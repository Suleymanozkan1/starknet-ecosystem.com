import { useState } from "react";
import type { CSSProperties } from "react";
import { Countdown, CurrencyAmount, HoloPanel, Modal, NeonButton, RarityBadge, Tabs, rarityStyle } from "@nebula/game-ui";
import { mulRatio } from "@nebula/shared";
import type { InventoryItemDto } from "@nebula/shared";
import { api } from "../lib/api.js";
import type { AuctionDto } from "../lib/dto.js";
import { idempotencyKey } from "../lib/http.js";
import { qk, useApiMutation, useAuctions, useEconomyStatus, useInventory } from "../lib/queries.js";
import { humanize } from "../lib/gameMeta.js";
import { PageHeader } from "../components/PageHeader.js";
import { EmptyState, QueryState } from "../components/QueryState.js";
import { ItemIcon, ItemTile } from "../components/ItemTile.js";
import { FeeRow } from "./Market.js";
import { useSession } from "../hooks/useSession.js";
import { haptic } from "../native/haptics.js";

type AType = "HOURLY" | "DAILY" | "WEEKLY";

function BidModal({ a, saleFee, onClose }: { a: AuctionDto; saleFee: number; onClose: () => void }) {
  const min = BigInt(a.minNextBid ?? (a.currentBid ? (BigInt(a.currentBid) + 1n).toString() : a.startPrice));
  const [amount, setAmount] = useState(min.toString());
  const valid = /^\d+$/.test(amount) && BigInt(amount) >= min;
  const bid = useApiMutation(() => api.auctions.bid(a.id, amount, idempotencyKey("bid")), { invalidate: [["auctions"], qk.me], success: "Bid placed", onSuccess: () => { haptic("success"); onClose(); } });
  const buyout = useApiMutation(() => api.auctions.buyout(a.id, idempotencyKey("buyout")), { invalidate: [["auctions"], qk.me, qk.inventory], success: `You won ${a.name}`, onSuccess: () => { haptic("success"); onClose(); } });
  const busy = bid.isPending || buyout.isPending;
  return (
    <Modal open onClose={onClose} locked={busy} title={`Bid · ${a.name}`}
      footer={<>
        {a.buyoutPrice && <NeonButton variant="success" loading={buyout.isPending} disabled={busy} onClick={() => buyout.mutate(undefined)}>Buy out <CurrencyAmount amount={a.buyoutPrice} currency={a.currency} size={14} /></NeonButton>}
        <NeonButton variant="primary" loading={bid.isPending} disabled={!valid || busy} onClick={() => bid.mutate(undefined)}>Place bid</NeonButton>
      </>}>
      <div className="grid gap-4">
        <div className="flex items-center justify-between">
          <span className="nf-label">Ends in</span>
          <Countdown to={a.endsAt} className="text-[20px]" urgentBelowMs={300_000} />
        </div>
        <label className="grid gap-1.5">
          <span className="nf-label">Your bid (min {min.toString()})</span>
          <input className="nf-input" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))} />
        </label>
        <div className="grid gap-2 rounded-lg border border-line bg-black/25 p-3">
          <FeeRow label="Current bid" amount={a.currentBid ?? "0"} currency={a.currency} />
          {valid && <FeeRow label={`Sale fee (${(saleFee * 100).toFixed(1)}%, paid by seller)`} amount={mulRatio(BigInt(amount), saleFee)} currency={a.currency} />}
          {valid && <FeeRow label="You pay if you win" amount={amount} currency={a.currency} strong />}
        </div>
        <p className="m-0 text-[12px] text-mute">Your bid is reserved from your balance and released automatically if you are outbid.</p>
      </div>
    </Modal>
  );
}

function CreateAuction({ fees }: { fees: { listing: number; sale: number; cancellation: number } }) {
  const inv = useInventory();
  const [sel, setSel] = useState<InventoryItemDto | null>(null);
  const [type, setType] = useState<AType>("DAILY");
  const [currency, setCurrency] = useState<"CREDITS" | "GEMS">("CREDITS");
  const [start, setStart] = useState("");
  const [buyout, setBuyout] = useState("");
  const tradeable = (inv.data?.items ?? []).filter((i) => i.tradeable && !i.equippedOn);
  const startN = /^\d+$/.test(start) ? BigInt(start) : 0n;
  const create = useApiMutation(() => api.auctions.create({ inventoryItemId: sel!.id, quantity: 1, type, currency, startPrice: start, buyoutPrice: buyout || null, idempotencyKey: idempotencyKey("auction") }), {
    invalidate: [["auctions"], qk.inventory, qk.me], success: "Auction started", onSuccess: () => { setSel(null); setStart(""); setBuyout(""); },
  });
  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_380px]">
      <HoloPanel title="Select an item">
        <QueryState q={inv} isEmpty={() => tradeable.length === 0} empty={<EmptyState title="Nothing tradeable" icon="inventory" />}>
          {() => <div className="grid max-h-[480px] grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3 xl:grid-cols-4">{tradeable.map((i) => <ItemTile key={i.id} item={i} compact selected={sel?.id === i.id} onClick={() => setSel(i)} />)}</div>}
        </QueryState>
      </HoloPanel>
      <HoloPanel title="Auction terms" glow={Boolean(sel)}>
        {!sel ? <div className="text-[13px] text-mute">Choose an item to auction.</div> : (
          <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); if (startN > 0n) create.mutate(undefined); }}>
            <div className="nf-ui text-[16px] font-bold">{sel.name}</div>
            <div className="flex gap-1.5">{(["HOURLY", "DAILY", "WEEKLY"] as const).map((t) => <button type="button" key={t} className="nf-chip cursor-pointer" style={t === type ? { color: "var(--nf-accent)", borderColor: "var(--nf-accent)" } : undefined} onClick={() => setType(t)}>{humanize(t)}</button>)}</div>
            <label className="grid gap-1.5"><span className="nf-label">Currency</span><select className="nf-input" value={currency} onChange={(e) => setCurrency(e.target.value as "CREDITS" | "GEMS")}><option value="CREDITS">Credits</option><option value="GEMS">Gems</option></select></label>
            <label className="grid gap-1.5"><span className="nf-label">Starting bid</span><input className="nf-input" inputMode="numeric" value={start} onChange={(e) => setStart(e.target.value.replace(/\D/g, ""))} /></label>
            <label className="grid gap-1.5"><span className="nf-label">Buyout (optional)</span><input className="nf-input" inputMode="numeric" value={buyout} onChange={(e) => setBuyout(e.target.value.replace(/\D/g, ""))} /></label>
            {startN > 0n && (
              <div className="grid gap-2 rounded-lg border border-line bg-black/25 p-3">
                <FeeRow label={`Listing fee (${(fees.listing * 100).toFixed(1)}%, non-refundable)`} amount={mulRatio(startN, fees.listing)} currency={currency} negative />
                <FeeRow label={`Sale fee on final price (${(fees.sale * 100).toFixed(1)}%)`} amount={mulRatio(startN, fees.sale)} currency={currency} negative />
                <FeeRow label="Proceeds at starting bid" amount={startN - mulRatio(startN, fees.sale)} currency={currency} strong />
                <div className="text-[11.5px] text-mute">Cancelling a live auction costs {(fees.cancellation * 100).toFixed(1)}%.</div>
              </div>
            )}
            <NeonButton type="submit" variant="primary" loading={create.isPending} disabled={startN <= 0n || (buyout !== "" && BigInt(buyout || "0") <= startN)}>Start auction</NeonButton>
          </form>
        )}
      </HoloPanel>
    </div>
  );
}

