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

/** Base64 token that decodes to `user:pass` (so prose like "Basic setup" is not redacted). */
function isBasicCredential(token: string): boolean {
  return Buffer.from(token, "base64").toString("utf8").includes(":");
}

/**
 * Patterns scrubbed from free-form strings (messages / errors). With `keepPrefix` the first capture
 * group (e.g. the `Bearer ` / `Basic ` prefix or a URL scheme) is kept in front of `[REDACTED]`;
 * `suffix` is appended after it (the `@` before a URL host); `when` (given the secret part) can veto a match.
 */
const SECRET_PATTERNS: { re: RegExp; keepPrefix?: boolean; suffix?: string; when?: (secret: string) => boolean }[] = [
  { re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g }, // JWT
  { re: /\b(nf_access|nf_refresh)=[^;\s]+/g }, // auth cookies
  { re: /\[(?:\s*\d{1,3}\s*,){31,}\s*\d{1,3}\s*\]/g }, // byte-array secret keys (solana-keygen format)
  { re: /(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, keepPrefix: true },
  { re: /(Basic\s+)([A-Za-z0-9+/]+=*)/gi, keepPrefix: true, when: isBasicCredential }, // HTTP Basic credentials
  { re: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/?#@]+)@/gi, keepPrefix: true, suffix: "@" }, // URL userinfo (scheme://user:pass@host)
];

export function scrubSecrets(s: string): string {
  let out = s;
  for (const p of SECRET_PATTERNS) {
    out = out.replace(p.re, (m: string, g1: unknown, g2: unknown) => {
      if (p.when && typeof g2 === "string" && !p.when(g2)) return m;
      return `${p.keepPrefix && typeof g1 === "string" ? g1 : ""}[REDACTED]${p.suffix ?? ""}`;
    });
  }
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
        // Non-Error values: strings are scrubbed, anything else passes through unchanged.
        if (!(e instanceof Error)) return typeof e === "string" ? scrubSecrets(e) : e;
        const s = pino.stdSerializers.err(e);
        return { ...s, message: scrubSecrets(String(s.message ?? "")), stack: s.stack ? scrubSecrets(s.stack) : undefined };
      },
    },
  };
  return opts.destination ? pino(options, opts.destination as unknown as DestinationStream) : pino(options);
}

export type { Logger };
