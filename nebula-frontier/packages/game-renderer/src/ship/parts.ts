import { type BufferGeometry, Shape } from "three";
import type { ShipVisualDef } from "@nebula/shared";
import {
  type PartCollector, type V2, type V3, box, chamferBox, cyl, cylZ, extrudeTopView, latheZ, octa,
  sphere, torus, transform,
} from "./geometry.js";
import type { Detail, HullInfo } from "./hulls.js";
import { insideMirrored } from "./geometry.js";
import { MaterialSlot } from "./materials.js";
import type { Rng } from "../core/random.js";

const seg = (d: Detail, low: number, med: number, high: number): number => (d === 0 ? low : d === 1 ? med : high);

export interface Sockets {
  /** Engine exhaust points (ship-local), flame points backwards (-z). */
  nozzles: V3[];
  /** Nozzle radii for flame sizing. */
  nozzleRadius: number[];
  /** Weapon muzzle points (ship-local). */
  muzzles: V3[];
  /** Drone launch points. */
  droneBays: V3[];
  /** Reactor core (for damage sparks/explosion origin). */
  core: V3;
}

/** Height of the hull surface (or wing plane) at a point, used to seat modules. */
export function seatY(hull: HullInfo, wingY: number, x: number, z: number): number {
  if (insideMirrored(hull.outline, x, z)) {
    const t = hull.topAt(x, z);
    if (t > 0) return t;
  }
  return wingY;
}

// ---------------------------------------------------------------------------------------
// Engines
// ---------------------------------------------------------------------------------------

