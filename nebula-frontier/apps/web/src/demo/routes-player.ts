/**
 * Demo routes for the pilot's own account: auth, me/profile/factions, game ticket, ships + loadouts,
 * inventory, shop, crafting and quests. Mirrors apps/api/src/routes/{auth,me,game,ships,inventory,shop,crafting,quests}.ts.
 */
import {
  BATTLE_PASSES, BLUEPRINTS, BLUEPRINTS_BY_ID, FACTIONS, FACTIONS_BY_ID, ITEMS_BY_ID, MAPS, MAPS_BY_ID, MODULES_BY_ID, PROGRESSION, QUESTS, QUESTS_BY_ID,
  SHIPS, SHIPS_BY_ID, SHOP, SHOP_BY_ID, WEAPONS_BY_ID, ACHIEVEMENTS_BY_ID, itemIdForDef,
} from "@nebula/config";
import { RARITY_ORDER, Reputation, type AuthResponse, type InventoryItemDto, type InventoryResponse, type MeResponse, type ProfileResponse, type PurchaseResponse, type QuestDef, type QuestDto, type ShipInstanceDto } from "@nebula/shared";
import {
  chooseFactionSchema, craftStartSchema, createLoadoutSchema, equipCosmeticSchema, equipRequestSchema, idSchema, inventoryQuerySchema, loginRequestSchema,
  purchaseRequestSchema, questAcceptSchema, questClaimSchema, registerRequestSchema, shipActivateSchema, shipUnlockSchema, shipUpgradeSchema, unequipRequestSchema,
  updateLoadoutSchema, updateMeSchema, upgradeItemSchema, z,
} from "@nebula/validation";
import type { CraftJobDto, FactionDto, GameTicketResponse, ShipCatalogEntry, ShipsResponse, ShopProductView, UpgradeCostResponse } from "../lib/dto.js";
import {
  MAX_LOADOUTS_PER_SHIP, MAX_UPGRADE_LEVEL, DEMO_RULES, applyGameplayEvent, assertCanAfford, balancesDto, consumeResources, createAccount, debit, emptyLoadout,
  equippedMap, fitTesterShips, gearScoreOf, grantBundle, grantItems, grantShip, grantTesterKit, itemDef, inventoryCapacity, inventoryDto, loadoutDto, loadoutItemIds, meDto, notify, rankId,
  shipDtos, slotCount, slotFamilyFor, SLOT_TYPES,
} from "./account.js";
import { NPC_PILOTS, NPC_PILOTS_BY_ID } from "./catalog.js";
import { craftCompletesAt, craftCost, questPeriodKey, rollCraft, starterAmmoFor, upgradeCost } from "./core.js";
import { badRequest, conflict, demoDisabled, forbidden, notFound, parse } from "./errors.js";
import { q, requireAccount, route } from "./router.js";
import { newId, nowIso, save, state, type DemoAccount, type DemoShip, type UpgradeCostWire } from "./state.js";

type Ok = { ok: boolean };

// ------------------------------------------------------------------ helpers

const SESSION_TTL_MS = 15 * 60_000;

function authResponse(acc: DemoAccount): AuthResponse {
  const s = state();
  s.sessionUserId = acc.id;
  s.sessionCreatedAt = nowIso();
  return { user: meDto(acc), accessTokenExpiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString() };
}

function findByEmail(email: string): DemoAccount | undefined {
  const e = email.toLowerCase();
  return Object.values(state().accounts).find((a) => a.email.toLowerCase() === e);
}

function usernameTaken(name: string, exceptId?: string): boolean {
  const n = name.toLowerCase();
  return Object.values(state().accounts).some((a) => a.id !== exceptId && a.username.toLowerCase() === n) || NPC_PILOTS.some((p) => p.username.toLowerCase() === n);
}

/** Unique username (3–20 chars of [A-Za-z0-9_]) from a wish, e.g. the email's local part. */
function uniqueUsername(wish: string): string {
  let base = wish.replace(/[^A-Za-z0-9_]/g, "").slice(0, 16);
  if (base.length < 3 || base.toLowerCase().startsWith("bot_")) base = `Pilot${base}`.slice(0, 16);
  let name = base;
  for (let i = 2; usernameTaken(name); i++) name = `${base.slice(0, 16)}${i}`;
  return name;
}

/** The demo accepts any password; only the shape of email/username is validated like the API. */
const demoRegisterSchema = registerRequestSchema.extend({ password: z.string().min(1).max(128) });

function ownedShip(acc: DemoAccount, id: string): DemoShip {
  const ship = acc.ships.find((s) => s.id === id);
  if (!ship) throw notFound("Ship");
  return ship;
}

function costWire(level: number): UpgradeCostWire {
  const c = upgradeCost(level, PROGRESSION);
  const resources: Record<string, number> = {};
  for (const [k, v] of Object.entries(c.resources)) if (typeof v === "number") resources[k] = v;
  return { fromLevel: c.fromLevel, toLevel: c.toLevel, credits: c.credits.toString(), gems: c.gems.toString(), resources, successChance: c.successChance };
}

function payUpgrade(acc: DemoAccount, cost: UpgradeCostWire, ref: string, kind: "SHIP_UPGRADE" | "ITEM_UPGRADE"): void {
  assertCanAfford(acc, BigInt(cost.credits), BigInt(cost.gems), cost.resources);
  debit(acc, "CREDITS", BigInt(cost.credits), "GAME_SINK", ref, { kind, from: cost.fromLevel });
  debit(acc, "GEMS", BigInt(cost.gems), "PURCHASE", ref, { kind, from: cost.fromLevel });
  consumeResources(acc, cost.resources);
}

