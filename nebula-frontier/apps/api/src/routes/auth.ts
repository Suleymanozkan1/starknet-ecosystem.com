/**
 * Authentication: SIWS-style wallet login, email/password, refresh rotation with reuse detection,
 * logout, session management and wallet linking.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  ACCESS_TOKEN_TTL_SEC, COOKIE_CSRF, COOKIE_REFRESH, NONCE_TTL_SEC, REFRESH_TOKEN_TTL_SEC, createRefreshToken,
  generateNonce, hashPassword, parseRefreshToken, sha256Hex, signAccessToken, verifyDummyPassword, verifyPassword,
} from "@nebula/authentication";
import { buildLoginMessage, verifyWalletSignature } from "@nebula/blockchain";
import type { NonceResponse } from "@nebula/shared";
import {
  linkWalletSchema, loginRequestSchema, nonceRequestSchema, registerRequestSchema, verifyRequestSchema,
} from "@nebula/validation";
import { ApiHttpError, conflict, forbidden, unauthorized } from "../errors.js";
import { clearAuthCookies, setAuthCookies } from "../lib/cookies.js";
import { flagRisk } from "../lib/economy.js";
import { buildMe } from "../lib/me.js";
import { notify } from "../lib/notify.js";
import { createUserWithUniqueName, issueSession, revokeAllSessions } from "../lib/sessions.js";

const LOGIN_FAIL_LIMIT = 5;
const LOCKOUT_SEC = 15 * 60;

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  const { db, redis, env } = app;
  const rl = app.rateLimits;

  // ------------------------------------------------------------------ wallet nonce
  app.post("/api/auth/nonce", { config: { rateLimit: rl.auth }, preHandler: app.optionalAuth }, async (req): Promise<NonceResponse> => {
    const body = app.parse(nonceRequestSchema, req.body);
    if (body.purpose === "LINK_WALLET" && !req.user) throw unauthorized("Sign in before linking a wallet");
    const nonce = generateNonce(32);
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + NONCE_TTL_SEC * 1000);
    const message = buildLoginMessage({ domain: env.authDomain, address: body.address, nonce, issuedAt, expiresAt, purpose: body.purpose });
    await db.walletNonce.create({
      data: {
        address: body.address,
        nonce,
        message,
        purpose: body.purpose,
        userId: body.purpose === "LINK_WALLET" ? req.user.id : null,
        expiresAt,
        ip: req.ip,
      },
    });
    // Opportunistic cleanup of this address' stale nonces.
    await db.walletNonce.deleteMany({ where: { address: body.address, expiresAt: { lt: new Date(Date.now() - 3_600_000) } } });
    return { nonce, message, expiresAt: expiresAt.toISOString() };
  });

  /**
   * Validate and atomically consume a nonce, then verify the ed25519 signature over the exact
   * stored message. The nonce is burned even if the signature is wrong (no grinding).
   */
  async function consumeNonce(req: FastifyRequest, input: { address: string; nonce: string; signature: string }, purpose: string) {
    const row = await db.walletNonce.findUnique({ where: { nonce: input.nonce } });
    if (!row || row.address !== input.address || row.purpose !== purpose) throw unauthorized("Invalid nonce", "INVALID_NONCE");
    if (row.usedAt) throw unauthorized("Nonce already used", "NONCE_USED");
    if (row.expiresAt.getTime() <= Date.now()) throw unauthorized("Nonce expired", "NONCE_EXPIRED");
    if (env.WALLET_NONCE_BIND_IP && row.ip && row.ip !== req.ip) throw unauthorized("Nonce was issued to another client", "INVALID_NONCE");
    const consumed = await db.walletNonce.updateMany({
      where: { id: row.id, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (consumed.count !== 1) throw unauthorized("Nonce already used", "NONCE_USED");
    const ok = await verifyWalletSignature(input.address, row.message, input.signature);
    if (!ok) throw unauthorized("Invalid wallet signature", "INVALID_SIGNATURE");
    return row;
  }

  // ------------------------------------------------------------------ wallet verify (login)
  app.post("/api/auth/verify", { config: { rateLimit: rl.authVerify } }, async (req, reply) => {
    const body = app.parse(verifyRequestSchema, req.body);
    await consumeNonce(req, body, "LOGIN");

    let wallet = await db.wallet.findUnique({ where: { address: body.address } });
    if (wallet?.unlinkedAt) throw forbidden("This wallet was unlinked from its account", "WALLET_UNLINKED");
    if (!wallet) {
      try {
        wallet = await db.$transaction(async (tx) => {
          const user = await createUserWithUniqueName(tx, {});
          if (!user) throw new Error("username allocation failed");
          return tx.wallet.create({ data: { userId: user.id, address: body.address, primary: true } });
        });
      } catch (err) {
        // Concurrent first login with the same wallet: the other request created it.
        if ((err as { code?: string }).code !== "P2002") throw err;
        wallet = await db.wallet.findUnique({ where: { address: body.address } });
        if (!wallet) throw err;
      }
    }
    const issued = await issueSession(db, env, req, reply, wallet.userId, body.deviceId);
    return issued.response;
  });

  // ------------------------------------------------------------------ link additional wallet
  app.post("/api/auth/link-wallet", { config: { rateLimit: rl.authVerify }, preHandler: app.authenticate }, async (req) => {
    const body = app.parse(linkWalletSchema, req.body);
    const row = await consumeNonce(req, body, "LINK_WALLET");
    if (row.userId !== req.user.id) throw unauthorized("Nonce was issued to another account", "INVALID_NONCE");
    const existing = await db.wallet.findUnique({ where: { address: body.address } });
    if (existing && existing.userId !== req.user.id) throw conflict("WALLET_IN_USE", "Wallet is linked to another account");
    if (existing && !existing.unlinkedAt) return buildMe(db, req.user.id);
    const hasPrimary = await db.wallet.count({ where: { userId: req.user.id, primary: true, unlinkedAt: null } });
    await db.$transaction(async (tx) => {
      if (existing) {
        await tx.wallet.update({ where: { id: existing.id }, data: { unlinkedAt: null, verifiedAt: new Date(), primary: hasPrimary === 0 } });
      } else {
        await tx.wallet.create({ data: { userId: req.user.id, address: body.address, primary: hasPrimary === 0 } });
      }
      await notify(tx, req.user.id, "SECURITY_WALLET_LINKED", "New wallet linked", "A new wallet was linked to your account. Withdrawals to a newly linked wallet are locked for a security period.", {
        address: body.address,
      });
      await app.audit(req, { action: "WALLET_LINK", targetType: "Wallet", targetId: body.address }, tx);
    });
    await flagRisk(db, req.user.id, "WALLET_CHANGE", 1, { address: body.address }, "auth");
    return buildMe(db, req.user.id);
  });

  // ------------------------------------------------------------------ email / password
  app.post("/api/auth/register", { config: { rateLimit: rl.register } }, async (req, reply) => {
    const body = app.parse(registerRequestSchema, req.body);
    const taken = await db.user.findFirst({
      where: { OR: [{ email: body.email }, { username: { equals: body.username, mode: "insensitive" } }] },
      select: { id: true },
    });
    if (taken) throw conflict("ACCOUNT_EXISTS", "Email or username already registered");
    const passwordHash = await hashPassword(body.password);
    let userId: string;
    try {
      const user = await db.$transaction((tx) => createUserWithUniqueName(tx, { email: body.email, passwordHash, username: body.username }));
      if (!user) throw conflict("ACCOUNT_EXISTS", "Email or username already registered");
      userId = user.id;
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") throw conflict("ACCOUNT_EXISTS", "Email or username already registered");
      throw err;
    }
    const issued = await issueSession(db, env, req, reply, userId, body.deviceId);
    return reply.status(201).send(issued.response);
  });

  app.post("/api/auth/login", { config: { rateLimit: rl.auth } }, async (req, reply) => {
    const body = app.parse(loginRequestSchema, req.body);
    const key = sha256Hex(body.email);
    if (await redis.exists(`auth:lock:${key}`)) {
      throw new ApiHttpError(429, "ACCOUNT_LOCKED", "Too many failed attempts. Try again later.");
    }
    const user = await db.user.findUnique({ where: { email: body.email }, select: { id: true, passwordHash: true } });
    const ok = user?.passwordHash ? await verifyPassword(user.passwordHash, body.password) : await verifyDummyPassword(body.password);
    if (!ok || !user) {
      const fails = await redis.incr(`auth:fail:${key}`);
      if (fails === 1) await redis.expire(`auth:fail:${key}`, LOCKOUT_SEC);
      if (fails >= LOGIN_FAIL_LIMIT) {
        await redis.set(`auth:lock:${key}`, "1", "EX", LOCKOUT_SEC);
        await redis.del(`auth:fail:${key}`);
        if (user) {
          await flagRisk(db, user.id, "BRUTE_FORCE_LOGIN", 3, { ip: req.ip }, "auth");
          await notify(db, user.id, "SECURITY_LOCKOUT", "Sign-in temporarily locked", "Several failed password attempts were made on your account. Sign-in is locked for 15 minutes.");
        }
      }
      throw unauthorized("Invalid email or password", "INVALID_CREDENTIALS");
    }
    await redis.del(`auth:fail:${key}`);
    const issued = await issueSession(db, env, req, reply, user.id, body.deviceId);
    return issued.response;
  });

  // ------------------------------------------------------------------ refresh (rotation + reuse detection)
  app.post("/api/auth/refresh", { config: { rateLimit: rl.auth } }, async (req, reply) => {
    app.checkCsrf(req);
    const raw = req.cookies?.[COOKIE_REFRESH];
    const parsed = raw ? parseRefreshToken(raw) : null;
    if (!parsed) throw unauthorized("Missing refresh token", "NO_REFRESH_TOKEN");
    const session = await db.session.findUnique({
      where: { id: parsed.sessionId },
      include: { user: { select: { id: true, username: true, bannedAt: true, adminUser: { select: { roles: true } } } } },
    });
    if (!session || session.revokedAt) {
      clearAuthCookies(reply, env);
      throw unauthorized("Session revoked", "SESSION_REVOKED");
    }
    if (session.refreshTokenHash !== parsed.hash) {
      const grace = await redis.get(`rt:grace:${parsed.hash}`);
      if (grace === session.id) throw conflict("REFRESH_RACE", "Session was refreshed concurrently; retry with the new cookie");
      // A rotated-out refresh token was presented: assume theft, kill every session.
      const n = await revokeAllSessions(db, session.userId);
      await flagRisk(db, session.userId, "REFRESH_TOKEN_REUSE", 10, { sessionId: session.id, ip: req.ip, revoked: n }, "auth");
      await notify(db, session.userId, "SECURITY_TOKEN_REUSE", "All sessions signed out", "A stale sign-in token was reused, which can indicate stolen credentials. All sessions were signed out.");
      clearAuthCookies(reply, env);
      throw unauthorized("Refresh token reuse detected; all sessions revoked", "TOKEN_REUSE");
    }
    if (session.expiresAt.getTime() <= Date.now()) {
      clearAuthCookies(reply, env);
      throw unauthorized("Session expired", "SESSION_EXPIRED");
    }
    if (session.user.bannedAt) {
      await revokeAllSessions(db, session.userId);
      clearAuthCookies(reply, env);
      throw forbidden("Account suspended", "ACCOUNT_BANNED");
    }
    const next = createRefreshToken(session.id);
    const rotated = await db.session.updateMany({
      where: { id: session.id, refreshTokenHash: parsed.hash, revokedAt: null },
      data: { refreshTokenHash: next.hash, lastUsedAt: new Date(), expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SEC * 1000), ip: req.ip },
    });
    if (rotated.count !== 1) throw conflict("REFRESH_RACE", "Session was refreshed concurrently; retry with the new cookie");
    await redis.set(`rt:grace:${parsed.hash}`, session.id, "EX", 30);
    const access = await signAccessToken(
      { sub: session.userId, username: session.user.username, roles: session.user.adminUser?.roles ?? [], sid: session.id },
      env.JWT_SECRET,
      ACCESS_TOKEN_TTL_SEC,
    );
    const csrfToken = setAuthCookies(reply, env, access, next.token, req.cookies?.[COOKIE_CSRF]);
    return {
      user: await buildMe(db, session.userId),
      accessTokenExpiresAt: new Date(Date.now() + ACCESS_TOKEN_TTL_SEC * 1000).toISOString(),
      csrfToken,
    };
  });

  // ------------------------------------------------------------------ logout
  app.post("/api/auth/logout", async (req, reply) => {
    if (req.authVia !== "bearer") app.checkCsrf(req);
    const raw = req.cookies?.[COOKIE_REFRESH];
    const sid = req.authClaims?.sid ?? (raw ? parseRefreshToken(raw)?.sessionId : undefined);
    if (sid) await db.session.updateMany({ where: { id: sid, revokedAt: null }, data: { revokedAt: new Date() } });
    clearAuthCookies(reply, env);
    return { ok: true };
  });

  app.post("/api/auth/logout-all", { preHandler: app.authenticate }, async (req, reply) => {
    const n = await revokeAllSessions(db, req.user.id);
    clearAuthCookies(reply, env);
    return { ok: true, revoked: n };
  });

  app.get("/api/auth/sessions", { preHandler: app.authenticate }, async (req) => {
    const rows = await db.session.findMany({
      where: { userId: req.user.id, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastUsedAt: "desc" },
      select: { id: true, userAgent: true, ip: true, createdAt: true, lastUsedAt: true },
    });
    return { sessions: rows.map((s) => ({ ...s, current: s.id === req.user.sessionId })) };
  });

  app.delete<{ Params: { id: string } }>("/api/auth/sessions/:id", { preHandler: app.authenticate }, async (req) => {
    const r = await db.session.updateMany({ where: { id: req.params.id, userId: req.user.id, revokedAt: null }, data: { revokedAt: new Date() } });
    return { ok: r.count === 1 };
  });
}