export function buildEngines(v: Pick<ShipVisualDef, "engine" | "nozzles" | "length">, hull: HullInfo, d: Detail, pc: PartCollector): Pick<Sockets, "nozzles" | "nozzleRadius"> {
  const L = v.length;
  const nozzles: V3[] = [];
  const radii: number[] = [];
  const count = Math.max(1, v.nozzles.length);
  const base = L * (count === 1 ? 0.085 : count <= 2 ? 0.065 : count <= 4 ? 0.05 : 0.042);
  const segs = seg(d, 8, 12, 20);
  const list: V3[] = v.nozzles.length > 0 ? v.nozzles : [[0, 0, -L / 2]];

  if (v.engine === "ring") {
    // one annular drive ring around the tail, nozzles distributed on it
    const R = Math.max(L * 0.12, ...list.map((p) => Math.abs(p[0]) + base));
    const z = Math.min(...list.map((p) => p[2]));
    const ring = torus(R, base * 0.55, seg(d, 5, 8, 10), seg(d, 16, 24, 40));
    pc.add(MaterialSlot.SECONDARY, transform(ring, [0, 0, z + base]));
    const glow = torus(R, base * 0.3, 4, seg(d, 16, 24, 40));
    pc.add(MaterialSlot.ENGINE, transform(glow, [0, 0, z + base * 0.4]));
    // spokes
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      pc.add(MaterialSlot.TRIM, transform(box(R, base * 0.25, base * 0.4), [Math.cos(a) * R * 0.5, Math.sin(a) * R * 0.5, z + base], [0, 0, a]));
    }
    const n = Math.max(4, count * 2);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      nozzles.push([Math.cos(a) * R, Math.sin(a) * R * 0.35, z]);
      radii.push(base * 0.45);
    }
    return { nozzles, nozzleRadius: radii };
  }

  for (const p of list) {
    const [x, y0, z] = p;
    const y = y0;
    switch (v.engine) {
      case "twin":
      case "quad": {
        const r = v.engine === "quad" ? base * 0.85 : base;
        const len = L * (v.engine === "quad" ? 0.22 : 0.3);
        // nacelle
        pc.add(MaterialSlot.SECONDARY, transform(latheZ([[r * 0.6, len], [r * 1.05, len * 0.8], [r * 1.1, len * 0.2], [r * 0.95, 0]], segs), [x, y, z]));
        // bell
        pc.add(MaterialSlot.TRIM, transform(latheZ([[r * 0.95, 0.002], [r * 0.85, -r * 0.5], [r * 1.0, -r * 0.9]], segs), [x, y, z]));
        pc.add(MaterialSlot.ENGINE, transform(cylZ(r * 0.8, r * 0.8, r * 0.05, segs), [x, y, z - r * 0.3]));
        if (d > 1) pc.add(MaterialSlot.ACCENT, transform(cylZ(r * 1.12, r * 1.12, len * 0.06, segs, true), [x, y, z + len * 0.55]));
        nozzles.push([x, y, z - r * 0.4]);
        radii.push(r * 0.85);
        break;
      }
      case "single-large": {
        const r = base * 1.5;
        pc.add(MaterialSlot.SECONDARY, transform(latheZ([[r * 0.8, L * 0.25], [r * 1.25, L * 0.12], [r * 1.2, 0]], segs), [x, y, z]));
        pc.add(MaterialSlot.TRIM, transform(latheZ([[r * 0.9, 0.002], [r * 0.95, -r * 0.4], [r * 1.25, -r * 1.1]], segs), [x, y, z]));
        pc.add(MaterialSlot.ENGINE, transform(cylZ(r * 0.85, r * 0.85, r * 0.05, segs), [x, y, z - r * 0.25]));
        for (let i = 0; i < (d > 1 ? 8 : 0); i++) {
          const a = (i / 8) * Math.PI * 2;
          pc.add(MaterialSlot.TRIM, transform(box(r * 0.12, r * 0.12, L * 0.1), [x + Math.cos(a) * r * 1.2, y + Math.sin(a) * r * 1.2, z + L * 0.07]));
        }
        nozzles.push([x, y, z - r * 0.5]);
        radii.push(r * 0.95);
        break;
      }
      case "cluster": {
        const r = base * 0.5;
        pc.add(MaterialSlot.SECONDARY, transform(chamferBox(base * 2.8, base * 2.2, L * 0.12, base * 0.4), [x, y, z + L * 0.06]));
        const offs: V2[] = [[0, 0], [1, 0], [-1, 0], [0.5, 0.87], [-0.5, 0.87], [0.5, -0.87], [-0.5, -0.87]];
        const use = d === 0 ? offs.slice(0, 3) : offs;
        for (const [ox, oy] of use) {
          const px = x + ox * r * 2.05, py = y + oy * r * 2.05;
          pc.add(MaterialSlot.TRIM, transform(latheZ([[r * 0.9, 0.002], [r * 0.85, -r * 0.4], [r, -r * 0.8]], seg(d, 6, 8, 12)), [px, py, z]));
          pc.add(MaterialSlot.ENGINE, transform(cylZ(r * 0.75, r * 0.75, r * 0.05, seg(d, 6, 8, 12)), [px, py, z - r * 0.25]));
        }
        nozzles.push([x, y, z - r * 0.5]);
        radii.push(r * 2.4);
        break;
      }
      case "ion-array": {
        const w = base * 2.6, h = base * 1.1;
        pc.add(MaterialSlot.SECONDARY, transform(chamferBox(w * 1.15, h * 1.3, L * 0.14, base * 0.3), [x, y, z + L * 0.07]));
        const vents = d === 0 ? 2 : 5;
        for (let i = 0; i < vents; i++) {
          const vx = x - w / 2 + ((i + 0.5) / vents) * w;
          pc.add(MaterialSlot.ENGINE, transform(box((w / vents) * 0.7, h, base * 0.05), [vx, y, z - base * 0.02]));
          pc.add(MaterialSlot.TRIM, transform(box(base * 0.08, h * 1.1, base * 0.4), [vx + (w / vents) * 0.45, y, z - base * 0.1]));
        }
        nozzles.push([x, y, z - base * 0.1]);
        radii.push(base * 1.3);
        break;
      }
      case "vector": {
        const r = base;
        pc.add(MaterialSlot.SECONDARY, transform(latheZ([[r * 0.7, L * 0.22], [r * 1.1, L * 0.1], [r * 1.05, 0]], segs), [x, y, z]));
        // thrust vectoring paddles
        const paddles = d === 0 ? 2 : 4;
        for (let i = 0; i < paddles; i++) {
          const a = (i / paddles) * Math.PI * 2 + Math.PI / 4;
          const px = x + Math.cos(a) * r * 1.05, py = y + Math.sin(a) * r * 1.05;
          pc.add(MaterialSlot.TRIM, transform(box(r * 0.7, r * 0.08, r * 1.2), [px, py, z - r * 0.5], [a > Math.PI ? -0.25 : 0.25, 0, a + Math.PI / 2]));
        }
        pc.add(MaterialSlot.ENGINE, transform(cylZ(r * 0.8, r * 0.8, r * 0.05, segs), [x, y, z - r * 0.15]));
        nozzles.push([x, y, z - r * 0.4]);
        radii.push(r * 0.85);
        break;
      }
    }
  }
  void hull;
  return { nozzles, nozzleRadius: radii };
}

