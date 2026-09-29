import { describe, expect, it } from "vitest";
import { createLogger, errorsTotal } from "@nebula/telemetry";
import { FinalFlushRetryQueue, type FlushTarget } from "./retry-queue.js";
import { PendingDelta, type FlushResult } from "./writer.js";

const log = createLogger({ name: "retry-queue-test", level: "silent" });
const ok = {} as FlushResult;
const ctx = { factionId: null, pet: null };

async function metric(code: string): Promise<number> {
  const m = await errorsTotal.get();
  return m.values.find((v) => v.labels.component === "persistence" && v.labels.code === code)?.value ?? 0;
}

function target(failures: number): FlushTarget & { calls: string[] } {
  let left = failures;
  const calls: string[] = [];
  return {
    calls,
    async flush(userId) {
      calls.push(userId);
      if (left-- > 0) throw new Error("db down");
      return ok;
    },
  };
}

function delta(xp: number): PendingDelta {
  const d = new PendingDelta();
  d.xp = xp;
  return d;
}

describe("FinalFlushRetryQueue", () => {
  it("retries a failed final delta with exponential backoff until it persists", async () => {
    let now = 0;
    const t = target(1);
    const q = new FinalFlushRetryQueue(t, log, { baseDelayMs: 1000, now: () => now });
    q.enqueue("u1", delta(5), [], new Set(), ctx);
    await q.retryDue();
    expect(t.calls).toEqual([]); // backoff not elapsed
    now = 1000;
    await q.retryDue(); // fails (attempt 2) -> next in 2000ms
    expect(q.size).toBe(1);
    now = 2500;
    await q.retryDue();
    expect(t.calls).toHaveLength(1);
    now = 3000;
    await q.retryDue();
    expect(t.calls).toHaveLength(2);
    expect(q.size).toBe(0);
    q.stop();
  });

  it("drain() forces retries (dispose); failures stay queued", async () => {
    const t = target(10);
    const q = new FinalFlushRetryQueue(t, log, { baseDelayMs: 60_000 });
    q.enqueue("u1", delta(1), [], new Set(), ctx);
    expect(await q.drain(2)).toBe(1);
    expect(t.calls).toHaveLength(2);
    q.stop();
  });

  it("drops a delta only after maxAttempts / on shutdown, and records an error metric", async () => {
    const before = await metric("flush_dropped");
    const q = new FinalFlushRetryQueue(target(100), log, { baseDelayMs: 1, maxAttempts: 3 });
    q.enqueue("u1", delta(1), [], new Set(), ctx);
    await q.drain(5);
    expect(q.size).toBe(0);
    expect(await metric("flush_dropped")).toBe(before + 1);
    q.enqueue("u2", delta(1), [], new Set(), ctx);
    expect(await q.drainAndDrop(1)).toBe(1);
    expect(await metric("flush_dropped")).toBe(before + 2);
  });
});
