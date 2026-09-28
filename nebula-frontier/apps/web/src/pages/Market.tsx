import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Countdown, CurrencyAmount, HoloPanel, Icon, Modal, NeonButton, RarityBadge, Tabs, formatAmount, rarityStyle } from "@nebula/game-ui";
import { mulRatio, parseUnits } from "@nebula/shared";
import type { Currency, InventoryItemDto } from "@nebula/shared";
import { api } from "../lib/api.js";
import type { MarketListingDto } from "../lib/dto.js";
import { qk, useApiMutation, useInventory, useMarket, useMyListings } from "../lib/queries.js";
import { humanize } from "../lib/gameMeta.js";
import { PageHeader } from "../components/PageHeader.js";
import { EmptyState, QueryState } from "../components/QueryState.js";
import { ItemIcon, ItemTile } from "../components/ItemTile.js";
import { useSession } from "../hooks/useSession.js";
import { haptic } from "../native/haptics.js";

type TradeCurrency = "CREDITS" | "GEMS" | "NEBX";
const CATS = ["", "WEAPON", "MODULE", "GENERATOR", "DRONE", "SHIP_PART", "SKIN", "RESOURCE", "CONSUMABLE", "BLUEPRINT"];

export function FeeRow({ label, amount, currency, strong, negative }: { label: string; amount: bigint | string; currency: Currency; strong?: boolean; negative?: boolean }) {
  return (
    <div className={`flex items-center justify-between ${strong ? "border-t border-line pt-2" : ""}`}>
      <span className={strong ? "nf-ui text-[14px] font-bold uppercase tracking-[0.12em]" : "text-[13.5px] text-dim"}>{label}</span>
      <span className={negative ? "text-bad" : undefined}>{negative ? "−" : ""}<CurrencyAmount amount={amount} currency={currency} size={strong ? 16 : 14} /></span>
    </div>
  );
}

function BuyModal({ l, onClose }: { l: MarketListingDto; onClose: () => void }) {
  const buy = useApiMutation(() => api.market.buy(l.id), { invalidate: [["market"], qk.inventory, qk.me], success: `Purchased ${l.name}`, onSuccess: () => { haptic("success"); onClose(); } });
  return (
    <Modal open onClose={onClose} locked={buy.isPending} title="Confirm purchase"
      footer={<><NeonButton variant="ghost" onClick={onClose} disabled={buy.isPending}>Cancel</NeonButton><NeonButton variant="primary" loading={buy.isPending} onClick={() => buy.mutate(undefined)}>Buy now</NeonButton></>}>
      <div className="grid gap-4">
        <div className="flex items-center gap-3">
          <ItemIcon item={{ category: (l.category ?? "CONSUMABLE") as InventoryItemDto["category"], itemId: l.itemId, rarity: l.rarity ?? "COMMON" }} size={36} />
          <div>
            <div className="nf-ui text-[17px] font-bold">{l.quantity > 1 ? `${l.quantity}× ` : ""}{l.name}{l.upgradeLevel ? ` +${l.upgradeLevel}` : ""}</div>
            <div className="text-[12.5px] text-mute">Sold by {l.seller ?? "unknown"}</div>
          </div>
        </div>
        <div className="grid gap-2 rounded-lg border border-line bg-black/25 p-3">
          <FeeRow label="Item price" amount={l.price} currency={l.currency} />
          <FeeRow label="Marketplace fee (paid by seller)" amount={l.fee} currency={l.currency} />
          <FeeRow label="Seller receives" amount={l.sellerReceives} currency={l.currency} />
          <FeeRow label="You pay" amount={l.price} currency={l.currency} strong />
        </div>
      </div>
    </Modal>
  );
}

