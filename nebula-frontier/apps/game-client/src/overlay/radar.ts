/**
 * Pure radar (minimap) logic used by the Phaser overlay: map → radar projection, clipping and the
 * marker style (shape / colour / size) of every relation. No Phaser import, so it is unit-testable.
 */
import type { MapDef, ZoneType } from "@nebula/shared";
import type { MinimapRelation } from "../types.js";

export const RELATION_COLORS: Readonly<Record<MinimapRelation, number>> = {
  self: 0xffffff, squad: 0x3ef08a, clan: 0x5fd4ff, faction: 0x6ea8ff, hostile: 0xff4d4d, neutral: 0xc9c9c9, npc: 0xff8a3d,
  boss: 0xff2d7a, resource: 0xffd166, loot: 0xb388ff, portal: 0x6ee7ff, station: 0x9fe8ff, objective: 0xfff275, event: 0xff9f43,
  marker: 0xffffff,
};

export interface RadarLayout {
  /** Radar pixels per map unit. */
  scale: number;
  /** Top-left of the radar map area on screen. */
  x0: number;
  y0: number;
  w: number;
  h: number;
}

/** Radar box in the top-right corner (compact on small screens), aspect-correct for the map. */
export function radarLayout(map: Pick<MapDef, "width" | "height">, screenWidth: number, compact: boolean, out?: RadarLayout): RadarLayout {
  const maxW = compact ? 130 : 210;
  const scale = maxW / Math.max(map.width, map.height * 1.25);
  const w = map.width * scale, h = map.height * scale;
  const o = out ?? { scale: 0, x0: 0, y0: 0, w: 0, h: 0 };
  o.scale = scale;
  o.w = w;
  o.h = h;
  o.x0 = screenWidth - w - 14;
  o.y0 = 14;
  return o;
}

/** Project a map position onto the radar. Returns false when it falls outside the radar box (2px tolerance). */
export function projectToRadar(l: RadarLayout, mx: number, my: number, out: { x: number; y: number }): boolean {
  out.x = l.x0 + mx * l.scale;
  out.y = l.y0 + my * l.scale;
  return !(out.x < l.x0 - 2 || out.y < l.y0 - 2 || out.x > l.x0 + l.w + 2 || out.y > l.y0 + l.h + 2);
}

export type RadarShape = "dot" | "square" | "ring" | "boss";

export interface RadarMarker {
  shape: RadarShape;
  color: number;
  alpha: number;
  /** Radius for dot/ring/boss, half-size for square. */
  size: number;
}

/** Marker style of an entity relation (bosses get a haloed dot, objectives/events/markers a ring). */
export function radarMarker(rel: MinimapRelation): RadarMarker {
  const color = RELATION_COLORS[rel];
  switch (rel) {
    case "boss": return { shape: "boss", color, alpha: 1, size: 4.5 };
    case "resource": return { shape: "square", color, alpha: 0.7, size: 1 };
    case "loot": return { shape: "square", color, alpha: 0.9, size: 1.5 };
    case "objective": case "event": case "marker": return { shape: "ring", color, alpha: 1, size: 4 };
    default: return { shape: "dot", color, alpha: 1, size: rel === "npc" ? 1.8 : 2.3 };
  }
}

/** Outline colour of a map zone on the radar. */
export function zoneColor(type: ZoneType): number {
  return type === "SAFE" ? 0x38d98a : type === "PVP" || type === "HIGH_RISK" ? 0xff4d4d : type === "MINING" ? 0xffd166 : type === "BOSS" ? 0xc77dff : 0x5a7aa5;
}
