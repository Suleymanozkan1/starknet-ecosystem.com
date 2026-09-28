import {
  AmbientLight, BufferGeometry, Color, DirectionalLight, Float32BufferAttribute, FogExp2, Group, HemisphereLight,
  LineBasicMaterial, LineLoop, Plane, Raycaster, Scene, Vector2, Vector3, Quaternion,
} from "three";
import type { EntityKind, GraphicsTier, MapDef, Rarity, ZoneType } from "@nebula/shared";
import { EntityFlag, RARITIES } from "@nebula/shared";
import { DRONES_BY_ID, NPCS_BY_ID, SHIPS_BY_ID } from "@nebula/config";
import { AdaptiveResolution, type BackendPreference, type RenderBackend, createRenderBackend } from "./core/backend.js";
import { TIER_SETTINGS, type TierSettings } from "./core/tiers.js";
import { createRng, hashString } from "./core/random.js";
import { FollowCamera } from "./camera/FollowCamera.js";
import { EffectsSystem, type WeaponVisualStyle } from "./fx/EffectsSystem.js";
import type { Trail } from "./fx/trails.js";
import type { ShieldHandle } from "./fx/shield.js";
import type { BeamHandle } from "./fx/beams.js";
import { WarpTunnel } from "./fx/warp.js";
import { MaterialLibrary } from "./ship/materials.js";
import { ShipFactory, type ShipModel } from "./ship/ShipFactory.js";
import { npcVisual, parseCosmeticIds, resolveCosmeticPayloads } from "./ship/cosmetics.js";
import { BossVisual, type BossLayer } from "./npc/BossVisual.js";
import { DroneFactory } from "./npc/drones.js";
import { SpaceBackground } from "./world/background.js";
import { AsteroidLayer, RESOURCE_COLORS } from "./world/asteroids.js";
import { LootLayer } from "./world/loot.js";
import { PortalVisual } from "./world/portal.js";
import { StationVisual } from "./world/station.js";
import { buildMapDecor, type DecorItem } from "./world/decor.js";

/** Per-frame render input for one entity (reuse the object — no per-frame allocation needed). */
export interface EntityRenderInput {
  id: string;
  kind: EntityKind;
  defId: string;
  cosmetics: string;
  x: number;
  y: number;
  heading: number;
  vx: number;
  vy: number;
  hull: number;
  maxHull: number;
  shield: number;
  maxShield: number;
  flags: number;
  cloaked: boolean;
  dead: boolean;
  targetId: string;
}

export interface WorldRendererOptions {
  canvas: HTMLCanvasElement;
  tier: GraphicsTier;
  backend?: BackendPreference;
  /** Keep the drawing buffer for screenshots. */
  preserveDrawingBuffer?: boolean;
}

export interface FrameStats {
  fps: number;
  frameMs: number;
  drawCalls: number;
  triangles: number;
  pixelRatio: number;
  entities: number;
}

interface ShipVisualEntry {
  type: "ship";
  id: string;
  kind: EntityKind;
  root: Group;
  model: ShipModel;
  boss: BossVisual | null;
  trails: Trail[];
  trailNozzles: number[];
  shield: ShieldHandle | null;
  mining: BeamHandle | null;
  maxSpeed: number;
  lastHeading: number;
  roll: number;
  hullFrac: number;
  wasDead: boolean;
  wasCloaked: boolean;
  isLocal: boolean;
  bob: number;
  length: number;
  visibleCloaked: boolean;
}

interface SimpleEntry {
  type: "asteroid" | "loot" | "portal" | "projectile" | "drone" | "station";
  id: string;
  kind: EntityKind;
  root: Group | null;
  dispose?: () => void;
}

type Entry = ShipVisualEntry | SimpleEntry;

const ZONE_COLORS: Readonly<Record<ZoneType, string>> = {
  SAFE: "#38d98a", NEUTRAL: "#8da3c4", PVP: "#ff4d4d", HIGH_RISK: "#ff2d55", PIRATE: "#ff8c42", EVENT: "#ffd166",
  BOSS: "#c77dff", GATE: "#4cc9f0", MINING: "#ffd166",
};

const tmpV = new Vector3();
const tmpV2 = new Vector3();
const tmpV3 = new Vector3();
const tmpQ = new Quaternion();
const X_AXIS = new Vector3(1, 0, 0);
const ndc = new Vector2();
const GROUND = new Plane(new Vector3(0, 1, 0), 0);

