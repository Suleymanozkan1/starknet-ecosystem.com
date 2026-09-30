/**
 * Demo pilot domain logic: balances + local ledger, item grants, XP/level/rank, ship stats and the DTO
 * mappers. Each function mirrors the corresponding apps/api helper (lib/grants.ts, lib/inventory.ts,
 * lib/ships.ts, lib/me.ts, lib/balances.ts) so the shapes and rules match the real backend.
 */
import {
  BATTLE_PASSES, DRONES_BY_ID, ECONOMY, FACTIONS_BY_ID, ITEMS, ITEMS_BY_ID, MODULES_BY_ID, PROGRESSION, QUESTS_BY_ID, SEASONS, SHIPS, SHIPS_BY_ID, WEAPONS_BY_ID,
} from "@nebula/config";
import {
  RARITY_ORDER, RESOURCE_IDS, type BalancesDto, type Currency, type DroneDef, type InventoryItemDto, type ItemCategory, type ItemDef, type LoadoutDto, type MeResponse,
  type ModuleDef, type Rarity, type ResourceId, type RewardBundle, type SeasonDef, type ShipDef, type ShipInstanceDto, type StatKey, type WeaponDef,
} from "@nebula/shared";
import { applyQuestEvent, computeStats, levelForXp, levelProgress, rankFor, xpForLevel, type Equipped, type GameplayEvent, type LoadoutInput } from "./core.js";
import { badRequest, insufficientBalance } from "./errors.js";
import { newId, nowIso, state, type DemoAccount, type DemoItem, type DemoLoadout, type DemoShip, type LoadoutConfig } from "./state.js";

/**
 * Gameplay/market rules the API keeps outside packages/config (apps/api/src/lib/rules.ts API_RULE_DEFAULTS).
 * Mirrored here so the demo enforces the same limits; they are shown to players via GET /api/rules.
 */
export const DEMO_RULES = {
  clanCreateCost: 250_000,
  clanMaxMembers: 50,
  squadMinSize: 4,
  squadMaxSize: 8,
  maxActiveQuests: 12,
  craftingMaxConcurrent: 3,
  auctionMinIncrementPct: 0.05,
  auctionAntiSnipeSeconds: 120,
  auctionDurationsHours: { HOURLY: 1, DAILY: 24, WEEKLY: 168 },
  bountyMin: 10_000,
  bountyDurationHours: 72,
  friendsMax: 200,
  usernameChangeCooldownHours: 24 * 7,
  marketMaxActiveListings: 50,
  inventoryHardCap: 500,
} as const;

/** Local play money every new demo pilot starts with (demo only — the real game starts at zero). */
export const DEMO_STARTING_CREDITS = 150_000n;
export const DEMO_STARTING_GEMS = 1_000n;
/** Credits attached to the welcome mail. */
export const DEMO_WELCOME_CREDITS = 5_000;

export const MAX_UPGRADE_LEVEL = PROGRESSION.upgrade.maxLevel;
export const MAX_LOADOUTS_PER_SHIP = 8;

export const SLOT_TYPES = ["weapons", "missiles", "generators", "modules", "drones"] as const;
export type SlotType = (typeof SLOT_TYPES)[number];

// ------------------------------------------------------------------ accounts / session

export function currentAccount(): DemoAccount | null {
  const s = state();
  return s.sessionUserId ? (s.accounts[s.sessionUserId] ?? null) : null;
}

export function emptyStats(): DemoAccount["stats"] {
  return { npcKills: 0, playerKills: 0, bossKills: 0, gatesCompleted: 0, resourcesMined: 0, mapsVisited: [], itemsCrafted: 0, pvpWins: 0, marketSales: 0 };
}

