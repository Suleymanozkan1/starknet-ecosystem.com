import { useState } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { HoloPanel, NeonButton } from "@nebula/game-ui";
import type { AdminEconomyResponse, CircuitBreakerMode } from "@nebula/shared";
import { api } from "../lib/api.js";
import { errorMessage } from "../lib/http.js";
import { LAMPORTS, int, pct, sol } from "../lib/format.js";
import { Failure, Kpi, Loading, NoData, Page, ReasonDialog } from "../components/ui.js";
import { TrendChart } from "../components/Charts.js";
import { useAdminMe } from "../session.js";
import { can } from "../lib/api.js";

/* ============================================================ Overview */
export function OverviewPage() {
  const q = useQuery({ queryKey: ["overview"], queryFn: api.overview, refetchInterval: 15_000 });
  if (q.error) return <Page title="Overview"><Failure error={q.error} onRetry={() => void q.refetch()} /></Page>;
  if (!q.data) return <Page title="Overview"><Loading /></Page>;
  const o = q.data;
  const sumBy = (rec: Record<string, { amount: string; count: number }>, keys?: string[]) =>
    Object.entries(rec).filter(([k]) => !keys || keys.includes(k)).reduce((a, [, v]) => ({ amount: a.amount + BigInt(v.amount), count: a.count + v.count }), { amount: 0n, count: 0 });
  const dep = sumBy(o.deposits7d, ["CREDITED", "CONFIRMED"]);
  const wd = sumBy(o.withdrawals7d, ["COMPLETED"]);
  return (
    <Page title="Live operations" eyebrow="Overview">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi label="Online players" value={int(o.players.online)} sub={`DAU ${int(o.players.dau)} · MAU ${int(o.players.mau)}`} icon="user" />
        <Kpi label="Active rooms" value={int(o.rooms.active)} sub={`${int(o.rooms.clients)} connected clients`} icon="galaxy" />
        <Kpi label="Players" value={int(o.players.total)} sub={`+${int(o.players.new24h)} in 24h`} icon="friends" />
        <Kpi label="Open reports" value={int(o.reports.open)} icon="warning" tone={o.reports.open > 0 ? "warn" : undefined} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi label="Purchases 24h" value={Object.entries(o.revenue.purchases24h).map(([c, v]) => `${c === "SOL" || c === "NEBX" ? sol(v.amount, 3) : int(v.amount)} ${c}`).join(" · ") || "0"} sub={`${Object.values(o.revenue.purchases24h).reduce((a, v) => a + v.count, 0)} orders`} icon="shop" />
        <Kpi label="Deposits 7d (credited)" value={`${sol(dep.amount, 3)} SOL`} sub={`${dep.count} deposits`} icon="wallet" />
        <Kpi label="Withdrawals 7d (completed)" value={sol(wd.amount, 3)} sub={`${wd.count} payouts`} icon="crypto" />
        <Kpi label="Withdrawals pending" value={int(o.withdrawalsPending)} tone={o.withdrawalsPending > 0 ? "warn" : "good"} icon="clock" />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <HoloPanel title="Server health">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {([["DB latency", `${o.health.dbLatencyMs} ms`, o.health.dbLatencyMs > 100], ["Redis latency", `${o.health.redisLatencyMs} ms`, o.health.redisLatencyMs > 50], ["RSS", `${o.health.rssMb} MB`, false], ["Heap", `${o.health.heapMb} MB`, false], ["API uptime", `${Math.floor(o.health.uptimeSec / 3600)}h ${Math.floor((o.health.uptimeSec % 3600) / 60)}m`, false]] as const).map(([k, v, bad]) => (
              <div key={k}><div className="font-ui text-[10.5px] font-bold uppercase tracking-[0.16em] text-mute">{k}</div><div className="font-display text-[17px] font-bold" style={bad ? { color: "var(--nf-warn)" } : undefined}>{v}</div></div>
            ))}
          </div>
        </HoloPanel>
        <HoloPanel title={`Suspicious accounts (${o.suspicious.count})`}>
          {o.suspicious.top.length === 0 ? <NoData what="None flagged" /> : (
            <table className="nf-table"><thead><tr><th>User</th><th>Risk</th><th>Score</th><th>Status</th></tr></thead>
              <tbody>{o.suspicious.top.map((u) => <tr key={u.id}><td className="font-ui font-bold">{u.username}</td><td><span className="nf-chip" style={{ color: u.riskLevel === "CRITICAL" ? "var(--nf-bad)" : "var(--nf-warn)" }}>{u.riskLevel}</span></td><td className="tabular-nums">{u.riskScore}</td><td>{u.bannedAt ? "Banned" : "Active"}</td></tr>)}</tbody>
            </table>
          )}
        </HoloPanel>
      </div>
      <HoloPanel title={`Active rooms (${o.rooms.list.length})`}>
        {o.rooms.list.length === 0 ? <NoData what="No rooms reporting heartbeats" /> : (
          <div className="max-h-80 overflow-y-auto">
            <table className="nf-table"><thead><tr><th>Room</th><th>Map</th><th>Region</th><th className="text-right">Clients</th></tr></thead>
              <tbody>{o.rooms.list.map((r) => <tr key={r.id}><td className="nf-mono">{r.roomName} · {r.id.slice(0, 8)}</td><td>{r.mapId}</td><td>{r.region}</td><td className="text-right tabular-nums">{r.clients}/{r.maxClients}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </HoloPanel>
    </Page>
  );
}

/* ============================================================ Economy */
const toSol = (v: number): number => v / LAMPORTS;
const fmtSol = (v: number): string => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(3));

/** Economic parameters exposed in the editor → EconomyConfig dotted key. */
export const PARAMS: { name: string; key: string; kind: "ratio" | "lamports" | "number"; help: string }[] = [
  { name: "REWARD_BUDGET_RATIO", key: "rewardBudgetRatio", kind: "ratio", help: "Share of season revenue funding the reward pool." },
  { name: "MIN_TREASURY_RESERVE", key: "minTreasuryReserve", kind: "lamports", help: "Reserve floor that is never paid out." },
  { name: "DAILY_REWARD_CAP", key: "caps.daily", kind: "lamports", help: "Per-player daily reward cap." },
  { name: "SEASON_REWARD_CAP", key: "caps.season", kind: "lamports", help: "Per-player season reward cap." },
  { name: "WITHDRAWAL_FEE", key: "fees.withdrawalServicePercent", kind: "ratio", help: "Service fee on withdrawals." },
  { name: "MARKETPLACE_FEE", key: "fees.marketplace", kind: "ratio", help: "Seller fee on marketplace sales." },
  { name: "AUCTION_FEE", key: "fees.auctionSale", kind: "ratio", help: "Seller fee on auction sales." },
  { name: "MAX_DAILY_WITHDRAWAL", key: "withdrawal.dailyLimit", kind: "lamports", help: "Per-player daily withdrawal limit." },
  { name: "REWARD_EMISSION_RATE", key: "emission.baseRate", kind: "ratio", help: "Base emission rate (hard-capped by maxRewardRate)." },
  { name: "INFLATION_THRESHOLD", key: "inflation.dailyThreshold", kind: "ratio", help: "Daily credit inflation that triggers responses." },
  { name: "CIRCUIT_BREAKER_THRESHOLD", key: "circuitBreaker.reserveCoverageMin", kind: "number", help: "Min reserve coverage before REWARD_PAUSE trips." },
];

function getPath(o: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((a, k) => (a && typeof a === "object" ? (a as Record<string, unknown>)[k] : undefined), o);
}

function ParamEditor({ eco }: { eco: AdminEconomyResponse }) {
  const qc = useQueryClient();
  const me = useAdminMe();
  const editable = can(me.roles, "economyManage");
  const [edit, setEdit] = useState<{ name: string; key: string; kind: string; value: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: ({ key, value, reason }: { key: string; value: number; reason: string }) => api.setConfig(key, value, reason),
    onSuccess: async () => { setEdit(null); setErr(null); await qc.invalidateQueries({ queryKey: ["economy"] }); },
    onError: (e) => setErr(errorMessage(e)),
  });
  const display = (kind: string, v: unknown): string => (typeof v !== "number" ? String(v ?? "—") : kind === "ratio" ? pct(v, 2) : kind === "lamports" ? `${sol(v)} (lamports ${int(v)})` : String(v));
  return (
    <HoloPanel title="Economic parameters" actions={!editable ? <span className="nf-chip">Read-only for your role</span> : undefined}>
      <table className="nf-table">
        <thead><tr><th>Parameter</th><th>Config key</th><th className="text-right">Current</th><th /></tr></thead>
        <tbody>{PARAMS.map((p) => {
          const v = getPath(eco.config, p.key);
          return (
            <tr key={p.name}>
              <td><div className="font-ui font-bold">{p.name}</div><div className="text-[11.5px] text-mute">{p.help}</div></td>
              <td className="nf-mono text-dim">{p.key}</td>
              <td className="text-right tabular-nums">{display(p.kind, v)}</td>
              <td className="text-right">{editable && typeof v === "number" && <NeonButton size="sm" onClick={() => setEdit({ name: p.name, key: p.key, kind: p.kind, value: String(v) })}>Edit</NeonButton>}</td>
            </tr>
          );
        })}</tbody>
      </table>
      <ReasonDialog open={Boolean(edit)} title={`Change ${edit?.name ?? ""}`} busy={m.isPending} onClose={() => { setEdit(null); setErr(null); }}
        onConfirm={(reason) => edit && Number.isFinite(Number(edit.value)) && m.mutate({ key: edit.key, value: Number(edit.value), reason })}>
        {edit && (
          <>
            <label className="grid gap-1.5"><span className="font-ui text-[11px] font-bold uppercase tracking-[0.18em] text-mute">New value ({edit.kind === "ratio" ? "0–1 ratio" : edit.kind === "lamports" ? "lamports" : "number"})</span>
              <input className="nf-input" inputMode="decimal" value={edit.value} onChange={(e) => setEdit({ ...edit, value: e.target.value })} /></label>
            <div className="text-[12px] text-mute">The server validates the whole configuration (cap ordering, ranges) before applying and writes an audit entry.</div>
            {err && <div className="text-[12.5px] text-bad">{err}</div>}
          </>
        )}
      </ReasonDialog>
    </HoloPanel>
  );
}

const BREAKERS: CircuitBreakerMode[] = ["REWARD_PAUSE", "MARKET_PAUSE", "WITHDRAWAL_REVIEW", "EVENT_PAUSE"];

function BreakerPanel({ eco }: { eco: AdminEconomyResponse }) {
  const qc = useQueryClient();
  const me = useAdminMe();
  const editable = can(me.roles, "economyManage");
  const [target, setTarget] = useState<{ mode: CircuitBreakerMode; active: boolean } | null>(null);
  const [rateOpen, setRateOpen] = useState(false);
  const [rate, setRate] = useState(String(eco.rewardRate));
  const [err, setErr] = useState<string | null>(null);
  const inv = async (): Promise<void> => { await qc.invalidateQueries({ queryKey: ["economy"] }); };
  const br = useMutation({ mutationFn: (v: { mode: CircuitBreakerMode; active: boolean; reason: string }) => api.setBreaker(v.mode, v.active, v.reason), onSuccess: async () => { setTarget(null); await inv(); }, onError: (e) => setErr(errorMessage(e)) });
  const rr = useMutation({ mutationFn: (v: { rate: number; reason: string }) => api.setRewardRate(v.rate, v.reason), onSuccess: async () => { setRateOpen(false); await inv(); }, onError: (e) => setErr(errorMessage(e)) });
  return (
    <HoloPanel title="Circuit breakers & reward rate">
      <div className="grid gap-2">
        {BREAKERS.map((b) => {
          const on = eco.activeBreakers.includes(b);
          return (
            <div key={b} className="flex items-center justify-between gap-2 rounded-lg border border-line px-3 py-2">
              <span className="font-ui font-bold tracking-[0.06em]">{b.replace(/_/g, " ")}</span>
              <span className="nf-chip" style={{ color: on ? "var(--nf-bad)" : "var(--nf-good)" }}>{on ? "Tripped" : "Normal"}</span>
              {editable && <NeonButton size="sm" variant={on ? "success" : "danger"} onClick={() => { setErr(null); setTarget({ mode: b, active: !on }); }}>{on ? "Reset" : "Trip"}</NeonButton>}
            </div>
          );
        })}
        <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-line px-3 py-2">
          <span className="font-ui font-bold">Current reward rate</span>
          <span className="font-display tabular-nums">{pct(eco.rewardRate, 2)}</span>
          {editable && <NeonButton size="sm" onClick={() => { setErr(null); setRateOpen(true); }}>Override</NeonButton>}
        </div>
      </div>
      <ReasonDialog open={Boolean(target)} danger={target?.active} title={`${target?.active ? "Trip" : "Reset"} ${target?.mode ?? ""}`} busy={br.isPending} onClose={() => setTarget(null)} onConfirm={(reason) => target && br.mutate({ ...target, reason })}>
        {err && <div className="text-[12.5px] text-bad">{err}</div>}
      </ReasonDialog>
      <ReasonDialog open={rateOpen} title="Override reward rate" busy={rr.isPending} onClose={() => setRateOpen(false)} onConfirm={(reason) => rr.mutate({ rate: Number(rate), reason })}>
        <label className="grid gap-1.5"><span className="font-ui text-[11px] font-bold uppercase tracking-[0.18em] text-mute">Rate (0–1, server rejects values above the hard cap)</span><input className="nf-input" value={rate} onChange={(e) => setRate(e.target.value)} /></label>
        {err && <div className="text-[12.5px] text-bad">{err}</div>}
      </ReasonDialog>
    </HoloPanel>
  );
}

/** Rebase a series to 100 at its first non-zero point so two unit-different measures share one axis. */
function indexed(series: AdminEconomyResponse["series"], a: keyof AdminEconomyResponse["series"][number], b: keyof AdminEconomyResponse["series"][number]) {
  const base = (k: typeof a) => series.map((p) => Number(p[k])).find((v) => v > 0) ?? 0;
  const ba = base(a);
  const bb = base(b);
  return series.map((p) => ({ date: p.date, a: ba ? (Number(p[a]) / ba) * 100 : 0, b: bb ? (Number(p[b]) / bb) * 100 : 0 }));
}

export function EconomyPage() {
  const q = useQuery({ queryKey: ["economy"], queryFn: api.economy, refetchInterval: 30_000 });
  const run = useMutation({ mutationFn: api.runController });
  if (q.error) return <Page title="Economy"><Failure error={q.error} onRetry={() => void q.refetch()} /></Page>;
  if (!q.data) return <Page title="Economy"><Loading /></Page>;
  const e = q.data;
  const s = e.series.map((p) => ({ ...p, revenueSol: toSol(p.revenue), rewardsSol: toSol(p.rewards), depositsSol: toSol(p.deposits), withdrawalsSol: toSol(p.withdrawals), liabilitySol: toSol(p.liability), treasurySol: toSol(p.treasury) }));
  const tot = (k: keyof (typeof e.series)[number]) => e.series.reduce((a, p) => a + Number(p[k]), 0);
  const healthTone = e.treasuryHealth === "HEALTHY" ? "good" : e.treasuryHealth === "CRITICAL" || e.treasuryHealth === "WARNING" ? "bad" : "warn";
  const treasuryTotal = e.treasury.filter((t) => t.asset === "NEBX" || t.asset === "SOL").reduce((a, t) => a + BigInt(t.balance), 0n);
  return (
    <Page title="Economy" eyebrow="Treasury & rewards" actions={<NeonButton size="sm" loading={run.isPending} onClick={() => run.mutate()}>Run controller now</NeonButton>}>
      {run.error && <div className="text-[13px] text-bad">{errorMessage(run.error)}</div>}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi label="Treasury health" value={e.treasuryHealth} sub={`Reserve coverage ${e.reserveCoverage >= 999 ? "∞" : e.reserveCoverage.toFixed(2)}×`} tone={healthTone} icon="shield" />
        <Kpi label="Treasury (system accts)" value={`${sol(treasuryTotal, 2)}`} sub={`Available reserve ${sol(e.availableReserve, 2)}`} icon="crypto" />
        <Kpi label="Outstanding liability" value={sol(e.outstandingLiability, 2)} sub={`Projected 30d rewards ${sol(e.projected30dRewardCost, 2)}`} icon="warning" />
        <Kpi label="Reward rate" value={pct(e.rewardRate, 2)} sub={e.activeBreakers.length ? `Breakers: ${e.activeBreakers.join(", ")}` : "No breakers tripped"} tone={e.activeBreakers.length ? "bad" : undefined} icon="zap" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi label="Revenue 30d (gross)" value={sol(e.revenue.gross, 3)} sub={`Net of rewards ${sol(e.revenue.net, 3)}`} icon="shop" />
        <Kpi label="Rewards paid 30d" value={sol(tot("rewards"), 3)} icon="trophy" />
        <Kpi label="Deposits / withdrawals 30d" value={`${sol(tot("deposits"), 2)} / ${sol(tot("withdrawals"), 2)}`} icon="wallet" />
        <Kpi label="Credit inflation" value={`${pct(e.inflation.daily, 2)} / d`} sub={`7d ${pct(e.inflation.weekly, 2)} · 30d ${pct(e.inflation.d30, 2)}`} icon="energy" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi label="Credit supply (stored)" value={int(e.supply.stored)} sub={`30d issued ${int(e.supply.issued)} · burned ${int(e.supply.burned)}`} />
        <Kpi label="Credits spent 30d" value={int(e.supply.spent)} />
        <Kpi label="Reward asset withdrawn 30d" value={sol(e.supply.withdrawn, 3)} />
        <Kpi label="Reward claim rate" value={<NoData what="No data" />} sub="Claimed ÷ granted needs a reward-status aggregate (not exposed yet)" />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <TrendChart title="Revenue vs rewards (SOL)" data={s} series={[{ key: "revenueSol", label: "Revenue", format: fmtSol }, { key: "rewardsSol", label: "Rewards", format: fmtSol }]} />
        <TrendChart title="Deposits vs withdrawals (SOL)" data={s} series={[{ key: "depositsSol", label: "Deposits", format: fmtSol }, { key: "withdrawalsSol", label: "Withdrawals", format: fmtSol }]} />
        <TrendChart title="Credit supply: issued vs burned" data={s} series={[{ key: "issued", label: "Issued" }, { key: "burned", label: "Burned (sinks)" }]} />
        <TrendChart title="Treasury vs liability (SOL)" data={s} series={[{ key: "treasurySol", label: "Available reserve", format: fmtSol }, { key: "liabilitySol", label: "Outstanding liability", format: fmtSol }]} />
        <TrendChart title="DAU vs rewards (indexed, first day = 100)" data={indexed(e.series, "dau", "rewards")} series={[{ key: "a", label: "DAU", format: (v) => v.toFixed(0) }, { key: "b", label: "Rewards", format: (v) => v.toFixed(0) }]} note="Different units are rebased to a common index so both share one axis." />
        <HoloPanel title="Revenue by source (30d)">
          {Object.keys(e.revenue.bySource).length === 0 ? <NoData /> : (
            <table className="nf-table"><tbody>{Object.entries(e.revenue.bySource).sort((a, b) => (BigInt(b[1]) > BigInt(a[1]) ? 1 : -1)).map(([k, v]) => <tr key={k}><td>{k.replace(/_/g, " ")}</td><td className="text-right tabular-nums">{sol(v, 4)}</td></tr>)}</tbody></table>
          )}
        </HoloPanel>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <ParamEditor eco={e} />
        <BreakerPanel eco={e} />
      </div>
      <HoloPanel title="System accounts">
        <table className="nf-table"><thead><tr><th>Account</th><th>Asset</th><th className="text-right">Balance</th></tr></thead>
          <tbody>{e.treasury.map((t) => <tr key={`${t.account}:${t.asset}`}><td>{t.account}</td><td>{t.asset}</td><td className="text-right tabular-nums">{t.asset === "CREDITS" || t.asset === "GEMS" ? int(t.balance) : sol(t.balance)}</td></tr>)}</tbody>
        </table>
      </HoloPanel>
    </Page>
  );
}

/* ============================================================ Owner profitability */
export function ProfitabilityPage() {
  const eco = useQuery({ queryKey: ["economy"], queryFn: api.economy });
  const ov = useQuery({ queryKey: ["overview"], queryFn: api.overview });
  if (eco.error) return <Page title="Owner profitability"><Failure error={eco.error} /></Page>;
  if (!eco.data || !ov.data) return <Page title="Owner profitability"><Loading /></Page>;
  const e = eco.data;
  const by = e.revenue.bySource;
  const gross = BigInt(e.revenue.gross);
  const rewardExpense = BigInt(e.series.reduce((a, p) => a + p.rewards, 0));
  const net = gross - rewardExpense;
  const src = (...keys: string[]): bigint | null => {
    const found = Object.entries(by).filter(([k]) => keys.some((x) => k.toUpperCase().includes(x)));
    return found.length ? found.reduce((a, [, v]) => a + BigInt(v), 0n) : null;
  };
  const payingOrders7d = Object.values(ov.data.revenue.purchases7d).reduce((a, v) => a + v.count, 0);
  const mau = ov.data.players.mau;
  const margin = gross > 0n ? Number((net * 10000n) / gross) / 10000 : null;
  const rows: [string, string | null, string?][] = [
    ["Gross revenue (30d)", sol(gross)],
    ["Reward expense (30d)", sol(rewardExpense)],
    ["Net revenue after rewards", sol(net)],
    ["Marketplace revenue", src("MARKETPLACE") === null ? null : sol(src("MARKETPLACE"))],
    ["Auction revenue", src("AUCTION") === null ? null : sol(src("AUCTION"))],
    ["Premium / subscription revenue", src("PREMIUM", "SUBSCRIPTION") === null ? null : sol(src("PREMIUM", "SUBSCRIPTION"))],
    ["Fee revenue (withdrawal/trade)", src("FEE") === null ? null : sol(src("FEE"))],
    ["Cosmetic revenue", null, "Purchases are not split by product category in the ledger yet"],
    ["Battle pass revenue", null, "Not separated from premium revenue"],
    ["Tournament revenue", null, "No tournament entry-fee flow exists"],
    ["Blockchain fees", null, "Network fees are paid by players / treasury on-chain; no ledger account"],
    ["Infrastructure cost", null, "Not tracked in the platform (enter from cloud billing)"],
    ["Payment processing costs", null, "No fiat processor integrated"],
    ["Refunds", null, "No refund aggregate endpoint"],
    ["Chargebacks", null, "No fiat processor integrated"],
    ["Net operating margin (after rewards only)", margin === null ? null : pct(margin, 1), "Excludes infra/payment costs (not tracked)"],
    ["Reward cost ÷ revenue", gross > 0n ? pct(Number((rewardExpense * 10000n) / gross) / 10000, 1) : null],
    ["Revenue per MAU (30d)", mau > 0 ? sol(gross / BigInt(mau)) : null],
    ["Paying orders (7d)", String(payingOrders7d)],
    ["ARPPU", null, "Needs distinct paying-user count (overview reports order counts only)"],
    ["Conversion rate", null, "Needs distinct paying-user count"],
  ];
  return (
    <Page title="Owner profitability" eyebrow="Finance">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi label="Gross revenue 30d" value={sol(gross, 3)} icon="shop" />
        <Kpi label="Reward expense 30d" value={sol(rewardExpense, 3)} icon="trophy" />
        <Kpi label="Net after rewards" value={sol(net, 3)} tone={net >= 0n ? "good" : "bad"} icon="crypto" />
        <Kpi label="Reward cost / revenue" value={gross > 0n ? pct(Number((rewardExpense * 10000n) / gross) / 10000, 1) : <NoData />} icon="leaderboard" />
      </div>
      <HoloPanel title="P&L lines">
        <table className="nf-table">
          <thead><tr><th>Metric</th><th className="text-right">Value</th><th>Note</th></tr></thead>
          <tbody>{rows.map(([k, v, note]) => <tr key={k}><td>{k}</td><td className="text-right tabular-nums">{v ?? <NoData />}</td><td className="text-[12px] text-mute">{note ?? ""}</td></tr>)}</tbody>
        </table>
        <div className="mt-3 text-[12px] text-mute">All values are computed from /api/admin/economy (ledger flows, 30 days, SOL/NEBX lamports) and /api/admin/overview. Nothing is estimated; unavailable metrics are marked “No data”.</div>
      </HoloPanel>
    </Page>
  );
}
