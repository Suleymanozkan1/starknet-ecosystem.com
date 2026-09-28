import type { BufferGeometry, Shape } from "three";
import { Shape as ThreeShape, SphereGeometry, Vector2 } from "three";
import type { ShipVisualDef } from "@nebula/shared";
import {
  type PartCollector, type V2, type V3, chamferBox, cylZ, extrudeTopView, insideMirrored, latheZ, mirroredShape,
  sphere, taperY, torus, transform, box, shiftY,
} from "./geometry.js";
import { MaterialSlot } from "./materials.js";

export type HullType = ShipVisualDef["hull"];

/** Level of detail for procedural building: 0 = low, 1 = medium, 2 = high. */
export type Detail = 0 | 1 | 2;

/** Mounting information exported by a hull so modular parts can attach believably. */
export interface HullInfo {
  length: number;
  /** Max half-width of the hull body. */
  halfWidth: number;
  /** Max top height. */
  top: number;
  /** Half outline used for greeble placement & inside tests (x ≥ 0, nose → tail). */
  outline: V2[];
  /** Approximate top surface height at (x, z); only meaningful inside the outline. */
  topAt(x: number, z: number): number;
  /** Half width of the central fuselage at z (wing roots). */
  bodyHalfWidthAt(z: number): number;
  cockpit: V3;
  reactor: V3;
  /** z of the wing root centre. */
  wingRootZ: number;
  wingRootY: number;
  tailZ: number;
  noseZ: number;
}

const seg = (d: Detail, low: number, med: number, high: number): number => (d === 0 ? low : d === 1 ? med : high);

function scaleOutline(pts: readonly V2[], w: number, l: number): V2[] {
  return pts.map(([x, z]) => [x * w, z * l] as V2);
}

/** Linear interpolation of the outline half-width at z (outline sorted by z descending per segment). */
function outlineHalfWidth(outline: readonly V2[], z: number): number {
  let best = 0;
  for (let i = 0; i < outline.length - 1; i++) {
    const a = outline[i], b = outline[i + 1];
    if (!a || !b) continue;
    const [x0, z0] = a, [x1, z1] = b;
    if ((z <= z0 && z >= z1) || (z >= z0 && z <= z1)) {
      const t = Math.abs(z1 - z0) < 1e-6 ? 0 : (z - z0) / (z1 - z0);
      best = Math.max(best, x0 + (x1 - x0) * t);
    }
  }
  return best;
}

function smoothShape(half: readonly V2[], divisions: number): Shape {
  const s = new ThreeShape();
  const right = half.map(([x, z]) => new Vector2(x, z));
  const first = right[0];
  if (!first) return s;
  s.moveTo(first.x, first.y);
  s.splineThru(right.slice(1));
  const left = [...half].reverse().map(([x, z]) => new Vector2(-x, z));
  s.splineThru(left.slice(1));
  // Densify is handled by curveSegments in extrude.
  void divisions;
  return s;
}

interface SlabOptions {
  half: V2[];
  thickness: number;
  y?: number;
  bevel?: number;
  smooth?: boolean;
  taper?: (x: number, z: number) => number;
  lift?: (x: number, z: number) => number;
}

function slab(d: Detail, o: SlabOptions): BufferGeometry {
  const shape = o.smooth ? smoothShape(o.half, 24) : mirroredShape(o.half);
  let g = extrudeTopView(shape, {
    thickness: o.thickness,
    bevel: o.bevel ?? Math.min(0.06, o.thickness * 0.22),
    bevelSegments: seg(d, 1, 1, 2),
    curveSegments: seg(d, 4, 8, 16),
    y: o.y ?? 0,
  });
  if (o.taper) g = taperY(g, o.taper, o.y ?? 0);
  if (o.lift) g = shiftY(g, o.lift);
  return g;
}

type HullBuilder = (L: number, d: Detail, pc: PartCollector) => HullInfo;

