/** Presentation metadata (labels/colors/icons) — no balance numbers live here. */
import { FACTIONS_BY_ID, ITEMS_BY_ID, MAPS_BY_ID, NPCS_BY_ID, SHIPS_BY_ID } from "@nebula/config";
import type { FactionDef, ItemCategory, ResourceId } from "@nebula/shared";
import type { IconName } from "@nebula/game-ui";
import { EN } from "./i18n/en.js";
import type { TKey } from "./i18n/en.js";
import { enumLabel, humanize, tNow, translate, currentLanguage } from "./i18n.js";

export { humanize } from "./i18n.js";

function isKey(k: string): k is TKey {
  return Object.prototype.hasOwnProperty.call(EN, k);
}

export const ZONE_META: Record<string, { color: string }> = {
  SAFE: { color: "#34d399" },
  NEUTRAL: { color: "#93c5fd" },
  PVP: { color: "#fb5a7a" },
  HIGH_RISK: { color: "#f97316" },
  PIRATE: { color: "#facc15" },
  EVENT: { color: "#c084fc" },
  BOSS: { color: "#f43f5e" },
  GATE: { color: "#a78bfa" },
  MINING: { color: "#5eead4" },
};

/** Localised zone label (falls back to the raw zone id, as before). */
export function zoneLabel(zone: string): string {
  const k = `zone.${zone}`;
  return isKey(k) ? tNow(k) : zone;
}

export const ROOM_META: Record<string, { icon: IconName }> = {
  sector: { icon: "galaxy" },
  pvp: { icon: "sword" },
  boss: { icon: "crown" },
  gate: { icon: "target" },
  raid: { icon: "clan" },
  arena: { icon: "trophy" },
  clanwar: { icon: "clan" },
  event: { icon: "events" },
};

/** Localised room-type label (falls back to the raw room type, as before). */
export function roomLabel(roomType: string): string {
  const k = `room.${roomType}`;
  return isKey(k) ? tNow(k) : roomType;
}

export const CATEGORY_META: Record<ItemCategory, { label: string; icon: IconName }> = {
  SHIP: { label: "Ships", icon: "ship" },
  WEAPON: { label: "Weapons", icon: "weapon" },
  MODULE: { label: "Modules", icon: "module" },
  GENERATOR: { label: "Generators", icon: "energy" },
  DRONE: { label: "Drones", icon: "drone" },
  SHIP_PART: { label: "Ship Parts", icon: "hull" },
  SKIN: { label: "Skins", icon: "star" },
  COSMETIC: { label: "Cosmetics", icon: "star" },
  RESOURCE: { label: "Resources", icon: "pickaxe" },
  CONSUMABLE: { label: "Consumables", icon: "zap" },
  AMMO: { label: "Ammo", icon: "fire" },
  BLUEPRINT: { label: "Blueprints", icon: "crafting" },
  BOOSTER: { label: "Boosters", icon: "rocket" },
  PET: { label: "Pets", icon: "drone" },
};

export const RESOURCE_META: Record<ResourceId, { color: string }> = {
  TITANIUM: { color: "#cbd5e1" },
  PLASMA_ORE: { color: "#f472b6" },
  DARK_MATTER: { color: "#8b5cf6" },
  QUANTUM_SHARD: { color: "#22d3ee" },
  CRYONITE: { color: "#93c5fd" },
  AETHER_CRYSTAL: { color: "#fde68a" },
  VOID_ESSENCE: { color: "#f43f5e" },
};

/** Localised resource name (falls back to the raw id for unknown resources, as before). */
export function resourceLabel(id: string): string {
  const k = `resource.${id}`;
  return isKey(k) ? tNow(k) : id;
}

export const DEFAULT_ACCENT = "#6ee7ff";

export function faction(id: string | null | undefined): FactionDef | undefined {
  return id ? FACTIONS_BY_ID.get(id) : undefined;
}
export function factionColor(id: string | null | undefined): string {
  return faction(id)?.color ?? DEFAULT_ACCENT;
}
export function mapName(id: string | null | undefined): string {
  if (!id) return "—";
  return MAPS_BY_ID.get(id)?.name ?? id;
}
export function shipName(defId: string | null | undefined): string {
  if (!defId) return "—";
  return SHIPS_BY_ID.get(defId)?.name ?? defId;
}
export function itemName(itemId: string): string {
  return ITEMS_BY_ID.get(itemId)?.name ?? itemId.replace(/^item_|^res_/, "").replace(/_/g, " ");
}

export function relTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const lang = currentLanguage();
  const d = Date.now() - new Date(iso).getTime();
  const abs = Math.abs(d);
  const fut = d < 0;
  const f = (n: number, u: "time.m" | "time.h" | "time.d"): string => translate(lang, fut ? "time.in" : "time.ago", { n, u: translate(lang, u) });
  if (abs < 60_000) return translate(lang, fut ? "time.soon" : "time.justNow");
  if (abs < 3_600_000) return f(Math.round(abs / 60_000), "time.m");
  if (abs < 86_400_000) return f(Math.round(abs / 3_600_000), "time.h");
  return f(Math.round(abs / 86_400_000), "time.d");
}

/** Target of a quest objective (NPC / map / item name). */
export function objectiveTarget(target?: string): string {
  if (!target) return "";
  return NPCS_BY_ID.get(target)?.name ?? MAPS_BY_ID.get(target)?.name ?? itemName(target);
}

/** Objective label, e.g. "Kill Pirate Raider" (EN) / "Yok et: Korsan Akıncı" (TR). */
export function objectiveLabel(type: string, target?: string): string {
  const tgt = objectiveTarget(target);
  if (currentLanguage() === "en") return `${humanize(type)} ${tgt}`.trim();
  return tgt ? tNow("missions.objective", { type: enumLabel(type), target: tgt }) : enumLabel(type);
}

export function shortAddr(a: string | null | undefined, n = 4): string {
  if (!a) return "—";
  return a.length <= n * 2 + 3 ? a : `${a.slice(0, n)}…${a.slice(-n)}`;
}
