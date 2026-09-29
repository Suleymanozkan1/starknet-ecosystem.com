/**
 * MP-07 reconnection & cleanup (BaseGameRoom.onLeave / allowReconnection / removePlayer / onDispose)
 * against a real Colyseus server, real WebSocket clients (@colyseus/sdk) and real PostgreSQL.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { matchMaker } from "@colyseus/core";
import { Client as SdkClient, type Room as SdkRoom } from "@colyseus/sdk";
import type { KeyRing } from "@nebula/authentication";
import { createDb, type Db } from "@nebula/database";
import { RoomName } from "@nebula/shared";
import { loadConfig } from "./config.js";
import { buildServices } from "./bootstrap.js";
import { ensureCatalog } from "./persistence/catalog.js";
import { createGameServer } from "./server.js";
import { createPlayerUser, shieldTestIpcFromPm2, ticketFor } from "./test-utils.js";
import type { GameServices } from "./services/context.js";
import type { GameRules } from "./services/rules.js";
import type { PlayerActor } from "./rooms/actors.js";

const envPath = resolve(import.meta.dirname, "../../../.env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

const PORT = 2583;

interface Internals {
  players: Map<string, PlayerActor>;
  rules: GameRules;
  getPlayerByUser(id: string): PlayerActor | undefined;
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
const entities = (c: SdkRoom) => (c.state as { entities?: Map<string, { kind: string }> }).entities;

let sdk: SdkClient;
let shutdown: () => Promise<void>;
let db: Db;
let svc: GameServices;
let secret: KeyRing;

beforeAll(async () => {
  shieldTestIpcFromPm2();
  process.env.GAME_TICK_RATE = "20";
  process.env.LOG_LEVEL = "warn";
  const config = loadConfig();
  secret = config.gameTicketKeys;
  db = createDb();
  svc = buildServices(config, { db, useRedis: true, logLevel: "warn", rngSeed: 99 });
  await ensureCatalog(db);
  const server = createGameServer({ redisUrl: null, gracefullyShutdown: false });
  await server.listen(PORT);
  sdk = new SdkClient(`ws://127.0.0.1:${PORT}`);
  shutdown = () => server.gracefullyShutdown(false);
});

afterAll(async () => {
  await shutdown?.();
  await db?.$disconnect();
});

async function joinSector(mapId: string, faction: string) {
  const user = await createPlayerUser(db, { faction });
  const ticket = await ticketFor(secret, user, mapId);
  const client = await sdk.joinOrCreate(RoomName.SECTOR, { ticket, mapId });
  client.reconnection.enabled = false; // the tests drive reconnection explicitly
  client.onMessage("*", () => undefined);
  await until(() => !!entities(client)?.size);
  const room = matchMaker.getLocalRoomById(client.roomId);
  const actor = I(room).getPlayerByUser(user.id);
  if (!actor) throw new Error("player actor missing");
  return { user, client, room, actor };
}

/** Drop the socket without a LEAVE message (network loss): the server sees a non-consented close. */
async function drop(client: SdkRoom): Promise<void> {
  await client.leave(false);
}

async function persistedPosition(userId: string) {
  const u = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { lastMapId: true, lastX: true, lastY: true } });
  return u;
}