export function createAccount(email: string, username: string): DemoAccount {
  const now = nowIso();
  const acc: DemoAccount = {
    id: newId("usr"),
    username,
    email,
    createdAt: now,
    xp: 0,
    level: 1,
    honor: 0,
    seasonScore: 0,
    prestige: 0,
    faction: null,
    activeShipId: null,
    lastMapId: null,
    premiumTier: "FREE",
    premiumUntil: null,
    credits: "0",
    gems: "0",
    resources: {},
    ships: [],
    inventory: [],
    ledger: [],
    quests: [],
    craftJobs: [],
    purchases: [],
    upgradeAttempts: [],
    achievements: [],
    battlePasses: [],
    mail: [],
    notifications: [],
    stats: emptyStats(),
    clan: null,
  };
  state().accounts[acc.id] = acc;
  credit(acc, "CREDITS", DEMO_STARTING_CREDITS, "GAME_REWARD", "demo:start", { reason: "Demo starting balance" });
  credit(acc, "GEMS", DEMO_STARTING_GEMS, "GAME_REWARD", "demo:start", { reason: "Demo starting balance" });
  acc.mail.push({
    id: newId("mail"),
    fromUserId: null,
    system: true,
    subject: "Welcome to Nebula Frontier",
    body:
      "Welcome aboard, pilot! This is an offline demo: your account, ships and balances live only in this browser. " +
      "Pick a faction, take your starter ship out and have fun. A small credit transfer is attached to get you going.",
    attachments: { credits: DEMO_WELCOME_CREDITS },
    claimed: false,
    read: false,
    expiresAt: null,
    createdAt: now,
  });
  notify(acc, "SYSTEM", "Demo mode", "Everything you do here stays in this browser. Wallet and on-chain features are disabled.");
  return acc;
}

export function notify(acc: DemoAccount, type: string, title: string, body: string, data?: Record<string, unknown>): void {
  acc.notifications.unshift({ id: newId("ntf"), type, title, body, ...(data ? { data } : {}), read: false, createdAt: nowIso() });
  if (acc.notifications.length > 100) acc.notifications.length = 100;
}

// ------------------------------------------------------------------ balances + ledger

type Asset = Extract<Currency, "CREDITS" | "GEMS">;

export function balanceOf(acc: DemoAccount, asset: Asset): bigint {
  return BigInt(asset === "CREDITS" ? acc.credits : acc.gems);
}

function setBalance(acc: DemoAccount, asset: Asset, v: bigint): void {
  if (asset === "CREDITS") acc.credits = v.toString();
  else acc.gems = v.toString();
}

function record(acc: DemoAccount, asset: Asset, amount: bigint, direction: "CREDIT" | "DEBIT", type: string, reference: string, metadata: Record<string, unknown>): void {
  acc.ledger.unshift({ id: newId("led"), type, asset, amount: amount.toString(), direction, reference, createdAt: nowIso(), metadata });
  if (acc.ledger.length > 500) acc.ledger.length = 500;
}

export function credit(acc: DemoAccount, asset: Asset, amount: bigint, type: string, reference: string, metadata: Record<string, unknown> = {}): void {
  if (amount <= 0n) return;
  setBalance(acc, asset, balanceOf(acc, asset) + amount);
  record(acc, asset, amount, "CREDIT", type, reference, metadata);
}

/** Debit or throw INSUFFICIENT_BALANCE (the ledger's error, as the API maps it). */
export function debit(acc: DemoAccount, asset: Asset, amount: bigint, type: string, reference: string, metadata: Record<string, unknown> = {}): void {
  if (amount <= 0n) return;
  const bal = balanceOf(acc, asset);
  if (bal < amount) throw insufficientBalance();
  setBalance(acc, asset, bal - amount);
  record(acc, asset, amount, "DEBIT", type, reference, metadata);
}

export function assertCanAfford(acc: DemoAccount, credits: bigint, gems: bigint, resources: Partial<Record<string, number>> = {}): void {
  if (balanceOf(acc, "CREDITS") < credits || balanceOf(acc, "GEMS") < gems) throw insufficientBalance();
  for (const [res, amt] of Object.entries(resources)) {
    if (amt && amt > 0 && (acc.resources[res as ResourceId] ?? 0) < amt) throw badRequest("INSUFFICIENT_RESOURCES", `Not enough ${res}`);
  }
}

export function addResources(acc: DemoAccount, resources: Partial<Record<string, number>>): void {
  for (const [res, amt] of Object.entries(resources)) {
    if (!amt || amt <= 0) continue;
    const k = res as ResourceId;
    acc.resources[k] = (acc.resources[k] ?? 0) + Math.floor(amt);
  }
}

export function consumeResources(acc: DemoAccount, resources: Partial<Record<string, number>>): void {
  assertCanAfford(acc, 0n, 0n, resources);
  for (const [res, amt] of Object.entries(resources)) {
    if (!amt || amt <= 0) continue;
    const k = res as ResourceId;
    acc.resources[k] = (acc.resources[k] ?? 0) - amt;
  }
}

