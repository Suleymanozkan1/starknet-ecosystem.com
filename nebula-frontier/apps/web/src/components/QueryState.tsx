import type { ReactNode } from "react";
import { HoloPanel, Icon, NeonButton } from "@nebula/game-ui";
import { errorMessage, isApiError } from "../lib/http.js";

interface Q<T> { data: T | undefined; isLoading: boolean; error: unknown; refetch: () => unknown }

/** Uniform loading / error / empty handling for query-driven sections. */
export function QueryState<T>({ q, children, empty, isEmpty, skeleton = 3 }: {
  q: Q<T>;
  children: (data: T) => ReactNode;
  empty?: ReactNode;
  isEmpty?: (d: T) => boolean;
  skeleton?: number;
}) {
  if (q.isLoading) {
    return (
      <div className="grid gap-3" aria-busy>
        {Array.from({ length: skeleton }, (_, i) => <div key={i} className="nf-skeleton h-16" />)}
      </div>
    );
  }
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (q.data === undefined) return null;
  if (isEmpty?.(q.data)) return <>{empty ?? <EmptyState />}</>;
  return <>{children(q.data)}</>;
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const notFound = isApiError(error) && (error.status === 404 || error.status === 501);
  return (
    <HoloPanel accent="var(--nf-bad)" className="text-center">
      <div className="grid justify-items-center gap-2 py-4">
        <span className="text-bad"><Icon name="warning" size={28} /></span>
        <div className="nf-ui text-[16px] font-bold uppercase tracking-[0.14em]">{notFound ? "Service not available" : "Transmission failed"}</div>
        <p className="max-w-md text-[13px] text-dim">{errorMessage(error)}</p>
        {onRetry && <NeonButton size="sm" onClick={onRetry} icon={<Icon name="refresh" size={14} />}>Retry</NeonButton>}
      </div>
    </HoloPanel>
  );
}

export function EmptyState({ title = "Nothing here yet", body, action, icon = "galaxy" }: { title?: string; body?: string; action?: ReactNode; icon?: Parameters<typeof Icon>[0]["name"] }) {
  return (
    <div className="grid justify-items-center gap-2 rounded-xl border border-dashed border-line px-6 py-10 text-center">
      <span className="text-mute"><Icon name={icon} size={34} /></span>
      <div className="nf-ui text-[16px] font-bold uppercase tracking-[0.14em] text-dim">{title}</div>
      {body && <p className="max-w-md text-[13px] text-mute">{body}</p>}
      {action}
    </div>
  );
}
