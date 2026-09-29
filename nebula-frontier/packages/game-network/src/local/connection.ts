import type { ClientMessages, EntitySnapshot, JoinOptions, RoomName, ServerEvents } from "@nebula/shared";
import { FACTIONS } from "@nebula/config";
import type { Connection, ConnectionEvents, ConnectionStatus, WorldStateView } from "../connection.js";
import { Emitter } from "../emitter.js";
import { LOCAL_TICK_RATE, LocalWorld, type LocalPilot } from "./world.js";

/** Server URL scheme that selects the offline demo simulation instead of Colyseus. */
export const LOCAL_SERVER_URL = "local://demo";

export function isLocalServerUrl(url: string): boolean {
  return url.startsWith("local:");
}

const TICKET_PREFIX = "demo.";

/** Encode a demo pilot into a game ticket (demo mode only — carries no authority). */
export function encodeDemoTicket(pilot: LocalPilot): string {
  const json = JSON.stringify(pilot);
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(json)));
  return `${TICKET_PREFIX}${b64}`;
}

/** Decode a demo ticket; unknown or malformed tickets fall back to a default pilot. */
export function decodeDemoTicket(ticket: string): LocalPilot {
  const fallbackFaction = FACTIONS[0];
  const fallback: LocalPilot = {
    userId: "demo-pilot", name: "Demo Pilot", factionId: fallbackFaction?.id ?? "", shipId: fallbackFaction?.starterShip ?? "", xp: 0,
  };
  if (!ticket.startsWith(TICKET_PREFIX)) return fallback;
  try {
    const bytes = Uint8Array.from(atob(ticket.slice(TICKET_PREFIX.length)), (c) => c.charCodeAt(0));
    const raw = JSON.parse(new TextDecoder().decode(bytes)) as Partial<Record<keyof LocalPilot, unknown>>;
    const str = (v: unknown, d: string): string => (typeof v === "string" && v.length > 0 && v.length <= 64 ? v : d);
    const xp = typeof raw.xp === "number" && Number.isFinite(raw.xp) && raw.xp >= 0 ? Math.floor(raw.xp) : 0;
    return {
      userId: str(raw.userId, fallback.userId),
      name: str(raw.name, fallback.name),
      factionId: str(raw.factionId, fallback.factionId),
      shipId: str(raw.shipId, fallback.shipId),
      xp,
    };
  } catch {
    return fallback;
  }
}

/**
 * Drop-in replacement for `GameConnection` that runs the room simulation in the
 * browser (demo mode). Entities are plain objects mutated by the world each tick;
 * change notifications are emitted after every tick like Colyseus schema callbacks.
 */
export class LocalConnection implements Connection {
  readonly events = new Emitter<ConnectionEvents>();
  private readonly serverEvents = new Emitter<ServerEvents>();
  private readonly entityMap = new Map<string, EntitySnapshot>();
  private world: LocalWorld | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private statusValue: ConnectionStatus = "idle";
  private roomNameValue = "";
  private lastTick = 0;
  /** XP carried across map switches within this session. */
  private carriedXp: number | null = null;

  get status(): ConnectionStatus {
    return this.statusValue;
  }

  private setStatus(s: ConnectionStatus): void {
    if (this.statusValue === s) return;
    this.statusValue = s;
    this.events.emit("status", s);
  }

  get sessionId(): string {
    return this.world?.localId ?? "";
  }

  get roomName(): string {
    return this.roomNameValue;
  }

  get connected(): boolean {
    return this.statusValue === "connected" && !!this.world;
  }

  get state(): WorldStateView | null {
    return this.world?.state ?? null;
  }

  get entities(): ReadonlyMap<string, EntitySnapshot> {
    return this.entityMap;
  }

  async join(roomName: RoomName, options: JoinOptions): Promise<void> {
    this.setStatus(this.world ? "switching" : "connecting");
    this.stopWorld();
    const pilot = decodeDemoTicket(options.ticket);
    if (this.carriedXp !== null) pilot.xp = Math.max(pilot.xp, this.carriedXp);
    const world = new LocalWorld(options.mapId, pilot, options.portalId ?? null, {
      add: (e) => {
        this.entityMap.set(e.id, e);
        this.events.emit("entityAdd", e);
      },
      remove: (id) => {
        if (!this.entityMap.delete(id)) return;
        this.events.emit("entityRemove", id);
      },
      event: (type, payload) => this.serverEvents.emit(type, payload),
    });
    this.world = world;
    this.roomNameValue = roomName;
    const self = world.start();
    this.setStatus("connected");
    this.events.emit("joined", { roomName, roomId: `local:${options.mapId}`, sessionId: world.localId });
    // Like Colyseus, the join message arrives after joinOrCreate resolves.
    await Promise.resolve();
    setTimeout(() => {
      if (this.world !== world) return;
      this.serverEvents.emit("player_join", { entityId: world.localId, name: pilot.name, self });
      this.serverEvents.emit("notice", { level: "info", text: "Demo mode: offline simulation — progress is kept in this browser only." });
    }, 0);
    this.lastTick = performance.now();
    this.timer = setInterval(() => this.step(), 1000 / LOCAL_TICK_RATE);
  }

  async consumeReservation(_reservation: unknown, roomName: string): Promise<void> {
    const mapId = this.world?.state.mapId ?? "";
    await this.join(roomName as RoomName, { ticket: "", mapId });
  }

  private step(): void {
    const w = this.world;
    if (!w) return;
    const now = performance.now();
    // Background tabs throttle timers; never simulate more than 250 ms at once.
    const dtMs = Math.min(250, Math.max(0, now - this.lastTick));
    this.lastTick = now;
    try {
      w.tick(dtMs);
    } catch (err) {
      console.error("[game-network] local simulation tick failed", err);
      return;
    }
    for (const e of this.entityMap.values()) {
      if (e.kind === "PLAYER" || e.kind === "NPC" || e.kind === "BOSS" || e.kind === "ASTEROID") this.events.emit("entityChange", e);
    }
  }

  private stopWorld(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.world) this.carriedXp = this.world.pilotXp;
    this.world = null;
    for (const id of [...this.entityMap.keys()]) {
      this.entityMap.delete(id);
      this.events.emit("entityRemove", id);
    }
  }

  send<K extends keyof ClientMessages>(type: K, payload: ClientMessages[K]): void {
    this.world?.handle(type, payload);
  }

  on<K extends keyof ServerEvents>(type: K, cb: (payload: ServerEvents[K]) => void): () => void {
    return this.serverEvents.on(type, cb);
  }

  async leave(): Promise<void> {
    this.stopWorld();
    this.setStatus("disconnected");
  }

  dispose(): void {
    void this.leave();
    this.events.clear();
    this.serverEvents.clear();
  }
}
