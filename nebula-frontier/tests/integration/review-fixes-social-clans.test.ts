/**
 * Review fixes: clan kick/treasury authorization inside the transaction, read-only missions GET,
 * exact bigint leaderboard scores, market/auction cancel honouring MARKET_PAUSE, atomic username
 * cooldown, bounty idempotency under concurrency, chat reports escalating to moderation, and reward
 * rules formatted with the reward mint decimals.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEconomyConfig } from "../../packages/economy/src/index.js";
import { formatRewardAmount, rewardRules } from "../../apps/api/src/routes/economy.js";
import { credits, fund, giveItem, key, registerUser, setup, teardown, type Session, type TestCtx } from "./helpers.js";

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => {
  await teardown(ctx);
});

type Err = { error: { code: string } };
const code = (r: { json: () => unknown }) => (r.json() as Err).error.code;

async function makeClan(): Promise<{ leader: Session; officer: Session; recruit: Session; clanId: string }> {
  const leader = await registerUser(ctx.app);
  const officer = await registerUser(ctx.app);
  const recruit = await registerUser(ctx.app);
  await fund(ctx.db, leader.userId, 10_000_000n);
  const tag = `R${Math.floor(Math.random() * 9000 + 1000)}`;
  const created = await leader.req("POST", "/api/clans", { name: `Review ${tag}`, tag });
  expect(created.statusCode, created.body).toBe(201);
  const clanId = (created.json() as { id: string }).id;
  for (const s of [officer, recruit]) {
    expect((await leader.req("POST", `/api/clans/${clanId}/invite`, { userId: s.userId })).statusCode).toBe(200);
    expect((await s.req("POST", `/api/clans/${clanId}/join`)).statusCode).toBe(200);
  }
  expect((await leader.req("POST", `/api/clans/${clanId}/promote`, { userId: officer.userId, role: "OFFICER" })).statusCode).toBe(200);
  return { leader, officer, recruit, clanId };
}

describe("clans", () => {
  it("treasury withdrawal re-checks membership and rank inside the transaction", async () => {
    const { leader, officer, recruit, clanId } = await makeClan();
    expect((await leader.req("POST", `/api/clans/${clanId}/treasury/deposit`, { amount: "5000", idempotencyKey: key() })).statusCode).toBe(200);

    const denied = await recruit.req("POST", `/api/clans/${clanId}/treasury/withdraw`, { amount: "100", idempotencyKey: key() });
    expect(denied.statusCode).toBe(403);
    expect(code(denied)).toBe("CLAN_ROLE");

    const outsider = await registerUser(ctx.app);
    const notMember = await outsider.req("POST", `/api/clans/${clanId}/treasury/withdraw`, { amount: "100", idempotencyKey: key() });
    expect(notMember.statusCode).toBe(403);
    expect(code(notMember)).toBe("NOT_CLAN_MEMBER");

    const before = await credits(ctx.db, officer.userId);
    expect((await officer.req("POST", `/api/clans/${clanId}/treasury/withdraw`, { amount: "100", idempotencyKey: key() })).statusCode).toBe(200);
    expect((await credits(ctx.db, officer.userId)) - before).toBe(100n);

    // Demoted: no longer allowed, and the treasury is untouched.
    expect((await leader.req("POST", `/api/clans/${clanId}/promote`, { userId: officer.userId, role: "MEMBER" })).statusCode).toBe(200);
    const demoted = await officer.req("POST", `/api/clans/${clanId}/treasury/withdraw`, { amount: "100", idempotencyKey: key() });
    expect(demoted.statusCode).toBe(403);
    expect((await ctx.db.clan.findUniqueOrThrow({ where: { id: clanId } })).bankCredits).toBe(4900n);
  });

  it("kick verifies actor and target in one transaction", async () => {
    const { officer, recruit, clanId } = await makeClan();
    const byRecruit = await recruit.req("POST", `/api/clans/${clanId}/kick`, { userId: officer.userId });
    expect(byRecruit.statusCode).toBe(403);
    const outsider = await registerUser(ctx.app);
    const byOutsider = await outsider.req("POST", `/api/clans/${clanId}/kick`, { userId: recruit.userId });
    expect(code(byOutsider)).toBe("NOT_CLAN_MEMBER");
    expect((await officer.req("POST", `/api/clans/${clanId}/kick`, { userId: recruit.userId })).statusCode).toBe(200);
    expect(await ctx.db.clanMember.findUnique({ where: { userId: recruit.userId } })).toBeNull();
    const again = await officer.req("POST", `/api/clans/${clanId}/kick`, { userId: recruit.userId });
    expect(again.statusCode).toBe(404);
    expect(await ctx.db.clanMember.count({ where: { clanId } })).toBe(2);
  });

  it("GET missions is read-only (does not refresh or rewrite mission rows)", async () => {
    const { leader, clanId } = await makeClan();
    await ctx.db.user.update({ where: { id: leader.userId }, data: { level: 50 } });
    const started = await leader.req("POST", `/api/clans/${clanId}/missions/q_clan_founding/start`);
    expect(started.statusCode, started.body).toBe(201);
    const missionId = (started.json() as { id: string }).id;
    // Simulate a baseline that a refresh would rewrite (members missing from it).
    await ctx.db.clanMission.update({ where: { id: missionId }, data: { baseline: {} } });
    const r = await leader.req("GET", `/api/clans/${clanId}/missions`);
    expect(r.statusCode).toBe(200);
    const row = await ctx.db.clanMission.findUniqueOrThrow({ where: { id: missionId } });
    expect(row.baseline).toEqual({});
    expect(row.status).toBe("ACTIVE");
  });
});

describe("leaderboard", () => {
  it("returns bigint scores as exact decimal strings", async () => {
    const s = await registerUser(ctx.app);
    const big = 9_007_199_254_740_993n; // 2^53 + 1: not representable as a JS number
    await ctx.db.user.update({ where: { id: s.userId }, data: { honor: big } });
    const cached = await ctx.app.redis.keys("lb:honor:*");
    if (cached.length) await ctx.app.redis.del(...cached);
    const res = await ctx.app.inject({ method: "GET", url: "/api/leaderboard?board=honor&limit=100" });
    expect(res.statusCode).toBe(200);
    const entry = (res.json() as { entries: { userId: string; score: string }[] }).entries.find((e) => e.userId === s.userId);
    expect(entry?.score).toBe(big.toString());
    await ctx.db.user.update({ where: { id: s.userId }, data: { honor: 0n } });
  });
});

describe("market pause on cancel", () => {
  it("market and auction cancellations are blocked while MARKET_PAUSE is active", async () => {
    const s = await registerUser(ctx.app);
    await fund(ctx.db, s.userId, 1_000_000n);
    const listed = await s.req("POST", "/api/market/list", { inventoryItemId: await giveItem(ctx.db, s.userId, "item_wpn_rocket_pod"), price: "5000" });
    expect(listed.statusCode, listed.body).toBe(201);
    const listingId = (listed.json() as { listing: { id: string; name: string } }).listing.id;
    const auctioned = await s.req("POST", "/api/auctions", { inventoryItemId: await giveItem(ctx.db, s.userId, "item_wpn_rocket_pod"), startPrice: "1000" });
    expect(auctioned.statusCode, auctioned.body).toBe(201);
    const auctionId = (auctioned.json() as { auction: { id: string } }).auction.id;

    await ctx.db.circuitBreaker.upsert({ where: { mode: "MARKET_PAUSE" }, create: { mode: "MARKET_PAUSE", active: true }, update: { active: true } });
    try {
      const m = await s.req("POST", `/api/market/cancel/${listingId}`);
      expect(m.statusCode).toBe(503);
      expect(code(m)).toBe("MARKET_PAUSED");
      const a = await s.req("POST", `/api/auctions/${auctionId}/cancel`);
      expect(a.statusCode).toBe(503);
      expect(code(a)).toBe("MARKET_PAUSED");
    } finally {
      await ctx.db.circuitBreaker.update({ where: { mode: "MARKET_PAUSE" }, data: { active: false } });
    }
    expect((await s.req("POST", `/api/market/cancel/${listingId}`)).statusCode).toBe(200);
    expect((await s.req("POST", `/api/auctions/${auctionId}/cancel`)).statusCode).toBe(200);

    // Batched DTOs still resolve catalog names and per-listing inventory data.
    const mine = (await s.req("GET", "/api/market/mine")).json() as { listings: { id: string; name: string; upgradeLevel: number }[] };
    const dto = mine.listings.find((l) => l.id === listingId);
    expect(dto?.name).not.toBe("item_wpn_rocket_pod");
    expect(dto?.upgradeLevel).toBe(0);
  });
});

describe("username cooldown", () => {
  it("concurrent changes: exactly one wins; a failed change releases the reservation", async () => {
    const other = await registerUser(ctx.app);
    const otherName = `t_${randomUUID().slice(0, 8)}`;
    expect((await other.req("PATCH", "/api/me", { username: otherName })).statusCode).toBe(200);

    const s = await registerUser(ctx.app);
    // Taken name: rejected, and the cooldown is NOT consumed.
    const taken = await s.req("PATCH", "/api/me", { username: otherName.toUpperCase() });
    expect(code(taken)).toBe("USERNAME_TAKEN");
    expect(await ctx.app.redis.exists(`username:cooldown:${s.userId}`)).toBe(0);

    const results = await Promise.all([0, 1, 2].map((i) => s.req("PATCH", "/api/me", { username: `c${i}_${randomUUID().slice(0, 8)}` })));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    const rejected = results.filter((r) => r.statusCode !== 200);
    expect(rejected.every((r) => code(r) === "USERNAME_COOLDOWN")).toBe(true);
    expect(await ctx.app.redis.ttl(`username:cooldown:${s.userId}`)).toBeGreaterThan(0);
  });
});

describe("bounties", () => {
  it("concurrent requests with one idempotency key create one funded bounty", async () => {
    const hunter = await registerUser(ctx.app);
    const target = await registerUser(ctx.app);
    await fund(ctx.db, hunter.userId, 10_000_000n);
    const rules = ((await ctx.app.inject({ method: "GET", url: "/api/rules" })).json() as { rules: { bountyMin: number } }).rules;
    const amount = BigInt(rules.bountyMin);
    const before = await credits(ctx.db, hunter.userId);
    const idem = key();
    const res = await Promise.all([0, 1, 2].map(() => hunter.req("POST", "/api/bounties", { targetUserId: target.userId, amount: amount.toString(), idempotencyKey: idem })));
    for (const r of res) expect([200, 201], r.body).toContain(r.statusCode);
    const ids = new Set(res.map((r) => (r.json() as { id: string }).id));
    expect(ids.size).toBe(1);
    expect(await ctx.db.bounty.count({ where: { creatorId: hunter.userId } })).toBe(1);
    expect(before - (await credits(ctx.db, hunter.userId))).toBe(amount);
  });
});

describe("chat reports", () => {
  it("reaching the report threshold escalates to moderation instead of hiding the message", async () => {
    const author = await registerUser(ctx.app);
    const msg = await ctx.db.chatMessage.create({ data: { channel: "GLOBAL", senderId: author.userId, text: `report me ${randomUUID()}` } });
    for (let i = 0; i < 4; i++) {
      const reporter = await registerUser(ctx.app);
      expect((await reporter.req("POST", "/api/chat/report", { messageId: msg.id, reason: "abusive text" })).statusCode).toBe(200);
    }
    expect((await ctx.db.chatMessage.findUniqueOrThrow({ where: { id: msg.id } })).flagged).toBe(false);
    expect(await ctx.db.auditLog.count({ where: { action: "CHAT_REPORT_ESCALATED", targetId: msg.id } })).toBe(1);
    expect(await ctx.db.chatReport.count({ where: { messageId: msg.id, status: "OPEN" } })).toBe(4);
  });
});

describe("reward rules", () => {
  it("formats amounts with the reward mint decimals", async () => {
    expect(formatRewardAmount(1_500_000, 6, "NEBX")).toBe("1.5000 NEBX");
    expect(formatRewardAmount(1_500_000_000n, 9, "NEBX")).toBe("1.5000 NEBX");
    const cfg = await loadEconomyConfig(ctx.db);
    const six = rewardRules(cfg, 6).join("\n");
    const nine = rewardRules(cfg, 9).join("\n");
    expect(six).toContain(formatRewardAmount(cfg.caps.daily, 6, cfg.tokenomics.symbol));
    expect(nine).toContain(formatRewardAmount(cfg.caps.daily, 9, cfg.tokenomics.symbol));
  });
});
