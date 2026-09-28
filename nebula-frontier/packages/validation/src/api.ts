/**
 * zod schemas for every REST request body / query in packages/shared/src/api.ts plus the
 * additional api routes. Unknown keys are stripped (never trusted), e.g. a client-sent `price`.
 */
import { z } from "zod";
import {
  amountSchema, base58SignatureSchema, breakerModeSchema, chatChannelSchema, clanRoleSchema, adminRoleSchema,
  currencySchema, defIdSchema, deviceIdSchema, emailSchema, idSchema, idempotencyKeySchema, itemCategorySchema,
  passwordSchema, raritySchema, safeTextSchema, solanaAddressSchema, tradeCurrencySchema, usernameSchema,
} from "./common.js";

// ---------------- Auth ----------------
export const nonceRequestSchema = z.object({
  address: solanaAddressSchema,
  purpose: z.enum(["LOGIN", "LINK_WALLET"]).default("LOGIN"),
});
export const verifyRequestSchema = z.object({
  address: solanaAddressSchema,
  nonce: z.string().min(16).max(128).regex(/^[A-Za-z0-9]+$/),
  signature: base58SignatureSchema,
  deviceId: deviceIdSchema.optional(),
});
export const registerRequestSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  username: usernameSchema,
  deviceId: deviceIdSchema.optional(),
});
export const loginRequestSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
  deviceId: deviceIdSchema.optional(),
});

// ---------------- User ----------------
export const updateMeSchema = z.object({ username: usernameSchema });
export const chooseFactionSchema = z.object({ factionId: defIdSchema });
export const gameTicketSchema = z.object({ mapId: defIdSchema.optional() }).default({});

// ---------------- Ships / Inventory ----------------
export const slotTypeSchema = z.enum(["weapons", "missiles", "generators", "modules", "drones"]);
export const equipRequestSchema = z.object({
  shipInstanceId: idSchema,
  loadoutId: idSchema,
  inventoryItemId: idSchema,
  slotType: slotTypeSchema,
  slotIndex: z.number().int().min(0).max(15),
});
export const unequipRequestSchema = z.object({
  shipInstanceId: idSchema,
  loadoutId: idSchema,
  slotType: slotTypeSchema,
  slotIndex: z.number().int().min(0).max(15),
});
export const inventoryQuerySchema = z.object({
  category: itemCategorySchema.optional(),
  rarity: raritySchema.optional(),
  sort: z.enum(["rarity", "level", "power", "recent", "value"]).default("recent"),
  search: safeTextSchema(40).optional(),
});
export const upgradeItemSchema = z.object({ inventoryItemId: idSchema, idempotencyKey: idempotencyKeySchema });
export const shipUnlockSchema = z.object({ shipId: defIdSchema, idempotencyKey: idempotencyKeySchema });
export const shipActivateSchema = z.object({ shipInstanceId: idSchema });
export const shipUpgradeSchema = z.object({ shipInstanceId: idSchema, idempotencyKey: idempotencyKeySchema });
export const loadoutPresetSchema = z.enum(["PVP", "PVE", "TANK", "SPEED", "MINING", "BOSS", "RAID", "CUSTOM"]);
export const createLoadoutSchema = z.object({
  name: safeTextSchema(24, 1),
  preset: loadoutPresetSchema.default("CUSTOM"),
  copyFromLoadoutId: idSchema.optional(),
});
export const updateLoadoutSchema = z.object({
  name: safeTextSchema(24, 1).optional(),
  preset: loadoutPresetSchema.optional(),
  formation: z.enum(["STANDARD", "ARROW", "TURTLE", "DIAMOND", "WHEEL"]).optional(),
  ammo: defIdSchema.nullable().optional(),
});
export const equipCosmeticSchema = z.object({
  shipInstanceId: idSchema,
  inventoryItemId: idSchema.nullable(),
  slot: z.enum([
    "HULL_SKIN", "ENGINE_EFFECT", "ENGINE_COLOR", "WEAPON_SKIN", "SHIELD_COLOR", "SHIELD_EFFECT", "TRAIL",
    "DRONE_SKIN", "EXPLOSION", "NAMEPLATE", "BADGE", "EMBLEM", "TITLE",
  ]),
});

