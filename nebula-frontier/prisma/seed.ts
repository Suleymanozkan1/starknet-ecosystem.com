/**
 * Idempotent database seed (`pnpm db:seed`).
 *
 * - Catalog tables (Faction, Ship, Weapon, Module, Drone, Item, Resource, NPC, Quest, Achievement,
 *   Season(+rewards), Event, ShopProduct, Galaxy/Sector/StarSystem/Map/Zone/NPCSpawn, Leaderboard)
 *   are created from packages/config JSON. Existing rows are NOT overwritten (admin overrides are
 *   preserved) unless SEED_SYNC_CATALOG=true, which re-syncs every catalog row from JSON.
 * - System ledger accounts for every currency, inactive CircuitBreaker rows, EconomyConfig
 *   runtime defaults, FeatureFlag defaults.
 * - A SUPER_ADMIN user from ADMIN_EMAIL / ADMIN_PASSWORD (development defaults are printed only
 *   when NODE_ENV !== "production"; production requires both env vars).
 */
import "dotenv/config";
import {
  ACHIEVEMENTS, DRONES, EVENTS, FACTIONS, GALAXY, ITEMS, MAPS, MODULES, NPCS, QUESTS, SEASONS, SHIPS, SHOP, WEAPONS,
} from "../packages/config/src/index.js";
import { createDb, ensureAccount, type Db } from "../packages/database/src/index.js";
import { hashPassword } from "../packages/authentication/src/index.js";
import { CircuitBreakerMode, Currency, LedgerAccountType, RESOURCE_IDS } from "../packages/shared/src/index.js";

type Json = Parameters<Db["ship"]["create"]>[0]["data"]["data"];
const SYNC = process.env.SEED_SYNC_CATALOG === "true";
const json = (v: unknown): Json => JSON.parse(JSON.stringify(v)) as Json;

let created = 0;
let updated = 0;

/** Upsert helper: create when missing; overwrite only in SYNC mode. */
async function upsert<T>(exists: () => Promise<unknown>, create: () => Promise<T>, update: () => Promise<T>): Promise<void> {
  if (await exists()) {
    if (SYNC) {
      await update();
      updated++;
    }
    return;
  }
  await create();
  created++;
}

async function seedFactions(db: Db) {
  for (const f of FACTIONS) {
    const data = { name: f.name, tag: f.tag, color: f.color, homeMap: f.homeMap };
    await upsert(() => db.faction.findUnique({ where: { id: f.id } }), () => db.faction.create({ data: { id: f.id, ...data } }), () => db.faction.update({ where: { id: f.id }, data }));
  }
}

async function seedCatalog(db: Db) {
  for (const s of SHIPS) {
    const data = { name: s.name, class: s.class, tier: s.tier, data: json(s) };
    await upsert(() => db.ship.findUnique({ where: { id: s.id } }), () => db.ship.create({ data: { id: s.id, ...data } }), () => db.ship.update({ where: { id: s.id }, data }));
  }
  for (const w of WEAPONS) {
    const data = { name: w.name, type: w.type, rarity: w.rarity, data: json(w) };
    await upsert(() => db.weapon.findUnique({ where: { id: w.id } }), () => db.weapon.create({ data: { id: w.id, ...data } }), () => db.weapon.update({ where: { id: w.id }, data }));
  }
  for (const m of MODULES) {
    const data = { name: m.name, kind: m.kind, rarity: m.rarity, data: json(m) };
    await upsert(() => db.module.findUnique({ where: { id: m.id } }), () => db.module.create({ data: { id: m.id, ...data } }), () => db.module.update({ where: { id: m.id }, data }));
  }
  for (const d of DRONES) {
    const data = { name: d.name, type: d.type, rarity: d.rarity, data: json(d) };
    await upsert(() => db.drone.findUnique({ where: { id: d.id } }), () => db.drone.create({ data: { id: d.id, ...data } }), () => db.drone.update({ where: { id: d.id }, data }));
  }
  for (const i of ITEMS) {
    const data = {
      name: i.name, category: i.category, rarity: i.rarity, ref: i.ref ?? null, tradeable: i.tradeable, soulbound: i.soulbound,
      premium: i.premium, cosmetic: i.cosmetic, powerItem: i.powerItem, nftEligible: i.nftEligible, stackable: i.stackable,
      maxStack: i.maxStack, baseValue: i.baseValue, data: json(i),
    };
    await upsert(() => db.item.findUnique({ where: { id: i.id } }), () => db.item.create({ data: { id: i.id, ...data } }), () => db.item.update({ where: { id: i.id }, data }));
  }
  for (const r of RESOURCE_IDS) {
    const item = ITEMS.find((i) => i.id === `res_${r.toLowerCase()}`);
    const data = { name: item?.name ?? r, rarity: item?.rarity ?? "COMMON", baseValue: item?.baseValue ?? 1 };
    await upsert(() => db.resource.findUnique({ where: { id: r } }), () => db.resource.create({ data: { id: r, ...data } }), () => db.resource.update({ where: { id: r }, data }));
  }
  for (const n of NPCS) {
    const data = { name: n.name, faction: n.faction, level: n.level, data: json(n) };
    await upsert(() => db.nPC.findUnique({ where: { id: n.id } }), () => db.nPC.create({ data: { id: n.id, ...data } }), () => db.nPC.update({ where: { id: n.id }, data }));
  }
  for (const q of QUESTS) {
    const data = { name: q.name, type: q.type, data: json(q) };
    await upsert(() => db.quest.findUnique({ where: { id: q.id } }), () => db.quest.create({ data: { id: q.id, ...data } }), () => db.quest.update({ where: { id: q.id }, data }));
  }
  for (const a of ACHIEVEMENTS) {
    const data = { name: a.name, data: json(a) };
    await upsert(() => db.achievement.findUnique({ where: { id: a.id } }), () => db.achievement.create({ data: { id: a.id, ...data } }), () => db.achievement.update({ where: { id: a.id }, data }));
  }
}

