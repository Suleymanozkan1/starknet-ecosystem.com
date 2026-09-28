/**
 * Wallet / deposit / withdrawal / rewards / admin-economy routes through the real Fastify app
 * (inject), an isolated Postgres schema (so mock-chain funding never touches the devnet-backed
 * ledger) and the mock Solana JSON-RPC served over HTTP (SOLANA_RPC_URL).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { buildApp } from "../../apps/api/src/app.js";
import { post, system, userWallet, getBalance, type Db } from "../../packages/database/src/index.js";
import { Currency, LedgerAccountType } from "../../packages/shared/src/index.js";
import { bootstrapTreasury, grantCryptoReward } from "../../packages/economy/src/index.js";
import { createIsolatedDb } from "../../packages/economy/src/testing.js";
import { sendSolWithMemo, type SolanaRpcClient } from "../../packages/blockchain/src/index.js";
import { startMockRpcServer, type MockChainState } from "../../packages/blockchain/src/testing.js";
import { key, signMessage, walletLogin, type Session } from "./helpers.js";

const SOL = 1_000_000_000n;
let app: FastifyInstance;
let db: Db;
let chain: { url: string; state: MockChainState; rpc: SolanaRpcClient; close: () => Promise<void> };
let treasury: KeyPairSigner;
const envBackup = { ...process.env };

type Err = { error: { code: string } };
const code = (r: { json: () => unknown }) => (r.json() as Err).error.code;

async function eligibleLogin(balance = 0n): Promise<{ s: Session; signer: KeyPairSigner }> {
  const signer = await generateKeyPairSigner();
  chain.state.balances.set(signer.address, SOL);
  const r = await walletLogin(app, signer);
  const createdAt = new Date(Date.now() - 5 * 86_400_000);
  await db.user.update({ where: { id: r.s.userId }, data: { createdAt, playtimeSeconds: 4n * 3600n, matchesPlayed: 30 } });
  await db.wallet.update({ where: { address: signer.address }, data: { verifiedAt: createdAt } });
  if (balance > 0n) {
    await db.$transaction((tx) =>
      post(tx, {
        from: system(LedgerAccountType.PLAYER_REWARD_POOL, Currency.NEBX),
        to: userWallet(r.s.userId, Currency.NEBX),
        amount: balance,
        type: "GAME_REWARD",
        reference: "test",
        idempotencyKey: `test-fund-${randomUUID()}`
      })
    );
  }
  return r;
}

beforeAll(async () => {
  treasury = await generateKeyPairSigner();
  chain = await startMockRpcServer({ balances: { [treasury.address]: 100n * SOL } });
  process.env.SOLANA_NETWORK = "devnet";
  process.env.SOLANA_RPC_URL = chain.url;
  process.env.TREASURY_PUBLIC_KEY = treasury.address;
  process.env.BLOCKCHAIN_SERVICE_URL = "http://127.0.0.1:9"; // unreachable: notify is non-fatal
  process.env.REWARD_MINT = "";
  db = await createIsolatedDb("test_api_wallet", { truncate: true });
  for (const k of ["wallet", "deposit", "withdraw"]) await db.featureFlag.upsert({ where: { key: k }, create: { key: k, enabled: true }, update: { enabled: true } });
  await bootstrapTreasury(db, { onChainBalance: 100n * SOL, slot: 1n, treasuryAddress: treasury.address });
  app = await buildApp({ db, logger: false, rateLimitScale: 1000, rateLimitNamespace: `nf:test:${randomUUID()}:` });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await db?.$disconnect();
  await chain?.close();
  process.env = envBackup;
});

describe("deposits", () => {
  it("prepare → real signed transfer + memo → verify credits once; replays and fakes are rejected", async () => {
    const { s, signer } = await eligibleLogin();
    const w = await s.req("GET", "/api/wallet");
    expect(w.statusCode).toBe(200);
    expect((w.json() as { treasuryAddress: string }).treasuryAddress).toBe(treasury.address);

    const p = await s.req("POST", "/api/wallet/deposit/prepare", { amount: "50000000", purpose: "GEMS", idempotencyKey: key() });
    expect(p.statusCode).toBe(200);
    const dep = p.json() as { depositId: string; memo: string; recipient: string; amount: string };
    expect(dep.recipient).toBe(treasury.address);
    const tx = await sendSolWithMemo({ rpc: chain.rpc, signer, destination: treasury.address, amount: 50_000_000n, memo: dep.memo });

    const v = await s.req("POST", "/api/wallet/deposit/verify", { depositId: dep.depositId, signature: tx.signature });
    expect(v.statusCode, v.body).toBe(200);
    expect((v.json() as { deposit: { status: string }; gems: number }).deposit.status).toBe("CREDITED");
    expect((v.json() as { gems: number }).gems).toBe(100);
    // duplicate verify of the same deposit is idempotent
    const again = await s.req("POST", "/api/wallet/deposit/verify", { depositId: dep.depositId, signature: tx.signature });
    expect(again.statusCode).toBe(200);
    expect(await getBalance(db, userWallet(s.userId, Currency.GEMS))).toBe(100n);

    // the same signature cannot fund a second deposit
    const p2 = (await s.req("POST", "/api/wallet/deposit/prepare", { amount: "50000000", purpose: "BALANCE", idempotencyKey: key() })).json() as { depositId: string; memo: string };
    const dup = await s.req("POST", "/api/wallet/deposit/verify", { depositId: p2.depositId, signature: tx.signature });
    expect(dup.statusCode).toBe(409);
    expect(code(dup)).toBe("DUPLICATE_SIGNATURE");

    // fake: right amount/recipient but wrong memo → rejected attempt, scored as suspicious, but the
    // memo-bound deposit stays creditable (the failure belongs to the signature, not the deposit)
    const fake = await sendSolWithMemo({ rpc: chain.rpc, signer, destination: treasury.address, amount: 50_000_000n, memo: "not-the-memo" });
    const bad = await s.req("POST", "/api/wallet/deposit/verify", { depositId: p2.depositId, signature: fake.signature });
    expect(bad.statusCode).toBe(400);
    expect(code(bad)).toBe("MEMO_MISMATCH");
    const afterBad = await db.deposit.findUniqueOrThrow({ where: { id: p2.depositId } });
    expect(afterBad.status).toBe("PREPARED");
    expect(afterBad.failureReason).toMatch(/^MEMO_MISMATCH/);
    expect(await db.riskSignal.count({ where: { userId: s.userId, type: "FAKE_TRANSACTION", source: "deposit" } })).toBeGreaterThan(0);
    // a later genuine payment carrying the right memo is still credited
    const real = await sendSolWithMemo({ rpc: chain.rpc, signer, destination: treasury.address, amount: 50_000_000n, memo: p2.memo });
    const ok = await s.req("POST", "/api/wallet/deposit/verify", { depositId: p2.depositId, signature: real.signature });
    expect(ok.statusCode, ok.body).toBe(200);
    const credited = await db.deposit.findUniqueOrThrow({ where: { id: p2.depositId } });
    expect(credited.status).toBe("CREDITED");
    expect(credited.failureReason).toBeNull();

    // fake: wrong recipient
    const p3 = (await s.req("POST", "/api/wallet/deposit/prepare", { amount: "10000000", purpose: "BALANCE", idempotencyKey: key() })).json() as { depositId: string; memo: string };
    const other = await generateKeyPairSigner();
    const wrong = await sendSolWithMemo({ rpc: chain.rpc, signer, destination: other.address, amount: 10_000_000n, memo: p3.memo });
    const wr = await s.req("POST", "/api/wallet/deposit/verify", { depositId: p3.depositId, signature: wrong.signature });
    expect(code(wr)).toBe("WRONG_RECIPIENT");

    // unknown signature → retryable 202
    const p4 = (await s.req("POST", "/api/wallet/deposit/prepare", { amount: "10000000", purpose: "BALANCE", idempotencyKey: key() })).json() as { depositId: string };
    const unknown = await s.req("POST", "/api/wallet/deposit/verify", { depositId: p4.depositId, signature: "3".repeat(87) });
    expect([202, 400]).toContain(unknown.statusCode);
  });
});

describe("withdrawals", () => {
  it("requires CSRF, is idempotent, and parallel requests never overdraw", async () => {
    const { s, signer } = await eligibleLogin(60_000_000n);
    const q = await s.req("GET", "/api/wallet/withdraw/quote?amount=20000000");
    expect(q.statusCode).toBe(200);
    expect((q.json() as { final: string }).final).toBe(String(20_000_000 - 400_000 - 1_000_000 - 5_000));

    const noCsrf = await s.req("POST", "/api/wallet/withdraw", { amount: "20000000", address: signer.address, idempotencyKey: key() }, { csrf: false });
    expect(noCsrf.statusCode).toBe(403);

    const k = key();
    const r1 = await s.req("POST", "/api/wallet/withdraw", { amount: "20000000", address: signer.address, idempotencyKey: k });
    expect(r1.statusCode, r1.body).toBe(201);
    const r2 = await s.req("POST", "/api/wallet/withdraw", { amount: "20000000", address: signer.address, idempotencyKey: k });
    expect(r2.statusCode).toBe(200);
    expect((r2.json() as { id: string }).id).toBe((r1.json() as { id: string }).id);
    expect(await db.withdrawal.count({ where: { userId: s.userId } })).toBe(1);

    const par = await Promise.all(Array.from({ length: 4 }, () => s.req("POST", "/api/wallet/withdraw", { amount: "20000000", address: signer.address, idempotencyKey: key() })));
    expect(par.every((r) => r.statusCode >= 400)).toBe(true); // cooldown
    const bal = await getBalance(db, userWallet(s.userId, Currency.NEBX));
    expect(bal).toBe(40_000_000n);

    const status = await s.req("GET", `/api/wallet/withdrawals/${(r1.json() as { id: string }).id}`);
    expect((status.json() as { status: string }).status).toBe("PENDING");
  });

  it("rejects insufficient balance and non-linked destinations", async () => {
    const { s, signer } = await eligibleLogin(5_000_000n);
    const r = await s.req("POST", "/api/wallet/withdraw", { amount: "20000000", address: signer.address, idempotencyKey: key() });
    expect(r.statusCode).toBe(400);
    expect(code(r)).toBe("INSUFFICIENT_BALANCE");
    const stranger = await generateKeyPairSigner();
    const r2 = await s.req("POST", "/api/wallet/withdraw", { amount: "10000000", address: stranger.address, idempotencyKey: key() });
    expect(r2.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("linking a new wallet via /api/wallet/connect locks withdrawals to it for 48h", async () => {
    const { s } = await eligibleLogin(60_000_000n);
    const extra = await generateKeyPairSigner();
    const n = await s.req("POST", "/api/auth/nonce", { address: extra.address, purpose: "LINK_WALLET" });
    expect(n.statusCode).toBe(200);
    const { nonce, message } = n.json() as { nonce: string; message: string };
    const c = await s.req("POST", "/api/wallet/connect", { address: extra.address, nonce, signature: await signMessage(extra, message) });
    expect(c.statusCode, c.body).toBe(200);
    expect((c.json() as { wallets: unknown[] }).wallets.length).toBe(2);
    const w = await s.req("POST", "/api/wallet/withdraw", { amount: "20000000", address: extra.address, idempotencyKey: key() });
    expect(w.statusCode).toBe(400);
    expect(code(w)).toBe("WALLET_CHANGE_LOCK");
  });
});

describe("rewards & admin economy", () => {
  it("claims granted rewards once and exposes rules/caps", async () => {
    const { s } = await eligibleLogin();
    const g = await grantCryptoReward(db, { userId: s.userId, source: "TOURNAMENT", sourceRef: `t-${randomUUID()}`, weight: 3, reason: "Tournament Reward" });
    expect(g.status).toBe("GRANTED");
    const rw = await s.req("GET", "/api/economy/rewards");
    expect(rw.statusCode).toBe(200);
    const body = rw.json() as { claimable: string; rules: string[]; eligibility: { eligible: boolean } };
    expect(body.claimable).toBe(g.amount.toString());
    expect(body.eligibility.eligible).toBe(true);
    expect(body.rules.join(" ")).not.toMatch(/\bAPY\b|interest rate|guaranteed return|passive income/i);
    const c1 = await s.req("POST", "/api/rewards/claim", { all: true });
    expect(c1.statusCode, c1.body).toBe(200);
    const c2 = await s.req("POST", "/api/rewards/claim", { rewardId: g.rewardId });
    expect((c2.json() as { claimed: { alreadyClaimed: boolean }[] }).claimed[0]?.alreadyClaimed).toBe(true);
    expect(await getBalance(db, userWallet(s.userId, Currency.NEBX))).toBe(g.amount);
    const tx = await s.req("GET", "/api/economy/transactions");
    expect((tx.json() as { entries: { type: string }[] }).entries.some((e) => e.type === "GAME_REWARD")).toBe(true);
    expect((await app.inject({ method: "GET", url: "/api/economy/status" })).statusCode).toBe(200);
  });

  it("admin economy routes require roles and audit breaker changes", async () => {
    const { s } = await eligibleLogin();
    expect((await s.req("GET", "/api/admin/economy")).statusCode).toBe(403);
    await db.adminUser.create({ data: { userId: s.userId, roles: ["ECONOMY_MANAGER"] } });
    const dash = await s.req("GET", "/api/admin/economy");
    expect(dash.statusCode, dash.body).toBe(200);
    expect((dash.json() as { series: unknown[] }).series.length).toBe(30);
    // Claim rate aggregates this session's rewards (claimed ÷ granted, rejected excluded).
    const rc = (dash.json() as { rewardClaims: { granted: string; claimed: string; count: number; claimedCount: number; rate: number | null } }).rewardClaims;
    expect(BigInt(rc.claimed)).toBeLessThanOrEqual(BigInt(rc.granted));
    expect(rc.claimedCount).toBeLessThanOrEqual(rc.count);
    if (rc.rate !== null) { expect(rc.rate).toBeGreaterThanOrEqual(0); expect(rc.rate).toBeLessThanOrEqual(1); }
    const on = await s.req("POST", "/api/admin/economy/circuit-breaker", { mode: "MARKET_PAUSE", active: true, reason: "integration test" });
    expect(on.statusCode).toBe(200);
    expect((on.json() as { activeBreakers: string[] }).activeBreakers).toContain("MARKET_PAUSE");
    await s.req("POST", "/api/admin/economy/circuit-breaker", { mode: "MARKET_PAUSE", active: false, reason: "integration test done" });
    const bad = await s.req("POST", "/api/admin/economy/config", { key: "rewardAllocation.LEADERBOARD", value: 0.95, reason: "over-allocate" });
    expect(bad.statusCode).toBe(400);
    expect(code(bad)).toBe("INVALID_ECONOMY_CONFIG");
    const rate = await s.req("POST", "/api/admin/economy/reward-rate", { rate: 0.5, reason: "above hard cap" });
    expect(code(rate)).toBe("ABOVE_HARD_CAP");
    const t = await s.req("GET", "/api/admin/treasury");
    expect(t.statusCode, t.body).toBe(200);
    expect(BigInt((t.json() as { onChain: { lamports: string } }).onChain.lamports)).toBeGreaterThanOrEqual(100n * SOL);
    expect(await db.auditLog.count({ where: { action: "CIRCUIT_BREAKER_ON", actorId: s.userId } })).toBe(1);
  });
});
