/** Optional Redis connection (horizontal scaling + ticket replay protection). */
import { Redis } from "ioredis";

export function createRedis(url: string | null): Redis | null {
  if (!url) return null;
  return new Redis(url, {
    lazyConnect: false,
    maxRetriesPerRequest: 2,
    enableOfflineQueue: true,
    connectTimeout: 3000,
  });
}

export async function redisHealthy(r: Redis | null): Promise<boolean> {
  if (!r) return true;
  try {
    return (await r.ping()) === "PONG";
  } catch {
    return false;
  }
}
