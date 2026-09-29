import { useSettings } from "../store/settings.js";
import type { GraphicsSetting } from "../store/settings.js";

/**
 * Graphics tier requested by the player. "AUTO" is resolved by @nebula/game-renderer
 * (`resolveTier`, GPU/device-memory probing) inside the renderer chunk so three.js stays code-split.
 */
export function useGraphicsTier(): GraphicsSetting {
  return useSettings((s) => s.graphics);
}
