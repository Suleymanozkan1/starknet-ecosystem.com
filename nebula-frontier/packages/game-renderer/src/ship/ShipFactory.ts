import type { BufferGeometry, DataTexture } from "three";
import {
  AdditiveBlending, BoxGeometry, Box3, Color, CylinderGeometry, Group, InstancedMesh,
  LOD, Matrix4, Mesh, type Material, type Object3D, Quaternion, ShaderMaterial, Sphere, Sprite, SpriteMaterial,
  Vector3, Euler,
} from "three";
import type { CosmeticPayload, ShipDef, ShipVisualDef } from "@nebula/shared";
import { createRng } from "../core/random.js";
import { createRadialTexture } from "../textures/procedural.js";
import { PartCollector, insideMirrored, type V3 } from "./geometry.js";
import { buildHull, type Detail } from "./hulls.js";
import {
  buildAntenna, buildArmor, buildCargo, buildCockpit, buildDroneDock, buildEngines, buildHardpoints, buildReactor,
  buildWings, type Sockets,
} from "./parts.js";
import type { MaterialLibrary } from "./materials.js";
import { MATERIAL_SLOTS, type MaterialSlot, type ShipPalette, type SlotMaterials } from "./materials.js";
import { resolveLook, type ResolvedLook } from "./cosmetics.js";
import type { GlbLibrary } from "./glb.js";

/** Geometry-affecting fields of a ship visual → stable cache key. Colors are NOT part of the key. */
export function shipGeometryKey(v: ShipVisualDef): string {
  const r = (n: number): string => (Math.round(n * 1000) / 1000).toString();
  const pts = (list: readonly (readonly number[])[]): string => list.map((p) => p.map(r).join(",")).join(";");
  return [
    v.hull, v.engine, v.wings, v.cockpit, v.reactor, v.armor, v.antenna, v.cargo, v.droneDock ? "dock" : "nodock",
    r(v.length), pts(v.hardpoints), pts(v.nozzles),
  ].join("|");
}

export interface ShipGeometrySet {
  key: string;
  /** Per LOD level (0 = high, 1 = medium, 2 = low) merged geometry per material slot. */
  levels: Map<MaterialSlot, BufferGeometry>[];
  sockets: Sockets;
  /** Greeble instance matrices (high LOD only). */
  greebles: Float32Array;
  radius: number;
  bounds: Box3;
  refs: number;
}

export interface ShipFactoryOptions {
  materials: MaterialLibrary;
  greebles: boolean;
  lodBias: number;
  /**
   * Production GLB loader. When set, ships whose visual has a `glb` URL get it attached to their high LOD
   * as soon as it loads; the procedural mesh stays in place until then (and on load failure).
   */
  glb?: GlbLibrary | null;
}

const DETAIL_FOR_LEVEL: Detail[] = [2, 1, 0];

/** Build all LOD levels for a visual. Pure geometry (headless-safe). */
export function buildShipGeometry(v: ShipVisualDef, withGreebles: boolean): ShipGeometrySet {
  const key = shipGeometryKey(v);
  const levels: Map<MaterialSlot, BufferGeometry>[] = [];
  let sockets: Sockets | null = null;
  let greebles: Float32Array = new Float32Array(0);
  for (const d of DETAIL_FOR_LEVEL) {
    const rng = createRng(key);
    const pc = new PartCollector(0.75 / Math.sqrt(Math.max(1, v.length / 3)));
    const L = v.length;
    const hull = buildHull(v.hull, L, d, pc);
    const wings = buildWings(v, hull, d, pc);
    const engines = buildEngines(v, hull, d, pc);
    buildCockpit(v.cockpit, L, hull, d, pc);
    const core = buildReactor(v.reactor, L, hull, d, pc);
    buildArmor(v.armor, L, hull, d, rng, pc);
    buildAntenna(v.antenna, L, hull, d, pc);
    buildCargo(v.cargo, L, hull, d, pc);
    const bays = v.droneDock ? buildDroneDock(L, hull, d, pc) : [];
    const muzzles = buildHardpoints(v.hardpoints, L, hull, wings.y + L * 0.02, d, pc);
    levels.push(pc.merge());
    if (d === 2) {
      sockets = { nozzles: engines.nozzles, nozzleRadius: engines.nozzleRadius, muzzles, droneBays: bays, core };
      if (withGreebles) greebles = sampleGreebles(hull, L, rng);
    }
  }
  const bounds = new Box3();
  const high = levels[0];
  if (high) {
    for (const g of high.values()) {
      if (!g.boundingBox) g.computeBoundingBox();
      if (g.boundingBox) bounds.union(g.boundingBox);
    }
  }
  const sphere = bounds.getBoundingSphere(new Sphere());
  if (!sockets) throw new Error("ship build produced no sockets");
  return { key, levels, sockets, greebles, radius: sphere.radius, bounds, refs: 0 };
}

