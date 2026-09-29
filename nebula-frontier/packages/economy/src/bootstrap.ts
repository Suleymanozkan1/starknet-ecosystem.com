import { SEASONS } from "@nebula/config";
import { CircuitBreakerMode, Currency, LedgerAccountType } from "@nebula/shared";
import { ensureAccount, getBalance, post, system, withSerializableTx, type Db } from "@nebula/database";
import { loadEconomyConfig } from "./config.js";
import { mulRatioFloor } from "./util.js";

export interface BootstrapInput {
  /** Real on-chain treasury balance of the reward asset (lamports), read via RPC. */
  onChainBalance: bigint;
  /** Slot at which the balance was read (makes the funding posting idempotent). */
  slot: bigint;
  treasuryAddress: string;
  /** Lamports kept unallocated for transaction fees. */
  feeBuffer?: bigint;
  actorId?: string | null;
  /**
   * SPL reward-mint mode (REWARD_MINT set): the treasury's reward-token balance in base units.
   * NEBX is then reconciled ONLY against this balance, and `onChainBalance` (lamports) only backs SOL.
   * Omit in native mode (devnet default), where NEBX is paid as lamports from the same wallet.
   */
  rewardTokenBalance?: bigint;
}

export interface BootstrapResult {
  accounted: bigint;
  delta: bigint;
  funded: bigint;
  allocation: Record<string, bigint>;
  seasonId: string | null;
  warnings: string[];
}

const ASSETS = [Currency.NEBX, Currency.SOL, Currency.CREDITS, Currency.GEMS];
const SYSTEM_TYPES = Object.values(LedgerAccountType).filter((t) => t !== LedgerAccountType.USER_WALLET && t !== LedgerAccountType.USER_PENDING_REWARD);

/**
 * Creates system accounts, circuit-breaker rows and the active season (if missing), then funds the
 * ledger from REAL treasury funds: only the difference between the on-chain balance and what the
 * ledger already accounts for is recorded (ADMIN_ADJUSTMENT EXTERNAL_CHAIN → TREASURY), then split by
 * reserve ratios (RESERVE_ALLOCATION). The reward pool can therefore never exceed real funds.
 */
