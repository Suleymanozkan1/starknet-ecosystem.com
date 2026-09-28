/**
 * Append-only double-entry ledger.
 *
 * Convention: every posting moves `amount` of `asset` FROM `debitAccount` (balance decreases)
 * TO `creditAccount` (balance increases). Sum of all balances per asset is therefore always 0
 * once issuance/external accounts (allowed to go negative) are included — this is asserted by
 * `verifyLedgerIntegrity`.
 *
 * - Postings are idempotent by `idempotencyKey` (unique index): replaying a request can never
 *   double-credit.
 * - Balance decrements use a conditional UPDATE (`balance >= amount`) so concurrent spends can
 *   never overdraw an account (no read-modify-write race).
 * - Rows are never updated/deleted; corrections are compensating postings (`reverse`).
 */
import { LedgerAccountType, type Currency, type LedgerTxType } from "@nebula/shared";
import { isRootClient, type DbOrTx, type Tx } from "./client.js";

export class LedgerError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** System accounts allowed to hold negative balances (they represent flows, not holdings). */
const NEGATIVE_ALLOWED = new Set<string>([
  LedgerAccountType.GAME_ISSUANCE,
  LedgerAccountType.EXTERNAL_CHAIN,
]);

export interface AccountRef {
  type: LedgerAccountType;
  asset: Currency;
  userId?: string | null;
}

export function accountKey(ref: AccountRef): string {
  return ref.userId ? `${ref.type}:${ref.userId}:${ref.asset}` : `${ref.type}:${ref.asset}`;
}

export const userWallet = (userId: string, asset: Currency): AccountRef => ({ type: LedgerAccountType.USER_WALLET, asset, userId });
export const userPending = (userId: string, asset: Currency): AccountRef => ({ type: LedgerAccountType.USER_PENDING_REWARD, asset, userId });
export const system = (type: LedgerAccountType, asset: Currency): AccountRef => ({ type, asset });

export async function ensureAccount(tx: DbOrTx, ref: AccountRef): Promise<{ id: string; key: string }> {
  const key = accountKey(ref);
  const existing = await tx.balanceAccount.findUnique({ where: { key }, select: { id: true, key: true } });
  if (existing) return existing;
  // INSERT ... ON CONFLICT DO NOTHING: a concurrent creator never raises a unique violation, so an
  // enclosing transaction is not aborted. Any other error (incl. serialization failures, which
  // withSerializableTx retries) propagates unchanged.
  await tx.balanceAccount.createMany({
    data: [{ key, type: ref.type, asset: ref.asset, userId: ref.userId ?? null, allowNegative: NEGATIVE_ALLOWED.has(ref.type) }],
    skipDuplicates: true,
  });
  const row = await tx.balanceAccount.findUnique({ where: { key }, select: { id: true, key: true } });
  if (!row) throw new LedgerError("ACCOUNT_CREATE_FAILED", `Could not create account ${key}`);
  return row;
}

export interface PostingInput {
  from: AccountRef;
  to: AccountRef;
  amount: bigint;
  type: LedgerTxType;
  reference: string;
  idempotencyKey: string;
  userId?: string | null;
  metadata?: Record<string, unknown>;
  correlationId?: string;
}

export interface PostingResult {
  id: string;
  duplicate: boolean;
}

/**
 * Post one transfer. Must run inside an interactive transaction (the decrement, increment and
 * journal insert are only atomic together); passing the root client is rejected at runtime.
 */
export async function post(tx: Tx, input: PostingInput): Promise<PostingResult> {
  if (isRootClient(tx)) throw new LedgerError("TX_REQUIRED", "post() must run inside a transaction");
  if (input.amount <= 0n) throw new LedgerError("INVALID_AMOUNT", "Amount must be positive");
  if (input.from.asset !== input.to.asset) throw new LedgerError("ASSET_MISMATCH", "Cross-asset postings are not allowed");

  const dup = await tx.balanceLedger.findUnique({ where: { idempotencyKey: input.idempotencyKey }, select: { id: true } });
  if (dup) return { id: dup.id, duplicate: true };

  const from = await ensureAccount(tx, input.from);
  const to = await ensureAccount(tx, input.to);

  // Conditional decrement — prevents overdraft even under concurrency.
  const dec = await tx.balanceAccount.updateMany({
    where: NEGATIVE_ALLOWED.has(input.from.type)
      ? { id: from.id }
      : { id: from.id, balance: { gte: input.amount } },
    data: { balance: { decrement: input.amount }, version: { increment: 1 } },
  });
  if (dec.count !== 1) {
    throw new LedgerError("INSUFFICIENT_BALANCE", `Insufficient ${input.from.asset} balance in ${from.key}`);
  }
  await tx.balanceAccount.update({
    where: { id: to.id },
    data: { balance: { increment: input.amount }, version: { increment: 1 } },
  });

  // ON CONFLICT DO NOTHING on idempotencyKey: a concurrent replay that committed after our dup check
  // must not abort the caller's transaction with a unique violation.
  const inserted = await tx.balanceLedger.createManyAndReturn({
    data: [{
      debitAccountId: from.id,
      creditAccountId: to.id,
      userId: input.userId ?? input.from.userId ?? input.to.userId ?? null,
      type: input.type,
      asset: input.from.asset,
      amount: input.amount,
      reference: input.reference,
      idempotencyKey: input.idempotencyKey,
      metadata: (input.metadata ?? {}) as object,
      correlationId: input.correlationId ?? null,
    }],
    skipDuplicates: true,
    select: { id: true },
  });
  const row = inserted[0];
  if (row) return { id: row.id, duplicate: false };

  // Lost the race: the other posting already moved the funds. Undo this transaction's balance moves
  // (same transaction, so nothing is ever visible) and report the winner as a duplicate.
  await tx.balanceAccount.update({ where: { id: from.id }, data: { balance: { increment: input.amount }, version: { increment: 1 } } });
  await tx.balanceAccount.update({ where: { id: to.id }, data: { balance: { decrement: input.amount }, version: { increment: 1 } } });
  const winner = await tx.balanceLedger.findUnique({ where: { idempotencyKey: input.idempotencyKey }, select: { id: true } });
  if (!winner) throw new LedgerError("IDEMPOTENCY_CONFLICT", `Posting ${input.idempotencyKey} conflicted but no winner is visible`);
  return { id: winner.id, duplicate: true };
}