export function balancesDto(acc: DemoAccount): BalancesDto {
  return { credits: acc.credits, gems: acc.gems, nebx: "0", pendingRewards: "0", resources: { ...acc.resources } };
}

// ------------------------------------------------------------------ progression

export function syncLevel(acc: DemoAccount): { before: number; after: number } {
  const before = acc.level;
  acc.level = Math.max(acc.level, levelForXp(acc.xp, PROGRESSION));
  if (acc.level > before) {
    notify(acc, "LEVEL_UP", "Level up!", `You reached level ${acc.level}.`, { level: acc.level });
    applyGameplayEvent(acc, { type: "LEVEL", level: acc.level });
  }
  return { before, after: acc.level };
}

export function addXpHonor(acc: DemoAccount, xp: number, honor: number): { before: number; after: number } {
  if (xp > 0) acc.xp += Math.floor(xp);
  if (honor > 0) acc.honor += Math.floor(honor);
  return syncLevel(acc);
}

export function rankId(acc: DemoAccount): string {
  return rankFor(acc.honor, acc.level, PROGRESSION).id;
}

/** Season whose [startAt, endAt] contains now (config seasons; the API reads the same rows from the DB). */
export function activeSeason(now = Date.now()): SeasonDef | undefined {
  return SEASONS.find((s) => Date.parse(s.startAt) <= now && Date.parse(s.endAt) >= now);
}

export function passTierForXp(passId: string, xp: number): number {
  const pass = BATTLE_PASSES.find((p) => p.id === passId);
  let tier = 0;
  for (const t of pass?.tiers ?? []) if (xp >= t.xpRequired) tier = t.tier;
  return tier;
}

export function battlePassRow(acc: DemoAccount, seasonId: string) {
  return acc.battlePasses.find((b) => b.seasonId === seasonId) ?? null;
}

export function addPassXp(acc: DemoAccount, amount: number): void {
  if (amount <= 0) return;
  const season = activeSeason();
  const pass = season ? BATTLE_PASSES.find((p) => p.seasonId === season.id) : undefined;
  if (!season || !pass) return;
  let bp = battlePassRow(acc, season.id);
  if (!bp) {
    bp = { seasonId: season.id, passId: pass.id, xp: 0, tier: 0, premium: false, claimedFree: [], claimedPremium: [] };
    acc.battlePasses.push(bp);
  }
  bp.xp += Math.floor(amount);
  bp.tier = passTierForXp(pass.id, bp.xp);
}

/** Advance quest objectives for every active quest row (the game server does this in the real backend). */
export function applyGameplayEvent(acc: DemoAccount, ev: GameplayEvent): void {
  for (const row of acc.quests) {
    if (row.status === "CLAIMED") continue;
    const def = QUESTS_BY_ID.get(row.questId);
    if (!def) continue;
    const r = applyQuestEvent(def, row.progress, ev);
    if (!r.changed) continue;
    row.progress = r.progress;
    if (r.completed && row.status !== "COMPLETED") {
      row.status = "COMPLETED";
      notify(acc, "QUEST_COMPLETED", "Mission complete", `${def.name} is ready to claim.`, { questId: def.id });
    }
  }
}

// ------------------------------------------------------------------ items

export function itemDef(itemId: string): ItemDef | undefined {
  return ITEMS_BY_ID.get(itemId);
}

/**
 * Grant items like apps/api lib/inventory.ts grantItems: stackable items merge into unlocked stacks
 * (up to maxStack) and overflow into new rows; non-stackable items create one row each.
 */
