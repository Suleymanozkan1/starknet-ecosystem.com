import { useId } from "react";
import type { CSSProperties } from "react";
import { cx } from "./cx.js";

export interface FactionEmblemProps {
  /** SVG path (24x24 viewBox) from factions.json `emblem`. */
  path: string;
  color: string;
  secondaryColor?: string;
  size?: number;
  /** Draw the hexagonal crest frame around the glyph. */
  framed?: boolean;
  className?: string;
  title?: string;
}

/** Faction crest: the data-driven glyph inside a holographic hex frame. */
export function FactionEmblem({ path, color, secondaryColor, size = 64, framed = true, className, title }: FactionEmblemProps) {
  const uid = useId().replace(/:/g, "");
  const grad = `fe-g-${uid}`;
  const glow = `fe-f-${uid}`;
  const accent = secondaryColor ?? color;
  return (
    <svg
      width={size}
      height={size}
      viewBox="-4 -4 32 32"
      className={cx("nf-emblem", className)}
      style={{ "--fc": color } as CSSProperties}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <defs>
        <linearGradient id={grad} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={color} />
          <stop offset="1" stopColor={accent} />
        </linearGradient>
        <filter id={glow} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="0.8" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      {framed && (
        <g fill="none" strokeLinejoin="round">
          <path d="M12 -2.5 L24.5 4.75 L24.5 19.25 L12 26.5 L-0.5 19.25 L-0.5 4.75 Z" stroke={color} strokeOpacity="0.35" strokeWidth="0.6" fill={color} fillOpacity="0.06" />
          <path d="M12 -0.8 L23 5.6 L23 18.4 L12 24.8 L1 18.4 L1 5.6 Z" stroke={`url(#${grad})`} strokeWidth="0.9" />
          <path d="M12 -2.5 v2 M24.5 19.25 l-1.7 -1 M-0.5 19.25 l1.7 -1" stroke={accent} strokeWidth="0.9" />
        </g>
      )}
      <g transform={framed ? "translate(12 12) scale(0.62) translate(-12 -12)" : undefined} filter={`url(#${glow})`}>
        <path d={path} fill={`url(#${grad})`} fillOpacity="0.9" stroke={color} strokeWidth="0.6" fillRule="evenodd" />
      </g>
    </svg>
  );
}
