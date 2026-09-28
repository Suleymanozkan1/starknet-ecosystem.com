/**
 * Background maintenance jobs run by the API process. Each job takes a short Redis lock so only one
 * API instance executes it per tick; every job is idempotent (conditional status transitions).
 */
import type { FastifyInstance } from "fastify";
import { post, system, userWallet, withSerializableTx, type Db } from "@nebula/database";
import { Currency, LedgerAccountType, LedgerTxType } from "@nebula/shared";
import { settleEndedAuctions } from "../lib/auction.js";
import { releaseEscrowed } from "../lib/escrow.js";
import { notify } from "../lib/notify.js";

export async function expireListings(db: Db): Promise<number> {
  const due = await db.marketplaceListing.findMany({ where: { status: "ACTIVE", expiresAt: { lte: new Date() } }, take: 200, select: { id: true, inventoryItemId: true } });
  let n = 0;
  for (const l of due) {
    await db.$transaction(async (tx) => {
      const upd = await tx.marketplaceListing.updateMany({ where: { id: l.id, status: "ACTIVE" }, data: { status: "EXPIRED", version: { increment: 1 } } });
      if (upd.count === 1) {
        await releaseEscrowed(tx, l.inventoryItemId, `listing:${l.id}`);
        n++;
      }
    });
  }
  return n;
}

export async function expireBounties(db: Db): Promise<number> {
  const due = await db.bounty.findMany({ where: { status: "ACTIVE", expiresAt: { lte: new Date() } }, take: 200 });
  let n = 0;
  for (const b of due) {
    await withSerializableTx(db, async (tx) => {
      const upd = await tx.bounty.updateMany({ where: { id: b.id, status: "ACTIVE" }, data: { status: "EXPIRED" } });
      if (upd.count !== 1) return;
      if (b.creatorId) {
        await post(tx, {
          from: system(LedgerAccountType.ESCROW, Currency.CREDITS), to: userWallet(b.creatorId, Currency.CREDITS), amount: b.amount,
          type: LedgerTxType.REFUND, reference: b.id, idempotencyKey: `bounty:${b.id}:refund`, userId: b.creatorId, metadata: { kind: "BOUNTY_EXPIRED" },
        });
        await notify(tx, b.creatorId, "BOUNTY_EXPIRED", "Bounty expired", "Your bounty expired unclaimed and was refunded.", { bountyId: b.id });
      }
      n++;
    });
  }
  return n;
}

/** Clan war lifecycle: PREPARATION -> BATTLE (startsAt) -> SCORING (endsAt) -> REWARDED. */
export async function advanceClanWars(db: Db): Promise<number> {
  const now = new Date();
  const a = await db.clanWar.updateMany({ where: { phase: "PREPARATION", startsAt: { lte: now } }, data: { phase: "BATTLE" } });
  const b = await db.clanWar.updateMany({ where: { phase: "BATTLE", endsAt: { lte: now } }, data: { phase: "SCORING" } });
  // Stale declarations that were never accepted are closed without a winner.
  const c = await db.clanWar.updateMany({ where: { phase: "DECLARED", endsAt: { lte: now } }, data: { phase: "REWARDED" } });
  const scoring = await db.clanWar.findMany({ where: { phase: "SCORING" }, take: 50 });
  for (const w of scoring) {
    const winnerId = w.scoreA === w.scoreB ? null : w.scoreA > w.scoreB ? w.clanAId : w.clanBId;
    await db.$transaction(async (tx) => {
      const upd = await tx.clanWar.updateMany({ where: { id: w.id, phase: "SCORING" }, data: { phase: "REWARDED", winnerId } });
      if (upd.count === 1 && winnerId) await tx.clan.update({ where: { id: winnerId }, data: { score: { increment: BigInt(Math.max(w.scoreA, w.scoreB)) } } });
    });
  }
  return a.count + b.count + c.count + scoring.length;
}

export async function cleanupNonces(db: Db): Promise<number> {
  const r = await db.walletNonce.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 24 * 3_600_000) } } });
  return r.count;
}

export function startJobs(app: FastifyInstance): () => void {
  const timers: NodeJS.Timeout[] = [];
  const every = (name: string, ms: number, fn: () => Promise<number>) => {
    const run = async () => {
      const lock = await app.redis.set(`job:${name}`, process.pid.toString(), "PX", Math.max(1000, ms - 500), "NX").catch(() => null);
      if (lock !== "OK") return;
      try {
        const n = await fn();
        if (n > 0) app.log.info({ job: name, processed: n }, "job run");
      } catch (err) {
        app.log.error({ err, job: name }, "job failed");
      }
    };
    timers.push(setInterval(() => void run(), ms));
  };
  every("auction-settle", 15_000, () => settleEndedAuctions(app.db));
  every("listing-expire", 60_000, () => expireListings(app.db));
  every("bounty-expire", 300_000, () => expireBounties(app.db));
  every("clanwar-advance", 60_000, () => advanceClanWars(app.db));
  every("nonce-cleanup", 3_600_000, () => cleanupNonces(app.db));
  return () => timers.forEach((t) => clearInterval(t));
}
