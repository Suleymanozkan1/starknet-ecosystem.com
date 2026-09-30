/**
 * In-process mock Solana JSON-RPC (a kit RpcTransport). Decodes real signed wire transactions
 * (system transfers + memo), keeps balances, statuses, block height and per-address signature
 * history, so the deposit verifier and the payout pipeline can be exercised end-to-end without a
 * network. Used by tests and as the documented fallback when the devnet faucet is unavailable.
 */
import {
  createSolanaRpcFromTransport,
  getBase58Decoder,
  getBase64Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  getUtf8Decoder,
  type RpcTransport
} from "@solana/kit";
import { GENESIS_HASHES, type SolanaRpcClient } from "./rpc.js";
import { MEMO_PROGRAM_IDS, SYSTEM_PROGRAM_ID } from "./deposit.js";
import {
  decodeSettlementConfig,
  DEFAULT_SETTLEMENT_PROGRAM_ID,
  encodeRewardReceipt,
  encodeSettlementConfig,
  getRewardReceiptPda,
  getSettlementPdas,
  SETTLEMENT_DISCRIMINATORS,
  type SettlementConfig
} from "./settlement.js";

export type SendBehavior = "land" | "fail" | "drop" | "throw" | "land-then-throw";

export interface MockTx {
  signature: string;
  slot: number;
  err: unknown;
  memo: string | null;
  feePayer: string;
  accountKeys: { pubkey: string; signer: boolean; writable: boolean }[];
  transfers: { source: string; destination: string; lamports: bigint }[];
  /** Transfers made by a program via CPI (reported as inner instructions). */
  innerTransfers: { source: string; destination: string; lamports: bigint }[];
  preBalances: bigint[];
  postBalances: bigint[];
  confirmationStatus: "processed" | "confirmed" | "finalized";
}

export interface MockChainState {
  genesisHash: string;
  slot: number;
  blockHeight: number;
  balances: Map<string, bigint>;
  txs: Map<string, MockTx>;
  /** Behaviours consumed by successive sendTransaction calls (default "land"). */
  sendQueue: SendBehavior[];
  calls: string[];
  /** Set to make getSignatureStatuses report this commitment for landed txs. */
  commitment: "processed" | "confirmed" | "finalized";
  /** Custom getTransaction overrides (fake / crafted transactions). */
  parsedOverrides: Map<string, unknown>;
  statusOverrides: Map<string, { confirmationStatus: string; err: unknown; slot: number } | null>;
  /** Program-owned accounts (owner + data); lamports live in `balances`. */
  accounts: Map<string, { owner: string; data: Uint8Array }>;
  /**
   * When set, instructions to this program id are emulated as `nebula_settlement` (verify_reward /
   * fund_vault) with the program's checks: reward signer, pause, caps, vault liquidity, one receipt
   * per reward id.
   */
  settlement: { programId: string; config: string; vault: string } | null;
  advance(blocks: number): void;
}

const LAMPORTS_FEE = 5000n;

function bigintJson(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? Number(x) : x)));
}

