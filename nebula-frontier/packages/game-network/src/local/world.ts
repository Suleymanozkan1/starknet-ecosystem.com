/**
 * Offline, in-browser simulation of a game room (demo mode). It reuses the same
 * `@nebula/game-core` rules as the authoritative server — movement (stepShip),
 * combat (tryFire/resolveHit), NPC brains, abilities, mining, loot and XP — but
 * keeps everything in memory and grants nothing real: there is no database,
 * ledger, wallet or reward budget behind it.
 */
import type {
  AbilityEffect, DroneDef, EntityKind, EntitySnapshot, MapDef, ModuleDef, NpcDef, Rarity, ResourceId, SelfJoinInfo, ServerEvents, WeaponDef,
} from "@nebula/shared";
import { EntityFlag, RARITY_ORDER } from "@nebula/shared";
import {
  DRONES_BY_ID, FACTIONS_BY_ID, ITEMS_BY_ID, LOOT_TABLES_BY_ID, MAPS_BY_ID, MODULES_BY_ID, NPCS_BY_ID, PROGRESSION, SHIPS,
  SHIPS_BY_ID, WEAPONS_BY_ID, itemIdForResource,
} from "@nebula/config";
import {
  DEFAULT_TUNING, IDLE_INPUT, activateAbility, aimTarget, shipHitRadius, applyDash, applyEmp, bossTick, buffModifiers, computeStats, coolHeat,
  createAbilityState, createBrain, grantXp, isSafeAt, isWeakPointHit, levelForXp, mineStep, nearestPortal, npcStats,
  pickAsteroidResource, pruneBuffs, regenerate, resolveAreaDamage, resolveHit, resourceHardness, rollLoot, spawnPoint,
  stationInRange, stepNpcBrain, stepShip, tryFire,
  type AbilitySlotDef, type AbilityState, type AsteroidState, type EffectiveStats, type EffectiveWeapon, type Equipped,
  type HeatState, type HitResult, type LootDrop, type MoveInput, type NpcBrain, type WeaponRuntime,
} from "@nebula/game-core";

/** Pilot the local world simulates (decoded from a demo ticket). */
export interface LocalPilot {
  userId: string;
  name: string;
  factionId: string;
  shipId: string;
  xp: number;
  /** Equipped gear from the hangar (def ids + upgrade levels); the faction starter loadout when absent. */
  loadout?: LocalLoadout;
}

export interface LocalGear { id: string; up: number }
export interface LocalLoadout { shipUpgrade: number; weapons: LocalGear[]; modules: LocalGear[]; drones: LocalGear[] }

export const LOCAL_TICK_RATE = 20;

const RULES = {
  pickupRange: 14,
  dockRange: 25,
  portalRange: 18,
  lootOwnerMs: 20_000,
  lootTtlMs: 90_000,
  spawnProtectionMs: 5_000,
  combatLockMs: 6_000,
  respawnDelayMs: 3_000,
  miningRange: 30,
  unarmedMiningFactor: 0.25,
  asteroidAmount: 40,
  asteroidRespawnMs: 60_000,
};

interface ShipActor {
  e: EntitySnapshot;
  stats: EffectiveStats;
  weaponRt: Map<string, WeaponRuntime>;
  heat: HeatState;
  abilities: AbilityState;
  stunnedUntil: number;
  shieldDisruptedUntil: number;
  lastDamagedAt: number;
  invulnerableUntil: number;
  damageBy: Map<string, number>;
  lastHitBy: Map<string, number>;
  pulse: number;
}

interface PlayerActor extends ShipActor {
  pilot: LocalPilot;
  xp: number;
  inputQueue: (MoveInput & { seq: number })[];
  lastInput: MoveInput;
  lastInputAt: number;
  firing: { PRIMARY: boolean; SECONDARY: boolean };
  docked: string | null;
  miningTarget: string | null;
  cargoUsed: number;
  ammo: Map<string, number>;
  respawnAt: number;
  /** Latest aim point (map coords) and when it arrived; free-aim fire shoots along this line. */
  aimX: number;
  aimY: number;
  aimAt: number;
}

interface NpcActor extends ShipActor {
  def: NpcDef;
  brain: NpcBrain;
  spawnIndex: number | null;
  respawnAt: number;
  removeAt: number;
  nextThinkAt: number;
  move: MoveInput;
  fireAt: string | null;
  bossDamageMult: number;
  bossFireRateMult: number;
  tag: string;
}

interface LootActor {
  e: EntitySnapshot;
  drops: LootDrop[];
  ownerUserId: string | null;
  ownerUntil: number;
  expiresAt: number;
}

interface AsteroidActor {
  e: EntitySnapshot;
  state: AsteroidState;
  depleted: boolean;
  respawnAt: number;
}

/** Output channel of the world (the local connection fans these out to the session). */
export interface LocalWorldSink {
  add(e: EntitySnapshot): void;
  remove(id: string): void;
  event<K extends keyof ServerEvents>(type: K, payload: ServerEvents[K]): void;
}

function blankEntity(id: string, kind: EntityKind, name: string, defId: string, x: number, y: number): EntitySnapshot {
  return {
    id, kind, name, defId, x, y, vx: 0, vy: 0, heading: 0, hull: 1, maxHull: 1, shield: 0, maxShield: 0, energy: 0, maxEnergy: 0,
    level: 1, faction: "", clanTag: "", team: -1, aiState: "", targetId: "", cloaked: false, dead: false, lastSeq: 0, flags: 0, cosmetics: "",
  };
}

function equipped<D>(gear: readonly LocalGear[], lookup: (id: string) => D | undefined): Equipped<D>[] {
  const out: Equipped<D>[] = [];
  for (const g of gear) {
    const def = lookup(g.id);
    if (def) out.push({ def, upgradeLevel: g.up, affixes: [], level: 1 });
  }
  return out;
}

const bare = (ids: readonly string[]): LocalGear[] => ids.map((id) => ({ id, up: 0 }));

/** Effective stats of a pilot's ship with the faction starter loadout (the demo has no hangar persistence). */
export function pilotStats(pilot: LocalPilot): EffectiveStats {
  const faction = FACTIONS_BY_ID.get(pilot.factionId);
  const ship = SHIPS_BY_ID.get(pilot.shipId) ?? (faction ? SHIPS_BY_ID.get(faction.starterShip) : undefined) ?? SHIPS[0];
  if (!ship) throw new Error("No ship definitions available");
  const starter = faction?.starterLoadout ?? { weapons: [], modules: [], drones: [] };
  const lo: LocalLoadout = pilot.loadout ?? { shipUpgrade: 0, weapons: bare(starter.weapons), modules: bare(starter.modules), drones: bare(starter.drones) };
  const weapons = equipped<WeaponDef>(lo.weapons, (id) => WEAPONS_BY_ID.get(id));
  const modules = equipped<ModuleDef>(lo.modules, (id) => MODULES_BY_ID.get(id));
  return computeStats({
    ship,
    shipUpgradeLevel: lo.shipUpgrade,
    lasers: weapons.filter((w) => w.def.slot === "LASER").slice(0, ship.slots.laser),
    missiles: weapons.filter((w) => w.def.slot === "MISSILE").slice(0, ship.slots.missile),
    generators: modules.filter((m) => m.def.slot === "GENERATOR").slice(0, ship.slots.generator),
    modules: modules.filter((m) => m.def.slot === "MODULE").slice(0, ship.slots.module),
    drones: equipped<DroneDef>(lo.drones, (id) => DRONES_BY_ID.get(id)).slice(0, ship.slots.drone),
    factionBonus: faction?.bonus ?? {},
    progression: PROGRESSION,
  });
}

