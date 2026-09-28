/**
 * Data-driven game definitions. Every balance number lives in JSON
 * (packages/config/data/*.json) or the database (EconomyConfig, ShopProduct),
 * never in code. These interfaces describe those documents.
 */
import type {
  BlueprintTier, Currency, DamageElement, DroneType, EventType, GateDifficulty, ItemCategory,
  ModuleKind, ObjectiveType, PortalKind, PremiumTier, QuestType, Rarity, ResourceId, RewardSource,
  ShipClass, WeaponSlot, WeaponType, ZoneType,
} from "./enums.js";

export type Resistances = Partial<Record<DamageElement, number>>;

/** Modular visual description consumed by the procedural ship builder (game-renderer). */
export interface ShipVisualDef {
  /** Hull silhouette archetype. Each ship uses a different combination. */
  hull: "dart" | "arrowhead" | "wedge" | "hammer" | "manta" | "spine" | "crescent" | "monolith" | "trident" | "beetle" | "needle" | "halo";
  engine: "twin" | "quad" | "ring" | "single-large" | "cluster" | "ion-array" | "vector";
  wings: "none" | "swept" | "forward-swept" | "delta" | "x-wing" | "folded" | "blade" | "ring" | "canard";
  cockpit: "bubble" | "slit" | "bridge" | "canopy" | "sensor-eye" | "none";
  reactor: "exposed-core" | "twin-cell" | "ring-core" | "buried";
  armor: "light" | "plated" | "heavy" | "ablative" | "crystal";
  antenna: "none" | "mast" | "array" | "dish" | "spikes";
  cargo: "none" | "pods" | "hold" | "container-rack";
  droneDock: boolean;
  /** Relative scale in world units (1 = interceptor-size). */
  scale: number;
  length: number;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  engineColor: string;
  /** Optional production GLB to load instead of / in addition to procedural geometry. */
  glb?: string;
  /** Weapon hardpoint positions in ship-local space [x, y, z] (x right, z forward). */
  hardpoints: [number, number, number][];
  /** Engine nozzle positions. */
  nozzles: [number, number, number][];
}

export interface ShipAbilityDef {
  id: string;
  name: string;
  kind: "PASSIVE" | "ACTIVE" | "ULTIMATE";
  description: string;
  cooldownMs: number;
  durationMs: number;
  energyCost: number;
  /** Effect payload interpreted by game-core ability system. */
  effect: AbilityEffect;
}

export type AbilityEffect =
  | { type: "SHIELD_RESTORE"; percent: number }
  | { type: "HULL_REPAIR"; percent: number }
  | { type: "SPEED_BOOST"; multiplier: number }
  | { type: "DAMAGE_BOOST"; multiplier: number }
  | { type: "DAMAGE_REDUCTION"; multiplier: number }
  | { type: "EMP"; radius: number; shieldDamagePercent: number; stunMs: number }
  | { type: "CLOAK" }
  | { type: "BARRAGE"; radius: number; damage: number; element: DamageElement }
  | { type: "DASH"; distance: number }
  | { type: "PASSIVE_STAT"; stat: StatKey; percent: number };

export type StatKey =
  | "hull" | "shield" | "energy" | "speed" | "acceleration" | "turnRate" | "cargo"
  | "damage" | "shieldDamage" | "hullDamage" | "pveDamage" | "pvpDamage" | "range" | "critChance" | "critDamage"
  | "energyCost" | "fireRate" | "shieldRegen" | "energyRegen" | "armor" | "miningSpeed" | "heatCapacity"
  | "cooldownReduction" | "evasion";

export interface ShipDef {
  id: string;
  name: string;
  class: ShipClass;
  faction?: string;
  tier: number;
  rarity: Rarity;
  description: string;
  requiredLevel: number;
  stats: {
    hull: number;
    shield: number;
    armor: number;
    energy: number;
    energyRegen: number;
    shieldRegen: number;
    speed: number;
    acceleration: number;
    turnRate: number;
    cargo: number;
    heatCapacity: number;
  };
  slots: {
    laser: number;
    missile: number;
    generator: number;
    module: number;
    drone: number;
    ability: number;
  };
  resistances: Resistances;
  abilities: ShipAbilityDef[];
  visual: ShipVisualDef;
  /** Credits/gems are only for display defaults — authoritative prices live in shop.json / ShopProduct. */
  tradeable: boolean;
  nftEligible: boolean;
}

