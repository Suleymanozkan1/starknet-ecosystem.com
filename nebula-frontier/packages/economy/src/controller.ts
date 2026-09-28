import { CircuitBreakerMode, Currency, LedgerAccountType, TreasuryHealth, RiskLevel, CheatType } from "@nebula/shared";
import { Prisma, type Db, type DbOrTx } from "@nebula/database";
import { loadEconomyConfig, updateEconomyConfig, type EconomyConfig } from "./config.js";
import { getActiveBreakers, setCircuitBreaker } from "./breakers.js";
import { getTreasuryState, type TreasuryState } from "./treasury.js";
import { emissionFromConfig } from "./emission.js";
import { DAY_MS, toJson } from "./util.js";

const REVENUE_TYPES = [
  LedgerAccountType.PREMIUM_REVENUE,
  LedgerAccountType.MARKETPLACE_REVENUE,
  LedgerAccountType.AUCTION_REVENUE,
  LedgerAccountType.FEE_REVENUE,
  LedgerAccountType.OPERATING_REVENUE
] as string[];

export interface FlowTotals {
  /** Newly created into player hands (GAME_ISSUANCE → players; for NEBX: reward claims from the pool). */
  issued: bigint;
  /** Destroyed (→ GAME_SINK). */
  burned: bigint;
  /** Spent by players into revenue accounts (premium, marketplace, fees). */
  spent: bigint;
  /** Left the system to chain (→ EXTERNAL_CHAIN). */
  withdrawn: bigint;
  /** Player deposits from chain (EXTERNAL_CHAIN → USER_WALLET). */
  deposited: bigint;
  /** All postings into revenue accounts (any origin). */
  revenue: bigint;
  revenueBySource: Record<string, bigint>;
}

interface FlowRow { from_type: string; to_type: string; total: bigint | number | string }

export async function ledgerFlows(db: DbOrTx, asset: string, since: Date, until: Date): Promise<FlowTotals> {
  const rows = await db.$queryRaw<FlowRow[]>(Prisma.sql`
    SELECT da."type" AS from_type, ca."type" AS to_type, COALESCE(SUM(l."amount"), 0) AS total
    FROM "BalanceLedger" l
    JOIN "BalanceAccount" da ON da."id" = l."debitAccountId"
    JOIN "BalanceAccount" ca ON ca."id" = l."creditAccountId"
    WHERE l."asset" = ${asset} AND l."createdAt" >= ${since} AND l."createdAt" < ${until}
    GROUP BY 1, 2`);
  const t: FlowTotals = { issued: 0n, burned: 0n, spent: 0n, withdrawn: 0n, deposited: 0n, revenue: 0n, revenueBySource: {} };
  for (const r of rows) {
    const v = BigInt(r.total);
    const toUser = r.to_type === LedgerAccountType.USER_WALLET || r.to_type === LedgerAccountType.USER_PENDING_REWARD;
    const fromUser = r.from_type === LedgerAccountType.USER_WALLET || r.from_type === LedgerAccountType.USER_PENDING_REWARD;
    if (toUser && (r.from_type === LedgerAccountType.GAME_ISSUANCE || r.from_type === LedgerAccountType.PLAYER_REWARD_POOL)) t.issued += v;
    if (r.to_type === LedgerAccountType.GAME_SINK) t.burned += v;
    if (fromUser && REVENUE_TYPES.includes(r.to_type)) t.spent += v;
    if (r.to_type === LedgerAccountType.EXTERNAL_CHAIN) t.withdrawn += v;
    if (r.from_type === LedgerAccountType.EXTERNAL_CHAIN && toUser) t.deposited += v;
    if (REVENUE_TYPES.includes(r.to_type) && !REVENUE_TYPES.includes(r.from_type)) {
      t.revenue += v;
      t.revenueBySource[r.to_type] = (t.revenueBySource[r.to_type] ?? 0n) + v;
    }
    // Refunds/compensations out of revenue reduce revenue.
    if (REVENUE_TYPES.includes(r.from_type) && !REVENUE_TYPES.includes(r.to_type)) {
      t.revenue -= v;
      t.revenueBySource[r.from_type] = (t.revenueBySource[r.from_type] ?? 0n) - v;
    }
  }
  return t;
}

