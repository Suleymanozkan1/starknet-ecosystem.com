import { Link } from "react-router-dom";
import { Icon } from "@nebula/game-ui";
import { api } from "../lib/api.js";
import type { NotificationDto } from "../lib/dto.js";
import { qk, useApiMutation } from "../lib/queries.js";
import { relTime } from "../lib/gameMeta.js";

export function NotificationDropdown({ items, loading, onClose }: { items: NotificationDto[]; loading: boolean; onClose: () => void }) {
  const markAll = useApiMutation(() => api.notifications.read("all"), { invalidate: [qk.notifications] });
  return (
    <div className="nf-panel absolute right-0 top-[calc(100%+10px)] z-[80] w-[min(360px,92vw)]" role="dialog" aria-label="Notifications">
      <div className="nf-panel__header">
        <h2 className="nf-panel__title">Notifications</h2>
        <button type="button" className="nf-ui text-[12px] uppercase tracking-[0.14em] text-accent disabled:opacity-40" disabled={markAll.isPending || !items.some((n) => !n.readAt)} onClick={() => markAll.mutate(undefined)}>
          Mark all read
        </button>
      </div>
      <div className="max-h-[360px] overflow-y-auto">
        {loading && <div className="p-4"><div className="nf-skeleton h-12" /></div>}
        {!loading && items.length === 0 && <div className="p-6 text-center text-[13px] text-mute">No notifications yet.</div>}
        {items.slice(0, 8).map((n) => (
          <div key={n.id} className="flex gap-3 border-b border-white/5 px-4 py-3">
            <span className={n.readAt ? "mt-1 text-mute" : "mt-1 text-accent"}><Icon name="bell" size={15} /></span>
            <div className="grid min-w-0 gap-0.5">
              <div className="nf-ui truncate text-[14px] font-bold">{n.title}</div>
              <div className="line-clamp-2 text-[12.5px] text-dim">{n.body}</div>
              <div className="text-[11px] text-mute">{relTime(n.createdAt)}</div>
            </div>
          </div>
        ))}
      </div>
      <Link to="/notifications" onClick={onClose} className="nf-ui block p-3 text-center text-[12px] uppercase tracking-[0.2em] text-accent no-underline hover:bg-white/5">
        View all
      </Link>
    </div>
  );
}
