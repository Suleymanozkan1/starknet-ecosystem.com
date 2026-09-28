/**
 * Server-side game rules that are not part of the static content JSON
 * (distances for interactions, PvP anti-farming windows, loot ownership…).
 * Defaults below; ops can override at runtime through the `EconomyConfig`
 * row with key `game.rules` (JSON object, partial) — loaded at room creation.
 * Simulation tuning (`@nebula/game-core` SimTuning) can be overridden with key
 * `game.tuning`.
 */
import type { Db } from "@nebula/database";
import { mergeTuning, type SimTuning } from "@nebula/game-core";

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
};

export async function loadRules(db: Db | null): Promise<{ rules: GameRules; tuning: SimTuning }> {
  if (!db) return { rules: DEFAULT_RULES, tuning: mergeTuning() };
  try {
    const rows = await db.economyConfig.findMany({ where: { key: { in: ["game.rules", "game.tuning"] } } });
    const get = (k: string) => rows.find((r) => r.key === k)?.value;
    const r = get("game.rules");
    const t = get("game.tuning");
    return {
      rules: { ...DEFAULT_RULES, ...(r && typeof r === "object" && !Array.isArray(r) ? (r as Partial<GameRules>) : {}) },
      tuning: mergeTuning(t && typeof t === "object" && !Array.isArray(t) ? (t as Partial<SimTuning>) : undefined),
    };
  } catch {
    return { rules: DEFAULT_RULES, tuning: mergeTuning() };
  }
}
