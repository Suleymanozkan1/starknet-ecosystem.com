import type {
  ClientMessages, EntityKind, GraphicsTier, ItemPickupEvent, KillFeedEvent, MatchEndEvent, NoticeEvent, Rarity,
  RewardEvent, TargetMsg, ZoneType,
} from "@nebula/shared";
import type { ConnectionStatus } from "@nebula/game-network";

export type { GraphicsTier };

export interface GameClientOptions {
  /** Element the game mounts into (it fills it; give it a size). */
  container: HTMLElement;
  /** Colyseus endpoint, e.g. ws://localhost:2567. */
  serverUrl: string;
  /** Fetch a fresh game ticket (web app → POST /api/game/ticket with credentials). */
  getTicket: (mapId: string) => Promise<{ ticket: string; mapId: string }>;
  initialMapId: string;
  graphics?: GraphicsTier | "AUTO";
  /** Touch UI mode: disables mouse aim/keyboard hints; the web app drives setJoystick/setAim/etc. */
  isMobile?: boolean;
  onEvent?: (e: GameUiEvent) => void;
  onHud?: (hud: HudState) => void;
  /** Renderer backend preference (WebGL is the stable default). */
  renderer?: "webgl" | "webgpu" | "auto";
  /** Initial audio volumes 0..1. */
  volume?: Partial<AudioVolumes>;
}

export interface AudioVolumes {
  master: number;
  sfx: number;
  music: number;
  ambient: number;
}

export type TargetMode = TargetMsg["mode"] | { entityId: string; lock?: "SOFT" | "HARD" };

export interface GameHandle {
  dispose(): void;
  /** Typed raw intent send (e.g. chat, formation, marker). */
  send<K extends keyof ClientMessages>(type: K, payload: ClientMessages[K]): void;
  setGraphics(t: GraphicsTier | "AUTO"): void;
  setPaused(p: boolean): void;
  /** Positive = zoom out, negative = zoom in (fraction, e.g. 0.1). */
  zoom(delta: number): void;
  target(mode: TargetMode): void;
  /** 0-based ability slot: ship skills first, then active modules (matches HudState.cooldowns). */
  useAbility(slot: number): void;
  toggleFire(on: boolean): void;
  /** Secondary weapon group (missiles). */
  toggleSecondary(on: boolean): void;
  dash(): void;
  /** Virtual joystick in screen space: x right, y down, magnitude 0..1. (0,0) releases. */
  setJoystick(x: number, y: number): void;
  /** Aim angle in screen/map space (radians, 0 = right, clockwise) or null to face movement. */
  setAim(angle: number | null): void;
  setBoost(on: boolean): void;
  /** Dock at the nearby station, or undock when docked. */
  dock(): void;
  /** Jump through the nearby portal. */
  jump(): void;
  pickup(): void;
  mine(): void;
  respawn(): void;
  setVolume(v: Partial<AudioVolumes>): void;
  /** Current HUD snapshot (same object passed to onHud). */
  getHud(): HudState;
}

export interface HudCooldown {
  slot: number;
  kind: "SKILL" | "MODULE";
  id: string;
  name: string;
  cooldownMs: number;
  /** Client-side estimate from the last activation (server remains authoritative). */
  remainingMs: number;
  energyCost: number;
  hotkey: string;
}

export interface HudTarget {
  id: string;
  name: string;
  kind: EntityKind;
  level: number;
  hull: number;
  maxHull: number;
  shield: number;
  maxShield: number;
  distance: number;
  faction: string;
  clanTag: string;
  hostile: boolean;
  inRange: boolean;
}

export type MinimapRelation =
  | "self" | "squad" | "clan" | "faction" | "hostile" | "neutral" | "npc" | "boss" | "resource" | "loot" | "portal"
  | "station" | "objective" | "event" | "marker";

export interface MinimapEntity {
  id: string;
  x: number;
  y: number;
  rel: MinimapRelation;
  heading?: number;
}

export interface HudPrompt {
  kind: "PORTAL" | "STATION" | "LOOT" | "ASTEROID" | "RESPAWN";
  id: string;
  label: string;
  distance: number;
  /** Keyboard hint (desktop). */
  key: string;
  enabled: boolean;
  reason?: string;
}

export interface HudState {
  status: ConnectionStatus;
  connected: boolean;
  mapId: string;
  mapName: string;
  zone: ZoneType;
  pvp: boolean;
  hull: number;
  maxHull: number;
  shield: number;
  maxShield: number;
  energy: number;
  maxEnergy: number;
  speed: number;
  maxSpeed: number;
  boosting: boolean;
  level: number;
  /** XP gained this session (server rewards); total XP lives in the profile API. */
  xpGained: number;
  creditsGained: number;
  honorGained: number;
  target: HudTarget | null;
  cooldowns: HudCooldown[];
  /** Ammo counts are server/profile data; null when the room does not stream them. */
  ammo: { weaponId: string; name: string; group: "PRIMARY" | "SECONDARY"; count: number | null }[];
  firing: { primary: boolean; secondary: boolean };
  mining: boolean;
  docked: boolean;
  dead: boolean;
  stunned: boolean;
  cloaked: boolean;
  prompts: HudPrompt[];
  questObjective: { questId: string; name: string; text: string; progress: number[] } | null;
  squad: { id: string; name: string; hullPct: number; shieldPct: number }[];
  boss: { id: string; name: string; hullPct: number; phase: number } | null;
  event: { id: string; name: string; endsAt: number } | null;
  match: { mode: string; phase: string; wave: number; totalWaves: number; endsAt: number; scores: number[] } | null;
  ping: number;
  fps: number;
  graphics: GraphicsTier;
  minimap: { width: number; height: number; x: number; y: number; heading: number; entities: MinimapEntity[] };
}

export type GameUiEvent =
  | { type: "kill_feed"; data: KillFeedEvent }
  | { type: "damage"; targetId: string; amount: number; shield: number; hull: number; crit: boolean; toLocal: boolean; fromLocal: boolean; x: number; y: number }
  | { type: "level_up"; level: number }
  | { type: "loot_pickup"; data: ItemPickupEvent }
  | { type: "loot_drop"; lootId: string; rarity: Rarity; label: string }
  | { type: "notice"; data: NoticeEvent }
  | { type: "reward"; data: RewardEvent }
  | { type: "boss_phase"; bossId: string; phase: number; name: string; layer: string }
  | { type: "event_started" | "event_finished"; eventId: string; name: string; eventType: string; endsAt: string }
  | { type: "death"; killerName?: string; repairCost?: number }
  | { type: "respawn"; repairCost: number }
  | { type: "docked"; stationId: string; stationName: string; services: string[] }
  | { type: "undocked" }
  | { type: "map_transition"; phase: "start" | "loading" | "end" | "failed"; mapId: string; mapName: string; error?: string }
  | { type: "quest_progress"; questId: string; progress: number[] }
  | { type: "quest_complete"; questId: string; name: string }
  | { type: "chat"; channel: string; from: string; fromId: string; text: string; at: number }
  | { type: "match_start"; matchId: string; mode: string }
  | { type: "match_end"; data: MatchEndEvent }
  | { type: "wave"; wave: number; total: number; name: string }
  | { type: "marker"; x: number; y: number; kind: string; fromName: string }
  | { type: "connection"; status: ConnectionStatus }
  | { type: "error"; code: string; message: string }
  | { type: "graphics"; tier: GraphicsTier; backend: string };
