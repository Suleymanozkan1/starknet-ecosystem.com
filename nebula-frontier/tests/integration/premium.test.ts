/**
 * PREM-01 premium tiers (FREE / VIP / ELITE) through the real shop purchase route:
 * tier + expiry, extension on re-purchase, idempotency per purchase key, tier precedence,
 * and that premium only grants convenience perks (no crypto / investment side effects).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ECONOMY } from "../../packages/config/src/index.js";
import { credits, fund, key, registerUser, setup, teardown, type Session, type TestCtx } from "./helpers.js";

let ctx: TestCtx;
let vipId = "";
let eliteId = "";
const DAY_MS = 86_400_000;

beforeAll(async () => {
  ctx = await setup();
  const shop = (await ctx.app.inject({ method: "GET", url: "/api/shop" })).json() as {
    products: { id: string; sku: string; category: string; currency: string; description: string; grants: { premium?: { tier: string; days: number } } }[];
  };
  const vip = shop.products.find((p) => p.sku === "sku_premium_vip_30");
  const elite = shop.products.find((p) => p.sku === "sku_premium_elite_30");
  if (!vip || !elite) throw new Error("premium SKUs are not seeded in the shop");
  expect(vip.grants.premium).toEqual({ tier: "VIP", days: 30 });
  expect(elite.grants.premium).toEqual({ tier: "ELITE", days: 30 });
  vipId = vip.id;
  eliteId = elite.id;
});
afterAll(async () => {
  await teardown(ctx);
});

type Me = { premiumTier: string; premiumUntil: string | null; xp: number; balances: { credits: string; gems: string; nebx: string; pendingRewards: string } };
const me = async (s: Session) => (await s.req("GET", "/api/me")).json() as Me;
const capacity = async (s: Session) => ((await s.req("GET", "/api/inventory")).json() as { capacity: number }).capacity;
const premiumUntilMs = async (userId: string) => (await ctx.db.user.findUniqueOrThrow({ where: { id: userId } })).premiumUntil?.getTime() ?? 0;
const buy = (s: Session, productId: string, idempotencyKey = key(), quantity = 1) => s.req("POST", "/api/shop/purchase", { productId, quantity, idempotencyKey });

describe("PREM-01 premium tiers", () => {
  it("VIP purchase sets tier + 30d expiry, extends on re-purchase and is idempotent per key", async () => {
    const s = await registerUser(ctx.app);
    await fund(ctx.db, s.userId, 5_000n, "GEMS");
    const before = await me(s);
    expect(before.premiumTier).toBe("FREE");
    expect(before.premiumUntil).toBeNull();
    expect(await capacity(s)).toBe(ECONOMY.premium.FREE.inventorySlots);

    const k1 = key();
    const t0 = Date.now();
    const first = await buy(s, vipId, k1);
    expect(first.statusCode, first.body).toBe(200);
    expect((first.json() as { duplicate: boolean }).duplicate).toBe(false);
    const until1 = await premiumUntilMs(s.userId);
    expect(until1).toBeGreaterThanOrEqual(t0 + 30 * DAY_MS);
    expect(until1).toBeLessThanOrEqual(Date.now() + 30 * DAY_MS);
    const after1 = await me(s);
    expect(after1.premiumTier).toBe("VIP");
    expect(after1.premiumUntil).toBe(new Date(until1).toISOString());
    expect(await credits(ctx.db, s.userId, "GEMS")).toBe(4_500n);

    // Replaying the same purchase key neither charges nor extends.
    const replay = await buy(s, vipId, k1);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ duplicate: true, purchaseId: (first.json() as { purchaseId: string }).purchaseId });
    expect(await premiumUntilMs(s.userId)).toBe(until1);
    expect(await credits(ctx.db, s.userId, "GEMS")).toBe(4_500n);
    expect(await ctx.db.purchase.count({ where: { userId: s.userId, productId: vipId } })).toBe(1);

    // Concurrent duplicates of one new key: exactly one charge / extension.
    const k2 = key();
    const par = await Promise.all([0, 1, 2].map(() => buy(s, vipId, k2)));
    expect(par.every((r) => r.statusCode === 200)).toBe(true);
    expect(par.filter((r) => !(r.json() as { duplicate: boolean }).duplicate)).toHaveLength(1);
    expect(await premiumUntilMs(s.userId)).toBe(until1 + 30 * DAY_MS); // stacked on the remaining time
    expect(await credits(ctx.db, s.userId, "GEMS")).toBe(4_000n);
    expect((await me(s)).premiumTier).toBe("VIP");

    // A purchase key cannot be reused for another product; premium is single-quantity.
    const reused = await buy(s, eliteId, k1);
    expect(reused.statusCode).toBe(409);
    expect((reused.json() as { error: { code: string } }).error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    const multi = await buy(s, vipId, key(), 2);
    expect(multi.statusCode).toBe(400);
    expect((multi.json() as { error: { code: string } }).error.code).toBe("INVALID_QUANTITY");
    expect(await credits(ctx.db, s.userId, "GEMS")).toBe(4_000n);
  });

  it("ELITE upgrades an active VIP, and a later VIP purchase extends without downgrading", async () => {
    const s = await registerUser(ctx.app);
    await fund(ctx.db, s.userId, 5_000n, "GEMS");
    expect((await buy(s, vipId)).statusCode).toBe(200);
    const vipUntil = await premiumUntilMs(s.userId);
    expect((await buy(s, eliteId)).statusCode).toBe(200);
    expect((await me(s)).premiumTier).toBe("ELITE");
    expect(await premiumUntilMs(s.userId)).toBe(vipUntil + 30 * DAY_MS);
    expect(await capacity(s)).toBe(ECONOMY.premium.ELITE.inventorySlots);

    expect((await buy(s, vipId)).statusCode).toBe(200);
    expect((await me(s)).premiumTier).toBe("ELITE");
    expect(await premiumUntilMs(s.userId)).toBe(vipUntil + 60 * DAY_MS);
  });

  it("an expired membership reads as FREE and a new purchase starts from now, not from the old expiry", async () => {
    const s = await registerUser(ctx.app);
    await fund(ctx.db, s.userId, 1_000n, "GEMS");
    const past = new Date(Date.now() - 10 * DAY_MS);
    await ctx.db.user.update({ where: { id: s.userId }, data: { premiumTier: "ELITE", premiumUntil: past } });
    expect((await me(s)).premiumTier).toBe("FREE");
    expect((await me(s)).premiumUntil).toBeNull();
    expect(await capacity(s)).toBe(ECONOMY.premium.FREE.inventorySlots);

    const t0 = Date.now();
    expect((await buy(s, vipId)).statusCode).toBe(200);
    const until = await premiumUntilMs(s.userId);
    expect(until).toBeGreaterThanOrEqual(t0 + 30 * DAY_MS);
    // An expired higher tier is not kept.
    expect((await me(s)).premiumTier).toBe("VIP");
    expect(await capacity(s)).toBe(ECONOMY.premium.VIP.inventorySlots);
  });

  it("grants convenience perks only: gems go to premium revenue, no crypto, credits, items or XP", async () => {
    const s = await registerUser(ctx.app);
    await fund(ctx.db, s.userId, 1_000n, "GEMS");
    const before = await me(s);
    const itemsBefore = await ctx.db.inventoryItem.count({ where: { userId: s.userId } });
    const ledgerBefore = await ctx.db.balanceLedger.count({ where: { userId: s.userId } });

    const res = await buy(s, vipId);
    expect(res.statusCode).toBe(200);
    const purchaseId = (res.json() as { purchaseId: string }).purchaseId;

    const after = await me(s);
    expect(after.balances.nebx).toBe(before.balances.nebx);
    expect(after.balances.pendingRewards).toBe(before.balances.pendingRewards);
    expect(after.balances.credits).toBe(before.balances.credits);
    expect(after.xp).toBe(before.xp);
    expect(await ctx.db.inventoryItem.count({ where: { userId: s.userId } })).toBe(itemsBefore);

    // Exactly one ledger posting: the gem charge into PREMIUM_REVENUE (a sink, nothing paid back out).
    const rows = await ctx.db.balanceLedger.findMany({ where: { userId: s.userId }, orderBy: { createdAt: "asc" }, include: { debitAccount: true, creditAccount: true } });
    expect(rows).toHaveLength(ledgerBefore + 1);
    const charge = rows[rows.length - 1];
    expect(charge?.reference).toBe(purchaseId);
    expect(charge?.asset).toBe("GEMS");
    expect(charge?.amount).toBe(500n);
    expect(charge?.debitAccount.key).toBe(`USER_WALLET:${s.userId}:GEMS`);
    expect(charge?.creditAccount.type).toBe("PREMIUM_REVENUE");
    expect(await ctx.db.balanceLedger.count({ where: { userId: s.userId, asset: { in: ["NEBX", "SOL"] } } })).toBe(0);

    // The only functional benefit exposed by the API is the larger inventory (convenience).
    expect(await capacity(s)).toBe(ECONOMY.premium.VIP.inventorySlots);
    expect(ECONOMY.premium.VIP.inventorySlots).toBeGreaterThan(ECONOMY.premium.FREE.inventorySlots);

    // Product copy is explicit that premium is not an investment.
    const product = await ctx.db.shopProduct.findUniqueOrThrow({ where: { id: vipId } });
    expect(product.category).toBe("PREMIUM");
    expect(product.description).toMatch(/not an investment/i);
    expect(product.description).not.toMatch(/\b(APY|interest|guaranteed return|passive income|daily profit)\b/i);
  });
});
