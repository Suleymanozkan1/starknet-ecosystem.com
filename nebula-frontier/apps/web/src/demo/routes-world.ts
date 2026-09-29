/**
 * Demo routes for the shared world: leaderboards, market, auctions, clans, social (squad/friends/chat/
 * notifications/mail/bounties), achievements, battle pass, seasons, events and galaxy data.
 * Mirrors apps/api/src/routes/{leaderboard,market,auctions,clans,social,progress,season,galaxy}.ts; other
 * players are the synthetic NPC pilots from ./catalog.ts.
 */
import { ACHIEVEMENTS, ACHIEVEMENTS_BY_ID, BATTLE_PASSES, ECONOMY, EVENTS, FACTIONS, GALAXY, GATES, ITEMS_BY_ID, MAPS, MAPS_BY_ID, SEASONS, SHOP_BY_SKU } from "@nebula/config";
import { mulRatio, type LeaderboardResponse, type RewardBundle } from "@nebula/shared";
import {
  auctionBidSchema, auctionCreateSchema, battlePassClaimSchema, chatHistoryQuerySchema, clanCreateSchema, defIdSchema, idSchema, leaderboardQuerySchema,
  marketListSchema, marketQuerySchema, notificationReadSchema, z,
} from "@nebula/validation";
import type {
  AchievementDto, AuctionDto, AuctionsResponse, BattlePassResponse, BountyDto, ChatMessageDto, ClanDetailDto, ClanSummaryDto, ClanWarDto, FriendsResponse,
  GameEventDto, MailDto, MapLiveResponse, MarketListingDto, MarketResponse, NotificationsResponse, SeasonDto,
} from "../lib/dto.js";
import {
  DEMO_RULES, activeSeason, balanceOf, battlePassRow, credit, debit, equippedMap, grantBundle, grantItems, itemDef, notify,
} from "./account.js";
import { NPC_PILOTS, chatLines, ensureWorld, syntheticBounties } from "./catalog.js";
import { activeEventWindow, newlyUnlockedAchievements, nextEventWindow } from "./core.js";
import { badRequest, conflict, demoDisabled, forbidden, insufficientBalance, notFound, parse } from "./errors.js";
import { q, cleanQuery, requireAccount, route } from "./router.js";
import { newId, nowIso, state, type DemoAccount, type DemoAuction, type DemoItem, type DemoMarketListing } from "./state.js";

type Ok = { ok: boolean };
const disabled = (message?: string) => () => {
  throw demoDisabled(message);
};

// ------------------------------------------------------------------ leaderboard

type Entry = LeaderboardResponse["entries"][number];

function clanTagOf(clanId: string | null): string | null {
  return clanId ? (state().clans.find((c) => c.id === clanId)?.tag ?? null) : null;
}

route("GET", "/api/leaderboard", (c): LeaderboardResponse => {
  ensureWorld();
  const query = parse(leaderboardQuerySchema, cleanQuery(c.query));
  const me = state().sessionUserId ? state().accounts[state().sessionUserId ?? ""] : undefined;
  const season = activeSeason()?.id ?? null;
  let entries: Entry[];
  if (query.board === "faction") {
    const rows = FACTIONS.map((f) => {
      const pilots = NPC_PILOTS.filter((p) => p.faction === f.id);
      const mine = me?.faction === f.id ? me.seasonScore : 0;
      return { f, score: pilots.reduce((s, p) => s + p.seasonScore, 0) + mine, territory: MAPS.filter((m) => m.factionHome === f.id).length };
    }).sort((a, b) => b.score - a.score);
    entries = rows.slice(0, query.limit).map((r, i) => ({ rank: i + 1, userId: r.f.id, username: r.f.name, faction: r.f.id, clanTag: r.f.tag, score: String(r.score), level: r.territory }));
  } else if (query.board === "clan") {
    const rows = [...state().clans].sort((a, b) => Number(BigInt(b.score) - BigInt(a.score)));
    entries = rows.slice(0, query.limit).map((cl, i) => ({ rank: i + 1, userId: cl.id, username: cl.name, faction: cl.factionId, clanTag: cl.tag, score: cl.score, level: cl.level }));
  } else {
    const metric = (p: { npcKills: number; playerKills: number; honor: number; seasonScore: number }): number =>
      query.board === "pvp_kills" ? p.playerKills : query.board === "npc_kills" ? p.npcKills : query.board === "honor" ? p.honor : p.seasonScore;
    const rows = NPC_PILOTS.map((p): Omit<Entry, "rank" | "score"> & { score: number } => ({ userId: p.id, username: p.username, faction: p.faction, clanTag: clanTagOf(p.clanId), score: metric(p), level: p.level }));
    if (me) {
      rows.push({
        userId: me.id, username: me.username, faction: me.faction, clanTag: clanTagOf(me.clan?.id ?? null),
        score: metric({ npcKills: me.stats.npcKills, playerKills: me.stats.playerKills, honor: me.honor, seasonScore: me.seasonScore }), level: me.level,
      });
    }
    rows.sort((a, b) => b.score - a.score);
    entries = rows.slice(0, query.limit).map((r, i) => ({ ...r, rank: i + 1, score: String(r.score) }));
  }
  return { board: query.board, season: query.board === "season_score" || query.board === "faction" ? season : null, entries };
});