export interface WeaponDef {
  id: string;
  name: string;
  type: WeaponType;
  slot: WeaponSlot;
  rarity: Rarity;
  requiredLevel: number;
  damage: number;
  /** World units. */
  range: number;
  /** 0..1 */
  accuracy: number;
  /** Shots per second. */
  fireRate: number;
  energyCost: number;
  heat: number;
  critChance: number;
  critDamage: number;
  /** 0..1 fraction of armor ignored. */
  armorPenetration: number;
  shieldDamage: number;
  hullDamage: number;
  element: DamageElement;
  /** Projectile speed (units/s); 0 = hitscan beam. */
  projectileSpeed: number;
  /** Consumable ammo id if the weapon uses ammo (missiles). */
  ammo?: string;
  splashRadius?: number;
  visual: { color: string; style: "beam" | "bolt" | "slug" | "missile" | "torpedo" | "wave" | "mine" };
  tradeable: boolean;
}

export interface ModuleDef {
  id: string;
  name: string;
  kind: ModuleKind;
  /** Generators are passive stat modules that fill generator slots. */
  slot: "MODULE" | "GENERATOR";
  rarity: Rarity;
  requiredLevel: number;
  cooldownMs: number;
  durationMs: number;
  energyCost: number;
  passive: Partial<Record<StatKey, number>>;
  active?: AbilityEffect;
  description: string;
  tradeable: boolean;
}

export interface DroneDef {
  id: string;
  name: string;
  type: DroneType;
  rarity: Rarity;
  requiredLevel: number;
  maxLevel: number;
  /** Stat bonuses per level applied to owning ship. */
  passivePerLevel: Partial<Record<StatKey, number>>;
  /** Drone weapon damage per level (COMBAT drones). */
  damagePerLevel: number;
  hull: number;
  visual: { shape: "orb" | "dart" | "ring" | "claw" | "prism"; color: string };
  tradeable: boolean;
}

export interface PetDef {
  id: string;
  name: string;
  abilities: ("LOOT_COLLECT" | "REPAIR" | "RADAR" | "ENEMY_SCAN" | "RESOURCE_DETECTION" | "PASSIVE_BUFF")[];
  maxLevel: number;
  lootRadius: number;
  repairPerSecond: number;
  radarBonus: number;
  buff: Partial<Record<StatKey, number>>;
}

export interface NpcFactionDef {
  id: string;
  name: string;
  lore: string;
  color: string;
  weakness: DamageElement;
  resistance: DamageElement;
}

export interface NpcDef {
  id: string;
  name: string;
  faction: string;
  kind: "NPC" | "BOSS";
  level: number;
  hull: number;
  shield: number;
  armor: number;
  speed: number;
  turnRate: number;
  damage: number;
  fireRate: number;
  range: number;
  aggroRange: number;
  element: DamageElement;
  resistances: Resistances;
  behavior: "PASSIVE" | "DEFENSIVE" | "AGGRESSIVE" | "COWARD" | "SWARM" | "BOSS";
  fleeHullPercent: number;
  respawnMs: number;
  xp: number;
  honor: number;
  credits: number;
  lootTable: string;
  visual: { hull: ShipVisualDef["hull"]; scale: number; color: string; accent: string };
  phases?: BossPhaseDef[];
}

export interface BossPhaseDef {
  id: string;
  name: string;
  /** Phase begins when hull% drops to or below this value (1 = start). */
  hullThreshold: number;
  /** Which layer is exposed: SHIELD/ARMOR/REACTOR/ENRAGE. */
  layer: "SHIELD" | "ARMOR" | "REACTOR" | "ENRAGE";
  damageMultiplier: number;
  fireRateMultiplier: number;
  /** Damage multiplier when a weak point is hit. */
  weakPointMultiplier: number;
  specialAttack?: { name: string; everyMs: number; radius: number; damage: number; element: DamageElement };
  adds?: { npcId: string; count: number; everyMs: number };
}

