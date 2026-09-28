import { RiskLevel, CheatType } from "@nebula/shared";
import { inSerializableTx, type Db, type DbOrTx } from "@nebula/database";
import { loadEconomyConfig, type EconomyConfig, type RiskConfig } from "./config.js";
import { toJson, DAY_MS } from "./util.js";

export interface RiskSignalInput {
  userId: string;
  type: CheatType | string;
  /** 0..100 contribution of this signal. */
  score: number;
  details?: Record<string, unknown>;
  source: string;
}

export function riskLevelForScore(score: number, r: Pick<RiskConfig, "mediumScore" | "highScore" | "criticalScore">): RiskLevel {
  if (score >= r.criticalScore) return RiskLevel.CRITICAL;
  if (score >= r.highScore) return RiskLevel.HIGH;
  if (score >= r.mediumScore) return RiskLevel.MEDIUM;
  return RiskLevel.LOW;
}

/**
 * Records an anti-cheat / bot signal and recomputes the user's rolling risk score (sum of signal
 * scores in the configured window, capped at 100). HIGH/CRITICAL puts rewards and withdrawals into
 * MANUAL REVIEW — this function never bans anyone; bans are a human decision in the admin panel.
 */
export async function recordRiskSignal(
  db: DbOrTx,
  input: RiskSignalInput,
  cfg?: EconomyConfig
): Promise<{ signalId: string; riskScore: number; riskLevel: RiskLevel; changed: boolean }> {
  const c = cfg ?? (await loadEconomyConfig(db));
  const score = Math.max(0, Math.min(100, Math.round(input.score)));
  // One SERIALIZABLE transaction (or the caller's): concurrent signals cannot both read the old
  // level and let a stale, lower score overwrite a HIGH escalation.
  return inSerializableTx(db, async (tx) => {
    const sig = await tx.riskSignal.create({
      data: { userId: input.userId, type: String(input.type), score, details: toJson(input.details ?? {}), source: input.source }
    });
    const since = new Date(Date.now() - c.risk.windowDays * DAY_MS);
    const agg = await tx.riskSignal.aggregate({ where: { userId: input.userId, createdAt: { gte: since } }, _sum: { score: true } });
    const riskScore = Math.min(100, agg._sum.score ?? 0);
    const riskLevel = riskLevelForScore(riskScore, c.risk);
    const user = await tx.user.findUnique({ where: { id: input.userId }, select: { riskLevel: true } });
    const changed = user?.riskLevel !== riskLevel;
    await tx.user.update({ where: { id: input.userId }, data: { riskScore, riskLevel } });
    if (changed) {
      await tx.auditLog.create({
        data: {
          actorType: "SYSTEM",
          action: "RISK_LEVEL_CHANGED",
          targetType: "User",
          targetId: input.userId,
          oldValue: { riskLevel: user?.riskLevel ?? null },
          newValue: { riskLevel, riskScore, trigger: String(input.type) },
          reason: `Risk signal ${String(input.type)} from ${input.source} — manual review required for HIGH/CRITICAL`
        }
      });
    }
    return { signalId: sig.id, riskScore, riskLevel, changed };
  });
}

/** Coefficient of variation of intervals — scripted farming tends to be metronome-regular. */
export function intervalRegularity(timestamps: Date[]): number | null {
  if (timestamps.length < 6) return null;
  const t = [...timestamps].map((d) => d.getTime()).sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < t.length; i++) gaps.push((t[i] as number) - (t[i - 1] as number));
  const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
  if (mean <= 0) return 0;
  const variance = gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / gaps.length;
  return Math.sqrt(variance) / mean;
}

export interface BotFarmingReport {
  userId: string;
  rewards24h: number;
  regularityCv: number | null;
  clusterUserIds: string[];
  clusterReasons: string[];
  signals: { type: string; score: number; details: Record<string, unknown> }[];
}

