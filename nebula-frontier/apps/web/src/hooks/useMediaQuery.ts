import { useSyncExternalStore } from "react";
import { isNative } from "../native/platform.js";

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(query);
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/**
 * Mobile UI (bottom nav, touch combat controls) — not a shrunken desktop.
 * Active inside the native shell, on narrow viewports, or on touch-first tablets in portrait.
 */
export function useIsMobileUI(): boolean {
  const narrow = useMediaQuery("(max-width: 767px)");
  const coarseSmall = useMediaQuery("(pointer: coarse) and (max-width: 1100px)");
  return isNative || narrow || coarseSmall;
}

export function useIsTouch(): boolean {
  const coarse = useMediaQuery("(pointer: coarse)");
  return isNative || coarse;
}

export function useIsLandscape(): boolean {
  return useMediaQuery("(orientation: landscape)");
}
