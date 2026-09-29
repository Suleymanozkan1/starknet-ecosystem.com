/** Every API response (not only /api/*) carries cache-control: no-store plus request/correlation ids. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setup, teardown, type TestCtx } from "./helpers.js";

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => {
  await teardown(ctx);
});

describe("response headers", () => {
  for (const url of ["/health", "/metrics", "/api/does-not-exist", "/not-an-api-route"]) {
    it(`sets no-store and request ids on ${url}`, async () => {
      const res = await ctx.app.inject({ method: "GET", url, headers: { "x-request-id": "req-abcdef12" } });
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.headers["x-request-id"]).toBe("req-abcdef12");
      expect(res.headers["x-correlation-id"]).toBeTruthy();
    });
  }
});