function priorAttempt(acc: DemoAccount, kind: "ITEM" | "SHIP", key: string, targetId: string) {
  const row = acc.upgradeAttempts.find((a) => a.kind === kind && a.idempotencyKey === key);
  if (row && row.targetId !== targetId) throw conflict("IDEMPOTENCY_KEY_REUSED", "Idempotency key was already used for a different upgrade");
  return row ?? null;
}

// ------------------------------------------------------------------ purchase (apps/api lib/purchase.ts)

const PREMIUM_RANK: Record<string, number> = { FREE: 0, VIP: 1, ELITE: 2 };

export function purchaseProduct(acc: DemoAccount, input: { productId: string; quantity: number; idempotencyKey: string }): PurchaseResponse & { duplicate: boolean } {
  const prior = acc.purchases.find((p) => p.idempotencyKey === input.idempotencyKey);
  if (prior) {
    if (prior.productId !== input.productId || prior.quantity !== input.quantity) throw conflict("IDEMPOTENCY_KEY_REUSED", "Idempotency key was already used for a different purchase");
    return { purchaseId: prior.id, balances: balancesDto(acc), duplicate: true };
  }
  const product = SHOP_BY_ID.get(input.productId);
  if (!product || !product.active) throw notFound("Product", "PRODUCT_NOT_FOUND");
  if (product.currency === "SOL" || product.currency === "NEBX") throw demoDisabled("On-chain purchases are disabled in the demo");
  if (product.currency !== "CREDITS" && product.currency !== "GEMS") throw badRequest("UNSUPPORTED_CURRENCY", "Unsupported currency");
  const g = product.grants;
  if ((g.ships?.length || g.premium || g.battlePassPremium) && input.quantity !== 1) throw badRequest("INVALID_QUANTITY", "This product can only be bought one at a time");
  if (acc.level < product.requiredLevel) throw badRequest("LEVEL_TOO_LOW", `Requires level ${product.requiredLevel}`);
  if (product.limitPerUser !== undefined) {
    const bought = acc.purchases.filter((p) => p.productId === product.id).reduce((s, p) => s + p.quantity, 0);
    if (bought + input.quantity > product.limitPerUser) throw badRequest("PURCHASE_LIMIT", "Purchase limit reached for this product");
  }
  for (const shipId of g.ships ?? []) if (acc.ships.some((s) => s.defId === shipId)) throw conflict("ALREADY_OWNED", "You already own this ship");
  let passSeason: string | null = null;
  if (g.battlePassPremium) {
    const pass = BATTLE_PASSES.find((p) => p.premiumProductSku === product.sku);
    if (!pass) throw badRequest("PASS_NOT_FOUND", "Battle pass for this product not found");
    if (acc.battlePasses.find((b) => b.seasonId === pass.seasonId)?.premium) throw conflict("ALREADY_OWNED", "Premium battle pass already active");
    passSeason = pass.seasonId;
  }
  if (g.items?.length && acc.inventory.length >= DEMO_RULES.inventoryHardCap) throw badRequest("INVENTORY_FULL", "Inventory is full");

  const total = product.price * BigInt(input.quantity);
  const currency = product.currency;
  const purchaseId = newId("pur");
  debit(acc, currency, total, "PURCHASE", purchaseId, { productId: product.id, sku: product.sku, quantity: input.quantity, unitPrice: product.price.toString() });
  acc.purchases.push({ id: purchaseId, productId: product.id, quantity: input.quantity, idempotencyKey: input.idempotencyKey, createdAt: nowIso() });

  const ref = `purchase:${purchaseId}`;
  for (const shipId of g.ships ?? []) grantShip(acc, shipId);
  const resources: Record<string, number> = {};
  for (const [k, v] of Object.entries(g.resources ?? {})) if (typeof v === "number") resources[k] = v * input.quantity;
  grantBundle(acc, {
    items: (g.items ?? []).map((i) => ({ itemId: i.itemId, quantity: i.quantity * input.quantity })),
    xp: (g.xp ?? 0) * input.quantity,
    credits: (g.credits ?? 0) * input.quantity,
    passXp: (g.passXp ?? 0) * input.quantity,
    resources,
  }, ref, `shop:${product.sku}`);
  if (g.premium) {
    const now = Date.now();
    const until = acc.premiumUntil ? Date.parse(acc.premiumUntil) : 0;
    const activeUntil = until > now ? until : now;
    const keepTier = until > now && (PREMIUM_RANK[acc.premiumTier] ?? 0) > (PREMIUM_RANK[g.premium.tier] ?? 0);
    if (!keepTier) acc.premiumTier = g.premium.tier;
    acc.premiumUntil = new Date(activeUntil + g.premium.days * 86_400_000).toISOString();
  }
  if (passSeason) {
    const pass = BATTLE_PASSES.find((p) => p.seasonId === passSeason);
    const bp = acc.battlePasses.find((b) => b.seasonId === passSeason);
    if (bp) bp.premium = true;
    else acc.battlePasses.push({ seasonId: passSeason, passId: pass?.id ?? passSeason, xp: 0, tier: 0, premium: true, claimedFree: [], claimedPremium: [] });
  }
  return { purchaseId, balances: balancesDto(acc), duplicate: false };
}

// ------------------------------------------------------------------ auth

route("POST", "/api/auth/register", (c): AuthResponse => {
  const body = parse(demoRegisterSchema, c.body);
  const existing = findByEmail(body.email);
  if (existing) return authResponse(existing);
  return authResponse(createAccount(body.email, uniqueUsername(body.username)));
});

route("POST", "/api/auth/login", (c): AuthResponse => {
  const body = parse(loginRequestSchema, c.body);
  const acc = findByEmail(body.email) ?? createAccount(body.email, uniqueUsername(body.email.split("@")[0] ?? ""));
  return authResponse(acc);
});

route("POST", "/api/auth/logout", (): Ok => {
  const s = state();
  s.sessionUserId = null;
  s.sessionCreatedAt = null;
  return { ok: true };
});