export function grantItems(acc: DemoAccount, items: readonly { itemId: string; quantity: number }[], opts: { skipUnknown?: boolean; upgradeLevel?: number; affixes?: { stat: string; value: number }[] } = {}): string[] {
  const created: string[] = [];
  const now = nowIso();
  for (const { itemId, quantity } of items) {
    if (quantity <= 0) continue;
    const def = itemDef(itemId);
    if (!def) {
      if (opts.skipUnknown) continue;
      throw badRequest("UNKNOWN_ITEM", `Unknown item ${itemId}`);
    }
    let remaining = Math.floor(quantity);
    if (def.stackable) {
      const maxStack = Math.max(1, def.maxStack);
      for (const s of acc.inventory) {
        if (remaining <= 0) break;
        if (s.itemId !== itemId || s.lockedBy || s.quantity >= maxStack) continue;
        const add = Math.min(remaining, maxStack - s.quantity);
        s.quantity += add;
        remaining -= add;
      }
      while (remaining > 0) {
        const q = Math.min(remaining, maxStack);
        const row: DemoItem = { id: newId("inv"), itemId, quantity: q, upgradeLevel: 0, affixes: [], lockedBy: null, bound: false, acquiredAt: now };
        acc.inventory.push(row);
        created.push(row.id);
        remaining -= q;
      }
    } else {
      for (let i = 0; i < remaining; i++) {
        const row: DemoItem = {
          id: newId("inv"), itemId, quantity: 1, upgradeLevel: opts.upgradeLevel ?? 0, affixes: opts.affixes ? [...opts.affixes] : [],
          lockedBy: null, bound: def.soulbound, acquiredAt: now,
        };
        acc.inventory.push(row);
        created.push(row.id);
      }
    }
  }
  return created;
}

export interface GrantResult { items: string[]; levelBefore: number; levelAfter: number }

/** apps/api lib/grants.ts grantBundle — crypto eligibility is never granted in the demo. */
export function grantBundle(acc: DemoAccount, bundle: RewardBundle, ref: string, reason: string): GrantResult {
  if (bundle.credits && bundle.credits > 0) credit(acc, "CREDITS", BigInt(Math.floor(bundle.credits)), "GAME_REWARD", ref, { reason });
  if (bundle.gems && bundle.gems > 0) credit(acc, "GEMS", BigInt(Math.floor(bundle.gems)), "GAME_REWARD", ref, { reason });
  const lv = addXpHonor(acc, bundle.xp ?? 0, bundle.honor ?? 0);
  if (bundle.seasonPoints && bundle.seasonPoints > 0) acc.seasonScore += Math.floor(bundle.seasonPoints);
  addPassXp(acc, bundle.passXp ?? 0);
  if (bundle.resources) addResources(acc, bundle.resources);
  const items = bundle.items?.length ? grantItems(acc, bundle.items) : [];
  return { items, levelBefore: lv.before, levelAfter: lv.after };
}

// ------------------------------------------------------------------ loadouts / ships

export function emptyLoadout(slots: ShipDef["slots"]): LoadoutConfig {
  return {
    weapons: Array<string | null>(slots.laser).fill(null),
    missiles: Array<string | null>(slots.missile).fill(null),
    generators: Array<string | null>(slots.generator).fill(null),
    modules: Array<string | null>(slots.module).fill(null),
    drones: Array<string | null>(slots.drone).fill(null),
    formation: "STANDARD",
    ammo: null,
    cosmetics: {},
  };
}

export function slotCount(slots: ShipDef["slots"], t: SlotType): number {
  switch (t) {
    case "weapons": return slots.laser;
    case "missiles": return slots.missile;
    case "generators": return slots.generator;
    case "modules": return slots.module;
    case "drones": return slots.drone;
  }
}

export function slotFamilyFor(def: ItemDef): SlotType | null {
  switch (def.category) {
    case "WEAPON":
      return def.ref && WEAPONS_BY_ID.get(def.ref)?.slot === "MISSILE" ? "missiles" : "weapons";
    case "GENERATOR":
      return "generators";
    case "MODULE":
      return "modules";
    case "DRONE":
      return "drones";
    default:
      return null;
  }
}

export function loadoutItemIds(c: LoadoutConfig): string[] {
  return [...c.weapons, ...c.missiles, ...c.generators, ...c.modules, ...c.drones].filter((x): x is string => Boolean(x));
}

export function loadoutDto(lo: DemoLoadout): LoadoutDto {
  const c = lo.config;
  return {
    id: lo.id, name: lo.name, preset: lo.preset, weapons: [...c.weapons], missiles: [...c.missiles], generators: [...c.generators],
    modules: [...c.modules], drones: [...c.drones], formation: c.formation, ammo: c.ammo, cosmetics: { ...c.cosmetics },
  };
}

/** inventoryItemId → shipInstanceId for every item referenced by any loadout. */
export function equippedMap(acc: DemoAccount): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of acc.ships) for (const lo of s.loadouts) for (const id of loadoutItemIds(lo.config)) out.set(id, s.id);
  return out;
}

