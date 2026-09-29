/** RPC failures are sanitised before logging (no endpoint URLs / credentials). */
import { describe, expect, it } from "vitest";
import { sanitizeRpcError } from "./admin-economy.js";

describe("sanitizeRpcError", () => {
  it("redacts URLs (with API keys or basic auth) from the message and keeps name/code", () => {
    const err = Object.assign(new Error("fetch failed: https://user:pass@rpc.example.com/v2/SECRETKEY?api-key=abc (ECONNREFUSED)"), { code: "ECONNREFUSED" });
    const s = sanitizeRpcError(err);
    expect(s.message).not.toMatch(/SECRETKEY|pass|api-key|rpc\.example\.com/);
    expect(s.message).toContain("<redacted-url>");
    expect(s).toMatchObject({ name: "Error", code: "ECONNREFUSED" });
  });

  it("handles non-Error values", () => {
    expect(sanitizeRpcError("wss://rpc.example.com/?token=abc down").message).toBe("<redacted-url> down");
  });
});
