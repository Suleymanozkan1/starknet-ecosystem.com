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
import { z } from "zod";

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
  /** Damage multiplier for time-based enrage (phase-based enrage uses the phase's own multiplier). */
  bossEnrageDamageMultiplier: number;
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
  bossEnrageDamageMultiplier: 1.5,
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

const CAP_KEYS = [
  "damage", "shieldDamage", "hullDamage", "pveDamage", "pvpDamage", "range", "critChance", "critDamage",
  "energyCost", "fireRate", "cooldownReduction", "evasion", "miningSpeed",
] as const;
const finite = z.number().refine((n) => Number.isFinite(n), "must be finite");
const nonNeg = finite.refine((n) => n >= 0, "must be >= 0");
const positive = finite.refine((n) => n > 0, "must be > 0");
const fraction = finite.refine((n) => n >= 0 && n <= 1, "must be within 0..1");
const capsSchema = z.object(Object.fromEntries(CAP_KEYS.map((k) => [k, finite.optional()])) as Record<(typeof CAP_KEYS)[number], z.ZodOptional<typeof finite>>).strict();

/** Strict schema for (partial) tuning overrides; unknown keys — including unknown cap keys — are rejected. */
export const SimTuningOverrideSchema = z.object({
  boostMultiplier: finite.refine((n) => n >= 1 && n <= 5, "must be within 1..5").optional(),
  boostEnergyPerSec: nonNeg.optional(),
  brakeFactor: positive.optional(),
  arriveRadius: nonNeg.optional(),
  armorK: positive.optional(),
  heatDissipationPerSec: nonNeg.optional(),
  overheatRecoverFraction: fraction.optional(),
  minHitChance: fraction.optional(),
  maxHitChance: fraction.optional(),
  minResist: finite.refine((n) => n >= -1 && n <= 0, "must be within -1..0").optional(),
  maxResist: finite.refine((n) => n >= 0 && n < 1, "must be within 0..1").optional(),
  shieldRegenDelaySec: nonNeg.optional(),
  bossEnrageAfterMs: positive.optional(),
  bossEnrageDamageMultiplier: positive.optional(),
  npcLeashFactor: positive.optional(),
  caps: capsSchema.optional(),
  pvpCaps: capsSchema.optional(),
}).strict().refine(
  // Checked against the merged result: a partial override (e.g. only maxHitChance) must not invert the default range.
  (t) => (t.minHitChance ?? DEFAULT_TUNING.minHitChance) <= (t.maxHitChance ?? DEFAULT_TUNING.maxHitChance),
  "minHitChance must be <= maxHitChance (after applying defaults)",
).refine(
  (t) => (t.minResist ?? DEFAULT_TUNING.minResist) < (t.maxResist ?? DEFAULT_TUNING.maxResist),
  "minResist must be < maxResist (after applying defaults)",
);
export type SimTuningOverride = z.infer<typeof SimTuningOverrideSchema>;

function cloneTuning(t: SimTuning): SimTuning {
  return { ...t, caps: { ...t.caps }, pvpCaps: { ...t.pvpCaps } };
}

/** Validate an untrusted override (e.g. EconomyConfig `game.tuning`). */
export function parseTuningOverride(raw: unknown): { ok: true; value: SimTuningOverride } | { ok: false; error: string } {
  const r = SimTuningOverrideSchema.safeParse(raw);
  return r.success ? { ok: true, value: r.data } : { ok: false, error: r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") };
}

/**
 * Merge a tuning override onto the defaults. Always returns a fresh object
 * (callers can never mutate DEFAULT_TUNING). Invalid overrides are ignored
 * entirely (defaults are returned); use `parseTuningOverride` to get the error.
 */
export function mergeTuning(override?: unknown): SimTuning {
  if (override === undefined || override === null) return cloneTuning(DEFAULT_TUNING);
  const parsed = parseTuningOverride(override);
  if (!parsed.ok) return cloneTuning(DEFAULT_TUNING);
  const o = parsed.value;
  const merged = cloneTuning(DEFAULT_TUNING);
  for (const [k, v] of Object.entries(o)) {
    if (k === "caps" || k === "pvpCaps" || v === undefined) continue;
    (merged as unknown as Record<string, unknown>)[k] = v;
  }
  merged.caps = { ...merged.caps, ...(o.caps ?? {}) };
  merged.pvpCaps = { ...merged.pvpCaps, ...(o.pvpCaps ?? {}) };
  return merged;
}

/** Injected randomness (server: seeded from crypto; tests: mulberry32). Returns [0,1). */
export type Rng = () => number;
