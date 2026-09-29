/**
 * Runtime catalog: config JSON defaults (packages/config) overlaid with admin overrides stored in
 * the Ship/Weapon/Module/Drone/Item tables (`data` JSON + `active`). Cached briefly in-process;
 * admin catalog mutations call `invalidateCatalog()`.
 */
import type { DbOrTx } from "@nebula/database";
import { DRONES_BY_ID, ITEMS_BY_ID, MODULES_BY_ID, SHIPS_BY_ID, WEAPONS_BY_ID } from "@nebula/config";
import type { DroneDef, ItemDef, ModuleDef, ShipDef, WeaponDef } from "@nebula/shared";
import { asRecord } from "./json.js";

export interface Catalog {
  ships: Map<string, ShipDef & { active: boolean }>;
  weapons: Map<string, WeaponDef & { active: boolean }>;
  modules: Map<string, ModuleDef & { active: boolean }>;
  drones: Map<string, DroneDef & { active: boolean }>;
  items: Map<string, ItemDef>;
}

let cached: { at: number; catalog: Catalog } | null = null;

function overlay<T extends { id: string }>(defaults: ReadonlyMap<string, T>, rows: { id: string; data: unknown; active?: boolean }[]) {
  const out = new Map<string, T & { active: boolean }>();
  for (const [id, def] of defaults) out.set(id, { ...def, active: true });
  for (const r of rows) {
    const base = out.get(r.id) ?? (asRecord(r.data) as unknown as T);
    out.set(r.id, { ...base, ...(asRecord(r.data) as Partial<T>), id: r.id, active: r.active ?? true } as T & { active: boolean });
  }
  return out;
}

export async function getCatalog(db: DbOrTx): Promise<Catalog> {
  if (cached && Date.now() - cached.at < 30_000) return cached.catalog;
  const [ships, weapons, modules, drones, items] = await Promise.all([
    db.ship.findMany({ select: { id: true, data: true, active: true } }),
    db.weapon.findMany({ select: { id: true, data: true, active: true } }),
    db.module.findMany({ select: { id: true, data: true, active: true } }),
    db.drone.findMany({ select: { id: true, data: true, active: true } }),
    db.item.findMany({ select: { id: true, data: true } }),
  ]);
  const itemMap = new Map<string, ItemDef>();
  for (const [id, def] of ITEMS_BY_ID) itemMap.set(id, def);
  for (const r of items) itemMap.set(r.id, { ...(itemMap.get(r.id) ?? ({} as ItemDef)), ...(asRecord(r.data) as Partial<ItemDef>), id: r.id });
  const catalog: Catalog = {
    ships: overlay(SHIPS_BY_ID, ships),
    weapons: overlay(WEAPONS_BY_ID, weapons),
    modules: overlay(MODULES_BY_ID, modules),
    drones: overlay(DRONES_BY_ID, drones),
    items: itemMap,
  };
  cached = { at: Date.now(), catalog };
  return catalog;
}

export function invalidateCatalog(): void {
  cached = null;
}
