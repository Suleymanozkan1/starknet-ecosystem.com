/**
 * Instanced gate run (gates.json): waves 1, 2, 3, Elite, Mini Boss, Final
 * Boss with NORMAL/HARD/NIGHTMARE/MYTHIC difficulty multipliers, entry cost
 * (credits via ledger sink + resources), completion rewards and crypto
 * eligibility (source GATE). RaidRoom extends this for 4/8/16/25-pilot raids.
 */
import { GATES, NPCS_BY_ID } from "@nebula/config";
import { toMoney } from "@nebula/game-core";
import { GateDifficulty, MatchMode, RoomName, ServerEvent, type GateDef, type RewardSource } from "@nebula/shared";
import { ServerError } from "@colyseus/core";
import { BaseGameRoom } from "./BaseGameRoom.js";
import type { NpcActor, PlayerActor } from "./actors.js";
import { qualifyContributors, raidCryptoWeight, raidRewardScale } from "./contribution.js";

export class GateRoom extends BaseGameRoom {
  readonly roomKind: RoomName = RoomName.GATE;

  /** Portal/rift jumps issue a ticket for exactly this map; a ticket for another map must not enter. */
  protected override requireTicketMap(): boolean {
    return true;
  }

  protected gate: GateDef | null = null;
  protected difficulty: GateDifficulty = GateDifficulty.NORMAL;
  protected wave = -1;
  protected nextWaveAt = 0;
  protected completed = false;
  protected matchId: string | null = null;
  protected participants = new Set<string>();

  protected override currentMatchId(): string | null {
    return this.matchId;
  }
  protected override matchMode(): string {
    return MatchMode.GATE;
  }
  protected override bossRewardSource(): RewardSource {
    return "GATE";
  }
  protected override tracksBossParticipation(): boolean {
    return false;
  }
  /** Gate kills do not pay tier rewards per boss; the run completion pays. */
  protected override async onBossKilled(_n: NpcActor, _contributors: { p: PlayerActor; dmg: number }[], _total: number): Promise<void> {
    // intentionally no per-boss payout inside a gate; see completeRun()
  }

  protected mult(): { hull: number; damage: number; reward: number } {
    const d = this.gate?.difficulties[this.difficulty];
    return { hull: d?.hullMultiplier ?? 1, damage: d?.damageMultiplier ?? 1, reward: d?.rewardMultiplier ?? 1 };
  }

  protected override setupWorld(): void {
    this.gate = GATES.find((g) => g.map === this.map.id) ?? null;
    const d = String(this.options.difficulty ?? "NORMAL").toUpperCase();
    this.difficulty = (Object.values(GateDifficulty) as string[]).includes(d) ? (d as GateDifficulty) : GateDifficulty.NORMAL;
    this.state.match.mode = MatchMode.GATE;
    this.state.match.difficulty = this.difficulty;
    this.state.match.totalWaves = this.gate?.waves.length ?? 0;
    this.state.match.phase = "WAITING";
    this.spawnAsteroids();
  }

  protected override async beforePlayerJoin(p: PlayerActor): Promise<void> {
    const g = this.gate;
    if (!g) throw new ServerError(4404, "NO_GATE_FOR_MAP");
    if (this.completed) throw new ServerError(4403, "GATE_COMPLETED");
    if (p.level < g.requiredLevel) throw new ServerError(4403, "LEVEL_TOO_LOW");
    // Entry cost is charged once per instance. The in-memory claim happens synchronously
    // (before any await), so concurrent joins of the same user in this room cannot both pay;
    // the ledger idempotency key protects credits across retries, and resources are only spent
    // when the credit charge was new (or when the entry has no credit cost and the claim is ours).
    if (this.participants.has(p.userId)) return;
    this.participants.add(p.userId);
    const credits = toMoney(g.entryCost.credits ?? 0);
    const resources = g.entryCost.resources ?? {};
    const key = `gate_entry:${this.roomId}:${p.userId}`;
    try {
      await this.svc.db.$transaction(async (tx) => {
        if (credits > 0n) {
          const charged = await this.svc.persistence.chargeCredits(p.userId, credits, key, `gate_entry:${g.id}`, false, tx);
          if (charged === 0n) return; // duplicate entry: already paid (credits + resources) earlier
        }
        await this.svc.persistence.spendResources(tx, p.userId, resources);
      });
    } catch (e) {
      this.participants.delete(p.userId);
      const msg = (e as Error).message;
      if (msg.includes("INSUFFICIENT")) throw new ServerError(4402, msg.startsWith("INSUFFICIENT_RESOURCE") ? msg : "INSUFFICIENT_CREDITS");
      throw e;
    }
  }

