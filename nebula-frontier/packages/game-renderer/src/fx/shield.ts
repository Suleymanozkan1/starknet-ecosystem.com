import {
  AdditiveBlending, Color, FrontSide, Group, IcosahedronGeometry, Mesh, type Object3D, ShaderMaterial, Vector3, Vector4,
} from "three";
import { ObjectPool } from "../core/pool.js";

const VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vView;
varying vec3 vLocal;
void main() {
  vLocal = normalize(position);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vN = normalize(mat3(modelMatrix) * normal);
  vView = normalize(cameraPosition - wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uTime;
uniform float uOpacity;
uniform float uHex;
uniform vec4 uHits[4];
varying vec3 vN;
varying vec3 vView;
varying vec3 vLocal;
float hexGrid(vec2 p) {
  p *= 6.0;
  vec2 r = vec2(1.0, 1.732);
  vec2 h = r * 0.5;
  vec2 a = mod(p, r) - h;
  vec2 b = mod(p - h, r) - h;
  vec2 g = dot(a, a) < dot(b, b) ? a : b;
  return smoothstep(0.38, 0.5, max(abs(g.x) * 0.866 + abs(g.y) * 0.5, abs(g.y)));
}
void main() {
  float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vView))), 2.2);
  float ripple = 0.0;
  for (int i = 0; i < 4; i++) {
    vec4 h = uHits[i];
    float age = uTime - h.w;
    if (age < 0.0 || age > 0.9) continue;
    float d = distance(vLocal, normalize(h.xyz));
    float wave = smoothstep(0.12, 0.0, abs(d - age * 2.2)) * (1.0 - age / 0.9);
    float flash = smoothstep(0.5, 0.0, d) * max(0.0, 1.0 - age * 5.0);
    ripple += wave * 1.4 + flash * 1.5;
  }
  float hex = uHex > 0.5 ? hexGrid(vec2(atan(vLocal.z, vLocal.x), vLocal.y * 1.6)) * (0.25 + ripple) : 0.0;
  float shimmer = 0.9 + 0.1 * sin(uTime * 3.0 + vLocal.y * 12.0);
  float a = (fres * 0.75 * shimmer + ripple + hex * 0.6) * uOpacity;
  gl_FragColor = vec4(uColor * (1.2 + ripple), clamp(a, 0.0, 1.0));
}`;

class Bubble {
  readonly mesh: Mesh<IcosahedronGeometry, ShaderMaterial>;
  target: Object3D | null = null;
  hitIndex = 0;
  visibleFor = 0;
  level = 1;
  persistent = false;
  constructor(geo: IcosahedronGeometry) {
    this.mesh = new Mesh(geo, new ShaderMaterial({
      uniforms: {
        uColor: { value: new Color() }, uTime: { value: 0 }, uOpacity: { value: 0 }, uHex: { value: 0 },
        uHits: { value: [new Vector4(0, 0, 1, -99), new Vector4(0, 0, 1, -99), new Vector4(0, 0, 1, -99), new Vector4(0, 0, 1, -99)] },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: FrontSide,
      toneMapped: false,
    }));
    this.mesh.visible = false;
    this.mesh.renderOrder = 8;
  }
}

export interface ShieldHandle {
  hit(worldPoint: Vector3, time: number): void;
  /** Keep the bubble visible for `seconds`. */
  show(seconds: number): void;
  setLevel(fraction: number): void;
  release(): void;
}

const tmp = new Vector3();

/**
 * Shield bubbles with fresnel rim, hex pattern (cosmetic) and hit ripples.
 * Each bubble follows a target Object3D; it is visible briefly after hits
 * (or permanently when `persistent`, e.g. hangar preview / boss shield phase).
 */
export class ShieldSystem {
  readonly group = new Group();
  private readonly geo = new IcosahedronGeometry(1, 4);
  private readonly pool: ObjectPool<Bubble>;
  private time = 0;

  constructor(budget: number) {
    this.pool = new ObjectPool<Bubble>({
      max: budget,
      create: () => {
        const b = new Bubble(this.geo);
        this.group.add(b.mesh);
        return b;
      },
      reset: (b) => { b.mesh.visible = false; b.target = null; },
      dispose: (b) => b.mesh.material.dispose(),
    });
  }

  attach(target: Object3D, size: Vector3, color: string, effect?: string, persistent = false): ShieldHandle | null {
    const b = this.pool.acquire();
    if (!b) return null;
    b.target = target;
    b.persistent = persistent;
    b.visibleFor = persistent ? 1 : 0;
    b.level = 1;
    b.mesh.scale.copy(size);
    const u = b.mesh.material.uniforms;
    (u.uColor?.value as Color).set(color);
    if (u.uHex) u.uHex.value = effect === "hex_ripple" ? 1 : 0;
    for (const h of u.uHits?.value as Vector4[]) h.w = -99;
    return {
      hit: (p, time) => {
        b.mesh.updateMatrixWorld();
        tmp.copy(p);
        b.mesh.worldToLocal(tmp);
        const hits = u.uHits?.value as Vector4[];
        const h = hits[b.hitIndex % hits.length];
        if (h) h.set(tmp.x, tmp.y, tmp.z, time);
        b.hitIndex++;
        b.visibleFor = Math.max(b.visibleFor, 1.0);
      },
      show: (seconds) => { b.visibleFor = Math.max(b.visibleFor, seconds); },
      setLevel: (f) => { b.level = Math.max(0, Math.min(1, f)); },
      release: () => this.pool.release(b),
    };
  }

  update(time: number, dt: number): void {
    this.time = time;
    this.pool.forEachActive((b) => {
      const t = b.target;
      if (t) {
        t.getWorldPosition(b.mesh.position);
        b.mesh.quaternion.copy(t.quaternion);
      }
      if (!b.persistent) b.visibleFor = Math.max(0, b.visibleFor - dt);
      const op = (b.persistent ? 0.9 : Math.min(1, b.visibleFor * 2)) * (0.35 + 0.65 * b.level);
      const u = b.mesh.material.uniforms;
      if (u.uOpacity) u.uOpacity.value = b.level <= 0.001 ? 0 : op;
      if (u.uTime) u.uTime.value = this.time;
      b.mesh.visible = op > 0.01 && b.level > 0.001;
    });
  }

  dispose(): void {
    this.pool.dispose();
    this.geo.dispose();
    this.group.removeFromParent();
  }
}
