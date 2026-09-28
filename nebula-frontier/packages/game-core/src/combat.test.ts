import { describe, expect, it } from "vitest";
import { mulberry32 } from "@nebula/shared";
import { FACTIONS_BY_ID, MODULES_BY_ID, PROGRESSION, SHIPS_BY_ID, WEAPONS_BY_ID, DRONES_BY_ID } from "@nebula/config";
import {
  applyEmp, armorReduction, coolHeat, isWeakPointHit, maxShotDamage, regenerate, resolveAreaDamage, resolveHit, tryFire,
  type DefenseContext,
} from "./combat.js";
import { computeStats, type EffectiveWeapon, type LoadoutInput } from "./stats.js";
import { isDamageImpossible } from "./anticheat.js";

function weapon(p: Partial<EffectiveWeapon> = {}): EffectiveWeapon {
  return {
    key: "L0", defId: "w", type: "LASER", group: "PRIMARY", damage: 100, range: 40, accuracy: 1, fireRate: 2, energyCost: 2, heat: 3,
    critChance: 0, critDamage: 1.5, armorPenetration: 0, shieldDamage: 1, hullDamage: 1, element: "THERMAL", splashRadius: 0,
    projectileSpeed: 100, color: "#fff", style: "bolt", mining: false, ...p,
  };
}
const target = (p: Partial<DefenseContext> = {}): DefenseContext => ({
  shield: 0, hull: 1000, armor: 0, resistances: {}, evasionPct: 0, damageTakenMultiplier: 1, ...p,
});
const att = (w: EffectiveWeapon, p: Partial<Parameters<typeof resolveHit>[0]> = {}) => ({ weapon: w, pveDamagePct: 0, pvpDamagePct: 0, damageMultiplier: 1, pvp: false, distance: 10, ...p });

