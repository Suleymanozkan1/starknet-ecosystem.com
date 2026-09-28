/**
 * Admin analytics aggregates (GET /api/admin/analytics). All figures are computed from
 * authoritative tables (Session, AnalyticsEvent, GameMatch, BalanceLedger, Trade, Withdrawal ...).
 */
import type { Db } from "@nebula/database";
import { LedgerAccountType } from "@nebula/shared";
import { parseLoadout } from "./inventory.js";

const DAY = 86_400_000;
const num = (v: unknown): number => (typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : v === null || v === undefined ? 0 : Number(v));

const SOURCE_ACCOUNTS = new Set<string>([LedgerAccountType.GAME_ISSUANCE, LedgerAccountType.EXTERNAL_CHAIN]);
const SINK_ACCOUNTS = new Set<string>([
  LedgerAccountType.GAME_SINK, LedgerAccountType.PREMIUM_REVENUE, LedgerAccountType.MARKETPLACE_REVENUE,
  LedgerAccountType.AUCTION_REVENUE, LedgerAccountType.FEE_REVENUE, LedgerAccountType.OPERATING_REVENUE,
]);

async function activeUsers(db: Db, since: Date): Promise<number> {
  const rows = await db.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(DISTINCT uid)::bigint AS n FROM (
      SELECT "userId" AS uid FROM "Session" WHERE "lastUsedAt" >= ${since} OR "createdAt" >= ${since}
      UNION SELECT "userId" FROM "AnalyticsEvent" WHERE "createdAt" >= ${since} AND "userId" IS NOT NULL
    ) t`;
  return num(rows[0]?.n);
}

/** Share of users (created in [from, to)) active between +dayN and +dayN+1 after sign-up. */
async function retention(db: Db, from: Date, to: Date, dayN: number): Promise<{ cohort: number; retained: number; rate: number | null }> {
  if (to <= from) return { cohort: 0, retained: 0, rate: null };
  const rows = await db.$queryRaw<{ total: bigint; retained: bigint }[]>`
    WITH cohort AS (SELECT id, "createdAt" FROM "User" WHERE "createdAt" >= ${from} AND "createdAt" < ${to}),
    activity AS (
      SELECT "userId" AS uid, "createdAt" AS at FROM "AnalyticsEvent" WHERE "userId" IN (SELECT id FROM cohort)
      UNION ALL SELECT "userId", "createdAt" FROM "Session" WHERE "userId" IN (SELECT id FROM cohort)
      UNION ALL SELECT "userId", "lastUsedAt" FROM "Session" WHERE "userId" IN (SELECT id FROM cohort)
    )
    SELECT COUNT(*)::bigint AS total,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM activity a WHERE a.uid = c.id
          AND a.at >= c."createdAt" + make_interval(days => ${dayN}::int)
          AND a.at < c."createdAt" + make_interval(days => ${dayN + 1}::int)
      ))::bigint AS retained
    FROM cohort c`;
  const total = num(rows[0]?.total);
  const retained = num(rows[0]?.retained);
  return { cohort: total, retained, rate: total ? retained / total : null };
}

export async function adminAnalytics(db: Db, days: number) {
  const now = Date.now();
  const since = new Date(now - days * DAY);
  const [dau, wau, mau, d1, d7] = await Promise.all([
    activeUsers(db, new Date(now - DAY)),
    activeUsers(db, new Date(now - 7 * DAY)),
    activeUsers(db, new Date(now - 30 * DAY)),
    retention(db, since, new Date(now - 2 * DAY), 1),
    retention(db, since, new Date(now - 8 * DAY), 7),
  ]);

  const [sessionAgg, playtimeAgg, matchAgg, killsAll, killsWindow, shipUsage, winRows, ledgerRows, trades, withdrawals, events] = await Promise.all([
    db.$queryRaw<{ avg: number | null; n: bigint }[]>`
      SELECT AVG(EXTRACT(EPOCH FROM ("lastUsedAt" - "createdAt")))::float8 AS avg, COUNT(*)::bigint AS n
      FROM "Session" WHERE "createdAt" >= ${since}`,
    db.$queryRaw<{ avg: number | null; players: bigint }[]>`
      SELECT AVG("playtimeSeconds")::float8 AS avg, COUNT(*)::bigint AS players FROM "User" WHERE "playtimeSeconds" > 0`,
    db.$queryRaw<{ mode: string; avg: number | null; n: bigint }[]>`
      SELECT mode, AVG(EXTRACT(EPOCH FROM ("endedAt" - "startedAt")))::float8 AS avg, COUNT(*)::bigint AS n
      FROM "GameMatch" WHERE "endedAt" IS NOT NULL AND "startedAt" >= ${since} GROUP BY mode`,
    db.playerStat.aggregate({ _sum: { playerKills: true, npcKills: true, bossKills: true, deaths: true } }),
    db.gameMatchPlayer.aggregate({ where: { joinedAt: { gte: since } }, _sum: { kills: true, deaths: true } }),
    db.$queryRaw<{ shipId: string; n: bigint }[]>`
      SELECT si."shipId" AS "shipId", COUNT(*)::bigint AS n FROM "User" u JOIN "ShipInstance" si ON si.id = u."activeShipId"
      GROUP BY si."shipId" ORDER BY n DESC`,
    db.$queryRaw<{ mode: string; total: bigint; wins: bigint }[]>`
      SELECT m.mode, COUNT(*)::bigint AS total, COUNT(*) FILTER (WHERE mp.team = m."winnerTeam")::bigint AS wins
      FROM "GameMatchPlayer" mp JOIN "GameMatch" m ON m.id = mp."matchId"
      WHERE m."winnerTeam" IS NOT NULL AND m."startedAt" >= ${since} GROUP BY m.mode`,
    db.$queryRaw<{ type: string; asset: string; fromType: string; toType: string; amount: bigint; n: bigint }[]>`
      SELECT l.type, l.asset, da.type AS "fromType", ca.type AS "toType", SUM(l.amount)::bigint AS amount, COUNT(*)::bigint AS n
      FROM "BalanceLedger" l
      JOIN "BalanceAccount" da ON da.id = l."debitAccountId"
      JOIN "BalanceAccount" ca ON ca.id = l."creditAccountId"
      WHERE l."createdAt" >= ${since}
      GROUP BY l.type, l.asset, da.type, ca.type`,
    db.trade.groupBy({ by: ["kind", "currency"], where: { createdAt: { gte: since } }, _sum: { price: true, fee: true }, _count: { _all: true } }),
    db.withdrawal.groupBy({ by: ["status"], where: { createdAt: { gte: since } }, _sum: { requested: true, final: true }, _count: { _all: true } }),
    db.analyticsEvent.groupBy({ by: ["name"], where: { createdAt: { gte: since } }, _count: { _all: true } }),
  ]);

  // Weapon usage: weapons/missiles equipped in the active loadout of every pilot's active ship.
  const active = await db.user.findMany({
    where: { activeShipId: { not: null } },
    select: { activeShipId: true },
    take: 20_000,
  });
  const ships = await db.shipInstance.findMany({
    where: { id: { in: active.map((a) => a.activeShipId as string) }, activeLoadoutId: { not: null } },
    select: { activeLoadoutId: true },
  });
  const loadouts = await db.shipLoadout.findMany({ where: { id: { in: ships.map((s) => s.activeLoadoutId as string) } }, select: { config: true } });
  const weaponInvIds: string[] = [];
  for (const l of loadouts) {
    const c = parseLoadout(l.config);
    weaponInvIds.push(...[...c.weapons, ...c.missiles].filter((x): x is string => Boolean(x)));
  }
  const weaponRows = weaponInvIds.length
    ? await db.inventoryItem.groupBy({ by: ["itemId"], where: { id: { in: weaponInvIds } }, _count: { _all: true } })
    : [];

  const sources: Record<string, Record<string, string>> = {};
  const sinks: Record<string, Record<string, string>> = {};
  const add = (bucket: Record<string, Record<string, string>>, asset: string, type: string, amount: bigint) => {
    bucket[asset] ??= {};
    bucket[asset][type] = (BigInt(bucket[asset][type] ?? "0") + amount).toString();
  };
  for (const r of ledgerRows) {
    if (SOURCE_ACCOUNTS.has(r.fromType)) add(sources, r.asset, r.type, r.amount);
    if (SINK_ACCOUNTS.has(r.toType)) add(sinks, r.asset, r.type, r.amount);
  }

  return {
    windowDays: days,
    generatedAt: new Date(now).toISOString(),
    activeUsers: { dau, wau, mau, stickiness: mau ? dau / mau : null },
    retention: { d1, d7 },
    sessions: {
      count: num(sessionAgg[0]?.n),
      avgSessionSeconds: sessionAgg[0]?.avg ?? null,
      avgPlaytimeSecondsPerPlayer: playtimeAgg[0]?.avg ?? null,
      playersWithPlaytime: num(playtimeAgg[0]?.players),
    },
    matches: matchAgg.map((m) => ({ mode: m.mode, count: num(m.n), avgSeconds: m.avg })),
    kills: {
      allTime: { pvp: killsAll._sum.playerKills ?? 0, pve: killsAll._sum.npcKills ?? 0, bosses: killsAll._sum.bossKills ?? 0, deaths: killsAll._sum.deaths ?? 0 },
      matchesInWindow: { kills: killsWindow._sum.kills ?? 0, deaths: killsWindow._sum.deaths ?? 0 },
    },
    shipUsage: shipUsage.map((s) => ({ shipId: s.shipId, activePilots: num(s.n) })),
    weaponUsage: weaponRows.map((w) => ({ itemId: w.itemId, equipped: w._count._all })).sort((a, b) => b.equipped - a.equipped),
    winRate: winRows.map((w) => ({ mode: w.mode, participations: num(w.total), wins: num(w.wins), rate: num(w.total) ? num(w.wins) / num(w.total) : null })),
    economy: { sources, sinks },
    market: trades.map((t) => ({ kind: t.kind, currency: t.currency, trades: t._count._all, volume: (t._sum.price ?? 0n).toString(), fees: (t._sum.fee ?? 0n).toString() })),
    withdrawals: withdrawals.map((w) => ({ status: w.status, count: w._count._all, requested: (w._sum.requested ?? 0n).toString(), paid: (w._sum.final ?? 0n).toString() })),
    events: Object.fromEntries(events.map((e) => [e.name, e._count._all])),
  };
}
