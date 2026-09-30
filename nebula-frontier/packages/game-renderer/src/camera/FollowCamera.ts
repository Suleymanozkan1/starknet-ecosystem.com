import { PerspectiveCamera, Vector3 } from "three";
import { valueNoise3 } from "../core/random.js";

export interface FollowCameraOptions {
  fov?: number;
  /** Camera pitch from horizontal (radians). ~0.95 rad ≈ 55° gives an isometric-like tilt. */
  pitch?: number;
  minDistance?: number;
  maxDistance?: number;
  distance?: number;
}

/**
 * Top-down / isometric-like follow camera: critically-damped follow, velocity
 * look-ahead, user zoom, combat zoom, boss cinematic framing, target focus,
 * auto-framing of player + target, and trauma-based screen shake.
 * Map coordinates: x → world X, y → world Z (screen up = -Z).
 */
export class FollowCamera {
  readonly camera: PerspectiveCamera;
  pitch: number;
  minDistance: number;
  maxDistance: number;
  /** User zoom distance. */
  distance: number;
  private curDistance: number;
  private readonly focus = new Vector3();
  private readonly desired = new Vector3();
  /** The followed entity position (leash anchor). */
  private readonly anchor = new Vector3();
  private hasAnchor = false;
  private readonly vel = new Vector3();
  private readonly shakeOffset = new Vector3();
  private trauma = 0;
  private time = 0;
  private combat = false;
  private combatBlend = 0;
  private hasTarget = false;
  private readonly targetPos = new Vector3();
  private boss: { x: number; z: number; r: number } | null = null;
  private cinematic = 0;
  private hasAim = false;
  private readonly aim = new Vector3();
  /** Seconds of free-look where focus stays still (e.g. death cam). */
  frozen = false;
  /** Vertical FOV (degrees) on a 16:9 screen; narrower screens widen it (see setAspect). */
  readonly baseFov: number;

  constructor(aspect: number, opts: FollowCameraOptions = {}) {
    this.baseFov = opts.fov ?? 30;
    this.camera = new PerspectiveCamera(this.baseFov, aspect, 0.5, 4000);
    this.pitch = opts.pitch ?? 1.08;
    this.minDistance = opts.minDistance ?? 30;
    this.maxDistance = opts.maxDistance ?? 220;
    this.distance = opts.distance ?? 64;
    this.curDistance = this.distance;
    this.setAspect(aspect);
  }

  /**
   * Keeps at least the horizontal field of view of a 16:9 screen: on narrower viewports (portrait phones,
   * tablets, 4:3) the vertical FOV widens instead of cropping the sides, so a phone shows as much of the
   * battlefield across as a desktop does (capped so the tilt stays readable).
   */
  setAspect(aspect: number): void {
    const a = Math.max(0.1, aspect);
    const half = (this.baseFov * Math.PI) / 360;
    const refHalfH = Math.atan(Math.tan(half) * (16 / 9));
    const needed = (Math.atan(Math.tan(refHalfH) / a) * 360) / Math.PI;
    this.camera.aspect = a;
    this.camera.fov = Math.min(FollowCamera.MAX_FOV, Math.max(this.baseFov, needed));
    this.camera.updateProjectionMatrix();
  }

  static readonly MAX_FOV = 62;

  /** Mouse-wheel / pinch zoom. Positive = zoom out. */
  zoomBy(delta: number): void {
    this.distance = Math.min(this.maxDistance, Math.max(this.minDistance, this.distance * (1 + delta)));
  }

  setZoom(distance: number): void {
    this.distance = Math.min(this.maxDistance, Math.max(this.minDistance, distance));
  }

  setCombat(on: boolean): void {
    this.combat = on;
  }

  setTarget(x: number | null, z = 0): void {
    this.hasTarget = x !== null;
    if (x !== null) this.targetPos.set(x, 0, z);
  }

  setAim(x: number | null, z = 0): void {
    this.hasAim = x !== null;
    if (x !== null) this.aim.set(x, 0, z);
  }

  /** Boss cinematic framing (null to exit). */
  setBoss(x: number | null, z = 0, radius = 20): void {
    this.boss = x === null ? null : { x, z, r: radius };
  }