/** Other accounts linked by shared device fingerprint, IP, or wallet relationships. */
export async function findAccountCluster(db: DbOrTx, userId: string): Promise<{ userIds: string[]; reasons: string[] }> {
  const reasons: string[] = [];
  const linked = new Set<string>();
  const devices = await db.device.findMany({ where: { userId }, select: { fingerprint: true, ip: true } });
  const fps = devices.map((d) => d.fingerprint);
  const ips = devices.map((d) => d.ip).filter((x): x is string => !!x);
  const sessionIps = (await db.session.findMany({ where: { userId, ip: { not: null } }, select: { ip: true }, take: 50, orderBy: { createdAt: "desc" } }))
    .map((s) => s.ip)
    .filter((x): x is string => !!x);
  const allIps = [...new Set([...ips, ...sessionIps])];
  if (fps.length) {
    const rows = await db.device.findMany({ where: { fingerprint: { in: fps }, userId: { not: userId } }, select: { userId: true } });
    if (rows.length) reasons.push("shared device fingerprint");
    rows.forEach((r) => linked.add(r.userId));
  }
  if (allIps.length) {
    const [d, s] = await Promise.all([
      db.device.findMany({ where: { ip: { in: allIps }, userId: { not: userId } }, select: { userId: true } }),
      db.session.findMany({ where: { ip: { in: allIps }, userId: { not: userId } }, select: { userId: true }, distinct: ["userId"] })
    ]);
    if (d.length || s.length) reasons.push("shared IP address");
    [...d, ...s].forEach((r) => linked.add(r.userId));
  }
  // Wallet relationships: withdrawals to another account's wallet / deposits from a wallet linked elsewhere.
  const myWallets = (await db.wallet.findMany({ where: { userId }, select: { address: true } })).map((w) => w.address);
  const myWithdrawalAddrs = (await db.withdrawal.findMany({ where: { userId }, select: { address: true }, distinct: ["address"] })).map((w) => w.address);
  const myDepositAddrs = (await db.deposit.findMany({ where: { userId }, select: { walletAddress: true }, distinct: ["walletAddress"] })).map((d) => d.walletAddress);
  const addrs = [...new Set([...myWallets, ...myWithdrawalAddrs, ...myDepositAddrs])];
  if (addrs.length) {
    const [w1, w2, w3] = await Promise.all([
      db.wallet.findMany({ where: { address: { in: addrs }, userId: { not: userId } }, select: { userId: true } }),
      db.withdrawal.findMany({ where: { address: { in: addrs }, userId: { not: userId } }, select: { userId: true }, distinct: ["userId"] }),
      db.deposit.findMany({ where: { walletAddress: { in: addrs }, userId: { not: userId } }, select: { userId: true }, distinct: ["userId"] })
    ]);
    if (w1.length || w2.length || w3.length) reasons.push("wallet relationship");
    [...w1, ...w2, ...w3].forEach((r) => linked.add(r.userId));
  }
  return { userIds: [...linked], reasons };
}

/**
 * Bot-farming heuristics. Records signals (never bans):
 *  - repeated reward extraction: too many rewards in 24h, or metronome-regular intervals
 *  - account clustering: multiple accounts sharing device / IP / wallet relationships
 */
export async function detectBotFarming(db: Db, userId: string, cfg?: EconomyConfig, record = true): Promise<BotFarmingReport> {
  const c = cfg ?? (await loadEconomyConfig(db));
  const since = new Date(Date.now() - DAY_MS);
  const rewards = await db.reward.findMany({ where: { userId, createdAt: { gte: since } }, select: { createdAt: true } });
  const cv = intervalRegularity(rewards.map((r) => r.createdAt));
  const cluster = await findAccountCluster(db, userId);
  const signals: BotFarmingReport["signals"] = [];
  if (rewards.length > c.risk.repeatedRewardsPerDay) {
    signals.push({ type: CheatType.ABNORMAL_FARMING, score: 20, details: { rewards24h: rewards.length, heuristic: "repeated_reward_extraction" } });
  }
  if (cv !== null && cv < c.risk.regularIntervalCvMax) {
    signals.push({ type: CheatType.ABNORMAL_FARMING, score: 25, details: { cv, heuristic: "regular_intervals" } });
  }
  if (cluster.userIds.length + 1 >= c.risk.clusterSizeWarn) {
    signals.push({
      type: "MULTI_ACCOUNT",
      score: Math.min(40, 10 * cluster.userIds.length),
      details: { clusterSize: cluster.userIds.length + 1, reasons: cluster.reasons, linked: cluster.userIds.slice(0, 20) }
    });
  }
  if (record) {
    for (const s of signals) await recordRiskSignal(db, { userId, type: s.type, score: s.score, details: s.details, source: "economy.botFarming" }, c);
  }
  return { userId, rewards24h: rewards.length, regularityCv: cv, clusterUserIds: cluster.userIds, clusterReasons: cluster.reasons, signals };
}
