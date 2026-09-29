/**
 * Game-server admission: a 60 s single-purpose JWT ticket (aud "game") bound to user + map.
 * The map is decided by the server (last known map or faction home), never by the client.
 */
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { FACTIONS_BY_ID, MAPS_BY_ID } from "@nebula/config";
import { signGameTicket } from "@nebula/authentication";
import { gameTicketSchema } from "@nebula/validation";
import { badRequest, forbidden } from "../errors.js";
import { PushType, notifyMany } from "../lib/notify.js";

const TICKET_TTL_SEC = 60;
const PRESENCE_TTL_SEC = 10 * 60;
/** At most one FRIEND_ONLINE push per pilot per 30 minutes. */
const FRIEND_ONLINE_COOLDOWN_SEC = 30 * 60;

export default async function gameRoutes(app: FastifyInstance): Promise<void> {
  const { db, env } = app;

  app.post("/api/game/ticket", { preHandler: app.authenticate, config: { rateLimit: { max: 30, timeWindow: 60_000 } } }, async (req) => {
    app.parse(gameTicketSchema, req.body ?? {});
    const u = await db.user.findUniqueOrThrow({
      where: { id: req.user.id },
      select: { username: true, activeShipId: true, lastMapId: true, restrictions: true, playerFaction: { select: { factionId: true } } },
    });
    if (!u.playerFaction) throw badRequest("NO_FACTION", "Choose a faction first");
    if (!u.activeShipId) throw badRequest("NO_ACTIVE_SHIP", "Activate a ship first");
    if (u.restrictions.includes("GAME_SUSPENDED")) throw forbidden("Game access suspended", "GAME_SUSPENDED");
    const ship = await db.shipInstance.findFirst({ where: { id: u.activeShipId, userId: req.user.id }, select: { id: true } });
    if (!ship) throw badRequest("NO_ACTIVE_SHIP", "Activate a ship first");
    const home = FACTIONS_BY_ID.get(u.playerFaction.factionId)?.homeMap;
    const mapId = u.lastMapId && MAPS_BY_ID.has(u.lastMapId) ? u.lastMapId : home;
    if (!mapId) throw badRequest("NO_MAP", "No valid map for this pilot");
    const jti = randomUUID();
    const ticket = await signGameTicket({ sub: req.user.id, username: u.username, mapId, jti }, env.gameTicketKeys, TICKET_TTL_SEC);
    // Single use is enforced by the consumer only: the game server claims `gt:<jti>` with SET NX
    // on join. The API must NOT pre-write that key, or every ticket would read as replayed.
    // Presence: a ticket means the pilot is entering the game. The game server may keep refreshing
    // `presence:<userId>`; the API sets it with a TTL so friends see the pilot online.
    await app.redis.set(`presence:${req.user.id}`, "api", "EX", PRESENCE_TTL_SEC);
    const announce = await app.redis.set(`online:announced:${req.user.id}`, "1", "EX", FRIEND_ONLINE_COOLDOWN_SEC, "NX");
    if (announce === "OK") {
      const friends = await db.friend.findMany({ where: { friendId: req.user.id, status: "ACCEPTED" }, select: { userId: true }, take: 200 });
      // One batched insert; push delivery is handed to the dispatcher job so the ticket is never delayed by providers.
      // Presence notifications are best effort: a failure is logged and never fails the admission.
      await notifyMany(db, {
        userIds: friends.map((f) => f.userId),
        type: PushType.FRIEND_ONLINE,
        title: "Friend online",
        body: `${u.username} just came online.`,
        data: { friendId: req.user.id, mapId },
      }).catch((err: unknown) => req.log.warn({ err, userId: req.user.id }, "friend-online notifications failed"));
    }
    return { ticket, mapId, gameServerUrl: env.PUBLIC_GAME_SERVER_URL, expiresAt: new Date(Date.now() + TICKET_TTL_SEC * 1000).toISOString() };
  });
}
