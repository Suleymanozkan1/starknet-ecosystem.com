import {
  AdditiveBlending, BackSide, BufferAttribute, BufferGeometry, Color, Group, Mesh, Points, ShaderMaterial,
  SphereGeometry, type Vector3,
} from "three";
import type { MapDef } from "@nebula/shared";
import { NOISE_GLSL } from "../core/glsl.js";
import { createRng } from "../core/random.js";

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;
const SKY_FRAG = /* glsl */ `
uniform vec3 uC0; uniform vec3 uC1; uniform vec3 uC2; uniform float uFog; uniform float uTime; uniform float uSeed;
varying vec3 vDir;
${NOISE_GLSL}
void main() {
  vec3 d = normalize(vDir);
  vec3 p = d * 2.2 + vec3(uSeed);
  float n1 = nf_fbm(p + vec3(uTime * 0.004, 0.0, 0.0));
  float n2 = nf_fbm(p * 1.9 + vec3(4.0, uTime * 0.003, 1.0));
  float n3 = nf_fbm(p * 4.0 - vec3(2.0));
  float cloud = smoothstep(0.35, 0.85, n1);
  float wisps = smoothstep(0.45, 0.9, n2) * (0.6 + 0.4 * n3);
  vec3 base = uC0 * 0.12;
  vec3 col = base;
  col += uC0 * cloud * 0.55;
  col += uC1 * wisps * 0.65 * (0.5 + uFog);
  col += uC2 * pow(smoothstep(0.62, 0.95, n3 * cloud + 0.3 * wisps), 2.0) * 0.8;
  // dark dust lanes
  float lanes = smoothstep(0.55, 0.75, nf_fbm(p * 3.1 + vec3(7.0)));
  col *= 1.0 - lanes * 0.55;
  gl_FragColor = vec4(col, 1.0);
}`;

const STAR_VERT = /* glsl */ `
attribute float aSize;
attribute vec3 aColor;
attribute float aPhase;
uniform float uTime;
uniform float uPixelRatio;
varying vec3 vColor;
varying float vTw;
void main() {
  vColor = aColor;
  vTw = 0.75 + 0.25 * sin(uTime * (0.6 + aPhase) + aPhase * 17.0);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uPixelRatio;
  gl_Position = projectionMatrix * mv;
}`;
const STAR_FRAG = /* glsl */ `
varying vec3 vColor;
varying float vTw;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  float a = smoothstep(0.5, 0.0, d);
  a = a * a;
  float cross = max(0.0, 1.0 - abs(c.x) * 14.0) * max(0.0, 1.0 - abs(c.y) * 2.2) + max(0.0, 1.0 - abs(c.y) * 14.0) * max(0.0, 1.0 - abs(c.x) * 2.2);
  gl_FragColor = vec4(vColor * vTw, clamp(a + cross * 0.35, 0.0, 1.0));
}`;

const DUST_VERT = /* glsl */ `
uniform vec3 uCenter;
uniform float uRange;
uniform float uPixelRatio;
uniform float uTime;
attribute float aSize;
varying float vA;
void main() {
  vec3 p = position;
  p.xz = mod(p.xz - uCenter.xz + uRange * 0.5, uRange) + uCenter.xz - uRange * 0.5;
  p.y += sin(uTime * 0.3 + position.x) * 0.3;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vA = clamp(1.0 - length(p.xz - uCenter.xz) / (uRange * 0.5), 0.0, 1.0);
  gl_PointSize = aSize * uPixelRatio * (40.0 / -mv.z);
  gl_Position = projectionMatrix * mv;
}`;
const DUST_FRAG = /* glsl */ `
uniform vec3 uColor;
varying float vA;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.1, d) * vA * 0.55;
  gl_FragColor = vec4(uColor, a);
}`;

export interface BackgroundOptions {
  starCount: number;
  dustCount: number;
  pixelRatio: number;
}

/**
 * Distant background: shader nebula skybox using `map.environment` colours,
 * multi-layer starfield (far layer follows the camera, mid layer parallaxes)
 * and near-plane space dust that wraps around the camera.
 */
export class SpaceBackground {
  readonly group = new Group();
  private readonly sky: Mesh<SphereGeometry, ShaderMaterial>;
  private readonly farStars: Points<BufferGeometry, ShaderMaterial>;
  private readonly midStars: Points<BufferGeometry, ShaderMaterial>;
  private readonly dust: Points<BufferGeometry, ShaderMaterial>;
  private readonly starMat: ShaderMaterial;
  private readonly midMat: ShaderMaterial;

