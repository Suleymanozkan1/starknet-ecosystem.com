/**
 * Typed access to the data-driven game content in packages/config/data/*.json,
 * plus id lookup maps and a referential-integrity validator.
 */
import type {
  AchievementDef, BattlePassDef, BlueprintDef, DroneDef, EconomyConfigDoc, EventDef, FactionDef, GalaxyDef,
  GateDef, ItemAffixDef, ItemDef, LootTableDef, MapDef, ModuleDef, NpcDef, NpcFactionDef, PetDef,
  ProgressionConfig, QuestDef, RewardBundle, SeasonDef, ShipDef, ShopProductDef, WeaponDef,
} from "@nebula/shared";
import { RESOURCE_IDS, RARITIES, DAMAGE_ELEMENTS } from "@nebula/shared";

import shipsJson from "../data/ships.json" with { type: "json" };
import weaponsJson from "../data/weapons.json" with { type: "json" };
import modulesJson from "../data/modules.json" with { type: "json" };
import dronesJson from "../data/drones.json" with { type: "json" };
import petsJson from "../data/pets.json" with { type: "json" };
import npcFactionsJson from "../data/npc_factions.json" with { type: "json" };
import npcsJson from "../data/npcs.json" with { type: "json" };
import lootTablesJson from "../data/loot_tables.json" with { type: "json" };
import itemsJson from "../data/items.json" with { type: "json" };
import itemAffixesJson from "../data/item_affixes.json" with { type: "json" };
import blueprintsJson from "../data/blueprints.json" with { type: "json" };
import mapsJson from "../data/maps.json" with { type: "json" };
import galaxyJson from "../data/galaxy.json" with { type: "json" };
import factionsJson from "../data/factions.json" with { type: "json" };
import questsJson from "../data/quests.json" with { type: "json" };
import achievementsJson from "../data/achievements.json" with { type: "json" };
import eventsJson from "../data/events.json" with { type: "json" };
import seasonsJson from "../data/seasons.json" with { type: "json" };
import battlepassJson from "../data/battlepass.json" with { type: "json" };
import gatesJson from "../data/gates.json" with { type: "json" };
import shopJson from "../data/shop.json" with { type: "json" };
import economyJson from "../data/economy.json" with { type: "json" };
import progressionJson from "../data/progression.json" with { type: "json" };

// JSON literals widen to `string`, so they are cast to the authoritative interfaces here.
// Shape conformance is enforced by validateGameData() and the config test-suite.
export const SHIPS = shipsJson as unknown as ShipDef[];
export const WEAPONS = weaponsJson as unknown as WeaponDef[];
export const MODULES = modulesJson as unknown as ModuleDef[];
export const DRONES = dronesJson as unknown as DroneDef[];
export const PETS = petsJson as unknown as PetDef[];
export const NPC_FACTIONS = npcFactionsJson as unknown as NpcFactionDef[];
export const NPCS = npcsJson as unknown as NpcDef[];
export const LOOT_TABLES = lootTablesJson as unknown as LootTableDef[];
export const ITEMS = itemsJson as unknown as ItemDef[];
export const ITEM_AFFIXES = itemAffixesJson as unknown as ItemAffixDef[];
export const BLUEPRINTS = blueprintsJson as unknown as BlueprintDef[];
export const MAPS = mapsJson as unknown as MapDef[];
export const GALAXY = galaxyJson as unknown as GalaxyDef;
export const FACTIONS = factionsJson as unknown as FactionDef[];
export const QUESTS = questsJson as unknown as QuestDef[];
export const ACHIEVEMENTS = achievementsJson as unknown as AchievementDef[];
export const EVENTS = eventsJson as unknown as EventDef[];
export const SEASONS = seasonsJson as unknown as SeasonDef[];
export const BATTLE_PASSES = battlepassJson as unknown as BattlePassDef[];
export const GATES = gatesJson as unknown as GateDef[];
export const SHOP = shopJson as unknown as ShopProductDef[];
export const ECONOMY = economyJson as unknown as EconomyConfigDoc;
export const PROGRESSION = progressionJson as unknown as ProgressionConfig;

function byId<T extends { id: string }>(list: readonly T[]): ReadonlyMap<string, T> {
  return new Map(list.map((x) => [x.id, x]));
}

