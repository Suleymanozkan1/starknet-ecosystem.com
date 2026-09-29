/** Unit regression tests for CodeRabbit PR #2 round 1 findings (game-server, no DB). */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ARCHETYPES, decide, type BotMemory, type BotWorld, type EntityView } from "./bots/behaviors.js";
import { deadlinePassed, parseArgs } from "./bots/cli.js";
import { loadConfig, MIN_METRICS_TOKEN_LENGTH, resolveApiInternalUrl, type GameServerConfig } from "./config.js";
import { createRoutes, metricsAccess } from "./http.js";
import { PingGuard, GALAXY_PING_LIMITS } from "./rooms/GalaxyRoom.js";
import type { GameServices } from "./services/context.js";
import { EventEngine, type PresenceLike } from "./services/events.js";
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
    [["--count", "1.5"]], [["--count", "1e2"]], [["--url", "ws://"]],
  ])("rejects %j", (argv) => {
    expect(() => parseArgs(argv)).toThrow();
  });
  it("keeps explicit unknown-flag / missing-operand errors and reports schema messages", () => {
    expect(() => parseArgs(["--bogus", "1"])).toThrow("Unknown flag --bogus");
    expect(() => parseArgs(["--count"])).toThrow("Flag --count requires a value");
    expect(() => parseArgs(["--count", "0"])).toThrow("--count must be an integer in 1..500");
    expect(parseArgs(["--url", "wss://game.example/ws", "--map", "map_aurora_prime"])).toMatchObject({ url: "wss://game.example/ws", map: "map_aurora_prime", durationSec: 0 });
  });
  it("stops launching bots once the run deadline has passed", () => {
    expect(deadlinePassed(0, 10_000)).toBe(false); // unlimited run
    expect(deadlinePassed(5_000, 4_999)).toBe(false);
    expect(deadlinePassed(5_000, 5_000)).toBe(true);
    expect(deadlinePassed(5_000, 49_900)).toBe(true); // e.g. bot #500 after its stagger on a 1s run
  });
});

