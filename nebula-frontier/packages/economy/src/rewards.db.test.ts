import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Currency, LedgerAccountType } from "@nebula/shared";
import { getBalance, system, userWallet, verifyLedgerIntegrity, type Db } from "@nebula/database";
import { createIsolatedDb, createTestUser } from "./testing.js";
import {
  bootstrapTreasury,
  claimReward,
  EconomyConfigError,
  EconomyController,
  expireRewards,
  grantCryptoReward,
  recordRiskSignal,
  setCircuitBreaker,
  updateEconomyConfig,
  loadEconomyConfig,
  defaultEconomyConfig,
  getOutstandingLiability,
  reviewReward
} from "./index.js";

const SOL = 1_000_000_000n;
let db: Db;

/** The fees subtree in its JSON (stored) form: money leaves as decimal strings. */
function cfgJsonFees(): Record<string, unknown> {
  const f = defaultEconomyConfig().fees;
  return { ...f, withdrawalFlat: f.withdrawalFlat.toString(), estimatedNetworkFee: f.estimatedNetworkFee.toString() };
}

beforeAll(async () => {
  db = await createIsolatedDb("test_economy_rewards", { truncate: true });
  const r = await bootstrapTreasury(db, { onChainBalance: 50n * SOL, slot: 1n, treasuryAddress: "Treasury1111111111111111111111111111111111" });
  expect(r.funded).toBeGreaterThan(0n);
});
afterAll(async () => {
  await db?.$disconnect();
});

