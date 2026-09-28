import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Currency, LedgerAccountType } from "@nebula/shared";
import { getBalance, post, system, userWallet, verifyLedgerIntegrity, type Db } from "@nebula/database";
import { createIsolatedDb, createTestUser } from "./testing.js";
import { bootstrapTreasury, createWithdrawal, creditDeposit, prepareDeposit, updateEconomyConfig, WithdrawalError, DepositError, reviewWithdrawal } from "./index.js";

const SOL = 1_000_000_000n;
let db: Db;
let n = 0;
const addr = () => {
  // deterministic valid-looking base58 addresses (not used on chain)
  const base = "Wa11et" + (n++).toString().padStart(4, "1").replace(/0/g, "z");
  return (base + "1111111111111111111111111111111111111111").slice(0, 44);
};

async function fund(userId: string, amount: bigint): Promise<void> {
  await db.$transaction((tx) =>
    post(tx, {
      from: system(LedgerAccountType.PLAYER_REWARD_POOL, Currency.NEBX),
      to: userWallet(userId, Currency.NEBX),
      amount,
      type: "GAME_REWARD",
      reference: "test",
      idempotencyKey: `fund-${userId}-${amount}-${Math.random()}`
    })
  );
}

beforeAll(async () => {
  db = await createIsolatedDb("test_economy_withdrawals", { truncate: true });
  await bootstrapTreasury(db, { onChainBalance: 100n * SOL, slot: 1n, treasuryAddress: "Treasury1111111111111111111111111111111111" });
});
afterAll(async () => {
  await db?.$disconnect();
});

describe("withdrawals", () => {
  it("rejects insufficient balance", async () => {
    const u = await createTestUser(db, { wallet: addr() });
    await expect(createWithdrawal(db, { userId: u.id, amount: 20_000_000n, address: u.wallet as string, idempotencyKey: "k-insufficient" })).rejects.toMatchObject({ code: "INSUFFICIENT_BALANCE" });
  });

  it("is idempotent per idempotencyKey (duplicate request = same withdrawal, one hold)", async () => {
    const u = await createTestUser(db, { wallet: addr() });
    await fund(u.id, 100_000_000n);
    const a = await createWithdrawal(db, { userId: u.id, amount: 20_000_000n, address: u.wallet as string, idempotencyKey: "dup-key-1" });
    const b = await createWithdrawal(db, { userId: u.id, amount: 20_000_000n, address: u.wallet as string, idempotencyKey: "dup-key-1" });
    expect(b.withdrawalId).toBe(a.withdrawalId);
    expect(b.duplicate).toBe(true);
    expect(await db.withdrawal.count({ where: { userId: u.id } })).toBe(1);
    expect(await getBalance(db, userWallet(u.id, Currency.NEBX))).toBe(80_000_000n);
    expect(await db.chainTransaction.count({ where: { referenceId: a.withdrawalId } })).toBe(1);
  });

  it("parallel withdrawals can never overdraw", async () => {
    await updateEconomyConfig(db, "withdrawal.cooldownMinutes", 0, null, "test: disable cooldown to exercise the race");
    try {
      const u = await createTestUser(db, { wallet: addr() });
      await fund(u.id, 50_000_000n);
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, (_, i) => createWithdrawal(db, { userId: u.id, amount: 20_000_000n, address: u.wallet as string, idempotencyKey: `race-${i}` }))
      );
      const ok = results.filter((r) => r.status === "fulfilled").length;
      expect(ok).toBeLessThanOrEqual(2);
      expect(ok).toBeGreaterThanOrEqual(1);
      const bal = await getBalance(db, userWallet(u.id, Currency.NEBX));
      expect(bal).toBeGreaterThanOrEqual(0n);
      expect(bal).toBe(50_000_000n - BigInt(ok) * 20_000_000n);
      for (const r of results) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(Error);
    } finally {
      await updateEconomyConfig(db, "withdrawal.cooldownMinutes", 60, null, "restore");
    }
  });

  it("enforces cooldown, destination wallet and wallet-change lock", async () => {
    const u = await createTestUser(db, { wallet: addr() });
    await fund(u.id, 200_000_000n);
    await createWithdrawal(db, { userId: u.id, amount: 20_000_000n, address: u.wallet as string, idempotencyKey: "cd-1" });
    await expect(createWithdrawal(db, { userId: u.id, amount: 20_000_000n, address: u.wallet as string, idempotencyKey: "cd-2" })).rejects.toMatchObject({ code: "COOLDOWN" });

    const v = await createTestUser(db, { wallet: addr() });
    await fund(v.id, 200_000_000n);
    await expect(createWithdrawal(db, { userId: v.id, amount: 20_000_000n, address: addr(), idempotencyKey: "foreign" })).rejects.toMatchObject({ code: "WALLET_NOT_LINKED" });
    const newWallet = addr();
    await db.wallet.create({ data: { userId: v.id, address: newWallet, verifiedAt: new Date() } });
    const err = await createWithdrawal(db, { userId: v.id, amount: 20_000_000n, address: newWallet, idempotencyKey: "lock" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WithdrawalError);
    expect((err as WithdrawalError).errors.map((e) => e.code)).toContain("WALLET_CHANGE_LOCK");
  });

  it("large amounts go to review; rejection refunds fees and principal", async () => {
    const u = await createTestUser(db, { wallet: addr() });
    await fund(u.id, 800_000_000n);
    const w = await createWithdrawal(db, { userId: u.id, amount: 600_000_000n, address: u.wallet as string, idempotencyKey: "big-1" });
    expect(w.status).toBe("PENDING_REVIEW");
    expect(await getBalance(db, userWallet(u.id, Currency.NEBX))).toBe(200_000_000n);
    await reviewWithdrawal(db, w.withdrawalId, false, u.id, "test reject");
    expect(await getBalance(db, userWallet(u.id, Currency.NEBX))).toBe(800_000_000n);
    expect((await verifyLedgerIntegrity(db)).every((a) => a.ok)).toBe(true);
  });
});

