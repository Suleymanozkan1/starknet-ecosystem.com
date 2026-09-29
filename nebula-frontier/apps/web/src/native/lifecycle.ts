/**
 * Foreground/background signal merged from Capacitor App state (native) and
 * document.visibilitychange (web + native webview). Used to pause game rendering
 * and polling when the app is not visible to save battery.
 */
import { isNative } from "./platform.js";

type Listener = (active: boolean) => void;
const listeners = new Set<Listener>();
let active = typeof document === "undefined" ? true : document.visibilityState !== "hidden";
let initialized = false;

function emit(next: boolean): void {
  if (next === active) return;
  active = next;
  listeners.forEach((l) => l(active));
}

export function initLifecycle(): void {
  if (initialized || typeof document === "undefined") return;
  initialized = true;
  document.addEventListener("visibilitychange", () => emit(document.visibilityState !== "hidden"));
  if (isNative) {
    void import("@capacitor/app").then(({ App }) => {
      void App.addListener("appStateChange", ({ isActive }) => emit(isActive));
    });
  }
}

export function isAppActive(): boolean {
  return active;
}

export function onAppActiveChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