const gM = new Matrix4();
const gQ = new Quaternion();
const gE = new Euler();
const gP = new Vector3();
const gS = new Vector3();

function sampleGreebles(hull: ReturnType<typeof buildHull>, L: number, rng: ReturnType<typeof createRng>): Float32Array {
  const target = Math.round(Math.min(90, 18 + L * 6));
  const out: number[] = [];
  let tries = 0;
  const hw = hull.halfWidth;
  while (out.length / 16 < target && tries < target * 12) {
    tries++;
    const x = rng.range(-hw, hw);
    const z = rng.range(hull.tailZ, hull.noseZ);
    if (!insideMirrored(hull.outline, x, z)) continue;
    const y = hull.topAt(x, z);
    if (y <= 0) continue;
    const sx = L * rng.range(0.008, 0.03), sy = L * rng.range(0.004, 0.014), sz = L * rng.range(0.01, 0.05);
    gE.set(0, rng() < 0.7 ? 0 : Math.PI / 2, 0);
    gQ.setFromEuler(gE);
    gP.set(x, y + sy * 0.5, z);
    gS.set(sx, sy, sz);
    gM.compose(gP, gQ, gS);
    out.push(...gM.elements);
  }
  return new Float32Array(out);
}

// ---------------------------------------------------------------------------------------
// Engine flame material (shared per color)
// ---------------------------------------------------------------------------------------

const FLAME_VERT = /* glsl */ `
uniform float uTime;
varying float vT;
varying float vN;
void main() {
  vT = clamp(-position.z, 0.0, 1.0);
  vec3 p = position;
  float f = sin(uTime * 38.0 + position.x * 20.0) * 0.06 + sin(uTime * 23.0 + position.y * 17.0) * 0.05;
  p.z *= 1.0 + f;
  vN = f;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;
const FLAME_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uIntensity;
varying float vT;
varying float vN;
void main() {
  float a = pow(1.0 - vT, 1.6) * uIntensity;
  vec3 core = mix(vec3(1.0), uColor, smoothstep(0.0, 0.45, vT));
  gl_FragColor = vec4(core * (1.1 + vN * 1.5), a * 0.85);
}`;

export interface ShipModelOptions {
  cosmetics?: readonly CosmeticPayload[];
  /** Material variant, e.g. "wreck" for derelicts. */
  variant?: "" | "wreck" | "boss";
  shipId?: string;
  /** Show engine flames / glow sprites. */
  engines?: boolean;
}

/**
 * Builds modular procedural ships from ShipVisualDef. Geometry is cached per
 * (visual geometry key) and shared between instances; materials are shared per palette.
 */
export class ShipFactory {
  private readonly cache = new Map<string, ShipGeometrySet>();
  private readonly flameMats = new Map<string, ShaderMaterial>();
  private readonly glowMats = new Map<string, SpriteMaterial>();
  readonly materials: MaterialLibrary;
  private readonly flameGeo: BufferGeometry;
  private readonly greebleGeo: BufferGeometry;
  private readonly glowTex: DataTexture;
  private greeblesEnabled: boolean;
  private readonly glb: GlbLibrary | null;
  lodBias: number;

  constructor(opts: ShipFactoryOptions) {
    this.materials = opts.materials;
    this.glb = opts.glb ?? null;
    this.greeblesEnabled = opts.greebles;
    this.lodBias = opts.lodBias;
    this.flameGeo = new CylinderGeometry(0.05, 1, 1, 10, 1, true).rotateX(-Math.PI / 2).translate(0, 0, -0.5);
    this.greebleGeo = new BoxGeometry(1, 1, 1);
    this.glowTex = createRadialTexture(64, 2.4);
  }

  setGreebles(on: boolean): void {
    this.greeblesEnabled = on;
  }

  /** Get (and build if needed) the cached geometry set for a visual. */
  geometry(v: ShipVisualDef): ShipGeometrySet {
    const key = shipGeometryKey(v);
    let set = this.cache.get(key);
    if (!set) {
      set = buildShipGeometry(v, true);
      this.cache.set(key, set);
    }
    return set;
  }

  get cacheSize(): number {
    return this.cache.size;
  }

  flameMaterial(color: string): ShaderMaterial {
    let m = this.flameMats.get(color);
    if (!m) {
      m = new ShaderMaterial({
        uniforms: { uTime: { value: 0 }, uColor: { value: new Color(color) }, uIntensity: { value: 1 } },
        vertexShader: FLAME_VERT,
        fragmentShader: FLAME_FRAG,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        toneMapped: false,
      });
      this.flameMats.set(color, m);
    }
    return m;
  }

