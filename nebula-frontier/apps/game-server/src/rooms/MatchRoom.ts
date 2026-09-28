/**
 * Team match lifecycle shared by PvP (casual/ranked, large-scale 50v50),
 * Arena and Clan War rooms:
 * WAITING → COUNTDOWN → RUNNING → ENDED, team scoring, GameMatch /
 * GameMatchPlayer rows, Elo (team) rating update, match_start / match_end.
 */
import { MatchMode, RoomName, ServerEvent, type RewardSource } from "@nebula/shared";
import { teamRatingDeltas } from "@nebula/game-core";
import { ServerError } from "@colyseus/core";
import type { Tx } from "@nebula/database";
import { BaseGameRoom } from "./BaseGameRoom.js";
import type { PlayerActor, ShipActor } from "./actors.js";

type Phase = "WAITING" | "COUNTDOWN" | "RUNNING" | "ENDED";

export abstract class MatchRoom extends BaseGameRoom {
  protected abstract readonly mode: MatchMode;
  protected teams = 2;
  protected phase: Phase = "WAITING";
  protected matchId: string | null = null;
  protected phaseEndsAt = 0;
  protected teamScores: number[] = [0, 0];
  /** Everyone who played in the running match (kept after leave, counted as loss). */
  protected roster = new Map<string, { userId: string; name: string; team: number; rating: number; matches: number; kills: number; deaths: number; damage: number; score: number; left: boolean; entityId: string }>();

  protected override pvpNormalized(): boolean {
    return true;
  }
  protected override isTeamRoom(): boolean {
    return true;
  }
  protected override setupWorld(): void {
    // Match maps have no NPCs.
    this.spawnAsteroids();
  }
  protected override currentMatchId(): string | null {
    return this.matchId;
  }
  protected override matchMode(): string {
    return this.mode;
  }
  protected override playersHostile(a: PlayerActor, b: PlayerActor): boolean {
    return this.phase === "RUNNING" && a.team !== b.team;
  }
  protected override bossRewardSource(): RewardSource {
    return "PVP";
  }

  protected override teamFor(p: PlayerActor): number {
    const requested = this.options.team;
    const counts = Array.from({ length: this.teams }, (_, i) => [...this.players.values()].filter((o) => o.team === i && o !== p).length);
    if (requested !== undefined && requested < this.teams && (counts[requested] ?? 0) <= Math.min(...counts)) return requested;
    let best = 0;
    counts.forEach((c, i) => { if (c < (counts[best] ?? 0)) best = i; });
    return best;
  }

  protected override spawnPointFor(p: PlayerActor): { x: number; y: number } {
    return this.teamSpawn(p.team);
  }
  protected override respawnPointFor(p: PlayerActor): { x: number; y: number } {
    return this.teamSpawn(p.team);
  }
  protected teamSpawn(team: number): { x: number; y: number } {
    const margin = Math.min(40, this.map.width * 0.1);
    const x = team % 2 === 0 ? margin : this.map.width - margin;
    const y = this.map.height / 2 + (this.rng() - 0.5) * this.map.height * 0.4;
    return { x, y };
  }

  protected override async beforePlayerJoin(_p: PlayerActor): Promise<void> {
    if (this.phase === "ENDED") throw new ServerError(4403, "MATCH_ENDED");
  }

  protected override onPlayerJoined(p: PlayerActor): void {
    this.state.match.mode = this.mode;
    if (this.phase === "RUNNING" && this.matchId) this.enroll(p);
    this.syncMatchState();
  }

  protected override onPlayerRemoved(p: PlayerActor): void {
    const r = this.roster.get(p.userId);
    if (r && this.phase === "RUNNING") r.left = true;
    if (this.phase === "RUNNING") {
      const alive = new Set([...this.players.values()].map((o) => o.team));
      if (alive.size <= 1) void this.endMatch(alive.size === 1 ? [...alive][0] ?? null : null, "FORFEIT");
    } else if (this.phase === "COUNTDOWN" && this.players.size < this.rules.arenaMinPlayers) {
      this.phase = "WAITING";
      this.syncMatchState();
    }
  }

  private enroll(p: PlayerActor): void {
    if (!this.matchId) return;
    if (!this.roster.has(p.userId)) {
      this.roster.set(p.userId, { userId: p.userId, name: p.name, team: p.team, rating: p.profile.pvpRating, matches: p.profile.matchesPlayed, kills: 0, deaths: 0, damage: 0, score: 0, left: false, entityId: p.id });
    }
    void this.svc.persistence.joinMatch(this.matchId, p.userId, p.team).catch((e: unknown) => this.log.error({ err: e }, "joinMatch failed"));
  }