// ---------------------------------------------------------------------------------------
// Wings
// ---------------------------------------------------------------------------------------

/** Planform in wing-local space: x outward from root (≥ 0), z forward. Returns full closed polygon. */
function wingSlab(pts: readonly V2[], thickness: number, d: Detail): BufferGeometry {
  // Build a closed shape directly (not mirrored).
  const half: V2[] = [...pts];
  const shape = mirroredShapeFromPolygon(half);
  return extrudeTopView(shape, { thickness, bevel: thickness * 0.3, bevelSegments: d > 1 ? 2 : 1, curveSegments: 2 });
}

function mirroredShapeFromPolygon(poly: readonly V2[]): Shape {
  const s = new Shape();
  const first = poly[0];
  if (!first) return s;
  s.moveTo(first[0], first[1]);
  for (let i = 1; i < poly.length; i++) {
    const p = poly[i];
    if (p) s.lineTo(p[0], p[1]);
  }
  s.closePath();
  return s;
}

export interface WingResult { span: number; y: number }

export function buildWings(v: Pick<ShipVisualDef, "wings" | "length" | "hardpoints">, hull: HullInfo, d: Detail, pc: PartCollector): WingResult {
  const L = v.length;
  const maxHp = v.hardpoints.reduce((m, h) => Math.max(m, Math.abs(h[0])), 0);
  const span = Math.max(hull.halfWidth * 1.05, maxHp + L * 0.06, L * 0.3);
  const rootX = Math.max(0.01, hull.bodyHalfWidthAt(hull.wingRootZ) * 0.8);
  const len = Math.max(L * 0.08, span - rootX);
  const z0 = hull.wingRootZ;
  const y = hull.wingRootY;
  const t = Math.max(0.02, L * 0.028);
  // wing tip must reach the forward-most outboard hardpoint so turrets sit on the wing
  const hpForward = v.hardpoints.filter((h) => Math.abs(h[0]) > hull.halfWidth * 0.8).reduce((m, h) => Math.max(m, h[2]), -Infinity);
  const tipZ = Number.isFinite(hpForward) ? hpForward : z0;

  const place = (planform: V2[], slot: MaterialSlot, rotZ = 0, yOff = 0, thick = t): void => {
    const g = wingSlab(planform, thick, d);
    transform(g, [rootX, y + yOff, 0], [0, 0, rotZ]);
    pc.addMirrored(slot, g);
  };
  const edgeStrip = (x0: number, z0a: number, x1: number, z1: number, yOff = 0, rotZ = 0): void => {
    const dx = x1 - x0, dz = z1 - z0a;
    const l = Math.hypot(dx, dz);
    const g = transform(box(l, t * 0.6, L * 0.012), [rootX + (x0 + x1) / 2, y + yOff + t * 0.2, (z0a + z1) / 2], [0, -Math.atan2(dz, dx), 0]);
    if (rotZ) g.rotateZ(rotZ);
    pc.addMirrored(MaterialSlot.ACCENT, g);
  };

  switch (v.wings) {
    case "none":
      return { span: hull.halfWidth, y };
    case "swept": {
      const cr = L * 0.34, ct = L * 0.11;
      const tz = Math.min(tipZ, z0 - L * 0.02);
      const pf: V2[] = [[0, z0 + cr / 2], [len, tz + ct / 2], [len, tz - ct / 2], [0, z0 - cr / 2]];
      place(pf, MaterialSlot.PRIMARY);
      if (d > 0) edgeStrip(0, z0 + cr / 2, len, tz + ct / 2);
      if (d > 0) pc.addMirrored(MaterialSlot.TRIM, transform(cylZ(t * 0.9, t * 0.9, ct * 1.6, 8), [rootX + len, y, tz]));
      break;
    }
    case "forward-swept": {
      const cr = L * 0.3, ct = L * 0.12;
      const tz = Math.max(tipZ, z0 + L * 0.18);
      const pf: V2[] = [[0, z0 + cr / 2], [len, tz + ct / 2], [len * 0.97, tz - ct / 2], [0, z0 - cr / 2]];
      place(pf, MaterialSlot.PRIMARY);
      if (d > 0) {
        edgeStrip(0, z0 - cr / 2, len * 0.97, tz - ct / 2);
        pc.addMirrored(MaterialSlot.SECONDARY, transform(chamferBox(t * 3, t * 2, ct * 1.4, t * 0.5), [rootX + len, y, tz]));
      }
      break;
    }
    case "delta": {
      const cr = L * 0.62;
      const tz = Math.min(tipZ, z0 - cr * 0.3);
      const pf: V2[] = [[0, z0 + cr * 0.45], [len, tz], [len * 0.92, tz - L * 0.06], [0, z0 - cr * 0.55]];
      place(pf, MaterialSlot.SECONDARY);
      if (d > 0) {
        edgeStrip(0, z0 + cr * 0.45, len, tz);
        // wing fence
        pc.addMirrored(MaterialSlot.TRIM, transform(box(t * 0.6, L * 0.04, cr * 0.5), [rootX + len * 0.55, y + L * 0.02, z0 - cr * 0.1]));
      }
      break;
    }
    case "x-wing": {
      const cr = L * 0.26, ct = L * 0.1;
      const tz = Math.min(tipZ, z0);
      const pf: V2[] = [[0, z0 + cr / 2], [len, tz + ct / 2], [len, tz - ct / 2], [0, z0 - cr / 2]];
      place(pf, MaterialSlot.PRIMARY, 0.24, t * 1.2);
      place(pf, MaterialSlot.SECONDARY, -0.24, -t * 1.2);
      if (d > 0) {
        const tipY = Math.sin(0.24) * len;
        for (const s of [1, -1]) {
          pc.addMirrored(MaterialSlot.TRIM, transform(cylZ(t, t * 0.7, ct * 2.2, 8), [rootX + len * Math.cos(0.24), y + s * (tipY + t * 1.2), tz]));
        }
      }
      break;
    }
    case "folded": {
      const cr = L * 0.3, ct = L * 0.14;
      const tz = Math.min(tipZ, z0 + L * 0.02);
      const pf: V2[] = [[0, z0 + cr / 2], [len, tz + ct / 2], [len, tz - ct / 2], [0, z0 - cr / 2]];
      place(pf, MaterialSlot.PRIMARY, -0.32);
      // vertical tip fins
      const drop = Math.sin(0.32) * len;
      const fin = transform(chamferBox(t * 1.2, L * 0.14, ct * 1.3, t * 0.3), [rootX + len * Math.cos(0.32), y - drop, tz]);
      pc.addMirrored(MaterialSlot.SECONDARY, fin);
      if (d > 0) pc.addMirrored(MaterialSlot.GLOW, transform(box(t * 1.4, L * 0.01, ct * 1.1), [rootX + len * Math.cos(0.32), y - drop + L * 0.07, tz]));
      break;
    }
    case "blade": {
      const cw = L * 0.07;
      const tz = Math.max(tipZ + L * 0.12, z0 + L * 0.35);
      const pf: V2[] = [[0, z0 + cw], [len * 0.9, tz], [len, tz - L * 0.02], [len * 0.35, z0 - cw * 0.3], [0, z0 - cw]];
      place(pf, MaterialSlot.SECONDARY, 0.04, 0, t * 0.8);
      if (d > 0) edgeStrip(0, z0 + cw, len * 0.9, tz, 0, 0);
      break;
    }
    case "ring": {
      const R = Math.max(span * 0.85, L * 0.3);
      const segs = seg(d, 16, 28, 44);
      const ring = latheZ([[R, L * 0.1], [R * 1.03, 0], [R, -L * 0.1], [R * 0.97, 0], [R, L * 0.1]], segs);
      pc.add(MaterialSlot.PRIMARY, transform(ring, [0, y, z0 - L * 0.1], [0, 0, 0], [1, 0.45, 1]));
      // pylons
      for (const a of [0, Math.PI]) {
        pc.add(MaterialSlot.TRIM, transform(box(R - rootX, t * 1.2, L * 0.08), [Math.cos(a) * (R + rootX) / 2, y, z0 - L * 0.1]));
      }
      if (d > 0) pc.add(MaterialSlot.GLOW, transform(torus(R * 1.02, L * 0.006, 3, segs), [0, y, z0 - L * 0.1], [0, 0, 0], [1, 0.45, 1]));
      return { span: R, y };
    }
    case "canard": {
      const cr = L * 0.14;
      const small = Math.max(L * 0.1, len * 0.55);
      const fz = hull.noseZ - L * 0.22;
      place([[0, fz + cr / 2], [small, fz - cr * 0.1], [small, fz - cr * 0.45], [0, fz - cr / 2]], MaterialSlot.SECONDARY);
      const rz = z0 - L * 0.08;
      place([[0, rz + cr * 0.7], [len, Math.min(tipZ, rz) + cr * 0.1], [len, Math.min(tipZ, rz) - cr * 0.3], [0, rz - cr * 0.7]], MaterialSlot.PRIMARY);
      break;
    }
  }
  return { span, y };
}

