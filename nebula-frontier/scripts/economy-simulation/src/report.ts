import type { EconomyConfig, SimulationResult, SimulationScenario } from "@nebula/economy";
import { formatUnits } from "@nebula/shared";

/** Exact lamports (bigint config amount) → whole-token decimal string, e.g. 50000000n → "0.05". */
export const lamports = (v: bigint): string => formatUnits(v, 9, 9);

export const USER_COUNTS = [1_000, 10_000, 50_000, 100_000, 500_000, 1_000_000];
export const HORIZONS = [30, 90, 180, 365];
export const SCENARIOS: SimulationScenario[] = [
  "LOW_PLAYER_GROWTH",
  "BASE_GROWTH",
  "HIGH_GROWTH",
  "HIGH_SPENDING",
  "LOW_SPENDING",
  "HIGH_REWARD_CLAIM",
  "HIGH_BOT_ACTIVITY",
  "HIGH_WITHDRAWAL",
  "MARKET_CRASH",
  "CRYPTO_VOLATILITY",
  "SERVER_COST_SPIKE"
];

export function usd(v: number): string {
  const a = Math.abs(v);
  const s = a >= 1e9 ? `${(a / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(2)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(1)}k` : a.toFixed(0);
  return `${v < 0 ? "-" : ""}$${s}`;
}
export const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
export const tok = (v: number, sym: string): string => `${v >= 1000 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toFixed(4)} ${sym}`;
export const users = (n: number): string => (n >= 1e6 ? `${n / 1e6}M` : `${n / 1e3}k`);

export function scenarioTable(results: SimulationResult[], sym: string): string {
  const head = "| Users | Days | Revenue | Reward Expense | Infrastructure Cost | Withdrawals | Treasury (end) | Net Margin | Reserve Coverage (min) | Inflation (avg/day) | Outstanding Liability (end) | Breaker days |";
  const sep = "|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|";
  const rows = results.map((r) => {
    const s = r.summary;
    return `| ${users(r.params.startUsers)} | ${r.params.days} | ${usd(s.revenueUsd)} | ${usd(s.rewardExpenseUsd)} | ${usd(s.infraCostUsd)} | ${usd(s.withdrawalsUsd)} | ${usd(s.endTreasuryUsd)} | ${usd(s.netMarginUsd)} (${pct(s.netMarginPct)}) | ${s.minReserveCoverage >= 99 ? "∞" : s.minReserveCoverage.toFixed(2)} | ${pct(s.avgInflation)} | ${tok(s.endOutstandingLiabilityTokens, sym)} | ${s.breakerDays} |`;
  });
  return [head, sep, ...rows].join("\n");
}

export function paramsTable(cfg: EconomyConfig): string {
  return [
    "| Parameter | Value |",
    "|---|---|",
    `| Reward budget ratio | ${pct(cfg.rewardBudgetRatio)} of revenue |`,
    `| Reserve split (treasury / operating / emergency) | ${pct(cfg.treasuryReserveRatio)} / ${pct(cfg.operatingReserveRatio)} / ${pct(cfg.emergencyReserveRatio)} |`,
    `| Emission base / hard cap | ${pct(cfg.emission.baseRate)} / ${pct(cfg.emission.maxRewardRate)} of season budget per day |`,
    `| Treasury health thresholds | HEALTHY ≥ ${cfg.treasuryHealth.healthy}, WATCH ≥ ${cfg.treasuryHealth.watch}, WARNING ≥ ${cfg.treasuryHealth.warning}, else CRITICAL |`,
    `| Health multipliers | ${Object.entries(cfg.treasuryHealth.multipliers).map(([k, v]) => `${k} ${v}`).join(", ")} |`,
    `| Player caps (day / week / season) | ${lamports(cfg.caps.daily)} / ${lamports(cfg.caps.weekly)} / ${lamports(cfg.caps.season)} ${cfg.tokenomics.symbol} |`,
    `| Withdrawal fee | ${pct(cfg.fees.withdrawalServicePercent)} + ${lamports(cfg.fees.withdrawalFlat)} ${cfg.tokenomics.symbol} + network |`,
    `| Circuit breakers | coverage < ${cfg.circuitBreaker.reserveCoverageMin}, liability > ${pct(cfg.circuitBreaker.liabilityRatioMax)} of pool, withdrawals > ${cfg.circuitBreaker.withdrawalSpikeMultiplier}× avg, bots > ${pct(cfg.circuitBreaker.botRiskShareMax)} |`
  ].join("\n");
}
