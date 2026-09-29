import { Link } from "react-router-dom";
import { Icon } from "@nebula/game-ui";
import { api } from "../lib/api.js";
import type { NotificationDto } from "../lib/dto.js";
import { qk, useApiMutation } from "../lib/queries.js";
import { relTime } from "../lib/gameMeta.js";
import { translateServerText, useT } from "../lib/i18n.js";

export function NotificationDropdown({ items, loading, onClose }: { items: NotificationDto[]; loading: boolean; onClose: () => void }) {
  const t = useT();
  const markAll = useApiMutation(() => api.notifications.read("all"), { invalidate: [qk.notifications] });
  return (
    <div className="nf-panel absolute right-0 top-[calc(100%+10px)] z-[80] w-[min(360px,92vw)]" role="dialog" aria-label={t("nav.notifications")}>
      <div className="nf-panel__header">
        <h2 className="nf-panel__title">{t("nav.notifications")}</h2>
        <button type="button" className="nf-ui text-[12px] uppercase tracking-[0.14em] text-accent disabled:opacity-40" disabled={markAll.isPending || !items.some((n) => !n.read)} onClick={() => markAll.mutate(undefined)}>
          {t("notif.markAllRead")}
        </button>
      </div>
      <div className="max-h-[360px] overflow-y-auto">
        {loading && <div className="p-4"><div className="nf-skeleton h-12" /></div>}
        {!loading && items.length === 0 && <div className="p-6 text-center text-[13px] text-mute">{t("notif.empty")}</div>}
        {items.slice(0, 8).map((n) => (
          <div key={n.id} className="flex gap-3 border-b border-white/5 px-4 py-3">
            <span className={n.read ? "mt-1 text-mute" : "mt-1 text-accent"}><Icon name="bell" size={15} /></span>
            <div className="grid min-w-0 gap-0.5">
              <div className="nf-ui truncate text-[14px] font-bold">{translateServerText(n.title)}</div>
              <div className="line-clamp-2 text-[12.5px] text-dim">{translateServerText(n.body)}</div>
              <div className="text-[11px] text-mute">{relTime(n.createdAt)}</div>
            </div>
          </div>
        ))}
      </div>
      <Link to="/notifications" onClick={onClose} className="nf-ui block p-3 text-center text-[12px] uppercase tracking-[0.2em] text-accent no-underline hover:bg-white/5">
        {t("notif.viewAll")}
      </Link>
    </div>
  );
}
