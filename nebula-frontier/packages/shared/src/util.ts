/** Small, dependency-free helpers shared by client and server. */
export const TAU = Math.PI * 2;

/** Clamp `v` to [min, max]. NaN input falls back to `min`. Throws on non-finite bounds or min > max. */
export function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) throw new Error(`Invalid clamp bounds: [${min}, ${max}]`);
  if (Number.isNaN(v)) return min;
  return v < min ? min : v > max ? max : v;
}
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
/** Wrap an angle to [-PI, PI]. Non-finite input yields 0. */
export function wrapAngle(a: number): number {
  if (!Number.isFinite(a)) return 0;
  let r = a % TAU;
  if (r > Math.PI) r -= TAU;
  if (r < -Math.PI) r += TAU;
  return r;
}
/**
 * Interpolate from angle `a` toward `b` along the shortest arc. Never returns NaN: a non-finite start
 * snaps to the (wrapped) target, a non-finite target keeps `a`, and a non-finite `t` is treated as 0.
 */
export function lerpAngle(a: number, b: number, t: number): number {
  if (!Number.isFinite(a)) return wrapAngle(b);
  if (!Number.isFinite(b)) return a;
  return a + wrapAngle(b - a) * (Number.isFinite(t) ? t : 0);
}
export function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}
export function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.sqrt(dist2(ax, ay, bx, by));
}

/** Deterministic PRNG (mulberry32) — server seeds it from crypto; tests seed it explicitly. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Amount helpers: all money is integer base units carried as bigint / decimal strings. */
export function toBigInt(v: string | number | bigint): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new Error(`Invalid integer amount: ${v}`);
    return BigInt(v);
  }
  if (!/^-?\d+$/.test(v)) throw new Error(`Invalid integer amount: ${v}`);
  return BigInt(v);
}
/**
 * Multiply a bigint amount by a decimal ratio with parts-per-million precision (ratio is rounded to
 * the nearest 1e-6). The result is truncated toward zero (bigint division), i.e. floored for
 * non-negative inputs. Throws if `ratio` is not finite.
 */
export function mulRatio(amount: bigint, ratio: number): bigint {
  if (!Number.isFinite(ratio)) throw new Error(`Invalid ratio: ${ratio}`);
  const scaled = BigInt(Math.round(ratio * 1_000_000));
  return (amount * scaled) / 1_000_000n;
}
function assertDecimals(decimals: number): void {
  if (!Number.isSafeInteger(decimals) || decimals < 0) throw new Error(`Invalid decimals: ${decimals}`);
}
export function formatUnits(amount: bigint | string, decimals: number, maxFraction = 4): string {
  assertDecimals(decimals);
  const v = typeof amount === "string" ? BigInt(amount) : amount;
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0").slice(0, maxFraction).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole.toString()}${frac ? "." + frac : ""}`;
}
/** Parse a non-negative decimal string into base units. Throws if it has more fraction digits than `decimals`. */
export function parseUnits(value: string, decimals: number): bigint {
  assertDecimals(decimals);
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) throw new Error(`Invalid decimal amount: ${value}`);
  const whole = BigInt(m[1] ?? "0");
  const frac = m[2] ?? "";
  if (frac.length > decimals) throw new Error(`Too many decimal places (max ${decimals}): ${value}`);
  const fracStr = frac.padEnd(decimals, "0");
  return whole * 10n ** BigInt(decimals) + (fracStr ? BigInt(fracStr) : 0n);
}

export const LAMPORTS_PER_SOL = 1_000_000_000n;
