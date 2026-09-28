import { useMemo, useState } from "react";
import { FACTIONS_BY_ID, GALAXY, MAPS, MAPS_BY_ID } from "@nebula/config";
import { FactionEmblem, HoloPanel, Icon, NeonButton } from "@nebula/game-ui";
import type { MapDef } from "@nebula/shared";
import { useNavigate } from "react-router-dom";
import { useGalaxy } from "../lib/queries.js";
import { ROOM_META, ZONE_META, humanize } from "../lib/gameMeta.js";
import { PageHeader } from "../components/PageHeader.js";
import { useSession } from "../hooks/useSession.js";

interface Node { map: MapDef; x: number; y: number; sector: string; color: string }

function mapColor(m: MapDef): string {
  if (m.factionHome) return FACTIONS_BY_ID.get(m.factionHome)?.color ?? "#6ee7ff";
  if (m.roomType === "boss" || m.roomType === "raid") return ZONE_META.BOSS!.color;
  if (m.roomType === "gate") return ZONE_META.GATE!.color;
  if (m.roomType === "pvp" || m.pvp) return ZONE_META.PVP!.color;
  if (m.zones.some((z) => z.type === "HIGH_RISK")) return ZONE_META.HIGH_RISK!.color;
  if (m.zones.some((z) => z.type === "MINING") && m.zones.filter((z) => z.type === "MINING").length > 1) return ZONE_META.MINING!.color;
  return ZONE_META.NEUTRAL!.color;
}

/** Deterministic radial layout: sectors on a ring, maps orbiting their sector. */
function layout(): { nodes: Node[]; sectors: { id: string; name: string; x: number; y: number }[] } {
  const secs = GALAXY.sectors;
  const nodes: Node[] = [];
  const sectors = secs.map((s, i) => {
    const a = (i / secs.length) * Math.PI * 2 - Math.PI / 2;
    const x = 50 + Math.cos(a) * 34;
    const y = 50 + Math.sin(a) * 34;
    const maps = s.systems.flatMap((sys) => sys.maps);
    maps.forEach((mid, j) => {
      const m = MAPS_BY_ID.get(mid);
      if (!m) return;
      const b = a + (maps.length > 1 ? (j - (maps.length - 1) / 2) * 0.9 : 0);
      const r = maps.length > 1 ? 7 : 0;
      nodes.push({ map: m, x: x + Math.cos(b + Math.PI / 2) * r, y: y + Math.sin(b + Math.PI / 2) * r, sector: s.name, color: mapColor(m) });
    });
    return { id: s.id, name: s.name, x, y };
  });
  return { nodes, sectors };
}

