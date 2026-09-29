/**
 * CLAN-03 clan battle station: building the station and upgrading its modules is paid from the
 * clan treasury (never the member's wallet), gated by clan role, idempotent per level in the
 * ledger, and the resulting station state is publicly readable through GET /api/clans/:id.
 * (Stations are not simulated by the game server yet, so this covers the API only.)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { credits, fund, key, registerUser, setup, teardown, type Session, type TestCtx } from "./helpers.js";

let ctx: TestCtx;
let rules: { clanCreateCost: number; clanStationBuildCost: number; clanStationHull: number; clanStationShield: number; clanModuleBaseCost: number; clanModuleGrowth: number; clanModuleMaxLevel: number };

beforeAll(async () => {
  ctx = await setup();
  rules = ((await ctx.app.inject({ method: "GET", url: "/api/rules" })).json() as { rules: typeof rules }).rules;
});
afterAll(async () => {
  await teardown(ctx);
});

type Err = { error: { code: string } };
const code = (r: { json: () => unknown }) => (r.json() as Err).error.code;
type StationView = { id: string; mapId: string; level: number; hull: number; maxHull: number; shield: number; maxShield: number; modules: { kind: string; level: number }[] };
const bank = async (clanId: string) => (await ctx.db.clan.findUniqueOrThrow({ where: { id: clanId } })).bankCredits;
const moduleCost = (level: number) => BigInt(Math.round(rules.clanModuleBaseCost * Math.pow(rules.clanModuleGrowth, level - 1)));

async function makeClan(): Promise<{ leader: Session; member: Session; outsider: Session; clanId: string }> {
  const leader = await registerUser(ctx.app);
  const member = await registerUser(ctx.app);
  const outsider = await registerUser(ctx.app);
  await fund(ctx.db, leader.userId, BigInt(rules.clanCreateCost) + 10_000_000n);
  const tag = `S${Math.floor(Math.random() * 9000 + 1000)}`;
  const created = await leader.req("POST", "/api/clans", { name: `Station ${tag}`, tag });
  expect(created.statusCode, created.body).toBe(201);
  const clanId = (created.json() as { id: string }).id;
  expect((await leader.req("POST", `/api/clans/${clanId}/invite`, { userId: member.userId })).statusCode).toBe(200);
  expect((await member.req("POST", `/api/clans/${clanId}/join`)).statusCode).toBe(200);
  return { leader, member, outsider, clanId };
}

describe("CLAN-03 clan battle station", () => {
  it("builds a station from the treasury (leader only, one per clan, not on faction home maps)", async () => {
    const { leader, member, outsider, clanId } = await makeClan();
    const body = { mapId: "map_helios_frontier" };

    // Empty treasury: rejected even though the leader's own wallet could pay.
    const broke = await leader.req("POST", `/api/clans/${clanId}/station`, body);
    expect(broke.statusCode).toBe(400);
    expect(code(broke)).toBe("INSUFFICIENT_TREASURY");
    expect(await ctx.db.clanStation.count({ where: { clanId } })).toBe(0);

    const deposit = BigInt(rules.clanStationBuildCost) + 1_000_000n;
    expect((await leader.req("POST", `/api/clans/${clanId}/treasury/deposit`, { amount: deposit.toString(), idempotencyKey: key() })).statusCode).toBe(200);
    const walletBefore = await credits(ctx.db, leader.userId);

    // Permissions: recruits and outsiders cannot build; faction home maps are refused.
    const recruit = await member.req("POST", `/api/clans/${clanId}/station`, body);
    expect(recruit.statusCode).toBe(403);
    expect(code(recruit)).toBe("CLAN_ROLE");
    const stranger = await outsider.req("POST", `/api/clans/${clanId}/station`, body);
    expect(stranger.statusCode).toBe(403);
    expect(code(stranger)).toBe("NOT_CLAN_MEMBER");
    const home = await leader.req("POST", `/api/clans/${clanId}/station`, { mapId: "map_aurora_prime" });
    expect(home.statusCode).toBe(400);
    expect(code(home)).toBe("INVALID_MAP");
    expect(await bank(clanId)).toBe(deposit);

    const built = await leader.req("POST", `/api/clans/${clanId}/station`, body);
    expect(built.statusCode, built.body).toBe(201);
    const station = (built.json() as { station: StationView }).station;
    expect(station).toMatchObject({ mapId: "map_helios_frontier", level: 1, hull: rules.clanStationHull, maxHull: rules.clanStationHull, shield: rules.clanStationShield, maxShield: rules.clanStationShield });
    expect(await bank(clanId)).toBe(deposit - BigInt(rules.clanStationBuildCost));
    expect(await credits(ctx.db, leader.userId)).toBe(walletBefore); // paid by the clan, not the leader
    const sink = await ctx.db.balanceLedger.findUniqueOrThrow({ where: { idempotencyKey: `clanstation:${station.id}:build` }, include: { debitAccount: true, creditAccount: true } });
    expect(sink.amount).toBe(BigInt(rules.clanStationBuildCost));
    expect(sink.debitAccount.key).toBe("ESCROW:CREDITS");
    expect(sink.creditAccount.type).toBe("GAME_SINK");

    const again = await leader.req("POST", `/api/clans/${clanId}/station`, { mapId: "map_orion_belt" });
    expect(again.statusCode).toBe(409);
    expect(code(again)).toBe("STATION_EXISTS");
    expect(await ctx.db.clanStation.count({ where: { clanId } })).toBe(1);
  });

  it("upgrades modules with growing treasury costs (officer+), caps at max level and exposes the state", async () => {
    const { leader, member, outsider, clanId } = await makeClan();
    const noStation = await leader.req("POST", `/api/clans/${clanId}/station/modules/SHIELD_GRID/upgrade`);
    expect(noStation.statusCode).toBe(400);
    expect(code(noStation)).toBe("NO_STATION");

    const lvl1 = moduleCost(1), lvl2 = moduleCost(2);
    const deposit = BigInt(rules.clanStationBuildCost) + lvl1 + lvl2 + moduleCost(1);
    expect((await leader.req("POST", `/api/clans/${clanId}/treasury/deposit`, { amount: deposit.toString(), idempotencyKey: key() })).statusCode).toBe(200);
    expect((await leader.req("POST", `/api/clans/${clanId}/station`, { mapId: "map_orion_belt" })).statusCode).toBe(201);
    const afterBuild = await bank(clanId);

    // Recruits cannot spend clan funds on modules; unknown module kinds are rejected.
    const recruit = await member.req("POST", `/api/clans/${clanId}/station/modules/SHIELD_GRID/upgrade`);
    expect(recruit.statusCode).toBe(403);
    expect(code(recruit)).toBe("CLAN_ROLE");
    expect((await leader.req("POST", `/api/clans/${clanId}/station/modules/DEATH_RAY/upgrade`)).statusCode).toBe(400);

    expect((await leader.req("POST", `/api/clans/${clanId}/promote`, { userId: member.userId, role: "OFFICER" })).statusCode).toBe(200);
    const u1 = await member.req("POST", `/api/clans/${clanId}/station/modules/SHIELD_GRID/upgrade`);
    expect(u1.statusCode, u1.body).toBe(200);
    expect(u1.json()).toEqual({ kind: "SHIELD_GRID", level: 1, cost: lvl1.toString() });
    const u2 = await leader.req("POST", `/api/clans/${clanId}/station/modules/SHIELD_GRID/upgrade`);
    expect(u2.json()).toEqual({ kind: "SHIELD_GRID", level: 2, cost: lvl2.toString() });
    expect(lvl2).toBeGreaterThan(lvl1);
    expect((await leader.req("POST", `/api/clans/${clanId}/station/modules/RADAR/upgrade`)).statusCode).toBe(200);
    expect(await bank(clanId)).toBe(afterBuild - lvl1 - lvl2 - moduleCost(1));
    expect(await bank(clanId)).toBe(0n);

    // Treasury exhausted: the upgrade fails atomically (module level unchanged, nothing charged).
    const broke = await leader.req("POST", `/api/clans/${clanId}/station/modules/SHIELD_GRID/upgrade`);
    expect(broke.statusCode).toBe(400);
    expect(code(broke)).toBe("INSUFFICIENT_TREASURY");
    const station = await ctx.db.clanStation.findFirstOrThrow({ where: { clanId }, include: { modules: true } });
    expect(station.modules.find((m) => m.kind === "SHIELD_GRID")?.level).toBe(2);
    for (const lvl of [1, 2]) expect(await ctx.db.balanceLedger.count({ where: { idempotencyKey: `clanstation:${station.id}:SHIELD_GRID:${lvl}` } })).toBe(1);
    expect(await ctx.db.balanceLedger.count({ where: { idempotencyKey: `clanstation:${station.id}:SHIELD_GRID:3` } })).toBe(0);

    // Max level cap (checked before any charge).
    await ctx.db.clanStationModule.updateMany({ where: { stationId: station.id, kind: "RADAR" }, data: { level: rules.clanModuleMaxLevel } });
    await fund(ctx.db, leader.userId, 10_000_000n);
    expect((await leader.req("POST", `/api/clans/${clanId}/treasury/deposit`, { amount: "10000000", idempotencyKey: key() })).statusCode).toBe(200);
    const maxed = await leader.req("POST", `/api/clans/${clanId}/station/modules/RADAR/upgrade`);
    expect(maxed.statusCode).toBe(400);
    expect(code(maxed)).toBe("MAX_LEVEL");
    expect(await bank(clanId)).toBe(10_000_000n);

    // Station state is readable by anyone (outsiders included); the treasury is not.
    const view = (await outsider.req("GET", `/api/clans/${clanId}`)).json() as { treasury: string | null; stations: StationView[] };
    expect(view.treasury).toBeNull();
    expect(view.stations).toHaveLength(1);
    expect(view.stations[0]).toMatchObject({ id: station.id, mapId: "map_orion_belt", hull: rules.clanStationHull, shield: rules.clanStationShield });
    expect([...(view.stations[0]?.modules ?? [])].sort((a, b) => a.kind.localeCompare(b.kind))).toEqual([
      { kind: "RADAR", level: rules.clanModuleMaxLevel },
      { kind: "SHIELD_GRID", level: 2 },
    ]);
  });

  it("concurrent upgrades of the same module never double-charge or skip a level", async () => {
    const { leader, clanId } = await makeClan();
    const deposit = BigInt(rules.clanStationBuildCost) + moduleCost(1) + moduleCost(2) + moduleCost(3);
    expect((await leader.req("POST", `/api/clans/${clanId}/treasury/deposit`, { amount: deposit.toString(), idempotencyKey: key() })).statusCode).toBe(200);
    expect((await leader.req("POST", `/api/clans/${clanId}/station`, { mapId: "map_helios_frontier" })).statusCode).toBe(201);
    const res = await Promise.all([0, 1, 2].map(() => leader.req("POST", `/api/clans/${clanId}/station/modules/TURRET_ARRAY/upgrade`)));
    const ok = res.filter((r) => r.statusCode === 200).map((r) => (r.json() as { level: number }).level).sort();
    const station = await ctx.db.clanStation.findFirstOrThrow({ where: { clanId }, include: { modules: true } });
    const level = station.modules.find((m) => m.kind === "TURRET_ARRAY")?.level ?? 0;
    expect(level).toBeGreaterThanOrEqual(1);
    expect(ok).toEqual(Array.from({ length: level }, (_, i) => i + 1));
    let spent = 0n;
    for (let l = 1; l <= level; l++) spent += moduleCost(l);
    expect(await bank(clanId)).toBe(deposit - BigInt(rules.clanStationBuildCost) - spent);
  });
});
