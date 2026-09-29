import { describe, expect, it } from "vitest";
import { metricProgress, parseBaseline, reconcileBaseline, type StatRow } from "./clanMissions.js";

const zero: StatRow = { npcKills: 0n, playerKills: 0n, pvpWins: 0n, gatesCompleted: 0n, resourcesMined: 0n, itemsCrafted: 0n, bossDamage: 0n };
const stats = (over: Partial<StatRow>): StatRow => ({ ...zero, ...over });
const start = new Date("2026-01-10T00:00:00Z");

describe("clan mission baselines", () => {
  it("re-baselines a member who left and rejoined (joinedAt changed) instead of counting pre-join stats", () => {
    const firstJoin = new Date("2026-01-01T00:00:00Z");
    const members = new Map([["u1", { joinedAt: firstJoin, stats: stats({ npcKills: 10n }) }]]);
    const baseline = parseBaseline({});
    expect(reconcileBaseline(baseline, members, start)).toBe(true);
    expect(reconcileBaseline(baseline, members, start)).toBe(false); // stable for the same membership

    // Member leaves, grinds 500 kills outside the clan, and rejoins.
    const rejoined = new Map([["u1", { joinedAt: new Date("2026-01-12T00:00:00Z"), stats: stats({ npcKills: 510n }) }]]);
    expect(reconcileBaseline(baseline, rejoined, start)).toBe(true);
    expect(baseline.get("u1")?.stats.npcKills).toBe(510n);
    expect(metricProgress("npcKills", rejoined, baseline, 1000)).toBe(0);

    rejoined.set("u1", { joinedAt: new Date("2026-01-12T00:00:00Z"), stats: stats({ npcKills: 515n }) });
    expect(metricProgress("npcKills", rejoined, baseline, 1000)).toBe(5);
  });

  it("reads legacy flat entries: kept when the membership predates the mission, reset otherwise", () => {
    const baseline = parseBaseline({ old: { npcKills: 3 }, rejoin: { npcKills: 3 } });
    const members = new Map([
      ["old", { joinedAt: new Date("2026-01-01T00:00:00Z"), stats: stats({ npcKills: 8n }) }],
      ["rejoin", { joinedAt: new Date("2026-01-11T00:00:00Z"), stats: stats({ npcKills: 50n }) }],
    ]);
    expect(reconcileBaseline(baseline, members, start)).toBe(true);
    expect(baseline.get("old")).toEqual({ joinedAt: "2026-01-01T00:00:00.000Z", stats: stats({ npcKills: 3n }) });
    expect(baseline.get("rejoin")?.stats.npcKills).toBe(50n);
    expect(metricProgress("npcKills", members, baseline, 1000)).toBe(5);
  });

  it("round-trips the new { joinedAt, stats } format with exact bigint strings", () => {
    const b = parseBaseline({ u: { joinedAt: "2026-01-01T00:00:00.000Z", stats: { resourcesMined: "9007199254740993", bossDamage: "1" } } });
    expect(b.get("u")?.stats.resourcesMined).toBe(9_007_199_254_740_993n);
    expect(b.get("u")?.joinedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("computes bigint deltas exactly and clamps to the objective count before converting to number", () => {
    const joinedAt = new Date("2026-01-01T00:00:00Z");
    const base = 2n ** 60n;
    const baseline = parseBaseline({});
    reconcileBaseline(baseline, new Map([["u", { joinedAt, stats: stats({ resourcesMined: base, bossDamage: base }) }]]), start);
    // Deltas smaller than float precision at this magnitude are still counted exactly.
    const small = new Map([["u", { joinedAt, stats: stats({ resourcesMined: base + 3n }) }]]);
    expect(metricProgress("resourcesMined", small, baseline, 100)).toBe(3);
    const huge = new Map([["u", { joinedAt, stats: stats({ bossDamage: base * 4n }) }]]);
    expect(metricProgress("bossDamage", huge, baseline, 250)).toBe(250);
    // Stats going down (e.g. admin reset) never produce negative progress.
    const lower = new Map([["u", { joinedAt, stats: stats({ resourcesMined: 1n }) }]]);
    expect(metricProgress("resourcesMined", lower, baseline, 100)).toBe(0);
  });
});
