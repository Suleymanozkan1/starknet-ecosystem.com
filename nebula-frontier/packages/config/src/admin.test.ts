import { describe, expect, it } from "vitest";
import { ADMIN_LIMITS, adminLimitsSchema } from "./admin.js";

describe("admin limits", () => {
  it("loads the admin mail attachment caps from data/admin.json", () => {
    expect(ADMIN_LIMITS.mail).toEqual({ maxCredits: 10_000_000, maxGems: 100_000, maxResourceQuantity: 1_000_000, maxItemQuantity: 10_000, maxItemStacks: 20 });
  });

  it("rejects missing or non-positive caps", () => {
    expect(adminLimitsSchema.safeParse({ mail: { ...ADMIN_LIMITS.mail, maxCredits: 0 } }).success).toBe(false);
    expect(adminLimitsSchema.safeParse({ mail: { maxGems: 1 } }).success).toBe(false);
  });
});
