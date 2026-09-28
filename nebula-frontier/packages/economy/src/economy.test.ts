import { describe, expect, it } from "vitest";
import { TreasuryHealth } from "@nebula/shared";
import {
  AllocationError,
  applyCaps,
  applyOverrides,
  bucketBudgets,
  checkRewardEligibility,
  claimCooldownUntil,
  computeEmissionRate,
  computeTreasuryHealth,
  dailyEmissionCap,
  defaultEconomyConfig,
  marketplaceFee,
  auctionFees,
  rewardAmountForWeight,
  runEconomySimulation,
  scenarioParams,
  seasonRewardBudget,
  validateAllocation,
  validateEconomyConfig,
  withdrawalQuote,
  FeeError,
  isKnownConfigKey,
  averageDailyMax,
  mulRatioCeil,
  mulRatioFloor,
  riskLevelForScore,
  intervalRegularity
} from "./index.js";

const cfg = defaultEconomyConfig();
const SOL = 1_000_000_000n;

describe("caps", () => {
  it("clips to the tightest remaining cap", () => {
    const r = applyCaps(30_000_000n, { daily: 40_000_000n, weekly: 0n, season: 0n }, cfg);
    expect(r.allowed).toBe(10_000_000n);
    expect(r.capped).toBe(true);
    expect(r.reasons).toContain("daily cap reached");
  });
  it("weekly and season caps apply independently", () => {
    expect(applyCaps(50_000_000n, { daily: 0n, weekly: BigInt(cfg.caps.weekly) - 1n, season: 0n }, cfg).allowed).toBe(1n);
    expect(applyCaps(50_000_000n, { daily: 0n, weekly: 0n, season: BigInt(cfg.caps.season) }, cfg).allowed).toBe(0n);
  });
  it("passes amounts under every cap untouched", () => {
    const r = applyCaps(1000n, { daily: 0n, weekly: 0n, season: 0n }, cfg);
    expect(r).toEqual({ allowed: 1000n, capped: false, reasons: [] });
  });
});

describe("eligibility", () => {
  const good = { createdAt: new Date(Date.now() - 5 * 86_400_000), riskLevel: "LOW", playtimeSeconds: 10_000n, matchesPlayed: 30, bannedAt: null, restrictions: [] };
  it("eligible player", () => {
    expect(checkRewardEligibility({ user: good, mode: "RANKED" }, cfg)).toEqual({ eligible: true, reasons: [] });
  });
  it("collects every failing reason", () => {
    const r = checkRewardEligibility(
      { user: { ...good, createdAt: new Date(), riskLevel: "HIGH", playtimeSeconds: 60n, matchesPlayed: 1, restrictions: ["NO_REWARDS"] }, mode: "CASUAL" },
      cfg
    );
    expect(r.eligible).toBe(false);
    expect(r.reasons.length).toBe(6);
  });
  it("claim cooldown", () => {
    const now = new Date();
    expect(claimCooldownUntil(new Date(now.getTime() - 5 * 60_000), cfg, now)).not.toBeNull();
    expect(claimCooldownUntil(new Date(now.getTime() - 2 * 3_600_000), cfg, now)).toBeNull();
  });
});

describe("treasury health", () => {
  const t = (reserve: bigint, outstanding: bigint, projected: bigint) =>
    computeTreasuryHealth({ availableReserve: reserve, outstandingLiability: outstanding, projected30dEmission: projected }, cfg);
  it("maps coverage to health levels using config thresholds", () => {
    expect(t(300n * SOL, 50n * SOL, 50n * SOL).health).toBe(TreasuryHealth.HEALTHY); // 3.0
    expect(t(170n * SOL, 50n * SOL, 50n * SOL).health).toBe(TreasuryHealth.WATCH); // 1.7
    expect(t(120n * SOL, 50n * SOL, 50n * SOL).health).toBe(TreasuryHealth.WARNING); // 1.2
    expect(t(80n * SOL, 50n * SOL, 50n * SOL).health).toBe(TreasuryHealth.CRITICAL); // 0.8
  });
  it("multiplier follows health", () => {
    expect(t(80n * SOL, 50n * SOL, 50n * SOL).multiplier).toBe(cfg.treasuryHealth.multipliers.CRITICAL);
  });
  it("a tiny treasury is never HEALTHY even without liabilities", () => {
    expect(t(1n, 0n, 0n).health).toBe(TreasuryHealth.WARNING);
  });
});

