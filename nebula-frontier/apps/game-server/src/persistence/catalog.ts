/**
 * Idempotent catalog bootstrap: inserts (never overwrites) the catalog rows
 * the game server writes foreign keys to, from @nebula/config data. The seed
 * script (prisma/seed.ts) owns full catalog sync; this only guarantees FK
 * targets exist so the server works against a freshly migrated database.
 */
import {
  ACHIEVEMENTS, DRONES, EVENTS, FACTIONS, ITEMS, MODULES, NPCS, QUESTS, SEASONS, SHIPS, WEAPONS, itemIdForResource,
} from "@nebula/config";
import type { Db } from "@nebula/database";
import { RESOURCE_IDS } from "@nebula/shared";

export const LEADERBOARDS = [
  { id: "pvp_kills", name: "PvP Kills", metric: "player_kills" },
  { id: "npc_kills", name: "NPC Kills", metric: "npc_kills" },
  { id: "honor", name: "Honor", metric: "honor" },
  { id: "season_score", name: "Season Score", metric: "season_score" },
] as const;
export type LeaderboardId = (typeof LEADERBOARDS)[number]["id"];

/** Synthetic event id used for world-boss participation when no events.json entry names the boss. */
export const bossEventId = (bossId: string): string => `worldboss_${bossId}`;

export function activeSeasonId(now = Date.now()): string | null {
  const s = SEASONS.find((x) => Date.parse(x.startAt) <= now && now < Date.parse(x.endAt));
  return s?.id ?? null;
}

let done: Promise<void> | null = null;

export function ensureCatalog(db: Db): Promise<void> {
  done ??= doEnsure(db).catch((e: unknown) => {
    done = null;
    throw e;
  });
  return done;
}

async function doEnsure(db: Db): Promise<void> {
  const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as object;
  await db.faction.createMany({
    data: FACTIONS.map((f) => ({ id: f.id, name: f.name, tag: f.tag, color: f.color, homeMap: f.homeMap })),
    skipDuplicates: true,
  });
  await db.ship.createMany({ data: SHIPS.map((s) => ({ id: s.id, name: s.name, class: s.class, tier: s.tier, data: json(s) })), skipDuplicates: true });
  await db.weapon.createMany({ data: WEAPONS.map((w) => ({ id: w.id, name: w.name, type: w.type, rarity: w.rarity, data: json(w) })), skipDuplicates: true });
  await db.module.createMany({ data: MODULES.map((m) => ({ id: m.id, name: m.name, kind: m.kind, rarity: m.rarity, data: json(m) })), skipDuplicates: true });
  await db.drone.createMany({ data: DRONES.map((d) => ({ id: d.id, name: d.name, type: d.type, rarity: d.rarity, data: json(d) })), skipDuplicates: true });
  await db.item.createMany({
    data: ITEMS.map((i) => ({
      id: i.id, name: i.name, category: i.category, rarity: i.rarity, ref: i.ref ?? null, tradeable: i.tradeable, soulbound: i.soulbound,
      premium: i.premium, cosmetic: i.cosmetic, powerItem: i.powerItem, nftEligible: i.nftEligible, stackable: i.stackable,
      maxStack: i.maxStack, baseValue: i.baseValue, data: json(i),
    })),
    skipDuplicates: true,
  });
  await db.resource.createMany({
    data: RESOURCE_IDS.map((r) => {
      const item = ITEMS.find((i) => i.id === itemIdForResource(r));
      return { id: r, name: item?.name ?? r, rarity: item?.rarity ?? "COMMON", baseValue: item?.baseValue ?? 1 };
    }),
    skipDuplicates: true,
  });
  await db.nPC.createMany({ data: NPCS.map((n) => ({ id: n.id, name: n.name, faction: n.faction, level: n.level, data: json(n) })), skipDuplicates: true });
  await db.quest.createMany({ data: QUESTS.map((q) => ({ id: q.id, name: q.name, type: q.type, data: json(q) })), skipDuplicates: true });
  await db.achievement.createMany({ data: ACHIEVEMENTS.map((a) => ({ id: a.id, name: a.name, data: json(a) })), skipDuplicates: true });
  const events = EVENTS.map((e) => ({ id: e.id, name: e.name, type: e.type, startAt: new Date(e.startAt), endAt: new Date(e.endAt), data: json(e) }));
  for (const n of NPCS.filter((x) => x.kind === "BOSS")) {
    if (EVENTS.some((e) => e.boss === n.id)) continue;
    events.push({ id: bossEventId(n.id), name: `${n.name} (world boss)`, type: "WORLD_BOSS", startAt: new Date("2026-01-01T00:00:00Z"), endAt: new Date("2030-01-01T00:00:00Z"), data: json({ boss: n.id, synthetic: true }) });
  }
  await db.event.createMany({ data: events, skipDuplicates: true });
  const season = activeSeasonId();
  await db.leaderboard.createMany({
    data: LEADERBOARDS.map((l) => ({ id: l.id, name: l.name, metric: l.metric, seasonId: l.id === "season_score" ? season : null })),
    skipDuplicates: true,
  });
}
