/**
 * Withdrawal payout state machine (the ONLY code path that moves treasury funds).
 *
 *   Withdrawal.status:  PENDING → (risk/limits re-check) → PENDING_REVIEW | PROCESSING → COMPLETED | FAILED
 *   chainState:         CREATED → QUEUED → SUBMITTED → CONFIRMING → CONFIRMED
 *                                    ↘ RETRYING (exp. backoff) ↗        ↘ FAILED (+ compensating refund)
 *
 * Safety invariants
 *  - The signature is persisted BEFORE broadcast (onSigned). After a crash the tx is re-checked,
 *    never blindly re-sent.
 *  - A tx is only rebuilt when the previous one provably cannot land any more (blockhash expired and
 *    signature unknown, or it landed with an error), and only after searching the treasury history
 *    for the withdrawal memo.
 *  - A memo match is only adopted after verifying it is a genuine payout (treasury fee payer + signer,
 *    exact w.final transfer treasury → w.address with the configured mint and memo). The memo is
 *    derivable from the withdrawal id, so anyone could send the treasury a spoof tx carrying it.
 *  - COMPLETED + ledger settlement happen only after an on-chain confirmation.
 *  - Row updates are conditional (optimistic concurrency) so two workers can't double-submit.
 */
import { ChainTxState, WithdrawalStatus, CircuitBreakerMode, RiskLevel } from "@nebula/shared";
import type { Db } from "@nebula/database";
import type { Prisma } from "@nebula/database";
import {
  buildAndSendPayout,
  checkSignature,
  findPayoutsByMemo,
  verifyPayoutTransaction,
  type ConfirmationOutcome,
  type SolanaRpcClient,
  type SolanaRpcSubscriptionsClient
} from "@nebula/blockchain";
import { isBreakerActive, loadEconomyConfig, recordRiskSignal, refundWithdrawalLedger, riskAtMost, settleWithdrawalLedger, withdrawalMemo } from "@nebula/economy";
import type { TransactionSigner } from "@solana/kit";
import type { Metrics } from "./metrics.js";
import { log } from "./logger.js";

export interface ProcessorDeps {
  db: Db;
  rpc: SolanaRpcClient;
  rpcSubscriptions?: SolanaRpcSubscriptionsClient;
  getSigner: () => Promise<TransactionSigner>;
  treasuryAddress: string;
  mint: string | null;
  mintDecimals: number;
  maxAttempts: number;
  backoffBaseMs: number;
  confirmPollMs: number;
  /** How long a single step waits inline for confirmation before yielding (ms). */
  inlineConfirmMs: number;
  metrics?: Metrics;
  now?: () => Date;
}

export type StepResult = { done: true; status: string } | { done: false; retryInMs: number; status: string };

const IN_FLIGHT = [ChainTxState.SUBMITTED, ChainTxState.CONFIRMING] as string[];
const READY = [ChainTxState.CREATED, ChainTxState.QUEUED, ChainTxState.RETRYING] as string[];
export const RECOVERABLE_CHAIN_STATES = [ChainTxState.CREATED, ChainTxState.QUEUED, ChainTxState.SUBMITTED, ChainTxState.CONFIRMING, ChainTxState.RETRYING] as string[];

type WithdrawalRow = NonNullable<Awaited<ReturnType<Db["withdrawal"]["findUnique"]>>>;

