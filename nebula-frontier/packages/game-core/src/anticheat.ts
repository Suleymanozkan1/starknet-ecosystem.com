/**
 * Anti-cheat validators. All are deterministic, allocation-light, and take
 * the server clock as an argument (no Date.now inside) so they are testable.
 *
 * Signals map to `CheatType` values; the server aggregates them with
 * `RiskAccumulator` and forwards threshold crossings to `recordRiskSignal`.
 */
import type { CheatType } from "@nebula/shared";

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/** Classic token bucket. `ratePerSec` tokens refill continuously up to `burst`. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  readonly ratePerSec: number;
  readonly burst: number;
  constructor(ratePerSec: number, burst: number, now: number) {
    this.ratePerSec = ratePerSec;
    this.burst = burst;
    this.tokens = burst;
    this.last = now;
  }
  refill(now: number): void {
    const dt = Math.max(0, now - this.last) / 1000;
    this.last = Math.max(this.last, now);
    this.tokens = Math.min(this.burst, this.tokens + dt * this.ratePerSec);
  }
  take(now: number, n = 1): boolean {
    this.refill(now);
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }
  available(now: number): number {
    this.refill(now);
    return this.tokens;
  }
}

/**
 * Per-client packet spam limiter: counts drops and reports PACKET_SPAM when
 * more than `maxDropsPerWindow` messages are dropped in `windowMs`.
 */
export class PacketRateLimiter {
  private bucket: TokenBucket;
  private drops: number[] = [];
  private readonly windowMs: number;
  private readonly maxDropsPerWindow: number;
  constructor(ratePerSec: number, burst: number, now: number, windowMs = 5000, maxDropsPerWindow = 40) {
    this.bucket = new TokenBucket(ratePerSec, burst, now);
    this.windowMs = windowMs;
    this.maxDropsPerWindow = maxDropsPerWindow;
  }
  /** Returns `allowed` and whether this drop crossed the spam threshold. */
  check(now: number): { allowed: boolean; spam: boolean } {
    if (this.bucket.take(now)) return { allowed: true, spam: false };
    this.drops.push(now);
    const cutoff = now - this.windowMs;
    while (this.drops.length > 0 && (this.drops[0] ?? 0) < cutoff) this.drops.shift();
    const spam = this.drops.length >= this.maxDropsPerWindow;
    if (spam) this.drops = [];
    return { allowed: false, spam };
  }
}

// ---------------------------------------------------------------------------
// Sequence / replay
// ---------------------------------------------------------------------------

export type SeqVerdict = "ok" | "replay" | "jump";

/**
 * Input sequence numbers must be strictly increasing. A repeated or older seq
 * is a replay; an absurd forward jump is suspicious (but accepted so a
 * reconnecting honest client is not locked out — it is flagged instead).
 */
export class SeqValidator {
  last = -1;
  private readonly maxJump: number;
  constructor(maxJump = 10_000) {
    this.maxJump = maxJump;
  }
  check(seq: number): SeqVerdict {
    if (!Number.isSafeInteger(seq) || seq < 0) return "replay";
    if (seq <= this.last) return "replay";
    const jump = this.last >= 0 && seq - this.last > this.maxJump;
    this.last = seq;
    return jump ? "jump" : "ok";
  }
}

// ---------------------------------------------------------------------------
// Movement: speed hack / teleport
// ---------------------------------------------------------------------------

/**
 * Speed hack guard for input-driven simulation. Each accepted input advances
 * the ship by one fixed step, so a client that sends inputs faster than the
 * tick rate would move faster. The budget allows `tickRate` steps per second
 * of server time (+ a jitter burst); excess inputs are dropped.
 */
export class MovementBudget {
  private bucket: TokenBucket;
  private excess: number[] = [];
  private readonly windowMs: number;
  private readonly flagAt: number;
  constructor(tickRate: number, now: number, burstSteps = 10, windowMs = 5000, flagAt = 20) {
    this.bucket = new TokenBucket(tickRate, burstSteps, now);
    this.windowMs = windowMs;
    this.flagAt = flagAt;
  }
  /** Consume one step. `flag` is true when excess inputs cross the threshold (SPEED_HACK). */
  consume(now: number): { allowed: boolean; flag: boolean } {
    if (this.bucket.take(now)) return { allowed: true, flag: false };
    this.excess.push(now);
    const cutoff = now - this.windowMs;
    while (this.excess.length > 0 && (this.excess[0] ?? 0) < cutoff) this.excess.shift();
    const flag = this.excess.length >= this.flagAt;
    if (flag) this.excess = [];
    return { allowed: false, flag };
  }
}

export interface DisplacementCheck {
  ok: boolean;
  distance: number;
  allowed: number;
  cheat?: CheatType;
}

/**
 * Validate a position change against the legal maximum. Used for every
 * authoritative position write that did not come from `stepShip` (e.g.
 * teleports, dashes) and for client-reported positions in diagnostics.
 * Distances beyond `teleportFactor ×` the allowance are classified as TELEPORT.
 */
export function checkDisplacement(
  from: { x: number; y: number },
  to: { x: number; y: number },
  maxSpeed: number,
  dtSec: number,
  tolerance = 1.15,
  extraAllowance = 0,
  teleportFactor = 4,
): DisplacementCheck {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const allowed = maxSpeed * Math.max(0, dtSec) * tolerance + extraAllowance + 0.01;
  if (distance <= allowed) return { ok: true, distance, allowed };
  return { ok: false, distance, allowed, cheat: distance > allowed * teleportFactor ? "TELEPORT" : "SPEED_HACK" };
}

