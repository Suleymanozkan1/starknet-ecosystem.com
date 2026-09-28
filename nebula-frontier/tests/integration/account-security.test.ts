/**
 * SEC-07 account security through the real auth routes:
 *  - device tracking: first device is silent, a new device notifies the owner, and a new device
 *    from an IP the account has never used also raises a SUSPICIOUS_LOGIN risk signal;
 *  - wallet change lock: linking a wallet notifies + scores the change and locks withdrawals for
 *    `walletChangeLockHours` (whole account, not just the new wallet); the lock lifts afterwards.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateKeyPairSigner } from "@solana/kit";
import { checkWithdrawal, loadEconomyConfig, walletChangeLockUntil } from "../../packages/economy/src/index.js";
import { registerUser, setup, signMessage, teardown, walletLogin, type Session, type TestCtx } from "./helpers.js";

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => {
  await teardown(ctx);
});

const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/128 Mobile Safari/537.36";
const DESKTOP_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128 Safari/537.36";

async function login(email: string, o: { deviceId?: string; ip?: string; ua?: string } = {}) {
  const res = await ctx.app.inject({
    method: "POST",
    url: "/api/auth/login",
    remoteAddress: o.ip ?? "127.0.0.1",
    headers: { "user-agent": o.ua ?? DESKTOP_UA },
    payload: { email, password: "correct-horse-42", ...(o.deviceId ? { deviceId: o.deviceId } : {}) },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res;
}
const newDeviceNotes = (userId: string) => ctx.db.notification.findMany({ where: { userId, type: "SECURITY_NEW_DEVICE" }, orderBy: { createdAt: "asc" } });
const suspicious = (userId: string) => ctx.db.riskSignal.findMany({ where: { userId, type: "SUSPICIOUS_LOGIN" } });
const dev = () => `dev-${randomUUID()}`;

describe("SEC-07 new device / suspicious login", () => {
  it("first device is silent; known device is not re-flagged; new device notifies; new device + unseen IP is suspicious", async () => {
    const devA = dev();
    const s = await registerUser(ctx.app, devA);
    const email = (await ctx.db.user.findUniqueOrThrow({ where: { id: s.userId } })).email ?? "";
    const devices = await ctx.db.device.findMany({ where: { userId: s.userId } });
    expect(devices.map((d) => d.fingerprint)).toEqual([`d:${devA}`]);
    expect(await newDeviceNotes(s.userId)).toHaveLength(0);

    // Same device again: last-seen is refreshed, nothing is raised.
    const seen0 = devices[0]?.lastSeenAt.getTime() ?? 0;
    await login(email, { deviceId: devA });
    expect(await ctx.db.device.count({ where: { userId: s.userId } })).toBe(1);
    const refreshed = await ctx.db.device.findUniqueOrThrow({ where: { userId_fingerprint: { userId: s.userId, fingerprint: `d:${devA}` } } });
    expect(refreshed.lastSeenAt.getTime()).toBeGreaterThanOrEqual(seen0);
    expect(await newDeviceNotes(s.userId)).toHaveLength(0);

    // New device, but from an IP this account already signed in from: notify, not suspicious.
    const devB = dev();
    await login(email, { deviceId: devB, ua: ANDROID_UA });
    const notes = await newDeviceNotes(s.userId);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.data).toMatchObject({ platform: "android" });
    expect((await ctx.db.device.findUniqueOrThrow({ where: { userId_fingerprint: { userId: s.userId, fingerprint: `d:${devB}` } } })).platform).toBe("android");
    expect(await suspicious(s.userId)).toHaveLength(0);
    expect((await ctx.db.user.findUniqueOrThrow({ where: { id: s.userId } })).riskScore).toBe(0);

    // New device from an unseen IP: notify + SUSPICIOUS_LOGIN risk signal (score feeds the user's risk score).
    const devC = dev();
    const res = await login(email, { deviceId: devC, ip: "203.0.113.77" });
    expect(await newDeviceNotes(s.userId)).toHaveLength(2);
    const sig = await suspicious(s.userId);
    expect(sig).toHaveLength(1);
    expect(sig[0]).toMatchObject({ score: 5, source: "auth" });
    expect(sig[0]?.details).toMatchObject({ ip: "203.0.113.77", fingerprint: `d:${devC}` });
    expect((await ctx.db.user.findUniqueOrThrow({ where: { id: s.userId } })).riskScore).toBe(5);
    // The login itself still succeeds (detection, not a block) and the session records the device.
    const session = await ctx.db.session.findFirstOrThrow({ where: { userId: s.userId, deviceId: `d:${devC}` } });
    expect(session.ip).toBe("203.0.113.77");
    expect((res.json() as { user: { id: string } }).user.id).toBe(s.userId);

    // That device is now known: logging in from it again (same IP) raises nothing new.
    await login(email, { deviceId: devC, ip: "203.0.113.77" });
    expect(await newDeviceNotes(s.userId)).toHaveLength(2);
    expect(await suspicious(s.userId)).toHaveLength(1);
    expect(await ctx.db.device.count({ where: { userId: s.userId } })).toBe(3);
  });

  it("without a deviceId the user agent is the fingerprint (same UA = same device)", async () => {
    const s = await registerUser(ctx.app);
    const email = (await ctx.db.user.findUniqueOrThrow({ where: { id: s.userId } })).email ?? "";
    // registerUser() sent inject()'s default UA; this UA is a second device.
    await login(email, { ua: DESKTOP_UA });
    await login(email, { ua: DESKTOP_UA });
    expect(await ctx.db.device.count({ where: { userId: s.userId } })).toBe(2);
    expect(await newDeviceNotes(s.userId)).toHaveLength(1);
    const fps = (await ctx.db.device.findMany({ where: { userId: s.userId } })).map((d) => d.fingerprint);
    expect(fps.every((f) => /^ua:[0-9a-f]{32}$/.test(f))).toBe(true);
  });

  it("wallet login from a second device of a wallet account is detected the same way", async () => {
    const devA = dev();
    const { signer, s } = await walletLogin(ctx.app, undefined, devA);
    expect(await newDeviceNotes(s.userId)).toHaveLength(0);
    await walletLogin(ctx.app, signer, dev());
    expect(await newDeviceNotes(s.userId)).toHaveLength(1);
  });
});

describe("SEC-07 wallet change lock", () => {
  async function linkWallet(s: Session) {
    const extra = await generateKeyPairSigner();
    const n = await s.req("POST", "/api/auth/nonce", { address: extra.address, purpose: "LINK_WALLET" });
    expect(n.statusCode, n.body).toBe(200);
    const { nonce, message } = n.json() as { nonce: string; message: string };
    const res = await s.req("POST", "/api/auth/link-wallet", { address: extra.address, nonce, signature: await signMessage(extra, message) });
    return { res, extra };
  }

  it("the wallet that created the account is not a change; linking another wallet locks withdrawals for the configured window", async () => {
    const cfg = await loadEconomyConfig(ctx.db);
    const { s, signer } = await walletLogin(ctx.app);
    // Fresh wallet account: the signup wallet is inside the grace period → no lock.
    expect(await walletChangeLockUntil(ctx.db, s.userId, cfg)).toBeNull();

    // Age the account so only the wallet change can cause a lock.
    const aged = new Date(Date.now() - 10 * 86_400_000);
    await ctx.db.user.update({ where: { id: s.userId }, data: { createdAt: aged } });
    await ctx.db.wallet.update({ where: { address: signer.address }, data: { verifiedAt: aged } });
    const pre = await checkWithdrawal(ctx.db, { userId: s.userId, amount: BigInt(cfg.withdrawal.min), address: signer.address }, cfg);
    expect(pre.errors.map((e) => e.code)).not.toContain("WALLET_CHANGE_LOCK");
    expect(pre.walletLockUntil).toBeNull();

    const t0 = Date.now();
    const { res, extra } = await linkWallet(s);
    expect(res.statusCode, res.body).toBe(200);
    const wallets = (res.json() as { wallets: { address: string; primary: boolean }[] }).wallets;
    expect(wallets.find((w) => w.address === signer.address)?.primary).toBe(true);
    expect(wallets.find((w) => w.address === extra.address)?.primary).toBe(false);

    const lock = await walletChangeLockUntil(ctx.db, s.userId, cfg);
    const windowMs = cfg.withdrawal.walletChangeLockHours * 3_600_000;
    expect(lock?.getTime()).toBeGreaterThanOrEqual(t0 + windowMs - 1000);
    expect(lock?.getTime()).toBeLessThanOrEqual(Date.now() + windowMs);
    // The lock covers every destination, including the long-standing primary wallet.
    for (const address of [signer.address, extra.address]) {
      const chk = await checkWithdrawal(ctx.db, { userId: s.userId, amount: BigInt(cfg.withdrawal.min), address }, cfg);
      expect(chk.ok).toBe(false);
      expect(chk.errors.map((e) => e.code)).toContain("WALLET_CHANGE_LOCK");
    }

    // Owner is told, the change is scored and audited.
    expect(await ctx.db.notification.count({ where: { userId: s.userId, type: "SECURITY_WALLET_LINKED" } })).toBe(1);
    const risk = await ctx.db.riskSignal.findFirstOrThrow({ where: { userId: s.userId, type: "WALLET_CHANGE" } });
    expect(risk.details).toMatchObject({ address: extra.address });
    expect(await ctx.db.auditLog.count({ where: { actorId: s.userId, action: "WALLET_LINK", targetId: extra.address } })).toBe(1);

    // After the window the lock lifts.
    await ctx.db.wallet.update({ where: { address: extra.address }, data: { verifiedAt: new Date(Date.now() - windowMs - 60_000) } });
    expect(await walletChangeLockUntil(ctx.db, s.userId, cfg)).toBeNull();
    const post = await checkWithdrawal(ctx.db, { userId: s.userId, amount: BigInt(cfg.withdrawal.min), address: extra.address }, cfg);
    expect(post.errors.map((e) => e.code)).not.toContain("WALLET_CHANGE_LOCK");
  });

  it("an unlinked wallet also counts as a change, and a wallet of another account cannot be linked", async () => {
    const cfg = await loadEconomyConfig(ctx.db);
    const { s, signer } = await walletLogin(ctx.app);
    const aged = new Date(Date.now() - 10 * 86_400_000);
    await ctx.db.user.update({ where: { id: s.userId }, data: { createdAt: aged } });
    await ctx.db.wallet.update({ where: { address: signer.address }, data: { verifiedAt: aged } });
    const { res, extra } = await linkWallet(s);
    expect(res.statusCode).toBe(200);
    // Old link, recent unlink → locked from the unlink time.
    await ctx.db.wallet.update({ where: { address: extra.address }, data: { verifiedAt: aged, unlinkedAt: new Date() } });
    expect(await walletChangeLockUntil(ctx.db, s.userId, cfg)).not.toBeNull();
    // An unlinked wallet can no longer be used to sign in.
    const n = await ctx.app.inject({ method: "POST", url: "/api/auth/nonce", payload: { address: extra.address } });
    const { nonce, message } = n.json() as { nonce: string; message: string };
    const v = await ctx.app.inject({ method: "POST", url: "/api/auth/verify", payload: { address: extra.address, nonce, signature: await signMessage(extra, message) } });
    expect(v.statusCode).toBe(403);
    expect((v.json() as { error: { code: string } }).error.code).toBe("WALLET_UNLINKED");

    // Someone else's wallet cannot be attached to this account.
    const other = await walletLogin(ctx.app);
    const n2 = await s.req("POST", "/api/auth/nonce", { address: other.signer.address, purpose: "LINK_WALLET" });
    const b2 = n2.json() as { nonce: string; message: string };
    const stolen = await s.req("POST", "/api/auth/link-wallet", { address: other.signer.address, nonce: b2.nonce, signature: await signMessage(other.signer, b2.message) });
    expect(stolen.statusCode).toBe(409);
    expect((stolen.json() as { error: { code: string } }).error.code).toBe("WALLET_IN_USE");
    expect((await ctx.db.wallet.findUniqueOrThrow({ where: { address: other.signer.address } })).userId).toBe(other.s.userId);
  });
});