  /** Create the GameMatch row once (shared promise — no sentinel ids). */
  protected ensureMatch(): Promise<string> {
    this.matchPromise ??= this.svc.persistence
      .createMatch({ roomId: this.roomId, mode: this.matchMode(), mapId: this.map.id, metadata: this.matchMetadata() })
      .then((id) => {
        this.matchId = id;
        this.state.match.matchId = id;
        this.broadcast(ServerEvent.MATCH_START, { matchId: id, mode: this.matchMode() });
        return id;
      })
      .catch((e: unknown) => {
        this.matchPromise = null;
        throw e;
      });
    return this.matchPromise;
  }
  protected matchPromise: Promise<string> | null = null;

  protected matchMetadata(): Record<string, unknown> {
    return { gate: this.gate?.id, difficulty: this.difficulty };
  }

  /** Persist only the joining player's GameMatchPlayer row; failures are logged, never thrown. */
  protected enrollInMatch(p: PlayerActor): void {
    this.ensureMatch()
      .then((id) => this.svc.persistence.joinMatch(id, p.userId, 0))
      .catch((e: unknown) => this.log.error({ err: e, userId: p.userId }, "match enrollment failed"));
  }

  protected override onPlayerJoined(p: PlayerActor): void {
    if (this.wave < 0 && !this.completed) {
      this.wave = 0;
      this.nextWaveAt = this.now + this.rules.gateWaveDelayMs;
      this.state.match.phase = "RUNNING";
    }
    this.enrollInMatch(p);
  }

  protected waveNpcsAlive(): number {
    let n = 0;
    for (const x of this.npcs.values()) if (x.tag.startsWith("wave:") && !x.dead) n++;
    return n;
  }

  protected override onTickExtra(): void {
    const g = this.gate;
    if (!g || this.completed || this.wave < 0) return;
    if (this.players.size === 0) return;
    if (this.nextWaveAt > 0 && this.now >= this.nextWaveAt) {
      this.nextWaveAt = 0;
      this.spawnWave(this.wave);
      return;
    }
    if (this.nextWaveAt === 0 && this.waveNpcsAlive() === 0) {
      if (this.wave >= g.waves.length - 1) {
        this.completeRun().catch((e: unknown) => this.log.error({ err: e }, "gate completion failed"));
      }
      else {
        this.wave++;
        this.nextWaveAt = this.now + this.rules.gateWaveDelayMs;
      }
    }
  }

  protected spawnWave(idx: number): void {
    const g = this.gate;
    const w = g?.waves[idx];
    if (!g || !w) return;
    const m = this.mult();
    this.state.match.wave = idx + 1;
    this.broadcast(ServerEvent.WAVE, { wave: idx + 1, total: g.waves.length, name: w.name });
    const cx = this.map.width * 0.65;
    const cy = this.map.height / 2;
    for (const grp of w.npcs) {
      const def = NPCS_BY_ID.get(grp.npcId);
      if (!def) continue;
      for (let i = 0; i < grp.count; i++) {
        const a = this.rng() * Math.PI * 2;
        const r = 10 + this.rng() * 50;
        const n = this.spawnNpc(def, cx + Math.cos(a) * r, cy + Math.sin(a) * r, { spawnIndex: null, homeRadius: 80, hullMult: m.hull, damageMult: m.damage, rewardMult: m.reward, tag: `wave:${idx}` });
        // Gate NPCs hunt immediately.
        n.brain = { ...n.brain, homeX: this.map.width / 2, homeY: cy, homeRadius: Math.max(this.map.width, this.map.height) };
        n.def = { ...def, aggroRange: Math.max(def.aggroRange, this.map.width) };
      }
    }
  }

