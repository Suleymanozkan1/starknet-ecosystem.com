/**
 * XP curve, levels, ranks, prestige and equipment upgrade (+1..+N) costs,
 * all driven by `progression.json` (ProgressionConfig).
 */
import type { ProgressionConfig, ResourceId } from "@nebula/shared";
import type { Rng } from "./tuning.js";

/**
 * Cumulative XP required to REACH `level`.
 * Level 1 = 0; level n (n ≥ 2) = round(xpBase × (n−1)^xpExponent).
 */
export function xpForLevel(level: number, cfg: ProgressionConfig): number {
  if (level <= 1) return 0;
  const n = Math.min(level, cfg.maxLevel);
  return Math.round(cfg.xpBase * Math.pow(n - 1, cfg.xpExponent));
}

/** Level reached with `xp` total experience (capped at maxLevel). */
export function levelForXp(xp: number, cfg: ProgressionConfig): number {
  if (!Number.isFinite(xp) || xp <= 0) return 1;
  // Invert the closed form, then correct for rounding.
  let lvl = Math.floor(Math.pow(xp / cfg.xpBase, 1 / cfg.xpExponent)) + 1;
  lvl = Math.max(1, Math.min(cfg.maxLevel, lvl));
  while (lvl < cfg.maxLevel && xpForLevel(lvl + 1, cfg) <= xp) lvl++;
  while (lvl > 1 && xpForLevel(lvl, cfg) > xp) lvl--;
  return lvl;
}

export interface LevelProgress {
  level: number;
  xpIntoLevel: number;
  xpToNext: number;
  maxed: boolean;
}

export function levelProgress(xp: number, cfg: ProgressionConfig): LevelProgress {
  const level = levelForXp(xp, cfg);
  if (level >= cfg.maxLevel) return { level, xpIntoLevel: xp - xpForLevel(level, cfg), xpToNext: 0, maxed: true };
  const cur = xpForLevel(level, cfg);
  const next = xpForLevel(level + 1, cfg);
  return { level, xpIntoLevel: xp - cur, xpToNext: next - xp, maxed: false };
}

export interface XpGrant {
  xpBefore: number;
  xpAfter: number;
  levelBefore: number;
  levelAfter: number;
  levelsGained: number[];
}

export function grantXp(xpBefore: number, amount: number, cfg: ProgressionConfig): XpGrant {
  const add = Math.max(0, Math.floor(amount));
  const xpAfter = xpBefore + add;
  const levelBefore = levelForXp(xpBefore, cfg);
  const levelAfter = levelForXp(xpAfter, cfg);
  const levelsGained: number[] = [];
  for (let l = levelBefore + 1; l <= levelAfter; l++) levelsGained.push(l);
  return { xpBefore, xpAfter, levelBefore, levelAfter, levelsGained };
}

/** Highest rank whose honor AND level requirements are met. */
export function rankFor(honor: number, level: number, cfg: ProgressionConfig): { id: string; name: string } {
  let best = cfg.ranks[0] ?? { id: "rank_cadet", name: "Cadet", minHonor: 0, minLevel: 1 };
  for (const r of cfg.ranks) if (honor >= r.minHonor && level >= r.minLevel && r.minHonor >= best.minHonor) best = r;
  return { id: best.id, name: best.name };
}

export function canPrestige(level: number, cfg: ProgressionConfig): boolean {
  return level >= cfg.prestigeLevel;
}

/** Prestige resets level/xp and increments the prestige counter. */
export function applyPrestige(p: { level: number; xp: number; prestige: number }, cfg: ProgressionConfig): { level: number; xp: number; prestige: number } {
  if (!canPrestige(p.level, cfg)) throw new Error("Prestige requires max level");
  return { level: 1, xp: 0, prestige: p.prestige + 1 };
}

export interface UpgradeCost {
  fromLevel: number;
  toLevel: number;
  credits: number;
  gems: number;
  resources: Partial<Record<ResourceId, number>>;
  successChance: number;
}

/** Cost and success chance of upgrading from `level` to `level+1`. */
export function upgradeCost(level: number, cfg: ProgressionConfig): UpgradeCost {
  const u = cfg.upgrade;
  if (level < 0 || level >= u.maxLevel) throw new Error(`Cannot upgrade from +${level} (max +${u.maxLevel})`);
  const credits = Math.round(u.creditsBase * Math.pow(u.creditsGrowth, level));
  const resources: Partial<Record<ResourceId, number>> = {};
  for (const [res, base] of Object.entries(u.resourceBase)) {
    if (typeof base === "number") resources[res as ResourceId] = Math.ceil(base * Math.pow(u.resourceGrowth, level));
  }
  const toLevel = level + 1;
  const gems = toLevel >= u.gemsFromLevel ? u.gemsPerLevel * (toLevel - u.gemsFromLevel + 1) : 0;
  const successChance = Math.max(0.05, Math.min(1, u.successChanceBase - u.successChanceDecay * level));
  return { fromLevel: level, toLevel, credits, gems, resources, successChance };
}

export function rollUpgrade(level: number, cfg: ProgressionConfig, rng: Rng): { success: boolean; cost: UpgradeCost; newLevel: number } {
  const cost = upgradeCost(level, cfg);
  const success = rng() < cost.successChance;
  return { success, cost, newLevel: success ? cost.toLevel : level };
}

/** Death repair cost in credits. */
export function deathRepairCost(maxHull: number, cfg: ProgressionConfig): number {
  return Math.max(0, Math.round(maxHull * cfg.repair.deathRepairPercent * cfg.repair.creditsPerHullPoint));
}

/** Repair cost for current hull damage (station repair). */
export function repairCost(missingHull: number, cfg: ProgressionConfig): number {
  return Math.max(0, Math.ceil(missingHull * cfg.repair.creditsPerHullPoint));
}
