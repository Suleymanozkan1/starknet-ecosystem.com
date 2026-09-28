import { describe, expect, it } from "vitest";
import {
  BATTLE_PASSES, DRONES, FACTIONS, GATES, ITEMS, MAPS, MODULES, NPCS, SHIPS, SHIPS_BY_ID, WEAPONS, validateGameData,
} from "./index.js";

describe("game data", () => {
  it("passes referential-integrity validation", () => {
    expect(validateGameData()).toEqual([]);
  });

  it("has the minimum content counts", () => {
    expect(SHIPS.length).toBeGreaterThanOrEqual(10);
    expect(WEAPONS.length).toBeGreaterThanOrEqual(10);
    expect(MODULES.length).toBeGreaterThanOrEqual(10);
    expect(DRONES.length).toBeGreaterThanOrEqual(5);
    expect(NPCS.length).toBeGreaterThanOrEqual(10);
    expect(NPCS.filter((n) => n.kind === "BOSS").length).toBeGreaterThanOrEqual(1);
    expect(MAPS.length).toBeGreaterThanOrEqual(5);
    expect(FACTIONS).toHaveLength(3);
    expect(GATES.length).toBeGreaterThanOrEqual(1);
    expect(MAPS.filter((m) => m.pvp && m.roomType === "pvp").length).toBeGreaterThanOrEqual(1);
  });

  it("covers every ship class and gives each faction a tier-1 starter", () => {
    const classes = new Set(SHIPS.map((s) => s.class));
    for (const c of ["SCOUT", "INTERCEPTOR", "ASSAULT", "STRIKER", "DESTROYER", "BATTLECRUISER", "CARRIER", "SUPPORT", "TANK", "STEALTH", "EXPLORATION", "MINING", "ELECTRONIC_WARFARE"]) {
      expect(classes.has(c as never), c).toBe(true);
    }
    for (const f of FACTIONS) expect(SHIPS_BY_ID.get(f.starterShip)?.tier).toBe(1);
  });

  it("has a four-phase world boss and 50-tier battle passes", () => {
    const colossus = NPCS.find((n) => n.id === "boss_vanta_colossus");
    expect(colossus?.phases?.map((p) => p.layer)).toEqual(["SHIELD", "ARMOR", "REACTOR", "ENRAGE"]);
    for (const bp of BATTLE_PASSES) expect(bp.tiers).toHaveLength(50);
    expect(ITEMS.filter((i) => i.cosmeticPayload?.geometry).length).toBeGreaterThanOrEqual(3);
  });
});
