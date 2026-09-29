import { describe, expect, it } from "vitest";
import { aimTarget, shipHitRadius } from "./aim.js";

const c = (id: string, x: number, y: number, radius = 3) => ({ id, x, y, radius });

describe("aimTarget (free-aim fire)", () => {
  it("hits the first ship along the aim line", () => {
    const r = aimTarget(0, 0, 0, 60, [c("far", 40, 0), c("near", 20, 1)], 0);
    expect(r?.target.id).toBe("near");
  });
  it("ignores ships off the line, behind the shooter or out of range", () => {
    expect(aimTarget(0, 0, 0, 60, [c("off", 20, 10)], 0)).toBeNull();
    expect(aimTarget(0, 0, 0, 60, [c("behind", -20, 0)], 0)).toBeNull();
    expect(aimTarget(0, 0, 0, 30, [c("far", 50, 0)], 0)).toBeNull();
  });
  it("counts the hull radius and the aim tolerance", () => {
    expect(aimTarget(0, 0, Math.PI / 2, 60, [c("big", 8, 30, 10)], 0)?.target.id).toBe("big");
    expect(aimTarget(0, 0, 0, 60, [c("edge", 20, 5, 3)], 2)?.target.id).toBe("edge");
  });
  it("rejects invalid input", () => {
    expect(aimTarget(0, 0, Number.NaN, 60, [c("a", 10, 0)])).toBeNull();
    expect(aimTarget(0, 0, 0, 0, [c("a", 10, 0)])).toBeNull();
    expect(shipHitRadius(Number.NaN)).toBeGreaterThan(0);
  });
});
