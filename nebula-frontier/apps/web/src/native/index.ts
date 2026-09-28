/**
 * Native bridge bootstrap: lifecycle, deep links (appUrlOpen), Android back button, status bar safe areas.
 * Safe to call on web — every native-only branch is guarded.
 */
import { isNative } from "./platform.js";
import { initLifecycle } from "./lifecycle.js";
import { deepLinkToRoute } from "./deepLinks.js";

export * from "./platform.js";
export * from "./secureStorage.js";
export * from "./haptics.js";
export * from "./clipboard.js";
export * from "./share.js";
export * from "./biometric.js";
export * from "./lifecycle.js";
export * from "./deepLinks.js";
export { registerPush } from "./push.js";

let started = false;

export function initNative(navigate: (route: string) => void): void {
  initLifecycle();
  if (!isNative || started) return;
  started = true;
  void import("@capacitor/app").then(async ({ App }) => {
    await App.addListener("appUrlOpen", ({ url }) => {
      const route = deepLinkToRoute(url);
      if (route) navigate(route);
      else console.warn("Rejected deep link", url.split("?")[0]);
    });
    await App.addListener("backButton", ({ canGoBack }) => {
      if (canGoBack) window.history.back();
      else void App.minimizeApp();
    });
    // Cold start via link.
    const launch = await App.getLaunchUrl();
    if (launch?.url) {
      const route = deepLinkToRoute(launch.url);
      if (route) navigate(route);
    }
  });
}
