import { describe, expect, it } from "vitest";
import { qualifyContributors, raidCryptoWeight, raidRewardScale } from "./contribution.js";

const MIN_SHARE = 0.005;

describe("raid contribution qualification", () => {
  it("a low-damage alt increases neither the raid reward scale nor the crypto weight", () => {
    const mains = [{ id: "a", dmg: 50_000 }, { id: "b", dmg: 50_000 }];
    const withAlt = [...mains, { id: "alt", dmg: 1 }];
    const raidSize = 4;
    const minPilots = 2;

    const base = qualifyContributors(mains, MIN_SHARE);
    const tagged = qualifyContributors(withAlt, MIN_SHARE);
    expect(tagged.qualified.map((c) => c.id)).toEqual(["a", "b"]);

    const scaleBase = raidRewardScale(base.qualified.length, raidSize, minPilots);
    const scaleTagged = raidRewardScale(tagged.qualified.length, raidSize, minPilots);
    expect(scaleBase).toBe(0.5);
    expect(scaleTagged).toBe(scaleBase); // raw contributor count (3) would have given 0.75

    const share = 50_000 / tagged.totalDmg;
    expect(raidCryptoWeight(share, tagged.qualified.length, scaleTagged)).toBeCloseTo(raidCryptoWeight(0.5, 2, scaleBase), 3);
  });

  it("an alt cannot unlock rewards for an under-manned raid", () => {
    const solo = qualifyContributors([{ dmg: 100_000 }, { dmg: 10 }], MIN_SHARE);
    expect(solo.qualified).toHaveLength(1);
    expect(raidRewardScale(solo.qualified.length, 8, 2)).toBe(0);
  });

  it("keeps everyone when no damage was recorded", () => {
    expect(qualifyContributors([{ dmg: 0 }, { dmg: 0 }], MIN_SHARE).qualified).toHaveLength(2);
  });
});
