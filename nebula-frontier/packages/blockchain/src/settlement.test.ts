import { describe, expect, it } from "vitest";
import { generateKeyPairSigner } from "@solana/kit";
import {
  checkSettlementEligibility,
  decodeRewardReceipt,
  decodeSettlementConfig,
  encodeRewardReceipt,
  encodeSettlementConfig,
  fetchRewardReceipt,
  fetchSettlementConfig,
  findPayoutsByMemo,
  getRewardReceiptPda,
  getSettlementPdas,
  rewardIdFor,
  sendFundVault,
  sendSettlementPayout,
  sendSolWithMemo,
  verifyPayoutTransaction,
  verifySettlementPayout,
  DEFAULT_SETTLEMENT_PROGRAM_ID,
  SETTLEMENT_CONFIG_SIZE
} from "./index.js";
import { createMockSolanaRpc, installMockSettlement } from "./testing.js";

const SOL = 1_000_000_000n;

async function setup(vaultLamports = 2n * SOL) {
  const treasury = await generateKeyPairSigner();
  const player = await generateKeyPairSigner();
  const mock = createMockSolanaRpc({ balances: { [treasury.address]: 10n * SOL } });
  const program = await installMockSettlement(mock.state, { rewardSigner: treasury.address, vaultLamports });
  return { ...mock, treasury, player, program };
}

