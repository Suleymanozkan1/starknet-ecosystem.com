/**
 * Reputation / karma, companions (pets) and faction war scoring rules.
 * All numbers come from progression.json (`reputation`, `factionWar`) and pets.json.
 */
import type { FactionDef, FactionWarConfig, PetDef, ReputationConfig, StatKey } from "@nebula/shared";
import { Reputation } from "@nebula/shared";

// ---------------------------------------------------------------------------
// Reputation
// ---------------------------------------------------------------------------

export function clampKarma(karma: number, cfg: ReputationConfig): number {
  return Math.max(cfg.minKarma, Math.min(cfg.maxKarma, Math.round(karma)));
}

/**
 * Status priority: OUTLAW > BOUNTY_TARGET > HOSTILE > FRIENDLY > NEUTRAL.
 * (An outlaw with a bounty is still an OUTLAW; the BOUNTY entity flag is set separately.)
 */
export function reputationFor(karma: number, hasActiveBounty: boolean, cfg: ReputationConfig): Reputation {
  if (karma <= cfg.outlawKarma) return Reputation.OUTLAW;
  if (hasActiveBounty) return Reputation.BOUNTY_TARGET;
  if (karma <= cfg.hostileKarma) return Reputation.HOSTILE;
  if (karma >= cfg.friendlyKarma) return Reputation.FRIENDLY;
  return Reputation.NEUTRAL;
}

export function isOutlaw(karma: number, cfg: ReputationConfig): boolean {
  return karma <= cfg.outlawKarma;
}

/**
 * Karma decays toward neutral (0) at `decayPerHour`, never overshooting.
 * Returns the (fractional) karma after `dtSec`.
 */
export function decayKarma(karma: number, dtSec: number, cfg: ReputationConfig): number {
  if (karma === 0 || dtSec <= 0) return karma;
  const step = (cfg.decayPerHour / 3600) * dtSec;
  return karma > 0 ? Math.max(0, karma - step) : Math.min(0, karma + step);
}

// ---------------------------------------------------------------------------
// Pets
// ---------------------------------------------------------------------------

export const DEFAULT_PET_XP_PER_LEVEL = 400;

export function petLevelForXp(xp: number, def: Pick<PetDef, "maxLevel" | "xpPerLevel">): number {
  const per = Math.max(1, def.xpPerLevel ?? DEFAULT_PET_XP_PER_LEVEL);
  return Math.max(1, Math.min(def.maxLevel, 1 + Math.floor(Math.max(0, xp) / per)));
}

export function petXpToNext(xp: number, def: Pick<PetDef, "maxLevel" | "xpPerLevel">): number {
  const lvl = petLevelForXp(xp, def);
  if (lvl >= def.maxLevel) return 0;
  const per = Math.max(1, def.xpPerLevel ?? DEFAULT_PET_XP_PER_LEVEL);
  return lvl * per - Math.max(0, xp);
}

/** Ability strength multiplier for a pet level. */
export function petScale(level: number, def: Pick<PetDef, "levelScalePerLevel">): number {
  return 1 + Math.max(0, level - 1) * (def.levelScalePerLevel ?? 0);
}

/** Passive stat buff (percent points per StatKey) of a pet at `level`. */
export function petBuff(def: PetDef, level: number): Partial<Record<StatKey, number>> {
  const s = petScale(level, def);
  const out: Partial<Record<StatKey, number>> = {};
  for (const [k, v] of Object.entries(def.buff)) if (typeof v === "number") out[k as StatKey] = v * s;
  return out;
}

export function hasPetAbility(def: PetDef, a: PetDef["abilities"][number]): boolean {
  return def.abilities.includes(a);
}

/** Starter pet of a faction (factions.json `starterLoadout.pet`) — shared by API and game server. */
export function starterPetFor(faction: Pick<FactionDef, "starterLoadout">): string | null {
  return faction.starterLoadout.pet ?? null;
}

// ---------------------------------------------------------------------------
// Faction war
// ---------------------------------------------------------------------------

export interface FactionWarDelta {
  npcKills: number;
  pvpKills: number;
  resources: number;
  bossKills: number;
}

/** Score points contributed by a batch of gameplay events (territory is scored separately). */
export function factionWarPoints(d: FactionWarDelta, cfg: FactionWarConfig): number {
  return Math.floor(
    d.npcKills * cfg.npcKillPoints + d.pvpKills * cfg.pvpKillPoints + (d.resources / 100) * cfg.resourcePointsPer100 + d.bossKills * cfg.bossKillPoints,
  );
}
