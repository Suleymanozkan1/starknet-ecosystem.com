/**
 * Auction house: listing fee on creation, escrowed bids (previous bidder refunded atomically),
 * minimum increment, anti-sniping extension, buyout, cancellation fee (only without bids) and
 * background settlement (lib/auction.ts).
 */
import type { FastifyInstance } from "fastify";
import { post, system, userWallet, withSerializableTx } from "@nebula/database";
import { CheatType, LedgerAccountType, LedgerTxType, mulRatio, type Currency } from "@nebula/shared";
import { auctionBidSchema, auctionCreateSchema, idSchema } from "@nebula/validation";
import { z } from "zod";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { payoutSeller } from "../lib/auction.js";
import { getCatalog } from "../lib/catalog.js";
import { assertMarketOpen, flagRisk, getFees } from "../lib/economy.js";
import { escrowItem, releaseEscrowed, transferEscrowed } from "../lib/escrow.js";
import { notify } from "../lib/notify.js";
import { loadRules } from "../lib/rules.js";
import { relationshipSignals } from "../lib/washtrade.js";

const listQuery = z.object({ type: z.enum(["HOURLY", "DAILY", "WEEKLY", "EVENT"]).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });

function minNextBid(current: bigint | null, start: bigint, pct: number): bigint {
  if (current === null) return start;
  const inc = mulRatio(current, pct);
  return current + (inc < 1n ? 1n : inc);
}

