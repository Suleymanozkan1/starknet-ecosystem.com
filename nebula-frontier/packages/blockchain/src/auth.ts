import {
  address as toAddress,
  getBase58Encoder,
  getPublicKeyFromAddress,
  getUtf8Encoder,
  isAddress,
  signatureBytes as toSignatureBytes,
  verifySignature
} from "@solana/kit";

/**
 * Sign-In-With-Solana style login message. The server builds this text, the wallet signs the
 * UTF-8 bytes (`signMessage`), the server re-builds the same text from the stored nonce row and
 * verifies the ed25519 signature against the claimed address.
 */
export type WalletAuthPurpose = "LOGIN" | "LINK_WALLET" | "WITHDRAWAL_CONFIRM";

export interface LoginMessageInput {
  domain: string;
  address: string;
  nonce: string;
  issuedAt: Date | string;
  expiresAt: Date | string;
  purpose: WalletAuthPurpose | string;
  /** Solana cluster; always devnet for this project. */
  chainId?: string;
  statement?: string;
}

const PURPOSE_STATEMENTS: Record<string, string> = {
  LOGIN: "Sign in to NEBULA FRONTIER. This request will not trigger a blockchain transaction or cost any fees.",
  LINK_WALLET: "Link this wallet to your NEBULA FRONTIER account. This request will not trigger a blockchain transaction or cost any fees.",
  WITHDRAWAL_CONFIRM: "Confirm a NEBULA FRONTIER withdrawal to this wallet. This signature does not move funds by itself."
};

function iso(d: Date | string): string {
  return typeof d === "string" ? new Date(d).toISOString() : d.toISOString();
}

export function buildLoginMessage(input: LoginMessageInput): string {
  const statement = input.statement ?? PURPOSE_STATEMENTS[input.purpose] ?? PURPOSE_STATEMENTS.LOGIN;
  return [
    `${input.domain} wants you to sign in with your Solana account:`,
    input.address,
    "",
    statement,
    "",
    `URI: https://${input.domain}`,
    "Version: 1",
    `Chain ID: ${input.chainId ?? "solana:devnet"}`,
    `Purpose: ${input.purpose}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${iso(input.issuedAt)}`,
    `Expiration Time: ${iso(input.expiresAt)}`
  ].join("\n");
}

export function encodeMessage(message: string): Uint8Array {
  return new Uint8Array(getUtf8Encoder().encode(message));
}

export function isValidSolanaAddress(value: string): boolean {
  return isAddress(value);
}

/**
 * Verifies an ed25519 signature (base58 encoded, 64 bytes) of `message` by `walletAddress`.
 * Never throws for malformed input: returns false instead.
 */
export async function verifyWalletSignature(
  walletAddress: string,
  message: Uint8Array | string,
  signatureBase58: string
): Promise<boolean> {
  try {
    if (!isAddress(walletAddress)) return false;
    const bytes = typeof message === "string" ? encodeMessage(message) : message;
    const sigRaw = getBase58Encoder().encode(signatureBase58);
    if (sigRaw.length !== 64) return false;
    const key = await getPublicKeyFromAddress(toAddress(walletAddress));
    return await verifySignature(key, toSignatureBytes(new Uint8Array(sigRaw)), bytes);
  } catch {
    return false;
  }
}
