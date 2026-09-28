import { getBase58Encoder, getUtf8Decoder, isSignature, signature as toSignature, type Commitment } from "@solana/kit";
import { GENESIS_HASHES, getSolanaNetwork, type SolanaNetwork, type SolanaRpcClient } from "./rpc.js";

export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EHFLbAv5A5fQ9mXC8b4W";
/** SPL Memo v2 (classic, indexed by RPC `memo` fields) — used for all our payouts. */
export const SPL_MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
/** Accepted memo programs: SPL Memo v2, v1 and the newer p-memo used by @solana-program/memo >= 0.15. */
export const MEMO_PROGRAM_IDS = [SPL_MEMO_PROGRAM_ID, "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo", "Memo4c2pN8afCj432Lb7RMVKi9PbQnnW7ewFFaV3oAH"];

export interface VerifyDepositInput {
  signature: string;
  /** Treasury address that must receive the funds. */
  expectedRecipient: string;
  /** Exact amount in base units (lamports or token base units). */
  expectedAmount: bigint;
  /** SPL mint; null/undefined => native SOL. */
  mint?: string | null;
  /** Memo that must be attached (the prepared deposit's unique memo). */
  memo: string;
  /** The user's verified wallet; must be the signer & source of the transfer. */
  expectedSender: string;
  /** When set, this account must be the transaction fee payer (first account key, a signer). */
  expectedFeePayer?: string;
  /** "confirmed" (default) or "finalized". */
  minConfirmations?: "confirmed" | "finalized";
  network?: SolanaNetwork;
  /** Skip the genesis-hash check (only for local mock RPC tests). */
  skipClusterCheck?: boolean;
}

export const DepositRejection = {
  INVALID_SIGNATURE: "INVALID_SIGNATURE",
  WRONG_NETWORK: "WRONG_NETWORK",
  NOT_FOUND: "NOT_FOUND",
  NOT_CONFIRMED: "NOT_CONFIRMED",
  TX_FAILED: "TX_FAILED",
  MEMO_MISMATCH: "MEMO_MISMATCH",
  WRONG_RECIPIENT: "WRONG_RECIPIENT",
  WRONG_MINT: "WRONG_MINT",
  AMOUNT_MISMATCH: "AMOUNT_MISMATCH",
  WRONG_SENDER: "WRONG_SENDER",
  MALFORMED: "MALFORMED",
  RPC_ERROR: "RPC_ERROR"
} as const;
export type DepositRejection = (typeof DepositRejection)[keyof typeof DepositRejection];

export type VerifyDepositResult =
  | {
      ok: true;
      signature: string;
      slot: bigint;
      blockTime: bigint | null;
      sender: string;
      recipient: string;
      amount: bigint;
      mint: string | null;
      confirmationStatus: "confirmed" | "finalized";
    }
  | { ok: false; reason: DepositRejection; message: string; retryable: boolean };

// --- minimal shapes of the jsonParsed getTransaction response we rely on ---------------------
type Num = bigint | number | string;
interface ParsedAccountKey { pubkey: string; signer: boolean; writable: boolean }
interface ParsedIx { program?: string; programId: string; parsed?: unknown; accounts?: string[]; data?: string }
interface TokenBalance { accountIndex: Num; mint: string; owner?: string; uiTokenAmount: { amount: string } }
interface ParsedTx {
  slot: Num;
  blockTime: Num | null;
  meta: {
    err: unknown;
    preBalances: Num[];
    postBalances: Num[];
    preTokenBalances?: TokenBalance[] | null;
    postTokenBalances?: TokenBalance[] | null;
    innerInstructions?: { index: Num; instructions: ParsedIx[] }[] | null;
    logMessages?: string[] | null;
  } | null;
  transaction: { signatures: string[]; message: { accountKeys: ParsedAccountKey[]; instructions: ParsedIx[] } };
}

const big = (v: Num | null | undefined): bigint => (v === null || v === undefined ? 0n : BigInt(v));

