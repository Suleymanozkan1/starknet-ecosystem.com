# Nebula Frontier — Mobile (Android & iOS)

The mobile apps are a [Capacitor 8](https://capacitorjs.com) shell (`apps/mobile`) around the same React
web app (`apps/web`). There is one codebase; mobile-specific behaviour lives in `apps/web/src/native/*`
and is guarded by `Capacitor.isNativePlatform()`, so the browser build is unaffected.

| Item | Value |
|---|---|
| App id | `com.nebulafrontier.app` |
| App name | Nebula Frontier |
| Web bundle | `apps/web/dist` (`webDir: ../web/dist`) |
| WebView origin | Android `https://localhost` (`androidScheme: https`), iOS `capacitor://localhost` |
| Custom scheme | `nebulafrontier://` |
| Universal / App Links host | `play.nebulafrontier.example` (replace with your production domain) |

## 1. Build

```bash
# from the repo root
pnpm install
VITE_API_URL=https://api.nebulafrontier.example \
VITE_SOLANA_RPC_URL=https://api.devnet.solana.com \
VITE_DEEP_LINK_HOSTS=play.nebulafrontier.example \
pnpm --filter @nebula/web build          # produces apps/web/dist
pnpm --filter @nebula/mobile sync         # npx cap sync (copies web + updates native plugins)
```

`VITE_API_URL` **must** be set for native builds: inside the WebView the page origin is
`https://localhost`, so relative `/api` calls would not reach the server. The API must list
`https://localhost` and `capacitor://localhost` in `CORS_ORIGINS` (already in `.env.example`) and, for
cookie auth across origins in production, issue cookies with `SameSite=None; Secure` (or serve the API
from the same registrable domain and set `COOKIE_DOMAIN`). The CSRF token is also returned in auth
response bodies (`csrfToken`) and the `x-nf-csrf` header, which the client keeps in memory because
`document.cookie` cannot read a cross-origin cookie.

### Android

Requirements: JDK 21, Android SDK (platform 36, build-tools), `ANDROID_HOME` set.

```bash
cd apps/mobile
npx cap sync android
cd android && ./gradlew assembleDebug     # → android/app/build/outputs/apk/debug/app-debug.apk
npx cap open android                      # Android Studio (release signing, bundles)
```

Release: `./gradlew bundleRelease` with a keystore configured in `android/app/build.gradle`
(`signingConfigs`), then upload the `.aab` to Play Console.

> In the build container used for this repository Java 21 is available but **no Android SDK**
> (`ANDROID_HOME` unset), so `assembleDebug` was not executed there. The `android/` project was generated
> with `npx cap add android` and synced; run the commands above on a machine with the SDK.

### iOS

Requirements: macOS, Xcode 16+, CocoaPods (or SPM, Capacitor 8 default).

```bash
cd apps/mobile
npx cap add ios        # once, if apps/mobile/ios does not exist yet
npx cap sync ios
npx cap open ios       # set Team, signing, then Run / Archive
```

If `apps/mobile/ios` is missing, it could not be generated in the Linux build container (no Xcode /
CocoaPods). All settings required for iOS are listed below so they can be applied right after
`npx cap add ios`.

## 2. Deep links, Universal Links and App Links

Routing is implemented in `apps/web/src/native/deepLinks.ts` (`deepLinkToRoute`, unit-tested) and wired in
`apps/web/src/native/index.ts` (`App.addListener("appUrlOpen")` + `App.getLaunchUrl()` for cold starts).

Accepted:

* `nebulafrontier://<route>[/…][?query]` — the host part is the first route segment
  (`nebulafrontier://wallet/return?…` → `/wallet/return?…`).
* `https://play.nebulafrontier.example/<route>[/…]` — Universal Links (iOS) / verified App Links (Android).

Everything else is rejected: other schemes/hosts/ports, credentials in URLs, `..`, unknown top-level routes
(whitelist: home, play, hangar, galaxy, inventory, ships, missions, crafting, clan, market, auction,
leaderboard, season, battle-pass, events, shop, wallet, profile, friends, notifications, mail, settings),
unexpected sub-paths, and query keys that are not `[A-Za-z0-9_]{1,32}`. Wallet return links
(`/wallet/return`) land on the wallet page; wallet apps that redirect back after signing use this path.

### Android (`apps/mobile/android/app/src/main/AndroidManifest.xml`)

Two intent filters are added to `MainActivity`:

```xml
<intent-filter>
  <action android:name="android.intent.action.VIEW" />
  <category android:name="android.intent.category.DEFAULT" />
  <category android:name="android.intent.category.BROWSABLE" />
  <data android:scheme="nebulafrontier" />
</intent-filter>
<intent-filter android:autoVerify="true">
  <action android:name="android.intent.action.VIEW" />
  <category android:name="android.intent.category.DEFAULT" />
  <category android:name="android.intent.category.BROWSABLE" />
  <data android:scheme="https" android:host="play.nebulafrontier.example" />
</intent-filter>
```

For verification host `https://play.nebulafrontier.example/.well-known/assetlinks.json`:

```json
[{ "relation": ["delegate_permission/common.handle_all_urls"],
   "target": { "namespace": "android_app", "package_name": "com.nebulafrontier.app",
               "sha256_cert_fingerprints": ["<SHA-256 of your signing cert>"] } }]
```

### iOS

* **Associated Domains** capability → `applinks:play.nebulafrontier.example`
  (writes `App/App.entitlements`).
* **URL Types** in `Info.plist`:

```xml
<key>CFBundleURLTypes</key>
<array><dict>
  <key>CFBundleURLName</key><string>com.nebulafrontier.app</string>
  <key>CFBundleURLSchemes</key><array><string>nebulafrontier</string></array>
</dict></array>
```

* Host `https://play.nebulafrontier.example/.well-known/apple-app-site-association`:

```json
{ "applinks": { "details": [{ "appIDs": ["<TEAMID>.com.nebulafrontier.app"],
  "components": [{ "/": "/*" }] }] } }
```

## 3. Push notifications (FCM / APNs)

Client: `apps/web/src/native/push.ts` → `registerPush()`. It asks for permission (only from a user action:
Notifications page → *Enable push*), registers with `@capacitor/push-notifications`, and sends the token to
`POST /api/notifications/push-token { token, platform, deviceId }`. Tapping a notification reads
`data.link` (full deep link) or `data.route` and routes it through the same deep-link whitelist.

* **Android / FCM**: create a Firebase project, add the Android app `com.nebulafrontier.app`, place
  `google-services.json` in `apps/mobile/android/app/`. Server credentials: `FCM_SERVICE_ACCOUNT_JSON`.
* **iOS / APNs**: enable the *Push Notifications* capability and *Background Modes → Remote
  notifications*; create an APNs auth key (`.p8`) → `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_KEY_P8`.
* Foreground presentation is configured in `capacitor.config.ts` (`PushNotifications.presentationOptions`).
* Android 13+: `POST_NOTIFICATIONS` is requested at runtime by the plugin (declared by the plugin manifest).

## 4. Secure storage & sessions

* **Auth tokens are never stored by the app.** Sessions are httpOnly cookies (`nf_access`, `nf_refresh`)
  held by the WebView cookie store; the refresh token is rotated server-side with reuse detection.
* `@aparajita/capacitor-secure-storage` (Keychain on iOS, Android Keystore-encrypted storage) holds only
  non-auth data: user preferences (`settings.v1`, via the zustand persist adapter
  `prefsStateStorage`) and the random **device id** sent with login/verify and push registration.
  On the web these fall back to `localStorage`.
* **Biometric gate**: withdrawals call `biometricGate()` (`@aparajita/capacitor-biometric-auth`) on native
  devices with enrolled biometrics / device credential; the server still enforces every withdrawal rule.
  iOS needs `NSFaceIDUsageDescription` in `Info.plist`
  (“Confirm withdrawals with Face ID.”).

## 5. App lifecycle & battery

`apps/web/src/native/lifecycle.ts` merges Capacitor `appStateChange` with `document.visibilitychange`:

* The game session (`/play`) calls `setPaused(true)` on the game client when the app goes to background —
  rendering and input are suspended, the server keeps the authoritative simulation.
* The menu starfield (`SpaceBackdrop`) stops its animation loop; the 3D hangar uses
  `requestAnimationFrame`, which the WebView suspends in the background.
* The Android hardware back button navigates back, or minimises the app at the root.
* Queries refetch on focus, so balances/notifications are fresh after resume.

## 6. Performance tiers

Graphics quality is chosen in **Settings → Graphics quality**: `Auto`, `Ultra`, `High`, `Medium`, `Low`
(persisted per device). `Auto` is resolved by `@nebula/game-renderer` (`resolveTier` / `probeDeviceCaps`:
GPU class, device memory, cores, DPR, screen size) with adaptive resolution targeting the tier FPS.
Guidance: phones → `Medium`/`Low` (battery), tablets → `High`, desktop dGPU → `Ultra`.
The menu backdrop caps DPR at 2 and scales star count with screen area; reduced-motion disables it.

## 7. Touch controls (combat)

Mobile UI is not a shrunken desktop: `useIsMobileUI()` switches to the mobile layout inside the native
shell, on narrow screens, and on touch-first tablets.

* **Bottom navigation**: Home · Hangar · Galaxy · Clan · Shop · Wallet (other screens from the Home grid).
* **In combat, only critical HUD**: compact shield/hull/energy, map strip, target panel, boss bar,
  kill feed. The minimap is drawn by the game client.
* **Left virtual joystick** → `setJoystick(x, y)` with a configurable dead zone and optional Y inversion.
* **Right cluster**: **Fire** (hold), **Ability 1**, **Ability 2**, **Ultimate**, **EMP**, **Shield**,
  **Dash** — each shows its cooldown.
* **Targeting**: *Nearest enemy*, *Nearest player*, *Nearest objective*, *Manual lock* (then tap a ship).
* **Left-handed layout** swaps the joystick and action cluster (Settings → Controls).
* **Haptics** on button presses, incoming hits, level-ups and boss phases (Capacitor Haptics natively,
  Vibration API on Android browsers); can be disabled in Settings.
* Safe areas (`env(safe-area-inset-*)`, `viewport-fit=cover`) are respected by the top bar, bottom nav and
  combat controls; orientation changes re-layout via CSS (landscape recommended in combat).

## 8. Permissions (minimal)

* Android: `INTERNET` (Capacitor default), `POST_NOTIFICATIONS` (push plugin), `USE_BIOMETRIC`
  (biometric plugin), `VIBRATE` (haptics plugin). No location, camera, contacts or storage permissions.
* iOS: `NSFaceIDUsageDescription` only.
