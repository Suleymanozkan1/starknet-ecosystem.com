/** flagRisk stays non-throwing but logs a lost risk signal. */
import { afterEach, describe, expect, it } from "vitest";
import { configureEconomyLog, flagRisk } from "./economy.js";

type RiskDb = Parameters<typeof flagRisk>[0];

afterEach(() => configureEconomyLog(null));

describe("flagRisk", () => {
  it("swallows recording failures and logs a warning with context", async () => {
    const warnings: { obj: object; msg: string | undefined }[] = [];
    configureEconomyLog({ warn: (obj, msg) => warnings.push({ obj, msg }) });
    const broken = new Proxy({}, { get: () => { throw new Error("db down"); } }) as unknown as RiskDb;
    await expect(flagRisk(broken, "u1", "TRADE_EXPLOIT", 15, { a: 1 }, "marketplace")).resolves.toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.msg).toBe("risk signal not recorded");
    expect(warnings[0]?.obj).toMatchObject({ userId: "u1", riskType: "TRADE_EXPLOIT", source: "marketplace", err: "db down" });
  });

  it("does not throw without a configured logger", async () => {
    const broken = new Proxy({}, { get: () => { throw new Error("db down"); } }) as unknown as RiskDb;
    await expect(flagRisk(broken, "u1", "X", 1, {})).resolves.toBeUndefined();
  });
});
