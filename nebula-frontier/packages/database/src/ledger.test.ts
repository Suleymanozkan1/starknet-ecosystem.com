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
    // A second reversal (the key is fixed per entry) is a duplicate, never a second compensation.
    const again = await withSerializableTx(db, (tx) => reverse(tx, id, "again"));
    expect(again.duplicate).toBe(true);
    expect(await getBalance(db, userWallet(userA, "CREDITS"))).toBe(before - 50n);
    // Compensation entries themselves cannot be reversed.
    await expect(withSerializableTx(db, (tx) => reverse(tx, comp!.id, "reverse the reversal"))).rejects.toMatchObject({ code: "NOT_REVERSIBLE" });
  });

  it("post() refuses the root (non-transactional) client", async () => {
    await expect(
      post(db, { from: system("GAME_ISSUANCE", "CREDITS"), to: userWallet(userA, "CREDITS"), amount: 1n, type: "GAME_ISSUANCE", reference: "x", idempotencyKey: `t7:${run}` }),
    ).rejects.toMatchObject({ code: "TX_REQUIRED" });
    expect(await db.balanceLedger.findUnique({ where: { idempotencyKey: `t7:${run}` } })).toBeNull();
  });

  it("concurrent replays of one key under READ COMMITTED: one posting, the rest report duplicate", async () => {
    const u = await db.user.create({ data: { username: `ledger_replay_${run}` } });
    const key = `t8:${run}`;
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        db.$transaction((tx) => post(tx, { from: system("GAME_ISSUANCE", "CREDITS"), to: userWallet(u.id, "CREDITS"), amount: 40n, type: "GAME_ISSUANCE", reference: key, idempotencyKey: key })),
      ),
    );
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(await getBalance(db, userWallet(u.id, "CREDITS"))).toBe(40n);
  });

  it("concurrent first use of an account inside transactions creates it once without aborting", async () => {
    const u = await db.user.create({ data: { username: `ledger_acct_${run}` } });
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        db.$transaction((tx) => post(tx, { from: system("GAME_ISSUANCE", "GEMS"), to: userWallet(u.id, "GEMS"), amount: 1n, type: "GAME_ISSUANCE", reference: "acct", idempotencyKey: `t9:${run}:${i}` })),
      ),
    );
    expect(results.every((r) => !r.duplicate)).toBe(true);
    expect(await getBalance(db, userWallet(u.id, "GEMS"))).toBe(5n);
  });

  it("integrity: balances equal the journal replay and every asset sums to zero", async () => {
    const acct = await db.balanceAccount.findUnique({ where: { key: accountKey(userWallet(userA, "CREDITS")) } });
    expect(acct).not.toBeNull();
    expect(await replayBalance(db, acct!.id)).toBe(acct!.balance);
    const sums = await verifyLedgerIntegrity(db);
    for (const s of sums) expect({ asset: s.asset, ok: s.ok }).toEqual({ asset: s.asset, ok: true });
  });

  it("integrity: detects an account balance that drifted from the journal even when sums still net to zero", async () => {
    const a = accountKey(userWallet(userA, "CREDITS"));
    const b = accountKey(userWallet(userB, "CREDITS"));
    const rollback = new Error("rollback");
    const seen = await db
      .$transaction(async (tx) => {
        // Equal and opposite tampering keeps the per-asset sum at zero.
        await tx.balanceAccount.update({ where: { key: a }, data: { balance: { increment: 7n } } });
        await tx.balanceAccount.update({ where: { key: b }, data: { balance: { decrement: 7n } } });
        const rows = await verifyLedgerIntegrity(tx);
        throw Object.assign(rollback, { rows });
      })
      .catch((e: unknown) => (e === rollback ? (e as Error & { rows: Awaited<ReturnType<typeof verifyLedgerIntegrity>> }).rows : Promise.reject(e)));
    const credits = seen.find((r) => r.asset === "CREDITS");
    expect(credits?.sum).toBe(0n);
    expect(credits?.mismatchedAccounts).toBe(2);
    expect(credits?.ok).toBe(false);
  });
});