describe("emission", () => {
  it("multiplies factors", () => {
    const r = computeEmissionRate({ baseRate: 0.01, activityMultiplier: 1.2, seasonMultiplier: 1, treasuryHealthMultiplier: 0.8, maxRewardRate: 0.03 });
    expect(r.rate).toBeCloseTo(0.0096, 8);
    expect(r.hardCapped).toBe(false);
  });
  it("is hard-capped at maxRewardRate no matter the inputs", () => {
    const r = computeEmissionRate({ baseRate: 0.05, activityMultiplier: 10, seasonMultiplier: 10, treasuryHealthMultiplier: 1, maxRewardRate: 0.03 });
    expect(r.rate).toBe(0.03);
    expect(r.hardCapped).toBe(true);
  });
  it("invalid inputs never produce emission", () => {
    expect(computeEmissionRate({ baseRate: Number.NaN, activityMultiplier: 1, seasonMultiplier: 1, treasuryHealthMultiplier: 1, maxRewardRate: 0.03 }).rate).toBe(0);
    expect(computeEmissionRate({ baseRate: 0.01, activityMultiplier: -1, seasonMultiplier: 1, treasuryHealthMultiplier: 1, maxRewardRate: 0.03 }).rate).toBe(0);
  });
  it("reward amount scales with weight and rate", () => {
    expect(rewardAmountForWeight(10, cfg.emission.baseRate, cfg)).toBe(BigInt(10 * cfg.emission.rewardUnitLamports));
    expect(rewardAmountForWeight(10, cfg.emission.baseRate / 2, cfg)).toBe(BigInt(5 * cfg.emission.rewardUnitLamports));
    expect(rewardAmountForWeight(0, 0.01, cfg)).toBe(0n);
    expect(dailyEmissionCap(100n * SOL, 0.01)).toBe(SOL);
  });
});

describe("reward budget", () => {
  it("season budget = revenue * ratio + funding, never unlimited", () => {
    expect(seasonRewardBudget(100n * SOL, 0.2)).toBe(20n * SOL);
    expect(seasonRewardBudget(0n, 0.2)).toBe(0n);
    expect(seasonRewardBudget(10n * SOL, 0.2, 5n * SOL)).toBe(7n * SOL);
    expect(() => seasonRewardBudget(1n, 1.5)).toThrow(AllocationError);
  });
  it("allocation above 100% is rejected", () => {
    expect(() => validateAllocation({ A: 0.6, B: 0.5 })).toThrow(/> 100%/);
    expect(() => bucketBudgets(SOL, { ...cfg.rewardAllocation, LEADERBOARD: 0.9 })).toThrow(AllocationError);
    const errors = validateEconomyConfig(applyOverrides([{ key: "rewardAllocation.LEADERBOARD", value: 0.9 }]));
    expect(errors.some((e) => e.includes("> 100%"))).toBe(true);
  });
  it("bucket budgets split the budget", () => {
    const b = bucketBudgets(100n * SOL, cfg.rewardAllocation);
    expect(b.LEADERBOARD).toBe(30n * SOL);
    expect(Object.values(b).reduce((s, v) => s + v, 0n)).toBeLessThanOrEqual(100n * SOL);
  });
});

describe("fees", () => {
  it("withdrawal quote", () => {
    const q = withdrawalQuote(100_000_000n, cfg);
    expect(q.serviceFee).toBe(2_000_000n + BigInt(cfg.fees.withdrawalFlat));
    expect(q.networkFee).toBe(BigInt(cfg.fees.estimatedNetworkFee));
    expect(q.final).toBe(100_000_000n - q.serviceFee - q.networkFee);
  });
  it("rejects amounts that cannot cover fees", () => {
    expect(() => withdrawalQuote(1000n, cfg)).toThrow(FeeError);
    expect(() => withdrawalQuote(0n, cfg)).toThrow(FeeError);
  });
  it("rounds fees up (house never under-collects)", () => {
    expect(marketplaceFee(1n, cfg).fee).toBe(1n);
    const m = marketplaceFee(1000n, cfg);
    expect(m.fee + m.sellerProceeds).toBe(1000n);
    expect(m.fee).toBe(75n);
    const a = auctionFees(1000n, 2000n, cfg);
    expect(a.saleFee).toBe(100n);
    expect(a.sellerProceeds).toBe(1900n);
  });
});

describe("config", () => {
  it("defaults are valid", () => expect(validateEconomyConfig(defaultEconomyConfig())).toEqual([]));
  it("overrides deep-merge by dot path", () => {
    const c = applyOverrides([{ key: "caps.daily", value: 1 }, { key: "caps", value: { weekly: 2 } }]);
    expect(c.caps.daily).toBe(1);
    expect(c.caps.weekly).toBe(2);
    expect(c.caps.season).toBe(cfg.caps.season);
  });
  it("rejects prototype-reaching config keys and never pollutes Object.prototype", () => {
    expect(isKnownConfigKey("caps.daily")).toBe(true);
    for (const k of ["constructor", "constructor.name", "__proto__", "__proto__.toString", "caps.constructor", "caps.prototype", "caps.hasOwnProperty"]) {
      expect(isKnownConfigKey(k), k).toBe(false);
    }
    const c = applyOverrides([
      { key: "__proto__.polluted", value: 1 },
      { key: "caps.constructor.prototype.polluted", value: 1 },
      { key: "caps", value: JSON.parse('{"__proto__":{"polluted":1},"weekly":3}') as unknown }
    ]);
    expect(c.caps.weekly).toBe(3);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(c.caps)).toBe(Object.prototype);
  });
});

