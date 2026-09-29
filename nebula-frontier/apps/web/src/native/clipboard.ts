import { isNative } from "./platform.js";
import { haptic } from "./haptics.js";

/** Copy text (wallet address, tx signature). Returns true on success. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (isNative) {
      const { Clipboard } = await import("@capacitor/clipboard");
      await Clipboard.write({ string: text });
    } else {
      await navigator.clipboard.writeText(text);
    }
    haptic("selection");
    return true;
  } catch {
    return false;
  }
}
