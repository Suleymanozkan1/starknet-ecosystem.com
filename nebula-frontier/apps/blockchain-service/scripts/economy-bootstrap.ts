/**
 * Treasury bootstrap / reconciliation.
 * Reads the REAL devnet treasury balance via RPC and records only the not-yet-accounted funds as an
 * ADMIN_ADJUSTMENT (EXTERNAL_CHAIN → TREASURY), split into PLAYER_REWARD_POOL / reserves by ratio.
 * Safe to re-run: it never funds more than the chain holds.
 *
 *   pnpm --filter @nebula/blockchain-service economy:bootstrap     (or npx tsx scripts/economy-bootstrap.ts)
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, disconnectDb, getDb } from "@nebula/database";
import { createRpcFromEnv, getTokenBalance, getTreasuryAddress, assertRpcCluster, explorerUrl, getSolanaNetwork, type SolanaRpcClient } from "@nebula/blockchain";
import { bootstrapTreasury, type BootstrapResult } from "@nebula/economy";
import type { Db } from "@nebula/database";

export async function runBootstrap(db: Db, rpc: SolanaRpcClient, treasuryAddress: string): Promise<BootstrapResult & { onChain: bigint; slot: bigint }> {
  const { value: onChain, context } = await rpc.getBalance(treasuryAddress as Parameters<SolanaRpcClient["getBalance"]>[0], { commitment: "finalized" }).send();
  // SPL reward-mint mode: NEBX is backed only by the treasury's reward-token balance (never by SOL).
  const mint = process.env.REWARD_MINT?.trim();
  let rewardTokenBalance: bigint | undefined;
  if (mint) rewardTokenBalance = await getTokenBalance(rpc, treasuryAddress, mint);
  const r = await bootstrapTreasury(db, { onChainBalance: onChain, rewardTokenBalance, slot: context.slot, treasuryAddress });
  return { ...r, onChain, slot: context.slot };
}

export async function main(): Promise<void> {
  const rpc = createRpcFromEnv();
  await assertRpcCluster(rpc);
  const treasury = getTreasuryAddress();
  const db = process.env.DATABASE_URL ? getDb() : createDb();
  try {
    const r = await runBootstrap(db, rpc, treasury);
    console.info(`Treasury ${treasury} (${explorerUrl(treasury, getSolanaNetwork(), "address")})`);
    console.info(`On-chain balance: ${r.onChain} lamports at slot ${r.slot}`);
    console.info(`Ledger already accounted: ${r.accounted}; newly funded: ${r.funded}`);
    for (const [k, v] of Object.entries(r.allocation)) console.info(`  ${k}: ${v}`);
    if (r.seasonId) console.info(`Active season: ${r.seasonId}`);
    for (const w of r.warnings) console.warn(`WARNING: ${w}`);
  } finally {
    await disconnectDb();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: Error) => {
    console.error(err.message);
    process.exit(1);
  });
}