// ---------------------------------------------------------------------------------------
// Cockpit / reactor / armor / antenna / cargo / dock / hardpoints
// ---------------------------------------------------------------------------------------

export function buildCockpit(kind: ShipVisualDef["cockpit"], L: number, hull: HullInfo, d: Detail, pc: PartCollector): void {
  const [x, y, z] = hull.cockpit;
  const s = Math.min(L * 0.07, 0.35 + L * 0.03);
  const segs = seg(d, 8, 12, 18);
  switch (kind) {
    case "none": return;
    case "bubble":
      pc.add(MaterialSlot.GLASS, transform(sphere(s, segs, segs / 2, Math.PI / 2), [x, y - s * 0.1, z], [0, 0, 0], [1, 0.8, 1.5]));
      pc.add(MaterialSlot.TRIM, transform(torus(s * 1.02, s * 0.08, 4, segs), [x, y - s * 0.08, z], [Math.PI / 2, 0, 0], [1, 1.5, 1]));
      return;
    case "canopy":
      pc.add(MaterialSlot.GLASS, transform(latheZ([[0.001, s * 2.2], [s * 0.6, s * 1.4], [s * 0.8, 0], [s * 0.6, -s * 1.4], [0.001, -s * 2]], segs, -Math.PI / 2, Math.PI), [x, y - s * 0.05, z], [0, 0, 0], [1, 0.9, 1]));
      pc.add(MaterialSlot.TRIM, transform(box(s * 0.12, s * 0.12, s * 4), [x, y + s * 0.7, z]));
      return;
    case "slit":
      pc.add(MaterialSlot.TRIM, transform(chamferBox(s * 2.6, s * 0.7, s * 2, s * 0.3), [x, y + s * 0.2, z]));
      pc.add(MaterialSlot.GLOW, transform(box(s * 2.2, s * 0.15, s * 0.3), [x, y + s * 0.45, z + s * 0.9]));
      return;
    case "bridge": {
      const b = Math.max(s, L * 0.045);
      pc.add(MaterialSlot.SECONDARY, transform(chamferBox(b * 3, b * 1.4, b * 2.4, b * 0.4), [x, y + b * 0.6, z]));
      pc.add(MaterialSlot.SECONDARY, transform(chamferBox(b * 2, b * 0.9, b * 1.6, b * 0.3), [x, y + b * 1.6, z - b * 0.2]));
      pc.add(MaterialSlot.GLASS, transform(box(b * 2.9, b * 0.28, b * 0.1), [x, y + b * 0.95, z + b * 1.2]));
      pc.add(MaterialSlot.GLASS, transform(box(b * 1.9, b * 0.2, b * 0.08), [x, y + b * 1.8, z + b * 0.6]));
      if (d > 0) pc.add(MaterialSlot.GLOW, transform(box(b * 0.2, b * 0.2, b * 0.2), [x, y + b * 2.15, z - b * 0.2]));
      return;
    }
    case "sensor-eye":
      pc.add(MaterialSlot.TRIM, transform(cylZ(s * 1.2, s * 1.4, s * 0.8, segs), [x, y, hull.noseZ - s * 0.3]));
      pc.add(MaterialSlot.GLOW, transform(sphere(s * 0.8, segs, segs / 2), [x, y, hull.noseZ + s * 0.1]));
      pc.add(MaterialSlot.ACCENT, transform(torus(s * 1.25, s * 0.12, 4, segs), [x, y, hull.noseZ + s * 0.1]));
      pc.add(MaterialSlot.GLASS, transform(sphere(s * 0.7, segs, segs / 2, Math.PI / 2), [x, y, z], [0, 0, 0], [1, 0.6, 1.3]));
      return;
  }
}

