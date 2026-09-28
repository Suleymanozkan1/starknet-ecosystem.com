/**
 * Auth security: SIWS wallet login with a real ed25519 keypair, signature/nonce replay/expiry
 * rejection, CSRF double-submit enforcement, refresh rotation + reuse detection, RBAC.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateKeyPairSigner } from "@solana/kit";
import { parseRefreshToken } from "../../packages/authentication/src/index.js";
import { Session, setup, signMessage, teardown, walletLogin, registerUser, type TestCtx } from "./helpers.js";

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => {
  await teardown(ctx);
});

describe("wallet login (SIWS)", () => {
  it("logs in with a valid ed25519 signature, sets cookies and creates the user once", async () => {
    const signer = await generateKeyPairSigner();
    const s = new Session(ctx.app);
    const n = await s.req("POST", "/api/auth/nonce", { address: signer.address });
    expect(n.statusCode).toBe(200);
    const { nonce, message, expiresAt } = n.json() as { nonce: string; message: string; expiresAt: string };
    expect(message).toContain(signer.address);
    expect(message).toContain(`Nonce: ${nonce}`);
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());

    const v = await s.req("POST", "/api/auth/verify", { address: signer.address, nonce, signature: await signMessage(signer, message) });
    expect(v.statusCode).toBe(200);
    const body = v.json() as { user: { id: string; username: string; wallets: { address: string }[] }; csrfToken: string };
    expect(body.user.username).toMatch(/^pilot_[0-9a-f]{8}$/);
    expect(body.user.wallets[0]?.address).toBe(signer.address);
    const cookies = v.cookies as { name: string; httpOnly?: boolean; path?: string; sameSite?: string }[];
    const access = cookies.find((c) => c.name === "nf_access");
    const refresh = cookies.find((c) => c.name === "nf_refresh");
    const csrf = cookies.find((c) => c.name === "nf_csrf");
    expect(access?.httpOnly).toBe(true);
    expect(refresh?.httpOnly).toBe(true);
    expect(refresh?.path).toBe("/api/auth");
    expect(csrf?.httpOnly).toBeFalsy();
    expect(access?.sameSite).toBe("Lax");

    const me = await s.req("GET", "/api/me");
    expect(me.statusCode).toBe(200);
    expect((me.json() as { id: string }).id).toBe(body.user.id);

    // Second login with the same wallet reuses the account.
    const again = await walletLogin(ctx.app, signer);
    expect(again.s.userId).toBe(body.user.id);
    const wallets = await ctx.db.wallet.count({ where: { address: signer.address } });
    expect(wallets).toBe(1);
  });

  it("rejects an invalid signature", async () => {
    const signer = await generateKeyPairSigner();
    const other = await generateKeyPairSigner();
    const s = new Session(ctx.app);
    const { nonce, message } = (await s.req("POST", "/api/auth/nonce", { address: signer.address })).json() as { nonce: string; message: string };
    // Signed by a different key.
    const bad = await s.req("POST", "/api/auth/verify", { address: signer.address, nonce, signature: await signMessage(other, message) });
    expect(bad.statusCode).toBe(401);
    expect((bad.json() as { error: { code: string } }).error.code).toBe("INVALID_SIGNATURE");
    // Wrong message signed by the right key (nonce already burned => also rejected).
    const n2 = (await s.req("POST", "/api/auth/nonce", { address: signer.address })).json() as { nonce: string; message: string };
    const tampered = await s.req("POST", "/api/auth/verify", { address: signer.address, nonce: n2.nonce, signature: await signMessage(signer, `${n2.message}\nextra`) });
    expect(tampered.statusCode).toBe(401);
    expect((tampered.json() as { error: { code: string } }).error.code).toBe("INVALID_SIGNATURE");
    expect(await ctx.db.wallet.count({ where: { address: signer.address } })).toBe(0);
  });

  it("rejects a replayed nonce", async () => {
    const signer = await generateKeyPairSigner();
    const s = new Session(ctx.app);
    const { nonce, message } = (await s.req("POST", "/api/auth/nonce", { address: signer.address })).json() as { nonce: string; message: string };
    const signature = await signMessage(signer, message);
    const first = await s.req("POST", "/api/auth/verify", { address: signer.address, nonce, signature });
    expect(first.statusCode).toBe(200);
    const replay = await new Session(ctx.app).req("POST", "/api/auth/verify", { address: signer.address, nonce, signature });
    expect(replay.statusCode).toBe(401);
    expect((replay.json() as { error: { code: string } }).error.code).toBe("NONCE_USED");
  });

  it("allows only one of two concurrent verifications of the same nonce", async () => {
    const signer = await generateKeyPairSigner();
    const s = new Session(ctx.app);
    const { nonce, message } = (await s.req("POST", "/api/auth/nonce", { address: signer.address })).json() as { nonce: string; message: string };
    const signature = await signMessage(signer, message);
    const results = await Promise.all([0, 1, 2].map(() => new Session(ctx.app).req("POST", "/api/auth/verify", { address: signer.address, nonce, signature })));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
  });

  it("rejects an expired nonce", async () => {
    const signer = await generateKeyPairSigner();
    const s = new Session(ctx.app);
    const { nonce, message } = (await s.req("POST", "/api/auth/nonce", { address: signer.address })).json() as { nonce: string; message: string };
    await ctx.db.walletNonce.update({ where: { nonce }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await s.req("POST", "/api/auth/verify", { address: signer.address, nonce, signature: await signMessage(signer, message) });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: { code: string } }).error.code).toBe("NONCE_EXPIRED");
  });

  it("rejects a nonce presented for a different address", async () => {
    const a = await generateKeyPairSigner();
    const b = await generateKeyPairSigner();
    const s = new Session(ctx.app);
    const { nonce, message } = (await s.req("POST", "/api/auth/nonce", { address: a.address })).json() as { nonce: string; message: string };
    const res = await s.req("POST", "/api/auth/verify", { address: b.address, nonce, signature: await signMessage(b, message) });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: { code: string } }).error.code).toBe("INVALID_NONCE");
  });

  it("validates input and returns the ApiError shape with a request id", async () => {
    const res = await ctx.app.inject({ method: "POST", url: "/api/auth/nonce", payload: { address: "not-an-address" }, headers: { "x-request-id": "req-test-12345" } });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string; requestId: string; details: unknown } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.requestId).toBe("req-test-12345");
    expect(res.headers["x-request-id"]).toBe("req-test-12345");
  });
});

describe("CSRF double-submit", () => {
  it("rejects cookie-authenticated mutations without the x-nf-csrf header", async () => {
    const s = await registerUser(ctx.app);
    const noHeader = await s.req("PATCH", "/api/me", { username: `u_${Date.now().toString(36)}` }, { csrf: false });
    expect(noHeader.statusCode).toBe(403);
    expect((noHeader.json() as { error: { code: string } }).error.code).toBe("CSRF_FAILED");
    const wrong = await s.req("PATCH", "/api/me", { username: `u_${Date.now().toString(36)}` }, { csrf: false, headers: { "x-nf-csrf": "forged-token-value-000000000000" } });
    expect(wrong.statusCode).toBe(403);
    const ok = await s.req("PATCH", "/api/me", { username: `u_${Date.now().toString(36)}` });
    expect(ok.statusCode).toBe(200);
    // Safe methods need no CSRF header.
    expect((await s.req("GET", "/api/me", undefined, { csrf: false })).statusCode).toBe(200);
  });

  it("does not require CSRF for bearer-token clients", async () => {
    const s = await registerUser(ctx.app);
    const token = s.cookies.get("nf_access");
    const res = await ctx.app.inject({ method: "POST", url: "/api/notifications/read", headers: { authorization: `Bearer ${token}` }, payload: { all: true } });
    expect(res.statusCode).toBe(200);
  });
});

describe("sessions", () => {
  it("rotates refresh tokens and revokes every session on reuse", async () => {
    const s = await registerUser(ctx.app);
    const oldRefresh = s.cookies.get("nf_refresh");
    const r1 = await s.req("POST", "/api/auth/refresh");
    expect(r1.statusCode).toBe(200);
    expect(s.cookies.get("nf_refresh")).not.toBe(oldRefresh);

    // Attacker replays the rotated-out token (outside the short race grace window).
    await ctx.app.redis.del(`rt:grace:${parseRefreshToken(oldRefresh ?? "")?.hash}`);
    const thief = new Session(ctx.app);
    thief.cookies.set("nf_refresh", oldRefresh ?? "");
    thief.cookies.set("nf_csrf", s.cookies.get("nf_csrf") ?? "");
    const reuse = await thief.req("POST", "/api/auth/refresh");
    expect(reuse.statusCode).toBe(401);
    expect((reuse.json() as { error: { code: string } }).error.code).toBe("TOKEN_REUSE");
    // The legitimate session is revoked too.
    const me = await s.req("GET", "/api/me");
    expect(me.statusCode).toBe(401);
    const signals = await ctx.db.riskSignal.count({ where: { userId: s.userId, type: "REFRESH_TOKEN_REUSE" } });
    expect(signals).toBe(1);
  });

  it("logout revokes the session", async () => {
    const s = await registerUser(ctx.app);
    const access = s.cookies.get("nf_access");
    expect((await s.req("POST", "/api/auth/logout")).statusCode).toBe(200);
    const res = await ctx.app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${access}` } });
    expect(res.statusCode).toBe(401);
  });

  it("locks out after repeated password failures", async () => {
    const s = await registerUser(ctx.app);
    const me = (await s.req("GET", "/api/me")).json() as { email: string };
    const anon = new Session(ctx.app);
    for (let i = 0; i < 5; i++) {
      const r = await anon.req("POST", "/api/auth/login", { email: me.email, password: "wrong-password-1" });
      expect(r.statusCode).toBe(401);
    }
    const locked = await anon.req("POST", "/api/auth/login", { email: me.email, password: "correct-horse-42" });
    expect(locked.statusCode).toBe(429);
    expect((locked.json() as { error: { code: string } }).error.code).toBe("ACCOUNT_LOCKED");
  });
});

describe("RBAC", () => {
  it("rejects non-admins from admin routes (403) and anonymous (401)", async () => {
    const { s } = await walletLogin(ctx.app);
    const res = await s.req("GET", "/api/admin/overview");
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: { code: string } }).error.code).toBe("FORBIDDEN_ROLE");
    const ban = await s.req("POST", `/api/admin/users/${s.userId}/ban`, { reason: "self test" });
    expect(ban.statusCode).toBe(403);
    const anon = await ctx.app.inject({ method: "GET", url: "/api/admin/overview" });
    expect(anon.statusCode).toBe(401);
  });

  it("allows admins and audits mutations", async () => {
    const admin = await registerUser(ctx.app);
    await ctx.db.adminUser.create({ data: { userId: admin.userId, roles: ["MODERATOR"] } });
    const target = await registerUser(ctx.app);
    const overview = await admin.req("GET", "/api/admin/overview");
    expect(overview.statusCode).toBe(200);
    const mute = await admin.req("POST", `/api/admin/users/${target.userId}/mute`, { reason: "spam in chat", minutes: 10 });
    expect(mute.statusCode).toBe(200);
    const log = await ctx.db.auditLog.findFirst({ where: { action: "USER_MUTE", targetId: target.userId } });
    expect(log?.actorId).toBe(admin.userId);
    expect(log?.reason).toBe("spam in chat");
    // Moderators cannot manage shop products.
    expect((await admin.req("GET", "/api/admin/shop/products")).statusCode).toBe(403);
    // Ban revokes the target's sessions.
    expect((await admin.req("POST", `/api/admin/users/${target.userId}/ban`, { reason: "cheating confirmed" })).statusCode).toBe(200);
    expect((await target.req("GET", "/api/me")).statusCode).toBe(401);
  });
});
