/**
 * Hangar: owned ships + catalog, unlock (shop), activate, +1..+N upgrades, loadouts, cosmetics.
 */
import type { FastifyInstance } from "fastify";
import { post, system, userWallet, withSerializableTx } from "@nebula/database";
import { Currency, LedgerAccountType, LedgerTxType, type ShipInstanceDto } from "@nebula/shared";
import {
  createLoadoutSchema, equipCosmeticSchema, idSchema, shipActivateSchema, shipUnlockSchema, shipUpgradeSchema, updateLoadoutSchema,
} from "@nebula/validation";
import { badRequest, conflict, notFound } from "../errors.js";
import { getCatalog } from "../lib/catalog.js";
import { consumeResources } from "../lib/grants.js";
import { withIdempotency } from "../lib/idempotency.js";
import { emptyLoadout, isUniqueViolation, loadoutDto, parseLoadout, priorUpgradeAttempt, type UpgradeOutcome } from "../lib/inventory.js";
import { asRecord, toJsonValue } from "../lib/json.js";
import { MAX_UPGRADE_LEVEL, secureRoll, upgradeCostFor } from "../lib/progression.js";
import { purchaseProduct } from "../lib/purchase.js";
import { refreshShipStats } from "../lib/ships.js";

const MAX_LOADOUTS_PER_SHIP = 8;

