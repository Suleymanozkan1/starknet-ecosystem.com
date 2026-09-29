import { HoloPanel, Icon, NeonButton } from "@nebula/game-ui";
import { api } from "../lib/api.js";
import { qk, useApiMutation, useNotifications } from "../lib/queries.js";
import { relTime } from "../lib/gameMeta.js";
import { enumLabel, translateServerText, useT } from "../lib/i18n.js";
import { PageHeader } from "../components/PageHeader.js";
import { EmptyState, QueryState } from "../components/QueryState.js";
import { registerPush } from "../native/push.js";
import { isNative } from "../native/platform.js";
import { useNavigate } from "react-router-dom";
import { toast } from "../store/ui.js";

export default function NotificationsPage() {
  const t = useT();
  const q = useNotifications();
  const navigate = useNavigate();
  const inv = [qk.notifications];
  const readAll = useApiMutation(() => api.notifications.read("all"), { invalidate: inv });
  const readOne = useApiMutation((id: string) => api.notifications.read([id]), { invalidate: inv });
  return (
    <div>
      <PageHeader eyebrow={t("notifs.eyebrow")} title={t("nav.notifications")} actions={
        <>
          {isNative && <NeonButton size="sm" variant="ghost" onClick={() => void registerPush((r) => navigate(r)).then((s) => toast.info(s === "registered" ? t("notifs.pushEnabled") : s === "denied" ? t("notifs.pushDenied") : t("notifs.pushUnavailable")))}>{t("notifs.enablePush")}</NeonButton>}
          <NeonButton size="sm" loading={readAll.isPending} disabled={!q.data?.unread} onClick={() => readAll.mutate(undefined)}>{t("notif.markAllRead")}</NeonButton>
        </>
      } />
      <QueryState q={q} isEmpty={(d) => d.notifications.length === 0} empty={<EmptyState title={t("notifs.emptyTitle")} body={t("notifs.emptyBody")} icon="bell" />}>
        {(d) => (
          <div className="grid gap-2">
            {d.notifications.map((n) => (
              <HoloPanel key={n.id} glow={!n.read} padded={false}>
                <button type="button" className="flex w-full items-start gap-3 p-4 text-left" onClick={() => !n.read && readOne.mutate(n.id)}>
                  <span className={n.read ? "mt-0.5 text-mute" : "mt-0.5 text-accent"}><Icon name={n.type.startsWith("SECURITY") ? "shield" : n.type.includes("REWARD") || n.type.includes("DEPOSIT") ? "crypto" : "bell"} size={18} /></span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-2"><span className="nf-ui text-[16px] font-bold">{translateServerText(n.title)}</span><span className="text-[11.5px] text-mute">{relTime(n.createdAt)}</span></div>
                    <div className="text-[13.5px] text-dim">{translateServerText(n.body)}</div>
                    <div className="nf-label mt-1 text-[9.5px]">{enumLabel(n.type)}</div>
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
