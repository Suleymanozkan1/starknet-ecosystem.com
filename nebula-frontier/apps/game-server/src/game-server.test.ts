/**
 * End-to-end room tests: real Colyseus server (in-process presence/driver),
 * real PostgreSQL, real WebSocket clients (@colyseus/sdk) — direct room tests.
 */
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { clanMissionProgressSchema } from "@nebula/validation";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { matchMaker } from "@colyseus/core";
import { Client as SdkClient } from "@colyseus/sdk";
import { EVENTS_BY_ID, QUESTS_BY_ID, NPCS_BY_ID, MAPS_BY_ID, LOOT_TABLES_BY_ID } from "@nebula/config";
import type { KeyRing } from "@nebula/authentication";
import { createDb, getBalance, post, system, userWallet, type Db } from "@nebula/database";
import { STARTER_AMMO, isPvpAllowedAt, objectiveIncrement, starterAmmoOriginRef, type HitResult, type LootDrop } from "@nebula/game-core";
import { LedgerAccountType, RoomName, type MapDef } from "@nebula/shared";

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
  applyHit(src: PlayerActor | null, target: NpcActor | PlayerActor, res: HitResult, weaponType: string): void;
  getRiftPortals(): { id: string; x: number; y: number; windowStart: number; eventId: string }[];
  getNpcs(): NpcActor[];
  clanWarId?: string | null;
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
let secret: KeyRing;
let mockApi: Server;
const clanEvents: { userId: string; event: { type: string; npcId?: string } }[] = [];

beforeAll(async () => {
  shieldTestIpcFromPm2();
  process.env.GAME_TICK_RATE = "20";
  process.env.LOG_LEVEL = "warn";
  // Redis is used for ticket jti / presence / mutes (as in production); matchmaking stays in-process.
  // Mock of the API internal endpoint (validates with the real shared zod schema + token).
  mockApi = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => { body += c.toString(); });
    req.on("end", () => {
      if (req.url !== "/api/internal/clan-missions/progress" || req.headers["x-internal-token"] !== process.env.INTERNAL_SERVICE_TOKEN) {
        res.statusCode = 401;
        return res.end();
      }
      const parsed = clanMissionProgressSchema.safeParse(JSON.parse(body));
      if (!parsed.success) {
        res.statusCode = 400;
        return res.end();
      }
      clanEvents.push(...parsed.data.events);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, missionsUpdated: 0 }));
    });
  });
  await new Promise<void>((r) => mockApi.listen(0, "127.0.0.1", () => r()));
  process.env.INTERNAL_SERVICE_TOKEN ||= "test-internal-service-token-0123456789";
  process.env.API_INTERNAL_URL = `http://127.0.0.1:${(mockApi.address() as AddressInfo).port}`;
  const config = loadConfig();
  secret = config.gameTicketKeys;
  db = createDb();
  svc = buildServices(config, { db, useRedis: true, logLevel: "warn", rngSeed: 1234 });
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
  mockApi?.close();
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
    // Starter missile ammo from factions.json (shared STARTER_AMMO source of truth).
    const ammo = await db.inventoryItem.findFirst({ where: { userId: user.id, originRef: starterAmmoOriginRef(user.id, "item_ammo_hornet") } });
    expect(ammo?.quantity).toBe(STARTER_AMMO.get("aurora")?.[0]?.quantity);
    expect(actor.profile.ammo.get("item_ammo_hornet")?.[0]?.quantity).toBe(ammo?.quantity);
    // Online presence for the API.
    expect(await svc.redis!.get(`presence:${user.id}`)).toBe("map_aurora_prime");
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

async function pvpSpot(map: MapDef): Promise<{ x: number; y: number }> {
  for (let i = 0; i < 200; i++) {
    const x = 50 + ((i * 37) % Math.max(1, map.width - 100));
    const y = 50 + ((i * 53) % Math.max(1, map.height - 100));
    if (isPvpAllowedAt(map, x, y)) return { x, y };
  }
  throw new Error("no pvp spot");
}

function bigHit(target: { shield: number; hull: number }): HitResult {
  return { hit: true, crit: false, weakPoint: false, element: "THERMAL", raw: target.shield + target.hull, shieldDamage: target.shield, armorDamage: 0, hullDamage: target.hull, shieldAfter: 0, hullAfter: 0, killed: true };
}

