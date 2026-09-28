/**
 * Password hashing with argon2id (OWASP recommended parameters: m=19 MiB, t=2, p=1).
 */
import { hash, verify } from "@node-rs/argon2";

/** `Algorithm.Argon2id` — the enum is an ambient const enum, so its value is inlined here. */
const ARGON2ID = 2;

const OPTIONS = { algorithm: ARGON2ID, memoryCost: 19_456, timeCost: 2, parallelism: 1, outputLen: 32 } as const;

export async function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;
/**
 * Burn comparable CPU time when the account does not exist so response timing does not reveal
 * which emails are registered.
 */
export async function verifyDummyPassword(password: string): Promise<false> {
  dummyHash ??= hashPassword("nebula-dummy-password-for-timing-equalisation");
  await verifyPassword(await dummyHash, password);
  return false;
}
