/**
 * Loading a player for a room: user, faction, clan, active ship instance,
 * active loadout (inventory items referenced by the loadout), drone levels,
 * ammo stacks, active quests, unlocked achievements and stat counters.
 * Provisions the faction starter kit idempotently when a user has no ship yet.
 */
import {
  DRONES_BY_ID, FACTIONS, FACTIONS_BY_ID, ITEM_AFFIXES, ITEMS_BY_ID, MODULES_BY_ID, PROGRESSION, QUESTS_BY_ID, SHIPS_BY_ID, WEAPONS_BY_ID,
  itemIdForDef,
} from "@nebula/config";
import type { Db } from "@nebula/database";
import { STARTER_AMMO, clampAffixes, levelForXp, starterAmmoOriginRef, type Equipped, type LoadoutInput } from "@nebula/game-core";
import type { DroneDef, ModuleDef, QuestDef, WeaponDef } from "@nebula/shared";

export interface QuestRuntime {
  userQuestId: string;
  def: QuestDef;
  progress: number[];
  status: "ACTIVE" | "COMPLETED";
  dirty: boolean;
}

export interface PlayerProfile {
  userId: string;
  username: string;
  level: number;
  xp: number;
  honor: number;
  prestige: number;
  pvpRating: number;
  matchesPlayed: number;
  factionId: string | null;
  clanId: string | null;
  clanTag: string;
  squadId: string | null;
  mutedUntil: Date | null;
  restrictions: string[];
  riskLevel: string;
  shipInstanceId: string;
  shipDefId: string;
  shipUpgradeLevel: number;
  loadoutId: string;
  formation: string;
  cosmetics: string;
  loadout: Omit<LoadoutInput, "pvpNormalized">;
  /** Ammo itemId → stacks (inventory rows) with quantities. */
  ammo: Map<string, { id: string; quantity: number }[]>;
  quests: Map<string, QuestRuntime>;
  achievements: Set<string>;
  stats: { npcKills: number; playerKills: number; bossKills: number; gatesCompleted: number; pvpWins: number; resourcesMined: number; mapsVisited: string[]; itemsCrafted: number };
  lastMapId: string | null;
  lastX: number | null;
  lastY: number | null;
}

export class JoinError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

interface LoadoutConfig {
  weapons?: (string | null)[];
  missiles?: (string | null)[];
  generators?: (string | null)[];
  modules?: (string | null)[];
  drones?: (string | null)[];
  formation?: string;
  ammo?: string | null;
  cosmetics?: Record<string, string>;
}

function asLoadoutConfig(v: unknown): LoadoutConfig {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as LoadoutConfig) : {};
}
const ids = (a: (string | null)[] | undefined): string[] => (Array.isArray(a) ? a.filter((x): x is string => typeof x === "string" && x.length > 0) : []);

/**
 * Give a user without any ship the starter ship + loadout of their faction
 * (assigning the faction whose home is `preferredMap` if they have none).
 * Idempotent: unique (userId, shipId) and unique InventoryItem.originRef.
 */
