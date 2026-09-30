/**
 * In-game ARIA tips: catalogue + pure trigger logic (HUD state / HUD events → tip ids) + queue helpers.
 * No React here so everything is unit-testable (gameTips.test.ts).
 */
import type { TKey } from "../lib/i18n.js";
import { EMPTY_HUD } from "../game/hudModel.js";
import type { HudEvent, HudView } from "../game/hudModel.js";

export const GAME_TIP_IDS = [
  "welcome", "move", "fire", "targeting", "abilities", "radar", "chat",
  "target", "dock", "station", "mining", "loot", "portal", "jumped",
  "zone_safe", "zone_open", "zone_danger", "zone_boss",
  "shield_low", "hull_low", "death", "level_up", "boss", "squad", "quest",
] as const;
export type GameTipId = (typeof GAME_TIP_IDS)[number];

export type TipTone = "info" | "good" | "warn" | "danger";

export interface GameTipDef {
  title: TKey;
  /** Desktop (keyboard + mouse) text. */
  body: TKey;
  /** Touch-controls text when it differs. */
  touch?: TKey;
  /** Lower = shown first. 0–2 are urgent (death / hull / shield). */
  priority: number;
  tone: TipTone;
}

export const GAME_TIPS: Readonly<Record<GameTipId, GameTipDef>> = {
  death: { title: "aria.tip.death.title", body: "aria.tip.death.body", touch: "aria.tip.death.touch", priority: 0, tone: "danger" },
  hull_low: { title: "aria.tip.hull_low.title", body: "aria.tip.hull_low.body", priority: 1, tone: "danger" },
  shield_low: { title: "aria.tip.shield_low.title", body: "aria.tip.shield_low.body", priority: 2, tone: "warn" },
  boss: { title: "aria.tip.boss.title", body: "aria.tip.boss.body", priority: 2, tone: "warn" },
  // First-flight introduction, in this order.
  welcome: { title: "aria.tip.welcome.title", body: "aria.tip.welcome.body", priority: 3, tone: "info" },
  move: { title: "aria.tip.move.title", body: "aria.tip.move.body", touch: "aria.tip.move.touch", priority: 4, tone: "info" },
  fire: { title: "aria.tip.fire.title", body: "aria.tip.fire.body", touch: "aria.tip.fire.touch", priority: 5, tone: "info" },
  targeting: { title: "aria.tip.targeting.title", body: "aria.tip.targeting.body", touch: "aria.tip.targeting.touch", priority: 6, tone: "info" },
  abilities: { title: "aria.tip.abilities.title", body: "aria.tip.abilities.body", touch: "aria.tip.abilities.touch", priority: 7, tone: "info" },
  radar: { title: "aria.tip.radar.title", body: "aria.tip.radar.body", priority: 8, tone: "info" },
  // Situational.
  station: { title: "aria.tip.station.title", body: "aria.tip.station.body", priority: 9, tone: "good" },
  dock: { title: "aria.tip.dock.title", body: "aria.tip.dock.body", touch: "aria.tip.dock.touch", priority: 10, tone: "info" },
  loot: { title: "aria.tip.loot.title", body: "aria.tip.loot.body", touch: "aria.tip.loot.touch", priority: 10, tone: "good" },
  mining: { title: "aria.tip.mining.title", body: "aria.tip.mining.body", touch: "aria.tip.mining.touch", priority: 10, tone: "info" },
  portal: { title: "aria.tip.portal.title", body: "aria.tip.portal.body", touch: "aria.tip.portal.touch", priority: 10, tone: "info" },
  target: { title: "aria.tip.target.title", body: "aria.tip.target.body", touch: "aria.tip.target.touch", priority: 11, tone: "info" },
  level_up: { title: "aria.tip.level_up.title", body: "aria.tip.level_up.body", priority: 11, tone: "good" },
  zone_danger: { title: "aria.tip.zone_danger.title", body: "aria.tip.zone_danger.body", priority: 12, tone: "warn" },
  zone_boss: { title: "aria.tip.zone_boss.title", body: "aria.tip.zone_boss.body", priority: 12, tone: "warn" },
  zone_open: { title: "aria.tip.zone_open.title", body: "aria.tip.zone_open.body", priority: 13, tone: "info" },
  zone_safe: { title: "aria.tip.zone_safe.title", body: "aria.tip.zone_safe.body", priority: 13, tone: "good" },
  jumped: { title: "aria.tip.jumped.title", body: "aria.tip.jumped.body", priority: 14, tone: "info" },
  squad: { title: "aria.tip.squad.title", body: "aria.tip.squad.body", priority: 14, tone: "info" },
  quest: { title: "aria.tip.quest.title", body: "aria.tip.quest.body", touch: "aria.tip.quest.touch", priority: 15, tone: "info" },
  chat: { title: "aria.tip.chat.title", body: "aria.tip.chat.body", touch: "aria.tip.chat.touch", priority: 30, tone: "info" },
};

/** Queued on the first connected HUD frame of a session. */
export const INTRO_TIPS: readonly GameTipId[] = ["welcome", "move", "fire", "targeting", "radar", "chat"];

/** Persisted id in the tutorial store. */
export function gameTipKey(id: GameTipId): string {
  return `game:${id}`;
}

export function tipText(id: GameTipId, touch: boolean): { title: TKey; body: TKey } {
  const d = GAME_TIPS[id];
  return { title: d.title, body: touch && d.touch ? d.touch : d.body };
}

