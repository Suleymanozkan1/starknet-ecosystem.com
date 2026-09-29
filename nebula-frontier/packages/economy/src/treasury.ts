import { LedgerAccountType, TreasuryHealth, Currency } from "@nebula/shared";
import { getBalance, system, type DbOrTx } from "@nebula/database";
import type { EconomyConfig } from "./config.js";
import { DAY_MS, ratio } from "./util.js";

export interface TreasuryHealthInput {
  availableReserve: bigint;
  outstandingLiability: bigint;
  /** Expected new reward grants over the next 30 days. */
  projected30dEmission: bigint;
}

export interface TreasuryHealthResult {
  health: TreasuryHealth;
  /** availableReserve / projected 30-day liabilities. Infinity when nothing is owed. */
  coverage: number;
  projected30dLiability: bigint;
  multiplier: number;
}

/** Pure: reserve coverage → HEALTHY / WATCH / WARNING / CRITICAL (thresholds from config). */
export function computeTreasuryHealth(input: TreasuryHealthInput, cfg: Pick<EconomyConfig, "treasuryHealth" | "minTreasuryReserve">): TreasuryHealthResult {
  const projected30dLiability = input.outstandingLiability + input.projected30dEmission;
  const coverage = projected30dLiability === 0n ? (input.availableReserve > 0n ? Number.POSITIVE_INFINITY : 0) : ratio(input.availableReserve, projected30dLiability);
  const t = cfg.treasuryHealth;
  let health: TreasuryHealth =
    coverage >= t.healthy ? TreasuryHealth.HEALTHY : coverage >= t.watch ? TreasuryHealth.WATCH : coverage >= t.warning ? TreasuryHealth.WARNING : TreasuryHealth.CRITICAL;
  // An almost-empty treasury is never "healthy", even with no liabilities yet.
  if (input.availableReserve < cfg.minTreasuryReserve && (health === TreasuryHealth.HEALTHY || health === TreasuryHealth.WATCH)) {
    health = TreasuryHealth.WARNING;
  }
  return { health, coverage, projected30dLiability, multiplier: t.multipliers[health] };
}

export interface TreasuryState extends TreasuryHealthResult {
  asset: Currency;
  rewardPool: bigint;
  rewardReserve: bigint;
  treasury: bigint;
  operatingReserve: bigint;
  emergencyReserve: bigint;
  withdrawalReserve: bigint;
  availableReserve: bigint;
  outstandingLiability: bigint;
  projected30dEmission: bigint;
  avgDailyEmission7d: bigint;
}

export async function getOutstandingLiability(db: DbOrTx, asset: Currency = Currency.NEBX): Promise<bigint> {
  const agg = await db.rewardLiability.aggregate({ where: { status: "OUTSTANDING", asset }, _sum: { amount: true } });
  return agg._sum.amount ?? 0n;
}

/** Reads ledger balances + liabilities and computes treasury health for the reward asset. */
export async function getTreasuryState(db: DbOrTx, cfg: EconomyConfig, now = new Date()): Promise<TreasuryState> {
  const asset = Currency.NEBX;
  const [rewardPool, rewardReserve, treasury, operatingReserve, emergencyReserve, withdrawalReserve, outstandingLiability, recent] = await Promise.all([
    getBalance(db, system(LedgerAccountType.PLAYER_REWARD_POOL, asset)),
    getBalance(db, system(LedgerAccountType.REWARD_RESERVE, asset)),
    getBalance(db, system(LedgerAccountType.TREASURY, asset)),
    getBalance(db, system(LedgerAccountType.OPERATING_RESERVE, asset)),
    getBalance(db, system(LedgerAccountType.EMERGENCY_RESERVE, asset)),
    getBalance(db, system(LedgerAccountType.WITHDRAWAL_RESERVE, asset)),
    getOutstandingLiability(db, asset),
    db.reward.aggregate({
      where: { asset, createdAt: { gte: new Date(now.getTime() - 7 * DAY_MS) }, status: { notIn: ["REJECTED"] } },
      _sum: { amount: true }
    })
  ]);
  const avgDailyEmission7d = (recent._sum.amount ?? 0n) / 7n;
  const projected30dEmission = avgDailyEmission7d * 30n;
  // Money that can back rewards: the pool itself plus dedicated reward reserve and unallocated treasury.
  const availableReserve = rewardPool + rewardReserve + treasury;
  const h = computeTreasuryHealth({ availableReserve, outstandingLiability, projected30dEmission }, cfg);
  return {
    asset,
    rewardPool,
    rewardReserve,
    treasury,
    operatingReserve,
    emergencyReserve,
    withdrawalReserve,
    availableReserve,
    outstandingLiability,
    projected30dEmission,
    avgDailyEmission7d,
    ...h
  };
}
