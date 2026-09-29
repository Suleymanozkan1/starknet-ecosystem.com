import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Currency, LedgerAccountType } from "@nebula/shared";
import { getBalance, post, system, userWallet, withSerializableTx, type Db } from "@nebula/database";
import { createIsolatedDb, createTestUser } from "./testing.js";
import { bootstrapTreasury } from "./bootstrap.js";

const SOL = 1_000_000_000n;
const TREASURY = "Treasury1111111111111111111111111111111111";
let db: Db;

beforeAll(async () => {
  db = await createIsolatedDb("test_economy_bootstrap", { truncate: true });
  // Accounts + season exist; nothing funded yet (chain holds nothing).
  await bootstrapTreasury(db, { onChainBalance: 0n, slot: 1n, treasuryAddress: TREASURY });
  // A player deposited 5 SOL: the ledger now owes 5 SOL of lamports held by the treasury.
  const u = await createTestUser(db);
  await withSerializableTx(db, (tx) => post(tx, { from: system(LedgerAccountType.EXTERNAL_CHAIN, Currency.SOL), to: userWallet(u.id, Currency.SOL), amount: 5n * SOL, type: "DEPOSIT", reference: "dep-1", idempotencyKey: "dep-1", userId: u.id }));
});
afterAll(async () => {
  await db?.$disconnect();
});

describe("bootstrapTreasury asset separation", () => {
  it("SPL mode: SOL deposits never back NEBX; NEBX is funded only from the reward-token balance", async () => {
    const none = await bootstrapTreasury(db, { onChainBalance: 5n * SOL + 20_000_000n, rewardTokenBalance: 0n, slot: 2n, treasuryAddress: TREASURY });
    expect(none.funded).toBe(0n);
    expect(await getBalance(db, system(LedgerAccountType.TREASURY, Currency.NEBX))).toBe(0n);

    const funded = await bootstrapTreasury(db, { onChainBalance: 5n * SOL + 20_000_000n, rewardTokenBalance: 1_000n, slot: 3n, treasuryAddress: TREASURY });
    expect(funded.funded).toBe(1_000n);
    expect(funded.warnings).toHaveLength(0);
  });

  it("SPL mode: a lamport shortfall against SOL deposits is reported, not hidden by token funds", async () => {
    const r = await bootstrapTreasury(db, { onChainBalance: 1n * SOL, rewardTokenBalance: 1_000n, slot: 4n, treasuryAddress: TREASURY });
    expect(r.funded).toBe(0n); // tokens already accounted at slot 3
    expect(r.warnings.some((w) => w.startsWith("SOL:"))).toBe(true);
  });
});
