import { formatUnits } from "@nebula/shared";
import type { Currency } from "@nebula/shared";
import { cx } from "./cx.js";
import { Icon } from "./Icon.js";
import { uiLocale } from "./locale.js";

/** Display metadata per currency. `decimals` matches the ledger base units. */
export const CURRENCY_META: Record<Currency, { decimals: number; symbol: string; color: string; icon: "credits" | "gems" | "crypto" }> = {
  CREDITS: { decimals: 0, symbol: "CR", color: "var(--nf-credits)", icon: "credits" },
  GEMS: { decimals: 0, symbol: "GEM", color: "var(--nf-gems)", icon: "gems" },
  NEBX: { decimals: 9, symbol: "NEBX", color: "var(--nf-crypto)", icon: "crypto" },
  SOL: { decimals: 9, symbol: "SOL", color: "var(--nf-crypto)", icon: "crypto" },
};

function groupDigits(s: string): string {
  const { groupSeparator, decimalSeparator } = uiLocale();
  const [whole = "0", frac] = s.split(".");
  const neg = whole.startsWith("-");
  const digits = neg ? whole.slice(1) : whole;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, groupSeparator);
  return `${neg ? "-" : ""}${grouped}${frac ? decimalSeparator + frac : ""}`;
}

/** Display symbol of a currency in the active UI locale. */
export function currencySymbol(currency: Currency): string {
  return uiLocale().currencySymbols[currency] ?? CURRENCY_META[currency].symbol;
}

/** Formats integer base units (string/bigint/number) into a human amount. */
export function formatAmount(amount: string | bigint | number, currency: Currency, opts: { maxFraction?: number; decimals?: number; compact?: boolean } = {}): string {
  const decimals = opts.decimals ?? CURRENCY_META[currency].decimals;
  let raw: bigint;
  try {
    raw = typeof amount === "bigint" ? amount : BigInt(typeof amount === "number" ? Math.trunc(amount) : amount || "0");
  } catch {
    return "—";
  }
  if (opts.compact && decimals === 0) {
    const n = Number(raw);
    const { compact, decimalSeparator } = uiLocale();
    const fix = (v: number, digits: number): string => v.toFixed(digits).replace(".", decimalSeparator);
    if (Math.abs(n) >= 1_000_000_000) return `${fix(n / 1_000_000_000, 2)}${compact.billion}`;
    if (Math.abs(n) >= 1_000_000) return `${fix(n / 1_000_000, 2)}${compact.million}`;
    if (Math.abs(n) >= 10_000) return `${fix(n / 1_000, 1)}${compact.thousand}`;
  }
  return groupDigits(formatUnits(raw, decimals, opts.maxFraction ?? (decimals > 0 ? 4 : 0)));
}

export interface CurrencyAmountProps {
  amount: string | bigint | number;
  currency: Currency;
  /** Override symbol text (e.g. reward asset symbol from the API). */
  symbol?: string;
  decimals?: number;
  maxFraction?: number;
  compact?: boolean;
  showIcon?: boolean;
  showSymbol?: boolean;
  size?: number;
  className?: string;
}

export function CurrencyAmount({
  amount, currency, symbol, decimals, maxFraction, compact, showIcon = true, showSymbol = true, size = 16, className,
}: CurrencyAmountProps) {
  const meta = CURRENCY_META[currency];
  const fmtOpts: { maxFraction?: number; decimals?: number; compact?: boolean } = {};
  if (maxFraction !== undefined) fmtOpts.maxFraction = maxFraction;
  if (decimals !== undefined) fmtOpts.decimals = decimals;
  if (compact !== undefined) fmtOpts.compact = compact;
  return (
    <span className={cx("nf-currency", className)} style={{ fontSize: size }}>
      {showIcon && <Icon name={meta.icon} size={Math.round(size * 1.05)} style={{ color: meta.color }} />}
      <span>{formatAmount(amount, currency, fmtOpts)}</span>
      {showSymbol && <span className="nf-currency__sym">{symbol ?? currencySymbol(currency)}</span>}
    </span>
  );
}
