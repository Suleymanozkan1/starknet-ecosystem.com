/**
 * Public world data: galaxy -> sector -> star system -> map hierarchy, live rooms, gates, API rules.
 */
import type { FastifyInstance } from "fastify";
import { GALAXY, GATES, MAPS, MAPS_BY_ID } from "@nebula/config";
import { defIdSchema } from "@nebula/validation";
import { notFound } from "../errors.js";
import { getFees } from "../lib/economy.js";
import { loadRules } from "../lib/rules.js";

export default async function galaxyRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app;

  app.get("/api/galaxy", async () => ({
    id: GALAXY.id,
    name: GALAXY.name,
    sectors: GALAXY.sectors.map((s) => ({
      id: s.id,
      name: s.name,
      systems: s.systems.map((sys) => ({
        id: sys.id,
        name: sys.name,
        maps: sys.maps.map((mid) => {
          const m = MAPS_BY_ID.get(mid);
          return m
            ? { id: m.id, name: m.name, pvp: m.pvp, roomType: m.roomType, levelRange: m.levelRange, factionHome: m.factionHome ?? null, portals: m.portals.map((p) => ({ id: p.id, targetMap: p.targetMap, requiredLevel: p.requiredLevel, kind: p.kind })) }
            : { id: mid };
        }),
      })),
    })),
  }));

  app.get<{ Params: { id: string } }>("/api/galaxy/maps/:id", async (req) => {
    const m = MAPS_BY_ID.get(app.parse(defIdSchema, req.params.id));
    if (!m) throw notFound("Map");
    const rooms = await db.gameRoom.findMany({ where: { mapId: m.id, disposedAt: null }, select: { id: true, clients: true, maxClients: true, region: true } });
    return { map: m, rooms };
  });

  app.get("/api/maps", async () => ({ maps: MAPS.map((m) => ({ id: m.id, name: m.name, sector: m.sector, system: m.system, pvp: m.pvp, roomType: m.roomType, levelRange: m.levelRange })) }));

  app.get("/api/gates", async () => ({ gates: GATES }));

  app.get("/api/rules", async () => ({ rules: await loadRules(db), fees: await getFees(db) }));
}
