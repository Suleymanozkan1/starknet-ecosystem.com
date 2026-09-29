/**
 * Transactional outbox for crypto reward settlement (quest / achievement claims).
 *
 * The claim transaction writes a `RewardSettlement` row (unique per userId + source + sourceRef)
 * together with the in-game grant, so a crash or reward-engine failure after commit can never lose
 * the crypto reward. Rows are processed right after the claim commits (best effort) and by a
 * background job with retry + exponential backoff. Processing is safe to repeat: the reward engine
 * (`grantCryptoReward`) is itself idempotent by (userId, source, sourceRef).
 */
import type { Db, Tx } from "@nebula/database";
import { grantCryptoReward } from "@nebula/economy";
import { RewardSource } from "@nebula/shared";
import type { GrantResult } from "./grants.js";
import { PushType, notify } from "./notify.js";

export const REWARD_OUTBOX_MAX_ATTEMPTS = 8;
/** A claimed row is invisible to other workers for this long (crash recovery: retried afterwards). */
export const REWARD_OUTBOX_LEASE_MS = 120_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 3_600_000;

export type SettlementOutcome = "DONE" | "RETRY" | "FAILED" | "SKIPPED";

export interface OutboxLogger {
  warn: (obj: object, msg?: string) => void;
}

export interface OutboxOptions {
  now?: Date;
  log?: OutboxLogger;
  /** Reward engine entry point (injectable for tests). */
  grant?: typeof grantCryptoReward;
}

const SOURCES = new Set<string>(Object.values(RewardSource));
const isRewardSource = (s: string): s is RewardSource => SOURCES.has(s);

/** Delay before retry number `attempts + 1` (attempts already made, >= 1). */
export function rewardOutboxBackoffMs(attempts: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.slice(0, 500);
}

/**
 * Must be called inside the claim transaction. Returns the outbox row id, or null when the grant
 * has no crypto-eligible part.
 */
export async function enqueueRewardSettlement(tx: Tx, userId: string, grant: GrantResult, sourceRef: string, reason: string): Promise<string | null> {
  if (!grant.crypto) return null;
  const { source, weight } = grant.crypto;
  const row = await tx.rewardSettlement.upsert({
    where: { userId_source_sourceRef: { userId, source, sourceRef } },
    create: { userId, source, sourceRef, weight, reason },
    update: {},
    select: { id: true },
  });
  return row.id;
}

/**
 * Process one outbox row. The row is leased with a conditional update first, so concurrent workers
 * (the request path and the job) never settle the same row at the same time.
 */
export async function settleRewardSettlement(db: Db, id: string, opts: OutboxOptions = {}): Promise<SettlementOutcome> {
  const now = opts.now ?? new Date();
  const leased = await db.rewardSettlement.updateMany({
    where: { id, status: "PENDING", nextAttemptAt: { lte: now } },
    data: { attempts: { increment: 1 }, nextAttemptAt: new Date(now.getTime() + REWARD_OUTBOX_LEASE_MS) },
  });
  if (leased.count !== 1) return "SKIPPED";
  const row = await db.rewardSettlement.findUniqueOrThrow({ where: { id } });
  if (!isRewardSource(row.source)) {
    await db.rewardSettlement.update({ where: { id }, data: { status: "FAILED", lastError: `Unknown reward source ${row.source}`, processedAt: now } });
    return "FAILED";
  }
  try {
    const grant = opts.grant ?? grantCryptoReward;
    const r = await grant(db, { userId: row.userId, source: row.source, sourceRef: row.sourceRef, weight: row.weight, reason: row.reason });
    if (r.status === "PAUSED") {
      // Breaker pause is not a failure of this row: retry later without burning an attempt.
      await db.rewardSettlement.update({
        where: { id },
        data: { attempts: { decrement: 1 }, nextAttemptAt: new Date(now.getTime() + rewardOutboxBackoffMs(Math.max(1, row.attempts))), result: r.status, lastError: r.reasons.join("; ").slice(0, 500) },
      });
      return "RETRY";
    }
    await db.rewardSettlement.update({ where: { id }, data: { status: "DONE", result: r.status, lastError: null, processedAt: now } });
    if (r.status === "GRANTED" && r.amount > 0n) {
      try {
        await notify(db, row.userId, PushType.REWARD_READY, "Reward ready", `${row.reason}: a reward is ready to claim in your wallet.`, { sourceRef: row.sourceRef, source: row.source });
      } catch (err) {
        opts.log?.warn({ err, settlementId: id }, "reward-ready notification failed");
      }
    }
    return "DONE";
  } catch (err) {
    const failed = row.attempts >= REWARD_OUTBOX_MAX_ATTEMPTS;
    await db.rewardSettlement.update({
      where: { id },
      data: failed
        ? { status: "FAILED", lastError: errorText(err), processedAt: now }
        : { nextAttemptAt: new Date(now.getTime() + rewardOutboxBackoffMs(row.attempts)), lastError: errorText(err) },
    });
    opts.log?.warn({ err, settlementId: id, attempts: row.attempts }, failed ? "reward settlement failed permanently" : "reward settlement failed, will retry");
    return failed ? "FAILED" : "RETRY";
  }
}

/**
 * Background job entry point: settle due PENDING rows (oldest first). Returns how many were DONE.
 * A failing row never blocks the rest of the batch.
 */
export async function processRewardOutbox(db: Db, limit = 50, opts: OutboxOptions = {}): Promise<number> {
  const now = opts.now ?? new Date();
  const due = await db.rewardSettlement.findMany({
    where: { status: "PENDING", nextAttemptAt: { lte: now } },
    orderBy: { nextAttemptAt: "asc" },
    take: limit,
    select: { id: true },
  });
  let done = 0;
  for (const { id } of due) {
    try {
      if ((await settleRewardSettlement(db, id, { ...opts, now })) === "DONE") done++;
    } catch (err) {
      opts.log?.warn({ err, settlementId: id }, "reward outbox row processing failed");
    }
  }
  return done;
}
