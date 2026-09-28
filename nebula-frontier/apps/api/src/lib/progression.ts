/** Progression formulas come from @nebula/game-core (shared with the game server). */
import { PROGRESSION } from "@nebula/config";
import { levelProgress, levelForXp, rankFor, upgradeCost } from "@nebula/game-core";
import { randomInt } from "node:crypto";

export function progressFor(xp: bigint) {
  return levelProgress(Number(xp), PROGRESSION);
}

export function levelFor(xp: bigint): number {
  return levelForXp(Number(xp), PROGRESSION);
}

export function rankOf(honor: bigint, level: number) {
  return rankFor(Number(honor), level, PROGRESSION);
}

export function upgradeCostFor(level: number) {
  return upgradeCost(level, PROGRESSION);
}

export const MAX_UPGRADE_LEVEL = PROGRESSION.upgrade.maxLevel;

/** Server-side uniform [0,1) roll from the CSPRNG (never client-influenced). */
export function secureRoll(): number {
  return randomInt(0, 1_000_000_000) / 1_000_000_000;
}
