import type { CSSProperties } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { NPCS_BY_ID } from "@nebula/config";
import { Countdown, HoloPanel, Icon, NeonButton } from "@nebula/game-ui";
import type { GameEventDto } from "../lib/dto.js";
import { useEvents } from "../lib/queries.js";
import { eventTimes } from "../lib/api.js";
import { mapName } from "../lib/gameMeta.js";
import { contentText, enumLabel, useT } from "../lib/i18n.js";
import { PageHeader } from "../components/PageHeader.js";
import { EmptyState, QueryState } from "../components/QueryState.js";
import { RewardChips } from "../components/RewardChips.js";

const TYPE_COLOR: Record<string, string> = {
  GLOBAL_RIFT: "#c084fc", WORLD_BOSS: "#f43f5e", INVASION: "#fb923c", FACTION_WAR: "#fb5a7a", DOUBLE_XP: "#a78bfa",
  MINING_FESTIVAL: "#5eead4", PVP_WEEKEND: "#f87171", TREASURE_HUNT: "#fbbf24", RAID_EVENT: "#ef4444",
};

function EventCard({ e, live, focused }: { e: GameEventDto; live: boolean; focused: boolean }) {
  const tr = useT();
  const navigate = useNavigate();
  const color = TYPE_COLOR[e.type] ?? "var(--nf-accent)";
  const t = eventTimes(e);
  return (
    <HoloPanel accent={color} glow={live || focused} id={`event-${e.id}`}>
      <div className="grid gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="nf-label" style={{ color }}>{enumLabel(e.type)}</div>
            <div className="nf-display text-[19px] font-bold tracking-[0.06em]">{e.name}</div>
          </div>
          <div className="text-right">
            <div className="nf-label">{live ? tr("common.endsIn") : tr("common.startsIn")}</div>
            <Countdown to={live ? t.end : t.start} className="text-[17px]" />
          </div>
        </div>
        <p className="m-0 text-[13.5px] text-dim">{contentText("event", e.id, e.description)}</p>
        <div className="flex flex-wrap gap-1.5">
          {e.maps.map((m) => <span key={m} className="nf-chip"><Icon name="map" size={11} />{mapName(m)}</span>)}
          {e.boss && <span className="nf-chip" style={{ color: "var(--nf-bad)" }}><Icon name="crown" size={11} />{NPCS_BY_ID.get(e.boss)?.name ?? e.boss}</span>}
          {e.xpMultiplier !== 1 ? <span className="nf-chip" style={{ color: "#a78bfa" }}>×{e.xpMultiplier} XP</span> : null}
          {e.dropMultiplier !== 1 ? <span className="nf-chip" style={{ color: "#fbbf24" }}>{tr("events.drops", { n: e.dropMultiplier })}</span> : null}
        </div>
        {e.rewards.length > 0 && (
          <div className="grid gap-1.5 border-t border-line pt-3">
            <div className="nf-label">{tr("events.contribution")}</div>
            {e.rewards.map((r) => (
              <div key={r.tier} className="flex flex-wrap items-center gap-3 text-[13px]"><span className="nf-ui w-24 font-bold">{enumLabel(r.tier)}</span><span className="text-mute">{tr("events.pts", { n: r.minContribution })}</span><RewardChips bundle={r.bundle} size={12} /></div>
            ))}
          </div>
        )}
        {live && <NeonButton size="sm" variant="primary" onClick={() => navigate("/play")} icon={<Icon name="play" size={14} />}>{tr("events.join")}</NeonButton>}
      </div>
    </HoloPanel>
  );
}

export default function EventsPage() {
  const { eventId } = useParams();
  const t = useT();
  const q = useEvents();
  return (
    <div>
      <PageHeader eyebrow={t("events.eyebrow")} title={t("nav.events")} subtitle={t("events.subtitle")} />
      <QueryState q={q} isEmpty={(d) => d.active.length + d.upcoming.length === 0} empty={<EmptyState title={t("events.empty")} icon="events" />}>
        {(d) => {
          const rift = d.active.find((e) => e.type === "GLOBAL_RIFT");
          return (
            <div className="grid gap-5">
              {rift && (
                <div className="nf-panel relative overflow-hidden" style={{ "--nf-accent": "#c084fc" } as CSSProperties}>
                  <div className="absolute inset-0 opacity-70" style={{ background: "radial-gradient(circle at 20% 50%, rgba(192,132,252,0.45), transparent 50%), repeating-linear-gradient(115deg, transparent 0 18px, rgba(192,132,252,0.08) 18px 20px)" }} />
                  <div className="relative flex flex-wrap items-center gap-5 p-6">
                    <span className="text-accent"><Icon name="warning" size={42} /></span>
                    <div className="min-w-0 flex-1">
                      <div className="nf-eyebrow">{t("events.riftDetected")}</div>
                      <div className="nf-display text-[clamp(22px,3vw,34px)] font-black tracking-[0.08em]">{rift.name}</div>
                      <div className="text-[13.5px] text-dim">{contentText("event", rift.id, rift.description)}</div>
                    </div>
                    <div className="text-right"><div className="nf-label">{t("events.collapsesIn")}</div><Countdown to={eventTimes(rift).end} className="text-[26px]" /></div>
                  </div>
                </div>
              )}
              <section>
                <h2 className="nf-eyebrow mb-3">{t("events.activeNow", { n: d.active.length })}</h2>
                {d.active.length === 0 ? <div className="text-[13px] text-mute">{t("events.noLive")}</div> : <div className="grid gap-4 lg:grid-cols-2">{d.active.map((e) => <EventCard key={e.id} e={e} live focused={e.id === eventId} />)}</div>}
              </section>
              <section>
                <h2 className="nf-eyebrow mb-3">{t("events.upcoming", { n: d.upcoming.length })}</h2>
                <div className="grid gap-4 lg:grid-cols-2">{d.upcoming.map((e) => <EventCard key={e.id} e={e} live={false} focused={e.id === eventId} />)}</div>
              </section>
            </div>
          );
        }}
      </QueryState>
    </div>
  );
}
