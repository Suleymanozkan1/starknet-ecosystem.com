import { CircuitBreakerMode, Currency, LedgerAccountType, RewardSource, RiskLevel, CheatType } from "@nebula/shared";
import { post, system, userWallet, withSerializableTx, LedgerError, type Db, type Tx } from "@nebula/database";
import { loadEconomyConfig, type EconomyConfig } from "./config.js";
import { isBreakerActive } from "./breakers.js";
import { checkRewardEligibility, claimCooldownUntil, REWARD_BLOCKING_RESTRICTIONS } from "./eligibility.js";
import { applyCaps, getCapUsage } from "./caps.js";
import { getTreasuryState, getOutstandingLiability } from "./treasury.js";
import { dailyEmissionCap, emissionFromConfig, rewardAmountForWeight } from "./emission.js";
import { REWARD_BUCKET_BY_SOURCE, getRewardBudgetState } from "./rewardBudget.js";
import { recordRiskSignal } from "./risk.js";
import { DAY_MS, startOfUtcDay } from "./util.js";

export type GrantStatus = "GRANTED" | "PENDING_REVIEW" | "CAPPED" | "INELIGIBLE" | "PAUSED" | "DUPLICATE";

export interface GrantCryptoRewardInput {
  userId: string;
  source: RewardSource;
  sourceRef: string;
  weight: number;
  reason: string;
  seasonId?: string;
  matchId?: string;
  /** Match mode (checked against eligibility.eligibleModes when provided). */
  mode?: string;
  now?: Date;
}

export interface GrantCryptoRewardResult {
  status: GrantStatus;
  amount: bigint;
  reasons: string[];
  rewardId?: string;
}

const VALID_SOURCES = new Set<string>(Object.values(RewardSource));

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string }).code === "P2002" || /Unique constraint/i.test(String((err as Error).message));
}

/**
 * Grants a crypto reward (Battle/Season/Tournament Rewards). Order of checks:
 *  duplicate → REWARD_PAUSE breaker → eligibility → emission rate (treasury health, hard cap) →
 *  per-user caps → season/bucket budget → daily emission cap → reward-pool coverage.
 * Creates Reward + RewardLiability atomically (SERIALIZABLE). HIGH/CRITICAL risk → PENDING_REVIEW.
 * No ledger movement happens until the player claims.
 */
export async function grantCryptoReward(db: Db, input: GrantCryptoRewardInput): Promise<GrantCryptoRewardResult> {
  const now = input.now ?? new Date();
  if (!VALID_SOURCES.has(input.source)) return { status: "INELIGIBLE", amount: 0n, reasons: [`Unknown reward source ${input.source}`] };
  if (!input.sourceRef || input.sourceRef.length > 200) return { status: "INELIGIBLE", amount: 0n, reasons: ["Invalid sourceRef"] };
  if (!Number.isFinite(input.weight) || input.weight <= 0) return { status: "INELIGIBLE", amount: 0n, reasons: ["Weight must be positive"] };

  const existing = await db.reward.findUnique({
    where: { userId_source_sourceRef: { userId: input.userId, source: input.source, sourceRef: input.sourceRef } },
    select: { id: true, amount: true }
  });
  if (existing) return { status: "DUPLICATE", amount: existing.amount, reasons: ["Reward already granted for this source"], rewardId: existing.id };

  if (await isBreakerActive(db, CircuitBreakerMode.REWARD_PAUSE)) {
    return { status: "PAUSED", amount: 0n, reasons: ["Rewards are temporarily paused by the economy controller"] };
  }

  const cfg = await loadEconomyConfig(db);
  const user = await db.user.findUnique({
    where: { id: input.userId },
    select: { createdAt: true, riskLevel: true, playtimeSeconds: true, matchesPlayed: true, bannedAt: true, restrictions: true }
  });
  if (!user) return { status: "INELIGIBLE", amount: 0n, reasons: ["Unknown user"] };
  // Eligibility gate. HIGH/CRITICAL risk is NOT an ineligibility here: the reward is recorded but
  // held for manual review (so a false positive can be approved by a human).
  const elig = checkRewardEligibility({ user: { ...user, riskLevel: RiskLevel.LOW }, mode: input.mode ?? null, now }, cfg);
  if (!elig.eligible) return { status: "INELIGIBLE", amount: 0n, reasons: elig.reasons };
  const highRisk = user.riskLevel === RiskLevel.HIGH || user.riskLevel === RiskLevel.CRITICAL;
  const mediumBlocked = !highRisk && user.riskLevel !== RiskLevel.LOW && cfg.eligibility.maxRiskLevel === RiskLevel.LOW;
  if (mediumBlocked) return { status: "INELIGIBLE", amount: 0n, reasons: ["Account is under security review"] };

  try {
    return await withSerializableTx(db, (tx) => grantInTx(tx, input, cfg, highRisk, now));
  } catch (err) {
    if (isUniqueViolation(err)) {
      const dup = await db.reward.findUnique({
        where: { userId_source_sourceRef: { userId: input.userId, source: input.source, sourceRef: input.sourceRef } },
        select: { id: true, amount: true }
      });
      await recordRiskSignal(db, { userId: input.userId, type: CheatType.DUPLICATE_REWARD, score: 2, details: { source: input.source, sourceRef: input.sourceRef }, source: "economy.grant" }, cfg).catch(() => undefined);
      return { status: "DUPLICATE", amount: dup?.amount ?? 0n, reasons: ["Reward already granted for this source"], rewardId: dup?.id };
    }
    throw err;
  }
}

