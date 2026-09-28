/**
 * @nebula/game-client — embeddable NEBULA FRONTIER game (Three.js world +
 * Phaser 4 radar/HUD overlay + Colyseus networking). The React web app mounts
 * it with `createGame()` and renders HUD/overlays from `onHud` / `onEvent`.
 */
import { Game } from "./Game.js";
import type { GameClientOptions, GameHandle } from "./types.js";

export type {
  GameClientOptions, GameHandle, HudState, GameUiEvent, HudCooldown, HudTarget, HudPrompt, MinimapEntity, MinimapRelation,
  AudioVolumes, TargetMode, GraphicsTier,
} from "./types.js";

export async function createGame(opts: GameClientOptions): Promise<GameHandle> {
  const game = new Game(opts);
  try {
    await game.init();
  } catch (err) {
    game.dispose();
    throw err;
  }
  return game.handle();
}

/** Standalone 3D hangar viewer (re-exported for the web app's hangar screen). */
export { createHangarViewer, type HangarViewer, type HangarViewerOptions } from "@nebula/game-renderer";
