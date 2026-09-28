import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { Redis } from "ioredis";
import { Currency, LedgerAccountType } from "@nebula/shared";
import { getBalance, post, system, userWallet, verifyLedgerIntegrity, type Db } from "@nebula/database";
import { bootstrapTreasury, createWithdrawal, withdrawalMemo } from "@nebula/economy";
import { createIsolatedDb, createTestUser } from "@nebula/economy/testing";
import { sendSolWithMemo, type SolanaRpcClient } from "@nebula/blockchain";
import { createMockSolanaRpc, type MockChainState } from "@nebula/blockchain/testing";
import { processWithdrawal, type ProcessorDeps } from "./processor.js";
import { createWithdrawalQueue, createWithdrawalWorker, enqueueWithdrawal, recoverQueue } from "./queue.js";

const SOL = 1_000_000_000n;
let db: Db;
let treasury: KeyPairSigner;

beforeAll(async () => {
  db = await createIsolatedDb("test_blockchain_service", { truncate: true });
  treasury = await generateKeyPairSigner();
  await bootstrapTreasury(db, { onChainBalance: 100n * SOL, slot: 1n, treasuryAddress: treasury.address });
});
afterAll(async () => {
  await db?.$disconnect();
});

function chain(): { rpc: SolanaRpcClient; state: MockChainState } {
  return createMockSolanaRpc({ balances: { [treasury.address]: 100n * SOL } });
}

function deps(rpc: SolanaRpcClient, over: Partial<ProcessorDeps> = {}): ProcessorDeps {
  return {
    db,
    rpc,
    getSigner: async () => treasury,
    treasuryAddress: treasury.address,
    mint: null,
    mintDecimals: 9,
    maxAttempts: 3,
    backoffBaseMs: 1,
    confirmPollMs: 1,
    inlineConfirmMs: 5,
    ...over
  };
}

async function newWithdrawal(amount = 20_000_000n): Promise<{ id: string; userId: string; wallet: string; player: Awaited<ReturnType<typeof generateKeyPairSigner>> }> {
  const player = await generateKeyPairSigner();
  const u = await createTestUser(db, { wallet: player.address });
  await db.$transaction((tx) =>
    post(tx, {
      from: system(LedgerAccountType.PLAYER_REWARD_POOL, Currency.NEBX),
      to: userWallet(u.id, Currency.NEBX),
      amount: 100_000_000n,
      type: "GAME_REWARD",
      reference: "test",
      idempotencyKey: `fund-${u.id}`
    })
  );
  const w = await createWithdrawal(db, { userId: u.id, amount, address: player.address, idempotencyKey: `wd-${u.id}` });
  expect(w.status).toBe("PENDING");
  return { id: w.withdrawalId, userId: u.id, wallet: player.address, player };
}

async function runUntilDone(d: ProcessorDeps, id: string, max = 20): Promise<string> {
  for (let i = 0; i < max; i++) {
    const r = await processWithdrawal(d, id);
    if (r.done) return r.status;
    await new Promise((res) => setTimeout(res, Math.min(r.retryInMs, 5)));
  }
  return "NOT_DONE";
}

const transfersTo = (state: MockChainState, addr: string) =>
  [...state.txs.values()].filter((t) => !t.err && t.transfers.some((tr) => tr.destination === addr));

