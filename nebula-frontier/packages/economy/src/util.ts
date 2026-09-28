import { Prisma } from "@nebula/database";

/** JSON-safe clone (bigint -> string) for Prisma Json columns. */
export function toJson(v: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (v === null || v === undefined) return Prisma.JsonNull;
  return JSON.parse(JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x))) as Prisma.InputJsonValue;
}

export const DAY_MS = 86_400_000;

export function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Monday 00:00 UTC of the week containing d. */
export function startOfUtcWeek(d: Date): Date {
  const day = startOfUtcDay(d);
  const dow = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - dow * DAY_MS);
}

export function minBig(...v: bigint[]): bigint {
  return v.reduce((a, b) => (b < a ? b : a));
}
export function maxBig(...v: bigint[]): bigint {
  return v.reduce((a, b) => (b > a ? b : a));
}

/** ceil(amount * ratio) with 1e6 precision. */
export function mulRatioCeil(amount: bigint, ratio: number): bigint {
  const scaled = BigInt(Math.round(ratio * 1_000_000));
  const num = amount * scaled;
  return num % 1_000_000n === 0n ? num / 1_000_000n : num / 1_000_000n + 1n;
}

/** floor(amount * ratio) with 1e6 precision. */
export function mulRatioFloor(amount: bigint, ratio: number): bigint {
  if (ratio <= 0) return 0n;
  const scaled = BigInt(Math.round(ratio * 1_000_000));
  return (amount * scaled) / 1_000_000n;
}

export function ratio(a: bigint, b: bigint): number {
  if (b === 0n) return a === 0n ? 0 : Number.POSITIVE_INFINITY;
  return Number((a * 1_000_000n) / b) / 1_000_000;
}
