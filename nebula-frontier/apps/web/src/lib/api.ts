/**
 * Typed REST client for apps/api. All DTOs come from @nebula/shared where they exist,
 * otherwise from ./dto.ts. Every call goes through ./http.ts (cookies + CSRF + refresh-once).
 */
import type {
  AuthResponse, DepositDto, DepositPrepareRequest, DepositPrepareResponse, DepositVerifyRequest, EconomyStatusResponse,
  EquipRequest, FeesResponse, InventoryResponse, LeaderboardResponse, LedgerEntryDto, LoginRequest, MeResponse,
  NonceRequest, NonceResponse, ProfileResponse, PurchaseRequest, PurchaseResponse, QuestDto, RegisterRequest,
  RewardsResponse, ShipInstanceDto, ShopProductDto, UnequipRequest, VerifyRequest, WalletResponse, WithdrawQuoteDto,
  WithdrawRequest, WithdrawalDto,
} from "@nebula/shared";
import { http } from "./http.js";
import type {
  AchievementDto, AuctionsResponse, BattlePassResponse, BountyDto, ChatMessageDto, ClanDetailDto, ClanSummaryDto,
  CraftBlueprintDto, CraftJobDto, EventsResponse, FactionDto, FriendDto, GalaxyResponse, GameTicketResponse, MailDto,
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
    list: () => http.get<ShipsResponse | ShipInstanceDto[]>("/api/ships").then((d): ShipsResponse => (Array.isArray(d) ? { ships: d } : d)),
    unlock: (defId: string, idempotencyKey: string) => http.post<ShipInstanceDto>("/api/ships/unlock", { defId, idempotencyKey }),
    activate: (shipInstanceId: string) => http.post<ShipInstanceDto>("/api/ships/activate", { shipInstanceId }),
    upgrade: (shipInstanceId: string, idempotencyKey: string) => http.post<ShipInstanceDto & { success?: boolean }>("/api/ships/upgrade", { shipInstanceId, idempotencyKey }),
    createLoadout: (shipInstanceId: string, body: { name: string; preset: string }) => http.post<ShipInstanceDto>(`/api/ships/${shipInstanceId}/loadouts`, body),
    activateLoadout: (shipInstanceId: string, loadoutId: string) => http.post<ShipInstanceDto>(`/api/ships/${shipInstanceId}/loadouts/${loadoutId}/activate`, {}),
    setCosmetic: (shipInstanceId: string, slot: string, inventoryItemId: string | null) => http.post<ShipInstanceDto>(`/api/ships/${shipInstanceId}/cosmetics`, { slot, inventoryItemId }),
  },
  inventory: {
    get: () => http.get<InventoryResponse>("/api/inventory"),
    equip: (body: EquipRequest) => http.post<ShipInstanceDto>("/api/inventory/equip", body),
    unequip: (body: UnequipRequest) => http.post<ShipInstanceDto>("/api/inventory/unequip", body),
    upgrade: (inventoryItemId: string, idempotencyKey: string) => http.post<{ success: boolean; upgradeLevel: number }>("/api/inventory/upgrade", { inventoryItemId, idempotencyKey }),
  },
  shop: {
    list: () => http.get<unknown>("/api/shop").then(list<ShopProductDto>("products")),
    purchase: (body: PurchaseRequest) => http.post<PurchaseResponse>("/api/shop/purchase", body),
  },
  crafting: {
    blueprints: () => http.get<unknown>("/api/crafting/blueprints").then(list<CraftBlueprintDto>("blueprints")),
    jobs: () => http.get<unknown>("/api/crafting/jobs").then(list<CraftJobDto>("jobs")),
    craft: (blueprintId: string, idempotencyKey: string) => http.post<CraftJobDto>("/api/crafting/craft", { blueprintId, idempotencyKey }),
    collect: (jobId: string) => http.post<CraftJobDto>(`/api/crafting/jobs/${jobId}/collect`, {}),
  },
  quests: {
    list: () => http.get<unknown>("/api/quests").then(list<QuestDto>("quests")),
    available: () => http.get<unknown>("/api/quests/available").then(list<QuestDto>("quests")),
    accept: (questId: string) => http.post<QuestDto>("/api/quests/accept", { questId }),
    claim: (questId: string) => http.post<QuestDto>("/api/quests/claim", { questId }),
  },
  leaderboard: {
    get: (board: string) => http.get<LeaderboardResponse>("/api/leaderboard", { board }),
  },
  market: {
    list: (q: { itemId?: string; category?: string; rarity?: string; sort?: string; mine?: boolean } = {}) => http.get<MarketResponse>("/api/market", q),
    create: (body: { inventoryItemId: string; quantity: number; price: string; currency: string; idempotencyKey: string }) => http.post<unknown>("/api/market/list", body),
    buy: (id: string, idempotencyKey: string) => http.post<unknown>(`/api/market/buy/${id}`, { idempotencyKey }),
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
    connect: (body: { address: string; nonce: string; signature: string }) => http.post<WalletResponse>("/api/wallet/connect", body),
    depositPrepare: (body: DepositPrepareRequest) => http.post<DepositPrepareResponse>("/api/wallet/deposit/prepare", body),
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
