import { useLocation } from "react-router-dom";
import { DEMO_MODE } from "../lib/demoMode.js";

/**
 * Persistent marker for the static demo build: everything runs in this browser, nothing is real.
 * Hidden during gameplay (the game shows its own demo notice) so it never covers the HUD.
 */
export function DemoBadge() {
  const { pathname } = useLocation();
  if (!DEMO_MODE || pathname === "/play") return null;
  return (
    <div
      role="note"
      className="nf-chip pointer-events-none fixed left-1/2 z-50 -translate-x-1/2 whitespace-nowrap text-[11px] font-bold uppercase tracking-[0.18em]"
      style={{ top: "calc(6px + var(--safe-top))", background: "color-mix(in oklab, var(--nf-warn) 22%, #04060c)", color: "var(--nf-warn)", opacity: 0.92 }}
    >
      Demo · offline simulation · no real assets
    </div>
  );
}
