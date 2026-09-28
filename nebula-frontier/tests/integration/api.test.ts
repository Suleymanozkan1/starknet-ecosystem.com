/**
 * Gameplay REST flows: quests, crafting, ships/loadouts/upgrades, clans + treasury, social,
 * mail/achievement/battle-pass idempotent claims, bounties, world data, feature flags, admin CRUD.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyGameTicket } from "../../packages/authentication/src/index.js";
import { WEAPONS_BY_ID } from "../../packages/config/src/index.js";
import { credits, fund, giveItem, key, registerUser, setup, teardown, type TestCtx } from "./helpers.js";

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => {
  await teardown(ctx);
});

type Err = { error: { code: string } };
const code = (r: { json: () => unknown }) => (r.json() as Err).error.code;

describe("world & public data", () => {
  it("serves galaxy, maps, seasons, events, factions, leaderboards, shop, rules", async () => {
    for (const url of ["/api/galaxy", "/api/maps", "/api/seasons", "/api/events", "/api/factions", "/api/shop", "/api/rules", "/api/gates", "/api/market", "/api/auctions", "/api/bounties", "/api/clans/ranking"]) {
      const r = await ctx.app.inject({ method: "GET", url });
      expect(r.statusCode, url).toBe(200);
    }
    for (const board of ["pvp_kills", "npc_kills", "honor", "season_score", "faction", "clan"]) {
      const r = await ctx.app.inject({ method: "GET", url: `/api/leaderboard?board=${board}` });
      expect(r.statusCode, board).toBe(200);
    }
    const s = await registerUser(ctx.app);
    const own = await s.req("GET", "/api/profile");
    expect(own.statusCode).toBe(200);
    const pub = await ctx.app.inject({ method: "GET", url: `/api/profile/${s.userId}` });
    expect((pub.json() as { id: string; username: string }).id).toBe(s.userId);
    expect(JSON.stringify(pub.json())).not.toContain("@test.local");
    expect((await ctx.app.inject({ method: "GET", url: "/api/profile" })).statusCode).toBe(404);
    const seasons = (await ctx.app.inject({ method: "GET", url: "/api/seasons" })).json() as { seasons: { id: string; active: boolean }[] };
    expect(seasons.seasons.find((s) => s.id === "season_1")).toBeDefined();
  });
});

describe("pilot progression", () => {
  it("reserves the bot_ username namespace on register and rename", async () => {
    const tag = randomUUID().replace(/-/g, "").slice(0, 10);
    for (const username of [`bot_${tag}`, `BOT_${tag}`]) {
      const r = await ctx.app.inject({ method: "POST", url: "/api/auth/register", payload: { email: `r_${tag}_${username.slice(0, 1)}@test.local`, password: "correct-horse-42", username } });
      expect(r.statusCode, username).toBe(400);
    }
    const s = await registerUser(ctx.app);
    expect((await s.req("PATCH", "/api/me", { username: `bot_${tag}` })).statusCode).toBe(400);
    expect((await ctx.db.user.findUniqueOrThrow({ where: { id: s.userId } })).username.startsWith("bot_")).toBe(false);
  });

  it("game ticket is a valid 60s JWT for the server-chosen map", async () => {
    const s = await registerUser(ctx.app);
    await s.req("POST", "/api/me/faction", { factionId: "vortex" });
    const t = (await s.req("POST", "/api/game/ticket", { mapId: "map_vanta_rift" })).json() as { ticket: string; mapId: string };
    expect(t.mapId).toBe("map_vortex_haven");
    const claims = await verifyGameTicket(t.ticket, process.env.GAME_TICKET_SECRET ?? "");
    expect(claims.sub).toBe(s.userId);
    expect(claims.mapId).toBe("map_vortex_haven");
  });

  it("quests: accept, cannot claim incomplete, claim once after server progress", async () => {
    const s = await registerUser(ctx.app);
    await s.req("POST", "/api/me/faction", { factionId: "aurora" });
    const list = (await s.req("GET", "/api/quests")).json() as { available: { questId: string }[] };
    expect(list.available.some((q) => q.questId === "q_main_1_1")).toBe(true);
    const acc = await s.req("POST", "/api/quests/accept", { questId: "q_main_1_1" });
    expect(acc.statusCode).toBe(200);
    const uq = await ctx.db.userQuest.findFirstOrThrow({ where: { userId: s.userId, questId: "q_main_1_1" } });
    const early = await s.req("POST", "/api/quests/claim", { userQuestId: uq.id });
    expect(early.statusCode).toBe(400);
    expect(code(early)).toBe("QUEST_INCOMPLETE");
    // Game server records progress.
    await ctx.db.userQuest.update({ where: { id: uq.id }, data: { progress: [5] } });
    const before = await credits(ctx.db, s.userId);
    const claims = await Promise.all([0, 1, 2].map(() => s.req("POST", "/api/quests/claim", { userQuestId: uq.id })));
    expect(claims.filter((c) => c.statusCode === 200)).toHaveLength(1);
    expect((await credits(ctx.db, s.userId)) - before).toBe(2000n);
    const kits = await ctx.db.inventoryItem.aggregate({ where: { userId: s.userId, itemId: "item_repair_kit" }, _sum: { quantity: true } });
    expect(kits._sum.quantity).toBe(3);
    // Another user cannot claim it.
    const other = await registerUser(ctx.app);
    expect((await other.req("POST", "/api/quests/claim", { userQuestId: uq.id })).statusCode).toBe(404);
  });

  it("crafting: consumes costs, refuses early claim, claims exactly once", async () => {
    const s = await registerUser(ctx.app);
    await ctx.db.user.update({ where: { id: s.userId }, data: { level: 10 } });
    await fund(ctx.db, s.userId, 50_000n);
    await ctx.db.playerResource.createMany({ data: [{ userId: s.userId, resourceId: "TITANIUM", amount: 100n }, { userId: s.userId, resourceId: "PLASMA_ORE", amount: 30n }] });
    const start = await s.req("POST", "/api/crafting/start", { blueprintId: "bp_laser_mk2", idempotencyKey: key() });
    expect(start.statusCode).toBe(200);
    const job = start.json() as { id: string };
    expect(await credits(ctx.db, s.userId)).toBe(38_000n);
    const ti = await ctx.db.playerResource.findUniqueOrThrow({ where: { userId_resourceId: { userId: s.userId, resourceId: "TITANIUM" } } });
    expect(ti.amount).toBe(40n);
    const early = await s.req("POST", `/api/crafting/${job.id}/claim`);
    expect(code(early)).toBe("NOT_READY");
    await ctx.db.craftJob.update({ where: { id: job.id }, data: { completesAt: new Date(Date.now() - 1000) } });
    const claims = await Promise.all([0, 1].map(() => s.req("POST", `/api/crafting/${job.id}/claim`)));
    expect(claims.filter((c) => c.statusCode === 200)).toHaveLength(1);
    expect(await ctx.db.inventoryItem.count({ where: { userId: s.userId, itemId: "item_wpn_laser_mk2" } })).toBe(1);
    // Not enough resources for a second craft -> nothing charged.
    const again = await s.req("POST", "/api/crafting/start", { blueprintId: "bp_laser_mk2", idempotencyKey: key() });
    expect(again.statusCode).toBe(400);
    expect(await credits(ctx.db, s.userId)).toBe(38_000n);
  });

  it("ships: upgrade consumes costs server-side, loadouts CRUD, unlock via shop", async () => {
    const s = await registerUser(ctx.app);
    await s.req("POST", "/api/me/faction", { factionId: "nova" });
    await fund(ctx.db, s.userId, 1_000_000n);
    await ctx.db.playerResource.createMany({ data: [{ userId: s.userId, resourceId: "TITANIUM", amount: 1000n }, { userId: s.userId, resourceId: "PLASMA_ORE", amount: 1000n }, { userId: s.userId, resourceId: "QUANTUM_SHARD", amount: 1000n }] });
    const ship = await ctx.db.shipInstance.findFirstOrThrow({ where: { userId: s.userId } });
    const k = key();
    const up = await s.req("POST", "/api/ships/upgrade", { shipInstanceId: ship.id, idempotencyKey: k });
    expect(up.statusCode).toBe(200);
    const body = up.json() as { success: boolean; cost: { credits: number } };
    expect(body.success).toBe(true); // +0 -> +1 has 100% success chance in progression.json
    const replay = await s.req("POST", "/api/ships/upgrade", { shipInstanceId: ship.id, idempotencyKey: k });
    expect((replay.json() as { toLevel: number }).toLevel).toBe(1);
    expect((await ctx.db.shipInstance.findUniqueOrThrow({ where: { id: ship.id } })).upgradeLevel).toBe(1);
    expect(await credits(ctx.db, s.userId)).toBe(1_000_000n - BigInt(body.cost.credits));

    // Unequip + re-equip a starter laser (server validates slot family / index / ownership).
    const laser = (await ctx.db.shipLoadout.findUniqueOrThrow({ where: { id: ship.activeLoadoutId ?? "" } })).config as { weapons: string[] };
    const un = await s.req("POST", "/api/inventory/unequip", { shipInstanceId: ship.id, loadoutId: ship.activeLoadoutId, slotType: "weapons", slotIndex: 0 });
    expect(un.statusCode).toBe(200);
    const wrongSlot = await s.req("POST", "/api/inventory/equip", { shipInstanceId: ship.id, loadoutId: ship.activeLoadoutId, inventoryItemId: laser.weapons[0], slotType: "drones", slotIndex: 0 });
    expect(code(wrongSlot)).toBe("INCOMPATIBLE_SLOT");
    const outOfRange = await s.req("POST", "/api/inventory/equip", { shipInstanceId: ship.id, loadoutId: ship.activeLoadoutId, inventoryItemId: laser.weapons[0], slotType: "weapons", slotIndex: 9 });
    expect(code(outOfRange)).toBe("INVALID_SLOT");
    const re = await s.req("POST", "/api/inventory/equip", { shipInstanceId: ship.id, loadoutId: ship.activeLoadoutId, inventoryItemId: laser.weapons[0], slotType: "weapons", slotIndex: 0 });
    expect(re.statusCode).toBe(200);

    const lo = await s.req("POST", `/api/ships/${ship.id}/loadouts`, { name: "PvP", preset: "PVP", copyFromLoadoutId: ship.activeLoadoutId });
    expect(lo.statusCode).toBe(200);
    const loId = (lo.json() as { id: string; weapons: (string | null)[] }).id;
    expect((await s.req("PUT", `/api/ships/${ship.id}/loadouts/${loId}`, { formation: "ARROW" })).statusCode).toBe(200);
    expect((await s.req("POST", `/api/ships/${ship.id}/loadouts/${loId}/activate`)).statusCode).toBe(200);
    expect((await s.req("DELETE", `/api/ships/${ship.id}/loadouts/${loId}`)).statusCode).toBe(400);

    await ctx.db.user.update({ where: { id: s.userId }, data: { level: 5 } });
    const unlock = await s.req("POST", "/api/ships/unlock", { shipId: "ship_wisp", idempotencyKey: key() });
    expect(unlock.statusCode).toBe(200);
    const dup = await s.req("POST", "/api/ships/unlock", { shipId: "ship_wisp", idempotencyKey: key() });
    expect(dup.statusCode).toBe(409);
    const inv = await s.req("GET", "/api/inventory?sort=rarity");
    expect(inv.statusCode).toBe(200);
    expect((inv.json() as { items: unknown[]; capacity: number }).capacity).toBeGreaterThan(0);
  });
});

describe("clans", () => {
  it("create, invite/join, role authorization and treasury", async () => {
    const leader = await registerUser(ctx.app);
    const member = await registerUser(ctx.app);
    const outsider = await registerUser(ctx.app);
    await fund(ctx.db, leader.userId, 1_000_000n);
    await fund(ctx.db, member.userId, 10_000n);
    const tag = `T${Math.floor(Math.random() * 9000 + 1000)}`;
    const created = await leader.req("POST", "/api/clans", { name: `Clan ${tag}`, tag });
    expect(created.statusCode).toBe(201);
    const clanId = (created.json() as { id: string }).id;
    const cost = (await ctx.app.inject({ method: "GET", url: "/api/rules" })).json() as { rules: { clanCreateCost: number } };
    expect(await credits(ctx.db, leader.userId)).toBe(1_000_000n - BigInt(cost.rules.clanCreateCost));

    expect((await member.req("POST", `/api/clans/${clanId}/join`)).statusCode).toBe(403);
    expect((await leader.req("POST", `/api/clans/${clanId}/invite`, { userId: member.userId })).statusCode).toBe(200);
    expect((await member.req("POST", `/api/clans/${clanId}/join`)).statusCode).toBe(200);
    // Recruits cannot invite, kick or withdraw.
    expect((await member.req("POST", `/api/clans/${clanId}/invite`, { userId: outsider.userId })).statusCode).toBe(403);
    expect((await member.req("POST", `/api/clans/${clanId}/kick`, { userId: leader.userId })).statusCode).toBe(403);
    const dk = key();
    expect((await member.req("POST", `/api/clans/${clanId}/treasury/deposit`, { amount: "5000", idempotencyKey: dk })).statusCode).toBe(200);
    expect(((await member.req("POST", `/api/clans/${clanId}/treasury/deposit`, { amount: "5000", idempotencyKey: dk })).json() as { duplicate: boolean }).duplicate).toBe(true);
    expect(await credits(ctx.db, member.userId)).toBe(5_000n);
    expect((await member.req("POST", `/api/clans/${clanId}/treasury/withdraw`, { amount: "100", idempotencyKey: key() })).statusCode).toBe(403);
    const over = await leader.req("POST", `/api/clans/${clanId}/treasury/withdraw`, { amount: "999999", idempotencyKey: key() });
    expect(code(over)).toBe("INSUFFICIENT_TREASURY");
    expect((await leader.req("POST", `/api/clans/${clanId}/treasury/withdraw`, { amount: "1000", idempotencyKey: key() })).statusCode).toBe(200);
    expect((await ctx.db.clan.findUniqueOrThrow({ where: { id: clanId } })).bankCredits).toBe(4_000n);
    // Promotion rules.
    expect((await leader.req("POST", `/api/clans/${clanId}/promote`, { userId: member.userId, role: "OFFICER" })).statusCode).toBe(200);
    expect((await member.req("POST", `/api/clans/${clanId}/promote`, { userId: leader.userId, role: "MEMBER" })).statusCode).toBe(403);
    expect((await member.req("PATCH", `/api/clans/${clanId}/announcement`, { announcement: "Raid at 20:00" })).statusCode).toBe(200);
    // Outsider cannot see the treasury.
    const view = (await outsider.req("GET", `/api/clans/${clanId}`)).json() as { treasury: string | null };
    expect(view.treasury).toBeNull();
    // Leader cannot leave while others remain.
    expect((await leader.req("POST", "/api/clans/leave")).statusCode).toBe(400);
  });
});

describe("social", () => {
  it("friends, squads, notifications, chat report, bounty escrow", async () => {
    const a = await registerUser(ctx.app);
    const b = await registerUser(ctx.app);
    expect(((await a.req("POST", "/api/friends/add", { userId: b.userId })).json() as { status: string }).status).toBe("PENDING");
    expect(((await b.req("POST", "/api/friends/add", { userId: a.userId })).json() as { status: string }).status).toBe("ACCEPTED");
    await ctx.app.redis.set(`presence:${b.userId}`, "1", "EX", 30);
    const friends = (await a.req("GET", "/api/friends")).json() as { friends: { id: string; online: boolean }[] };
    expect(friends.friends.find((f) => f.id === b.userId)?.online).toBe(true);

    expect((await a.req("POST", "/api/squad")).statusCode).toBe(201);
    const squad = (await a.req("GET", "/api/squad")).json() as { squad: { id: string } };
    expect((await b.req("POST", `/api/squad/${squad.squad.id}/join`)).statusCode).toBe(403);
    await a.req("POST", "/api/squad/invite", { userId: b.userId });
    expect((await b.req("POST", `/api/squad/${squad.squad.id}/join`)).statusCode).toBe(200);

    const notes = (await b.req("GET", "/api/notifications")).json() as { unread: number };
    expect(notes.unread).toBeGreaterThan(0);
    expect(((await b.req("POST", "/api/notifications/read", { all: true })).json() as { updated: number }).updated).toBeGreaterThan(0);

    const msg = await ctx.db.chatMessage.create({ data: { channel: "GLOBAL", senderId: a.userId, text: "hello" } });
    expect((await b.req("POST", "/api/chat/report", { messageId: msg.id, reason: "spam test" })).statusCode).toBe(200);
    expect(((await b.req("POST", "/api/chat/report", { messageId: msg.id, reason: "spam test" })).json() as { duplicate: boolean }).duplicate).toBe(true);
    const hist = (await a.req("GET", "/api/chat/history?channel=GLOBAL&limit=5")).json() as { messages: unknown[] };
    expect(hist.messages.length).toBeGreaterThan(0);
    expect((await a.req("GET", "/api/chat/history?channel=CLAN")).statusCode).toBe(403);

    await fund(ctx.db, a.userId, 50_000n);
    const bk = key();
    expect((await a.req("POST", "/api/bounties", { targetUserId: b.userId, amount: "20000", idempotencyKey: bk })).statusCode).toBe(201);
    expect(((await a.req("POST", "/api/bounties", { targetUserId: b.userId, amount: "20000", idempotencyKey: bk })).json() as { duplicate: boolean }).duplicate).toBe(true);
    expect(await credits(ctx.db, a.userId)).toBe(30_000n);
    expect((await a.req("POST", "/api/bounties", { targetUserId: a.userId, amount: "20000", idempotencyKey: key() })).statusCode).toBe(400);
  });
});

describe("claims", () => {
  it("mail attachments are claimed exactly once", async () => {
    const s = await registerUser(ctx.app);
    const mail = await ctx.db.mail.create({ data: { toUserId: s.userId, system: true, subject: "Compensation", body: "Sorry", attachments: { credits: 1234, items: [{ itemId: "item_repair_kit", quantity: 2 }] } } });
    const results = await Promise.all([0, 1, 2].map(() => s.req("POST", `/api/mail/${mail.id}/claim`)));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(await credits(ctx.db, s.userId)).toBe(1234n);
    const other = await registerUser(ctx.app);
    expect((await other.req("POST", `/api/mail/${mail.id}/claim`)).statusCode).toBe(404);
  });

  it("achievements unlock from server stats and claim once", async () => {
    const s = await registerUser(ctx.app);
    await ctx.db.playerStat.update({ where: { userId: s.userId }, data: { npcKills: 1 } });
    const list = (await s.req("GET", "/api/achievements")).json() as { achievements: { id: string; unlocked: boolean }[] };
    expect(list.achievements.find((a) => a.id === "ach_first_kill")?.unlocked).toBe(true);
    const claims = await Promise.all([0, 1].map(() => s.req("POST", "/api/achievements/ach_first_kill/claim")));
    expect(claims.filter((c) => c.statusCode === 200)).toHaveLength(1);
    expect(await credits(ctx.db, s.userId)).toBe(1000n);
  });

  it("battle pass: premium purchase with gems, tier claims once per track", async () => {
    const s = await registerUser(ctx.app);
    await fund(ctx.db, s.userId, 5_000n, "GEMS");
    const bp = (await s.req("GET", "/api/battlepass")).json() as { active: boolean; premiumProductId: string; pass: { tiers: { tier: number; xpRequired: number; free?: unknown; premium?: unknown }[] } };
    expect(bp.active).toBe(true);
    const buy = await s.req("POST", "/api/shop/purchase", { productId: bp.premiumProductId, quantity: 1, idempotencyKey: key() });
    expect(buy.statusCode).toBe(200);
    const second = await s.req("POST", "/api/shop/purchase", { productId: bp.premiumProductId, quantity: 1, idempotencyKey: key() });
    expect(["PURCHASE_LIMIT", "ALREADY_OWNED"]).toContain(code(second));
    const tier2 = bp.pass.tiers[1]!;
    const locked = await s.req("POST", "/api/battlepass/claim", { tier: 2, track: "free" });
    expect(code(locked)).toBe("TIER_LOCKED");
    const row = await ctx.db.battlePass.findFirstOrThrow({ where: { userId: s.userId } });
    await ctx.db.battlePass.update({ where: { id: row.id }, data: { xp: tier2.xpRequired, tier: 2 } });
    const claims = await Promise.all([0, 1, 2].map(() => s.req("POST", "/api/battlepass/claim", { tier: 2, track: "free" })));
    expect(claims.filter((c) => c.statusCode === 200)).toHaveLength(1);
    expect((await s.req("POST", "/api/battlepass/claim", { tier: 1, track: "premium" })).statusCode).toBe(200);
  });
});

describe("feature flags & admin", () => {
  it("crypto-priced listings require the marketplace_crypto feature", async () => {
    const s = await registerUser(ctx.app);
    const item = await giveItem(ctx.db, s.userId, "item_wpn_ion_cannon");
    await ctx.db.featureFlag.upsert({ where: { key: "marketplace_crypto" }, create: { key: "marketplace_crypto", enabled: false }, update: {} });
    const res = await s.req("POST", "/api/market/list", { inventoryItemId: item, price: "1000000", currency: "NEBX" });
    expect(res.statusCode).toBe(403);
    expect(["FEATURE_DISABLED", "FEATURE_RESTRICTED"]).toContain(code(res));
  });

  it("economy managers can manage shop products; changes are audited", async () => {
    const mgr = await registerUser(ctx.app);
    await ctx.db.adminUser.create({ data: { userId: mgr.userId, roles: ["ECONOMY_MANAGER"] } });
    const id = `shop_test_${Date.now()}`;
    const create = await mgr.req("POST", "/api/admin/shop/products", {
      id, sku: `sku_test_${Date.now()}`, name: "Test pack", category: "AMMO", description: "t", currency: "CREDITS", price: "100",
      grants: { items: [{ itemId: "item_ammo_hornet", quantity: 10 }] }, reason: "integration test",
    });
    expect(create.statusCode, create.body).toBe(201);
    const patch = await mgr.req("PATCH", `/api/admin/shop/products/${id}`, { price: "150", reason: "price tune" });
    expect(patch.statusCode).toBe(200);
    expect((await ctx.db.shopProduct.findUniqueOrThrow({ where: { id } })).price).toBe(150n);
    expect(await ctx.db.auditLog.count({ where: { targetId: id, actorId: mgr.userId } })).toBe(2);
    // ECONOMY_MANAGER cannot ban users or edit feature flags.
    expect((await mgr.req("POST", `/api/admin/users/${mgr.userId}/ban`, { reason: "nope" })).statusCode).toBe(403);
    expect((await mgr.req("PUT", "/api/admin/feature-flags/wallet", { enabled: false, reason: "nope" })).statusCode).toBe(403);
    await ctx.db.shopProduct.update({ where: { id }, data: { active: false } });
  });

  it("super admin endpoints respond and every mutation is audited", async () => {
    const root = await registerUser(ctx.app);
    await ctx.db.adminUser.create({ data: { userId: root.userId, roles: ["SUPER_ADMIN"] } });
    const target = await registerUser(ctx.app);
    const gets = ["/api/admin/users?q=t_", `/api/admin/users/${target.userId}`, "/api/admin/risk", "/api/admin/reports", "/api/admin/audit?limit=5",
      "/api/admin/events", "/api/admin/feature-flags", "/api/admin/rules", "/api/admin/shop/products"];
    for (const url of gets) expect((await root.req("GET", url)).statusCode, url).toBe(200);
    const detail = (await root.req("GET", `/api/admin/users/${target.userId}`)).json() as { user: Record<string, unknown> };
    expect(detail.user.passwordHash).toBeUndefined();
    const muts: [string, string, unknown][] = [
      ["PUT", "/api/admin/events", { id: `evt_test_${Date.now()}`, name: "Test", type: "SPECIAL_EVENT", startAt: new Date().toISOString(), endAt: new Date(Date.now() + 3600_000).toISOString(), reason: "qa window" }],
      ["PUT", "/api/admin/catalog/weapon/wpn_laser_mk2", { data: { damage: 999 }, reason: "balance test" }],
      ["PUT", "/api/admin/feature-flags/nft_mint", { enabled: false, rules: { denyCountries: ["KP"] }, reason: "compliance" }],
      ["PUT", "/api/admin/rules", { rules: { bountyMin: 10000 }, reason: "same value" }],
      ["POST", "/api/admin/mail", { toUserId: target.userId, subject: "Hi", body: "Gift", attachments: { credits: 10 }, reason: "support ticket 42" }],
      ["PUT", `/api/admin/users/${target.userId}/roles`, { roles: ["SUPPORT"], reason: "hired" }],
    ];
    for (const [m, url, body] of muts) {
      const r = await root.req(m as "PUT" | "POST", url, body);
      expect(r.statusCode, `${m} ${url} ${r.body}`).toBeLessThan(300);
    }
    // Restore the catalog override.
    const wpn = await ctx.db.weapon.findUniqueOrThrow({ where: { id: "wpn_laser_mk2" } });
    await ctx.db.weapon.update({ where: { id: wpn.id }, data: { data: JSON.parse(JSON.stringify(WEAPONS_BY_ID.get("wpn_laser_mk2"))) } });
    const audits = await ctx.db.auditLog.count({ where: { actorId: root.userId } });
    expect(audits).toBeGreaterThanOrEqual(muts.length);
    const bad = await root.req("PUT", "/api/admin/rules", { rules: { notARule: 1 }, reason: "invalid" });
    expect(bad.statusCode).toBe(400);
  });
});
