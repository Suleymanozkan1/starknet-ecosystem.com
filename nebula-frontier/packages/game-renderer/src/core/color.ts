import { Color } from "three";

const cache = new Map<string, Color>();

/** Parse "#rrggbb" (or any CSS color three understands) into a cached, shared THREE.Color. Do not mutate the result. */
export function sharedColor(hex: string): Color {
  let c = cache.get(hex);
  if (!c) {
    c = new Color(hex);
    cache.set(hex, c);
  }
  return c;
}

/** Fresh mutable color. */
export function color(hex: string): Color {
  return new Color(hex);
}

export function hexToInt(hex: string): number {
  return sharedColor(hex).getHex();
}

/** Mix two hex colors → new Color. */
export function mixHex(a: string, b: string, t: number): Color {
  return new Color(a).lerp(sharedColor(b), t);
}

/** Relative luminance 0..1 (sRGB approx). */
export function luminance(hex: string): number {
  const c = sharedColor(hex);
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}
