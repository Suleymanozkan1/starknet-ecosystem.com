import { describe, expect, it } from "vitest";
import { InterpolationBuffer, SnapshotBuffer, type MotionSample } from "./interpolation.js";

const s = (x: number, y: number, heading = 0, vx = 0, vy = 0): MotionSample => ({ x, y, heading, vx, vy });
const out = (): MotionSample => s(0, 0);

describe("SnapshotBuffer", () => {
  it("interpolates linearly between bracketing samples", () => {
    const b = new SnapshotBuffer();
    b.push(0, s(0, 0));
    b.push(100, s(10, 20));
    const o = out();
    expect(b.sample(50, o)).toBe(true);
    expect(o.x).toBeCloseTo(5);
    expect(o.y).toBeCloseTo(10);
  });

  it("interpolates headings along the shortest arc", () => {
    const b = new SnapshotBuffer();
    b.push(0, s(0, 0, Math.PI - 0.1));
    b.push(100, s(0, 0, -Math.PI + 0.1));
    const o = out();
    b.sample(50, o);
    expect(Math.abs(Math.abs(o.heading) - Math.PI)).toBeLessThan(0.02);
  });

  it("extrapolates with velocity for a bounded time past the newest sample", () => {
    const b = new SnapshotBuffer({ maxExtrapolateMs: 100 });
    b.push(0, s(0, 0, 0, 10, 0));
    const o = out();
    b.sample(50, o);
    expect(o.x).toBeCloseTo(0.5);
    b.sample(1000, o);
    expect(o.x).toBeCloseTo(1); // capped at 100ms
  });

  it("clamps to the oldest sample when asked for older times", () => {
    const b = new SnapshotBuffer();
    b.push(100, s(3, 4));
    b.push(200, s(5, 6));
    const o = out();
    b.sample(0, o);
    expect(o.x).toBe(3);
  });

  it("does not glide across teleports", () => {
    const b = new SnapshotBuffer({ snapDistance: 10 });
    b.push(0, s(0, 0));
    b.push(100, s(500, 0));
    const o = out();
    b.sample(40, o);
    expect(o.x).toBe(0);
    b.sample(60, o);
    expect(o.x).toBe(500);
  });

  it("holds the previous pose across long gaps (entity was at rest)", () => {
    const b = new SnapshotBuffer({ holdGapMs: 250 });
    b.push(0, s(0, 0));
    b.push(1000, s(10, 0));
    const o = out();
    b.sample(500, o);
    expect(o.x).toBe(0);
    b.sample(975, o);
    expect(o.x).toBeCloseTo(5, 0);
  });

  it("ignores out-of-order samples and wraps its ring", () => {
    const b = new SnapshotBuffer({ capacity: 4 });
    for (let i = 0; i < 10; i++) b.push(i * 10, s(i, 0));
    b.push(5, s(-100, 0));
    expect(b.size).toBe(4);
    const o = out();
    b.sample(85, o);
    expect(o.x).toBeCloseTo(8.5);
  });
});

describe("InterpolationBuffer", () => {
  it("renders entities delayMs in the past", () => {
    const ib = new InterpolationBuffer(100);
    ib.push("a", 1000, s(0, 0));
    ib.push("a", 1050, s(5, 0));
    ib.push("a", 1100, s(10, 0));
    const o = out();
    expect(ib.sample("a", 1175, o)).toBe(true);
    expect(o.x).toBeCloseTo(7.5);
    expect(ib.sample("missing", 1175, o)).toBe(false);
    ib.remove("a");
    expect(ib.has("a")).toBe(false);
  });
});
