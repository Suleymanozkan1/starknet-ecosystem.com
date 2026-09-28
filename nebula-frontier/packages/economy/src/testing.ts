/**
 * Test / sandbox helpers: an isolated PostgreSQL schema with all Prisma migrations applied.
 * Used by economy/blockchain tests and by the mock-mode e2e script so that funding system
 * accounts from a MOCK chain never touches the real (devnet-backed) ledger in the public schema.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, type Db } from "@nebula/database";

function migrationsDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const p = join(dir, "prisma", "migrations");
    if (existsSync(p)) return p;
    dir = resolve(dir, "..");
  }
  throw new Error("prisma/migrations not found");
}

/** Returns a Db bound to `schema` (created + migrated when missing or when migrations changed). */
export async function createIsolatedDb(schema: string, opts: { truncate?: boolean } = {}): Promise<Db> {
  if (!/^[a-z_][a-z0-9_]{0,40}$/.test(schema) || schema === "public") throw new Error("invalid sandbox schema name");
  const base = process.env.DATABASE_URL ?? "postgresql://nebula:nebula@localhost:5432/nebula";
  const dir = migrationsDir();
  const files = readdirSync(dir).filter((d) => existsSync(join(dir, d, "migration.sql"))).sort();
  const sql = files.map((f) => readFileSync(join(dir, f, "migration.sql"), "utf8"));
  const hash = createHash("sha256").update(sql.join("\n")).digest("hex").slice(0, 16);

  const admin = createDb(base);
  try {
    await admin.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext('nebula-sandbox-${schema}'))`);
      await tx.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
      await tx.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "${schema}"."_sandbox_meta" (k text primary key, v text)`);
      const rows = await tx.$queryRawUnsafe<{ v: string }[]>(`SELECT v FROM "${schema}"."_sandbox_meta" WHERE k = 'migrations'`);
      if (rows[0]?.v === hash) return;
      await tx.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
      await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
      for (const file of sql) {
        for (const stmt of file.split(/;\s*(?:\r?\n|$)/)) {
          const s = stmt.replace(/^\s*--.*$/gm, "").trim();
          if (s) await tx.$executeRawUnsafe(s);
        }
      }
      await tx.$executeRawUnsafe(`CREATE TABLE "${schema}"."_sandbox_meta" (k text primary key, v text)`);
      await tx.$executeRawUnsafe(`INSERT INTO "${schema}"."_sandbox_meta" (k, v) VALUES ('migrations', '${hash}')`);
    }, { timeout: 120_000, maxWait: 60_000 });
  } finally {
    await admin.$disconnect();
  }
  // Adapter schema qualifies generated queries; search_path covers raw SQL ($queryRaw).
  const u = new URL(base);
  u.searchParams.set("options", `-c search_path=${schema}`);
  const db = createDb(u.toString(), { schema });
  if (opts.truncate) {
    const tables = await db.$queryRawUnsafe<{ tablename: string }[]>(`SELECT tablename FROM pg_tables WHERE schemaname = '${schema}' AND tablename <> '_sandbox_meta'`);
    if (tables.length) await db.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${schema}"."${t.tablename}"`).join(", ")} CASCADE`);
  }
  return db;
}

let seq = 0;
/** Creates a user that passes reward/withdrawal eligibility by default. */
export async function createTestUser(
  db: Db,
  overrides: Partial<{ createdAt: Date; riskLevel: string; playtimeSeconds: bigint; matchesPlayed: number; wallet: string | null }> = {}
): Promise<{ id: string; wallet: string | null }> {
  const id = `t${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = overrides.createdAt ?? new Date(Date.now() - 5 * 86_400_000);
  await db.user.create({
    data: {
      id,
      username: `u_${id}`,
      createdAt,
      riskLevel: overrides.riskLevel ?? "LOW",
      playtimeSeconds: overrides.playtimeSeconds ?? 4n * 3600n,
      matchesPlayed: overrides.matchesPlayed ?? 25
    }
  });
  const wallet = overrides.wallet === undefined ? null : overrides.wallet;
  if (wallet) await db.wallet.create({ data: { userId: id, address: wallet, primary: true, verifiedAt: createdAt } });
  return { id, wallet };
}
