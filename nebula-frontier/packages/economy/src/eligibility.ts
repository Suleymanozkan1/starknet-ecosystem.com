import { RiskLevel } from "@nebula/shared";
import type { DbOrTx } from "@nebula/database";
import type { EconomyConfig } from "./config.js";

export const RISK_ORDER: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

export function riskAtMost(level: string, max: RiskLevel): boolean {
  const l = RISK_ORDER[level as RiskLevel] ?? RISK_ORDER.CRITICAL;
  return l <= RISK_ORDER[max];
}

export interface EligibilityUser {
  createdAt: Date;
  riskLevel: string;
  playtimeSeconds: bigint | number;
  matchesPlayed: number;
  bannedAt: Date | null;
  restrictions: string[];
}

export interface EligibilityInput {
  user: EligibilityUser;
  /** Match mode that produced the reward (if any). */
  mode?: string | null;
  now?: Date;
}

export interface EligibilityResult {
  eligible: boolean;
  reasons: string[];
}

/** Restrictions that block crypto rewards. */
export const REWARD_BLOCKING_RESTRICTIONS = ["NO_REWARDS", "NO_CRYPTO_REWARDS", "SUSPENDED"];

/** Pure eligibility check for crypto rewards. Collects ALL failing reasons (shown to the player). */
export function checkRewardEligibility(input: EligibilityInput, cfg: Pick<EconomyConfig, "eligibility">): EligibilityResult {
  const e = cfg.eligibility;
  const now = input.now ?? new Date();
  const reasons: string[] = [];
  const u = input.user;
  if (u.bannedAt) reasons.push("Account is suspended");
  for (const r of u.restrictions) if (REWARD_BLOCKING_RESTRICTIONS.includes(r)) reasons.push(`Account restriction: ${r}`);
  const ageHours = (now.getTime() - u.createdAt.getTime()) / 3_600_000;
  if (ageHours < e.minAccountAgeHours) reasons.push(`Account must be at least ${e.minAccountAgeHours}h old`);
  if (!riskAtMost(u.riskLevel, e.maxRiskLevel as RiskLevel)) reasons.push("Account is under security review");
  const minutes = Number(u.playtimeSeconds) / 60;
  if (minutes < e.minGameplayMinutes) reasons.push(`Play at least ${e.minGameplayMinutes} minutes`);
  if (u.matchesPlayed < e.minCompletedMatches) reasons.push(`Complete at least ${e.minCompletedMatches} matches`);
  if (input.mode && !e.eligibleModes.includes(input.mode)) reasons.push(`Mode ${input.mode} does not grant Battle Rewards`);
  return { eligible: reasons.length === 0, reasons };
}

/** Claim cooldown between two claims. Returns the time the next claim is allowed, or null. */
export function claimCooldownUntil(lastClaimAt: Date | null, cfg: Pick<EconomyConfig, "eligibility">, now = new Date()): Date | null {
  if (!lastClaimAt) return null;
  const until = new Date(lastClaimAt.getTime() + cfg.eligibility.claimCooldownMinutes * 60_000);
  return until > now ? until : null;
}

export async function getRewardEligibility(db: DbOrTx, userId: string, cfg: EconomyConfig, mode?: string | null, now = new Date()): Promise<EligibilityResult> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { createdAt: true, riskLevel: true, playtimeSeconds: true, matchesPlayed: true, bannedAt: true, restrictions: true }
  });
  if (!user) return { eligible: false, reasons: ["Unknown user"] };
  return checkRewardEligibility({ user, mode, now }, cfg);
}
