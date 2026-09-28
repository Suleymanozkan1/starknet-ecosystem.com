import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, withSerializableTx, type Db } from "./client.js";
import {
  LedgerError, accountKey, getBalance, post, replayBalance, reverse, system, userWallet, verifyLedgerIntegrity,
} from "./ledger.js";

let db: Db;
const run = randomUUID().slice(0, 8);
let userA: string;
let userB: string;

beforeAll(async () => {
  db = createDb(process.env.DATABASE_URL ?? "postgresql://nebula:nebula@localhost:5432/nebula");
  const a = await db.user.create({ data: { username: `ledger_a_${run}` } });
  const b = await db.user.create({ data: { username: `ledger_b_${run}` } });
  userA = a.id;
  userB = b.id;
});

afterAll(async () => {
  await db.$disconnect();
});

const issue = (userId: string, amount: bigint, key: string) =>
  withSerializableTx(db, (tx) =>
    post(tx, {
      from: system("GAME_ISSUANCE", "CREDITS"),
      to: userWallet(userId, "CREDITS"),
      amount,
      type: "GAME_ISSUANCE",
      reference: key,
      idempotencyKey: key,
    }),
  );

describe("double-entry ledger", () => {
  it("credits a user from issuance and records one immutable row", async () => {
    const key = `t1:${run}`;
    const r = await issue(userA, 500n, key);
    expect(r.duplicate).toBe(false);
    expect(await getBalance(db, userWallet(userA, "CREDITS"))).toBe(500n);
    const row = await db.balanceLedger.findUnique({ where: { idempotencyKey: key } });
    expect(row?.amount).toBe(500n);
    expect(row?.type).toBe("GAME_ISSUANCE");
  });

  it("is idempotent: replaying the same idempotency key never double-credits", async () => {
    const key = `t2:${run}`;
    await issue(userB, 100n, key);
    const again = await issue(userB, 100n, key);
    expect(again.duplicate).toBe(true);
    expect(await getBalance(db, userWallet(userB, "CREDITS"))).toBe(100n);
  });

  it("rejects overdrafts and non-positive amounts", async () => {
    await expect(
      withSerializableTx(db, (tx) =>
        post(tx, { from: userWallet(userB, "CREDITS"), to: system("GAME_SINK", "CREDITS"), amount: 10_000n, type: "GAME_SINK", reference: "x", idempotencyKey: `t3:${run}` }),
      ),
    ).rejects.toBeInstanceOf(LedgerError);
    await expect(
      withSerializableTx(db, (tx) =>
        post(tx, { from: userWallet(userB, "CREDITS"), to: system("GAME_SINK", "CREDITS"), amount: 0n, type: "GAME_SINK", reference: "x", idempotencyKey: `t3b:${run}` }),
      ),
    ).rejects.toThrow(/positive/);
    expect(await getBalance(db, userWallet(userB, "CREDITS"))).toBe(100n);
  });

  it("rejects cross-asset postings", async () => {
    await expect(
      withSerializableTx(db, (tx) =>
        post(tx, { from: userWallet(userB, "CREDITS"), to: system("GAME_SINK", "GEMS"), amount: 1n, type: "GAME_SINK", reference: "x", idempotencyKey: `t4:${run}` }),
      ),
    ).rejects.toThrow(/Cross-asset/);
  });

  it("race condition: concurrent spends can never overdraw", async () => {
    const u = await db.user.create({ data: { username: `ledger_race_${run}` } });
    await issue(u.id, 100n, `t5:${run}`);
    const attempts = Array.from({ length: 8 }, (_, i) =>
      withSerializableTx(db, (tx) =>
        post(tx, { from: userWallet(u.id, "CREDITS"), to: system("GAME_SINK", "CREDITS"), amount: 30n, type: "GAME_SINK", reference: "race", idempotencyKey: `t5:${run}:${i}` }),
      ).then(() => "ok", () => "fail"),
    );
    const results = await Promise.all(attempts);
    expect(results.filter((r) => r === "ok")).toHaveLength(3);
    expect(await getBalance(db, userWallet(u.id, "CREDITS"))).toBe(10n);
  });

  it("corrections are compensating entries (reverse) and the original row is untouched", async () => {
    const key = `t6:${run}`;
    const { id } = await issue(userA, 50n, key);
    const before = await getBalance(db, userWallet(userA, "CREDITS"));
    await withSerializableTx(db, (tx) => reverse(tx, id, "test correction"));
    expect(await getBalance(db, userWallet(userA, "CREDITS"))).toBe(before - 50n);
    const orig = await db.balanceLedger.findUnique({ where: { id } });
    expect(orig?.status).toBe("POSTED");
    const comp = await db.balanceLedger.findUnique({ where: { idempotencyKey: `reverse:${id}` } });
    expect(comp?.type).toBe("COMPENSATION");
    expect(comp?.reference).toBe(id);
  });

  it("integrity: balances equal the journal replay and every asset sums to zero", async () => {
    const acct = await db.balanceAccount.findUnique({ where: { key: accountKey(userWallet(userA, "CREDITS")) } });
    expect(acct).not.toBeNull();
    expect(await replayBalance(db, acct!.id)).toBe(acct!.balance);
    const sums = await verifyLedgerIntegrity(db);
    for (const s of sums) expect({ asset: s.asset, ok: s.ok }).toEqual({ asset: s.asset, ok: true });
  });
});
