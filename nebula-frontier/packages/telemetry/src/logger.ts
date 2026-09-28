/**
 * pino logger factory with secret redaction. Never logs private keys, JWTs,
 * cookies, passwords, wallet signatures, game tickets or treasury secrets.
 */
import pino, { type Logger, type LoggerOptions, type DestinationStream } from "pino";

/** Paths redacted in every log line (pino fast-redact syntax, wildcards supported). */
export const REDACT_PATHS: string[] = [
  "password", "*.password", "passwordHash", "*.passwordHash",
  "token", "*.token", "accessToken", "*.accessToken", "refreshToken", "*.refreshToken",
  "ticket", "*.ticket", "*.options.ticket", "jwt", "*.jwt",
  "secret", "*.secret", "secretKey", "*.secretKey", "privateKey", "*.privateKey", "seed", "*.seed", "mnemonic", "*.mnemonic",
  "signature", "*.signature", "authSignature", "*.authSignature",
  "authorization", "*.authorization", "cookie", "*.cookie", "cookies", "*.cookies", "set-cookie", "*.set-cookie",
  "req.headers.authorization", "req.headers.cookie", "res.headers[\"set-cookie\"]",
  "headers.authorization", "headers.cookie",
  "TREASURY_SECRET", "*.TREASURY_SECRET", "JWT_SECRET", "*.JWT_SECRET", "GAME_TICKET_SECRET", "*.GAME_TICKET_SECRET",
  "INTERNAL_SERVICE_TOKEN", "*.INTERNAL_SERVICE_TOKEN",
];

/** Patterns scrubbed from free-form strings (messages / errors). */
const SECRET_PATTERNS: RegExp[] = [
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
  /\b(nf_access|nf_refresh)=[^;\s]+/g, // auth cookies
  /\[(?:\s*\d{1,3}\s*,){31,}\s*\d{1,3}\s*\]/g, // byte-array secret keys (solana-keygen format)
  /(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi,
];

export function scrubSecrets(s: string): string {
  let out = s;
  for (const p of SECRET_PATTERNS) out = out.replace(p, (m, g1: unknown) => (typeof g1 === "string" && /Bearer/i.test(g1) ? `${g1}[REDACTED]` : "[REDACTED]"));
  return out;
}

export interface CreateLoggerOptions {
  name: string;
  level?: string;
  /** Extra base bindings (service, region, processId…). */
  base?: Record<string, unknown>;
  /** Extra redaction paths. */
  redact?: string[];
  /** Destination stream (tests). */
  destination?: NodeJS.WritableStream;
}

export function createLogger(opts: CreateLoggerOptions): Logger {
  const options: LoggerOptions = {
    name: opts.name,
    level: opts.level ?? process.env.LOG_LEVEL ?? "info",
    base: { service: opts.name, pid: process.pid, ...(opts.base ?? {}) },
    redact: { paths: [...REDACT_PATHS, ...(opts.redact ?? [])], censor: "[REDACTED]" },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    hooks: {
      logMethod(args, method) {
        const scrubbed = args.map((a) => (typeof a === "string" ? scrubSecrets(a) : a)) as Parameters<typeof method>;
        return method.apply(this, scrubbed);
      },
    },
    serializers: {
      err: (e: unknown) => {
        const s = pino.stdSerializers.err(e as Error);
        return { ...s, message: scrubSecrets(String(s.message ?? "")), stack: s.stack ? scrubSecrets(s.stack) : undefined };
      },
    },
  };
  return opts.destination ? pino(options, opts.destination as unknown as DestinationStream) : pino(options);
}

export type { Logger };
