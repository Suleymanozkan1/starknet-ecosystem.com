import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { prefsStateStorage } from "../native/secureStorage.js";

/**
 * ARIA tutorial progress. Persisted through the same secure-storage adapter as the settings store
 * (localStorage on the web, wrapped in try/catch — private mode / quota errors only mean "not persisted").
 *
 * Ids are namespaced strings: "landing" (full briefing), "page:<id>" (shell page tips), "game:<id>" (in-game tips).
 */
export interface TutorialState {
  /** Automatic tips on/off. Explicit requests (help button, "Meet ARIA") still work when disabled. */
  enabled: boolean;
  /** Ids of tips/briefings that were already shown. */
  seen: string[];
  /** Transient (not persisted): a tip the player explicitly asked to replay. */
  replayId: string | null;
  /** Transient: bumped on every replay request so the same id can be replayed twice in a row. */
  replayNonce: number;
  markSeen: (id: string) => void;
  /** Show `id` again right now, even when already seen or when tips are disabled. */
  replay: (id: string) => void;
  clearReplay: () => void;
  setEnabled: (enabled: boolean) => void;
  /** "Replay all tutorials": forget every seen id and re-enable the guide. */
  reset: () => void;
}

export const TUTORIAL_STORAGE_NAME = "tutorial.v1";

export const useTutorial = create<TutorialState>()(
  persist(
    (set, get) => ({
      enabled: true,
      seen: [],
      replayId: null,
      replayNonce: 0,
      markSeen: (id) => {
        if (get().seen.includes(id)) return;
        set({ seen: [...get().seen, id] });
      },
      replay: (id) => set({ replayId: id, replayNonce: get().replayNonce + 1 }),
      clearReplay: () => set({ replayId: null }),
      setEnabled: (enabled) => set({ enabled }),
      reset: () => set({ seen: [], enabled: true, replayId: null }),
    }),
    {
      name: TUTORIAL_STORAGE_NAME,
      version: 1,
      storage: createJSONStorage(() => prefsStateStorage),
      partialize: ({ enabled, seen }) => ({ enabled, seen }),
      // Tolerate corrupted / foreign persisted data: keep only well-formed fields.
      merge: (persisted, current) => {
        const p = (typeof persisted === "object" && persisted !== null ? persisted : {}) as Partial<Record<"enabled" | "seen", unknown>>;
        return {
          ...current,
          enabled: typeof p.enabled === "boolean" ? p.enabled : current.enabled,
          seen: Array.isArray(p.seen) ? p.seen.filter((x): x is string => typeof x === "string").slice(0, 500) : current.seen,
        };
      },
    },
  ),
);

/** Whether an automatic tip should be shown now (pure; used by components and tests). */
export function shouldAutoShow(s: Pick<TutorialState, "enabled" | "seen">, id: string): boolean {
  return s.enabled && !s.seen.includes(id);
}

/** Resolves once the persisted state has been loaded (immediately when it already was). */
export function whenTutorialHydrated(cb: () => void): () => void {
  if (useTutorial.persist.hasHydrated()) {
    cb();
    return () => undefined;
  }
  return useTutorial.persist.onFinishHydration(() => cb());
}
