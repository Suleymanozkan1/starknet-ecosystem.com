import { Link } from "react-router-dom";
import { NPCS_BY_ID } from "@nebula/config";
import { Countdown, CurrencyAmount, HoloPanel, Icon, StatBar } from "@nebula/game-ui";
import { useRewards, useSeasons } from "../lib/queries.js";
import { PageHeader } from "../components/PageHeader.js";
import { EmptyState, ErrorState, QueryState } from "../components/QueryState.js";
import { RewardChips } from "../components/RewardChips.js";

/** Season overview + transparent Season Rewards rules (caps, eligibility) — no investment framing. */
export default function SeasonPage() {
  const seasons = useSeasons();
  const rewards = useRewards();
  return (
    <div>
      <QueryState q={seasons} isEmpty={(d) => d.length === 0} empty={<EmptyState title="No season data" icon="season" />}>
        {(list) => {
          const s = list.find((x) => x.active) ?? list[0]!;
          const start = new Date(s.startAt).getTime();
          const end = new Date(s.endAt).getTime();
          const pct = Math.max(0, Math.min(1, (Date.now() - start) / Math.max(1, end - start)));
          const boss = s.bossId ? NPCS_BY_ID.get(s.bossId) : undefined;
          return (
            <div className="grid gap-5">
              <PageHeader eyebrow={`Season ${s.number}`} title={s.name} subtitle={s.theme} actions={<Link to="/battle-pass" className="nf-btn nf-btn--primary nf-btn--sm no-underline"><Icon name="battlepass" size={15} />Battle Pass</Link>} />
              <div className="grid gap-4 md:grid-cols-3">
                <HoloPanel title="Season clock" glow>
                  <div className="nf-label">{s.active ? "Ends in" : "Starts in"}</div>
                  <Countdown to={s.active ? s.endAt : s.startAt} className="text-[28px]" />
                  <div className="mt-3"><StatBar value={pct * 100} max={100} height={5} showValue={false} ghost={false} /></div>
                </HoloPanel>
                <HoloPanel title="Your standing">
                  <div className="grid grid-cols-2 gap-3">
                    <div><div className="nf-label">Season points</div><div className="nf-display text-[24px] font-bold">{(s.myPoints ?? 0).toLocaleString()}</div></div>
                    <div><div className="nf-label">Rank</div><div className="nf-display text-[24px] font-bold">{s.myRank ? `#${s.myRank}` : "—"}</div></div>
                  </div>
                </HoloPanel>
                <HoloPanel title="Season boss" accent="#f43f5e">
                  <div className="nf-display text-[20px] font-bold text-bad">{boss?.name ?? "—"}</div>
                  <div className="text-[13px] text-dim">{boss ? `Level ${boss.level} · ${boss.phases?.length ?? 0} phases` : ""}</div>
                  <Link to="/events" className="nf-link mt-2 inline-block text-[13px]">World events →</Link>
                </HoloPanel>
              </div>
              <div className="grid gap-4 lg:grid-cols-2">
                <HoloPanel title="Leaderboard rewards">
                  <table className="nf-table">
                    <thead><tr><th>Rank</th><th>Rewards</th></tr></thead>
                    <tbody>{(s.leaderboardRewards ?? []).map((r) => <tr key={r.rankFrom}><td className="nf-ui font-bold">{r.rankFrom === r.rankTo ? `#${r.rankFrom}` : `#${r.rankFrom}–${r.rankTo}`}</td><td><RewardChips bundle={r.bundle} /></td></tr>)}</tbody>
                  </table>
                </HoloPanel>
                <HoloPanel title="Ranked tiers">
                  <table className="nf-table">
                    <thead><tr><th>Tier</th><th>Rating</th><th>Rewards</th></tr></thead>
                    <tbody>{(s.rankedRewards ?? []).map((r) => <tr key={r.tier}><td className="nf-ui font-bold">{r.tier}</td><td className="tabular-nums">{r.minRating}+</td><td><RewardChips bundle={r.bundle} /></td></tr>)}</tbody>
                  </table>
                </HoloPanel>
              </div>
            </div>
          );
        }}
      </QueryState>

      <div className="mt-5">
        <HoloPanel title="Season Rewards — how they work" accent="var(--nf-crypto)">
          {rewards.error ? <ErrorState error={rewards.error} onRetry={() => void rewards.refetch()} /> : !rewards.data ? <div className="nf-skeleton h-32" /> : (
            <div className="grid gap-5 lg:grid-cols-[1fr_1fr]">
              <div className="grid gap-3">
                <p className="m-0 text-[13.5px] leading-relaxed text-dim">
                  Top competitive play (ranked seasons, tournaments, world bosses, raids, faction wars) can earn <b className="text-ink">Battle Rewards</b> from a capped season pool.
                  Rewards are never guaranteed, depend on the season budget and are reviewed for fair play. Spending in the shop does not earn rewards.
                </p>
                <ul className="m-0 grid list-disc gap-1.5 pl-5 text-[13px] text-dim">{rewards.data.rules.map((r) => <li key={r}>{r}</li>)}</ul>
                <div className="flex items-center gap-2 text-[13px]">
                  <span className="nf-label">Eligibility</span>
                  {rewards.data.eligibility.eligible ? <span className="nf-chip" style={{ color: "var(--nf-good)" }}>Eligible</span> : <span className="nf-chip" style={{ color: "var(--nf-warn)" }}>Not yet eligible</span>}
                </div>
                {!rewards.data.eligibility.eligible && <ul className="m-0 grid list-disc gap-1 pl-5 text-[12.5px] text-mute">{rewards.data.eligibility.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
              </div>
              <div className="grid content-start gap-3">
                {([
                  ["Daily cap", rewards.data.caps.dailyUsed, rewards.data.caps.daily],
                  ["Weekly cap", rewards.data.caps.weeklyUsed, rewards.data.caps.weekly],
                  ["Season cap", rewards.data.caps.seasonUsed, rewards.data.caps.season],
                ] as const).map(([label, used, cap]) => (
                  <div key={label} className="grid gap-1">
                    <div className="flex justify-between text-[12.5px]"><span className="nf-label">{label}</span><span><CurrencyAmount amount={used} currency="NEBX" size={12} showIcon={false} /> / <CurrencyAmount amount={cap} currency="NEBX" size={12} showIcon={false} /></span></div>
                    <StatBar value={Number(BigInt(used) * 1000n / (BigInt(cap) || 1n))} max={1000} showValue={false} height={4} ghost={false} color="var(--nf-crypto)" />
                  </div>
                ))}
                <div className="flex items-center justify-between rounded-lg border border-line bg-black/25 p-3">
                  <span className="nf-label">Claimable now</span>
                  <CurrencyAmount amount={rewards.data.claimable} currency="NEBX" size={18} />
                </div>
                <Link to="/wallet" className="nf-link text-[13px]">Claim & withdraw in Wallet →</Link>
              </div>
            </div>
          )}
        </HoloPanel>
      </div>
    </div>
  );
}
