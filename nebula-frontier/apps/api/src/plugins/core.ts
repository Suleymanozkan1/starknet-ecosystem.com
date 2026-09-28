/**
 * Core decorators: db, redis, env, identify/authenticate (+CSRF), RBAC, feature flags, audit,
 * rate limiters and zod parsing. Registered on the root instance so every route module sees them.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { Redis } from "ioredis";
import type { z } from "zod";
import {
  COOKIE_ACCESS, COOKIE_CSRF, CSRF_HEADER, hasAnyRole, safeEqual, verifyAccessToken, type AccessClaims,
} from "@nebula/authentication";
import { AdminRole, RiskLevel } from "@nebula/shared";
import type { Db } from "@nebula/database";
import type { Env } from "../env.js";
import { ApiHttpError, forbidden, unauthorized, zodDetails } from "../errors.js";
import { toJsonValue } from "../lib/json.js";
import type { AuditEntry, AuthUser, PreHandler, RateLimitPreset, RateLimitPresetName } from "../types.js";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const RISK_ORDER: Record<string, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

export interface CoreOptions {
  db: Db;
  redis: Redis;
  env: Env;
  /** Multiplies every rate-limit max (tests use a large value; production keeps 1). */
  rateLimitScale: number;
  /** Redis key namespace for rate-limit counters. */
  rateLimitNamespace: string;
}

function extractToken(req: FastifyRequest): { token: string; via: "cookie" | "bearer" } | null {
  const h = req.headers.authorization;
  if (typeof h === "string" && h.startsWith("Bearer ")) {
    const t = h.slice(7).trim();
    if (t) return { token: t, via: "bearer" };
  }
  const c = req.cookies?.[COOKIE_ACCESS];
  if (c) return { token: c, via: "cookie" };
  return null;
}

/** Rate-limit key: authenticated user id when the access token verifies, else client IP. */
export function clientKey(req: FastifyRequest): string {
  return req.authClaims ? `u:${req.authClaims.sub}` : `ip:${req.ip}`;
}

interface FlagRules {
  allowCountries?: string[];
  denyCountries?: string[];
  allowRegions?: string[];
  denyRegions?: string[];
  minAge?: number;
  requireKyc?: "NONE" | "BASIC" | "FULL";
  denyRestrictions?: string[];
  maxRiskLevel?: string;
}
const KYC_ORDER: Record<string, number> = { NONE: 0, BASIC: 1, FULL: 2 };

/**
 * Transport security: helmet (strict CSP for a JSON API, HSTS in production), CORS allowlist with
 * credentials (CORS_ORIGINS), cookie parsing.
 */
