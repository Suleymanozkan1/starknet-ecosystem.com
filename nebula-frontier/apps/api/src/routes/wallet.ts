/**
 * Wallet routes (economy engineer): link wallet, wallet overview, SOL deposits (prepare/verify),
 * withdrawal quote and withdrawal request. Treasury keys never touch this process — payouts are
 * executed by apps/blockchain-service, which this module only notifies.
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  depositPrepareSchema,
  depositVerifySchema,
  idSchema,
  linkWalletSchema,
  withdrawQuoteSchema,
  withdrawRequestSchema
} from "@nebula/validation";
import { Currency, type ChainTxState, type DepositDto, type DepositPrepareResponse, type WalletResponse, type WithdrawalDto, type WithdrawalLimitsDto, type WithdrawQuoteDto } from "@nebula/shared";
import {
  createRpcFromEnv,
  explorerUrl,
  getRewardMint,
  getSolanaNetwork,
  getTreasuryAddress,
  verifyDepositTransaction,
  DepositRejection,
  type SolanaRpcClient
} from "@nebula/blockchain";
import {
  checkWithdrawal,
  createWithdrawal,
  creditDeposit,
  DepositError,
  FeeError,
  loadEconomyConfig,
  prepareDeposit,
  quoteToDto,
  recordRiskSignal,
  rejectDeposit,
  walletChangeLockUntil,
  withdrawalDailyUsed,
  withdrawalQuote,
  WithdrawalError,
  type EconomyConfig
} from "@nebula/economy";
import type { Db } from "@nebula/database";
import { ApiHttpError, badRequest, conflict, notFound, unavailable } from "../errors.js";
import { balancesDto } from "../lib/balances.js";
import { notify } from "../lib/notify.js";

export interface WalletRoutesOptions {
  /** Injected in tests (mock RPC); defaults to SOLANA_RPC_URL. */
  rpc?: SolanaRpcClient;
  /** Injected in tests; defaults to POSTing BLOCKCHAIN_SERVICE_URL/internal/withdrawals/:id/enqueue. */
  notifyBlockchainService?: (withdrawalId: string) => Promise<void>;
}

const SUSPICIOUS: string[] = [DepositRejection.WRONG_RECIPIENT, DepositRejection.WRONG_SENDER, DepositRejection.AMOUNT_MISMATCH, DepositRejection.MEMO_MISMATCH, DepositRejection.WRONG_MINT, DepositRejection.TX_FAILED];

export function depositDto(d: { id: string; amount: bigint; status: string; signature: string | null; createdAt: Date; creditedAt: Date | null }): DepositDto {
  return { id: d.id, amount: d.amount.toString(), status: d.status as DepositDto["status"], signature: d.signature, createdAt: d.createdAt.toISOString(), creditedAt: d.creditedAt?.toISOString() ?? null };
}

export function withdrawalDto(w: {
  id: string; requested: bigint; serviceFee: bigint; networkFee: bigint; final: bigint; address: string; status: string;
  signature: string | null; failureReason: string | null; createdAt: Date; completedAt: Date | null;
}): WithdrawalDto {
  const network = getSolanaNetwork();
  return {
    id: w.id,
    requested: w.requested.toString(),
    serviceFee: w.serviceFee.toString(),
    networkFee: w.networkFee.toString(),
    final: w.final.toString(),
    address: w.address,
    status: w.status as WithdrawalDto["status"],
    signature: w.signature,
    explorerUrl: w.signature ? explorerUrl(w.signature, network) : null,
    failureReason: w.failureReason,
    createdAt: w.createdAt.toISOString(),
    completedAt: w.completedAt?.toISOString() ?? null
  };
}