export async function storedSupply(db: DbOrTx, asset: string): Promise<bigint> {
  const agg = await db.balanceAccount.aggregate({
    where: { asset, type: { in: [LedgerAccountType.USER_WALLET, LedgerAccountType.USER_PENDING_REWARD] } },
    _sum: { balance: true }
  });
  return agg._sum.balance ?? 0n;
}

/** Net inflation of player-held supply over a window: (issued - burned - spent) / stored at window start. */
export function inflationRate(flows: FlowTotals, storedNow: bigint, minBase = 1n): number {
  const net = flows.issued - flows.burned - flows.spent;
  const delta = flows.issued + flows.deposited - flows.burned - flows.spent - flows.withdrawn;
  const start = storedNow - delta;
  // Below a meaningful base (e.g. launch week) a ratio is noise, not inflation.
  if (start < minBase || start <= 0n) return 0;
  return Number((net * 1_000_000n) / start) / 1_000_000;
}

export interface EconomyMetrics {
  at: Date;
  treasury: TreasuryState;
  rewardRate: number;
  inflation: { credits: { daily: number; weekly: number; d30: number }; nebx: { daily: number; weekly: number; d30: number } };
  withdrawals24h: bigint;
  withdrawalsAvg7d: bigint;
  deposits24h: bigint;
  depositsAvg7d: bigint;
  rewardOutflow24h: bigint;
  rewardOutflowAvg7d: bigint;
  marketVolume24h: bigint;
  marketVolumeAvg7d: bigint;
  marketTopSellerShare: number;
  rewardUsers24h: number;
  riskyRewardUsers24h: number;
  duplicateClaimSignals1h: number;
  dau: number;
  dauAvg7d: number;
}

export type AnomalyKind =
  | "RESERVE_TOO_LOW"
  | "LIABILITY_TOO_HIGH"
  | "WITHDRAWAL_SPIKE"
  | "DEPOSIT_SPIKE"
  | "BOT_SPIKE"
  | "INFLATION_SPIKE"
  | "MARKET_MANIPULATION"
  | "DUPLICATE_CLAIMS"
  | "ABNORMAL_OUTFLOW";

export interface Anomaly {
  kind: AnomalyKind;
  severity: "WARN" | "CRITICAL";
  message: string;
  breakers: CircuitBreakerMode[];
  throttle: boolean;
}

function spike(current: bigint, avg: bigint, multiplier: number, floor: bigint): boolean {
  const base = avg > floor ? avg : floor;
  return current > (base * BigInt(Math.round(multiplier * 1000))) / 1000n;
}

