/**
 * Client for the on-chain `nebula_settlement` program (programs/nebula_settlement, devnet).
 *
 * `verify_reward(reward_id, amount)` pays a verified reward from the program vault. The reward signer
 * (config.reward_signer = the treasury key held by apps/blockchain-service) must co-sign, and the
 * receipt PDA `["reward", reward_id]` can only be created once — a second payout for the same
 * reward id fails on chain. Emission is additionally capped per claim and per epoch by the program.
 *
 * Instruction layouts / discriminators come from programs/target/idl/nebula_settlement.json.
 */
import {
  AccountRole,
  address as toAddress,
  appendTransactionMessageInstructions,
  assertIsSendableTransaction,
  assertIsTransactionWithBlockhashLifetime,
  createTransactionMessage,
  getAddressDecoder,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type TransactionSigner
} from "@solana/kit";
import { getAddMemoInstruction } from "@solana-program/memo";
import type { SolanaRpcClient } from "./rpc.js";
import { DepositRejection, SPL_MEMO_PROGRAM_ID, SYSTEM_PROGRAM_ID, verifyDepositTransaction, type VerifyDepositResult } from "./deposit.js";
import { waitForConfirmation, type ConfirmationOutcome, type PayoutInput } from "./transfer.js";

/** Program deployed on devnet (see docs/BLOCKCHAIN.md). Override with SETTLEMENT_PROGRAM_ID. */
export const DEFAULT_SETTLEMENT_PROGRAM_ID = "DvgysAhNTnrBjGxo7qXd8QpvP1XNpJvkfXqjwzqTQohL";

export const SETTLEMENT_DISCRIMINATORS = {
  fundVault: [26, 33, 207, 242, 119, 108, 134, 73],
  verifyReward: [162, 149, 201, 213, 204, 64, 202, 201],
  configAccount: [155, 12, 170, 224, 30, 250, 204, 130],
  receiptAccount: [116, 154, 221, 22, 195, 73, 132, 89]
} as const;

/** Account sizes (8-byte discriminator + fields), matching `#[derive(InitSpace)]` in lib.rs. */
export const SETTLEMENT_CONFIG_SIZE = 8 + 32 * 3 + 2 + 8 * 5 + 1 + 1 + 1;
export const SETTLEMENT_RECEIPT_SIZE = 8 + 32 + 32 + 8 + 8 + 1;

export interface SettlementPdas {
  programId: Address;
  config: Address;
  vault: Address;
}

export async function getSettlementPdas(programId: string = DEFAULT_SETTLEMENT_PROGRAM_ID): Promise<SettlementPdas> {
  const program = toAddress(programId);
  const [config] = await getProgramDerivedAddress({ programAddress: program, seeds: ["config"] });
  const [vault] = await getProgramDerivedAddress({ programAddress: program, seeds: ["vault"] });
  return { programId: program, config, vault };
}

export async function getRewardReceiptPda(programId: string, rewardId: Uint8Array): Promise<Address> {
  if (rewardId.length !== 32) throw new Error("reward id must be 32 bytes");
  const [receipt] = await getProgramDerivedAddress({ programAddress: toAddress(programId), seeds: ["reward", rewardId] });
  return receipt;
}

/** Deterministic 32-byte reward id for an off-chain record (e.g. a withdrawal id): sha256("nf-reward:" + id). */
export async function rewardIdFor(referenceId: string): Promise<Uint8Array> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(`nf-reward:${referenceId}`));
  return new Uint8Array(digest);
}

function u64(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
}

export function buildVerifyRewardInstruction(input: {
  pdas: SettlementPdas;
  payer: TransactionSigner;
  rewardSigner: TransactionSigner;
  receipt: Address;
  player: string;
  rewardId: Uint8Array;
  amount: bigint;
}): Instruction {
  if (input.amount <= 0n) throw new Error("Reward amount must be positive");
  if (input.rewardId.length !== 32) throw new Error("reward id must be 32 bytes");
  const data = new Uint8Array(8 + 32 + 8);
  data.set(SETTLEMENT_DISCRIMINATORS.verifyReward, 0);
  data.set(input.rewardId, 8);
  data.set(u64(input.amount), 40);
  const same = input.payer.address === input.rewardSigner.address;
  return {
    programAddress: input.pdas.programId,
    data,
    accounts: [
      { address: input.payer.address, role: AccountRole.WRITABLE_SIGNER, signer: input.payer },
      // payer and reward signer may be the same key; the runtime merges duplicate metas.
      { address: input.rewardSigner.address, role: same ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER, signer: input.rewardSigner },
      { address: input.pdas.config, role: AccountRole.WRITABLE },
      { address: input.pdas.vault, role: AccountRole.WRITABLE },
      { address: input.receipt, role: AccountRole.WRITABLE },
      { address: toAddress(input.player), role: AccountRole.WRITABLE },
      { address: toAddress(SYSTEM_PROGRAM_ID), role: AccountRole.READONLY }
    ]
  } as Instruction;
}

