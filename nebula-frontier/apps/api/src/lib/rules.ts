/**
 * API gameplay/market rules that are not part of packages/config JSON. Defaults live here, but
 * the authoritative values can be overridden at runtime by the `apiRules` EconomyConfig row
 * (admin: PUT /api/admin/rules, audited). Nothing below is a hidden price: every value is exposed
 * via GET /api/rules so clients can show it.
 */
import type { DbOrTx } from "@nebula/database";
import { asRecord } from "./json.js";

export const API_RULE_DEFAULTS = {
  /** Credits charged to found a clan (sink). */
  clanCreateCost: 250_000,
  clanMaxMembers: 50,
  clanStationBuildCost: 1_000_000,
  clanStationHull: 500_000,
  clanStationShield: 250_000,
  /** Clan station module upgrade cost = base * growth^(level-1), paid from the clan treasury. */
  clanModuleBaseCost: 150_000,
  clanModuleGrowth: 1.6,
  clanModuleMaxLevel: 10,
  clanWarPreparationMinutes: 60,
  clanWarDurationMinutes: 60,
  clanInviteTtlHours: 72,
  squadMinSize: 4,
  squadMaxSize: 8,
  squadInviteTtlMinutes: 30,
  maxActiveQuests: 12,
  craftingMaxConcurrent: 3,
  /** Minimum next bid = current + max(1, ceil(current * pct)). */
  auctionMinIncrementPct: 0.05,
  /** Bids in the final window extend the auction to now + window (anti-sniping). */
  auctionAntiSnipeSeconds: 120,
  auctionDurationsHours: { HOURLY: 1, DAILY: 24, WEEKLY: 168 },
  bountyMin: 10_000,
  bountyDurationHours: 72,
  friendsMax: 200,
  usernameChangeCooldownHours: 24 * 7,
  marketMaxActiveListings: 50,
  inventoryHardCap: 500,
};

export type ApiRules = typeof API_RULE_DEFAULTS;

let cache: { at: number; rules: ApiRules } | null = null;

export async function loadRules(db: DbOrTx): Promise<ApiRules> {
  if (cache && Date.now() - cache.at < 15_000) return cache.rules;
  const row = await db.economyConfig.findUnique({ where: { key: "apiRules" } });
  const overrides = asRecord(row?.value);
  const rules = { ...API_RULE_DEFAULTS } as Record<string, unknown>;
  for (const [k, v] of Object.entries(overrides)) {
    const def = (API_RULE_DEFAULTS as Record<string, unknown>)[k];
    if (def !== undefined && typeof def === typeof v) rules[k] = v;
  }
  cache = { at: Date.now(), rules: rules as ApiRules };
  return cache.rules;
}

export function invalidateRules(): void {
  cache = null;
}
