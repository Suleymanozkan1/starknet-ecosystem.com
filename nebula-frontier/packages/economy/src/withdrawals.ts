import { CircuitBreakerMode, Currency, LedgerAccountType, RiskLevel, WithdrawalStatus, ChainTxState } from "@nebula/shared";
import { getBalance, post, system, userWallet, withSerializableTx, type Db, type DbOrTx, type Tx } from "@nebula/database";
import { loadEconomyConfig, type EconomyConfig } from "./config.js";
import { isBreakerActive } from "./breakers.js";
import { riskAtMost } from "./eligibility.js";
import { withdrawalQuote, type WithdrawalQuote } from "./fees.js";
import { DAY_MS } from "./util.js";

export interface WithdrawalCheckError {
  code: string;
  message: string;
}

export interface WithdrawalCheckResult {
  ok: boolean;
  errors: WithdrawalCheckError[];
  /** Non-blocking flags that route the withdrawal to PENDING_REVIEW. */
  reviewFlags: string[];
  quote: WithdrawalQuote | null;
  dailyUsed: bigint;
  nextAllowedAt: Date | null;
  walletLockUntil: Date | null;
}

const ACTIVE_STATUSES = [WithdrawalStatus.PENDING, WithdrawalStatus.PENDING_REVIEW, WithdrawalStatus.PROCESSING, WithdrawalStatus.COMPLETED];

export async function withdrawalDailyUsed(db: DbOrTx, userId: string, now = new Date()): Promise<bigint> {
  const agg = await db.withdrawal.aggregate({
    where: { userId, createdAt: { gte: new Date(now.getTime() - DAY_MS) }, status: { in: ACTIVE_STATUSES } },
    _sum: { requested: true }
  });
  return agg._sum.requested ?? 0n;
}

/** Latest wallet link/unlink time after account creation → withdrawal lock end. */
export async function walletChangeLockUntil(db: DbOrTx, userId: string, cfg: EconomyConfig, now = new Date()): Promise<Date | null> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { createdAt: true } });
  if (!user) return null;
  const wallets = await db.wallet.findMany({ where: { userId }, select: { verifiedAt: true, unlinkedAt: true } });
  const graceMs = 5 * 60_000; // the wallet used to create the account is not a "change"
  let latest = 0;
  for (const w of wallets) {
    if (w.verifiedAt.getTime() > user.createdAt.getTime() + graceMs) latest = Math.max(latest, w.verifiedAt.getTime());
    if (w.unlinkedAt) latest = Math.max(latest, w.unlinkedAt.getTime());
  }
  if (!latest) return null;
  const until = new Date(latest + cfg.withdrawal.walletChangeLockHours * 3_600_000);
  return until > now ? until : null;
}

/**
 * All withdrawal checks: min/max, daily limit, cooldown, available balance, account age, recent
 * wallet change, destination is a verified linked wallet, risk level, velocity, breaker.
 */
