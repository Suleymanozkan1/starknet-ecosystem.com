import type { DragEvent } from "react";
import { Icon, RarityBadge, rarityColor, rarityStyle } from "@nebula/game-ui";
import type { InventoryItemDto } from "@nebula/shared";
import { CATEGORY_META, RESOURCE_META } from "../lib/gameMeta.js";
import type { ResourceId } from "@nebula/shared";
import { fmtNum, useT } from "../lib/i18n.js";

export const DND_MIME = "application/x-nf-item";

export function ItemIcon({ item, size = 28 }: { item: Pick<InventoryItemDto, "category" | "itemId" | "rarity">; size?: number }) {
  if (item.category === "RESOURCE") {
    const res = item.itemId.replace(/^res_/, "").toUpperCase() as ResourceId;
    const c = RESOURCE_META[res]?.color ?? rarityColor(item.rarity);
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
        <path d="M12 2 20 8 17 20H7L4 8Z" fill={c} fillOpacity="0.25" stroke={c} strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M12 2v18M4 8l8 4 8-4" stroke={c} strokeOpacity="0.6" strokeWidth="1" fill="none" />
      </svg>
    );
  }
  const meta = CATEGORY_META[item.category] ?? CATEGORY_META.CONSUMABLE;
  return <span style={{ color: rarityColor(item.rarity), filter: `drop-shadow(0 0 6px ${rarityColor(item.rarity)})` }}><Icon name={meta.icon} size={size} /></span>;
}

export interface ItemTileProps {
  item: InventoryItemDto;
  onClick?: () => void;
  selected?: boolean;
  draggable?: boolean;
  compact?: boolean;
}

/** Inventory card with rarity frame; draggable onto hangar slots (desktop). */
export function ItemTile({ item, onClick, selected, draggable, compact }: ItemTileProps) {
  const t = useT();
  const onDragStart = (e: DragEvent<HTMLButtonElement>): void => {
    e.dataTransfer.setData(DND_MIME, item.id);
    e.dataTransfer.setData("text/plain", item.name);
    e.dataTransfer.effectAllowed = "move";
  };
  return (
    <button
      type="button"
      onClick={onClick}
      draggable={draggable}
      onDragStart={draggable ? onDragStart : undefined}
      className="nf-panel nf-panel--interactive nf-rarity-frame relative grid content-start gap-2 p-3 text-left"
      style={{ ...rarityStyle(item.rarity), outline: selected ? `2px solid ${rarityColor(item.rarity)}` : undefined }}
      title={item.name}
      data-testid="item-tile"
    >
      <div className="flex items-start justify-between gap-2">
        <ItemIcon item={item} size={compact ? 24 : 30} />
        <div className="flex flex-col items-end gap-1">
          {item.upgradeLevel > 0 && <span className="nf-display text-[13px] font-bold text-accent">+{item.upgradeLevel}</span>}
          {item.quantity > 1 && <span className="nf-ui text-[12px] font-bold tabular-nums text-dim">×{fmtNum(item.quantity)}</span>}
        </div>
      </div>
      <div className={compact ? "nf-ui line-clamp-2 text-[13px] font-bold leading-tight" : "nf-ui line-clamp-2 text-[14.5px] font-bold leading-tight"}>{item.name}</div>
      {!compact && (
        <div className="flex flex-wrap items-center gap-1.5">
          <RarityBadge rarity={item.rarity} />
          {item.power > 0 && <span className="nf-ui text-[11px] uppercase tracking-[0.12em] text-mute">{t("item.pwr", { n: Math.round(item.power) })}</span>}
        </div>
      )}
      {item.equippedOn && <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-good shadow-[0_0_8px_var(--nf-good)]" title={t("item.equipped")} />}
      {item.soulbound && !compact && <span className="nf-label text-[9.5px]">{t("item.soulbound")}</span>}
    </button>
  );
}