export interface LootEntry {
  kind: "ITEM" | "RESOURCE" | "CREDITS" | "GEMS" | "BLUEPRINT";
  ref: string;
  weight: number;
  min: number;
  max: number;
  rarity?: Rarity;
}
export interface LootTableDef {
  id: string;
  rolls: number;
  /** Chance that nothing drops per roll. */
  emptyWeight: number;
  entries: LootEntry[];
}

export interface ZoneDef {
  id: string;
  type: ZoneType;
  /** Circle in map coordinates. */
  x: number;
  y: number;
  radius: number;
}
export interface PortalDef {
  id: string;
  kind: PortalKind;
  x: number;
  y: number;
  targetMap: string;
  targetPortal: string;
  requiredLevel: number;
}
export interface SpawnDef {
  npcId: string;
  count: number;
  x: number;
  y: number;
  radius: number;
}
export interface AsteroidFieldDef {
  x: number;
  y: number;
  radius: number;
  count: number;
  resources: { id: ResourceId; weight: number }[];
}
export interface StationDef {
  id: string;
  name: string;
  x: number;
  y: number;
  faction?: string;
  services: ("DOCK" | "HANGAR" | "SHOP" | "REPAIR" | "CRAFTING" | "MARKET" | "QUEST_BOARD" | "FACTION_HQ" | "CLAN")[];
}
export interface MapDef {
  id: string;
  name: string;
  sector: string;
  system: string;
  width: number;
  height: number;
  pvp: boolean;
  /** Room type that hosts this map. */
  roomType: "sector" | "pvp" | "boss" | "gate" | "raid" | "arena" | "clanwar" | "event";
  maxPlayers: number;
  levelRange: [number, number];
  factionHome?: string;
  environment: { nebulaColors: string[]; starDensity: number; fog: number; ambient: string; skybox?: string };
  zones: ZoneDef[];
  portals: PortalDef[];
  spawns: SpawnDef[];
  asteroidFields: AsteroidFieldDef[];
  stations: StationDef[];
  decor: { kind: "WRECK" | "DERELICT" | "PLANET" | "MOON" | "STATION_RUIN" | "BEACON"; x: number; y: number; scale: number }[];
}

export interface GalaxyDef {
  id: string;
  name: string;
  sectors: { id: string; name: string; systems: { id: string; name: string; maps: string[] }[] }[];
}

export interface FactionDef {
  id: string;
  name: string;
  tag: string;
  motto: string;
  lore: string;
  color: string;
  secondaryColor: string;
  emblem: string;
  homeSector: string;
  homeMap: string;
  starterShip: string;
  /** `ammo` (optional): starter consumable stacks granted with the starter ship (e.g. missile ammo). */
  starterLoadout: { weapons: string[]; modules: string[]; drones: string[]; ammo?: { itemId: string; quantity: number }[] };
  bonus: Partial<Record<StatKey, number>>;
}

export interface QuestObjectiveDef {
  type: ObjectiveType;
  target?: string;
  count: number;
  map?: string;
}
export interface QuestDef {
  id: string;
  name: string;
  type: QuestType;
  chapter?: number;
  description: string;
  requiredLevel: number;
  faction?: string;
  prerequisites: string[];
  objectives: QuestObjectiveDef[];
  rewards: RewardBundle;
  repeatable: boolean;
}

export interface RewardBundle {
  xp?: number;
  honor?: number;
  credits?: number;
  gems?: number;
  seasonPoints?: number;
  passXp?: number;
  resources?: Partial<Record<ResourceId, number>>;
  items?: { itemId: string; quantity: number }[];
  /** Crypto reward eligibility — routed through the reward engine, never granted directly. */
  cryptoEligible?: { source: RewardSource; weight: number };
}