function info(L: number, outline: V2[], top: number, partial: Partial<HullInfo>): HullInfo {
  let hw = 0;
  for (const [x] of outline) hw = Math.max(hw, x);
  return {
    length: L,
    halfWidth: hw,
    top,
    outline,
    topAt: partial.topAt ?? (() => top),
    bodyHalfWidthAt: partial.bodyHalfWidthAt ?? ((z) => outlineHalfWidth(outline, z)),
    cockpit: partial.cockpit ?? [0, top, L * 0.2],
    reactor: partial.reactor ?? [0, top, -L * 0.15],
    wingRootZ: partial.wingRootZ ?? -L * 0.1,
    wingRootY: partial.wingRootY ?? 0,
    tailZ: partial.tailZ ?? -L / 2,
    noseZ: partial.noseZ ?? L / 2,
  };
}

// ---------------------------------------------------------------------------------------
// Archetypes
// ---------------------------------------------------------------------------------------

const dart: HullBuilder = (L, d, pc) => {
  const outline = scaleOutline([[0, 0.5], [0.05, 0.4], [0.09, 0.15], [0.12, -0.12], [0.17, -0.34], [0.18, -0.46], [0.1, -0.44], [0.07, -0.5], [0, -0.48]], L, L);
  const t = L * 0.13;
  const taper = (_x: number, z: number): number => 0.35 + 0.65 * Math.min(1, (L * 0.5 - z) / (L * 0.45));
  pc.add(MaterialSlot.PRIMARY, slab(d, { half: outline, thickness: t, taper }));
  // raised dorsal spine
  const spine = scaleOutline([[0, 0.3], [0.035, 0.18], [0.05, -0.2], [0.04, -0.42], [0, -0.44]], L, L);
  pc.add(MaterialSlot.SECONDARY, slab(d, { half: spine, thickness: L * 0.07, y: t * 0.45, taper: (_x, z) => 0.5 + 0.5 * Math.min(1, (L * 0.3 - z) / (L * 0.3)) }));
  if (d > 0) {
    // side intakes
    const intake = transform(chamferBox(L * 0.05, t * 0.55, L * 0.16, L * 0.015), [L * 0.11, 0, -L * 0.05]);
    pc.addMirrored(MaterialSlot.TRIM, intake);
    pc.addMirrored(MaterialSlot.GLOW, transform(box(L * 0.035, t * 0.18, L * 0.01), [L * 0.11, 0, L * 0.035]));
  }
  return info(L, outline, t * 0.5 + L * 0.035, {
    topAt: (_x, z) => (t / 2) * taper(0, z),
    cockpit: [0, t * 0.5, L * 0.2],
    reactor: [0, t * 0.55, -L * 0.28],
    wingRootZ: -L * 0.2,
  });
};

const arrowhead: HullBuilder = (L, d, pc) => {
  const outline = scaleOutline([[0, 0.5], [0.1, 0.28], [0.34, -0.26], [0.4, -0.4], [0.33, -0.44], [0.15, -0.3], [0.1, -0.42], [0, -0.38]], L, L);
  const t = L * 0.08;
  const taper = (x: number): number => 1 - 0.55 * Math.min(1, Math.abs(x) / (L * 0.4));
  pc.add(MaterialSlot.PRIMARY, slab(d, { half: outline, thickness: t, taper }));
  // central fuselage pod (lathe)
  const pod = latheZ([[0.001, L * 0.46], [L * 0.04, L * 0.38], [L * 0.075, L * 0.18], [L * 0.085, -L * 0.2], [L * 0.07, -L * 0.42], [0.001, -L * 0.44]], seg(d, 8, 12, 20));
  pc.add(MaterialSlot.SECONDARY, transform(pod, [0, t * 0.35, 0], [0, 0, 0], [1, 0.75, 1]));
  if (d > 0) {
    // wing edge strakes
    const strake = transform(box(L * 0.2, t * 0.3, L * 0.02), [L * 0.22, t * 0.3, -L * 0.1], [0, -0.85, 0]);
    pc.addMirrored(MaterialSlot.ACCENT, strake);
  }
  return info(L, outline, t * 0.35 + L * 0.064, {
    topAt: (x, z) => {
      const podR = Math.max(0, L * 0.08 - Math.abs(x));
      return (t / 2) * taper(x) + (Math.abs(z) < L * 0.4 ? podR * 0.9 : 0);
    },
    cockpit: [0, t * 0.35 + L * 0.06, L * 0.22],
    reactor: [0, t * 0.35 + L * 0.06, -L * 0.18],
    bodyHalfWidthAt: () => L * 0.08,
    wingRootZ: -L * 0.15,
  });
};