export async function withdrawalLimits(db: Db, userId: string, cfg: EconomyConfig): Promise<WithdrawalLimitsDto> {
  const now = new Date();
  const [dailyUsed, last, lock] = await Promise.all([
    withdrawalDailyUsed(db, userId, now),
    db.withdrawal.findFirst({ where: { userId, status: { not: "CANCELLED" } }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    walletChangeLockUntil(db, userId, cfg, now)
  ]);
  const cooldownEnd = last ? new Date(last.createdAt.getTime() + cfg.withdrawal.cooldownMinutes * 60_000) : null;
  const candidates = [cooldownEnd, lock].filter((d): d is Date => !!d && d > now);
  const nextAllowedAt = candidates.length ? new Date(Math.max(...candidates.map((d) => d.getTime()))) : null;
  return {
    min: String(cfg.withdrawal.min),
    max: String(cfg.withdrawal.max),
    dailyLimit: String(cfg.withdrawal.dailyLimit),
    dailyUsed: dailyUsed.toString(),
    cooldownMinutes: cfg.withdrawal.cooldownMinutes,
    nextAllowedAt: nextAllowedAt?.toISOString() ?? null,
    serviceFeePercent: cfg.fees.withdrawalServicePercent,
    flatFee: String(cfg.fees.withdrawalFlat),
    estimatedNetworkFee: String(cfg.fees.estimatedNetworkFee)
  };
}

function treasuryOr503(): string {
  try {
    return getTreasuryAddress();
  } catch {
    throw unavailable("TREASURY_NOT_CONFIGURED", "Deposits are unavailable: treasury is not configured");
  }
}

async function defaultNotify(withdrawalId: string): Promise<void> {
  const base = process.env.BLOCKCHAIN_SERVICE_URL ?? `http://127.0.0.1:${process.env.BLOCKCHAIN_SERVICE_PORT ?? 8090}`;
  const token = process.env.INTERNAL_SERVICE_TOKEN ?? "";
  const res = await fetch(`${base}/internal/withdrawals/${encodeURIComponent(withdrawalId)}/enqueue`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(3000)
  });
  if (!res.ok) throw new Error(`blockchain-service responded ${res.status}`);
}

const historyQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) });