/**
 * High-level 3D world renderer used by the game client. Owns the scene, camera,
 * effects, map layer and per-entity visuals. Map coordinates (x, y) map to world (X, Z).
 */
export class WorldRenderer {
  readonly scene = new Scene();
  readonly camera: FollowCamera;
  readonly fx: EffectsSystem;
  readonly factory: ShipFactory;
  readonly materials: MaterialLibrary;
  readonly backend: RenderBackend;
  private tier: TierSettings;
  private readonly background: SpaceBackground;
  private readonly asteroids: AsteroidLayer;
  private readonly loot: LootLayer;
  private readonly drones: DroneFactory;
  private readonly warp = new WarpTunnel();
  private readonly mapLayer = new Group();
  private readonly entityLayer = new Group();
  private readonly entries = new Map<string, Entry>();
  private readonly portals = new Map<string, PortalVisual>();
  private readonly stations = new Map<string, StationVisual>();
  private decor: DecorItem[] = [];
  private readonly zoneLines: LineLoop[] = [];
  private readonly key: DirectionalLight;
  private readonly rim: DirectionalLight;
  private readonly hemi: HemisphereLight;
  private readonly ambient: AmbientLight;
  private readonly adaptive: AdaptiveResolution;
  private readonly raycaster = new Raycaster();
  private readonly lootRarity = new Map<string, Rarity>();
  private width = 1;
  private height = 1;
  private time = 0;
  private lastNow = -1;
  private fpsAcc = 0;
  private fpsFrames = 0;
  private fps = 60;
  private frameMs = 16;
  private mapDef: MapDef | null = null;
  private disposed = false;
  localId: string | null = null;
  /** Show cloaked enemies (scanned). */
  revealCloaked = new Set<string>();

  private constructor(backend: RenderBackend, tier: TierSettings) {
    this.backend = backend;
    this.tier = tier;
    this.materials = new MaterialLibrary({ textureSize: tier.textureSize, physical: tier.physicalMaterials, anisotropy: tier.anisotropy });
    this.factory = new ShipFactory({ materials: this.materials, greebles: tier.greebles, lodBias: tier.lodBias });
    this.drones = new DroneFactory(this.materials);
    this.camera = new FollowCamera(1);
    this.fx = new EffectsSystem(tier);
    this.fx.onShake = (amount, x, z) => {
      const f = this.camera.focusPoint;
      const d = Math.hypot(f.x - x, f.z - z);
      const k = Math.max(0, 1 - d / 120);
      if (k > 0) this.camera.addShake(amount * k);
    };
    this.background = new SpaceBackground({ starCount: TIER_SETTINGS.ULTRA.starCount, dustCount: TIER_SETTINGS.ULTRA.dustCount, pixelRatio: 1 });
    this.asteroids = new AsteroidLayer(160, tier.asteroidDetail);
    this.loot = new LootLayer(160);
    this.adaptive = new AdaptiveResolution({ min: tier.minPixelRatio, max: this.maxRatio(tier), targetFps: tier.targetFps });

    this.scene.background = new Color("#02030a");
    if (backend.environment) {
      this.scene.environment = backend.environment;
      this.scene.environmentIntensity = 0.4;
    }
    this.hemi = new HemisphereLight("#9fc5ff", "#0a0c14", 0.6);
    this.ambient = new AmbientLight("#1a2030", 0.4);
    this.key = new DirectionalLight("#fff4e0", 2.1);
    this.key.position.set(-60, 120, -40);
    this.key.castShadow = tier.shadows;
    this.key.shadow.mapSize.set(tier.shadowMapSize, tier.shadowMapSize);
    const sc = this.key.shadow.camera;
    sc.left = -70; sc.right = 70; sc.top = 70; sc.bottom = -70; sc.near = 10; sc.far = 400;
    this.key.shadow.bias = -0.0008;
    this.key.shadow.normalBias = 0.04;
    this.rim = new DirectionalLight("#6ee7ff", 0.9);
    this.rim.position.set(70, 40, 90);
    this.scene.add(this.hemi, this.ambient, this.key, this.key.target, this.rim);
    this.scene.add(this.background.group, this.mapLayer, this.asteroids.group, this.loot.group, this.entityLayer, this.fx.group, this.warp.mesh);
    this.applyTierToBackend(tier);
  }