export function buildReactor(kind: ShipVisualDef["reactor"], L: number, hull: HullInfo, d: Detail, pc: PartCollector): V3 {
  const [x, y, z] = hull.reactor;
  const s = L * 0.05;
  const segs = seg(d, 8, 12, 16);
  switch (kind) {
    case "exposed-core":
      pc.add(MaterialSlot.GLOW, transform(sphere(s * 0.8, segs, segs / 2), [x, y + s * 0.4, z]));
      for (let i = 0; i < (d === 0 ? 2 : 4); i++) {
        const a = (i / 4) * Math.PI * 2;
        pc.add(MaterialSlot.TRIM, transform(box(s * 0.12, s * 1.6, s * 0.12), [x + Math.cos(a) * s, y + s * 0.4, z + Math.sin(a) * s]));
      }
      pc.add(MaterialSlot.TRIM, transform(torus(s * 1.0, s * 0.1, 4, segs), [x, y + s * 1.1, z], [Math.PI / 2, 0, 0]));
      return [x, y + s * 0.4, z];
    case "twin-cell":
      for (const sx of [1, -1]) {
        pc.add(MaterialSlot.GLOW, transform(cylZ(s * 0.35, s * 0.35, s * 2, segs), [x + sx * s * 0.55, y + s * 0.2, z]));
        pc.add(MaterialSlot.TRIM, transform(cylZ(s * 0.45, s * 0.45, s * 0.25, segs), [x + sx * s * 0.55, y + s * 0.2, z + s]));
        pc.add(MaterialSlot.TRIM, transform(cylZ(s * 0.45, s * 0.45, s * 0.25, segs), [x + sx * s * 0.55, y + s * 0.2, z - s]));
      }
      return [x, y + s * 0.2, z];
    case "ring-core":
      pc.add(MaterialSlot.GLOW, transform(torus(s * 0.9, s * 0.18, 6, segs * 2), [x, y + s * 0.2, z], [Math.PI / 2, 0, 0]));
      pc.add(MaterialSlot.TRIM, transform(cyl(s * 0.5, s * 0.6, s * 0.5, segs), [x, y + s * 0.2, z]));
      pc.add(MaterialSlot.ACCENT, transform(cyl(s * 0.2, s * 0.2, s * 0.6, segs), [x, y + s * 0.3, z]));
      return [x, y + s * 0.2, z];
    case "buried":
      for (let i = 0; i < 3; i++) {
        pc.addMirrored(MaterialSlot.GLOW, transform(box(s * 0.5, s * 0.06, s * 0.15), [x + s * 0.5, y + s * 0.02, z - i * s * 0.4]));
      }
      return [x, y - s, z];
  }
}