export interface EventDef {
  id: string;
  name: string;
  type: EventType;
  description: string;
  startAt: string;
  endAt: string;
  /** Optional cron-like recurrence in hours (e.g. every 6h for 1h). */
  recurrence?: { everyHours: number; durationMinutes: number };
  maps: string[];
  boss?: string;
  xpMultiplier: number;
  dropMultiplier: number;
  rewards: { tier: string; minContribution: number; bundle: RewardBundle }[];
}

export interface ItemAffixDef {
  id: string;
  stat: StatKey;
  min: number;
  max: number;
  /** Hard cap for the stat across all affixes on one item. */
  cap: number;
  weight: number;
  pvpNormalized: boolean;
}

export interface ItemDef {
  id: string;
  name: string;
  category: ItemCategory;
  rarity: Rarity;
  /** Reference to ships/weapons/modules/drones def id when category matches. */
  ref?: string;
  description: string;
  stackable: boolean;
  maxStack: number;
  tradeable: boolean;
  soulbound: boolean;
  premium: boolean;
  cosmetic: boolean;
  powerItem: boolean;
  nftEligible: boolean;
  /** Cosmetic payload for skins/effects. */
  cosmeticPayload?: CosmeticPayload;
  baseValue: number;
}

export interface CosmeticPayload {
  slot: "HULL_SKIN" | "ENGINE_EFFECT" | "ENGINE_COLOR" | "WEAPON_SKIN" | "SHIELD_COLOR" | "SHIELD_EFFECT" | "TRAIL" | "DRONE_SKIN" | "EXPLOSION" | "NAMEPLATE" | "BADGE" | "EMBLEM" | "TITLE";
  shipId?: string;
  colors?: string[];
  /** Geometry overrides for skins that change silhouette. */
  geometry?: Partial<Pick<ShipVisualDef, "wings" | "armor" | "engine" | "antenna" | "cockpit">> & { hardpoints?: [number, number, number][] };
  effect?: string;
  text?: string;
}

export interface BlueprintDef {
  id: string;
  name: string;
  tier: BlueprintTier;
  outputItem: string;
  outputQuantity: number;
  requiredLevel: number;
  craftTimeSec: number;
  successChance: number;
  credits: number;
  resources: Partial<Record<ResourceId, number>>;
  items?: { itemId: string; quantity: number }[];
}

export interface ShopProductDef {
  id: string;
  sku: string;
  name: string;
  category: "SHIPS" | "SHIP_PARTS" | "WEAPONS" | "MODULES" | "SKINS" | "COSMETICS" | "BOOSTERS" | "BATTLE_PASS" | "PREMIUM" | "BUNDLES" | "GEMS" | "AMMO" | "DRONES";
  description: string;
  currency: Currency;
  /** Price in currency base units (credits/gems integer; NEBX/SOL lamports). */
  price: number;
  grants: RewardBundle & { ships?: string[]; premium?: { tier: PremiumTier; days: number }; battlePassPremium?: boolean };
  requiredLevel: number;
  stock?: number;
  limitPerUser?: number;
  active: boolean;
  featured?: boolean;
}

export interface BattlePassTierDef {
  tier: number;
  xpRequired: number;
  free?: RewardBundle;
  premium?: RewardBundle;
}
export interface BattlePassDef {
  id: string;
  seasonId: string;
  name: string;
  premiumProductSku: string;
  tiers: BattlePassTierDef[];
}

export interface SeasonDef {
  id: string;
  number: number;
  name: string;
  theme: string;
  startAt: string;
  endAt: string;
  bossId: string;
  battlePassId: string;
  leaderboardRewards: { rankFrom: number; rankTo: number; bundle: RewardBundle }[];
  rankedRewards: { tier: string; minRating: number; bundle: RewardBundle }[];
}

