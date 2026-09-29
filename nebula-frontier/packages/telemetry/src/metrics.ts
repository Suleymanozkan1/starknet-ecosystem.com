/**
 * Prometheus metrics registry (prom-client) with the standard game/service
 * metrics. Each process owns one registry; `metricsText()` renders it.
 */
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

export const registry = new Registry();

let defaultsCollected = false;
export function initMetrics(labels: Record<string, string> = {}): Registry {
  registry.setDefaultLabels(labels);
  if (!defaultsCollected) {
    collectDefaultMetrics({ register: registry, prefix: "nebula_" });
    defaultsCollected = true;
  }
  return registry;
}

export const activePlayers = new Gauge({
  name: "nebula_active_players", help: "Players currently connected", labelNames: ["room", "map"] as const, registers: [registry],
});
export const activeRooms = new Gauge({
  name: "nebula_active_rooms", help: "Rooms currently alive", labelNames: ["room"] as const, registers: [registry],
});
export const tickDuration = new Histogram({
  name: "nebula_tick_duration_seconds", help: "Simulation tick duration", labelNames: ["room"] as const,
  buckets: [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.02, 0.035, 0.05, 0.1], registers: [registry],
});
export const packetsReceived = new Counter({
  name: "nebula_packets_received_total", help: "Client messages received", labelNames: ["room", "type"] as const, registers: [registry],
});
export const packetsDropped = new Counter({
  name: "nebula_packets_dropped_total", help: "Client messages dropped (rate limit / validation / replay)", labelNames: ["room", "reason"] as const, registers: [registry],
});
export const errorsTotal = new Counter({
  name: "nebula_errors_total", help: "Errors by component", labelNames: ["component", "code"] as const, registers: [registry],
});
export const riskSignalsTotal = new Counter({
  name: "nebula_risk_signals_total", help: "Anti-cheat risk signals emitted", labelNames: ["type"] as const, registers: [registry],
});
export const persistenceFlushDuration = new Histogram({
  name: "nebula_persistence_flush_seconds", help: "Batched persistence flush duration", buckets: [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5], registers: [registry],
});
export const httpRequestDuration = new Histogram({
  name: "nebula_http_request_duration_seconds", help: "HTTP request duration", labelNames: ["method", "route", "status"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5], registers: [registry],
});

export async function metricsText(): Promise<string> {
  return registry.metrics();
}

export const metricsContentType = registry.contentType;