  protected override onTickExtra(): void {
    const now = this.now;
    if (this.phase === "WAITING" && this.players.size >= this.rules.arenaMinPlayers && new Set([...this.players.values()].map((p) => p.team)).size >= 2) {
      this.phase = "COUNTDOWN";
      this.phaseEndsAt = now + this.rules.arenaCountdownMs;
      this.syncMatchState();
    } else if (this.phase === "COUNTDOWN" && now >= this.phaseEndsAt) {
      void this.startMatch();
    } else if (this.phase === "RUNNING") {
      for (const p of this.players.values()) {
        const r = this.roster.get(p.userId);
        if (r) r.damage = p.damageDealt;
      }
      if (now >= this.phaseEndsAt) {
        const max = Math.max(...this.teamScores);
        const leaders = this.teamScores.map((s, i) => (s === max ? i : -1)).filter((i) => i >= 0);
        void this.endMatch(leaders.length === 1 ? leaders[0] ?? null : null, "TIME");
      }
    }
  }

  private async startMatch(): Promise<void> {
    if (this.phase !== "COUNTDOWN") return;
    this.phase = "RUNNING";
    this.phaseEndsAt = this.now + this.rules.arenaMatchMs;
    this.teamScores = Array.from({ length: this.teams }, () => 0);
    try {
      this.matchId = await this.svc.persistence.createMatch({ roomId: this.roomId, mode: this.mode, mapId: this.map.id, metadata: { region: this.svc.config.region } });
    } catch (e) {
      this.log.error({ err: e }, "createMatch failed");
      this.phase = "WAITING";
      return;
    }
    for (const p of this.players.values()) {
      this.enroll(p);
      // Everyone starts fresh at their team spawn.
      const s = this.teamSpawn(p.team);
      p.x = s.x;
      p.y = s.y;
      p.hull = p.maxHull;
      p.shield = p.maxShield;
      p.dead = false;
      p.invulnerableUntil = this.now + this.rules.spawnProtectionMs;
    }
    this.syncMatchState();
    this.broadcast(ServerEvent.MATCH_START, { matchId: this.matchId, mode: this.mode });
  }

  protected override onPlayerKilled(victim: PlayerActor, killer: ShipActor | null): void {
    if (this.phase !== "RUNNING") return;
    const rv = this.roster.get(victim.userId);
    if (rv) rv.deaths++;
    if (killer && killer.kind === "PLAYER") {
      const k = killer as PlayerActor;
      const rk = this.roster.get(k.userId);
      if (rk) {
        rk.kills++;
        rk.score += 10;
      }
      k.score += 10;
      this.teamScores[k.team] = (this.teamScores[k.team] ?? 0) + 1;
      // assists
      for (const [id] of victim.damageBy) {
        const a = this.players.get(id);
        if (a && a !== k && a.team === k.team) {
          const ra = this.roster.get(a.userId);
          if (ra) ra.score += 3;
        }
      }
      this.syncMatchState();
      if ((this.teamScores[k.team] ?? 0) >= this.rules.arenaScoreToWin) void this.endMatch(k.team, "SCORE");
    }
  }

  protected async endMatch(winnerTeam: number | null, reason: string): Promise<void> {
    if (this.phase !== "RUNNING" || !this.matchId) return;
    this.phase = "ENDED";
    this.phaseEndsAt = this.now;
    const matchId = this.matchId;
    const roster = [...this.roster.values()];
    const rated = this.mode === MatchMode.RANKED || this.mode === MatchMode.ARENA || this.mode === MatchMode.CLAN_WAR;
    const teams = Array.from({ length: this.teams }, (_, t) => roster.filter((r) => r.team === t).map((r) => ({ userId: r.userId, rating: r.rating, matches: r.matches })));
    const deltas = rated ? teamRatingDeltas(teams, winnerTeam) : new Map<string, number>();
    const scores = roster.map((r) => ({ entityId: r.entityId, name: r.name, kills: r.kills, deaths: r.deaths, score: r.score }));
    this.syncMatchState();
    this.broadcast(ServerEvent.MATCH_END, { matchId, winnerTeam: winnerTeam ?? undefined, scores });
    try {
      await this.svc.persistence.finishMatch(
        matchId,
        winnerTeam,
        roster.map((r) => ({ userId: r.userId, kills: r.kills, deaths: r.deaths, damage: r.damage, score: r.score, ratingDelta: deltas.get(r.userId) ?? 0, won: winnerTeam !== null && r.team === winnerTeam && !r.left, left: r.left })),
        { reason, teamScores: this.teamScores, mode: this.mode },
        (tx) => this.onMatchFinishedTx(tx, winnerTeam),
      );
    } catch (e) {
      this.log.error({ err: e, matchId }, "finishMatch failed");
    }
    for (const p of this.players.values()) {
      const won = winnerTeam !== null && p.team === winnerTeam;
      if (won) this.questEvent(p, { type: "WIN_PVP", mapId: this.map.id });
      const d = deltas.get(p.userId) ?? 0;
      this.emitTo(p.client, ServerEvent.NOTICE, { level: won ? "success" : "info", text: `${won ? "Victory" : winnerTeam === null ? "Draw" : "Defeat"}${rated ? ` (${d >= 0 ? "+" : ""}${d} rating)` : ""}` });
      this.requestFlush(p);
    }
    await this.lock();
    this.clock.setTimeout(() => void this.disconnect(), 15_000);
  }