describe("MP-07 reconnection", () => {
  it("an unexpectedly dropped client reconnects with its token inside the window and keeps its actor", async () => {
    const { user, client, room, actor } = await joinSector("map_aurora_prime", "aurora");
    const sessionId = client.sessionId;
    const token = client.reconnectionToken;
    actor.score = 4242;
    actor.kills = 3;
    const joinedAt = actor.joinedAt;

    await drop(client);
    await until(() => !actor.connected);
    // Inside the window: the actor, its entity and presence are kept.
    expect(I(room).players.get(sessionId)).toBe(actor);
    expect(actor.left).toBe(false);
    expect(await svc.redis!.get(`presence:${user.id}`)).toBe("map_aurora_prime");

    const back = await sdk.reconnect(token);
    back.reconnection.enabled = false;
    back.onMessage("*", () => undefined);
    expect(back.sessionId).toBe(sessionId);
    expect(back.roomId).toBe(room.roomId);
    await until(() => actor.connected);
    const same = I(room).getPlayerByUser(user.id);
    expect(same).toBe(actor);
    expect(same?.score).toBe(4242);
    expect(same?.kills).toBe(3);
    expect(same?.joinedAt).toBe(joinedAt);
    expect([...I(room).players.values()].filter((p) => p.userId === user.id)).toHaveLength(1);
    // The reconnected client gets its own entity replicated again (new StateView).
    await until(() => entities(back)?.get(sessionId)?.kind === "PLAYER");
    // Nothing was persisted as a "leave" while reconnecting.
    expect((await persistedPosition(user.id)).lastMapId).toBeNull();

    await back.leave();
  });

  it("a consented leave removes the actor immediately and persists its position (no reconnection)", async () => {
    const { user, client, room, actor } = await joinSector("map_aurora_prime", "aurora");
    const sessionId = client.sessionId;
    const token = client.reconnectionToken;
    await client.leave(true);
    await until(() => actor.left && !I(room).players.has(sessionId));
    expect(I(room).getPlayerByUser(user.id)).toBeUndefined();
    await until(async () => (await persistedPosition(user.id)).lastMapId === "map_aurora_prime");
    const pos = await persistedPosition(user.id);
    expect(pos.lastX).toBeCloseTo(actor.x, 3);
    expect(pos.lastY).toBeCloseTo(actor.y, 3);
    await until(async () => (await svc.redis!.get(`presence:${user.id}`)) === null);
    await expect(sdk.reconnect(token)).rejects.toThrow();
  });

  it("after the reconnection window expires the actor is removed and persisted; the token is dead", async () => {
    const first = await joinSector("map_nova_crown", "nova");
    // A second pilot keeps the room alive so we observe removal, not disposal.
    const keeper = await joinSector("map_nova_crown", "nova");
    expect(keeper.room.roomId).toBe(first.room.roomId);
    I(first.room).rules.reconnectSeconds = 1;
    const sessionId = first.client.sessionId;
    const token = first.client.reconnectionToken;

    await drop(first.client);
    await until(() => !first.actor.connected);
    expect(I(first.room).players.has(sessionId)).toBe(true);
    await until(() => first.actor.left, 5000);
    expect(I(first.room).players.has(sessionId)).toBe(false);
    await until(() => !entities(keeper.client)?.has(sessionId));
    await until(async () => (await persistedPosition(first.user.id)).lastMapId === "map_nova_crown");
    const pos = await persistedPosition(first.user.id);
    expect(pos.lastX).toBeCloseTo(first.actor.x, 3);
    expect(pos.lastY).toBeCloseTo(first.actor.y, 3);
    await expect(sdk.reconnect(token)).rejects.toThrow();
    // The remaining pilot is unaffected.
    expect(I(keeper.room).getPlayerByUser(keeper.user.id)).toBe(keeper.actor);
    await keeper.client.leave();
  });

  it("disposing the room while a pilot is inside the reconnection window persists and removes it", async () => {
    const { user, client, room, actor } = await joinSector("map_vortex_haven", "vortex");
    const sessionId = client.sessionId;
    await drop(client);
    await until(() => !actor.connected);
    expect(I(room).players.has(sessionId)).toBe(true);
    await room.disconnect();
    await until(() => actor.left);
    expect(I(room).players.size).toBe(0);
    await until(async () => (await persistedPosition(user.id)).lastMapId === "map_vortex_haven");
    await until(async () => (await db.gameRoom.findUnique({ where: { id: room.roomId } }))?.disposedAt != null);
    expect(await svc.redis!.get(`presence:${user.id}`)).toBeNull();
  });
});
