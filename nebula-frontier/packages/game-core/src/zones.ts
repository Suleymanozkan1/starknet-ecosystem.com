/**
 * Map zone queries (safe / pvp / mining…), portal & station proximity.
 */
import type { MapDef, PortalDef, StationDef, ZoneDef, ZoneType } from "@nebula/shared";

/** Zone precedence when circles overlap: the most specific/restrictive wins. */
const PRECEDENCE: Record<ZoneType, number> = {
  SAFE: 9, BOSS: 8, GATE: 7, EVENT: 6, PVP: 5, HIGH_RISK: 4, PIRATE: 3, MINING: 2, NEUTRAL: 1,
};

export function zonesAt(map: Pick<MapDef, "zones">, x: number, y: number): ZoneDef[] {
  return map.zones.filter((z) => (x - z.x) ** 2 + (y - z.y) ** 2 <= z.radius * z.radius);
}

export function zoneTypeAt(map: Pick<MapDef, "zones" | "pvp">, x: number, y: number): ZoneType {
  let best: ZoneType = map.pvp ? "PVP" : "NEUTRAL";
  let bestP = -1;
  for (const z of zonesAt(map, x, y)) {
    const p = PRECEDENCE[z.type] ?? 0;
    if (p > bestP) {
      bestP = p;
      best = z.type;
    }
  }
  return best;
}

export function isSafeAt(map: Pick<MapDef, "zones" | "pvp">, x: number, y: number): boolean {
  return zoneTypeAt(map, x, y) === "SAFE";
}

/**
 * Player-vs-player damage allowed at this point? Never in SAFE zones; otherwise
 * only on PvP maps or inside explicit PVP / HIGH_RISK zones. PIRATE zones mark
 * NPC-pirate territory and do NOT enable PvP on a non-PvP map by themselves.
 */
export function isPvpAllowedAt(map: Pick<MapDef, "zones" | "pvp">, x: number, y: number): boolean {
  const t = zoneTypeAt(map, x, y);
  if (t === "SAFE") return false;
  return map.pvp || t === "PVP" || t === "HIGH_RISK";
}

export function nearestPortal(map: Pick<MapDef, "portals">, x: number, y: number, maxDist: number): PortalDef | null {
  let best: PortalDef | null = null;
  let bd = maxDist * maxDist;
  for (const p of map.portals) {
    const d = (p.x - x) ** 2 + (p.y - y) ** 2;
    if (d <= bd) { bd = d; best = p; }
  }
  return best;
}

export function stationInRange(map: Pick<MapDef, "stations">, stationId: string, x: number, y: number, maxDist: number): StationDef | null {
  const s = map.stations.find((st) => st.id === stationId);
  if (!s) return null;
  return (s.x - x) ** 2 + (s.y - y) ** 2 <= maxDist * maxDist ? s : null;
}

/** Spawn point for a player: faction home station, else first safe zone, else map center. */
export function spawnPoint(map: MapDef, faction: string | null, portalId?: string | null): { x: number; y: number } {
  if (portalId) {
    const p = map.portals.find((pp) => pp.id === portalId);
    if (p) return { x: p.x, y: p.y };
  }
  const st = (faction && map.stations.find((s) => s.faction === faction)) || map.stations[0];
  if (st) return { x: st.x, y: st.y };
  const safe = map.zones.find((z) => z.type === "SAFE");
  if (safe) return { x: safe.x, y: safe.y };
  return { x: map.width / 2, y: map.height / 2 };
}
