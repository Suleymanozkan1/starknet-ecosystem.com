import { defineConfig, devices } from "@playwright/test";
import { proxyOptions, webglLaunchOptions } from "./browser.js";

/**
 * Wallet sign-in against the real stack: a dedicated API process (port 8191, local PostgreSQL + Redis from
 * ../../.env) and the Vite dev server (port 4191) proxying /api to it. The SIWS domain is derived from
 * PUBLIC_WEB_URL, so the API signs challenges for `localhost:4191`.
 *   service postgresql start; service redis-server start
 *   pnpm --filter @nebula/tests exec playwright test -c e2e/playwright.wallet.config.ts
 */
const API_PORT = 8191;
const WEB_PORT = 4191;
const apiURL = `http://localhost:${API_PORT}`;
const baseURL = `http://localhost:${WEB_PORT}`;

export default defineConfig({
  testDir: ".",
  testMatch: /\.wallet\.spec\.ts$/,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  outputDir: "../../test-results/e2e-wallet",
  use: {
    baseURL,
    trace: "retain-on-failure",
    ...proxyOptions(),
    launchOptions: webglLaunchOptions(),
  },
  projects: [{ name: "wallet-desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  webServer: [
    {
      command: "../../node_modules/.bin/tsx --env-file-if-exists=../../.env src/index.ts",
      cwd: "../../apps/api",
      url: `${apiURL}/health`,
      env: { API_PORT: String(API_PORT), PUBLIC_WEB_URL: baseURL, LOG_LEVEL: "warn" },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: `./node_modules/.bin/vite --port ${WEB_PORT} --strictPort`,
      cwd: "../../apps/web",
      url: baseURL,
      env: { VITE_DEV_API_PROXY: apiURL },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