export class LocalWorld {
  readonly map: MapDef;
  readonly localId = "p1";
  readonly state: {
    mapId: string; roomKind: string; region: string; serverTime: number; tick: number; online: number;
    eventId: string; eventName: string; eventEndsAt: number; xpMultiplier: number; dropMultiplier: number;
    bossId: string; bossName: string; bossPhase: number; bossHullPct: number;
  };
  private readonly sink: LocalWorldSink;
  private readonly rng: () => number;
  private now = Date.now();
  private tickCount = 0;
  private seq = 0;
  private player: PlayerActor;
  private readonly npcs = new Map<string, NpcActor>();
  private readonly loot = new Map<string, LootActor>();
  private readonly asteroids = new Map<string, AsteroidActor>();

  constructor(mapId: string, pilot: LocalPilot, portalId: string | null, sink: LocalWorldSink, rng: () => number = Math.random) {
    const map = MAPS_BY_ID.get(mapId);
    if (!map) throw new Error(`Unknown map ${mapId}`);
    this.map = map;
    this.sink = sink;
    this.rng = rng;
    this.state = {
      mapId: map.id, roomKind: map.roomType, region: "local", serverTime: this.now, tick: 0, online: 1,
      eventId: "", eventName: "", eventEndsAt: 0, xpMultiplier: 1, dropMultiplier: 1, bossId: "", bossName: "", bossPhase: 0, bossHullPct: 0,
    };
    this.player = this.createPlayer(pilot, portalId);
  }

  /** Spawn the static world and the pilot; returns SelfJoinInfo for prediction. */
  start(): SelfJoinInfo {
    this.map.spawns.forEach((s, i) => {
      const def = NPCS_BY_ID.get(s.npcId);
      if (!def) return;
      for (let k = 0; k < s.count; k++) {
        const a = this.rng() * Math.PI * 2;
        const r = Math.sqrt(this.rng()) * s.radius;
        this.spawnNpc(def, s.x + Math.cos(a) * r, s.y + Math.sin(a) * r, i, s.radius, "");
      }
    });
    if (this.map.spawns.length === 0 && this.map.roomType !== "pvp") this.spawnFallbackWave();
    this.spawnAsteroids();
    this.sink.add(this.player.e);
    const p = this.player;
    return {
      userId: p.pilot.userId,
      mapId: this.map.id,
      tickRate: LOCAL_TICK_RATE,
      aoiRadius: Math.max(this.map.width, this.map.height),
      motion: { speed: p.stats.speed, acceleration: p.stats.acceleration, turnRate: p.stats.turnRate, maxEnergy: p.e.maxEnergy },
      weapons: p.stats.weapons.map((w) => ({ key: w.key, defId: w.defId, group: w.group, range: w.range, fireRate: w.fireRate })),
      skills: p.stats.skills.map((a, slot) => ({ slot, id: a.id, name: a.name, cooldownMs: a.cooldownMs, energyCost: a.energyCost })),
      modules: p.stats.moduleActives.map((a, slot) => ({ slot, id: a.id, name: a.name, cooldownMs: a.cooldownMs, energyCost: a.energyCost })),
    };
  }

  /** Every live entity (for the connection's entity map). */
  entities(): EntitySnapshot[] {
    return [this.player.e, ...[...this.npcs.values()].map((n) => n.e), ...[...this.loot.values()].map((l) => l.e), ...[...this.asteroids.values()].map((a) => a.e)];
  }

  // ---------------------------------------------------------------------------------------------- setup

  private createPlayer(pilot: LocalPilot, portalId: string | null): PlayerActor {
    const stats = pilotStats(pilot);
    const pos = spawnPoint(this.map, pilot.factionId, portalId);
    const level = levelForXp(pilot.xp, PROGRESSION);
    const e = blankEntity(this.localId, "PLAYER", pilot.name, SHIPS_BY_ID.get(pilot.shipId)?.id ?? FACTIONS_BY_ID.get(pilot.factionId)?.starterShip ?? "", pos.x, pos.y);
    e.hull = e.maxHull = stats.hull;
    e.shield = e.maxShield = stats.shield;
    e.energy = e.maxEnergy = stats.energy;
    e.level = level;
    e.faction = pilot.factionId;
    e.team = 0;
    e.heading = -Math.PI / 2;
    const faction = FACTIONS_BY_ID.get(pilot.factionId);
    const ammo = new Map<string, number>();
    for (const a of faction?.starterLoadout.ammo ?? []) ammo.set(a.itemId, a.quantity);
    // Weapons reference ammo by item def id; map starter stacks (`item_<id>`) onto both spellings.
    for (const w of stats.weapons) if (w.ammo && !ammo.has(w.ammo)) ammo.set(w.ammo, ammo.get(`item_${w.ammo}`) ?? 2000);
    return {
      e, stats, weaponRt: new Map(), heat: { heat: 0, overheated: false }, abilities: createAbilityState(), stunnedUntil: 0,
      shieldDisruptedUntil: 0, lastDamagedAt: 0, invulnerableUntil: this.now + RULES.spawnProtectionMs, damageBy: new Map(),
      lastHitBy: new Map(), pulse: 0, pilot, xp: pilot.xp, inputQueue: [], lastInput: { ...IDLE_INPUT }, lastInputAt: 0,
      firing: { PRIMARY: false, SECONDARY: false }, docked: null, miningTarget: null, cargoUsed: 0, ammo, respawnAt: 0,
      aimX: 0, aimY: 0, aimAt: -Infinity,
    };
  }

  /** Maps whose content is normally driven by a room script (gates) get a small roaming group instead. */
  private spawnFallbackWave(): void {
    const [lo, hi] = this.map.levelRange;
    const pool = [...NPCS_BY_ID.values()].filter((d) => d.kind === "NPC" && d.level >= lo - 5 && d.level <= hi + 5);
    const list = pool.length ? pool : [...NPCS_BY_ID.values()].filter((d) => d.kind === "NPC").slice(0, 3);
    for (let i = 0; i < 6 && list.length; i++) {
      const def = list[i % list.length] as NpcDef;
      const x = this.map.width * (0.3 + 0.4 * this.rng());
      const y = this.map.height * (0.3 + 0.4 * this.rng());
      this.spawnNpc(def, x, y, null, 40, "wave");
    }
  }