async function grantInTx(tx: Tx, input: GrantCryptoRewardInput, cfg: EconomyConfig, highRisk: boolean, now: Date): Promise<GrantCryptoRewardResult> {
  const reasons: string[] = [];
  const treasury = await getTreasuryState(tx, cfg, now);
  const emission = emissionFromConfig(cfg, treasury.health);
  if (emission.hardCapped) reasons.push("Emission rate hard-capped");
  let amount = rewardAmountForWeight(input.weight, emission.rate, cfg);
  if (amount <= 0n) return { status: "CAPPED", amount: 0n, reasons: [...reasons, "Emission rate is zero"] };

  const budget = await getRewardBudgetState(tx, cfg, input.seasonId ?? null, now);
  const seasonId = budget.seasonId;

  // Per-user caps
  const usage = await getCapUsage(tx, input.userId, seasonId, now);
  const capped = applyCaps(amount, usage, cfg);
  if (capped.capped) reasons.push(...capped.reasons);
  amount = capped.allowed;

  // Season bucket budget
  const bucket = REWARD_BUCKET_BY_SOURCE[input.source];
  const bucketRemaining = budget.buckets[bucket].remaining;
  if (amount > bucketRemaining) {
    amount = bucketRemaining;
    reasons.push(`${bucket} season budget exhausted`);
  }
  // Daily emission cap = budget * rate
  const dayCap = dailyEmissionCap(budget.effectiveBudget, emission.rate);
  // Scoped to this season: dayCap derives from this season's budget, so another season's grants
  // (e.g. on a rollover day) must not consume it.
  const today = (await tx.reward.aggregate({ where: { seasonId, createdAt: { gte: startOfUtcDay(now) }, status: { in: ["CLAIMABLE", "CLAIMED", "PENDING_REVIEW"] } }, _sum: { amount: true } }))._sum.amount ?? 0n;
  const dayRoom = dayCap - today;
  if (amount > dayRoom) {
    amount = dayRoom > 0n ? dayRoom : 0n;
    reasons.push("Daily emission cap reached");
  }
  // Pool coverage: outstanding liabilities can never exceed what the reward pool holds.
  const outstanding = await getOutstandingLiability(tx, Currency.NEBX);
  const poolRoom = budget.rewardPool - outstanding;
  if (amount > poolRoom) {
    amount = poolRoom > 0n ? poolRoom : 0n;
    reasons.push("Reward pool fully committed");
  }
  if (amount <= 0n) return { status: "CAPPED", amount: 0n, reasons };

  const status = highRisk ? "PENDING_REVIEW" : "CLAIMABLE";
  const expiresAt = new Date(now.getTime() + cfg.rewardExpiryDays * DAY_MS);
  const reward = await tx.reward.create({
    data: {
      userId: input.userId,
      seasonId,
      source: input.source,
      sourceRef: input.sourceRef,
      amount,
      asset: Currency.NEBX,
      status,
      reason: input.reason.slice(0, 500),
      riskLevel: highRisk ? RiskLevel.HIGH : RiskLevel.LOW,
      expiresAt
    }
  });
  await tx.rewardLiability.create({
    data: { seasonId, userId: input.userId, rewardId: reward.id, amount, asset: Currency.NEBX, status: "OUTSTANDING", expiresAt }
  });
  if (highRisk) reasons.push("Held for manual review (account risk)");
  return { status: highRisk ? "PENDING_REVIEW" : "GRANTED", amount, reasons, rewardId: reward.id };
}

