import { useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router-dom";
import { DRONES, MODULES, WEAPONS, itemIdForDef } from "@nebula/config";
import { CurrencyAmount, HoloPanel, Icon, RarityBadge, Tabs, rarityColor, rarityStyle } from "@nebula/game-ui";
import type { Rarity } from "@nebula/shared";
import { useInventory, useShop } from "../lib/queries.js";
import { humanize } from "../lib/gameMeta.js";
import { contentText, enumLabel, enumText, fmtDecimalStr, useT } from "../lib/i18n.js";
import type { TFn, TKey } from "../lib/i18n.js";
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

function rows(kind: Kind, t: TFn): Row[] {
  const num = (n: number): string => fmtDecimalStr(String(n));
  if (kind === "weapons") {
    return WEAPONS.map((w) => ({
      id: w.id, name: w.name, rarity: w.rarity, type: `${enumLabel(w.type)} · ${enumLabel(w.slot)}`, requiredLevel: w.requiredLevel,
      stats: [
        { label: t("stat.damage"), value: w.damage },
        { label: t("stat.rate"), value: t("unit.perSec", { n: num(w.fireRate) }) },
        { label: t("stat.range"), value: w.range },
        { label: t("stat.element"), value: enumLabel(w.element) },
        { label: t("stat.crit"), value: t("common.pct", { n: Math.round(w.critChance * 100) }) },
        { label: t("stat.energy"), value: w.energyCost },
      ],
    }));
  }
  if (kind === "modules") {
    return MODULES.map((m) => ({
      id: m.id, name: m.name, rarity: m.rarity, type: `${enumLabel(m.kind)} · ${enumLabel(m.slot)}`, requiredLevel: m.requiredLevel, description: contentText("module", m.id, m.description),
      stats: [
        ...Object.entries(m.passive).slice(0, 4).map(([k, v]) => ({ label: enumLabel(k.replace(/([A-Z])/g, "_$1")), value: `+${num(v)}` })),
        ...(m.cooldownMs ? [{ label: t("stat.cooldown"), value: t("unit.sec", { n: Math.round(m.cooldownMs / 1000) }) }] : []),
      ],
    }));
  }
  return DRONES.map((d) => ({
    id: d.id, name: d.name, rarity: d.rarity, type: enumLabel(d.type), requiredLevel: d.requiredLevel,
    stats: [
      { label: t("stat.hull"), value: d.hull },
      { label: t("stat.maxLevel"), value: d.maxLevel },
      { label: t("stat.dmgPerLvl"), value: d.damagePerLevel },
      ...Object.entries(d.passivePerLevel).slice(0, 2).map(([k, v]) => ({ label: t("stat.perLvl", { stat: enumText(k, humanize(k)) }), value: `+${num(v)}` })),
    ],
  }));
}

const TITLES: Record<Kind, { title: TKey; eyebrow: TKey; icon: "weapon" | "module" | "drone" }> = {
  weapons: { title: "nav.weapons", eyebrow: "catalog.armory", icon: "weapon" },
  modules: { title: "nav.modules", eyebrow: "catalog.engineering", icon: "module" },
  drones: { title: "nav.drones", eyebrow: "catalog.droneBay", icon: "drone" },
};

/** Weapons / Modules / Drones reference: data-driven stats + what you own + live shop prices. */
export default function CatalogPage({ kind }: { kind: Kind }) {
  const tr = useT();
  const inv = useInventory();
  const shop = useShop();
  const [owned, setOwned] = useState<"ALL" | "OWNED">("ALL");
  const [search, setSearch] = useState("");
  // `tr` changes identity with the language, so the translated rows are rebuilt on a language switch.
  const all = useMemo(() => rows(kind, tr), [kind, tr]);
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
      <PageHeader eyebrow={tr(t.eyebrow)} title={tr(t.title)} actions={<Link to="/inventory" className="nf-btn nf-btn--sm nf-btn--ghost no-underline">{tr("nav.inventory")}</Link>} />
      <HoloPanel padded={false} className="mb-4">
        <div className="flex flex-wrap items-center justify-between gap-2 pr-3">
          <Tabs value={owned} onChange={setOwned} items={[{ key: "ALL", label: tr("common.all"), count: all.length }, { key: "OWNED", label: tr("common.owned"), count: all.filter((r) => ownedCount.has(itemIdForDef(r.id))).length }]} />
          <input className="nf-input my-2 w-56" placeholder={tr("common.search")} value={search} onChange={(e) => setSearch(e.target.value)} aria-label={tr("common.search")} />
        </div>
      </HoloPanel>
      {list.length === 0 ? <EmptyState title={tr("catalog.nothing")} icon={t.icon} /> : (
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
                    <div className="nf-label">{r.type} · {tr("common.lvPlus", { n: r.requiredLevel })}</div>
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
                  {n > 0 ? <span className="nf-chip" style={{ color: "var(--nf-good)" }}>{tr("catalog.ownedN", { n })}</span> : <span className="text-[12px] text-mute">{tr("catalog.notOwned")}</span>}
                  {price ? <Link to={`/shop?product=${price.id}`} className="no-underline"><CurrencyAmount amount={price.price} currency={price.currency} size={14} /></Link> : <span className="text-[12px] text-mute">{tr("catalog.lootCraft")}</span>}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
