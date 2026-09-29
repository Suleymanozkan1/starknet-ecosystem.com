/**
 * Shared authoritative simulation for every in-world room type (sector, PvP,
 * arena, boss, gate, raid, clan war, event). Subclasses only add rules
 * (match lifecycle, waves, boss contribution…) through the protected hooks.
 *
 * Patterns adapted from the reference repos:
 * - tutorial-phaser: per-player input queue drained in a fixed tick, `lastSeq` ack.
 * - tosios: pure shared movement (`@nebula/game-core` stepShip) + message whitelist.
 * - colyseus 0.18: setFixedTimestep, StateView interest management, zod-validated messages.
 */
import { randomInt, randomUUID } from "node:crypto";
import { CloseCode, Room, ServerError, matchMaker, type Client } from "@colyseus/core";
import { StateView } from "@colyseus/schema";
import {
  EVENTS, ITEM_AFFIXES, ITEMS_BY_ID, LOOT_TABLES_BY_ID, MAPS_BY_ID, NPCS_BY_ID, PROGRESSION, itemIdForDef, itemIdForResource,
} from "@nebula/config";
import { grantCryptoReward } from "@nebula/economy";
import {
  CooldownViolationTracker, FireRateAuditor, IDLE_INPUT, MovementBudget, PacketRateLimiter, ReactionTimeDetector,
  RepeatedMovementDetector, SeqValidator, SpatialGrid, TokenBucket, activateAbility, applyDash, applyEmp, bossTick, breakCloak,
  buffModifiers, checkDisplacement, computeStats, coolHeat, createAbilityState, createBrain, deathRepairCost, grantXp,
  isDamageImpossible, isPvpAllowedAt, isSafeAt, isWeakPointHit, maxShotDamage, mineStep, nearestPortal, npcStats,
  pickAsteroidResource, pruneBuffs, regenerate, resetBoss, resolveAreaDamage, resolveHit, resourceHardness, rollAffixes, rollLoot,
  spawnPoint, stationInRange, stepNpcBrain, stepShip, tryFire, applyQuestEvent, repairCost, isAffixable,
  clampKarma, decayKarma, hasPetAbility, isOutlaw, petBuff, petLevelForXp, petScale, petXpToNext, reputationFor, toMoney,
  type AbilitySlotDef, type EffectiveWeapon, type GameplayEvent, type HitResult, type LootDrop, type Rng, type SimTuning,
} from "@nebula/game-core";
import {
  EntityFlag, RARITY_ORDER, RoomName, ServerEvent, mulberry32, type AbilityEffect, type ChatEvent, type DamageElement, type EntityKind,
  type EventDef, type MapDef, type NpcDef, type Rarity, type ResourceId, type RewardBundle, type RewardSource, type SelfJoinInfo, type ServerEvents, type CheatType,
} from "@nebula/shared";
import { activePlayers, activeRooms, errorsTotal, packetsDropped, packetsReceived, tickDuration, type Logger } from "@nebula/telemetry";
import { JoinOptionsSchema, Schemas, sanitizeChat, type ParsedJoinOptions, type ParsedMessages } from "../protocol/messages.js";
import { Entity, MatchInfo, WorldState } from "../schema/state.js";
import { getServices, type GameServices } from "../services/context.js";
import { EventEngine, type ActiveEvent } from "../services/events.js";
import { loadRules, DEFAULT_RULES, type GameRules } from "../services/rules.js";
import { TicketError } from "../services/tickets.js";
import { JoinError, loadActiveQuests, loadPlayer } from "../persistence/player.js";
import { qualifyContributors } from "./contribution.js";
import { DuplicateLootError, PendingDelta, type FlushContext, type FlushResult } from "../persistence/writer.js";
import { activeSeasonId, bossEventId } from "../persistence/catalog.js";
import type { ActorBase, AsteroidActor, LootActor, NpcActor, ParsedInput, PetActor, PlayerActor, ShipActor } from "./actors.js";

export interface AuthData {
  userId: string;
  username: string;
  mapId: string;
  options: ParsedJoinOptions;
}

export interface RoomMeta {
  mapId: string;
  roomKind: string;
  region: string;
  maxPlayers: number;
  instanceKey?: string;
  difficulty?: string;
}

type Msg = keyof typeof Schemas;

/** Temporary EVENT_GATE portal opened by a GLOBAL_RIFT event. */
export interface RiftPortal {
  id: string;
  x: number;
  y: number;
  eventId: string;
  windowStart: number;
  expiresAt: number;
  targetMap: string;
  entity: Entity;
}
type GridItem = { id: string; x: number; y: number; ref: PlayerActor | NpcActor | LootActor | AsteroidActor | PetActor };

const ROOM_FOR_MAP_TYPE: Record<MapDef["roomType"], RoomName> = {
  sector: RoomName.SECTOR, pvp: RoomName.PVP, boss: RoomName.BOSS, gate: RoomName.GATE, raid: RoomName.RAID,
  arena: RoomName.ARENA, clanwar: RoomName.CLAN_WAR, event: RoomName.EVENT,
};

export const CHAT_TOPIC_GLOBAL = "nf:chat:global";
const PRESENCE_TTL_SEC = 60;
const PRESENCE_REFRESH_MS = 20_000;
/** Prune stale PvP anti-farming pair entries every N simulation ticks. */
const PVP_KILL_LOG_PRUNE_TICKS = 200;
const chatTopicFaction = (f: string) => `nf:chat:faction:${f}`;
const chatTopicClan = (c: string) => `nf:chat:clan:${c}`;

export abstract class BaseGameRoom extends Room<{ state: WorldState; metadata: RoomMeta }> {
  override state = new WorldState();

  /** Human-readable kind for metrics/state (`sector`, `pvp`…). */
  abstract readonly roomKind: RoomName;

  protected svc!: GameServices;
  protected log!: Logger;
  protected rules: GameRules = DEFAULT_RULES;
  protected tuning!: SimTuning;
  protected map!: MapDef;
  protected rng: Rng = Math.random;
  protected now = Date.now();
  protected tickCount = 0;
  protected options!: ParsedJoinOptions & { mapId: string };

  protected players = new Map<string, PlayerActor>();
  protected npcs = new Map<string, NpcActor>();
  protected loot = new Map<string, LootActor>();
  protected asteroids = new Map<string, AsteroidActor>();
  protected grid = new SpatialGrid<GridItem>(50);
  private gridItems: GridItem[] = [];
  private npcSeq = 0;
  private chatBuffer: { channel: string; channelKey: string; senderId: string; text: string }[] = [];
  private eventListeners: { started: (a: ActiveEvent) => void; finished: (a: ActiveEvent) => void } | null = null;
  private presenceSubs: { topic: string; cb: (d: unknown) => void }[] = [];
  private pvpKillLog = new Map<string, number>();
  private processedLoot = new Set<string>();
  protected xpMultiplier = 1;
  protected dropMultiplier = 1;
  protected riftBossIds = new Set<string>();
  protected riftPortals = new Map<string, RiftPortal>();

  // ------------------------------------------------------------------------
  // Hooks for subclasses
  // ------------------------------------------------------------------------

  /** Whether the ticket's mapId must match this room's map (true for open-world sectors). */
  protected requireTicketMap(): boolean {
    return false;
  }
  /** Normalize PvP stats (arena/pvp/clan war). */
  protected pvpNormalized(): boolean {
    return false;
  }
  /** Populate NPCs/asteroids. Default: map spawns + asteroid fields. */
  protected setupWorld(): void {
    this.map.spawns.forEach((s, i) => {
      for (let k = 0; k < s.count; k++) {
        const def = NPCS_BY_ID.get(s.npcId);
        if (!def) continue;
        const a = this.rng() * Math.PI * 2;
        const r = Math.sqrt(this.rng()) * s.radius;
        this.spawnNpc(def, s.x + Math.cos(a) * r, s.y + Math.sin(a) * r, { spawnIndex: i, homeRadius: s.radius });
      }
    });
    this.spawnAsteroids();
  }
  protected teamFor(_p: PlayerActor): number {
    return 0;
  }
  protected spawnPointFor(p: PlayerActor, portalId: string | null): { x: number; y: number } {
    if (portalId) return spawnPoint(this.map, p.profile.factionId, portalId);
    const pr = p.profile;
    if (pr.lastMapId === this.map.id && pr.lastX !== null && pr.lastY !== null && pr.lastX >= 0 && pr.lastY >= 0 && pr.lastX <= this.map.width && pr.lastY <= this.map.height) {
      return { x: pr.lastX, y: pr.lastY };
    }
    return spawnPoint(this.map, pr.factionId);
  }
  protected respawnPointFor(p: PlayerActor): { x: number; y: number } {
    return spawnPoint(this.map, p.profile.factionId);
  }
  /**
   * Where the player is persisted when leaving. Open-world rooms keep the
   * current position; instanced rooms (gates, raids, matches, events) send the
   * player back through the map's exit portal so the next login lands in a sector.
   */
  protected exitPosition(p: PlayerActor): { mapId: string; x: number; y: number } {
    const open = this.roomKind === RoomName.SECTOR || this.roomKind === RoomName.BOSS;
    if (!open) {
      const exit = this.map.portals[0];
      const target = exit ? MAPS_BY_ID.get(exit.targetMap) : undefined;
      const tp = target?.portals.find((x) => x.id === exit?.targetPortal);
      if (target && tp) return { mapId: target.id, x: tp.x, y: tp.y };
    }
    const pos = p.dead ? this.respawnPointFor(p) : { x: p.x, y: p.y };
    return { mapId: this.map.id, x: pos.x, y: pos.y };
  }
  /** Extra join validation (level requirement, entry costs). Throw JoinError to reject. */
  protected async beforePlayerJoin(_p: PlayerActor): Promise<void> {
    // default: none
  }
  protected onPlayerJoined(_p: PlayerActor): void {}
  protected onPlayerRemoved(_p: PlayerActor): void {}
  protected onTickExtra(_dt: number): void {}
  /** Called after an NPC dies and default rewards are applied. */
  protected onNpcKilled(_npc: NpcActor, _credited: PlayerActor | null): void {}
  protected onPlayerKilled(_victim: PlayerActor, _killer: ShipActor | null): void {}
  /** Multiplier applied to NPC kill rewards (XP/credits/loot); 0 disables them. */
  protected rewardScale(_npc: NpcActor, _contributors: number): number {
    return 1;
  }
  /** Whether NPC kills use contribution sharing (bosses always do). */
  protected shareRewards(npc: NpcActor): boolean {
    return npc.def.kind === "BOSS";
  }
  /**
   * Player-vs-player hostility ("enemies": auto-targeting, area damage, war kills).
   * Open world: different faction + PvP allowed at both positions, or the target is an OUTLAW.
   */
  protected playersHostile(a: PlayerActor, b: PlayerActor): boolean {
    if (a.userId === b.userId) return false;
    if (a.profile.clanId && a.profile.clanId === b.profile.clanId) return false;
    if (this.outlawTargetable(b)) return true;
    return this.warHostile(a, b);
  }
  /** Faction war: different factions, both inside PvP-enabled space. */
  protected warHostile(a: PlayerActor, b: PlayerActor): boolean {
    if (!a.profile.factionId || a.profile.factionId === b.profile.factionId) return false;
    return isPvpAllowedAt(this.map, a.x, a.y) && isPvpAllowedAt(this.map, b.x, b.y);
  }
  /** Outlaws are attackable by anyone; per rule they also lose safe-zone protection. */
  protected outlawTargetable(b: PlayerActor): boolean {
    const cfg = PROGRESSION.reputation;
    if (!cfg || !isOutlaw(b.karma, cfg)) return false;
    return cfg.outlawLosesSafeZone || !isSafeAt(this.map, b.x, b.y);
  }
  /**
   * Whether `a` may deliberately attack `b` (explicit target). Superset of hostility: in PvP
   * space a pilot may also attack a same-faction, non-clan pilot — an unprovoked attack that
   * costs karma (see onPlayerHitPlayer). Team rooms use strict team hostility.
   */
  protected playersAttackable(a: PlayerActor, b: PlayerActor): boolean {
    if (this.isTeamRoom()) return this.playersHostile(a, b);
    if (this.playersHostile(a, b)) return true;
    if (a.userId === b.userId || (a.profile.clanId && a.profile.clanId === b.profile.clanId)) return false;
    return isPvpAllowedAt(this.map, a.x, a.y) && isPvpAllowedAt(this.map, b.x, b.y);
  }
  /** Match id for PvP reward refs (match rooms override). */
  protected currentMatchId(): string | null {
    return null;
  }
  protected matchMode(): string | undefined {
    return undefined;
  }

  // ------------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------------

  override async onCreate(rawOptions: Record<string, unknown>): Promise<void> {
    this.svc = getServices();
    this.log = this.svc.log.child({ room: this.roomKind, roomId: this.roomId });
    const mapId = String(rawOptions.mapId ?? "");
    const map = MAPS_BY_ID.get(mapId);
    if (!map) throw new ServerError(4404, `Unknown map ${mapId}`);
    this.map = map;
    this.options = { ...(JoinOptionsSchema.partial().parse(rawOptions) as ParsedJoinOptions), mapId };
    const { rules, tuning } = await loadRules(this.svc.db, this.log);
    this.rules = rules;
    this.tuning = tuning;
    this.rng = mulberry32(this.svc.rngSeed ?? randomInt(0, 2 ** 31));
    this.maxClients = Math.min(map.maxPlayers, this.svc.config.maxPlayersPerRoom);
    this.grid = new SpatialGrid<GridItem>(Math.max(20, this.svc.config.aoiRadius / 2));
    this.patchRate = this.svc.config.patchRateMs;
    this.autoDispose = true;
    this.metadata = { mapId, roomKind: this.roomKind, region: this.svc.config.region, maxPlayers: this.maxClients, instanceKey: this.options.instanceKey, difficulty: this.options.difficulty };

    this.state.mapId = mapId;
    this.state.roomKind = this.roomKind;
    this.state.region = this.svc.config.region;
    this.state.match = new MatchInfo();
    this.state.match.phase = "OPEN";
    this.state.xpMultiplier = 1;
    this.state.dropMultiplier = 1;

    this.registerMessages();
    this.setupWorld();
    this.attachEvents();
    await this.subscribeChat();

    this.setFixedTimestep((ctx) => this.fixedTick(ctx.dtMs), this.svc.config.tickRate);
    this.clock.setInterval(() => {
      void this.flushAll(false);
      void this.heartbeat(false);
    }, this.svc.config.flushIntervalMs);
    void this.heartbeat(false);
    // Online presence for the API (friends list): refresh `presence:<userId>` while connected.
    this.clock.setInterval(() => {
      for (const p of this.players.values()) if (p.connected) void this.setPresence(p);
    }, PRESENCE_REFRESH_MS);
    activeRooms.inc({ room: this.roomKind });
    this.log.info({ mapId, maxClients: this.maxClients }, "room created");
  }

  override async onAuth(_client: Client, rawOptions: unknown): Promise<AuthData> {
    const parsed = JoinOptionsSchema.safeParse(rawOptions);
    if (!parsed.success) throw new ServerError(4400, "Invalid join options");
    try {
      const claims = await this.svc.tickets.verifyAndConsume(parsed.data.ticket);
      if (this.requireTicketMap() && claims.mapId !== this.map.id) {
        throw new TicketError("TICKET_MAP_MISMATCH", `Ticket authorises ${claims.mapId}, not ${this.map.id}`);
      }
      return { userId: claims.sub, username: claims.username, mapId: claims.mapId, options: parsed.data };
    } catch (e) {
      if (e instanceof TicketError) {
        this.log.warn({ code: e.code }, "join rejected");
        throw new ServerError(4401, e.code);
      }
      throw e;
    }
  }

