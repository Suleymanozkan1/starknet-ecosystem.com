/**
 * Typed REST client for apps/api (routes in apps/api/src/routes/*). DTOs come from @nebula/shared where
 * they exist, otherwise from ./dto.ts. Every call goes through ./http.ts (cookies + CSRF + refresh-once).
 */
import type {
  AuthResponse, BlueprintDef, DepositPrepareRequest, DepositPrepareResponse, DepositVerifyRequest, EconomyStatusResponse,
  EquipRequest, FeesResponse, InventoryResponse, LeaderboardResponse, LedgerEntryDto, LoadoutDto, LoginRequest, MeResponse,
  NonceRequest, NonceResponse, ProfileResponse, PurchaseRequest, PurchaseResponse, QuestDto, RegisterRequest, RewardsResponse,
  ShipInstanceDto, UnequipRequest, VerifyRequest, WalletResponse, WithdrawRequest, WithdrawalDto, BalancesDto,
} from "@nebula/shared";
import { http } from "./http.js";
import type {
  AchievementDto, AuctionsResponse, BattlePassResponse, BountyDto, ChatMessageDto, ClanDetailDto, ClanSummaryDto, ClanWarDto,
  CraftJobDto, DepositPending, DepositVerifyResponse, EventsView, FactionDto, FriendsResponse, GameEventDto, GameTicketResponse,
  MailDto, MapLiveResponse, MarketListingDto, MarketResponse, NotificationsResponse, SeasonDto, ShipsResponse, ShopProductView,
  SquadDto, UpgradeCostResponse, UpgradeResult, WithdrawQuoteResponse,
} from "./dto.js";

type Ok = { ok: boolean };

