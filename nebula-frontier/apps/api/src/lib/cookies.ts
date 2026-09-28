/**
 * Auth cookie contract (documented in docs/SECURITY.md):
 *  - nf_access  httpOnly, path=/,          15 min  — access JWT
 *  - nf_refresh httpOnly, path=/api/auth,  30 days — opaque rotating refresh token
 *  - nf_csrf    readable, path=/,          30 days — double-submit CSRF token; send it back as `x-nf-csrf`
 * All: SameSite=Lax, Secure in production, Domain=COOKIE_DOMAIN when set.
 */
import type { FastifyReply } from "fastify";
import {
  ACCESS_TOKEN_TTL_SEC, COOKIE_ACCESS, COOKIE_CSRF, COOKIE_REFRESH, REFRESH_TOKEN_TTL_SEC, randomToken,
} from "@nebula/authentication";
import type { Env } from "../env.js";

function base(env: Env) {
  return {
    secure: env.isProd,
    sameSite: "lax" as const,
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
  };
}

export function setAuthCookies(reply: FastifyReply, env: Env, accessToken: string, refreshToken: string): string {
  const csrf = randomToken(24);
  reply.setCookie(COOKIE_ACCESS, accessToken, { ...base(env), httpOnly: true, path: "/", maxAge: ACCESS_TOKEN_TTL_SEC });
  reply.setCookie(COOKIE_REFRESH, refreshToken, { ...base(env), httpOnly: true, path: "/api/auth", maxAge: REFRESH_TOKEN_TTL_SEC });
  reply.setCookie(COOKIE_CSRF, csrf, { ...base(env), httpOnly: false, path: "/", maxAge: REFRESH_TOKEN_TTL_SEC });
  return csrf;
}

export function clearAuthCookies(reply: FastifyReply, env: Env): void {
  reply.clearCookie(COOKIE_ACCESS, { ...base(env), path: "/" });
  reply.clearCookie(COOKIE_REFRESH, { ...base(env), path: "/api/auth" });
  reply.clearCookie(COOKIE_CSRF, { ...base(env), path: "/" });
}
