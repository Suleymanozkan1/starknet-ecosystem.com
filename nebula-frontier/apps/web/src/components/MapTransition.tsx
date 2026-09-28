import { MAPS_BY_ID, GALAXY } from "@nebula/config";
import { ZONE_META } from "../lib/gameMeta.js";

export interface MapTransitionProps {
  mapId: string;
  /** "warp" when jumping through a portal, "launch" on first deploy. */
  mode?: "warp" | "launch";
  progress?: number;
}

/** Hyperspace transition shown while a sector loads (portal jump / initial launch). */
export function MapTransition({ mapId, mode = "warp", progress }: MapTransitionProps) {
  const map = MAPS_BY_ID.get(mapId);
  const sector = GALAXY.sectors.find((s) => s.id === map?.sector);
  const zones = [...new Set(map?.zones.map((z) => z.type) ?? [])];
  return (
    <div className="nf-warp" role="status" aria-live="polite">
      <div className="nf-warp__streaks" />
      <div className="absolute inset-0 grid place-items-center p-6 text-center">
        <div className="grid justify-items-center gap-3">
          <div className="nf-eyebrow">{mode === "warp" ? "Warp jump in progress" : "Launching"}</div>
          <div className="nf-h1 text-[clamp(28px,5vw,56px)]">{map?.name ?? mapId}</div>
          <div className="nf-ui text-[15px] uppercase tracking-[0.3em] text-dim">
            {sector?.name ?? "Unknown sector"}
            {map && <> · LVL {map.levelRange[0]}–{map.levelRange[1]}</>}
          </div>
          <div className="mt-2 flex flex-wrap justify-center gap-2">
            {map?.pvp && <span className="nf-chip" style={{ color: "var(--nf-bad)", borderColor: "var(--nf-bad)" }}>PvP enabled</span>}
            {zones.map((z) => (
              <span key={z} className="nf-chip" style={{ color: ZONE_META[z]?.color, borderColor: ZONE_META[z]?.color }}>{ZONE_META[z]?.label ?? z}</span>
            ))}
          </div>
          {progress !== undefined && (
            <div className="nf-loading__bar mt-4">
              <div className="nf-loading__fill" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
