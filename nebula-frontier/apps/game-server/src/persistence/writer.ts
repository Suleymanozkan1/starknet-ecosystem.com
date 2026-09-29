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
 * - Increment-based writes (XP, honor, counters, resources, leaderboards, faction war) are made idempotent by a
 *   stable per-delta `flushId`: the flush transaction first inserts a `PlayerFlush(id)` row, and a retried
 *   flush whose earlier attempt already committed finds that row and applies nothing a second time.
 * - Redis never holds any of this state.
 */
import { randomUUID } from "node:crypto";
import { ACHIEVEMENTS, ITEMS_BY_ID, PROGRESSION } from "@nebula/config";
import { grantCryptoReward } from "@nebula/economy";
import { post, system, userWallet, getBalance, withSerializableTx, type Db, type Tx } from "@nebula/database";
import { clampKarma, contributionTier, factionWarPoints, levelForXp, newlyUnlockedAchievements, petLevelForXp, rankFor, reputationFor } from "@nebula/game-core";
import type { AchievementDef, Currency, EventDef, PetDef, ResourceId, RewardBundle, RewardSource } from "@nebula/shared";
import { LedgerAccountType } from "@nebula/shared";
import { createLogger, errorsTotal, type Logger } from "@nebula/telemetry";
import { activeSeasonId, type LeaderboardId } from "./catalog.js";
import type { QuestRuntime } from "./player.js";

export interface Issuance {
  asset: Extract<Currency, "CREDITS" | "GEMS">;
  /** Integer base units (use `toMoney` from @nebula/game-core to convert a computed number). */
  amount: bigint;
  key: string;
  reason: string;
  meta?: Record<string, unknown>;
}

/** Whole units of a (possibly fractional / non-finite) in-memory amount; never throws, never negative. */
export function wholeUnits(n: number): bigint {
  return Number.isFinite(n) && n >= 1 ? BigInt(Math.floor(n)) : 0n;
}

export class PendingDelta {
  /**
   * Stable idempotency id, assigned when the delta is detached and handed to `Persistence.flush`. Every retry of
   * this delta reuses it; a delta that has one never receives new increments (see `carryFailed`).
   */
  flushId: string | null = null;
  /** Older deltas whose flush failed, oldest first. Each is retried with its OWN `flushId` before this delta. */
  carried: PendingDelta[] = [];
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
  /** Karma change (may be fractional in memory; rounded when persisted). */
  karma = 0;
  /** XP earned by the active companion. */
  petXp = 0;
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
      && this.bossDamage === 0 && this.resourcesMined === 0 && this.playtimeSec === 0 && Math.round(this.karma) === 0 && this.petXp === 0 && this.resources.size === 0 && this.issuance.length === 0
      && this.ammo.size === 0 && this.boards.size === 0 && this.mapsVisited.size === 0 && this.eventContrib.size === 0 && this.position === null
      && this.carried.length === 0;
  }

  addResource(id: string, n: number): void {
    if (Number.isFinite(n) && n > 0) this.resources.set(id, (this.resources.get(id) ?? 0) + n);
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

  /**
   * Keep a failed flush so nothing is lost. The failed delta is NOT merged into this one: its transaction may
   * have committed before the error surfaced, so it stays a separate part that is retried with its own
   * `flushId` (a committed part is then recognised and skipped) ahead of this delta's newer increments.
   */
  carryFailed(failed: PendingDelta): void {
    const parts = [...failed.carried, failed];
    failed.carried = [];
    this.carried.unshift(...parts);
  }
}

export interface EventRewardResult {
  userId: string;
  tier: string | null;
  contributionPct: number;
  bundle: RewardBundle;
  cryptoStatus: string | null;
}

/** Context needed to apply reputation, companion and faction-war side effects in the same transaction. */
export interface FlushContext {
  factionId: string | null;
  pet: { rowId: string; def: PetDef } | null;
}

export interface FlushResult {
  karma: number;
  reputation: string;
  hasBounty: boolean;
  /** A system bounty was placed in this flush (pilot just turned OUTLAW). */
  systemBountyPlaced: boolean;
  pet: { level: number; xp: number } | null;
  xp: number;
  level: number;
  honor: number;
  rank: string;
  newAchievements: AchievementDef[];
  /** Fractional resource amounts that were not persisted (only whole units are); carry them into the next delta. */
  resourceRemainder: Map<string, number>;
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
  /** Integer base units (`toMoney` from @nebula/game-core). */
  credits: bigint;
  gems: bigint;
  resources: Partial<Record<ResourceId, number>>;
}

