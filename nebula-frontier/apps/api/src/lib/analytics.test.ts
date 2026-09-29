/** AnalyticsWriter.flush(): concurrent callers never run two flushes at once. */
import type { Db } from "@nebula/database";
import { describe, expect, it } from "vitest";
import { AnalyticsWriter } from "./analytics.js";

describe("AnalyticsWriter.flush", () => {
  it("serialises concurrent flushes and writes every buffered event exactly once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const written: string[] = [];
    const fakeDb = {
      analyticsEvent: {
        async createMany(args: { data: { name: string }[] }) {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 20));
          written.push(...args.data.map((d) => d.name));
          inFlight--;
          return { count: args.data.length };
        },
      },
    };
    const w = new AnalyticsWriter(fakeDb as unknown as Db, { intervalMs: 0, maxBatch: 1000 });
    w.track("a", null);
    const first = w.flush();
    w.track("b", null);
    w.track("c", null);
    // Two callers wake from the same in-flight flush; only one may start the next createMany.
    await Promise.all([first, w.flush(), w.flush(), w.flush()]);
    expect(maxInFlight).toBe(1);
    expect(written.sort()).toEqual(["a", "b", "c"]);
    expect(w.pending).toBe(0);
    await w.close();
  });
});
