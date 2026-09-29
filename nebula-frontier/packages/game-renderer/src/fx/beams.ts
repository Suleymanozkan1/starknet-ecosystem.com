import type { BufferGeometry } from "three";
import {
  AdditiveBlending, Color, DoubleSide, Group, Mesh, PlaneGeometry, ShaderMaterial, type Vector3,
} from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { ObjectPool } from "../core/pool.js";
import { NOISE_GLSL } from "../core/glsl.js";

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uTime;
uniform float uOpacity;
uniform float uLength;
uniform float uStyle;
varying vec2 vUv;
${NOISE_GLSL}
void main() {
  float x = abs(vUv.x - 0.5) * 2.0;
  float along = vUv.y * uLength;
  float n = nf_noise(vec3(along * 1.4 - uTime * 18.0, x * 3.0, uTime * 3.0));
  float wobble = uStyle > 0.5 ? (n - 0.5) * 0.5 : (n - 0.5) * 0.15;
  float xx = clamp(x + wobble, 0.0, 1.0);
  float core = smoothstep(0.35, 0.0, xx);
  float glow = pow(1.0 - xx, 3.0);
  float ends = smoothstep(0.0, 0.03, vUv.y) * smoothstep(1.0, 0.97, vUv.y);
  float pulses = 0.85 + 0.15 * sin(along * 3.0 - uTime * 40.0);
  vec3 col = mix(uColor, vec3(1.0), core * 0.8);
  float a = (core + glow * 0.6) * ends * uOpacity * pulses;
  gl_FragColor = vec4(col * (1.5 + core), a);
}`;

export interface BeamHandle {
  set(from: Vector3, to: Vector3): void;
  release(): void;
}

class Beam {
  readonly mesh: Mesh<BufferGeometry, ShaderMaterial>;
  life = 0;
  maxLife = 0;
  persistent = false;
  width = 0.3;
  constructor(geo: BufferGeometry) {
    this.mesh = new Mesh(geo, new ShaderMaterial({
      uniforms: { uColor: { value: new Color() }, uTime: { value: 0 }, uOpacity: { value: 1 }, uLength: { value: 1 }, uStyle: { value: 0 } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
      toneMapped: false,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 15;
    this.mesh.visible = false;
  }
  place(from: Vector3, to: Vector3): void {
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const len = Math.max(0.001, Math.hypot(dx, dy, dz));
    this.mesh.position.copy(from);
    this.mesh.scale.set(this.width, this.width, len);
    this.mesh.lookAt(to);
    const u = this.mesh.material.uniforms.uLength;
    if (u) u.value = len;
  }
}

/** Pooled beam weapons, mining beams, laser lines. Geometry: crossed quads spanning local z 0..1. */
export class BeamSystem {
  readonly group = new Group();
  private readonly geo: BufferGeometry;
  private readonly pool: ObjectPool<Beam>;

  constructor(budget: number) {
    const a = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0, 0, 0.5);
    const b = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2).rotateZ(Math.PI / 2).translate(0, 0, 0.5);
    const merged = mergeGeometries([a, b]);
    a.dispose();
    b.dispose();
    if (!merged) throw new Error("beam geometry merge failed");
    this.geo = merged;
    this.pool = new ObjectPool<Beam>({
      max: budget,
      create: () => {
        const beam = new Beam(this.geo);
        this.group.add(beam.mesh);
        return beam;
      },
      reset: (beam) => { beam.mesh.visible = false; },
      dispose: (beam) => beam.mesh.material.dispose(),
    });
  }

  /** Short-lived beam flash (hitscan). */
  flash(from: Vector3, to: Vector3, color: string, width: number, duration: number, style: "laser" | "arc" = "laser"): void {
    const b = this.pool.acquire();
    if (!b) return;
    this.setup(b, color, width, style);
    b.persistent = false;
    b.life = b.maxLife = duration;
    b.place(from, to);
  }

  /** Continuous beam (mining / channelled) — caller updates endpoints and releases. */
  hold(color: string, width: number, style: "laser" | "arc" = "laser"): BeamHandle | null {
    const b = this.pool.acquire();
    if (!b) return null;
    this.setup(b, color, width, style);
    b.persistent = true;
    b.life = b.maxLife = 1;
    return {
      set: (from, to) => b.place(from, to),
      release: () => this.pool.release(b),
    };
  }

  private setup(b: Beam, color: string, width: number, style: "laser" | "arc"): void {
    const u = b.mesh.material.uniforms;
    (u.uColor?.value as Color).set(color);
    if (u.uStyle) u.uStyle.value = style === "arc" ? 1 : 0;
    if (u.uOpacity) u.uOpacity.value = 1;
    b.width = width;
    b.mesh.visible = true;
  }

  update(time: number, dt: number): void {
    this.pool.forEachActive((b) => {
      const u = b.mesh.material.uniforms;
      if (u.uTime) u.uTime.value = time;
      if (b.persistent) return;
      b.life -= dt;
      if (u.uOpacity) u.uOpacity.value = Math.max(0, b.life / b.maxLife);
      if (b.life <= 0) this.pool.release(b);
    });
  }

  setBudget(n: number): void {
    this.pool.setMax(n);
  }

  dispose(): void {
    this.pool.dispose();
    this.geo.dispose();
    this.group.removeFromParent();
  }
}
