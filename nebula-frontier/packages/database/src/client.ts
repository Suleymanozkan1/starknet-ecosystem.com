import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";

export type Db = InstanceType<typeof PrismaClient>;
/** Interactive transaction client type. */
export type Tx = Parameters<Parameters<Db["$transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;

let singleton: Db | undefined;

export const DEFAULT_DB_POOL_SIZE = 10;

/** Parses DB_POOL_SIZE: unset/blank → default; anything but a positive integer is a configuration error. */
export function parsePoolSize(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_DB_POOL_SIZE;
  const trimmed = raw.trim();
  const n = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(n) || n < 1) {
    throw new Error(`DB_POOL_SIZE must be a positive integer (got "${raw}")`);
  }
  return n;
}

/** Create a Prisma client backed by the pg driver adapter (Prisma 7 requires an adapter). */
export function createDb(url = process.env.DATABASE_URL, opts: { schema?: string } = {}): Db {
  if (!url) throw new Error("DATABASE_URL is not set");
  // `schema` (optional) targets a non-public schema, e.g. isolated test sandboxes.
  const adapter = new PrismaPg({ connectionString: url, max: parsePoolSize(process.env.DB_POOL_SIZE) }, opts.schema ? { schema: opts.schema } : undefined);
  return new PrismaClient({ adapter });
}

export function getDb(): Db {
  singleton ??= createDb();
  return singleton;
}

export async function disconnectDb(): Promise<void> {
  if (singleton) await singleton.$disconnect();
  singleton = undefined;
}

/** Run fn in a SERIALIZABLE transaction, retrying on serialization failures / deadlocks. */
export async function withSerializableTx<T>(db: Db, fn: (tx: Tx) => Promise<T>, attempts = 5): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await db.$transaction(fn, { isolationLevel: "Serializable", timeout: 15_000, maxWait: 10_000 });
    } catch (err) {
      lastErr = err;
      const code = (err as { code?: string }).code;
      const msg = String((err as Error).message ?? "");
      const retryable = code === "P2034" || msg.includes("could not serialize") || msg.includes("deadlock") || msg.includes("40001");
      if (!retryable) throw err;
      await new Promise((r) => setTimeout(r, 15 * 2 ** i + Math.random() * 20));
    }
  }
  throw lastErr;
}

/**
 * True for the root client (it owns the connection pool); false for an interactive transaction
 * client. Prisma's transaction client does not expose `$disconnect`.
 */
export function isRootClient(c: DbOrTx): c is Db {
  return typeof (c as { $disconnect?: unknown }).$disconnect === "function";
}

/** Runs fn in the caller's transaction, or opens a SERIALIZABLE one (with retries) when given the root client. */
export async function inSerializableTx<T>(c: DbOrTx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return isRootClient(c) ? withSerializableTx(c, fn) : fn(c);
}
