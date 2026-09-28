/**
 * Push notifications (FCM on Android, APNs on iOS) via @capacitor/push-notifications.
 * The device token is registered with the API: POST /api/notifications/devices.
 */
import { http } from "../lib/http.js";
import { isNative, isPluginAvailable, platform } from "./platform.js";
import { getDeviceId } from "./secureStorage.js";
import { deepLinkToRoute } from "./deepLinks.js";

let registered = false;

export async function registerPush(navigate: (route: string) => void): Promise<"registered" | "denied" | "unsupported" | "error"> {
  if (!isNative || !isPluginAvailable("PushNotifications")) return "unsupported";
  if (registered) return "registered";
  try {
    const { PushNotifications } = await import("@capacitor/push-notifications");
    let perm = await PushNotifications.checkPermissions();
    if (perm.receive === "prompt" || perm.receive === "prompt-with-rationale") perm = await PushNotifications.requestPermissions();
    if (perm.receive !== "granted") return "denied";

    await PushNotifications.removeAllListeners();
    await PushNotifications.addListener("registration", (token) => {
      void getDeviceId().then((deviceId) =>
        http.post("/api/notifications/devices", { token: token.value, platform, deviceId }).catch((e: unknown) => {
          console.warn("push token registration failed", e);
        }),
      );
    });
    await PushNotifications.addListener("registrationError", (err) => {
      console.warn("push registration error", err.error);
    });
    await PushNotifications.addListener("pushNotificationActionPerformed", (action) => {
      const data = action.notification.data as Record<string, unknown> | undefined;
      const link = typeof data?.link === "string" ? data.link : typeof data?.route === "string" ? `nebulafrontier:/${data.route}` : null;
      const route = link ? deepLinkToRoute(link) : null;
      if (route) navigate(route);
    });
    await PushNotifications.register();
    registered = true;
    return "registered";
  } catch (e) {
    console.warn("push setup failed", e);
    return "error";
  }
}
