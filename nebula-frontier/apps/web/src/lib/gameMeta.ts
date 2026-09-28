/** Presentation metadata (labels/colors/icons) — no balance numbers live here. */
import { FACTIONS_BY_ID, ITEMS_BY_ID, MAPS_BY_ID, SHIPS_BY_ID } from "@nebula/config";
import type { FactionDef, ItemCategory, ResourceId } from "@nebula/shared";
import type { IconName } from "@nebula/game-ui";

export const ZONE_META: Record<string, { label: string; color: string }> = {
  SAFE: { label: "Safe zone", color: "#34d399" },
  NEUTRAL: { label: "Neutral", color: "#93c5fd" },
  PVP: { label: "PvP", color: "#fb5a7a" },
  HIGH_RISK: { label: "High risk", color: "#f97316" },
  PIRATE: { label: "Pirate space", color: "#facc15" },
  EVENT: { label: "Event", color: "#c084fc" },
  BOSS: { label: "Boss", color: "#f43f5e" },
  GATE: { label: "Gate", color: "#a78bfa" },
  MINING: { label: "Mining", color: "#5eead4" },
};

export const ROOM_META: Record<string, { label: string; icon: IconName }> = {
  sector: { label: "Sector", icon: "galaxy" },
  pvp: { label: "PvP Arena", icon: "sword" },
  boss: { label: "Boss Lair", icon: "crown" },
  gate: { label: "Gate", icon: "target" },
  raid: { label: "Raid", icon: "clan" },
  arena: { label: "Arena", icon: "trophy" },
  clanwar: { label: "Clan War", icon: "clan" },
  event: { label: "Event", icon: "events" },
};

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

export const RESOURCE_META: Record<ResourceId, { label: string; color: string }> = {
  TITANIUM: { label: "Titanium", color: "#cbd5e1" },
  PLASMA_ORE: { label: "Plasma Ore", color: "#f472b6" },
  DARK_MATTER: { label: "Dark Matter", color: "#8b5cf6" },
  QUANTUM_SHARD: { label: "Quantum Shard", color: "#22d3ee" },
  CRYONITE: { label: "Cryonite", color: "#93c5fd" },
  AETHER_CRYSTAL: { label: "Aether Crystal", color: "#fde68a" },
  VOID_ESSENCE: { label: "Void Essence", color: "#f43f5e" },
};

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

export function humanize(s: string): string {
  return s.toLowerCase().replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function relTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = Date.now() - new Date(iso).getTime();
  const abs = Math.abs(d);
  const fut = d < 0;
  const f = (n: number, u: string): string => (fut ? `in ${n}${u}` : `${n}${u} ago`);
  if (abs < 60_000) return fut ? "soon" : "just now";
  if (abs < 3_600_000) return f(Math.round(abs / 60_000), "m");
  if (abs < 86_400_000) return f(Math.round(abs / 3_600_000), "h");
  return f(Math.round(abs / 86_400_000), "d");
}

export function shortAddr(a: string | null | undefined, n = 4): string {
  if (!a) return "—";
  return a.length <= n * 2 + 3 ? a : `${a.slice(0, n)}…${a.slice(-n)}`;
}
