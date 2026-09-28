import {
  AdditiveBlending, Color, DoubleSide, Group, Mesh, NormalBlending, PlaneGeometry, ShaderMaterial,
} from "three";
import { ObjectPool } from "../core/pool.js";

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uP;        // progress 0..1
uniform float uKind;     // 0 shockwave, 1 telegraph, 2 pulse, 3 warp flash, 4 portal-ring flash
uniform float uThick;
uniform float uTime;
uniform float uOpacity;
varying vec2 vUv;
void main() {
  vec2 p = (vUv - 0.5) * 2.0;
  float r = length(p);
  float a = 0.0;
  vec3 col = uColor;
  if (uKind < 0.5) {
    float w = uThick * (1.0 - uP * 0.6);
    float ring = smoothstep(w, 0.0, abs(r - uP));
    float inner = smoothstep(uP, 0.0, r) * 0.25 * (1.0 - uP);
    a = (ring + inner) * (1.0 - uP);
    col = mix(uColor, vec3(1.0), ring * 0.5);
  } else if (uKind < 1.5) {
    float edge = smoothstep(0.03, 0.0, abs(r - 0.97));
    float fill = step(r, uP) * 0.28;
    float front = smoothstep(0.04, 0.0, abs(r - uP)) * 0.9;
    float stripes = step(0.5, fract((p.x + p.y) * 6.0 - uTime * 1.5)) * 0.12 * step(r, 1.0);
    float pulse = 0.65 + 0.35 * sin(uTime * (8.0 + uP * 20.0));
    a = (edge * pulse + fill + front + stripes) * step(r, 1.0);
  } else if (uKind < 2.5) {
    float ring = smoothstep(uThick, 0.0, abs(r - uP)) ;
    float glow = smoothstep(1.0, 0.0, r) * 0.25 * (1.0 - uP);
    a = (ring * 0.9 + glow) * (1.0 - uP);
  } else {
    float ring = smoothstep(uThick * 2.0, 0.0, abs(r - uP * 0.9));
    float core = smoothstep(0.5 * (1.0 - uP), 0.0, r);
    a = (ring + core) * (1.0 - uP);
    col = mix(uColor, vec3(1.0), core);
  }
  gl_FragColor = vec4(col * 1.6, clamp(a * uOpacity, 0.0, 1.0));
}`;

export const RingKind = { SHOCKWAVE: 0, TELEGRAPH: 1, PULSE: 2, FLASH: 3 } as const;
export type RingKind = (typeof RingKind)[keyof typeof RingKind];

class Ring {
  readonly mesh: Mesh<PlaneGeometry, ShaderMaterial>;
  life = 0;
  dur = 1;
  kind: RingKind = 0;
  onDone: (() => void) | null = null;
  constructor(geo: PlaneGeometry) {
    this.mesh = new Mesh(geo, new ShaderMaterial({
      uniforms: {
        uColor: { value: new Color() }, uP: { value: 0 }, uKind: { value: 0 }, uThick: { value: 0.08 }, uTime: { value: 0 },
        uOpacity: { value: 1 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      toneMapped: false,
    }));
    this.mesh.visible = false;
    this.mesh.renderOrder = 12;
    this.mesh.frustumCulled = false;
  }
}

/** Expanding rings: EMP / shockwaves / heal pulses / warp flashes, plus boss attack telegraphs (ground AoE). */
export class RingSystem {
  readonly group = new Group();
  private readonly geo = new PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
  private readonly pool: ObjectPool<Ring>;

  constructor(budget: number) {
    this.pool = new ObjectPool<Ring>({
      max: budget,
      create: () => {
        const r = new Ring(this.geo);
        this.group.add(r.mesh);
        return r;
      },
      reset: (r) => { r.mesh.visible = false; r.onDone = null; },
      dispose: (r) => r.mesh.material.dispose(),
    });
  }

  spawn(kind: RingKind, x: number, y: number, z: number, radius: number, color: string, duration: number, thickness = 0.08, onDone?: () => void): void {
    const r = this.pool.acquire();
    if (!r) return;
    r.kind = kind;
    r.life = 0;
    r.dur = Math.max(0.05, duration);
    r.onDone = onDone ?? null;
    const m = r.mesh;
    m.position.set(x, y, z);
    m.scale.setScalar(radius);
    const u = m.material.uniforms;
    (u.uColor?.value as Color).set(color);
    if (u.uKind) u.uKind.value = kind;
    if (u.uThick) u.uThick.value = thickness;
    if (u.uP) u.uP.value = 0;
    m.material.blending = kind === RingKind.TELEGRAPH ? NormalBlending : AdditiveBlending;
    m.visible = true;
  }

  update(time: number, dt: number): void {
    this.pool.forEachActive((r) => {
      r.life += dt;
      const p = Math.min(1, r.life / r.dur);
      const u = r.mesh.material.uniforms;
      if (u.uP) u.uP.value = r.kind === RingKind.TELEGRAPH ? p : 1 - Math.pow(1 - p, 2.2);
      if (u.uTime) u.uTime.value = time;
      if (p >= 1) {
        const cb = r.onDone;
        this.pool.release(r);
        cb?.();
      }
    });
  }

  dispose(): void {
    this.pool.dispose();
    this.geo.dispose();
    this.group.removeFromParent();
  }
}
