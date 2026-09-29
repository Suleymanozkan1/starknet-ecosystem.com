import { lazy, Suspense, useEffect } from "react";
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient, qk } from "./lib/queries.js";
import { onUnauthorized } from "./lib/http.js";
import { initNative } from "./native/index.js";
import { SpaceBackdrop } from "./components/SpaceBackdrop.js";
import { Toasts } from "./components/Toasts.js";
import { DemoBadge } from "./components/DemoBadge.js";
import { LoadingScreen } from "./components/LoadingScreen.js";
import { AppShell } from "./components/AppShell.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { RequireAuth, RequireOnboarded } from "./routes/guards.js";
import { LandingPage } from "./pages/Landing.js";
import { useSettings } from "./store/settings.js";

// Heavy / rarely-first routes are code-split.
const WalletLayout = lazy(() => import("./wallet/WalletProviders.js"));
const AuthPage = lazy(() => import("./pages/Auth.js"));
const FactionSelectPage = lazy(() => import("./pages/onboarding/FactionSelect.js"));
const StarterShipPage = lazy(() => import("./pages/onboarding/StarterShip.js"));
const HomePage = lazy(() => import("./pages/Home.js"));
const PlayPage = lazy(() => import("./pages/Play.js"));
const HangarPage = lazy(() => import("./pages/Hangar.js"));
const InventoryPage = lazy(() => import("./pages/Inventory.js"));
const ShipsPage = lazy(() => import("./pages/Ships.js"));
const CatalogPage = lazy(() => import("./pages/Catalog.js"));
const MissionsPage = lazy(() => import("./pages/Missions.js"));
const CraftingPage = lazy(() => import("./pages/Crafting.js"));
const GalaxyPage = lazy(() => import("./pages/Galaxy.js"));
const ClanPage = lazy(() => import("./pages/Clan.js"));
const MarketPage = lazy(() => import("./pages/Market.js"));
const AuctionPage = lazy(() => import("./pages/Auction.js"));
const LeaderboardPage = lazy(() => import("./pages/Leaderboard.js"));
const SeasonPage = lazy(() => import("./pages/Season.js"));
const BattlePassPage = lazy(() => import("./pages/BattlePass.js"));
const EventsPage = lazy(() => import("./pages/Events.js"));
const ShopPage = lazy(() => import("./pages/Shop.js"));
const WalletPage = lazy(() => import("./pages/Wallet.js"));
const ProfilePage = lazy(() => import("./pages/Profile.js"));
const FriendsPage = lazy(() => import("./pages/Friends.js"));
const NotificationsPage = lazy(() => import("./pages/Notifications.js"));
const MailPage = lazy(() => import("./pages/Mail.js"));
const SettingsPage = lazy(() => import("./pages/Settings.js"));
const NotFoundPage = lazy(() => import("./pages/NotFound.js"));

function NativeBridge() {
  const navigate = useNavigate();
  useEffect(() => {
    initNative((route) => navigate(route));
    return onUnauthorized(() => queryClient.setQueryData(qk.me, null));
  }, [navigate]);
  return null;
}

function Language() {
  const lang = useSettings((s) => s.language);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  return null;
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <NativeBridge />
        <Language />
        <SpaceBackdrop />
        <ErrorBoundary>
          <Suspense fallback={<LoadingScreen />}>
            <Routes>
              <Route path="/" element={<LandingPage />} />
              <Route element={<WalletLayout />}>
                <Route path="/login" element={<AuthPage mode="login" />} />
                <Route path="/register" element={<AuthPage mode="register" />} />
              </Route>
              <Route element={<RequireAuth />}>
                <Route path="/onboarding/faction" element={<FactionSelectPage />} />
                <Route path="/onboarding/ship" element={<StarterShipPage />} />
                <Route element={<RequireOnboarded />}>
                  <Route path="/play" element={<PlayPage />} />
                  <Route element={<AppShell />}>
                    <Route path="/home" element={<HomePage />} />
                    <Route path="/galaxy" element={<GalaxyPage />} />
                    <Route path="/hangar" element={<HangarPage />} />
                    <Route path="/inventory" element={<InventoryPage />} />
                    <Route path="/ships" element={<ShipsPage />} />
                    <Route path="/weapons" element={<CatalogPage kind="weapons" />} />
                    <Route path="/modules" element={<CatalogPage kind="modules" />} />
                    <Route path="/drones" element={<CatalogPage kind="drones" />} />
                    <Route path="/missions" element={<MissionsPage />} />
                    <Route path="/crafting" element={<CraftingPage />} />
                    <Route path="/clan" element={<ClanPage />} />
                    <Route path="/clan/:clanId" element={<ClanPage />} />
                    <Route path="/market" element={<MarketPage />} />
                    <Route path="/auction" element={<AuctionPage />} />
                    <Route path="/leaderboard" element={<LeaderboardPage />} />
                    <Route path="/season" element={<SeasonPage />} />
                    <Route path="/battle-pass" element={<BattlePassPage />} />
                    <Route path="/events" element={<EventsPage />} />
                    <Route path="/events/:eventId" element={<EventsPage />} />
                    <Route path="/shop" element={<ShopPage />} />
                    <Route element={<WalletLayout />}>
                      <Route path="/wallet" element={<WalletPage />} />
                      <Route path="/wallet/:action" element={<WalletPage />} />
                      <Route path="/profile" element={<ProfilePage />} />
                    </Route>
                    <Route path="/profile/:userId" element={<ProfilePage />} />
                    <Route path="/friends" element={<FriendsPage />} />
                    <Route path="/notifications" element={<NotificationsPage />} />
                    <Route path="/mail" element={<MailPage />} />
                    <Route path="/settings" element={<SettingsPage />} />
                  </Route>
                </Route>
              </Route>
              <Route path="/app" element={<Navigate to="/home" replace />} />
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </Suspense>
        </ErrorBoundary>
        <Toasts />
        <DemoBadge />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