route("POST", "/api/auth/logout-all", (): Ok => {
  requireAccount();
  const s = state();
  s.sessionUserId = null;
  s.sessionCreatedAt = null;
  return { ok: true };
});

route("POST", "/api/auth/refresh", () => {
  const acc = requireAccount();
  return { ok: true, user: meDto(acc), accessTokenExpiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString() };
});

route("GET", "/api/auth/sessions", () => {
  requireAccount();
  const s = state();
  const at = s.sessionCreatedAt ?? nowIso();
  const ua = typeof navigator === "undefined" ? null : navigator.userAgent;
  return { sessions: [{ id: "demo_session", userAgent: ua, ip: null, createdAt: at, lastUsedAt: nowIso(), current: true }] };
});

for (const p of ["/api/auth/nonce", "/api/auth/verify", "/api/auth/link-wallet"]) {
  route("POST", p, () => {
    throw demoDisabled("Wallet sign-in is disabled in the demo");
  });
}

// ------------------------------------------------------------------ me / profile / factions

route("GET", "/api/me", (): MeResponse => {
  const acc = requireAccount();
  // Pilots created before the tester kit existed receive it on their next visit.
  if (acc.faction && !acc.testerKit) {
    grantTesterKit(acc);
    save(); // GETs are not persisted automatically
  } else if (acc.testerKit && !acc.testerFitted) {
    // Tester kits granted before ships were fitted: arm the ships that still have no weapon.
    fitTesterShips(acc);
    save();
  }
  return meDto(acc);
});

route("PATCH", "/api/me", (c): MeResponse => {
  const acc = requireAccount();
  const body = parse(updateMeSchema, c.body);
  if (usernameTaken(body.username, acc.id)) throw conflict("USERNAME_TAKEN", "Username already taken");
  acc.username = body.username;
  return meDto(acc);
});

route("POST", "/api/me/faction", (c): MeResponse => {
  const acc = requireAccount();
  const { factionId } = parse(chooseFactionSchema, c.body);
  const faction = FACTIONS_BY_ID.get(factionId);
  if (!faction) throw badRequest("UNKNOWN_FACTION", "Unknown faction");
  const shipDef = SHIPS_BY_ID.get(faction.starterShip);
  if (!shipDef) throw badRequest("UNKNOWN_SHIP", "Starter ship missing from catalog");
  if (acc.faction) throw conflict("FACTION_ALREADY_CHOSEN", "Faction already chosen");
  for (const defId of [...faction.starterLoadout.weapons, ...faction.starterLoadout.modules, ...faction.starterLoadout.drones]) {
    if (!ITEMS_BY_ID.has(itemIdForDef(defId))) throw badRequest("UNKNOWN_ITEM", `Starter item ${itemIdForDef(defId)} missing`);
  }

  acc.faction = faction.id;
  const ship = grantShip(acc, shipDef.id);
  const lo = ship.loadouts[0];
  if (!lo) throw notFound("Loadout");
  const cfg = lo.config;
  for (const defId of [...faction.starterLoadout.weapons, ...faction.starterLoadout.modules, ...faction.starterLoadout.drones]) {
    const [invId] = grantItems(acc, [{ itemId: itemIdForDef(defId), quantity: 1 }]);
    if (!invId) continue;
    const place = (arr: (string | null)[]) => {
      const idx = arr.indexOf(null);
      if (idx >= 0) arr[idx] = invId;
    };
    const w = WEAPONS_BY_ID.get(defId);
    const m = MODULES_BY_ID.get(defId);
    if (w) place(w.slot === "MISSILE" ? cfg.missiles : cfg.weapons);
    else if (m) place(m.slot === "GENERATOR" ? cfg.generators : cfg.modules);
    else place(cfg.drones);
  }
  const ammo = starterAmmoFor(faction).filter((a) => ITEMS_BY_ID.has(a.itemId));
  if (ammo.length) {
    grantItems(acc, ammo);
    cfg.ammo = ammo[0]?.itemId ?? null;
  }
  acc.activeShipId = ship.id;
  acc.lastMapId = faction.homeMap;
  grantTesterKit(acc);
  notify(acc, "SYSTEM", `Welcome to ${faction.name}`, `Your ${shipDef.name} is fueled and waiting in the hangar.`, { factionId: faction.id });
  return meDto(acc);
});

function profileOf(acc: DemoAccount): ProfileResponse {
  const ship = acc.ships.find((s) => s.id === acc.activeShipId);
  const clan = acc.clan ? state().clans.find((x) => x.id === acc.clan?.id) : undefined;
  return {
    id: acc.id,
    username: acc.username,
    level: acc.level,
    rank: rankId(acc),
    prestige: acc.prestige,
    title: null,
    faction: acc.faction,
    clan: clan ? { name: clan.name, tag: clan.tag } : null,
    ship: ship ? { defId: ship.defId, name: SHIPS_BY_ID.get(ship.defId)?.name ?? ship.defId } : null,
    gearScore: gearScoreOf(acc),
    reputation: Reputation.NEUTRAL,
    karma: 0,
    pvp: { kills: acc.stats.playerKills, deaths: 0, wins: acc.stats.pvpWins, rating: 1000 },
    pve: { npcKills: acc.stats.npcKills, bossKills: acc.stats.bossKills, gatesCompleted: acc.stats.gatesCompleted },
    achievements: [...acc.achievements]
      .sort((a, b) => b.unlockedAt.localeCompare(a.unlockedAt))
      .slice(0, 20)
      .map((a) => ({ id: a.id, name: ACHIEVEMENTS_BY_ID.get(a.id)?.name ?? a.id, unlockedAt: a.unlockedAt })),
  };
}

