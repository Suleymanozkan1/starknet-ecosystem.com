/**
 * Instanced gate run (gates.json): waves 1, 2, 3, Elite, Mini Boss, Final
 * Boss with NORMAL/HARD/NIGHTMARE/MYTHIC difficulty multipliers, entry cost
 * (credits via ledger sink + resources), completion rewards and crypto
 * eligibility (source GATE). RaidRoom extends this for 4/8/16/25-pilot raids.
 */
import { GATES, NPCS_BY_ID } from "@nebula/config";
import { GateDifficulty, MatchMode, RoomName, ServerEvent, type GateDef, type RewardSource } from "@nebula/shared";
import { ServerError } from "@colyseus/core";
import { BaseGameRoom } from "./BaseGameRoom.js";
import type { NpcActor, PlayerActor } from "./actors.js";

export class GateRoom extends BaseGameRoom {
  readonly roomKind: RoomName = RoomName.GATE;
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
    // Entry cost, charged once per instance (re-joining the same instance is free; idempotent key).
    if (this.participants.has(p.userId)) return;
    const credits = g.entryCost.credits ?? 0;
    const resources = g.entryCost.resources ?? {};
    const key = `gate_entry:${this.roomId}:${p.userId}`;
    try {
      await this.svc.db.$transaction(async (tx) => {
        const paid = await tx.balanceLedger.findUnique({ where: { idempotencyKey: key }, select: { id: true } });
        if (paid) return;
        await this.svc.persistence.chargeCredits(p.userId, credits, key, `gate_entry:${g.id}`, false, tx);
        await this.svc.persistence.spendResources(tx, p.userId, resources);
      });
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("INSUFFICIENT")) throw new ServerError(4402, msg.startsWith("INSUFFICIENT_RESOURCE") ? msg : "INSUFFICIENT_CREDITS");
      throw e;
    }
    this.participants.add(p.userId);
  }

  protected override onPlayerJoined(): void {
    if (this.wave < 0 && !this.completed) {
      this.wave = 0;
      this.nextWaveAt = this.now + this.rules.gateWaveDelayMs;
      this.state.match.phase = "RUNNING";
      if (!this.matchId) {
        void this.svc.persistence.createMatch({ roomId: this.roomId, mode: MatchMode.GATE, mapId: this.map.id, metadata: { gate: this.gate?.id, difficulty: this.difficulty } })
          .then((id) => {
            this.matchId = id;
            this.state.match.matchId = id;
            this.broadcast(ServerEvent.MATCH_START, { matchId: id, mode: MatchMode.GATE });
            for (const p of this.players.values()) void this.svc.persistence.joinMatch(id, p.userId, 0);
          })
          .catch((e: unknown) => this.log.error({ err: e }, "createMatch failed"));
      }
    } else if (this.matchId) {
      for (const p of this.players.values()) void this.svc.persistence.joinMatch(this.matchId, p.userId, 0);
    }
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
      if (this.wave >= g.waves.length - 1) void this.completeRun();
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
      p.pending.gatesCompleted++;
      this.questEvent(p, { type: "COMPLETE_GATE", gateId: g.id, mapId: this.map.id });
      await this.grantBundle(p, g.rewards, m.reward, `gate:${this.roomId}:${p.userId}`, `${g.name} (${this.difficulty}) cleared`, this.completionSource());
    }
    if (this.matchId) {
      await this.svc.persistence.finishMatch(this.matchId, 0, [...this.players.values()].map((p) => ({ userId: p.userId, kills: p.kills, deaths: p.deaths, damage: p.damageDealt, score: Math.round(p.damageDealt), ratingDelta: 0, won: true, left: false })), { gate: g.id, difficulty: this.difficulty })
        .catch((e: unknown) => this.log.error({ err: e }, "finishMatch failed"));
    }
    this.broadcast(ServerEvent.MATCH_END, { matchId: this.matchId ?? this.roomId, winnerTeam: 0, scores });
    await this.lock();
  }

  protected completionSource(): RewardSource {
    return "GATE";
  }
}

/** Raid instance: map spawns (raid boss + adds) scaled for 4/8/16/25 pilots; completes when the raid boss dies. */
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
    this.participants.add(p.userId);
  }

  protected override onPlayerJoined(): void {
    if (!this.matchId) {
      this.matchId = "pending";
      void this.svc.persistence.createMatch({ roomId: this.roomId, mode: MatchMode.RAID, mapId: this.map.id, metadata: { size: this.raidSize } })
        .then((id) => {
          this.matchId = id;
          this.state.match.matchId = id;
          this.broadcast(ServerEvent.MATCH_START, { matchId: id, mode: MatchMode.RAID });
        })
        .catch((e: unknown) => this.log.error({ err: e }, "createMatch failed"));
    }
  }

  protected override onTickExtra(): void {
    // Raids complete on boss death (see onBossKilled).
  }

  protected override async onBossKilled(n: NpcActor, contributors: { p: PlayerActor; dmg: number }[]): Promise<void> {
    if (n.tag !== "raidboss" || this.completed) return;
    this.completed = true;
    this.state.match.phase = "ENDED";
    const total = contributors.reduce((s, c) => s + c.dmg, 0);
    for (const c of contributors) {
      const share = total > 0 ? c.dmg / total : 0;
      if (share < this.rules.bossMinContribution) continue;
      this.questEvent(c.p, { type: "KILL", npcId: n.def.id, boss: true, mapId: this.map.id });
      void this.crypto(c.p, "RAID", `raid:${this.roomId}:${c.p.userId}`, Math.max(0.2, Math.min(3, share * contributors.length)), `${n.name} defeated (raid ${this.raidSize})`, this.matchId ?? undefined);
    }
    if (this.matchId && this.matchId !== "pending") {
      await this.svc.persistence.finishMatch(this.matchId, 0, contributors.map((c) => ({ userId: c.p.userId, kills: c.p.kills, deaths: c.p.deaths, damage: c.dmg, score: Math.round(c.dmg), ratingDelta: 0, won: true, left: false })), { boss: n.def.id, size: this.raidSize })
        .catch((e: unknown) => this.log.error({ err: e }, "finishMatch failed"));
    }
    this.broadcast(ServerEvent.MATCH_END, { matchId: this.matchId ?? this.roomId, winnerTeam: 0, scores: contributors.map((c) => ({ entityId: c.p.id, name: c.p.name, kills: c.p.kills, deaths: c.p.deaths, score: Math.round(c.dmg) })) });
  }
}