export function buildArmor(kind: ShipVisualDef["armor"], L: number, hull: HullInfo, d: Detail, rng: Rng, pc: PartCollector): void {
  if (d === 0) return;
  const hw = hull.bodyHalfWidthAt(0);
  switch (kind) {
    case "light":
      return;
    case "plated": {
      for (let i = 0; i < 3; i++) {
        const z = L * (0.15 - i * 0.16);
        const x = Math.max(hull.bodyHalfWidthAt(z), L * 0.05);
        pc.addMirrored(MaterialSlot.SECONDARY, transform(chamferBox(L * 0.03, L * 0.06, L * 0.13, L * 0.01), [x + L * 0.005, hull.topAt(x * 0.5, z) * 0.3, z]));
      }
      return;
    }
    case "heavy": {
      for (let i = 0; i < 4; i++) {
        const z = L * (0.25 - i * 0.16);
        const x = Math.max(hull.bodyHalfWidthAt(z), L * 0.05);
        pc.addMirrored(MaterialSlot.SECONDARY, transform(chamferBox(L * 0.05, L * 0.09, L * 0.15, L * 0.015), [x + L * 0.01, 0, z], [0, 0, -0.15]));
      }
      pc.add(MaterialSlot.TRIM, transform(chamferBox(Math.max(hw, L * 0.08) * 1.6, L * 0.05, L * 0.05, L * 0.01), [0, hull.topAt(0, hull.noseZ - L * 0.12) * 0.6, hull.noseZ - L * 0.1]));
      return;
    }
    case "ablative": {
      // layered scale tiles along the dorsal line
      const rows = 5;
      for (let i = 0; i < rows; i++) {
        const z = L * (0.25 - i * 0.12);
        const y = hull.topAt(0, z);
        if (y <= 0) continue;
        pc.add(MaterialSlot.SECONDARY, transform(chamferBox(L * 0.1, L * 0.018, L * 0.1, L * 0.02), [0, y + L * 0.008, z], [-0.12, 0, 0]));
        pc.addMirrored(MaterialSlot.TRIM, transform(chamferBox(L * 0.06, L * 0.014, L * 0.08, L * 0.015), [L * 0.07, hull.topAt(L * 0.07, z) + L * 0.004, z - L * 0.03], [-0.1, 0, 0.1]));
      }
      return;
    }
    case "crystal": {
      const n = d > 1 ? 9 : 5;
      for (let i = 0; i < n; i++) {
        const z = L * rng.range(-0.35, 0.3);
        const x = L * rng.range(0.02, 0.14);
        const y = Math.max(0, hull.topAt(x, z));
        const g = transform(octa(L * rng.range(0.025, 0.05)), [x, y + L * 0.01, z], [rng.range(0, 1), rng.range(0, 3), rng.range(0, 1)], [0.6, rng.range(1.4, 2.4), 0.6]);
        pc.addMirrored(MaterialSlot.ACCENT, g);
      }
      return;
    }
  }
}

