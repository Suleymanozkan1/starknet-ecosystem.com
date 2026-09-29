/** Shared GLSL snippets. */
export const NOISE_GLSL = /* glsl */ `
float nf_hash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float nf_noise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(nf_hash(i + vec3(0,0,0)), nf_hash(i + vec3(1,0,0)), f.x),
                 mix(nf_hash(i + vec3(0,1,0)), nf_hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(nf_hash(i + vec3(0,0,1)), nf_hash(i + vec3(1,0,1)), f.x),
                 mix(nf_hash(i + vec3(0,1,1)), nf_hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float nf_fbm(vec3 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * nf_noise(p); p = p * 2.02 + vec3(1.7, 9.2, 4.1); a *= 0.5; }
  return s;
}
`;