describe("damage pipeline", () => {
  it("out of range misses", () => {
    const r = resolveHit(att(weapon(), { distance: 41 }), target(), () => 0);
    expect(r).toMatchObject({ hit: false, miss: "OUT_OF_RANGE" });
  });

  it("accuracy vs evasion", () => {
    const r = resolveHit(att(weapon({ accuracy: 0.5 })), target(), () => 0.6);
    expect(r.miss).toBe("EVADED");
    const r2 = resolveHit(att(weapon({ accuracy: 0.9 })), target({ evasionPct: 50 }), () => 0.5);
    expect(r2.miss).toBe("EVADED");
  });

  it("shield absorbs first, overflow goes to hull", () => {
    const r = resolveHit(att(weapon({ damage: 300 })), target({ shield: 100 }), () => 0.99);
    expect(r.shieldDamage).toBe(100);
    expect(r.hullDamage).toBe(200);
    expect(r.shieldAfter).toBe(0);
    expect(r.hullAfter).toBe(800);
  });

  it("shieldDamage / hullDamage multipliers", () => {
    const r = resolveHit(att(weapon({ damage: 100, shieldDamage: 2 })), target({ shield: 1000 }), () => 0.99);
    expect(r.shieldDamage).toBe(200);
    const h = resolveHit(att(weapon({ damage: 100, hullDamage: 0.5 })), target(), () => 0.99);
    expect(h.hullDamage).toBe(50);
  });

  it("armor mitigates, penetration ignores armor", () => {
    const noPen = resolveHit(att(weapon({ damage: 100 })), target({ armor: 250 }), () => 0.99);
    expect(noPen.hullDamage).toBe(50);
    expect(noPen.armorDamage).toBe(50);
    const pen = resolveHit(att(weapon({ damage: 100, armorPenetration: 1 })), target({ armor: 250 }), () => 0.99);
    expect(pen.hullDamage).toBe(100);
    expect(armorReduction(0, 0)).toBe(0);
  });

  it("crit multiplies damage", () => {
    let i = 0;
    const seq = [0, 0];
    const r = resolveHit(att(weapon({ critChance: 0.5, critDamage: 2 })), target(), () => seq[i++] ?? 0);
    expect(r.crit).toBe(true);
    expect(r.hullDamage).toBe(200);
  });

  it("element resistances and weaknesses", () => {
    const resisted = resolveHit(att(weapon({ element: "EM" })), target({ resistances: { EM: 0.5 } }), () => 0.99);
    expect(resisted.hullDamage).toBe(50);
    const weak = resolveHit(att(weapon({ element: "KINETIC" })), target({ resistances: { KINETIC: -0.1 } }), () => 0.99);
    expect(weak.hullDamage).toBe(110);
  });

  it("pvp vs pve modifiers, buffs, damage reduction, weak points", () => {
    const pvp = resolveHit(att(weapon(), { pvp: true, pvpDamagePct: 10, pveDamagePct: 50 }), target(), () => 0.99);
    expect(pvp.hullDamage).toBe(110);
    const pve = resolveHit(att(weapon(), { pvp: false, pvpDamagePct: 10, pveDamagePct: 50, damageMultiplier: 2 }), target({ damageTakenMultiplier: 0.5, weakPointMultiplier: 3 }), () => 0.99);
    expect(pve.hullDamage).toBe(450);
    expect(pve.weakPoint).toBe(true);
  });

  it("kills when hull reaches zero and never overkills", () => {
    const r = resolveHit(att(weapon({ damage: 5000 })), target({ hull: 100 }), () => 0.99);
    expect(r.killed).toBe(true);
    expect(r.hullDamage).toBe(100);
    expect(r.hullAfter).toBe(0);
  });

  it("invulnerable targets take nothing", () => {
    expect(resolveHit(att(weapon()), target({ invulnerable: true }), () => 0).miss).toBe("INVULNERABLE");
  });

  it("damage hack: computed damage never exceeds the theoretical max", () => {
    const rng = mulberry32(42);
    const w = weapon({ critChance: 0.5, critDamage: 2.5, shieldDamage: 1.3 });
    const a = att(w, { pveDamagePct: 20, damageMultiplier: 1.25 });
    const max = maxShotDamage(a, 3);
    for (let i = 0; i < 2000; i++) {
      const r = resolveHit(a, target({ shield: 500, hull: 1e9, resistances: { THERMAL: -0.75 }, weakPointMultiplier: 3 }), rng);
      expect(isDamageImpossible(r.shieldDamage + r.hullDamage + r.armorDamage, max)).toBe(false);
    }
    expect(isDamageImpossible(max * 2, max)).toBe(true);
  });

  it("area damage bypasses accuracy", () => {
    const r = resolveAreaDamage(500, "VOID", target({ shield: 200 }));
    expect(r.hit).toBe(true);
    expect(r.shieldDamage + r.hullDamage).toBe(500);
  });
});

describe("weapon gating", () => {
  it("enforces fire rate, energy and heat", () => {
    const w = weapon({ fireRate: 2, energyCost: 10, heat: 40 });
    let rt = { readyAt: 0 };
    let heat = { heat: 0, overheated: false };
    let energy = 25;
    const a = tryFire(w, rt, heat, energy, 100, 0);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    rt = a.rt; heat = a.heat; energy = a.energy;
    expect(tryFire(w, rt, heat, energy, 100, 100)).toMatchObject({ ok: false, reason: "COOLDOWN" });
    const b = tryFire(w, rt, heat, energy, 100, 500);
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(tryFire(w, b.rt, b.heat, b.energy, 100, 1000)).toMatchObject({ ok: false, reason: "ENERGY" });
    const c = tryFire(w, b.rt, b.heat, 100, 100, 1000);
    expect(c.ok && c.heat.overheated).toBe(true);
    if (!c.ok) return;
    expect(tryFire(w, c.rt, c.heat, 100, 100, 2000)).toMatchObject({ ok: false, reason: "OVERHEAT" });
    const cooled = coolHeat(c.heat, 100, 10);
    expect(cooled.overheated).toBe(false);
  });

  it("missiles require ammo", () => {
    expect(tryFire(weapon({ ammo: "item_ammo_hornet" }), { readyAt: 0 }, { heat: 0, overheated: false }, 100, 100, 0, false)).toMatchObject({ ok: false, reason: "NO_AMMO" });
  });
});

