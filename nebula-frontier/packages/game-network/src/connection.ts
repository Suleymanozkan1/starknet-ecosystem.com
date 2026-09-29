import { Callbacks, Client, type Room } from "@colyseus/sdk";
import type { ClientMessages, EntitySnapshot, JoinOptions, RoomName, ServerEvents } from "@nebula/shared";
import { Emitter } from "./emitter.js";

export type ConnectionStatus = "idle" | "connecting" | "connected" | "reconnecting" | "switching" | "disconnected";

/** Root fields of the synchronized WorldState (mirrors apps/game-server schema/state.ts). */
export interface WorldStateView {
  mapId: string;
  roomKind: string;
  region: string;
  serverTime: number;
  tick: number;
  online: number;
  eventId: string;
  eventName: string;
  eventEndsAt: number;
  xpMultiplier: number;
  dropMultiplier: number;
  bossId: string;
  bossName: string;
  bossPhase: number;
  bossHullPct: number;
  match?: {
    matchId: string;
    mode: string;
    phase: string;
    startsAt: number;
    endsAt: number;
    teamScores?: ArrayLike<number>;
    wave: number;
    totalWaves: number;
    difficulty: string;
  };
}

export interface ConnectionEvents {
  status: ConnectionStatus;
  /** Entity decoded for the first time (live schema instance — read, don't store fields). */
  entityAdd: EntitySnapshot;
  entityChange: EntitySnapshot;
  entityRemove: string;
  /** Room joined (initial state available). */
  joined: { roomName: string; roomId: string; sessionId: string };
  left: { code: number; reason?: string; consented: boolean };
  error: { code: number; message?: string };
}

/**
 * Public surface of a game connection. `GameConnection` talks to Colyseus; `LocalConnection`
 * (demo mode) runs an in-browser simulation behind the same contract.
 */
export interface Connection {
  readonly events: Emitter<ConnectionEvents>;
  readonly status: ConnectionStatus;
  readonly sessionId: string;
  readonly roomName: string;
  readonly connected: boolean;
  readonly state: WorldStateView | null;
  readonly entities: ReadonlyMap<string, EntitySnapshot>;
  join(roomName: RoomName, options: JoinOptions): Promise<void>;
  consumeReservation(reservation: unknown, roomName: string): Promise<void>;
  send<K extends keyof ClientMessages>(type: K, payload: ClientMessages[K]): void;
  on<K extends keyof ServerEvents>(type: K, cb: (payload: ServerEvents[K]) => void): () => void;
  leave(): Promise<void>;
  dispose(): void;
}

type AnyRoom = Room<unknown, WorldStateLike>;
interface WorldStateLike extends WorldStateView {
  entities: { forEach(cb: (e: EntitySnapshot, id: string) => void): void; get(id: string): EntitySnapshot | undefined };
}

/**
 * Typed Colyseus 0.18 client wrapper. Server events and entity callbacks are
 * re-emitted through stable emitters so subscribers survive room switches
 * (portal jumps) and reconnections.
 */
export class GameConnection implements Connection {
  readonly client: InstanceType<typeof Client>;
  readonly events = new Emitter<ConnectionEvents>();
  private readonly serverEvents = new Emitter<ServerEvents>();
  private room: AnyRoom | null = null;
  private readonly entityMap = new Map<string, EntitySnapshot>();
  private unbind: (() => void)[] = [];
  private switching = false;
  private statusValue: ConnectionStatus = "idle";
  private roomNameValue = "";

  constructor(serverUrl: string) {
    this.client = new Client(serverUrl);
  }

  get status(): ConnectionStatus {
    return this.statusValue;
  }

  private setStatus(s: ConnectionStatus): void {
    if (this.statusValue === s) return;
    this.statusValue = s;
    this.events.emit("status", s);
  }

  get sessionId(): string {
    return this.room?.sessionId ?? "";
  }

  get roomName(): string {
    return this.roomNameValue;
  }

  get connected(): boolean {
    return this.statusValue === "connected" && !!this.room;
  }

  /** Root state (null before join). */
  get state(): WorldStateView | null {
    return (this.room?.state as WorldStateView | undefined) ?? null;
  }

  /** Live entity map (decoded schema instances keyed by entity id). */
  get entities(): ReadonlyMap<string, EntitySnapshot> {
    return this.entityMap;
  }

  /** Join (or create) a room for a map with a fresh ticket. */
  async join(roomName: RoomName, options: JoinOptions): Promise<void> {
    this.setStatus(this.room ? "switching" : "connecting");
    await this.leaveCurrent();
    try {
      const room = (await this.client.joinOrCreate(roomName, options)) as unknown as AnyRoom;
      this.bind(room, roomName);
    } catch (err) {
      this.setStatus("disconnected");
      throw err;
    }
  }

