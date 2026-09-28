import { CircuitBreakerMode } from "@nebula/shared";
import type { DbOrTx } from "@nebula/database";

export const ALL_BREAKERS = Object.values(CircuitBreakerMode) as CircuitBreakerMode[];

export async function getActiveBreakers(db: DbOrTx): Promise<CircuitBreakerMode[]> {
  const rows = await db.circuitBreaker.findMany({ where: { active: true }, select: { mode: true } });
  return rows.map((r) => r.mode as CircuitBreakerMode).filter((m) => ALL_BREAKERS.includes(m));
}

export async function isBreakerActive(db: DbOrTx, mode: CircuitBreakerMode): Promise<boolean> {
  const row = await db.circuitBreaker.findUnique({ where: { mode }, select: { active: true } });
  return row?.active ?? false;
}

export interface SetBreakerInput {
  mode: CircuitBreakerMode;
  active: boolean;
  reason: string;
  /** Admin user id, or null for the automated controller. */
  actorId: string | null;
  actorType?: "ADMIN" | "SYSTEM";
  ip?: string | null;
  requestId?: string | null;
}

/** Toggle a breaker (idempotent) and write an audit log entry when the state changes. */
export async function setCircuitBreaker(db: DbOrTx, input: SetBreakerInput): Promise<{ changed: boolean }> {
  if (!ALL_BREAKERS.includes(input.mode)) throw new Error(`Unknown circuit breaker ${input.mode}`);
  const existing = await db.circuitBreaker.findUnique({ where: { mode: input.mode } });
  if (existing && existing.active === input.active) return { changed: false };
  const triggeredBy = input.actorId ?? "SYSTEM";
  await db.circuitBreaker.upsert({
    where: { mode: input.mode },
    create: { mode: input.mode, active: input.active, reason: input.reason, triggeredBy, triggeredAt: new Date() },
    update: { active: input.active, reason: input.reason, triggeredBy, triggeredAt: new Date() }
  });
  await db.auditLog.create({
    data: {
      actorId: input.actorId,
      actorType: input.actorType ?? (input.actorId ? "ADMIN" : "SYSTEM"),
      action: input.active ? "CIRCUIT_BREAKER_ON" : "CIRCUIT_BREAKER_OFF",
      targetType: "CircuitBreaker",
      targetId: input.mode,
      oldValue: { active: existing?.active ?? false, reason: existing?.reason ?? null },
      newValue: { active: input.active, reason: input.reason },
      reason: input.reason,
      ip: input.ip ?? null,
      requestId: input.requestId ?? null
    }
  });
  return { changed: true };
}
