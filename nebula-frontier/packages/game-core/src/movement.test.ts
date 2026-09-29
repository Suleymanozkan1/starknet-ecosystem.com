import { describe, expect, it } from "vitest";
import { applyDash, maxTravelDistance, sanitizeMoveInput, stepShip, type MotionState, type MotionStats } from "./movement.js";
import { DEFAULT_TUNING } from "./tuning.js";

const stats: MotionStats = { speed: 30, acceleration: 60, turnRate: 3, maxEnergy: 100 };
const bounds = { width: 600, height: 450 };
const start: MotionState = { x: 100, y: 100, vx: 0, vy: 0, heading: 0, energy: 100 };
const dt = 1 / 20;

function run(state: MotionState, n: number, input: Parameters<typeof stepShip>[1]): MotionState {
  let s = state;
  for (let i = 0; i < n; i++) s = stepShip(s, input, stats, dt, bounds);
  return s;
}

describe("stepShip", () => {
  it("accelerates forward and caps at max speed", () => {
    const s = run(start, 100, { thrust: 1, strafe: 0, heading: 0, boost: false });
    expect(Math.hypot(s.vx, s.vy)).toBeCloseTo(30, 5);
    expect(s.x).toBeGreaterThan(start.x);
    expect(s.y).toBeCloseTo(100, 5);
  });

  it("boost raises cap and consumes energy; no boost without energy", () => {
    const s = run(start, 40, { thrust: 1, strafe: 0, heading: 0, boost: true });
    expect(Math.hypot(s.vx, s.vy)).toBeGreaterThan(30);
    expect(Math.hypot(s.vx, s.vy)).toBeLessThanOrEqual(30 * DEFAULT_TUNING.boostMultiplier + 1e-9);
    expect(s.energy).toBeLessThan(100);
    const empty = run({ ...start, energy: 0 }, 60, { thrust: 1, strafe: 0, heading: 0, boost: true });
    expect(Math.hypot(empty.vx, empty.vy)).toBeLessThanOrEqual(30 + 1e-9);
  });

  it("decelerates to a stop without input", () => {
    const moving = run(start, 40, { thrust: 1, strafe: 0, heading: 0, boost: false });
    const stopped = run(moving, 60, { thrust: 0, strafe: 0, heading: Number.NaN, boost: false });
    expect(Math.hypot(stopped.vx, stopped.vy)).toBe(0);
  });

  it("turn rate limits heading change per step", () => {
    const s = stepShip(start, { thrust: 0, strafe: 0, heading: Math.PI / 2, boost: false }, stats, dt, bounds);
    expect(s.heading).toBeCloseTo(stats.turnRate * dt, 6);
  });

  it("clamps to map bounds", () => {
    const s = run({ ...start, x: 590 }, 100, { thrust: 1, strafe: 0, heading: 0, boost: true });
    expect(s.x).toBe(600);
    expect(s.vx).toBe(0);
  });

  it("is deterministic (client prediction == server)", () => {
    const inputs = Array.from({ length: 50 }, (_, i) => ({ thrust: Math.sin(i), strafe: Math.cos(i) / 2, heading: i / 10, boost: i % 3 === 0 }));
    const a = inputs.reduce((s, inp) => stepShip(s, inp, stats, dt, bounds), start);
    const b = inputs.reduce((s, inp) => stepShip(s, inp, stats, dt, bounds), start);
    expect(a).toEqual(b);
  });

  it("sanitizes hostile input (out-of-range axes, NaN)", () => {
    const s = sanitizeMoveInput({ thrust: 127, strafe: Number.NaN, heading: Infinity, boost: true });
    expect(s).toMatchObject({ thrust: 1, strafe: 0, boost: true });
    expect(Number.isNaN(s.heading)).toBe(true);
    // An oversized axis cannot exceed max speed.
    const moved = run(start, 200, { thrust: 1000, strafe: 1000, heading: 0, boost: false });
    expect(Math.hypot(moved.vx, moved.vy)).toBeLessThanOrEqual(30 + 1e-9);
  });

  it("never exceeds maxTravelDistance per step", () => {
    let s = start;
    for (let i = 0; i < 200; i++) {
      const n = stepShip(s, { thrust: 1, strafe: 1, heading: i, boost: true }, stats, dt, bounds);
      expect(Math.hypot(n.x - s.x, n.y - s.y)).toBeLessThanOrEqual(maxTravelDistance(stats, dt) + 1e-9);
      s = n;
    }
  });

  it("click-to-move arrives near target", () => {
    const s = run(start, 400, { thrust: 0, strafe: 0, heading: Number.NaN, boost: false, moveTo: { x: 200, y: 160 } });
    expect(Math.hypot(s.x - 200, s.y - 160)).toBeLessThan(3);
  });

  it("dash moves along direction and clamps", () => {
    const d = applyDash(start, 1, 0, 25, bounds);
    expect(d.x).toBeCloseTo(125);
    expect(applyDash({ ...start, x: 590 }, 1, 0, 25, bounds).x).toBe(600);
  });
});