async function seedSeasonsAndEvents(db: Db) {
  const now = Date.now();
  for (const s of SEASONS) {
    const startAt = new Date(s.startAt);
    const endAt = new Date(s.endAt);
    const data = { number: s.number, name: s.name, startAt, endAt, active: startAt.getTime() <= now && endAt.getTime() >= now, data: json(s) };
    const existed = await db.season.findUnique({ where: { id: s.id } });
    await upsert(() => Promise.resolve(existed), () => db.season.create({ data: { id: s.id, ...data } }), () => db.season.update({ where: { id: s.id }, data }));
    if (!existed || SYNC) {
      await db.seasonReward.deleteMany({ where: { seasonId: s.id } });
      await db.seasonReward.createMany({
        data: [
          ...s.leaderboardRewards.map((r) => ({ seasonId: s.id, kind: "LEADERBOARD", rankFrom: r.rankFrom, rankTo: r.rankTo, bundle: json(r.bundle) })),
          ...s.rankedRewards.map((r) => ({ seasonId: s.id, kind: `RANKED:${r.tier}`, rankFrom: r.minRating, rankTo: null, bundle: json(r.bundle) })),
        ],
      });
    } else if (existed.active !== data.active) {
      // Keep season activation in sync with the calendar even without SYNC.
      await db.season.update({ where: { id: s.id }, data: { active: data.active } });
    }
  }
  for (const e of EVENTS) {
    const data = { name: e.name, type: e.type, startAt: new Date(e.startAt), endAt: new Date(e.endAt), data: json(e) };
    await upsert(() => db.event.findUnique({ where: { id: e.id } }), () => db.event.create({ data: { id: e.id, ...data } }), () => db.event.update({ where: { id: e.id }, data }));
  }
}

async function seedShop(db: Db) {
  for (const p of SHOP) {
    const data = {
      sku: p.sku, name: p.name, category: p.category, description: p.description, currency: p.currency, price: BigInt(p.price),
      grants: json(p.grants), requiredLevel: p.requiredLevel, stock: p.stock ?? null, limitPerUser: p.limitPerUser ?? null,
      featured: p.featured ?? false, active: p.active,
    };
    await upsert(() => db.shopProduct.findUnique({ where: { id: p.id } }), () => db.shopProduct.create({ data: { id: p.id, ...data } }), () => db.shopProduct.update({ where: { id: p.id }, data }));
  }
}

async function seedWorld(db: Db) {
  await db.galaxy.upsert({ where: { id: GALAXY.id }, create: { id: GALAXY.id, name: GALAXY.name }, update: SYNC ? { name: GALAXY.name } : {} });
  for (const sec of GALAXY.sectors) {
    await db.sector.upsert({ where: { id: sec.id }, create: { id: sec.id, galaxyId: GALAXY.id, name: sec.name }, update: SYNC ? { name: sec.name } : {} });
    for (const sys of sec.systems) {
      await db.starSystem.upsert({ where: { id: sys.id }, create: { id: sys.id, sectorId: sec.id, name: sys.name }, update: SYNC ? { name: sys.name } : {} });
    }
  }
  for (const m of MAPS) {
    const data = { systemId: m.system, name: m.name, pvp: m.pvp, data: json(m) };
    const existed = await db.map.findUnique({ where: { id: m.id } });
    await upsert(() => Promise.resolve(existed), () => db.map.create({ data: { id: m.id, ...data } }), () => db.map.update({ where: { id: m.id }, data }));
    if (!existed || SYNC) {
      for (const z of m.zones) {
        const zd = { mapId: m.id, type: z.type, x: z.x, y: z.y, radius: z.radius };
        await db.zone.upsert({ where: { id: z.id }, create: { id: z.id, ...zd }, update: zd });
      }
      await db.nPCSpawn.deleteMany({ where: { mapId: m.id } });
      if (m.spawns.length) {
        await db.nPCSpawn.createMany({ data: m.spawns.map((s) => ({ mapId: m.id, npcId: s.npcId, count: s.count, x: s.x, y: s.y, radius: s.radius })) });
      }
    }
  }
}