  glowMaterial(color: string): SpriteMaterial {
    let m = this.glowMats.get(color);
    if (!m) {
      m = new SpriteMaterial({ map: this.glowTex, color: new Color(color).multiplyScalar(2), blending: AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false });
      this.glowMats.set(color, m);
    }
    return m;
  }

  /** Advance shared animated materials. */
  update(time: number): void {
    for (const m of this.flameMats.values()) {
      const u = m.uniforms.uTime;
      if (u) u.value = time;
    }
  }

  createFromDef(def: ShipDef, opts: ShipModelOptions = {}): ShipModel {
    return this.create(def.visual, { ...opts, shipId: opts.shipId ?? def.id });
  }

  create(visual: ShipVisualDef, opts: ShipModelOptions = {}): ShipModel {
    const look = resolveLook(visual, opts.cosmetics ?? [], opts.shipId);
    const set = this.geometry(look.visual);
    set.refs++;
    const mats = this.materials.get(look.palette, opts.variant ?? "");
    const model = new ShipModel(this, set, look, mats, opts.engines ?? opts.variant !== "wreck");
    if (this.glb && look.visual.glb && (opts.variant ?? "") === "") model.glbReady = this.glb.apply(model);
    return model;
  }

  /** Internal: create LOD levels for a model. */
  buildLod(set: ShipGeometrySet, mats: SlotMaterials): { lod: LOD; greebles: InstancedMesh | null } {
    const lod = new LOD();
    const L = set.radius * 2;
    const dist = [0, (120 + L * 6) * this.lodBias, (240 + L * 12) * this.lodBias];
    let greebles: InstancedMesh | null = null;
    set.levels.forEach((level, i) => {
      const g = new Group();
      for (const slot of MATERIAL_SLOTS) {
        const geo = level.get(slot);
        if (!geo) continue;
        const mesh = new Mesh(geo, mats[slot]);
        mesh.castShadow = i === 0 && slot !== "engine" && slot !== "glow";
        mesh.receiveShadow = i === 0;
        mesh.name = slot;
        g.add(mesh);
      }
      if (i === 0 && this.greeblesEnabled && set.greebles.length > 0) {
        const count = set.greebles.length / 16;
        greebles = new InstancedMesh(this.greebleGeo, mats.trim, count);
        greebles.instanceMatrix.array.set(set.greebles);
        greebles.instanceMatrix.needsUpdate = true;
        greebles.castShadow = false;
        greebles.name = "greebles";
        g.add(greebles);
      }
      lod.addLevel(g, dist[i] ?? 0);
    });
    return { lod, greebles };
  }

  release(set: ShipGeometrySet): void {
    set.refs = Math.max(0, set.refs - 1);
  }

  /** Drop cached geometry sets with no live instances. */
  trim(): number {
    let n = 0;
    for (const [k, set] of this.cache) {
      if (set.refs > 0) continue;
      for (const lvl of set.levels) for (const g of lvl.values()) g.dispose();
      this.cache.delete(k);
      n++;
    }
    return n;
  }

  dispose(): void {
    for (const set of this.cache.values()) for (const lvl of set.levels) for (const g of lvl.values()) g.dispose();
    this.cache.clear();
    for (const m of this.flameMats.values()) m.dispose();
    for (const m of this.glowMats.values()) m.dispose();
    this.flameMats.clear();
    this.glowMats.clear();
    this.flameGeo.dispose();
    this.greebleGeo.dispose();
    this.glowTex.dispose();
  }

  get flameGeometry(): BufferGeometry {
    return this.flameGeo;
  }
}

const tmpV = new Vector3();
const tmpV2 = new Vector3();

/** A live ship visual (one per entity). Owns only its scene-graph nodes; geometry/materials are shared. */
export class ShipModel {
  readonly root = new Group();
  readonly lod: LOD;
  readonly look: ResolvedLook;
  readonly sockets: Sockets;
  readonly radius: number;
  readonly length: number;
  /** Local-space bounds of the high LOD. Shared — do not mutate. */
  readonly bounds: Box3;
  private readonly factory: ShipFactory;
  private readonly set: ShipGeometrySet;
  private readonly flames: Mesh[] = [];
  private readonly glows: Sprite[] = [];
  private greebles: InstancedMesh | null;
  private glb: Object3D | null = null;
  /** Resolves once the production GLB is attached (true) or unavailable (false); false immediately without one. */
  glbReady: Promise<boolean> = Promise.resolve(false);
  private thrust = 0;
  private disposed = false;
  readonly materials: SlotMaterials;

