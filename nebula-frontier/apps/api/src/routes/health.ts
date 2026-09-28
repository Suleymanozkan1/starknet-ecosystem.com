import type { FastifyInstance } from "fastify";
import { safeEqual } from "@nebula/authentication";
import { unauthorized } from "../errors.js";
import type { ApiMetrics } from "../lib/metrics.js";

const started = Date.now();

export default async function healthRoutes(app: FastifyInstance, opts: { metrics: ApiMetrics }): Promise<void> {
  const noLimit = { config: { rateLimit: false as const } };

  app.get("/health", noLimit, async () => ({ status: "ok", uptimeSec: Math.round((Date.now() - started) / 1000) }));

  app.get("/ready", noLimit, async (_req, reply) => {
    const checks: Record<string, { ok: boolean; latencyMs: number; error?: string }> = {};
    const t0 = performance.now();
    try {
      await app.db.$queryRaw`SELECT 1`;
      checks.database = { ok: true, latencyMs: Math.round(performance.now() - t0) };
    } catch {
      checks.database = { ok: false, latencyMs: Math.round(performance.now() - t0), error: "unreachable" };
    }
    const t1 = performance.now();
    try {
      await app.redis.ping();
      checks.redis = { ok: true, latencyMs: Math.round(performance.now() - t1) };
    } catch {
      checks.redis = { ok: false, latencyMs: Math.round(performance.now() - t1), error: "unreachable" };
    }
    const ok = Object.values(checks).every((c) => c.ok);
    return reply.status(ok ? 200 : 503).send({ status: ok ? "ready" : "degraded", checks });
  });

  app.get("/metrics", noLimit, async (req, reply) => {
    const token = app.env.METRICS_TOKEN;
    if (token) {
      const h = req.headers.authorization ?? "";
      if (!h.startsWith("Bearer ") || !safeEqual(h.slice(7), token)) throw unauthorized();
    }
    reply.header("content-type", opts.metrics.registry.contentType);
    return opts.metrics.registry.metrics();
  });
}
