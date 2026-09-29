/**
 * Faction war standings. Event metrics (kills, PvP score, resources, bosses) are written by the
 * game server's batched writer into `Faction` (all-time) and `FactionSeasonScore` (per season) in
 * the same transaction as the pilot's counters. Territory is live state: maps held by clans of the
 * faction (ClanTerritory → Clan.factionId), scored with `progression.factionWar.territoryPoints`.
 */
import { FACTIONS, PROGRESSION } from "@nebula/config";
import type { Db } from "@nebula/database";
import type { FactionWarResponse, FactionWarStanding } from "@nebula/shared";
import { activeSeasonId } from "./grants.js";

export async function factionTerritory(db: Db): Promise<Map<string, number>> {
  const rows = await db.clanTerritory.findMany({ select: { clan: { select: { factionId: true } } } });
  const out = new Map<string, number>();
  for (const r of rows) if (r.clan.factionId) out.set(r.clan.factionId, (out.get(r.clan.factionId) ?? 0) + 1);
  return out;
}

/**
 * Keep the denormalised `Faction.territory` column current for other readers. Runs from the
 * background jobs (never from the public standings GET); conditional updates make it idempotent.
 * Returns the number of factions whose territory changed.
 */
export async function syncFactionTerritory(db: Db): Promise<number> {
  const territory = await factionTerritory(db);
  const all = await db.faction.findMany({ select: { id: true, territory: true } });
  let changed = 0;
  for (const f of all) {
    const t = territory.get(f.id) ?? 0;
    if (f.territory === t) continue;
    const upd = await db.faction.updateMany({ where: { id: f.id, territory: { not: t } }, data: { territory: t } });
    changed += upd.count;
  }
  return changed;
}

/** Read-only standings (public GET): territory is computed live, nothing is written. */
export async function factionWarStandings(db: Db): Promise<FactionWarResponse> {
  const war = PROGRESSION.factionWar ?? { npcKillPoints: 0, pvpKillPoints: 0, resourcePointsPer100: 0, bossKillPoints: 0, territoryPoints: 0 };
  const seasonId = await activeSeasonId(db);
  const territory = await factionTerritory(db);
  const all = await db.faction.findMany();
  const seasonRows = seasonId ? await db.factionSeasonScore.findMany({ where: { seasonId } }) : [];
  const standing = (id: string, m: { score: bigint; kills: bigint; pvpScore: bigint; resources: bigint; bossKills: number } | undefined): FactionWarStanding => {
    const def = FACTIONS.find((f) => f.id === id);
    const t = territory.get(id) ?? 0;
    return {
      factionId: id, name: def?.name ?? id, tag: def?.tag ?? "", color: def?.color ?? "#ffffff",
      score: ((m?.score ?? 0n) + BigInt(t * war.territoryPoints)).toString(),
      kills: (m?.kills ?? 0n).toString(), pvpScore: (m?.pvpScore ?? 0n).toString(), resources: (m?.resources ?? 0n).toString(),
      bossKills: m?.bossKills ?? 0, territory: t,
    };
  };
  const sortDesc = (a: FactionWarStanding, b: FactionWarStanding) => (BigInt(b.score) > BigInt(a.score) ? 1 : BigInt(b.score) < BigInt(a.score) ? -1 : 0);
  return {
    seasonId,
    season: FACTIONS.map((f) => standing(f.id, seasonRows.find((r) => r.factionId === f.id))).sort(sortDesc),
    allTime: FACTIONS.map((f) => standing(f.id, all.find((r) => r.id === f.id))).sort(sortDesc),
    weights: { ...war },
  };
}
