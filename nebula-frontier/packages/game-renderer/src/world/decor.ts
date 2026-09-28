import {
  AdditiveBlending, BackSide, Color, Group, Mesh, MeshBasicMaterial, ShaderMaterial, SphereGeometry, type Vector3,
} from "three";
import type { MapDef, ShipVisualDef } from "@nebula/shared";
import { SHIPS } from "@nebula/config";
import { NOISE_GLSL } from "../core/glsl.js";
import { createRng } from "../core/random.js";
import type { ShipFactory, ShipModel } from "../ship/ShipFactory.js";
import { PartCollector, box, chamferBox, cyl, sphere, transform } from "../ship/geometry.js";
import { MaterialSlot, type MaterialLibrary } from "../ship/materials.js";
import { StationVisual } from "./station.js";

const PLANET_VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vLocal;
varying vec3 vWorld;
void main() {
  vLocal = normalize(position);
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const PLANET_FRAG = /* glsl */ `
uniform vec3 uA; uniform vec3 uB; uniform vec3 uC; uniform vec3 uLight; uniform float uSeed; uniform float uBands; uniform float uTime;
varying vec3 vN;
varying vec3 vLocal;
varying vec3 vWorld;
${NOISE_GLSL}
void main() {
  vec3 p = vLocal * 2.0 + vec3(uSeed);
  float n = nf_fbm(p + vec3(uTime * 0.01, 0.0, 0.0));
  float bands = sin(vLocal.y * 14.0 * uBands + n * 6.0) * 0.5 + 0.5;
  float land = smoothstep(0.45, 0.6, n);
  vec3 col = mix(mix(uA, uB, bands * uBands + land * (1.0 - uBands)), uC, smoothstep(0.7, 0.9, nf_fbm(p * 3.0)) * 0.5);
  float diff = max(dot(normalize(vN), normalize(uLight)), 0.0);
  float term = smoothstep(-0.1, 0.3, dot(normalize(vN), normalize(uLight)));
  vec3 V = normalize(cameraPosition - vWorld);
  float rim = pow(1.0 - max(dot(normalize(vN), V), 0.0), 3.0);
  vec3 c = col * (0.04 + diff * 1.1) + uB * rim * 0.6 * term;
  gl_FragColor = vec4(c, 1.0);
}`;
const ATMO_FRAG = /* glsl */ `
uniform vec3 uB; uniform vec3 uLight;
varying vec3 vN;
varying vec3 vWorld;
varying vec3 vLocal;
void main() {
  vec3 V = normalize(cameraPosition - vWorld);
  float rim = pow(1.0 - abs(dot(normalize(vN), V)), 2.5);
  float lit = smoothstep(-0.3, 0.5, dot(normalize(vN), normalize(uLight)));
  gl_FragColor = vec4(uB * 1.4, rim * lit * 0.9);
}`;

export interface DecorItem {
  root: Group;
  update(time: number): void;
  dispose(): void;
}

/** Procedural planet (or moon) with atmosphere, placed far below the play plane for parallax. */
export function createPlanet(colors: readonly string[], seed: string, radius: number, moon: boolean, light: Vector3): DecorItem {
  const rng = createRng(seed);
  const root = new Group();
  const geo = new SphereGeometry(radius, 64, 40);
  const a = colors[0] ?? "#223355", b = colors[1] ?? "#88aaff", c = colors[2] ?? "#ffffff";
  const mat = new ShaderMaterial({
    uniforms: {
      uA: { value: new Color(moon ? "#4a4a52" : a) }, uB: { value: new Color(moon ? "#9a9aa6" : b) }, uC: { value: new Color(moon ? "#6b6b75" : c) },
      uLight: { value: light.clone() }, uSeed: { value: rng.range(0, 40) }, uBands: { value: moon ? 0 : rng() < 0.5 ? 1 : 0.2 }, uTime: { value: 0 },
    },
    vertexShader: PLANET_VERT,
    fragmentShader: PLANET_FRAG,
  });
  const planet = new Mesh(geo, mat);
  root.add(planet);
  let atmo: Mesh<SphereGeometry, ShaderMaterial> | null = null;
  if (!moon) {
    atmo = new Mesh(new SphereGeometry(radius * 1.06, 48, 32), new ShaderMaterial({
      uniforms: { uB: { value: new Color(b) }, uLight: { value: light.clone() } },
      vertexShader: PLANET_VERT,
      fragmentShader: ATMO_FRAG,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: BackSide,
    }));
    root.add(atmo);
  }
  planet.rotation.z = rng.range(-0.4, 0.4);
  return {
    root,
    update(time) {
      planet.rotation.y = time * 0.01;
      const u = mat.uniforms.uTime;
      if (u) u.value = time;
    },
    dispose() {
      root.removeFromParent();
      geo.dispose();
      mat.dispose();
      if (atmo) {
        atmo.geometry.dispose();
        atmo.material.dispose();
      }
    },
  };
}

/** Navigation beacon: pylon with blinking light. */
export function createBeacon(lib: MaterialLibrary, color: string, seed: string): DecorItem {
  const pc = new PartCollector(0.8);
  pc.add(MaterialSlot.PRIMARY, transform(cyl(0.25, 0.6, 3, 8), [0, 0, 0]));
  pc.add(MaterialSlot.TRIM, transform(chamferBox(1.6, 0.3, 1.6, 0.3), [0, -1.4, 0]));
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    pc.add(MaterialSlot.SECONDARY, transform(box(0.15, 1.6, 0.5), [Math.cos(a) * 0.9, -0.6, Math.sin(a) * 0.9], [0, -a, 0.3]));
  }
  const geos = pc.merge();
  const mats = lib.get({ primary: "#3a3f4a", secondary: "#596070", accent: color, engine: color });
  const root = new Group();
  for (const [slot, g] of geos) root.add(new Mesh(g, mats[slot]));
  const lampGeo = sphere(0.35, 12, 8);
  const lampMat = new MeshBasicMaterial({ color: new Color(color).multiplyScalar(3), toneMapped: false });
  const lamp = new Mesh(lampGeo, lampMat);
  lamp.position.y = 1.7;
  root.add(lamp);
  const phase = createRng(seed)() * 6;
  return {
    root,
    update(time) {
      const on = Math.sin(time * 3 + phase) > 0.6;
      lamp.visible = on;
    },
    dispose() {
      root.removeFromParent();
      for (const g of geos.values()) g.dispose();
      lampGeo.dispose();
      lampMat.dispose();
    },
  };
}

