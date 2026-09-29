import { describe, expect, it } from "vitest";
import { MAPS_BY_ID } from "@nebula/config";
import { EntityFlag } from "@nebula/shared";
import { computeZone, relationOf, type RelationContext } from "./relations.js";
import { intentToMoveInput } from "../input/InputManager.js";

const ctx = (pvp = false): RelationContext => ({ selfId: "me", faction: "aurora", clanTag: "ABC", pvp, scanned: new Set() });
const ent = (o: Partial<{ id: string; kind: "PLAYER" | "NPC" | "BOSS" | "ASTEROID"; faction: string; clanTag: string; flags: number; cloaked: boolean }>) => ({
  id: "x", kind: "PLAYER" as const, faction: "vortex", clanTag: "", flags: 0, cloaked: false, ...o,
});

describe("relations", () => {
  it("classifies players by squad/clan/faction/pvp", () => {
    expect(relationOf(ent({ id: "me" }), ctx())).toBe("self");
    expect(relationOf(ent({ flags: EntityFlag.SQUAD }), ctx())).toBe("squad");
    expect(relationOf(ent({ clanTag: "ABC" }), ctx())).toBe("clan");
    expect(relationOf(ent({ faction: "aurora" }), ctx())).toBe("faction");
    expect(relationOf(ent({}), ctx(false))).toBe("neutral");
    expect(relationOf(ent({}), ctx(true))).toBe("hostile");
    expect(relationOf(ent({ kind: "BOSS" }), ctx())).toBe("boss");
    expect(relationOf(ent({ kind: "ASTEROID" }), ctx())).toBe("resource");
  });

  it("hides cloaked entities unless scanned", () => {
    const c = ctx(true);
    expect(relationOf(ent({ id: "spy", cloaked: true }), c)).toBeNull();
    c.scanned.add("spy");
    expect(relationOf(ent({ id: "spy", cloaked: true }), c)).toBe("hostile");
  });

  it("computes the zone at a position", () => {
    const map = MAPS_BY_ID.get("map_aurora_prime");
    if (!map) throw new Error("map missing");
    const safe = map.zones.find((z) => z.type === "SAFE");
    if (!safe) throw new Error("no safe zone");
    expect(computeZone(map, safe.x, safe.y)).toBe("SAFE");
    expect(computeZone({ zones: [], pvp: true }, 0, 0)).toBe("PVP");
    expect(computeZone({ zones: [], pvp: false }, 0, 0)).toBe("NEUTRAL");
  });
});

describe("movement intent → thrust/strafe", () => {
  const out = { thrust: 0, strafe: 0, heading: 0, boost: false, moveTo: null };
  it("screen-relative WASD thrusts along heading when aligned", () => {
    intentToMoveInput({ mx: 1, my: 0, aim: Number.NaN, boost: false }, 0, out);
    expect(out.thrust).toBeCloseTo(1);
    expect(out.strafe).toBeCloseTo(0);
    expect(out.heading).toBeCloseTo(0);
  });
  it("twin-stick: moving sideways while aiming forward strafes", () => {
    intentToMoveInput({ mx: 0, my: 1, aim: 0, boost: true }, 0, out);
    expect(out.thrust).toBeCloseTo(0);
    expect(out.strafe).toBeCloseTo(1);
    expect(out.heading).toBe(0);
    expect(out.boost).toBe(true);
  });
  it("no movement keeps position but still faces the aim", () => {
    intentToMoveInput({ mx: 0, my: 0, aim: 1.2, boost: false }, 0, out);
    expect(out.thrust).toBe(0);
    expect(out.strafe).toBe(0);
    expect(out.heading).toBe(1.2);
  });
});
