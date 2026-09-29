/**
 * Devnet deposit transaction builder.
 * Flow: POST /api/wallet/deposit/prepare → build transfer + memo → wallet-adapter sendTransaction →
 *       confirm on devnet → POST /api/wallet/deposit/verify { depositId, signature }.
 * The server re-verifies network, mint, amount, recipient, memo, sender, confirmation and signature uniqueness.
 */
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import type { Connection, SendOptions, TransactionSignature } from "@solana/web3.js";
import type { DepositPrepareResponse } from "@nebula/shared";

export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbd2vxMnRqvuYrfyA5UcQEmJ9WWNnoXhq6K2");

export type SendTransactionFn = (tx: Transaction, connection: Connection, options?: SendOptions & { minContextSlot?: number }) => Promise<TransactionSignature>;

export function associatedTokenAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID)[0];
}

function u64le(v: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, v, true);
  return out;
}

export function memoInstruction(memo: string, signer: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [{ pubkey: signer, isSigner: true, isWritable: false }],
    data: Buffer.from(memo, "utf8"),
  });
}

/** SPL Token `TransferChecked` (instruction 12) — avoids pulling in @solana/spl-token. */
export function transferCheckedInstruction(source: PublicKey, mint: PublicKey, destination: PublicKey, owner: PublicKey, amount: bigint, decimals: number): TransactionInstruction {
  const data = new Uint8Array(10);
  data[0] = 12;
  data.set(u64le(amount), 1);
  data[9] = decimals;
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

export interface BuildDepositInput {
  prep: DepositPrepareResponse;
  payer: PublicKey;
  /** Treasury address independently fetched from GET /api/wallet — must match prep.recipient. */
  expectedTreasury: string;
  mintDecimals: number;
}

export function buildDepositInstructions({ prep, payer, expectedTreasury, mintDecimals }: BuildDepositInput): TransactionInstruction[] {
  if (!/devnet/i.test(prep.network)) throw new Error(`Refusing to deposit on network "${prep.network}" (devnet only).`);
  if (prep.recipient !== expectedTreasury) throw new Error("Deposit recipient does not match the game treasury. Aborting.");
  if (new Date(prep.expiresAt).getTime() < Date.now()) throw new Error("This deposit request expired. Please start again.");
  const amount = BigInt(prep.amount);
  if (amount <= 0n) throw new Error("Invalid deposit amount.");
  const recipient = new PublicKey(prep.recipient);
  const ixs: TransactionInstruction[] = [];
  if (prep.mint) {
    const mint = new PublicKey(prep.mint);
    ixs.push(transferCheckedInstruction(associatedTokenAddress(payer, mint), mint, associatedTokenAddress(recipient, mint), payer, amount, mintDecimals));
  } else {
    ixs.push(SystemProgram.transfer({ fromPubkey: payer, toPubkey: recipient, lamports: amount }));
  }
  ixs.push(memoInstruction(prep.memo, payer));
  return ixs;
}

/** Builds, sends (wallet signs) and confirms the deposit. Returns the transaction signature. */
export async function sendDeposit(connection: Connection, sendTransaction: SendTransactionFn, input: BuildDepositInput, onStage?: (s: "signing" | "confirming") => void): Promise<string> {
  const {
    context: { slot: minContextSlot },
    value: { blockhash, lastValidBlockHeight },
  } = await connection.getLatestBlockhashAndContext("confirmed");
  const tx = new Transaction({ feePayer: input.payer, blockhash, lastValidBlockHeight }).add(...buildDepositInstructions(input));
  onStage?.("signing");
  const signature = await sendTransaction(tx, connection, { minContextSlot });
  onStage?.("confirming");
  const res = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (res.value.err) throw new Error(`Transaction failed on-chain: ${JSON.stringify(res.value.err)}`);
  return signature;
}

export function explorerTxUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=devnet`;
}
export function explorerAddressUrl(address: string): string {
  return `https://explorer.solana.com/address/${encodeURIComponent(address)}?cluster=devnet`;
}
