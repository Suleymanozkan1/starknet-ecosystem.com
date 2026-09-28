/**
 * Erasable "enums" (const objects + literal unions) shared by every workspace.
 * Pattern borrowed from the Colyseus repo conventions (no TS `enum` emit).
 */
function values<T extends Record<string, string>>(o: T): T[keyof T][] {
  return Object.values(o) as T[keyof T][];
}

export const Rarity = {
  COMMON: "COMMON",
  UNCOMMON: "UNCOMMON",
  RARE: "RARE",
  EPIC: "EPIC",
  LEGENDARY: "LEGENDARY",
  ANCIENT: "ANCIENT",
  MYTHIC: "MYTHIC",
  PROTOTYPE: "PROTOTYPE",
} as const;
export type Rarity = (typeof Rarity)[keyof typeof Rarity];
export const RARITIES = values(Rarity);
export const RARITY_ORDER: Record<Rarity, number> = {
  COMMON: 0, UNCOMMON: 1, RARE: 2, EPIC: 3, LEGENDARY: 4, ANCIENT: 5, MYTHIC: 6, PROTOTYPE: 7,
};

export const BlueprintTier = {
  STANDARD: "STANDARD",
  ADVANCED: "ADVANCED",
  EXPERIMENTAL: "EXPERIMENTAL",
  PROTOTYPE: "PROTOTYPE",
  LEGENDARY: "LEGENDARY",
} as const;
export type BlueprintTier = (typeof BlueprintTier)[keyof typeof BlueprintTier];

export const ShipClass = {
  SCOUT: "SCOUT",
  INTERCEPTOR: "INTERCEPTOR",
  ASSAULT: "ASSAULT",
  STRIKER: "STRIKER",
  DESTROYER: "DESTROYER",
  BATTLECRUISER: "BATTLECRUISER",
  CARRIER: "CARRIER",
  SUPPORT: "SUPPORT",
  TANK: "TANK",
  STEALTH: "STEALTH",
  EXPLORATION: "EXPLORATION",
  MINING: "MINING",
  ELECTRONIC_WARFARE: "ELECTRONIC_WARFARE",
} as const;
export type ShipClass = (typeof ShipClass)[keyof typeof ShipClass];

export const WeaponType = {
  LASER: "LASER",
  PLASMA: "PLASMA",
  RAILGUN: "RAILGUN",
  PARTICLE_CANNON: "PARTICLE_CANNON",
  ION_CANNON: "ION_CANNON",
  MISSILE: "MISSILE",
  ROCKET: "ROCKET",
  TORPEDO: "TORPEDO",
  EMP: "EMP",
  BEAM: "BEAM",
  MINE: "MINE",
  DRONE_WEAPON: "DRONE_WEAPON",
  SPECIAL: "SPECIAL",
  MINING_LASER: "MINING_LASER",
} as const;
export type WeaponType = (typeof WeaponType)[keyof typeof WeaponType];

/** Slot family a weapon occupies. */
export const WeaponSlot = { LASER: "LASER", MISSILE: "MISSILE" } as const;
export type WeaponSlot = (typeof WeaponSlot)[keyof typeof WeaponSlot];

export const DamageElement = {
  KINETIC: "KINETIC",
  THERMAL: "THERMAL",
  EM: "EM",
  PLASMA: "PLASMA",
  VOID: "VOID",
} as const;
export type DamageElement = (typeof DamageElement)[keyof typeof DamageElement];
export const DAMAGE_ELEMENTS = values(DamageElement);

export const ModuleKind = {
  SHIELD_BOOSTER: "SHIELD_BOOSTER",
  ENGINE_OVERDRIVE: "ENGINE_OVERDRIVE",
  EMERGENCY_REPAIR: "EMERGENCY_REPAIR",
  EMP_BURST: "EMP_BURST",
  CLOAKING: "CLOAKING",
  TARGET_JAMMER: "TARGET_JAMMER",
  CARGO_BOOSTER: "CARGO_BOOSTER",
  MINING_BOOSTER: "MINING_BOOSTER",
  ENERGY_CONVERTER: "ENERGY_CONVERTER",
  WEAPON_OVERCHARGER: "WEAPON_OVERCHARGER",
  SENSOR_AMPLIFIER: "SENSOR_AMPLIFIER",
  WARP_STABILIZER: "WARP_STABILIZER",
  HEAT_SINK: "HEAT_SINK",
  COMBAT_AI: "COMBAT_AI",
  REPAIR_MATRIX: "REPAIR_MATRIX",
  SHIELD_GENERATOR: "SHIELD_GENERATOR",
  SPEED_GENERATOR: "SPEED_GENERATOR",
} as const;
export type ModuleKind = (typeof ModuleKind)[keyof typeof ModuleKind];

