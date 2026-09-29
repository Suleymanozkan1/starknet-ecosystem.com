import { describe, expect, it } from "vitest";
import { MAPS_BY_ID } from "@nebula/config";
import { EntityFlag, type EntitySnapshot } from "@nebula/shared";
import { relationOf, type RelationContext } from "../hud/relations.js";
import type { MinimapRelation } from "../types.js";
import { RELATION_COLORS, projectToRadar, radarLayout, radarMarker, zoneColor } from "./radar.js";

type Ent = Pick<EntitySnapshot, "id" | "kind" | "faction" | "clanTag" | "flags" | "cloaked">;
const ent = (o: Partial<Ent>): Ent => ({ id: "x", kind: "PLAYER", faction: "vortex", clanTag: "", flags: 0, cloaked: false, ...o });
const ctx = (pvp = true): RelationContext => ({ selfId: "me", faction: "aurora", clanTag: "ABC", pvp, scanned: new Set() });
/** What the radar draws for an entity, or null when it is hidden (same pipeline as Game → OverlayScene). */
const radarFor = (e: Ent, c: RelationContext) => {
  const rel = relationOf(e, c);
  return rel === null ? null : { rel, ...radarMarker(rel) };
};

describe("MINIMAP-01 radar classification", () => {
  it("gives portals, stations, bosses, NPCs, resources and loot their own icon and colour", () => {
    const c = ctx();
    expect(radarFor(ent({ kind: "PORTAL" }), c)).toEqual({ rel: "portal", shape: "dot", color: 0x6ee7ff, alpha: 1, size: 2.3 });
    expect(radarFor(ent({ kind: "STATION" }), c)).toMatchObject({ rel: "station", color: 0x9fe8ff });
    expect(radarFor(ent({ kind: "BOSS" }), c)).toEqual({ rel: "boss", shape: "boss", color: 0xff2d7a, alpha: 1, size: 4.5 });
    expect(radarFor(ent({ kind: "NPC" }), c)).toEqual({ rel: "npc", shape: "dot", color: 0xff8a3d, alpha: 1, size: 1.8 });
    expect(radarFor(ent({ kind: "ASTEROID" }), c)).toEqual({ rel: "resource", shape: "square", color: 0xffd166, alpha: 0.7, size: 1 });
    expect(radarFor(ent({ kind: "LOOT" }), c)).toEqual({ rel: "loot", shape: "square", color: 0xb388ff, alpha: 0.9, size: 1.5 });
    expect(radarFor(ent({ kind: "PROJECTILE" }), c)).toBeNull();
    // The boss marker is the largest dot on the radar.
    expect(radarMarker("boss").size).toBeGreaterThan(radarMarker("hostile").size);
  });

  it("colours players by squad > clan > faction > hostile/neutral", () => {
    const c = ctx(true);
    // Squad wins over clan and faction membership.
    expect(radarFor(ent({ flags: EntityFlag.SQUAD, clanTag: "ABC", faction: "aurora" }), c)).toMatchObject({ rel: "squad", color: 0x3ef08a });
    expect(radarFor(ent({ clanTag: "ABC", faction: "aurora" }), c)).toMatchObject({ rel: "clan", color: 0x5fd4ff });
    expect(radarFor(ent({ faction: "aurora" }), c)).toMatchObject({ rel: "faction", color: 0x6ea8ff });
    expect(radarFor(ent({}), c)).toMatchObject({ rel: "hostile", color: 0xff4d4d, shape: "dot" });
    expect(radarFor(ent({}), ctx(false))).toMatchObject({ rel: "neutral", color: 0xc9c9c9 });
    // Without a clan, an empty clan tag must not match other clanless pilots.
    expect(radarFor(ent({ clanTag: "" }), { ...c, clanTag: "" })).toMatchObject({ rel: "hostile" });
    const friendly: MinimapRelation[] = ["squad", "clan", "faction"];
    for (const r of friendly) expect(RELATION_COLORS[r]).not.toBe(RELATION_COLORS.hostile);
    expect(new Set(friendly.map((r) => RELATION_COLORS[r])).size).toBe(3);
  });

  it("hides stealthed (cloaked) contacts until scanned, including bosses; self is never hidden", () => {
    const c = ctx(true);
    expect(radarFor(ent({ id: "spy", cloaked: true }), c)).toBeNull();
    expect(radarFor(ent({ id: "ghost", kind: "BOSS", cloaked: true }), c)).toBeNull();
    c.scanned.add("spy");
    expect(radarFor(ent({ id: "spy", cloaked: true }), c)).toMatchObject({ rel: "hostile" });
    expect(radarFor(ent({ id: "me", cloaked: true }), c)).toMatchObject({ rel: "self", color: 0xffffff });
  });

  it("draws objectives, events and tactical markers as rings", () => {
    for (const r of ["objective", "event", "marker"] as const) expect(radarMarker(r)).toMatchObject({ shape: "ring", size: 4, color: RELATION_COLORS[r] });
  });

  it("colours zones by type", () => {
    expect(zoneColor("SAFE")).toBe(0x38d98a);
    expect(zoneColor("PVP")).toBe(0xff4d4d);
    expect(zoneColor("HIGH_RISK")).toBe(0xff4d4d);
    expect(zoneColor("MINING")).toBe(0xffd166);
    expect(zoneColor("BOSS")).toBe(0xc77dff);
    expect(zoneColor("NEUTRAL")).toBe(0x5a7aa5);
  });
});