describe("presence & mutes", () => {
  it("clears presence on leave and blocks chat when muted in Redis", async () => {
    const { client, user } = await joinSector("map_aurora_prime");
    const errors: string[] = [];
    client.onMessage("error", (e: { code: string }) => errors.push(e.code));
    await svc.redis!.set(`mute:${user.id}`, "1", "PX", 60_000);
    client.send("chat", { channel: "LOCAL", text: "hello" });
    await until(() => errors.includes("MUTED"));
    await client.leave();
    await until(async () => (await svc.redis!.get(`presence:${user.id}`)) === null);
  });
});

describe("markers", () => {
  it("relays tactical markers to allies only", async () => {
    const a = await joinSector("map_aurora_prime", { faction: "aurora" });
    const b = await joinSector("map_aurora_prime", { faction: "aurora" });
    const c = await joinSector("map_aurora_prime", { faction: "nova" });
    const gotB = new Promise<{ fromName: string; kind: string }>((r) => b.client.onMessage("marker", r));
    let cGot = false;
    c.client.onMessage("marker", () => { cGot = true; });
    a.client.send("marker", { x: 100, y: 100, kind: "ATTACK" });
    const m = await gotB;
    expect(m).toMatchObject({ fromName: a.user.username, kind: "ATTACK", x: 100, y: 100 });
    await sleep(200);
    expect(cGot).toBe(false);
    await Promise.all([a.client.leave(), b.client.leave(), c.client.leave()]);
  });
});

describe("void rift", () => {
  it("opens an EVENT_GATE portal on the rift maps that leads into the event room and closes at event end", async () => {
    const { client, room, actor } = await joinSector("map_vanta_rift", { level: 20 });
    const notices: { eventId: string; mapIds: string[] }[] = [];
    client.onMessage("event_started", (e: { eventId: string; mapIds: string[] }) => notices.push(e));
    const t0 = Date.now();
    svc.events.trigger("evt_void_rift", 0.05); // 3 seconds
    await until(() => I(room).getRiftPortals().some((p) => p.windowStart >= t0));
    const portal = I(room).getRiftPortals().find((p) => p.windowStart >= t0)!;
    await until(() => notices.some((n) => n.eventId === "evt_void_rift" && n.mapIds.includes("map_vanta_rift")));
    await until(() => (client.state as unknown as { entities: Map<string, { kind: string; defId: string }> }).entities.get(portal.id)?.defId === "EVENT_GATE");
    actor.x = portal.x;
    actor.y = portal.y;
    actor.lastDamagedAt = 0;
    const jump = new Promise<{ roomName: string; mapId: string; reservation?: { roomId?: string } }>((r) => client.onMessage("jump", r));
    client.send("jump", { portalId: portal.id });
    const ev = await jump;
    expect(ev.roomName).toBe(RoomName.EVENT);
    expect(ev.reservation?.roomId).toBeTruthy();
    await sleep(3200);
    svc.events.evaluate(Date.now());
    await until(() => !I(room).getRiftPortals().some((p) => p.id === portal.id));
    await client.leave();
  });
});