export async function ensureStarterKit(db: Db, userId: string, preferredMap: string | null): Promise<void> {
  const existing = await db.shipInstance.findFirst({ where: { userId }, select: { id: true } });
  if (existing) return;
  await db.$transaction(async (tx) => {
    // Serialize concurrent first joins of the same user: lock the user row, then re-check.
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
    if (await tx.shipInstance.findFirst({ where: { userId }, select: { id: true } })) return;
    let pf = await tx.playerFaction.findUnique({ where: { userId } });
    if (!pf) {
      const fac = FACTIONS.find((f) => f.homeMap === preferredMap) ?? FACTIONS[0];
      if (!fac) throw new JoinError("NO_FACTION", "No factions configured");
      pf = await tx.playerFaction.upsert({ where: { userId }, create: { userId, factionId: fac.id }, update: {} });
    }
    const faction = FACTIONS_BY_ID.get(pf.factionId);
    if (!faction) throw new JoinError("NO_FACTION", `Unknown faction ${pf.factionId}`);
    const ship = await tx.shipInstance.upsert({
      where: { userId_shipId: { userId, shipId: faction.starterShip } },
      create: { userId, shipId: faction.starterShip },
      update: {},
    });
    const grants: { slot: keyof LoadoutConfig; defId: string }[] = [];
    for (const w of faction.starterLoadout.weapons) {
      const def = WEAPONS_BY_ID.get(w);
      if (def) grants.push({ slot: def.slot === "MISSILE" ? "missiles" : "weapons", defId: w });
    }
    for (const m of faction.starterLoadout.modules) {
      const def = MODULES_BY_ID.get(m);
      if (def) grants.push({ slot: def.slot === "GENERATOR" ? "generators" : "modules", defId: m });
    }
    for (const d of faction.starterLoadout.drones) if (DRONES_BY_ID.has(d)) grants.push({ slot: "drones", defId: d });
    const rows = grants.map((g, idx) => ({ userId, itemId: itemIdForDef(g.defId), quantity: 1, originRef: `starter:${userId}:${idx}:${g.defId}`, boundAt: new Date() }));
    const validRows = rows.filter((r) => ITEMS_BY_ID.has(r.itemId));
    await tx.inventoryItem.createMany({ data: validRows, skipDuplicates: true });
    const inv = await tx.inventoryItem.findMany({ where: { userId, originRef: { in: validRows.map((r) => r.originRef) } }, select: { id: true, originRef: true, itemId: true } });
    const byRef = new Map(inv.map((i) => [i.originRef, i]));
    const cfg: Required<Omit<LoadoutConfig, "ammo" | "cosmetics" | "formation">> & LoadoutConfig = { weapons: [], missiles: [], generators: [], modules: [], drones: [], formation: "STANDARD", ammo: null, cosmetics: {} };
    grants.forEach((g, idx) => {
      const row = byRef.get(`starter:${userId}:${idx}:${g.defId}`);
      const list = cfg[g.slot];
      if (row && Array.isArray(list)) list.push(row.id);
    });
    const droneRows = grants
      .map((g, idx) => ({ g, row: byRef.get(`starter:${userId}:${idx}:${g.defId}`) }))
      .filter((x) => x.g.slot === "drones" && x.row)
      .map((x) => ({ userId, droneId: x.g.defId, inventoryItemId: x.row!.id }));
    if (droneRows.length) await tx.droneInstance.createMany({ data: droneRows, skipDuplicates: true });
    // Starter consumables (missile ammo) from factions.json via the shared STARTER_AMMO source.
    const ammo = (STARTER_AMMO.get(faction.id) ?? []).filter((a) => ITEMS_BY_ID.has(a.itemId));
    if (ammo.length) {
      await tx.inventoryItem.createMany({
        data: ammo.map((a) => ({ userId, itemId: a.itemId, quantity: a.quantity, originRef: starterAmmoOriginRef(userId, a.itemId) })),
        skipDuplicates: true,
      });
      cfg.ammo = ammo[0]?.itemId ?? null;
    }
    const loadout = await tx.shipLoadout.create({ data: { shipInstanceId: ship.id, name: "Starter", preset: "CUSTOM", config: cfg as object } });
    await tx.shipInstance.update({ where: { id: ship.id }, data: { activeLoadoutId: loadout.id } });
    await tx.user.update({ where: { id: userId }, data: { activeShipId: ship.id } });
  });
}

