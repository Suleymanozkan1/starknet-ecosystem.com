/**
 * Brief §94 / CLAUDE.md economy rule: the player UI must never present rewards as an investment.
 * Scans every player-facing source file (web app, game client, shared UI kit, game data shown to
 * players) for investment wording. Admin/owner tooling and docs are out of scope.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const SCOPES = ["apps/web/src", "apps/game-client/src", "packages/game-ui/src", "packages/config/data"];
const BANNED = [
  /\bAPY\b/,
  /\bAPR\b/,
  /\binterest rate\b/i,
  /\bguaranteed (return|profit|income)\b/i,
  /\bpassive income\b/i,
  /\bdaily profit\b/i,
  /\binvestment return\b/i,
  /\breturn on investment\b/i,
  /\bROI\b/,
];

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(tsx?|json|html|css)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe("player-facing terminology", () => {
  it("never uses investment / guaranteed-return wording", () => {
    const hits: string[] = [];
    for (const scope of SCOPES) {
      for (const f of files(join(ROOT, scope))) {
        const text = readFileSync(f, "utf8");
        for (const re of BANNED) {
          const m = re.exec(text);
          if (m) hits.push(`${f.replace(ROOT + "/", "")}: "${m[0]}"`);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});
