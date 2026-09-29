/** Production environment guards: explicit DATABASE_URL and a strong METRICS_TOKEN are mandatory. */
import { describe, expect, it } from "vitest";
import { DEV_DATABASE_URL, loadEnv } from "./env.js";

const PROD = {
  NODE_ENV: "production",
  JWT_SECRET: "k".repeat(48),
  GAME_TICKET_SECRET: "g".repeat(48),
  DATABASE_URL: "postgresql://api:strong@db.internal:5432/nebula",
  METRICS_TOKEN: "m".repeat(32),
};

describe("loadEnv production guards", () => {
  it("accepts a complete production environment", () => {
    const env = loadEnv(PROD);
    expect(env.isProd).toBe(true);
    expect(env.DATABASE_URL).toBe(PROD.DATABASE_URL);
  });

  it("refuses the local development DATABASE_URL default in production", () => {
    const { DATABASE_URL: _omit, ...noDb } = PROD;
    expect(() => loadEnv(noDb)).toThrow(/DATABASE_URL/);
    expect(() => loadEnv({ ...PROD, DATABASE_URL: DEV_DATABASE_URL })).toThrow(/DATABASE_URL/);
  });

  it("requires METRICS_TOKEN of at least 32 characters in production", () => {
    const { METRICS_TOKEN: _omit, ...noToken } = PROD;
    expect(() => loadEnv(noToken)).toThrow(/METRICS_TOKEN/);
    expect(() => loadEnv({ ...PROD, METRICS_TOKEN: "short-token" })).toThrow(/METRICS_TOKEN/);
  });

  it("keeps development defaults usable outside production", () => {
    const env = loadEnv({ NODE_ENV: "development", JWT_SECRET: PROD.JWT_SECRET, GAME_TICKET_SECRET: PROD.GAME_TICKET_SECRET });
    expect(env.DATABASE_URL).toBe(DEV_DATABASE_URL);
    expect(env.METRICS_TOKEN).toBeUndefined();
  });
});
