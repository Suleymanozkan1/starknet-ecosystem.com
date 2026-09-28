/**
 * NEBULA FRONTIER REST API — Fastify 5 application factory.
 *
 * `buildApp()` wires security plugins (helmet, CORS allowlist, cookies, Redis-backed rate limits),
 * request/correlation ids, the uniform ApiError handler, the core decorators (see types.ts) and
 * every route module. `index.ts` only adds `listen()` and background jobs.
 */
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import sensible from "@fastify/sensible";
import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { createDb, type Db } from "@nebula/database";
import { loadEnv, type Env } from "./env.js";
import { sendError } from "./errors.js";
import { createLogger } from "@nebula/telemetry";
import { REDACT_PATHS } from "./lib/logger.js";
import { createMetrics } from "./lib/metrics.js";
import { registerCore, registerSecurity } from "./plugins/core.js";
import "./types.js";

import healthRoutes from "./routes/health.js";
import authRoutes from "./routes/auth.js";
import meRoutes from "./routes/me.js";
import gameRoutes from "./routes/game.js";
import shipRoutes from "./routes/ships.js";
import inventoryRoutes from "./routes/inventory.js";
import shopRoutes from "./routes/shop.js";
import craftingRoutes from "./routes/crafting.js";
import questRoutes from "./routes/quests.js";
import leaderboardRoutes from "./routes/leaderboard.js";
import marketRoutes from "./routes/market.js";
import auctionRoutes from "./routes/auctions.js";
import clanRoutes from "./routes/clans.js";
import socialRoutes from "./routes/social.js";
import progressRoutes from "./routes/progress.js";
import galaxyRoutes from "./routes/galaxy.js";
import seasonRoutes from "./routes/season.js";
import adminRoutes from "./routes/admin.js";
// Economy engineer's route modules (wallet / deposits / withdrawals / rewards / economy admin).
import walletRoutes from "./routes/wallet.js";
import economyRoutes from "./routes/economy.js";
import rewardsRoutes from "./routes/rewards.js";
import adminEconomyRoutes from "./routes/admin-economy.js";

export interface BuildAppOptions {
  /** Environment overrides (merged over process.env). */
  env?: Partial<Env>;
  db?: Db;
  redis?: Redis;
  /** Enable request logging (default: true unless NODE_ENV=test). */
  logger?: boolean;
  /** Multiplier for every rate-limit max (tests only). */
  rateLimitScale?: number;
  /** Redis namespace for rate-limit counters (tests isolate runs). */
  rateLimitNamespace?: string;
}

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,128}$/;

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const env = loadEnv(process.env, opts.env);
  const ownsDb = !opts.db;
  const ownsRedis = !opts.redis;
  const db = opts.db ?? createDb(env.DATABASE_URL);
  const redis = opts.redis ?? new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2, enableOfflineQueue: true, lazyConnect: false });
  const metrics = createMetrics(ownsDb);

  const app = Fastify({
    ...(opts.logger === false || env.NODE_ENV === "test"
      ? { logger: false }
      : {
          // pino Logger is structurally a FastifyBaseLogger; the generic is widened for route typing.
          loggerInstance: createLogger({ name: "api", level: env.LOG_LEVEL, base: { region: env.REGION }, redact: REDACT_PATHS }) as FastifyBaseLogger,
        }),
    trustProxy: env.TRUST_PROXY,
    bodyLimit: 256 * 1024,
    requestIdHeader: false,
    genReqId: (req) => {
      const h = req.headers["x-request-id"];
      return typeof h === "string" && REQUEST_ID_RE.test(h) ? h : randomUUID();
    },
    routerOptions: { ignoreTrailingSlash: true },
    ajv: { customOptions: { removeAdditional: true } },
  });

  app.setErrorHandler((err, req, reply) => sendError(req, reply, err, env.isProd));
  // Money/ids are BigInt in Prisma: serialize them as decimal strings (the wire format of shared/api.ts).
  app.setReplySerializer((payload) => JSON.stringify(payload, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)));
  app.setNotFoundHandler((req, reply) =>
    reply.status(404).send({ error: { code: "NOT_FOUND", message: `Route ${req.method} ${req.url.split("?")[0]} not found`, requestId: req.id } }),
  );

  await registerSecurity(app, env);
  await app.register(sensible);

  await registerCore(app, {
    db,
    redis,
    env,
    rateLimitScale: opts.rateLimitScale ?? 1,
    rateLimitNamespace: opts.rateLimitNamespace ?? "nf:rl:",
  });

  app.addHook("onSend", async (req, reply) => {
    reply.header("x-request-id", req.id);
    reply.header("x-correlation-id", req.correlationId || req.id);
    if (req.url.startsWith("/api/")) reply.header("cache-control", "no-store");
  });
  app.addHook("onResponse", async (req, reply) => {
    metrics.httpDuration.observe(
      { method: req.method, route: req.routeOptions.url ?? "unmatched", status: String(reply.statusCode) },
      reply.elapsedTime / 1000,
    );
  });

  await app.register(healthRoutes, { metrics });
  await app.register(authRoutes);
  await app.register(meRoutes);
  await app.register(gameRoutes);
  await app.register(shipRoutes);
  await app.register(inventoryRoutes);
  await app.register(shopRoutes, { metrics });
  await app.register(craftingRoutes);
  await app.register(questRoutes);
  await app.register(leaderboardRoutes);
  await app.register(marketRoutes);
  await app.register(auctionRoutes);
  await app.register(clanRoutes);
  await app.register(socialRoutes);
  await app.register(progressRoutes);
  await app.register(galaxyRoutes);
  await app.register(seasonRoutes);
  await app.register(adminRoutes);
  await app.register(walletRoutes);
  await app.register(economyRoutes);
  await app.register(rewardsRoutes);
  await app.register(adminEconomyRoutes);

  app.addHook("onClose", async () => {
    if (ownsRedis) await redis.quit().catch(() => undefined);
    if (ownsDb) await db.$disconnect().catch(() => undefined);
  });

  return app;
}