function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string }).code === "P2002";
}

export class Persistence {
  readonly db: Db;
  private readonly log: Logger;
  constructor(db: Db, log?: Logger) {
    this.db = db;
    this.log = log ?? createLogger({ name: "game-server-persistence" });
  }

  /**
   * Flush one player's pending delta. Carried (previously failed) parts go first, oldest first, each in its own
   * transaction under its own stable `flushId`; a part is removed from `d.carried` once it has committed.
   */
  async flush(userId: string, d: PendingDelta, quests: Iterable<QuestRuntime>, unlocked: Set<string>, ctx: FlushContext = { factionId: null, pet: null }): Promise<FlushResult> {
    const newAchievements: AchievementDef[] = [];
    const resourceRemainder = new Map<string, number>();
    let systemBountyPlaced = false;
    const collect = (r: FlushResult): void => {
      newAchievements.push(...r.newAchievements);
      systemBountyPlaced ||= r.systemBountyPlaced;
      for (const [id, v] of r.resourceRemainder) resourceRemainder.set(id, (resourceRemainder.get(id) ?? 0) + v);
    };
    for (let part = d.carried[0]; part; part = d.carried[0]) {
      collect(await this.flushPart(userId, part, [], unlocked, ctx));
      d.carried.shift();
    }
    const res = await this.flushPart(userId, d, quests, unlocked, ctx);
    collect(res);
    return { ...res, newAchievements, systemBountyPlaced, resourceRemainder };
  }