  protected override onNpcKilled(_n: NpcActor): void {
    // wave progression handled in onTickExtra
  }

  protected async completeRun(): Promise<void> {
    const g = this.gate;
    if (!g || this.completed) return;
    this.completed = true;
    this.state.match.phase = "ENDED";
    const m = this.mult();
    const scores = [...this.players.values()].map((p) => ({ entityId: p.id, name: p.name, kills: p.kills, deaths: p.deaths, score: Math.round(p.damageDealt) }));
    for (const p of this.players.values()) {
      // One player's failure must not block the others, finishMatch or lock().
      try {
        p.pending.gatesCompleted++;
        this.questEvent(p, { type: "COMPLETE_GATE", gateId: g.id, mapId: this.map.id });
        await this.grantBundle(p, g.rewards, m.reward, `gate:${this.roomId}:${p.userId}`, `${g.name} (${this.difficulty}) cleared`, this.completionSource());
      } catch (e) {
        this.log.error({ err: e, userId: p.userId }, "gate reward failed");
      }
    }
    try {
      const matchId = await this.ensureMatch();
      await this.svc.persistence.finishMatch(matchId, 0, [...this.players.values()].map((p) => ({ userId: p.userId, kills: p.kills, deaths: p.deaths, damage: p.damageDealt, score: Math.round(p.damageDealt), ratingDelta: 0, won: true, left: false })), { gate: g.id, difficulty: this.difficulty });
    } catch (e) {
      this.log.error({ err: e }, "finishMatch failed");
    }
    this.broadcast(ServerEvent.MATCH_END, { matchId: this.matchId ?? this.roomId, winnerTeam: 0, scores });
    await this.lock();
  }

  protected completionSource(): RewardSource {
    return "GATE";
  }
}

/**
 * Raid instance: map spawns (raid boss + adds) scaled for 4/8/16/25 pilots; completes when the raid boss dies.
 *
 * Anti-exploit (a solo pilot must not farm a small, weakened raid for full rewards):
 * - daily entry limit per pilot (`game.rules.raidDailyEntries`, counted from GameMatchPlayer rows of RAID matches);
 * - rewards require at least `ceil(raidSize × raidMinPilotsFraction)` distinct QUALIFIED contributors (damage share
 *   ≥ `bossMinContribution`, so low-damage alts do not count), and are scaled by `min(1, qualified / raidSize)`
 *   (XP/credits/loot/crypto weight). Admission is enforced server-side.
 */
export class RaidRoom extends GateRoom {
  override readonly roomKind: RoomName = RoomName.RAID;
  private raidSize = 8;

  protected override matchMode(): string {
    return MatchMode.RAID;
  }
  protected override bossRewardSource(): RewardSource {
    return "RAID";
  }
  protected override completionSource(): RewardSource {
    return "RAID";
  }
  protected override matchMetadata(): Record<string, unknown> {
    return { size: this.raidSize };
  }

  minPilots(): number {
    return Math.max(1, Math.ceil(this.raidSize * this.rules.raidMinPilotsFraction));
  }

  /** Reward scale for the raid boss based on how many pilots actually fought it. */
  protected override rewardScale(n: NpcActor, contributors: number): number {
    if (n.tag !== "raidboss") return 1;
    return raidRewardScale(contributors, this.raidSize, this.minPilots());
  }

  protected override setupWorld(): void {
    const raw = String(this.options.difficulty ?? "8").replace(/\D/g, "");
    const size = [4, 8, 16, 25].includes(Number(raw)) ? Number(raw) : 8;
    this.raidSize = size;
    this.maxClients = Math.min(this.maxClients, size);
    this.state.match.mode = MatchMode.RAID;
    this.state.match.difficulty = `R${size}`;
    this.state.match.phase = "RUNNING";
    const hullMult = size / 8;
    this.map.spawns.forEach((s, i) => {
      const def = NPCS_BY_ID.get(s.npcId);
      if (!def) return;
      for (let k = 0; k < s.count; k++) {
        const a = this.rng() * Math.PI * 2;
        const r = Math.sqrt(this.rng()) * s.radius;
        this.spawnNpc(def, s.x + Math.cos(a) * r, s.y + Math.sin(a) * r, { spawnIndex: def.kind === "BOSS" ? null : i, homeRadius: s.radius, hullMult: Math.max(0.5, hullMult), tag: def.kind === "BOSS" ? "raidboss" : "" });
      }
    });
    this.spawnAsteroids();
  }

