/**
 * Client-side view of REST payloads that are not part of @nebula/shared/api.ts.
 * Shapes mirror apps/api/src/routes/* responses exactly (see each comment for the route).
 */
import type {
  AchievementDef, BattlePassTierDef, Currency, Rarity, RewardBundle, SeasonDef, ShipDef, ShipInstanceDto, ShopProductDto, WalletResponse,
  WithdrawQuoteDto, WithdrawalLimitsDto, BalancesDto, DepositDto,
} from "@nebula/shared";

export type RewardBundleView = RewardBundle & { items?: { itemId: string; quantity: number; name?: string }[] };

/** GET /api/factions */
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
  homeSector?: string;
  starterShip: string;
  bonus: Record<string, number>;
  members?: number;
  score?: string;
  territory?: number;
}

/** POST /api/game/ticket */
export interface GameTicketResponse { ticket: string; mapId: string; gameServerUrl: string; expiresAt: string }

/** GET /api/ships */
export interface ShipCatalogEntry {
  id: string;
  name: string;
  class: string;
  tier: number;
  rarity: Rarity;
  faction: string | null;
  description: string;
  stats: ShipDef["stats"];
  slots: ShipDef["slots"];
  visual: ShipDef["visual"];
  abilities: ShipDef["abilities"];
  owned: boolean;
  unlock: {
    requiredLevel: number;
    product: { productId: string; currency: Currency; price: string } | null;
    method: "SHOP" | "FACTION_STARTER" | "CRAFT_OR_EVENT" | string;
  };
}
export interface ShipsResponse { owned: ShipInstanceDto[]; catalog: ShipCatalogEntry[] }

export interface UpgradeCost { toLevel: number; credits: number; gems: number; resources: Record<string, number>; successChance: number }
export interface UpgradeCostResponse { maxed: boolean; cost: UpgradeCost | null }
export interface UpgradeResult { success: boolean; fromLevel: number; toLevel: number; cost: UpgradeCost }

/** GET /api/shop */
export interface ShopProductView extends ShopProductDto {
  stock?: number | null;
  limitPerUser?: number | null;
  /** SOL/NEBX-priced products are bought through the on-chain deposit flow. */
  purchaseFlow?: "LEDGER" | "DEPOSIT";
}

/** GET /api/crafting/blueprints → jobs */
export interface CraftJobDto { id: string; blueprintId: string; status: string; startedAt?: string; completesAt: string; ready?: boolean }

/** GET /api/market, /api/market/mine */
export interface MarketListingDto {
  id: string;
  sellerId: string;
  seller: string | null;
  itemId: string;
  name: string;
  category: string | null;
  rarity: Rarity | null;
  quantity: number;
  upgradeLevel: number;
  affixes: { stat: string; value: number }[];
  price: string;
  currency: Currency;
  fee: string;
  sellerReceives: string;
  status: string;
  expiresAt: string;
  createdAt: string;
}
export interface MarketResponse { listings: MarketListingDto[]; feeRate?: number }

/** GET /api/auctions */
export interface AuctionDto {
  id: string;
  sellerId: string;
  itemId: string;
  name: string;
  rarity: Rarity | null;
  quantity: number;
  type: string;
  currency: Currency;
  startPrice: string;
  buyoutPrice: string | null;
  currentBid: string | null;
  currentBidderId: string | null;
  listingFee: string;
  minNextBid: string;
  status: string;
  endsAt: string;
  createdAt: string;
}
export interface AuctionsResponse { auctions: AuctionDto[]; fees: { listing: number; sale: number; cancellation: number } }

