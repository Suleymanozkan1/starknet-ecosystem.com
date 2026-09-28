/**
 * Galaxy presence room: online counts per map/room type across all processes
 * (via the matchmaker driver — Redis when REDIS_URL is set) and active events.
 * Clients use it for the galaxy map / server browser. Authenticated with the
 * same game ticket (any map).
 */
import { Room, ServerError, matchMaker, type Client } from "@colyseus/core";
import { MAPS } from "@nebula/config";
import { ServerEvent } from "@nebula/shared";
import { JoinOptionsSchema } from "../protocol/messages.js";
import { GalaxyState, MapPresence } from "../schema/state.js";
import { getServices, type GameServices } from "../services/context.js";
import { EventEngine } from "../services/events.js";
import { TicketError } from "../services/tickets.js";

export class GalaxyRoom extends Room<{ state: GalaxyState }> {
  override state = new GalaxyState();
  private svc!: GameServices;

  override onCreate(): void {
    this.svc = getServices();
    this.maxClients = 5000;
    this.patchRate = 1000;
    for (const m of MAPS) {
      const mp = new MapPresence();
      mp.mapId = m.id;
      this.state.maps.set(m.id, mp);
    }
    const started = (a: Parameters<typeof EventEngine.notice>[0]) => this.broadcast(ServerEvent.EVENT_STARTED, EventEngine.notice(a));
    const finished = (a: Parameters<typeof EventEngine.notice>[0]) => this.broadcast(ServerEvent.EVENT_FINISHED, EventEngine.notice(a));
    this.svc.events.on("started", started);
    this.svc.events.on("finished", finished);
    this.onDispose = () => {
      this.svc.events.off("started", started);
      this.svc.events.off("finished", finished);
    };
    this.onMessage("ping", (client: Client, m: unknown) => {
      const t = typeof (m as { t?: unknown })?.t === "number" ? (m as { t: number }).t : 0;
      client.send(ServerEvent.PONG, { t, server: Date.now() });
    });
    void this.refresh();
    this.clock.setInterval(() => void this.refresh(), 5000);
  }

  override async onAuth(_client: Client, raw: unknown): Promise<{ userId: string }> {
    const parsed = JoinOptionsSchema.safeParse(raw);
    if (!parsed.success) throw new ServerError(4400, "Invalid join options");
    try {
      const c = await this.svc.tickets.verifyAndConsume(parsed.data.ticket);
      return { userId: c.sub };
    } catch (e) {
      if (e instanceof TicketError) throw new ServerError(4401, e.code);
      throw e;
    }
  }

  override onJoin(client: Client): void {
    for (const a of this.svc.events.allActive()) client.send(ServerEvent.EVENT_STARTED, EventEngine.notice(a));
  }

  private async refresh(): Promise<void> {
    try {
      const rooms = await matchMaker.query({});
      let online = 0;
      const perMap = new Map<string, { players: number; rooms: number }>();
      for (const r of rooms) {
        const meta = (r.metadata ?? {}) as { mapId?: string };
        if (r.name === "galaxy" || r.name === "lobby") continue;
        online += r.clients;
        if (!meta.mapId) continue;
        const cur = perMap.get(meta.mapId) ?? { players: 0, rooms: 0 };
        cur.players += r.clients;
        cur.rooms += 1;
        perMap.set(meta.mapId, cur);
      }
      this.state.online = online;
      this.state.serverTime = Date.now();
      for (const [id, mp] of this.state.maps) {
        const v = perMap.get(id);
        mp.players = v?.players ?? 0;
        mp.rooms = v?.rooms ?? 0;
        mp.eventId = this.svc.events.activeFor(id)[0]?.def.id ?? "";
      }
      const active = this.svc.events.allActive().map((a) => a.def.id);
      this.state.activeEvents.clear();
      for (const a of active) this.state.activeEvents.push(a);
    } catch (e) {
      this.svc.log.error({ err: e }, "galaxy refresh failed");
    }
  }
}