export async function processWithdrawal(deps: ProcessorDeps, withdrawalId: string): Promise<StepResult> {
  const now = deps.now?.() ?? new Date();
  const w = await deps.db.withdrawal.findUnique({ where: { id: withdrawalId } });
  if (!w) return { done: true, status: "NOT_FOUND" };
  if (w.status === WithdrawalStatus.COMPLETED || w.status === WithdrawalStatus.FAILED || w.status === WithdrawalStatus.CANCELLED) {
    return { done: true, status: w.status };
  }
  if (w.status === WithdrawalStatus.PENDING_REVIEW) return { done: true, status: w.status };

  if (w.status === WithdrawalStatus.PENDING) {
    const gate = await preflightGate(deps, w);
    if (gate) return gate;
    const moved = await deps.db.withdrawal.updateMany({
      where: { id: w.id, status: WithdrawalStatus.PENDING },
      data: { status: WithdrawalStatus.PROCESSING, chainState: ChainTxState.QUEUED }
    });
    await deps.db.chainTransaction.updateMany({ where: { referenceId: w.id, state: ChainTxState.CREATED }, data: { state: ChainTxState.QUEUED } });
    if (moved.count !== 1) return { done: false, retryInMs: 500, status: "RACE" };
    return processWithdrawal(deps, withdrawalId);
  }

  // PROCESSING
  if (w.chainState === ChainTxState.CONFIRMED) {
    if (!w.signature) throw new Error(`Withdrawal ${w.id} CONFIRMED without signature`);
    await finalize(deps, w, w.signature);
    return { done: true, status: WithdrawalStatus.COMPLETED };
  }
  if (IN_FLIGHT.includes(w.chainState)) return checkInFlight(deps, w);
  if (READY.includes(w.chainState)) {
    if (w.nextAttemptAt && w.nextAttemptAt > now) return { done: false, retryInMs: w.nextAttemptAt.getTime() - now.getTime(), status: w.chainState };
    return submit(deps, w);
  }
  return { done: true, status: w.status };
}

/** Re-check risk / breaker / account state right before money moves. */
async function preflightGate(deps: ProcessorDeps, w: WithdrawalRow): Promise<StepResult | null> {
  const { db } = deps;
  const cfg = await loadEconomyConfig(db);
  const user = await db.user.findUnique({ where: { id: w.userId }, select: { riskLevel: true, bannedAt: true, restrictions: true } });
  if (!user || user.bannedAt || user.restrictions.includes("NO_WITHDRAWALS")) {
    await db.$transaction(async (tx) => {
      const upd = await tx.withdrawal.updateMany({ where: { id: w.id, status: WithdrawalStatus.PENDING }, data: { status: WithdrawalStatus.CANCELLED, chainState: ChainTxState.FAILED, failureReason: "Account restricted" } });
      if (upd.count === 1) await refundWithdrawalLedger(tx, w, "Account restricted before payout");
      await tx.chainTransaction.updateMany({ where: { referenceId: w.id }, data: { state: ChainTxState.FAILED, lastError: "Account restricted" } });
    });
    return { done: true, status: WithdrawalStatus.CANCELLED };
  }
  if (w.reviewedBy) return null; // a human already approved it
  const flags: string[] = [];
  if (user.riskLevel === RiskLevel.CRITICAL || !riskAtMost(user.riskLevel, cfg.risk.autoReviewWithdrawalRisk) || (user.riskLevel !== RiskLevel.LOW && user.riskLevel === cfg.risk.autoReviewWithdrawalRisk)) {
    flags.push(`RISK_${user.riskLevel}`);
  }
  if (await isBreakerActive(db, CircuitBreakerMode.WITHDRAWAL_REVIEW)) flags.push("BREAKER_WITHDRAWAL_REVIEW");
  if (!flags.length) return null;
  await db.withdrawal.updateMany({
    where: { id: w.id, status: WithdrawalStatus.PENDING },
    data: { status: WithdrawalStatus.PENDING_REVIEW, riskFlags: [...new Set([...w.riskFlags, ...flags])] }
  });
  deps.metrics?.inc("withdrawals_review_total");
  log.info("withdrawal routed to manual review", { withdrawalId: w.id, flags });
  return { done: true, status: WithdrawalStatus.PENDING_REVIEW };
}

/**
 * Looks up treasury transactions carrying this withdrawal's memo and returns the first one that is a
 * verified genuine payout. "retry" = lookup/verification could not complete (never resubmit then);
 * null = no genuine payout. Spoofed memo matches are logged + risk-scored and ignored.
 */
