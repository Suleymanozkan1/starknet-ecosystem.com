import {
  AdditiveBlending, BufferAttribute, BufferGeometry, Color, DynamicDrawUsage, Group, Mesh, ShaderMaterial, type Vector3,
} from "three";
import { ObjectPool } from "../core/pool.js";

const VERT = /* glsl */ `
attribute float aT;
attribute float aSide;
varying float vT;
varying float vSide;
void main() {
  vT = aT;
  vSide = aSide;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uColor2;
uniform float uOpacity;
uniform float uTime;
uniform float uStyle;
varying float vT;
varying float vSide;
void main() {
  float edge = 1.0 - abs(vSide);
  float core = pow(edge, 2.5);
  float fade = pow(1.0 - vT, 1.8);
  vec3 col = mix(uColor, uColor2, vT);
  float sparkle = 1.0;
  if (uStyle > 0.5 && uStyle < 1.5) { // stardust
    sparkle = 0.6 + 0.8 * step(0.82, fract(sin(floor(vT * 60.0 - uTime * 4.0) * 91.7 + vSide * 3.0) * 4375.5));
  } else if (uStyle > 1.5) { // void tear
    col = mix(col, vec3(0.0), 0.35 * sin(vT * 30.0 - uTime * 6.0));
  }
  gl_FragColor = vec4(col * (0.6 + core * 1.8) * sparkle, (core * 0.9 + edge * 0.25) * fade * uOpacity);
}`;

export interface TrailStyle {
  color: string;
  color2?: string;
  width: number;
  /** "", "stardust", "void_tear", "aurora_ribbon" */
  effect?: string;
}

/** One ribbon trail. Positions are rewritten each frame from a fixed-size history (no allocation). */
export class Trail {
  readonly mesh: Mesh<BufferGeometry, ShaderMaterial>;
  private readonly n: number;
  private readonly hist: Float32Array;
  private count = 0;
  private head = 0;
  private width = 0.3;
  private readonly posAttr: BufferAttribute;
  active = false;
  /** When > 0, trail is fading out after release. */
  fading = 0;
  private minDist2 = 0.04;