export function createMockSolanaRpc(init: { genesisHash?: string; balances?: Record<string, bigint> } = {}): {
  rpc: SolanaRpcClient;
  state: MockChainState;
  handle: (payload: unknown) => Promise<unknown>;
} {
  const state: MockChainState = {
    genesisHash: init.genesisHash ?? GENESIS_HASHES.devnet,
    slot: 1000,
    blockHeight: 900,
    balances: new Map(Object.entries(init.balances ?? {})),
    txs: new Map(),
    sendQueue: [],
    calls: [],
    commitment: "confirmed",
    parsedOverrides: new Map(),
    statusOverrides: new Map(),
    accounts: new Map(),
    settlement: null,
    advance(blocks: number) {
      this.slot += blocks;
      this.blockHeight += blocks;
    }
  };
  const b58 = getBase58Decoder();
  const utf8 = getUtf8Decoder();

  async function applyWire(wireB64: string, behavior: SendBehavior): Promise<string> {
    const bytes = getBase64Encoder().encode(wireB64);
    const tx = getTransactionDecoder().decode(bytes);
    const decoded = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    if (!("instructions" in decoded)) throw new Error("Mock RPC only supports legacy/v0 messages");
    const msg = decoded;
    const sigEntries = Object.entries(tx.signatures);
    const signature = b58.decode(sigEntries[0]?.[1] as Uint8Array);
    if (state.txs.has(signature)) return signature;
    if (behavior === "drop") return signature;
    const keys = msg.staticAccounts.map(String);
    const numSigners = msg.header.numSignerAccounts;
    const accountKeys = keys.map((k, i) => ({ pubkey: k, signer: i < numSigners, writable: true }));
    const pre = keys.map((k) => state.balances.get(k) ?? 0n);
    const bal = new Map(state.balances);
    const transfers: MockTx["transfers"] = [];
    const innerTransfers: MockTx["innerTransfers"] = [];
    const accounts = new Map(state.accounts);
    let memo: string | null = null;
    let err: unknown = behavior === "fail" ? { InstructionError: [0, { Custom: 1 }] } : null;
    const feePayer = keys[0] as string;
    bal.set(feePayer, (bal.get(feePayer) ?? 0n) - LAMPORTS_FEE);
    for (const ix of msg.instructions) {
      const program = keys[ix.programAddressIndex];
      const data = ix.data ?? new Uint8Array();
      if (program === SYSTEM_PROGRAM_ID && data.length >= 12 && data[0] === 2) {
        const lamports = new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(4, true);
        const src = keys[ix.accountIndices?.[0] ?? -1] as string;
        const dst = keys[ix.accountIndices?.[1] ?? -1] as string;
        transfers.push({ source: src, destination: dst, lamports });
        if ((bal.get(src) ?? 0n) < lamports) err ??= { InstructionError: [0, { Custom: 1 }] };
        bal.set(src, (bal.get(src) ?? 0n) - lamports);
        bal.set(dst, (bal.get(dst) ?? 0n) + lamports);
      } else if (program && MEMO_PROGRAM_IDS.includes(program)) {
        memo = utf8.decode(data);
      } else if (program && state.settlement && program === state.settlement.programId) {
        const at = (i: number): string => keys[ix.accountIndices?.[i] ?? -1] ?? "";
        const isSigner = (k: string): boolean => keys.indexOf(k) >= 0 && keys.indexOf(k) < numSigners;
        const fail = (code: number): void => {
          err ??= { InstructionError: [0, { Custom: code }] };
        };
        const disc = [...data.subarray(0, 8)];
        const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const cfgAcc = accounts.get(state.settlement.config);
        if (disc.every((b, i) => b === SETTLEMENT_DISCRIMINATORS.fundVault[i])) {
          const amount = dv.getBigUint64(8, true);
          const funder = at(0);
          if (!isSigner(funder) || at(2) !== state.settlement.vault || (bal.get(funder) ?? 0n) < amount) fail(6000);
          else {
            bal.set(funder, (bal.get(funder) ?? 0n) - amount);
            bal.set(at(2), (bal.get(at(2)) ?? 0n) + amount);
            innerTransfers.push({ source: funder, destination: at(2), lamports: amount });
          }
        } else if (disc.every((b, i) => b === SETTLEMENT_DISCRIMINATORS.verifyReward[i]) && cfgAcc) {
          const rewardId = data.slice(8, 40);
          const amount = dv.getBigUint64(40, true);
          const cfg = decodeSettlementConfig(cfgAcc.data);
          const [signer, vault, receipt, player] = [at(1), at(3), at(4), at(5)];
          const rent = 890_880n;
          if (!isSigner(signer) || signer !== cfg.rewardSigner) fail(6001);
          else if (cfg.paused) fail(6002);
          else if (amount === 0n || amount > cfg.maxRewardPerClaim) fail(6003);
          else if (cfg.epochEmitted + amount > cfg.maxEmissionPerEpoch) fail(6004);
          else if (vault !== state.settlement.vault || (bal.get(vault) ?? 0n) - rent < amount) fail(6005);
          else if (receipt !== (await getRewardReceiptPda(program, rewardId)) || accounts.has(receipt)) fail(0); // "account already in use"
          else {
            accounts.set(receipt, { owner: program, data: encodeRewardReceipt({ rewardId, player, amount, claimedAt: 0n }) });
            accounts.set(state.settlement.config, { owner: program, data: encodeSettlementConfig({ ...cfg, epochEmitted: cfg.epochEmitted + amount }) });
            bal.set(vault, (bal.get(vault) ?? 0n) - amount);
            bal.set(player, (bal.get(player) ?? 0n) + amount);
            innerTransfers.push({ source: vault, destination: player, lamports: amount });
          }
        } else fail(101);
      }
    }
    if (!err) {
      state.balances = bal;
      state.accounts = accounts;
    }
    const post = keys.map((k) => (err ? (k === feePayer ? (pre[0] ?? 0n) - LAMPORTS_FEE : (state.balances.get(k) ?? 0n)) : (state.balances.get(k) ?? 0n)));
    if (err) state.balances.set(feePayer, (state.balances.get(feePayer) ?? 0n) - LAMPORTS_FEE);
    state.slot += 1;
    state.txs.set(signature, {
      signature,
      slot: state.slot,
      err,
      memo,
      feePayer,
      accountKeys,
      transfers: err ? [] : transfers,
      innerTransfers: err ? [] : innerTransfers,
      preBalances: pre,
      postBalances: post,
      confirmationStatus: state.commitment
    });
    return signature;
  }

  function parsedTx(t: MockTx): unknown {
    const instructions: unknown[] = t.transfers.map((tr) => ({
      program: "system",
      programId: SYSTEM_PROGRAM_ID,
      parsed: { type: "transfer", info: { source: tr.source, destination: tr.destination, lamports: tr.lamports } },
      stackHeight: null
    }));
    if (t.memo !== null) instructions.push({ program: "spl-memo", programId: MEMO_PROGRAM_IDS[0], parsed: t.memo, stackHeight: null });
    return {
      slot: t.slot,
      blockTime: Math.floor(Date.now() / 1000),
      version: 0,
      meta: {
        err: t.err,
        fee: Number(LAMPORTS_FEE),
        preBalances: t.preBalances,
        postBalances: t.postBalances,
        preTokenBalances: [],
        postTokenBalances: [],
        innerInstructions: t.innerTransfers.length
          ? [{
              index: 0,
              instructions: t.innerTransfers.map((tr) => ({
                program: "system",
                programId: SYSTEM_PROGRAM_ID,
                parsed: { type: "transfer", info: { source: tr.source, destination: tr.destination, lamports: tr.lamports } },
                stackHeight: 2
              }))
            }]
          : [],
        logMessages: [],
        status: t.err ? { Err: t.err } : { Ok: null }
      },
      transaction: {
        signatures: [t.signature],
        message: { accountKeys: t.accountKeys.map((k) => ({ ...k, source: "transaction" })), instructions, recentBlockhash: state.genesisHash }
      }
    };
  }

  const handle = async (payload: unknown): Promise<unknown> => {
    const p = payload as { id: number | string; method: string; params?: unknown[] };
    state.calls.push(p.method);
    const params = p.params ?? [];
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id: p.id, result: bigintJson(result) });
    switch (p.method) {
      case "getGenesisHash":
        return ok(state.genesisHash);
      case "getSlot":
        return ok(state.slot);
      case "getBlockHeight":
        return ok(state.blockHeight);
      case "getLatestBlockhash": {
        // Unique blockhash per call so identical transfers get distinct signatures (like a real chain).
        state.slot += 1;
        const bh = new Uint8Array(32);
        new DataView(bh.buffer).setUint32(0, state.slot);
        bh[31] = 1;
        return ok({ context: { slot: state.slot }, value: { blockhash: b58.decode(bh), lastValidBlockHeight: state.blockHeight + 150 } });
      }
      case "getAccountInfo": {
        const addr = String(params[0]);
        const acc = state.accounts.get(addr);
        const lamports = state.balances.get(addr);
        if (!acc && lamports === undefined) return ok({ context: { slot: state.slot }, value: null });
        const data = acc?.data ?? new Uint8Array();
        return ok({
          context: { slot: state.slot },
          value: { owner: acc?.owner ?? SYSTEM_PROGRAM_ID, lamports: lamports ?? 0n, data: [getBase64Decoder().decode(data), "base64"], executable: false, rentEpoch: 0, space: data.length }
        });
      }
      case "getMinimumBalanceForRentExemption":
        return ok(890_880n + 6_960n * BigInt(Number(params[0] ?? 0)));
      case "getBalance":
        return ok({ context: { slot: state.slot }, value: state.balances.get(String(params[0])) ?? 0n });
      case "sendTransaction": {
        const behavior = state.sendQueue.shift() ?? "land";
        if (behavior === "throw") return { jsonrpc: "2.0", id: p.id, error: { code: -32002, message: "Transaction simulation failed: mock preflight failure" } };
        const sig = await applyWire(String(params[0]), behavior);
        if (behavior === "land-then-throw") return { jsonrpc: "2.0", id: p.id, error: { code: -32005, message: "Node is behind (mock)" } };
        return ok(sig);
      }
      case "getSignatureStatuses": {
        const sigs = (params[0] as string[]) ?? [];
        return ok({
          context: { slot: state.slot },
          value: sigs.map((s) => {
            if (state.statusOverrides.has(s)) {
              const o = state.statusOverrides.get(s);
              return o ? { slot: o.slot, confirmations: null, err: o.err, confirmationStatus: o.confirmationStatus, status: o.err ? { Err: o.err } : { Ok: null } } : null;
            }
            const t = state.txs.get(s);
            return t ? { slot: t.slot, confirmations: null, err: t.err, confirmationStatus: t.confirmationStatus, status: t.err ? { Err: t.err } : { Ok: null } } : null;
          })
        });
      }
      case "getTransaction": {
        const s = String(params[0]);
        if (state.parsedOverrides.has(s)) return ok(state.parsedOverrides.get(s));
        const t = state.txs.get(s);
        return ok(t ? parsedTx(t) : null);
      }
      case "getSignaturesForAddress": {
        const addr = String(params[0]);
        const list = [...state.txs.values()]
          .filter((t) => t.accountKeys.some((k) => k.pubkey === addr))
          .sort((a, b) => b.slot - a.slot)
          .map((t) => ({
            signature: t.signature,
            slot: t.slot,
            err: t.err,
            memo: t.memo === null ? null : `[${t.memo.length}] ${t.memo}`,
            blockTime: null,
            confirmationStatus: t.confirmationStatus
          }));
        return ok(list);
      }
      case "requestAirdrop": {
        const addr = String(params[0]);
        state.balances.set(addr, (state.balances.get(addr) ?? 0n) + BigInt(params[1] as number));
        return ok(GENESIS_HASHES.devnet);
      }
      default:
        return { jsonrpc: "2.0", id: p.id, error: { code: -32601, message: `Mock RPC: method ${p.method} not implemented` } };
    }
  };
  const transport = (async ({ payload }: { payload: unknown }) => handle(payload)) as unknown as RpcTransport;

  return { rpc: createSolanaRpcFromTransport(transport) as unknown as SolanaRpcClient, state, handle };
}

