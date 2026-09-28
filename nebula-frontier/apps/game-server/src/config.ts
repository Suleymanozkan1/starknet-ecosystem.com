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

export function loadConfig(): GameServerConfig {
  const gameTicketKeys = keyRingFromEnv("GAME_TICKET");
  const nodeEnv = process.env.NODE_ENV ?? "development";
  // Ticket single-use (jti) must be shared by every game-server process; the in-memory fallback
  // is per-process and would allow cross-process ticket replay. Redis is mandatory in production.
  if (nodeEnv === "production" && !process.env.REDIS_URL) throw new Error("REDIS_URL is required in production (ticket replay protection, presence, matchmaking)");
  const region = (process.env.REGION ?? "EU").toUpperCase();
  return {
    port: num("GAME_PORT", 2567),
    region: (Object.values(Region) as string[]).includes(region) ? (region as Region) : Region.EU,
    tickRate: Math.max(5, Math.min(60, num("GAME_TICK_RATE", 20))),
    patchRateMs: Math.max(16, num("GAME_PATCH_RATE_MS", 50)),
    maxPlayersPerRoom: Math.max(2, num("MAX_PLAYERS_PER_ROOM", 100)),
    aoiRadius: Math.max(20, num("AOI_RADIUS", 140)),
    redisUrl: process.env.REDIS_URL ? process.env.REDIS_URL : null,
    gameTicketKeys,
    apiInternalUrl: (process.env.API_INTERNAL_URL || "http://localhost:8080").replace(/\/$/, ""),
    internalServiceToken: process.env.INTERNAL_SERVICE_TOKEN || null,
    publicUrl: process.env.PUBLIC_GAME_SERVER_URL ?? `ws://localhost:${num("GAME_PORT", 2567)}`,
    flushIntervalMs: Math.max(1000, num("GAME_FLUSH_INTERVAL_MS", 5000)),
    nodeEnv,
  };
}
