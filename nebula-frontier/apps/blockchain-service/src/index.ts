/**
 * apps/blockchain-service — the ONLY process that holds the treasury key.
 * Runs the withdrawal payout queue (BullMQ on Redis + durable rows in Postgres), the economy
 * controller (every 5 min) and reward expiry, and exposes an internal HTTP API.
 */
import { Redis } from "ioredis";
import { createDb } from "@nebula/database";
import {
  assertRpcCluster,
  checkSettlementEligibility,
  createRpcFromEnv,
  getSettlementPdas,
  getRewardMint,
  getSolanaNetwork,
  getTreasuryAddress,
  loadTreasurySigner
} from "@nebula/blockchain";
import { EconomyController, expireRewards } from "@nebula/economy";
import { loadServiceEnv } from "./env.js";
import { log } from "./logger.js";
import { Metrics } from "./metrics.js";
import { createWithdrawalQueue, createWithdrawalWorker, recoverQueue } from "./queue.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const env = loadServiceEnv();
  const network = getSolanaNetwork();
  const signer = await loadTreasurySigner(); // throws unless SERVICE_ROLE=blockchain
  const treasuryAddress = getTreasuryAddress();
  if (signer.address !== treasuryAddress) throw new Error("Treasury signer does not match TREASURY_PUBLIC_KEY");
  const rpc = createRpcFromEnv();
  const { mint, decimals } = getRewardMint();

  const db = createDb();
  const redis = new Redis(env.redisUrl, { maxRetriesPerRequest: null });
  const connection = redis;
  const metrics = new Metrics();
  const queue = createWithdrawalQueue(connection);
  const earlyServer = buildServer({ db, redis, rpc, queue, metrics, internalToken: env.internalToken, treasuryAddress });
  let stopping = false;
  // Safety gate: never pay out before the RPC is proven to be the configured cluster (genesis hash).
  // An unreachable RPC at boot must not crash the service (queued payouts stay durable in Postgres and
  // /health stays up); retry with exponential backoff and start the payout worker only once verified.
  for (let attempt = 1; !stopping; attempt++) {
    try {
      await assertRpcCluster(rpc, network);
      metrics.set("rpc_cluster_verified", 1);
      break;
    } catch (err) {
      metrics.set("rpc_cluster_verified", 0);
      const waitMs = Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6));
      log.warn("RPC cluster check failed; payouts held until verified", { attempt, retryInMs: waitMs, error: (err as Error).message });
      if (attempt === 1) {
        // Serve /health (+ /ready = 503) while waiting so orchestrators see a live, not-ready service.
        await earlyServer.listen({ port: env.port, host: env.host });
      }
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  if (env.settlement) {
    if (mint) log.warn("ONCHAIN_SETTLEMENT_ENABLED has no effect for SPL payouts (the program vault holds SOL)", { mint });
    // Boot-time probe only (a 1-lamport check); every payout re-checks eligibility and falls back when needed.
    const probe = await checkSettlementEligibility(rpc, { pdas: await getSettlementPdas(env.settlement.programId), rewardSigner: treasuryAddress, amount: 1n }).catch((err: Error) => ({ ok: false as const, reason: err.message }));
    metrics.set("settlement_enabled", 1);
    log.info("on-chain settlement enabled", { programId: env.settlement.programId, ready: probe.ok, ...(probe.ok ? {} : { reason: probe.reason }) });
  } else {
    metrics.set("settlement_enabled", 0);
  }
  const worker = createWithdrawalWorker(
    connection,
    {
      db,
      rpc,
      getSigner: async () => signer,
      treasuryAddress,
      mint,
      mintDecimals: decimals,
      maxAttempts: env.maxAttempts,
      backoffBaseMs: env.backoffBaseMs,
      confirmPollMs: env.confirmPollMs,
      inlineConfirmMs: 30_000,
      metrics,
      settlement: env.settlement
    },
    { concurrency: env.concurrency }
  );

  await recoverQueue(db, queue);
  const sweep = setInterval(() => {
    recoverQueue(db, queue).catch((err: Error) => log.error("sweep failed", { error: err.message }));
  }, env.sweepIntervalMs);

  const controller = new EconomyController(db);
  const runController = async () => {
    try {
      const expired = await expireRewards(db);
      const r = await controller.run();
      metrics.set("treasury_coverage", Number.isFinite(r.metrics.treasury.coverage) ? r.metrics.treasury.coverage : 999);
      metrics.set("reward_rate", r.metrics.rewardRate);
      metrics.inc("economy_controller_runs_total");
      log.info("economy controller run", {
        health: r.metrics.treasury.health,
        anomalies: r.anomalies.map((a) => a.kind),
        breakersOn: r.breakersOn,
        breakersOff: r.breakersOff,
        expiredRewards: expired
      });
    } catch (err) {
      log.error("economy controller failed", { error: (err as Error).message });
    }
  };
  void runController();
  const ctrl = setInterval(() => void runController(), env.controllerIntervalMs);

  const server = earlyServer;
  if (!server.server.listening) await server.listen({ port: env.port, host: env.host });
  log.info("blockchain-service listening", { port: env.port, network, treasury: treasuryAddress, mint });

  const shutdown = async (sig: string) => {
    stopping = true;
    log.info("shutting down", { signal: sig });
    clearInterval(sweep);
    clearInterval(ctrl);
    await server.close().catch(() => undefined);
    await worker.close().catch(() => undefined);
    await queue.close().catch(() => undefined);
    await redis.quit().catch(() => undefined);
    await db.$disconnect().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: Error) => {
  log.error("blockchain-service failed to start", { error: err.message });
  process.exit(1);
});
