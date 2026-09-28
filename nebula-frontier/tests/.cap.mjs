import { chromium } from "@playwright/test";
const out = process.argv[2]; const mode = process.argv[3] ?? "desktop"; const pages = (process.argv[4] ?? "/home").split(",");
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", proxy: { server: process.env.HTTPS_PROXY, bypass: "localhost,127.0.0.1" }, args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, ...(mode === "mobile" ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width: 1440, height: 900 } }) });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));
page.on("console", (m) => { if (m.type() === "error" && !/401|403|CERT/.test(m.text())) console.log("err", m.text().slice(0, 200)); });
const acct = process.env.CAP_USER ?? "capture_pilot";
await page.goto("http://localhost:5173/login");
await page.getByRole("tab", { name: "Email" }).click();
await page.locator('input[name="email"]').fill(acct + "@example.test");
await page.locator('input[name="password"]').fill("Frontier-Test-2026");
await page.getByTestId("email-submit").click();
await page.waitForTimeout(3000);
if (page.url().includes("/login")) {
  await page.goto("http://localhost:5173/register");
  await page.getByRole("tab", { name: "Email" }).click();
  await page.locator('input[name="username"]').fill(acct);
  await page.locator('input[name="email"]').fill(acct + "@example.test");
  await page.locator('input[name="password"]').fill("Frontier-Test-2026");
  await page.getByTestId("email-submit").click();
  await page.waitForURL(/onboarding\/faction/);
}
if (page.url().includes("onboarding/faction")) {
  await page.getByTestId("faction-aurora").click();
  await page.getByTestId("faction-confirm").click();
  await page.getByTestId("faction-pledge").click();
  await page.waitForURL(/onboarding\/ship/);
}
for (const p of pages) {
  await page.goto("http://localhost:5173" + p);
  await page.waitForTimeout(p === "/home" || p === "/hangar" ? 15000 : 5000);
  const name = p.replace(/\W+/g, "_");
  await page.screenshot({ path: `${out}/${mode}${name}.png`, timeout: 60000 });
  console.log("shot", p);
}
await browser.close();
