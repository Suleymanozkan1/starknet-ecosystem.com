/**
 * Authoritative persistence for gameplay results.
 *
 * - High-frequency deltas (XP, honor, counters, resources, kill credits,
 *   ammo use, leaderboard increments, quest progress) are accumulated in a
 *   per-player `PendingDelta` and flushed in ONE transaction per player
 *   (periodically, on important events, on leave, on shutdown).
 * - Credits/gems use the double-entry ledger with idempotency keys derived
 *   from the kill/loot id, so a retried flush can never double-credit.
 * - Loot items are inserted with a unique `originRef` (duplicate pickup is
 *   rejected by the database, not just by memory).
 * - Redis never holds any of this state.
 */
import { ACHIEVEMENTS, ITEMS_BY_ID, PROGRESSION } from "@nebula/config";
import { grantCryptoReward } from "@nebula/economy";
import { post, system, userWallet, getBalance, withSerializableTx, type Db, type Tx } from "@nebula/database";
import { contributionTier, levelForXp, newlyUnlockedAchievements, rankFor } from "@nebula/game-core";
import type { AchievementDef, Currency, EventDef, ResourceId, RewardBundle, RewardSource } from "@nebula/shared";
import { LedgerAccountType } from "@nebula/shared";
import { activeSeasonId, type LeaderboardId } from "./catalog.js";
import type { QuestRuntime } from "./player.js";

export interface Issuance {
  asset: Extract<Currency, "CREDITS" | "GEMS">;
  amount: number;
  key: string;
  reason: string;
  meta?: Record<string, unknown>;
}

export class PendingDelta {
  xp = 0;
  honor = 0;
  seasonScore = 0;
  npcKills = 0;
  playerKills = 0;
  deaths = 0;
  bossKills = 0;
  gatesCompleted = 0;
  pvpWins = 0;
  pvpLosses = 0;
  damageDealt = 0;
  bossDamage = 0;
  resourcesMined = 0;
  playtimeSec = 0;
  resources = new Map<string, number>();
  issuance: Issuance[] = [];
  ammo = new Map<string, number>();
  boards = new Map<LeaderboardId, number>();
  mapsVisited = new Set<string>();
  eventContrib = new Map<string, { eventId: string; instanceKey: string; amount: number }>();
  position: { mapId: string; x: number; y: number } | null = null;

  isEmpty(): boolean {
    return this.xp === 0 && this.honor === 0 && this.seasonScore === 0 && this.npcKills === 0 && this.playerKills === 0 && this.deaths === 0
      && this.bossKills === 0 && this.gatesCompleted === 0 && this.pvpWins === 0 && this.pvpLosses === 0 && this.damageDealt === 0
      && this.bossDamage === 0 && this.resourcesMined === 0 && this.playtimeSec === 0 && this.resources.size === 0 && this.issuance.length === 0
      && this.ammo.size === 0 && this.boards.size === 0 && this.mapsVisited.size === 0 && this.eventContrib.size === 0 && this.position === null;
  }

  addResource(id: string, n: number): void {
    if (n > 0) this.resources.set(id, (this.resources.get(id) ?? 0) + n);
  }
  addBoard(id: LeaderboardId, n: number): void {
    if (n !== 0) this.boards.set(id, (this.boards.get(id) ?? 0) + n);
  }
  addEvent(eventId: string, instanceKey: string, amount: number): void {
    const k = `${eventId}|${instanceKey}`;
    const cur = this.eventContrib.get(k);
    if (cur) cur.amount += amount;
    else this.eventContrib.set(k, { eventId, instanceKey, amount });
  }