describe("nebula_settlement client", () => {
  it("derives the devnet config / vault PDAs of the deployed program", async () => {
    const pdas = await getSettlementPdas();
    expect(pdas.programId).toBe(DEFAULT_SETTLEMENT_PROGRAM_ID);
    // Initialized on devnet by programs/scripts/devnet-initialize.mjs (see docs/BLOCKCHAIN.md).
    expect(pdas.config).toBe("GG6QLkLk9VzTWdpjH7bTfNF71r9AjbM5n94okZMQ4UjH");
  });

  it("round-trips the Config / RewardReceipt account layouts (Anchor InitSpace)", async () => {
    const a = await generateKeyPairSigner();
    const cfg = {
      authority: a.address, pendingAuthority: "11111111111111111111111111111111", rewardSigner: a.address, feeBps: 500,
      maxRewardPerClaim: SOL, maxEmissionPerEpoch: 2n * SOL, epochDurationSecs: 86_400n, epochStart: 1_700_000_000n, epochEmitted: 5n,
      paused: true, bump: 254, vaultBump: 253
    };
    const buf = encodeSettlementConfig(cfg);
    expect(buf.length).toBe(SETTLEMENT_CONFIG_SIZE);
    expect(decodeSettlementConfig(buf)).toEqual(cfg);
    const rewardId = await rewardIdFor("wd_1");
    const r = { rewardId, player: a.address, amount: 42n, claimedAt: 7n };
    expect(decodeRewardReceipt(encodeRewardReceipt(r))).toEqual(r);
    expect(() => decodeSettlementConfig(encodeRewardReceipt(r))).toThrow(/Config/);
  });

  it("derives a stable 32-byte reward id per reference", async () => {
    const a = await rewardIdFor("wd_1");
    expect(a.length).toBe(32);
    expect(await rewardIdFor("wd_1")).toEqual(a);
    expect(await rewardIdFor("wd_2")).not.toEqual(a);
  });

  it("pays a reward from the vault once, and refuses a second claim for the same reward id", async () => {
    const { rpc, state, treasury, player, program } = await setup();
    const rewardId = await rewardIdFor("wd_abc");
    const memo = "nebula:wd:abc";
    let persisted: string | null = null;
    const out = await sendSettlementPayout({ rpc, signer: treasury, destination: player.address, amount: SOL / 4n, memo, programId: program.programId, rewardId, onSigned: async ({ signature }) => { persisted = signature; } });
    expect(out.status).toBe("CONFIRMED");
    expect(persisted).toBe(out.signature);
    expect(state.balances.get(player.address)).toBe(SOL / 4n);

    const receipt = await fetchRewardReceipt(rpc, program.programId, rewardId);
    expect(receipt).toMatchObject({ player: player.address, amount: SOL / 4n });
    expect((await fetchSettlementConfig(rpc, await getSettlementPdas()))?.epochEmitted).toBe(SOL / 4n);

    // Found by the same memo lookup as direct payouts, and verified as a settlement payout (not as a treasury transfer).
    expect((await findPayoutsByMemo(rpc, treasury.address, memo)).map((c) => c.signature)).toEqual([out.signature]);
    const v = { signature: out.signature, treasury: treasury.address, destination: player.address, amount: SOL / 4n, memo, programId: program.programId, rewardId };
    expect(await verifySettlementPayout(rpc, v)).toMatchObject({ ok: true, amount: SOL / 4n });
    expect(await verifyPayoutTransaction(rpc, v)).toMatchObject({ ok: false });
    expect(await verifySettlementPayout(rpc, { ...v, amount: SOL / 5n })).toMatchObject({ ok: false });
    expect(await verifySettlementPayout(rpc, { ...v, rewardId: await rewardIdFor("wd_other") })).toMatchObject({ ok: false, reason: "AMOUNT_MISMATCH" });

    const again = await sendSettlementPayout({ rpc, signer: treasury, destination: player.address, amount: SOL / 4n, memo, programId: program.programId, rewardId });
    expect(again.status).toBe("FAILED");
    expect(state.balances.get(player.address)).toBe(SOL / 4n);
  });

  it("rejects a payout not co-signed by the configured reward signer", async () => {
    const { rpc, state, player, program } = await setup();
    const intruder = await generateKeyPairSigner();
    state.balances.set(intruder.address, SOL);
    const out = await sendSettlementPayout({ rpc, signer: intruder, destination: player.address, amount: 1000n, memo: "nebula:wd:x", programId: program.programId, rewardId: await rewardIdFor("x") });
    expect(out.status).toBe("FAILED");
    expect(await getRewardReceiptPda(program.programId, await rewardIdFor("x"))).toBeTruthy();
    expect(await fetchRewardReceipt(rpc, program.programId, await rewardIdFor("x"))).toBeNull();
  });

  it("a spoofed treasury-bound tx carrying the memo does not verify as a settlement payout", async () => {
    const { rpc, treasury, player, program } = await setup();
    const memo = "nebula:wd:spoof";
    const spoof = await sendSolWithMemo({ rpc: rpc, signer: treasury, destination: player.address, amount: 1000n, memo });
    const res = await verifySettlementPayout(rpc, { signature: spoof.signature, treasury: treasury.address, destination: player.address, amount: 1000n, memo, programId: program.programId, rewardId: await rewardIdFor("spoof") });
    expect(res).toMatchObject({ ok: false, reason: "WRONG_SENDER" });
  });

  it("eligibility mirrors the program checks (cap, epoch emission, liquidity, pause, signer)", async () => {
    const { rpc, state, treasury, program } = await setup(SOL / 2n);
    const pdas = await getSettlementPdas(program.programId);
    const check = (amount: bigint, rewardSigner = treasury.address) => checkSettlementEligibility(rpc, { pdas, rewardSigner, amount });
    expect(await check(SOL / 4n)).toEqual({ ok: true });
    expect(await check(2n * SOL)).toMatchObject({ ok: false, reason: expect.stringMatching(/per-claim cap/) });
    expect(await check(SOL)).toMatchObject({ ok: false, reason: expect.stringMatching(/vault liquidity/) });
    expect(await check(1n, (await generateKeyPairSigner()).address)).toMatchObject({ ok: false, reason: expect.stringMatching(/reward signer/) });

    const funded = await sendFundVault({ rpc, funder: treasury, programId: program.programId, amount: 3n * SOL });
    expect(funded.status).toBe("CONFIRMED");
    expect(await check(SOL)).toEqual({ ok: true });

    const cfg = decodeSettlementConfig(state.accounts.get(pdas.config)!.data);
    state.accounts.set(pdas.config, { owner: program.programId, data: encodeSettlementConfig({ ...cfg, epochEmitted: 2n * SOL - 10n }) });
    expect(await check(11n)).toMatchObject({ ok: false, reason: "epoch emission cap reached" });
    // A new epoch resets the emitted counter.
    expect(await checkSettlementEligibility(rpc, { pdas, rewardSigner: treasury.address, amount: 11n, nowSecs: cfg.epochStart + cfg.epochDurationSecs })).toEqual({ ok: true });
    state.accounts.set(pdas.config, { owner: program.programId, data: encodeSettlementConfig({ ...cfg, paused: true }) });
    expect(await check(1n)).toMatchObject({ ok: false, reason: "program paused" });
    state.accounts.delete(pdas.config);
    expect(await check(1n)).toMatchObject({ ok: false, reason: "program not initialized" });
  });
});
