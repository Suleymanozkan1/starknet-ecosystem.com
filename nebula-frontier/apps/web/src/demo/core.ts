/** @nebula/game-core helpers used by the demo backend (the same formulas the real API and game server use). */
export {
  activeEventWindow, applyQuestEvent, computeStats, craftCompletesAt, craftCost, levelForXp, levelProgress, newlyUnlockedAchievements,
  nextEventWindow, questPeriodKey, rankFor, rollCraft, starterAmmoFor, toMoney, upgradeCost, xpForLevel,
} from "@nebula/game-core";
export type { Equipped, GameplayEvent, LoadoutInput, UpgradeCost as CoreUpgradeCost } from "@nebula/game-core";
