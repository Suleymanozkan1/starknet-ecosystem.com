import { expect, test } from "@playwright/test";
import { apiUp, registerThroughUi, shot } from "./helpers.js";

test.describe("web · desktop", () => {
  test("landing shows hero, factions and CTAs", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /nebula\s*frontier/i })).toBeVisible();
    await expect(page.getByText("AURORA INDUSTRIES").first()).toBeVisible();
    await expect(page.getByText("VORTEX CONSORTIUM").first()).toBeVisible();
    await expect(page.getByText("NOVA DYNASTY").first()).toBeVisible();
    // Investment wording must never appear in player UI.
    const body = (await page.locator("body").innerText()).toLowerCase();
    for (const banned of ["apy", "interest rate", "passive income", "guaranteed return", "daily profit"]) expect(body).not.toContain(banned);
    await shot(page, "desktop-landing");
  });

  test("auth page offers wallet and email sign-in", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByTestId("wallet-signin")).toBeVisible();
    await page.getByRole("tab", { name: "Email" }).click();
    await expect(page.locator('input[name="email"]')).toBeVisible();
    await shot(page, "desktop-login");
  });

  test("protected routes redirect to login", async ({ page }) => {
    await page.goto("/hangar");
    await page.waitForURL(/\/login\?next=%2Fhangar/);
  });

  test("full onboarding → dashboard → hangar → wallet (needs API)", async ({ page, request }) => {
    test.skip(!(await apiUp(request)), "API not reachable — skipping authenticated flow");
    test.setTimeout(240_000);
    await registerThroughUi(page);
    await expect(page.getByTestId("faction-aurora")).toBeVisible();
    await page.getByTestId("faction-aurora").click();
    await shot(page, "desktop-faction-select");
    await page.getByTestId("faction-confirm").click();
    await page.getByTestId("faction-pledge").click();
    await page.waitForURL(/\/onboarding\/ship/);
    await expect(page.getByText("Lumen").first()).toBeVisible();
    await shot(page, "desktop-starter-ship");
    await page.getByRole("button", { name: /command deck/i }).click();
    await page.waitForURL(/\/home/);
    await expect(page.getByTestId("play-hero")).toBeVisible();
    await shot(page, "desktop-home");
    await page.getByRole("link", { name: /^hangar$/i }).first().click();
    await expect(page.getByText(/Lasers/i).first()).toBeVisible();
    await shot(page, "desktop-hangar");
    await page.goto("/wallet");
    await expect(page.getByText(/Withdraw/i).first()).toBeVisible();
    await expect(page.getByText("Final amount")).toBeVisible();
    await shot(page, "desktop-wallet");
  });
});
