/** settleEndedAuctions: one failing auction is logged and never blocks the rest of the batch. */
import type { Db } from "@nebula/database";
import { describe, expect, it } from "vitest";
import { settleEndedAuctions } from "./auction.js";

describe("settleEndedAuctions", () => {
  it("continues past an auction whose settlement throws and logs it", async () => {
    const fakeDb = { auction: { findMany: async () => [{ id: "a1" }, { id: "bad" }, { id: "a3" }] } } as unknown as Db;
    const settled: string[] = [];
    const errors: object[] = [];
    const n = await settleEndedAuctions(fakeDb, 50, { error: (o) => errors.push(o) }, async (_db, id) => {
      if (id === "bad") throw new Error("serialization failure");
      settled.push(id);
      return true;
    });
    expect(n).toBe(2);
    expect(settled).toEqual(["a1", "a3"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ auctionId: "bad" });
  });
});
