import { SHIPS } from "@nebula/config";
import { StatBar } from "@nebula/game-ui";
import { fmtNum, useT } from "../lib/i18n.js";
import type { TKey } from "../lib/i18n.js";

const ROWS: { key: string; label: TKey; color: string }[] = [
  { key: "hull", label: "stat.hull", color: "#34d399" },
  { key: "shield", label: "stat.shield", color: "#60a5fa" },
  { key: "armor", label: "stat.armor", color: "#cbd5e1" },
  { key: "speed", label: "stat.speed", color: "#fbbf24" },
  { key: "energy", label: "stat.energy", color: "#fde047" },
  { key: "cargo", label: "stat.cargo", color: "#a78bfa" },
];

/** Max of each stat across the whole ship catalog → bars are comparable between ships. */
const MAX: Record<string, number> = Object.fromEntries(
  ROWS.map((r) => [r.key, Math.max(1, ...SHIPS.map((s) => (s.stats as unknown as Record<string, number>)[r.key] ?? 0))]),
);

export function ShipStatBars({ stats, compare }: { stats: Record<string, number>; compare?: Record<string, number> | null }) {
  const t = useT();
  return (
    <div className="grid gap-2.5">
      {ROWS.map((r) => {
        const v = stats[r.key] ?? 0;
        const c = compare?.[r.key];
        const diff = c === undefined ? null : v - c;
        return (
          <div key={r.key} className="relative">
            <StatBar
              label={t(r.label)}
              value={v}
              max={MAX[r.key] ?? 1}
              color={r.color}
              height={6}
              ghost={false}
              format={() => (diff === null || diff === 0 ? fmtNum(Math.round(v)) : `${fmtNum(Math.round(v))} (${diff > 0 ? "+" : ""}${fmtNum(Math.round(diff))})`)}
            />
          </div>
        );
      })}
    </div>
  );
}