  override async onJoin(client: Client, _options: unknown, auth?: AuthData): Promise<void> {
    const a = auth ?? (client.auth as AuthData | undefined);
    if (!a) throw new ServerError(4401, "Unauthenticated");
    // One seat per user per room: drop an older session of the same user.
    for (const other of this.players.values()) {
      if (other.userId === a.userId && other.sessionId !== client.sessionId) {
        other.client.leave(CloseCode.CONSENTED, "DUPLICATE_SESSION");
      }
    }
    let profile;
    try {
      profile = await loadPlayer(this.svc.db, a.userId, this.map.id);
    } catch (e) {
      if (e instanceof JoinError) throw new ServerError(4403, e.code);
      throw e;
    }
    if (profile.level < this.map.levelRange[0] && this.roomKind !== RoomName.SECTOR) {
      throw new ServerError(4403, "LEVEL_TOO_LOW");
    }
    const p = this.createPlayer(client, profile);
    await this.beforePlayerJoin(p);
    p.team = this.teamFor(p);
    const pos = this.spawnPointFor(p, a.options.portalId ?? null);
    p.x = pos.x;
    p.y = pos.y;
    p.invulnerableUntil = this.now + this.rules.spawnProtectionMs;
    this.players.set(client.sessionId, p);
    this.state.entities.set(p.id, p.entity);
    client.view = new StateView();
    client.view.add(p.entity);
    p.visible.add(p.id);
    this.syncEntity(p);
    this.spawnPet(p);
    this.updateAoiFor(p);

    p.pending.mapsVisited.add(this.map.id);
    this.questEvent(p, { type: "TRAVEL", mapId: this.map.id });
    this.questEvent(p, { type: "LEVEL", level: p.level });
    this.emitTo(client, ServerEvent.PLAYER_JOIN, { entityId: p.id, name: p.name, self: this.selfInfo(p) });
    this.emitReputation(p, "join");
    if (p.pet) this.emitPet(p, undefined);
    this.sendNear(p.x, p.y, ServerEvent.PLAYER_JOIN, { entityId: p.id, name: p.name }, p);
    for (const ae of this.svc.events.allActive()) {
      if (ae.def.maps.includes(this.map.id) || ae.def.type === "GLOBAL_RIFT") this.emitTo(client, ServerEvent.EVENT_STARTED, EventEngine.notice(ae));
    }
    this.state.online = this.players.size;
    activePlayers.set({ room: this.roomKind, map: this.map.id }, this.players.size);
    void this.setMatchmaking({ metadata: { ...this.metadata } }).catch(() => undefined);
    this.onPlayerJoined(p);
    void this.setPresence(p);
    this.log.info({ userId: p.userId, entityId: p.id }, "player joined");
  }

  override async onLeave(client: Client, code?: number): Promise<void> {
    const p = this.players.get(client.sessionId);
    if (!p) return;
    p.connected = false;
    p.firing.PRIMARY = false;
    p.firing.SECONDARY = false;
    p.inputQueue.length = 0;
    const consented = code === CloseCode.CONSENTED || code === CloseCode.NORMAL_CLOSURE || code === CloseCode.SERVER_SHUTDOWN;
    if (!consented && this.rules.reconnectSeconds > 0 && !this.isLocked()) {
      try {
        const next = await this.allowReconnection(client, this.rules.reconnectSeconds);
        p.client = next;
        p.connected = true;
        next.view = new StateView();
        p.visible.clear();
        next.view.add(p.entity);
        p.visible.add(p.id);
        this.updateAoiFor(p);
        return;
      } catch {
        // reconnection window elapsed
      }
    }
    await this.removePlayer(p);
  }

  private isLocked(): boolean {
    return this.locked;
  }

  override async onDispose(): Promise<void> {
    for (const p of [...this.players.values()]) await this.removePlayer(p);
    // Give failed final flushes (e.g. this room's last leaver) an immediate retry; survivors stay queued.
    await this.svc.flushRetry.drain();
    await this.flushChat();
    if (this.eventListeners) {
      this.svc.events.off("started", this.eventListeners.started);
      this.svc.events.off("finished", this.eventListeners.finished);
    }
    for (const s of this.presenceSubs) this.presence.unsubscribe(s.topic, s.cb);
    await this.heartbeat(true);
    activeRooms.dec({ room: this.roomKind });
    activePlayers.set({ room: this.roomKind, map: this.map?.id ?? "" }, 0);
    this.log.info("room disposed");
  }

  override onBeforeShutdown(): void {
    // Persist everything before clients are disconnected (graceful shutdown).
    void this.flushAll(true).then(() => this.svc.flushRetry.drain()).finally(() => {
      void this.disconnect(CloseCode.SERVER_SHUTDOWN).catch(() => undefined);
    });
  }

  override onUncaughtException(err: Error, methodName: string): void {
    // Rejected joins (bad/replayed ticket, level, entry cost) surface here too: expected, not errors.
    if ((methodName === "onAuth" || methodName === "onJoin") && (err instanceof ServerError || err.cause instanceof ServerError)) {
      this.log.info({ reason: err.message, methodName }, "join rejected");
      return;
    }
    errorsTotal.inc({ component: "room", code: methodName });
    this.log.error({ err, methodName }, "uncaught room exception");
  }

  /** `presence:<userId>` = mapId (TTL 60s, refreshed every 20s) — read by the API for online status. */
  private async setPresence(p: PlayerActor): Promise<void> {
    if (!this.svc.redis) return;
    try {
      await this.svc.redis.set(`presence:${p.userId}`, this.map.id, "EX", PRESENCE_TTL_SEC);
    } catch (e) {
      this.log.debug({ err: e }, "presence set failed");
    }
  }

  /** Delete presence only if it still points at this map (a portal jump may already have set the new map). */
  private async clearPresence(p: PlayerActor): Promise<void> {
    if (!this.svc.redis) return;
    try {
      await this.svc.redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0", 1, `presence:${p.userId}`, this.map.id);
    } catch (e) {
      this.log.debug({ err: e }, "presence clear failed");
    }
  }

  /** Room registry row (GameRoom) for admin/ops dashboards; never used for game state. */
  private async heartbeat(disposed: boolean): Promise<void> {
    try {
      const data = {
        roomName: this.roomKind, mapId: this.map.id, region: this.svc.config.region, processId: String(process.pid),
        clients: this.players.size, maxClients: this.maxClients, heartbeatAt: new Date(), disposedAt: disposed ? new Date() : null,
      };
      await this.svc.db.gameRoom.upsert({ where: { id: this.roomId }, create: { id: this.roomId, ...data }, update: data });
    } catch (e) {
      this.log.debug({ err: e }, "room heartbeat failed");
    }
  }

  // ------------------------------------------------------------------------
  // Player lifecycle helpers
  // ------------------------------------------------------------------------

  private createPlayer(client: Client, profile: Awaited<ReturnType<typeof loadPlayer>>): PlayerActor {
    const stats = computeStats({ ...profile.loadout, pvpNormalized: this.pvpNormalized() }, this.tuning);
    const now = this.now;
    const entity = new Entity();
    const p: PlayerActor = {
      id: client.sessionId, kind: "PLAYER", name: profile.username, defId: profile.shipDefId,
      x: 0, y: 0, vx: 0, vy: 0, heading: 0,
      hull: stats.hull, shield: stats.shield, energy: stats.energy, maxHull: stats.hull, maxShield: stats.shield, maxEnergy: stats.energy,
      level: profile.level, faction: profile.factionId ?? "", clanTag: profile.clanTag, team: 0, targetId: "", dead: false, flags: 0, cloaked: false,
      entity, stats, weaponRt: new Map(), heat: { heat: 0, overheated: false }, abilities: createAbilityState(), stunnedUntil: 0,
      shieldDisruptedUntil: 0, lastDamagedAt: 0, invulnerableUntil: 0, damageBy: new Map(), lastHitBy: new Map(), pulseFlags: 0,
      sessionId: client.sessionId, client, profile, userId: profile.userId, xp: profile.xp, honor: profile.honor,
      inputQueue: [], lastInput: { ...IDLE_INPUT }, lastInputAt: 0, lastSeq: 0, seq: new SeqValidator(),
      budget: new MovementBudget(this.svc.config.tickRate, now),
      packets: new PacketRateLimiter(this.rules.packetRatePerSec, this.rules.packetBurst, now),
      chat: new TokenBucket(this.rules.chatRatePerSec, this.rules.chatBurst, now),
      cooldownTracker: new CooldownViolationTracker(), fireAudit: new FireRateAuditor(), repeated: new RepeatedMovementDetector(),
      reaction: new ReactionTimeDetector(), spamStrikes: 0, firing: { PRIMARY: false, SECONDARY: false }, docked: null, miningTarget: null,
      cargoUsed: 0, visible: new Set(), firstSeen: new Map(), pending: new PendingDelta(), flushing: false, flushRequested: false,
      deathCount: 0, respawnAt: 0, lastRepairCost: 0, joinedAt: now, lastPlaytimeAt: now, lastSurviveAt: now, formation: profile.formation,
      cosmetics: profile.cosmetics, kills: 0, deaths: 0, score: 0, damageDealt: 0, connected: true, left: false, jumpedTo: null,
      karma: profile.karma,
      reputation: PROGRESSION.reputation ? reputationFor(profile.karma, profile.hasBounty, PROGRESSION.reputation) : profile.reputation,
      hasBounty: profile.hasBounty, unprovokedLog: new Map(), lastKarmaDecayAt: now, pet: null,
    };
    entity.id = p.id;
    entity.kind = "PLAYER";
    entity.name = p.name;
    entity.defId = p.defId;
    entity.cosmetics = p.cosmetics;
    return p;
  }

  protected async removePlayer(p: PlayerActor): Promise<void> {
    if (p.left) return;
    p.left = true;
    this.players.delete(p.sessionId);
    p.pending.position = p.jumpedTo ?? this.exitPosition(p);
    this.accruePlaytime(p);
    this.state.entities.delete(p.id);
    for (const o of this.players.values()) o.visible.delete(p.id);
    if (p.pet) {
      this.state.entities.delete(p.pet.id);
      for (const o of this.players.values()) o.visible.delete(p.pet.id);
    }
    this.sendNear(p.x, p.y, ServerEvent.PLAYER_LEAVE, { entityId: p.id });
    this.svc.risk.drain(p.userId, `game-server:${this.roomKind}`);
    void this.clearPresence(p);
    this.onPlayerRemoved(p);
    this.state.online = this.players.size;
    activePlayers.set({ room: this.roomKind, map: this.map.id }, this.players.size);
    if (!(await this.flushPlayer(p, true))) {
      // The actor is gone from `players`, so flushAll would never retry it: hand the delta to the
      // process-level retry queue (backoff; drained on dispose/shutdown; drops are metered).
      this.svc.flushRetry.enqueue(p.userId, p.pending, p.profile.quests.values(), p.profile.achievements, this.flushContext(p));
      p.pending = new PendingDelta();
    }
    this.log.info({ userId: p.userId }, "player left");
  }

  /** Prediction parameters for the owning client (same numbers the server simulates with). */
  protected selfInfo(p: PlayerActor): SelfJoinInfo {
    return {
      userId: p.userId,
      mapId: this.map.id,
      tickRate: this.svc.config.tickRate,
      aoiRadius: this.svc.config.aoiRadius,
      motion: { speed: p.stats.speed, acceleration: p.stats.acceleration, turnRate: p.stats.turnRate, maxEnergy: p.maxEnergy },
      weapons: p.stats.weapons.map((w) => ({ key: w.key, defId: w.defId, group: w.group, range: w.range, fireRate: w.fireRate })),
      skills: p.stats.skills.map((a, slot) => ({ slot, id: a.id, name: a.name, cooldownMs: a.cooldownMs, energyCost: a.energyCost })),
      modules: p.stats.moduleActives.map((a, slot) => ({ slot, id: a.id, name: a.name, cooldownMs: a.cooldownMs, energyCost: a.energyCost })),
    };
  }

  private accruePlaytime(p: PlayerActor): void {
    const sec = Math.floor((this.now - p.lastPlaytimeAt) / 1000);
    if (sec > 0) {
      p.pending.playtimeSec += sec;
      p.lastPlaytimeAt += sec * 1000;
    }
  }

  // ------------------------------------------------------------------------
  // Messages
  // ------------------------------------------------------------------------

  private registerMessages(): void {
    for (const type of Object.keys(Schemas) as Msg[]) {
      this.onMessage(type, (client: Client, raw: unknown) => this.handleMessage(type, client, raw));
    }
    this.onMessage("*", (client: Client, type: string | number) => {
      packetsDropped.inc({ room: this.roomKind, reason: "unknown_type" });
      const p = this.players.get(client.sessionId);
      if (p) this.rateCheck(p);
      this.log.debug({ type: String(type) }, "unknown message type");
    });
  }

  private rateCheck(p: PlayerActor): boolean {
    const r = p.packets.check(Date.now());
    if (r.spam) {
      p.spamStrikes++;
      this.flag(p, "PACKET_SPAM", 10, { strikes: p.spamStrikes });
      if (p.spamStrikes >= 3) p.client.leave(CloseCode.WITH_ERROR, "PACKET_SPAM");
    }
    if (!r.allowed) packetsDropped.inc({ room: this.roomKind, reason: "rate_limit" });
    return r.allowed;
  }

  private handleMessage(type: Msg, client: Client, raw: unknown): void {
    const p = this.players.get(client.sessionId);
    if (!p || !p.connected) return;
    packetsReceived.inc({ room: this.roomKind, type });
    if (!this.rateCheck(p)) return;
    const parsed = Schemas[type].safeParse(raw ?? {});
    if (!parsed.success) {
      packetsDropped.inc({ room: this.roomKind, reason: "invalid" });
      return;
    }
    const msg = parsed.data as ParsedMessages[typeof type];
    try {
      this.dispatch(type, p, msg);
    } catch (e) {
      errorsTotal.inc({ component: "message", code: type });
      this.log.error({ err: e, type }, "message handler failed");
    }
  }

  private dispatch<K extends Msg>(type: K, p: PlayerActor, m: ParsedMessages[K]): void {
    switch (type) {
      case "input": return this.onInput(p, m as ParsedMessages["input"]);
      case "aim": {
        const a = m as ParsedMessages["aim"];
        if (!p.dead && !p.docked) p.lastInput = { ...p.lastInput, heading: Math.atan2(a.y - p.y, a.x - p.x) };
        return;
      }
      case "fire": {
        const f = m as ParsedMessages["fire"];
        p.firing[f.group] = f.firing && !p.dead && !p.docked;
        return;
      }
      case "target": return this.onTarget(p, m as ParsedMessages["target"]);
      case "skill": return this.onAbility(p, p.stats.skills[(m as ParsedMessages["skill"]).slot]);
      case "module": return this.onAbility(p, p.stats.moduleActives[(m as ParsedMessages["module"]).slot]);
      case "dash": {
        const d = m as ParsedMessages["dash"];
        const slot = [...p.stats.skills, ...p.stats.moduleActives].find((s) => s.effect.type === "DASH");
        if (!slot) return this.error(p, "NO_DASH", "No dash ability equipped");
        return this.onAbility(p, slot, { x: d.dirX, y: d.dirY });
      }
      case "dock": return this.onDock(p, (m as ParsedMessages["dock"]).stationId);
      case "undock": {
        if (p.docked) {
          p.docked = null;
          p.invulnerableUntil = this.now + this.rules.spawnProtectionMs;
        }
        return;
      }
      case "pickup": return void this.onPickup(p, (m as ParsedMessages["pickup"]).lootId);
      case "mine": {
        const id = (m as ParsedMessages["mine"]).asteroidId;
        p.miningTarget = id && this.asteroids.has(id) ? id : null;
        return;
      }
      case "jump": return void this.onJump(p, (m as ParsedMessages["jump"]).portalId);
      case "chat": return void this.onChat(p, m as ParsedMessages["chat"]);
      case "formation": {
        const f = (m as ParsedMessages["formation"]).formation.toUpperCase();
        if (["STANDARD", "ARROW", "TURTLE", "DIAMOND", "WHEEL"].includes(f)) p.formation = f;
        return;
      }
      case "respawn": return this.onRespawn(p);
      case "ping": return this.emitTo(p.client, ServerEvent.PONG, { t: (m as ParsedMessages["ping"]).t, server: Date.now() });
      case "marker": {
        const mk = m as ParsedMessages["marker"];
        if (p.dead) return;
        const evt = { x: Math.max(0, Math.min(this.map.width, mk.x)), y: Math.max(0, Math.min(this.map.height, mk.y)), kind: mk.kind, fromId: p.id, fromName: p.name };
        for (const o of this.players.values()) if (o.connected && this.isAlly(p, o)) this.emitTo(o.client, ServerEvent.MARKER, evt);
        return;
      }
      default: return;
    }
  }