  /** Merge a failed flush back so nothing is lost (idempotent parts are safe to retry). */
  mergeFrom(o: PendingDelta): void {
    const numKeys = ["xp", "honor", "seasonScore", "npcKills", "playerKills", "deaths", "bossKills", "gatesCompleted", "pvpWins", "pvpLosses", "damageDealt", "bossDamage", "resourcesMined", "playtimeSec"] as const;
    for (const k of numKeys) this[k] += o[k];
    for (const [k, v] of o.resources) this.addResource(k, v);
    this.issuance.unshift(...o.issuance);
    for (const [k, v] of o.ammo) this.ammo.set(k, (this.ammo.get(k) ?? 0) + v);
    for (const [k, v] of o.boards) this.addBoard(k, v);
    for (const m of o.mapsVisited) this.mapsVisited.add(m);
    for (const e of o.eventContrib.values()) this.addEvent(e.eventId, e.instanceKey, e.amount);
    this.position ??= o.position;
  }
}

export interface EventRewardResult {
  userId: string;
  tier: string | null;
  contributionPct: number;
  bundle: RewardBundle;
  cryptoStatus: string | null;
}

export interface FlushResult {
  xp: number;
  level: number;
  honor: number;
  rank: string;
  newAchievements: AchievementDef[];
}

export class DuplicateLootError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "DuplicateLootError";
  }
}

export interface LootGrant {
  lootId: string;
  items: { itemId: string; quantity: number; affixes: unknown[] }[];
  credits: number;
  gems: number;
  resources: Partial<Record<ResourceId, number>>;
}

function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string }).code === "P2002";
}

