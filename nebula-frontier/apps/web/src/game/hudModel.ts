/**
 * View model consumed by the React HUD. `adapter.ts` maps the game client's `HudState` /
 * `GameUiEvent` (apps/game-client) onto these shapes so the HUD stays decoupled from engine internals.
 */
export interface BarPair { value: number; max: number }

export interface HudTarget {
  id: string;
  name: string;
  kind: string;
  level: number;
  hull: BarPair;
  shield: BarPair;
  distance: number | null;
  faction: string | null;
  hostile: boolean;
}

export interface HudSkill {
  slot: number;
  key: string;
  name: string;
  kind: "ABILITY" | "MODULE" | "ULTIMATE" | string;
  cooldownMs: number;
  remainingMs: number;
  energyCost: number;
  active: boolean;
}

export interface HudBoss { name: string; hull: BarPair; shield: BarPair; phase: number; phaseName: string; layer: string; phases: number }
export interface HudSquadMember { id: string; name: string; hull: BarPair; shield: BarPair; dead: boolean }
export interface HudQuest { name: string; objectives: { label: string; progress: number; count: number }[] }

export interface HudView {
  mapId: string;
  connection: "connecting" | "connected" | "reconnecting" | "disconnected";
  pingMs: number | null;
  hull: BarPair;
  shield: BarPair;
  energy: BarPair;
  speed: number;
  maxSpeed: number;
  ammo: { label: string; count: number | null }[];
  target: HudTarget | null;
  skills: HudSkill[];
  quest: HudQuest | null;
  squad: HudSquadMember[];
  boss: HudBoss | null;
  /** Station in docking range (show "Dock" prompt). */
  dockPrompt: { stationId: string; name: string } | null;
  /** Currently docked at a station. */
  docked: { stationId: string; name: string; services: string[] } | null;
  dead: { repairCost: number; respawnAt: number | null; killer: string | null } | null;
  zone: string | null;
  /** Interactables in range (from the game client's prompts): loot container, minable asteroid, portal. */
  nearby: { loot: boolean; asteroid: boolean; portal: boolean };
}

export type HudEvent =
  | { type: "killfeed"; killer: string; victim: string; weapon: string; pvp: boolean }
  | { type: "levelup"; level: number }
  | { type: "loot"; label: string; rarity: string; credits: number }
  | { type: "reward"; text: string }
  | { type: "notice"; level: "info" | "warn" | "error" | "success"; text: string }
  | { type: "chat"; channel: string; from: string; text: string; at: number }
  | { type: "jump"; mapId: string; phase: "start" | "end" }
  | { type: "hit"; incoming: boolean; crit: boolean }
  | { type: "boss_phase"; name: string; phase: number };

export const EMPTY_HUD: HudView = {
  mapId: "",
  connection: "connecting",
  pingMs: null,
  hull: { value: 0, max: 1 },
  shield: { value: 0, max: 1 },
  energy: { value: 0, max: 1 },
  speed: 0,
  maxSpeed: 1,
  ammo: [],
  target: null,
  skills: [],
  quest: null,
  squad: [],
  boss: null,
  dockPrompt: null,
  docked: null,
  dead: null,
  zone: null,
  nearby: { loot: false, asteroid: false, portal: false },
};