export const api = {
  auth: {
    nonce: (body: NonceRequest) => http.post<NonceResponse>("/api/auth/nonce", body, { noRefresh: true }),
    verify: (body: VerifyRequest) => http.post<AuthResponse>("/api/auth/verify", body, { noRefresh: true }),
    register: (body: RegisterRequest & { deviceId?: string }) => http.post<AuthResponse>("/api/auth/register", body, { noRefresh: true }),
    login: (body: LoginRequest) => http.post<AuthResponse>("/api/auth/login", body, { noRefresh: true }),
    logout: () => http.post<Ok>("/api/auth/logout", {}, { noRefresh: true }),
    logoutAll: () => http.post<Ok>("/api/auth/logout-all", {}),
    sessions: () => http.get<{ sessions: { id: string; userAgent: string | null; ip: string | null; createdAt: string; lastUsedAt: string; current: boolean }[] }>("/api/auth/sessions"),
  },
  me: {
    get: () => http.get<MeResponse>("/api/me"),
    rename: (username: string) => http.patch<MeResponse>("/api/me", { username }),
    setFaction: (factionId: string) => http.post<MeResponse>("/api/me/faction", { factionId }),
    profile: (userId?: string) => http.get<ProfileResponse>(userId ? `/api/profile/${encodeURIComponent(userId)}` : "/api/profile"),
  },
  factions: {
    list: () => http.get<{ factions: FactionDto[] }>("/api/factions").then((d) => d.factions),
  },
  game: {
    ticket: () => http.post<GameTicketResponse>("/api/game/ticket", {}),
  },
  ships: {
    list: () => http.get<ShipsResponse>("/api/ships"),
    unlock: (shipId: string, idempotencyKey: string) => http.post<{ purchaseId: string; ships: ShipInstanceDto[] }>("/api/ships/unlock", { shipId, idempotencyKey }),
    activate: (shipInstanceId: string) => http.post<{ ships: ShipInstanceDto[] }>("/api/ships/activate", { shipInstanceId }),
    upgradeCost: (shipInstanceId: string) => http.get<UpgradeCostResponse>(`/api/ships/${encodeURIComponent(shipInstanceId)}/upgrade-cost`),
    upgrade: (shipInstanceId: string, idempotencyKey: string) => http.post<UpgradeResult & { ships: ShipInstanceDto[] }>("/api/ships/upgrade", { shipInstanceId, idempotencyKey }),
    createLoadout: (shipInstanceId: string, body: { name: string; preset: LoadoutDto["preset"]; copyFromLoadoutId?: string }) =>
      http.post<LoadoutDto>(`/api/ships/${encodeURIComponent(shipInstanceId)}/loadouts`, body),
    updateLoadout: (shipInstanceId: string, loadoutId: string, body: { name?: string; preset?: LoadoutDto["preset"]; formation?: string; ammo?: string | null }) =>
      http.put<LoadoutDto>(`/api/ships/${encodeURIComponent(shipInstanceId)}/loadouts/${encodeURIComponent(loadoutId)}`, body),
    activateLoadout: (shipInstanceId: string, loadoutId: string) =>
      http.post<{ ships: ShipInstanceDto[] }>(`/api/ships/${encodeURIComponent(shipInstanceId)}/loadouts/${encodeURIComponent(loadoutId)}/activate`, {}),
    deleteLoadout: (shipInstanceId: string, loadoutId: string) => http.del<Ok>(`/api/ships/${encodeURIComponent(shipInstanceId)}/loadouts/${encodeURIComponent(loadoutId)}`),
    setCosmetic: (shipInstanceId: string, slot: string, inventoryItemId: string | null) => http.post<{ ships: ShipInstanceDto[] }>("/api/ships/cosmetics", { shipInstanceId, slot, inventoryItemId }),
  },
  inventory: {
    get: (q: { category?: string; rarity?: string; sort?: string; search?: string } = {}) => http.get<InventoryResponse>("/api/inventory", q),
    equip: (body: EquipRequest) => http.post<{ loadout: LoadoutDto }>("/api/inventory/equip", body),
    unequip: (body: UnequipRequest) => http.post<{ loadout: LoadoutDto }>("/api/inventory/unequip", body),
    upgrade: (inventoryItemId: string, idempotencyKey: string) => http.post<UpgradeResult>("/api/inventory/upgrade", { inventoryItemId, idempotencyKey }),
  },
  shop: {
    list: () => http.get<{ products: ShopProductView[] }>("/api/shop").then((d) => d.products),
    purchase: (body: PurchaseRequest) => http.post<PurchaseResponse & { duplicate?: boolean }>("/api/shop/purchase", body),
  },
  crafting: {
    blueprints: () => http.get<{ blueprints: BlueprintDef[]; jobs: CraftJobDto[] }>("/api/crafting/blueprints"),
    start: (blueprintId: string, idempotencyKey: string) => http.post<CraftJobDto>("/api/crafting/start", { blueprintId, idempotencyKey }),
    claim: (jobId: string) => http.post<{ success: boolean; outputItem: string; quantity: number }>(`/api/crafting/${encodeURIComponent(jobId)}/claim`, {}),
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
    buy: (id: string) => http.post<unknown>(`/api/market/buy/${encodeURIComponent(id)}`, {}),
    cancel: (id: string) => http.post<unknown>(`/api/market/cancel/${encodeURIComponent(id)}`, {}),
  },
  auctions: {
    list: (q: { type?: string } = {}) => http.get<AuctionsResponse>("/api/auctions", q),
    create: (body: { inventoryItemId: string; quantity: number; type: "HOURLY" | "DAILY" | "WEEKLY"; currency: "CREDITS" | "GEMS"; startPrice: string; buyoutPrice?: string }) =>
      http.post<unknown>("/api/auctions", body),
    bid: (id: string, amount: string) => http.post<unknown>(`/api/auctions/${encodeURIComponent(id)}/bid`, { amount }),
    buyout: (id: string) => http.post<unknown>(`/api/auctions/${encodeURIComponent(id)}/buyout`, {}),
    cancel: (id: string) => http.post<unknown>(`/api/auctions/${encodeURIComponent(id)}/cancel`, {}),
  },
  clans: {
    list: (q: { search?: string } = {}) => http.get<{ clans: ClanSummaryDto[] }>("/api/clans", q).then((d) => d.clans),
    get: (id: string) => http.get<ClanDetailDto>(`/api/clans/${encodeURIComponent(id)}`),
    wars: (id: string) => http.get<{ wars: ClanWarDto[] }>(`/api/clans/${encodeURIComponent(id)}/wars`).then((d) => d.wars),
    create: (body: { name: string; tag: string; description?: string }) => http.post<{ id: string; name: string; tag: string }>("/api/clans", body),
    join: (id: string) => http.post<Ok>(`/api/clans/${encodeURIComponent(id)}/join`, {}),
    invite: (id: string, userId: string) => http.post<Ok>(`/api/clans/${encodeURIComponent(id)}/invite`, { userId }),
    leave: () => http.post<Ok>("/api/clans/leave", {}),
    promote: (id: string, userId: string, role: string) => http.post<Ok>(`/api/clans/${encodeURIComponent(id)}/promote`, { userId, role }),
    kick: (id: string, userId: string) => http.post<Ok>(`/api/clans/${encodeURIComponent(id)}/kick`, { userId }),
    deposit: (id: string, amount: string, idempotencyKey: string) => http.post<Ok>(`/api/clans/${encodeURIComponent(id)}/treasury/deposit`, { amount, idempotencyKey }),
    announce: (id: string, announcement: string) => http.patch<Ok>(`/api/clans/${encodeURIComponent(id)}/announcement`, { announcement }),
    declareWar: (id: string, targetClanId: string) => http.post<unknown>(`/api/clans/${encodeURIComponent(id)}/wars`, { targetClanId }),
    acceptWar: (warId: string) => http.post<Ok>(`/api/clans/wars/${encodeURIComponent(warId)}/accept`, {}),
  },
  squad: {
    get: () => http.get<{ squad: SquadDto | null }>("/api/squad").then((d) => d.squad),
    create: () => http.post<{ id: string }>("/api/squad", {}),
    invite: (userId: string) => http.post<Ok>("/api/squad/invite", { userId }),
    join: (squadId: string) => http.post<Ok>(`/api/squad/${encodeURIComponent(squadId)}/join`, {}),
    leave: () => http.post<Ok>("/api/squad/leave", {}),
    kick: (userId: string) => http.post<Ok>("/api/squad/kick", { userId }),
  },
  friends: {
    list: () => http.get<FriendsResponse>("/api/friends"),
    add: (target: { username: string } | { userId: string }) => http.post<{ status: string }>("/api/friends/add", target),
    remove: (userId: string) => http.post<Ok>("/api/friends/remove", { userId }),
    block: (userId: string) => http.post<Ok>("/api/friends/block", { userId }),
    unblock: (userId: string) => http.post<Ok>("/api/friends/unblock", { userId }),
  },
  chat: {
    /** Chat is sent through the game server (ClientMsg.CHAT); REST only serves history. */
    history: (channel: string, key?: string) => http.get<{ messages: ChatMessageDto[] }>("/api/chat/history", { channel, key }).then((d) => d.messages),
    report: (messageId: string, reason: string) => http.post<Ok>("/api/chat/report", { messageId, reason }),
  },
  notifications: {
    list: () => http.get<NotificationsResponse>("/api/notifications"),
    read: (ids: string[] | "all") => http.post<{ updated: number }>("/api/notifications/read", ids === "all" ? { all: true } : { ids }),
    registerPushToken: (body: { token: string; platform: "ios" | "android" | "web"; deviceId: string }) => http.post<Ok>("/api/notifications/push-token", body),
  },
  mail: {
    list: () => http.get<{ mail: MailDto[] }>("/api/mail").then((d) => d.mail),
    read: (id: string) => http.post<Ok>(`/api/mail/${encodeURIComponent(id)}/read`, {}),
    claim: (id: string) => http.post<unknown>(`/api/mail/${encodeURIComponent(id)}/claim`, {}),
  },
  bounties: {
    list: () => http.get<{ bounties: BountyDto[] }>("/api/bounties").then((d) => d.bounties),
    place: (targetUserId: string, amount: string, idempotencyKey: string) => http.post<{ id: string }>("/api/bounties", { targetUserId, amount, idempotencyKey }),
  },
  achievements: {
    list: () => http.get<{ achievements: AchievementDto[] }>("/api/achievements").then((d) => d.achievements),
    claim: (id: string) => http.post<Ok>(`/api/achievements/${encodeURIComponent(id)}/claim`, {}),
  },
  battlepass: {
    get: () => http.get<BattlePassResponse>("/api/battlepass"),
    claim: (tier: number, track: "free" | "premium") => http.post<Ok>("/api/battlepass/claim", { tier, track }),
  },
  seasons: {
    list: () => http.get<{ seasons: SeasonDto[] }>("/api/seasons").then((d) => d.seasons),
  },
  events: {
    list: () => http.get<{ events: GameEventDto[] }>("/api/events").then((d): EventsView => ({
      active: d.events.filter((e) => e.active),
      upcoming: d.events.filter((e) => !e.active && e.next).sort((a, b) => (a.next?.start ?? "").localeCompare(b.next?.start ?? "")),
    })),
  },
  galaxy: {
    map: (mapId: string) => http.get<MapLiveResponse>(`/api/galaxy/maps/${encodeURIComponent(mapId)}`),
  },
  wallet: {
    get: () => http.get<WalletResponse>("/api/wallet"),
    /** Link a wallet to the signed-in account (nonce purpose LINK_WALLET). */
    connect: (body: { address: string; nonce: string; signature: string }) => http.post<WalletResponse>("/api/wallet/connect", body),
    depositPrepare: (body: DepositPrepareRequest & { productId?: string }) => http.post<DepositPrepareResponse>("/api/wallet/deposit/prepare", body),
    depositVerify: (body: DepositVerifyRequest) => http.post<DepositVerifyResponse | DepositPending>("/api/wallet/deposit/verify", body),
    withdrawQuote: (amount: string) => http.get<WithdrawQuoteResponse>("/api/wallet/withdraw/quote", { amount }),
    withdrawCheck: (amount: string, address: string) =>
      http.get<{ ok: boolean; errors: { code: string; message: string }[]; reviewRequired: boolean }>("/api/wallet/withdraw/check", { amount, address }),
    withdraw: (body: WithdrawRequest) => http.post<WithdrawalDto>("/api/wallet/withdraw", body),
  },
  economy: {
    status: () => http.get<EconomyStatusResponse>("/api/economy/status"),
    rewards: () => http.get<RewardsResponse & { nextClaimAt: string | null }>("/api/economy/rewards"),
    transactions: (q: { asset?: string; cursor?: string } = {}) => http.get<{ entries: LedgerEntryDto[]; nextCursor: string | null }>("/api/economy/transactions", q),
    fees: () => http.get<FeesResponse>("/api/economy/fees"),
  },
  rewards: {
    claim: (body: { rewardIds?: string[]; all?: boolean }) => http.post<{ claimed: { rewardId: string; amount: string; alreadyClaimed: boolean }[]; balances: BalancesDto }>("/api/rewards/claim", body),
  },
};

/** Event start/end regardless of active/upcoming. */
export function eventTimes(e: GameEventDto): { start: string; end: string } {
  return e.window ?? e.next ?? { start: new Date().toISOString(), end: new Date().toISOString() };
}

export type Api = typeof api;
