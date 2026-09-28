import { CurrencyAmount } from "@nebula/game-ui";
import type { ResourceId } from "@nebula/shared";
import { itemName, RESOURCE_META } from "../lib/gameMeta.js";
import type { RewardBundleView } from "../lib/dto.js";

/** Compact rendering of a reward bundle (XP, credits, gems, resources, items, reward eligibility). */
export function RewardChips({ bundle, size = 13 }: { bundle: RewardBundleView | null | undefined; size?: number }) {
  if (!bundle) return <span className="text-[12px] text-mute">—</span>;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      {bundle.xp ? <span className="nf-ui font-bold" style={{ fontSize: size, color: "#a78bfa" }}>{bundle.xp.toLocaleString()} XP</span> : null}
      {bundle.honor ? <span className="nf-ui font-bold" style={{ fontSize: size, color: "#93c5fd" }}>{bundle.honor.toLocaleString()} Honor</span> : null}
      {bundle.credits ? <CurrencyAmount amount={bundle.credits} currency="CREDITS" size={size} showSymbol={false} /> : null}
      {bundle.gems ? <CurrencyAmount amount={bundle.gems} currency="GEMS" size={size} showSymbol={false} /> : null}
      {bundle.seasonPoints ? <span className="nf-ui font-bold" style={{ fontSize: size, color: "#fbbf24" }}>{bundle.seasonPoints} SP</span> : null}
      {Object.entries(bundle.resources ?? {}).map(([k, v]) => (
        <span key={k} className="nf-ui font-bold" style={{ fontSize: size, color: RESOURCE_META[k as ResourceId]?.color }}>{v}× {RESOURCE_META[k as ResourceId]?.label ?? k}</span>
      ))}
      {(bundle.items ?? []).map((i) => (
        <span key={i.itemId} className="nf-chip" style={{ fontSize: size - 2 }}>{i.quantity > 1 ? `${i.quantity}× ` : ""}{i.name ?? itemName(i.itemId)}</span>
      ))}
      {bundle.cryptoEligible && <span className="nf-chip" style={{ color: "var(--nf-crypto)", borderColor: "var(--nf-crypto)", fontSize: size - 2 }}>Battle Reward eligible</span>}
    </div>
  );
}