export async function registerSecurity(app: FastifyInstance, env: Env): Promise<void> {
  await app.register(helmet, {
    // Pure JSON API: nothing may be framed, scripted or embedded.
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: "same-site" },
    hsts: env.isProd ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false,
    referrerPolicy: { policy: "no-referrer" },
  });
  await app.register(cors, {
    origin: (origin, cb) => {
      // Non-browser clients (no Origin) are allowed; browsers only from the allowlist.
      if (!origin) return cb(null, true);
      cb(null, env.CORS_ORIGINS.includes(origin));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["content-type", "authorization", "x-nf-csrf", "x-request-id", "x-correlation-id", "idempotency-key"],
    exposedHeaders: ["x-request-id", "x-correlation-id", "retry-after", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"],
    maxAge: 600,
  });
  await app.register(cookie, { hook: "onRequest" });
}

export async function registerCore(app: FastifyInstance, opts: CoreOptions): Promise<void> {
  const { db, redis, env } = opts;
  app.decorate("db", db);
  app.decorate("redis", redis);
  app.decorate("env", env);
  app.decorateRequest("user", null as unknown as AuthUser);
  app.decorateRequest("authClaims", null);
  app.decorateRequest("authVia", null);
  app.decorateRequest("correlationId", "");

  // ---- Identify early (no DB): verified claims are used for per-user rate-limit keys. ----
  app.addHook("onRequest", async (req) => {
    const hdr = req.headers["x-correlation-id"];
    req.correlationId = typeof hdr === "string" && /^[A-Za-z0-9._-]{8,128}$/.test(hdr) ? hdr : req.id;
    const found = extractToken(req);
    if (!found) return;
    try {
      req.authClaims = await verifyAccessToken(found.token, env.JWT_SECRET);
      req.authVia = found.via;
    } catch {
      req.authClaims = null;
      req.authVia = null;
    }
  });

  // ---- Rate limiting (Redis store shared by all API instances). ----
  const scale = Math.max(1, opts.rateLimitScale);
  await app.register(rateLimit, {
    global: true,
    max: 300 * scale,
    timeWindow: 60_000,
    redis,
    nameSpace: opts.rateLimitNamespace,
    skipOnError: false,
    keyGenerator: clientKey,
    errorResponseBuilder: (_req, ctx) =>
      new ApiHttpError(ctx.statusCode, ctx.ban ? "RATE_LIMIT_BANNED" : "RATE_LIMITED", `Too many requests, retry in ${ctx.after}`),
  });

  const ipKey = (req: FastifyRequest) => `ip:${req.ip}`;
  const presets: Record<RateLimitPresetName, RateLimitPreset> = {
    // Brute-force protection keyed by IP (no identity yet).
    auth: { max: 20 * scale, timeWindow: 60_000, keyGenerator: ipKey },
    authVerify: { max: 10 * scale, timeWindow: 60_000, keyGenerator: ipKey },
    register: { max: 5 * scale, timeWindow: 10 * 60_000, keyGenerator: ipKey },
    wallet: { max: 20 * scale, timeWindow: 60_000 },
    withdrawal: { max: 3 * scale, timeWindow: 60_000 },
    chat: { max: 30 * scale, timeWindow: 60_000 },
    purchase: { max: 20 * scale, timeWindow: 60_000 },
    market: { max: 30 * scale, timeWindow: 60_000 },
    bid: { max: 10 * scale, timeWindow: 60_000 },
    social: { max: 60 * scale, timeWindow: 60_000 },
    admin: { max: 120 * scale, timeWindow: 60_000 },
  };
  app.decorate("rateLimits", presets);

  const limiter = (name: string, max: number, windowMs: number): PreHandler => {
    const check = app.createRateLimit({
      max: max * scale,
      timeWindow: windowMs,
      keyGenerator: (req) => `${name}:${req.user?.id ? `u:${req.user.id}` : clientKey(req)}`,
    });
    return async (req, reply) => {
      const r = await check(req);
      if (!r.isAllowed && r.isExceeded) {
        reply.header("retry-after", r.ttlInSeconds);
        throw new ApiHttpError(429, "RATE_LIMITED", `Too many requests, retry in ${r.ttlInSeconds}s`);
      }
    };
  };
  app.decorate("limiter", limiter);
  app.decorate("rateLimitStrict", limiter("wallet-strict", 10, 60_000));
  const wdMinute = limiter("withdraw-m", 3, 60_000);
  const wdHour = limiter("withdraw-h", 10, 60 * 60_000);
  app.decorate("rateLimitWithdrawal", async (req: FastifyRequest, reply: FastifyReply) => {
    await wdMinute(req, reply);
    await wdHour(req, reply);
  });

  // ---- zod parsing ----
  app.decorate("parse", <S extends z.ZodType>(schema: S, data: unknown): z.output<S> => {
    const res = schema.safeParse(data);
    if (!res.success) throw new ApiHttpError(400, "VALIDATION_ERROR", "Invalid request", zodDetails(res.error));
    return res.data;
  });

  // ---- Authentication ----
  const originAllowed = (origin: string) => env.CORS_ORIGINS.includes(origin);

  function checkCsrf(req: FastifyRequest): void {
    const header = req.headers[CSRF_HEADER];
    const cookie = req.cookies?.[COOKIE_CSRF];
    if (typeof header !== "string" || !cookie || !safeEqual(header, cookie)) {
      throw new ApiHttpError(403, "CSRF_FAILED", "Missing or invalid CSRF token (x-nf-csrf header must match nf_csrf cookie)");
    }
    const origin = req.headers.origin;
    if (typeof origin === "string" && origin !== "null" && env.CORS_ORIGINS.length > 0 && !originAllowed(origin)) {
      throw new ApiHttpError(403, "CSRF_FAILED", "Origin not allowed");
    }
  }

  async function loadUser(claims: AccessClaims): Promise<AuthUser> {
    const s = await db.session.findUnique({
      where: { id: claims.sid },
      select: {
        userId: true,
        revokedAt: true,
        expiresAt: true,
        user: { select: { username: true, bannedAt: true, adminUser: { select: { roles: true } } } },
      },
    });
    if (!s || s.revokedAt || s.expiresAt.getTime() <= Date.now() || s.userId !== claims.sub) {
      throw unauthorized("Session expired or revoked", "SESSION_REVOKED");
    }
    if (s.user.bannedAt) throw forbidden("Account suspended", "ACCOUNT_BANNED");
    const roles = (s.user.adminUser?.roles ?? []).filter((r): r is AdminRole => r in AdminRole);
    return { id: claims.sub, username: s.user.username, roles, sessionId: claims.sid };
  }

  const authenticate: PreHandler = async (req) => {
    if (!req.authClaims) throw unauthorized();
    req.user = await loadUser(req.authClaims);
    if (req.authVia === "cookie" && MUTATING.has(req.method)) checkCsrf(req);
  };
  app.decorate("authenticate", authenticate);
  app.decorate("optionalAuth", async (req: FastifyRequest) => {
    if (!req.authClaims) return;
    try {
      req.user = await loadUser(req.authClaims);
    } catch {
      req.user = null as unknown as AuthUser;
    }
  });
  /** Exposed for cookie-only routes that are not behind authenticate (refresh/logout). */
  app.decorate("checkCsrf", checkCsrf);

  app.decorate("requireRole", (...roles: AdminRole[]): PreHandler => async (req) => {
    if (!req.user) throw unauthorized();
    if (!hasAnyRole(req.user.roles, roles)) throw forbidden("Insufficient role", "FORBIDDEN_ROLE");
  });

  // ---- Feature flags / compliance gating ----
  const flagCache = new Map<string, { at: number; enabled: boolean; rules: FlagRules }>();
  async function loadFlag(key: string) {
    const hit = flagCache.get(key);
    if (hit && Date.now() - hit.at < 10_000) return hit;
    const row = await db.featureFlag.findUnique({ where: { key } });
    const v = { at: Date.now(), enabled: row?.enabled ?? false, rules: (row?.rules ?? {}) as FlagRules };
    flagCache.set(key, v);
    return v;
  }
  app.decorate("requireFeature", (key: string): PreHandler => async (req) => {
    const flag = await loadFlag(key);
    if (!flag.enabled) throw forbidden(`Feature "${key}" is not available`, "FEATURE_DISABLED");
    if (!req.user) throw unauthorized();
    const u = await db.user.findUnique({
      where: { id: req.user.id },
      select: { country: true, region: true, birthYear: true, kycStatus: true, restrictions: true, riskLevel: true },
    });
    if (!u) throw unauthorized();
    const r = flag.rules;
    const country = u.country?.toUpperCase() ?? null;
    const deny = (why: string) => forbidden(`Feature "${key}" is not available: ${why}`, "FEATURE_RESTRICTED");
    if (r.allowCountries?.length && (!country || !r.allowCountries.includes(country))) throw deny("country");
    if (country && r.denyCountries?.includes(country)) throw deny("country");
    if (r.allowRegions?.length && (!u.region || !r.allowRegions.includes(u.region))) throw deny("region");
    if (u.region && r.denyRegions?.includes(u.region)) throw deny("region");
    if (r.minAge) {
      if (!u.birthYear || new Date().getUTCFullYear() - u.birthYear < r.minAge) throw deny("age verification required");
    }
    if (r.requireKyc && (KYC_ORDER[u.kycStatus] ?? 0) < (KYC_ORDER[r.requireKyc] ?? 0)) throw deny("identity verification required");
    if (r.denyRestrictions?.some((x) => u.restrictions.includes(x))) throw deny("account restriction");
    if (r.maxRiskLevel && (RISK_ORDER[u.riskLevel] ?? 0) > (RISK_ORDER[r.maxRiskLevel] ?? RISK_ORDER[RiskLevel.CRITICAL]!)) {
      throw deny("account under review");
    }
  });

  // ---- Audit ----
  app.decorate("audit", async (req: FastifyRequest, entry: AuditEntry, tx?: Parameters<FastifyInstance["audit"]>[2]) => {
    const client = tx ?? db;
    await client.auditLog.create({
      data: {
        actorId: req.user?.id ?? null,
        actorType: req.user?.roles?.length ? "ADMIN" : req.user ? "USER" : "SYSTEM",
        action: entry.action,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        ...(entry.oldValue === undefined ? {} : { oldValue: toJsonValue(entry.oldValue) }),
        ...(entry.newValue === undefined ? {} : { newValue: toJsonValue(entry.newValue) }),
        reason: entry.reason ?? null,
        ip: req.ip,
        requestId: req.id,
        correlationId: req.correlationId || req.id,
      },
    });
  });
}

declare module "fastify" {
  interface FastifyInstance {
    checkCsrf: (req: FastifyRequest) => void;
  }
}
