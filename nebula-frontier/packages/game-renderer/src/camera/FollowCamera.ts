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

  constructor(aspect: number, opts: FollowCameraOptions = {}) {
    this.camera = new PerspectiveCamera(opts.fov ?? 42, aspect, 0.5, 3000);
    this.pitch = opts.pitch ?? 0.98;
    this.minDistance = opts.minDistance ?? 22;
    this.maxDistance = opts.maxDistance ?? 150;
    this.distance = opts.distance ?? 58;
    this.curDistance = this.distance;
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

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
    this.desired.set(x + vx * look, 0, z + vz * look);
    if (this.hasAim) {
      this.desired.x += (this.aim.x - x) * 0.12;
      this.desired.z += (this.aim.z - z) * 0.12;
    }
    if (this.hasTarget) {
      this.desired.x += (this.targetPos.x - x) * 0.25;
      this.desired.z += (this.targetPos.z - z) * 0.25;
    }
    if (this.boss) {
      this.desired.x += (this.boss.x - x) * 0.4 * this.cinematic;
      this.desired.z += (this.boss.z - z) * 0.4 * this.cinematic;
    }
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
    const omega = 6;
    const x = omega * d;
    const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    const cx = this.focus.x - this.desired.x, cz = this.focus.z - this.desired.z;
    const tx = (this.vel.x + omega * cx) * d, tz = (this.vel.z + omega * cz) * d;
    this.vel.x = (this.vel.x - omega * tx) * exp;
    this.vel.z = (this.vel.z - omega * tz) * exp;
    this.focus.x = this.desired.x + (cx + tx) * exp;
    this.focus.z = this.desired.z + (cz + tz) * exp;

    this.combatBlend += ((this.combat ? 1 : 0) - this.combatBlend) * Math.min(1, d * 2);
    this.cinematic += ((this.boss ? 1 : 0) - this.cinematic) * Math.min(1, d * 1.2);

    let want = this.distance * (1 + 0.12 * this.combatBlend);
    // auto-frame the locked target so both stay on screen
    if (this.hasTarget) {
      const sep = Math.hypot(this.targetPos.x - this.desired.x, this.targetPos.z - this.desired.z);
      want = Math.max(want, sep * 1.35);
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
