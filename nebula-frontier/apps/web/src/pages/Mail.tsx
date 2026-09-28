import { useState } from "react";
import { HoloPanel, Icon, NeonButton } from "@nebula/game-ui";
import { api } from "../lib/api.js";
import type { MailDto } from "../lib/dto.js";
import { qk, useApiMutation, useMail } from "../lib/queries.js";
import { relTime } from "../lib/gameMeta.js";
import { PageHeader } from "../components/PageHeader.js";
import { EmptyState, QueryState } from "../components/QueryState.js";
import { RewardChips } from "../components/RewardChips.js";
import { haptic } from "../native/haptics.js";

export default function MailPage() {
  const q = useMail();
  const [sel, setSel] = useState<MailDto | null>(null);
  const read = useApiMutation((id: string) => api.mail.read(id), { invalidate: [qk.mail] });
  const claim = useApiMutation((id: string) => api.mail.claim(id), { invalidate: [qk.mail, qk.me, qk.inventory], success: "Attachments claimed", onSuccess: () => haptic("success") });
  const open = (m: MailDto): void => {
    setSel(m);
    if (!m.read) read.mutate(m.id);
  };
  const current = sel ? (q.data ?? []).find((m) => m.id === sel.id) ?? sel : null;
  return (
    <div>
      <PageHeader eyebrow="Comms relay" title="Mailbox" />
      <QueryState q={q} isEmpty={(d) => d.length === 0} empty={<EmptyState title="No mail" body="Season rewards, compensation and clan messages arrive here." icon="mail" />}>
        {(list) => (
          <div className="grid gap-5 lg:grid-cols-[380px_1fr]">
            <HoloPanel padded={false}>
              <ul className="m-0 max-h-[70vh] list-none overflow-y-auto p-0">
                {list.map((m) => (
                  <li key={m.id}>
                    <button type="button" onClick={() => open(m)} className="flex w-full items-start gap-3 border-b border-white/5 px-4 py-3 text-left hover:bg-white/5" style={current?.id === m.id ? { background: "color-mix(in oklab, var(--nf-accent) 10%, transparent)" } : undefined}>
                      <span className={m.read ? "text-mute" : "text-accent"}><Icon name="mail" size={17} /></span>
                      <div className="min-w-0 flex-1">
                        <div className={`nf-ui truncate text-[15px] ${m.read ? "" : "font-bold"}`}>{m.subject}</div>
                        <div className="text-[11.5px] text-mute">{m.system ? "Frontier Command" : "Pilot"} · {relTime(m.createdAt)}</div>
                      </div>
                      {m.hasAttachments && !m.claimed && <span className="text-credits"><Icon name="gems" size={15} /></span>}
                    </button>
                  </li>
                ))}
              </ul>
            </HoloPanel>
            {current ? (
              <HoloPanel title={current.subject}>
                <div className="grid gap-4">
                  <div className="text-[12px] text-mute">{current.system ? "Frontier Command" : "Pilot message"} · {new Date(current.createdAt).toLocaleString()}{current.expiresAt ? ` · expires ${relTime(current.expiresAt)}` : ""}</div>
                  <p className="m-0 whitespace-pre-wrap text-[14px] leading-relaxed text-ink/90">{current.body}</p>
                  {current.hasAttachments && current.attachments && (
                    <div className="grid gap-2 rounded-lg border border-line bg-black/25 p-3">
                      <div className="nf-label">Attachments</div>
                      <RewardChips bundle={current.attachments} />
                      {current.claimed ? <span className="nf-chip justify-self-start" style={{ color: "var(--nf-good)" }}>Claimed</span> : <NeonButton size="sm" variant="success" loading={claim.isPending} onClick={() => claim.mutate(current.id)}>Claim attachments</NeonButton>}
                    </div>
                  )}
                </div>
              </HoloPanel>
            ) : <EmptyState title="Select a message" icon="mail" />}
          </div>
        )}
      </QueryState>
    </div>
  );
}