  /**
   * Allies for tactical markers: same team in team rooms; otherwise clan mates
   * anywhere in the room, or same-faction pilots within 2× AOI (open-world squad).
   */
  protected isAlly(a: PlayerActor, b: PlayerActor): boolean {
    if (this.isTeamRoom()) return a.team === b.team;
    if (a.profile.squadId && a.profile.squadId === b.profile.squadId) return true;
    if (a.profile.clanId && a.profile.clanId === b.profile.clanId) return true;
    const r = this.svc.config.aoiRadius * 2;
    return !!a.profile.factionId && a.profile.factionId === b.profile.factionId && (a.x - b.x) ** 2 + (a.y - b.y) ** 2 <= r * r;
  }

  protected isTeamRoom(): boolean {
    return false;
  }

  private onInput(p: PlayerActor, m: ParsedMessages["input"]): void {
    const verdict = p.seq.check(m.seq);
    if (verdict === "replay") {
      packetsDropped.inc({ room: this.roomKind, reason: "replay" });
      this.flag(p, "PACKET_REPLAY", 3, { seq: m.seq, last: p.seq.last });
      return;
    }
    if (verdict === "jump") this.flag(p, "PACKET_REPLAY", 1, { seqJump: m.seq });
    if (p.inputQueue.length >= 64) {
      packetsDropped.inc({ room: this.roomKind, reason: "input_overflow" });
      p.inputQueue.shift();
    }
    p.inputQueue.push({ seq: m.seq, thrust: m.thrust, strafe: m.strafe, heading: m.heading, boost: m.boost, moveTo: m.moveTo ?? null });
    p.lastInputAt = this.now;
  }

  private onTarget(p: PlayerActor, m: ParsedMessages["target"]): void {
    if (m.mode === "CLEAR") {
      p.targetId = "";
      return;
    }
    let target: { id: string; x: number; y: number; kind: string } | null = null;
    if (m.mode === "ENTITY" && m.entityId) {
      if (!p.visible.has(m.entityId)) return this.error(p, "TARGET_NOT_VISIBLE", "Target not in range");
      target = this.actorById(m.entityId);
    } else {
      let best = Infinity;
      for (const id of p.visible) {
        const a = this.actorById(id);
        if (!a || a === p) continue;
        if (a.kind === "LOOT" ? a.claimed : a.kind === "ASTEROID" ? a.depleted : a.dead) continue;
        if (m.mode === "NEAREST_PLAYER" && a.kind !== "PLAYER") continue;
        if (m.mode === "NEAREST_OBJECTIVE" && a.kind !== "BOSS" && a.kind !== "LOOT") continue;
        if (m.mode !== "NEAREST_OBJECTIVE" && (a.kind === "LOOT" || a.kind === "ASTEROID" || !this.hostile(p, a))) continue;
        const d = (a.x - p.x) ** 2 + (a.y - p.y) ** 2;
        if (d < best) { best = d; target = a; }
      }
    }
    if (!target) return;
    p.targetId = target.id;
    const seen = p.firstSeen.get(target.id);
    if (seen !== undefined && this.now - seen < 3000 && target.kind === "PLAYER") {
      if (p.reaction.record(this.now - seen)) this.flag(p, "IMPOSSIBLE_REACTION", 15, { reactionMs: this.now - seen });
    }
  }

  // ------------------------------------------------------------------------
  // Tick
  // ------------------------------------------------------------------------

  private fixedTick(dtMs: number): void {
    const t0 = performance.now();
    this.now = Date.now();
    this.tickCount++;
    const dt = dtMs / 1000;
    this.state.serverTime = this.now;
    this.state.tick = this.tickCount;

    this.rebuildGrid();
    for (const p of this.players.values()) this.tickPlayerMovement(p, dt);
    for (const n of this.npcs.values()) this.tickNpc(n, dt);
    this.rebuildGrid();
    for (const p of this.players.values()) this.tickPlayerCombat(p);
    for (const p of this.players.values()) this.tickMining(p, dt);
    for (const p of this.players.values()) this.tickVitals(p, dt);
    for (const p of this.players.values()) this.tickPet(p, dt);
    if (this.tickCount % (this.svc.config.tickRate * 10) === 0) for (const p of this.players.values()) this.decayKarma(p);
    this.tickWorld();
    this.onTickExtra(dt);

    for (const p of this.players.values()) this.syncEntity(p);
    for (const n of this.npcs.values()) this.syncEntity(n);
    if (this.tickCount % this.rules.aoiUpdateEveryTicks === 0) for (const p of this.players.values()) this.updateAoiFor(p);
    if (this.tickCount % (this.svc.config.tickRate * 10) === 0) void this.flushChat();
    tickDuration.observe({ room: this.roomKind }, (performance.now() - t0) / 1000);
  }

  private rebuildGrid(): void {
    const items = this.gridItems;
    items.length = 0;
    for (const p of this.players.values()) items.push({ id: p.id, x: p.x, y: p.y, ref: p });
    for (const n of this.npcs.values()) items.push({ id: n.id, x: n.x, y: n.y, ref: n });
    for (const l of this.loot.values()) items.push({ id: l.id, x: l.x, y: l.y, ref: l });
    for (const a of this.asteroids.values()) if (!a.depleted) items.push({ id: a.id, x: a.x, y: a.y, ref: a });
    for (const p of this.players.values()) if (p.pet) items.push({ id: p.pet.id, x: p.pet.x, y: p.pet.y, ref: p.pet });
    this.grid.rebuild(items);
  }

  private motionStats(s: ShipActor) {
    const buffs = buffModifiers(s.abilities, this.now);
    return {
      speed: s.stats.speed, acceleration: s.stats.acceleration, turnRate: s.stats.turnRate, maxEnergy: s.maxEnergy,
      speedMultiplier: buffs.speedMultiplier, stunned: this.now < s.stunnedUntil,
    };
  }

  private tickPlayerMovement(p: PlayerActor, dt: number): void {
    if (p.dead || p.docked) {
      p.vx = 0;
      p.vy = 0;
      p.inputQueue.length = 0;
      return;
    }
    const ms = this.motionStats(p);
    const bounds = { width: this.map.width, height: this.map.height };
    const before = { x: p.x, y: p.y };
    let steps = 0;
    if (p.inputQueue.length > 0) {
      while (p.inputQueue.length > 0) {
        const inp = p.inputQueue.shift() as ParsedInput;
        const b = p.budget.consume(this.now);
        if (!b.allowed) {
          packetsDropped.inc({ room: this.roomKind, reason: "movement_budget" });
          if (b.flag) this.flag(p, "SPEED_HACK", 20, { reason: "input_rate", queued: p.inputQueue.length });
          continue;
        }
        const r = stepShip(p, inp, ms, dt, bounds, this.tuning);
        this.applyMotion(p, r);
        p.lastInput = { thrust: inp.thrust, strafe: inp.strafe, heading: inp.heading, boost: inp.boost, moveTo: inp.moveTo };
        p.lastSeq = inp.seq;
        steps++;
        if (p.repeated.push(inp)) this.flag(p, "REPEATED_MOVEMENT", 8, {});
      }
    } else if (this.now - p.lastInputAt > 150) {
      // Client is not streaming: hold the last intent for up to 2s, then brake.
      const input = this.now - p.lastInputAt < 2000 ? p.lastInput : IDLE_INPUT;
      this.applyMotion(p, stepShip(p, input, ms, dt, bounds, this.tuning));
      steps = 1;
    }
    if (steps > 0) {
      const check = checkDisplacement(before, p, ms.speed * (ms.speedMultiplier ?? 1) * this.tuning.boostMultiplier, dt * steps, 1.05);
      if (!check.ok) {
        // Should be impossible through stepShip; treat as a server-side anomaly and clamp.
        this.flag(p, check.cheat ?? "SPEED_HACK", 25, { distance: check.distance, allowed: check.allowed });
        p.x = before.x;
        p.y = before.y;
      }
    }
    if (p.vx !== 0 || p.vy !== 0) {
      p.cloaked = p.cloaked && buffModifiers(p.abilities, this.now).cloaked;
    }
  }

  private applyMotion(s: ShipActor, r: { x: number; y: number; vx: number; vy: number; heading: number; energy: number; boosting?: boolean }): void {
    s.x = r.x;
    s.y = r.y;
    s.vx = r.vx;
    s.vy = r.vy;
    s.heading = r.heading;
    s.energy = r.energy;
    if (r.boosting) s.pulseFlags |= EntityFlag.BOOSTING;
  }

  private tickPlayerCombat(p: PlayerActor): void {
    if (p.dead || p.docked || !p.connected) return;
    if (!p.firing.PRIMARY && !p.firing.SECONDARY) return;
    if (this.now < p.stunnedUntil) return;
    const target = p.targetId ? this.shipById(p.targetId) : null;
    if (!target || target.dead || !p.visible.has(target.id) || !this.attackable(p, target)) return;
    for (const w of p.stats.weapons) {
      if (w.mining) continue;
      if (!p.firing[w.group]) continue;
      this.fireWeapon(p, w, target as ShipActor);
      if (target.dead) break;
    }
  }

  /** Fire one weapon at a target, enforcing fire rate / energy / heat / ammo / range. */
  protected fireWeapon(src: ShipActor, w: EffectiveWeapon, target: ShipActor, damageMultiplier = 1): void {
    const dist = Math.hypot(target.x - src.x, target.y - src.y);
    if (dist > w.range) return;
    const rt = src.weaponRt.get(w.key) ?? { readyAt: 0 };
    const p = src.kind === "PLAYER" ? (src as PlayerActor) : null;
    const ammoStack = p && w.ammo ? p.profile.ammo.get(w.ammo)?.find((s) => s.quantity > 0) : undefined;
    const r = tryFire(w, rt, src.heat, src.energy, src.stats.heatCapacity, this.now, !w.ammo || !!ammoStack);
    if (!r.ok) return;
    src.weaponRt.set(w.key, r.rt);
    src.heat = r.heat;
    src.energy = r.energy;
    if (p) {
      if (ammoStack) {
        ammoStack.quantity--;
        p.pending.ammo.set(ammoStack.id, (p.pending.ammo.get(ammoStack.id) ?? 0) + 1);
      }
      if (p.fireAudit.check(w.key, w.fireRate, this.now)) this.flag(p, "ATTACK_SPEED_HACK", 25, { weapon: w.defId });
      p.abilities = breakCloak(p.abilities);
      p.cloaked = false;
    }
    src.pulseFlags |= EntityFlag.FIRING;
    const res = this.hitWith(src, w, target, dist, damageMultiplier);
    this.sendNear(src.x, src.y, ServerEvent.PLAYER_ATTACK, {
      sourceId: src.id, targetId: target.id, weaponId: w.defId, weaponType: w.type, hit: res.hit,
      fromX: src.x, fromY: src.y, toX: target.x, toY: target.y, color: w.color, style: w.style,
      travelMs: w.projectileSpeed > 0 ? Math.round((dist / w.projectileSpeed) * 1000) : 0,
    });
    if (w.splashRadius > 0 && res.hit) {
      for (const g of this.grid.query(target.x, target.y, w.splashRadius)) {
        const o = g.ref;
        if (o === target || o === src || (o.kind !== "PLAYER" && o.kind !== "NPC" && o.kind !== "BOSS")) continue;
        if (!this.hostile(src, o)) continue;
        const splash = resolveAreaDamage(res.raw * 0.5, w.element, this.defenseOf(o as ShipActor), this.tuning);
        this.applyHit(src, o as ShipActor, splash, w.type);
      }
    }
  }

  private defenseOf(t: ShipActor, weakPointMultiplier = 1) {
    const buffs = buffModifiers(t.abilities, this.now);
    const invulnerable = this.now < t.invulnerableUntil || (t.kind === "PLAYER" && !!(t as PlayerActor).docked);
    return {
      shield: t.shield, hull: t.hull, armor: t.stats.armor, resistances: t.stats.resistances, evasionPct: t.stats.pct.evasion,
      damageTakenMultiplier: buffs.damageTakenMultiplier, weakPointMultiplier, invulnerable,
    };
  }

  private hitWith(src: ShipActor, w: EffectiveWeapon, target: ShipActor, dist: number, extraMult: number): HitResult {
    const pvp = src.kind === "PLAYER" && target.kind === "PLAYER";
    const buffs = buffModifiers(src.abilities, this.now);
    let dmgMult = buffs.damageMultiplier * extraMult;
    if (src.kind === "NPC" || src.kind === "BOSS") {
      const n = src as NpcActor;
      dmgMult *= n.damageMult * n.bossDamageMult;
    }
    let weak = 1;
    if (target.kind === "BOSS") {
      const boss = target as NpcActor;
      const phase = boss.def.phases?.[boss.brain.phase];
      if (phase && isWeakPointHit(boss.x, boss.y, boss.heading, src.x, src.y)) weak = phase.weakPointMultiplier;
    }
    const att = { weapon: w, pveDamagePct: src.stats.pct.pveDamage, pvpDamagePct: src.stats.pct.pvpDamage, damageMultiplier: dmgMult, pvp, distance: dist };
    const res = resolveHit(att, this.defenseOf(target, weak), this.rng, this.tuning);
    if (res.hit && src.kind === "PLAYER") {
      const total = res.shieldDamage + res.hullDamage + res.armorDamage;
      if (isDamageImpossible(total, maxShotDamage(att, weak, this.tuning))) {
        this.flag(src as PlayerActor, "DAMAGE_MANIPULATION", 30, { total, weapon: w.defId });
        return { ...res, hit: false, shieldDamage: 0, hullDamage: 0, armorDamage: 0, shieldAfter: target.shield, hullAfter: target.hull, killed: false };
      }
    }
    if (res.hit) this.applyHit(src, target, res, w.type, weak > 1);
    return res;
  }

  /** Apply a resolved hit: vitals, contribution, events, kill handling. */
  protected applyHit(src: ShipActor | null, target: ShipActor, res: HitResult, weaponType: string, weakPoint = false): void {
    if (!res.hit || target.dead) return;
    target.shield = res.shieldAfter;
    target.hull = res.hullAfter;
    target.lastDamagedAt = this.now;
    if (res.shieldDamage > 0) target.pulseFlags |= EntityFlag.SHIELD_HIT;
    if (weakPoint) target.pulseFlags |= EntityFlag.WEAK_POINT;
    const total = res.shieldDamage + res.hullDamage;
    if (src && src.kind === "PLAYER" && target.kind === "PLAYER") this.onPlayerHitPlayer(src as PlayerActor, target as PlayerActor);
    if (src) {
      target.damageBy.set(src.id, (target.damageBy.get(src.id) ?? 0) + total);
      target.lastHitBy.set(src.id, this.now);
      if (src.kind === "PLAYER") {
        const p = src as PlayerActor;
        p.pending.damageDealt += total;
        p.damageDealt += total;
        if (target.kind === "BOSS") {
          const boss = target as NpcActor;
          p.pending.bossDamage += total;
          if (this.tracksBossParticipation()) p.pending.addEvent(this.bossEventFor(boss).eventId, boss.uid, total);
          this.questEvent(p, { type: "DAMAGE_BOSS", bossId: boss.def.id, amount: total, mapId: this.map.id });
        }
      }
    }
    this.sendNear(target.x, target.y, ServerEvent.PLAYER_DAMAGE, {
      sourceId: src?.id ?? "", targetId: target.id, shieldDamage: res.shieldDamage, armorDamage: res.armorDamage, hullDamage: res.hullDamage,
      crit: res.crit, element: res.element, weaponType, x: target.x, y: target.y,
    });
    if (res.killed || target.hull <= 0) this.kill(target, src);
  }

  private tickVitals(p: PlayerActor, dt: number): void {
    if (p.dead) {
      p.pulseFlags = 0;
      return;
    }
    p.abilities = pruneBuffs(p.abilities, this.now);
    p.cloaked = buffModifiers(p.abilities, this.now).cloaked;
    const v = regenerate(
      { hull: p.hull, shield: p.shield, energy: p.energy, maxHull: p.maxHull, maxShield: p.maxShield, maxEnergy: p.maxEnergy, lastDamagedAt: p.lastDamagedAt, shieldDisruptedUntil: p.shieldDisruptedUntil },
      p.stats.shieldRegen, p.stats.energyRegen, dt, this.now, this.tuning,
    );
    p.shield = v.shield;
    p.energy = v.energy;
    p.heat = coolHeat(p.heat, p.stats.heatCapacity, dt, this.tuning);
    if (p.docked) {
      p.shield = p.maxShield;
    }
    if (this.now - p.lastSurviveAt >= 10_000) {
      this.questEvent(p, { type: "SURVIVE", seconds: Math.floor((this.now - p.lastSurviveAt) / 1000), mapId: this.map.id });
      p.lastSurviveAt = this.now;
    }
  }

