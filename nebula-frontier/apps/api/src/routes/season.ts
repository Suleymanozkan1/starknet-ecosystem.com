/**
 * Seasons, live events (active/next windows from config + admin-managed Event rows) and the
 * season battle pass (free/premium tracks; tier claims are single-use via an atomic
 * array_append guarded by NOT ANY()).
 */
import type { FastifyInstance } from "fastify";
import { BATTLE_PASSES, EVENTS, SEASONS, SHOP_BY_SKU } from "@nebula/config";
import { activeEventWindow, nextEventWindow } from "@nebula/game-core";
import type { EventDef } from "@nebula/shared";
import { battlePassClaimSchema } from "@nebula/validation";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { activeSeasonId, grantBundle } from "../lib/grants.js";
import { asRecord } from "../lib/json.js";

export default async function seasonRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app;
  const auth = { preHandler: app.authenticate };

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

  // ------------------------------------------------------------------ battle pass
  app.get("/api/battlepass", auth, async (req) => {
    const seasonId = await activeSeasonId(db);
    const pass = seasonId ? BATTLE_PASSES.find((p) => p.seasonId === seasonId) : undefined;
    if (!seasonId || !pass) return { active: false, pass: null };
    const row = await db.battlePass.findUnique({ where: { userId_seasonId: { userId: req.user.id, seasonId } } });
    const product = SHOP_BY_SKU.get(pass.premiumProductSku);
    return {
      active: true,
      seasonId,
      pass: { id: pass.id, name: pass.name, tiers: pass.tiers },
      premiumProductId: product?.id ?? null,
      state: {
        xp: row?.xp ?? 0,
        tier: row?.tier ?? 0,
        premium: row?.premium ?? false,
        claimedFree: row?.claimedFree ?? [],
        claimedPremium: row?.claimedPremium ?? [],
      },
    };
  });

  app.post("/api/battlepass/claim", auth, async (req) => {
    const body = app.parse(battlePassClaimSchema, req.body);
    const userId = req.user.id;
    const seasonId = await activeSeasonId(db);
    const pass = seasonId ? BATTLE_PASSES.find((p) => p.seasonId === seasonId) : undefined;
    if (!seasonId || !pass) throw badRequest("NO_ACTIVE_PASS", "No active battle pass");
    const tierDef = pass.tiers.find((t) => t.tier === body.tier);
    if (!tierDef) throw notFound("Tier");
    const bundle = body.track === "free" ? tierDef.free : tierDef.premium;
    if (!bundle) throw badRequest("NO_REWARD", "This tier has no reward on that track");
    const res = await db.$transaction(async (tx) => {
      const bp = await tx.battlePass.findUnique({ where: { userId_seasonId: { userId, seasonId } } });
      if (!bp || bp.tier < body.tier) throw forbidden("Tier not reached yet", "TIER_LOCKED");
      if (body.track === "premium" && !bp.premium) throw forbidden("Premium pass required", "PREMIUM_REQUIRED");
      const n = body.track === "free"
        ? await tx.$executeRaw`UPDATE "BattlePass" SET "claimedFree" = array_append("claimedFree", ${body.tier}), "updatedAt" = now() WHERE id = ${bp.id} AND NOT (${body.tier} = ANY("claimedFree"))`
        : await tx.$executeRaw`UPDATE "BattlePass" SET "claimedPremium" = array_append("claimedPremium", ${body.tier}), "updatedAt" = now() WHERE id = ${bp.id} AND NOT (${body.tier} = ANY("claimedPremium"))`;
      if (n !== 1) throw conflict("ALREADY_CLAIMED", "Tier reward already claimed");
      return grantBundle(tx, userId, bundle, `bp:${seasonId}:${body.track}:${body.tier}:${userId}`, `battlepass:${pass.id}:${body.tier}`);
    });
    return { ok: true, items: res.items };
  });
}
