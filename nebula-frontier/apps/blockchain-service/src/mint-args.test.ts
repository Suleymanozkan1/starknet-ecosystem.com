/** mint-devnet-nft CLI input validation (runs before any signing or submission). */
import { describe, expect, it } from "vitest";
import { mintArgsSchema } from "../scripts/mint-devnet-nft.js";

const owner = "Hd6r6rGc8CNXRzYV8DwsU6vqh8aPM3711r2UC8Z3vbhe";
const ok = { owner, uri: "https://example.com/nft/ship.json", image: "https://example.com/nft/ship.png" };

describe("mintArgsSchema", () => {
  it("accepts a Solana owner and http(s) metadata URIs", () => {
    expect(mintArgsSchema.parse(ok)).toEqual(ok);
    expect(mintArgsSchema.safeParse({ ...ok, uri: "http://localhost:5173/nft/x.json" }).success).toBe(true);
  });

  it("rejects invalid owners and non-http URIs before a mint is signed", () => {
    for (const bad of [
      { ...ok, owner: "not-an-address" },
      { ...ok, owner: "0OIl".repeat(10) },
      { ...ok, uri: "javascript:alert(1)" },
      { ...ok, uri: "ftp://example.com/x.json" },
      { ...ok, uri: "not a url" },
      { ...ok, image: "data:image/png;base64,AAAA" }
    ]) {
      expect(mintArgsSchema.safeParse(bad).success).toBe(false);
    }
  });
});