async function findGenuinePayout(deps: ProcessorDeps, w: WithdrawalRow, exclude: string | null = null): Promise<{ signature: string } | "retry" | null> {
  const memo = withdrawalMemo(w.id);
  let candidates: Awaited<ReturnType<typeof findPayoutsByMemo>>;
  try {
    candidates = await findPayoutsByMemo(deps.rpc, deps.treasuryAddress, memo);
  } catch (err) {
    log.warn("memo lookup failed", { withdrawalId: w.id, error: (err as Error).message });
    return "retry";
  }
  let pending = false;
  for (const c of candidates) {
    if (c.err || c.signature === exclude) continue;
    const v = await verifyPayoutTransaction(deps.rpc, { signature: c.signature, treasury: deps.treasuryAddress, destination: w.address, amount: w.final, mint: deps.mint, memo });
    if (v.ok) return { signature: c.signature };
    if (v.retryable) {
      pending = true;
      continue;
    }
    log.warn("memo-matched transaction is not a genuine payout; ignoring it", { withdrawalId: w.id, signature: c.signature, reason: v.reason });
    deps.metrics?.inc("withdrawal_spoofed_memo_total");
    await recordRiskSignal(deps.db, {
      userId: w.userId,
      type: "FAKE_TRANSACTION",
      score: 10,
      details: { withdrawalId: w.id, signature: c.signature, reason: v.reason, message: v.message },
      source: "withdrawal"
    }).catch(() => undefined);
  }
  return pending ? "retry" : null;
}

async function submit(deps: ProcessorDeps, w: WithdrawalRow): Promise<StepResult> {
  const { db } = deps;
  const memo = withdrawalMemo(w.id);
  // Idempotency: never pay twice — look for an earlier (verified) payout carrying this memo first.
  const existing = await findGenuinePayout(deps, w);
  if (existing === "retry") {
    log.warn("memo lookup/verification incomplete; will retry before submitting", { withdrawalId: w.id });
    return { done: false, retryInMs: deps.confirmPollMs, status: w.chainState };
  }
  if (existing) {
    log.warn("found existing on-chain payout for withdrawal; adopting it", { withdrawalId: w.id, signature: existing.signature });
    await db.$transaction([
      db.withdrawal.update({ where: { id: w.id }, data: { signature: existing.signature, chainState: ChainTxState.CONFIRMING } }),
      db.chainTransaction.updateMany({ where: { referenceId: w.id }, data: { signature: existing.signature, state: ChainTxState.CONFIRMING } })
    ]);
    const fresh = await db.withdrawal.findUniqueOrThrow({ where: { id: w.id } });
    return checkInFlight(deps, fresh);
  }

  // Claim this attempt (optimistic concurrency on attempts + chainState).
  const claimed = await db.withdrawal.updateMany({
    where: { id: w.id, status: WithdrawalStatus.PROCESSING, chainState: w.chainState, attempts: w.attempts, signature: null },
    data: { attempts: { increment: 1 } }
  });
  if (claimed.count !== 1) return { done: false, retryInMs: 1000, status: "RACE" };
  const attempt = w.attempts + 1;
  deps.metrics?.inc("withdrawal_submit_attempts_total");

  let signedSig: string | null = null;
  let outcome: ConfirmationOutcome;
  try {
    const signer = await deps.getSigner();
    outcome = await buildAndSendPayout({
      rpc: deps.rpc,
      rpcSubscriptions: deps.rpcSubscriptions,
      signer,
      destination: w.address,
      amount: w.final,
      mint: deps.mint,
      mintDecimals: deps.mintDecimals,
      memo,
      confirmTimeoutMs: deps.inlineConfirmMs,
      onSigned: async ({ signature, lastValidBlockHeight }) => {
        signedSig = signature;
        await db.$transaction([
          db.withdrawal.update({
            where: { id: w.id },
            data: { signature, lastValidBlockHeight, chainState: ChainTxState.SUBMITTED, submittedAt: new Date(), nextAttemptAt: null }
          }),
          db.chainTransaction.updateMany({
            where: { referenceId: w.id },
            data: { signature, state: ChainTxState.SUBMITTED, attempts: attempt, lastError: null }
          })
        ]);
        log.info("payout signed and persisted; broadcasting", { withdrawalId: w.id, signature, attempt });
      }
    });
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    if (signedSig) {
      // Signature persisted: the tx may or may not have been broadcast. Resolve via status/expiry.
      await db.chainTransaction.updateMany({ where: { referenceId: w.id }, data: { lastError: message.slice(0, 1000) } });
      log.warn("broadcast error after signing; will re-check signature", { withdrawalId: w.id, signature: signedSig, error: message });
      return { done: false, retryInMs: deps.confirmPollMs, status: ChainTxState.SUBMITTED };
    }
    log.warn("payout build/sign failed before broadcast", { withdrawalId: w.id, error: message });
    return failAttempt(deps, w.id, `Submit failed: ${message}`);
  }
  return handleOutcome(deps, w.id, outcome);
}

