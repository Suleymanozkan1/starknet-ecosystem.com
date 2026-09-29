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
  it("scrubs Basic credentials keeping the Basic prefix", () => {
    const basic = Buffer.from("admin:s3cr3t-pass").toString("base64");
    expect(scrubSecrets(`Authorization: Basic ${basic}`)).toBe("Authorization: Basic [REDACTED]");
    expect(scrubSecrets(`authorization: basic ${basic}`)).toBe("authorization: basic [REDACTED]");
    expect(scrubSecrets("Basic setup complete")).toBe("Basic setup complete");
  });
  it("scrubs URL userinfo credentials keeping the scheme and host", () => {
    expect(scrubSecrets("connect redis://default:hunter2@cache.internal:6379/0 failed"))
      .toBe("connect redis://[REDACTED]@cache.internal:6379/0 failed");
    expect(scrubSecrets("postgresql://nebula:pw%40x@db:5432/nebula")).toBe("postgresql://[REDACTED]@db:5432/nebula");
    expect(scrubSecrets("https://ghp_token123@github.com/org/repo")).toBe("https://[REDACTED]@github.com/org/repo");
    expect(scrubSecrets("see https://example.com/a@b")).toBe("see https://example.com/a@b");
  });
  it("err serializer scrubs string errors, passes other non-Errors through, keeps Error handling", async () => {
    const { lines, dest } = capture();
    const log = createLogger({ name: "test", destination: dest, level: "info" });
    log.error({ err: "failed with Bearer abc123token" }, "string err");
    log.error({ err: { code: 42 } }, "object err");
    log.error({ err: new Error("boom redis://u:p4ss@h:6379") }, "error err");
    await new Promise((r) => setImmediate(r));
    const [a, b, c] = lines.map((l) => JSON.parse(l) as { err: unknown });
    expect(a?.err).toBe("failed with Bearer [REDACTED]");
    expect(b?.err).toEqual({ code: 42 });
    expect(c?.err).toMatchObject({ type: "Error", message: "boom redis://[REDACTED]@h:6379" });
    expect(JSON.stringify(c)).not.toContain("p4ss");
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
