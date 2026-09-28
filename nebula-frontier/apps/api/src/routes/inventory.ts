/**
 * Inventory listing, equip/unequip into ship loadouts and item upgrades.
 * All mutations run in SERIALIZABLE transactions with ownership + lock checks, so an item can never
 * be equipped while listed/escrowed (lockedBy) nor listed while equipped.
 */
import type { FastifyInstance } from "fastify";
import { ECONOMY, WEAPONS_BY_ID } from "@nebula/config";
import { post, system, userWallet, withSerializableTx, type Tx } from "@nebula/database";
import { Currency, LedgerAccountType, LedgerTxType, RARITY_ORDER, type InventoryResponse } from "@nebula/shared";
import { equipRequestSchema, inventoryQuerySchema, unequipRequestSchema, upgradeItemSchema } from "@nebula/validation";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { getCatalog, type Catalog } from "../lib/catalog.js";
import { consumeResources } from "../lib/grants.js";
import { withIdempotency } from "../lib/idempotency.js";
import { equippedMap, inventoryDto, loadoutDto, loadoutItemIds, parseLoadout, slotCount, slotFamilyFor, type SlotType } from "../lib/inventory.js";
import { toJsonValue } from "../lib/json.js";
import { MAX_UPGRADE_LEVEL, secureRoll, upgradeCostFor } from "../lib/progression.js";
import { refreshShipStats } from "../lib/ships.js";

function requiredLevelOf(catalog: Catalog, ref: string | undefined): number {
  if (!ref) return 1;
  return catalog.weapons.get(ref)?.requiredLevel ?? catalog.modules.get(ref)?.requiredLevel ?? catalog.drones.get(ref)?.requiredLevel ?? 1;
}

