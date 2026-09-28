import type {
  ClientMessages, EntitySnapshot, GraphicsTier, MapDef, SelfJoinInfo, ServerEvents, ZoneType,
} from "@nebula/shared";
import { EntityFlag } from "@nebula/shared";
import { MAPS_BY_ID, QUESTS_BY_ID, WEAPONS_BY_ID, NPCS_BY_ID, ITEMS_BY_ID } from "@nebula/config";
import { DEFAULT_TUNING, type MoveInput } from "@nebula/game-core";
import { GameSession, type ConnectionStatus, type Pose } from "@nebula/game-network";
import { WorldRenderer, hashString, resolveTier, type EntityRenderInput } from "@nebula/game-renderer";
import { AudioManager, type SfxKind } from "./audio/AudioManager.js";
import { InputManager, intentToMoveInput, type InputAction, type MoveIntent } from "./input/InputManager.js";
import { OverlayLayer } from "./overlay/OverlayLayer.js";
import { computeZone, relationOf, type RelationContext } from "./hud/relations.js";
import type {
  AudioVolumes, GameClientOptions, GameHandle, GameUiEvent, HudCooldown, HudPrompt, HudState, MinimapEntity, TargetMode,
} from "./types.js";

const HUD_INTERVAL_MS = 100;
const PORTAL_PROMPT_RANGE = 16;
const STATION_PROMPT_RANGE = 32;
const LOOT_RANGE = 22;
const MINE_RANGE = 35;
const PICK_RADIUS_PX = 34;

interface CooldownStart { at: number; ms: number }

