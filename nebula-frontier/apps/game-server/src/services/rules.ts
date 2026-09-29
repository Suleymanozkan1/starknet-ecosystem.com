/**
 * Server-side game rules that are not part of the static content JSON
 * (distances for interactions, PvP anti-farming windows, loot ownership…).
 * Defaults below; ops can override at runtime through the `EconomyConfig`
 * row with key `game.rules` (JSON object, partial) — loaded at room creation.
 * Simulation tuning (`@nebula/game-core` SimTuning) can be overridden with key
 * `game.tuning`.
 */
import type { Db } from "@nebula/database";
import { mergeTuning, parseTuningOverride, type SimTuning } from "@nebula/game-core";
import type { Logger } from "@nebula/telemetry";
import { z } from "zod";

export interface GameRules {
  pickupRange: number;
  dockRange: number;
  portalRange: number;
  lootOwnerMs: number;
  lootTtlMs: number;
  spawnProtectionMs: number;
  combatLockMs: number;
  /** Honor for a PvP kill = victim level × this. */
  pvpHonorPerVictimLevel: number;
  /** XP for a PvP kill = victim level × this. */
  pvpXpPerVictimLevel: number;
  /** Repeated kills of the same victim by the same killer inside this window grant nothing. */
  pvpSameVictimWindowMs: number;
  /** Max level gap (killer − victim) for a PvP kill to count toward rewards. */
  pvpMaxLevelGap: number;
  /** Crypto reward weight for a counted PvP kill (routed through grantCryptoReward). */
  pvpCryptoWeight: number;
  /** Minimum boss contribution share (0..1) to receive boss rewards. */
  bossMinContribution: number;
  chatRatePerSec: number;
  chatBurst: number;
  packetRatePerSec: number;
  packetBurst: number;
  aoiUpdateEveryTicks: number;
  unarmedMiningFactor: number;
  miningRange: number;
  asteroidAmount: number;
  asteroidRespawnMs: number;
  arenaMatchMs: number;
  arenaMinPlayers: number;
  arenaCountdownMs: number;
  arenaScoreToWin: number;
  gateWaveDelayMs: number;
  reconnectSeconds: number;
  /** Clan score added per enemy kill in a clan war, and bonus for the winning clan. */
  clanWarKillScore: number;
  clanWarWinScore: number;
  /** Raid anti-exploit: min contributors = ceil(size × fraction); daily raid entries per pilot. */
  raidMinPilotsFraction: number;
  raidDailyEntries: number;
  /** Share of the owner's kill XP granted to the active companion. */
  petXpShare: number;
  /** ENEMY_SCAN reveal radius (× pet level scale). */
  petScanRadius: number;
  petFollowDistance: number;
}

export const DEFAULT_RULES: GameRules = {
  pickupRange: 14,
  dockRange: 25,
  portalRange: 18,
  lootOwnerMs: 20_000,
  lootTtlMs: 90_000,
  spawnProtectionMs: 5_000,
  combatLockMs: 6_000,
  pvpHonorPerVictimLevel: 12,
  pvpXpPerVictimLevel: 150,
  pvpSameVictimWindowMs: 30 * 60_000,
  pvpMaxLevelGap: 15,
  pvpCryptoWeight: 1,
  bossMinContribution: 0.005,
  chatRatePerSec: 0.7,
  chatBurst: 3,
  packetRatePerSec: 90,
  packetBurst: 120,
  aoiUpdateEveryTicks: 4,
  unarmedMiningFactor: 0.15,
  miningRange: 30,
  asteroidAmount: 60,
  asteroidRespawnMs: 60_000,
  arenaMatchMs: 8 * 60_000,
  arenaMinPlayers: 2,
  arenaCountdownMs: 10_000,
  arenaScoreToWin: 25,
  gateWaveDelayMs: 4_000,
  reconnectSeconds: 20,
  clanWarKillScore: 10,
  clanWarWinScore: 100,
  raidMinPilotsFraction: 0.5,
  raidDailyEntries: 3,
  petXpShare: 0.1,
  petScanRadius: 60,
  petFollowDistance: 6,
};

const num = z.number().refine((n) => Number.isFinite(n), "must be finite");
const nonNeg = num.refine((n) => n >= 0, "must be >= 0");
const pos = num.refine((n) => n > 0, "must be > 0");
const frac = num.refine((n) => n >= 0 && n <= 1, "must be within 0..1");
const int = (min: number) => z.number().int().min(min);

/** Strict schema for `game.rules` overrides (partial; unknown keys rejected). */
export const GameRulesOverrideSchema = z.object({
  pickupRange: pos, dockRange: pos, portalRange: pos, lootOwnerMs: nonNeg, lootTtlMs: pos, spawnProtectionMs: nonNeg,
  combatLockMs: nonNeg, pvpHonorPerVictimLevel: nonNeg, pvpXpPerVictimLevel: nonNeg, pvpSameVictimWindowMs: nonNeg,
  pvpMaxLevelGap: int(0), pvpCryptoWeight: nonNeg, bossMinContribution: frac, chatRatePerSec: pos, chatBurst: int(1),
  packetRatePerSec: pos, packetBurst: int(1), aoiUpdateEveryTicks: int(1), unarmedMiningFactor: nonNeg, miningRange: pos,
  asteroidAmount: int(1), asteroidRespawnMs: nonNeg, arenaMatchMs: pos, arenaMinPlayers: int(2), arenaCountdownMs: nonNeg,
  arenaScoreToWin: int(1), gateWaveDelayMs: nonNeg, reconnectSeconds: nonNeg, clanWarKillScore: nonNeg, clanWarWinScore: nonNeg,
  raidMinPilotsFraction: frac, raidDailyEntries: int(0), petXpShare: frac, petScanRadius: nonNeg, petFollowDistance: nonNeg,
} satisfies Record<keyof GameRules, z.ZodType>).partial().strict();

export interface LoadedRules {
  rules: GameRules;
  tuning: SimTuning;
  /** Validation problems of rejected overrides (logged by the caller). */
  warnings: string[];
}

/** Validate untrusted overrides; invalid documents are ignored entirely (defaults apply). */
export function applyOverrides(rawRules: unknown, rawTuning: unknown): LoadedRules {
  const warnings: string[] = [];
  let rules: GameRules = { ...DEFAULT_RULES };
  if (rawRules !== undefined && rawRules !== null) {
    const r = GameRulesOverrideSchema.safeParse(rawRules);
    if (r.success) rules = { ...DEFAULT_RULES, ...r.data };
    else warnings.push(`game.rules rejected: ${r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  }
  let tuning = mergeTuning();
  if (rawTuning !== undefined && rawTuning !== null) {
    const t = parseTuningOverride(rawTuning);
    if (t.ok) tuning = mergeTuning(t.value);
    else warnings.push(`game.tuning rejected: ${t.error}`);
  }
  return { rules, tuning, warnings };
}

export async function loadRules(db: Db | null, log?: Pick<Logger, "warn">): Promise<LoadedRules> {
  if (!db) return applyOverrides(undefined, undefined);
  try {
    const rows = await db.economyConfig.findMany({ where: { key: { in: ["game.rules", "game.tuning"] } } });
    const out = applyOverrides(rows.find((r) => r.key === "game.rules")?.value, rows.find((r) => r.key === "game.tuning")?.value);
    for (const w of out.warnings) log?.warn(w);
    return out;
  } catch (e) {
    log?.warn(`game rules could not be loaded, using defaults: ${(e as Error).message}`);
    return applyOverrides(undefined, undefined);
  }
}