describe("event rewards", () => {
  it("distributes EventParticipation tiers once when the event boss dies", async () => {
    svc.events.trigger("evt_void_rift", 5);
    const u = await createPlayerUser(db, { faction: "aurora", level: 40 });
    const mapId = "map_astra_graveyard";
    const instanceKey = `test-rift-${Date.now()}`;
    const c = await colyseus.sdk.joinOrCreate(RoomName.EVENT, { ticket: await ticketFor(secret, u, mapId), mapId, instanceKey });
    const room = matchMaker.getLocalRoomById(c.roomId);
    await until(() => I(room).getNpcs().some((n) => n.def.id === "boss_void_herald" && !n.dead));
    const boss = I(room).getNpcs().find((n) => n.def.id === "boss_void_herald")!;
    const me = I(room).getPlayerByUser(u.id)!;
    const rewards: { reason: string }[] = [];
    c.onMessage("reward", (r: { reason: string }) => rewards.push(r));
    I(room).applyHit(me, boss, bigHit(boss), "LASER");
    expect(boss.dead).toBe(true);
    await until(async () => (await db.eventParticipation.findFirst({ where: { userId: u.id, instanceKey: boss.uid } }))?.rewarded === true);
    const row = await db.eventParticipation.findFirstOrThrow({ where: { userId: u.id, instanceKey: boss.uid } });
    expect(row.rewardTier).toBe("GOLD");
    const gold = EVENTS_BY_ID.get("evt_void_rift")!.rewards.find((r) => r.tier === "GOLD")!;
    // Kill credits (NpcDef.credits, flushed) + GOLD tier credits (event bundle).
    const expected = BigInt((gold.bundle.credits ?? 0) + boss.def.credits);
    await until(async () => (await getBalance(db, userWallet(u.id, "CREDITS"))) === expected);
    const items = await db.inventoryItem.findMany({ where: { userId: u.id, originRef: { startsWith: `event:evt_void_rift:${boss.uid}:${u.id}` } } });
    expect(items.map((i) => i.itemId)).toEqual((gold.bundle.items ?? []).map((i) => i.itemId));
    await until(() => rewards.some((r) => r.reason.includes("GOLD")));
    // Idempotent: a second distribution pays nothing.
    const again = await svc.persistence.distributeEventRewards("evt_void_rift", boss.uid, EVENTS_BY_ID.get("evt_void_rift")!, { minShare: 0, fallbackSource: "EVENT", label: "x" });
    expect(again).toEqual([]);
    expect(await getBalance(db, userWallet(u.id, "CREDITS"))).toBe(expected);
    await c.leave();
  });
});

describe("bounties", () => {
  it("pays escrowed bounty credits to the PvP killer exactly once", async () => {
    const map = MAPS_BY_ID.get("map_vanta_rift")!;
    const a = await joinSector(map.id, { faction: "aurora", level: 20 });
    const b = await joinSector(map.id, { faction: "vortex", level: 20 });
    const creator = await createPlayerUser(db, { faction: "nova", credits: 20_000 });
    const bounty = await db.$transaction(async (tx) => {
      const bt = await tx.bounty.create({ data: { targetId: b.user.id, creatorId: creator.id, amount: 15_000n, expiresAt: new Date(Date.now() + 3_600_000) } });
      await post(tx, { from: userWallet(creator.id, "CREDITS"), to: system(LedgerAccountType.ESCROW, "CREDITS"), amount: 15_000n, type: "ESCROW", reference: bt.id, idempotencyKey: `bounty:test:${bt.id}`, userId: creator.id });
      return bt;
    });
    const spot = await pvpSpot(map);
    Object.assign(a.actor, { x: spot.x, y: spot.y, invulnerableUntil: 0 });
    Object.assign(b.actor, { x: spot.x + 1, y: spot.y, invulnerableUntil: 0 });
    I(a.room).applyHit(a.actor, b.actor, bigHit(b.actor), "LASER");
    await until(async () => (await db.bounty.findUnique({ where: { id: bounty.id } }))?.status === "CLAIMED");
    const claimed = await db.bounty.findUniqueOrThrow({ where: { id: bounty.id } });
    expect(claimed.claimedBy).toBe(a.user.id);
    expect(await getBalance(db, userWallet(a.user.id, "CREDITS"))).toBe(15_000n);
    expect(await svc.persistence.claimBounties(b.user.id, a.user.id)).toEqual([]);
    expect(await getBalance(db, userWallet(a.user.id, "CREDITS"))).toBe(15_000n);
    await Promise.all([a.client.leave(), b.client.leave()]);
  });
});

