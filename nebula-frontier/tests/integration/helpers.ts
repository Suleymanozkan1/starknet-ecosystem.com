/**
 * Shared helpers for API integration tests (real Postgres + Redis, Fastify inject).
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { generateKeyPairSigner, getBase58Decoder, getUtf8Encoder, signBytes, type KeyPairSigner } from "@solana/kit";
import { buildApp, type BuildAppOptions } from "../../apps/api/src/app.js";
import { createDb, post, system, userWallet, type Db } from "../../packages/database/src/index.js";
import { Currency, LedgerAccountType } from "../../packages/shared/src/index.js";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET ??= "test-jwt-secret-0123456789abcdef0123456789abcdef";
process.env.GAME_TICKET_SECRET ??= "test-game-ticket-secret-0123456789abcdef";

export interface TestCtx {
  app: FastifyInstance;
  db: Db;
}

export async function setup(opts: Omit<BuildAppOptions, "db"> = {}): Promise<TestCtx> {
  const db = createDb(process.env.DATABASE_URL ?? "postgresql://nebula:nebula@localhost:5432/nebula");
  const app = await buildApp({ db, logger: false, rateLimitScale: 1000, rateLimitNamespace: `nf:test:${randomUUID()}:`, ...opts });
  await app.ready();
  return { app, db };
}

export async function teardown(ctx: TestCtx): Promise<void> {
  await ctx.app.close();
  await ctx.db.$disconnect();
}

/** Minimal cookie jar for inject(). */
export class Session {
  cookies = new Map<string, string>();
  userId = "";
  constructor(public app: FastifyInstance) {}

  absorb(res: LightMyRequestResponse): void {
    for (const c of res.cookies as { name: string; value: string; maxAge?: number; expires?: Date }[]) {
      const cleared = c.value === "" || (c.maxAge !== undefined && c.maxAge <= 0) || (c.expires !== undefined && c.expires.getTime() <= Date.now());
      if (cleared) this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
  }

  cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  async req(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, body?: unknown, opts: { csrf?: boolean; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (this.cookies.size) headers.cookie = this.cookieHeader();
    const csrf = this.cookies.get("nf_csrf");
    if (method !== "GET" && opts.csrf !== false && csrf) headers["x-nf-csrf"] = csrf;
    const res = await this.app.inject({ method, url, headers, ...(body === undefined ? {} : { payload: body as object }) });
    this.absorb(res);
    return res;
  }
}

export async function signMessage(signer: KeyPairSigner, message: string): Promise<string> {
  const sig = await signBytes(signer.keyPair.privateKey, new Uint8Array(getUtf8Encoder().encode(message)));
  return getBase58Decoder().decode(sig);
}

/** Full SIWS wallet login; returns an authenticated cookie session. */
export async function walletLogin(app: FastifyInstance, signer?: KeyPairSigner, deviceId?: string): Promise<{ s: Session; signer: KeyPairSigner }> {
  const kp = signer ?? (await generateKeyPairSigner());
  const s = new Session(app);
  const n = await s.req("POST", "/api/auth/nonce", { address: kp.address });
  if (n.statusCode !== 200) throw new Error(`nonce failed: ${n.body}`);
  const { nonce, message } = n.json() as { nonce: string; message: string };
  const v = await s.req("POST", "/api/auth/verify", { address: kp.address, nonce, signature: await signMessage(kp, message), ...(deviceId ? { deviceId } : {}) });
  if (v.statusCode !== 200) throw new Error(`verify failed: ${v.body}`);
  s.userId = (v.json() as { user: { id: string } }).user.id;
  return { s, signer: kp };
}

/** Register with email/password (unique per call). */
export async function registerUser(app: FastifyInstance, deviceId?: string): Promise<Session> {
  const s = new Session(app);
  const tag = randomUUID().replace(/-/g, "").slice(0, 12);
  const res = await s.req("POST", "/api/auth/register", { email: `t_${tag}@test.local`, password: "correct-horse-42", username: `t_${tag}`, ...(deviceId ? { deviceId } : {}) });
  if (res.statusCode !== 201) throw new Error(`register failed: ${res.body}`);
  s.userId = (res.json() as { user: { id: string } }).user.id;
  return s;
}

/** Credit a user through the ledger (test funding: GAME_ISSUANCE -> user). */
export async function fund(db: Db, userId: string, amount: bigint, asset: "CREDITS" | "GEMS" = "CREDITS"): Promise<void> {
  await db.$transaction((tx) =>
    post(tx, {
      from: system(LedgerAccountType.GAME_ISSUANCE, asset === "GEMS" ? Currency.GEMS : Currency.CREDITS),
      to: userWallet(userId, asset === "GEMS" ? Currency.GEMS : Currency.CREDITS),
      amount,
      type: "ADMIN_ADJUSTMENT",
      reference: "test-funding",
      idempotencyKey: `test-fund:${randomUUID()}`,
      userId,
    }),
  );
}

export async function credits(db: Db, userId: string, asset: "CREDITS" | "GEMS" = "CREDITS"): Promise<bigint> {
  const row = await db.balanceAccount.findUnique({ where: { key: `USER_WALLET:${userId}:${asset}` } });
  return row?.balance ?? 0n;
}

/** Give a user a tradeable inventory item directly (server-side grant for tests). */
export async function giveItem(db: Db, userId: string, itemId = "item_wpn_laser_mk2", quantity = 1): Promise<string> {
  const row = await db.inventoryItem.create({ data: { userId, itemId, quantity, originRef: `test:${randomUUID()}` } });
  return row.id;
}

export const key = (): string => `k_${randomUUID()}`;
