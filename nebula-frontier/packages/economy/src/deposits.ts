import { randomBytes } from "node:crypto";
import { SHOP } from "@nebula/config";
import { Currency, DepositStatus, LedgerAccountType, CheatType } from "@nebula/shared";
import { post, system, userWallet, withSerializableTx, type Db, type DbOrTx } from "@nebula/database";
import { getActiveSeason } from "./rewardBudget.js";
import { recordRiskSignal } from "./risk.js";

export class DepositError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface GemPack {
  id: string;
  price: bigint;
  gems: number;
}

/** Gem packs sold for devnet SOL: DB ShopProduct rows (admin-editable) override shop.json. */
export async function getGemPacks(db: DbOrTx): Promise<GemPack[]> {
  const rows = await db.shopProduct.findMany({ where: { category: "GEMS", currency: Currency.SOL, active: true } });
  const fromDb = rows
    .map((r) => ({ id: r.id, price: r.price, gems: Number((r.grants as { gems?: number } | null)?.gems ?? 0) }))
    .filter((p) => p.gems > 0 && p.price > 0n);
  if (fromDb.length) return fromDb.sort((a, b) => (a.price < b.price ? -1 : 1));
  return SHOP.filter((p) => p.category === "GEMS" && p.currency === Currency.SOL && p.active && (p.grants.gems ?? 0) > 0)
    .map((p) => ({ id: p.id, price: BigInt(p.price), gems: p.grants.gems ?? 0 }))
    .sort((a, b) => (a.price < b.price ? -1 : 1));
}

/** Exact pack (by id or matching price) or the base rate of the smallest pack (floored). */
export function gemsForDeposit(amount: bigint, packs: GemPack[], productId?: string | null): { gems: number; packId: string | null } {
  if (productId) {
    const p = packs.find((x) => x.id === productId);
    if (!p) throw new DepositError("INVALID_PRODUCT", "Unknown gem pack");
    if (p.price !== amount) throw new DepositError("AMOUNT_MISMATCH", "Amount must equal the gem pack price");
    return { gems: p.gems, packId: p.id };
  }
  const exact = packs.find((p) => p.price === amount);
  if (exact) return { gems: exact.gems, packId: exact.id };
  const base = packs[0];
  if (!base) throw new DepositError("NO_GEM_PACKS", "Gem packs are not available");
  const gems = Number((amount * BigInt(base.gems)) / base.price);
  if (gems < 1) throw new DepositError("AMOUNT_TOO_SMALL", "Amount is too small to buy gems");
  return { gems, packId: null };
}

export interface PrepareDepositInput {
  userId: string;
  amount: bigint;
  purpose: "GEMS" | "BALANCE";
  idempotencyKey: string;
  recipient: string;
  mint?: string | null;
  productId?: string | null;
  ttlMinutes?: number;
}

export async function prepareDeposit(db: Db, input: PrepareDepositInput) {
  if (input.amount <= 0n) throw new DepositError("INVALID_AMOUNT", "Amount must be positive");
  const existing = await db.deposit.findUnique({ where: { userId_idempotencyKey: { userId: input.userId, idempotencyKey: input.idempotencyKey } } });
  if (existing) return existing;
  const wallet = await db.wallet.findFirst({ where: { userId: input.userId, unlinkedAt: null }, orderBy: [{ primary: "desc" }, { verifiedAt: "asc" }] });
  if (!wallet) throw new DepositError("NO_WALLET", "Link a verified wallet before depositing");
  if (input.purpose === "GEMS") gemsForDeposit(input.amount, await getGemPacks(db), input.productId); // validate early
  const memo = `nebula:dep:${randomBytes(12).toString("hex")}`;
  try {
    return await db.deposit.create({
      data: {
        userId: input.userId,
        walletAddress: wallet.address,
        recipient: input.recipient,
        asset: input.mint ? "SPL" : Currency.SOL,
        mint: input.mint ?? null,
        amount: input.amount,
        memo,
        purpose: input.purpose,
        status: DepositStatus.PREPARED,
        idempotencyKey: input.idempotencyKey,
        expiresAt: new Date(Date.now() + (input.ttlMinutes ?? 30) * 60_000)
      }
    });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") {
      const again = await db.deposit.findUnique({ where: { userId_idempotencyKey: { userId: input.userId, idempotencyKey: input.idempotencyKey } } });
      if (again) return again;
    }
    throw err;
  }
}

export interface VerifiedChainDeposit {
  signature: string;
  amount: bigint;
  sender: string;
  slot: bigint;
}

/**
 * Credits a chain-verified deposit exactly once. Signature uniqueness is enforced by the DB
 * (Deposit.signature @unique) and the ledger idempotency key.
 *  - BALANCE: EXTERNAL_CHAIN:SOL → USER_WALLET:<uid>:SOL
 *  - GEMS:    EXTERNAL_CHAIN:SOL → PREMIUM_REVENUE:SOL (gem sale revenue) and
 *             GAME_ISSUANCE:GEMS → USER_WALLET:<uid>:GEMS; active season revenue += amount.
 */
