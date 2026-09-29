import { Link } from "react-router-dom";
import { NPCS_BY_ID } from "@nebula/config";
import { Countdown, CurrencyAmount, HoloPanel, Icon, StatBar } from "@nebula/game-ui";
import { useLeaderboard, useRewards, useSeasons } from "../lib/queries.js";
import { useSession } from "../hooks/useSession.js";
import { PageHeader } from "../components/PageHeader.js";
import { EmptyState, ErrorState, QueryState } from "../components/QueryState.js";
import { RewardChips } from "../components/RewardChips.js";
import { En, Rich, contentText, enumText, fmtNum, translateServerText, useT } from "../lib/i18n.js";
import type { TKey } from "../lib/i18n.js";

/** Season overview + transparent Season Rewards rules (caps, eligibility) — no investment framing. */
export default function SeasonPage() {
  const t = useT();
  const me = useSession();
  const seasons = useSeasons();
  const rewards = useRewards();
  const board = useLeaderboard("season_score");
  const mine = board.data?.entries.find((e) => e.userId === me.id);
  return (
    <div>
      <QueryState q={seasons} isEmpty={(d) => d.length === 0} empty={<EmptyState title={t("season.empty")} icon="season" />}>
        {(list) => {
          const s = list.find((x) => x.active) ?? list[0]!;
          const start = new Date(s.startAt).getTime();
          const end = new Date(s.endAt).getTime();
          const pct = Math.max(0, Math.min(1, (Date.now() - start) / Math.max(1, end - start)));
          const boss = s.bossId ? NPCS_BY_ID.get(s.bossId) : undefined;
          return (
            <div className="grid gap-5">
              <PageHeader eyebrow={t("season.eyebrow", { n: s.number })} title={<En>{s.name}</En>} subtitle={contentText("seasonTheme", s.id, s.theme)} actions={<Link to="/battle-pass" className="nf-btn nf-btn--primary nf-btn--sm no-underline"><Icon name="battlepass" size={15} />{t("nav.battlepass")}</Link>} />
              <div className="grid gap-4 md:grid-cols-3">
                <HoloPanel title={t("season.clock")} glow>
                  <div className="nf-label">{s.active ? t("common.endsIn") : t("common.startsIn")}</div>
                  <Countdown to={s.active ? s.endAt : s.startAt} className="text-[28px]" />
                  <div className="mt-3"><StatBar value={pct * 100} max={100} height={5} showValue={false} ghost={false} /></div>
                </HoloPanel>
                <HoloPanel title={t("season.standing")}>
                  <div className="grid grid-cols-2 gap-3">
                    <div><div className="nf-label">{t("season.points")}</div><div className="nf-display text-[24px] font-bold">{mine ? fmtNum(BigInt(mine.score)) : "—"}</div></div>
                    <div><div className="nf-label">{t("common.rank")}</div><div className="nf-display text-[24px] font-bold">{mine ? `#${mine.rank}` : t("season.unranked")}</div></div>
                  </div>
                </HoloPanel>
                <HoloPanel title={t("season.boss")} accent="#f43f5e">
                  <div className="nf-display text-[20px] font-bold text-bad">{boss?.name ?? "—"}</div>
                  <div className="text-[13px] text-dim">{boss ? t("season.bossInfo", { level: boss.level, phases: boss.phases?.length ?? 0 }) : ""}</div>
                  <Link to="/events" className="nf-link mt-2 inline-block text-[13px]">{t("season.worldEvents")}</Link>
                </HoloPanel>
              </div>
              <div className="grid gap-4 lg:grid-cols-2">
                <HoloPanel title={t("season.lbRewards")}>
                  <table className="nf-table">
                    <thead><tr><th>{t("common.rank")}</th><th>{t("season.rewards")}</th></tr></thead>
                    <tbody>{s.leaderboardRewards.map((r) => <tr key={r.rankFrom}><td className="nf-ui font-bold">{r.rankFrom === r.rankTo ? `#${r.rankFrom}` : `#${r.rankFrom}–${r.rankTo}`}</td><td><RewardChips bundle={r.bundle} /></td></tr>)}</tbody>
                  </table>
                </HoloPanel>
                <HoloPanel title={t("season.ranked")}>
                  <table className="nf-table">
                    <thead><tr><th>{t("season.tier")}</th><th>{t("season.rating")}</th><th>{t("season.rewards")}</th></tr></thead>
                    <tbody>{s.rankedRewards.map((r) => <tr key={r.tier}><td className="nf-ui font-bold">{enumText(r.tier, r.tier)}</td><td className="tabular-nums">{r.minRating}+</td><td><RewardChips bundle={r.bundle} /></td></tr>)}</tbody>
                  </table>
                </HoloPanel>
              </div>
            </div>
          );
        }}
      </QueryState>

      <div className="mt-5">
        <HoloPanel title={t("season.howTitle")} accent="var(--nf-crypto)">
          {rewards.error ? <ErrorState error={rewards.error} onRetry={() => void rewards.refetch()} /> : !rewards.data ? <div className="nf-skeleton h-32" /> : (
            <div className="grid gap-5 lg:grid-cols-[1fr_1fr]">
              <div className="grid gap-3">
                <p className="m-0 text-[13.5px] leading-relaxed text-dim">
                  <Rich text={t("season.howBody")} parts={{ battleRewards: <b className="text-ink">{t("common.battleRewards")}</b> }} />
                </p>
                <ul className="m-0 grid list-disc gap-1.5 pl-5 text-[13px] text-dim">{rewards.data.rules.map((r) => <li key={r}>{translateServerText(r)}</li>)}</ul>
                <div className="flex items-center gap-2 text-[13px]">
                  <span className="nf-label">{t("season.eligibility")}</span>
                  {rewards.data.eligibility.eligible ? <span className="nf-chip" style={{ color: "var(--nf-good)" }}>{t("season.eligible")}</span> : <span className="nf-chip" style={{ color: "var(--nf-warn)" }}>{t("season.notYetEligible")}</span>}
                </div>
                {!rewards.data.eligibility.eligible && <ul className="m-0 grid list-disc gap-1 pl-5 text-[12.5px] text-mute">{rewards.data.eligibility.reasons.map((r) => <li key={r}>{translateServerText(r)}</li>)}</ul>}
              </div>
              <div className="grid content-start gap-3">
                {([
                  ["season.dailyCap", rewards.data.caps.dailyUsed, rewards.data.caps.daily],
                  ["season.weeklyCap", rewards.data.caps.weeklyUsed, rewards.data.caps.weekly],
                  ["season.seasonCap", rewards.data.caps.seasonUsed, rewards.data.caps.season],
                ] as const satisfies readonly (readonly [TKey, string, string])[]).map(([label, used, cap]) => (
                  <div key={label} className="grid gap-1">
                    <div className="flex justify-between text-[12.5px]"><span className="nf-label">{t(label)}</span><span><CurrencyAmount amount={used} currency="NEBX" size={12} showIcon={false} /> / <CurrencyAmount amount={cap} currency="NEBX" size={12} showIcon={false} /></span></div>
                    <StatBar value={Number(BigInt(used) * 1000n / (BigInt(cap) || 1n))} max={1000} showValue={false} height={4} ghost={false} color="var(--nf-crypto)" />
                  </div>
                ))}
                <div className="flex items-center justify-between rounded-lg border border-line bg-black/25 p-3">
                  <span className="nf-label">{t("season.claimableNow")}</span>
                  <CurrencyAmount amount={rewards.data.claimable} currency="NEBX" size={18} />
                </div>
                <Link to="/wallet" className="nf-link text-[13px]">{t("season.claimInWallet")}</Link>
              </div>
            </div>
          )}
        </HoloPanel>
      </div>
    </div>
  );
}
