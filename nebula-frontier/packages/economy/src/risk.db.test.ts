import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@nebula/database";
import { createIsolatedDb, createTestUser } from "./testing.js";
import { recordRiskSignal } from "./risk.js";

let db: Db;
beforeAll(async () => { db = await createIsolatedDb("test_economy_risk", { truncate: true }); });
afterAll(async () => { await db?.$disconnect(); });

describe("recordRiskSignal under concurrency", () => {
  it("signals for different users never conflict (no dropped signals under load)", async () => {
    const users = await Promise.all(Array.from({ length: 25 }, () => createTestUser(db)));
    const res = await Promise.allSettled(users.map((u) => recordRiskSignal(db, { userId: u.id, type: "SPEED_HACK", score: 10, source: "test" })));
    expect(res.filter((r) => r.status === "rejected")).toHaveLength(0);
    expect(await db.riskSignal.count({ where: { userId: { in: users.map((u) => u.id) } } })).toBe(25);
  });

  it("concurrent signals for the same user serialize: the final score includes every signal", async () => {
    const u = await createTestUser(db);
    const res = await Promise.allSettled(Array.from({ length: 8 }, () => recordRiskSignal(db, { userId: u.id, type: "SPEED_HACK", score: 10, source: "test" })));
    expect(res.filter((r) => r.status === "rejected")).toHaveLength(0);
    const user = await db.user.findUniqueOrThrow({ where: { id: u.id }, select: { riskScore: true } });
    expect(user.riskScore).toBe(80);
  });
});
