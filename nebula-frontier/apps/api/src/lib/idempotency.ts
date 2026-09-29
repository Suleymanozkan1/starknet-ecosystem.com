/**
 * Request-level idempotency for mutations that are not naturally keyed by a unique DB row.
 * First call runs `fn` under a Redis lock and caches the JSON result for 24h; replays return the
 * cached result; concurrent duplicates get 409 IDEMPOTENCY_IN_PROGRESS. Ledger postings inside
 * `fn` must ALSO derive their idempotency keys from the same key (defence in depth if Redis is lost).
 *
 * The pending lock carries a unique token and is extended while `fn` runs, so a slow request never
 * loses it to a duplicate; the result write and the failure cleanup are compare-and-set /
 * compare-and-delete on that token, so one request can never overwrite or delete another's key.
 */
import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { conflict } from "../errors.js";

const TTL_SEC = 24 * 3600;
const PENDING_PREFIX = "__pending__";
/** Pending-lock lifetime; refreshed every LOCK_TTL_MS / 3 while `fn` runs. */
export const LOCK_TTL_MS = 60_000;

/** PEXPIRE only while the key still holds our token. */
const EXTEND_IF_OWNER = `if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("PEXPIRE", KEYS[1], ARGV[2]) else return 0 end`;
/** DEL only while the key still holds our token. */
const DEL_IF_OWNER = `if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end`;
/** Replace our pending token with the result (EX seconds) only while we still own the key. */
const SET_IF_OWNER = `if redis.call("GET", KEYS[1]) == ARGV[1] then redis.call("SET", KEYS[1], ARGV[2], "EX", ARGV[3]) return 1 else return 0 end`;

const isPending = (v: string) => v === PENDING_PREFIX || v.startsWith(`${PENDING_PREFIX}:`);

export interface IdempotencyOptions {
  /** Pending-lock TTL override (tests). */
  lockTtlMs?: number;
}

export async function withIdempotency<T>(
  redis: Redis,
  scope: string,
  userId: string,
  key: string,
  fn: () => Promise<T>,
  opts: IdempotencyOptions = {},
): Promise<T> {
  const k = `idem:${scope}:${userId}:${key}`;
  const lockTtlMs = opts.lockTtlMs ?? LOCK_TTL_MS;
  const cached = await redis.get(k);
  if (cached !== null) {
    if (isPending(cached)) throw conflict("IDEMPOTENCY_IN_PROGRESS", "A request with this idempotency key is in progress");
    return JSON.parse(cached) as T;
  }
  const token = `${PENDING_PREFIX}:${randomUUID()}`;
  const locked = await redis.set(k, token, "PX", lockTtlMs, "NX");
  if (locked !== "OK") {
    const again = await redis.get(k);
    if (again !== null && !isPending(again)) return JSON.parse(again) as T;
    throw conflict("IDEMPOTENCY_IN_PROGRESS", "A request with this idempotency key is in progress");
  }
  // Keep the lock alive while fn runs (a lost lock would let a duplicate run concurrently).
  const keepAlive = setInterval(() => {
    void redis.eval(EXTEND_IF_OWNER, 1, k, token, String(lockTtlMs)).catch(() => undefined);
  }, Math.max(10, Math.floor(lockTtlMs / 3)));
  keepAlive.unref();
  let result: T;
  try {
    result = await fn();
  } catch (err) {
    clearInterval(keepAlive);
    await redis.eval(DEL_IF_OWNER, 1, k, token).catch(() => undefined);
    throw err;
  }
  clearInterval(keepAlive);
  const json = JSON.stringify(result, (_x, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
  try {
    await redis.eval(SET_IF_OWNER, 1, k, token, json, String(TTL_SEC));
  } catch (err) {
    await redis.eval(DEL_IF_OWNER, 1, k, token).catch(() => undefined);
    throw err;
  }
  return result;
}
