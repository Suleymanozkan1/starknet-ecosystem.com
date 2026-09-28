/** Small, dependency-free helpers shared by client and server. */
export const TAU = Math.PI * 2;

export function clamp(v: number, min: number, max: number): number {
  if (Number.isNaN(v)) return min;
  return v < min ? min : v > max ? max : v;
}
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
export function wrapAngle(a: number): number {
  let r = a % TAU;
  if (r > Math.PI) r -= TAU;
  if (r < -Math.PI) r += TAU;
  return r;
}
export function lerpAngle(a: number, b: number, t: number): number {
  return a + wrapAngle(b - a) * t;
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
    if (!Number.isFinite(v) || !Number.isInteger(v)) throw new Error(`Invalid integer amount: ${v}`);
    return BigInt(v);
  }
  if (!/^-?\d+$/.test(v)) throw new Error(`Invalid integer amount: ${v}`);
  return BigInt(v);
}
/** Multiply a bigint amount by a decimal ratio using basis points precision (1e6). */
export function mulRatio(amount: bigint, ratio: number): bigint {
  const scaled = BigInt(Math.round(ratio * 1_000_000));
  return (amount * scaled) / 1_000_000n;
}
export function formatUnits(amount: bigint | string, decimals: number, maxFraction = 4): string {
  const v = typeof amount === "string" ? BigInt(amount) : amount;
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0").slice(0, maxFraction).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole.toString()}${frac ? "." + frac : ""}`;
}
export function parseUnits(value: string, decimals: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) throw new Error(`Invalid decimal amount: ${value}`);
  const whole = BigInt(m[1] ?? "0");
  const fracStr = (m[2] ?? "").slice(0, decimals).padEnd(decimals, "0");
  return whole * 10n ** BigInt(decimals) + (fracStr ? BigInt(fracStr) : 0n);
}

export const LAMPORTS_PER_SOL = 1_000_000_000n;