function npcProfile(id: string): ProfileResponse {
  const p = NPC_PILOTS_BY_ID.get(id);
  if (!p) throw notFound("Profile");
  const clan = p.clanId ? state().clans.find((x) => x.id === p.clanId) : undefined;
  const shipDef = SHIPS.filter((s) => s.requiredLevel <= p.level).sort((a, b) => b.requiredLevel - a.requiredLevel)[0];
  return {
    id: p.id, username: p.username, level: p.level, rank: rankFor(p.honor, p.level), prestige: 0, title: null, faction: p.faction,
    clan: clan ? { name: clan.name, tag: clan.tag } : null, ship: shipDef ? { defId: shipDef.id, name: shipDef.name } : null,
    gearScore: p.level * 40, reputation: Reputation.NEUTRAL, karma: 0,
    pvp: { kills: p.playerKills, deaths: Math.floor(p.playerKills * 0.8), wins: p.pvpWins, rating: 1000 + p.pvpWins * 5 },
    pve: { npcKills: p.npcKills, bossKills: Math.floor(p.level / 5), gatesCompleted: Math.floor(p.level / 8) }, achievements: [],
  };
}

function rankFor(honor: number, level: number): string {
  let best = PROGRESSION.ranks[0];
  for (const r of PROGRESSION.ranks) if (honor >= r.minHonor && level >= r.minLevel && r.minHonor >= (best?.minHonor ?? 0)) best = r;
  return best?.id ?? "rank_cadet";
}

route("GET", "/api/profile", (): ProfileResponse => {
  const acc = state().sessionUserId ? requireAccount() : null;
  if (!acc) throw notFound("Profile");
  return profileOf(acc);
});

route("GET", "/api/profile/:id", (c): ProfileResponse => {
  const id = parse(idSchema, c.params.id);
  const acc = state().accounts[id];
  if (acc) return profileOf(acc);
  return npcProfile(id);
});

route("GET", "/api/factions", (): { factions: FactionDto[] } => {
  const accounts = Object.values(state().accounts);
  return {
    factions: FACTIONS.map((f) => {
      const pilots = NPC_PILOTS.filter((p) => p.faction === f.id);
      return {
        id: f.id, name: f.name, tag: f.tag, motto: f.motto, lore: f.lore, color: f.color, secondaryColor: f.secondaryColor, emblem: f.emblem,
        homeMap: f.homeMap, homeSector: f.homeSector, starterShip: f.starterShip, bonus: { ...f.bonus } as Record<string, number>,
        members: pilots.length + accounts.filter((a) => a.faction === f.id).length,
        score: String(pilots.reduce((s, p) => s + p.seasonScore, 0)),
        territory: MAPS.filter((m) => m.factionHome === f.id).length,
      };
    }),
  };
});

// ------------------------------------------------------------------ game ticket

route("POST", "/api/game/ticket", (): GameTicketResponse => {
  const acc = requireAccount();
  // Same checks and codes as apps/api/src/routes/game.ts.
  if (!acc.faction) throw badRequest("NO_FACTION", "Choose a faction first");
  const ship = acc.ships.find((s) => s.id === acc.activeShipId);
  if (!ship) throw badRequest("NO_ACTIVE_SHIP", "Activate a ship first");
  const home = FACTIONS_BY_ID.get(acc.faction)?.homeMap;
  const mapId = acc.lastMapId && MAPS_BY_ID.has(acc.lastMapId) ? acc.lastMapId : home;
  if (!mapId) throw badRequest("NO_MAP", "No valid map for this pilot");
  // The equipped hangar loadout travels with the ticket so the offline simulation flies the same ship.
  const lo = ship.loadouts.find((l) => l.id === ship.activeLoadoutId) ?? ship.loadouts[0];
  const gear = (ids: readonly (string | null)[]) => ids.flatMap((invId) => {
    const row = invId ? acc.inventory.find((i) => i.id === invId) : undefined;
    const ref = row ? itemDef(row.itemId)?.ref : undefined;
    return row && ref ? [{ id: ref, up: row.upgradeLevel }] : [];
  });
  const loadout = lo
    ? { shipUpgrade: ship.upgradeLevel, weapons: gear([...lo.config.weapons, ...lo.config.missiles]), modules: gear([...lo.config.generators, ...lo.config.modules]), drones: gear(lo.config.drones) }
    : undefined;
  const json = JSON.stringify({ userId: acc.id, name: acc.username, factionId: acc.faction, shipId: ship.defId, xp: acc.xp, loadout });
  const ticket = `demo.${btoa(String.fromCharCode(...new TextEncoder().encode(json)))}`;
  return { ticket, mapId, gameServerUrl: "local://demo", expiresAt: new Date(Date.now() + 60_000).toISOString() };
});

// ------------------------------------------------------------------ ships

function shipProduct(shipId: string) {
  return SHOP.find((p) => p.active && p.category === "SHIPS" && (p.grants.ships ?? []).includes(shipId));
}

route("GET", "/api/ships", (): ShipsResponse => {
  const acc = requireAccount();
  const owned = shipDtos(acc);
  const ownedIds = new Set(owned.map((o) => o.defId));
  const catalog: ShipCatalogEntry[] = SHIPS.map((s) => {
    const p = shipProduct(s.id);
    return {
      id: s.id, name: s.name, class: s.class, tier: s.tier, rarity: s.rarity, faction: s.faction ?? null, description: s.description,
      stats: s.stats, slots: s.slots, visual: s.visual, abilities: s.abilities, owned: ownedIds.has(s.id),
      unlock: {
        requiredLevel: s.requiredLevel,
        product: p ? { productId: p.id, currency: p.currency, price: p.price.toString() } : null,
        method: p ? "SHOP" : s.faction ? "FACTION_STARTER" : "CRAFT_OR_EVENT",
      },
    };
  });
  return { owned, catalog };
});

