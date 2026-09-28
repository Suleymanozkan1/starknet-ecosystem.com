import { describe, expect, it } from "vitest";
import { createLogger } from "@nebula/telemetry";
import { Writable } from "node:stream";
import { ClanMissionReporter } from "./clan-missions.js";

const log = createLogger({ name: "test", level: "silent", destination: new Writable({ write(_c, _e, cb) { cb(); } }) });

describe("ClanMissionReporter", () => {
  it("aggregates quantity events, skips non-members, batches and retries transient failures", async () => {
    const calls: { url: string; token: string; events: unknown[] }[] = [];
    let fail = 1;
    const r = new ClanMissionReporter({
      baseUrl: "http://api.test", token: "tok", log, maxAttempts: 3,
      fetchImpl: async (url, init) => {
        if (fail-- > 0) return { ok: false, status: 503 };
        calls.push({ url, token: init.headers["x-internal-token"] ?? "", events: (JSON.parse(init.body) as { events: unknown[] }).events });
        return { ok: true, status: 200 };
      },
    });
    r.report("u1", "c1", { type: "DAMAGE_BOSS", bossId: "b", amount: 10.4, mapId: "m" });
    r.report("u1", "c1", { type: "DAMAGE_BOSS", bossId: "b", amount: 5, mapId: "m" });
    r.report("u1", "c1", { type: "KILL", npcId: "npc_xyrr_fighter", boss: false, mapId: "m" });
    r.report("u2", null, { type: "KILL", npcId: "npc_xyrr_fighter", boss: false, mapId: "m" });
    r.report("u1", "c1", { type: "LEVEL", level: 3 });
    await r.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://api.test/api/internal/clan-missions/progress");
    expect(calls[0]!.token).toBe("tok");
    expect(calls[0]!.events).toEqual([
      { userId: "u1", event: { type: "KILL", npcId: "npc_xyrr_fighter", boss: false, mapId: "m" } },
      { userId: "u1", event: { type: "DAMAGE_BOSS", bossId: "b", amount: 15, mapId: "m" } },
    ]);
    expect(r.sent).toBe(2);
  });

  it("drops a batch rejected with 4xx without retrying, and is disabled without a token", async () => {
    let n = 0;
    const r = new ClanMissionReporter({ baseUrl: "http://x", token: "t", log, fetchImpl: async () => { n++; return { ok: false, status: 400 }; } });
    r.report("u", "c", { type: "TRAVEL", mapId: "m" });
    await r.flush();
    expect(n).toBe(1);
    expect(r.dropped).toBe(1);
    const off = new ClanMissionReporter({ baseUrl: "http://x", token: null, log });
    off.report("u", "c", { type: "TRAVEL", mapId: "m" });
    expect(off.pending()).toBe(0);
  });
});