/** Wreck or derelict: a burnt, broken ship hull with scattered fragments. */
export function createWreck(factory: ShipFactory, seed: string, scale: number, derelict: boolean): DecorItem {
  const rng = createRng(seed);
  const pool = SHIPS.filter((s) => (derelict ? s.visual.length >= 6 : s.visual.length < 6));
  const base = (pool.length > 0 ? rng.pick(pool) : rng.pick(SHIPS)).visual;
  const visual: ShipVisualDef = { ...base, length: base.length * scale * (derelict ? 1.2 : 1), hardpoints: [], nozzles: base.nozzles.map((n) => [n[0] * scale, n[1] * scale, n[2] * scale] as [number, number, number]) };
  const ship: ShipModel = factory.create(visual, { variant: "wreck", engines: false });
  const root = new Group();
  ship.root.rotation.set(rng.range(-0.5, 0.5), rng.range(0, Math.PI * 2), rng.range(-0.7, 0.7));
  ship.root.position.y = -1.5;
  root.add(ship.root);
  // scattered hull fragments
  const pc = new PartCollector(1);
  const frags = derelict ? 14 : 7;
  for (let i = 0; i < frags; i++) {
    const r = visual.length * rng.range(0.5, 1.2);
    const a = rng() * Math.PI * 2;
    pc.add(rng() < 0.5 ? MaterialSlot.PRIMARY : MaterialSlot.TRIM, transform(chamferBox(visual.length * rng.range(0.04, 0.12), visual.length * 0.02, visual.length * rng.range(0.05, 0.15), 0.05), [Math.cos(a) * r, rng.range(-2, 0), Math.sin(a) * r], [rng() * 3, rng() * 3, rng() * 3]));
  }
  const fragGeos = pc.merge();
  for (const [slot, g] of fragGeos) root.add(new Mesh(g, ship.materials[slot]));
  const spin = rng.range(-0.02, 0.02);
  return {
    root,
    update(time) {
      ship.root.rotation.y += spin * 0.016;
      void time;
    },
    dispose() {
      root.removeFromParent();
      ship.dispose();
      for (const g of fragGeos.values()) g.dispose();
    },
  };
}

export function createStationRuin(lib: MaterialLibrary, seed: string, scale: number): DecorItem {
  const st = new StationVisual(lib, { id: seed, palette: { primary: "#4a4f58", secondary: "#2f333a", accent: "#ff6a3d", engine: "#ff6a3d" }, ruined: true, scale: scale * 0.8 });
  st.root.position.y = -2;
  return {
    root: st.root,
    update: (t) => st.update(t * 0.2),
    dispose: () => st.dispose(),
  };
}

export interface DecorContext {
  factory: ShipFactory;
  lib: MaterialLibrary;
  light: Vector3;
}

/** Build all decor items for a map. Coordinates: map (x,y) → world (x, ?, y). */
export function buildMapDecor(map: MapDef, ctx: DecorContext): DecorItem[] {
  const out: DecorItem[] = [];
  map.decor.forEach((d, i) => {
    const seed = `${map.id}:${i}`;
    let item: DecorItem;
    switch (d.kind) {
      case "PLANET": {
        const r = 6 * d.scale;
        item = createPlanet(map.environment.nebulaColors, seed, r, false, ctx.light);
        item.root.position.set(d.x, -r - 45, d.y);
        break;
      }
      case "MOON": {
        const r = 5 * d.scale;
        item = createPlanet(map.environment.nebulaColors, seed, r, true, ctx.light);
        item.root.position.set(d.x, -r - 30, d.y);
        break;
      }
      case "BEACON":
        item = createBeacon(ctx.lib, map.environment.nebulaColors[1] ?? "#6ee7ff", seed);
        item.root.position.set(d.x, 0, d.y);
        item.root.scale.setScalar(d.scale);
        break;
      case "WRECK":
      case "DERELICT":
        item = createWreck(ctx.factory, seed, d.scale, d.kind === "DERELICT");
        item.root.position.set(d.x, 0, d.y);
        break;
      case "STATION_RUIN":
        item = createStationRuin(ctx.lib, seed, d.scale);
        item.root.position.set(d.x, 0, d.y);
        break;
    }
    out.push(item);
  });
  return out;
}

