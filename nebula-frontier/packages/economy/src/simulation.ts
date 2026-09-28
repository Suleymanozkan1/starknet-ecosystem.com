/**
 * Deterministic economy simulation engine (pure — no DB). Uses the SAME treasury-health, emission
 * and anomaly/circuit-breaker functions as production so scenarios exercise the real policy.
 *
 * Units: fiat values in USD (float); reward asset in whole tokens (float), converted to integer
 * micro-units (1e-6) when calling the bigint policy functions.
 */
import type { TreasuryHealth} from "@nebula/shared";
import { mulberry32, CircuitBreakerMode } from "@nebula/shared";
import type { EconomyConfig } from "./config.js";
import { computeTreasuryHealth } from "./treasury.js";
import { computeEmissionRate } from "./emission.js";
import { detectAnomalies, type EconomyMetrics } from "./controller.js";

export const SimulationScenario = {
  LOW_PLAYER_GROWTH: "LOW_PLAYER_GROWTH",
  BASE_GROWTH: "BASE_GROWTH",
  HIGH_GROWTH: "HIGH_GROWTH",
  HIGH_SPENDING: "HIGH_SPENDING",
  LOW_SPENDING: "LOW_SPENDING",
  HIGH_REWARD_CLAIM: "HIGH_REWARD_CLAIM",
  HIGH_BOT_ACTIVITY: "HIGH_BOT_ACTIVITY",
  HIGH_WITHDRAWAL: "HIGH_WITHDRAWAL",
  MARKET_CRASH: "MARKET_CRASH",
  CRYPTO_VOLATILITY: "CRYPTO_VOLATILITY",
  SERVER_COST_SPIKE: "SERVER_COST_SPIKE",
  WORST_CASE: "WORST_CASE"
} as const;
export type SimulationScenario = (typeof SimulationScenario)[keyof typeof SimulationScenario];

export interface SimulationParams {
  startUsers: number;
  days: number;
  seed: number;
  /** Daily new-user growth rate (fraction of current users). */
  dailyGrowth: number;
  dailyChurn: number;
  dauRatio: number;
  /** Share of DAU that pays on a given day. */
  payerConversion: number;
  /** Average spend per paying DAU per day (USD). */
  arppuDaily: number;
  /** Multiplier applied to spend from `shockDay` (deposits drop). */
  spendShock: number;
  /** Marketplace fee revenue per DAU per day (USD equivalent). */
  marketFeePerDau: number;
  /** Average reward weight earned per eligible DAU per day. */
  weightPerDau: number;
  /** Share of DAU eligible for crypto rewards (age/playtime/matches). */
  eligibleShare: number;
  botShare: number;
  /** Fraction of still-undetected bots caught per day by risk heuristics (then ineligible / held for review). */
  botDetection: number;
  /** Share of the bot population that is fresh (new accounts) each day. */
  botArrival: number;
  /** Fraction of outstanding rewards claimed per day. */
  claimRate: number;
  /** Fraction of player-held reward tokens withdrawn per day. */
  withdrawalRate: number;
  tokenPrice: number;
  priceDriftDaily: number;
  priceVolDaily: number;
  /** One-off price multiplier applied at shockDay. */
  priceShock: number;
  /** Infra cost per DAU per day (USD). */
  infraCostPerDau: number;
  /** RPC / chain cost per on-chain tx (USD). */
  rpcCostPerTx: number;
  /** Multiplier on infra + RPC cost from shockDay. */
  costShock: number;
  shockDay: number;
  /** Behavioural parameters that change abruptly at shockDay (bank run, bot wave, claim rush). */
  shock?: Partial<Pick<SimulationParams, "botShare" | "withdrawalRate" | "claimRate" | "botDetection" | "payerConversion">>;
  /** Initial treasury funding in tokens (bootstrap from real treasury). */
  initialTreasuryTokens: number;
}

