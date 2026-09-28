/**
 * Fastify module augmentation for the decorators provided by `buildApp` (see app.ts / plugins/core.ts).
 *
 * Contract used by every route module (including the economy engineer's wallet/economy/rewards/
 * admin-economy routes):
 *   app.db                      Prisma client (@nebula/database Db)
 *   app.redis                   ioredis client
 *   app.env                     validated environment
 *   app.authenticate            preHandler: cookie `nf_access` or `Authorization: Bearer`; sets req.user;
 *                               enforces session not revoked, user not banned, CSRF for cookie mutations
 *   app.optionalAuth            preHandler: like authenticate but anonymous requests pass (req.user = null)
 *   app.requireRole(...roles)   preHandler (use after authenticate); SUPER_ADMIN passes every check
 *   app.requireFeature(key)     preHandler (use after authenticate); FeatureFlag + compliance rules
 *   app.audit(req, entry, tx?)  append an AuditLog row (actor, ip, requestId, correlationId)
 *   app.rateLimitStrict         preHandler: strict per-user limit for wallet endpoints
 *   app.rateLimitWithdrawal     preHandler: very strict per-user withdrawal limit (per minute + per hour)
 *   app.limiter(name,max,ms)    preHandler factory for custom per-user limits
 *   app.rateLimits              route `config.rateLimit` presets (auth, wallet, chat, purchase, market, ...)
 *   app.parse(schema, data)     zod parse -> typed data, or 400 VALIDATION_ERROR ApiError
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import type { z } from "zod";
import type { AdminRole } from "@nebula/shared";
import type { AccessClaims } from "@nebula/authentication";
import type { Db, Tx } from "@nebula/database";
import type { Env } from "./env.js";

export interface AuthUser {
  id: string;
  username: string;
  roles: AdminRole[];
  sessionId: string;
}

export interface AuditEntry {
  action: string;
  targetType?: string;
  targetId?: string;
  oldValue?: unknown;
  newValue?: unknown;
  reason?: string;
}

export type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface RateLimitPreset {
  max: number;
  timeWindow: number;
  groupId?: string;
  keyGenerator?: (req: FastifyRequest) => string;
}

export type RateLimitPresetName =
  | "auth" | "authVerify" | "register" | "wallet" | "withdrawal" | "chat" | "purchase" | "market" | "bid" | "social" | "admin";

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
    redis: Redis;
    env: Env;
    authenticate: PreHandler;
    optionalAuth: PreHandler;
    requireRole: (...roles: AdminRole[]) => PreHandler;
    requireFeature: (key: string) => PreHandler;
    audit: (req: FastifyRequest, entry: AuditEntry, tx?: Tx) => Promise<void>;
    rateLimitStrict: PreHandler;
    rateLimitWithdrawal: PreHandler;
    limiter: (name: string, max: number, windowMs: number) => PreHandler;
    rateLimits: Record<RateLimitPresetName, RateLimitPreset>;
    parse: <S extends z.ZodType>(schema: S, data: unknown) => z.output<S>;
  }
  interface FastifyRequest {
    /** Set by app.authenticate. Only read it in handlers protected by authenticate. */
    user: AuthUser;
    /** Verified access-token claims (set early, before rate limiting, for per-user keys). */
    authClaims: AccessClaims | null;
    authVia: "cookie" | "bearer" | null;
    correlationId: string;
  }
}
