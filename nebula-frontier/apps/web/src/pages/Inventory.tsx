import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ITEMS_BY_ID } from "@nebula/config";
import { CurrencyAmount, HoloPanel, Icon, Modal, NeonButton, RarityBadge, StatBar, Tabs } from "@nebula/game-ui";
import { RARITY_ORDER } from "@nebula/shared";
import type { InventoryItemDto, ItemCategory } from "@nebula/shared";
import { api } from "../lib/api.js";
import { idempotencyKey } from "../lib/http.js";
import { qk, useApiMutation, useInventory } from "../lib/queries.js";
import { humanize } from "../lib/gameMeta.js";
import { PageHeader } from "../components/PageHeader.js";
import { EmptyState, QueryState } from "../components/QueryState.js";
import { ItemIcon, ItemTile } from "../components/ItemTile.js";
import { haptic } from "../native/haptics.js";
import { toast } from "../store/ui.js";

const FILTERS: { key: string; label: string; cats: ItemCategory[] | null }[] = [
  { key: "ALL", label: "All", cats: null },
  { key: "WEAPONS", label: "Weapons", cats: ["WEAPON"] },
  { key: "MODULES", label: "Modules", cats: ["MODULE"] },
  { key: "GENERATORS", label: "Generators", cats: ["GENERATOR"] },
  { key: "PARTS", label: "Ship Parts", cats: ["SHIP_PART", "SHIP"] },
  { key: "DRONES", label: "Drones", cats: ["DRONE", "PET"] },
  { key: "SKINS", label: "Skins", cats: ["SKIN", "COSMETIC"] },
  { key: "RESOURCES", label: "Resources", cats: ["RESOURCE", "BLUEPRINT"] },
  { key: "CONSUMABLES", label: "Consumables", cats: ["CONSUMABLE", "AMMO", "BOOSTER"] },
];
type Sort = "rarity" | "level" | "power" | "recent" | "value";
const SORTS: Record<Sort, (a: InventoryItemDto, b: InventoryItemDto) => number> = {
  rarity: (a, b) => RARITY_ORDER[b.rarity] - RARITY_ORDER[a.rarity],
  level: (a, b) => b.upgradeLevel - a.upgradeLevel,
  power: (a, b) => b.power - a.power,
  recent: (a, b) => b.acquiredAt.localeCompare(a.acquiredAt),
  value: (a, b) => b.value - a.value,
};

function ItemDetail({ item, onClose }: { item: InventoryItemDto; onClose: () => void }) {
  const def = ITEMS_BY_ID.get(item.itemId);
  const upgrade = useApiMutation(() => api.inventory.upgrade(item.id, idempotencyKey("itemup")), {
    invalidate: [qk.inventory, qk.me, qk.ships],
    errorTitle: "Upgrade failed",
    onSuccess: (r) => {
      haptic(r.success ? "success" : "warning");
      if (r.success) toast.success("Upgrade successful", `${item.name} is now +${r.toLevel}`);
      else toast.warn("Upgrade failed", "Materials were consumed; the item keeps its level.");
      onClose();
    },
  });
  return (
    <Modal open onClose={onClose} locked={upgrade.isPending} title={item.name}
      footer={
        <>
          {item.tradeable && !item.equippedOn && <Link to={`/market?sell=${item.id}`} className="nf-btn nf-btn--sm no-underline" onClick={onClose}>Sell on market</Link>}
          {def?.powerItem && !def.stackable && <NeonButton size="sm" variant="primary" loading={upgrade.isPending} onClick={() => upgrade.mutate(undefined)}>Upgrade to +{item.upgradeLevel + 1}</NeonButton>}
        </>
      }
    >
      <div className="grid gap-4">
        <div className="flex items-center gap-4">
          <div className="grid h-20 w-20 place-items-center rounded-xl border border-line bg-black/30"><ItemIcon item={item} size={44} /></div>
          <div className="grid gap-1.5">
            <div className="flex flex-wrap items-center gap-2"><RarityBadge rarity={item.rarity} /><span className="nf-chip">{humanize(item.category)}</span>{item.upgradeLevel > 0 && <span className="nf-chip text-accent">+{item.upgradeLevel}</span>}</div>
            <div className="text-[13px] text-dim">{def?.description}</div>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded-md border border-line p-2"><div className="nf-label">Power</div><div className="nf-display text-[16px] font-bold">{Math.round(item.power)}</div></div>
          <div className="rounded-md border border-line p-2"><div className="nf-label">Qty</div><div className="nf-display text-[16px] font-bold">{item.quantity}</div></div>
          <div className="rounded-md border border-line p-2"><div className="nf-label">Value</div><CurrencyAmount amount={item.value} currency="CREDITS" size={14} showSymbol={false} /></div>
        </div>
        {item.affixes.length > 0 && (
          <div className="grid gap-2">
            <div className="nf-label">Affixes</div>
            {item.affixes.map((a, i) => <StatBar key={i} label={humanize(a.stat.replace(/([A-Z])/g, "_$1"))} value={a.value} max={Math.max(1, a.value * 1.5)} height={4} ghost={false} format={(v) => `+${v}`} />)}
          </div>
        )}
        <div className="flex flex-wrap gap-2 text-[12px] text-mute">
          {item.equippedOn ? <span className="nf-chip" style={{ color: "var(--nf-good)" }}>Equipped</span> : <span className="nf-chip">In cargo</span>}
          <span className="nf-chip">{item.tradeable ? "Tradeable" : "Not tradeable"}</span>
          {item.soulbound && <span className="nf-chip">Soulbound</span>}
        </div>
      </div>
    </Modal>
  );
}