  constructor(segments: number) {
    this.n = segments;
    this.hist = new Float32Array(segments * 3);
    const g = new BufferGeometry();
    const pos = new Float32Array(segments * 2 * 3);
    const t = new Float32Array(segments * 2);
    const side = new Float32Array(segments * 2);
    const idx: number[] = [];
    for (let i = 0; i < segments; i++) {
      t[i * 2] = t[i * 2 + 1] = i / (segments - 1);
      side[i * 2] = -1;
      side[i * 2 + 1] = 1;
      if (i < segments - 1) {
        const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
        idx.push(a, c, b, b, c, d);
      }
    }
    this.posAttr = new BufferAttribute(pos, 3);
    this.posAttr.setUsage(DynamicDrawUsage);
    g.setAttribute("position", this.posAttr);
    g.setAttribute("aT", new BufferAttribute(t, 1));
    g.setAttribute("aSide", new BufferAttribute(side, 1));
    g.setIndex(idx);
    const mat = new ShaderMaterial({
      uniforms: {
        uColor: { value: new Color() }, uColor2: { value: new Color() }, uOpacity: { value: 1 }, uTime: { value: 0 }, uStyle: { value: 0 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: 2,
      toneMapped: false,
    });
    this.mesh = new Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.visible = false;
  }

  start(style: TrailStyle, at: Vector3): void {
    const u = this.mesh.material.uniforms;
    (u.uColor?.value as Color).set(style.color);
    (u.uColor2?.value as Color).set(style.color2 ?? style.color);
    if (u.uStyle) u.uStyle.value = style.effect === "stardust" ? 1 : style.effect === "void_tear" ? 2 : 0;
    if (u.uOpacity) u.uOpacity.value = 1;
    this.width = style.width;
    this.minDist2 = (style.width * 0.35) ** 2;
    this.count = 0;
    this.head = 0;
    this.fading = 0;
    this.active = true;
    this.push(at.x, at.y, at.z);
    this.mesh.visible = true;
  }

  private push(x: number, y: number, z: number): void {
    this.head = (this.head + 1) % this.n;
    const i = this.head * 3;
    this.hist[i] = x; this.hist[i + 1] = y; this.hist[i + 2] = z;
    if (this.count < this.n) this.count++;
  }

  /** Feed the current head position. */
  setHead(p: Vector3): void {
    const i = this.head * 3;
    const dx = p.x - (this.hist[i] ?? 0), dy = p.y - (this.hist[i + 1] ?? 0), dz = p.z - (this.hist[i + 2] ?? 0);
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > 400) {
      // teleport: restart history
      this.count = 0;
      this.push(p.x, p.y, p.z);
      return;
    }
    if (d2 >= this.minDist2 || this.count < 2) this.push(p.x, p.y, p.z);
    else {
      this.hist[i] = p.x; this.hist[i + 1] = p.y; this.hist[i + 2] = p.z;
    }
  }

  update(time: number, dt: number): void {
    const u = this.mesh.material.uniforms;
    if (u.uTime) u.uTime.value = time;
    if (this.fading > 0) {
      this.fading -= dt;
      if (u.uOpacity) u.uOpacity.value = Math.max(0, this.fading / 0.6);
      // shrink from the tail
      if (this.count > 1) this.count--;
    }
    const pos = this.posAttr.array as Float32Array;
    const n = this.n;
    let px = 0, pz = 0;
    for (let k = 0; k < n; k++) {
      const kk = Math.min(k, Math.max(0, this.count - 1));
      const hi = ((this.head - kk + n) % n) * 3;
      const x = this.hist[hi] ?? 0, y = this.hist[hi + 1] ?? 0, z = this.hist[hi + 2] ?? 0;
      // direction to the next (older) point
      const kn = Math.min(kk + 1, Math.max(0, this.count - 1));
      const ni = ((this.head - kn + n) % n) * 3;
      let dx = (this.hist[ni] ?? x) - x, dz = (this.hist[ni + 2] ?? z) - z;
      let len = Math.hypot(dx, dz);
      if (len < 1e-5) { dx = px; dz = pz; len = Math.hypot(dx, dz) || 1; }
      px = dx; pz = dz;
      const w = this.width * (1 - k / n) * 0.5;
      const sx = (-dz / len) * w, sz = (dx / len) * w;
      const o = k * 6;
      pos[o] = x + sx; pos[o + 1] = y; pos[o + 2] = z + sz;
      pos[o + 3] = x - sx; pos[o + 4] = y; pos[o + 5] = z - sz;
    }
    this.posAttr.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

/** Pool of ribbon trails. */
export class TrailSystem {
  readonly group = new Group();
  private readonly pool: ObjectPool<Trail>;
  private readonly fadingList: Trail[] = [];

  constructor(budget: number, segments: number) {
    this.pool = new ObjectPool<Trail>({
      max: budget,
      create: () => {
        const t = new Trail(segments);
        this.group.add(t.mesh);
        return t;
      },
      reset: (t) => {
        t.active = false;
        t.mesh.visible = false;
      },
      dispose: (t) => t.dispose(),
    });
  }

  acquire(style: TrailStyle, at: Vector3): Trail | null {
    const t = this.pool.acquire();
    if (!t) return null;
    t.start(style, at);
    return t;
  }

  /** Release: the trail fades out, then returns to the pool. */
  release(t: Trail): void {
    if (!t.active || t.fading > 0) return;
    t.fading = 0.6;
    this.fadingList.push(t);
  }

  setBudget(n: number): void {
    this.pool.setMax(n);
  }

  update(time: number, dt: number): void {
    this.pool.forEachActive((t) => t.update(time, dt));
    for (let i = this.fadingList.length - 1; i >= 0; i--) {
      const t = this.fadingList[i];
      if (!t) continue;
      if (t.fading <= 0) {
        this.fadingList.splice(i, 1);
        this.pool.release(t);
      }
    }
  }

  get active(): number {
    return this.pool.active;
  }

  dispose(): void {
    this.pool.dispose();
    this.fadingList.length = 0;
    this.group.removeFromParent();
  }
}
