/**
 * Secure storage for NON-auth preferences and the device id.
 * Native: Keychain (iOS) / Android Keystore-backed storage via @aparajita/capacitor-secure-storage.
 * Web: localStorage (auth tokens are httpOnly cookies and are never stored here).
 */
import { isNative } from "./platform.js";

const PREFIX = "nf.";

async function native() {
  const mod = await import("@aparajita/capacitor-secure-storage");
  return mod.SecureStorage;
}

export async function getPref(key: string): Promise<string | null> {
  if (isNative) {
    try {
      return await (await native()).getItem(PREFIX + key);
    } catch {
      return null;
    }
  }
  try {
    return window.localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

export async function setPref(key: string, value: string): Promise<void> {
  if (isNative) {
    try {
      await (await native()).setItem(PREFIX + key, value);
    } catch {
      /* storage unavailable (e.g. locked keychain) — preference is simply not persisted */
    }
    return;
  }
  try {
    window.localStorage.setItem(PREFIX + key, value);
  } catch {
    /* private mode / quota — not persisted */
  }
}

export async function removePref(key: string): Promise<void> {
  if (isNative) {
    try {
      await (await native()).removeItem(PREFIX + key);
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    window.localStorage.removeItem(PREFIX + key);
  } catch {
    /* ignore */
  }
}

let deviceIdPromise: Promise<string> | null = null;
/** Stable random device id (not a hardware identifier) used for session/device binding and push. */
export function getDeviceId(): Promise<string> {
  deviceIdPromise ??= (async () => {
    const existing = await getPref("deviceId");
    if (existing && /^[a-f0-9-]{16,64}$/.test(existing)) return existing;
    const id = crypto.randomUUID();
    await setPref("deviceId", id);
    return id;
  })();
  return deviceIdPromise;
}

/** zustand `persist` storage adapter backed by secure storage. */
export const prefsStateStorage = {
  getItem: (name: string) => getPref(name),
  setItem: (name: string, value: string) => setPref(name, value),
  removeItem: (name: string) => removePref(name),
};
