import { AdditiveBlending, Color, ShaderMaterial } from "three";
import { NOISE_GLSL } from "../core/glsl.js";

const VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vView;
varying vec3 vPos;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vPos = wp.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  vView = normalize(cameraPosition - wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uTime;
uniform float uStrength;
varying vec3 vN;
varying vec3 vView;
varying vec3 vPos;
${NOISE_GLSL}
void main() {
  float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vView))), 3.0);
  float n = nf_noise(vPos * 2.5 + vec3(0.0, uTime * 1.5, uTime));
  float bands = smoothstep(0.6, 1.0, sin(vPos.x * 3.0 + vPos.z * 2.0 + uTime * 5.0) * 0.5 + 0.5);
  float a = (fres * 0.7 + bands * 0.12 + n * 0.08) * uStrength;
  gl_FragColor = vec4(uColor * (0.6 + n), a);
}`;

/** Refraction-like shimmer used while a ship is cloaked (own ship / scanned enemy) and for "void_shimmer" skins. */
export function createCloakMaterial(color = "#9ad7ff", strength = 1): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { uColor: { value: new Color(color) }, uTime: { value: 0 }, uStrength: { value: strength } },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    toneMapped: false,
  });
}
