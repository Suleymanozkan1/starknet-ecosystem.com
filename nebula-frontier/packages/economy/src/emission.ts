import type { EconomyConfig } from "./config.js";
import type { TreasuryHealth } from "@nebula/shared";

export interface EmissionInput {
  baseRate: number;
  activityMultiplier: number;
  seasonMultiplier: number;
  treasuryHealthMultiplier: number;
  /** Controller throttle (inflation response), 0..1. */
  throttle?: number;
  maxRewardRate: number;
}

export interface EmissionResult {
  rate: number;
  uncapped: number;
  hardCapped: boolean;
}

/**
 * rate = baseRate * activityMultiplier * seasonMultiplier * treasuryHealthMultiplier * throttle,
 * hard-capped at maxRewardRate. The rate is the fraction of the season reward budget that may be
 * emitted per day; it also scales per-reward amounts relative to baseRate.
 */
export function computeEmissionRate(i: EmissionInput): EmissionResult {
  const parts = [i.baseRate, i.activityMultiplier, i.seasonMultiplier, i.treasuryHealthMultiplier, i.throttle ?? 1];
  if (parts.some((p) => !Number.isFinite(p) || p < 0)) return { rate: 0, uncapped: 0, hardCapped: false };
  const uncapped = parts.reduce((a, b) => a * b, 1);
  const cap = Math.max(0, i.maxRewardRate);
  return { rate: Math.min(uncapped, cap), uncapped, hardCapped: uncapped > cap };
}

export function emissionFromConfig(cfg: EconomyConfig, health: TreasuryHealth): EmissionResult {
  const activity = Math.min(Math.max(cfg.runtime.activityMultiplier, 0), cfg.emission.activityMultiplierMax);
  return computeEmissionRate({
    baseRate: cfg.runtime.rewardRateOverride ?? cfg.emission.baseRate,
    activityMultiplier: activity,
    seasonMultiplier: cfg.emission.seasonMultiplier,
    treasuryHealthMultiplier: cfg.treasuryHealth.multipliers[health],
    throttle: cfg.runtime.throttleMultiplier,
    maxRewardRate: cfg.emission.maxRewardRate
  });
}

/** Reward amount for a given weight: weight * rewardUnit * (rate / baseRate), floored to lamports. */
export function rewardAmountForWeight(weight: number, rate: number, cfg: Pick<EconomyConfig, "emission">): bigint {
  if (!Number.isFinite(weight) || weight <= 0 || rate <= 0) return 0n;
  const base = cfg.emission.baseRate > 0 ? cfg.emission.baseRate : 1;
  const amount = Math.floor(weight * cfg.emission.rewardUnitLamports * (rate / base));
  return amount > 0 ? BigInt(amount) : 0n;
}

/** Daily emission ceiling: seasonBudget * rate. */
export function dailyEmissionCap(seasonBudget: bigint, rate: number): bigint {
  if (rate <= 0 || seasonBudget <= 0n) return 0n;
  return (seasonBudget * BigInt(Math.round(rate * 1_000_000))) / 1_000_000n;
}
