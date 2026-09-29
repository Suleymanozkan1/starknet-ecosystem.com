import { beforeEach, describe, expect, it } from "vitest";
import { FACTIONS, ITEMS, PROGRESSION, SHIPS, SHOP } from "@nebula/config";
import type { AuthResponse, InventoryResponse, MeResponse, PurchaseResponse } from "@nebula/shared";
import { ApiRequestError } from "../lib/http.js";
import type { GameTicketResponse, ShipsResponse } from "../lib/dto.js";
import { demoApplyPickup, demoApplyReward, demoRequest, demoSetLocation, resetDemoState } from "./mockApi.js";

const get = <T>(path: string, query?: Record<string, string>) => demoRequest("GET", path, query, undefined) as Promise<T>;
const post = <T>(path: string, body: unknown = {}) => demoRequest("POST", path, undefined, body) as Promise<T>;

function decodeTicket(ticket: string): Record<string, unknown> {
  expect(ticket.startsWith("demo.")).toBe(true);
  const bytes = Uint8Array.from(atob(ticket.slice("demo.".length)), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

describe("demo mock backend", () => {
  beforeEach(() => resetDemoState());

  it("runs the onboarding → hangar → game → shop flow end to end", async () => {
    // 401 before login, like the real API (the app shows the auth screens).
    const unauth = await get("/api/me").catch((e: unknown) => e);
    expect(unauth).toBeInstanceOf(ApiRequestError);
    expect((unauth as ApiRequestError).status).toBe(401);
    expect((unauth as ApiRequestError).code).toBe("UNAUTHORIZED");

    // Any credentials are accepted.
    const reg = await post<AuthResponse>("/api/auth/register", { email: "ace@demo.local", password: "x", username: "Ace_Pilot" });
    expect(reg.user.username).toBe("Ace_Pilot");
    expect(reg.user.faction).toBeNull();
    expect(reg.user.activeShipInstanceId).toBeNull();
    expect((await get<MeResponse>("/api/me")).id).toBe(reg.user.id);

    // Wallet sign-in is disabled; unknown routes are NOT_IN_DEMO.
    await expect(post("/api/auth/nonce", { address: "x" })).rejects.toMatchObject({ status: 403, code: "DEMO_DISABLED" });
    await expect(get("/api/definitely/unknown")).rejects.toMatchObject({ status: 501, code: "NOT_IN_DEMO" });

    // No faction yet → no game ticket (same code as apps/api routes/game.ts).
    await expect(post("/api/game/ticket")).rejects.toMatchObject({ status: 400, code: "NO_FACTION" });

    // Faction choice grants the starter ship, its loadout items and starter ammo.
    const faction = FACTIONS[0];
    if (!faction) throw new Error("no factions in config");
    const me = await post<MeResponse>("/api/me/faction", { factionId: faction.id });
    expect(me.faction).toBe(faction.id);
    expect(me.activeShipInstanceId).toBeTruthy();
    await expect(post("/api/me/faction", { factionId: faction.id })).rejects.toMatchObject({ status: 409, code: "FACTION_ALREADY_CHOSEN" });

    // The demo tester kit adds every ship; the faction starter ship stays the active one.
    const ships = await get<ShipsResponse>("/api/ships");
    expect(ships.owned).toHaveLength(SHIPS.length);
    expect(ships.catalog.every((c) => c.owned)).toBe(true);
    const owned = ships.owned.find((o) => o.active);
    expect(owned?.defId).toBe(faction.starterShip);
    expect(owned?.active).toBe(true);
    expect(owned?.id).toBe(me.activeShipInstanceId);
    expect(owned?.gearScore).toBeGreaterThan(0);
    expect(ships.catalog.find((c) => c.id === faction.starterShip)?.owned).toBe(true);
    const lo = owned?.loadouts.find((l) => l.id === owned.activeLoadoutId);
    expect(lo?.weapons.filter(Boolean).length).toBeGreaterThan(0);

    const inv = await get<InventoryResponse>("/api/inventory", { sort: "rarity" });
    const starterCount = faction.starterLoadout.weapons.length + faction.starterLoadout.modules.length + faction.starterLoadout.drones.length;
    expect(inv.items.filter((i) => i.equippedOn === owned?.id)).toHaveLength(starterCount);
    // Tester kit: every non-ship, non-resource item, all resources, max level, premium and big balances.
    const invIds = new Set(inv.items.map((i) => i.itemId));
    expect(ITEMS.filter((d) => d.category !== "SHIP" && d.category !== "RESOURCE").every((d) => invIds.has(d.id))).toBe(true);
    expect(me.level).toBe(PROGRESSION.maxLevel);
    expect(me.premiumTier).toBe("ELITE");
    expect(BigInt(me.balances.credits)).toBeGreaterThanOrEqual(100_000_000n);
    expect(Object.values(me.balances.resources).every((n) => (n ?? 0) >= 50_000)).toBe(true);

    // Game ticket decodes to the pilot's faction + active ship; map = faction home until a location is set.
    const t = await post<GameTicketResponse>("/api/game/ticket");
    expect(t.gameServerUrl).toBe("local://demo");
    expect(t.mapId).toBe(faction.homeMap);
    const ticket = decodeTicket(t.ticket) as { loadout?: { weapons: { id: string }[] } };
    expect(ticket).toMatchObject({ userId: me.id, name: "Ace_Pilot", factionId: faction.id, shipId: faction.starterShip, xp: me.xp });
    // The equipped hangar loadout travels with the ticket so the simulation flies the same gear.
    expect(ticket.loadout?.weapons.map((w) => w.id).sort()).toEqual([...faction.starterLoadout.weapons].sort());

    // Buying a CREDITS product debits credits by exactly the configured price.
    const product = SHOP.find((p) => p.active && p.currency === "CREDITS" && p.requiredLevel <= 1 && p.grants.items?.length);
    if (!product) throw new Error("no level-1 credits product in shop.json");
    const before = BigInt((await get<MeResponse>("/api/me")).balances.credits);
    const bought = await post<PurchaseResponse & { duplicate: boolean }>("/api/shop/purchase", { productId: product.id, quantity: 1, idempotencyKey: "test_buy_1" });
    expect(BigInt(bought.balances.credits)).toBe(before - product.price);
    // Idempotent replay.
    const again = await post<PurchaseResponse & { duplicate: boolean }>("/api/shop/purchase", { productId: product.id, quantity: 1, idempotencyKey: "test_buy_1" });
    expect(again.duplicate).toBe(true);
    expect(again.balances.credits).toBe(bought.balances.credits);

    // On-chain products are disabled.
    const solProduct = SHOP.find((p) => p.active && (p.currency === "SOL" || p.currency === "NEBX"));
    if (solProduct) {
      await expect(post("/api/shop/purchase", { productId: solProduct.id, quantity: 1, idempotencyKey: "test_buy_sol" })).rejects.toMatchObject({ code: "DEMO_DISABLED" });
    }

    // Simulation events flow into the account.
    const pre = await get<MeResponse>("/api/me");
    demoApplyReward({ xp: 5_000, honor: 10, credits: 250, seasonPoints: 10, reason: "Destroyed Nobody" });
    demoApplyPickup({ lootId: "l1", byEntityId: "e1", items: [], credits: 50, gems: 0, resources: {} });
    const post1 = await get<MeResponse>("/api/me");
    expect(post1.xp).toBe(pre.xp + 5_000);
    expect(post1.honor).toBe(pre.honor + 10);
    expect(post1.level).toBeGreaterThanOrEqual(pre.level);
    expect(BigInt(post1.balances.credits)).toBe(BigInt(pre.balances.credits) + 300n);

    // Location is remembered for the next ticket.
    const other = FACTIONS[1]?.homeMap;
    if (other) {
      demoSetLocation(other);
      expect((await post<GameTicketResponse>("/api/game/ticket")).mapId).toBe(other);
    }

    // Ledger records every balance change.
    const tx = await get<{ entries: { direction: string; asset: string }[] }>("/api/economy/transactions", { asset: "CREDITS" });
    expect(tx.entries.some((e) => e.direction === "DEBIT")).toBe(true);
    expect(tx.entries.every((e) => e.asset === "CREDITS")).toBe(true);

    // Logout → 401 again; login with the same email restores the account.
    await post("/api/auth/logout");
    await expect(get("/api/me")).rejects.toMatchObject({ status: 401 });
    const back = await post<AuthResponse>("/api/auth/login", { email: "ace@demo.local", password: "anything" });
    expect(back.user.id).toBe(me.id);
    expect(back.user.faction).toBe(faction.id);
  });

  it("validates input like the API and leaves balances untouched on errors", async () => {
    await post("/api/auth/register", { email: "b@demo.local", password: "x", username: "Bravo" });
    await expect(post("/api/me/faction", { factionId: "Not A Faction!" })).rejects.toMatchObject({ status: 400, code: "VALIDATION_ERROR" });
    const expensive = SHOP.filter((p) => p.active && p.currency === "CREDITS").sort((a, b) => (a.price > b.price ? -1 : 1))[0];
    if (!expensive) throw new Error("no credits product");
    const before = (await get<MeResponse>("/api/me")).balances.credits;
    await expect(post("/api/shop/purchase", { productId: expensive.id, quantity: 100, idempotencyKey: "too_much" })).rejects.toBeInstanceOf(ApiRequestError);
    expect((await get<MeResponse>("/api/me")).balances.credits).toBe(before);
  });

  it("serves the read-only world pages", async () => {
    await post("/api/auth/register", { email: "c@demo.local", password: "x", username: "Charlie" });
    const lb = await get<{ entries: { username: string }[] }>("/api/leaderboard", { board: "honor" });
    expect(lb.entries.some((e) => e.username === "Charlie")).toBe(true);
    expect((await get<{ listings: unknown[] }>("/api/market")).listings.length).toBeGreaterThan(0);
    expect((await get<{ clans: unknown[] }>("/api/clans")).clans.length).toBeGreaterThan(0);
    expect((await get<{ mail: { attachments: unknown }[] }>("/api/mail")).mail[0]?.attachments).toBeTruthy();
    expect(Array.isArray((await get<{ events: unknown[] }>("/api/events")).events)).toBe(true);
    const wallet = await get<{ network: string; wallets: unknown[] }>("/api/wallet");
    expect(wallet.network).toBe("devnet");
    expect(wallet.wallets).toHaveLength(0);
    await expect(post("/api/wallet/withdraw", {})).rejects.toMatchObject({ code: "DEMO_DISABLED" });
    expect(await get<{ squad: null }>("/api/squad")).toEqual({ squad: null });
  });
});
