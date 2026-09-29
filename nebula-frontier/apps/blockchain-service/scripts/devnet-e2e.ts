/**
 * REAL end-to-end test of the chain flows:
 *   1. player wallet → treasury deposit (SOL transfer + memo), verified with verifyDepositTransaction
 *      and credited to the ledger;
 *   2. treasury bootstrap from the real on-chain balance;
 *   3. Battle Reward grant + claim (policy-limited), then a withdrawal request;
 *   4. payout executed by the blockchain-service processor (sign → persist → send → confirm → settle).
 *
 * Modes:
 *   devnet (default): real devnet RPC, keys from .secrets/ + TREASURY_SECRET, public DB schema.
 *   --mock:           same code path against the in-process mock RPC and an isolated DB schema
 *                     (fallback when the devnet faucet is rate-limited).
 *
 *   SERVICE_ROLE=blockchain npx tsx --env-file=../../.env scripts/devnet-e2e.ts [--mock]
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createKeyPairSignerFromBytes, generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { Currency, LedgerAccountType } from "@nebula/shared";
import { createDb, getBalance, post, system, userWallet, verifyLedgerIntegrity, type Db } from "@nebula/database";
import {
  buildAndSendPayout,
  createRpcFromEnv,
  explorerUrl,
  getSolanaNetwork,
  loadTreasurySigner,
  sendSolWithMemo,
  verifyDepositTransaction,
  type SolanaRpcClient
} from "@nebula/blockchain";
import { bootstrapTreasury, claimReward, createWithdrawal, creditDeposit, grantCryptoReward, loadEconomyConfig, prepareDeposit } from "@nebula/economy";
import { createIsolatedDb } from "@nebula/economy/testing";
import { processWithdrawal } from "../src/processor.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SOL = 1_000_000_000n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function loadKeypair(file: string): Promise<KeyPairSigner> {
  if (!existsSync(file)) throw new Error(`${file} missing — run scripts/devnet-setup.ts first`);
  return createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(file, "utf8")) as number[]));
}

async function balance(rpc: SolanaRpcClient, addr: string): Promise<bigint> {
  return (await rpc.getBalance(addr as Parameters<SolanaRpcClient["getBalance"]>[0], { commitment: "confirmed" }).send()).value;
}

export interface E2eResult {
  mode: "devnet" | "mock";
  treasury: string;
  player: string;
  deposit: { signature: string; explorerUrl: string; amount: string; verified: boolean; rejectedReplay: string };
  payout: { withdrawalId: string; signature: string; explorerUrl: string; final: string; status: string };
  ledgerIntegrity: boolean;
}

export async function main(argv = process.argv): Promise<E2eResult> {
  const mock = argv.includes("--mock");
  process.env.SERVICE_ROLE = "blockchain"; // this script IS blockchain-service tooling
  let rpc: SolanaRpcClient;
  let treasury: KeyPairSigner;
  let player: KeyPairSigner;
  let db: Db;
  if (mock) {
    treasury = await generateKeyPairSigner();
    player = await generateKeyPairSigner();
    // Test-only mock RPC (no signature verification): loaded lazily and only in --mock mode.
    const { createMockSolanaRpc } = await import("@nebula/blockchain/testing");
    rpc = createMockSolanaRpc({ balances: { [treasury.address]: 2n * SOL } }).rpc;
    db = await createIsolatedDb("e2e_mock", { truncate: true });
  } else {
    if (getSolanaNetwork() !== "devnet") throw new Error("devnet-e2e runs on devnet only");
    rpc = createRpcFromEnv();
    treasury = (await loadTreasurySigner()) as KeyPairSigner;
    player = await loadKeypair(resolve(ROOT, ".secrets/player-devnet.json"));
    db = createDb();
  }
  const network = mock ? "localnet" : "devnet";
  const url = (s: string) => (mock ? `(mock) ${s}` : explorerUrl(s, network));
  console.info(`[e2e] mode=${mock ? "mock" : "devnet"} treasury=${treasury.address} player=${player.address}`);

  try {
    // ---- 0. balances / funding of the player wallet from the treasury
    const tBal = await balance(rpc, treasury.address);
    console.info(`[e2e] treasury balance ${tBal} lamports`);
    if (tBal < 60_000_000n) throw new Error(`Treasury underfunded (${tBal} lamports). Devnet faucet may be rate-limited; retry scripts/devnet-setup.ts later or use --mock.`);
    if ((await balance(rpc, player.address)) < 15_000_000n) {
      const f = await buildAndSendPayout({ rpc, signer: treasury, destination: player.address, amount: 20_000_000n, memo: "nebula:fund-test-player", confirmTimeoutMs: 60_000 });
      console.info(`[e2e] funded player wallet: ${f.status} ${url(f.signature)}`);
      if (f.status !== "CONFIRMED") throw new Error("player funding not confirmed");
    }

    // ---- 1. test user with the player wallet linked (eligible for rewards/withdrawals)
    const createdAt = new Date(Date.now() - 5 * 86_400_000);
    const user = await db.user.create({
      data: { username: `e2e_${Date.now().toString(36)}`, createdAt, playtimeSeconds: 4n * 3600n, matchesPlayed: 25, riskLevel: "LOW" }
    });
    const existingWallet = await db.wallet.findUnique({ where: { address: player.address } });
    if (existingWallet) await db.wallet.update({ where: { id: existingWallet.id }, data: { userId: user.id, primary: true, unlinkedAt: null, verifiedAt: createdAt } });
    else await db.wallet.create({ data: { userId: user.id, address: player.address, primary: true, verifiedAt: createdAt } });

    // ---- 2. deposit: prepare → real transfer with memo → verify → credit
    const dep = await prepareDeposit(db, { userId: user.id, amount: 10_000_000n, purpose: "BALANCE", idempotencyKey: `e2e-dep-${user.id}`, recipient: treasury.address });
    const sent = await sendSolWithMemo({ rpc, signer: player, destination: treasury.address, amount: dep.amount, memo: dep.memo, confirmTimeoutMs: 60_000 });
    console.info(`[e2e] deposit tx ${sent.status}: ${url(sent.signature)}`);
    let verified = await verifyDepositTransaction(rpc, { signature: sent.signature, expectedRecipient: treasury.address, expectedAmount: dep.amount, memo: dep.memo, expectedSender: player.address, network: mock ? "devnet" : "devnet" });
    for (let i = 0; i < 20 && !verified.ok && verified.retryable; i++) {
      await sleep(2000);
      verified = await verifyDepositTransaction(rpc, { signature: sent.signature, expectedRecipient: treasury.address, expectedAmount: dep.amount, memo: dep.memo, expectedSender: player.address });
    }
    if (!verified.ok) throw new Error(`deposit verification failed: ${verified.reason} ${verified.message}`);
    await creditDeposit(db, dep.id, user.id, { signature: verified.signature, amount: verified.amount, sender: verified.sender, slot: verified.slot });
    // Replay protection: the same signature against a second prepared deposit (different memo) is rejected.
    const dep2 = await prepareDeposit(db, { userId: user.id, amount: 10_000_000n, purpose: "BALANCE", idempotencyKey: `e2e-dep2-${user.id}`, recipient: treasury.address });
    const replay = await verifyDepositTransaction(rpc, { signature: sent.signature, expectedRecipient: treasury.address, expectedAmount: dep2.amount, memo: dep2.memo, expectedSender: player.address });
    const rejectedReplay = replay.ok ? "NOT REJECTED (bug)" : replay.reason;
    console.info(`[e2e] deposit verified & credited (${verified.amount} lamports); replay → ${rejectedReplay}`);

    // ---- 3. bootstrap reward pool from the real treasury balance; grant + claim a reward
    const onChain = await rpc.getBalance(treasury.address, { commitment: "confirmed" }).send();
    const boot = await bootstrapTreasury(db, { onChainBalance: onChain.value, slot: onChain.context.slot, treasuryAddress: treasury.address });
    console.info(`[e2e] bootstrap funded ${boot.funded} lamports (accounted before: ${boot.accounted})`);
    const g = await grantCryptoReward(db, { userId: user.id, source: "TOURNAMENT", sourceRef: `e2e-${user.id}`, weight: 100, reason: "Tournament Reward (e2e)", mode: "ARENA" });
    console.info(`[e2e] reward grant: ${g.status} ${g.amount} lamports ${g.reasons.join("; ")}`);
    if (g.rewardId && g.status === "GRANTED") await claimReward(db, user.id, g.rewardId);
    const cfg = await loadEconomyConfig(db);
    const min = cfg.withdrawal.min;
    const have = await getBalance(db, userWallet(user.id, Currency.NEBX));
    if (have < min) {
      // The emission policy caps a single day's reward far below the withdrawal minimum on a small
      // devnet treasury; top up from the (real-funds-backed) reward pool with an audited adjustment.
      await db.$transaction(async (tx) => {
        await post(tx, {
          from: system(LedgerAccountType.PLAYER_REWARD_POOL, Currency.NEBX),
          to: userWallet(user.id, Currency.NEBX),
          amount: min - have,
          type: "ADMIN_ADJUSTMENT",
          reference: user.id,
          idempotencyKey: `e2e-topup-${user.id}`,
          userId: user.id,
          metadata: { reason: "devnet e2e test top-up to withdrawal minimum" }
        });
        await tx.auditLog.create({ data: { actorType: "SYSTEM", action: "E2E_TEST_TOPUP", targetType: "User", targetId: user.id, newValue: { amount: (min - have).toString() }, reason: "devnet e2e" } });
      });
    }

    // ---- 4. withdrawal → blockchain-service processor → on-chain payout
    const w = await createWithdrawal(db, { userId: user.id, amount: min, address: player.address, idempotencyKey: `e2e-wd-${user.id}` });
    console.info(`[e2e] withdrawal ${w.withdrawalId} ${w.status} final=${w.quote.final}`);
    const deps = {
      db,
      rpc,
      getSigner: async () => treasury,
      treasuryAddress: treasury.address,
      mint: null,
      mintDecimals: 9,
      maxAttempts: 5,
      backoffBaseMs: 5_000,
      confirmPollMs: 2_000,
      inlineConfirmMs: 30_000
    };
    let status = "";
    for (let i = 0; i < 60; i++) {
      const r = await processWithdrawal(deps, w.withdrawalId);
      status = r.status;
      if (r.done) break;
      await sleep(Math.min(r.retryInMs, 5_000));
    }
    const row = await db.withdrawal.findUniqueOrThrow({ where: { id: w.withdrawalId } });
    if (row.status !== "COMPLETED" || !row.signature) throw new Error(`payout not completed: ${row.status}/${row.chainState} ${row.failureReason ?? ""}`);
    console.info(`[e2e] payout ${status}: ${url(row.signature)}`);
    const integrity = (await verifyLedgerIntegrity(db)).every((a) => a.ok);
    const result: E2eResult = {
      mode: mock ? "mock" : "devnet",
      treasury: treasury.address,
      player: player.address,
      deposit: { signature: sent.signature, explorerUrl: url(sent.signature), amount: dep.amount.toString(), verified: true, rejectedReplay },
      payout: { withdrawalId: row.id, signature: row.signature, explorerUrl: url(row.signature), final: row.final.toString(), status: row.status },
      ledgerIntegrity: integrity
    };
    console.info(JSON.stringify(result, null, 2));
    return result;
  } finally {
    await db.$disconnect();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: Error) => {
    console.error(`[e2e] FAILED: ${err.message}`);
    process.exit(1);
  });
}
