import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HoloPanel, NeonButton, Tabs } from "@nebula/game-ui";
import { api, can } from "../lib/api.js";
import type { EventRow, ShopProductRow } from "../lib/api.js";
import { errorMessage } from "../lib/http.js";
import { int, pct, short, sol, when } from "../lib/format.js";
import { Failure, Loading, NoData, Page, ReasonDialog } from "../components/ui.js";
import { useAdminMe } from "../session.js";

const price = (currency: string, v: string): string => (currency === "SOL" || currency === "NEBX" ? `${sol(v)} ${currency}` : `${int(v)} ${currency}`);
const RO = <span className="nf-chip">Read-only · no admin mutation endpoint</span>;

/* ============================================================ Shop */
export function ShopPage() {
  const qc = useQueryClient();
  const me = useAdminMe();
  const q = useQuery({ queryKey: ["admin-products"], queryFn: api.products });
  const [edit, setEdit] = useState<ShopProductRow | null>(null);
  const [draft, setDraft] = useState<{ price: string; active: boolean; featured: boolean; stock: string }>({ price: "", active: true, featured: false, stock: "" });
  const [err, setErr] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: (reason: string) => api.patchProduct(edit!.id, { price: draft.price, active: draft.active, featured: draft.featured, stock: draft.stock === "" ? null : Number(draft.stock), reason }),
    onSuccess: async () => { setEdit(null); await qc.invalidateQueries({ queryKey: ["admin-products"] }); },
    onError: (e) => setErr(errorMessage(e)),
  });
  const editable = can(me.roles, "shopManage");
  return (
    <Page title="Shop catalog" eyebrow="Content">
      {q.error ? <Failure error={q.error} /> : !q.data ? <Loading /> : (
        <HoloPanel padded={false}>
          <div className="overflow-x-auto">
            <table className="nf-table">
              <thead><tr><th>Product</th><th>Category</th><th className="text-right">Price</th><th>Lvl</th><th>Stock</th><th>Status</th><th /></tr></thead>
              <tbody>{q.data.products.map((p) => (
                <tr key={p.id}>
                  <td><div className="font-ui font-bold">{p.name}</div><div className="nf-mono text-mute">{p.sku}</div></td>
                  <td>{p.category}</td><td className="text-right tabular-nums">{price(p.currency, p.price)}</td><td>{p.requiredLevel}</td><td>{p.stock ?? "∞"}</td>
                  <td>{p.active ? <span className="text-good">Active</span> : <span className="text-mute">Inactive</span>}{p.featured && <span className="nf-chip ml-1">Featured</span>}</td>
                  <td className="text-right">{editable && <NeonButton size="sm" onClick={() => { setErr(null); setEdit(p); setDraft({ price: p.price, active: p.active, featured: p.featured, stock: p.stock === null ? "" : String(p.stock) }); }}>Edit</NeonButton>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </HoloPanel>
      )}
      <ReasonDialog open={Boolean(edit)} title={`Edit ${edit?.name ?? ""}`} busy={m.isPending} onClose={() => setEdit(null)} onConfirm={(r) => /^\d+$/.test(draft.price) && m.mutate(r)}>
        {edit && (
          <div className="grid gap-2">
            <label className="grid gap-1"><span className="text-[12px] text-mute">Price ({edit.currency} base units)</span><input className="nf-input" value={draft.price} onChange={(e) => setDraft({ ...draft, price: e.target.value.replace(/\D/g, "") })} /></label>
            <label className="grid gap-1"><span className="text-[12px] text-mute">Stock (empty = unlimited)</span><input className="nf-input" value={draft.stock} onChange={(e) => setDraft({ ...draft, stock: e.target.value.replace(/\D/g, "") })} /></label>
            <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} />Active</label>
            <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={draft.featured} onChange={(e) => setDraft({ ...draft, featured: e.target.checked })} />Featured</label>
          </div>
        )}
        {err && <div className="text-[12.5px] text-bad">{err}</div>}
      </ReasonDialog>
    </Page>
  );
}

/* ============================================================ Events (admin overrides) */
export function EventsPage() {
  const qc = useQueryClient();
  const me = useAdminMe();
  const q = useQuery({ queryKey: ["admin-events"], queryFn: api.events });
  const blank: EventRow = { id: "", name: "", type: "GLOBAL_RIFT", startAt: new Date().toISOString().slice(0, 16), endAt: new Date(Date.now() + 3_600_000).toISOString().slice(0, 16), active: true, data: {} };
  const [edit, setEdit] = useState<EventRow | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const save = useMutation({ mutationFn: (reason: string) => api.upsertEvent({ ...edit!, startAt: new Date(edit!.startAt).toISOString(), endAt: new Date(edit!.endAt).toISOString(), reason }), onSuccess: async () => { setEdit(null); await qc.invalidateQueries({ queryKey: ["admin-events"] }); }, onError: (e) => setErr(errorMessage(e)) });
  const editable = can(me.roles, "eventsManage");
  return (
    <Page title="Events" eyebrow="Content" actions={editable ? <NeonButton size="sm" variant="primary" onClick={() => { setErr(null); setEdit(blank); }}>Schedule event</NeonButton> : undefined}>
      {q.error ? <Failure error={q.error} /> : !q.data ? <Loading /> : q.data.events.length === 0 ? <HoloPanel><NoData what="No admin overrides — config events are active by default" /></HoloPanel> : (
        <HoloPanel padded={false}>
          <table className="nf-table">
            <thead><tr><th>Event</th><th>Type</th><th>Start</th><th>End</th><th>Status</th><th /></tr></thead>
            <tbody>{q.data.events.map((e) => (
              <tr key={e.id}><td><div className="font-ui font-bold">{e.name}</div><div className="nf-mono text-mute">{e.id}</div></td><td>{e.type}</td><td className="text-[12px]">{when(e.startAt)}</td><td className="text-[12px]">{when(e.endAt)}</td><td>{e.active ? <span className="text-good">Active</span> : "Disabled"}</td>
                <td className="text-right">{editable && <NeonButton size="sm" onClick={() => { setErr(null); setEdit({ ...e, startAt: e.startAt.slice(0, 16), endAt: e.endAt.slice(0, 16) }); }}>Edit</NeonButton>}</td></tr>
            ))}</tbody>
          </table>
        </HoloPanel>
      )}
      <ReasonDialog open={Boolean(edit)} title={edit?.id ? `Event ${edit.id}` : "New event"} busy={save.isPending} onClose={() => setEdit(null)} onConfirm={(r) => edit && /^[a-z0-9_]+$/.test(edit.id) && save.mutate(r)}>
        {edit && (
          <div className="grid gap-2">
            <label className="grid gap-1"><span className="text-[12px] text-mute">Id (a-z0-9_)</span><input className="nf-input" value={edit.id} onChange={(e) => setEdit({ ...edit, id: e.target.value })} /></label>
            <label className="grid gap-1"><span className="text-[12px] text-mute">Name</span><input className="nf-input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
            <label className="grid gap-1"><span className="text-[12px] text-mute">Type</span><select className="nf-input" value={edit.type} onChange={(e) => setEdit({ ...edit, type: e.target.value })}>{["INVASION", "WORLD_BOSS", "TREASURE_HUNT", "DOUBLE_XP", "FACTION_WAR", "MINING_FESTIVAL", "PVP_WEEKEND", "RAID_EVENT", "SPECIAL_EVENT", "SEASON_EVENT", "GLOBAL_RIFT"].map((t) => <option key={t}>{t}</option>)}</select></label>
            <div className="grid grid-cols-2 gap-2">
              <label className="grid gap-1"><span className="text-[12px] text-mute">Start</span><input className="nf-input" type="datetime-local" value={edit.startAt} onChange={(e) => setEdit({ ...edit, startAt: e.target.value })} /></label>
              <label className="grid gap-1"><span className="text-[12px] text-mute">End</span><input className="nf-input" type="datetime-local" value={edit.endAt} onChange={(e) => setEdit({ ...edit, endAt: e.target.value })} /></label>
            </div>
            <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} />Active</label>
          </div>
        )}
        {err && <div className="text-[12.5px] text-bad">{err}</div>}
      </ReasonDialog>
    </Page>
  );
}

/* ============================================================ Catalog overrides */
export function CatalogPage() {
  const me = useAdminMe();
  const [kind, setKind] = useState("ship");
  const [id, setId] = useState("");
  const [json, setJson] = useState("{\n  \n}");
  const [active, setActive] = useState<"" | "true" | "false">("");
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: (reason: string) => {
      const data = JSON.parse(json) as Record<string, unknown>;
      return api.catalog(kind, id, { ...(Object.keys(data).length ? { data } : {}), ...(active ? { active: active === "true" } : {}), reason });
    },
    onSuccess: () => { setOpen(false); setMsg("Override saved and catalog cache invalidated."); },
    onError: (e) => setMsg(errorMessage(e)),
  });
  let jsonOk = true;
  try { JSON.parse(json); } catch { jsonOk = false; }
  return (
    <Page title="Catalog overrides" eyebrow="Ships · weapons · modules · drones · items">
      <HoloPanel title="Override a definition">
        {!can(me.roles, "catalogManage") ? <NoData what="Requires ADMIN" /> : (
          <div className="grid gap-3">
            <Tabs variant="pill" value={kind} onChange={setKind} items={["ship", "weapon", "module", "drone", "item"].map((k) => ({ key: k, label: k }))} />
            <input className="nf-input" placeholder="Definition id, e.g. ship_aurora_lumen / npc stats live in config" value={id} onChange={(e) => setId(e.target.value.trim())} />
            <textarea className="nf-input nf-mono min-h-[180px] py-2" value={json} onChange={(e) => setJson(e.target.value)} aria-label="JSON patch" />
            {kind !== "item" && <select className="nf-input w-auto" value={active} onChange={(e) => setActive(e.target.value as "" | "true" | "false")}><option value="">Active unchanged</option><option value="true">Enable</option><option value="false">Disable</option></select>}
            <div className="text-[12px] text-mute">The JSON is shallow-merged into the stored definition. NPC and map data are config-driven (packages/config) and change through deploys.</div>
            {!jsonOk && <div className="text-[12.5px] text-bad">Invalid JSON</div>}
            {msg && <div className="text-[12.5px] text-dim">{msg}</div>}
            <NeonButton variant="primary" disabled={!id || !jsonOk} onClick={() => setOpen(true)}>Apply override</NeonButton>
          </div>
        )}
      </HoloPanel>
      <ReasonDialog open={open} title={`Override ${kind} ${id}`} busy={m.isPending} onClose={() => setOpen(false)} onConfirm={(r) => m.mutate(r)} />
    </Page>
  );
}

