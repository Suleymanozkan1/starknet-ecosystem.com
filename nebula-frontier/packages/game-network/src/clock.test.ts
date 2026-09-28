import { describe, expect, it } from "vitest";
import { PingTracker } from "./clock.js";
import { Emitter } from "./emitter.js";

describe("PingTracker", () => {
  it("smooths RTT samples", () => {
    const p = new PingTracker();
    p.sample(0, 100);
    expect(p.ping).toBe(100);
    p.sample(1000, 1050);
    expect(p.rtt).toBeCloseTo(90);
    expect(p.jitter).toBeGreaterThan(0);
  });
});

describe("Emitter", () => {
  it("delivers typed events and unsubscribes", () => {
    const e = new Emitter<{ a: number; b: string }>();
    const got: number[] = [];
    const off = e.on("a", (n) => got.push(n));
    e.emit("a", 1);
    off();
    e.emit("a", 2);
    expect(got).toEqual([1]);
  });
});
