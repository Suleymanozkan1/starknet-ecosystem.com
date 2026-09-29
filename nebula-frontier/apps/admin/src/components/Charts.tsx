import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { HoloPanel } from "@nebula/game-ui";

export interface SeriesSpec { key: string; label: string; format?: (v: number) => string }

const SLOTS = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)", "var(--series-5)"];

/**
 * Two-series comparison over time on ONE shared axis (no dual axes). When two measures have
 * different units the caller indexes them or uses separate charts. Legend + hover tooltip always on.
 */
export function TrendChart({ title, data, series, xKey = "date", height = 240, note }: {
  title: string; data: Record<string, number | string>[]; series: SeriesSpec[]; xKey?: string; height?: number; note?: string;
}) {
  const fmt = series[0]?.format ?? ((v: number) => v.toLocaleString());
  return (
    <HoloPanel title={title}>
      {data.length === 0 ? <div className="grid h-40 place-items-center text-[13px] text-mute">No data yet</div> : (
        <div style={{ height }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="rgba(140,200,255,0.08)" vertical={false} />
              <XAxis dataKey={xKey} tick={{ fill: "var(--nf-text-mute)", fontSize: 11 }} tickLine={false} axisLine={{ stroke: "rgba(140,200,255,0.18)" }} tickFormatter={(d: string) => String(d).slice(5, 10)} minTickGap={24} />
              <YAxis tick={{ fill: "var(--nf-text-mute)", fontSize: 11 }} tickLine={false} axisLine={false} width={64} tickFormatter={(v: number) => fmt(v)} />
              <Tooltip
                cursor={{ stroke: "rgba(140,200,255,0.35)", strokeWidth: 1 }}
                contentStyle={{ background: "rgba(8,13,26,0.96)", border: "1px solid rgba(140,200,255,0.28)", borderRadius: 8, fontSize: 12 }}
                labelStyle={{ color: "var(--nf-text-dim)" }}
                itemStyle={{ color: "var(--nf-text)" }}
                formatter={(v, name) => {
                  const s = series.find((x) => x.label === name);
                  return [(s?.format ?? fmt)(Number(v)), String(name)];
                }}
              />
              <Legend wrapperStyle={{ fontSize: 12, color: "var(--nf-text-dim)" }} iconType="plainline" />
              {series.map((s, i) => (
                <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={SLOTS[i]} strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--nf-bg)" }} isAnimationActive={false} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
      {note && <div className="mt-2 text-[11.5px] text-mute">{note}</div>}
    </HoloPanel>
  );
}