describe("grantCryptoReward / claimReward", () => {
  it("grants, rejects duplicates, and claims idempotently via the ledger", async () => {
    const u = await createTestUser(db);
    const input = { userId: u.id, source: "TOURNAMENT" as const, sourceRef: "tour-1", weight: 5, reason: "Tournament Reward: top 8" };
    const g = await grantCryptoReward(db, input);
    expect(g.status).toBe("GRANTED");
    expect(g.amount).toBeGreaterThan(0n);
    const dup = await grantCryptoReward(db, input);
    expect(dup.status).toBe("DUPLICATE");
    expect(dup.amount).toBe(g.amount);
    // Concurrent duplicate grants: exactly one row.
    const parallel = await Promise.all(Array.from({ length: 5 }, () => grantCryptoReward(db, { ...input, sourceRef: "tour-2" })));
    expect(parallel.filter((p) => p.status === "GRANTED").length).toBe(1);
    expect(await db.reward.count({ where: { userId: u.id, sourceRef: "tour-2" } })).toBe(1);

    const poolBefore = await getBalance(db, system(LedgerAccountType.PLAYER_REWARD_POOL, Currency.NEBX));
    const c1 = await claimReward(db, u.id, g.rewardId as string);
    const c2 = await claimReward(db, u.id, g.rewardId as string);
    expect(c1.alreadyClaimed).toBe(false);
    expect(c2.alreadyClaimed).toBe(true);
    expect(c2.claimId).toBe(c1.claimId);
    expect(await getBalance(db, userWallet(u.id, Currency.NEBX))).toBe(g.amount);
    expect(await getBalance(db, system(LedgerAccountType.PLAYER_REWARD_POOL, Currency.NEBX))).toBe(poolBefore - g.amount);
    const liab = await db.rewardLiability.findUnique({ where: { rewardId: g.rewardId as string } });
    expect(liab?.status).toBe("SETTLED");
    expect((await verifyLedgerIntegrity(db)).every((a) => a.ok)).toBe(true);
  });

  it("ineligible accounts are refused; HIGH risk goes to PENDING_REVIEW", async () => {
    const young = await createTestUser(db, { createdAt: new Date() });
    expect((await grantCryptoReward(db, { userId: young.id, source: "PVP", sourceRef: "m1", weight: 1, reason: "Battle Reward" })).status).toBe("INELIGIBLE");
    const risky = await createTestUser(db);
    await recordRiskSignal(db, { userId: risky.id, type: "ABNORMAL_FARMING", score: 60, details: {}, source: "test" });
    const g = await grantCryptoReward(db, { userId: risky.id, source: "PVP", sourceRef: "m1", weight: 1, reason: "Battle Reward" });
    expect(g.status).toBe("PENDING_REVIEW");
    await expect(claimReward(db, risky.id, g.rewardId as string)).rejects.toMatchObject({ code: "UNDER_REVIEW" });
    const user = await db.user.findUniqueOrThrow({ where: { id: risky.id } });
    expect(user.bannedAt).toBeNull(); // never auto-banned
    // Four-eyes: the reward owner cannot approve their own reward; another admin can.
    await expect(reviewReward(db, g.rewardId as string, true, risky.id, "self")).rejects.toMatchObject({ code: "SELF_REVIEW" });
    const admin = await createTestUser(db);
    expect((await reviewReward(db, g.rewardId as string, true, admin.id, "ok")).status).toBe("CLAIMABLE");
  });

  it("a reward-blocking restriction added after the grant freezes the claim", async () => {
    const u = await createTestUser(db);
    const g = await grantCryptoReward(db, { userId: u.id, source: "EVENT", sourceRef: "restr-1", weight: 1, reason: "Event Reward" });
    expect(g.status).toBe("GRANTED");
    await db.user.update({ where: { id: u.id }, data: { restrictions: ["NO_REWARDS"] } });
    await expect(claimReward(db, u.id, g.rewardId as string)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await db.reward.findUniqueOrThrow({ where: { id: g.rewardId as string } })).status).toBe("CLAIMABLE");
  });

  it("REWARD_PAUSE breaker pauses grants", async () => {
    const u = await createTestUser(db);
    await setCircuitBreaker(db, { mode: "REWARD_PAUSE", active: true, reason: "test", actorId: null });
    expect((await grantCryptoReward(db, { userId: u.id, source: "RAID", sourceRef: "r1", weight: 1, reason: "Raid" })).status).toBe("PAUSED");
    await setCircuitBreaker(db, { mode: "REWARD_PAUSE", active: false, reason: "test done", actorId: null });
    expect((await grantCryptoReward(db, { userId: u.id, source: "RAID", sourceRef: "r1", weight: 1, reason: "Raid" })).status).toBe("GRANTED");
    expect(await db.auditLog.count({ where: { action: { in: ["CIRCUIT_BREAKER_ON", "CIRCUIT_BREAKER_OFF"] }, targetId: "REWARD_PAUSE" } })).toBeGreaterThanOrEqual(2);
  });

  it("daily cap caps a single player", async () => {
    const u = await createTestUser(db);
    const cfg = await loadEconomyConfig(db);
    const big = await grantCryptoReward(db, { userId: u.id, source: "LEADERBOARD", sourceRef: "lb-1", weight: 10_000, reason: "Season Reward" });
    expect(big.status).toBe("GRANTED");
    expect(big.amount).toBeLessThanOrEqual(cfg.caps.daily);
    const more = await grantCryptoReward(db, { userId: u.id, source: "LEADERBOARD", sourceRef: "lb-2", weight: 10_000, reason: "Season Reward" });
    expect(["CAPPED"]).toContain(more.status);
  });

  it("outstanding liability never exceeds the reward pool", async () => {
    const pool = await getBalance(db, system(LedgerAccountType.PLAYER_REWARD_POOL, Currency.NEBX));
    expect(await getOutstandingLiability(db)).toBeLessThanOrEqual(pool);
  });

  it("expiry job expires unclaimed rewards and their liability", async () => {
    const u = await createTestUser(db);
    const g = await grantCryptoReward(db, { userId: u.id, source: "EVENT", sourceRef: "ev-1", weight: 1, reason: "Event Reward" });
    await db.reward.update({ where: { id: g.rewardId as string }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await expireRewards(db)).toBeGreaterThanOrEqual(1);
    expect((await db.reward.findUniqueOrThrow({ where: { id: g.rewardId as string } })).status).toBe("EXPIRED");
    expect((await db.rewardLiability.findUniqueOrThrow({ where: { rewardId: g.rewardId as string } })).status).toBe("EXPIRED");
  });
});

