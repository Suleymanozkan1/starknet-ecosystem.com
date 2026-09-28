/**
 * Mining yield: mining lasers (and mining drones via miningSpeed%) extract
 * resources from asteroids over time, limited by the asteroid's remaining
 * amount and the ship's free cargo.
 */
import type { ResourceId } from "@nebula/shared";
import type { Rng } from "./tuning.js";
import { weightedPick } from "./loot.js";

export interface AsteroidState {
  resource: ResourceId;
  /** Remaining units. */
  amount: number;
  /** Fractional extraction carried between ticks. */
  progress: number;
}

export interface MiningResult {
  asteroid: AsteroidState;
  extracted: number;
  depleted: boolean;
}

/**
 * Advance mining for `dt` seconds. `miningPower` is the summed mining laser
 * damage per second (weapon.damage × fireRate); `miningSpeedPct` from stats.
 * Units per second = miningPower / hardness.
 */
export function mineStep(a: AsteroidState, miningPower: number, miningSpeedPct: number, dt: number, freeCargo: number, hardness = 10): MiningResult {
  if (a.amount <= 0 || miningPower <= 0 || freeCargo <= 0) return { asteroid: a, extracted: 0, depleted: a.amount <= 0 };
  const rate = (miningPower / Math.max(0.1, hardness)) * (1 + miningSpeedPct / 100);
  const progress = a.progress + rate * Math.max(0, dt);
  let whole = Math.floor(progress);
  whole = Math.min(whole, a.amount, Math.floor(freeCargo));
  const asteroid = { ...a, amount: a.amount - whole, progress: progress - whole };
  if (whole === 0 && Math.floor(freeCargo) <= 0) asteroid.progress = 0;
  return { asteroid, extracted: whole, depleted: asteroid.amount <= 0 };
}

/** Pick an asteroid's resource from a field's weighted resource list. */
export function pickAsteroidResource(resources: { id: ResourceId; weight: number }[], rng: Rng): ResourceId {
  const idx = weightedPick(resources.map((r) => r.weight), rng);
  return resources[Math.max(0, idx)]?.id ?? "TITANIUM";
}

/** Relative hardness per resource rarity (rarer = slower). */
export const RESOURCE_HARDNESS: Record<ResourceId, number> = {
  TITANIUM: 8, PLASMA_ORE: 12, CRYONITE: 16, DARK_MATTER: 30, QUANTUM_SHARD: 40, AETHER_CRYSTAL: 50, VOID_ESSENCE: 70,
};