/** Create a ship instance with an empty PVE loadout (apps/api lib/purchase.ts grantShip). */
export function grantShip(acc: DemoAccount, shipId: string): DemoShip {
  const def = SHIPS_BY_ID.get(shipId);
  if (!def) throw badRequest("UNKNOWN_SHIP", `Unknown ship ${shipId}`);
  const now = nowIso();
  const lo: DemoLoadout = { id: newId("lo"), name: "PVE", preset: "PVE", config: emptyLoadout(def.slots), createdAt: now };
  const ship: DemoShip = { id: newId("shp"), defId: def.id, upgradeLevel: 0, activeLoadoutId: lo.id, loadouts: [lo], cosmetics: {}, createdAt: now };
  acc.ships.push(ship);
  return ship;
}

/** apps/api lib/ships.ts computeShipStats — same @nebula/game-core formulas. */
export function computeShipStats(acc: DemoAccount, ship: DemoShip): { stats: Record<string, number>; gearScore: number } {
  const def = SHIPS_BY_ID.get(ship.defId);
  if (!def) return { stats: {}, gearScore: 0 };
  const lo = ship.loadouts.find((l) => l.id === ship.activeLoadoutId);
  const cfg = lo?.config ?? emptyLoadout(def.slots);
  const byId = new Map(acc.inventory.filter((i) => !i.lockedBy).map((i) => [i.id, i]));
  function equipped<D>(list: (string | null)[], resolve: (ref: string) => D | undefined): Equipped<D>[] {
    const out: Equipped<D>[] = [];
    for (const id of list) {
      if (!id) continue;
      const inv = byId.get(id);
      const ref = inv ? itemDef(inv.itemId)?.ref : undefined;
      const d = ref ? resolve(ref) : undefined;
      if (!inv || !d) continue;
      out.push({ def: d, upgradeLevel: inv.upgradeLevel, affixes: inv.affixes.map((a) => ({ stat: a.stat as StatKey, value: a.value })), inventoryItemId: inv.id });
    }
    return out;
  }
  const input: LoadoutInput = {
    ship: def,
    shipUpgradeLevel: ship.upgradeLevel,
    lasers: equipped<WeaponDef>(cfg.weapons, (r) => WEAPONS_BY_ID.get(r)),
    missiles: equipped<WeaponDef>(cfg.missiles, (r) => WEAPONS_BY_ID.get(r)),
    generators: equipped<ModuleDef>(cfg.generators, (r) => MODULES_BY_ID.get(r)),
    modules: equipped<ModuleDef>(cfg.modules, (r) => MODULES_BY_ID.get(r)),
    drones: equipped<DroneDef>(cfg.drones, (r) => DRONES_BY_ID.get(r)),
    factionBonus: FACTIONS_BY_ID.get(acc.faction ?? "")?.bonus,
    progression: PROGRESSION,
  };
  const eff = computeStats(input);
  const stats: Record<string, number> = {
    hull: eff.hull,
    shield: eff.shield,
    armor: eff.armor,
    energy: eff.energy,
    energyRegen: eff.energyRegen,
    shieldRegen: eff.shieldRegen,
    speed: eff.speed,
    acceleration: eff.acceleration,
    turnRate: eff.turnRate,
    cargo: eff.cargo,
    heatCapacity: eff.heatCapacity,
    weapons: eff.weapons.length,
  };
  for (const [k, v] of Object.entries(eff.pct)) stats[`pct_${k}`] = v;
  return { stats, gearScore: eff.gearScore };
}

export function shipDtos(acc: DemoAccount): ShipInstanceDto[] {
  return acc.ships.map((s) => {
    const computed = computeShipStats(acc, s);
    return {
      id: s.id,
      defId: s.defId,
      name: SHIPS_BY_ID.get(s.defId)?.name ?? s.defId,
      upgradeLevel: s.upgradeLevel,
      active: acc.activeShipId === s.id,
      loadouts: s.loadouts.map(loadoutDto),
      activeLoadoutId: s.activeLoadoutId,
      stats: computed.stats,
      gearScore: computed.gearScore,
      cosmetics: { ...s.cosmetics },
    };
  });
}

export function gearScoreOf(acc: DemoAccount): number {
  const ship = acc.ships.find((s) => s.id === acc.activeShipId);
  return ship ? computeShipStats(acc, ship).gearScore : 0;
}

// ------------------------------------------------------------------ DTOs

export function itemPower(def: ItemDef | undefined, upgradeLevel: number, affixes: { value: number }[]): number {
  if (!def?.powerItem) return 0;
  const rarity = RARITY_ORDER[def.rarity] ?? 0;
  const base = (rarity + 1) * 100 * (1 + upgradeLevel * PROGRESSION.upgrade.statPercentPerLevel);
  return Math.round(base + affixes.reduce((s, a) => s + Math.abs(a.value), 0));
}

export function inventoryDto(row: DemoItem, equippedOn: string | null): InventoryItemDto {
  const def = itemDef(row.itemId);
  return {
    id: row.id,
    itemId: row.itemId,
    name: def?.name ?? row.itemId,
    category: (def?.category ?? "CONSUMABLE") as ItemCategory,
    rarity: (def?.rarity ?? "COMMON") as Rarity,
    quantity: row.quantity,
    upgradeLevel: row.upgradeLevel,
    affixes: row.affixes.map((a) => ({ ...a })),
    equippedOn,
    tradeable: Boolean(def?.tradeable) && !def?.soulbound && !row.bound && !row.lockedBy,
    soulbound: Boolean(def?.soulbound) || row.bound,
    value: (def?.baseValue ?? 0) * row.quantity,
    power: itemPower(def, row.upgradeLevel, row.affixes),
    acquiredAt: row.acquiredAt,
  };
}

export function premiumActive(acc: DemoAccount): boolean {
  return Boolean(acc.premiumUntil && Date.parse(acc.premiumUntil) > Date.now());
}

export function inventoryCapacity(acc: DemoAccount): number {
  const tier = (premiumActive(acc) ? acc.premiumTier : "FREE") as keyof typeof ECONOMY.premium;
  const base = ECONOMY.premium[tier]?.inventorySlots ?? ECONOMY.premium.FREE.inventorySlots;
  return acc.testerKit ? base + TESTER_KIT.extraInventorySlots : base;
}

/**
 * Demo-only tester kit: so every system can be tried without grinding, a demo pilot receives every ship,
 * every item, large balances, all resources, max level and premium. Never exists outside the demo build.
 */
export const TESTER_KIT = {
  credits: 100_000_000n,
  gems: 1_000_000n,
  resourceEach: 50_000,
  /** Copies of each non-stackable item per category (weapons: enough for the widest laser/missile racks). */
  copies: { WEAPON: 4, MODULE: 2, GENERATOR: 3, DRONE: 4 } as Partial<Record<ItemCategory, number>>,
  stackQuantity: 500,
  extraInventorySlots: 600,
  premiumDays: 365,
} as const;

export function grantTesterKit(acc: DemoAccount): void {
  if (acc.testerKit) return;
  acc.testerKit = true;
  credit(acc, "CREDITS", TESTER_KIT.credits, "GAME_REWARD", "demo:tester-kit", { reason: "Demo tester kit" });
  credit(acc, "GEMS", TESTER_KIT.gems, "GAME_REWARD", "demo:tester-kit", { reason: "Demo tester kit" });
  addResources(acc, Object.fromEntries(RESOURCE_IDS.map((r) => [r, TESTER_KIT.resourceEach])));
  const owned = new Set(acc.ships.map((s) => s.defId));
  for (const ship of SHIPS) if (!owned.has(ship.id)) grantShip(acc, ship.id);
  for (const def of ITEMS) {
    // Ship tokens and raw resources are covered above (hangar ships / resource balances).
    if (def.category === "SHIP" || def.category === "RESOURCE") continue;
    const quantity = def.stackable ? Math.min(TESTER_KIT.stackQuantity, Math.max(1, def.maxStack) * 2) : (TESTER_KIT.copies[def.category] ?? 1);
    grantItems(acc, [{ itemId: def.id, quantity }], { skipUnknown: true });
  }
  acc.xp = Math.max(acc.xp, xpForLevel(PROGRESSION.maxLevel, PROGRESSION));
  syncLevel(acc);
  acc.premiumTier = "ELITE";
  acc.premiumUntil = new Date(Date.now() + TESTER_KIT.premiumDays * 86_400_000).toISOString();
  // Unlock every battle-pass tier on both tracks (rewards still have to be claimed on the pass page).
  addPassXp(acc, 100_000_000);
  const season = activeSeason();
  const bp = season ? battlePassRow(acc, season.id) : null;
  if (bp) bp.premium = true;
  fitTesterShips(acc);
  notify(acc, "SYSTEM", "Tester kit unlocked", "Every ship, item and resource has been added to your demo account so you can try everything.");
}