// ------------------------------------------------------------------ market

function listingDto(l: DemoMarketListing): MarketListingDto {
  const def = itemDef(l.itemId);
  return {
    id: l.id, sellerId: l.sellerId, seller: l.seller, itemId: l.itemId, name: def?.name ?? l.itemId, category: def?.category ?? null, rarity: def?.rarity ?? null,
    quantity: l.quantity, upgradeLevel: l.upgradeLevel, affixes: l.affixes.map((a) => ({ ...a })), price: l.price, currency: l.currency, fee: l.fee,
    sellerReceives: (BigInt(l.price) - BigInt(l.fee)).toString(), status: l.status, expiresAt: l.expiresAt, createdAt: l.createdAt,
  };
}

/** Move `quantity` of an owned, tradeable, unequipped item into escrow (apps/api lib/escrow.ts). */
function escrowItem(acc: DemoAccount, inventoryItemId: string, quantity: number, lockId: string): DemoItem {
  const item = acc.inventory.find((i) => i.id === inventoryItemId);
  if (!item) throw notFound("Item");
  if (item.lockedBy) throw conflict("ITEM_LOCKED", "Item is already listed or in escrow");
  const def = itemDef(item.itemId);
  if (!def?.tradeable || def.soulbound || item.bound) throw badRequest("NOT_TRADEABLE", "This item cannot be traded");
  if (equippedMap(acc).has(item.id)) throw badRequest("ITEM_EQUIPPED", "Unequip the item first");
  if (quantity > item.quantity) throw badRequest("INSUFFICIENT_QUANTITY", "Not enough items in this stack");
  if (quantity === item.quantity) {
    item.lockedBy = lockId;
    return item;
  }
  item.quantity -= quantity;
  const part: DemoItem = { ...item, id: newId("inv"), quantity, affixes: item.affixes.map((a) => ({ ...a })), lockedBy: lockId };
  acc.inventory.push(part);
  return part;
}

function releaseEscrow(acc: DemoAccount, inventoryItemId: string | null): void {
  const item = inventoryItemId ? acc.inventory.find((i) => i.id === inventoryItemId) : undefined;
  if (item) item.lockedBy = null;
}

route("GET", "/api/market", (c): MarketResponse => {
  ensureWorld();
  const query = parse(marketQuerySchema, cleanQuery(c.query));
  const now = Date.now();
  const rows = state().market
    .filter((l) => l.status === "ACTIVE" && Date.parse(l.expiresAt) > now)
    .filter((l) => !query.itemId || l.itemId === query.itemId)
    .filter((l) => {
      const def = itemDef(l.itemId);
      return (!query.category || def?.category === query.category) && (!query.rarity || def?.rarity === query.rarity);
    })
    .filter((l) => !query.currency || l.currency === query.currency)
    .sort((a, b) => {
      if (query.sort === "recent") return b.createdAt.localeCompare(a.createdAt);
      const d = BigInt(a.price) - BigInt(b.price);
      const cmp = d < 0n ? -1 : d > 0n ? 1 : 0;
      return query.sort === "price_asc" ? cmp : -cmp;
    })
    .slice(0, query.limit);
  return { listings: rows.map(listingDto), feeRate: ECONOMY.fees.marketplace };
});

