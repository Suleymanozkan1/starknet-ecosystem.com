/**
 * Platform wiring checks that don't need a device:
 *  - Capacitor shell config, Android App Links / custom scheme, iOS URL scheme + Associated Domains.
 *  - App lifecycle signal (visibility → pause/resume) used to stop rendering in the background.
 *  - Service health endpoints (/health, /ready, /metrics) on the real API app.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import config from "../../apps/mobile/capacitor.config.js";
import { setup, teardown, type TestCtx } from "./helpers.js";

const ROOT = resolve(import.meta.dirname, "../..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

describe("mobile shell (Capacitor)", () => {
  it("serves the built web app from a secure origin under the production app id", () => {
    expect(config.appId).toBe("com.nebulafrontier.app");
    expect(config.webDir).toBe("../web/dist");
    expect(config.server?.androidScheme).toBe("https");
    expect(config.android?.allowMixedContent).toBe(false);
    expect(config.plugins?.PushNotifications).toBeTruthy();
  });

  it("Android: custom scheme deep link + verified https App Link", () => {
    const manifest = read("apps/mobile/android/app/src/main/AndroidManifest.xml");
    expect(manifest).toContain('android:scheme="nebulafrontier"');
    expect(manifest).toMatch(/<intent-filter android:autoVerify="true">[\s\S]*android:scheme="https"[\s\S]*android:host="play\.nebulafrontier\.example"/);
  });

  it("iOS: URL scheme and Associated Domains (universal links) + push entitlement", () => {
    const plist = read("apps/mobile/ios/App/App/Info.plist");
    expect(plist).toMatch(/CFBundleURLSchemes[\s\S]*nebulafrontier/);
    const ent = read("apps/mobile/ios/App/App/App.entitlements");
    expect(ent).toContain("com.apple.developer.associated-domains");
    expect(ent).toContain("applinks:play.nebulafrontier.example");
    expect(ent).toContain("aps-environment");
  });
});

describe("app lifecycle (battery: pause rendering when hidden)", () => {
  it("emits inactive on visibility hidden and active again on visible", async () => {
    const handlers: (() => void)[] = [];
    const doc = {
      visibilityState: "visible",
      addEventListener: (type: string, fn: () => void) => { if (type === "visibilitychange") handlers.push(fn); },
    };
    (globalThis as { document?: unknown }).document = doc;
    const lifecycle = await import("../../apps/web/src/native/lifecycle.js");
    lifecycle.initLifecycle();
    const seen: boolean[] = [];
    const off = lifecycle.onAppActiveChange((a) => seen.push(a));
    doc.visibilityState = "hidden";
    handlers.forEach((h) => h());
    expect(lifecycle.isAppActive()).toBe(false);
    doc.visibilityState = "visible";
    handlers.forEach((h) => h());
    expect(seen).toEqual([false, true]);
    off();
    delete (globalThis as { document?: unknown }).document;
  });

  it("the Play screen wires lifecycle changes to the game's pause", () => {
    const play = read("apps/web/src/pages/Play.tsx") + read("apps/web/src/game/adapter.ts");
    expect(play).toMatch(/onAppActiveChange/);
    expect(play).toMatch(/setPaused/);
  });
});

describe("service health endpoints", () => {
  let ctx: TestCtx;
  beforeAll(async () => { ctx = await setup(); });
  afterAll(async () => { await teardown(ctx); });

  it("/health is live, /ready checks DB + Redis, /metrics exposes Prometheus text", async () => {
    const h = await ctx.app.inject({ method: "GET", url: "/health" });
    expect(h.statusCode).toBe(200);
    const r = await ctx.app.inject({ method: "GET", url: "/ready" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(/db|database/i);
    expect(r.body).toMatch(/redis/i);
    const m = await ctx.app.inject({ method: "GET", url: "/metrics" });
    expect([200, 401]).toContain(m.statusCode);
    if (m.statusCode === 200) expect(m.body).toMatch(/# (HELP|TYPE)/);
  });
});
