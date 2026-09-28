import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeAll } from "vitest";
import { generateKeyPairSigner, getBase58Decoder, signBytes, type KeyPairSigner } from "@solana/kit";
import {
  buildLoginMessage,
  encodeMessage,
  explorerUrl,
  findPayoutByMemo,
  findPayoutsByMemo,
  verifyPayoutTransaction,
  loadTreasurySigner,
  parseSecretKey,
  resetTreasurySignerCache,
  sendSolWithMemo,
  verifyDepositTransaction,
  verifyWalletSignature,
  buildNftMetadataJson,
  buildMintNftInstructions,
  exportKeyPairBytes
} from "./index.js";
import { createMockSolanaRpc } from "./testing.js";

const SOL = 1_000_000_000n;

describe("wallet auth (SIWS)", () => {
  it("verifies a real ed25519 signature over the login message and rejects tampering", async () => {
    const kp = await generateKeyPairSigner();
    const msg = buildLoginMessage({ domain: "localhost:5173", address: kp.address, nonce: "abc123def456ghi789", issuedAt: new Date(), expiresAt: new Date(Date.now() + 300_000), purpose: "LOGIN" });
    expect(msg).toContain(kp.address);
    expect(msg).toContain("Nonce: abc123def456ghi789");
    const sig = getBase58Decoder().decode(await signBytes(kp.keyPair.privateKey, encodeMessage(msg)));
    expect(await verifyWalletSignature(kp.address, msg, sig)).toBe(true);
    expect(await verifyWalletSignature(kp.address, msg + " ", sig)).toBe(false);
    const other = await generateKeyPairSigner();
    expect(await verifyWalletSignature(other.address, msg, sig)).toBe(false);
    expect(await verifyWalletSignature("not-an-address", msg, sig)).toBe(false);
    expect(await verifyWalletSignature(kp.address, msg, "111")).toBe(false);
  });
});

