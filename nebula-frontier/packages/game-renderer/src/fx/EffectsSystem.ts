import { Color, Group, Vector3 } from "three";
import type { TierSettings } from "../core/tiers.js";
import { createRng } from "../core/random.js";
import { ParticleLayer } from "./particles.js";
import { TrailSystem } from "./trails.js";
import { BeamSystem } from "./beams.js";
import { ProjectileStyle, ProjectileSystem, type ProjectileImpact } from "./projectiles.js";
import { RingKind, RingSystem } from "./rings.js";
import { ShieldSystem } from "./shield.js";
import { DebrisSystem } from "./debris.js";
import { createCloakMaterial } from "./cloak.js";

export type WeaponVisualStyle = "beam" | "bolt" | "slug" | "missile" | "torpedo" | "wave" | "mine";

const tmpA = new Vector3();
const tmpC = new Color();

/**
 * Facade over all pooled effect systems. Positions are world-space (map x → X, map y → Z).
 * Every effect respects the tier budgets; when a pool is exhausted the effect is skipped.
 */
export class EffectsSystem {
  readonly group = new Group();
  readonly sparks: ParticleLayer;
  readonly smoke: ParticleLayer;
  readonly trails: TrailSystem;
  readonly beams: BeamSystem;
  readonly projectiles: ProjectileSystem;
  readonly rings: RingSystem;
  readonly shields: ShieldSystem;
  readonly debris: DebrisSystem;
  readonly cloakMaterial = createCloakMaterial();
  private readonly rng = createRng(4242);
  private time = 0;
  private particleScale = 1;
  /** Camera shake hook (amount 0..1). */
  onShake: ((amount: number, x: number, z: number) => void) | null = null;

  constructor(tier: TierSettings) {
    this.sparks = new ParticleLayer(TIER_MAX.particles, "additive");
    this.smoke = new ParticleLayer(Math.round(TIER_MAX.particles / 2), "smoke");
    this.trails = new TrailSystem(tier.trailBudget, tier.trailSegments);
    this.beams = new BeamSystem(64);
    this.projectiles = new ProjectileSystem(TIER_MAX.projectiles);
    this.rings = new RingSystem(48);
    this.shields = new ShieldSystem(48);
    this.debris = new DebrisSystem(TIER_MAX.debris);
    this.group.add(this.smoke.points, this.trails.group, this.beams.group, this.projectiles.mesh, this.rings.group, this.shields.group, this.debris.mesh, this.sparks.points);
    this.projectiles.onImpact = (i) => this.onProjectileImpact(i);
    this.projectiles.onFlight = (x, y, z, dx, dz, style, r, g, b) => this.onMissileFlight(x, y, z, dx, dz, style, r, g, b);
    this.setTier(tier);
  }

  setTier(t: TierSettings): void {
    this.sparks.setBudget(t.particleBudget);
    this.smoke.setBudget(Math.round(t.particleBudget / 2));
    this.trails.setBudget(t.trailBudget);
    this.projectiles.setBudget(t.projectileBudget);
    this.debris.setBudget(t.debrisBudget * 14);
    this.particleScale = t.particleBudget >= 3000 ? 1 : t.particleBudget >= 1500 ? 0.7 : 0.45;
  }

  setViewport(heightPx: number, fovRad: number): void {
    this.sparks.setScale(heightPx, fovRad);
    this.smoke.setScale(heightPx, fovRad);
  }

  private n(count: number): number {
    return Math.max(1, Math.round(count * this.particleScale));
  }

  // --------------------------------------------------------------------------- weapons

  muzzleFlash(pos: Vector3, dirX: number, dirZ: number, color: string, scale = 1): void {
    tmpC.set(color);
    const s = this.sparks;
    s.emit(pos.x, pos.y, pos.z, dirX * 2, 0, dirZ * 2, tmpC.r, tmpC.g, tmpC.b, 0.09, 1.6 * scale, 0.4 * scale);
    for (let i = 0; i < this.n(4); i++) {
      const sp = 8 + this.rng() * 10;
      const a = (this.rng() - 0.5) * 0.7;
      const cx = Math.cos(a), sx = Math.sin(a);
      const dx = dirX * cx - dirZ * sx, dz = dirX * sx + dirZ * cx;
      s.emit(pos.x, pos.y, pos.z, dx * sp, 0, dz * sp, tmpC.r, tmpC.g, tmpC.b, 0.12 + this.rng() * 0.1, 0.25 * scale, 0.05, 6);
    }
  }

