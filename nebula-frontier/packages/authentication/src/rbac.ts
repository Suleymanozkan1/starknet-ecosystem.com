/**
 * Role-based access control helpers shared by apps/api and apps/admin.
 */
import { AdminRole, ClanRole } from "@nebula/shared";

const { SUPER_ADMIN, ADMIN, MODERATOR, SUPPORT, ECONOMY_MANAGER } = AdminRole;

/**
 * RBAC matrix: capability -> roles allowed (SUPER_ADMIN is implicitly allowed everything).
 * Used by apps/api admin routes and documented in docs/SECURITY.md.
 */
export const ADMIN_PERMISSIONS = {
  overview: [ADMIN, MODERATOR, SUPPORT, ECONOMY_MANAGER],
  usersRead: [ADMIN, MODERATOR, SUPPORT],
  usersBan: [ADMIN, MODERATOR],
  usersMute: [ADMIN, MODERATOR],
  rolesManage: [SUPER_ADMIN],
  riskRead: [ADMIN, MODERATOR, ECONOMY_MANAGER],
  riskReview: [ADMIN, MODERATOR],
  reports: [ADMIN, MODERATOR],
  shopManage: [ADMIN, ECONOMY_MANAGER],
  eventsRead: [ADMIN, ECONOMY_MANAGER, MODERATOR],
  eventsManage: [ADMIN],
  catalogManage: [ADMIN],
  featureFlags: [ADMIN],
  rulesManage: [ADMIN, ECONOMY_MANAGER],
  mailGrant: [ADMIN],
  auditRead: [ADMIN],
  economyRead: [ADMIN, ECONOMY_MANAGER],
  economyManage: [ECONOMY_MANAGER],
  withdrawalReview: [ADMIN, ECONOMY_MANAGER],
} as const satisfies Record<string, readonly AdminRole[]>;
export type AdminPermission = keyof typeof ADMIN_PERMISSIONS;

export function can(userRoles: readonly string[], permission: AdminPermission): boolean {
  return hasAnyRole(userRoles, ADMIN_PERMISSIONS[permission]);
}

/** SUPER_ADMIN implicitly holds every admin role. */
export function hasAnyRole(userRoles: readonly string[], required: readonly AdminRole[]): boolean {
  if (userRoles.includes(AdminRole.SUPER_ADMIN)) return true;
  return required.some((r) => userRoles.includes(r));
}

/** Clan rank order: higher number = more authority. */
export const CLAN_ROLE_RANK: Record<ClanRole, number> = {
  RECRUIT: 0,
  MEMBER: 1,
  VETERAN: 2,
  OFFICER: 3,
  LEADER: 4,
};

export function clanRoleAtLeast(role: string, min: ClanRole): boolean {
  const r = CLAN_ROLE_RANK[role as ClanRole];
  return r !== undefined && r >= CLAN_ROLE_RANK[min];
}

/**
 * Can `actor` change `target` from its current role to `next`?
 * - LEADER may set any non-leader role, and may transfer leadership (next = LEADER).
 * - OFFICER may move members strictly below OFFICER between RECRUIT..VETERAN.
 */
export function canSetClanRole(actor: string, target: string, next: string): boolean {
  const a = CLAN_ROLE_RANK[actor as ClanRole];
  const t = CLAN_ROLE_RANK[target as ClanRole];
  const n = CLAN_ROLE_RANK[next as ClanRole];
  if (a === undefined || t === undefined || n === undefined) return false;
  if (t >= a) return false;
  if (actor === ClanRole.LEADER) return true;
  if (actor === ClanRole.OFFICER) return n < CLAN_ROLE_RANK.OFFICER;
  return false;
}

/** Can `actor` remove `target` from the clan? Only strictly lower ranks, officer or above. */
export function canKickClanMember(actor: string, target: string): boolean {
  const a = CLAN_ROLE_RANK[actor as ClanRole];
  const t = CLAN_ROLE_RANK[target as ClanRole];
  if (a === undefined || t === undefined) return false;
  return a >= CLAN_ROLE_RANK.OFFICER && t < a;
}
