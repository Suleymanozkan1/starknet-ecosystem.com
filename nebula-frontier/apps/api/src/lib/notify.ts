/**
 * In-app notifications + push delivery.
 *
 * `notify()` always writes the Notification row (in the caller's transaction when given one).
 * For push-worthy types (`PUSH_TYPES`) the row is also delivered to the user's registered devices
 * (Device.pushToken) through `PushSender`:
 *  - called with the root client (no transaction): delivered immediately after the insert;
 *  - called inside a transaction: delivered by `dispatchPendingPush` (background job), which only
 *    looks at rows older than the maximum transaction time so it never misses a late commit.
 * `Notification.pushedAt` is set only when at least one provider accepted the message. A Redis
 * lock per notification prevents double delivery between the two paths.
 */
import type { Redis } from "ioredis";
import type { Db, DbOrTx } from "@nebula/database";
import { toJsonValue } from "./json.js";
import type { PushSender } from "./push.js";

export const PushType = {
  AUCTION_WON: "AUCTION_WON",
  CLAN_INVITE: "CLAN_INVITE",
  CLAN_WAR_STARTED: "CLAN_WAR_STARTED",
  EVENT_STARTED: "EVENT_STARTED",
  REWARD_READY: "REWARD_READY",
  WITHDRAWAL_COMPLETED: "WITHDRAWAL_COMPLETED",
  FRIEND_ONLINE: "FRIEND_ONLINE",
  RAID_AVAILABLE: "RAID_AVAILABLE",
  MISSION_COMPLETE: "MISSION_COMPLETE",
} as const;
export const PUSH_TYPES: ReadonlySet<string> = new Set(Object.values(PushType));

/** Longer than the longest interactive transaction (15 s), see withSerializableTx. */
const COMMIT_LAG_MS = 16_000;
const WINDOW_MS = 30 * 60_000;

interface PushRuntime {
  db: Db;
  redis: Redis;
  sender: PushSender;
}
let runtime: PushRuntime | null = null;

/** Wire the process-wide push runtime (called by buildApp). */
export function configurePush(rt: PushRuntime | null): void {
  runtime = rt;
}

/** Interactive-transaction clients have no `$connect`; only writes through the root client are already committed. */
function isRootClient(db: DbOrTx): db is Db {
  return typeof (db as unknown as Record<string, unknown>).$connect === "function";
}

export async function notify(
  db: DbOrTx,
  userId: string,
  type: string,
  title: string,
  body: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  const row = await db.notification.create({ data: { userId, type, title, body, data: toJsonValue(data) }, select: { id: true } });
  const rt = runtime;
  if (rt?.sender.enabled && PUSH_TYPES.has(type) && isRootClient(db)) {
    // Not in a transaction: the row is committed, deliver now (errors never fail the caller).
    void deliverNotification(rt, row.id).catch(() => undefined);
  }
}

/** Deliver one notification to all of the user's push devices. Returns true if pushed. */
export async function deliverNotification(rt: PushRuntime, notificationId: string): Promise<boolean> {
  const lock = await rt.redis.set(`push:lock:${notificationId}`, "1", "EX", 3600, "NX");
  if (lock !== "OK") return false;
  const n = await rt.db.notification.findUnique({ where: { id: notificationId } });
  if (!n || n.pushedAt) return false;
  const devices = await rt.db.device.findMany({ where: { userId: n.userId, pushToken: { not: null } }, select: { id: true, platform: true, pushToken: true } });
  let delivered = false;
  let transient = false;
  for (const d of devices) {
    const res = await rt.sender.send(
      { deviceId: d.id, platform: d.platform, token: d.pushToken as string },
      { notificationId: n.id, type: n.type, title: n.title, body: n.body, data: (n.data ?? {}) as Record<string, unknown> },
    );
    if (res.ok) delivered = true;
    else if (res.reason === "TRANSPORT_ERROR" || /^HTTP_(5\d\d|429)$/.test(res.reason)) transient = true;
    else if (res.invalidToken) await rt.db.device.updateMany({ where: { id: d.id, pushToken: d.pushToken }, data: { pushToken: null } });
  }
  if (delivered) await rt.db.notification.updateMany({ where: { id: n.id, pushedAt: null }, data: { pushedAt: new Date() } });
  // Transient provider failure: release the lock so the next dispatcher tick retries (within the window).
  else if (transient) await rt.redis.del(`push:lock:${notificationId}`);
  return delivered;
}

/** Background delivery of push-worthy notifications written inside transactions (or by other services). */
export async function dispatchPendingPush(rt: PushRuntime | null = runtime, limit = 200): Promise<number> {
  if (!rt?.sender.enabled) return 0;
  const now = Date.now();
  const rows = await rt.db.notification.findMany({
    where: {
      type: { in: [...PUSH_TYPES] },
      pushedAt: null,
      createdAt: { gte: new Date(now - WINDOW_MS), lte: new Date(now - COMMIT_LAG_MS) },
      user: { devices: { some: { pushToken: { not: null } } } },
    },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true },
  });
  let n = 0;
  for (const r of rows) if (await deliverNotification(rt, r.id)) n++;
  return n;
}
