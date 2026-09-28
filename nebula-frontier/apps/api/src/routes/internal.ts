/**
 * Internal service-to-service endpoints (game server -> API). Authenticated with the shared
 * `INTERNAL_SERVICE_TOKEN` in the `x-internal-token` header (constant-time compare); disabled
 * (503) when the token is not configured. Not reachable with player credentials.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { safeEqual } from "@nebula/authentication";
import { clanMissionProgressSchema } from "@nebula/validation";
import { unauthorized, unavailable } from "../errors.js";
import { contributeToMissions } from "../lib/clanMissions.js";

export default async function internalRoutes(app: FastifyInstance): Promise<void> {
  const requireService = async (req: FastifyRequest) => {
    const token = app.env.INTERNAL_SERVICE_TOKEN;
    if (!token) throw unavailable("INTERNAL_DISABLED", "Internal API is not configured");
    const h = req.headers["x-internal-token"];
    if (typeof h !== "string" || !safeEqual(h, token)) throw unauthorized("Invalid service token", "INVALID_SERVICE_TOKEN");
  };

  /** Batched gameplay events for clan-mission objectives that target a specific NPC/item/map/gate. */
  app.post("/api/internal/clan-missions/progress", { preHandler: requireService, config: { rateLimit: { max: 600, timeWindow: 60_000 } } }, async (req) => {
    const body = app.parse(clanMissionProgressSchema, req.body);
    let touched = 0;
    for (const e of body.events) touched += await contributeToMissions(app.db, e.userId, e.event);
    return { ok: true, missionsUpdated: touched };
  });
}
