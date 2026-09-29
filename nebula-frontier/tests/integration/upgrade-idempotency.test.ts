/**
 * Durable upgrade idempotency (independent of the Redis request cache), loadout update merging,
 * ship stats owner/lock filtering, grant originRef uniqueness, quest inactive-set semantics,
 * reward settlement outbox rows, and purchase idempotency-key reuse under concurrency.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getCatalog } from "../../apps/api/src/lib/catalog.js";
import { grantItems } from "../../apps/api/src/lib/inventory.js";
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

async function pilot(): Promise<Session> {
  const s = await registerUser(ctx.app);
  expect((await s.req("POST", "/api/me/faction", { factionId: "nova" })).statusCode).toBe(200);
  await fund(ctx.db, s.userId, 10_000_000n);
  await fund(ctx.db, s.userId, 1_000_000n, "GEMS");
  await ctx.db.playerResource.createMany({
    data: ["TITANIUM", "PLASMA_ORE", "QUANTUM_SHARD"].map((resourceId) => ({ userId: s.userId, resourceId, amount: 100_000n })),
    skipDuplicates: true,
  });
  return s;
}

async function resources(userId: string): Promise<Record<string, bigint>> {
  const rows = await ctx.db.playerResource.findMany({ where: { userId } });
  return Object.fromEntries(rows.map((r) => [r.resourceId, r.amount]));
}

describe("upgrade idempotency survives a lost Redis cache", () => {
  it("item upgrade retried with the same key neither consumes twice nor re-rolls", async () => {
    const s = await pilot();
    const itemId = await giveItem(ctx.db, s.userId, "item_wpn_laser_mk2");
    // A level with < 100% success chance, so a re-roll could change the outcome.
    await ctx.db.inventoryItem.update({ where: { id: itemId }, data: { upgradeLevel: 15 } });
    const k = key();
    const first = await s.req("POST", "/api/inventory/upgrade", { inventoryItemId: itemId, idempotencyKey: k });
    expect(first.statusCode, first.body).toBe(200);
    const r1 = first.json() as { success: boolean; toLevel: number };
    const creditsAfter = await credits(ctx.db, s.userId);
    const resAfter = await resources(s.userId);
    const levelAfter = (await ctx.db.inventoryItem.findUniqueOrThrow({ where: { id: itemId } })).upgradeLevel;

    for (let i = 0; i < 3; i++) {
      await ctx.app.redis.del(`idem:item-upgrade:${s.userId}:${k}`);
      const again = await s.req("POST", "/api/inventory/upgrade", { inventoryItemId: itemId, idempotencyKey: k });
      expect(again.statusCode).toBe(200);
      expect(again.json()).toMatchObject({ success: r1.success, toLevel: r1.toLevel, inventoryItemId: itemId });
    }
    expect(await credits(ctx.db, s.userId)).toBe(creditsAfter);
    expect(await resources(s.userId)).toEqual(resAfter);
    expect((await ctx.db.inventoryItem.findUniqueOrThrow({ where: { id: itemId } })).upgradeLevel).toBe(levelAfter);
    expect(await ctx.db.upgradeAttempt.count({ where: { userId: s.userId, kind: "ITEM" } })).toBe(1);

    // The same key cannot be reused for another item.
    const other = await giveItem(ctx.db, s.userId, "item_wpn_laser_mk2");
    await ctx.app.redis.del(`idem:item-upgrade:${s.userId}:${k}`);
    const reuse = await s.req("POST", "/api/inventory/upgrade", { inventoryItemId: other, idempotencyKey: k });
    expect(reuse.statusCode).toBe(409);
    expect(code(reuse)).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("ship upgrade retried with the same key neither consumes twice nor re-rolls", async () => {
    const s = await pilot();
    const ship = await ctx.db.shipInstance.findFirstOrThrow({ where: { userId: s.userId } });
    await ctx.db.shipInstance.update({ where: { id: ship.id }, data: { upgradeLevel: 15 } });
    const k = key();
    const first = await s.req("POST", "/api/ships/upgrade", { shipInstanceId: ship.id, idempotencyKey: k });
    expect(first.statusCode, first.body).toBe(200);
    const r1 = first.json() as { success: boolean; toLevel: number };
    const creditsAfter = await credits(ctx.db, s.userId);
    const resAfter = await resources(s.userId);
    await ctx.app.redis.del(`idem:ship-upgrade:${s.userId}:${k}`);
    const again = await s.req("POST", "/api/ships/upgrade", { shipInstanceId: ship.id, idempotencyKey: k });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ success: r1.success, toLevel: r1.toLevel, shipInstanceId: ship.id });
    expect(await credits(ctx.db, s.userId)).toBe(creditsAfter);
    expect(await resources(s.userId)).toEqual(resAfter);
    expect((await ctx.db.shipInstance.findUniqueOrThrow({ where: { id: ship.id } })).upgradeLevel).toBe(r1.toLevel);
    expect(await ctx.db.shipUpgrade.count({ where: { shipInstanceId: ship.id } })).toBe(1);
  });
});

describe("loadouts and ship stats", () => {
  it("PUT loadout only merges formation/ammo and never loses a concurrent unequip", async () => {
    const s = await pilot();
    const ship = await ctx.db.shipInstance.findFirstOrThrow({ where: { userId: s.userId } });
    const loadoutId = ship.activeLoadoutId ?? "";
    const before = (await ctx.db.shipLoadout.findUniqueOrThrow({ where: { id: loadoutId } })).config as { weapons: (string | null)[] };
    expect(before.weapons[0]).toBeTruthy();
    const [put, un] = await Promise.all([
      s.req("PUT", `/api/ships/${ship.id}/loadouts/${loadoutId}`, { formation: "ARROW" }),
      s.req("POST", "/api/inventory/unequip", { shipInstanceId: ship.id, loadoutId, slotType: "weapons", slotIndex: 0 }),
    ]);
    expect([200, 409]).toContain(put.statusCode);
    expect([200, 409]).toContain(un.statusCode);
    const after = (await ctx.db.shipLoadout.findUniqueOrThrow({ where: { id: loadoutId } })).config as { weapons: (string | null)[]; formation: string };
    if (put.statusCode === 200) expect(after.formation).toBe("ARROW");
    if (un.statusCode === 200) expect(after.weapons[0]).toBeNull();
    else expect(code(un)).toBe("CONCURRENT_UPDATE");
    if (put.statusCode === 409) expect(code(put)).toBe("CONCURRENT_UPDATE");
    // Slots other than the unequipped one are untouched by the formation update.
    expect(after.weapons.slice(1)).toEqual(before.weapons.slice(1));
  });

  it("items that are locked or no longer owned stop contributing to ship stats", async () => {
    const s = await pilot();
    const ship = await ctx.db.shipInstance.findFirstOrThrow({ where: { userId: s.userId } });
    const cfg = (await ctx.db.shipLoadout.findUniqueOrThrow({ where: { id: ship.activeLoadoutId ?? "" } })).config as { weapons: (string | null)[] };
    const equipped = cfg.weapons.filter((w): w is string => Boolean(w));
    expect(equipped.length).toBeGreaterThanOrEqual(1);
    const gear = async () => {
      await s.req("POST", "/api/ships/activate", { shipInstanceId: ship.id });
      return (await ctx.db.shipStats.findUniqueOrThrow({ where: { shipInstanceId: ship.id } })).gearScore;
    };
    const full = await gear();
    await ctx.db.inventoryItem.update({ where: { id: equipped[0]! }, data: { lockedBy: "test-escrow" } });
    const locked = await gear();
    expect(locked).toBeLessThan(full);
    await ctx.db.inventoryItem.update({ where: { id: equipped[0]! }, data: { lockedBy: null } });
    expect(await gear()).toBe(full);
    const other = await registerUser(ctx.app);
    await ctx.db.inventoryItem.update({ where: { id: equipped[0]! }, data: { userId: other.userId } });
    expect(await gear()).toBe(locked);
  });
});

describe("grantItems originRef", () => {
  it("repeated itemIds in one grant get distinct originRefs (no collision)", async () => {
    const s = await registerUser(ctx.app);
    const prefix = `test-dup:${randomUUID()}`;
    const { items } = await getCatalog(ctx.db);
    const ids = await ctx.db.$transaction((tx) =>
      grantItems(tx, s.userId, [{ itemId: "item_wpn_laser_mk2", quantity: 2 }, { itemId: "item_wpn_laser_mk2", quantity: 1 }], prefix, items),
    );
    expect(ids).toHaveLength(3);
    const refs = (await ctx.db.inventoryItem.findMany({ where: { id: { in: ids } }, select: { originRef: true } })).map((r) => r.originRef).sort();
    expect(refs).toEqual([0, 1, 2].map((n) => `${prefix}:item_wpn_laser_mk2:${n}`));
  });
});

describe("quests inactive set", () => {
  it("excludes quests explicitly marked inactive, keeps the rest", async () => {
    const s = await registerUser(ctx.app);
    await ctx.db.user.update({ where: { id: s.userId }, data: { level: 40 } });
    const qid = "q_weekly_colossus";
    const listed = async () => ((await s.req("GET", "/api/quests")).json() as { available: { questId: string }[] }).available.map((q) => q.questId);
    expect(await listed()).toContain(qid);
    await ctx.db.quest.update({ where: { id: qid }, data: { active: false } });
    try {
      const ids = await listed();
      expect(ids).not.toContain(qid);
      expect(ids).toContain("q_daily_mining");
      const acc = await s.req("POST", "/api/quests/accept", { questId: qid });
      expect(code(acc)).toBe("QUEST_DISABLED");
    } finally {
      await ctx.db.quest.update({ where: { id: qid }, data: { active: true } });
    }
  });
});

describe("reward settlement outbox", () => {
  it("a crypto-eligible achievement claim writes and settles an outbox row", async () => {
    const s = await registerUser(ctx.app);
    await ctx.db.userAchievement.create({ data: { userId: s.userId, achievementId: "ach_pvp_wins_50" } });
    const claim = await s.req("POST", "/api/achievements/ach_pvp_wins_50/claim");
    expect(claim.statusCode).toBe(200);
    const rows = await ctx.db.rewardSettlement.findMany({ where: { userId: s.userId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "ACHIEVEMENT", sourceRef: "ach:ach_pvp_wins_50", status: "DONE", attempts: 1 });
    expect(rows[0]!.result).toBeTruthy();
  });
});

describe("purchase idempotency", () => {
  it("concurrent reuse of a key with a different quantity is a conflict, never a silent duplicate", async () => {
    const s = await registerUser(ctx.app);
    await fund(ctx.db, s.userId, 1_000_000n);
    await ctx.db.user.update({ where: { id: s.userId }, data: { level: 10 } });
    const k = key();
    const [a, b] = await Promise.all([
      s.req("POST", "/api/shop/purchase", { productId: "shop_part_plating", quantity: 1, idempotencyKey: k }),
      s.req("POST", "/api/shop/purchase", { productId: "shop_part_plating", quantity: 2, idempotencyKey: k }),
    ]);
    const statuses = [a.statusCode, b.statusCode].sort();
    expect(statuses, `${a.body} ${b.body}`).toEqual([200, 409]);
    const loser = a.statusCode === 409 ? a : b;
    expect(code(loser)).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await ctx.db.purchase.count({ where: { userId: s.userId } })).toBe(1);
  });
});
