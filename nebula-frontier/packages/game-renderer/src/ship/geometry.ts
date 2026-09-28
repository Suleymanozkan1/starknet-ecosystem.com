import {
  BoxGeometry, BufferAttribute, BufferGeometry, CylinderGeometry, ExtrudeGeometry, LatheGeometry, Matrix4,
  Quaternion, Shape, SphereGeometry, TorusGeometry, Vector2, Vector3, Euler, OctahedronGeometry,
} from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { MaterialSlot } from "./materials.js";

export type V2 = readonly [number, number];
export type V3 = readonly [number, number, number];

/** Make a geometry mergeable: non-indexed, only position/normal/uv attributes, box-projected UVs. */
export function prepare(geo: BufferGeometry, uvScale = 0.9): BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  for (const name of Object.keys(g.attributes)) {
    if (name !== "position" && name !== "normal") g.deleteAttribute(name);
  }
  if (!g.attributes.normal) g.computeVertexNormals();
  boxProjectUVs(g, uvScale);
  g.morphAttributes = {};
  return g;
}

/** Box/triplanar-style UVs in object space so panel textures keep a constant density across parts. */
export function boxProjectUVs(geo: BufferGeometry, scale: number): void {
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  if (!pos || !nor) return;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i)), nz = Math.abs(nor.getZ(i));
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    let u: number, v: number;
    if (ny >= nx && ny >= nz) { u = x; v = z; }
    else if (nx >= nz) { u = z; v = y; }
    else { u = x; v = y; }
    uv[i * 2] = u * scale;
    uv[i * 2 + 1] = v * scale;
  }
  geo.setAttribute("uv", new BufferAttribute(uv, 2));
}

/** Build a mirrored (bilaterally symmetric) Shape from the right half outline, nose → tail (x ≥ 0). */
export function mirroredShape(half: readonly V2[]): Shape {
  const pts: Vector2[] = [];
  for (const [x, z] of half) pts.push(new Vector2(x, z));
  for (let i = half.length - 1; i >= 0; i--) {
    const p = half[i];
    if (!p) continue;
    if (Math.abs(p[0]) < 1e-6 && (i === 0 || i === half.length - 1)) continue;
    pts.push(new Vector2(-p[0], p[1]));
  }
  return new Shape(pts);
}

export interface ExtrudeOpts {
  thickness: number;
  bevel?: number;
  bevelSegments?: number;
  curveSegments?: number;
  /** Vertical centre of the slab. */
  y?: number;
}

/** Extrude a top-view shape (x = right, shape-y = forward/z) into a slab lying in XZ, y-centered. */
export function extrudeTopView(shape: Shape, o: ExtrudeOpts): BufferGeometry {
  const bevel = o.bevel ?? Math.min(0.08, o.thickness * 0.3);
  const depth = Math.max(0.001, o.thickness - bevel * 2);
  const geo = new ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: -bevel,
    bevelSegments: o.bevelSegments ?? 2,
    curveSegments: o.curveSegments ?? 8,
  });
  geo.rotateX(Math.PI / 2); // shape-y → +z, extrude → -y
  geo.translate(0, depth / 2 + (o.y ?? 0), 0);
  return geo;
}

