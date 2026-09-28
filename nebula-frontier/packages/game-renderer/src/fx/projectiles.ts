import {
  AdditiveBlending, Color, DynamicDrawUsage, InstancedBufferAttribute, InstancedMesh, Matrix4, PlaneGeometry,
  Quaternion, ShaderMaterial, Vector3,
} from "three";

const VERT = /* glsl */ `
attribute vec4 aParams; // x = style, y = age01, z = seed
varying vec2 vUv;
varying vec3 vColor;
varying vec4 vParams;
void main() {
  vUv = vec2(uv.x, 1.0 - uv.y); // uv.y runs along +z (forward)
  vColor = instanceColor;
  vParams = aParams;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`;
const FRAG = /* glsl */ `
uniform float uTime;
varying vec2 vUv;
varying vec3 vColor;
varying vec4 vParams;
void main() {
  vec2 p = (vUv - 0.5) * 2.0;
  float style = vParams.x;
  float a;
  float core;
  if (style < 0.5) {            // bolt: capsule with hot core, tail fade
    float d = length(vec2(p.x, max(abs(p.y) - 0.55, 0.0) * 2.2));
    core = smoothstep(0.35, 0.0, d);
    a = smoothstep(1.0, 0.0, d) * (0.55 + 0.45 * smoothstep(-1.0, 0.4, p.y));
  } else if (style < 1.5) {     // slug: thin needle
    float d = abs(p.x) * 2.0 + max(abs(p.y) - 0.8, 0.0) * 5.0;
    core = smoothstep(0.4, 0.0, d);
    a = smoothstep(1.0, 0.0, d);
  } else if (style < 2.5) {     // wave: crescent arc
    float r = length(vec2(p.x, p.y + 0.9));
    float d = abs(r - 1.2) * 4.0 + max(abs(p.x) - 0.7, 0.0) * 3.0;
    core = smoothstep(0.5, 0.0, d);
    a = smoothstep(1.0, 0.0, d) * (0.7 + 0.3 * sin(uTime * 30.0 + vParams.z));
  } else {                      // orb (torpedo / mine)
    float d = length(p);
    core = smoothstep(0.35, 0.0, d);
    a = smoothstep(1.0, 0.0, d) * (0.75 + 0.25 * sin(uTime * 14.0 + vParams.z * 6.0));
  }
  vec3 col = mix(vColor * 1.8, vec3(1.0), core * 0.85);
  gl_FragColor = vec4(col, a);
}`;

export const ProjectileStyle = { BOLT: 0, SLUG: 1, WAVE: 2, ORB: 3, MISSILE: 4 } as const;
export type ProjectileStyle = (typeof ProjectileStyle)[keyof typeof ProjectileStyle];

interface Projectile {
  active: boolean;
  style: ProjectileStyle;
  fromX: number; fromY: number; fromZ: number;
  toX: number; toY: number; toZ: number;
  start: number; dur: number;
  length: number; width: number;
  r: number; g: number; b: number;
  seed: number;
  arc: number;
  hit: boolean;
}

export interface ProjectileImpact {
  x: number; y: number; z: number;
  r: number; g: number; b: number;
  style: ProjectileStyle;
  hit: boolean;
}

const tmpM = new Matrix4();
const tmpQ = new Quaternion();
const tmpS = new Vector3();
const tmpP = new Vector3();
const UP = new Vector3(0, 1, 0);
const tmpC = new Color();

/**
 * Instanced projectile renderer (bolts, slugs, waves, torpedoes, missiles).
 * Fixed-capacity slot array; flat quads facing up (top-down camera).
 */
export class ProjectileSystem {
  readonly mesh: InstancedMesh<PlaneGeometry, ShaderMaterial>;
  private readonly slots: Projectile[] = [];
  private readonly params: InstancedBufferAttribute;
  private live = 0;
  private budget: number;
  private readonly impact: ProjectileImpact = { x: 0, y: 0, z: 0, r: 0, g: 0, b: 0, style: 0, hit: false };
  onImpact: ((i: ProjectileImpact) => void) | null = null;
  /** Called every frame for each live missile/torpedo (trail emission). */
  onFlight: ((x: number, y: number, z: number, dirX: number, dirZ: number, style: ProjectileStyle, r: number, g: number, b: number) => void) | null = null;