export default async function auctionRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app;
  const bidLimiter = app.limiter("auction-bid", 10, 60_000);
  const mutate = { preHandler: app.authenticate, config: { rateLimit: app.rateLimits.market } };

  async function dto(a: { id: string; sellerId: string; itemId: string; quantity: number; type: string; currency: string; startPrice: bigint; buyoutPrice: bigint | null; currentBid: bigint | null; currentBidderId: string | null; listingFee: bigint; status: string; endsAt: Date; createdAt: Date }) {
    const rules = await loadRules(db);
    const def = (await getCatalog(db)).items.get(a.itemId);
    return {
      id: a.id, sellerId: a.sellerId, itemId: a.itemId, name: def?.name ?? a.itemId, rarity: def?.rarity ?? null, quantity: a.quantity,
      type: a.type, currency: a.currency, startPrice: a.startPrice.toString(), buyoutPrice: a.buyoutPrice?.toString() ?? null,
      currentBid: a.currentBid?.toString() ?? null, currentBidderId: a.currentBidderId, listingFee: a.listingFee.toString(),
      minNextBid: minNextBid(a.currentBid, a.startPrice, rules.auctionMinIncrementPct).toString(),
      status: a.status, endsAt: a.endsAt.toISOString(), createdAt: a.createdAt.toISOString(),
    };
  }

  app.get("/api/auctions", async (req) => {
    const q = app.parse(listQuery, req.query);
    const rows = await db.auction.findMany({
      where: { status: "ACTIVE", endsAt: { gt: new Date() }, ...(q.type ? { type: q.type } : {}) },
      orderBy: { endsAt: "asc" },
      take: q.limit,
    });
    const fees = await getFees(db);
    return { auctions: await Promise.all(rows.map(dto)), fees: { listing: fees.auctionListing, sale: fees.auctionSale, cancellation: fees.auctionCancellation } };
  });

  app.get<{ Params: { id: string } }>("/api/auctions/:id", async (req) => {
    const a = await db.auction.findUnique({ where: { id: app.parse(idSchema, req.params.id) }, include: { bids: { orderBy: { amount: "desc" }, take: 20 } } });
    if (!a) throw notFound("Auction");
    return { auction: await dto(a), bids: a.bids.map((b) => ({ id: b.id, bidderId: b.bidderId, amount: b.amount.toString(), status: b.status, createdAt: b.createdAt.toISOString() })) };
  });

  app.post("/api/auctions", mutate, async (req, reply) => {
    const body = app.parse(auctionCreateSchema, req.body);
    if (body.buyoutPrice !== undefined && body.buyoutPrice <= body.startPrice) throw badRequest("INVALID_BUYOUT", "Buyout must exceed the start price");
    await assertMarketOpen(db);
    const userId = req.user.id;
    const [fees, rules, catalog] = await Promise.all([getFees(db), loadRules(db), getCatalog(db)]);
    const hours = rules.auctionDurationsHours[body.type];
    const listingFee = mulRatio(body.startPrice, fees.auctionListing);
    const currency = body.currency as Currency;
    const { recordId } = await withSerializableTx(db, async (tx) => {
      const res = await escrowItem(tx, catalog, userId, body.inventoryItemId, body.quantity, (t) =>
        tx.auction.create({
          data: {
            sellerId: userId, inventoryItemId: t.inventoryItemId, itemId: t.itemId, quantity: t.quantity, type: body.type, currency,
            startPrice: body.startPrice, buyoutPrice: body.buyoutPrice ?? null, listingFee, endsAt: new Date(Date.now() + hours * 3_600_000),
          },
          select: { id: true },
        }), "auction");
      if (listingFee > 0n) {
        await post(tx, {
          from: userWallet(userId, currency), to: system(LedgerAccountType.AUCTION_REVENUE, currency), amount: listingFee,
          type: LedgerTxType.AUCTION_FEE, reference: res.recordId, idempotencyKey: `auction:${res.recordId}:listing`, userId,
          metadata: { auctionId: res.recordId, kind: "LISTING_FEE" },
        });
      }
      return res;
    });
    const a = await db.auction.findUniqueOrThrow({ where: { id: recordId } });
    app.analytics.track("AUCTION", userId, { action: "CREATE", auctionId: a.id, itemId: a.itemId, startPrice: a.startPrice.toString(), listingFee: listingFee.toString(), currency });
    return reply.status(201).send({ auction: await dto(a) });
  });

  app.post<{ Params: { id: string } }>("/api/auctions/:id/bid", { preHandler: [app.authenticate, bidLimiter], config: { rateLimit: app.rateLimits.bid } }, async (req) => {
    const auctionId = app.parse(idSchema, req.params.id);
    const { amount } = app.parse(auctionBidSchema, req.body);
    await assertMarketOpen(db);
    const bidderId = req.user.id;
    const rules = await loadRules(db);
    const pre = await db.auction.findUnique({ where: { id: auctionId }, select: { sellerId: true } });
    if (!pre) throw notFound("Auction");
    if (pre.sellerId === bidderId) throw badRequest("OWN_AUCTION", "You cannot bid on your own auction");
    const related = await relationshipSignals(db, bidderId, pre.sellerId);
    if (related.length) {
      const details = { auctionId, bidderId, sellerId: pre.sellerId, reasons: related };
      await flagRisk(db, bidderId, CheatType.TRADE_EXPLOIT, 15, details, "auction");
      await flagRisk(db, pre.sellerId, CheatType.TRADE_EXPLOIT, 15, details, "auction");
      throw forbidden("Bid blocked: accounts appear to be related", "TRADE_BLOCKED");
    }
    const result = await withSerializableTx(db, async (tx) => {
      const a = await tx.auction.findUnique({ where: { id: auctionId } });
      if (!a) throw notFound("Auction");
      if (a.status !== "ACTIVE" || a.endsAt.getTime() <= Date.now()) throw conflict("AUCTION_CLOSED", "Auction has ended");
      if (a.currentBidderId === bidderId) throw badRequest("ALREADY_HIGHEST", "You are already the highest bidder");
      const min = minNextBid(a.currentBid, a.startPrice, rules.auctionMinIncrementPct);
      if (amount < min) throw badRequest("BID_TOO_LOW", `Minimum bid is ${min.toString()}`, { minBid: min.toString() });
      if (a.buyoutPrice !== null && amount >= a.buyoutPrice) throw badRequest("USE_BUYOUT", "Bid reaches the buyout price; use buyout instead");
      const currency = a.currency as Currency;
      const bid = await tx.auctionBid.create({ data: { auctionId: a.id, bidderId, amount, ip: req.ip } });
      await post(tx, {
        from: userWallet(bidderId, currency), to: system(LedgerAccountType.ESCROW, currency), amount, type: LedgerTxType.ESCROW,
        reference: a.id, idempotencyKey: `auction:${a.id}:bid:${bid.id}`, userId: bidderId, metadata: { auctionId: a.id, bidId: bid.id },
      });
      if (a.currentBidderId && a.currentBid) {
        const prev = await tx.auctionBid.findFirst({ where: { auctionId: a.id, bidderId: a.currentBidderId, status: "ACTIVE" }, orderBy: { amount: "desc" } });
        await post(tx, {
          from: system(LedgerAccountType.ESCROW, currency), to: userWallet(a.currentBidderId, currency), amount: a.currentBid,
          type: LedgerTxType.REFUND, reference: a.id, idempotencyKey: `auction:${a.id}:refund:${prev?.id ?? `${a.currentBidderId}:${a.version}`}`,
          userId: a.currentBidderId, metadata: { auctionId: a.id, outbidBy: bid.id },
        });
        if (prev) await tx.auctionBid.update({ where: { id: prev.id }, data: { status: "OUTBID" } });
        await notify(tx, a.currentBidderId, "AUCTION_OUTBID", "You were outbid", "Your bid was exceeded; your escrowed amount was returned.", { auctionId: a.id });
      }
      const snipeMs = rules.auctionAntiSnipeSeconds * 1000;
      const endsAt = a.endsAt.getTime() - Date.now() < snipeMs ? new Date(Date.now() + snipeMs) : a.endsAt;
      const upd = await tx.auction.updateMany({
        where: { id: a.id, version: a.version, status: "ACTIVE" },
        data: { currentBid: amount, currentBidderId: bidderId, endsAt, version: { increment: 1 } },
      });
      if (upd.count !== 1) throw conflict("CONCURRENT_BID", "Another bid was placed, retry");
      return { bidId: bid.id, endsAt };
    });
    app.analytics.track("AUCTION", bidderId, { action: "BID", auctionId, bidId: result.bidId, amount: amount.toString() });
    return { ok: true, bidId: result.bidId, amount: amount.toString(), endsAt: result.endsAt.toISOString() };
  });

  app.post<{ Params: { id: string } }>("/api/auctions/:id/buyout", mutate, async (req) => {
    const auctionId = app.parse(idSchema, req.params.id);
    await assertMarketOpen(db);
    const buyerId = req.user.id;
    const fees = await getFees(db);
    const pre = await db.auction.findUnique({ where: { id: auctionId }, select: { sellerId: true } });
    if (!pre) throw notFound("Auction");
    if (pre.sellerId === buyerId) throw badRequest("OWN_AUCTION", "You cannot buy your own auction");
    const related = await relationshipSignals(db, buyerId, pre.sellerId);
    if (related.length) {
      await flagRisk(db, buyerId, CheatType.TRADE_EXPLOIT, 15, { auctionId, reasons: related }, "auction");
      throw forbidden("Trade blocked: accounts appear to be related", "TRADE_BLOCKED");
    }
    await withSerializableTx(db, async (tx) => {
      const a = await tx.auction.findUnique({ where: { id: auctionId } });
      if (!a) throw notFound("Auction");
      if (a.status !== "ACTIVE" || a.endsAt.getTime() <= Date.now()) throw conflict("AUCTION_CLOSED", "Auction has ended");
      if (a.buyoutPrice === null) throw badRequest("NO_BUYOUT", "This auction has no buyout price");
      const currency = a.currency as Currency;
      const upd = await tx.auction.updateMany({
        where: { id: a.id, version: a.version, status: "ACTIVE" },
        data: { status: "SOLD", currentBid: a.buyoutPrice, currentBidderId: buyerId, settledAt: new Date(), version: { increment: 1 } },
      });
      if (upd.count !== 1) throw conflict("CONCURRENT_BID", "Auction changed, retry");
      if (a.currentBidderId && a.currentBid) {
        await post(tx, {
          from: system(LedgerAccountType.ESCROW, currency), to: userWallet(a.currentBidderId, currency), amount: a.currentBid,
          type: LedgerTxType.REFUND, reference: a.id, idempotencyKey: `auction:${a.id}:refund:buyout`, userId: a.currentBidderId,
          metadata: { auctionId: a.id, reason: "BUYOUT" },
        });
        await tx.auctionBid.updateMany({ where: { auctionId: a.id, status: "ACTIVE" }, data: { status: "OUTBID" } });
        await notify(tx, a.currentBidderId, "AUCTION_OUTBID", "Auction bought out", "The auction was bought out; your escrowed bid was returned.", { auctionId: a.id });
      }
      await payoutSeller(tx, a, a.buyoutPrice, fees.auctionSale, false, buyerId);
      await transferEscrowed(tx, a.inventoryItemId, a.sellerId, buyerId, `auction:${a.id}`);
      await tx.trade.create({
        data: {
          kind: "AUCTION_BUYOUT", referenceId: a.id, sellerId: a.sellerId, buyerId, itemId: a.itemId, quantity: a.quantity,
          price: a.buyoutPrice, currency: a.currency, fee: mulRatio(a.buyoutPrice, fees.auctionSale),
        },
      });
      await notify(tx, a.sellerId, "AUCTION_SOLD", "Auction sold", `Your auction was bought out for ${a.buyoutPrice.toString()} ${a.currency}.`, { auctionId: a.id });
    });
    app.analytics.track("AUCTION", buyerId, { action: "BUYOUT", auctionId });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/auctions/:id/cancel", mutate, async (req) => {
    const auctionId = app.parse(idSchema, req.params.id);
    await assertMarketOpen(db);
    const fees = await getFees(db);
    await withSerializableTx(db, async (tx) => {
      const a = await tx.auction.findFirst({ where: { id: auctionId, sellerId: req.user.id } });
      if (!a) throw notFound("Auction");
      if (a.status !== "ACTIVE") throw conflict("AUCTION_CLOSED", "Auction is not active");
      if (a.currentBidderId) throw badRequest("HAS_BIDS", "Auctions with bids cannot be cancelled");
      const upd = await tx.auction.updateMany({
        where: { id: a.id, version: a.version, status: "ACTIVE", currentBidderId: null },
        data: { status: "CANCELLED", settledAt: new Date(), version: { increment: 1 } },
      });
      if (upd.count !== 1) throw conflict("CONCURRENT_BID", "Auction changed, retry");
      const fee = mulRatio(a.startPrice, fees.auctionCancellation);
      if (fee > 0n) {
        await post(tx, {
          from: userWallet(a.sellerId, a.currency as Currency), to: system(LedgerAccountType.AUCTION_REVENUE, a.currency as Currency), amount: fee,
          type: LedgerTxType.AUCTION_FEE, reference: a.id, idempotencyKey: `auction:${a.id}:cancelfee`, userId: a.sellerId,
          metadata: { auctionId: a.id, kind: "CANCELLATION_FEE" },
        });
      }
      await releaseEscrowed(tx, a.inventoryItemId, `auction:${a.id}`);
    });
    app.analytics.track("AUCTION", req.user.id, { action: "CANCEL", auctionId });
    return { ok: true };
  });
}
