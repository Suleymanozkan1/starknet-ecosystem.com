/**
 * Admin (non-economy) API. RBAC per route (SUPER_ADMIN passes every check); every mutation is
 * written to AuditLog with actor, old/new values, reason, IP, request id. Bans are always manual.
 */
import type { FastifyInstance } from "fastify";
import { AdminRole } from "@nebula/shared";
import {
  adminAuditQuerySchema, adminBanSchema, adminCatalogSchema, adminEventSchema, adminFeatureFlagSchema, adminMuteSchema,
  adminReportResolveSchema, adminRiskReviewSchema, adminRolesSchema, adminShopProductPatchSchema, adminShopProductSchema,
  adminUserSearchSchema, defIdSchema, idSchema,
} from "@nebula/validation";
import { z } from "zod";
import { badRequest, conflict, notFound } from "../errors.js";
import { balancesDto } from "../lib/balances.js";
import { invalidateCatalog } from "../lib/catalog.js";
import { toJsonValue } from "../lib/json.js";
import { notify } from "../lib/notify.js";
import { API_RULE_DEFAULTS, invalidateRules, loadRules } from "../lib/rules.js";
import { revokeAllSessions } from "../lib/sessions.js";

const { SUPER_ADMIN, ADMIN, MODERATOR, SUPPORT, ECONOMY_MANAGER } = AdminRole;
const catalogKinds = z.enum(["ship", "weapon", "module", "drone", "item"]);
const mailSchema = z.object({
  toUserId: idSchema,
  subject: z.string().trim().min(1).max(120),
  body: z.string().trim().max(4000),
  attachments: z.object({
    credits: z.number().int().min(0).max(10_000_000).optional(),
    gems: z.number().int().min(0).max(100_000).optional(),
    resources: z.record(z.string(), z.number().int().min(0).max(1_000_000)).optional(),
    items: z.array(z.object({ itemId: defIdSchema, quantity: z.number().int().min(1).max(10_000) })).max(20).optional(),
  }).nullable().default(null),
  reason: z.string().trim().min(3).max(500),
});
const rulesSchema = z.object({ rules: z.record(z.string(), z.unknown()), reason: z.string().trim().min(3).max(500) });