export default function AuctionPage() {
  const me = useSession();
  const [tab, setTab] = useState<AType | "CREATE" | "MINE">("DAILY");
  const live = useAuctions(tab === "HOURLY" || tab === "DAILY" || tab === "WEEKLY" ? { type: tab } : { mine: true });
  const eco = useEconomyStatus();
  const [bidding, setBidding] = useState<AuctionDto | null>(null);
  const cancel = useApiMutation((id: string) => api.auctions.cancel(id), { invalidate: [["auctions"], qk.inventory], success: "Auction cancelled" });
  const fees = live.data?.fees ?? { listing: eco.data?.fees.auctionListingFee ?? 0, sale: eco.data?.fees.auctionSaleFee ?? 0, cancellation: eco.data?.fees.auctionCancellationFee ?? 0 };

  return (
    <div>
      <PageHeader eyebrow="Auction house" title="Auctions" subtitle="Timed auctions with optional buyout. Anti-sniping extends auctions that receive late bids." />
      <Tabs className="mb-4" value={tab} onChange={setTab} items={[{ key: "HOURLY", label: "Hourly" }, { key: "DAILY", label: "Daily" }, { key: "WEEKLY", label: "Weekly" }, { key: "CREATE", label: "Create" }, { key: "MINE", label: "Mine" }]} />
      {tab === "CREATE" ? <CreateAuction fees={fees} /> : (
        <QueryState q={live} isEmpty={(d) => d.auctions.length === 0} empty={<EmptyState title="No auctions" icon="auction" />}>
          {(d) => (
            <div className="nf-grid-cards" style={{ "--card-min": "260px" } as CSSProperties}>
              {d.auctions.map((a) => (
                <article key={a.id} className="nf-panel nf-rarity-frame grid gap-3 p-4" style={rarityStyle(a.rarity)}>
                  <div className="flex items-start gap-3">
                    <ItemIcon item={{ category: "WEAPON", itemId: a.itemId, rarity: a.rarity }} size={30} />
                    <div className="min-w-0 flex-1"><div className="nf-ui truncate text-[16px] font-bold">{a.name}</div><div className="nf-label">{a.sellerName ?? "—"} · {humanize(a.type)}</div></div>
                    <RarityBadge rarity={a.rarity} />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div><div className="nf-label">{a.currentBid ? "Current bid" : "Starting bid"}</div><CurrencyAmount amount={a.currentBid ?? a.startPrice} currency={a.currency} size={16} /></div>
                    <div><div className="nf-label">Buyout</div>{a.buyoutPrice ? <CurrencyAmount amount={a.buyoutPrice} currency={a.currency} size={16} /> : <span className="text-mute">—</span>}</div>
                  </div>
                  <div className="flex items-center justify-between">
                    <Countdown to={a.endsAt} urgentBelowMs={300_000} className="text-[15px]" />
                    {a.leading && <span className="nf-chip" style={{ color: "var(--nf-good)" }}>Leading</span>}
                    <span className="nf-label">{a.bidCount ?? 0} bids</span>
                  </div>
                  {a.sellerId === me.id ? (
                    <NeonButton size="sm" variant="danger" loading={cancel.isPending && cancel.variables === a.id} disabled={Boolean(a.currentBid)} onClick={() => cancel.mutate(a.id)}>{a.currentBid ? "Has bids" : "Cancel"}</NeonButton>
                  ) : (
                    <NeonButton size="sm" variant="primary" onClick={() => setBidding(a)} disabled={a.status !== "ACTIVE"}>Bid</NeonButton>
                  )}
                </article>
              ))}
            </div>
          )}
        </QueryState>
      )}
      {bidding && <BidModal a={bidding} saleFee={fees.sale} onClose={() => setBidding(null)} />}
    </div>
  );
}
