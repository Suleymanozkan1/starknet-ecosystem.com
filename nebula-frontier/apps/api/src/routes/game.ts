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

const TICKET_TTL_SEC = 60;

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
    const ticket = await signGameTicket({ sub: req.user.id, username: u.username, mapId, jti }, env.GAME_TICKET_SECRET, TICKET_TTL_SEC);
    // Recorded so the game server can enforce single use (SET NX on consume).
    await app.redis.set(`gt:${jti}`, req.user.id, "EX", TICKET_TTL_SEC + 5);
    return { ticket, mapId, gameServerUrl: env.PUBLIC_GAME_SERVER_URL, expiresAt: new Date(Date.now() + TICKET_TTL_SEC * 1000).toISOString() };
  });
}
