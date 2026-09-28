import {
  Color, DynamicDrawUsage, InstancedMesh, Matrix4, MeshStandardMaterial, Quaternion, TetrahedronGeometry, Vector3, Euler,
} from "three";
import type { Rng } from "../core/random.js";

const tmpM = new Matrix4();
const tmpQ = new Quaternion();
const tmpE = new Euler();
const tmpP = new Vector3();
const tmpS = new Vector3();
const tmpC = new Color();
const ZERO = new Matrix4().makeScale(0, 0, 0);

/** Tumbling hull shards for explosions & asteroid chips (instanced, fixed slots). */
export class DebrisSystem {
  readonly mesh: InstancedMesh<TetrahedronGeometry, MeshStandardMaterial>;
  private readonly cap: number;
  private readonly data: Float32Array; // per shard: px,py,pz, vx,vy,vz, rx,ry,rz, wx,wy,wz, life, maxLife, scale, _
  private cursor = 0;
  private liveCount = 0;
  private budget: number;

  constructor(capacity: number) {
    this.cap = capacity;
    this.budget = capacity;
    this.data = new Float32Array(capacity * 16);
    const mat = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, metalness: 0.7, emissive: new Color("#ff6a1a"), emissiveIntensity: 0.6 });
    this.mesh = new InstancedMesh(new TetrahedronGeometry(1, 0), mat, capacity);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    for (let i = 0; i < capacity; i++) this.mesh.setMatrixAt(i, ZERO);
    this.mesh.setColorAt(0, tmpC.set(1, 1, 1));
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
  }

  setBudget(n: number): void {
    this.budget = Math.max(8, Math.min(this.cap, n));
    if (this.cursor >= this.budget) this.cursor = 0;
  }

  burst(x: number, y: number, z: number, count: number, speed: number, size: number, color: string, rng: Rng, life = 2.2): void {
    tmpC.set(color);
    for (let k = 0; k < count; k++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.budget;
      const o = i * 16;
      const a = rng() * Math.PI * 2;
      const sp = speed * (0.35 + rng() * 0.9);
      this.data[o] = x; this.data[o + 1] = y; this.data[o + 2] = z;
      this.data[o + 3] = Math.cos(a) * sp; this.data[o + 4] = (rng() - 0.3) * sp * 0.4; this.data[o + 5] = Math.sin(a) * sp;
      this.data[o + 6] = rng() * 6; this.data[o + 7] = rng() * 6; this.data[o + 8] = rng() * 6;
      this.data[o + 9] = (rng() - 0.5) * 10; this.data[o + 10] = (rng() - 0.5) * 10; this.data[o + 11] = (rng() - 0.5) * 10;
      this.data[o + 12] = life * (0.6 + rng() * 0.6);
      this.data[o + 13] = this.data[o + 12] ?? life;
      this.data[o + 14] = size * (0.4 + rng() * 0.9);
      this.mesh.setColorAt(i, tmpC);
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.liveCount = Math.min(this.budget, this.liveCount + count);
  }

  update(dt: number): void {
    if (this.liveCount <= 0) return;
    let alive = 0;
    const d = this.data;
    for (let i = 0; i < this.budget; i++) {
      const o = i * 16;
      let life = d[o + 12] ?? 0;
      if (life <= 0) continue;
      life -= dt;
      d[o + 12] = life;
      if (life <= 0) {
        this.mesh.setMatrixAt(i, ZERO);
        continue;
      }
      alive++;
      const drag = Math.exp(-0.6 * dt);
      d[o + 3] = (d[o + 3] ?? 0) * drag; d[o + 4] = (d[o + 4] ?? 0) * drag; d[o + 5] = (d[o + 5] ?? 0) * drag;
      d[o] = (d[o] ?? 0) + (d[o + 3] ?? 0) * dt;
      d[o + 1] = (d[o + 1] ?? 0) + (d[o + 4] ?? 0) * dt;
      d[o + 2] = (d[o + 2] ?? 0) + (d[o + 5] ?? 0) * dt;
      d[o + 6] = (d[o + 6] ?? 0) + (d[o + 9] ?? 0) * dt;
      d[o + 7] = (d[o + 7] ?? 0) + (d[o + 10] ?? 0) * dt;
      d[o + 8] = (d[o + 8] ?? 0) + (d[o + 11] ?? 0) * dt;
      const k = Math.min(1, life / Math.max(0.001, (d[o + 13] ?? 1) * 0.3));
      const s = (d[o + 14] ?? 1) * k;
      tmpE.set(d[o + 6] ?? 0, d[o + 7] ?? 0, d[o + 8] ?? 0);
      tmpQ.setFromEuler(tmpE);
      tmpP.set(d[o] ?? 0, d[o + 1] ?? 0, d[o + 2] ?? 0);
      tmpS.set(s, s * 0.5, s * 1.4);
      tmpM.compose(tmpP, tmpQ, tmpS);
      this.mesh.setMatrixAt(i, tmpM);
    }
    this.liveCount = alive;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear(): void {
    for (let i = 0; i < this.cap; i++) {
      this.data[i * 16 + 12] = 0;
      this.mesh.setMatrixAt(i, ZERO);
    }
    this.liveCount = 0;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.dispose();
  }
}
