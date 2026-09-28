/** Regression tests for CodeRabbit PR #2 round 1 findings (game-core). */
import { describe, expect, it } from "vitest";
import { DRONES_BY_ID, MAPS_BY_ID, MODULES_BY_ID, PROGRESSION, SHIPS_BY_ID, WEAPONS_BY_ID } from "@nebula/config";
import { mulberry32, type LootTableDef, type MapDef } from "@nebula/shared";
import { rollLoot } from "./loot.js";
import { tryFire, type HeatState, type WeaponRuntime } from "./combat.js";
import { formMatches, type QueueTicket } from "./matchmaking.js";
import { computeStats, gearScore, type EffectiveWeapon, type LoadoutInput } from "./stats.js";
import { DEFAULT_TUNING, mergeTuning, parseTuningOverride } from "./tuning.js";
import { isPvpAllowedAt } from "./zones.js";

describe("#16 fire rate: no tick-quantization drift", () => {
  const w = { key: "L0", fireRate: 3, energyCost: 0, heat: 0 } as EffectiveWeapon; // 333.3 ms interval
  it("continuous fire at a 20 Hz tick sustains the nominal fire rate", () => {
    let rt: WeaponRuntime = { readyAt: 0 };
    let heat: HeatState = { heat: 0, overheated: false };
    let shots = 0;
    for (let t = 0; t < 10_000; t += 50) {
      const r = tryFire(w, rt, heat, 100, 0, t);
      if (r.ok) { shots++; rt = r.rt; heat = r.heat; }
    }
    expect(shots).toBeGreaterThanOrEqual(30); // 3/s × 10 s (old code: ~25)
    expect(shots).toBeLessThanOrEqual(31);
  });
  it("idle time is not banked into a burst", () => {
    const r1 = tryFire(w, { readyAt: 1000 }, { heat: 0, overheated: false }, 100, 0, 60_000);
    expect(r1.ok && r1.rt.readyAt).toBeCloseTo(60_000 + 1000 / 3, 5);
  });
});

describe("#17 matchmaking keeps parties whole", () => {
  const now = 100_000;
  const t = (id: string, o: Partial<QueueTicket> = {}): QueueTicket => ({ userId: id, rating: 1200, level: 20, gearScore: 1000, region: "EU", latencyMs: 40, partyId: null, enqueuedAt: now - 1000, ...o });
  const rules = { teamSize: 2, teams: 2, baseRatingSpread: 100, ratingSpreadPerSec: 1, maxRatingSpread: 300, maxLevelSpread: 10, maxGearSpreadRatio: 0.5, maxLatencyMs: 150 };
  it("rejects the whole party if one member exceeds the latency limit", () => {
    const r = formMatches([t("a", { partyId: "P" }), t("b", { partyId: "P", latencyMs: 400 }), t("c"), t("d"), t("e")], now, rules);
    expect(r.matches).toHaveLength(0);
    expect(r.remaining.map((x) => x.userId).sort()).toEqual(["a", "b", "c", "d", "e"]);
  });
  it("matches a mixed-region party in its leader's region without splitting it", () => {
    const r = formMatches([t("a", { partyId: "P" }), t("b", { partyId: "P", region: "NA" }), t("c"), t("d")], now, rules);
    expect(r.matches).toHaveLength(1);
    const team = r.matches[0]!.teams.find((x) => x.some((p) => p.userId === "a"))!;
    expect(team.map((p) => p.userId).sort()).toEqual(["a", "b"]);
  });
});

describe("#19 gear score uses the equipped (slot-limited) loadout", () => {
  it("extra items beyond slots do not inflate gear score", () => {
    const ship = SHIPS_BY_ID.get("ship_aurora_lumen")!;
    const laser = { def: WEAPONS_BY_ID.get("wpn_laser_seraph")! };
    const base: LoadoutInput = { ship, shipUpgradeLevel: 0, lasers: [laser, laser], missiles: [], generators: [{ def: MODULES_BY_ID.get("gen_shield_s1")! }], modules: [], drones: [{ def: DRONES_BY_ID.get("drone_striker")! }], progression: PROGRESSION };
    const stuffed: LoadoutInput = { ...base, lasers: Array(20).fill(laser), shipUpgradeLevel: 999 };
    expect(computeStats(stuffed).gearScore).toBe(computeStats({ ...base, shipUpgradeLevel: PROGRESSION.upgrade.maxLevel }).gearScore);
    expect(computeStats(stuffed).gearScore).toBeLessThan(gearScore(stuffed));
  });
});

