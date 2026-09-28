/**
 * Damage pipeline (server-authoritative; the client never computes damage).
 *
 * range → accuracy roll (vs evasion) → base damage (item/upgrade/%damage) →
 * PvE/PvP modifier → buffs → crit → element vs resistance/weakness →
 * boss weak point & phase multipliers → target damage reduction →
 * shield (× shieldDamage) → armor (penetration) → hull (× hullDamage).
 *
 * Plus weapon gating (fire rate, energy, heat) and EMP / shield disruption.
 */
import type { DamageElement, Resistances } from "@nebula/shared";
import { clamp } from "@nebula/shared";
import type { EffectiveWeapon } from "./stats.js";
import { DEFAULT_TUNING, type Rng, type SimTuning } from "./tuning.js";

export interface AttackContext {
  weapon: EffectiveWeapon;
  /** Attacker percent stats relevant to context (pveDamage/pvpDamage). */
  pveDamagePct: number;
  pvpDamagePct: number;
  /** Multiplicative buffs (DAMAGE_BOOST, boss phase damageMultiplier, difficulty). */
  damageMultiplier: number;
  /** True when attacker and defender are both players. */
  pvp: boolean;
  /** Center-to-center distance. */
  distance: number;
}

export interface DefenseContext {
  shield: number;
  hull: number;
  armor: number;
  resistances: Resistances;
  /** Evasion percent points. */
  evasionPct: number;
  /** Multiplier on incoming damage (DAMAGE_REDUCTION buffs, e.g. 0.7). */
  damageTakenMultiplier: number;
  /** Boss weak point multiplier when the hit lands on a weak point (1 = none). */
  weakPointMultiplier?: number;
  /** Target is invulnerable (docked / spawn protection / safe zone). */
  invulnerable?: boolean;
}

export type MissReason = "OUT_OF_RANGE" | "EVADED" | "INVULNERABLE";

export interface HitResult {
  hit: boolean;
  miss?: MissReason;
  crit: boolean;
  weakPoint: boolean;
  element: DamageElement;
  /** Raw damage after multipliers, before shield/armor. */
  raw: number;
  shieldDamage: number;
  /** Damage mitigated by armor (reported to clients as armorDamage). */
  armorDamage: number;
  hullDamage: number;
  shieldAfter: number;
  hullAfter: number;
  killed: boolean;
}

export function hitChance(weaponAccuracy: number, evasionPct: number, tuning: SimTuning = DEFAULT_TUNING): number {
  return clamp(weaponAccuracy - evasionPct / 100, tuning.minHitChance, tuning.maxHitChance);
}

export function resistanceMultiplier(resistances: Resistances, element: DamageElement, tuning: SimTuning = DEFAULT_TUNING): number {
  const r = clamp(resistances[element] ?? 0, tuning.minResist, tuning.maxResist);
  return 1 - r;
}

export function armorReduction(armor: number, armorPenetration: number, tuning: SimTuning = DEFAULT_TUNING): number {
  const eff = Math.max(0, armor) * (1 - clamp(armorPenetration, 0, 1));
  return eff / (eff + tuning.armorK);
}

/** Theoretical maximum raw damage of a single shot — used by damage sanity checks. */
export function maxShotDamage(att: Omit<AttackContext, "distance">, weakPointMultiplier = 1, tuning: SimTuning = DEFAULT_TUNING): number {
  const ctxPct = att.pvp ? att.pvpDamagePct : att.pveDamagePct;
  const worstResist = 1 - tuning.minResist;
  return att.weapon.damage * (1 + ctxPct / 100) * att.damageMultiplier * Math.max(1, att.weapon.critDamage) * worstResist * Math.max(1, weakPointMultiplier)
    * Math.max(att.weapon.shieldDamage, att.weapon.hullDamage, 1);
}

