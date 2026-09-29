/**
 * Opaque tokens: refresh tokens, CSRF tokens and wallet-login nonces.
 *
 * Refresh token format: `<sessionId>.<secret>` where secret = 32 random bytes (base64url).
 * Only sha256(secret) is persisted (`Session.refreshTokenHash`). Embedding the session id lets
 * the server detect reuse of a rotated-out token (id matches, hash does not) and revoke every
 * session of that user (refresh-token reuse detection, RFC 6819 §5.2.2.3).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const ACCESS_TOKEN_TTL_SEC = 15 * 60;
export const REFRESH_TOKEN_TTL_SEC = 30 * 24 * 60 * 60;
export const NONCE_TTL_SEC = 5 * 60;

export const COOKIE_ACCESS = "nf_access";
export const COOKIE_REFRESH = "nf_refresh";
export const COOKIE_CSRF = "nf_csrf";
export const CSRF_HEADER = "x-nf-csrf";

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Alphanumeric nonce (SIWS nonces must be alphanumeric, >= 8 chars). */
export function generateNonce(length = 32): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const out: string[] = [];
  // Rejection sampling to avoid modulo bias (62 symbols; accept bytes < 248).
  while (out.length < length) {
    for (const b of randomBytes(length * 2)) {
      if (b < 248 && out.length < length) out.push(alphabet[b % 62] as string);
    }
  }
  return out.join("");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface RefreshToken {
  token: string;
  hash: string;
}

export function createRefreshToken(sessionId: string): RefreshToken {
  const secret = randomToken(32);
  return { token: `${sessionId}.${secret}`, hash: sha256Hex(secret) };
}

export function parseRefreshToken(token: string): { sessionId: string; hash: string } | null {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot > 64) return null;
  const sessionId = token.slice(0, dot);
  const secret = token.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId) || !/^[A-Za-z0-9_-]{40,64}$/.test(secret)) return null;
  return { sessionId, hash: sha256Hex(secret) };
}

/**
 * Constant-time string comparison. Both inputs are hashed to fixed-length sha256 digests first,
 * so neither the content nor the length of the secret leaks through timing.
 */
export function safeEqual(a: string, b: string): boolean {
  const da = createHash("sha256").update(a).digest();
  const db = createHash("sha256").update(b).digest();
  return timingSafeEqual(da, db);
}
