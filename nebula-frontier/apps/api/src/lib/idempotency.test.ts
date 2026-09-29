/** withIdempotency: token-owned pending lock, keep-alive while running, compare-and-delete. */
import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withIdempotency } from "./idempotency.js";

let redis: Redis;
beforeAll(() => {
  redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379", { maxRetriesPerRequest: 2 });
});
afterAll(async () => {
  await redis.quit();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("withIdempotency", () => {
  it("caches the result and replays it without re-running fn", async () => {
    const key = randomUUID();
    let runs = 0;
    const fn = async () => ({ n: ++runs, big: 5n });
    const a = await withIdempotency(redis, "t", "u", key, fn);
    const b = await withIdempotency(redis, "t", "u", key, fn);
    expect(runs).toBe(1);
    expect(a.n).toBe(1);
    expect(b).toEqual({ n: 1, big: "5" });
  });

  it("keeps the pending lock alive while fn outlasts the lock TTL", async () => {
    const key = randomUUID();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = withIdempotency(redis, "t", "u", key, async () => { await gate; return 1; }, { lockTtlMs: 150 });
    await sleep(450); // three TTLs: without keep-alive the lock would be gone
    await expect(withIdempotency(redis, "t", "u", key, async () => 2, { lockTtlMs: 150 })).rejects.toMatchObject({ code: "IDEMPOTENCY_IN_PROGRESS" });
    release();
    expect(await first).toBe(1);
    expect(await withIdempotency(redis, "t", "u", key, async () => 3)).toBe(1);
  });

  it("on failure deletes only its own lock, never another request's key", async () => {
    const key = randomUUID();
    const k = `idem:t:u:${key}`;
    await expect(
      withIdempotency(redis, "t", "u", key, async () => {
        // Simulate our lock expiring and another request taking the key over.
        await redis.set(k, "__pending__:someone-else", "PX", 5000);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await redis.get(k)).toBe("__pending__:someone-else");
    await redis.del(k);

    await expect(withIdempotency(redis, "t", "u", key, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await redis.get(k)).toBeNull();
  });

  it("does not overwrite a key another request now owns with its result", async () => {
    const key = randomUUID();
    const k = `idem:t:u:${key}`;
    const r = await withIdempotency(redis, "t", "u", key, async () => {
      await redis.set(k, "__pending__:someone-else", "PX", 5000);
      return 7;
    });
    expect(r).toBe(7);
    expect(await redis.get(k)).toBe("__pending__:someone-else");
    await redis.del(k);
  });
});
