/**
 * Event engine. Scheduled windows (events.json startAt/endAt + recurrence) are
 * evaluated deterministically from the clock in every process, so all shards
 * agree without coordination. Dynamic triggers (e.g. an admin opening a VOID
 * RIFT now) arrive over presence pub/sub (`nf:events:trigger`) and are
 * rebroadcast to every process/room.
 */
import { EventEmitter } from "node:events";
import { EVENTS, EVENTS_BY_ID } from "@nebula/config";
import { activeEventWindow, eventMultipliers, type EventWindow } from "@nebula/game-core";
import type { EventDef, GameEventNotice } from "@nebula/shared";
import { z } from "zod";

export const EVENT_TRIGGER_TOPIC = "nf:events:trigger";

const TriggerSchema = z.object({ eventId: z.string().max(96), durationMinutes: z.number().positive().max(24 * 60), startAt: z.number().optional() });

export interface PresenceLike {
  subscribe(topic: string, cb: (data: unknown) => void): Promise<unknown>;
  unsubscribe(topic: string, cb?: (data: unknown) => void): unknown;
  publish(topic: string, data: unknown): unknown;
}

export interface ActiveEvent {
  def: EventDef;
  window: EventWindow;
}

export class EventEngine extends EventEmitter {
  private active = new Map<string, ActiveEvent>();
  private overrides = new Map<string, EventWindow>();
  private timer: NodeJS.Timeout | null = null;
  private presence: PresenceLike | null = null;
  private readonly onTrigger = (data: unknown) => {
    const p = TriggerSchema.safeParse(data);
    if (!p.success || !EVENTS_BY_ID.has(p.data.eventId)) return;
    const start = p.data.startAt ?? Date.now();
    this.overrides.set(p.data.eventId, { start, end: start + p.data.durationMinutes * 60_000 });
    this.evaluate(Date.now());
  };

  constructor() {
    super();
    this.setMaxListeners(0);
  }

  /**
   * Begin evaluating event windows. A failed trigger-topic subscription is never an unhandled
   * rejection: it is emitted as `subscribeError` and passed to `onError` (the caller logs it).
   */
  start(presence: PresenceLike | null, intervalMs = 5000, onError?: (err: unknown) => void): void {
    this.presence = presence;
    if (presence) {
      Promise.resolve()
        .then(() => presence.subscribe(EVENT_TRIGGER_TOPIC, this.onTrigger))
        .catch((err: unknown) => {
          this.emit("subscribeError", err);
          onError?.(err);
        });
    }
    this.evaluate(Date.now());
    this.timer = setInterval(() => this.evaluate(Date.now()), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.presence) this.presence.unsubscribe(EVENT_TRIGGER_TOPIC, this.onTrigger);
  }

  /** Start an event now on every process (admin / dynamic rift). */
  trigger(eventId: string, durationMinutes: number): void {
    const msg = { eventId, durationMinutes, startAt: Date.now() };
    if (this.presence) this.presence.publish(EVENT_TRIGGER_TOPIC, msg);
    else this.onTrigger(msg);
  }

  evaluate(now: number): void {
    for (const def of EVENTS) {
      const ov = this.overrides.get(def.id);
      let w: EventWindow | null = null;
      if (ov && now >= ov.start && now < ov.end) w = ov;
      else {
        if (ov && now >= ov.end) this.overrides.delete(def.id);
        w = activeEventWindow(def, now);
      }
      const cur = this.active.get(def.id);
      if (w && (!cur || cur.window.start !== w.start)) {
        if (cur) this.emit("finished", cur);
        const ae = { def, window: w };
        this.active.set(def.id, ae);
        this.emit("started", ae);
      } else if (!w && cur) {
        this.active.delete(def.id);
        this.emit("finished", cur);
      }
    }
  }

  activeFor(mapId: string): ActiveEvent[] {
    return [...this.active.values()].filter((a) => a.def.maps.includes(mapId));
  }

  allActive(): ActiveEvent[] {
    return [...this.active.values()];
  }

  multipliers(mapId: string): { xp: number; drop: number } {
    return eventMultipliers(this.activeFor(mapId));
  }

  static notice(a: ActiveEvent): GameEventNotice {
    return { eventId: a.def.id, name: a.def.name, type: a.def.type, mapIds: a.def.maps, endsAt: new Date(a.window.end).toISOString() };
  }
}
