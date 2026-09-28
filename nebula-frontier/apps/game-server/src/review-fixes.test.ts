/** Unit regression tests for CodeRabbit PR #2 round 1 findings (game-server, no DB). */
import { afterEach, describe, expect, it } from "vitest";
import { ARCHETYPES, decide, type BotMemory, type BotWorld, type EntityView } from "./bots/behaviors.js";
import { parseArgs } from "./bots/cli.js";
import { loadConfig } from "./config.js";
import { sanitizeChat } from "./protocol/messages.js";
import { applyOverrides, DEFAULT_RULES } from "./services/rules.js";

describe("#1 fighter bots attack before collecting", () => {
  it("chooses Attack when both an NPC and loot are nearby", () => {
    const e = (o: Partial<EntityView>): EntityView => ({ id: "x", kind: "NPC", x: 0, y: 0, hull: 10, maxHull: 10, shield: 10, maxShield: 10, dead: false, faction: "", team: 0, targetId: "", defId: "", ...o });
    const self = e({ id: "me", kind: "PLAYER", x: 100, y: 100, faction: "aurora" });
    const w: BotWorld = { self, entities: [self, e({ id: "npc", x: 110, y: 100 }), e({ id: "loot", kind: "LOOT", x: 101, y: 100 })], mapWidth: 600, mapHeight: 450, home: { x: 0, y: 0 }, now: 0 };
    const mem: BotMemory = { wanderTo: null, lastModuleAt: 0, rng: () => 0.5 };
    expect(decide(ARCHETYPES.fighter!, w, mem).targetId).toBe("npc");
  });
});

describe("#2 bots CLI flag validation", () => {
  it("accepts valid flags and defaults absent ones", () => {
    expect(parseArgs(["--", "--count", "12", "--type", "miner", "--duration", "30"])).toMatchObject({ count: 12, type: "miner", durationSec: 30, map: null });
    expect(parseArgs([]).count).toBe(10);
  });
  it.each([
    [["--count"]], [["--count", "--map", "map_aurora_prime"]], [["--count", "abc"]], [["--count", "0"]], [["--count", "501"]],
    [["--duration", "-1"]], [["--type", "wizard"]], [["--map", "map_gate_alpha"]], [["--url", "http://x"]], [["--bogus", "1"]], [["stray"]],
  ])("rejects %j", (argv) => {
    expect(() => parseArgs(argv)).toThrow();
  });
});

describe("#4 production requires REDIS_URL", () => {
  const saved = { NODE_ENV: process.env.NODE_ENV, REDIS_URL: process.env.REDIS_URL };
  afterEach(() => {
    process.env.NODE_ENV = saved.NODE_ENV;
    if (saved.REDIS_URL === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = saved.REDIS_URL;
  });
  it("fails fast in production without Redis, stays optional in development", () => {
    process.env.GAME_TICKET_SECRET ||= "x".repeat(40);
    delete process.env.REDIS_URL;
    process.env.NODE_ENV = "production";
    expect(() => loadConfig()).toThrow(/REDIS_URL/);
    process.env.NODE_ENV = "development";
    expect(loadConfig().redisUrl).toBeNull();
  });
});

describe("#9 chat strips invisible code points", () => {
  it("removes tag characters, soft hyphens, fillers and bidi overrides", () => {
    const tagged = `hi${String.fromCodePoint(0xe0041, 0xe0042)}­ㅤ‮ there\u{1d173}`;
    expect(sanitizeChat(tagged)).toBe("hi there");
    expect(sanitizeChat("ok 👍️")).toBe("ok 👍️");
  });
});

describe("#15 game.rules / game.tuning overrides are validated", () => {
  it("applies valid overrides and rejects invalid documents with a warning", () => {
    const ok = applyOverrides({ pickupRange: 20 }, { armorK: 300 });
    expect(ok.rules.pickupRange).toBe(20);
    expect(ok.tuning.armorK).toBe(300);
    expect(ok.warnings).toEqual([]);
    const bad = applyOverrides({ pickupRange: -5, bogus: 1 }, { armorK: "x" });
    expect(bad.rules).toEqual(DEFAULT_RULES);
    expect(bad.tuning.armorK).toBe(250);
    expect(bad.warnings).toHaveLength(2);
  });
});
