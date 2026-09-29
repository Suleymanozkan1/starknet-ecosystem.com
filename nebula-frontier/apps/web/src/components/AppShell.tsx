import { Suspense, useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { CurrencyAmount, FactionEmblem, Icon, StatBar, STAT_COLORS, Tooltip } from "@nebula/game-ui";
import type { MeResponse } from "@nebula/shared";
import { fmtNum, rankLabel, useT } from "../lib/i18n.js";
import { useNotifications } from "../lib/queries.js";
import { faction } from "../lib/gameMeta.js";
import { useFactionAccent, useLogout, useSession } from "../hooks/useSession.js";
import { useIsMobileUI } from "../hooks/useMediaQuery.js";
import { useUi } from "../store/ui.js";
import { haptic } from "../native/haptics.js";
import { BOTTOM_NAV, MAIN_MENU, SECONDARY_MENU } from "./nav.js";
import { NotificationDropdown } from "./NotificationDropdown.js";
import { ChatPanel } from "./ChatPanel.js";
import { ErrorBoundary } from "./ErrorBoundary.js";

export function LevelHex({ level, size = 40 }: { level: number; size?: number }) {
  return (
    <span className="relative inline-grid shrink-0 place-items-center" style={{ width: size, height: size }}>
      <svg viewBox="0 0 40 40" width={size} height={size} className="absolute inset-0" aria-hidden>
        <polygon points="20,1 37,10.5 37,29.5 20,39 3,29.5 3,10.5" fill="rgba(6,12,26,0.9)" stroke="var(--nf-accent)" strokeWidth="1.5" />
        <polygon points="20,5 33.5,12.7 33.5,27.3 20,35 6.5,27.3 6.5,12.7" fill="none" stroke="var(--nf-accent)" strokeOpacity="0.3" />
      </svg>
      <span className="nf-display relative text-[13px] font-bold" style={{ fontSize: size * 0.33 }}>{level}</span>
    </span>
  );
}

function ProfileChip({ me, compact }: { me: MeResponse; compact?: boolean }) {
  const t = useT();
  const f = faction(me.faction);
  const xpMax = Math.max(1, me.xpToNext);
  return (
    <Link to="/profile" className="flex min-w-0 items-center gap-3 rounded-lg px-1.5 py-1 text-inherit no-underline transition-colors hover:bg-white/5">
      <LevelHex level={me.level} size={compact ? 36 : 42} />
      <div className="grid min-w-0 gap-1" style={{ width: compact ? 110 : 170 }}>
        <div className="flex min-w-0 items-center gap-1.5">
          {f && <FactionEmblem path={f.emblem} color={f.color} secondaryColor={f.secondaryColor} size={16} framed={false} />}
          <span className="nf-ui truncate text-[15px] font-bold tracking-[0.06em]">{me.username}</span>
          {me.clan && !compact && <span className="nf-ui text-[12px] text-accent">[{me.clan.tag}]</span>}
        </div>
        <StatBar value={me.xpIntoLevel} max={xpMax} height={4} showValue={false} color={STAT_COLORS.xp} ghost={false} />
        {!compact && (
          <div className="nf-ui flex justify-between text-[10.5px] uppercase tracking-[0.16em] text-mute">
            <span>{rankLabel(me.rank)}</span>
            <span className="tabular-nums">{t("shell.xp", { pct: fmtNum(Math.floor((me.xpIntoLevel / xpMax) * 100)) })}</span>
          </div>
        )}
      </div>
    </Link>
  );
}

function Bell() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const notifs = useNotifications();
  const unread = notifs.data?.unread ?? 0;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button type="button" className="nf-iconbtn" aria-label={unread ? t("nav.notificationsUnread", { n: unread }) : t("nav.notifications")} aria-expanded={open} onClick={() => { haptic("selection"); setOpen((o) => !o); }}>
        <Icon name="bell" size={19} />
        {unread > 0 && <span className="nf-badge-dot">{unread > 9 ? "9+" : unread}</span>}
      </button>
      {open && <NotificationDropdown items={notifs.data?.notifications ?? []} loading={notifs.isLoading} onClose={() => setOpen(false)} />}
    </div>
  );
}

