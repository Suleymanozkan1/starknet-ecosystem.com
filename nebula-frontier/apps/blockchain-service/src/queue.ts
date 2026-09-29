import { DelayedError, Queue, Worker, type ConnectionOptions, type Job } from "bullmq";
import type { Db } from "@nebula/database";
import { findRecoverableWithdrawals, processWithdrawal, type ProcessorDeps } from "./processor.js";
import { log } from "./logger.js";

export const WITHDRAWAL_QUEUE = "nebula-withdrawals";

export interface WithdrawalJob {
  withdrawalId: string;
}

export function jobIdFor(withdrawalId: string): string {
  return `wd-${withdrawalId}`;
}

export function createWithdrawalQueue(connection: ConnectionOptions, name = WITHDRAWAL_QUEUE): Queue<WithdrawalJob> {
  return new Queue<WithdrawalJob>(name, {
    connection,
    defaultJobOptions: { removeOnComplete: true, removeOnFail: 1000, attempts: 1 }
  });
}

/** Idempotent: the jobId dedupes while a job for this withdrawal is waiting/delayed/active. */
export async function enqueueWithdrawal(queue: Queue<WithdrawalJob>, withdrawalId: string, delayMs = 0): Promise<void> {
  const jobId = jobIdFor(withdrawalId);
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === "failed" || state === "completed") await existing.remove().catch(() => undefined);
    else return;
  }
  await queue.add("payout", { withdrawalId }, { jobId, delay: Math.max(0, delayMs) });
}

/**
 * Postgres is the source of truth. On boot (and periodically) every withdrawal whose durable state is
 * PENDING or PROCESSING/{CREATED,QUEUED,SUBMITTED,CONFIRMING,RETRYING} is (re-)enqueued, so losing
 * Redis never loses a queued payout.
 */
export async function recoverQueue(db: Db, queue: Queue<WithdrawalJob>): Promise<number> {
  const ids = await findRecoverableWithdrawals(db);
  for (const id of ids) await enqueueWithdrawal(queue, id);
  if (ids.length) log.info("re-enqueued withdrawals from durable state", { count: ids.length });
  return ids.length;
}

export function createWithdrawalWorker(connection: ConnectionOptions, deps: ProcessorDeps, opts: { concurrency?: number; name?: string } = {}): Worker<WithdrawalJob> {
  const worker = new Worker<WithdrawalJob>(
    opts.name ?? WITHDRAWAL_QUEUE,
    async (job: Job<WithdrawalJob>, token?: string) => {
      let retryInMs: number;
      try {
        const r = await processWithdrawal(deps, job.data.withdrawalId);
        if (r.done) return r;
        retryInMs = r.retryInMs;
      } catch (err) {
        // Unexpected error (DB/RPC outage): never drop the job — back off and retry.
        log.error("withdrawal step crashed; rescheduling", { withdrawalId: job.data.withdrawalId, error: (err as Error).message });
        retryInMs = deps.backoffBaseMs;
      }
      await job.moveToDelayed(Date.now() + Math.max(250, retryInMs), token);
      throw new DelayedError();
    },
    { connection, concurrency: opts.concurrency ?? 2, lockDuration: 120_000 }
  );
  worker.on("error", (err) => log.error("worker error", { error: err.message }));
  return worker;
}
