/**
 * Inflation control (brief §88): issued / burned / spent / stored / withdrawn are measured from the
 * ledger, turned into daily/weekly/30-day inflation, and an inflation spike throttles emission.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { post, system, userWallet, type Db } from "@nebula/database";
import { LedgerAccountType, TreasuryHealth } from "@nebula/shared";
import { loadEconomyConfig } from "./config.js";
import { detectAnomalies, inflationRate, ledgerFlows, storedSupply, type EconomyMetrics } from "./controller.js";
import { createIsolatedDb, createTestUser } from "./testing.js";

let db: Db;

beforeAll(async () => {
  db = await createIsolatedDb("test_economy_inflation", { truncate: true });
});
afterAll(async () => {
  await db?.$disconnect();
});

const move = (from: Parameters<typeof post>[1]["from"], to: Parameters<typeof post>[1]["to"], amount: bigint, key: string) =>
  db.$transaction((tx) => post(tx, { from, to, amount, type: "ADMIN_ADJUSTMENT", reference: "inflation-test", idempotencyKey: key }));

describe("inflation measurement from the ledger", () => {
  it("classifies issued, burned, spent and withdrawn flows and computes the rate", async () => {
    const u = await createTestUser(db);
    const since = new Date(Date.now() - 60_000);
    await move(system(LedgerAccountType.GAME_ISSUANCE, "CREDITS"), userWallet(u.id, "CREDITS"), 10_000n, "inf:issue");
    await move(userWallet(u.id, "CREDITS"), system(LedgerAccountType.GAME_SINK, "CREDITS"), 2_000n, "inf:burn");
    await move(userWallet(u.id, "CREDITS"), system(LedgerAccountType.PREMIUM_REVENUE, "CREDITS"), 1_000n, "inf:spend");
    const flows = await ledgerFlows(db, "CREDITS", since, new Date(Date.now() + 60_000));
    expect(flows.issued).toBe(10_000n);
    expect(flows.burned).toBe(2_000n);
    expect(flows.spent).toBe(1_000n);
    expect(flows.withdrawn).toBe(0n);
    const stored = await storedSupply(db, "CREDITS");
    expect(stored).toBe(7_000n);
    // Start-of-window supply was 0 → below any meaningful base → reported as 0 (no division noise).
    expect(inflationRate(flows, stored, 1n)).toBe(0);
  });

  it("inflation = (issued − burned − spent) / supply at window start", () => {
    const flows = { issued: 1_000n, burned: 200n, spent: 300n, withdrawn: 0n, deposited: 0n, revenue: 300n, revenueBySource: {} };
    // Supply now 10 500 → start = 10 500 − (1000 − 200 − 300) = 10 000 → net 500 / 10 000 = 5 %.
    expect(inflationRate(flows, 10_500n, 1n)).toBeCloseTo(0.05, 6);
    // Sinks larger than issuance → deflation (negative).
    expect(inflationRate({ ...flows, burned: 1_500n }, 9_200n, 1n)).toBeLessThan(0);
  });
});

describe("inflation response", () => {
  const base = (daily: number): EconomyMetrics => ({
    at: new Date(),
    treasury: { health: TreasuryHealth.HEALTHY, coverage: 10, availableReserve: 0n, projected30dLiability: 0n, outstandingLiability: 0n, rewardPool: 0n } as unknown as EconomyMetrics["treasury"],
    rewardRate: 0.01,
    inflation: { credits: { daily, weekly: 0, d30: 0 }, nebx: { daily: 0, weekly: 0, d30: 0 } },
    withdrawals24h: 0n, withdrawalsAvg7d: 0n, deposits24h: 0n, depositsAvg7d: 0n,
    rewardOutflow24h: 0n, rewardOutflowAvg7d: 0n, marketVolume24h: 0n, marketVolumeAvg7d: 0n, marketTopSellerShare: 0,
    rewardUsers24h: 0, riskyRewardUsers24h: 0, duplicateClaimSignals1h: 0, dau: 0, dauAvg7d: 0,
  });

  it("above threshold → WARN + emission throttle; above spike → CRITICAL + EVENT_PAUSE", async () => {
    const cfg = await loadEconomyConfig(db);
    expect(detectAnomalies(base(0), cfg).some((a) => a.kind === "INFLATION_SPIKE")).toBe(false);
    const warn = detectAnomalies(base(cfg.inflation.dailyThreshold + 0.0001), cfg).find((a) => a.kind === "INFLATION_SPIKE");
    expect(warn?.severity).toBe("WARN");
    expect(warn?.throttle).toBe(true);
    const crit = detectAnomalies(base(cfg.circuitBreaker.inflationSpike + 0.01), cfg).find((a) => a.kind === "INFLATION_SPIKE");
    expect(crit?.severity).toBe("CRITICAL");
    expect(crit?.breakers).toContain("EVENT_PAUSE");
  });
});