describe("EMP, regen, weak point", () => {
  it("EMP strips shield, stuns and disrupts regen", () => {
    const e = applyEmp(1000, 2000, 20, 1500, 10_000);
    expect(e.shieldDamage).toBe(400);
    expect(e.stunnedUntil).toBe(11_500);
    const v = regenerate({ hull: 1, shield: 600, energy: 0, maxHull: 1, maxShield: 2000, maxEnergy: 100, lastDamagedAt: 0, shieldDisruptedUntil: e.shieldDisruptedUntil }, 100, 10, 1, 11_000);
    expect(v.shield).toBe(600);
    expect(v.energy).toBe(10);
    const later = regenerate({ ...v, shieldDisruptedUntil: 0 }, 100, 10, 1, 20_000);
    expect(later.shield).toBe(700);
  });

  it("weak point = rear arc", () => {
    expect(isWeakPointHit(0, 0, 0, -10, 0)).toBe(true);
    expect(isWeakPointHit(0, 0, 0, 10, 0)).toBe(false);
  });
});

describe("effective stats", () => {
  const faction = FACTIONS_BY_ID.get("aurora");
  const ship = SHIPS_BY_ID.get("ship_aurora_lumen");
  const baseInput = (): LoadoutInput => ({
    ship: ship!,
    shipUpgradeLevel: 0,
    lasers: faction!.starterLoadout.weapons.map((id) => WEAPONS_BY_ID.get(id)!).filter((w) => w.slot === "LASER").map((def) => ({ def })),
    missiles: faction!.starterLoadout.weapons.map((id) => WEAPONS_BY_ID.get(id)!).filter((w) => w.slot === "MISSILE").map((def) => ({ def })),
    generators: faction!.starterLoadout.modules.map((id) => MODULES_BY_ID.get(id)!).filter((m) => m.slot === "GENERATOR").map((def) => ({ def })),
    modules: faction!.starterLoadout.modules.map((id) => MODULES_BY_ID.get(id)!).filter((m) => m.slot === "MODULE").map((def) => ({ def })),
    drones: faction!.starterLoadout.drones.map((id) => ({ def: DRONES_BY_ID.get(id)!, level: 1 })),
    factionBonus: faction!.bonus,
    progression: PROGRESSION,
  });

  it("combines ship, generators, faction bonus and passives", () => {
    const s = computeStats(baseInput());
    const shieldGen = MODULES_BY_ID.get("gen_shield_s1")!.passive.shield ?? 0;
    expect(s.shield).toBeCloseTo(ship!.stats.shield + shieldGen, 5);
    expect(s.speed).toBeGreaterThan(ship!.stats.speed);
    expect(s.weapons.filter((w) => w.group === "PRIMARY" && w.type === "LASER").length).toBe(2);
    expect(s.weapons.some((w) => w.type === "DRONE_WEAPON")).toBe(true);
    expect(s.gearScore).toBeGreaterThan(0);
    expect(s.skills.length).toBeGreaterThan(0);
    expect(s.moduleActives.length).toBe(1);
  });

  it("upgrade level scales durability", () => {
    const a = computeStats(baseInput());
    const b = computeStats({ ...baseInput(), shipUpgradeLevel: 10 });
    expect(b.hull).toBeCloseTo(a.hull * (1 + PROGRESSION.upgrade.statPercentPerLevel * 10), 5);
  });

  it("caps stats and applies stricter PvP normalization", () => {
    const inp = baseInput();
    inp.lasers[0] = { ...inp.lasers[0]!, affixes: [{ stat: "critChance", value: 500 }, { stat: "damage", value: 900 }] };
    const pve = computeStats(inp);
    const pvp = computeStats({ ...inp, pvpNormalized: true });
    expect(pve.pct.critChance).toBe(60);
    expect(pvp.pct.critChance).toBe(35);
    expect(pvp.pct.damage).toBeLessThan(pve.pct.damage);
  });

  it("respects slot limits", () => {
    const inp = baseInput();
    const laser = inp.lasers[0]!;
    inp.lasers = [laser, laser, laser, laser, laser];
    const s = computeStats(inp);
    expect(s.weapons.filter((w) => w.key.startsWith("L")).length).toBe(ship!.slots.laser);
  });
});
