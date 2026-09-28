import type { CSSProperties } from "react";
import { Link, useNavigate } from "react-router-dom";
import { SHIPS_BY_ID } from "@nebula/config";
import { Countdown, CurrencyAmount, FactionEmblem, HoloPanel, Icon, RarityBadge, StatBar, STAT_COLORS } from "@nebula/game-ui";
import { useT } from "../lib/i18n.js";
import { useEvents, useQuests, useRewards, useShips } from "../lib/queries.js";
import { eventTimes } from "../lib/api.js";
import { faction, humanize, mapName, shortAddr } from "../lib/gameMeta.js";
import { useSession } from "../hooks/useSession.js";
import { useIsMobileUI } from "../hooks/useMediaQuery.js";
import { ShipViewer } from "../components/ShipViewer.js";
import { MAIN_MENU, SECONDARY_MENU } from "../components/nav.js";
import { haptic } from "../native/haptics.js";

function PlayHero() {
  const t = useT();
  const navigate = useNavigate();
  const me = useSession();
  const f = faction(me.faction);
  return (
    <button type="button" className="nf-play" onClick={() => { haptic("medium"); navigate("/play"); }} data-testid="play-hero" aria-label="Play — launch into the galaxy">
      <span className="nf-play__ring" />
      <span className="nf-play__ring nf-play__ring--2" />
      <span className="relative grid justify-items-center gap-2">
        <span className="nf-eyebrow">{t("play.ready")}</span>
        <span className="nf-display nf-glow-text text-[clamp(44px,6vw,84px)] font-black tracking-[0.3em] text-white">{t("nav.play").toUpperCase()}</span>
        <span className="nf-ui text-[13px] uppercase tracking-[0.26em] text-dim">{f ? `Deploy · ${mapName(f.homeMap)}` : "Deploy"}</span>
      </span>
    </button>
  );
}

function ShipCard() {
  const me = useSession();
  const ships = useShips();
  const inst = ships.data?.owned.find((s) => s.id === me.activeShipInstanceId);
  const def = inst ? SHIPS_BY_ID.get(inst.defId) : undefined;
  const loadout = inst?.loadouts.find((l) => l.id === inst.activeLoadoutId);
  return (
    <HoloPanel title="Active ship" actions={<Link to="/hangar" className="nf-ui text-[12px] uppercase tracking-[0.16em] text-accent no-underline">Hangar →</Link>} padded={false}>
      <div className="relative h-[220px] border-b border-line">
        {def ? <ShipViewer def={def} cosmetics={inst?.cosmetics} /> : <div className="nf-skeleton absolute inset-4" />}
      </div>
      <div className="grid gap-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="nf-display text-[20px] font-bold tracking-[0.08em]">{inst?.name ?? "—"}{inst && inst.upgradeLevel > 0 && <span className="text-accent"> +{inst.upgradeLevel}</span>}</div>
            <div className="nf-ui text-[12px] uppercase tracking-[0.18em] text-mute">{def ? `${humanize(def.class)} · Tier ${def.tier}` : ""}</div>
          </div>
          {def && <RarityBadge rarity={def.rarity} />}
        </div>
        <div className="grid grid-cols-3 gap-2 text-center">
          {[
            { k: "Gear score", v: inst?.gearScore ?? 0 },
            { k: "Hull", v: inst?.stats.hull ?? def?.stats.hull ?? 0 },
            { k: "Shield", v: inst?.stats.shield ?? def?.stats.shield ?? 0 },
          ].map((s) => (
            <div key={s.k} className="rounded-md border border-line bg-black/20 px-2 py-2">
              <div className="nf-display text-[16px] font-bold tabular-nums">{Math.round(s.v).toLocaleString()}</div>
              <div className="nf-label text-[9.5px]">{s.k}</div>
            </div>
          ))}
        </div>
        {loadout && <div className="nf-ui text-[12px] uppercase tracking-[0.16em] text-dim">Loadout: <span className="text-ink">{loadout.name}</span> · {humanize(loadout.preset)}</div>}
      </div>
    </HoloPanel>
  );
}

function WalletSummary() {
  const t = useT();
  const me = useSession();
  const rewards = useRewards();
  const primary = me.wallets.find((w) => w.primary) ?? me.wallets[0];
  return (
    <HoloPanel title="Treasury" actions={<Link to="/wallet" className="nf-ui text-[12px] uppercase tracking-[0.16em] text-accent no-underline">Wallet →</Link>}>
      <div className="grid gap-3">
        <div className="flex items-center justify-between"><span className="nf-label">{t("common.credits")}</span><CurrencyAmount amount={me.balances.credits} currency="CREDITS" size={17} /></div>
        <div className="flex items-center justify-between"><span className="nf-label">{t("common.gems")}</span><CurrencyAmount amount={me.balances.gems} currency="GEMS" size={17} /></div>
        <hr className="nf-divider my-1" />
        <div className="flex items-center justify-between"><span className="nf-label">{t("common.battleRewards")}</span><CurrencyAmount amount={me.balances.nebx} currency="NEBX" size={16} /></div>
        <div className="flex items-center justify-between">
          <span className="nf-label">Pending review</span>
          <CurrencyAmount amount={me.balances.pendingRewards} currency="NEBX" size={14} />
        </div>
        {rewards.data && (
          <div className="flex items-center justify-between">
            <span className="nf-label">{t("common.seasonRewards")} claimable</span>
            <CurrencyAmount amount={rewards.data.claimable} currency="NEBX" size={14} />
          </div>
        )}
        <div className="flex items-center gap-2 rounded-md border border-line bg-black/20 px-3 py-2 text-[12.5px]">
          <Icon name="wallet" size={15} />
          {primary ? <span className="nf-mono text-dim">{shortAddr(primary.address, 5)}</span> : <span className="text-mute">No wallet linked</span>}
          <span className="nf-chip ml-auto text-[10px]">Devnet</span>
        </div>
      </div>
    </HoloPanel>
  );
}

