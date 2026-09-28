import {
  AmbientLight, CircleGeometry, Color, CylinderGeometry, DirectionalLight, GridHelper, Group, Mesh, MeshBasicMaterial,
  MeshStandardMaterial, PerspectiveCamera, Quaternion, Scene, SpotLight, TorusGeometry, Vector3, AdditiveBlending,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Reflector } from "three/addons/objects/Reflector.js";
import type { CosmeticPayload, GraphicsTier, ShipDef } from "@nebula/shared";
import { SHIPS_BY_ID } from "@nebula/config";
import { createRenderBackend, type BackendPreference, type RenderBackend } from "../core/backend.js";
import { TIER_SETTINGS, resolveTier } from "../core/tiers.js";
import { MaterialLibrary } from "../ship/materials.js";
import { ShipFactory, type ShipModel } from "../ship/ShipFactory.js";
import { resolveCosmeticPayloads } from "../ship/cosmetics.js";
import { EffectsSystem } from "../fx/EffectsSystem.js";
import type { ShieldHandle } from "../fx/shield.js";

export interface HangarViewerOptions {
  shipDef: ShipDef | string;
  /** Equipped cosmetic item ids (e.g. "skin_lumen_solar_crown") or resolved payloads. */
  cosmetics?: readonly (string | CosmeticPayload)[];
  tier?: GraphicsTier | "AUTO";
  backend?: BackendPreference;
  /** Auto-rotate the platform (default true). */
  autoRotate?: boolean;
  /** Transparent background (compose over web UI). */
  transparent?: boolean;
}

export interface HangarViewer {
  setShip(def: ShipDef | string): void;
  setCosmetics(cosmetics: readonly (string | CosmeticPayload)[]): void;
  previewEngines(on: boolean): void;
  fireWeapons(): void;
  previewShield(): void;
  previewDamage(pct: number): void;
  setCompare(def: ShipDef | string | null): void;
  setAutoRotate(on: boolean): void;
  zoom(delta: number): void;
  resetView(): void;
  resize(): void;
  screenshot(): string;
  readonly controls: OrbitControls;
  dispose(): void;
}

interface Bay {
  root: Group;
  /** Rotating turntable (unscaled) holding the disc and the ship. */
  platform: Group;
  disc: Group;
  model: ShipModel | null;
  def: ShipDef | null;
  shield: ShieldHandle | null;
  damage: number;
}

function resolveDef(d: ShipDef | string): ShipDef {
  if (typeof d !== "string") return d;
  const def = SHIPS_BY_ID.get(d);
  if (!def) throw new Error(`Unknown ship ${d}`);
  return def;
}

function resolvePayloads(list: readonly (string | CosmeticPayload)[]): CosmeticPayload[] {
  const ids = list.filter((x): x is string => typeof x === "string");
  const payloads = list.filter((x): x is CosmeticPayload => typeof x !== "string");
  return [...resolveCosmeticPayloads(ids), ...payloads];
}

const tmpA = new Vector3();
const tmpB = new Vector3();
const tmpQ = new Quaternion();

/**
 * Standalone 3D hangar: studio lighting, reflective floor, rotating platform,
 * orbit controls, engine/weapon/shield/damage previews and side-by-side compare.
 */
