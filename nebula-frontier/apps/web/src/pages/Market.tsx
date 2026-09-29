import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Countdown, CurrencyAmount, HoloPanel, Icon, Modal, NeonButton, RarityBadge, Tabs, formatAmount, rarityStyle } from "@nebula/game-ui";
import { mulRatio, parseUnits } from "@nebula/shared";
import type { Currency, InventoryItemDto } from "@nebula/shared";
import { api } from "../lib/api.js";
import type { MarketListingDto } from "../lib/dto.js";
import { qk, useApiMutation, useInventory, useMarket, useMyListings } from "../lib/queries.js";
import { enumLabel, fmtFixed, useT } from "../lib/i18n.js";
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
  const t = useT();
  const buy = useApiMutation(() => api.market.buy(l.id), { invalidate: [["market"], qk.inventory, qk.me], success: t("shop.purchased", { name: l.name }), onSuccess: () => { haptic("success"); onClose(); } });
  return (
    <Modal open onClose={onClose} locked={buy.isPending} title={t("market.confirmPurchase")}
      footer={<><NeonButton variant="ghost" onClick={onClose} disabled={buy.isPending}>{t("common.cancel")}</NeonButton><NeonButton variant="primary" loading={buy.isPending} onClick={() => buy.mutate(undefined)}>{t("market.buyNow")}</NeonButton></>}>
      <div className="grid gap-4">
        <div className="flex items-center gap-3">
          <ItemIcon item={{ category: (l.category ?? "CONSUMABLE") as InventoryItemDto["category"], itemId: l.itemId, rarity: l.rarity ?? "COMMON" }} size={36} />
          <div>
            <div className="nf-ui text-[17px] font-bold">{l.quantity > 1 ? `${l.quantity}× ` : ""}{l.name}{l.upgradeLevel ? ` +${l.upgradeLevel}` : ""}</div>
            <div className="text-[12.5px] text-mute">{t("market.soldBy", { name: l.seller ?? t("market.unknownSeller") })}</div>
          </div>
        </div>
        <div className="grid gap-2 rounded-lg border border-line bg-black/25 p-3">
          <FeeRow label={t("market.itemPrice")} amount={l.price} currency={l.currency} />
          <FeeRow label={t("market.feeSeller")} amount={l.fee} currency={l.currency} />
          <FeeRow label={t("market.sellerReceives")} amount={l.sellerReceives} currency={l.currency} />
          <FeeRow label={t("market.youPay")} amount={l.price} currency={l.currency} strong />
        </div>
      </div>
    </Modal>
  );
}

function SellPanel({ feeRate, preselect }: { feeRate: number; preselect: string | null }) {
  const t = useT();
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
    invalidate: [["market"], qk.inventory], success: t("market.listed"), onSuccess: () => { setItemId(null); setPrice(""); haptic("success"); },
  });
  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_380px]">
      <HoloPanel title={t("market.selectItem")}>
        <QueryState q={inv} isEmpty={() => tradeable.length === 0} empty={<EmptyState title={t("market.nothingTradeable")} body={t("market.nothingTradeableBody")} icon="inventory" />}>
          {() => (
            <div className="grid max-h-[520px] grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3 xl:grid-cols-4">
              {tradeable.map((i) => <ItemTile key={i.id} item={i} compact selected={i.id === itemId} onClick={() => { setItemId(i.id); setQty(1); }} />)}
            </div>
          )}
        </QueryState>
      </HoloPanel>
      <HoloPanel title={t("market.listing")} glow={Boolean(item)}>
        {!item ? <div className="text-[13px] text-mute">{t("market.chooseItem")}</div> : (
          <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); if (base && base > 0n) list.mutate(undefined); }}>
            <div className="flex items-center gap-2" style={rarityStyle(item.rarity)}><ItemIcon item={item} size={24} /><span className="nf-ui text-[16px] font-bold">{item.name}</span><RarityBadge rarity={item.rarity} /></div>
            {item.quantity > 1 && <label className="grid gap-1.5"><span className="nf-label">{t("market.qtyMax", { n: item.quantity })}</span><input className="nf-input" type="number" min={1} max={item.quantity} value={qty} onChange={(e) => setQty(Math.max(1, Math.min(item.quantity, Number(e.target.value) || 1)))} /></label>}
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <label className="grid gap-1.5"><span className="nf-label">{t("common.price")}</span><input className="nf-input" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value.replace(decimals ? /[^\d.]/g : /\D/g, ""))} placeholder="0" /></label>
              <label className="grid gap-1.5"><span className="nf-label">{t("common.currency")}</span>
                <select className="nf-input" value={currency} onChange={(e) => setCurrency(e.target.value as TradeCurrency)}><option value="CREDITS">{t("common.credits")}</option><option value="GEMS">{t("common.gems")}</option><option value="NEBX">NEBX</option></select>
              </label>
            </div>
            <label className="grid gap-1.5"><span className="nf-label">{t("market.duration")}</span>
              <select className="nf-input" value={hours} onChange={(e) => setHours(Number(e.target.value))}>{[12, 24, 48, 72, 168].map((h) => <option key={h} value={h}>{h < 48 ? t("unit.hours", { n: h }) : t("unit.days", { n: h / 24 })}</option>)}</select>
            </label>
            {base !== null && fee !== null && (
              <div className="grid gap-2 rounded-lg border border-line bg-black/25 p-3">
                <FeeRow label={t("market.listingPrice")} amount={base} currency={currency} />
                <FeeRow label={t("market.feePct", { pct: fmtFixed(feeRate * 100, 1) })} amount={fee} currency={currency} negative />
                <FeeRow label={t("market.youReceive")} amount={base - fee} currency={currency} strong />
              </div>
            )}
            <p className="m-0 text-[12px] text-mute">{t("market.escrowNote")}</p>
            <NeonButton type="submit" variant="primary" loading={list.isPending} disabled={!base || base <= 0n}>{t("market.createListing")}</NeonButton>
          </form>
        )}
      </HoloPanel>
    </div>
  );
}