export default async function inventoryRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app;
  const auth = { preHandler: app.authenticate };

  app.get("/api/inventory", auth, async (req): Promise<InventoryResponse> => {
    const q = app.parse(inventoryQuerySchema, req.query);
    const catalog = await getCatalog(db);
    const [rows, equipped, user] = await Promise.all([
      db.inventoryItem.findMany({ where: { userId: req.user.id }, orderBy: { acquiredAt: "desc" } }),
      equippedMap(db, req.user.id),
      db.user.findUniqueOrThrow({ where: { id: req.user.id }, select: { premiumTier: true, premiumUntil: true } }),
    ]);
    const search = q.search?.toLowerCase();
    let items = rows
      .map((r) => inventoryDto(r, catalog.items.get(r.itemId), equipped.get(r.id) ?? null))
      .filter((i) => (!q.category || i.category === q.category) && (!q.rarity || i.rarity === q.rarity))
      .filter((i) => !search || i.name.toLowerCase().includes(search) || i.itemId.includes(search));
    const cmp: Record<typeof q.sort, (a: (typeof items)[number], b: (typeof items)[number]) => number> = {
      rarity: (a, b) => RARITY_ORDER[b.rarity] - RARITY_ORDER[a.rarity],
      level: (a, b) => b.upgradeLevel - a.upgradeLevel,
      power: (a, b) => b.power - a.power,
      value: (a, b) => b.value - a.value,
      recent: (a, b) => b.acquiredAt.localeCompare(a.acquiredAt),
    };
    items = items.sort(cmp[q.sort]);
    const premiumActive = user.premiumUntil && user.premiumUntil.getTime() > Date.now();
    const tier = (premiumActive ? user.premiumTier : "FREE") as keyof typeof ECONOMY.premium;
    return { items, capacity: ECONOMY.premium[tier]?.inventorySlots ?? ECONOMY.premium.FREE.inventorySlots };
  });

  async function loadShipAndLoadout(tx: Tx, userId: string, shipInstanceId: string, loadoutId: string) {
    const inst = await tx.shipInstance.findFirst({ where: { id: shipInstanceId, userId } });
    if (!inst) throw notFound("Ship");
    const lo = await tx.shipLoadout.findFirst({ where: { id: loadoutId, shipInstanceId: inst.id } });
    if (!lo) throw notFound("Loadout");
    return { inst, lo };
  }

  app.post("/api/inventory/equip", auth, async (req) => {
    const body = app.parse(equipRequestSchema, req.body);
    const userId = req.user.id;
    const catalog = await getCatalog(db);
    const result = await withSerializableTx(db, async (tx) => {
      const { inst, lo } = await loadShipAndLoadout(tx, userId, body.shipInstanceId, body.loadoutId);
      const shipDef = catalog.ships.get(inst.shipId);
      if (!shipDef) throw notFound("Ship definition");
      const item = await tx.inventoryItem.findUnique({ where: { id: body.inventoryItemId } });
      // IDOR guard: the item must belong to the caller.
      if (!item || item.userId !== userId) throw notFound("Item");
      if (item.lockedBy) throw conflict("ITEM_LOCKED", "Item is listed on the market or in escrow");
      const def = catalog.items.get(item.itemId);
      if (!def) throw badRequest("UNKNOWN_ITEM", "Unknown item");
      const family = slotFamilyFor(def, def.ref ? WEAPONS_BY_ID.get(def.ref)?.slot ?? catalog.weapons.get(def.ref)?.slot : undefined);
      if (family !== body.slotType) throw badRequest("INCOMPATIBLE_SLOT", `Item cannot be equipped in ${body.slotType}`);
      if (body.slotIndex >= slotCount(shipDef.slots, body.slotType)) throw badRequest("INVALID_SLOT", "Slot index out of range for this ship");
      const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { level: true } });
      const reqLevel = requiredLevelOf(catalog, def.ref);
      if (user.level < reqLevel) throw forbidden(`Requires level ${reqLevel}`, "LEVEL_TOO_LOW");
      // An item can only be used by one ship at a time.
      const others = await tx.shipLoadout.findMany({ where: { shipInstance: { userId }, NOT: { shipInstanceId: inst.id } }, select: { config: true } });
      if (others.some((o) => loadoutItemIds(parseLoadout(o.config)).includes(item.id))) {
        throw conflict("ITEM_IN_USE", "Item is equipped on another ship");
      }
      const cfg = parseLoadout(lo.config);
      const size = slotCount(shipDef.slots, body.slotType);
      for (const t of ["weapons", "missiles", "generators", "modules", "drones"] as SlotType[]) {
        const arr = cfg[t];
        while (arr.length < slotCount(shipDef.slots, t)) arr.push(null);
        for (let i = 0; i < arr.length; i++) if (arr[i] === item.id) arr[i] = null; // move within loadout
      }
      cfg[body.slotType].length = size;
      cfg[body.slotType][body.slotIndex] = item.id;
      const upd = await tx.shipLoadout.updateMany({ where: { id: lo.id, updatedAt: lo.updatedAt }, data: { config: cfg as object } });
      if (upd.count !== 1) throw conflict("CONCURRENT_UPDATE", "Loadout changed concurrently, retry");
      // Touch the item version so a concurrent listing transaction conflicts.
      await tx.inventoryItem.update({ where: { id: item.id }, data: { version: { increment: 1 } } });
      return { shipInstanceId: inst.id, loadoutId: lo.id };
    });
    await refreshShipStats(db, result.shipInstanceId, catalog);
    const lo = await db.shipLoadout.findUniqueOrThrow({ where: { id: result.loadoutId } });
    return { loadout: loadoutDto(lo) };
  });

  app.post("/api/inventory/unequip", auth, async (req) => {
    const body = app.parse(unequipRequestSchema, req.body);
    const userId = req.user.id;
    const result = await withSerializableTx(db, async (tx) => {
      const { inst, lo } = await loadShipAndLoadout(tx, userId, body.shipInstanceId, body.loadoutId);
      const cfg = parseLoadout(lo.config);
      const arr = cfg[body.slotType];
      if (body.slotIndex >= arr.length || !arr[body.slotIndex]) throw badRequest("EMPTY_SLOT", "Slot is already empty");
      arr[body.slotIndex] = null;
      const upd = await tx.shipLoadout.updateMany({ where: { id: lo.id, updatedAt: lo.updatedAt }, data: { config: cfg as object } });
      if (upd.count !== 1) throw conflict("CONCURRENT_UPDATE", "Loadout changed concurrently, retry");
      return { shipInstanceId: inst.id, loadoutId: lo.id };
    });
    await refreshShipStats(db, result.shipInstanceId, await getCatalog(db));
    const lo = await db.shipLoadout.findUniqueOrThrow({ where: { id: result.loadoutId } });
    return { loadout: loadoutDto(lo) };
  });

  app.post("/api/inventory/upgrade", { preHandler: app.authenticate, config: { rateLimit: app.rateLimits.purchase } }, async (req) => {
    const body = app.parse(upgradeItemSchema, req.body);
    const userId = req.user.id;
    const catalog = await getCatalog(db);
    return withIdempotency(app.redis, "item-upgrade", userId, body.idempotencyKey, async () => {
      const out = await withSerializableTx(db, async (tx) => {
        const item = await tx.inventoryItem.findUnique({ where: { id: body.inventoryItemId } });
        if (!item || item.userId !== userId) throw notFound("Item");
        if (item.lockedBy) throw conflict("ITEM_LOCKED", "Item is listed on the market or in escrow");
        const def = catalog.items.get(item.itemId);
        if (!def?.powerItem || def.stackable) throw badRequest("NOT_UPGRADABLE", "This item cannot be upgraded");
        if (item.upgradeLevel >= MAX_UPGRADE_LEVEL) throw badRequest("MAX_LEVEL", `Item is already +${MAX_UPGRADE_LEVEL}`);
        const cost = upgradeCostFor(item.upgradeLevel);
        const ref = `item-upgrade:${userId}:${body.idempotencyKey}`;
        if (cost.credits > 0) {
          await post(tx, {
            from: userWallet(userId, Currency.CREDITS), to: system(LedgerAccountType.GAME_SINK, Currency.CREDITS),
            amount: BigInt(cost.credits), type: LedgerTxType.GAME_SINK, reference: item.id, idempotencyKey: `${ref}:credits`, userId,
            metadata: { kind: "ITEM_UPGRADE", from: item.upgradeLevel },
          });
        }
        if (cost.gems > 0) {
          await post(tx, {
            from: userWallet(userId, Currency.GEMS), to: system(LedgerAccountType.PREMIUM_REVENUE, Currency.GEMS),
            amount: BigInt(cost.gems), type: LedgerTxType.PURCHASE, reference: item.id, idempotencyKey: `${ref}:gems`, userId,
            metadata: { kind: "ITEM_UPGRADE", from: item.upgradeLevel },
          });
        }
        await consumeResources(tx, userId, cost.resources);
        const success = secureRoll() < cost.successChance;
        const upd = await tx.inventoryItem.updateMany({
          where: { id: item.id, version: item.version, lockedBy: null },
          data: { version: { increment: 1 }, ...(success ? { upgradeLevel: { increment: 1 } } : {}) },
        });
        if (upd.count !== 1) throw conflict("CONCURRENT_UPDATE", "Item changed concurrently, retry");
        return { success, fromLevel: item.upgradeLevel, toLevel: success ? cost.toLevel : item.upgradeLevel, cost: toJsonValue(cost), inventoryItemId: item.id };
      });
      const eq = (await equippedMap(db, userId)).get(out.inventoryItemId);
      if (eq) await refreshShipStats(db, eq, catalog);
      return out;
    });
  });
}
