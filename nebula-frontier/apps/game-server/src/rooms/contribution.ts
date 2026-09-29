/**
 * Boss / raid contribution helpers (pure). A contributor only counts toward reward scaling when its damage share
 * reaches `minShare`, so a low-damage alt ("tagging" the boss) cannot inflate a raid's reward scale or the per-pilot
 * contribution factors. Full contributor lists are still used for match accounting and persistence.
 */
export interface Contribution {
  dmg: number;
}

export interface QualifiedContributors<T extends Contribution> {
  /** Contributors whose share is at least `minShare` (all of them when no damage was recorded). */
  qualified: T[];
  totalDmg: number;
}

export function qualifyContributors<T extends Contribution>(contributors: readonly T[], minShare: number): QualifiedContributors<T> {
  const totalDmg = contributors.reduce((s, c) => s + (Number.isFinite(c.dmg) && c.dmg > 0 ? c.dmg : 0), 0);
  if (totalDmg <= 0) return { qualified: [...contributors], totalDmg: 0 };
  return { qualified: contributors.filter((c) => c.dmg / totalDmg >= minShare), totalDmg };
}

/** Raid-boss reward scale: 0 below `minPilots` qualified pilots, else `min(1, qualified / raidSize)`. */
export function raidRewardScale(qualified: number, raidSize: number, minPilots: number): number {
  if (qualified < minPilots || raidSize <= 0) return 0;
  return Math.min(1, qualified / raidSize);
}

/** RAID crypto weight for one qualified pilot. */
export function raidCryptoWeight(share: number, qualified: number, scale: number): number {
  return Math.max(0.2, Math.min(3, share * qualified)) * scale;
}
