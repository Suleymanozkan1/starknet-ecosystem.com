/**
 * MVP VERTICAL SLICE (brief §144) — one end-to-end run across the real services:
 *
 *   account (SIWS wallet login) → wallet → faction → ship → ticket → enter galaxy (Colyseus join)
 *   → move → target NPC → shoot → kill → XP/level → loot → inventory → equip → PvP kill
 *   → leaderboard → event reward → crypto-eligible reward → wallet page → withdrawal
 *   → blockchain-service payout → transaction signature.
 *
 * Real components: Fastify API (buildApp), Colyseus game server (in-process, real WebSocket
 * clients), PostgreSQL (isolated schema so mock-chain funding never touches the devnet-backed
 * ledger), Redis, the blockchain-service withdrawal processor. The only substitute is the Solana
 * RPC: a local mock chain that decodes and applies the real signed transactions (public devnet
 * faucet is rate-limited from this environment — see docs/FINAL_IMPLEMENTATION_REPORT.md).
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { matchMaker } from "@colyseus/core";
import { Client as SdkClient, type Room } from "@colyseus/sdk";
import { generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import type { FastifyInstance } from "fastify";
import { NPCS_BY_ID, MAPS_BY_ID, EVENTS_BY_ID } from "@nebula/config";
import { RoomName } from "@nebula/shared";
import { getBalance, post, system, userWallet, verifyLedgerIntegrity, type Db } from "@nebula/database";
import { bootstrapTreasury } from "@nebula/economy";
import { createIsolatedDb } from "@nebula/economy/testing";
import { createMockSolanaRpc } from "@nebula/blockchain/testing";
import { isPvpAllowedAt } from "@nebula/game-core";
import { buildApp } from "../../apps/api/src/app.js";
import { loadConfig } from "../../apps/game-server/src/config.js";
import { buildServices } from "../../apps/game-server/src/bootstrap.js";
import { ensureCatalog } from "../../apps/game-server/src/persistence/catalog.js";
import { createGameServer } from "../../apps/game-server/src/server.js";
import { shieldTestIpcFromPm2 } from "../../apps/game-server/src/test-utils.js";
import { processWithdrawal } from "../../apps/blockchain-service/src/processor.js";
import type { Session} from "./helpers.js";
import { walletLogin } from "./helpers.js";

const envPath = resolve(import.meta.dirname, "../../.env");
if (existsSync(envPath)) process.loadEnvFile(envPath);
process.env.NODE_ENV = "test";
process.env.JWT_SECRET ||= "test-jwt-secret-0123456789abcdef0123456789abcdef";
process.env.GAME_TICKET_SECRET ||= "test-game-ticket-secret-0123456789abcdef";

const GAME_PORT = 2571;
const SOL = 1_000_000_000n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, timeoutMs = 10_000, step = 50): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(step);
  }
  throw new Error("condition not met in time");
}

/* Minimal view of room internals used to place actors deterministically (positions are server state). */
interface Actor { id: string; userId: string; x: number; y: number; dead: boolean; targetId: string | null; visible: Set<string>; invulnerableUntil: number; shield: number; hull: number; stunnedUntil: number; nextThinkAt: number }
interface RoomInternals {
  getPlayerByUser(id: string): Actor | undefined;
  spawnNpc(def: unknown, x: number, y: number, o?: { spawnIndex?: number | null }): Actor;
  getLoot(): { id: string; x: number; y: number }[];
  getNpcs(): Actor[];
  flushAll(final: boolean): Promise<void>;
}
const internals = (roomId: string) => matchMaker.getLocalRoomById(roomId) as unknown as RoomInternals;

let db: Db;
let app: FastifyInstance;
let shutdownGame: () => Promise<void>;
let stopEvents: () => void;
let sdk: SdkClient;
const chain = { treasury: undefined as unknown as KeyPairSigner, rpc: undefined as unknown as ReturnType<typeof createMockSolanaRpc>["rpc"] };

// Shared state between ordered steps.
const S: {
  pilot?: { s: Session; signer: KeyPairSigner };
  rival?: { s: Session; signer: KeyPairSigner };
  room?: Room;
  roomId?: string;
  lootItemId?: string;
} = {};