export async function checkWithdrawal(
  db: DbOrTx,
  input: { userId: string; amount: bigint; address: string },
  cfg?: EconomyConfig,
  now = new Date()
): Promise<WithdrawalCheckResult> {
  const c = cfg ?? (await loadEconomyConfig(db));
  const w = c.withdrawal;
  const errors: WithdrawalCheckError[] = [];
  const reviewFlags: string[] = [];
  const err = (code: string, message: string) => errors.push({ code, message });

  let quote: WithdrawalQuote | null = null;
  if (input.amount < BigInt(w.min)) err("BELOW_MINIMUM", `Minimum withdrawal is ${w.min}`);
  if (input.amount > BigInt(w.max)) err("ABOVE_MAXIMUM", `Maximum withdrawal is ${w.max}`);
  try {
    quote = withdrawalQuote(input.amount, c);
  } catch {
    err("AMOUNT_TOO_SMALL", "Amount does not cover fees");
  }

  const user = await db.user.findUnique({
    where: { id: input.userId },
    select: { createdAt: true, riskLevel: true, bannedAt: true, restrictions: true }
  });
  if (!user) return { ok: false, errors: [{ code: "NOT_FOUND", message: "User not found" }], reviewFlags, quote, dailyUsed: 0n, nextAllowedAt: null, walletLockUntil: null };
  if (user.bannedAt || user.restrictions.includes("NO_WITHDRAWALS") || user.restrictions.includes("SUSPENDED")) err("ACCOUNT_RESTRICTED", "Withdrawals are disabled for this account");
  const ageH = (now.getTime() - user.createdAt.getTime()) / 3_600_000;
  if (ageH < w.minAccountAgeHours) err("ACCOUNT_TOO_NEW", `Account must be at least ${w.minAccountAgeHours}h old`);
  if (user.riskLevel === RiskLevel.CRITICAL) err("UNDER_REVIEW", "Account is under security review");
  else if (!riskAtMost(user.riskLevel, c.risk.autoReviewWithdrawalRisk)) reviewFlags.push(`RISK_${user.riskLevel}`);
  else if (user.riskLevel !== RiskLevel.LOW && user.riskLevel === c.risk.autoReviewWithdrawalRisk) reviewFlags.push(`RISK_${user.riskLevel}`);

  const wallet = await db.wallet.findUnique({ where: { address: input.address }, select: { userId: true, unlinkedAt: true } });
  if (!wallet || wallet.userId !== input.userId || wallet.unlinkedAt) err("WALLET_NOT_LINKED", "Withdrawals can only go to a verified wallet linked to your account");

  const walletLockUntil = await walletChangeLockUntil(db, input.userId, c, now);
  if (walletLockUntil) err("WALLET_CHANGE_LOCK", `Withdrawals are locked until ${walletLockUntil.toISOString()} after a wallet change`);

  const dailyUsed = await withdrawalDailyUsed(db, input.userId, now);
  if (dailyUsed + input.amount > BigInt(w.dailyLimit)) err("DAILY_LIMIT", "Daily withdrawal limit reached");

  const last = await db.withdrawal.findFirst({
    where: { userId: input.userId, status: { notIn: [WithdrawalStatus.CANCELLED] } },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true }
  });
  let nextAllowedAt: Date | null = null;
  if (last) {
    const t = new Date(last.createdAt.getTime() + w.cooldownMinutes * 60_000);
    if (t > now) {
      nextAllowedAt = t;
      err("COOLDOWN", `Next withdrawal available at ${t.toISOString()}`);
    }
  }
  const bal = await getBalance(db, userWallet(input.userId, Currency.NEBX));
  if (bal < input.amount) err("INSUFFICIENT_BALANCE", "Insufficient balance");

  // Velocity: many withdrawals in 24h → review.
  const count24 = await db.withdrawal.count({ where: { userId: input.userId, createdAt: { gte: new Date(now.getTime() - DAY_MS) } } });
  if (count24 >= 5) reviewFlags.push("VELOCITY");
  if (input.amount >= BigInt(w.reviewThreshold)) reviewFlags.push("LARGE_AMOUNT");
  if (await isBreakerActive(db, CircuitBreakerMode.WITHDRAWAL_REVIEW)) reviewFlags.push("BREAKER_WITHDRAWAL_REVIEW");

  return { ok: errors.length === 0, errors, reviewFlags, quote, dailyUsed, nextAllowedAt, walletLockUntil };
}

export class WithdrawalError extends Error {
  code: string;
  errors: WithdrawalCheckError[];
  constructor(errors: WithdrawalCheckError[]) {
    super(errors.map((e) => e.message).join("; "));
    this.code = errors[0]?.code ?? "WITHDRAWAL_REJECTED";
    this.errors = errors;
  }
}

export interface CreateWithdrawalResult {
  withdrawalId: string;
  status: string;
  duplicate: boolean;
  quote: WithdrawalQuote;
}

/**
 * Creates a withdrawal atomically (SERIALIZABLE): re-checks limits inside the transaction, holds
 * funds (USER_WALLET → WITHDRAWAL_RESERVE, service fee → FEE_REVENUE), creates the Withdrawal and
 * its durable ChainTransaction. Idempotent per (userId, idempotencyKey). Parallel requests can never
 * overdraw: the ledger decrement is conditional and the daily-limit read is serializable.
 */
