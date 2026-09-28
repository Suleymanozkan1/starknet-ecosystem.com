import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Call = { url: string; init: RequestInit };

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

describe("http client (cookie auth contract)", () => {
  let calls: Call[];
  let responses: Response[];

  beforeEach(() => {
    vi.resetModules();
    calls = [];
    responses = [];
    vi.stubGlobal("document", { cookie: "nf_csrf=csrf-token-123; other=1" });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const r = responses.shift();
      if (!r) throw new Error("unexpected fetch");
      return r;
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sends credentials and the CSRF header on mutations only", async () => {
    const { http } = await import("./http.js");
    responses.push(json(200, { ok: 1 }), json(200, { ok: 2 }));
    await http.get("/api/me");
    await http.post("/api/shop/purchase", { productId: "x" });
    expect(calls[0]!.init.credentials).toBe("include");
    expect((calls[0]!.init.headers as Record<string, string>)["x-nf-csrf"]).toBeUndefined();
    expect((calls[1]!.init.headers as Record<string, string>)["x-nf-csrf"]).toBe("csrf-token-123");
    expect(calls[1]!.init.body).toBe(JSON.stringify({ productId: "x" }));
  });

  it("refreshes once on 401 and retries the request", async () => {
    const { http } = await import("./http.js");
    responses.push(json(401, { error: { code: "UNAUTHORIZED", message: "no" } }), json(200, {}), json(200, { id: "u1" }));
    const me = await http.get<{ id: string }>("/api/me");
    expect(me.id).toBe("u1");
    expect(calls.map((c) => c.url)).toEqual(["/api/me", "/api/auth/refresh", "/api/me"]);
    expect(calls[1]!.init.method).toBe("POST");
  });

  it("surfaces the API error model and notifies when the session is gone", async () => {
    const { http, onUnauthorized, ApiRequestError } = await import("./http.js");
    const spy = vi.fn();
    onUnauthorized(spy);
    responses.push(json(401, { error: { code: "UNAUTHORIZED", message: "expired" } }), json(401, {}), json(401, { error: { code: "UNAUTHORIZED", message: "expired" } }));
    await expect(http.get("/api/me")).rejects.toBeInstanceOf(ApiRequestError);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("never persists tokens in web storage", async () => {
    const setItem = vi.fn();
    vi.stubGlobal("localStorage", { setItem, getItem: () => null });
    const { http } = await import("./http.js");
    responses.push(json(200, { user: {}, csrfToken: "abc" }));
    await http.post("/api/auth/login", { email: "a@b.c", password: "x" }, { noRefresh: true });
    expect(setItem).not.toHaveBeenCalled();
  });
});