/** Unset schema fields decode as undefined. */
function num(v: number | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Orchestrates renderer, overlay, network session, input and audio. */
export class Game {
  private readonly opts: GameClientOptions;
  private readonly root: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly overlayHost: HTMLDivElement;
  private world!: WorldRenderer;
  private overlay!: OverlayLayer;
  private readonly audio: AudioManager;
  private readonly input: InputManager;
  private readonly session: GameSession;
  private tier: GraphicsTier;
  private raf = 0;
  private paused = false;
  private disposed = false;
  private ro: ResizeObserver | null = null;
  private readonly unsubs: (() => void)[] = [];
  private readonly renderInputs = new Map<string, EntityRenderInput>();
  private readonly kinds = new Map<string, EntitySnapshot["kind"]>();
  private readonly pose: Pose = { x: 0, y: 0, heading: 0, vx: 0, vy: 0 };
  private readonly localPose: Pose = { x: 0, y: 0, heading: 0, vx: 0, vy: 0 };
  private hasLocalPose = false;
  private readonly intent: MoveIntent = { mx: 0, my: 0, aim: Number.NaN, boost: false };
  private readonly moveInput: MoveInput = { thrust: 0, strafe: 0, heading: Number.NaN, boost: false, moveTo: null };
  private moveTo: { x: number; y: number } | null = null;
  private lastFrame = -1;
  private lastHud = 0;
  private firing = false;
  private secondary = false;
  private cameraSnapped = false;
  private wasDead = false;
  private wasDocked = false;
  private lastDamageAt = -1e9;
  private lastAimSent = 0;
  private readonly cooldowns = new Map<number, CooldownStart>();
  private hud: HudState;
  private xpGained = 0;
  private creditsGained = 0;
  private honorGained = 0;
  private quest: HudState["questObjective"] = null;
  private readonly tmpScreen = { x: 0, y: 0 };
  private readonly tmpMap = { x: 0, y: 0 };
  private readonly relCtx: RelationContext = { selfId: "", faction: "", clanTag: "", pvp: false, scanned: new Set<string>() };
  private map: MapDef | null = null;
  private lastFps = 0;

  constructor(opts: GameClientOptions) {
    this.opts = opts;
    this.tier = resolveTier(opts.graphics ?? "AUTO");
    const root = document.createElement("div");
    root.style.cssText = "position:relative;width:100%;height:100%;overflow:hidden;touch-action:none;user-select:none;background:#02030a;";
    root.tabIndex = 0;
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;";
    const overlayHost = document.createElement("div");
    overlayHost.style.cssText = "position:absolute;inset:0;pointer-events:none;";
    root.append(canvas, overlayHost);
    opts.container.appendChild(root);
    this.root = root;
    this.canvas = canvas;
    this.overlayHost = overlayHost;
    this.audio = new AudioManager(opts.volume);
    this.input = new InputManager(root, !!opts.isMobile);
    this.session = new GameSession({ serverUrl: opts.serverUrl, getTicket: opts.getTicket });
    this.hud = this.emptyHud();
  }

  async init(): Promise<void> {
    const rect = this.root.getBoundingClientRect();
    this.world = await WorldRenderer.create({ canvas: this.canvas, tier: this.tier, backend: this.opts.renderer ?? "webgl" });
    this.world.resize(rect.width, rect.height);
    this.overlay = new OverlayLayer(this.overlayHost, rect.width, rect.height);
    this.overlay.model.compact = !!this.opts.isMobile;
    this.emit({ type: "graphics", tier: this.tier, backend: this.world.backend.kind });

    this.input.aimFromScreen = (sx, sy) => {
      if (!this.hasLocalPose || !this.world.screenToMap(sx, sy, this.tmpMap)) return null;
      return Math.atan2(this.tmpMap.y - this.localPose.y, this.tmpMap.x - this.localPose.x);
    };
    this.input.onAction = (a) => this.onAction(a);
    this.bindSession();

    if (typeof ResizeObserver !== "undefined") {
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(this.root);
    }
    const onVis = (): void => {
      if (document.hidden) this.sendFire(false);
    };
    document.addEventListener("visibilitychange", onVis);
    this.unsubs.push(() => document.removeEventListener("visibilitychange", onVis));

    this.raf = requestAnimationFrame(this.loop);
    await this.session.start(this.opts.initialMapId);
  }

  // ------------------------------------------------------------------------------------------ helpers

  private emit(e: GameUiEvent): void {
    try {
      this.opts.onEvent?.(e);
    } catch (err) {
      console.error("[game-client] onEvent handler threw", err);
    }
  }

  private resize(): void {
    const r = this.root.getBoundingClientRect();
    this.world.resize(r.width, r.height);
    this.overlay.resize(r.width, r.height);
  }

  private get self(): SelfJoinInfo | null {
    return this.session.self;
  }

  private get me(): EntitySnapshot | undefined {
    return this.session.connection.entities.get(this.session.localId);
  }

  private sfx(kind: SfxKind, x?: number, y?: number, vol = 1): void {
    this.audio.play(kind, x, y, vol);
  }

  // ------------------------------------------------------------------------------------------ session wiring

  private bindSession(): void {
    const s = this.session;
    const c = s.connection;
    const on = <K extends keyof ServerEvents>(type: K, cb: (p: ServerEvents[K]) => void): void => {
      this.unsubs.push(c.on(type, cb));
    };
    this.unsubs.push(
      s.events.on("status", (st) => this.onStatus(st)),
      s.events.on("mapChange", (m) => this.onMapChange(m.mapId)),
      s.events.on("transition", (t) => {
        const name = MAPS_BY_ID.get(t.mapId)?.name ?? t.mapId;
        if (t.phase === "start") {
          this.world.setWarp(true);
          this.sfx("warp");
          this.sendFire(false);
          this.emit({ type: "map_transition", phase: "start", mapId: t.mapId, mapName: name });
        } else if (t.phase === "end") {
          setTimeout(() => this.world.setWarp(false), 700);
          this.emit({ type: "map_transition", phase: "end", mapId: t.mapId, mapName: name });
        } else {
          this.world.setWarp(false);
          this.emit({ type: "map_transition", phase: "failed", mapId: t.mapId, mapName: name, error: t.error });
        }
      }),
      s.events.on("entityAdd", (e) => this.kinds.set(e.id, e.kind)),
      s.events.on("entityRemove", (id) => {
        const kind = this.kinds.get(id);
        this.world.removeEntity(id, kind === "ASTEROID");
        this.renderInputs.delete(id);
        this.kinds.delete(id);
      }),
      s.events.on("self", () => this.cooldowns.clear()),
    );

    on("player_attack", (a) => {
      this.world.attack(a.sourceId, a.fromX, a.fromY, a.toX, a.toY, a.color, a.style, a.travelMs, a.hit);
      const kind: SfxKind = a.style === "missile" || a.style === "torpedo" ? "missile" : a.style === "slug" ? "rail" : a.weaponType === "PLASMA" ? "plasma" : "laser";
      this.sfx(kind, a.fromX, a.fromY, a.sourceId === s.localId ? 0.8 : 0.6);
      if (a.sourceId === s.localId || a.targetId === s.localId) this.lastDamageAt = performance.now();
    });
    on("player_damage", (d) => {
      this.world.damage(d.targetId, d.x, d.y, d.shieldDamage, d.hullDamage, d.crit);
      const toLocal = d.targetId === s.localId, fromLocal = d.sourceId === s.localId;
      const amount = Math.round(d.shieldDamage + d.armorDamage + d.hullDamage);
      if (this.world.mapToScreen(d.x, d.y, this.tmpScreen, 1.5) && amount > 0) {
        const color = toLocal ? "#ff5a5a" : d.crit ? "#ffe066" : d.hullDamage > 0 ? "#ffb347" : "#7fd8ff";
        this.overlay.floatText(this.tmpScreen.x, this.tmpScreen.y, d.crit ? `${amount}!` : `${amount}`, color, d.crit ? 22 : toLocal ? 15 : 16);
      }
      if (toLocal || fromLocal) {
        this.lastDamageAt = performance.now();
        this.sfx(d.shieldDamage > 0 && d.hullDamage === 0 ? "shield_hit" : "hull_hit", d.x, d.y, toLocal ? 1 : 0.6);
      }
      this.emit({ type: "damage", targetId: d.targetId, amount, shield: d.shieldDamage, hull: d.hullDamage, crit: d.crit, toLocal, fromLocal, x: d.x, y: d.y });
    });
    on("player_death", (d) => {
      if (!this.world.has(d.entityId)) this.world.explosionAt(d.x, d.y, Math.max(1, d.scale / 3));
      this.sfx(d.kind === "BOSS" ? "explosion_big" : "explosion", d.x, d.y);
      if (d.entityId === s.localId) {
        this.wasDead = true;
        this.sendFire(false);
        this.world.camera.addShake(0.8);
        this.emit({ type: "death", killerName: d.killerName });
      }
    });
    on("player_respawn", (r) => {
      if (r.entityId !== s.localId) return;
      this.cameraSnapped = false;
      this.sfx("warp");
      this.emit({ type: "respawn", repairCost: r.repairCost });
    });
    on("player_level_up", (l) => {
      if (l.entityId !== s.localId) return;
      this.sfx("level_up");
      this.world.effect("HEAL", this.localPose.x, this.localPose.y, 8, l.entityId);
      this.emit({ type: "level_up", level: l.level });
    });
    on("item_drop", (d) => {
      this.world.rememberLootRarity(d.lootId, d.rarity);
      this.emit({ type: "loot_drop", lootId: d.lootId, rarity: d.rarity, label: d.label });
    });
    on("item_pickup", (p) => {
      if (p.byEntityId !== s.localId) return;
      this.sfx("pickup");
      this.world.effect("HEAL", this.localPose.x, this.localPose.y, 3, p.byEntityId);
      if (this.world.mapToScreen(this.localPose.x, this.localPose.y, this.tmpScreen, 2)) {
        const first = p.items[0];
        const label = first ? `+${first.quantity} ${first.name}` : p.credits > 0 ? `+${p.credits} CR` : "+loot";
        this.overlay.floatText(this.tmpScreen.x, this.tmpScreen.y - 20, label, "#c9a7ff", 14);
      }
      this.emit({ type: "loot_pickup", data: p });
    });
    on("quest_progress", (q) => {
      this.setQuest(q.questId, q.progress);
      this.emit({ type: "quest_progress", questId: q.questId, progress: q.progress });
    });
    on("quest_complete", (q) => {
      if (this.quest?.questId === q.questId) this.quest = null;
      this.sfx("ui_confirm");
      this.emit({ type: "quest_complete", questId: q.questId, name: q.name });
    });
    on("boss_phase", (b) => {
      this.world.setBossPhase(b.bossId, b.layer as "SHIELD" | "ARMOR" | "REACTOR" | "ENRAGE");
      this.audio.setBossLayer(true, Math.min(1, b.phase / 4));
      this.sfx("npc_alert");
      this.world.camera.addShake(0.35);
      this.emit({ type: "boss_phase", bossId: b.bossId, phase: b.phase, name: b.name, layer: b.layer });
    });
    on("event_started", (e) => this.emit({ type: "event_started", eventId: e.eventId, name: e.name, eventType: e.type, endsAt: e.endsAt }));
    on("event_finished", (e) => this.emit({ type: "event_finished", eventId: e.eventId, name: e.name, eventType: e.type, endsAt: e.endsAt }));
    on("reward", (r) => {
      this.xpGained += r.xp;
      this.creditsGained += r.credits;
      this.honorGained += r.honor;
      if (r.xp > 0 && this.world.mapToScreen(this.localPose.x, this.localPose.y, this.tmpScreen, 2)) {
        this.overlay.floatText(this.tmpScreen.x, this.tmpScreen.y - 34, `+${r.xp} XP`, "#8cffb0", 13);
      }
      this.emit({ type: "reward", data: r });
    });
    on("chat", (m) => this.emit({ type: "chat", channel: m.channel, from: m.from, fromId: m.fromId, text: m.text, at: m.at }));
    on("notice", (n) => this.emit({ type: "notice", data: n }));
    on("docked", (d) => {
      const st = this.map?.stations.find((x) => x.id === d.stationId);
      this.sendFire(false);
      this.sfx("ui_confirm");
      this.emit({ type: "docked", stationId: d.stationId, stationName: st?.name ?? d.stationId, services: d.services });
    });
    on("effect", (e) => {
      this.world.effect(e.kind, e.x, e.y, e.radius, e.sourceId);
      if (e.kind === "EMP") this.sfx("emp", e.x, e.y);
      else if (e.kind === "WARP") this.sfx("warp", e.x, e.y, 0.6);
      else if (e.kind === "DASH") this.sfx("dash", e.x, e.y, 0.7);
      else if (e.kind === "BARRAGE") this.sfx("explosion", e.x, e.y, 0.8);
    });
    on("wave", (w) => {
      this.sfx("npc_alert");
      this.emit({ type: "wave", wave: w.wave, total: w.total, name: w.name });
    });
    on("match_start", (m) => this.emit({ type: "match_start", matchId: m.matchId, mode: m.mode }));
    on("match_end", (m) => this.emit({ type: "match_end", data: m }));
    on("kill_feed", (k) => this.emit({ type: "kill_feed", data: k }));
    on("marker", (m) => this.emit({ type: "marker", x: m.x, y: m.y, kind: m.kind, fromName: m.fromName }));
    on("error", (e) => {
      this.sfx("error");
      if (e.code === "COOLDOWN" || e.code === "SKILL_COOLDOWN") {
        // server rejected — keep the estimate but it will expire naturally
      }
      this.emit({ type: "error", code: e.code, message: e.message });
    });
  }

  private onStatus(st: ConnectionStatus): void {
    this.emit({ type: "connection", status: st });
    if (st !== "connected") this.sendFire(false);
  }

  private onMapChange(mapId: string): void {
    const map = MAPS_BY_ID.get(mapId);
    if (!map) return;
    this.map = map;
    this.world.localId = this.session.localId;
    this.world.setMap(map);
    this.overlay.model.map = map;
    this.renderInputs.clear();
    this.kinds.clear();
    this.cameraSnapped = false;
    this.moveTo = null;
    this.firing = false;
    this.secondary = false;
    this.audio.startAmbient(hashString(map.id));
    this.audio.setBossLayer(map.roomType === "boss", 0.3);
    this.relCtx.pvp = map.pvp;
    this.emit({ type: "map_transition", phase: "loading", mapId, mapName: map.name });
  }

  private setQuest(questId: string, progress: number[]): void {
    const q = QUESTS_BY_ID.get(questId);
    if (!q) return;
    const idx = q.objectives.findIndex((o, i) => (progress[i] ?? 0) < o.count);
    const o = q.objectives[idx < 0 ? 0 : idx];
    if (!o) return;
    const targetName = o.target ? (NPCS_BY_ID.get(o.target)?.name ?? ITEMS_BY_ID.get(o.target)?.name ?? MAPS_BY_ID.get(o.target)?.name ?? o.target) : "";
    const verb = o.type.replace(/_/g, " ").toLowerCase();
    const text = `${verb.charAt(0).toUpperCase()}${verb.slice(1)}${targetName ? ` ${targetName}` : ""} ${Math.min(o.count, progress[idx < 0 ? 0 : idx] ?? 0)}/${o.count}`;
    this.quest = { questId, name: q.name, text, progress };
  }

  // ------------------------------------------------------------------------------------------ input actions

  private sendFire(on: boolean): void {
    if (this.firing !== on) {
      this.firing = on;
      this.session.connection.send("fire", { firing: on, group: "PRIMARY" });
    }
  }

  private sendSecondary(on: boolean): void {
    if (this.secondary !== on) {
      this.secondary = on;
      this.session.connection.send("fire", { firing: on, group: "SECONDARY" });
    }
  }

  /** Entity nearest to a screen point (for click-targeting). */
  private pickAt(sx: number, sy: number): EntitySnapshot | null {
    let best: EntitySnapshot | null = null;
    let bestD = PICK_RADIUS_PX * PICK_RADIUS_PX;
    for (const e of this.session.connection.entities.values()) {
      if (e.id === this.session.localId || e.dead) continue;
      if (e.kind !== "PLAYER" && e.kind !== "NPC" && e.kind !== "BOSS" && e.kind !== "ASTEROID" && e.kind !== "LOOT") continue;
      const p = this.renderInputs.get(e.id);
      if (!p || !this.world.mapToScreen(p.x, p.y, this.tmpScreen)) continue;
      const scale = e.kind === "BOSS" ? 6 : 1;
      const d = ((this.tmpScreen.x - sx) ** 2 + (this.tmpScreen.y - sy) ** 2) / scale;
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  private nearest(kind: EntitySnapshot["kind"], range: number, filter?: (e: EntitySnapshot) => boolean): EntitySnapshot | null {
    let best: EntitySnapshot | null = null;
    let bestD = range * range;
    for (const e of this.session.connection.entities.values()) {
      if (e.kind !== kind || e.dead || (filter && !filter(e))) continue;
      const d = (e.x - this.localPose.x) ** 2 + (e.y - this.localPose.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  private onAction(a: InputAction): void {
    const c = this.session.connection;
    switch (a.type) {
      case "fire": this.sendFire(a.on); break;
      case "secondary": this.sendSecondary(a.on); break;
      case "toggleSecondary": this.sendSecondary(!this.secondary); break;
      case "selectAt": {
        const e = this.pickAt(a.sx, a.sy);
        if (e && (e.kind === "PLAYER" || e.kind === "NPC" || e.kind === "BOSS")) {
          this.targetEntity(e.id);
          if (a.button === 2) this.sendSecondary(true);
        } else if (e && e.kind === "LOOT") {
          c.send("pickup", { lootId: e.id });
          if (a.button === 0) this.sendFire(false);
        } else if (e && e.kind === "ASTEROID" && a.button === 2) {
          c.send("mine", { asteroidId: e.id });
        } else if (a.button === 2 && this.world.screenToMap(a.sx, a.sy, this.tmpMap)) {
          this.moveTo = { x: this.tmpMap.x, y: this.tmpMap.y };
          this.sendSecondary(false);
        }
        break;
      }
      case "moveTo":
        if (this.world.screenToMap(a.sx, a.sy, this.tmpMap)) this.moveTo = { x: this.tmpMap.x, y: this.tmpMap.y };
        break;
      case "ability": this.useAbility(a.slot); break;
      case "dash": this.dash(); break;
      case "targetNearest": this.target("NEAREST_ENEMY"); break;
      case "targetCycle": this.cycleTarget(); break;
      case "clearTarget": this.target("CLEAR"); break;
      case "interact": this.interact(); break;
      case "pickup": this.pickup(); break;
      case "mine": this.mine(); break;
      case "respawn": this.respawn(); break;
      case "zoom": this.world.camera.zoomBy(a.delta); break;
    }
  }

  private targetEntity(id: string): void {
    this.session.connection.send("target", { mode: "ENTITY", entityId: id, lock: "HARD" });
    this.sfx("ui");
  }

  target(mode: TargetMode): void {
    if (typeof mode === "object") {
      this.session.connection.send("target", { mode: "ENTITY", entityId: mode.entityId, lock: mode.lock ?? "HARD" });
    } else {
      this.session.connection.send("target", { mode });
      if (mode === "CLEAR") {
        this.sendFire(false);
        this.sendSecondary(false);
      }
    }
    this.sfx("ui");
  }

  private cycleTarget(): void {
    const me = this.me;
    const list: { id: string; d: number }[] = [];
    for (const e of this.session.connection.entities.values()) {
      if (e.dead || e.id === this.session.localId) continue;
      if (relationOf(e, this.relCtx) !== "hostile" && e.kind !== "NPC" && e.kind !== "BOSS") continue;
      list.push({ id: e.id, d: (e.x - this.localPose.x) ** 2 + (e.y - this.localPose.y) ** 2 });
    }
    if (list.length === 0) return;
    list.sort((a, b) => a.d - b.d);
    const cur = list.findIndex((x) => x.id === me?.targetId);
    const next = list[(cur + 1) % list.length];
    if (next) this.targetEntity(next.id);
  }

  useAbility(slot: number): void {
    const self = this.self;
    if (!self || slot < 0) return;
    const nSkills = self.skills.length;
    const def = slot < nSkills ? self.skills[slot] : self.modules[slot - nSkills];
    if (!def) return;
    const now = performance.now();
    const cd = this.cooldowns.get(slot);
    if (cd && now - cd.at < cd.ms) {
      this.sfx("error");
      return;
    }
    if (slot < nSkills) this.session.connection.send("skill", { slot: def.slot });
    else this.session.connection.send("module", { slot: def.slot });
    this.cooldowns.set(slot, { at: now, ms: def.cooldownMs });
    this.sfx("ui_confirm");
  }

  dash(): void {
    const i = this.input.readIntent(this.intent);
    let dx = i.mx, dy = i.my;
    if (Math.hypot(dx, dy) < 0.1) {
      dx = Math.cos(this.localPose.heading);
      dy = Math.sin(this.localPose.heading);
    }
    const l = Math.hypot(dx, dy) || 1;
    this.session.connection.send("dash", { dirX: dx / l, dirY: dy / l });
    this.sfx("dash");
  }

  private interact(): void {
    if (this.me && (this.me.flags & EntityFlag.DOCKED) !== 0) {
      this.session.connection.send("undock", {});
      return;
    }
    const station = this.nearestStation();
    const portal = this.nearestPortal();
    if (station && (!portal || station.d < portal.d)) this.dockAt(station.id);
    else if (portal) this.jumpVia(portal.id);
  }

  dock(): void {
    if (this.me && (this.me.flags & EntityFlag.DOCKED) !== 0) {
      this.session.connection.send("undock", {});
      return;
    }
    const st = this.nearestStation();
    if (st) this.dockAt(st.id);
    else this.emit({ type: "error", code: "NO_STATION", message: "No station in range" });
  }

  private dockAt(stationId: string): void {
    this.session.connection.send("dock", { stationId });
  }

  jump(): void {
    const p = this.nearestPortal();
    if (p) this.jumpVia(p.id);
    else this.emit({ type: "error", code: "NO_PORTAL", message: "No portal in range" });
  }

  private jumpVia(portalId: string): void {
    this.sendFire(false);
    this.session.requestJump(portalId);
  }

  private nearestStation(): { id: string; d: number } | null {
    let best: { id: string; d: number } | null = null;
    for (const s of this.map?.stations ?? []) {
      const d = Math.hypot(s.x - this.localPose.x, s.y - this.localPose.y);
      if (d <= STATION_PROMPT_RANGE && (!best || d < best.d)) best = { id: s.id, d };
    }
    return best;
  }

  private nearestPortal(): { id: string; d: number } | null {
    let best: { id: string; d: number } | null = null;
    for (const p of this.map?.portals ?? []) {
      const d = Math.hypot(p.x - this.localPose.x, p.y - this.localPose.y);
      if (d <= PORTAL_PROMPT_RANGE && (!best || d < best.d)) best = { id: p.id, d };
    }
    for (const e of this.session.connection.entities.values()) {
      if (e.kind !== "PORTAL") continue;
      const d = Math.hypot(e.x - this.localPose.x, e.y - this.localPose.y);
      if (d <= PORTAL_PROMPT_RANGE && (!best || d < best.d)) best = { id: e.id, d };
    }
    return best;
  }

  pickup(): void {
    const l = this.nearest("LOOT", LOOT_RANGE);
    if (l) this.session.connection.send("pickup", { lootId: l.id });
  }

  mine(): void {
    const me = this.me;
    if (me && (me.flags & EntityFlag.MINING) !== 0) {
      this.session.connection.send("mine", { asteroidId: null });
      return;
    }
    const a = this.nearest("ASTEROID", MINE_RANGE);
    if (a) this.session.connection.send("mine", { asteroidId: a.id });
    else this.emit({ type: "error", code: "NO_ASTEROID", message: "No asteroid in range" });
  }

  respawn(): void {
    if (this.me?.dead) this.session.connection.send("respawn", {});
  }

  toggleFire(on: boolean): void {
    this.sendFire(on);
  }

  toggleSecondary(on: boolean): void {
    this.sendSecondary(on);
  }

  setJoystick(x: number, y: number): void {
    this.input.setJoystick(x, y);
    if (Math.hypot(x, y) > 0.1) this.moveTo = null;
  }

  setAim(angle: number | null): void {
    this.input.setAim(angle);
  }

  setBoost(on: boolean): void {
    this.input.setBoost(on);
  }

  zoom(delta: number): void {
    this.world.camera.zoomBy(delta);
  }

  setGraphics(t: GraphicsTier | "AUTO"): void {
    this.tier = resolveTier(t);
    this.world.setTier(this.tier);
    this.emit({ type: "graphics", tier: this.tier, backend: this.world.backend.kind });
  }

  setPaused(p: boolean): void {
    if (this.paused === p || this.disposed) return;
    this.paused = p;
    this.audio.setSuspended(p);
    this.overlay.setPaused(p);
    this.input.enabled = !p;
    if (p) {
      this.sendFire(false);
      this.sendSecondary(false);
      cancelAnimationFrame(this.raf);
    } else {
      this.lastFrame = -1;
      this.raf = requestAnimationFrame(this.loop);
    }
  }

  setVolume(v: Partial<AudioVolumes>): void {
    this.audio.setVolumes(v);
  }

  send<K extends keyof ClientMessages>(type: K, payload: ClientMessages[K]): void {
    this.session.connection.send(type, payload);
  }

  getHud(): HudState {
    return this.hud;
  }

  // ------------------------------------------------------------------------------------------ frame loop

  private readonly readMove = (): MoveInput => {
    const intent = this.input.readIntent(this.intent);
    const heading = this.session.predictor?.state.heading ?? this.localPose.heading;
    intentToMoveInput(intent, heading, this.moveInput);
    if (Math.hypot(intent.mx, intent.my) > 0.1) this.moveTo = null;
    if (this.moveTo) {
      const d = Math.hypot(this.moveTo.x - this.localPose.x, this.moveTo.y - this.localPose.y);
      if (d < DEFAULT_TUNING.arriveRadius * 1.5) this.moveTo = null;
      else this.moveInput.moveTo = this.moveTo;
    }
    return this.moveInput;
  };

  private readonly loop = (now: number): void => {
    if (this.disposed || this.paused) return;
    this.raf = requestAnimationFrame(this.loop);
    try {
      this.frame(now);
    } catch (err) {
      console.error("[game-client] frame error", err);
    }
  };

  private frame(now: number): void {
    const dt = this.lastFrame < 0 ? 1 / 60 : Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.input.pollGamepad();
    // 1) frame driver owns input: send + predict BEFORE reading poses
    this.session.advance(now, this.readMove);
    // aim point for server-side targeting helpers (throttled)
    if (!this.input.touchMode && now - this.lastAimSent > 120) {
      const m = this.input.mouse;
      if (m.active && this.world.screenToMap(m.x, m.y, this.tmpMap)) {
        this.session.connection.send("aim", { x: this.tmpMap.x, y: this.tmpMap.y });
        this.lastAimSent = now;
      }
    }
    // 2) poses → renderer
    const localId = this.session.localId;
    this.relCtx.selfId = localId;
    const me = this.me;
    if (me) {
      this.relCtx.faction = me.faction;
      this.relCtx.clanTag = me.clanTag;
    }
    this.hasLocalPose = false;
    for (const e of this.session.connection.entities.values()) {
      let r = this.renderInputs.get(e.id);
      if (!r) {
        r = {
          id: e.id, kind: e.kind, defId: e.defId ?? "", cosmetics: e.cosmetics ?? "", x: num(e.x), y: num(e.y), heading: num(e.heading),
          vx: num(e.vx), vy: num(e.vy), hull: num(e.hull), maxHull: num(e.maxHull), shield: num(e.shield), maxShield: num(e.maxShield),
          flags: num(e.flags), cloaked: !!e.cloaked, dead: !!e.dead, targetId: e.targetId ?? "",
        };
        this.renderInputs.set(e.id, r);
        this.kinds.set(e.id, e.kind);
      }
      const isLocal = e.id === localId;
      const ok = isLocal ? this.session.localPose(dt, this.pose) : this.session.remotePose(e.id, now, this.pose);
      if (ok) {
        r.x = this.pose.x; r.y = this.pose.y; r.heading = this.pose.heading; r.vx = this.pose.vx; r.vy = this.pose.vy;
      } else {
        r.x = num(e.x); r.y = num(e.y); r.heading = num(e.heading); r.vx = num(e.vx); r.vy = num(e.vy);
      }
      r.hull = num(e.hull); r.maxHull = num(e.maxHull); r.shield = num(e.shield); r.maxShield = num(e.maxShield); r.flags = num(e.flags);
      r.cloaked = !!e.cloaked; r.dead = !!e.dead; r.targetId = e.targetId ?? ""; r.cosmetics = e.cosmetics ?? "";
      if (isLocal) {
        this.localPose.x = r.x; this.localPose.y = r.y; this.localPose.heading = r.heading; this.localPose.vx = r.vx; this.localPose.vy = r.vy;
        this.hasLocalPose = true;
        if (this.moveInput.boost && this.session.predictor?.boosting) r.flags |= EntityFlag.BOOSTING;
      }
      this.world.syncEntity(r, dt);
    }

    // 3) camera
    const cam = this.world.camera;
    if (this.hasLocalPose) {
      cam.follow(this.localPose.x, this.localPose.y, this.localPose.vx, this.localPose.vy);
      if (!this.cameraSnapped) {
        cam.snap();
        this.cameraSnapped = true;
      }
      const target = me?.targetId ? this.renderInputs.get(me.targetId) : undefined;
      const inCombat = now - this.lastDamageAt < 4000 || this.firing;
      cam.setCombat(inCombat);
      cam.setTarget(target && inCombat && !target.dead ? target.x : null, target?.y ?? 0);
      const bossId = this.session.connection.state?.bossId;
      const boss = bossId ? this.renderInputs.get(bossId) : undefined;
      if (boss && !boss.dead && Math.hypot(boss.x - this.localPose.x, boss.y - this.localPose.y) < 160) cam.setBoss(boss.x, boss.y, 25);
      else cam.setBoss(null);
    }
    this.lastFps = this.world.frame(now).fps;

    // 4) overlay, audio, hud
    this.updateOverlay(me);
    const speed = Math.hypot(this.localPose.vx, this.localPose.vy);
    const maxSpeed = this.self?.motion.speed ?? 30;
    this.audio.setListener(cam.focusPoint.x, cam.focusPoint.z, cam.currentDistance * 1.6);
    this.audio.setEngine(me && !me.dead ? speed / maxSpeed : 0, this.moveInput.boost && !!this.session.predictor?.boosting);
    this.audio.setMining(!!me && (me.flags & EntityFlag.MINING) !== 0);
    this.trackLocalState(me);
    if (now - this.lastHud >= HUD_INTERVAL_MS) {
      this.lastHud = now;
      this.hud = this.buildHud(me, now);
      try {
        this.opts.onHud?.(this.hud);
      } catch (err) {
        console.error("[game-client] onHud handler threw", err);
      }
    }
  }

  private trackLocalState(me: EntitySnapshot | undefined): void {
    if (!me) return;
    const docked = (me.flags & EntityFlag.DOCKED) !== 0;
    if (this.wasDocked && !docked) this.emit({ type: "undocked" });
    this.wasDocked = docked;
    if (this.wasDead && !me.dead) this.wasDead = false;
    if (!this.wasDead && me.dead) {
      this.wasDead = true;
      this.sendFire(false);
    }
  }

  private updateOverlay(me: EntitySnapshot | undefined): void {
    const m = this.overlay.model;
    m.selfX = this.localPose.x;
    m.selfY = this.localPose.y;
    m.selfHeading = this.localPose.heading;
    const vp = this.world.viewport;
    // camera footprint (map coords) from screen corners
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let c = 0; c < 4; c++) {
      const sx = c % 2 === 0 ? 0 : vp.width, sy = c < 2 ? 0 : vp.height;
      if (this.world.screenToMap(sx, sy, this.tmpMap)) {
        minX = Math.min(minX, this.tmpMap.x); maxX = Math.max(maxX, this.tmpMap.x);
        minY = Math.min(minY, this.tmpMap.y); maxY = Math.max(maxY, this.tmpMap.y);
      }
    }
    if (Number.isFinite(minX)) {
      m.viewX = minX; m.viewY = minY; m.viewW = maxX - minX; m.viewH = maxY - minY;
    }
    let ri = 0, pi = 0;
    const upp = this.world.unitsPerPixel;
    for (const e of this.session.connection.entities.values()) {
      const r = this.renderInputs.get(e.id);
      if (!r || e.dead || e.kind === "PROJECTILE") continue;
      const rel = relationOf(e, this.relCtx);
      if (rel === null) continue; // hidden (cloaked & unscanned)
      if (e.id !== this.session.localId) {
        const slot = m.radarSlot(ri++);
        slot.id = e.id; slot.x = r.x; slot.y = r.y; slot.rel = rel; slot.heading = r.heading;
      }
      if ((e.kind === "PLAYER" || e.kind === "NPC" || e.kind === "BOSS") && (e.flags & EntityFlag.DOCKED) === 0) {
        const size = e.kind === "BOSS" ? 22 : e.kind === "PLAYER" ? 3.2 : 2.6;
        if (this.world.mapToScreen(r.x, r.y - size, this.tmpScreen, 0.5)) {
          const p = m.plateSlot(pi++);
          p.id = e.id; p.sx = this.tmpScreen.x; p.sy = this.tmpScreen.y;
          p.name = e.clanTag ? `[${e.clanTag}] ${e.name}` : e.name;
          p.level = e.level;
          p.hull = e.maxHull > 0 ? e.hull / e.maxHull : 0;
          p.shield = e.maxShield > 0 ? e.shield / e.maxShield : 0;
          p.rel = e.id === this.session.localId ? "self" : rel;
          p.visible = true;
        }
      }
    }
    m.radarCount = ri;
    m.plateCount = pi;
    // reticle + lead indicator
    const ret = m.reticle;
    ret.active = false;
    const tid = me?.targetId;
    const t = tid ? this.renderInputs.get(tid) : undefined;
    const te = tid ? this.session.connection.entities.get(tid) : undefined;
    if (t && te && !t.dead && this.world.mapToScreen(t.x, t.y, this.tmpScreen, 0.5)) {
      ret.active = true;
      ret.sx = this.tmpScreen.x;
      ret.sy = this.tmpScreen.y;
      const radiusWorld = te.kind === "BOSS" ? 18 : te.kind === "PLAYER" ? 3 : 2.5;
      ret.radius = radiusWorld / Math.max(0.01, upp);
      ret.hostile = relationOf(te, this.relCtx) !== "squad" && relationOf(te, this.relCtx) !== "clan" && relationOf(te, this.relCtx) !== "faction";
      const w = this.self?.weapons.find((x) => x.group === "PRIMARY");
      const dist = Math.hypot(t.x - this.localPose.x, t.y - this.localPose.y);
      ret.inRange = !!w && dist <= w.range;
      const speed = w ? (WEAPONS_BY_ID.get(w.defId)?.projectileSpeed ?? 0) : 0;
      ret.lead = false;
      if (speed > 0 && Math.hypot(t.vx, t.vy) > 1) {
        let time = dist / speed;
        for (let k = 0; k < 2; k++) time = Math.hypot(t.x + t.vx * time - this.localPose.x, t.y + t.vy * time - this.localPose.y) / speed;
        if (this.world.mapToScreen(t.x + t.vx * time, t.y + t.vy * time, this.tmpScreen, 0.5)) {
          ret.lead = true;
          ret.leadX = this.tmpScreen.x;
          ret.leadY = this.tmpScreen.y;
        }
      }
    }
  }

  // ------------------------------------------------------------------------------------------ HUD

  private emptyHud(): HudState {
    return {
      status: "idle", connected: false, mapId: this.opts.initialMapId, mapName: MAPS_BY_ID.get(this.opts.initialMapId)?.name ?? "",
      zone: "NEUTRAL", pvp: false, hull: 0, maxHull: 0, shield: 0, maxShield: 0, energy: 0, maxEnergy: 0, speed: 0, maxSpeed: 0,
      boosting: false, level: 0, xpGained: 0, creditsGained: 0, honorGained: 0, target: null, cooldowns: [], ammo: [],
      firing: { primary: false, secondary: false }, mining: false, docked: false, dead: false, stunned: false, cloaked: false,
      prompts: [], questObjective: null, squad: [], boss: null, event: null, match: null, ping: 0, fps: 0, graphics: this.tier,
      minimap: { width: 0, height: 0, x: 0, y: 0, heading: 0, entities: [] },
    };
  }

  private buildHud(me: EntitySnapshot | undefined, now: number): HudState {
    const conn = this.session.connection;
    const map = this.map;
    const self = this.self;
    const state = conn.state;
    const zone: ZoneType = map ? computeZone(map, this.localPose.x, this.localPose.y) : "NEUTRAL";
    this.relCtx.pvp = !!map && (map.pvp || zone === "PVP" || zone === "HIGH_RISK" || zone === "PIRATE");

    let target: HudState["target"] = null;
    const te = me?.targetId ? conn.entities.get(me.targetId) : undefined;
    if (te) {
      const tr = this.renderInputs.get(te.id);
      const dist = Math.hypot((tr?.x ?? te.x) - this.localPose.x, (tr?.y ?? te.y) - this.localPose.y);
      const primary = self?.weapons.find((w) => w.group === "PRIMARY");
      const rel = relationOf(te, this.relCtx);
      target = {
        id: te.id, name: te.name, kind: te.kind, level: te.level, hull: te.hull, maxHull: te.maxHull, shield: te.shield,
        maxShield: te.maxShield, distance: Math.round(dist), faction: te.faction, clanTag: te.clanTag,
        hostile: rel === "hostile" || rel === "npc" || rel === "boss", inRange: !!primary && dist <= primary.range,
      };
    }

    const cooldowns: HudCooldown[] = [];
    if (self) {
      const all = [...self.skills.map((s) => ({ ...s, kind: "SKILL" as const })), ...self.modules.map((m) => ({ ...m, kind: "MODULE" as const }))];
      all.forEach((a, i) => {
        const cd = this.cooldowns.get(i);
        cooldowns.push({
          slot: i, kind: a.kind, id: a.id, name: a.name, cooldownMs: a.cooldownMs,
          remainingMs: cd ? Math.max(0, cd.ms - (now - cd.at)) : 0, energyCost: a.energyCost, hotkey: i < 9 ? String(i + 1) : "",
        });
      });
    }
    const ammo: HudState["ammo"] = (self?.weapons ?? []).filter((w) => WEAPONS_BY_ID.get(w.defId)?.ammo).map((w) => ({
      weaponId: w.defId, name: WEAPONS_BY_ID.get(w.defId)?.name ?? w.defId, group: w.group, count: null,
    }));

    const prompts: HudPrompt[] = [];
    if (me?.dead) prompts.push({ kind: "RESPAWN", id: "respawn", label: "Respawn", distance: 0, key: "R", enabled: true });
    const docked = !!me && (me.flags & EntityFlag.DOCKED) !== 0;
    if (me && !me.dead) {
      const st = this.nearestStation();
      if (st || docked) {
        const def = map?.stations.find((x) => x.id === st?.id);
        prompts.push({ kind: "STATION", id: st?.id ?? "", label: docked ? "Undock" : `Dock at ${def?.name ?? "station"}`, distance: Math.round(st?.d ?? 0), key: "E", enabled: true });
      }
      const pt = this.nearestPortal();
      if (pt && !docked) {
        const pd = map?.portals.find((x) => x.id === pt.id);
        const targetMap = pd ? MAPS_BY_ID.get(pd.targetMap) : undefined;
        const lvlOk = !pd || me.level >= pd.requiredLevel;
        const combat = now - this.lastDamageAt < 5000;
        prompts.push({
          kind: "PORTAL", id: pt.id, label: `Jump to ${targetMap?.name ?? "portal"}`, distance: Math.round(pt.d), key: "E",
          enabled: lvlOk && !combat, reason: !lvlOk ? `Requires level ${pd?.requiredLevel}` : combat ? "Jump drive locked in combat" : undefined,
        });
      }
      const loot = this.nearest("LOOT", LOOT_RANGE);
      if (loot) prompts.push({ kind: "LOOT", id: loot.id, label: "Collect cargo", distance: Math.round(Math.hypot(loot.x - this.localPose.x, loot.y - this.localPose.y)), key: "F", enabled: true });
      const ast = (me.flags & EntityFlag.MINING) === 0 ? this.nearest("ASTEROID", MINE_RANGE) : null;
      if (ast) prompts.push({ kind: "ASTEROID", id: ast.id, label: `Mine ${ast.defId.replace(/_/g, " ").toLowerCase()}`, distance: Math.round(Math.hypot(ast.x - this.localPose.x, ast.y - this.localPose.y)), key: "M", enabled: true });
    }

    const squad: HudState["squad"] = [];
    const minimapEntities: MinimapEntity[] = [];
    for (const e of conn.entities.values()) {
      if (e.id === this.session.localId || e.kind === "PROJECTILE") continue;
      const rel = relationOf(e, this.relCtx);
      if (rel === null) continue;
      if (e.kind === "PLAYER" && rel === "squad") {
        squad.push({ id: e.id, name: e.name, hullPct: e.maxHull > 0 ? e.hull / e.maxHull : 0, shieldPct: e.maxShield > 0 ? e.shield / e.maxShield : 0 });
      }
      const r = this.renderInputs.get(e.id);
      minimapEntities.push({ id: e.id, x: r?.x ?? e.x, y: r?.y ?? e.y, rel, heading: r?.heading ?? e.heading });
    }

    const maxSpeed = (self?.motion.speed ?? 0) * DEFAULT_TUNING.boostMultiplier;
    const boss = state && state.bossId ? { id: state.bossId, name: state.bossName, hullPct: state.bossHullPct, phase: state.bossPhase } : null;
    const event = state && state.eventId ? { id: state.eventId, name: state.eventName, endsAt: state.eventEndsAt } : null;
    const mi = state?.match;
    const match = mi && mi.matchId ? {
      mode: mi.mode, phase: mi.phase, wave: mi.wave, totalWaves: mi.totalWaves, endsAt: mi.endsAt,
      scores: mi.teamScores ? Array.from(mi.teamScores) : [],
    } : null;

    return {
      status: conn.status,
      connected: conn.connected,
      mapId: map?.id ?? this.session.mapId,
      mapName: map?.name ?? "",
      zone,
      pvp: this.relCtx.pvp,
      hull: me?.hull ?? 0, maxHull: me?.maxHull ?? 0,
      shield: me?.shield ?? 0, maxShield: me?.maxShield ?? 0,
      energy: this.session.predictor?.state.energy ?? me?.energy ?? 0, maxEnergy: me?.maxEnergy ?? 0,
      speed: Math.round(Math.hypot(this.localPose.vx, this.localPose.vy) * 10) / 10,
      maxSpeed,
      boosting: !!this.session.predictor?.boosting && this.moveInput.boost,
      level: me?.level ?? 0,
      xpGained: this.xpGained, creditsGained: this.creditsGained, honorGained: this.honorGained,
      target, cooldowns, ammo,
      firing: { primary: this.firing, secondary: this.secondary },
      mining: !!me && (me.flags & EntityFlag.MINING) !== 0,
      docked,
      dead: !!me?.dead,
      stunned: !!me && (me.flags & EntityFlag.STUNNED) !== 0,
      cloaked: !!me?.cloaked,
      prompts,
      questObjective: this.quest,
      squad,
      boss,
      event,
      match,
      ping: this.session.ping.ping,
      fps: Math.round(this.lastFps),
      graphics: this.tier,
      minimap: { width: map?.width ?? 0, height: map?.height ?? 0, x: this.localPose.x, y: this.localPose.y, heading: this.localPose.heading, entities: minimapEntities },
    };
  }

  // ------------------------------------------------------------------------------------------ lifecycle

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    try {
      this.sendFire(false);
    } catch {
      // connection may already be closed
    }
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.ro?.disconnect();
    this.input.dispose();
    this.session.dispose();
    this.audio.dispose();
    this.overlay?.destroy();
    this.world?.dispose();
    this.renderInputs.clear();
    this.root.remove();
  }

  /** Public handle (bound methods). */
  handle(): GameHandle {
    return {
      dispose: () => this.dispose(),
      send: (type, payload) => this.send(type, payload),
      setGraphics: (t) => this.setGraphics(t),
      setPaused: (p) => this.setPaused(p),
      zoom: (d) => this.zoom(d),
      target: (m) => this.target(m),
      useAbility: (s) => this.useAbility(s),
      toggleFire: (on) => this.toggleFire(on),
      toggleSecondary: (on) => this.toggleSecondary(on),
      dash: () => this.dash(),
      setJoystick: (x, y) => this.setJoystick(x, y),
      setAim: (a) => this.setAim(a),
      setBoost: (on) => this.setBoost(on),
      dock: () => this.dock(),
      jump: () => this.jump(),
      pickup: () => this.pickup(),
      mine: () => this.mine(),
      respawn: () => this.respawn(),
      setVolume: (v) => this.setVolume(v),
      getHud: () => this.getHud(),
    };
  }
}