export async function createWithdrawal(
  db: Db,
  input: { userId: string; amount: bigint; address: string; idempotencyKey: string; mint?: string | null },
  now = new Date()
): Promise<CreateWithdrawalResult> {
  const existing = await db.withdrawal.findUnique({ where: { userId_idempotencyKey: { userId: input.userId, idempotencyKey: input.idempotencyKey } } });
  if (existing) {
    return {
      withdrawalId: existing.id,
      status: existing.status,
      duplicate: true,
      quote: { requested: existing.requested, serviceFee: existing.serviceFee, networkFee: existing.networkFee, final: existing.final }
    };
  }
  const cfg = await loadEconomyConfig(db);
  try {
    return await withSerializableTx(db, async (tx) => {
      const check = await checkWithdrawal(tx, input, cfg, now);
      if (!check.ok || !check.quote) throw new WithdrawalError(check.errors);
      const q = check.quote;
      const status = check.reviewFlags.length ? WithdrawalStatus.PENDING_REVIEW : WithdrawalStatus.PENDING;
      const w = await tx.withdrawal.create({
        data: {
          userId: input.userId,
          address: input.address,
          asset: Currency.NEBX,
          mint: input.mint ?? null,
          requested: q.requested,
          serviceFee: q.serviceFee,
          networkFee: q.networkFee,
          final: q.final,
          status,
          chainState: ChainTxState.CREATED,
          riskFlags: check.reviewFlags,
          idempotencyKey: input.idempotencyKey
        }
      });
      const hold = await post(tx, {
        from: userWallet(input.userId, Currency.NEBX),
        to: system(LedgerAccountType.WITHDRAWAL_RESERVE, Currency.NEBX),
        amount: q.final + q.networkFee,
        type: "WITHDRAWAL",
        reference: w.id,
        idempotencyKey: `wd-hold:${w.id}`,
        userId: input.userId,
        metadata: { address: input.address, stage: "hold" }
      });
      await post(tx, {
        from: userWallet(input.userId, Currency.NEBX),
        to: system(LedgerAccountType.FEE_REVENUE, Currency.NEBX),
        amount: q.serviceFee,
        type: "FEE",
        reference: w.id,
        idempotencyKey: `wd-fee:${w.id}`,
        userId: input.userId,
        metadata: { kind: "withdrawal_service_fee" }
      });
      await tx.withdrawal.update({ where: { id: w.id }, data: { ledgerHoldId: hold.id } });
      await tx.chainTransaction.create({
        data: {
          kind: "WITHDRAWAL_PAYOUT",
          referenceId: w.id,
          state: ChainTxState.CREATED,
          payload: { withdrawalId: w.id, destination: input.address, amount: q.final.toString(), mint: input.mint ?? null, memo: withdrawalMemo(w.id) }
        }
      });
      return { withdrawalId: w.id, status, duplicate: false, quote: q };
    });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") {
      const again = await db.withdrawal.findUnique({ where: { userId_idempotencyKey: { userId: input.userId, idempotencyKey: input.idempotencyKey } } });
      if (again) return { withdrawalId: again.id, status: again.status, duplicate: true, quote: { requested: again.requested, serviceFee: again.serviceFee, networkFee: again.networkFee, final: again.final } };
    }
    throw err;
  }
}

/** On-chain memo for a withdrawal payout (used to find an existing payout before resubmitting). */
export function withdrawalMemo(withdrawalId: string): string {
  return `nebula:wd:${withdrawalId}`;
}

