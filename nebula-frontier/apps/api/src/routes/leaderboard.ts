/**
 * Leaderboards computed from authoritative tables, cached in Redis for 30 s.
 */
import type { FastifyInstance } from "fastify";
import type { LeaderboardResponse } from "@nebula/shared";
import { leaderboardQuerySchema } from "@nebula/validation";
import { activeSeasonId } from "../lib/grants.js";
import { factionWarStandings } from "../lib/factionWar.js";

type Entry = LeaderboardResponse["entries"][number];

export default async function leaderboardRoutes(app: FastifyInstance): Promise<void> {
  const { db, redis } = app;

  async function playerBoard(order: "playerKills" | "npcKills" | "honor" | "seasonScore", limit: number): Promise<Entry[]> {
    const userSelect = {
      id: true, username: true, level: true, honor: true, seasonScore: true,
      playerFaction: { select: { factionId: true } },
      clanMember: { select: { clan: { select: { tag: true } } } },
    } as const;
    if (order === "playerKills" || order === "npcKills") {
      const rows = await db.playerStat.findMany({
        where: { user: { bannedAt: null } },
        orderBy: order === "playerKills" ? { playerKills: "desc" } : { npcKills: "desc" },
        take: limit,
        select: { playerKills: true, npcKills: true, user: { select: userSelect } },
      });
      return rows.map((r, i) => ({
        rank: i + 1,
        userId: r.user.id,
        username: r.user.username,
        faction: r.user.playerFaction?.factionId ?? null,
        clanTag: r.user.clanMember?.clan.tag ?? null,
        score: String(order === "playerKills" ? r.playerKills : r.npcKills),
        level: r.user.level,
      }));
    }
    const users = await db.user.findMany({
      where: { bannedAt: null },
      orderBy: order === "honor" ? { honor: "desc" } : { seasonScore: "desc" },
      take: limit,
      select: userSelect,
    });
    return users.map((u, i) => ({
      rank: i + 1,
      userId: u.id,
      username: u.username,
      faction: u.playerFaction?.factionId ?? null,
      clanTag: u.clanMember?.clan.tag ?? null,
      score: (order === "honor" ? u.honor : u.seasonScore).toString(),
      level: u.level,
    }));
  }

  app.get("/api/leaderboard", async (req): Promise<LeaderboardResponse> => {
    const q = app.parse(leaderboardQuerySchema, req.query);
    const cacheKey = `lb:${q.board}:${q.limit}`;
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached) as LeaderboardResponse;
    let entries: Entry[];
    switch (q.board) {
      case "pvp_kills": entries = await playerBoard("playerKills", q.limit); break;
      case "npc_kills": entries = await playerBoard("npcKills", q.limit); break;
      case "honor": entries = await playerBoard("honor", q.limit); break;
      case "season_score": entries = await playerBoard("seasonScore", q.limit); break;
      case "faction": {
        // Seasonal faction war standings (event score + live territory); all-time when no season is active.
        const war = await factionWarStandings(db);
        const rows = war.seasonId ? war.season : war.allTime;
        entries = rows.slice(0, q.limit).map((f, i) => ({ rank: i + 1, userId: f.factionId, username: f.name, faction: f.factionId, clanTag: f.tag, score: f.score, level: f.territory }));
        break;
      }
      case "clan": {
        const rows = await db.clan.findMany({ orderBy: { score: "desc" }, take: q.limit });
        entries = rows.map((c, i) => ({ rank: i + 1, userId: c.id, username: c.name, faction: c.factionId, clanTag: c.tag, score: c.score.toString(), level: c.level }));
        break;
      }
    }
    const res: LeaderboardResponse = { board: q.board, season: q.board === "season_score" || q.board === "faction" ? await activeSeasonId(db) : null, entries };
    await redis.set(cacheKey, JSON.stringify(res), "EX", 30);
    return res;
  });

  /** Faction war: season and all-time standings with the metric breakdown and scoring weights. */
  app.get("/api/factions/war", async () => {
    const cached = await redis.get("factionwar");
    if (cached) return JSON.parse(cached) as unknown;
    const res = await factionWarStandings(db);
    await redis.set("factionwar", JSON.stringify(res), "EX", 30);
    return res;
  });
}
