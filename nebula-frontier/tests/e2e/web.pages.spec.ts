import { expect, test, type Page } from "@playwright/test";
import { apiUp, registerThroughUi } from "./helpers.js";

/**
 * Every player screen, authenticated, against the real API: each page must render its content
 * without an error boundary ("This panel failed to load") or a failed API query ("Transmission
 * failed" / "Service not available").
 */
const PAGES: { path: string; expect: RegExp }[] = [
  { path: "/home", expect: /play/i },
  { path: "/galaxy", expect: /helios|sector/i },
  { path: "/hangar", expect: /lasers/i },
  { path: "/inventory", expect: /inventory/i },
  { path: "/ships", expect: /ships|lumen/i },
  { path: "/weapons", expect: /weapons|laser/i },
  { path: "/modules", expect: /modules|shield/i },
  { path: "/drones", expect: /drones/i },
  { path: "/missions", expect: /missions|first light/i },
  { path: "/crafting", expect: /crafting|blueprint/i },
  { path: "/clan", expect: /clan/i },
  { path: "/market", expect: /market/i },
  { path: "/auction", expect: /auction/i },
  { path: "/leaderboard", expect: /leaderboard/i },
  { path: "/season", expect: /season/i },
  { path: "/battle-pass", expect: /battle pass|tier/i },
  { path: "/events", expect: /events|rift/i },
  { path: "/shop", expect: /shop/i },
  { path: "/wallet", expect: /withdraw/i },
  { path: "/profile", expect: /profile|level/i },
  { path: "/friends", expect: /friends|squad/i },
  { path: "/notifications", expect: /notifications/i },
  { path: "/mail", expect: /mail/i },
  { path: "/settings", expect: /graphics|settings/i },
];

async function onboard(page: Page): Promise<void> {
  await registerThroughUi(page);
  await page.getByTestId("faction-aurora").click();
  await page.getByTestId("faction-confirm").click();
  await page.getByTestId("faction-pledge").click();
  await page.waitForURL(/\/onboarding\/ship/);
  await page.getByRole("button", { name: /command deck/i }).click();
  await page.waitForURL(/\/home/);
}

async function assertHealthy(page: Page, re: RegExp): Promise<void> {
  await expect(page.locator("body")).toContainText(re, { timeout: 30_000 });
  // Let queries settle, then make sure none of them failed.
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await expect(page.getByText("This panel failed to load")).toHaveCount(0);
  await expect(page.getByText(/transmission failed|service not available/i)).toHaveCount(0);
}

test.describe("web · every player screen (authenticated, real API)", () => {
  test("desktop: all routes render without errors; language switches to Türkçe", async ({ page, request }, info) => {
    test.skip(info.project.name !== "desktop", "desktop only");
    test.skip(!(await apiUp(request)), "API not reachable");
    test.setTimeout(420_000);
    await onboard(page);
    for (const p of PAGES) {
      await test.step(p.path, async () => {
        await page.goto(p.path);
        await assertHealthy(page, p.expect);
      });
    }
    // i18n: switch to Turkish in Settings and see translated navigation.
    await page.goto("/settings");
    await page.getByRole("button", { name: "Türkçe" }).click();
    await expect(page.getByText("Envanter").first()).toBeVisible();
    await page.getByRole("button", { name: "English" }).click();
  });

  test("mobile: bottom navigation reaches Home/Hangar/Galaxy/Clan/Shop/Wallet", async ({ page, request }, info) => {
    test.skip(info.project.name !== "mobile", "mobile only");
    test.skip(!(await apiUp(request)), "API not reachable");
    test.setTimeout(300_000);
    await onboard(page);
    for (const [label, path, re] of [["Hangar", "/hangar", /lasers/i], ["Galaxy", "/galaxy", /sector|helios/i], ["Clan", "/clan", /clan/i], ["Shop", "/shop", /shop/i], ["Wallet", "/wallet", /withdraw/i], ["Home", "/home", /play/i]] as const) {
      await page.getByRole("link", { name: label, exact: true }).last().click();
      await page.waitForURL(new RegExp(path));
      await assertHealthy(page, re);
    }
  });
});
