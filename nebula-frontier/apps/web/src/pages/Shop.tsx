import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { CurrencyAmount, Icon, Modal, NeonButton, Tabs } from "@nebula/game-ui";
import type { IconName } from "@nebula/game-ui";
import { api } from "../lib/api.js";
import type { RewardBundleView, ShopProductView } from "../lib/dto.js";
import { idempotencyKey } from "../lib/http.js";
import { qk, useApiMutation, useShop } from "../lib/queries.js";
import { humanize, shipName } from "../lib/gameMeta.js";
import { PageHeader } from "../components/PageHeader.js";
import { EmptyState, QueryState } from "../components/QueryState.js";
import { RewardChips } from "../components/RewardChips.js";
import { useSession } from "../hooks/useSession.js";
import { haptic } from "../native/haptics.js";

const CAT_ICON: Record<string, IconName> = {
  SHIPS: "ship", SHIP_PARTS: "hull", WEAPONS: "weapon", MODULES: "module", SKINS: "star", COSMETICS: "star", BOOSTERS: "rocket",
  BATTLE_PASS: "battlepass", PREMIUM: "crown", BUNDLES: "inventory", GEMS: "gems", AMMO: "fire", DRONES: "drone",
};

function Grants({ p }: { p: ShopProductView }) {
  const g = (p.grants ?? {}) as RewardBundleView & { ships?: string[]; premium?: { tier: string; days: number }; battlePassPremium?: boolean };
  return (
    <div className="grid gap-1.5">
      {g.ships?.map((s) => <span key={s} className="nf-chip justify-self-start"><Icon name="ship" size={11} />{shipName(s)}</span>)}
      {g.premium && <span className="nf-chip justify-self-start" style={{ color: "var(--nf-credits)" }}><Icon name="crown" size={11} />{humanize(g.premium.tier)} · {g.premium.days} days</span>}
      {g.battlePassPremium && <span className="nf-chip justify-self-start" style={{ color: "var(--nf-credits)" }}>Premium battle pass</span>}
      <RewardChips bundle={g} size={12.5} />
    </div>
  );
}

function BuyModal({ p, onClose }: { p: ShopProductView; onClose: () => void }) {
  const me = useSession();
  const navigate = useNavigate();
  const [qty, setQty] = useState(1);
  const buy = useApiMutation(() => api.shop.purchase({ productId: p.id, quantity: qty, idempotencyKey: idempotencyKey("shop") }), {
    invalidate: [qk.me, qk.inventory, qk.ships, qk.battlepass], success: `Purchased ${p.name}`, onSuccess: () => { haptic("success"); onClose(); },
  });
  const deposit = p.purchaseFlow === "DEPOSIT" || p.currency === "SOL" || p.currency === "NEBX";
  const stackable = !deposit && (p.category === "AMMO" || p.category === "BOOSTERS");
  const total = BigInt(p.price) * BigInt(qty);
  const bal = p.currency === "CREDITS" ? BigInt(me.balances.credits) : p.currency === "GEMS" ? BigInt(me.balances.gems) : null;
  const short = bal !== null && bal < total;
  return (
    <Modal open onClose={onClose} locked={buy.isPending} title={p.name}
      footer={deposit ? (
        <NeonButton variant="primary" onClick={() => navigate(`/wallet/deposit?product=${encodeURIComponent(p.id)}`)} icon={<Icon name="wallet" size={16} />}>Pay with devnet wallet</NeonButton>
      ) : (
        <NeonButton variant="primary" loading={buy.isPending} disabled={short || me.level < p.requiredLevel} onClick={() => buy.mutate(undefined)}>
          {me.level < p.requiredLevel ? `Requires level ${p.requiredLevel}` : short ? "Insufficient balance" : <>Buy · <CurrencyAmount amount={total} currency={p.currency} size={14} /></>}
        </NeonButton>
      )}>
      <div className="grid gap-4">
        <p className="m-0 text-[14px] text-dim">{p.description}</p>
        <Grants p={p} />
        {stackable && (
          <label className="grid gap-1.5"><span className="nf-label">Quantity</span>
            <input className="nf-input w-32" type="number" min={1} max={p.limitPerUser ?? 100} value={qty} onChange={(e) => setQty(Math.max(1, Math.min(p.limitPerUser ?? 100, Number(e.target.value) || 1)))} />
          </label>
        )}
        <div className="grid gap-2 rounded-lg border border-line bg-black/25 p-3">
          <div className="flex justify-between"><span className="text-dim">Price</span><CurrencyAmount amount={total} currency={p.currency} /></div>
          {bal !== null && <div className="flex justify-between text-[13px]"><span className="text-mute">Your balance</span><CurrencyAmount amount={bal} currency={p.currency} size={13} /></div>}
          {deposit && <div className="text-[12px] text-mute">Paid on Solana devnet from your connected wallet. Gems are credited after the transfer is confirmed and verified.</div>}
        </div>
      </div>
    </Modal>
  );
}

