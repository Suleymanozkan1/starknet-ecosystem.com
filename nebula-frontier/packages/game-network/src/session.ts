import type { EntitySnapshot, MapDef, RoomName, SelfJoinInfo } from "@nebula/shared";
import { EntityFlag, RoomName as Rooms } from "@nebula/shared";
import { MAPS_BY_ID } from "@nebula/config";
import type { MoveInput } from "@nebula/game-core";
import { GameConnection, type Connection, type ConnectionEvents, type ConnectionStatus } from "./connection.js";
import { LocalConnection, isLocalServerUrl } from "./local/connection.js";
import { Emitter } from "./emitter.js";
import { InterpolationBuffer, type MotionSample } from "./interpolation.js";
import { ShipPredictor } from "./prediction.js";
import { PingTracker } from "./clock.js";

export const ROOM_FOR_MAP_TYPE: Readonly<Record<MapDef["roomType"], RoomName>> = {
  sector: Rooms.SECTOR, pvp: Rooms.PVP, boss: Rooms.BOSS, gate: Rooms.GATE, raid: Rooms.RAID,
  arena: Rooms.ARENA, clanwar: Rooms.CLAN_WAR, event: Rooms.EVENT,
};

export function roomForMap(mapId: string): RoomName {
  const map = MAPS_BY_ID.get(mapId);
  if (!map) throw new Error(`Unknown map ${mapId}`);
  return ROOM_FOR_MAP_TYPE[map.roomType];
}

export interface TicketResult {
  ticket: string;
  mapId: string;
}

export interface GameSessionOptions {
  serverUrl: string;
  /** Fetch a fresh short-lived game ticket (POST /api/game/ticket) for a map. */
  getTicket: (mapId: string) => Promise<TicketResult>;
  /** Remote entity render delay (ms). */
  interpolationDelayMs?: number;
  /** Fallback until the server's SelfJoinInfo arrives. */
  defaultTickRate?: number;
  /** Ping interval (ms). */
  pingIntervalMs?: number;
  /** Rejoin attempts with a fresh ticket after an unrecoverable disconnect. */
  maxRejoinAttempts?: number;
}

export interface SessionEvents {
  self: SelfJoinInfo;
  status: ConnectionStatus;
  /** Map/room transition lifecycle (warp effect & loading UI). */
  transition: { phase: "start" | "end" | "failed"; mapId: string; portalId?: string; error?: string };
  mapChange: { mapId: string; roomName: string };
  entityAdd: EntitySnapshot;
  entityRemove: string;
  ping: number;
}

