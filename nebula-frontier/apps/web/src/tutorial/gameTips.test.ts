import { describe, expect, it } from "vitest";
import { EMPTY_HUD } from "../game/hudModel.js";
import type { HudView } from "../game/hudModel.js";
import { EN } from "../lib/i18n/en.js";
import { TR } from "../lib/i18n/tr.js";
import {
  GAME_TIPS, GAME_TIP_IDS, INTRO_TIPS, enqueueTips, gameTipKey, preempts, takeNextTip, tipDurationMs, tipStatus, tipText, tipsForEvent, tipsForHud, zoneTip,
} from "./gameTips.js";
import type { GameTipId } from "./gameTips.js";
import { PAGE_TIPS, pageTipFor } from "./pageTips.js";
import { BRIEFING_STEPS, briefingSteps } from "./briefing.js";
import { parseTip, plainTip } from "./TypedText.js";

const hud = (over: Partial<HudView> = {}): HudView => ({
  ...EMPTY_HUD,
  connection: "connected",
  hull: { value: 1000, max: 1000 },
  shield: { value: 800, max: 800 },
  energy: { value: 100, max: 100 },
  zone: "SAFE",
  mapId: "map_aurora_prime",
  ...over,
});
const skill = { slot: 0, key: "1", name: "Overdrive", kind: "ABILITY", cooldownMs: 8000, remainingMs: 0, energyCost: 20, active: false };
const target = { id: "n1", name: "Corsair", kind: "NPC", level: 3, hull: { value: 1, max: 1 }, shield: { value: 1, max: 1 }, distance: 120, faction: null, hostile: true };
const never = (): boolean => false;

describe("tipsForHud", () => {
  it("queues the intro, abilities and the spawn zone on the first connected frame", () => {
    const ids = tipsForHud(null, hud({ skills: [skill] }));
    expect(ids.slice(0, INTRO_TIPS.length)).toEqual([...INTRO_TIPS]);
    expect(ids).toContain("abilities");
    expect(ids).toContain("zone_safe");
    expect(ids).not.toContain("shield_low");
    expect(ids).not.toContain("death");
  });

  it("is edge-triggered: an unchanged HUD produces nothing", () => {
    const a = hud({ skills: [skill], target, dockPrompt: { stationId: "s", name: "Aurora Station" } });
    expect(tipsForHud(a, { ...a })).toEqual([]);
  });

  it("maps interactables and situations to their tips", () => {
    const base = hud();
    expect(tipsForHud(base, hud({ dockPrompt: { stationId: "s", name: "X" } }))).toEqual(["dock"]);
    expect(tipsForHud(base, hud({ docked: { stationId: "s", name: "X", services: ["HANGAR"] } }))).toEqual(["station"]);
    expect(tipsForHud(base, hud({ nearby: { loot: true, asteroid: false, portal: false } }))).toEqual(["loot"]);
    expect(tipsForHud(base, hud({ nearby: { loot: false, asteroid: true, portal: false } }))).toEqual(["mining"]);
    expect(tipsForHud(base, hud({ nearby: { loot: false, asteroid: false, portal: true } }))).toEqual(["portal"]);
    expect(tipsForHud(base, hud({ target }))).toEqual(["target"]);
    expect(tipsForHud(base, hud({ target: { ...target, hostile: false } }))).toEqual([]);
    expect(tipsForHud(base, hud({ squad: [{ id: "p", name: "Wing", hull: { value: 1, max: 1 }, shield: { value: 1, max: 1 }, dead: false }] }))).toEqual(["squad"]);
    expect(tipsForHud(base, hud({ quest: { name: "Q", objectives: [] } }))).toEqual(["quest"]);
    expect(tipsForHud(base, hud({ boss: { name: "Titan", hull: { value: 1, max: 1 }, shield: { value: 0, max: 1 }, phase: 1, phaseName: "", layer: "", phases: 3 } }))).toEqual(["boss"]);
  });

  it("warns once when shield / hull cross their thresholds, and on death", () => {
    const base = hud();
    expect(tipsForHud(base, hud({ shield: { value: 100, max: 800 } }))).toEqual(["shield_low"]);
    const lowShield = hud({ shield: { value: 100, max: 800 } });
    expect(tipsForHud(lowShield, hud({ shield: { value: 50, max: 800 } }))).toEqual([]);
    expect(tipsForHud(lowShield, hud({ shield: { value: 0, max: 800 }, hull: { value: 300, max: 1000 } }))).toEqual(["hull_low"]);
    expect(tipsForHud(base, hud({ dead: { repairCost: 50, respawnAt: null, killer: "Corsair" }, hull: { value: 0, max: 1000 } }))).toEqual(["death"]);
  });

  it("maps zone changes to the matching zone tip", () => {
    expect(tipsForHud(hud({ zone: "SAFE" }), hud({ zone: "NEUTRAL" }))).toEqual(["zone_open"]);
    expect(tipsForHud(hud({ zone: "SAFE" }), hud({ zone: "PVP" }))).toEqual(["zone_danger"]);
    expect(tipsForHud(hud({ zone: "PVP" }), hud({ zone: "BOSS" }))).toEqual(["zone_boss"]);
    expect(zoneTip("PIRATE")).toBe("zone_danger");
    expect(zoneTip("HIGH_RISK")).toBe("zone_danger");
    expect(zoneTip("MINING")).toBe("zone_open");
    expect(zoneTip("GATE")).toBe("zone_boss");
    expect(zoneTip(null)).toBeNull();
    expect(zoneTip("SOMETHING_NEW")).toBeNull();
  });
});

