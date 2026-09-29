import type { ReactNode } from "react";

export interface ProgressRingProps {
  /** 0..1 */
  value: number;
  size?: number;
  stroke?: number;
  color?: string;
  track?: string;
  children?: ReactNode;
  className?: string;
}

/** Circular progress (loading screens, cooldown sweeps, battle pass tiers). */
export function ProgressRing({ value, size = 56, stroke = 4, color = "var(--nf-accent)", track = "rgba(255,255,255,0.08)", children, className }: ProgressRingProps) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value));
  return (
    <span className={className} style={{ position: "relative", display: "inline-grid", placeItems: "center", width: size, height: size }}>
      <svg width={size} height={size} className="nf-ring" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track} strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - v)}
          style={{ transition: "stroke-dashoffset 0.3s cubic-bezier(0.2,0.8,0.2,1)", filter: `drop-shadow(0 0 4px ${color})` }}
        />
      </svg>
      {children !== undefined && <span style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>{children}</span>}
    </span>
  );
}