export interface SimulationDay {
  day: number;
  users: number;
  dau: number;
  tokenPrice: number;
  revenueUsd: number;
  rewardExpenseUsd: number;
  infraCostUsd: number;
  withdrawalsTokens: number;
  withdrawalsUsd: number;
  treasuryTokens: number;
  treasuryUsd: number;
  rewardPoolTokens: number;
  outstandingLiabilityTokens: number;
  playerHeldTokens: number;
  netMarginUsd: number;
  reserveCoverage: number;
  inflation: number;
  emissionRate: number;
  treasuryHealth: TreasuryHealth;
  breakers: CircuitBreakerMode[];
  anomalies: string[];
  grantsTokens: number;
  claimsTokens: number;
}

export interface SimulationResult {
  scenario: string;
  params: SimulationParams;
  days: SimulationDay[];
  summary: {
    revenueUsd: number;
    rewardExpenseUsd: number;
    infraCostUsd: number;
    withdrawalsUsd: number;
    netMarginUsd: number;
    netMarginPct: number;
    endTreasuryUsd: number;
    endTreasuryTokens: number;
    minReserveCoverage: number;
    avgInflation: number;
    endOutstandingLiabilityTokens: number;
    maxOutstandingLiabilityTokens: number;
    breakerDays: number;
    throttledDays: number;
    liabilityEverExceededPool: boolean;
    treasuryEverNegative: boolean;
  };
}

export const BASE_PARAMS: Omit<SimulationParams, "startUsers" | "days"> = {
  seed: 42,
  dailyGrowth: 0.01,
  dailyChurn: 0.004,
  dauRatio: 0.25,
  payerConversion: 0.03,
  arppuDaily: 1.6,
  spendShock: 1,
  marketFeePerDau: 0.004,
  weightPerDau: 1,
  eligibleShare: 0.45,
  botShare: 0.03,
  botDetection: 0.35,
  botArrival: 0.05,
  claimRate: 0.3,
  withdrawalRate: 0.05,
  tokenPrice: 150,
  priceDriftDaily: 0,
  priceVolDaily: 0.03,
  priceShock: 1,
  infraCostPerDau: 0.012,
  rpcCostPerTx: 0.0005,
  costShock: 1,
  shockDay: 30,
  initialTreasuryTokens: 50
};

export function scenarioParams(s: SimulationScenario, startUsers: number, days: number): SimulationParams {
  const p: SimulationParams = { ...BASE_PARAMS, startUsers, days, initialTreasuryTokens: Math.max(10, startUsers / 2000), shockDay: Math.min(30, Math.floor(days / 3)) };
  switch (s) {
    case "LOW_PLAYER_GROWTH": return { ...p, dailyGrowth: 0.002, dailyChurn: 0.006 };
    case "BASE_GROWTH": return p;
    case "HIGH_GROWTH": return { ...p, dailyGrowth: 0.03 };
    case "HIGH_SPENDING": return { ...p, payerConversion: 0.05, arppuDaily: 2.4 };
    case "LOW_SPENDING": return { ...p, payerConversion: 0.012, arppuDaily: 0.9 };
    case "HIGH_REWARD_CLAIM": return { ...p, claimRate: 0.5, shock: { claimRate: 0.7 } };
    case "HIGH_BOT_ACTIVITY": return { ...p, botShare: 0.1, shock: { botShare: 0.25, botDetection: 0.2 } };
    case "HIGH_WITHDRAWAL": return { ...p, withdrawalRate: 0.1, shock: { withdrawalRate: 0.35 } };
    case "MARKET_CRASH": return { ...p, priceShock: 0.3, spendShock: 0.6, priceDriftDaily: -0.004 };
    case "CRYPTO_VOLATILITY": return { ...p, priceVolDaily: 0.12 };
    case "SERVER_COST_SPIKE": return { ...p, costShock: 3.5 };
    case "WORST_CASE":
      // 70% claim rush, deposits drop 60%, token price -60%, RPC/infra cost x3, bot wave, bank run.
      return {
        ...p,
        spendShock: 0.4,
        priceShock: 0.4,
        priceDriftDaily: -0.003,
        costShock: 3,
        rpcCostPerTx: 0.002,
        dailyGrowth: 0.002,
        shock: { claimRate: 0.7, botShare: 0.3, botDetection: 0.15, withdrawalRate: 0.4 }
      };
  }
}

