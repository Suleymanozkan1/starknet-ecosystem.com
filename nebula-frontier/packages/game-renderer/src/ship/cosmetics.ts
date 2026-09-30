import type { CosmeticPayload, NpcDef, ShipVisualDef } from "@nebula/shared";
import { ITEMS_BY_ID } from "@nebula/config";
import { hashString } from "../core/random.js";
import type { ShipPalette } from "./materials.js";

/** Visual look resolved from a ship visual + equipped cosmetics. */
export interface ResolvedLook {
  visual: ShipVisualDef;
  palette: ShipPalette;
  trail?: { colors: string[]; effect?: string };
  shield?: { color: string; effect?: string };
  explosion?: { colors: string[]; effect?: string };
  weaponColors?: string[];
  droneColors?: string[];
  /** Special material effect such as "void_shimmer". */
  hullEffect?: string;
}

/**
 * Parse the `EntitySnapshot.cosmetics` string. Accepts a JSON array of item ids,
 * or a comma / pipe / semicolon separated list.
 */
export function parseCosmeticIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const s = raw.trim();
  if (!s) return [];
  if (s.startsWith("[")) {
    try {
      const v: unknown = JSON.parse(s);
      if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
    } catch {
      return [];
    }
  }
  return s.split(/[,|;]/).map((x) => x.trim()).filter(Boolean);
}

/** Look up cosmetic payloads for item ids (unknown/non-cosmetic ids are ignored). */
export function resolveCosmeticPayloads(ids: readonly string[]): CosmeticPayload[] {
  const out: CosmeticPayload[] = [];
  for (const id of ids) {
    const item = ITEMS_BY_ID.get(id);
    if (item?.cosmeticPayload) out.push(item.cosmeticPayload);
  }
  return out;
}

/** Apply cosmetics (skins may override geometry and colors) to a base visual. */
export function resolveLook(base: ShipVisualDef, cosmetics: readonly CosmeticPayload[] = [], shipId?: string): ResolvedLook {
  let visual: ShipVisualDef = base;
  const palette: ShipPalette = { primary: base.primaryColor, secondary: base.secondaryColor, accent: base.accentColor, engine: base.engineColor };
  const look: ResolvedLook = { visual, palette };
  for (const c of cosmetics) {
    switch (c.slot) {
      case "HULL_SKIN": {
        if (c.shipId && shipId && c.shipId !== shipId) break;
        const [p, s, a, e] = c.colors ?? [];
        if (p) palette.primary = p;
        if (s) palette.secondary = s;
        if (a) palette.accent = a;
        if (e) palette.engine = e;
        if (c.geometry) {
          const { hardpoints, ...rest } = c.geometry;
          // A geometry-changing skin no longer matches the ship's production GLB → keep it procedural.
          const { glb: _glb, ...base } = visual;
          visual = { ...base, ...rest, ...(hardpoints ? { hardpoints } : {}) };
        }
        if (c.effect) look.hullEffect = c.effect;
        break;
      }
      case "ENGINE_COLOR":
        if (c.colors?.[0]) palette.engine = c.colors[0];
        break;
      case "ENGINE_EFFECT":
      case "TRAIL":
        look.trail = { colors: c.colors ?? [palette.engine], effect: c.effect };
        break;
      case "SHIELD_COLOR":
        if (c.colors?.[0]) look.shield = { color: c.colors[0], effect: look.shield?.effect };
        break;
      case "SHIELD_EFFECT":
        look.shield = { color: look.shield?.color ?? c.colors?.[0] ?? palette.accent, effect: c.effect };
        break;
      case "EXPLOSION":
        look.explosion = { colors: c.colors ?? [], effect: c.effect };
        break;
      case "WEAPON_SKIN":
        look.weaponColors = c.colors;
        break;
      case "DRONE_SKIN":
        look.droneColors = c.colors;
        break;
      default:
        break;
    }
  }
  look.visual = visual;
  return look;
}

const ENGINES: ShipVisualDef["engine"][] = ["twin", "quad", "single-large", "cluster", "vector", "ion-array"];
const WINGS: ShipVisualDef["wings"][] = ["swept", "delta", "blade", "forward-swept", "folded", "canard", "none"];
const ARMOR: ShipVisualDef["armor"][] = ["plated", "heavy", "ablative", "crystal", "light"];

/** Synthesize a full ShipVisualDef for an NPC (NPC data only defines hull/scale/colors). */
export function npcVisual(npc: Pick<NpcDef, "id" | "visual" | "kind">): ShipVisualDef {
  const h = hashString(npc.id);
  const L = 3 * npc.visual.scale;
  const hull = npc.visual.hull;
  const pick = <T>(list: readonly T[], salt: number): T => list[(h >>> salt) % list.length] as T;
  const wings = hull === "halo" ? "ring" : hull === "monolith" || hull === "beetle" ? "none" : pick(WINGS, 3);
  const engine = hull === "halo" ? "ring" : pick(ENGINES, 7);
  const nozzleCount = L > 12 ? 5 : L > 5 ? 3 : 2;
  const nozzles: [number, number, number][] = [];
  for (let i = 0; i < nozzleCount; i++) {
    const t = i / (nozzleCount - 1) - 0.5;
    nozzles.push([t * L * 0.3, 0, -L / 2]);
  }
  const hpCount = Math.min(8, 2 + Math.floor(L / 4));
  const hardpoints: [number, number, number][] = [];
  for (let i = 0; i < hpCount; i++) {
    const side = i % 2 === 0 ? 1 : -1;
    const row = Math.floor(i / 2);
    hardpoints.push([side * L * (0.12 + row * 0.07), 0, L * (0.32 - row * 0.12)]);
  }
  const darker = npc.visual.color;
  return {
    hull,
    engine,
    wings,
    cockpit: npc.kind === "BOSS" ? "bridge" : pick(["slit", "sensor-eye", "canopy", "bubble"] as const, 11),
    reactor: pick(["exposed-core", "ring-core", "twin-cell", "buried"] as const, 13),
    armor: pick(ARMOR, 17),
    antenna: pick(["spikes", "mast", "array", "none"] as const, 19),
    cargo: "none",
    droneDock: npc.kind === "BOSS",
    scale: npc.visual.scale,
    length: L,
    primaryColor: darker,
    secondaryColor: `#${((h & 0x3f3f3f) + 0x202020).toString(16).padStart(6, "0")}`,
    accentColor: npc.visual.accent,
    engineColor: npc.visual.accent,
    hardpoints,
    nozzles,
  };
}