export class Persistence {
  readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  /** Flush one player's pending delta atomically. */
  async flush(userId: string, d: PendingDelta, quests: Iterable<QuestRuntime>, unlocked: Set<string>): Promise<FlushResult> {
    const dirtyQuests = [...quests].filter((q) => q.dirty);
    const res = await this.db.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id: userId },
        data: {
          xp: { increment: BigInt(Math.floor(d.xp)) },
          honor: { increment: BigInt(Math.floor(d.honor)) },
          seasonScore: { increment: BigInt(Math.floor(d.seasonScore)) },
          playtimeSeconds: { increment: BigInt(Math.floor(d.playtimeSec)) },
          ...(d.position ? { lastMapId: d.position.mapId, lastX: d.position.x, lastY: d.position.y } : {}),
        },
        select: { xp: true, honor: true, level: true, rank: true },
      });
      const xp = Number(user.xp);
      const honor = Number(user.honor);
      const level = Math.max(user.level, levelForXp(xp, PROGRESSION));
      const rank = rankFor(honor, level, PROGRESSION).id.replace(/^rank_/, "");
      if (level !== user.level || rank !== user.rank) await tx.user.update({ where: { id: userId }, data: { level, rank } });

      const prevStats = await tx.playerStat.findUnique({ where: { userId }, select: { mapsVisited: true } });
      const maps = [...new Set([...(prevStats?.mapsVisited ?? []), ...d.mapsVisited])];
      const inc = {
        npcKills: { increment: d.npcKills }, playerKills: { increment: d.playerKills }, deaths: { increment: d.deaths },
        bossKills: { increment: d.bossKills }, gatesCompleted: { increment: d.gatesCompleted }, pvpWins: { increment: d.pvpWins },
        pvpLosses: { increment: d.pvpLosses }, resourcesMined: { increment: BigInt(Math.floor(d.resourcesMined)) },
        damageDealt: { increment: BigInt(Math.floor(d.damageDealt)) }, bossDamage: { increment: BigInt(Math.floor(d.bossDamage)) },
        mapsVisited: maps,
      };
      const stats = await tx.playerStat.upsert({
        where: { userId },
        create: {
          userId, npcKills: d.npcKills, playerKills: d.playerKills, deaths: d.deaths, bossKills: d.bossKills, gatesCompleted: d.gatesCompleted,
          pvpWins: d.pvpWins, pvpLosses: d.pvpLosses, resourcesMined: BigInt(Math.floor(d.resourcesMined)),
          damageDealt: BigInt(Math.floor(d.damageDealt)), bossDamage: BigInt(Math.floor(d.bossDamage)), mapsVisited: maps,
        },
        update: inc,
      });

      for (const [resourceId, amount] of d.resources) {
        await tx.playerResource.upsert({
          where: { userId_resourceId: { userId, resourceId } },
          create: { userId, resourceId, amount: BigInt(amount) },
          update: { amount: { increment: BigInt(amount) } },
        });
      }

      for (const is of d.issuance) {
        if (is.amount <= 0) continue;
        await post(tx, {
          from: system(LedgerAccountType.GAME_ISSUANCE, is.asset),
          to: userWallet(userId, is.asset),
          amount: BigInt(Math.floor(is.amount)),
          type: "GAME_ISSUANCE",
          reference: is.reason,
          idempotencyKey: is.key,
          userId,
          metadata: is.meta,
        });
      }

      for (const [stackId, used] of d.ammo) {
        if (used <= 0) continue;
        const row = await tx.inventoryItem.findFirst({ where: { id: stackId, userId }, select: { quantity: true } });
        if (!row) continue;
        const take = Math.min(row.quantity, used);
        if (row.quantity - take <= 0) await tx.inventoryItem.delete({ where: { id: stackId } });
        else await tx.inventoryItem.update({ where: { id: stackId }, data: { quantity: { decrement: take }, version: { increment: 1 } } });
      }

      for (const [board, amount] of d.boards) {
        if (board === "honor") continue;
        await tx.leaderboardEntry.upsert({
          where: { leaderboardId_userId: { leaderboardId: board, userId } },
          create: { leaderboardId: board, userId, score: BigInt(Math.floor(amount)) },
          update: { score: { increment: BigInt(Math.floor(amount)) } },
        });
      }
      if (d.honor !== 0 || d.boards.has("honor")) {
        await tx.leaderboardEntry.upsert({
          where: { leaderboardId_userId: { leaderboardId: "honor", userId } },
          create: { leaderboardId: "honor", userId, score: BigInt(honor) },
          update: { score: BigInt(honor) },
        });
      }
      for (const e of d.eventContrib.values()) {
        await tx.eventParticipation.upsert({
          where: { eventId_userId_instanceKey: { eventId: e.eventId, userId, instanceKey: e.instanceKey } },
          create: { eventId: e.eventId, userId, instanceKey: e.instanceKey, contribution: BigInt(Math.floor(e.amount)) },
          update: { contribution: { increment: BigInt(Math.floor(e.amount)) } },
        });
      }

      for (const q of dirtyQuests) {
        await tx.userQuest.updateMany({
          where: { id: q.userQuestId, userId, status: "ACTIVE" },
          data: { progress: q.progress, ...(q.status === "COMPLETED" ? { status: "COMPLETED", completedAt: new Date() } : {}) },
        });
      }

      const metrics: Record<string, number> = {
        npc_kills: stats.npcKills, player_kills: stats.playerKills, pvp_wins: stats.pvpWins, boss_kills: stats.bossKills,
        gates_completed: stats.gatesCompleted, resources_mined: Number(stats.resourcesMined), maps_visited: stats.mapsVisited.length,
        level, items_crafted: stats.itemsCrafted,
      };
      const fresh = newlyUnlockedAchievements(ACHIEVEMENTS, metrics, unlocked);
      if (fresh.length) {
        await tx.userAchievement.createMany({ data: fresh.map((a) => ({ userId, achievementId: a.id })), skipDuplicates: true });
      }
      return { xp, level, honor, rank, newAchievements: fresh };
    }, { timeout: 20_000, maxWait: 10_000 });
    for (const q of dirtyQuests) q.dirty = false;
    for (const a of res.newAchievements) unlocked.add(a.id);
    return res;
  }

  /**
   * Grant a loot pickup atomically. Items are unique by originRef, credits/gems
   * by ledger idempotency key; any duplicate aborts the whole grant.
   */
  async grantLoot(userId: string, g: LootGrant): Promise<void> {
    try {
      await this.db.$transaction(async (tx) => {
        let i = 0;
        for (const it of g.items) {
          await tx.inventoryItem.create({
            data: { userId, itemId: it.itemId, quantity: it.quantity, affixes: it.affixes as object[], originRef: `loot:${g.lootId}:${i++}` },
          });
        }
        for (const [asset, amount] of [["CREDITS", g.credits], ["GEMS", g.gems]] as const) {
          if (amount <= 0) continue;
          const r = await post(tx, {
            from: system(LedgerAccountType.GAME_ISSUANCE, asset), to: userWallet(userId, asset), amount: BigInt(Math.floor(amount)),
            type: "GAME_ISSUANCE", reference: `loot:${g.lootId}`, idempotencyKey: `loot:${g.lootId}:${asset}`, userId,
          });
          if (r.duplicate) throw new DuplicateLootError(`loot ${g.lootId} ${asset} already granted`);
        }
        for (const [resourceId, amount] of Object.entries(g.resources)) {
          if (!amount || amount <= 0) continue;
          await tx.playerResource.upsert({
            where: { userId_resourceId: { userId, resourceId } },
            create: { userId, resourceId, amount: BigInt(amount) },
            update: { amount: { increment: BigInt(amount) } },
          });
        }
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new DuplicateLootError(`loot ${g.lootId} already granted`);
      throw e;
    }
  }

  /**
   * Credit sink (repair, gate entry). Charges min(balance, amount) when
   * `partial`, else all-or-nothing. Idempotent by key. Returns amount charged.
   */
  async chargeCredits(userId: string, amount: number, key: string, reason: string, partial: boolean, tx?: Tx): Promise<number> {
    const run = async (t: Tx): Promise<number> => {
      const want = BigInt(Math.max(0, Math.floor(amount)));
      if (want === 0n) return 0;
      const bal = await getBalance(t, userWallet(userId, "CREDITS"));
      const take = partial ? (bal < want ? bal : want) : want;
      if (take <= 0n) return 0;
      if (!partial && bal < want) throw new Error("INSUFFICIENT_CREDITS");
      await post(t, {
        from: userWallet(userId, "CREDITS"), to: system(LedgerAccountType.GAME_SINK, "CREDITS"), amount: take,
        type: "GAME_SINK", reference: reason, idempotencyKey: key, userId,
      });
      return Number(take);
    };
    if (tx) return run(tx);
    return this.db.$transaction(run);
  }

  /** Spend resources (all-or-nothing) inside a transaction. */
  async spendResources(tx: Tx, userId: string, resources: Partial<Record<string, number>>): Promise<void> {
    for (const [resourceId, amount] of Object.entries(resources)) {
      if (!amount || amount <= 0) continue;
      const r = await tx.playerResource.updateMany({ where: { userId, resourceId, amount: { gte: BigInt(amount) } }, data: { amount: { decrement: BigInt(amount) } } });
      if (r.count !== 1) throw new Error(`INSUFFICIENT_RESOURCE:${resourceId}`);
    }
  }

  /**
   * Distribute EventParticipation reward tiers for one event instance
   * (eventId + instanceKey, e.g. a boss life). Idempotent: each row is claimed
   * with `rewarded=false → true` inside the same transaction that grants the
   * bundle (XP/honor/season points on User, credits/gems via ledger keys,
   * items with unique originRef `event:<eventId>:<instance>:<userId>:<i>`).
   * Crypto eligibility is routed through grantCryptoReward (sourceRef =
   * `event:<eventId>:<instance>:<userId>`).
   */
  async distributeEventRewards(
    eventId: string,
    instanceKey: string,
    def: EventDef | null,
    opts: { minShare: number; fallbackSource: RewardSource; label: string; mode?: string },
  ): Promise<EventRewardResult[]> {
    const rows = await this.db.eventParticipation.findMany({ where: { eventId, instanceKey } });
    const total = rows.reduce((s, r) => s + Number(r.contribution), 0);
    const out: EventRewardResult[] = [];
    for (const row of rows) {
      if (row.rewarded) continue;
      const pct = total > 0 ? (Number(row.contribution) / total) * 100 : 0;
      const eligible = pct >= opts.minShare * 100;
      const tier = eligible && def ? contributionTier(def, pct) : null;
      const bundle: RewardBundle = tier?.bundle ?? {};
      const ref = `event:${eventId}:${instanceKey}:${row.userId}`;
      const userId = row.userId;
      const granted = await this.db.$transaction(async (tx) => {
        const claim = await tx.eventParticipation.updateMany({ where: { id: row.id, rewarded: false }, data: { rewarded: true, rewardTier: tier?.tier ?? (eligible ? "PARTICIPANT" : "NONE") } });
        if (claim.count !== 1) return false;
        const xp = Math.floor(bundle.xp ?? 0);
        const honor = Math.floor(bundle.honor ?? 0);
        const season = Math.floor(bundle.seasonPoints ?? 0) + honor;
        if (xp || honor || season) {
          const u = await tx.user.update({ where: { id: userId }, data: { xp: { increment: BigInt(xp) }, honor: { increment: BigInt(honor) }, seasonScore: { increment: BigInt(season) } }, select: { xp: true, level: true, honor: true } });
          const level = Math.max(u.level, levelForXp(Number(u.xp), PROGRESSION));
          if (level !== u.level) await tx.user.update({ where: { id: userId }, data: { level } });
          if (season) {
            await tx.leaderboardEntry.upsert({ where: { leaderboardId_userId: { leaderboardId: "season_score", userId } }, create: { leaderboardId: "season_score", userId, score: BigInt(season) }, update: { score: { increment: BigInt(season) } } });
          }
          if (honor) {
            await tx.leaderboardEntry.upsert({ where: { leaderboardId_userId: { leaderboardId: "honor", userId } }, create: { leaderboardId: "honor", userId, score: u.honor }, update: { score: u.honor } });
          }
        }
        let i = 0;
        for (const it of bundle.items ?? []) {
          if (!ITEMS_BY_ID.has(it.itemId)) continue;
          await tx.inventoryItem.create({ data: { userId, itemId: it.itemId, quantity: it.quantity, originRef: `${ref}:${i++}` } });
        }
        for (const [asset, amount] of [["CREDITS", bundle.credits ?? 0], ["GEMS", bundle.gems ?? 0]] as const) {
          if (amount <= 0) continue;
          await post(tx, {
            from: system(LedgerAccountType.GAME_ISSUANCE, asset), to: userWallet(userId, asset), amount: BigInt(Math.floor(amount)),
            type: "GAME_REWARD", reference: ref, idempotencyKey: `${ref}:${asset}`, userId, metadata: { eventId, instanceKey, tier: tier?.tier },
          });
        }
        for (const [resourceId, amount] of Object.entries(bundle.resources ?? {})) {
          if (!amount || amount <= 0) continue;
          await tx.playerResource.upsert({ where: { userId_resourceId: { userId, resourceId } }, create: { userId, resourceId, amount: BigInt(amount) }, update: { amount: { increment: BigInt(amount) } } });
        }
        return true;
      });
      if (!granted) continue;
      let cryptoStatus: string | null = null;
      const crypto = bundle.cryptoEligible ?? (eligible && !def ? { source: opts.fallbackSource, weight: Math.max(0.1, Math.min(3, pct / 20)) } : null);
      if (crypto) {
        try {
          const r = await grantCryptoReward(this.db, { userId, source: crypto.source, sourceRef: ref, weight: crypto.weight, reason: `${opts.label} (${pct.toFixed(1)}% contribution)`, mode: opts.mode, seasonId: activeSeasonId() ?? undefined });
          cryptoStatus = r.status;
        } catch {
          cryptoStatus = "ERROR";
        }
      }
      out.push({ userId, tier: tier?.tier ?? null, contributionPct: pct, bundle, cryptoStatus });
    }
    return out;
  }

  /**
   * Pay out ACTIVE bounties on a PvP victim to the killer (bounty credits are
   * held in ESCROW:CREDITS by the API). Claim + payout share one transaction;
   * idempotencyKey `bounty:<bountyId>`. The bounty creator cannot claim it.
   */
  async claimBounties(victimId: string, killerId: string): Promise<{ bountyId: string; amount: bigint }[]> {
    const now = new Date();
    const open = await this.db.bounty.findMany({ where: { targetId: victimId, status: "ACTIVE", expiresAt: { gt: now } } });
    const paid: { bountyId: string; amount: bigint }[] = [];
    for (const b of open) {
      if (b.creatorId === killerId || b.currency !== "CREDITS" || b.amount <= 0n) continue;
      await withSerializableTx(this.db, async (tx) => {
        const claim = await tx.bounty.updateMany({ where: { id: b.id, status: "ACTIVE", expiresAt: { gt: now } }, data: { status: "CLAIMED", claimedBy: killerId } });
        if (claim.count !== 1) return;
        await post(tx, {
          from: system(LedgerAccountType.ESCROW, "CREDITS"), to: userWallet(killerId, "CREDITS"), amount: b.amount,
          type: "ESCROW", reference: b.id, idempotencyKey: `bounty:${b.id}`, userId: killerId, metadata: { kind: "BOUNTY_CLAIMED", targetId: victimId },
        });
        paid.push({ bountyId: b.id, amount: b.amount });
      });
    }
    return paid;
  }

  async createMatch(data: { roomId: string; mode: string; mapId: string; metadata?: Record<string, unknown> }): Promise<string> {
    const m = await this.db.gameMatch.create({ data: { roomId: data.roomId, mode: data.mode, mapId: data.mapId, metadata: (data.metadata ?? {}) as object } });
    return m.id;
  }

  async joinMatch(matchId: string, userId: string, team: number): Promise<void> {
    await this.db.gameMatchPlayer.upsert({
      where: { matchId_userId: { matchId, userId } },
      create: { matchId, userId, team },
      update: { team, leftAt: null },
    });
  }

  /**
   * Finish a match idempotently. `extra` runs inside the SAME transaction, only
   * when this call actually transitioned the match (e.g. ClanWar scoring).
   */
  async finishMatch(matchId: string, winnerTeam: number | null, players: { userId: string; kills: number; deaths: number; damage: number; score: number; ratingDelta: number; won: boolean; left: boolean }[], metadata: Record<string, unknown>, extra?: (tx: Tx) => Promise<void>): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const upd = await tx.gameMatch.updateMany({ where: { id: matchId, status: "RUNNING" }, data: { status: "FINISHED", winnerTeam, endedAt: new Date(), metadata: metadata as object } });
      if (upd.count !== 1) return; // already finished (idempotent)
      if (extra) await extra(tx);
      for (const p of players) {
        await tx.gameMatchPlayer.upsert({
          where: { matchId_userId: { matchId, userId: p.userId } },
          create: { matchId, userId: p.userId, kills: p.kills, deaths: p.deaths, damage: BigInt(Math.floor(p.damage)), score: p.score, ratingDelta: p.ratingDelta, leftAt: new Date() },
          update: { kills: p.kills, deaths: p.deaths, damage: BigInt(Math.floor(p.damage)), score: p.score, ratingDelta: p.ratingDelta, leftAt: new Date() },
        });
        await tx.user.update({ where: { id: p.userId }, data: { pvpRating: { increment: p.ratingDelta }, matchesPlayed: { increment: 1 } } });
        await tx.playerStat.upsert({
          where: { userId: p.userId },
          create: { userId: p.userId, pvpWins: p.won ? 1 : 0, pvpLosses: p.won ? 0 : 1 },
          update: { pvpWins: { increment: p.won ? 1 : 0 }, pvpLosses: { increment: p.won ? 0 : 1 } },
        });
      }
    });
  }

  async saveChat(rows: { channel: string; channelKey: string; senderId: string; text: string }[]): Promise<void> {
    if (rows.length) await this.db.chatMessage.createMany({ data: rows });
  }
}
