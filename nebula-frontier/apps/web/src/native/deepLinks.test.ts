import { describe, expect, it } from "vitest";
import { deepLinkToRoute } from "./deepLinks.js";

const HOSTS = ["play.nebulafrontier.example"];

describe("deepLinkToRoute", () => {
  it("maps the custom scheme host to the first route segment", () => {
    expect(deepLinkToRoute("nebulafrontier://wallet", HOSTS)).toBe("/wallet");
    expect(deepLinkToRoute("nebulafrontier://wallet/return?sig=abc", HOSTS)).toBe("/wallet/return?sig=abc");
    expect(deepLinkToRoute("nebulafrontier://hangar", HOSTS)).toBe("/hangar");
  });
  it("accepts https links only for whitelisted hosts", () => {
    expect(deepLinkToRoute("https://play.nebulafrontier.example/events/rift_1", HOSTS)).toBe("/events/rift_1");
    expect(deepLinkToRoute("https://evil.example/wallet", HOSTS)).toBeNull();
    expect(deepLinkToRoute("http://play.nebulafrontier.example/wallet", HOSTS)).toBeNull();
    expect(deepLinkToRoute("https://play.nebulafrontier.example:8443/wallet", HOSTS)).toBeNull();
  });
  it("rejects unknown routes, traversal and other schemes", () => {
    expect(deepLinkToRoute("nebulafrontier://admin", HOSTS)).toBeNull();
    expect(deepLinkToRoute("nebulafrontier://wallet/../admin", HOSTS)).toBeNull();
    expect(deepLinkToRoute("nebulafrontier://hangar/extra/depth", HOSTS)).toBeNull();
    expect(deepLinkToRoute("javascript:alert(1)", HOSTS)).toBeNull();
    expect(deepLinkToRoute("not a url", HOSTS)).toBeNull();
  });
  it("drops suspicious query keys", () => {
    expect(deepLinkToRoute("nebulafrontier://shop?cat=GEMS&<x>=1", HOSTS)).toBe("/shop?cat=GEMS");
  });
});
