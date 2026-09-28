/**
 * NPC AI state machine: IDLE / PATROL / SEARCH / AGGRO / ATTACK / FLEE /
 * ASSIST / RETREAT / RESPAWN, parameterised by the NpcDef `behavior`
 * (PASSIVE, DEFENSIVE, AGGRESSIVE, COWARD, SWARM, BOSS), plus boss phases,
 * adds, special attacks and enrage.
 *
 * The brain only DECIDES (where to go, whom to shoot). Movement uses the same
 * `stepShip` as players; damage goes through `combat.resolveHit` on the server.
 */
import type { BossPhaseDef, NpcAiState, NpcDef } from "@nebula/shared";
import { NpcAiState as S } from "@nebula/shared";
import { DEFAULT_TUNING, type Rng, type SimTuning } from "./tuning.js";

export interface NpcBrain {
  state: NpcAiState;
  stateSince: number;
  targetId: string | null;
  homeX: number;
  homeY: number;
  homeRadius: number;
  patrolX: number | null;
  patrolY: number | null;
  lastKnownX: number;
  lastKnownY: number;
  // boss
  phase: number;
  engagedAt: number | null;
  lastSpecialAt: number;
  lastAddsAt: number;
  enraged: boolean;
}

export function createBrain(homeX: number, homeY: number, homeRadius: number, now: number): NpcBrain {
  return {
    state: S.IDLE, stateSince: now, targetId: null, homeX, homeY, homeRadius, patrolX: null, patrolY: null,
    lastKnownX: homeX, lastKnownY: homeY, phase: 0, engagedAt: null, lastSpecialAt: now, lastAddsAt: now, enraged: false,
  };
}

export interface PerceivedTarget {
  id: string;
  x: number;
  y: number;
}

export interface NpcContext {
  now: number;
  x: number;
  y: number;
  hullFraction: number;
  def: Pick<NpcDef, "behavior" | "aggroRange" | "range" | "fleeHullPercent" | "kind">;
  /** Hostiles the NPC can perceive (not cloaked, not in safe zones), nearest first is not required. */
  visible: PerceivedTarget[];
  /** Entities that damaged this NPC recently, highest threat first. */
  attackers: string[];
  /** A nearby ally is under attack by this entity (for ASSIST). */
  allyAttacker: PerceivedTarget | null;
  rng: Rng;
}

export interface NpcDecision {
  brain: NpcBrain;
  /** Where to fly this tick (null = hold / drift). */
  moveTo: { x: number; y: number } | null;
  /** Face this point (for shooting / weak point exposure). */
  faceTo: { x: number; y: number } | null;
  /** Entity id to shoot this tick (the server still gates fire rate & range). */
  fireAt: string | null;
  changed: boolean;
}

const IDLE_MS = 1500;
const SEARCH_MS = 5000;
const FLEE_MS = 6000;

function to(brain: NpcBrain, state: NpcAiState, now: number, patch: Partial<NpcBrain> = {}): NpcBrain {
  return { ...brain, ...patch, state, stateSince: now };
}

function d2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

function nearest(ctx: NpcContext, maxRange: number): PerceivedTarget | null {
  let best: PerceivedTarget | null = null;
  let bestD = maxRange * maxRange;
  for (const t of ctx.visible) {
    const dd = d2(ctx.x, ctx.y, t.x, t.y);
    if (dd <= bestD) {
      best = t;
      bestD = dd;
    }
  }
  return best;
}

function aggressive(behavior: NpcDef["behavior"]): boolean {
  return behavior === "AGGRESSIVE" || behavior === "SWARM" || behavior === "BOSS";
}

