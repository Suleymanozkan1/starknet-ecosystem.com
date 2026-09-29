/**
 * Player-facing economy routes. Terminology: Battle Rewards / Season Rewards / Tournament Rewards /
 * Marketplace Earnings — never APY, interest, yield, guaranteed returns or investment.
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { idSchema } from "@nebula/validation";
import type { Currency, EconomyStatusResponse, FeesResponse, LedgerEntryDto, RewardDto, RewardsResponse } from "@nebula/shared";
import {
  capLimits,
  claimCooldownUntil,
  emissionFromConfig,
  getActiveBreakers,
  getCapUsage,
  getRewardBudgetState,
  getRewardEligibility,
  getTreasuryState,
  loadEconomyConfig,
  type EconomyConfig
} from "@nebula/economy";
import type { DbOrTx } from "@nebula/database";
import { getRewardMint } from "@nebula/blockchain";

/** Reward mint decimals from the blockchain config (REWARD_MINT / REWARD_MINT_DECIMALS). */
function rewardMintDecimals(): number {
  try {
    return getRewardMint().decimals;
  } catch {
    // Misconfigured REWARD_MINT address: use the library's mint-less default rather than failing a public rules page.
    return getRewardMint({}).decimals;
  }
}

/** Format an amount in the reward token's base units with the mint's decimals (4 fraction digits). */
export function formatRewardAmount(n: number | bigint, decimals: number, symbol: string): string {
  const v = Number(n) / 10 ** decimals;
  return `${v.toFixed(4)} ${symbol}`;
}

export function feesDto(cfg: EconomyConfig): FeesResponse {
  return {
    marketplaceFee: cfg.fees.marketplace,
    auctionListingFee: cfg.fees.auctionListing,
    auctionSaleFee: cfg.fees.auctionSale,
    auctionCancellationFee: cfg.fees.auctionCancellation,
    withdrawalServiceFeePercent: cfg.fees.withdrawalServicePercent,
    withdrawalFlatFee: String(cfg.fees.withdrawalFlat),
    estimatedNetworkFee: String(cfg.fees.estimatedNetworkFee),
    tradeTax: cfg.fees.tradeTax
  };
}

export function rewardDto(r: { id: string; source: string; amount: bigint; status: string; reason: string; expiresAt: Date | null; createdAt: Date }): RewardDto {
  return {
    id: r.id,
    source: r.source as RewardDto["source"],
    amount: r.amount.toString(),
    status: r.status as RewardDto["status"],
    reason: r.reason,
    expiresAt: r.expiresAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString()
  };
}

/** Player-facing rules text, generated from live config so it can never drift from enforcement. */
export function rewardRules(cfg: EconomyConfig, decimals: number = rewardMintDecimals()): string[] {
  const sol = (n: number | bigint) => formatRewardAmount(n, decimals, cfg.tokenomics.symbol);
  const e = cfg.eligibility;
  return [
    "Battle Rewards, Season Rewards and Tournament Rewards are earned through skilled gameplay in eligible modes: " + e.eligibleModes.join(", ") + ".",
    `Eligibility: account at least ${e.minAccountAgeHours}h old, ${e.minGameplayMinutes} minutes of play, ${e.minCompletedMatches} completed matches, and no open security review.`,
    `Caps per player: ${sol(cfg.caps.daily)} per day, ${sol(cfg.caps.weekly)} per week, ${sol(cfg.caps.season)} per season.`,
    `Rewards are funded from a fixed share (${Math.round(cfg.rewardBudgetRatio * 100)}%) of real game revenue and a funded reward pool — the pool is finite and rewards stop when it is spent.`,
    `Unclaimed rewards expire after ${cfg.rewardExpiryDays} days. Claims have a ${e.claimCooldownMinutes}-minute cooldown.`,
    "Reward rates adjust automatically with treasury health and can be paused during abnormal activity.",
    "Rewards are earned through gameplay only and carry no promise of any value. Devnet tokens have no monetary value.",
    `Withdrawals: minimum ${sol(cfg.withdrawal.min)}, service fee ${(cfg.fees.withdrawalServicePercent * 100).toFixed(1)}% + ${sol(cfg.fees.withdrawalFlat)}, only to your verified wallet, locked ${cfg.withdrawal.walletChangeLockHours}h after a wallet change.`
  ];
}

