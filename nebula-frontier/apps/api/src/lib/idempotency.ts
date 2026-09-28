/**
 * Request-level idempotency for mutations that are not naturally keyed by a unique DB row.
 * First call runs `fn` under a Redis lock and caches the JSON result for 24h; replays return the
 * cached result; concurrent duplicates get 409 IDEMPOTENCY_IN_PROGRESS. Ledger postings inside
 * `fn` must ALSO derive their idempotency keys from the same key (defence in depth if Redis is lost).
 */
import type { Redis } from "ioredis";
import { conflict } from "../errors.js";

const TTL_SEC = 24 * 3600;

export async function withIdempotency<T>(redis: Redis, scope: string, userId: string, key: string, fn: () => Promise<T>): Promise<T> {
  const k = `idem:${scope}:${userId}:${key}`;
  const cached = await redis.get(k);
  if (cached && cached !== "__pending__") return JSON.parse(cached) as T;
  if (cached === "__pending__") throw conflict("IDEMPOTENCY_IN_PROGRESS", "A request with this idempotency key is in progress");
  const locked = await redis.set(k, "__pending__", "EX", 60, "NX");
  if (locked !== "OK") {
    const again = await redis.get(k);
    if (again && again !== "__pending__") return JSON.parse(again) as T;
    throw conflict("IDEMPOTENCY_IN_PROGRESS", "A request with this idempotency key is in progress");
  }
  try {
    const result = await fn();
    await redis.set(k, JSON.stringify(result, (_x, v: unknown) => (typeof v === "bigint" ? v.toString() : v)), "EX", TTL_SEC);
    return result;
  } catch (err) {
    await redis.del(k);
    throw err;
  }
}
