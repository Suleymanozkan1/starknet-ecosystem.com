import { isNative, isPluginAvailable } from "./platform.js";
import { tNow } from "../lib/i18n.js";

/**
 * Biometric gate for sensitive actions (withdrawals). On native devices with enrolled biometry the user
 * must pass Face ID / fingerprint (device credential fallback allowed). On web or devices without
 * biometry this resolves to true — the server still enforces its own withdrawal checks.
 */
export async function biometricGate(reason: string): Promise<boolean> {
  if (!isNative || !isPluginAvailable("BiometricAuthNative")) return true;
  try {
    const { BiometricAuth } = await import("@aparajita/capacitor-biometric-auth");
    const info = await BiometricAuth.checkBiometry();
    if (!info.isAvailable && !info.deviceIsSecure) return true;
    await BiometricAuth.authenticate({
      reason,
      cancelTitle: tNow("wallet.bioCancel"),
      allowDeviceCredential: true,
      androidTitle: tNow("wallet.bioTitle"),
      androidSubtitle: reason,
    });
    return true;
  } catch {
    return false;
  }
}

export async function biometricAvailable(): Promise<boolean> {
  if (!isNative) return false;
  try {
    const { BiometricAuth } = await import("@aparajita/capacitor-biometric-auth");
    const info = await BiometricAuth.checkBiometry();
    return info.isAvailable;
  } catch {
    return false;
  }
}
