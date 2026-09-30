/**
 * Tops up the nebula_settlement reward vault from the treasury (`fund_vault`), DEVNET only.
 * The vault only pays out through `verify_reward` (reward-signer co-signed, per-claim + per-epoch caps).
 *
 *   SERVICE_ROLE=blockchain npx tsx --env-file=../../.env scripts/settlement-fund-vault.ts <lamports> [--status]
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertRpcCluster,
  createRpcFromEnv,
  DEFAULT_SETTLEMENT_PROGRAM_ID,
  explorerUrl,
  fetchSettlementConfig,
  getSettlementPdas,
  getSolanaNetwork,
  getVaultAvailable,
  loadTreasurySigner,
  sendFundVault
} from "@nebula/blockchain";

export async function main(argv = process.argv): Promise<void> {
  process.env.SERVICE_ROLE = "blockchain";
  if (getSolanaNetwork() !== "devnet") throw new Error("settlement-fund-vault runs on devnet only");
  const rpc = createRpcFromEnv();
  await assertRpcCluster(rpc, "devnet");
  const programId = process.env.SETTLEMENT_PROGRAM_ID?.trim() || DEFAULT_SETTLEMENT_PROGRAM_ID;
  const pdas = await getSettlementPdas(programId);
  const cfg = await fetchSettlementConfig(rpc, pdas);
  if (!cfg) throw new Error(`program ${programId} is not initialized on devnet`);
  const report = async () =>
    console.info(JSON.stringify({ programId, vault: pdas.vault, available: (await getVaultAvailable(rpc, pdas)).toString(), paused: cfg.paused, rewardSigner: cfg.rewardSigner, maxRewardPerClaim: cfg.maxRewardPerClaim.toString(), maxEmissionPerEpoch: cfg.maxEmissionPerEpoch.toString(), epochEmitted: cfg.epochEmitted.toString() }));
  if (argv.includes("--status")) return report();
  const raw = argv.slice(2).find((a) => /^\d+$/.test(a));
  if (!raw) throw new Error("usage: settlement-fund-vault.ts <lamports> | --status");
  const amount = BigInt(raw);
  if (amount <= 0n || amount > 2_000_000_000n) throw new Error("amount must be 1..2_000_000_000 lamports (devnet guard)");
  const treasury = await loadTreasurySigner();
  const out = await sendFundVault({ rpc, funder: treasury, programId, amount, confirmTimeoutMs: 60_000 });
  console.info(`fund_vault ${amount} lamports: ${out.status} ${explorerUrl(out.signature, "devnet")}`);
  if (out.status !== "CONFIRMED") throw new Error("vault funding not confirmed");
  await report();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: Error) => {
    console.error(`[fund-vault] FAILED: ${err.message}`);
    process.exit(1);
  });
}
