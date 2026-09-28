import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HoloPanel, NeonButton } from "@nebula/game-ui";
import { api } from "../lib/api.js";
import { errorMessage } from "../lib/http.js";
import { short, when } from "../lib/format.js";
import { Failure, Loading, NoData, Page, ReasonDialog } from "../components/ui.js";

/* ============================================================ API rules + feature flags */
export function RulesPage() {
  const qc = useQueryClient();
  const rules = useQuery({ queryKey: ["rules"], queryFn: api.rules });
  const flags = useQuery({ queryKey: ["flags"], queryFn: api.flags });
  const [edit, setEdit] = useState<{ key: string; value: string; type: string } | null>(null);
  const [flag, setFlag] = useState<{ key: string; enabled: boolean; rules: Record<string, unknown> } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const saveRule = useMutation({
    mutationFn: (reason: string) => {
      const v = edit!.type === "number" ? Number(edit!.value) : edit!.type === "boolean" ? edit!.value === "true" : edit!.value;
      return api.setRules({ [edit!.key]: v }, reason);
    },
    onSuccess: async () => { setEdit(null); await qc.invalidateQueries({ queryKey: ["rules"] }); },
    onError: (e) => setErr(errorMessage(e)),
  });
  const saveFlag = useMutation({ mutationFn: (reason: string) => api.setFlag(flag!.key, flag!.enabled, flag!.rules, reason), onSuccess: async () => { setFlag(null); await qc.invalidateQueries({ queryKey: ["flags"] }); }, onError: (e) => setErr(errorMessage(e)) });
  return (
    <Page title="Rules & feature flags" eyebrow="System">
      <div className="grid gap-4 xl:grid-cols-2">
        {rules.error ? <Failure error={rules.error} /> : !rules.data ? <Loading /> : (
          <HoloPanel title="Gameplay / API rules" padded={false}>
            <div className="max-h-[70vh] overflow-y-auto">
              <table className="nf-table"><thead><tr><th>Rule</th><th className="text-right">Value</th><th className="text-right">Default</th><th /></tr></thead>
                <tbody>{Object.entries(rules.data.rules).map(([k, v]) => (
                  <tr key={k}><td className="nf-mono">{k}</td><td className="text-right tabular-nums">{JSON.stringify(v)}</td><td className="text-right text-mute">{JSON.stringify(rules.data.defaults[k])}</td>
                    <td className="text-right">{(typeof v === "number" || typeof v === "boolean" || typeof v === "string") && <NeonButton size="sm" onClick={() => { setErr(null); setEdit({ key: k, value: String(v), type: typeof v }); }}>Edit</NeonButton>}</td></tr>
                ))}</tbody></table>
            </div>
          </HoloPanel>
        )}
        {flags.error ? <Failure error={flags.error} /> : !flags.data ? <Loading /> : (
          <HoloPanel title="Feature flags">
            {flags.data.flags.length === 0 ? <NoData what="No flags defined" /> : flags.data.flags.map((f) => (
              <div key={f.key} className="flex items-center justify-between gap-2 border-b border-white/5 py-2">
                <div><div className="nf-mono">{f.key}</div><div className="text-[11px] text-mute">{JSON.stringify(f.rules)}</div></div>
                <NeonButton size="sm" variant={f.enabled ? "danger" : "success"} onClick={() => { setErr(null); setFlag({ key: f.key, enabled: !f.enabled, rules: f.rules }); }}>{f.enabled ? "Disable" : "Enable"}</NeonButton>
              </div>
            ))}
          </HoloPanel>
        )}
      </div>
      <ReasonDialog open={Boolean(edit)} title={`Rule ${edit?.key ?? ""}`} busy={saveRule.isPending} onClose={() => setEdit(null)} onConfirm={(r) => saveRule.mutate(r)}>
        {edit && <input className="nf-input" value={edit.value} onChange={(e) => setEdit({ ...edit, value: e.target.value })} />}
        {err && <div className="text-[12.5px] text-bad">{err}</div>}
      </ReasonDialog>
      <ReasonDialog open={Boolean(flag)} title={`${flag?.enabled ? "Enable" : "Disable"} ${flag?.key ?? ""}`} busy={saveFlag.isPending} onClose={() => setFlag(null)} onConfirm={(r) => saveFlag.mutate(r)}>
        {err && <div className="text-[12.5px] text-bad">{err}</div>}
      </ReasonDialog>
    </Page>
  );
}

