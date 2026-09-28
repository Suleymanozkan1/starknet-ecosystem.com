/**
 * Process-wide services shared by all rooms. Colyseus instantiates rooms
 * itself, so rooms read services from this module (set once at boot or by tests).
 */
import type { Db } from "@nebula/database";
import type { Logger } from "@nebula/telemetry";
import type { Redis } from "ioredis";
import type { GameServerConfig } from "../config.js";
import type { Persistence } from "../persistence/writer.js";
import type { RiskReporter } from "./risk.js";
import type { TicketService } from "./tickets.js";
import type { EventEngine } from "./events.js";
import type { ClanMissionReporter } from "./clan-missions.js";

export interface GameServices {
  config: GameServerConfig;
  db: Db;
  redis: Redis | null;
  log: Logger;
  tickets: TicketService;
  persistence: Persistence;
  risk: RiskReporter;
  events: EventEngine;
  clanMissions: ClanMissionReporter;
  /** Deterministic RNG seed override for tests (undefined = crypto seeded). */
  rngSeed?: number;
}

let services: GameServices | null = null;

export function setServices(s: GameServices): void {
  services = s;
}

export function getServices(): GameServices {
  if (!services) throw new Error("Game services not initialised");
  return services;
}
