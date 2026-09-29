/**
 * Money in the JSON documents (economy.json, shop.json) is integer currency base units written as
 * decimal integer strings (`"10000000000"`): JSON numbers lose precision above 2^53. These zod
 * schemas parse the documents into exact `bigint` amounts.
 */
import { z } from "zod";
import { Currency, RiskLevel, type EconomyConfigDef, type EconomyConfigDoc, type ShopProductDef, type ShopProductDoc } from "@nebula/shared";

const DECIMAL_INTEGER = /^\d+$/;

/** A non-negative decimal integer string (`"0"`, `"10000000000"`) → exact bigint base units. */
export const baseUnitsStringSchema = z
  .string()
  .regex(DECIMAL_INTEGER, "must be a decimal integer string of base units")
  .transform((s) => BigInt(s));

/**
 * Lenient base-unit parser for stored overrides (EconomyConfig DB rows, admin input): accepts a bigint,
 * a decimal integer string, or — for rows written before amounts became strings — a non-negative
 * safe-integer JSON number. Fractional, negative, unsafe or non-numeric values are rejected.
 */
export const baseUnitsInputSchema = z.union([
  z.bigint().nonnegative(),
  baseUnitsStringSchema,
  z.number().int().nonnegative().refine(Number.isSafeInteger, "must be a safe integer").transform((n) => BigInt(n)),
]);

/** Parses a base-unit amount (see baseUnitsInputSchema); null when invalid. */
export function parseBaseUnits(v: unknown): bigint | null {
  const r = baseUnitsInputSchema.safeParse(v);
  return r.success ? r.data : null;
}

const num = z.number().finite();
const money = baseUnitsStringSchema;
const riskLevel = z.enum(RiskLevel);
const record = <K extends string>(keys: readonly [K, ...K[]]) => z.record(z.enum(keys), num);

/** economy.json → EconomyConfigDef. Every leaf is required; unknown keys are rejected. */
export const economyConfigDocSchema: z.ZodType<EconomyConfigDef, EconomyConfigDoc> = z.strictObject({
  currencies: z.record(z.enum(Currency), z.strictObject({ decimals: z.number().int().nonnegative(), symbol: z.string().min(1), onChain: z.boolean() })),
  rewardBudgetRatio: num,
  treasuryReserveRatio: num,
  operatingReserveRatio: num,
  emergencyReserveRatio: num,
  minTreasuryReserve: money,
  rewardAllocation: record(["LEADERBOARD", "TOURNAMENT", "WORLD_EVENTS", "FACTION_WARS", "RAIDS", "ACHIEVEMENTS", "SPECIAL_CAMPAIGNS"]),
  emission: z.strictObject({ baseRate: num, maxRewardRate: num, activityMultiplierMax: num, seasonMultiplier: num, rewardUnitLamports: money }),
  treasuryHealth: z.strictObject({ healthy: num, watch: num, warning: num, multipliers: record(["HEALTHY", "WATCH", "WARNING", "CRITICAL"]) }),
  caps: z.strictObject({ daily: money, weekly: money, season: money }),
  eligibility: z.strictObject({
    minAccountAgeHours: num, minGameplayMinutes: num, minCompletedMatches: num, claimCooldownMinutes: num,
    maxRiskLevel: riskLevel, eligibleModes: z.array(z.string()),
  }),
  fees: z.strictObject({
    marketplace: num, auctionListing: num, auctionSale: num, auctionCancellation: num, withdrawalServicePercent: num,
    withdrawalFlat: money, estimatedNetworkFee: money, tradeTax: num,
  }),
  withdrawal: z.strictObject({
    min: money, max: money, dailyLimit: money, cooldownMinutes: num, minAccountAgeHours: num, walletChangeLockHours: num, reviewThreshold: money,
  }),
  inflation: z.strictObject({ dailyThreshold: num, weeklyThreshold: num, responses: z.strictObject({ rewardMultiplier: num, dropMultiplier: num, sinkMultiplier: num }) }),
  circuitBreaker: z.strictObject({
    reserveCoverageMin: num, liabilityRatioMax: num, withdrawalSpikeMultiplier: num, depositSpikeMultiplier: num,
    depositSpikeFloorLamports: money, botRiskShareMax: num, inflationSpike: num, abnormalOutflowMultiplier: num,
  }),
  rewardExpiryDays: num,
  tokenomics: z.strictObject({
    symbol: z.string().min(1),
    maxSupply: money,
    allocation: record(["TREASURY", "REWARDS", "LIQUIDITY", "OPERATIONS", "MARKETING", "TEAM", "ECOSYSTEM"]),
    mintAuthorityDisabledAfterGenesis: z.boolean(),
  }),
  sinks: z.strictObject({ ammoCreditsPerShot: money, travelCreditsPerJump: money, npcServiceFee: money }),
  premium: z.record(z.enum(["FREE", "VIP", "ELITE"]), z.strictObject({ xpBoost: num, inventorySlots: z.number().int().nonnegative(), extraDailyQuests: z.number().int().nonnegative() })),
  risk: z.strictObject({
    mediumScore: num, highScore: num, criticalScore: num, windowDays: num, repeatedRewardsPerDay: num,
    regularIntervalCvMax: num, clusterSizeWarn: num, duplicateClaimSignalsMax: num, autoReviewWithdrawalRisk: riskLevel,
  }),
});

function formatIssues(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`).join("; ");
}

/** Parses an economy.json document; throws with every offending path on invalid input. */
export function parseEconomyConfigDoc(raw: unknown): EconomyConfigDef {
  const r = economyConfigDocSchema.safeParse(raw);
  if (!r.success) throw new Error(`Invalid economy.json: ${formatIssues(r.error)}`);
  return r.data;
}

const shopEntrySchema = z.looseObject({ sku: z.string().min(1), price: baseUnitsStringSchema });

/**
 * Parses shop.json: every price must be a decimal integer string of base units (the error names the
 * SKU). Other product fields keep their documented shape and are cross-checked by validateGameData().
 */
export function parseShopDoc(raw: unknown): ShopProductDef[] {
  const list = z.array(z.unknown()).parse(raw);
  return list.map((entry, i) => {
    const r = shopEntrySchema.safeParse(entry);
    if (!r.success) {
      const sku = typeof entry === "object" && entry !== null && "sku" in entry ? String(entry.sku) : `#${i}`;
      throw new Error(`Invalid shop.json product ${sku}: ${formatIssues(r.error)}`);
    }
    return { ...(entry as ShopProductDoc), price: r.data.price };
  });
}
