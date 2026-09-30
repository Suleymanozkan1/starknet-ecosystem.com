import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * HANGAR-01 — 3D hangar interaction against the static demo build (in-browser mock API, WebGL via SwiftShader):
 * canvas renders, drag rotates, wheel zooms, engine/fire/shield/damage previews change the image,
 * ship selection, equip/unequip, compare, customize and upgrade.
 */

/**
 * Minimum share of pixels outside the idle envelope for a preview to count as visible (~8 px of the 128×80
 * sample). Measured under SwiftShader: idle 0, engines ≈0.002, fire ≈0.004, shield/damage ≈0.012.
 */
const PREVIEW_NOVELTY = 0.0008;

const FACTION_BUTTONS = '[data-testid^="faction-"]:not([data-testid="faction-confirm"]):not([data-testid="faction-pledge"])';

/** Downscaled RGBA+alpha luminance of the viewer canvas (preserveDrawingBuffer keeps the last frame readable). */
async function sample(canvas: Locator): Promise<number[]> {
  return canvas.evaluate((el) => {
    if (!(el instanceof HTMLCanvasElement)) throw new Error("viewer is not a canvas");
    const w = 128;
    const h = 80;
    const off = document.createElement("canvas");
    off.width = w;
    off.height = h;
    const ctx = off.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("2d context unavailable");
    ctx.drawImage(el, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    const out: number[] = [];
    for (let i = 0; i < d.length; i += 4) out.push((d[i] ?? 0) + (d[i + 1] ?? 0) + (d[i + 2] ?? 0) + (d[i + 3] ?? 0));
    return out;
  });
}

/** Mean absolute difference between two samples, normalised to [0, 1]. */
function diff(a: readonly number[], b: readonly number[]): number {
  expect(a.length).toBe(b.length);
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  return sum / (a.length * 1020);
}

/** Share of pixels that are not fully transparent black, and the number of distinct values. */
function coverage(s: readonly number[]): { lit: number; distinct: number } {
  return { lit: s.filter((v) => v > 0).length / s.length, distinct: new Set(s).size };
}

interface Envelope {
  min: number[];
  max: number[];
}

/**
 * Per-pixel [min, max] over idle frames spanning a full bob cycle of the ship (≈5 s): anything outside this
 * envelope was drawn by something other than the idle animation.
 */
async function idleEnvelope(page: Page, canvas: Locator, frames = 14, everyMs = 420): Promise<Envelope> {
  const first = await sample(canvas);
  const min = [...first];
  const max = [...first];
  for (let f = 1; f < frames; f++) {
    await page.waitForTimeout(everyMs);
    const s = await sample(canvas);
    for (let i = 0; i < s.length; i++) {
      const v = s[i] ?? 0;
      if (v < (min[i] ?? v)) min[i] = v;
      if (v > (max[i] ?? v)) max[i] = v;
    }
  }
  return { min, max };
}

/** Share of pixels outside the idle envelope (with a small tolerance for rasterisation jitter). */
function novelty(env: Envelope, s: readonly number[], tolerance = 40): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const v = s[i] ?? 0;
    if (v < (env.min[i] ?? 0) - tolerance || v > (env.max[i] ?? 0) + tolerance) n++;
  }
  return n / s.length;
}

async function settle(page: Page, ms = 700): Promise<void> {
  await page.waitForTimeout(ms);
}

/** Frame-to-frame noise with no interaction (the ship bobs slightly on its platform). */
async function idleNoise(page: Page, canvas: Locator): Promise<number> {
  const a = await sample(canvas);
  await settle(page, 400);
  const b = await sample(canvas);
  return diff(a, b);
}

async function createDemoPilot(page: Page): Promise<void> {
  await page.goto("/register");
  await page.getByTestId("demo-start").click();
  await page.waitForURL(/\/onboarding\/faction/);
  await page.locator(FACTION_BUTTONS).first().click();
  await page.getByTestId("faction-confirm").click();
  await page.getByTestId("faction-pledge").click();
  await page.waitForURL(/\/onboarding\/ship/);
  await page.getByRole("button", { name: /command deck/i }).click();
  await page.waitForURL(/\/home/);
}