  /** Extra writes committed atomically with the GameMatch result. */
  protected async onMatchFinishedTx(_tx: Tx, _winnerTeam: number | null): Promise<void> {
    // default: nothing
  }

  protected syncMatchState(): void {
    const m = this.state.match;
    m.matchId = this.matchId ?? "";
    m.mode = this.mode;
    m.phase = this.phase;
    m.endsAt = this.phaseEndsAt;
    m.teamScores.clear();
    for (const s of this.teamScores) m.teamScores.push(s);
  }
}

/** Casual / ranked / large-scale (50v50) PvP. `difficulty` option selects "RANKED"; default CASUAL. */
export class PvPRoom extends MatchRoom {
  readonly roomKind = RoomName.PVP;
  protected mode: MatchMode = MatchMode.CASUAL;
  override async onCreate(options: Record<string, unknown>): Promise<void> {
    const d = String(options.difficulty ?? "").toUpperCase();
    this.mode = d === "RANKED" ? MatchMode.RANKED : d === "LARGE_SCALE" ? MatchMode.LARGE_SCALE : MatchMode.CASUAL;
    await super.onCreate(options);
  }
}

/** Small-team rated arena. */
export class ArenaRoom extends MatchRoom {
  readonly roomKind = RoomName.ARENA;
  protected readonly mode = MatchMode.ARENA;
}

/**
 * Clan war battle: exactly two clans (first two clans to join take teams 0/1);
 * pilots without a clan or from a third clan are rejected.
 */
export class ClanWarRoom extends MatchRoom {
  readonly roomKind = RoomName.CLAN_WAR;
  protected readonly mode = MatchMode.CLAN_WAR;
  private clanTeams: string[] = [];

  protected override bossRewardSource(): RewardSource {
    return "FACTION_WAR";
  }

  protected override async beforePlayerJoin(p: PlayerActor): Promise<void> {
    await super.beforePlayerJoin(p);
    const clanId = p.profile.clanId;
    if (!clanId) throw new ServerError(4403, "CLAN_REQUIRED");
    if (!this.clanTeams.includes(clanId)) {
      if (this.clanTeams.length >= 2) throw new ServerError(4403, "CLAN_NOT_IN_WAR");
      this.clanTeams.push(clanId);
    }
  }

  protected override teamFor(p: PlayerActor): number {
    return Math.max(0, this.clanTeams.indexOf(p.profile.clanId ?? ""));
  }

  /**
   * Record the battle on the ClanWar row (scores, winner, SCORING → REWARDED)
   * and add clan score, in the same transaction as the GameMatch result.
   * The war is `instanceKey` (ClanWar id) when given, else the open war
   * between the two clans; an ad-hoc war row is created otherwise.
   */
  protected override async onMatchFinishedTx(tx: Tx, winnerTeam: number | null): Promise<void> {
    const [clanA, clanB] = this.clanTeams;
    if (!clanA || !clanB) return;
    const scoreA = this.teamScores[0] ?? 0;
    const scoreB = this.teamScores[1] ?? 0;
    const winnerId = winnerTeam === null ? null : winnerTeam === 0 ? clanA : clanB;
    const byKey = this.options.instanceKey ? await tx.clanWar.findUnique({ where: { id: this.options.instanceKey } }) : null;
    let war = byKey && [byKey.clanAId, byKey.clanBId].includes(clanA) && [byKey.clanAId, byKey.clanBId].includes(clanB) ? byKey : null;
    war ??= await tx.clanWar.findFirst({
      where: { phase: { notIn: ["REWARDED"] }, OR: [{ clanAId: clanA, clanBId: clanB }, { clanAId: clanB, clanBId: clanA }] },
      orderBy: { createdAt: "desc" },
    });
    const now = new Date();
    if (!war) {
      war = await tx.clanWar.create({ data: { clanAId: clanA, clanBId: clanB, mapId: this.map.id, phase: "BATTLE", startsAt: new Date(this.phaseEndsAt - this.rules.arenaMatchMs), endsAt: now } });
    }
    // Scores are stored relative to the war's own A/B orientation.
    const aIsTeam0 = war.clanAId === clanA;
    await tx.clanWar.update({ where: { id: war.id }, data: { phase: "SCORING", scoreA: aIsTeam0 ? scoreA : scoreB, scoreB: aIsTeam0 ? scoreB : scoreA, winnerId, endsAt: now } });
    const add = (team: number) => BigInt((this.teamScores[team] ?? 0) * this.rules.clanWarKillScore + (winnerTeam === team ? this.rules.clanWarWinScore : 0));
    await tx.clan.update({ where: { id: clanA }, data: { score: { increment: add(0) } } });
    await tx.clan.update({ where: { id: clanB }, data: { score: { increment: add(1) } } });
    await tx.clanWar.update({ where: { id: war.id }, data: { phase: "REWARDED" } });
    this.clanWarId = war.id;
  }

  /** ClanWar row updated by the last finished match (tests / diagnostics). */
  clanWarId: string | null = null;
}
