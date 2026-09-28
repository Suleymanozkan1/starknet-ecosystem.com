/**
 * Client-side view of REST payloads that are not (yet) part of @nebula/shared/api.ts.
 * Shapes mirror apps/api/src/routes/* responses; every optional field is rendered defensively.
 */
import type { Currency, Rarity } from "@nebula/shared";

export interface FactionDto {
  id: string;
  name: string;
  tag: string;
  motto: string;
  lore: string;
  color: string;
  secondaryColor: string;
  emblem: string;
  homeMap: string;
  starterShip: string;
  bonus: Record<string, number>;
  members?: number;
  controlledMaps?: number;
}

export interface GameTicketResponse { ticket: string; mapId: string; gameServerUrl: string; roomName?: string }

export interface ShipCatalogEntry {
  defId: string;
  name: string;
  class: string;
  tier: number;
  rarity: Rarity;
  faction?: string | null;
  requiredLevel: number;
  owned: boolean;
  instanceId?: string | null;
  unlock?: { currency: Currency; price: string; productId?: string | null } | null;
}
export interface ShipsResponse {
  ships: import("@nebula/shared").ShipInstanceDto[];
  catalog?: ShipCatalogEntry[];
}

export interface CraftBlueprintDto {
  id: string;
  name: string;
  tier: string;
  outputItem: string;
  outputName?: string;
  outputQuantity: number;
  requiredLevel: number;
  craftTimeSec: number;
  successChance: number;
  credits: number;
  resources: Record<string, number>;
  items?: { itemId: string; quantity: number }[];
  canCraft?: boolean;
  missing?: string[];
}
export interface CraftJobDto {
  id: string;
  blueprintId: string;
  status: string;
  startedAt: string;
  completesAt: string;
  success?: boolean | null;
  outputItem?: string;
}

export interface MarketListingDto {
  id: string;
  sellerId: string;
  sellerName?: string;
  itemId: string;
  name: string;
  category?: string;
  rarity: Rarity;
  quantity: number;
  price: string;
  currency: Currency;
  fee?: string;
  status: string;
  expiresAt: string;
  createdAt: string;
  mine?: boolean;
}
export interface MarketResponse { listings: MarketListingDto[]; feePercent?: number; total?: number }

export interface AuctionDto {
  id: string;
  sellerId: string;
  sellerName?: string;
  itemId: string;
  name: string;
  rarity: Rarity;
  quantity: number;
  type: string;
  currency: Currency;
  startPrice: string;
  buyoutPrice: string | null;
  currentBid: string | null;
  currentBidderId: string | null;
  minNextBid?: string;
  bidCount?: number;
  listingFee?: string;
  status: string;
  endsAt: string;
  mine?: boolean;
  leading?: boolean;
}
export interface AuctionsResponse { auctions: AuctionDto[]; fees?: { listing: number; sale: number; cancellation: number } }

export interface ClanSummaryDto {
  id: string;
  name: string;
  tag: string;
  level: number;
  factionId: string | null;
  score: string | number;
  memberCount: number;
  description?: string;
}
export interface ClanMemberDto { userId: string; username: string; role: string; level: number; contribution: string; joinedAt: string; online?: boolean }
export interface ClanWarDto { id: string; opponent: { id: string; name: string; tag: string }; phase: string; mapId: string; scoreUs: number; scoreThem: number; startsAt: string; endsAt: string; winnerId: string | null }
export interface ClanStationDto { id: string; mapId: string; level: number; hull: number; maxHull: number; shield: number; maxShield: number; modules: { kind: string; level: number }[]; underAttackAt: string | null }
export interface ClanDetailDto extends ClanSummaryDto {
  announcement?: string;
  bankCredits: string;
  xp?: string | number;
  members: ClanMemberDto[];
  wars?: ClanWarDto[];
  stations?: ClanStationDto[];
  territories?: { mapId: string; capturedAt: string }[];
  myRole?: string | null;
}

export interface FriendDto { id: string; userId: string; username: string; level: number; faction: string | null; status: "PENDING" | "ACCEPTED" | "BLOCKED" | string; online?: boolean; incoming?: boolean }
export interface ChatMessageDto { id: string; channel: string; senderId: string; from: string; text: string; createdAt: string; faction?: string | null }
export interface NotificationDto { id: string; type: string; title: string; body: string; data?: Record<string, unknown>; readAt: string | null; createdAt: string }
export interface MailDto {
  id: string;
  fromUserId: string | null;
  fromName?: string | null;
  system: boolean;
  subject: string;
  body: string;
  attachments: { credits?: number; gems?: number; items?: { itemId: string; quantity: number; name?: string }[] } | null;
  claimedAt: string | null;
  readAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface AchievementDto { id: string; name: string; description: string; category: string; progress: number; threshold: number; unlockedAt: string | null; hidden?: boolean }

export interface BattlePassTierDto {
  tier: number;
  xpRequired: number;
  free?: RewardBundleView | null;
  premium?: RewardBundleView | null;
  freeClaimed: boolean;
  premiumClaimed: boolean;
}
export interface RewardBundleView {
  xp?: number;
  honor?: number;
  credits?: number;
  gems?: number;
  seasonPoints?: number;
  resources?: Record<string, number>;
  items?: { itemId: string; quantity: number; name?: string }[];
  cryptoEligible?: { source: string; weight: number };
}
export interface BattlePassResponse {
  passId: string;
  seasonId: string;
  name: string;
  xp: number;
  tier: number;
  premium: boolean;
  premiumProductId?: string | null;
  tiers: BattlePassTierDto[];
}

export interface SeasonDto {
  id: string;
  number: number;
  name: string;
  theme: string;
  startAt: string;
  endAt: string;
  active: boolean;
  bossId?: string;
  battlePassId?: string;
  myPoints?: number;
  myRank?: number | null;
  leaderboardRewards?: { rankFrom: number; rankTo: number; bundle: RewardBundleView }[];
  rankedRewards?: { tier: string; minRating: number; bundle: RewardBundleView }[];
}

export interface GameEventDto {
  id: string;
  name: string;
  type: string;
  description: string;
  startAt: string;
  endAt: string;
  active: boolean;
  maps: string[];
  boss?: string | null;
  xpMultiplier?: number;
  dropMultiplier?: number;
  rewards?: { tier: string; minContribution: number; bundle: RewardBundleView }[];
}
export interface EventsResponse { active: GameEventDto[]; upcoming: GameEventDto[] }

export interface GalaxyMapNode {
  id: string;
  name: string;
  sector: string;
  system: string;
  roomType: string;
  pvp: boolean;
  levelRange: [number, number];
  zoneTypes: string[];
  factionHome?: string | null;
  population?: number;
  controlledBy?: { clanTag?: string; faction?: string } | null;
  portals: { id: string; targetMap: string; kind: string; requiredLevel: number }[];
}
export interface GalaxyResponse {
  id: string;
  name: string;
  sectors: { id: string; name: string; systems: { id: string; name: string; maps: string[] }[] }[];
  maps: GalaxyMapNode[];
}

export interface SquadDto { id: string; leaderId: string; members: { userId: string; username: string; level: number; online?: boolean }[] }
export interface BountyDto { id: string; targetId: string; targetName?: string; amount: string; currency: Currency; status: string; expiresAt: string }