  // ------------------------------------------------------------------------
  // NPCs
  // ------------------------------------------------------------------------

  protected spawnNpc(def: NpcDef, x: number, y: number, o: { spawnIndex?: number | null; homeRadius?: number; hullMult?: number; damageMult?: number; rewardMult?: number; tag?: string } = {}): NpcActor {
    const hullMult = o.hullMult ?? 1;
    const damageMult = o.damageMult ?? 1;
    const stats = npcStats(def, { hull: hullMult });
    const id = `n${++this.npcSeq}`;
    const entity = new Entity();
    const n: NpcActor = {
      id, kind: def.kind === "BOSS" ? "BOSS" : "NPC", name: def.name, defId: def.id,
      x: Math.max(0, Math.min(this.map.width, x)), y: Math.max(0, Math.min(this.map.height, y)), vx: 0, vy: 0, heading: this.rng() * Math.PI * 2,
      hull: stats.hull, shield: stats.shield, energy: 0, maxHull: stats.hull, maxShield: stats.shield, maxEnergy: 0,
      level: def.level, faction: def.faction, clanTag: "", team: -1, targetId: "", dead: false, flags: 0, cloaked: false, entity,
      stats, weaponRt: new Map(), heat: { heat: 0, overheated: false }, abilities: createAbilityState(), stunnedUntil: 0, shieldDisruptedUntil: 0,
      lastDamagedAt: 0, invulnerableUntil: 0, damageBy: new Map(), lastHitBy: new Map(), pulseFlags: 0,
      def, uid: `${this.roomId}:${id}:1`, life: 1, brain: createBrain(x, y, o.homeRadius ?? 20, this.now), spawnIndex: o.spawnIndex ?? null,
      respawnAt: 0, nextThinkAt: this.now + Math.floor(this.rng() * 200), move: { ...IDLE_INPUT }, fireAt: null, hullMult, damageMult,
      rewardMult: o.rewardMult ?? 1, bossDamageMult: 1, bossFireRateMult: 1, removeAt: 0, tag: o.tag ?? "",
    };
    entity.id = id;
    entity.kind = n.kind;
    entity.name = def.name;
    entity.defId = def.id;
    entity.team = -1;
    this.npcs.set(id, n);
    this.state.entities.set(id, entity);
    this.syncEntity(n);
    if (n.kind === "BOSS") {
      this.state.bossId = n.id;
      this.state.bossName = def.name;
      this.state.bossPhase = 0;
      this.state.bossHullPct = 1;
    }
    return n;
  }

  protected removeNpc(n: NpcActor): void {
    this.npcs.delete(n.id);
    this.state.entities.delete(n.id);
    for (const p of this.players.values()) p.visible.delete(n.id);
  }

  private npcPerceives(n: NpcActor, p: PlayerActor): boolean {
    return !p.dead && !p.docked && !p.cloaked && p.connected && this.now >= p.invulnerableUntil && !isSafeAt(this.map, p.x, p.y);
  }

  private tickNpc(n: NpcActor, dt: number): void {
    if (n.dead) {
      if (n.spawnIndex === null) {
        if (this.now >= n.removeAt) this.removeNpc(n);
      } else if (this.now >= n.respawnAt) {
        this.respawnNpc(n);
      }
      return;
    }
    if (this.now >= n.nextThinkAt) {
      n.nextThinkAt = this.now + (n.kind === "BOSS" ? 100 : 200);
      const perception = Math.max(n.def.aggroRange, n.def.range) * 1.5 + 10;
      const visible: { id: string; x: number; y: number }[] = [];
      for (const g of this.grid.query(n.x, n.y, perception)) {
        if (g.ref.kind === "PLAYER" && this.npcPerceives(n, g.ref)) visible.push({ id: g.id, x: g.x, y: g.y });
      }
      const attackers = [...n.damageBy.entries()]
        .filter(([id]) => (n.lastHitBy.get(id) ?? 0) > this.now - 12_000)
        .filter(([id]) => { const a = this.players.get(id); return !!a && this.npcPerceives(n, a); })
        .sort((a, b) => b[1] - a[1])
        .map(([id]) => id);
      for (const id of attackers) {
        if (!visible.some((v) => v.id === id)) {
          const a = this.players.get(id);
          if (a) visible.push({ id, x: a.x, y: a.y });
        }
      }
      let allyAttacker: { id: string; x: number; y: number } | null = null;
      if (n.def.behavior === "SWARM" || n.def.behavior === "DEFENSIVE" || n.def.behavior === "AGGRESSIVE") {
        for (const g of this.grid.query(n.x, n.y, 45)) {
          const o = g.ref;
          if (o === n || (o.kind !== "NPC" && o.kind !== "BOSS") || o.dead || o.def.faction !== n.def.faction) continue;
          if (this.now - o.lastDamagedAt > 3000) continue;
          const top = [...o.damageBy.entries()].sort((a, b) => b[1] - a[1])[0];
          const att = top ? this.players.get(top[0]) : undefined;
          if (att && this.npcPerceives(n, att)) { allyAttacker = { id: att.id, x: att.x, y: att.y }; break; }
        }
      }
      const d = stepNpcBrain(n.brain, {
        now: this.now, x: n.x, y: n.y, hullFraction: n.hull / Math.max(1, n.maxHull), def: n.def, visible, attackers, allyAttacker, rng: this.rng,
      }, this.tuning);
      n.brain = d.brain;
      n.targetId = d.brain.targetId ?? "";
      n.fireAt = d.fireAt;
      if (d.moveTo) n.move = { thrust: 0, strafe: 0, heading: Number.NaN, boost: false, moveTo: d.moveTo };
      else if (d.faceTo) n.move = { thrust: 0, strafe: 0, heading: Math.atan2(d.faceTo.y - n.y, d.faceTo.x - n.x), boost: false, moveTo: null };
      else n.move = { ...IDLE_INPUT };
      if (n.brain.state === "RETREAT" || n.brain.state === "IDLE") {
        if (n.kind === "BOSS" && n.brain.engagedAt !== null && attackers.length === 0) {
          n.brain = resetBoss(n.brain, this.now);
          n.hull = n.maxHull;
          n.shield = n.maxShield;
          n.damageBy.clear();
        }
      }
    }
    // Retreating NPCs regenerate quickly (anti-kiting reset).
    if (n.brain.state === "RETREAT") {
      n.hull = Math.min(n.maxHull, n.hull + n.maxHull * 0.1 * dt);
      n.shield = Math.min(n.maxShield, n.shield + n.maxShield * 0.1 * dt);
    } else if (this.now - n.lastDamagedAt > 5000) {
      n.shield = Math.min(n.maxShield, n.shield + n.stats.shieldRegen * dt);
    }
    const ms = this.motionStats(n);
    this.applyMotion(n, stepShip(n, n.move, { ...ms, maxEnergy: 0 }, dt, { width: this.map.width, height: this.map.height }, this.tuning));

    if (n.def.phases && n.def.phases.length) this.tickBoss(n);

    if (n.fireAt && this.now >= n.stunnedUntil) {
      const t = this.players.get(n.fireAt);
      if (t && !t.dead && this.npcPerceives(n, t)) {
        for (const w of n.stats.weapons) {
          const eff = n.bossFireRateMult !== 1 ? { ...w, fireRate: w.fireRate * n.bossFireRateMult } : w;
          this.fireWeapon(n, eff, t);
        }
      }
    }
  }

  private tickBoss(n: NpcActor): void {
    const phases = n.def.phases ?? [];
    const r = bossTick(n.brain, phases, n.hull / Math.max(1, n.maxHull), this.now, this.tuning);
    n.brain = r.brain;
    n.bossDamageMult = r.damageMultiplier;
    n.bossFireRateMult = r.fireRateMultiplier;
    if (r.phaseChanged && r.phase) {
      this.broadcast(ServerEvent.BOSS_PHASE, { bossId: n.id, phase: n.brain.phase, name: r.phase.name, layer: r.phase.layer });
      if (this.state.bossId === n.id) this.state.bossPhase = n.brain.phase;
    }
    if (r.enragedNow) {
      n.flags |= EntityFlag.ENRAGED;
      this.sendNear(n.x, n.y, ServerEvent.EFFECT, { kind: "ENRAGE", x: n.x, y: n.y, radius: 40, sourceId: n.id });
    }
    if (r.special) this.areaAttack(n, r.special.radius, r.special.damage * n.damageMult, r.special.element, "BARRAGE");
    if (r.adds) {
      const addDef = NPCS_BY_ID.get(r.adds.npcId);
      if (addDef) {
        const cap = 30;
        const current = [...this.npcs.values()].filter((x) => x.tag === `add:${n.id}` && !x.dead).length;
        for (let i = 0; i < Math.min(r.adds.count, cap - current); i++) {
          const a = this.rng() * Math.PI * 2;
          this.spawnNpc(addDef, n.x + Math.cos(a) * 25, n.y + Math.sin(a) * 25, { spawnIndex: null, homeRadius: 30, hullMult: n.hullMult > 1 ? n.hullMult : 1, damageMult: n.damageMult, rewardMult: 0.5, tag: `add:${n.id}` });
        }
      }
    }
    if (this.state.bossId === n.id) this.state.bossHullPct = n.hull / Math.max(1, n.maxHull);
  }

  /** Area damage centered on a source (boss specials, barrage, EMP handled separately). */
  protected areaAttack(src: ShipActor, radius: number, damage: number, element: DamageElement, effect: "BARRAGE" | "EMP" | "SHIELD_BURST"): void {
    this.sendNear(src.x, src.y, ServerEvent.EFFECT, { kind: effect, x: src.x, y: src.y, radius, sourceId: src.id });
    for (const g of this.grid.query(src.x, src.y, radius)) {
      const o = g.ref;
      if (o === src || (o.kind !== "PLAYER" && o.kind !== "NPC" && o.kind !== "BOSS")) continue;
      if (!this.hostile(src, o)) continue;
      const res = resolveAreaDamage(damage, element, this.defenseOf(o as ShipActor), this.tuning);
      this.applyHit(src, o as ShipActor, res, "SPECIAL");
    }
  }

  private respawnNpc(n: NpcActor): void {
    const s = n.spawnIndex !== null ? this.map.spawns[n.spawnIndex] : undefined;
    const a = this.rng() * Math.PI * 2;
    const r = Math.sqrt(this.rng()) * (s?.radius ?? 20);
    n.x = (s?.x ?? n.brain.homeX) + Math.cos(a) * r;
    n.y = (s?.y ?? n.brain.homeY) + Math.sin(a) * r;
    n.vx = 0;
    n.vy = 0;
    n.hull = n.maxHull;
    n.shield = n.maxShield;
    n.dead = false;
    n.life++;
    n.uid = `${this.roomId}:${n.id}:${n.life}`;
    n.damageBy.clear();
    n.lastHitBy.clear();
    n.flags = 0;
    n.brain = createBrain(n.brain.homeX, n.brain.homeY, n.brain.homeRadius, this.now);
    n.bossDamageMult = 1;
    n.bossFireRateMult = 1;
    this.syncEntity(n);
    if (n.kind === "BOSS" && this.state.bossId === n.id) {
      this.state.bossPhase = 0;
      this.state.bossHullPct = 1;
    }
  }

  // ------------------------------------------------------------------------
  // Deaths & rewards
  // ------------------------------------------------------------------------

  protected kill(target: ShipActor, killer: ShipActor | null): void {
    if (target.dead) return;
    target.dead = true;
    target.hull = 0;
    target.shield = 0;
    target.vx = 0;
    target.vy = 0;
    const scale = target.kind === "PLAYER" ? 1 : (target as NpcActor).def.visual.scale;
    const killerName = killer?.name;
    this.sendNear(target.x, target.y, ServerEvent.PLAYER_DEATH, { entityId: target.id, kind: target.kind as EntityKind, killerId: killer?.id, killerName, x: target.x, y: target.y, scale });
    if (target.kind === "PLAYER") {
      this.playerDied(target as PlayerActor, killer);
    } else {
      this.npcDied(target as NpcActor, killer);
    }
  }

  private npcDied(n: NpcActor, killer: ShipActor | null): void {
    n.brain = { ...n.brain, state: "RESPAWN", stateSince: this.now, targetId: null };
    n.respawnAt = this.now + n.def.respawnMs;
    n.removeAt = this.now + 2000;
    n.fireAt = null;
    n.targetId = "";
    const boss = n.kind === "BOSS";
    const contributors = [...n.damageBy.entries()]
      .map(([id, dmg]) => ({ p: this.players.get(id), dmg }))
      .filter((c): c is { p: PlayerActor; dmg: number } => !!c.p);
    // Reward scaling counts only QUALIFIED contributors (share ≥ bossMinContribution): a low-damage alt must not
    // raise a raid's reward scale or the per-pilot contribution factors. `contributors` stays the full list.
    const { qualified, totalDmg } = qualifyContributors(contributors, this.rules.bossMinContribution);
    let credited: PlayerActor | null = null;
    if (contributors.length) {
      const top = contributors.reduce((a, b) => (b.dmg > a.dmg ? b : a));
      credited = top.p;
    } else if (killer?.kind === "PLAYER") {
      credited = killer as PlayerActor;
    }
    if (boss) this.broadcast(ServerEvent.KILL_FEED, { killer: credited?.name ?? killer?.name ?? "?", victim: n.name, weapon: "", pvp: false });

    const scale = this.rewardScale(n, qualified.length);
    const rewardMult = n.rewardMult * scale;
    if (rewardMult <= 0) {
      // No rewards (e.g. under-manned raid); kill still counts for match/quest bookkeeping below.
    } else if (this.shareRewards(n) && totalDmg > 0) {
      for (const c of qualified) {
        const share = c.dmg / totalDmg;
        const factor = Math.max(0.1, Math.min(1, share * qualified.length));
        this.grantNpcRewards(c.p, n, factor * rewardMult, `${n.uid}`);
        if (boss) c.p.pending.bossKills++;
        this.rollLootFor(n, c.p, true, scale);
      }
    } else if (credited) {
      this.grantNpcRewards(credited, n, rewardMult, n.uid);
      this.rollLootFor(n, credited, false, scale);
    }
    if (boss) void this.onBossKilled(n, contributors, totalDmg);
    this.onNpcKilled(n, credited);
    if (boss) for (const c of contributors) this.requestFlush(c.p);
  }

  /** XP / honor / credits / counters / quests for one credited player. */
  protected grantNpcRewards(p: PlayerActor, n: NpcActor, mult: number, keyBase: string): void {
    const xp = Math.round(n.def.xp * mult * this.xpMultiplier);
    const credits = Math.round(n.def.credits * mult);
    const honor = Math.round(n.def.honor * mult);
    this.giveXp(p, xp);
    this.givePetXp(p, xp);
    p.honor += honor;
    p.pending.honor += honor;
    p.pending.seasonScore += honor;
    if (honor) p.pending.addBoard("season_score", honor);
    p.pending.npcKills++;
    p.pending.addBoard("npc_kills", 1);
    if (credits > 0) p.pending.issuance.push({ asset: "CREDITS", amount: toMoney(credits), key: `kill:${keyBase}:${p.userId}`, reason: `npc_kill:${n.def.id}`, meta: { npc: n.def.id, map: this.map.id } });
    this.emitTo(p.client, ServerEvent.REWARD, { xp, honor, credits, seasonPoints: honor, reason: `Destroyed ${n.name}` });
    this.questEvent(p, { type: "KILL", npcId: n.def.id, boss: n.kind === "BOSS", mapId: this.map.id });
  }

  /** Add XP in memory (level-up events); `persist=false` when the database was already credited. */
  protected giveXp(p: PlayerActor, amount: number, persist = true): void {
    if (amount <= 0) return;
    const g = grantXp(p.xp, amount, PROGRESSION);
    p.xp = g.xpAfter;
    if (persist) p.pending.xp += amount;
    if (g.levelsGained.length) {
      p.level = g.levelAfter;
      p.profile.level = g.levelAfter;
      this.sendNear(p.x, p.y, ServerEvent.PLAYER_LEVEL_UP, { userId: p.userId, level: p.level, entityId: p.id });
      this.questEvent(p, { type: "LEVEL", level: p.level });
      this.requestFlush(p);
    }
  }

