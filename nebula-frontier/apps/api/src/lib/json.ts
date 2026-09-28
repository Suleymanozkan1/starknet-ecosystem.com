/** JSON helpers: BigInt-safe conversion for Prisma Json columns and API payloads. */
import type { Prisma } from "@nebula/database";

export function toJsonValue(v: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(v ?? null, (_k, val: unknown) => (typeof val === "bigint" ? val.toString() : val))) as Prisma.InputJsonValue;
}

export function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
