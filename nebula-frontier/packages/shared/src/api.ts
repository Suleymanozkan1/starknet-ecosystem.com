/**
 * Typed REST contract between apps/api and the web/admin/mobile clients.
 * Monetary amounts on the wire are strings of integer base units (bigint-safe).
 */
import type {
  AdminRole, CircuitBreakerMode, ClanRole, Currency, DepositStatus, ItemCategory, PremiumTier, Rarity,
  ResourceId, RewardSource, RewardStatus, RiskLevel, TreasuryHealth, WithdrawalStatus,
} from "./enums.js";

export interface ApiError { error: { code: string; message: string; details?: unknown; requestId?: string } }

// ---------------- Auth ----------------
export interface NonceRequest { address: string; purpose?: "LOGIN" | "LINK_WALLET" }
export interface NonceResponse { nonce: string; message: string; expiresAt: string }
export interface VerifyRequest { address: string; nonce: string; signature: string /* base58 */ ; deviceId?: string }
export interface RegisterRequest { email: string; password: string; username: string }
export interface LoginRequest { email: string; password: string; deviceId?: string }
export interface AuthResponse {
  user: MeResponse;
  accessTokenExpiresAt: string;
  /** Double-submit CSRF token (same value as the readable `nf_csrf` cookie); send it as `x-nf-csrf`. */
  csrfToken?: string;
}

// ---------------- User ----------------
export interface MeResponse {
  id: string;
  username: string;
  email: string | null;
  level: number;
  xp: number;
  xpToNext: number;
  xpIntoLevel: number;
  honor: number;
  rank: string;
  prestige: number;
  faction: string | null;
  clan: { id: string; name: string; tag: string; role: ClanRole } | null;
  activeShipInstanceId: string | null;
  premiumTier: PremiumTier;
  premiumUntil: string | null;
  wallets: { address: string; primary: boolean; verifiedAt: string }[];
  balances: BalancesDto;
  roles: AdminRole[];
  riskLevel: RiskLevel;
  createdAt: string;
  restrictions: string[];
}

export interface BalancesDto {
  credits: string;
  gems: string;
  /** Withdrawable crypto reward balance (lamports of the reward asset). */
  nebx: string;
  pendingRewards: string;
  resources: Partial<Record<ResourceId, number>>;
}

export interface ProfileResponse {
  id: string;
  username: string;
  level: number;
  rank: string;
  prestige: number;
  title: string | null;
  faction: string | null;
  clan: { name: string; tag: string } | null;
  ship: { defId: string; name: string } | null;
  gearScore: number;
  pvp: { kills: number; deaths: number; wins: number; rating: number };
  pve: { npcKills: number; bossKills: number; gatesCompleted: number };
  achievements: { id: string; name: string; unlockedAt: string }[];
}

// ---------------- Ships / Inventory ----------------
export interface ShipInstanceDto {
  id: string;
  defId: string;
  name: string;
  upgradeLevel: number;
  active: boolean;
  loadouts: LoadoutDto[];
  activeLoadoutId: string | null;
  stats: Record<string, number>;
  gearScore: number;
  cosmetics: Record<string, string>;
}
export interface LoadoutDto {
  id: string;
  name: string;
  preset: "PVP" | "PVE" | "TANK" | "SPEED" | "MINING" | "BOSS" | "RAID" | "CUSTOM";
  weapons: (string | null)[];
  missiles: (string | null)[];
  generators: (string | null)[];
  modules: (string | null)[];
  drones: (string | null)[];
  formation: string;
  ammo: string | null;
  cosmetics: Record<string, string>;
}

export interface InventoryItemDto {
  id: string;
  itemId: string;
  name: string;
  category: ItemCategory;
  rarity: Rarity;
  quantity: number;
  upgradeLevel: number;
  affixes: { stat: string; value: number }[];
  equippedOn: string | null;
  tradeable: boolean;
  soulbound: boolean;
  value: number;
  power: number;
  acquiredAt: string;
}
export interface InventoryResponse { items: InventoryItemDto[]; capacity: number }
export interface EquipRequest {
  shipInstanceId: string;
  loadoutId: string;
  inventoryItemId: string;
  slotType: "weapons" | "missiles" | "generators" | "modules" | "drones";
  slotIndex: number;
}
export interface UnequipRequest { shipInstanceId: string; loadoutId: string; slotType: EquipRequest["slotType"]; slotIndex: number }

// ---------------- Shop ----------------
export interface ShopProductDto {
  id: string;
  sku: string;
  name: string;
  category: string;
  description: string;
  currency: Currency;
  price: string;
  requiredLevel: number;
  featured: boolean;
  grants: unknown;
}
export interface PurchaseRequest { productId: string; quantity: number; idempotencyKey: string }
export interface PurchaseResponse { purchaseId: string; balances: BalancesDto }