export default function GalaxyPage() {
  const me = useSession();
  const navigate = useNavigate();
  const live = useGalaxy();
  const { nodes, sectors } = useMemo(layout, []);
  const byId = useMemo(() => new Map(nodes.map((n) => [n.map.id, n])), [nodes]);
  const home = me.faction ? FACTIONS_BY_ID.get(me.faction)?.homeMap : undefined;
  const [sel, setSel] = useState<string>(home ?? MAPS[0]?.id ?? "");
  const selected = byId.get(sel);
  const liveNode = live.data?.maps?.find((m) => m.id === sel);

  const edges = useMemo(() => {
    const seen = new Set<string>();
    const out: { a: Node; b: Node; kind: string }[] = [];
    for (const n of nodes) for (const p of n.map.portals) {
      const t = byId.get(p.targetMap);
      if (!t) continue;
      const k = [n.map.id, t.map.id].sort().join("|");
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ a: n, b: t, kind: p.kind });
    }
    return out;
  }, [nodes, byId]);

  const m = selected?.map;
  const zones = m ? [...new Set(m.zones.map((z) => z.type))] : [];
  return (
    <div>
      <PageHeader eyebrow={GALAXY.name} title="Galaxy map" subtitle="Sectors, systems and jump routes. Travel happens in-flight through portals and jump gates." />
      <div className="grid gap-5 xl:grid-cols-[1fr_360px]">
        <HoloPanel padded={false} corners className="relative">
          <svg viewBox="0 0 100 100" className="block aspect-square max-h-[74vh] w-full" role="img" aria-label="Galaxy map">
            <defs>
              <radialGradient id="gx-core"><stop offset="0" stopColor="var(--nf-accent)" stopOpacity="0.35" /><stop offset="1" stopColor="var(--nf-accent)" stopOpacity="0" /></radialGradient>
              <filter id="gx-glow"><feGaussianBlur stdDeviation="0.6" /></filter>
            </defs>
            <circle cx="50" cy="50" r="46" fill="url(#gx-core)" />
            {[14, 26, 34, 42].map((r) => <circle key={r} cx="50" cy="50" r={r} fill="none" stroke="rgba(140,200,255,0.08)" strokeWidth="0.15" strokeDasharray="0.6 0.8" />)}
            {sectors.map((s) => (
              <g key={s.id}>
                <circle cx={s.x} cy={s.y} r="10.5" fill="rgba(140,200,255,0.025)" stroke="rgba(140,200,255,0.12)" strokeWidth="0.15" />
                <text x={s.x} y={s.y - 11.8} textAnchor="middle" fontSize="1.9" fill="var(--nf-text-mute)" style={{ fontFamily: "var(--nf-font-ui)", letterSpacing: "0.25em", textTransform: "uppercase" }}>{s.name}</text>
              </g>
            ))}
            {edges.map((e, i) => (
              <line key={i} x1={e.a.x} y1={e.a.y} x2={e.b.x} y2={e.b.y} stroke={e.kind === "PORTAL" ? "rgba(140,200,255,0.35)" : "rgba(192,132,252,0.5)"} strokeWidth="0.25" strokeDasharray={e.kind === "PORTAL" ? undefined : "0.8 0.6"} />
            ))}
            {nodes.map((n) => {
              const active = n.map.id === sel;
              const isHome = n.map.id === home;
              return (
                <g key={n.map.id} transform={`translate(${n.x} ${n.y})`} style={{ cursor: "pointer" }} onClick={() => setSel(n.map.id)} role="button" aria-label={n.map.name} tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") setSel(n.map.id); }}>
                  {active && <circle r="3.6" fill="none" stroke={n.color} strokeWidth="0.3"><animate attributeName="r" values="3;4.2;3" dur="2s" repeatCount="indefinite" /></circle>}
                  <circle r="2.2" fill={n.color} opacity="0.25" filter="url(#gx-glow)" />
                  <circle r={active ? 1.7 : 1.35} fill="#050a14" stroke={n.color} strokeWidth="0.45" />
                  <circle r="0.55" fill={n.color} />
                  {isHome && <path d="M0 -3.4 L0.7 -2.4 L-0.7 -2.4 Z" fill={n.color} />}
                  <text y="3.9" textAnchor="middle" fontSize="1.55" fill={active ? "#fff" : "var(--nf-text-dim)"} style={{ fontFamily: "var(--nf-font-ui)", fontWeight: 700 }}>{n.map.name}</text>
                </g>
              );
            })}
          </svg>
          <div className="flex flex-wrap gap-2 border-t border-line p-3">
            {["SAFE", "NEUTRAL", "PVP", "HIGH_RISK", "MINING", "GATE", "BOSS"].map((z) => (
              <span key={z} className="nf-chip text-[10.5px]" style={{ color: ZONE_META[z]?.color }}><span className="h-2 w-2 rounded-full" style={{ background: ZONE_META[z]?.color }} />{ZONE_META[z]?.label}</span>
            ))}
          </div>
        </HoloPanel>

        {m && selected && (
          <HoloPanel title="Sector intel" accent={selected.color} glow>
            <div className="grid gap-4">
              <div>
                <div className="nf-label">{selected.sector}</div>
                <div className="nf-display text-[24px] font-bold tracking-[0.08em]" style={{ color: selected.color }}>{m.name}</div>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  <span className="nf-chip"><Icon name={ROOM_META[m.roomType]?.icon ?? "galaxy"} size={12} />{ROOM_META[m.roomType]?.label ?? m.roomType}</span>
                  <span className="nf-chip">Lv {m.levelRange[0]}–{m.levelRange[1]}</span>
                  {m.pvp && <span className="nf-chip" style={{ color: "var(--nf-bad)" }}>PvP</span>}
                  {m.id === home && <span className="nf-chip" style={{ color: selected.color }}>Home</span>}
                </div>
              </div>
              {m.factionHome && FACTIONS_BY_ID.get(m.factionHome) && (
                <div className="flex items-center gap-2 text-[13px] text-dim">
                  <FactionEmblem path={FACTIONS_BY_ID.get(m.factionHome)!.emblem} color={selected.color} size={22} framed={false} />
                  Homeworld of {FACTIONS_BY_ID.get(m.factionHome)!.name}
                </div>
              )}
              <div className="grid gap-1.5">
                <div className="nf-label">Zones</div>
                <div className="flex flex-wrap gap-1.5">{zones.map((z) => <span key={z} className="nf-chip" style={{ color: ZONE_META[z]?.color }}>{ZONE_META[z]?.label ?? z}</span>)}</div>
              </div>
              {liveNode && (liveNode.population !== undefined || liveNode.controlledBy) && (
                <div className="grid grid-cols-2 gap-2 text-[13px]">
                  {liveNode.population !== undefined && <div><div className="nf-label">Pilots online</div><div className="nf-display text-[18px] font-bold">{liveNode.population}</div></div>}
                  {liveNode.controlledBy && <div><div className="nf-label">Controlled by</div><div className="nf-ui text-[15px] font-bold">{liveNode.controlledBy.clanTag ? `[${liveNode.controlledBy.clanTag}]` : humanize(liveNode.controlledBy.faction ?? "")}</div></div>}
                </div>
              )}
              <div className="grid gap-1.5">
                <div className="nf-label">Stations</div>
                {m.stations.length === 0 ? <div className="text-[13px] text-mute">No stations — no safe docking.</div> : m.stations.map((s) => (
                  <div key={s.id} className="text-[13px]"><b className="nf-ui text-[14px]">{s.name}</b> <span className="text-mute">· {s.services.map(humanize).join(", ")}</span></div>
                ))}
              </div>
              <div className="grid gap-1.5">
                <div className="nf-label">Jump routes</div>
                {m.portals.map((p) => (
                  <button key={p.id} type="button" className="flex items-center justify-between rounded-md border border-line px-3 py-2 text-left text-[13px] hover:border-accent" onClick={() => setSel(p.targetMap)}>
                    <span>{MAPS_BY_ID.get(p.targetMap)?.name ?? p.targetMap}</span>
                    <span className="nf-label">{humanize(p.kind)}{p.requiredLevel > 1 ? ` · Lv ${p.requiredLevel}` : ""}</span>
                  </button>
                ))}
              </div>
              <NeonButton variant="primary" block onClick={() => navigate("/play")} icon={<Icon name="play" size={16} />}>Launch</NeonButton>
            </div>
          </HoloPanel>
        )}
      </div>
    </div>
  );
}