// ---------------- Shop ----------------
export const purchaseRequestSchema = z.object({
  productId: defIdSchema,
  quantity: z.number().int().min(1).max(100).default(1),
  idempotencyKey: idempotencyKeySchema,
});

// ---------------- Wallet / Chain (economy engineer routes) ----------------
export const depositPrepareSchema = z.object({
  amount: amountSchema,
  purpose: z.enum(["GEMS", "BALANCE"]),
  idempotencyKey: idempotencyKeySchema,
  productId: defIdSchema.optional(),
});
export const depositVerifySchema = z.object({ depositId: idSchema, signature: base58SignatureSchema });
export const withdrawRequestSchema = z.object({
  amount: amountSchema,
  address: solanaAddressSchema,
  idempotencyKey: idempotencyKeySchema,
});
export const withdrawQuoteSchema = z.object({ amount: amountSchema });
export const linkWalletSchema = verifyRequestSchema.omit({ deviceId: true });

// ---------------- Economy admin (economy engineer routes) ----------------
export const economyConfigUpdateSchema = z.object({ key: z.string().min(1).max(80), value: z.unknown(), reason: safeTextSchema(500, 3) });
export const circuitBreakerSchema = z.object({ mode: breakerModeSchema, active: z.boolean(), reason: safeTextSchema(500, 3) });
export const rewardRateSchema = z.object({ rate: z.number().min(0).max(1), reason: safeTextSchema(500, 3) });

// ---------------- Crafting ----------------
export const craftStartSchema = z.object({ blueprintId: defIdSchema, idempotencyKey: idempotencyKeySchema });

// ---------------- Quests ----------------
export const questAcceptSchema = z.object({ questId: defIdSchema });
export const questClaimSchema = z.object({ userQuestId: idSchema });

