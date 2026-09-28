import {
  address as toAddress,
  appendTransactionMessageInstructions,
  assertIsSendableTransaction,
  assertIsTransactionWithBlockhashLifetime,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  lamports,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signature as toSignature,
  signTransactionMessageWithSigners,
  type Address,
  type Commitment,
  type Instruction,
  type TransactionSigner
} from "@solana/kit";
import { getAddMemoInstruction } from "@solana-program/memo";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS
} from "@solana-program/token";
import type { SolanaRpcClient, SolanaRpcSubscriptionsClient } from "./rpc.js";
import { SPL_MEMO_PROGRAM_ID } from "./deposit.js";

export interface PayoutInput {
  rpc: SolanaRpcClient;
  /** Optional: when given, confirmation uses kit's sendAndConfirmTransactionFactory (websocket). */
  rpcSubscriptions?: SolanaRpcSubscriptionsClient;
  signer: TransactionSigner;
  destination: string;
  amount: bigint;
  /** SPL mint; omit/null for native SOL. */
  mint?: string | null;
  mintDecimals?: number;
  /** Unique memo (the withdrawal id) — used for on-chain idempotency lookup. */
  memo: string;
  commitment?: Commitment;
  /**
   * Called with the signature BEFORE the transaction is broadcast. The caller must durably store
   * it (Withdrawal/ChainTransaction row) so a crash after send can never lead to a double payment.
   */
  onSigned?: (info: { signature: string; lastValidBlockHeight: bigint }) => Promise<void>;
  confirmTimeoutMs?: number;
}

export type ConfirmationOutcome =
  | { status: "CONFIRMED"; signature: string; slot: bigint | null; confirmationStatus: string }
  | { status: "FAILED"; signature: string; error: string }
  /** Blockhash expired and the tx never landed — safe to rebuild & resubmit. */
  | { status: "EXPIRED"; signature: string }
  /** Unknown yet (still in flight) — keep polling, NEVER resubmit. */
  | { status: "PENDING"; signature: string };

