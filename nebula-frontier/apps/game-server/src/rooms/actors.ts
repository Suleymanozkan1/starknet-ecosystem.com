/** Server-side simulation actors (plain objects), synced into Schema `Entity`s each tick. */
import type { Client } from "@colyseus/core";
import type {
  AbilityState, AsteroidState, CooldownViolationTracker, EffectiveStats, FireRateAuditor, HeatState, LootDrop, MovementBudget,
  MoveInput, NpcBrain, PacketRateLimiter, ReactionTimeDetector, RepeatedMovementDetector, SeqValidator, TokenBucket, WeaponRuntime,
} from "@nebula/game-core";
import type { EntityKind, NpcDef, PetDef, Rarity } from "@nebula/shared";
import type { PendingDelta } from "../persistence/writer.js";
import type { PlayerProfile } from "../persistence/player.js";
import type { Entity } from "../schema/state.js";

export interface ActorBase {
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
  shield: number;
  energy: number;
  maxHull: number;
  maxShield: number;
  maxEnergy: number;
  level: number;
  faction: string;
  clanTag: string;
  team: number;
  targetId: string;
  dead: boolean;
  flags: number;
  cloaked: boolean;
  entity: Entity;
}

export interface ShipActor extends ActorBase {
  stats: EffectiveStats;
  weaponRt: Map<string, WeaponRuntime>;
  heat: HeatState;
  abilities: AbilityState;
  stunnedUntil: number;
  shieldDisruptedUntil: number;
  lastDamagedAt: number;
  invulnerableUntil: number;
  /** attacker actor id → total damage dealt to this actor (contribution / threat). */
  damageBy: Map<string, number>;
  lastHitBy: Map<string, number>;
  /** Transient flag bits for this tick (SHIELD_HIT…). */
  pulseFlags: number;
}

export interface ParsedInput extends MoveInput {
  seq: number;
}

export interface PlayerActor extends ShipActor {
  kind: "PLAYER";
  sessionId: string;
  client: Client;
  profile: PlayerProfile;
  userId: string;
  xp: number;
  honor: number;
  inputQueue: ParsedInput[];
  lastInput: MoveInput;
  lastInputAt: number;
  lastSeq: number;
  seq: SeqValidator;
  budget: MovementBudget;
  packets: PacketRateLimiter;
  chat: TokenBucket;
  cooldownTracker: CooldownViolationTracker;
  fireAudit: FireRateAuditor;
  repeated: RepeatedMovementDetector;
  reaction: ReactionTimeDetector;
  spamStrikes: number;
  firing: { PRIMARY: boolean; SECONDARY: boolean };
  /** Latest validated aim point (map coords) and when it arrived — free-aim fire shoots along it. */
  aim: { x: number; y: number; at: number };
  docked: string | null;
  miningTarget: string | null;
  cargoUsed: number;
  visible: Set<string>;
  firstSeen: Map<string, number>;
  pending: PendingDelta;
  flushing: boolean;
  flushRequested: boolean;
  deathCount: number;
  respawnAt: number;
  lastRepairCost: number;
  joinedAt: number;
  lastPlaytimeAt: number;
  lastSurviveAt: number;
  formation: string;
  cosmetics: string;
  // match stats
  kills: number;
  deaths: number;
  score: number;
  damageDealt: number;
  connected: boolean;
  left: boolean;
  /** Set after a successful portal jump: persisted position is the arrival portal. */
  jumpedTo: { mapId: string; x: number; y: number } | null;
  // reputation
  karma: number;
  reputation: string;
  hasBounty: boolean;
  /** victim userId → last unprovoked-attack penalty time (ms). */
  unprovokedLog: Map<string, number>;
  lastKarmaDecayAt: number;
  pet: PetActor | null;
}

/** Companion following its owner (kind PET). */
export interface PetActor {
  id: string;
  kind: "PET";
  ownerSessionId: string;
  rowId: string;
  def: PetDef;
  name: string;
  level: number;
  xp: number;
  x: number;
  y: number;
  heading: number;
  nextCollectAt: number;
  nextHintAt: number;
  hintKey: string;
  entity: Entity;
}

export interface NpcActor extends ShipActor {
  kind: "NPC" | "BOSS";
  def: NpcDef;
  /** Globally unique id of this life of the NPC (for idempotency keys). */
  uid: string;
  life: number;
  brain: NpcBrain;
  /** Index into map spawns (null = temporary add / wave spawn, no respawn). */
  spawnIndex: number | null;
  respawnAt: number;
  nextThinkAt: number;
  move: MoveInput;
  fireAt: string | null;
  hullMult: number;
  damageMult: number;
  rewardMult: number;
  bossDamageMult: number;
  bossFireRateMult: number;
  removeAt: number;
  tag: string;
}

export interface LootActor {
  id: string;
  kind: "LOOT";
  x: number;
  y: number;
  ownerUserId: string | null;
  ownerUntil: number;
  expiresAt: number;
  drops: LootDrop[];
  rarity: Rarity;
  label: string;
  claimed: boolean;
  entity: Entity;
}

export interface AsteroidActor {
  id: string;
  kind: "ASTEROID";
  x: number;
  y: number;
  state: AsteroidState;
  initialAmount: number;
  field: number;
  respawnAt: number;
  depleted: boolean;
  entity: Entity;
}

export type AnyActor = PlayerActor | NpcActor | LootActor | AsteroidActor | PetActor;
