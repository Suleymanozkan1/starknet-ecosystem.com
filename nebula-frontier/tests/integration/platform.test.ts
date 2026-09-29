/**
 * Platform features: push delivery (mocked HTTP transport only), friend-online, clan missions &
 * territory capture, analytics writer + admin analytics.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatchPendingPush, notify } from "../../apps/api/src/lib/notify.js";
import type { HttpResponse, PushTransport } from "../../apps/api/src/lib/push.js";
import { captureTerritories } from "../../apps/api/src/lib/territory.js";
import { AnalyticsWriter } from "../../apps/api/src/lib/analytics.js";
import { verifyLedgerIntegrity } from "../../packages/database/src/index.js";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { credits, fund, registerUser, setup, teardown, type TestCtx } from "./helpers.js";

const INTERNAL = "internal-test-token-0123456789abcdef0123456789";
const sent: { url: string; body: string }[] = [];
const transport: PushTransport = {
  async post(url, _headers, body): Promise<HttpResponse> {
    if (url.includes("oauth2")) return { status: 200, body: JSON.stringify({ access_token: "ya29.test", expires_in: 3600 }) };
    sent.push({ url, body });
    const token = (JSON.parse(body) as { message: { token: string } }).message.token;
    return token === "dead-token-000000" ? { status: 404, body: '{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}' } : { status: 200, body: "{}" };
  },
  async http2Post() {
    return { status: 500, body: "unused" };
  },
};
const sa = {
  project_id: "nebula-test",
  client_email: "push@nebula-test.iam.gserviceaccount.com",
  private_key: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await setup({ pushTransport: transport, pushEnv: { FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(sa) }, env: { INTERNAL_SERVICE_TOKEN: INTERNAL } });
});
afterAll(async () => {
  await teardown(ctx);
});

type Err = { error: { code: string } };
const code = (r: { json: () => unknown }) => (r.json() as Err).error.code;
const until = async (fn: () => Promise<boolean>, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};
const sentTo = (token: string) => sent.filter((s) => s.body.includes(token));

describe("push notifications", () => {
  it("delivers push types to registered devices and marks pushedAt", async () => {
    const s = await registerUser(ctx.app);
    const token = `fcm-${randomUUID()}`;
    expect((await s.req("POST", "/api/notifications/push-token", { token, platform: "android", deviceId: `dev-${randomUUID()}` })).statusCode).toBe(200);

    await notify(ctx.db, s.userId, "AUCTION_WON", "Auction won", "You won", { auctionId: "a1" });
    expect(await until(async () => (await ctx.db.notification.count({ where: { userId: s.userId, type: "AUCTION_WON", pushedAt: { not: null } } })) === 1)).toBe(true);
    const msg = JSON.parse(sentTo(token)[0]?.body ?? "{}") as { message: { data: Record<string, string>; notification: { title: string } } };
    expect(msg.message.notification.title).toBe("Auction won");
    expect(msg.message.data.auctionId).toBe("a1");

    // Non-push types stay in-app only.
    await notify(ctx.db, s.userId, "MARKET_SOLD", "Sold", "x");
    await new Promise((r) => setTimeout(r, 200));
    expect(sentTo(token)).toHaveLength(1);

    // Written inside a transaction: delivered by the dispatcher once past the commit lag.
    await ctx.db.$transaction((tx) => notify(tx, s.userId, "REWARD_READY", "Reward ready", "Claim it"));
    const row = await ctx.db.notification.findFirstOrThrow({ where: { userId: s.userId, type: "REWARD_READY" } });
    expect(row.pushedAt).toBeNull();
    await ctx.db.notification.update({ where: { id: row.id }, data: { createdAt: new Date(Date.now() - 20_000) } });
    expect(await dispatchPendingPush()).toBeGreaterThanOrEqual(1);
    expect((await ctx.db.notification.findUniqueOrThrow({ where: { id: row.id } })).pushedAt).not.toBeNull();
    expect(sentTo(token)).toHaveLength(2);
    // Never delivered twice.
    await dispatchPendingPush();
    expect(sentTo(token)).toHaveLength(2);
  });

  it("clears invalid device tokens and does not mark the notification pushed", async () => {
    const s = await registerUser(ctx.app);
    await s.req("POST", "/api/notifications/push-token", { token: "dead-token-000000", platform: "android", deviceId: `dev-${randomUUID()}` });
    await notify(ctx.db, s.userId, "CLAN_INVITE", "Clan invitation", "join us");
    expect(await until(async () => (await ctx.db.device.count({ where: { userId: s.userId, pushToken: null } })) === 1)).toBe(true);
    const n = await ctx.db.notification.findFirstOrThrow({ where: { userId: s.userId, type: "CLAN_INVITE" } });
    expect(n.pushedAt).toBeNull();
  });

  it("notifies accepted friends when a pilot comes online (game ticket)", async () => {
    const a = await registerUser(ctx.app);
    const b = await registerUser(ctx.app);
    await a.req("POST", "/api/friends/add", { userId: b.userId });
    await b.req("POST", "/api/friends/add", { userId: a.userId });
    await b.req("POST", "/api/me/faction", { factionId: "nova" });
    expect((await b.req("POST", "/api/game/ticket", {})).statusCode).toBe(200);
    expect((await b.req("POST", "/api/game/ticket", {})).statusCode).toBe(200);
    expect(await ctx.db.notification.count({ where: { userId: a.userId, type: "FRIEND_ONLINE" } })).toBe(1);
    const friends = (await a.req("GET", "/api/friends")).json() as { friends: { id: string; online: boolean }[] };
    expect(friends.friends.find((f) => f.id === b.userId)?.online).toBe(true);
  });
});

describe("clan missions", () => {
  it("tracks targeted objectives from game-server events, completes, and pays the clan bank once", async () => {
    const leader = await registerUser(ctx.app);
    const member = await registerUser(ctx.app);
    await ctx.db.user.update({ where: { id: leader.userId }, data: { level: 12 } });
    await fund(ctx.db, leader.userId, 1_000_000n);
    const tag = `M${Math.floor(Math.random() * 9000 + 1000)}`;
    const clanId = ((await leader.req("POST", "/api/clans", { name: `Mission ${tag}`, tag })).json() as { id: string }).id;
    await leader.req("POST", `/api/clans/${clanId}/invite`, { userId: member.userId });
    await member.req("POST", `/api/clans/${clanId}/join`);

    const list = (await leader.req("GET", `/api/clans/${clanId}/missions`)).json() as { missions: { questId: string; objectives: { tracking: string; count: number }[] }[] };
    const def = list.missions.find((m) => m.questId === "q_clan_founding");
    expect(def?.objectives[0]?.tracking).toBe("GAME_EVENTS");
    expect((await member.req("POST", `/api/clans/${clanId}/missions/q_clan_founding/start`)).statusCode).toBe(403);
    const started = await leader.req("POST", `/api/clans/${clanId}/missions/q_clan_founding/start`);
    expect(started.statusCode).toBe(201);
    const missionId = (started.json() as { id: string }).id;
    expect((await leader.req("POST", `/api/clans/${clanId}/missions/q_clan_founding/start`)).statusCode).toBe(409);
    expect(code(await leader.req("POST", `/api/clans/${clanId}/missions/${missionId}/claim`))).toBe("MISSION_INCOMPLETE");

    const kill = (npcId: string) => ({ eventId: randomUUID(), userId: member.userId, event: { type: "KILL", npcId, boss: false, mapId: "map_helios_frontier" } });
    const noToken = await ctx.app.inject({ method: "POST", url: "/api/internal/clan-missions/progress", payload: { events: [kill("npc_xyrr_fighter")] } });
    expect(noToken.statusCode).toBe(401);
    // Player credentials are not accepted on internal endpoints.
    expect((await member.req("POST", "/api/internal/clan-missions/progress", { events: [kill("npc_xyrr_fighter")] })).statusCode).toBe(401);
    const post = (events: unknown[]) =>
      ctx.app.inject({ method: "POST", url: "/api/internal/clan-missions/progress", headers: { "x-internal-token": INTERNAL }, payload: { events } });
    expect((await post([kill("npc_pirate_raider"), kill("npc_pirate_raider")])).statusCode).toBe(200); // wrong target: no progress
    const batch = Array.from({ length: 29 }, () => kill("npc_xyrr_fighter"));
    expect((await post(batch)).statusCode).toBe(200);
    let m = await ctx.db.clanMission.findUniqueOrThrow({ where: { id: missionId } });
    expect(m.progress[0]).toBe(29);
    // A retried request (same event ids, e.g. response lost) is a no-op; events without an id are rejected.
    expect((await post(batch)).statusCode).toBe(200);
    expect((await post([{ userId: member.userId, event: batch[0]!.event }])).statusCode).toBe(400);
    m = await ctx.db.clanMission.findUniqueOrThrow({ where: { id: missionId } });
    expect(m.progress[0]).toBe(29);
    expect(await ctx.db.clanMissionEventReceipt.count({ where: { missionId } })).toBe(29);
    expect(m.status).toBe("ACTIVE");
    await post([kill("npc_xyrr_fighter"), kill("npc_xyrr_fighter")]);
    m = await ctx.db.clanMission.findUniqueOrThrow({ where: { id: missionId } });
    expect(m.progress[0]).toBe(30);
    expect(m.status).toBe("COMPLETED");
    expect(await ctx.db.notification.count({ where: { userId: member.userId, type: "MISSION_COMPLETE" } })).toBe(1);

    const bankBefore = (await ctx.db.clan.findUniqueOrThrow({ where: { id: clanId } })).bankCredits;
    const claims = await Promise.all([0, 1].map(() => leader.req("POST", `/api/clans/${clanId}/missions/${missionId}/claim`)));
    expect(claims.filter((c) => c.statusCode === 200)).toHaveLength(1);
    const clan = await ctx.db.clan.findUniqueOrThrow({ where: { id: clanId } });
    expect(clan.bankCredits - bankBefore).toBe(15_000n);
    expect(clan.xp).toBe(8_000n);
    // Treasury credits are withdrawable through the normal (ledger-backed) treasury flow.
    const before = await credits(ctx.db, leader.userId);
    expect((await leader.req("POST", `/api/clans/${clanId}/treasury/withdraw`, { amount: "15000", idempotencyKey: `k_${randomUUID()}` })).statusCode).toBe(200);
    expect((await credits(ctx.db, leader.userId)) - before).toBe(15_000n);
  });
});

describe("territory", () => {
  it("assigns the war map to the latest winner, idempotently", async () => {
    const a = await registerUser(ctx.app);
    const b = await registerUser(ctx.app);
    await fund(ctx.db, a.userId, 1_000_000n);
    await fund(ctx.db, b.userId, 1_000_000n);
    const mk = async (s: typeof a) => {
      const tag = `W${Math.floor(Math.random() * 9000 + 1000)}`;
      return ((await s.req("POST", "/api/clans", { name: `War ${tag}`, tag })).json() as { id: string }).id;
    };
    const clanA = await mk(a);
    const clanB = await mk(b);
    const mapId = "map_eclipse_arena";
    // Start after any war left on this map by earlier runs, from a clean ownership state.
    const last = await ctx.db.clanWar.findFirst({ where: { mapId }, orderBy: { endsAt: "desc" } });
    await ctx.db.clanTerritory.deleteMany({ where: { mapId } });
    const t0 = new Date(Math.max(Date.now(), last?.endsAt.getTime() ?? 0) + 1000);
    await ctx.db.clanWar.create({ data: { clanAId: clanA, clanBId: clanB, mapId, phase: "REWARDED", winnerId: clanA, scoreA: 5, scoreB: 1, startsAt: new Date(t0.getTime() - 60_000), endsAt: t0 } });
    expect(await captureTerritories(ctx.db)).toBeGreaterThanOrEqual(1);
    const terrA = (await ctx.app.inject({ method: "GET", url: `/api/clans/${clanA}/territory` })).json() as { territories: { mapId: string }[] };
    expect(terrA.territories.map((t) => t.mapId)).toContain(mapId);
    expect(await ctx.db.notification.count({ where: { userId: a.userId, type: "CLAN_TERRITORY_CAPTURED" } })).toBe(1);
    // Re-running is a no-op for this map.
    await captureTerritories(ctx.db);
    expect(await ctx.db.notification.count({ where: { userId: a.userId, type: "CLAN_TERRITORY_CAPTURED" } })).toBe(1);
    // A newer war won by B moves the territory.
    const t1 = new Date(t0.getTime() + 60_000);
    await ctx.db.clanWar.create({ data: { clanAId: clanA, clanBId: clanB, mapId, phase: "REWARDED", winnerId: clanB, scoreA: 1, scoreB: 9, startsAt: t0, endsAt: t1 } });
    await captureTerritories(ctx.db);
    expect((await ctx.db.clanTerritory.findUniqueOrThrow({ where: { mapId } })).clanId).toBe(clanB);
    expect(await ctx.db.notification.count({ where: { userId: a.userId, type: "CLAN_TERRITORY_LOST" } })).toBe(1);
    // A draw does not change ownership.
    await ctx.db.clanWar.create({ data: { clanAId: clanA, clanBId: clanB, mapId, phase: "REWARDED", winnerId: null, startsAt: t1, endsAt: new Date(t1.getTime() + 60_000) } });
    await captureTerritories(ctx.db);
    expect((await ctx.db.clanTerritory.findUniqueOrThrow({ where: { mapId } })).clanId).toBe(clanB);
    await ctx.db.clanTerritory.delete({ where: { mapId } });
  });
});

describe("analytics", () => {
  it("batches events into AnalyticsEvent", async () => {
    const w = new AnalyticsWriter(ctx.db, { intervalMs: 0, maxBatch: 50 });
    const tag = `T_${randomUUID()}`;
    for (let i = 0; i < 3; i++) w.track(tag, null, { i });
    expect(w.pending).toBe(3);
    await w.close();
    expect(await ctx.db.analyticsEvent.count({ where: { name: tag } })).toBe(3);
  });

  it("records API events and serves admin analytics to authorised roles only", async () => {
    const buyer = await registerUser(ctx.app);
    await fund(ctx.db, buyer.userId, 100_000n);
    expect((await buyer.req("POST", "/api/shop/purchase", { productId: "shop_ammo_hornet_500", quantity: 1, idempotencyKey: `k_${randomUUID()}` })).statusCode).toBe(200);
    await buyer.req("POST", "/api/auth/logout");
    await ctx.app.analytics.flush();
    const names = (await ctx.db.analyticsEvent.findMany({ where: { userId: buyer.userId }, select: { name: true } })).map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(["LOGIN", "PURCHASE", "LOGOUT"]));

    const plain = await registerUser(ctx.app);
    expect((await plain.req("GET", "/api/admin/analytics")).statusCode).toBe(403);
    const mgr = await registerUser(ctx.app);
    await ctx.db.adminUser.create({ data: { userId: mgr.userId, roles: ["ECONOMY_MANAGER"] } });
    const res = await mgr.req("GET", "/api/admin/analytics?days=30");
    expect(res.statusCode, res.body).toBe(200);
    const a = res.json() as {
      activeUsers: { dau: number; mau: number }; retention: { d1: { cohort: number }; d7: unknown }; sessions: { avgSessionSeconds: number | null };
      economy: { sources: Record<string, Record<string, string>>; sinks: Record<string, Record<string, string>> };
      events: Record<string, number>; shipUsage: unknown[]; weaponUsage: unknown[]; winRate: unknown[]; market: unknown[]; withdrawals: unknown[]; matches: unknown[];
      kills: { allTime: { pvp: number } };
    };
    expect(a.activeUsers.dau).toBeGreaterThanOrEqual(1);
    expect(a.activeUsers.mau).toBeGreaterThanOrEqual(a.activeUsers.dau);
    expect(a.events.LOGIN).toBeGreaterThanOrEqual(1);
    expect(a.events.PURCHASE).toBeGreaterThanOrEqual(1);
    expect(BigInt(a.economy.sinks.CREDITS?.PURCHASE ?? "0")).toBeGreaterThan(0n);
    expect(Object.keys(a.economy.sources)).toContain("CREDITS");
    for (const k of ["shipUsage", "weaponUsage", "winRate", "market", "withdrawals", "matches"] as const) expect(Array.isArray(a[k])).toBe(true);
    expect(typeof a.kills.allTime.pvp).toBe("number");
  });

  it("keeps the ledger balanced", async () => {
    for (const r of await verifyLedgerIntegrity(ctx.db)) expect(r.ok, r.asset).toBe(true);
  });
});