export function buildFundVaultInstruction(input: { pdas: SettlementPdas; funder: TransactionSigner; amount: bigint }): Instruction {
  if (input.amount <= 0n) throw new Error("Funding amount must be positive");
  const data = new Uint8Array(16);
  data.set(SETTLEMENT_DISCRIMINATORS.fundVault, 0);
  data.set(u64(input.amount), 8);
  return {
    programAddress: input.pdas.programId,
    data,
    accounts: [
      { address: input.funder.address, role: AccountRole.WRITABLE_SIGNER, signer: input.funder },
      { address: input.pdas.config, role: AccountRole.READONLY },
      { address: input.pdas.vault, role: AccountRole.WRITABLE },
      { address: toAddress(SYSTEM_PROGRAM_ID), role: AccountRole.READONLY }
    ]
  } as Instruction;
}

export interface SettlementConfig {
  authority: string;
  pendingAuthority: string;
  rewardSigner: string;
  feeBps: number;
  maxRewardPerClaim: bigint;
  maxEmissionPerEpoch: bigint;
  epochDurationSecs: bigint;
  epochStart: bigint;
  epochEmitted: bigint;
  paused: boolean;
  bump: number;
  vaultBump: number;
}

function hasDiscriminator(buf: Uint8Array, disc: readonly number[]): boolean {
  return disc.every((b, i) => buf[i] === b);
}

export function decodeSettlementConfig(buf: Uint8Array): SettlementConfig {
  if (buf.length < SETTLEMENT_CONFIG_SIZE || !hasDiscriminator(buf, SETTLEMENT_DISCRIMINATORS.configAccount)) throw new Error("Not a settlement Config account");
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const dec = getAddressDecoder();
  return {
    authority: dec.decode(buf.subarray(8, 40)),
    pendingAuthority: dec.decode(buf.subarray(40, 72)),
    rewardSigner: dec.decode(buf.subarray(72, 104)),
    feeBps: dv.getUint16(104, true),
    maxRewardPerClaim: dv.getBigUint64(106, true),
    maxEmissionPerEpoch: dv.getBigUint64(114, true),
    epochDurationSecs: dv.getBigInt64(122, true),
    epochStart: dv.getBigInt64(130, true),
    epochEmitted: dv.getBigUint64(138, true),
    paused: buf[146] === 1,
    bump: buf[147] ?? 0,
    vaultBump: buf[148] ?? 0
  };
}

/** Inverse of decodeSettlementConfig (used by tests and the mock RPC). */
export function encodeSettlementConfig(c: SettlementConfig): Uint8Array {
  const buf = new Uint8Array(SETTLEMENT_CONFIG_SIZE);
  const dv = new DataView(buf.buffer);
  const enc = getAddressEncoder();
  buf.set(SETTLEMENT_DISCRIMINATORS.configAccount, 0);
  buf.set(enc.encode(toAddress(c.authority)), 8);
  buf.set(enc.encode(toAddress(c.pendingAuthority)), 40);
  buf.set(enc.encode(toAddress(c.rewardSigner)), 72);
  dv.setUint16(104, c.feeBps, true);
  dv.setBigUint64(106, c.maxRewardPerClaim, true);
  dv.setBigUint64(114, c.maxEmissionPerEpoch, true);
  dv.setBigInt64(122, c.epochDurationSecs, true);
  dv.setBigInt64(130, c.epochStart, true);
  dv.setBigUint64(138, c.epochEmitted, true);
  buf[146] = c.paused ? 1 : 0;
  buf[147] = c.bump;
  buf[148] = c.vaultBump;
  return buf;
}

export interface RewardReceipt {
  rewardId: Uint8Array;
  player: string;
  amount: bigint;
  claimedAt: bigint;
}