/** Pure anomaly detection → breakers to engage + whether to throttle emission. */
export function detectAnomalies(m: EconomyMetrics, cfg: EconomyConfig): Anomaly[] {
  const cb = cfg.circuitBreaker;
  const out: Anomaly[] = [];
  const t = m.treasury;
  if (t.projected30dLiability > 0n && t.coverage < cb.reserveCoverageMin) {
    out.push({ kind: "RESERVE_TOO_LOW", severity: "CRITICAL", message: `Reserve coverage ${t.coverage.toFixed(2)} < ${cb.reserveCoverageMin}`, breakers: [CircuitBreakerMode.REWARD_PAUSE, CircuitBreakerMode.EVENT_PAUSE], throttle: true });
  } else if (t.health === TreasuryHealth.WARNING || t.health === TreasuryHealth.CRITICAL) {
    out.push({ kind: "RESERVE_TOO_LOW", severity: "WARN", message: `Treasury health ${t.health}`, breakers: [], throttle: true });
  }
  if (t.rewardPool > 0n || t.outstandingLiability > 0n) {
    const liabilityRatio = t.rewardPool === 0n ? Number.POSITIVE_INFINITY : Number((t.outstandingLiability * 10_000n) / t.rewardPool) / 10_000;
    if (liabilityRatio > cb.liabilityRatioMax) {
      out.push({ kind: "LIABILITY_TOO_HIGH", severity: "CRITICAL", message: `Outstanding liability is ${(liabilityRatio * 100).toFixed(1)}% of the reward pool`, breakers: [CircuitBreakerMode.REWARD_PAUSE], throttle: true });
    }
  }
  const wFloor = BigInt(cfg.withdrawal.dailyLimit);
  if (spike(m.withdrawals24h, m.withdrawalsAvg7d, cb.withdrawalSpikeMultiplier, wFloor)) {
    out.push({ kind: "WITHDRAWAL_SPIKE", severity: "CRITICAL", message: `Withdrawals 24h ${m.withdrawals24h} vs 7d avg ${m.withdrawalsAvg7d}`, breakers: [CircuitBreakerMode.WITHDRAWAL_REVIEW], throttle: false });
  }
  if (spike(m.deposits24h, m.depositsAvg7d, cb.depositSpikeMultiplier, wFloor)) {
    out.push({ kind: "DEPOSIT_SPIKE", severity: "WARN", message: `Deposits 24h ${m.deposits24h} vs 7d avg ${m.depositsAvg7d}`, breakers: [CircuitBreakerMode.WITHDRAWAL_REVIEW], throttle: false });
  }
  if (m.rewardUsers24h >= 20 && m.riskyRewardUsers24h / m.rewardUsers24h > cb.botRiskShareMax) {
    out.push({ kind: "BOT_SPIKE", severity: "CRITICAL", message: `${m.riskyRewardUsers24h}/${m.rewardUsers24h} rewarded users are high risk`, breakers: [CircuitBreakerMode.REWARD_PAUSE], throttle: true });
  }
  // Inflation is measured on minted soft currency (credits). NEBX has a fixed supply and is only
  // distributed from the funded reward pool, so its flows are covered by ABNORMAL_OUTFLOW instead.
  if (m.inflation.credits.daily > cb.inflationSpike) {
    out.push({ kind: "INFLATION_SPIKE", severity: "CRITICAL", message: `Daily credit inflation ${(m.inflation.credits.daily * 100).toFixed(2)}%`, breakers: [CircuitBreakerMode.EVENT_PAUSE], throttle: true });
  } else if (m.inflation.credits.daily > cfg.inflation.dailyThreshold || m.inflation.credits.weekly > cfg.inflation.weeklyThreshold) {
    out.push({ kind: "INFLATION_SPIKE", severity: "WARN", message: "Credit inflation above target", breakers: [], throttle: true });
  }
  const mFloor = BigInt(cfg.sinks.npcServiceFee) * 100n;
  if (spike(m.marketVolume24h, m.marketVolumeAvg7d, cb.abnormalOutflowMultiplier, mFloor) && m.marketTopSellerShare > 0.5) {
    out.push({ kind: "MARKET_MANIPULATION", severity: "CRITICAL", message: `Market volume spike with ${(m.marketTopSellerShare * 100).toFixed(0)}% from one seller`, breakers: [CircuitBreakerMode.MARKET_PAUSE], throttle: false });
  }
  if (m.duplicateClaimSignals1h > cfg.risk.duplicateClaimSignalsMax) {
    out.push({ kind: "DUPLICATE_CLAIMS", severity: "CRITICAL", message: `${m.duplicateClaimSignals1h} duplicate reward attempts in 1h`, breakers: [CircuitBreakerMode.REWARD_PAUSE], throttle: false });
  }
  const oFloor = BigInt(cfg.caps.daily) * 20n;
  if (spike(m.rewardOutflow24h + m.withdrawals24h, m.rewardOutflowAvg7d + m.withdrawalsAvg7d, cb.abnormalOutflowMultiplier, oFloor)) {
    out.push({ kind: "ABNORMAL_OUTFLOW", severity: "CRITICAL", message: "Abnormal NEBX outflow", breakers: [CircuitBreakerMode.WITHDRAWAL_REVIEW], throttle: true });
  }
  return out;
}

export interface ControllerRunReport {
  metrics: EconomyMetrics;
  anomalies: Anomaly[];
  breakersOn: CircuitBreakerMode[];
  breakersOff: CircuitBreakerMode[];
  throttleMultiplier: number;
  activityMultiplier: number;
  snapshotIds: string[];
}