const wedge: HullBuilder = (L, d, pc) => {
  const outline = scaleOutline([[0.06, 0.5], [0.12, 0.46], [0.35, -0.38], [0.32, -0.5], [0, -0.5]], L, L);
  const t = L * 0.22;
  const rise = (z: number): number => 0.25 + 0.75 * Math.min(1, Math.max(0, (L * 0.5 - z) / L));
  pc.add(MaterialSlot.PRIMARY, slab(d, { half: outline, thickness: t, taper: (_x, z) => rise(z), y: 0 }));
  // stacked upper wedge (stepped)
  const upper = scaleOutline([[0.04, 0.2], [0.08, 0.17], [0.2, -0.4], [0.18, -0.48], [0, -0.48]], L, L);
  pc.add(MaterialSlot.SECONDARY, slab(d, { half: upper, thickness: t * 0.5, y: t * 0.45, taper: (_x, z) => 0.2 + 0.8 * Math.min(1, Math.max(0, (L * 0.2 - z) / (L * 0.65))) }));
  if (d > 0) {
    // armour ridge lines
    for (let i = 0; i < 3; i++) {
      const z = -L * (0.05 + i * 0.13);
      const w = L * (0.18 + i * 0.05);
      pc.addMirrored(MaterialSlot.TRIM, transform(box(w, L * 0.012, L * 0.02), [w / 2 + L * 0.02, (t / 2) * rise(z) + L * 0.004, z]));
    }
  }
  return info(L, outline, t * 0.7, {
    topAt: (_x, z) => (t / 2) * rise(z),
    cockpit: [0, (t / 2) * rise(L * 0.25), L * 0.25],
    reactor: [0, t * 0.7, -L * 0.3],
    wingRootZ: -L * 0.3,
  });
};

const hammer: HullBuilder = (L, d, pc) => {
  const body = scaleOutline([[0, 0.28], [0.1, 0.28], [0.12, 0.1], [0.12, -0.44], [0.15, -0.5], [0, -0.5]], L, L);
  const t = L * 0.13;
  pc.add(MaterialSlot.PRIMARY, slab(d, { half: body, thickness: t }));
  const head = scaleOutline([[0, 0.5], [0.34, 0.5], [0.42, 0.45], [0.44, 0.34], [0.36, 0.26], [0, 0.26]], L, L);
  pc.add(MaterialSlot.SECONDARY, slab(d, { half: head, thickness: t * 1.25, y: t * 0.05 }));
  // head armour lip
  pc.add(MaterialSlot.TRIM, transform(chamferBox(L * 0.8, t * 0.3, L * 0.04, L * 0.01), [0, t * 0.1, L * 0.505]));
  if (d > 0) {
    // bridge tower
    pc.add(MaterialSlot.SECONDARY, transform(chamferBox(L * 0.12, t * 0.9, L * 0.2, L * 0.03), [0, t * 0.8, -L * 0.2]));
    // ventral keel
    pc.add(MaterialSlot.TRIM, transform(chamferBox(L * 0.06, t * 0.6, L * 0.6, L * 0.02), [0, -t * 0.55, -L * 0.1]));
    // head sensor lights
    for (let i = 0; i < 4; i++) pc.addMirrored(MaterialSlot.GLOW, transform(box(L * 0.03, L * 0.01, L * 0.01), [L * (0.08 + i * 0.08), t * 0.66, L * 0.495]));
  }
  const outline = scaleOutline([[0, 0.5], [0.34, 0.5], [0.44, 0.4], [0.44, 0.3], [0.12, 0.26], [0.12, -0.44], [0.15, -0.5], [0, -0.5]], L, L);
  return info(L, outline, t * 1.25, {
    topAt: (_x, z) => (z > L * 0.26 ? t * 0.68 : t * 0.5),
    cockpit: [0, t * 1.25, -L * 0.2],
    reactor: [0, t * 0.5, -L * 0.38],
    bodyHalfWidthAt: () => L * 0.12,
    wingRootZ: -L * 0.05,
  });
};