route("POST", "/api/ships/unlock", (c) => {
  const acc = requireAccount();
  const body = parse(shipUnlockSchema, c.body);
  const p = shipProduct(body.shipId);
  if (!p) throw badRequest("NOT_PURCHASABLE", "This ship cannot be bought in the shop");
  const res = purchaseProduct(acc, { productId: p.id, quantity: 1, idempotencyKey: body.idempotencyKey });
  return { ...res, ships: shipDtos(acc) };
});

route("POST", "/api/ships/activate", (c): { ships: ShipInstanceDto[] } => {
  const acc = requireAccount();
  const body = parse(shipActivateSchema, c.body);
  acc.activeShipId = ownedShip(acc, body.shipInstanceId).id;
  return { ships: shipDtos(acc) };
});

route("GET", "/api/ships/:id/upgrade-cost", (c): UpgradeCostResponse => {
  const acc = requireAccount();
  const ship = ownedShip(acc, parse(idSchema, c.params.id));
  if (ship.upgradeLevel >= MAX_UPGRADE_LEVEL) return { maxed: true, cost: null };
  return { maxed: false, cost: costWire(ship.upgradeLevel) };
});

route("POST", "/api/ships/upgrade", (c) => {
  const acc = requireAccount();
  const body = parse(shipUpgradeSchema, c.body);
  const prior = priorAttempt(acc, "SHIP", body.idempotencyKey, body.shipInstanceId);
  if (prior) return { success: prior.success, fromLevel: prior.fromLevel, toLevel: prior.toLevel, cost: prior.cost, shipInstanceId: prior.targetId, ships: shipDtos(acc) };
  const ship = ownedShip(acc, body.shipInstanceId);
  if (ship.upgradeLevel >= MAX_UPGRADE_LEVEL) throw badRequest("MAX_LEVEL", `Ship is already +${MAX_UPGRADE_LEVEL}`);
  const cost = costWire(ship.upgradeLevel);
  payUpgrade(acc, cost, `ship-upgrade:${acc.id}:${body.idempotencyKey}`, "SHIP_UPGRADE");
  const success = Math.random() < cost.successChance;
  const fromLevel = ship.upgradeLevel;
  if (success) ship.upgradeLevel += 1;
  acc.upgradeAttempts.push({ kind: "SHIP", idempotencyKey: body.idempotencyKey, targetId: ship.id, success, fromLevel, toLevel: ship.upgradeLevel, cost });
  return { success, fromLevel, toLevel: ship.upgradeLevel, cost, shipInstanceId: ship.id, ships: shipDtos(acc) };
});

route("POST", "/api/ships/:id/loadouts", (c) => {
  const acc = requireAccount();
  const ship = ownedShip(acc, parse(idSchema, c.params.id));
  const body = parse(createLoadoutSchema, c.body);
  if (ship.loadouts.length >= MAX_LOADOUTS_PER_SHIP) throw badRequest("TOO_MANY_LOADOUTS", `At most ${MAX_LOADOUTS_PER_SHIP} loadouts per ship`);
  const def = SHIPS_BY_ID.get(ship.defId);
  if (!def) throw notFound("Ship definition");
  let config = emptyLoadout(def.slots);
  if (body.copyFromLoadoutId) {
    const src = ship.loadouts.find((l) => l.id === body.copyFromLoadoutId);
    if (!src) throw notFound("Loadout");
    config = structuredClone(src.config);
  }
  const lo = { id: newId("lo"), name: body.name, preset: body.preset, config, createdAt: nowIso() };
  ship.loadouts.push(lo);
  return loadoutDto(lo);
});

route("PUT", "/api/ships/:id/loadouts/:loadoutId", (c) => {
  const acc = requireAccount();
  const ship = ownedShip(acc, parse(idSchema, c.params.id));
  const body = parse(updateLoadoutSchema, c.body);
  const lo = ship.loadouts.find((l) => l.id === c.params.loadoutId);
  if (!lo) throw notFound("Loadout");
  if (body.ammo && !acc.inventory.some((i) => i.itemId === body.ammo)) throw badRequest("AMMO_NOT_OWNED", "You do not own this ammunition");
  if (body.formation) lo.config.formation = body.formation;
  if (body.ammo !== undefined) lo.config.ammo = body.ammo;
  if (body.name) lo.name = body.name;
  if (body.preset) lo.preset = body.preset;
  return loadoutDto(lo);
});

route("POST", "/api/ships/:id/loadouts/:loadoutId/activate", (c): { ships: ShipInstanceDto[] } => {
  const acc = requireAccount();
  const ship = ownedShip(acc, parse(idSchema, c.params.id));
  const lo = ship.loadouts.find((l) => l.id === c.params.loadoutId);
  if (!lo) throw notFound("Loadout");
  ship.activeLoadoutId = lo.id;
  return { ships: shipDtos(acc) };
});

route("DELETE", "/api/ships/:id/loadouts/:loadoutId", (c): Ok => {
  const acc = requireAccount();
  const ship = ownedShip(acc, parse(idSchema, c.params.id));
  const loadoutId = parse(idSchema, c.params.loadoutId);
  if (ship.activeLoadoutId === loadoutId) throw badRequest("ACTIVE_LOADOUT", "Cannot delete the active loadout");
  const idx = ship.loadouts.findIndex((l) => l.id === loadoutId);
  if (idx < 0) throw notFound("Loadout");
  ship.loadouts.splice(idx, 1);
  return { ok: true };
});

route("POST", "/api/ships/cosmetics", (c): { ships: ShipInstanceDto[] } => {
  const acc = requireAccount();
  const body = parse(equipCosmeticSchema, c.body);
  const ship = ownedShip(acc, body.shipInstanceId);
  if (body.inventoryItemId === null) {
    delete ship.cosmetics[body.slot];
  } else {
    const inv = acc.inventory.find((i) => i.id === body.inventoryItemId && !i.lockedBy);
    if (!inv) throw notFound("Item");
    const def = ITEMS_BY_ID.get(inv.itemId);
    const payload = def?.cosmeticPayload;
    if (!def || (def.category !== "SKIN" && def.category !== "COSMETIC") || !payload) throw badRequest("NOT_COSMETIC", "Item is not a cosmetic");
    if (payload.slot !== body.slot) throw badRequest("WRONG_SLOT", `Item fits the ${payload.slot} slot`);
    if (payload.shipId && payload.shipId !== ship.defId) throw badRequest("WRONG_SHIP", "This skin is for a different ship");
    ship.cosmetics[body.slot] = inv.itemId;
  }
  return { ships: shipDtos(acc) };
});