function reject(reason: DepositRejection, message: string, retryable = false): VerifyDepositResult {
  return { ok: false, reason, message, retryable };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Extract memo strings from parsed instructions (top-level and inner). */
export function extractMemos(tx: ParsedTx): string[] {
  const out: string[] = [];
  const all = [...tx.transaction.message.instructions, ...(tx.meta?.innerInstructions ?? []).flatMap((i) => i.instructions)];
  for (const ix of all) {
    if (MEMO_PROGRAM_IDS.includes(ix.programId) || ix.program === "spl-memo") {
      if (typeof ix.parsed === "string") out.push(ix.parsed);
      else if (typeof ix.data === "string") {
        // Not parsed by the RPC (e.g. newer memo program): raw base58 instruction data = UTF-8 memo.
        try {
          out.push(getUtf8Decoder().decode(getBase58Encoder().encode(ix.data)));
        } catch {
          /* ignore undecodable data */
        }
      }
    }
  }
  return out;
}

function allInstructions(tx: ParsedTx): ParsedIx[] {
  return [...tx.transaction.message.instructions, ...(tx.meta?.innerInstructions ?? []).flatMap((i) => i.instructions)];
}

/**
 * Verifies that `signature` is a successful, confirmed transaction on the configured cluster that
 * moves exactly `expectedAmount` from `expectedSender` to `expectedRecipient` (SOL or SPL `mint`)
 * and carries `memo`. Never throws for bad user input — returns a typed rejection.
 */
export async function verifyDepositTransaction(rpc: SolanaRpcClient, input: VerifyDepositInput): Promise<VerifyDepositResult> {
  if (!isSignature(input.signature)) return reject(DepositRejection.INVALID_SIGNATURE, "Not a valid transaction signature");
  const sig = toSignature(input.signature);
  const network = input.network ?? getSolanaNetwork();
  const minConf = input.minConfirmations ?? "confirmed";

  try {
    if (!input.skipClusterCheck && network !== "localnet") {
      const genesis = await rpc.getGenesisHash().send();
      if (genesis !== GENESIS_HASHES[network]) {
        return reject(DepositRejection.WRONG_NETWORK, `RPC is not ${network}`);
      }
    }

    const statuses = await rpc.getSignatureStatuses([sig], { searchTransactionHistory: true }).send();
    const status = statuses.value[0];
    if (!status) return reject(DepositRejection.NOT_FOUND, "Transaction not found on chain (yet)", true);
    if (status.err) return reject(DepositRejection.TX_FAILED, "Transaction failed on chain");
    const cs = status.confirmationStatus;
    const confirmedEnough = minConf === "finalized" ? cs === "finalized" : cs === "confirmed" || cs === "finalized";
    if (!confirmedEnough) return reject(DepositRejection.NOT_CONFIRMED, `Transaction is ${cs ?? "unknown"}, need ${minConf}`, true);

    const commitment: Commitment = minConf;
    const raw = await rpc
      .getTransaction(sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment })
      .send();
    if (!raw) return reject(DepositRejection.NOT_FOUND, "Transaction not available at requested commitment", true);
    const tx = raw as unknown as ParsedTx;
    if (!tx.meta || !isObj(tx.transaction) || !Array.isArray(tx.transaction.message?.accountKeys)) {
      return reject(DepositRejection.MALFORMED, "Unexpected transaction format");
    }
    if (tx.meta.err) return reject(DepositRejection.TX_FAILED, "Transaction failed on chain");

    // Memo must match exactly (wallets may add extra memos; ours must be present).
    const memos = extractMemos(tx);
    if (!memos.some((m) => m === input.memo)) return reject(DepositRejection.MEMO_MISMATCH, "Deposit memo missing or incorrect");

    const keys = tx.transaction.message.accountKeys;
    const senderKey = keys.find((k) => k.pubkey === input.expectedSender);
    if (!senderKey || !senderKey.signer) return reject(DepositRejection.WRONG_SENDER, "Transaction was not signed by your verified wallet");
    if (input.expectedFeePayer !== undefined) {
      const feePayer = keys[0];
      if (!feePayer || feePayer.pubkey !== input.expectedFeePayer || !feePayer.signer) {
        return reject(DepositRejection.WRONG_SENDER, "Transaction fee payer is not the expected account");
      }
    }

    const mint = input.mint ?? null;
    let transferred = 0n;
    if (!mint) {
      // Native SOL: sum parsed system transfers sender -> recipient.
      let toRecipientAny = false;
      for (const ix of allInstructions(tx)) {
        if (ix.programId !== SYSTEM_PROGRAM_ID || !isObj(ix.parsed)) continue;
        const p = ix.parsed as { type?: string; info?: Record<string, unknown> };
        if (p.type !== "transfer" && p.type !== "transferWithSeed") continue;
        const info = p.info ?? {};
        if (info.destination === input.expectedRecipient) {
          toRecipientAny = true;
          if (info.source === input.expectedSender) transferred += big(info.lamports as Num);
        }
      }
      if (!toRecipientAny) return reject(DepositRejection.WRONG_RECIPIENT, "No transfer to the treasury address found");
      if (transferred === 0n) return reject(DepositRejection.WRONG_SENDER, "Transfer did not originate from your verified wallet");
      // Cross-check with balance deltas so a parser quirk can't inflate the credited amount.
      const ri = keys.findIndex((k) => k.pubkey === input.expectedRecipient);
      const delta = big(tx.meta.postBalances[ri]) - big(tx.meta.preBalances[ri]);
      if (delta < transferred) return reject(DepositRejection.AMOUNT_MISMATCH, "Recipient balance delta does not match transfer");
    } else {
      const pre = tx.meta.preTokenBalances ?? [];
      const post = tx.meta.postTokenBalances ?? [];
      const sumFor = (list: TokenBalance[], owner: string, m: string) =>
        list.filter((b) => b.owner === owner && b.mint === m).reduce((s, b) => s + BigInt(b.uiTokenAmount.amount), 0n);
      const recipientTouched = [...pre, ...post].some((b) => b.owner === input.expectedRecipient);
      if (!recipientTouched) return reject(DepositRejection.WRONG_RECIPIENT, "No token transfer to the treasury found");
      const mintTouched = [...pre, ...post].some((b) => b.owner === input.expectedRecipient && b.mint === mint);
      if (!mintTouched) return reject(DepositRejection.WRONG_MINT, "Token transfer used a different mint");
      const recvDelta = sumFor(post, input.expectedRecipient, mint) - sumFor(pre, input.expectedRecipient, mint);
      const sendDelta = sumFor(pre, input.expectedSender, mint) - sumFor(post, input.expectedSender, mint);
      if (sendDelta <= 0n) return reject(DepositRejection.WRONG_SENDER, "Tokens did not come from your verified wallet");
      transferred = recvDelta < sendDelta ? recvDelta : sendDelta;
    }

    if (transferred !== input.expectedAmount) {
      return reject(DepositRejection.AMOUNT_MISMATCH, `Transferred ${transferred} but expected ${input.expectedAmount}`);
    }

    return {
      ok: true,
      signature: input.signature,
      slot: big(tx.slot),
      blockTime: tx.blockTime === null ? null : big(tx.blockTime),
      sender: input.expectedSender,
      recipient: input.expectedRecipient,
      amount: transferred,
      mint,
      confirmationStatus: cs === "finalized" ? "finalized" : "confirmed"
    };
  } catch (err) {
    return reject(DepositRejection.RPC_ERROR, `RPC error: ${(err as Error).message}`, true);
  }
}