/** Advance the brain one think step. Pure given `ctx.rng`. */
export function stepNpcBrain(brain0: NpcBrain, ctx: NpcContext, tuning: SimTuning = DEFAULT_TUNING): NpcDecision {
  const { now, def } = ctx;
  let brain = brain0;
  const leash = Math.max(def.aggroRange, def.range) * tuning.npcLeashFactor + brain.homeRadius;
  const targetOf = (id: string | null) => (id ? ctx.visible.find((t) => t.id === id) ?? null : null);
  let moveTo: NpcDecision["moveTo"] = null;
  let faceTo: NpcDecision["faceTo"] = null;
  let fireAt: string | null = null;

  const distHome = Math.sqrt(d2(ctx.x, ctx.y, brain.homeX, brain.homeY));
  const attacked = ctx.attackers.length > 0;
  const firstAttacker = attacked ? targetOf(ctx.attackers[0] ?? null) : null;

  // Global transitions (priority order).
  if (brain.state !== S.RESPAWN) {
    const shouldFlee = def.fleeHullPercent > 0 && ctx.hullFraction <= def.fleeHullPercent && def.behavior !== "BOSS";
    if (shouldFlee && brain.state !== S.FLEE && brain.state !== S.RETREAT) {
      brain = to(brain, S.FLEE, now);
    } else if (def.behavior === "PASSIVE" && attacked && brain.state !== S.FLEE && brain.state !== S.RETREAT) {
      brain = to(brain, S.FLEE, now);
    } else if (brain.state !== S.RETREAT && brain.state !== S.FLEE && distHome > leash) {
      brain = to(brain, S.RETREAT, now, { targetId: null });
    }
  }

  switch (brain.state) {
    case S.RESPAWN:
      break;

    case S.IDLE: {
      const t = aggressive(def.behavior) ? nearest(ctx, def.aggroRange) : null;
      if (t) brain = to(brain, S.AGGRO, now, { targetId: t.id });
      else if (attacked && firstAttacker) brain = to(brain, S.AGGRO, now, { targetId: firstAttacker.id });
      else if (ctx.allyAttacker && (def.behavior === "SWARM" || def.behavior === "DEFENSIVE" || def.behavior === "AGGRESSIVE")) brain = to(brain, S.ASSIST, now, { targetId: ctx.allyAttacker.id });
      else if (now - brain.stateSince >= IDLE_MS) {
        const a = ctx.rng() * Math.PI * 2;
        const r = Math.sqrt(ctx.rng()) * brain.homeRadius;
        brain = to(brain, S.PATROL, now, { patrolX: brain.homeX + Math.cos(a) * r, patrolY: brain.homeY + Math.sin(a) * r });
      }
      break;
    }

    case S.PATROL: {
      const t = aggressive(def.behavior) ? nearest(ctx, def.aggroRange) : null;
      if (t) brain = to(brain, S.AGGRO, now, { targetId: t.id });
      else if (attacked && firstAttacker) brain = to(brain, S.AGGRO, now, { targetId: firstAttacker.id });
      else if (ctx.allyAttacker && (def.behavior === "SWARM" || def.behavior === "DEFENSIVE" || def.behavior === "AGGRESSIVE")) brain = to(brain, S.ASSIST, now, { targetId: ctx.allyAttacker.id });
      else if (brain.patrolX !== null && brain.patrolY !== null) {
        if (d2(ctx.x, ctx.y, brain.patrolX, brain.patrolY) < 4) brain = to(brain, S.IDLE, now, { patrolX: null, patrolY: null });
        else moveTo = { x: brain.patrolX, y: brain.patrolY };
      } else brain = to(brain, S.IDLE, now);
      break;
    }

    case S.ASSIST: {
      const t = targetOf(brain.targetId);
      if (t) brain = to(brain, S.AGGRO, now, { targetId: t.id, lastKnownX: t.x, lastKnownY: t.y });
      else if (ctx.allyAttacker) moveTo = { x: ctx.allyAttacker.x, y: ctx.allyAttacker.y };
      else brain = to(brain, S.RETREAT, now, { targetId: null });
      break;
    }

    case S.AGGRO:
    case S.ATTACK: {
      let t = targetOf(brain.targetId);
      // Switch to the top attacker when our current target disappears.
      if (!t && firstAttacker) {
        t = firstAttacker;
        brain = { ...brain, targetId: t.id };
      }
      if (!t) {
        brain = to(brain, S.SEARCH, now, { targetId: null });
        moveTo = { x: brain.lastKnownX, y: brain.lastKnownY };
        break;
      }
      brain = { ...brain, lastKnownX: t.x, lastKnownY: t.y };
      if (def.behavior === "BOSS" && brain.engagedAt === null) brain = { ...brain, engagedAt: now };
      const dist = Math.sqrt(d2(ctx.x, ctx.y, t.x, t.y));
      faceTo = { x: t.x, y: t.y };
      if (dist <= def.range) {
        if (brain.state !== S.ATTACK) brain = to(brain, S.ATTACK, now);
        fireAt = t.id;
        // Keep a comfortable distance (orbit at ~70% of range).
        const ideal = def.range * 0.7;
        if (dist < ideal * 0.6) {
          const ang = Math.atan2(ctx.y - t.y, ctx.x - t.x);
          moveTo = { x: t.x + Math.cos(ang) * ideal, y: t.y + Math.sin(ang) * ideal };
        } else if (dist > ideal * 1.2) {
          moveTo = { x: t.x, y: t.y };
        } else {
          const ang = Math.atan2(ctx.y - t.y, ctx.x - t.x) + 0.35;
          moveTo = { x: t.x + Math.cos(ang) * ideal, y: t.y + Math.sin(ang) * ideal };
        }
      } else {
        if (brain.state !== S.AGGRO) brain = to(brain, S.AGGRO, now);
        moveTo = { x: t.x, y: t.y };
        if (dist > Math.max(def.aggroRange, def.range) * 2 && !ctx.attackers.includes(t.id)) {
          brain = to(brain, S.SEARCH, now, { targetId: null });
        }
      }
      break;
    }

    case S.SEARCH: {
      const t = aggressive(def.behavior) ? nearest(ctx, def.aggroRange) : null;
      if (t) brain = to(brain, S.AGGRO, now, { targetId: t.id });
      else if (attacked && firstAttacker) brain = to(brain, S.AGGRO, now, { targetId: firstAttacker.id });
      else if (now - brain.stateSince > SEARCH_MS) brain = to(brain, S.RETREAT, now);
      else moveTo = { x: brain.lastKnownX, y: brain.lastKnownY };
      break;
    }

    case S.FLEE: {
      const threat = firstAttacker ?? nearest(ctx, def.aggroRange * 2 + def.range);
      if (threat) {
        const ang = Math.atan2(ctx.y - threat.y, ctx.x - threat.x);
        moveTo = { x: ctx.x + Math.cos(ang) * 50, y: ctx.y + Math.sin(ang) * 50 };
      }
      if (now - brain.stateSince > FLEE_MS) brain = to(brain, S.RETREAT, now, { targetId: null });
      break;
    }

    case S.RETREAT: {
      if (distHome <= Math.max(3, brain.homeRadius * 0.5)) brain = to(brain, S.IDLE, now, { targetId: null });
      else moveTo = { x: brain.homeX, y: brain.homeY };
      break;
    }

    default:
      break;
  }

  return { brain, moveTo, faceTo, fireAt, changed: brain.state !== brain0.state || brain.targetId !== brain0.targetId };
}