/* ============================================================ Read-only world content */
export function WorldContentPage() {
  const [tab, setTab] = useState("maps");
  const maps = useQuery({ queryKey: ["maps"], queryFn: api.maps, enabled: tab === "maps" });
  const seasons = useQuery({ queryKey: ["seasons"], queryFn: api.seasons, enabled: tab === "seasons" });
  return (
    <Page title="World content" eyebrow="Maps · quests · seasons · battle pass" actions={RO}>
      <Tabs value={tab} onChange={setTab} items={[{ key: "maps", label: "Maps" }, { key: "seasons", label: "Seasons & battle pass" }, { key: "quests", label: "Quests & NPCs" }]} />
      {tab === "maps" && (maps.error ? <Failure error={maps.error} /> : !maps.data ? <Loading /> : (
        <HoloPanel padded={false}><table className="nf-table"><thead><tr><th>Map</th><th>Sector</th><th>Room</th><th>Levels</th><th>PvP</th></tr></thead>
          <tbody>{maps.data.maps.map((m) => <tr key={m.id}><td><div className="font-ui font-bold">{m.name}</div><div className="nf-mono text-mute">{m.id}</div></td><td>{m.sector}</td><td>{m.roomType}</td><td>{m.levelRange[0]}–{m.levelRange[1]}</td><td>{m.pvp ? "Yes" : "No"}</td></tr>)}</tbody></table></HoloPanel>
      ))}
      {tab === "seasons" && (seasons.error ? <Failure error={seasons.error} /> : !seasons.data ? <Loading /> : (
        <HoloPanel padded={false}><table className="nf-table"><thead><tr><th>Season</th><th>Start</th><th>End</th><th>Battle pass</th><th>Status</th></tr></thead>
          <tbody>{seasons.data.seasons.map((s) => <tr key={s.id}><td className="font-ui font-bold">{s.name}</td><td className="text-[12px]">{when(s.startAt)}</td><td className="text-[12px]">{when(s.endAt)}</td><td className="nf-mono">{s.battlePassId}</td><td>{s.active ? <span className="text-good">Active</span> : "—"}</td></tr>)}</tbody></table></HoloPanel>
      ))}
      {tab === "quests" && <HoloPanel><div className="text-[13px] text-dim">Quests, NPCs, loot tables and battle-pass tiers are data-driven in <span className="nf-mono">packages/config/data/*.json</span>, validated by <span className="nf-mono">validateGameData()</span> and shipped through deploys. Balance tuning at runtime happens via Economy parameters and API rules.</div></HoloPanel>}
    </Page>
  );
}

/* ============================================================ Trade & clans (read-only monitoring) */
export function TradePage() {
  const [tab, setTab] = useState("market");
  const market = useQuery({ queryKey: ["market"], queryFn: api.market, enabled: tab === "market" });
  const auctions = useQuery({ queryKey: ["auctions"], queryFn: api.auctions, enabled: tab === "auction" });
  const clans = useQuery({ queryKey: ["clans"], queryFn: api.clans, enabled: tab === "clans" });
  return (
    <Page title="Marketplace, auctions & clans" eyebrow="Monitoring" actions={RO}>
      <Tabs value={tab} onChange={setTab} items={[{ key: "market", label: "Marketplace" }, { key: "auction", label: "Auctions" }, { key: "clans", label: "Clans" }]} />
      {tab === "market" && (market.error ? <Failure error={market.error} /> : !market.data ? <Loading /> : (
        <HoloPanel padded={false} title={`Active listings · fee ${pct(market.data.feeRate)}`}><table className="nf-table"><thead><tr><th>Item</th><th>Seller</th><th>Qty</th><th className="text-right">Price</th><th className="text-right">Fee</th><th>Expires</th></tr></thead>
          <tbody>{market.data.listings.length === 0 ? <tr><td colSpan={6}><NoData /></td></tr> : market.data.listings.map((l) => <tr key={l.id}><td>{l.name}</td><td>{l.seller ?? "—"}</td><td>{l.quantity}</td><td className="text-right">{price(l.currency, l.price)}</td><td className="text-right text-dim">{price(l.currency, l.fee)}</td><td className="text-[12px]">{when(l.expiresAt)}</td></tr>)}</tbody></table></HoloPanel>
      ))}
      {tab === "auction" && (auctions.error ? <Failure error={auctions.error} /> : !auctions.data ? <Loading /> : (
        <HoloPanel padded={false}><table className="nf-table"><thead><tr><th>Item</th><th>Type</th><th>Seller</th><th className="text-right">Current</th><th className="text-right">Buyout</th><th>Ends</th></tr></thead>
          <tbody>{auctions.data.auctions.length === 0 ? <tr><td colSpan={6}><NoData /></td></tr> : auctions.data.auctions.map((a) => <tr key={a.id}><td>{a.name}</td><td>{a.type}</td><td className="nf-mono">{short(a.sellerId)}</td><td className="text-right">{price(a.currency, a.currentBid ?? a.startPrice)}</td><td className="text-right">{a.buyoutPrice ? price(a.currency, a.buyoutPrice) : "—"}</td><td className="text-[12px]">{when(a.endsAt)}</td></tr>)}</tbody></table></HoloPanel>
      ))}
      {tab === "clans" && (clans.error ? <Failure error={clans.error} /> : !clans.data ? <Loading /> : (
        <HoloPanel padded={false}><table className="nf-table"><thead><tr><th>#</th><th>Clan</th><th>Level</th><th>Members</th><th>Territories</th><th className="text-right">Score</th></tr></thead>
          <tbody>{clans.data.ranking.map((c) => <tr key={c.id}><td>{c.rank}</td><td className="font-ui font-bold">[{c.tag}] {c.name}</td><td>{c.level}</td><td>{c.members}</td><td>{c.territories}</td><td className="text-right tabular-nums">{int(c.score)}</td></tr>)}</tbody></table></HoloPanel>
      ))}
    </Page>
  );
}