describe("clan war", () => {
  it("updates the ClanWar row and clan scores with the match result", async () => {
    const mk = async (tag: string) => db.clan.create({ data: { name: `Clan ${tag}`, tag } });
    const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
    const clanA = await mk(`A${suffix}`);
    const clanB = await mk(`B${suffix}`);
    const war = await db.clanWar.create({ data: { clanAId: clanA.id, clanBId: clanB.id, phase: "BATTLE", mapId: "map_eclipse_arena", startsAt: new Date(), endsAt: new Date(Date.now() + 3_600_000) } });
    const ua = await createPlayerUser(db, { faction: "aurora", level: 15 });
    const ub = await createPlayerUser(db, { faction: "vortex", level: 15 });
    await db.clanMember.create({ data: { userId: ua.id, clanId: clanA.id, role: "LEADER" } });
    await db.clanMember.create({ data: { userId: ub.id, clanId: clanB.id, role: "LEADER" } });
    const mapId = "map_eclipse_arena";
    const ca = await colyseus.sdk.joinOrCreate(RoomName.CLAN_WAR, { ticket: await ticketFor(secret, ua, mapId), mapId, instanceKey: war.id });
    const room = matchMaker.getLocalRoomById(ca.roomId);
    I(room).rules = { ...I(room).rules, arenaCountdownMs: 100, arenaScoreToWin: 1 };
    const started = new Promise((r) => ca.onMessage("match_start", r));
    const ended = new Promise((r) => ca.onMessage("match_end", r));
    const cb = await colyseus.sdk.joinOrCreate(RoomName.CLAN_WAR, { ticket: await ticketFor(secret, ub, mapId), mapId, instanceKey: war.id });
    await started;
    const a = I(room).getPlayerByUser(ua.id)!;
    const b = I(room).getPlayerByUser(ub.id)!;
    b.invulnerableUntil = 0;
    I(room).applyHit(a, b, bigHit(b), "LASER");
    await ended;
    await until(async () => (await db.clanWar.findUnique({ where: { id: war.id } }))?.phase === "REWARDED");
    const w = await db.clanWar.findUniqueOrThrow({ where: { id: war.id } });
    expect(w.winnerId).toBe(clanA.id);
    expect(w.scoreA).toBe(1);
    expect(w.scoreB).toBe(0);
    const [sa, sb] = await Promise.all([db.clan.findUniqueOrThrow({ where: { id: clanA.id } }), db.clan.findUniqueOrThrow({ where: { id: clanB.id } })]);
    expect(Number(sa.score)).toBe(I(room).rules.clanWarKillScore + I(room).rules.clanWarWinScore);
    expect(Number(sb.score)).toBe(0);
    await ca.leave().catch(() => undefined);
    await cb.leave().catch(() => undefined);
  });
});

describe("clan missions", () => {
  it("reports targeted objective events of clan members to the API (q_clan_founding progresses)", async () => {
    const clan = await db.clan.create({ data: { name: `Mission ${Date.now()}`, tag: `M${Math.random().toString(36).slice(2, 6).toUpperCase()}` } });
    const u = await createPlayerUser(db, { faction: "aurora", level: 10 });
    await db.clanMember.create({ data: { userId: u.id, clanId: clan.id, role: "LEADER" } });
    const ticket = await ticketFor(secret, u, "map_aurora_prime");
    const c = await colyseus.sdk.joinOrCreate(RoomName.SECTOR, { ticket, mapId: "map_aurora_prime" });
    const r = matchMaker.getLocalRoomById(c.roomId);
    await until(() => !!I(r).getPlayerByUser(u.id));
    const me = I(r).getPlayerByUser(u.id)!;
    const fighter = I(r).spawnNpc(NPCS_BY_ID.get("npc_xyrr_fighter")!, me.x + 10, me.y, { spawnIndex: null });
    I(r).applyHit(me, fighter, bigHit(fighter), "LASER");
    expect(fighter.dead).toBe(true);
    await I(r).flushAll(false);
    await until(() => clanEvents.some((e) => e.userId === u.id && e.event.type === "KILL" && e.event.npcId === "npc_xyrr_fighter"));
    const ev = clanEvents.find((e) => e.userId === u.id && e.event.type === "KILL")!.event;
    const q = QUESTS_BY_ID.get("q_clan_founding")!;
    expect(objectiveIncrement(q.objectives[0]!, ev as Parameters<typeof objectiveIncrement>[1])).toBe(1);
    // Non-clan players are never reported (the reporter drops events without a clan).
    const loner = await joinSector("map_aurora_prime");
    const other = I(loner.room).spawnNpc(NPCS_BY_ID.get("npc_xyrr_fighter")!, loner.actor.x + 10, loner.actor.y, { spawnIndex: null });
    I(loner.room).applyHit(loner.actor, other, bigHit(other), "LASER");
    await I(loner.room).flushAll(false);
    await sleep(300);
    expect(clanEvents.some((e) => e.userId === loner.user.id)).toBe(false);
    await loner.client.leave();
    await c.leave();
  });
});
