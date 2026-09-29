import { describe, expect, it } from "vitest";
import { stepShip, type MotionState, type MoveInput } from "@nebula/game-core";
import { Reconciler, ShipPredictor } from "./prediction.js";

const stats = { speed: 30, acceleration: 40, turnRate: 3, maxEnergy: 100 };
const bounds = { width: 1000, height: 1000 };
const dt = 1 / 20;
const start: MotionState = { x: 500, y: 500, vx: 0, vy: 0, heading: 0, energy: 100 };

function inputAt(i: number): MoveInput {
  return { thrust: i % 40 < 30 ? 1 : 0, strafe: i % 17 < 5 ? 0.5 : 0, heading: (i % 50) * 0.05, boost: i % 60 > 45, moveTo: null };
}

/** Authoritative server: applies queued inputs in order, acks lastSeq. */
class FakeServer {
  state: MotionState = { ...start };
  lastSeq = 0;
  knock = 0;
  apply(seq: number, input: MoveInput): void {
    const r = stepShip(this.state, input, stats, dt, bounds);
    this.state = { x: r.x + this.knock, y: r.y, vx: r.vx, vy: r.vy, heading: r.heading, energy: r.energy };
    this.lastSeq = seq;
  }
}

describe("Reconciler", () => {
  it("drops acknowledged inputs and replays the rest", () => {
    const r = new Reconciler<number, number>(0, { step: (s, i) => s + i });
    r.predict(1, 1);
    r.predict(2, 2);
    r.predict(3, 3);
    expect(r.state).toBe(6);
    // server acked seq 2 with state 3 (it saw 1+2)
    expect(r.reconcile(3, 2)).toBe(6);
    expect(r.pending.map((p) => p.seq)).toEqual([3]);
    // server says the truth after seq 2 was 10 (e.g. knockback) → 10 + 3
    expect(r.reconcile(10, 2)).toBe(13);
  });

  it("caps pending inputs", () => {
    const r = new Reconciler<number, number>(0, { step: (s, i) => s + i, maxPending: 4 });
    for (let i = 1; i <= 10; i++) r.predict(i, 1);
    expect(r.pending).toHaveLength(4);
    expect(r.pending[0]?.seq).toBe(7);
  });
});

describe("ShipPredictor replay", () => {
  it("matches the server exactly under latency when simulations are deterministic", () => {
    const p = new ShipPredictor({ ...start }, { stats, bounds, dt });
    const server = new FakeServer();
    const latencyTicks = 4;
    const inFlight: { seq: number; input: MoveInput; arrive: number }[] = [];
    const acks: { state: MotionState; seq: number; arrive: number }[] = [];
    for (let tick = 1; tick <= 200; tick++) {
      const input = inputAt(tick);
      p.step(tick, input);
      inFlight.push({ seq: tick, input, arrive: tick + latencyTicks });
      while (inFlight[0] && inFlight[0].arrive <= tick) {
        const m = inFlight.shift();
        if (m) server.apply(m.seq, m.input);
        acks.push({ state: { ...server.state }, seq: server.lastSeq, arrive: tick + latencyTicks });
      }
      while (acks[0] && acks[0].arrive <= tick) {
        const a = acks.shift();
        if (a) p.reconcile(a.state, a.seq);
        // deterministic → replay reproduces the prediction: no correction
        expect(p.lastCorrection).toBeLessThan(1e-9);
      }
    }
    expect(p.reconciler.pending.length).toBeLessThanOrEqual(latencyTicks * 2 + 1);
    // after all inputs land, prediction == authoritative state
    while (inFlight.length) {
      const m = inFlight.shift();
      if (m) server.apply(m.seq, m.input);
    }
    p.reconcile({ ...server.state }, server.lastSeq);
    expect(p.state.x).toBeCloseTo(server.state.x, 9);
    expect(p.state.y).toBeCloseTo(server.state.y, 9);
    expect(p.reconciler.pending).toHaveLength(0);
  });

  it("corrects divergence with a smoothed visual offset that decays", () => {
    const p = new ShipPredictor({ ...start }, { stats, bounds, dt, smoothing: 10 });
    const server = new FakeServer();
    server.knock = 0.2; // server-side force the client doesn't know about
    for (let tick = 1; tick <= 20; tick++) {
      const input = inputAt(tick);
      p.step(tick, input);
      server.apply(tick, input);
    }
    p.reconcile({ ...server.state }, server.lastSeq);
    expect(p.state.x).toBeCloseTo(server.state.x, 9);
    expect(p.lastCorrection).toBeGreaterThan(1);
    const pose = { x: 0, y: 0, heading: 0, vx: 0, vy: 0 };
    p.render(1, 0, pose);
    const err0 = Math.abs(pose.x - p.state.x);
    expect(err0).toBeGreaterThan(1);
    for (let i = 0; i < 60; i++) p.render(1, 1 / 60, pose);
    expect(Math.abs(pose.x - p.state.x)).toBeLessThan(err0 * 0.01);
  });

  it("snaps on large corrections (teleport/respawn)", () => {
    const p = new ShipPredictor({ ...start }, { stats, bounds, dt, snapDistance: 5 });
    p.step(1, inputAt(1));
    p.reconcile({ ...start, x: 100, y: 100 }, 1);
    const pose = { x: 0, y: 0, heading: 0, vx: 0, vy: 0 };
    p.render(1, 0, pose);
    expect(pose.x).toBeCloseTo(100);
    expect(p.errX).toBe(0);
  });
});
