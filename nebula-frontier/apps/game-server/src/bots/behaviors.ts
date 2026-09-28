/**
 * Dev bot behaviours (Wander / Collect / Attack / Flee / Assist) composed into
 * archetypes Scout, Miner, Fighter, Tank, Support. Bots are real clients: they
 * only send the same intents a human client can send.
 */
export interface EntityView {
  id: string;
  kind: string;
  x: number;
  y: number;
  hull: number;
  maxHull: number;
  shield: number;
  maxShield: number;
  dead: boolean;
  faction: string;
  team: number;
  targetId: string;
  defId: string;
}

export interface BotWorld {
  self: EntityView;
  entities: EntityView[];
  mapWidth: number;
  mapHeight: number;
  home: { x: number; y: number };
  now: number;
}

export interface BotAction {
  moveTo?: { x: number; y: number } | null;
  heading?: number;
  thrust?: number;
  boost?: boolean;
  targetId?: string | null;
  firing?: boolean;
  mine?: string | null;
  pickup?: string | null;
  module?: number | null;
  skill?: number | null;
}

export type Behavior = (w: BotWorld, mem: BotMemory) => BotAction | null;

export interface BotMemory {
  wanderTo: { x: number; y: number } | null;
  lastModuleAt: number;
  rng: () => number;
}

const d = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
const nearest = (w: BotWorld, pred: (e: EntityView) => boolean) => {
  let best: EntityView | null = null;
  let bd = Infinity;
  for (const e of w.entities) {
    if (e.id === w.self.id || !pred(e)) continue;
    const dd = d(e, w.self);
    if (dd < bd) { bd = dd; best = e; }
  }
  return best;
};
const hostileNpc = (e: EntityView) => (e.kind === "NPC" || e.kind === "BOSS") && !e.dead;

export const Wander: Behavior = (w, mem) => {
  if (!mem.wanderTo || d(mem.wanderTo, w.self) < 5) {
    mem.wanderTo = { x: 20 + mem.rng() * (w.mapWidth - 40), y: 20 + mem.rng() * (w.mapHeight - 40) };
  }
  return { moveTo: mem.wanderTo, firing: false, targetId: null };
};

export const Flee: Behavior = (w) => {
  const hp = (w.self.hull + w.self.shield) / Math.max(1, w.self.maxHull + w.self.maxShield);
  if (hp > 0.3) return null;
  return { moveTo: w.home, boost: true, firing: false, targetId: null };
};

export const Collect: Behavior = (w) => {
  const loot = nearest(w, (e) => e.kind === "LOOT");
  if (loot && d(loot, w.self) < 60) {
    if (d(loot, w.self) < 10) return { pickup: loot.id, moveTo: { x: loot.x, y: loot.y } };
    return { moveTo: { x: loot.x, y: loot.y } };
  }
  const rock = nearest(w, (e) => e.kind === "ASTEROID" && !e.dead && e.hull > 0);
  if (rock) {
    if (d(rock, w.self) < 20) return { mine: rock.id, moveTo: null, thrust: 0 };
    return { moveTo: { x: rock.x, y: rock.y }, mine: null };
  }
  return null;
};

export const Attack: Behavior = (w) => {
  const t = nearest(w, hostileNpc);
  if (!t) return null;
  const dist = d(t, w.self);
  const heading = Math.atan2(t.y - w.self.y, t.x - w.self.x);
  if (dist > 30) return { moveTo: { x: t.x, y: t.y }, targetId: t.id, firing: dist < 45 };
  return { moveTo: null, heading, thrust: 0, targetId: t.id, firing: true };
};

export const Assist: Behavior = (w) => {
  const ally = nearest(w, (e) => e.kind === "PLAYER" && !e.dead && e.faction === w.self.faction);
  if (!ally) return null;
  const tgt = ally.targetId ? w.entities.find((e) => e.id === ally.targetId && !e.dead) : undefined;
  if (tgt && hostileNpc(tgt)) return { moveTo: d(tgt, w.self) > 30 ? { x: tgt.x, y: tgt.y } : null, targetId: tgt.id, firing: d(tgt, w.self) < 45 };
  return { moveTo: d(ally, w.self) > 15 ? { x: ally.x, y: ally.y } : null, firing: false };
};

export const ShieldUp: Behavior = (w, mem) => {
  if (w.self.shield / Math.max(1, w.self.maxShield) < 0.4 && w.now - mem.lastModuleAt > 5000) {
    mem.lastModuleAt = w.now;
    return { module: 0 };
  }
  return null;
};

export const ARCHETYPES: Record<string, Behavior[]> = {
  scout: [Flee, Wander],
  miner: [Flee, Collect, Wander],
  // Fighters engage first and only collect when there is nothing to fight.
  fighter: [Flee, Attack, Collect, Wander],
  tank: [ShieldUp, Attack, Wander],
  support: [Flee, Assist, Attack, Wander],
};

/** First behaviour that returns an action wins (priority list), merged with ShieldUp-style side actions. */
export function decide(arch: Behavior[], w: BotWorld, mem: BotMemory): BotAction {
  let out: BotAction = {};
  for (const b of arch) {
    const a = b(w, mem);
    if (!a) continue;
    if (a.module !== undefined && Object.keys(a).length === 1) {
      out = { ...out, module: a.module };
      continue;
    }
    return { ...out, ...a };
  }
  return out;
}
