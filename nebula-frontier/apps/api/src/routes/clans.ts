/**
 * Clans: creation (credit sink), invitations, roles (LEADER > OFFICER > VETERAN > MEMBER > RECRUIT),
 * treasury, announcements, diplomacy, ranking, clan wars and clan station modules.
 *
 * Treasury accounting: clan funds are held in the ledger's ESCROW:CREDITS account, and
 * `Clan.bankCredits` is the per-clan sub-ledger updated atomically in the same transaction
 * (conditional decrement => can never go negative). Every movement has a ledger idempotency key.
 */
import type { FastifyInstance } from "fastify";
import { MAPS, MAPS_BY_ID, QUESTS_BY_ID } from "@nebula/config";
import { canKickClanMember, canSetClanRole, clanRoleAtLeast } from "@nebula/authentication";
import { post, system, userWallet, withSerializableTx, type Tx } from "@nebula/database";
import { ClanRole, Currency, LedgerAccountType, LedgerTxType } from "@nebula/shared";
import {
  clanAnnouncementSchema, clanCreateSchema, clanDiplomacySchema, clanInviteSchema, clanMemberSchema, clanModuleKindSchema,
  clanPromoteSchema, clanStationBuildSchema, clanTreasurySchema, clanWarDeclareSchema, idSchema,
} from "@nebula/validation";
import { z } from "zod";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { asRecord } from "../lib/json.js";
import { notify } from "../lib/notify.js";
import { CLAN_MISSIONS, claimMission, missionPeriod, refreshMission, startMission, statMetric } from "../lib/clanMissions.js";
import { loadRules } from "../lib/rules.js";

const searchQuery = z.object({ search: z.string().max(24).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });

export default async function clanRoutes(app: FastifyInstance): Promise<void> {
  const { db, redis } = app;
  const auth = { preHandler: app.authenticate, config: { rateLimit: app.rateLimits.social } };

  async function myMembership(userId: string, clanId?: string) {
    const m = await db.clanMember.findUnique({ where: { userId } });
    if (!m || (clanId && m.clanId !== clanId)) throw forbidden("You are not a member of this clan", "NOT_CLAN_MEMBER");
    return m;
  }
  function requireRank(role: string, min: ClanRole) {
    if (!clanRoleAtLeast(role, min)) throw forbidden(`Requires clan role ${min} or higher`, "CLAN_ROLE");
  }

  app.get("/api/clans", async (req) => {
    const q = app.parse(searchQuery, req.query);
    const rows = await db.clan.findMany({
      where: q.search ? { OR: [{ name: { contains: q.search, mode: "insensitive" } }, { tag: { contains: q.search.toUpperCase() } }] } : {},
      orderBy: { score: "desc" },
      take: q.limit,
      include: { _count: { select: { members: true } } },
    });
    return { clans: rows.map((c) => ({ id: c.id, name: c.name, tag: c.tag, level: c.level, score: c.score.toString(), members: c._count.members, factionId: c.factionId })) };
  });

  app.get("/api/clans/ranking", async () => {
    const rows = await db.clan.findMany({ orderBy: [{ score: "desc" }, { level: "desc" }], take: 100, include: { _count: { select: { members: true, territories: true } } } });
    return {
      ranking: rows.map((c, i) => ({
        rank: i + 1, id: c.id, name: c.name, tag: c.tag, level: c.level, score: c.score.toString(), members: c._count.members, territories: c._count.territories,
      })),
    };
  });

  app.get<{ Params: { id: string } }>("/api/clans/:id", { preHandler: app.optionalAuth }, async (req) => {
    const clanId = app.parse(idSchema, req.params.id);
    const c = await db.clan.findUnique({
      where: { id: clanId },
      include: {
        members: { include: { user: { select: { username: true, level: true } } }, orderBy: { joinedAt: "asc" } },
        stations: { include: { modules: true } },
        territories: true,
      },
    });
    if (!c) throw notFound("Clan");
    const isMember = Boolean(req.user && c.members.some((m) => m.userId === req.user.id));
    return {
      id: c.id, name: c.name, tag: c.tag, description: c.description, level: c.level, score: c.score.toString(), factionId: c.factionId,
      announcement: isMember ? c.announcement : null,
      treasury: isMember ? c.bankCredits.toString() : null,
      diplomacy: c.diplomacy,
      members: c.members.map((m) => ({ userId: m.userId, username: m.user.username, level: m.user.level, role: m.role, contribution: m.contribution.toString(), joinedAt: m.joinedAt.toISOString() })),
      stations: c.stations.map((s) => ({ id: s.id, mapId: s.mapId, level: s.level, hull: s.hull, maxHull: s.maxHull, shield: s.shield, maxShield: s.maxShield, modules: s.modules.map((m) => ({ kind: m.kind, level: m.level })) })),
      territories: c.territories.map((t) => t.mapId),
    };
  });

  app.post("/api/clans", auth, async (req, reply) => {
    const body = app.parse(clanCreateSchema, req.body);
    const userId = req.user.id;
    const rules = await loadRules(db);
    try {
      const clan = await withSerializableTx(db, async (tx) => {
        if (await tx.clanMember.findUnique({ where: { userId } })) throw conflict("ALREADY_IN_CLAN", "Leave your current clan first");
        const pf = await tx.playerFaction.findUnique({ where: { userId } });
        const c = await tx.clan.create({ data: { name: body.name, tag: body.tag, description: body.description, factionId: pf?.factionId ?? null } });
        await post(tx, {
          from: userWallet(userId, Currency.CREDITS), to: system(LedgerAccountType.GAME_SINK, Currency.CREDITS), amount: BigInt(rules.clanCreateCost),
          type: LedgerTxType.GAME_SINK, reference: c.id, idempotencyKey: `clan:${c.id}:create`, userId, metadata: { kind: "CLAN_CREATE" },
        });
        await tx.clanMember.create({ data: { userId, clanId: c.id, role: ClanRole.LEADER } });
        return c;
      });
      return reply.status(201).send({ id: clan.id, name: clan.name, tag: clan.tag });
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") throw conflict("CLAN_EXISTS", "Clan name or tag already taken");
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>("/api/clans/:id/invite", auth, async (req) => {
    const clanId = app.parse(idSchema, req.params.id);
    const { userId } = app.parse(clanInviteSchema, req.body);
    const me = await myMembership(req.user.id, clanId);
    requireRank(me.role, ClanRole.OFFICER);
    const target = await db.user.findUnique({ where: { id: userId }, select: { id: true, clanMember: true } });
    if (!target) throw notFound("User");
    if (target.clanMember) throw conflict("ALREADY_IN_CLAN", "Player is already in a clan");
    const rules = await loadRules(db);
    await redis.set(`clan:invite:${clanId}:${userId}`, req.user.id, "EX", rules.clanInviteTtlHours * 3600);
    const clan = await db.clan.findUniqueOrThrow({ where: { id: clanId }, select: { name: true, tag: true } });
    await notify(db, userId, "CLAN_INVITE", "Clan invitation", `You were invited to join [${clan.tag}] ${clan.name}.`, { clanId });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/clans/:id/join", auth, async (req) => {
    const clanId = app.parse(idSchema, req.params.id);
    const userId = req.user.id;
    const invited = await redis.get(`clan:invite:${clanId}:${userId}`);
    if (!invited) throw forbidden("An invitation is required to join this clan", "NO_INVITE");
    const rules = await loadRules(db);
    await withSerializableTx(db, async (tx) => {
      if (await tx.clanMember.findUnique({ where: { userId } })) throw conflict("ALREADY_IN_CLAN", "Leave your current clan first");
      const count = await tx.clanMember.count({ where: { clanId } });
      if (count >= rules.clanMaxMembers) throw badRequest("CLAN_FULL", "Clan is full");
      await tx.clanMember.create({ data: { userId, clanId, role: ClanRole.RECRUIT } });
    });
    await redis.del(`clan:invite:${clanId}:${userId}`);
    return { ok: true };
  });

  app.post("/api/clans/leave", auth, async (req) => {
    const userId = req.user.id;
    await withSerializableTx(db, async (tx) => {
      const m = await tx.clanMember.findUnique({ where: { userId } });
      if (!m) throw badRequest("NOT_IN_CLAN", "You are not in a clan");
      if (m.role === ClanRole.LEADER) {
        const others = await tx.clanMember.count({ where: { clanId: m.clanId, NOT: { userId } } });
        if (others > 0) throw badRequest("TRANSFER_LEADERSHIP", "Transfer leadership before leaving");
        const clan = await tx.clan.findUniqueOrThrow({ where: { id: m.clanId } });
        if (clan.bankCredits > 0n) {
          // Disbanding returns the remaining treasury to the last leader.
          await tx.clan.update({ where: { id: clan.id }, data: { bankCredits: 0n } });
          await post(tx, {
            from: system(LedgerAccountType.ESCROW, Currency.CREDITS), to: userWallet(userId, Currency.CREDITS), amount: clan.bankCredits,
            type: LedgerTxType.ESCROW, reference: clan.id, idempotencyKey: `clan:${clan.id}:disband`, userId, metadata: { kind: "CLAN_DISBAND", clanId: clan.id },
          });
        }
        await tx.clan.delete({ where: { id: m.clanId } });
        return;
      }
      await tx.clanMember.delete({ where: { userId } });
    });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/clans/:id/kick", auth, async (req) => {
    const clanId = app.parse(idSchema, req.params.id);
    const { userId } = app.parse(clanMemberSchema, req.body);
    // Actor and target are re-read and the delete happens in one serializable transaction, so a
    // concurrent role change / leave cannot be raced (e.g. a demoted officer kicking someone).
    await withSerializableTx(db, async (tx) => {
      const me = await tx.clanMember.findUnique({ where: { userId: req.user.id } });
      if (!me || me.clanId !== clanId) throw forbidden("You are not a member of this clan", "NOT_CLAN_MEMBER");
      const target = await tx.clanMember.findUnique({ where: { userId } });
      if (!target || target.clanId !== clanId) throw notFound("Member");
      if (!canKickClanMember(me.role, target.role)) throw forbidden("You cannot remove this member", "CLAN_ROLE");
      const del = await tx.clanMember.deleteMany({ where: { userId, clanId, role: target.role } });
      if (del.count !== 1) throw conflict("CONCURRENT_UPDATE", "Member changed concurrently");
    });
    await notify(db, userId, "CLAN_KICKED", "Removed from clan", "You were removed from your clan.", { clanId });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/clans/:id/promote", auth, async (req) => {
    const clanId = app.parse(idSchema, req.params.id);
    const body = app.parse(clanPromoteSchema, req.body);
    await withSerializableTx(db, async (tx) => {
      const me = await tx.clanMember.findUnique({ where: { userId: req.user.id } });
      if (!me || me.clanId !== clanId) throw forbidden("You are not a member of this clan", "NOT_CLAN_MEMBER");
      const target = await tx.clanMember.findUnique({ where: { userId: body.userId } });
      if (!target || target.clanId !== clanId) throw notFound("Member");
      if (!canSetClanRole(me.role, target.role, body.role)) throw forbidden("You cannot assign this role", "CLAN_ROLE");
      if (body.role === ClanRole.LEADER) {
        await tx.clanMember.update({ where: { userId: me.userId }, data: { role: ClanRole.OFFICER } });
      }
      await tx.clanMember.update({ where: { userId: target.userId }, data: { role: body.role } });
    });
    return { ok: true };
  });

  async function treasuryMove(tx: Tx, clanId: string, userId: string, amount: bigint, dir: "in" | "out", key: string) {
    if (dir === "in") {
      await post(tx, {
        from: userWallet(userId, Currency.CREDITS), to: system(LedgerAccountType.ESCROW, Currency.CREDITS), amount, type: LedgerTxType.ESCROW,
        reference: clanId, idempotencyKey: key, userId, metadata: { kind: "CLAN_TREASURY_DEPOSIT", clanId },
      });
      await tx.clan.update({ where: { id: clanId }, data: { bankCredits: { increment: amount } } });
      await tx.clanMember.update({ where: { userId }, data: { contribution: { increment: amount } } });
    } else {
      const dec = await tx.clan.updateMany({ where: { id: clanId, bankCredits: { gte: amount } }, data: { bankCredits: { decrement: amount } } });
      if (dec.count !== 1) throw badRequest("INSUFFICIENT_TREASURY", "Not enough credits in the clan treasury");
      await post(tx, {
        from: system(LedgerAccountType.ESCROW, Currency.CREDITS), to: userWallet(userId, Currency.CREDITS), amount, type: LedgerTxType.ESCROW,
        reference: clanId, idempotencyKey: key, userId, metadata: { kind: "CLAN_TREASURY_WITHDRAW", clanId },
      });
    }
  }

  app.post<{ Params: { id: string } }>("/api/clans/:id/treasury/deposit", auth, async (req) => {
    const clanId = app.parse(idSchema, req.params.id);
    const body = app.parse(clanTreasurySchema, req.body);
    await myMembership(req.user.id, clanId);
    const key = `clan:${clanId}:dep:${req.user.id}:${body.idempotencyKey}`;
    if (await db.balanceLedger.findUnique({ where: { idempotencyKey: key }, select: { id: true } })) return { ok: true, duplicate: true };
    await withSerializableTx(db, (tx) => treasuryMove(tx, clanId, req.user.id, body.amount, "in", key));
    return { ok: true, duplicate: false };
  });

  app.post<{ Params: { id: string } }>(
    "/api/clans/:id/treasury/withdraw",
    { preHandler: app.authenticate, config: { rateLimit: app.rateLimits.withdrawal } },
    async (req) => {
      const clanId = app.parse(idSchema, req.params.id);
      const body = app.parse(clanTreasurySchema, req.body);
      const key = `clan:${clanId}:wd:${req.user.id}:${body.idempotencyKey}`;
      if (await db.balanceLedger.findUnique({ where: { idempotencyKey: key }, select: { id: true } })) return { ok: true, duplicate: true };
      await withSerializableTx(db, async (tx) => {
        // Membership and rank are checked inside the transaction that moves the funds, so a member
        // demoted or kicked concurrently cannot still withdraw.
        const me = await tx.clanMember.findUnique({ where: { userId: req.user.id } });
        if (!me || me.clanId !== clanId) throw forbidden("You are not a member of this clan", "NOT_CLAN_MEMBER");
        requireRank(me.role, ClanRole.OFFICER);
        await treasuryMove(tx, clanId, req.user.id, body.amount, "out", key);
      });
      await app.audit(req, { action: "CLAN_TREASURY_WITHDRAW", targetType: "Clan", targetId: clanId, newValue: { amount: body.amount.toString() } });
      return { ok: true, duplicate: false };
    },
  );

  app.patch<{ Params: { id: string } }>("/api/clans/:id/announcement", auth, async (req) => {
    const clanId = app.parse(idSchema, req.params.id);
    const body = app.parse(clanAnnouncementSchema, req.body);
    const me = await myMembership(req.user.id, clanId);
    requireRank(me.role, ClanRole.OFFICER);
    await db.clan.update({ where: { id: clanId }, data: { announcement: body.announcement } });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/clans/:id/diplomacy", auth, async (req) => {
    const clanId = app.parse(idSchema, req.params.id);
    const body = app.parse(clanDiplomacySchema, req.body);
    const me = await myMembership(req.user.id, clanId);
    requireRank(me.role, ClanRole.OFFICER);
    if (body.targetClanId === clanId) throw badRequest("SELF_DIPLOMACY", "Cannot set diplomacy with your own clan");
    if (!(await db.clan.findUnique({ where: { id: body.targetClanId }, select: { id: true } }))) throw notFound("Clan");
    await withSerializableTx(db, async (tx) => {
      const c = await tx.clan.findUniqueOrThrow({ where: { id: clanId }, select: { diplomacy: true } });
      const d = asRecord(c.diplomacy);
      if (body.stance === "NEUTRAL") delete d[body.targetClanId];
      else d[body.targetClanId] = { stance: body.stance, since: new Date().toISOString() };
      await tx.clan.update({ where: { id: clanId }, data: { diplomacy: d as object } });
    });
    return { ok: true };
  });

  // ---- Clan wars ----
  const defaultWarMap = MAPS.find((m) => m.roomType === "clanwar")?.id ?? MAPS.find((m) => m.roomType === "pvp")?.id ?? MAPS[0]?.id ?? "";

  app.get<{ Params: { id: string } }>("/api/clans/:id/wars", async (req) => {
    const clanId = app.parse(idSchema, req.params.id);
    const wars = await db.clanWar.findMany({ where: { OR: [{ clanAId: clanId }, { clanBId: clanId }] }, orderBy: { createdAt: "desc" }, take: 50 });
    return { wars };
  });

  app.post<{ Params: { id: string } }>("/api/clans/:id/wars", auth, async (req, reply) => {
    const clanId = app.parse(idSchema, req.params.id);
    const body = app.parse(clanWarDeclareSchema, req.body);
    const me = await myMembership(req.user.id, clanId);
    requireRank(me.role, ClanRole.OFFICER);
    if (body.targetClanId === clanId) throw badRequest("SELF_WAR", "Cannot declare war on your own clan");
    const mapId = body.mapId ?? defaultWarMap;
    const map = MAPS_BY_ID.get(mapId);
    if (!map || !map.pvp) throw badRequest("INVALID_MAP", "Clan wars require a PvP map");
    const target = await db.clan.findUnique({ where: { id: body.targetClanId }, select: { id: true } });
    if (!target) throw notFound("Clan");
    const open = await db.clanWar.findFirst({
      where: {
        phase: { notIn: ["REWARDED"] },
        OR: [{ clanAId: clanId, clanBId: body.targetClanId }, { clanAId: body.targetClanId, clanBId: clanId }],
      },
    });
    if (open) throw conflict("WAR_EXISTS", "A war between these clans is already ongoing");
    const rules = await loadRules(db);
    const startsAt = new Date(Date.now() + rules.clanWarPreparationMinutes * 60_000);
    const war = await db.clanWar.create({
      data: { clanAId: clanId, clanBId: body.targetClanId, phase: "DECLARED", mapId, startsAt, endsAt: new Date(startsAt.getTime() + rules.clanWarDurationMinutes * 60_000) },
    });
    const leaders = await db.clanMember.findMany({ where: { clanId: body.targetClanId, role: { in: [ClanRole.LEADER, ClanRole.OFFICER] } }, select: { userId: true } });
    for (const l of leaders) await notify(db, l.userId, "CLAN_WAR_DECLARED", "War declared", "A clan has declared war on you.", { warId: war.id, clanId });
    return reply.status(201).send({ war });
  });

  app.post<{ Params: { warId: string } }>("/api/clans/wars/:warId/accept", auth, async (req) => {
    const warId = app.parse(idSchema, req.params.warId);
    const war = await db.clanWar.findUnique({ where: { id: warId } });
    if (!war) throw notFound("War");
    const me = await myMembership(req.user.id, war.clanBId);
    requireRank(me.role, ClanRole.OFFICER);
    const rules = await loadRules(db);
    const startsAt = new Date(Date.now() + rules.clanWarPreparationMinutes * 60_000);
    const upd = await db.clanWar.updateMany({
      where: { id: warId, phase: "DECLARED" },
      data: { phase: "PREPARATION", startsAt, endsAt: new Date(startsAt.getTime() + rules.clanWarDurationMinutes * 60_000) },
    });
    if (upd.count !== 1) throw conflict("WAR_NOT_PENDING", "War is not awaiting acceptance");
    return { ok: true, startsAt: startsAt.toISOString() };
  });

  // ---- Clan station ----
  app.post<{ Params: { id: string } }>("/api/clans/:id/station", auth, async (req, reply) => {
    const clanId = app.parse(idSchema, req.params.id);
    const { mapId } = app.parse(clanStationBuildSchema, req.body);
    const me = await myMembership(req.user.id, clanId);
    requireRank(me.role, ClanRole.LEADER);
    const map = MAPS_BY_ID.get(mapId);
    if (!map || map.factionHome) throw badRequest("INVALID_MAP", "Stations cannot be built on this map");
    const rules = await loadRules(db);
    const station = await withSerializableTx(db, async (tx) => {
      if (await tx.clanStation.findFirst({ where: { clanId } })) throw conflict("STATION_EXISTS", "Your clan already has a station");
      const cost = BigInt(rules.clanStationBuildCost);
      const dec = await tx.clan.updateMany({ where: { id: clanId, bankCredits: { gte: cost } }, data: { bankCredits: { decrement: cost } } });
      if (dec.count !== 1) throw badRequest("INSUFFICIENT_TREASURY", "Not enough credits in the clan treasury");
      const s = await tx.clanStation.create({
        data: { clanId, mapId, x: map.width / 2, y: map.height / 2, hull: rules.clanStationHull, maxHull: rules.clanStationHull, shield: rules.clanStationShield, maxShield: rules.clanStationShield },
      });
      await post(tx, {
        from: system(LedgerAccountType.ESCROW, Currency.CREDITS), to: system(LedgerAccountType.GAME_SINK, Currency.CREDITS), amount: cost,
        type: LedgerTxType.GAME_SINK, reference: s.id, idempotencyKey: `clanstation:${s.id}:build`, userId: req.user.id, metadata: { clanId, kind: "CLAN_STATION_BUILD" },
      });
      return s;
    });
    return reply.status(201).send({ station });
  });

  app.post<{ Params: { id: string; kind: string } }>("/api/clans/:id/station/modules/:kind/upgrade", auth, async (req) => {
    const clanId = app.parse(idSchema, req.params.id);
    const kind = app.parse(clanModuleKindSchema, req.params.kind);
    const me = await myMembership(req.user.id, clanId);
    requireRank(me.role, ClanRole.OFFICER);
    const rules = await loadRules(db);
    const out = await withSerializableTx(db, async (tx) => {
      const station = await tx.clanStation.findFirst({ where: { clanId }, include: { modules: true } });
      if (!station) throw badRequest("NO_STATION", "Build a clan station first");
      const mod = station.modules.find((m) => m.kind === kind);
      const nextLevel = (mod?.level ?? 0) + 1;
      if (nextLevel > rules.clanModuleMaxLevel) throw badRequest("MAX_LEVEL", "Module is at max level");
      const cost = BigInt(Math.round(rules.clanModuleBaseCost * Math.pow(rules.clanModuleGrowth, nextLevel - 1)));
      const dec = await tx.clan.updateMany({ where: { id: clanId, bankCredits: { gte: cost } }, data: { bankCredits: { decrement: cost } } });
      if (dec.count !== 1) throw badRequest("INSUFFICIENT_TREASURY", "Not enough credits in the clan treasury");
      if (mod) {
        const upd = await tx.clanStationModule.updateMany({ where: { id: mod.id, level: mod.level }, data: { level: nextLevel } });
        if (upd.count !== 1) throw conflict("CONCURRENT_UPDATE", "Module changed concurrently");
      } else {
        await tx.clanStationModule.create({ data: { stationId: station.id, kind, level: 1 } });
      }
      await post(tx, {
        from: system(LedgerAccountType.ESCROW, Currency.CREDITS), to: system(LedgerAccountType.GAME_SINK, Currency.CREDITS), amount: cost,
        type: LedgerTxType.GAME_SINK, reference: station.id, idempotencyKey: `clanstation:${station.id}:${kind}:${nextLevel}`, userId: req.user.id,
        metadata: { clanId, kind: "CLAN_MODULE_UPGRADE", module: kind, level: nextLevel },
      });
      return { kind, level: nextLevel, cost: cost.toString() };
    });
    return out;
  });

  // ---- Clan missions (quests.json type CLAN) ----
  app.get<{ Params: { id: string } }>("/api/clans/:id/missions", auth, async (req) => {
    const clanId = app.parse(idSchema, req.params.id);
    await myMembership(req.user.id, clanId);
    // Read-only: progress is advanced by the refreshClanMissions job, game-server contributions and claim.
    const rows = await db.clanMission.findMany({ where: { clanId }, orderBy: { startedAt: "desc" } });
    return {
      missions: CLAN_MISSIONS.map((q) => {
        const row = rows.find((r) => r.questId === q.id && r.periodKey === missionPeriod(q)) ?? null;
        return {
          questId: q.id, name: q.name, description: q.description, requiredLevel: q.requiredLevel, rewards: q.rewards, repeatable: q.repeatable,
          objectives: q.objectives.map((o, i) => ({
            type: o.type, target: o.target ?? null, count: o.count, progress: row?.progress[i] ?? 0,
            tracking: statMetric(o) ? "MEMBER_STATS" : "GAME_EVENTS",
          })),
          mission: row ? { id: row.id, status: row.status, startedAt: row.startedAt.toISOString(), completedAt: row.completedAt?.toISOString() ?? null, claimedAt: row.claimedAt?.toISOString() ?? null } : null,
        };
      }),
    };
  });

  app.post<{ Params: { id: string; questId: string } }>("/api/clans/:id/missions/:questId/start", auth, async (req, reply) => {
    const clanId = app.parse(idSchema, req.params.id);
    const questId = app.parse(idSchema, req.params.questId);
    const me = await myMembership(req.user.id, clanId);
    requireRank(me.role, ClanRole.OFFICER);
    if (!QUESTS_BY_ID.has(questId)) throw notFound("Clan mission");
    const m = await startMission(db, clanId, questId, req.user.id);
    return reply.status(201).send({ id: m.id, questId: m.questId, status: m.status, progress: m.progress });
  });

  app.post<{ Params: { id: string; missionId: string } }>("/api/clans/:id/missions/:missionId/claim", auth, async (req) => {
    const clanId = app.parse(idSchema, req.params.id);
    const missionId = app.parse(idSchema, req.params.missionId);
    const me = await myMembership(req.user.id, clanId);
    requireRank(me.role, ClanRole.OFFICER);
    await refreshMission(db, missionId);
    const out = await claimMission(db, clanId, missionId, req.user.id);
    app.analytics.track("REWARD_CLAIM", req.user.id, { source: "CLAN_MISSION", clanId, missionId, credits: out.credits });
    await app.audit(req, { action: "CLAN_MISSION_CLAIM", targetType: "Clan", targetId: clanId, newValue: out });
    return out;
  });

  // ---- Territory ----
  app.get<{ Params: { id: string } }>("/api/clans/:id/territory", async (req) => {
    const clanId = app.parse(idSchema, req.params.id);
    if (!(await db.clan.findUnique({ where: { id: clanId }, select: { id: true } }))) throw notFound("Clan");
    const rows = await db.clanTerritory.findMany({ where: { clanId }, orderBy: { capturedAt: "desc" } });
    return {
      territories: rows.map((t) => {
        const m = MAPS_BY_ID.get(t.mapId);
        return { mapId: t.mapId, name: m?.name ?? t.mapId, sector: m?.sector ?? null, pvp: m?.pvp ?? null, capturedAt: t.capturedAt.toISOString() };
      }),
    };
  });
}