/** Ledger settlement after ON-CHAIN CONFIRMATION only. Idempotent. */
export async function settleWithdrawalLedger(tx: Tx, w: { id: string; userId: string; final: bigint; networkFee: bigint }, signature: string): Promise<void> {
  await post(tx, {
    from: system(LedgerAccountType.WITHDRAWAL_RESERVE, Currency.NEBX),
    to: system(LedgerAccountType.EXTERNAL_CHAIN, Currency.NEBX),
    amount: w.final,
    type: "WITHDRAWAL",
    reference: w.id,
    idempotencyKey: `wd-settle:${w.id}`,
    userId: w.userId,
    metadata: { signature, stage: "settle" }
  });
  if (w.networkFee > 0n) {
    await post(tx, {
      from: system(LedgerAccountType.WITHDRAWAL_RESERVE, Currency.NEBX),
      to: system(LedgerAccountType.FEE_REVENUE, Currency.NEBX),
      amount: w.networkFee,
      type: "FEE",
      reference: w.id,
      idempotencyKey: `wd-netfee:${w.id}`,
      userId: w.userId,
      metadata: { kind: "withdrawal_network_fee", signature }
    });
  }
}

/** Compensating entries returning held funds + service fee to the player. Idempotent. */
export async function refundWithdrawalLedger(tx: Tx, w: { id: string; userId: string; final: bigint; networkFee: bigint; serviceFee: bigint }, reason: string): Promise<void> {
  await post(tx, {
    from: system(LedgerAccountType.WITHDRAWAL_RESERVE, Currency.NEBX),
    to: userWallet(w.userId, Currency.NEBX),
    amount: w.final + w.networkFee,
    type: "COMPENSATION",
    reference: w.id,
    idempotencyKey: `wd-refund:${w.id}`,
    userId: w.userId,
    metadata: { reason }
  });
  if (w.serviceFee > 0n) {
    await post(tx, {
      from: system(LedgerAccountType.FEE_REVENUE, Currency.NEBX),
      to: userWallet(w.userId, Currency.NEBX),
      amount: w.serviceFee,
      type: "COMPENSATION",
      reference: w.id,
      idempotencyKey: `wd-refund-fee:${w.id}`,
      userId: w.userId,
      metadata: { reason, kind: "withdrawal_service_fee_refund" }
    });
  }
}

/** Admin review decision for PENDING_REVIEW withdrawals. Reject refunds the player. */
export async function reviewWithdrawal(db: Db, withdrawalId: string, approve: boolean, adminId: string, reason: string): Promise<{ status: string }> {
  return withSerializableTx(db, async (tx) => {
    const w = await tx.withdrawal.findUnique({ where: { id: withdrawalId } });
    if (!w) throw new WithdrawalError([{ code: "NOT_FOUND", message: "Withdrawal not found" }]);
    if (w.status !== WithdrawalStatus.PENDING_REVIEW) throw new WithdrawalError([{ code: "NOT_REVIEWABLE", message: `Withdrawal is ${w.status}` }]);
    // Four-eyes rule: an admin who also plays may never decide their own withdrawal.
    if (w.userId === adminId) throw new WithdrawalError([{ code: "SELF_REVIEW", message: "Reviewers cannot decide their own withdrawal" }]);
    if (approve) {
      await tx.withdrawal.update({ where: { id: w.id }, data: { status: WithdrawalStatus.PENDING, reviewedBy: adminId } });
    } else {
      await refundWithdrawalLedger(tx, w, `Rejected by review: ${reason}`);
      await tx.withdrawal.update({ where: { id: w.id }, data: { status: WithdrawalStatus.CANCELLED, reviewedBy: adminId, failureReason: `Rejected: ${reason}`.slice(0, 500), chainState: ChainTxState.FAILED } });
      await tx.chainTransaction.updateMany({ where: { referenceId: w.id }, data: { state: ChainTxState.FAILED, lastError: "Rejected by review" } });
    }
    await tx.auditLog.create({
      data: {
        actorId: adminId,
        action: approve ? "WITHDRAWAL_APPROVED" : "WITHDRAWAL_REJECTED",
        targetType: "Withdrawal",
        targetId: w.id,
        oldValue: { status: w.status },
        newValue: { status: approve ? WithdrawalStatus.PENDING : WithdrawalStatus.CANCELLED },
        reason
      }
    });
    return { status: approve ? WithdrawalStatus.PENDING : WithdrawalStatus.CANCELLED };
  });
}
