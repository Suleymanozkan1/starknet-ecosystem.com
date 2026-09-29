/**
 * Effective ship stats: ShipDef + upgrade level + equipped weapons / generators /
 * modules / drones + item affixes + faction bonus + ship passives, with stat caps
 * and optional PvP normalization. Also computes gear score.
 *
 * Semantics (documented so data authors know how numbers combine):
 * - Generator / module `passive` values are FLAT for base stats (hull, shield,
 *   speed…) and PERCENT POINTS for percent stats (damage, critChance…).
 * - Faction bonus, drone `passivePerLevel`, item affixes and ship PASSIVE_STAT
 *   abilities are PERCENT for every stat.
 * - Ship & item upgrade levels scale stats by `progression.upgrade.statPercentPerLevel`.
 */
import type {
  AbilityEffect, DamageElement, DroneDef, ModuleDef, ProgressionConfig, Resistances, ShipDef, StatKey, WeaponDef,
} from "@nebula/shared";
import { RARITY_ORDER } from "@nebula/shared";
import { DEFAULT_TUNING, type SimTuning } from "./tuning.js";

export const BASE_STATS = [
  "hull", "shield", "armor", "energy", "energyRegen", "shieldRegen", "speed", "acceleration", "turnRate", "cargo", "heatCapacity",
] as const;
export type BaseStat = (typeof BASE_STATS)[number];

export const PERCENT_STATS = [
  "damage", "shieldDamage", "hullDamage", "pveDamage", "pvpDamage", "range", "critChance", "critDamage",
  "energyCost", "fireRate", "cooldownReduction", "evasion", "miningSpeed",
] as const;
export type PercentStat = (typeof PERCENT_STATS)[number];

const BASE_SET = new Set<string>(BASE_STATS);

export interface EquippedAffix { stat: StatKey; value: number; id?: string }
export interface Equipped<D> {
  def: D;
  upgradeLevel?: number;
  affixes?: EquippedAffix[];
  /** Drone level (1..maxLevel). */
  level?: number;
  /** Inventory item id (for reference in events). */
  inventoryItemId?: string;
}

export interface LoadoutInput {
  ship: ShipDef;
  shipUpgradeLevel: number;
  lasers: Equipped<WeaponDef>[];
  missiles: Equipped<WeaponDef>[];
  generators: Equipped<ModuleDef>[];
  modules: Equipped<ModuleDef>[];
  drones: Equipped<DroneDef>[];
  factionBonus?: Partial<Record<StatKey, number>>;
  /** Companion passive buff (percent points), see `petBuff`. */
  petBuff?: Partial<Record<StatKey, number>>;
  progression: ProgressionConfig;
  /** Apply PvP stat normalization caps. */
  pvpNormalized?: boolean;
}

export type WeaponGroup = "PRIMARY" | "SECONDARY";

export interface EffectiveWeapon {
  /** Stable key within the ship: `L0`, `L1`, `M0`, `D0`… */
  key: string;
  defId: string;
  type: string;
  group: WeaponGroup;
  damage: number;
  range: number;
  accuracy: number;
  /** Shots per second. */
  fireRate: number;
  energyCost: number;
  heat: number;
  critChance: number;
  /** Crit multiplier (e.g. 1.5). */
  critDamage: number;
  armorPenetration: number;
  /** Multiplier applied to shield damage. */
  shieldDamage: number;
  /** Multiplier applied to hull damage. */
  hullDamage: number;
  element: DamageElement;
  splashRadius: number;
  projectileSpeed: number;
  ammo?: string;
  color: string;
  style: string;
  /** Mining lasers extract resources instead of damaging ships. */
  mining: boolean;
}

export interface AbilitySlotDef {
  /** Stable id (`ship:<abilityId>` / `module:<index>`). */
  id: string;
  name: string;
  source: "SHIP" | "MODULE";
  kind: "ACTIVE" | "ULTIMATE" | "MODULE";
  cooldownMs: number;
  durationMs: number;
  energyCost: number;
  effect: AbilityEffect;
}

