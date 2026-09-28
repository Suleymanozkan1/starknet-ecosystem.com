import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { prefsStateStorage } from "../native/secureStorage.js";
import { setHapticsEnabled } from "../native/haptics.js";

export type GraphicsSetting = "AUTO" | "ULTRA" | "HIGH" | "MEDIUM" | "LOW";
export type Language = "en" | "tr";

export interface SettingsState {
  graphics: GraphicsSetting;
  masterVolume: number;
  musicVolume: number;
  sfxVolume: number;
  muted: boolean;
  language: Language;
  haptics: boolean;
  showDamageNumbers: boolean;
  invertJoystick: boolean;
  /** Joystick dead zone 0..0.5 */
  joystickDeadZone: number;
  leftHandedControls: boolean;
  reducedMotion: boolean;
  set: <K extends keyof Omit<SettingsState, "set">>(key: K, value: SettingsState[K]) => void;
}

function initialLanguage(): Language {
  if (typeof navigator !== "undefined" && navigator.language?.toLowerCase().startsWith("tr")) return "tr";
  return "en";
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      graphics: "AUTO",
      masterVolume: 0.8,
      musicVolume: 0.6,
      sfxVolume: 0.8,
      muted: false,
      language: initialLanguage(),
      haptics: true,
      showDamageNumbers: true,
      invertJoystick: false,
      joystickDeadZone: 0.12,
      leftHandedControls: false,
      reducedMotion: false,
      set: (key, value) => {
        if (key === "haptics") setHapticsEnabled(Boolean(value));
        set({ [key]: value } as Partial<SettingsState>);
      },
    }),
    {
      name: "settings.v1",
      storage: createJSONStorage(() => prefsStateStorage),
      partialize: ({ set: _set, ...rest }) => rest,
      onRehydrateStorage: () => (state) => {
        if (state) setHapticsEnabled(state.haptics);
      },
    },
  ),
);