export function decodeRewardReceipt(buf: Uint8Array): RewardReceipt {
  if (buf.length < SETTLEMENT_RECEIPT_SIZE || !hasDiscriminator(buf, SETTLEMENT_DISCRIMINATORS.receiptAccount)) throw new Error("Not a settlement RewardReceipt account");
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return {
    rewardId: buf.slice(8, 40),
    player: getAddressDecoder().decode(buf.subarray(40, 72)),
    amount: dv.getBigUint64(72, true),
    claimedAt: dv.getBigInt64(80, true)
  };
}

export function encodeRewardReceipt(r: RewardReceipt, bump = 255): Uint8Array {
  const buf = new Uint8Array(SETTLEMENT_RECEIPT_SIZE);
  const dv = new DataView(buf.buffer);
  buf.set(SETTLEMENT_DISCRIMINATORS.receiptAccount, 0);
  buf.set(r.rewardId, 8);
  buf.set(getAddressEncoder().encode(toAddress(r.player)), 40);
  dv.setBigUint64(72, r.amount, true);
  dv.setBigInt64(80, r.claimedAt, true);
  buf[88] = bump;
  return buf;
}

async function fetchProgramAccount(rpc: SolanaRpcClient, account: Address, programId: Address): Promise<{ data: Uint8Array; lamports: bigint } | null> {
  const { value } = await rpc.getAccountInfo(account, { encoding: "base64", commitment: "confirmed" }).send();
  if (!value) return null;
  if (value.owner !== programId) throw new Error(`Account ${account} is not owned by the settlement program`);
  return { data: new Uint8Array(getBase64Encoder().encode(value.data[0])), lamports: BigInt(value.lamports) };
}

export async function fetchSettlementConfig(rpc: SolanaRpcClient, pdas: SettlementPdas): Promise<SettlementConfig | null> {
  const acc = await fetchProgramAccount(rpc, pdas.config, pdas.programId);
  return acc ? decodeSettlementConfig(acc.data) : null;
}

export async function fetchRewardReceipt(rpc: SolanaRpcClient, programId: string, rewardId: Uint8Array): Promise<RewardReceipt | null> {
  const receipt = await getRewardReceiptPda(programId, rewardId);
  const acc = await fetchProgramAccount(rpc, receipt, toAddress(programId));
  return acc ? decodeRewardReceipt(acc.data) : null;
}

/** Lamports the vault can pay out (balance above its rent-exempt floor). */
export async function getVaultAvailable(rpc: SolanaRpcClient, pdas: SettlementPdas): Promise<bigint> {
  const [{ value: balance }, floor] = await Promise.all([
    rpc.getBalance(pdas.vault, { commitment: "confirmed" }).send(),
    rpc.getMinimumBalanceForRentExemption(0n).send()
  ]);
  const b = BigInt(balance);
  const f = BigInt(floor);
  return b > f ? b - f : 0n;
}

export type SettlementEligibility = { ok: true } | { ok: false; reason: string };

/**
 * Whether `amount` can be paid through `verify_reward` right now. Mirrors the program's checks
 * (paused, per-claim cap, per-epoch emission cap, vault liquidity) so the caller can fall back to a
 * direct treasury transfer instead of broadcasting a transaction that would fail on chain.
 */
export async function checkSettlementEligibility(
  rpc: SolanaRpcClient,
  input: { pdas: SettlementPdas; rewardSigner: string; amount: bigint; nowSecs?: bigint }
): Promise<SettlementEligibility> {
  const cfg = await fetchSettlementConfig(rpc, input.pdas);
  if (!cfg) return { ok: false, reason: "program not initialized" };
  if (cfg.paused) return { ok: false, reason: "program paused" };
  if (cfg.rewardSigner !== input.rewardSigner) return { ok: false, reason: "treasury is not the configured reward signer" };
  if (input.amount <= 0n) return { ok: false, reason: "amount must be positive" };
  if (input.amount > cfg.maxRewardPerClaim) return { ok: false, reason: `amount above per-claim cap (${cfg.maxRewardPerClaim})` };
  const now = input.nowSecs ?? BigInt(Math.floor(Date.now() / 1000));
  const emitted = now >= cfg.epochStart + cfg.epochDurationSecs ? 0n : cfg.epochEmitted;
  if (emitted + input.amount > cfg.maxEmissionPerEpoch) return { ok: false, reason: "epoch emission cap reached" };
  const available = await getVaultAvailable(rpc, input.pdas);
  if (available < input.amount) return { ok: false, reason: `vault liquidity ${available} below ${input.amount}` };
  return { ok: true };
}

