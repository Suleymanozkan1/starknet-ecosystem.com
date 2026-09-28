/**
 * Money in game-core is integer base units as `bigint` (credits/gems are
 * integers; NEBX/SOL are lamports) — the same representation as the ledger.
 * Formula results (floats) are converted with ONE rounding rule: round half up
 * to the nearest integer unit. Non-finite or negative amounts are rejected.
 */
export function toMoney(value: number): bigint {
  if (!Number.isFinite(value)) throw new RangeError(`Invalid money amount: ${value}`);
  if (value < 0) throw new RangeError(`Money amount cannot be negative: ${value}`);
  return BigInt(Math.floor(value + 0.5));
}

/** Multiply an integer money amount by a non-negative integer quantity. */
export function mulMoney(amount: bigint, quantity: number): bigint {
  if (!Number.isSafeInteger(quantity) || quantity < 0) throw new RangeError(`Invalid quantity: ${quantity}`);
  return amount * BigInt(quantity);
}