/**
 * Economy controller: monitors emission, sinks, treasury and inflation from the ledger, persists
 * EconomySnapshot rows, detects anomalies and toggles circuit breakers (with audit logs). Breakers
 * it engaged itself are released automatically once the condition clears; breakers set by an
 * admin are never auto-released.
 */
export class EconomyController {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  async collectMetrics(now = new Date(), cfg?: EconomyConfig): Promise<EconomyMetrics> {
    const db = this.db;
    const c = cfg ?? (await loadEconomyConfig(db));
    const d1 = new Date(now.getTime() - DAY_MS);
    const d7 = new Date(now.getTime() - 7 * DAY_MS);
    const d8 = new Date(now.getTime() - 8 * DAY_MS);
    const d30 = new Date(now.getTime() - 30 * DAY_MS);
    const treasury = await getTreasuryState(db, c, now);
    const emission = emissionFromConfig(c, treasury.health);
    const [cStored, nStored] = await Promise.all([storedSupply(db, Currency.CREDITS), storedSupply(db, Currency.NEBX)]);
    const win = async (asset: string) => {
      const [a, b, e] = await Promise.all([ledgerFlows(db, asset, d1, now), ledgerFlows(db, asset, d7, now), ledgerFlows(db, asset, d30, now)]);
      return { a, b, e };
    };
    const [cf, nf] = await Promise.all([win(Currency.CREDITS), win(Currency.NEBX)]);
    // Minimum supply before inflation ratios are meaningful (derived from config, not hardcoded).
    const creditBase = BigInt(c.sinks.npcServiceFee) * 10_000n;
    const nebxBase = BigInt(c.caps.season);
    const nebxPrior = await ledgerFlows(db, Currency.NEBX, d8, d1);
    const sumW = async (from: Date, to: Date) =>
      (await db.withdrawal.aggregate({ where: { createdAt: { gte: from, lt: to }, status: { notIn: ["CANCELLED"] } }, _sum: { requested: true } }))._sum.requested ?? 0n;
    const sumD = async (from: Date, to: Date) =>
      (await db.deposit.aggregate({ where: { creditedAt: { gte: from, lt: to } }, _sum: { amount: true } }))._sum.amount ?? 0n;
    const [w24, wPrior, dep24, depPrior] = await Promise.all([sumW(d1, now), sumW(d8, d1), sumD(d1, now), sumD(d8, d1)]);

    // Market: marketplace fee postings (credits) per user for concentration.
    const market = await db.$queryRaw<{ uid: string | null; total: bigint | number | string; recent: boolean }[]>(Prisma.sql`
      SELECT l."userId" AS uid, SUM(l."amount") AS total, (l."createdAt" >= ${d1}) AS recent
      FROM "BalanceLedger" l WHERE l."type" IN ('MARKETPLACE_FEE','AUCTION_FEE') AND l."createdAt" >= ${d8}
      GROUP BY 1, 3`);
    let m24 = 0n;
    let mPrior = 0n;
    let top = 0n;
    for (const r of market) {
      const v = BigInt(r.total);
      if (r.recent) {
        m24 += v;
        if (v > top) top = v;
      } else mPrior += v;
    }
    const rewardUsers = await db.reward.findMany({ where: { createdAt: { gte: d1 } }, select: { userId: true }, distinct: ["userId"] });
    const risky = rewardUsers.length
      ? await db.user.count({ where: { id: { in: rewardUsers.map((r) => r.userId) }, riskLevel: { in: [RiskLevel.HIGH, RiskLevel.CRITICAL] } } })
      : 0;
    const dup = await db.riskSignal.count({ where: { type: CheatType.DUPLICATE_REWARD, createdAt: { gte: new Date(now.getTime() - 3_600_000) } } });
    const dauRows = await db.session.findMany({ where: { lastUsedAt: { gte: d1 } }, select: { userId: true }, distinct: ["userId"] });
    const dau7 = await db.session.findMany({ where: { lastUsedAt: { gte: d7, lt: d1 } }, select: { userId: true }, distinct: ["userId"] });

