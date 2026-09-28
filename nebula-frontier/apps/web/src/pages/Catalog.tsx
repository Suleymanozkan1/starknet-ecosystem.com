import { useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router-dom";
import { DRONES, MODULES, WEAPONS, itemIdForDef } from "@nebula/config";
import { CurrencyAmount, HoloPanel, Icon, RarityBadge, Tabs, rarityColor, rarityStyle } from "@nebula/game-ui";
import type { Rarity } from "@nebula/shared";
import { useInventory, useShop } from "../lib/queries.js";
import { humanize } from "../lib/gameMeta.js";
import { PageHeader } from "../components/PageHeader.js";
import { EmptyState } from "../components/QueryState.js";

type Kind = "weapons" | "modules" | "drones";

interface Row {
  id: string;
  name: string;
  rarity: Rarity;
  type: string;
  requiredLevel: number;
  description?: string;
  stats: { label: string; value: ReactNode }[];
}

function rows(kind: Kind): Row[] {
  if (kind === "weapons") {
    return WEAPONS.map((w) => ({
      id: w.id, name: w.name, rarity: w.rarity, type: `${humanize(w.type)} · ${humanize(w.slot)}`, requiredLevel: w.requiredLevel,
      stats: [
        { label: "Damage", value: w.damage },
        { label: "Rate", value: `${w.fireRate}/s` },
        { label: "Range", value: w.range },
        { label: "Element", value: humanize(w.element) },
        { label: "Crit", value: `${Math.round(w.critChance * 100)}%` },
        { label: "Energy", value: w.energyCost },
      ],
    }));
  }
  if (kind === "modules") {
    return MODULES.map((m) => ({
      id: m.id, name: m.name, rarity: m.rarity, type: `${humanize(m.kind)} · ${humanize(m.slot)}`, requiredLevel: m.requiredLevel, description: m.description,
      stats: [
        ...Object.entries(m.passive).slice(0, 4).map(([k, v]) => ({ label: humanize(k.replace(/([A-Z])/g, "_$1")), value: `+${v}` })),
        ...(m.cooldownMs ? [{ label: "Cooldown", value: `${Math.round(m.cooldownMs / 1000)}s` }] : []),
      ],
    }));
  }
  return DRONES.map((d) => ({
    id: d.id, name: d.name, rarity: d.rarity, type: humanize(d.type), requiredLevel: d.requiredLevel,
    stats: [
      { label: "Hull", value: d.hull },
      { label: "Max level", value: d.maxLevel },
      { label: "Dmg / lvl", value: d.damagePerLevel },
      ...Object.entries(d.passivePerLevel).slice(0, 2).map(([k, v]) => ({ label: `${humanize(k)} / lvl`, value: `+${v}` })),
    ],
  }));
}

const TITLES: Record<Kind, { title: string; eyebrow: string; icon: "weapon" | "module" | "drone" }> = {
  weapons: { title: "Weapons", eyebrow: "Armory", icon: "weapon" },
  modules: { title: "Modules", eyebrow: "Engineering", icon: "module" },
  drones: { title: "Drones", eyebrow: "Drone bay", icon: "drone" },
};

/** Weapons / Modules / Drones reference: data-driven stats + what you own + live shop prices. */
export default function CatalogPage({ kind }: { kind: Kind }) {
  const inv = useInventory();
  const shop = useShop();
  const [owned, setOwned] = useState<"ALL" | "OWNED">("ALL");
  const [search, setSearch] = useState("");
  const all = useMemo(() => rows(kind), [kind]);
  const ownedCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of inv.data?.items ?? []) m.set(i.itemId, (m.get(i.itemId) ?? 0) + i.quantity);
    return m;
  }, [inv.data]);
  const priceFor = useMemo(() => {
    const m = new Map<string, { price: string; currency: "CREDITS" | "GEMS" | "NEBX" | "SOL"; id: string }>();
    for (const p of shop.data ?? []) {
      const g = p.grants as { items?: { itemId: string }[] } | null;
      if (g?.items?.length === 1 && g.items[0]) m.set(g.items[0].itemId, { price: p.price, currency: p.currency, id: p.id });
    }
    return m;
  }, [shop.data]);
  const s = search.trim().toLowerCase();
  const list = all.filter((r) => (owned === "ALL" || ownedCount.has(itemIdForDef(r.id))) && (!s || r.name.toLowerCase().includes(s)));
  const t = TITLES[kind];

  return (
    <div>
      <PageHeader eyebrow={t.eyebrow} title={t.title} actions={<Link to="/inventory" className="nf-btn nf-btn--sm nf-btn--ghost no-underline">Inventory</Link>} />
      <HoloPanel padded={false} className="mb-4">
        <div className="flex flex-wrap items-center justify-between gap-2 pr-3">
          <Tabs value={owned} onChange={setOwned} items={[{ key: "ALL", label: "All", count: all.length }, { key: "OWNED", label: "Owned", count: all.filter((r) => ownedCount.has(itemIdForDef(r.id))).length }]} />
          <input className="nf-input my-2 w-56" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search" />
        </div>
      </HoloPanel>
      {list.length === 0 ? <EmptyState title="Nothing found" icon={t.icon} /> : (
        <div className="nf-grid-cards" style={{ "--card-min": "260px" } as CSSProperties}>
          {list.map((r) => {
            const n = ownedCount.get(itemIdForDef(r.id)) ?? 0;
            const price = priceFor.get(itemIdForDef(r.id));
            return (
              <article key={r.id} className="nf-panel nf-rarity-frame grid content-start gap-3 p-4" style={rarityStyle(r.rarity)}>
                <div className="flex items-start gap-3">
                  <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-line bg-black/30" style={{ color: rarityColor(r.rarity) }}><Icon name={t.icon} size={24} /></span>
                  <div className="min-w-0 flex-1">
                    <div className="nf-ui truncate text-[16px] font-bold">{r.name}</div>
                    <div className="nf-label">{r.type} · Lv {r.requiredLevel}+</div>
                  </div>
                  <RarityBadge rarity={r.rarity} />
                </div>
                {r.description && <p className="m-0 line-clamp-2 text-[12.5px] text-dim">{r.description}</p>}
                <dl className="m-0 grid grid-cols-3 gap-x-3 gap-y-2">
                  {r.stats.map((st) => (
                    <div key={st.label}><dt className="nf-label text-[9.5px]">{st.label}</dt><dd className="nf-ui m-0 text-[14px] font-bold tabular-nums">{st.value}</dd></div>
                  ))}
                </dl>
                <div className="flex items-center justify-between border-t border-line pt-2.5">
                  {n > 0 ? <span className="nf-chip" style={{ color: "var(--nf-good)" }}>Owned ×{n}</span> : <span className="text-[12px] text-mute">Not owned</span>}
                  {price ? <Link to={`/shop?product=${price.id}`} className="no-underline"><CurrencyAmount amount={price.price} currency={price.currency} size={14} /></Link> : <span className="text-[12px] text-mute">Loot / craft</span>}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