export interface GateWaveDef {
  name: string;
  npcs: { npcId: string; count: number }[];
  elite?: boolean;
  boss?: boolean;
}
export interface GateDef {
  id: string;
  name: string;
  map: string;
  requiredLevel: number;
  entryCost: { credits?: number; resources?: Partial<Record<ResourceId, number>> };
  waves: GateWaveDef[];
  difficulties: Record<GateDifficulty, { hullMultiplier: number; damageMultiplier: number; rewardMultiplier: number }>;
  rewards: RewardBundle;
}

export interface AchievementDef {
  id: string;
  name: string;
  description: string;
  category: "COMBAT" | "PVE" | "PVP" | "EXPLORATION" | "MINING" | "CRAFTING" | "SOCIAL" | "ECONOMY" | "SEASON";
  metric: string;
  threshold: number;
  rewards: RewardBundle;
  hidden?: boolean;
}

/** Progression curve and generic formulas. */
export interface ProgressionConfig {
  maxLevel: number;
  /** xpForLevel(n) = round(base * n^exponent) cumulative. */
  xpBase: number;
  xpExponent: number;
  ranks: { id: string; name: string; minHonor: number; minLevel: number }[];
  prestigeLevel: number;
  upgrade: {
    maxLevel: number;
    statPercentPerLevel: number;
    creditsBase: number;
    creditsGrowth: number;
    resourceBase: Partial<Record<ResourceId, number>>;
    resourceGrowth: number;
    successChanceBase: number;
    successChanceDecay: number;
    gemsFromLevel: number;
    gemsPerLevel: number;
  };
  repair: { creditsPerHullPoint: number; deathRepairPercent: number };
  respawnMs: number;
  gearScoreWeights: Record<string, number>;
}

export interface EconomyConfigDoc {
  currencies: Record<Currency, { decimals: number; symbol: string; onChain: boolean }>;
  rewardBudgetRatio: number;
  treasuryReserveRatio: number;
  operatingReserveRatio: number;
  emergencyReserveRatio: number;
  minTreasuryReserve: number;
  rewardAllocation: Record<"LEADERBOARD" | "TOURNAMENT" | "WORLD_EVENTS" | "FACTION_WARS" | "RAIDS" | "ACHIEVEMENTS" | "SPECIAL_CAMPAIGNS", number>;
  emission: { baseRate: number; maxRewardRate: number; activityMultiplierMax: number; seasonMultiplier: number };
  treasuryHealth: { healthy: number; watch: number; warning: number; multipliers: Record<"HEALTHY" | "WATCH" | "WARNING" | "CRITICAL", number> };
  caps: { daily: number; weekly: number; season: number };
  eligibility: { minAccountAgeHours: number; minGameplayMinutes: number; minCompletedMatches: number; claimCooldownMinutes: number; maxRiskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"; eligibleModes: string[] };
  fees: { marketplace: number; auctionListing: number; auctionSale: number; auctionCancellation: number; withdrawalServicePercent: number; withdrawalFlat: number; estimatedNetworkFee: number; tradeTax: number };
  withdrawal: { min: number; max: number; dailyLimit: number; cooldownMinutes: number; minAccountAgeHours: number; walletChangeLockHours: number; reviewThreshold: number };
  inflation: { dailyThreshold: number; weeklyThreshold: number; responses: { rewardMultiplier: number; dropMultiplier: number; sinkMultiplier: number } };
  circuitBreaker: { reserveCoverageMin: number; liabilityRatioMax: number; withdrawalSpikeMultiplier: number; depositSpikeMultiplier: number; botRiskShareMax: number; inflationSpike: number; abnormalOutflowMultiplier: number };
  rewardExpiryDays: number;
  tokenomics: {
    symbol: string;
    maxSupply: number;
    allocation: Record<"TREASURY" | "REWARDS" | "LIQUIDITY" | "OPERATIONS" | "MARKETING" | "TEAM" | "ECOSYSTEM", number>;
    mintAuthorityDisabledAfterGenesis: boolean;
  };
  sinks: { ammoCreditsPerShot: number; travelCreditsPerJump: number; npcServiceFee: number };
  premium: Record<"FREE" | "VIP" | "ELITE", { xpBoost: number; inventorySlots: number; extraDailyQuests: number }>;
}