  private spawnNpc(def: NpcDef, x: number, y: number, spawnIndex: number | null, homeRadius: number, tag: string): NpcActor {
    const stats = npcStats(def);
    const id = `n${++this.seq}`;
    const cx = Math.max(0, Math.min(this.map.width, x));
    const cy = Math.max(0, Math.min(this.map.height, y));
    const e = blankEntity(id, def.kind === "BOSS" ? "BOSS" : "NPC", def.name, def.id, cx, cy);
    e.hull = e.maxHull = stats.hull;
    e.shield = e.maxShield = stats.shield;
    e.level = def.level;
    e.faction = def.faction;
    e.heading = this.rng() * Math.PI * 2;
    const n: NpcActor = {
      e, stats, weaponRt: new Map(), heat: { heat: 0, overheated: false }, abilities: createAbilityState(), stunnedUntil: 0,
      shieldDisruptedUntil: 0, lastDamagedAt: 0, invulnerableUntil: 0, damageBy: new Map(), lastHitBy: new Map(), pulse: 0,
      def, brain: createBrain(cx, cy, homeRadius, this.now), spawnIndex, respawnAt: 0, removeAt: 0,
      nextThinkAt: this.now + Math.floor(this.rng() * 200), move: { ...IDLE_INPUT }, fireAt: null, bossDamageMult: 1, bossFireRateMult: 1, tag,
    };
    this.npcs.set(id, n);
    this.sink.add(e);
    if (e.kind === "BOSS") {
      this.state.bossId = id;
      this.state.bossName = def.name;
      this.state.bossPhase = 0;
      this.state.bossHullPct = 1;
    }
    return n;
  }

  private spawnAsteroids(): void {
    this.map.asteroidFields.forEach((f) => {
      for (let i = 0; i < f.count; i++) {
        const a = this.rng() * Math.PI * 2;
        const r = Math.sqrt(this.rng()) * f.radius;
        const resource: ResourceId = pickAsteroidResource(f.resources, this.rng);
        const id = `a${++this.seq}`;
        const e = blankEntity(id, "ASTEROID", resource, resource, f.x + Math.cos(a) * r, f.y + Math.sin(a) * r);
        e.hull = e.maxHull = RULES.asteroidAmount;
        e.heading = this.rng() * Math.PI * 2;
        this.asteroids.set(id, { e, state: { resource, amount: RULES.asteroidAmount, progress: 0 }, depleted: false, respawnAt: 0 });
        this.sink.add(e);
      }
    });
  }

  // ---------------------------------------------------------------------------------------------- messages

  handle(type: string, raw: unknown): void {
    const p = this.player;
    const m = (raw ?? {}) as Record<string, unknown>;
    const num = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
    const str = (v: unknown): string => (typeof v === "string" ? v : "");
    switch (type) {
      case "input": {
        const mt = m.moveTo as { x?: unknown; y?: unknown } | null | undefined;
        const moveTo = mt && typeof mt === "object" ? { x: num(mt.x), y: num(mt.y) } : null;
        if (p.inputQueue.length >= 64) p.inputQueue.shift();
        p.inputQueue.push({
          seq: num(m.seq), thrust: num(m.thrust), strafe: num(m.strafe),
          heading: typeof m.heading === "number" ? m.heading : Number.NaN, boost: m.boost === true, moveTo,
        });
        p.lastInputAt = this.now;
        return;
      }
      case "aim":
        if (typeof m.x !== "number" || typeof m.y !== "number" || !Number.isFinite(m.x) || !Number.isFinite(m.y)) return;
        p.aimX = m.x;
        p.aimY = m.y;
        p.aimAt = this.now;
        if (!p.e.dead && !p.docked) p.lastInput = { ...p.lastInput, heading: Math.atan2(m.y - p.e.y, m.x - p.e.x) };
        return;
      case "fire": {
        const group = m.group === "SECONDARY" ? "SECONDARY" : "PRIMARY";
        p.firing[group] = m.firing === true && !p.e.dead && !p.docked;
        return;
      }
      case "target": return this.onTarget(str(m.mode), str(m.entityId));
      case "skill": return this.onAbility(p.stats.skills[num(m.slot, -1)]);
      case "module": return this.onAbility(p.stats.moduleActives[num(m.slot, -1)]);
      case "dash": {
        const slot = [...p.stats.skills, ...p.stats.moduleActives].find((s) => s.effect.type === "DASH");
        if (!slot) return this.notice("warn", "No dash ability equipped");
        return this.onAbility(slot, { x: num(m.dirX, Math.cos(p.e.heading)), y: num(m.dirY, Math.sin(p.e.heading)) });
      }
      case "dock": return this.onDock(str(m.stationId));
      case "undock":
        if (p.docked) {
          p.docked = null;
          p.invulnerableUntil = this.now + RULES.spawnProtectionMs;
        }
        return;
      case "pickup": return this.onPickup(str(m.lootId));
      case "mine": {
        const id = str(m.asteroidId);
        p.miningTarget = id && this.asteroids.has(id) ? id : null;
        return;
      }
      case "jump": return this.onJump(str(m.portalId));
      case "chat": {
        const text = str(m.text).trim().slice(0, 200);
        if (text) this.sink.event("chat", { channel: str(m.channel) || "LOCAL", from: p.e.name, fromId: p.e.id, text, at: Date.now(), faction: p.e.faction });
        return;
      }
      case "respawn": return this.onRespawn();
      case "ping": return this.sink.event("pong", { t: num(m.t), server: Date.now() });
      case "marker":
        return this.sink.event("marker", { x: num(m.x), y: num(m.y), kind: m.kind === "ATTACK" || m.kind === "DEFEND" ? m.kind : "MOVE", fromId: p.e.id, fromName: p.e.name });
      default: return;
    }
  }

  private notice(level: "info" | "warn" | "error" | "success", text: string): void {
    this.sink.event("notice", { level, text });
  }

  private onTarget(mode: string, entityId: string): void {
    const p = this.player;
    if (mode === "CLEAR") {
      p.e.targetId = "";
      return;
    }
    if (mode === "ENTITY") {
      if (entityId && (this.npcs.has(entityId) || this.loot.has(entityId))) p.e.targetId = entityId;
      return;
    }
    let best = Infinity;
    let id = "";
    if (mode === "NEAREST_OBJECTIVE") {
      for (const l of this.loot.values()) {
        const d = (l.e.x - p.e.x) ** 2 + (l.e.y - p.e.y) ** 2;
        if (d < best) { best = d; id = l.e.id; }
      }
    }
    if (mode !== "NEAREST_PLAYER") {
      for (const n of this.npcs.values()) {
        if (n.e.dead || (mode === "NEAREST_OBJECTIVE" && n.e.kind !== "BOSS")) continue;
        const d = (n.e.x - p.e.x) ** 2 + (n.e.y - p.e.y) ** 2;
        if (d < best) { best = d; id = n.e.id; }
      }
    }
    if (id) p.e.targetId = id;
  }

