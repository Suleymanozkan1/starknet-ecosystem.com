/**
 * Inventory helpers: server-side item grants (unique originRef => no duplication), loadout JSON
 * shape, equipped-item resolution and DTO mapping.
 */
import type { DbOrTx, Prisma, Tx } from "@nebula/database";
import { PROGRESSION } from "@nebula/config";
import { RARITY_ORDER, type InventoryItemDto, type ItemCategory, type ItemDef, type LoadoutDto, type Rarity } from "@nebula/shared";
import { badRequest, conflict } from "../errors.js";
import { asRecord } from "./json.js";

export const SLOT_TYPES = ["weapons", "missiles", "generators", "modules", "drones"] as const;
export type SlotType = (typeof SLOT_TYPES)[number];

export interface LoadoutConfig {
  weapons: (string | null)[];
  missiles: (string | null)[];
  generators: (string | null)[];
  modules: (string | null)[];
  drones: (string | null)[];
  formation: string;
  ammo: string | null;
  cosmetics: Record<string, string>;
}

export function emptyLoadout(slots: { laser: number; missile: number; generator: number; module: number; drone: number }): LoadoutConfig {
  return {
    weapons: Array<string | null>(slots.laser).fill(null),
    missiles: Array<string | null>(slots.missile).fill(null),
    generators: Array<string | null>(slots.generator).fill(null),
    modules: Array<string | null>(slots.module).fill(null),
    drones: Array<string | null>(slots.drone).fill(null),
    formation: "STANDARD",
    ammo: null,
    cosmetics: {},
  };
}

export function parseLoadout(raw: unknown): LoadoutConfig {
  const r = asRecord(raw);
  const arr = (v: unknown) => (Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : null)) : []);
  const cos = asRecord(r.cosmetics);
  return {
    weapons: arr(r.weapons),
    missiles: arr(r.missiles),
    generators: arr(r.generators),
    modules: arr(r.modules),
    drones: arr(r.drones),
    formation: typeof r.formation === "string" ? r.formation : "STANDARD",
    ammo: typeof r.ammo === "string" ? r.ammo : null,
    cosmetics: Object.fromEntries(Object.entries(cos).filter(([, v]) => typeof v === "string")) as Record<string, string>,
  };
}

export function loadoutDto(row: { id: string; name: string; preset: string; config: unknown }): LoadoutDto {
  const c = parseLoadout(row.config);
  return { id: row.id, name: row.name, preset: row.preset as LoadoutDto["preset"], ...c };
}

export function loadoutItemIds(c: LoadoutConfig): string[] {
  return [...c.weapons, ...c.missiles, ...c.generators, ...c.modules, ...c.drones].filter((x): x is string => Boolean(x));
}

/** inventoryItemId -> shipInstanceId for every item referenced by any of the user's loadouts. */
export async function equippedMap(db: DbOrTx, userId: string): Promise<Map<string, string>> {
  const loadouts = await db.shipLoadout.findMany({
    where: { shipInstance: { userId } },
    select: { shipInstanceId: true, config: true },
  });
  const out = new Map<string, string>();
  for (const l of loadouts) for (const id of loadoutItemIds(parseLoadout(l.config))) out.set(id, l.shipInstanceId);
  return out;
}

export async function isEquipped(db: DbOrTx, userId: string, inventoryItemId: string): Promise<boolean> {
  return (await equippedMap(db, userId)).has(inventoryItemId);
}

/**
 * Grant items. Stackable items merge into an existing unlocked stack (up to maxStack) and overflow
 * into new rows; non-stackable items create one row each. Every created row carries a unique
 * server-generated `originRef` (`<prefix>:<itemId>:<n>`, `n` counted per itemId across all entries,
 * so repeated itemIds in one grant never collide).
 *
 * Replay safety: a replay with the same prefix that has to create a row hits the unique `originRef`
 * and aborts the transaction; merges into existing stacks are NOT keyed. Callers must therefore
 * claim the grant source atomically (conditional update / unique row) in the same transaction —
 * `originRef` is defence in depth, not the sole idempotency guard.
 */