describe("config & controller", () => {
  it("rejects allocation > 100% and audits valid changes with old/new value", async () => {
    await expect(updateEconomyConfig(db, "rewardAllocation.LEADERBOARD", 0.9, null, "try to over-allocate")).rejects.toBeInstanceOf(EconomyConfigError);
    await expect(updateEconomyConfig(db, "nope.key", 1, null, "unknown")).rejects.toBeInstanceOf(EconomyConfigError);
    // Money is integer base units (decimal string or legacy safe-integer number); a subtree cannot
    // smuggle a non-integer amount or a string past a numeric (ratio) leaf.
    await expect(updateEconomyConfig(db, "caps.daily", 1.5, null, "fractional")).rejects.toBeInstanceOf(EconomyConfigError);
    await expect(updateEconomyConfig(db, "caps.daily", 2 ** 60, null, "unsafe")).rejects.toBeInstanceOf(EconomyConfigError);
    await expect(updateEconomyConfig(db, "caps.daily", "6e7", null, "non-decimal string")).rejects.toBeInstanceOf(EconomyConfigError);
    await expect(updateEconomyConfig(db, "caps", { daily: "1.5", weekly: "200000000", season: "1000000000" }, null, "fractional string leaf")).rejects.toBeInstanceOf(EconomyConfigError);
    await expect(updateEconomyConfig(db, "fees", { ...cfgJsonFees(), marketplace: "0.1" }, null, "string ratio leaf")).rejects.toBeInstanceOf(EconomyConfigError);
    await expect(updateEconomyConfig(db, "sinks.npcServiceFee", 0.5, null, "fractional sink")).rejects.toBeInstanceOf(EconomyConfigError);
    try {
      const r = await updateEconomyConfig(db, "caps.daily", 60_000_000, null, "raise daily cap");
      expect(r.oldValue).toBe(50_000_000n);
      expect(r.newValue).toBe("60000000");
      expect(r.config.caps.daily).toBe(60_000_000n);
      const log = await db.auditLog.findFirst({ where: { action: "ECONOMY_CONFIG_UPDATE", targetId: "caps.daily" }, orderBy: { createdAt: "desc" } });
      expect(log?.oldValue).toBe("50000000");
      expect(log?.newValue).toBe("60000000");
      // Stored as a decimal string and read back as bigint.
      expect((await db.economyConfig.findUniqueOrThrow({ where: { key: "caps.daily" } })).value).toBe("60000000");
      expect((await loadEconomyConfig(db)).caps.daily).toBe(60_000_000n);
    } finally {
      await updateEconomyConfig(db, "caps.daily", "50000000", null, "restore");
    }
  });

  it("controller snapshots and trips REWARD_PAUSE when liability is too high", async () => {
    const ctl = new EconomyController(db);
    const r1 = await ctl.run();
    expect(r1.snapshotIds.length).toBe(3);
    // Simulate liabilities approaching the pool: drain the pool with an audited adjustment.
    const pool = await getBalance(db, system(LedgerAccountType.PLAYER_REWARD_POOL, Currency.NEBX));
    const outstanding = await getOutstandingLiability(db);
    const { post } = await import("@nebula/database");
    await db.$transaction((tx) =>
      post(tx, {
        from: system(LedgerAccountType.PLAYER_REWARD_POOL, Currency.NEBX),
        to: system(LedgerAccountType.TREASURY, Currency.NEBX),
        amount: pool - outstanding - 1n,
        type: "RESERVE_ALLOCATION",
        reference: "test",
        idempotencyKey: `test-drain-${Date.now()}`
      })
    );
    const r2 = await ctl.run();
    expect(r2.anomalies.map((a) => a.kind)).toContain("LIABILITY_TOO_HIGH");
    expect(r2.breakersOn).toContain("REWARD_PAUSE");
    const u = await createTestUser(db);
    expect((await grantCryptoReward(db, { userId: u.id, source: "PVP", sourceRef: "after-trip", weight: 1, reason: "x" })).status).toBe("PAUSED");
    const cfg = await loadEconomyConfig(db);
    expect(cfg.runtime.throttleMultiplier).toBeLessThan(1);
  });
});
