/** Faction standings are read-only; territory sync is a separate idempotent job. */
import type { Db } from "@nebula/database";
import { FACTIONS } from "@nebula/config";
import { describe, expect, it } from "vitest";
import { factionWarStandings, syncFactionTerritory } from "./factionWar.js";

const [f1, f2] = FACTIONS;

function fakeDb() {
  const writes: { id: string; territory: number }[] = [];
  const factions = FACTIONS.map((f) => ({ id: f.id, territory: 0, score: 0n, kills: 0n, pvpScore: 0n, resources: 0n, bossKills: 0 }));
  const db = {
    clanTerritory: {
      findMany: async () => [
        { clan: { factionId: f1?.id ?? null } },
        { clan: { factionId: f1?.id ?? null } },
        { clan: { factionId: null } },
      ],
    },
    faction: {
      findMany: async () => factions.map((f) => ({ ...f })),
      async updateMany({ where, data }: { where: { id: string }; data: { territory: number } }) {
        writes.push({ id: where.id, territory: data.territory });
        const row = factions.find((f) => f.id === where.id);
        if (row) row.territory = data.territory;
        return { count: 1 };
      },
      update: async () => {
        throw new Error("standings must not write");
      },
    },
    season: { findFirst: async () => null },
    factionSeasonScore: { findMany: async () => [] },
  };
  return { db: db as unknown as Db, writes, factions };
}

describe("faction war", () => {
  it("syncFactionTerritory writes only changed rows and is idempotent", async () => {
    const { db, writes } = fakeDb();
    expect(await syncFactionTerritory(db)).toBe(1);
    expect(writes).toEqual([{ id: f1?.id, territory: 2 }]);
    expect(await syncFactionTerritory(db)).toBe(0);
    expect(writes).toHaveLength(1);
  });

  it("factionWarStandings computes live territory without writing", async () => {
    const { db, writes } = fakeDb();
    const res = await factionWarStandings(db);
    expect(writes).toHaveLength(0);
    const s1 = res.allTime.find((s) => s.factionId === f1?.id);
    expect(s1?.territory).toBe(2);
    expect(res.allTime.find((s) => s.factionId === f2?.id)?.territory).toBe(0);
  });
});