export interface EffectiveStats {
  hull: number;
  shield: number;
  armor: number;
  energy: number;
  energyRegen: number;
  shieldRegen: number;
  speed: number;
  acceleration: number;
  turnRate: number;
  cargo: number;
  heatCapacity: number;
  pct: Record<PercentStat, number>;
  resistances: Resistances;
  weapons: EffectiveWeapon[];
  /** Ship ACTIVE/ULTIMATE abilities first (skill slots), then module actives (module slots). */
  skills: AbilitySlotDef[];
  moduleActives: AbilitySlotDef[];
  gearScore: number;
}

/** Tuning for the synthetic drone weapon (drones auto-fire at the ship's target). */
export interface DroneWeaponTuning { range: number; accuracy: number; fireRate: number; element: DamageElement }
export const DEFAULT_DRONE_WEAPON: DroneWeaponTuning = { range: 35, accuracy: 0.9, fireRate: 1, element: "KINETIC" };

function emptyPct(): Record<PercentStat, number> {
  const o = {} as Record<PercentStat, number>;
  for (const k of PERCENT_STATS) o[k] = 0;
  return o;
}

function addPct(target: Record<string, number>, stat: string, value: number): void {
  target[stat] = (target[stat] ?? 0) + value;
}

function capValue(stat: string, value: number, caps: Partial<Record<string, number>>): number {
  const cap = caps[stat];
  if (cap === undefined) return value;
  return cap < 0 ? Math.max(value, cap) : Math.min(value, cap);
}