// ---------------- Wallet / Chain ----------------
export interface WalletResponse {
  wallets: { address: string; primary: boolean; verifiedAt: string }[];
  balances: BalancesDto;
  network: string;
  treasuryAddress: string;
  rewardAsset: { symbol: string; mint: string | null; decimals: number };
  limits: WithdrawalLimitsDto;
  deposits: DepositDto[];
  withdrawals: WithdrawalDto[];
}
export interface WithdrawalLimitsDto {
  min: string;
  max: string;
  dailyLimit: string;
  dailyUsed: string;
  cooldownMinutes: number;
  nextAllowedAt: string | null;
  serviceFeePercent: number;
  flatFee: string;
  estimatedNetworkFee: string;
}
export interface DepositPrepareRequest { amount: string; purpose: "GEMS" | "BALANCE"; idempotencyKey: string }
export interface DepositPrepareResponse {
  depositId: string;
  recipient: string;
  amount: string;
  mint: string | null;
  memo: string;
  expiresAt: string;
  network: string;
}
export interface DepositVerifyRequest { depositId: string; signature: string }
export interface DepositDto { id: string; amount: string; status: DepositStatus; signature: string | null; createdAt: string; creditedAt: string | null }
export interface WithdrawQuoteDto { requested: string; serviceFee: string; networkFee: string; final: string }
export interface WithdrawRequest { amount: string; address: string; idempotencyKey: string }
export interface WithdrawalDto {
  id: string;
  requested: string;
  serviceFee: string;
  networkFee: string;
  final: string;
  address: string;
  status: WithdrawalStatus;
  signature: string | null;
  explorerUrl: string | null;
  failureReason: string | null;
  createdAt: string;
  completedAt: string | null;
}

// ---------------- Rewards / Economy ----------------
export interface RewardDto {
  id: string;
  source: RewardSource;
  amount: string;
  status: RewardStatus;
  reason: string;
  expiresAt: string | null;
  createdAt: string;
}
export interface RewardsResponse {
  rewards: RewardDto[];
  claimable: string;
  caps: { daily: string; weekly: string; season: string; dailyUsed: string; weeklyUsed: string; seasonUsed: string };
  eligibility: { eligible: boolean; reasons: string[] };
  rules: string[];
}
export interface EconomyStatusResponse {
  treasuryHealth: TreasuryHealth;
  rewardPoolRemaining: string;
  seasonRewardBudget: string;
  currentRewardRate: number;
  activeBreakers: CircuitBreakerMode[];
  fees: FeesResponse;
}
export interface FeesResponse {
  marketplaceFee: number;
  auctionListingFee: number;
  auctionSaleFee: number;
  auctionCancellationFee: number;
  withdrawalServiceFeePercent: number;
  withdrawalFlatFee: string;
  estimatedNetworkFee: string;
  tradeTax: number;
}
export interface LedgerEntryDto {
  id: string;
  type: string;
  asset: Currency;
  amount: string;
  direction: "CREDIT" | "DEBIT";
  reference: string;
  createdAt: string;
  metadata: unknown;
}

// ---------------- Leaderboard ----------------
export interface LeaderboardResponse {
  board: string;
  season: string | null;
  entries: { rank: number; userId: string; username: string; faction: string | null; clanTag: string | null; score: number; level: number }[];
}

// ---------------- Quests ----------------
export interface QuestDto {
  id: string;
  questId: string;
  name: string;
  type: string;
  description: string;
  objectives: { type: string; target?: string; count: number; progress: number }[];
  status: "ACTIVE" | "COMPLETED" | "CLAIMED";
  rewards: unknown;
}

// ---------------- Admin ----------------
export interface AdminEconomyResponse {
  treasury: { account: string; asset: Currency; balance: string }[];
  treasuryHealth: TreasuryHealth;
  reserveCoverage: number;
  outstandingLiability: string;
  projected30dRewardCost: string;
  availableReserve: string;
  inflation: { daily: number; weekly: number; d30: number };
  supply: { issued: string; burned: string; spent: string; stored: string; withdrawn: string };
  revenue: { gross: string; net: string; bySource: Record<string, string> };
  rewardRate: number;
  activeBreakers: CircuitBreakerMode[];
  config: Record<string, unknown>;
  series: { date: string; revenue: number; rewards: number; deposits: number; withdrawals: number; dau: number; issued: number; burned: number; liability: number; treasury: number }[];
}
export interface EconomyConfigUpdateRequest { key: string; value: unknown; reason: string }
export interface CircuitBreakerRequest { mode: CircuitBreakerMode; active: boolean; reason: string }
export interface RewardRateRequest { rate: number; reason: string }