  // ---------------------------------------------------------------------------------------------- tick

  /** Advance the simulation; time is simulated (start time + sum of ticks) so throttled tabs stay consistent. */
  tick(dtMs: number): void {
    this.now += Math.max(0, dtMs);
    this.tickCount++;
    this.state.serverTime = this.now;
    this.state.tick = this.tickCount;
    const dt = dtMs / 1000;
    this.tickPlayerMovement(dt);
    for (const n of [...this.npcs.values()]) this.tickNpc(n, dt);
    this.tickPlayerCombat();
    this.tickMining(dt);
    this.tickVitals(dt);
    this.tickWorld();
    this.syncPlayer();
    for (const n of this.npcs.values()) this.syncNpc(n);
  }

  private motion(s: ShipActor, maxEnergy: number) {
    const b = buffModifiers(s.abilities, this.now);
    return { speed: s.stats.speed, acceleration: s.stats.acceleration, turnRate: s.stats.turnRate, maxEnergy, speedMultiplier: b.speedMultiplier, stunned: this.now < s.stunnedUntil };
  }

  private applyMotion(e: EntitySnapshot, r: { x: number; y: number; vx: number; vy: number; heading: number; energy: number }): void {
    e.x = r.x;
    e.y = r.y;
    e.vx = r.vx;
    e.vy = r.vy;
    e.heading = r.heading;
    e.energy = r.energy;
  }

  private tickPlayerMovement(dt: number): void {
    const p = this.player;
    if (p.e.dead || p.docked) {
      p.e.vx = 0;
      p.e.vy = 0;
      p.inputQueue.length = 0;
      return;
    }
    const ms = this.motion(p, p.e.maxEnergy);
    const bounds = { width: this.map.width, height: this.map.height };
    if (p.inputQueue.length) {
      // One queued client step per server step keeps prediction and simulation aligned; a small backlog is drained.
      const budget = p.inputQueue.length > 3 ? p.inputQueue.length - 2 : 1;
      for (let i = 0; i < budget; i++) {
        const inp = p.inputQueue.shift();
        if (!inp) break;
        const r = stepShip(p.e, inp, ms, dt, bounds, DEFAULT_TUNING);
        this.applyMotion(p.e, r);
        if (r.boosting) p.pulse |= EntityFlag.BOOSTING;
        p.lastInput = { thrust: inp.thrust, strafe: inp.strafe, heading: inp.heading, boost: inp.boost, moveTo: inp.moveTo ?? null };
        p.e.lastSeq = inp.seq;
      }
    } else if (this.now - p.lastInputAt > 150) {
      const input = this.now - p.lastInputAt < 2000 ? p.lastInput : IDLE_INPUT;
      this.applyMotion(p.e, stepShip(p.e, input, ms, dt, bounds, DEFAULT_TUNING));
    }
  }

  private hostileToPlayer(n: NpcActor): boolean {
    return !n.e.dead;
  }

  private tickPlayerCombat(): void {
    const p = this.player;
    if (p.e.dead || p.docked) return;
    if (!p.firing.PRIMARY && !p.firing.SECONDARY) return;
    if (this.now < p.stunnedUntil) return;
    // Free aim: shoot along the cursor/stick line (fresh aim point), else straight ahead.
    const aimFresh = this.now - p.aimAt < 1500 && Math.hypot(p.aimX - p.e.x, p.aimY - p.e.y) > 0.5;
    const angle = aimFresh ? Math.atan2(p.aimY - p.e.y, p.aimX - p.e.x) : p.e.heading;
    const locked = p.e.targetId ? this.npcs.get(p.e.targetId) : undefined;
    for (const w of p.stats.weapons) {
      if (w.mining || !p.firing[w.group]) continue;
      // Missiles keep homing on a locked target; guns hit whatever is on the line of fire.
      if (w.group === "SECONDARY" && locked && !locked.e.dead) {
        this.fireWeapon(p, w, locked);
        continue;
      }
      const hit = aimTarget(p.e.x, p.e.y, angle, w.range, this.aimCandidates());
      if (hit) this.fireWeapon(p, w, hit.target.actor);
      else this.fireDry(p, w, angle);
    }
  }

  private aimCandidates(): { id: string; x: number; y: number; radius: number; actor: NpcActor }[] {
    const out: { id: string; x: number; y: number; radius: number; actor: NpcActor }[] = [];
    for (const n of this.npcs.values()) {
      if (n.e.dead || !this.hostileToPlayer(n)) continue;
      out.push({ id: n.e.id, x: n.e.x, y: n.e.y, radius: shipHitRadius(n.def.visual.scale), actor: n });
    }
    return out;
  }

  /** A shot that meets nothing: same fire-rate/energy/heat/ammo costs, the bolt flies to max range. */
  private fireDry(src: PlayerActor, w: EffectiveWeapon, angle: number): void {
    const rt = src.weaponRt.get(w.key) ?? { readyAt: 0 };
    const ammoLeft = w.ammo ? src.ammo.get(w.ammo) ?? 0 : 1;
    const r = tryFire(w, rt, src.heat, src.e.energy, src.stats.heatCapacity, this.now, !w.ammo || ammoLeft > 0);
    if (!r.ok) return;
    src.weaponRt.set(w.key, r.rt);
    src.heat = r.heat;
    src.e.energy = r.energy;
    if (w.ammo) src.ammo.set(w.ammo, ammoLeft - 1);
    src.pulse |= EntityFlag.FIRING;
    const toX = src.e.x + Math.cos(angle) * w.range;
    const toY = src.e.y + Math.sin(angle) * w.range;
    this.sink.event("player_attack", {
      sourceId: src.e.id, targetId: "", weaponId: w.defId, weaponType: w.type, hit: false,
      fromX: src.e.x, fromY: src.e.y, toX, toY, color: w.color, style: w.style,
      travelMs: w.projectileSpeed > 0 ? Math.round((w.range / w.projectileSpeed) * 1000) : 0,
    });
  }