  /** Visualise a weapon shot (AttackEvent). Hitscan styles draw an instant beam. */
  fire(from: Vector3, to: Vector3, color: string, style: WeaponVisualStyle | string, travelS: number, hit = true): void {
    const dx = to.x - from.x, dz = to.z - from.z;
    const len = Math.hypot(dx, dz) || 1;
    this.muzzleFlash(from, dx / len, dz / len, color, style === "torpedo" ? 1.6 : 1);
    switch (style) {
      case "beam":
        this.beams.flash(from, to, color, 0.35, 0.16);
        if (hit) this.impact(to, color, 0.8);
        return;
      case "wave":
        if (travelS <= 0.01) {
          this.rings.spawn(RingKind.SHOCKWAVE, from.x, from.y, from.z, len, color, 0.45, 0.06);
          return;
        }
        this.projectiles.spawn(from, to, color, ProjectileStyle.WAVE, travelS, this.time, hit);
        return;
      case "slug":
        this.projectiles.spawn(from, to, color, ProjectileStyle.SLUG, Math.max(0.05, travelS), this.time, hit);
        return;
      case "missile":
        this.projectiles.spawn(from, to, color, ProjectileStyle.MISSILE, Math.max(0.2, travelS), this.time, hit);
        return;
      case "torpedo":
        this.projectiles.spawn(from, to, color, ProjectileStyle.ORB, Math.max(0.3, travelS), this.time, hit);
        return;
      case "mine":
        this.projectiles.spawn(from, from, color, ProjectileStyle.ORB, 6, this.time, false);
        return;
      default:
        this.projectiles.spawn(from, to, color, ProjectileStyle.BOLT, Math.max(0.04, travelS), this.time, hit);
    }
  }

  private onProjectileImpact(i: ProjectileImpact): void {
    if (!i.hit) return;
    tmpA.set(i.x, i.y, i.z);
    tmpC.setRGB(i.r, i.g, i.b);
    if (i.style === ProjectileStyle.MISSILE || i.style === ProjectileStyle.ORB) {
      this.explosion(tmpA, i.style === ProjectileStyle.ORB ? 1.3 : 0.7, undefined, undefined, `#${tmpC.getHexString()}`);
    } else {
      this.impact(tmpA, `#${tmpC.getHexString()}`, i.style === ProjectileStyle.SLUG ? 1.2 : 0.8);
    }
  }

  private onMissileFlight(x: number, y: number, z: number, dx: number, dz: number, style: ProjectileStyle, r: number, g: number, b: number): void {
    if (this.rng() > 0.7 * this.particleScale + 0.2) return;
    this.smoke.emit(x - dx * 0.4, y, z - dz * 0.4, (this.rng() - 0.5) * 0.6, 0.2, (this.rng() - 0.5) * 0.6, 0.55, 0.55, 0.6, 0.9, 0.5, 1.6, 1.5, 0.3);
    this.sparks.emit(x - dx * 0.35, y, z - dz * 0.35, -dx * 3, 0, -dz * 3, style === ProjectileStyle.ORB ? r : 1, style === ProjectileStyle.ORB ? g : 0.65, style === ProjectileStyle.ORB ? b : 0.25, 0.18, 0.7, 0.1, 4);
  }

  /** Small hit spark burst (on hull / shield). */
  impact(pos: Vector3, color: string, scale = 1): void {
    tmpC.set(color);
    this.sparks.emit(pos.x, pos.y + 0.1, pos.z, 0, 0, 0, tmpC.r, tmpC.g, tmpC.b, 0.14, 2.2 * scale, 0.6 * scale);
    for (let i = 0; i < this.n(8); i++) {
      const a = this.rng() * Math.PI * 2, sp = (4 + this.rng() * 10) * scale;
      this.sparks.emit(pos.x, pos.y, pos.z, Math.cos(a) * sp, this.rng() * 2, Math.sin(a) * sp, 1, 0.85, 0.55, 0.2 + this.rng() * 0.25, 0.22 * scale, 0.04, 5);
    }
  }

  // --------------------------------------------------------------------------- explosions

