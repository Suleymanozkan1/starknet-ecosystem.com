/**
 * Client for apps/blockchain-service internal endpoints. Shared by every route that needs to wake
 * the withdrawal queue so URL/port resolution, auth and error handling cannot drift apart.
 */

export function blockchainServiceBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.BLOCKCHAIN_SERVICE_URL ?? `http://127.0.0.1:${env.BLOCKCHAIN_SERVICE_PORT ?? 8090}`;
}

/** Asks blockchain-service to enqueue a withdrawal. Throws on network errors and non-2xx responses. */
export async function notifyBlockchainServiceEnqueue(withdrawalId: string): Promise<void> {
  const token = process.env.INTERNAL_SERVICE_TOKEN ?? "";
  const res = await fetch(`${blockchainServiceBaseUrl()}/internal/withdrawals/${encodeURIComponent(withdrawalId)}/enqueue`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(3000)
  });
  if (!res.ok) throw new Error(`blockchain-service responded ${res.status}`);
}
