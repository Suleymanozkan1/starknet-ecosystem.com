/**
 * Session issuance, device tracking and new-device / suspicious-login detection.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import {
  ACCESS_TOKEN_TTL_SEC, REFRESH_TOKEN_TTL_SEC, createRefreshToken, randomToken, sha256Hex, signAccessToken,
} from "@nebula/authentication";
import type { Db, Tx } from "@nebula/database";
import type { AuthResponse } from "@nebula/shared";
import { isReservedUsername } from "@nebula/validation";
import type { Env } from "../env.js";
import { forbidden } from "../errors.js";
import { setAuthCookies } from "./cookies.js";
import { flagRisk } from "./economy.js";
import { buildMe } from "./me.js";
import { notify } from "./notify.js";

export function deviceFingerprint(req: FastifyRequest, deviceId?: string): string {
  if (deviceId) return `d:${deviceId}`;
  return `ua:${sha256Hex(String(req.headers["user-agent"] ?? "unknown")).slice(0, 32)}`;
}

export function platformOf(req: FastifyRequest): string {
  const ua = String(req.headers["user-agent"] ?? "").toLowerCase();
  if (ua.includes("android")) return "android";
  if (ua.includes("iphone") || ua.includes("ipad") || ua.includes("ios")) return "ios";
  return "web";
}

/** Create a user with an auto-generated `pilot_<8 hex>` username (retries on collision). */
export async function createUserWithUniqueName(tx: Tx, data: { email?: string; passwordHash?: string; username?: string }) {
  // Invariant (schemas already reject it): the `bot_` namespace belongs to server-owned bot accounts.
  if (data.username !== undefined && isReservedUsername(data.username)) throw new Error("Reserved username prefix");
  for (let i = 0; i < 6; i++) {
    const username = data.username ?? `pilot_${randomBytes(4).toString("hex")}`;
    const exists = await tx.user.findUnique({ where: { username }, select: { id: true } });
    if (exists) {
      if (data.username) return null;
      continue;
    }
    const user = await tx.user.create({
      data: { username, email: data.email ?? null, passwordHash: data.passwordHash ?? null },
    });
    await tx.playerStat.create({ data: { userId: user.id } });
    return user;
  }
  throw new Error("Could not allocate a username");
}

async function trackDevice(db: Db, req: FastifyRequest, userId: string, fingerprint: string): Promise<void> {
  const existing = await db.device.findUnique({ where: { userId_fingerprint: { userId, fingerprint } } });
  if (existing) {
    await db.device.update({ where: { id: existing.id }, data: { lastSeenAt: new Date(), ip: req.ip } });
    return;
  }
  const [otherDevices, knownIp] = await Promise.all([
    db.device.count({ where: { userId } }),
    db.session.findFirst({
      where: { userId, ip: req.ip, createdAt: { gte: new Date(Date.now() - 90 * 86_400_000) } },
      select: { id: true },
    }),
  ]);
  await db.device.create({ data: { userId, fingerprint, platform: platformOf(req), ip: req.ip } });
  if (otherDevices === 0) return; // first device of a new account
  await notify(db, userId, "SECURITY_NEW_DEVICE", "New device sign-in", "Your account was accessed from a new device. If this wasn't you, sign out all sessions and secure your wallet.", {
    platform: platformOf(req),
    at: new Date().toISOString(),
  });
  if (!knownIp) {
    await flagRisk(db, userId, "SUSPICIOUS_LOGIN", 5, { reason: "new device from unseen IP", ip: req.ip, fingerprint }, "auth");
  }
}

export interface IssuedSession {
  response: AuthResponse & { csrfToken: string };
  sessionId: string;
}

export async function issueSession(
  db: Db,
  env: Env,
  req: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  deviceId?: string,
  method: "wallet" | "password" | "register" = "password",
): Promise<IssuedSession> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, username: true, bannedAt: true, adminUser: { select: { roles: true } } },
  });
  if (!user) throw forbidden("Account not found");
  if (user.bannedAt) throw forbidden("Account suspended", "ACCOUNT_BANNED");
  const fingerprint = deviceFingerprint(req, deviceId);
  await trackDevice(db, req, userId, fingerprint);

  const sessionId = randomToken(18);
  const refresh = createRefreshToken(sessionId);
  await db.session.create({
    data: {
      id: sessionId,
      userId,
      refreshTokenHash: refresh.hash,
      userAgent: String(req.headers["user-agent"] ?? "").slice(0, 255) || null,
      ip: req.ip,
      deviceId: fingerprint,
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SEC * 1000),
    },
  });
  await db.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
  req.server.analytics.track("LOGIN", userId, { method, sessionId }, platformOf(req));
  const access = await signAccessToken(
    { sub: userId, username: user.username, roles: user.adminUser?.roles ?? [], sid: sessionId },
    env.jwtKeys,
    ACCESS_TOKEN_TTL_SEC,
  );
  // Always mint a fresh CSRF token at login (never trust a pre-login cookie: cookie tossing).
  const csrfToken = setAuthCookies(reply, env, access, refresh.token);
  return {
    sessionId,
    response: {
      user: await buildMe(db, userId),
      accessTokenExpiresAt: new Date(Date.now() + ACCESS_TOKEN_TTL_SEC * 1000).toISOString(),
      csrfToken,
    },
  };
}

/** Revoke every active session of a user (logout-all, token reuse, ban). */
export async function revokeAllSessions(db: Db | Tx, userId: string): Promise<number> {
  const r = await db.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
  return r.count;
}