// ---------------------------------------------------------------------------
// Bosses
// ---------------------------------------------------------------------------

/** Index of the active phase for a hull fraction (phases ordered by threshold desc). */
export function bossPhaseIndex(phases: BossPhaseDef[], hullFraction: number): number {
  let idx = 0;
  for (let i = 0; i < phases.length; i++) {
    const p = phases[i];
    if (p && hullFraction <= p.hullThreshold) idx = i;
  }
  return idx;
}

export interface BossTickResult {
  brain: NpcBrain;
  phaseChanged: boolean;
  phase: BossPhaseDef | null;
  special: BossPhaseDef["specialAttack"] | null;
  adds: { npcId: string; count: number } | null;
  enragedNow: boolean;
  damageMultiplier: number;
  fireRateMultiplier: number;
}

/** Boss phase/special/adds/enrage scheduler. Only runs while the boss is engaged. */
export function bossTick(brain0: NpcBrain, phases: BossPhaseDef[], hullFraction: number, now: number, tuning: SimTuning = DEFAULT_TUNING): BossTickResult {
  let brain = brain0;
  const idx = bossPhaseIndex(phases, hullFraction);
  const phaseChanged = idx !== brain.phase;
  if (phaseChanged) brain = { ...brain, phase: idx, lastSpecialAt: now, lastAddsAt: now };
  const phase = phases[idx] ?? null;
  const engaged = brain.engagedAt !== null && (brain.state === S.AGGRO || brain.state === S.ATTACK || brain.state === S.SEARCH);
  let special: BossTickResult["special"] = null;
  let adds: BossTickResult["adds"] = null;
  if (phase && engaged) {
    if (phase.specialAttack && now - brain.lastSpecialAt >= phase.specialAttack.everyMs) {
      special = phase.specialAttack;
      brain = { ...brain, lastSpecialAt: now };
    }
    if (phase.adds && phase.adds.count > 0 && now - brain.lastAddsAt >= phase.adds.everyMs) {
      adds = { npcId: phase.adds.npcId, count: phase.adds.count };
      brain = { ...brain, lastAddsAt: now };
    }
  }
  const timeEnrage = brain.engagedAt !== null && now - brain.engagedAt >= tuning.bossEnrageAfterMs;
  const shouldEnrage = phase?.layer === "ENRAGE" || timeEnrage;
  const enragedNow = shouldEnrage && !brain.enraged;
  if (enragedNow) brain = { ...brain, enraged: true };
  let damageMultiplier = phase?.damageMultiplier ?? 1;
  if (timeEnrage && phase?.layer !== "ENRAGE") damageMultiplier *= tuning.bossEnrageDamageMultiplier;
  return { brain, phaseChanged, phase, special, adds, enragedNow, damageMultiplier, fireRateMultiplier: phase?.fireRateMultiplier ?? 1 };
}

/** Reset boss engagement (all attackers gone / leashed). */
export function resetBoss(brain: NpcBrain, now: number): NpcBrain {
  return { ...brain, engagedAt: null, enraged: false, phase: 0, lastSpecialAt: now, lastAddsAt: now };
}
