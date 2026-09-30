import { useEffect, useId, useState } from "react";
import { Icon, NeonButton } from "@nebula/game-ui";
import { useT } from "../lib/i18n.js";
import { DEMO_MODE } from "../lib/demoMode.js";
import { toast } from "../store/ui.js";
import { AriaAvatar, ARIA_NAME } from "./AriaAvatar.js";
import { TipText, useReducedMotion, useTypewriter } from "./TypedText.js";
import { pageTipFor, pageTipKey } from "./pageTips.js";
import type { PageTip } from "./pageTips.js";
import { shouldAutoShow, useTutorial, whenTutorialHydrated } from "./store.js";

/** Delay before a first-visit tip appears, so it does not compete with the page's enter animation. */
const FIRST_VISIT_DELAY_MS = 700;

function useTutorialHydrated(): boolean {
  const [hydrated, setHydrated] = useState(() => useTutorial.persist.hasHydrated());
  useEffect(() => whenTutorialHydrated(() => setHydrated(true)), []);
  return hydrated;
}

function PageBubble({ tip, onClose }: { tip: PageTip; onClose: () => void }) {
  const t = useT();
  const reduced = useReducedMotion();
  const setEnabled = useTutorial((s) => s.setEnabled);
  const titleId = useId();
  const body = t(tip.body);
  const tw = useTypewriter(body, !reduced);
  return (
    <div role="dialog" aria-modal="false" aria-labelledby={titleId} className="nf-panel nf-aria-bubble nf-aria-bubble--page" data-testid="aria-page-tip">
      <AriaAvatar size={46} speaking={!tw.done} />
      <div className="grid min-w-0 flex-1 gap-1" onClick={tw.finish}>
        <div className="flex items-baseline gap-2 pr-6">
          <span className="nf-display text-[11px] font-black tracking-[0.3em] text-[var(--aria-a)]">{ARIA_NAME}</span>
          <span id={titleId} className="nf-ui truncate text-[14px] font-bold uppercase tracking-[0.1em]">{t(tip.title)}</span>
        </div>
        <div aria-live="polite">
          <TipText text={body} count={tw.count} className="m-0 text-[13px] leading-snug text-dim" />
        </div>
        {DEMO_MODE && tip.demoNote && tw.done && <p className="m-0 text-[12px] leading-snug text-warn">{t(tip.demoNote)}</p>}
        <div className="mt-1 flex items-center justify-end gap-2">
          <button
            type="button"
            className="nf-ui cursor-pointer bg-transparent px-1 text-[11px] font-bold uppercase tracking-[0.14em] text-mute hover:text-ink"
            onClick={() => {
              setEnabled(false);
              onClose();
              toast.info(t("aria.turnedOff"));
            }}
          >
            {t("aria.turnOff")}
          </button>
          <NeonButton size="sm" variant="primary" onClick={onClose} data-testid="aria-page-ok">{t("aria.finish")}</NeonButton>
        </div>
      </div>
      <button type="button" className="nf-aria-bubble__x" onClick={onClose} aria-label={t("aria.dismiss")}><Icon name="close" size={13} /></button>
    </div>
  );
}

/**
 * First-visit page explanation for the shell pages (bottom-right; above the bottom navigation on mobile).
 * Replays on demand through the top-bar ARIA button (`useTutorial().replay`).
 */
export function AriaPageGuide({ pathname, mobile = false, hidden = false }: { pathname: string; mobile?: boolean; hidden?: boolean }) {
  const tip = pageTipFor(pathname);
  const key = tip ? pageTipKey(tip) : null;
  const hydrated = useTutorialHydrated();
  const enabled = useTutorial((s) => s.enabled);
  const replayId = useTutorial((s) => s.replayId);
  const replayNonce = useTutorial((s) => s.replayNonce);
  const [open, setOpen] = useState<{ key: string; nonce: number } | null>(null);

  useEffect(() => {
    if (!key || !hydrated) return undefined;
    const st = useTutorial.getState();
    const replaying = st.replayId === key;
    if (!replaying && !shouldAutoShow(st, key)) return undefined;
    const timer = window.setTimeout(() => {
      setOpen({ key, nonce: st.replayNonce });
      st.markSeen(key);
      if (replaying) st.clearReplay();
    }, replaying ? 0 : FIRST_VISIT_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [key, hydrated, enabled, replayId, replayNonce]);

  if (!tip || !open || open.key !== key || hidden) return null;
  return (
    <div className={`nf-aria-page-slot${mobile ? " nf-aria-page-slot--mobile" : ""}`}>
      <PageBubble key={`${open.key}:${open.nonce}`} tip={tip} onClose={() => setOpen(null)} />
    </div>
  );
}

/** Top-bar button: replays the current page's ARIA tip. */
export function AriaHelpButton({ pathname }: { pathname: string }) {
  const t = useT();
  const replay = useTutorial((s) => s.replay);
  const tip = pageTipFor(pathname);
  if (!tip) return null;
  return (
    <button type="button" className="nf-iconbtn nf-aria-helpbtn" aria-label={t("aria.help")} title={t("aria.help")} onClick={() => replay(pageTipKey(tip))} data-testid="aria-help">
      <AriaAvatar size={30} />
    </button>
  );
}
