/**
 * Public world data: galaxy/sectors/maps, seasons, events (active/next windows), gates, rules.
 */
import type { FastifyInstance } from "fastify";
import { EVENTS, GALAXY, GATES, MAPS, MAPS_BY_ID, SEASONS } from "@nebula/config";
import { activeEventWindow, nextEventWindow } from "@nebula/game-core";
import type { EventDef } from "@nebula/shared";
import { defIdSchema } from "@nebula/validation";
import { notFound } from "../errors.js";
import { getFees } from "../lib/economy.js";
import { asRecord } from "../lib/json.js";
import { loadRules } from "../lib/rules.js";

export default async function worldRoutes(app: FastifyInstance): Promise<void> {
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

  app.get("/api/seasons", async () => {
    const rows = await db.season.findMany({ orderBy: { number: "asc" } });
    const now = Date.now();
    return {
      seasons: SEASONS.map((s) => {
        const row = rows.find((r) => r.id === s.id);
        const active = row ? row.active && row.startAt.getTime() <= now && row.endAt.getTime() >= now : Date.parse(s.startAt) <= now && Date.parse(s.endAt) >= now;
        return { ...s, active, startAt: (row?.startAt ?? new Date(s.startAt)).toISOString(), endAt: (row?.endAt ?? new Date(s.endAt)).toISOString() };
      }),
    };
  });

  app.get("/api/events", async () => {
    const now = Date.now();
    // DB rows (admin-managed) override / extend config events.
    const rows = await db.event.findMany();
    const defs = new Map<string, EventDef & { enabled: boolean }>();
    for (const e of EVENTS) defs.set(e.id, { ...e, enabled: true });
    for (const r of rows) {
      const base = defs.get(r.id) ?? (asRecord(r.data) as unknown as EventDef);
      defs.set(r.id, { ...base, ...(asRecord(r.data) as Partial<EventDef>), id: r.id, name: r.name, type: r.type as EventDef["type"], startAt: r.startAt.toISOString(), endAt: r.endAt.toISOString(), enabled: r.active });
    }
    const list = [...defs.values()].filter((d) => d.enabled);
    return {
      events: list
        .map((d) => {
          const active = activeEventWindow(d, now);
          const next = nextEventWindow(d, now);
          return {
            id: d.id, name: d.name, type: d.type, description: d.description, maps: d.maps ?? [], boss: d.boss ?? null,
            xpMultiplier: d.xpMultiplier, dropMultiplier: d.dropMultiplier, rewards: d.rewards ?? [],
            active: Boolean(active),
            window: active ? { start: new Date(active.start).toISOString(), end: new Date(active.end).toISOString() } : null,
            next: next ? { start: new Date(next.start).toISOString(), end: new Date(next.end).toISOString() } : null,
          };
        })
        .filter((e) => e.active || e.next),
    };
  });

  app.get("/api/gates", async () => ({ gates: GATES }));

  app.get("/api/rules", async () => ({ rules: await loadRules(db), fees: await getFees(db) }));
}
