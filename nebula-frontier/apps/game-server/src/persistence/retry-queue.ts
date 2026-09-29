/**
 * Process-level retry queue for FINAL player flushes (leave / room dispose / shutdown).
 *
 * After `removePlayer` the actor is no longer in `room.players`, so a failed final flush would never be
 * retried by `flushAll` — the session's unpersisted delta would be lost. Failed final deltas are parked
 * here (process-wide, so a room that disposes right after its last player left does not take them down
 * with it) and retried with exponential backoff. `drain()` forces retries on dispose / graceful shutdown.
 * A delta is only ever dropped after `maxAttempts` failures, and every drop increments
 * `nebula_errors_total{component="persistence",code="flush_dropped"}`.
 */
import { errorsTotal, type Logger } from "@nebula/telemetry";
import type { QuestRuntime } from "./player.js";
import type { FlushContext, FlushResult, PendingDelta } from "./writer.js";

export interface FlushTarget {
  flush(userId: string, d: PendingDelta, quests: Iterable<QuestRuntime>, unlocked: Set<string>, ctx?: FlushContext): Promise<FlushResult>;
}

interface Entry {
  userId: string;
  delta: PendingDelta;
  quests: QuestRuntime[];
  achievements: Set<string>;
  ctx: FlushContext;
  attempts: number;
  nextAt: number;
}

export interface FinalFlushRetryOptions {
  baseDelayMs: number;
  maxDelayMs?: number;
  maxAttempts?: number;
  now?: () => number;
}

export class FinalFlushRetryQueue {
  private readonly target: FlushTarget;
  private readonly log: Logger;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly maxAttempts: number;
  private readonly now: () => number;
  private readonly entries: Entry[] = [];
  private running: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(target: FlushTarget, log: Logger, opts: FinalFlushRetryOptions) {
    this.target = target;
    this.log = log;
    this.baseDelayMs = Math.max(1, opts.baseDelayMs);
    this.maxDelayMs = opts.maxDelayMs ?? 5 * 60_000;
    this.maxAttempts = opts.maxAttempts ?? 12;
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.entries.length;
  }

  /** Park a failed final delta (the caller must stop using `delta` afterwards). */
  enqueue(userId: string, delta: PendingDelta, quests: Iterable<QuestRuntime>, achievements: Set<string>, ctx: FlushContext): void {
    this.entries.push({ userId, delta, quests: [...quests], achievements, ctx, attempts: 1, nextAt: this.now() + this.backoff(1) });
    this.log.warn({ userId, queued: this.entries.length }, "final flush failed; queued for retry");
    this.ensureTimer();
  }

  /** Retry every entry whose backoff elapsed (or all, when `force`). Serialised: one pass at a time. */
  async retryDue(force = false): Promise<void> {
    while (this.running) await this.running;
    const pass = this.pass(force);
    this.running = pass;
    try {
      await pass;
    } finally {
      this.running = null;
      if (this.entries.length === 0) this.stop();
    }
  }

  /** Dispose / shutdown: force up to `rounds` immediate retries; anything still failing afterwards stays queued. */
  async drain(rounds = 3): Promise<number> {
    for (let i = 0; i < rounds && this.entries.length > 0; i++) await this.retryDue(true);
    return this.entries.length;
  }

  /** Final shutdown: drain, then drop (with an error metric) whatever still cannot be persisted. */
  async drainAndDrop(rounds = 3): Promise<number> {
    await this.drain(rounds);
    const left = this.entries.splice(0);
    for (const e of left) this.drop(e, "shutdown");
    this.stop();
    return left.length;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.retryDue(false), this.baseDelayMs);
    this.timer.unref();
  }

  private backoff(attempts: number): number {
    return Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** Math.max(0, attempts - 1));
  }

  private async pass(force: boolean): Promise<void> {
    // Oldest first and sequential, so several queued deltas of one pilot apply in order. Once an older entry of a
    // pilot is not persisted in this pass (backoff pending or failed), that pilot's newer entries wait too: they
    // carry absolute writes (quest progress, position) that must never land before the older delta.
    const blocked = new Set<string>();
    for (const e of [...this.entries]) {
      if (blocked.has(e.userId)) continue;
      if (!force && e.nextAt > this.now()) {
        blocked.add(e.userId);
        continue;
      }
      try {
        await this.target.flush(e.userId, e.delta, e.quests, e.achievements, e.ctx);
        this.entries.splice(this.entries.indexOf(e), 1);
        this.log.info({ userId: e.userId, attempts: e.attempts + 1 }, "queued final flush persisted");
      } catch (err) {
        blocked.add(e.userId);
        e.attempts++;
        errorsTotal.inc({ component: "persistence", code: "flush_retry" });
        if (e.attempts >= this.maxAttempts) {
          this.entries.splice(this.entries.indexOf(e), 1);
          this.drop(e, "max_attempts", err);
        } else {
          e.nextAt = this.now() + this.backoff(e.attempts);
          this.log.warn({ err, userId: e.userId, attempts: e.attempts }, "queued final flush failed; backing off");
        }
      }
    }
  }

  private drop(e: Entry, reason: string, err?: unknown): void {
    errorsTotal.inc({ component: "persistence", code: "flush_dropped" });
    this.log.error({ err, userId: e.userId, attempts: e.attempts, reason, xp: e.delta.xp, honor: e.delta.honor, issuance: e.delta.issuance.length }, "final flush dropped: delta could not be persisted");
  }
}