// ------------------------------------------------------------------ inventory

type InvSort = "rarity" | "level" | "power" | "value" | "recent";
const INV_SORT: Record<InvSort, (a: InventoryItemDto, b: InventoryItemDto) => number> = {
  rarity: (a, b) => RARITY_ORDER[b.rarity] - RARITY_ORDER[a.rarity],
  level: (a, b) => b.upgradeLevel - a.upgradeLevel,
  power: (a, b) => b.power - a.power,
  value: (a, b) => b.value - a.value,
  recent: (a, b) => b.acquiredAt.localeCompare(a.acquiredAt),
};

route("GET", "/api/inventory", (c): InventoryResponse => {
  const acc = requireAccount();
  const query = parse(inventoryQuerySchema, {
    category: q(c.query, "category"), rarity: q(c.query, "rarity"), sort: q(c.query, "sort"), search: q(c.query, "search"),
  });
  const equipped = equippedMap(acc);
  const search = query.search?.toLowerCase();
  const items = acc.inventory
    .map((r) => inventoryDto(r, equipped.get(r.id) ?? null))
    .filter((i) => (!query.category || i.category === query.category) && (!query.rarity || i.rarity === query.rarity))
    .filter((i) => !search || i.name.toLowerCase().includes(search) || i.itemId.includes(search))
    .sort((a, b) => b.acquiredAt.localeCompare(a.acquiredAt))
    .sort(INV_SORT[query.sort]);
  return { items, capacity: inventoryCapacity(acc) };
});

function requiredLevelOf(ref: string | undefined): number {
  if (!ref) return 1;
  return WEAPONS_BY_ID.get(ref)?.requiredLevel ?? MODULES_BY_ID.get(ref)?.requiredLevel ?? 1;
}

route("POST", "/api/inventory/equip", (c) => {
  const acc = requireAccount();
  const body = parse(equipRequestSchema, c.body);
  const ship = ownedShip(acc, body.shipInstanceId);
  const lo = ship.loadouts.find((l) => l.id === body.loadoutId);
  if (!lo) throw notFound("Loadout");
  const shipDef = SHIPS_BY_ID.get(ship.defId);
  if (!shipDef) throw notFound("Ship definition");
  const item = acc.inventory.find((i) => i.id === body.inventoryItemId);
  if (!item) throw notFound("Item");
  if (item.lockedBy) throw conflict("ITEM_LOCKED", "Item is listed on the market or in escrow");
  const def = ITEMS_BY_ID.get(item.itemId);
  if (!def) throw badRequest("UNKNOWN_ITEM", "Unknown item");
  if (slotFamilyFor(def) !== body.slotType) throw badRequest("INCOMPATIBLE_SLOT", `Item cannot be equipped in ${body.slotType}`);
  if (body.slotIndex >= slotCount(shipDef.slots, body.slotType)) throw badRequest("INVALID_SLOT", "Slot index out of range for this ship");
  const reqLevel = requiredLevelOf(def.ref);
  if (acc.level < reqLevel) throw forbidden(`Requires level ${reqLevel}`, "LEVEL_TOO_LOW");
  const onOther = acc.ships.some((s) => s.id !== ship.id && s.loadouts.some((l) => loadoutItemIds(l.config).includes(item.id)));
  if (onOther) throw conflict("ITEM_IN_USE", "Item is equipped on another ship");
  const cfg = lo.config;
  for (const t of SLOT_TYPES) {
    const arr = cfg[t];
    while (arr.length < slotCount(shipDef.slots, t)) arr.push(null);
    for (let i = 0; i < arr.length; i++) if (arr[i] === item.id) arr[i] = null;
  }
  cfg[body.slotType].length = slotCount(shipDef.slots, body.slotType);
  cfg[body.slotType][body.slotIndex] = item.id;
  return { loadout: loadoutDto(lo) };
});

route("POST", "/api/inventory/unequip", (c) => {
  const acc = requireAccount();
  const body = parse(unequipRequestSchema, c.body);
  const ship = ownedShip(acc, body.shipInstanceId);
  const lo = ship.loadouts.find((l) => l.id === body.loadoutId);
  if (!lo) throw notFound("Loadout");
  const arr = lo.config[body.slotType];
  if (body.slotIndex >= arr.length || !arr[body.slotIndex]) throw badRequest("EMPTY_SLOT", "Slot is already empty");
  arr[body.slotIndex] = null;
  return { loadout: loadoutDto(lo) };
});

route("POST", "/api/inventory/upgrade", (c) => {
  const acc = requireAccount();
  const body = parse(upgradeItemSchema, c.body);
  const prior = priorAttempt(acc, "ITEM", body.idempotencyKey, body.inventoryItemId);
  if (prior) return { success: prior.success, fromLevel: prior.fromLevel, toLevel: prior.toLevel, cost: prior.cost, inventoryItemId: prior.targetId };
  const item = acc.inventory.find((i) => i.id === body.inventoryItemId);
  if (!item) throw notFound("Item");
  if (item.lockedBy) throw conflict("ITEM_LOCKED", "Item is listed on the market or in escrow");
  const def = ITEMS_BY_ID.get(item.itemId);
  if (!def?.powerItem || def.stackable) throw badRequest("NOT_UPGRADABLE", "This item cannot be upgraded");
  if (item.upgradeLevel >= MAX_UPGRADE_LEVEL) throw badRequest("MAX_LEVEL", `Item is already +${MAX_UPGRADE_LEVEL}`);
  const cost = costWire(item.upgradeLevel);
  payUpgrade(acc, cost, `item-upgrade:${acc.id}:${body.idempotencyKey}`, "ITEM_UPGRADE");
  const success = Math.random() < cost.successChance;
  const fromLevel = item.upgradeLevel;
  if (success) item.upgradeLevel += 1;
  acc.upgradeAttempts.push({ kind: "ITEM", idempotencyKey: body.idempotencyKey, targetId: item.id, success, fromLevel, toLevel: item.upgradeLevel, cost });
  return { success, fromLevel, toLevel: item.upgradeLevel, cost, inventoryItemId: item.id };
});

