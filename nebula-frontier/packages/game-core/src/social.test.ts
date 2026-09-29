import { describe, expect, it } from "vitest";
import { FACTIONS, PETS_BY_ID, PROGRESSION, SHIPS_BY_ID } from "@nebula/config";
import { clampKarma, decayKarma, factionWarPoints, petBuff, petLevelForXp, petXpToNext, reputationFor, starterPetFor } from "./social.js";
import { computeStats } from "./stats.js";

const rep = PROGRESSION.reputation!;

describe("reputation", () => {
  it("status thresholds with OUTLAW > BOUNTY_TARGET > HOSTILE > FRIENDLY > NEUTRAL", () => {
    expect(reputationFor(0, false, rep)).toBe("NEUTRAL");
    expect(reputationFor(rep.friendlyKarma, false, rep)).toBe("FRIENDLY");
    expect(reputationFor(rep.hostileKarma, false, rep)).toBe("HOSTILE");
    expect(reputationFor(rep.outlawKarma, true, rep)).toBe("OUTLAW");
    expect(reputationFor(0, true, rep)).toBe("BOUNTY_TARGET");
    expect(clampKarma(1e9, rep)).toBe(rep.maxKarma);
  });
  it("karma decays toward neutral without overshooting", () => {
    expect(decayKarma(-100, 3600, rep)).toBe(-100 + rep.decayPerHour);
    expect(decayKarma(5, 3600 * 100, rep)).toBe(0);
    expect(decayKarma(-5, 3600 * 100, rep)).toBe(0);
  });
});

describe("pets", () => {
  const glimmer = PETS_BY_ID.get("pet_glimmer")!;
  it("linear level curve capped at maxLevel", () => {
    const per = glimmer.xpPerLevel!;
    expect(petLevelForXp(0, glimmer)).toBe(1);
    expect(petLevelForXp(per, glimmer)).toBe(2);
    expect(petXpToNext(per - 1, glimmer)).toBe(1);
    expect(petLevelForXp(1e9, glimmer)).toBe(glimmer.maxLevel);
  });
  it("buff scales with level and feeds computeStats; every faction has a starter pet", () => {
    expect(petBuff(glimmer, 1).miningSpeed).toBe(glimmer.buff.miningSpeed);
    expect(petBuff(glimmer, 11).miningSpeed!).toBeGreaterThan(glimmer.buff.miningSpeed!);
    const base = { ship: SHIPS_BY_ID.get("ship_aurora_lumen")!, shipUpgradeLevel: 0, lasers: [], missiles: [], generators: [], modules: [], drones: [], progression: PROGRESSION };
    expect(computeStats({ ...base, petBuff: petBuff(glimmer, 1) }).pct.miningSpeed - computeStats(base).pct.miningSpeed).toBeCloseTo(glimmer.buff.miningSpeed!, 5);
    for (const f of FACTIONS) expect(PETS_BY_ID.has(starterPetFor(f)!)).toBe(true);
  });
});

describe("faction war", () => {
  it("points from events", () => {
    const w = PROGRESSION.factionWar!;
    expect(factionWarPoints({ npcKills: 2, pvpKills: 1, resources: 300, bossKills: 1 }, w)).toBe(Math.floor(2 * w.npcKillPoints + w.pvpKillPoints + 3 * w.resourcePointsPer100 + w.bossKillPoints));
  });
});
