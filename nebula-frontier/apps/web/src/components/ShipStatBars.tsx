import { SHIPS } from "@nebula/config";
import { StatBar } from "@nebula/game-ui";

const ROWS: { key: string; label: string; color: string }[] = [
  { key: "hull", label: "Hull", color: "#34d399" },
  { key: "shield", label: "Shield", color: "#60a5fa" },
  { key: "armor", label: "Armor", color: "#cbd5e1" },
  { key: "speed", label: "Speed", color: "#fbbf24" },
  { key: "energy", label: "Energy", color: "#fde047" },
  { key: "cargo", label: "Cargo", color: "#a78bfa" },
];

/** Max of each stat across the whole ship catalog → bars are comparable between ships. */
const MAX: Record<string, number> = Object.fromEntries(
  ROWS.map((r) => [r.key, Math.max(1, ...SHIPS.map((s) => (s.stats as unknown as Record<string, number>)[r.key] ?? 0))]),
);

export function ShipStatBars({ stats, compare }: { stats: Record<string, number>; compare?: Record<string, number> | null }) {
  return (
    <div className="grid gap-2.5">
      {ROWS.map((r) => {
        const v = stats[r.key] ?? 0;
        const c = compare?.[r.key];
        const diff = c === undefined ? null : v - c;
        return (
          <div key={r.key} className="relative">
            <StatBar
              label={r.label}
              value={v}
              max={MAX[r.key] ?? 1}
              color={r.color}
              height={6}
              ghost={false}
              format={() => (diff === null || diff === 0 ? Math.round(v).toLocaleString() : `${Math.round(v).toLocaleString()} (${diff > 0 ? "+" : ""}${Math.round(diff).toLocaleString()})`)}
            />
          </div>
        );
      })}
    </div>
  );
}