export function buildAntenna(kind: ShipVisualDef["antenna"], L: number, hull: HullInfo, d: Detail, pc: PartCollector): void {
  if (d === 0 || kind === "none") return;
  const z = hull.tailZ + L * 0.22;
  const y = Math.max(0, hull.topAt(0, z));
  switch (kind) {
    case "mast":
      pc.add(MaterialSlot.TRIM, transform(cyl(L * 0.006, L * 0.01, L * 0.16, 6), [0, y + L * 0.08, z]));
      pc.add(MaterialSlot.GLOW, transform(sphere(L * 0.012, 6, 4), [0, y + L * 0.165, z]));
      pc.add(MaterialSlot.TRIM, transform(box(L * 0.08, L * 0.005, L * 0.005), [0, y + L * 0.12, z]));
      return;
    case "array":
      for (let i = 0; i < 4; i++) {
        pc.addMirrored(MaterialSlot.TRIM, transform(cyl(L * 0.004, L * 0.006, L * (0.06 + i * 0.015), 5), [L * 0.03, y + L * (0.03 + i * 0.0075), z + i * L * 0.04 - L * 0.06]));
      }
      pc.add(MaterialSlot.ACCENT, transform(box(L * 0.1, L * 0.008, L * 0.18), [0, y + L * 0.005, z - L * 0.0]));
      return;
    case "dish": {
      const r = L * 0.06;
      const dish = latheZ([[0.001, 0], [r * 0.5, -r * 0.08], [r, -r * 0.3]], 14);
      pc.add(MaterialSlot.SECONDARY, transform(dish, [L * 0.05, y + L * 0.06, z], [-0.9, 0.5, 0]));
      pc.add(MaterialSlot.TRIM, transform(cyl(L * 0.006, L * 0.008, L * 0.07, 6), [L * 0.05, y + L * 0.03, z]));
      pc.add(MaterialSlot.GLOW, transform(sphere(L * 0.008, 6, 4), [L * 0.05, y + L * 0.075, z + L * 0.02]));
      return;
    }
    case "spikes":
      for (let i = 0; i < 3; i++) {
        const sz = z + L * (0.05 + i * 0.12);
        const sy = Math.max(0, hull.topAt(0, sz));
        pc.add(MaterialSlot.ACCENT, transform(cyl(0.001, L * 0.018, L * (0.12 - i * 0.025), 5), [0, sy + L * 0.05, sz], [-0.5, 0, 0]));
        pc.addMirrored(MaterialSlot.TRIM, transform(cyl(0.001, L * 0.012, L * 0.08, 5), [L * 0.06, sy + L * 0.02, sz], [-0.6, 0, -0.5]));
      }
      return;
  }
}

