/** HTTP endpoints served next to the Colyseus matchmaker: /health, /ready, /metrics. */
import { createEndpoint, createRouter } from "@colyseus/core";
import { metricsContentType, metricsText } from "@nebula/telemetry";
import { redisHealthy } from "./services/redis.js";
import type { GameServices } from "./services/context.js";

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
  const metrics = createEndpoint("/metrics", { method: "GET" }, async () => {
    return new Response(await metricsText(), { headers: { "content-type": metricsContentType } });
  });
  return createRouter({ health, ready, metrics });
}
