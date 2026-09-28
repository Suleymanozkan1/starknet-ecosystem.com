/**
 * Clan territory capture: the winner of the most recent decided clan war on a map owns that map.
 * The game server finishes wars (ClanWar.phase = REWARDED, winnerId); this job applies ownership
 * idempotently (only when the war ended after the current capture time).
 */
import type { Db } from "@nebula/database";
import { MAPS_BY_ID } from "@nebula/config";
import { notify } from "./notify.js";

export async function captureTerritories(db: Db): Promise<number> {
  const wars = await db.clanWar.findMany({
    where: { phase: "REWARDED", winnerId: { not: null } },
    orderBy: { endsAt: "desc" },
    distinct: ["mapId"],
    take: 500,
    select: { id: true, mapId: true, winnerId: true, endsAt: true, clanAId: true, clanBId: true },
  });
  let changed = 0;
  for (const w of wars) {
    if (!w.winnerId || !MAPS_BY_ID.has(w.mapId)) continue;
    const winnerId = w.winnerId;
    const applied = await db.$transaction(async (tx) => {
      const cur = await tx.clanTerritory.findUnique({ where: { mapId: w.mapId } });
      if (cur && cur.capturedAt.getTime() >= w.endsAt.getTime()) return null;
      const winnerExists = await tx.clan.findUnique({ where: { id: winnerId }, select: { id: true } });
      if (!winnerExists) return null;
      await tx.clanTerritory.upsert({
        where: { mapId: w.mapId },
        create: { mapId: w.mapId, clanId: winnerId, capturedAt: w.endsAt },
        update: { clanId: winnerId, capturedAt: w.endsAt },
      });
      return { previous: cur?.clanId ?? null };
    });
    if (!applied) continue;
    changed++;
    if (applied.previous !== winnerId) {
      const leaders = await db.clanMember.findMany({ where: { clanId: { in: [winnerId, ...(applied.previous ? [applied.previous] : [])] }, role: { in: ["LEADER", "OFFICER"] } }, select: { userId: true, clanId: true } });
      const mapName = MAPS_BY_ID.get(w.mapId)?.name ?? w.mapId;
      for (const l of leaders) {
        const won = l.clanId === winnerId;
        await notify(db, l.userId, won ? "CLAN_TERRITORY_CAPTURED" : "CLAN_TERRITORY_LOST", won ? "Territory captured" : "Territory lost", `${mapName} ${won ? "is now held by your clan" : "was taken by another clan"}.`, { mapId: w.mapId, warId: w.id });
      }
    }
  }
  return changed;
}
