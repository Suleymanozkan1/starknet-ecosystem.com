import { ITEMS_BY_ID, WEAPONS_BY_ID } from "@nebula/config";
import type { EquipRequest, InventoryItemDto, LoadoutDto, ShipDef } from "@nebula/shared";

export type SlotType = EquipRequest["slotType"];

export const SLOT_TYPES: { key: SlotType; label: string; shipSlot: keyof ShipDef["slots"]; icon: "weapon" | "rocket" | "energy" | "module" | "drone" }[] = [
  { key: "weapons", label: "Lasers", shipSlot: "laser", icon: "weapon" },
  { key: "missiles", label: "Missiles", shipSlot: "missile", icon: "rocket" },
  { key: "generators", label: "Generators", shipSlot: "generator", icon: "energy" },
  { key: "modules", label: "Modules", shipSlot: "module", icon: "module" },
  { key: "drones", label: "Drones", shipSlot: "drone", icon: "drone" },
];

/** Which loadout slot family an inventory item fits into (mirrors the server's slotFamilyFor). */
export function slotFamilyOf(item: Pick<InventoryItemDto, "itemId" | "category">): SlotType | null {
  switch (item.category) {
    case "WEAPON": {
      const ref = ITEMS_BY_ID.get(item.itemId)?.ref;
      const w = ref ? WEAPONS_BY_ID.get(ref) : undefined;
      return w?.slot === "MISSILE" ? "missiles" : "weapons";
    }
    case "GENERATOR": return "generators";
    case "MODULE": return "modules";
    case "DRONE": return "drones";
    default: return null;
  }
}

export function slotArray(lo: LoadoutDto, t: SlotType, count: number): (string | null)[] {
  const arr = [...(lo[t] ?? [])];
  while (arr.length < count) arr.push(null);
  return arr.slice(0, count);
}

export const COSMETIC_SLOTS = ["HULL_SKIN", "ENGINE_EFFECT", "ENGINE_COLOR", "SHIELD_COLOR", "SHIELD_EFFECT", "TRAIL", "WEAPON_SKIN", "DRONE_SKIN", "EXPLOSION"] as const;
export type CosmeticSlot = (typeof COSMETIC_SLOTS)[number];

export function cosmeticSlotOf(itemId: string): string | null {
  return ITEMS_BY_ID.get(itemId)?.cosmeticPayload?.slot ?? null;
}
export function cosmeticShipOf(itemId: string): string | null {
  return ITEMS_BY_ID.get(itemId)?.cosmeticPayload?.shipId ?? null;
}
