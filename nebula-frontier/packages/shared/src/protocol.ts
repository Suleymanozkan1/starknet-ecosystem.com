/**
 * Real-time protocol between game-client and game-server (Colyseus).
 * The client ONLY sends intents (inputs). Every consequence — HP, damage,
 * XP, loot, credits, cooldowns, positions — is decided on the server.
 */
import type { DamageElement, EntityKind, NpcAiState, Rarity, ResourceId } from "./enums.js";

/** Colyseus room names registered by apps/game-server. */
export const RoomName = {
  LOBBY: "lobby",
  GALAXY: "galaxy",
  SECTOR: "sector",
  PVP: "pvp",
  RAID: "raid",
  BOSS: "boss",
  CLAN_WAR: "clan_war",
  ARENA: "arena",
  EVENT: "event",
  GATE: "gate",
} as const;
export type RoomName = (typeof RoomName)[keyof typeof RoomName];

/** Options passed to client.joinOrCreate(room, options). */
export interface JoinOptions {
  /** Short-lived game ticket issued by POST /api/game/ticket (JWT, audience "game"). */
  ticket: string;
  mapId: string;
  /** For arrival through a portal. */
  portalId?: string;
  /** Gate/raid difficulty etc. */
  difficulty?: string;
  instanceKey?: string;
}

// ---------------------------------------------------------------------------
// Client -> Server messages (inputs only)
// ---------------------------------------------------------------------------

export const ClientMsg = {
  INPUT: "input",
  AIM: "aim",
  FIRE: "fire",
  TARGET: "target",
  SKILL: "skill",
  MODULE: "module",
  DASH: "dash",
  DOCK: "dock",
  UNDOCK: "undock",
  PICKUP: "pickup",
  MINE: "mine",
  JUMP: "jump",
  CHAT: "chat",
  FORMATION: "formation",
  RESPAWN: "respawn",
  PING: "ping",
  MARKER: "marker",
} as const;
export type ClientMsg = (typeof ClientMsg)[keyof typeof ClientMsg];

/** Movement input frame, sent at the client fixed tick (or on change). */
export interface InputMsg {
  /** Client sequence number, monotonically increasing — used for reconciliation & replay protection. */
  seq: number;
  /** Thrust axis -1..1 (forward/back). */
  thrust: number;
  /** Strafe axis -1..1. */
  strafe: number;
  /** Desired heading in radians (mouse aim / joystick). NaN => keep. */
  heading: number;
  boost: boolean;
  /** Optional click-to-move target in map coordinates. */
  moveTo?: { x: number; y: number } | null;
}
export interface AimMsg { x: number; y: number }
export interface FireMsg { firing: boolean; group: "PRIMARY" | "SECONDARY" }
export interface TargetMsg {
  mode: "ENTITY" | "NEAREST_ENEMY" | "NEAREST_PLAYER" | "NEAREST_OBJECTIVE" | "CLEAR";
  entityId?: string;
  lock?: "SOFT" | "HARD";
}
export interface SkillMsg { slot: number }
export interface ModuleMsg { slot: number }
export interface DashMsg { dirX: number; dirY: number }
export interface DockMsg { stationId: string }
export interface PickupMsg { lootId: string }
export interface MineMsg { asteroidId: string | null }
export interface JumpMsg { portalId: string }
export interface ChatMsg { channel: "LOCAL" | "GLOBAL" | "FACTION" | "CLAN" | "SQUAD"; text: string }
export interface FormationMsg { formation: string }
export interface MarkerMsg { x: number; y: number; kind: "ATTACK" | "DEFEND" | "MOVE" }
export interface PingMsg { t: number }

export interface ClientMessages {
  input: InputMsg;
  aim: AimMsg;
  fire: FireMsg;
  target: TargetMsg;
  skill: SkillMsg;
  module: ModuleMsg;
  dash: DashMsg;
  dock: DockMsg;
  undock: Record<string, never>;
  pickup: PickupMsg;
  mine: MineMsg;
  jump: JumpMsg;
  chat: ChatMsg;
  formation: FormationMsg;
  respawn: Record<string, never>;
  ping: PingMsg;
  marker: MarkerMsg;
}

// ---------------------------------------------------------------------------
// Server -> Client events (in addition to the synchronized Schema state)
// ---------------------------------------------------------------------------

export const ServerEvent = {
  PLAYER_JOIN: "player_join",
  PLAYER_LEAVE: "player_leave",
  PLAYER_ATTACK: "player_attack",
  PLAYER_DAMAGE: "player_damage",
  PLAYER_DEATH: "player_death",
  PLAYER_RESPAWN: "player_respawn",
  PLAYER_LEVEL_UP: "player_level_up",
  ITEM_DROP: "item_drop",
  ITEM_PICKUP: "item_pickup",
  QUEST_PROGRESS: "quest_progress",
  QUEST_COMPLETE: "quest_complete",
  MATCH_START: "match_start",
  MATCH_END: "match_end",
  BOSS_PHASE: "boss_phase",
  EVENT_STARTED: "event_started",
  EVENT_FINISHED: "event_finished",
  REWARD: "reward",
  CHAT: "chat",
  NOTICE: "notice",
  PONG: "pong",
  JUMP: "jump",
  DOCKED: "docked",
  EFFECT: "effect",
  WAVE: "wave",
  KILL_FEED: "kill_feed",
  ERROR: "error",
} as const;
export type ServerEvent = (typeof ServerEvent)[keyof typeof ServerEvent];