route("GET", "/api/market/mine", (): MarketResponse => {
  const acc = requireAccount();
  return { listings: state().market.filter((l) => l.sellerId === acc.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(listingDto) };
});

route("POST", "/api/market/list", (c) => {
  const acc = requireAccount();
  ensureWorld();
  const body = parse(marketListSchema, c.body);
  if (body.currency === "NEBX") throw demoDisabled("Crypto-priced listings are disabled in the demo");
  if (state().market.filter((l) => l.sellerId === acc.id && l.status === "ACTIVE").length >= DEMO_RULES.marketMaxActiveListings) {
    throw badRequest("TOO_MANY_LISTINGS", "Too many active listings");
  }
  const id = newId("mkt");
  const item = escrowItem(acc, body.inventoryItemId, body.quantity, `listing:${id}`);
  const listing: DemoMarketListing = {
    id, sellerId: acc.id, seller: acc.username, inventoryItemId: item.id, itemId: item.itemId, quantity: item.quantity, upgradeLevel: item.upgradeLevel,
    affixes: item.affixes.map((a) => ({ ...a })), price: body.price.toString(), currency: body.currency, fee: mulRatio(body.price, ECONOMY.fees.marketplace).toString(),
    status: "ACTIVE", expiresAt: new Date(Date.now() + body.durationHours * 3_600_000).toISOString(), createdAt: nowIso(),
  };
  state().market.unshift(listing);
  return { listing: listingDto(listing), feeRate: ECONOMY.fees.marketplace };
});

route("POST", "/api/market/buy/:id", (c) => {
  const acc = requireAccount();
  ensureWorld();
  const listingId = parse(idSchema, c.params.id);
  const listing = state().market.find((l) => l.id === listingId);
  if (!listing) throw notFound("Listing");
  if (listing.status !== "ACTIVE" || Date.parse(listing.expiresAt) <= Date.now()) throw conflict("LISTING_UNAVAILABLE", "Listing is no longer available");
  if (listing.sellerId === acc.id) throw badRequest("OWN_LISTING", "You cannot buy your own listing");
  if (listing.currency !== "CREDITS" && listing.currency !== "GEMS") throw demoDisabled("Crypto-priced listings are disabled in the demo");
  const price = BigInt(listing.price);
  const fee = BigInt(listing.fee);
  if (balanceOf(acc, listing.currency) < price) throw insufficientBalance();
  debit(acc, listing.currency, price - fee, "TRADE", listing.id, { listingId: listing.id, itemId: listing.itemId, sellerId: listing.sellerId });
  debit(acc, listing.currency, fee, "MARKETPLACE_FEE", listing.id, { listingId: listing.id });
  listing.status = "SOLD";
  const def = ITEMS_BY_ID.get(listing.itemId);
  const [invId] = grantItems(acc, [{ itemId: listing.itemId, quantity: listing.quantity }], {
    skipUnknown: true, upgradeLevel: def?.stackable ? 0 : listing.upgradeLevel, affixes: listing.affixes,
  });
  return { ok: true, listingId: listing.id, inventoryItemId: invId ?? null };
});

route("POST", "/api/market/cancel/:id", (c) => {
  const acc = requireAccount();
  const listingId = parse(idSchema, c.params.id);
  const listing = state().market.find((l) => l.id === listingId && l.sellerId === acc.id);
  if (!listing) throw notFound("Listing");
  if (listing.status !== "ACTIVE") throw conflict("LISTING_UNAVAILABLE", "Listing is no longer active");
  listing.status = "CANCELLED";
  releaseEscrow(acc, listing.inventoryItemId);
  return { ok: true };
});

// ------------------------------------------------------------------ auctions

function minNextBid(current: bigint | null, start: bigint): bigint {
  if (current === null) return start;
  const inc = mulRatio(current, DEMO_RULES.auctionMinIncrementPct);
  return current + (inc < 1n ? 1n : inc);
}

function auctionDto(a: DemoAuction): AuctionDto {
  const def = itemDef(a.itemId);
  return {
    id: a.id, sellerId: a.sellerId, itemId: a.itemId, name: def?.name ?? a.itemId, rarity: def?.rarity ?? null, quantity: a.quantity, type: a.type,
    currency: a.currency, startPrice: a.startPrice, buyoutPrice: a.buyoutPrice, currentBid: a.currentBid, currentBidderId: a.currentBidderId,
    listingFee: a.listingFee, minNextBid: minNextBid(a.currentBid === null ? null : BigInt(a.currentBid), BigInt(a.startPrice)).toString(),
    status: a.status, endsAt: a.endsAt, createdAt: a.createdAt,
  };
}

const auctionFees = () => ({ listing: ECONOMY.fees.auctionListing, sale: ECONOMY.fees.auctionSale, cancellation: ECONOMY.fees.auctionCancellation });

function activeAuction(id: string): DemoAuction {
  ensureWorld();
  const a = state().auctions.find((x) => x.id === id);
  if (!a) throw notFound("Auction");
  if (a.status !== "ACTIVE" || Date.parse(a.endsAt) <= Date.now()) throw conflict("AUCTION_CLOSED", "Auction is no longer active");
  return a;
}

/** Refund the pilot's escrowed bid when they are outbid / the auction is bought out. */
function refundBid(acc: DemoAccount, a: DemoAuction): void {
  if (a.currentBidderId === acc.id && a.currentBid) credit(acc, a.currency, BigInt(a.currentBid), "REFUND", a.id, { auctionId: a.id, kind: "BID_REFUND" });
}

route("GET", "/api/auctions", (c): AuctionsResponse => {
  ensureWorld();
  const query = parse(z.object({ type: z.enum(["HOURLY", "DAILY", "WEEKLY", "EVENT"]).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }), cleanQuery(c.query));
  const now = Date.now();
  const rows = state().auctions
    .filter((a) => a.status === "ACTIVE" && Date.parse(a.endsAt) > now && (!query.type || a.type === query.type))
    .sort((a, b) => a.endsAt.localeCompare(b.endsAt))
    .slice(0, query.limit);
  return { auctions: rows.map(auctionDto), fees: auctionFees() };
});

route("GET", "/api/auctions/:id", (c) => {
  ensureWorld();
  const a = state().auctions.find((x) => x.id === c.params.id);
  if (!a) throw notFound("Auction");
  return { auction: auctionDto(a), bids: [] };
});

route("POST", "/api/auctions", (c) => {
  const acc = requireAccount();
  ensureWorld();
  const body = parse(auctionCreateSchema, c.body);
  if (body.buyoutPrice !== undefined && body.buyoutPrice <= body.startPrice) throw badRequest("INVALID_BUYOUT", "Buyout must exceed the start price");
  const id = newId("auc");
  const listingFee = mulRatio(body.startPrice, ECONOMY.fees.auctionListing);
  if (balanceOf(acc, body.currency) < listingFee) throw insufficientBalance();
  const item = escrowItem(acc, body.inventoryItemId, body.quantity, `auction:${id}`);
  debit(acc, body.currency, listingFee, "AUCTION_FEE", id, { auctionId: id, kind: "LISTING_FEE" });
  const a: DemoAuction = {
    id, sellerId: acc.id, inventoryItemId: item.id, itemId: item.itemId, quantity: item.quantity, type: body.type, currency: body.currency,
    startPrice: body.startPrice.toString(), buyoutPrice: body.buyoutPrice?.toString() ?? null, currentBid: null, currentBidderId: null,
    listingFee: listingFee.toString(), status: "ACTIVE", endsAt: new Date(Date.now() + DEMO_RULES.auctionDurationsHours[body.type] * 3_600_000).toISOString(),
    createdAt: nowIso(),
  };
  state().auctions.push(a);
  return { auction: auctionDto(a) };
});

route("POST", "/api/auctions/:id/bid", (c) => {
  const acc = requireAccount();
  const a = activeAuction(parse(idSchema, c.params.id));
  const { amount } = parse(auctionBidSchema, c.body);
  if (a.sellerId === acc.id) throw badRequest("OWN_AUCTION", "You cannot bid on your own auction");
  if (a.currentBidderId === acc.id) throw badRequest("ALREADY_HIGHEST", "You are already the highest bidder");
  const min = minNextBid(a.currentBid === null ? null : BigInt(a.currentBid), BigInt(a.startPrice));
  if (amount < min) throw badRequest("BID_TOO_LOW", `Minimum bid is ${min.toString()}`);
  if (a.buyoutPrice && amount >= BigInt(a.buyoutPrice)) throw badRequest("USE_BUYOUT", "Bid reaches the buyout price — use buyout instead");
  debit(acc, a.currency, amount, "ESCROW", a.id, { auctionId: a.id, kind: "BID" });
  a.currentBid = amount.toString();
  a.currentBidderId = acc.id;
  const left = Date.parse(a.endsAt) - Date.now();
  if (left < DEMO_RULES.auctionAntiSnipeSeconds * 1000) a.endsAt = new Date(Date.now() + DEMO_RULES.auctionAntiSnipeSeconds * 1000).toISOString();
  return { auction: auctionDto(a) };
});

route("POST", "/api/auctions/:id/buyout", (c) => {
  const acc = requireAccount();
  const a = activeAuction(parse(idSchema, c.params.id));
  if (a.sellerId === acc.id) throw badRequest("OWN_AUCTION", "You cannot buy your own auction");
  if (!a.buyoutPrice) throw badRequest("NO_BUYOUT", "This auction has no buyout price");
  const price = BigInt(a.buyoutPrice);
  const refund = a.currentBidderId === acc.id && a.currentBid ? BigInt(a.currentBid) : 0n;
  if (balanceOf(acc, a.currency) + refund < price) throw insufficientBalance();
  refundBid(acc, a);
  debit(acc, a.currency, price, "TRADE", a.id, { auctionId: a.id, kind: "BUYOUT" });
  a.status = "SOLD";
  a.currentBid = price.toString();
  a.currentBidderId = acc.id;
  grantItems(acc, [{ itemId: a.itemId, quantity: a.quantity }], { skipUnknown: true });
  return { ok: true, auctionId: a.id };
});

route("POST", "/api/auctions/:id/cancel", (c) => {
  const acc = requireAccount();
  const a = state().auctions.find((x) => x.id === parse(idSchema, c.params.id) && x.sellerId === acc.id);
  if (!a) throw notFound("Auction");
  if (a.status !== "ACTIVE") throw conflict("AUCTION_CLOSED", "Auction is no longer active");
  if (a.currentBid) throw badRequest("HAS_BIDS", "Auctions with bids cannot be cancelled");
  debit(acc, a.currency, mulRatio(BigInt(a.startPrice), ECONOMY.fees.auctionCancellation), "AUCTION_FEE", a.id, { auctionId: a.id, kind: "CANCELLATION_FEE" });
  a.status = "CANCELLED";
  releaseEscrow(acc, a.inventoryItemId);
  return { ok: true };
});

// ------------------------------------------------------------------ clans

function clanSummary(cl: ReturnType<typeof state>["clans"][number]): ClanSummaryDto {
  return { id: cl.id, name: cl.name, tag: cl.tag, level: cl.level, score: cl.score, members: cl.members.length + pilotsInClan(cl.id).length, factionId: cl.factionId };
}

function pilotsInClan(clanId: string): DemoAccount[] {
  return Object.values(state().accounts).filter((a) => a.clan?.id === clanId);
}

route("GET", "/api/clans", (c): { clans: ClanSummaryDto[] } => {
  ensureWorld();
  const search = q(c.query, "search")?.toLowerCase();
  const rows = state().clans
    .filter((cl) => !search || cl.name.toLowerCase().includes(search) || cl.tag.includes(search.toUpperCase()))
    .sort((a, b) => Number(BigInt(b.score) - BigInt(a.score)));
  return { clans: rows.map(clanSummary) };
});

route("GET", "/api/clans/ranking", () => {
  ensureWorld();
  const rows = [...state().clans].sort((a, b) => Number(BigInt(b.score) - BigInt(a.score)) || b.level - a.level);
  return { ranking: rows.map((cl, i) => ({ rank: i + 1, ...clanSummary(cl), territories: cl.territories.length })) };
});

route("GET", "/api/clans/:id", (c): ClanDetailDto => {
  ensureWorld();
  const cl = state().clans.find((x) => x.id === parse(idSchema, c.params.id));
  if (!cl) throw notFound("Clan");
  const me = state().sessionUserId ? state().accounts[state().sessionUserId ?? ""] : undefined;
  const isMember = Boolean(me && me.clan?.id === cl.id);
  const pilots = pilotsInClan(cl.id).map((a) => ({
    userId: a.id, username: a.username, level: a.level, role: a.clan?.role ?? "MEMBER", contribution: "0", joinedAt: a.clan?.joinedAt ?? cl.createdAt,
  }));
  return {
    id: cl.id, name: cl.name, tag: cl.tag, description: cl.description, level: cl.level, score: cl.score, factionId: cl.factionId,
    announcement: isMember ? cl.announcement : null, treasury: isMember ? cl.treasury : null, diplomacy: {},
    members: [...cl.members, ...pilots], stations: [], territories: [...cl.territories],
  };
});

route("GET", "/api/clans/:id/wars", (c): { wars: ClanWarDto[] } => {
  ensureWorld();
  const clans = state().clans;
  const cl = clans.find((x) => x.id === parse(idSchema, c.params.id));
  if (!cl) throw notFound("Clan");
  const idx = clans.indexOf(cl);
  const rival = clans[(idx + 1) % clans.length];
  if (!rival || rival.id === cl.id || !cl.id.startsWith("clan_demo_")) return { wars: [] };
  const start = Date.now() - 2 * 86_400_000;
  return {
    wars: [{
      id: `war_demo_${idx + 1}`, clanAId: cl.id, clanBId: rival.id, phase: "ENDED", mapId: cl.territories[0] ?? MAPS[0]?.id ?? "", scoreA: 42 + idx * 7, scoreB: 35 + idx * 5,
      winnerId: cl.id, startsAt: new Date(start).toISOString(), endsAt: new Date(start + 3_600_000).toISOString(),
    }],
  };
});

route("POST", "/api/clans", (c) => {
  const acc = requireAccount();
  ensureWorld();
  const body = parse(clanCreateSchema, c.body);
  if (acc.clan) throw conflict("ALREADY_IN_CLAN", "Leave your current clan first");
  const clans = state().clans;
  if (clans.some((x) => x.name.toLowerCase() === body.name.toLowerCase() || x.tag === body.tag)) throw conflict("CLAN_EXISTS", "Clan name or tag already taken");
  const id = newId("clan");
  debit(acc, "CREDITS", BigInt(DEMO_RULES.clanCreateCost), "GAME_SINK", id, { kind: "CLAN_CREATE" });
  clans.push({
    id, name: body.name, tag: body.tag, description: body.description, level: 1, score: "0", factionId: acc.faction, announcement: null, treasury: "0",
    members: [], territories: [], createdAt: nowIso(),
  });
  acc.clan = { id, role: "LEADER", joinedAt: nowIso() };
  return { id, name: body.name, tag: body.tag };
});

route("POST", "/api/clans/:id/join", (c): Ok => {
  const acc = requireAccount();
  ensureWorld();
  const cl = state().clans.find((x) => x.id === parse(idSchema, c.params.id));
  if (!cl) throw notFound("Clan");
  if (acc.clan) throw conflict("ALREADY_IN_CLAN", "Leave your current clan first");
  if (cl.members.length + pilotsInClan(cl.id).length >= DEMO_RULES.clanMaxMembers) throw badRequest("CLAN_FULL", "Clan is full");
  acc.clan = { id: cl.id, role: "RECRUIT", joinedAt: nowIso() };
  notify(acc, "CLAN", `Welcome to [${cl.tag}]`, `You joined ${cl.name}.`, { clanId: cl.id });
  return { ok: true };
});

route("POST", "/api/clans/leave", (): Ok => {
  const acc = requireAccount();
  if (!acc.clan) throw badRequest("NOT_IN_CLAN", "You are not in a clan");
  const clanId = acc.clan.id;
  acc.clan = null;
  const s = state();
  const cl = s.clans.find((x) => x.id === clanId);
  // A pilot-founded clan with nobody left is dissolved.
  if (cl && cl.members.length === 0 && pilotsInClan(cl.id).length === 0) s.clans = s.clans.filter((x) => x.id !== clanId);
  return { ok: true };
});

for (const [method, path] of [
  ["POST", "/api/clans/:id/invite"], ["POST", "/api/clans/:id/kick"], ["POST", "/api/clans/:id/promote"], ["POST", "/api/clans/:id/treasury/deposit"],
  ["PATCH", "/api/clans/:id/announcement"], ["POST", "/api/clans/:id/diplomacy"], ["POST", "/api/clans/:id/wars"], ["POST", "/api/clans/wars/:warId/accept"],
  ["POST", "/api/clans/:id/station"], ["GET", "/api/clans/:id/missions"],
] as const) {
  route(method, path, disabled("Clan management needs other players and is disabled in the demo"));
}

// ------------------------------------------------------------------ squad / friends

route("GET", "/api/squad", () => {
  requireAccount();
  return { squad: null };
});
for (const p of ["/api/squad", "/api/squad/invite", "/api/squad/:id/join", "/api/squad/leave", "/api/squad/kick"]) {
  route("POST", p, disabled("Squads need other players and are disabled in the demo"));
}

route("GET", "/api/friends", (): FriendsResponse => {
  requireAccount();
  return { friends: [], incoming: [], outgoing: [], blocked: [] };
});
for (const p of ["/api/friends/add", "/api/friends/remove", "/api/friends/block", "/api/friends/unblock"]) {
  route("POST", p, disabled("Friends need other players and are disabled in the demo"));
}

// ------------------------------------------------------------------ chat

route("GET", "/api/chat/history", (c): { messages: ChatMessageDto[] } => {
  const acc = requireAccount();
  const query = parse(chatHistoryQuerySchema, cleanQuery(c.query));
  switch (query.channel) {
    case "FACTION":
      if (!acc.faction) throw forbidden("Join a faction first", "NO_FACTION");
      break;
    case "CLAN":
      if (!acc.clan) throw forbidden("You are not in a clan", "NOT_CLAN_MEMBER");
      break;
    case "SQUAD":
      throw forbidden("You are not in a squad", "NOT_IN_SQUAD");
    case "PRIVATE":
      if (!query.key) throw badRequest("KEY_REQUIRED", "Private history requires the other user's id as key");
      return { messages: [] };
    default:
      break;
  }
  const lines = query.channel === "CLAN" ? ["Clan ops tonight — bring repair kits.", "Welcome to the new recruit!"] : chatLines(query.channel);
  const pool = query.channel === "FACTION" ? NPC_PILOTS.filter((p) => p.faction === acc.faction) : query.channel === "CLAN" ? NPC_PILOTS.filter((p) => p.clanId === acc.clan?.id) : NPC_PILOTS;
  const now = Date.now();
  const messages = lines.slice(0, query.limit).map((text, i) => {
    const from = query.channel === "SYSTEM" ? { id: "system", username: "SYSTEM" } : (pool[i % Math.max(1, pool.length)] ?? { id: "system", username: "SYSTEM" });
    return { id: `chat_${query.channel.toLowerCase()}_${i}`, channel: query.channel, from: from.username, fromId: from.id, text, at: now - (lines.length - i) * 97_000 };
  });
  return { messages };
});

route("POST", "/api/chat/report", () => {
  requireAccount();
  return { ok: true, duplicate: false };
});

// ------------------------------------------------------------------ notifications

route("GET", "/api/notifications", (c): NotificationsResponse => {
  const acc = requireAccount();
  const unreadOnly = q(c.query, "unread") === "true";
  const limit = Math.min(100, Math.max(1, Number(q(c.query, "limit") ?? 50) || 50));
  return {
    unread: acc.notifications.filter((n) => !n.read).length,
    notifications: acc.notifications.filter((n) => !unreadOnly || !n.read).slice(0, limit).map((n) => ({ ...n })),
  };
});

route("POST", "/api/notifications/read", (c) => {
  const acc = requireAccount();
  const body = parse(notificationReadSchema, c.body);
  if (!body.all && !body.ids?.length) throw badRequest("NOTHING_TO_READ", "Provide ids or all=true");
  const ids = new Set(body.ids ?? []);
  let updated = 0;
  for (const n of acc.notifications) {
    if (!n.read && (body.all || ids.has(n.id))) {
      n.read = true;
      updated++;
    }
  }
  return { updated };
});

route("POST", "/api/notifications/push-token", (): Ok => {
  requireAccount();
  return { ok: true };
});

// ------------------------------------------------------------------ mail

route("GET", "/api/mail", (): { mail: MailDto[] } => {
  const acc = requireAccount();
  const now = Date.now();
  return {
    mail: acc.mail
      .filter((m) => !m.expiresAt || Date.parse(m.expiresAt) > now)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((m) => ({ ...m, hasAttachments: m.attachments !== null })),
  };
});

route("POST", "/api/mail/:id/read", (c) => {
  const acc = requireAccount();
  const m = acc.mail.find((x) => x.id === parse(idSchema, c.params.id));
  const updated = m && !m.read ? 1 : 0;
  if (m) m.read = true;
  return { ok: true, updated };
});

route("POST", "/api/mail/:id/claim", (c) => {
  const acc = requireAccount();
  const m = acc.mail.find((x) => x.id === parse(idSchema, c.params.id));
  if (!m) throw notFound("Mail");
  if (m.attachments === null) throw badRequest("NO_ATTACHMENTS", "This mail has no attachments");
  if (m.expiresAt && Date.parse(m.expiresAt) <= Date.now()) throw badRequest("MAIL_EXPIRED", "This mail has expired");
  if (m.claimed) throw conflict("ALREADY_CLAIMED", "Attachments already claimed");
  m.claimed = true;
  m.read = true;
  const bundle: RewardBundle = { ...m.attachments, items: m.attachments.items?.map((i) => ({ itemId: i.itemId, quantity: i.quantity })) };
  const res = grantBundle(acc, bundle, `mail:${m.id}`, `mail:${m.subject}`);
  return { ok: true, items: res.items };
});

// ------------------------------------------------------------------ bounties

route("GET", "/api/bounties", (): { bounties: BountyDto[] } => ({ bounties: syntheticBounties() }));
route("POST", "/api/bounties", disabled("Bounties need other players and are disabled in the demo"));

// ------------------------------------------------------------------ achievements

function metrics(acc: DemoAccount): Record<string, number> {
  const bp = [...acc.battlePasses].sort((a, b) => b.tier - a.tier)[0];
  return {
    level: acc.level,
    npc_kills: acc.stats.npcKills,
    player_kills: acc.stats.playerKills,
    boss_kills: acc.stats.bossKills,
    gates_completed: acc.stats.gatesCompleted,
    resources_mined: acc.stats.resourcesMined,
    maps_visited: acc.stats.mapsVisited.length,
    items_crafted: acc.stats.itemsCrafted,
    pvp_wins: acc.stats.pvpWins,
    clan_created: acc.clan?.role === "LEADER" ? 1 : 0,
    market_sales: acc.stats.marketSales,
    battlepass_tier: bp?.tier ?? 0,
  };
}

route("GET", "/api/achievements", (): { achievements: AchievementDto[] } => {
  const acc = requireAccount();
  const m = metrics(acc);
  const unlocked = new Set(acc.achievements.map((a) => a.id));
  for (const a of newlyUnlockedAchievements(ACHIEVEMENTS, m, unlocked)) {
    acc.achievements.push({ id: a.id, unlockedAt: nowIso(), claimed: false });
    unlocked.add(a.id);
  }
  const byId = new Map(acc.achievements.map((a) => [a.id, a]));
  return {
    achievements: ACHIEVEMENTS.filter((a) => !a.hidden || unlocked.has(a.id)).map((a) => ({
      id: a.id, name: a.name, description: a.description, category: a.category, metric: a.metric, threshold: a.threshold,
      progress: Math.min(a.threshold, m[a.metric] ?? 0), rewards: a.rewards, unlocked: unlocked.has(a.id),
      unlockedAt: byId.get(a.id)?.unlockedAt ?? null, claimed: byId.get(a.id)?.claimed ?? false,
    })),
  };
});

route("POST", "/api/achievements/:id/claim", (c) => {
  const acc = requireAccount();
  const achievementId = parse(defIdSchema, c.params.id);
  const def = ACHIEVEMENTS_BY_ID.get(achievementId);
  if (!def) throw notFound("Achievement");
  const row = acc.achievements.find((a) => a.id === achievementId);
  if (!row) throw forbidden("Achievement not unlocked", "NOT_UNLOCKED");
  if (row.claimed) throw conflict("ALREADY_CLAIMED", "Achievement reward already claimed");
  row.claimed = true;
  const { cryptoEligible: _crypto, ...safe } = def.rewards;
  const g = grantBundle(acc, safe, `ach:${acc.id}:${achievementId}`, `achievement:${achievementId}`);
  return { ok: true, items: g.items };
});

// ------------------------------------------------------------------ battle pass / seasons / events

route("GET", "/api/battlepass", (): BattlePassResponse => {
  const acc = requireAccount();
  const season = activeSeason();
  const pass = season ? BATTLE_PASSES.find((p) => p.seasonId === season.id) : undefined;
  if (!season || !pass) return { active: false, pass: null };
  const row = battlePassRow(acc, season.id);
  return {
    active: true,
    seasonId: season.id,
    pass: { id: pass.id, name: pass.name, tiers: pass.tiers },
    premiumProductId: SHOP_BY_SKU.get(pass.premiumProductSku)?.id ?? null,
    state: { xp: row?.xp ?? 0, tier: row?.tier ?? 0, premium: row?.premium ?? false, claimedFree: [...(row?.claimedFree ?? [])], claimedPremium: [...(row?.claimedPremium ?? [])] },
  };
});

route("POST", "/api/battlepass/claim", (c) => {
  const acc = requireAccount();
  const body = parse(battlePassClaimSchema, c.body);
  const season = activeSeason();
  const pass = season ? BATTLE_PASSES.find((p) => p.seasonId === season.id) : undefined;
  if (!season || !pass) throw badRequest("NO_ACTIVE_PASS", "No active battle pass");
  const tierDef = pass.tiers.find((t) => t.tier === body.tier);
  if (!tierDef) throw notFound("Tier");
  const bundle = body.track === "free" ? tierDef.free : tierDef.premium;
  if (!bundle) throw badRequest("NO_REWARD", "This tier has no reward on that track");
  const bp = battlePassRow(acc, season.id);
  if (!bp || bp.tier < body.tier) throw forbidden("Tier not reached yet", "TIER_LOCKED");
  if (body.track === "premium" && !bp.premium) throw forbidden("Premium pass required", "PREMIUM_REQUIRED");
  const claimed = body.track === "free" ? bp.claimedFree : bp.claimedPremium;
  if (claimed.includes(body.tier)) throw conflict("ALREADY_CLAIMED", "Tier reward already claimed");
  claimed.push(body.tier);
  const { cryptoEligible: _crypto, ...safe } = bundle;
  const res = grantBundle(acc, safe, `bp:${season.id}:${body.track}:${body.tier}:${acc.id}`, `battlepass:${pass.id}:${body.tier}`);
  return { ok: true, items: res.items };
});

route("GET", "/api/seasons", (): { seasons: SeasonDto[] } => {
  const now = Date.now();
  return {
    seasons: SEASONS.map((s) => ({
      ...s, active: Date.parse(s.startAt) <= now && Date.parse(s.endAt) >= now,
      startAt: new Date(s.startAt).toISOString(), endAt: new Date(s.endAt).toISOString(),
    })),
  };
});

route("GET", "/api/events", (): { events: GameEventDto[] } => {
  const now = Date.now();
  return {
    events: EVENTS.map((d): GameEventDto => {
      const active = activeEventWindow(d, now);
      const next = nextEventWindow(d, now);
      return {
        id: d.id, name: d.name, type: d.type, description: d.description, maps: d.maps ?? [], boss: d.boss ?? null,
        xpMultiplier: d.xpMultiplier, dropMultiplier: d.dropMultiplier, rewards: d.rewards ?? [], active: Boolean(active),
        window: active ? { start: new Date(active.start).toISOString(), end: new Date(active.end).toISOString() } : null,
        next: next ? { start: new Date(next.start).toISOString(), end: new Date(next.end).toISOString() } : null,
      };
    }).filter((e) => e.active || e.next),
  };
});

// ------------------------------------------------------------------ galaxy / rules

route("GET", "/api/galaxy", () => ({
  id: GALAXY.id,
  name: GALAXY.name,
  sectors: GALAXY.sectors.map((s) => ({
    id: s.id,
    name: s.name,
    systems: s.systems.map((sys) => ({
      id: sys.id,
      name: sys.name,
      maps: sys.maps.map((mid) => {
        const m = MAPS_BY_ID.get(mid);
        return m
          ? { id: m.id, name: m.name, pvp: m.pvp, roomType: m.roomType, levelRange: m.levelRange, factionHome: m.factionHome ?? null, portals: m.portals.map((p) => ({ id: p.id, targetMap: p.targetMap, requiredLevel: p.requiredLevel, kind: p.kind })) }
          : { id: mid };
      }),
    })),
  })),
}));

route("GET", "/api/galaxy/maps/:id", (c): MapLiveResponse & { map: unknown } => {
  const m = MAPS_BY_ID.get(parse(defIdSchema, c.params.id));
  if (!m) throw notFound("Map");
  const me = state().sessionUserId ? state().accounts[state().sessionUserId ?? ""] : undefined;
  const here = me && (me.lastMapId ?? "") === m.id ? 1 : 0;
  return { map: m, rooms: [{ id: `local_${m.id}`, clients: here, maxClients: m.maxPlayers, region: "local" }] };
});

route("GET", "/api/maps", () => ({ maps: MAPS.map((m) => ({ id: m.id, name: m.name, sector: m.sector, system: m.system, pvp: m.pvp, roomType: m.roomType, levelRange: m.levelRange })) }));
route("GET", "/api/gates", () => ({ gates: GATES }));
route("GET", "/api/rules", () => ({ rules: DEMO_RULES, fees: ECONOMY.fees }));
