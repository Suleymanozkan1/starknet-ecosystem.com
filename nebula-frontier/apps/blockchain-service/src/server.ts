import Fastify, { type FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import type { Queue } from "bullmq";
import type { Redis } from "ioredis";
import type { Db } from "@nebula/database";
import { measureRpcLatency, type SolanaRpcClient } from "@nebula/blockchain";
import { enqueueWithdrawal, type WithdrawalJob } from "./queue.js";
import type { Metrics } from "./metrics.js";

export interface ServerDeps {
  db: Db;
  redis: Redis;
  rpc: SolanaRpcClient;
  queue: Queue<WithdrawalJob>;
  metrics: Metrics;
  internalToken: string;
  treasuryAddress: string;
}

function tokenOk(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024 });
  const started = Date.now();

  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/internal") && !req.url.startsWith("/metrics")) return;
    const h = req.headers.authorization;
    const bearer = typeof h === "string" && h.startsWith("Bearer ") ? h.slice(7) : undefined;
    const hdr = req.headers["x-internal-token"];
    const provided = bearer ?? (typeof hdr === "string" ? hdr : undefined);
    if (!tokenOk(provided, deps.internalToken)) {
      await reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Invalid internal token" } });
    }
  });

  app.post<{ Params: { id: string } }>("/internal/withdrawals/:id/enqueue", async (req, reply) => {
    const id = req.params.id;
    if (!/^[a-z0-9]{8,40}$/i.test(id)) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "Invalid id" } });
    const w = await deps.db.withdrawal.findUnique({ where: { id }, select: { id: true, status: true } });
    if (!w) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Withdrawal not found" } });
    await enqueueWithdrawal(deps.queue, id);
    deps.metrics.inc("withdrawals_enqueued_total");
    return { queued: true, withdrawalId: id, status: w.status };
  });

  app.get("/health", async () => ({ ok: true, service: "blockchain-service", uptimeSec: Math.round((Date.now() - started) / 1000) }));

  app.get("/ready", async (_req, reply) => {
    const [dbOk, redisOk, rpc, counts] = await Promise.all([
      deps.db.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
      deps.redis.ping().then((r) => r === "PONG").catch(() => false),
      measureRpcLatency(deps.rpc),
      deps.queue.getJobCounts("waiting", "active", "delayed", "failed").catch(() => null)
    ]);
    const balance = await deps.rpc
      .getBalance(deps.treasuryAddress as Parameters<SolanaRpcClient["getBalance"]>[0], { commitment: "confirmed" })
      .send()
      .then((r) => r.value.toString())
      .catch(() => null);
    const ready = dbOk && redisOk && rpc.ok;
    deps.metrics.set("rpc_latency_ms", rpc.latencyMs);
    if (counts) for (const [k, v] of Object.entries(counts)) deps.metrics.set("withdrawal_queue_jobs", v, { state: k });
    const body = { ready, db: dbOk, redis: redisOk, rpc: { ok: rpc.ok, latencyMs: rpc.latencyMs, slot: rpc.slot?.toString() ?? null, error: rpc.error ?? null }, queue: counts, treasury: { address: deps.treasuryAddress, lamports: balance } };
    return reply.code(ready ? 200 : 503).send(body);
  });

  app.get("/metrics", async (_req, reply) => {
    reply.header("content-type", "text/plain; version=0.0.4");
    return deps.metrics.render();
  });

  return app;
}
