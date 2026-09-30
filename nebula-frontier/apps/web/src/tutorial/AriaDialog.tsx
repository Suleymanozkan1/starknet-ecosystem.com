import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon, NeonButton } from "@nebula/game-ui";
import type { IconName } from "@nebula/game-ui";
import { useT } from "../lib/i18n.js";
import { AriaAvatar, ARIA_NAME } from "./AriaAvatar.js";
import { TipText, useReducedMotion, useTypewriter } from "./TypedText.js";

export interface AriaStep {
  id: string;
  icon?: IconName;
  title: string;
  body: string;
  note?: string;
}

export interface AriaDialogProps {
  steps: readonly AriaStep[];
  /** Called on Skip / Esc / close (completed = false) or after the last step (completed = true). */
  onClose: (completed: boolean) => void;
  /** Accessible name of the dialog. */
  label: string;
  /** Enter / → next, ← back, Esc close (landing page only — never in-game). */
  keyboard?: boolean;
  /** Extra primary action on the last step (e.g. "Enter the Frontier"). */
  finalAction?: { label: string; onClick: () => void };
}

function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}

function isInteractive(el: EventTarget | null): boolean {
  return el instanceof HTMLElement && (["BUTTON", "A", "SUMMARY"].includes(el.tagName) || isEditable(el));
}

/**
 * ARIA's step-by-step walkthrough: a non-modal holographic panel (the page behind stays usable) with a
 * typewriter speech bubble, step dots and Back / Skip / Next.
 */
export function AriaDialog({ steps, onClose, label, keyboard = false, finalAction }: AriaDialogProps) {
  const t = useT();
  const [index, setIndex] = useState(0);
  const reduced = useReducedMotion();
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const step = steps[Math.min(index, steps.length - 1)];
  const text = step ? step.body : "";
  const tw = useTypewriter(text, !reduced);
  const last = index >= steps.length - 1;

  // Latest handlers for the window key listener without re-subscribing every render.
  const nav = useRef<{ next: () => void; back: () => void; close: () => void }>({ next: () => undefined, back: () => undefined, close: () => undefined });
  nav.current = {
    next: () => (last ? onClose(true) : setIndex((i) => Math.min(steps.length - 1, i + 1))),
    back: () => setIndex((i) => Math.max(0, i - 1)),
    close: () => onClose(false),
  };

  useEffect(() => {
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.focus({ preventScroll: true });
    return () => prev?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (!keyboard) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || isEditable(e.target)) return;
      if (e.key === "Escape") {
        e.preventDefault();
        nav.current.close();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        nav.current.next();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        nav.current.back();
      } else if (e.key === "Enter") {
        // A focused button / link keeps its own Enter behaviour (inside or outside the panel).
        if (isInteractive(e.target)) return;
        e.preventDefault();
        nav.current.next();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keyboard]);

  if (!step) return null;
  // Portal: panels with backdrop-filter / transforms would otherwise become the containing block of `position: fixed`.
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-modal="false"
      aria-label={label}
      aria-describedby={titleId}
      tabIndex={-1}
      className="nf-panel nf-aria-dialog"
      data-testid="aria-dialog"
    >
      <div className="flex items-start gap-3">
        <AriaAvatar size={64} speaking={!tw.done} className="nf-aria-dialog__avatar" />
        <div className="grid min-w-0 flex-1 gap-0.5">
          <div className="flex items-center gap-2">
            <span className="nf-display text-[15px] font-black tracking-[0.3em] text-[var(--aria-a)]">{ARIA_NAME}</span>
            <span className="nf-ui min-w-0 truncate text-[11px] uppercase tracking-[0.18em] text-mute">{t("aria.role")}</span>
          </div>
          <div className="nf-ui text-[11px] uppercase tracking-[0.2em] text-dim">{t("aria.stepOf", { n: index + 1, total: steps.length })}</div>
        </div>
        <button type="button" className="nf-iconbtn h-8 w-8 shrink-0" onClick={() => onClose(false)} aria-label={t("aria.close")} data-testid="aria-close">
          <Icon name="close" size={15} />
        </button>
      </div>

      <div className="nf-aria-speech" onClick={tw.finish}>
        <h2 id={titleId} className="nf-ui m-0 flex items-center gap-2 text-[18px] font-bold uppercase tracking-[0.08em]">
          {step.icon && <span className="text-[var(--aria-a)]"><Icon name={step.icon} size={18} /></span>}
          {step.title}
        </h2>
        <div aria-live="polite">
          <TipText text={text} count={tw.count} className="m-0 mt-1.5 text-[14px] leading-relaxed text-ink" />
        </div>
        {step.note && tw.done && <p className="m-0 mt-2 flex items-start gap-1.5 text-[12.5px] leading-snug text-warn"><Icon name="info" size={14} />{step.note}</p>}
      </div>

      <div className="nf-aria-dots" role="group" aria-label={t("aria.stepOf", { n: index + 1, total: steps.length })}>
        {steps.map((s, i) => (
          <button key={s.id} type="button" className="nf-aria-dot" data-active={i === index} data-done={i < index} aria-label={t("aria.goToStep", { n: i + 1 })} aria-current={i === index ? "step" : undefined} onClick={() => setIndex(i)} />
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <NeonButton size="sm" variant="ghost" onClick={() => setIndex((i) => Math.max(0, i - 1))} disabled={index === 0} data-testid="aria-back">{t("aria.back")}</NeonButton>
        {!last && <button type="button" className="nf-ui cursor-pointer bg-transparent px-2 text-[12px] font-bold uppercase tracking-[0.16em] text-mute hover:text-ink" onClick={() => onClose(false)} data-testid="aria-skip">{t("aria.skip")}</button>}
        <span className="flex-1" />
        {last && finalAction && <NeonButton size="sm" onClick={finalAction.onClick} icon={<Icon name="play" size={14} />}>{finalAction.label}</NeonButton>}
        <NeonButton size="sm" variant="primary" onClick={() => nav.current.next()} data-testid="aria-next">{last ? t("aria.finish") : t("aria.next")}</NeonButton>
      </div>
      {keyboard && <div className="nf-aria-keys nf-ui text-[10.5px] uppercase tracking-[0.16em] text-mute">{t("aria.keysHint")}</div>}
    </div>,
    document.body,
  );
}
