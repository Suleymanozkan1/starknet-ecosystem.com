import { useMemo } from "react";
import { CurrencyAmount, HoloPanel, Icon, NeonButton, ProgressRing, StatBar, STAT_COLORS } from "@nebula/game-ui";
import type { BattlePassTierDef } from "@nebula/shared";
import { api } from "../lib/api.js";
import { idempotencyKey } from "../lib/http.js";
import { qk, useApiMutation, useBattlePass, useShop } from "../lib/queries.js";
import { PageHeader } from "../components/PageHeader.js";
import { EmptyState, QueryState } from "../components/QueryState.js";
import { RewardChips } from "../components/RewardChips.js";
import { haptic } from "../native/haptics.js";
import { En, fmtNum, useT } from "../lib/i18n.js";

interface TierState { reached: boolean; premium: boolean; freeClaimed: boolean; premiumClaimed: boolean }

function TierCard({ t, st, onClaim, claiming }: { t: BattlePassTierDef; st: TierState; onClaim: (track: "free" | "premium") => void; claiming: boolean }) {
  const tr = useT();
  const cell = (track: "free" | "premium") => {
    const bundle = track === "free" ? t.free : t.premium;
    const claimed = track === "free" ? st.freeClaimed : st.premiumClaimed;
    const locked = !st.reached || (track === "premium" && !st.premium);
    return (
      <div
        className="grid min-h-[112px] content-between gap-2 rounded-lg border p-2.5"
        style={{
          opacity: locked && !claimed ? 0.55 : 1,
          borderColor: track === "premium" ? "color-mix(in oklab, var(--nf-credits) 40%, transparent)" : "var(--nf-line)",
          background: track === "premium" ? "color-mix(in oklab, var(--nf-credits) 7%, transparent)" : "rgba(0,0,0,0.25)",
        }}
      >
        {bundle ? <RewardChips bundle={bundle} size={12} /> : <span className="text-[11px] text-mute">—</span>}
        {bundle && (claimed ? <span className="nf-chip justify-self-start text-[10px]" style={{ color: "var(--nf-good)" }}><Icon name="check" size={10} />{tr("common.claimed")}</span>
          : locked ? <span className="nf-label flex items-center gap-1 text-[10px]"><Icon name="lock" size={11} />{track === "premium" && !st.premium ? tr("bp.premium") : tr("bp.locked")}</span>
          : <NeonButton size="sm" variant="success" loading={claiming} onClick={() => onClaim(track)}>{tr("common.claim")}</NeonButton>)}
      </div>
    );
  };
  return (
    <div className="grid w-[168px] shrink-0 gap-2" data-testid="bp-tier">
      <div className="flex items-center justify-between">
        <span className="nf-display text-[18px] font-bold" style={{ color: st.reached ? "var(--nf-accent)" : "var(--nf-text-mute)" }}>{t.tier}</span>
        <span className="nf-label text-[10px]">{tr("reward.xp", { n: fmtNum(t.xpRequired) })}</span>
      </div>
      {cell("free")}
      {cell("premium")}
    </div>
  );
}

