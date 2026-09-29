/**
 * Reward settlement outbox: rows written in the claim tx are settled exactly once, a breaker pause
 * is retried without burning attempts, and engine failures back off until they fail permanently.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withSerializableTx, type Db } from "@nebula/database";
import { bootstrapTreasury, setCircuitBreaker } from "@nebula/economy";
import { createIsolatedDb, createTestUser } from "@nebula/economy/testing";
import type { GrantResult } from "./grants.js";
import {
  REWARD_OUTBOX_MAX_ATTEMPTS, enqueueRewardSettlement, processRewardOutbox, rewardOutboxBackoffMs, settleRewardSettlement,
} from "./rewardOutbox.js";

const SOL = 1_000_000_000n;
let db: Db;

const grantResult = (weight = 2): GrantResult => ({ items: [], levelBefore: 1, levelAfter: 1, crypto: { source: "ACHIEVEMENT", weight } });

async function enqueue(userId: string, sourceRef: string): Promise<string> {
  const id = await withSerializableTx(db, (tx) => enqueueRewardSettlement(tx, userId, grantResult(), sourceRef, "Achievement test"));
  if (!id) throw new Error("expected an outbox row");
  return id;
}

beforeAll(async () => {
  db = await createIsolatedDb("test_api_reward_outbox", { truncate: true });
  await bootstrapTreasury(db, { onChainBalance: 50n * SOL, slot: 1n, treasuryAddress: "Treasury1111111111111111111111111111111111" });
});
afterAll(async () => {
  await db?.$disconnect();
});

describe("reward settlement outbox", () => {
  it("enqueue is a no-op without a crypto part and idempotent per (user, source, sourceRef)", async () => {
    const u = await createTestUser(db);
    const none = await withSerializableTx(db, (tx) => enqueueRewardSettlement(tx, u.id, { ...grantResult(), crypto: null }, "ach:none", "x"));
    expect(none).toBeNull();
    const a = await enqueue(u.id, "ach:dup");
    const b = await enqueue(u.id, "ach:dup");
    expect(b).toBe(a);
    expect(await db.rewardSettlement.count({ where: { userId: u.id } })).toBe(1);
  });

  it("processes a pending row once and grants the reward exactly once", async () => {
    const u = await createTestUser(db);
    const id = await enqueue(u.id, "ach:once");
    expect(await processRewardOutbox(db, 50)).toBeGreaterThanOrEqual(1);
    const row = await db.rewardSettlement.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: "DONE", result: "GRANTED", attempts: 1 });
    expect(await db.reward.count({ where: { userId: u.id, sourceRef: "ach:once" } })).toBe(1);
    // Already settled: another pass / a direct retry does nothing.
    expect(await settleRewardSettlement(db, id)).toBe("SKIPPED");
    expect(await db.reward.count({ where: { userId: u.id, sourceRef: "ach:once" } })).toBe(1);
  });

  it("a REWARD_PAUSE breaker defers the row without consuming an attempt", async () => {
    const u = await createTestUser(db);
    const id = await enqueue(u.id, "ach:paused");
    await setCircuitBreaker(db, { mode: "REWARD_PAUSE", active: true, reason: "test", actorId: null });
    try {
      expect(await settleRewardSettlement(db, id)).toBe("RETRY");
    } finally {
      await setCircuitBreaker(db, { mode: "REWARD_PAUSE", active: false, reason: "test done", actorId: null });
    }
    const paused = await db.rewardSettlement.findUniqueOrThrow({ where: { id } });
    expect(paused).toMatchObject({ status: "PENDING", attempts: 0, result: "PAUSED" });
    expect(paused.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    // Not due yet.
    expect(await settleRewardSettlement(db, id)).toBe("SKIPPED");
    expect(await settleRewardSettlement(db, id, { now: new Date(paused.nextAttemptAt.getTime() + 1) })).toBe("DONE");
    expect(await db.reward.count({ where: { userId: u.id, sourceRef: "ach:paused" } })).toBe(1);
  });

  it("engine failures retry with exponential backoff and fail permanently after the max attempts", async () => {
    const u = await createTestUser(db);
    const id = await enqueue(u.id, "ach:flaky");
    const boom = async (): Promise<never> => {
      throw new Error("rpc down");
    };
    let now = new Date();
    for (let attempt = 1; attempt <= REWARD_OUTBOX_MAX_ATTEMPTS; attempt++) {
      const outcome = await settleRewardSettlement(db, id, { now, grant: boom });
      const row = await db.rewardSettlement.findUniqueOrThrow({ where: { id } });
      expect(row.attempts).toBe(attempt);
      expect(row.lastError).toBe("rpc down");
      if (attempt < REWARD_OUTBOX_MAX_ATTEMPTS) {
        expect(outcome).toBe("RETRY");
        expect(row.status).toBe("PENDING");
        expect(row.nextAttemptAt.getTime()).toBe(now.getTime() + rewardOutboxBackoffMs(attempt));
        now = row.nextAttemptAt;
      } else {
        expect(outcome).toBe("FAILED");
        expect(row.status).toBe("FAILED");
      }
    }
    expect(await db.reward.count({ where: { userId: u.id, sourceRef: "ach:flaky" } })).toBe(0);
  });

  it("recovers after a transient failure (retry succeeds)", async () => {
    const u = await createTestUser(db);
    const id = await enqueue(u.id, "ach:transient");
    const failAt = new Date();
    expect(await settleRewardSettlement(db, id, { now: failAt, grant: async () => { throw new Error("transient"); } })).toBe("RETRY");
    const later = new Date(failAt.getTime() + rewardOutboxBackoffMs(1) + 1);
    expect(await processRewardOutbox(db, 50, { now: later })).toBeGreaterThanOrEqual(1);
    expect(await db.rewardSettlement.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "DONE", attempts: 2, lastError: null });
    expect(await db.reward.count({ where: { userId: u.id, sourceRef: "ach:transient" } })).toBe(1);
  });

  it("backoff grows exponentially and is capped", () => {
    expect(rewardOutboxBackoffMs(1)).toBe(30_000);
    expect(rewardOutboxBackoffMs(2)).toBe(60_000);
    expect(rewardOutboxBackoffMs(20)).toBe(3_600_000);
  });
});