  constructor(opts: BackgroundOptions) {
    this.sky = new Mesh(
      new SphereGeometry(900, 48, 24),
      new ShaderMaterial({
        uniforms: {
          uC0: { value: new Color("#1b3a6b") }, uC1: { value: new Color("#6ee7ff") }, uC2: { value: new Color("#ffd36b") },
          uFog: { value: 0.2 }, uTime: { value: 0 }, uSeed: { value: 0 },
        },
        vertexShader: SKY_VERT,
        fragmentShader: SKY_FRAG,
        side: BackSide,
        depthWrite: false,
        depthTest: false,
      }),
    );
    this.sky.renderOrder = -1000;
    this.sky.frustumCulled = false;
    this.group.add(this.sky);

    this.starMat = starMaterial(opts.pixelRatio);
    this.farStars = new Points(starGeometry(opts.starCount, 800, 1, false), this.starMat);
    this.farStars.renderOrder = -999;
    this.farStars.frustumCulled = false;
    this.group.add(this.farStars);

    this.midMat = starMaterial(opts.pixelRatio);
    this.midMat.depthTest = true;
    this.midStars = new Points(starGeometry(Math.round(opts.starCount * 0.35), 1400, 2, true), this.midMat);
    this.midStars.frustumCulled = false;
    this.group.add(this.midStars);

    const dg = new BufferGeometry();
    const n = opts.dustCount;
    const pos = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const rng = createRng(99);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = rng.range(-120, 120);
      pos[i * 3 + 1] = rng.range(-14, 6);
      pos[i * 3 + 2] = rng.range(-120, 120);
      size[i] = rng.range(1, 3.5);
    }
    dg.setAttribute("position", new BufferAttribute(pos, 3));
    dg.setAttribute("aSize", new BufferAttribute(size, 1));
    this.dust = new Points(dg, new ShaderMaterial({
      uniforms: { uCenter: { value: null }, uRange: { value: 240 }, uPixelRatio: { value: opts.pixelRatio }, uTime: { value: 0 }, uColor: { value: new Color("#9fc5ff") } },
      vertexShader: DUST_VERT,
      fragmentShader: DUST_FRAG,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    }));
    this.dust.frustumCulled = false;
    this.group.add(this.dust);
  }

  setEnvironment(env: MapDef["environment"], seed: string): void {
    const u = this.sky.material.uniforms;
    const [a, b, c] = env.nebulaColors;
    (u.uC0?.value as Color).set(a ?? "#101830");
    (u.uC1?.value as Color).set(b ?? a ?? "#4060a0");
    (u.uC2?.value as Color).set(c ?? b ?? "#ffffff");
    if (u.uFog) u.uFog.value = env.fog;
    if (u.uSeed) u.uSeed.value = (createRng(seed)() * 50);
    this.farStars.visible = env.starDensity > 0.05;
    this.farStars.geometry.setDrawRange(0, Math.round((this.farStars.geometry.attributes.position?.count ?? 0) * Math.min(1, 0.3 + env.starDensity)));
    const du = this.dust.material.uniforms.uColor;
    if (du) (du.value as Color).set(env.ambient);
  }

  setPixelRatio(r: number): void {
    for (const m of [this.starMat, this.midMat, this.dust.material]) {
      const u = m.uniforms.uPixelRatio;
      if (u) u.value = r;
    }
  }

  update(cameraPos: Vector3, time: number): void {
    this.sky.position.copy(cameraPos);
    this.farStars.position.copy(cameraPos);
    const su = this.sky.material.uniforms.uTime;
    if (su) su.value = time;
    for (const m of [this.starMat, this.midMat, this.dust.material]) {
      const u = m.uniforms.uTime;
      if (u) u.value = time;
    }
    const c = this.dust.material.uniforms.uCenter;
    if (c) c.value = cameraPos;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.sky.geometry.dispose();
    this.sky.material.dispose();
    this.farStars.geometry.dispose();
    this.midStars.geometry.dispose();
    this.starMat.dispose();
    this.midMat.dispose();
    this.dust.geometry.dispose();
    this.dust.material.dispose();
  }
}

function starMaterial(pixelRatio: number): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uPixelRatio: { value: pixelRatio } },
    vertexShader: STAR_VERT,
    fragmentShader: STAR_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: AdditiveBlending,
  });
}

const STAR_TINTS = ["#ffffff", "#cfe0ff", "#fff2d6", "#ffd9b0", "#b8d0ff", "#ffe9f0"];

function starGeometry(n: number, radius: number, seed: number, plane: boolean): BufferGeometry {
  const rng = createRng(seed * 7919);
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const size = new Float32Array(n);
  const phase = new Float32Array(n);
  const c = new Color();
  for (let i = 0; i < n; i++) {
    if (plane) {
      // layer well below the play plane → parallax as the camera pans
      pos[i * 3] = rng.range(-radius, radius);
      pos[i * 3 + 1] = rng.range(-420, -160);
      pos[i * 3 + 2] = rng.range(-radius, radius);
    } else {
      const u = rng() * 2 - 1, t = rng() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      pos[i * 3] = Math.cos(t) * s * radius;
      pos[i * 3 + 1] = u * radius;
      pos[i * 3 + 2] = Math.sin(t) * s * radius;
    }
    c.set(STAR_TINTS[rng.int(0, STAR_TINTS.length - 1)] ?? "#ffffff");
    const b = Math.pow(rng(), 3) * 1.6 + 0.25;
    col[i * 3] = c.r * b; col[i * 3 + 1] = c.g * b; col[i * 3 + 2] = c.b * b;
    size[i] = rng() < 0.02 ? rng.range(5, 9) : rng.range(1.2, 3.2);
    phase[i] = rng() * 3;
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(pos, 3));
  g.setAttribute("aColor", new BufferAttribute(col, 3));
  g.setAttribute("aSize", new BufferAttribute(size, 1));
  g.setAttribute("aPhase", new BufferAttribute(phase, 1));
  return g;
}
