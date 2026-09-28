// Runs `cap sync` when the web bundle exists. In a full monorepo build the web app may not be built yet
// (no workspace dependency edge), so a missing bundle is reported instead of failing the whole build.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

if (!existsSync(new URL("../../web/dist/index.html", import.meta.url))) {
  console.warn("[mobile] apps/web/dist missing — run `pnpm --filter @nebula/web build` then `pnpm --filter @nebula/mobile sync`.");
  process.exit(0);
}
const r = spawnSync("npx", ["cap", "sync", ...process.argv.slice(2)], { stdio: "inherit", shell: process.platform === "win32" });
process.exit(r.status ?? 1);
