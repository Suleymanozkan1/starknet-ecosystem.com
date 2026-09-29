import { describe, expect, it } from "vitest";
import { adminEventSchema, adminUserSearchSchema } from "./api.js";
import { hasControlChars } from "./common.js";
import { parseClientMessage, type ClientMessageType } from "./game.js";

describe("hasControlChars", () => {
  it("allows ordinary text, tabs and newlines", () => {
    expect(hasControlChars("hello pilot\tok\n")).toBe(false);
    expect(hasControlChars("Grüße 你好")).toBe(false);
  });
  it.each([
    ["C0", "a\u0001b"],
    ["DEL", "a\u007fb"],
    ["C1", "a\u0085b"],
    ["C1 end", "a\u009fb"],
    ["zero-width space", "a​b"],
    ["RLM", "a‏b"],
    ["bidi override", "a‮b"],
    ["bidi isolate", "a⁦b"],
    ["pop isolate", "a⁩b"],
    ["BOM", "﻿ab"],
  ])("rejects %s", (_name, s) => {
    expect(hasControlChars(s)).toBe(true);
  });
});

describe("parseClientMessage", () => {
  it("returns null for prototype keys", () => {
    expect(parseClientMessage("constructor" as ClientMessageType, {})).toBeNull();
    expect(parseClientMessage("toString" as ClientMessageType, {})).toBeNull();
    expect(parseClientMessage("__proto__" as ClientMessageType, {})).toBeNull();
  });
  it("parses known messages", () => {
    expect(parseClientMessage("formation", { formation: "ARROW" })).toEqual({ formation: "ARROW" });
    expect(parseClientMessage("formation", { formation: "NOPE" })).toBeNull();
  });
});

describe("adminUserSearchSchema", () => {
  it("parses banned=false as false and banned=true as true", () => {
    expect(adminUserSearchSchema.parse({ banned: "false" }).banned).toBe(false);
    expect(adminUserSearchSchema.parse({ banned: "true" }).banned).toBe(true);
    expect(adminUserSearchSchema.parse({}).banned).toBeUndefined();
  });
  it("rejects other values", () => {
    expect(adminUserSearchSchema.safeParse({ banned: "yes" }).success).toBe(false);
    expect(adminUserSearchSchema.safeParse({ banned: "0" }).success).toBe(false);
  });
});

describe("adminEventSchema", () => {
  const base = { id: "evt_x", name: "Rift", type: "GLOBAL_RIFT", reason: "qa window" };
  it("accepts ISO datetime strings and converts them to Dates", () => {
    const e = adminEventSchema.parse({ ...base, startAt: "2026-01-01T00:00:00.000Z", endAt: "2026-01-02T00:00:00+02:00" });
    expect(e.startAt).toBeInstanceOf(Date);
    expect(e.startAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(e.endAt.toISOString()).toBe("2026-01-01T22:00:00.000Z");
  });
  it("rejects non-ISO or numeric dates", () => {
    expect(adminEventSchema.safeParse({ ...base, startAt: 0, endAt: 1 }).success).toBe(false);
    expect(adminEventSchema.safeParse({ ...base, startAt: "Jan 1 2026", endAt: "2026-01-02T00:00:00Z" }).success).toBe(false);
    expect(adminEventSchema.safeParse({ ...base, startAt: "2026-01-02T00:00:00Z", endAt: "2026-01-01T00:00:00Z" }).success).toBe(false);
  });
});
