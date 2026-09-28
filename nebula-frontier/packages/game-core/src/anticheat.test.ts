import { describe, expect, it } from "vitest";
import {
  checkDisplacement, FireRateAuditor, isDamageImpossible, MovementBudget, PacketRateLimiter, ReactionTimeDetector,
  RepeatedMovementDetector, RiskAccumulator, SeqValidator, TokenBucket,
} from "./anticheat.js";
import { activateAbility, createAbilityState, CooldownViolationTracker } from "./abilities.js";
import { stepShip } from "./movement.js";
import type { AbilitySlotDef } from "./stats.js";

describe("speed hack", () => {
  it("MovementBudget drops inputs sent faster than the tick rate and flags", () => {
    const budget = new MovementBudget(20, 0, 10, 5000, 20);
    let accepted = 0;
    let flagged = false;
    // Cheater sends 200 inputs within 1 second (10x tick rate).
    for (let i = 0; i < 200; i++) {
      const r = budget.consume(i * 5);
      if (r.allowed) accepted++;
      if (r.flag) flagged = true;
    }
    expect(accepted).toBeLessThanOrEqual(10 + 20 + 1);
    expect(flagged).toBe(true);
  });

  it("an honest client at tick rate is never throttled", () => {
    const budget = new MovementBudget(20, 0);
    for (let i = 0; i < 400; i++) expect(budget.consume(i * 50).allowed).toBe(true);
  });

  it("budgeted simulation bounds distance to max speed", () => {
    const stats = { speed: 30, acceleration: 60, turnRate: 3, maxEnergy: 100 };
    const budget = new MovementBudget(20, 0, 10);
    let s = { x: 0, y: 200, vx: 0, vy: 0, heading: 0, energy: 100 };
    for (let i = 0; i < 1000; i++) {
      if (budget.consume(Math.floor(i / 50) * 50).allowed) s = stepShip(s, { thrust: 1, strafe: 0, heading: 0, boost: false }, stats, 0.05, { width: 10000, height: 400 });
    }
    // 1000 inputs spread over 1s of server time → at most (20 + burst) steps.
    expect(s.x).toBeLessThanOrEqual(30 * 0.05 * 31);
  });

  it("checkDisplacement classifies speed hack vs teleport", () => {
    expect(checkDisplacement({ x: 0, y: 0 }, { x: 1.4, y: 0 }, 30, 0.05).ok).toBe(true);
    expect(checkDisplacement({ x: 0, y: 0 }, { x: 3, y: 0 }, 30, 0.05).cheat).toBe("SPEED_HACK");
    expect(checkDisplacement({ x: 0, y: 0 }, { x: 300, y: 0 }, 30, 0.05).cheat).toBe("TELEPORT");
  });
});

describe("replay / spam", () => {
  it("SeqValidator rejects replays and non-monotonic sequences", () => {
    const v = new SeqValidator();
    expect(v.check(1)).toBe("ok");
    expect(v.check(2)).toBe("ok");
    expect(v.check(2)).toBe("replay");
    expect(v.check(1)).toBe("replay");
    expect(v.check(-5)).toBe("replay");
    expect(v.check(1.5)).toBe("replay");
    expect(v.check(3)).toBe("ok");
    expect(v.check(50_000)).toBe("jump");
  });

  it("TokenBucket refills over time", () => {
    const b = new TokenBucket(10, 2, 0);
    expect(b.take(0)).toBe(true);
    expect(b.take(0)).toBe(true);
    expect(b.take(0)).toBe(false);
    expect(b.take(100)).toBe(true);
  });

  it("PacketRateLimiter flags spam", () => {
    const l = new PacketRateLimiter(30, 30, 0, 5000, 40);
    let spam = false;
    for (let i = 0; i < 500; i++) if (l.check(i).spam) spam = true;
    expect(spam).toBe(true);
  });
});

describe("cooldown hack", () => {
  const slot: AbilitySlotDef = { id: "module:0", name: "Booster", source: "MODULE", kind: "MODULE", cooldownMs: 30_000, durationMs: 0, energyCost: 40, effect: { type: "SHIELD_RESTORE", percent: 30 } };

  it("rejects activation before cooldown on the server clock", () => {
    let st = createAbilityState();
    const a = activateAbility(st, slot, { now: 1000, energy: 100, cooldownReductionPct: 0, stunned: false, dead: false });
    expect(a.ok).toBe(true);
    if (a.ok) st = a.state;
    const b = activateAbility(st, slot, { now: 2000, energy: 100, cooldownReductionPct: 0, stunned: false, dead: false });
    expect(b).toMatchObject({ ok: false, reason: "COOLDOWN" });
    const c = activateAbility(st, slot, { now: 31_000, energy: 100, cooldownReductionPct: 0, stunned: false, dead: false });
    expect(c.ok).toBe(true);
  });

  it("cooldown reduction is capped", () => {
    const st = createAbilityState();
    const a = activateAbility(st, slot, { now: 0, energy: 100, cooldownReductionPct: 500, stunned: false, dead: false });
    expect(a.ok && a.readyAt).toBe(3000);
  });

  it("CooldownViolationTracker flags repeated early activations", () => {
    const t = new CooldownViolationTracker(10_000, 8);
    let flagged = false;
    for (let i = 0; i < 8; i++) flagged = t.record(i * 100) || flagged;
    expect(flagged).toBe(true);
  });
});

describe("damage / fire-rate / bot heuristics", () => {
  it("isDamageImpossible", () => {
    expect(isDamageImpossible(100, 200)).toBe(false);
    expect(isDamageImpossible(1000, 200)).toBe(true);
    expect(isDamageImpossible(Number.NaN, 200)).toBe(true);
  });

  it("FireRateAuditor detects more shots than fire rate allows", () => {
    const a = new FireRateAuditor();
    let bad = false;
    for (let i = 0; i < 20; i++) bad = a.check("L0", 2, i * 50) || bad;
    expect(bad).toBe(true);
    const ok = new FireRateAuditor();
    let fine = false;
    for (let i = 0; i < 20; i++) fine = ok.check("L0", 2, i * 500) || fine;
    expect(fine).toBe(false);
  });

  it("RepeatedMovementDetector flags looped identical input patterns", () => {
    const d = new RepeatedMovementDetector(10, 3, 30);
    let flagged = false;
    for (let rep = 0; rep < 5; rep++) for (let i = 0; i < 10; i++) flagged = d.push({ thrust: 1, strafe: 0, heading: i * 0.3, boost: false }) || flagged;
    expect(flagged).toBe(true);
  });

  it("ReactionTimeDetector flags inhuman reactions", () => {
    const d = new ReactionTimeDetector(110, 10, 8);
    let f = false;
    for (let i = 0; i < 10; i++) f = d.record(30) || f;
    expect(f).toBe(true);
  });

  it("RiskAccumulator rate-limits emissions per type", () => {
    const r = new RiskAccumulator(30_000);
    expect(r.add({ type: "SPEED_HACK", score: 10, details: {} }, 0)).not.toBeNull();
    expect(r.add({ type: "SPEED_HACK", score: 10, details: {} }, 1000)).toBeNull();
    const e = r.add({ type: "SPEED_HACK", score: 10, details: {} }, 31_000);
    expect(e?.score).toBe(20);
  });
});