async function checkInFlight(deps: ProcessorDeps, w: WithdrawalRow): Promise<StepResult> {
  if (!w.signature) {
    await deps.db.withdrawal.update({ where: { id: w.id }, data: { chainState: ChainTxState.RETRYING } });
    return { done: false, retryInMs: 0, status: ChainTxState.RETRYING };
  }
  let outcome: ConfirmationOutcome;
  try {
    outcome = await checkSignature(deps.rpc, w.signature, w.lastValidBlockHeight ?? null);
  } catch (err) {
    log.warn("signature status check failed", { withdrawalId: w.id, error: (err as Error).message });
    return { done: false, retryInMs: deps.confirmPollMs, status: w.chainState };
  }
  if (outcome.status === "EXPIRED") {
    // One more history lookup: an earlier attempt with the same memo may have landed.
    const found = await findGenuinePayout(deps, w, w.signature);
    if (found === "retry") return { done: false, retryInMs: deps.confirmPollMs, status: w.chainState };
    if (found) {
      await deps.db.withdrawal.update({ where: { id: w.id }, data: { signature: found.signature } });
      await deps.db.chainTransaction.updateMany({ where: { referenceId: w.id }, data: { signature: found.signature } });
      const fresh = await deps.db.withdrawal.findUniqueOrThrow({ where: { id: w.id } });
      return checkInFlight(deps, fresh);
    }
  }
  return handleOutcome(deps, w.id, outcome);
}

async function handleOutcome(deps: ProcessorDeps, withdrawalId: string, outcome: ConfirmationOutcome): Promise<StepResult> {
  const w = await deps.db.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId } });
  switch (outcome.status) {
    case "CONFIRMED":
      await finalize(deps, w, outcome.signature);
      return { done: true, status: WithdrawalStatus.COMPLETED };
    case "PENDING":
      if (w.chainState !== ChainTxState.CONFIRMING) {
        await deps.db.withdrawal.updateMany({ where: { id: w.id, chainState: ChainTxState.SUBMITTED }, data: { chainState: ChainTxState.CONFIRMING } });
        await deps.db.chainTransaction.updateMany({ where: { referenceId: w.id }, data: { state: ChainTxState.CONFIRMING } });
      }
      return { done: false, retryInMs: deps.confirmPollMs, status: ChainTxState.CONFIRMING };
    case "FAILED":
      return failAttempt(deps, w.id, `On-chain failure: ${outcome.error}`);
    case "EXPIRED":
      return failAttempt(deps, w.id, "Transaction expired before landing");
  }
}

/** Marks COMPLETED + settles the ledger. Only reachable with an on-chain confirmation. */
async function finalize(deps: ProcessorDeps, w: WithdrawalRow, signature: string): Promise<void> {
  await deps.db.$transaction(async (tx) => {
    const upd = await tx.withdrawal.updateMany({
      where: { id: w.id, status: WithdrawalStatus.PROCESSING },
      data: { status: WithdrawalStatus.COMPLETED, chainState: ChainTxState.CONFIRMED, completedAt: new Date(), signature, failureReason: null }
    });
    if (upd.count !== 1) return;
    await settleWithdrawalLedger(tx, w, signature);
    await tx.chainTransaction.updateMany({ where: { referenceId: w.id }, data: { state: ChainTxState.CONFIRMED, confirmedAt: new Date(), signature } });
    await tx.notification.create({
      data: {
        userId: w.userId,
        type: "WITHDRAWAL_COMPLETED",
        title: "Withdrawal completed",
        body: "Your withdrawal was confirmed on Solana devnet.",
        data: { withdrawalId: w.id, signature, amount: w.final.toString() }
      }
    });
  });
  deps.metrics?.inc("withdrawals_completed_total");
  log.info("withdrawal confirmed on chain", { withdrawalId: w.id, signature });
}