  private fireWeapon(src: ShipActor, w: EffectiveWeapon, target: ShipActor, fireRateMult = 1): void {
    const dist = Math.hypot(target.e.x - src.e.x, target.e.y - src.e.y);
    if (dist > w.range) return;
    const eff = fireRateMult !== 1 ? { ...w, fireRate: w.fireRate * fireRateMult } : w;
    const rt = src.weaponRt.get(w.key) ?? { readyAt: 0 };
    const isPlayer = src === this.player;
    const ammoLeft = isPlayer && w.ammo ? this.player.ammo.get(w.ammo) ?? 0 : 1;
    const r = tryFire(eff, rt, src.heat, src.e.energy, src.stats.heatCapacity, this.now, !w.ammo || ammoLeft > 0);
    if (!r.ok) return;
    src.weaponRt.set(w.key, r.rt);
    src.heat = r.heat;
    src.e.energy = r.energy;
    if (isPlayer && w.ammo) this.player.ammo.set(w.ammo, ammoLeft - 1);
    src.pulse |= EntityFlag.FIRING;
    const res = this.hitWith(src, w, target, dist);
    this.sink.event("player_attack", {
      sourceId: src.e.id, targetId: target.e.id, weaponId: w.defId, weaponType: w.type, hit: res.hit,
      fromX: src.e.x, fromY: src.e.y, toX: target.e.x, toY: target.e.y, color: w.color, style: w.style,
      travelMs: w.projectileSpeed > 0 ? Math.round((dist / w.projectileSpeed) * 1000) : 0,
    });
    if (w.splashRadius > 0 && res.hit && isPlayer) {
      for (const o of this.npcs.values()) {
        if (o === target || o.e.dead) continue;
        if (Math.hypot(o.e.x - target.e.x, o.e.y - target.e.y) > w.splashRadius) continue;
        this.applyHit(src, o, resolveAreaDamage(res.raw * 0.5, w.element, this.defenseOf(o), DEFAULT_TUNING), w.type);
      }
    }
  }

  private defenseOf(t: ShipActor, weakPointMultiplier = 1) {
    const b = buffModifiers(t.abilities, this.now);
    const invulnerable = this.now < t.invulnerableUntil || (t === this.player && !!this.player.docked);
    return {
      shield: t.e.shield, hull: t.e.hull, armor: t.stats.armor, resistances: t.stats.resistances, evasionPct: t.stats.pct.evasion,
      damageTakenMultiplier: b.damageTakenMultiplier, weakPointMultiplier, invulnerable,
    };
  }

  private hitWith(src: ShipActor, w: EffectiveWeapon, target: ShipActor, dist: number): HitResult {
    let dmgMult = buffModifiers(src.abilities, this.now).damageMultiplier;
    if (src !== this.player) dmgMult *= (src as NpcActor).bossDamageMult;
    let weak = 1;
    if (target.e.kind === "BOSS") {
      const boss = target as NpcActor;
      const phase = boss.def.phases?.[boss.brain.phase];
      if (phase && isWeakPointHit(boss.e.x, boss.e.y, boss.e.heading, src.e.x, src.e.y)) weak = phase.weakPointMultiplier;
    }
    const att = { weapon: w, pveDamagePct: src.stats.pct.pveDamage, pvpDamagePct: src.stats.pct.pvpDamage, damageMultiplier: dmgMult, pvp: false, distance: dist };
    const res = resolveHit(att, this.defenseOf(target, weak), this.rng, DEFAULT_TUNING);
    if (res.hit) this.applyHit(src, target, res, w.type, weak > 1);
    return res;
  }

  private applyHit(src: ShipActor | null, target: ShipActor, res: HitResult, weaponType: string, weakPoint = false): void {
    if (!res.hit || target.e.dead) return;
    target.e.shield = res.shieldAfter;
    target.e.hull = res.hullAfter;
    target.lastDamagedAt = this.now;
    if (res.shieldDamage > 0) target.pulse |= EntityFlag.SHIELD_HIT;
    if (weakPoint) target.pulse |= EntityFlag.WEAK_POINT;
    if (src) {
      const total = res.shieldDamage + res.hullDamage;
      target.damageBy.set(src.e.id, (target.damageBy.get(src.e.id) ?? 0) + total);
      target.lastHitBy.set(src.e.id, this.now);
    }
    this.sink.event("player_damage", {
      sourceId: src?.e.id ?? "", targetId: target.e.id, shieldDamage: res.shieldDamage, armorDamage: res.armorDamage, hullDamage: res.hullDamage,
      crit: res.crit, element: res.element, weaponType, x: target.e.x, y: target.e.y,
    });
    if (res.killed || target.e.hull <= 0) this.kill(target, src);
  }

  private tickVitals(dt: number): void {
    const p = this.player;
    if (p.e.dead) return;
    p.abilities = pruneBuffs(p.abilities, this.now);
    p.e.cloaked = buffModifiers(p.abilities, this.now).cloaked;
    const v = regenerate(
      { hull: p.e.hull, shield: p.e.shield, energy: p.e.energy, maxHull: p.e.maxHull, maxShield: p.e.maxShield, maxEnergy: p.e.maxEnergy, lastDamagedAt: p.lastDamagedAt, shieldDisruptedUntil: p.shieldDisruptedUntil },
      p.stats.shieldRegen, p.stats.energyRegen, dt, this.now, DEFAULT_TUNING,
    );
    p.e.shield = v.shield;
    p.e.energy = v.energy;
    p.heat = coolHeat(p.heat, p.stats.heatCapacity, dt, DEFAULT_TUNING);
    if (p.docked) {
      p.e.shield = p.e.maxShield;
      p.e.hull = Math.min(p.e.maxHull, p.e.hull + p.e.maxHull * 0.2 * dt);
    }
  }

  // ---------------------------------------------------------------------------------------------- NPCs

  private npcPerceivesPlayer(): boolean {
    const p = this.player;
    return !p.e.dead && !p.docked && !p.e.cloaked && this.now >= p.invulnerableUntil && !isSafeAt(this.map, p.e.x, p.e.y);
  }