// ---------------- Leaderboard ----------------
export const leaderboardQuerySchema = z.object({
  board: z.enum(["pvp_kills", "npc_kills", "honor", "season_score", "faction", "clan"]).default("honor"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// ---------------- Marketplace ----------------
export const marketQuerySchema = z.object({
  itemId: defIdSchema.optional(),
  category: itemCategorySchema.optional(),
  rarity: raritySchema.optional(),
  currency: tradeCurrencySchema.optional(),
  sort: z.enum(["price_asc", "price_desc", "recent"]).default("recent"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const marketListSchema = z.object({
  inventoryItemId: idSchema,
  quantity: z.number().int().min(1).max(100000).default(1),
  price: amountSchema,
  currency: tradeCurrencySchema.default("CREDITS"),
  durationHours: z.number().int().min(1).max(168).default(48),
});

// ---------------- Auctions ----------------
export const auctionCreateSchema = z.object({
  inventoryItemId: idSchema,
  quantity: z.number().int().min(1).max(100000).default(1),
  type: z.enum(["HOURLY", "DAILY", "WEEKLY"]).default("DAILY"),
  currency: z.enum(["CREDITS", "GEMS"]).default("CREDITS"),
  startPrice: amountSchema,
  buyoutPrice: amountSchema.optional(),
});
export const auctionBidSchema = z.object({ amount: amountSchema });

// ---------------- Clans ----------------
export const clanCreateSchema = z.object({
  name: safeTextSchema(24, 3).refine((s) => /^[A-Za-z0-9 _-]+$/.test(s), "invalid clan name"),
  tag: z.string().min(2).max(5).regex(/^[A-Z0-9]+$/, "tag must be 2-5 uppercase letters/digits"),
  description: safeTextSchema(500).default(""),
});
export const clanInviteSchema = z.object({ userId: idSchema });
export const clanMemberSchema = z.object({ userId: idSchema });
export const clanPromoteSchema = z.object({ userId: idSchema, role: clanRoleSchema });
export const clanTreasurySchema = z.object({ amount: amountSchema, idempotencyKey: idempotencyKeySchema });
export const clanAnnouncementSchema = z.object({ announcement: safeTextSchema(1000) });
export const clanDiplomacySchema = z.object({ targetClanId: idSchema, stance: z.enum(["ALLY", "NAP", "NEUTRAL", "HOSTILE"]) });
export const clanWarDeclareSchema = z.object({ targetClanId: idSchema, mapId: defIdSchema.optional() });
export const clanStationBuildSchema = z.object({ mapId: defIdSchema });
export const clanModuleKindSchema = z.enum(["SHIELD_GRID", "TURRET_ARRAY", "REPAIR_BAY", "RADAR", "HANGAR", "REFINERY"]);

// ---------------- Squad / Friends / Chat ----------------
export const squadInviteSchema = z.object({ userId: idSchema });
export const friendAddSchema = z.object({ userId: idSchema.optional(), username: usernameSchema.optional() }).refine(
  (v) => Boolean(v.userId ?? v.username),
  "userId or username required",
);
export const friendTargetSchema = z.object({ userId: idSchema });
export const chatHistoryQuerySchema = z.object({
  channel: chatChannelSchema,
  key: z.string().max(128).optional(),
  before: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const chatReportSchema = z.object({ messageId: idSchema, reason: safeTextSchema(300, 3) });

// ---------------- Notifications / Mail / Bounty ----------------
export const notificationReadSchema = z.object({ ids: z.array(idSchema).max(200).optional(), all: z.boolean().optional() });
export const pushTokenSchema = z.object({
  token: z.string().min(16).max(4096),
  platform: z.enum(["ios", "android", "web"]),
  deviceId: deviceIdSchema,
});
export const bountyCreateSchema = z.object({
  targetUserId: idSchema,
  amount: amountSchema,
  idempotencyKey: idempotencyKeySchema,
});

// ---------------- Battle pass / achievements ----------------
export const battlePassClaimSchema = z.object({ tier: z.number().int().min(1).max(500), track: z.enum(["free", "premium"]) });

// ---------------- Admin ----------------
export const adminUserSearchSchema = z.object({
  q: safeTextSchema(64).optional(),
  riskLevel: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
  banned: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const adminBanSchema = z.object({ reason: safeTextSchema(500, 3) });
export const adminMuteSchema = z.object({ reason: safeTextSchema(500, 3), minutes: z.number().int().min(1).max(60 * 24 * 30) });
export const adminRolesSchema = z.object({ roles: z.array(adminRoleSchema).max(5), reason: safeTextSchema(500, 3) });
export const adminRiskReviewSchema = z.object({
  decision: z.enum(["CLEAR", "CONFIRM"]),
  riskLevel: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
  reason: safeTextSchema(500, 3),
});
export const adminShopProductSchema = z.object({
  id: defIdSchema,
  sku: z.string().min(3).max(64).regex(/^sku_[a-z0-9_]+$/),
  name: safeTextSchema(80, 1),
  category: z.string().min(1).max(32),
  description: safeTextSchema(1000),
  currency: currencySchema,
  price: amountSchema,
  grants: z.record(z.string(), z.unknown()),
  requiredLevel: z.number().int().min(1).max(1000).default(1),
  stock: z.number().int().min(0).nullable().default(null),
  limitPerUser: z.number().int().min(1).nullable().default(null),
  featured: z.boolean().default(false),
  active: z.boolean().default(true),
  reason: safeTextSchema(500, 3),
});
export const adminShopProductPatchSchema = adminShopProductSchema.partial().extend({ reason: safeTextSchema(500, 3) });
export const adminEventSchema = z.object({
  id: defIdSchema,
  name: safeTextSchema(80, 1),
  type: z.string().min(1).max(32),
  startAt: z.coerce.date(),
  endAt: z.coerce.date(),
  active: z.boolean().default(true),
  data: z.record(z.string(), z.unknown()).default({}),
  reason: safeTextSchema(500, 3),
}).refine((e) => e.startAt < e.endAt, "startAt must be before endAt");
export const adminCatalogSchema = z.object({
  data: z.record(z.string(), z.unknown()).optional(),
  active: z.boolean().optional(),
  reason: safeTextSchema(500, 3),
});
export const adminFeatureFlagSchema = z.object({
  enabled: z.boolean(),
  rules: z.object({
    allowCountries: z.array(z.string().length(2)).optional(),
    denyCountries: z.array(z.string().length(2)).optional(),
    allowRegions: z.array(z.string().max(8)).optional(),
    denyRegions: z.array(z.string().max(8)).optional(),
    minAge: z.number().int().min(0).max(100).optional(),
    requireKyc: z.enum(["NONE", "BASIC", "FULL"]).optional(),
    denyRestrictions: z.array(z.string().max(64)).optional(),
    maxRiskLevel: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
  }).default({}),
  reason: safeTextSchema(500, 3),
});
export const adminAuditQuerySchema = z.object({
  action: z.string().max(80).optional(),
  actorId: idSchema.optional(),
  targetId: idSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  before: z.coerce.date().optional(),
});
export const adminReportResolveSchema = z.object({ status: z.enum(["RESOLVED", "DISMISSED"]), reason: safeTextSchema(500, 3) });

export type NonceRequestInput = z.infer<typeof nonceRequestSchema>;
export type VerifyRequestInput = z.infer<typeof verifyRequestSchema>;
export type PurchaseRequestInput = z.infer<typeof purchaseRequestSchema>;
export type EquipRequestInput = z.infer<typeof equipRequestSchema>;
export type MarketListInput = z.infer<typeof marketListSchema>;
export type AuctionCreateInput = z.infer<typeof auctionCreateSchema>;
export type FeatureFlagRules = z.infer<typeof adminFeatureFlagSchema>["rules"];

// ---------------- Internal (game server -> API) ----------------
const gid = z.string().min(1).max(80).regex(/^[A-Za-z0-9_:-]+$/);
const qty = z.number().int().min(0).max(1_000_000);
/** Mirrors `GameplayEvent` in @nebula/game-core quests.ts. */
export const gameplayEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("KILL"), npcId: gid, boss: z.boolean(), mapId: gid }),
  z.object({ type: z.literal("KILL_PLAYER"), victimId: gid, mapId: gid }),
  z.object({ type: z.literal("COLLECT"), itemId: gid, quantity: qty, mapId: gid }),
  z.object({ type: z.literal("MINE"), resourceId: gid, quantity: qty, mapId: gid }),
  z.object({ type: z.literal("TRAVEL"), mapId: gid }),
  z.object({ type: z.literal("DAMAGE_BOSS"), bossId: gid, amount: qty, mapId: gid }),
  z.object({ type: z.literal("COMPLETE_GATE"), gateId: gid, mapId: gid }),
  z.object({ type: z.literal("WIN_PVP"), mapId: gid }),
  z.object({ type: z.literal("LEVEL"), level: z.number().int().min(1).max(1000) }),
  z.object({ type: z.literal("CRAFT"), blueprintId: gid, quantity: qty }),
  z.object({ type: z.literal("SURVIVE"), seconds: qty, mapId: gid }),
  z.object({ type: z.literal("DELIVER"), resourceId: gid, quantity: qty, mapId: gid }),
  z.object({ type: z.literal("ESCORT"), mapId: gid }),
]);
export const clanMissionProgressSchema = z.object({
  events: z.array(z.object({ userId: idSchema, event: gameplayEventSchema })).min(1).max(500),
});
export const adminAnalyticsQuerySchema = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });
