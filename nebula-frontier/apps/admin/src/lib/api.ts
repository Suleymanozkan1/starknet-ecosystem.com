/** Admin REST client (apps/api/src/routes/admin*.ts). Server enforces RBAC; the UI only hides what a role cannot use. */
import type { AdminEconomyResponse, AdminRole, CircuitBreakerMode, EconomyStatusResponse, LeaderboardResponse, MeResponse, RewardDto, WithdrawalDto } from "@nebula/shared";
import { http } from "./http.js";

export interface OverviewResponse {
  players: { online: number; total: number; new24h: number; dau: number; mau: number };
  rooms: { active: number; clients: number; list: { id: string; roomName: string; mapId: string; clients: number; maxClients: number; region: string }[] };
  revenue: { purchases24h: Record<string, { amount: string; count: number }>; purchases7d: Record<string, { amount: string; count: number }> };
  deposits7d: Record<string, { amount: string; count: number }>;
  withdrawals7d: Record<string, { amount: string; count: number }>;
  withdrawalsPending: number;
  suspicious: { count: number; top: { id: string; username: string; riskLevel: string; riskScore: number; bannedAt: string | null }[] };
  reports: { open: number };
  health: { dbLatencyMs: number; redisLatencyMs: number; rssMb: number; heapMb: number; uptimeSec: number };
}
export interface AdminUserRow { id: string; username: string; email: string | null; level: number; riskLevel: string; riskScore: number; bannedAt: string | null; mutedUntil: string | null; createdAt: string; lastLoginAt: string | null }
export type AdminWithdrawal = WithdrawalDto & { userId: string; username: string; userRiskLevel: string; userRiskScore: number; riskFlags: string[]; chainState: string; attempts: number; reviewedBy: string | null };
export interface RiskSignalRow { id: string; userId: string; type: string; score: number; source: string; details: unknown; reviewed: boolean; createdAt: string; user: { username: string; riskLevel: string } }
export interface ShopProductRow { id: string; sku: string; name: string; category: string; description: string; currency: string; price: string; grants: unknown; requiredLevel: number; stock: number | null; limitPerUser: number | null; featured: boolean; active: boolean }
export interface EventRow { id: string; name: string; type: string; startAt: string; endAt: string; active: boolean; data: Record<string, unknown> }
export interface AuditRow { id: string; actorId: string | null; actorType: string; action: string; targetType: string | null; targetId: string | null; oldValue: unknown; newValue: unknown; reason: string | null; ip: string | null; createdAt: string }

