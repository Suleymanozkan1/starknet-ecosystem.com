/** Environment configuration for the game server (validated once at boot). */
import { keyRingFromEnv, type KeyRing } from "@nebula/authentication";
import { Region } from "@nebula/shared";

function num(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Env ${name} must be a number`);
  return n;
}

export interface GameServerConfig {
  port: number;
  region: Region;
  tickRate: number;
  patchRateMs: number;
  maxPlayersPerRoom: number;
  aoiRadius: number;
  redisUrl: string | null;
  /** GAME_TICKET_SECRETS (`kid:secret,…`, first = active) with fallback GAME_TICKET_SECRET — supports rotation. */
  gameTicketKeys: KeyRing;
  /** Internal API for clan-mission progress (`API_INTERNAL_URL`, `INTERNAL_SERVICE_TOKEN`); null token = disabled. */
  apiInternalUrl: string;
  internalServiceToken: string | null;
  publicUrl: string;
  flushIntervalMs: number;
  nodeEnv: string;
}

const LOOPBACK_HOSTS = new Set(["localhost", "[::1]", "::1"]);
function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return LOOPBACK_HOSTS.has(h) || h.endsWith(".localhost") || /^127(?:\.\d{1,3}){3}$/.test(h);
}

/**
 * Normalise API_INTERNAL_URL. With an INTERNAL_SERVICE_TOKEN the URL carries a credential header,
 * so it must be https:// unless it targets loopback (local development); plain http to a remote
 * host would expose the token to on-path observers.
 */
export function resolveApiInternalUrl(raw: string | undefined, token: string | null): string {
  const value = (raw || "http://localhost:8080").replace(/\/$/, "");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("API_INTERNAL_URL must be a valid http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("API_INTERNAL_URL must be a valid http(s) URL");
  if (token && url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    throw new Error("API_INTERNAL_URL must use https:// for non-loopback hosts when INTERNAL_SERVICE_TOKEN is set");
  }
  return value;
}

export function loadConfig(): GameServerConfig {
  const gameTicketKeys = keyRingFromEnv("GAME_TICKET");
  const nodeEnv = process.env.NODE_ENV ?? "development";
  // Ticket single-use (jti) must be shared by every game-server process; the in-memory fallback
  // is per-process and would allow cross-process ticket replay. Redis is mandatory in production.
  if (nodeEnv === "production" && !process.env.REDIS_URL) throw new Error("REDIS_URL is required in production (ticket replay protection, presence, matchmaking)");
  const region = (process.env.REGION ?? "EU").toUpperCase();
  const internalServiceToken = process.env.INTERNAL_SERVICE_TOKEN || null;
  const apiInternalUrl = resolveApiInternalUrl(process.env.API_INTERNAL_URL, internalServiceToken);
  return {
    port: num("GAME_PORT", 2567),
    region: (Object.values(Region) as string[]).includes(region) ? (region as Region) : Region.EU,
    tickRate: Math.max(5, Math.min(60, num("GAME_TICK_RATE", 20))),
    patchRateMs: Math.max(16, num("GAME_PATCH_RATE_MS", 50)),
    maxPlayersPerRoom: Math.max(2, num("MAX_PLAYERS_PER_ROOM", 100)),
    aoiRadius: Math.max(20, num("AOI_RADIUS", 140)),
    redisUrl: process.env.REDIS_URL ? process.env.REDIS_URL : null,
    gameTicketKeys,
    apiInternalUrl,
    internalServiceToken,
    publicUrl: process.env.PUBLIC_GAME_SERVER_URL ?? `ws://localhost:${num("GAME_PORT", 2567)}`,
    flushIntervalMs: Math.max(1000, num("GAME_FLUSH_INTERVAL_MS", 5000)),
    nodeEnv,
  };
}
