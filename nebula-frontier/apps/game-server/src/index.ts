/**
 * NEBULA FRONTIER authoritative game server (Colyseus 0.18).
 * `npx tsx --env-file=../../.env src/index.ts`
 */
import { matchMaker } from "@colyseus/core";
import { disconnectDb } from "@nebula/database";
import { loadConfig } from "./config.js";
import { buildServices } from "./bootstrap.js";
import { ensureCatalog } from "./persistence/catalog.js";
import { createGameServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const svc = buildServices(config);
  await ensureCatalog(svc.db);
  const server = createGameServer({ redisUrl: config.redisUrl, publicAddress: process.env.GAME_PUBLIC_ADDRESS || undefined });
  server.onShutdown(async () => {
    svc.log.info("shutting down: rooms persisted, closing connections");
    svc.events.stop();
    svc.clanMissions.stop();
    // Last chance for failed post-leave flushes; anything still failing is dropped with an error metric.
    await svc.flushRetry.drainAndDrop();
    await svc.clanMissions.flush();
    await disconnectDb().catch(() => undefined);
    await svc.db.$disconnect().catch(() => undefined);
    if (svc.redis) await svc.redis.quit().catch(() => undefined);
  });
  await server.listen(config.port);
  svc.events.start(matchMaker.presence);
  svc.clanMissions.start(config.flushIntervalMs);
  svc.log.info({ port: config.port, region: config.region, tickRate: config.tickRate, redis: !!config.redisUrl }, "game server listening");
}

main().catch((err: unknown) => {
  console.error("game-server failed to start", err instanceof Error ? err.message : err);
  process.exit(1);
});