/** Fit score: rarer first, then raw output (DPS for weapons). */
function gearScore(def: ItemDef): number {
  const w = def.ref ? WEAPONS_BY_ID.get(def.ref) : undefined;
  return RARITY_ORDER[def.rarity] * 1_000_000 + (w ? w.damage * w.fireRate : 0);
}

/** Best combat item defs per slot family (mining lasers excluded: they cannot shoot ships). */
function fitCandidates(family: SlotType, level: number): ItemDef[] {
  return ITEMS.filter((d) => {
    if (slotFamilyFor(d) !== family || !d.ref) return false;
    const w = WEAPONS_BY_ID.get(d.ref);
    if (w && w.type === "MINING_LASER") return false;
    const req = w?.requiredLevel ?? MODULES_BY_ID.get(d.ref)?.requiredLevel ?? DRONES_BY_ID.get(d.ref)?.requiredLevel ?? 0;
    return req <= level;
  }).sort((a, b) => gearScore(b) - gearScore(a));
}

/**
 * Demo tester kit: every ship arrives with an empty loadout, so without this only the starter ship could
 * fire. Fits each ship whose loadouts carry no weapon at all: free inventory copies first, then fresh demo
 * copies of the best item for the slot. Ships the pilot already fitted are left untouched.
 */
export function fitTesterShips(acc: DemoAccount): void {
  if (!acc.testerKit || acc.testerFitted) return;
  acc.testerFitted = true;
  const used = new Set(acc.ships.flatMap((s) => s.loadouts.flatMap((l) => loadoutItemIds(l.config))));
  const take = (def: ItemDef): string => {
    const free = acc.inventory.find((i) => i.itemId === def.id && !i.lockedBy && !used.has(i.id));
    const id = free?.id ?? grantItems(acc, [{ itemId: def.id, quantity: 1 }])[0];
    if (!id) throw new Error(`could not grant ${def.id}`);
    used.add(id);
    return id;
  };
  for (const ship of acc.ships) {
    const def = SHIPS_BY_ID.get(ship.defId);
    const lo = ship.loadouts.find((l) => l.id === ship.activeLoadoutId) ?? ship.loadouts[0];
    if (!def || !lo) continue;
    const armed = ship.loadouts.some((l) => [...l.config.weapons, ...l.config.missiles].some(Boolean));
    if (armed) continue;
    for (const family of ["weapons", "missiles", "generators", "modules", "drones"] as const) {
      const n = slotCount(def.slots, family);
      const arr = lo.config[family];
      while (arr.length < n) arr.push(null);
      arr.length = n;
      const picks = fitCandidates(family, acc.level);
      if (!picks.length) continue;
      // Modules differ in effect: rotate through the best distinct ones; guns/missiles/drones stack the best.
      for (let i = 0; i < n; i++) {
        if (arr[i]) continue;
        const pick = family === "modules" || family === "generators" ? picks[i % Math.min(picks.length, n)] : picks[0];
        if (pick) arr[i] = take(pick);
      }
    }
  }
}

/** apps/api lib/me.ts buildMe. */
export function meDto(acc: DemoAccount): MeResponse {
  const p = levelProgress(acc.xp, PROGRESSION);
  const active = premiumActive(acc);
  const clan = acc.clan ? state().clans.find((c) => c.id === acc.clan?.id) : undefined;
  return {
    id: acc.id,
    username: acc.username,
    email: acc.email,
    level: acc.level,
    xp: acc.xp,
    xpToNext: p.xpToNext,
    xpIntoLevel: p.xpIntoLevel,
    honor: acc.honor,
    rank: rankId(acc),
    prestige: acc.prestige,
    faction: acc.faction,
    clan: clan && acc.clan ? { id: clan.id, name: clan.name, tag: clan.tag, role: acc.clan.role } : null,
    activeShipInstanceId: acc.activeShipId,
    premiumTier: active ? acc.premiumTier : "FREE",
    premiumUntil: active ? acc.premiumUntil : null,
    wallets: [],
    balances: balancesDto(acc),
    roles: [],
    createdAt: acc.createdAt,
    restrictions: [],
  };
}
