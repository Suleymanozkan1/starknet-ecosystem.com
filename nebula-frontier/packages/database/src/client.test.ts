import { describe, expect, it } from "vitest";
import { DEFAULT_DB_POOL_SIZE, parsePoolSize } from "./client.js";

describe("parsePoolSize", () => {
  it("defaults when unset or blank", () => {
    expect(parsePoolSize(undefined)).toBe(DEFAULT_DB_POOL_SIZE);
    expect(parsePoolSize("  ")).toBe(DEFAULT_DB_POOL_SIZE);
  });

  it("accepts positive integers", () => {
    expect(parsePoolSize("1")).toBe(1);
    expect(parsePoolSize(" 25 ")).toBe(25);
  });

  it.each(["abc", "0", "-3", "2.5", "1e3", "NaN", "99999999999999999999"])("rejects %j", (raw) => {
    expect(() => parsePoolSize(raw)).toThrow(/DB_POOL_SIZE/);
  });
});