export const SHIPS_BY_ID = byId(SHIPS);
export const WEAPONS_BY_ID = byId(WEAPONS);
export const MODULES_BY_ID = byId(MODULES);
export const DRONES_BY_ID = byId(DRONES);
export const PETS_BY_ID = byId(PETS);
export const NPC_FACTIONS_BY_ID = byId(NPC_FACTIONS);
export const NPCS_BY_ID = byId(NPCS);
export const LOOT_TABLES_BY_ID = byId(LOOT_TABLES);
export const ITEMS_BY_ID = byId(ITEMS);
export const ITEM_AFFIXES_BY_ID = byId(ITEM_AFFIXES);
export const BLUEPRINTS_BY_ID = byId(BLUEPRINTS);
export const MAPS_BY_ID = byId(MAPS);
export const FACTIONS_BY_ID = byId(FACTIONS);
export const QUESTS_BY_ID = byId(QUESTS);
export const ACHIEVEMENTS_BY_ID = byId(ACHIEVEMENTS);
export const EVENTS_BY_ID = byId(EVENTS);
export const SEASONS_BY_ID = byId(SEASONS);
export const BATTLE_PASSES_BY_ID = byId(BATTLE_PASSES);
export const GATES_BY_ID = byId(GATES);
export const SHOP_BY_ID = byId(SHOP);
export const SHOP_BY_SKU: ReadonlyMap<string, ShopProductDef> = new Map(SHOP.map((p) => [p.sku, p]));
/** Item id for a ship/weapon/module/drone/pet def id (convention: `item_<defId>`). */
export const itemIdForDef = (defId: string): string => `item_${defId}`;
/** Item id for a resource (convention: `res_<resourceid lowercase>`). */
export const itemIdForResource = (resourceId: string): string => `res_${resourceId.toLowerCase()}`;

export interface GameDataSet {
  ships: readonly ShipDef[]; weapons: readonly WeaponDef[]; modules: readonly ModuleDef[]; drones: readonly DroneDef[];
  pets: readonly PetDef[]; npcFactions: readonly NpcFactionDef[]; npcs: readonly NpcDef[]; lootTables: readonly LootTableDef[];
  items: readonly ItemDef[]; itemAffixes: readonly ItemAffixDef[]; blueprints: readonly BlueprintDef[]; maps: readonly MapDef[];
  galaxy: GalaxyDef; factions: readonly FactionDef[]; quests: readonly QuestDef[]; achievements: readonly AchievementDef[];
  events: readonly EventDef[]; seasons: readonly SeasonDef[]; battlePasses: readonly BattlePassDef[]; gates: readonly GateDef[];
  shop: readonly ShopProductDef[]; economy: EconomyConfigDoc; progression: ProgressionConfig;
}

export const GAME_DATA: GameDataSet = {
  ships: SHIPS, weapons: WEAPONS, modules: MODULES, drones: DRONES, pets: PETS, npcFactions: NPC_FACTIONS, npcs: NPCS,
  lootTables: LOOT_TABLES, items: ITEMS, itemAffixes: ITEM_AFFIXES, blueprints: BLUEPRINTS, maps: MAPS, galaxy: GALAXY,
  factions: FACTIONS, quests: QUESTS, achievements: ACHIEVEMENTS, events: EVENTS, seasons: SEASONS,
  battlePasses: BATTLE_PASSES, gates: GATES, shop: SHOP, economy: ECONOMY, progression: PROGRESSION,
};

const EPS = 1e-9;
const sum = (xs: Iterable<number>): number => { let s = 0; for (const x of xs) s += x; return s; };

/**
 * Cross-checks referential integrity of the whole data set.
 * Returns a list of human-readable errors (empty = valid).
 */
