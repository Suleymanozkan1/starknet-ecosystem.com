/**
 * Typed, validated environment. The process refuses to start with weak/missing secrets in production.
 */
import { z } from "zod";

const csv = z
  .string()
  .default("")
  .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean));

const bool = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((v) => (typeof v === "boolean" ? v : v === "true" || v === "1"));

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  API_HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.string().min(1).default("postgresql://nebula:nebula@localhost:5432/nebula"),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  GAME_TICKET_SECRET: z.string().min(32, "GAME_TICKET_SECRET must be at least 32 characters"),
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
  /** Optional bearer token protecting GET /metrics. */
  METRICS_TOKEN: z.string().optional(),
  SOLANA_NETWORK: z.string().default("devnet"),
  REGION: z.string().default("EU"),
});

export type Env = z.infer<typeof envSchema> & { authDomain: string; isProd: boolean };

const WEAK = /dev-only|change-me|changeme|secret|password/i;

export function loadEnv(source: Record<string, string | undefined> = process.env, overrides: Partial<Env> = {}): Env {
  const parsed = envSchema.safeParse({ ...source, ...overrides });
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment: ${msg}`);
  }
  const e = parsed.data;
  const isProd = e.NODE_ENV === "production";
  if (isProd) {
    for (const k of ["JWT_SECRET", "GAME_TICKET_SECRET"] as const) {
      if (WEAK.test(e[k])) throw new Error(`${k} looks like a development placeholder; refusing to start in production`);
    }
    if (e.SOLANA_NETWORK !== "devnet") throw new Error("This build only supports SOLANA_NETWORK=devnet");
  }
  let authDomain = e.AUTH_DOMAIN ?? "";
  if (!authDomain) {
    try {
      authDomain = new URL(e.PUBLIC_WEB_URL).host;
    } catch {
      authDomain = "localhost";
    }
  }
  return { ...e, ...overrides, authDomain, isProd };
}