describe("withdrawal payout pipeline", () => {
  it("completes only after on-chain confirmation and settles the ledger", async () => {
    const { rpc, state } = chain();
    const w = await newWithdrawal();
    const reserveBefore = await getBalance(db, system(LedgerAccountType.WITHDRAWAL_RESERVE, Currency.NEBX));
    expect(await runUntilDone(deps(rpc), w.id)).toBe("COMPLETED");
    const row = await db.withdrawal.findUniqueOrThrow({ where: { id: w.id } });
    expect(row.chainState).toBe("CONFIRMED");
    expect(row.signature).toBeTruthy();
    expect(state.txs.get(row.signature as string)?.memo).toBe(withdrawalMemo(w.id));
    expect(state.balances.get(w.wallet)).toBe(row.final);
    expect(await getBalance(db, system(LedgerAccountType.WITHDRAWAL_RESERVE, Currency.NEBX))).toBe(reserveBefore - row.final - row.networkFee);
    expect((await db.chainTransaction.findUniqueOrThrow({ where: { referenceId: w.id } })).state).toBe("CONFIRMED");
    expect((await verifyLedgerIntegrity(db)).every((a) => a.ok)).toBe(true);
  });

  it("never marks COMPLETED while the tx is unconfirmed", async () => {
    const { rpc, state } = chain();
    state.commitment = "processed";
    const w = await newWithdrawal();
    const d = deps(rpc);
    for (let i = 0; i < 5; i++) {
      const r = await processWithdrawal(d, w.id);
      expect(r.done).toBe(false);
    }
    let row = await db.withdrawal.findUniqueOrThrow({ where: { id: w.id } });
    expect(row.status).toBe("PROCESSING");
    expect(row.chainState).toBe("CONFIRMING");
    expect(await db.balanceLedger.count({ where: { idempotencyKey: `wd-settle:${w.id}` } })).toBe(0);
    // Chain confirms → next step completes.
    const tx = state.txs.get(row.signature as string);
    if (tx) tx.confirmationStatus = "confirmed";
    expect(await runUntilDone(d, w.id)).toBe("COMPLETED");
    row = await db.withdrawal.findUniqueOrThrow({ where: { id: w.id } });
    expect(row.completedAt).not.toBeNull();
    expect(transfersTo(state, w.wallet).length).toBe(1);
  });

  it("signature is saved before broadcast: a crash/error after sending never double pays", async () => {
    const { rpc, state } = chain();
    state.sendQueue.push("land-then-throw");
    const w = await newWithdrawal();
    expect(await runUntilDone(deps(rpc), w.id)).toBe("COMPLETED");
    expect(transfersTo(state, w.wallet).length).toBe(1);
  });

  it("expired (dropped) tx is retried with backoff only after the blockhash expired", async () => {
    const { rpc, state } = chain();
    state.sendQueue.push("drop");
    const w = await newWithdrawal();
    const d = deps(rpc);
    const r1 = await processWithdrawal(d, w.id);
    expect(r1.done).toBe(false);
    // Still valid blockhash → keeps waiting, does NOT resubmit.
    const r2 = await processWithdrawal(d, w.id);
    expect(r2.done).toBe(false);
    expect((await db.withdrawal.findUniqueOrThrow({ where: { id: w.id } })).attempts).toBe(1);
    state.advance(500); // blockhash expires
    expect(await runUntilDone(d, w.id)).toBe("COMPLETED");
    const row = await db.withdrawal.findUniqueOrThrow({ where: { id: w.id } });
    expect(row.attempts).toBe(2);
    expect(transfersTo(state, w.wallet).length).toBe(1);
  });

  it("adopts an existing on-chain payout found by memo instead of paying again", async () => {
    const { rpc, state } = chain();
    const w = await newWithdrawal();
    const row = await db.withdrawal.findUniqueOrThrow({ where: { id: w.id } });
    // Simulate: payout landed but the DB lost the signature (e.g. restored backup).
    await sendSolWithMemo({ rpc, signer: treasury, destination: w.wallet, amount: row.final, memo: withdrawalMemo(w.id) });
    expect(await runUntilDone(deps(rpc), w.id)).toBe("COMPLETED");
    expect(transfersTo(state, w.wallet).length).toBe(1);
  });

  it("never adopts a spoofed inbound tx carrying the withdrawal memo; pays out for real without blaming the player", async () => {
    const { rpc, state } = chain();
    const w = await newWithdrawal();
    const row = await db.withdrawal.findUniqueOrThrow({ where: { id: w.id } });
    // Attacker (knows the withdrawal id → memo) sends the treasury a tx carrying the payout memo.
    const attacker = await generateKeyPairSigner();
    state.balances.set(attacker.address, SOL);
    const spoof = await sendSolWithMemo({ rpc, signer: attacker, destination: treasury.address, amount: row.final, memo: withdrawalMemo(w.id) });
    expect(spoof.status).toBe("CONFIRMED");
    expect(await runUntilDone(deps(rpc), w.id)).toBe("COMPLETED");
    const done = await db.withdrawal.findUniqueOrThrow({ where: { id: w.id } });
    expect(done.signature).not.toBe(spoof.signature);
    const payouts = transfersTo(state, w.wallet);
    expect(payouts.length).toBe(1);
    expect(payouts[0]?.transfers.some((t) => t.source === treasury.address && t.destination === w.wallet)).toBe(true);
    expect(state.balances.get(w.wallet)).toBe(row.final);
    // A third party's spoof must not raise the victim's risk score.
    const signals = await db.riskSignal.findMany({ where: { userId: w.userId, type: "FAKE_TRANSACTION", source: "withdrawal" } });
    expect(signals).toHaveLength(0);
  });

  it("a spoof paid by the player's own linked wallet is flagged exactly once", async () => {
    const { rpc, state } = chain();
    const w = await newWithdrawal();
    const row = await db.withdrawal.findUniqueOrThrow({ where: { id: w.id } });
    state.balances.set(w.wallet, SOL);
    const spoof = await sendSolWithMemo({ rpc, signer: w.player, destination: treasury.address, amount: row.final, memo: withdrawalMemo(w.id) });
    expect(spoof.status).toBe("CONFIRMED");
    expect(await runUntilDone(deps(rpc), w.id)).toBe("COMPLETED");
    const signals = await db.riskSignal.findMany({ where: { userId: w.userId, type: "FAKE_TRANSACTION", source: "withdrawal" } });
    expect(signals).toHaveLength(1);
    expect((signals[0]?.details as { signature?: string }).signature).toBe(spoof.signature);
  });

  it("max attempts → FAILED with a compensating refund (never COMPLETED)", async () => {
    const { rpc, state } = chain();
    state.sendQueue.push("fail", "fail", "fail");
    const w = await newWithdrawal();
    const before = 100_000_000n;
    expect(await runUntilDone(deps(rpc, { maxAttempts: 3 }), w.id)).toBe("FAILED");
    const row = await db.withdrawal.findUniqueOrThrow({ where: { id: w.id } });
    expect(row.status).toBe("FAILED");
    expect(row.completedAt).toBeNull();
    expect(await getBalance(db, userWallet(w.userId, Currency.NEBX))).toBe(before);
    expect(transfersTo(state, w.wallet).length).toBe(0);
    expect((await verifyLedgerIntegrity(db)).every((a) => a.ok)).toBe(true);
  });

  it("routes to manual review when the WITHDRAWAL_REVIEW breaker is on", async () => {
    const { rpc } = chain();
    const w = await newWithdrawal();
    await db.circuitBreaker.update({ where: { mode: "WITHDRAWAL_REVIEW" }, data: { active: true } });
    try {
      expect(await runUntilDone(deps(rpc), w.id)).toBe("PENDING_REVIEW");
    } finally {
      await db.circuitBreaker.update({ where: { mode: "WITHDRAWAL_REVIEW" }, data: { active: false } });
    }
  });
});