  /** Ship/NPC destruction. `scale` ≈ ship length / 3. */
  explosion(pos: Vector3, scale = 1, colors?: readonly string[], effect?: string, tint?: string): void {
    const s = Math.max(0.3, scale);
    const c0 = colors?.[0] ?? "#fff3c0";
    const c1 = colors?.[1] ?? tint ?? "#ff9a3c";
    const c2 = colors?.[2] ?? "#ff3d1f";
    const sup = effect === "supernova";
    // flash
    tmpC.set(c0);
    this.sparks.emit(pos.x, pos.y + 0.2, pos.z, 0, 0, 0, tmpC.r, tmpC.g, tmpC.b, 0.25 * Math.sqrt(s), 7 * s, 11 * s);
    // fireball
    const fire = this.n(Math.round(26 * Math.sqrt(s)));
    for (let i = 0; i < fire; i++) {
      const a = this.rng() * Math.PI * 2, u = this.rng() * 2 - 1, sp = (2 + this.rng() * 5) * Math.sqrt(s);
      const r = Math.sqrt(1 - u * u);
      tmpC.set(this.rng() < 0.5 ? c1 : c2);
      this.sparks.emit(pos.x, pos.y, pos.z, Math.cos(a) * r * sp, u * sp * 0.4, Math.sin(a) * r * sp, tmpC.r, tmpC.g, tmpC.b, 0.5 + this.rng() * 0.5, 2.2 * s, 4 * s, 2.5, 0.8);
    }
    // sparks
    for (let i = 0; i < this.n(Math.round(30 * Math.sqrt(s))); i++) {
      const a = this.rng() * Math.PI * 2, sp = (10 + this.rng() * 22) * Math.sqrt(s);
      this.sparks.emit(pos.x, pos.y, pos.z, Math.cos(a) * sp, (this.rng() - 0.3) * 4, Math.sin(a) * sp, 1, 0.8, 0.45, 0.4 + this.rng() * 0.6, 0.3 * s, 0.05, 2.2);
    }
    // smoke
    for (let i = 0; i < this.n(Math.round(14 * Math.sqrt(s))); i++) {
      const a = this.rng() * Math.PI * 2, sp = (1 + this.rng() * 3) * Math.sqrt(s);
      const g = 0.12 + this.rng() * 0.1;
      this.smoke.emit(pos.x, pos.y, pos.z, Math.cos(a) * sp, 0.5, Math.sin(a) * sp, g, g, g * 1.1, 1.6 + this.rng() * 1.4, 2 * s, 6 * s, 1.2, 0.2);
    }
    // shockwave
    this.rings.spawn(RingKind.SHOCKWAVE, pos.x, pos.y + 0.05, pos.z, 9 * s, sup ? (colors?.[2] ?? "#ff006e") : c1, 0.7 + 0.15 * s, 0.07);
    if (sup) this.rings.spawn(RingKind.FLASH, pos.x, pos.y + 0.1, pos.z, 14 * s, c0, 0.9, 0.05);
    // debris
    this.debris.burst(pos.x, pos.y, pos.z, Math.min(24, Math.round(8 * Math.sqrt(s))), 9 * Math.sqrt(s), 0.25 * s, "#4a4f58", this.rng);
    this.onShake?.(Math.min(1, 0.25 * s), pos.x, pos.z);
  }

  emp(pos: Vector3, radius: number, color = "#56cfe1"): void {
    this.rings.spawn(RingKind.SHOCKWAVE, pos.x, pos.y + 0.1, pos.z, radius, color, 0.8, 0.12);
    this.rings.spawn(RingKind.PULSE, pos.x, pos.y + 0.12, pos.z, radius * 0.6, "#ffffff", 0.5, 0.05);
    tmpC.set(color);
    for (let i = 0; i < this.n(40); i++) {
      const a = (i / 40) * Math.PI * 2, sp = radius * 1.4;
      this.sparks.emit(pos.x, pos.y, pos.z, Math.cos(a) * sp, 0, Math.sin(a) * sp, tmpC.r, tmpC.g, tmpC.b, 0.6, 0.6, 0.1, 1.8);
    }
    this.onShake?.(0.3, pos.x, pos.z);
  }

  /** Heal / shield restore / buff pulse. */
  energyPulse(pos: Vector3, radius: number, color: string): void {
    this.rings.spawn(RingKind.PULSE, pos.x, pos.y + 0.05, pos.z, radius, color, 0.7, 0.1);
    tmpC.set(color);
    for (let i = 0; i < this.n(18); i++) {
      const a = this.rng() * Math.PI * 2, r = this.rng() * radius * 0.6;
      this.sparks.emit(pos.x + Math.cos(a) * r, pos.y, pos.z + Math.sin(a) * r, 0, 2 + this.rng() * 3, 0, tmpC.r, tmpC.g, tmpC.b, 0.8, 0.5, 0.1, 0.5);
    }
  }

  /** Warp in/out flash at a location (dash, portal jump, spawn). */
  warpFlash(pos: Vector3, dirX: number, dirZ: number, color = "#9ad7ff", scale = 1): void {
    this.rings.spawn(RingKind.FLASH, pos.x, pos.y + 0.1, pos.z, 6 * scale, color, 0.5, 0.06);
    tmpC.set(color);
    for (let i = 0; i < this.n(30); i++) {
      const sp = 15 + this.rng() * 30;
      const off = (this.rng() - 0.5) * 2 * scale;
      this.sparks.emit(pos.x - dirZ * off, pos.y, pos.z + dirX * off, dirX * sp, 0, dirZ * sp, tmpC.r, tmpC.g, tmpC.b, 0.3 + this.rng() * 0.2, 0.5 * scale, 0.05, 3);
    }
  }

