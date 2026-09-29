/**
 * Typed, validated environment. The process refuses to start with weak/missing secrets in production.
 */
import { z } from "zod";
import { parseKeyRing, type KeyRing } from "@nebula/authentication";

const csv = z
  .string()
  .default("")
  .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean));

const bool = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((v) => (typeof v === "boolean" ? v : v === "true" || v === "1"));

/** Local development database; never acceptable in production. */
export const DEV_DATABASE_URL = "postgresql://nebula:nebula@localhost:5432/nebula";
/** Minimum length of METRICS_TOKEN in production (GET /metrics must never be public there). */
export const MIN_METRICS_TOKEN_LENGTH = 32;

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  API_HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.string().min(1).default(DEV_DATABASE_URL),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
  /** Legacy single secrets (used when the *_SECRETS rotation lists are empty). */
  JWT_SECRET: z.string().optional(),
  GAME_TICKET_SECRET: z.string().optional(),
  /** Rotation lists `kid:secret,kid:secret` — first entry signs, all entries verify. */
  JWT_SECRETS: z.string().optional(),
  GAME_TICKET_SECRETS: z.string().optional(),
  INTERNAL_SERVICE_TOKEN: z.string().min(32).optional(),
  COOKIE_DOMAIN: z.string().optional().transform((v) => (v ? v : undefined)),
  CORS_ORIGINS: csv,
  PUBLIC_GAME_SERVER_URL: z.string().default("ws://localhost:2567"),
  PUBLIC_WEB_URL: z.string().default("http://localhost:5173"),
  /** Domain inserted into the Sign-In-With-Solana message (defaults to PUBLIC_WEB_URL host). */
  AUTH_DOMAIN: z.string().optional(),
  /** Reject wallet signatures from an IP other than the one that requested the nonce. */
  WALLET_NONCE_BIND_IP: bool,
  /** Honour X-Forwarded-For (set when running behind a trusted reverse proxy / LB). */
  TRUST_PROXY: bool,
  /** Bearer token protecting GET /metrics (optional in development, >= 32 chars required in production). */
  METRICS_TOKEN: z.string().optional(),
  SOLANA_NETWORK: z.string().default("devnet"),
  REGION: z.string().default("EU"),
});

export type Env = z.infer<typeof envSchema> & { authDomain: string; isProd: boolean; jwtKeys: KeyRing; gameTicketKeys: KeyRing };

const WEAK = /dev-only|change-me|changeme|secret|password/i;

export function loadEnv(source: Record<string, string | undefined> = process.env, overrides: Partial<Env> = {}): Env {
  const parsed = envSchema.safeParse({ ...source, ...overrides });
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment: ${msg}`);
  }
  const e = parsed.data;
  const isProd = e.NODE_ENV === "production";
  let jwtKeys: KeyRing;
  let gameTicketKeys: KeyRing;
  try {
    jwtKeys = parseKeyRing(e.JWT_SECRETS, e.JWT_SECRET);
    gameTicketKeys = parseKeyRing(e.GAME_TICKET_SECRETS, e.GAME_TICKET_SECRET);
  } catch (err) {
    throw new Error(`Invalid environment: JWT/GAME_TICKET secrets: ${(err as Error).message}`);
  }
  if (isProd) {
    for (const [name, ring] of [["JWT", jwtKeys], ["GAME_TICKET", gameTicketKeys]] as const) {
      if (ring.keys.some((k) => WEAK.test(k.secret))) throw new Error(`${name} secret looks like a development placeholder; refusing to start in production`);
    }
    if (e.SOLANA_NETWORK !== "devnet") throw new Error("This build only supports SOLANA_NETWORK=devnet");
    const dbUrlProvided = Boolean(overrides.DATABASE_URL ?? source.DATABASE_URL);
    if (!dbUrlProvided || e.DATABASE_URL === DEV_DATABASE_URL) {
      throw new Error("DATABASE_URL must be set explicitly in production (the local development default is refused)");
    }
    if (!e.METRICS_TOKEN || e.METRICS_TOKEN.trim().length < MIN_METRICS_TOKEN_LENGTH) {
      throw new Error(`METRICS_TOKEN must be at least ${MIN_METRICS_TOKEN_LENGTH} characters in production (GET /metrics would be public)`);
    }
  }
  let authDomain = e.AUTH_DOMAIN ?? "";
  if (!authDomain) {
    try {
      authDomain = new URL(e.PUBLIC_WEB_URL).host;
    } catch {
      authDomain = "localhost";
    }
  }
  return { ...e, ...overrides, authDomain, isProd, jwtKeys, gameTicketKeys };
}