export interface DamageEvent {
  sourceId: string;
  targetId: string;
  shieldDamage: number;
  armorDamage: number;
  hullDamage: number;
  crit: boolean;
  element: DamageElement;
  weaponType: string;
  x: number;
  y: number;
}
export interface AttackEvent {
  sourceId: string;
  targetId: string;
  weaponId: string;
  weaponType: string;
  hit: boolean;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  color: string;
  style: string;
  travelMs: number;
}
export interface DeathEvent {
  entityId: string;
  kind: EntityKind;
  killerId?: string;
  killerName?: string;
  x: number;
  y: number;
  scale: number;
}
export interface RespawnEvent { entityId: string; x: number; y: number; repairCost: number }
export interface LevelUpEvent { userId: string; level: number; entityId: string }
export interface ItemDropEvent { lootId: string; x: number; y: number; rarity: Rarity; label: string }
export interface ItemPickupEvent {
  lootId: string;
  byEntityId: string;
  items: { itemId: string; name: string; quantity: number; rarity: Rarity }[];
  credits: number;
  gems: number;
  resources: Partial<Record<ResourceId, number>>;
}
export interface RewardEvent {
  xp: number;
  honor: number;
  credits: number;
  seasonPoints: number;
  reason: string;
  cryptoEligible?: boolean;
}
export interface BossPhaseEvent { bossId: string; phase: number; name: string; layer: string }
export interface GameEventNotice { eventId: string; name: string; type: string; mapIds: string[]; endsAt: string }
export interface ChatEvent { channel: string; from: string; fromId: string; text: string; at: number; faction?: string }
export interface NoticeEvent { level: "info" | "warn" | "error" | "success"; text: string }
export interface JumpEvent { mapId: string; portalId: string; roomName: RoomName; reservation?: unknown }
export interface EffectEvent { kind: "EMP" | "WARP" | "SHIELD_BURST" | "HEAL" | "CLOAK" | "BARRAGE" | "DASH" | "MINING" | "ENRAGE"; x: number; y: number; radius: number; sourceId: string }
export interface WaveEvent { wave: number; total: number; name: string }
export interface MatchEndEvent { matchId: string; winnerTeam?: number; scores: { entityId: string; name: string; kills: number; deaths: number; score: number }[] }
/**
 * Parameters the owning client needs to run `@nebula/game-core` stepShip
 * prediction with exactly the server's numbers (sent only to the joining client).
 */
export interface SelfJoinInfo {
  userId: string;
  mapId: string;
  tickRate: number;
  aoiRadius: number;
  motion: { speed: number; acceleration: number; turnRate: number; maxEnergy: number };
  weapons: { key: string; defId: string; group: "PRIMARY" | "SECONDARY"; range: number; fireRate: number }[];
  skills: { slot: number; id: string; name: string; cooldownMs: number; energyCost: number }[];
  modules: { slot: number; id: string; name: string; cooldownMs: number; energyCost: number }[];
}
export interface KillFeedEvent { killer: string; victim: string; weapon: string; pvp: boolean }

export interface ServerEvents {
  /** Sent to everyone nearby; the joining client additionally receives `self` (its own prediction parameters). */
  player_join: { entityId: string; name: string; self?: SelfJoinInfo };
  player_leave: { entityId: string };
  player_attack: AttackEvent;
  player_damage: DamageEvent;
  player_death: DeathEvent;
  player_respawn: RespawnEvent;
  player_level_up: LevelUpEvent;
  item_drop: ItemDropEvent;
  item_pickup: ItemPickupEvent;
  quest_progress: { questId: string; progress: number[] };
  quest_complete: { questId: string; name: string };
  match_start: { matchId: string; mode: string };
  match_end: MatchEndEvent;
  boss_phase: BossPhaseEvent;
  event_started: GameEventNotice;
  event_finished: GameEventNotice;
  reward: RewardEvent;
  chat: ChatEvent;
  notice: NoticeEvent;
  pong: { t: number; server: number };
  jump: JumpEvent;
  docked: { stationId: string; services: string[] };
  effect: EffectEvent;
  wave: WaveEvent;
  kill_feed: KillFeedEvent;
  error: { code: string; message: string };
}

/**
 * Shape of the synchronized entity as seen by clients (mirrors the Colyseus Schema
 * `ShipEntity` in apps/game-server). Kept as a plain interface so renderers are
 * decoupled from the Schema implementation.
 */
export interface EntitySnapshot {
  id: string;
  kind: EntityKind;
  name: string;
  defId: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  heading: number;
  hull: number;
  maxHull: number;
  shield: number;
  maxShield: number;
  energy: number;
  maxEnergy: number;
  level: number;
  faction: string;
  clanTag: string;
  team: number;
  aiState: NpcAiState | "";
  targetId: string;
  cloaked: boolean;
  dead: boolean;
  lastSeq: number;
  flags: number;
  cosmetics: string;
}

/** Bit flags packed into EntitySnapshot.flags. */
export const EntityFlag = {
  FIRING: 1,
  BOOSTING: 2,
  SHIELD_HIT: 4,
  MINING: 8,
  DOCKED: 16,
  STUNNED: 32,
  ENRAGED: 64,
  OUTLAW: 128,
  BOUNTY: 256,
  SQUAD: 512,
  CLAN: 1024,
  WEAK_POINT: 2048,
} as const;
