/** Stored feature-flag rules are validated; malformed rules fail closed. */
import { describe, expect, it } from "vitest";
import { parseFlagRules } from "./core.js";

describe("parseFlagRules", () => {
  it("accepts empty/missing rules and valid rule sets", () => {
    expect(parseFlagRules(null)).toEqual({});
    expect(parseFlagRules(undefined)).toEqual({});
    expect(parseFlagRules({ allowCountries: ["DE", "FR"], minAge: 18, requireKyc: "BASIC", maxRiskLevel: "MEDIUM" })).toEqual({
      allowCountries: ["DE", "FR"], minAge: 18, requireKyc: "BASIC", maxRiskLevel: "MEDIUM",
    });
  });

  it("rejects malformed rules instead of trusting a cast", () => {
    expect(parseFlagRules({ allowCountries: "DE" })).toBeNull();
    expect(parseFlagRules({ minAge: "18" })).toBeNull();
    expect(parseFlagRules({ requireKyc: "PLATINUM" })).toBeNull();
    expect(parseFlagRules({ maxRiskLevel: "EXTREME" })).toBeNull();
    expect(parseFlagRules(["not", "an", "object"])).toBeNull();
    expect(parseFlagRules("x")).toBeNull();
  });
});
