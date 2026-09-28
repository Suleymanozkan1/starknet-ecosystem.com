/**
 * Ship stat computation via @nebula/game-core (same formulas as the authoritative game server).
 */
import { FACTIONS_BY_ID, PROGRESSION } from "@nebula/config";
import type { DbOrTx } from "@nebula/database";
import { computeStats, type Equipped, type LoadoutInput } from "@nebula/game-core";
import type { DroneDef, ModuleDef, StatKey, WeaponDef } from "@nebula/shared";
import type { Catalog } from "./catalog.js";
import { affixList, parseLoadout } from "./inventory.js";

export interface ComputedShipStats {
  stats: Record<string, number>;
  gearScore: number;
}

export async function computeShipStats(db: DbOrTx, shipInstanceId: string, catalog: Catalog, loadoutId?: string | null): Promise<ComputedShipStats> {
  const inst = await db.shipInstance.findUnique({
    where: { id: shipInstanceId },
    select: { shipId: true, upgradeLevel: true, activeLoadoutId: true, user: { select: { playerFaction: { select: { factionId: true } } } } },
  });
  const ship = inst ? catalog.ships.get(inst.shipId) : undefined;
  if (!inst || !ship) return { stats: {}, gearScore: 0 };
  const lid = loadoutId ?? inst.activeLoadoutId;
  const loadout = lid ? await db.shipLoadout.findUnique({ where: { id: lid }, select: { config: true } }) : null;
  const cfg = parseLoadout(loadout?.config);
  const ids = [...cfg.weapons, ...cfg.missiles, ...cfg.generators, ...cfg.modules, ...cfg.drones].filter((x): x is string => Boolean(x));
  const items = ids.length
    ? await db.inventoryItem.findMany({ where: { id: { in: ids } }, select: { id: true, itemId: true, upgradeLevel: true, affixes: true } })
    : [];
  const byId = new Map(items.map((i) => [i.id, i]));

  function equipped<D>(list: (string | null)[], resolve: (ref: string) => D | undefined): Equipped<D>[] {
    const out: Equipped<D>[] = [];
    for (const id of list) {
      if (!id) continue;
      const inv = byId.get(id);
      const ref = inv ? catalog.items.get(inv.itemId)?.ref : undefined;
      const def = ref ? resolve(ref) : undefined;
      if (!inv || !def) continue;
      out.push({
        def,
        upgradeLevel: inv.upgradeLevel,
        affixes: affixList(inv.affixes).map((a) => ({ stat: a.stat as StatKey, value: a.value })),
        inventoryItemId: inv.id,
      });
    }
    return out;
  }

  const input: LoadoutInput = {
    ship,
    shipUpgradeLevel: inst.upgradeLevel,
    lasers: equipped<WeaponDef>(cfg.weapons, (r) => catalog.weapons.get(r)),
    missiles: equipped<WeaponDef>(cfg.missiles, (r) => catalog.weapons.get(r)),
    generators: equipped<ModuleDef>(cfg.generators, (r) => catalog.modules.get(r)),
    modules: equipped<ModuleDef>(cfg.modules, (r) => catalog.modules.get(r)),
    drones: equipped<DroneDef>(cfg.drones, (r) => catalog.drones.get(r)),
    factionBonus: FACTIONS_BY_ID.get(inst.user.playerFaction?.factionId ?? "")?.bonus,
    progression: PROGRESSION,
  };
  const eff = computeStats(input);
  const stats: Record<string, number> = {
    hull: eff.hull,
    shield: eff.shield,
    armor: eff.armor,
    energy: eff.energy,
    energyRegen: eff.energyRegen,
    shieldRegen: eff.shieldRegen,
    speed: eff.speed,
    acceleration: eff.acceleration,
    turnRate: eff.turnRate,
    cargo: eff.cargo,
    heatCapacity: eff.heatCapacity,
    weapons: eff.weapons.length,
  };
  for (const [k, v] of Object.entries(eff.pct)) stats[`pct_${k}`] = v;
  return { stats, gearScore: eff.gearScore };
}

/** Recompute and persist ShipStats (+ User.gearScore when it is the active ship). */
export async function refreshShipStats(db: DbOrTx, shipInstanceId: string, catalog: Catalog): Promise<ComputedShipStats> {
  const s = await computeShipStats(db, shipInstanceId, catalog);
  await db.shipStats.upsert({
    where: { shipInstanceId },
    create: { shipInstanceId, stats: s.stats, gearScore: s.gearScore },
    update: { stats: s.stats, gearScore: s.gearScore, computedAt: new Date() },
  });
  const inst = await db.shipInstance.findUnique({ where: { id: shipInstanceId }, select: { userId: true } });
  if (inst) await db.user.updateMany({ where: { id: inst.userId, activeShipId: shipInstanceId }, data: { gearScore: s.gearScore } });
  return s;
}