export async function createHangarViewer(canvas: HTMLCanvasElement, opts: HangarViewerOptions): Promise<HangarViewer> {
  const tierName = resolveTier(opts.tier ?? "AUTO");
  const tier = TIER_SETTINGS[tierName];
  const backend: RenderBackend = await createRenderBackend({ canvas, tier, preference: opts.backend ?? "webgl", alpha: opts.transparent ?? false, preserveDrawingBuffer: true });
  const scene = new Scene();
  if (!opts.transparent) scene.background = new Color("#05070d");
  if (backend.environment) {
    scene.environment = backend.environment;
    scene.environmentIntensity = 0.55;
  }
  const camera = new PerspectiveCamera(35, 1, 0.1, 500);
  camera.position.set(9, 5.5, 11);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.minDistance = 3;
  controls.maxDistance = 90;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.target.set(0, 0.8, 0);

  // --- studio lighting -----------------------------------------------------------------
  const key = new SpotLight("#ffffff", 260, 120, Math.PI / 5, 0.5, 1.4);
  key.position.set(8, 16, 10);
  key.castShadow = tier.shadows;
  key.shadow.mapSize.set(tier.shadowMapSize, tier.shadowMapSize);
  key.shadow.bias = -0.0005;
  const fill = new DirectionalLight("#8fb4ff", 1.1);
  fill.position.set(-10, 6, -4);
  const rimL = new DirectionalLight("#6ee7ff", 2.2);
  rimL.position.set(-6, 4, -12);
  const rimR = new DirectionalLight("#ff9ad5", 1.4);
  rimR.position.set(10, 3, -10);
  scene.add(key, key.target, fill, rimL, rimR, new AmbientLight("#1b2233", 0.6));

  // --- floor ---------------------------------------------------------------------------------
  const floorGroup = new Group();
  scene.add(floorGroup);
  let reflector: Reflector | null = null;
  if (backend.kind === "webgl" && (tierName === "ULTRA" || tierName === "HIGH")) {
    reflector = new Reflector(new CircleGeometry(60, 64), { color: new Color("#1a1e28"), textureWidth: 1024, textureHeight: 1024, clipBias: 0.003 });
    reflector.rotation.x = -Math.PI / 2;
    reflector.position.y = -0.02;
    floorGroup.add(reflector);
  }
  const floorMat = new MeshStandardMaterial({ color: "#05070b", roughness: 0.85, metalness: 0.1, envMapIntensity: 0.05, transparent: !!reflector, opacity: reflector ? 0.9 : 1 });
  const floorGeo = new CircleGeometry(60, 64);
  const floor = new Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  floorGroup.add(floor);
  const grid = new GridHelper(120, 60, 0x1f3550, 0x121a28);
  grid.position.y = 0.005;
  grid.material.transparent = true;
  grid.material.opacity = 0.35;
  floorGroup.add(grid);

  // --- shared runtime ------------------------------------------------------------------------
  const materials = new MaterialLibrary({ textureSize: Math.max(256, tier.textureSize), physical: tier.physicalMaterials, anisotropy: tier.anisotropy });
  const factory = new ShipFactory({ materials, greebles: true, lodBias: 50 });
  const fx = new EffectsSystem({ ...tier, particleBudget: Math.max(1500, tier.particleBudget) });
  scene.add(fx.group);

  const platformGeo = new CylinderGeometry(1, 1.06, 0.18, 64);
  const platformMat = new MeshStandardMaterial({ color: "#1c222d", metalness: 0.85, roughness: 0.45, envMapIntensity: 0.3 });
  const ringGeo = new TorusGeometry(1.04, 0.012, 6, 96).rotateX(Math.PI / 2);
  const ringMat = new MeshBasicMaterial({ color: new Color("#6ee7ff").multiplyScalar(2), toneMapped: false });
  const haloGeo = new CircleGeometry(1.4, 64).rotateX(-Math.PI / 2);
  const haloMat = new MeshBasicMaterial({ color: "#2a6fff", transparent: true, opacity: 0.12, blending: AdditiveBlending, depthWrite: false });

  const makeBay = (): Bay => {
    const root = new Group();
    const platform = new Group();
    const discGroup = new Group();
    const disc = new Mesh(platformGeo, platformMat);
    disc.receiveShadow = true;
    disc.position.y = 0.09;
    const ring = new Mesh(ringGeo, ringMat);
    ring.position.y = 0.19;
    const halo = new Mesh(haloGeo, haloMat);
    halo.position.y = 0.01;
    discGroup.add(disc, ring, halo);
    platform.add(discGroup);
    root.add(platform);
    scene.add(root);
    return { root, platform, disc: discGroup, model: null, def: null, shield: null, damage: 0 };
  };
  const main = makeBay();
  let compare: Bay | null = null;
  let cosmetics = resolvePayloads(opts.cosmetics ?? []);
  let engines = true;
  let autoRotate = opts.autoRotate ?? true;

  const mountShip = (bay: Bay, def: ShipDef, cos: readonly CosmeticPayload[]): void => {
    bay.shield?.release();
    bay.shield = null;
    bay.model?.dispose();
    const model = factory.createFromDef(def, { cosmetics: cos });
    const L = model.length;
    const s = Math.max(L * 0.62, model.radius * 1.05);
    bay.disc.scale.set(s, 1, s);
    model.root.position.y = 0.2 + Math.max(0.3, L * 0.09);
    model.root.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh) m.castShadow = true;
    });
    model.setThrust(engines ? 0.6 : 0);
    bay.platform.add(model.root);
    bay.model = model;
    bay.def = def;
    bay.damage = 0;
  };

  const frame = (): void => {
    const models = [main, compare].filter((b): b is Bay => !!b && !!b.model);
    const widths = models.map((b) => Math.max(b.model?.length ?? 3, (b.model?.radius ?? 1.5) * 2));
    if (compare && main.model && compare.model) {
      const gap = (widths[0] ?? 3) / 2 + (widths[1] ?? 3) / 2 + 2;
      main.root.position.x = -gap / 2;
      compare.root.position.x = gap / 2;
    } else {
      main.root.position.x = 0;
    }
    const extent = compare ? (widths[0] ?? 3) + (widths[1] ?? 3) + 2 : Math.max(widths[0] ?? 3, 3);
    controls.minDistance = extent * 0.6;
    controls.maxDistance = extent * 6;
    key.shadow.camera.far = extent * 12;
  };

  const resetView = (): void => {
    const L = Math.max(main.model?.length ?? 3, (main.model?.radius ?? 1.5) * 1.6);
    const ext = compare ? L * 2.6 : L;
    const d = Math.max(9, ext * 2.7);
    camera.position.set(d * 0.72, d * 0.42, d * 0.85);
    controls.target.set(0, Math.max(0.6, L * 0.1), 0);
    controls.update();
  };

  mountShip(main, resolveDef(opts.shipDef), cosmetics);
  frame();
  resetView();

  // --- sizing & loop ---------------------------------------------------------------------
  const resize = (): void => {
    const w = Math.max(1, canvas.clientWidth), h = Math.max(1, canvas.clientHeight);
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    backend.setPixelRatio(Math.min(dpr, tier.maxPixelRatio));
    backend.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    fx.setViewport(h * backend.pixelRatio, (camera.fov * Math.PI) / 180);
    reflector?.getRenderTarget().setSize(Math.min(1024, w), Math.min(1024, h));
  };
  resize();
  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => resize()) : null;
  ro?.observe(canvas);

  let raf = 0;
  let last = -1;
  let time = 0;
  let disposed = false;
  const tick = (now: number): void => {
    if (disposed) return;
    raf = requestAnimationFrame(tick);
    const dt = last < 0 ? 1 / 60 : Math.min(0.1, (now - last) / 1000);
    last = now;
    time += dt;
    for (const bay of [main, compare]) {
      if (!bay || !bay.model) continue;
      if (autoRotate) bay.platform.rotation.y += dt * 0.25;
      bay.model.root.position.y = 0.2 + Math.max(0.3, bay.model.length * 0.09) + Math.sin(time * 1.2) * 0.04;
      if (bay.damage > 0.3) {
        bay.model.socketWorld(bay.model.sockets.core, tmpA);
        fx.damageEmit(tmpA, 1 - bay.damage, dt, bay.model.length);
      }
    }
    factory.update(time);
    fx.update(time, dt);
    if (!backend.supportsGlsl) {
      // experimental WebGPU backend: GLSL effects are unsupported → hide them
      scene.traverse((o) => {
        const m = (o as { material?: unknown }).material;
        if (m && (m as { isShaderMaterial?: boolean }).isShaderMaterial) o.visible = false;
      });
    }
    controls.update();
    backend.render(scene, camera);
  };
  raf = requestAnimationFrame(tick);

  const viewer: HangarViewer = {
    controls,
    setShip(def) {
      mountShip(main, resolveDef(def), cosmetics);
      frame();
      resetView();
    },
    setCosmetics(list) {
      cosmetics = resolvePayloads(list);
      if (main.def) mountShip(main, main.def, cosmetics);
      frame();
    },
    previewEngines(on) {
      engines = on;
      for (const bay of [main, compare]) bay?.model?.setThrust(on ? 1 : 0, on);
    },
    fireWeapons() {
      for (const bay of [main, compare]) {
        const m = bay?.model;
        if (!m) continue;
        m.root.updateMatrixWorld(true);
        const n = Math.max(1, m.sockets.muzzles.length);
        const color = m.look.weaponColors?.[0] ?? m.palette.accent;
        for (let i = 0; i < n; i++) {
          m.muzzleWorld(i, tmpA);
          // shoot along the ship's forward axis
          tmpB.set(0, 0, 1).applyQuaternion(m.root.getWorldQuaternion(tmpQ)).multiplyScalar(30).add(tmpA);
          fx.fire(tmpA, tmpB, color, i % 3 === 2 ? "missile" : "bolt", 0.35 + i * 0.03, false);
        }
      }
    },
    previewShield() {
      for (const bay of [main, compare]) {
        const m = bay?.model;
        if (!bay || !m) continue;
        if (!bay.shield) {
          const size = new Vector3(Math.max(m.radius * 0.9, m.length * 0.45), Math.max(0.6, m.radius * 0.45), m.length * 0.62);
          bay.shield = fx.shields.attach(m.root, size, m.look.shield?.color ?? m.palette.accent, m.look.shield?.effect, false);
        }
        m.root.updateMatrixWorld(true);
        m.socketWorld([m.radius * 0.5, 0, m.length * 0.4], tmpA);
        bay.shield?.hit(tmpA, time);
        m.socketWorld([-m.radius * 0.5, 0.2, -m.length * 0.2], tmpA);
        bay.shield?.hit(tmpA, time + 0.25);
        bay.shield?.show(3);
      }
    },
    previewDamage(pct) {
      const v = Math.max(0, Math.min(1, pct > 1 ? pct / 100 : pct));
      for (const bay of [main, compare]) if (bay) bay.damage = v;
    },
    setCompare(def) {
      if (!def) {
        if (compare) {
          compare.shield?.release();
          compare.model?.dispose();
          compare.root.removeFromParent();
          compare = null;
        }
      } else {
        compare ??= makeBay();
        mountShip(compare, resolveDef(def), []);
      }
      frame();
      resetView();
    },
    setAutoRotate(on) {
      autoRotate = on;
    },
    zoom(delta) {
      const dir = tmpA.copy(camera.position).sub(controls.target);
      const len = Math.min(controls.maxDistance, Math.max(controls.minDistance, dir.length() * (1 + delta)));
      dir.setLength(len);
      camera.position.copy(controls.target).add(dir);
      controls.update();
    },
    resetView,
    resize,
    screenshot() {
      backend.render(scene, camera);
      return canvas.toDataURL("image/png");
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      ro?.disconnect();
      controls.dispose();
      for (const bay of [main, compare]) {
        bay?.shield?.release();
        bay?.model?.dispose();
      }
      fx.dispose();
      factory.dispose();
      materials.dispose();
      platformGeo.dispose();
      platformMat.dispose();
      ringGeo.dispose();
      ringMat.dispose();
      haloGeo.dispose();
      haloMat.dispose();
      floorGeo.dispose();
      floorMat.dispose();
      grid.dispose();
      if (reflector) {
        reflector.geometry.dispose();
        reflector.dispose();
      }
      key.dispose();
      fill.dispose();
      rimL.dispose();
      rimR.dispose();
      scene.clear();
      backend.dispose();
    },
  };
  return viewer;
}