/* ============================================================ Compensation mail */
export function MailPage() {
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [credits, setCredits] = useState("");
  const [gems, setGems] = useState("");
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: (reason: string) => {
      const att = { ...(credits ? { credits: Number(credits) } : {}), ...(gems ? { gems: Number(gems) } : {}) };
      return api.mail({ toUserId: to, subject, body, attachments: Object.keys(att).length ? att : null, reason });
    },
    onSuccess: (r) => { setOpen(false); setMsg(`Mail ${r.id} sent`); },
    onError: (e) => setMsg(errorMessage(e)),
  });
  return (
    <Page title="Compensation mail" eyebrow="Support">
      <HoloPanel title="Send system mail">
        <div className="grid max-w-xl gap-3">
          <input className="nf-input" placeholder="Recipient user id" value={to} onChange={(e) => setTo(e.target.value.trim())} />
          <input className="nf-input" placeholder="Subject" value={subject} maxLength={120} onChange={(e) => setSubject(e.target.value)} />
          <textarea className="nf-input min-h-[120px] py-2" placeholder="Message" value={body} maxLength={4000} onChange={(e) => setBody(e.target.value)} />
          <div className="grid grid-cols-2 gap-2">
            <input className="nf-input" placeholder="Credits (optional)" value={credits} onChange={(e) => setCredits(e.target.value.replace(/\D/g, ""))} />
            <input className="nf-input" placeholder="Gems (optional)" value={gems} onChange={(e) => setGems(e.target.value.replace(/\D/g, ""))} />
          </div>
          {msg && <div className="text-[13px] text-dim">{msg}</div>}
          <NeonButton variant="primary" disabled={!to || !subject} onClick={() => setOpen(true)}>Send</NeonButton>
        </div>
      </HoloPanel>
      <ReasonDialog open={open} title="Send compensation mail" busy={m.isPending} onClose={() => setOpen(false)} onConfirm={(r) => m.mutate(r)} />
    </Page>
  );
}

/* ============================================================ Audit log */
export function AuditPage() {
  const [action, setAction] = useState("");
  const [target, setTarget] = useState("");
  const q = useQuery({ queryKey: ["audit", action, target], queryFn: () => api.audit({ ...(action ? { action } : {}), ...(target ? { targetId: target } : {}) }) });
  return (
    <Page title="Audit log" eyebrow="System">
      <div className="flex flex-wrap gap-2">
        <input className="nf-input max-w-xs" placeholder="Action (e.g. ECONOMY_CONFIG_UPDATE)" value={action} onChange={(e) => setAction(e.target.value.trim())} />
        <input className="nf-input max-w-xs" placeholder="Target id" value={target} onChange={(e) => setTarget(e.target.value.trim())} />
      </div>
      {q.error ? <Failure error={q.error} /> : !q.data ? <Loading /> : (
        <HoloPanel padded={false}>
          <div className="overflow-x-auto">
            <table className="nf-table">
              <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Reason</th><th>Change</th></tr></thead>
              <tbody>{q.data.entries.map((e) => (
                <tr key={e.id}>
                  <td className="whitespace-nowrap text-[12px]">{when(e.createdAt)}</td><td className="nf-mono">{e.actorType} {short(e.actorId, 4)}</td>
                  <td className="font-ui font-bold">{e.action}</td><td className="nf-mono">{e.targetType} {short(e.targetId, 5)}</td><td className="text-[12.5px] text-dim">{e.reason ?? "—"}</td>
                  <td className="nf-mono max-w-[320px] truncate text-mute" title={JSON.stringify({ old: e.oldValue, new: e.newValue })}>{JSON.stringify(e.newValue)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </HoloPanel>
      )}
    </Page>
  );
}
