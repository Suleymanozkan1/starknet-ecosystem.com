/**
 * Generic object pool. Objects are created up-front (or lazily up to `max`)
 * and recycled, so hot paths never allocate. `acquire()` returns null when the
 * budget is exhausted — callers must degrade gracefully (skip the effect).
 */
export interface PoolOptions<T> {
  create: () => T;
  /** Called when an object is returned to the pool. */
  reset?: (item: T) => void;
  /** Called on pool dispose for every object ever created. */
  dispose?: (item: T) => void;
  /** Objects to create immediately. */
  initial?: number;
  /** Hard cap (budget). */
  max: number;
}

export class ObjectPool<T> {
  private readonly free: T[] = [];
  private readonly all: T[] = [];
  private readonly activeSet = new Set<T>();
  private readonly opts: PoolOptions<T>;
  private maxSize: number;

  constructor(opts: PoolOptions<T>) {
    this.opts = opts;
    this.maxSize = opts.max;
    const n = Math.min(opts.initial ?? 0, opts.max);
    for (let i = 0; i < n; i++) {
      const it = opts.create();
      this.all.push(it);
      this.free.push(it);
    }
  }

  acquire(): T | null {
    let it = this.free.pop();
    if (it === undefined) {
      if (this.all.length >= this.maxSize) return null;
      it = this.opts.create();
      this.all.push(it);
    }
    this.activeSet.add(it);
    return it;
  }

  release(item: T): void {
    if (!this.activeSet.delete(item)) return;
    this.opts.reset?.(item);
    this.free.push(item);
  }

  /** Iterate active items without allocating. Safe to release the current item during iteration. */
  forEachActive(fn: (item: T) => void): void {
    for (const it of this.activeSet) fn(it);
  }

  releaseAll(): void {
    for (const it of this.activeSet) {
      this.opts.reset?.(it);
      this.free.push(it);
    }
    this.activeSet.clear();
  }

  /** Change the budget (graphics tier switch). Existing objects are kept. */
  setMax(max: number): void {
    this.maxSize = Math.max(0, max);
  }

  get active(): number {
    return this.activeSet.size;
  }
  get created(): number {
    return this.all.length;
  }
  get max(): number {
    return this.maxSize;
  }

  dispose(): void {
    if (this.opts.dispose) for (const it of this.all) this.opts.dispose(it);
    this.all.length = 0;
    this.free.length = 0;
    this.activeSet.clear();
  }
}
