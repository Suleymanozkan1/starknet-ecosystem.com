import type { DbOrTx } from "@nebula/database";
import type { AdminRole, ClanRole, MeResponse, PremiumTier, RiskLevel } from "@nebula/shared";
import { notFound } from "../errors.js";
import { balancesDto } from "./balances.js";
import { progressFor } from "./progression.js";

export async function buildMe(db: DbOrTx, userId: string): Promise<MeResponse> {
  const u = await db.user.findUnique({
    where: { id: userId },
    include: {
      playerFaction: { select: { factionId: true } },
      clanMember: { select: { role: true, clan: { select: { id: true, name: true, tag: true } } } },
      wallets: { where: { unlinkedAt: null }, select: { address: true, primary: true, verifiedAt: true } },
      adminUser: { select: { roles: true } },
    },
  });
  if (!u) throw notFound("User");
  const p = progressFor(u.xp);
  const premiumUntil = u.premiumUntil && u.premiumUntil.getTime() > Date.now() ? u.premiumUntil : null;
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    level: u.level,
    xp: Number(u.xp),
    xpToNext: p.xpToNext,
    xpIntoLevel: p.xpIntoLevel,
    honor: Number(u.honor),
    rank: u.rank,
    prestige: u.prestige,
    faction: u.playerFaction?.factionId ?? null,
    clan: u.clanMember
      ? { id: u.clanMember.clan.id, name: u.clanMember.clan.name, tag: u.clanMember.clan.tag, role: u.clanMember.role as ClanRole }
      : null,
    activeShipInstanceId: u.activeShipId,
    premiumTier: (premiumUntil ? u.premiumTier : "FREE") as PremiumTier,
    premiumUntil: premiumUntil ? premiumUntil.toISOString() : null,
    wallets: u.wallets.map((w) => ({ address: w.address, primary: w.primary, verifiedAt: w.verifiedAt.toISOString() })),
    balances: await balancesDto(db, u.id),
    roles: (u.adminUser?.roles ?? []) as AdminRole[],
    riskLevel: u.riskLevel as RiskLevel,
    createdAt: u.createdAt.toISOString(),
    restrictions: [
      ...u.restrictions,
      ...(u.mutedUntil && u.mutedUntil.getTime() > Date.now() ? ["MUTED"] : []),
    ],
  };
}
