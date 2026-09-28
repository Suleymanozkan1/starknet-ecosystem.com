import {
  address as toAddress,
  createKeyPairSignerFromBytes,
  getBase58Encoder,
  isAddress,
  type Address,
  type KeyPairSigner
} from "@solana/kit";
import type { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Treasury key handling.
 *
 * - The secret is read ONLY from `TREASURY_SECRET` (JSON byte array as written by solana-keygen /
 *   scripts/devnet-setup.ts, or a base58 string of the 64-byte secret key), or — when that is unset —
 *   from the file named by `TREASURY_SECRET_FILE` (same formats; e.g. a mounted secret or the 0600
 *   `.secrets/treasury-devnet.json`), so the secret itself never has to live in a shared `.env`.
 * - It may only be loaded inside apps/blockchain-service (`SERVICE_ROLE=blockchain`). Any other
 *   process (API, game server, web) gets an exception — they only ever know the public key.
 * - The secret value is never logged or included in error messages. The resulting signer uses a
 *   non-extractable WebCrypto private key.
 */
export class TreasuryKeyError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "TreasuryKeyError";
  }
}

let cached: Promise<KeyPairSigner> | undefined;

export function parseSecretKey(raw: string): Uint8Array {
  const trimmed = raw.trim();
  let bytes: Uint8Array;
  if (trimmed.startsWith("[")) {
    let arr: unknown;
    try {
      arr = JSON.parse(trimmed);
    } catch {
      throw new TreasuryKeyError("MALFORMED_SECRET", "TREASURY_SECRET is not valid JSON");
    }
    if (!Array.isArray(arr) || !arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      throw new TreasuryKeyError("MALFORMED_SECRET", "TREASURY_SECRET must be a JSON array of bytes");
    }
    bytes = Uint8Array.from(arr as number[]);
  } else {
    try {
      bytes = new Uint8Array(getBase58Encoder().encode(trimmed));
    } catch {
      throw new TreasuryKeyError("MALFORMED_SECRET", "TREASURY_SECRET is neither a JSON byte array nor base58");
    }
  }
  if (bytes.length !== 64) throw new TreasuryKeyError("MALFORMED_SECRET", `TREASURY_SECRET must decode to 64 bytes (got ${bytes.length})`);
  return bytes;
}

export function assertBlockchainServiceRole(env: NodeJS.ProcessEnv = process.env): void {
  if (env.SERVICE_ROLE !== "blockchain") {
    throw new TreasuryKeyError(
      "FORBIDDEN_CONTEXT",
      "The treasury signer can only be loaded by apps/blockchain-service (SERVICE_ROLE=blockchain)"
    );
  }
}

/** Reads the raw secret from TREASURY_SECRET or TREASURY_SECRET_FILE. Never echoes the contents. */
function readTreasurySecret(env: NodeJS.ProcessEnv): string {
  if (env.TREASURY_SECRET) return env.TREASURY_SECRET;
  const file = env.TREASURY_SECRET_FILE?.trim();
  if (!file) throw new TreasuryKeyError("MISSING_SECRET", "TREASURY_SECRET (or TREASURY_SECRET_FILE) is not configured");
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    throw new TreasuryKeyError("MISSING_SECRET", `TREASURY_SECRET_FILE could not be read (${(err as NodeJS.ErrnoException).code ?? "error"})`);
  }
  if (!raw.trim()) throw new TreasuryKeyError("MISSING_SECRET", "TREASURY_SECRET_FILE is empty");
  return raw;
}

/** Loads (once) the treasury signer. Throws outside the blockchain service. */
export function loadTreasurySigner(env: NodeJS.ProcessEnv = process.env): Promise<KeyPairSigner> {
  assertBlockchainServiceRole(env);
  const raw = readTreasurySecret(env);
  cached ??= (async () => {
    const bytes = parseSecretKey(raw);
    try {
      const signer = await createKeyPairSignerFromBytes(bytes, false);
      const expected = env.TREASURY_PUBLIC_KEY?.trim();
      if (expected && expected !== signer.address) {
        throw new TreasuryKeyError("PUBKEY_MISMATCH", `TREASURY_SECRET does not match TREASURY_PUBLIC_KEY (${expected})`);
      }
      return signer;
    } finally {
      bytes.fill(0);
    }
  })();
  cached.catch(() => {
    cached = undefined;
  });
  return cached;
}

/** For tests only: forget the cached signer. */
export function resetTreasurySignerCache(): void {
  cached = undefined;
}

/** Public treasury address — safe to use anywhere (API returns it to clients as deposit target). */
export function getTreasuryAddress(env: NodeJS.ProcessEnv = process.env): Address {
  const pk = env.TREASURY_PUBLIC_KEY?.trim();
  if (!pk || !isAddress(pk)) throw new TreasuryKeyError("MISSING_PUBLIC_KEY", "TREASURY_PUBLIC_KEY is not configured or invalid");
  return toAddress(pk);
}

export function getRewardMint(env: NodeJS.ProcessEnv = process.env): { mint: Address | null; decimals: number } {
  const m = env.REWARD_MINT?.trim();
  const decimals = Number(env.REWARD_MINT_DECIMALS ?? 9);
  if (!m) return { mint: null, decimals: 9 };
  if (!isAddress(m)) throw new Error("REWARD_MINT is not a valid address");
  return { mint: toAddress(m), decimals: Number.isInteger(decimals) ? decimals : 9 };
}

/**
 * Exports an EXTRACTABLE CryptoKeyPair to the 64-byte solana-keygen format (seed || pubkey).
 * Only used by devnet tooling (scripts/devnet-setup.ts) to persist a freshly generated key.
 */
export async function exportKeyPairBytes(keyPair: { privateKey: webcrypto.CryptoKey; publicKey: webcrypto.CryptoKey }): Promise<Uint8Array> {
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  const seed = pkcs8.slice(pkcs8.length - 32);
  const out = new Uint8Array(64);
  out.set(seed, 0);
  out.set(pub, 32);
  return out;
}