describe("tipsForEvent", () => {
  it("maps HUD events to tips", () => {
    expect(tipsForEvent({ type: "levelup", level: 4 })).toEqual(["level_up"]);
    expect(tipsForEvent({ type: "boss_phase", name: "Titan", phase: 2 })).toEqual(["boss"]);
    expect(tipsForEvent({ type: "jump", mapId: "m", phase: "end" })).toEqual(["jumped"]);
    expect(tipsForEvent({ type: "jump", mapId: "m", phase: "start" })).toEqual([]);
    expect(tipsForEvent({ type: "chat", channel: "SECTOR", from: "a", text: "hi", at: 0 })).toEqual(["chat"]);
    expect(tipsForEvent({ type: "hit", incoming: true, crit: false })).toEqual([]);
  });
});

describe("queue", () => {
  it("dedupes, skips seen / current tips and orders by priority (stable)", () => {
    const seen = new Set<GameTipId>(["move"]);
    const q = enqueueTips([], ["welcome", "move", "fire", "welcome", "chat", "death"], (id) => seen.has(id), "fire");
    expect(q).toEqual(["death", "welcome", "chat"]);
    expect(enqueueTips(q, ["loot", "dock"], never)).toEqual(["death", "welcome", "loot", "dock", "chat"]);
  });

  it("drops stale situational tips and waits while dead / docked", () => {
    const docked = hud({ docked: { stationId: "s", name: "X", services: [] } });
    expect(tipStatus("loot", hud())).toBe("drop");
    expect(tipStatus("death", hud())).toBe("drop");
    expect(tipStatus("radar", docked)).toBe("wait");
    expect(tipStatus("station", docked)).toBe("show");
    expect(tipStatus("level_up", docked)).toBe("show");
    const dead = hud({ dead: { repairCost: 0, respawnAt: null, killer: null } });
    expect(tipStatus("death", dead)).toBe("show");
    expect(tipStatus("fire", dead)).toBe("wait");
    expect(takeNextTip(["loot", "radar", "chat"], hud())).toEqual({ tip: "radar", rest: ["chat"] });
    expect(takeNextTip(["radar", "death"], dead)).toEqual({ tip: "death", rest: ["radar"] });
  });

  it("lets only danger warnings interrupt the current tip", () => {
    expect(preempts("death", "radar")).toBe(true);
    expect(preempts("hull_low", "welcome")).toBe(true);
    expect(preempts("loot", "radar")).toBe(false);
    expect(preempts("shield_low", "death")).toBe(false);
  });

  it("gives every tip a readable on-screen time", () => {
    expect(tipDurationMs("short")).toBe(5000);
    expect(tipDurationMs(Array.from({ length: 200 }, () => "word").join(" "))).toBe(14000);
    for (const id of GAME_TIP_IDS) {
      const ms = tipDurationMs(plainTip(EN[tipText(id, false).body]));
      expect(ms).toBeGreaterThanOrEqual(5000);
      expect(ms).toBeLessThanOrEqual(14000);
    }
  });
});

describe("tutorial content", () => {
  it("has EN + TR texts for every tip, page and briefing step (desktop and touch)", () => {
    const keys = [
      ...GAME_TIP_IDS.flatMap((id) => [GAME_TIPS[id].title, GAME_TIPS[id].body, ...(GAME_TIPS[id].touch ? [GAME_TIPS[id].touch] : [])]),
      ...Object.values(PAGE_TIPS).flatMap((p) => [p.title, p.body, ...(p.demoNote ? [p.demoNote] : [])]),
      ...BRIEFING_STEPS.flatMap((s) => [s.title, s.body, ...(s.demoNote ? [s.demoNote] : [])]),
    ];
    const missing = keys.filter((k) => typeof EN[k as keyof typeof EN] !== "string" || typeof TR[k as keyof typeof TR] !== "string");
    expect(missing).toEqual([]);
  });

  it("uses the same key caps in EN and TR, only real game keys on desktop", () => {
    const caps = (s: string): string[] => parseTip(s).filter((x) => x.key).map((x) => x.text);
    const ALLOWED = new Set(["W", "A", "S", "D", "Q", "E", "F", "M", "R", "1", "2", "3", "Tab", "Esc", "Space", "Shift", "Enter"]);
    for (const id of GAME_TIP_IDS) {
      const k = GAME_TIPS[id].body;
      expect(caps(EN[k]).length, id).toBe(caps(TR[k]).length);
      expect(caps(EN[k]).filter((c) => !ALLOWED.has(c)), id).toEqual([]);
    }
  });

  it("matches every main shell page, including nested routes", () => {
    for (const p of ["/home", "/hangar", "/ships", "/inventory", "/weapons", "/modules", "/drones", "/missions", "/crafting", "/galaxy", "/clan", "/market", "/auction", "/leaderboard", "/season", "/battle-pass", "/events", "/shop", "/wallet", "/profile", "/friends", "/mail", "/notifications", "/settings"]) {
      expect(pageTipFor(p), p).not.toBeNull();
    }
    expect(pageTipFor("/clan/abc")?.id).toBe("clan");
    expect(pageTipFor("/wallet/deposit")?.id).toBe("wallet");
    expect(pageTipFor("/play")).toBeNull();
    expect(pageTipFor("/")).toBeNull();
    expect(pageTipFor("/constructor")).toBeNull();
  });

  it("includes the tester-kit step only in the demo briefing", () => {
    expect(briefingSteps(true).some((s) => s.id === "demo")).toBe(true);
    expect(briefingSteps(false).some((s) => s.id === "demo")).toBe(false);
    expect(briefingSteps(false).at(-1)?.id).toBe("ready");
  });

  it("stores game tips under a namespaced key", () => {
    expect(gameTipKey("fire")).toBe("game:fire");
  });
});