  /** Join through a seat reservation issued by the server (portal jump). */
  async consumeReservation(reservation: unknown, roomName: string): Promise<void> {
    this.setStatus("switching");
    await this.leaveCurrent();
    try {
      const room = (await this.client.consumeSeatReservation(reservation as Parameters<typeof this.client.consumeSeatReservation>[0])) as unknown as AnyRoom;
      this.bind(room, roomName);
    } catch (err) {
      this.setStatus("disconnected");
      throw err;
    }
  }

  private bind(room: AnyRoom, roomName: string): void {
    this.room = room;
    this.roomNameValue = roomName;
    this.entityMap.clear();
    room.reconnection.maxRetries = 12;
    room.reconnection.minDelay = 250;
    room.reconnection.maxDelay = 5000;

    const offMsg = room.onMessage("*", (type: string | number, payload: unknown) => {
      if (typeof type !== "string") return;
      this.serverEvents.emit(type as keyof ServerEvents, payload as ServerEvents[keyof ServerEvents]);
    });
    this.unbind.push(offMsg);

    const cb = Callbacks.get(room as unknown as Parameters<typeof Callbacks.get>[0]) as unknown as {
      onAdd(prop: string, h: (e: EntitySnapshot, id: string) => void, immediate?: boolean): () => void;
      onRemove(prop: string, h: (e: EntitySnapshot, id: string) => void): () => void;
      onChange(instance: object, h: () => void): () => void;
    };
    const changeUnsubs = new Map<string, () => void>();
    this.unbind.push(cb.onAdd("entities", (e, id) => {
      this.entityMap.set(id, e);
      this.events.emit("entityAdd", e);
      changeUnsubs.set(id, cb.onChange(e, () => this.events.emit("entityChange", e)));
    }, true));
    this.unbind.push(cb.onRemove("entities", (_e, id) => {
      this.entityMap.delete(id);
      changeUnsubs.get(id)?.();
      changeUnsubs.delete(id);
      this.events.emit("entityRemove", id);
    }));
    this.unbind.push(() => {
      for (const u of changeUnsubs.values()) u();
      changeUnsubs.clear();
    });

    const onDrop = (): void => this.setStatus("reconnecting");
    const onReconnect = (): void => this.setStatus("connected");
    const onLeave = (code: number, reason?: string): void => {
      if (this.room !== room) return;
      const consented = this.switching || code === 1000 || code === 4000;
      this.room = null;
      this.clearBindings();
      for (const id of [...this.entityMap.keys()]) this.events.emit("entityRemove", id);
      this.entityMap.clear();
      if (!this.switching) this.setStatus("disconnected");
      this.events.emit("left", { code, reason, consented });
    };
    const onError = (code: number, message?: string): void => this.events.emit("error", { code, message });
    room.onDrop(onDrop);
    room.onReconnect(onReconnect);
    room.onLeave(onLeave);
    room.onError(onError);
    this.unbind.push(() => {
      room.onDrop.remove(onDrop);
      room.onReconnect.remove(onReconnect);
      room.onLeave.remove(onLeave);
      room.onError.remove(onError);
    });
    this.setStatus("connected");
    this.events.emit("joined", { roomName, roomId: room.roomId, sessionId: room.sessionId });
  }

  private clearBindings(): void {
    for (const u of this.unbind) u();
    this.unbind = [];
  }

  private async leaveCurrent(): Promise<void> {
    const r = this.room;
    if (!r) return;
    this.switching = true;
    try {
      await r.leave(true);
    } catch {
      // already closed
    } finally {
      if (this.room === r) {
        this.room = null;
        this.clearBindings();
        for (const id of [...this.entityMap.keys()]) this.events.emit("entityRemove", id);
        this.entityMap.clear();
      }
      this.switching = false;
    }
  }

  /** Typed intent send. Dropped silently while not connected (the SDK buffers during reconnection). */
  send<K extends keyof ClientMessages>(type: K, payload: ClientMessages[K]): void {
    const r = this.room;
    if (!r) return;
    (r.send as (t: string, p: unknown) => void)(type, payload);
  }

  /** Subscribe to a typed server event. Survives room switches. */
  on<K extends keyof ServerEvents>(type: K, cb: (payload: ServerEvents[K]) => void): () => void {
    return this.serverEvents.on(type, cb);
  }

  async leave(): Promise<void> {
    await this.leaveCurrent();
    this.setStatus("disconnected");
  }

  dispose(): void {
    void this.leave();
    this.events.clear();
    this.serverEvents.clear();
  }
}
