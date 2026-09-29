/**
 * In-browser mock backend for the static demo build (VITE_DEMO_MODE=true, e.g. a Vercel deployment with no
 * API). lib/http.ts lazily imports `demoRequest` and routes every REST call here; the game adapter forwards
 * the offline simulation's rewards/pickups/location so progress shows up in the shell.
 *
 * Response shapes mirror apps/api/src/routes/* exactly (DTOs from @nebula/shared and ../lib/dto.ts); game data
 * and formulas come from @nebula/config and @nebula/game-core. State lives in memory and is mirrored to
 * localStorage ("nf_demo_v1"). Nothing here touches real accounts, money or a blockchain.
 */
import { MAPS_BY_ID, NPCS } from "@nebula/config";
import type { ItemPickupEvent, RewardEvent } from "@nebula/shared";
import { ApiRequestError } from "../lib/http.js";
import { addResources, addXpHonor, applyGameplayEvent, credit, currentAccount, grantItems, syncLevel } from "./account.js";
import { toMoney } from "./core.js";
import { notInDemo } from "./errors.js";
import { match, type Query } from "./router.js";
import "./routes-player.js";
import "./routes-world.js";
import "./routes-economy.js";
import { replaceState, save, state, type DemoState } from "./state.js";

export { resetDemoState } from "./state.js";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** Artificial latency so loading states look natural (skipped under vitest). */
const LATENCY_MS: readonly [number, number] = import.meta.env.MODE === "test" ? [0, 0] : [60, 150];

function delay(): Promise<void> {
  const [min, max] = LATENCY_MS;
  if (max <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)));
}

/** JSON round-trip like a real HTTP response (bigint → decimal string, as the API's serializer does). */
function toWire(value: unknown): unknown {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))) as unknown;
}

function splitPath(path: string, query: Query | undefined): { pathname: string; query: Query } {
  const i = path.indexOf("?");
  if (i < 0) return { pathname: path, query: { ...(query ?? {}) } };
  const merged: Query = {};
  for (const [k, v] of new URLSearchParams(path.slice(i + 1))) merged[k] = v;
  return { pathname: path.slice(0, i), query: { ...merged, ...(query ?? {}) } };
}

/**
 * Handle one REST call in demo mode. Resolves with the JSON body the real API would return; rejects with
 * ApiRequestError for errors. A failing mutation is rolled back (all-or-nothing, like the API's transactions).
 */
export async function demoRequest(
  method: string,
  path: string,
  query: Record<string, string | number | boolean | null | undefined> | undefined,
  body: unknown,
): Promise<unknown> {
  await delay();
  const m = method.toUpperCase();
  const { pathname, query: q } = splitPath(path, query);
  const found = match(m, pathname);
  if (!found) throw notInDemo();
  const mutating = MUTATING.has(m);
  const snapshot = mutating ? JSON.stringify(state()) : null;
  try {
    const result = await found.handler({ params: found.params, query: q, body: body ?? {} });
    if (mutating) save();
    return toWire(result);
  } catch (err) {
    if (snapshot) replaceState(JSON.parse(snapshot) as DemoState);
    if (err instanceof ApiRequestError) throw err;
    throw new ApiRequestError(500, "INTERNAL_ERROR", err instanceof Error ? err.message : "Demo backend error");
  }
}

const NPC_BY_NAME = new Map(NPCS.map((n) => [n.name.toLowerCase(), n]));

/** Money from the simulation (whole units) → integer base units with game-core's single rounding rule. */
function money(n: number): bigint {
  try {
    return n > 0 ? toMoney(n) : 0n;
  } catch {
    return 0n;
  }
}

/** Game events forwarded from the in-browser simulation so progress shows up in the shell. */
export function demoApplyReward(r: RewardEvent): void {
  const acc = currentAccount();
  if (!acc) return;
  const credits = money(r.credits);
  if (credits > 0n) credit(acc, "CREDITS", credits, "GAME_REWARD", "demo:game", { reason: r.reason });
  addXpHonor(acc, Number.isFinite(r.xp) ? r.xp : 0, Number.isFinite(r.honor) ? r.honor : 0);
  if (Number.isFinite(r.seasonPoints) && r.seasonPoints > 0) acc.seasonScore += Math.floor(r.seasonPoints);
  const killed = /^Destroyed (.+)$/.exec(r.reason)?.[1];
  if (killed) {
    const npc = NPC_BY_NAME.get(killed.toLowerCase());
    const boss = npc?.kind === "BOSS";
    acc.stats.npcKills += 1;
    if (boss) acc.stats.bossKills += 1;
    if (npc) applyGameplayEvent(acc, { type: "KILL", npcId: npc.id, boss, mapId: acc.lastMapId ?? "" });
  }
  save();
}

/** Credits, gems, resources and items picked up in the simulation → balances/inventory. */
export function demoApplyPickup(p: ItemPickupEvent): void {
  const acc = currentAccount();
  if (!acc) return;
  const ref = `demo:loot:${p.lootId}`;
  const credits = money(p.credits);
  const gems = money(p.gems);
  if (credits > 0n) credit(acc, "CREDITS", credits, "GAME_REWARD", ref, { reason: "loot" });
  if (gems > 0n) credit(acc, "GEMS", gems, "GAME_REWARD", ref, { reason: "loot" });
  const mapId = acc.lastMapId ?? "";
  addResources(acc, p.resources);
  for (const [resourceId, amt] of Object.entries(p.resources)) {
    if (!amt || amt <= 0) continue;
    acc.stats.resourcesMined += Math.floor(amt);
    applyGameplayEvent(acc, { type: "MINE", resourceId, quantity: Math.floor(amt), mapId });
  }
  const items = p.items.filter((i) => i.quantity > 0).map((i) => ({ itemId: i.itemId, quantity: Math.floor(i.quantity) }));
  grantItems(acc, items, { skipUnknown: true });
  for (const i of items) applyGameplayEvent(acc, { type: "COLLECT", itemId: i.itemId, quantity: i.quantity, mapId });
  save();
}

/** Remember the current map for the next game ticket. */
export function demoSetLocation(mapId: string): void {
  const acc = currentAccount();
  if (!acc || !MAPS_BY_ID.has(mapId)) return;
  acc.lastMapId = mapId;
  if (!acc.stats.mapsVisited.includes(mapId)) acc.stats.mapsVisited.push(mapId);
  applyGameplayEvent(acc, { type: "TRAVEL", mapId });
  save();
}

/** Optional sync from the simulation's level-up event; XP (already applied via rewards) drives the level. */
export function demoLevelUp(_level: number): void {
  const acc = currentAccount();
  if (!acc) return;
  syncLevel(acc);
  save();
}
