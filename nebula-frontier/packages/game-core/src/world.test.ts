import { describe, expect, it } from "vitest";
import { mulberry32 } from "@nebula/shared";
import { EVENTS_BY_ID, MAPS_BY_ID, NPCS_BY_ID, QUESTS, BLUEPRINTS, ACHIEVEMENTS } from "@nebula/config";
import { bossPhaseIndex, bossTick, createBrain, stepNpcBrain, type NpcBrain, type NpcContext } from "./npc-ai.js";
import { applyQuestEvent, newlyUnlockedAchievements, questPeriodKey } from "./quests.js";
import { eloUpdate, formMatches, teamRatingDeltas, type QueueTicket } from "./matchmaking.js";
import { activeEventWindow, contributionTier, nextEventWindow } from "./events.js";
import { isPvpAllowedAt, isSafeAt, spawnPoint, zoneTypeAt } from "./zones.js";
import { craftCost, validateCraft } from "./crafting.js";
import { mineStep, type AsteroidState } from "./mining.js";
import { SpatialGrid } from "./spatial.js";

const raider = NPCS_BY_ID.get("npc_pirate_raider")!;
function ctx(p: Partial<NpcContext>): NpcContext {
  return { now: 0, x: 0, y: 0, hullFraction: 1, def: raider, visible: [], attackers: [], allyAttacker: null, rng: mulberry32(1), ...p };
}

describe("npc ai", () => {
  it("aggressive npc aggroes, attacks in range, searches when target lost, retreats", () => {
    let b = createBrain(0, 0, 20, 0);
    let d = stepNpcBrain(b, ctx({ visible: [{ id: "p1", x: raider.aggroRange - 1, y: 0 }] }));
    expect(d.brain.state).toBe("AGGRO");
    b = d.brain;
    d = stepNpcBrain(b, ctx({ now: 100, visible: [{ id: "p1", x: raider.range - 1, y: 0 }] }));
    expect(d.brain.state).toBe("ATTACK");
    expect(d.fireAt).toBe("p1");
    d = stepNpcBrain(d.brain, ctx({ now: 200, visible: [] }));
    expect(d.brain.state).toBe("SEARCH");
    d = stepNpcBrain(d.brain, ctx({ now: 6000, visible: [] }));
    expect(d.brain.state).toBe("RETREAT");
  });

  it("coward flees at low hull; passive flees when attacked", () => {
    const scout = NPCS_BY_ID.get("npc_xyrr_scout")!;
    const d = stepNpcBrain({ ...createBrain(0, 0, 20, 0), state: "ATTACK", targetId: "p1" }, ctx({ def: scout, hullFraction: scout.fleeHullPercent - 0.01, visible: [{ id: "p1", x: 5, y: 0 }], attackers: ["p1"] }));
    expect(d.brain.state).toBe("FLEE");
    const drone = NPCS_BY_ID.get("npc_mining_drone")!;
    const p = stepNpcBrain(createBrain(0, 0, 20, 0), ctx({ def: drone, visible: [{ id: "p1", x: 5, y: 0 }], attackers: ["p1"] }));
    expect(p.brain.state).toBe("FLEE");
  });

  it("swarm assists allies under attack", () => {
    const sw = NPCS_BY_ID.get("npc_leviathan_spawnling")!;
    const d = stepNpcBrain(createBrain(0, 0, 20, 0), ctx({ def: { ...sw, aggroRange: 1 }, allyAttacker: { id: "p9", x: 50, y: 0 } }));
    expect(d.brain.state).toBe("ASSIST");
  });

  it("leash: returns home when dragged too far", () => {
    const d = stepNpcBrain({ ...createBrain(0, 0, 20, 0), state: "AGGRO", targetId: "p1" }, ctx({ x: 5000, y: 0, visible: [{ id: "p1", x: 5010, y: 0 }] }));
    expect(d.brain.state).toBe("RETREAT");
  });

  it("boss phases, specials, adds and enrage", () => {
    const boss = NPCS_BY_ID.get("boss_vanta_colossus")!;
    const phases = boss.phases!;
    expect(bossPhaseIndex(phases, 1)).toBe(0);
    expect(bossPhaseIndex(phases, 0.7)).toBe(1);
    expect(bossPhaseIndex(phases, 0.4)).toBe(2);
    expect(bossPhaseIndex(phases, 0.1)).toBe(3);
    let brain: NpcBrain = { ...createBrain(0, 0, 10, 0), state: "ATTACK", engagedAt: 0 };
    const t1 = bossTick(brain, phases, 1, phases[0]!.specialAttack!.everyMs);
    expect(t1.special?.name).toBe(phases[0]!.specialAttack!.name);
    brain = t1.brain;
    const t2 = bossTick(brain, phases, 0.1, 50_000);
    expect(t2.phaseChanged).toBe(true);
    expect(t2.enragedNow).toBe(true);
    expect(t2.damageMultiplier).toBe(phases[3]!.damageMultiplier);
    const t3 = bossTick(t2.brain, phases, 0.1, 50_000 + phases[3]!.adds!.everyMs);
    expect(t3.adds).toEqual({ npcId: phases[3]!.adds!.npcId, count: phases[3]!.adds!.count });
  });
});