async function seedLeaderboards(db: Db) {
  const boards = [
    { id: "pvp_kills", name: "PvP Kills", metric: "playerKills" },
    { id: "npc_kills", name: "NPC Kills", metric: "npcKills" },
    { id: "honor", name: "Honor", metric: "honor" },
    { id: "season_score", name: "Season Score", metric: "seasonScore", seasonId: "season_1" },
    { id: "faction", name: "Faction Score", metric: "factionScore" },
    { id: "clan", name: "Clan Score", metric: "clanScore" },
  ];
  for (const b of boards) {
    await db.leaderboard.upsert({ where: { id: b.id }, create: { ...b, seasonId: b.seasonId ?? null }, update: {} });
  }
}

async function seedEconomy(db: Db) {
  const systemTypes = Object.values(LedgerAccountType).filter((t) => t !== LedgerAccountType.USER_WALLET && t !== LedgerAccountType.USER_PENDING_REWARD);
  for (const type of systemTypes) {
    for (const asset of [Currency.CREDITS, Currency.GEMS, Currency.NEBX]) await ensureAccount(db, { type, asset });
  }
  for (const mode of Object.values(CircuitBreakerMode)) {
    await db.circuitBreaker.upsert({ where: { mode }, create: { mode, active: false }, update: {} });
  }
  const configDefaults: Record<string, unknown> = {
    // Runtime controller state (see @nebula/economy config.ts); balance numbers stay in economy.json.
    runtime: { rewardRateOverride: null, throttleMultiplier: 1, activityMultiplier: 1 },
    // API rule overrides (apps/api/src/lib/rules.ts); empty = code defaults.
    apiRules: {},
  };
  for (const [key, value] of Object.entries(configDefaults)) {
    await db.economyConfig.upsert({ where: { key }, create: { key, value: json(value) as object, updatedBy: "seed" }, update: {} });
  }
  const flags: { key: string; enabled: boolean; rules: Record<string, unknown> }[] = [
    { key: "wallet", enabled: true, rules: {} },
    { key: "deposit", enabled: true, rules: { denyRestrictions: ["WALLET_SUSPENDED"] } },
    { key: "withdraw", enabled: true, rules: { denyRestrictions: ["WITHDRAWAL_SUSPENDED"], maxRiskLevel: "HIGH" } },
    { key: "marketplace_crypto", enabled: false, rules: { minAge: 18 } },
    { key: "nft_mint", enabled: false, rules: {} },
  ];
  for (const f of flags) {
    await db.featureFlag.upsert({ where: { key: f.key }, create: { key: f.key, enabled: f.enabled, rules: json(f.rules) as object }, update: {} });
  }
}

async function seedAdmin(db: Db) {
  const prod = process.env.NODE_ENV === "production";
  const email = (process.env.ADMIN_EMAIL ?? (prod ? "" : "admin@nebula.local")).toLowerCase();
  const password = process.env.ADMIN_PASSWORD ?? (prod ? "" : "change-me-dev-only");
  if (!email || !password) {
    console.warn("[seed] ADMIN_EMAIL / ADMIN_PASSWORD not set: skipping admin user (required in production)");
    return;
  }
  if (prod && password.length < 16) throw new Error("ADMIN_PASSWORD must be at least 16 characters in production");
  let user = await db.user.findUnique({ where: { email } });
  if (!user) {
    let username = "admin";
    if (await db.user.findUnique({ where: { username } })) username = `admin_${Date.now().toString(36)}`;
    user = await db.user.create({ data: { email, username, passwordHash: await hashPassword(password) } });
    await db.playerStat.create({ data: { userId: user.id } });
    if (!prod) console.info(`[seed] created dev admin ${email} / ${password} (development only — change it)`);
    else console.info(`[seed] created admin ${email}`);
  } else if (process.env.ADMIN_PASSWORD_RESET === "true") {
    await db.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(password) } });
    console.info(`[seed] reset admin password for ${email}`);
  }
  const au = await db.adminUser.findUnique({ where: { userId: user.id } });
  if (!au) await db.adminUser.create({ data: { userId: user.id, roles: ["SUPER_ADMIN"] } });
  else if (!au.roles.includes("SUPER_ADMIN")) await db.adminUser.update({ where: { userId: user.id }, data: { roles: [...au.roles, "SUPER_ADMIN"] } });
  await db.auditLog.create({ data: { actorType: "SYSTEM", action: "SEED_ADMIN_ENSURED", targetType: "User", targetId: user.id } });
}

async function main() {
  const db = createDb(process.env.DATABASE_URL ?? "postgresql://nebula:nebula@localhost:5432/nebula");
  const t0 = Date.now();
  try {
    await seedFactions(db);
    await seedCatalog(db);
    await seedWorld(db);
    await seedSeasonsAndEvents(db);
    await seedShop(db);
    await seedLeaderboards(db);
    await seedEconomy(db);
    await seedAdmin(db);
    console.info(`[seed] done in ${Date.now() - t0} ms (created ${created}, updated ${updated}${SYNC ? ", SYNC mode" : ""})`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error("[seed] failed:", err);
  process.exit(1);
});
