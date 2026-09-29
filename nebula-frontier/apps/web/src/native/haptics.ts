import { isNative } from "./platform.js";

let enabled = true;
export function setHapticsEnabled(v: boolean): void {
  enabled = v;
}

type Kind = "light" | "medium" | "heavy" | "success" | "warning" | "error" | "selection";

/** Fire-and-forget haptic feedback. Native uses Capacitor Haptics; web falls back to the Vibration API. */
export function haptic(kind: Kind = "light"): void {
  if (!enabled) return;
  if (isNative) {
    void import("@capacitor/haptics").then(({ Haptics, ImpactStyle, NotificationType }) => {
      switch (kind) {
        case "light": return Haptics.impact({ style: ImpactStyle.Light });
        case "medium": return Haptics.impact({ style: ImpactStyle.Medium });
        case "heavy": return Haptics.impact({ style: ImpactStyle.Heavy });
        case "success": return Haptics.notification({ type: NotificationType.Success });
        case "warning": return Haptics.notification({ type: NotificationType.Warning });
        case "error": return Haptics.notification({ type: NotificationType.Error });
        case "selection": return Haptics.selectionChanged();
      }
    }).catch(() => undefined);
    return;
  }
  if (typeof navigator !== "undefined" && "vibrate" in navigator && window.matchMedia?.("(pointer: coarse)").matches) {
    const ms = kind === "heavy" || kind === "error" ? 35 : kind === "medium" || kind === "warning" ? 20 : 8;
    try {
      navigator.vibrate(ms);
    } catch {
      /* not allowed before user gesture */
    }
  }
}
