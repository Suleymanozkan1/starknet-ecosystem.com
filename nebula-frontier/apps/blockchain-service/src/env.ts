export interface ServiceEnv {
  port: number;
  host: string;
  redisUrl: string;
  internalToken: string;
  maxAttempts: number;
  backoffBaseMs: number;
  confirmPollMs: number;
  controllerIntervalMs: number;
  sweepIntervalMs: number;
  concurrency: number;
}

export function loadServiceEnv(env: NodeJS.ProcessEnv = process.env): ServiceEnv {
  const token = env.INTERNAL_SERVICE_TOKEN ?? "";
  if (token.length < 32) throw new Error("INTERNAL_SERVICE_TOKEN must be set (>= 32 chars)");
  const n = (v: string | undefined, d: number) => {
    const x = Number(v);
    return Number.isFinite(x) && x > 0 ? x : d;
  };
  return {
    port: n(env.BLOCKCHAIN_SERVICE_PORT, 8090),
    host: env.BLOCKCHAIN_SERVICE_HOST ?? "127.0.0.1",
    redisUrl: env.REDIS_URL ?? "redis://localhost:6379",
    internalToken: token,
    maxAttempts: n(env.WITHDRAWAL_MAX_ATTEMPTS, 5),
    backoffBaseMs: n(env.WITHDRAWAL_BACKOFF_MS, 15_000),
    confirmPollMs: n(env.WITHDRAWAL_CONFIRM_POLL_MS, 4_000),
    controllerIntervalMs: n(env.ECONOMY_CONTROLLER_INTERVAL_MS, 5 * 60_000),
    sweepIntervalMs: n(env.CHAIN_SWEEP_INTERVAL_MS, 60_000),
    concurrency: n(env.WITHDRAWAL_CONCURRENCY, 2)
  };
}
