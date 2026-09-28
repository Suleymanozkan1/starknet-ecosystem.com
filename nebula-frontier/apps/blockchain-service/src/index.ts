/**
 * apps/blockchain-service — the ONLY process that holds the treasury key.
 * Runs the withdrawal payout queue (BullMQ on Redis + durable rows in Postgres), the economy
 * controller (every 5 min) and reward expiry, and exposes an internal HTTP API.
 */
import { Redis } from "ioredis";
import { createDb } from "@nebula/database";
import {
  assertRpcCluster,
  createRpcFromEnv,
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
  await assertRpcCluster(rpc, network);
  const { mint, decimals } = getRewardMint();

  const db = createDb();
  const redis = new Redis(env.redisUrl, { maxRetriesPerRequest: null });
  const connection = redis;
  const metrics = new Metrics();
  const queue = createWithdrawalQueue(connection);
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
      metrics
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

  const server = buildServer({ db, redis, rpc, queue, metrics, internalToken: env.internalToken, treasuryAddress });
  await server.listen({ port: env.port, host: env.host });
  log.info("blockchain-service listening", { port: env.port, network, treasury: treasuryAddress, mint });

  const shutdown = async (sig: string) => {
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