    return {
      at: now,
      treasury,
      rewardRate: emission.rate,
      inflation: {
        credits: { daily: inflationRate(cf.a, cStored, creditBase), weekly: inflationRate(cf.b, cStored, creditBase), d30: inflationRate(cf.e, cStored, creditBase) },
        nebx: { daily: inflationRate(nf.a, nStored, nebxBase), weekly: inflationRate(nf.b, nStored, nebxBase), d30: inflationRate(nf.e, nStored, nebxBase) }
      },
      withdrawals24h: w24,
      withdrawalsAvg7d: wPrior / 7n,
      deposits24h: dep24,
      depositsAvg7d: depPrior / 7n,
      rewardOutflow24h: nf.a.issued,
      rewardOutflowAvg7d: nebxPrior.issued / 7n,
      marketVolume24h: m24,
      marketVolumeAvg7d: mPrior / 7n,
      marketTopSellerShare: m24 > 0n ? Number((top * 1000n) / m24) / 1000 : 0,
      rewardUsers24h: rewardUsers.length,
      riskyRewardUsers24h: risky,
      duplicateClaimSignals1h: dup,
      dau: dauRows.length,
      dauAvg7d: dau7.length / 6
    };
  }

  async snapshot(metrics: EconomyMetrics, now = new Date()): Promise<string[]> {
    const ids: string[] = [];
    const d1 = new Date(now.getTime() - DAY_MS);
    for (const asset of [Currency.NEBX, Currency.CREDITS, Currency.SOL]) {
      const f = await ledgerFlows(this.db, asset, d1, now);
      const stored = await storedSupply(this.db, asset);
      const isNebx = asset === Currency.NEBX;
      const row = await this.db.economySnapshot.create({
        data: {
          takenAt: now,
          asset,
          issued: f.issued,
          burned: f.burned,
          spent: f.spent,
          stored,
          withdrawn: f.withdrawn,
          deposited: f.deposited,
          outstandingLiability: isNebx ? metrics.treasury.outstandingLiability : 0n,
          availableReserve: isNebx ? metrics.treasury.availableReserve : 0n,
          treasuryHealth: metrics.treasury.health,
          rewardRate: metrics.rewardRate,
          dau: metrics.dau,
          revenue: f.revenue,
          rewardExpense: isNebx ? f.issued : 0n,
          data: toJson({ inflation: metrics.inflation, coverage: Number.isFinite(metrics.treasury.coverage) ? metrics.treasury.coverage : null, revenueBySource: f.revenueBySource })
        },
        select: { id: true }
      });
      ids.push(row.id);
    }
    return ids;
  }

  async run(now = new Date()): Promise<ControllerRunReport> {
    const cfg = await loadEconomyConfig(this.db);
    const metrics = await this.collectMetrics(now, cfg);
    const anomalies = detectAnomalies(metrics, cfg);
    const desired = new Set<CircuitBreakerMode>(anomalies.flatMap((a) => a.breakers));
    const rows = await this.db.circuitBreaker.findMany();
    const active = new Map(rows.map((r) => [r.mode, r]));
    const breakersOn: CircuitBreakerMode[] = [];
    const breakersOff: CircuitBreakerMode[] = [];
    for (const mode of desired) {
      if (!active.get(mode)?.active) {
        const reason = anomalies.filter((a) => a.breakers.includes(mode)).map((a) => `${a.kind}: ${a.message}`).join("; ");
        await setCircuitBreaker(this.db, { mode, active: true, reason: `Auto: ${reason}`.slice(0, 1000), actorId: null, actorType: "SYSTEM" });
        breakersOn.push(mode);
      }
    }
    for (const r of rows) {
      const mode = r.mode as CircuitBreakerMode;
      if (r.active && r.triggeredBy === "SYSTEM" && !desired.has(mode)) {
        await setCircuitBreaker(this.db, { mode, active: false, reason: "Auto: condition cleared", actorId: null, actorType: "SYSTEM" });
        breakersOff.push(mode);
      }
    }
    // Emission throttle (inflation / treasury response)
    const throttle = anomalies.some((a) => a.throttle) ? cfg.inflation.responses.rewardMultiplier : 1;
    if (Math.abs(throttle - cfg.runtime.throttleMultiplier) > 1e-9) {
      await updateEconomyConfig(this.db, "runtime.throttleMultiplier", throttle, null, throttle < 1 ? `Auto throttle: ${anomalies.map((a) => a.kind).join(",")}` : "Auto: throttle released", { actorType: "SYSTEM" });
    }
    // Activity multiplier from DAU trend
    const rawActivity = metrics.dauAvg7d > 0 ? metrics.dau / metrics.dauAvg7d : 1;
    const activity = Math.round(Math.min(Math.max(rawActivity, 0.5), cfg.emission.activityMultiplierMax) * 100) / 100;
    if (Math.abs(activity - cfg.runtime.activityMultiplier) >= 0.05) {
      await updateEconomyConfig(this.db, "runtime.activityMultiplier", activity, null, `Auto: DAU ${metrics.dau} vs 7d avg ${metrics.dauAvg7d.toFixed(1)}`, { actorType: "SYSTEM" });
    }
    const snapshotIds = await this.snapshot(metrics, now);
    return { metrics, anomalies, breakersOn, breakersOff, throttleMultiplier: throttle, activityMultiplier: activity, snapshotIds };
  }
}

