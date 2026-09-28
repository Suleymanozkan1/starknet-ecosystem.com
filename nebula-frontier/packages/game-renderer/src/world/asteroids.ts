import {
  BufferAttribute, type BufferGeometry, Color, DynamicDrawUsage, Group, IcosahedronGeometry, InstancedMesh, Matrix4,
  MeshStandardMaterial, Quaternion, Vector3, Euler,
} from "three";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import type { ResourceId } from "@nebula/shared";
import { fbm3, createRng } from "../core/random.js";

export const RESOURCE_COLORS: Readonly<Record<ResourceId, string>> = {
  TITANIUM: "#c9d6ea",
  PLASMA_ORE: "#ff4fd8",
  DARK_MATTER: "#9d4edd",
  QUANTUM_SHARD: "#4cc9f0",
  CRYONITE: "#9bf6ff",
  AETHER_CRYSTAL: "#ffd166",
  VOID_ESSENCE: "#c77dff",
};

/** Noise-displaced icosahedron with baked vertex colours (rock vs mineral veins). */
export function createAsteroidGeometry(detail: number, seed: number): BufferGeometry {
  let g: BufferGeometry = new IcosahedronGeometry(1, Math.max(1, detail));
  g.deleteAttribute("normal");
  g.deleteAttribute("uv");
  g = mergeVertices(g);
  const pos = g.attributes.position;
  if (!pos) return g;
  const colors = new Float32Array(pos.count * 3);
  const rng = createRng(seed);
  const sx = rng.range(0.75, 1.25), sy = rng.range(0.6, 0.95), sz = rng.range(0.8, 1.3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const n = fbm3(x * 1.6 + seed, y * 1.6, z * 1.6, 4, seed);
    const fine = fbm3(x * 6.5, y * 6.5, z * 6.5 + seed, 2, seed + 7);
    const crater = Math.max(0, fbm3(x * 3.1, y * 3.1 + seed, z * 3.1, 2, seed + 3) - 0.6) * 1.6;
    const r = 0.7 + n * 0.6 - crater + (fine - 0.5) * 0.12;
    pos.setXYZ(i, x * r * sx, y * r * sy, z * r * sz);
    const vein = fbm3(x * 5.5, y * 5.5, z * 5.5 + seed, 3, seed + 11) > 0.66 ? 1 : 0;
    const base = 0.1 + n * 0.1 + crater * 0.05;
    colors[i * 3] = vein ? 1 : base;
    colors[i * 3 + 1] = vein ? 1 : base;
    colors[i * 3 + 2] = vein ? 1 : base * 1.05;
  }
  g.setAttribute("color", new BufferAttribute(colors, 3));
  g = g.toNonIndexed();
  g.computeVertexNormals();
  return g;
}

interface Slot { variant: number; index: number; x: number; y: number; z: number; r: number; spin: number; phase: number; tilt: number }

const tmpM = new Matrix4();
const tmpQ = new Quaternion();
const tmpE = new Euler();
const tmpP = new Vector3();
const tmpS = new Vector3();
const tmpC = new Color();
const ZERO = new Matrix4().makeScale(0, 0, 0);

/**
 * Instanced asteroids: a few shared rock variants, per-instance tint by resource,
 * glowing mineral veins (vertex colours → emissive), slow tumbling.
 */
export class AsteroidLayer {
  readonly group = new Group();
  private readonly geos: BufferGeometry[] = [];
  private readonly meshes: InstancedMesh[] = [];
  private readonly material: MeshStandardMaterial;
  private readonly slots = new Map<string, Slot>();
  private readonly free: number[][] = [];
  private readonly capacity: number;
  private readonly idsByVariant: (string | null)[][] = [];

  constructor(capacityPerVariant: number, detail: number, variants = 4) {
    this.capacity = capacityPerVariant;
    this.material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0.05, flatShading: true, envMapIntensity: 0.3 });
    this.material.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <emissivemap_fragment>",
        "#include <emissivemap_fragment>\n#ifdef USE_COLOR\n totalEmissiveRadiance += max(vColor.rgb - vec3(0.3), vec3(0.0)) * 1.1;\n#endif",
      );
    };
    for (let v = 0; v < variants; v++) {
      const g = createAsteroidGeometry(detail, 17 + v * 31);
      this.geos.push(g);
      const m = new InstancedMesh(g, this.material, capacityPerVariant);
      m.instanceMatrix.setUsage(DynamicDrawUsage);
      for (let i = 0; i < capacityPerVariant; i++) m.setMatrixAt(i, ZERO);
      m.setColorAt(0, tmpC.set(1, 1, 1));
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      this.meshes.push(m);
      this.group.add(m);
      const f: number[] = [];
      for (let i = capacityPerVariant - 1; i >= 0; i--) f.push(i);
      this.free.push(f);
      this.idsByVariant.push(new Array<string | null>(capacityPerVariant).fill(null));
    }
  }

  has(id: string): boolean {
    return this.slots.has(id);
  }

  add(id: string, x: number, y: number, z: number, radius: number, resource: ResourceId | string | null): boolean {
    if (this.slots.has(id)) return true;
    const rng = createRng(id);
    const variant = rng.int(0, this.meshes.length - 1);
    const index = this.free[variant]?.pop();
    if (index === undefined) return false;
    const slot: Slot = { variant, index, x, y, z, r: radius, spin: rng.range(0.05, 0.35) * rng.sign(), phase: rng.range(0, 6), tilt: rng.range(0, 3) };
    this.slots.set(id, slot);
    const ids = this.idsByVariant[variant];
    if (ids) ids[index] = id;
    const mesh = this.meshes[variant];
    if (mesh) {
      const col = resource && resource in RESOURCE_COLORS ? RESOURCE_COLORS[resource as ResourceId] : "#8d99ae";
      mesh.setColorAt(index, tmpC.set(col));
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    this.write(slot, 0);
    return true;
  }

  setPosition(id: string, x: number, y: number, z: number): void {
    const s = this.slots.get(id);
    if (!s) return;
    s.x = x; s.y = y; s.z = z;
  }

  get(id: string): { x: number; y: number; z: number; r: number } | undefined {
    return this.slots.get(id);
  }

  remove(id: string): void {
    const s = this.slots.get(id);
    if (!s) return;
    this.slots.delete(id);
    const mesh = this.meshes[s.variant];
    mesh?.setMatrixAt(s.index, ZERO);
    if (mesh) mesh.instanceMatrix.needsUpdate = true;
    this.free[s.variant]?.push(s.index);
    const ids = this.idsByVariant[s.variant];
    if (ids) ids[s.index] = null;
  }

  clear(): void {
    for (const id of [...this.slots.keys()]) this.remove(id);
  }

  private write(s: Slot, time: number): void {
    tmpE.set(s.tilt, s.phase + time * s.spin, s.tilt * 0.5);
    tmpQ.setFromEuler(tmpE);
    tmpP.set(s.x, s.y, s.z);
    tmpS.setScalar(s.r);
    tmpM.compose(tmpP, tmpQ, tmpS);
    const mesh = this.meshes[s.variant];
    mesh?.setMatrixAt(s.index, tmpM);
  }

  update(time: number): void {
    if (this.slots.size === 0) return;
    for (const s of this.slots.values()) this.write(s, time);
    for (const m of this.meshes) m.instanceMatrix.needsUpdate = true;
  }

  get count(): number {
    return this.slots.size;
  }

  get maxCapacity(): number {
    return this.capacity * this.meshes.length;
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const m of this.meshes) m.dispose();
    for (const g of this.geos) g.dispose();
    this.material.dispose();
    this.slots.clear();
  }
}
