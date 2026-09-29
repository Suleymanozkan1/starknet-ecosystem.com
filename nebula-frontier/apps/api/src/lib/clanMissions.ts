/**
 * Clan missions, derived from quests.json quests of type CLAN.
 *
 * Progress per objective:
 *  - untargeted objectives with a PlayerStat metric (KILL -> npcKills, KILL_PLAYER -> playerKills,
 *    WIN_PVP -> pvpWins, COMPLETE_GATE -> gatesCompleted, MINE_RESOURCES -> resourcesMined,
 *    CRAFT -> itemsCrafted, DAMAGE_BOSS -> bossDamage): sum over current members of
 *    (stat now - stat at mission start / when the member was first observed in their current
 *    membership, keyed by ClanMember.joinedAt). Deltas are exact bigints clamped to the objective
 *    count. Stats are written by the game server only, so progress is server-authoritative.
 *    Progress is refreshed by the `refreshClanMissions` job, on contributions and on claim; the
 *    missions GET endpoint is read-only.
 *  - targeted objectives (a specific NPC / item / map / gate): explicit contributions reported by
 *    the game server through `POST /api/internal/clan-missions/progress` (GameplayEvent), counted
 *    with the shared `objectiveIncrement` from @nebula/game-core.
 * Progress never decreases (members leaving keep what the clan already earned). Completing a
 * mission notifies members (MISSION_COMPLETE push); officers claim it: credits go into the clan
 * treasury (ledger GAME_ISSUANCE -> ESCROW + Clan.bankCredits) and XP into Clan.xp.
 */
import { QUESTS_BY_ID, QUESTS } from "@nebula/config";
import { post, system, withSerializableTx, type Db, type Tx } from "@nebula/database";
import { objectiveIncrement, questPeriodKey, type GameplayEvent } from "@nebula/game-core";
import { Currency, LedgerAccountType, LedgerTxType, type QuestDef, type QuestObjectiveDef } from "@nebula/shared";
import { badRequest, conflict, notFound } from "../errors.js";
import { asRecord, toJsonValue } from "./json.js";
import { PushType, notify } from "./notify.js";

export type Metric = "npcKills" | "playerKills" | "pvpWins" | "gatesCompleted" | "resourcesMined" | "itemsCrafted" | "bossDamage";

const METRIC_FOR: Partial<Record<string, Metric>> = {
  KILL: "npcKills",
  KILL_PLAYER: "playerKills",
  WIN_PVP: "pvpWins",
  COMPLETE_GATE: "gatesCompleted",
  MINE_RESOURCES: "resourcesMined",
  CRAFT: "itemsCrafted",
  DAMAGE_BOSS: "bossDamage",
};

export const CLAN_MISSIONS: readonly QuestDef[] = QUESTS.filter((q) => q.type === "CLAN");

/** Metric used for an objective, or null when it needs explicit contributions. */
export function statMetric(o: QuestObjectiveDef): Metric | null {
  if (o.target || o.map) return null;
  return METRIC_FOR[o.type] ?? null;
}

export function missionPeriod(q: QuestDef, now = new Date()): string {
  return q.repeatable ? questPeriodKey("WEEKLY", now) : "once";
}

const METRICS: readonly Metric[] = ["npcKills", "playerKills", "pvpWins", "gatesCompleted", "resourcesMined", "itemsCrafted", "bossDamage"];

/** Member stats as exact integers (resourcesMined / bossDamage are BigInt columns). */
export type StatRow = Record<Metric, bigint>;

/**
 * Baseline entry stored per member in `ClanMission.baseline` (JSON, no schema change):
 * `{ joinedAt: ISO string of ClanMember.joinedAt, stats: { [metric]: decimal string } }`.
 * Keyed to the membership (joinedAt) so a member who leaves and rejoins gets a fresh baseline.
 * Legacy entries (`{ [metric]: number }`, no joinedAt) are still read.
 */
export type BaselineEntry = { joinedAt: string | null; stats: StatRow };

type MemberSnapshot = { joinedAt: Date; stats: StatRow };

function toBig(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.trunc(v));
  if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
  return 0n;
}

function parseStats(v: unknown): StatRow {
  const r = asRecord(v);
  const out = {} as StatRow;
  for (const k of METRICS) out[k] = toBig(r[k]);
  return out;
}

/** Parse the stored baseline JSON (new `{ joinedAt, stats }` entries and legacy flat metric maps). */
export function parseBaseline(v: unknown): Map<string, BaselineEntry> {
  const out = new Map<string, BaselineEntry>();
  for (const [uid, raw] of Object.entries(asRecord(v))) {
    const e = asRecord(raw);
    if ("stats" in e) out.set(uid, { joinedAt: typeof e.joinedAt === "string" ? e.joinedAt : null, stats: parseStats(e.stats) });
    else out.set(uid, { joinedAt: null, stats: parseStats(e) });
  }
  return out;
}

