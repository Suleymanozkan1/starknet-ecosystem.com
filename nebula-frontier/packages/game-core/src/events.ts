/**
 * Game event windows (events.json): a fixed [startAt, endAt) window, optionally
 * with recurrence (every N hours for M minutes, anchored at startAt).
 */
import type { EventDef } from "@nebula/shared";

export interface EventWindow { start: number; end: number }

/** Active window containing `now`, or null. */
export function activeEventWindow(def: EventDef, now: number): EventWindow | null {
  const start = Date.parse(def.startAt);
  const end = Date.parse(def.endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || now < start || now >= end) return null;
  if (!def.recurrence) return { start, end };
  const period = def.recurrence.everyHours * 3_600_000;
  const dur = def.recurrence.durationMinutes * 60_000;
  if (period <= 0 || dur <= 0) return null;
  const k = Math.floor((now - start) / period);
  const ws = start + k * period;
  const we = Math.min(ws + dur, end);
  return now >= ws && now < we ? { start: ws, end: we } : null;
}

/** Next window starting after `now` (or the current one if active). */
export function nextEventWindow(def: EventDef, now: number): EventWindow | null {
  const active = activeEventWindow(def, now);
  if (active) return active;
  const start = Date.parse(def.startAt);
  const end = Date.parse(def.endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || now >= end) return null;
  if (now < start) {
    const dur = def.recurrence ? def.recurrence.durationMinutes * 60_000 : end - start;
    return { start, end: Math.min(start + dur, end) };
  }
  if (!def.recurrence) return null;
  const period = def.recurrence.everyHours * 3_600_000;
  const k = Math.floor((now - start) / period) + 1;
  const ws = start + k * period;
  if (ws >= end) return null;
  return { start: ws, end: Math.min(ws + def.recurrence.durationMinutes * 60_000, end) };
}

export function activeEventsForMap(defs: EventDef[], mapId: string, now: number): { def: EventDef; window: EventWindow }[] {
  const out: { def: EventDef; window: EventWindow }[] = [];
  for (const def of defs) {
    if (!def.maps.includes(mapId)) continue;
    const w = activeEventWindow(def, now);
    if (w) out.push({ def, window: w });
  }
  return out;
}

/** Combined multipliers of all active events on a map (multiplicative). */
export function eventMultipliers(active: { def: EventDef }[]): { xp: number; drop: number } {
  let xp = 1;
  let drop = 1;
  for (const a of active) {
    xp *= a.def.xpMultiplier || 1;
    drop *= a.def.dropMultiplier || 1;
  }
  return { xp, drop };
}

/** Contribution tier for an event reward (highest tier whose minContribution is met; contribution in percent points). */
export function contributionTier(def: EventDef, contributionPct: number): EventDef["rewards"][number] | null {
  let best: EventDef["rewards"][number] | null = null;
  for (const r of def.rewards) if (contributionPct >= r.minContribution && (!best || r.minContribution >= best.minContribution)) best = r;
  return best;
}