function EventBanner() {
  const events = useEvents();
  const rift = events.data?.active.find((e) => e.type === "GLOBAL_RIFT") ?? events.data?.active[0];
  const next = events.data?.upcoming[0];
  if (!rift && !next) return null;
  const e = rift ?? next!;
  const live = Boolean(rift);
  return (
    <Link to="/events" className="nf-panel nf-panel--interactive block overflow-hidden no-underline" style={{ "--nf-accent": live ? "#c084fc" : "var(--nf-accent)" } as CSSProperties}>
      <div className="flex flex-wrap items-center gap-4 p-4" style={{ background: "linear-gradient(90deg, color-mix(in oklab, var(--nf-accent) 22%, transparent), transparent 70%)" }}>
        <span className="text-accent"><Icon name={live ? "warning" : "events"} size={28} /></span>
        <div className="min-w-0 flex-1">
          <div className="nf-eyebrow">{live ? "Live event" : "Upcoming event"}</div>
          <div className="nf-display truncate text-[18px] font-bold tracking-[0.08em] text-ink">{e.name}</div>
        </div>
        <div className="text-right">
          <div className="nf-label">{live ? "Ends in" : "Starts in"}</div>
          <Countdown to={live ? eventTimes(e).end : eventTimes(e).start} className="text-[18px] text-ink" />
        </div>
      </div>
    </Link>
  );
}

function MissionTracker() {
  const quests = useQuests();
  const active = quests.data?.active.filter((q) => q.status !== "CLAIMED").slice(0, 3) ?? [];
  const ready = quests.data?.active.filter((q) => q.status === "COMPLETED").length ?? 0;
  return (
    <HoloPanel title="Missions" actions={<Link to="/missions" className="nf-ui text-[12px] uppercase tracking-[0.16em] text-accent no-underline">{ready > 0 ? `${ready} ready to claim →` : "All →"}</Link>}>
      {quests.isLoading && <div className="nf-skeleton h-24" />}
      {!quests.isLoading && active.length === 0 && <div className="text-[13px] text-mute">No active missions. Accept one from the mission board.</div>}
      <div className="grid gap-3">
        {active.map((q) => {
          const total = q.objectives.reduce((a, o) => a + o.count, 0);
          const done = q.objectives.reduce((a, o) => a + Math.min(o.count, o.progress), 0);
          return (
            <div key={q.id || q.questId} className="grid gap-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="nf-ui truncate text-[15px] font-bold">{q.name}</span>
                <span className="nf-label shrink-0">{humanize(q.type)}</span>
              </div>
              <StatBar value={done} max={Math.max(1, total)} height={5} color={q.status === "COMPLETED" ? STAT_COLORS.hull : "var(--nf-accent)"} format={(v, m) => `${v}/${m}`} ghost={false} />
            </div>
          );
        })}
      </div>
    </HoloPanel>
  );
}

function QuickMenu() {
  const t = useT();
  const items = [...MAIN_MENU.filter((m) => m.to !== "/play"), ...SECONDARY_MENU];
  return (
    <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
      {items.map((n) => (
        <Link key={n.to} to={n.to} className="nf-panel nf-panel--interactive grid aspect-square place-items-center content-center gap-1.5 p-2 text-center text-dim no-underline" onClick={() => haptic("selection")}>
          <span className="text-accent"><Icon name={n.icon} size={22} /></span>
          <span className="nf-ui text-[10.5px] font-bold uppercase leading-tight tracking-[0.08em]">{t(n.label)}</span>
        </Link>
      ))}
    </div>
  );
}

export default function HomePage() {
  const me = useSession();
  const mobile = useIsMobileUI();
  const f = faction(me.faction);
  const greeting = (
    <div className="mb-4 flex flex-wrap items-center gap-3">
      {f && <FactionEmblem path={f.emblem} color={f.color} secondaryColor={f.secondaryColor} size={46} />}
      <div>
        <div className="nf-eyebrow">{f?.name ?? "Independent"}{me.clan ? ` · [${me.clan.tag}] ${me.clan.name}` : ""}</div>
        <h1 className="nf-h1">Command deck</h1>
      </div>
    </div>
  );

  if (mobile) {
    return (
      <div className="grid gap-4">
        {greeting}
        <PlayHero />
        <EventBanner />
        <ShipCard />
        <WalletSummary />
        <MissionTracker />
        <QuickMenu />
      </div>
    );
  }
  return (
    <div className="grid gap-5">
      {greeting}
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(280px,340px)_1fr_minmax(280px,340px)] lg:grid-cols-[300px_1fr]">
        <div className="grid gap-5">
          <ShipCard />
        </div>
        <div className="grid gap-5">
          <PlayHero />
          <EventBanner />
          <MissionTracker />
        </div>
        <div className="grid gap-5 lg:col-span-2 xl:col-span-1">
          <WalletSummary />
          <HoloPanel title="Pilot record">
            <div className="grid grid-cols-2 gap-3">
              {[
                { k: "Level", v: me.level },
                { k: "Honor", v: me.honor },
                { k: "Rank", v: me.rank },
                { k: "Prestige", v: me.prestige },
              ].map((s) => (
                <div key={s.k}>
                  <div className="nf-label">{s.k}</div>
                  <div className="nf-display text-[17px] font-bold">{typeof s.v === "number" ? s.v.toLocaleString() : s.v}</div>
                </div>
              ))}
            </div>
          </HoloPanel>
        </div>
      </div>
    </div>
  );
}