  constructor(factory: ShipFactory, set: ShipGeometrySet, look: ResolvedLook, mats: SlotMaterials, engines: boolean) {
    this.factory = factory;
    this.set = set;
    this.look = look;
    this.materials = mats;
    this.sockets = set.sockets;
    this.radius = set.radius;
    this.bounds = set.bounds;
    this.length = look.visual.length;
    const { lod, greebles } = factory.buildLod(set, mats);
    this.lod = lod;
    this.greebles = greebles;
    this.root.add(lod);
    this.root.name = "ship";
    if (engines) {
      const flameMat = factory.flameMaterial(look.palette.engine);
      const glowMat = factory.glowMaterial(look.palette.engine);
      set.sockets.nozzles.forEach((n, i) => {
        const r = set.sockets.nozzleRadius[i] ?? 0.1;
        const f = new Mesh(factory.flameGeometry, flameMat);
        f.position.set(n[0], n[1], n[2]);
        f.scale.set(r, r, r * 3);
        f.renderOrder = 2;
        this.flames.push(f);
        this.root.add(f);
        const s = new Sprite(glowMat);
        s.position.set(n[0], n[1], n[2] - r * 0.3);
        s.scale.setScalar(r * 4);
        s.renderOrder = 3;
        this.glows.push(s);
        this.root.add(s);
      });
    }
  }

  get palette(): ShipPalette {
    return this.look.palette;
  }

  /** 0..1 thrust; boost stretches flames. */
  setThrust(t: number, boost = false): void {
    const k = Math.max(0.12, Math.min(1, t)) * (boost ? 1.9 : 1);
    if (Math.abs(k - this.thrust) < 0.01) return;
    this.thrust = k;
    for (let i = 0; i < this.flames.length; i++) {
      const f = this.flames[i];
      const r = this.sockets.nozzleRadius[i] ?? 0.1;
      if (f) f.scale.set(r * (0.75 + k * 0.2), r * (0.75 + k * 0.2), r * (0.8 + k * 3.2));
      const g = this.glows[i];
      if (g) g.scale.setScalar(r * (2 + k * 1.6));
    }
  }

  /** World position of a muzzle socket. */
  muzzleWorld(i: number, out: Vector3): Vector3 {
    const list = this.sockets.muzzles;
    const m = list.length > 0 ? list[i % list.length] : undefined;
    if (!m) return out.copy(this.root.position);
    out.set(m[0], m[1], m[2]);
    return this.root.localToWorld(out);
  }

  nozzleWorld(i: number, out: Vector3): Vector3 {
    const n = this.sockets.nozzles[i];
    if (!n) return out.copy(this.root.position);
    out.set(n[0], n[1], n[2]);
    return this.root.localToWorld(out);
  }

  socketWorld(p: V3, out: Vector3): Vector3 {
    out.set(p[0], p[1], p[2]);
    return this.root.localToWorld(out);
  }

  /** True once a production GLB has been attached (see `GlbLibrary.apply`). */
  get hasGlb(): boolean {
    return this.glb !== null;
  }

  /**
   * Replace/augment the procedural high LOD with a loaded production GLB. Meshes named after a material
   * slot ("primary", "trim", …) are re-skinned with this ship's shared slot materials so palettes,
   * cosmetics and material overrides (cloak) behave exactly like the procedural mesh.
   */
  attachGlb(obj: Object3D, mode: "replace" | "augment" = "replace"): void {
    if (this.disposed || this.glb) return;
    this.glb = obj;
    obj.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh) return;
      const slot = m.name as MaterialSlot;
      if (MATERIAL_SLOTS.includes(slot)) {
        m.material = this.materials[slot];
        if (slot === "engine" || slot === "glow") m.castShadow = false;
      } else {
        m.userData.glbMaterial = m.material;
      }
    });
    const high = this.lod.levels[0]?.object;
    if (high && mode === "replace") {
      for (const c of high.children) c.visible = false;
    }
    // Fit the asset to the procedural bounds (same forward length, same centre).
    obj.position.set(0, 0, 0);
    obj.scale.setScalar(1);
    const box = new Box3().setFromObject(obj);
    const size = box.getSize(tmpV);
    const target = this.bounds.getSize(tmpV2);
    const s = size.z > 0 && target.z > 0 ? target.z / size.z : 1;
    obj.scale.setScalar(s);
    const c = box.getCenter(tmpV).multiplyScalar(s);
    obj.position.copy(this.bounds.getCenter(tmpV2)).sub(c);
    high?.add(obj);
  }

  /** Swap all mesh materials (e.g. cloak shimmer) or restore with null. */
  overrideMaterial(mat: Material | null): void {
    this.lod.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh) return;
      const slot = m.name as MaterialSlot;
      const own = m.userData.glbMaterial as Material | undefined;
      m.material = mat ?? own ?? this.materials[slot] ?? this.materials.trim;
    });
    for (const f of this.flames) f.visible = mat === null;
    for (const g of this.glows) g.visible = mat === null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root.removeFromParent();
    if (this.greebles) {
      this.greebles.dispose();
      this.greebles = null;
    }
    if (this.glb) {
      this.glb.removeFromParent();
      this.glb = null;
    }
    this.factory.release(this.set);
  }
}
