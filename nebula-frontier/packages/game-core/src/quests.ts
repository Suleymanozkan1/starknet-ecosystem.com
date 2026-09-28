/**
 * Quest objective progress & achievement unlock evaluation from game events.
 */
import type { AchievementDef, QuestDef, QuestObjectiveDef } from "@nebula/shared";

export type GameplayEvent =
  | { type: "KILL"; npcId: string; boss: boolean; mapId: string }
  | { type: "KILL_PLAYER"; victimId: string; mapId: string }
  | { type: "COLLECT"; itemId: string; quantity: number; mapId: string }
  | { type: "MINE"; resourceId: string; quantity: number; mapId: string }
  | { type: "TRAVEL"; mapId: string }
  | { type: "DAMAGE_BOSS"; bossId: string; amount: number; mapId: string }
  | { type: "COMPLETE_GATE"; gateId: string; mapId: string }
  | { type: "WIN_PVP"; mapId: string }
  | { type: "LEVEL"; level: number }
  | { type: "CRAFT"; blueprintId: string; quantity: number }
  | { type: "SURVIVE"; seconds: number; mapId: string }
  | { type: "DELIVER"; resourceId: string; quantity: number; mapId: string }
  | { type: "ESCORT"; mapId: string };

function mapMatches(obj: QuestObjectiveDef, mapId: string | undefined): boolean {
  return !obj.map || obj.map === mapId;
}

/** Progress increment an event contributes to one objective (0 = not relevant). */
export function objectiveIncrement(obj: QuestObjectiveDef, ev: GameplayEvent): number {
  switch (obj.type) {
    case "KILL":
      return ev.type === "KILL" && (!obj.target || obj.target === ev.npcId) && mapMatches(obj, ev.mapId) ? 1 : 0;
    case "KILL_PLAYER":
      return ev.type === "KILL_PLAYER" && mapMatches(obj, ev.mapId) ? 1 : 0;
    case "COLLECT":
      return ev.type === "COLLECT" && (!obj.target || obj.target === ev.itemId) && mapMatches(obj, ev.mapId) ? ev.quantity : 0;
    case "MINE_RESOURCES":
      return ev.type === "MINE" && (!obj.target || obj.target === ev.resourceId) && mapMatches(obj, ev.mapId) ? ev.quantity : 0;
    case "TRAVEL":
      return ev.type === "TRAVEL" && (obj.target ?? obj.map) === ev.mapId ? 1 : 0;
    case "DAMAGE_BOSS":
      return ev.type === "DAMAGE_BOSS" && (!obj.target || obj.target === ev.bossId) && mapMatches(obj, ev.mapId) ? Math.floor(ev.amount) : 0;
    case "COMPLETE_GATE":
      return ev.type === "COMPLETE_GATE" && (!obj.target || obj.target === ev.gateId) ? 1 : 0;
    case "WIN_PVP":
      return ev.type === "WIN_PVP" && mapMatches(obj, ev.mapId) ? 1 : 0;
    case "CRAFT":
      return ev.type === "CRAFT" && (!obj.target || obj.target === ev.blueprintId) ? ev.quantity : 0;
    case "SURVIVE":
      return ev.type === "SURVIVE" && mapMatches(obj, ev.mapId) ? Math.floor(ev.seconds) : 0;
    case "DELIVER":
      return ev.type === "DELIVER" && (!obj.target || obj.target === ev.resourceId) && mapMatches(obj, ev.mapId) ? ev.quantity : 0;
    case "ESCORT":
      return ev.type === "ESCORT" && mapMatches(obj, ev.mapId) ? 1 : 0;
    case "LEVEL":
      return 0; // handled as absolute in applyQuestEvent
    default:
      return 0;
  }
}

export interface QuestProgressResult {
  progress: number[];
  changed: boolean;
  completed: boolean;
}

/** Apply one event to a quest's progress array (clamped to objective counts). */
export function applyQuestEvent(def: QuestDef, progress: number[], ev: GameplayEvent): QuestProgressResult {
  const next = def.objectives.map((o, i) => {
    const cur = Math.min(progress[i] ?? 0, o.count);
    if (o.type === "LEVEL" && ev.type === "LEVEL") return Math.min(o.count, Math.max(cur, ev.level));
    return Math.min(o.count, cur + objectiveIncrement(o, ev));
  });
  const changed = next.some((v, i) => v !== (progress[i] ?? 0));
  const completed = def.objectives.every((o, i) => (next[i] ?? 0) >= o.count);
  return { progress: next, changed, completed };
}

export function isQuestComplete(def: QuestDef, progress: number[]): boolean {
  return def.objectives.every((o, i) => (progress[i] ?? 0) >= o.count);
}

/** Achievements newly unlocked by current metric values. */
export function newlyUnlockedAchievements(defs: AchievementDef[], metrics: Record<string, number>, unlocked: ReadonlySet<string>): AchievementDef[] {
  return defs.filter((a) => !unlocked.has(a.id) && (metrics[a.metric] ?? 0) >= a.threshold);
}

/** Period key for repeatable quests (daily/weekly/monthly) in UTC. */
export function questPeriodKey(type: string, now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  if (type === "DAILY") return `${y}-${m}-${d}`;
  if (type === "MONTHLY") return `${y}-${m}`;
  if (type === "WEEKLY") {
    const t = Date.UTC(y, now.getUTCMonth(), now.getUTCDate());
    const day = (now.getUTCDay() + 6) % 7; // Monday = 0
    const monday = new Date(t - day * 86_400_000);
    return `${monday.getUTCFullYear()}-W${String(monday.getUTCMonth() + 1).padStart(2, "0")}${String(monday.getUTCDate()).padStart(2, "0")}`;
  }
  return "once";
}