  static async create(opts: WorldRendererOptions): Promise<WorldRenderer> {
    const tier = TIER_SETTINGS[opts.tier];
    const backend = await createRenderBackend({ canvas: opts.canvas, tier, preference: opts.backend ?? "webgl", preserveDrawingBuffer: opts.preserveDrawingBuffer });
    const w = new WorldRenderer(backend, tier);
    const rect = opts.canvas.getBoundingClientRect();
    w.resize(Math.max(1, rect.width), Math.max(1, rect.height));
    return w;
  }

  private maxRatio(t: TierSettings): number {
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    return Math.min(t.maxPixelRatio, dpr);
  }

  private applyTierToBackend(t: TierSettings): void {
    this.backend.setTier(t);
    this.adaptive.configure(t.minPixelRatio, this.maxRatio(t), t.targetFps);
    this.adaptive.ratio = this.maxRatio(t);
    this.backend.setPixelRatio(this.adaptive.ratio);
    this.background.setPixelRatio(this.adaptive.ratio);
    this.key.castShadow = t.shadows;
    this.fx.setTier(t);
    this.factory.setGreebles(t.greebles);
    this.factory.lodBias = t.lodBias;
  }

  get tierSettings(): TierSettings {
    return this.tier;
  }

  setTier(tier: GraphicsTier): void {
    this.tier = TIER_SETTINGS[tier];
    this.applyTierToBackend(this.tier);
    this.resize(this.width, this.height);
  }

  setAdaptiveResolution(on: boolean): void {
    this.adaptive.enabled = on;
  }

  resize(w: number, h: number): void {
    this.width = Math.max(1, Math.floor(w));
    this.height = Math.max(1, Math.floor(h));
    this.backend.setSize(this.width, this.height);
    this.camera.setAspect(this.width / this.height);
    this.fx.setViewport(this.height * this.backend.pixelRatio, (this.camera.camera.fov * Math.PI) / 180);
  }

  get viewport(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  // ------------------------------------------------------------------------------ map

  setMap(map: MapDef): void {
    this.clearMap();
    this.mapDef = map;
    const env = map.environment;
    this.background.setEnvironment(env, map.id);
    this.hemi.color.set(env.ambient);
    this.rim.color.set(env.nebulaColors[1] ?? "#6ee7ff");
    this.scene.fog = new FogExp2(new Color(env.nebulaColors[0] ?? "#000000").multiplyScalar(0.4), 0.0012 + env.fog * 0.0025);
    // stations
    for (const st of map.stations) {
      const color = env.nebulaColors[1] ?? "#6ee7ff";
      const v = new StationVisual(this.materials, { id: st.id, palette: { primary: "#6c7382", secondary: "#3a404c", accent: color, engine: color }, scale: 1 });
      v.root.position.set(st.x, -1.5, st.y);
      this.mapLayer.add(v.root);
      this.stations.set(st.id, v);
    }
    // portals
    for (const p of map.portals) {
      const v = new PortalVisual(p.kind, this.materials, p.kind === "JUMP_GATE" || p.kind === "WARP_GATE" ? 7 : 5.5);
      v.root.position.set(p.x, -0.5, p.y);
      this.mapLayer.add(v.root);
      this.portals.set(p.id, v);
    }
    // decor
    this.decor = buildMapDecor(map, { factory: this.factory, lib: this.materials, light: this.key.position.clone().normalize() });
    for (const d of this.decor) this.mapLayer.add(d.root);
    // zones: faint ground circles
    for (const z of map.zones) {
      const pts: number[] = [];
      const n = Math.max(48, Math.round(z.radius * 1.5));
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        pts.push(z.x + Math.cos(a) * z.radius, -0.6, z.y + Math.sin(a) * z.radius);
      }
      const g = new BufferGeometry();
      g.setAttribute("position", new Float32BufferAttribute(pts, 3));
      const line = new LineLoop(g, new LineBasicMaterial({ color: ZONE_COLORS[z.type], transparent: true, opacity: z.type === "NEUTRAL" ? 0.08 : 0.22, depthWrite: false }));
      this.zoneLines.push(line);
      this.mapLayer.add(line);
    }
    // map boundary
    const b = new BufferGeometry();
    b.setAttribute("position", new Float32BufferAttribute([0, -0.6, 0, map.width, -0.6, 0, map.width, -0.6, map.height, 0, -0.6, map.height], 3));
    const border = new LineLoop(b, new LineBasicMaterial({ color: "#ff4d6d", transparent: true, opacity: 0.35 }));
    this.zoneLines.push(border);
    this.mapLayer.add(border);
    this.fx.clear();
  }

  get map(): MapDef | null {
    return this.mapDef;
  }

