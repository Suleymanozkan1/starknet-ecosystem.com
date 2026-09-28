/**
 * Blueprint validation, cost and outcome (the API executes crafting jobs; the
 * rules live here so every service agrees).
 */
import type { BlueprintDef, ResourceId } from "@nebula/shared";
import type { Rng } from "./tuning.js";

export interface CrafterState {
  level: number;
  credits: number;
  resources: Partial<Record<ResourceId, number>>;
  /** itemId → owned quantity (unlocked, not listed/escrowed). */
  items: Record<string, number>;
}

export interface CraftValidation {
  ok: boolean;
  missing: { kind: "LEVEL" | "CREDITS" | "RESOURCE" | "ITEM"; ref: string; required: number; have: number }[];
}

export function craftCost(bp: BlueprintDef, quantity = 1): { credits: number; resources: Partial<Record<ResourceId, number>>; items: { itemId: string; quantity: number }[] } {
  const q = Math.max(1, Math.floor(quantity));
  const resources: Partial<Record<ResourceId, number>> = {};
  for (const [k, v] of Object.entries(bp.resources)) if (typeof v === "number") resources[k as ResourceId] = v * q;
  return { credits: bp.credits * q, resources, items: (bp.items ?? []).map((i) => ({ itemId: i.itemId, quantity: i.quantity * q })) };
}

export function validateCraft(bp: BlueprintDef, s: CrafterState, quantity = 1): CraftValidation {
  const missing: CraftValidation["missing"] = [];
  if (s.level < bp.requiredLevel) missing.push({ kind: "LEVEL", ref: "level", required: bp.requiredLevel, have: s.level });
  const cost = craftCost(bp, quantity);
  if (s.credits < cost.credits) missing.push({ kind: "CREDITS", ref: "CREDITS", required: cost.credits, have: s.credits });
  for (const [res, need] of Object.entries(cost.resources)) {
    const have = s.resources[res as ResourceId] ?? 0;
    if (typeof need === "number" && have < need) missing.push({ kind: "RESOURCE", ref: res, required: need, have });
  }
  for (const it of cost.items) {
    const have = s.items[it.itemId] ?? 0;
    if (have < it.quantity) missing.push({ kind: "ITEM", ref: it.itemId, required: it.quantity, have });
  }
  return { ok: missing.length === 0, missing };
}

export function rollCraft(bp: BlueprintDef, rng: Rng): { success: boolean; outputItem: string; quantity: number } {
  const success = rng() < Math.max(0, Math.min(1, bp.successChance));
  return { success, outputItem: bp.outputItem, quantity: success ? bp.outputQuantity : 0 };
}

export function craftCompletesAt(bp: BlueprintDef, startedAt: Date, speedMultiplier = 1): Date {
  return new Date(startedAt.getTime() + Math.round((bp.craftTimeSec * 1000) / Math.max(0.1, speedMultiplier)));
}