  addShake(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** Desired follow point: entity position + velocity look-ahead. */
  follow(x: number, z: number, vx = 0, vz = 0): void {
    if (this.frozen) return;
    const look = 0.35;
    let ox = vx * look, oz = vz * look;
    if (this.hasAim) {
      ox += (this.aim.x - x) * 0.1;
      oz += (this.aim.z - z) * 0.1;
    }
    if (this.hasTarget) {
      ox += (this.targetPos.x - x) * 0.15;
      oz += (this.targetPos.z - z) * 0.15;
    }
    if (this.boss) {
      ox += (this.boss.x - x) * 0.35 * this.cinematic;
      oz += (this.boss.z - z) * 0.35 * this.cinematic;
    }
    // never push the followed ship out of the view: clamp the offset to a
    // fraction of the visible ground footprint (vertical extent is the limit)
    const maxOff = this.curDistance * Math.tan((this.camera.fov * Math.PI) / 360) * 0.55;
    const off = Math.hypot(ox, oz);
    if (off > maxOff) {
      ox *= maxOff / off;
      oz *= maxOff / off;
    }
    this.desired.set(x + ox, 0, z + oz);
    this.anchor.set(x, 0, z);
    this.hasAnchor = true;
  }

  /** Instantly jump to the desired focus (after spawn / map change). */
  snap(): void {
    this.focus.copy(this.desired);
    this.vel.set(0, 0, 0);
    this.curDistance = this.distance;
    this.apply();
  }

  /** World-space focus point (for audio listener, LOD, shadow camera). */
  get focusPoint(): Vector3 {
    return this.focus;
  }

  update(dt: number): void {
    this.time += dt;
    const d = Math.min(0.1, Math.max(0, dt));
    // critically damped spring toward desired
    const omega = 8;
    const x = omega * d;
    const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    const cx = this.focus.x - this.desired.x, cz = this.focus.z - this.desired.z;
    const tx = (this.vel.x + omega * cx) * d, tz = (this.vel.z + omega * cz) * d;
    this.vel.x = (this.vel.x - omega * tx) * exp;
    this.vel.z = (this.vel.z - omega * tz) * exp;
    this.focus.x = this.desired.x + (cx + tx) * exp;
    this.focus.z = this.desired.z + (cz + tz) * exp;
    // leash: the followed ship must stay well inside the view whatever the spring lag
    if (this.hasAnchor && !this.frozen) {
      const leash = this.curDistance * Math.tan((this.camera.fov * Math.PI) / 360) * 0.6;
      const lx = this.focus.x - this.anchor.x, lz = this.focus.z - this.anchor.z;
      const l = Math.hypot(lx, lz);
      if (l > leash) {
        this.focus.x = this.anchor.x + (lx / l) * leash;
        this.focus.z = this.anchor.z + (lz / l) * leash;
      }
    }

    this.combatBlend += ((this.combat ? 1 : 0) - this.combatBlend) * Math.min(1, d * 2);
    this.cinematic += ((this.boss ? 1 : 0) - this.cinematic) * Math.min(1, d * 1.2);

    let want = this.distance * (1 + 0.12 * this.combatBlend);
    // auto-frame the locked target so both stay on screen
    if (this.hasTarget) {
      const sep = Math.hypot(this.targetPos.x - this.desired.x, this.targetPos.z - this.desired.z);
      want = Math.min(Math.max(want, sep * 1.8), this.distance * 1.5);
    }
    if (this.boss) want = Math.max(want, (this.boss.r * 3.2 + 30) * this.cinematic + want * (1 - this.cinematic));
    want = Math.min(this.maxDistance * 1.4, want);
    this.curDistance += (want - this.curDistance) * Math.min(1, d * 3);

    // trauma shake
    this.trauma = Math.max(0, this.trauma - d * 1.4);
    const s = this.trauma * this.trauma;
    const t = this.time * 22;
    this.shakeOffset.set(
      (valueNoise3(t, 0, 0, 1) - 0.5) * 2 * s * 1.6,
      (valueNoise3(0, t, 0, 2) - 0.5) * 2 * s * 0.8,
      (valueNoise3(0, 0, t, 3) - 0.5) * 2 * s * 1.6,
    );
    this.apply();
  }

  private apply(): void {
    const dist = this.curDistance;
    const cam = this.camera;
    cam.position.set(
      this.focus.x + this.shakeOffset.x,
      Math.sin(this.pitch) * dist + this.shakeOffset.y,
      this.focus.z + Math.cos(this.pitch) * dist + this.shakeOffset.z,
    );
    cam.lookAt(this.focus.x + this.shakeOffset.x * 0.5, 0, this.focus.z + this.shakeOffset.z * 0.5);
    cam.updateMatrixWorld();
  }

  get currentDistance(): number {
    return this.curDistance;
  }
}