export default async function shipRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app;
  const auth = { preHandler: app.authenticate };

  async function ownedShip(userId: string, shipInstanceId: string) {
    const inst = await db.shipInstance.findFirst({ where: { id: shipInstanceId, userId } });
    if (!inst) throw notFound("Ship");
    return inst;
  }

  async function shipDtos(userId: string): Promise<ShipInstanceDto[]> {
    const catalog = await getCatalog(db);
    const [user, ships] = await Promise.all([
      db.user.findUniqueOrThrow({ where: { id: userId }, select: { activeShipId: true } }),
      db.shipInstance.findMany({ where: { userId }, include: { loadouts: { orderBy: { createdAt: "asc" } }, stats: true }, orderBy: { createdAt: "asc" } }),
    ]);
    return ships.map((s) => ({
      id: s.id,
      defId: s.shipId,
      name: s.nickname ?? catalog.ships.get(s.shipId)?.name ?? s.shipId,
      upgradeLevel: s.upgradeLevel,
      active: user.activeShipId === s.id,
      loadouts: s.loadouts.map(loadoutDto),
      activeLoadoutId: s.activeLoadoutId,
      stats: (asRecord(s.stats?.stats) as Record<string, number>) ?? {},
      gearScore: s.stats?.gearScore ?? 0,
      cosmetics: asRecord(s.cosmetics) as Record<string, string>,
    }));
  }

  app.get("/api/ships", auth, async (req) => {
    const catalog = await getCatalog(db);
    const products = await db.shopProduct.findMany({ where: { active: true, category: "SHIPS" }, select: { id: true, currency: true, price: true, grants: true } });
    const productFor = (shipId: string) =>
      products.find((p) => ((asRecord(p.grants).ships as string[] | undefined) ?? []).includes(shipId));
    const owned = await shipDtos(req.user.id);
    const ownedIds = new Set(owned.map((o) => o.defId));
    return {
      owned,
      catalog: [...catalog.ships.values()]
        .filter((s) => s.active)
        .map((s) => {
          const p = productFor(s.id);
          return {
            id: s.id,
            name: s.name,
            class: s.class,
            tier: s.tier,
            rarity: s.rarity,
            faction: s.faction ?? null,
            description: s.description,
            stats: s.stats,
            slots: s.slots,
            visual: s.visual,
            abilities: s.abilities,
            owned: ownedIds.has(s.id),
            unlock: {
              requiredLevel: s.requiredLevel,
              product: p ? { productId: p.id, currency: p.currency, price: p.price.toString() } : null,
              method: p ? "SHOP" : s.faction ? "FACTION_STARTER" : "CRAFT_OR_EVENT",
            },
          };
        }),
    };
  });

  app.post("/api/ships/unlock", { preHandler: app.authenticate, config: { rateLimit: app.rateLimits.purchase } }, async (req) => {
    const body = app.parse(shipUnlockSchema, req.body);
    const products = await db.shopProduct.findMany({ where: { active: true, category: "SHIPS" }, select: { id: true, grants: true } });
    const p = products.find((x) => ((asRecord(x.grants).ships as string[] | undefined) ?? []).includes(body.shipId));
    if (!p) throw badRequest("NOT_PURCHASABLE", "This ship cannot be bought in the shop");
    const res = await purchaseProduct(db, req.user.id, { productId: p.id, quantity: 1, idempotencyKey: body.idempotencyKey });
    if (!res.duplicate) app.analytics.track("PURCHASE", req.user.id, { purchaseId: res.purchaseId, productId: p.id, quantity: 1, shipId: body.shipId });
    return { ...res, ships: await shipDtos(req.user.id) };
  });

  app.post("/api/ships/activate", auth, async (req) => {
    const body = app.parse(shipActivateSchema, req.body);
    const inst = await ownedShip(req.user.id, body.shipInstanceId);
    await db.user.update({ where: { id: req.user.id }, data: { activeShipId: inst.id } });
    await refreshShipStats(db, inst.id, await getCatalog(db));
    return { ships: await shipDtos(req.user.id) };
  });

  app.post("/api/ships/upgrade", { preHandler: app.authenticate, config: { rateLimit: app.rateLimits.purchase } }, async (req) => {
    const body = app.parse(shipUpgradeSchema, req.body);
    const userId = req.user.id;
    return withIdempotency(app.redis, "ship-upgrade", userId, body.idempotencyKey, async () => {
      let result: UpgradeOutcome & { shipInstanceId: string };
      try {
        result = await withSerializableTx(db, async (tx) => {
          // Durable idempotency: a retry (even after the Redis cache was lost) returns the stored
          // outcome instead of consuming the cost again and re-rolling.
          const prior = await priorUpgradeAttempt(tx, userId, "SHIP", body.idempotencyKey, body.shipInstanceId);
          if (prior) return { ...prior, shipInstanceId: body.shipInstanceId };
          const inst = await tx.shipInstance.findFirst({ where: { id: body.shipInstanceId, userId } });
          if (!inst) throw notFound("Ship");
          if (inst.upgradeLevel >= MAX_UPGRADE_LEVEL) throw badRequest("MAX_LEVEL", `Ship is already +${MAX_UPGRADE_LEVEL}`);
          const cost = upgradeCostFor(inst.upgradeLevel);
          const success = secureRoll() < cost.successChance;
          const toLevel = success ? cost.toLevel : inst.upgradeLevel;
          // Claimed before any posting: a concurrent duplicate blocks here and then fails on the unique key.
          const attempt = await tx.upgradeAttempt.create({
            data: { userId, kind: "SHIP", targetId: inst.id, idempotencyKey: body.idempotencyKey, success, fromLevel: inst.upgradeLevel, toLevel, cost: toJsonValue(cost) },
          });
          const ref = `ship-upgrade:${userId}:${body.idempotencyKey}`;
          if (cost.credits > 0n) {
            await post(tx, {
              from: userWallet(userId, Currency.CREDITS), to: system(LedgerAccountType.GAME_SINK, Currency.CREDITS),
              amount: cost.credits, type: LedgerTxType.GAME_SINK, reference: inst.id, idempotencyKey: `${ref}:credits`, userId,
              metadata: { kind: "SHIP_UPGRADE", from: inst.upgradeLevel, attemptId: attempt.id },
            });
          }
          if (cost.gems > 0n) {
            await post(tx, {
              from: userWallet(userId, Currency.GEMS), to: system(LedgerAccountType.PREMIUM_REVENUE, Currency.GEMS),
              amount: cost.gems, type: LedgerTxType.PURCHASE, reference: inst.id, idempotencyKey: `${ref}:gems`, userId,
              metadata: { kind: "SHIP_UPGRADE", from: inst.upgradeLevel, attemptId: attempt.id },
            });
          }
          await consumeResources(tx, userId, cost.resources);
          if (success) {
            const upd = await tx.shipInstance.updateMany({ where: { id: inst.id, upgradeLevel: inst.upgradeLevel }, data: { upgradeLevel: { increment: 1 } } });
            if (upd.count !== 1) throw conflict("CONCURRENT_UPGRADE", "Ship was upgraded concurrently");
          }
          await tx.shipUpgrade.create({
            data: { shipInstanceId: inst.id, fromLevel: inst.upgradeLevel, toLevel, success, cost: attempt.cost ?? {} },
          });
          return { success, fromLevel: attempt.fromLevel, toLevel, cost: attempt.cost, shipInstanceId: inst.id };
        });
      } catch (err) {
        // A concurrent request with the same key won the unique UpgradeAttempt row.
        const prior = isUniqueViolation(err) ? await priorUpgradeAttempt(db, userId, "SHIP", body.idempotencyKey, body.shipInstanceId) : null;
        if (!prior) throw err;
        result = { ...prior, shipInstanceId: body.shipInstanceId };
      }
      await refreshShipStats(db, result.shipInstanceId, await getCatalog(db));
      return { ...result, ships: await shipDtos(userId) };
    });
  });

  app.get<{ Params: { id: string } }>("/api/ships/:id/upgrade-cost", auth, async (req) => {
    const inst = await ownedShip(req.user.id, app.parse(idSchema, req.params.id));
    if (inst.upgradeLevel >= MAX_UPGRADE_LEVEL) return { maxed: true, cost: null };
    return { maxed: false, cost: upgradeCostFor(inst.upgradeLevel) };
  });

  // ---- Loadouts ----
  app.post<{ Params: { id: string } }>("/api/ships/:id/loadouts", auth, async (req) => {
    const inst = await ownedShip(req.user.id, app.parse(idSchema, req.params.id));
    const body = app.parse(createLoadoutSchema, req.body);
    const count = await db.shipLoadout.count({ where: { shipInstanceId: inst.id } });
    if (count >= MAX_LOADOUTS_PER_SHIP) throw badRequest("TOO_MANY_LOADOUTS", `At most ${MAX_LOADOUTS_PER_SHIP} loadouts per ship`);
    const def = (await getCatalog(db)).ships.get(inst.shipId);
    if (!def) throw notFound("Ship definition");
    let config = emptyLoadout(def.slots);
    if (body.copyFromLoadoutId) {
      const src = await db.shipLoadout.findFirst({ where: { id: body.copyFromLoadoutId, shipInstanceId: inst.id } });
      if (!src) throw notFound("Loadout");
      config = parseLoadout(src.config);
    }
    const lo = await db.shipLoadout.create({ data: { shipInstanceId: inst.id, name: body.name, preset: body.preset, config: config as object } });
    return loadoutDto(lo);
  });

  app.put<{ Params: { id: string; loadoutId: string } }>("/api/ships/:id/loadouts/:loadoutId", auth, async (req) => {
    const inst = await ownedShip(req.user.id, app.parse(idSchema, req.params.id));
    const body = app.parse(updateLoadoutSchema, req.body);
    const lo = await db.shipLoadout.findFirst({ where: { id: app.parse(idSchema, req.params.loadoutId), shipInstanceId: inst.id } });
    if (!lo) throw notFound("Loadout");
    const cfg = parseLoadout(lo.config);
    if (body.formation) cfg.formation = body.formation;
    if (body.ammo !== undefined) {
      if (body.ammo) {
        const has = await db.inventoryItem.findFirst({ where: { userId: req.user.id, itemId: body.ammo }, select: { id: true } });
        if (!has) throw badRequest("AMMO_NOT_OWNED", "You do not own this ammunition");
      }
      cfg.ammo = body.ammo;
    }
    const updated = await db.shipLoadout.update({
      where: { id: lo.id },
      data: { ...(body.name ? { name: body.name } : {}), ...(body.preset ? { preset: body.preset } : {}), config: cfg as object },
    });
    return loadoutDto(updated);
  });

  app.post<{ Params: { id: string; loadoutId: string } }>("/api/ships/:id/loadouts/:loadoutId/activate", auth, async (req) => {
    const inst = await ownedShip(req.user.id, app.parse(idSchema, req.params.id));
    const lo = await db.shipLoadout.findFirst({ where: { id: app.parse(idSchema, req.params.loadoutId), shipInstanceId: inst.id } });
    if (!lo) throw notFound("Loadout");
    await db.shipInstance.update({ where: { id: inst.id }, data: { activeLoadoutId: lo.id } });
    await refreshShipStats(db, inst.id, await getCatalog(db));
    return { ships: await shipDtos(req.user.id) };
  });

  app.delete<{ Params: { id: string; loadoutId: string } }>("/api/ships/:id/loadouts/:loadoutId", auth, async (req) => {
    const inst = await ownedShip(req.user.id, app.parse(idSchema, req.params.id));
    const loadoutId = app.parse(idSchema, req.params.loadoutId);
    if (inst.activeLoadoutId === loadoutId) throw badRequest("ACTIVE_LOADOUT", "Cannot delete the active loadout");
    const r = await db.shipLoadout.deleteMany({ where: { id: loadoutId, shipInstanceId: inst.id } });
    if (r.count !== 1) throw notFound("Loadout");
    return { ok: true };
  });

  // ---- Cosmetics ----
  app.post("/api/ships/cosmetics", auth, async (req) => {
    const body = app.parse(equipCosmeticSchema, req.body);
    const inst = await ownedShip(req.user.id, body.shipInstanceId);
    const cosmetics = asRecord(inst.cosmetics) as Record<string, string>;
    if (body.inventoryItemId === null) {
      delete cosmetics[body.slot];
    } else {
      const inv = await db.inventoryItem.findFirst({ where: { id: body.inventoryItemId, userId: req.user.id, lockedBy: null } });
      if (!inv) throw notFound("Item");
      const def = (await getCatalog(db)).items.get(inv.itemId);
      const payload = def?.cosmeticPayload;
      if (!def || (def.category !== "SKIN" && def.category !== "COSMETIC") || !payload) throw badRequest("NOT_COSMETIC", "Item is not a cosmetic");
      if (payload.slot !== body.slot) throw badRequest("WRONG_SLOT", `Item fits the ${payload.slot} slot`);
      if (payload.shipId && payload.shipId !== inst.shipId) throw badRequest("WRONG_SHIP", "This skin is for a different ship");
      cosmetics[body.slot] = inv.itemId;
    }
    await db.shipInstance.update({ where: { id: inst.id }, data: { cosmetics } });
    return { ships: await shipDtos(req.user.id) };
  });
}