export interface DailySeriesPoint {
  date: string;
  revenue: number;
  rewards: number;
  deposits: number;
  withdrawals: number;
  dau: number;
  issued: number;
  burned: number;
  liability: number;
  treasury: number;
}

/** Daily series for the admin dashboard (ledger + snapshots), last `days` days. */
export async function economySeries(db: DbOrTx, days = 30, now = new Date()): Promise<DailySeriesPoint[]> {
  const since = new Date(now.getTime() - days * DAY_MS);
  const rows = await db.$queryRaw<{ day: Date; from_type: string; to_type: string; asset: string; total: bigint | number | string }[]>(Prisma.sql`
    SELECT date_trunc('day', l."createdAt") AS day, da."type" AS from_type, ca."type" AS to_type, l."asset" AS asset, SUM(l."amount") AS total
    FROM "BalanceLedger" l
    JOIN "BalanceAccount" da ON da."id" = l."debitAccountId"
    JOIN "BalanceAccount" ca ON ca."id" = l."creditAccountId"
    WHERE l."createdAt" >= ${since}
    GROUP BY 1, 2, 3, 4`);
  const snaps = await db.economySnapshot.findMany({ where: { asset: Currency.NEBX, takenAt: { gte: since } }, orderBy: { takenAt: "asc" } });
  const map = new Map<string, DailySeriesPoint>();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * DAY_MS).toISOString().slice(0, 10);
    map.set(d, { date: d, revenue: 0, rewards: 0, deposits: 0, withdrawals: 0, dau: 0, issued: 0, burned: 0, liability: 0, treasury: 0 });
  }
  for (const r of rows) {
    const p = map.get(new Date(r.day).toISOString().slice(0, 10));
    if (!p) continue;
    const v = Number(BigInt(r.total));
    const toUser = r.to_type === LedgerAccountType.USER_WALLET;
    if (REVENUE_TYPES.includes(r.to_type) && (r.asset === Currency.NEBX || r.asset === Currency.SOL)) p.revenue += v;
    if (r.from_type === LedgerAccountType.PLAYER_REWARD_POOL && toUser) p.rewards += v;
    if (r.from_type === LedgerAccountType.EXTERNAL_CHAIN && toUser) p.deposits += v;
    if (r.to_type === LedgerAccountType.EXTERNAL_CHAIN) p.withdrawals += v;
    if (r.asset === Currency.CREDITS && r.from_type === LedgerAccountType.GAME_ISSUANCE) p.issued += v;
    if (r.asset === Currency.CREDITS && r.to_type === LedgerAccountType.GAME_SINK) p.burned += v;
  }
  for (const s of snaps) {
    const p = map.get(s.takenAt.toISOString().slice(0, 10));
    if (!p) continue;
    p.liability = Number(s.outstandingLiability);
    p.treasury = Number(s.availableReserve);
    p.dau = Math.max(p.dau, s.dau);
  }
  return [...map.values()];
}

export async function currentBreakers(db: DbOrTx): Promise<CircuitBreakerMode[]> {
  return getActiveBreakers(db);
}