export async function grantItems(
  tx: Tx,
  userId: string,
  items: readonly { itemId: string; quantity: number }[],
  originPrefix: string,
  itemDefs: ReadonlyMap<string, ItemDef>,
): Promise<string[]> {
  const created: string[] = [];
  const seq = new Map<string, number>();
  const nextRef = (itemId: string): string => {
    const n = seq.get(itemId) ?? 0;
    seq.set(itemId, n + 1);
    return `${originPrefix}:${itemId}:${n}`;
  };
  for (const { itemId, quantity } of items) {
    if (quantity <= 0) continue;
    const def = itemDefs.get(itemId);
    const row = def ? null : await tx.item.findUnique({ where: { id: itemId }, select: { stackable: true, maxStack: true } });
    if (!def && !row) throw badRequest("UNKNOWN_ITEM", `Unknown item ${itemId}`);
    const stackable = def?.stackable ?? row?.stackable ?? false;
    const maxStack = Math.max(1, def?.maxStack ?? row?.maxStack ?? 1);
    let remaining = quantity;
    if (stackable) {
      const stacks = await tx.inventoryItem.findMany({
        where: { userId, itemId, lockedBy: null, quantity: { lt: maxStack } },
        orderBy: { quantity: "desc" },
        select: { id: true, quantity: true },
      });
      for (const s of stacks) {
        if (remaining <= 0) break;
        const add = Math.min(remaining, maxStack - s.quantity);
        const upd = await tx.inventoryItem.updateMany({
          where: { id: s.id, lockedBy: null, quantity: s.quantity },
          data: { quantity: { increment: add }, version: { increment: 1 } },
        });
        if (upd.count === 1) remaining -= add;
      }
      while (remaining > 0) {
        const q = Math.min(remaining, maxStack);
        const r = await tx.inventoryItem.create({ data: { userId, itemId, quantity: q, originRef: nextRef(itemId) } });
        created.push(r.id);
        remaining -= q;
      }
    } else {
      for (let i = 0; i < quantity; i++) {
        const r = await tx.inventoryItem.create({
          data: { userId, itemId, quantity: 1, originRef: nextRef(itemId), boundAt: def?.soulbound ? new Date() : null },
        });
        created.push(r.id);
      }
    }
  }
  return created;
}

export interface InventoryRow {
  id: string;
  itemId: string;
  quantity: number;
  upgradeLevel: number;
  affixes: unknown;
  lockedBy: string | null;
  boundAt: Date | null;
  acquiredAt: Date;
}

export function affixList(raw: unknown): { stat: string; value: number }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((a) => asRecord(a))
    .filter((a) => typeof a.stat === "string" && typeof a.value === "number")
    .map((a) => ({ stat: a.stat as string, value: a.value as number }));
}

export function itemPower(def: ItemDef | undefined, upgradeLevel: number, affixes: { value: number }[]): number {
  if (!def?.powerItem) return 0;
  const rarity = RARITY_ORDER[def.rarity] ?? 0;
  const base = (rarity + 1) * 100 * (1 + upgradeLevel * PROGRESSION.upgrade.statPercentPerLevel);
  return Math.round(base + affixes.reduce((s, a) => s + Math.abs(a.value), 0));
}

export function inventoryDto(row: InventoryRow, def: ItemDef | undefined, equippedOn: string | null): InventoryItemDto {
  const affixes = affixList(row.affixes);
  return {
    id: row.id,
    itemId: row.itemId,
    name: def?.name ?? row.itemId,
    category: (def?.category ?? "CONSUMABLE") as ItemCategory,
    rarity: (def?.rarity ?? "COMMON") as Rarity,
    quantity: row.quantity,
    upgradeLevel: row.upgradeLevel,
    affixes,
    equippedOn,
    tradeable: Boolean(def?.tradeable) && !def?.soulbound && !row.boundAt && !row.lockedBy,
    soulbound: Boolean(def?.soulbound) || Boolean(row.boundAt),
    value: (def?.baseValue ?? 0) * row.quantity,
    power: itemPower(def, row.upgradeLevel, affixes),
    acquiredAt: row.acquiredAt.toISOString(),
  };
}

export type UpgradeKind = "ITEM" | "SHIP";

export interface UpgradeOutcome {
  success: boolean;
  fromLevel: number;
  toLevel: number;
  cost: Prisma.JsonValue;
}

/**
 * Durable upgrade idempotency (independent of the Redis request cache): returns the stored outcome
 * of an earlier attempt with the same (user, kind, idempotencyKey), or null when there is none.
 * Reusing a key for a different target is rejected.
 */
export async function priorUpgradeAttempt(db: DbOrTx, userId: string, kind: UpgradeKind, idempotencyKey: string, targetId: string): Promise<UpgradeOutcome | null> {
  const row = await db.upgradeAttempt.findUnique({ where: { userId_kind_idempotencyKey: { userId, kind, idempotencyKey } } });
  if (!row) return null;
  if (row.targetId !== targetId) throw conflict("IDEMPOTENCY_KEY_REUSED", "Idempotency key was already used for a different upgrade");
  return { success: row.success, fromLevel: row.fromLevel, toLevel: row.toLevel, cost: row.cost };
}

export function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string }).code === "P2002" || /Unique constraint/i.test(String((err as { message?: unknown }).message ?? ""));
}

/** Which loadout slot family an item may occupy. */
export function slotFamilyFor(def: ItemDef, weaponSlot: string | undefined): SlotType | null {
  switch (def.category) {
    case "WEAPON":
      return weaponSlot === "MISSILE" ? "missiles" : "weapons";
    case "GENERATOR":
      return "generators";
    case "MODULE":
      return "modules";
    case "DRONE":
      return "drones";
    default:
      return null;
  }
}

export function slotCount(slots: { laser: number; missile: number; generator: number; module: number; drone: number }, t: SlotType): number {
  switch (t) {
    case "weapons": return slots.laser;
    case "missiles": return slots.missile;
    case "generators": return slots.generator;
    case "modules": return slots.module;
    case "drones": return slots.drone;
  }
}
