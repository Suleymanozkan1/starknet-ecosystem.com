import { AdditiveBlending, BackSide, Color, CylinderGeometry, Mesh, ShaderMaterial } from "three";

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const FRAG = /* glsl */ `
uniform float uTime;
uniform float uI;
uniform vec3 uColor;
varying vec2 vUv;
float h(float n) { return fract(sin(n) * 43758.5453); }
void main() {
  float lane = floor(vUv.x * 90.0);
  float speed = 1.5 + h(lane) * 3.0;
  float y = fract(vUv.y * 2.0 + uTime * speed + h(lane * 7.1));
  float streak = smoothstep(0.0, 0.02, y) * smoothstep(0.35 + h(lane) * 0.4, 0.0, y);
  float laneMask = smoothstep(0.5, 0.0, abs(fract(vUv.x * 90.0) - 0.5)) * step(0.45, h(lane * 3.3));
  float a = streak * laneMask * uI;
  vec3 col = mix(uColor, vec3(1.0), streak * 0.6);
  gl_FragColor = vec4(col * 2.0, a);
}`;

/** Hyperspace streak tunnel shown around the camera during map transitions. */
export class WarpTunnel {
  readonly mesh: Mesh<CylinderGeometry, ShaderMaterial>;
  private intensity = 0;
  private target = 0;

  constructor() {
    const geo = new CylinderGeometry(14, 14, 160, 48, 1, true);
    this.mesh = new Mesh(geo, new ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uI: { value: 0 }, uColor: { value: new Color("#8fd3ff") } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: BackSide,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: AdditiveBlending,
      toneMapped: false,
    }));
    this.mesh.renderOrder = 100;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  /** Fade towards intensity (0 = off, 1 = full). */
  set(on: boolean, color?: string): void {
    this.target = on ? 1 : 0;
    if (color) (this.mesh.material.uniforms.uColor?.value as Color).set(color);
  }

  get active(): boolean {
    return this.intensity > 0.001 || this.target > 0;
  }

  update(time: number, dt: number): void {
    this.intensity += (this.target - this.intensity) * Math.min(1, dt * 3);
    const u = this.mesh.material.uniforms;
    if (u.uI) u.uI.value = this.intensity;
    if (u.uTime) u.uTime.value = time;
    this.mesh.visible = this.intensity > 0.005;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