async function failAttempt(deps: ProcessorDeps, withdrawalId: string, reason: string): Promise<StepResult> {
  const { db } = deps;
  const w = await db.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId } });
  const ctx = await db.chainTransaction.findUnique({ where: { referenceId: w.id } });
  const payload = (ctx?.payload ?? {}) as Record<string, unknown>;
  const previous = Array.isArray(payload.previousSignatures) ? (payload.previousSignatures as string[]) : [];
  const newPayload = { ...payload, previousSignatures: w.signature ? [...previous, w.signature] : previous } as Prisma.InputJsonValue;
  if (w.attempts >= deps.maxAttempts) {
    await db.$transaction(async (tx) => {
      const upd = await tx.withdrawal.updateMany({
        where: { id: w.id, status: WithdrawalStatus.PROCESSING },
        data: { status: WithdrawalStatus.FAILED, chainState: ChainTxState.FAILED, failureReason: reason.slice(0, 500), signature: null, lastValidBlockHeight: null }
      });
      if (upd.count !== 1) return;
      await refundWithdrawalLedger(tx, w, reason);
      await tx.chainTransaction.updateMany({ where: { referenceId: w.id }, data: { state: ChainTxState.FAILED, lastError: reason.slice(0, 1000), signature: null, payload: newPayload } });
      await tx.notification.create({
        data: { userId: w.userId, type: "WITHDRAWAL_FAILED", title: "Withdrawal failed", body: "Your withdrawal could not be completed. The full amount including fees was returned to your balance.", data: { withdrawalId: w.id } }
      });
    });
    deps.metrics?.inc("withdrawals_failed_total");
    log.error("withdrawal failed permanently; funds returned", { withdrawalId: w.id, reason });
    return { done: true, status: WithdrawalStatus.FAILED };
  }
  const delay = deps.backoffBaseMs * 2 ** Math.max(0, w.attempts - 1);
  const next = new Date((deps.now?.() ?? new Date()).getTime() + delay);
  await db.$transaction([
    db.withdrawal.update({ where: { id: w.id }, data: { chainState: ChainTxState.RETRYING, nextAttemptAt: next, signature: null, lastValidBlockHeight: null, failureReason: reason.slice(0, 500) } }),
    db.chainTransaction.updateMany({ where: { referenceId: w.id }, data: { state: ChainTxState.RETRYING, lastError: reason.slice(0, 1000), nextAttemptAt: next, signature: null, payload: newPayload } })
  ]);
  deps.metrics?.inc("withdrawal_retries_total");
  log.warn("withdrawal attempt failed; retrying with backoff", { withdrawalId: w.id, attempt: w.attempts, delayMs: delay, reason });
  return { done: false, retryInMs: delay, status: ChainTxState.RETRYING };
}

/** IDs of withdrawals that still need work (used on boot and by the periodic sweeper). */
export async function findRecoverableWithdrawals(db: Db): Promise<string[]> {
  const [ws, cts] = await Promise.all([
    db.withdrawal.findMany({
      where: {
        OR: [
          { status: WithdrawalStatus.PENDING },
          { status: WithdrawalStatus.PROCESSING, chainState: { in: RECOVERABLE_CHAIN_STATES } }
        ]
      },
      select: { id: true },
      orderBy: { createdAt: "asc" },
      take: 5000
    }),
    db.chainTransaction.findMany({ where: { kind: "WITHDRAWAL_PAYOUT", state: { in: RECOVERABLE_CHAIN_STATES } }, select: { referenceId: true }, take: 5000 })
  ]);
  const ids = new Set<string>(ws.map((w) => w.id));
  if (cts.length) {
    const live = await db.withdrawal.findMany({
      where: { id: { in: cts.map((c) => c.referenceId) }, status: { in: [WithdrawalStatus.PENDING, WithdrawalStatus.PROCESSING] } },
      select: { id: true }
    });
    live.forEach((w) => ids.add(w.id));
  }
  return [...ids];
}