/** Resolve one shot. Pure given `rng`. */
export function resolveHit(att: AttackContext, def: DefenseContext, rng: Rng, tuning: SimTuning = DEFAULT_TUNING): HitResult {
  const w = att.weapon;
  const base: HitResult = {
    hit: false, crit: false, weakPoint: false, element: w.element, raw: 0,
    shieldDamage: 0, armorDamage: 0, hullDamage: 0, shieldAfter: def.shield, hullAfter: def.hull, killed: false,
  };
  if (att.distance > w.range) return { ...base, miss: "OUT_OF_RANGE" };
  if (def.invulnerable) return { ...base, miss: "INVULNERABLE" };
  // Always consume the same number of rng draws for determinism across branches.
  const rollHit = rng();
  const rollCrit = rng();
  if (rollHit >= hitChance(w.accuracy, def.evasionPct, tuning)) return { ...base, miss: "EVADED" };

  let dmg = w.damage;
  dmg *= 1 + (att.pvp ? att.pvpDamagePct : att.pveDamagePct) / 100;
  dmg *= Math.max(0, att.damageMultiplier);
  const crit = rollCrit < w.critChance;
  if (crit) dmg *= Math.max(1, w.critDamage);
  dmg *= resistanceMultiplier(def.resistances, w.element, tuning);
  const wp = def.weakPointMultiplier ?? 1;
  const weakPoint = wp > 1;
  dmg *= wp;
  dmg *= Math.max(0, def.damageTakenMultiplier);
  const raw = Math.max(0, dmg);

  // Shield first (scaled by shieldDamage), remainder converted back to raw units.
  let remainingRaw = raw;
  let shieldDamage = 0;
  let shield = def.shield;
  if (shield > 0 && w.shieldDamage > 0) {
    const shieldPortion = raw * w.shieldDamage;
    shieldDamage = Math.min(shield, shieldPortion);
    shield -= shieldDamage;
    remainingRaw = (shieldPortion - shieldDamage) / w.shieldDamage;
  }

  let hullDamage = 0;
  let armorDamage = 0;
  let hull = def.hull;
  if (remainingRaw > 0) {
    const preArmor = remainingRaw * w.hullDamage;
    const red = armorReduction(def.armor, w.armorPenetration, tuning);
    armorDamage = preArmor * red;
    hullDamage = Math.min(hull, preArmor - armorDamage);
    hull -= hullDamage;
  }

  const r = (v: number) => Math.round(v);
  return {
    hit: true,
    crit,
    weakPoint,
    element: w.element,
    raw: r(raw),
    shieldDamage: r(shieldDamage),
    armorDamage: r(armorDamage),
    hullDamage: r(hullDamage),
    shieldAfter: Math.max(0, r(shield)),
    hullAfter: Math.max(0, r(hull)),
    killed: hull <= 0.5,
  };
}

/** Flat area damage (special attacks, barrage, splash): no accuracy roll, still resisted & armored. */
export function resolveAreaDamage(
  damage: number,
  element: DamageElement,
  def: DefenseContext,
  tuning: SimTuning = DEFAULT_TUNING,
): HitResult {
  const weapon: EffectiveWeapon = {
    key: "AREA", defId: "area", type: "SPECIAL", group: "SECONDARY", damage, range: Infinity, accuracy: 1, fireRate: 1,
    energyCost: 0, heat: 0, critChance: 0, critDamage: 1, armorPenetration: 0, shieldDamage: 1, hullDamage: 1,
    element, splashRadius: 0, projectileSpeed: 0, color: "#ffffff", style: "wave", mining: false,
  };
  return resolveHit(
    { weapon, pveDamagePct: 0, pvpDamagePct: 0, damageMultiplier: 1, pvp: false, distance: 0 },
    { ...def, evasionPct: 0 },
    () => 0,
    { ...tuning, minHitChance: 1 },
  );
}

// ---------------------------------------------------------------------------
// Weapon gating: fire rate, energy, heat
// ---------------------------------------------------------------------------

export interface WeaponRuntime {
  /** Timestamp (ms) at which the weapon may fire next. */
  readyAt: number;
}

export interface HeatState {
  heat: number;
  overheated: boolean;
}

export type FireBlock = "COOLDOWN" | "ENERGY" | "OVERHEAT" | "NO_AMMO";

export function fireIntervalMs(weapon: EffectiveWeapon): number {
  return weapon.fireRate > 0 ? 1000 / weapon.fireRate : Infinity;
}

/**
 * Check & consume the costs of firing. Returns the new runtime/heat/energy or
 * the reason firing is blocked. Callers must not bypass this — it is the
 * attack-speed hack guard (fire rate is enforced on the server clock).
 */