export async function buildPayoutInstructions(input: Pick<PayoutInput, "signer" | "destination" | "amount" | "mint" | "mintDecimals" | "memo">): Promise<Instruction[]> {
  if (input.amount <= 0n) throw new Error("Payout amount must be positive");
  const destination = toAddress(input.destination);
  const ixs: Instruction[] = [];
  if (!input.mint) {
    ixs.push(getTransferSolInstruction({ source: input.signer, destination, amount: lamports(input.amount) }));
  } else {
    const mint = toAddress(input.mint);
    const [sourceAta] = await findAssociatedTokenPda({ owner: input.signer.address, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const [destAta] = await findAssociatedTokenPda({ owner: destination, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    ixs.push(await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: input.signer, owner: destination, mint }));
    ixs.push(
      getTransferCheckedInstruction({
        source: sourceAta,
        mint,
        destination: destAta,
        authority: input.signer,
        amount: input.amount,
        decimals: input.mintDecimals ?? 9
      })
    );
  }
  // Classic SPL Memo program: its memos are indexed by RPC (getSignaturesForAddress.memo), which the
  // payout idempotency lookup relies on.
  ixs.push(getAddMemoInstruction({ memo: input.memo, signers: [input.signer] }, { programAddress: toAddress(SPL_MEMO_PROGRAM_ID) }));
  return ixs;
}

/**
 * Searches the treasury's recent signatures for a successful tx carrying `memo`.
 * The RPC's getSignaturesForAddress includes the memo text (format "[len] text").
 */
export async function findPayoutByMemo(
  rpc: SolanaRpcClient,
  treasury: Address | string,
  memo: string,
  limit = 200
): Promise<{ signature: string; slot: bigint; err: boolean } | null> {
  return (await findPayoutsByMemo(rpc, treasury, memo, limit))[0] ?? null;
}

/**
 * All treasury transactions (newest first) whose memo matches. A match is only a candidate: anyone
 * can send the treasury a tx with this memo, so callers must verify it (verifyPayoutTransaction).
 */
export async function findPayoutsByMemo(
  rpc: SolanaRpcClient,
  treasury: Address | string,
  memo: string,
  limit = 200
): Promise<{ signature: string; slot: bigint; err: boolean }[]> {
  const list = await rpc.getSignaturesForAddress(toAddress(treasury), { limit, commitment: "confirmed" }).send();
  const out: { signature: string; slot: bigint; err: boolean }[] = [];
  for (const s of list) {
    if (!s.memo) continue;
    const text = s.memo.replace(/^\[\d+\]\s*/, "");
    const parts = text.split(/;\s*/);
    if (text === memo || parts.includes(memo)) out.push({ signature: s.signature, slot: s.slot, err: s.err !== null });
  }
  return out;
}

/** Single status check: never resubmit unless EXPIRED. */
export async function checkSignature(
  rpc: SolanaRpcClient,
  sig: string,
  lastValidBlockHeight: bigint | null,
  commitment: Commitment = "confirmed"
): Promise<ConfirmationOutcome> {
  const { value } = await rpc.getSignatureStatuses([toSignature(sig)], { searchTransactionHistory: true }).send();
  const st = value[0];
  if (st) {
    if (st.err) return { status: "FAILED", signature: sig, error: JSON.stringify(st.err, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)) };
    const cs = st.confirmationStatus;
    const ok = commitment === "finalized" ? cs === "finalized" : cs === "confirmed" || cs === "finalized";
    if (ok) return { status: "CONFIRMED", signature: sig, slot: st.slot, confirmationStatus: cs ?? "confirmed" };
    return { status: "PENDING", signature: sig };
  }
  if (lastValidBlockHeight !== null) {
    const height = await rpc.getBlockHeight({ commitment: "finalized" }).send();
    if (height > lastValidBlockHeight) {
      // Re-check once more after expiry is observed, to avoid a race with a just-landed tx.
      const again = await rpc.getSignatureStatuses([toSignature(sig)], { searchTransactionHistory: true }).send();
      if (!again.value[0]) return { status: "EXPIRED", signature: sig };
      return checkSignature(rpc, sig, null, commitment);
    }
  }
  return { status: "PENDING", signature: sig };
}

export async function waitForConfirmation(
  rpc: SolanaRpcClient,
  sig: string,
  lastValidBlockHeight: bigint | null,
  opts: { commitment?: Commitment; timeoutMs?: number; pollMs?: number } = {}
): Promise<ConfirmationOutcome> {
  const deadline = Date.now() + (opts.timeoutMs ?? 90_000);
  for (;;) {
    const res = await checkSignature(rpc, sig, lastValidBlockHeight, opts.commitment ?? "confirmed");
    if (res.status !== "PENDING") return res;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return res;
    await new Promise((r) => setTimeout(r, Math.min(opts.pollMs ?? 1500, remaining)));
  }
}

/**
 * Builds, signs, (persists signature via onSigned), sends and confirms a treasury payout.
 * Uses pipe/createTransactionMessage like the @solana/kit transfer-lamports example.
 */
export async function buildAndSendPayout(input: PayoutInput): Promise<ConfirmationOutcome> {
  const commitment = input.commitment ?? "confirmed";
  const ixs = await buildPayoutInstructions(input);
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

  if (input.rpcSubscriptions) {
    const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc: input.rpc, rpcSubscriptions: input.rpcSubscriptions });
    try {
      await sendAndConfirm(signed, { commitment });
      return await checkSignature(input.rpc, sig, latestBlockhash.lastValidBlockHeight, commitment);
    } catch {
      // Fall through to polling: the tx may still have landed.
      return waitForConfirmation(input.rpc, sig, latestBlockhash.lastValidBlockHeight, { commitment, timeoutMs: input.confirmTimeoutMs });
    }
  }

  await input.rpc
    .sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64", preflightCommitment: "confirmed", maxRetries: 5n })
    .send();
  return waitForConfirmation(input.rpc, sig, latestBlockhash.lastValidBlockHeight, { commitment, timeoutMs: input.confirmTimeoutMs });
}

/** Plain SOL transfer with memo (used by devnet scripts to simulate a player deposit). */
export async function sendSolWithMemo(input: Omit<PayoutInput, "mint" | "mintDecimals">): Promise<ConfirmationOutcome> {
  return buildAndSendPayout({ ...input, mint: null });
}