export const api = {
  me: () => http.get<MeResponse>("/api/me"),
  login: (email: string, password: string) => http.post<{ user: MeResponse }>("/api/auth/login", { email, password }, { noRefresh: true }),
  logout: () => http.post<{ ok: boolean }>("/api/auth/logout", {}, { noRefresh: true }),
  overview: () => http.get<OverviewResponse>("/api/admin/overview"),
  economy: () => http.get<AdminEconomyResponse>("/api/admin/economy"),
  economyStatus: () => http.get<EconomyStatusResponse>("/api/economy/status"),
  setConfig: (key: string, value: unknown, reason: string) => http.post<{ key: string; oldValue: unknown; newValue: unknown }>("/api/admin/economy/config", { key, value, reason }),
  setRewardRate: (rate: number, reason: string) => http.post<{ rate: number }>("/api/admin/economy/reward-rate", { rate, reason }),
  setBreaker: (mode: CircuitBreakerMode, active: boolean, reason: string) => http.post<{ activeBreakers: CircuitBreakerMode[] }>("/api/admin/economy/circuit-breaker", { mode, active, reason }),
  runController: () => http.post<Record<string, unknown>>("/api/admin/economy/controller/run", {}),
  withdrawals: (status?: string) => http.get<{ withdrawals: AdminWithdrawal[] }>("/api/admin/withdrawals", { status, limit: 200 }),
  reviewWithdrawal: (id: string, approve: boolean, reason: string) => http.post<unknown>(`/api/admin/withdrawals/${encodeURIComponent(id)}/${approve ? "approve" : "reject"}`, { reason }),
  rewardsReview: () => http.get<{ rewards: (RewardDto & { userId: string; username: string; riskLevel: string; riskScore: number })[] }>("/api/admin/economy/rewards/review"),
  reviewReward: (id: string, approve: boolean, reason: string) => http.post<unknown>(`/api/admin/economy/rewards/${encodeURIComponent(id)}/review`, { approve, reason }),
  treasury: () => http.get<Record<string, unknown>>("/api/admin/treasury"),
  users: (q: { q?: string; riskLevel?: string; banned?: boolean }) => http.get<{ users: AdminUserRow[] }>("/api/admin/users", { ...q, limit: 100 }),
  user: (id: string) => http.get<{ user: Record<string, unknown>; balances: Record<string, unknown> }>(`/api/admin/users/${encodeURIComponent(id)}`),
  ban: (id: string, reason: string, on: boolean) => http.post<unknown>(`/api/admin/users/${encodeURIComponent(id)}/${on ? "ban" : "unban"}`, { reason }),
  mute: (id: string, minutes: number, reason: string) => http.post<unknown>(`/api/admin/users/${encodeURIComponent(id)}/mute`, { minutes, reason }),
  unmute: (id: string, reason: string) => http.post<unknown>(`/api/admin/users/${encodeURIComponent(id)}/unmute`, { reason }),
  setRoles: (id: string, roles: AdminRole[], reason: string) => http.put<unknown>(`/api/admin/users/${encodeURIComponent(id)}/roles`, { roles, reason }),
  risk: () => http.get<{ signals: RiskSignalRow[]; users: AdminUserRow[] }>("/api/admin/risk"),
  reviewRisk: (id: string, decision: "CLEAR" | "CONFIRM", reason: string, riskLevel?: string) => http.post<unknown>(`/api/admin/risk/${encodeURIComponent(id)}/review`, { decision, reason, ...(riskLevel ? { riskLevel } : {}) }),
  reports: () => http.get<{ reports: { id: string; reason: string; reporterId: string; createdAt: string; message: { id: string; text: string; channel: string; sender: { username: string } } | null }[] }>("/api/admin/reports"),
  resolveReport: (id: string, status: "RESOLVED" | "DISMISSED", reason: string) => http.post<unknown>(`/api/admin/reports/${encodeURIComponent(id)}/resolve`, { status, reason }),
  products: () => http.get<{ products: ShopProductRow[] }>("/api/admin/shop/products"),
  patchProduct: (id: string, patch: Partial<ShopProductRow> & { reason: string }) => http.patch<unknown>(`/api/admin/shop/products/${encodeURIComponent(id)}`, patch),
  createProduct: (p: Omit<ShopProductRow, "stock" | "limitPerUser"> & { stock?: number | null; limitPerUser?: number | null; reason: string }) => http.post<unknown>("/api/admin/shop/products", p),
  events: () => http.get<{ events: EventRow[] }>("/api/admin/events"),
  upsertEvent: (e: EventRow & { reason: string }) => http.put<unknown>("/api/admin/events", e),
  disableEvent: (id: string, reason: string) => http.del<unknown>(`/api/admin/events/${encodeURIComponent(id)}`, { reason }),
  catalog: (kind: string, id: string, body: { data?: Record<string, unknown>; active?: boolean; reason: string }) => http.put<unknown>(`/api/admin/catalog/${kind}/${encodeURIComponent(id)}`, body),
  flags: () => http.get<{ flags: { key: string; enabled: boolean; rules: Record<string, unknown> }[] }>("/api/admin/feature-flags"),
  setFlag: (key: string, enabled: boolean, rules: Record<string, unknown>, reason: string) => http.put<unknown>(`/api/admin/feature-flags/${encodeURIComponent(key)}`, { enabled, rules, reason }),
  rules: () => http.get<{ rules: Record<string, unknown>; defaults: Record<string, unknown> }>("/api/admin/rules"),
  setRules: (rules: Record<string, unknown>, reason: string) => http.put<unknown>("/api/admin/rules", { rules, reason }),
  mail: (body: { toUserId: string; subject: string; body: string; attachments: { credits?: number; gems?: number } | null; reason: string }) => http.post<{ id: string }>("/api/admin/mail", body),
  audit: (q: { action?: string; actorId?: string; targetId?: string }) => http.get<{ entries: AuditRow[] }>("/api/admin/audit", { ...q, limit: 200 }),
  // Public read endpoints used for content pages without admin mutation routes.
  seasons: () => http.get<{ seasons: { id: string; name: string; number: number; startAt: string; endAt: string; active: boolean; battlePassId: string }[] }>("/api/seasons"),
  maps: () => http.get<{ maps: { id: string; name: string; sector: string; pvp: boolean; roomType: string; levelRange: [number, number] }[] }>("/api/maps"),
  auctions: () => http.get<{ auctions: { id: string; name: string; currency: string; startPrice: string; currentBid: string | null; buyoutPrice: string | null; endsAt: string; sellerId: string; type: string }[]; fees: Record<string, number> }>("/api/auctions"),
  market: () => http.get<{ listings: { id: string; name: string; seller: string | null; price: string; currency: string; fee: string; quantity: number; expiresAt: string }[]; feeRate: number }>("/api/market"),
  clans: () => http.get<{ ranking: { rank: number; id: string; name: string; tag: string; level: number; score: string; members: number; territories: number }[] }>("/api/clans/ranking"),
  leaderboard: (board: string) => http.get<LeaderboardResponse>("/api/leaderboard", { board }),
};

/** Mirrors @nebula/authentication ADMIN_PERMISSIONS (UI hint only; the API enforces). */
export const PERMS = {
  overview: ["ADMIN", "MODERATOR", "SUPPORT", "ECONOMY_MANAGER"],
  usersRead: ["ADMIN", "MODERATOR", "SUPPORT"],
  usersBan: ["ADMIN", "MODERATOR"],
  rolesManage: [],
  riskRead: ["ADMIN", "MODERATOR", "ECONOMY_MANAGER"],
  riskReview: ["ADMIN", "MODERATOR"],
  reports: ["ADMIN", "MODERATOR"],
  shopManage: ["ADMIN", "ECONOMY_MANAGER"],
  eventsRead: ["ADMIN", "ECONOMY_MANAGER", "MODERATOR"],
  eventsManage: ["ADMIN"],
  catalogManage: ["ADMIN"],
  featureFlags: ["ADMIN"],
  rulesManage: ["ADMIN", "ECONOMY_MANAGER"],
  mailGrant: ["ADMIN"],
  auditRead: ["ADMIN"],
  economyRead: ["ADMIN", "ECONOMY_MANAGER"],
  economyManage: ["ECONOMY_MANAGER"],
  withdrawalReview: ["ADMIN", "ECONOMY_MANAGER"],
} as const satisfies Record<string, readonly string[]>;
export type Perm = keyof typeof PERMS;
export function can(roles: readonly string[], p: Perm): boolean {
  if (roles.includes("SUPER_ADMIN")) return true;
  return (PERMS[p] as readonly string[]).some((r) => roles.includes(r));
}