// ------------------------------------------------------------------ shop

route("GET", "/api/shop", (): { products: ShopProductView[] } => {
  const products = SHOP.filter((p) => p.active)
    .sort((a, b) => a.category.localeCompare(b.category) || (a.price < b.price ? -1 : a.price > b.price ? 1 : 0))
    .map((p): ShopProductView => ({
      id: p.id, sku: p.sku, name: p.name, category: p.category, description: p.description, currency: p.currency, price: p.price.toString(),
      requiredLevel: p.requiredLevel, featured: p.featured ?? false, grants: p.grants, stock: p.stock ?? null, limitPerUser: p.limitPerUser ?? null,
      purchaseFlow: p.currency === "SOL" || p.currency === "NEBX" ? "DEPOSIT" : "LEDGER",
    }));
  return { products };
});

route("GET", "/api/shop/purchases", () => {
  const acc = requireAccount();
  return {
    purchases: [...acc.purchases].reverse().map((p) => {
      const product = SHOP_BY_ID.get(p.productId);
      return {
        id: p.id, productId: p.productId, quantity: p.quantity, currency: product?.currency ?? "CREDITS",
        totalPrice: ((product?.price ?? 0n) * BigInt(p.quantity)).toString(), status: "COMPLETED", createdAt: p.createdAt,
      };
    }),
  };
});

route("POST", "/api/shop/purchase", (c) => {
  const acc = requireAccount();
  const body = parse(purchaseRequestSchema, c.body);
  const res = purchaseProduct(acc, body);
  return { purchaseId: res.purchaseId, balances: res.balances, duplicate: res.duplicate };
});

// ------------------------------------------------------------------ crafting

function craftJobDto(j: DemoAccount["craftJobs"][number]): CraftJobDto {
  return { id: j.id, blueprintId: j.blueprintId, status: j.status, startedAt: j.startedAt, completesAt: j.completesAt, ready: Date.parse(j.completesAt) <= Date.now() };
}

route("GET", "/api/crafting/blueprints", () => {
  const acc = requireAccount();
  return { blueprints: BLUEPRINTS, jobs: acc.craftJobs.filter((j) => !j.claimedAt).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map(craftJobDto) };
});

route("POST", "/api/crafting/start", (c): CraftJobDto => {
  const acc = requireAccount();
  const body = parse(craftStartSchema, c.body);
  const bp = BLUEPRINTS_BY_ID.get(body.blueprintId);
  if (!bp) throw notFound("Blueprint");
  const prior = acc.craftJobs.find((j) => j.idempotencyKey === body.idempotencyKey);
  if (prior) return { id: prior.id, blueprintId: prior.blueprintId, status: prior.status, completesAt: prior.completesAt };
  if (acc.level < bp.requiredLevel) throw forbidden(`Requires level ${bp.requiredLevel}`, "LEVEL_TOO_LOW");
  if (acc.craftJobs.filter((j) => j.status === "IN_PROGRESS").length >= DEMO_RULES.craftingMaxConcurrent) {
    throw badRequest("CRAFT_QUEUE_FULL", `At most ${DEMO_RULES.craftingMaxConcurrent} concurrent crafts`);
  }
  const cost = craftCost(bp);
  assertCanAfford(acc, cost.credits, 0n, cost.resources);
  const equipped = equippedMap(acc);
  for (const need of cost.items) {
    const have = acc.inventory.filter((i) => i.itemId === need.itemId && !i.lockedBy && !equipped.has(i.id)).reduce((s, i) => s + i.quantity, 0);
    if (have < need.quantity) throw badRequest("MISSING_ITEMS", `Not enough ${need.itemId}`);
  }
  const id = newId("craft");
  debit(acc, "CREDITS", cost.credits, "GAME_SINK", id, { kind: "CRAFT", blueprintId: bp.id });
  consumeResources(acc, cost.resources);
  for (const need of cost.items) {
    let remaining = need.quantity;
    const stacks = acc.inventory.filter((i) => i.itemId === need.itemId && !i.lockedBy && !equipped.has(i.id)).sort((a, b) => a.quantity - b.quantity);
    for (const s of stacks) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, s.quantity);
      s.quantity -= take;
      remaining -= take;
    }
  }
  acc.inventory = acc.inventory.filter((i) => i.quantity > 0);
  const now = new Date();
  const job = { id, blueprintId: bp.id, status: "IN_PROGRESS", startedAt: now.toISOString(), completesAt: craftCompletesAt(bp, now).toISOString(), claimedAt: null, idempotencyKey: body.idempotencyKey };
  acc.craftJobs.push(job);
  return { id: job.id, blueprintId: job.blueprintId, status: job.status, completesAt: job.completesAt };
});

