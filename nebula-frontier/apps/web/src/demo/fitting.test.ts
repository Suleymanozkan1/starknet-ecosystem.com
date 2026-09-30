import { beforeEach, describe, expect, it } from "vitest";
import { FACTIONS, SHIPS } from "@nebula/config";
import { decodeDemoTicket, LocalWorld } from "@nebula/game-network";
import type { EntitySnapshot, MeResponse, ServerEvents } from "@nebula/shared";
import type { GameTicketResponse, ShipsResponse } from "../lib/dto.js";
import { demoRequest, resetDemoState } from "./mockApi.js";
import { state } from "./state.js";

const get = <T>(path: string) => demoRequest("GET", path, undefined, undefined) as Promise<T>;
const post = <T>(path: string, body: unknown = {}) => demoRequest("POST", path, undefined, body) as Promise<T>;

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Flies the ticket's ship in the offline simulation, holding the trigger at an NPC for `seconds`. */
function shotsFired(ticket: string, seconds: number): { total: number; lastHalf: number } {
  const pilot = decodeDemoTicket(ticket);
  const entities = new Map<string, EntitySnapshot>();
  const shots: number[] = [];
  let t = 0;
  const faction = FACTIONS.find((f) => f.id === pilot.factionId);
  const world = new LocalWorld(faction?.homeMap ?? "", pilot, null, {
    add: (e) => entities.set(e.id, e),
    remove: (id) => entities.delete(id),
    event: (type) => {
      if (type === ("player_attack" satisfies keyof ServerEvents)) shots.push(t);
    },
  }, seeded(3));
  world.start();
  const me = entities.get(world.localId) as EntitySnapshot;
  const npc = [...entities.values()].find((e) => e.kind === "NPC") as EntitySnapshot;
  world.handle("fire", { firing: true, group: "PRIMARY" });
  for (t = 0; t < seconds * 1000; t += 50) {
    me.x = npc.x - 30;
    me.y = npc.y;
    npc.dead = false;
    world.handle("aim", { x: npc.x, y: npc.y });
    world.tick(50);
  }
  return { total: shots.length, lastHalf: shots.filter((s) => s >= (seconds * 1000) / 2).length };
}

describe("demo tester kit fitting", () => {
  beforeEach(() => resetDemoState());

  it("every ship in the hangar is armed and keeps firing in the simulation", async () => {
    await post("/api/auth/register", { email: "fit@demo.local", password: "x", username: "Fit_Pilot" });
    const faction = FACTIONS[0];
    if (!faction) throw new Error("no factions");
    await post<MeResponse>("/api/me/faction", { factionId: faction.id });
    const { owned } = await get<ShipsResponse>("/api/ships");
    expect(owned).toHaveLength(SHIPS.length);
    const starter = owned.find((s) => s.defId === faction.starterShip);
    const starterWeapons = starter?.loadouts.find((l) => l.id === starter.activeLoadoutId)?.weapons.filter(Boolean) ?? [];
    expect(starterWeapons.length).toBeGreaterThan(0);
    const idle: string[] = [];
    for (const ship of owned) {
      const lo = ship.loadouts.find((l) => l.id === ship.activeLoadoutId);
      expect(lo?.weapons.some(Boolean), `${ship.defId} has no weapon`).toBe(true);
      await post("/api/ships/activate", { shipInstanceId: ship.id });
      const { ticket } = await post<GameTicketResponse>("/api/game/ticket");
      const fired = shotsFired(ticket, 12);
      // Sustained fire: still shooting in the second half (energy/heat must not lock the guns for good).
      if (fired.total === 0 || fired.lastHalf === 0) idle.push(`${ship.defId} (${fired.total}/${fired.lastHalf})`);
    }
    expect(idle).toEqual([]);
  });

  it("arms ships of pilots whose tester kit predates the fitting (one-time migration)", async () => {
    await post("/api/auth/register", { email: "old@demo.local", password: "x", username: "Old_Pilot" });
    const faction = FACTIONS[0];
    if (!faction) throw new Error("no factions");
    await post<MeResponse>("/api/me/faction", { factionId: faction.id });
    // Simulate an old save: tester kit granted, ships never fitted.
    const acc = Object.values(state().accounts)[0];
    if (!acc) throw new Error("no account");
    for (const s of acc.ships) {
      if (s.defId === faction.starterShip) continue;
      for (const l of s.loadouts) for (const k of ["weapons", "missiles", "generators", "modules", "drones"] as const) l.config[k] = l.config[k].map(() => null);
    }
    acc.testerFitted = false;
    await get<MeResponse>("/api/me");
    const { owned } = await get<ShipsResponse>("/api/ships");
    const unarmed = owned.filter((s) => !s.loadouts.some((l) => l.weapons.some(Boolean))).map((s) => s.defId);
    expect(unarmed).toEqual([]);
  });
});
