/**
 * Client for apps/blockchain-service internal endpoints. Shared by every route that needs to wake
 * the withdrawal queue so URL/port resolution, auth and error handling cannot drift apart.
 */

export function blockchainServiceBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.BLOCKCHAIN_SERVICE_URL ?? `http://127.0.0.1:${env.BLOCKCHAIN_SERVICE_PORT ?? 8090}`;
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
