/**
 * Reputation (profile), companions (pets) and faction war read endpoints.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { giveItem, registerUser, setup, teardown, type TestCtx } from "./helpers.js";

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => {
  await teardown(ctx);
});

describe("reputation in profile", () => {
  it("exposes reputation status and karma", async () => {
    const s = await registerUser(ctx.app);
    await ctx.db.user.update({ where: { id: s.userId }, data: { karma: -120, reputation: "OUTLAW" } });
    const p = (await ctx.app.inject({ method: "GET", url: `/api/profile/${s.userId}` })).json() as { reputation: string; karma: number };
    expect(p).toMatchObject({ reputation: "OUTLAW", karma: -120 });
  });
});

describe("pets", () => {
  it("choosing a faction grants the starter pet; owned pet items unlock companions; activation is exclusive", async () => {
    const s = await registerUser(ctx.app);
    expect((await s.req("POST", "/api/me/faction", { factionId: "aurora" })).statusCode).toBe(200);
    const first = (await s.req("GET", "/api/pets")).json() as { pets: { id: string; petId: string; active: boolean; level: number }[] };
    expect(first.pets).toHaveLength(1);
    expect(first.pets[0]).toMatchObject({ petId: "pet_glimmer", active: true, level: 1 });
    await giveItem(ctx.db, s.userId, "item_pet_ferrox");
    const second = (await s.req("GET", "/api/pets")).json() as { pets: { id: string; petId: string; active: boolean }[] };
    expect(second.pets.map((p) => p.petId).sort()).toEqual(["pet_ferrox", "pet_glimmer"]);
    expect(second.pets.find((p) => p.petId === "pet_ferrox")!.active).toBe(false);
    // Idempotent sync.
    expect(((await s.req("GET", "/api/pets")).json() as { pets: unknown[] }).pets).toHaveLength(2);
    const ferrox = second.pets.find((p) => p.petId === "pet_ferrox")!;
    const act = (await s.req("POST", `/api/pets/${ferrox.id}/activate`)).json() as { pets: { petId: string; active: boolean }[] };
    expect(act.pets.filter((p) => p.active).map((p) => p.petId)).toEqual(["pet_ferrox"]);
    const other = await registerUser(ctx.app);
    expect((await other.req("POST", `/api/pets/${ferrox.id}/activate`)).statusCode).toBe(404);
  });
});

describe("faction war", () => {
  it("serves standings with breakdown and the seasonal faction leaderboard", async () => {
    const r = await ctx.app.inject({ method: "GET", url: "/api/factions/war" });
    expect(r.statusCode).toBe(200);
    const war = r.json() as { season: { factionId: string; score: string; territory: number; kills: string }[]; allTime: unknown[]; weights: Record<string, number> };
    expect(war.season.map((f) => f.factionId).sort()).toEqual(["aurora", "nova", "vortex"]);
    expect(war.weights.bossKillPoints).toBeGreaterThan(0);
    const lb = (await ctx.app.inject({ method: "GET", url: "/api/leaderboard?board=faction&limit=3" })).json() as { entries: { faction: string; score: number }[] };
    expect(lb.entries).toHaveLength(3);
    expect(lb.entries[0]!.score).toBeGreaterThanOrEqual(lb.entries[2]!.score);
  });
});
