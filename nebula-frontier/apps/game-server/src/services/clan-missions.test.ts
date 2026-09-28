import { describe, expect, it } from "vitest";
import { createLogger } from "@nebula/telemetry";
import { Writable } from "node:stream";
import { ClanMissionReporter, MAX_QUEUE } from "./clan-missions.js";

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
      { eventId: expect.any(String), userId: "u1", event: { type: "KILL", npcId: "npc_xyrr_fighter", boss: false, mapId: "m" } },
      { eventId: expect.any(String), userId: "u1", event: { type: "DAMAGE_BOSS", bossId: "b", amount: 15, mapId: "m" } },
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

  it("resends identical event ids on every retry of a batch (API dedupes replays)", async () => {
    const bodies: { eventId: string }[][] = [];
    let fail = 2;
    const r = new ClanMissionReporter({
      baseUrl: "http://x", token: "t", log, maxAttempts: 3,
      fetchImpl: async (_u, init) => {
        bodies.push((JSON.parse(init.body) as { events: { eventId: string }[] }).events);
        return fail-- > 0 ? { ok: false, status: 503 } : { ok: true, status: 200 };
      },
    });
    r.report("u", "c", { type: "TRAVEL", mapId: "m" });
    r.report("u", "c", { type: "MINE", resourceId: "TITANIUM", quantity: 3, mapId: "m" });
    await r.flush();
    expect(bodies).toHaveLength(3);
    const ids = bodies[0]!.map((e) => e.eventId);
    expect(new Set(ids).size).toBe(2);
    for (const b of bodies) expect(b.map((e) => e.eventId)).toEqual(ids);
  });

  it("bounds the aggregate map and the aggregate->queue copy by MAX_QUEUE, counting discards", async () => {
    let sent = 0;
    const r = new ClanMissionReporter({ baseUrl: "http://x", token: "t", log, fetchImpl: async (_u, init) => { sent += (JSON.parse(init.body) as { events: unknown[] }).events.length; return { ok: true, status: 200 }; } });
    for (let i = 0; i < MAX_QUEUE + 5; i++) r.report("u", "c", { type: "MINE", resourceId: `R${i}`, quantity: 1, mapId: "m" });
    expect(r.pending()).toBe(MAX_QUEUE);
    expect(r.dropped).toBe(5);
    // Queue already full of plain events: aggregates that do not fit are discarded, not copied.
    const q = new ClanMissionReporter({ baseUrl: "http://x", token: "t", log, fetchImpl: async (_u, init) => { sent += (JSON.parse(init.body) as { events: unknown[] }).events.length; return { ok: true, status: 200 }; } });
    for (let i = 0; i < MAX_QUEUE; i++) q.report("u", "c", { type: "TRAVEL", mapId: "m" });
    for (let i = 0; i < 3; i++) q.report("u", "c", { type: "MINE", resourceId: `R${i}`, quantity: 1, mapId: "m" });
    await q.flush();
    expect(q.dropped).toBe(3);
    expect(q.sent).toBe(MAX_QUEUE);
    expect(sent).toBe(MAX_QUEUE);
  });
});
