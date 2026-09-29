import { describe, expect, it } from "vitest";
import { translate } from "./i18n.js";

describe("i18n (EN/TR)", () => {
  it("translates navigation to Turkish", () => {
    expect(translate("en", "nav.inventory")).toBe("Inventory");
    expect(translate("tr", "nav.inventory")).toBe("Envanter");
  });

  it("every Turkish string is non-empty and differs from the key", () => {
    for (const key of ["nav.play", "nav.hangar", "nav.wallet", "nav.settings", "common.loading"] as const) {
      const tr = translate("tr", key);
      expect(tr.length).toBeGreaterThan(0);
      expect(tr).not.toBe(key);
    }
  });

  it("uses no investment terminology in either language", () => {
    const keys = ["common.battleRewards", "common.seasonRewards", "nav.wallet"] as const;
    for (const lang of ["en", "tr"] as const) for (const k of keys) expect(translate(lang, k)).not.toMatch(/APY|APR|ROI|interest|faiz|getiri/i);
  });
});