  private tickNpc(n: NpcActor, dt: number): void {
    const p = this.player;
    if (n.e.dead) {
      if (n.spawnIndex === null && n.tag !== "wave") {
        if (this.now >= n.removeAt) this.removeNpc(n);
      } else if (this.now >= n.respawnAt) {
        this.respawnNpc(n);
      }
      return;
    }
    if (this.now >= n.nextThinkAt) {
      n.nextThinkAt = this.now + (n.e.kind === "BOSS" ? 100 : 200);
      const perceives = this.npcPerceivesPlayer();
      const perception = Math.max(n.def.aggroRange, n.def.range) * 1.5 + 10;
      const near = Math.hypot(p.e.x - n.e.x, p.e.y - n.e.y) <= perception;
      const recentlyHit = (n.lastHitBy.get(p.e.id) ?? 0) > this.now - 12_000;
      const visible = perceives && (near || recentlyHit) ? [{ id: p.e.id, x: p.e.x, y: p.e.y }] : [];
      const attackers = perceives && recentlyHit ? [p.e.id] : [];
      let allyAttacker: { id: string; x: number; y: number } | null = null;
      if (perceives && (n.def.behavior === "SWARM" || n.def.behavior === "DEFENSIVE" || n.def.behavior === "AGGRESSIVE")) {
        for (const o of this.npcs.values()) {
          if (o === n || o.e.dead || o.def.faction !== n.def.faction) continue;
          if (this.now - o.lastDamagedAt > 3000 || Math.hypot(o.e.x - n.e.x, o.e.y - n.e.y) > 45) continue;
          if (o.damageBy.has(p.e.id)) { allyAttacker = { id: p.e.id, x: p.e.x, y: p.e.y }; break; }
        }
      }
      const d = stepNpcBrain(n.brain, {
        now: this.now, x: n.e.x, y: n.e.y, hullFraction: n.e.hull / Math.max(1, n.e.maxHull), def: n.def, visible, attackers, allyAttacker, rng: this.rng,
      }, DEFAULT_TUNING);
      n.brain = d.brain;
      n.e.targetId = d.brain.targetId ?? "";
      n.fireAt = d.fireAt;
      if (d.moveTo) n.move = { thrust: 0, strafe: 0, heading: Number.NaN, boost: false, moveTo: d.moveTo };
      else if (d.faceTo) n.move = { thrust: 0, strafe: 0, heading: Math.atan2(d.faceTo.y - n.e.y, d.faceTo.x - n.e.x), boost: false, moveTo: null };
      else n.move = { ...IDLE_INPUT };
    }
    if (n.brain.state === "RETREAT") {
      n.e.hull = Math.min(n.e.maxHull, n.e.hull + n.e.maxHull * 0.1 * dt);
      n.e.shield = Math.min(n.e.maxShield, n.e.shield + n.e.maxShield * 0.1 * dt);
    } else if (this.now - n.lastDamagedAt > 5000) {
      n.e.shield = Math.min(n.e.maxShield, n.e.shield + n.stats.shieldRegen * dt);
    }
    const r = stepShip(n.e, n.move, { ...this.motion(n, 0), maxEnergy: 0 }, dt, { width: this.map.width, height: this.map.height }, DEFAULT_TUNING);
    this.applyMotion(n.e, r);
    n.e.energy = 0;
    if (n.def.phases?.length) this.tickBoss(n);
    if (n.fireAt === p.e.id && this.now >= n.stunnedUntil && !p.e.dead && this.npcPerceivesPlayer()) {
      for (const w of n.stats.weapons) this.fireWeapon(n, w, p, n.bossFireRateMult);
    }
  }

  private tickBoss(n: NpcActor): void {
    const phases = n.def.phases ?? [];
    const r = bossTick(n.brain, phases, n.e.hull / Math.max(1, n.e.maxHull), this.now, DEFAULT_TUNING);
    n.brain = r.brain;
    n.bossDamageMult = r.damageMultiplier;
    n.bossFireRateMult = r.fireRateMultiplier;
    if (r.phaseChanged && r.phase) {
      this.sink.event("boss_phase", { bossId: n.e.id, phase: n.brain.phase, name: r.phase.name, layer: r.phase.layer });
      this.state.bossPhase = n.brain.phase;
    }
    if (r.enragedNow) this.sink.event("effect", { kind: "ENRAGE", x: n.e.x, y: n.e.y, radius: 40, sourceId: n.e.id });
    if (r.special) {
      this.sink.event("effect", { kind: "BARRAGE", x: n.e.x, y: n.e.y, radius: r.special.radius, sourceId: n.e.id });
      const p = this.player;
      if (!p.e.dead && Math.hypot(p.e.x - n.e.x, p.e.y - n.e.y) <= r.special.radius) {
        this.applyHit(n, p, resolveAreaDamage(r.special.damage, r.special.element, this.defenseOf(p), DEFAULT_TUNING), "SPECIAL");
      }
    }
    if (r.adds) {
      const addDef = NPCS_BY_ID.get(r.adds.npcId);
      const current = [...this.npcs.values()].filter((x) => x.tag === `add:${n.e.id}` && !x.e.dead).length;
      if (addDef) {
        for (let i = 0; i < Math.min(r.adds.count, 12 - current); i++) {
          const a = this.rng() * Math.PI * 2;
          this.spawnNpc(addDef, n.e.x + Math.cos(a) * 25, n.e.y + Math.sin(a) * 25, null, 30, `add:${n.e.id}`);
        }
      }
    }
    this.state.bossHullPct = n.e.hull / Math.max(1, n.e.maxHull);
  }

  private removeNpc(n: NpcActor): void {
    this.npcs.delete(n.e.id);
    if (this.player.e.targetId === n.e.id) this.player.e.targetId = "";
    this.sink.remove(n.e.id);
  }

  private respawnNpc(n: NpcActor): void {
    const s = n.spawnIndex !== null ? this.map.spawns[n.spawnIndex] : undefined;
    const a = this.rng() * Math.PI * 2;
    const r = Math.sqrt(this.rng()) * (s?.radius ?? n.brain.homeRadius);
    n.e.x = (s?.x ?? n.brain.homeX) + Math.cos(a) * r;
    n.e.y = (s?.y ?? n.brain.homeY) + Math.sin(a) * r;
    n.e.vx = 0;
    n.e.vy = 0;
    n.e.hull = n.e.maxHull;
    n.e.shield = n.e.maxShield;
    n.e.dead = false;
    n.e.flags = 0;
    n.damageBy.clear();
    n.lastHitBy.clear();
    n.brain = createBrain(n.brain.homeX, n.brain.homeY, n.brain.homeRadius, this.now);
    n.bossDamageMult = 1;
    n.bossFireRateMult = 1;
    if (n.e.kind === "BOSS") {
      this.state.bossPhase = 0;
      this.state.bossHullPct = 1;
    }
  }

  // ---------------------------------------------------------------------------------------------- deaths & rewards

  private kill(target: ShipActor, killer: ShipActor | null): void {
    if (target.e.dead) return;
    target.e.dead = true;
    target.e.hull = 0;
    target.e.shield = 0;
    target.e.vx = 0;
    target.e.vy = 0;
    const scale = target === this.player ? 1 : (target as NpcActor).def.visual.scale;
    this.sink.event("player_death", { entityId: target.e.id, kind: target.e.kind, killerId: killer?.e.id, killerName: killer?.e.name, x: target.e.x, y: target.e.y, scale });
    if (target === this.player) {
      const p = this.player;
      p.respawnAt = this.now + RULES.respawnDelayMs;
      p.firing.PRIMARY = false;
      p.firing.SECONDARY = false;
      p.miningTarget = null;
      p.e.targetId = "";
      this.sink.event("kill_feed", { killer: killer?.e.name ?? "Unknown", victim: p.e.name, weapon: "", pvp: false });
      return;
    }
    const n = target as NpcActor;
    n.brain = { ...n.brain, state: "RESPAWN", stateSince: this.now, targetId: null };
    n.respawnAt = this.now + n.def.respawnMs;
    n.removeAt = this.now + 2000;
    n.fireAt = null;
    n.e.targetId = "";
    if (this.player.e.targetId === n.e.id) this.player.e.targetId = "";
    if (!n.damageBy.has(this.player.e.id)) return;
    if (n.e.kind === "BOSS") this.sink.event("kill_feed", { killer: this.player.e.name, victim: n.e.name, weapon: "", pvp: false });
    const mult = n.tag.startsWith("add:") ? 0.5 : 1;
    const xp = Math.round(n.def.xp * mult);
    const credits = Math.round(n.def.credits * mult);
    const honor = Math.round(n.def.honor * mult);
    this.sink.event("reward", { xp, honor, credits, seasonPoints: honor, reason: `Destroyed ${n.e.name}` });
    this.giveXp(xp);
    const table = LOOT_TABLES_BY_ID.get(n.def.lootTable);
    if (table) {
      const drops = rollLoot(table, this.rng, {});
      if (drops.length) this.dropLoot(n.e.x, n.e.y, drops, this.player.pilot.userId);
    }
  }

