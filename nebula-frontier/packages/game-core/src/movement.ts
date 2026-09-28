/**
 * Deterministic ship kinematics shared by the authoritative server and client
 * prediction (tosios `common` pattern: one pure step function on both sides).
 *
 * Coordinates are map units, +x right, +y down (screen/map space). Heading 0
 * points to +x; heading increases clockwise in screen space.
 */
import { clamp, wrapAngle } from "@nebula/shared";
import { DEFAULT_TUNING, type SimTuning } from "./tuning.js";

export interface MotionState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  heading: number;
  energy: number;
}

export interface MoveInput {
  /** -1..1 forward/back. */
  thrust: number;
  /** -1..1 right/left relative to heading. */
  strafe: number;
  /** Desired heading (radians); NaN keeps the current heading. */
  heading: number;
  boost: boolean;
  moveTo?: { x: number; y: number } | null;
}

export interface MotionStats {
  /** Max speed, units/s. */
  speed: number;
  /** Units/s². */
  acceleration: number;
  /** Radians/s. */
  turnRate: number;
  /** Max energy (clamp for boost consumption). */
  maxEnergy: number;
  /** Multiplier from active buffs (engine overdrive etc.). */
  speedMultiplier?: number;
  /** When true the ship cannot thrust or turn (EMP stun). */
  stunned?: boolean;
}

export interface MapBounds {
  width: number;
  height: number;
}

export interface StepResult extends MotionState {
  boosting: boolean;
}

const EPS = 1e-6;

/** Neutral input (no thrust, keep heading). */
export const IDLE_INPUT: MoveInput = Object.freeze({ thrust: 0, strafe: 0, heading: Number.NaN, boost: false, moveTo: null });

/** Clamp untrusted input values into their legal domain (NaN-safe). Never rejects. */
export function sanitizeMoveInput(input: Partial<MoveInput>): MoveInput {
  const num = (v: unknown, lo: number, hi: number): number => (typeof v === "number" && Number.isFinite(v) ? clamp(v, lo, hi) : 0);
  const heading = typeof input.heading === "number" && Number.isFinite(input.heading) ? wrapAngle(input.heading) : Number.NaN;
  let moveTo: MoveInput["moveTo"] = null;
  if (input.moveTo && typeof input.moveTo.x === "number" && typeof input.moveTo.y === "number" && Number.isFinite(input.moveTo.x) && Number.isFinite(input.moveTo.y)) {
    moveTo = { x: input.moveTo.x, y: input.moveTo.y };
  }
  return { thrust: num(input.thrust, -1, 1), strafe: num(input.strafe, -1, 1), heading, boost: input.boost === true, moveTo };
}

/** Rotate `from` toward `to` by at most `maxDelta` radians. */
export function turnToward(from: number, to: number, maxDelta: number): number {
  const d = wrapAngle(to - from);
  if (Math.abs(d) <= maxDelta) return wrapAngle(to);
  return wrapAngle(from + Math.sign(d) * maxDelta);
}

/** Maximum distance a ship with these stats can legitimately cover in `dt` seconds. */
export function maxTravelDistance(stats: MotionStats, dt: number, tuning: SimTuning = DEFAULT_TUNING): number {
  const mult = stats.speedMultiplier ?? 1;
  return stats.speed * mult * tuning.boostMultiplier * dt;
}

/**
 * Advance one fixed step. Pure: returns a new state; never mutates `state`.
 * Same function is used by client prediction and server simulation.
 */
