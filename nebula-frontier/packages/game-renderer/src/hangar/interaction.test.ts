import { describe, expect, it } from "vitest";
import {
  HANGAR_ORBIT, PREVIEW_DAMAGE, bayWidth, damageLevel, hangarFraming, hangarHomePose, hangarPreviewPlan, zoomedDistance,
  type HangarPreviewMode,
} from "./interaction.js";

describe("hangar orbit controls", () => {
  it("rotates and zooms but never pans or dips below the floor", () => {
    expect(HANGAR_ORBIT.enablePan).toBe(false);
    expect(HANGAR_ORBIT.maxPolarAngle).toBeLessThan(Math.PI / 2);
    expect(HANGAR_ORBIT.maxPolarAngle).toBeGreaterThan(Math.PI * 0.4);
    expect(HANGAR_ORBIT.minDistance).toBeLessThan(HANGAR_ORBIT.maxDistance);
    expect(HANGAR_ORBIT.dampingFactor).toBeGreaterThan(0);
  });
});

describe("zoomedDistance (wheel / pinch / zoom buttons)", () => {
  it("zooms in and out relative to the current distance", () => {
    expect(zoomedDistance(20, -0.25, 3, 90)).toBeCloseTo(15);
    expect(zoomedDistance(20, 0.5, 3, 90)).toBeCloseTo(30);
    expect(zoomedDistance(20, 0, 3, 90)).toBe(20);
  });

  it("clamps to the orbit limits", () => {
    expect(zoomedDistance(4, -0.9, 3, 90)).toBe(3);
    expect(zoomedDistance(80, 1, 3, 90)).toBe(90);
    // repeated wheel steps converge on the limits instead of overshooting
    let d = 20;
    for (let i = 0; i < 50; i++) d = zoomedDistance(d, -0.2, 3, 90);
    expect(d).toBe(3);
    for (let i = 0; i < 50; i++) d = zoomedDistance(d, 0.2, 3, 90);
    expect(d).toBe(90);
  });

  it("stays inside the framed range for a real ship", () => {
    const f = hangarFraming(bayWidth(8, 3), null, false);
    expect(zoomedDistance(f.minDistance * 1.1, -0.5, f.minDistance, f.maxDistance)).toBe(f.minDistance);
    expect(zoomedDistance(f.maxDistance * 0.9, 0.5, f.minDistance, f.maxDistance)).toBe(f.maxDistance);
  });
});

describe("hangarFraming (single ship + side-by-side compare)", () => {
  it("uses the larger of length and span as the footprint", () => {
    expect(bayWidth(10, 2)).toBe(10);
    expect(bayWidth(4, 3)).toBe(6);
  });

  it("centres a single ship and scales the zoom range with its size", () => {
    const small = hangarFraming(4, null, false);
    const big = hangarFraming(20, null, false);
    expect(small.mainX).toBe(0);
    expect(small.compareX).toBeNull();
    expect(small.minDistance).toBeCloseTo(4 * 0.6);
    expect(small.maxDistance).toBeCloseTo(4 * 6);
    expect(big.minDistance).toBeGreaterThan(small.minDistance);
    expect(big.maxDistance).toBeGreaterThan(small.maxDistance);
    // tiny hulls still get a usable range
    expect(hangarFraming(1, null, false).minDistance).toBeCloseTo(3 * 0.6);
  });

  it("places two ships symmetrically without overlap and widens the zoom range", () => {
    const single = hangarFraming(6, null, false);
    const f = hangarFraming(6, 10, true);
    expect(f.compareX).not.toBeNull();
    const compareX = f.compareX ?? 0;
    expect(f.mainX).toBeCloseTo(-compareX);
    // distance between the bay centres leaves a gap between the two footprints
    expect(compareX - f.mainX).toBeGreaterThan(6 / 2 + 10 / 2);
    expect(f.maxDistance).toBeGreaterThan(single.maxDistance);
    expect(f.minDistance).toBeGreaterThan(single.minDistance);
  });

  it("keeps the main ship centred while the compare model is not mounted yet", () => {
    const f = hangarFraming(6, null, true);
    expect(f.mainX).toBe(0);
    expect(f.compareX).toBeNull();
  });
});

describe("hangarHomePose (reset view)", () => {
  const dist = (p: readonly [number, number, number], t: readonly [number, number, number]) => Math.hypot(p[0] - t[0], p[1] - t[1], p[2] - t[2]);

  it("looks at the ship from above and backs off for large hulls and compare mode", () => {
    const small = hangarHomePose({ length: 3, radius: 1 }, false);
    const big = hangarHomePose({ length: 30, radius: 6 }, false);
    const cmp = hangarHomePose({ length: 30, radius: 6 }, true);
    expect(small.position[1]).toBeGreaterThan(small.target[1]);
    expect(dist(big.position, big.target)).toBeGreaterThan(dist(small.position, small.target));
    expect(dist(cmp.position, cmp.target)).toBeGreaterThan(dist(big.position, big.target));
    expect(small.target[0]).toBe(0);
    expect(small.target[2]).toBe(0);
  });

  it("has a sane default without a model", () => {
    const p = hangarHomePose(null, false);
    expect(dist(p.position, p.target)).toBeGreaterThan(9);
  });
});

describe("preview modes (engine / fire / shield / damage)", () => {
  it("maps each mode to engines, pulses and damage", () => {
    expect(hangarPreviewPlan("idle")).toEqual({ engines: false, damage: 0, pulse: null, intervalMs: 0 });
    expect(hangarPreviewPlan("engine")).toMatchObject({ engines: true, damage: 0, pulse: null });
    expect(hangarPreviewPlan("fire")).toMatchObject({ engines: true, pulse: "fire" });
    expect(hangarPreviewPlan("shield")).toMatchObject({ engines: false, pulse: "shield" });
    expect(hangarPreviewPlan("damage")).toMatchObject({ engines: false, damage: PREVIEW_DAMAGE, pulse: null });
  });

  it("repeats pulses on a positive interval and only for pulsing modes", () => {
    const modes: HangarPreviewMode[] = ["idle", "engine", "fire", "shield", "damage"];
    for (const m of modes) {
      const p = hangarPreviewPlan(m);
      if (p.pulse) expect(p.intervalMs).toBeGreaterThan(0);
      else expect(p.intervalMs).toBe(0);
    }
  });

  it("damage preview is heavy enough to show smoke (> 0.3)", () => {
    expect(PREVIEW_DAMAGE).toBeGreaterThan(0.3);
  });

  it("clamps damage levels and accepts percentages", () => {
    expect(damageLevel(0.4)).toBe(0.4);
    expect(damageLevel(65)).toBeCloseTo(0.65);
    expect(damageLevel(250)).toBe(1);
    expect(damageLevel(-1)).toBe(0);
    expect(damageLevel(Number.NaN)).toBe(0);
  });
});
