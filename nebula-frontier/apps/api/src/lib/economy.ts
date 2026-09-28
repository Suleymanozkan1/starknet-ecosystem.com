/**
 * Single import point for the economy engine (@nebula/economy) used by the API routes.
 */
import type { DbOrTx } from "@nebula/database";
import { CircuitBreakerMode } from "@nebula/shared";
import { loadEconomyConfig, recordRiskSignal } from "@nebula/economy";
import { unavailable } from "../errors.js";

export { loadEconomyConfig, recordRiskSignal };

export async function getFees(db: DbOrTx) {
  const cfg = await loadEconomyConfig(db);
  return cfg.fees;
}

export async function isBreakerActive(db: DbOrTx, mode: CircuitBreakerMode): Promise<boolean> {
  const row = await db.circuitBreaker.findUnique({ where: { mode }, select: { active: true } });
  return row?.active ?? false;
}

export async function assertMarketOpen(db: DbOrTx): Promise<void> {
  if (await isBreakerActive(db, CircuitBreakerMode.MARKET_PAUSE)) {
    throw unavailable("MARKET_PAUSED", "The marketplace is temporarily paused");
  }
}

/** Fire-and-forget-safe risk signal: never lets anti-cheat bookkeeping break the request. */
export async function flagRisk(
  db: Parameters<typeof recordRiskSignal>[0],
  userId: string,
  type: string,
  score: number,
  details: Record<string, unknown>,
  source = "api",
): Promise<void> {
  try {
    await recordRiskSignal(db, { userId, type, score, details, source });
  } catch {
    // Risk scoring must not fail the user-facing operation; the error is visible in DB logs.
  }
}
