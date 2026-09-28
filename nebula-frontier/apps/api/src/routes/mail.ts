/**
 * In-game mail. Attachments (RewardBundle JSON written only by the server/admin) are claimed
 * idempotently: atomic `claimedAt IS NULL` update + ledger/item keys derived from the mail id.
 */
import type { FastifyInstance } from "fastify";
import type { RewardBundle } from "@nebula/shared";
import { idSchema } from "@nebula/validation";
import { badRequest, conflict, notFound } from "../errors.js";
import { grantBundle } from "../lib/grants.js";

export default async function mailRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app;
  const auth = { preHandler: app.authenticate };

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
