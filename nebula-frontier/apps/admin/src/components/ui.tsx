import { useState } from "react";
import type { ReactNode } from "react";
import { HoloPanel, Icon, Modal, NeonButton } from "@nebula/game-ui";
import type { IconName } from "@nebula/game-ui";
import { errorMessage, isApiError } from "../lib/http.js";

export function Page({ title, eyebrow, actions, children }: { title: string; eyebrow?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          {eyebrow && <div className="font-ui text-[11px] font-bold uppercase tracking-[0.28em] text-accent">{eyebrow}</div>}
          <h1 className="m-0 font-display text-[26px] font-extrabold tracking-[0.08em]">{title}</h1>
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </header>
      {children}
    </div>
  );
}

/** KPI tile: a headline number (no chart) with an optional sub-line. */
export function Kpi({ label, value, sub, icon, tone }: { label: string; value: ReactNode; sub?: ReactNode; icon?: IconName; tone?: "good" | "warn" | "bad" }) {
  const color = tone === "good" ? "var(--nf-good)" : tone === "warn" ? "var(--nf-warn)" : tone === "bad" ? "var(--nf-bad)" : undefined;
  return (
    <HoloPanel>
      <div className="flex items-start justify-between gap-2">
        <div className="font-ui text-[11px] font-bold uppercase tracking-[0.18em] text-mute">{label}</div>
        {icon && <span className="text-accent"><Icon name={icon} size={16} /></span>}
      </div>
      <div className="kpi-value mt-1" style={color ? { color } : undefined}>{value}</div>
      {sub && <div className="mt-0.5 text-[12px] text-dim">{sub}</div>}
    </HoloPanel>
  );
}

export function NoData({ what = "No data" }: { what?: string }) {
  return <span className="font-ui text-[12px] uppercase tracking-[0.14em] text-mute">{what}</span>;
}

export function Loading() {
  return <div className="h-40 animate-pulse rounded-xl bg-white/5" />;
}

export function Failure({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const forbidden = isApiError(error) && error.status === 403;
  return (
    <HoloPanel accent="var(--nf-bad)">
      <div className="grid gap-2">
        <div className="font-ui font-bold uppercase tracking-[0.12em] text-bad">{forbidden ? "Insufficient role" : "Request failed"}</div>
        <div className="text-[13px] text-dim">{errorMessage(error)}</div>
        {onRetry && !forbidden && <NeonButton size="sm" onClick={onRetry}>Retry</NeonButton>}
      </div>
    </HoloPanel>
  );
}

/** Every admin mutation requires a reason (stored in the audit log). */
export function ReasonDialog({ open, title, confirmLabel = "Confirm", danger, children, busy, onClose, onConfirm }: {
  open: boolean; title: string; confirmLabel?: string; danger?: boolean; children?: ReactNode; busy?: boolean;
  onClose: () => void; onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <Modal open={open} onClose={onClose} locked={busy} title={title}
      footer={<><NeonButton variant="ghost" onClick={onClose} disabled={busy}>Cancel</NeonButton><NeonButton variant={danger ? "danger" : "primary"} loading={busy} disabled={reason.trim().length < 3} onClick={() => onConfirm(reason.trim())}>{confirmLabel}</NeonButton></>}>
      <div className="grid gap-3">
        {children}
        <label className="grid gap-1.5">
          <span className="font-ui text-[11px] font-bold uppercase tracking-[0.18em] text-mute">Reason (audit log, required)</span>
          <textarea className="nf-input min-h-[80px] py-2" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
        </label>
      </div>
    </Modal>
  );
}
