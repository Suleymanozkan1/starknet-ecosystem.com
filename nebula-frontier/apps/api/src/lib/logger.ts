/**
 * Pino logger options with redaction of secrets (tokens, cookies, passwords, signatures, keys).
 */
import type { FastifyServerOptions } from "fastify";

export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-nf-csrf"]',
  'req.headers["x-internal-token"]',
  'res.headers["set-cookie"]',
  "*.password",
  "*.passwordHash",
  "*.refreshToken",
  "*.accessToken",
  "*.token",
  "*.ticket",
  "*.secret",
  "*.privateKey",
  "*.signature",
  "*.cookie",
  "body.password",
  "body.signature",
  "body.token",
];

export function loggerOptions(level: string): FastifyServerOptions["logger"] {
  return {
    level,
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
    base: { service: "api" },
    serializers: {
      req(req: { method: string; url: string; id: string; ip?: string }) {
        // Never log query strings of auth routes (they could carry tokens in misbehaving clients).
        const url = req.url.startsWith("/api/auth") ? req.url.split("?")[0] : req.url;
        return { method: req.method, url, id: req.id, ip: req.ip };
      },
    },
  };
}
