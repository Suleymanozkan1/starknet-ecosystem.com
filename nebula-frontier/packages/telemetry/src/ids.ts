/**
 * Correlation / request id helpers. Uses AsyncLocalStorage so any log line
 * inside a request/tick handler can carry the id without threading it through.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export interface CorrelationContext {
  correlationId: string;
  userId?: string;
  [k: string]: unknown;
}

const als = new AsyncLocalStorage<CorrelationContext>();

const VALID_ID = /^[A-Za-z0-9._:-]{8,128}$/;

export function newCorrelationId(): string {
  return randomUUID();
}

/** Accept an inbound id (e.g. `x-request-id` header) only if well-formed, else mint one. */
export function sanitizeCorrelationId(inbound: unknown): string {
  return typeof inbound === "string" && VALID_ID.test(inbound) ? inbound : newCorrelationId();
}

export function withCorrelation<T>(ctx: Partial<CorrelationContext>, fn: () => T): T {
  const full: CorrelationContext = { ...ctx, correlationId: ctx.correlationId ?? newCorrelationId() };
  return als.run(full, fn);
}

export function currentCorrelation(): CorrelationContext | undefined {
  return als.getStore();
}

export function correlationId(): string | undefined {
  return als.getStore()?.correlationId;
}

/** Child-logger bindings for the current context. */
export function correlationBindings(): Record<string, unknown> {
  const c = als.getStore();
  return c ? { correlationId: c.correlationId, ...(c.userId ? { userId: c.userId } : {}) } : {};
}