export async function creditDeposit(db: Db, depositId: string, userId: string, v: VerifiedChainDeposit, productId?: string | null) {
  const dupSig = await db.deposit.findUnique({ where: { signature: v.signature }, select: { id: true, userId: true } });
  if (dupSig && dupSig.id !== depositId) {
    await recordRiskSignal(db, { userId, type: CheatType.FAKE_TRANSACTION, score: 15, details: { reason: "signature reuse", signature: v.signature }, source: "deposit" }).catch(() => undefined);
    throw new DepositError("DUPLICATE_SIGNATURE", "This transaction was already used for another deposit");
  }
  const packs = await getGemPacks(db);
  try {
    return await withSerializableTx(db, async (tx) => {
      const d = await tx.deposit.findUnique({ where: { id: depositId } });
      if (!d || d.userId !== userId) throw new DepositError("NOT_FOUND", "Deposit not found");
      if (d.status === DepositStatus.CREDITED) {
        if (d.signature === v.signature) return { deposit: d, gems: 0, alreadyCredited: true };
        throw new DepositError("ALREADY_CREDITED", "Deposit already credited");
      }
      // EXPIRED is still creditable: if the player paid (memo verified on chain) the funds are theirs.
      if (d.status !== DepositStatus.PREPARED && d.status !== DepositStatus.SUBMITTED && d.status !== DepositStatus.EXPIRED) throw new DepositError("INVALID_STATE", `Deposit is ${d.status}`);
      if (v.amount !== d.amount) throw new DepositError("AMOUNT_MISMATCH", "Verified amount differs from prepared amount");
      let gems = 0;
      if (d.purpose === "GEMS") {
        gems = gemsForDeposit(d.amount, packs, productId).gems;
        await post(tx, {
          from: system(LedgerAccountType.EXTERNAL_CHAIN, Currency.SOL),
          to: system(LedgerAccountType.PREMIUM_REVENUE, Currency.SOL),
          amount: d.amount,
          type: "DEPOSIT",
          reference: d.id,
          idempotencyKey: `deposit:${d.id}`,
          userId,
          metadata: { signature: v.signature, purpose: "GEMS", gems }
        });
        await post(tx, {
          from: system(LedgerAccountType.GAME_ISSUANCE, Currency.GEMS),
          to: userWallet(userId, Currency.GEMS),
          amount: BigInt(gems),
          type: "PURCHASE",
          reference: d.id,
          idempotencyKey: `deposit-gems:${d.id}`,
          userId,
          metadata: { signature: v.signature, lamports: d.amount.toString() }
        });
        const season = await getActiveSeason(tx);
        if (season) await tx.season.update({ where: { id: season.id }, data: { revenue: { increment: d.amount } } });
      } else {
        await post(tx, {
          from: system(LedgerAccountType.EXTERNAL_CHAIN, Currency.SOL),
          to: userWallet(userId, Currency.SOL),
          amount: d.amount,
          type: "DEPOSIT",
          reference: d.id,
          idempotencyKey: `deposit:${d.id}`,
          userId,
          metadata: { signature: v.signature, purpose: "BALANCE" }
        });
      }
      const now = new Date();
      const updated = await tx.deposit.update({
        where: { id: d.id },
        data: { status: DepositStatus.CREDITED, signature: v.signature, slot: v.slot, confirmedAt: now, creditedAt: now, failureReason: null }
      });
      return { deposit: updated, gems, alreadyCredited: false };
    });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") throw new DepositError("DUPLICATE_SIGNATURE", "This transaction was already used for another deposit");
    throw err;
  }
}

/** Marks a deposit REJECTED for non-retryable verification failures and scores the attempt. */
export async function rejectDeposit(db: Db, depositId: string, userId: string, reason: string, suspicious: boolean): Promise<void> {
  await db.deposit.updateMany({
    where: { id: depositId, userId, status: { in: [DepositStatus.PREPARED, DepositStatus.SUBMITTED] } },
    data: { status: DepositStatus.REJECTED, failureReason: reason.slice(0, 500) }
  });
  if (suspicious) {
    await recordRiskSignal(db, { userId, type: CheatType.FAKE_TRANSACTION, score: 10, details: { depositId, reason }, source: "deposit" }).catch(() => undefined);
  }
}

export async function expireDeposits(db: Db, now = new Date()): Promise<number> {
  const r = await db.deposit.updateMany({ where: { status: DepositStatus.PREPARED, expiresAt: { lt: now } }, data: { status: DepositStatus.EXPIRED } });
  return r.count;
}
