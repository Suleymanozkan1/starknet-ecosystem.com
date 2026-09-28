/** Deterministic helpers so procedural content is stable for a given id/seed. */
export function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export interface Rng {
  (): number;
  range(min: number, max: number): number;
  int(min: number, maxInclusive: number): number;
  pick<T>(list: readonly T[]): T;
  sign(): number;
}

export function createRng(seed: number | string): Rng {
  let a = (typeof seed === "string" ? hashString(seed) : seed) >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng = next as Rng;
  rng.range = (min, max) => min + (max - min) * next();
  rng.int = (min, max) => Math.floor(min + (max - min + 1) * next());
  rng.pick = <T>(list: readonly T[]): T => {
    const v = list[Math.floor(next() * list.length)];
    if (v === undefined) throw new Error("pick from empty list");
    return v;
  };
  rng.sign = () => (next() < 0.5 ? -1 : 1);
  return rng;
}

/** Cheap 3D value noise (deterministic, allocation-free) used for asteroid displacement & textures. */
export function valueNoise3(x: number, y: number, z: number, seed = 0): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const h = (i: number, j: number, k: number): number => {
    let n = (i * 374761393 + j * 668265263 + k * 1274126177 + seed * 2654435761) | 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  const l = (a: number, b: number, t: number): number => a + (b - a) * t;
  return l(
    l(l(h(xi, yi, zi), h(xi + 1, yi, zi), u), l(h(xi, yi + 1, zi), h(xi + 1, yi + 1, zi), u), v),
    l(l(h(xi, yi, zi + 1), h(xi + 1, yi, zi + 1), u), l(h(xi, yi + 1, zi + 1), h(xi + 1, yi + 1, zi + 1), u), v),
    w,
  );
}

export function fbm3(x: number, y: number, z: number, octaves = 4, seed = 0): number {
  let amp = 0.5, freq = 1, sum = 0, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise3(x * freq, y * freq, z * freq, seed + o * 17);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}
