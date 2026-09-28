import { describe, expect, it } from "vitest";
import { SHIPS, NPCS } from "@nebula/config";
import { buildShipGeometry, shipGeometryKey } from "./ShipFactory.js";
import { resolveLook, npcVisual, parseCosmeticIds, resolveCosmeticPayloads } from "./cosmetics.js";
import { HULL_TYPES } from "./hulls.js";
import type { ShipVisualDef } from "@nebula/shared";

function sizeKey(v: ShipVisualDef): string {
  const set = buildShipGeometry(v, false);
  const s = set.bounds.getSize(new (set.bounds.min.constructor as new () => typeof set.bounds.min)());
  return [s.x, s.y, s.z].map((n) => n.toFixed(2)).join("x");
}

describe("ShipFactory geometry", () => {
  it("builds every ship at all LOD levels with valid geometry", () => {
    for (const ship of SHIPS) {
      const set = buildShipGeometry(ship.visual, true);
      expect(set.levels).toHaveLength(3);
      for (const lvl of set.levels) {
        expect(lvl.size).toBeGreaterThan(0);
        for (const g of lvl.values()) {
          const pos = g.attributes.position;
          expect(pos).toBeDefined();
          expect(pos?.count ?? 0).toBeGreaterThan(0);
          const arr = pos?.array as Float32Array;
          let finite = true;
          for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i])) finite = false;
          expect(finite).toBe(true);
          expect(g.attributes.uv).toBeDefined();
          expect(g.attributes.normal).toBeDefined();
        }
      }
      expect(set.sockets.nozzles.length).toBeGreaterThan(0);
      expect(set.sockets.muzzles.length).toBe(ship.visual.hardpoints.length);
      expect(set.radius).toBeGreaterThan(ship.visual.length * 0.3);
      // high LOD has more triangles than low
      const tri = (i: number): number => [...(set.levels[i]?.values() ?? [])].reduce((a, g) => a + (g.attributes.position?.count ?? 0), 0);
      expect(tri(0)).toBeGreaterThan(tri(2));
    }
  });

  it("every ship has a distinct geometry key and distinct bounding box", () => {
    const keys = new Set(SHIPS.map((s) => shipGeometryKey(s.visual)));
    expect(keys.size).toBe(SHIPS.length);
    const boxes = new Set(SHIPS.map((s) => sizeKey(s.visual)));
    expect(boxes.size).toBe(SHIPS.length);
  });

  it("every hull archetype produces a different silhouette for the same parts", () => {
    const base = SHIPS[0]?.visual;
    if (!base) throw new Error("no ships");
    const sizes = new Set(HULL_TYPES.map((hull) => sizeKey({ ...base, hull, wings: "none", hardpoints: [], nozzles: [[0, 0, -1.5]] })));
    expect(sizes.size).toBe(HULL_TYPES.length);
  });

  it("geometry cache key ignores colors but reacts to skins that change geometry", () => {
    const ship = SHIPS.find((s) => s.id === "ship_aurora_lumen");
    if (!ship) throw new Error("missing lumen");
    const recolor = { ...ship.visual, primaryColor: "#000000", accentColor: "#ff0000" };
    expect(shipGeometryKey(recolor)).toBe(shipGeometryKey(ship.visual));
    const skin = resolveCosmeticPayloads(["skin_lumen_solar_crown"]);
    expect(skin).toHaveLength(1);
    const look = resolveLook(ship.visual, skin, ship.id);
    expect(look.visual.wings).toBe("delta");
    expect(look.palette.primary).toBe("#fff3c4");
    expect(shipGeometryKey(look.visual)).not.toBe(shipGeometryKey(ship.visual));
    // skin for another ship does not apply
    const other = resolveLook(ship.visual, resolveCosmeticPayloads(["skin_ember_phoenix"]), ship.id);
    expect(shipGeometryKey(other.visual)).toBe(shipGeometryKey(ship.visual));
  });

  it("skin hardpoint overrides change muzzle sockets", () => {
    const ship = SHIPS.find((s) => s.id === "ship_riftbreaker");
    if (!ship) throw new Error("missing riftbreaker");
    const look = resolveLook(ship.visual, resolveCosmeticPayloads(["skin_riftbreaker_voidborn"]), ship.id);
    const set = buildShipGeometry(look.visual, false);
    expect(set.sockets.muzzles.length).toBe(look.visual.hardpoints.length);
    expect(look.hullEffect).toBe("void_shimmer");
  });

  it("parses cosmetic id strings", () => {
    expect(parseCosmeticIds('["a","b"]')).toEqual(["a", "b"]);
    expect(parseCosmeticIds("a, b|c")).toEqual(["a", "b", "c"]);
    expect(parseCosmeticIds("")).toEqual([]);
    expect(parseCosmeticIds("[bad")).toEqual([]);
  });

  it("builds NPC and boss visuals", () => {
    for (const npc of NPCS) {
      const v = npcVisual(npc);
      const set = buildShipGeometry(v, false);
      expect(set.radius).toBeGreaterThan(0);
    }
  });
});