export const DroneType = {
  COMBAT: "COMBAT",
  DEFENSE: "DEFENSE",
  REPAIR: "REPAIR",
  MINING: "MINING",
  UTILITY: "UTILITY",
  RECON: "RECON",
} as const;
export type DroneType = (typeof DroneType)[keyof typeof DroneType];

export const DroneFormation = {
  STANDARD: "STANDARD",
  ARROW: "ARROW",
  TURTLE: "TURTLE",
  DIAMOND: "DIAMOND",
  WHEEL: "WHEEL",
} as const;
export type DroneFormation = (typeof DroneFormation)[keyof typeof DroneFormation];

export const ZoneType = {
  SAFE: "SAFE",
  NEUTRAL: "NEUTRAL",
  PVP: "PVP",
  HIGH_RISK: "HIGH_RISK",
  PIRATE: "PIRATE",
  EVENT: "EVENT",
  BOSS: "BOSS",
  GATE: "GATE",
  MINING: "MINING",
} as const;
export type ZoneType = (typeof ZoneType)[keyof typeof ZoneType];

export const PortalKind = {
  PORTAL: "PORTAL",
  JUMP_GATE: "JUMP_GATE",
  WARP_GATE: "WARP_GATE",
  EVENT_GATE: "EVENT_GATE",
  BOSS_GATE: "BOSS_GATE",
  RAID_GATE: "RAID_GATE",
  PVP_GATE: "PVP_GATE",
} as const;
export type PortalKind = (typeof PortalKind)[keyof typeof PortalKind];

export const NpcAiState = {
  IDLE: "IDLE",
  PATROL: "PATROL",
  SEARCH: "SEARCH",
  AGGRO: "AGGRO",
  ATTACK: "ATTACK",
  FLEE: "FLEE",
  ASSIST: "ASSIST",
  RETREAT: "RETREAT",
  RESPAWN: "RESPAWN",
} as const;
export type NpcAiState = (typeof NpcAiState)[keyof typeof NpcAiState];

export const EntityKind = {
  PLAYER: "PLAYER",
  NPC: "NPC",
  BOSS: "BOSS",
  ASTEROID: "ASTEROID",
  LOOT: "LOOT",
  PORTAL: "PORTAL",
  STATION: "STATION",
  PROJECTILE: "PROJECTILE",
  DRONE: "DRONE",
} as const;
export type EntityKind = (typeof EntityKind)[keyof typeof EntityKind];

/** Off-chain + on-chain currencies. */
export const Currency = {
  CREDITS: "CREDITS",
  GEMS: "GEMS",
  /** Withdrawable crypto reward asset (devnet SOL or configured SPL mint), stored in base units (lamports). */
  NEBX: "NEBX",
  SOL: "SOL",
} as const;
export type Currency = (typeof Currency)[keyof typeof Currency];

export const ResourceId = {
  TITANIUM: "TITANIUM",
  PLASMA_ORE: "PLASMA_ORE",
  DARK_MATTER: "DARK_MATTER",
  QUANTUM_SHARD: "QUANTUM_SHARD",
  CRYONITE: "CRYONITE",
  AETHER_CRYSTAL: "AETHER_CRYSTAL",
  VOID_ESSENCE: "VOID_ESSENCE",
} as const;
export type ResourceId = (typeof ResourceId)[keyof typeof ResourceId];
export const RESOURCE_IDS = values(ResourceId);