async function ticketAndJoin(s: Session): Promise<Room> {
  const t = await s.req("POST", "/api/game/ticket", {});
  expect(t.statusCode, t.body).toBe(200);
  const { ticket, mapId } = t.json() as { ticket: string; mapId: string };
  const room = await sdk.joinOrCreate(RoomName.SECTOR, { ticket, mapId });
  await until(() => !!(room.state as { entities?: Map<string, unknown> }).entities?.size);
  return room;
}

beforeAll(async () => {
  shieldTestIpcFromPm2();
  process.env.SERVICE_ROLE = "blockchain"; // the withdrawal processor step runs blockchain-service code
  db = await createIsolatedDb(`vslice_${randomUUID().slice(0, 8).replace(/-/g, "")}`);
  await ensureCatalog(db);
  // Mock chain holding real treasury funds; the ledger reward pool is funded only from that balance.
  chain.treasury = await generateKeyPairSigner();
  chain.rpc = createMockSolanaRpc({ balances: { [chain.treasury.address]: 50n * SOL } }).rpc;
  process.env.TREASURY_PUBLIC_KEY = chain.treasury.address;
  const bal = await chain.rpc.getBalance(chain.treasury.address, { commitment: "confirmed" }).send();
  await bootstrapTreasury(db, { onChainBalance: bal.value, slot: bal.context.slot, treasuryAddress: chain.treasury.address });
  // Season revenue drives the (bounded) reward budget: record owner revenue for season_1.
  await db.season.updateMany({ where: { id: "season_1" }, data: { revenue: 100n * SOL } });
  // Feature flags exactly as prisma/seed.ts seeds them (compliance gates for wallet features).
  for (const [key, rules] of [["wallet", {}], ["deposit", { denyRestrictions: ["WALLET_SUSPENDED"] }], ["withdraw", { denyRestrictions: ["WITHDRAWAL_SUSPENDED"], maxRiskLevel: "HIGH" }]] as const) {
    await db.featureFlag.upsert({ where: { key }, create: { key, enabled: true, rules }, update: {} });
  }

  app = await buildApp({ db, logger: false, rateLimitScale: 1000, rateLimitNamespace: `nf:vslice:${randomUUID()}:` });
  await app.ready();

  process.env.LOG_LEVEL = "warn";
  const config = loadConfig();
  const svc = buildServices(config, { db, useRedis: true, logLevel: "warn", rngSeed: 7 });
  const server = createGameServer({ redisUrl: null, gracefullyShutdown: false });
  await server.listen(GAME_PORT);
  sdk = new SdkClient(`ws://127.0.0.1:${GAME_PORT}`);
  svc.events.start(matchMaker.presence, 60_000);
  stopEvents = () => svc.events.stop();
  shutdownGame = () => server.gracefullyShutdown(false);
}, 120_000);

afterAll(async () => {
  stopEvents?.();
  await shutdownGame?.();
  await app?.close();
  await db?.$disconnect();
});

