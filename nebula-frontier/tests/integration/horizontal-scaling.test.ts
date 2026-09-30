/**
 * MP-09 — horizontal scaling: TWO real game-server processes (apps/game-server/src/index.ts, spawned
 * as child processes) share ONE Redis (RedisPresence + RedisDriver) and one PostgreSQL.
 *
 * Proves, with real @colyseus/sdk WebSocket clients and real game tickets:
 *  (a) cross-node matchmaking: clients that enter through node A and node B for the same map land in
 *      the SAME sector room (one of them via a seat reserved on the other node) and see each other;
 *  (b) a room hosted on one node can be joined by id by a client that talks to the other node;
 *  (c) presence pub/sub works across nodes: GLOBAL and FACTION chat sent in a room on node A reach a
 *      player in a room on node B, and both nodes write player presence into the shared Redis.
 *
 * Colyseus' matchMaker is a process-wide singleton, so two nodes cannot share one process: each node
 * is a separate `node --import tsx` process. They use a dedicated Redis logical DB so other suites'
 * rooms/tickets never leak into this cluster.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client as SdkClient, type Room } from "@colyseus/sdk";
import { keyRingFromEnv, type KeyRing } from "@nebula/authentication";
import { createDb, type Db } from "@nebula/database";
import { RoomName } from "@nebula/shared";
import { createRedis } from "../../apps/game-server/src/services/redis.js";
import { createPlayerUser, ticketFor } from "../../apps/game-server/src/test-utils.js";

const ROOT = resolve(import.meta.dirname, "../..");
const envPath = resolve(ROOT, ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);
process.env.GAME_TICKET_SECRET ||= "test-game-ticket-secret-0123456789abcdef";

/** Dedicated logical DB: this suite flushes it, so it must not be shared with any other suite. */
const SCALING_REDIS_DB = 11;
const SECTOR_MAPS = ["map_aurora_prime", "map_vortex_haven", "map_nova_crown", "map_helios_frontier", "map_orion_belt"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, timeoutMs = 10_000, step = 50): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(step);
  }
  throw new Error("condition not met in time");
}

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => res(port));
    });
  });
}

function redisUrlWithDb(base: string, db: number): string {
  const u = new URL(base);
  u.pathname = `/${db}`;
  return u.toString();
}

interface GameNode {
  name: string;
  port: number;
  proc: ChildProcess;
  /** SDK client whose matchmaking HTTP requests go to THIS node. */
  sdk: SdkClient;
  /** WebSocket URLs the SDK opened after matchmaking through this node (reveals the hosting node). */
  wsUrls: string[];
  output: string[];
}

interface Entities { entities?: Map<string, { kind: string }> }
interface ChatEvt { channel: string; text: string; fromId: string }

let db: Db;
let redis: NonNullable<ReturnType<typeof createRedis>>;
let secret: KeyRing;
let redisUrl: string;
const nodes: GameNode[] = [];
const rooms: Room[] = [];

