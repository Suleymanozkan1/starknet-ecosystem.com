import { expect, test } from "@playwright/test";
import { apiUp, registerThroughUi, shot } from "./helpers.js";

test.describe("web · mobile (touch)", () => {
  test("landing is touch-friendly and fits the viewport", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("cta-enter")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await shot(page, "mobile-landing");
  });

  test("login renders on small screens", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByTestId("wallet-signin")).toBeVisible();
    await shot(page, "mobile-login");
  });

  test("onboarding + bottom navigation (needs API)", async ({ page, request }) => {
    test.skip(!(await apiUp(request)), "API not reachable — skipping authenticated flow");
    await registerThroughUi(page);
    await page.getByTestId("faction-nova").tap();
    await shot(page, "mobile-faction-select");
    await page.getByTestId("faction-confirm").tap();
    await page.getByTestId("faction-pledge").tap();
    await page.waitForURL(/\/onboarding\/ship/);
    await page.getByRole("button", { name: /command deck/i }).tap();
    await page.waitForURL(/\/home/);
    const nav = page.getByRole("navigation", { name: "Primary" });
    await expect(nav).toBeVisible();
    for (const label of ["Home", "Hangar", "Galaxy", "Clan", "Shop", "Wallet"]) await expect(nav.getByText(label)).toBeVisible();
    await shot(page, "mobile-home");
    await nav.getByText("Hangar").tap();
    await page.waitForURL(/\/hangar/);
    await shot(page, "mobile-hangar");
    await nav.getByText("Wallet").tap();
    await page.waitForURL(/\/wallet/);
    await shot(page, "mobile-wallet");
  });
});
