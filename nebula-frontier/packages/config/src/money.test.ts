import { describe, expect, it } from "vitest";
import economyJson from "../data/economy.json" with { type: "json" };
import shopJson from "../data/shop.json" with { type: "json" };
import { ECONOMY, SHOP, parseBaseUnits, parseEconomyConfigDoc, parseShopDoc } from "./index.js";

const clone = <T>(v: T): T => structuredClone(v);

describe("money documents (decimal-string base units → bigint)", () => {
  it("stores every money amount in economy.json / shop.json as a decimal integer string", () => {
    expect(economyJson.caps.daily).toBe("50000000");
    expect(economyJson.minTreasuryReserve).toBe("10000000000");
    for (const p of shopJson) expect(p.price, p.sku).toMatch(/^\d+$/);
  });

  it("parses economy.json money to bigint and keeps ratios/counts as numbers", () => {
    expect(ECONOMY.minTreasuryReserve).toBe(10_000_000_000n);
    expect(ECONOMY.caps).toEqual({ daily: 50_000_000n, weekly: 250_000_000n, season: 2_000_000_000n });
    expect(ECONOMY.fees.withdrawalFlat).toBe(1_000_000n);
    expect(ECONOMY.fees.estimatedNetworkFee).toBe(5_000n);
    expect(ECONOMY.withdrawal.min).toBe(10_000_000n);
    expect(ECONOMY.withdrawal.reviewThreshold).toBe(500_000_000n);
    expect(ECONOMY.circuitBreaker.depositSpikeFloorLamports).toBe(10_000_000_000n);
    expect(ECONOMY.tokenomics.maxSupply).toBe(1_000_000_000n);
    expect(ECONOMY.emission.rewardUnitLamports).toBe(100_000n);
    expect(ECONOMY.fees.marketplace).toBe(0.075);
    expect(ECONOMY.withdrawal.cooldownMinutes).toBe(60);
    expect(ECONOMY.risk.autoReviewWithdrawalRisk).toBe("MEDIUM");
  });

  it("keeps full precision above 2^53", () => {
    const doc = clone(economyJson);
    doc.caps.season = "123456789012345678901234567890";
    expect(parseEconomyConfigDoc(doc).caps.season).toBe(123456789012345678901234567890n);
  });

  it("rejects non-integer, negative, exponent and numeric money values with the offending path", () => {
    for (const bad of ["1.5", "-1", "1e9", "", " 10", "0x10"]) {
      const doc = clone(economyJson);
      doc.withdrawal.min = bad;
      expect(() => parseEconomyConfigDoc(doc), bad).toThrow(/withdrawal\.min/);
    }
    const numeric: Record<string, unknown> = clone(economyJson);
    numeric.minTreasuryReserve = 10_000_000_000;
    expect(() => parseEconomyConfigDoc(numeric)).toThrow(/minTreasuryReserve/);
  });

  it("rejects unknown and missing economy keys", () => {
    const extra: Record<string, unknown> = { ...clone(economyJson), bogus: 1 };
    expect(() => parseEconomyConfigDoc(extra)).toThrow(/bogus/);
    const missing: Record<string, unknown> = clone(economyJson);
    delete missing.caps;
    expect(() => parseEconomyConfigDoc(missing)).toThrow(/caps/);
  });

  it("parses shop prices to bigint and names the SKU on a bad price", () => {
    expect(SHOP.every((p) => typeof p.price === "bigint")).toBe(true);
    const wisp = SHOP.find((p) => p.sku === "sku_ship_wisp");
    expect(wisp?.price).toBe(60_000n);
    for (const bad of ["12.5", "-3", 60000, null]) {
      const doc: Record<string, unknown>[] = clone(shopJson);
      const first = doc[0] as Record<string, unknown>;
      first.price = bad;
      expect(() => parseShopDoc(doc), String(bad)).toThrow(/sku_ship_wisp/);
    }
  });

  it("parseBaseUnits accepts decimal strings, bigints and legacy safe-integer numbers only", () => {
    expect(parseBaseUnits("10000000000")).toBe(10_000_000_000n);
    expect(parseBaseUnits("90071992547409930000")).toBe(90071992547409930000n);
    expect(parseBaseUnits(7n)).toBe(7n);
    expect(parseBaseUnits(60_000_000)).toBe(60_000_000n);
    expect(parseBaseUnits(0)).toBe(0n);
    for (const bad of [1.5, -1, 2 ** 60, Number.NaN, "1.5", "-1", "1e9", "", "abc", -1n, null, undefined, true, {}]) {
      expect(parseBaseUnits(bad), String(bad)).toBeNull();
    }
  });
});