describe("controller DAU baseline", () => {
  it("averages the per-day maximum of snapshot DAU; empty history is 0", () => {
    expect(averageDailyMax([])).toBe(0);
    const at = (iso: string) => new Date(iso);
    expect(
      averageDailyMax([
        { takenAt: at("2026-09-20T01:00:00Z"), dau: 80 },
        { takenAt: at("2026-09-20T13:00:00Z"), dau: 100 },
        { takenAt: at("2026-09-21T13:00:00Z"), dau: 120 },
        { takenAt: at("2026-09-22T00:00:00Z"), dau: 110 }
      ])
    ).toBe(110);
  });
});

describe("ratio helpers", () => {
  it("mulRatioCeil returns 0 for non-positive ratios and rejects non-finite ones", () => {
    expect(mulRatioCeil(1000n, 0.0015)).toBe(2n);
    expect(mulRatioCeil(1000n, 0)).toBe(0n);
    expect(mulRatioCeil(1000n, -0.5)).toBe(0n);
    for (const r of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => mulRatioCeil(1000n, r)).toThrow(RangeError);
      expect(() => mulRatioFloor(1000n, r)).toThrow(RangeError);
    }
  });
});

describe("risk", () => {
  it("levels", () => {
    expect(riskLevelForScore(0, cfg.risk)).toBe("LOW");
    expect(riskLevelForScore(cfg.risk.highScore, cfg.risk)).toBe("HIGH");
    expect(riskLevelForScore(100, cfg.risk)).toBe("CRITICAL");
  });
  it("metronome-regular reward timing is detected", () => {
    const t0 = Date.now();
    expect(intervalRegularity(Array.from({ length: 10 }, (_, i) => new Date(t0 + i * 60_000)))).toBe(0);
    expect(intervalRegularity([new Date()])).toBeNull();
  });
});

describe("simulation", () => {
  it("is deterministic", () => {
    const a = runEconomySimulation("BASE_GROWTH", scenarioParams("BASE_GROWTH", 10_000, 60), cfg);
    const b = runEconomySimulation("BASE_GROWTH", scenarioParams("BASE_GROWTH", 10_000, 60), cfg);
    expect(a.summary).toEqual(b.summary);
  });

  it("worst case (70% claims, deposits drop, price drop, RPC cost up, bots up, withdrawals up) keeps the treasury protected", () => {
    const r = runEconomySimulation("WORST_CASE", scenarioParams("WORST_CASE", 1_000_000, 120), cfg);
    const s = r.summary;
    // Breakers engage and emission throttles
    expect(s.breakerDays).toBeGreaterThan(0);
    expect(r.days.some((d) => d.breakers.includes("WITHDRAWAL_REVIEW"))).toBe(true);
    expect(r.days.some((d) => d.breakers.includes("REWARD_PAUSE"))).toBe(true);
    expect(s.throttledDays).toBeGreaterThan(0);
    expect(r.days.every((d) => d.emissionRate <= cfg.emission.maxRewardRate)).toBe(true);
    // Liability never exceeds the funded reward pool; pool/reserves never go negative
    expect(s.liabilityEverExceededPool).toBe(false);
    expect(s.treasuryEverNegative).toBe(false);
    for (const d of r.days) {
      expect(d.outstandingLiabilityTokens).toBeLessThanOrEqual(d.rewardPoolTokens + 1e-9);
      expect(d.rewardPoolTokens).toBeGreaterThanOrEqual(-1e-9);
    }
  });

  it("every scenario respects the hard cap and liability bound", () => {
    for (const s of ["LOW_PLAYER_GROWTH", "HIGH_GROWTH", "HIGH_BOT_ACTIVITY", "HIGH_WITHDRAWAL", "MARKET_CRASH", "CRYPTO_VOLATILITY", "SERVER_COST_SPIKE"] as const) {
      const r = runEconomySimulation(s, scenarioParams(s, 50_000, 90), cfg);
      expect(r.summary.liabilityEverExceededPool).toBe(false);
      expect(r.days.every((d) => d.emissionRate <= cfg.emission.maxRewardRate)).toBe(true);
    }
  });
});
