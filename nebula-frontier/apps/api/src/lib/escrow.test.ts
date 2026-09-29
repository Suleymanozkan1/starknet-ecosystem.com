/** escrowItem rejects non-positive / fractional quantities before touching the database. */
import type { Tx } from "@nebula/database";
import { describe, expect, it } from "vitest";
import type { Catalog } from "./catalog.js";
import { escrowItem } from "./escrow.js";

const untouchable = new Proxy({}, { get: () => { throw new Error("database must not be touched"); } }) as unknown as Tx;

describe("escrowItem quantity validation", () => {
  for (const quantity of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    it(`rejects quantity ${quantity} with INVALID_QUANTITY`, async () => {
      await expect(
        escrowItem(untouchable, {} as unknown as Catalog, "u1", "inv1", quantity, async () => ({ id: "r1" }), "listing"),
      ).rejects.toMatchObject({ code: "INVALID_QUANTITY", statusCode: 400 });
    });
  }
});
