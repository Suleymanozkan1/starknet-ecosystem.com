import { useCallback, useEffect, useMemo, useState } from "react";
import { useMediaQuery } from "../hooks/useMediaQuery.js";
import { useSettings } from "../store/settings.js";

/** OS "reduce motion" or the in-game Reduced motion setting: no typewriter, no avatar animation. */
export function useReducedMotion(): boolean {
  const os = useMediaQuery("(prefers-reduced-motion: reduce)");
  const setting = useSettings((s) => s.reducedMotion);
  return os || setting;
}

export interface TipSegment { text: string; key: boolean }

/** Splits "Press [Tab] to …" into text and key-cap segments. */
export function parseTip(text: string): TipSegment[] {
  const out: TipSegment[] = [];
  const re = /\[([^\]]+)\]/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), key: false });
    out.push({ text: m[1] ?? "", key: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), key: false });
  return out;
}

/** Text without the key-cap brackets (screen readers, reading-time estimates). */
export function plainTip(text: string): string {
  return parseTip(text).map((s) => s.text).join("");
}

/**
 * Typewriter reveal of `text` (in plain characters). Instantly complete when `animate` is false.
 * Restarts whenever `text` changes.
 */
export function useTypewriter(text: string, animate: boolean, cps = 70): { count: number; done: boolean; finish: () => void } {
  const total = useMemo(() => plainTip(text).length, [text]);
  const [state, setState] = useState({ text, count: 0 });
  let count = state.count;
  if (state.text !== text) {
    // Derived-state reset during render (React docs pattern) — avoids a flash of the previous text.
    count = 0;
    setState({ text, count: 0 });
  }
  useEffect(() => {
    if (!animate) return undefined;
    // Time-based interval (not requestAnimationFrame): keeps typing even when frames are throttled by a busy
    // WebGL scene or a background tab.
    const start = performance.now();
    const timer = window.setInterval(() => {
      const n = Math.min(total, Math.floor(((performance.now() - start) * cps) / 1000));
      setState((s) => (s.text === text && s.count < n ? { text, count: n } : s));
      if (n >= total) window.clearInterval(timer);
    }, 33);
    return () => window.clearInterval(timer);
  }, [text, animate, total, cps]);
  const finish = useCallback(() => setState({ text, count: total }), [text, total]);
  const shown = animate ? Math.min(count, total) : total;
  return { count: shown, done: shown >= total, finish };
}

/**
 * Renders the first `count` characters of a tip, key caps included. The visible (animated) copy is
 * aria-hidden; the complete sentence is exposed once to assistive tech.
 */
export function TipText({ text, count, className }: { text: string; count: number; className?: string }) {
  const segs = useMemo(() => parseTip(text), [text]);
  let left = count;
  const typing = count < plainTip(text).length;
  return (
    <p className={className}>
      <span className="sr-only">{plainTip(text)}</span>
      <span aria-hidden>
        {segs.map((s, i) => {
          if (left <= 0) return null;
          const part = s.text.slice(0, left);
          left -= s.text.length;
          return s.key ? <kbd key={i} className="nf-aria-key">{part}</kbd> : <span key={i}>{part}</span>;
        })}
        {typing && <span className="nf-aria-caret" />}
      </span>
    </p>
  );
}