function SellPanel({ feeRate, preselect }: { feeRate: number; preselect: string | null }) {
  const inv = useInventory();
  const [itemId, setItemId] = useState<string | null>(preselect);
  const [price, setPrice] = useState("");
  const [currency, setCurrency] = useState<TradeCurrency>("CREDITS");
  const [qty, setQty] = useState(1);
  const [hours, setHours] = useState(48);
  useEffect(() => { if (preselect) setItemId(preselect); }, [preselect]);
  const tradeable = (inv.data?.items ?? []).filter((i) => i.tradeable && !i.equippedOn);
  const item = tradeable.find((i) => i.id === itemId);
  const decimals = currency === "NEBX" ? 9 : 0;
  let base: bigint | null = null;
  try {
    base = price ? parseUnits(price, decimals) : null;
  } catch {
    base = null;
  }
  const fee = base !== null ? mulRatio(base, feeRate) : null;
  const list = useApiMutation(() => api.market.create({ inventoryItemId: item!.id, quantity: qty, price: base!.toString(), currency, durationHours: hours }), {
    invalidate: [["market"], qk.inventory], success: "Listing created", onSuccess: () => { setItemId(null); setPrice(""); haptic("success"); },
  });
  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_380px]">
      <HoloPanel title="Select an item">
        <QueryState q={inv} isEmpty={() => tradeable.length === 0} empty={<EmptyState title="Nothing tradeable" body="Soulbound and equipped items cannot be listed." icon="inventory" />}>
          {() => (
            <div className="grid max-h-[520px] grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3 xl:grid-cols-4">
              {tradeable.map((i) => <ItemTile key={i.id} item={i} compact selected={i.id === itemId} onClick={() => { setItemId(i.id); setQty(1); }} />)}
            </div>
          )}
        </QueryState>
      </HoloPanel>
      <HoloPanel title="Listing" glow={Boolean(item)}>
        {!item ? <div className="text-[13px] text-mute">Choose an item to list.</div> : (
          <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); if (base && base > 0n) list.mutate(undefined); }}>
            <div className="flex items-center gap-2" style={rarityStyle(item.rarity)}><ItemIcon item={item} size={24} /><span className="nf-ui text-[16px] font-bold">{item.name}</span><RarityBadge rarity={item.rarity} /></div>
            {item.quantity > 1 && <label className="grid gap-1.5"><span className="nf-label">Quantity (max {item.quantity})</span><input className="nf-input" type="number" min={1} max={item.quantity} value={qty} onChange={(e) => setQty(Math.max(1, Math.min(item.quantity, Number(e.target.value) || 1)))} /></label>}
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <label className="grid gap-1.5"><span className="nf-label">Price</span><input className="nf-input" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value.replace(decimals ? /[^\d.]/g : /\D/g, ""))} placeholder="0" /></label>
              <label className="grid gap-1.5"><span className="nf-label">Currency</span>
                <select className="nf-input" value={currency} onChange={(e) => setCurrency(e.target.value as TradeCurrency)}><option value="CREDITS">Credits</option><option value="GEMS">Gems</option><option value="NEBX">NEBX</option></select>
              </label>
            </div>
            <label className="grid gap-1.5"><span className="nf-label">Duration</span>
              <select className="nf-input" value={hours} onChange={(e) => setHours(Number(e.target.value))}>{[12, 24, 48, 72, 168].map((h) => <option key={h} value={h}>{h < 48 ? `${h} hours` : `${h / 24} days`}</option>)}</select>
            </label>
            {base !== null && fee !== null && (
              <div className="grid gap-2 rounded-lg border border-line bg-black/25 p-3">
                <FeeRow label="Listing price" amount={base} currency={currency} />
                <FeeRow label={`Marketplace fee (${(feeRate * 100).toFixed(1)}%)`} amount={fee} currency={currency} negative />
                <FeeRow label="You receive when sold" amount={base - fee} currency={currency} strong />
              </div>
            )}
            <p className="m-0 text-[12px] text-mute">The item is held in escrow while listed. Final fee is computed by the server at sale time.</p>
            <NeonButton type="submit" variant="primary" loading={list.isPending} disabled={!base || base <= 0n}>Create listing</NeonButton>
          </form>
        )}
      </HoloPanel>
    </div>
  );
}

