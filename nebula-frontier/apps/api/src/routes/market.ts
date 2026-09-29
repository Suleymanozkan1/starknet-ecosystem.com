/**
 * Player marketplace (fixed-price listings). Fee rate from the economy config, shown at listing
 * time and stored on the listing. Settlement is a single SERIALIZABLE transaction:
 * listing version check -> ledger (buyer -> seller proceeds, buyer -> MARKETPLACE_REVENUE fee) ->
 * escrowed item ownership transfer -> Trade row. MARKET_PAUSE breaker blocks all mutations.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { mulRatio } from "@nebula/shared";
import { post, system, userWallet, withSerializableTx } from "@nebula/database";
import { CheatType, Currency, LedgerAccountType, LedgerTxType } from "@nebula/shared";
import { idSchema, marketListSchema, marketQuerySchema } from "@nebula/validation";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { getCatalog } from "../lib/catalog.js";
import { assertMarketOpen, flagRisk, getFees } from "../lib/economy.js";
import { escrowItem, releaseEscrowed, transferEscrowed } from "../lib/escrow.js";
import { notify } from "../lib/notify.js";
import { loadRules } from "../lib/rules.js";
import { relationshipSignals } from "../lib/washtrade.js";

type ListingRow = {
  id: string; sellerId: string; inventoryItemId: string; itemId: string; quantity: number; price: bigint; currency: string;
  fee: bigint; status: string; expiresAt: Date; createdAt: Date; seller?: { username: string } | null;
};

export default async function marketRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app;
  const market = { preHandler: app.authenticate, config: { rateLimit: app.rateLimits.market } };

  /** Batch DTO mapping: one catalog load and one inventory query for all listings (no N+1). */
  async function toDtos(listings: readonly ListingRow[]) {
    if (listings.length === 0) return [];
    const catalog = await getCatalog(db);
    const invIds = [...new Set(listings.map((l) => l.inventoryItemId))];
    const invRows = await db.inventoryItem.findMany({ where: { id: { in: invIds } }, select: { id: true, upgradeLevel: true, affixes: true } });
    const invById = new Map(invRows.map((r) => [r.id, r]));
    return listings.map((l) => {
      const def = catalog.items.get(l.itemId);
      const inv = invById.get(l.inventoryItemId);
      return {
        id: l.id,
        sellerId: l.sellerId,
        seller: l.seller?.username ?? null,
        itemId: l.itemId,
        name: def?.name ?? l.itemId,
        category: def?.category ?? null,
        rarity: def?.rarity ?? null,
        quantity: l.quantity,
        upgradeLevel: inv?.upgradeLevel ?? 0,
        affixes: inv?.affixes ?? [],
        price: l.price.toString(),
        currency: l.currency,
        fee: l.fee.toString(),
        sellerReceives: (l.price - l.fee).toString(),
        status: l.status,
        expiresAt: l.expiresAt.toISOString(),
        createdAt: l.createdAt.toISOString(),
      };
    });
  }

  async function requireCryptoFeature(req: FastifyRequest, reply: FastifyReply, currency: string) {
    if (currency === Currency.NEBX) await app.requireFeature("marketplace_crypto")(req, reply);
  }

  app.get("/api/market", async (req) => {
    const q = app.parse(marketQuerySchema, req.query);
    const catalog = await getCatalog(db);
    const itemIds = q.category || q.rarity
      ? [...catalog.items.values()].filter((d) => (!q.category || d.category === q.category) && (!q.rarity || d.rarity === q.rarity)).map((d) => d.id)
      : undefined;
    const rows = await db.marketplaceListing.findMany({
      where: {
        status: "ACTIVE",
        expiresAt: { gt: new Date() },
        ...(q.itemId ? { itemId: q.itemId } : itemIds ? { itemId: { in: itemIds } } : {}),
        ...(q.currency ? { currency: q.currency } : {}),
      },
      orderBy: q.sort === "price_asc" ? { price: "asc" } : q.sort === "price_desc" ? { price: "desc" } : { createdAt: "desc" },
      take: q.limit,
      include: { seller: { select: { username: true } } },
    });
    const fees = await getFees(db);
    return { listings: await toDtos(rows), feeRate: fees.marketplace };
  });

  app.get("/api/market/mine", { preHandler: app.authenticate }, async (req) => {
    const rows = await db.marketplaceListing.findMany({
      where: { sellerId: req.user.id },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { seller: { select: { username: true } } },
    });
    return { listings: await toDtos(rows) };
  });

  app.post("/api/market/list", market, async (req, reply) => {
    const body = app.parse(marketListSchema, req.body);
    await requireCryptoFeature(req, reply, body.currency);
    await assertMarketOpen(db);
    const userId = req.user.id;
    const [fees, rules, catalog] = await Promise.all([getFees(db), loadRules(db), getCatalog(db)]);
    const active = await db.marketplaceListing.count({ where: { sellerId: userId, status: "ACTIVE" } });
    if (active >= rules.marketMaxActiveListings) throw badRequest("TOO_MANY_LISTINGS", "Too many active listings");
    const fee = mulRatio(body.price, fees.marketplace);
    const { recordId } = await withSerializableTx(db, (tx) =>
      escrowItem(tx, catalog, userId, body.inventoryItemId, body.quantity, (t) =>
        tx.marketplaceListing.create({
          data: {
            sellerId: userId, inventoryItemId: t.inventoryItemId, itemId: t.itemId, quantity: t.quantity, price: body.price,
            currency: body.currency, fee, expiresAt: new Date(Date.now() + body.durationHours * 3_600_000),
          },
          select: { id: true },
        }), "listing"),
    );
    const listing = await db.marketplaceListing.findUniqueOrThrow({ where: { id: recordId }, include: { seller: { select: { username: true } } } });
    const [dto] = await toDtos([listing]);
    return reply.status(201).send({ listing: dto, feeRate: fees.marketplace });
  });

  app.post<{ Params: { id: string } }>("/api/market/buy/:id", market, async (req, reply) => {
    const listingId = app.parse(idSchema, req.params.id);
    await assertMarketOpen(db);
    const buyerId = req.user.id;
    const listing = await db.marketplaceListing.findUnique({ where: { id: listingId } });
    if (!listing) throw notFound("Listing");
    await requireCryptoFeature(req, reply, listing.currency);
    if (listing.status !== "ACTIVE" || listing.expiresAt.getTime() <= Date.now()) throw conflict("LISTING_UNAVAILABLE", "Listing is no longer available");
    if (listing.sellerId === buyerId) throw badRequest("OWN_LISTING", "You cannot buy your own listing");
    const related = await relationshipSignals(db, buyerId, listing.sellerId);
    if (related.length) {
      const details = { listingId, buyerId, sellerId: listing.sellerId, reasons: related };
      await flagRisk(db, buyerId, CheatType.TRADE_EXPLOIT, 15, details, "marketplace");
      await flagRisk(db, listing.sellerId, CheatType.TRADE_EXPLOIT, 15, details, "marketplace");
      throw forbidden("Trade blocked: accounts appear to be related", "TRADE_BLOCKED");
    }
    const currency = listing.currency as Currency;
    await withSerializableTx(db, async (tx) => {
      const claimed = await tx.marketplaceListing.updateMany({
        where: { id: listing.id, status: "ACTIVE", version: listing.version, expiresAt: { gt: new Date() } },
        data: { status: "SOLD", buyerId, soldAt: new Date(), version: { increment: 1 } },
      });
      if (claimed.count !== 1) throw conflict("LISTING_UNAVAILABLE", "Listing is no longer available");
      const proceeds = listing.price - listing.fee;
      if (proceeds > 0n) {
        await post(tx, {
          from: userWallet(buyerId, currency), to: userWallet(listing.sellerId, currency), amount: proceeds,
          type: LedgerTxType.TRADE, reference: listing.id, idempotencyKey: `market:${listing.id}:proceeds`, userId: buyerId,
          metadata: { listingId: listing.id, itemId: listing.itemId, sellerId: listing.sellerId },
        });
      }
      if (listing.fee > 0n) {
        await post(tx, {
          from: userWallet(buyerId, currency), to: system(LedgerAccountType.MARKETPLACE_REVENUE, currency), amount: listing.fee,
          type: LedgerTxType.MARKETPLACE_FEE, reference: listing.id, idempotencyKey: `market:${listing.id}:fee`, userId: buyerId,
          metadata: { listingId: listing.id },
        });
      }
      await transferEscrowed(tx, listing.inventoryItemId, listing.sellerId, buyerId, `listing:${listing.id}`);
      await tx.trade.create({
        data: {
          kind: "MARKET", referenceId: listing.id, sellerId: listing.sellerId, buyerId, itemId: listing.itemId,
          quantity: listing.quantity, price: listing.price, currency: listing.currency, fee: listing.fee,
        },
      });
      await notify(tx, listing.sellerId, "MARKET_SOLD", "Item sold", `Your listing sold for ${listing.price.toString()} ${listing.currency}.`, {
        listingId: listing.id, proceeds: proceeds.toString(),
      });
    });
    app.analytics.track("TRADE", buyerId, {
      kind: "MARKET", listingId: listing.id, sellerId: listing.sellerId, itemId: listing.itemId, quantity: listing.quantity,
      price: listing.price.toString(), fee: listing.fee.toString(), currency: listing.currency,
    });
    return { ok: true, listingId: listing.id, inventoryItemId: listing.inventoryItemId };
  });

  app.post<{ Params: { id: string } }>("/api/market/cancel/:id", market, async (req) => {
    const listingId = app.parse(idSchema, req.params.id);
    await assertMarketOpen(db);
    await withSerializableTx(db, async (tx) => {
      const listing = await tx.marketplaceListing.findFirst({ where: { id: listingId, sellerId: req.user.id } });
      if (!listing) throw notFound("Listing");
      const upd = await tx.marketplaceListing.updateMany({
        where: { id: listing.id, status: "ACTIVE" },
        data: { status: "CANCELLED", version: { increment: 1 } },
      });
      if (upd.count !== 1) throw conflict("LISTING_UNAVAILABLE", "Listing is no longer active");
      await releaseEscrowed(tx, listing.inventoryItemId, `listing:${listing.id}`);
    });
    return { ok: true };
  });
}
