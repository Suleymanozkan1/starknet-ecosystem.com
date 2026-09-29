import type { ShipDef } from "@nebula/shared";
import { useT } from "../lib/i18n.js";

/** Silhouette outlines (top-down, nose up) per hull archetype, in a 100x140 box. */
const HULLS: Record<string, string> = {
  dart: "M50 4 L60 60 L88 100 L62 96 L56 128 L44 128 L38 96 L12 100 L40 60 Z",
  arrowhead: "M50 6 L92 112 L64 100 L50 132 L36 100 L8 112 Z",
  wedge: "M50 8 L86 120 L50 108 L14 120 Z",
  hammer: "M36 10 H64 V40 H90 V70 H64 V128 H36 V70 H10 V40 H36 Z",
  manta: "M50 12 C70 20 96 70 94 96 C80 90 64 100 50 130 C36 100 20 90 6 96 C4 70 30 20 50 12 Z",
  spine: "M50 2 L56 40 L74 52 L58 62 L60 132 L40 132 L42 62 L26 52 L44 40 Z",
  crescent: "M50 10 C82 20 96 70 86 124 C74 96 62 86 50 88 C38 86 26 96 14 124 C4 70 18 20 50 10 Z",
  monolith: "M30 6 H70 L78 20 V124 L70 134 H30 L22 124 V20 Z",
  trident: "M50 4 L56 50 L70 20 L72 70 L90 60 L66 120 H34 L10 60 L28 70 L30 20 L44 50 Z",
  beetle: "M50 8 C76 8 90 40 90 78 C90 110 72 132 50 132 C28 132 10 110 10 78 C10 40 24 8 50 8 Z",
  needle: "M50 0 L56 90 L70 126 L50 116 L30 126 L44 90 Z",
  halo: "M50 14 A48 48 0 1 1 49.9 14 Z M50 38 A26 26 0 1 0 50.1 38 Z",
};

/** 2D holographic blueprint fallback for devices without WebGL. */
export function ShipBlueprint({ def }: { def: ShipDef }) {
  const t = useT();
  const v = def.visual;
  const path = HULLS[v.hull] ?? HULLS.dart!;
  return (
    <div className="absolute inset-0 grid place-items-center">
      <svg viewBox="-20 -10 140 160" className="h-[78%] max-h-[520px] w-auto" role="img" aria-label={t("ship.blueprintAria", { name: def.name })}>
        <defs>
          <linearGradient id="bp-hull" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={v.primaryColor} stopOpacity="0.9" />
            <stop offset="1" stopColor={v.secondaryColor} stopOpacity="0.6" />
          </linearGradient>
          <radialGradient id="bp-engine">
            <stop offset="0" stopColor="#fff" />
            <stop offset="0.4" stopColor={v.engineColor} />
            <stop offset="1" stopColor={v.engineColor} stopOpacity="0" />
          </radialGradient>
          <pattern id="bp-grid" width="10" height="10" patternUnits="userSpaceOnUse">
            <path d="M10 0H0V10" fill="none" stroke={v.engineColor} strokeOpacity="0.12" strokeWidth="0.4" />
          </pattern>
        </defs>
        <rect x="-20" y="-10" width="140" height="160" fill="url(#bp-grid)" />
        <circle cx="50" cy="70" r="66" fill="none" stroke={v.engineColor} strokeOpacity="0.18" strokeDasharray="2 4" />
        {v.nozzles.map(([x], i) => (
          <ellipse key={i} cx={50 + x * 14} cy={136} rx="7" ry="12" fill="url(#bp-engine)">
            <animate attributeName="ry" values="10;15;10" dur="0.6s" repeatCount="indefinite" />
          </ellipse>
        ))}
        <path d={path} fill="url(#bp-hull)" fillRule="evenodd" stroke={v.accentColor} strokeWidth="1.2" style={{ filter: `drop-shadow(0 0 6px ${v.engineColor})` }} />
        <path d={path} fill="none" stroke="#fff" strokeOpacity="0.25" strokeWidth="0.4" transform="translate(50 70) scale(0.82) translate(-50 -70)" />
        <ellipse cx="50" cy="40" rx="5" ry="9" fill={v.engineColor} fillOpacity="0.8" />
        {v.hardpoints.map(([x, , z], i) => (
          <circle key={i} cx={50 + x * 30} cy={70 - z * 22} r="2.4" fill={v.accentColor} />
        ))}
      </svg>
    </div>
  );
}