describe("queue recovery after restart", () => {
  it("re-enqueues durable CREATED/QUEUED/SUBMITTED/... withdrawals after Redis loses the queue", async () => {
    const connection = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: null });
    const name = `test-wd-${Date.now()}`;
    const queue = createWithdrawalQueue(connection, name);
    try {
      // Only this test's rows should be pending in the sandbox.
      await db.withdrawal.updateMany({ where: { status: { in: ["PENDING", "PROCESSING"] } }, data: { status: "CANCELLED" } });
      const a = await newWithdrawal();
      const b = await newWithdrawal();
      await db.withdrawal.update({ where: { id: b.id }, data: { status: "PROCESSING", chainState: "QUEUED" } });
      await enqueueWithdrawal(queue, a.id);
      await enqueueWithdrawal(queue, a.id); // dedup
      expect((await queue.getJobCounts("waiting")).waiting).toBe(1);
      // Redis loss / restart
      await queue.obliterate({ force: true });
      expect((await queue.getJobCounts("waiting")).waiting).toBe(0);
      expect(await recoverQueue(db, queue)).toBe(2);
      await recoverQueue(db, queue); // idempotent
      expect((await queue.getJobCounts("waiting")).waiting).toBe(2);
      // A worker drains the recovered jobs against the (mock) chain.
      const { rpc } = chain();
      const worker = createWithdrawalWorker(connection, deps(rpc), { name, concurrency: 2 });
      const deadline = Date.now() + 20_000;
      for (;;) {
        const rows = await db.withdrawal.findMany({ where: { id: { in: [a.id, b.id] } } });
        if (rows.every((r) => r.status === "COMPLETED")) break;
        if (Date.now() > deadline) throw new Error(`not completed: ${rows.map((r) => `${r.status}/${r.chainState}`).join(",")}`);
        await new Promise((r) => setTimeout(r, 100));
      }
      await worker.close();
    } finally {
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close();
      await connection.quit();
    }
  });
});
