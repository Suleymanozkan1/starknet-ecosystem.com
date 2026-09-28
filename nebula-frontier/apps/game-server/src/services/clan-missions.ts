/**
 * Clan-mission progress reporter (game server → API).
 *
 * Clan missions with *targeted* objectives (a specific NPC, map, boss, gate,
 * item or resource) cannot be derived from PlayerStat counters, so the game
 * server reports the gameplay events of clan members to
 * `POST {API_INTERNAL_URL}/api/internal/clan-missions/progress`
 * (`x-internal-token: INTERNAL_SERVICE_TOKEN`, body `{ events: [{ userId, event }] }`,
 * ≤ 500 events per request — see @nebula/validation clanMissionProgressSchema).
 *
 * Never blocks the tick: events are queued in memory (quantity events such as
 * boss damage and mining are aggregated per user/target), flushed together with
 * the persistence flush, sent fire-and-forget and retried with backoff. Mission
 * progress is a non-critical side channel: after `maxAttempts` a batch is dropped
 * and logged (untargeted objectives still progress from PlayerStat in the API).
 */
import type { GameplayEvent } from "@nebula/game-core";
import { errorsTotal, type Logger } from "@nebula/telemetry";

export interface ClanMissionEvent {
  userId: string;
  event: GameplayEvent;
}

/** Event types that clan-mission objectives can target. */
const REPORTED = new Set<GameplayEvent["type"]>(["KILL", "KILL_PLAYER", "COLLECT", "MINE", "TRAVEL", "DAMAGE_BOSS", "COMPLETE_GATE", "WIN_PVP", "DELIVER"]);

const MAX_BATCH = 500;
const MAX_QUEUE = 20_000;

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

export class ClanMissionReporter {
  private queue: ClanMissionEvent[] = [];
  /** Aggregated quantity events keyed by user|type|target|map. */
  private agg = new Map<string, ClanMissionEvent>();
  private inFlight = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly url: string;
  private readonly token: string | null;
  private readonly log: Logger;
  private readonly fetchImpl: Fetch;
  private readonly maxAttempts: number;
  private warnedDisabled = false;
  /** Diagnostics. */
  sent = 0;
  dropped = 0;

  constructor(opts: { baseUrl: string; token: string | null; log: Logger; fetchImpl?: Fetch; maxAttempts?: number }) {
    this.url = `${opts.baseUrl}/api/internal/clan-missions/progress`;
    this.token = opts.token;
    this.log = opts.log;
    this.fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
    this.maxAttempts = opts.maxAttempts ?? 5;
  }

  get enabled(): boolean {
    return !!this.token;
  }

  /** Queue an event for a clan member (no-op for non-reported types or when disabled). */
  report(userId: string, clanId: string | null, event: GameplayEvent): void {
    if (!clanId || !REPORTED.has(event.type)) return;
    if (!this.enabled) {
      if (!this.warnedDisabled) {
        this.warnedDisabled = true;
        this.log.warn("INTERNAL_SERVICE_TOKEN not set: clan-mission progress reporting disabled");
      }
      return;
    }
    if (event.type === "DAMAGE_BOSS" || event.type === "MINE" || event.type === "COLLECT" || event.type === "DELIVER") {
      const target = event.type === "DAMAGE_BOSS" ? event.bossId : event.type === "COLLECT" ? event.itemId : event.resourceId;
      const key = `${userId}|${event.type}|${target}|${event.mapId}`;
      const cur = this.agg.get(key);
      if (cur) {
        const e = cur.event;
        if (e.type === "DAMAGE_BOSS" && event.type === "DAMAGE_BOSS") e.amount += event.amount;
        else if ((e.type === "MINE" || e.type === "COLLECT" || e.type === "DELIVER") && "quantity" in event) e.quantity += event.quantity;
        return;
      }
      this.agg.set(key, { userId, event: { ...event } });
      return;
    }
    this.queue.push({ userId, event });
    if (this.queue.length > MAX_QUEUE) {
      const n = this.queue.length - MAX_QUEUE;
      this.queue.splice(0, n);
      this.dropped += n;
    }
  }

  pending(): number {
    return this.queue.length + this.agg.size;
  }

  start(intervalMs: number): void {
    this.timer = setInterval(() => void this.flush(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Send everything queued. Fire-and-forget safe: never throws. */
  async flush(): Promise<void> {
    if (this.inFlight || !this.enabled) return;
    for (const e of this.agg.values()) {
      const ev = e.event;
      const amount = ev.type === "DAMAGE_BOSS" ? ev.amount : "quantity" in ev ? ev.quantity : 1;
      if (amount >= 1) this.queue.push({ userId: e.userId, event: ev.type === "DAMAGE_BOSS" ? { ...ev, amount: Math.floor(ev.amount) } : ev });
    }
    this.agg.clear();
    if (!this.queue.length) return;
    this.inFlight = true;
    try {
      while (this.queue.length) {
        const batch = this.queue.splice(0, MAX_BATCH);
        const ok = await this.sendWithRetry(batch);
        if (ok) this.sent += batch.length;
        else {
          this.dropped += batch.length;
          errorsTotal.inc({ component: "clan_missions", code: "dropped" });
          this.log.error({ events: batch.length }, "clan-mission progress batch dropped after retries");
        }
      }
    } finally {
      this.inFlight = false;
    }
  }

  private async sendWithRetry(events: ClanMissionEvent[]): Promise<boolean> {
    const body = JSON.stringify({ events });
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const res = await this.fetchImpl(this.url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-internal-token": this.token ?? "" },
          body,
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) return true;
        // 4xx other than 429 will not succeed on retry (bad payload / bad token).
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          this.log.error({ status: res.status }, "clan-mission progress rejected by API");
          return false;
        }
      } catch (e) {
        this.log.warn({ err: e, attempt }, "clan-mission progress post failed");
      }
      await new Promise((r) => setTimeout(r, Math.min(10_000, 200 * 2 ** attempt)));
    }
    return false;
  }
}