  /** Ground telegraph for boss special attacks; `onDone` fires when the fill completes. */
  telegraph(pos: Vector3, radius: number, color: string, durationS: number, onDone?: () => void): void {
    this.rings.spawn(RingKind.TELEGRAPH, pos.x, pos.y + 0.02, pos.z, radius, color, durationS, 0.05, onDone);
  }

  /** Continuous damage feedback: sparks & smoke by hull fraction. Call every frame. */
  damageEmit(pos: Vector3, hullFrac: number, dt: number, size: number): void {
    if (hullFrac > 0.7) return;
    const severity = 1 - hullFrac / 0.7;
    const rate = (4 + severity * 26) * this.particleScale * Math.sqrt(Math.max(1, size / 3));
    const count = rate * dt + (this.rng() < (rate * dt) % 1 ? 1 : 0);
    for (let i = 0; i < Math.floor(count); i++) {
      const ox = (this.rng() - 0.5) * size * 0.5, oz = (this.rng() - 0.5) * size * 0.6;
      const g = 0.08 + this.rng() * 0.08;
      this.smoke.emit(pos.x + ox, pos.y + 0.3, pos.z + oz, (this.rng() - 0.5), 0.8, (this.rng() - 0.5), g, g, g, 1.2 + severity, 0.4 * size / 3, 1.8 * size / 3, 0.8, 0.6);
      if (this.rng() < 0.3 + severity * 0.5) {
        const a = this.rng() * Math.PI * 2, sp = 3 + this.rng() * 6;
        this.sparks.emit(pos.x + ox, pos.y + 0.3, pos.z + oz, Math.cos(a) * sp, 2, Math.sin(a) * sp, 1, 0.6, 0.25, 0.3, 0.2, 0.03, 3);
      }
      if (severity > 0.6 && this.rng() < 0.15) {
        this.sparks.emit(pos.x + ox, pos.y + 0.3, pos.z + oz, 0, 1, 0, 1, 0.45, 0.1, 0.35, 0.9 * size / 3, 0.2, 1);
      }
    }
  }

  /** Asteroid chips while mining. */
  miningChips(pos: Vector3, color: string, dt: number): void {
    tmpC.set(color);
    if (this.rng() < dt * 12 * this.particleScale) {
      const a = this.rng() * Math.PI * 2, sp = 2 + this.rng() * 4;
      this.sparks.emit(pos.x, pos.y, pos.z, Math.cos(a) * sp, 1 + this.rng() * 2, Math.sin(a) * sp, tmpC.r, tmpC.g, tmpC.b, 0.5, 0.35, 0.05, 2);
    }
    if (this.rng() < dt * 3) this.debris.burst(pos.x, pos.y, pos.z, 1, 3, 0.12, color, this.rng, 1.2);
  }

  /** Engine exhaust sparks for boosting ships. */
  boostSparks(pos: Vector3, dirX: number, dirZ: number, color: string, dt: number): void {
    if (this.rng() > dt * 40 * this.particleScale) return;
    tmpC.set(color);
    this.sparks.emit(pos.x, pos.y, pos.z, -dirX * 6 + (this.rng() - 0.5) * 2, 0, -dirZ * 6 + (this.rng() - 0.5) * 2, tmpC.r, tmpC.g, tmpC.b, 0.25, 0.45, 0.05, 2);
  }

  /** Loot pickup sparkle. */
  pickup(pos: Vector3, color: string): void {
    this.energyPulse(pos, 2.5, color);
  }

  update(time: number, dt: number): void {
    this.time = time;
    this.projectiles.update(time);
    this.sparks.update(time);
    this.smoke.update(time);
    this.trails.update(time, dt);
    this.beams.update(time, dt);
    this.rings.update(time, dt);
    this.shields.update(time, dt);
    this.debris.update(dt);
    const u = this.cloakMaterial.uniforms.uTime;
    if (u) u.value = time;
  }

  get now(): number {
    return this.time;
  }

  clear(): void {
    this.projectiles.clear();
    this.sparks.clear();
    this.smoke.clear();
    this.debris.clear();
  }

  dispose(): void {
    this.sparks.dispose();
    this.smoke.dispose();
    this.trails.dispose();
    this.beams.dispose();
    this.projectiles.dispose();
    this.rings.dispose();
    this.shields.dispose();
    this.debris.dispose();
    this.cloakMaterial.dispose();
    this.group.removeFromParent();
  }
}

/** Buffer capacities (max over all tiers — budgets clamp usage per tier). */
const TIER_MAX = { particles: 6000, projectiles: 768, debris: 720 };
