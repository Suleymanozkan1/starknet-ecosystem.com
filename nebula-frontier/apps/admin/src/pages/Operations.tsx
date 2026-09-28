import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HoloPanel, NeonButton, Tabs } from "@nebula/game-ui";
import type { AdminRole } from "@nebula/shared";
import { api, can } from "../lib/api.js";
import type { AdminUserRow, AdminWithdrawal } from "../lib/api.js";
import { errorMessage } from "../lib/http.js";
import { short, sol, when } from "../lib/format.js";
import { Failure, Loading, NoData, Page, ReasonDialog } from "../components/ui.js";
import { useAdminMe } from "../session.js";

const STATUS_COLOR: Record<string, string> = { COMPLETED: "var(--nf-good)", PENDING: "var(--nf-warn)", PENDING_REVIEW: "var(--nf-warn)", PROCESSING: "var(--nf-accent)", FAILED: "var(--nf-bad)", CANCELLED: "var(--nf-text-mute)" };
const RISK_COLOR: Record<string, string> = { LOW: "var(--nf-good)", MEDIUM: "var(--nf-warn)", HIGH: "#f97316", CRITICAL: "var(--nf-bad)" };

/* ============================================================ Withdrawals review */
export function WithdrawalsPage() {
  const qc = useQueryClient();
  const me = useAdminMe();
  const [status, setStatus] = useState("PENDING_REVIEW");
  const q = useQuery({ queryKey: ["withdrawals", status], queryFn: () => api.withdrawals(status === "ALL" ? undefined : status), refetchInterval: 15_000 });
  const [target, setTarget] = useState<{ w: AdminWithdrawal; approve: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: (v: { id: string; approve: boolean; reason: string }) => api.reviewWithdrawal(v.id, v.approve, v.reason),
    onSuccess: async () => { setTarget(null); await qc.invalidateQueries({ queryKey: ["withdrawals"] }); },
    onError: (e) => setErr(errorMessage(e)),
  });
  const canReview = can(me.roles, "economyManage");
  return (
    <Page title="Withdrawals" eyebrow="Blockchain">
      <Tabs value={status} onChange={setStatus} items={["PENDING_REVIEW", "PENDING", "PROCESSING", "COMPLETED", "FAILED", "CANCELLED", "ALL"].map((k) => ({ key: k, label: k.replace("_", " ") }))} />
      {q.error ? <Failure error={q.error} onRetry={() => void q.refetch()} /> : !q.data ? <Loading /> : q.data.withdrawals.length === 0 ? <HoloPanel><NoData what="Queue empty" /></HoloPanel> : (
        <HoloPanel padded={false}>
          <div className="overflow-x-auto">
            <table className="nf-table">
              <thead><tr><th>Player</th><th>Risk</th><th className="text-right">Requested</th><th className="text-right">Fees</th><th className="text-right">Final</th><th>Address</th><th>Status</th><th>Chain</th><th>Flags</th><th>Created</th><th /></tr></thead>
              <tbody>{q.data.withdrawals.map((w) => (
                <tr key={w.id}>
                  <td className="font-ui font-bold">{w.username}</td>
                  <td><span className="nf-chip" style={{ color: RISK_COLOR[w.userRiskLevel] }}>{w.userRiskLevel} · {w.userRiskScore}</span></td>
                  <td className="text-right tabular-nums">{sol(w.requested)}</td>
                  <td className="text-right tabular-nums text-dim">{sol(BigInt(w.serviceFee) + BigInt(w.networkFee))}</td>
                  <td className="text-right tabular-nums font-bold">{sol(w.final)}</td>
                  <td className="nf-mono">{short(w.address)}</td>
                  <td><span className="nf-chip" style={{ color: STATUS_COLOR[w.status] }}>{w.status}</span>{w.failureReason && <div className="text-[11px] text-bad">{w.failureReason}</div>}</td>
                  <td className="text-[12px]">{w.chainState}{w.attempts ? ` · ${w.attempts} tries` : ""}{w.signature && <div>{w.explorerUrl ? <a className="nf-mono text-accent" href={w.explorerUrl} target="_blank" rel="noreferrer noopener">{short(w.signature)}</a> : short(w.signature)}</div>}</td>
                  <td className="text-[11.5px] text-warn">{w.riskFlags.join(", ") || "—"}</td>
                  <td className="text-[12px] text-dim">{when(w.createdAt)}</td>
                  <td className="whitespace-nowrap text-right">{canReview && w.status === "PENDING_REVIEW" && (
                    <span className="inline-flex gap-1.5"><NeonButton size="sm" variant="success" onClick={() => { setErr(null); setTarget({ w, approve: true }); }}>Approve</NeonButton><NeonButton size="sm" variant="danger" onClick={() => { setErr(null); setTarget({ w, approve: false }); }}>Reject</NeonButton></span>
                  )}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </HoloPanel>
      )}
      <ReasonDialog open={Boolean(target)} danger={!target?.approve} title={`${target?.approve ? "Approve" : "Reject"} withdrawal`} busy={m.isPending} onClose={() => setTarget(null)} onConfirm={(reason) => target && m.mutate({ id: target.w.id, approve: target.approve, reason })}>
        {target && <div className="text-[13px] text-dim">{target.w.username} · final {sol(target.w.final)} → <span className="nf-mono">{target.w.address}</span>. {target.approve ? "Approving enqueues it for the blockchain service." : "Rejecting refunds the full requested amount to the player's balance."}</div>}
        {err && <div className="text-[12.5px] text-bad">{err}</div>}
      </ReasonDialog>
    </Page>
  );
}

/* ============================================================ Reward review */
export function RewardsPage() {
  const qc = useQueryClient();
  const me = useAdminMe();
  const q = useQuery({ queryKey: ["rewards-review"], queryFn: api.rewardsReview });
  const [target, setTarget] = useState<{ id: string; approve: boolean } | null>(null);
  const m = useMutation({ mutationFn: (v: { id: string; approve: boolean; reason: string }) => api.reviewReward(v.id, v.approve, v.reason), onSuccess: async () => { setTarget(null); await qc.invalidateQueries({ queryKey: ["rewards-review"] }); } });
  return (
    <Page title="Reward review" eyebrow="Rewards">
      {q.error ? <Failure error={q.error} /> : !q.data ? <Loading /> : q.data.rewards.length === 0 ? <HoloPanel><NoData what="No rewards awaiting review" /></HoloPanel> : (
        <HoloPanel padded={false}>
          <table className="nf-table">
            <thead><tr><th>Player</th><th>Risk</th><th>Source</th><th>Reason</th><th className="text-right">Amount</th><th>Created</th><th /></tr></thead>
            <tbody>{q.data.rewards.map((r) => (
              <tr key={r.id}>
                <td className="font-ui font-bold">{r.username}</td><td><span className="nf-chip" style={{ color: RISK_COLOR[r.riskLevel] }}>{r.riskLevel}</span></td>
                <td>{r.source}</td><td className="text-[12.5px] text-dim">{r.reason}</td><td className="text-right tabular-nums">{sol(r.amount)}</td><td className="text-[12px] text-dim">{when(r.createdAt)}</td>
                <td className="text-right">{can(me.roles, "economyManage") && <span className="inline-flex gap-1.5"><NeonButton size="sm" variant="success" onClick={() => setTarget({ id: r.id, approve: true })}>Approve</NeonButton><NeonButton size="sm" variant="danger" onClick={() => setTarget({ id: r.id, approve: false })}>Reject</NeonButton></span>}</td>
              </tr>
            ))}</tbody>
          </table>
        </HoloPanel>
      )}
      {m.error && <div className="text-bad">{errorMessage(m.error)}</div>}
      <ReasonDialog open={Boolean(target)} title={target?.approve ? "Approve reward" : "Reject reward"} danger={!target?.approve} busy={m.isPending} onClose={() => setTarget(null)} onConfirm={(reason) => target && m.mutate({ ...target, reason })} />
    </Page>
  );
}

/* ============================================================ Treasury reconciliation */
export function TreasuryPage() {
  const q = useQuery({ queryKey: ["treasury"], queryFn: api.treasury });
  if (q.error) return <Page title="Treasury"><Failure error={q.error} /></Page>;
  if (!q.data) return <Page title="Treasury"><Loading /></Page>;
  const d = q.data as {
    onChain: { address: string; lamports: string | null; explorerUrl: string | null; error?: string };
    ledgerExpectedOnChain: string; reconciliationDelta: string | null;
    treasury: Record<string, unknown>; budget: Record<string, unknown>;
    systemAccounts: { type: string; asset: string; balance: string }[];
    ledgerIntegrity: Record<string, unknown>;
  };
  const delta = d.reconciliationDelta === null ? null : BigInt(d.reconciliationDelta);
  return (
    <Page title="Treasury reconciliation" eyebrow="Blockchain">
      <div className="grid gap-3 sm:grid-cols-3">
        <HoloPanel title="On-chain treasury">
          <div className="nf-mono break-all text-[12px]">{d.onChain.address || "Not configured"}</div>
          <div className="kpi-value mt-2">{d.onChain.lamports === null ? <NoData what={d.onChain.error ?? "Unavailable"} /> : sol(d.onChain.lamports)}</div>
          {d.onChain.explorerUrl && <a className="text-[12px] text-accent" href={d.onChain.explorerUrl} target="_blank" rel="noreferrer noopener">Open in explorer</a>}
        </HoloPanel>
        <HoloPanel title="Ledger expects"><div className="kpi-value">{sol(d.ledgerExpectedOnChain)}</div></HoloPanel>
        <HoloPanel title="Delta" accent={delta === null ? undefined : delta === 0n ? "var(--nf-good)" : "var(--nf-warn)"}><div className="kpi-value" style={{ color: delta === null ? undefined : delta === 0n ? "var(--nf-good)" : "var(--nf-warn)" }}>{delta === null ? <NoData /> : sol(delta)}</div><div className="text-[12px] text-mute">Positive = unallocated on-chain funds (e.g. network fee float).</div></HoloPanel>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <HoloPanel title="System accounts"><table className="nf-table"><tbody>{d.systemAccounts.map((a) => <tr key={`${a.type}${a.asset}`}><td>{a.type}</td><td>{a.asset}</td><td className="text-right tabular-nums">{sol(a.balance)}</td></tr>)}</tbody></table></HoloPanel>
        <HoloPanel title="Ledger integrity & budget"><pre className="nf-mono m-0 max-h-80 overflow-auto whitespace-pre-wrap text-dim">{JSON.stringify({ integrity: d.ledgerIntegrity, budget: d.budget, treasury: d.treasury }, null, 2)}</pre></HoloPanel>
      </div>
    </Page>
  );
}

/* ============================================================ Users */
const ROLES: AdminRole[] = ["SUPER_ADMIN", "ADMIN", "MODERATOR", "SUPPORT", "ECONOMY_MANAGER"];

function UserDetail({ u, onClose }: { u: AdminUserRow; onClose: () => void }) {
  const qc = useQueryClient();
  const me = useAdminMe();
  const q = useQuery({ queryKey: ["user", u.id], queryFn: () => api.user(u.id) });
  const [action, setAction] = useState<"ban" | "unban" | "mute" | "unmute" | "roles" | null>(null);
  const [minutes, setMinutes] = useState(60);
  const [roles, setRoles] = useState<AdminRole[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: async (reason: string) => {
      if (action === "ban" || action === "unban") return api.ban(u.id, reason, action === "ban");
      if (action === "mute") return api.mute(u.id, minutes, reason);
      if (action === "unmute") return api.unmute(u.id, reason);
      return api.setRoles(u.id, roles, reason);
    },
    onSuccess: async () => { setAction(null); await qc.invalidateQueries({ queryKey: ["users"] }); await qc.invalidateQueries({ queryKey: ["user", u.id] }); },
    onError: (e) => setErr(errorMessage(e)),
  });
  const detail = q.data?.user as { wallets?: { address: string }[]; adminUser?: { roles: AdminRole[] } | null; devices?: unknown[]; riskSignals?: { type: string; score: number; createdAt: string }[] } | undefined;
  return (
    <HoloPanel title={`${u.username}`} actions={<NeonButton size="sm" variant="ghost" onClick={onClose}>Close</NeonButton>}>
      <div className="grid gap-3 text-[13px]">
        <div className="flex flex-wrap gap-2">
          {can(me.roles, "usersBan") && (u.bannedAt ? <NeonButton size="sm" variant="success" onClick={() => setAction("unban")}>Unban</NeonButton> : <NeonButton size="sm" variant="danger" onClick={() => setAction("ban")}>Ban</NeonButton>)}
          {can(me.roles, "usersBan") && (u.mutedUntil && new Date(u.mutedUntil).getTime() > Date.now() ? <NeonButton size="sm" onClick={() => setAction("unmute")}>Unmute</NeonButton> : <NeonButton size="sm" onClick={() => setAction("mute")}>Mute</NeonButton>)}
          {can(me.roles, "rolesManage") && <NeonButton size="sm" onClick={() => { setRoles(detail?.adminUser?.roles ?? []); setAction("roles"); }}>Admin roles</NeonButton>}
        </div>
        {q.isLoading ? <Loading /> : q.error ? <Failure error={q.error} /> : (
          <>
            <div className="grid grid-cols-2 gap-2">
              <div><span className="text-mute">Email</span><div>{u.email ?? "—"}</div></div>
              <div><span className="text-mute">Wallets</span><div className="nf-mono">{detail?.wallets?.map((w) => short(w.address)).join(", ") || "—"}</div></div>
              <div><span className="text-mute">Roles</span><div>{detail?.adminUser?.roles.join(", ") || "Player"}</div></div>
              <div><span className="text-mute">Devices</span><div>{detail?.devices?.length ?? 0}</div></div>
            </div>
            <div><div className="text-mute">Balances</div><pre className="nf-mono m-0 whitespace-pre-wrap text-dim">{JSON.stringify(q.data?.balances, null, 1)}</pre></div>
            <div><div className="text-mute">Recent risk signals</div>{(detail?.riskSignals ?? []).slice(0, 8).map((s, i) => <div key={i} className="text-[12px]">{s.type} · {s.score} · {when(s.createdAt)}</div>)}</div>
          </>
        )}
      </div>
      <ReasonDialog open={Boolean(action)} danger={action === "ban"} title={action ? `${action[0]!.toUpperCase()}${action.slice(1)} ${u.username}` : ""} busy={m.isPending} onClose={() => { setAction(null); setErr(null); }} onConfirm={(r) => m.mutate(r)}>
        {action === "mute" && <label className="grid gap-1.5"><span className="text-[12px] text-mute">Minutes</span><input className="nf-input" type="number" min={1} max={43200} value={minutes} onChange={(e) => setMinutes(Number(e.target.value) || 1)} /></label>}
        {action === "roles" && <div className="flex flex-wrap gap-2">{ROLES.map((r) => <label key={r} className="nf-chip cursor-pointer"><input type="checkbox" checked={roles.includes(r)} onChange={(e) => setRoles(e.target.checked ? [...roles, r] : roles.filter((x) => x !== r))} />{r}</label>)}</div>}
        {action === "ban" && <div className="text-[12.5px] text-dim">Bans revoke all sessions immediately. Bans are always a human decision.</div>}
        {err && <div className="text-[12.5px] text-bad">{err}</div>}
      </ReasonDialog>
    </HoloPanel>
  );
}

export function UsersPage() {
  const [search, setSearch] = useState("");
  const [risk, setRisk] = useState("");
  const [sel, setSel] = useState<AdminUserRow | null>(null);
  const q = useQuery({ queryKey: ["users", search, risk], queryFn: () => api.users({ ...(search ? { q: search } : {}), ...(risk ? { riskLevel: risk } : {}) }) });
  return (
    <Page title="Users" eyebrow="Players">
      <div className="flex flex-wrap gap-2">
        <input className="nf-input max-w-sm" placeholder="Username, email, id or wallet" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className="nf-input w-auto" value={risk} onChange={(e) => setRisk(e.target.value)}><option value="">Any risk</option>{["LOW", "MEDIUM", "HIGH", "CRITICAL"].map((r) => <option key={r}>{r}</option>)}</select>
      </div>
      <div className="grid gap-4 xl:grid-cols-[1fr_420px]">
        {q.error ? <Failure error={q.error} /> : !q.data ? <Loading /> : (
          <HoloPanel padded={false}>
            <div className="overflow-x-auto">
              <table className="nf-table">
                <thead><tr><th>User</th><th>Level</th><th>Risk</th><th>Status</th><th>Joined</th><th>Last login</th></tr></thead>
                <tbody>{q.data.users.map((u) => (
                  <tr key={u.id} className="cursor-pointer" onClick={() => setSel(u)}>
                    <td><div className="font-ui font-bold">{u.username}</div><div className="text-[11px] text-mute">{u.email ?? u.id}</div></td>
                    <td>{u.level}</td>
                    <td><span className="nf-chip" style={{ color: RISK_COLOR[u.riskLevel] }}>{u.riskLevel} · {u.riskScore}</span></td>
                    <td>{u.bannedAt ? <span className="text-bad">Banned</span> : u.mutedUntil && new Date(u.mutedUntil).getTime() > Date.now() ? <span className="text-warn">Muted</span> : "Active"}</td>
                    <td className="text-[12px] text-dim">{when(u.createdAt)}</td><td className="text-[12px] text-dim">{when(u.lastLoginAt)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </HoloPanel>
        )}
        {sel && <UserDetail key={sel.id} u={sel} onClose={() => setSel(null)} />}
      </div>
    </Page>
  );
}

/* ============================================================ Suspicious accounts / risk */
export function RiskPage() {
  const qc = useQueryClient();
  const me = useAdminMe();
  const q = useQuery({ queryKey: ["risk"], queryFn: api.risk, refetchInterval: 30_000 });
  const [target, setTarget] = useState<{ id: string; decision: "CLEAR" | "CONFIRM" } | null>(null);
  const [level, setLevel] = useState("");
  const m = useMutation({ mutationFn: (v: { id: string; decision: "CLEAR" | "CONFIRM"; reason: string }) => api.reviewRisk(v.id, v.decision, v.reason, level || undefined), onSuccess: async () => { setTarget(null); await qc.invalidateQueries({ queryKey: ["risk"] }); } });
  return (
    <Page title="Suspicious accounts" eyebrow="Anti-cheat & fraud">
      {q.error ? <Failure error={q.error} /> : !q.data ? <Loading /> : (
        <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
          <HoloPanel title={`Unreviewed signals (${q.data.signals.length})`} padded={false}>
            <div className="max-h-[70vh] overflow-auto">
              <table className="nf-table">
                <thead><tr><th>User</th><th>Type</th><th>Score</th><th>Source</th><th>Details</th><th>When</th><th /></tr></thead>
                <tbody>{q.data.signals.map((s) => (
                  <tr key={s.id}>
                    <td className="font-ui font-bold">{s.user.username}<div><span className="nf-chip" style={{ color: RISK_COLOR[s.user.riskLevel] }}>{s.user.riskLevel}</span></div></td>
                    <td>{s.type}</td><td className="tabular-nums">{s.score}</td><td className="text-dim">{s.source}</td>
                    <td className="nf-mono max-w-[260px] truncate text-dim" title={JSON.stringify(s.details)}>{JSON.stringify(s.details)}</td>
                    <td className="text-[12px] text-dim">{when(s.createdAt)}</td>
                    <td className="whitespace-nowrap">{can(me.roles, "riskReview") && <span className="inline-flex gap-1.5"><NeonButton size="sm" onClick={() => setTarget({ id: s.id, decision: "CLEAR" })}>Clear</NeonButton><NeonButton size="sm" variant="danger" onClick={() => setTarget({ id: s.id, decision: "CONFIRM" })}>Confirm</NeonButton></span>}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </HoloPanel>
          <HoloPanel title="High-risk users">
            {q.data.users.length === 0 ? <NoData what="None" /> : q.data.users.map((u) => <div key={u.id} className="flex justify-between border-b border-white/5 py-1.5 text-[13px]"><span className="font-ui font-bold">{u.username}</span><span style={{ color: RISK_COLOR[u.riskLevel] }}>{u.riskLevel} · {u.riskScore}</span></div>)}
            <div className="mt-2 text-[11.5px] text-mute">Risk levels only trigger manual review; bans are a human decision.</div>
          </HoloPanel>
        </div>
      )}
      <ReasonDialog open={Boolean(target)} title={target?.decision === "CONFIRM" ? "Confirm signal" : "Clear signal"} busy={m.isPending} onClose={() => setTarget(null)} onConfirm={(reason) => target && m.mutate({ ...target, reason })}>
        <label className="grid gap-1.5"><span className="text-[12px] text-mute">Set risk level (optional)</span><select className="nf-input" value={level} onChange={(e) => setLevel(e.target.value)}><option value="">Unchanged</option>{["LOW", "MEDIUM", "HIGH", "CRITICAL"].map((r) => <option key={r}>{r}</option>)}</select></label>
      </ReasonDialog>
    </Page>
  );
}

/* ============================================================ Reports */
export function ReportsPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["reports"], queryFn: api.reports });
  const [target, setTarget] = useState<{ id: string; status: "RESOLVED" | "DISMISSED" } | null>(null);
  const m = useMutation({ mutationFn: (v: { id: string; status: "RESOLVED" | "DISMISSED"; reason: string }) => api.resolveReport(v.id, v.status, v.reason), onSuccess: async () => { setTarget(null); await qc.invalidateQueries({ queryKey: ["reports"] }); } });
  return (
    <Page title="Chat reports" eyebrow="Moderation">
      {q.error ? <Failure error={q.error} /> : !q.data ? <Loading /> : q.data.reports.length === 0 ? <HoloPanel><NoData what="No open reports" /></HoloPanel> : (
        <HoloPanel padded={false}>
          <table className="nf-table">
            <thead><tr><th>Sender</th><th>Channel</th><th>Message</th><th>Reason</th><th>Reported</th><th /></tr></thead>
            <tbody>{q.data.reports.map((r) => (
              <tr key={r.id}>
                <td className="font-ui font-bold">{r.message?.sender.username ?? "—"}</td><td>{r.message?.channel ?? "—"}</td>
                <td className="max-w-[340px] text-[13px]">{r.message?.text ?? <NoData what="Deleted" />}</td><td className="text-dim">{r.reason}</td><td className="text-[12px] text-dim">{when(r.createdAt)}</td>
                <td className="whitespace-nowrap"><span className="inline-flex gap-1.5"><NeonButton size="sm" variant="danger" onClick={() => setTarget({ id: r.id, status: "RESOLVED" })}>Hide msg</NeonButton><NeonButton size="sm" variant="ghost" onClick={() => setTarget({ id: r.id, status: "DISMISSED" })}>Dismiss</NeonButton></span></td>
              </tr>
            ))}</tbody>
          </table>
        </HoloPanel>
      )}
      <ReasonDialog open={Boolean(target)} title={target?.status === "RESOLVED" ? "Resolve report" : "Dismiss report"} busy={m.isPending} onClose={() => setTarget(null)} onConfirm={(reason) => target && m.mutate({ ...target, reason })} />
    </Page>
  );
}


