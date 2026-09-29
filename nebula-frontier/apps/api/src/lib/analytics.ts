/**
 * Batched AnalyticsEvent writer. `track()` never blocks or fails a request: events are buffered
 * and flushed with `createMany` every `intervalMs` or when the buffer reaches `maxBatch`. Buffer
 * overflow drops the oldest events (analytics is best effort, the ledger/audit log are not).
 */
import type { Db } from "@nebula/database";
import { toJsonValue } from "./json.js";

export const AnalyticsName = {
  LOGIN: "LOGIN",
  LOGOUT: "LOGOUT",
  PURCHASE: "PURCHASE",
  TRADE: "TRADE",
  AUCTION: "AUCTION",
  REWARD_CLAIM: "REWARD_CLAIM",
} as const;
export type AnalyticsName = (typeof AnalyticsName)[keyof typeof AnalyticsName];

interface Pending {
  name: string;
  userId: string | null;
  props: Record<string, unknown>;
  platform: string | null;
  createdAt: Date;
}

type Logger = { warn: (obj: object, msg?: string) => void };

export class AnalyticsWriter {
  private buf: Pending[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private db: Db;
  private maxBatch: number;
  private maxBuffer: number;
  private log: Logger | undefined;

  constructor(db: Db, opts: { intervalMs?: number; maxBatch?: number; maxBuffer?: number; log?: Logger } = {}) {
    this.db = db;
    this.maxBatch = opts.maxBatch ?? 100;
    this.maxBuffer = opts.maxBuffer ?? 10_000;
    this.log = opts.log;
    const interval = opts.intervalMs ?? 2000;
    if (interval > 0) {
      this.timer = setInterval(() => void this.flush(), interval);
      this.timer.unref();
    }
  }

  track(name: AnalyticsName | string, userId: string | null, props: Record<string, unknown> = {}, platform: string | null = null): void {
    this.buf.push({ name, userId, props, platform, createdAt: new Date() });
    if (this.buf.length > this.maxBuffer) this.buf.splice(0, this.buf.length - this.maxBuffer);
    if (this.buf.length >= this.maxBatch) void this.flush();
  }

  get pending(): number {
    return this.buf.length;
  }

  /** Write everything buffered so far (serialised: one flush at a time). */
  async flush(): Promise<void> {
    // Loop: several callers may wake from the same in-flight flush; only the first may start the next one.
    while (this.flushing) await this.flushing;
    if (!this.buf.length) return;
    const batch = this.buf.splice(0, this.buf.length);
    this.flushing = (async () => {
      for (let i = 0; i < batch.length; i += this.maxBatch) {
        const chunk = batch.slice(i, i + this.maxBatch);
        try {
          await this.db.analyticsEvent.createMany({
            data: chunk.map((e) => ({ name: e.name, userId: e.userId, props: toJsonValue(e.props), platform: e.platform, createdAt: e.createdAt })),
          });
        } catch (err) {
          this.log?.warn({ err: (err as Error).message, dropped: chunk.length }, "analytics flush failed");
        }
      }
    })();
    try {
      await this.flushing;
    } finally {
      this.flushing = null;
    }
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }
}
