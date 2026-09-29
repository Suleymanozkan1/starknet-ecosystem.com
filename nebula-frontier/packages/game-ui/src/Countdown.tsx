import { useEffect, useRef, useState } from "react";
import { cx } from "./cx.js";
import { uiLocale } from "./locale.js";

export function formatDuration(ms: number, opts: { showSeconds?: boolean } = {}): string {
  const showSeconds = opts.showSeconds ?? true;
  const u = uiLocale().units;
  if (ms <= 0) return showSeconds ? "00:00:00" : `0${u.minute}`;
  const total = Math.floor(ms / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number): string => n.toString().padStart(2, "0");
  if (d > 0) return `${d}${u.day} ${pad(h)}${u.hour} ${pad(m)}${u.minute}`;
  return showSeconds ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${h}${u.hour} ${pad(m)}${u.minute}`;
}

/** Re-renders every `intervalMs` and returns Date.now(). */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}

export interface CountdownProps {
  /** Target instant (ISO string, epoch ms or Date). */
  to: string | number | Date;
  /** Rendered when the countdown reached zero (default: the UI locale's "Ended"). */
  endedLabel?: string;
  /** Below this many ms the countdown turns red and pulses. */
  urgentBelowMs?: number;
  className?: string;
  prefix?: string;
  onEnd?: () => void;
}

export function Countdown({ to, endedLabel, urgentBelowMs = 60_000, className, prefix, onEnd }: CountdownProps) {
  const now = useNow(1000);
  const target = typeof to === "number" ? to : new Date(to).getTime();
  const left = target - now;
  const ended = left <= 0;
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;
  useEffect(() => {
    // Fires once when the countdown crosses zero.
    if (ended) onEndRef.current?.();
  }, [ended]);
  if (!Number.isFinite(target)) return <span className={className}>—</span>;
  return (
    <span
      className={cx("nf-countdown", left > 0 && left < urgentBelowMs && "nf-countdown--urgent", className)}
      title={new Date(target).toLocaleString(uiLocale().locale)}
    >
      {left <= 0 ? (endedLabel ?? uiLocale().ended) : `${prefix ?? ""}${formatDuration(left)}`}
    </span>
  );
}