export function computeStats(input: LoadoutInput, tuning: SimTuning = DEFAULT_TUNING, droneWeapon: DroneWeaponTuning = DEFAULT_DRONE_WEAPON): EffectiveStats {
  const { ship, progression } = input;
  const upg = progression.upgrade;
  const perLevel = upg.statPercentPerLevel;
  const shipLevel = Math.max(0, Math.min(upg.maxLevel, Math.floor(input.shipUpgradeLevel)));

  const lasers = input.lasers.slice(0, ship.slots.laser);
  const missiles = input.missiles.slice(0, ship.slots.missile);
  const generators = input.generators.filter((g) => g.def.slot === "GENERATOR").slice(0, ship.slots.generator);
  const modules = input.modules.filter((m) => m.def.slot === "MODULE").slice(0, ship.slots.module);
  const drones = input.drones.slice(0, ship.slots.drone);

  // 1) base + flat additions
  const flat: Record<BaseStat, number> = { ...ship.stats };
  const pctBase: Record<string, number> = {};
  const pct = emptyPct() as Record<string, number>;

  for (const g of [...generators, ...modules]) {
    for (const [stat, v] of Object.entries(g.def.passive)) {
      if (typeof v !== "number") continue;
      if (BASE_SET.has(stat)) flat[stat as BaseStat] += v;
      else addPct(pct, stat, v);
    }
  }

  // 2) percent sources
  const percentSources: Partial<Record<StatKey, number>>[] = [];
  if (input.factionBonus) percentSources.push(input.factionBonus);
  if (input.petBuff) percentSources.push(input.petBuff);
  for (const d of drones) {
    const lvl = Math.max(1, Math.min(d.def.maxLevel, d.level ?? 1));
    const scaled: Partial<Record<StatKey, number>> = {};
    for (const [stat, v] of Object.entries(d.def.passivePerLevel)) if (typeof v === "number") scaled[stat as StatKey] = v * lvl;
    percentSources.push(scaled);
  }
  for (const a of ship.abilities) {
    if (a.kind === "PASSIVE" && a.effect.type === "PASSIVE_STAT") percentSources.push({ [a.effect.stat]: a.effect.percent });
  }
  const allItems = [...lasers, ...missiles, ...generators, ...modules, ...drones];
  // Affix caps are enforced per stat across ONE item's affixes at roll time (loot.ts);
  // here we sum them.
  for (const it of allItems) for (const af of it.affixes ?? []) percentSources.push({ [af.stat]: af.value });

  for (const src of percentSources) {
    for (const [stat, v] of Object.entries(src)) {
      if (typeof v !== "number") continue;
      if (BASE_SET.has(stat)) addPct(pctBase, stat, v);
      else addPct(pct, stat, v);
    }
  }

  // 3) upgrade scaling (ship upgrade affects durability + energy)
  const shipUpg = 1 + perLevel * shipLevel;
  const scaled: Record<BaseStat, number> = { ...flat };
  for (const s of ["hull", "shield", "armor", "energy"] as const) scaled[s] = flat[s] * shipUpg;
  for (const s of BASE_STATS) scaled[s] = scaled[s] * (1 + (pctBase[s] ?? 0) / 100);

  // 4) caps
  const caps = input.pvpNormalized ? { ...tuning.caps, ...mergeMin(tuning.caps, tuning.pvpCaps) } : tuning.caps;
  for (const k of PERCENT_STATS) pct[k] = capValue(k, pct[k] ?? 0, caps);

  const finalPct = pct as Record<PercentStat, number>;

  // 5) weapons
  const weapons: EffectiveWeapon[] = [];
  const mkWeapon = (e: Equipped<WeaponDef>, key: string, group: WeaponGroup): EffectiveWeapon => {
    const w = e.def;
    const lvl = Math.max(0, Math.min(upg.maxLevel, e.upgradeLevel ?? 0));
    const dmgMult = (1 + perLevel * lvl) * (1 + finalPct.damage / 100);
    return {
      key,
      defId: w.id,
      type: w.type,
      group,
      damage: w.damage * dmgMult,
      range: w.range * (1 + finalPct.range / 100),
      accuracy: w.accuracy,
      fireRate: w.fireRate * (1 + finalPct.fireRate / 100),
      energyCost: Math.max(0, w.energyCost * (1 + finalPct.energyCost / 100)),
      heat: w.heat,
      critChance: Math.min(1, w.critChance + finalPct.critChance / 100),
      critDamage: w.critDamage + finalPct.critDamage / 100,
      armorPenetration: Math.min(1, Math.max(0, w.armorPenetration)),
      shieldDamage: w.shieldDamage * (1 + finalPct.shieldDamage / 100),
      hullDamage: w.hullDamage * (1 + finalPct.hullDamage / 100),
      element: w.element,
      splashRadius: w.splashRadius ?? 0,
      projectileSpeed: w.projectileSpeed,
      ammo: w.ammo,
      color: w.visual.color,
      style: w.visual.style,
      mining: w.type === "MINING_LASER",
    };
  };
  lasers.forEach((e, i) => weapons.push(mkWeapon(e, `L${i}`, "PRIMARY")));
  missiles.forEach((e, i) => weapons.push(mkWeapon(e, `M${i}`, "SECONDARY")));
  drones.forEach((d, i) => {
    if (d.def.damagePerLevel <= 0) return;
    const lvl = Math.max(1, Math.min(d.def.maxLevel, d.level ?? 1));
    weapons.push({
      key: `D${i}`,
      defId: d.def.id,
      type: "DRONE_WEAPON",
      group: "PRIMARY",
      damage: d.def.damagePerLevel * lvl * (1 + finalPct.damage / 100),
      range: droneWeapon.range,
      accuracy: droneWeapon.accuracy,
      fireRate: droneWeapon.fireRate,
      energyCost: 0,
      heat: 0,
      critChance: Math.min(1, finalPct.critChance / 100),
      critDamage: 1.5 + finalPct.critDamage / 100,
      armorPenetration: 0,
      shieldDamage: 1 + finalPct.shieldDamage / 100,
      hullDamage: 1 + finalPct.hullDamage / 100,
      element: droneWeapon.element,
      splashRadius: 0,
      projectileSpeed: 90,
      color: d.def.visual.color,
      style: "bolt",
      mining: false,
    });
  });

  // 6) abilities
  const skills: AbilitySlotDef[] = ship.abilities
    .filter((a) => a.kind !== "PASSIVE")
    .slice(0, ship.slots.ability)
    .map((a) => ({
      id: `ship:${a.id}`,
      name: a.name,
      source: "SHIP" as const,
      kind: a.kind === "ULTIMATE" ? ("ULTIMATE" as const) : ("ACTIVE" as const),
      cooldownMs: a.cooldownMs,
      durationMs: a.durationMs,
      energyCost: a.energyCost,
      effect: a.effect,
    }));
  const moduleActives: AbilitySlotDef[] = [];
  modules.forEach((m, i) => {
    if (!m.def.active) return;
    moduleActives.push({
      id: `module:${i}:${m.def.id}`,
      name: m.def.name,
      source: "MODULE",
      kind: "MODULE",
      cooldownMs: m.def.cooldownMs,
      durationMs: m.def.durationMs,
      energyCost: m.def.energyCost,
      effect: m.def.active,
    });
  });

  const out: EffectiveStats = {
    ...scaled,
    turnRate: scaled.turnRate,
    pct: finalPct,
    resistances: { ...ship.resistances },
    weapons,
    skills,
    moduleActives,
    gearScore: 0,
  };
  // Score exactly what is equipped (slot-limited, slot-type filtered, clamped upgrade level).
  out.gearScore = gearScore({ ...input, shipUpgradeLevel: shipLevel, lasers, missiles, generators, modules, drones });
  return out;
}