describe("deposits (ledger side)", () => {
  it("credits once; the same chain signature can never be used twice", async () => {
    const u = await createTestUser(db, { wallet: addr() });
    const recipient = "Treasury1111111111111111111111111111111111";
    const d1 = await prepareDeposit(db, { userId: u.id, amount: 50_000_000n, purpose: "GEMS", idempotencyKey: "dep-1", recipient });
    const d2 = await prepareDeposit(db, { userId: u.id, amount: 50_000_000n, purpose: "BALANCE", idempotencyKey: "dep-2", recipient });
    expect((await prepareDeposit(db, { userId: u.id, amount: 50_000_000n, purpose: "GEMS", idempotencyKey: "dep-1", recipient })).id).toBe(d1.id);
    const sig = "5".repeat(88);
    const r1 = await creditDeposit(db, d1.id, u.id, { signature: sig, amount: 50_000_000n, sender: u.wallet as string, slot: 1n });
    expect(r1.gems).toBe(100);
    expect(await getBalance(db, userWallet(u.id, Currency.GEMS))).toBe(100n);
    const again = await creditDeposit(db, d1.id, u.id, { signature: sig, amount: 50_000_000n, sender: u.wallet as string, slot: 1n });
    expect(again.alreadyCredited).toBe(true);
    await expect(creditDeposit(db, d2.id, u.id, { signature: sig, amount: 50_000_000n, sender: u.wallet as string, slot: 1n })).rejects.toBeInstanceOf(DepositError);
    expect(await getBalance(db, userWallet(u.id, Currency.GEMS))).toBe(100n);
    expect(await getBalance(db, userWallet(u.id, Currency.SOL))).toBe(0n);
    expect(await getBalance(db, system(LedgerAccountType.PREMIUM_REVENUE, Currency.SOL))).toBeGreaterThanOrEqual(50_000_000n);
  });

  it("credits the gem grant locked at prepare time even if the shop changes after payment", async () => {
    const u = await createTestUser(db, { wallet: addr() });
    const recipient = "Treasury1111111111111111111111111111111111";
    const d = await prepareDeposit(db, { userId: u.id, amount: 50_000_000n, purpose: "GEMS", idempotencyKey: "dep-locked", recipient });
    expect(d.gems).toBe(100);
    // Admin reprices: a DB pack at the same price now grants far more gems (DB rows override shop.json).
    const id = "test-gems-reprice";
    await db.shopProduct.create({
      data: { id, sku: id, name: "Repriced", category: "GEMS", description: "test", currency: Currency.SOL, price: 50_000_000n, grants: { gems: 999 } }
    });
    try {
      const r = await creditDeposit(db, d.id, u.id, { signature: "6".repeat(88), amount: 50_000_000n, sender: u.wallet as string, slot: 2n });
      expect(r.gems).toBe(100);
      expect(await getBalance(db, userWallet(u.id, Currency.GEMS))).toBe(100n);
    } finally {
      await db.shopProduct.delete({ where: { id } });
    }
  });
});
