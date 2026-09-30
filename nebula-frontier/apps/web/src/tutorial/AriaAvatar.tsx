import { useId } from "react";
import { useReducedMotion } from "./TypedText.js";

export const ARIA_NAME = "ARIA";

/**
 * ARIA — original holographic co-pilot avatar: a stylised flight-helmet head projected from a small
 * emitter, with visor eyes, voice bars, scanlines and a rotating targeting ring. Pure inline SVG + CSS
 * (index.css `.nf-aria-avatar*`); animations stop under reduced motion.
 */
export function AriaAvatar({ size = 56, speaking = false, tone = "info", className }: { size?: number; speaking?: boolean; tone?: "info" | "good" | "warn" | "danger"; className?: string }) {
  const still = useReducedMotion();
  const uid = useId().replace(/:/g, "");
  const id = (s: string): string => `aria-${uid}-${s}`;
  return (
    <span
      className={`nf-aria-avatar${className ? ` ${className}` : ""}`}
      data-speaking={speaking}
      data-still={still}
      data-tone={tone}
      style={{ width: size, height: size }}
      aria-hidden
    >
      <svg viewBox="0 0 100 100" width={size} height={size} focusable="false">
        <defs>
          <radialGradient id={id("glow")} cx="50%" cy="46%" r="52%">
            <stop offset="0%" stopColor="var(--aria-a)" stopOpacity="0.34" />
            <stop offset="60%" stopColor="var(--aria-b)" stopOpacity="0.1" />
            <stop offset="100%" stopColor="var(--aria-b)" stopOpacity="0" />
          </radialGradient>
          <linearGradient id={id("shell")} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--aria-a)" stopOpacity="0.55" />
            <stop offset="70%" stopColor="var(--aria-a)" stopOpacity="0.14" />
            <stop offset="100%" stopColor="var(--aria-b)" stopOpacity="0.05" />
          </linearGradient>
          <linearGradient id={id("beam")} x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor="var(--aria-a)" stopOpacity="0.45" />
            <stop offset="100%" stopColor="var(--aria-a)" stopOpacity="0" />
          </linearGradient>
          <pattern id={id("scan")} width="4" height="3" patternUnits="userSpaceOnUse">
            <rect width="4" height="1" fill="#fff" fillOpacity="0.14" />
          </pattern>
          <clipPath id={id("clip")}>
            <circle cx="50" cy="50" r="44" />
          </clipPath>
        </defs>

        <circle cx="50" cy="50" r="46" fill={`url(#${id("glow")})`} />
        {/* targeting ring */}
        <g className="nf-aria-avatar__ring">
          <circle cx="50" cy="50" r="45" fill="none" stroke="var(--aria-a)" strokeOpacity="0.55" strokeWidth="1.2" strokeDasharray="10 5 2 5" />
          <circle cx="50" cy="5" r="1.8" fill="var(--aria-a)" />
        </g>
        <circle cx="50" cy="50" r="39" fill="none" stroke="var(--aria-b)" strokeOpacity="0.35" strokeWidth="0.8" />

        {/* emitter + light cone */}
        <path d="M34 92 L42 70 L58 70 L66 92 Z" fill={`url(#${id("beam")})`} />
        <ellipse cx="50" cy="92" rx="16" ry="3.2" fill="none" stroke="var(--aria-a)" strokeOpacity="0.8" strokeWidth="1.4" />

        <g className="nf-aria-avatar__holo" clipPath={`url(#${id("clip")})`}>
          <g className="nf-aria-avatar__head">
            {/* helmet shell */}
            <path d="M50 17 C33 17 24 30 24 46 C24 58 29 68 37 74 L44 79 L56 79 L63 74 C71 68 76 58 76 46 C76 30 67 17 50 17 Z" fill={`url(#${id("shell")})`} stroke="var(--aria-a)" strokeWidth="1.6" />
            {/* crest + side comms fins */}
            <path d="M50 17 L50 31" stroke="var(--aria-a)" strokeWidth="1.4" strokeOpacity="0.9" />
            <path d="M43 20 L46 30 M57 20 L54 30" stroke="var(--aria-a)" strokeWidth="0.9" strokeOpacity="0.6" />
            <path d="M24 44 L19 42 L19 56 L25 55" fill="none" stroke="var(--aria-b)" strokeWidth="1.4" />
            <path d="M76 44 L81 42 L81 56 L75 55" fill="none" stroke="var(--aria-b)" strokeWidth="1.4" />
            {/* visor */}
            <path d="M29 42 Q50 34 71 42 L68 55 Q50 61 32 55 Z" fill="#031019" fillOpacity="0.88" stroke="var(--aria-a)" strokeWidth="1.3" />
            <path d="M33 44 Q50 38 67 44" fill="none" stroke="#fff" strokeOpacity="0.35" strokeWidth="0.8" />
            <g className="nf-aria-avatar__eyes">
              <rect x="36.5" y="47" width="10" height="3.4" rx="1.7" fill="var(--aria-a)" />
              <rect x="53.5" y="47" width="10" height="3.4" rx="1.7" fill="var(--aria-a)" />
            </g>
            {/* voice bars */}
            <g transform="translate(40 65)">
              {[0, 1, 2, 3, 4].map((i) => (
                <rect key={i} className="nf-aria-avatar__bar" x={i * 4.4} y="-3" width="2.2" height="6" rx="1" fill="var(--aria-a)" fillOpacity="0.85" style={{ animationDelay: `${[0, 0.18, 0.08, 0.26, 0.12][i]}s` }} />
              ))}
            </g>
          </g>
          <rect className="nf-aria-avatar__scan" x="0" y="-6" width="100" height="112" fill={`url(#${id("scan")})`} />
        </g>
      </svg>
    </span>
  );
}
