import { HoloPanel, Icon, NeonButton } from "@nebula/game-ui";
import { api } from "../lib/api.js";
import { qk, useApiMutation, useNotifications } from "../lib/queries.js";
import { humanize, relTime } from "../lib/gameMeta.js";
import { PageHeader } from "../components/PageHeader.js";
import { EmptyState, QueryState } from "../components/QueryState.js";
import { registerPush } from "../native/push.js";
import { isNative } from "../native/platform.js";
import { useNavigate } from "react-router-dom";
import { toast } from "../store/ui.js";

export default function NotificationsPage() {
  const q = useNotifications();
  const navigate = useNavigate();
  const inv = [qk.notifications];
  const readAll = useApiMutation(() => api.notifications.read("all"), { invalidate: inv });
  const readOne = useApiMutation((id: string) => api.notifications.read([id]), { invalidate: inv });
  return (
    <div>
      <PageHeader eyebrow="Inbox" title="Notifications" actions={
        <>
          {isNative && <NeonButton size="sm" variant="ghost" onClick={() => void registerPush((r) => navigate(r)).then((s) => toast.info(s === "registered" ? "Push notifications enabled" : s === "denied" ? "Permission denied — enable in system settings" : "Push unavailable"))}>Enable push</NeonButton>}
          <NeonButton size="sm" loading={readAll.isPending} disabled={!q.data?.unread} onClick={() => readAll.mutate(undefined)}>Mark all read</NeonButton>
        </>
      } />
      <QueryState q={q} isEmpty={(d) => d.notifications.length === 0} empty={<EmptyState title="All quiet" body="Security alerts, invitations and rewards appear here." icon="bell" />}>
        {(d) => (
          <div className="grid gap-2">
            {d.notifications.map((n) => (
              <HoloPanel key={n.id} glow={!n.read} padded={false}>
                <button type="button" className="flex w-full items-start gap-3 p-4 text-left" onClick={() => !n.read && readOne.mutate(n.id)}>
                  <span className={n.read ? "mt-0.5 text-mute" : "mt-0.5 text-accent"}><Icon name={n.type.startsWith("SECURITY") ? "shield" : n.type.includes("REWARD") || n.type.includes("DEPOSIT") ? "crypto" : "bell"} size={18} /></span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-2"><span className="nf-ui text-[16px] font-bold">{n.title}</span><span className="text-[11.5px] text-mute">{relTime(n.createdAt)}</span></div>
                    <div className="text-[13.5px] text-dim">{n.body}</div>
                    <div className="nf-label mt-1 text-[9.5px]">{humanize(n.type)}</div>
                  </div>
                </button>
              </HoloPanel>
            ))}
          </div>
        )}
      </QueryState>
    </div>
  );
}