function serializeBaseline(b: Map<string, BaselineEntry>): Record<string, { joinedAt: string | null; stats: Record<Metric, string> }> {
  const out: Record<string, { joinedAt: string | null; stats: Record<Metric, string> }> = {};
  for (const [uid, e] of b) {
    const stats = {} as Record<Metric, string>;
    for (const k of METRICS) stats[k] = e.stats[k].toString();
    out[uid] = { joinedAt: e.joinedAt, stats };
  }
  return out;
}

/**
 * Reconcile the stored baseline with the current members: a member without an entry, or whose
 * entry belongs to an earlier membership (different joinedAt), is (re)baselined at their current
 * stats. Legacy entries without joinedAt are kept only if the membership predates the mission start
 * (so it cannot be a stale entry from before a leave/rejoin); otherwise they are reset. Resetting
 * never lowers mission progress (progress is monotonic).
 */
export function reconcileBaseline(
  baseline: Map<string, BaselineEntry>, members: Map<string, MemberSnapshot>, missionStartedAt: Date,
): boolean {
  let changed = false;
  for (const [uid, mem] of members) {
    const joinedAt = mem.joinedAt.toISOString();
    const cur = baseline.get(uid);
    if (cur && cur.joinedAt === joinedAt) continue;
    if (cur && cur.joinedAt === null && mem.joinedAt.getTime() <= missionStartedAt.getTime()) {
      baseline.set(uid, { joinedAt, stats: cur.stats }); // legacy entry, same membership: stamp it
    } else {
      baseline.set(uid, { joinedAt, stats: { ...mem.stats } });
    }
    changed = true;
  }
  return changed;
}

/** Sum of member stat deltas for a metric, as bigint, clamped to [0, cap] before converting to number. */
export function metricProgress(metric: Metric, members: Map<string, MemberSnapshot>, baseline: Map<string, BaselineEntry>, cap: number): number {
  let v = 0n;
  for (const [uid, mem] of members) {
    const now = mem.stats[metric];
    const base = baseline.get(uid)?.stats[metric] ?? now;
    if (now > base) v += now - base;
  }
  const c = BigInt(Math.max(0, Math.floor(cap)));
  return Number(v > c ? c : v);
}

async function memberStats(tx: Tx | Db, clanId: string): Promise<Map<string, MemberSnapshot>> {
  const members = await tx.clanMember.findMany({ where: { clanId }, select: { userId: true, joinedAt: true, user: { select: { stats: true } } } });
  const out = new Map<string, MemberSnapshot>();
  for (const m of members) {
    const s = m.user.stats;
    out.set(m.userId, {
      joinedAt: m.joinedAt,
      stats: {
        npcKills: BigInt(s?.npcKills ?? 0),
        playerKills: BigInt(s?.playerKills ?? 0),
        pvpWins: BigInt(s?.pvpWins ?? 0),
        gatesCompleted: BigInt(s?.gatesCompleted ?? 0),
        resourcesMined: s?.resourcesMined ?? 0n,
        itemsCrafted: BigInt(s?.itemsCrafted ?? 0),
        bossDamage: s?.bossDamage ?? 0n,
      },
    });
  }
  return out;
}

export async function startMission(db: Db, clanId: string, questId: string, userId: string) {
  const q = QUESTS_BY_ID.get(questId);
  if (!q || q.type !== "CLAN") throw notFound("Clan mission");
  const starter = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { level: true } });
  if (starter.level < q.requiredLevel) throw badRequest("LEVEL_TOO_LOW", `Requires level ${q.requiredLevel}`);
  const stats = await memberStats(db, clanId);
  const baseline = new Map<string, BaselineEntry>();
  const startedAt = new Date();
  reconcileBaseline(baseline, stats, startedAt);
  try {
    return await db.clanMission.create({
      data: {
        clanId, questId, periodKey: missionPeriod(q, startedAt), startedBy: userId, startedAt,
        progress: q.objectives.map(() => 0), baseline: toJsonValue(serializeBaseline(baseline)),
      },
    });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") throw conflict("MISSION_ACTIVE", "This mission was already started for the current period");
    throw err;
  }
}

