/**
 * Social: squads, friends, mail (reward attachments), (+ online presence from the game server's Redis keys `presence:<userId>`),
 * chat history + reports, notifications + push tokens, bounties (credits held in escrow).
 */
import type { FastifyInstance } from "fastify";
import { post, system, userWallet, withSerializableTx } from "@nebula/database";
import { ChatChannel, Currency, LedgerAccountType, LedgerTxType, type RewardBundle } from "@nebula/shared";
import {
  bountyCreateSchema, chatHistoryQuerySchema, chatReportSchema, friendAddSchema, friendTargetSchema, idSchema, notificationReadSchema,
  pushTokenSchema, squadInviteSchema,
} from "@nebula/validation";
import { z } from "zod";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { grantBundle } from "../lib/grants.js";
import { notify } from "../lib/notify.js";
import { loadRules } from "../lib/rules.js";
import { platformOf } from "../lib/sessions.js";

const REPORTS_TO_FLAG = 3;

export default async function socialRoutes(app: FastifyInstance): Promise<void> {
  const { db, redis } = app;
  const auth = { preHandler: app.authenticate, config: { rateLimit: app.rateLimits.social } };

  async function online(ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const vals = await redis.mget(...ids.map((id) => `presence:${id}`));
    return new Set(ids.filter((_, i) => vals[i] !== null));
  }

  // ------------------------------------------------------------------ squads
  app.get("/api/squad", auth, async (req) => {
    const m = await db.squadMember.findUnique({ where: { userId: req.user.id } });
    if (!m) return { squad: null };
    const squad = await db.squad.findUniqueOrThrow({ where: { id: m.squadId }, include: { members: { include: { user: { select: { username: true, level: true } } } } } });
    const on = await online(squad.members.map((x) => x.userId));
    const rules = await loadRules(db);
    return {
      squad: {
        id: squad.id, leaderId: squad.leaderId, minSize: rules.squadMinSize, maxSize: rules.squadMaxSize,
        members: squad.members.map((x) => ({ userId: x.userId, username: x.user.username, level: x.user.level, online: on.has(x.userId) })),
      },
    };
  });

  app.post("/api/squad", auth, async (req, reply) => {
    const userId = req.user.id;
    const squad = await withSerializableTx(db, async (tx) => {
      if (await tx.squadMember.findUnique({ where: { userId } })) throw conflict("ALREADY_IN_SQUAD", "Leave your current squad first");
      const s = await tx.squad.create({ data: { leaderId: userId } });
      await tx.squadMember.create({ data: { userId, squadId: s.id } });
      return s;
    });
    return reply.status(201).send({ id: squad.id });
  });

  app.post("/api/squad/invite", auth, async (req) => {
    const { userId } = app.parse(squadInviteSchema, req.body);
    const m = await db.squadMember.findUnique({ where: { userId: req.user.id }, include: { squad: true } });
    if (!m || m.squad.leaderId !== req.user.id) throw forbidden("Only the squad leader can invite", "NOT_SQUAD_LEADER");
    if (userId === req.user.id) throw badRequest("SELF_INVITE", "Cannot invite yourself");
    if (!(await db.user.findUnique({ where: { id: userId }, select: { id: true } }))) throw notFound("User");
    const rules = await loadRules(db);
    await redis.set(`squad:invite:${m.squadId}:${userId}`, req.user.id, "EX", rules.squadInviteTtlMinutes * 60);
    await notify(db, userId, "SQUAD_INVITE", "Squad invitation", `${req.user.username} invited you to a squad.`, { squadId: m.squadId });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/squad/:id/join", auth, async (req) => {
    const squadId = app.parse(idSchema, req.params.id);
    const userId = req.user.id;
    if (!(await redis.get(`squad:invite:${squadId}:${userId}`))) throw forbidden("An invitation is required", "NO_INVITE");
    const rules = await loadRules(db);
    await withSerializableTx(db, async (tx) => {
      if (await tx.squadMember.findUnique({ where: { userId } })) throw conflict("ALREADY_IN_SQUAD", "Leave your current squad first");
      if (!(await tx.squad.findUnique({ where: { id: squadId }, select: { id: true } }))) throw notFound("Squad");
      if ((await tx.squadMember.count({ where: { squadId } })) >= rules.squadMaxSize) throw badRequest("SQUAD_FULL", "Squad is full");
      await tx.squadMember.create({ data: { userId, squadId } });
    });
    await redis.del(`squad:invite:${squadId}:${userId}`);
    return { ok: true };
  });

  app.post("/api/squad/leave", auth, async (req) => {
    const userId = req.user.id;
    await withSerializableTx(db, async (tx) => {
      const m = await tx.squadMember.findUnique({ where: { userId }, include: { squad: true } });
      if (!m) throw badRequest("NOT_IN_SQUAD", "You are not in a squad");
      await tx.squadMember.delete({ where: { userId } });
      const next = await tx.squadMember.findFirst({ where: { squadId: m.squadId }, orderBy: { joinedAt: "asc" } });
      if (!next) await tx.squad.delete({ where: { id: m.squadId } });
      else if (m.squad.leaderId === userId) await tx.squad.update({ where: { id: m.squadId }, data: { leaderId: next.userId } });
    });
    return { ok: true };
  });

  app.post("/api/squad/kick", auth, async (req) => {
    const { userId } = app.parse(squadInviteSchema, req.body);
    const m = await db.squadMember.findUnique({ where: { userId: req.user.id }, include: { squad: true } });
    if (!m || m.squad.leaderId !== req.user.id) throw forbidden("Only the squad leader can remove members", "NOT_SQUAD_LEADER");
    if (userId === req.user.id) throw badRequest("SELF_KICK", "Use leave instead");
    const r = await db.squadMember.deleteMany({ where: { userId, squadId: m.squadId } });
    if (r.count !== 1) throw notFound("Member");
    return { ok: true };
  });

  // ------------------------------------------------------------------ friends
  app.get("/api/friends", auth, async (req) => {
    const me = req.user.id;
    const rows = await db.friend.findMany({
      where: { OR: [{ userId: me }, { friendId: me }] },
      include: { user: { select: { id: true, username: true, level: true } }, friend: { select: { id: true, username: true, level: true } } },
    });
    const accepted = rows.filter((r) => r.status === "ACCEPTED" && r.userId === me).map((r) => r.friend);
    const on = await online(accepted.map((f) => f.id));
    return {
      friends: accepted.map((f) => ({ ...f, online: on.has(f.id) })),
      incoming: rows.filter((r) => r.status === "PENDING" && r.friendId === me).map((r) => r.user),
      outgoing: rows.filter((r) => r.status === "PENDING" && r.userId === me).map((r) => r.friend),
      blocked: rows.filter((r) => r.status === "BLOCKED" && r.userId === me).map((r) => r.friend),
    };
  });

  app.post("/api/friends/add", auth, async (req) => {
    const body = app.parse(friendAddSchema, req.body);
    const me = req.user.id;
    const target = await db.user.findFirst({ where: body.userId ? { id: body.userId } : { username: body.username }, select: { id: true } });
    if (!target) throw notFound("User");
    if (target.id === me) throw badRequest("SELF_FRIEND", "You cannot add yourself");
    const rules = await loadRules(db);
    const status = await withSerializableTx(db, async (tx) => {
      const [mine, theirs] = await Promise.all([
        tx.friend.findUnique({ where: { userId_friendId: { userId: me, friendId: target.id } } }),
        tx.friend.findUnique({ where: { userId_friendId: { userId: target.id, friendId: me } } }),
      ]);
      // Silently accepted but never delivered when the target blocked us (no block oracle).
      if (theirs?.status === "BLOCKED") return "PENDING";
      if (mine?.status === "ACCEPTED") return "ACCEPTED";
      if ((await tx.friend.count({ where: { userId: me, status: "ACCEPTED" } })) >= rules.friendsMax) throw badRequest("FRIENDS_FULL", "Friend list is full");
      if (theirs?.status === "PENDING" || theirs?.status === "ACCEPTED") {
        await tx.friend.upsert({ where: { userId_friendId: { userId: me, friendId: target.id } }, create: { userId: me, friendId: target.id, status: "ACCEPTED" }, update: { status: "ACCEPTED" } });
        await tx.friend.update({ where: { id: theirs.id }, data: { status: "ACCEPTED" } });
        return "ACCEPTED";
      }
      await tx.friend.upsert({ where: { userId_friendId: { userId: me, friendId: target.id } }, create: { userId: me, friendId: target.id }, update: { status: "PENDING" } });
      await notify(tx, target.id, "FRIEND_REQUEST", "Friend request", `${req.user.username} wants to be your friend.`, { fromUserId: me });
      return "PENDING";
    });
    return { status };
  });

  app.post("/api/friends/remove", auth, async (req) => {
    const { userId } = app.parse(friendTargetSchema, req.body);
    await db.friend.deleteMany({
      where: { OR: [{ userId: req.user.id, friendId: userId, status: { not: "BLOCKED" } }, { userId, friendId: req.user.id, status: { not: "BLOCKED" } }] },
    });
    return { ok: true };
  });

  app.post("/api/friends/block", auth, async (req) => {
    const { userId } = app.parse(friendTargetSchema, req.body);
    if (userId === req.user.id) throw badRequest("SELF_BLOCK", "You cannot block yourself");
    if (!(await db.user.findUnique({ where: { id: userId }, select: { id: true } }))) throw notFound("User");
    await db.$transaction([
      db.friend.upsert({ where: { userId_friendId: { userId: req.user.id, friendId: userId } }, create: { userId: req.user.id, friendId: userId, status: "BLOCKED" }, update: { status: "BLOCKED" } }),
      db.friend.deleteMany({ where: { userId, friendId: req.user.id, status: { not: "BLOCKED" } } }),
    ]);
    return { ok: true };
  });

  app.post("/api/friends/unblock", auth, async (req) => {
    const { userId } = app.parse(friendTargetSchema, req.body);
    await db.friend.deleteMany({ where: { userId: req.user.id, friendId: userId, status: "BLOCKED" } });
    return { ok: true };
  });

  // ------------------------------------------------------------------ chat
  app.get("/api/chat/history", { preHandler: app.authenticate, config: { rateLimit: app.rateLimits.chat } }, async (req) => {
    const q = app.parse(chatHistoryQuerySchema, req.query);
    const me = req.user.id;
    let key = "";
    switch (q.channel) {
      case ChatChannel.GLOBAL:
      case ChatChannel.SYSTEM:
        key = "";
        break;
      case ChatChannel.FACTION: {
        const pf = await db.playerFaction.findUnique({ where: { userId: me } });
        if (!pf) throw forbidden("Join a faction first", "NO_FACTION");
        key = pf.factionId;
        break;
      }
      case ChatChannel.CLAN: {
        const cm = await db.clanMember.findUnique({ where: { userId: me } });
        if (!cm) throw forbidden("You are not in a clan", "NOT_CLAN_MEMBER");
        key = cm.clanId;
        break;
      }
      case ChatChannel.SQUAD: {
        const sm = await db.squadMember.findUnique({ where: { userId: me } });
        if (!sm) throw forbidden("You are not in a squad", "NOT_IN_SQUAD");
        key = sm.squadId;
        break;
      }
      case ChatChannel.PRIVATE: {
        const other = q.key ? app.parse(idSchema, q.key) : null;
        if (!other) throw badRequest("KEY_REQUIRED", "Private history requires the other user's id as key");
        key = [me, other].sort().join(":");
        break;
      }
    }
    const rows = await db.chatMessage.findMany({
      where: { channel: q.channel, channelKey: key, ...(q.before ? { createdAt: { lt: q.before } } : {}) },
      orderBy: { createdAt: "desc" },
      take: q.limit,
      include: { sender: { select: { username: true } } },
    });
    const blocked = new Set((await db.friend.findMany({ where: { userId: me, status: "BLOCKED" }, select: { friendId: true } })).map((b) => b.friendId));
    return {
      messages: rows
        .filter((m) => !blocked.has(m.senderId))
        .reverse()
        .map((m) => ({ id: m.id, channel: m.channel, from: m.sender.username, fromId: m.senderId, text: m.flagged ? "[message hidden by moderation]" : m.text, at: m.createdAt.getTime() })),
    };
  });

  app.post("/api/chat/report", { preHandler: app.authenticate, config: { rateLimit: app.rateLimits.chat } }, async (req) => {
    const body = app.parse(chatReportSchema, req.body);
    const msg = await db.chatMessage.findUnique({ where: { id: body.messageId }, select: { id: true, senderId: true } });
    if (!msg) throw notFound("Message");
    if (msg.senderId === req.user.id) throw badRequest("SELF_REPORT", "You cannot report your own message");
    try {
      await db.chatReport.create({ data: { messageId: msg.id, reporterId: req.user.id, reason: body.reason } });
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") return { ok: true, duplicate: true };
      throw err;
    }
    const n = await db.chatReport.count({ where: { messageId: msg.id, status: "OPEN" } });
    if (n >= REPORTS_TO_FLAG) await db.chatMessage.update({ where: { id: msg.id }, data: { flagged: true } });
    return { ok: true, duplicate: false };
  });

  // ------------------------------------------------------------------ notifications
  const notifQuery = z.object({ unread: z.coerce.boolean().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });
  app.get("/api/notifications", auth, async (req) => {
    const q = app.parse(notifQuery, req.query);
    const [rows, unread] = await Promise.all([
      db.notification.findMany({ where: { userId: req.user.id, ...(q.unread ? { readAt: null } : {}) }, orderBy: { createdAt: "desc" }, take: q.limit }),
      db.notification.count({ where: { userId: req.user.id, readAt: null } }),
    ]);
    return {
      unread,
      notifications: rows.map((n) => ({ id: n.id, type: n.type, title: n.title, body: n.body, data: n.data, read: Boolean(n.readAt), createdAt: n.createdAt.toISOString() })),
    };
  });

  app.post("/api/notifications/read", auth, async (req) => {
    const body = app.parse(notificationReadSchema, req.body);
    if (!body.all && !body.ids?.length) throw badRequest("NOTHING_TO_READ", "Provide ids or all=true");
    const r = await db.notification.updateMany({
      where: { userId: req.user.id, readAt: null, ...(body.all ? {} : { id: { in: body.ids ?? [] } }) },
      data: { readAt: new Date() },
    });
    return { updated: r.count };
  });

  app.post("/api/notifications/push-token", auth, async (req) => {
    const body = app.parse(pushTokenSchema, req.body);
    const fingerprint = `d:${body.deviceId}`;
    await db.device.upsert({
      where: { userId_fingerprint: { userId: req.user.id, fingerprint } },
      create: { userId: req.user.id, fingerprint, platform: body.platform || platformOf(req), pushToken: body.token, ip: req.ip },
      update: { pushToken: body.token, platform: body.platform, lastSeenAt: new Date() },
    });
    return { ok: true };
  });

  // ------------------------------------------------------------------ bounties
  app.get("/api/bounties", async () => {
    const rows = await db.bounty.groupBy({ by: ["targetId"], where: { status: "ACTIVE", expiresAt: { gt: new Date() } }, _sum: { amount: true }, _count: { _all: true } });
    const users = await db.user.findMany({ where: { id: { in: rows.map((r) => r.targetId) } }, select: { id: true, username: true, level: true } });
    return {
      bounties: rows
        .map((r) => ({ targetId: r.targetId, username: users.find((u) => u.id === r.targetId)?.username ?? null, level: users.find((u) => u.id === r.targetId)?.level ?? null, total: (r._sum.amount ?? 0n).toString(), count: r._count._all }))
        .sort((a, b) => (BigInt(b.total) > BigInt(a.total) ? 1 : -1)),
    };
  });

  app.post("/api/bounties", auth, async (req, reply) => {
    const body = app.parse(bountyCreateSchema, req.body);
    const me = req.user.id;
    if (body.targetUserId === me) throw badRequest("SELF_BOUNTY", "You cannot place a bounty on yourself");
    const rules = await loadRules(db);
    if (body.amount < BigInt(rules.bountyMin)) throw badRequest("BOUNTY_TOO_LOW", `Minimum bounty is ${rules.bountyMin} credits`);
    const target = await db.user.findUnique({ where: { id: body.targetUserId }, select: { id: true } });
    if (!target) throw notFound("User");
    const key = `bounty:${me}:${body.idempotencyKey}`;
    const dup = await db.balanceLedger.findUnique({ where: { idempotencyKey: key }, select: { reference: true } });
    if (dup) return { id: dup.reference, duplicate: true };
    const bounty = await withSerializableTx(db, async (tx) => {
      const b = await tx.bounty.create({ data: { targetId: target.id, creatorId: me, amount: body.amount, expiresAt: new Date(Date.now() + rules.bountyDurationHours * 3_600_000) } });
      await post(tx, {
        from: userWallet(me, Currency.CREDITS), to: system(LedgerAccountType.ESCROW, Currency.CREDITS), amount: body.amount,
        type: LedgerTxType.ESCROW, reference: b.id, idempotencyKey: key, userId: me, metadata: { kind: "BOUNTY", targetId: target.id },
      });
      await notify(tx, target.id, "BOUNTY_PLACED", "A bounty was placed on you", "Other pilots are hunting you. Watch your six.", { bountyId: b.id });
      return b;
    });
    return reply.status(201).send({ id: bounty.id, duplicate: false });
  });

  // ------------------------------------------------------------------ mail
  // Attachments (RewardBundle JSON written only by the server/admin) are claimed idempotently:
  // atomic `claimedAt IS NULL` update + ledger/item keys derived from the mail id.
  app.get("/api/mail", auth, async (req) => {
    const rows = await db.mail.findMany({
      where: { toUserId: req.user.id, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return {
      mail: rows.map((m) => ({
        id: m.id, fromUserId: m.fromUserId, system: m.system, subject: m.subject, body: m.body, attachments: m.attachments,
        hasAttachments: m.attachments !== null, claimed: Boolean(m.claimedAt), read: Boolean(m.readAt),
        expiresAt: m.expiresAt?.toISOString() ?? null, createdAt: m.createdAt.toISOString(),
      })),
    };
  });

  app.post<{ Params: { id: string } }>("/api/mail/:id/read", auth, async (req) => {
    const r = await db.mail.updateMany({ where: { id: app.parse(idSchema, req.params.id), toUserId: req.user.id, readAt: null }, data: { readAt: new Date() } });
    return { ok: true, updated: r.count };
  });

  app.post<{ Params: { id: string } }>("/api/mail/:id/claim", auth, async (req) => {
    const mailId = app.parse(idSchema, req.params.id);
    const userId = req.user.id;
    return db.$transaction(async (tx) => {
      const m = await tx.mail.findFirst({ where: { id: mailId, toUserId: userId } });
      if (!m) throw notFound("Mail");
      if (m.attachments === null) throw badRequest("NO_ATTACHMENTS", "This mail has no attachments");
      if (m.expiresAt && m.expiresAt.getTime() <= Date.now()) throw badRequest("MAIL_EXPIRED", "This mail has expired");
      const claimed = await tx.mail.updateMany({ where: { id: m.id, claimedAt: null }, data: { claimedAt: new Date(), readAt: m.readAt ?? new Date() } });
      if (claimed.count !== 1) throw conflict("ALREADY_CLAIMED", "Attachments already claimed");
      const bundle = m.attachments as unknown as RewardBundle;
      // Mail never carries crypto rewards; those go through the reward engine.
      const { cryptoEligible: _ignored, ...safe } = bundle;
      const res = await grantBundle(tx, userId, safe, `mail:${m.id}`, `mail:${m.subject}`);
      return { ok: true, items: res.items };
    });
  });
}
