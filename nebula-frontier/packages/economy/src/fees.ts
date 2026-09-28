import type { EconomyConfig } from "./config.js";
import { mulRatioCeil } from "./util.js";

export class FeeError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface WithdrawalQuote {
  requested: bigint;
  serviceFee: bigint;
  networkFee: bigint;
  final: bigint;
}

/** Marketplace sale: fee is rounded UP so the house never under-collects; seller gets the rest. */
export function marketplaceFee(price: bigint, cfg: Pick<EconomyConfig, "fees">): { fee: bigint; sellerProceeds: bigint } {
  if (price <= 0n) throw new FeeError("INVALID_AMOUNT", "Price must be positive");
  const fee = mulRatioCeil(price, cfg.fees.marketplace);
  return { fee, sellerProceeds: price - fee };
}

export function tradeTax(amount: bigint, cfg: Pick<EconomyConfig, "fees">): bigint {
  if (amount <= 0n) return 0n;
  return mulRatioCeil(amount, cfg.fees.tradeTax);
}

export function auctionFees(
  startPrice: bigint,
  finalPrice: bigint | null,
  cfg: Pick<EconomyConfig, "fees">
): { listingFee: bigint; saleFee: bigint; cancellationFee: bigint; sellerProceeds: bigint } {
  if (startPrice <= 0n) throw new FeeError("INVALID_AMOUNT", "Start price must be positive");
  const listingFee = mulRatioCeil(startPrice, cfg.fees.auctionListing);
  const cancellationFee = mulRatioCeil(startPrice, cfg.fees.auctionCancellation);
  const saleFee = finalPrice && finalPrice > 0n ? mulRatioCeil(finalPrice, cfg.fees.auctionSale) : 0n;
  return { listingFee, saleFee, cancellationFee, sellerProceeds: finalPrice ? finalPrice - saleFee : 0n };
}

/**
 * Withdrawal quote (all bigint, base units):
 *   serviceFee = ceil(requested * withdrawalServicePercent) + withdrawalFlat
 *   networkFee = estimatedNetworkFee (Solana base fee, paid by the treasury on chain)
 *   final      = requested - serviceFee - networkFee  (what arrives in the player's wallet)
 */
export function withdrawalQuote(requested: bigint, cfg: Pick<EconomyConfig, "fees">): WithdrawalQuote {
  if (requested <= 0n) throw new FeeError("INVALID_AMOUNT", "Amount must be positive");
  const serviceFee = mulRatioCeil(requested, cfg.fees.withdrawalServicePercent) + BigInt(cfg.fees.withdrawalFlat);
  const networkFee = BigInt(cfg.fees.estimatedNetworkFee);
  const final = requested - serviceFee - networkFee;
  if (final <= 0n) throw new FeeError("AMOUNT_TOO_SMALL", "Amount does not cover withdrawal fees");
  return { requested, serviceFee, networkFee, final };
}

export function quoteToDto(q: WithdrawalQuote): { requested: string; serviceFee: string; networkFee: string; final: string } {
  return { requested: q.requested.toString(), serviceFee: q.serviceFee.toString(), networkFee: q.networkFee.toString(), final: q.final.toString() };
}