export interface VerifyPayoutInput {
  signature: string;
  /** Treasury address: must be fee payer, signer and the source of the transfer. */
  treasury: string;
  /** Withdrawal destination that must receive exactly `amount`. */
  destination: string;
  amount: bigint;
  /** SPL mint; null/undefined => native SOL. */
  mint?: string | null;
  /** The withdrawal memo the payout must carry. */
  memo: string;
  network?: SolanaNetwork;
  skipClusterCheck?: boolean;
}

/** Sum of `owner`'s token-account balances for `mint` (base units) at `commitment`. */
export async function getTokenBalance(rpc: SolanaRpcClient, owner: string, mint: string, commitment: Commitment = "finalized"): Promise<bigint> {
  const { value } = await rpc
    .getTokenAccountsByOwner(owner as Parameters<SolanaRpcClient["getTokenAccountsByOwner"]>[0], { mint: mint as Parameters<SolanaRpcClient["getBalance"]>[0] }, { encoding: "jsonParsed", commitment })
    .send();
  return value.reduce((sum, a) => sum + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
}

/** Fee payer (first account key) of a landed transaction, or null when it is not available. */
export async function getTransactionFeePayer(rpc: SolanaRpcClient, signature: string): Promise<string | null> {
  if (!isSignature(signature)) return null;
  const raw = await rpc
    .getTransaction(toSignature(signature), { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" })
    .send();
  const keys = (raw as unknown as ParsedTx | null)?.transaction?.message?.accountKeys;
  return Array.isArray(keys) ? (keys[0]?.pubkey ?? null) : null;
}

/**
 * Verifies that `signature` is a genuine treasury payout: successful + confirmed, treasury is fee
 * payer and signer, exactly `amount` moves treasury → `destination` (SOL or SPL `mint`) and the
 * memo matches. A memo alone proves nothing — anyone can send the treasury a tx carrying it.
 */
export function verifyPayoutTransaction(rpc: SolanaRpcClient, input: VerifyPayoutInput): Promise<VerifyDepositResult> {
  return verifyDepositTransaction(rpc, {
    signature: input.signature,
    expectedRecipient: input.destination,
    expectedAmount: input.amount,
    mint: input.mint ?? null,
    memo: input.memo,
    expectedSender: input.treasury,
    expectedFeePayer: input.treasury,
    minConfirmations: "confirmed",
    ...(input.network ? { network: input.network } : {}),
    ...(input.skipClusterCheck ? { skipClusterCheck: true } : {})
  });
}