const manta: HullBuilder = (L, d, pc) => {
  const outline = scaleOutline([[0, 0.5], [0.1, 0.43], [0.28, 0.22], [0.48, -0.06], [0.46, -0.16], [0.26, -0.24], [0.12, -0.38], [0.04, -0.5], [0, -0.5]], L, L);
  const t = L * 0.12;
  const taper = (x: number, z: number): number => Math.max(0.12, 1 - Math.pow(Math.abs(x) / (L * 0.48), 0.8)) * (0.7 + 0.3 * Math.max(0, 1 - Math.abs(z) / (L * 0.5)));
  pc.add(MaterialSlot.PRIMARY, slab(d, { half: outline, thickness: t, smooth: true, taper }));
  // dorsal carapace
  const cara = scaleOutline([[0, 0.34], [0.09, 0.26], [0.13, 0.0], [0.1, -0.3], [0, -0.38]], L, L);
  pc.add(MaterialSlot.SECONDARY, slab(d, { half: cara, thickness: t * 0.6, y: t * 0.35, smooth: true, taper: (x) => 1 - 0.6 * Math.min(1, Math.abs(x) / (L * 0.13)) }));
  if (d > 0) {
    // gill slits (glow)
    for (let i = 0; i < 4; i++) {
      pc.addMirrored(MaterialSlot.GLOW, transform(box(L * 0.06, L * 0.008, L * 0.012), [L * 0.16, t * 0.35, L * (0.02 - i * 0.05)], [0, 0.35, 0]));
    }
    // tail spine
    pc.add(MaterialSlot.TRIM, transform(cylZ(L * 0.004, L * 0.025, L * 0.25, 6), [0, 0, -L * 0.58]));
  }
  return info(L, outline, t * 0.65, {
    topAt: (x, z) => (t / 2) * taper(x, z) + (Math.abs(x) < L * 0.12 && z < L * 0.3 && z > -L * 0.35 ? t * 0.25 : 0),
    cockpit: [0, t * 0.65, L * 0.28],
    reactor: [0, t * 0.62, -L * 0.1],
    bodyHalfWidthAt: () => L * 0.14,
    wingRootZ: -L * 0.12,
  });
};

