import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { MAPS_BY_ID } from "@nebula/config";
import { Icon, NeonButton, StatBar, STAT_COLORS } from "@nebula/game-ui";
import type { IconName } from "@nebula/game-ui";
import type { HudEvent, HudSkill, HudView } from "./hudModel.js";
import type { GameActions } from "./adapter.js";
import { useSettings } from "../store/settings.js";
import { ZONE_META, humanize } from "../lib/gameMeta.js";

/* ------------------------------------------------------------------ top-left: own ship */
export function ShipStatus({ hud, compact }: { hud: HudView; compact?: boolean }) {
  return (
    <div className="nf-hud-panel grid gap-1.5 p-2.5" style={{ width: compact ? 190 : 280 }}>
      <StatBar label={compact ? undefined : "Shield"} value={hud.shield.value} max={hud.shield.max} color={STAT_COLORS.shield} height={compact ? 6 : 8} showValue={!compact} />
      <StatBar label={compact ? undefined : "Hull"} value={hud.hull.value} max={hud.hull.max} color={STAT_COLORS.hull} height={compact ? 6 : 8} showValue={!compact} />
      <StatBar label={compact ? undefined : "Energy"} value={hud.energy.value} max={hud.energy.max} color={STAT_COLORS.energy} height={compact ? 4 : 5} showValue={!compact} />
      {!compact && (
        <div className="flex items-center justify-between pt-0.5 text-[11px] uppercase tracking-[0.14em] text-dim">
          <span>Speed <b className="tabular-nums text-ink">{Math.round(hud.speed)}</b></span>
          {hud.ammo.map((a) => <span key={a.label}>{a.label} <b className="tabular-nums text-ink">{a.count ?? "∞"}</b></span>)}
        </div>
      )}
    </div>
  );
}

export function TargetPanel({ hud, onClear }: { hud: HudView; onClear: () => void }) {
  const t = hud.target;
  if (!t) return null;
  return (
    <div className="nf-hud-panel grid w-[260px] gap-1.5 p-2.5" style={{ borderColor: t.hostile ? "color-mix(in oklab, var(--nf-bad) 60%, transparent)" : undefined }}>
      <div className="flex items-center gap-2">
        <span style={{ color: t.hostile ? "var(--nf-bad)" : "var(--nf-good)" }}><Icon name="target" size={16} /></span>
        <span className="truncate text-[15px] font-bold">{t.name}</span>
        <span className="text-[11px] text-mute">Lv {t.level}</span>
        <button type="button" className="ml-auto text-mute hover:text-ink" onClick={onClear} aria-label="Clear target"><Icon name="close" size={14} /></button>
      </div>
      <StatBar value={t.shield.value} max={t.shield.max} color={STAT_COLORS.shield} height={5} showValue={false} />
      <StatBar value={t.hull.value} max={t.hull.max} color={STAT_COLORS.hull} height={6} showValue={false} />
      <div className="flex justify-between text-[11px] uppercase tracking-[0.12em] text-dim"><span>{humanize(t.kind)}</span>{t.distance !== null && <span>{Math.round(t.distance)} m</span>}</div>
    </div>
  );
}

export function BossBar({ hud }: { hud: HudView }) {
  const b = hud.boss;
  if (!b) return null;
  return (
    <div className="nf-hud-panel grid w-[min(620px,90vw)] gap-1 px-4 py-2" style={{ borderColor: "color-mix(in oklab, var(--nf-bad) 50%, transparent)" }}>
      <div className="flex items-baseline justify-between">
        <span className="nf-display text-[15px] font-bold tracking-[0.14em] text-bad">{b.name}</span>
        <span className="text-[11px] uppercase tracking-[0.16em] text-dim">Phase {b.phase}/{b.phases} · {b.phaseName} · {humanize(b.layer)} exposed</span>
      </div>
      <StatBar value={b.shield.value} max={b.shield.max} color={STAT_COLORS.shield} height={4} showValue={false} />
      <StatBar value={b.hull.value} max={b.hull.max} color={STAT_COLORS.boss} height={10} showValue={false} />
      <div className="relative h-0">
        {Array.from({ length: Math.max(0, b.phases - 1) }, (_, i) => <span key={i} className="absolute -top-[12px] h-[10px] w-px bg-white/60" style={{ left: `${((i + 1) / b.phases) * 100}%` }} />)}
      </div>
    </div>
  );
}

const SKILL_ICON: Record<string, IconName> = { ABILITY: "zap", MODULE: "module", ULTIMATE: "ultimate" };