// ---------------------------------------------------------------------------
// Attack speed / damage sanity
// ---------------------------------------------------------------------------

/**
 * Counts shots per weapon in a sliding window and reports when a weapon fired
 * more often than its fire rate allows (only possible through a server bug or
 * a bypassed gate — defensive telemetry).
 */
export class FireRateAuditor {
  private shots = new Map<string, number[]>();
  check(weaponKey: string, fireRate: number, now: number, windowMs = 3000): boolean {
    const arr = this.shots.get(weaponKey) ?? [];
    arr.push(now);
    const cutoff = now - windowMs;
    while (arr.length > 0 && (arr[0] ?? 0) < cutoff) arr.shift();
    this.shots.set(weaponKey, arr);
    const allowed = Math.ceil((fireRate * windowMs) / 1000) + 1;
    return arr.length > allowed;
  }
}

/** Damage manipulation check: a reported/computed hit must not exceed the theoretical maximum. */
export function isDamageImpossible(dealt: number, theoreticalMax: number, tolerance = 1.01): boolean {
  return !Number.isFinite(dealt) || dealt < 0 || dealt > theoreticalMax * tolerance + 1;
}

// ---------------------------------------------------------------------------
// Bot heuristics
// ---------------------------------------------------------------------------

/**
 * Repeated-movement detector: bots often replay the exact same input pattern.
 * Hashes quantised inputs into fixed-size chunks and flags when the same chunk
 * repeats `repeatThreshold` times within the tracked history.
 */
export class RepeatedMovementDetector {
  private current: string[] = [];
  private counts = new Map<string, number>();
  private order: string[] = [];
  private readonly chunk: number;
  private readonly repeatThreshold: number;
  private readonly history: number;
  constructor(chunk = 40, repeatThreshold = 6, history = 60) {
    this.chunk = chunk;
    this.repeatThreshold = repeatThreshold;
    this.history = history;
  }
  push(input: { thrust: number; strafe: number; heading: number; boost: boolean }): boolean {
    const h = Number.isFinite(input.heading) ? Math.round(input.heading * 10) : 99;
    this.current.push(`${Math.round(input.thrust * 4)}|${Math.round(input.strafe * 4)}|${h}|${input.boost ? 1 : 0}`);
    if (this.current.length < this.chunk) return false;
    const key = this.current.join(",");
    this.current = [];
    // Idle chunks (no movement at all) are not evidence of botting.
    if (/^(0\|0\|99\|0,?)+$/.test(key)) return false;
    const c = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, c);
    this.order.push(key);
    if (this.order.length > this.history) {
      const old = this.order.shift();
      if (old !== undefined) {
        const oc = (this.counts.get(old) ?? 1) - 1;
        if (oc <= 0) this.counts.delete(old);
        else this.counts.set(old, oc);
      }
    }
    if (c >= this.repeatThreshold) {
      this.counts.set(key, 0);
      return true;
    }
    return false;
  }
}

/**
 * Impossible-reaction detector: time between a hostile becoming visible to the
 * client and the client locking/firing on it. Humans rarely react < ~120ms
 * consistently; flags when `count` of the last `sample` reactions are below
 * `minHumanMs`.
 */
export class ReactionTimeDetector {
  private samples: number[] = [];
  private readonly minHumanMs: number;
  private readonly sample: number;
  private readonly count: number;
  constructor(minHumanMs = 110, sample = 20, count = 14) {
    this.minHumanMs = minHumanMs;
    this.sample = sample;
    this.count = count;
  }
  record(reactionMs: number): boolean {
    if (!Number.isFinite(reactionMs) || reactionMs < 0) return false;
    this.samples.push(reactionMs);
    if (this.samples.length > this.sample) this.samples.shift();
    if (this.samples.length < this.sample) return false;
    const fast = this.samples.filter((s) => s < this.minHumanMs).length;
    if (fast >= this.count) {
      this.samples = [];
      return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface RiskEvent {
  type: CheatType;
  score: number;
  details: Record<string, unknown>;
}

/**
 * Accumulates per-type scores and emits at most one event per type per
 * `cooldownMs` so a cheating client cannot flood the database.
 */
export class RiskAccumulator {
  private lastEmit = new Map<string, number>();
  private pending = new Map<string, RiskEvent>();
  private readonly cooldownMs: number;
  constructor(cooldownMs = 30_000) {
    this.cooldownMs = cooldownMs;
  }
  add(ev: RiskEvent, now: number): RiskEvent | null {
    const cur = this.pending.get(ev.type);
    const merged: RiskEvent = cur
      ? { type: ev.type, score: cur.score + ev.score, details: { ...cur.details, ...ev.details, occurrences: (Number(cur.details.occurrences ?? 1) + 1) } }
      : { ...ev, details: { ...ev.details, occurrences: 1 } };
    const last = this.lastEmit.get(ev.type) ?? -Infinity;
    if (now - last >= this.cooldownMs) {
      this.lastEmit.set(ev.type, now);
      this.pending.delete(ev.type);
      return merged;
    }
    this.pending.set(ev.type, merged);
    return null;
  }
  /** Flush all pending (e.g. on leave). */
  drain(): RiskEvent[] {
    const out = [...this.pending.values()];
    this.pending.clear();
    return out;
  }
}
