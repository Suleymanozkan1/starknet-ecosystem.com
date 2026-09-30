import {
  AmbientLight, CircleGeometry, Color, CylinderGeometry, DirectionalLight, GridHelper, Group, Mesh, MeshBasicMaterial,
  MeshLambertMaterial, MeshStandardMaterial, PerspectiveCamera, Quaternion, Scene, ShadowMaterial, SpotLight, TorusGeometry, Vector3, AdditiveBlending,
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
import { HANGAR_ORBIT, bayWidth, damageLevel, hangarFraming, hangarHomePose, hangarPreviewPlan, zoomedDistance, type HangarPreviewMode } from "./interaction.js";

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
  /** Load production ship GLBs (`visual.glb`) over the procedural meshes. Default true. */
  shipGlbs?: boolean;
  /**
   * Keep the last frame readable (canvas pixel tests). Off by default: it forces an extra buffer copy
   * per frame, which some mobile GPUs answer with flicker.
   */
  preserveDrawingBuffer?: boolean;
  /** Where the Draco decoder is served. Default "/draco/". */
  dracoPath?: string;
}

export interface HangarViewer {
  setShip(def: ShipDef | string): void;
  setCosmetics(cosmetics: readonly (string | CosmeticPayload)[]): void;
  previewEngines(on: boolean): void;
  fireWeapons(): void;
  previewShield(): void;
  previewDamage(pct: number): void;
  /** Drive one preview mode (engines / repeating fire or shield pulses / damage); "idle" stops them. */
  setPreview(mode: HangarPreviewMode): void;
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
  /** Ship id + cosmetics currently mounted (identical remounts are skipped). */
  key: string;
  /** Previous ship, kept on screen until its replacement is ready so the bay never goes empty. */
  outgoing: ShipModel | null;
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

/** Show the procedural ship anyway if its GLB takes longer than this (slow network / failed decode). */
const GLB_REVEAL_TIMEOUT_MS = 2500;
/** Floor / mirror radius: large enough that its rim sits near the horizon at the lowest orbit angle. */
const FLOOR_RADIUS = 160;
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
  const backend: RenderBackend = await createRenderBackend({ canvas, tier, preference: opts.backend ?? "webgl", alpha: opts.transparent ?? false, preserveDrawingBuffer: opts.preserveDrawingBuffer ?? false });
  const scene = new Scene();
  if (!opts.transparent) scene.background = new Color("#05070d");
  if (backend.environment) {
    scene.environment = backend.environment;
    scene.environmentIntensity = 0.55;
  }
  // near/far kept tight (orbit distance 3..90, floor radius FLOOR_RADIUS): mobile GPUs often only have a 16-bit
  // depth buffer, where near = 0.1 made the stacked floor / grid / halo layers z-fight (shimmer).
  const camera = new PerspectiveCamera(35, 1, 0.5, FLOOR_RADIUS * 2.5);
  camera.position.set(9, 5.5, 11);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = HANGAR_ORBIT.dampingFactor;
  controls.enablePan = HANGAR_ORBIT.enablePan;
  controls.minDistance = HANGAR_ORBIT.minDistance;
  controls.maxDistance = HANGAR_ORBIT.maxDistance;
  controls.maxPolarAngle = HANGAR_ORBIT.maxPolarAngle;
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
  // HIGH/ULTRA: one mirror surface (tinted by the Reflector itself) plus a shadow-only plane above it.
  // A semi-transparent floor stacked on the mirror z-fought toward the horizon: a torn, shimmering edge
  // that crawled while the camera/ship turned — the hangar flicker seen on real GPUs.
  // LOW/MEDIUM: a plain opaque floor.
  const floorGroup = new Group();
  scene.add(floorGroup);
  let reflector: Reflector | null = null;
  const floorGeo = new CircleGeometry(FLOOR_RADIUS, 96);
  let floorMat: MeshLambertMaterial | ShadowMaterial;
  if (backend.kind === "webgl" && (tierName === "ULTRA" || tierName === "HIGH")) {
    reflector = new Reflector(new CircleGeometry(FLOOR_RADIUS, 96), { color: new Color("#10131b"), textureWidth: 1024, textureHeight: 1024, clipBias: 0.003 });
    reflector.rotation.x = -Math.PI / 2;
    floorGroup.add(reflector);
    floorMat = new ShadowMaterial({ opacity: 0.45, depthWrite: false });
  } else {
    // Lambert: no environment-map specular. A rough PBR floor still mirrored the bright studio environment
    // at grazing angles (a washed-out teal plane that brightened and dimmed as the view turned).
    floorMat = new MeshLambertMaterial({ color: "#070a12" });
  }
  const floor = new Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  if (reflector) {
    // Shadow plane sits a hair above the mirror and always wins the depth test against it.
    floor.position.y = 0.01;
    floorMat.polygonOffset = true;
    floorMat.polygonOffsetFactor = -2;
    floorMat.polygonOffsetUnits = -2;
  } else {
    // Push the floor back in depth so the grid / platform halo drawn just above it never fight it.
    floorMat.polygonOffset = true;
    floorMat.polygonOffsetFactor = 2;
    floorMat.polygonOffsetUnits = 2;
  }
  floorGroup.add(floor);
  // Local deck grid only: thin lines running out toward the horizon alias into a crawling moiré.
  const grid = new GridHelper(40, 20, 0x1f3550, 0x121a28);
  grid.position.y = 0.03;
  grid.material.depthWrite = false;
  grid.material.transparent = true;
  grid.material.opacity = 0.35;
  floorGroup.add(grid);