export class RewardClaimError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface ClaimResult {
  rewardId: string;
  amount: bigint;
  claimId: string;
  ledgerTxId: string | null;
  alreadyClaimed: boolean;
}

/**
 * Claims a CLAIMABLE reward: PLAYER_REWARD_POOL:NEBX → USER_WALLET:<uid>:NEBX, RewardClaim row,
 * liability SETTLED. Idempotent: claiming an already-claimed reward returns the original claim.
 */
export async function claimReward(db: Db, userId: string, rewardId: string, opts: { now?: Date; skipCooldown?: boolean } = {}): Promise<ClaimResult> {
  const now = opts.now ?? new Date();
  const cfg = await loadEconomyConfig(db);
  return withSerializableTx(db, async (tx) => {
    const reward = await tx.reward.findUnique({ where: { id: rewardId }, include: { claims: true } });
    if (!reward || reward.userId !== userId) throw new RewardClaimError("NOT_FOUND", "Reward not found");
    const prior = reward.claims[0];
    if (reward.status === "CLAIMED" && prior) {
      return { rewardId, amount: prior.amount, claimId: prior.id, ledgerTxId: prior.ledgerTxId, alreadyClaimed: true };
    }
    if (reward.status === "PENDING_REVIEW") throw new RewardClaimError("UNDER_REVIEW", "Reward is under review");
    if (reward.status !== "CLAIMABLE") throw new RewardClaimError("NOT_CLAIMABLE", `Reward is ${reward.status.toLowerCase()}`);
    if (reward.expiresAt && reward.expiresAt < now) throw new RewardClaimError("EXPIRED", "Reward has expired");
    const user = await tx.user.findUnique({ where: { id: userId }, select: { riskLevel: true, bannedAt: true, restrictions: true } });
    if (!user || user.bannedAt) throw new RewardClaimError("FORBIDDEN", "Account cannot claim rewards");
    // A restriction added after the grant freezes rewards that are already claimable.
    if (user.restrictions.some((r) => REWARD_BLOCKING_RESTRICTIONS.includes(r))) throw new RewardClaimError("FORBIDDEN", "Account is restricted from rewards");
    if (user.riskLevel === RiskLevel.HIGH || user.riskLevel === RiskLevel.CRITICAL) throw new RewardClaimError("UNDER_REVIEW", "Account is under security review");
    if (!opts.skipCooldown) {
      const last = await tx.rewardClaim.findFirst({ where: { userId }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
      const until = claimCooldownUntil(last?.createdAt ?? null, cfg, now);
      if (until) throw new RewardClaimError("COOLDOWN", `Next claim available at ${until.toISOString()}`);
    }
    let ledgerId: string;
    try {
      const posted = await post(tx, {
        from: system(LedgerAccountType.PLAYER_REWARD_POOL, Currency.NEBX),
        to: userWallet(userId, Currency.NEBX),
        amount: reward.amount,
        type: "GAME_REWARD",
        reference: reward.id,
        idempotencyKey: `reward-claim:${reward.id}`,
        userId,
        metadata: { source: reward.source, sourceRef: reward.sourceRef, seasonId: reward.seasonId }
      });
      ledgerId = posted.id;
    } catch (err) {
      if (err instanceof LedgerError && err.code === "INSUFFICIENT_BALANCE") throw new RewardClaimError("POOL_DEPLETED", "Reward pool cannot cover this claim right now");
      throw err;
    }
    const claim = await tx.rewardClaim.create({ data: { rewardId, userId, amount: reward.amount, ledgerTxId: ledgerId } });
    // Conditional transitions: a concurrent expiry/review must make the claim fail (and roll back the
    // payout), never be overwritten.
    const rewardUpd = await tx.reward.updateMany({ where: { id: rewardId, status: "CLAIMABLE" }, data: { status: "CLAIMED" } });
    if (rewardUpd.count !== 1) throw new RewardClaimError("NOT_CLAIMABLE", "Reward changed during claim");
    const liabilityUpd = await tx.rewardLiability.updateMany({ where: { rewardId, status: "OUTSTANDING" }, data: { status: "SETTLED", settledAt: now } });
    if (liabilityUpd.count !== 1) throw new RewardClaimError("NOT_CLAIMABLE", "Reward liability is no longer outstanding");
    return { rewardId, amount: reward.amount, claimId: claim.id, ledgerTxId: ledgerId, alreadyClaimed: false };
  });
}

/** Claims several rewards in one action (one cooldown window). */
export async function claimRewards(db: Db, userId: string, rewardIds: string[], now = new Date()): Promise<{ claimed: ClaimResult[]; errors: { rewardId: string; code: string; message: string }[] }> {
  const claimed: ClaimResult[] = [];
  const errors: { rewardId: string; code: string; message: string }[] = [];
  const unique = [...new Set(rewardIds)].slice(0, 100);
  for (let i = 0; i < unique.length; i++) {
    const id = unique[i] as string;
    try {
      claimed.push(await claimReward(db, userId, id, { now, skipCooldown: i > 0 && claimed.some((c) => !c.alreadyClaimed) }));
    } catch (err) {
      if (err instanceof RewardClaimError) errors.push({ rewardId: id, code: err.code, message: err.message });
      else throw err;
    }
  }
  return { claimed, errors };
}

/** Expiry job: CLAIMABLE / PENDING_REVIEW rewards past expiresAt → EXPIRED; liability EXPIRED. */
export async function expireRewards(db: Db, now = new Date()): Promise<number> {
  const due = await db.reward.findMany({ where: { status: { in: ["CLAIMABLE", "PENDING_REVIEW"] }, expiresAt: { lt: now } }, select: { id: true }, take: 1000 });
  let n = 0;
  for (const r of due) {
    await db.$transaction(async (tx) => {
      const upd = await tx.reward.updateMany({ where: { id: r.id, status: { in: ["CLAIMABLE", "PENDING_REVIEW"] } }, data: { status: "EXPIRED" } });
      if (upd.count === 1) {
        await tx.rewardLiability.updateMany({ where: { rewardId: r.id, status: "OUTSTANDING" }, data: { status: "EXPIRED", settledAt: now } });
        n++;
      }
    });
  }
  return n;
}

/** Admin review of a PENDING_REVIEW reward. */
export async function reviewReward(db: Db, rewardId: string, approve: boolean, adminId: string, reason: string): Promise<{ status: string }> {
  return db.$transaction(async (tx) => {
    const r = await tx.reward.findUnique({ where: { id: rewardId } });
    if (!r) throw new RewardClaimError("NOT_FOUND", "Reward not found");
    if (r.status !== "PENDING_REVIEW") throw new RewardClaimError("NOT_REVIEWABLE", `Reward is ${r.status}`);
    if (r.userId === adminId) throw new RewardClaimError("SELF_REVIEW", "Reviewers cannot decide their own reward");
    const status = approve ? "CLAIMABLE" : "REJECTED";
    // Conditional: a concurrent expiry (EXPIRED + liability EXPIRED) must not be overwritten by CLAIMABLE.
    const upd = await tx.reward.updateMany({ where: { id: rewardId, status: "PENDING_REVIEW" }, data: { status, reviewedBy: adminId } });
    if (upd.count !== 1) throw new RewardClaimError("NOT_REVIEWABLE", "Reward changed during review");
    if (approve) {
      const outstanding = await tx.rewardLiability.count({ where: { rewardId, status: "OUTSTANDING" } });
      if (outstanding !== 1) throw new RewardClaimError("NOT_REVIEWABLE", "Reward liability is no longer outstanding");
    }
    if (!approve) await tx.rewardLiability.updateMany({ where: { rewardId, status: "OUTSTANDING" }, data: { status: "CANCELLED", settledAt: new Date() } });
    await tx.auditLog.create({
      data: { actorId: adminId, action: approve ? "REWARD_APPROVED" : "REWARD_REJECTED", targetType: "Reward", targetId: rewardId, oldValue: { status: r.status }, newValue: { status }, reason }
    });
    return { status };
  });
}