/** Post several legs atomically (caller provides the transaction). */
export async function postMany(tx: Tx, legs: PostingInput[]): Promise<PostingResult[]> {
  const out: PostingResult[] = [];
  for (const leg of legs) out.push(await post(tx, leg));
  return out;
}

/**
 * Compensating entry: moves the same amount back. Original row is left untouched. The idempotency
 * key is fixed per original entry, so an entry can be reversed at most once; compensation entries
 * themselves cannot be reversed.
 */
export async function reverse(tx: Tx, ledgerId: string, reason: string): Promise<PostingResult> {
  const orig = await tx.balanceLedger.findUnique({
    where: { id: ledgerId },
    include: { debitAccount: true, creditAccount: true },
  });
  if (!orig) throw new LedgerError("NOT_FOUND", "Ledger entry not found");
  if (orig.type === "COMPENSATION") throw new LedgerError("NOT_REVERSIBLE", "Compensation entries cannot be reversed");
  return post(tx, {
    from: { type: orig.creditAccount.type as LedgerAccountType, asset: orig.asset as Currency, userId: orig.creditAccount.userId },
    to: { type: orig.debitAccount.type as LedgerAccountType, asset: orig.asset as Currency, userId: orig.debitAccount.userId },
    amount: orig.amount,
    type: "COMPENSATION",
    reference: orig.id,
    idempotencyKey: `reverse:${orig.id}`,
    userId: orig.userId,
    metadata: { reason, reverses: orig.id },
  });
}

export async function getBalance(db: DbOrTx, ref: AccountRef): Promise<bigint> {
  const row = await db.balanceAccount.findUnique({ where: { key: accountKey(ref) }, select: { balance: true } });
  return row?.balance ?? 0n;
}

export async function getUserBalances(db: DbOrTx, userId: string): Promise<Record<string, bigint>> {
  const rows = await db.balanceAccount.findMany({ where: { userId }, select: { type: true, asset: true, balance: true } });
  const out: Record<string, bigint> = {};
  for (const r of rows) out[`${r.type}:${r.asset}`] = r.balance;
  return out;
}

export interface LedgerIntegrityRow {
  asset: string;
  /** Sum of all account balances for the asset (double entry ⇒ must be 0). */
  sum: bigint;
  /** Accounts whose stored balance differs from the balance replayed from the journal. */
  mismatchedAccounts: number;
  ok: boolean;
}

/**
 * Per asset: (1) the sum of all balances must be 0, and (2) every account's stored balance must
 * equal its journal replay (credits − debits), checked with one aggregate query. (1) alone cannot
 * detect drift because every posting changes two balances by equal and opposite amounts.
 */
export async function verifyLedgerIntegrity(db: DbOrTx): Promise<LedgerIntegrityRow[]> {
  const rows = await db.balanceAccount.groupBy({ by: ["asset"], _sum: { balance: true } });
  const drift = await db.$queryRaw<{ asset: string; mismatched: number }[]>`
    WITH net AS (
      SELECT j.id, SUM(j.delta) AS net FROM (
        SELECT "creditAccountId" AS id, "amount" AS delta FROM "BalanceLedger"
        UNION ALL
        SELECT "debitAccountId" AS id, -"amount" AS delta FROM "BalanceLedger"
      ) j GROUP BY j.id
    )
    SELECT a."asset" AS asset, COUNT(*)::int AS mismatched
    FROM "BalanceAccount" a LEFT JOIN net n ON n.id = a."id"
    WHERE a."balance" <> COALESCE(n.net, 0)
    GROUP BY a."asset"`;
  const mismatchedByAsset = new Map(drift.map((d) => [d.asset, Number(d.mismatched)]));
  return rows.map((r) => {
    const sum = r._sum.balance ?? 0n;
    const mismatchedAccounts = mismatchedByAsset.get(r.asset) ?? 0;
    return { asset: r.asset, sum, mismatchedAccounts, ok: sum === 0n && mismatchedAccounts === 0 };
  });
}

/** Recompute an account's balance from the journal (audit / reconciliation). */
export async function replayBalance(db: DbOrTx, accountId: string): Promise<bigint> {
  const [inc, dec] = await Promise.all([
    db.balanceLedger.aggregate({ where: { creditAccountId: accountId }, _sum: { amount: true } }),
    db.balanceLedger.aggregate({ where: { debitAccountId: accountId }, _sum: { amount: true } }),
  ]);
  return (inc._sum.amount ?? 0n) - (dec._sum.amount ?? 0n);
}