  private giveXp(amount: number): void {
    const p = this.player;
    if (amount <= 0) return;
    const g = grantXp(p.xp, amount, PROGRESSION);
    p.xp = g.xpAfter;
    if (g.levelsGained.length) {
      p.e.level = g.levelAfter;
      this.sink.event("player_level_up", { userId: p.pilot.userId, level: g.levelAfter, entityId: p.e.id });
    }
  }

  private dropLoot(x: number, y: number, drops: LootDrop[], ownerUserId: string | null): void {
    let rarity: Rarity = "COMMON";
    for (const d of drops) {
      const r: Rarity = d.rarity ?? (d.kind === "ITEM" ? ITEMS_BY_ID.get(d.ref)?.rarity ?? "COMMON" : d.kind === "GEMS" ? "RARE" : "COMMON");
      if (RARITY_ORDER[r] > RARITY_ORDER[rarity]) rarity = r;
    }
    const first = drops[0];
    const label = drops.length > 1 ? `${drops.length} items` : first ? (first.kind === "ITEM" ? ITEMS_BY_ID.get(first.ref)?.name ?? first.ref : `${first.quantity} ${first.ref}`) : "Cargo";
    const id = `l${++this.seq}`;
    const e = blankEntity(id, "LOOT", label, rarity, Math.max(0, Math.min(this.map.width, x)), Math.max(0, Math.min(this.map.height, y)));
    this.loot.set(id, { e, drops, ownerUserId, ownerUntil: this.now + RULES.lootOwnerMs, expiresAt: this.now + RULES.lootTtlMs });
    this.sink.add(e);
    this.sink.event("item_drop", { lootId: id, x: e.x, y: e.y, rarity, label });
  }

  private onPickup(lootId: string): void {
    const p = this.player;
    const l = this.loot.get(lootId);
    if (!l || p.e.dead) return;
    if (Math.hypot(l.e.x - p.e.x, l.e.y - p.e.y) > RULES.pickupRange) return this.notice("info", "Move closer to pick up");
    this.loot.delete(lootId);
    this.sink.remove(lootId);
    const items: ServerEvents["item_pickup"]["items"] = [];
    const resources: Partial<Record<ResourceId, number>> = {};
    let credits = 0;
    let gems = 0;
    for (const d of l.drops) {
      if (d.kind === "CREDITS") credits += d.quantity;
      else if (d.kind === "GEMS") gems += d.quantity;
      else if (d.kind === "RESOURCE") resources[d.ref as ResourceId] = (resources[d.ref as ResourceId] ?? 0) + d.quantity;
      else {
        const def = ITEMS_BY_ID.get(d.ref);
        items.push({ itemId: d.ref, name: def?.name ?? d.ref, quantity: d.quantity, rarity: d.rarity ?? def?.rarity ?? "COMMON" });
      }
    }
    this.sink.event("item_pickup", { lootId, byEntityId: p.e.id, items, credits, gems, resources });
  }

  private onRespawn(): void {
    const p = this.player;
    if (!p.e.dead) return;
    if (this.now < p.respawnAt) return this.notice("info", "Repairs in progress");
    const pos = spawnPoint(this.map, p.pilot.factionId);
    p.e.x = pos.x;
    p.e.y = pos.y;
    p.e.vx = 0;
    p.e.vy = 0;
    p.e.hull = p.e.maxHull;
    p.e.shield = p.e.maxShield;
    p.e.energy = p.e.maxEnergy;
    p.e.dead = false;
    p.heat = { heat: 0, overheated: false };
    p.abilities = { ...p.abilities, buffs: [] };
    p.damageBy.clear();
    p.invulnerableUntil = this.now + RULES.spawnProtectionMs;
    p.inputQueue.length = 0;
    p.lastInput = { ...IDLE_INPUT };
    this.syncPlayer();
    this.sink.event("player_respawn", { entityId: p.e.id, x: p.e.x, y: p.e.y, repairCost: 0 });
  }

  // ---------------------------------------------------------------------------------------------- abilities

  private onAbility(slot: AbilitySlotDef | undefined, dir?: { x: number; y: number }): void {
    const p = this.player;
    if (p.docked) return this.notice("warn", "Undock first");
    const r = activateAbility(p.abilities, slot, { now: this.now, energy: p.e.energy, cooldownReductionPct: p.stats.pct.cooldownReduction, stunned: this.now < p.stunnedUntil, dead: p.e.dead });
    if (!r.ok) {
      if (r.reason === "COOLDOWN") this.notice("info", "Ability on cooldown");
      else if (r.reason === "ENERGY") this.notice("warn", "Not enough energy");
      return;
    }
    p.abilities = r.state;
    p.e.energy -= r.energyCost;
    this.applyEffect(r.effect, dir);
  }

  private applyEffect(e: AbilityEffect, dir?: { x: number; y: number }): void {
    const p = this.player;
    const at = { x: p.e.x, y: p.e.y };
    switch (e.type) {
      case "SHIELD_RESTORE":
        p.e.shield = Math.min(p.e.maxShield, p.e.shield + p.e.maxShield * (e.percent / 100));
        this.sink.event("effect", { kind: "SHIELD_BURST", ...at, radius: 6, sourceId: p.e.id });
        break;
      case "HULL_REPAIR":
        p.e.hull = Math.min(p.e.maxHull, p.e.hull + p.e.maxHull * (e.percent / 100));
        this.sink.event("effect", { kind: "HEAL", ...at, radius: 6, sourceId: p.e.id });
        break;
      case "EMP":
        this.sink.event("effect", { kind: "EMP", ...at, radius: e.radius, sourceId: p.e.id });
        for (const t of this.npcs.values()) {
          if (t.e.dead || Math.hypot(t.e.x - p.e.x, t.e.y - p.e.y) > e.radius) continue;
          const r = applyEmp(t.e.shield, t.e.maxShield, e.shieldDamagePercent, e.stunMs, this.now, t.stats.resistances.EM ?? 0);
          t.e.shield = r.shieldAfter;
          t.stunnedUntil = r.stunnedUntil;
          t.shieldDisruptedUntil = r.shieldDisruptedUntil;
          t.lastDamagedAt = this.now;
          t.damageBy.set(p.e.id, (t.damageBy.get(p.e.id) ?? 0) + r.shieldDamage);
          t.lastHitBy.set(p.e.id, this.now);
        }
        break;
      case "BARRAGE":
        this.sink.event("effect", { kind: "BARRAGE", ...at, radius: e.radius, sourceId: p.e.id });
        for (const t of [...this.npcs.values()]) {
          if (t.e.dead || Math.hypot(t.e.x - p.e.x, t.e.y - p.e.y) > e.radius) continue;
          this.applyHit(p, t, resolveAreaDamage(e.damage * (1 + p.stats.pct.damage / 100), e.element, this.defenseOf(t), DEFAULT_TUNING), "SPECIAL");
        }
        break;
      case "DASH": {
        const d = applyDash(p.e, dir?.x ?? Math.cos(p.e.heading), dir?.y ?? Math.sin(p.e.heading), e.distance, { width: this.map.width, height: this.map.height });
        p.e.x = d.x;
        p.e.y = d.y;
        this.sink.event("effect", { kind: "DASH", ...at, radius: e.distance, sourceId: p.e.id });
        break;
      }
      case "CLOAK":
        p.e.cloaked = true;
        this.sink.event("effect", { kind: "CLOAK", ...at, radius: 5, sourceId: p.e.id });
        break;
      default:
        break;
    }
  }