  /** One idempotent flush transaction for a single delta (no carried parts). */
  private async flushPart(userId: string, part: PendingDelta, quests: Iterable<QuestRuntime>, unlocked: Set<string>, ctx: FlushContext): Promise<FlushResult> {
    const dirtyQuests = [...quests].filter((q) => q.dirty);
    const flushId = (part.flushId ??= randomUUID());
    const resourceRemainder = new Map<string, number>();
    for (const [id, v] of part.resources) {
      const rem = Number.isFinite(v) ? v - Math.floor(v) : 0;
      if (rem > 0) resourceRemainder.set(id, rem);
    }
    const res = await this.db.$transaction(async (tx) => {
      // Idempotency guard: ON CONFLICT DO NOTHING (keeps the transaction usable, unlike a caught P2002). When the
      // id already exists an earlier attempt of this exact delta committed; re-apply nothing, just re-derive state.
      const claim = await tx.playerFlush.createMany({ data: [{ id: flushId, userId }], skipDuplicates: true });
      const d = claim.count === 1 ? part : new PendingDelta();
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

      for (const [resourceId, raw] of d.resources) {
        // Mining yields fractional units: persist whole units only (BigInt of a fraction would throw and
        // abort every retry of this flush); the remainder is reported back via `resourceRemainder`.
        const amount = wholeUnits(raw);
        if (amount <= 0n) continue;
        await tx.playerResource.upsert({
          where: { userId_resourceId: { userId, resourceId } },
          create: { userId, resourceId, amount },
          update: { amount: { increment: amount } },
        });
      }

      for (const is of d.issuance) {
        if (is.amount <= 0n) continue;
        await post(tx, {
          from: system(LedgerAccountType.GAME_ISSUANCE, is.asset),
          to: userWallet(userId, is.asset),
          amount: is.amount,
          type: "GAME_ISSUANCE",
          reference: is.reason,
          idempotencyKey: is.key,
          userId,
          metadata: is.meta,
        });
      }

      for (const [stackId, used] of d.ammo) {
        if (used <= 0) continue;
        // Never touch listed/escrowed stacks (lockedBy set); every write is conditional on the row
        // still being ours, unlocked and holding at least what we take (no read-modify-write race).
        const row = await tx.inventoryItem.findFirst({ where: { id: stackId, userId, lockedBy: null }, select: { quantity: true } });
        if (!row) continue;
        const take = Math.min(row.quantity, used);
        if (take <= 0) continue;
        const guard = { id: stackId, userId, lockedBy: null, quantity: { gte: take } };
        if (row.quantity - take <= 0) await tx.inventoryItem.deleteMany({ where: { ...guard, quantity: take } });
        else await tx.inventoryItem.updateMany({ where: guard, data: { quantity: { decrement: take }, version: { increment: 1 } } });
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
      // ---- Reputation (karma is clamped; status recomputed every flush since bounties change externally)
      const repCfg = PROGRESSION.reputation;
      const karmaDelta = Math.round(d.karma);
      const before = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { karma: true, reputation: true } });
      let karma = before.karma + karmaDelta;
      if (repCfg) karma = clampKarma(karma, repCfg);
      const now = new Date();
      let hasBounty = (await tx.bounty.count({ where: { targetId: userId, status: "ACTIVE", expiresAt: { gt: now } } })) > 0;
      const reputation = repCfg ? reputationFor(karma, hasBounty, repCfg) : before.reputation;
      let systemBountyPlaced = false;
      if (repCfg && reputation === "OUTLAW" && before.reputation !== "OUTLAW" && repCfg.outlawSystemBountyCredits > 0) {
        // System-funded bounty on a new outlaw: GAME_ISSUANCE → ESCROW (claimed by the killer via claimBounties).
        const bucket = now.toISOString().slice(0, 13);
        const amount = BigInt(Math.floor(repCfg.outlawSystemBountyCredits));
        const r = await post(tx, {
          from: system(LedgerAccountType.GAME_ISSUANCE, "CREDITS"), to: system(LedgerAccountType.ESCROW, "CREDITS"), amount,
          type: "ESCROW", reference: `outlaw:${userId}`, idempotencyKey: `system-bounty:${userId}:${bucket}`, userId, metadata: { kind: "SYSTEM_BOUNTY" },
        });
        if (!r.duplicate) {
          await tx.bounty.create({ data: { targetId: userId, creatorId: null, amount, expiresAt: new Date(now.getTime() + repCfg.systemBountyHours * 3_600_000) } });
          systemBountyPlaced = true;
          hasBounty = true;
        }
      }
      if (karma !== before.karma || reputation !== before.reputation) await tx.user.update({ where: { id: userId }, data: { karma, reputation } });

      // ---- Companion XP / level
      let pet: FlushResult["pet"] = null;
      if (ctx.pet) {
        // Owner-scoped, conditional writes: a deleted/foreign cached pet row is skipped (no P2025) instead
        // of rolling back the whole flush (progression, resources, issuance) and failing every retry.
        const petWhere = { id: ctx.pet.rowId, userId };
        if (d.petXp > 0) await tx.pet.updateMany({ where: petWhere, data: { xp: { increment: Math.floor(d.petXp) } } });
        const row = await tx.pet.findFirst({ where: petWhere, select: { xp: true, level: true } });
        if (row) {
          const lvl = petLevelForXp(row.xp, ctx.pet.def);
          if (lvl !== row.level) await tx.pet.updateMany({ where: petWhere, data: { level: lvl } });
          pet = { level: lvl, xp: row.xp };
        }
      }

      // ---- Faction war (same transaction as the player counters → each event counted exactly once)
      const war = PROGRESSION.factionWar;
      if (ctx.factionId && war && (d.npcKills || d.playerKills || d.resourcesMined || d.bossKills)) {
        const delta = { npcKills: d.npcKills, pvpKills: d.playerKills, resources: Math.floor(d.resourcesMined), bossKills: d.bossKills };
        const points = BigInt(factionWarPoints(delta, war));
        const inc = {
          score: { increment: points }, kills: { increment: BigInt(delta.npcKills + delta.pvpKills) },
          pvpScore: { increment: BigInt(delta.pvpKills * war.pvpKillPoints) }, resources: { increment: BigInt(delta.resources) },
          bossKills: { increment: delta.bossKills },
        };
        await tx.faction.update({ where: { id: ctx.factionId }, data: inc });
        const seasonId = activeSeasonId();
        if (seasonId) {
          await tx.factionSeasonScore.upsert({
            where: { factionId_seasonId: { factionId: ctx.factionId, seasonId } },
            create: { factionId: ctx.factionId, seasonId, score: points, kills: BigInt(delta.npcKills + delta.pvpKills), pvpScore: BigInt(delta.pvpKills * war.pvpKillPoints), resources: BigInt(delta.resources), bossKills: delta.bossKills },
            update: inc,
          });
        }
      }

      return { xp, level, honor, rank, newAchievements: fresh, karma, reputation, hasBounty, systemBountyPlaced, pet, resourceRemainder };
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
          if (amount <= 0n) continue;
          const r = await post(tx, {
            from: system(LedgerAccountType.GAME_ISSUANCE, asset), to: userWallet(userId, asset), amount,
            type: "GAME_ISSUANCE", reference: `loot:${g.lootId}`, idempotencyKey: `loot:${g.lootId}:${asset}`, userId,
          });
          if (r.duplicate) throw new DuplicateLootError(`loot ${g.lootId} ${asset} already granted`);
        }
        for (const [resourceId, raw] of Object.entries(g.resources)) {
          const amount = wholeUnits(raw ?? 0);
          if (amount <= 0n) continue;
          await tx.playerResource.upsert({
            where: { userId_resourceId: { userId, resourceId } },
            create: { userId, resourceId, amount },
            update: { amount: { increment: amount } },
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
  async chargeCredits(userId: string, amount: bigint, key: string, reason: string, partial: boolean, tx?: Tx): Promise<bigint> {
    const run = async (t: Tx): Promise<bigint> => {
      if (amount <= 0n) return 0n;
      // A replayed key was already charged earlier: report 0 charged now (caller must not double-apply).
      if (await t.balanceLedger.findUnique({ where: { idempotencyKey: key }, select: { id: true } })) return 0n;
      const bal = await getBalance(t, userWallet(userId, "CREDITS"));
      const take = partial ? (bal < amount ? bal : amount) : amount;
      if (take <= 0n) return 0n;
      if (!partial && bal < amount) throw new Error("INSUFFICIENT_CREDITS");
      const r = await post(t, {
        from: userWallet(userId, "CREDITS"), to: system(LedgerAccountType.GAME_SINK, "CREDITS"), amount: take,
        type: "GAME_SINK", reference: reason, idempotencyKey: key, userId,
      });
      return r.duplicate ? 0n : take;
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
      // Isolated per bounty: one failing payout must not stop the others. `paid` is only updated after the
      // transaction committed (withSerializableTx may re-run the callback on serialization conflicts).
      try {
        const claimed = await withSerializableTx(this.db, async (tx) => {
          const claim = await tx.bounty.updateMany({ where: { id: b.id, status: "ACTIVE", expiresAt: { gt: now } }, data: { status: "CLAIMED", claimedBy: killerId } });
          if (claim.count !== 1) return false;
          await post(tx, {
            from: system(LedgerAccountType.ESCROW, "CREDITS"), to: userWallet(killerId, "CREDITS"), amount: b.amount,
            type: "ESCROW", reference: b.id, idempotencyKey: `bounty:${b.id}`, userId: killerId, metadata: { kind: "BOUNTY_CLAIMED", targetId: victimId },
          });
          return true;
        });
        if (claimed) paid.push({ bountyId: b.id, amount: b.amount });
      } catch (err) {
        errorsTotal.inc({ component: "persistence", code: "bounty_payout" });
        this.log.error({ err, bountyId: b.id, victimId, killerId }, "bounty payout failed");
      }
    }
    return paid;
  }

  async createMatch(data: { roomId: string; mode: string; mapId: string; metadata?: Record<string, unknown> }): Promise<string> {
    const m = await this.db.gameMatch.create({ data: { roomId: data.roomId, mode: data.mode, mapId: data.mapId, metadata: (data.metadata ?? {}) as object } });
    return m.id;
  }

  /**
   * Atomically claim one of `limit` daily entries for `mode` (raids). The user row is locked FOR UPDATE, so
   * concurrent joins on any instance/process serialise: count + insert of the entry row happen in one
   * transaction. A pilot already enrolled in `matchId` (re-join) is admitted without consuming an entry.
   */
  async claimDailyMatchEntry(matchId: string, userId: string, mode: string, since: Date, limit: number): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
      const own = await tx.gameMatchPlayer.findUnique({ where: { matchId_userId: { matchId, userId } }, select: { id: true } });
      if (own) {
        await tx.gameMatchPlayer.update({ where: { id: own.id }, data: { leftAt: null } });
        return true;
      }
      const entries = await tx.gameMatchPlayer.count({ where: { userId, joinedAt: { gte: since }, match: { mode } } });
      if (entries >= limit) return false;
      await tx.gameMatchPlayer.create({ data: { matchId, userId, team: 0 } });
      return true;
    });
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
