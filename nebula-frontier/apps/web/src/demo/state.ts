/**
 * Demo backend state: one browser-local "database" kept in memory and mirrored to localStorage.
 * Every storage access is wrapped in try/catch (private mode, blocked site data, node test runs);
 * without storage the demo still works for the lifetime of the page.
 */
import type { Currency, LoadoutDto, PremiumTier, ResourceId } from "@nebula/shared";
import type { MailDto, NotificationDto } from "../lib/dto.js";

export const STORAGE_KEY = "nf_demo_v1";
const STATE_VERSION = 1;

export interface LoadoutConfig {
  weapons: (string | null)[];
  missiles: (string | null)[];
  generators: (string | null)[];
  modules: (string | null)[];
  drones: (string | null)[];
  formation: string;
  ammo: string | null;
  cosmetics: Record<string, string>;
}

export interface DemoLoadout { id: string; name: string; preset: LoadoutDto["preset"]; config: LoadoutConfig; createdAt: string }
export interface DemoShip {
  id: string;
  defId: string;
  upgradeLevel: number;
  activeLoadoutId: string | null;
  loadouts: DemoLoadout[];
  cosmetics: Record<string, string>;
  createdAt: string;
}
export interface DemoItem {
  id: string;
  itemId: string;
  quantity: number;
  upgradeLevel: number;
  affixes: { stat: string; value: number }[];
  /** Listing/auction id holding the item in escrow. */
  lockedBy: string | null;
  bound: boolean;
  acquiredAt: string;
}
export interface DemoLedgerEntry {
  id: string;
  type: string;
  asset: Currency;
  amount: string;
  direction: "CREDIT" | "DEBIT";
  reference: string;
  createdAt: string;
  metadata: Record<string, unknown>;
}
export interface DemoQuestRow { id: string; questId: string; periodKey: string; status: "ACTIVE" | "COMPLETED" | "CLAIMED"; progress: number[]; claimedAt: string | null }
export interface DemoCraftJob { id: string; blueprintId: string; status: string; startedAt: string; completesAt: string; claimedAt: string | null; idempotencyKey: string }
export interface DemoPurchase { id: string; productId: string; quantity: number; idempotencyKey: string; createdAt: string }
export interface DemoUpgradeAttempt {
  kind: "ITEM" | "SHIP";
  idempotencyKey: string;
  targetId: string;
  success: boolean;
  fromLevel: number;
  toLevel: number;
  cost: UpgradeCostWire;
}
/** Upgrade cost as it appears on the wire (bigint money as decimal strings). */
export interface UpgradeCostWire { fromLevel: number; toLevel: number; credits: string; gems: string; resources: Record<string, number>; successChance: number }
export interface DemoBattlePass { seasonId: string; passId: string; xp: number; tier: number; premium: boolean; claimedFree: number[]; claimedPremium: number[] }
export interface DemoStats {
  npcKills: number;
  playerKills: number;
  bossKills: number;
  gatesCompleted: number;
  resourcesMined: number;
  mapsVisited: string[];
  itemsCrafted: number;
  pvpWins: number;
  marketSales: number;
}

export interface DemoAccount {
  id: string;
  username: string;
  email: string;
  createdAt: string;
  xp: number;
  level: number;
  honor: number;
  seasonScore: number;
  prestige: number;
  faction: string | null;
  activeShipId: string | null;
  lastMapId: string | null;
  /** Demo tester kit granted (every ship/item, large balances, max level) — also lifts the inventory cap. */
  testerKit?: boolean;
  /** Tester-kit ships have been fitted with gear (ships granted with empty loadouts could not fire). */
  testerFitted?: boolean;
  premiumTier: PremiumTier;
  premiumUntil: string | null;
  /** Integer base units as decimal strings (same representation as the ledger). */
  credits: string;
  gems: string;
  resources: Partial<Record<ResourceId, number>>;
  ships: DemoShip[];
  inventory: DemoItem[];
  ledger: DemoLedgerEntry[];
  quests: DemoQuestRow[];
  craftJobs: DemoCraftJob[];
  purchases: DemoPurchase[];
  upgradeAttempts: DemoUpgradeAttempt[];
  achievements: { id: string; unlockedAt: string; claimed: boolean }[];
  battlePasses: DemoBattlePass[];
  mail: (Omit<MailDto, "hasAttachments">)[];
  notifications: NotificationDto[];
  stats: DemoStats;
  clan: { id: string; role: "LEADER" | "OFFICER" | "VETERAN" | "MEMBER" | "RECRUIT"; joinedAt: string } | null;
}

export interface DemoMarketListing {
  id: string;
  sellerId: string;
  seller: string;
  /** Escrowed inventory row for the pilot's own listings; null for synthetic sellers. */
  inventoryItemId: string | null;
  itemId: string;
  quantity: number;
  upgradeLevel: number;
  affixes: { stat: string; value: number }[];
  price: string;
  currency: Currency;
  fee: string;
  status: "ACTIVE" | "SOLD" | "CANCELLED";
  expiresAt: string;
  createdAt: string;
}

export interface DemoAuction {
  id: string;
  sellerId: string;
  inventoryItemId: string | null;
  itemId: string;
  quantity: number;
  type: "HOURLY" | "DAILY" | "WEEKLY";
  currency: "CREDITS" | "GEMS";
  startPrice: string;
  buyoutPrice: string | null;
  currentBid: string | null;
  currentBidderId: string | null;
  listingFee: string;
  status: "ACTIVE" | "SOLD" | "CANCELLED";
  endsAt: string;
  createdAt: string;
}

export interface DemoClan {
  id: string;
  name: string;
  tag: string;
  description: string;
  level: number;
  score: string;
  factionId: string | null;
  announcement: string | null;
  treasury: string;
  /** Synthetic (NPC) members; the demo pilot is added from DemoAccount.clan. */
  members: { userId: string; username: string; level: number; role: string; contribution: string; joinedAt: string }[];
  territories: string[];
  createdAt: string;
}

export interface DemoState {
  version: number;
  seq: number;
  sessionUserId: string | null;
  sessionCreatedAt: string | null;
  accounts: Record<string, DemoAccount>;
  market: DemoMarketListing[];
  auctions: DemoAuction[];
  clans: DemoClan[];
}

function emptyState(): DemoState {
  return { version: STATE_VERSION, seq: 0, sessionUserId: null, sessionCreatedAt: null, accounts: {}, market: [], auctions: [], clans: [] };
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function readStored(): DemoState | null {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DemoState> | null;
    if (!parsed || typeof parsed !== "object" || parsed.version !== STATE_VERSION || typeof parsed.accounts !== "object" || !parsed.accounts) return null;
    return { ...emptyState(), ...parsed } as DemoState;
  } catch {
    return null;
  }
}

let current: DemoState | null = null;

/** The live state (loaded lazily from storage). */
export function state(): DemoState {
  current ??= readStored() ?? emptyState();
  return current;
}

/** Persist the live state; failures (quota, private mode) are ignored — the in-memory copy stays authoritative. */
export function save(): void {
  if (!current) return;
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    /* storage unavailable or full */
  }
}

/** Replace the live state (used to roll back a failed request, like a DB transaction). */
export function replaceState(next: DemoState): void {
  current = next;
}

/** Forget everything (tests, "reset demo"). */
export function resetDemoState(): void {
  current = emptyState();
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** Unique id that satisfies the API id schema (`[A-Za-z0-9_:-]`). */
export function newId(prefix: string): string {
  const s = state();
  s.seq += 1;
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return `${prefix}_${s.seq.toString(36)}${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export const nowIso = (): string => new Date().toISOString();