route("POST", "/api/crafting/:id/claim", (c) => {
  const acc = requireAccount();
  const jobId = parse(idSchema, c.params.id);
  const job = acc.craftJobs.find((j) => j.id === jobId);
  if (!job) throw notFound("Craft job");
  if (job.claimedAt) throw conflict("ALREADY_CLAIMED", "Craft already claimed");
  if (Date.parse(job.completesAt) > Date.now()) throw badRequest("NOT_READY", "Crafting is not finished yet");
  const bp = BLUEPRINTS_BY_ID.get(job.blueprintId);
  if (!bp) throw notFound("Blueprint");
  const roll = rollCraft(bp, Math.random);
  job.claimedAt = nowIso();
  job.status = roll.success ? "COMPLETED" : "FAILED";
  let items: string[] = [];
  if (roll.success) {
    items = grantItems(acc, [{ itemId: roll.outputItem, quantity: roll.quantity }]);
    acc.stats.itemsCrafted += 1;
    applyGameplayEvent(acc, { type: "CRAFT", blueprintId: bp.id, quantity: roll.quantity });
  }
  return { success: roll.success, outputItem: roll.outputItem, quantity: roll.quantity, inventoryItemIds: items };
});

// ------------------------------------------------------------------ quests

const REPEATING = new Set(["DAILY", "WEEKLY", "MONTHLY"]);
const periodFor = (qd: QuestDef): string => (REPEATING.has(qd.type) ? questPeriodKey(qd.type, new Date()) : "once");

function objectiveProgress(qd: QuestDef, progress: number[], level: number): number[] {
  return qd.objectives.map((o, i) => (o.type === "LEVEL" ? Math.min(o.count, Math.max(progress[i] ?? 0, level)) : Math.min(o.count, progress[i] ?? 0)));
}

function questComplete(qd: QuestDef, progress: number[], level: number): boolean {
  const p = objectiveProgress(qd, progress, level);
  return qd.objectives.every((o, i) => (p[i] ?? 0) >= o.count);
}

function questDto(qd: QuestDef, row: DemoAccount["quests"][number] | null, level: number): QuestDto {
  const progress = objectiveProgress(qd, row?.progress ?? [], level);
  const complete = questComplete(qd, progress, level);
  return {
    id: row?.id ?? "",
    questId: qd.id,
    name: qd.name,
    type: qd.type,
    description: qd.description,
    objectives: qd.objectives.map((o, i) => ({ type: o.type, ...(o.target ? { target: o.target } : {}), count: o.count, progress: progress[i] ?? 0 })),
    status: row?.status === "CLAIMED" ? "CLAIMED" : complete && row ? "COMPLETED" : "ACTIVE",
    rewards: qd.rewards,
  };
}

route("GET", "/api/quests", () => {
  const acc = requireAccount();
  const claimedOnce = new Set(acc.quests.filter((r) => r.status === "CLAIMED").map((r) => r.questId));
  const active: QuestDto[] = [];
  const available: QuestDto[] = [];
  for (const qd of QUESTS) {
    const row = acc.quests.find((r) => r.questId === qd.id && r.periodKey === periodFor(qd)) ?? null;
    if (row) {
      active.push(questDto(qd, row, acc.level));
      continue;
    }
    if (!qd.repeatable && claimedOnce.has(qd.id)) continue;
    if (qd.requiredLevel > acc.level) continue;
    if (qd.faction && qd.faction !== acc.faction) continue;
    if (!qd.prerequisites.every((p) => claimedOnce.has(p))) continue;
    available.push(questDto(qd, null, acc.level));
  }
  return { active, available };
});

route("POST", "/api/quests/accept", (c): QuestDto => {
  const acc = requireAccount();
  const { questId } = parse(questAcceptSchema, c.body);
  const qd = QUESTS_BY_ID.get(questId);
  if (!qd) throw notFound("Quest");
  if (qd.requiredLevel > acc.level) throw forbidden(`Requires level ${qd.requiredLevel}`, "LEVEL_TOO_LOW");
  if (qd.faction && qd.faction !== acc.faction) throw forbidden("Quest belongs to another faction", "WRONG_FACTION");
  const claimed = new Set(acc.quests.filter((r) => r.status === "CLAIMED").map((r) => r.questId));
  if (!qd.prerequisites.every((p) => claimed.has(p))) throw forbidden("Prerequisites not completed", "PREREQUISITES");
  if (!qd.repeatable && acc.quests.some((r) => r.questId === qd.id)) throw conflict("QUEST_ALREADY_TAKEN", "Quest already accepted");
  const period = periodFor(qd);
  if (acc.quests.some((r) => r.questId === qd.id && r.periodKey === period)) throw conflict("QUEST_ALREADY_TAKEN", "Quest already accepted for this period");
  if (acc.quests.filter((r) => r.status !== "CLAIMED").length >= DEMO_RULES.maxActiveQuests) throw badRequest("TOO_MANY_QUESTS", "Quest log is full");
  const row = { id: newId("uq"), questId: qd.id, periodKey: period, status: "ACTIVE" as const, progress: qd.objectives.map(() => 0), claimedAt: null };
  acc.quests.push(row);
  return questDto(qd, row, acc.level);
});

route("POST", "/api/quests/claim", (c) => {
  const acc = requireAccount();
  const { userQuestId } = parse(questClaimSchema, c.body);
  const row = acc.quests.find((r) => r.id === userQuestId);
  if (!row) throw notFound("Quest");
  const qd = QUESTS_BY_ID.get(row.questId);
  if (!qd) throw notFound("Quest definition");
  if (row.status === "CLAIMED") throw conflict("ALREADY_CLAIMED", "Quest rewards already claimed");
  if (!questComplete(qd, row.progress, acc.level)) throw badRequest("QUEST_INCOMPLETE", "Quest objectives are not complete");
  row.status = "CLAIMED";
  row.claimedAt = nowIso();
  const { cryptoEligible: _crypto, ...safe } = qd.rewards;
  const grant = grantBundle(acc, safe, `quest:${row.id}`, `quest:${qd.id}`);
  return { ok: true, questId: qd.id, levelBefore: grant.levelBefore, levelAfter: grant.levelAfter, items: grant.items };
});