export default async function adminRoutes(app: FastifyInstance): Promise<void> {
  const { db, redis } = app;
  const guard = (...roles: AdminRole[]) => ({ preHandler: [app.authenticate, app.requireRole(...roles)], config: { rateLimit: app.rateLimits.admin } });

  async function countOnline(): Promise<number> {
    let cursor = "0";
    let n = 0;
    let rounds = 0;
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", "presence:*", "COUNT", 1000);
      cursor = next;
      n += keys.length;
    } while (cursor !== "0" && ++rounds < 1000);
    return n;
  }

  app.get("/api/admin/overview", guard(ADMIN, MODERATOR, SUPPORT, ECONOMY_MANAGER), async () => {
    const since24 = new Date(Date.now() - 86_400_000);
    const since7d = new Date(Date.now() - 7 * 86_400_000);
    const t0 = performance.now();
    await db.$queryRaw`SELECT 1`;
    const dbMs = performance.now() - t0;
    const t1 = performance.now();
    await redis.ping();
    const redisMs = performance.now() - t1;
    const [online, rooms, purch24, purch7, deps, wds, wdPending, suspicious, suspiciousTop, reports, users, newUsers] = await Promise.all([
      countOnline(),
      db.gameRoom.findMany({ where: { disposedAt: null, heartbeatAt: { gt: new Date(Date.now() - 120_000) } }, select: { id: true, roomName: true, mapId: true, clients: true, maxClients: true, region: true } }),
      db.purchase.groupBy({ by: ["currency"], where: { createdAt: { gte: since24 }, status: "COMPLETED" }, _sum: { totalPrice: true }, _count: { _all: true } }),
      db.purchase.groupBy({ by: ["currency"], where: { createdAt: { gte: since7d }, status: "COMPLETED" }, _sum: { totalPrice: true }, _count: { _all: true } }),
      db.deposit.groupBy({ by: ["status"], where: { createdAt: { gte: since7d } }, _sum: { amount: true }, _count: { _all: true } }),
      db.withdrawal.groupBy({ by: ["status"], where: { createdAt: { gte: since7d } }, _sum: { requested: true }, _count: { _all: true } }),
      db.withdrawal.count({ where: { status: { in: ["PENDING", "PENDING_REVIEW", "PROCESSING"] } } }),
      db.user.count({ where: { riskLevel: { in: ["HIGH", "CRITICAL"] } } }),
      db.user.findMany({ where: { riskLevel: { in: ["HIGH", "CRITICAL"] } }, orderBy: { riskScore: "desc" }, take: 10, select: { id: true, username: true, riskLevel: true, riskScore: true, bannedAt: true } }),
      db.chatReport.count({ where: { status: "OPEN" } }),
      db.user.count(),
      db.user.count({ where: { createdAt: { gte: since24 } } }),
    ]);
    const sum = (rows: { currency: string; _sum: { totalPrice: bigint | null }; _count: { _all: number } }[]) =>
      Object.fromEntries(rows.map((r) => [r.currency, { amount: (r._sum.totalPrice ?? 0n).toString(), count: r._count._all }]));
    const mem = process.memoryUsage();
    return {
      players: { online, total: users, new24h: newUsers },
      rooms: { active: rooms.length, clients: rooms.reduce((s, r) => s + r.clients, 0), list: rooms },
      revenue: { purchases24h: sum(purch24), purchases7d: sum(purch7) },
      deposits7d: Object.fromEntries(deps.map((d) => [d.status, { amount: (d._sum.amount ?? 0n).toString(), count: d._count._all }])),
      withdrawals7d: Object.fromEntries(wds.map((w) => [w.status, { amount: (w._sum.requested ?? 0n).toString(), count: w._count._all }])),
      withdrawalsPending: wdPending,
      suspicious: { count: suspicious, top: suspiciousTop },
      reports: { open: reports },
      health: { dbLatencyMs: Math.round(dbMs), redisLatencyMs: Math.round(redisMs), rssMb: Math.round(mem.rss / 1e6), heapMb: Math.round(mem.heapUsed / 1e6), uptimeSec: Math.round(process.uptime()) },
    };
  });

  // ------------------------------------------------------------------ users
  app.get("/api/admin/users", guard(ADMIN, MODERATOR, SUPPORT), async (req) => {
    const q = app.parse(adminUserSearchSchema, req.query);
    const wallet = q.q && q.q.length >= 32 ? await db.wallet.findUnique({ where: { address: q.q }, select: { userId: true } }) : null;
    const rows = await db.user.findMany({
      where: {
        ...(q.q ? { OR: [{ username: { contains: q.q, mode: "insensitive" } }, { email: { contains: q.q, mode: "insensitive" } }, { id: q.q }, ...(wallet ? [{ id: wallet.userId }] : [])] } : {}),
        ...(q.riskLevel ? { riskLevel: q.riskLevel } : {}),
        ...(q.banned === undefined ? {} : q.banned ? { bannedAt: { not: null } } : { bannedAt: null }),
      },
      orderBy: { createdAt: "desc" },
      take: q.limit,
      select: { id: true, username: true, email: true, level: true, riskLevel: true, riskScore: true, bannedAt: true, mutedUntil: true, createdAt: true, lastLoginAt: true },
    });
    return { users: rows };
  });

  app.get<{ Params: { id: string } }>("/api/admin/users/:id", guard(ADMIN, MODERATOR, SUPPORT), async (req) => {
    const id = app.parse(idSchema, req.params.id);
    const u = await db.user.findUnique({
      where: { id },
      include: {
        wallets: true, adminUser: true, playerFaction: true, clanMember: true, stats: true,
        devices: { orderBy: { lastSeenAt: "desc" }, take: 20, select: { id: true, fingerprint: true, platform: true, ip: true, firstSeenAt: true, lastSeenAt: true } },
        riskSignals: { orderBy: { createdAt: "desc" }, take: 50 },
        sessions: { where: { revokedAt: null }, select: { id: true, ip: true, userAgent: true, createdAt: true, lastUsedAt: true } },
      },
    });
    if (!u) throw notFound("User");
    const { passwordHash: _omit, ...safe } = u;
    return { user: safe, balances: await balancesDto(db, id) };
  });

  app.post<{ Params: { id: string } }>("/api/admin/users/:id/ban", guard(ADMIN, MODERATOR), async (req) => {
    const id = app.parse(idSchema, req.params.id);
    const { reason } = app.parse(adminBanSchema, req.body);
    if (id === req.user.id) throw badRequest("SELF_BAN", "You cannot ban yourself");
    const target = await db.user.findUnique({ where: { id }, select: { bannedAt: true, adminUser: { select: { roles: true } } } });
    if (!target) throw notFound("User");
    if (target.adminUser?.roles.includes(SUPER_ADMIN) && !req.user.roles.includes(SUPER_ADMIN)) throw badRequest("PROTECTED_ACCOUNT", "Only a super admin can ban a super admin");
    await db.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { bannedAt: new Date() } });
      await revokeAllSessions(tx, id);
      await app.audit(req, { action: "USER_BAN", targetType: "User", targetId: id, oldValue: { bannedAt: target.bannedAt }, newValue: { banned: true }, reason }, tx);
    });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/admin/users/:id/unban", guard(ADMIN, MODERATOR), async (req) => {
    const id = app.parse(idSchema, req.params.id);
    const { reason } = app.parse(adminBanSchema, req.body);
    await db.$transaction(async (tx) => {
      const u = await tx.user.update({ where: { id }, data: { bannedAt: null } });
      await app.audit(req, { action: "USER_UNBAN", targetType: "User", targetId: u.id, newValue: { banned: false }, reason }, tx);
    });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/admin/users/:id/mute", guard(ADMIN, MODERATOR), async (req) => {
    const id = app.parse(idSchema, req.params.id);
    const body = app.parse(adminMuteSchema, req.body);
    const until = new Date(Date.now() + body.minutes * 60_000);
    await db.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { mutedUntil: until } });
      await app.audit(req, { action: "USER_MUTE", targetType: "User", targetId: id, newValue: { mutedUntil: until.toISOString() }, reason: body.reason }, tx);
    });
    await redis.set(`mute:${id}`, "1", "PX", body.minutes * 60_000);
    await notify(db, id, "MODERATION_MUTE", "Chat muted", `You were muted until ${until.toISOString()}.`, { until: until.toISOString() });
    return { ok: true, mutedUntil: until.toISOString() };
  });

  app.post<{ Params: { id: string } }>("/api/admin/users/:id/unmute", guard(ADMIN, MODERATOR), async (req) => {
    const id = app.parse(idSchema, req.params.id);
    const { reason } = app.parse(adminBanSchema, req.body);
    await db.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { mutedUntil: null } });
      await app.audit(req, { action: "USER_UNMUTE", targetType: "User", targetId: id, reason }, tx);
    });
    await redis.del(`mute:${id}`);
    return { ok: true };
  });

  app.put<{ Params: { id: string } }>("/api/admin/users/:id/roles", guard(SUPER_ADMIN), async (req) => {
    const id = app.parse(idSchema, req.params.id);
    const body = app.parse(adminRolesSchema, req.body);
    await db.$transaction(async (tx) => {
      const before = await tx.adminUser.findUnique({ where: { userId: id } });
      if (body.roles.length === 0) await tx.adminUser.deleteMany({ where: { userId: id } });
      else await tx.adminUser.upsert({ where: { userId: id }, create: { userId: id, roles: body.roles }, update: { roles: body.roles } });
      await revokeAllSessions(tx, id); // force re-login so tokens carry the new roles
      await app.audit(req, { action: "ADMIN_ROLES_SET", targetType: "User", targetId: id, oldValue: before?.roles ?? [], newValue: body.roles, reason: body.reason }, tx);
    });
    return { ok: true };
  });

  // ------------------------------------------------------------------ risk review
  app.get("/api/admin/risk", guard(ADMIN, MODERATOR, ECONOMY_MANAGER), async () => {
    const [signals, users] = await Promise.all([
      db.riskSignal.findMany({ where: { reviewed: false }, orderBy: [{ score: "desc" }, { createdAt: "desc" }], take: 200, include: { user: { select: { username: true, riskLevel: true } } } }),
      db.user.findMany({ where: { riskLevel: { in: ["HIGH", "CRITICAL"] } }, orderBy: { riskScore: "desc" }, take: 100, select: { id: true, username: true, riskLevel: true, riskScore: true, bannedAt: true } }),
    ]);
    return { signals, users };
  });

  app.post<{ Params: { id: string } }>("/api/admin/risk/:id/review", guard(ADMIN, MODERATOR), async (req) => {
    const id = app.parse(idSchema, req.params.id);
    const body = app.parse(adminRiskReviewSchema, req.body);
    await db.$transaction(async (tx) => {
      const s = await tx.riskSignal.findUnique({ where: { id } });
      if (!s) throw notFound("Risk signal");
      await tx.riskSignal.update({ where: { id }, data: { reviewed: true } });
      if (body.riskLevel) {
        const u = await tx.user.findUniqueOrThrow({ where: { id: s.userId }, select: { riskLevel: true } });
        await tx.user.update({ where: { id: s.userId }, data: { riskLevel: body.riskLevel, ...(body.decision === "CLEAR" && body.riskLevel === "LOW" ? { riskScore: 0 } : {}) } });
        await app.audit(req, { action: "RISK_LEVEL_SET", targetType: "User", targetId: s.userId, oldValue: u.riskLevel, newValue: body.riskLevel, reason: body.reason }, tx);
      }
      await app.audit(req, { action: `RISK_REVIEW_${body.decision}`, targetType: "RiskSignal", targetId: id, reason: body.reason }, tx);
    });
    return { ok: true };
  });

  // ------------------------------------------------------------------ reports
  app.get("/api/admin/reports", guard(ADMIN, MODERATOR), async () => {
    const reports = await db.chatReport.findMany({ where: { status: "OPEN" }, orderBy: { createdAt: "asc" }, take: 200 });
    const msgs = await db.chatMessage.findMany({ where: { id: { in: reports.map((r) => r.messageId) } }, include: { sender: { select: { username: true } } } });
    return { reports: reports.map((r) => ({ ...r, message: msgs.find((m) => m.id === r.messageId) ?? null })) };
  });

  app.post<{ Params: { id: string } }>("/api/admin/reports/:id/resolve", guard(ADMIN, MODERATOR), async (req) => {
    const id = app.parse(idSchema, req.params.id);
    const body = app.parse(adminReportResolveSchema, req.body);
    await db.$transaction(async (tx) => {
      const r = await tx.chatReport.update({ where: { id }, data: { status: body.status } });
      if (body.status === "RESOLVED") await tx.chatMessage.updateMany({ where: { id: r.messageId }, data: { flagged: true } });
      await app.audit(req, { action: `REPORT_${body.status}`, targetType: "ChatReport", targetId: id, reason: body.reason }, tx);
    });
    return { ok: true };
  });

  // ------------------------------------------------------------------ shop products
  app.get("/api/admin/shop/products", guard(ADMIN, ECONOMY_MANAGER), async () => ({ products: await db.shopProduct.findMany({ orderBy: { id: "asc" } }) }));

  app.post("/api/admin/shop/products", guard(ADMIN, ECONOMY_MANAGER), async (req, reply) => {
    const { reason, ...p } = app.parse(adminShopProductSchema, req.body);
    const created = await db.$transaction(async (tx) => {
      if (await tx.shopProduct.findFirst({ where: { OR: [{ id: p.id }, { sku: p.sku }] } })) throw conflict("PRODUCT_EXISTS", "Product id or sku already exists");
      const row = await tx.shopProduct.create({ data: { ...p, grants: toJsonValue(p.grants) } });
      await app.audit(req, { action: "SHOP_PRODUCT_CREATE", targetType: "ShopProduct", targetId: row.id, newValue: row, reason }, tx);
      return row;
    });
    return reply.status(201).send({ product: created });
  });

  app.patch<{ Params: { id: string } }>("/api/admin/shop/products/:id", guard(ADMIN, ECONOMY_MANAGER), async (req) => {
    const id = app.parse(defIdSchema, req.params.id);
    const { reason, id: _ignoreId, grants, ...patch } = app.parse(adminShopProductPatchSchema, req.body);
    const updated = await db.$transaction(async (tx) => {
      const before = await tx.shopProduct.findUnique({ where: { id } });
      if (!before) throw notFound("Product");
      const row = await tx.shopProduct.update({ where: { id }, data: { ...patch, ...(grants ? { grants: toJsonValue(grants) } : {}) } });
      await app.audit(req, { action: "SHOP_PRODUCT_UPDATE", targetType: "ShopProduct", targetId: id, oldValue: before, newValue: row, reason }, tx);
      return row;
    });
    return { product: updated };
  });

  app.delete<{ Params: { id: string } }>("/api/admin/shop/products/:id", guard(ADMIN, ECONOMY_MANAGER), async (req) => {
    const id = app.parse(defIdSchema, req.params.id);
    const { reason } = app.parse(adminBanSchema, req.body ?? {});
    // Products are never hard-deleted (purchases reference them): deactivate instead.
    await db.$transaction(async (tx) => {
      const row = await tx.shopProduct.update({ where: { id }, data: { active: false } });
      await app.audit(req, { action: "SHOP_PRODUCT_DEACTIVATE", targetType: "ShopProduct", targetId: row.id, reason }, tx);
    });
    return { ok: true };
  });

  // ------------------------------------------------------------------ events
  app.get("/api/admin/events", guard(ADMIN, ECONOMY_MANAGER, MODERATOR), async () => ({ events: await db.event.findMany({ orderBy: { startAt: "desc" } }) }));

  app.put("/api/admin/events", guard(ADMIN), async (req) => {
    const { reason, ...e } = app.parse(adminEventSchema, req.body);
    const row = await db.$transaction(async (tx) => {
      const before = await tx.event.findUnique({ where: { id: e.id } });
      const data = { name: e.name, type: e.type, startAt: e.startAt, endAt: e.endAt, active: e.active, data: toJsonValue(e.data) };
      const r = await tx.event.upsert({ where: { id: e.id }, create: { id: e.id, ...data }, update: data });
      await app.audit(req, { action: before ? "EVENT_UPDATE" : "EVENT_CREATE", targetType: "Event", targetId: e.id, oldValue: before ?? undefined, newValue: r, reason }, tx);
      return r;
    });
    return { event: row };
  });

  app.delete<{ Params: { id: string } }>("/api/admin/events/:id", guard(ADMIN), async (req) => {
    const id = app.parse(defIdSchema, req.params.id);
    const { reason } = app.parse(adminBanSchema, req.body ?? {});
    await db.$transaction(async (tx) => {
      const r = await tx.event.update({ where: { id }, data: { active: false } });
      await app.audit(req, { action: "EVENT_DISABLE", targetType: "Event", targetId: r.id, reason }, tx);
    });
    return { ok: true };
  });

  // ------------------------------------------------------------------ catalog overrides
  app.put<{ Params: { kind: string; id: string } }>("/api/admin/catalog/:kind/:id", guard(ADMIN), async (req) => {
    const kind = app.parse(catalogKinds, req.params.kind);
    const id = app.parse(defIdSchema, req.params.id);
    const body = app.parse(adminCatalogSchema, req.body);
    const row = await db.$transaction(async (tx) => {
      const find = { where: { id } };
      const before =
        kind === "ship" ? await tx.ship.findUnique(find)
        : kind === "weapon" ? await tx.weapon.findUnique(find)
        : kind === "module" ? await tx.module.findUnique(find)
        : kind === "drone" ? await tx.drone.findUnique(find)
        : await tx.item.findUnique(find);
      if (!before) throw notFound("Catalog entry");
      const merged = body.data ? toJsonValue({ ...(before.data as object), ...body.data, id }) : undefined;
      const data = { ...(merged ? { data: merged } : {}), ...(body.active === undefined || kind === "item" ? {} : { active: body.active }) };
      const after =
        kind === "ship" ? await tx.ship.update({ where: { id }, data })
        : kind === "weapon" ? await tx.weapon.update({ where: { id }, data })
        : kind === "module" ? await tx.module.update({ where: { id }, data })
        : kind === "drone" ? await tx.drone.update({ where: { id }, data })
        : await tx.item.update({ where: { id }, data: merged ? { data: merged } : {} });
      await app.audit(req, { action: "CATALOG_OVERRIDE", targetType: kind, targetId: id, oldValue: before, newValue: after, reason: body.reason }, tx);
      return after;
    });
    invalidateCatalog();
    return { entry: row };
  });

  // ------------------------------------------------------------------ feature flags
  app.get("/api/admin/feature-flags", guard(ADMIN), async () => ({ flags: await db.featureFlag.findMany({ orderBy: { key: "asc" } }) }));

  app.put<{ Params: { key: string } }>("/api/admin/feature-flags/:key", guard(ADMIN), async (req) => {
    const key = app.parse(z.string().min(2).max(64).regex(/^[a-z0-9_]+$/), req.params.key);
    const body = app.parse(adminFeatureFlagSchema, req.body);
    const row = await db.$transaction(async (tx) => {
      const before = await tx.featureFlag.findUnique({ where: { key } });
      const r = await tx.featureFlag.upsert({ where: { key }, create: { key, enabled: body.enabled, rules: toJsonValue(body.rules) }, update: { enabled: body.enabled, rules: toJsonValue(body.rules) } });
      await app.audit(req, { action: "FEATURE_FLAG_SET", targetType: "FeatureFlag", targetId: key, oldValue: before ?? undefined, newValue: r, reason: body.reason }, tx);
      return r;
    });
    return { flag: row };
  });

  // ------------------------------------------------------------------ API rules
  app.get("/api/admin/rules", guard(ADMIN, ECONOMY_MANAGER), async () => ({ rules: await loadRules(db), defaults: API_RULE_DEFAULTS }));

  app.put("/api/admin/rules", guard(ADMIN, ECONOMY_MANAGER), async (req) => {
    const body = app.parse(rulesSchema, req.body);
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body.rules)) {
      const def = (API_RULE_DEFAULTS as Record<string, unknown>)[k];
      if (def === undefined) throw badRequest("UNKNOWN_RULE", `Unknown rule "${k}"`);
      if (typeof def !== typeof v) throw badRequest("INVALID_RULE", `Rule "${k}" has the wrong type`);
      if (typeof v === "number" && (!Number.isFinite(v) || v < 0)) throw badRequest("INVALID_RULE", `Rule "${k}" must be a non-negative number`);
      clean[k] = v;
    }
    await db.$transaction(async (tx) => {
      const before = await tx.economyConfig.findUnique({ where: { key: "apiRules" } });
      const next = { ...((before?.value as object | null) ?? {}), ...clean };
      await tx.economyConfig.upsert({ where: { key: "apiRules" }, create: { key: "apiRules", value: toJsonValue(next), updatedBy: req.user.id }, update: { value: toJsonValue(next), updatedBy: req.user.id } });
      await app.audit(req, { action: "API_RULES_UPDATE", targetType: "EconomyConfig", targetId: "apiRules", oldValue: before?.value ?? undefined, newValue: next, reason: body.reason }, tx);
    });
    invalidateRules();
    return { rules: await loadRules(db) };
  });

  // ------------------------------------------------------------------ system mail (compensation)
  app.post("/api/admin/mail", guard(ADMIN), async (req, reply) => {
    const body = app.parse(mailSchema, req.body);
    const mail = await db.$transaction(async (tx) => {
      if (!(await tx.user.findUnique({ where: { id: body.toUserId }, select: { id: true } }))) throw notFound("User");
      const m = await tx.mail.create({
        data: { toUserId: body.toUserId, system: true, subject: body.subject, body: body.body, ...(body.attachments ? { attachments: toJsonValue(body.attachments) } : {}) },
      });
      await app.audit(req, { action: "ADMIN_MAIL_SEND", targetType: "User", targetId: body.toUserId, newValue: { mailId: m.id, attachments: body.attachments }, reason: body.reason }, tx);
      return m;
    });
    return reply.status(201).send({ id: mail.id });
  });

  // ------------------------------------------------------------------ audit log
  app.get("/api/admin/audit", guard(ADMIN), async (req) => {
    const q = app.parse(adminAuditQuerySchema, req.query);
    const rows = await db.auditLog.findMany({
      where: {
        ...(q.action ? { action: q.action } : {}),
        ...(q.actorId ? { actorId: q.actorId } : {}),
        ...(q.targetId ? { targetId: q.targetId } : {}),
        ...(q.before ? { createdAt: { lt: q.before } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: q.limit,
    });
    return { entries: rows };
  });
}
