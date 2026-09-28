import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { idSchema } from "@nebula/validation";
import { claimRewards } from "@nebula/economy";
import { badRequest } from "../errors.js";
import { balancesDto } from "../lib/balances.js";

const claimSchema = z
  .object({
    rewardId: idSchema.optional(),
    rewardIds: z.array(idSchema).min(1).max(100).optional(),
    all: z.boolean().optional()
  })
  .refine((b) => !!b.rewardId || !!b.rewardIds?.length || b.all === true, "rewardId, rewardIds or all is required");

const plugin: FastifyPluginAsync = async (app) => {
  const db = app.db;

  /** Claim Battle / Season / Tournament Rewards into the in-game NEBX balance (idempotent per reward). */
  app.post("/api/rewards/claim", { preHandler: [app.authenticate, app.rateLimitStrict], config: { rateLimit: app.rateLimits.wallet } }, async (req) => {
    const body = app.parse(claimSchema, req.body);
    const userId = req.user.id;
    let ids = body.rewardIds ?? (body.rewardId ? [body.rewardId] : []);
    if (body.all) {
      const rows = await db.reward.findMany({
        where: { userId, status: "CLAIMABLE", OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        select: { id: true },
        orderBy: { createdAt: "asc" },
        take: 100
      });
      ids = rows.map((r) => r.id);
    }
    if (!ids.length) throw badRequest("NOTHING_TO_CLAIM", "No claimable rewards");
    const result = await claimRewards(db, userId, ids);
    if (!result.claimed.length && result.errors.length) {
      const first = result.errors[0] as { code: string; message: string };
      throw badRequest(first.code, first.message, result.errors);
    }
    const fresh = result.claimed.filter((c) => !c.alreadyClaimed);
    if (fresh.length) {
      await app.audit(req, {
        action: "REWARD_CLAIM",
        targetType: "Reward",
        targetId: fresh.map((c) => c.rewardId).join(",").slice(0, 190),
        newValue: { count: fresh.length, total: fresh.reduce((s, c) => s + c.amount, 0n).toString() }
      });
    }
    return {
      claimed: result.claimed.map((c) => ({ rewardId: c.rewardId, amount: c.amount.toString(), alreadyClaimed: c.alreadyClaimed })),
      errors: result.errors,
      balances: await balancesDto(db, userId)
    };
  });
};

export default plugin;