describe("quests & achievements", () => {
  it("kill objective progresses and completes", () => {
    const q = QUESTS.find((x) => x.id === "q_main_1_1")!;
    let prog: number[] = [];
    let done = false;
    for (let i = 0; i < q.objectives[0]!.count; i++) {
      const r = applyQuestEvent(q, prog, { type: "KILL", npcId: "npc_mining_drone", boss: false, mapId: "map_aurora_prime" });
      prog = r.progress;
      done = r.completed;
    }
    expect(done).toBe(true);
    const other = applyQuestEvent(q, [0], { type: "KILL", npcId: "npc_pirate_raider", boss: false, mapId: "x" });
    expect(other.changed).toBe(false);
  });
  it("achievements unlock by metric", () => {
    const got = newlyUnlockedAchievements(ACHIEVEMENTS, { npc_kills: 100 }, new Set(["ach_first_kill"]));
    expect(got.map((a) => a.id)).toContain("ach_100_kills");
    expect(got.map((a) => a.id)).not.toContain("ach_first_kill");
  });
  it("period keys", () => {
    expect(questPeriodKey("DAILY", new Date("2026-09-28T10:00:00Z"))).toBe("2026-09-28");
    expect(questPeriodKey("MAIN_STORY", new Date())).toBe("once");
  });
});

describe("matchmaking", () => {
  it("elo is zero-sum and favours the underdog", () => {
    const u = eloUpdate(1200, 1600, 1);
    expect(u.deltaA + u.deltaB).toBe(0);
    expect(u.deltaA).toBeGreaterThan(16);
    const d = teamRatingDeltas([[{ userId: "a", rating: 1200, matches: 100 }], [{ userId: "b", rating: 1200, matches: 100 }]], 0);
    expect(d.get("a")).toBeGreaterThan(0);
    expect(d.get("b")).toBeLessThan(0);
  });
  it("forms balanced matches by region and keeps parties together", () => {
    const now = 100_000;
    const t = (id: string, rating: number, region = "EU", partyId: string | null = null): QueueTicket => ({ userId: id, rating, level: 20, gearScore: 1000, region, latencyMs: 40, partyId, enqueuedAt: now - 1000 });
    const tickets = [t("a", 1200, "EU", "P"), t("b", 1210, "EU", "P"), t("c", 1190), t("d", 1205), t("e", 1500, "NA"), t("f", 1195)];
    const r = formMatches(tickets, now, { teamSize: 2, teams: 2, baseRatingSpread: 100, ratingSpreadPerSec: 1, maxRatingSpread: 300, maxLevelSpread: 10, maxGearSpreadRatio: 0.5, maxLatencyMs: 150 });
    expect(r.matches.length).toBe(1);
    const m = r.matches[0]!;
    const teamOfA = m.teams.findIndex((team) => team.some((p) => p.userId === "a"));
    expect(m.teams[teamOfA]!.some((p) => p.userId === "b")).toBe(true);
    expect(r.remaining.map((x) => x.userId)).toContain("e");
  });
});

describe("events, zones, crafting, mining, spatial", () => {
  it("recurring event windows", () => {
    const ev = EVENTS_BY_ID.get("evt_void_rift")!;
    const start = Date.parse(ev.startAt);
    expect(activeEventWindow(ev, start + 10 * 60_000)).not.toBeNull();
    expect(activeEventWindow(ev, start + 2 * 3_600_000)).toBeNull();
    const n = nextEventWindow(ev, start + 2 * 3_600_000)!;
    expect(n.start).toBe(start + ev.recurrence!.everyHours * 3_600_000);
    expect(contributionTier(ev, 70)?.tier).toBe("GOLD");
    expect(contributionTier(ev, 0)).toBeNull();
  });
  it("zones", () => {
    const m = MAPS_BY_ID.get("map_aurora_prime")!;
    const safe = m.zones.find((z) => z.type === "SAFE")!;
    expect(isSafeAt(m, safe.x, safe.y)).toBe(true);
    expect(zoneTypeAt(m, safe.x, safe.y)).toBe("SAFE");
    expect(isPvpAllowedAt(m, safe.x, safe.y)).toBe(false);
    expect(isPvpAllowedAt(MAPS_BY_ID.get("map_eclipse_arena")!, 250, 200)).toBe(true);
    const sp = spawnPoint(m, "aurora");
    expect(isSafeAt(m, sp.x, sp.y)).toBe(true);
  });
  it("crafting validation", () => {
    const bp = BLUEPRINTS[0]!;
    const cost = craftCost(bp, 2);
    expect(cost.credits).toBe(bp.credits * 2);
    expect(validateCraft(bp, { level: 1, credits: 0, resources: {}, items: {} }, 1).ok).toBe(false);
    expect(validateCraft(bp, { level: 99, credits: 1e9, resources: Object.fromEntries(Object.entries(bp.resources).map(([k, v]) => [k, (v ?? 0) * 10])), items: Object.fromEntries((bp.items ?? []).map((i) => [i.itemId, 99])) }, 1).ok).toBe(true);
  });
  it("mining yield bounded by asteroid and cargo", () => {
    let a: AsteroidState = { resource: "TITANIUM", amount: 10, progress: 0 };
    let total = 0;
    for (let i = 0; i < 100; i++) {
      const r = mineStep(a, 24, 0, 0.5, 1000, 8);
      a = r.asteroid;
      total += r.extracted;
    }
    expect(total).toBe(10);
    expect(mineStep({ resource: "TITANIUM", amount: 10, progress: 0 }, 100, 0, 10, 3, 1).extracted).toBe(3);
  });
  it("spatial grid", () => {
    const g = new SpatialGrid<{ id: string; x: number; y: number }>(50);
    g.rebuild([{ id: "a", x: 0, y: 0 }, { id: "b", x: 30, y: 0 }, { id: "c", x: 300, y: 0 }]);
    expect(g.query(0, 0, 40).map((e) => e.id).sort()).toEqual(["a", "b"]);
  });
});
