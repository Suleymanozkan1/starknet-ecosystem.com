/** devnet-setup helpers: the shared .env is kept 0600 and never keeps the treasury secret. */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { upsertEnv } from "../scripts/devnet-setup.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("upsertEnv", () => {
  it("forces mode 0600 on an existing world-readable .env and upserts keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "nf-env-"));
    dirs.push(dir);
    const file = join(dir, ".env");
    writeFileSync(file, "FOO=1\nTREASURY_PUBLIC_KEY=old\n", { mode: 0o644 });
    upsertEnv({ TREASURY_PUBLIC_KEY: "new", BAR: "2" }, file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toBe("FOO=1\nTREASURY_PUBLIC_KEY=new\nBAR=2\n");
  });

  it("removes keys set to null (drops a legacy TREASURY_SECRET from the shared .env)", () => {
    const dir = mkdtempSync(join(tmpdir(), "nf-env-"));
    dirs.push(dir);
    const file = join(dir, ".env");
    writeFileSync(file, "TREASURY_PUBLIC_KEY=pk\nTREASURY_SECRET=[1,2,3]\nFOO=1\n");
    upsertEnv({ TREASURY_SECRET_FILE: "/abs/treasury.json", TREASURY_SECRET: null }, file);
    const out = readFileSync(file, "utf8");
    expect(out).not.toContain("TREASURY_SECRET=");
    expect(out).toBe("TREASURY_PUBLIC_KEY=pk\nFOO=1\nTREASURY_SECRET_FILE=/abs/treasury.json\n");
  });
});