/** Double-entry ledger system accounts (user sub-accounts are USER_WALLET:<userId>). */
export const LedgerAccountType = {
  TREASURY: "TREASURY",
  PLAYER_REWARD_POOL: "PLAYER_REWARD_POOL",
  OPERATING_REVENUE: "OPERATING_REVENUE",
  OPERATING_RESERVE: "OPERATING_RESERVE",
  REWARD_RESERVE: "REWARD_RESERVE",
  WITHDRAWAL_RESERVE: "WITHDRAWAL_RESERVE",
  EMERGENCY_RESERVE: "EMERGENCY_RESERVE",
  MARKETPLACE_REVENUE: "MARKETPLACE_REVENUE",
  AUCTION_REVENUE: "AUCTION_REVENUE",
  PREMIUM_REVENUE: "PREMIUM_REVENUE",
  FEE_REVENUE: "FEE_REVENUE",
  GAME_ISSUANCE: "GAME_ISSUANCE",
  GAME_SINK: "GAME_SINK",
  EXTERNAL_CHAIN: "EXTERNAL_CHAIN",
  ESCROW: "ESCROW",
  USER_WALLET: "USER_WALLET",
  USER_PENDING_REWARD: "USER_PENDING_REWARD",
} as const;
export type LedgerAccountType = (typeof LedgerAccountType)[keyof typeof LedgerAccountType];

export const LedgerTxType = {
  DEPOSIT: "DEPOSIT",
  GAME_REWARD: "GAME_REWARD",
  PURCHASE: "PURCHASE",
  REFUND: "REFUND",
  WITHDRAWAL: "WITHDRAWAL",
  FEE: "FEE",
  MARKETPLACE_FEE: "MARKETPLACE_FEE",
  AUCTION_FEE: "AUCTION_FEE",
  ADMIN_ADJUSTMENT: "ADMIN_ADJUSTMENT",
  GAME_ISSUANCE: "GAME_ISSUANCE",
  GAME_SINK: "GAME_SINK",
  TRADE: "TRADE",
  ESCROW: "ESCROW",
  RESERVE_ALLOCATION: "RESERVE_ALLOCATION",
  COMPENSATION: "COMPENSATION",
} as const;
export type LedgerTxType = (typeof LedgerTxType)[keyof typeof LedgerTxType];

export const WithdrawalStatus = {
  PENDING: "PENDING",
  PENDING_REVIEW: "PENDING_REVIEW",
  PROCESSING: "PROCESSING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
} as const;
export type WithdrawalStatus = (typeof WithdrawalStatus)[keyof typeof WithdrawalStatus];

export const ChainTxState = {
  CREATED: "CREATED",
  QUEUED: "QUEUED",
  SUBMITTED: "SUBMITTED",
  CONFIRMING: "CONFIRMING",
  CONFIRMED: "CONFIRMED",
  FAILED: "FAILED",
  RETRYING: "RETRYING",
} as const;
export type ChainTxState = (typeof ChainTxState)[keyof typeof ChainTxState];

export const DepositStatus = {
  PREPARED: "PREPARED",
  SUBMITTED: "SUBMITTED",
  CONFIRMED: "CONFIRMED",
  CREDITED: "CREDITED",
  REJECTED: "REJECTED",
  EXPIRED: "EXPIRED",
} as const;
export type DepositStatus = (typeof DepositStatus)[keyof typeof DepositStatus];

export const TreasuryHealth = {
  HEALTHY: "HEALTHY",
  WATCH: "WATCH",
  WARNING: "WARNING",
  CRITICAL: "CRITICAL",
} as const;
export type TreasuryHealth = (typeof TreasuryHealth)[keyof typeof TreasuryHealth];

export const CircuitBreakerMode = {
  REWARD_PAUSE: "REWARD_PAUSE",
  MARKET_PAUSE: "MARKET_PAUSE",
  WITHDRAWAL_REVIEW: "WITHDRAWAL_REVIEW",
  EVENT_PAUSE: "EVENT_PAUSE",
} as const;
export type CircuitBreakerMode = (typeof CircuitBreakerMode)[keyof typeof CircuitBreakerMode];

export const RiskLevel = { LOW: "LOW", MEDIUM: "MEDIUM", HIGH: "HIGH", CRITICAL: "CRITICAL" } as const;
export type RiskLevel = (typeof RiskLevel)[keyof typeof RiskLevel];

