import {
  AdditiveBlending, BufferAttribute, BufferGeometry, DynamicDrawUsage, NormalBlending, Points, ShaderMaterial,
} from "three";

const VERT = /* glsl */ `
uniform float uTime;
uniform float uScale;
attribute vec3 aVel;
attribute vec3 aColor;
attribute vec4 aLife;   // x = spawn time, y = lifetime, z = drag, w = rise (upward accel)
attribute vec2 aSize;   // start, end
varying vec3 vColor;
varying float vT;
void main() {
  float age = uTime - aLife.x;
  float t = age / max(aLife.y, 0.0001);
  vT = t;
  vColor = aColor;
  if (t < 0.0 || t > 1.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }
  float drag = aLife.z;
  float k = drag > 0.0001 ? (1.0 - exp(-drag * age)) / drag : age;
  vec3 p = position + aVel * k + vec3(0.0, aLife.w * age * age * 0.5, 0.0);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float size = mix(aSize.x, aSize.y, t);
  gl_PointSize = size * uScale / max(0.1, -mv.z);
}`;

const FRAG_ADD = /* glsl */ `
varying vec3 vColor;
varying float vT;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c) * 2.0;
  float a = smoothstep(1.0, 0.0, d);
  a *= a;
  float fade = pow(1.0 - vT, 1.4);
  vec3 col = mix(vec3(1.0), vColor, smoothstep(0.0, 0.35, vT + d * 0.4));
  gl_FragColor = vec4(col * fade * 1.6, a * fade);
}`;

const FRAG_SMOKE = /* glsl */ `
varying vec3 vColor;
varying float vT;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c) * 2.0;
  float n = sin(c.x * 13.0 + vT * 4.0) * sin(c.y * 11.0 - vT * 3.0) * 0.12;
  float a = smoothstep(1.0, 0.2, d + n);
  float fade = smoothstep(0.0, 0.12, vT) * (1.0 - vT);
  gl_FragColor = vec4(vColor, a * fade * 0.55);
}`;

export type ParticleBlend = "additive" | "smoke";

/**
 * GPU-animated particle layer. Particles are written once into a ring buffer at
 * emit time; motion, fade and size are computed in the vertex shader, so the
 * per-frame CPU cost is a uniform update plus partial buffer uploads.
 */
export class ParticleLayer {
  readonly points: Points<BufferGeometry, ShaderMaterial>;
  private readonly capacity: number;
  private cursor = 0;
  private dirtyMin = Number.POSITIVE_INFINITY;
  private dirtyMax = -1;
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly col: Float32Array;
  private readonly life: Float32Array;
  private readonly size: Float32Array;
  private readonly attrs: BufferAttribute[];
  private budget: number;
  time = 0;

  constructor(capacity: number, blend: ParticleBlend) {
    this.capacity = capacity;
    this.budget = capacity;
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.col = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity * 4);
    this.size = new Float32Array(capacity * 2);
    for (let i = 0; i < capacity; i++) this.life[i * 4] = -1e6; // dead
    const g = new BufferGeometry();
    const mk = (arr: Float32Array, n: number): BufferAttribute => {
      const a = new BufferAttribute(arr, n);
      a.setUsage(DynamicDrawUsage);
      return a;
    };
    const aPos = mk(this.pos, 3), aVel = mk(this.vel, 3), aCol = mk(this.col, 3), aLife = mk(this.life, 4), aSize = mk(this.size, 2);
    g.setAttribute("position", aPos);
    g.setAttribute("aVel", aVel);
    g.setAttribute("aColor", aCol);
    g.setAttribute("aLife", aLife);
    g.setAttribute("aSize", aSize);
    this.attrs = [aPos, aVel, aCol, aLife, aSize];
    const mat = new ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uScale: { value: 300 } },
      vertexShader: VERT,
      fragmentShader: blend === "additive" ? FRAG_ADD : FRAG_SMOKE,
      transparent: true,
      depthWrite: false,
      blending: blend === "additive" ? AdditiveBlending : NormalBlending,
      toneMapped: blend !== "additive",
    });
    this.points = new Points(g, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = blend === "additive" ? 20 : 10;
  }

  /** Limit live particles (graphics tier). */
  setBudget(n: number): void {
    this.budget = Math.max(16, Math.min(this.capacity, n));
    if (this.cursor >= this.budget) this.cursor = 0;
  }

  /** Viewport height in px × projection factor, so point sizes are in world units. */
  setScale(viewportHeightPx: number, fovRad: number): void {
    const u = this.points.material.uniforms.uScale;
    if (u) u.value = viewportHeightPx / (2 * Math.tan(fovRad / 2));
  }

  emit(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    r: number, g: number, b: number,
    life: number, size0: number, size1: number, drag = 0, rise = 0,
  ): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.budget;
    const i3 = i * 3;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this.col[i3] = r; this.col[i3 + 1] = g; this.col[i3 + 2] = b;
    const i4 = i * 4;
    this.life[i4] = this.time; this.life[i4 + 1] = life; this.life[i4 + 2] = drag; this.life[i4 + 3] = rise;
    this.size[i * 2] = size0; this.size[i * 2 + 1] = size1;
    if (i < this.dirtyMin) this.dirtyMin = i;
    if (i > this.dirtyMax) this.dirtyMax = i;
  }

  update(time: number): void {
    this.time = time;
    const u = this.points.material.uniforms.uTime;
    if (u) u.value = time;
    if (this.dirtyMax < 0) return;
    const start = this.dirtyMin, count = this.dirtyMax - this.dirtyMin + 1;
    for (const a of this.attrs) {
      a.clearUpdateRanges();
      a.addUpdateRange(start * a.itemSize, count * a.itemSize);
      a.needsUpdate = true;
    }
    this.dirtyMin = Number.POSITIVE_INFINITY;
    this.dirtyMax = -1;
  }

  clear(): void {
    for (let i = 0; i < this.capacity; i++) this.life[i * 4] = -1e6;
    this.dirtyMin = 0;
    this.dirtyMax = this.capacity - 1;
  }

  dispose(): void {
    this.points.removeFromParent();
    this.points.geometry.dispose();
    this.points.material.dispose();
  }
}