const spine: HullBuilder = (L, d, pc) => {
  const r = L * 0.055;
  const segs = seg(d, 6, 10, 16);
  pc.add(MaterialSlot.PRIMARY, latheZ([[0.001, L * 0.5], [r * 0.6, L * 0.46], [r * 1.3, L * 0.36], [r * 1.3, L * 0.26], [r, L * 0.22], [r, -L * 0.36], [r * 1.5, -L * 0.4], [r * 1.5, -L * 0.48], [0.001, -L * 0.5]], segs));
  // ribs
  const ribs = d === 0 ? 3 : 6;
  for (let i = 0; i < ribs; i++) {
    const z = L * 0.18 - (i * L * 0.52) / (ribs - 1);
    pc.add(MaterialSlot.TRIM, transform(torus(r * 1.35, r * 0.28, 5, segs), [0, 0, z]));
  }
  // forward sensor module + rear drive block
  pc.add(MaterialSlot.SECONDARY, transform(chamferBox(r * 4.2, r * 1.6, L * 0.12, r * 0.4), [0, 0, L * 0.3]));
  pc.add(MaterialSlot.SECONDARY, transform(chamferBox(r * 5, r * 2.2, L * 0.16, r * 0.5), [0, 0, -L * 0.4]));
  if (d > 0) {
    // side modules along the spine
    for (let i = 0; i < 2; i++) {
      pc.addMirrored(MaterialSlot.SECONDARY, transform(chamferBox(r * 1.4, r * 1.4, L * 0.14, r * 0.3), [r * 1.9, 0, L * (0.02 - i * 0.2)]));
      pc.addMirrored(MaterialSlot.GLOW, transform(box(r * 0.2, r * 0.4, L * 0.1), [r * 2.62, 0, L * (0.02 - i * 0.2)]));
    }
  }
  const outline = scaleOutline([[0, 0.5], [0.09, 0.36], [0.09, 0.24], [0.06, 0.2], [0.13, 0.08], [0.13, -0.32], [0.14, -0.48], [0, -0.5]], L, L);
  return info(L, outline, r * 1.3, {
    topAt: (_x, z) => (Math.abs(z - L * 0.3) < L * 0.06 ? r * 0.8 : Math.abs(z + L * 0.4) < L * 0.08 ? r * 1.1 : r),
    cockpit: [0, r * 0.8, L * 0.4],
    reactor: [0, r * 1.1, -L * 0.4],
    bodyHalfWidthAt: () => r * 1.2,
    wingRootZ: -L * 0.12,
  });
};

const crescent: HullBuilder = (L, d, pc) => {
  const n = seg(d, 6, 10, 16);
  const half: V2[] = [];
  // inner arc from the centre apex forward to the horn tip
  const ci = 0.12, ri = 0.4;
  for (let i = 0; i <= n; i++) {
    const b = (i / n) * (Math.PI * 0.7);
    half.push([Math.sin(b) * ri, ci - Math.cos(b) * ri]);
  }
  // outer arc from the horn tip back to the rear
  const co = -0.02, ro = 0.48;
  for (let i = n; i >= 0; i--) {
    const a = (i / n) * (Math.PI * 0.68);
    half.push([Math.sin(a) * ro, co - Math.cos(a) * ro]);
  }
  const outline = scaleOutline(half, L, L);
  const t = L * 0.1;
  pc.add(MaterialSlot.PRIMARY, slab(d, { half: outline, thickness: t, taper: (x) => 1 - 0.45 * Math.min(1, Math.abs(x) / (L * 0.46)) }));
  // central pod
  pc.add(MaterialSlot.SECONDARY, transform(latheZ([[0.001, L * 0.12], [L * 0.06, L * 0.06], [L * 0.08, -L * 0.2], [L * 0.06, -L * 0.42], [0.001, -L * 0.46]], seg(d, 8, 12, 18)), [0, t * 0.3, 0], [0, 0, 0], [1, 0.7, 1]));
  if (d > 0) {
    // horn tip emitters
    pc.addMirrored(MaterialSlot.GLOW, transform(sphere(L * 0.025, 8, 6), [Math.sin(Math.PI * 0.7) * ri * L, 0, (ci - Math.cos(Math.PI * 0.7) * ri) * L]));
    // edge trim along the outer arc
    for (let i = 1; i < 5; i++) {
      const a = (i / 5) * Math.PI * 0.62;
      pc.addMirrored(MaterialSlot.TRIM, transform(box(L * 0.05, t * 0.4, L * 0.02), [Math.sin(a) * ro * L * 0.97, t * 0.35, (co - Math.cos(a) * ro) * L * 0.97], [0, a, 0]));
    }
  }
  return info(L, outline, t * 0.3 + L * 0.056, {
    topAt: (x) => (t / 2) * (1 - 0.45 * Math.min(1, Math.abs(x) / (L * 0.46))),
    cockpit: [0, t * 0.3 + L * 0.05, L * 0.02],
    reactor: [0, t * 0.3 + L * 0.055, -L * 0.2],
    bodyHalfWidthAt: () => L * 0.08,
    wingRootZ: -L * 0.3,
    noseZ: L * 0.38,
  });
};

