/**
 * Money & item integrity through the REST API: purchases (price from DB, idempotency,
 * insufficient funds), IDOR, inventory duplication attempts, trade and auction races.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { settleAuction } from "../../apps/api/src/lib/auction.js";
import { verifyLedgerIntegrity } from "../../packages/database/src/index.js";
import { FACTIONS_BY_ID } from "../../packages/config/src/index.js";
import { starterAmmoFor, starterAmmoOriginRef } from "../../packages/game-core/src/index.js";
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

async function productPrice(id: string): Promise<bigint> {
  const p = await ctx.db.shopProduct.findUniqueOrThrow({ where: { id } });
  return p.price;
}

describe("faction onboarding", () => {
  it("grants the starter ship + loadout once and issues a game ticket", async () => {
    const s = await registerUser(ctx.app);
    expect((await s.req("POST", "/api/game/ticket", {})).statusCode).toBe(400);
    const res = await s.req("POST", "/api/me/faction", { factionId: "aurora" });
    expect(res.statusCode).toBe(200);
    const me = res.json() as { faction: string; activeShipInstanceId: string };
    expect(me.faction).toBe("aurora");
    const items = await ctx.db.inventoryItem.findMany({ where: { userId: s.userId } });
    const gear = items.filter((i) => i.originRef?.startsWith(`starter:${s.userId}:`));
    expect(gear.length).toBe(7);
    // Starter ammo from factions.json (shared game-core source) with the game server's originRef.
    const expectedAmmo = starterAmmoFor(FACTIONS_BY_ID.get("aurora")!);
    expect(expectedAmmo.length).toBeGreaterThan(0);
    for (const a of expectedAmmo) {
      const row = items.find((i) => i.originRef === starterAmmoOriginRef(s.userId, a.itemId));
      expect(row?.itemId).toBe(a.itemId);
      expect(row?.quantity).toBe(a.quantity);
    }
    expect(items.length).toBe(7 + expectedAmmo.length);
    // The game-server fallback kit writing the same originRefs is a no-op.
    await ctx.db.inventoryItem.createMany({
      data: expectedAmmo.map((a) => ({ userId: s.userId, itemId: a.itemId, quantity: a.quantity, originRef: starterAmmoOriginRef(s.userId, a.itemId) })),
      skipDuplicates: true,
    });
    expect(await ctx.db.inventoryItem.count({ where: { userId: s.userId } })).toBe(items.length);
    const again = await s.req("POST", "/api/me/faction", { factionId: "vortex" });
    expect(again.statusCode).toBe(409);
    const ticket = await s.req("POST", "/api/game/ticket", {});
    expect(ticket.statusCode).toBe(200);
    expect((ticket.json() as { mapId: string }).mapId).toBe("map_aurora_prime");
    const ships = (await s.req("GET", "/api/ships")).json() as { owned: { loadouts: { weapons: (string | null)[]; ammo: string | null }[] }[] };
    expect(ships.owned[0]?.loadouts[0]?.weapons.filter(Boolean)).toHaveLength(2);
    expect(ships.owned[0]?.loadouts[0]?.ammo).toBe(expectedAmmo[0]?.itemId);
  });
});

describe("shop purchases", () => {
  it("rejects a purchase with insufficient credits and charges nothing", async () => {
    const s = await registerUser(ctx.app);
    await ctx.db.user.update({ where: { id: s.userId }, data: { level: 20 } });
    const res = await s.req("POST", "/api/shop/purchase", { productId: "shop_wpn_laser_mk2", quantity: 1, idempotencyKey: key() });
    expect(res.statusCode).toBe(400);
    expect(code(res)).toBe("INSUFFICIENT_BALANCE");
    expect(await ctx.db.purchase.count({ where: { userId: s.userId } })).toBe(0);
    expect(await ctx.db.inventoryItem.count({ where: { userId: s.userId } })).toBe(0);
  });

  it("rejects inactive products and SOL-priced gem packs", async () => {
    const s = await registerUser(ctx.app);
    await fund(ctx.db, s.userId, 1_000_000n);
    await ctx.db.shopProduct.upsert({
      where: { id: "shop_test_inactive" },
      create: { id: "shop_test_inactive", sku: "sku_test_inactive", name: "Inactive", category: "AMMO", description: "", currency: "CREDITS", price: 10n, grants: {}, active: false },
      update: { active: false },
    });
    const inactive = await s.req("POST", "/api/shop/purchase", { productId: "shop_test_inactive", quantity: 1, idempotencyKey: key() });
    expect(inactive.statusCode).toBe(404);
    const gems = await s.req("POST", "/api/shop/purchase", { productId: "shop_gems_100", quantity: 1, idempotencyKey: key() });
    expect(gems.statusCode).toBe(400);
    expect(code(gems)).toBe("USE_DEPOSIT_FLOW");
    expect(await credits(ctx.db, s.userId)).toBe(1_000_000n);
  });

  it("ignores a client-sent price and charges the DB price", async () => {
    const s = await registerUser(ctx.app);
    await ctx.db.user.update({ where: { id: s.userId }, data: { level: 20 } });
    await fund(ctx.db, s.userId, 1_000_000n);
    const price = await productPrice("shop_wpn_laser_mk2");
    const res = await s.req("POST", "/api/shop/purchase", { productId: "shop_wpn_laser_mk2", quantity: 1, idempotencyKey: key(), price: "1", currency: "GEMS", totalPrice: "0" });
    expect(res.statusCode).toBe(200);
    expect(await credits(ctx.db, s.userId)).toBe(1_000_000n - price);
    const p = await ctx.db.purchase.findFirstOrThrow({ where: { userId: s.userId } });
    expect(p.totalPrice).toBe(price);
    expect(await ctx.db.inventoryItem.count({ where: { userId: s.userId, itemId: "item_wpn_laser_mk2" } })).toBe(1);
  });

  it("is idempotent per idempotencyKey, including concurrent duplicates", async () => {
    const s = await registerUser(ctx.app);
    await fund(ctx.db, s.userId, 1_000_000n);
    const price = await productPrice("shop_ammo_hornet_500");
    const k = key();
    const results = await Promise.all([0, 1, 2, 3].map(() => s.req("POST", "/api/shop/purchase", { productId: "shop_ammo_hornet_500", quantity: 1, idempotencyKey: k })));
    for (const r of results) expect(r.statusCode).toBe(200);
    const ids = new Set(results.map((r) => (r.json() as { purchaseId: string }).purchaseId));
    expect(ids.size).toBe(1);
    const replay = await s.req("POST", "/api/shop/purchase", { productId: "shop_ammo_hornet_500", quantity: 1, idempotencyKey: k });
    expect((replay.json() as { duplicate: boolean }).duplicate).toBe(true);
    expect(await credits(ctx.db, s.userId)).toBe(1_000_000n - price);
    expect(await ctx.db.purchase.count({ where: { userId: s.userId } })).toBe(1);
    const ammo = await ctx.db.inventoryItem.aggregate({ where: { userId: s.userId, itemId: "item_ammo_hornet" }, _sum: { quantity: true } });
    expect(ammo._sum.quantity).toBe(500);
    // Reusing the key for another product is rejected.
    const misuse = await s.req("POST", "/api/shop/purchase", { productId: "shop_ammo_rocket_500", quantity: 1, idempotencyKey: k });
    expect(misuse.statusCode).toBe(409);
  });
});

describe("inventory ownership", () => {
  it("prevents equipping another player's item (IDOR)", async () => {
    const a = await registerUser(ctx.app);
    const b = await registerUser(ctx.app);
    await a.req("POST", "/api/me/faction", { factionId: "nova" });
    await b.req("POST", "/api/me/faction", { factionId: "nova" });
    const aItem = await giveItem(ctx.db, a.userId, "item_wpn_laser_mk1");
    const bShip = await ctx.db.shipInstance.findFirstOrThrow({ where: { userId: b.userId } });
    const res = await b.req("POST", "/api/inventory/equip", {
      shipInstanceId: bShip.id, loadoutId: bShip.activeLoadoutId, inventoryItemId: aItem, slotType: "weapons", slotIndex: 0,
    });
    expect(res.statusCode).toBe(404);
    // B also cannot equip into A's ship.
    const aShip = await ctx.db.shipInstance.findFirstOrThrow({ where: { userId: a.userId } });
    const res2 = await b.req("POST", "/api/inventory/equip", {
      shipInstanceId: aShip.id, loadoutId: aShip.activeLoadoutId, inventoryItemId: aItem, slotType: "weapons", slotIndex: 0,
    });
    expect(res2.statusCode).toBe(404);
    // A can.
    const ok = await a.req("POST", "/api/inventory/equip", {
      shipInstanceId: aShip.id, loadoutId: aShip.activeLoadoutId, inventoryItemId: aItem, slotType: "weapons", slotIndex: 0,
    });
    expect(ok.statusCode).toBe(200);
  });

  it("cannot equip a listed item, cannot list an equipped item", async () => {
    const s = await registerUser(ctx.app);
    await s.req("POST", "/api/me/faction", { factionId: "aurora" });
    const ship = await ctx.db.shipInstance.findFirstOrThrow({ where: { userId: s.userId } });
    const item = await giveItem(ctx.db, s.userId, "item_wpn_laser_mk2");
    const list = await s.req("POST", "/api/market/list", { inventoryItemId: item, price: "5000" });
    expect(list.statusCode).toBe(201);
    const equip = await s.req("POST", "/api/inventory/equip", { shipInstanceId: ship.id, loadoutId: ship.activeLoadoutId, inventoryItemId: item, slotType: "weapons", slotIndex: 0 });
    expect(equip.statusCode).toBe(409);
    expect(code(equip)).toBe("ITEM_LOCKED");
    // Starter items are soulbound: not tradeable at all.
    const starter = await ctx.db.inventoryItem.findFirstOrThrow({ where: { userId: s.userId, itemId: "item_wpn_laser_mk1" } });
    const sellStarter = await s.req("POST", "/api/market/list", { inventoryItemId: starter.id, price: "10" });
    expect(sellStarter.statusCode).toBe(400);
    expect(code(sellStarter)).toBe("NOT_TRADEABLE");
    // Equipped tradeable item cannot be listed.
    const other = await giveItem(ctx.db, s.userId, "item_wpn_missile_hornet");
    await ctx.db.user.update({ where: { id: s.userId }, data: { level: 30 } });
    const eq = await s.req("POST", "/api/inventory/equip", { shipInstanceId: ship.id, loadoutId: ship.activeLoadoutId, inventoryItemId: other, slotType: "missiles", slotIndex: 0 });
    expect(eq.statusCode).toBe(200);
    const listEquipped = await s.req("POST", "/api/market/list", { inventoryItemId: other, price: "10" });
    expect(listEquipped.statusCode).toBe(409);
    expect(code(listEquipped)).toBe("ITEM_EQUIPPED");
  });

  it("double-sell race: only one of N concurrent listings of the same item succeeds", async () => {
    const s = await registerUser(ctx.app);
    const item = await giveItem(ctx.db, s.userId, "item_wpn_laser_prism");
    const results = await Promise.all([0, 1, 2, 3, 4].map((i) => s.req("POST", "/api/market/list", { inventoryItemId: item, price: String(1000 + i) })));
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(await ctx.db.marketplaceListing.count({ where: { sellerId: s.userId, status: "ACTIVE" } })).toBe(1);
    // Listing + auction of the same item concurrently: still one escrow.
    const item2 = await giveItem(ctx.db, s.userId, "item_wpn_laser_solaris");
    const mixed = await Promise.all([
      s.req("POST", "/api/market/list", { inventoryItemId: item2, price: "900" }),
      s.req("POST", "/api/auctions", { inventoryItemId: item2, startPrice: "900" }),
    ]);
    expect(mixed.filter((r) => r.statusCode === 201)).toHaveLength(1);
  });
});

describe("marketplace trade", () => {
  it("trade duplication race: concurrent buyers, exactly one purchase and one payout", async () => {
    const seller = await registerUser(ctx.app);
    const buyers = await Promise.all([0, 1, 2].map(() => registerUser(ctx.app)));
    for (const b of buyers) await fund(ctx.db, b.userId, 100_000n);
    const item = await giveItem(ctx.db, seller.userId, "item_gen_shield_s2");
    const listed = await seller.req("POST", "/api/market/list", { inventoryItemId: item, price: "10000" });
    expect(listed.statusCode).toBe(201);
    const listing = (listed.json() as { listing: { id: string; fee: string } }).listing;
    const sellerBefore = await credits(ctx.db, seller.userId);

    const results = await Promise.all(buyers.map((b) => b.req("POST", `/api/market/buy/${listing.id}`)));
    const winners = results.map((r, i) => ({ r, b: buyers[i]! })).filter((x) => x.r.statusCode === 200);
    expect(winners).toHaveLength(1);
    for (const r of results) if (r.statusCode !== 200) expect(r.statusCode).toBe(409);

    const winner = winners[0]!.b;
    const fee = BigInt(listing.fee);
    expect(fee).toBeGreaterThan(0n);
    expect(await credits(ctx.db, winner.userId)).toBe(100_000n - 10_000n);
    expect(await credits(ctx.db, seller.userId)).toBe(sellerBefore + 10_000n - fee);
    for (const b of buyers) if (b !== winner) expect(await credits(ctx.db, b.userId)).toBe(100_000n);
    const inv = await ctx.db.inventoryItem.findUniqueOrThrow({ where: { id: item } });
    expect(inv.userId).toBe(winner.userId);
    expect(inv.lockedBy).toBeNull();
    expect(await ctx.db.trade.count({ where: { referenceId: listing.id } })).toBe(1);
    // Replaying the buy is rejected.
    expect((await winner.req("POST", `/api/market/buy/${listing.id}`)).statusCode).toBe(409);
  });

  it("blocks wash trades between accounts sharing a device", async () => {
    const device = `dev-${Date.now()}-shared`;
    const seller = await registerUser(ctx.app, device);
    const buyer = await registerUser(ctx.app, device);
    await fund(ctx.db, buyer.userId, 100_000n);
    const item = await giveItem(ctx.db, seller.userId, "item_gen_speed_s2");
    const listing = ((await seller.req("POST", "/api/market/list", { inventoryItemId: item, price: "5000" })).json() as { listing: { id: string } }).listing;
    const res = await buyer.req("POST", `/api/market/buy/${listing.id}`);
    expect(res.statusCode).toBe(403);
    expect(code(res)).toBe("TRADE_BLOCKED");
    expect(await ctx.db.riskSignal.count({ where: { userId: buyer.userId, type: "TRADE_EXPLOIT" } })).toBe(1);
    expect(await credits(ctx.db, buyer.userId)).toBe(100_000n);
  });

  it("respects the MARKET_PAUSE circuit breaker", async () => {
    const s = await registerUser(ctx.app);
    const item = await giveItem(ctx.db, s.userId, "item_wpn_rocket_pod");
    await ctx.db.circuitBreaker.upsert({ where: { mode: "MARKET_PAUSE" }, create: { mode: "MARKET_PAUSE", active: true }, update: { active: true } });
    try {
      const res = await s.req("POST", "/api/market/list", { inventoryItemId: item, price: "100" });
      expect(res.statusCode).toBe(503);
      expect(code(res)).toBe("MARKET_PAUSED");
    } finally {
      await ctx.db.circuitBreaker.update({ where: { mode: "MARKET_PAUSE" }, data: { active: false } });
    }
  });
});

describe("auctions", () => {
  it("bid race: concurrent equal bids -> one accepted, escrow holds exactly one bid, outbid refunds", async () => {
    const seller = await registerUser(ctx.app);
    const bidders = await Promise.all([0, 1, 2, 3].map(() => registerUser(ctx.app)));
    for (const b of bidders) await fund(ctx.db, b.userId, 50_000n);
    await fund(ctx.db, seller.userId, 10_000n);
    const item = await giveItem(ctx.db, seller.userId, "item_wpn_plasma_repeater");
    const created = await seller.req("POST", "/api/auctions", { inventoryItemId: item, startPrice: "1000", type: "HOURLY" });
    expect(created.statusCode).toBe(201);
    const auction = (created.json() as { auction: { id: string; listingFee: string } }).auction;
    expect(BigInt(auction.listingFee)).toBeGreaterThan(0n);

    const escrowBefore = (await ctx.db.balanceAccount.findUnique({ where: { key: "ESCROW:CREDITS" } }))?.balance ?? 0n;
    const results = await Promise.all(bidders.map((b) => b.req("POST", `/api/auctions/${auction.id}/bid`, { amount: "2000" })));
    const ok = results.filter((r) => r.statusCode === 200);
    expect(ok).toHaveLength(1);
    const winnerIdx = results.findIndex((r) => r.statusCode === 200);
    const escrowAfter = (await ctx.db.balanceAccount.findUnique({ where: { key: "ESCROW:CREDITS" } }))?.balance ?? 0n;
    expect(escrowAfter - escrowBefore).toBe(2000n);
    for (let i = 0; i < bidders.length; i++) {
      expect(await credits(ctx.db, bidders[i]!.userId)).toBe(i === winnerIdx ? 48_000n : 50_000n);
    }

    // Seller cannot bid on own auction; too-low bid rejected; higher bid refunds previous bidder.
    expect((await seller.req("POST", `/api/auctions/${auction.id}/bid`, { amount: "5000" })).statusCode).toBe(400);
    const other = bidders[(winnerIdx + 1) % bidders.length]!;
    const low = await other.req("POST", `/api/auctions/${auction.id}/bid`, { amount: "2001" });
    expect(low.statusCode).toBe(400);
    expect(code(low)).toBe("BID_TOO_LOW");
    const higher = await other.req("POST", `/api/auctions/${auction.id}/bid`, { amount: "3000" });
    expect(higher.statusCode).toBe(200);
    expect(await credits(ctx.db, bidders[winnerIdx]!.userId)).toBe(50_000n);
    expect(await credits(ctx.db, other.userId)).toBe(47_000n);

    // Seller cannot cancel once bids exist.
    expect((await seller.req("POST", `/api/auctions/${auction.id}/cancel`)).statusCode).toBe(400);

    // Settlement after end: item -> winner, escrow -> seller minus fee.
    await ctx.db.auction.update({ where: { id: auction.id }, data: { endsAt: new Date(Date.now() - 1000) } });
    const sellerBefore = await credits(ctx.db, seller.userId);
    expect(await settleAuction(ctx.db, auction.id)).toBe(true);
    expect(await settleAuction(ctx.db, auction.id)).toBe(false);
    const inv = await ctx.db.inventoryItem.findUniqueOrThrow({ where: { id: item } });
    expect(inv.userId).toBe(other.userId);
    const gained = (await credits(ctx.db, seller.userId)) - sellerBefore;
    expect(gained).toBeGreaterThan(0n);
    expect(gained).toBeLessThan(3000n);
  });
});

describe("ledger integrity", () => {
  it("every asset sums to zero across all accounts after the scenarios above", async () => {
    const rows = await verifyLedgerIntegrity(ctx.db);
    for (const r of rows) expect(r.ok, `${r.asset} sum ${r.sum}`).toBe(true);
  });
});
