/**
 * Simulation tuning that is *physics / netcode* rather than game balance.
 *
 * Balance numbers (ship stats, weapon damage, loot, XP, prices) come from
 * `@nebula/config` JSON. What lives here are the engine-level constants that
 * both the server and client prediction must agree on (drag, boost multiplier,
 * armor curve constant, stat caps). Every function that uses them accepts an
 * optional override so ops can tune without code changes (the server reads
 * `EconomyConfig` key `game.tuning` when present).
 */
export interface SimTuning {
  /** Max-speed multiplier while boosting. */
  boostMultiplier: number;
  /** Energy per second consumed while boosting. */
  boostEnergyPerSec: number;
  /** Fraction of acceleration applied as braking when no thrust is held. */
  brakeFactor: number;
  /** Distance (units) under which click-to-move considers the target reached. */
  arriveRadius: number;
  /** Armor mitigation curve: reduction = armor / (armor + armorK). */
  armorK: number;
  /** Heat dissipated per second as a fraction of heat capacity. */
  heatDissipationPerSec: number;
  /** Overheated weapons unlock when heat drops below this fraction of capacity. */
  overheatRecoverFraction: number;
  /** Minimum/maximum final hit chance. */
  minHitChance: number;
  maxHitChance: number;
  /** Resistances are clamped to this range (negative = weakness). */
  minResist: number;
  maxResist: number;
  /** Seconds without taking damage before shields regenerate. */
  shieldRegenDelaySec: number;
  /** Boss enrage timer (ms after engage) when data provides no ENRAGE phase trigger. */
  bossEnrageAfterMs: number;
  /** NPC leash radius multiplier over aggro range. */
  npcLeashFactor: number;
  /** Hard stat caps (percent points unless noted). */
  caps: Partial<Record<string, number>>;
  /** Caps applied on top of `caps` when PvP normalization is on. */
  pvpCaps: Partial<Record<string, number>>;
}

export const DEFAULT_TUNING: SimTuning = {
  boostMultiplier: 1.6,
  boostEnergyPerSec: 18,
  brakeFactor: 0.9,
  arriveRadius: 1.5,
  armorK: 250,
  heatDissipationPerSec: 0.3,
  overheatRecoverFraction: 0.5,
  minHitChance: 0.05,
  maxHitChance: 1,
  minResist: -0.75,
  maxResist: 0.85,
  shieldRegenDelaySec: 3,
  bossEnrageAfterMs: 15 * 60_000,
  npcLeashFactor: 2.5,
  caps: {
    critChance: 60,
    critDamage: 250,
    evasion: 35,
    cooldownReduction: 40,
    damage: 150,
    shieldDamage: 100,
    hullDamage: 100,
    pveDamage: 150,
    pvpDamage: 50,
    fireRate: 60,
    range: 50,
    energyCost: -60,
    miningSpeed: 300,
  },
  pvpCaps: {
    critChance: 35,
    critDamage: 150,
    evasion: 20,
    damage: 60,
    pvpDamage: 20,
    fireRate: 30,
    range: 25,
    shieldDamage: 40,
    hullDamage: 40,
  },
};

export function mergeTuning(override?: Partial<SimTuning>): SimTuning {
  if (!override) return DEFAULT_TUNING;
  return {
    ...DEFAULT_TUNING,
    ...override,
    caps: { ...DEFAULT_TUNING.caps, ...(override.caps ?? {}) },
    pvpCaps: { ...DEFAULT_TUNING.pvpCaps, ...(override.pvpCaps ?? {}) },
  };
}

/** Injected randomness (server: seeded from crypto; tests: mulberry32). Returns [0,1). */
export type Rng = () => number;
