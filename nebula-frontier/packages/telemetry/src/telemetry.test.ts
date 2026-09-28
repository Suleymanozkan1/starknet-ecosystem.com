import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger, scrubSecrets } from "./logger.js";
import { correlationId, sanitizeCorrelationId, withCorrelation } from "./ids.js";
import { activePlayers, metricsText } from "./metrics.js";

function capture() {
  const lines: string[] = [];
  const dest = new Writable({ write(chunk, _enc, cb) { lines.push(String(chunk)); cb(); } });
  return { lines, dest };
}

describe("logger redaction", () => {
  it("redacts secret fields and scrubs JWTs from messages", async () => {
    const { lines, dest } = capture();
    const log = createLogger({ name: "test", destination: dest, level: "info" });
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    log.info({ ticket: jwt, user: { password: "hunter2", privateKey: "abc" }, req: { headers: { cookie: "nf_access=x", authorization: "Bearer y" } }, signature: "sig" }, `joined with ${jwt}`);
    await new Promise((r) => setImmediate(r));
    const out = lines.join("");
    expect(out).not.toContain(jwt);
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("nf_access=x");
    expect(out).not.toContain("\"sig\"");
    expect(out).toContain("[REDACTED]");
  });
  it("scrubs byte-array keys and bearer tokens", () => {
    const key = `[${Array.from({ length: 64 }, (_, i) => i).join(",")}]`;
    expect(scrubSecrets(`secret=${key}`)).not.toContain("63");
    expect(scrubSecrets("Authorization: Bearer abc.def")).toBe("Authorization: Bearer [REDACTED]");
  });
});

describe("correlation ids", () => {
  it("propagates through async calls", async () => {
    await withCorrelation({ correlationId: "req-12345678" }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      expect(correlationId()).toBe("req-12345678");
    });
    expect(correlationId()).toBeUndefined();
    expect(sanitizeCorrelationId("bad id!")).not.toBe("bad id!");
  });
});

describe("metrics", () => {
  it("renders prometheus text", async () => {
    activePlayers.set({ room: "sector", map: "m" }, 3);
    const t = await metricsText();
    expect(t).toContain("nebula_active_players");
    expect(t).toContain("nebula_tick_duration_seconds");
  });
});