export default function MarketPage() {
  const me = useSession();
  const [params, setParams] = useSearchParams();
  const sellParam = params.get("sell");
  const [tab, setTab] = useState<"browse" | "sell" | "mine">(sellParam ? "sell" : "browse");
  const [category, setCategory] = useState("");
  const [currency, setCurrency] = useState("");
  const [sort, setSort] = useState<"recent" | "price_asc" | "price_desc">("recent");
  const [buying, setBuying] = useState<MarketListingDto | null>(null);
  const query = useMemo(() => ({ ...(category ? { category } : {}), ...(currency ? { currency } : {}), sort }), [category, currency, sort]);
  const market = useMarket(query);
  const mine = useMyListings();
  const cancel = useApiMutation((id: string) => api.market.cancel(id), { invalidate: [["market"], qk.inventory], success: "Listing cancelled" });
  const feeRate = market.data?.feeRate ?? 0;

  return (
    <div>
      <PageHeader eyebrow="Trade network" title="Marketplace" subtitle={`Player-to-player trading. Fee ${(feeRate * 100).toFixed(1)}% is deducted from the seller's proceeds.`} />
      <Tabs className="mb-4" value={tab} onChange={(k) => { setTab(k); if (k !== "sell" && sellParam) setParams({}); }} items={[{ key: "browse", label: "Browse" }, { key: "sell", label: "Sell" }, { key: "mine", label: "My listings", count: mine.data?.listings.filter((l) => l.status === "ACTIVE").length }]} />

      {tab === "browse" && (
        <>
          <div className="mb-3 flex flex-wrap gap-2">
            <select className="nf-input w-auto" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">{CATS.map((c) => <option key={c} value={c}>{c ? humanize(c) : "All categories"}</option>)}</select>
            <select className="nf-input w-auto" value={currency} onChange={(e) => setCurrency(e.target.value)} aria-label="Currency"><option value="">Any currency</option><option value="CREDITS">Credits</option><option value="GEMS">Gems</option><option value="NEBX">NEBX</option></select>
            <select className="nf-input w-auto" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sort"><option value="recent">Newest</option><option value="price_asc">Price ↑</option><option value="price_desc">Price ↓</option></select>
          </div>
          <QueryState q={market} isEmpty={(d) => d.listings.length === 0} empty={<EmptyState title="No listings" body="Be the first to list an item." icon="market" />}>
            {(d) => (
              <HoloPanel padded={false}>
                <div className="overflow-x-auto">
                  <table className="nf-table">
                    <thead><tr><th>Item</th><th>Qty</th><th>Seller</th><th>Expires</th><th className="text-right">Price</th><th /></tr></thead>
                    <tbody>
                      {d.listings.map((l) => (
                        <tr key={l.id}>
                          <td><div className="flex items-center gap-2" style={rarityStyle(l.rarity ?? "COMMON")}><ItemIcon item={{ category: (l.category ?? "CONSUMABLE") as InventoryItemDto["category"], itemId: l.itemId, rarity: l.rarity ?? "COMMON" }} size={22} /><span className="nf-ui text-[15px] font-bold">{l.name}{l.upgradeLevel ? ` +${l.upgradeLevel}` : ""}</span>{l.rarity && <RarityBadge rarity={l.rarity} />}</div></td>
                          <td className="tabular-nums">{l.quantity}</td>
                          <td className="text-dim">{l.seller ?? "—"}</td>
                          <td><Countdown to={l.expiresAt} className="text-[13px]" /></td>
                          <td className="text-right"><CurrencyAmount amount={l.price} currency={l.currency} size={15} /></td>
                          <td className="text-right">{l.sellerId !== me.id && <NeonButton size="sm" onClick={() => setBuying(l)}>Buy</NeonButton>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </HoloPanel>
            )}
          </QueryState>
        </>
      )}
      {tab === "sell" && <SellPanel feeRate={feeRate} preselect={sellParam} />}
      {tab === "mine" && (
        <QueryState q={mine} isEmpty={(d) => d.listings.length === 0} empty={<EmptyState title="No listings" icon="market" />}>
          {(d) => (
            <HoloPanel padded={false}>
              <div className="overflow-x-auto">
                <table className="nf-table">
                  <thead><tr><th>Item</th><th>Status</th><th>Price</th><th>Fee</th><th>Proceeds</th><th /></tr></thead>
                  <tbody>
                    {d.listings.map((l) => (
                      <tr key={l.id}>
                        <td className="nf-ui text-[15px] font-bold">{l.quantity > 1 ? `${l.quantity}× ` : ""}{l.name}</td>
                        <td><span className="nf-chip">{humanize(l.status)}</span></td>
                        <td><CurrencyAmount amount={l.price} currency={l.currency} size={14} /></td>
                        <td className="text-dim">{formatAmount(l.fee, l.currency)}</td>
                        <td><CurrencyAmount amount={l.sellerReceives} currency={l.currency} size={14} /></td>
                        <td className="text-right">{l.status === "ACTIVE" && <NeonButton size="sm" variant="danger" loading={cancel.isPending && cancel.variables === l.id} onClick={() => cancel.mutate(l.id)}><Icon name="close" size={12} />Cancel</NeonButton>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </HoloPanel>
          )}
        </QueryState>
      )}
      {buying && <BuyModal l={buying} onClose={() => setBuying(null)} />}
    </div>
  );
}
