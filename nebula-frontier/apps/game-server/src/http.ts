/** HTTP endpoints served next to the Colyseus matchmaker: /health, /ready, /metrics. */
import { createEndpoint, createRouter } from "@colyseus/core";
import { safeEqual } from "@nebula/authentication";
import { metricsContentType, metricsText } from "@nebula/telemetry";
import { redisHealthy } from "./services/redis.js";
import type { GameServices } from "./services/context.js";

export type MetricsAccess = "allow" | "unauthorized" | "disabled";

/**
 * Access decision for GET /metrics (served on the public game port). With a configured token the
 * request must carry `Authorization: Bearer <token>` (constant-time compare). Without a token the
 * endpoint is disabled in production (config validation also refuses to boot that way) and open only
 * in non-production, matching apps/api.
 */
export function metricsAccess(authorization: string | null, token: string | null, nodeEnv: string): MetricsAccess {
  if (!token) return nodeEnv === "production" ? "disabled" : "allow";
  const h = authorization ?? "";
  return h.startsWith("Bearer ") && safeEqual(h.slice(7), token) ? "allow" : "unauthorized";
}

export function createRoutes(svc: () => GameServices) {
  const health = createEndpoint("/health", { method: "GET" }, async () => {
    return new Response(JSON.stringify({ status: "ok", service: "game-server", region: svc().config.region, time: new Date().toISOString() }), {
      headers: { "content-type": "application/json" },
    });
  });
  const ready = createEndpoint("/ready", { method: "GET" }, async () => {
    const s = svc();
    const checks: Record<string, boolean> = {};
    try {
      await s.db.$queryRaw`SELECT 1`;
      checks.database = true;
    } catch {
      checks.database = false;
    }
    checks.redis = await redisHealthy(s.redis);
    const ok = Object.values(checks).every(Boolean);
    return new Response(JSON.stringify({ status: ok ? "ready" : "not_ready", checks }), {
      status: ok ? 200 : 503,
      headers: { "content-type": "application/json" },
    });
  });
  const metrics = createEndpoint("/metrics", { method: "GET" }, async (ctx) => {
    const { config } = svc();
    const access = metricsAccess(ctx.getHeader("authorization"), config.metricsToken, config.nodeEnv);
    if (access === "disabled") return new Response("Not Found", { status: 404 });
    if (access === "unauthorized") return new Response("Unauthorized", { status: 401, headers: { "www-authenticate": "Bearer" } });
    return new Response(await metricsText(), { headers: { "content-type": metricsContentType } });
  });
  return createRouter({ health, ready, metrics });
}
