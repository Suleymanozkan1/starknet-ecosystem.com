/**
 * Deep link / universal link / App Link routing with a strict whitelist.
 * Accepted:
 *   nebulafrontier://<route>[/...][?query]           (custom scheme; host part is the first path segment)
 *   https://<allowed host>/<route>[/...][?query]      (Universal Links / Android App Links)
 * Anything else (other schemes, hosts, `..`, unknown routes) is rejected and returns null.
 */
export const DEEP_LINK_SCHEME = "nebulafrontier";

/** First path segment → allowed. Sub-paths are allowed only when listed in ALLOWED_SUBPATHS. */
const ALLOWED_ROUTES = new Set([
  "", "home", "play", "hangar", "galaxy", "inventory", "ships", "missions", "crafting", "clan", "market", "auction",
  "leaderboard", "season", "battle-pass", "events", "shop", "wallet", "profile", "friends", "notifications", "mail", "settings",
]);
const ALLOWED_SUBPATHS: Record<string, RegExp> = {
  wallet: /^\/wallet(\/(return|deposit|withdraw))?$/,
  clan: /^\/clan(\/[a-zA-Z0-9_-]{1,64})?$/,
  profile: /^\/profile(\/[a-zA-Z0-9_-]{1,64})?$/,
  market: /^\/market(\/[a-zA-Z0-9_-]{1,64})?$/,
  auction: /^\/auction(\/[a-zA-Z0-9_-]{1,64})?$/,
  events: /^\/events(\/[a-zA-Z0-9_-]{1,64})?$/,
};
const QUERY_KEY = /^[a-zA-Z0-9_]{1,32}$/;
const MAX_QUERY_VALUE = 512;

export function defaultDeepLinkHosts(): string[] {
  const raw = import.meta.env.VITE_DEEP_LINK_HOSTS ?? "play.nebulafrontier.example";
  return raw.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
}

/** Returns an in-app route (path + sanitized query) or null when the URL is not allowed. */
export function deepLinkToRoute(rawUrl: string, allowedHosts: readonly string[] = defaultDeepLinkHosts()): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  let path: string;
  if (url.protocol === `${DEEP_LINK_SCHEME}:`) {
    // nebulafrontier://wallet/return → host "wallet", pathname "/return"
    path = `/${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } else if (url.protocol === "https:") {
    if (!allowedHosts.includes(url.hostname.toLowerCase()) || url.port || url.username || url.password) return null;
    path = url.pathname;
  } else {
    return null;
  }
  path = path.replace(/\/+$/, "") || "/";
  if (path.includes("..") || path.includes("//") || !/^[a-zA-Z0-9/_-]*$/.test(path)) return null;
  const first = path.split("/")[1] ?? "";
  if (!ALLOWED_ROUTES.has(first)) return null;
  const sub = ALLOWED_SUBPATHS[first];
  const depth = path.split("/").length - 1;
  if (sub ? !sub.test(path) : depth > 1) return null;

  const q = new URLSearchParams();
  for (const [k, v] of url.searchParams) {
    if (QUERY_KEY.test(k) && v.length <= MAX_QUERY_VALUE) q.append(k, v);
  }
  const qs = q.toString();
  return `${path === "/" ? "/" : path}${qs ? `?${qs}` : ""}`;
}