const monolith: HullBuilder = (L, d, pc) => {
  const outline = scaleOutline([[0.18, 0.5], [0.28, 0.43], [0.3, -0.42], [0.26, -0.5], [0, -0.5]], L, L);
  const t = L * 0.2;
  pc.add(MaterialSlot.PRIMARY, slab(d, { half: outline, thickness: t, bevel: L * 0.025 }));
  const deck = scaleOutline([[0.12, 0.36], [0.2, 0.3], [0.21, -0.38], [0.17, -0.44], [0, -0.44]], L, L);
  pc.add(MaterialSlot.SECONDARY, slab(d, { half: deck, thickness: t * 0.45, y: t * 0.6, bevel: L * 0.02 }));
  const crown = scaleOutline([[0.06, 0.1], [0.1, 0.06], [0.1, -0.3], [0, -0.3]], L, L);
  pc.add(MaterialSlot.PRIMARY, slab(d, { half: crown, thickness: t * 0.35, y: t * 0.95, bevel: L * 0.015 }));
  if (d > 0) {
    // hull ribs + window bands
    for (let i = 0; i < 6; i++) {
      const z = L * (0.35 - i * 0.14);
      pc.addMirrored(MaterialSlot.TRIM, transform(box(L * 0.02, t * 0.9, L * 0.05), [L * 0.3, 0, z]));
      pc.addMirrored(MaterialSlot.GLOW, transform(box(L * 0.004, t * 0.08, L * 0.07), [L * 0.305, t * 0.25, z - L * 0.07]));
    }
  }
  return info(L, outline, t * 1.12, {
    topAt: (x, z) => (Math.abs(x) < L * 0.1 && z < L * 0.1 && z > -L * 0.3 ? t * 1.12 : Math.abs(x) < L * 0.2 && z < L * 0.34 && z > -L * 0.44 ? t * 0.82 : t * 0.5),
    cockpit: [0, t * 1.12, L * 0.0],
    reactor: [0, t * 0.82, -L * 0.36],
    bodyHalfWidthAt: () => L * 0.3,
    wingRootZ: -L * 0.1,
  });
};

const trident: HullBuilder = (L, d, pc) => {
  const outline = scaleOutline([[0, 0.5], [0.045, 0.46], [0.06, -0.05], [0.22, -0.05], [0.23, 0.3], [0.27, 0.38], [0.31, 0.3], [0.33, -0.3], [0.28, -0.5], [0, -0.46]], L, L);
  const t = L * 0.1;
  pc.add(MaterialSlot.PRIMARY, slab(d, { half: outline, thickness: t }));
  // central prong superstructure
  const prong = scaleOutline([[0, 0.42], [0.03, 0.36], [0.04, -0.3], [0, -0.34]], L, L);
  pc.add(MaterialSlot.SECONDARY, slab(d, { half: prong, thickness: t * 0.7, y: t * 0.5 }));
  // side prong turret housings
  pc.addMirrored(MaterialSlot.SECONDARY, transform(chamferBox(L * 0.07, t * 0.6, L * 0.4, L * 0.015), [L * 0.28, t * 0.45, L * 0.0]));
  if (d > 0) {
    // prong tip emitters
    pc.add(MaterialSlot.GLOW, transform(cylZ(L * 0.012, L * 0.02, L * 0.05, 8), [0, 0, L * 0.5]));
    pc.addMirrored(MaterialSlot.GLOW, transform(cylZ(L * 0.012, L * 0.018, L * 0.04, 8), [L * 0.27, 0, L * 0.39]));
    // crossbar conduits
    for (let i = 0; i < 3; i++) pc.addMirrored(MaterialSlot.TRIM, transform(cylZ(L * 0.012, L * 0.012, L * 0.15, 6), [L * (0.1 + i * 0.05), t * 0.52, -L * 0.2], [0, Math.PI / 2, 0]));
  }
  return info(L, outline, t * 0.85, {
    topAt: (x) => (Math.abs(x) < L * 0.04 ? t * 0.85 : Math.abs(Math.abs(x) - L * 0.28) < L * 0.035 ? t * 0.75 : t * 0.5),
    cockpit: [0, t * 0.85, L * 0.12],
    reactor: [0, t * 0.5, -L * 0.3],
    bodyHalfWidthAt: () => L * 0.3,
    wingRootZ: -L * 0.3,
  });
};

