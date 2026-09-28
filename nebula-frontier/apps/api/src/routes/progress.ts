/**
 * Achievements (evaluated server-side from authoritative PlayerStat metrics) and battle pass
 * (tier claims are single-use via an atomic array_append guarded by NOT ANY()).
 */
import type { FastifyInstance } from "fastify";
import { ACHIEVEMENTS, ACHIEVEMENTS_BY_ID, BATTLE_PASSES, SHOP_BY_SKU } from "@nebula/config";
import { newlyUnlockedAchievements } from "@nebula/game-core";
import { battlePassClaimSchema, defIdSchema } from "@nebula/validation";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { activeSeasonId, grantBundle, settleCrypto } from "../lib/grants.js";

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
      return grantBundle(tx, userId, def.rewards, `ach:${userId}:${achievementId}`, `achievement:${achievementId}`);
    });
    await settleCrypto(db, userId, grant, `ach:${achievementId}`, `Achievement ${def.name}`);
    return { ok: true, items: grant.items };
  });

  // ------------------------------------------------------------------ battle pass
  app.get("/api/battlepass", auth, async (req) => {
    const seasonId = await activeSeasonId(db);
    const pass = seasonId ? BATTLE_PASSES.find((p) => p.seasonId === seasonId) : undefined;
    if (!seasonId || !pass) return { active: false, pass: null };
    const row = await db.battlePass.findUnique({ where: { userId_seasonId: { userId: req.user.id, seasonId } } });
    const product = SHOP_BY_SKU.get(pass.premiumProductSku);
    return {
      active: true,
      seasonId,
      pass: { id: pass.id, name: pass.name, tiers: pass.tiers },
      premiumProductId: product?.id ?? null,
      state: {
        xp: row?.xp ?? 0,
        tier: row?.tier ?? 0,
        premium: row?.premium ?? false,
        claimedFree: row?.claimedFree ?? [],
        claimedPremium: row?.claimedPremium ?? [],
      },
    };
  });

  app.post("/api/battlepass/claim", auth, async (req) => {
    const body = app.parse(battlePassClaimSchema, req.body);
    const userId = req.user.id;
    const seasonId = await activeSeasonId(db);
    const pass = seasonId ? BATTLE_PASSES.find((p) => p.seasonId === seasonId) : undefined;
    if (!seasonId || !pass) throw badRequest("NO_ACTIVE_PASS", "No active battle pass");
    const tierDef = pass.tiers.find((t) => t.tier === body.tier);
    if (!tierDef) throw notFound("Tier");
    const bundle = body.track === "free" ? tierDef.free : tierDef.premium;
    if (!bundle) throw badRequest("NO_REWARD", "This tier has no reward on that track");
    const res = await db.$transaction(async (tx) => {
      const bp = await tx.battlePass.findUnique({ where: { userId_seasonId: { userId, seasonId } } });
      if (!bp || bp.tier < body.tier) throw forbidden("Tier not reached yet", "TIER_LOCKED");
      if (body.track === "premium" && !bp.premium) throw forbidden("Premium pass required", "PREMIUM_REQUIRED");
      const n = body.track === "free"
        ? await tx.$executeRaw`UPDATE "BattlePass" SET "claimedFree" = array_append("claimedFree", ${body.tier}), "updatedAt" = now() WHERE id = ${bp.id} AND NOT (${body.tier} = ANY("claimedFree"))`
        : await tx.$executeRaw`UPDATE "BattlePass" SET "claimedPremium" = array_append("claimedPremium", ${body.tier}), "updatedAt" = now() WHERE id = ${bp.id} AND NOT (${body.tier} = ANY("claimedPremium"))`;
      if (n !== 1) throw conflict("ALREADY_CLAIMED", "Tier reward already claimed");
      return grantBundle(tx, userId, bundle, `bp:${seasonId}:${body.track}:${body.tier}:${userId}`, `battlepass:${pass.id}:${body.tier}`);
    });
    return { ok: true, items: res.items };
  });
}
