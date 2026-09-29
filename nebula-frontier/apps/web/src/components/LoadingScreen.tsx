import { useEffect, useState } from "react";

const TIPS = [
  "Shield generators recharge faster when you stop taking fire for a few seconds.",
  "Drones follow the formation you choose in the hangar — Turtle favours defense, Arrow favours damage.",
  "High-risk sectors drop better loot, but other pilots can engage you there.",
  "Gates are instanced wave encounters. Bring repair modules.",
  "Battle Rewards are granted for competitive play and events and are subject to season caps.",
  "Dock at a station to repair, craft and trade without leaving the map.",
];

export interface LoadingScreenProps {
  label?: string;
  /** 0..1, undefined = indeterminate */
  progress?: number;
  detail?: string;
}

/** Full screen branded loader with animated progress and rotating tips. */
export function LoadingScreen({ label = "Establishing uplink", progress, detail }: LoadingScreenProps) {
  const [tip, setTip] = useState(() => Math.floor(Math.random() * TIPS.length));
  useEffect(() => {
    const t = window.setInterval(() => setTip((i) => (i + 1) % TIPS.length), 4500);
    return () => window.clearInterval(t);
  }, []);
  const pct = progress === undefined ? undefined : Math.round(Math.max(0, Math.min(1, progress)) * 100);
  return (
    <div className="nf-loading" role="status" aria-live="polite" aria-label={label}>
      <div className="grid justify-items-center gap-6 px-6 text-center">
        <svg viewBox="0 0 100 100" className="nf-hexspin" aria-hidden>
          <defs>
            <linearGradient id="ls-g" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="var(--nf-accent)" />
              <stop offset="1" stopColor="var(--nf-accent-2)" />
            </linearGradient>
          </defs>
          <polygon points="50,4 90,27 90,73 50,96 10,73 10,27" fill="none" stroke="url(#ls-g)" strokeWidth="2" />
          <polygon points="50,18 78,34 78,66 50,82 22,66 22,34" fill="none" stroke="var(--nf-accent)" strokeOpacity="0.35" strokeWidth="1" strokeDasharray="4 5" />
          <circle cx="50" cy="50" r="7" fill="var(--nf-accent)" style={{ filter: "drop-shadow(0 0 8px var(--nf-accent))" }} />
        </svg>
        <div className="nf-logo text-[20px]">NEBULA <b>FRONTIER</b></div>
        <div className="grid gap-2 justify-items-center">
          <div className="nf-loading__bar">
            <div className={pct === undefined ? "nf-loading__fill nf-loading__fill--indeterminate" : "nf-loading__fill"} style={pct === undefined ? undefined : { width: `${pct}%` }} />
          </div>
          <div className="nf-ui flex w-[min(420px,78vw)] justify-between text-[12px] uppercase tracking-[0.24em] text-dim">
            <span>{label}</span>
            <span className="tabular-nums text-accent">{pct === undefined ? "" : `${pct}%`}</span>
          </div>
          {detail && <div className="text-[12px] text-mute">{detail}</div>}
        </div>
        <p className="max-w-[440px] text-[13px] leading-relaxed text-dim">
          <span className="nf-label mr-2">Tip</span>
          {TIPS[tip]}
        </p>
      </div>
    </div>
  );
}