/** Recompute progress; transitions ACTIVE -> COMPLETED (and notifies members) when all objectives are met. */
export async function refreshMission(db: Db, missionId: string) {
  const res = await withSerializableTx(db, async (tx) => {
    const m = await tx.clanMission.findUnique({ where: { id: missionId } });
    if (!m) throw notFound("Clan mission");
    const q = QUESTS_BY_ID.get(m.questId);
    if (!q || m.status !== "ACTIVE") return { mission: m, completedNow: false };
    const stats = await memberStats(tx, m.clanId);
    const baseline = parseBaseline(m.baseline);
    const baselineChanged = reconcileBaseline(baseline, stats, m.startedAt);
    const contrib = asRecord(m.contributions);
    const progress = q.objectives.map((o, i) => {
      const metric = statMetric(o);
      const v = metric ? metricProgress(metric, stats, baseline, o.count) : Number(contrib[String(i)] ?? 0);
      return Math.min(o.count, Math.max(m.progress[i] ?? 0, Math.floor(v)));
    });
    const complete = q.objectives.every((o, i) => (progress[i] ?? 0) >= o.count);
    const changed = baselineChanged || progress.some((v, i) => v !== (m.progress[i] ?? 0)) || complete;
    if (!changed) return { mission: m, completedNow: false };
    const upd = await tx.clanMission.updateMany({
      where: { id: m.id, status: "ACTIVE" },
      data: {
        progress,
        ...(baselineChanged ? { baseline: toJsonValue(serializeBaseline(baseline)) } : {}),
        ...(complete ? { status: "COMPLETED", completedAt: new Date() } : {}),
      },
    });
    const mission = await tx.clanMission.findUniqueOrThrow({ where: { id: m.id } });
    return { mission, completedNow: complete && upd.count === 1 };
  });
  if (res.completedNow) {
    const q = QUESTS_BY_ID.get(res.mission.questId);
    const members = await db.clanMember.findMany({ where: { clanId: res.mission.clanId }, select: { userId: true } });
    for (const mem of members) {
      await notify(db, mem.userId, PushType.MISSION_COMPLETE, "Clan mission complete", `${q?.name ?? "A clan mission"} is complete. Officers can claim the reward.`, {
        clanId: res.mission.clanId, missionId: res.mission.id,
      });
    }
  }
  return res.mission;
}

/**
 * Apply a game-server gameplay event for a player to their clan's active missions (targeted objectives only).
 * Idempotent per `eventId`: a (missionId, eventId) receipt is inserted in the same transaction as the
 * contribution; a replayed event (retried request) conflicts on the unique key and is not counted again.
 */
export async function contributeToMissions(db: Db, userId: string, ev: GameplayEvent, eventId: string): Promise<number> {
  const member = await db.clanMember.findUnique({ where: { userId }, select: { clanId: true } });
  if (!member) return 0;
  const active = await db.clanMission.findMany({ where: { clanId: member.clanId, status: "ACTIVE" } });
  let touched = 0;
  for (const m of active) {
    const q = QUESTS_BY_ID.get(m.questId);
    if (!q) continue;
    const incs = q.objectives.map((o) => (statMetric(o) ? 0 : objectiveIncrement(o, ev)));
    if (!incs.some((x) => x > 0)) continue;
    const applied = await withSerializableTx(db, async (tx) => {
      const cur = await tx.clanMission.findUniqueOrThrow({ where: { id: m.id } });
      if (cur.status !== "ACTIVE") return false;
      // ON CONFLICT DO NOTHING: keeps the transaction usable and turns a replay into a no-op.
      const receipt = await tx.clanMissionEventReceipt.createMany({ data: [{ missionId: m.id, eventId, userId }], skipDuplicates: true });
      if (receipt.count === 0) return false;
      const c = asRecord(cur.contributions);
      incs.forEach((inc, i) => {
        if (inc > 0) c[String(i)] = Number(c[String(i)] ?? 0) + inc;
      });
      await tx.clanMission.update({ where: { id: m.id }, data: { contributions: toJsonValue(c) } });
      return true;
    });
    if (!applied) continue;
    await refreshMission(db, m.id);
    touched++;
  }
  return touched;
}

/** Claim a completed mission: credits into the clan treasury through the ledger, XP into the clan. */
export async function claimMission(db: Db, clanId: string, missionId: string, userId: string) {
  return withSerializableTx(db, async (tx) => {
    const m = await tx.clanMission.findFirst({ where: { id: missionId, clanId } });
    if (!m) throw notFound("Clan mission");
    if (m.status === "CLAIMED") throw conflict("ALREADY_CLAIMED", "Mission reward already claimed");
    if (m.status !== "COMPLETED") throw badRequest("MISSION_INCOMPLETE", "Mission objectives are not complete");
    const q = QUESTS_BY_ID.get(m.questId);
    if (!q) throw notFound("Mission definition");
    const upd = await tx.clanMission.updateMany({ where: { id: m.id, status: "COMPLETED", claimedAt: null }, data: { status: "CLAIMED", claimedAt: new Date() } });
    if (upd.count !== 1) throw conflict("ALREADY_CLAIMED", "Mission reward already claimed");
    const credits = BigInt(Math.max(0, Math.floor(q.rewards.credits ?? 0)));
    if (credits > 0n) {
      await post(tx, {
        from: system(LedgerAccountType.GAME_ISSUANCE, Currency.CREDITS),
        to: system(LedgerAccountType.ESCROW, Currency.CREDITS),
        amount: credits,
        type: LedgerTxType.GAME_REWARD,
        reference: m.id,
        idempotencyKey: `clanmission:${m.id}:credits`,
        userId,
        metadata: { kind: "CLAN_MISSION_REWARD", clanId, questId: q.id },
      });
      await tx.clan.update({ where: { id: clanId }, data: { bankCredits: { increment: credits } } });
    }
    const xp = BigInt(Math.max(0, Math.floor(q.rewards.xp ?? 0)));
    if (xp > 0n) await tx.clan.update({ where: { id: clanId }, data: { xp: { increment: xp }, score: { increment: xp / 100n } } });
    return { missionId: m.id, credits: credits.toString(), xp: xp.toString() };
  });
}
