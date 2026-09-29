/** Helpers shared by game-server tests and the bot runner. */
import { randomUUID } from "node:crypto";
import { signGameTicket, type KeyRing } from "@nebula/authentication";
import { post, system, userWallet, type Db } from "@nebula/database";
import { LedgerAccountType } from "@nebula/shared";

export async function createPlayerUser(db: Db, o: { prefix?: string; faction?: string; level?: number; xp?: number; credits?: number; karma?: number } = {}): Promise<{ id: string; username: string }> {
  const username = `${o.prefix ?? "t_"}${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const user = await db.user.create({ data: { username, level: o.level ?? 1, xp: BigInt(o.xp ?? 0), karma: o.karma ?? 0 } });
  if (o.faction) await db.playerFaction.create({ data: { userId: user.id, factionId: o.faction } });
  if (o.credits && o.credits > 0) {
    await db.$transaction((tx) => post(tx, {
      from: system(LedgerAccountType.GAME_ISSUANCE, "CREDITS"), to: userWallet(user.id, "CREDITS"), amount: BigInt(o.credits ?? 0),
      type: "GAME_ISSUANCE", reference: "test_funding", idempotencyKey: `test_funding:${user.id}`, userId: user.id,
    }));
  }
  return { id: user.id, username };
}

export async function ticketFor(secret: string | KeyRing, user: { id: string; username: string }, mapId: string): Promise<string> {
  return signGameTicket({ sub: user.id, username: user.username, mapId, jti: randomUUID() }, secret);
}

/**
 * @colyseus/core lazily loads @pm2/io, which reports metrics over `process.send`.
 * Under vitest's `forks` pool that channel belongs to the test runner, so PM2
 * "axm:*" messages are dropped here (test environment only).
 */
export function shieldTestIpcFromPm2(): void {
  const orig = process.send?.bind(process);
  if (!orig) return;
  const filtered = (msg: unknown, ...rest: unknown[]): boolean => {
    if (msg && typeof msg === "object" && typeof (msg as { type?: unknown }).type === "string" && (msg as { type: string }).type.startsWith("axm")) return true;
    return (orig as (...a: unknown[]) => boolean)(msg, ...rest);
  };
  process.send = filtered as typeof process.send;
}
