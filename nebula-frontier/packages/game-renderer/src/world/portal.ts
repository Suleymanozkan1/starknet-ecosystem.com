import {
  AdditiveBlending, Color, DoubleSide, Group, Mesh, MeshBasicMaterial, type MeshStandardMaterial, CircleGeometry,
  ShaderMaterial, type BufferGeometry,
} from "three";
import type { PortalKind } from "@nebula/shared";
import { NOISE_GLSL } from "../core/glsl.js";
import { PartCollector, box, chamferBox, torus, transform, cyl } from "../ship/geometry.js";
import { MaterialSlot, type MaterialLibrary } from "../ship/materials.js";

export const PORTAL_COLORS: Readonly<Record<PortalKind, string>> = {
  PORTAL: "#6ee7ff",
  JUMP_GATE: "#ffd36b",
  WARP_GATE: "#b388ff",
  EVENT_GATE: "#ff9f43",
  BOSS_GATE: "#ff3b3b",
  RAID_GATE: "#4cc9f0",
  PVP_GATE: "#ff006e",
};

const VORTEX_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const VORTEX_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uColor;
uniform float uActive;
varying vec2 vUv;
${NOISE_GLSL}
void main() {
  vec2 p = (vUv - 0.5) * 2.0;
  float r = length(p);
  if (r > 1.0) discard;
  float a = atan(p.y, p.x);
  float swirl = a + r * 5.0 - uTime * 1.6;
  float n = nf_fbm(vec3(cos(swirl) * r * 2.0, sin(swirl) * r * 2.0, uTime * 0.25));
  float arms = pow(0.5 + 0.5 * sin(swirl * 3.0 + n * 4.0), 3.0);
  float core = smoothstep(0.45, 0.0, r);
  float rim = smoothstep(0.75, 1.0, r) * smoothstep(1.0, 0.92, r);
  vec3 col = uColor * (arms * 0.9 + n * 0.6) + vec3(1.0) * core * 0.9 + uColor * rim * 1.5;
  float alpha = clamp((arms * 0.6 + n * 0.4 + core + rim) * smoothstep(1.0, 0.85, r), 0.0, 1.0) * (0.55 + 0.45 * uActive);
  gl_FragColor = vec4(col * (1.0 + uActive), alpha);
}`;

/** Animated jump gate / portal: hard-surface frame + swirling shader vortex. */
export class PortalVisual {
  readonly root = new Group();
  private readonly vortex: Mesh<CircleGeometry, ShaderMaterial>;
  private readonly frameGeos: Map<MaterialSlot, BufferGeometry>;
  private readonly frame: Group;
  private readonly ringLights: Mesh;
  private readonly lightMat: MeshBasicMaterial;
  private active = 0;
  readonly radius: number;

  constructor(kind: PortalKind, lib: MaterialLibrary, radius = 6) {
    this.radius = radius;
    const color = PORTAL_COLORS[kind];
    const pc = new PartCollector(0.5);
    const R = radius;
    const gate = kind === "JUMP_GATE" || kind === "WARP_GATE" || kind === "RAID_GATE";
    // outer frame ring (lying flat)
    pc.add(MaterialSlot.PRIMARY, transform(torus(R, R * 0.09, 8, 64), [0, 0, 0], [Math.PI / 2, 0, 0]));
    pc.add(MaterialSlot.TRIM, transform(torus(R * 1.1, R * 0.035, 6, 64), [0, 0, 0], [Math.PI / 2, 0, 0]));
    const segs = gate ? 8 : 6;
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      pc.add(MaterialSlot.SECONDARY, transform(chamferBox(R * 0.28, R * 0.28, R * 0.34, R * 0.05), [Math.cos(a) * R, 0, Math.sin(a) * R], [0, -a, 0]));
      pc.add(MaterialSlot.GLOW, transform(box(R * 0.05, R * 0.3, R * 0.1), [Math.cos(a) * R * 1.14, 0, Math.sin(a) * R * 1.14], [0, -a, 0]));
      if (gate) {
        // pylons reaching outward
        pc.add(MaterialSlot.PRIMARY, transform(chamferBox(R * 0.45, R * 0.12, R * 0.14, R * 0.03), [Math.cos(a) * R * 1.35, -R * 0.05, Math.sin(a) * R * 1.35], [0, -a, 0]));
        pc.add(MaterialSlot.TRIM, transform(cyl(R * 0.04, R * 0.06, R * 0.5, 6), [Math.cos(a) * R * 1.55, R * 0.15, Math.sin(a) * R * 1.55]));
      }
    }
    this.frameGeos = pc.merge();
    const mats = lib.get({ primary: "#3b4252", secondary: "#596377", accent: color, engine: color });
    this.frame = new Group();
    for (const [slot, g] of this.frameGeos) {
      const m = new Mesh(g, mats[slot] as MeshStandardMaterial);
      m.castShadow = slot !== "glow";
      m.receiveShadow = true;
      this.frame.add(m);
    }
    this.root.add(this.frame);

    this.vortex = new Mesh(new CircleGeometry(R * 0.95, 64).rotateX(-Math.PI / 2), new ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uColor: { value: new Color(color) }, uActive: { value: 0 } },
      vertexShader: VORTEX_VERT,
      fragmentShader: VORTEX_FRAG,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
      toneMapped: false,
    }));
    this.vortex.renderOrder = 4;
    this.root.add(this.vortex);

    this.lightMat = new MeshBasicMaterial({ color: new Color(color).multiplyScalar(2.5), toneMapped: false });
    this.ringLights = new Mesh(transform(torus(R * 0.93, R * 0.02, 4, 64), [0, R * 0.05, 0], [Math.PI / 2, 0, 0]), this.lightMat);
    this.root.add(this.ringLights);
  }

  /** Highlight when the local player is in jump range. */
  setActive(on: boolean): void {
    this.active = on ? 1 : 0;
  }

  update(time: number, dt: number): void {
    const u = this.vortex.material.uniforms;
    if (u.uTime) u.uTime.value = time;
    if (u.uActive) u.uActive.value += (this.active - (u.uActive.value as number)) * Math.min(1, dt * 4);
    this.frame.rotation.y = time * 0.05;
    this.ringLights.rotation.y = -time * 0.4;
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const g of this.frameGeos.values()) g.dispose();
    this.vortex.geometry.dispose();
    this.vortex.material.dispose();
    this.ringLights.geometry.dispose();
    this.lightMat.dispose();
  }
}
