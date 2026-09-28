/**
 * Typed REST client for apps/api. All DTOs come from @nebula/shared where they exist,
 * otherwise from ./dto.ts. Every call goes through ./http.ts (cookies + CSRF + refresh-once).
 */
import type {
  AuthResponse, DepositDto, DepositPrepareRequest, DepositPrepareResponse, DepositVerifyRequest, EconomyStatusResponse,
  EquipRequest, FeesResponse, InventoryResponse, LeaderboardResponse, LedgerEntryDto, LoginRequest, MeResponse,
  NonceRequest, NonceResponse, ProfileResponse, PurchaseRequest, PurchaseResponse, QuestDto, RegisterRequest,
  RewardsResponse, ShipInstanceDto, UnequipRequest, VerifyRequest, WalletResponse, WithdrawQuoteDto,
  WithdrawRequest, WithdrawalDto, LoadoutDto, BlueprintDef,
} from "@nebula/shared";
import { http } from "./http.js";
import type {
  AchievementDto, AuctionsResponse, MarketListingDto, ShopProductView, UpgradeCostResponse, UpgradeResult, BattlePassResponse, BountyDto, ChatMessageDto, ClanDetailDto, ClanSummaryDto,
  CraftJobDto, EventsResponse, FactionDto, FriendDto, GalaxyResponse, GameTicketResponse, MailDto,
  MarketResponse, NotificationDto, SeasonDto, ShipsResponse, SquadDto,
} from "./dto.js";

/** Some list endpoints return a bare array, others `{ <key>: [...] }` — normalize. */
function list<T>(key: string) {
  return (data: unknown): T[] => {
    if (Array.isArray(data)) return data as T[];
    if (data && typeof data === "object") {
      const v = (data as Record<string, unknown>)[key];
      if (Array.isArray(v)) return v as T[];
      const items = (data as Record<string, unknown>).items;
      if (Array.isArray(items)) return items as T[];
    }
    return [];
  };
}