export function tryFire(
  weapon: EffectiveWeapon,
  rt: WeaponRuntime,
  heat: HeatState,
  energy: number,
  heatCapacity: number,
  now: number,
  hasAmmo = true,
): { ok: true; rt: WeaponRuntime; heat: HeatState; energy: number } | { ok: false; reason: FireBlock } {
  if (now < rt.readyAt) return { ok: false, reason: "COOLDOWN" };
  if (heat.overheated) return { ok: false, reason: "OVERHEAT" };
  if (energy < weapon.energyCost) return { ok: false, reason: "ENERGY" };
  if (weapon.ammo && !hasAmmo) return { ok: false, reason: "NO_AMMO" };
  const newHeat = heat.heat + weapon.heat;
  const overheated = heatCapacity > 0 && newHeat >= heatCapacity;
  // Schedule next shot relative to the previous slot when firing continuously to avoid drift,
  // but never earlier than one full interval from now minus one tick of slack.
  const interval = fireIntervalMs(weapon);
  const next = Math.max(now, rt.readyAt) + interval;
  return {
    ok: true,
    rt: { readyAt: next },
    heat: { heat: Math.min(newHeat, heatCapacity > 0 ? heatCapacity : newHeat), overheated },
    energy: energy - weapon.energyCost,
  };
}

export function coolHeat(heat: HeatState, heatCapacity: number, dt: number, tuning: SimTuning = DEFAULT_TUNING): HeatState {
  if (heatCapacity <= 0) return { heat: 0, overheated: false };
  const h = Math.max(0, heat.heat - heatCapacity * tuning.heatDissipationPerSec * dt);
  const overheated = heat.overheated && h > heatCapacity * tuning.overheatRecoverFraction;
  return { heat: h, overheated };
}

// ---------------------------------------------------------------------------
// Regeneration, EMP, shield disruption
// ---------------------------------------------------------------------------

export interface Vitals {
  hull: number;
  shield: number;
  energy: number;
  maxHull: number;
  maxShield: number;
  maxEnergy: number;
  /** Timestamp of last damage taken (ms). */
  lastDamagedAt: number;
  /** Shield regen disabled until (EMP). */
  shieldDisruptedUntil: number;
}

export function regenerate(v: Vitals, shieldRegen: number, energyRegen: number, dt: number, now: number, tuning: SimTuning = DEFAULT_TUNING): Vitals {
  const canShield = now >= v.shieldDisruptedUntil && now - v.lastDamagedAt >= tuning.shieldRegenDelaySec * 1000;
  return {
    ...v,
    shield: canShield ? Math.min(v.maxShield, v.shield + shieldRegen * dt) : v.shield,
    energy: Math.min(v.maxEnergy, v.energy + energyRegen * dt),
  };
}

export interface EmpResult { shieldDamage: number; shieldAfter: number; stunnedUntil: number; shieldDisruptedUntil: number }

/** EMP strips a percentage of max shield, stuns, and disables shield regen for the stun duration ×2. */
export function applyEmp(shield: number, maxShield: number, shieldDamagePercent: number, stunMs: number, now: number, resistEm = 0): EmpResult {
  const mult = 1 - clamp(resistEm, 0, 0.9);
  const dmg = Math.min(shield, maxShield * (shieldDamagePercent / 100) * mult);
  return {
    shieldDamage: Math.round(dmg),
    shieldAfter: Math.max(0, Math.round(shield - dmg)),
    stunnedUntil: now + Math.round(stunMs * mult),
    shieldDisruptedUntil: now + Math.round(stunMs * 2 * mult),
  };
}

// ---------------------------------------------------------------------------
// Boss helpers
// ---------------------------------------------------------------------------

/**
 * Weak point: the boss exposes its reactor at the rear. A hit counts as a
 * weak-point hit when the attacker is within `arc` radians of the boss's rear.
 */
export function isWeakPointHit(bossX: number, bossY: number, bossHeading: number, attackerX: number, attackerY: number, arc = Math.PI / 4): boolean {
  const toAttacker = Math.atan2(attackerY - bossY, attackerX - bossX);
  const rear = bossHeading + Math.PI;
  let d = Math.abs(toAttacker - rear) % (Math.PI * 2);
  if (d > Math.PI) d = Math.PI * 2 - d;
  return d <= arc;
}
