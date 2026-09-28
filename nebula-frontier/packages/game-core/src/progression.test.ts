import { describe, expect, it } from "vitest";
import { mulberry32 } from "@nebula/shared";
import { LOOT_TABLES_BY_ID, ITEM_AFFIXES, ITEMS, PROGRESSION } from "@nebula/config";
import { toMoney } from "./money.js";
import { deathRepairCost, grantXp, levelForXp, levelProgress, rankFor, rollUpgrade, upgradeCost, xpForLevel, applyPrestige } from "./progression.js";
import { clampAffixes, rollAffixes, rollLoot } from "./loot.js";

describe("xp curve", () => {
  it("matches the progression.json closed form", () => {
    expect(xpForLevel(1, PROGRESSION)).toBe(0);
    expect(xpForLevel(2, PROGRESSION)).toBe(PROGRESSION.xpBase);
    expect(xpForLevel(10, PROGRESSION)).toBe(Math.round(PROGRESSION.xpBase * Math.pow(9, PROGRESSION.xpExponent)));
  });

  it("is strictly increasing and invertible", () => {
    for (let l = 1; l < PROGRESSION.maxLevel; l++) {
      expect(xpForLevel(l + 1, PROGRESSION)).toBeGreaterThan(xpForLevel(l, PROGRESSION));
      expect(levelForXp(xpForLevel(l, PROGRESSION), PROGRESSION)).toBe(l);
      expect(levelForXp(xpForLevel(l + 1, PROGRESSION) - 1, PROGRESSION)).toBe(l);
    }
    expect(levelForXp(1e15, PROGRESSION)).toBe(PROGRESSION.maxLevel);
    expect(levelForXp(-5, PROGRESSION)).toBe(1);
  });

  it("grantXp reports every level gained", () => {
    const g = grantXp(0, xpForLevel(4, PROGRESSION), PROGRESSION);
    expect(g.levelsGained).toEqual([2, 3, 4]);
    expect(levelProgress(g.xpAfter, PROGRESSION).level).toBe(4);
  });

  it("ranks need honor and level", () => {
    expect(rankFor(0, 1, PROGRESSION).id).toBe("rank_cadet");
    expect(rankFor(1_000_000, 2, PROGRESSION).id).toBe("rank_cadet");
    expect(rankFor(1_000_000, 50, PROGRESSION).id).toBe("rank_nebula_sovereign");
  });

  it("prestige only at max level", () => {
    expect(() => applyPrestige({ level: 10, xp: 0, prestige: 0 }, PROGRESSION)).toThrow();
    expect(applyPrestige({ level: 50, xp: 1, prestige: 0 }, PROGRESSION)).toEqual({ level: 1, xp: 0, prestige: 1 });
  });
});

describe("upgrades & repair", () => {
  it("cost grows and success decays; gems from configured level", () => {
    const c0 = upgradeCost(0, PROGRESSION);
    const c10 = upgradeCost(10, PROGRESSION);
    expect(c10.credits).toBeGreaterThan(c0.credits);
    expect(c10.successChance).toBeLessThan(c0.successChance);
    expect(c0.gems).toBe(0n);
    expect(typeof c0.credits).toBe("bigint");
    expect(upgradeCost(PROGRESSION.upgrade.gemsFromLevel - 1, PROGRESSION).gems).toBe(BigInt(PROGRESSION.upgrade.gemsPerLevel));
    expect(() => upgradeCost(PROGRESSION.upgrade.maxLevel, PROGRESSION)).toThrow();
    expect(rollUpgrade(0, PROGRESSION, () => 0.5).success).toBe(true);
  });
  it("death repair", () => {
    expect(deathRepairCost(1000, PROGRESSION)).toBe(BigInt(Math.round(1000 * PROGRESSION.repair.deathRepairPercent * PROGRESSION.repair.creditsPerHullPoint)));
  });
  it("toMoney: one rounding rule, rejects invalid amounts", () => {
    expect(toMoney(1.5)).toBe(2n);
    expect(toMoney(1.49)).toBe(1n);
    expect(toMoney(0)).toBe(0n);
    expect(() => toMoney(Number.NaN)).toThrow();
    expect(() => toMoney(Infinity)).toThrow();
    expect(() => toMoney(-1)).toThrow();
  });
});

describe("loot determinism", () => {
  const table = LOOT_TABLES_BY_ID.get("loot_t2")!;
  it("same seed → same drops; different seed → (almost surely) different", () => {
    const a = Array.from({ length: 50 }, (_, i) => rollLoot(table, mulberry32(1000 + i)));
    const b = Array.from({ length: 50 }, (_, i) => rollLoot(table, mulberry32(1000 + i)));
    expect(a).toEqual(b);
    const c = Array.from({ length: 50 }, (_, i) => rollLoot(table, mulberry32(9000 + i)));
    expect(c).not.toEqual(a);
  });

  it("drop multiplier reduces empty rolls", () => {
    const rng1 = mulberry32(7);
    const rng2 = mulberry32(7);
    let base = 0;
    let boosted = 0;
    for (let i = 0; i < 2000; i++) {
      base += rollLoot(table, rng1).length;
      boosted += rollLoot(table, rng2, { dropMultiplier: 3 }).length;
    }
    expect(boosted).toBeGreaterThan(base);
  });

  it("quantities within entry bounds and refs from the table", () => {
    const rng = mulberry32(3);
    for (let i = 0; i < 500; i++) {
      for (const d of rollLoot(table, rng)) {
        const e = table.entries.find((x) => x.kind === d.kind && x.ref === d.ref)!;
        expect(e).toBeDefined();
        expect(d.quantity).toBeGreaterThanOrEqual(e.min);
        expect(d.quantity).toBeLessThanOrEqual(e.max * table.rolls);
      }
    }
  });

  it("affixes respect caps and count by rarity", () => {
    const item = ITEMS.find((i) => i.category === "WEAPON" && i.powerItem && i.rarity === "EPIC") ?? ITEMS.find((i) => i.category === "WEAPON" && i.powerItem)!;
    const rng = mulberry32(5);
    for (let i = 0; i < 300; i++) {
      const aff = rollAffixes(item, ITEM_AFFIXES, rng, "LEGENDARY");
      expect(aff.length).toBeLessThanOrEqual(4);
      const totals = new Map<string, number>();
      for (const a of aff) totals.set(a.stat, (totals.get(a.stat) ?? 0) + a.value);
      for (const [stat, v] of totals) {
        const cap = ITEM_AFFIXES.find((x) => x.stat === stat)!.cap;
        if (cap < 0) expect(v).toBeGreaterThanOrEqual(cap);
        else expect(v).toBeLessThanOrEqual(cap);
      }
    }
    expect(rollAffixes({ ...item, powerItem: false }, ITEM_AFFIXES, rng)).toEqual([]);
    expect(clampAffixes([{ stat: "damage", value: 999 }, { stat: "bogus", value: 5 }], ITEM_AFFIXES)).toEqual([{ id: "affix_damage", stat: "damage", value: 15 }]);
  });
});
