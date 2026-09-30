import { describe, expect, it } from "vitest";
import type { SolanaRpcClient } from "./rpc.js";
import { GENESIS_HASHES, assertRpcCluster, getRpcUrls, getSolanaNetwork } from "./rpc.js";

/** BC-11: the project runs on devnet (or a local validator) only — mainnet is refused at every entry point. */
describe("devnet-only network guard", () => {
  it("defaults to devnet and accepts only non-mainnet clusters", () => {
    expect(getSolanaNetwork({})).toBe("devnet");
    expect(getSolanaNetwork({ SOLANA_NETWORK: " DevNet " })).toBe("devnet");
    expect(getSolanaNetwork({ SOLANA_NETWORK: "localnet" })).toBe("localnet");
    for (const bad of ["mainnet", "mainnet-beta", "Mainnet-Beta", "prod"]) {
      expect(() => getSolanaNetwork({ SOLANA_NETWORK: bad })).toThrow(/devnet only/);
    }
  });

  it("refuses mainnet RPC endpoints even when the network name says devnet", () => {
    expect(getRpcUrls({}).http).toMatch(/devnet/);
    expect(() => getRpcUrls({ SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com" })).toThrow(/Mainnet RPC/);
    expect(() => getRpcUrls({ SOLANA_WS_URL: "wss://mainnet.helius-rpc.com" })).toThrow(/Mainnet RPC/);
  });

  it("rejects an RPC whose genesis hash is not the configured cluster", async () => {
    const rpcWithGenesis = (hash: string) => ({ getGenesisHash: () => ({ send: async () => hash }) }) as unknown as SolanaRpcClient;
    await expect(assertRpcCluster(rpcWithGenesis(GENESIS_HASHES.devnet), "devnet")).resolves.toBeUndefined();
    await expect(assertRpcCluster(rpcWithGenesis("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"), "devnet")).rejects.toThrow(/cluster mismatch/);
  });
});
