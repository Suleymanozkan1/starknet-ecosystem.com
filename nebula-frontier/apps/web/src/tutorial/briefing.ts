/** ARIA landing briefing: the step-by-step walkthrough of the whole game. */
import { FACTIONS, MAPS, PROGRESSION, SHIPS } from "@nebula/config";
import type { IconName } from "@nebula/game-ui";
import type { TKey, TVars } from "../lib/i18n.js";

export interface BriefingStep {
  id: string;
  icon: IconName;
  title: TKey;
  body: TKey;
  vars?: TVars;
  /** Appended in the demo build. */
  demoNote?: TKey;
  /** Only part of the demo build's briefing. */
  demoOnly?: boolean;
}

const step = (id: string, icon: IconName, extra: Omit<BriefingStep, "id" | "icon" | "title" | "body"> = {}): BriefingStep => ({
  id,
  icon,
  title: `aria.brief.${id}.title` as TKey,
  body: `aria.brief.${id}.body` as TKey,
  ...extra,
});

const factionNames = (): TVars => ({ a: FACTIONS[0]?.name ?? "", b: FACTIONS[1]?.name ?? "", c: FACTIONS[2]?.name ?? "" });

export const BRIEFING_STEPS: readonly BriefingStep[] = [
  step("intro", "rocket"),
  step("factions", "crown", { vars: factionNames() }),
  step("ships", "ship", { vars: { n: SHIPS.length } }),
  step("hangar", "hangar"),
  step("gear", "weapon"),
  step("combat", "fire"),
  step("abilities", "zap"),
  step("mining", "pickaxe"),
  step("loot", "gems"),
  step("stations", "station"),
  step("galaxy", "galaxy", { vars: { n: MAPS.length } }),
  step("zones", "shield"),
  step("npcs", "target"),
  step("gates", "sword"),
  step("missions", "missions"),
  step("crafting", "crafting"),
  step("market", "market"),
  step("clans", "clan"),
  step("social", "friends"),
  step("leaderboards", "leaderboard"),
  step("season", "battlepass"),
  step("events", "events"),
  step("progression", "star", { vars: { max: PROGRESSION.maxLevel } }),
  step("premium", "gems"),
  step("rewards", "crypto", { demoNote: "aria.brief.rewards.demo" }),
  step("crossplay", "globe"),
  step("demo", "gamepad", { demoOnly: true }),
  step("ready", "play"),
];

export const BRIEFING_KEY = "landing";

/** Steps for this build (the demo-only tester-kit step is skipped outside the demo). */
export function briefingSteps(demo: boolean): BriefingStep[] {
  return BRIEFING_STEPS.filter((s) => demo || !s.demoOnly);
}