describe("#4 production requires REDIS_URL", () => {
  const saved = { NODE_ENV: process.env.NODE_ENV, REDIS_URL: process.env.REDIS_URL, GAME_TICKET_SECRET: process.env.GAME_TICKET_SECRET };
  afterEach(() => {
    process.env.NODE_ENV = saved.NODE_ENV;
    if (saved.REDIS_URL === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = saved.REDIS_URL;
    if (saved.GAME_TICKET_SECRET === undefined) delete process.env.GAME_TICKET_SECRET;
    else process.env.GAME_TICKET_SECRET = saved.GAME_TICKET_SECRET;
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

describe("round 3: internal API URL requires TLS when the service token is set", () => {
  it("rejects remote plain http with a token, allows loopback / https / no token", () => {
    expect(() => resolveApiInternalUrl("http://api.internal:8080", "t".repeat(32))).toThrow(/https/);
    expect(() => resolveApiInternalUrl("http://10.0.0.5:8080/", "t".repeat(32))).toThrow(/https/);
    expect(() => resolveApiInternalUrl("ftp://api.internal", null)).toThrow();
    expect(resolveApiInternalUrl("https://api.internal:8443/", "t".repeat(32))).toBe("https://api.internal:8443");
    for (const u of ["http://localhost:8080", "http://127.0.0.1:9000", "http://[::1]:8080"]) expect(resolveApiInternalUrl(u, "t".repeat(32))).toBe(u);
    expect(resolveApiInternalUrl("http://api.internal:8080", null)).toBe("http://api.internal:8080");
    expect(resolveApiInternalUrl(undefined, "t".repeat(32))).toBe("http://localhost:8080");
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

describe("/metrics requires METRICS_TOKEN (public game port)", () => {
  const token = "m".repeat(MIN_METRICS_TOKEN_LENGTH);
  it("decides access: bearer token when configured, disabled in production without one", () => {
    expect(metricsAccess(`Bearer ${token}`, token)).toBe("allow");
    expect(metricsAccess(null, token)).toBe("unauthorized");
    expect(metricsAccess("Bearer wrong", token)).toBe("unauthorized");
    expect(metricsAccess(token, token)).toBe("unauthorized"); // missing Bearer scheme
    expect(metricsAccess(null, null)).toBe("disabled"); // fails closed in every environment
    expect(metricsAccess(`Bearer ${token}`, null)).toBe("disabled");
  });

  it("endpoint returns 401 / 404 / 200 accordingly", async () => {
    const svcFor = (cfg: Partial<GameServerConfig>) => () => ({ config: cfg as GameServerConfig }) as GameServices;
    const call = async (cfg: Partial<GameServerConfig>, auth?: string) => {
      const { metrics } = createRoutes(svcFor(cfg)).endpoints;
      const res: unknown = await metrics({ headers: auth ? { authorization: auth } : {}, asResponse: true });
      return (res as Response).status;
    };
    expect(await call({ metricsToken: token, nodeEnv: "production" })).toBe(401);
    expect(await call({ metricsToken: token, nodeEnv: "production" }, "Bearer nope")).toBe(401);
    expect(await call({ metricsToken: token, nodeEnv: "production" }, `Bearer ${token}`)).toBe(200);
    expect(await call({ metricsToken: null, nodeEnv: "production" }, `Bearer ${token}`)).toBe(404);
    expect(await call({ metricsToken: null, nodeEnv: "development" })).toBe(404);
  });

  describe("config validation", () => {
    const keys = ["NODE_ENV", "REDIS_URL", "METRICS_TOKEN", "GAME_TICKET_SECRET"] as const;
    const saved = new Map(keys.map((k) => [k, process.env[k]] as const));
    afterEach(() => {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
    it("production requires a METRICS_TOKEN of at least 32 characters; optional in development", () => {
      process.env.GAME_TICKET_SECRET ||= "x".repeat(40);
      process.env.REDIS_URL = "redis://localhost:6379";
      process.env.NODE_ENV = "production";
      delete process.env.METRICS_TOKEN;
      expect(() => loadConfig()).toThrow(/METRICS_TOKEN/);
      process.env.METRICS_TOKEN = "short";
      expect(() => loadConfig()).toThrow(/METRICS_TOKEN/);
      process.env.METRICS_TOKEN = ` ${" ".repeat(MIN_METRICS_TOKEN_LENGTH)} `;
      expect(() => loadConfig()).toThrow(/METRICS_TOKEN/);
      process.env.METRICS_TOKEN = token;
      expect(loadConfig().metricsToken).toBe(token);
      process.env.NODE_ENV = "development";
      delete process.env.METRICS_TOKEN;
      expect(loadConfig().metricsToken).toBeNull();
    });
  });
});

describe("galaxy ping rate limit", () => {
  it("allows the burst, drops excess, and disconnects after repeated spam", () => {
    const g = new PingGuard(0);
    for (let i = 0; i < GALAXY_PING_LIMITS.burst; i++) expect(g.check(0)).toBe("allow");
    expect(g.check(0)).toBe("drop");
    const verdicts: string[] = [];
    // One drop already happened above; the (maxDrops × maxStrikes)-th drop triggers the disconnect.
    for (let i = 1; i < GALAXY_PING_LIMITS.maxDropsPerWindow * GALAXY_PING_LIMITS.maxStrikes; i++) verdicts.push(g.check(0));
    expect(verdicts.at(-1)).toBe("disconnect");
    expect(verdicts.slice(0, -1).every((v) => v === "drop")).toBe(true);
  });
  it("refills over time for well-behaved clients", () => {
    const g = new PingGuard(0);
    for (let i = 0; i < 100; i++) expect(g.check(i * 1000)).toBe("allow");
  });
});

describe("event engine surfaces trigger-subscription failures", () => {
  it("emits subscribeError and calls onError instead of an unhandled rejection", async () => {
    const failure = new Error("presence down");
    const presence: PresenceLike = { subscribe: () => Promise.reject(failure), unsubscribe: () => undefined, publish: () => undefined };
    const engine = new EventEngine();
    const onError = vi.fn();
    const emitted = vi.fn();
    engine.on("subscribeError", emitted);
    engine.start(presence, 60_000, onError);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(failure));
    expect(emitted).toHaveBeenCalledWith(failure);
    engine.stop();
  });
  it("also catches a synchronous subscribe throw", async () => {
    const presence: PresenceLike = { subscribe: () => { throw new Error("sync"); }, unsubscribe: () => undefined, publish: () => undefined };
    const engine = new EventEngine();
    const onError = vi.fn();
    engine.start(presence, 60_000, onError);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    engine.stop();
  });
});
