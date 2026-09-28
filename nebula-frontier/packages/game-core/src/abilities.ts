/**
 * Server-authoritative ability / module activation: cooldowns, durations,
 * energy costs and timed buffs. The client only sends "activate slot N".
 */
import type { AbilityEffect } from "@nebula/shared";
import type { AbilitySlotDef } from "./stats.js";

export interface ActiveBuff {
  sourceId: string;
  effect: AbilityEffect;
  expiresAt: number;
}

export interface AbilityState {
  /** Ability id → timestamp when it is ready again. */
  readyAt: Record<string, number>;
  buffs: ActiveBuff[];
}

export function createAbilityState(): AbilityState {
  return { readyAt: {}, buffs: [] };
}

export type ActivationFailure = "COOLDOWN" | "ENERGY" | "STUNNED" | "DEAD" | "UNKNOWN_SLOT" | "PASSIVE";

export type ActivationResult =
  | { ok: true; state: AbilityState; energyCost: number; effect: AbilityEffect; readyAt: number; expiresAt: number }
  | { ok: false; reason: ActivationFailure; readyAt?: number };

export function effectiveCooldownMs(slot: AbilitySlotDef, cooldownReductionPct: number): number {
  const cdr = Math.max(0, Math.min(90, cooldownReductionPct));
  return Math.round(slot.cooldownMs * (1 - cdr / 100));
}

/**
 * Try to activate an ability. Pure: returns a new state. The cooldown is
 * measured on the server clock (`now`), so a client cannot shorten it.
 */
export function activateAbility(
  state: AbilityState,
  slot: AbilitySlotDef | undefined,
  ctx: { now: number; energy: number; cooldownReductionPct: number; stunned: boolean; dead: boolean },
): ActivationResult {
  if (!slot) return { ok: false, reason: "UNKNOWN_SLOT" };
  if (slot.effect.type === "PASSIVE_STAT") return { ok: false, reason: "PASSIVE" };
  if (ctx.dead) return { ok: false, reason: "DEAD" };
  if (ctx.stunned) return { ok: false, reason: "STUNNED" };
  const ready = state.readyAt[slot.id] ?? 0;
  if (ctx.now < ready) return { ok: false, reason: "COOLDOWN", readyAt: ready };
  if (ctx.energy < slot.energyCost) return { ok: false, reason: "ENERGY" };
  const readyAt = ctx.now + effectiveCooldownMs(slot, ctx.cooldownReductionPct);
  const expiresAt = ctx.now + Math.max(0, slot.durationMs);
  const buffs = slot.durationMs > 0 && isTimedEffect(slot.effect)
    ? [...state.buffs.filter((b) => b.sourceId !== slot.id), { sourceId: slot.id, effect: slot.effect, expiresAt }]
    : state.buffs;
  return {
    ok: true,
    state: { readyAt: { ...state.readyAt, [slot.id]: readyAt }, buffs },
    energyCost: slot.energyCost,
    effect: slot.effect,
    readyAt,
    expiresAt,
  };
}

export function isTimedEffect(e: AbilityEffect): boolean {
  return e.type === "SPEED_BOOST" || e.type === "DAMAGE_BOOST" || e.type === "DAMAGE_REDUCTION" || e.type === "CLOAK";
}

export function pruneBuffs(state: AbilityState, now: number): AbilityState {
  const buffs = state.buffs.filter((b) => b.expiresAt > now);
  return buffs.length === state.buffs.length ? state : { ...state, buffs };
}

/** Remove cloak (e.g. when firing). */
export function breakCloak(state: AbilityState): AbilityState {
  const buffs = state.buffs.filter((b) => b.effect.type !== "CLOAK");
  return buffs.length === state.buffs.length ? state : { ...state, buffs };
}

export interface BuffModifiers {
  speedMultiplier: number;
  damageMultiplier: number;
  damageTakenMultiplier: number;
  cloaked: boolean;
}

export function buffModifiers(state: AbilityState, now: number): BuffModifiers {
  const m: BuffModifiers = { speedMultiplier: 1, damageMultiplier: 1, damageTakenMultiplier: 1, cloaked: false };
  for (const b of state.buffs) {
    if (b.expiresAt <= now) continue;
    switch (b.effect.type) {
      case "SPEED_BOOST": m.speedMultiplier *= b.effect.multiplier; break;
      case "DAMAGE_BOOST": m.damageMultiplier *= b.effect.multiplier; break;
      case "DAMAGE_REDUCTION": m.damageTakenMultiplier *= b.effect.multiplier; break;
      case "CLOAK": m.cloaked = true; break;
      default: break;
    }
  }
  return m;
}

/**
 * Tracks repeated activation attempts made before the cooldown elapsed.
 * Honest clients occasionally mis-time a key press; a modified client spams.
 * Returns true when the number of early attempts inside `windowMs` reaches `threshold`.
 */
export class CooldownViolationTracker {
  private hits: number[] = [];
  private readonly windowMs: number;
  private readonly threshold: number;
  constructor(windowMs = 10_000, threshold = 8) {
    this.windowMs = windowMs;
    this.threshold = threshold;
  }
  record(now: number): boolean {
    this.hits.push(now);
    const cutoff = now - this.windowMs;
    while (this.hits.length > 0 && (this.hits[0] ?? 0) < cutoff) this.hits.shift();
    if (this.hits.length >= this.threshold) {
      this.hits = [];
      return true;
    }
    return false;
  }
}
