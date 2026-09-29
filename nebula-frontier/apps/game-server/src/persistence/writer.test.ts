/**
 * Persistence writer against real PostgreSQL: flush idempotency (stable flushId + PlayerFlush guard), fractional
 * resources, and bounty payout isolation.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, getBalance, post, system, userWallet, type Db, type Tx } from "@nebula/database";
import { LedgerAccountType, ResourceId } from "@nebula/shared";
import { createLogger } from "@nebula/telemetry";
import { createPlayerUser } from "../test-utils.js";
import { ensureCatalog } from "./catalog.js";
import { PendingDelta, Persistence, wholeUnits } from "./writer.js";

const envPath = resolve(import.meta.dirname, "../../../../.env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

const log = createLogger({ name: "writer-test", level: "silent" });
const ore: ResourceId = ResourceId.TITANIUM;
let db: Db;
let persistence: Persistence;

beforeAll(async () => {
  db = createDb();
  await ensureCatalog(db);
  persistence = new Persistence(db, log);
});

afterAll(async () => {
  await db.$disconnect();
});

async function resourceAmount(userId: string): Promise<bigint> {
  const row = await db.playerResource.findUnique({ where: { userId_resourceId: { userId, resourceId: ore } } });
  return row?.amount ?? 0n;
}

describe("Persistence.flush idempotency", () => {
  it("applies a delta once even when the same delta (same flushId) is flushed again after a commit", async () => {
    const u = await createPlayerUser(db);
    const d = new PendingDelta();
    d.xp = 100;
    d.honor = 4;
    d.npcKills = 2;
    d.addResource(ore, 3);
    d.addBoard("npc_kills", 2);
    // First attempt commits; the caller then (e.g. connection dropped after COMMIT) sees an error and retries.
    await persistence.flush(u.id, d, [], new Set());
    const id = d.flushId;
    expect(id).toBeTruthy();
    await persistence.flush(u.id, d, [], new Set());
    expect(d.flushId).toBe(id);
    const user = await db.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(user.xp).toBe(100n);
    expect(user.honor).toBe(4n);
    expect((await db.playerStat.findUniqueOrThrow({ where: { userId: u.id } })).npcKills).toBe(2);
    expect(await resourceAmount(u.id)).toBe(3n);
    expect((await db.leaderboardEntry.findUniqueOrThrow({ where: { leaderboardId_userId: { leaderboardId: "npc_kills", userId: u.id } } })).score).toBe(2n);
    expect(await db.playerFlush.count({ where: { userId: u.id } })).toBe(1);
  });

  it("a failed (but actually committed) delta carried into a newer one is skipped; the newer increments still apply", async () => {
    const u = await createPlayerUser(db);
    const older = new PendingDelta();
    older.xp = 50;
    older.addResource(ore, 5);
    await persistence.flush(u.id, older, [], new Set()); // committed, but the room saw an error
    const newer = new PendingDelta();
    newer.xp = 7;
    newer.addResource(ore, 1);
    newer.carryFailed(older);
    expect(newer.isEmpty()).toBe(false);
    await persistence.flush(u.id, newer, [], new Set());
    expect(newer.carried).toHaveLength(0);
    expect((await db.user.findUniqueOrThrow({ where: { id: u.id } })).xp).toBe(57n);
    expect(await resourceAmount(u.id)).toBe(6n);
    expect(await db.playerFlush.count({ where: { userId: u.id } })).toBe(2);
  });

  it("carried parts that never committed are applied in order with their own flush ids", async () => {
    const u = await createPlayerUser(db);
    const a = new PendingDelta();
    a.xp = 10;
    a.position = { mapId: "map_aurora_prime", x: 1, y: 1 };
    const b = new PendingDelta();
    b.xp = 20;
    b.position = { mapId: "map_aurora_prime", x: 2, y: 2 };
    b.carryFailed(a);
    const c = new PendingDelta();
    c.xp = 30;
    c.carryFailed(b);
    expect(c.carried).toEqual([a, b]);
    await persistence.flush(u.id, c, [], new Set());
    const user = await db.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(user.xp).toBe(60n);
    expect(user.lastX).toBe(2); // newer absolute write wins
    expect(new Set([a.flushId, b.flushId, c.flushId]).size).toBe(3);
  });
});

describe("fractional resources", () => {
  it("wholeUnits never throws", () => {
    expect(wholeUnits(2.7)).toBe(2n);
    expect(wholeUnits(0.4)).toBe(0n);
    expect(wholeUnits(Number.NaN)).toBe(0n);
    expect(wholeUnits(Number.POSITIVE_INFINITY)).toBe(0n);
    expect(wholeUnits(-3)).toBe(0n);
  });

  it("flush persists whole units and reports the remainder instead of aborting", async () => {
    const u = await createPlayerUser(db);
    const d = new PendingDelta();
    d.addResource(ore, 2.5);
    d.xp = 1;
    const res = await persistence.flush(u.id, d, [], new Set());
    expect(await resourceAmount(u.id)).toBe(2n);
    expect(res.resourceRemainder.get(ore)).toBeCloseTo(0.5);
    expect((await db.user.findUniqueOrThrow({ where: { id: u.id } })).xp).toBe(1n);
  });

  it("grantLoot floors fractional resources", async () => {
    const u = await createPlayerUser(db);
    await persistence.grantLoot(u.id, { lootId: `test-frac-${u.id}`, items: [], credits: 0n, gems: 0n, resources: { [ore]: 1.5 } });
    expect(await resourceAmount(u.id)).toBe(1n);
  });
});

describe("claimBounties", () => {
  it("isolates per-bounty failures and records a payout only after its transaction committed", async () => {
    const creator = await createPlayerUser(db, { credits: 1000 });
    const victim = await createPlayerUser(db);
    const killer = await createPlayerUser(db);
    const bounties = [];
    for (const amount of [100n, 200n]) {
      bounties.push(await db.$transaction(async (tx) => {
        const b = await tx.bounty.create({ data: { targetId: victim.id, creatorId: creator.id, amount, expiresAt: new Date(Date.now() + 3_600_000) } });
        await post(tx, { from: userWallet(creator.id, "CREDITS"), to: system(LedgerAccountType.ESCROW, "CREDITS"), amount, type: "ESCROW", reference: b.id, idempotencyKey: `bounty:test:${b.id}`, userId: creator.id });
        return b;
      }));
    }
    // 1st transaction: hard failure. 2nd: runs the callback, then rolls back with a serialization error (retried).
    let call = 0;
    const flaky = async (fn: (tx: Tx) => Promise<unknown>): Promise<unknown> => {
      call++;
      if (call === 1) throw new Error("db exploded");
      if (call === 2) {
        await db.$transaction(async (tx) => {
          await fn(tx);
          throw Object.assign(new Error("could not serialize access"), { code: "P2034" });
        });
      }
      return db.$transaction(fn);
    };
    const proxied = new Proxy(db, {
      get(target, key) {
        if (key === "$transaction") return flaky;
        const v: unknown = Reflect.get(target, key);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const paid = await new Persistence(proxied, log).claimBounties(victim.id, killer.id);
    expect(paid).toHaveLength(1);
    const statuses = await db.bounty.findMany({ where: { id: { in: bounties.map((b) => b.id) } } });
    const claimed = statuses.filter((b) => b.status === "CLAIMED");
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.id).toBe(paid[0]?.bountyId);
    expect(await getBalance(db, userWallet(killer.id, "CREDITS"))).toBe(paid[0]?.amount);
    // The failed bounty is still ACTIVE and is paid by a later (healthy) claim.
    const rest = await persistence.claimBounties(victim.id, killer.id);
    expect(rest).toHaveLength(1);
    expect(await getBalance(db, userWallet(killer.id, "CREDITS"))).toBe(300n);
  });
});
