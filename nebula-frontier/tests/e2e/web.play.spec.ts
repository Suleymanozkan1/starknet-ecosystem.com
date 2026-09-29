import { expect, test, type Page } from "@playwright/test";
import { apiUp, registerThroughUi, shot } from "./helpers.js";

/** Onboards a fresh pilot through the UI and opens the Play screen (real API ticket → real game server). */
async function enterGame(page: Page): Promise<void> {
  await registerThroughUi(page);
  await page.getByTestId("faction-aurora").click();
  await page.getByTestId("faction-confirm").click();
  await page.getByTestId("faction-pledge").click();
  await page.waitForURL(/\/onboarding\/ship/);
  await page.getByRole("button", { name: /command deck/i }).click();
  await page.waitForURL(/\/home/);
  await page.goto("/play");
  // The HUD only mounts once createGame() resolved: ticket issued, room joined, first state received.
  await expect(page.locator(".nf-hud")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText(/launch aborted/i)).toHaveCount(0);
  await expect(page.locator("canvas").first()).toBeVisible();
}

test.describe("play · real game session", () => {
  test("desktop: joins the galaxy, renders the world + HUD, keyboard input moves the ship", async ({ page, request }, info) => {
    test.skip(info.project.name !== "desktop", "desktop only");
    test.skip(!(await apiUp(request)), "API not reachable");
    test.setTimeout(240_000);
    await enterGame(page);
    // The Phaser radar/HUD overlay sits above the WebGL canvas; focus the page with a raw click.
    await page.mouse.click(720, 450);
    await page.keyboard.down("KeyW");
    // While thrusting, the (server-reconciled) speed shown in the HUD must rise above zero.
    await expect.poll(async () => Number(/SPEED\s+([\d.]+)/i.exec(await page.locator(".nf-hud").innerText())?.[1] ?? 0), { timeout: 15_000 }).toBeGreaterThan(0);
    await shot(page, "desktop-play-thrust");
    await page.keyboard.up("KeyW");
    await expect(page.locator(".nf-hud")).toContainText(/aurora prime/i);
    await shot(page, "desktop-play");
  });

  test("mobile: touch HUD with joystick and combat buttons", async ({ page, request }, info) => {
    test.skip(info.project.name !== "mobile", "mobile only");
    test.skip(!(await apiUp(request)), "API not reachable");
    test.setTimeout(240_000);
    await enterGame(page);
    await expect(page.getByRole("button", { name: /fire/i }).first()).toBeVisible();
    await shot(page, "mobile-play");
  });
});
