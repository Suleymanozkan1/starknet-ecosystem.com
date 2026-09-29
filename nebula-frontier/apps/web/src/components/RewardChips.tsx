import { CurrencyAmount } from "@nebula/game-ui";
import type { ResourceId } from "@nebula/shared";
import { itemName, RESOURCE_META, resourceLabel } from "../lib/gameMeta.js";
import { fmtNum, useT } from "../lib/i18n.js";
import type { RewardBundleView } from "../lib/dto.js";

/** Compact rendering of a reward bundle (XP, credits, gems, resources, items, reward eligibility). */
export function RewardChips({ bundle, size = 13 }: { bundle: RewardBundleView | null | undefined; size?: number }) {
  const t = useT();
  if (!bundle) return <span className="text-[12px] text-mute">—</span>;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      {bundle.xp ? <span className="nf-ui font-bold" style={{ fontSize: size, color: "#a78bfa" }}>{t("reward.xp", { n: fmtNum(bundle.xp) })}</span> : null}
      {bundle.honor ? <span className="nf-ui font-bold" style={{ fontSize: size, color: "#93c5fd" }}>{t("reward.honor", { n: fmtNum(bundle.honor) })}</span> : null}
      {bundle.credits ? <CurrencyAmount amount={bundle.credits} currency="CREDITS" size={size} showSymbol={false} /> : null}
      {bundle.gems ? <CurrencyAmount amount={bundle.gems} currency="GEMS" size={size} showSymbol={false} /> : null}
      {bundle.seasonPoints ? <span className="nf-ui font-bold" style={{ fontSize: size, color: "#fbbf24" }}>{t("reward.sp", { n: bundle.seasonPoints })}</span> : null}
      {Object.entries(bundle.resources ?? {}).map(([k, v]) => (
        <span key={k} className="nf-ui font-bold" style={{ fontSize: size, color: RESOURCE_META[k as ResourceId]?.color }}>{v}× {resourceLabel(k)}</span>
      ))}
      {(bundle.items ?? []).map((i) => (
        <span key={i.itemId} className="nf-chip" lang="en" style={{ fontSize: size - 2 }}>{i.quantity > 1 ? `${i.quantity}× ` : ""}{i.name ?? itemName(i.itemId)}</span>
      ))}
      {bundle.cryptoEligible && <span className="nf-chip" style={{ color: "var(--nf-crypto)", borderColor: "var(--nf-crypto)", fontSize: size - 2 }}>{t("reward.cryptoEligible")}</span>}
    </div>
  );
}