export default function BattlePassPage() {
  const tr = useT();
  const bp = useBattlePass();
  const shop = useShop();
  const claim = useApiMutation((v: { tier: number; track: "free" | "premium" }) => api.battlepass.claim(v.tier, v.track), { invalidate: [qk.battlepass, qk.me, qk.inventory], success: tr("bp.claimed"), onSuccess: () => haptic("success") });
  const premiumProduct = useMemo(() => {
    const d = bp.data;
    const pid = d?.active ? d.premiumProductId : null;
    return (shop.data ?? []).find((p) => (pid ? p.id === pid : p.category === "BATTLE_PASS"));
  }, [shop.data, bp.data]);
  const buy = useApiMutation(() => api.shop.purchase({ productId: premiumProduct!.id, quantity: 1, idempotencyKey: idempotencyKey("bp") }), { invalidate: [qk.battlepass, qk.me], success: tr("bp.premiumUnlocked"), onSuccess: () => haptic("success") });

  return (
    <QueryState q={bp} isEmpty={(d) => !d.active} empty={<><PageHeader eyebrow={tr("nav.battlepass")} title={tr("nav.battlepass")} /><EmptyState title={tr("bp.noneTitle")} body={tr("bp.noneBody")} icon="battlepass" /></>}>
      {(d) => {
        if (!d.active) return null;
        const { state, pass } = d;
        const next = pass.tiers.find((t) => t.tier === state.tier + 1);
        const prevXp = pass.tiers.find((t) => t.tier === state.tier)?.xpRequired ?? 0;
        const tierState = (t: BattlePassTierDef): TierState => ({
          reached: t.tier <= state.tier, premium: state.premium,
          freeClaimed: state.claimedFree.includes(t.tier), premiumClaimed: state.claimedPremium.includes(t.tier),
        });
        const claimable = pass.tiers.filter((t) => t.tier <= state.tier && ((t.free && !state.claimedFree.includes(t.tier)) || (state.premium && t.premium && !state.claimedPremium.includes(t.tier)))).length;
        return (
          <div className="grid gap-5">
            <PageHeader eyebrow={tr("nav.battlepass")} title={<En>{pass.name}</En>} actions={
              !state.premium && premiumProduct ? (
                <NeonButton variant="primary" loading={buy.isPending} onClick={() => buy.mutate(undefined)} color="var(--nf-credits)" icon={<Icon name="crown" size={16} />}>
                  {tr("bp.unlockPremium")} <CurrencyAmount amount={premiumProduct.price} currency={premiumProduct.currency} size={14} showIcon={false} />
                </NeonButton>
              ) : state.premium ? <span className="nf-chip" style={{ color: "var(--nf-credits)", borderColor: "var(--nf-credits)" }}><Icon name="crown" size={12} />{tr("bp.premiumActive")}</span> : undefined
            } />
            <HoloPanel glow>
              <div className="flex flex-wrap items-center gap-6">
                <ProgressRing value={next ? (state.xp - prevXp) / Math.max(1, next.xpRequired - prevXp) : 1} size={92} stroke={6}>
                  <span className="grid justify-items-center"><span className="nf-display text-[26px] font-black">{state.tier}</span><span className="nf-label text-[9px]">{tr("bp.tier")}</span></span>
                </ProgressRing>
                <div className="grid min-w-[220px] flex-1 gap-2">
                  <StatBar label={tr("bp.passXp")} value={Math.max(0, state.xp - prevXp)} max={Math.max(1, (next?.xpRequired ?? state.xp) - prevXp)} color={STAT_COLORS.xp} format={(v, m) => (next ? `${fmtNum(v)} / ${fmtNum(m)}` : tr("bp.maxTier"))} />
                  <div className="text-[13px] text-dim">{tr("bp.totalXp", { n: fmtNum(state.xp) })} · {claimable > 0 ? <b className="text-good">{tr("bp.readyToClaim", { n: claimable })}</b> : tr("bp.earnHint")}</div>
                </div>
              </div>
            </HoloPanel>
            <HoloPanel padded={false}>
              <div className="flex gap-3 overflow-x-auto p-4">
                <div className="grid w-[64px] shrink-0 content-start gap-2 pt-8">
                  <div className="nf-label grid h-[112px] place-items-center">{tr("bp.free")}</div>
                  <div className="nf-label grid h-[112px] place-items-center" style={{ color: "var(--nf-credits)" }}>{tr("bp.premium")}</div>
                </div>
                {pass.tiers.map((t) => (
                  <TierCard key={t.tier} t={t} st={tierState(t)} claiming={claim.isPending && claim.variables?.tier === t.tier} onClaim={(track) => claim.mutate({ tier: t.tier, track })} />
                ))}
              </div>
            </HoloPanel>
          </div>
        );
      }}
    </QueryState>
  );
}
