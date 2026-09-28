/**
 * Crafting: blueprints (config), start jobs (consume credits/resources/items), claim after
 * completion with a server-side success roll. Output items get unique originRef `craft:<jobId>`.
 */
import type { FastifyInstance } from "fastify";
import { BLUEPRINTS, BLUEPRINTS_BY_ID } from "@nebula/config";
import { post, system, userWallet, withSerializableTx } from "@nebula/database";
import { craftCompletesAt, craftCost, rollCraft } from "@nebula/game-core";
import { Currency, LedgerAccountType, LedgerTxType } from "@nebula/shared";
import { craftStartSchema, idSchema } from "@nebula/validation";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { getCatalog } from "../lib/catalog.js";
import { consumeResources } from "../lib/grants.js";
import { withIdempotency } from "../lib/idempotency.js";
import { equippedMap, grantItems } from "../lib/inventory.js";
import { secureRoll } from "../lib/progression.js";
import { loadRules } from "../lib/rules.js";

export default async function craftingRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app;
  const auth = { preHandler: app.authenticate };

  app.get("/api/crafting/blueprints", auth, async (req) => {
    const jobs = await db.craftJob.findMany({ where: { userId: req.user.id, claimedAt: null }, orderBy: { startedAt: "desc" } });
    return {
      blueprints: BLUEPRINTS,
      jobs: jobs.map((j) => ({
        id: j.id, blueprintId: j.blueprintId, status: j.status, startedAt: j.startedAt.toISOString(),
        completesAt: j.completesAt.toISOString(), ready: j.completesAt.getTime() <= Date.now(),
      })),
    };
  });

  app.post("/api/crafting/start", { preHandler: app.authenticate, config: { rateLimit: app.rateLimits.purchase } }, async (req) => {
    const body = app.parse(craftStartSchema, req.body);
    const bp = BLUEPRINTS_BY_ID.get(body.blueprintId);
    if (!bp) throw notFound("Blueprint");
    const userId = req.user.id;
    const rules = await loadRules(db);
    return withIdempotency(app.redis, "craft", userId, body.idempotencyKey, async () => {
      const equipped = await equippedMap(db, userId);
      const job = await withSerializableTx(db, async (tx) => {
        const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { level: true } });
        if (user.level < bp.requiredLevel) throw forbidden(`Requires level ${bp.requiredLevel}`, "LEVEL_TOO_LOW");
        const running = await tx.craftJob.count({ where: { userId, status: "IN_PROGRESS" } });
        if (running >= rules.craftingMaxConcurrent) throw badRequest("CRAFT_QUEUE_FULL", `At most ${rules.craftingMaxConcurrent} concurrent crafts`);
        const cost = craftCost(bp);
        const now = new Date();
        const created = await tx.craftJob.create({ data: { userId, blueprintId: bp.id, completesAt: craftCompletesAt(bp, now) } });
        if (cost.credits > 0) {
          await post(tx, {
            from: userWallet(userId, Currency.CREDITS), to: system(LedgerAccountType.GAME_SINK, Currency.CREDITS),
            amount: BigInt(cost.credits), type: LedgerTxType.GAME_SINK, reference: created.id, idempotencyKey: `craft:${created.id}:credits`, userId,
            metadata: { kind: "CRAFT", blueprintId: bp.id },
          });
        }
        await consumeResources(tx, userId, cost.resources);
        // Consume input items (unlocked, unequipped stacks only).
        for (const need of cost.items) {
          let remaining = need.quantity;
          const stacks = await tx.inventoryItem.findMany({ where: { userId, itemId: need.itemId, lockedBy: null }, orderBy: { quantity: "asc" } });
          for (const s of stacks) {
            if (remaining <= 0) break;
            if (equipped.has(s.id)) continue;
            const take = Math.min(remaining, s.quantity);
            if (take === s.quantity) {
              const del = await tx.inventoryItem.deleteMany({ where: { id: s.id, version: s.version, lockedBy: null } });
              if (del.count !== 1) throw conflict("CONCURRENT_UPDATE", "Inventory changed concurrently, retry");
            } else {
              const upd = await tx.inventoryItem.updateMany({
                where: { id: s.id, version: s.version, lockedBy: null },
                data: { quantity: { decrement: take }, version: { increment: 1 } },
              });
              if (upd.count !== 1) throw conflict("CONCURRENT_UPDATE", "Inventory changed concurrently, retry");
            }
            remaining -= take;
          }
          if (remaining > 0) throw badRequest("MISSING_ITEMS", `Not enough ${need.itemId}`);
        }
        return created;
      });
      return { id: job.id, blueprintId: job.blueprintId, status: job.status, completesAt: job.completesAt.toISOString() };
    });
  });

  app.post<{ Params: { id: string } }>("/api/crafting/:id/claim", auth, async (req) => {
    const jobId = app.parse(idSchema, req.params.id);
    const userId = req.user.id;
    const catalog = await getCatalog(db);
    return withSerializableTx(db, async (tx) => {
      const job = await tx.craftJob.findFirst({ where: { id: jobId, userId } });
      if (!job) throw notFound("Craft job");
      if (job.claimedAt) throw conflict("ALREADY_CLAIMED", "Craft already claimed");
      if (job.completesAt.getTime() > Date.now()) throw badRequest("NOT_READY", "Crafting is not finished yet");
      const bp = BLUEPRINTS_BY_ID.get(job.blueprintId);
      if (!bp) throw notFound("Blueprint");
      const roll = rollCraft(bp, secureRoll);
      const claimed = await tx.craftJob.updateMany({
        where: { id: job.id, claimedAt: null },
        data: { claimedAt: new Date(), status: roll.success ? "COMPLETED" : "FAILED", success: roll.success },
      });
      if (claimed.count !== 1) throw conflict("ALREADY_CLAIMED", "Craft already claimed");
      let items: string[] = [];
      if (roll.success) {
        items = await grantItems(tx, userId, [{ itemId: roll.outputItem, quantity: roll.quantity }], `craft:${job.id}`, catalog.items);
        await tx.playerStat.upsert({ where: { userId }, create: { userId, itemsCrafted: 1 }, update: { itemsCrafted: { increment: 1 } } });
      }
      return { success: roll.success, outputItem: roll.outputItem, quantity: roll.quantity, inventoryItemIds: items };
    });
  });
}