export function SkillButton({ s, onUse, size = 52 }: { s: HudSkill; onUse: () => void; size?: number }) {
  const ready = s.remainingMs <= 0;
  const p = s.cooldownMs > 0 ? Math.min(1, s.remainingMs / s.cooldownMs) : 0;
  return (
    <button type="button" className="nf-skill" data-ready={ready} style={{ width: size, height: size, "--p": `${p * 100}%` } as CSSProperties} onClick={onUse} title={`${s.name} (${s.key})`} aria-label={`${s.name}, key ${s.key}${ready ? "" : ", cooling down"}`}>
      <Icon name={SKILL_ICON[s.kind] ?? "zap"} size={size * 0.42} />
      {!ready && <span className="nf-skill__sweep" />}
      {!ready && <span className="nf-skill__cd">{Math.ceil(s.remainingMs / 1000)}</span>}
      <span className="nf-skill__key">{s.key}</span>
      {s.active && <span className="absolute inset-0 rounded-[10px] ring-2 ring-accent" />}
    </button>
  );
}

export function SkillBar({ hud, actions }: { hud: HudView; actions: GameActions }) {
  return (
    <div className="nf-hud-panel flex gap-1.5 p-1.5">
      {hud.skills.slice(0, 9).map((s) => <SkillButton key={s.slot} s={s} onUse={() => actions.useSkill(s.slot)} />)}
    </div>
  );
}

export function QuestTracker({ hud }: { hud: HudView }) {
  const q = hud.quest;
  if (!q) return null;
  return (
    <div className="nf-hud-panel grid w-[250px] gap-1.5 p-2.5">
      <div className="text-[10.5px] font-bold uppercase tracking-[0.2em] text-accent">Objective</div>
      <div className="text-[14px] font-bold">{q.name}</div>
      {q.objectives.map((o, i) => (
        <div key={i} className="flex justify-between text-[12.5px]" style={{ color: o.progress >= o.count ? "var(--nf-good)" : "var(--nf-text-dim)" }}>
          <span className="truncate">{o.label}</span><span className="tabular-nums">{o.progress}/{o.count}</span>
        </div>
      ))}
    </div>
  );
}

