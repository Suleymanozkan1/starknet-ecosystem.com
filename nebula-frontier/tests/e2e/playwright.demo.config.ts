import { defineConfig, devices } from "@playwright/test";
import { proxyOptions, webglLaunchOptions } from "./browser.js";

/**
 * Specs that run against the static DEMO build (VITE_DEMO_MODE=true: the in-browser mock API, no backend).
 *   pnpm --filter @nebula/tests exec playwright test -c e2e/playwright.demo.config.ts
 * The web server builds apps/web in demo mode into test-results/web-demo-dist and serves it with
 * `vite preview` on port 4190. Set E2E_DEMO_SKIP_BUILD=1 to reuse an existing build, or
 * E2E_DEMO_BASE_URL to run against an already running demo deployment.
 */
const PORT = 4190;
const baseURL = process.env.E2E_DEMO_BASE_URL ?? `http://localhost:${PORT}`;
const OUT_DIR = "../../test-results/web-demo-dist";
const build = `VITE_DEMO_MODE=true ./node_modules/.bin/vite build --outDir ${OUT_DIR} --emptyOutDir --logLevel warn`;
const serve = `./node_modules/.bin/vite preview --outDir ${OUT_DIR} --port ${PORT} --strictPort`;

export default defineConfig({
  testDir: ".",
  testMatch: /\.demo\.spec\.ts$/,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  outputDir: "../../test-results/e2e-demo",
  use: {
    baseURL,
    trace: "retain-on-failure",
    ...proxyOptions(),
    launchOptions: webglLaunchOptions(),
  },
  projects: [{ name: "demo-desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  webServer: process.env.E2E_DEMO_BASE_URL
    ? undefined
    : {
        command: process.env.E2E_DEMO_SKIP_BUILD ? serve : `${build} && ${serve}`,
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 300_000,
        cwd: "../../apps/web",
      },
});
