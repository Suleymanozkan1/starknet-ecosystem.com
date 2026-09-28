/**
 * Bridge between the React shell and @nebula/game-client (`createGame(opts): Promise<GameHandle>`).
 * The game client owns rendering (Three.js world + Phaser radar/minimap) and the Colyseus connection;
 * this module lazy-loads it (code-split) and maps its HudState / GameUiEvent callbacks onto the HUD view model.
 */
import type { GameTicketResponse } from "../lib/dto.js";
import type { GraphicsSetting } from "../store/settings.js";
import type { GameChatChannel } from "../store/gameLink.js";
import type { HudEvent, HudView } from "./hudModel.js";
import { mapEvent, mapHud } from "./mapping.js";

export type TargetMode = "NEAREST_ENEMY" | "NEAREST_PLAYER" | "NEAREST_OBJECTIVE" | "CLEAR";

/** Commands the HUD / touch controls send. All are intents; the server decides outcomes. */
export interface GameActions {
  setJoystick(x: number, y: number): void;
  setFiring(on: boolean): void;
  useSkill(slot: number): void;
  target(mode: TargetMode): void;
  toggleManualLock(): void;
  dash(): void;
  dock(): void;
  undock(): void;
  repair(): void;
  respawn(): void;
  sendChat(channel: GameChatChannel, text: string): void;
  setPaused(paused: boolean): void;
  setAudio(v: { master: number; music: number; sfx: number }): void;
  dispose(): void;
}

export interface StartOptions {
  ticket: GameTicketResponse;
  tier: GraphicsSetting;
  touch: boolean;
  audio: { master: number; music: number; sfx: number };
  onHud: (hud: HudView) => void;
  onEvent: (e: HudEvent) => void;
  onProgress: (progress: number, label: string) => void;
}

export async function startGame(container: HTMLElement, o: StartOptions): Promise<GameActions> {
  o.onProgress(0.1, "Loading engine");
  const { createGame } = await import("@nebula/game-client");
  o.onProgress(0.25, "Connecting to sector");
  const handle = await createGame({
    container,
    ticket: o.ticket.ticket,
    mapId: o.ticket.mapId,
    gameServerUrl: o.ticket.gameServerUrl,
    tier: o.tier,
    touch: o.touch,
    onHud: (s) => o.onHud(mapHud(s)),
    onEvent: (e) => {
      const m = mapEvent(e);
      if (m) o.onEvent(m);
    },
    onProgress: (p: number, label?: string) => o.onProgress(0.25 + p * 0.75, label ?? "Loading sector"),
  });
  handle.setVolume?.(o.audio.master);

  let manualLock = false;
  return {
    setJoystick: (x, y) => handle.setJoystick(x, y),
    setFiring: (on) => handle.setFiring(on),
    useSkill: (slot) => handle.useSkill(slot),
    target: (mode) => handle.target(mode),
    toggleManualLock: () => {
      manualLock = !manualLock;
      handle.setManualLock?.(manualLock);
    },
    dash: () => handle.dash(),
    dock: () => handle.dock(),
    undock: () => handle.undock(),
    repair: () => handle.repair?.(),
    respawn: () => handle.respawn(),
    sendChat: (channel, text) => handle.sendChat(channel, text),
    setPaused: (p) => handle.setPaused(p),
    setAudio: (v) => handle.setVolume?.(v.master),
    dispose: () => handle.dispose(),
  };
}
