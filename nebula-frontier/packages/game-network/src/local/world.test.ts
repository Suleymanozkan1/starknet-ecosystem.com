import { describe, expect, it } from "vitest";
import type { EntitySnapshot, ServerEvents } from "@nebula/shared";
import { FACTIONS, MAPS_BY_ID } from "@nebula/config";
import { LocalWorld, type LocalPilot } from "./world.js";
import { decodeDemoTicket, encodeDemoTicket, LocalConnection } from "./connection.js";

type Evt = { type: keyof ServerEvents; payload: unknown };

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function setup(mapId?: string) {
  const faction = FACTIONS[0];
  if (!faction) throw new Error("no factions");
  const pilot: LocalPilot = { userId: "u1", name: "Tester", factionId: faction.id, shipId: faction.starterShip, xp: 0 };
  const entities = new Map<string, EntitySnapshot>();
  const events: Evt[] = [];
  const world = new LocalWorld(mapId ?? faction.homeMap, pilot, null, {
    add: (e) => entities.set(e.id, e),
    remove: (id) => entities.delete(id),
    event: (type, payload) => events.push({ type, payload }),
  }, seeded(7));
  const self = world.start();
  return { world, entities, events, self, faction };
}

describe("LocalWorld (demo simulation)", () => {
  it("spawns the pilot, NPCs and asteroids and returns prediction parameters", () => {
    const { world, entities, self } = setup();
    const me = entities.get(world.localId);
    expect(me?.kind).toBe("PLAYER");
    expect(me?.maxHull).toBeGreaterThan(0);
    expect(self.tickRate).toBeGreaterThan(0);
    expect(self.motion.speed).toBeGreaterThan(0);
    expect(self.weapons.length).toBeGreaterThan(0);
    expect([...entities.values()].some((e) => e.kind === "NPC")).toBe(true);
  });

  it("moves the ship from queued inputs and acknowledges the sequence", () => {
    const { world, entities } = setup();
    const me = entities.get(world.localId) as EntitySnapshot;
    const x0 = me.x;
    for (let seq = 1; seq <= 20; seq++) {
      world.handle("input", { seq, thrust: 1, strafe: 0, heading: 0, boost: false, moveTo: null });
      world.tick(50);
    }
    expect(me.x).toBeGreaterThan(x0);
    expect(me.lastSeq).toBe(20);
  });

  it("destroys a targeted NPC and grants XP/credits through reward events", () => {
    const { world, entities, events } = setup();
    const me = entities.get(world.localId) as EntitySnapshot;
    const npc = [...entities.values()].find((e) => e.kind === "NPC") as EntitySnapshot;
    // Park the pilot next to the NPC outside the safe zone and keep firing.
    let seq = 0;
    for (let i = 0; i < 20 * 120 && !npc.dead; i++) {
      me.x = npc.x - 10;
      me.y = npc.y;
      world.handle("input", { seq: ++seq, thrust: 0, strafe: 0, heading: 0, boost: false, moveTo: null });
      world.handle("target", { mode: "ENTITY", entityId: npc.id });
      world.handle("fire", { firing: true, group: "PRIMARY" });
      world.tick(50);
    }
    expect(npc.dead).toBe(true);
    expect(events.some((e) => e.type === "player_attack")).toBe(true);
    const reward = events.find((e) => e.type === "reward")?.payload as ServerEvents["reward"] | undefined;
    expect(reward?.xp).toBeGreaterThan(0);
  });

  it("jumps through a portal to its target map", () => {
    const { world, entities, events, faction } = setup();
    const map = MAPS_BY_ID.get(faction.homeMap);
    const portal = map?.portals[0];
    if (!portal) throw new Error("home map has no portal");
    const me = entities.get(world.localId) as EntitySnapshot;
    me.x = portal.x;
    me.y = portal.y;
    world.handle("jump", { portalId: portal.id });
    const jump = events.find((e) => e.type === "jump")?.payload as ServerEvents["jump"] | undefined;
    expect(jump?.mapId).toBe(portal.targetMap);
  });
});

describe("demo tickets", () => {
  it("round-trips a pilot and falls back on garbage", () => {
    const p: LocalPilot = { userId: "u9", name: "Çağrı İşaret", factionId: "nova", shipId: "ship_nova_ember", xp: 1234 };
    expect(decodeDemoTicket(encodeDemoTicket(p))).toEqual(p);
    expect(decodeDemoTicket("demo.%%%").userId).toBe("demo-pilot");
    expect(decodeDemoTicket("jwt.token.value").userId).toBe("demo-pilot");
  });
});

describe("LocalConnection", () => {
  it("joins, emits the self info and simulates until left", async () => {
    const faction = FACTIONS[0];
    if (!faction) throw new Error("no factions");
    const c = new LocalConnection();
    const selfs: ServerEvents["player_join"][] = [];
    c.on("player_join", (m) => selfs.push(m));
    await c.join("sector", { ticket: encodeDemoTicket({ userId: "u1", name: "T", factionId: faction.id, shipId: faction.starterShip, xp: 0 }), mapId: faction.homeMap });
    expect(c.connected).toBe(true);
    expect(c.entities.get(c.sessionId)?.kind).toBe("PLAYER");
    await new Promise((r) => setTimeout(r, 120));
    expect(selfs[0]?.self?.mapId).toBe(faction.homeMap);
    expect((c.state?.tick ?? 0)).toBeGreaterThan(0);
    await c.leave();
    expect(c.connected).toBe(false);
    expect(c.entities.size).toBe(0);
    c.dispose();
  });
});
