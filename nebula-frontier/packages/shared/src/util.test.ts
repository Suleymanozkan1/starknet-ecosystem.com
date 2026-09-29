import { describe, expect, it } from "vitest";
import { TAU, clamp, formatUnits, lerpAngle, mulRatio, parseUnits, toBigInt, wrapAngle } from "./util.js";

describe("clamp", () => {
  it("clamps into range and maps NaN input to min", () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
    expect(clamp(2, 0, 3)).toBe(2);
    expect(clamp(Number.NaN, 1, 3)).toBe(1);
  });
  it("throws on invalid bounds", () => {
    expect(() => clamp(1, 3, 0)).toThrow();
    expect(() => clamp(1, Number.NaN, 3)).toThrow();
    expect(() => clamp(1, 0, Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe("wrapAngle / lerpAngle", () => {
  it("wraps into [-PI, PI]", () => {
    expect(wrapAngle(TAU + 0.5)).toBeCloseTo(0.5);
    expect(wrapAngle(-TAU - 0.5)).toBeCloseTo(-0.5);
  });
  it("returns 0 for non-finite input so lerpAngle never yields NaN", () => {
    expect(wrapAngle(Number.NaN)).toBe(0);
    expect(wrapAngle(Number.POSITIVE_INFINITY)).toBe(0);
    expect(lerpAngle(1, Number.POSITIVE_INFINITY, 0.5)).toBe(1);
    expect(lerpAngle(Number.NaN, 1, 0.5)).toBe(1);
    expect(lerpAngle(Number.NEGATIVE_INFINITY, Number.NaN, 0.5)).toBe(0);
    expect(lerpAngle(1, 2, Number.NaN)).toBe(1);
  });
});

describe("toBigInt", () => {
  it("accepts safe integers and rejects unsafe numbers", () => {
    expect(toBigInt(42)).toBe(42n);
    expect(toBigInt("-7")).toBe(-7n);
    expect(() => toBigInt(2 ** 53)).toThrow();
    expect(() => toBigInt(1.5)).toThrow();
    expect(() => toBigInt(Number.NaN)).toThrow();
  });
});

describe("mulRatio", () => {
  it("multiplies with ppm precision, truncating", () => {
    expect(mulRatio(1000n, 0.05)).toBe(50n);
    expect(mulRatio(999n, 0.1)).toBe(99n);
    expect(mulRatio(1_000_000n, 0.0000015)).toBe(2n);
  });
  it("throws on non-finite ratio", () => {
    expect(() => mulRatio(10n, Number.NaN)).toThrow();
    expect(() => mulRatio(10n, Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe("formatUnits / parseUnits", () => {
  it("formats and parses round-trip", () => {
    expect(formatUnits(1_500_000_000n, 9)).toBe("1.5");
    expect(formatUnits("-2000000000", 9)).toBe("-2");
    expect(formatUnits(7n, 0)).toBe("7");
    expect(parseUnits("1.5", 9)).toBe(1_500_000_000n);
    expect(parseUnits("3", 0)).toBe(3n);
    expect(parseUnits("0.000000001", 9)).toBe(1n);
  });
  it("rejects invalid decimals", () => {
    expect(() => formatUnits(1n, -1)).toThrow("Invalid decimals");
    expect(() => formatUnits(1n, 1.5)).toThrow("Invalid decimals");
    expect(() => parseUnits("1", -1)).toThrow("Invalid decimals");
  });
  it("rejects more fraction digits than decimals", () => {
    expect(() => parseUnits("0.0000000001", 9)).toThrow();
    expect(() => parseUnits("1.5", 0)).toThrow();
    expect(() => parseUnits("abc", 9)).toThrow();
  });
});