  private clearMap(): void {
    for (const p of this.portals.values()) p.dispose();
    this.portals.clear();
    for (const s of this.stations.values()) s.dispose();
    this.stations.clear();
    for (const d of this.decor) d.dispose();
    this.decor = [];
    for (const l of this.zoneLines) {
      l.removeFromParent();
      l.geometry.dispose();
      (l.material as LineBasicMaterial).dispose();
    }
    this.zoneLines.length = 0;
    for (const id of [...this.entries.keys()]) this.removeEntity(id, false);
    this.asteroids.clear();
    this.loot.clear();
    this.lootRarity.clear();
    this.factory.trim();
  }

  setPortalActive(portalId: string, on: boolean): void {
    this.portals.get(portalId)?.setActive(on);
  }

  // ------------------------------------------------------------------------------ entities

  /** Create/update the visual for an entity from interpolated state. */
  syncEntity(e: EntityRenderInput, dt: number): void {
    let entry = this.entries.get(e.id);
    if (!entry) {
      const created = this.createEntry(e);
      if (!created) return;
      entry = created;
      this.entries.set(e.id, entry);
    }
    if (entry.type === "ship") this.updateShip(entry, e, dt);
    else this.updateSimple(entry, e);
  }

  /** Extra display scale for an entity visual (UI previews / showcase). */
  setDisplayScale(id: string, scale: number): void {
    const e = this.entries.get(id);
    if (e?.type === "ship") e.root.scale.setScalar(scale);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  private createEntry(e: EntityRenderInput): Entry | null {
    switch (e.kind) {
      case "PLAYER":
      case "NPC":
      case "BOSS":
        return this.createShip(e);
      case "ASTEROID": {
        const res = e.defId.toUpperCase();
        const r = 1.2 + (hashString(e.id) % 100) / 100 * 1.6 + Math.min(2, Math.sqrt(Math.max(0, e.maxHull)) / 40);
        this.asteroids.add(e.id, e.x, -0.2, e.y, r, res in RESOURCE_COLORS ? res : null);
        return { type: "asteroid", id: e.id, kind: e.kind, root: null };
      }
      case "LOOT": {
        const up = e.defId.toUpperCase();
        const rarity = (RARITIES as readonly string[]).includes(up) ? (up as Rarity) : this.lootRarity.get(e.id) ?? "COMMON";
        this.loot.add(e.id, e.x, e.y, rarity);
        return { type: "loot", id: e.id, kind: e.kind, root: null };
      }
      case "PORTAL": {
        if (this.portals.has(e.id)) return { type: "portal", id: e.id, kind: e.kind, root: null };
        const v = new PortalVisual("PORTAL", this.materials, 5.5);
        v.root.position.set(e.x, -0.5, e.y);
        this.mapLayer.add(v.root);
        this.portals.set(e.id, v);
        return { type: "portal", id: e.id, kind: e.kind, root: null, dispose: () => { v.dispose(); this.portals.delete(e.id); } };
      }
      case "STATION":
        return { type: "station", id: e.id, kind: e.kind, root: null };
      case "DRONE": {
        const def = DRONES_BY_ID.get(e.defId);
        const g = this.drones.create(def?.visual.shape ?? "orb", def?.visual.color ?? "#6ee7ff");
        const root = new Group();
        root.add(g);
        this.entityLayer.add(root);
        return { type: "drone", id: e.id, kind: e.kind, root, dispose: () => root.removeFromParent() };
      }
      case "PROJECTILE": {
        const root = new Group();
        this.entityLayer.add(root);
        return { type: "projectile", id: e.id, kind: e.kind, root, dispose: () => root.removeFromParent() };
      }
    }
    return null;
  }

  private createShip(e: EntityRenderInput): ShipVisualEntry | null {
    const isLocal = e.id === this.localId;
    let model: ShipModel;
    let boss: BossVisual | null = null;
    let maxSpeed = 30;
    let root: Group;
    if (e.kind === "PLAYER") {
      const def = SHIPS_BY_ID.get(e.defId);
      if (!def) return null;
      const cosmetics = resolveCosmeticPayloads(parseCosmeticIds(e.cosmetics));
      model = this.factory.createFromDef(def, { cosmetics });
      maxSpeed = def.stats.speed;
      root = model.root;
    } else {
      const npc = NPCS_BY_ID.get(e.defId);
      if (!npc) return null;
      maxSpeed = npc.speed;
      if (e.kind === "BOSS" || npc.kind === "BOSS") {
        boss = new BossVisual(this.factory, npc);
        boss.onPlateBlown = (p) => this.fx.explosion(p, 1.5);
        model = boss.model;
        root = boss.root;
      } else {
        model = this.factory.create(npcVisual(npc), { shipId: npc.id });
        root = model.root;
      }
    }
    this.entityLayer.add(root);
    // pick up to two trail nozzles (outermost)
    const nz = model.sockets.nozzles;
    const order = nz.map((n, i) => ({ i, x: n[0] })).sort((a, b) => Math.abs(b.x) - Math.abs(a.x));
    const trailNozzles = nz.length <= 1 ? [0] : [order[0]?.i ?? 0, order[1]?.i ?? 1];
    const entry: ShipVisualEntry = {
      type: "ship", id: e.id, kind: e.kind, root, model, boss, trails: [], trailNozzles, shield: null, mining: null,
      maxSpeed: Math.max(1, maxSpeed), lastHeading: e.heading, roll: 0, hullFrac: 1, wasDead: e.dead, wasCloaked: false,
      isLocal, bob: (hashString(e.id) % 628) / 100, length: model.length, visibleCloaked: false,
    };
    if (e.maxShield > 0) {
      const size = model.lod.levels[0]?.object ? this.shieldSize(model) : new Vector3(2, 1, 2);
      const look = model.look;
      entry.shield = this.fx.shields.attach(root, size, look.shield?.color ?? model.palette.accent, look.shield?.effect, false);
    }
    root.position.set(e.x, 0, e.y);
    root.rotation.y = Math.PI / 2 - e.heading;
    if (e.dead) root.visible = false;
    return entry;
  }

  private shieldSize(model: ShipModel): Vector3 {
    const r = model.radius;
    return new Vector3(Math.max(r * 0.9, model.length * 0.45), Math.max(0.6, r * 0.45), model.length * 0.62);
  }

  private startTrails(entry: ShipVisualEntry): void {
    if (entry.trails.length > 0) return;
    const look = entry.model.look;
    const colors = look.trail?.colors ?? [entry.model.palette.engine];
    for (const ni of entry.trailNozzles) {
      entry.model.nozzleWorld(ni, tmpV);
      const radius = entry.model.sockets.nozzleRadius[ni] ?? 0.2;
      const t = this.fx.trails.acquire({ color: colors[0] ?? "#ffffff", color2: colors[1], width: Math.max(0.25, radius * 1.8), effect: look.trail?.effect }, tmpV);
      if (t) entry.trails.push(t);
    }
  }

  private stopTrails(entry: ShipVisualEntry): void {
    for (const t of entry.trails) this.fx.trails.release(t);
    entry.trails.length = 0;
  }

  private updateShip(s: ShipVisualEntry, e: EntityRenderInput, dt: number): void {
    const root = s.root;
    // death handling
    if (e.dead) {
      if (!s.wasDead) this.shipDestroyed(s);
      s.wasDead = true;
      root.visible = false;
      return;
    }
    if (s.wasDead) {
      // respawn
      s.wasDead = false;
      root.visible = true;
      this.fx.warpFlash(tmpV.set(e.x, 0, e.y), Math.cos(e.heading), Math.sin(e.heading), s.model.palette.engine, 1);
    }
    const docked = (e.flags & EntityFlag.DOCKED) !== 0;
    const hiddenCloak = e.cloaked && !s.isLocal && !this.revealCloaked.has(e.id);
    root.visible = !docked && !hiddenCloak;
    const showShimmer = e.cloaked && !hiddenCloak;
    if (showShimmer !== s.visibleCloaked) {
      s.model.overrideMaterial(showShimmer ? this.fx.cloakMaterial : null);
      s.visibleCloaked = showShimmer;
    }
    if (e.cloaked !== s.wasCloaked) {
      this.fx.energyPulse(tmpV.set(e.x, 0, e.y), s.length * 0.8, "#9ad7ff");
      s.wasCloaked = e.cloaked;
    }
    if (!root.visible) {
      this.stopTrails(s);
      s.mining?.release();
      s.mining = null;
      return;
    }

    // transform
    const bob = Math.sin(this.time * 1.3 + s.bob) * 0.08 * Math.min(2, s.length / 3);
    root.position.set(e.x, bob, e.y);
    let dh = e.heading - s.lastHeading;
    if (dh > Math.PI) dh -= Math.PI * 2;
    if (dh < -Math.PI) dh += Math.PI * 2;
    s.lastHeading = e.heading;
    const turnRate = dt > 0 ? dh / dt : 0;
    const targetRoll = Math.max(-0.55, Math.min(0.55, turnRate * 0.18));
    s.roll += (targetRoll - s.roll) * Math.min(1, dt * 5);
    root.rotation.set(0, Math.PI / 2 - e.heading, 0);
    tmpQ.setFromAxisAngle(tmpV3.set(0, 0, 1), s.roll);
    root.quaternion.multiply(tmpQ);
    if (s.boss) s.boss.update(this.time, dt);

    // engines & trails
    const speed = Math.hypot(e.vx, e.vy);
    const boosting = (e.flags & EntityFlag.BOOSTING) !== 0;
    s.model.setThrust(speed / s.maxSpeed, boosting);
    root.updateMatrixWorld();
    if (speed > s.maxSpeed * 0.08 && !s.visibleCloaked) this.startTrails(s);
    else if (speed < s.maxSpeed * 0.03) this.stopTrails(s);
    for (let i = 0; i < s.trails.length; i++) {
      const t = s.trails[i];
      if (!t) continue;
      s.model.nozzleWorld(s.trailNozzles[i] ?? 0, tmpV);
      t.setHead(tmpV);
    }
    if (boosting) {
      s.model.nozzleWorld(s.trailNozzles[0] ?? 0, tmpV);
      this.fx.boostSparks(tmpV, Math.cos(e.heading), Math.sin(e.heading), s.model.palette.engine, dt);
    }

    // shields & damage
    s.hullFrac = e.maxHull > 0 ? e.hull / e.maxHull : 1;
    if (s.shield) s.shield.setLevel(e.maxShield > 0 ? e.shield / e.maxShield : 0);
    if (s.hullFrac < 0.7) {
      s.model.socketWorld(s.model.sockets.core, tmpV);
      this.fx.damageEmit(tmpV, s.hullFrac, dt, s.length);
    }
    if ((e.flags & EntityFlag.STUNNED) !== 0 && Math.random() < dt * 20) {
      this.fx.impact(tmpV.set(e.x + (Math.random() - 0.5) * s.length, 0.4, e.y + (Math.random() - 0.5) * s.length), "#56cfe1", 0.4);
    }

    // mining beam
    const mining = (e.flags & EntityFlag.MINING) !== 0 && e.targetId !== "" ? this.asteroids.get(e.targetId) : undefined;
    if (mining) {
      if (!s.mining) s.mining = this.fx.beams.hold("#f4d35e", 0.3, "arc");
      s.model.muzzleWorld(0, tmpV);
      tmpV2.set(mining.x, mining.y + 0.3, mining.z);
      s.mining?.set(tmpV, tmpV2);
      this.fx.miningChips(tmpV2, "#c9d6ea", dt);
    } else if (s.mining) {
      s.mining.release();
      s.mining = null;
    }
  }

  private updateSimple(entry: SimpleEntry, e: EntityRenderInput): void {
    switch (entry.type) {
      case "asteroid":
        this.asteroids.setPosition(e.id, e.x, -0.2, e.y);
        return;
      case "drone":
      case "projectile":
        if (entry.root) {
          entry.root.position.set(e.x, 0.3, e.y);
          entry.root.rotation.y = Math.PI / 2 - e.heading;
        }
        return;
      default:
        return;
    }
  }

  private shipDestroyed(s: ShipVisualEntry): void {
    s.model.socketWorld(s.model.sockets.core, tmpV);
    const ex = s.model.look.explosion;
    this.fx.explosion(tmpV, s.length / 3, ex?.colors, ex?.effect);
    this.stopTrails(s);
    s.mining?.release();
    s.mining = null;
  }

  /** Remove an entity visual. `explode` plays the destruction effect first. */
  removeEntity(id: string, explode = false): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    if (entry.type === "ship") {
      if (explode && entry.root.visible) this.shipDestroyed(entry);
      this.stopTrails(entry);
      entry.shield?.release();
      entry.mining?.release();
      if (entry.boss) entry.boss.dispose();
      else entry.model.dispose();
      return;
    }
    switch (entry.type) {
      case "asteroid":
        if (explode) {
          const a = this.asteroids.get(id);
          if (a) this.fx.debris.burst(a.x, a.y, a.z, 10, 6, a.r * 0.25, "#8d99ae", createRng(id));
        }
        this.asteroids.remove(id);
        break;
      case "loot":
        this.loot.remove(id);
        this.lootRarity.delete(id);
        break;
      default:
        entry.dispose?.();
    }
  }