async function startNode(name: string): Promise<GameNode> {
  const port = await freePort();
  const output: string[] = [];
  const proc = spawn(process.execPath, ["--import", "tsx", "apps/game-server/src/index.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      GAME_PORT: String(port),
      REDIS_URL: redisUrl,
      // Seat reservations carry the hosting node's address so the SDK connects there directly.
      // Given with a scheme on purpose: the server must advertise it scheme-less (resolvePublicAddress).
      GAME_PUBLIC_ADDRESS: `ws://127.0.0.1:${port}/`,
      GAME_TICK_RATE: "20",
      LOG_LEVEL: "warn",
      NODE_OPTIONS: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const keep = (b: Buffer) => {
    output.push(b.toString());
    if (output.length > 200) output.shift();
  };
  proc.stdout?.on("data", keep);
  proc.stderr?.on("data", keep);
  const wsUrls: string[] = [];
  const sdk = new SdkClient(`ws://127.0.0.1:${port}`, {
    urlBuilder: (url: URL) => {
      if (url.protocol === "ws:") wsUrls.push(url.toString());
      return url.toString();
    },
  });
  const node: GameNode = { name, port, proc, sdk, wsUrls, output };
  nodes.push(node);
  try {
    await until(async () => {
      if (proc.exitCode !== null) throw new Error(`${name} exited early (${proc.exitCode}):\n${output.join("")}`);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        return res.ok;
      } catch {
        return false;
      }
    }, 90_000, 200);
  } catch (e) {
    throw new Error(`${name} did not become healthy: ${e instanceof Error ? e.message : String(e)}\n${output.join("")}`);
  }
  return node;
}

async function stopNode(node: GameNode): Promise<void> {
  const { proc } = node;
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise<void>((r) => proc.once("exit", () => r()));
  proc.kill("SIGTERM");
  const timedOut = await Promise.race([exited.then(() => false), sleep(15_000).then(() => true)]);
  if (timedOut) {
    proc.kill("SIGKILL");
    await exited;
  }
}

function killAllNow(): void {
  for (const n of nodes) if (n.proc.exitCode === null && n.proc.signalCode === null) n.proc.kill("SIGKILL");
}

/** Port of the node whose WebSocket the SDK opened for the most recent join through `via`. */
function hostPortOfLastJoin(via: GameNode): number {
  const last = via.wsUrls.at(-1);
  if (!last) throw new Error(`no websocket opened through ${via.name}`);
  return Number(new URL(last).port);
}

async function player(faction = "aurora") {
  return createPlayerUser(db, { prefix: "hs_", faction });
}

async function join(via: GameNode, mapId: string, user: { id: string; username: string }): Promise<{ room: Room; hostPort: number }> {
  const ticket = await ticketFor(secret, user, mapId);
  const room = await via.sdk.joinOrCreate(RoomName.SECTOR, { ticket, mapId });
  track(room);
  const hostPort = hostPortOfLastJoin(via);
  await until(() => !!(room.state as Entities).entities?.has(room.sessionId));
  return { room, hostPort };
}

/** Registers the room for cleanup and swallows server events this suite does not assert on. */
function track(room: Room): Room {
  room.onMessage("*", () => undefined);
  rooms.push(room);
  return room;
}

function sees(room: Room, entityId: string): boolean {
  return !!(room.state as Entities).entities?.has(entityId);
}

beforeAll(async () => {
  process.on("exit", killAllNow);
  redisUrl = redisUrlWithDb(process.env.REDIS_URL || "redis://localhost:6379", SCALING_REDIS_DB);
  const r = createRedis(redisUrl);
  if (!r) throw new Error("redis url missing");
  redis = r;
  // Stale room caches / process stats from an aborted earlier run would point matchmaking at dead nodes.
  await redis.flushdb();
  secret = keyRingFromEnv("GAME_TICKET");
  db = createDb();
  // Sequential boot: both nodes run the idempotent catalog sync at startup.
  await startNode("node-A");
  await startNode("node-B");
  // Both processes registered in the shared matchmaker stats.
  await until(async () => Object.keys(await redis.hgetall("roomcount")).length === 2, 15_000, 100);
});

afterAll(async () => {
  await Promise.all(rooms.map((r) => r.leave().catch(() => undefined)));
  await Promise.all(nodes.map((n) => stopNode(n)));
  process.off("exit", killAllNow);
  await redis?.flushdb().catch(() => undefined);
  redis?.disconnect();
  await db?.$disconnect();
});

describe("MP-09 horizontal scaling (2 game-server processes, 1 Redis)", () => {
  it("(a) clients entering through different nodes share one sector room per map and see each other", async () => {
    const [A, B] = nodes as [GameNode, GameNode];
    const mapId = "map_aurora_prime";
    const first = await join(A, mapId, await player());
    // The second player enters through the node that does NOT host the room: the seat must be
    // reserved remotely on the hosting node through the Redis driver / presence IPC.
    const other = first.hostPort === A.port ? B : A;
    const second = await join(other, mapId, await player());

    expect(second.room.roomId).toBe(first.room.roomId);
    expect(second.hostPort).toBe(first.hostPort);
    expect(second.hostPort).not.toBe(other.port);
    await until(() => sees(first.room, second.room.sessionId) && sees(second.room, first.room.sessionId));
    expect((first.room.state as Entities).entities?.get(second.room.sessionId)?.kind).toBe("PLAYER");
  });

  it("(b) a room hosted on one node can be joined by id through the other node", async () => {
    const [A, B] = nodes as [GameNode, GameNode];
    const mapId = "map_vortex_haven";
    const owner = await join(B, mapId, await player("vortex"));
    const via = owner.hostPort === A.port ? B : A;
    const user = await player("vortex");
    const ticket = await ticketFor(secret, user, mapId);
    const guest = track(await via.sdk.joinById(owner.room.roomId, { ticket, mapId }));

    expect(guest.roomId).toBe(owner.room.roomId);
    expect(hostPortOfLastJoin(via)).toBe(owner.hostPort);
    expect(hostPortOfLastJoin(via)).not.toBe(via.port);
    await until(() => sees(guest, owner.room.sessionId) && sees(owner.room, guest.sessionId));
  });

  it("(c) presence pub/sub (GLOBAL + FACTION chat) and presence keys work across nodes", async () => {
    const [A, B] = nodes as [GameNode, GameNode];
    // Open sector rooms (one per map) until there is a room on each node. Matchmaking places new
    // rooms on the process with the fewest rooms (stats persisted to Redis at most once per second).
    const byPort = new Map<number, { room: Room; userId: string }>();
    for (const [i, mapId] of SECTOR_MAPS.entries()) {
      if (byPort.size === 2) break;
      const u = await player("nova");
      const j = await join(i % 2 === 0 ? A : B, mapId, u);
      if (!byPort.has(j.hostPort)) byPort.set(j.hostPort, { room: j.room, userId: u.id });
      await sleep(1_200);
    }
    const onA = byPort.get(A.port);
    const onB = byPort.get(B.port);
    expect(onA, "a room hosted on node A").toBeDefined();
    expect(onB, "a room hosted on node B").toBeDefined();
    if (!onA || !onB) return;
    expect(onA.room.roomId).not.toBe(onB.room.roomId);

    // Both nodes write player presence into the one shared Redis (read by the API).
    expect(await redis.get(`presence:${onA.userId}`)).toBeTruthy();
    expect(await redis.get(`presence:${onB.userId}`)).toBeTruthy();

    const received: ChatEvt[] = [];
    onB.room.onMessage("chat", (e: ChatEvt) => received.push(e));
    const globalText = `global-${Date.now()}`;
    onA.room.send("chat", { channel: "GLOBAL", text: globalText });
    await until(() => received.some((e) => e.channel === "GLOBAL" && e.text === globalText && e.fromId === onA.userId));

    // FACTION chat: node B's room never sent faction chat itself, it must still be subscribed.
    const factionText = `faction-${Date.now()}`;
    await sleep(1_100); // chat rate limit
    onA.room.send("chat", { channel: "FACTION", text: factionText });
    await until(() => received.some((e) => e.channel === "FACTION" && e.text === factionText && e.fromId === onA.userId));
  });
});
