import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { Icon } from "@nebula/game-ui";
import { useT } from "../lib/i18n.js";
import type { HudEvent, HudView } from "../game/hudModel.js";
import { AriaAvatar, ARIA_NAME } from "./AriaAvatar.js";
import { TipText, plainTip, useReducedMotion, useTypewriter } from "./TypedText.js";
import { GAME_TIPS, enqueueTips, gameTipKey, preempts, takeNextTip, tipDurationMs, tipText, tipsForEvent, tipsForHud } from "./gameTips.js";
import type { GameTipId } from "./gameTips.js";
import { useTutorial, whenTutorialHydrated } from "./store.js";

/** Pause between two tips so they read as separate messages. */
const GAP_MS = 900;

type Listener = (ids: GameTipId[]) => void;
const listeners = new Set<Listener>();

/** Feed a HUD event to ARIA (called from Play.tsx's event handler). */
export function ariaGameEvent(e: HudEvent): void {
  const ids = tipsForEvent(e);
  if (ids.length) for (const l of listeners) l(ids);
}

const TONE_COLOR: Record<string, string> = { info: "var(--aria-a)", good: "var(--nf-good)", warn: "var(--nf-warn)", danger: "var(--nf-bad)" };

/** Keeps pointer presses on ARIA from moving keyboard focus away from the game (WASD / Space / Tab). */
const keepFocus = (e: ReactMouseEvent): void => e.preventDefault();

function GameBubble({ id, touch, more, onDone }: { id: GameTipId; touch: boolean; more: number; onDone: () => void }) {
  const t = useT();
  const reduced = useReducedMotion();
  const keys = tipText(id, touch);
  const body = t(keys.body);
  const tw = useTypewriter(body, !reduced, 80);
  const ms = tipDurationMs(plainTip(body));
  const tone = GAME_TIPS[id].tone;
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (!tw.done) return undefined;
    const timer = window.setTimeout(() => done.current(), ms);
    return () => window.clearTimeout(timer);
  }, [tw.done, ms]);
  return (
    <div
      className="nf-panel nf-aria-bubble nf-aria-bubble--game"
      data-tone={tone}
      data-testid="aria-game-tip"
      data-tip={id}
      style={{ "--tone": TONE_COLOR[tone] } as CSSProperties}
      onMouseDown={keepFocus}
      onClick={onDone}
      title={t("aria.tapToDismiss")}
    >
      <AriaAvatar size={touch ? 38 : 44} speaking={!tw.done} tone={tone} />
      <div className="grid min-w-0 flex-1 gap-0.5">
        <div className="flex items-baseline gap-2 pr-5">
          <span className="nf-display text-[10px] font-black tracking-[0.3em] text-[var(--aria-a)]">{ARIA_NAME}</span>
          <span className="nf-ui min-w-0 text-[13px] font-bold uppercase leading-tight tracking-[0.1em]" style={{ color: "var(--tone)" }}>{t(keys.title)}</span>
          {more > 0 && <span className="nf-ui ml-auto shrink-0 text-[10px] uppercase tracking-[0.12em] text-mute">{t("aria.moreTips", { n: more })}</span>}
        </div>
        <TipText text={body} count={tw.count} className="m-0 text-[12.5px] leading-snug text-ink" />
      </div>
      <button type="button" tabIndex={-1} className="nf-aria-bubble__x" onMouseDown={keepFocus} onClick={(e) => { e.stopPropagation(); onDone(); }} aria-label={t("aria.dismiss")}>
        <Icon name="close" size={12} />
      </button>
      {!reduced && tw.done && <span className="nf-aria-bubble__timer" style={{ animationDuration: `${ms}ms` }} />}
    </div>
  );
}

/**
 * ARIA in flight: a compact, non-blocking tip bubble (bottom-left on desktop, bottom-centre between the
 * joystick and the action buttons on touch). Tips are driven by HUD state changes and HUD events, show once
 * each (tutorial store), queue by priority and auto-dismiss. It never takes keyboard focus and has no key
 * shortcuts — the game owns the keyboard.
 */
export function AriaGameCoach({ hud, touch, hidden = false }: { hud: HudView; touch: boolean; hidden?: boolean }) {
  const t = useT();
  const enabled = useTutorial((s) => s.enabled);
  const markSeen = useTutorial((s) => s.markSeen);
  const [hydrated, setHydrated] = useState(() => useTutorial.persist.hasHydrated());
  const [queue, setQueue] = useState<GameTipId[]>([]);
  const [current, setCurrent] = useState<{ id: GameTipId; n: number } | null>(null);
  const [resting, setResting] = useState(false);
  const prevHud = useRef<HudView | null>(null);
  const currentRef = useRef(current);
  currentRef.current = current;
  const counter = useRef(0);

  useEffect(() => whenTutorialHydrated(() => setHydrated(true)), []);

  const add = useCallback((ids: readonly GameTipId[]) => {
    if (ids.length === 0) return;
    const isSeen = (id: GameTipId): boolean => useTutorial.getState().seen.includes(gameTipKey(id));
    const cur = currentRef.current;
    const urgent = cur ? ids.find((id) => !isSeen(id) && preempts(id, cur.id)) : undefined;
    if (cur && urgent) {
      // A danger warning replaces the tip on screen; the interrupted tip goes back into the queue.
      setCurrent(null);
      setQueue((q) => enqueueTips([cur.id, ...q.filter((x) => x !== cur.id)], ids, isSeen));
      return;
    }
    setQueue((q) => {
      const next = enqueueTips(q, ids, isSeen, cur?.id ?? null);
      return next.length === q.length && next.every((x, i) => x === q[i]) ? q : next;
    });
  }, []);

  // HUD state → tips (edge-triggered; the first connected frame queues the intro).
  useEffect(() => {
    if (!hydrated || !enabled || hud.connection !== "connected") return;
    const ids = tipsForHud(prevHud.current, hud);
    prevHud.current = hud;
    add(ids);
  }, [hud, hydrated, enabled, add]);

  // HUD events → tips.
  useEffect(() => {
    if (!enabled) return undefined;
    listeners.add(add);
    return () => { listeners.delete(add); };
  }, [enabled, add]);

  // Guide switched off mid-flight: clear everything.
  useEffect(() => {
    if (enabled) return;
    setQueue([]);
    setCurrent(null);
  }, [enabled]);

  // Show the next eligible tip.
  useEffect(() => {
    if (current || resting || hidden || !enabled || queue.length === 0) return;
    const { tip, rest } = takeNextTip(queue, hud);
    if (rest.length !== queue.length) setQueue(rest);
    if (tip) {
      counter.current += 1;
      setCurrent({ id: tip, n: counter.current });
      markSeen(gameTipKey(tip));
    }
  }, [queue, current, resting, hidden, enabled, hud, markSeen]);

  // Gap between tips.
  useEffect(() => {
    if (!resting) return undefined;
    const timer = window.setTimeout(() => setResting(false), GAP_MS);
    return () => window.clearTimeout(timer);
  }, [resting]);

  const dismiss = useCallback(() => {
    setCurrent(null);
    setResting(true);
  }, []);

  return (
    <div className={`nf-aria-game-slot${touch ? " nf-aria-game-slot--touch" : ""}`} role="status" aria-live="polite" aria-label={t("aria.gameLabel")}>
      {current && !hidden && <GameBubble key={current.n} id={current.id} touch={touch} more={queue.length} onDone={dismiss} />}
    </div>
  );
}