export const RewardSource = {
  PVP: "PVP",
  TOURNAMENT: "TOURNAMENT",
  RANKED_SEASON: "RANKED_SEASON",
  WORLD_BOSS: "WORLD_BOSS",
  RAID: "RAID",
  FACTION_WAR: "FACTION_WAR",
  EVENT: "EVENT",
  ACHIEVEMENT: "ACHIEVEMENT",
  SPECIAL_CAMPAIGN: "SPECIAL_CAMPAIGN",
  LEADERBOARD: "LEADERBOARD",
  GATE: "GATE",
} as const;
export type RewardSource = (typeof RewardSource)[keyof typeof RewardSource];

export const RewardStatus = {
  PENDING_REVIEW: "PENDING_REVIEW",
  CLAIMABLE: "CLAIMABLE",
  CLAIMED: "CLAIMED",
  EXPIRED: "EXPIRED",
  REJECTED: "REJECTED",
} as const;
export type RewardStatus = (typeof RewardStatus)[keyof typeof RewardStatus];

export const AdminRole = {
  SUPER_ADMIN: "SUPER_ADMIN",
  ADMIN: "ADMIN",
  MODERATOR: "MODERATOR",
  SUPPORT: "SUPPORT",
  ECONOMY_MANAGER: "ECONOMY_MANAGER",
} as const;
export type AdminRole = (typeof AdminRole)[keyof typeof AdminRole];

export const ClanRole = {
  LEADER: "LEADER",
  OFFICER: "OFFICER",
  VETERAN: "VETERAN",
  MEMBER: "MEMBER",
  RECRUIT: "RECRUIT",
} as const;
export type ClanRole = (typeof ClanRole)[keyof typeof ClanRole];

export const ClanWarPhase = {
  PREPARATION: "PREPARATION",
  DECLARED: "DECLARED",
  MATCHMAKING: "MATCHMAKING",
  BATTLE: "BATTLE",
  SCORING: "SCORING",
  REWARDED: "REWARDED",
} as const;
export type ClanWarPhase = (typeof ClanWarPhase)[keyof typeof ClanWarPhase];

export const ItemCategory = {
  SHIP: "SHIP",
  WEAPON: "WEAPON",
  MODULE: "MODULE",
  GENERATOR: "GENERATOR",
  DRONE: "DRONE",
  SHIP_PART: "SHIP_PART",
  SKIN: "SKIN",
  COSMETIC: "COSMETIC",
  RESOURCE: "RESOURCE",
  CONSUMABLE: "CONSUMABLE",
  AMMO: "AMMO",
  BLUEPRINT: "BLUEPRINT",
  BOOSTER: "BOOSTER",
  PET: "PET",
} as const;
export type ItemCategory = (typeof ItemCategory)[keyof typeof ItemCategory];

export const QuestType = {
  MAIN_STORY: "MAIN_STORY",
  FACTION: "FACTION",
  DAILY: "DAILY",
  WEEKLY: "WEEKLY",
  MONTHLY: "MONTHLY",
  EVENT: "EVENT",
  PVP: "PVP",
  PVE: "PVE",
  EXPLORATION: "EXPLORATION",
  MINING: "MINING",
  CRAFTING: "CRAFTING",
  CLAN: "CLAN",
  ACHIEVEMENT: "ACHIEVEMENT",
} as const;
export type QuestType = (typeof QuestType)[keyof typeof QuestType];

export const ObjectiveType = {
  KILL: "KILL",
  COLLECT: "COLLECT",
  TRAVEL: "TRAVEL",
  DELIVER: "DELIVER",
  ESCORT: "ESCORT",
  SURVIVE: "SURVIVE",
  DAMAGE_BOSS: "DAMAGE_BOSS",
  COMPLETE_GATE: "COMPLETE_GATE",
  WIN_PVP: "WIN_PVP",
  MINE_RESOURCES: "MINE_RESOURCES",
  CRAFT: "CRAFT",
  KILL_PLAYER: "KILL_PLAYER",
  LEVEL: "LEVEL",
} as const;
export type ObjectiveType = (typeof ObjectiveType)[keyof typeof ObjectiveType];