export default function InventoryPage() {
  const [params, setParams] = useSearchParams();
  const filter = params.get("cat") ?? "ALL";
  const [sort, setSort] = useState<Sort>("recent");
  const [search, setSearch] = useState("");
  const [detail, setDetail] = useState<InventoryItemDto | null>(null);
  const q = useInventory();

  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const f of FILTERS) m[f.key] = (q.data?.items ?? []).filter((i) => !f.cats || f.cats.includes(i.category)).length;
    return m;
  }, [q.data]);

  const visible = useMemo(() => {
    const f = FILTERS.find((x) => x.key === filter) ?? FILTERS[0]!;
    const s = search.trim().toLowerCase();
    return (q.data?.items ?? [])
      .filter((i) => !f.cats || f.cats.includes(i.category))
      .filter((i) => !s || i.name.toLowerCase().includes(s))
      .sort(SORTS[sort]);
  }, [q.data, filter, search, sort]);

  const used = q.data?.items.length ?? 0;
  const cap = q.data?.capacity ?? 0;
  return (
    <div>
      <PageHeader
        eyebrow="Cargo"
        title="Inventory"
        actions={cap > 0 ? <div className="w-48"><StatBar label="Capacity" value={used} max={cap} height={5} color={used / cap > 0.9 ? "var(--nf-bad)" : "var(--nf-accent)"} ghost={false} format={(v, m) => `${v}/${m}`} /></div> : undefined}
      />
      <HoloPanel padded={false} className="mb-4">
        <Tabs value={filter} onChange={(k) => setParams(k === "ALL" ? {} : { cat: k })} items={FILTERS.map((f) => ({ key: f.key, label: f.label, count: counts[f.key] ?? 0 }))} ariaLabel="Item categories" />
        <div className="flex flex-wrap items-center gap-2 p-3">
          <div className="relative min-w-[200px] flex-1">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-mute"><Icon name="search" size={16} /></span>
            <input className="nf-input pl-9" placeholder="Search items" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search items" />
          </div>
          <select className="nf-input w-auto" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort">
            <option value="recent">Recent</option>
            <option value="rarity">Rarity</option>
            <option value="level">Level</option>
            <option value="power">Power</option>
            <option value="value">Value</option>
          </select>
        </div>
      </HoloPanel>
      <QueryState q={q} skeleton={4}>
        {() => visible.length === 0 ? (
          <EmptyState title="No items match" body={search ? "Try a different search." : "Loot, craft or buy gear to fill your hold."} icon="inventory" />
        ) : (
          <div className="nf-grid-cards" style={{ "--card-min": "170px" } as React.CSSProperties}>
            {visible.map((i) => <ItemTile key={i.id} item={i} onClick={() => setDetail(i)} />)}
          </div>
        )}
      </QueryState>
      {detail && <ItemDetail item={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}