  constructor(capacity: number) {
    const geo = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    // plane uv.y should run along +z (forward)
    const mat = new ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      toneMapped: false,
    });
    this.mesh = new InstancedMesh(geo, mat, capacity);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.setColorAt(0, tmpC.set(1, 1, 1));
    if (this.mesh.instanceColor) this.mesh.instanceColor.setUsage(DynamicDrawUsage);
    this.params = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.params.setUsage(DynamicDrawUsage);
    geo.setAttribute("aParams", this.params);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 16;
    this.budget = capacity;
    for (let i = 0; i < capacity; i++) {
      this.slots.push({
        active: false, style: 0, fromX: 0, fromY: 0, fromZ: 0, toX: 0, toY: 0, toZ: 0, start: 0, dur: 1,
        length: 1, width: 0.3, r: 1, g: 1, b: 1, seed: 0, arc: 0, hit: true,
      });
    }
  }

  setBudget(n: number): void {
    this.budget = Math.max(8, Math.min(this.slots.length, n));
  }

  get active(): number {
    return this.live;
  }

  spawn(
    from: Vector3, to: Vector3, color: string, style: ProjectileStyle, durationS: number, now: number, hit = true,
  ): boolean {
    if (this.live >= this.budget) return false;
    let slot: Projectile | undefined;
    for (let i = 0; i < this.budget; i++) {
      const s = this.slots[i];
      if (s && !s.active) { slot = s; break; }
    }
    if (!slot) return false;
    tmpC.set(color);
    slot.active = true;
    slot.style = style;
    slot.fromX = from.x; slot.fromY = from.y; slot.fromZ = from.z;
    slot.toX = to.x; slot.toY = to.y; slot.toZ = to.z;
    slot.start = now;
    slot.dur = Math.max(0.03, durationS);
    slot.r = tmpC.r; slot.g = tmpC.g; slot.b = tmpC.b;
    slot.seed = Math.random() * 10;
    slot.hit = hit;
    switch (style) {
      case ProjectileStyle.BOLT: slot.length = 1.9; slot.width = 0.42; slot.arc = 0; break;
      case ProjectileStyle.SLUG: slot.length = 3.6; slot.width = 0.2; slot.arc = 0; break;
      case ProjectileStyle.WAVE: slot.length = 1.0; slot.width = 2.0; slot.arc = 0; break;
      case ProjectileStyle.ORB: slot.length = 1.3; slot.width = 1.3; slot.arc = 0; break;
      case ProjectileStyle.MISSILE: slot.length = 0.9; slot.width = 0.45; slot.arc = (Math.random() - 0.5) * 6; break;
    }
    this.live++;
    return true;
  }

  update(now: number): void {
    const u = this.mesh.material.uniforms.uTime;
    if (u) u.value = now;
    let n = 0;
    const colors = this.mesh.instanceColor;
    const pa = this.params.array as Float32Array;
    for (let i = 0; i < this.budget; i++) {
      const s = this.slots[i];
      if (!s || !s.active) continue;
      const t = (now - s.start) / s.dur;
      if (t >= 1) {
        s.active = false;
        this.live--;
        if (this.onImpact) {
          const im = this.impact;
          im.x = s.toX; im.y = s.toY; im.z = s.toZ; im.r = s.r; im.g = s.g; im.b = s.b; im.style = s.style; im.hit = s.hit;
          this.onImpact(im);
        }
        continue;
      }
      const tt = Math.max(0, t);
      let x = s.fromX + (s.toX - s.fromX) * tt;
      const y = s.fromY + (s.toY - s.fromY) * tt;
      let z = s.fromZ + (s.toZ - s.fromZ) * tt;
      let dx = s.toX - s.fromX, dz = s.toZ - s.fromZ;
      if (s.arc !== 0) {
        // curved missile path: perpendicular offset peaking mid-flight
        const len = Math.hypot(dx, dz) || 1;
        const off = Math.sin(tt * Math.PI) * s.arc;
        const d = Math.cos(tt * Math.PI) * s.arc * Math.PI / len;
        x += (-dz / len) * off;
        z += (dx / len) * off;
        const ndx = dx + (-dz) * d, ndz = dz + dx * d;
        dx = ndx; dz = ndz;
      }
      const ang = Math.atan2(dx, dz);
      tmpQ.setFromAxisAngle(UP, ang);
      tmpS.set(s.width, 1, s.length);
      tmpP.set(x, y, z);
      tmpM.compose(tmpP, tmpQ, tmpS);
      this.mesh.setMatrixAt(n, tmpM);
      if (colors) {
        const ca = colors.array as Float32Array;
        ca[n * 3] = s.r; ca[n * 3 + 1] = s.g; ca[n * 3 + 2] = s.b;
      }
      const vis = s.style === ProjectileStyle.MISSILE ? ProjectileStyle.BOLT : s.style;
      pa[n * 4] = vis; pa[n * 4 + 1] = tt; pa[n * 4 + 2] = s.seed; pa[n * 4 + 3] = 0;
      if (this.onFlight && (s.style === ProjectileStyle.MISSILE || s.style === ProjectileStyle.ORB)) {
        const l = Math.hypot(dx, dz) || 1;
        this.onFlight(x, y, z, dx / l, dz / l, s.style, s.r, s.g, s.b);
      }
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (colors) colors.needsUpdate = true;
    this.params.needsUpdate = true;
  }

  clear(): void {
    for (const s of this.slots) s.active = false;
    this.live = 0;
    this.mesh.count = 0;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.dispose();
  }
}