/** Scale vertex heights (around `pivotY`) by fn(x, z). Useful for wedge/tapered hard-surface forms. */
export function taperY(geo: BufferGeometry, fn: (x: number, z: number) => number, pivotY = 0): BufferGeometry {
  const pos = geo.attributes.position;
  if (!pos) return geo;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    pos.setY(i, pivotY + (y - pivotY) * fn(x, z));
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/** Offset heights by fn(x,z) (e.g. raise the spine). */
export function shiftY(geo: BufferGeometry, fn: (x: number, z: number) => number): BufferGeometry {
  const pos = geo.attributes.position;
  if (!pos) return geo;
  for (let i = 0; i < pos.count; i++) pos.setY(i, pos.getY(i) + fn(pos.getX(i), pos.getZ(i)));
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/** Lathe around the Z axis (forward). Profile points are [radius, z]. */
export function latheZ(profile: readonly V2[], segments: number, phiStart = 0, phiLength = Math.PI * 2): BufferGeometry {
  const pts = profile.map(([r, z]) => new Vector2(Math.max(0.0001, r), z));
  const geo = new LatheGeometry(pts, segments, phiStart, phiLength);
  geo.rotateX(Math.PI / 2); // lathe axis Y → Z
  // After rotateX(+90°) original +y maps to +z; profile z is along lathe axis.
  return geo;
}

const tmpM = new Matrix4();
const tmpQ = new Quaternion();
const tmpE = new Euler();
const tmpS = new Vector3();
const tmpP = new Vector3();

export function transform(geo: BufferGeometry, pos: V3, rot: V3 = [0, 0, 0], scale: V3 = [1, 1, 1]): BufferGeometry {
  tmpE.set(rot[0], rot[1], rot[2]);
  tmpQ.setFromEuler(tmpE);
  tmpS.set(scale[0], scale[1], scale[2]);
  tmpP.set(pos[0], pos[1], pos[2]);
  tmpM.compose(tmpP, tmpQ, tmpS);
  geo.applyMatrix4(tmpM);
  return geo;
}

// --- primitive shortcuts ---------------------------------------------------------------
export const box = (w: number, h: number, d: number): BufferGeometry => new BoxGeometry(w, h, d);
export const cyl = (rTop: number, rBot: number, h: number, seg: number, open = false): BufferGeometry =>
  new CylinderGeometry(rTop, rBot, h, seg, 1, open);
/** Cylinder whose axis is Z (forward). */
export const cylZ = (rFront: number, rBack: number, len: number, seg: number, open = false): BufferGeometry =>
  new CylinderGeometry(rFront, rBack, len, seg, 1, open).rotateX(Math.PI / 2);
export const sphere = (r: number, ws: number, hs: number, thetaLen = Math.PI): BufferGeometry =>
  new SphereGeometry(r, ws, hs, 0, Math.PI * 2, 0, thetaLen);
export const torus = (r: number, tube: number, rs: number, ts: number): BufferGeometry => new TorusGeometry(r, tube, rs, ts);
export const octa = (r: number): BufferGeometry => new OctahedronGeometry(r, 0);

/** Chamfered box (hard-surface) — an extruded rounded rectangle. */
export function chamferBox(w: number, h: number, d: number, chamfer = 0.15): BufferGeometry {
  const c = Math.min(chamfer, w * 0.45, d * 0.45);
  const hw = w / 2, hd = d / 2;
  const half: V2[] = [[0, hd], [hw - c, hd], [hw, hd - c], [hw, -hd + c], [hw - c, -hd], [0, -hd]];
  return extrudeTopView(mirroredShape(half), { thickness: h, bevel: Math.min(c * 0.5, h * 0.25), bevelSegments: 1 });
}

/**
 * Accumulates part geometries per material slot, then merges them so each
 * ship costs one draw call per slot.
 */
export class PartCollector {
  private readonly parts = new Map<MaterialSlot, BufferGeometry[]>();
  readonly uvScale: number;

  constructor(uvScale = 0.9) {
    this.uvScale = uvScale;
  }

  add(slot: MaterialSlot, geo: BufferGeometry): void {
    const g = prepare(geo, this.uvScale);
    let list = this.parts.get(slot);
    if (!list) {
      list = [];
      this.parts.set(slot, list);
    }
    list.push(g);
  }

  /** Add a geometry and its X-mirrored copy. */
  addMirrored(slot: MaterialSlot, geo: BufferGeometry): void {
    const m = geo.clone();
    mirrorX(m);
    this.add(slot, geo);
    this.add(slot, m);
  }

  merge(): Map<MaterialSlot, BufferGeometry> {
    const out = new Map<MaterialSlot, BufferGeometry>();
    for (const [slot, list] of this.parts) {
      if (list.length === 0) continue;
      const merged = list.length === 1 ? list[0] : mergeGeometries(list, false);
      if (!merged) throw new Error(`Failed to merge geometries for slot ${slot}`);
      if (list.length > 1) for (const g of list) g.dispose();
      merged.computeBoundingBox();
      merged.computeBoundingSphere();
      out.set(slot, merged);
    }
    this.parts.clear();
    return out;
  }
}

/** Mirror geometry across X, fixing triangle winding and normals. */
export function mirrorX(geo: BufferGeometry): BufferGeometry {
  geo.scale(-1, 1, 1);
  // flip winding
  const g = geo.index ? geo.toNonIndexed() : geo;
  const pos = g.attributes.position;
  const nor = g.attributes.normal;
  if (pos) {
    for (let i = 0; i < pos.count; i += 3) {
      swapVert(pos, i + 1, i + 2);
      if (nor) swapVert(nor, i + 1, i + 2);
    }
    pos.needsUpdate = true;
  }
  if (g !== geo) {
    geo.copy(g);
    g.dispose();
  }
  return geo;
}

function swapVert(attr: BufferAttribute | import("three").InterleavedBufferAttribute, a: number, b: number): void {
  const ax = attr.getX(a), ay = attr.getY(a), az = attr.getZ(a);
  attr.setXYZ(a, attr.getX(b), attr.getY(b), attr.getZ(b));
  attr.setXYZ(b, ax, ay, az);
}

/** Point-in-polygon for a mirrored half outline (x ≥ 0 half, nose→tail), closed along the x=0 axis. */
export function insideMirrored(half: readonly V2[], x: number, z: number): boolean {
  const ax = Math.abs(x);
  const first = half[0];
  const last = half[half.length - 1];
  if (!first || !last) return false;
  const poly: V2[] = [];
  if (first[0] > 1e-6) poly.push([0, first[1]]);
  poly.push(...half);
  if (last[0] > 1e-6) poly.push([0, last[1]]);
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i], pj = poly[j];
    if (!pi || !pj) continue;
    const [xi, zi] = pi;
    const [xj, zj] = pj;
    if ((zi > z) !== (zj > z) && ax < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