  // --- shared runtime ------------------------------------------------------------------------
  const materials = new MaterialLibrary({ textureSize: Math.max(256, tier.textureSize), physical: tier.physicalMaterials, anisotropy: tier.anisotropy });
  // Same production GLBs as the game world (procedural mesh stays as the fallback until/unless they load).
  const glb = opts.shipGlbs === false ? null : new (await import("../ship/glb.js")).GlbLibrary({ dracoPath: opts.dracoPath ?? "/draco/" });
  const factory = new ShipFactory({ materials, greebles: true, lodBias: 50, glb });
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
    halo.position.y = 0.05; // clear of the floor + grid (see the depth notes on the camera)
    discGroup.add(disc, ring, halo);
    platform.add(discGroup);
    root.add(platform);
    scene.add(root);
    return { root, platform, disc: discGroup, model: null, def: null, shield: null, damage: 0, key: "", outgoing: null };
  };
  const main = makeBay();
  let compare: Bay | null = null;
  let cosmetics = resolvePayloads(opts.cosmetics ?? []);
  let engines = true;
  let autoRotate = opts.autoRotate ?? true;

  // Remounting rebuilds the model (and its GLB swap), so identical requests are ignored — React effects
  // re-applying the same ship/cosmetics used to rebuild it up to three times while loading (visible flicker).
  const mountKey = (def: ShipDef, cos: readonly CosmeticPayload[]): string => `${def.id}|${JSON.stringify(cos)}`;
  const mountShip = (bay: Bay, def: ShipDef, cos: readonly CosmeticPayload[]): boolean => {
    const key = mountKey(def, cos);
    if (bay.model && bay.key === key) return false;
    bay.key = key;
    bay.shield?.release();
    bay.shield = null;
    // Keep the currently visible ship until the new one is revealed; one still hidden is simply dropped.
    const prev = bay.model;
    if (prev?.root.visible) {
      bay.outgoing?.dispose();
      bay.outgoing = prev;
    } else {
      prev?.dispose();
    }
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
    // Show the ship once, in its final form: hidden until its production GLB is attached (or failed / slow),
    // instead of popping from the procedural mesh to the GLB.
    model.root.visible = false;
    const reveal = (): void => {
      if (bay.model !== model || model.root.visible) return;
      model.root.visible = true;
      bay.outgoing?.dispose();
      bay.outgoing = null;
    };
    void model.glbReady.then(reveal, reveal);
    setTimeout(reveal, GLB_REVEAL_TIMEOUT_MS);
    return true;
  };

  const widthOf = (bay: Bay | null): number | null => (bay?.model ? bayWidth(bay.model.length, bay.model.radius) : null);
  const frame = (): void => {
    const f = hangarFraming(widthOf(main), widthOf(compare), compare !== null);
    main.root.position.x = f.mainX;
    if (compare && f.compareX !== null) compare.root.position.x = f.compareX;
    controls.minDistance = f.minDistance;
    controls.maxDistance = f.maxDistance;
    key.shadow.camera.far = f.shadowFar;
  };

  const resetView = (): void => {
    const pose = hangarHomePose(main.model ? { length: main.model.length, radius: main.model.radius } : null, compare !== null);
    camera.position.set(...pose.position);
    controls.target.set(...pose.target);
    controls.update();
  };

  mountShip(main, resolveDef(opts.shipDef), cosmetics);
  frame();
  resetView();

  // --- sizing & loop ---------------------------------------------------------------------
  // Writing canvas.width/height wipes the drawing buffer, so the canvas is only resized when its size really
  // changed, and the next frame is drawn immediately — otherwise the browser composites the blank buffer
  // until the next animation frame (the ship "blinks" whenever the layout around the hangar settles).
  let sized = "";
  let disposed = false;
  const resize = (): void => {
    const w = Math.max(1, canvas.clientWidth), h = Math.max(1, canvas.clientHeight);
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    const ratio = Math.min(dpr, tier.maxPixelRatio);
    const next = `${w}x${h}@${ratio}`;
    if (next === sized) return;
    const first = sized === "";
    sized = next;
    backend.setPixelRatio(ratio);
    backend.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    fx.setViewport(h * backend.pixelRatio, (camera.fov * Math.PI) / 180);
    reflector?.getRenderTarget().setSize(Math.min(1024, w), Math.min(1024, h));
    if (!first && !disposed) backend.render(scene, camera);
  };
  resize();
  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => resize()) : null;
  ro?.observe(canvas);

  let raf = 0;
  let previewTimer: ReturnType<typeof setInterval> | null = null;
  let last = -1;
  let time = 0;
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
      if (!mountShip(main, resolveDef(def), cosmetics)) return;
      frame();
      resetView();
    },
    setCosmetics(list) {
      cosmetics = resolvePayloads(list);
      if (main.def && mountShip(main, main.def, cosmetics)) frame();
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
      const v = damageLevel(pct);
      for (const bay of [main, compare]) if (bay) bay.damage = v;
    },
    setPreview(mode) {
      if (previewTimer !== null) clearInterval(previewTimer);
      previewTimer = null;
      const plan = hangarPreviewPlan(mode);
      viewer.previewEngines(plan.engines);
      viewer.previewDamage(plan.damage);
      if (plan.pulse) {
        const pulse = plan.pulse === "fire" ? () => viewer.fireWeapons() : () => viewer.previewShield();
        pulse();
        previewTimer = setInterval(pulse, plan.intervalMs);
      }
    },
    setCompare(def) {
      if (!def) {
        if (compare) {
          compare.shield?.release();
          compare.model?.dispose();
          compare.outgoing?.dispose();
          compare.root.removeFromParent();
          compare = null;
        }
      } else {
        compare ??= makeBay();
        if (!mountShip(compare, resolveDef(def), [])) return;
      }
      frame();
      resetView();
    },
    setAutoRotate(on) {
      autoRotate = on;
    },
    zoom(delta) {
      const dir = tmpA.copy(camera.position).sub(controls.target);
      dir.setLength(zoomedDistance(dir.length(), delta, controls.minDistance, controls.maxDistance));
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
      if (previewTimer !== null) clearInterval(previewTimer);
      ro?.disconnect();
      controls.dispose();
      for (const bay of [main, compare]) {
        bay?.shield?.release();
        bay?.model?.dispose();
        bay?.outgoing?.dispose();
      }
      fx.dispose();
      factory.dispose();
      glb?.dispose();
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