export const EventType = {
  INVASION: "INVASION",
  WORLD_BOSS: "WORLD_BOSS",
  TREASURE_HUNT: "TREASURE_HUNT",
  DOUBLE_XP: "DOUBLE_XP",
  FACTION_WAR: "FACTION_WAR",
  MINING_FESTIVAL: "MINING_FESTIVAL",
  PVP_WEEKEND: "PVP_WEEKEND",
  RAID_EVENT: "RAID_EVENT",
  SPECIAL_EVENT: "SPECIAL_EVENT",
  SEASON_EVENT: "SEASON_EVENT",
  GLOBAL_RIFT: "GLOBAL_RIFT",
} as const;
export type EventType = (typeof EventType)[keyof typeof EventType];

export const Reputation = {
  NEUTRAL: "NEUTRAL",
  FRIENDLY: "FRIENDLY",
  HOSTILE: "HOSTILE",
  OUTLAW: "OUTLAW",
  BOUNTY_TARGET: "BOUNTY_TARGET",
} as const;
export type Reputation = (typeof Reputation)[keyof typeof Reputation];

export const PremiumTier = { FREE: "FREE", VIP: "VIP", ELITE: "ELITE" } as const;
export type PremiumTier = (typeof PremiumTier)[keyof typeof PremiumTier];

export const ChatChannel = {
  GLOBAL: "GLOBAL",
  FACTION: "FACTION",
  CLAN: "CLAN",
  SQUAD: "SQUAD",
  PRIVATE: "PRIVATE",
  SYSTEM: "SYSTEM",
} as const;
export type ChatChannel = (typeof ChatChannel)[keyof typeof ChatChannel];

export const MatchMode = {
  CASUAL: "CASUAL",
  RANKED: "RANKED",
  ARENA: "ARENA",
  RAID: "RAID",
  LARGE_SCALE: "LARGE_SCALE",
  CLAN_WAR: "CLAN_WAR",
  GATE: "GATE",
  DUEL: "DUEL",
} as const;
export type MatchMode = (typeof MatchMode)[keyof typeof MatchMode];

export const GateDifficulty = {
  NORMAL: "NORMAL",
  HARD: "HARD",
  NIGHTMARE: "NIGHTMARE",
  MYTHIC: "MYTHIC",
} as const;
export type GateDifficulty = (typeof GateDifficulty)[keyof typeof GateDifficulty];

export const Region = { EU: "EU", NA: "NA", ASIA: "ASIA" } as const;
export type Region = (typeof Region)[keyof typeof Region];

export const GraphicsTier = { ULTRA: "ULTRA", HIGH: "HIGH", MEDIUM: "MEDIUM", LOW: "LOW" } as const;
export type GraphicsTier = (typeof GraphicsTier)[keyof typeof GraphicsTier];

export const AuctionType = { HOURLY: "HOURLY", DAILY: "DAILY", WEEKLY: "WEEKLY", EVENT: "EVENT" } as const;
export type AuctionType = (typeof AuctionType)[keyof typeof AuctionType];

export const ListingStatus = {
  ACTIVE: "ACTIVE",
  SOLD: "SOLD",
  CANCELLED: "CANCELLED",
  EXPIRED: "EXPIRED",
} as const;
export type ListingStatus = (typeof ListingStatus)[keyof typeof ListingStatus];

export const CheatType = {
  SPEED_HACK: "SPEED_HACK",
  TELEPORT: "TELEPORT",
  ATTACK_SPEED_HACK: "ATTACK_SPEED_HACK",
  DAMAGE_MANIPULATION: "DAMAGE_MANIPULATION",
  COOLDOWN_BYPASS: "COOLDOWN_BYPASS",
  PACKET_REPLAY: "PACKET_REPLAY",
  PACKET_SPAM: "PACKET_SPAM",
  DUPLICATE_LOOT: "DUPLICATE_LOOT",
  DUPLICATE_REWARD: "DUPLICATE_REWARD",
  FAKE_TRANSACTION: "FAKE_TRANSACTION",
  TRADE_EXPLOIT: "TRADE_EXPLOIT",
  INVENTORY_DUPLICATION: "INVENTORY_DUPLICATION",
  REPEATED_MOVEMENT: "REPEATED_MOVEMENT",
  IMPOSSIBLE_REACTION: "IMPOSSIBLE_REACTION",
  ABNORMAL_FARMING: "ABNORMAL_FARMING",
} as const;
export type CheatType = (typeof CheatType)[keyof typeof CheatType];