export async function bootstrapTreasury(db: Db, input: BootstrapInput): Promise<BootstrapResult> {
  const cfg = await loadEconomyConfig(db);
  const warnings: string[] = [];
  for (const asset of ASSETS) for (const type of SYSTEM_TYPES) await ensureAccount(db, system(type, asset));
  for (const mode of Object.values(CircuitBreakerMode)) {
    await db.circuitBreaker.upsert({ where: { mode }, create: { mode, active: false }, update: {} });
  }
  // Active season from seasons.json (only created when missing; live data is never overwritten).
  const now = new Date();
  let seasonId: string | null = null;
  for (const s of SEASONS) {
    const start = new Date(s.startAt);
    const end = new Date(s.endAt);
    const active = start <= now && end >= now;
    const exists = await db.season.findUnique({ where: { id: s.id }, select: { id: true } });
    if (!exists) {
      await db.season.create({ data: { id: s.id, number: s.number, name: s.name, startAt: start, endAt: end, active, data: JSON.parse(JSON.stringify(s)) as object } });
    }
    if (active) seasonId = s.id;
  }

  return withSerializableTx(db, async (tx) => {
    const extNebx = await getBalance(tx, system(LedgerAccountType.EXTERNAL_CHAIN, Currency.NEBX));
    const extSol = await getBalance(tx, system(LedgerAccountType.EXTERNAL_CHAIN, Currency.SOL));
    const buffer = input.feeBuffer ?? 10_000_000n;
    let accounted: bigint;
    let delta: bigint;
    if (input.rewardTokenBalance !== undefined) {
      // SPL mode: separate assets. NEBX backing = reward-token balance only; SOL is checked on its own
      // (it pays fees, so the fee buffer applies to lamports, not tokens). Neither can offset the other.
      accounted = -extNebx;
      delta = input.rewardTokenBalance - accounted;
      if (input.onChainBalance < -extSol + buffer) {
        warnings.push(`SOL: ledger owes ${-extSol} lamports of deposits but the treasury holds ${input.onChainBalance} (fee buffer ${buffer}).`);
      }
    } else {
      // Native mode: NEBX is settled as lamports from the SAME treasury wallet (docs/ECONOMY.md), so
      // `onChainBalance` backs both ledger assets and both claims are subtracted before any surplus is
      // booked as NEBX funding. SOL deposits are therefore never counted as NEBX backing.
      accounted = -extNebx - extSol;
      delta = input.onChainBalance - buffer - accounted;
    }
    const allocation: Record<string, bigint> = {};
    if (delta <= 0n) {
      const spl = input.rewardTokenBalance !== undefined;
      const held = spl ? input.rewardTokenBalance : input.onChainBalance;
      if (spl ? delta < 0n : delta < -buffer) warnings.push(`Ledger accounts for ${accounted} ${spl ? "reward-token base units" : "lamports"} but chain holds ${held}; NOT funding. Investigate (network fees / manual transfers).`);
      return { accounted, delta, funded: 0n, allocation, seasonId, warnings };
    }
    // Audit trail: record which balance actually backed the funding (reward token in SPL mode).
    const mode = input.rewardTokenBalance !== undefined ? "SPL" : "NATIVE";
    const backing = input.rewardTokenBalance ?? input.onChainBalance;
    const key = `bootstrap:${input.treasuryAddress}:${input.slot}`;
    const res = await post(tx, {
      from: system(LedgerAccountType.EXTERNAL_CHAIN, Currency.NEBX),
      to: system(LedgerAccountType.TREASURY, Currency.NEBX),
      amount: delta,
      type: "ADMIN_ADJUSTMENT",
      reference: input.treasuryAddress,
      idempotencyKey: key,
      metadata: { mode, backingBalance: backing.toString(), onChainLamports: input.onChainBalance.toString(), slot: input.slot.toString(), accounted: accounted.toString(), reason: "Treasury funding reconciled from on-chain balance" }
    });
    if (res.duplicate) return { accounted, delta: 0n, funded: 0n, allocation, seasonId, warnings: ["Already bootstrapped at this slot"] };
    const splits: [LedgerAccountType, number][] = [
      [LedgerAccountType.PLAYER_REWARD_POOL, cfg.rewardBudgetRatio],
      [LedgerAccountType.OPERATING_RESERVE, cfg.operatingReserveRatio],
      [LedgerAccountType.EMERGENCY_RESERVE, cfg.emergencyReserveRatio]
    ];
    for (const [type, r] of splits) {
      const amt = mulRatioFloor(delta, r);
      allocation[type] = amt;
      if (amt > 0n) {
        await post(tx, {
          from: system(LedgerAccountType.TREASURY, Currency.NEBX),
          to: system(type, Currency.NEBX),
          amount: amt,
          type: "RESERVE_ALLOCATION",
          reference: res.id,
          idempotencyKey: `${key}:${type}`,
          metadata: { ratio: r }
        });
      }
    }
    allocation[LedgerAccountType.TREASURY] = delta - Object.values(allocation).reduce((a, b) => a + b, 0n);
    const poolFunding = allocation[LedgerAccountType.PLAYER_REWARD_POOL] ?? 0n;
    if (seasonId && poolFunding > 0n) await tx.season.update({ where: { id: seasonId }, data: { rewardBudget: { increment: poolFunding } } });
    await tx.auditLog.create({
      data: {
        actorId: input.actorId ?? null,
        actorType: input.actorId ? "ADMIN" : "SYSTEM",
        action: "TREASURY_BOOTSTRAP",
        targetType: "Treasury",
        targetId: input.treasuryAddress,
        oldValue: { accounted: accounted.toString() },
        newValue: { funded: delta.toString(), allocation: Object.fromEntries(Object.entries(allocation).map(([k, v]) => [k, v.toString()])) },
        reason: `${mode} backing balance ${backing} (treasury lamports ${input.onChainBalance}) at slot ${input.slot}`
      }
    });
    return { accounted, delta, funded: delta, allocation, seasonId, warnings };
  });
}