describe("PHASER-01 radar projection", () => {
  it("fits the map into the top-right corner, keeping the aspect ratio (compact on small screens)", () => {
    const wide = radarLayout({ width: 4000, height: 2000 }, 1280, false);
    expect(wide.scale).toBeCloseTo(210 / 4000);
    expect(wide.w).toBeCloseTo(210);
    expect(wide.h).toBeCloseTo(105);
    expect(wide.x0).toBeCloseTo(1280 - 210 - 14);
    expect(wide.y0).toBe(14);
    // Tall maps are bounded by height * 1.25.
    const tall = radarLayout({ width: 1000, height: 2000 }, 800, false);
    expect(tall.scale).toBeCloseTo(210 / 2500);
    expect(tall.w / tall.h).toBeCloseTo(0.5);
    const compact = radarLayout({ width: 4000, height: 2000 }, 400, true);
    expect(compact.w).toBeCloseTo(130);
    expect(compact.x0 + compact.w).toBeCloseTo(400 - 14);
  });

  it("projects map corners/centre onto the radar box and clips positions outside the map", () => {
    const map = MAPS_BY_ID.get("map_aurora_prime");
    if (!map) throw new Error("map missing");
    const l = radarLayout(map, 1920, false);
    const p = { x: 0, y: 0 };
    expect(projectToRadar(l, 0, 0, p)).toBe(true);
    expect(p).toEqual({ x: l.x0, y: l.y0 });
    expect(projectToRadar(l, map.width, map.height, p)).toBe(true);
    expect(p.x).toBeCloseTo(l.x0 + l.w);
    expect(p.y).toBeCloseTo(l.y0 + l.h);
    expect(projectToRadar(l, map.width / 2, map.height / 2, p)).toBe(true);
    expect(p.x).toBeCloseTo(l.x0 + l.w / 2);
    // Every portal of the map lands inside the radar.
    for (const portal of map.portals) expect(projectToRadar(l, portal.x, portal.y, p)).toBe(true);
    // Far outside the map → not drawn.
    expect(projectToRadar(l, -map.width, map.height / 2, p)).toBe(false);
    expect(projectToRadar(l, map.width / 2, map.height * 2, p)).toBe(false);
    // Just past the edge is tolerated by 2 radar pixels.
    expect(projectToRadar(l, map.width + 1 / l.scale, 0, p)).toBe(true);
    expect(projectToRadar(l, map.width + 3 / l.scale, 0, p)).toBe(false);
  });
});
