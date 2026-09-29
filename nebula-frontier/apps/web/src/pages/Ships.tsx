import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { SHIPS_BY_ID } from "@nebula/config";
import { CurrencyAmount, FactionEmblem, HoloPanel, Icon, Modal, NeonButton, RarityBadge, Tabs, rarityStyle } from "@nebula/game-ui";
import type { ShipDef } from "@nebula/shared";
import { api } from "../lib/api.js";
import type { ShipCatalogEntry } from "../lib/dto.js";
import { idempotencyKey } from "../lib/http.js";
import { qk, useApiMutation, useShips } from "../lib/queries.js";
import { faction, humanize } from "../lib/gameMeta.js";
import { PageHeader } from "../components/PageHeader.js";
import { EmptyState, QueryState } from "../components/QueryState.js";
import { ShipBlueprint } from "../components/ShipBlueprint.js";
import { ShipViewer } from "../components/ShipViewer.js";
import { ShipStatBars } from "../components/ShipStatBars.js";
import { useSession } from "../hooks/useSession.js";
import { haptic } from "../native/haptics.js";

function asDef(c: ShipCatalogEntry): ShipDef {
  return SHIPS_BY_ID.get(c.id) ?? ({ ...c, faction: c.faction ?? undefined, requiredLevel: c.unlock.requiredLevel, resistances: {}, tradeable: false, nftEligible: false } as ShipDef);
}

function ShipDetail({ ship, onClose }: { ship: ShipCatalogEntry; onClose: () => void }) {
  const me = useSession();
  const navigate = useNavigate();
  const def = asDef(ship);
  const f = faction(ship.faction);
  const product = ship.unlock.product;
  const levelOk = me.level >= ship.unlock.requiredLevel;
  const buy = useApiMutation(() => api.ships.unlock(ship.id, idempotencyKey("ship")), {
    invalidate: [qk.ships, qk.me],
    success: `${ship.name} added to your hangar`,
    errorTitle: "Purchase failed",
    onSuccess: () => { haptic("success"); onClose(); },
  });
  return (
    <Modal open onClose={onClose} wide locked={buy.isPending} title={ship.name}
      footer={
        ship.owned ? <NeonButton variant="primary" onClick={() => navigate("/hangar")}>Open in hangar</NeonButton>
          : product ? (
            <NeonButton variant="primary" loading={buy.isPending} disabled={!levelOk} onClick={() => buy.mutate(undefined)}>
              {levelOk ? <>Unlock for <CurrencyAmount amount={product.price} currency={product.currency} size={15} /></> : `Requires level ${ship.unlock.requiredLevel}`}
            </NeonButton>
          ) : <span className="text-[13px] text-mute">{ship.unlock.method === "FACTION_STARTER" ? "Faction starter ship" : "Obtained through crafting or events"}</span>
      }
    >
      <div className="grid gap-4 md:grid-cols-[1.2fr_1fr]">
        <div className="relative h-[320px] overflow-hidden rounded-xl border border-line bg-black/30">
          <ShipViewer def={def} />
        </div>
        <div className="grid content-start gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <RarityBadge rarity={ship.rarity} />
            <span className="nf-chip">{humanize(ship.class)}</span>
            <span className="nf-chip">Tier {ship.tier}</span>
            {f && <span className="nf-chip" style={{ color: f.color }}><FactionEmblem path={f.emblem} color={f.color} size={14} framed={false} />{f.tag}</span>}
          </div>
          <p className="m-0 text-[13.5px] text-dim">{ship.description}</p>
          <ShipStatBars stats={ship.stats as unknown as Record<string, number>} />
        </div>
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        {ship.abilities.map((a) => (
          <div key={a.id} className="rounded-lg border border-line bg-black/20 p-3">
            <div className="nf-ui text-[14px] font-bold">{a.name}</div>
            <div className="nf-label">{a.kind}{a.cooldownMs ? ` · ${Math.round(a.cooldownMs / 1000)}s` : ""}</div>
            <div className="mt-1 text-[12.5px] text-dim">{a.description}</div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

export default function ShipsPage() {
  const q = useShips();
  const [filter, setFilter] = useState<"ALL" | "OWNED" | "AVAILABLE">("ALL");
  const [cls, setCls] = useState("");
  const [detail, setDetail] = useState<ShipCatalogEntry | null>(null);
  const catalog = q.data?.catalog ?? [];
  const classes = useMemo(() => [...new Set(catalog.map((c) => c.class))].sort(), [catalog]);
  const list = catalog
    .filter((c) => (filter === "OWNED" ? c.owned : filter === "AVAILABLE" ? !c.owned && c.unlock.product : true))
    .filter((c) => !cls || c.class === cls)
    .sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name));

  return (
    <div>
      <PageHeader eyebrow="Shipyard" title="Ships" subtitle="Every hull in the Frontier. Prices come from the live shop; faction starters are granted on enlistment." />
      <HoloPanel padded={false} className="mb-4">
        <div className="flex flex-wrap items-center justify-between gap-2 pr-3">
          <Tabs value={filter} onChange={setFilter} items={[{ key: "ALL", label: "All", count: catalog.length }, { key: "OWNED", label: "Owned", count: catalog.filter((c) => c.owned).length }, { key: "AVAILABLE", label: "For sale" }]} />
          <select className="nf-input my-2 w-auto" value={cls} onChange={(e) => setCls(e.target.value)} aria-label="Ship class">
            <option value="">All classes</option>
            {classes.map((c) => <option key={c} value={c}>{humanize(c)}</option>)}
          </select>
        </div>
      </HoloPanel>
      <QueryState q={q}>
        {() => list.length === 0 ? <EmptyState title="No ships match" icon="ship" /> : (
          <div className="nf-grid-cards" style={{ "--card-min": "250px" } as CSSProperties}>
            {list.map((c) => {
              const f = faction(c.faction);
              return (
                <article key={c.id} className="nf-panel nf-panel--interactive nf-rarity-frame overflow-hidden" style={rarityStyle(c.rarity)} onClick={() => setDetail(c)} data-testid="ship-card">
                  <div className="relative h-[170px] border-b border-line">
                    <ShipBlueprint def={asDef(c)} />
                    {c.owned && <span className="nf-chip absolute right-2 top-2" style={{ color: "var(--nf-good)", borderColor: "var(--nf-good)" }}><Icon name="check" size={11} />Owned</span>}
                    {f && <span className="absolute left-2 top-2"><FactionEmblem path={f.emblem} color={f.color} size={26} /></span>}
                  </div>
                  <div className="grid gap-2 p-3.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="nf-display text-[16px] font-bold tracking-[0.08em]">{c.name}</div>
                      <RarityBadge rarity={c.rarity} />
                    </div>
                    <div className="nf-ui text-[12px] uppercase tracking-[0.16em] text-mute">{humanize(c.class)} · Tier {c.tier} · Lv {c.unlock.requiredLevel}+</div>
                    <div className="flex items-center justify-between pt-1">
                      {c.owned ? <span className="text-[12.5px] text-dim">In hangar</span> : c.unlock.product ? <CurrencyAmount amount={c.unlock.product.price} currency={c.unlock.product.currency} size={15} /> : <span className="text-[12.5px] text-mute">{c.unlock.method === "FACTION_STARTER" ? "Faction starter" : "Craft / event"}</span>}
                      <span className="text-accent"><Icon name="arrowRight" size={16} /></span>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </QueryState>
      {detail && <ShipDetail ship={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}
