import { defineConfig, devices } from "@playwright/test";

/**
 * Web smoke tests (desktop + mobile). Starts the Vite dev server unless E2E_BASE_URL is given.
 *   pnpm --filter @nebula/tests exec playwright test -c e2e/playwright.config.ts
 * Chromium: set PLAYWRIGHT_CHROMIUM_PATH (e.g. /opt/pw-browsers/chromium-1194/chrome-linux/chrome) when
 * browsers are pre-installed outside the Playwright cache.
 */
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:5173";
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts$/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  outputDir: "../../test-results/e2e",
  use: {
    baseURL,
    trace: "retain-on-failure",
    // Behind an egress proxy (CI sandboxes) web fonts are fetched through it.
    ...(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY, bypass: "localhost,127.0.0.1" }, ignoreHTTPSErrors: true } : {}),
    launchOptions: { ...(executablePath ? { executablePath } : {}), args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] },
  },
  projects: [
    { name: "desktop", testMatch: /(desktop|play)\.spec\.ts$/, use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "mobile", testMatch: /(mobile|play)\.spec\.ts$/, use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, userAgent: devices["Pixel 7"].userAgent } },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : { command: "pnpm --filter @nebula/web dev", url: baseURL, reuseExistingServer: true, timeout: 120_000, cwd: "../.." },
});
