/** Build the process-wide services (DB, Redis, logger, tickets, persistence, events). */
import { createDb, type Db } from "@nebula/database";
import { createLogger, initMetrics } from "@nebula/telemetry";
import type { GameServerConfig } from "./config.js";
import { Persistence } from "./persistence/writer.js";
import { setServices, type GameServices } from "./services/context.js";
import { EventEngine } from "./services/events.js";
import { ClanMissionReporter } from "./services/clan-missions.js";
import { createRedis } from "./services/redis.js";
import { RiskReporter } from "./services/risk.js";
import { TicketService } from "./services/tickets.js";

export function buildServices(config: GameServerConfig, opts: { db?: Db; useRedis?: boolean; logLevel?: string; rngSeed?: number } = {}): GameServices {
  const log = createLogger({ name: "game-server", level: opts.logLevel, base: { region: config.region } });
  initMetrics({ service: "game-server", region: config.region });
  const db = opts.db ?? createDb();
  const redis = opts.useRedis === false ? null : createRedis(config.redisUrl);
  const svc: GameServices = {
    config,
    db,
    redis,
    log,
    tickets: new TicketService(config.gameTicketKeys, redis),
    persistence: new Persistence(db),
    risk: new RiskReporter(db, log),
    events: new EventEngine(),
    clanMissions: new ClanMissionReporter({ baseUrl: config.apiInternalUrl, token: config.internalServiceToken, log }),
    rngSeed: opts.rngSeed,
  };
  setServices(svc);
  return svc;
}
