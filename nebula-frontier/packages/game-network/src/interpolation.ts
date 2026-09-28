import { lerpAngle } from "@nebula/shared";

/** Motion sample stored per entity. */
export interface MotionSample {
  x: number;
  y: number;
  heading: number;
  vx: number;
  vy: number;
}

export interface InterpolationOptions {
  /** Samples kept per entity. */
  capacity?: number;
  /** Max time to extrapolate beyond the newest sample (ms). */
  maxExtrapolateMs?: number;
  /** Distance jump treated as a teleport (no gliding). */
  snapDistance?: number;
  /** A gap longer than this between samples is treated as "entity was at rest" (ms). */
  holdGapMs?: number;
}

/**
 * Ring buffer of timestamped motion samples for one remote entity. Rendering
 * samples it at `now - delay` (snapshot interpolation, Valve/Gambetta style).
 */
export class SnapshotBuffer {
  private readonly cap: number;
  private readonly t: Float64Array;
  private readonly data: Float64Array; // x, y, heading, vx, vy
  private head = -1;
  private count = 0;
  private readonly maxExtrapolateMs: number;
  private readonly snap2: number;
  private readonly holdGapMs: number;

  constructor(opts: InterpolationOptions = {}) {
    this.cap = Math.max(4, opts.capacity ?? 32);
    this.t = new Float64Array(this.cap);
    this.data = new Float64Array(this.cap * 5);
    this.maxExtrapolateMs = opts.maxExtrapolateMs ?? 200;
    const s = opts.snapDistance ?? 40;
    this.snap2 = s * s;
    this.holdGapMs = opts.holdGapMs ?? 250;
  }

  get size(): number {
    return this.count;
  }

  get newestTime(): number {
    return this.count > 0 ? (this.t[this.head] ?? 0) : Number.NEGATIVE_INFINITY;
  }

  clear(): void {
    this.head = -1;
    this.count = 0;
  }

  private write(time: number, x: number, y: number, heading: number, vx: number, vy: number): void {
    this.head = (this.head + 1) % this.cap;
    this.t[this.head] = time;
    const o = this.head * 5;
    this.data[o] = x; this.data[o + 1] = y; this.data[o + 2] = heading; this.data[o + 3] = vx; this.data[o + 4] = vy;
    if (this.count < this.cap) this.count++;
  }

  push(time: number, s: MotionSample): void {
    if (this.count > 0) {
      const last = this.t[this.head] ?? 0;
      if (time < last) return; // out-of-order
      if (time === last) {
        const o = this.head * 5;
        this.data[o] = s.x; this.data[o + 1] = s.y; this.data[o + 2] = s.heading; this.data[o + 3] = s.vx; this.data[o + 4] = s.vy;
        return;
      }
      if (time - last > this.holdGapMs) {
        // The entity was stationary (no patches): hold the previous pose until just before this sample
        const o = this.head * 5;
        this.write(time - Math.min(50, (time - last) / 2), this.data[o] ?? 0, this.data[o + 1] ?? 0, this.data[o + 2] ?? 0, 0, 0);
      }
    }
    this.write(time, s.x, s.y, s.heading, s.vx, s.vy);
  }

  /** Sample at `time` into `out`. Returns false when empty. */
  sample(time: number, out: MotionSample): boolean {
    if (this.count === 0) return false;
    const idx = (k: number): number => (this.head - k + this.cap) % this.cap; // k = 0 newest
    const newest = idx(0);
    const tn = this.t[newest] ?? 0;
    if (time >= tn) {
      const o = newest * 5;
      const ext = Math.min(this.maxExtrapolateMs, time - tn) / 1000;
      out.vx = this.data[o + 3] ?? 0;
      out.vy = this.data[o + 4] ?? 0;
      out.x = (this.data[o] ?? 0) + out.vx * ext;
      out.y = (this.data[o + 1] ?? 0) + out.vy * ext;
      out.heading = this.data[o + 2] ?? 0;
      return true;
    }
    for (let k = 1; k < this.count; k++) {
      const a = idx(k), b = idx(k - 1);
      const ta = this.t[a] ?? 0, tb = this.t[b] ?? 0;
      if (time >= ta) {
        const oa = a * 5, ob = b * 5;
        const ax = this.data[oa] ?? 0, ay = this.data[oa + 1] ?? 0;
        const bx = this.data[ob] ?? 0, by = this.data[ob + 1] ?? 0;
        const alpha = tb > ta ? (time - ta) / (tb - ta) : 1;
        const dx = bx - ax, dy = by - ay;
        if (dx * dx + dy * dy > this.snap2) {
          // teleport: cut instead of gliding
          const src = alpha < 0.5 ? oa : ob;
          out.x = this.data[src] ?? 0; out.y = this.data[src + 1] ?? 0; out.heading = this.data[src + 2] ?? 0;
          out.vx = this.data[src + 3] ?? 0; out.vy = this.data[src + 4] ?? 0;
          return true;
        }
        out.x = ax + dx * alpha;
        out.y = ay + dy * alpha;
        out.heading = lerpAngle(this.data[oa + 2] ?? 0, this.data[ob + 2] ?? 0, alpha);
        out.vx = (this.data[oa + 3] ?? 0) + ((this.data[ob + 3] ?? 0) - (this.data[oa + 3] ?? 0)) * alpha;
        out.vy = (this.data[oa + 4] ?? 0) + ((this.data[ob + 4] ?? 0) - (this.data[oa + 4] ?? 0)) * alpha;
        return true;
      }
    }
    // older than everything we have: oldest sample
    const oldest = idx(this.count - 1) * 5;
    out.x = this.data[oldest] ?? 0; out.y = this.data[oldest + 1] ?? 0; out.heading = this.data[oldest + 2] ?? 0;
    out.vx = this.data[oldest + 3] ?? 0; out.vy = this.data[oldest + 4] ?? 0;
    return true;
  }
}

/** Interpolation buffers for all remote entities, rendered `delayMs` in the past. */
export class InterpolationBuffer {
  private readonly buffers = new Map<string, SnapshotBuffer>();
  private readonly opts: InterpolationOptions;
  delayMs: number;

  constructor(delayMs = 100, opts: InterpolationOptions = {}) {
    this.delayMs = delayMs;
    this.opts = opts;
  }

  push(id: string, time: number, s: MotionSample): void {
    let b = this.buffers.get(id);
    if (!b) {
      b = new SnapshotBuffer(this.opts);
      this.buffers.set(id, b);
    }
    b.push(time, s);
  }

  /** Sample entity `id` for a frame rendered at local time `now`. */
  sample(id: string, now: number, out: MotionSample): boolean {
    const b = this.buffers.get(id);
    return b ? b.sample(now - this.delayMs, out) : false;
  }

  has(id: string): boolean {
    return this.buffers.has(id);
  }

  remove(id: string): void {
    this.buffers.delete(id);
  }

  clear(): void {
    this.buffers.clear();
  }

  get size(): number {
    return this.buffers.size;
  }
}
