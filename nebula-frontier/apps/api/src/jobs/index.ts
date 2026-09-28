/**
 * Background maintenance jobs run by the API process. Each job takes a short Redis lock so only one
 * API instance executes it per tick; every job is idempotent (conditional status transitions).
 */
import type { FastifyInstance } from "fastify";
import { post, system, userWallet, withSerializableTx, type Db } from "@nebula/database";
import { Currency, LedgerAccountType, LedgerTxType } from "@nebula/shared";
import type { Redis } from "ioredis";
import { MAPS_BY_ID, QUESTS_BY_ID } from "@nebula/config";
import { activeEventWindow, isQuestComplete } from "@nebula/game-core";
import { settleEndedAuctions } from "../lib/auction.js";
import { refreshMission } from "../lib/clanMissions.js";
import { loadEventDefs } from "../lib/events.js";
import { captureTerritories } from "../lib/territory.js";
import { releaseEscrowed } from "../lib/escrow.js";
import { PushType, dispatchPendingPush, notify } from "../lib/notify.js";

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
  // PREPARATION -> BATTLE, one by one so members of both clans get a CLAN_WAR_STARTED push.
  const starting = await db.clanWar.findMany({ where: { phase: "PREPARATION", startsAt: { lte: now } }, take: 100 });
  const a = { count: 0 };
  for (const w of starting) {
    const upd = await db.clanWar.updateMany({ where: { id: w.id, phase: "PREPARATION" }, data: { phase: "BATTLE" } });
    if (upd.count !== 1) continue;
    a.count++;
    const members = await db.clanMember.findMany({ where: { clanId: { in: [w.clanAId, w.clanBId] } }, select: { userId: true } });
    const mapName = MAPS_BY_ID.get(w.mapId)?.name ?? w.mapId;
    for (const m of members) {
      await notify(db, m.userId, PushType.CLAN_WAR_STARTED, "Clan war started", `The battle for ${mapName} has begun. Join your clan now!`, { warId: w.id, mapId: w.mapId });
    }
  }
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
  const t = await captureTerritories(db);
  return a.count + b.count + c.count + scoring.length + t;
}

/** Re-evaluate active clan missions (member stat deltas) so completion is detected without a page view. */
export async function refreshClanMissions(db: Db): Promise<number> {
  const active = await db.clanMission.findMany({ where: { status: "ACTIVE" }, select: { id: true }, orderBy: { startedAt: "asc" }, take: 200 });
  let completed = 0;
  for (const m of active) if ((await refreshMission(db, m.id)).status === "COMPLETED") completed++;
  return completed;
}

/** EVENT_STARTED / RAID_AVAILABLE pushes when an event window opens (once per window). */
export async function announceEvents(db: Db, redis: Redis, now = Date.now(), lookbackMs = 5 * 60_000): Promise<number> {
  const defs = await loadEventDefs(db);
  let sent = 0;
  for (const d of defs) {
    const w = activeEventWindow(d, now);
    if (!w || now - w.start > lookbackMs) continue;
    const first = await redis.set(`evt:announced:${d.id}:${w.start}`, "1", "PX", Math.max(60_000, w.end - now + 60_000), "NX");
    if (first !== "OK") continue;
    const raid = d.type === "RAID_EVENT";
    // Audience: recently active pilots that registered a push device (in-app rows are the fallback).
    const users = await db.user.findMany({
      where: { bannedAt: null, lastLoginAt: { gte: new Date(now - 14 * 86_400_000) }, devices: { some: { pushToken: { not: null } } } },
      select: { id: true },
      take: 5000,
    });
    for (const u of users) {
      await notify(db, u.id, raid ? PushType.RAID_AVAILABLE : PushType.EVENT_STARTED, raid ? "Raid available" : `${d.name} started`, d.description.slice(0, 180), {
        eventId: d.id, endsAt: new Date(w.end).toISOString(), maps: d.maps,
      });
    }
    sent += users.length;
  }
  return sent;
}

/** WITHDRAWAL_COMPLETED push for withdrawals the blockchain-service confirmed (once per withdrawal). */
export async function announceWithdrawals(db: Db, redis: Redis): Promise<number> {
  const rows = await db.withdrawal.findMany({
    where: { status: "COMPLETED", completedAt: { gte: new Date(Date.now() - 24 * 3_600_000) } },
    select: { id: true, userId: true, final: true, signature: true },
    orderBy: { completedAt: "asc" },
    take: 200,
  });
  let n = 0;
  for (const w of rows) {
    if ((await redis.set(`wd:announced:${w.id}`, "1", "EX", 3 * 86_400, "NX")) !== "OK") continue;
    await notify(db, w.userId, PushType.WITHDRAWAL_COMPLETED, "Withdrawal completed", "Your withdrawal was confirmed on-chain.", {
      withdrawalId: w.id, amount: w.final.toString(), signature: w.signature,
    });
    n++;
  }
  return n;
}

/**
 * MISSION_COMPLETE push once per completed quest: covers quests the game server marked COMPLETED
 * and ACTIVE quests whose recorded progress already meets every objective (e.g. LEVEL objectives).
 */
export async function announceCompletedQuests(db: Db, redis: Redis): Promise<number> {
  const since = new Date(Date.now() - 3_600_000);
  const rows = await db.userQuest.findMany({
    where: { OR: [{ status: "COMPLETED", completedAt: { gte: since } }, { status: "ACTIVE", completedAt: null }] },
    take: 1000,
    select: { id: true, userId: true, questId: true, progress: true, status: true },
  });
  let n = 0;
  for (const r of rows) {
    const q = QUESTS_BY_ID.get(r.questId);
    if (!q) continue;
    if (r.status === "ACTIVE") {
      if (!isQuestComplete(q, r.progress)) continue;
      const upd = await db.userQuest.updateMany({ where: { id: r.id, status: "ACTIVE", completedAt: null }, data: { status: "COMPLETED", completedAt: new Date() } });
      if (upd.count !== 1) continue;
    }
    if ((await redis.set(`quest:announced:${r.id}`, "1", "EX", 7 * 86_400, "NX")) !== "OK") continue;
    await notify(db, r.userId, PushType.MISSION_COMPLETE, "Mission complete", `${q.name} is complete. Claim your reward!`, { userQuestId: r.id, questId: q.id });
    n++;
  }
  return n;
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
  every("clan-missions", 60_000, () => refreshClanMissions(app.db));
  every("quest-complete", 30_000, () => announceCompletedQuests(app.db, app.redis));
  every("event-announce", 60_000, () => announceEvents(app.db, app.redis));
  every("withdrawal-announce", 30_000, () => announceWithdrawals(app.db, app.redis));
  if (app.pushSender.enabled) every("push-dispatch", 5_000, () => dispatchPendingPush());
  return () => timers.forEach((t) => clearInterval(t));
}