export function SquadFrames({ hud }: { hud: HudView }) {
  if (hud.squad.length === 0) return null;
  return (
    <div className="grid gap-1.5">
      {hud.squad.map((m) => (
        <div key={m.id} className="nf-hud-panel grid w-[170px] gap-1 px-2 py-1.5" style={{ opacity: m.dead ? 0.5 : 1 }}>
          <div className="truncate text-[12.5px] font-bold">{m.name}</div>
          <StatBar value={m.shield.value} max={m.shield.max} color={STAT_COLORS.shield} height={3} showValue={false} ghost={false} />
          <StatBar value={m.hull.value} max={m.hull.max} color={STAT_COLORS.hull} height={4} showValue={false} ghost={false} />
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ transient layers */
interface Floating { id: number; x: number; y: number; text: string; crit: boolean; color: string }
interface FeedItem { id: number; text: string; pvp: boolean }

export function useHudEventLayers() {
  const [floats, setFloats] = useState<Floating[]>([]);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const nextId = useRef(1);
  const push = (e: HudEvent): void => {
    if (e.type === "damage") {
      const id = nextId.current++;
      const color = e.incoming ? "#fb7185" : e.shield ? "#93c5fd" : "#fef3c7";
      setFloats((f) => [...f.slice(-40), { id, x: e.x, y: e.y, text: `${Math.round(e.amount)}`, crit: e.crit, color }]);
      window.setTimeout(() => setFloats((f) => f.filter((x) => x.id !== id)), 950);
    } else if (e.type === "killfeed") {
      const id = nextId.current++;
      setFeed((f) => [...f.slice(-4), { id, text: `${e.killer} ⟶ ${e.victim}`, pvp: e.pvp }]);
      window.setTimeout(() => setFeed((f) => f.filter((x) => x.id !== id)), 6000);
    }
  };
  return { floats, feed, push };
}

export function DamageLayer({ floats }: { floats: Floating[] }) {
  const show = useSettings((s) => s.showDamageNumbers);
  if (!show) return null;
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      {floats.map((f) => <span key={f.id} className={`nf-dmg${f.crit ? " nf-dmg--crit" : ""}`} style={{ left: f.x, top: f.y, color: f.crit ? undefined : f.color }}>{f.text}{f.crit ? "!" : ""}</span>)}
    </div>
  );
}

export function KillFeed({ feed }: { feed: FeedItem[] }) {
  return (
    <div className="grid justify-items-end gap-1" aria-live="polite">
      {feed.map((k) => <div key={k.id} className="nf-hud-panel px-2.5 py-1 text-[12.5px]" style={{ borderColor: k.pvp ? "color-mix(in oklab, var(--nf-bad) 50%, transparent)" : undefined }}>{k.text}</div>)}
    </div>
  );
}

/* ------------------------------------------------------------------ station / death / top strip */
const SERVICE_ROUTES: Record<string, { label: string; to: string; icon: IconName }> = {
  HANGAR: { label: "Hangar", to: "/hangar", icon: "hangar" },
  SHOP: { label: "Shop", to: "/shop", icon: "shop" },
  QUEST_BOARD: { label: "Missions", to: "/missions", icon: "missions" },
  CRAFTING: { label: "Crafting", to: "/crafting", icon: "crafting" },
  MARKET: { label: "Market", to: "/market", icon: "market" },
  CLAN: { label: "Clan", to: "/clan", icon: "clan" },
};

export function StationPanel({ hud, actions }: { hud: HudView; actions: GameActions }) {
  const navigate = useNavigate();
  const d = hud.docked;
  if (!d) return null;
  const services = d.services.filter((s) => s !== "DOCK");
  return (
    <div className="absolute inset-0 grid place-items-center bg-black/55 p-4 backdrop-blur-sm">
      <div className="nf-panel nf-panel--cut w-[min(560px,100%)] p-5">
        <div className="text-[11px] font-bold uppercase tracking-[0.28em] text-accent">Docked</div>
        <div className="nf-display mb-4 text-[24px] font-bold tracking-[0.08em]">{d.name}</div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {services.includes("REPAIR") && (
            <button type="button" className="nf-panel nf-panel--interactive grid justify-items-center gap-1.5 p-4" onClick={() => actions.repair()}>
              <Icon name="repair" size={24} /><span className="text-[13px] font-bold uppercase tracking-[0.12em]">Repair</span>
            </button>
          )}
          {services.map((s) => SERVICE_ROUTES[s]).filter((x): x is NonNullable<typeof x> => Boolean(x)).map((s) => (
            <button key={s.to} type="button" className="nf-panel nf-panel--interactive grid justify-items-center gap-1.5 p-4" onClick={() => navigate(s.to)}>
              <Icon name={s.icon} size={24} /><span className="text-[13px] font-bold uppercase tracking-[0.12em]">{s.label}</span>
            </button>
          ))}
        </div>
        <NeonButton className="mt-4" block variant="primary" onClick={() => actions.undock()} icon={<Icon name="rocket" size={16} />}>Undock</NeonButton>
      </div>
    </div>
  );
}

export function DeathScreen({ hud, actions }: { hud: HudView; actions: GameActions }) {
  const d = hud.dead;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!d) return undefined;
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, [d]);
  if (!d) return null;
  const wait = d.respawnAt ? Math.max(0, d.respawnAt - now) : 0;
  return (
    <div className="absolute inset-0 grid place-items-center p-4" style={{ background: "radial-gradient(circle, rgba(80,0,20,0.55), rgba(0,0,0,0.85))" }}>
      <div className="grid justify-items-center gap-3 text-center">
        <div className="text-[12px] font-bold uppercase tracking-[0.4em] text-bad">Ship destroyed</div>
        <div className="nf-display text-[clamp(30px,5vw,54px)] font-black tracking-[0.12em]">{d.killer ? `Downed by ${d.killer}` : "Hull breach"}</div>
        <div className="text-[14px] text-dim">Repair cost on respawn: <b className="text-credits">{d.repairCost.toLocaleString()} credits</b></div>
        <NeonButton variant="primary" size="lg" disabled={wait > 0} onClick={() => actions.respawn()}>{wait > 0 ? `Respawn in ${Math.ceil(wait / 1000)}s` : "Respawn at station"}</NeonButton>
      </div>
    </div>
  );
}

export function MapStrip({ hud }: { hud: HudView }) {
  const map = MAPS_BY_ID.get(hud.mapId);
  const zone = hud.zone ? ZONE_META[hud.zone] : undefined;
  return (
    <div className="nf-hud-panel flex items-center gap-2 px-3 py-1.5 text-[12px] uppercase tracking-[0.14em]">
      <span className="font-bold">{map?.name ?? hud.mapId}</span>
      {zone && <span style={{ color: zone.color }}>· {zone.label}</span>}
      <span className="flex items-center gap-1 text-mute"><Icon name="signal" size={12} style={{ color: hud.connection === "connected" ? "var(--nf-good)" : "var(--nf-warn)" }} />{hud.pingMs !== null ? `${hud.pingMs} ms` : humanize(hud.connection)}</span>
    </div>
  );
}