  protected override async beforePlayerJoin(p: PlayerActor): Promise<void> {
    if (this.completed) throw new ServerError(4403, "RAID_COMPLETED");
    if (p.level < this.map.levelRange[0]) throw new ServerError(4403, "LEVEL_TOO_LOW");
    if (this.participants.has(p.userId)) return; // re-join of the same instance
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    // Cheap fast-path rejection (no match row is created for a capped pilot); NOT the authoritative check.
    const entries = await this.svc.db.gameMatchPlayer.count({ where: { userId: p.userId, joinedAt: { gte: dayStart }, match: { mode: MatchMode.RAID } } });
    if (entries >= this.rules.raidDailyEntries) throw new ServerError(4403, "RAID_DAILY_LIMIT");
    this.participants.add(p.userId);
    // Authoritative: count + entry-row insert in one transaction under a user-row lock, so concurrent joins
    // to different raid instances/processes cannot exceed the limit. Recorded before admission, so leaving
    // early does not refund the entry.
    let admitted: boolean;
    try {
      const id = await this.ensureMatch();
      admitted = await this.svc.persistence.claimDailyMatchEntry(id, p.userId, MatchMode.RAID, dayStart, this.rules.raidDailyEntries);
    } catch (e) {
      this.participants.delete(p.userId);
      throw e;
    }
    if (!admitted) {
      this.participants.delete(p.userId);
      throw new ServerError(4403, "RAID_DAILY_LIMIT");
    }
  }

  protected override onPlayerJoined(): void {
    // enrollment already happened in beforePlayerJoin
  }

  protected override onTickExtra(): void {
    // Raids complete on boss death (see onBossKilled).
  }

  protected override async onBossKilled(n: NpcActor, contributors: { p: PlayerActor; dmg: number }[]): Promise<void> {
    if (n.tag !== "raidboss" || this.completed) return;
    this.completed = true;
    this.state.match.phase = "ENDED";
    // Only qualified contributors (share ≥ bossMinContribution) count toward scale and crypto weight; the full
    // `contributors` list is still used for match accounting below.
    const { qualified, totalDmg: total } = qualifyContributors(contributors, this.rules.bossMinContribution);
    const scale = this.rewardScale(n, qualified.length);
    if (scale <= 0) {
      this.broadcast(ServerEvent.NOTICE, { level: "warn", text: `Raid rewards require at least ${this.minPilots()} pilots` });
    }
    for (const c of qualified) {
      const share = total > 0 ? c.dmg / total : 0;
      this.questEvent(c.p, { type: "KILL", npcId: n.def.id, boss: true, mapId: this.map.id });
      if (scale > 0) {
        void this.crypto(c.p, "RAID", `raid:${this.roomId}:${c.p.userId}`, raidCryptoWeight(share, qualified.length, scale), `${n.name} defeated (raid ${this.raidSize})`, this.matchId ?? undefined);
      }
    }
    try {
      const matchId = await this.ensureMatch();
      await this.svc.persistence.finishMatch(matchId, 0, contributors.map((c) => ({ userId: c.p.userId, kills: c.p.kills, deaths: c.p.deaths, damage: c.dmg, score: Math.round(c.dmg), ratingDelta: 0, won: true, left: false })), { boss: n.def.id, size: this.raidSize, rewardScale: scale });
    } catch (e) {
      this.log.error({ err: e }, "finishMatch failed");
    }
    this.broadcast(ServerEvent.MATCH_END, { matchId: this.matchId ?? this.roomId, winnerTeam: 0, scores: contributors.map((c) => ({ entityId: c.p.id, name: c.p.name, kills: c.p.kills, deaths: c.p.deaths, score: Math.round(c.dmg) })) });
  }
}
