import { expect, test } from "@playwright/test";
import { apiUp, shot } from "./helpers.js";

/**
 * Admin console against the real API with the seeded SUPER_ADMIN (prisma/seed.ts dev defaults).
 * Every section must load its data without "Request failed" / "Insufficient role".
 */
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@nebula.local";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "change-me-dev-only";

const SECTIONS: { path: string; expect: RegExp; shot?: string }[] = [
  { path: "/", expect: /online|rooms/i, shot: "admin-overview" },
  { path: "/economy", expect: /treasury health/i, shot: "admin-economy" },
  { path: "/profitability", expect: /ARPPU|revenue/i, shot: "admin-profitability" },
  { path: "/withdrawals", expect: /withdrawal/i },
  { path: "/rewards", expect: /reward/i },
  { path: "/treasury", expect: /treasury/i },
  { path: "/users", expect: /users|search/i },
  { path: "/risk", expect: /risk|suspicious/i },
  { path: "/reports", expect: /report/i },
  { path: "/mail", expect: /mail|compensation/i },
  { path: "/shop", expect: /shop|product/i },
  { path: "/events", expect: /event/i },
  { path: "/catalog", expect: /catalog|ship/i },
  { path: "/world", expect: /map|season/i },
  { path: "/trade", expect: /market|clan/i },
  { path: "/rules", expect: /rules|flag/i },
  { path: "/audit", expect: /audit/i },
];

test("admin: SUPER_ADMIN signs in and every section loads real data", async ({ page, request }) => {
  test.skip(!(await apiUp(request)), "API not reachable");
  test.setTimeout(300_000);
  await page.goto("/");
  await page.locator('input[type="email"]').fill(ADMIN_EMAIL);
  await page.locator('input[type="password"]').fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  // Wait for the session cookie + role-aware shell before navigating.
  await expect(page.getByRole("link", { name: "Economy" })).toBeVisible({ timeout: 30_000 });
  for (const s of SECTIONS) {
    await test.step(s.path, async () => {
      await page.goto(s.path);
      await expect(page.locator("body")).toContainText(s.expect, { timeout: 30_000 });
      await page.waitForLoadState("networkidle").catch(() => undefined);
      await expect(page.getByText(/request failed|insufficient role/i)).toHaveCount(0);
      if (s.shot) await shot(page, s.shot);
    });
  }
});
