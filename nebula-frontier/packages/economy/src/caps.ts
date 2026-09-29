import type { DbOrTx } from "@nebula/database";
import type { EconomyConfig } from "./config.js";
import { startOfUtcDay, startOfUtcWeek } from "./util.js";

export interface CapUsage {
  daily: bigint;
  weekly: bigint;
  season: bigint;
}

export interface CapResult {
  /** Amount that fits under every cap (may be less than requested). */
  allowed: bigint;
  capped: boolean;
  reasons: string[];
}

export function capLimits(cfg: Pick<EconomyConfig, "caps">): CapUsage {
  return { daily: cfg.caps.daily, weekly: cfg.caps.weekly, season: cfg.caps.season };
}

/** Pure: clips `amount` so daily/weekly/season usage never exceeds the configured caps. */
export function applyCaps(amount: bigint, used: CapUsage, cfg: Pick<EconomyConfig, "caps">): CapResult {
  const lim = capLimits(cfg);
  const reasons: string[] = [];
  let allowed = amount < 0n ? 0n : amount;
  const check = (name: keyof CapUsage) => {
    const room = lim[name] - used[name];
    const r = room > 0n ? room : 0n;
    if (allowed > r) {
      allowed = r;
      reasons.push(`${name} cap reached`);
    }
  };
  check("daily");
  check("weekly");
  check("season");
  return { allowed, capped: allowed < amount, reasons };
}

const COUNTED = ["CLAIMABLE", "CLAIMED", "PENDING_REVIEW"];

export async function getCapUsage(db: DbOrTx, userId: string, seasonId: string | null, now = new Date()): Promise<CapUsage> {
  const sum = async (where: object) =>
    (await db.reward.aggregate({ where: { userId, status: { in: COUNTED }, ...where }, _sum: { amount: true } }))._sum.amount ?? 0n;
  const [daily, weekly, season] = await Promise.all([
    sum({ createdAt: { gte: startOfUtcDay(now) } }),
    sum({ createdAt: { gte: startOfUtcWeek(now) } }),
    seasonId ? sum({ seasonId }) : sum({ createdAt: { gte: new Date(now.getTime() - 90 * 86_400_000) } })
  ]);
  return { daily, weekly, season };
}