export function buildCargo(kind: ShipVisualDef["cargo"], L: number, hull: HullInfo, d: Detail, pc: PartCollector): void {
  if (kind === "none") return;
  const hw = Math.max(hull.bodyHalfWidthAt(-L * 0.1), L * 0.06);
  switch (kind) {
    case "pods": {
      const r = L * 0.045;
      const pod = latheZ([[0.001, L * 0.12], [r * 0.8, L * 0.1], [r, 0], [r, -L * 0.1], [0.001, -L * 0.13]], seg(d, 6, 10, 14));
      pc.addMirrored(MaterialSlot.SECONDARY, transform(pod, [hw + r * 1.1, -r * 0.4, -L * 0.08]));
      if (d > 0) pc.addMirrored(MaterialSlot.ACCENT, transform(cylZ(r * 1.05, r * 1.05, L * 0.015, 10, true), [hw + r * 1.1, -r * 0.4, -L * 0.02]));
      return;
    }
    case "hold":
      pc.add(MaterialSlot.SECONDARY, transform(chamferBox(hw * 1.5, L * 0.08, L * 0.36, L * 0.03), [0, -L * 0.07, -L * 0.05]));
      if (d > 0) for (let i = 0; i < 3; i++) pc.add(MaterialSlot.TRIM, transform(box(hw * 1.55, L * 0.012, L * 0.01), [0, -L * 0.04, -L * (0.18 - i * 0.12)]));
      return;
    case "container-rack": {
      const rows = d === 0 ? 1 : 2, cols = d === 0 ? 2 : 4;
      const cw = L * 0.07, ch = L * 0.05, cl = L * 0.1;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const z = -L * 0.02 - c * cl * 1.1;
          const x = hw + cw * (0.6 + r * 1.1);
          const y = Math.max(0, hull.topAt(0, z)) * 0.2;
          const slot = (r + c) % 2 === 0 ? MaterialSlot.SECONDARY : MaterialSlot.ACCENT;
          pc.addMirrored(slot, transform(chamferBox(cw, ch, cl, L * 0.006), [x, y, z]));
        }
      }
      pc.addMirrored(MaterialSlot.TRIM, transform(box(L * 0.01, L * 0.01, cols * cl * 1.1), [hw + cw * 0.1, 0, -L * 0.02 - (cols - 1) * cl * 0.55]));
      return;
    }
  }
}

export function buildDroneDock(L: number, hull: HullInfo, d: Detail, pc: PartCollector): V3[] {
  const bays: V3[] = [];
  const n = 3;
  for (let i = 0; i < n; i++) {
    const z = L * (0.1 - i * 0.14);
    const x = Math.max(hull.bodyHalfWidthAt(z) * 0.85, L * 0.06);
    const y = Math.max(0, hull.topAt(x * 0.5, z)) * 0.4;
    pc.addMirrored(MaterialSlot.TRIM, transform(chamferBox(L * 0.06, L * 0.04, L * 0.1, L * 0.008), [x, y, z]));
    if (d > 0) pc.addMirrored(MaterialSlot.GLOW, transform(box(L * 0.004, L * 0.025, L * 0.08), [x + L * 0.031, y, z]));
    bays.push([x + L * 0.04, y, z], [-(x + L * 0.04), y, z]);
  }
  return bays;
}

export function buildHardpoints(hps: readonly V3[], L: number, hull: HullInfo, wingY: number, d: Detail, pc: PartCollector): V3[] {
  const muzzles: V3[] = [];
  const s = Math.min(L * 0.035, 0.12 + L * 0.012);
  const segs = seg(d, 6, 8, 12);
  for (const [x, y0, z] of hps) {
    const baseY = Math.max(y0, seatY(hull, wingY, x, z));
    if (d === 0) {
      muzzles.push([x, baseY + s * 0.8, z + s * 3.2]);
      continue;
    }
    pc.add(MaterialSlot.TRIM, transform(cyl(s * 1.1, s * 1.3, s * 0.5, segs), [x, baseY + s * 0.25, z]));
    pc.add(MaterialSlot.SECONDARY, transform(chamferBox(s * 1.6, s * 0.8, s * 1.8, s * 0.3), [x, baseY + s * 0.8, z]));
    const barrels = L > 5 ? 2 : 1;
    for (let b = 0; b < barrels; b++) {
      const bx = barrels === 1 ? x : x + (b === 0 ? -s * 0.4 : s * 0.4);
      pc.add(MaterialSlot.TRIM, transform(cylZ(s * 0.18, s * 0.26, s * 2.6, segs), [bx, baseY + s * 0.85, z + s * 2.0]));
      if (d > 1) pc.add(MaterialSlot.ACCENT, transform(cylZ(s * 0.3, s * 0.3, s * 0.3, segs), [bx, baseY + s * 0.85, z + s * 3.1]));
    }
    muzzles.push([x, baseY + s * 0.85, z + s * 3.4]);
  }
  return muzzles;
}
