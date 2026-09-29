import type { EntitySnapshot, MapDef, ZoneType } from "@nebula/shared";
import { EntityFlag } from "@nebula/shared";
import type { MinimapRelation } from "../types.js";

export interface RelationContext {
  selfId: string;
  faction: string;
  clanTag: string;
  /** Current zone allows PvP. */
  pvp: boolean;
  /** Cloaked entities revealed by scans. */
  scanned: Set<string>;
}

/**
 * Relation of an entity to the local player for radar/nameplate colouring.
 * Returns null for entities that must not be shown (cloaked and not scanned).
 */
export function relationOf(e: Pick<EntitySnapshot, "id" | "kind" | "faction" | "clanTag" | "flags" | "cloaked">, ctx: RelationContext): MinimapRelation | null {
  if (e.id === ctx.selfId) return "self";
  if (e.cloaked && !ctx.scanned.has(e.id)) return null;
  switch (e.kind) {
    case "NPC": return "npc";
    case "BOSS": return "boss";
    case "ASTEROID": return "resource";
    case "LOOT": return "loot";
    case "PORTAL": return "portal";
    case "STATION": return "station";
    case "DRONE": return "neutral";
    case "PROJECTILE": return null;
    case "PLAYER":
      if ((e.flags & EntityFlag.SQUAD) !== 0) return "squad";
      if (ctx.clanTag && e.clanTag === ctx.clanTag) return "clan";
      if (ctx.faction && e.faction === ctx.faction) return "faction";
      return ctx.pvp ? "hostile" : "neutral";
  }
  return "neutral";
}

const ZONE_PRIORITY: readonly ZoneType[] = ["SAFE", "BOSS", "PVP", "HIGH_RISK", "PIRATE", "EVENT", "GATE", "MINING", "NEUTRAL"];

/** Zone type at a map position (highest-priority containing zone; map default otherwise). */
export function computeZone(map: Pick<MapDef, "zones" | "pvp">, x: number, y: number): ZoneType {
  let best: ZoneType | null = null;
  let bestRank = Infinity;
  for (const z of map.zones) {
    if ((x - z.x) ** 2 + (y - z.y) ** 2 > z.radius * z.radius) continue;
    const rank = ZONE_PRIORITY.indexOf(z.type);
    if (rank < bestRank) {
      bestRank = rank;
      best = z.type;
    }
  }
  return best ?? (map.pvp ? "PVP" : "NEUTRAL");
}
