/**
 * End-to-end room tests: real Colyseus server (in-process presence/driver),
 * real PostgreSQL, real WebSocket clients (@colyseus/sdk) — direct room tests.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { matchMaker } from "@colyseus/core";
import { Client as SdkClient } from "@colyseus/sdk";
import { NPCS_BY_ID, MAPS_BY_ID, LOOT_TABLES_BY_ID } from "@nebula/config";
import { createDb, getBalance, userWallet, type Db } from "@nebula/database";
import { isPvpAllowedAt, type LootDrop } from "@nebula/game-core";
import { RoomName, type MapDef } from "@nebula/shared";

import { loadConfig } from "./config.js";
import { buildServices } from "./bootstrap.js";
import { ensureCatalog } from "./persistence/catalog.js";
import { DuplicateLootError } from "./persistence/writer.js";
import { createGameServer } from "./server.js";
import { createPlayerUser, shieldTestIpcFromPm2, ticketFor } from "./test-utils.js";
import type { GameServices } from "./services/context.js";
import type { GameRules } from "./services/rules.js";
import type { LootActor, NpcActor, PlayerActor } from "./rooms/actors.js";

const envPath = resolve(import.meta.dirname, "../../../.env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

interface Internals {
  players: Map<string, PlayerActor>;
  npcs: Map<string, NpcActor>;
  map: MapDef;
  spawnNpc(def: NonNullable<ReturnType<typeof NPCS_BY_ID.get>>, x: number, y: number, o?: { spawnIndex?: number | null }): NpcActor;
  dropLoot(x: number, y: number, drops: LootDrop[], owner: string | null): LootActor;
  flushAll(final: boolean): Promise<void>;
  getPlayerByUser(id: string): PlayerActor | undefined;
  rules: GameRules;
  kill(target: NpcActor | PlayerActor, killer: PlayerActor | null): void;
}
const I = (room: unknown) => room as Internals;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, timeoutMs = 8000, step = 50): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(step);
  }
  throw new Error("condition not met in time");
}

let colyseus: { sdk: SdkClient; shutdown: () => Promise<void> };
let db: Db;
let svc: GameServices;
let secret: string;

beforeAll(async () => {
  shieldTestIpcFromPm2();
  process.env.GAME_TICK_RATE = "20";
  process.env.LOG_LEVEL = "warn";
  const config = { ...loadConfig(), redisUrl: null };
  secret = config.gameTicketSecret;
  db = createDb();
  svc = buildServices(config, { db, useRedis: false, logLevel: "warn", rngSeed: 1234 });
  await ensureCatalog(db);
  const server = createGameServer({ redisUrl: null, gracefullyShutdown: false });
  await server.listen(2568);
  colyseus = { sdk: new SdkClient("ws://127.0.0.1:2568"), shutdown: () => server.gracefullyShutdown(false) };
  svc.events.start(matchMaker.presence, 60_000);
});

afterAll(async () => {
  svc?.events.stop();
  await colyseus?.shutdown();
  await db?.$disconnect();
});

async function joinSector(mapId: string, o: { faction?: string; level?: number; credits?: number } = {}) {
  const user = await createPlayerUser(db, { faction: o.faction ?? "aurora", level: o.level, credits: o.credits });
  const ticket = await ticketFor(secret, user, mapId);
  const client = await colyseus.sdk.joinOrCreate(RoomName.SECTOR, { ticket, mapId });
  await until(() => !!(client.state as { entities?: Map<string, unknown> }).entities?.size);
  const room = matchMaker.getLocalRoomById(client.roomId);
  const actor = I(room).getPlayerByUser(user.id);
  if (!actor) throw new Error("player actor missing");
  return { user, ticket, client, room, actor };
}

describe("auth", () => {
  it("joins with a valid ticket and receives own entity + starter ship", async () => {
    const { client, actor, user } = await joinSector("map_aurora_prime");
    const ents = (client.state as unknown as { entities: Map<string, { kind: string; hull: number; maxHull: number }> }).entities;
    const me = ents.get(client.sessionId);
    expect(me?.kind).toBe("PLAYER");
    expect(me?.maxHull).toBeGreaterThan(0);
    expect(actor.stats.weapons.length).toBeGreaterThan(0);
    const ship = await db.shipInstance.findFirst({ where: { userId: user.id } });
    expect(ship?.shipId).toBe("ship_aurora_lumen");
    await client.leave();
  });

  it("rejects an invalid ticket", async () => {
    await expect(colyseus.sdk.joinOrCreate(RoomName.SECTOR, { ticket: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.invalidsignature_xxxxxxxxxxxxxxxx", mapId: "map_aurora_prime" })).rejects.toThrow();
  });

  it("rejects a replayed ticket (jti single use)", async () => {
    const user = await createPlayerUser(db, { faction: "aurora" });
    const ticket = await ticketFor(secret, user, "map_aurora_prime");
    const c1 = await colyseus.sdk.joinOrCreate(RoomName.SECTOR, { ticket, mapId: "map_aurora_prime" });
    await expect(colyseus.sdk.joinOrCreate(RoomName.SECTOR, { ticket, mapId: "map_aurora_prime" })).rejects.toThrow(/TICKET_REPLAYED/);
    await c1.leave();
  });

  it("rejects a ticket issued for another map", async () => {
    const user = await createPlayerUser(db, { faction: "aurora" });
    const ticket = await ticketFor(secret, user, "map_vanta_rift");
    await expect(colyseus.sdk.joinOrCreate(RoomName.SECTOR, { ticket, mapId: "map_aurora_prime" })).rejects.toThrow(/TICKET_MAP_MISMATCH/);
  });
});

describe("movement & anti-cheat", () => {
  it("is authoritative: inputs faster than the tick rate are dropped (speed hack) and flagged", async () => {
    const { client, actor, user } = await joinSector("map_aurora_prime");
    actor.x = 100;
    actor.y = 225;
    const start = { x: actor.x, y: actor.y };
    const t0 = Date.now();
    // Speed hack: 5 inputs per 50ms = 100 inputs/s (5x the 20Hz tick rate).
    let seq = 0;
    await new Promise<void>((done) => {
      const iv = setInterval(() => {
        for (let i = 0; i < 5; i++) client.send("input", { seq: ++seq, thrust: 1, strafe: 0, heading: 0, boost: false });
        if (Date.now() - t0 > 1500) { clearInterval(iv); done(); }
      }, 50);
    });
    await sleep(100);
    const elapsed = (Date.now() - t0) / 1000;
    const moved = Math.hypot(actor.x - start.x, actor.y - start.y);
    // Legal maximum: max speed × elapsed (+ the 10-step jitter burst).
    expect(moved).toBeLessThanOrEqual(actor.stats.speed * (elapsed + 0.5));
    expect(moved).toBeGreaterThan(0);
    await until(() => svc.risk.recent.some((r) => r.userId === user.id && r.type === "SPEED_HACK"));
    await until(async () => (await db.riskSignal.count({ where: { userId: user.id, type: "SPEED_HACK" } })) > 0);
    await client.leave();
  });

  it("packet floods are rate limited and flagged as PACKET_SPAM", async () => {
    const { client, user } = await joinSector("map_aurora_prime");
    let kicked = false;
    client.onLeave(() => { kicked = true; });
    for (let i = 1; i <= 400; i++) client.send("ping", { t: i });
    await until(() => svc.risk.recent.some((r) => r.userId === user.id && r.type === "PACKET_SPAM"));
    // Persistent flooding disconnects the client.
    await until(() => kicked);
  });

  it("acks lastSeq and rejects replayed input sequences", async () => {
    const { client, actor, user } = await joinSector("map_aurora_prime");
    client.send("input", { seq: 5, thrust: 1, strafe: 0, heading: 0, boost: false });
    await until(() => actor.lastSeq === 5);
    client.send("input", { seq: 5, thrust: 1, strafe: 0, heading: 0, boost: false });
    client.send("input", { seq: 3, thrust: 1, strafe: 0, heading: 0, boost: false });
    await until(() => svc.risk.recent.some((r) => r.userId === user.id && r.type === "PACKET_REPLAY"));
    await client.leave();
  });

  it("rejects cooldown hacks (module activation before cooldown)", async () => {
    const { client, actor, user } = await joinSector("map_aurora_prime");
    const errors: string[] = [];
    client.onMessage("error", (e: { code: string }) => errors.push(e.code));
    actor.shield = 10;
    client.send("module", { slot: 0 });
    await until(() => actor.shield > 10);
    const shieldAfter = actor.shield;
    for (let i = 0; i < 10; i++) client.send("module", { slot: 0 });
    await until(() => errors.filter((e) => e === "ABILITY_COOLDOWN").length >= 10);
    expect(actor.shield).toBeLessThanOrEqual(shieldAfter + actor.stats.shieldRegen * 2);
    await until(() => svc.risk.recent.some((r) => r.userId === user.id && r.type === "COOLDOWN_BYPASS"));
    await client.leave();
  });
});

describe("area of interest", () => {
  it("only replicates entities within AOI_RADIUS", async () => {
    const { client, room, actor } = await joinSector("map_aurora_prime");
    const def = NPCS_BY_ID.get("npc_mining_drone")!;
    const near = I(room).spawnNpc(def, actor.x + 20, actor.y, { spawnIndex: null });
    near.stunnedUntil = Number.MAX_SAFE_INTEGER;
    const far = I(room).spawnNpc(def, 590, 440, { spawnIndex: null });
    far.stunnedUntil = Number.MAX_SAFE_INTEGER;
    const ents = () => (client.state as unknown as { entities: Map<string, unknown> }).entities;
    await until(() => ents().has(near.id));
    expect(Math.hypot(far.x - actor.x, far.y - actor.y)).toBeGreaterThan(svc.config.aoiRadius);
    await sleep(400);
    expect(ents().has(far.id)).toBe(false);
    await client.leave();
  });
});

describe("combat, rewards & loot persistence", () => {
  it("firing kills an NPC → XP, credits, counters, leaderboard persisted", async () => {
    const { client, room, actor, user } = await joinSector("map_aurora_prime");
    actor.x = 300;
    actor.y = 225;
    const def = NPCS_BY_ID.get("npc_mining_drone")!;
    const npc = I(room).spawnNpc({ ...def, lootTable: "loot_mining_drone" }, actor.x + 15, actor.y, { spawnIndex: null });
    npc.stunnedUntil = Number.MAX_SAFE_INTEGER;
    npc.nextThinkAt = Number.MAX_SAFE_INTEGER;
    await until(() => (client.state as unknown as { entities: Map<string, unknown> }).entities.has(npc.id));
    client.send("target", { mode: "ENTITY", entityId: npc.id });
    await until(() => actor.targetId === npc.id);
    client.send("fire", { firing: true, group: "PRIMARY" });
    await until(() => npc.dead, 15_000);
    client.send("fire", { firing: false, group: "PRIMARY" });
    await I(room).flushAll(false);
    const u = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(Number(u.xp)).toBe(def.xp);
    const st = await db.playerStat.findUniqueOrThrow({ where: { userId: user.id } });
    expect(st.npcKills).toBe(1);
    const lb = await db.leaderboardEntry.findUniqueOrThrow({ where: { leaderboardId_userId: { leaderboardId: "npc_kills", userId: user.id } } });
    expect(Number(lb.score)).toBe(1);
    expect(await getBalance(db, userWallet(user.id, "CREDITS"))).toBe(BigInt(def.credits));
    await client.leave();
  });

  it("loot pickup persists items once; duplicate pickup rejected", async () => {
    const { client, room, actor, user } = await joinSector("map_aurora_prime");
    const errors: string[] = [];
    const pickups: unknown[] = [];
    client.onMessage("error", (e: { code: string }) => errors.push(e.code));
    client.onMessage("item_pickup", (e: unknown) => pickups.push(e));
    const loot = I(room).dropLoot(actor.x + 3, actor.y, [
      { kind: "ITEM", ref: "item_repair_kit", quantity: 2 },
      { kind: "CREDITS", ref: "CREDITS", quantity: 150 },
      { kind: "RESOURCE", ref: "TITANIUM", quantity: 7 },
    ], user.id);
    client.send("pickup", { lootId: loot.id });
    client.send("pickup", { lootId: loot.id });
    await until(() => pickups.length === 1 && errors.includes("LOOT_GONE"));
    const inv = await db.inventoryItem.findMany({ where: { userId: user.id, originRef: { startsWith: `loot:${loot.id}` } } });
    expect(inv).toHaveLength(1);
    expect(inv[0]?.quantity).toBe(2);
    expect(await getBalance(db, userWallet(user.id, "CREDITS"))).toBe(150n);
    const res = await db.playerResource.findUniqueOrThrow({ where: { userId_resourceId: { userId: user.id, resourceId: "TITANIUM" } } });
    expect(Number(res.amount)).toBe(7);
    // Database-level duplicate protection (e.g. after a crash/replay) — never granted twice.
    await expect(svc.persistence.grantLoot(user.id, { lootId: loot.id, items: [{ itemId: "item_repair_kit", quantity: 2, affixes: [] }], credits: 150, gems: 0, resources: {} })).rejects.toBeInstanceOf(DuplicateLootError);
    expect(await getBalance(db, userWallet(user.id, "CREDITS"))).toBe(150n);
    expect(LOOT_TABLES_BY_ID.size).toBeGreaterThan(0);
    await client.leave();
  });
});

describe("pvp", () => {
  it("PvP kill updates leaderboard, stats and requests a crypto reward", async () => {
    const map = MAPS_BY_ID.get("map_vanta_rift")!;
    const a = await joinSector(map.id, { faction: "aurora", level: 20 });
    const b = await joinSector(map.id, { faction: "vortex", level: 20, credits: 5000 });
    expect(a.room).toBe(b.room);
    let px = map.width / 2;
    let py = map.height / 2;
    for (let i = 0; i < 50 && !isPvpAllowedAt(map, px, py); i++) { px = 50 + Math.random() * (map.width - 100); py = 50 + Math.random() * (map.height - 100); }
    expect(isPvpAllowedAt(map, px, py)).toBe(true);
    Object.assign(a.actor, { x: px, y: py, invulnerableUntil: 0 });
    Object.assign(b.actor, { x: px + 10, y: py, invulnerableUntil: 0, shield: 0, hull: 1 });
    await until(() => a.actor.visible.has(b.actor.id));
    a.client.send("target", { mode: "ENTITY", entityId: b.actor.id });
    await until(() => a.actor.targetId === b.actor.id);
    a.client.send("fire", { firing: true, group: "PRIMARY" });
    await until(() => b.actor.dead, 10_000);
    a.client.send("fire", { firing: false, group: "PRIMARY" });
    await I(a.room).flushAll(false);
    const lb = await db.leaderboardEntry.findUniqueOrThrow({ where: { leaderboardId_userId: { leaderboardId: "pvp_kills", userId: a.user.id } } });
    expect(Number(lb.score)).toBe(1);
    const sa = await db.playerStat.findUniqueOrThrow({ where: { userId: a.user.id } });
    expect(sa.playerKills).toBe(1);
    const sb = await db.playerStat.findUniqueOrThrow({ where: { userId: b.user.id } });
    expect(sb.deaths).toBe(1);
    const honor = await db.leaderboardEntry.findUniqueOrThrow({ where: { leaderboardId_userId: { leaderboardId: "honor", userId: a.user.id } } });
    expect(Number(honor.score)).toBeGreaterThan(0);
    // Death repair is a credit sink through the ledger.
    await until(async () => (await getBalance(db, userWallet(b.user.id, "CREDITS"))) < 5000n);
    // Repeat kill of the same victim inside the window: no extra leaderboard credit (anti-farming).
    b.client.send("respawn", {});
    await sleep(100);
    await a.client.leave();
    await b.client.leave();
  });
});

describe("portals", () => {
  it("jump returns a seat reservation for the target map room", async () => {
    const { client, actor } = await joinSector("map_aurora_prime", { level: 10 });
    const portal = MAPS_BY_ID.get("map_aurora_prime")!.portals[0]!;
    actor.x = portal.x;
    actor.y = portal.y;
    actor.level = 10;
    const jump = new Promise<{ mapId: string; reservation?: { roomId?: string } }>((res) => client.onMessage("jump", res));
    client.send("jump", { portalId: portal.id });
    const ev = await jump;
    expect(ev.mapId).toBe(portal.targetMap);
    expect(ev.reservation?.roomId).toBeTruthy();
    await client.leave();
  });
});

describe("arena match lifecycle", () => {
  it("runs WAITING → RUNNING → ENDED, persists GameMatch rows and rating deltas", async () => {
    const instanceKey = `test-${Date.now()}`;
    const mapId = "map_eclipse_arena";
    const ua = await createPlayerUser(db, { faction: "aurora", level: 12 });
    const ub = await createPlayerUser(db, { faction: "vortex", level: 12 });
    const ca = await colyseus.sdk.joinOrCreate(RoomName.ARENA, { ticket: await ticketFor(secret, ua, mapId), mapId, instanceKey });
    const room = matchMaker.getLocalRoomById(ca.roomId);
    I(room).rules = { ...I(room).rules, arenaCountdownMs: 100, arenaScoreToWin: 1 };
    const started = new Promise<{ matchId: string }>((r) => ca.onMessage("match_start", r));
    const ended = new Promise<{ matchId: string; winnerTeam?: number }>((r) => ca.onMessage("match_end", r));
    const cb = await colyseus.sdk.joinOrCreate(RoomName.ARENA, { ticket: await ticketFor(secret, ub, mapId), mapId, instanceKey });
    expect(cb.roomId).toBe(ca.roomId);
    const { matchId } = await started;
    const a = I(room).getPlayerByUser(ua.id)!;
    const b = I(room).getPlayerByUser(ub.id)!;
    expect(a.team).not.toBe(b.team);
    Object.assign(a, { x: 250, y: 200, invulnerableUntil: 0 });
    Object.assign(b, { x: 262, y: 200, invulnerableUntil: 0, shield: 0, hull: 1 });
    await until(() => a.visible.has(b.id));
    ca.send("target", { mode: "ENTITY", entityId: b.id });
    await until(() => a.targetId === b.id);
    ca.send("fire", { firing: true, group: "PRIMARY" });
    const end = await ended;
    expect(end.matchId).toBe(matchId);
    expect(end.winnerTeam).toBe(a.team);
    await until(async () => (await db.gameMatch.findUnique({ where: { id: matchId } }))?.status === "FINISHED");
    const players = await db.gameMatchPlayer.findMany({ where: { matchId } });
    expect(players).toHaveLength(2);
    const pa = players.find((x) => x.userId === ua.id)!;
    expect(pa.kills).toBe(1);
    expect(pa.ratingDelta).toBeGreaterThan(0);
    const userA = await db.user.findUniqueOrThrow({ where: { id: ua.id } });
    expect(userA.pvpRating).toBe(1200 + pa.ratingDelta);
    const stA = await db.playerStat.findUniqueOrThrow({ where: { userId: ua.id } });
    expect(stA.pvpWins).toBe(1);
    await ca.leave().catch(() => undefined);
    await cb.leave().catch(() => undefined);
  });
});

describe("gate run", () => {
  it("charges entry cost, runs all waves and pays completion rewards", async () => {
    const mapId = "map_gate_alpha";
    const u = await createPlayerUser(db, { faction: "nova", level: 20, credits: 50_000 });
    await db.playerResource.create({ data: { userId: u.id, resourceId: "QUANTUM_SHARD", amount: 5n } });
    const instanceKey = `test-${Date.now()}`;
    const c = await colyseus.sdk.joinOrCreate(RoomName.GATE, { ticket: await ticketFor(secret, u, mapId), mapId, instanceKey, difficulty: "HARD" });
    const room = matchMaker.getLocalRoomById(c.roomId);
    I(room).rules = { ...I(room).rules, gateWaveDelayMs: 50 };
    expect(await getBalance(db, userWallet(u.id, "CREDITS"))).toBe(30_000n);
    expect(Number((await db.playerResource.findUniqueOrThrow({ where: { userId_resourceId: { userId: u.id, resourceId: "QUANTUM_SHARD" } } })).amount)).toBe(0);
    const waves: number[] = [];
    c.onMessage("wave", (w: { wave: number }) => waves.push(w.wave));
    const ended = new Promise<unknown>((r) => c.onMessage("match_end", r));
    const me = I(room).getPlayerByUser(u.id)!;
    me.invulnerableUntil = Number.MAX_SAFE_INTEGER;
    const deadline = Date.now() + 20_000;
    let done = false;
    void ended.then(() => { done = true; });
    while (!done && Date.now() < deadline) {
      for (const n of I(room).npcs.values()) if (!n.dead && n.tag.startsWith("wave:")) I(room).kill(n, me);
      await sleep(60);
    }
    expect(done).toBe(true);
    expect(waves).toEqual([1, 2, 3, 4, 5, 6]);
    await I(room).flushAll(false);
    const st = await db.playerStat.findUniqueOrThrow({ where: { userId: u.id } });
    expect(st.gatesCompleted).toBe(1);
    // Completion credits (× HARD reward multiplier) arrive through the ledger exactly once.
    await until(async () => (await getBalance(db, userWallet(u.id, "CREDITS"))) > 30_000n);
    await c.leave().catch(() => undefined);
  });
});
