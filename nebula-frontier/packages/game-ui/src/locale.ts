/**
 * Tiny locale hook-point for the UI kit. The kit never imports app code: the host app (apps/web) pushes
 * its current language strings / number format here via `setUiLocale`, and components read them at render.
 * Defaults reproduce the original English output exactly.
 */
export interface UiLocale {
  /** BCP-47 tag for `toLocaleString` (undefined = browser default). */
  locale: string | undefined;
  /** Separators used by `formatAmount`. */
  groupSeparator: string;
  decimalSeparator: string;
  /** Compact suffixes used by `formatAmount({ compact: true })`. */
  compact: { thousand: string; million: string; billion: string };
  /** Duration unit suffixes used by `formatDuration`. */
  units: { day: string; hour: string; minute: string };
  /** Countdown text once the target is reached. */
  ended: string;
  /** Accessible label of the modal close button. */
  close: string;
  /** Display labels per rarity id (fallback: lower-cased id). */
  rarity: Readonly<Record<string, string>>;
  /** Currency symbol overrides (fallback: CURRENCY_META symbol). */
  currencySymbols: Readonly<Record<string, string>>;
}

export const DEFAULT_UI_LOCALE: UiLocale = {
  locale: undefined,
  groupSeparator: ",",
  decimalSeparator: ".",
  compact: { thousand: "K", million: "M", billion: "B" },
  units: { day: "d", hour: "h", minute: "m" },
  ended: "Ended",
  close: "Close",
  rarity: {},
  currencySymbols: {},
};

let current: UiLocale = DEFAULT_UI_LOCALE;

/** Replaces the active UI-kit locale (missing fields fall back to the English defaults). */
export function setUiLocale(next: Partial<UiLocale>): void {
  current = { ...DEFAULT_UI_LOCALE, ...next };
}

export function uiLocale(): UiLocale {
  return current;
}
