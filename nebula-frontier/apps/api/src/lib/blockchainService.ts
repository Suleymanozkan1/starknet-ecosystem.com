/**
 * Client for apps/blockchain-service internal endpoints. Shared by every route that needs to wake
 * the withdrawal queue so URL/port resolution, auth and error handling cannot drift apart.
 */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname) || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

/**
 * Base URL of blockchain-service. The internal bearer token travels with every request, so in
 * production a non-loopback URL must use https (plain http is only accepted on loopback). Development
 * keeps plain http for private container networks (docker-compose `http://blockchain-service:8090`).
 */
export function blockchainServiceBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.BLOCKCHAIN_SERVICE_URL?.trim();
  if (!raw) return `http://127.0.0.1:${env.BLOCKCHAIN_SERVICE_PORT ?? 8090}`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("BLOCKCHAIN_SERVICE_URL is not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("BLOCKCHAIN_SERVICE_URL must use http(s)");
  if (url.username || url.password) throw new Error("BLOCKCHAIN_SERVICE_URL must not embed credentials");
  if (env.NODE_ENV === "production" && url.protocol !== "https:" && !isLoopbackHost(url.hostname)) {
    throw new Error("BLOCKCHAIN_SERVICE_URL must use https unless it points to loopback");
  }
  return raw.replace(/\/+$/, "");
}

/** blockchain-service refuses to start with a shorter token (apps/blockchain-service/src/env.ts). */
export const MIN_INTERNAL_TOKEN_LENGTH = 32;

/** Returns the trimmed internal service token, or throws before any request is sent without valid auth. */
export function internalServiceToken(env: NodeJS.ProcessEnv = process.env): string {
  const token = env.INTERNAL_SERVICE_TOKEN?.trim();
  if (!token || token.length < MIN_INTERNAL_TOKEN_LENGTH) {
    throw new Error(`INTERNAL_SERVICE_TOKEN is not configured (need at least ${MIN_INTERNAL_TOKEN_LENGTH} characters)`);
  }
  return token;
}

/** Asks blockchain-service to enqueue a withdrawal. Throws on missing auth, network errors and non-2xx responses. */
export async function notifyBlockchainServiceEnqueue(withdrawalId: string): Promise<void> {
  const token = internalServiceToken();
  const res = await fetch(`${blockchainServiceBaseUrl()}/internal/withdrawals/${encodeURIComponent(withdrawalId)}/enqueue`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(3000)
  });
  if (!res.ok) throw new Error(`blockchain-service responded ${res.status}`);
}