  /** `scale` is the room's reward scale (e.g. an under-manned raid) and applies to loot as it does to XP/credits. */
  private rollLootFor(n: NpcActor, owner: PlayerActor, personal: boolean, scale = 1): void {
    const table = LOOT_TABLES_BY_ID.get(n.def.lootTable);
    if (!table || scale <= 0) return;
    const drops = rollLoot(table, this.rng, { dropMultiplier: this.dropMultiplier, scale });
    if (!drops.length) return;
    const a = this.rng() * Math.PI * 2;
    const r = personal ? 4 + this.rng() * 8 : 0;
    this.dropLoot(n.x + Math.cos(a) * r, n.y + Math.sin(a) * r, drops, owner.userId);
  }

  protected dropLoot(x: number, y: number, drops: LootDrop[], ownerUserId: string | null): LootActor {
    let rarity: Rarity = "COMMON";
    for (const d of drops) {
      const r: Rarity = d.rarity ?? (d.kind === "ITEM" ? ITEMS_BY_ID.get(d.ref)?.rarity ?? "COMMON" : d.kind === "GEMS" ? "RARE" : "COMMON");
      if (RARITY_ORDER[r] > RARITY_ORDER[rarity]) rarity = r;
    }
    const id = `l${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const entity = new Entity();
    const first = drops[0];
    const label = drops.length > 1 ? `${drops.length} items` : first ? (first.kind === "ITEM" ? ITEMS_BY_ID.get(first.ref)?.name ?? first.ref : `${first.quantity} ${first.ref}`) : "Cargo";
    const l: LootActor = {
      id, kind: "LOOT", x: Math.max(0, Math.min(this.map.width, x)), y: Math.max(0, Math.min(this.map.height, y)), ownerUserId,
      ownerUntil: this.now + this.rules.lootOwnerMs, expiresAt: this.now + this.rules.lootTtlMs, drops, rarity, label, claimed: false, entity,
    };
    entity.id = id;
    entity.kind = "LOOT";
    entity.name = label;
    entity.defId = rarity;
    entity.x = l.x;
    entity.y = l.y;
    entity.maxHull = 1;
    entity.hull = 1;
    entity.team = -1;
    this.loot.set(id, l);
    this.state.entities.set(id, entity);
    this.sendNear(l.x, l.y, ServerEvent.ITEM_DROP, { lootId: id, x: l.x, y: l.y, rarity, label });
    return l;
  }

  private removeLoot(l: LootActor): void {
    this.loot.delete(l.id);
    this.state.entities.delete(l.id);
    for (const p of this.players.values()) p.visible.delete(l.id);
  }

  /** `via`: companion LOOT_COLLECT (range measured from the pet, loot radius instead of pickup range). */
  private async onPickup(p: PlayerActor, lootId: string, via?: { x: number; y: number; range: number }): Promise<void> {
    const l = this.loot.get(lootId);
    // Double clicks / races are normal: an already-claimed loot id is simply gone.
    // Only a database-level duplicate (see below) is treated as a cheat signal.
    if (!l || l.claimed || this.processedLoot.has(lootId)) return this.error(p, "LOOT_GONE", "Loot no longer available");
    if (p.dead) return;
    const from = via ?? { x: p.x, y: p.y, range: this.rules.pickupRange };
    if (Math.hypot(l.x - from.x, l.y - from.y) > from.range) return via ? undefined : this.error(p, "TOO_FAR", "Move closer to pick up");
    if (l.ownerUserId && l.ownerUserId !== p.userId && this.now < l.ownerUntil) return via ? undefined : this.error(p, "NOT_OWNER", "Loot reserved for another pilot");
    l.claimed = true;
    this.processedLoot.add(lootId);
    this.removeLoot(l);
    const items: { itemId: string; name: string; quantity: number; rarity: Rarity; affixes: unknown[] }[] = [];
    let credits = 0;
    let gems = 0;
    const resources: Partial<Record<ResourceId, number>> = {};
    for (const d of l.drops) {
      if (d.kind === "CREDITS") credits += d.quantity;
      else if (d.kind === "GEMS") gems += d.quantity;
      else if (d.kind === "RESOURCE") resources[d.ref as ResourceId] = (resources[d.ref as ResourceId] ?? 0) + d.quantity;
      else {
        const itemId = d.kind === "BLUEPRINT" ? itemIdForDef(d.ref) : d.ref;
        const def = ITEMS_BY_ID.get(itemId);
        if (!def) continue;
        const affixes = isAffixable(def) ? rollAffixes(def, ITEM_AFFIXES, this.rng, d.rarity) : [];
        items.push({ itemId, name: def.name, quantity: d.quantity, rarity: d.rarity ?? def.rarity, affixes });
      }
    }
    try {
      await this.svc.persistence.grantLoot(p.userId, { lootId, items: items.map((i) => ({ itemId: i.itemId, quantity: i.quantity, affixes: i.affixes })), credits: toMoney(credits), gems: toMoney(gems), resources });
    } catch (e) {
      if (e instanceof DuplicateLootError) {
        this.processedLoot.delete(lootId); // loot stays removed from `this.loot`, so repeats are still rejected
        this.flag(p, "DUPLICATE_LOOT", 20, { lootId });
        return this.error(p, "DUPLICATE_LOOT", "Loot already claimed");
      }
      this.log.error({ err: e, lootId }, "loot grant failed");
      this.processedLoot.delete(lootId);
      l.claimed = false;
      this.loot.set(l.id, l);
      this.state.entities.set(l.id, l.entity);
      return this.error(p, "LOOT_FAILED", "Could not collect loot, try again");
    }
    // Granted: the id is out of `this.loot` (repeat pickups hit `!l`) and the DB originRef is unique,
    // so the in-flight guard is no longer needed — keep the set bounded in long-lived rooms.
    this.processedLoot.delete(lootId);
    const evt: ServerEvents["item_pickup"] = {
      lootId, byEntityId: p.id, items: items.map((i) => ({ itemId: i.itemId, name: i.name, quantity: i.quantity, rarity: i.rarity })), credits, gems, resources,
    };
    if (p.connected) this.emitTo(p.client, ServerEvent.ITEM_PICKUP, evt);
    for (const i of items) {
      this.questEvent(p, { type: "COLLECT", itemId: i.itemId, quantity: i.quantity, mapId: this.map.id });
      // Newly looted ammo becomes usable immediately.
      if (ITEMS_BY_ID.get(i.itemId)?.category === "AMMO") void this.refreshAmmo(p, i.itemId);
    }
    for (const [res, q] of Object.entries(resources)) if (q) this.questEvent(p, { type: "COLLECT", itemId: itemIdForResource(res), quantity: q, mapId: this.map.id });
  }

  private async refreshAmmo(p: PlayerActor, itemId: string): Promise<void> {
    const rows = await this.svc.db.inventoryItem.findMany({ where: { userId: p.userId, itemId, lockedBy: null, quantity: { gt: 0 } }, select: { id: true, quantity: true } });
    const pendingUse = (id: string) => p.pending.ammo.get(id) ?? 0;
    p.profile.ammo.set(itemId, rows.map((r) => ({ id: r.id, quantity: Math.max(0, r.quantity - pendingUse(r.id)) })));
  }

  private playerDied(v: PlayerActor, killer: ShipActor | null): void {
    v.respawnAt = this.now + PROGRESSION.respawnMs;
    v.firing.PRIMARY = false;
    v.firing.SECONDARY = false;
    v.targetId = "";
    v.miningTarget = null;
    v.deathCount++;
    v.deaths++;
    v.pending.deaths++;
    const cost = deathRepairCost(v.maxHull, PROGRESSION);
    v.lastRepairCost = 0;
    if (cost > 0n) {
      const key = `death:${this.roomId}:${v.userId}:${v.deathCount}`;
      this.svc.persistence.chargeCredits(v.userId, cost, key, "death_repair", true)
        .then((charged) => { v.lastRepairCost = Number(charged); })
        .catch((e: unknown) => this.log.error({ err: e }, "repair charge failed"));
    }
    const kp = killer?.kind === "PLAYER" ? (killer as PlayerActor) : null;
    this.broadcast(ServerEvent.KILL_FEED, { killer: killer?.name ?? "Environment", victim: v.name, weapon: "", pvp: !!kp });
    if (kp) this.pvpKill(kp, v);
    this.onPlayerKilled(v, killer);
    this.requestFlush(v);
  }

  /** PvP kill rewards with anti-farming (same victim window, level gap). */
  protected pvpKill(k: PlayerActor, v: PlayerActor): void {
    k.kills++;
    const cfg = PROGRESSION.reputation;
    if (cfg && !this.isTeamRoom()) {
      if (isOutlaw(v.karma, cfg)) {
        this.adjustKarma(k, cfg.outlawKillReward, "outlaw_kill");
      } else if (this.isUnprovoked(k, v)) {
        // Murder of a non-hostile pilot: karma penalty and no PvP rewards.
        this.adjustKarma(k, -cfg.unprovokedKillPenalty, "unprovoked_kill");
        this.emitTo(k.client, ServerEvent.NOTICE, { level: "warn", text: "Unprovoked kill — no rewards, karma lost" });
        return;
      }
    }
    const pairKey = `${k.userId}:${v.userId}`;
    const last = this.pvpKillLog.get(pairKey) ?? -Infinity;
    const farming = this.now - last < this.rules.pvpSameVictimWindowMs || k.level - v.level > this.rules.pvpMaxLevelGap || k.profile.clanId !== null && k.profile.clanId === v.profile.clanId;
    this.pvpKillLog.set(pairKey, this.now);
    if (farming) {
      this.emitTo(k.client, ServerEvent.NOTICE, { level: "warn", text: "Repeated kill of the same pilot — no rewards" });
      if (this.now - last < 60_000) this.flag(k, "ABNORMAL_FARMING", 5, { victim: v.userId });
      return;
    }
    const honor = Math.round(v.level * this.rules.pvpHonorPerVictimLevel);
    const xp = Math.round(v.level * this.rules.pvpXpPerVictimLevel * this.xpMultiplier);
    this.giveXp(k, xp);
    this.givePetXp(k, xp);
    k.honor += honor;
    k.pending.honor += honor;
    k.pending.seasonScore += honor;
    k.pending.playerKills++;
    k.pending.addBoard("pvp_kills", 1);
    k.pending.addBoard("season_score", honor);
    this.questEvent(k, { type: "KILL_PLAYER", victimId: v.userId, mapId: this.map.id });
    const matchId = this.currentMatchId();
    const window = Math.floor(this.now / this.rules.pvpSameVictimWindowMs);
    const sourceRef = matchId ? `pvp:${matchId}:${v.userId}:${k.userId}` : `pvp:${this.map.id}:${v.userId}:${k.userId}:${window}`;
    this.emitTo(k.client, ServerEvent.REWARD, { xp, honor, credits: 0, seasonPoints: honor, reason: `Defeated ${v.name}`, cryptoEligible: true });
    this.requestFlush(k);
    void this.crypto(k, "PVP", sourceRef, this.rules.pvpCryptoWeight, `PvP victory over ${v.name}`, matchId ?? undefined);
    void this.svc.persistence.claimBounties(v.userId, k.userId)
      .then((paid) => {
        const total = paid.reduce((s, b) => s + b.amount, 0n);
        if (total > 0n && k.connected) {
          this.emitTo(k.client, ServerEvent.REWARD, { xp: 0, honor: 0, credits: Number(total), seasonPoints: 0, reason: `Bounty on ${v.name} claimed` });
          this.broadcast(ServerEvent.KILL_FEED, { killer: k.name, victim: v.name, weapon: "BOUNTY", pvp: true });
        }
      })
      .catch((e: unknown) => this.log.error({ err: e }, "bounty claim failed"));
  }

  /** Route an eligible achievement through the economy reward engine (never granted directly). */
  protected async crypto(p: PlayerActor, source: RewardSource, sourceRef: string, weight: number, reason: string, matchId?: string): Promise<void> {
    try {
      const r = await grantCryptoReward(this.svc.db, {
        userId: p.userId, source, sourceRef, weight, reason, matchId, mode: this.matchMode(), seasonId: activeSeasonId() ?? undefined,
      });
      this.log.info({ userId: p.userId, source, sourceRef, status: r.status, amount: r.amount.toString() }, "crypto reward");
      if (p.connected && (r.status === "GRANTED" || r.status === "PENDING_REVIEW")) {
        this.emitTo(p.client, ServerEvent.NOTICE, { level: "success", text: r.status === "GRANTED" ? "Battle reward earned — claim it in Rewards" : "Battle reward recorded (pending review)" });
      }
    } catch (e) {
      errorsTotal.inc({ component: "economy", code: "grant" });
      this.log.error({ err: e, sourceRef }, "grantCryptoReward failed");
    }
  }

  /** Event id that world-boss participation is recorded under. */
  private bossEventCache = new Map<string, { eventId: string; def: EventDef | null }>();
  protected bossEventFor(n: NpcActor): { eventId: string; def: EventDef | null } {
    const cached = this.bossEventCache.get(n.uid);
    if (cached) return cached;
    const r = this.resolveBossEvent(n);
    this.bossEventCache.set(n.uid, r);
    return r;
  }

  private resolveBossEvent(n: NpcActor): { eventId: string; def: EventDef | null } {
    const active = this.svc.events.activeFor(this.map.id).find((a) => a.def.boss === n.def.id);
    if (active) return { eventId: active.def.id, def: active.def };
    const any = EVENTS.find((e) => e.boss === n.def.id);
    return any ? { eventId: any.id, def: null } : { eventId: bossEventId(n.def.id), def: null };
  }

  /** Crypto source for a boss kill in this room. */
  protected bossRewardSource(): RewardSource {
    return "WORLD_BOSS";
  }

  /**
   * Collective boss contribution: EventParticipation rows (contribution = damage),
   * event reward tiers by contribution %, and crypto eligibility through the reward engine.
   */
  /** Whether boss damage is recorded as EventParticipation in this room (gates/raids pay per run instead). */
  protected tracksBossParticipation(): boolean {
    return true;
  }

  /**
   * Collective boss contribution: boss damage is recorded continuously as
   * EventParticipation (contribution = damage, instance = boss life). On kill
   * the tiers are distributed idempotently (see Persistence.distributeEventRewards).
   */
  protected async onBossKilled(n: NpcActor, contributors: { p: PlayerActor; dmg: number }[], _totalDmg: number): Promise<void> {
    await this.distributeBossRewards(n, contributors.map((c) => c.p));
  }

  protected async distributeBossRewards(n: NpcActor, participants: PlayerActor[]): Promise<void> {
    if (!this.tracksBossParticipation()) return;
    const { eventId, def } = this.bossEventFor(n);
    // Make sure every contribution is in the database before computing shares.
    await Promise.all(participants.map((p) => this.flushPlayer(p, false, true)));
    try {
      const results = await this.svc.persistence.distributeEventRewards(eventId, n.uid, def, {
        minShare: this.rules.bossMinContribution,
        fallbackSource: def?.type === "GLOBAL_RIFT" ? "EVENT" : this.bossRewardSource(),
        label: def?.name ?? `${n.name} destroyed`,
        mode: this.matchMode(),
      });
      for (const r of results) {
        const p = this.getPlayerByUser(r.userId);
        if (!p || !p.connected) continue;
        const xp = Math.floor(r.bundle.xp ?? 0);
        if (xp > 0) this.giveXp(p, xp, false);
        const honor = Math.floor(r.bundle.honor ?? 0);
        p.honor += honor;
        this.emitTo(p.client, ServerEvent.REWARD, {
          xp, honor, credits: r.bundle.credits ?? 0, seasonPoints: (r.bundle.seasonPoints ?? 0) + honor,
          reason: `${def?.name ?? n.name}${r.tier ? ` — ${r.tier}` : ""} (${r.contributionPct.toFixed(1)}%)`,
          cryptoEligible: r.cryptoStatus === "GRANTED" || r.cryptoStatus === "PENDING_REVIEW",
        });
      }
    } catch (e) {
      errorsTotal.inc({ component: "persistence", code: "event_rewards" });
      this.log.error({ err: e, eventId, instance: n.uid }, "event reward distribution failed");
    }
  }


  /**
   * Grant a RewardBundle: XP/honor/season points (batched), credits/gems/items/resources
   * (idempotent by `refBase`), crypto eligibility through grantCryptoReward.
   */
  protected async grantBundle(p: PlayerActor, b: RewardBundle, mult: number, refBase: string, reason: string, cryptoSource?: RewardSource): Promise<void> {
    const xp = Math.round((b.xp ?? 0) * mult * this.xpMultiplier);
    const honor = Math.round((b.honor ?? 0) * mult);
    const season = Math.round((b.seasonPoints ?? 0) * mult) + honor;
    this.giveXp(p, xp);
    p.honor += honor;
    p.pending.honor += honor;
    p.pending.seasonScore += season;
    if (season) p.pending.addBoard("season_score", season);
    const credits = Math.round((b.credits ?? 0) * mult);
    const gems = Math.round((b.gems ?? 0) * mult);
    const resources: Partial<Record<ResourceId, number>> = {};
    for (const [k, v] of Object.entries(b.resources ?? {})) if (v) resources[k as ResourceId] = Math.round(v * mult);
    const items = (b.items ?? []).filter((i) => ITEMS_BY_ID.has(i.itemId)).map((i) => ({ itemId: i.itemId, quantity: i.quantity, affixes: [] as unknown[] }));
    try {
      await this.svc.persistence.grantLoot(p.userId, { lootId: refBase, items, credits: toMoney(credits), gems: toMoney(gems), resources });
    } catch (e) {
      if (!(e instanceof DuplicateLootError)) this.log.error({ err: e, refBase }, "bundle grant failed");
      return;
    }
    if (p.connected) this.emitTo(p.client, ServerEvent.REWARD, { xp, honor, credits, seasonPoints: season, reason, cryptoEligible: !!b.cryptoEligible });
    if (b.cryptoEligible) void this.crypto(p, cryptoSource ?? b.cryptoEligible.source, refBase, b.cryptoEligible.weight * mult, reason, this.currentMatchId() ?? undefined);
    this.requestFlush(p);
  }

  private onRespawn(p: PlayerActor): void {
    if (!p.dead) return;
    if (this.now < p.respawnAt) return this.error(p, "RESPAWN_COOLDOWN", "Repairs in progress");
    const pos = this.respawnPointFor(p);
    p.x = pos.x;
    p.y = pos.y;
    p.vx = 0;
    p.vy = 0;
    p.hull = p.maxHull;
    p.shield = p.maxShield;
    p.energy = p.maxEnergy;
    p.dead = false;
    p.heat = { heat: 0, overheated: false };
    p.abilities = { ...p.abilities, buffs: [] };
    p.damageBy.clear();
    p.invulnerableUntil = this.now + this.rules.spawnProtectionMs;
    p.inputQueue.length = 0;
    p.lastInput = { ...IDLE_INPUT };
    this.syncEntity(p);
    this.sendNear(p.x, p.y, ServerEvent.PLAYER_RESPAWN, { entityId: p.id, x: p.x, y: p.y, repairCost: p.lastRepairCost });
    this.emitTo(p.client, ServerEvent.PLAYER_RESPAWN, { entityId: p.id, x: p.x, y: p.y, repairCost: p.lastRepairCost });
    this.updateAoiFor(p);
  }

  // ------------------------------------------------------------------------
  // Reputation / karma
  // ------------------------------------------------------------------------

  /** Unprovoked = not a team match, target not an outlaw, not a faction-war enemy, and not self-defense. */
  protected isUnprovoked(a: PlayerActor, b: PlayerActor): boolean {
    const cfg = PROGRESSION.reputation;
    if (!cfg || this.isTeamRoom()) return false;
    if (isOutlaw(b.karma, cfg) || this.warHostile(a, b)) return false;
    const provokedAt = a.lastHitBy.get(b.id) ?? -Infinity;
    return this.now - provokedAt > cfg.selfDefenseWindowSec * 1000;
  }

  private onPlayerHitPlayer(a: PlayerActor, b: PlayerActor): void {
    const cfg = PROGRESSION.reputation;
    if (!cfg || !this.isUnprovoked(a, b)) return;
    const last = a.unprovokedLog.get(b.userId) ?? -Infinity;
    if (this.now - last < cfg.unprovokedAttackWindowSec * 1000) return;
    a.unprovokedLog.set(b.userId, this.now);
    this.adjustKarma(a, -cfg.unprovokedAttackPenalty, "unprovoked_attack");
  }

  protected adjustKarma(p: PlayerActor, delta: number, reason: string): void {
    const cfg = PROGRESSION.reputation;
    if (!cfg || delta === 0) return;
    const before = p.karma;
    const after = clampKarma(before + delta, cfg);
    if (after === before) return;
    p.karma = after;
    p.pending.karma += after - before;
    const prevRep = p.reputation;
    p.reputation = reputationFor(after, p.hasBounty, cfg);
    this.emitReputation(p, reason);
    if (p.reputation !== prevRep) {
      if (p.reputation === "OUTLAW") this.sendNear(p.x, p.y, ServerEvent.NOTICE, { level: "warn", text: `${p.name} is now an OUTLAW` });
      this.requestFlush(p);
    }
  }

  private decayKarma(p: PlayerActor): void {
    const cfg = PROGRESSION.reputation;
    const dt = (this.now - p.lastKarmaDecayAt) / 1000;
    p.lastKarmaDecayAt = this.now;
    if (!cfg || p.karma === 0) return;
    const next = decayKarma(p.karma, dt, cfg);
    const delta = next - p.karma;
    const wasOutlaw = isOutlaw(p.karma, cfg);
    p.karma = next;
    p.pending.karma += delta;
    const rep = reputationFor(Math.round(next), p.hasBounty, cfg);
    if (rep !== p.reputation || wasOutlaw !== isOutlaw(next, cfg)) {
      p.reputation = rep;
      this.emitReputation(p, "decay");
    }
  }

  protected emitReputation(p: PlayerActor, reason: string): void {
    const cfg = PROGRESSION.reputation;
    if (!p.connected || !cfg) return;
    this.emitTo(p.client, ServerEvent.REPUTATION, { karma: Math.round(p.karma), reputation: p.reputation, outlaw: isOutlaw(p.karma, cfg), bountyTarget: p.hasBounty, reason });
  }

  private applyFlushSocial(p: PlayerActor, res: { karma: number; reputation: string; hasBounty: boolean; systemBountyPlaced: boolean; pet: { level: number; xp: number } | null }): void {
    const bountyChanged = res.hasBounty !== p.hasBounty;
    p.hasBounty = res.hasBounty;
    // The DB value plus what accumulated since the flush started is the authoritative karma.
    p.karma = res.karma + p.pending.karma;
    const cfg = PROGRESSION.reputation;
    const rep = cfg ? reputationFor(Math.round(p.karma), p.hasBounty, cfg) : res.reputation;
    if (rep !== p.reputation || bountyChanged) {
      p.reputation = rep;
      this.emitReputation(p, res.systemBountyPlaced ? "system_bounty" : "sync");
    }
    if (res.systemBountyPlaced) this.broadcast(ServerEvent.NOTICE, { level: "warn", text: `A bounty has been placed on outlaw ${p.name}` });
    if (p.pet && res.pet && res.pet.xp > p.pet.xp) {
      p.pet.xp = res.pet.xp;
      p.pet.level = Math.max(p.pet.level, res.pet.level);
    }
  }

  // ------------------------------------------------------------------------
  // Companions (pets)
  // ------------------------------------------------------------------------

  private spawnPet(p: PlayerActor): void {
    const pr = p.profile.pet;
    if (!pr) return;
    const entity = new Entity();
    const pet: PetActor = {
      id: `pet${p.id}`, kind: "PET", ownerSessionId: p.sessionId, rowId: pr.rowId, def: pr.def, name: pr.name, level: pr.level, xp: pr.xp,
      x: p.x - this.rules.petFollowDistance, y: p.y, heading: p.heading, nextCollectAt: 0, nextHintAt: 0, hintKey: "", entity,
    };
    entity.id = pet.id;
    entity.kind = "PET";
    entity.defId = pr.def.id;
    entity.name = pr.name;
    entity.targetId = p.id;
    entity.faction = p.faction;
    entity.team = p.team;
    entity.maxHull = 1;
    entity.hull = 1;
    p.pet = pet;
    this.state.entities.set(pet.id, entity);
    this.syncPet(p);
  }

  private syncPet(p: PlayerActor): void {
    const pet = p.pet;
    if (!pet) return;
    const e = pet.entity;
    e.x = pet.x;
    e.y = pet.y;
    e.heading = pet.heading;
    e.level = Math.min(255, pet.level);
    e.dead = p.dead;
    e.cloaked = p.cloaked;
  }

  /** Follow the owner; LOOT_COLLECT, REPAIR and RESOURCE_DETECTION behaviours. */
  private tickPet(p: PlayerActor, dt: number): void {
    const pet = p.pet;
    if (!pet) return;
    const d = this.rules.petFollowDistance;
    const tx = p.x - Math.cos(p.heading) * d;
    const ty = p.y - Math.sin(p.heading) * d;
    const dist = Math.hypot(tx - pet.x, ty - pet.y);
    if (dist > 60) {
      pet.x = tx;
      pet.y = ty;
    } else {
      const k = Math.min(1, 8 * dt);
      pet.x += (tx - pet.x) * k;
      pet.y += (ty - pet.y) * k;
    }
    pet.heading = p.heading;
    const scale = petScale(pet.level, pet.def);
    if (!p.dead && p.connected) {
      if (hasPetAbility(pet.def, "LOOT_COLLECT") && this.now >= pet.nextCollectAt) {
        pet.nextCollectAt = this.now + 500;
        for (const g of this.grid.query(pet.x, pet.y, pet.def.lootRadius)) {
          const l = g.ref;
          if (l.kind !== "LOOT" || l.claimed) continue;
          if (l.ownerUserId && l.ownerUserId !== p.userId && this.now < l.ownerUntil) continue;
          void this.onPickup(p, l.id, { x: pet.x, y: pet.y, range: pet.def.lootRadius });
        }
      }
      if (hasPetAbility(pet.def, "REPAIR") && pet.def.repairPerSecond > 0 && p.hull < p.maxHull && this.now - p.lastDamagedAt > this.rules.combatLockMs) {
        p.hull = Math.min(p.maxHull, p.hull + pet.def.repairPerSecond * scale * dt);
      }
      if (hasPetAbility(pet.def, "RESOURCE_DETECTION") && this.now >= pet.nextHintAt) {
        pet.nextHintAt = this.now + 3000;
        const range = this.aoiRadiusFor(p) * 2;
        let best: AsteroidActor | null = null;
        let bd = range * range;
        for (const a of this.asteroids.values()) {
          if (a.depleted) continue;
          const dd = (a.x - p.x) ** 2 + (a.y - p.y) ** 2;
          if (dd < bd) { bd = dd; best = a; }
        }
        const key = best?.id ?? "";
        if (key !== pet.hintKey) {
          pet.hintKey = key;
          this.emitPet(p, best ? { asteroidId: best.id, resource: best.state.resource, x: best.x, y: best.y, distance: Math.sqrt(bd) } : null);
        }
      }
    }
    this.syncPet(p);
  }

  /** RADAR: companion extends the owner's area of interest. */
  protected aoiRadiusFor(p: PlayerActor): number {
    const base = this.svc.config.aoiRadius;
    const pet = p.pet;
    if (!pet || !hasPetAbility(pet.def, "RADAR")) return base;
    return base * (1 + pet.def.radarBonus * petScale(pet.level, pet.def));
  }

  /** Companion XP from the owner's kills; level-ups rescale the passive buff. */
  protected givePetXp(p: PlayerActor, ownerXp: number): void {
    const pet = p.pet;
    if (!pet || ownerXp <= 0) return;
    const gain = Math.floor(ownerXp * this.rules.petXpShare);
    if (gain <= 0) return;
    const before = pet.level;
    pet.xp += gain;
    p.pending.petXp += gain;
    pet.level = petLevelForXp(pet.xp, pet.def);
    if (pet.level !== before) {
      this.recomputeStats(p);
      this.emitPet(p, undefined);
      this.requestFlush(p);
    }
  }

  /** Recompute effective stats (e.g. pet buff level changed) keeping hull/shield/energy ratios. */
  protected recomputeStats(p: PlayerActor): void {
    const stats = computeStats({ ...p.profile.loadout, petBuff: p.pet ? petBuff(p.pet.def, p.pet.level) : undefined, pvpNormalized: this.pvpNormalized() }, this.tuning);
    const r = (v: number, m: number) => (m > 0 ? v / m : 1);
    const hr = r(p.hull, p.maxHull);
    const sr = r(p.shield, p.maxShield);
    const er = r(p.energy, p.maxEnergy);
    p.stats = stats;
    p.maxHull = stats.hull;
    p.maxShield = stats.shield;
    p.maxEnergy = stats.energy;
    p.hull = stats.hull * hr;
    p.shield = stats.shield * sr;
    p.energy = stats.energy * er;
  }

  /** `hint`: undefined = unchanged (status only), null = no asteroid in range. */
  protected emitPet(p: PlayerActor, hint: ServerEvents["pet"]["hint"] | undefined): void {
    const pet = p.pet;
    if (!pet || !p.connected) return;
    this.emitTo(p.client, ServerEvent.PET, {
      entityId: pet.id, petId: pet.def.id, name: pet.name, level: pet.level, xp: pet.xp, xpToNext: petXpToNext(pet.xp, pet.def),
      abilities: [...pet.def.abilities], ...(hint !== undefined ? { hint } : {}),
    });
  }

  // ------------------------------------------------------------------------
  // Abilities
  // ------------------------------------------------------------------------

  private onAbility(p: PlayerActor, slot: AbilitySlotDef | undefined, dir?: { x: number; y: number }): void {
    const r = activateAbility(p.abilities, slot, { now: this.now, energy: p.energy, cooldownReductionPct: p.stats.pct.cooldownReduction, stunned: this.now < p.stunnedUntil, dead: p.dead });
    if (!r.ok) {
      if (r.reason === "COOLDOWN" && p.cooldownTracker.record(this.now)) this.flag(p, "COOLDOWN_BYPASS", 15, { slot: slot?.id });
      return this.error(p, `ABILITY_${r.reason}`, r.reason === "COOLDOWN" ? "Ability on cooldown" : `Cannot activate (${r.reason})`);
    }
    if (p.docked) return this.error(p, "ABILITY_DOCKED", "Undock first");
    p.abilities = r.state;
    p.energy -= r.energyCost;
    this.applyEffect(p, r.effect, dir);
  }

  private applyEffect(p: PlayerActor, e: AbilityEffect, dir?: { x: number; y: number }): void {
    switch (e.type) {
      case "SHIELD_RESTORE":
        p.shield = Math.min(p.maxShield, p.shield + p.maxShield * (e.percent / 100));
        this.sendNear(p.x, p.y, ServerEvent.EFFECT, { kind: "SHIELD_BURST", x: p.x, y: p.y, radius: 6, sourceId: p.id });
        break;
      case "HULL_REPAIR":
        p.hull = Math.min(p.maxHull, p.hull + p.maxHull * (e.percent / 100));
        this.sendNear(p.x, p.y, ServerEvent.EFFECT, { kind: "HEAL", x: p.x, y: p.y, radius: 6, sourceId: p.id });
        break;
      case "EMP":
        this.sendNear(p.x, p.y, ServerEvent.EFFECT, { kind: "EMP", x: p.x, y: p.y, radius: e.radius, sourceId: p.id });
        for (const g of this.grid.query(p.x, p.y, e.radius)) {
          const o = g.ref;
          if (o === p || (o.kind !== "PLAYER" && o.kind !== "NPC" && o.kind !== "BOSS") || !this.hostile(p, o)) continue;
          const t = o as ShipActor;
          if (this.now < t.invulnerableUntil) continue;
          const r = applyEmp(t.shield, t.maxShield, e.shieldDamagePercent, e.stunMs, this.now, t.stats.resistances.EM ?? 0);
          t.shield = r.shieldAfter;
          t.stunnedUntil = r.stunnedUntil;
          t.shieldDisruptedUntil = r.shieldDisruptedUntil;
          t.lastDamagedAt = this.now;
          t.damageBy.set(p.id, (t.damageBy.get(p.id) ?? 0) + r.shieldDamage);
          t.lastHitBy.set(p.id, this.now);
          if (t.kind === "PLAYER") (t as PlayerActor).abilities = breakCloak((t as PlayerActor).abilities);
        }
        break;
      case "BARRAGE":
        this.areaAttack(p, e.radius, e.damage * (1 + p.stats.pct.damage / 100), e.element, "BARRAGE");
        break;
      case "DASH": {
        const before = { x: p.x, y: p.y };
        const d = applyDash(p, dir?.x ?? Math.cos(p.heading), dir?.y ?? Math.sin(p.heading), e.distance, { width: this.map.width, height: this.map.height });
        const chk = checkDisplacement(before, d, 0, 0, 1, e.distance + 0.5);
        if (!chk.ok) {
          this.flag(p, "TELEPORT", 20, { distance: chk.distance });
          return;
        }
        p.x = d.x;
        p.y = d.y;
        this.sendNear(p.x, p.y, ServerEvent.EFFECT, { kind: "DASH", x: before.x, y: before.y, radius: e.distance, sourceId: p.id });
        break;
      }
      case "CLOAK":
        p.cloaked = true;
        this.sendNear(p.x, p.y, ServerEvent.EFFECT, { kind: "CLOAK", x: p.x, y: p.y, radius: 5, sourceId: p.id });
        break;
      case "SPEED_BOOST":
      case "DAMAGE_BOOST":
      case "DAMAGE_REDUCTION":
      case "PASSIVE_STAT":
        break;
    }
  }

  // ------------------------------------------------------------------------
  // World: mining, loot expiry, asteroids
  // ------------------------------------------------------------------------

  protected spawnAsteroids(): void {
    let n = 0;
    this.map.asteroidFields.forEach((f, fi) => {
      for (let i = 0; i < f.count; i++) {
        const a = this.rng() * Math.PI * 2;
        const r = Math.sqrt(this.rng()) * f.radius;
        const resource = pickAsteroidResource(f.resources, this.rng);
        const id = `a${++n}`;
        const entity = new Entity();
        const amount = this.rules.asteroidAmount;
        const ast: AsteroidActor = {
          id, kind: "ASTEROID", x: f.x + Math.cos(a) * r, y: f.y + Math.sin(a) * r, state: { resource, amount, progress: 0 },
          initialAmount: amount, field: fi, respawnAt: 0, depleted: false, entity,
        };
        entity.id = id;
        entity.kind = "ASTEROID";
        entity.name = resource;
        entity.defId = resource;
        entity.x = ast.x;
        entity.y = ast.y;
        entity.hull = amount;
        entity.maxHull = amount;
        entity.team = -1;
        entity.heading = this.rng() * Math.PI * 2;
        this.asteroids.set(id, ast);
        this.state.entities.set(id, entity);
      }
    });
  }

  private tickMining(p: PlayerActor, dt: number): void {
    if (!p.miningTarget || p.dead || p.docked) {
      if (p.flags & EntityFlag.MINING) p.flags &= ~EntityFlag.MINING;
      return;
    }
    const a = this.asteroids.get(p.miningTarget);
    if (!a || a.depleted) {
      p.miningTarget = null;
      return;
    }
    const miners = p.stats.weapons.filter((w) => w.mining);
    const range = miners.length ? Math.max(...miners.map((w) => w.range)) : this.rules.miningRange;
    if (Math.hypot(a.x - p.x, a.y - p.y) > range) return;
    let power = miners.reduce((s, w) => s + w.damage * w.fireRate, 0);
    if (power <= 0) power = p.stats.weapons.filter((w) => w.group === "PRIMARY" && !w.mining).reduce((s, w) => s + w.damage * w.fireRate, 0) * this.rules.unarmedMiningFactor;
    const hardness = resourceHardness(ITEMS_BY_ID.get(itemIdForResource(a.state.resource))?.baseValue ?? 10);
    const free = p.stats.cargo - p.cargoUsed;
    if (free <= 0) {
      p.miningTarget = null;
      return this.error(p, "CARGO_FULL", "Cargo hold full — dock to unload");
    }
    const r = mineStep(a.state, power, p.stats.pct.miningSpeed, dt, free, hardness);
    a.state = r.asteroid;
    p.flags |= EntityFlag.MINING;
    if (r.extracted > 0) {
      p.cargoUsed += r.extracted;
      p.pending.addResource(a.state.resource, r.extracted);
      p.pending.resourcesMined += r.extracted;
      a.entity.hull = a.state.amount;
      this.questEvent(p, { type: "MINE", resourceId: a.state.resource, quantity: r.extracted, mapId: this.map.id });
      if (this.tickCount % 10 === 0) this.sendNear(a.x, a.y, ServerEvent.EFFECT, { kind: "MINING", x: a.x, y: a.y, radius: 3, sourceId: p.id });
    }
    if (r.depleted) {
      a.depleted = true;
      a.respawnAt = this.now + this.rules.asteroidRespawnMs;
      a.entity.dead = true;
      p.miningTarget = null;
    }
  }

  private tickWorld(): void {
    if (this.tickCount % PVP_KILL_LOG_PRUNE_TICKS === 0) this.prunePvpKillLog();
    for (const rp of this.riftPortals.values()) if (this.now >= rp.expiresAt) this.closeRiftPortal(rp);
    for (const l of this.loot.values()) if (this.now >= l.expiresAt) this.removeLoot(l);
    for (const a of this.asteroids.values()) {
      if (a.depleted && this.now >= a.respawnAt) {
        a.depleted = false;
        a.state = { ...a.state, amount: a.initialAmount, progress: 0 };
        a.entity.dead = false;
        a.entity.hull = a.initialAmount;
      }
    }
  }

  /** Drop PvP pair entries that can no longer affect anti-farming checks (window / 60s flag horizon). */
  protected prunePvpKillLog(): void {
    const horizon = Math.max(this.rules.pvpSameVictimWindowMs, 60_000);
    for (const [k, t] of this.pvpKillLog) if (this.now - t >= horizon) this.pvpKillLog.delete(k);
  }

  // ------------------------------------------------------------------------
  // Dock / jump / chat
  // ------------------------------------------------------------------------

  private onDock(p: PlayerActor, stationId: string): void {
    if (p.dead) return;
    const st = stationInRange(this.map, stationId, p.x, p.y, this.rules.dockRange);
    if (!st) return this.error(p, "DOCK_OUT_OF_RANGE", "Station out of range");
    if (this.now - p.lastDamagedAt < this.rules.combatLockMs) return this.error(p, "IN_COMBAT", "Cannot dock during combat");
    if (st.faction && p.profile.factionId && st.faction !== p.profile.factionId && !st.services.includes("DOCK")) return this.error(p, "DOCK_DENIED", "Docking denied");
    p.docked = st.id;
    p.vx = 0;
    p.vy = 0;
    p.firing.PRIMARY = false;
    p.firing.SECONDARY = false;
    p.miningTarget = null;
    p.cargoUsed = 0; // cargo unloaded into station storage (already credited to PlayerResource)
    p.pending.position = { mapId: this.map.id, x: p.x, y: p.y };
    if (st.services.includes("REPAIR") && p.hull < p.maxHull) {
      const missing = p.maxHull - p.hull;
      const cost = repairCost(missing, PROGRESSION);
      const key = `repair:${this.roomId}:${p.userId}:${this.now}`;
      this.svc.persistence.chargeCredits(p.userId, cost, key, "station_repair", true)
        .then((charged) => {
          if (p.left) return;
          const fraction = cost > 0n ? Number(charged) / Number(cost) : 1;
          p.hull = Math.min(p.maxHull, p.hull + missing * fraction);
          if (charged < cost) this.emitTo(p.client, ServerEvent.NOTICE, { level: "warn", text: "Insufficient credits for a full repair" });
        })
        .catch((e: unknown) => this.log.error({ err: e }, "repair failed"));
    }
    this.emitTo(p.client, ServerEvent.DOCKED, { stationId: st.id, services: st.services });
    this.requestFlush(p);
  }

  private async onJump(p: PlayerActor, portalId: string): Promise<void> {
    if (p.dead || p.docked) return this.error(p, "CANNOT_JUMP", "Cannot jump now");
    const rift = this.riftPortals.get(portalId);
    if (rift) return this.jumpRift(p, rift);
    const portal = this.map.portals.find((x) => x.id === portalId);
    const near = nearestPortal(this.map, p.x, p.y, this.rules.portalRange);
    if (!portal || !near || near.id !== portal.id) return this.error(p, "PORTAL_OUT_OF_RANGE", "Fly into the portal to jump");
    if (p.level < portal.requiredLevel) return this.error(p, "LEVEL_TOO_LOW", `Requires level ${portal.requiredLevel}`);
    if (this.now - p.lastDamagedAt < this.rules.combatLockMs) return this.error(p, "IN_COMBAT", "Jump drive locked during combat");
    const target = MAPS_BY_ID.get(portal.targetMap);
    if (!target) return this.error(p, "BAD_PORTAL", "Portal destination offline");
    const roomName = ROOM_FOR_MAP_TYPE[target.roomType];
    try {
      const ticket = await this.svc.tickets.issue(p.userId, p.name, target.id);
      const instanceKey = target.roomType === "gate" || target.roomType === "raid" ? `solo:${p.userId}` : undefined;
      const reservation = await matchMaker.joinOrCreate(roomName, { ticket, mapId: target.id, portalId: portal.targetPortal, instanceKey });
      const tp = target.portals.find((x) => x.id === portal.targetPortal);
      p.jumpedTo = { mapId: target.id, x: tp?.x ?? target.width / 2, y: tp?.y ?? target.height / 2 };
      p.pending.position = p.jumpedTo;
      this.emitTo(p.client, ServerEvent.JUMP, { mapId: target.id, portalId: portal.targetPortal, roomName, reservation });
      this.sendNear(p.x, p.y, ServerEvent.EFFECT, { kind: "WARP", x: p.x, y: p.y, radius: 10, sourceId: p.id });
      this.requestFlush(p);
    } catch (e) {
      this.log.error({ err: e, portalId }, "jump failed");
      this.error(p, "JUMP_FAILED", "Jump failed, try again");
    }
  }

  private async jumpRift(p: PlayerActor, rp: RiftPortal): Promise<void> {
    if (Math.hypot(rp.x - p.x, rp.y - p.y) > this.rules.portalRange) return this.error(p, "PORTAL_OUT_OF_RANGE", "Fly into the rift gate to jump");
    if (this.now - p.lastDamagedAt < this.rules.combatLockMs) return this.error(p, "IN_COMBAT", "Jump drive locked during combat");
    const target = MAPS_BY_ID.get(rp.targetMap);
    if (!target) return this.error(p, "BAD_PORTAL", "Rift destination offline");
    try {
      const ticket = await this.svc.tickets.issue(p.userId, p.name, target.id);
      const instanceKey = `${rp.eventId}:${rp.windowStart}`;
      const reservation = await matchMaker.joinOrCreate(RoomName.EVENT, { ticket, mapId: target.id, instanceKey });
      // The rift instance is temporary: persist the player at the gate they entered from.
      p.jumpedTo = { mapId: this.map.id, x: rp.x, y: rp.y };
      p.pending.position = p.jumpedTo;
      this.emitTo(p.client, ServerEvent.JUMP, { mapId: target.id, portalId: rp.id, roomName: RoomName.EVENT, reservation });
      this.sendNear(p.x, p.y, ServerEvent.EFFECT, { kind: "WARP", x: p.x, y: p.y, radius: 10, sourceId: p.id });
      this.requestFlush(p);
    } catch (e) {
      this.log.error({ err: e, portalId: rp.id }, "rift jump failed");
      this.error(p, "JUMP_FAILED", "Rift jump failed, try again");
    }
  }

  private async subscribeChat(): Promise<void> {
    const handler = (topic: string, filter: (p: PlayerActor, e: ChatEvent) => boolean) => {
      const cb = (data: unknown) => {
        const e = data as ChatEvent;
        if (!e || typeof e.text !== "string") return;
        for (const p of this.players.values()) if (p.connected && filter(p, e)) this.emitTo(p.client, ServerEvent.CHAT, e);
      };
      this.presenceSubs.push({ topic, cb });
      return this.presence.subscribe(topic, cb);
    };
    await handler(CHAT_TOPIC_GLOBAL, () => true);
  }

  private async ensureTopic(topic: string, filter: (p: PlayerActor, e: ChatEvent) => boolean): Promise<void> {
    if (this.presenceSubs.some((s) => s.topic === topic)) return;
    const cb = (data: unknown) => {
      const e = data as ChatEvent;
      for (const p of this.players.values()) if (p.connected && filter(p, e)) this.emitTo(p.client, ServerEvent.CHAT, e);
    };
    this.presenceSubs.push({ topic, cb });
    await this.presence.subscribe(topic, cb);
  }

  /** Mutes: User.mutedUntil / CHAT_MUTED restriction (loaded at join) and Redis `mute:<userId>` (set live by admins). */
  private async isMuted(p: PlayerActor): Promise<boolean> {
    if ((p.profile.mutedUntil && p.profile.mutedUntil.getTime() > Date.now()) || p.profile.restrictions.includes("CHAT_MUTED")) return true;
    if (!this.svc.redis) return false;
    try {
      return (await this.svc.redis.exists(`mute:${p.userId}`)) === 1;
    } catch {
      return false;
    }
  }

  private async onChat(p: PlayerActor, m: ParsedMessages["chat"]): Promise<void> {
    if (!p.chat.take(Date.now())) return this.error(p, "CHAT_RATE_LIMIT", "Slow down");
    if (await this.isMuted(p)) return this.error(p, "MUTED", "You are muted");
    if (!p.connected) return;
    const text = sanitizeChat(m.text);
    if (!text) return;
    const evt: ChatEvent = { channel: m.channel, from: p.name, fromId: p.userId, text, at: Date.now(), faction: p.profile.factionId ?? undefined };
    let key = "";
    switch (m.channel) {
      case "LOCAL":
        key = this.map.id;
        this.sendNear(p.x, p.y, ServerEvent.CHAT, evt, undefined, this.svc.config.aoiRadius * 1.5);
        break;
      case "GLOBAL":
        this.presence.publish(CHAT_TOPIC_GLOBAL, evt);
        break;
      case "FACTION": {
        if (!p.profile.factionId) return this.error(p, "NO_FACTION", "No faction");
        key = p.profile.factionId;
        const topic = chatTopicFaction(key);
        void this.ensureTopic(topic, (o, e) => o.profile.factionId === e.faction).then(() => this.presence.publish(topic, evt));
        break;
      }
      case "CLAN": {
        const clanId = p.profile.clanId;
        if (!clanId) return this.error(p, "NO_CLAN", "Not in a clan");
        key = clanId;
        const topic = chatTopicClan(clanId);
        void this.ensureTopic(topic, (o) => o.profile.clanId === clanId).then(() => this.presence.publish(topic, evt));
        break;
      }
      case "SQUAD":
        key = p.profile.squadId ?? `team:${p.team}`;
        for (const o of this.players.values()) {
          const same = p.profile.squadId ? o.profile.squadId === p.profile.squadId : this.isTeamRoom() && o.team === p.team;
          if (o.connected && (same || o === p)) this.emitTo(o.client, ServerEvent.CHAT, evt);
        }
        break;
    }
    this.chatBuffer.push({ channel: m.channel, channelKey: key, senderId: p.userId, text });
  }

  private async flushChat(): Promise<void> {
    if (!this.chatBuffer.length) return;
    const rows = this.chatBuffer.splice(0, this.chatBuffer.length);
    try {
      await this.svc.persistence.saveChat(rows);
    } catch (e) {
      this.log.error({ err: e }, "chat persist failed");
    }
  }

  // ------------------------------------------------------------------------
  // Events engine integration
  // ------------------------------------------------------------------------

  private attachEvents(): void {
    const apply = () => {
      const m = this.svc.events.multipliers(this.map.id);
      this.xpMultiplier = m.xp;
      this.dropMultiplier = m.drop;
      this.state.xpMultiplier = m.xp;
      this.state.dropMultiplier = m.drop;
      const act = this.svc.events.activeFor(this.map.id)[0];
      this.state.eventId = act?.def.id ?? "";
      this.state.eventName = act?.def.name ?? "";
      this.state.eventEndsAt = act?.window.end ?? 0;
    };
    // Global rifts are announced in every room (notice carries the affected map list);
    // map-local effects (multipliers, portals, bosses) only apply on the listed maps.
    const started = (a: ActiveEvent) => {
      const here = a.def.maps.includes(this.map.id);
      if (!here && a.def.type !== "GLOBAL_RIFT") return;
      this.broadcast(ServerEvent.EVENT_STARTED, EventEngine.notice(a));
      if (!here) return;
      apply();
      this.onEventStarted(a);
    };
    const finished = (a: ActiveEvent) => {
      const here = a.def.maps.includes(this.map.id);
      if (!here && a.def.type !== "GLOBAL_RIFT") return;
      this.broadcast(ServerEvent.EVENT_FINISHED, EventEngine.notice(a));
      if (!here) return;
      apply();
      this.onEventFinished(a);
    };
    this.eventListeners = { started, finished };
    this.svc.events.on("started", started);
    this.svc.events.on("finished", finished);
    apply();
    for (const a of this.svc.events.activeFor(this.map.id)) this.onEventStarted(a);
  }

  /**
   * Default event handling on a listed map:
   * - GLOBAL_RIFT in open-world rooms: a temporary EVENT_GATE portal opens (despawns at event end)
   *   leading into the shared rift instance (EventRoom) where the rift boss lives.
   * - Other boss events (and the rift instance itself): the event boss spawns here.
   */
  protected onEventStarted(a: ActiveEvent): void {
    if (a.def.type === "GLOBAL_RIFT" && (this.roomKind === RoomName.SECTOR || this.roomKind === RoomName.BOSS)) {
      this.openRiftPortal(a);
      return;
    }
    if (!a.def.boss || this.riftBossIds.has(`${a.def.id}:${a.window.start}`)) return;
    if (this.roomKind !== RoomName.SECTOR && this.roomKind !== RoomName.BOSS && this.roomKind !== RoomName.EVENT) return;
    if ([...this.npcs.values()].some((n) => n.def.id === a.def.boss && !n.dead)) return;
    const def = NPCS_BY_ID.get(a.def.boss);
    if (!def) return;
    this.riftBossIds.add(`${a.def.id}:${a.window.start}`);
    const x = this.map.width * (0.35 + this.rng() * 0.3);
    const y = this.map.height * (0.35 + this.rng() * 0.3);
    const n = this.spawnNpc(def, x, y, { spawnIndex: null, homeRadius: 40, tag: `event:${a.def.id}:${a.window.start}` });
    n.removeAt = a.window.end;
    this.broadcast(ServerEvent.NOTICE, { level: "warn", text: `${a.def.name}: ${def.name} has emerged!` });
    this.broadcast(ServerEvent.EFFECT, { kind: "WARP", x, y, radius: 60, sourceId: n.id });
  }

  protected onEventFinished(a: ActiveEvent): void {
    for (const rp of [...this.riftPortals.values()]) if (rp.eventId === a.def.id && rp.windowStart === a.window.start) this.closeRiftPortal(rp);
    for (const n of [...this.npcs.values()]) {
      if (n.tag === `event:${a.def.id}:${a.window.start}` && !n.dead) {
        // Boss survived the event window: participants are still paid by contribution tier.
        const participants = [...n.damageBy.keys()].map((id) => this.players.get(id)).filter((p): p is PlayerActor => !!p);
        void this.distributeBossRewards(n, participants);
        this.broadcast(ServerEvent.NOTICE, { level: "info", text: `${n.name} retreated into the rift` });
        this.removeNpc(n);
      }
    }
  }

  /** Map hosting a rift instance: the event map whose roomType is "boss", else the first listed map. */
  static riftTargetMap(def: EventDef): string {
    return def.maps.find((m) => MAPS_BY_ID.get(m)?.roomType === "boss") ?? def.maps[0] ?? "";
  }

  protected openRiftPortal(a: ActiveEvent): void {
    const id = `rift:${a.def.id}:${a.window.start}`;
    if (this.riftPortals.has(id)) return;
    const x = this.map.width * (0.3 + this.rng() * 0.4);
    const y = this.map.height * (0.3 + this.rng() * 0.4);
    const entity = new Entity();
    entity.id = id;
    entity.kind = "PORTAL";
    entity.name = a.def.name;
    entity.defId = "EVENT_GATE";
    entity.x = x;
    entity.y = y;
    entity.hull = 1;
    entity.maxHull = 1;
    entity.team = -1;
    entity.aiState = a.def.id;
    const rp: RiftPortal = { id, x, y, eventId: a.def.id, windowStart: a.window.start, expiresAt: a.window.end, targetMap: BaseGameRoom.riftTargetMap(a.def), entity };
    this.riftPortals.set(id, rp);
    this.state.entities.set(id, entity);
    for (const p of this.players.values()) this.updateAoiFor(p);
    this.broadcast(ServerEvent.NOTICE, { level: "warn", text: `${a.def.name}: a rift gate has opened in ${this.map.name}!` });
    this.broadcast(ServerEvent.EFFECT, { kind: "WARP", x, y, radius: 40, sourceId: id });
  }

  protected closeRiftPortal(rp: RiftPortal): void {
    this.riftPortals.delete(rp.id);
    this.state.entities.delete(rp.id);
    for (const p of this.players.values()) p.visible.delete(rp.id);
    this.broadcast(ServerEvent.NOTICE, { level: "info", text: "The rift gate collapsed" });
  }

  getRiftPortals(): RiftPortal[] {
    return [...this.riftPortals.values()];
  }

  // ------------------------------------------------------------------------
  // Persistence scheduling
  // ------------------------------------------------------------------------

  protected requestFlush(p: PlayerActor): void {
    if (p.flushRequested) return;
    p.flushRequested = true;
    this.clock.setTimeout(() => {
      p.flushRequested = false;
      void this.flushPlayer(p, false);
    }, 250);
  }

  protected async flushAll(final: boolean): Promise<void> {
    await Promise.all([...this.players.values()].map((p) => this.flushPlayer(p, final)));
    await this.flushChat();
    // Clan-mission progress rides along with the persistence flush (fire-and-forget, own retries).
    void this.svc.clanMissions.flush();
  }

  private flushContext(p: PlayerActor): FlushContext {
    return {
      factionId: p.profile.factionId,
      pet: p.pet ? { rowId: p.pet.rowId, def: p.pet.def } : p.profile.pet ? { rowId: p.profile.pet.rowId, def: p.profile.pet.def } : null,
    };
  }

  /** Returns false only when the persistence transaction itself failed (delta restored into `p.pending`). */
  protected async flushPlayer(p: PlayerActor, final: boolean, waitInFlight = final): Promise<boolean> {
    this.accruePlaytime(p);
    if (final && !p.pending.position) p.pending.position = p.jumpedTo ?? this.exitPosition(p);
    const hasQuestChanges = [...p.profile.quests.values()].some((q) => q.dirty);
    if (p.pending.isEmpty() && !hasQuestChanges && !final) return true;
    if (p.flushing) {
      if (waitInFlight) {
        // wait for the in-flight flush then flush the rest
        for (let i = 0; i < 100 && p.flushing; i++) await new Promise((r) => setTimeout(r, 50));
      } else return true;
    }
    p.flushing = true;
    const delta = p.pending;
    p.pending = new PendingDelta();
    let res: FlushResult;
    try {
      res = await this.svc.persistence.flush(p.userId, delta, p.profile.quests.values(), p.profile.achievements, this.flushContext(p));
    } catch (e) {
      // Keep the failed delta as a separate part with its own flushId (NOT merged into the newer increments):
      // if its transaction did commit before the error surfaced, the retry recognises the id and skips it.
      errorsTotal.inc({ component: "persistence", code: "flush" });
      this.log.error({ err: e, userId: p.userId }, "flush failed; will retry");
      p.pending.carryFailed(delta);
      p.flushing = false;
      return false;
    }
    // Post-commit bookkeeping: failures here must NEVER re-queue the committed delta (double increments).
    try {
      // Only whole resource units are persisted; the fractional rest rides along with the next flush.
      for (const [id, rest] of res.resourceRemainder) p.pending.addResource(id, rest);
      if (res.level > p.level && !p.left) {
        p.level = res.level;
        this.sendNear(p.x, p.y, ServerEvent.PLAYER_LEVEL_UP, { userId: p.userId, level: p.level, entityId: p.id });
      }
      if (res.xp > p.xp) p.xp = res.xp;
      this.applyFlushSocial(p, res);
      for (const a of res.newAchievements) {
        if (p.connected) this.emitTo(p.client, ServerEvent.NOTICE, { level: "success", text: `Achievement unlocked: ${a.name}` });
      }
      if (!final && this.tickCount % 3 === 0) {
        // pick up quests accepted through the API while in game
        const fresh = await loadActiveQuests(this.svc.db, p.userId);
        for (const [id, q] of fresh) if (!p.profile.quests.has(id)) p.profile.quests.set(id, q);
      }
    } catch (e) {
      errorsTotal.inc({ component: "persistence", code: "post_flush" });
      this.log.warn({ err: e, userId: p.userId }, "post-flush sync failed (delta already committed)");
    } finally {
      p.flushing = false;
    }
    return true;
  }

  // ------------------------------------------------------------------------
  // Quests
  // ------------------------------------------------------------------------

  protected questEvent(p: PlayerActor, ev: GameplayEvent): void {
    this.svc.clanMissions.report(p.userId, p.profile.clanId, ev);
    for (const q of p.profile.quests.values()) {
      if (q.status !== "ACTIVE") continue;
      const r = applyQuestEvent(q.def, q.progress, ev);
      if (!r.changed) continue;
      q.progress = r.progress;
      q.dirty = true;
      if (p.connected) this.emitTo(p.client, ServerEvent.QUEST_PROGRESS, { questId: q.def.id, progress: r.progress });
      if (r.completed) {
        q.status = "COMPLETED";
        if (p.connected) this.emitTo(p.client, ServerEvent.QUEST_COMPLETE, { questId: q.def.id, name: q.def.name });
        this.requestFlush(p);
      }
    }
  }

  // ------------------------------------------------------------------------
  // Interest management (StateView AOI)
  // ------------------------------------------------------------------------

  protected updateAoiFor(p: PlayerActor): void {
    const view = p.client.view;
    if (!view || !p.connected) return;
    const radius = this.aoiRadiusFor(p);
    const scan = p.pet && hasPetAbility(p.pet.def, "ENEMY_SCAN") ? this.rules.petScanRadius * petScale(p.pet.level, p.pet.def) : 0;
    const want = new Set<string>([p.id]);
    for (const g of this.grid.query(p.x, p.y, radius)) {
      const o = g.ref;
      // Cloaked enemies stay hidden unless the viewer's companion scans them (ENEMY_SCAN radius);
      // a revealed entity arrives with `cloaked: true`, which is the client's "scanned" indicator.
      if (o.kind === "PLAYER" && o !== p && o.cloaked && o.team !== p.team && o.faction !== p.faction && !(scan > 0 && (o.x - p.x) ** 2 + (o.y - p.y) ** 2 <= scan * scan)) continue;
      if (o.kind === "ASTEROID" && o.depleted) continue;
      want.add(o.id);
    }
    // Keep the room's boss always visible (large fights: boss is the objective).
    if (this.state.bossId && this.npcs.has(this.state.bossId)) want.add(this.state.bossId);
    // Rift gates are map-wide objectives: visible to everyone on the map.
    for (const id of this.riftPortals.keys()) want.add(id);
    for (const id of p.visible) {
      if (want.has(id)) continue;
      const e = this.state.entities.get(id);
      if (e) view.remove(e);
      p.visible.delete(id);
      p.firstSeen.delete(id);
    }
    for (const id of want) {
      if (p.visible.has(id)) continue;
      const e = this.state.entities.get(id);
      if (!e) continue;
      view.add(e);
      p.visible.add(id);
      p.firstSeen.set(id, this.now);
    }
  }

  /** Send an event to clients whose ship is within `radius` of (x, y). */
  protected sendNear<K extends keyof ServerEvents & string>(x: number, y: number, type: K, payload: ServerEvents[K], except?: PlayerActor, radius = this.svc.config.aoiRadius): void {
    const r2 = radius * radius;
    for (const p of this.players.values()) {
      if (p === except || !p.connected) continue;
      if ((p.x - x) ** 2 + (p.y - y) ** 2 <= r2) this.emitTo(p.client, type, payload);
    }
  }

  protected emitTo<K extends keyof ServerEvents & string>(client: Client, type: K, payload: ServerEvents[K]): void {
    client.send(type, payload);
  }

  protected error(p: PlayerActor, code: string, message: string): void {
    if (p.connected) this.emitTo(p.client, ServerEvent.ERROR, { code, message });
  }

  protected flag(p: PlayerActor, type: CheatType, score: number, details: Record<string, unknown>): void {
    this.svc.risk.report(p.userId, type, score, { ...details, room: this.roomKind, map: this.map.id }, `game-server:${this.roomKind}`, this.now);
  }

  // ------------------------------------------------------------------------
  // Utilities
  // ------------------------------------------------------------------------

  protected actorById(id: string): PlayerActor | NpcActor | LootActor | AsteroidActor | null {
    return this.players.get(id) ?? this.npcs.get(id) ?? this.loot.get(id) ?? this.asteroids.get(id) ?? null;
  }

  protected shipById(id: string): PlayerActor | NpcActor | null {
    return this.players.get(id) ?? this.npcs.get(id) ?? null;
  }

  /** Explicit attack permission (targeted fire): hostility plus penalised friendly fire in PvP space. */
  protected attackable(a: ActorBase, b: ActorBase): boolean {
    if (a.kind === "PLAYER" && b.kind === "PLAYER" && a !== b && !a.dead && !b.dead) return this.playersAttackable(a as PlayerActor, b as PlayerActor);
    return this.hostile(a, b);
  }

  protected hostile(a: ActorBase, b: ActorBase): boolean {
    if (a === b || b.dead || a.dead) return false;
    const aShip = a.kind === "PLAYER" || a.kind === "NPC" || a.kind === "BOSS";
    const bShip = b.kind === "PLAYER" || b.kind === "NPC" || b.kind === "BOSS";
    if (!aShip || !bShip) return false;
    if (a.kind === "PLAYER" && b.kind === "PLAYER") return this.playersHostile(a as PlayerActor, b as PlayerActor);
    if (a.kind === "PLAYER" || b.kind === "PLAYER") return true;
    return false;
  }

  protected syncEntity(a: PlayerActor | NpcActor): void {
    const e = a.entity;
    e.x = a.x;
    e.y = a.y;
    e.vx = a.vx;
    e.vy = a.vy;
    e.heading = a.heading;
    e.hull = Math.max(0, Math.round(a.hull));
    e.maxHull = Math.round(a.maxHull);
    e.shield = Math.max(0, Math.round(a.shield));
    e.maxShield = Math.round(a.maxShield);
    e.energy = Math.max(0, Math.round(a.energy));
    e.maxEnergy = Math.round(a.maxEnergy);
    e.level = Math.min(255, a.level);
    e.faction = a.faction;
    e.clanTag = a.clanTag;
    e.team = a.team;
    e.targetId = a.targetId;
    e.cloaked = a.cloaked;
    e.dead = a.dead;
    let flags = a.flags | a.pulseFlags;
    if (a.kind === "PLAYER") {
      const p = a as PlayerActor;
      e.lastSeq = p.lastSeq;
      e.aiState = "";
      if (p.docked) flags |= EntityFlag.DOCKED;
      if (p.firing.PRIMARY || p.firing.SECONDARY) flags |= EntityFlag.FIRING;
      if (p.profile.clanId) flags |= EntityFlag.CLAN;
      const rep = PROGRESSION.reputation;
      if (rep && isOutlaw(p.karma, rep)) flags |= EntityFlag.OUTLAW;
      if (p.hasBounty) flags |= EntityFlag.BOUNTY;
      e.cosmetics = p.cosmetics;
    } else {
      e.aiState = (a as NpcActor).brain.state;
    }
    if (this.now < a.stunnedUntil) flags |= EntityFlag.STUNNED;
    e.flags = flags & 0xffff;
    a.pulseFlags = 0;
  }

  /** Test/diagnostic accessors. */
  getPlayerByUser(userId: string): PlayerActor | undefined {
    for (const p of this.players.values()) if (p.userId === userId) return p;
    return undefined;
  }
  getNpcs(): NpcActor[] {
    return [...this.npcs.values()];
  }
  getLoot(): LootActor[] {
    return [...this.loot.values()];
  }
}

