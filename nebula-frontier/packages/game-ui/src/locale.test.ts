import { afterEach, describe, expect, it } from "vitest";
import { formatAmount } from "./CurrencyAmount.js";
import { formatDuration } from "./Countdown.js";
import { DEFAULT_UI_LOCALE, setUiLocale, uiLocale } from "./locale.js";

afterEach(() => setUiLocale({}));

describe("UI kit locale", () => {
  it("defaults to the original English formatting", () => {
    expect(uiLocale()).toEqual(DEFAULT_UI_LOCALE);
    expect(formatAmount("1234567", "CREDITS")).toBe("1,234,567");
    expect(formatAmount("1500000000", "NEBX")).toBe("1.5");
    expect(formatAmount("25000", "GEMS", { compact: true })).toBe("25.0K");
    expect(formatDuration(3 * 86_400_000 + 2 * 3_600_000 + 5 * 60_000)).toBe("3d 02h 05m");
    expect(formatDuration(0, { showSeconds: false })).toBe("0m");
  });

  it("applies host-provided separators, compact suffixes and units", () => {
    setUiLocale({
      groupSeparator: ".",
      decimalSeparator: ",",
      compact: { thousand: "B", million: "Mn", billion: "Mr" },
      units: { day: "g", hour: "sa", minute: "dk" },
    });
    expect(formatAmount("1234567", "CREDITS")).toBe("1.234.567");
    expect(formatAmount("1500000000", "NEBX")).toBe("1,5");
    expect(formatAmount("25000", "GEMS", { compact: true })).toBe("25,0B");
    expect(formatDuration(3 * 86_400_000 + 2 * 3_600_000 + 5 * 60_000)).toBe("3g 02sa 05dk");
  });

  it("falls back to defaults for fields that are not provided", () => {
    setUiLocale({ ended: "Sona erdi" });
    expect(uiLocale().ended).toBe("Sona erdi");
    expect(uiLocale().close).toBe("Close");
    expect(uiLocale().groupSeparator).toBe(",");
  });
});
