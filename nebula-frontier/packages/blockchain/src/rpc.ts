import {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  type Commitment,
  type Rpc,
  type RpcSubscriptions,
  type SolanaRpcApi,
  type SolanaRpcSubscriptionsApi
} from "@solana/kit";

export type SolanaNetwork = "devnet" | "testnet" | "localnet";
export type SolanaRpcClient = Rpc<SolanaRpcApi>;
export type SolanaRpcSubscriptionsClient = RpcSubscriptions<SolanaRpcSubscriptionsApi>;

/** Genesis hashes used to prove the RPC endpoint is really the configured cluster. */
export const GENESIS_HASHES: Record<Exclude<SolanaNetwork, "localnet">, string> = {
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  testnet: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY"
};

const DEFAULT_URLS: Record<SolanaNetwork, { http: string; ws: string }> = {
  devnet: { http: "https://api.devnet.solana.com", ws: "wss://api.devnet.solana.com" },
  testnet: { http: "https://api.testnet.solana.com", ws: "wss://api.testnet.solana.com" },
  localnet: { http: "http://127.0.0.1:8899", ws: "ws://127.0.0.1:8900" }
};

/**
 * This project is DEVNET ONLY. Mainnet is refused outright so a misconfigured env can never
 * move real funds.
 */
export function getSolanaNetwork(env: NodeJS.ProcessEnv = process.env): SolanaNetwork {
  const raw = (env.SOLANA_NETWORK ?? "devnet").trim().toLowerCase();
  if (raw === "devnet" || raw === "testnet" || raw === "localnet") return raw;
  throw new Error(`Unsupported SOLANA_NETWORK "${raw}" — NEBULA FRONTIER runs on devnet only`);
}

export function getRpcUrls(env: NodeJS.ProcessEnv = process.env): { http: string; ws: string } {
  const net = getSolanaNetwork(env);
  const http = env.SOLANA_RPC_URL?.trim() || DEFAULT_URLS[net].http;
  const ws = env.SOLANA_WS_URL?.trim() || DEFAULT_URLS[net].ws;
  if (/mainnet/i.test(http) || /mainnet/i.test(ws)) throw new Error("Mainnet RPC endpoints are not allowed");
  return { http, ws };
}

export function getCommitment(env: NodeJS.ProcessEnv = process.env): Commitment {
  const c = (env.SOLANA_COMMITMENT ?? "confirmed").trim();
  return c === "finalized" || c === "processed" ? c : "confirmed";
}

export function createRpcFromEnv(env: NodeJS.ProcessEnv = process.env): SolanaRpcClient {
  return createSolanaRpc(getRpcUrls(env).http);
}

export function createRpcSubscriptionsFromEnv(env: NodeJS.ProcessEnv = process.env): SolanaRpcSubscriptionsClient {
  return createSolanaRpcSubscriptions(getRpcUrls(env).ws);
}

/** Verifies the RPC endpoint serves the expected cluster (genesis hash check). */
export async function assertRpcCluster(rpc: SolanaRpcClient, network: SolanaNetwork = getSolanaNetwork()): Promise<void> {
  if (network === "localnet") return;
  const genesis = await rpc.getGenesisHash().send();
  if (genesis !== GENESIS_HASHES[network]) {
    throw new Error(`RPC cluster mismatch: expected ${network} genesis ${GENESIS_HASHES[network]}, got ${genesis}`);
  }
}

/** Measures round-trip latency of a cheap RPC call (used by /ready). */
export async function measureRpcLatency(rpc: SolanaRpcClient): Promise<{ ok: boolean; latencyMs: number; slot?: bigint; error?: string }> {
  const start = performance.now();
  try {
    const slot = await rpc.getSlot({ commitment: "confirmed" }).send();
    return { ok: true, latencyMs: Math.round(performance.now() - start), slot };
  } catch (err) {
    return { ok: false, latencyMs: Math.round(performance.now() - start), error: (err as Error).message };
  }
}

export function explorerUrl(sig: string, network: SolanaNetwork | string = getSolanaNetwork(), kind: "tx" | "address" = "tx"): string {
  const base = `https://explorer.solana.com/${kind}/${sig}`;
  if (network === "localnet") return `${base}?cluster=custom&customUrl=${encodeURIComponent("http://127.0.0.1:8899")}`;
  if (network === "mainnet-beta") return base;
  return `${base}?cluster=${network}`;
}