/**
 * Serves the mock chain over real HTTP JSON-RPC (127.0.0.1, random port) so processes that build
 * their RPC from SOLANA_RPC_URL (e.g. the API) can be integration-tested end-to-end.
 */
export async function startMockRpcServer(init: Parameters<typeof createMockSolanaRpc>[0] = {}): Promise<{ url: string; state: MockChainState; rpc: SolanaRpcClient; close: () => Promise<void> }> {
  const { createServer } = await import("node:http");
  const mock = createMockSolanaRpc(init);
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
          const out = Array.isArray(body) ? await Promise.all(body.map((b) => mock.handle(b))) : await mock.handle(body);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(out));
        } catch (err) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: (err as Error).message } }));
        }
      })();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { url: `http://127.0.0.1:${port}`, state: mock.state, rpc: mock.rpc, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/**
 * Deploys an emulated `nebula_settlement` program into a mock chain: initialized config (reward signer +
 * caps) and a funded vault.
 */
export async function installMockSettlement(
  state: MockChainState,
  opts: { rewardSigner: string; vaultLamports?: bigint; programId?: string; config?: Partial<SettlementConfig> }
): Promise<{ programId: string; config: string; vault: string }> {
  const programId = opts.programId ?? DEFAULT_SETTLEMENT_PROGRAM_ID;
  const pdas = await getSettlementPdas(programId);
  state.settlement = { programId, config: pdas.config, vault: pdas.vault };
  const cfg: SettlementConfig = {
    authority: opts.rewardSigner,
    pendingAuthority: "11111111111111111111111111111111",
    rewardSigner: opts.rewardSigner,
    feeBps: 500,
    maxRewardPerClaim: 1_000_000_000n,
    maxEmissionPerEpoch: 2_000_000_000n,
    epochDurationSecs: 86_400n,
    epochStart: BigInt(Math.floor(Date.now() / 1000)),
    epochEmitted: 0n,
    paused: false,
    bump: 255,
    vaultBump: 255,
    ...opts.config
  };
  state.accounts.set(pdas.config, { owner: programId, data: encodeSettlementConfig(cfg) });
  state.balances.set(pdas.vault, 890_880n + (opts.vaultLamports ?? 0n));
  return { programId, config: pdas.config, vault: pdas.vault };
}
