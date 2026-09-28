import { describe, expect, it } from "vitest";
import { decodeProtectedHeader } from "jose";
import { keyRingFromEnv, parseKeyRing, signAccessToken, signGameTicket, verifyAccessToken, verifyGameTicket } from "./tokens.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const claims = { sub: "user_1", username: "pilot", roles: ["ADMIN"], sid: "s1" };

describe("JWT key rotation", () => {
  it("parses kid:secret lists with the first key active", () => {
    const ring = parseKeyRing(`k2:${B}, k1:${A}`);
    expect(ring.active.kid).toBe("k2");
    expect(ring.keys.map((k) => k.kid)).toEqual(["k2", "k1"]);
  });

  it("falls back to the legacy single secret", () => {
    const ring = keyRingFromEnv("JWT", { JWT_SECRET: A });
    expect(ring.active).toEqual({ kid: "default", secret: A });
    expect(keyRingFromEnv("GAME_TICKET", { GAME_TICKET_SECRETS: `g1:${C}`, GAME_TICKET_SECRET: A }).active.kid).toBe("g1");
  });

  it("rejects malformed lists and short secrets", () => {
    expect(() => parseKeyRing("nocolon")).toThrow();
    expect(() => parseKeyRing("k1:short")).toThrow();
    expect(() => parseKeyRing(`k1:${A},k1:${B}`)).toThrow();
    expect(() => parseKeyRing("", "short")).toThrow();
    expect(() => parseKeyRing("bad kid!:" + A)).toThrow();
  });

  it("signs with the active kid and verifies tokens from any listed key", async () => {
    const old = parseKeyRing(`k1:${A}`);
    const rotated = parseKeyRing(`k2:${B},k1:${A}`);
    const oldToken = await signAccessToken(claims, old);
    const newToken = await signAccessToken(claims, rotated);
    expect(decodeProtectedHeader(newToken).kid).toBe("k2");
    expect((await verifyAccessToken(oldToken, rotated)).sub).toBe("user_1");
    expect((await verifyAccessToken(newToken, rotated)).roles).toEqual(["ADMIN"]);
    // After the old key is retired, its tokens are rejected.
    await expect(verifyAccessToken(oldToken, parseKeyRing(`k2:${B}`))).rejects.toThrow();
    // Unknown kid is rejected even if a same-named secret would verify.
    await expect(verifyAccessToken(newToken, parseKeyRing(`k9:${B}`))).rejects.toThrow();
  });

  it("keeps plain string secrets backwards compatible (no kid)", async () => {
    const t = await signAccessToken(claims, A);
    expect(decodeProtectedHeader(t).kid).toBeUndefined();
    expect((await verifyAccessToken(t, A)).sid).toBe("s1");
    // Legacy kid-less tokens verify against a ring containing the key.
    expect((await verifyAccessToken(t, parseKeyRing(`k2:${B},k1:${A}`))).sub).toBe("user_1");
    await expect(verifyAccessToken(t, B)).rejects.toThrow();
  });

  it("applies to game tickets with audience separation", async () => {
    const ring = parseKeyRing(`g2:${C},g1:${A}`);
    const ticket = await signGameTicket({ sub: "u", username: "p", mapId: "map_x", jti: "j1" }, ring);
    expect((await verifyGameTicket(ticket, ring)).mapId).toBe("map_x");
    expect((await verifyGameTicket(ticket, C)).jti).toBe("j1");
    await expect(verifyAccessToken(ticket, ring)).rejects.toThrow();
  });
});
