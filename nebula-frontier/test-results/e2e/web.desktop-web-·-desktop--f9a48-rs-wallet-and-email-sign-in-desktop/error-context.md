# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: web.desktop.spec.ts >> web · desktop >> auth page offers wallet and email sign-in
- Location: e2e/web.desktop.spec.ts:17:3

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByTestId('wallet-signin')
Expected: visible
Timeout: 10000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" getByTestId('wallet-signin') with timeout 10000ms
  - waiting for getByTestId('wallet-signin')

```

```yaml
- text: INITIALIZING
```

# Test source

```ts
  1  | import { expect, test } from "@playwright/test";
  2  | import { apiUp, registerThroughUi, shot } from "./helpers.js";
  3  | 
  4  | test.describe("web · desktop", () => {
  5  |   test("landing shows hero, factions and CTAs", async ({ page }) => {
  6  |     await page.goto("/");
  7  |     await expect(page.getByRole("heading", { name: /nebula\s*frontier/i })).toBeVisible();
  8  |     await expect(page.getByText("AURORA INDUSTRIES").first()).toBeVisible();
  9  |     await expect(page.getByText("VORTEX CONSORTIUM").first()).toBeVisible();
  10 |     await expect(page.getByText("NOVA DYNASTY").first()).toBeVisible();
  11 |     // Investment wording must never appear in player UI.
  12 |     const body = (await page.locator("body").innerText()).toLowerCase();
  13 |     for (const banned of ["apy", "interest rate", "passive income", "guaranteed return", "daily profit"]) expect(body).not.toContain(banned);
  14 |     await shot(page, "desktop-landing");
  15 |   });
  16 | 
  17 |   test("auth page offers wallet and email sign-in", async ({ page }) => {
  18 |     await page.goto("/login");
> 19 |     await expect(page.getByTestId("wallet-signin")).toBeVisible();
     |                                                     ^ Error: expect(locator).toBeVisible() failed
  20 |     await page.getByRole("tab", { name: "Email" }).click();
  21 |     await expect(page.locator('input[name="email"]')).toBeVisible();
  22 |     await shot(page, "desktop-login");
  23 |   });
  24 | 
  25 |   test("protected routes redirect to login", async ({ page }) => {
  26 |     await page.goto("/hangar");
  27 |     await page.waitForURL(/\/login\?next=%2Fhangar/);
  28 |   });
  29 | 
  30 |   test("full onboarding → dashboard → hangar → wallet (needs API)", async ({ page, request }) => {
  31 |     test.skip(!(await apiUp(request)), "API not reachable — skipping authenticated flow");
  32 |     await registerThroughUi(page);
  33 |     await expect(page.getByTestId("faction-aurora")).toBeVisible();
  34 |     await page.getByTestId("faction-aurora").click();
  35 |     await shot(page, "desktop-faction-select");
  36 |     await page.getByTestId("faction-confirm").click();
  37 |     await page.getByTestId("faction-pledge").click();
  38 |     await page.waitForURL(/\/onboarding\/ship/);
  39 |     await expect(page.getByText("Lumen").first()).toBeVisible();
  40 |     await shot(page, "desktop-starter-ship");
  41 |     await page.getByRole("button", { name: /command deck/i }).click();
  42 |     await page.waitForURL(/\/home/);
  43 |     await expect(page.getByTestId("play-hero")).toBeVisible();
  44 |     await shot(page, "desktop-home");
  45 |     await page.getByRole("link", { name: /^hangar$/i }).first().click();
  46 |     await expect(page.getByText(/Lasers/i).first()).toBeVisible();
  47 |     await shot(page, "desktop-hangar");
  48 |     await page.goto("/wallet");
  49 |     await expect(page.getByText(/Withdraw/i).first()).toBeVisible();
  50 |     await expect(page.getByText("Final amount")).toBeVisible();
  51 |     await shot(page, "desktop-wallet");
  52 |   });
  53 | });
  54 | 
```