describe("treasury key guard", () => {
  it("refuses to load outside the blockchain service and never leaks the secret", async () => {
    const kp = await generateKeyPairSigner(true);
    const bytes = await exportKeyPairBytes(kp.keyPair);
    const secret = JSON.stringify(Array.from(bytes));
    resetTreasurySignerCache();
    expect(() => loadTreasurySigner({ TREASURY_SECRET: secret, SERVICE_ROLE: "api" })).toThrow(/blockchain-service/);
    const signer = await loadTreasurySigner({ TREASURY_SECRET: secret, SERVICE_ROLE: "blockchain", TREASURY_PUBLIC_KEY: kp.address });
    expect(signer.address).toBe(kp.address);
    resetTreasurySignerCache();
    let thrown: unknown;
    try {
      parseSecretKey("[1,2,3]");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/64 bytes/);
    expect((thrown as Error).message).not.toContain("1,2,3");
    expect(parseSecretKey(getBase58Decoder().decode(bytes))).toEqual(bytes);
  });

  it("loads the secret from TREASURY_SECRET_FILE without echoing it", async () => {
    const kp = await generateKeyPairSigner(true);
    const secret = JSON.stringify(Array.from(await exportKeyPairBytes(kp.keyPair)));
    const dir = mkdtempSync(join(tmpdir(), "nf-key-"));
    try {
      const file = join(dir, "treasury.json");
      writeFileSync(file, secret, { mode: 0o600 });
      resetTreasurySignerCache();
      expect(() => loadTreasurySigner({ TREASURY_SECRET_FILE: file, SERVICE_ROLE: "api" })).toThrow(/blockchain-service/);
      const signer = await loadTreasurySigner({ TREASURY_SECRET_FILE: file, SERVICE_ROLE: "blockchain", TREASURY_PUBLIC_KEY: kp.address });
      expect(signer.address).toBe(kp.address);
      resetTreasurySignerCache();
      let thrown: unknown;
      try {
        loadTreasurySigner({ TREASURY_SECRET_FILE: join(dir, "missing.json"), SERVICE_ROLE: "blockchain" });
      } catch (e) {
        thrown = e;
      }
      expect((thrown as Error).message).toMatch(/TREASURY_SECRET_FILE could not be read/);
      expect(() => loadTreasurySigner({ SERVICE_ROLE: "blockchain" })).toThrow(/not configured/);
    } finally {
      resetTreasurySignerCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("verifyDepositTransaction (mock RPC)", () => {
  let treasury: KeyPairSigner;
  let player: KeyPairSigner;
  beforeAll(async () => {
    treasury = await generateKeyPairSigner();
    player = await generateKeyPairSigner();
  });

  async function setup(opts: { genesisHash?: string } = {}) {
    const mock = createMockSolanaRpc({ genesisHash: opts.genesisHash, balances: { [player.address]: 2n * SOL, [treasury.address]: SOL } });
    return mock;
  }
  const base = () => ({ expectedRecipient: treasury.address, expectedAmount: 50_000_000n, memo: "nebula:dep:abc", expectedSender: player.address, network: "devnet" as const });

  it("accepts a real signed transfer with the right memo, amount, recipient and sender", async () => {
    const { rpc, state } = await setup();
    const out = await sendSolWithMemo({ rpc, signer: player, destination: treasury.address, amount: 50_000_000n, memo: "nebula:dep:abc" });
    expect(out.status).toBe("CONFIRMED");
    const r = await verifyDepositTransaction(rpc, { ...base(), signature: out.signature });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.amount).toBe(50_000_000n);
    expect(state.balances.get(treasury.address)).toBe(SOL + 50_000_000n);
  });

  it("rejects wrong recipient / amount / memo / sender", async () => {
    const { rpc } = await setup();
    const elsewhere = await generateKeyPairSigner();
    const a = await sendSolWithMemo({ rpc, signer: player, destination: elsewhere.address, amount: 50_000_000n, memo: "nebula:dep:abc" });
    expect(await verifyDepositTransaction(rpc, { ...base(), signature: a.signature })).toMatchObject({ ok: false, reason: "WRONG_RECIPIENT" });
    const b = await sendSolWithMemo({ rpc, signer: player, destination: treasury.address, amount: 49_000_000n, memo: "nebula:dep:abc" });
    expect(await verifyDepositTransaction(rpc, { ...base(), signature: b.signature })).toMatchObject({ ok: false, reason: "AMOUNT_MISMATCH" });
    const c = await sendSolWithMemo({ rpc, signer: player, destination: treasury.address, amount: 50_000_000n, memo: "nebula:dep:other" });
    expect(await verifyDepositTransaction(rpc, { ...base(), signature: c.signature })).toMatchObject({ ok: false, reason: "MEMO_MISMATCH" });
    // A valid transfer, but claimed by an account whose verified wallet did not sign it.
    const stranger = await generateKeyPairSigner();
    const d = await sendSolWithMemo({ rpc, signer: player, destination: treasury.address, amount: 50_000_000n, memo: "nebula:dep:abc" });
    expect(await verifyDepositTransaction(rpc, { ...base(), expectedSender: stranger.address, signature: d.signature })).toMatchObject({ ok: false, reason: "WRONG_SENDER" });
  });

  it("rejects failed transactions, unknown / unconfirmed signatures and the wrong cluster", async () => {
    const { rpc, state } = await setup();
    state.sendQueue.push("fail");
    const f = await sendSolWithMemo({ rpc, signer: player, destination: treasury.address, amount: 50_000_000n, memo: "nebula:dep:abc" });
    expect(f.status).toBe("FAILED");
    expect(await verifyDepositTransaction(rpc, { ...base(), signature: f.signature })).toMatchObject({ ok: false, reason: "TX_FAILED" });
    const fakeSig = getBase58Decoder().decode(new Uint8Array(64).fill(7));
    expect(await verifyDepositTransaction(rpc, { ...base(), signature: fakeSig })).toMatchObject({ ok: false, reason: "NOT_FOUND", retryable: true });
    expect(await verifyDepositTransaction(rpc, { ...base(), signature: "garbage" })).toMatchObject({ ok: false, reason: "INVALID_SIGNATURE" });
    state.commitment = "processed";
    const p = await sendSolWithMemo({ rpc, signer: player, destination: treasury.address, amount: 50_000_000n, memo: "nebula:dep:abc", confirmTimeoutMs: 10 });
    expect(await verifyDepositTransaction(rpc, { ...base(), signature: p.signature })).toMatchObject({ ok: false, reason: "NOT_CONFIRMED", retryable: true });
    const other = await setup({ genesisHash: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" });
    const o = await sendSolWithMemo({ rpc: other.rpc, signer: player, destination: treasury.address, amount: 50_000_000n, memo: "nebula:dep:abc" });
    expect(await verifyDepositTransaction(other.rpc, { ...base(), signature: o.signature })).toMatchObject({ ok: false, reason: "WRONG_NETWORK" });
  });

  it("finds an existing payout by memo (idempotency lookup)", async () => {
    const { rpc } = await setup();
    const out = await sendSolWithMemo({ rpc, signer: player, destination: treasury.address, amount: 1000n, memo: "nebula:wd:xyz" });
    const found = await findPayoutByMemo(rpc, treasury.address, "nebula:wd:xyz");
    expect(found?.signature).toBe(out.signature);
    expect(await findPayoutByMemo(rpc, treasury.address, "nebula:wd:none")).toBeNull();
    // A memo match alone is not a payout: this one is inbound (player → treasury).
    const payout = { treasury: treasury.address, destination: player.address, amount: 1000n, memo: "nebula:wd:xyz", network: "devnet" as const };
    expect(await verifyPayoutTransaction(rpc, { ...payout, signature: out.signature })).toMatchObject({ ok: false, retryable: false });
    const real = await sendSolWithMemo({ rpc, signer: treasury, destination: player.address, amount: 1000n, memo: "nebula:wd:xyz" });
    expect(await verifyPayoutTransaction(rpc, { ...payout, signature: real.signature })).toMatchObject({ ok: true, amount: 1000n });
    expect(await verifyPayoutTransaction(rpc, { ...payout, amount: 999n, signature: real.signature })).toMatchObject({ ok: false, reason: "AMOUNT_MISMATCH" });
    expect((await findPayoutsByMemo(rpc, treasury.address, "nebula:wd:xyz")).map((c) => c.signature).sort()).toEqual([out.signature, real.signature].sort());
  });
});

describe("nft + explorer", () => {
  it("builds Metaplex JSON and mint instructions", async () => {
    const json = buildNftMetadataJson({ family: "LEGENDARY_SHIP", itemId: "ship_vanta", name: "Vanta Warden", description: "Legendary hull", image: "https://example.com/v.png", rarity: "LEGENDARY", shipClass: "DESTROYER", faction: "AURORA", edition: { number: 3, max: 100 } });
    expect(json.name).toBe("Vanta Warden #3");
    expect(json.attributes).toContainEqual({ trait_type: "Ship Class", value: "DESTROYER" });
    const payer = await generateKeyPairSigner();
    const mint = await generateKeyPairSigner();
    const ixs = await buildMintNftInstructions({ payer, mint, owner: payer.address, name: json.name, uri: "https://example.com/v.json" });
    expect(ixs.length).toBe(2);
    expect(ixs[0]?.programAddress).toBe("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
  });
  it("explorer url", () => {
    expect(explorerUrl("abc", "devnet")).toBe("https://explorer.solana.com/tx/abc?cluster=devnet");
  });
});
