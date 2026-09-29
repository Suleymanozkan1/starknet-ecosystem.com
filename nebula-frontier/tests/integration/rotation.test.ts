/**
 * JWT key rotation end-to-end: tokens from the pre-rotation key keep working after a new key is
 * prepended to JWT_SECRETS; new tokens carry the new kid; retiring the old key rejects old tokens.
 * Game tickets follow GAME_TICKET_SECRETS the same way.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseKeyRing, verifyGameTicket } from "../../packages/authentication/src/index.js";
import { registerUser, setup, teardown, type TestCtx } from "./helpers.js";

const decodeProtectedHeader = (jwt: string): { kid?: string } => JSON.parse(Buffer.from(jwt.split(".")[0] ?? "", "base64url").toString("utf8")) as { kid?: string };

const OLD = process.env.JWT_SECRET ?? "";
const NEW = "rotated-jwt-secret-0123456789abcdef0123456789abcdef";
const TICKET_NEW = "rotated-ticket-secret-0123456789abcdef0123456789";

let before: TestCtx;
let after: TestCtx;
let retired: TestCtx;
beforeAll(async () => {
  before = await setup();
  after = await setup({ env: { JWT_SECRETS: `k2:${NEW},default:${OLD}`, GAME_TICKET_SECRETS: `t2:${TICKET_NEW},default:${process.env.GAME_TICKET_SECRET ?? ""}` } });
  retired = await setup({ env: { JWT_SECRETS: `k2:${NEW}` } });
});
afterAll(async () => {
  for (const c of [before, after, retired]) await teardown(c);
});

const me = (ctx: TestCtx, token: string) => ctx.app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${token}` } });

describe("JWT key rotation", () => {
  it("accepts old tokens during rotation and signs new ones with the new kid", async () => {
    const legacy = await registerUser(before.app);
    const oldToken = legacy.cookies.get("nf_access") ?? "";
    expect(decodeProtectedHeader(oldToken).kid).toBe("default");
    expect((await me(after, oldToken)).statusCode).toBe(200);

    const fresh = await registerUser(after.app);
    const newToken = fresh.cookies.get("nf_access") ?? "";
    expect(decodeProtectedHeader(newToken).kid).toBe("k2");
    expect((await me(after, newToken)).statusCode).toBe(200);
    // Instances that do not know k2 yet reject it; once the old key is retired, old tokens fail.
    expect((await me(before, newToken)).statusCode).toBe(401);
    expect((await me(retired, newToken)).statusCode).toBe(200);
    expect((await me(retired, oldToken)).statusCode).toBe(401);
  });

  it("rotates game ticket keys independently", async () => {
    const s = await registerUser(after.app);
    await s.req("POST", "/api/me/faction", { factionId: "aurora" });
    const { ticket } = (await s.req("POST", "/api/game/ticket", {})).json() as { ticket: string };
    expect(decodeProtectedHeader(ticket).kid).toBe("t2");
    const ring = parseKeyRing(`t2:${TICKET_NEW}`);
    expect((await verifyGameTicket(ticket, ring)).sub).toBe(s.userId);
    await expect(verifyGameTicket(ticket, process.env.GAME_TICKET_SECRET ?? "")).rejects.toThrow();
  });
});