export default function ShopPage() {
  const q = useShop();
  const [params, setParams] = useSearchParams();
  const [buying, setBuying] = useState<ShopProductView | null>(null);
  const cats = useMemo(() => [...new Set((q.data ?? []).map((p) => p.category))], [q.data]);
  const cat = params.get("cat") ?? "FEATURED";
  const productParam = params.get("product");
  useEffect(() => {
    if (productParam && q.data) {
      const p = q.data.find((x) => x.id === productParam);
      if (p) setBuying(p);
    }
  }, [productParam, q.data]);
  const list = (q.data ?? []).filter((p) => (cat === "FEATURED" ? p.featured : p.category === cat));
  const featured = (q.data ?? []).filter((p) => p.featured).slice(0, 1)[0];

  return (
    <div>
      <PageHeader eyebrow="Supply depot" title="Shop" subtitle="All prices come live from the server. Gem packs are paid with devnet SOL through your wallet." />
      {featured && cat === "FEATURED" && (
        <button type="button" onClick={() => setBuying(featured)} className="nf-panel nf-panel--interactive mb-5 block w-full overflow-hidden text-left" style={{ "--nf-accent": "var(--nf-credits)" } as CSSProperties}>
          <div className="flex flex-wrap items-center gap-5 p-6" style={{ background: "radial-gradient(circle at 12% 50%, color-mix(in oklab, var(--nf-credits) 30%, transparent), transparent 55%)" }}>
            <span className="text-accent"><Icon name={CAT_ICON[featured.category] ?? "star"} size={46} /></span>
            <div className="min-w-0 flex-1">
              <div className="nf-eyebrow">Featured</div>
              <div className="nf-display text-[26px] font-black tracking-[0.06em]">{featured.name}</div>
              <div className="text-[13.5px] text-dim">{featured.description}</div>
            </div>
            <CurrencyAmount amount={featured.price} currency={featured.currency} size={22} />
          </div>
        </button>
      )}
      <Tabs className="mb-4" value={cat} onChange={(k) => setParams(k === "FEATURED" ? {} : { cat: k })} items={[{ key: "FEATURED", label: "Featured" }, ...cats.map((c) => ({ key: c, label: humanize(c) }))]} />
      <QueryState q={q}>
        {() => list.length === 0 ? <EmptyState title="Nothing in this aisle" icon="shop" /> : (
          <div className="nf-grid-cards" style={{ "--card-min": "230px" } as CSSProperties}>
            {list.map((p) => (
              <article key={p.id} className="nf-panel nf-panel--interactive grid content-between gap-3 p-4" onClick={() => setBuying(p)} data-testid="shop-product">
                <div className="grid gap-2">
                  <div className="flex items-start justify-between">
                    <span className="grid h-12 w-12 place-items-center rounded-xl border border-line bg-black/30 text-accent"><Icon name={CAT_ICON[p.category] ?? "shop"} size={26} /></span>
                    {p.featured && <span className="nf-chip text-[10px]" style={{ color: "var(--nf-credits)" }}>Featured</span>}
                  </div>
                  <div className="nf-ui text-[17px] font-bold leading-tight">{p.name}</div>
                  <div className="line-clamp-2 text-[12.5px] text-dim">{p.description}</div>
                </div>
                <div className="flex items-center justify-between border-t border-line pt-3">
                  <CurrencyAmount amount={p.price} currency={p.currency} size={16} />
                  {p.requiredLevel > 1 && <span className="nf-label">Lv {p.requiredLevel}+</span>}
                </div>
              </article>
            ))}
          </div>
        )}
      </QueryState>
      {buying && <BuyModal p={buying} onClose={() => { setBuying(null); if (productParam) setParams(cat === "FEATURED" ? {} : { cat }); }} />}
    </div>
  );
}
