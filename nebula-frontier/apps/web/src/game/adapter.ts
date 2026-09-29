/**
 * Bridge between the React shell and @nebula/game-client (`createGame(opts): Promise<GameHandle>`).
 * The game client owns rendering (Three.js world + Phaser radar/minimap/damage numbers) and the Colyseus
 * connection; this module lazy-loads it (code-split) and maps HudState / GameUiEvent onto the HUD view model.
 */
import { api } from "../lib/api.js";
import type { GameTicketResponse } from "../lib/dto.js";
import type { GraphicsSetting } from "../store/settings.js";
import type { GameChatChannel } from "../store/gameLink.js";
import type { HudEvent, HudView } from "./hudModel.js";
import { mapEvent, mapHud, newSessionFacts } from "./mapping.js";

export type TargetMode = "NEAREST_ENEMY" | "NEAREST_PLAYER" | "NEAREST_OBJECTIVE" | "CLEAR";

/** Commands the HUD / touch controls send. All are intents; the server decides outcomes. */
export interface GameActions {
  setJoystick(x: number, y: number): void;
  setFiring(on: boolean): void;
  useSkill(slot: number): void;
  target(mode: TargetMode): void;
  /** Hard-lock the current target (or release the lock). */
  toggleManualLock(): void;
  dash(): void;
  /** Dock at the nearby station / undock when docked (same intent on the game client). */
  dock(): void;
  undock(): void;
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
  o.onProgress(0.35, "Connecting to sector");
  const facts = newSessionFacts();
  let firstTicket: GameTicketResponse | null = o.ticket;
  const handle = await createGame({
    container,
    serverUrl: o.ticket.gameServerUrl,
    initialMapId: o.ticket.mapId,
    // The first join uses the ticket fetched by the Play page; portal jumps / reconnects fetch fresh ones.
    getTicket: async () => {
      const t = firstTicket ?? (await api.game.ticket());
      firstTicket = null;
      return { ticket: t.ticket, mapId: t.mapId };
    },
    graphics: o.tier,
    isMobile: o.touch,
    volume: { master: o.audio.master, music: o.audio.music, sfx: o.audio.sfx },
    onHud: (s) => o.onHud(mapHud(s, facts)),
    onEvent: (e) => {
      const m = mapEvent(e, facts);
      if (m) o.onEvent(m);
    },
  });
  o.onProgress(1, "Ready");

  let hardLock = false;
  return {
    setJoystick: (x, y) => handle.setJoystick(x, y),
    setFiring: (on) => handle.toggleFire(on),
    useSkill: (slot) => handle.useAbility(slot),
    target: (mode) => {
      hardLock = false;
      handle.target(mode);
    },
    toggleManualLock: () => {
      const t = handle.getHud().target;
      if (!t) {
        o.onEvent({ type: "notice", level: "info", text: "Tap a ship to select it, then lock." });
        return;
      }
      hardLock = !hardLock;
      handle.target({ entityId: t.id, lock: hardLock ? "HARD" : "SOFT" });
    },
    dash: () => handle.dash(),
    dock: () => handle.dock(),
    undock: () => {
      if (handle.getHud().docked) handle.dock();
    },
    respawn: () => handle.respawn(),
    sendChat: (channel, text) => handle.send("chat", { channel, text }),
    setPaused: (p) => handle.setPaused(p),
    setAudio: (v) => handle.setVolume({ master: v.master, music: v.music, sfx: v.sfx }),
    dispose: () => handle.dispose(),
  };
}
