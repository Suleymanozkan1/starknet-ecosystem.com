/**
 * Demo wallet / economy routes (apps/api/src/routes/{wallet,economy,rewards}.ts). Nothing on-chain exists in
 * the demo: no wallets, zero crypto balances, no rewards — every chain-facing action returns DEMO_DISABLED.
 * Credit/gem history comes from the local ledger the demo records on every balance change.
 */
import { ECONOMY } from "@nebula/config";
import type { EconomyStatusResponse, FeesResponse, LedgerEntryDto, RewardsResponse, WalletResponse } from "@nebula/shared";
import { z } from "@nebula/validation";
import { balancesDto } from "./account.js";
import { badRequest, demoDisabled, parse } from "./errors.js";
import { cleanQuery, requireAccount, route } from "./router.js";

function feesDto(): FeesResponse {
  const f = ECONOMY.fees;
  return {
    marketplaceFee: f.marketplace,
    auctionListingFee: f.auctionListing,
    auctionSaleFee: f.auctionSale,
    auctionCancellationFee: f.auctionCancellation,
    withdrawalServiceFeePercent: f.withdrawalServicePercent,
    withdrawalFlatFee: f.withdrawalFlat.toString(),
    estimatedNetworkFee: f.estimatedNetworkFee.toString(),
    tradeTax: f.tradeTax,
  };
}

const DEMO_REWARD_RULES = [
  "This is an offline demo: Battle Rewards, Season Rewards and Tournament Rewards are not available here.",
  "Credits and gems in the demo are local play money stored only in this browser.",
  "Nothing in the demo has any monetary value, and no wallet or blockchain is ever contacted.",
];

route("GET", "/api/wallet", (): WalletResponse => {
  const acc = requireAccount();
  const w = ECONOMY.withdrawal;
  return {
    wallets: [],
    balances: balancesDto(acc),
    network: "devnet",
    treasuryAddress: "",
    rewardAsset: { symbol: ECONOMY.tokenomics.symbol, mint: null, decimals: ECONOMY.currencies.NEBX.decimals },
    limits: {
      min: w.min.toString(),
      max: w.max.toString(),
      dailyLimit: w.dailyLimit.toString(),
      dailyUsed: "0",
      cooldownMinutes: w.cooldownMinutes,
      nextAllowedAt: null,
      serviceFeePercent: ECONOMY.fees.withdrawalServicePercent,
      flatFee: ECONOMY.fees.withdrawalFlat.toString(),
      estimatedNetworkFee: ECONOMY.fees.estimatedNetworkFee.toString(),
    },
    deposits: [],
    withdrawals: [],
  };
});

const walletDisabled = (): never => {
  throw demoDisabled("Wallets and on-chain transfers are disabled in the demo");
};
route("POST", "/api/wallet/connect", walletDisabled);
route("POST", "/api/wallet/deposit/prepare", walletDisabled);
route("POST", "/api/wallet/deposit/verify", walletDisabled);
route("GET", "/api/wallet/withdraw/quote", walletDisabled);
route("GET", "/api/wallet/withdraw/check", walletDisabled);
route("POST", "/api/wallet/withdraw", walletDisabled);
route("GET", "/api/wallet/withdrawals/:id", walletDisabled);

route("GET", "/api/economy/status", (): EconomyStatusResponse => ({
  treasuryHealth: "HEALTHY",
  rewardPoolRemaining: "0",
  seasonRewardBudget: "0",
  currentRewardRate: 0,
  activeBreakers: [],
  fees: feesDto(),
}));

route("GET", "/api/economy/fees", (): FeesResponse => feesDto());

route("GET", "/api/economy/rewards", (): RewardsResponse & { nextClaimAt: string | null } => {
  requireAccount();
  return {
    rewards: [],
    claimable: "0",
    caps: {
      daily: ECONOMY.caps.daily.toString(),
      weekly: ECONOMY.caps.weekly.toString(),
      season: ECONOMY.caps.season.toString(),
      dailyUsed: "0",
      weeklyUsed: "0",
      seasonUsed: "0",
    },
    eligibility: { eligible: false, reasons: ["Rewards are not available in the demo"] },
    rules: DEMO_REWARD_RULES,
    nextClaimAt: null,
  };
});

const txQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(64).optional(),
  asset: z.enum(["CREDITS", "GEMS", "NEBX", "SOL"]).optional(),
});

route("GET", "/api/economy/transactions", (c): { entries: LedgerEntryDto[]; nextCursor: string | null } => {
  const acc = requireAccount();
  const query = parse(txQuery, cleanQuery(c.query));
  let rows = acc.ledger.filter((e) => !query.asset || e.asset === query.asset);
  if (query.cursor) {
    const idx = rows.findIndex((e) => e.id === query.cursor);
    rows = idx >= 0 ? rows.slice(idx + 1) : [];
  }
  const page = rows.slice(0, query.limit);
  return {
    entries: page.map((e) => ({ id: e.id, type: e.type, asset: e.asset, amount: e.amount, direction: e.direction, reference: e.reference, createdAt: e.createdAt, metadata: e.metadata })),
    nextCursor: rows.length > query.limit ? (page[page.length - 1]?.id ?? null) : null,
  };
});

route("POST", "/api/rewards/claim", () => {
  requireAccount();
  throw badRequest("NOTHING_TO_CLAIM", "No claimable rewards");
});
