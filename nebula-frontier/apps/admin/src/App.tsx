import { useEffect } from "react";
import type { ReactNode } from "react";
import { BrowserRouter, Navigate, NavLink, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Icon, NeonButton } from "@nebula/game-ui";
import type { IconName } from "@nebula/game-ui";
import { api, can } from "./lib/api.js";
import type { Perm } from "./lib/api.js";
import { isApiError, onUnauthorized } from "./lib/http.js";
import { useMeQuery } from "./session.js";
import { LoginPage } from "./pages/Login.js";
import { EconomyPage, OverviewPage, ProfitabilityPage } from "./pages/Dashboards.js";
import { ReportsPage, RewardsPage, RiskPage, TreasuryPage, UsersPage, WithdrawalsPage } from "./pages/Operations.js";
import { CatalogPage, EventsPage, ShopPage, TradePage, WorldContentPage } from "./pages/Content.js";
import { AuditPage, MailPage, RulesPage } from "./pages/System.js";

const qc = new QueryClient({
  defaultOptions: { queries: { retry: (n, e) => !(isApiError(e) && e.status < 500) && n < 2, refetchOnWindowFocus: false } },
});

interface NavDef { to: string; label: string; icon: IconName; perm: Perm; el: ReactNode }
const SECTIONS: { title: string; items: NavDef[] }[] = [
  { title: "Dashboards", items: [
    { to: "/", label: "Overview", icon: "signal", perm: "overview", el: <OverviewPage /> },
    { to: "/economy", label: "Economy", icon: "crypto", perm: "economyRead", el: <EconomyPage /> },
    { to: "/profitability", label: "Profitability", icon: "leaderboard", perm: "economyRead", el: <ProfitabilityPage /> },
  ] },
  { title: "Blockchain", items: [
    { to: "/withdrawals", label: "Withdrawals", icon: "wallet", perm: "withdrawalReview", el: <WithdrawalsPage /> },
    { to: "/rewards", label: "Reward review", icon: "trophy", perm: "economyRead", el: <RewardsPage /> },
    { to: "/treasury", label: "Treasury", icon: "shield", perm: "economyRead", el: <TreasuryPage /> },
  ] },
  { title: "Players", items: [
    { to: "/users", label: "Users", icon: "user", perm: "usersRead", el: <UsersPage /> },
    { to: "/risk", label: "Suspicious", icon: "warning", perm: "riskRead", el: <RiskPage /> },
    { to: "/reports", label: "Reports", icon: "chat", perm: "reports", el: <ReportsPage /> },
    { to: "/mail", label: "Compensation", icon: "mail", perm: "mailGrant", el: <MailPage /> },
  ] },
  { title: "Content", items: [
    { to: "/shop", label: "Shop", icon: "shop", perm: "shopManage", el: <ShopPage /> },
    { to: "/events", label: "Events", icon: "events", perm: "eventsRead", el: <EventsPage /> },
    { to: "/catalog", label: "Catalog", icon: "ship", perm: "catalogManage", el: <CatalogPage /> },
    { to: "/world", label: "Maps & seasons", icon: "map", perm: "overview", el: <WorldContentPage /> },
    { to: "/trade", label: "Market & clans", icon: "market", perm: "overview", el: <TradePage /> },
  ] },
  { title: "System", items: [
    { to: "/rules", label: "Rules & flags", icon: "settings", perm: "rulesManage", el: <RulesPage /> },
    { to: "/audit", label: "Audit log", icon: "missions", perm: "auditRead", el: <AuditPage /> },
  ] },
];

function Shell() {
  const me = useMeQuery();
  const client = useQueryClient();
  useEffect(() => onUnauthorized(() => client.setQueryData(["me"], null)), [client]);
  if (me.isLoading) return <div className="grid min-h-screen place-items-center text-mute">Authenticating…</div>;
  if (!me.data) return <LoginPage />;
  const roles = me.data.roles;
  if (roles.length === 0) {
    return (
      <div className="grid min-h-screen place-items-center p-6 text-center">
        <div className="grid gap-3">
          <div className="font-display text-[20px]">No admin role</div>
          <div className="text-dim">{me.data.username} is signed in but holds no admin role.</div>
          <NeonButton onClick={() => void api.logout().then(() => client.setQueryData(["me"], null))}>Sign out</NeonButton>
        </div>
      </div>
    );
  }
  const visible = SECTIONS.map((s) => ({ ...s, items: s.items.filter((i) => can(roles, i.perm)) })).filter((s) => s.items.length);
  const all = visible.flatMap((s) => s.items);
  return (
    <div className="flex min-h-screen">
      <aside className="adm-nav sticky top-0 h-screen w-[230px] shrink-0 overflow-y-auto border-r border-line bg-[rgba(4,7,14,0.7)] px-2 py-4 backdrop-blur-xl max-md:hidden">
        <div className="px-3 pb-2 font-display text-[13px] font-extrabold tracking-[0.24em]">NEBULA <span className="text-accent">OPS</span></div>
        {visible.map((s) => (
          <div key={s.title}>
            <h3>{s.title}</h3>
            {s.items.map((i) => <NavLink key={i.to} to={i.to} end={i.to === "/"}><Icon name={i.icon} size={15} />{i.label}</NavLink>)}
          </div>
        ))}
        <div className="mt-6 border-t border-line px-3 pt-3 text-[12px] text-dim">
          <div className="font-ui font-bold text-ink">{me.data.username}</div>
          <div>{roles.join(", ")}</div>
          <button type="button" className="mt-2 text-accent" onClick={() => void api.logout().then(() => client.setQueryData(["me"], null))}>Sign out</button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-4 md:p-7">
        <nav className="mb-4 flex gap-2 overflow-x-auto md:hidden">{all.map((i) => <NavLink key={i.to} to={i.to} end={i.to === "/"} className="nf-chip whitespace-nowrap no-underline">{i.label}</NavLink>)}</nav>
        <Routes>
          {all.map((i) => <Route key={i.to} path={i.to} element={i.el} />)}
          <Route path="*" element={<Navigate to={all[0]?.to ?? "/"} replace />} />
        </Routes>
      </main>
    </div>
  );
}

export function App() {
  return (
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <Shell />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
