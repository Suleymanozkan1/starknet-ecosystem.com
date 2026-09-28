/**
 * Colyseus server definition: room registry, transport, presence/driver
 * (Redis for horizontal scaling when configured), HTTP routes.
 */
import { LobbyRoom, LocalDriver, LocalPresence, defineRoom, defineServer } from "@colyseus/core";
import { RedisDriver } from "@colyseus/redis-driver";
import { RedisPresence } from "@colyseus/redis-presence";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { RoomName } from "@nebula/shared";
import { createRoutes } from "./http.js";
import { getServices } from "./services/context.js";
import { SectorRoom } from "./rooms/SectorRoom.js";
import { ArenaRoom, ClanWarRoom, PvPRoom } from "./rooms/MatchRoom.js";
import { BossRoom } from "./rooms/BossRoom.js";
import { GateRoom, RaidRoom } from "./rooms/GateRoom.js";
import { EventRoom } from "./rooms/EventRoom.js";
import { GalaxyRoom } from "./rooms/GalaxyRoom.js";

export interface CreateServerOptions {
  /** Redis URL for presence + matchmaking driver (horizontal scaling). null = in-process. */
  redisUrl: string | null;
  /** Public address of this node (for multi-node seat reservations). */
  publicAddress?: string;
  gracefullyShutdown?: boolean;
}

export function createGameServer(opts: CreateServerOptions) {
  return defineServer({
    presence: opts.redisUrl ? new RedisPresence(opts.redisUrl) : new LocalPresence(),
    driver: opts.redisUrl ? new RedisDriver(opts.redisUrl) : new LocalDriver(),
    transport: new WebSocketTransport({ pingInterval: 5000, pingMaxRetries: 3, maxPayload: 16 * 1024 }),
    publicAddress: opts.publicAddress,
    gracefullyShutdown: opts.gracefullyShutdown ?? true,
    greet: false,
    rooms: {
      [RoomName.LOBBY]: defineRoom(LobbyRoom),
      [RoomName.GALAXY]: defineRoom(GalaxyRoom),
      [RoomName.SECTOR]: defineRoom(SectorRoom).filterBy(["mapId"]).enableRealtimeListing(),
      [RoomName.PVP]: defineRoom(PvPRoom).filterBy(["mapId", "instanceKey", "difficulty"]).enableRealtimeListing(),
      [RoomName.ARENA]: defineRoom(ArenaRoom).filterBy(["mapId", "instanceKey"]).enableRealtimeListing(),
      [RoomName.BOSS]: defineRoom(BossRoom).filterBy(["mapId"]).enableRealtimeListing(),
      [RoomName.GATE]: defineRoom(GateRoom).filterBy(["mapId", "instanceKey", "difficulty"]),
      [RoomName.RAID]: defineRoom(RaidRoom).filterBy(["mapId", "instanceKey", "difficulty"]),
      [RoomName.CLAN_WAR]: defineRoom(ClanWarRoom).filterBy(["mapId", "instanceKey"]),
      [RoomName.EVENT]: defineRoom(EventRoom).filterBy(["mapId", "instanceKey"]).enableRealtimeListing(),
    },
    routes: createRoutes(getServices),
  });
}
