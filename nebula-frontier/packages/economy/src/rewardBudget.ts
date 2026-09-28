import type { RewardSource} from "@nebula/shared";
import { LedgerAccountType, Currency } from "@nebula/shared";
import { getBalance, system, type DbOrTx } from "@nebula/database";
import type { EconomyConfig } from "./config.js";
import { mulRatioFloor } from "./util.js";

export type RewardBucket = keyof EconomyConfig["rewardAllocation"];
export const REWARD_BUCKETS: RewardBucket[] = ["LEADERBOARD", "TOURNAMENT", "WORLD_EVENTS", "FACTION_WARS", "RAIDS", "ACHIEVEMENTS", "SPECIAL_CAMPAIGNS"];

export const REWARD_BUCKET_BY_SOURCE: Record<RewardSource, RewardBucket> = {
  PVP: "LEADERBOARD",
  RANKED_SEASON: "LEADERBOARD",
  LEADERBOARD: "LEADERBOARD",
  TOURNAMENT: "TOURNAMENT",
  WORLD_BOSS: "WORLD_EVENTS",
  EVENT: "WORLD_EVENTS",
  GATE: "WORLD_EVENTS",
  FACTION_WAR: "FACTION_WARS",
  RAID: "RAIDS",
  ACHIEVEMENT: "ACHIEVEMENTS",
  SPECIAL_CAMPAIGN: "SPECIAL_CAMPAIGNS"
};

export function sourcesForBucket(bucket: RewardBucket): RewardSource[] {
  return (Object.keys(REWARD_BUCKET_BY_SOURCE) as RewardSource[]).filter((s) => REWARD_BUCKET_BY_SOURCE[s] === bucket);
}

export class AllocationError extends Error {}

/** Allocation buckets must each be in [0,1] and sum to at most 100%. */
export function validateAllocation(alloc: Record<string, number>): void {
  let sum = 0;
  for (const [k, v] of Object.entries(alloc)) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) throw new AllocationError(`Allocation for ${k} must be within [0, 1]`);
    sum += v;
  }
  if (sum > 1 + 1e-9) throw new AllocationError(`Reward allocation sums to ${(sum * 100).toFixed(2)}% (> 100%)`);
}

/**
 * Season reward budget = seasonRevenue * rewardBudgetRatio + explicit base funding (moved into
 * PLAYER_REWARD_POOL for that season from real treasury funds). There is no "unlimited" mode:
 * a season without revenue or funding has a budget of 0.
 */
export function seasonRewardBudget(seasonRevenue: bigint, rewardBudgetRatio: number, baseFunding = 0n): bigint {
  if (seasonRevenue < 0n || baseFunding < 0n) throw new AllocationError("Revenue/funding cannot be negative");
  if (!(rewardBudgetRatio >= 0 && rewardBudgetRatio <= 1)) throw new AllocationError("rewardBudgetRatio must be within [0, 1]");
  return mulRatioFloor(seasonRevenue, rewardBudgetRatio) + baseFunding;
}

export function bucketBudgets(budget: bigint, alloc: Record<RewardBucket, number>): Record<RewardBucket, bigint> {
  validateAllocation(alloc);
  const out = {} as Record<RewardBucket, bigint>;
  for (const b of REWARD_BUCKETS) out[b] = mulRatioFloor(budget, alloc[b] ?? 0);
  return out;
}

export interface BucketState {
  budget: bigint;
  granted: bigint;
  remaining: bigint;
}
export interface RewardBudgetState {
  seasonId: string | null;
  seasonRevenue: bigint;
  baseFunding: bigint;
  /** Nominal season budget (revenue * ratio + funding). */
  budget: bigint;
  /** Budget further limited by what the reward pool can actually back. */
  effectiveBudget: bigint;
  granted: bigint;
  remaining: bigint;
  rewardPool: bigint;
  buckets: Record<RewardBucket, BucketState>;
}

export async function getActiveSeason(db: DbOrTx, now = new Date()): Promise<{ id: string; revenue: bigint; rewardBudget: bigint; startAt: Date; endAt: Date } | null> {
  const s =
    (await db.season.findFirst({ where: { active: true, startAt: { lte: now }, endAt: { gte: now } }, orderBy: { startAt: "desc" } })) ??
    (await db.season.findFirst({ where: { startAt: { lte: now }, endAt: { gte: now } }, orderBy: { startAt: "desc" } }));
  return s ? { id: s.id, revenue: s.revenue, rewardBudget: s.rewardBudget, startAt: s.startAt, endAt: s.endAt } : null;
}

const COUNTED = ["CLAIMABLE", "CLAIMED", "PENDING_REVIEW"];

/** Budget + per-bucket remaining for the season (default: active season). */
export async function getRewardBudgetState(db: DbOrTx, cfg: EconomyConfig, seasonId?: string | null, now = new Date()): Promise<RewardBudgetState> {
  const season = seasonId ? await db.season.findUnique({ where: { id: seasonId } }) : await getActiveSeason(db, now);
  const seasonRevenue = season?.revenue ?? 0n;
  const baseFunding = season?.rewardBudget ?? 0n;
  const budget = season ? seasonRewardBudget(seasonRevenue, cfg.rewardBudgetRatio, baseFunding) : 0n;
  const rows = season
    ? await db.reward.groupBy({ by: ["source"], where: { seasonId: season.id, status: { in: COUNTED } }, _sum: { amount: true } })
    : [];
  const bySource = new Map(rows.map((r) => [r.source, r._sum.amount ?? 0n]));
  const granted = rows.reduce((s, r) => s + (r._sum.amount ?? 0n), 0n);
  const rewardPool = await getBalance(db, system(LedgerAccountType.PLAYER_REWARD_POOL, Currency.NEBX));
  // Unclaimed grants still sit in the pool; the pool must back budget - already claimed.
  const claimed = season
    ? ((await db.reward.aggregate({ where: { seasonId: season.id, status: "CLAIMED" }, _sum: { amount: true } }))._sum.amount ?? 0n)
    : 0n;
  const backable = rewardPool + claimed;
  const effectiveBudget = budget < backable ? budget : backable;
  const nominal = bucketBudgets(effectiveBudget, cfg.rewardAllocation);
  const buckets = {} as Record<RewardBucket, BucketState>;
  for (const b of REWARD_BUCKETS) {
    const g = sourcesForBucket(b).reduce((s, src) => s + (bySource.get(src) ?? 0n), 0n);
    const rem = nominal[b] - g;
    buckets[b] = { budget: nominal[b], granted: g, remaining: rem > 0n ? rem : 0n };
  }
  const remaining = effectiveBudget - granted;
  return {
    seasonId: season?.id ?? null,
    seasonRevenue,
    baseFunding,
    budget,
    effectiveBudget,
    granted,
    remaining: remaining > 0n ? remaining : 0n,
    rewardPool,
    buckets
  };
}