test.describe("hangar · 3D viewer interaction (demo build)", () => {
  test("renders, rotates, zooms, previews effects, selects/equips/compares ships", async ({ page }) => {
    test.setTimeout(360_000);
    const pageErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));

    await createDemoPilot(page);
    await page.goto("/hangar");
    const canvas = page.getByTestId("ship-viewer-canvas");
    await expect(canvas).toHaveAttribute("data-ready", "true", { timeout: 120_000 });
    await expect(page.getByText(/3D hangar unavailable/i)).toHaveCount(0);

    // Stop the turntable so every image change below comes from the interaction under test.
    const autoRotate = page.getByTestId("hangar-autorotate");
    await expect(autoRotate).toHaveAttribute("aria-pressed", "true");
    await autoRotate.click();
    await expect(autoRotate).toHaveAttribute("aria-pressed", "false");
    await settle(page, 1200);

    await test.step("WebGL canvas renders a non-empty image", async () => {
      const s = await sample(canvas);
      const c = coverage(s);
      expect(c.lit).toBeGreaterThan(0.2);
      expect(c.distinct).toBeGreaterThan(50);
    });

    const noise = await idleNoise(page, canvas);
    const threshold = Math.max(noise * 3, 0.002);

    const box = await canvas.boundingBox();
    if (!box) throw new Error("viewer canvas has no box");
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    await test.step("drag rotates the camera", async () => {
      const before = await sample(canvas);
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      for (let i = 1; i <= 10; i++) await page.mouse.move(cx + i * 25, cy + i * 3);
      await page.mouse.up();
      await settle(page, 900);
      expect(diff(before, await sample(canvas))).toBeGreaterThan(threshold);
    });

    await test.step("wheel zooms the camera", async () => {
      const before = await sample(canvas);
      await page.mouse.move(cx, cy);
      for (let i = 0; i < 6; i++) {
        await page.mouse.wheel(0, -240);
        await page.waitForTimeout(60);
      }
      await settle(page, 900);
      const zoomedIn = await sample(canvas);
      expect(diff(before, zoomedIn)).toBeGreaterThan(threshold);
      for (let i = 0; i < 12; i++) {
        await page.mouse.wheel(0, 240);
        await page.waitForTimeout(60);
      }
      await settle(page, 900);
      expect(diff(zoomedIn, await sample(canvas))).toBeGreaterThan(threshold);
    });

    await test.step("engine / fire / shield / damage previews change the image", async () => {
      const idle = page.getByTestId("hangar-preview-idle");
      await idle.click();
      await expect(idle).toHaveAttribute("aria-pressed", "true");
      await settle(page, 1500);
      const env = await idleEnvelope(page, canvas);
      // Sanity: a fresh idle frame stays inside the envelope.
      expect(novelty(env, await sample(canvas))).toBeLessThan(PREVIEW_NOVELTY / 2);
      for (const mode of ["engine", "fire", "shield", "damage"] as const) {
        await idle.click();
        await expect(idle).toHaveAttribute("aria-pressed", "true");
        await settle(page, 3500);
        const button = page.getByTestId(`hangar-preview-${mode}`);
        await button.click();
        await expect(button).toHaveAttribute("aria-pressed", "true");
        await expect(idle).toHaveAttribute("aria-pressed", "false");
        // Effects animate: poll until the preview draws pixels the idle animation never produces.
        await expect.poll(async () => novelty(env, await sample(canvas)), { timeout: 10_000, message: `${mode} preview` }).toBeGreaterThan(PREVIEW_NOVELTY);
      }
      await idle.click();
    });

    await test.step("selects another ship", async () => {
      const ships = page.getByTestId("hangar-ship");
      expect(await ships.count()).toBeGreaterThan(1);
      const title = page.locator("h1").first();
      const titleBefore = await title.innerText();
      const before = await sample(canvas);
      const other = page.locator('[data-testid="hangar-ship"][aria-pressed="false"]').first();
      const otherDef = await other.getAttribute("data-ship-def");
      await other.click();
      await expect(page.locator(`[data-testid="hangar-ship"][data-ship-def="${otherDef}"]`)).toHaveAttribute("aria-pressed", "true");
      await expect(title).not.toHaveText(titleBefore);
      await expect.poll(async () => diff(before, await sample(canvas)), { timeout: 10_000 }).toBeGreaterThan(threshold);
    });

    await test.step("unequips and re-equips an item", async () => {
      // Tester-kit ships arrive fully fitted: free a weapon slot, then fit an item into it again.
      const filled = page.locator('[data-testid^="slot-weapons-"][data-filled="true"]').first();
      const slotId = await filled.getAttribute("data-testid");
      if (!slotId) throw new Error("no fitted weapon slot");
      const slot = page.getByTestId(slotId);
      const dialog = page.locator('[role="dialog"][aria-modal="true"]');
      await slot.click();
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: /^unequip$/i }).click();
      await expect(dialog).toBeHidden();
      await expect(slot).toHaveAttribute("data-filled", "false");
      await slot.click();
      await expect(dialog).toBeVisible();
      await dialog.getByTestId("item-tile").first().click();
      await expect(dialog).toBeHidden();
      await expect(slot).toHaveAttribute("data-filled", "true");
    });

    await test.step("customizes the ship with a cosmetic", async () => {
      await page.getByRole("tab", { name: /customize/i }).click();
      const selects = page.locator("select.nf-input:not([disabled])");
      await expect(selects.first()).toBeVisible();
      const count = await selects.count();
      let applied = false;
      for (let i = 0; i < count && !applied; i++) {
        const sel = selects.nth(i);
        const values = await sel.locator("option").evaluateAll((opts) => opts.map((o) => (o instanceof HTMLOptionElement ? o.value : "")).filter(Boolean));
        const value = values[0];
        if (!value) continue;
        await sel.selectOption(value);
        applied = true;
      }
      expect(applied).toBe(true);
      await expect(page.getByText("Cosmetic applied").first()).toBeVisible();
    });

    await test.step("compares with another ship side by side", async () => {
      await page.getByRole("tab", { name: /compare/i }).click();
      const select = page.getByTestId("hangar-compare-select");
      const value = await select.locator("option").nth(1).getAttribute("value");
      if (!value) throw new Error("no ship to compare with");
      await settle(page, 600);
      const before = await sample(canvas);
      await select.selectOption(value);
      await expect(page.getByText(/bars show/i)).toBeVisible();
      await expect.poll(async () => diff(before, await sample(canvas)), { timeout: 10_000 }).toBeGreaterThan(threshold);
    });

    await test.step("upgrades the ship", async () => {
      await page.getByTestId("hangar-upgrade").click();
      const dialog = page.locator('[role="dialog"][aria-modal="true"]');
      const attempt = dialog.getByRole("button", { name: /attempt upgrade/i });
      await expect(attempt).toBeEnabled();
      await attempt.click();
      await expect(dialog).toBeHidden();
      await expect(page.getByText(/upgrade successful|upgrade failed/i).first()).toBeVisible();
    });

    expect(pageErrors).toEqual([]);
  });
});
