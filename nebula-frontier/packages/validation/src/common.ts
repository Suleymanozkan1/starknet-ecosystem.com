/**
 * Reusable zod primitives. Every external input (REST bodies, query strings, game messages)
 * is parsed through these before it reaches business logic.
 */
import { z } from "zod";
import {
  ChatChannel, ClanRole, Currency, ItemCategory, Rarity, ResourceId, CircuitBreakerMode, AdminRole,
} from "@nebula/shared";

const vals = <T extends Record<string, string>>(o: T) => Object.values(o) as [T[keyof T], ...T[keyof T][]];

/** Database ids (cuid / cuid2 / config ids like `ship_aurora_lumen`). */
export const idSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_:-]+$/, "invalid id");
/** Config catalog ids (`ship_*`, `item_*`, `q_*` ...). */
export const defIdSchema = z.string().min(1).max(80).regex(/^[a-z0-9_]+$/, "invalid definition id");

/** Positive integer amount in base units, carried as a decimal string (bigint-safe). */
export const amountSchema = z
  .string()
  .regex(/^[1-9]\d{0,29}$/, "amount must be a positive integer string")
  .transform((s) => BigInt(s));
/** Positive integer amount accepted as string or safe integer number. */
export const amountLooseSchema = z
  .union([z.string(), z.number().int().positive().max(Number.MAX_SAFE_INTEGER)])
  .transform((v) => String(v))
  .pipe(amountSchema);

export const idempotencyKeySchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9_.:-]+$/, "invalid idempotency key");

/** Base58 Solana address (32-byte ed25519 public key). */
export const solanaAddressSchema = z
  .string()
  .min(32)
  .max(44)
  .regex(/^[1-9A-HJ-NP-Za-km-z]+$/, "invalid Solana address");
/** Base58 ed25519 signature (64 bytes => 86-88 chars). */
export const base58SignatureSchema = z
  .string()
  .min(64)
  .max(96)
  .regex(/^[1-9A-HJ-NP-Za-km-z]+$/, "invalid base58 signature");

export const usernameSchema = z
  .string()
  .min(3)
  .max(20)
  .regex(/^[A-Za-z0-9_]+$/, "username may only contain letters, digits and underscores");
export const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());
export const passwordSchema = z
  .string()
  .min(10, "password must be at least 10 characters")
  .max(128)
  .refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), "password must contain letters and digits");
/** Client-generated device identifier (random UUID persisted on the device). */
export const deviceIdSchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9_.:-]+$/);

export const currencySchema = z.enum(vals(Currency));
export const tradeCurrencySchema = z.enum(["CREDITS", "GEMS", "NEBX"]);
export const raritySchema = z.enum(vals(Rarity));
export const itemCategorySchema = z.enum(vals(ItemCategory));
export const resourceIdSchema = z.enum(vals(ResourceId));
export const clanRoleSchema = z.enum(vals(ClanRole));
export const chatChannelSchema = z.enum(vals(ChatChannel));
export const breakerModeSchema = z.enum(vals(CircuitBreakerMode));
export const adminRoleSchema = z.enum(vals(AdminRole));

/** True if the string contains C0 control characters (except tab/newline/CR) or DEL. */
export function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 127) return true;
  }
  return false;
}

/** Free text shown to other players: trimmed, no control characters. */
export const safeTextSchema = (max: number, min = 0) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((s) => !hasControlChars(s), "control characters are not allowed");

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: idSchema.optional(),
});
