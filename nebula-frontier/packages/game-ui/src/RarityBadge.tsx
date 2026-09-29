import type { CSSProperties } from "react";
import type { Rarity } from "@nebula/shared";
import { cx } from "./cx.js";
import { uiLocale } from "./locale.js";

export const RARITY_COLORS: Record<Rarity, string> = {
  COMMON: "#a3adbf",
  UNCOMMON: "#4ade80",
  RARE: "#60a5fa",
  EPIC: "#c084fc",
  LEGENDARY: "#fbbf24",
  ANCIENT: "#2dd4bf",
  MYTHIC: "#fb5a7a",
  PROTOTYPE: "#e0f2fe",
};

export function rarityColor(r: string): string {
  return (RARITY_COLORS as Record<string, string>)[r] ?? RARITY_COLORS.COMMON;
}

/** CSS variables to put on a card so `.nf-rarity-frame` picks up the rarity color. */
export function rarityStyle(r: string): CSSProperties {
  return { "--rc": rarityColor(r) } as CSSProperties;
}

export function RarityBadge({ rarity, className, label }: { rarity: Rarity | string; className?: string; label?: string }) {
  return (
    <span className={cx("nf-rarity", className)} style={rarityStyle(rarity)}>
      {label ?? uiLocale().rarity[rarity] ?? rarity.toLowerCase()}
    </span>
  );
}
