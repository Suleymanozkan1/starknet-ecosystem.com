import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { cx } from "./cx.js";

export interface StatBarProps {
  value: number;
  max: number;
  label?: ReactNode;
  color?: string;
  height?: number;
  showValue?: boolean;
  /** Format for the value readout. */
  format?: (value: number, max: number) => string;
  className?: string;
  /** Shows a trailing "damage ghost" that catches up after decreases. */
  ghost?: boolean;
}

export const STAT_COLORS = {
  hull: "#34d399",
  shield: "#60a5fa",
  energy: "#fbbf24",
  xp: "#a78bfa",
  heat: "#fb7185",
  boss: "#f43f5e",
} as const;

export function StatBar({
  value, max, label, color = STAT_COLORS.hull, height = 8, showValue = true, format, className, ghost = true,
}: StatBarProps) {
  const pct = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const [ghostPct, setGhostPct] = useState(pct);
  const prev = useRef(pct);
  useEffect(() => {
    // The ghost jumps up immediately when healing and lags behind when taking damage.
    if (pct >= prev.current) setGhostPct(pct);
    else {
      const t = window.setTimeout(() => setGhostPct(pct), 30);
      prev.current = pct;
      return () => window.clearTimeout(t);
    }
    prev.current = pct;
    return undefined;
  }, [pct]);
  const readout = format ? format(value, max) : `${Math.round(value).toLocaleString()} / ${Math.round(max).toLocaleString()}`;
  return (
    <div className={cx("nf-stat", className)} style={{ "--c": color, "--h": `${height}px` } as CSSProperties}>
      {(label || showValue) && (
        <div className="nf-stat__row">
          <span>{label}</span>
          {showValue && <span className="nf-stat__value">{readout}</span>}
        </div>
      )}
      <div
        className="nf-stat__track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={Math.round(value)}
        aria-label={typeof label === "string" ? label : undefined}
      >
        {ghost && <div className="nf-stat__ghost" style={{ width: `${Math.max(ghostPct, pct) * 100}%` }} />}
        <div className="nf-stat__fill" style={{ width: `${pct * 100}%` }} />
      </div>
    </div>
  );
}