/** Zone id (HUD zone label) → zone tip. */
export function zoneTip(zone: string | null): GameTipId | null {
  switch (zone) {
    case "SAFE": return "zone_safe";
    case "NEUTRAL": case "MINING": return "zone_open";
    case "PVP": case "HIGH_RISK": case "PIRATE": return "zone_danger";
    case "BOSS": case "GATE": case "EVENT": return "zone_boss";
    default: return null;
  }
}

const SHIELD_LOW = 0.25;
const HULL_LOW = 0.35;

function ratio(b: { value: number; max: number }): number {
  return b.max > 1 ? b.value / b.max : 1;
}

/**
 * Tips triggered by a HUD change (edge-triggered: a condition that just became true).
 * `prev === null` means this is the first connected frame of the session → the intro sequence.
 */
export function tipsForHud(prev: HudView | null, next: HudView): GameTipId[] {
  const out: GameTipId[] = [];
  const base = prev ?? EMPTY_HUD;
  if (!prev) out.push(...INTRO_TIPS);
  if (base.skills.length === 0 && next.skills.length > 0) out.push("abilities");
  if (!base.dead && next.dead) out.push("death");
  if (!next.dead) {
    const sh = ratio(next.shield), hu = ratio(next.hull);
    if (next.shield.max > 1 && sh < SHIELD_LOW && ratio(base.shield) >= SHIELD_LOW && prev) out.push("shield_low");
    if (next.hull.max > 1 && hu < HULL_LOW && ratio(base.hull) >= HULL_LOW && prev) out.push("hull_low");
  }
  if (!base.boss && next.boss) out.push("boss");
  if (!base.docked && next.docked) out.push("station");
  if (!base.dockPrompt && next.dockPrompt) out.push("dock");
  if (!base.nearby.loot && next.nearby.loot) out.push("loot");
  if (!base.nearby.asteroid && next.nearby.asteroid) out.push("mining");
  if (!base.nearby.portal && next.nearby.portal) out.push("portal");
  if (!base.target && next.target?.hostile) out.push("target");
  if (base.squad.length === 0 && next.squad.length > 0) out.push("squad");
  if (!base.quest && next.quest) out.push("quest");
  if (next.zone !== base.zone) {
    const z = zoneTip(next.zone);
    if (z) out.push(z);
  }
  return out;
}

/** Tips triggered by a one-off HUD event. */
export function tipsForEvent(e: HudEvent): GameTipId[] {
  switch (e.type) {
    case "levelup": return ["level_up"];
    case "boss_phase": return ["boss"];
    case "jump": return e.phase === "end" ? ["jumped"] : [];
    case "chat": return ["chat"];
    default: return [];
  }
}

/**
 * Adds `add` to the queue: skips seen tips, the tip on screen and duplicates, then orders by priority
 * (stable — equal priorities keep their arrival order).
 */
export function enqueueTips(queue: readonly GameTipId[], add: readonly GameTipId[], isSeen: (id: GameTipId) => boolean, current: GameTipId | null = null): GameTipId[] {
  const next = [...queue];
  for (const id of add) {
    if (id === current || next.includes(id) || isSeen(id)) continue;
    next.push(id);
  }
  return next
    .map((id, i) => ({ id, i }))
    .sort((a, b) => GAME_TIPS[a.id].priority - GAME_TIPS[b.id].priority || a.i - b.i)
    .map((x) => x.id);
}

/**
 * Whether a queued tip can be shown with the current HUD: "show", "wait" (e.g. while dead / docked only
 * the matching tips appear) or "drop" (the situation is over — the tip stays unseen and can trigger again).
 */
export function tipStatus(id: GameTipId, hud: HudView): "show" | "wait" | "drop" {
  switch (id) {
    case "death": return hud.dead ? "show" : "drop";
    case "station": return hud.docked ? "show" : "drop";
    case "dock": return hud.dockPrompt && !hud.dead ? "show" : "drop";
    case "loot": if (!hud.nearby.loot) return "drop"; break;
    case "mining": if (!hud.nearby.asteroid) return "drop"; break;
    case "portal": if (!hud.nearby.portal) return "drop"; break;
    case "target": if (!hud.target) return "drop"; break;
    case "shield_low": case "hull_low": if (hud.dead) return "drop"; break;
    default: break;
  }
  if (hud.dead) return "wait";
  if (hud.docked) return id === "level_up" ? "show" : "wait";
  return "show";
}

/**
 * Picks the next tip to display and returns the remaining queue (dropped tips removed).
 */
export function takeNextTip(queue: readonly GameTipId[], hud: HudView): { tip: GameTipId | null; rest: GameTipId[] } {
  const rest: GameTipId[] = [];
  let tip: GameTipId | null = null;
  for (const id of queue) {
    const st = tipStatus(id, hud);
    if (st === "drop") continue;
    if (st === "show" && tip === null) tip = id;
    else rest.push(id);
  }
  return { tip, rest };
}

/** Whether `candidate` is urgent enough to replace the tip on screen (death / hull / shield warnings). */
export function preempts(candidate: GameTipId, current: GameTipId): boolean {
  return GAME_TIPS[candidate].priority <= 2 && GAME_TIPS[candidate].priority < GAME_TIPS[current].priority;
}

/** Reading time for a tip once it is fully typed: ~220 wpm plus a base, clamped to 5–14 s. */
export function tipDurationMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.min(14_000, Math.max(5_000, 2_500 + words * 280));
}
