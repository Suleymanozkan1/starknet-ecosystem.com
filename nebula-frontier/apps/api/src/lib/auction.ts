/**
 * Auction settlement shared by the buyout route and the background settlement job.
 * Winning bid is held in ESCROW; on settlement escrow -> seller (minus sale fee) and
 * escrow -> AUCTION_REVENUE (fee); the escrowed item moves to the winner.
 */
import { post, system, userWallet, withSerializableTx, type Db, type Tx } from "@nebula/database";
import { LedgerAccountType, LedgerTxType, mulRatio, type Currency } from "@nebula/shared";
import { getFees } from "./economy.js";
import { releaseEscrowed, transferEscrowed } from "./escrow.js";
import { notify } from "./notify.js";

export async function payoutSeller(tx: Tx, auction: { id: string; sellerId: string; currency: string }, amount: bigint, saleFeeRate: number, fromEscrow: boolean, buyerId: string) {
  const currency = auction.currency as Currency;
  const fee = mulRatio(amount, saleFeeRate);
  const proceeds = amount - fee;
  const from = fromEscrow ? system(LedgerAccountType.ESCROW, currency) : userWallet(buyerId, currency);
  if (proceeds > 0n) {
    await post(tx, {
      from, to: userWallet(auction.sellerId, currency), amount: proceeds, type: LedgerTxType.TRADE, reference: auction.id,
      idempotencyKey: `auction:${auction.id}:proceeds`, userId: auction.sellerId, metadata: { auctionId: auction.id, buyerId },
    });
  }
  if (fee > 0n) {
    await post(tx, {
      from, to: system(LedgerAccountType.AUCTION_REVENUE, currency), amount: fee, type: LedgerTxType.AUCTION_FEE, reference: auction.id,
      idempotencyKey: `auction:${auction.id}:salefee`, userId: auction.sellerId, metadata: { auctionId: auction.id },
    });
  }
  return { fee, proceeds };
}

/** Settle one ended auction (idempotent: conditional on status ACTIVE). Returns true if settled now. */
export async function settleAuction(db: Db, auctionId: string): Promise<boolean> {
  const fees = await getFees(db);
  return withSerializableTx(db, async (tx) => {
    const a = await tx.auction.findUnique({ where: { id: auctionId } });
    if (!a || a.status !== "ACTIVE" || a.endsAt.getTime() > Date.now()) return false;
    const winner = a.currentBidderId;
    const upd = await tx.auction.updateMany({
      where: { id: a.id, status: "ACTIVE", version: a.version },
      data: { status: winner ? "SOLD" : "EXPIRED", settledAt: new Date(), version: { increment: 1 } },
    });
    if (upd.count !== 1) return false;
    if (winner && a.currentBid) {
      await payoutSeller(tx, a, a.currentBid, fees.auctionSale, true, winner);
      await transferEscrowed(tx, a.inventoryItemId, a.sellerId, winner, `auction:${a.id}`);
      await tx.auctionBid.updateMany({ where: { auctionId: a.id, bidderId: winner, status: "ACTIVE" }, data: { status: "WON" } });
      await tx.trade.create({
        data: {
          kind: "AUCTION", referenceId: a.id, sellerId: a.sellerId, buyerId: winner, itemId: a.itemId, quantity: a.quantity,
          price: a.currentBid, currency: a.currency, fee: mulRatio(a.currentBid, fees.auctionSale),
        },
      });
      await notify(tx, winner, "AUCTION_WON", "Auction won", "You won an auction; the item is in your inventory.", { auctionId: a.id });
      await notify(tx, a.sellerId, "AUCTION_SOLD", "Auction sold", `Your auction sold for ${a.currentBid.toString()} ${a.currency}.`, { auctionId: a.id });
    } else {
      await releaseEscrowed(tx, a.inventoryItemId, `auction:${a.id}`);
      await notify(tx, a.sellerId, "AUCTION_EXPIRED", "Auction ended", "Your auction ended without bids; the item was returned.", { auctionId: a.id });
    }
    return true;
  });
}

interface SettleLogger {
  error: (obj: object, msg?: string) => void;
}

/**
 * Settle every ended auction in the batch. A failing auction is logged and skipped so it cannot
 * block the rest of the batch (it stays ACTIVE and is retried on the next run).
 */
export async function settleEndedAuctions(db: Db, limit = 50, log?: SettleLogger, settle: typeof settleAuction = settleAuction): Promise<number> {
  const due = await db.auction.findMany({ where: { status: "ACTIVE", endsAt: { lte: new Date() } }, select: { id: true }, take: limit, orderBy: { endsAt: "asc" } });
  let n = 0;
  for (const a of due) {
    try {
      if (await settle(db, a.id)) n++;
    } catch (err) {
      log?.error({ err, auctionId: a.id }, "auction settlement failed");
    }
  }
  return n;
}
