import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useMe } from "../lib/queries.js";
import { LoadingScreen } from "../components/LoadingScreen.js";
import { ErrorState } from "../components/QueryState.js";

/** Requires a session; unauthenticated users are sent to /login?next=<path>. */
export function RequireAuth() {
  const me = useMe();
  const loc = useLocation();
  if (me.isLoading) return <LoadingScreen label="Authenticating" />;
  if (me.error) {
    return (
      <div className="relative z-10 grid min-h-screen place-items-center p-6">
        <ErrorState error={me.error} onRetry={() => void me.refetch()} />
      </div>
    );
  }
  if (!me.data) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  return <Outlet />;
}

/** Requires completed onboarding (faction + active ship). */
export function RequireOnboarded() {
  const { data: me } = useMe();
  if (!me) return null;
  if (!me.faction) return <Navigate to="/onboarding/faction" replace />;
  if (!me.activeShipInstanceId) return <Navigate to="/onboarding/ship" replace />;
  return <Outlet />;
}

/** Where a freshly authenticated user should land. */
export function postLoginRoute(me: { faction: string | null; activeShipInstanceId: string | null }, next?: string | null): string {
  if (!me.faction) return "/onboarding/faction";
  if (!me.activeShipInstanceId) return "/onboarding/ship";
  if (next && next.startsWith("/") && !next.startsWith("//")) return next;
  return "/home";
}
