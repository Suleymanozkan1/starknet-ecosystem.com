/**
 * Achievements, evaluated server-side from authoritative PlayerStat metrics; rewards claimed once.
 */
import type { FastifyInstance } from "fastify";
import { ACHIEVEMENTS, ACHIEVEMENTS_BY_ID } from "@nebula/config";
import { newlyUnlockedAchievements } from "@nebula/game-core";
import { defIdSchema } from "@nebula/validation";
import { conflict, forbidden, notFound } from "../errors.js";
import { grantBundle } from "../lib/grants.js";
import { enqueueRewardSettlement, settleRewardSettlement } from "../lib/rewardOutbox.js";

export default async function progressRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app;
  const auth = { preHandler: app.authenticate };

  async function metrics(userId: string): Promise<Record<string, number>> {
    const [u, s, clanLead, sales, bp] = await Promise.all([
      db.user.findUniqueOrThrow({ where: { id: userId }, select: { level: true } }),
      db.playerStat.findUnique({ where: { userId } }),
      db.clanMember.count({ where: { userId, role: "LEADER" } }),
      db.trade.count({ where: { sellerId: userId } }),
      db.battlePass.findFirst({ where: { userId }, orderBy: { tier: "desc" }, select: { tier: true } }),
    ]);
    return {
      level: u.level,
      npc_kills: s?.npcKills ?? 0,
      player_kills: s?.playerKills ?? 0,
      boss_kills: s?.bossKills ?? 0,
      gates_completed: s?.gatesCompleted ?? 0,
      resources_mined: Number(s?.resourcesMined ?? 0n),
      maps_visited: s?.mapsVisited.length ?? 0,
      items_crafted: s?.itemsCrafted ?? 0,
      pvp_wins: s?.pvpWins ?? 0,
      clan_created: clanLead,
      market_sales: sales,
      battlepass_tier: bp?.tier ?? 0,
    };
  }

  app.get("/api/achievements", auth, async (req) => {
    const userId = req.user.id;
    const [m, rows] = await Promise.all([metrics(userId), db.userAchievement.findMany({ where: { userId } })]);
    const unlocked = new Set(rows.map((r) => r.achievementId));
    const fresh = newlyUnlockedAchievements(ACHIEVEMENTS, m, unlocked);
    if (fresh.length) {
      await db.userAchievement.createMany({ data: fresh.map((a) => ({ userId, achievementId: a.id })), skipDuplicates: true });
      for (const a of fresh) unlocked.add(a.id);
    }
    const all = await db.userAchievement.findMany({ where: { userId } });
    const byId = new Map(all.map((r) => [r.achievementId, r]));
    return {
      achievements: ACHIEVEMENTS.filter((a) => !a.hidden || unlocked.has(a.id)).map((a) => ({
        id: a.id, name: a.name, description: a.description, category: a.category, metric: a.metric, threshold: a.threshold,
        progress: Math.min(a.threshold, m[a.metric] ?? 0), rewards: a.rewards,
        unlocked: unlocked.has(a.id), unlockedAt: byId.get(a.id)?.unlockedAt.toISOString() ?? null, claimed: byId.get(a.id)?.claimed ?? false,
      })),
    };
  });

  app.post<{ Params: { id: string } }>("/api/achievements/:id/claim", auth, async (req) => {
    const achievementId = app.parse(defIdSchema, req.params.id);
    const def = ACHIEVEMENTS_BY_ID.get(achievementId);
    if (!def) throw notFound("Achievement");
    const userId = req.user.id;
    const grant = await db.$transaction(async (tx) => {
      const upd = await tx.userAchievement.updateMany({ where: { userId, achievementId, claimed: false }, data: { claimed: true } });
      if (upd.count !== 1) {
        const row = await tx.userAchievement.findUnique({ where: { userId_achievementId: { userId, achievementId } } });
        if (!row) throw forbidden("Achievement not unlocked", "NOT_UNLOCKED");
        throw conflict("ALREADY_CLAIMED", "Achievement reward already claimed");
      }
      const g = await grantBundle(tx, userId, def.rewards, `ach:${userId}:${achievementId}`, `achievement:${achievementId}`);
      // Outbox row in the claim tx: the crypto reward survives a crash / engine failure after commit.
      const settlementId = await enqueueRewardSettlement(tx, userId, g, `ach:${achievementId}`, `Achievement ${def.name}`);
      return { ...g, settlementId };
    });
    if (grant.settlementId) {
      await settleRewardSettlement(db, grant.settlementId, { log: req.log }).catch((err: unknown) => req.log.warn({ err }, "reward settlement deferred to outbox job"));
    }
    app.analytics.track("REWARD_CLAIM", userId, { source: "ACHIEVEMENT", achievementId });
    return { ok: true, items: grant.items };
  });


}