const beetle: HullBuilder = (L, d, pc) => {
  const ws = seg(d, 8, 14, 22), hs = seg(d, 5, 8, 12);
  const rx = L * 0.3, ry = L * 0.17, rz = L * 0.44;
  // two elytra shells split along the spine (half domes)
  for (const side of [1, -1] as const) {
    const g = new SphereGeometry(1, ws, hs, side > 0 ? Math.PI / 2 : -Math.PI / 2, Math.PI, 0, Math.PI / 2);
    transform(g, [side * L * 0.012, 0, 0], [0, 0, 0], [rx, ry, rz]);
    pc.add(MaterialSlot.PRIMARY, g);
  }
  // underbody slab
  const belly = scaleOutline([[0.08, 0.44], [0.26, 0.3], [0.3, -0.2], [0.22, -0.44], [0, -0.46]], L, L);
  pc.add(MaterialSlot.SECONDARY, slab(d, { half: belly, thickness: L * 0.08, y: -L * 0.03, smooth: true }));
  // central seam
  pc.add(MaterialSlot.GLOW, transform(box(L * 0.012, L * 0.02, L * 0.8), [0, ry * 0.97, 0], [0, 0, 0], [1, 1, 1]));
  // mandibles
  const mand = latheZ([[0.001, L * 0.16], [L * 0.03, L * 0.08], [L * 0.04, -L * 0.02], [0.001, -L * 0.06]], seg(d, 5, 6, 8));
  pc.addMirrored(MaterialSlot.TRIM, transform(mand, [L * 0.12, -L * 0.01, L * 0.48], [0, -0.35, 0]));
  const outline = scaleOutline([[0, 0.5], [0.16, 0.44], [0.3, 0.2], [0.31, -0.1], [0.24, -0.4], [0.1, -0.48], [0, -0.48]], L, L);
  return info(L, outline, ry, {
    topAt: (x, z) => {
      const e = 1 - (x * x) / (rx * rx) - (z * z) / (rz * rz);
      return e > 0 ? ry * Math.sqrt(e) : 0;
    },
    cockpit: [0, ry * 0.75, L * 0.3],
    reactor: [0, ry * 0.95, -L * 0.05],
    bodyHalfWidthAt: () => rx * 0.9,
    wingRootZ: -L * 0.05,
  });
};

