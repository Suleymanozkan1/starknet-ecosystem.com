/** Prometheus metrics for the API (one registry per app instance so tests don't collide). */
import { Counter, Histogram, Registry, collectDefaultMetrics } from "prom-client";

export interface ApiMetrics {
  registry: Registry;
  httpDuration: Histogram<"method" | "route" | "status">;
  authEvents: Counter<"event">;
  purchases: Counter<"currency">;
}

export function createMetrics(defaults = true): ApiMetrics {
  const registry = new Registry();
  registry.setDefaultLabels({ service: "api" });
  if (defaults) collectDefaultMetrics({ register: registry });
  return {
    registry,
    httpDuration: new Histogram({
      name: "nebula_api_http_request_duration_seconds",
      help: "HTTP request latency",
      labelNames: ["method", "route", "status"],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [registry],
    }),
    authEvents: new Counter({ name: "nebula_api_auth_events_total", help: "Auth events", labelNames: ["event"], registers: [registry] }),
    purchases: new Counter({ name: "nebula_api_purchases_total", help: "Completed shop purchases", labelNames: ["currency"], registers: [registry] }),
  };
}
