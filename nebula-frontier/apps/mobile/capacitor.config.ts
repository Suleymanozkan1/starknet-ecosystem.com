import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Nebula Frontier native shell (Android + iOS). The web layer is apps/web (built to ../web/dist).
 * Deep links: custom scheme `nebulafrontier://` + https App Links / Universal Links on
 * DEEP_LINK_HOST (see docs/MOBILE.md). Routing and the path whitelist live in apps/web/src/native/deepLinks.ts.
 */
const config: CapacitorConfig = {
  appId: "com.nebulafrontier.app",
  appName: "Nebula Frontier",
  webDir: "../web/dist",
  // Serve the bundled web app from https://localhost (secure context for WebCrypto / wallet adapters).
  server: {
    androidScheme: "https",
    iosScheme: "capacitor",
    // Only needed for live-reload during development: CAP_SERVER_URL=http://<lan-ip>:5173 npx cap run android
    ...(process.env.CAP_SERVER_URL ? { url: process.env.CAP_SERVER_URL, cleartext: true } : {}),
  },
  backgroundColor: "#04060c",
  loggingBehavior: "debug",
  android: {
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: process.env.NODE_ENV !== "production",
  },
  ios: {
    contentInset: "never",
    backgroundColor: "#04060c",
    limitsNavigationsToAppBoundDomains: false,
  },
  plugins: {
    PushNotifications: {
      presentationOptions: ["badge", "sound", "alert"],
    },
    SplashScreen: {
      launchShowDuration: 1200,
      launchAutoHide: true,
      backgroundColor: "#04060c",
      androidScaleType: "CENTER_CROP",
      showSpinner: false,
      splashFullScreen: true,
      splashImmersive: true,
    },
    LocalNotifications: {
      iconColor: "#6ee7ff",
    },
  },
};

export default config;
