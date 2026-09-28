/**
 * Admin economy console: dashboard, config, reward rate, circuit breakers, withdrawal review,
 * reward review, risk queue and treasury reconciliation. Roles: SUPER_ADMIN / ECONOMY_MANAGER / ADMIN.
 * Every mutation is audited (config/breaker helpers write their own AuditLog rows with ip/requestId).
 */
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { circuitBreakerSchema, economyConfigUpdateSchema, idSchema, rewardRateSchema, safeTextSchema } from "@nebula/validation";
import { AdminRole, Currency, LedgerAccountType, RewardStatus, type AdminEconomyResponse } from "@nebula/shared";
import { createRpcFromEnv, explorerUrl, getSolanaNetwork, getTreasuryAddress, type SolanaRpcClient } from "@nebula/blockchain";
import {
  EconomyConfigError,
  EconomyController,
  economySeries,
  emissionFromConfig,
  getActiveBreakers,
  getRewardBudgetState,
  getTreasuryState,
  ledgerFlows,
  loadEconomyConfig,
  reviewReward,
  reviewWithdrawal,
  RewardClaimError,
  setCircuitBreaker,
  storedSupply,
  updateEconomyConfig,
  WithdrawalError
} from "@nebula/economy";
import { verifyLedgerIntegrity } from "@nebula/database";
import { badRequest } from "../errors.js";
import { withdrawalDto } from "./wallet.js";
import { rewardDto } from "./economy.js";

export interface AdminEconomyRoutesOptions {
  rpc?: SolanaRpcClient;
  notifyBlockchainService?: (withdrawalId: string) => Promise<void>;
}

const DAY = 86_400_000;
const reviewSchema = z.object({ reason: safeTextSchema(500, 3) });
const idParams = z.object({ id: idSchema });
const listQuery = z.object({
  status: z.enum(["PENDING", "PENDING_REVIEW", "PROCESSING", "COMPLETED", "FAILED", "CANCELLED"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50)
});

const jsonBig = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x)));