export default function MarketPage() {
  const t = useT();
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
  const cancel = useApiMutation((id: string) => api.market.cancel(id), { invalidate: [["market"], qk.inventory], success: t("market.cancelled") });
  const feeRate = market.data?.feeRate ?? 0;

  return (
    <div>
      <PageHeader eyebrow={t("market.eyebrow")} title={t("market.title")} subtitle={t("market.subtitle", { pct: fmtFixed(feeRate * 100, 1) })} />
      <Tabs className="mb-4" value={tab} onChange={(k) => { setTab(k); if (k !== "sell" && sellParam) setParams({}); }} items={[{ key: "browse", label: t("market.browse") }, { key: "sell", label: t("market.sell") }, { key: "mine", label: t("market.mine"), count: mine.data?.listings.filter((l) => l.status === "ACTIVE").length }]} />

      {tab === "browse" && (
        <>
          <div className="mb-3 flex flex-wrap gap-2">
            <select className="nf-input w-auto" value={category} onChange={(e) => setCategory(e.target.value)} aria-label={t("market.category")}>{CATS.map((c) => <option key={c} value={c}>{c ? enumLabel(c) : t("market.allCategories")}</option>)}</select>
            <select className="nf-input w-auto" value={currency} onChange={(e) => setCurrency(e.target.value)} aria-label={t("common.currency")}><option value="">{t("market.anyCurrency")}</option><option value="CREDITS">{t("common.credits")}</option><option value="GEMS">{t("common.gems")}</option><option value="NEBX">NEBX</option></select>
            <select className="nf-input w-auto" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label={t("inv.sort")}><option value="recent">{t("market.newest")}</option><option value="price_asc">{t("market.priceAsc")}</option><option value="price_desc">{t("market.priceDesc")}</option></select>
          </div>
          <QueryState q={market} isEmpty={(d) => d.listings.length === 0} empty={<EmptyState title={t("market.noListings")} body={t("market.beFirst")} icon="market" />}>
            {(d) => (
              <HoloPanel padded={false}>
                <div className="overflow-x-auto">
                  <table className="nf-table">
                    <thead><tr><th>{t("common.item")}</th><th>{t("inv.qty")}</th><th>{t("market.seller")}</th><th>{t("market.expires")}</th><th className="text-right">{t("common.price")}</th><th /></tr></thead>
                    <tbody>
                      {d.listings.map((l) => (
                        <tr key={l.id}>
                          <td><div className="flex items-center gap-2" style={rarityStyle(l.rarity ?? "COMMON")}><ItemIcon item={{ category: (l.category ?? "CONSUMABLE") as InventoryItemDto["category"], itemId: l.itemId, rarity: l.rarity ?? "COMMON" }} size={22} /><span className="nf-ui text-[15px] font-bold">{l.name}{l.upgradeLevel ? ` +${l.upgradeLevel}` : ""}</span>{l.rarity && <RarityBadge rarity={l.rarity} />}</div></td>
                          <td className="tabular-nums">{l.quantity}</td>
                          <td className="text-dim">{l.seller ?? "—"}</td>
                          <td><Countdown to={l.expiresAt} className="text-[13px]" /></td>
                          <td className="text-right"><CurrencyAmount amount={l.price} currency={l.currency} size={15} /></td>
                          <td className="text-right">{l.sellerId !== me.id && <NeonButton size="sm" onClick={() => setBuying(l)}>{t("common.buy")}</NeonButton>}</td>
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
        <QueryState q={mine} isEmpty={(d) => d.listings.length === 0} empty={<EmptyState title={t("market.noListings")} icon="market" />}>
          {(d) => (
            <HoloPanel padded={false}>
              <div className="overflow-x-auto">
                <table className="nf-table">
                  <thead><tr><th>{t("common.item")}</th><th>{t("common.status")}</th><th>{t("common.price")}</th><th>{t("common.fee")}</th><th>{t("market.proceeds")}</th><th /></tr></thead>
                  <tbody>
                    {d.listings.map((l) => (
                      <tr key={l.id}>
                        <td className="nf-ui text-[15px] font-bold">{l.quantity > 1 ? `${l.quantity}× ` : ""}{l.name}</td>
                        <td><span className="nf-chip">{enumLabel(l.status)}</span></td>
                        <td><CurrencyAmount amount={l.price} currency={l.currency} size={14} /></td>
                        <td className="text-dim">{formatAmount(l.fee, l.currency)}</td>
                        <td><CurrencyAmount amount={l.sellerReceives} currency={l.currency} size={14} /></td>
                        <td className="text-right">{l.status === "ACTIVE" && <NeonButton size="sm" variant="danger" loading={cancel.isPending && cancel.variables === l.id} onClick={() => cancel.mutate(l.id)}><Icon name="close" size={12} />{t("common.cancel")}</NeonButton>}</td>
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
