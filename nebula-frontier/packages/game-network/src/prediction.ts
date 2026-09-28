import {
  DEFAULT_TUNING, stepShip, type MapBounds, type MotionState, type MotionStats, type MoveInput, type SimTuning,
} from "@nebula/game-core";

export interface PendingInput<I> {
  seq: number;
  input: I;
}

export interface ReconcilerOptions<S, I> {
  /** Deterministic step shared with the server. Must not mutate `state`. */
  step: (state: S, input: I) => S;
  /** Max unacknowledged inputs kept for replay (older are dropped). */
  maxPending?: number;
}

/**
 * Generic client-side prediction + server reconciliation (tosios / Colyseus
 * reconciler approach): every input is applied locally and stored; when the
 * server acknowledges seq N with its authoritative state, inputs ≤ N are
 * dropped and the rest are replayed on top of the server state.
 */
export class Reconciler<S, I> {
  private readonly step: (state: S, input: I) => S;
  private readonly maxPending: number;
  readonly pending: PendingInput<I>[] = [];
  state: S;
  lastAck = -1;

  constructor(initial: S, opts: ReconcilerOptions<S, I>) {
    this.state = initial;
    this.step = opts.step;
    this.maxPending = opts.maxPending ?? 128;
  }

  reset(state: S): void {
    this.state = state;
    this.pending.length = 0;
    this.lastAck = -1;
  }

  /** Apply an input locally (prediction) and remember it for replay. */
  predict(seq: number, input: I): S {
    this.state = this.step(this.state, input);
    this.pending.push({ seq, input });
    if (this.pending.length > this.maxPending) this.pending.splice(0, this.pending.length - this.maxPending);
    return this.state;
  }

  /** Adopt the authoritative state acknowledged up to `ackSeq` and replay the rest. */
  reconcile(serverState: S, ackSeq: number): S {
    this.lastAck = Math.max(this.lastAck, ackSeq);
    let drop = 0;
    while (drop < this.pending.length && (this.pending[drop]?.seq ?? Infinity) <= ackSeq) drop++;
    if (drop > 0) this.pending.splice(0, drop);
    let s = serverState;
    for (const p of this.pending) s = this.step(s, p.input);
    this.state = s;
    return s;
  }
}

export interface ShipPredictorOptions {
  stats: MotionStats;
  bounds: MapBounds;
  /** Fixed step (s) = 1 / server tick rate. */
  dt: number;
  tuning?: SimTuning;
  /** Corrections larger than this snap instantly (teleport, dash, respawn). */
  snapDistance?: number;
  /** Visual error decay rate (1/s). */
  smoothing?: number;
}

/** Local ship prediction using game-core `stepShip`, with visual error smoothing. */
export class ShipPredictor {
  readonly reconciler: Reconciler<MotionState, MoveInput>;
  stats: MotionStats;
  bounds: MapBounds;
  dt: number;
  tuning: SimTuning;
  private readonly snap2: number;
  private readonly smoothing: number;
  /** Previous fixed-step state for render interpolation. */
  private prev: MotionState;
  /** Visual correction offset (decays to 0). */
  errX = 0;
  errY = 0;
  errH = 0;
  boosting = false;
  lastCorrection = 0;

  constructor(initial: MotionState, opts: ShipPredictorOptions) {
    this.stats = opts.stats;
    this.bounds = opts.bounds;
    this.dt = opts.dt;
    this.tuning = opts.tuning ?? DEFAULT_TUNING;
    const s = opts.snapDistance ?? 12;
    this.snap2 = s * s;
    this.smoothing = opts.smoothing ?? 10;
    this.prev = { ...initial };
    this.reconciler = new Reconciler<MotionState, MoveInput>({ ...initial }, {
      step: (state, input) => {
        const r = stepShip(state, input, this.stats, this.dt, this.bounds, this.tuning);
        this.boosting = r.boosting;
        return { x: r.x, y: r.y, vx: r.vx, vy: r.vy, heading: r.heading, energy: r.energy };
      },
    });
  }

  get state(): MotionState {
    return this.reconciler.state;
  }

  reset(state: MotionState): void {
    this.reconciler.reset({ ...state });
    this.prev = { ...state };
    this.errX = this.errY = this.errH = 0;
  }

  /** Apply one fixed-step input. */
  step(seq: number, input: MoveInput): MotionState {
    this.prev = this.reconciler.state;
    return this.reconciler.predict(seq, input);
  }

  /** Server snapshot for the local entity. */
  reconcile(server: MotionState, ackSeq: number): void {
    const before = this.reconciler.state;
    const after = this.reconciler.reconcile({ ...server }, ackSeq);
    const dx = before.x - after.x, dy = before.y - after.y;
    const d2 = dx * dx + dy * dy;
    this.lastCorrection = Math.sqrt(d2);
    if (d2 > this.snap2) {
      this.errX = this.errY = this.errH = 0;
      this.prev = { ...after };
      return;
    }
    this.errX += dx;
    this.errY += dy;
    let dh = before.heading - after.heading;
    if (dh > Math.PI) dh -= Math.PI * 2;
    if (dh < -Math.PI) dh += Math.PI * 2;
    this.errH += dh;
    // shift the render-interpolation origin by the same correction
    this.prev = { ...this.prev, x: this.prev.x - dx, y: this.prev.y - dy };
  }

  /**
   * Render pose: interpolate between the last two fixed steps by `alpha`
   * (accumulator fraction) plus the decaying correction offset.
   */
  render(alpha: number, frameDt: number, out: { x: number; y: number; heading: number; vx: number; vy: number }): void {
    const k = Math.exp(-this.smoothing * Math.max(0, frameDt));
    this.errX *= k;
    this.errY *= k;
    this.errH *= k;
    const a = Math.max(0, Math.min(1, alpha));
    const p = this.prev, s = this.reconciler.state;
    out.x = p.x + (s.x - p.x) * a + this.errX;
    out.y = p.y + (s.y - p.y) * a + this.errY;
    let dh = s.heading - p.heading;
    if (dh > Math.PI) dh -= Math.PI * 2;
    if (dh < -Math.PI) dh += Math.PI * 2;
    out.heading = p.heading + dh * a + this.errH;
    out.vx = s.vx;
    out.vy = s.vy;
  }
}