const plugin: FastifyPluginAsync<AdminEconomyRoutesOptions> = async (app, opts) => {
  const db = app.db;
  let rpc = opts.rpc;
  const getRpc = () => (rpc ??= createRpcFromEnv());
  const guard = [app.authenticate, app.requireRole(AdminRole.SUPER_ADMIN, AdminRole.ECONOMY_MANAGER, AdminRole.ADMIN)];
  const cfgGuard = [app.authenticate, app.requireRole(AdminRole.SUPER_ADMIN, AdminRole.ECONOMY_MANAGER)];
  const notifyService =
    opts.notifyBlockchainService ??
    (async (id: string) => {
      const base = process.env.BLOCKCHAIN_SERVICE_URL ?? "http://127.0.0.1:8090";
      await fetch(`${base}/internal/withdrawals/${encodeURIComponent(id)}/enqueue`, {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.INTERNAL_SERVICE_TOKEN ?? ""}` },
        signal: AbortSignal.timeout(3000)
      });
    });

  const cfgError = (err: unknown): never => {
    if (err instanceof EconomyConfigError) throw badRequest("INVALID_ECONOMY_CONFIG", err.message, err.errors);
    throw err;
  };

  app.get("/api/admin/economy", { preHandler: guard, config: { rateLimit: app.rateLimits.admin } }, async (): Promise<AdminEconomyResponse> => {
    const now = new Date();
    const cfg = await loadEconomyConfig(db);
    const [treasury, breakers, series, d1, d7, d30, stored, nebxAccounts] = await Promise.all([
      getTreasuryState(db, cfg, now),
      getActiveBreakers(db),
      economySeries(db, 30, now),
      ledgerFlows(db, Currency.CREDITS, new Date(now.getTime() - DAY), now),
      ledgerFlows(db, Currency.CREDITS, new Date(now.getTime() - 7 * DAY), now),
      ledgerFlows(db, Currency.CREDITS, new Date(now.getTime() - 30 * DAY), now),
      storedSupply(db, Currency.CREDITS),
      db.balanceAccount.findMany({ where: { userId: null }, orderBy: [{ asset: "asc" }, { type: "asc" }] })
    ]);
    const since30 = new Date(now.getTime() - 30 * DAY);
    const [sol30, nebx30, rewardGroups] = await Promise.all([
      ledgerFlows(db, Currency.SOL, since30, now),
      ledgerFlows(db, Currency.NEBX, since30, now),
      db.reward.groupBy({ by: ["status"], where: { createdAt: { gte: since30 }, status: { not: RewardStatus.REJECTED } }, _sum: { amount: true }, _count: { _all: true } })
    ]);
    let granted = 0n, claimed = 0n, count = 0, claimedCount = 0;
    for (const g of rewardGroups) {
      const amt = g._sum.amount ?? 0n;
      granted += amt; count += g._count._all;
      if (g.status === RewardStatus.CLAIMED) { claimed += amt; claimedCount += g._count._all; }
    }
    const infl = (f: typeof d1) => {
      const start = stored - (f.issued + f.deposited - f.burned - f.spent - f.withdrawn);
      return start > 0n ? Number(((f.issued - f.burned - f.spent) * 1_000_000n) / start) / 1_000_000 : 0;
    };
    const bySource: Record<string, string> = {};
    for (const f of [sol30, nebx30]) for (const [k, v] of Object.entries(f.revenueBySource)) bySource[k] = ((BigInt(bySource[k] ?? "0")) + v).toString();
    const gross = sol30.revenue + nebx30.revenue;
    const rewardCost = nebx30.issued;
    return {
      treasury: nebxAccounts.map((a) => ({ account: a.type, asset: a.asset as Currency, balance: a.balance.toString() })),
      treasuryHealth: treasury.health,
      reserveCoverage: Number.isFinite(treasury.coverage) ? treasury.coverage : 999,
      outstandingLiability: treasury.outstandingLiability.toString(),
      projected30dRewardCost: treasury.projected30dEmission.toString(),
      availableReserve: treasury.availableReserve.toString(),
      inflation: { daily: infl(d1), weekly: infl(d7), d30: infl(d30) },
      supply: { issued: d30.issued.toString(), burned: d30.burned.toString(), spent: d30.spent.toString(), stored: stored.toString(), withdrawn: nebx30.withdrawn.toString() },
      revenue: { gross: gross.toString(), net: (gross - rewardCost).toString(), bySource },
      rewardRate: breakers.includes("REWARD_PAUSE") ? 0 : emissionFromConfig(cfg, treasury.health).rate,
      rewardClaims: { granted: granted.toString(), claimed: claimed.toString(), count, claimedCount, rate: granted > 0n ? Number((claimed * 1_000_000n) / granted) / 1_000_000 : null },
      activeBreakers: breakers,
      config: jsonBig(cfg) as Record<string, unknown>,
      series
    };
  });

  app.post("/api/admin/economy/config", { preHandler: cfgGuard, config: { rateLimit: app.rateLimits.admin } }, async (req) => {
    const body = app.parse(economyConfigUpdateSchema, req.body);
    const r = await updateEconomyConfig(db, body.key, body.value, req.user.id, body.reason, { ip: req.ip, requestId: req.id }).catch(cfgError);
    return { key: body.key, oldValue: jsonBig(r.oldValue), newValue: jsonBig(r.newValue) };
  });

  app.post("/api/admin/economy/reward-rate", { preHandler: cfgGuard, config: { rateLimit: app.rateLimits.admin } }, async (req) => {
    const body = app.parse(rewardRateSchema, req.body);
    const cfg = await loadEconomyConfig(db);
    if (body.rate > cfg.emission.maxRewardRate) throw badRequest("ABOVE_HARD_CAP", `Rate cannot exceed the hard cap maxRewardRate=${cfg.emission.maxRewardRate}`);
    const r = await updateEconomyConfig(db, "runtime.rewardRateOverride", body.rate, req.user.id, body.reason, { ip: req.ip, requestId: req.id }).catch(cfgError);
    return { rate: body.rate, previous: r.oldValue ?? null };
  });

  app.post("/api/admin/economy/circuit-breaker", { preHandler: cfgGuard, config: { rateLimit: app.rateLimits.admin } }, async (req) => {
    const body = app.parse(circuitBreakerSchema, req.body);
    const r = await setCircuitBreaker(db, { mode: body.mode, active: body.active, reason: body.reason, actorId: req.user.id, actorType: "ADMIN", ip: req.ip, requestId: req.id });
    return { mode: body.mode, active: body.active, changed: r.changed, activeBreakers: await getActiveBreakers(db) };
  });

  app.post("/api/admin/economy/controller/run", { preHandler: cfgGuard, config: { rateLimit: app.rateLimits.admin } }, async (req) => {
    const r = await new EconomyController(db).run();
    await app.audit(req, { action: "ECONOMY_CONTROLLER_MANUAL_RUN", newValue: { anomalies: r.anomalies.map((a) => a.kind), breakersOn: r.breakersOn, breakersOff: r.breakersOff } });
    return jsonBig({ anomalies: r.anomalies, breakersOn: r.breakersOn, breakersOff: r.breakersOff, throttleMultiplier: r.throttleMultiplier, activityMultiplier: r.activityMultiplier, health: r.metrics.treasury.health });
  });

  // ---------------------------------------------------------------- withdrawals review
  app.get("/api/admin/withdrawals", { preHandler: guard, config: { rateLimit: app.rateLimits.admin } }, async (req) => {
    const q = app.parse(listQuery, req.query);
    const rows = await db.withdrawal.findMany({
      where: q.status ? { status: q.status } : {},
      orderBy: { createdAt: "desc" },
      take: q.limit,
      include: { user: { select: { username: true, riskLevel: true, riskScore: true, createdAt: true } } }
    });
    return {
      withdrawals: rows.map((w) => ({
        ...withdrawalDto(w),
        userId: w.userId,
        username: w.user.username,
        userRiskLevel: w.user.riskLevel,
        userRiskScore: w.user.riskScore,
        riskFlags: w.riskFlags,
        chainState: w.chainState,
        attempts: w.attempts,
        reviewedBy: w.reviewedBy
      }))
    };
  });

  const decide = (approve: boolean) => async (req: FastifyRequest) => {
    const { id } = app.parse(idParams, req.params);
    const body = app.parse(reviewSchema, req.body);
    try {
      const r = await reviewWithdrawal(db, id, approve, req.user.id, body.reason);
      if (approve) await notifyService(id).catch((err: Error) => req.log.warn({ err: err.message }, "blockchain-service notify failed"));
      return r;
    } catch (err) {
      if (err instanceof WithdrawalError) throw badRequest(err.code, err.message);
      throw err;
    }
  };
  app.post("/api/admin/withdrawals/:id/approve", { preHandler: cfgGuard, config: { rateLimit: app.rateLimits.admin } }, decide(true));
  app.post("/api/admin/withdrawals/:id/reject", { preHandler: cfgGuard, config: { rateLimit: app.rateLimits.admin } }, decide(false));

  // ---------------------------------------------------------------- reward review & risk queue
  app.get("/api/admin/economy/rewards/review", { preHandler: guard, config: { rateLimit: app.rateLimits.admin } }, async () => {
    const rows = await db.reward.findMany({ where: { status: "PENDING_REVIEW" }, orderBy: { createdAt: "asc" }, take: 200, include: { user: { select: { username: true, riskLevel: true, riskScore: true } } } });
    return { rewards: rows.map((r) => ({ ...rewardDto(r), userId: r.userId, username: r.user.username, riskLevel: r.user.riskLevel, riskScore: r.user.riskScore })) };
  });
  app.post("/api/admin/economy/rewards/:id/review", { preHandler: cfgGuard, config: { rateLimit: app.rateLimits.admin } }, async (req) => {
    const { id } = app.parse(idParams, req.params);
    const body = app.parse(reviewSchema.extend({ approve: z.boolean() }), req.body);
    try {
      return await reviewReward(db, id, body.approve, req.user.id, body.reason);
    } catch (err) {
      if (err instanceof RewardClaimError) throw badRequest(err.code, err.message);
      throw err;
    }
  });
  app.get("/api/admin/economy/risk", { preHandler: guard, config: { rateLimit: app.rateLimits.admin } }, async () => {
    const users = await db.user.findMany({
      where: { riskLevel: { in: ["HIGH", "CRITICAL", "MEDIUM"] } },
      orderBy: { riskScore: "desc" },
      take: 100,
      select: { id: true, username: true, riskLevel: true, riskScore: true, createdAt: true, riskSignals: { orderBy: { createdAt: "desc" }, take: 10, select: { type: true, score: true, source: true, details: true, createdAt: true } } }
    });
    return { users, note: "Risk levels trigger manual review only; bans are a human decision." };
  });

  // ---------------------------------------------------------------- treasury reconciliation
  app.get("/api/admin/treasury", { preHandler: guard, config: { rateLimit: app.rateLimits.admin } }, async () => {
    const cfg = await loadEconomyConfig(db);
    const [treasury, budget, integrity] = await Promise.all([getTreasuryState(db, cfg), getRewardBudgetState(db, cfg), verifyLedgerIntegrity(db)]);
    let onChain: { address: string; lamports: string | null; explorerUrl: string | null; error?: string } = { address: "", lamports: null, explorerUrl: null };
    try {
      const address = getTreasuryAddress();
      const bal = await getRpc().getBalance(address, { commitment: "confirmed" }).send();
      onChain = { address, lamports: bal.value.toString(), explorerUrl: explorerUrl(address, getSolanaNetwork(), "address") };
    } catch (err) {
      onChain.error = (err as Error).message;
    }
    const accounts = await db.balanceAccount.findMany({ where: { userId: null, asset: { in: [Currency.NEBX, Currency.SOL] } } });
    const ext = (asset: string) => accounts.find((a) => a.type === LedgerAccountType.EXTERNAL_CHAIN && a.asset === asset)?.balance ?? 0n;
    const ledgerOnChain = -ext(Currency.NEBX) - ext(Currency.SOL);
    return jsonBig({
      onChain,
      ledgerExpectedOnChain: ledgerOnChain,
      reconciliationDelta: onChain.lamports !== null ? BigInt(onChain.lamports) - ledgerOnChain : null,
      treasury: { ...treasury, coverage: Number.isFinite(treasury.coverage) ? treasury.coverage : null },
      budget,
      systemAccounts: accounts.map((a) => ({ type: a.type, asset: a.asset, balance: a.balance })),
      ledgerIntegrity: integrity,
      recentWithdrawals: (await db.withdrawal.findMany({ orderBy: { createdAt: "desc" }, take: 20 })).map(withdrawalDto)
    });
  });
};

export default plugin;
