import {
  DataTexture, LinearFilter, LinearMipmapLinearFilter, NoColorSpace, RGBAFormat, RepeatWrapping, SRGBColorSpace,
  UnsignedByteType,
} from "three";
import { createRng, fbm3, valueNoise3 } from "../core/random.js";

/**
 * Procedural hard-surface texture set generated into DataTextures (works in
 * browsers, workers and node). Tileable, so hull UVs can use box projection.
 */
export interface PanelTextureSet {
  /** Tangent-space normal map. */
  normal: DataTexture;
  /** glTF-style ORM packing: R = ambient occlusion, G = roughness, B = metalness. */
  orm: DataTexture;
  /** Panel-line light strips mask (white = emissive). */
  emissive: DataTexture;
  /** Albedo modulation (grime/wear), multiplied with material color. */
  albedo: DataTexture;
  dispose(): void;
}

interface Rect { x: number; y: number; w: number; h: number }

function finalizeTexture(data: Uint8Array, size: number, srgb: boolean): DataTexture {
  const tex = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Generate a tileable greebled panel texture set. */
export function createPanelTextures(size: number, seed = 1337): PanelTextureSet {
  const n = size;
  const rng = createRng(seed);
  const height = new Float32Array(n * n).fill(1);
  const rough = new Float32Array(n * n);
  const metal = new Float32Array(n * n);
  const emis = new Float32Array(n * n);

  // --- Recursive panel subdivision -------------------------------------------------
  const rects: Rect[] = [];
  const split = (r: Rect, depth: number): void => {
    const canSplitW = r.w > n / 10;
    const canSplitH = r.h > n / 10;
    if (depth > 5 || (!canSplitW && !canSplitH) || (depth > 1 && rng() < 0.18)) {
      rects.push(r);
      return;
    }
    const vertical = canSplitW && (!canSplitH || (r.w > r.h ? rng() < 0.75 : rng() < 0.25));
    const t = 0.3 + rng() * 0.4;
    if (vertical) {
      const w1 = Math.max(2, Math.round(r.w * t));
      split({ x: r.x, y: r.y, w: w1, h: r.h }, depth + 1);
      split({ x: r.x + w1, y: r.y, w: r.w - w1, h: r.h }, depth + 1);
    } else {
      const h1 = Math.max(2, Math.round(r.h * t));
      split({ x: r.x, y: r.y, w: r.w, h: h1 }, depth + 1);
      split({ x: r.x, y: r.y + h1, w: r.w, h: r.h - h1 }, depth + 1);
    }
  };
  split({ x: 0, y: 0, w: n, h: n }, 0);

  const seam = Math.max(1, Math.round(n / 128));
  const bevel = Math.max(2, Math.round(n / 64));
  rects.forEach((r) => {
    const inset = rng() < 0.22 ? -0.18 : rng() < 0.15 ? 0.08 : 0;
    const pr = 0.3 + rng() * 0.35;
    const pm = 0.55 + rng() * 0.4;
    const lit = rng() < 0.12;
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        const i = y * n + x;
        const dx = Math.min(x - r.x, r.x + r.w - 1 - x);
        const dy = Math.min(y - r.y, r.y + r.h - 1 - y);
        const d = Math.min(dx, dy);
        let hgt: number;
        if (d < seam) hgt = 0;
        else if (d < seam + bevel) hgt = ((d - seam) / bevel) * (1 + inset);
        else hgt = 1 + inset;
        height[i] = hgt;
        rough[i] = pr;
        metal[i] = pm;
        // strip lights along one edge of some panels
        if (lit && d >= seam && d < seam + Math.max(1, bevel / 2) && dy <= dx && r.w > n / 6) emis[i] = 1;
      }
    }
    // rivets along long panels
    if (r.w > n / 5 && rng() < 0.5) {
      const ry = r.y + seam + bevel + 1;
      for (let x = r.x + bevel * 2; x < r.x + r.w - bevel * 2; x += Math.max(4, Math.round(n / 40))) {
        for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
          const xx = x + ox, yy = ry + oy;
          if (xx >= 0 && xx < n && yy >= 0 && yy < n) height[yy * n + xx] = (height[yy * n + xx] ?? 1) + 0.25;
        }
      }
    }
  });

  // --- Grime / wear ---------------------------------------------------------------
  const albedoData = new Uint8Array(n * n * 4);
  const ormData = new Uint8Array(n * n * 4);
  const emisData = new Uint8Array(n * n * 4);
  const normalData = new Uint8Array(n * n * 4);
  const s = 6 / n;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      // tileable noise via torus mapping
      const ax = (x / n) * Math.PI * 2, ay = (y / n) * Math.PI * 2;
      const g = fbm3(Math.cos(ax) * 1.5 + 3, Math.sin(ax) * 1.5 + Math.cos(ay) * 1.5, Math.sin(ay) * 1.5, 4, seed);
      const fine = valueNoise3(x * s * 8, y * s * 8, 0.5, seed + 9);
      const h = height[i] ?? 1;
      const cavity = h < 0.5 ? 1 - h * 2 : 0;
      const ao = Math.max(0, Math.min(1, 1 - cavity * 0.55 - (1 - Math.min(1, h)) * 0.1));
      const wear = Math.max(0, g - 0.52) * 2.2;
      const r = Math.min(1, (rough[i] ?? 0.5) + wear * 0.35 + (fine - 0.5) * 0.08 + cavity * 0.2);
      const m = Math.max(0, (metal[i] ?? 0.7) - wear * 0.4 - cavity * 0.3);
      const alb = Math.max(0, Math.min(1, 0.92 - wear * 0.35 - cavity * 0.35 + (fine - 0.5) * 0.06));
      const o = i * 4;
      albedoData[o] = albedoData[o + 1] = albedoData[o + 2] = Math.round(alb * 255);
      albedoData[o + 3] = 255;
      ormData[o] = Math.round(ao * 255);
      ormData[o + 1] = Math.round(r * 255);
      ormData[o + 2] = Math.round(m * 255);
      ormData[o + 3] = 255;
      const e = emis[i] ?? 0;
      emisData[o] = emisData[o + 1] = emisData[o + 2] = Math.round(e * 255);
      emisData[o + 3] = 255;
    }
  }
  // --- Normal from height (Sobel, wrapped) ------------------------------------------
  const strength = n / 48;
  const H = (x: number, y: number): number => height[((y + n) % n) * n + ((x + n) % n)] ?? 1;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = (H(x + 1, y - 1) + 2 * H(x + 1, y) + H(x + 1, y + 1)) - (H(x - 1, y - 1) + 2 * H(x - 1, y) + H(x - 1, y + 1));
      const dy = (H(x - 1, y + 1) + 2 * H(x, y + 1) + H(x + 1, y + 1)) - (H(x - 1, y - 1) + 2 * H(x, y - 1) + H(x + 1, y - 1));
      let nx = -dx * strength * 0.25, ny = -dy * strength * 0.25, nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len; nz /= len;
      const o = (y * n + x) * 4;
      normalData[o] = Math.round((nx * 0.5 + 0.5) * 255);
      normalData[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      normalData[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      normalData[o + 3] = 255;
    }
  }

  const normal = finalizeTexture(normalData, n, false);
  const orm = finalizeTexture(ormData, n, false);
  const emissive = finalizeTexture(emisData, n, false);
  const albedo = finalizeTexture(albedoData, n, true);
  return {
    normal, orm, emissive, albedo,
    dispose() {
      normal.dispose(); orm.dispose(); emissive.dispose(); albedo.dispose();
    },
  };
}

/** Soft radial gradient sprite (for glows/flares/particles). */
export function createRadialTexture(size = 64, falloff = 2.2): DataTexture {
  const data = new Uint8Array(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.min(1, Math.hypot(x - c, y - c) / c);
      const a = Math.pow(1 - d, falloff);
      const o = (y * size + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = 255;
      data[o + 3] = Math.round(a * 255);
    }
  }
  const tex = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/** Hazard/checker stripes for platforms & station details. */
export function createStripeTexture(size = 64, a = [230, 180, 40], b = [30, 30, 34]): DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const on = ((x + y) >> 3) % 2 === 0;
      const c = on ? a : b;
      const o = (y * size + x) * 4;
      data[o] = c[0] ?? 0; data[o + 1] = c[1] ?? 0; data[o + 2] = c[2] ?? 0; data[o + 3] = 255;
    }
  }
  const tex = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.colorSpace = SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}