export function validateGameData(data: GameDataSet = GAME_DATA): string[] {
  const errors: string[] = [];
  const err = (m: string): void => { errors.push(m); };
  const ids = <T extends { id: string }>(name: string, list: readonly T[]): Set<string> => {
    const s = new Set<string>();
    for (const x of list) {
      if (s.has(x.id)) err(`${name}: duplicate id "${x.id}"`);
      s.add(x.id);
    }
    return s;
  };

  const shipIds = ids("ships", data.ships);
  const weaponIds = ids("weapons", data.weapons);
  const moduleIds = ids("modules", data.modules);
  const droneIds = ids("drones", data.drones);
  const petIds = ids("pets", data.pets);
  const npcFactionIds = ids("npc_factions", data.npcFactions);
  const npcIds = ids("npcs", data.npcs);
  const lootIds = ids("loot_tables", data.lootTables);
  const itemIds = ids("items", data.items);
  ids("item_affixes", data.itemAffixes);
  const bpIds = ids("blueprints", data.blueprints);
  const mapIds = ids("maps", data.maps);
  const factionIds = ids("factions", data.factions);
  const questIds = ids("quests", data.quests);
  ids("achievements", data.achievements);
  ids("events", data.events);
  const seasonIds = ids("seasons", data.seasons);
  const passIds = ids("battlepass", data.battlePasses);
  const gateIds = ids("gates", data.gates);
  ids("shop", data.shop);
  const resourceIds = new Set<string>(RESOURCE_IDS);
  const rarities = new Set<string>(RARITIES);
  const elements = new Set<string>(DAMAGE_ELEMENTS);
  const skus = new Set<string>();
  for (const p of data.shop) {
    if (skus.has(p.sku)) err(`shop: duplicate sku "${p.sku}"`);
    skus.add(p.sku);
  }

  const checkItem = (ctx: string, id: string): void => { if (!itemIds.has(id)) err(`${ctx}: unknown item "${id}"`); };
  const checkResources = (ctx: string, res: Partial<Record<string, number>> | undefined): void => {
    for (const k of Object.keys(res ?? {})) if (!resourceIds.has(k)) err(`${ctx}: unknown resource "${k}"`);
  };
  const checkBundle = (ctx: string, b: RewardBundle | undefined): void => {
    if (!b) return;
    checkResources(ctx, b.resources);
    for (const i of b.items ?? []) {
      checkItem(ctx, i.itemId);
      if (i.quantity <= 0) err(`${ctx}: non-positive quantity for "${i.itemId}"`);
    }
  };

  // Ships
  for (const s of data.ships) {
    const ctx = `ship ${s.id}`;
    if (!rarities.has(s.rarity)) err(`${ctx}: bad rarity ${s.rarity}`);
    if (s.faction && !factionIds.has(s.faction)) err(`${ctx}: unknown faction "${s.faction}"`);
    if (s.visual.hardpoints.length !== s.slots.laser + s.slots.missile) err(`${ctx}: hardpoints (${s.visual.hardpoints.length}) != laser+missile slots`);
    if (s.visual.nozzles.length === 0) err(`${ctx}: no nozzles`);
    const kinds = s.abilities.map((a) => a.kind).sort().join(",");
    if (kinds !== "ACTIVE,PASSIVE,ULTIMATE") err(`${ctx}: abilities must be PASSIVE/ACTIVE/ULTIMATE (got ${kinds})`);
    if (!itemIds.has(`item_${s.id}`)) err(`${ctx}: missing item entry item_${s.id}`);
  }
  const visualKeys = new Set(data.ships.map((s) => [s.visual.hull, s.visual.engine, s.visual.wings, s.visual.cockpit, s.visual.reactor, s.visual.armor, s.visual.antenna, s.visual.cargo].join("|")));
  if (visualKeys.size !== data.ships.length) err("ships: visual combinations are not unique");

  // Weapons / modules / drones / pets must have items
  for (const w of data.weapons) {
    if (!elements.has(w.element)) err(`weapon ${w.id}: bad element ${w.element}`);
    if (w.ammo) checkItem(`weapon ${w.id} ammo`, w.ammo);
    if (!itemIds.has(`item_${w.id}`)) err(`weapon ${w.id}: missing item entry`);
  }
  for (const m of data.modules) if (!itemIds.has(`item_${m.id}`)) err(`module ${m.id}: missing item entry`);
  for (const d of data.drones) if (!itemIds.has(`item_${d.id}`)) err(`drone ${d.id}: missing item entry`);

  // Items: refs
  for (const it of data.items) {
    const ctx = `item ${it.id}`;
    if (!rarities.has(it.rarity)) err(`${ctx}: bad rarity ${it.rarity}`);
    const refSets: Partial<Record<string, Set<string>>> = { SHIP: shipIds, WEAPON: weaponIds, MODULE: moduleIds, GENERATOR: moduleIds, DRONE: droneIds, PET: petIds, BLUEPRINT: bpIds };
    const set = refSets[it.category];
    if (set) {
      if (!it.ref) err(`${ctx}: category ${it.category} requires ref`);
      else if (!set.has(it.ref)) err(`${ctx}: unknown ref "${it.ref}"`);
    }
    if (it.category === "GENERATOR" && it.ref && data.modules.find((m) => m.id === it.ref)?.slot !== "GENERATOR") err(`${ctx}: GENERATOR item refs non-generator module`);
    if (it.cosmeticPayload?.shipId && !shipIds.has(it.cosmeticPayload.shipId)) err(`${ctx}: skin refs unknown ship "${it.cosmeticPayload.shipId}"`);
    if (it.soulbound && it.tradeable) err(`${ctx}: soulbound items cannot be tradeable`);
  }
  for (const r of RESOURCE_IDS) if (!itemIds.has(`res_${r.toLowerCase()}`)) err(`items: missing resource item res_${r.toLowerCase()}`);

  // Blueprints
  for (const b of data.blueprints) {
    checkItem(`blueprint ${b.id} output`, b.outputItem);
    checkResources(`blueprint ${b.id}`, b.resources);
    for (const i of b.items ?? []) checkItem(`blueprint ${b.id} input`, i.itemId);
    if (b.successChance <= 0 || b.successChance > 1) err(`blueprint ${b.id}: successChance out of range`);
  }

  // Loot tables
  for (const t of data.lootTables) {
    for (const e of t.entries) {
      const ctx = `loot ${t.id}`;
      if (e.min > e.max) err(`${ctx}: min > max for ${e.ref}`);
      switch (e.kind) {
        case "ITEM": checkItem(ctx, e.ref); break;
        case "RESOURCE": if (!resourceIds.has(e.ref)) err(`${ctx}: unknown resource "${e.ref}"`); break;
        case "BLUEPRINT": if (!bpIds.has(e.ref)) err(`${ctx}: unknown blueprint "${e.ref}"`); break;
        case "CREDITS": if (e.ref !== "CREDITS") err(`${ctx}: CREDITS entry ref must be "CREDITS"`); break;
        case "GEMS": if (e.ref !== "GEMS") err(`${ctx}: GEMS entry ref must be "GEMS"`); break;
      }
    }
  }

  // NPCs
  for (const n of data.npcs) {
    const ctx = `npc ${n.id}`;
    if (!npcFactionIds.has(n.faction)) err(`${ctx}: unknown npc faction "${n.faction}"`);
    if (!lootIds.has(n.lootTable)) err(`${ctx}: unknown loot table "${n.lootTable}"`);
    if (!elements.has(n.element)) err(`${ctx}: bad element ${n.element}`);
    if (n.kind === "BOSS") {
      if (!n.phases?.length) err(`${ctx}: boss without phases`);
      let prev = Infinity;
      for (const p of n.phases ?? []) {
        if (p.hullThreshold >= prev) err(`${ctx}: phase thresholds must descend`);
        prev = p.hullThreshold;
        if (p.adds && !npcIds.has(p.adds.npcId)) err(`${ctx}: phase ${p.id} adds unknown npc "${p.adds.npcId}"`);
      }
      if (n.phases?.[0]?.hullThreshold !== 1) err(`${ctx}: first phase must start at hullThreshold 1`);
    }
  }
  for (const f of data.npcFactions) {
    if (!elements.has(f.weakness) || !elements.has(f.resistance)) err(`npc faction ${f.id}: bad element`);
  }

  // Maps & portals
  const mapsById = new Map(data.maps.map((m) => [m.id, m]));
  const portalIdsGlobal = new Set<string>();
  for (const m of data.maps) {
    const ctx = `map ${m.id}`;
    const inside = (x: number, y: number): boolean => x >= 0 && y >= 0 && x <= m.width && y <= m.height;
    if (m.factionHome && !factionIds.has(m.factionHome)) err(`${ctx}: unknown factionHome`);
    for (const p of m.portals) {
      if (portalIdsGlobal.has(p.id)) err(`${ctx}: duplicate portal id "${p.id}"`);
      portalIdsGlobal.add(p.id);
      if (!inside(p.x, p.y)) err(`${ctx}: portal ${p.id} out of bounds`);
      const target = mapsById.get(p.targetMap);
      if (!target) { err(`${ctx}: portal ${p.id} targets unknown map "${p.targetMap}"`); continue; }
      const back = target.portals.find((tp) => tp.id === p.targetPortal);
      if (!back) err(`${ctx}: portal ${p.id} targets unknown portal "${p.targetPortal}" on ${p.targetMap}`);
      else if (back.targetMap !== m.id || back.targetPortal !== p.id) err(`${ctx}: portal ${p.id} is not reciprocated by ${p.targetMap}/${back.id}`);
    }
    for (const s of m.spawns) {
      if (!npcIds.has(s.npcId)) err(`${ctx}: spawn of unknown npc "${s.npcId}"`);
      if (!inside(s.x, s.y)) err(`${ctx}: spawn ${s.npcId} out of bounds`);
    }
    for (const a of m.asteroidFields) for (const r of a.resources) if (!resourceIds.has(r.id)) err(`${ctx}: asteroid unknown resource "${r.id}"`);
    for (const st of m.stations) {
      if (st.faction && !factionIds.has(st.faction)) err(`${ctx}: station ${st.id} unknown faction`);
      if (!inside(st.x, st.y)) err(`${ctx}: station ${st.id} out of bounds`);
    }
    for (const z of m.zones) if (!inside(z.x, z.y)) err(`${ctx}: zone ${z.id} out of bounds`);
    for (const dcr of m.decor) if (!inside(dcr.x, dcr.y)) err(`${ctx}: decor out of bounds`);
  }

  // Galaxy
  const galaxyMaps = new Set<string>();
  for (const sec of data.galaxy.sectors) {
    for (const sys of sec.systems) {
      for (const mid of sys.maps) {
        const m = mapsById.get(mid);
        if (!m) { err(`galaxy ${sys.id}: unknown map "${mid}"`); continue; }
        galaxyMaps.add(mid);
        if (m.sector !== sec.id || m.system !== sys.id) err(`galaxy: map ${mid} sector/system mismatch (${m.sector}/${m.system} vs ${sec.id}/${sys.id})`);
      }
    }
  }
  for (const m of data.maps) if (!galaxyMaps.has(m.id)) err(`galaxy: map ${m.id} not placed in any system`);

  // Factions
  const sectorIds = new Set(data.galaxy.sectors.map((s) => s.id));
  for (const f of data.factions) {
    const ctx = `faction ${f.id}`;
    if (!sectorIds.has(f.homeSector)) err(`${ctx}: unknown homeSector`);
    if (!mapIds.has(f.homeMap)) err(`${ctx}: unknown homeMap`);
    if (!shipIds.has(f.starterShip)) err(`${ctx}: unknown starterShip`);
    for (const w of f.starterLoadout.weapons) if (!weaponIds.has(w)) err(`${ctx}: unknown starter weapon "${w}"`);
    for (const m of f.starterLoadout.modules) if (!moduleIds.has(m)) err(`${ctx}: unknown starter module "${m}"`);
    for (const d of f.starterLoadout.drones) if (!droneIds.has(d)) err(`${ctx}: unknown starter drone "${d}"`);
    if (f.starterLoadout.pet !== undefined && !petIds.has(f.starterLoadout.pet)) err(`${ctx}: unknown starter pet "${f.starterLoadout.pet}"`);
    for (const a of f.starterLoadout.ammo ?? []) {
      checkItem(`${ctx} starter ammo`, a.itemId);
      if (!Number.isInteger(a.quantity) || a.quantity <= 0) err(`${ctx}: starter ammo "${a.itemId}" quantity must be a positive integer`);
    }
  }

  // Quests
  for (const q of data.quests) {
    const ctx = `quest ${q.id}`;
    for (const p of q.prerequisites) if (!questIds.has(p)) err(`${ctx}: unknown prerequisite "${p}"`);
    if (q.faction && !factionIds.has(q.faction)) err(`${ctx}: unknown faction`);
    for (const o of q.objectives) {
      if (o.map && !mapIds.has(o.map)) err(`${ctx}: unknown map "${o.map}"`);
      const t = o.target;
      if (!t) continue;
      switch (o.type) {
        case "KILL": case "DAMAGE_BOSS": case "ESCORT": if (!npcIds.has(t)) err(`${ctx}: unknown npc "${t}"`); break;
        case "TRAVEL": if (!mapIds.has(t)) err(`${ctx}: unknown map "${t}"`); break;
        case "COMPLETE_GATE": if (!gateIds.has(t)) err(`${ctx}: unknown gate "${t}"`); break;
        case "CRAFT": if (!bpIds.has(t)) err(`${ctx}: unknown blueprint "${t}"`); break;
        case "MINE_RESOURCES": case "COLLECT": case "DELIVER":
          if (!resourceIds.has(t) && !itemIds.has(t)) err(`${ctx}: unknown resource/item "${t}"`); break;
        default: break;
      }
    }
    checkBundle(ctx, q.rewards);
  }
  for (const a of data.achievements) checkBundle(`achievement ${a.id}`, a.rewards);

  // Events
  for (const e of data.events) {
    const ctx = `event ${e.id}`;
    if (!(Date.parse(e.startAt) < Date.parse(e.endAt))) err(`${ctx}: startAt must be before endAt`);
    for (const m of e.maps) if (!mapIds.has(m)) err(`${ctx}: unknown map "${m}"`);
    if (e.boss && !npcIds.has(e.boss)) err(`${ctx}: unknown boss "${e.boss}"`);
    for (const r of e.rewards) checkBundle(ctx, r.bundle);
  }

  // Seasons & battle passes
  for (const s of data.seasons) {
    const ctx = `season ${s.id}`;
    if (!npcIds.has(s.bossId)) err(`${ctx}: unknown boss`);
    if (!passIds.has(s.battlePassId)) err(`${ctx}: unknown battle pass`);
    if (!(Date.parse(s.startAt) < Date.parse(s.endAt))) err(`${ctx}: startAt must be before endAt`);
    for (const r of s.leaderboardRewards) checkBundle(ctx, r.bundle);
    for (const r of s.rankedRewards) checkBundle(ctx, r.bundle);
  }
  for (const bp of data.battlePasses) {
    const ctx = `battlepass ${bp.id}`;
    if (!seasonIds.has(bp.seasonId)) err(`${ctx}: unknown season`);
    if (!skus.has(bp.premiumProductSku)) err(`${ctx}: unknown premium sku "${bp.premiumProductSku}"`);
    let prevTier = 0; let prevXp = -1;
    for (const t of bp.tiers) {
      if (t.tier !== prevTier + 1) err(`${ctx}: tiers must ascend by 1 (got ${t.tier} after ${prevTier})`);
      if (t.xpRequired <= prevXp) err(`${ctx}: xpRequired must ascend at tier ${t.tier}`);
      prevTier = t.tier; prevXp = t.xpRequired;
      checkBundle(`${ctx} tier ${t.tier}`, t.free);
      checkBundle(`${ctx} tier ${t.tier}`, t.premium);
    }
  }

  // Gates
  for (const g of data.gates) {
    const ctx = `gate ${g.id}`;
    const gm = mapsById.get(g.map);
    if (!gm) err(`${ctx}: unknown map`);
    else if (gm.roomType !== "gate") err(`${ctx}: map ${g.map} is not a gate map`);
    checkResources(ctx, g.entryCost.resources);
    for (const w of g.waves) for (const n of w.npcs) if (!npcIds.has(n.npcId)) err(`${ctx}: wave ${w.name} unknown npc "${n.npcId}"`);
    checkBundle(ctx, g.rewards);
  }

  // Shop
  for (const p of data.shop) {
    const ctx = `shop ${p.sku}`;
    if (!Number.isInteger(p.price) || p.price < 0) err(`${ctx}: price must be a non-negative integer`);
    for (const s of p.grants.ships ?? []) if (!shipIds.has(s)) err(`${ctx}: unknown ship "${s}"`);
    checkBundle(ctx, p.grants);
  }

  // Economy
  const eco = data.economy;
  if (Math.abs(sum(Object.values(eco.rewardAllocation)) - 1) > EPS) err("economy: rewardAllocation must sum to 1");
  if (Math.abs(sum(Object.values(eco.tokenomics.allocation)) - 1) > EPS) err("economy: tokenomics.allocation must sum to 1");
  if (!(eco.treasuryHealth.healthy > eco.treasuryHealth.watch && eco.treasuryHealth.watch > eco.treasuryHealth.warning)) err("economy: treasuryHealth thresholds must descend");
  if (!(eco.caps.daily <= eco.caps.weekly && eco.caps.weekly <= eco.caps.season)) err("economy: caps must be daily <= weekly <= season");
  if (!(eco.withdrawal.min <= eco.withdrawal.max && eco.withdrawal.max <= eco.withdrawal.dailyLimit)) err("economy: withdrawal min <= max <= dailyLimit");

  // Progression
  let prevHonor = -1;
  for (const r of data.progression.ranks) {
    if (r.minHonor <= prevHonor) err(`progression: rank ${r.id} minHonor must ascend`);
    prevHonor = r.minHonor;
  }
  checkResources("progression.upgrade", data.progression.upgrade.resourceBase);

  return errors;
}