export async function loadPlayer(db: Db, userId: string, mapId: string): Promise<PlayerProfile> {
  const user = await db.user.findUnique({
    where: { id: userId },
    include: { playerFaction: true, clanMember: { include: { clan: { select: { id: true, tag: true } } } }, squadMember: { select: { squadId: true } }, stats: true },
  });
  if (!user) throw new JoinError("NO_USER", "User not found");
  if (user.bannedAt) throw new JoinError("BANNED", "Account suspended");
  if (user.restrictions.includes("GAME_BANNED")) throw new JoinError("BANNED", "Account restricted from gameplay");

  await ensureStarterKit(db, userId, user.lastMapId ?? mapId);

  let ship = user.activeShipId
    ? await db.shipInstance.findFirst({ where: { id: user.activeShipId, userId } })
    : null;
  ship ??= await db.shipInstance.findFirst({ where: { userId }, orderBy: { createdAt: "asc" } });
  if (!ship) throw new JoinError("NO_SHIP", "No ship available");
  const shipDef = SHIPS_BY_ID.get(ship.shipId);
  if (!shipDef) throw new JoinError("NO_SHIP", `Unknown ship ${ship.shipId}`);

  const loadoutRow = ship.activeLoadoutId
    ? await db.shipLoadout.findFirst({ where: { id: ship.activeLoadoutId, shipInstanceId: ship.id } })
    : await db.shipLoadout.findFirst({ where: { shipInstanceId: ship.id }, orderBy: { createdAt: "asc" } });
  const cfg = asLoadoutConfig(loadoutRow?.config);

  const allRefs = [...ids(cfg.weapons), ...ids(cfg.missiles), ...ids(cfg.generators), ...ids(cfg.modules), ...ids(cfg.drones)];
  // Only unlocked items owned by this user may be equipped (listed/escrowed items are locked).
  const invRows = allRefs.length
    ? await db.inventoryItem.findMany({ where: { id: { in: allRefs }, userId, lockedBy: null } })
    : [];
  const inv = new Map(invRows.map((r) => [r.id, r]));
  const droneInst = allRefs.length ? await db.droneInstance.findMany({ where: { inventoryItemId: { in: ids(cfg.drones) }, userId } }) : [];
  const droneLevel = new Map(droneInst.map((d) => [d.inventoryItemId, d.level]));
  const used = new Set<string>();

  function resolve<D>(list: (string | null)[] | undefined, lookup: (defId: string) => D | undefined, expectCategory: string[]): Equipped<D>[] {
    const out: Equipped<D>[] = [];
    for (const invId of ids(list)) {
      if (used.has(invId)) continue; // an item may only be equipped once
      const row = inv.get(invId);
      if (!row) continue;
      const item = ITEMS_BY_ID.get(row.itemId);
      if (!item || !expectCategory.includes(item.category) || !item.ref) continue;
      const def = lookup(item.ref);
      if (!def) continue;
      used.add(invId);
      const affixes = clampAffixes(Array.isArray(row.affixes) ? (row.affixes as { stat: string; value: number; id?: string }[]) : [], ITEM_AFFIXES);
      out.push({ def, upgradeLevel: row.upgradeLevel, affixes, level: droneLevel.get(invId), inventoryItemId: invId });
    }
    return out;
  }

  const lasers = resolve<WeaponDef>(cfg.weapons, (d) => WEAPONS_BY_ID.get(d), ["WEAPON"]).filter((w) => w.def.slot === "LASER");
  const missiles = resolve<WeaponDef>(cfg.missiles, (d) => WEAPONS_BY_ID.get(d), ["WEAPON"]).filter((w) => w.def.slot === "MISSILE");
  const generators = resolve<ModuleDef>(cfg.generators, (d) => MODULES_BY_ID.get(d), ["GENERATOR", "MODULE"]).filter((m) => m.def.slot === "GENERATOR");
  const modules = resolve<ModuleDef>(cfg.modules, (d) => MODULES_BY_ID.get(d), ["MODULE", "GENERATOR"]).filter((m) => m.def.slot === "MODULE");
  const drones = resolve<DroneDef>(cfg.drones, (d) => DRONES_BY_ID.get(d), ["DRONE"]);

  const ammoIds = [...new Set([...lasers, ...missiles].map((w) => w.def.ammo).filter((a): a is string => !!a))];
  const ammoRows = ammoIds.length
    ? await db.inventoryItem.findMany({ where: { userId, itemId: { in: ammoIds }, lockedBy: null, quantity: { gt: 0 } }, select: { id: true, itemId: true, quantity: true } })
    : [];
  const ammo = new Map<string, { id: string; quantity: number }[]>();
  for (const r of ammoRows) {
    const arr = ammo.get(r.itemId) ?? [];
    arr.push({ id: r.id, quantity: r.quantity });
    ammo.set(r.itemId, arr);
  }

  const quests = await loadActiveQuests(db, userId);
  const ach = await db.userAchievement.findMany({ where: { userId }, select: { achievementId: true } });
  const factionId = user.playerFaction?.factionId ?? null;
  const faction = factionId ? FACTIONS_BY_ID.get(factionId) : undefined;
  const xp = Number(user.xp);

  return {
    userId,
    username: user.username,
    level: Math.max(user.level, levelForXp(xp, PROGRESSION)),
    xp,
    honor: Number(user.honor),
    prestige: user.prestige,
    pvpRating: user.pvpRating,
    matchesPlayed: user.matchesPlayed,
    factionId,
    clanId: user.clanMember?.clan.id ?? null,
    clanTag: user.clanMember?.clan.tag ?? "",
    squadId: user.squadMember?.squadId ?? null,
    mutedUntil: user.mutedUntil,
    restrictions: user.restrictions,
    riskLevel: user.riskLevel,
    shipInstanceId: ship.id,
    shipDefId: ship.shipId,
    shipUpgradeLevel: ship.upgradeLevel,
    loadoutId: loadoutRow?.id ?? "",
    formation: typeof cfg.formation === "string" ? cfg.formation : "STANDARD",
    cosmetics: JSON.stringify({ ...(ship.cosmetics && typeof ship.cosmetics === "object" ? ship.cosmetics : {}), ...(cfg.cosmetics ?? {}) }),
    loadout: {
      ship: shipDef,
      shipUpgradeLevel: ship.upgradeLevel,
      lasers,
      missiles,
      generators,
      modules,
      drones,
      factionBonus: faction?.bonus,
      progression: PROGRESSION,
    },
    ammo,
    quests,
    achievements: new Set(ach.map((a) => a.achievementId)),
    stats: {
      npcKills: user.stats?.npcKills ?? 0,
      playerKills: user.stats?.playerKills ?? 0,
      bossKills: user.stats?.bossKills ?? 0,
      gatesCompleted: user.stats?.gatesCompleted ?? 0,
      pvpWins: user.stats?.pvpWins ?? 0,
      resourcesMined: Number(user.stats?.resourcesMined ?? 0),
      mapsVisited: user.stats?.mapsVisited ?? [],
      itemsCrafted: user.stats?.itemsCrafted ?? 0,
    },
    lastMapId: user.lastMapId,
    lastX: user.lastX,
    lastY: user.lastY,
  };
}

export async function loadActiveQuests(db: Db, userId: string): Promise<Map<string, QuestRuntime>> {
  const rows = await db.userQuest.findMany({ where: { userId, status: "ACTIVE" } });
  const out = new Map<string, QuestRuntime>();
  for (const r of rows) {
    const def = QUESTS_BY_ID.get(r.questId);
    if (!def) continue;
    out.set(r.id, { userQuestId: r.id, def, progress: [...r.progress], status: "ACTIVE", dirty: false });
  }
  return out;
}
