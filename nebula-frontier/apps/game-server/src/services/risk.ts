/**
 * Anti-cheat signal sink: aggregates per player with `RiskAccumulator`
 * (at most one DB write per cheat type per 30s) and forwards to
 * `recordRiskSignal` from @nebula/economy (updates User.riskScore/riskLevel).
 */
import { recordRiskSignal } from "@nebula/economy";
import type { Db } from "@nebula/database";
import { RiskAccumulator, type RiskEvent } from "@nebula/game-core";
import { riskSignalsTotal, type Logger } from "@nebula/telemetry";
import type { CheatType } from "@nebula/shared";

export class RiskReporter {
  private readonly acc = new Map<string, RiskAccumulator>();
  private readonly db: Db | null;
  private readonly log: Logger;
  /** Last emitted events (tests / diagnostics). */
  readonly recent: { userId: string; type: string; score: number }[] = [];

  constructor(db: Db | null, log: Logger) {
    this.db = db;
    this.log = log;
  }

  report(userId: string, type: CheatType, score: number, details: Record<string, unknown>, source: string, now = Date.now()): void {
    let a = this.acc.get(userId);
    if (!a) {
      a = new RiskAccumulator();
      this.acc.set(userId, a);
    }
    const ev = a.add({ type, score, details }, now);
    if (ev) this.emit(userId, ev, source);
  }

  /** Flush pending aggregated signals for a user (on leave). */
  drain(userId: string, source: string): void {
    const a = this.acc.get(userId);
    if (!a) return;
    for (const ev of a.drain()) this.emit(userId, ev, source);
    this.acc.delete(userId);
  }

  private emit(userId: string, ev: RiskEvent, source: string): void {
    riskSignalsTotal.inc({ type: ev.type });
    this.recent.push({ userId, type: ev.type, score: ev.score });
    if (this.recent.length > 200) this.recent.shift();
    this.log.warn({ userId, type: ev.type, score: ev.score, details: ev.details, source }, "risk signal");
    if (!this.db) return;
    recordRiskSignal(this.db, { userId, type: ev.type, score: Math.min(100, ev.score), details: ev.details, source }).catch((e: unknown) => {
      this.log.error({ err: e, userId, type: ev.type }, "failed to record risk signal");
    });
  }
}