export const api = {
  auth: {
    nonce: (body: NonceRequest) => http.post<NonceResponse>("/api/auth/nonce", body, { noRefresh: true }),
    verify: (body: VerifyRequest) => http.post<AuthResponse>("/api/auth/verify", body, { noRefresh: true }),
    register: (body: RegisterRequest & { deviceId?: string }) => http.post<AuthResponse>("/api/auth/register", body, { noRefresh: true }),
    login: (body: LoginRequest) => http.post<AuthResponse>("/api/auth/login", body, { noRefresh: true }),
    logout: () => http.post<void>("/api/auth/logout", {}, { noRefresh: true }),
  },
  me: {
    get: () => http.get<MeResponse>("/api/me"),
    update: (body: { username?: string; title?: string | null }) => http.patch<MeResponse>("/api/me", body),
    setFaction: (factionId: string) => http.post<MeResponse>("/api/me/faction", { factionId }),
    profile: (userId?: string) => http.get<ProfileResponse>(userId ? `/api/profile/${encodeURIComponent(userId)}` : "/api/me/profile"),
  },
  factions: {
    list: () => http.get<unknown>("/api/factions").then(list<FactionDto>("factions")),
  },
  game: {
    ticket: (body: { mapId?: string; portalId?: string } = {}) => http.post<GameTicketResponse>("/api/game/ticket", body),
  },
  ships: {
    list: () => http.get<ShipsResponse>("/api/ships"),
    unlock: (shipId: string, idempotencyKey: string) => http.post<{ purchaseId: string; ships: ShipInstanceDto[] }>("/api/ships/unlock", { shipId, idempotencyKey }),
    activate: (shipInstanceId: string) => http.post<{ ships: ShipInstanceDto[] }>("/api/ships/activate", { shipInstanceId }),
    upgradeCost: (shipInstanceId: string) => http.get<UpgradeCostResponse>(`/api/ships/${shipInstanceId}/upgrade-cost`),
    upgrade: (shipInstanceId: string, idempotencyKey: string) => http.post<UpgradeResult & { ships: ShipInstanceDto[] }>("/api/ships/upgrade", { shipInstanceId, idempotencyKey }),
    createLoadout: (shipInstanceId: string, body: { name: string; preset: LoadoutDto["preset"]; copyFromLoadoutId?: string }) => http.post<LoadoutDto>(`/api/ships/${shipInstanceId}/loadouts`, body),
    updateLoadout: (shipInstanceId: string, loadoutId: string, body: { name?: string; preset?: LoadoutDto["preset"]; formation?: string; ammo?: string | null }) =>
      http.put<LoadoutDto>(`/api/ships/${shipInstanceId}/loadouts/${loadoutId}`, body),
    activateLoadout: (shipInstanceId: string, loadoutId: string) => http.post<{ ships: ShipInstanceDto[] }>(`/api/ships/${shipInstanceId}/loadouts/${loadoutId}/activate`, {}),
    deleteLoadout: (shipInstanceId: string, loadoutId: string) => http.del<{ ok: boolean }>(`/api/ships/${shipInstanceId}/loadouts/${loadoutId}`),
    setCosmetic: (shipInstanceId: string, slot: string, inventoryItemId: string | null) => http.post<{ ships: ShipInstanceDto[] }>("/api/ships/cosmetics", { shipInstanceId, slot, inventoryItemId }),
  },
  inventory: {
    get: (q: { category?: string; rarity?: string; sort?: string; search?: string } = {}) => http.get<InventoryResponse>("/api/inventory", q),
    equip: (body: EquipRequest) => http.post<{ loadout: LoadoutDto }>("/api/inventory/equip", body),
    unequip: (body: UnequipRequest) => http.post<{ loadout: LoadoutDto }>("/api/inventory/unequip", body),
    upgrade: (inventoryItemId: string, idempotencyKey: string) => http.post<UpgradeResult>("/api/inventory/upgrade", { inventoryItemId, idempotencyKey }),
  },
  shop: {
    list: () => http.get<unknown>("/api/shop").then(list<ShopProductView>("products")),
    purchase: (body: PurchaseRequest) => http.post<PurchaseResponse>("/api/shop/purchase", body),
  },
  crafting: {
    blueprints: () => http.get<{ blueprints: BlueprintDef[]; jobs: CraftJobDto[] }>("/api/crafting/blueprints"),
    start: (blueprintId: string, idempotencyKey: string) => http.post<CraftJobDto>("/api/crafting/start", { blueprintId, idempotencyKey }),
    claim: (jobId: string) => http.post<{ success: boolean; outputItem: string; quantity: number }>(`/api/crafting/${jobId}/claim`, {}),
  },
  quests: {
    list: () => http.get<{ active: QuestDto[]; available: QuestDto[] }>("/api/quests"),
    accept: (questId: string) => http.post<unknown>("/api/quests/accept", { questId }),
    claim: (userQuestId: string) => http.post<unknown>("/api/quests/claim", { userQuestId }),
  },
  leaderboard: {
    get: (board: string) => http.get<LeaderboardResponse>("/api/leaderboard", { board }),
  },
  market: {
    list: (q: { itemId?: string; category?: string; rarity?: string; currency?: string; sort?: "price_asc" | "price_desc" | "recent" } = {}) => http.get<MarketResponse>("/api/market", q),
    mine: () => http.get<MarketResponse>("/api/market/mine"),
    create: (body: { inventoryItemId: string; quantity: number; price: string; currency: "CREDITS" | "GEMS" | "NEBX"; durationHours: number }) =>
      http.post<{ listing: MarketListingDto; feeRate: number }>("/api/market/list", body),
    buy: (id: string) => http.post<unknown>(`/api/market/buy/${id}`, {}),
    cancel: (id: string) => http.post<unknown>(`/api/market/cancel/${id}`, {}),
  },
  auctions: {
    list: (q: { type?: string; mine?: boolean } = {}) => http.get<AuctionsResponse>("/api/auctions", q),
    create: (body: { inventoryItemId: string; quantity: number; type: string; currency: string; startPrice: string; buyoutPrice?: string | null; idempotencyKey: string }) => http.post<unknown>("/api/auctions", body),
    bid: (id: string, amount: string, idempotencyKey: string) => http.post<unknown>(`/api/auctions/${id}/bid`, { amount, idempotencyKey }),
    buyout: (id: string, idempotencyKey: string) => http.post<unknown>(`/api/auctions/${id}/buyout`, { idempotencyKey }),
    cancel: (id: string) => http.post<unknown>(`/api/auctions/${id}/cancel`, {}),
  },
  clans: {
    list: (q: { search?: string } = {}) => http.get<unknown>("/api/clans", q).then(list<ClanSummaryDto>("clans")),
    mine: () => http.get<ClanDetailDto | null>("/api/clans/mine"),
    get: (id: string) => http.get<ClanDetailDto>(`/api/clans/${id}`),
    create: (body: { name: string; tag: string; description?: string }) => http.post<ClanDetailDto>("/api/clans", body),
    join: (id: string) => http.post<unknown>(`/api/clans/${id}/join`, {}),
    leave: () => http.post<unknown>("/api/clans/leave", {}),
    setRole: (userId: string, role: string) => http.post<unknown>("/api/clans/role", { userId, role }),
    kick: (userId: string) => http.post<unknown>("/api/clans/kick", { userId }),
    deposit: (amount: string, idempotencyKey: string) => http.post<unknown>("/api/clans/treasury/deposit", { amount, idempotencyKey }),
    declareWar: (targetClanId: string) => http.post<unknown>("/api/clans/war/declare", { targetClanId }),
  },
  squad: {
    get: () => http.get<SquadDto | null>("/api/squad"),
    create: () => http.post<SquadDto>("/api/squad", {}),
    invite: (userId: string) => http.post<unknown>("/api/squad/invite", { userId }),
    leave: () => http.post<unknown>("/api/squad/leave", {}),
  },
  friends: {
    list: () => http.get<unknown>("/api/friends").then(list<FriendDto>("friends")),
    add: (username: string) => http.post<unknown>("/api/friends", { username }),
    accept: (id: string) => http.post<unknown>(`/api/friends/${id}/accept`, {}),
    remove: (id: string) => http.del<unknown>(`/api/friends/${id}`),
  },
  chat: {
    list: (channel: string, key?: string) => http.get<unknown>("/api/chat", { channel, key }).then(list<ChatMessageDto>("messages")),
    send: (channel: string, text: string, to?: string) => http.post<ChatMessageDto>("/api/chat", { channel, text, ...(to ? { to } : {}) }),
    report: (messageId: string, reason: string) => http.post<unknown>("/api/chat/report", { messageId, reason }),
  },
  notifications: {
    list: () => http.get<unknown>("/api/notifications").then(list<NotificationDto>("notifications")),
    read: (ids: string[] | "all") => http.post<unknown>("/api/notifications/read", ids === "all" ? { all: true } : { ids }),
  },
  mail: {
    list: () => http.get<unknown>("/api/mail").then(list<MailDto>("mail")),
    read: (id: string) => http.post<unknown>(`/api/mail/${id}/read`, {}),
    claim: (id: string) => http.post<unknown>(`/api/mail/${id}/claim`, {}),
    remove: (id: string) => http.del<unknown>(`/api/mail/${id}`),
  },
  bounties: {
    list: () => http.get<unknown>("/api/bounties").then(list<BountyDto>("bounties")),
  },
  achievements: {
    list: () => http.get<unknown>("/api/achievements").then(list<AchievementDto>("achievements")),
  },
  battlepass: {
    get: () => http.get<BattlePassResponse>("/api/battlepass"),
    claim: (tier: number, track: "FREE" | "PREMIUM") => http.post<unknown>("/api/battlepass/claim", { tier, track }),
  },
  seasons: {
    list: () => http.get<unknown>("/api/seasons").then(list<SeasonDto>("seasons")),
  },
  events: {
    list: () => http.get<EventsResponse | unknown>("/api/events").then((d): EventsResponse => {
      if (d && typeof d === "object" && "active" in d) return d as EventsResponse;
      const all = list<import("./dto.js").GameEventDto>("events")(d);
      return { active: all.filter((e) => e.active), upcoming: all.filter((e) => !e.active) };
    }),
  },
  galaxy: {
    get: () => http.get<GalaxyResponse>("/api/galaxy"),
  },
  wallet: {
    get: () => http.get<WalletResponse>("/api/wallet"),
    /** Link an additional wallet (nonce purpose LINK_WALLET). */
    link: (body: { address: string; nonce: string; signature: string }) => http.post<MeResponse>("/api/auth/link-wallet", body),
    depositPrepare: (body: DepositPrepareRequest & { productId?: string }) => http.post<DepositPrepareResponse>("/api/wallet/deposit/prepare", body),
    depositVerify: (body: DepositVerifyRequest) => http.post<DepositDto>("/api/wallet/deposit/verify", body),
    withdrawQuote: (amount: string) => http.get<WithdrawQuoteDto>("/api/wallet/withdraw/quote", { amount }),
    withdraw: (body: WithdrawRequest) => http.post<WithdrawalDto>("/api/wallet/withdraw", body),
  },
  economy: {
    status: () => http.get<EconomyStatusResponse>("/api/economy/status"),
    rewards: () => http.get<RewardsResponse>("/api/economy/rewards"),
    transactions: (q: { asset?: string; cursor?: string } = {}) => http.get<unknown>("/api/economy/transactions", q).then(list<LedgerEntryDto>("entries")),
    fees: () => http.get<FeesResponse>("/api/economy/fees"),
  },
  rewards: {
    claim: (body: { rewardIds?: string[]; idempotencyKey: string }) => http.post<{ claimed: string; count: number }>("/api/rewards/claim", body),
  },
};

export type Api = typeof api;
