/**
 * API-specific redaction paths, added on top of @nebula/telemetry's REDACT_PATHS
 * (tokens, cookies, passwords, signatures, secrets are already covered there).
 */
export const REDACT_PATHS = [
  'req.headers["x-nf-csrf"]',
  'req.headers["x-internal-token"]',
  "body.password",
  "body.signature",
  "body.token",
  "*.nonce",
  "*.csrfToken",
];
