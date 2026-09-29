/** deliverNotification lock handling and batched notifyMany. */
import { randomUUID } from "node:crypto";
import type { Db, DbOrTx } from "@nebula/database";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUSH_LOCK_TTL_SEC, PushType, deliverNotification, notifyMany } from "./notify.js";
import type { PushSender } from "./push.js";

let redis: Redis;
beforeAll(() => {
  redis = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379", { maxRetriesPerRequest: 2 });
});
afterAll(async () => {
  await redis.quit();
});

const sender = (result: { ok: boolean; reason: string; invalidToken?: boolean }) =>
  ({ enabled: true, send: async () => result }) as unknown as PushSender;

function fakeDb(opts: { throwOnFind?: boolean } = {}) {
  const updates: string[] = [];
  const db = {
    notification: {
      async findUnique({ where }: { where: { id: string } }) {
        if (opts.throwOnFind) throw new Error("db down");
        return { id: where.id, userId: "u1", type: PushType.AUCTION_WON, title: "t", body: "b", data: {}, pushedAt: null };
      },
      async updateMany({ where }: { where: { id: string } }) {
        updates.push(where.id);
        return { count: 1 };
      },
    },
    device: {
      findMany: async () => [{ id: "d1", platform: "android", pushToken: "tok" }],
      updateMany: async () => ({ count: 1 }),
    },
  };
  return { db: db as unknown as Db, updates };
}

describe("deliverNotification", () => {
  it("releases the delivery lock when the database throws", async () => {
    const id = randomUUID();
    const { db } = fakeDb({ throwOnFind: true });
    await expect(deliverNotification({ db, redis, sender: sender({ ok: true, reason: "OK" }) }, id)).rejects.toThrow("db down");
    expect(await redis.exists(`push:lock:${id}`)).toBe(0);
  });

  it("uses a short in-flight lock and marks the row pushed on success", async () => {
    const id = randomUUID();
    const { db, updates } = fakeDb();
    expect(await deliverNotification({ db, redis, sender: sender({ ok: true, reason: "OK" }) }, id)).toBe(true);
    expect(updates).toEqual([id]);
    const ttl = await redis.ttl(`push:lock:${id}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(PUSH_LOCK_TTL_SEC);
    // A concurrent/second attempt is refused while the lock exists.
    expect(await deliverNotification({ db, redis, sender: sender({ ok: true, reason: "OK" }) }, id)).toBe(false);
    await redis.del(`push:lock:${id}`);
  });

  it("releases the lock on transient provider failures and keeps a give-up marker on permanent ones", async () => {
    const transientId = randomUUID();
    const { db } = fakeDb();
    expect(await deliverNotification({ db, redis, sender: sender({ ok: false, reason: "HTTP_503" }) }, transientId)).toBe(false);
    expect(await redis.exists(`push:lock:${transientId}`)).toBe(0);

    const permanentId = randomUUID();
    expect(await deliverNotification({ db, redis, sender: sender({ ok: false, reason: "HTTP_400" }) }, permanentId)).toBe(false);
    expect(await redis.ttl(`push:lock:${permanentId}`)).toBeGreaterThan(PUSH_LOCK_TTL_SEC);
    await redis.del(`push:lock:${permanentId}`);
  });
});

describe("notifyMany", () => {
  it("writes one createMany per chunk, dedupes user ids and keeps type/title/body/data", async () => {
    const calls: { userId: string; type: string; title: string; body: string; data: unknown }[][] = [];
    const db = {
      notification: {
        async createMany({ data }: { data: { userId: string; type: string; title: string; body: string; data: unknown }[] }) {
          calls.push(data);
          return { count: data.length };
        },
      },
    } as unknown as DbOrTx;
    const ids = Array.from({ length: 2500 }, (_, i) => `u${i}`);
    const n = await notifyMany(db, { userIds: [...ids, "u0", "u1"], type: PushType.EVENT_STARTED, title: "Event", body: "Go", data: { eventId: "e1", big: 3n } });
    expect(n).toBe(2500);
    expect(calls.map((c) => c.length)).toEqual([1000, 1000, 500]);
    expect(calls[0]?.[0]).toEqual({ userId: "u0", type: "EVENT_STARTED", title: "Event", body: "Go", data: { eventId: "e1", big: "3" } });
    expect(await notifyMany(db, { userIds: [], type: "X", title: "t", body: "b" })).toBe(0);
    expect(calls).toHaveLength(3);
  });
});