export function stepShip(
  state: MotionState,
  rawInput: MoveInput,
  stats: MotionStats,
  dt: number,
  bounds: MapBounds,
  tuning: SimTuning = DEFAULT_TUNING,
): StepResult {
  const input = sanitizeMoveInput(rawInput);
  const safeDt = clamp(dt, 0, 0.25);
  let { x, y, vx, vy, heading, energy } = state;
  const speedMult = Math.max(0, stats.speedMultiplier ?? 1);

  let thrust = input.thrust;
  let strafe = input.strafe;
  let desiredHeading = input.heading;

  if (input.moveTo) {
    const dx = input.moveTo.x - x;
    const dy = input.moveTo.y - y;
    const d = Math.hypot(dx, dy);
    if (d > tuning.arriveRadius) {
      desiredHeading = Math.atan2(dy, dx);
      // Ease in on arrival: thrust proportional to the braking distance.
      const brakeDist = (Math.hypot(vx, vy) ** 2) / (2 * Math.max(EPS, stats.acceleration));
      thrust = d > brakeDist + tuning.arriveRadius ? 1 : 0;
      strafe = 0;
    } else {
      thrust = 0;
      strafe = 0;
    }
  }

  if (stats.stunned) {
    thrust = 0;
    strafe = 0;
    desiredHeading = Number.NaN;
  }

  if (!Number.isNaN(desiredHeading)) {
    heading = turnToward(heading, desiredHeading, stats.turnRate * safeDt);
  }

  // Boost consumes energy; with insufficient energy it simply does not engage.
  const wantsBoost = input.boost && (thrust !== 0 || strafe !== 0);
  const boostCost = tuning.boostEnergyPerSec * safeDt;
  const boosting = wantsBoost && energy >= boostCost;
  if (boosting) energy = Math.max(0, energy - boostCost);

  const maxSpeed = stats.speed * speedMult * (boosting ? tuning.boostMultiplier : 1);
  const accel = stats.acceleration * speedMult * (boosting ? tuning.boostMultiplier : 1);

  const fx = Math.cos(heading);
  const fy = Math.sin(heading);
  // Right vector in screen space (heading + 90°).
  const rx = -fy;
  const ry = fx;
  let ax = fx * thrust + rx * strafe;
  let ay = fy * thrust + ry * strafe;
  const alen = Math.hypot(ax, ay);
  if (alen > 1) {
    ax /= alen;
    ay /= alen;
  }

  if (alen > EPS) {
    vx += ax * accel * safeDt;
    vy += ay * accel * safeDt;
  } else {
    // Brake toward zero without overshooting.
    const sp = Math.hypot(vx, vy);
    if (sp > EPS) {
      const dec = Math.min(sp, stats.acceleration * tuning.brakeFactor * safeDt);
      vx -= (vx / sp) * dec;
      vy -= (vy / sp) * dec;
    } else {
      vx = 0;
      vy = 0;
    }
  }

  const sp = Math.hypot(vx, vy);
  if (sp > maxSpeed) {
    // Thrusting: hard cap. Coasting over the cap (boost released): bleed off smoothly,
    // never above the absolute legal maximum (speed × mult × boostMultiplier).
    const bleed = alen > EPS ? sp - maxSpeed : stats.acceleration * tuning.brakeFactor * safeDt * 2;
    const absoluteMax = stats.speed * speedMult * tuning.boostMultiplier;
    const capped = Math.min(Math.max(maxSpeed, sp - bleed), absoluteMax);
    vx = (vx / sp) * capped;
    vy = (vy / sp) * capped;
  }

  x += vx * safeDt;
  y += vy * safeDt;

  if (x < 0) { x = 0; if (vx < 0) vx = 0; }
  if (y < 0) { y = 0; if (vy < 0) vy = 0; }
  if (x > bounds.width) { x = bounds.width; if (vx > 0) vx = 0; }
  if (y > bounds.height) { y = bounds.height; if (vy > 0) vy = 0; }

  energy = clamp(energy, 0, stats.maxEnergy);
  return { x, y, vx, vy, heading, energy, boosting };
}

/**
 * Instant dash along a direction (ability/module). Direction is normalised; a
 * zero vector dashes along the current heading. Result is clamped to bounds.
 */
export function applyDash(state: MotionState, dirX: number, dirY: number, distance: number, bounds: MapBounds): MotionState {
  let dx = Number.isFinite(dirX) ? dirX : 0;
  let dy = Number.isFinite(dirY) ? dirY : 0;
  const len = Math.hypot(dx, dy);
  if (len < EPS) {
    dx = Math.cos(state.heading);
    dy = Math.sin(state.heading);
  } else {
    dx /= len;
    dy /= len;
  }
  const d = Math.max(0, distance);
  return {
    ...state,
    x: clamp(state.x + dx * d, 0, bounds.width),
    y: clamp(state.y + dy * d, 0, bounds.height),
  };
}
