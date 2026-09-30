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

  it("--settlement: the payout goes through verify_reward from the program vault, once", async () => {
    const r = await main(["node", "devnet-e2e", "--mock", "--settlement"]);
    expect(r.payout.status).toBe("COMPLETED");
    expect(r.payout.mode).toBe("settlement");
    expect(r.settlement?.receipt.amount).toBe(r.payout.final);
    expect(r.settlement?.fundSignature).toBeTruthy(); // mock vault starts empty → funded from the treasury
    expect(r.settlement?.duplicateRejected).toBe(true);
    expect(r.ledgerIntegrity).toBe(true);
  }, 60_000);
});
