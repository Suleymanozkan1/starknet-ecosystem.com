/** createJobRunner: local running guard, token-owned Redis lock, compare-and-delete release. */
import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createJobRunner } from "./index.js";

let redis: Redis;
beforeAll(() => {
  redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379", { maxRetriesPerRequest: 2 });
});
afterAll(async () => {
  await redis.quit();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = { info: () => undefined, error: () => undefined };

describe("createJobRunner", () => {
  it("skips overlapping ticks in the same instance while a run is in progress", async () => {
    const name = `t-${randomUUID()}`;
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const run = createJobRunner({ redis, log }, name, 1500, async () => { runs++; await gate; return 0; });
    const first = run();
    await sleep(20);
    await run(); // overlapping tick: returns immediately
    release();
    await first;
    expect(runs).toBe(1);
    await redis.del(`job:${name}`);
  });

  it("keeps the lock alive during a long run so another instance cannot start it", async () => {
    const name = `t-${randomUUID()}`;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let otherRuns = 0;
    const a = createJobRunner({ redis, log }, name, 1500, async () => { await gate; return 0; }); // lock TTL 1000 ms
    const b = createJobRunner({ redis, log }, name, 1500, async () => { otherRuns++; return 0; });
    const running = a();
    await sleep(1400); // past the initial TTL
    await b();
    expect(otherRuns).toBe(0);
    release();
    await running;
  });

  it("releases its own lock after a run that outlasted the tick window, and never someone else's", async () => {
    const name = `t-${randomUUID()}`;
    const key = `job:${name}`;
    // ms = 1100 -> lock TTL 1000 ms; the run takes longer, so the lock is released at the end.
    const run = createJobRunner({ redis, log }, name, 1100, async () => { await sleep(1100); return 0; });
    await run();
    expect(await redis.exists(key)).toBe(0);

    // A run whose lock was taken over by another instance must leave that lock alone.
    const run2 = createJobRunner({ redis, log }, name, 1100, async () => {
      await redis.set(key, "other-instance", "PX", 5000);
      return 0;
    });
    await run2();
    expect(await redis.get(key)).toBe("other-instance");
    await redis.del(key);
  });

  it("holds the lock for the rest of the tick window after a short run and logs failures", async () => {
    const name = `t-${randomUUID()}`;
    const errors: object[] = [];
    const run = createJobRunner({ redis, log: { info: () => undefined, error: (o: object) => { errors.push(o); } } }, name, 2000, async () => {
      throw new Error("boom");
    });
    await run();
    expect(errors).toHaveLength(1);
    const pttl = await redis.pttl(`job:${name}`);
    expect(pttl).toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(1500);
    await redis.del(`job:${name}`);
  });
});