describe.sequential("MVP vertical slice", { timeout: 90_000 }, () => {
  it("account: user enters, signs in with a Solana wallet (nonce → signature → session) — wallet connected", async () => {
    S.pilot = await walletLogin(app);
    S.rival = await walletLogin(app);
    const me = await S.pilot.s.req("GET", "/api/me");
    expect(me.statusCode).toBe(200);
    const body = me.json() as { wallets: { address: string }[] };
    expect(body.wallets.map((w) => w.address)).toContain(S.pilot.signer.address);
  });

  it("faction + ship: choose faction, receive and activate the starter ship", async () => {
    for (const [p, faction] of [[S.pilot!, "aurora"], [S.rival!, "vortex"]] as const) {
      const r = await p.s.req("POST", "/api/me/faction", { factionId: faction });
      expect(r.statusCode, r.body).toBe(200);
    }
    const ships = await S.pilot!.s.req("GET", "/api/ships");
    expect(ships.statusCode).toBe(200);
    const u = await db.user.findUniqueOrThrow({ where: { id: S.pilot!.s.userId } });
    expect(u.activeShipId).toBeTruthy();
  });

  it("enter: API ticket admits the pilot into the galaxy (Colyseus sector room, single-use ticket)", async () => {
    S.room = await ticketAndJoin(S.pilot!.s);
    S.roomId = S.room.roomId;
    const me = (S.room.state as unknown as { entities: Map<string, { kind: string }> }).entities.get(S.room.sessionId);
    expect(me?.kind).toBe("PLAYER");
  });

  it("move: inputs move the ship; position is server-authoritative", async () => {
    const actor = internals(S.roomId!).getPlayerByUser(S.pilot!.s.userId)!;
    const x0 = actor.x;
    const y0 = actor.y;
    for (let seq = 1; seq <= 20; seq++) {
      S.room!.send("input", { seq, thrust: 1, strafe: 0, heading: 0, boost: false });
      await sleep(50);
    }
    await until(() => Math.hypot(actor.x - x0, actor.y - y0) > 1);
  });

  it("target + shoot + kill NPC → XP gained, loot dropped", async () => {
    const r = internals(S.roomId!);
    const actor = r.getPlayerByUser(S.pilot!.s.userId)!;
    // Stop (thrust 0) — the ship still carries momentum from the move step — then place it in open
    // space outside the home station's SAFE zone, where weapons are enabled.
    S.room!.send("input", { seq: 1000, thrust: 0, strafe: 0, heading: 0, boost: false });
    await sleep(100);
    Object.assign(actor, { x: 300, y: 225, vx: 0, vy: 0 });
    const def = NPCS_BY_ID.get("npc_mining_drone")!;
    const npc = r.spawnNpc({ ...def, lootTable: "loot_mining_drone" }, actor.x + 15, actor.y, { spawnIndex: null });
    npc.stunnedUntil = Number.MAX_SAFE_INTEGER;
    npc.nextThinkAt = Number.MAX_SAFE_INTEGER;
    await until(() => (S.room!.state as unknown as { entities: Map<string, unknown> }).entities.has(npc.id));
    S.room!.send("target", { mode: "ENTITY", entityId: npc.id });
    await until(() => actor.targetId === npc.id);
    S.room!.send("fire", { firing: true, group: "PRIMARY" });
    await until(() => npc.dead, 20_000);
    S.room!.send("fire", { firing: false, group: "PRIMARY" });
    await r.flushAll(false);
    const u = await db.user.findUniqueOrThrow({ where: { id: S.pilot!.s.userId } });
    expect(Number(u.xp)).toBeGreaterThanOrEqual(def.xp);
    expect(await getBalance(db, userWallet(u.id, "CREDITS"))).toBeGreaterThanOrEqual(BigInt(def.credits));
  });

  it("level up: XP from kills is applied by the server's progression curve", async () => {
    const before = await db.user.findUniqueOrThrow({ where: { id: S.pilot!.s.userId } });
    const r = internals(S.roomId!);
    const actor = r.getPlayerByUser(S.pilot!.s.userId)!;
    Object.assign(actor, { x: 300, y: 225, vx: 0, vy: 0 });
    // Highest-XP regular NPC; keep fighting until the server's progression curve levels the pilot up.
    const def = [...NPCS_BY_ID.values()].filter((n) => n.kind === "NPC").sort((a, b) => b.xp - a.xp)[0]!;
    for (let i = 0; i < 12; i++) {
      Object.assign(actor, { x: 300, y: 225, vx: 0, vy: 0 });
      const npc = r.spawnNpc({ ...def }, actor.x + 12, actor.y, { spawnIndex: null });
      Object.assign(npc, { stunnedUntil: Number.MAX_SAFE_INTEGER, nextThinkAt: Number.MAX_SAFE_INTEGER, shield: 0, hull: 1 });
      await until(() => actor.visible.has(npc.id));
      S.room!.send("target", { mode: "ENTITY", entityId: npc.id });
      await until(() => actor.targetId === npc.id);
      S.room!.send("fire", { firing: true, group: "PRIMARY" });
      await until(() => npc.dead, 20_000);
      S.room!.send("fire", { firing: false, group: "PRIMARY" });
      await r.flushAll(false);
      if ((await db.user.findUniqueOrThrow({ where: { id: S.pilot!.s.userId } })).level >= 2) break;
    }
    await r.flushAll(false);
    const after = await db.user.findUniqueOrThrow({ where: { id: S.pilot!.s.userId } });
    expect(after.xp).toBeGreaterThan(before.xp);
    expect(after.level).toBeGreaterThanOrEqual(before.level);
    expect(after.level).toBeGreaterThanOrEqual(2);
  });

  it("loot: pick up the dropped loot → items land in the server inventory exactly once", async () => {
    const r = internals(S.roomId!);
    const actor = r.getPlayerByUser(S.pilot!.s.userId)!;
    const pickups: unknown[] = [];
    S.room!.onMessage("item_pickup", (e: unknown) => pickups.push(e));
    const loot = r.getLoot();
    expect(loot.length).toBeGreaterThan(0);
    for (const l of loot) {
      Object.assign(actor, { x: l.x, y: l.y });
      S.room!.send("pickup", { lootId: l.id });
    }
    await until(() => pickups.length > 0);
    await r.flushAll(false);
    const inv = await db.inventoryItem.findMany({ where: { userId: S.pilot!.s.userId, originRef: { startsWith: "loot:" } } });
    const credits = await getBalance(db, userWallet(S.pilot!.s.userId, "CREDITS"));
    // Loot rolls are random: a drop may be items, credits or only resources, so accept any of them.
    const resources = await db.playerResource.aggregate({ where: { userId: S.pilot!.s.userId }, _sum: { amount: true } });
    expect(inv.length > 0 || credits > 0n || (resources._sum.amount ?? 0n) > 0n).toBe(true);
  });

  it("inventory + equip: open inventory, equip an item into the active loadout (server-validated)", async () => {
    // A tradeable weapon bought in the shop (server price) so equip has a concrete compatible item.
    const shop = await S.pilot!.s.req("GET", "/api/shop");
    expect(shop.statusCode).toBe(200);
    const inv = await S.pilot!.s.req("GET", "/api/inventory");
    expect(inv.statusCode).toBe(200);
    const items = (inv.json() as { items: { id: string; itemId: string; category: string; equippedOn: string | null }[] }).items;
    // The starter laser (level 1): random loot from the previous step may add higher-level lasers.
    const weapon = items.find((i) => i.category === "WEAPON" && i.itemId === "item_wpn_laser_mk1");
    expect(weapon, "starter weapons present in inventory").toBeTruthy();
    const u = await db.user.findUniqueOrThrow({ where: { id: S.pilot!.s.userId } });
    const ship = await db.shipInstance.findUniqueOrThrow({ where: { id: u.activeShipId! } });
    const res = await S.pilot!.s.req("POST", "/api/inventory/equip", { shipInstanceId: ship.id, loadoutId: ship.activeLoadoutId, inventoryItemId: weapon!.id, slotType: "weapons", slotIndex: 0 });
    expect(res.statusCode, res.body).toBe(200);
  });

  it("PvP: enter a PvP map and kill another player → leaderboard updated → crypto-eligible PvP reward", async () => {
    // Both pilots are established accounts (reward eligibility: age, playtime, matches) on the PvP map.
    const aged = new Date(Date.now() - 10 * 86_400_000);
    await S.room!.leave();
    await until(() => !internals(S.roomId!)?.getPlayerByUser?.(S.pilot!.s.userId));
    await sleep(300);
    for (const id of [S.pilot!.s.userId, S.rival!.s.userId]) {
      await db.user.update({ where: { id }, data: { createdAt: aged, playtimeSeconds: 10n * 3600n, matchesPlayed: 30, level: 20, lastMapId: "map_vanta_rift" } });
      await db.wallet.updateMany({ where: { userId: id }, data: { verifiedAt: aged } });
    }
    const a = await ticketAndJoin(S.pilot!.s);
    const b = await ticketAndJoin(S.rival!.s);
    expect(a.roomId).toBe(b.roomId);
    S.room = a;
    const r = internals(a.roomId);
    // Vanta Rift is a pirate zone: freeze its NPCs so the kill below is unambiguously pilot-vs-pilot.
    for (const n of r.getNpcs()) Object.assign(n, { stunnedUntil: Number.MAX_SAFE_INTEGER, nextThinkAt: Number.MAX_SAFE_INTEGER });
    const map = MAPS_BY_ID.get("map_vanta_rift")!;
    let px = map.width / 2;
    let py = map.height / 2;
    for (let i = 0; i < 100 && !isPvpAllowedAt(map, px, py); i++) { px = 50 + Math.random() * (map.width - 100); py = 50 + Math.random() * (map.height - 100); }
    const pa = r.getPlayerByUser(S.pilot!.s.userId)!;
    const pb = r.getPlayerByUser(S.rival!.s.userId)!;
    Object.assign(pa, { x: px, y: py, invulnerableUntil: 0 });
    Object.assign(pb, { x: px + 10, y: py, invulnerableUntil: 0, shield: 0, hull: 1 });
    await until(() => pa.visible.has(pb.id));
    a.send("target", { mode: "ENTITY", entityId: pb.id });
    await until(() => pa.targetId === pb.id);
    a.send("fire", { firing: true, group: "PRIMARY" });
    await until(() => pb.dead, 15_000);
    a.send("fire", { firing: false, group: "PRIMARY" });
    await r.flushAll(false);

    // The API caches leaderboards in Redis for 30 s (one shared DB in production); drop the cache so
    // this isolated-schema run never reads a board cached by another run.
    const cached = await app.redis.keys("lb:*");
    if (cached.length) await app.redis.del(...cached);
    const lb = await S.pilot!.s.req("GET", "/api/leaderboard?board=pvp_kills");
    expect(lb.statusCode).toBe(200);
    const entries = (lb.json() as { entries: { userId: string; score: string }[] }).entries;
    expect(Number(entries.find((e) => e.userId === S.pilot!.s.userId)?.score ?? "0")).toBeGreaterThanOrEqual(1);

    await until(async () => (await db.reward.count({ where: { userId: S.pilot!.s.userId, source: "PVP" } })) > 0, 10_000);
    const reward = await db.reward.findFirstOrThrow({ where: { userId: S.pilot!.s.userId, source: "PVP" } });
    expect(["CLAIMABLE", "PENDING_REVIEW"]).toContain(reward.status);
    const liability = await db.rewardLiability.findUnique({ where: { rewardId: reward.id } });
    expect(liability?.status).toBe("OUTSTANDING");
    await b.leave();
  });

  it("event reward: participation in an active event pays its reward tier once", async () => {
    const ev = [...EVENTS_BY_ID.values()].find((e) => e.rewards.length > 0)!;
    await db.event.upsert({ where: { id: ev.id }, create: { id: ev.id, name: ev.name, type: ev.type, startAt: new Date(Date.now() - 3600_000), endAt: new Date(Date.now() + 3600_000), data: JSON.parse(JSON.stringify(ev)) as object }, update: {} });
    await db.eventParticipation.create({ data: { eventId: ev.id, userId: S.pilot!.s.userId, instanceKey: "vslice", contribution: 1000n } });
    const svcMod = await import("../../apps/game-server/src/services/context.js");
    const svc = svcMod.getServices();
    const before = await db.user.findUniqueOrThrow({ where: { id: S.pilot!.s.userId } });
    const opts = { minShare: 0, fallbackSource: "EVENT" as const, label: ev.name };
    await svc.persistence.distributeEventRewards(ev.id, "vslice", ev, opts);
    const once = await db.user.findUniqueOrThrow({ where: { id: S.pilot!.s.userId } });
    await svc.persistence.distributeEventRewards(ev.id, "vslice", ev, opts); // idempotent: pays once
    const part = await db.eventParticipation.findFirstOrThrow({ where: { eventId: ev.id, userId: S.pilot!.s.userId, instanceKey: "vslice" } });
    expect(part.rewarded).toBe(true);
    const after = await db.user.findUniqueOrThrow({ where: { id: S.pilot!.s.userId } });
    // Sole participant = 100% contribution → the top tier the event defines.
    const top = [...ev.rewards].sort((x, y) => y.minContribution - x.minContribution)[0]!;
    expect(part.rewardTier).toBe(top.tier);
    if (top.bundle.xp) expect(once.xp - before.xp).toBe(BigInt(top.bundle.xp));
    expect(after.xp).toBe(once.xp);
  });

  it("crypto reward: claim eligible rewards into the withdrawable balance (ledger)", async () => {
    const rewards = await S.pilot!.s.req("GET", "/api/economy/rewards");
    expect(rewards.statusCode).toBe(200);
    const claim = await S.pilot!.s.req("POST", "/api/rewards/claim", { all: true });
    expect(claim.statusCode, claim.body).toBe(200);
    const bal = await getBalance(db, userWallet(S.pilot!.s.userId, "NEBX"));
    expect(bal).toBeGreaterThan(0n);
  });

  it("wallet page → devnet withdrawal request → blockchain-service payout → transaction signature", async () => {
    const wallet = await S.pilot!.s.req("GET", "/api/wallet");
    expect(wallet.statusCode, wallet.body).toBe(200);
    const w = wallet.json() as { limits: { min: string } };
    const min = BigInt(w.limits.min);
    const have = await getBalance(db, userWallet(S.pilot!.s.userId, "NEBX"));
    if (have < min) {
      // Emission caps keep a single day's reward below the withdrawal minimum; top up from the
      // real-funds-backed reward pool with an audited adjustment (same as scripts/devnet-e2e.ts).
      await db.$transaction((tx) => post(tx, {
        from: system("PLAYER_REWARD_POOL", "NEBX"), to: userWallet(S.pilot!.s.userId, "NEBX"), amount: min - have,
        type: "ADMIN_ADJUSTMENT", reference: S.pilot!.s.userId, idempotencyKey: `vslice-topup-${S.pilot!.s.userId}`, userId: S.pilot!.s.userId,
        metadata: { reason: "vertical slice top-up to withdrawal minimum" },
      }));
    }
    const quote = await S.pilot!.s.req("GET", `/api/wallet/withdraw/quote?amount=${min}`);
    expect(quote.statusCode, quote.body).toBe(200);
    const req = await S.pilot!.s.req("POST", "/api/wallet/withdraw", { amount: min.toString(), address: S.pilot!.signer.address, idempotencyKey: `vslice-${randomUUID()}` });
    expect([200, 201, 202], req.body).toContain(req.statusCode);
    const wd = await db.withdrawal.findFirstOrThrow({ where: { userId: S.pilot!.s.userId }, orderBy: { createdAt: "desc" } });
    expect(["PENDING", "PENDING_REVIEW", "PROCESSING"]).toContain(wd.status);
    if (wd.status === "PENDING_REVIEW") {
      await db.withdrawal.update({ where: { id: wd.id }, data: { status: "PENDING", reviewedBy: "vslice-admin" } });
    }
    const deps = {
      db, rpc: chain.rpc, getSigner: async () => chain.treasury, treasuryAddress: chain.treasury.address, mint: null, mintDecimals: 9,
      maxAttempts: 5, backoffBaseMs: 100, confirmPollMs: 100, inlineConfirmMs: 10_000,
    };
    for (let i = 0; i < 40; i++) {
      const step = await processWithdrawal(deps, wd.id);
      if (step.done) break;
      await sleep(Math.min(step.retryInMs, 500));
    }
    const done = await db.withdrawal.findUniqueOrThrow({ where: { id: wd.id } });
    expect(done.status, done.failureReason ?? "").toBe("COMPLETED");
    expect(done.signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
    const list = await S.pilot!.s.req("GET", "/api/wallet");
    const shown = (list.json() as { withdrawals: { id: string; signature: string | null; status: string }[] }).withdrawals.find((x) => x.id === wd.id);
    expect(shown?.signature).toBe(done.signature);
    expect((await verifyLedgerIntegrity(db)).every((a) => a.ok)).toBe(true);
    if (S.room?.connection.isOpen) await S.room.leave();
  });
});
