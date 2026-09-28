/**
 * Money in game-core is integer base units as `bigint` (credits/gems are
 * integers; NEBX/SOL are lamports) — the same representation as the ledger.
 * Formula results (floats) are converted with ONE rounding rule: round half up
 * to the nearest integer unit. Non-finite, negative or unsafe-integer
 * (> Number.MAX_SAFE_INTEGER, already imprecise) amounts are rejected.
 */
export function toMoney(value: number): bigint {
  if (!Number.isFinite(value)) throw new RangeError(`Invalid money amount: ${value}`);
  if (value < 0) throw new RangeError(`Money amount cannot be negative: ${value}`);
  // Integers pass through unchanged: near 2^53, `value + 0.5` itself rounds up and would corrupt them.
  const rounded = Number.isInteger(value) ? value : Math.floor(value + 0.5);
  if (!Number.isSafeInteger(rounded)) throw new RangeError(`Money amount exceeds safe integer range: ${value}`);
  return BigInt(rounded);
}

/** Multiply an integer money amount by a non-negative integer quantity. */
export function mulMoney(amount: bigint, quantity: number): bigint {
  if (!Number.isSafeInteger(quantity) || quantity < 0) throw new RangeError(`Invalid quantity: ${quantity}`);
  return amount * BigInt(quantity);
}
