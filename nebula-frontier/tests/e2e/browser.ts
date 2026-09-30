import { existsSync } from "node:fs";
import type { LaunchOptions } from "@playwright/test";

/** Pre-installed Playwright Chromium (sandbox / CI image) used when the bundled revision is not installed. */
const PREINSTALLED_CHROMIUM = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

/**
 * Chromium launch options for WebGL specs: software GL via ANGLE + SwiftShader so three.js renders
 * headless without a GPU. PLAYWRIGHT_CHROMIUM_PATH overrides the executable.
 */
export function webglLaunchOptions(): LaunchOptions {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || (existsSync(PREINSTALLED_CHROMIUM) ? PREINSTALLED_CHROMIUM : undefined);
  return {
    ...(executablePath ? { executablePath } : {}),
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  };
}

/** Behind an egress proxy (CI sandboxes) web fonts are fetched through it; local servers bypass it. */
export function proxyOptions(): { proxy?: { server: string; bypass: string }; ignoreHTTPSErrors?: boolean } {
  return process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY, bypass: "localhost,127.0.0.1" }, ignoreHTTPSErrors: true } : {};
}
