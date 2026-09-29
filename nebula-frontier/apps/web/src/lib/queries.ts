import { QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryKey, UseMutationOptions } from "@tanstack/react-query";
import type { MeResponse } from "@nebula/shared";
import { api } from "./api.js";
import { errorMessage, isApiError } from "./http.js";
import { toast } from "../store/ui.js";
import { tNow } from "./i18n.js";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 20_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: true,
      retry: (count, err) => {
        if (isApiError(err) && err.status >= 400 && err.status < 500) return false;
        return count < 2;
      },
    },
    mutations: { retry: false },
  },
});

export const qk = {
  me: ["me"] as const,
  factions: ["factions"] as const,
  ships: ["ships"] as const,
  inventory: ["inventory"] as const,
  shop: ["shop"] as const,
  blueprints: ["crafting", "blueprints"] as const,
  quests: ["quests"] as const,
  leaderboard: (board: string) => ["leaderboard", board] as const,
  market: (q: Record<string, unknown>) => ["market", q] as const,
  auctions: (q: Record<string, unknown>) => ["auctions", q] as const,
  clans: (search: string) => ["clans", search] as const,
  squad: ["squad"] as const,
  friends: ["friends"] as const,
  chat: (channel: string, key?: string) => ["chat", channel, key ?? ""] as const,
  notifications: ["notifications"] as const,
  mail: ["mail"] as const,
  achievements: ["achievements"] as const,
  battlepass: ["battlepass"] as const,
  seasons: ["seasons"] as const,
  events: ["events"] as const,
  galaxy: ["galaxy"] as const,
  wallet: ["wallet"] as const,
  economyStatus: ["economy", "status"] as const,
  rewards: ["economy", "rewards"] as const,
  transactions: ["economy", "transactions"] as const,
  profile: (id?: string) => ["profile", id ?? "me"] as const,
  bounties: ["bounties"] as const,
};

/** Current session. `null` = signed out (401 is not an error here). */
export function useMe() {
  return useQuery<MeResponse | null>({
    queryKey: qk.me,
    queryFn: async () => {
      try {
        return await api.me.get();
      } catch (e) {
        if (isApiError(e) && (e.status === 401 || e.status === 403)) return null;
        throw e;
      }
    },
    staleTime: 30_000,
  });
}

export const useFactions = () => useQuery({ queryKey: qk.factions, queryFn: api.factions.list, staleTime: 10 * 60_000 });
export const useShips = () => useQuery({ queryKey: qk.ships, queryFn: api.ships.list });
export const useInventory = () => useQuery({ queryKey: qk.inventory, queryFn: () => api.inventory.get() });
export const useShop = () => useQuery({ queryKey: qk.shop, queryFn: api.shop.list, staleTime: 60_000 });
export const useCrafting = () => useQuery({ queryKey: qk.blueprints, queryFn: api.crafting.blueprints, refetchInterval: 15_000 });
export const useQuests = () => useQuery({ queryKey: qk.quests, queryFn: api.quests.list });
export const useLeaderboard = (board: string) => useQuery({ queryKey: qk.leaderboard(board), queryFn: () => api.leaderboard.get(board) });
export const useMarket = (q: Parameters<typeof api.market.list>[0] = {}) => useQuery({ queryKey: qk.market(q), queryFn: () => api.market.list(q) });
export const useMyListings = () => useQuery({ queryKey: ["market", "mine"], queryFn: api.market.mine });
export const useAuctions = (q: Parameters<typeof api.auctions.list>[0] = {}) => useQuery({ queryKey: qk.auctions(q), queryFn: () => api.auctions.list(q), refetchInterval: 10_000 });
export const useClans = (search = "") => useQuery({ queryKey: qk.clans(search), queryFn: () => api.clans.list(search ? { search } : {}) });
export const useClan = (id: string | null | undefined) => useQuery({ queryKey: ["clans", "detail", id], queryFn: () => api.clans.get(id!), enabled: Boolean(id) });
export const useClanWars = (id: string | null | undefined) => useQuery({ queryKey: ["clans", "wars", id], queryFn: () => api.clans.wars(id!), enabled: Boolean(id) });
export const useSquad = () => useQuery({ queryKey: qk.squad, queryFn: api.squad.get, refetchInterval: 20_000 });
export const useFriends = () => useQuery({ queryKey: qk.friends, queryFn: api.friends.list, refetchInterval: 30_000 });
export const useChat = (channel: string, key?: string, enabled = true) =>
  useQuery({ queryKey: qk.chat(channel, key), queryFn: () => api.chat.history(channel, key), refetchInterval: 5_000, enabled, retry: false });
export const useNotifications = (enabled = true) => useQuery({ queryKey: qk.notifications, queryFn: api.notifications.list, refetchInterval: 30_000, enabled });
export const useMail = () => useQuery({ queryKey: qk.mail, queryFn: api.mail.list });
export const useAchievements = () => useQuery({ queryKey: qk.achievements, queryFn: api.achievements.list });
export const useBattlePass = () => useQuery({ queryKey: qk.battlepass, queryFn: api.battlepass.get });
export const useSeasons = () => useQuery({ queryKey: qk.seasons, queryFn: api.seasons.list, staleTime: 5 * 60_000 });
export const useEvents = () => useQuery({ queryKey: qk.events, queryFn: api.events.list, refetchInterval: 60_000 });
export const useMapLive = (mapId: string | null | undefined) => useQuery({ queryKey: ["galaxy", "map", mapId], queryFn: () => api.galaxy.map(mapId!), enabled: Boolean(mapId), refetchInterval: 30_000 });
export const useWallet = (enabled = true) => useQuery({ queryKey: qk.wallet, queryFn: api.wallet.get, enabled });
export const useEconomyStatus = () => useQuery({ queryKey: qk.economyStatus, queryFn: api.economy.status, staleTime: 60_000 });
export const useRewards = () => useQuery({ queryKey: qk.rewards, queryFn: api.economy.rewards });
export const useTransactions = () => useQuery({ queryKey: qk.transactions, queryFn: () => api.economy.transactions() });
export const useProfile = (id?: string) => useQuery({ queryKey: qk.profile(id), queryFn: () => api.me.profile(id) });
export const useBounties = () => useQuery({ queryKey: qk.bounties, queryFn: api.bounties.list });

/**
 * Mutation helper: shows an error toast, optional success toast, and invalidates the given keys.
 */
export function useApiMutation<TVars, TData>(
  fn: (vars: TVars) => Promise<TData>,
  opts: { invalidate?: QueryKey[]; success?: string | ((d: TData) => string); errorTitle?: string } & Omit<UseMutationOptions<TData, Error, TVars>, "mutationFn"> = {},
) {
  const qc = useQueryClient();
  const { invalidate, success, errorTitle, onSuccess, onError, ...rest } = opts;
  return useMutation<TData, Error, TVars>({
    mutationFn: fn,
    ...rest,
    onSuccess: async (data, vars, ctx, mctx) => {
      await Promise.all((invalidate ?? []).map((k) => qc.invalidateQueries({ queryKey: k })));
      if (success) toast.success(typeof success === "function" ? success(data) : success);
      await onSuccess?.(data, vars, ctx, mctx);
    },
    onError: (err, vars, ctx, mctx) => {
      toast.error(errorTitle ?? tNow("common.actionFailed"), errorMessage(err));
      onError?.(err, vars, ctx, mctx);
    },
  });
}
