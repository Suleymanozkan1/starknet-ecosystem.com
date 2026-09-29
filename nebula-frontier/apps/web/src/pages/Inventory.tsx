import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ITEMS_BY_ID } from "@nebula/config";
import { CurrencyAmount, HoloPanel, Icon, Modal, NeonButton, RarityBadge, StatBar, Tabs } from "@nebula/game-ui";
import { RARITY_ORDER } from "@nebula/shared";
import type { InventoryItemDto, ItemCategory } from "@nebula/shared";
import { api } from "../lib/api.js";
import { idempotencyKey } from "../lib/http.js";
import { qk, useApiMutation, useInventory } from "../lib/queries.js";
import { En, contentText, enumLabel, tNow, useT } from "../lib/i18n.js";
import type { TKey } from "../lib/i18n.js";
import { PageHeader } from "../components/PageHeader.js";
import { EmptyState, QueryState } from "../components/QueryState.js";
import { ItemIcon, ItemTile } from "../components/ItemTile.js";
import { haptic } from "../native/haptics.js";
import { toast } from "../store/ui.js";

const FILTERS: { key: string; label: TKey; cats: ItemCategory[] | null }[] = [
  { key: "ALL", label: "common.all", cats: null },
  { key: "WEAPONS", label: "nav.weapons", cats: ["WEAPON"] },
  { key: "MODULES", label: "nav.modules", cats: ["MODULE"] },
  { key: "GENERATORS", label: "inv.generators", cats: ["GENERATOR"] },
  { key: "PARTS", label: "inv.parts", cats: ["SHIP_PART", "SHIP"] },
  { key: "DRONES", label: "nav.drones", cats: ["DRONE", "PET"] },
  { key: "SKINS", label: "inv.skins", cats: ["SKIN", "COSMETIC"] },
  { key: "RESOURCES", label: "inv.resources", cats: ["RESOURCE", "BLUEPRINT"] },
  { key: "CONSUMABLES", label: "inv.consumables", cats: ["CONSUMABLE", "AMMO", "BOOSTER"] },
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
  const t = useT();
  const def = ITEMS_BY_ID.get(item.itemId);
  const upgrade = useApiMutation(() => api.inventory.upgrade(item.id, idempotencyKey("itemup")), {
    invalidate: [qk.inventory, qk.me, qk.ships],
    errorTitle: t("hangar.upgradeFailed"),
    onSuccess: (r) => {
      haptic(r.success ? "success" : "warning");
      if (r.success) toast.success(tNow("hangar.upgradeOk"), tNow("hangar.nowPlus", { name: item.name, n: r.toLevel }));
      else toast.warn(tNow("hangar.upgradeFailed"), tNow("inv.upgradeFailBody"));
      onClose();
    },
  });
  return (
    <Modal open onClose={onClose} locked={upgrade.isPending} title={<En>{item.name}</En>}
      footer={
        <>
          {item.tradeable && !item.equippedOn && <Link to={`/market?sell=${item.id}`} className="nf-btn nf-btn--sm no-underline" onClick={onClose}>{t("inv.sell")}</Link>}
          {def?.powerItem && !def.stackable && <NeonButton size="sm" variant="primary" loading={upgrade.isPending} onClick={() => upgrade.mutate(undefined)}>{t("inv.upgradeTo", { n: item.upgradeLevel + 1 })}</NeonButton>}
        </>
      }
    >
      <div className="grid gap-4">
        <div className="flex items-center gap-4">
          <div className="grid h-20 w-20 place-items-center rounded-xl border border-line bg-black/30"><ItemIcon item={item} size={44} /></div>
          <div className="grid gap-1.5">
            <div className="flex flex-wrap items-center gap-2"><RarityBadge rarity={item.rarity} /><span className="nf-chip">{enumLabel(item.category)}</span>{item.upgradeLevel > 0 && <span className="nf-chip text-accent">+{item.upgradeLevel}</span>}</div>
            <div className="text-[13px] text-dim">{contentText("item", item.itemId, def?.description)}</div>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded-md border border-line p-2"><div className="nf-label">{t("inv.power")}</div><div className="nf-display text-[16px] font-bold">{Math.round(item.power)}</div></div>
          <div className="rounded-md border border-line p-2"><div className="nf-label">{t("inv.qty")}</div><div className="nf-display text-[16px] font-bold">{item.quantity}</div></div>
          <div className="rounded-md border border-line p-2"><div className="nf-label">{t("inv.value")}</div><CurrencyAmount amount={item.value} currency="CREDITS" size={14} showSymbol={false} /></div>
        </div>
        {item.affixes.length > 0 && (
          <div className="grid gap-2">
            <div className="nf-label">{t("inv.affixes")}</div>
            {item.affixes.map((a, i) => <StatBar key={i} label={enumLabel(a.stat.replace(/([A-Z])/g, "_$1"))} value={a.value} max={Math.max(1, a.value * 1.5)} height={4} ghost={false} format={(v) => `+${v}`} />)}
          </div>
        )}
        <div className="flex flex-wrap gap-2 text-[12px] text-mute">
          {item.equippedOn ? <span className="nf-chip" style={{ color: "var(--nf-good)" }}>{t("item.equipped")}</span> : <span className="nf-chip">{t("inv.inCargo")}</span>}
          <span className="nf-chip">{item.tradeable ? t("inv.tradeable") : t("inv.notTradeable")}</span>
          {item.soulbound && <span className="nf-chip">{t("item.soulbound")}</span>}
        </div>
      </div>
    </Modal>
  );
}

export default function InventoryPage() {
  const t = useT();
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
        eyebrow={t("inv.eyebrow")}
        title={t("nav.inventory")}
        actions={cap > 0 ? <div className="w-48"><StatBar label={t("inv.capacity")} value={used} max={cap} height={5} color={used / cap > 0.9 ? "var(--nf-bad)" : "var(--nf-accent)"} ghost={false} format={(v, m) => `${v}/${m}`} /></div> : undefined}
      />
      <HoloPanel padded={false} className="mb-4">
        <Tabs value={filter} onChange={(k) => setParams(k === "ALL" ? {} : { cat: k })} items={FILTERS.map((f) => ({ key: f.key, label: t(f.label), count: counts[f.key] ?? 0 }))} ariaLabel={t("inv.categories")} />
        <div className="flex flex-wrap items-center gap-2 p-3">
          <div className="relative min-w-[200px] flex-1">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-mute"><Icon name="search" size={16} /></span>
            <input className="nf-input pl-9" placeholder={t("inv.search")} value={search} onChange={(e) => setSearch(e.target.value)} aria-label={t("inv.search")} />
          </div>
          <select className="nf-input w-auto" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label={t("inv.sort")}>
            <option value="recent">{t("inv.sort.recent")}</option>
            <option value="rarity">{t("inv.sort.rarity")}</option>
            <option value="level">{t("inv.sort.level")}</option>
            <option value="power">{t("inv.sort.power")}</option>
            <option value="value">{t("inv.sort.value")}</option>
          </select>
        </div>
      </HoloPanel>
      <QueryState q={q} skeleton={4}>
        {() => visible.length === 0 ? (
          <EmptyState title={t("inv.noMatch")} body={search ? t("inv.tryDifferent") : t("inv.fillHold")} icon="inventory" />
        ) : (
          <div className="nf-grid-cards" style={{ "--card-min": "170px" } as CSSProperties}>
            {visible.map((i) => <ItemTile key={i.id} item={i} onClick={() => setDetail(i)} />)}
          </div>
        )}
      </QueryState>
      {detail && <ItemDetail item={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}
