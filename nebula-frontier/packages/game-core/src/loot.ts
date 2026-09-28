/**
 * Server-side weighted loot rolls from loot tables and item affix rolling.
 * RNG is injected, so identical seeds produce identical drops (tests,
 * replays, audit).
 */
import type { ItemAffixDef, ItemDef, LootEntry, LootTableDef, Rarity, StatKey } from "@nebula/shared";
import type { Rng } from "./tuning.js";

export interface LootDrop {
  kind: LootEntry["kind"];
  ref: string;
  quantity: number;
  rarity?: Rarity;
}

export interface LootRollOptions {
  /** Event / booster drop multiplier (>1 makes empty rolls rarer). */
  dropMultiplier?: number;
  /** Extra rolls (e.g. difficulty or contribution tiers). */
  extraRolls?: number;
}

/** Pick an index from weights. Returns -1 when total weight is 0. */
export function weightedPick(weights: number[], rng: Rng): number {
  let total = 0;
  for (const w of weights) total += Math.max(0, w);
  if (total <= 0) return -1;
  let r = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    const w = Math.max(0, weights[i] ?? 0);
    if (r < w) return i;
    r -= w;
  }
  return weights.length - 1;
}

export function randInt(min: number, max: number, rng: Rng): number {
  const lo = Math.ceil(Math.min(min, max));
  const hi = Math.floor(Math.max(min, max));
  return lo + Math.floor(rng() * (hi - lo + 1));
}

/** Roll a loot table. Drops of the same kind+ref are merged. */
export function rollLoot(table: LootTableDef, rng: Rng, opts: LootRollOptions = {}): LootDrop[] {
  const mult = Math.max(0.01, opts.dropMultiplier ?? 1);
  const rolls = Math.max(0, table.rolls + (opts.extraRolls ?? 0));
  const weights = [table.emptyWeight / mult, ...table.entries.map((e) => e.weight)];
  const merged = new Map<string, LootDrop>();
  for (let i = 0; i < rolls; i++) {
    const idx = weightedPick(weights, rng);
    if (idx <= 0) continue; // empty
    const e = table.entries[idx - 1];
    if (!e) continue;
    const qty = randInt(e.min, e.max, rng);
    if (qty <= 0) continue;
    const key = `${e.kind}:${e.ref}`;
    const prev = merged.get(key);
    if (prev) prev.quantity += qty;
    else merged.set(key, { kind: e.kind, ref: e.ref, quantity: qty, rarity: e.rarity });
  }
  return [...merged.values()];
}

export interface RolledAffix { id: string; stat: StatKey; value: number }

/** Number of affixes by rarity. */
export const AFFIX_SLOTS: Record<Rarity, number> = {
  COMMON: 0, UNCOMMON: 1, RARE: 2, EPIC: 3, LEGENDARY: 4, ANCIENT: 4, MYTHIC: 5, PROTOTYPE: 5,
};

/** Items that can carry affixes: power items of equipment categories. */
export function isAffixable(item: ItemDef): boolean {
  return item.powerItem && (item.category === "WEAPON" || item.category === "MODULE" || item.category === "GENERATOR" || item.category === "DRONE");
}

/**
 * Roll affixes for an item. Distinct affix ids; per-stat totals are clamped to
 * the affix `cap` (negative caps clamp from below, e.g. energy cost reduction).
 */
export function rollAffixes(item: ItemDef, affixes: ItemAffixDef[], rng: Rng, rarityOverride?: Rarity): RolledAffix[] {
  if (!isAffixable(item)) return [];
  const n = AFFIX_SLOTS[rarityOverride ?? item.rarity] ?? 0;
  const pool = [...affixes];
  const out: RolledAffix[] = [];
  const totals = new Map<string, number>();
  for (let i = 0; i < n && pool.length > 0; i++) {
    const idx = weightedPick(pool.map((a) => a.weight), rng);
    if (idx < 0) break;
    const a = pool.splice(idx, 1)[0];
    if (!a) break;
    const lo = Math.min(a.min, a.max);
    const hi = Math.max(a.min, a.max);
    let value = Math.round((lo + rng() * (hi - lo)) * 10) / 10;
    const cur = totals.get(a.stat) ?? 0;
    const next = cur + value;
    if (a.cap < 0) value = Math.max(next, a.cap) - cur;
    else value = Math.min(next, a.cap) - cur;
    if (value === 0) continue;
    totals.set(a.stat, cur + value);
    out.push({ id: a.id, stat: a.stat, value });
  }
  return out;
}

/** Clamp an arbitrary affix list to caps (defensive re-validation of stored affixes). */
export function clampAffixes(list: { stat: string; value: number; id?: string }[], affixes: ItemAffixDef[]): RolledAffix[] {
  const caps = new Map<string, number>();
  for (const a of affixes) caps.set(a.stat, a.cap);
  const totals = new Map<string, number>();
  const out: RolledAffix[] = [];
  for (const af of list) {
    const cap = caps.get(af.stat);
    if (cap === undefined || !Number.isFinite(af.value)) continue;
    const cur = totals.get(af.stat) ?? 0;
    const next = cap < 0 ? Math.max(cur + af.value, cap) : Math.min(cur + af.value, cap);
    const v = next - cur;
    if (v === 0) continue;
    totals.set(af.stat, next);
    out.push({ id: af.id ?? `affix_${af.stat}`, stat: af.stat as StatKey, value: v });
  }
  return out;
}
