import { describe, expect, it } from "vitest";
import { ObjectPool } from "./pool.js";
import { AdaptiveResolution } from "./backend.js";

describe("ObjectPool", () => {
  it("recycles objects and enforces the budget", () => {
    let created = 0;
    const resets: number[] = [];
    const pool = new ObjectPool<{ id: number }>({ create: () => ({ id: created++ }), reset: (o) => resets.push(o.id), max: 3, initial: 1 });
    expect(pool.created).toBe(1);
    const a = pool.acquire(), b = pool.acquire(), c = pool.acquire();
    expect(a && b && c).toBeTruthy();
    expect(pool.acquire()).toBeNull();
    expect(pool.active).toBe(3);
    if (a) pool.release(a);
    if (a) pool.release(a); // double release is ignored
    expect(resets).toEqual([a?.id]);
    expect(pool.acquire()).toBe(a);
    expect(created).toBe(3);
  });

  it("supports budget changes, iteration and dispose", () => {
    const disposed: number[] = [];
    let n = 0;
    const pool = new ObjectPool<{ id: number }>({ create: () => ({ id: n++ }), dispose: (o) => disposed.push(o.id), max: 1 });
    pool.acquire();
    expect(pool.acquire()).toBeNull();
    pool.setMax(2);
    expect(pool.acquire()).not.toBeNull();
    let seen = 0;
    pool.forEachActive(() => seen++);
    expect(seen).toBe(2);
    pool.releaseAll();
    expect(pool.active).toBe(0);
    pool.dispose();
    expect(disposed).toEqual([0, 1]);
  });
});

describe("AdaptiveResolution", () => {
  it("drops pixel ratio under sustained load and recovers with headroom", () => {
    const ar = new AdaptiveResolution({ min: 0.6, max: 1.5, targetFps: 60 });
    let changed: number | null = null;
    for (let i = 0; i < 200 && changed === null; i++) changed = ar.sample(33);
    expect(changed).not.toBeNull();
    expect(ar.ratio).toBeLessThan(1.5);
    const low = ar.ratio;
    for (let i = 0; i < 2000; i++) ar.sample(8);
    expect(ar.ratio).toBeGreaterThan(low);
    for (let i = 0; i < 5000; i++) ar.sample(40);
    expect(ar.ratio).toBeGreaterThanOrEqual(0.6);
  });

  it("can be disabled", () => {
    const ar = new AdaptiveResolution({ min: 0.5, max: 1, targetFps: 60 });
    ar.enabled = false;
    for (let i = 0; i < 500; i++) expect(ar.sample(50)).toBeNull();
  });
});