const MICRO = 1_000_000;
const toMicro = (tokens: number): bigint => BigInt(Math.max(0, Math.floor(tokens * MICRO)));

/** Runs one scenario. Deterministic for identical params (seeded PRNG). */
export function runEconomySimulation(scenario: string, params: SimulationParams, cfg: EconomyConfig): SimulationResult {
  const rnd = mulberry32(params.seed);
  const gauss = () => {
    const u = Math.max(rnd(), 1e-12);
    const v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  let users = params.startUsers;
  let price = params.tokenPrice;
  // Treasury: bootstrap split like scripts/economy-bootstrap.ts
  let rewardPool = params.initialTreasuryTokens * cfg.rewardBudgetRatio;
  let reserve = params.initialTreasuryTokens * (1 - cfg.rewardBudgetRatio);
  let operatingCashUsd = 0;
  let outstanding = 0;
  let playerHeld = 0;
  let throttle = 1;
  /** Fraction of bots not yet flagged. */
  let undetected = 1;
  const grantHistory: number[] = [];
  const withdrawHistory: number[] = [];
  const breakersActive = new Set<CircuitBreakerMode>();
  // Share of the non-pool treasury that backs rewards (TREASURY reserve; not operating/emergency).
  const backingShare = cfg.treasuryReserveRatio / Math.max(1e-9, 1 - cfg.rewardBudgetRatio);
  const days: SimulationDay[] = [];
  let everExceeded = false;
  let everNegative = false;

  let prevBots = 0;
  for (let day = 1; day <= params.days; day++) {
    const shocked = day >= params.shockDay;
    const bp = shocked && params.shock ? { ...params, ...params.shock } : params;
    // Users
    users = Math.max(0, users * (1 + params.dailyGrowth - params.dailyChurn));
    const dau = users * params.dauRatio;
    const bots = dau * bp.botShare;
    const humans = dau - bots;
    // Price
    if (day === params.shockDay) price *= params.priceShock;
    price = Math.max(0.01, price * Math.exp(params.priceDriftDaily + params.priceVolDaily * gauss() - (params.priceVolDaily ** 2) / 2));

    // Revenue (USD) → split per config ratios
    const spend = humans * bp.payerConversion * params.arppuDaily * (shocked ? params.spendShock : 1);
    const marketFees = dau * params.marketFeePerDau;
    const revenueUsd = spend + marketFees;
    rewardPool += (revenueUsd * cfg.rewardBudgetRatio) / price;
    reserve += (revenueUsd * (cfg.treasuryReserveRatio + cfg.emergencyReserveRatio)) / price;
    operatingCashUsd += revenueUsd * (1 - cfg.rewardBudgetRatio - cfg.treasuryReserveRatio - cfg.emergencyReserveRatio);

    // Treasury health from the real policy function
    const avg7 = grantHistory.slice(-7).reduce((s, v) => s + v, 0) / Math.max(1, Math.min(7, grantHistory.length));
    const health = computeTreasuryHealth(
      { availableReserve: toMicro(rewardPool + reserve * backingShare), outstandingLiability: toMicro(outstanding), projected30dEmission: toMicro(avg7 * 30) },
      { treasuryHealth: cfg.treasuryHealth, minTreasuryReserve: 0 }
    );
    const emission = computeEmissionRate({
      baseRate: cfg.runtime.rewardRateOverride ?? cfg.emission.baseRate,
      activityMultiplier: 1,
      seasonMultiplier: cfg.emission.seasonMultiplier,
      treasuryHealthMultiplier: health.multiplier,
      throttle,
      maxRewardRate: cfg.emission.maxRewardRate
    });
    const rate = breakersActive.has(CircuitBreakerMode.REWARD_PAUSE) ? 0 : emission.rate;

    // Grants: demand from eligible humans + undetected bots, limited by per-user daily cap,
    // daily emission cap (pool * rate) and uncommitted pool (liability <= pool).
    const unitTokens = cfg.emission.rewardUnitLamports / 1e9;
    const perUserTokens = Math.min(params.weightPerDau * unitTokens * (rate / cfg.emission.baseRate), cfg.caps.daily / 1e9);
    // A bot wave arrives undetected; existing bots get flagged at botDetection per day.
    if (bots > prevBots && bots > 0) undetected = (prevBots * undetected + (bots - prevBots)) / bots;
    prevBots = bots;
    undetected = Math.min(1, undetected * (1 - bp.botDetection) + params.botArrival);
    const botEarners = bots * undetected;
    // Flagged bots that keep farming: their rewards are recorded as PENDING_REVIEW and rejected.
    const flaggedFarming = bots * (1 - undetected) * 0.5;
    const demand = (humans * params.eligibleShare + botEarners) * perUserTokens;
    const dailyCap = Math.max(0, rewardPool) * rate;
    const uncommitted = Math.max(0, rewardPool - outstanding);
    const grants = Math.max(0, Math.min(demand, dailyCap, uncommitted));
    outstanding += grants;
    grantHistory.push(grants);

    // Claims (pool → players) and expiry (1/expiryDays of unclaimed returns to pool)
    const claims = outstanding * bp.claimRate;
    outstanding -= claims;
    rewardPool -= claims;
    playerHeld += claims;
    const expired = outstanding / Math.max(1, cfg.rewardExpiryDays);
    outstanding -= expired;

    // Withdrawals (players → chain), fees back to treasury
    const wRate = bp.withdrawalRate * (breakersActive.has(CircuitBreakerMode.WITHDRAWAL_REVIEW) ? 0.5 : 1);
    const withdrawn = playerHeld * wRate;
    const fee = withdrawn * cfg.fees.withdrawalServicePercent;
    playerHeld -= withdrawn;
    reserve += fee;
    withdrawHistory.push(withdrawn);
    const withdrawalTxs = Math.ceil(withdrawn / Math.max(cfg.withdrawal.min / 1e9, 1e-9) / 5) + Math.ceil(claims > 0 ? humans * 0.02 : 0);

    // Infra + RPC cost (USD) paid from operating cash, then by selling reserve tokens.
    const infraCostUsd = (dau * params.infraCostPerDau + withdrawalTxs * params.rpcCostPerTx) * (shocked ? params.costShock : 1);
    operatingCashUsd -= infraCostUsd;
    if (operatingCashUsd < 0) {
      const needTokens = -operatingCashUsd / price;
      const sell = Math.min(needTokens, reserve);
      reserve -= sell;
      operatingCashUsd += sell * price;
    }
    if (outstanding > rewardPool + 1e-9) everExceeded = true;
    if (rewardPool < -1e-9 || reserve < -1e-9) everNegative = true;

    const treasuryTokens = rewardPool + reserve;
    // Same rule as production: below a meaningful base (season cap) the ratio is noise.
    const heldStart = playerHeld - claims + withdrawn;
    const inflation = heldStart >= cfg.caps.season / 1e9 ? (claims - withdrawn) / heldStart : 0;

    // Controller: same anomaly detection as production
    const metrics: EconomyMetrics = {
      at: new Date(0),
      treasury: {
        asset: "NEBX",
        rewardPool: toMicro(rewardPool),
        rewardReserve: 0n,
        treasury: toMicro(reserve * backingShare),
        operatingReserve: 0n,
        emergencyReserve: 0n,
        withdrawalReserve: 0n,
        availableReserve: toMicro(rewardPool + reserve * backingShare),
        outstandingLiability: toMicro(outstanding),
        projected30dEmission: toMicro(avg7 * 30),
        avgDailyEmission7d: toMicro(avg7),
        ...health
      },
      rewardRate: rate,
      inflation: { credits: { daily: 0, weekly: 0, d30: 0 }, nebx: { daily: inflation, weekly: 0, d30: 0 } },
      withdrawals24h: toMicro(withdrawn) * 1000n,
      withdrawalsAvg7d: (toMicro(withdrawHistory.slice(-8, -1).reduce((s, v) => s + v, 0) / 7) * 1000n),
      deposits24h: 0n,
      depositsAvg7d: 0n,
      rewardOutflow24h: toMicro(claims) * 1000n,
      rewardOutflowAvg7d: toMicro(avg7) * 1000n,
      marketVolume24h: 0n,
      marketVolumeAvg7d: 0n,
      marketTopSellerShare: 0,
      rewardUsers24h: rate > 0 ? Math.round(humans * params.eligibleShare + botEarners + flaggedFarming) : 0,
      riskyRewardUsers24h: rate > 0 ? Math.round(flaggedFarming) : 0,
      duplicateClaimSignals1h: 0,
      dau: Math.round(dau),
      dauAvg7d: Math.round(dau)
    };
    const anomalies = detectAnomalies(metrics, cfg);
    breakersActive.clear();
    for (const a of anomalies) for (const b of a.breakers) breakersActive.add(b);
    throttle = anomalies.some((a) => a.throttle) ? cfg.inflation.responses.rewardMultiplier : 1;

    const rewardExpenseUsd = grants * price;
    days.push({
      day,
      users: Math.round(users),
      dau: Math.round(dau),
      tokenPrice: price,
      revenueUsd,
      rewardExpenseUsd,
      infraCostUsd,
      withdrawalsTokens: withdrawn,
      withdrawalsUsd: withdrawn * price,
      treasuryTokens,
      treasuryUsd: treasuryTokens * price + operatingCashUsd,
      rewardPoolTokens: rewardPool,
      outstandingLiabilityTokens: outstanding,
      playerHeldTokens: playerHeld,
      netMarginUsd: revenueUsd - rewardExpenseUsd - infraCostUsd,
      reserveCoverage: Number.isFinite(health.coverage) ? health.coverage : 99,
      inflation,
      emissionRate: rate,
      treasuryHealth: health.health,
      breakers: [...breakersActive],
      anomalies: anomalies.map((a) => a.kind),
      grantsTokens: grants,
      claimsTokens: claims
    });
  }
  const sum = (k: keyof SimulationDay) => days.reduce((s, d) => s + (d[k] as number), 0);
  const revenueUsd = sum("revenueUsd");
  const netMarginUsd = sum("netMarginUsd");
  const last = days[days.length - 1];
  return {
    scenario,
    params,
    days,
    summary: {
      revenueUsd,
      rewardExpenseUsd: sum("rewardExpenseUsd"),
      infraCostUsd: sum("infraCostUsd"),
      withdrawalsUsd: sum("withdrawalsUsd"),
      netMarginUsd,
      netMarginPct: revenueUsd > 0 ? netMarginUsd / revenueUsd : 0,
      endTreasuryUsd: last?.treasuryUsd ?? 0,
      endTreasuryTokens: last?.treasuryTokens ?? 0,
      minReserveCoverage: Math.min(...days.map((d) => d.reserveCoverage)),
      avgInflation: sum("inflation") / Math.max(1, days.length),
      endOutstandingLiabilityTokens: last?.outstandingLiabilityTokens ?? 0,
      maxOutstandingLiabilityTokens: Math.max(0, ...days.map((d) => d.outstandingLiabilityTokens)),
      breakerDays: days.filter((d) => d.breakers.length > 0).length,
      throttledDays: days.filter((d) => d.emissionRate < cfg.emission.baseRate).length,
      liabilityEverExceededPool: everExceeded,
      treasuryEverNegative: everNegative
    }
  };
}
