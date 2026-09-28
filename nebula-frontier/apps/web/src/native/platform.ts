import { Capacitor } from "@capacitor/core";

/** True inside the Capacitor Android/iOS shell. */
export const isNative: boolean = Capacitor.isNativePlatform();
export const platform = Capacitor.getPlatform() as "web" | "ios" | "android";

export function isPluginAvailable(name: string): boolean {
  return Capacitor.isPluginAvailable(name);
}

/** Coarse pointer (finger) as primary input. */
export function isTouchPrimary(): boolean {
  if (typeof window === "undefined") return false;
  return isNative || window.matchMedia?.("(pointer: coarse)").matches === true;
}