/** Schema fields the server never assigned decode as undefined — treat as 0. */
function num(v: number | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export interface Pose {
  x: number;
  y: number;
  heading: number;
  vx: number;
  vy: number;
}

/**
 * High-level multiplayer session: typed connection + remote snapshot
 * interpolation + local prediction/reconciliation + fixed-tick input sending
 * with sequence numbers + ping + reconnection + portal jumps.
 *
 * Frame driver contract (Colyseus PREDICTION.md §4): each render frame call
 * `advance(now, readInput)` FIRST (it sends one input per due fixed step and
 * predicts), then read poses (`localPose`, `remotePose`).
 */
export class GameSession {
  readonly connection: Connection;
  readonly events = new Emitter<SessionEvents>();
  readonly interp: InterpolationBuffer;
  readonly ping = new PingTracker();
  predictor: ShipPredictor | null = null;
  self: SelfJoinInfo | null = null;
  mapId = "";
  private readonly opts: GameSessionOptions;
  private tickRate: number;
  private accumulator = 0;
  private lastAdvance = -1;
  private seq = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private readonly unsubs: (() => void)[] = [];
  private transitioning = false;
  private disposed = false;
  private rejoining = false;
  private localDead = false;
  private readonly sample: MotionSample = { x: 0, y: 0, heading: 0, vx: 0, vy: 0 };
  /** Inputs sent (diagnostics). */
  sentInputs = 0;

  constructor(opts: GameSessionOptions) {
    this.opts = opts;
    this.tickRate = opts.defaultTickRate ?? 20;
    this.connection = isLocalServerUrl(opts.serverUrl) ? new LocalConnection() : new GameConnection(opts.serverUrl);
    this.interp = new InterpolationBuffer(opts.interpolationDelayMs ?? 100);
    const c = this.connection;
    this.unsubs.push(
      c.events.on("status", (s) => this.events.emit("status", s)),
      c.events.on("entityAdd", (e) => this.onEntity(e, true)),
      c.events.on("entityChange", (e) => this.onEntity(e, false)),
      c.events.on("entityRemove", (id) => {
        this.interp.remove(id);
        this.events.emit("entityRemove", id);
      }),
      c.events.on("left", (l) => this.onLeft(l)),
      c.on("player_join", (m) => {
        if (m.self) this.onSelf(m.self);
      }),
      c.on("pong", (m) => {
        const now = performance.now();
        this.ping.sample(m.t, now, m.server);
        this.events.emit("ping", this.ping.ping);
      }),
      c.on("jump", (j) => {
        void this.followJump(j.mapId, j.roomName, j.portalId, j.reservation);
      }),
      c.on("player_respawn", (r) => {
        if (r.entityId === this.localId) this.localDead = false;
      }),
    );
  }

  get localId(): string {
    return this.connection.sessionId;
  }

  get fixedDt(): number {
    return 1 / this.tickRate;
  }

  /** Join the initial map. */
  async start(mapId: string): Promise<void> {
    this.mapId = mapId;
    const t = await this.opts.getTicket(mapId);
    this.mapId = t.mapId || mapId;
    await this.connection.join(roomForMap(this.mapId), { ticket: t.ticket, mapId: this.mapId });
    this.afterJoin();
  }

  private afterJoin(): void {
    this.interp.clear();
    this.predictor = null;
    this.accumulator = 0;
    this.lastAdvance = -1;
    this.localDead = false;
    this.events.emit("mapChange", { mapId: this.mapId, roomName: this.connection.roomName });
    this.startPing();
    // entities that arrived during join
    for (const e of this.connection.entities.values()) this.onEntity(e, true);
  }

  private startPing(): void {
    if (this.pingTimer) return;
    const send = (): void => this.connection.send("ping", { t: performance.now() });
    send();
    this.pingTimer = setInterval(send, this.opts.pingIntervalMs ?? 2000);
  }

  private onSelf(self: SelfJoinInfo): void {
    this.self = self;
    if (self.tickRate > 0) this.tickRate = self.tickRate;
    if (this.predictor) {
      this.predictor.stats = { ...this.predictor.stats, ...self.motion };
      this.predictor.dt = 1 / this.tickRate;
    }
    this.events.emit("self", self);
    const me = this.connection.entities.get(this.localId);
    if (me) this.onEntity(me, false);
  }

  private onEntity(e: EntitySnapshot, added: boolean): void {
    const now = performance.now();
    if (e.id === this.localId) {
      this.onLocalSnapshot(e);
      if (added) this.events.emit("entityAdd", e);
      return;
    }
    this.sample.x = num(e.x);
    this.sample.y = num(e.y);
    this.sample.heading = num(e.heading);
    this.sample.vx = num(e.vx);
    this.sample.vy = num(e.vy);
    this.interp.push(e.id, now, this.sample);
    if (added) this.events.emit("entityAdd", e);
  }

  private onLocalSnapshot(e: EntitySnapshot): void {
    const map = MAPS_BY_ID.get(this.mapId);
    const server = { x: num(e.x), y: num(e.y), vx: num(e.vx), vy: num(e.vy), heading: num(e.heading), energy: num(e.energy) };
    const stunned = (e.flags & EntityFlag.STUNNED) !== 0;
    if (e.dead) {
      this.localDead = true;
    } else if (this.localDead) {
      // respawned: restart prediction from the authoritative pose
      this.localDead = false;
      this.predictor?.reset(server);
    }
    if (!this.predictor) {
      if (!this.self || !map) return;
      this.predictor = new ShipPredictor(server, {
        stats: { ...this.self.motion, stunned },
        bounds: { width: map.width, height: map.height },
        dt: 1 / this.tickRate,
      });
      return;
    }
    this.predictor.stats.stunned = stunned;
    this.predictor.stats.maxEnergy = num(e.maxEnergy);
    this.predictor.reconcile(server, num(e.lastSeq));
  }

  /** True when local input should be applied (alive, not docked, predictor ready). */
  get canControl(): boolean {
    const me = this.connection.entities.get(this.localId);
    return !!this.predictor && !!me && !me.dead && (me.flags & EntityFlag.DOCKED) === 0 && !this.transitioning;
  }

  /**
   * Frame driver: advance the fixed-step clock, send one input per due step
   * (seq-numbered) and apply it to the local prediction. Returns steps run.
   */
  advance(now: number, readInput: () => MoveInput): number {
    if (this.lastAdvance < 0) {
      this.lastAdvance = now;
      return 0;
    }
    const frame = Math.min(250, Math.max(0, now - this.lastAdvance)) / 1000;
    this.lastAdvance = now;
    if (!this.connection.connected || !this.canControl) {
      this.accumulator = 0;
      return 0;
    }
    this.accumulator += frame;
    const dt = this.fixedDt;
    let steps = 0;
    while (this.accumulator >= dt && steps < 5) {
      this.accumulator -= dt;
      const input = readInput();
      this.seq = (this.seq + 1) % 2 ** 31;
      this.connection.send("input", {
        seq: this.seq, thrust: input.thrust, strafe: input.strafe, heading: input.heading, boost: input.boost, moveTo: input.moveTo ?? null,
      });
      this.sentInputs++;
      this.predictor?.step(this.seq, input);
      steps++;
    }
    if (steps === 5) this.accumulator = 0; // tab was throttled: drop the backlog instead of bursting
    return steps;
  }

  /** Accumulator fraction for render interpolation of the local ship. */
  get alpha(): number {
    return this.accumulator / this.fixedDt;
  }

  /** Predicted, smoothed local pose. Returns false before the predictor exists. */
  localPose(frameDt: number, out: Pose): boolean {
    const p = this.predictor;
    if (!p) {
      const me = this.connection.entities.get(this.localId);
      if (!me) return false;
      out.x = me.x; out.y = me.y; out.heading = me.heading; out.vx = me.vx; out.vy = me.vy;
      return true;
    }
    p.render(this.alpha, frameDt, out);
    return true;
  }

  /** Interpolated remote pose (rendered `interpolationDelayMs` in the past). */
  remotePose(id: string, now: number, out: Pose): boolean {
    return this.interp.sample(id, now, out);
  }

  /** Ask the server to jump through a portal; the server replies with `jump` + seat reservation. */
  requestJump(portalId: string): void {
    this.connection.send("jump", { portalId });
  }

  private async followJump(mapId: string, roomName: RoomName, portalId: string, reservation: unknown): Promise<void> {
    if (this.transitioning) return;
    this.transitioning = true;
    this.events.emit("transition", { phase: "start", mapId, portalId });
    try {
      this.mapId = mapId;
      if (reservation) {
        await this.connection.consumeReservation(reservation, roomName);
      } else {
        const t = await this.opts.getTicket(mapId);
        await this.connection.join(roomName, { ticket: t.ticket, mapId, portalId });
      }
      this.afterJoin();
      this.events.emit("transition", { phase: "end", mapId, portalId });
    } catch (err) {
      this.events.emit("transition", { phase: "failed", mapId, portalId, error: err instanceof Error ? err.message : String(err) });
      void this.rejoin();
    } finally {
      this.transitioning = false;
    }
  }

  private onLeft(l: ConnectionEvents["left"]): void {
    if (this.disposed || this.transitioning || l.consented) return;
    void this.rejoin();
  }

  /** The SDK's automatic reconnection failed or the room closed: rejoin with a fresh ticket. */
  private async rejoin(): Promise<void> {
    if (this.rejoining || this.disposed) return;
    this.rejoining = true;
    const max = this.opts.maxRejoinAttempts ?? 5;
    try {
      for (let attempt = 0; attempt < max && !this.disposed; attempt++) {
        await new Promise((r) => setTimeout(r, Math.min(8000, 500 * 2 ** attempt)));
        if (this.disposed || this.connection.connected) return;
        try {
          const t = await this.opts.getTicket(this.mapId);
          await this.connection.join(roomForMap(t.mapId || this.mapId), { ticket: t.ticket, mapId: t.mapId || this.mapId });
          this.mapId = t.mapId || this.mapId;
          this.afterJoin();
          return;
        } catch (err) {
          console.warn(`[game-network] rejoin attempt ${attempt + 1} failed`, err);
        }
      }
    } finally {
      this.rejoining = false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.connection.dispose();
    this.events.clear();
    this.interp.clear();
  }
}
