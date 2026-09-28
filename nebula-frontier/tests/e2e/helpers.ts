import type { APIRequestContext, Page } from "@playwright/test";

/** API origin used to decide whether the full (authenticated) flow can run. */
export const API_URL = process.env.E2E_API_URL ?? "http://localhost:8080";

export async function apiUp(request: APIRequestContext): Promise<boolean> {
  try {
    const r = await request.get(`${API_URL}/health`, { timeout: 3000 });
    return r.ok();
  } catch {
    return false;
  }
}

/** Registers a fresh pilot through the real UI (email flow). */
export async function registerThroughUi(page: Page): Promise<{ username: string }> {
  const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const username = `e2e_${suffix}`.slice(0, 20);
  await page.goto("/register");
  await page.getByRole("tab", { name: "Email" }).click();
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="email"]').fill(`${username}@example.test`);
  await page.locator('input[name="password"]').fill("Frontier-Test-2026");
  await page.getByTestId("email-submit").click();
  await page.waitForURL(/\/onboarding\/faction/);
  return { username };
}

export async function shot(page: Page, name: string): Promise<void> {
  if (!process.env.E2E_SCREENSHOTS) return;
  await page.waitForTimeout(900);
  await page.screenshot({ path: `../../docs/screenshots/${name}.png`, fullPage: false });
}