describe("#20 tuning overrides are validated", () => {
  it("returns fresh objects and never exposes DEFAULT_TUNING for mutation", () => {
    const t = mergeTuning();
    t.caps.critChance = 999;
    t.armorK = 1;
    expect(DEFAULT_TUNING.caps.critChance).toBe(60);
    expect(DEFAULT_TUNING.armorK).toBe(250);
  });
  it("applies valid overrides, rejects invalid values and unknown keys", () => {
    expect(mergeTuning({ armorK: 300, caps: { critChance: 50 } })).toMatchObject({ armorK: 300, caps: { critChance: 50, evasion: 35 } });
    expect(parseTuningOverride({ armorK: -1 }).ok).toBe(false);
    expect(parseTuningOverride({ caps: { bogus: 1 } }).ok).toBe(false);
    expect(parseTuningOverride({ nope: true }).ok).toBe(false);
    expect(parseTuningOverride({ minHitChance: 0.9, maxHitChance: 0.5 }).ok).toBe(false);
    expect(mergeTuning({ armorK: Number.NaN })).toEqual(DEFAULT_TUNING);
    // Partial overrides are checked against the merged range (default minHitChance 0.05).
    expect(parseTuningOverride({ maxHitChance: 0 }).ok).toBe(false);
    expect(parseTuningOverride({ minHitChance: 1.0 }).ok).toBe(true); // default max 1.0
    expect(mergeTuning({ maxHitChance: 0 })).toEqual(DEFAULT_TUNING);
    expect(mergeTuning({ maxHitChance: 0.8 }).maxHitChance).toBe(0.8);
  });
});

describe("#21 PIRATE zones do not enable PvP on non-PvP maps", () => {
  const map: Pick<MapDef, "zones" | "pvp"> = { pvp: false, zones: [{ id: "z", type: "PIRATE", x: 100, y: 100, radius: 50 }] };
  it("non-PvP map pirate zone: no PvP; PvP map pirate zone: PvP", () => {
    expect(isPvpAllowedAt(map, 100, 100)).toBe(false);
    expect(isPvpAllowedAt({ ...map, pvp: true }, 100, 100)).toBe(true);
    const helios = MAPS_BY_ID.get("map_helios_frontier")!;
    const pirate = helios.zones.find((z) => z.type === "PIRATE")!;
    expect(isPvpAllowedAt(helios, pirate.x, pirate.y)).toBe(false);
  });
});

describe("#12 raid loot follows the raid reward scale", () => {
  // Guaranteed table (emptyWeight 0): a drop-weight multiplier alone could not reduce it.
  const table: LootTableDef = { id: "t_test_boss", rolls: 4, emptyWeight: 0, entries: [{ kind: "CREDITS", ref: "CREDITS", weight: 1, min: 1, max: 1 }] };
  const total = (scale: number | undefined, seed: number) =>
    rollLoot(table, mulberry32(seed), scale === undefined ? {} : { scale }).reduce((a, d) => a + d.quantity, 0);

  it("full scale is unchanged; zero or invalid scale drops nothing", () => {
    expect(total(undefined, 1)).toBe(4);
    expect(total(1, 1)).toBe(4);
    expect(total(0, 1)).toBe(0);
    expect(total(Number.NaN, 1)).toBe(0);
  });

  it("a qualifying raid below raidSize gets proportionally less loot on average", () => {
    let sum = 0;
    for (let i = 0; i < 2000; i++) sum += total(0.5, i + 1);
    expect(sum / 2000).toBeGreaterThan(1.9);
    expect(sum / 2000).toBeLessThan(2.1);
    for (let i = 0; i < 50; i++) expect(total(0.625, i + 1)).toBeLessThanOrEqual(3); // 4 × 0.625 = 2.5 → 2 or 3 rolls
  });
});