function mergeMin(a: Partial<Record<string, number>>, b: Partial<Record<string, number>>): Partial<Record<string, number>> {
  const out: Partial<Record<string, number>> = {};
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined) continue;
    const cur = a[k];
    out[k] = cur === undefined ? v : v < 0 ? Math.max(cur, v) : Math.min(cur, v);
  }
  return out;
}

/** Gear score from `progression.gearScoreWeights`. */
export function gearScore(input: LoadoutInput): number {
  const w = input.progression.gearScoreWeights;
  const weight = (k: string): number => w[k] ?? 0;
  const itemPower = (rarity: string, upgradeLevel: number, affixes: number): number =>
    ((RARITY_ORDER as Record<string, number>)[rarity] ?? 0) * weight("rarity") + 1 + upgradeLevel * weight("upgradeLevel") + affixes * weight("affix");
  let gs = weight("ship") * (input.ship.tier * 10 + ((RARITY_ORDER as Record<string, number>)[input.ship.rarity] ?? 0) * weight("rarity") + input.shipUpgradeLevel * weight("upgradeLevel"));
  for (const e of [...input.lasers, ...input.missiles]) gs += weight("weapon") * (itemPower(e.def.rarity, e.upgradeLevel ?? 0, e.affixes?.length ?? 0) + e.def.requiredLevel / 5);
  for (const e of input.generators) gs += weight("generator") * itemPower(e.def.rarity, e.upgradeLevel ?? 0, e.affixes?.length ?? 0);
  for (const e of input.modules) gs += weight("module") * itemPower(e.def.rarity, e.upgradeLevel ?? 0, e.affixes?.length ?? 0);
  for (const e of input.drones) gs += weight("drone") * (itemPower(e.def.rarity, e.upgradeLevel ?? 0, e.affixes?.length ?? 0) + (e.level ?? 1) / 2);
  return Math.round(gs * 10);
}

/** Convert an NPC definition into the same effective-stat shape (for shared combat/movement code). */
export function npcStats(
  def: { hull: number; shield: number; armor: number; speed: number; turnRate: number; damage: number; fireRate: number; range: number; element: DamageElement; resistances: Resistances; id: string },
  mult: { hull?: number; damage?: number } = {},
): EffectiveStats {
  const hullMult = mult.hull ?? 1;
  const dmgMult = mult.damage ?? 1;
  return {
    hull: def.hull * hullMult,
    shield: def.shield * hullMult,
    armor: def.armor,
    energy: 0,
    energyRegen: 0,
    shieldRegen: def.shield * 0.02,
    speed: def.speed,
    acceleration: def.speed * 2,
    turnRate: def.turnRate,
    cargo: 0,
    heatCapacity: 0,
    pct: emptyPct(),
    resistances: { ...def.resistances },
    weapons: [
      {
        key: "N0",
        defId: `${def.id}:weapon`,
        type: "NPC",
        group: "PRIMARY",
        damage: def.damage * dmgMult,
        range: def.range,
        accuracy: 0.85,
        fireRate: def.fireRate,
        energyCost: 0,
        heat: 0,
        critChance: 0.05,
        critDamage: 1.5,
        armorPenetration: 0,
        shieldDamage: 1,
        hullDamage: 1,
        element: def.element,
        splashRadius: 0,
        projectileSpeed: 100,
        color: "#ff6b6b",
        style: "bolt",
        mining: false,
      },
    ],
    skills: [],
    moduleActives: [],
    gearScore: 0,
  };
}