  // ---------------------------------------------------------------------------------------------- world

  private tickMining(dt: number): void {
    const p = this.player;
    if (!p.miningTarget || p.e.dead || p.docked) {
      p.e.flags &= ~EntityFlag.MINING;
      return;
    }
    const a = this.asteroids.get(p.miningTarget);
    if (!a || a.depleted) {
      p.miningTarget = null;
      return;
    }
    const miners = p.stats.weapons.filter((w) => w.mining);
    const range = miners.length ? Math.max(...miners.map((w) => w.range)) : RULES.miningRange;
    if (Math.hypot(a.e.x - p.e.x, a.e.y - p.e.y) > range) return;
    let power = miners.reduce((s, w) => s + w.damage * w.fireRate, 0);
    if (power <= 0) power = p.stats.weapons.filter((w) => w.group === "PRIMARY").reduce((s, w) => s + w.damage * w.fireRate, 0) * RULES.unarmedMiningFactor;
    const free = p.stats.cargo - p.cargoUsed;
    if (free <= 0) {
      p.miningTarget = null;
      return this.notice("warn", "Cargo hold full — dock to unload");
    }
    const hardness = resourceHardness(ITEMS_BY_ID.get(itemIdForResource(a.state.resource))?.baseValue ?? 10);
    const r = mineStep(a.state, power, p.stats.pct.miningSpeed, dt, free, hardness);
    a.state = r.asteroid;
    p.pulse |= EntityFlag.MINING;
    if (r.extracted > 0) {
      p.cargoUsed += r.extracted;
      a.e.hull = a.state.amount;
      this.sink.event("item_pickup", { lootId: a.e.id, byEntityId: p.e.id, items: [], credits: 0, gems: 0, resources: { [a.state.resource]: r.extracted } });
      if (this.tickCount % 10 === 0) this.sink.event("effect", { kind: "MINING", x: a.e.x, y: a.e.y, radius: 3, sourceId: p.e.id });
    }
    if (r.depleted) {
      a.depleted = true;
      a.respawnAt = this.now + RULES.asteroidRespawnMs;
      a.e.dead = true;
      p.miningTarget = null;
    }
  }

  private tickWorld(): void {
    for (const l of [...this.loot.values()]) {
      if (this.now >= l.expiresAt) {
        this.loot.delete(l.e.id);
        this.sink.remove(l.e.id);
      }
    }
    for (const a of this.asteroids.values()) {
      if (a.depleted && this.now >= a.respawnAt) {
        a.depleted = false;
        a.state = { ...a.state, amount: RULES.asteroidAmount, progress: 0 };
        a.e.dead = false;
        a.e.hull = RULES.asteroidAmount;
      }
    }
  }

  private onDock(stationId: string): void {
    const p = this.player;
    if (p.e.dead) return;
    const st = stationInRange(this.map, stationId, p.e.x, p.e.y, RULES.dockRange);
    if (!st) return this.notice("warn", "Station out of range");
    if (this.now - p.lastDamagedAt < RULES.combatLockMs) return this.notice("warn", "Cannot dock during combat");
    p.docked = st.id;
    p.e.vx = 0;
    p.e.vy = 0;
    p.firing.PRIMARY = false;
    p.firing.SECONDARY = false;
    p.miningTarget = null;
    p.cargoUsed = 0;
    this.sink.event("docked", { stationId: st.id, services: st.services });
  }

  private onJump(portalId: string): void {
    const p = this.player;
    if (p.e.dead || p.docked) return this.notice("warn", "Cannot jump now");
    const portal = this.map.portals.find((x) => x.id === portalId);
    const near = nearestPortal(this.map, p.e.x, p.e.y, RULES.portalRange);
    if (!portal || !near || near.id !== portal.id) return this.notice("info", "Fly into the portal to jump");
    if (this.now - p.lastDamagedAt < RULES.combatLockMs) return this.notice("warn", "Jump drive locked during combat");
    const target = MAPS_BY_ID.get(portal.targetMap);
    if (!target) return this.notice("error", "Portal destination offline");
    // Demo: level requirements are shown but not enforced so every sector can be explored.
    if (p.e.level < portal.requiredLevel) this.notice("info", `Demo access: ${target.name} normally requires level ${portal.requiredLevel}`);
    this.sink.event("effect", { kind: "WARP", x: p.e.x, y: p.e.y, radius: 10, sourceId: p.e.id });
    this.sink.event("jump", { mapId: target.id, portalId: portal.targetPortal, roomName: roomNameFor(target) });
  }

  // ---------------------------------------------------------------------------------------------- sync

  private syncPlayer(): void {
    const p = this.player;
    const e = p.e;
    let flags = (e.flags & EntityFlag.MINING) | p.pulse;
    if (p.docked) flags |= EntityFlag.DOCKED;
    if (p.firing.PRIMARY || p.firing.SECONDARY) flags |= EntityFlag.FIRING;
    if (this.now < p.stunnedUntil) flags |= EntityFlag.STUNNED;
    e.flags = flags & 0xffff;
    p.pulse = 0;
  }

  private syncNpc(n: NpcActor): void {
    let flags = (n.e.flags & EntityFlag.ENRAGED) | n.pulse;
    if (n.brain.enraged) flags |= EntityFlag.ENRAGED;
    if (this.now < n.stunnedUntil) flags |= EntityFlag.STUNNED;
    n.e.flags = flags & 0xffff;
    n.e.aiState = n.brain.state;
    n.pulse = 0;
  }

  /** XP after this session (the demo shell stores it locally). */
  get pilotXp(): number {
    return this.player.xp;
  }
}

function roomNameFor(map: MapDef): ServerEvents["jump"]["roomName"] {
  const byType: Record<MapDef["roomType"], ServerEvents["jump"]["roomName"]> = {
    sector: "sector", pvp: "pvp", boss: "boss", gate: "gate", raid: "raid", arena: "arena", clanwar: "clan_war", event: "event",
  };
  return byType[map.roomType];
}