export async function economyStatus(db: DbOrTx): Promise<EconomyStatusResponse> {
  const cfg = await loadEconomyConfig(db);
  const [treasury, budget, breakers] = await Promise.all([getTreasuryState(db, cfg), getRewardBudgetState(db, cfg), getActiveBreakers(db)]);
  const emission = emissionFromConfig(cfg, treasury.health);
  return {
    treasuryHealth: treasury.health,
    rewardPoolRemaining: budget.remaining.toString(),
    seasonRewardBudget: budget.effectiveBudget.toString(),
    currentRewardRate: breakers.includes("REWARD_PAUSE") ? 0 : emission.rate,
    activeBreakers: breakers,
    fees: feesDto(cfg)
  };
}

const txQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: idSchema.optional(),
  asset: z.enum(["CREDITS", "GEMS", "NEBX", "SOL"]).optional()
});

const plugin: FastifyPluginAsync = async (app) => {
  const db = app.db;

  app.get("/api/economy/status", async (): Promise<EconomyStatusResponse> => economyStatus(db));

  app.get("/api/economy/fees", async (): Promise<FeesResponse> => feesDto(await loadEconomyConfig(db)));

  app.get("/api/economy/rewards", { preHandler: app.authenticate }, async (req): Promise<RewardsResponse & { nextClaimAt: string | null }> => {
    const userId = req.user.id;
    const cfg = await loadEconomyConfig(db);
    const budget = await getRewardBudgetState(db, cfg);
    const [rewards, usage, elig, claimable, lastClaim] = await Promise.all([
      db.reward.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 100 }),
      getCapUsage(db, userId, budget.seasonId),
      getRewardEligibility(db, userId, cfg),
      db.reward.aggregate({ where: { userId, status: "CLAIMABLE", OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }, _sum: { amount: true } }),
      db.rewardClaim.findFirst({ where: { userId }, orderBy: { createdAt: "desc" }, select: { createdAt: true } })
    ]);
    const lim = capLimits(cfg);
    const next = claimCooldownUntil(lastClaim?.createdAt ?? null, cfg);
    return {
      rewards: rewards.map(rewardDto),
      claimable: (claimable._sum.amount ?? 0n).toString(),
      caps: {
        daily: lim.daily.toString(),
        weekly: lim.weekly.toString(),
        season: lim.season.toString(),
        dailyUsed: usage.daily.toString(),
        weeklyUsed: usage.weekly.toString(),
        seasonUsed: usage.season.toString()
      },
      eligibility: elig,
      rules: rewardRules(cfg),
      nextClaimAt: next?.toISOString() ?? null
    };
  });

  app.get("/api/economy/transactions", { preHandler: app.authenticate }, async (req): Promise<{ entries: LedgerEntryDto[]; nextCursor: string | null }> => {
    const q = app.parse(txQuery, req.query);
    const userId = req.user.id;
    const accounts = await db.balanceAccount.findMany({ where: { userId, ...(q.asset ? { asset: q.asset } : {}) }, select: { id: true } });
    const ids = accounts.map((a) => a.id);
    if (!ids.length) return { entries: [], nextCursor: null };
    const rows = await db.balanceLedger.findMany({
      where: { OR: [{ debitAccountId: { in: ids } }, { creditAccountId: { in: ids } }] },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {})
    });
    const idSet = new Set(ids);
    const page = rows.slice(0, q.limit);
    return {
      entries: page.map((r) => ({
        id: r.id,
        type: r.type,
        asset: r.asset as Currency,
        amount: r.amount.toString(),
        direction: idSet.has(r.creditAccountId) ? "CREDIT" : "DEBIT",
        reference: r.reference,
        createdAt: r.createdAt.toISOString(),
        metadata: r.metadata
      })),
      nextCursor: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null
    };
  });
};

export default plugin;