const plugin: FastifyPluginAsync<WalletRoutesOptions> = async (app, opts) => {
  const db = app.db;
  let rpc: SolanaRpcClient | undefined = opts.rpc;
  const getRpc = () => (rpc ??= createRpcFromEnv());
  const notifyService = opts.notifyBlockchainService ?? defaultNotify;

  async function walletResponse(userId: string, limit = 20): Promise<WalletResponse> {
    const cfg = await loadEconomyConfig(db);
    const [wallets, balances, deposits, withdrawals, limits] = await Promise.all([
      db.wallet.findMany({ where: { userId, unlinkedAt: null }, orderBy: [{ primary: "desc" }, { verifiedAt: "asc" }] }),
      balancesDto(db, userId),
      db.deposit.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: limit }),
      db.withdrawal.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: limit }),
      withdrawalLimits(db, userId, cfg)
    ]);
    const { mint, decimals } = getRewardMint();
    let treasuryAddress = "";
    try {
      treasuryAddress = getTreasuryAddress();
    } catch {
      treasuryAddress = "";
    }
    return {
      wallets: wallets.map((w) => ({ address: w.address, primary: w.primary, verifiedAt: w.verifiedAt.toISOString() })),
      balances,
      network: getSolanaNetwork(),
      treasuryAddress,
      rewardAsset: { symbol: cfg.tokenomics.symbol, mint, decimals },
      limits,
      deposits: deposits.map(depositDto),
      withdrawals: withdrawals.map(withdrawalDto)
    };
  }

  // ---------------------------------------------------------------- link an additional wallet
  // Single implementation: delegates to POST /api/auth/link-wallet (nonce purpose LINK_WALLET,
  // signature check, audit, notification, WALLET_CHANGE risk signal). The 48h withdrawal lock is
  // derived from Wallet.verifiedAt in checkWithdrawal(), so it applies to either entry point.
  app.post("/api/wallet/connect", { preHandler: [app.authenticate, app.requireFeature("wallet")], config: { rateLimit: app.rateLimits.wallet } }, async (req, reply) => {
    const headers: Record<string, string> = {};
    for (const h of ["cookie", "authorization", "x-nf-csrf", "origin", "user-agent", "x-correlation-id"]) {
      const v = req.headers[h];
      if (typeof v === "string") headers[h] = v;
    }
    const res = await app.inject({ method: "POST", url: "/api/auth/link-wallet", headers, payload: (req.body ?? {}) as object, remoteAddress: req.ip });
    if (res.statusCode >= 400) return reply.code(res.statusCode).send(res.json());
    return walletResponse(req.user.id);
  });

  // ---------------------------------------------------------------- overview
  app.get("/api/wallet", { preHandler: [app.authenticate, app.requireFeature("wallet")] }, async (req) => {
    const q = app.parse(historyQuery, req.query);
    return walletResponse(req.user.id, q.limit);
  });

  // ---------------------------------------------------------------- deposits
  app.post("/api/wallet/deposit/prepare", { preHandler: [app.authenticate, app.requireFeature("deposit"), app.rateLimitStrict], config: { rateLimit: app.rateLimits.wallet } }, async (req): Promise<DepositPrepareResponse> => {
    const body = app.parse(depositPrepareSchema, req.body);
    const recipient = treasuryOr503();
    try {
      const d = await prepareDeposit(db, {
        userId: req.user.id,
        amount: body.amount,
        purpose: body.purpose,
        idempotencyKey: body.idempotencyKey,
        recipient,
        // Deposits are always native devnet SOL (gem purchases / SOL balance).
        mint: null,
        productId: body.productId ?? null
      });
      return { depositId: d.id, recipient: d.recipient, amount: d.amount.toString(), mint: d.mint, memo: d.memo, expiresAt: d.expiresAt.toISOString(), network: getSolanaNetwork() };
    } catch (err) {
      if (err instanceof DepositError) throw badRequest(err.code, err.message);
      throw err;
    }
  });

  app.post("/api/wallet/deposit/verify", { preHandler: [app.authenticate, app.requireFeature("deposit"), app.rateLimitStrict], config: { rateLimit: app.rateLimits.wallet } }, async (req, reply) => {
    const body = app.parse(depositVerifySchema, req.body);
    const d = await db.deposit.findUnique({ where: { id: body.depositId } });
    if (!d || d.userId !== req.user.id) throw notFound("Deposit");
    if (d.status === "CREDITED") {
      if (d.signature === body.signature) return { deposit: depositDto(d), balances: await balancesDto(db, req.user.id), alreadyCredited: true };
      throw conflict("ALREADY_CREDITED", "Deposit already credited with another transaction");
    }
    if (d.status === "REJECTED") throw conflict("DEPOSIT_REJECTED", d.failureReason ?? "Deposit was rejected");
    const used = await db.deposit.findUnique({ where: { signature: body.signature }, select: { id: true } });
    if (used && used.id !== d.id) {
      await recordRiskSignal(db, { userId: req.user.id, type: "FAKE_TRANSACTION", score: 15, details: { reason: "signature reuse", signature: body.signature }, source: "deposit" }).catch(() => undefined);
      throw conflict("DUPLICATE_SIGNATURE", "This transaction was already used for another deposit");
    }
    // The sender must be the wallet recorded at prepare time (a verified wallet of this user).
    const wallet = await db.wallet.findUnique({ where: { address: d.walletAddress } });
    if (!wallet || wallet.userId !== req.user.id || wallet.unlinkedAt) throw badRequest("WALLET_NOT_LINKED", "Deposit wallet is no longer linked");
    const result = await verifyDepositTransaction(getRpc(), {
      signature: body.signature,
      expectedRecipient: d.recipient,
      expectedAmount: d.amount,
      mint: d.mint,
      memo: d.memo,
      expectedSender: d.walletAddress,
      minConfirmations: "confirmed"
    });
    if (!result.ok) {
      if (result.retryable) {
        await db.deposit.updateMany({ where: { id: d.id, status: "PREPARED" }, data: { status: "SUBMITTED" } });
        return reply.code(202).send({ error: { code: result.reason, message: result.message, retryable: true, requestId: req.id } });
      }
      await rejectDeposit(db, d.id, req.user.id, `${result.reason}: ${result.message}`, SUSPICIOUS.includes(result.reason));
      throw badRequest(result.reason, result.message);
    }
    try {
      const credited = await creditDeposit(db, d.id, req.user.id, { signature: result.signature, amount: result.amount, sender: result.sender, slot: result.slot });
      await app.audit(req, { action: "DEPOSIT_CREDITED", targetType: "Deposit", targetId: d.id, newValue: { signature: result.signature, amount: d.amount.toString(), purpose: d.purpose, gems: credited.gems } });
      if (!credited.alreadyCredited) {
        await notify(db, req.user.id, "DEPOSIT_CREDITED", "Deposit received",
          d.purpose === "GEMS" ? `${credited.gems} Gems were added to your account.` : "Your devnet SOL deposit was credited.", { depositId: d.id, signature: result.signature });
      }
      return { deposit: depositDto(credited.deposit), balances: await balancesDto(db, req.user.id), gems: credited.gems, explorerUrl: explorerUrl(result.signature, getSolanaNetwork()) };
    } catch (err) {
      if (err instanceof DepositError) throw err.code === "DUPLICATE_SIGNATURE" ? conflict(err.code, err.message) : badRequest(err.code, err.message);
      throw err;
    }
  });

  // ---------------------------------------------------------------- withdrawals
  app.get("/api/wallet/withdraw/quote", { preHandler: [app.authenticate, app.requireFeature("withdraw")] }, async (req): Promise<WithdrawQuoteDto & { limits: WithdrawalLimitsDto }> => {
    const q = app.parse(withdrawQuoteSchema, req.query);
    const cfg = await loadEconomyConfig(db);
    try {
      return { ...quoteToDto(withdrawalQuote(q.amount, cfg)), limits: await withdrawalLimits(db, req.user.id, cfg) };
    } catch (err) {
      if (err instanceof FeeError) throw badRequest(err.code, err.message);
      throw err;
    }
  });

  app.post(
    "/api/wallet/withdraw",
    { preHandler: [app.authenticate, app.requireFeature("withdraw"), app.rateLimitWithdrawal], config: { rateLimit: app.rateLimits.withdrawal } },
    async (req, reply): Promise<WithdrawalDto> => {
      const body = app.parse(withdrawRequestSchema, req.body);
      const { mint } = getRewardMint();
      try {
        const r = await createWithdrawal(db, { userId: req.user.id, amount: body.amount, address: body.address, idempotencyKey: body.idempotencyKey, mint });
        const w = await db.withdrawal.findUniqueOrThrow({ where: { id: r.withdrawalId } });
        if (!r.duplicate) {
          await app.audit(req, { action: "WITHDRAWAL_REQUESTED", targetType: "Withdrawal", targetId: w.id, newValue: { amount: body.amount.toString(), address: body.address, status: w.status, riskFlags: w.riskFlags } });
          if (w.status === "PENDING") {
            // Non-fatal: the service's sweeper re-enqueues from Postgres within a minute.
            await notifyService(w.id).catch((err: Error) => req.log.warn({ err: err.message, withdrawalId: w.id }, "blockchain-service notify failed"));
          } else {
            await notify(db, req.user.id, "WITHDRAWAL_REVIEW", "Withdrawal under review", "Your withdrawal is being reviewed by our security team. Funds are held safely.", { withdrawalId: w.id });
          }
        }
        reply.code(r.duplicate ? 200 : 201);
        return withdrawalDto(w);
      } catch (err) {
        if (err instanceof WithdrawalError) throw new ApiHttpError(err.code === "INSUFFICIENT_BALANCE" ? 400 : err.code === "COOLDOWN" || err.code === "DAILY_LIMIT" ? 429 : 400, err.code, err.message, err.errors);
        throw err;
      }
    }
  );

  app.get("/api/wallet/withdrawals/:id", { preHandler: [app.authenticate, app.requireFeature("withdraw")] }, async (req): Promise<WithdrawalDto & { chainState: string }> => {
    const { id } = app.parse(z.object({ id: idSchema }), req.params);
    const w = await db.withdrawal.findUnique({ where: { id } });
    if (!w || w.userId !== req.user.id) throw notFound("Withdrawal");
    return { ...withdrawalDto(w), chainState: w.chainState as ChainTxState };
  });

  app.get("/api/wallet/withdraw/check", { preHandler: [app.authenticate, app.requireFeature("withdraw")] }, async (req) => {
    const q = app.parse(z.object({ amount: withdrawQuoteSchema.shape.amount, address: linkWalletSchema.shape.address }), req.query);
    const r = await checkWithdrawal(db, { userId: req.user.id, amount: q.amount, address: q.address });
    return { ok: r.ok, errors: r.errors, reviewRequired: r.reviewFlags.length > 0, quote: r.quote ? quoteToDto(r.quote) : null, asset: Currency.NEBX };
  });
};

export default plugin;
