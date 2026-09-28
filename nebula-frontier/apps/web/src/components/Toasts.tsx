import { Icon } from "@nebula/game-ui";
import type { IconName } from "@nebula/game-ui";
import { useUi } from "../store/ui.js";

const KIND: Record<string, { icon: IconName; color: string }> = {
  info: { icon: "info", color: "var(--nf-accent)" },
  success: { icon: "check", color: "var(--nf-good)" },
  warn: { icon: "warning", color: "var(--nf-warn)" },
  error: { icon: "warning", color: "var(--nf-bad)" },
  loot: { icon: "gems", color: "var(--nf-gems)" },
  levelup: { icon: "star", color: "var(--nf-credits)" },
};

export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismissToast);
  return (
    <div className="nf-toasts" aria-live="polite">
      {toasts.map((t) => {
        const k = KIND[t.kind] ?? KIND.info!;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => dismiss(t.id)}
            className="nf-panel nf-toast flex items-start gap-3 p-3 text-left"
            style={{ borderColor: `color-mix(in oklab, ${k.color} 50%, transparent)` }}
          >
            <span style={{ color: k.color }} className="mt-0.5"><Icon name={k.icon} size={18} /></span>
            <span className="grid gap-0.5">
              <span className="nf-ui text-[15px] font-bold uppercase tracking-[0.08em]">{t.title}</span>
              {t.body && <span className="text-[13px] text-dim">{t.body}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}
