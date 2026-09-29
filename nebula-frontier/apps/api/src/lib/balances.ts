import { getUserBalances, type DbOrTx } from "@nebula/database";
import type { BalancesDto, ResourceId } from "@nebula/shared";

export async function balancesDto(db: DbOrTx, userId: string): Promise<BalancesDto> {
  const [b, res] = await Promise.all([
    getUserBalances(db, userId),
    db.playerResource.findMany({ where: { userId }, select: { resourceId: true, amount: true } }),
  ]);
  const resources: Partial<Record<ResourceId, number>> = {};
  for (const r of res) resources[r.resourceId as ResourceId] = Number(r.amount);
  return {
    credits: (b["USER_WALLET:CREDITS"] ?? 0n).toString(),
    gems: (b["USER_WALLET:GEMS"] ?? 0n).toString(),
    nebx: (b["USER_WALLET:NEBX"] ?? 0n).toString(),
    pendingRewards: (b["USER_PENDING_REWARD:NEBX"] ?? 0n).toString(),
    resources,
  };
}
