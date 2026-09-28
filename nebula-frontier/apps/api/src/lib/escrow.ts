/**
 * Item escrow for marketplace listings and auctions. Runs inside a SERIALIZABLE transaction:
 * ownership, tradeability, equipped and lock checks, optional stack split, then an optimistic
 * `version` + `lockedBy IS NULL` conditional lock. A second concurrent sell of the same item
 * therefore always fails (lockedBy/version mismatch or serialization abort).
 */
import { randomUUID } from "node:crypto";
import type { Tx } from "@nebula/database";
import { badRequest, conflict, notFound } from "../errors.js";
import type { Catalog } from "./catalog.js";
import { loadoutItemIds, parseLoadout } from "./inventory.js";
import { asRecord } from "./json.js";

export interface EscrowTarget {
  inventoryItemId: string;
  itemId: string;
  quantity: number;
}

export async function escrowItem(
  tx: Tx,
  catalog: Catalog,
  userId: string,
  inventoryItemId: string,
  quantity: number,
  create: (target: EscrowTarget) => Promise<{ id: string }>,
  lockPrefix: "listing" | "auction",
): Promise<{ recordId: string; target: EscrowTarget }> {
  const item = await tx.inventoryItem.findUnique({ where: { id: inventoryItemId } });
  if (!item || item.userId !== userId) throw notFound("Item");
  if (item.lockedBy) throw conflict("ITEM_LOCKED", "Item is already listed or in escrow");
  const def = catalog.items.get(item.itemId);
  if (!def || !def.tradeable || def.soulbound || item.boundAt) throw badRequest("NOT_TRADEABLE", "This item cannot be traded");
  if (quantity > item.quantity) throw badRequest("INSUFFICIENT_QUANTITY", "Not enough items in this stack");

  const loadouts = await tx.shipLoadout.findMany({ where: { shipInstance: { userId } }, select: { config: true } });
  if (loadouts.some((l) => loadoutItemIds(parseLoadout(l.config)).includes(item.id))) {
    throw conflict("ITEM_EQUIPPED", "Unequip the item before selling it");
  }
  if (def.category === "SKIN" || def.category === "COSMETIC") {
    const ships = await tx.shipInstance.findMany({ where: { userId }, select: { cosmetics: true } });
    const inUse = ships.some((s) => Object.values(asRecord(s.cosmetics)).includes(item.itemId));
    const owned = await tx.inventoryItem.count({ where: { userId, itemId: item.itemId } });
    if (inUse && owned <= 1) throw conflict("ITEM_EQUIPPED", "Remove the cosmetic from your ship before selling it");
  }

  let targetId = item.id;
  if (quantity < item.quantity) {
    const dec = await tx.inventoryItem.updateMany({
      where: { id: item.id, version: item.version, lockedBy: null, quantity: item.quantity },
      data: { quantity: { decrement: quantity }, version: { increment: 1 } },
    });
    if (dec.count !== 1) throw conflict("CONCURRENT_UPDATE", "Item changed concurrently, retry");
    const split = await tx.inventoryItem.create({
      data: {
        userId, itemId: item.itemId, quantity, upgradeLevel: item.upgradeLevel, affixes: item.affixes as object,
        originRef: `split:${item.id}:${randomUUID()}`,
      },
    });
    targetId = split.id;
  }
  const target: EscrowTarget = { inventoryItemId: targetId, itemId: item.itemId, quantity };
  const record = await create(target);
  const lock = await tx.inventoryItem.updateMany({
    where: { id: targetId, userId, lockedBy: null, ...(targetId === item.id ? { version: item.version } : {}) },
    data: { lockedBy: `${lockPrefix}:${record.id}`, version: { increment: 1 } },
  });
  if (lock.count !== 1) throw conflict("ITEM_LOCKED", "Item is already listed or in escrow");
  return { recordId: record.id, target };
}

/** Move an escrowed item to its new owner (sale settlement). */
export async function transferEscrowed(tx: Tx, inventoryItemId: string, fromUserId: string, toUserId: string, lock: string): Promise<void> {
  const r = await tx.inventoryItem.updateMany({
    where: { id: inventoryItemId, userId: fromUserId, lockedBy: lock },
    data: { userId: toUserId, lockedBy: null, version: { increment: 1 }, acquiredAt: new Date() },
  });
  if (r.count !== 1) throw conflict("ESCROW_MISMATCH", "Escrowed item is no longer available");
}

/** Return an escrowed item to its owner (cancel / expiry). */
export async function releaseEscrowed(tx: Tx, inventoryItemId: string, lock: string): Promise<void> {
  await tx.inventoryItem.updateMany({ where: { id: inventoryItemId, lockedBy: lock }, data: { lockedBy: null, version: { increment: 1 } } });
}