/** GET /api/clans */
export interface ClanSummaryDto { id: string; name: string; tag: string; level: number; score: string; members: number; factionId: string | null }
export interface ClanMemberDto { userId: string; username: string; level: number; role: string; contribution: string; joinedAt: string }
export interface ClanStationDto { id: string; mapId: string; level: number; hull: number; maxHull: number; shield: number; maxShield: number; modules: { kind: string; level: number }[] }
/** GET /api/clans/:id (announcement/treasury only for members) */
export interface ClanDetailDto {
  id: string;
  name: string;
  tag: string;
  description: string;
  level: number;
  score: string;
  factionId: string | null;
  announcement: string | null;
  treasury: string | null;
  diplomacy: Record<string, string>;
  members: ClanMemberDto[];
  stations: ClanStationDto[];
  territories: string[];
}
/** GET /api/clans/:id/wars (raw rows) */
export interface ClanWarDto { id: string; clanAId: string; clanBId: string; phase: string; mapId: string; scoreA: number; scoreB: number; winnerId: string | null; startsAt: string; endsAt: string }

/** GET /api/friends */
export interface FriendUser { id: string; username: string; level: number; online?: boolean }
export interface FriendsResponse { friends: FriendUser[]; incoming: FriendUser[]; outgoing: FriendUser[]; blocked: FriendUser[] }

/** GET /api/chat/history */
export interface ChatMessageDto { id: string; channel: string; from: string; fromId: string; text: string; at: number }

/** GET /api/notifications */
export interface NotificationDto { id: string; type: string; title: string; body: string; data?: Record<string, unknown>; read: boolean; createdAt: string }
export interface NotificationsResponse { unread: number; notifications: NotificationDto[] }

/** GET /api/mail */
export interface MailDto {
  id: string;
  fromUserId: string | null;
  system: boolean;
  subject: string;
  body: string;
  attachments: RewardBundleView | null;
  hasAttachments: boolean;
  claimed: boolean;
  read: boolean;
  expiresAt: string | null;
  createdAt: string;
}

/** GET /api/achievements */
export interface AchievementDto extends Pick<AchievementDef, "id" | "name" | "description" | "category" | "metric" | "threshold"> {
  progress: number;
  rewards: RewardBundleView;
  unlocked: boolean;
  unlockedAt: string | null;
  claimed: boolean;
}

/** GET /api/battlepass */
export type BattlePassResponse =
  | { active: false; pass: null }
  | {
      active: true;
      seasonId: string;
      pass: { id: string; name: string; tiers: BattlePassTierDef[] };
      premiumProductId: string | null;
      state: { xp: number; tier: number; premium: boolean; claimedFree: number[]; claimedPremium: number[] };
    };

/** GET /api/seasons */
export type SeasonDto = SeasonDef & { active: boolean };

/** GET /api/events */
export interface GameEventDto {
  id: string;
  name: string;
  type: string;
  description: string;
  maps: string[];
  boss: string | null;
  xpMultiplier: number;
  dropMultiplier: number;
  rewards: { tier: string; minContribution: number; bundle: RewardBundleView }[];
  active: boolean;
  window: { start: string; end: string } | null;
  next: { start: string; end: string } | null;
}
export interface EventsView { active: GameEventDto[]; upcoming: GameEventDto[] }

/** GET /api/galaxy/maps/:id */
export interface MapLiveResponse { rooms: { id: string; clients: number; maxClients: number; region: string }[] }

/** GET /api/squad */
export interface SquadDto { id: string; leaderId: string; minSize: number; maxSize: number; members: { userId: string; username: string; level: number; online: boolean }[] }

/** GET /api/bounties */
export interface BountyDto { targetId: string; username: string | null; level: number | null; total: string; count: number }

/** POST /api/wallet/deposit/verify */
export interface DepositVerifyResponse { deposit: DepositDto; balances: BalancesDto; gems?: number; explorerUrl?: string; alreadyCredited?: boolean }
/** 202 from verify: the transaction is not final yet — retry. */
export interface DepositPending { error: { code: string; message: string; retryable: true } }
/** GET /api/wallet/withdraw/quote */
export type WithdrawQuoteResponse = WithdrawQuoteDto & { limits: WithdrawalLimitsDto };
export type { WalletResponse };
