import { describe, expect, it } from "vitest";
import { main } from "../scripts/devnet-e2e.js";

describe("devnet e2e flow against the local mock RPC", () => {
  it("deposit → verify → credit → reward → withdrawal → payout confirmed", async () => {
    const r = await main(["node", "devnet-e2e", "--mock"]);
    expect(r.deposit.verified).toBe(true);
    expect(r.deposit.rejectedReplay).toBe("MEMO_MISMATCH");
    expect(r.payout.status).toBe("COMPLETED");
    expect(r.ledgerIntegrity).toBe(true);
  }, 60_000);
});