const needle: HullBuilder = (L, d, pc) => {
  const r = L * 0.05;
  const segs = seg(d, 6, 10, 16);
  pc.add(MaterialSlot.PRIMARY, latheZ([[0.001, L * 0.5], [r * 0.3, L * 0.38], [r * 0.8, L * 0.2], [r, L * 0.05], [r * 1.1, -L * 0.3], [r * 1.25, -L * 0.42], [r * 0.9, -L * 0.5], [0.001, -L * 0.5]], segs));
  // collar rings
  pc.add(MaterialSlot.SECONDARY, transform(cylZ(r * 1.25, r * 1.25, L * 0.06, segs), [0, 0, L * 0.02]));
  pc.add(MaterialSlot.SECONDARY, transform(cylZ(r * 1.4, r * 1.4, L * 0.08, segs), [0, 0, -L * 0.35]));
  if (d > 0) {
    pc.add(MaterialSlot.GLOW, transform(cylZ(r * 1.27, r * 1.27, L * 0.008, segs, true), [0, 0, L * 0.05]));
    // dorsal & ventral fins
    const fin = scaleOutline([[0, 0.0], [0.004, -0.02], [0.004, -0.18], [0, -0.2]], L, L);
    const finG = slab(d, { half: fin, thickness: L * 0.08 });
    // stand the fin up: rotate so thickness goes along x
    pc.add(MaterialSlot.TRIM, transform(finG, [0, r * 1.1, -L * 0.22], [0, 0, Math.PI / 2]));
  }
  const outline = scaleOutline([[0, 0.5], [0.02, 0.3], [0.05, 0.05], [0.06, -0.35], [0.07, -0.42], [0.05, -0.5], [0, -0.5]], L, L);
  return info(L, outline, r * 1.2, {
    topAt: () => r,
    cockpit: [0, r * 0.75, L * 0.18],
    reactor: [0, r * 0.9, -L * 0.2],
    bodyHalfWidthAt: () => r,
    wingRootZ: -L * 0.2,
  });
};

const halo: HullBuilder = (L, d, pc) => {
  const R = L * 0.38, w = L * 0.07, h = L * 0.05;
  const segs = seg(d, 16, 28, 48);
  // flat ring (lathe around Y)
  const ring = latheZ([[R - w, h / 2], [R + w, h / 2], [R + w * 1.1, 0], [R + w, -h / 2], [R - w, -h / 2], [R - w * 1.1, 0], [R - w, h / 2]], segs);
  // latheZ spins around z; turn it so the ring lies flat in XZ
  ring.rotateX(Math.PI / 2);
  pc.add(MaterialSlot.PRIMARY, ring);
  // inner glow band
  const band = torus(R - w * 1.05, h * 0.18, 4, segs);
  band.rotateX(Math.PI / 2);
  pc.add(MaterialSlot.GLOW, band);
  // central pod
  pc.add(MaterialSlot.SECONDARY, latheZ([[0.001, L * 0.5], [L * 0.05, L * 0.42], [L * 0.09, L * 0.2], [L * 0.1, -L * 0.1], [L * 0.08, -L * 0.42], [0.001, -L * 0.46]], seg(d, 8, 12, 18)));
  // struts
  const struts = 4;
  for (let i = 0; i < struts; i++) {
    const a = (i / struts) * Math.PI * 2 + Math.PI / 4;
    const len = R - L * 0.09;
    const s = transform(chamferBox(L * 0.04, h * 0.7, len, L * 0.01), [Math.sin(a) * (L * 0.09 + len / 2), 0, Math.cos(a) * (L * 0.09 + len / 2)], [0, a, 0]);
    pc.add(MaterialSlot.TRIM, s);
  }
  const outline: V2[] = [];
  const n = 12;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI;
    outline.push([Math.sin(a) * (R + w), Math.cos(a) * (R + w)]);
  }
  return info(L, outline, L * 0.1, {
    topAt: (x, z) => {
      const rr = Math.hypot(x, z);
      if (Math.abs(rr - R) < w) return h / 2;
      if (Math.abs(x) < L * 0.09) return L * 0.08;
      return -1;
    },
    cockpit: [0, L * 0.085, L * 0.3],
    reactor: [0, L * 0.09, -L * 0.05],
    bodyHalfWidthAt: () => L * 0.09,
    wingRootZ: -L * 0.2,
  });
};

export const HULL_BUILDERS: Readonly<Record<HullType, HullBuilder>> = {
  dart, arrowhead, wedge, hammer, manta, spine, crescent, monolith, trident, beetle, needle, halo,
};

export const HULL_TYPES = Object.keys(HULL_BUILDERS) as HullType[];

export function buildHull(type: HullType, L: number, d: Detail, pc: PartCollector): HullInfo {
  return HULL_BUILDERS[type](L, d, pc);
}

export { insideMirrored };