export interface SettlementPayoutInput extends Omit<PayoutInput, "mint" | "mintDecimals" | "rpcSubscriptions"> {
  programId: string;
  rewardId: Uint8Array;
}

/**
 * Pays a reward through `verify_reward`, signed by `signer` as fee payer AND reward signer, with the
 * same SPL memo as a direct payout (so the memo-based idempotency lookup finds it). The signature is
 * handed to `onSigned` BEFORE broadcast, exactly like buildAndSendPayout.
 */
export async function sendSettlementPayout(input: SettlementPayoutInput): Promise<ConfirmationOutcome> {
  const commitment = input.commitment ?? "confirmed";
  const pdas = await getSettlementPdas(input.programId);
  const receipt = await getRewardReceiptPda(input.programId, input.rewardId);
  const ixs: Instruction[] = [
    buildVerifyRewardInstruction({ pdas, payer: input.signer, rewardSigner: input.signer, receipt, player: input.destination, rewardId: input.rewardId, amount: input.amount }),
    getAddMemoInstruction({ memo: input.memo, signers: [input.signer] }, { programAddress: toAddress(SPL_MEMO_PROGRAM_ID) })
  ];
  const { value: latestBlockhash } = await input.rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(input.signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstructions(ixs, m)
  );
  const signed = await signTransactionMessageWithSigners(message);
  const sig = getSignatureFromTransaction(signed);
  if (input.onSigned) await input.onSigned({ signature: sig, lastValidBlockHeight: latestBlockhash.lastValidBlockHeight });
  assertIsSendableTransaction(signed);
  assertIsTransactionWithBlockhashLifetime(signed);
  await input.rpc
    .sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64", preflightCommitment: "confirmed", maxRetries: 5n })
    .send();
  return waitForConfirmation(input.rpc, sig, latestBlockhash.lastValidBlockHeight, { commitment, timeoutMs: input.confirmTimeoutMs });
}

export async function sendFundVault(input: { rpc: SolanaRpcClient; funder: TransactionSigner; programId?: string; amount: bigint; confirmTimeoutMs?: number }): Promise<ConfirmationOutcome> {
  const pdas = await getSettlementPdas(input.programId);
  const ix = buildFundVaultInstruction({ pdas, funder: input.funder, amount: input.amount });
  const { value: latestBlockhash } = await input.rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(input.funder, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstructions([ix], m)
  );
  const signed = await signTransactionMessageWithSigners(message);
  const sig = getSignatureFromTransaction(signed);
  assertIsSendableTransaction(signed);
  assertIsTransactionWithBlockhashLifetime(signed);
  await input.rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64", preflightCommitment: "confirmed" }).send();
  return waitForConfirmation(input.rpc, sig, latestBlockhash.lastValidBlockHeight, { timeoutMs: input.confirmTimeoutMs ?? 90_000 });
}

/**
 * Verifies a settlement payout: successful + confirmed, treasury is fee payer/signer, the memo is
 * present, exactly `amount` moved vault → `destination` (the program's CPI transfer) AND the reward
 * receipt on chain names the same player and amount. Only the program can move vault lamports, and
 * only with the reward signer's co-signature, so a spoofed transaction cannot pass.
 */
export async function verifySettlementPayout(
  rpc: SolanaRpcClient,
  input: { signature: string; treasury: string; destination: string; amount: bigint; memo: string; programId: string; rewardId: Uint8Array; skipClusterCheck?: boolean }
): Promise<VerifyDepositResult> {
  const pdas = await getSettlementPdas(input.programId);
  const tx = await verifyDepositTransaction(rpc, {
    signature: input.signature,
    expectedRecipient: input.destination,
    expectedAmount: input.amount,
    mint: null,
    memo: input.memo,
    expectedSender: pdas.vault,
    senderMustSign: false,
    expectedFeePayer: input.treasury,
    minConfirmations: "confirmed",
    ...(input.skipClusterCheck ? { skipClusterCheck: true } : {})
  });
  if (!tx.ok) return tx;
  try {
    const receipt = await fetchRewardReceipt(rpc, input.programId, input.rewardId);
    if (!receipt || receipt.player !== input.destination || receipt.amount !== input.amount) {
      return { ok: false, reason: DepositRejection.AMOUNT_MISMATCH, message: "Reward receipt missing or does not match the payout", retryable: false };
    }
  } catch (err) {
    return { ok: false, reason: DepositRejection.RPC_ERROR, message: `RPC error: ${(err as Error).message}`, retryable: true };
  }
  return tx;
}