  setBossPhase(id: string, layer: BossLayer): void {
    const e = this.entries.get(id);
    if (e?.type === "ship" && e.boss) {
      e.boss.setPhase(layer);
      if (layer === "ENRAGE") this.fx.emp(e.root.position, e.length * 0.9, "#ff2d55");
    }
  }

  /** World position of an entity (map coords → out.x / out.z), false if unknown. */
  entityWorld(id: string, out: Vector3): boolean {
    const e = this.entries.get(id);
    if (!e) return false;
    if (e.type === "ship") {
      out.copy(e.root.position);
      return true;
    }
    if (e.type === "asteroid") {
      const a = this.asteroids.get(id);
      if (!a) return false;
      out.set(a.x, a.y, a.z);
      return true;
    }
    if (e.root) {
      out.copy(e.root.position);
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------------------ events → FX

  rememberLootRarity(lootId: string, rarity: Rarity): void {
    this.lootRarity.set(lootId, rarity);
  }

  /** Server AttackEvent → projectile/beam visuals. Map coordinates. */
  attack(sourceId: string, fromX: number, fromY: number, toX: number, toY: number, color: string, style: WeaponVisualStyle | string, travelMs: number, hit: boolean): void {
    const src = this.entries.get(sourceId);
    if (src?.type === "ship" && src.root.visible) {
      src.model.muzzleWorld(Math.floor(Math.random() * Math.max(1, src.model.sockets.muzzles.length)), tmpV);
    } else {
      tmpV.set(fromX, 0.4, fromY);
    }
    tmpV2.set(toX, 0.4, toY);
    this.fx.fire(tmpV, tmpV2, color, style, travelMs / 1000, hit);
  }

  /** Server DamageEvent → shield ripple or hull sparks. */
  damage(targetId: string, x: number, y: number, shieldDamage: number, hullDamage: number, crit: boolean): void {
    const t = this.entries.get(targetId);
    tmpV.set(x, 0.4, y);
    if (t?.type === "ship") {
      if (shieldDamage > 0 && t.shield) t.shield.hit(tmpV, this.time);
      if (hullDamage > 0) this.fx.impact(tmpV, crit ? "#ffe066" : "#ff9a3c", crit ? 1.4 : 0.9);
      if (t.isLocal && hullDamage > 0) this.camera.addShake(crit ? 0.3 : 0.12);
    } else {
      this.fx.impact(tmpV, "#ffffff", 0.6);
    }
  }

  /** Server EffectEvent. */
  effect(kind: string, x: number, y: number, radius: number, sourceId: string): void {
    tmpV.set(x, 0.3, y);
    const src = this.entries.get(sourceId);
    const color = src?.type === "ship" ? src.model.palette.accent : "#6ee7ff";
    switch (kind) {
      case "EMP": this.fx.emp(tmpV, radius, "#56cfe1"); break;
      case "WARP": this.fx.warpFlash(tmpV, 1, 0, "#b388ff", Math.max(1, radius / 20)); break;
      case "SHIELD_BURST": this.fx.energyPulse(tmpV, radius || 6, "#4cc9f0"); break;
      case "HEAL": this.fx.energyPulse(tmpV, radius || 6, "#52ffa8"); break;
      case "CLOAK": this.fx.energyPulse(tmpV, radius || 4, "#9ad7ff"); break;
      case "BARRAGE": this.fx.telegraph(tmpV, radius, "#ff5d3a", 0.6, () => this.fx.explosion(tmpV3.set(x, 0.3, y), Math.max(1, radius / 6))); break;
      case "DASH": this.fx.warpFlash(tmpV, 1, 0, color, 0.8); break;
      case "MINING": this.fx.miningChips(tmpV, "#f4d35e", 0.2); break;
      case "ENRAGE": this.fx.emp(tmpV, radius || 30, "#ff2d55"); break;
      default: this.fx.energyPulse(tmpV, radius || 5, color);
    }
  }

  /** Boss special-attack telegraph. */
  telegraph(x: number, y: number, radius: number, color: string, durationMs: number, onDone?: () => void): void {
    this.fx.telegraph(tmpV.set(x, 0.05, y), radius, color, durationMs / 1000, onDone);
  }

  /** Death event at a position without a known visual. */
  explosionAt(x: number, y: number, scale: number): void {
    this.fx.explosion(tmpV.set(x, 0.3, y), scale);
  }

  setWarp(on: boolean, color?: string): void {
    this.warp.set(on, color);
  }

  // ------------------------------------------------------------------------------ picking / projection

  /** Screen pixel (relative to canvas) → map coordinates on the play plane. */
  screenToMap(sx: number, sy: number, out: { x: number; y: number }): boolean {
    ndc.set((sx / this.width) * 2 - 1, -(sy / this.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera.camera);
    const hit = this.raycaster.ray.intersectPlane(GROUND, tmpV3);
    if (!hit) return false;
    out.x = hit.x;
    out.y = hit.z;
    return true;
  }

  /** Map coordinates → screen pixels. Returns false when behind the camera / off-screen. */
  mapToScreen(x: number, y: number, out: { x: number; y: number }, height = 0): boolean {
    tmpV3.set(x, height, y).project(this.camera.camera);
    out.x = (tmpV3.x * 0.5 + 0.5) * this.width;
    out.y = (-tmpV3.y * 0.5 + 0.5) * this.height;
    return tmpV3.z < 1 && tmpV3.x >= -1.2 && tmpV3.x <= 1.2 && tmpV3.y >= -1.2 && tmpV3.y <= 1.2;
  }

  /** World units per screen pixel at the focus point (for overlay scaling). */
  get unitsPerPixel(): number {
    const cam = this.camera.camera;
    const d = cam.position.distanceTo(this.camera.focusPoint);
    return (2 * d * Math.tan((cam.fov * Math.PI) / 360)) / this.height;
  }

  // ------------------------------------------------------------------------------ frame

  /** Advance & render one frame. `now` in milliseconds (rAF timestamp). */
  frame(now: number): FrameStats {
    const dt = this.lastNow < 0 ? 1 / 60 : Math.min(0.1, Math.max(0, (now - this.lastNow) / 1000));
    this.lastNow = now;
    this.time += dt;
    const t = this.time;
    this.camera.update(dt);
    const focus = this.camera.focusPoint;
    // shadow camera follows the focus
    this.key.position.set(focus.x - 60, 120, focus.z - 40);
    this.key.target.position.set(focus.x, 0, focus.z);
    this.key.target.updateMatrixWorld();
    this.background.update(this.camera.camera.position, t);
    this.factory.update(t);
    this.asteroids.update(t);
    this.loot.update(t);
    for (const p of this.portals.values()) p.update(t, dt);
    for (const s of this.stations.values()) s.update(t);
    for (const d of this.decor) d.update(t);
    this.fx.update(t, dt);
    if (this.warp.active) {
      const cam = this.camera.camera;
      this.warp.mesh.position.copy(cam.position);
      tmpQ.setFromAxisAngle(X_AXIS, Math.PI / 2);
      this.warp.mesh.quaternion.copy(cam.quaternion).multiply(tmpQ);
    }
    this.warp.update(t, dt);
    this.backend.render(this.scene, this.camera.camera);

    // stats + adaptive resolution
    this.fpsAcc += dt;
    this.fpsFrames++;
    if (this.fpsAcc >= 0.5) {
      this.fps = this.fpsFrames / this.fpsAcc;
      this.fpsAcc = 0;
      this.fpsFrames = 0;
    }
    this.frameMs = dt * 1000;
    const r = this.adaptive.sample(this.frameMs);
    if (r !== null) {
      this.backend.setPixelRatio(r);
      this.background.setPixelRatio(r);
      this.resize(this.width, this.height);
    }
    const info = this.backend.webgl?.info.render;
    return {
      fps: this.fps,
      frameMs: this.frameMs,
      drawCalls: info?.calls ?? 0,
      triangles: info?.triangles ?? 0,
      pixelRatio: this.backend.pixelRatio,
      entities: this.entries.size,
    };
  }

  get elapsed(): number {
    return this.time;
  }

  /** Current canvas as PNG data URL (requires preserveDrawingBuffer or call right after frame()). */
  screenshot(): string {
    return this.backend.renderer.domElement.toDataURL("image/png");
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearMap();
    this.asteroids.dispose();
    this.loot.dispose();
    this.fx.dispose();
    this.warp.dispose();
    this.background.dispose();
    this.drones.dispose();
    this.factory.dispose();
    this.materials.dispose();
    this.key.dispose();
    this.rim.dispose();
    this.hemi.dispose();
    this.ambient.dispose();
    this.scene.clear();
    this.backend.dispose();
  }
}

