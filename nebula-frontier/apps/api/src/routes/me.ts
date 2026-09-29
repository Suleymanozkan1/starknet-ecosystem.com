/**
 * Current user, public profiles, username change, faction choice (grants the starter ship/loadout).
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { ACHIEVEMENTS_BY_ID, FACTIONS, FACTIONS_BY_ID, PETS_BY_ID, WEAPONS_BY_ID, MODULES_BY_ID, itemIdForDef } from "@nebula/config";
import type { Tx } from "@nebula/database";
import { Reputation, type ProfileResponse } from "@nebula/shared";
import { starterAmmoFor, starterAmmoOriginRef, starterPetFor } from "@nebula/game-core";
import { chooseFactionSchema, idSchema, updateMeSchema } from "@nebula/validation";
import { badRequest, conflict, notFound } from "../errors.js";
import { getCatalog } from "../lib/catalog.js";
import { emptyLoadout, type LoadoutConfig } from "../lib/inventory.js";
import { buildMe } from "../lib/me.js";
import { loadRules } from "../lib/rules.js";
import { computeShipStats } from "../lib/ships.js";

/** Compare-and-delete: release a Redis reservation only if it still holds our token. */
const DEL_IF_OWNER = `if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end`;

export default async function meRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app;

  app.get("/api/me", { preHandler: app.authenticate }, async (req) => buildMe(db, req.user.id));

  app.patch("/api/me", { preHandler: app.authenticate }, async (req) => {
    const body = app.parse(updateMeSchema, req.body);
    const rules = await loadRules(db);
    const cooldownKey = `username:cooldown:${req.user.id}`;
    // Atomic reservation: SET NX EX both checks and starts the cooldown, so two concurrent changes
    // cannot both pass a TTL check. The reservation is released (only if still ours) when the change fails.
    const token = randomUUID();
    const reserved = await app.redis.set(cooldownKey, token, "EX", rules.usernameChangeCooldownHours * 3600, "NX");
    if (reserved !== "OK") {
      const ttl = await app.redis.ttl(cooldownKey);
      const hours = Math.max(1, Math.ceil(Math.max(ttl, 0) / 3600));
      throw badRequest("USERNAME_COOLDOWN", `Username can be changed again in ${hours}h`, { retryAfterSeconds: Math.max(ttl, 0) });
    }
    let before: { username: string };
    try {
      const taken = await db.user.findFirst({
        where: { username: { equals: body.username, mode: "insensitive" }, NOT: { id: req.user.id } },
        select: { id: true },
      });
      if (taken) throw conflict("USERNAME_TAKEN", "Username already taken");
      before = await db.user.findUniqueOrThrow({ where: { id: req.user.id }, select: { username: true } });
      try {
        await db.user.update({ where: { id: req.user.id }, data: { username: body.username } });
      } catch (err) {
        if ((err as { code?: string }).code === "P2002") throw conflict("USERNAME_TAKEN", "Username already taken");
        throw err;
      }
    } catch (err) {
      await app.redis.eval(DEL_IF_OWNER, 1, cooldownKey, token).catch(() => undefined);
      throw err;
    }
    await app.audit(req, { action: "USERNAME_CHANGE", targetType: "User", targetId: req.user.id, oldValue: before.username, newValue: body.username });
    return buildMe(db, req.user.id);
  });

  app.get("/api/factions", async () => {
    const counts = await db.playerFaction.groupBy({ by: ["factionId"], _count: { _all: true } });
    const rows = await db.faction.findMany({ select: { id: true, score: true, territory: true } });
    return {
      factions: FACTIONS.map((f) => ({
        id: f.id,
        name: f.name,
        tag: f.tag,
        motto: f.motto,
        lore: f.lore,
        color: f.color,
        secondaryColor: f.secondaryColor,
        emblem: f.emblem,
        homeMap: f.homeMap,
        homeSector: f.homeSector,
        starterShip: f.starterShip,
        bonus: f.bonus,
        members: counts.find((c) => c.factionId === f.id)?._count._all ?? 0,
        score: (rows.find((r) => r.id === f.id)?.score ?? 0n).toString(),
        territory: rows.find((r) => r.id === f.id)?.territory ?? 0,
      })),
    };
  });

  /** Choose a faction (once). Grants starter ship, starter loadout items and a PVE loadout. */
  app.post("/api/me/faction", { preHandler: app.authenticate }, async (req) => {
    const { factionId } = app.parse(chooseFactionSchema, req.body);
    const faction = FACTIONS_BY_ID.get(factionId);
    if (!faction) throw badRequest("UNKNOWN_FACTION", "Unknown faction");
    const catalog = await getCatalog(db);
    const ship = catalog.ships.get(faction.starterShip);
    if (!ship) throw badRequest("UNKNOWN_SHIP", "Starter ship missing from catalog");
    const userId = req.user.id;
    try {
      await db.$transaction(async (tx: Tx) => {
        await tx.playerFaction.create({ data: { userId, factionId } });
        const inst = await tx.shipInstance.create({ data: { userId, shipId: ship.id } });
        const loadout: LoadoutConfig = emptyLoadout(ship.slots);
        const starter = [...faction.starterLoadout.weapons, ...faction.starterLoadout.modules, ...faction.starterLoadout.drones];
        let n = 0;
        for (const defId of starter) {
          const itemId = itemIdForDef(defId);
          const def = catalog.items.get(itemId);
          if (!def) throw badRequest("UNKNOWN_ITEM", `Starter item ${itemId} missing`);
          const inv = await tx.inventoryItem.create({
            data: { userId, itemId, quantity: 1, originRef: `starter:${userId}:${n++}:${defId}`, boundAt: def.soulbound ? new Date() : null },
          });
          const place = (arr: (string | null)[]) => {
            const idx = arr.indexOf(null);
            if (idx >= 0) arr[idx] = inv.id;
          };
          const w = WEAPONS_BY_ID.get(defId);
          const m = MODULES_BY_ID.get(defId);
          if (w) place(w.slot === "MISSILE" ? loadout.missiles : loadout.weapons);
          else if (m) place(m.slot === "GENERATOR" ? loadout.generators : loadout.modules);
          else place(loadout.drones);
        }
        // Starter ammo from factions.json via the shared game-core source of truth. The originRef is the
        // same one the game server's fallback starter kit uses, so whichever runs first wins and the
        // other is a no-op (skipDuplicates on the unique originRef).
        const ammo = starterAmmoFor(faction).filter((a) => catalog.items.has(a.itemId));
        if (ammo.length) {
          await tx.inventoryItem.createMany({
            data: ammo.map((a) => ({ userId, itemId: a.itemId, quantity: a.quantity, originRef: starterAmmoOriginRef(userId, a.itemId) })),
            skipDuplicates: true,
          });
          loadout.ammo = ammo[0]?.itemId ?? null;
        }
        // Starter companion (factions.json starterLoadout.pet) — same data + unique (userId, petId) as the game server.
        const starterPet = starterPetFor(faction);
        const petDef = starterPet ? PETS_BY_ID.get(starterPet) : undefined;
        if (starterPet && petDef) await tx.pet.createMany({ data: [{ userId, petId: starterPet, name: petDef.name, active: true }], skipDuplicates: true });
        const lo = await tx.shipLoadout.create({ data: { shipInstanceId: inst.id, name: "PVE", preset: "PVE", config: loadout as object } });
        await tx.shipInstance.update({ where: { id: inst.id }, data: { activeLoadoutId: lo.id } });
        const stats = await computeShipStats(tx, inst.id, catalog);
        await tx.shipStats.create({ data: { shipInstanceId: inst.id, stats: stats.stats, gearScore: stats.gearScore } });
        await tx.user.update({ where: { id: userId }, data: { activeShipId: inst.id, lastMapId: faction.homeMap, gearScore: stats.gearScore } });
      });
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") throw conflict("FACTION_ALREADY_CHOSEN", "Faction already chosen");
      throw err;
    }
    return buildMe(db, userId);
  });

  app.get<{ Params: { id?: string } }>("/api/profile/:id?", { preHandler: app.optionalAuth }, async (req): Promise<ProfileResponse> => {
    const id = req.params.id ? app.parse(idSchema, req.params.id) : req.user?.id;
    if (!id) throw notFound("Profile");
    const u = await db.user.findUnique({
      where: { id },
      include: {
        playerFaction: { select: { factionId: true } },
        clanMember: { select: { clan: { select: { name: true, tag: true } } } },
        stats: true,
        achievements: { orderBy: { unlockedAt: "desc" }, take: 20 },
      },
    });
    if (!u) throw notFound("Profile");
    const shipRow = u.activeShipId ? await db.shipInstance.findUnique({ where: { id: u.activeShipId }, select: { shipId: true } }) : null;
    const catalog = await getCatalog(db);
    return {
      id: u.id,
      username: u.username,
      level: u.level,
      rank: u.rank,
      prestige: u.prestige,
      title: u.title,
      faction: u.playerFaction?.factionId ?? null,
      clan: u.clanMember ? { name: u.clanMember.clan.name, tag: u.clanMember.clan.tag } : null,
      ship: shipRow ? { defId: shipRow.shipId, name: catalog.ships.get(shipRow.shipId)?.name ?? shipRow.shipId } : null,
      gearScore: u.gearScore,
      reputation: (Object.values(Reputation) as string[]).includes(u.reputation) ? (u.reputation as Reputation) : Reputation.NEUTRAL,
      karma: u.karma,
      pvp: { kills: u.stats?.playerKills ?? 0, deaths: u.stats?.deaths ?? 0, wins: u.stats?.pvpWins ?? 0, rating: u.pvpRating },
      pve: { npcKills: u.stats?.npcKills ?? 0, bossKills: u.stats?.bossKills ?? 0, gatesCompleted: u.stats?.gatesCompleted ?? 0 },
      achievements: u.achievements.map((a) => ({
        id: a.achievementId,
        name: ACHIEVEMENTS_BY_ID.get(a.achievementId)?.name ?? a.achievementId,
        unlockedAt: a.unlockedAt.toISOString(),
      })),
    };
  });
}
