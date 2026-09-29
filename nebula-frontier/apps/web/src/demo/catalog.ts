/**
 * Synthetic world for the demo: NPC pilots (leaderboards, clans, chat, bounties), a few clans, market
 * listings and auctions. Everything is generated deterministically from @nebula/config data (items,
 * factions, maps, economy fees) — prices are derived from each item's configured baseValue.
 */
import { ECONOMY, FACTIONS, ITEMS, MAPS } from "@nebula/config";
import { mulRatio, type ItemDef } from "@nebula/shared";
import { DEMO_RULES } from "./account.js";
import { nowIso, state, type DemoAuction, type DemoClan, type DemoMarketListing } from "./state.js";

/** Small deterministic PRNG so the synthetic world looks the same on every visit. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface NpcPilot {
  id: string;
  username: string;
  faction: string;
  level: number;
  honor: number;
  seasonScore: number;
  npcKills: number;
  playerKills: number;
  pvpWins: number;
  clanId: string | null;
}

const PILOT_NAMES = [
  "VexHalcyon", "Orin_Slate", "KiraNovak", "DriftMarrow", "Sable_Quill", "JunoPike", "Tarn_Voss", "MiraCinder", "Rook_Anselm",
  "LyraKestrel", "Cass_Ember", "NyxOrdell", "Bram_Tessel", "IdaWren", "Soren_Vale", "PaxHollow", "Rhea_Stroud", "Talon_Mercer",
  "EzraQuell", "Wyn_Castor", "ZoraFlint", "Cato_Riven", "Mael_Dusk", "Nova_Tamsin",
];

const CLAN_SPECS = [
  { name: "Silent Meridian", tag: "SMRD", description: "Patient hunters of the outer lanes. We fly together or not at all." },
  { name: "Ashen Covenant", tag: "ASHC", description: "Frontline wing for faction war nights. Voice comms encouraged." },
  { name: "Glasswake Miners", tag: "GLSW", description: "Prospectors and haulers. Deep-field mining runs every evening." },
  { name: "Starfall Lancers", tag: "SFL", description: "Boss raids, gate clears and the occasional bad idea." },
];

export const NPC_PILOTS: readonly NpcPilot[] = (() => {
  const rnd = mulberry32(0x5eed);
  return PILOT_NAMES.map((username, i) => {
    const level = 3 + Math.floor(rnd() * 38);
    const faction = FACTIONS[i % Math.max(1, FACTIONS.length)]?.id ?? "";
    return {
      id: `npc_pilot_${i + 1}`,
      username,
      faction,
      level,
      honor: Math.floor(level * level * (20 + rnd() * 60)),
      seasonScore: Math.floor(level * (100 + rnd() * 400)),
      npcKills: Math.floor(level * (15 + rnd() * 80)),
      playerKills: Math.floor(level * rnd() * 12),
      pvpWins: Math.floor(level * rnd() * 3),
      clanId: i < CLAN_SPECS.length * 4 ? `clan_demo_${(i % CLAN_SPECS.length) + 1}` : null,
    };
  });
})();

export const NPC_PILOTS_BY_ID: ReadonlyMap<string, NpcPilot> = new Map(NPC_PILOTS.map((p) => [p.id, p]));

function isTradeable(d: ItemDef): boolean {
  return d.tradeable && !d.soulbound && !d.cosmetic && d.baseValue > 0;
}

function seedClans(): DemoClan[] {
  const created = new Date(Date.now() - 45 * 86_400_000).toISOString();
  return CLAN_SPECS.map((c, i) => {
    const id = `clan_demo_${i + 1}`;
    const members = NPC_PILOTS.filter((p) => p.clanId === id);
    const faction = members[0]?.faction ?? FACTIONS[i % Math.max(1, FACTIONS.length)]?.id ?? null;
    const score = members.reduce((s, m) => s + m.seasonScore, 0);
    return {
      id,
      name: c.name,
      tag: c.tag,
      description: c.description,
      level: 2 + ((i * 3) % 7),
      score: String(score),
      factionId: faction,
      announcement: "Clan ops tonight — bring repair kits.",
      treasury: String(score * 10),
      members: members.map((m, j) => ({
        userId: m.id, username: m.username, level: m.level, role: j === 0 ? "LEADER" : j === 1 ? "OFFICER" : "MEMBER",
        contribution: String(m.seasonScore * 3), joinedAt: created,
      })),
      territories: MAPS.filter((m) => m.factionHome === faction).slice(0, 1).map((m) => m.id),
      createdAt: created,
    };
  });
}

function seedMarket(): DemoMarketListing[] {
  const rnd = mulberry32(0xa11ce);
  const pool = ITEMS.filter(isTradeable);
  const out: DemoMarketListing[] = [];
  const now = Date.now();
  for (let i = 0; i < Math.min(12, pool.length); i++) {
    const def = pool[Math.floor(rnd() * pool.length)];
    const seller = NPC_PILOTS[Math.floor(rnd() * NPC_PILOTS.length)];
    if (!def || !seller || out.some((l) => l.itemId === def.id)) continue;
    const quantity = def.stackable ? Math.min(def.maxStack, 5 + Math.floor(rnd() * 45)) : 1;
    const price = BigInt(Math.max(1, Math.round(def.baseValue * quantity * (0.9 + rnd() * 0.6))));
    out.push({
      id: `mkt_demo_${i + 1}`,
      sellerId: seller.id,
      seller: seller.username,
      inventoryItemId: null,
      itemId: def.id,
      quantity,
      upgradeLevel: def.powerItem && !def.stackable ? Math.floor(rnd() * 4) : 0,
      affixes: [],
      price: price.toString(),
      currency: "CREDITS",
      fee: mulRatio(price, ECONOMY.fees.marketplace).toString(),
      status: "ACTIVE",
      expiresAt: new Date(now + (12 + Math.floor(rnd() * 36)) * 3_600_000).toISOString(),
      createdAt: new Date(now - Math.floor(rnd() * 20) * 3_600_000).toISOString(),
    });
  }
  return out;
}

const AUCTION_TYPES = ["HOURLY", "DAILY", "WEEKLY"] as const;

function seedAuctions(): DemoAuction[] {
  const rnd = mulberry32(0xb1d5);
  const pool = ITEMS.filter((d) => isTradeable(d) && d.powerItem);
  const out: DemoAuction[] = [];
  const now = Date.now();
  for (let i = 0; i < Math.min(6, pool.length); i++) {
    const def = pool[Math.floor(rnd() * pool.length)];
    const seller = NPC_PILOTS[Math.floor(rnd() * NPC_PILOTS.length)];
    if (!def || !seller || out.some((a) => a.itemId === def.id)) continue;
    const type = AUCTION_TYPES[i % AUCTION_TYPES.length] ?? "DAILY";
    const start = BigInt(Math.max(1, Math.round(def.baseValue * (0.5 + rnd() * 0.3))));
    const hasBid = rnd() < 0.5;
    out.push({
      id: `auc_demo_${i + 1}`,
      sellerId: seller.id,
      inventoryItemId: null,
      itemId: def.id,
      quantity: 1,
      type,
      currency: "CREDITS",
      startPrice: start.toString(),
      buyoutPrice: (start * 3n).toString(),
      currentBid: hasBid ? (start + mulRatio(start, 0.2)).toString() : null,
      currentBidderId: hasBid ? (NPC_PILOTS[(i + 5) % NPC_PILOTS.length]?.id ?? null) : null,
      listingFee: mulRatio(start, ECONOMY.fees.auctionListing).toString(),
      status: "ACTIVE",
      endsAt: new Date(now + Math.max(0.25, rnd()) * DEMO_RULES.auctionDurationsHours[type] * 3_600_000).toISOString(),
      createdAt: nowIso(),
    });
  }
  return out;
}

/** Make sure the synthetic world exists and keeps looking "live" (expired NPC offers are renewed). */
export function ensureWorld(): void {
  const s = state();
  if (!s.clans.length) s.clans = seedClans();
  if (!s.market.length) s.market = seedMarket();
  if (!s.auctions.length) s.auctions = seedAuctions();
  const now = Date.now();
  for (const l of s.market) {
    if (l.inventoryItemId === null && l.status === "ACTIVE" && Date.parse(l.expiresAt) <= now) l.expiresAt = new Date(now + 24 * 3_600_000).toISOString();
  }
  for (const a of s.auctions) {
    if (a.inventoryItemId === null && a.status === "ACTIVE" && Date.parse(a.endsAt) <= now) {
      a.endsAt = new Date(now + DEMO_RULES.auctionDurationsHours[a.type] * 3_600_000).toISOString();
    }
  }
}

const CHAT_LINES: Record<string, readonly string[]> = {
  GLOBAL: [
    "Anyone running the gate tonight? Need two more.",
    "Boss spawned near the nebula rim, bring shields.",
    "Tip for new pilots: dock at the station to repair for cheap.",
    "Just hit +5 on my laser, finally.",
    "Watch out, pirates camping the east portal again.",
  ],
  FACTION: [
    "Faction war starts soon, rally at home station.",
    "We are two sectors ahead this week, keep pushing!",
    "Escort needed for a mining convoy.",
  ],
  SYSTEM: ["Welcome to the Nebula Frontier demo. This chat is simulated."],
};

export function chatLines(channel: string): readonly string[] {
  return CHAT_LINES[channel] ?? [];
}

/** Synthetic bounties (target pilots with totals in multiples of the minimum bounty). */
export function syntheticBounties(): { targetId: string; username: string; level: number; total: string; count: number }[] {
  return NPC_PILOTS.filter((_, i) => i % 7 === 2).map((p, i) => ({
    targetId: p.id, username: p.username, level: p.level, total: String(DEMO_RULES.bountyMin * (6 - i * 2 > 0 ? 6 - i * 2 : 1)), count: 3 - Math.min(2, i),
  }));
}
