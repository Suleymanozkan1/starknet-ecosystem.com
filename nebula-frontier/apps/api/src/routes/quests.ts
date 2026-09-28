/**
 * Quests: availability, accept and claim. Progress is written ONLY by the game server
 * (UserQuest.progress); the API only checks that recorded progress meets objective counts.
 */
import type { FastifyInstance } from "fastify";
import { QUESTS, QUESTS_BY_ID } from "@nebula/config";
import { questPeriodKey } from "@nebula/game-core";
import type { QuestDef, QuestDto } from "@nebula/shared";
import { questAcceptSchema, questClaimSchema } from "@nebula/validation";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { grantBundle, settleCrypto } from "../lib/grants.js";
import { loadRules } from "../lib/rules.js";

const REPEATING = new Set(["DAILY", "WEEKLY", "MONTHLY"]);

function periodFor(q: QuestDef, now = new Date()): string {
  return REPEATING.has(q.type) ? questPeriodKey(q.type, now) : "once";
}

function objectiveProgress(q: QuestDef, progress: number[], level: number): number[] {
  return q.objectives.map((o, i) => (o.type === "LEVEL" ? Math.min(o.count, Math.max(progress[i] ?? 0, level)) : Math.min(o.count, progress[i] ?? 0)));
}

function isComplete(q: QuestDef, progress: number[], level: number): boolean {
  const p = objectiveProgress(q, progress, level);
  return q.objectives.every((o, i) => (p[i] ?? 0) >= o.count);
}

export default async function questRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app;
  const auth = { preHandler: app.authenticate };

  async function context(userId: string) {
    const [user, rows, activeDefs] = await Promise.all([
      db.user.findUniqueOrThrow({ where: { id: userId }, select: { level: true, playerFaction: { select: { factionId: true } } } }),
      db.userQuest.findMany({ where: { userId } }),
      db.quest.findMany({ where: { active: true }, select: { id: true } }),
    ]);
    return { user, rows, activeIds: new Set(activeDefs.map((d) => d.id)) };
  }

  function toDto(q: QuestDef, row: { id: string; status: string; progress: number[] } | null, level: number): QuestDto {
    const progress = objectiveProgress(q, row?.progress ?? [], level);
    const complete = isComplete(q, progress, level);
    return {
      id: row?.id ?? "",
      questId: q.id,
      name: q.name,
      type: q.type,
      description: q.description,
      objectives: q.objectives.map((o, i) => ({ type: o.type, ...(o.target ? { target: o.target } : {}), count: o.count, progress: progress[i] ?? 0 })),
      status: row?.status === "CLAIMED" ? "CLAIMED" : complete && row ? "COMPLETED" : "ACTIVE",
      rewards: q.rewards,
    };
  }

  app.get("/api/quests", auth, async (req) => {
    const { user, rows, activeIds } = await context(req.user.id);
    const claimedOnce = new Set(rows.filter((r) => r.status === "CLAIMED").map((r) => r.questId));
    const active: QuestDto[] = [];
    const available: QuestDto[] = [];
    for (const q of QUESTS) {
      if (activeIds.size && !activeIds.has(q.id)) continue;
      const period = periodFor(q);
      const row = rows.find((r) => r.questId === q.id && r.periodKey === period) ?? null;
      if (row) {
        active.push(toDto(q, row, user.level));
        continue;
      }
      if (!q.repeatable && claimedOnce.has(q.id)) continue;
      if (q.requiredLevel > user.level) continue;
      if (q.faction && q.faction !== user.playerFaction?.factionId) continue;
      if (!q.prerequisites.every((p) => claimedOnce.has(p))) continue;
      available.push(toDto(q, null, user.level));
    }
    return { active, available };
  });

  app.post("/api/quests/accept", auth, async (req) => {
    const { questId } = app.parse(questAcceptSchema, req.body);
    const q = QUESTS_BY_ID.get(questId);
    if (!q) throw notFound("Quest");
    const { user, rows, activeIds } = await context(req.user.id);
    if (activeIds.size && !activeIds.has(q.id)) throw badRequest("QUEST_DISABLED", "Quest is not available");
    if (q.requiredLevel > user.level) throw forbidden(`Requires level ${q.requiredLevel}`, "LEVEL_TOO_LOW");
    if (q.faction && q.faction !== user.playerFaction?.factionId) throw forbidden("Quest belongs to another faction", "WRONG_FACTION");
    const claimed = new Set(rows.filter((r) => r.status === "CLAIMED").map((r) => r.questId));
    if (!q.prerequisites.every((p) => claimed.has(p))) throw forbidden("Prerequisites not completed", "PREREQUISITES");
    if (!q.repeatable && rows.some((r) => r.questId === q.id)) throw conflict("QUEST_ALREADY_TAKEN", "Quest already accepted");
    const rules = await loadRules(db);
    if (rows.filter((r) => r.status !== "CLAIMED").length >= rules.maxActiveQuests) throw badRequest("TOO_MANY_QUESTS", "Quest log is full");
    try {
      const row = await db.userQuest.create({
        data: { userId: req.user.id, questId: q.id, periodKey: periodFor(q), progress: q.objectives.map(() => 0) },
      });
      return toDto(q, row, user.level);
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") throw conflict("QUEST_ALREADY_TAKEN", "Quest already accepted for this period");
      throw err;
    }
  });

  app.post("/api/quests/claim", auth, async (req) => {
    const { userQuestId } = app.parse(questClaimSchema, req.body);
    const userId = req.user.id;
    const out = await db.$transaction(async (tx) => {
      const row = await tx.userQuest.findFirst({ where: { id: userQuestId, userId } });
      if (!row) throw notFound("Quest");
      const q = QUESTS_BY_ID.get(row.questId);
      if (!q) throw notFound("Quest definition");
      if (row.status === "CLAIMED") throw conflict("ALREADY_CLAIMED", "Quest rewards already claimed");
      const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { level: true } });
      if (!isComplete(q, row.progress, user.level)) throw badRequest("QUEST_INCOMPLETE", "Quest objectives are not complete");
      // Atomic single claim.
      const upd = await tx.userQuest.updateMany({
        where: { id: row.id, claimedAt: null },
        data: { status: "CLAIMED", claimedAt: new Date(), completedAt: row.completedAt ?? new Date() },
      });
      if (upd.count !== 1) throw conflict("ALREADY_CLAIMED", "Quest rewards already claimed");
      const grant = await grantBundle(tx, userId, q.rewards, `quest:${row.id}`, `quest:${q.id}`);
      return { grant, questId: q.id, rowId: row.id };
    });
    await settleCrypto(db, userId, out.grant, `quest:${out.rowId}`, `Quest ${out.questId}`);
    return { ok: true, questId: out.questId, levelBefore: out.grant.levelBefore, levelAfter: out.grant.levelAfter, items: out.grant.items };
  });
}