function TopBar({ me, mobile }: { me: MeResponse; mobile: boolean }) {
  const t = useT();
  const logout = useLogout();
  const setChat = useUi((s) => s.setChatOpen);
  const chatOpen = useUi((s) => s.chatOpen);
  return (
    <header className="nf-topbar">
      {!mobile && (
        <Link to="/home" className="nf-logo mr-2 text-ink no-underline" aria-label={t("nav.homeLink")}>
          NEBULA <b>FRONTIER</b>
        </Link>
      )}
      <ProfileChip me={me} compact={mobile} />
      <div className="flex-1" />
      <div className="flex items-center gap-3 sm:gap-5">
        <Tooltip content={t("common.credits")} placement="bottom">
          <CurrencyAmount amount={me.balances.credits} currency="CREDITS" compact size={mobile ? 13 : 15} showSymbol={!mobile} />
        </Tooltip>
        <Tooltip content={t("common.gems")} placement="bottom">
          <CurrencyAmount amount={me.balances.gems} currency="GEMS" compact size={mobile ? 13 : 15} showSymbol={!mobile} />
        </Tooltip>
      </div>
      <div className="flex items-center gap-2">
        <Bell />
        {!mobile && (
          <>
            <button type="button" className="nf-iconbtn" aria-label={t("nav.chat")} aria-pressed={chatOpen} onClick={() => setChat(!chatOpen)}>
              <Icon name="chat" size={19} />
            </button>
            <Link to="/mail" className="nf-iconbtn" aria-label={t("nav.mail")}><Icon name="mail" size={19} /></Link>
            <Link to="/settings" className="nf-iconbtn" aria-label={t("nav.settings")}><Icon name="settings" size={19} /></Link>
            <button type="button" className="nf-iconbtn" aria-label={t("common.logout")} onClick={() => void logout()}>
              <Icon name="logout" size={19} />
            </button>
          </>
        )}
      </div>
    </header>
  );
}

function SideNav() {
  const t = useT();
  return (
    <nav className="nf-sidenav" aria-label={t("nav.mainMenu")}>
      {MAIN_MENU.map((n) => (
        <NavLink key={n.to} to={n.to} className={({ isActive }) => `nf-navlink${isActive ? " active" : ""}${n.to === "/play" ? " nf-navlink--play" : ""}`}>
          <Icon name={n.icon} size={17} />
          {t(n.label)}
        </NavLink>
      ))}
      <hr className="nf-divider" />
      {SECONDARY_MENU.map((n) => (
        <NavLink key={n.to} to={n.to} className={({ isActive }) => `nf-navlink${isActive ? " active" : ""}`}>
          <Icon name={n.icon} size={17} />
          {t(n.label)}
        </NavLink>
      ))}
    </nav>
  );
}

function BottomNav() {
  const t = useT();
  return (
    <nav className="nf-bottomnav" aria-label={t("nav.primary")}>
      {BOTTOM_NAV.map((n) => (
        <NavLink key={n.to} to={n.to} className={({ isActive }) => (isActive ? "active" : "")} onClick={() => haptic("selection")}>
          <Icon name={n.icon} size={22} />
          <span>{t(n.label)}</span>
        </NavLink>
      ))}
    </nav>
  );
}

/** Authenticated layout: desktop = top bar + side menu; mobile = compact top bar + bottom navigation. */
export function AppShell() {
  const me = useSession();
  const mobile = useIsMobileUI();
  const loc = useLocation();
  const chatOpen = useUi((s) => s.chatOpen);
  useFactionAccent(me.faction);
  return (
    <div className="nf-shell">
      <TopBar me={me} mobile={mobile} />
      <div className="flex min-h-0 flex-1">
        {!mobile && <SideNav />}
        <main className="nf-main" id="main">
          <ErrorBoundary key={loc.pathname}>
            <Suspense fallback={<div className="grid gap-3"><div className="nf-skeleton h-10 w-72" /><div className="nf-skeleton h-64" /></div>}>
              <div className="nf-page" key={loc.pathname}>
                <Outlet />
              </div>
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>
      {mobile && <BottomNav />}
      {chatOpen && <ChatPanel me={me} />}
    </div>
  );
}
