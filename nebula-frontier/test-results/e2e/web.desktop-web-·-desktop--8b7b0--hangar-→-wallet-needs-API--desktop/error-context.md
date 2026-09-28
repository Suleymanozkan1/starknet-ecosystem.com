# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: web.desktop.spec.ts >> web · desktop >> full onboarding → dashboard → hangar → wallet (needs API)
- Location: e2e/web.desktop.spec.ts:30:3

# Error details

```
Test timeout of 60000ms exceeded.
```

```
Error: page.screenshot: Test timeout of 60000ms exceeded.
Call log:
  - taking page screenshot
  - waiting for fonts to load...
  - fonts loaded

```

# Test source

```ts
  1  | import type { APIRequestContext, Page } from "@playwright/test";
  2  | 
  3  | /** API origin used to decide whether the full (authenticated) flow can run. */
  4  | export const API_URL = process.env.E2E_API_URL ?? "http://localhost:8080";
  5  | 
  6  | export async function apiUp(request: APIRequestContext): Promise<boolean> {
  7  |   try {
  8  |     const r = await request.get(`${API_URL}/health`, { timeout: 3000 });
  9  |     return r.ok();
  10 |   } catch {
  11 |     return false;
  12 |   }
  13 | }
  14 | 
  15 | /** Registers a fresh pilot through the real UI (email flow). */
  16 | export async function registerThroughUi(page: Page): Promise<{ username: string }> {
  17 |   const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  18 |   const username = `e2e_${suffix}`.slice(0, 20);
  19 |   await page.goto("/register");
  20 |   await page.getByRole("tab", { name: "Email" }).click();
  21 |   await page.locator('input[name="username"]').fill(username);
  22 |   await page.locator('input[name="email"]').fill(`${username}@example.test`);
  23 |   await page.locator('input[name="password"]').fill("Frontier-Test-2026");
  24 |   await page.getByTestId("email-submit").click();
  25 |   await page.waitForURL(/\/onboarding\/faction/);
  26 |   return { username };
  27 | }
  28 | 
  29 | export async function shot(page: Page, name: string): Promise<void> {
  30 |   if (!process.env.E2E_SCREENSHOTS) return;
  31 |   await page.waitForTimeout(900);
> 32 |   await page.screenshot({ path: `../../docs/screenshots/${name}.png`, fullPage: false });
     |              ^ Error: page.screenshot: Test timeout of 60000ms exceeded.
  33 | }
  34 | 
```