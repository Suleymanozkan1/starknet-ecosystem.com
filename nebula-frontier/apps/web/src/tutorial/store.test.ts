import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TUTORIAL_STORAGE_NAME, shouldAutoShow, useTutorial } from "./store.js";

const KEY = `nf.${TUTORIAL_STORAGE_NAME}`;

function memoryStorage(): Storage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => { data.delete(k); },
    setItem: (k, v) => { data.set(k, String(v)); },
  };
}

function throwingStorage(): Storage {
  const fail = (): never => { throw new DOMException("QuotaExceededError", "QuotaExceededError"); };
  return { length: 0, clear: fail, getItem: fail, key: fail, removeItem: fail, setItem: fail };
}

const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

beforeEach(() => {
  useTutorial.setState({ enabled: true, seen: [], replayId: null, replayNonce: 0 });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("tutorial store", () => {
  it("marks tips as seen once and gates automatic display", () => {
    const s = useTutorial.getState();
    expect(shouldAutoShow(useTutorial.getState(), "page:home")).toBe(true);
    s.markSeen("page:home");
    s.markSeen("page:home");
    expect(useTutorial.getState().seen).toEqual(["page:home"]);
    expect(shouldAutoShow(useTutorial.getState(), "page:home")).toBe(false);
    expect(shouldAutoShow(useTutorial.getState(), "page:hangar")).toBe(true);
  });

  it("disabling the guide stops automatic tips", () => {
    useTutorial.getState().setEnabled(false);
    expect(shouldAutoShow(useTutorial.getState(), "game:move")).toBe(false);
    useTutorial.getState().setEnabled(true);
    expect(shouldAutoShow(useTutorial.getState(), "game:move")).toBe(true);
  });

  it("replays a seen tip on request (twice in a row) and clears the request", () => {
    const s = useTutorial.getState();
    s.markSeen("page:clan");
    s.replay("page:clan");
    const first = useTutorial.getState();
    expect(first.replayId).toBe("page:clan");
    s.replay("page:clan");
    expect(useTutorial.getState().replayNonce).toBe(first.replayNonce + 1);
    useTutorial.getState().clearReplay();
    expect(useTutorial.getState().replayId).toBeNull();
    expect(useTutorial.getState().seen).toContain("page:clan");
  });

  it("reset forgets every seen tip and re-enables the guide", () => {
    const s = useTutorial.getState();
    s.markSeen("landing");
    s.markSeen("game:fire");
    s.setEnabled(false);
    s.reset();
    expect(useTutorial.getState()).toMatchObject({ enabled: true, seen: [], replayId: null });
  });

  it("persists only enabled + seen to localStorage (nf. prefix) and rehydrates them", async () => {
    const storage = memoryStorage();
    vi.stubGlobal("window", { localStorage: storage });
    useTutorial.getState().markSeen("page:shop");
    useTutorial.getState().replay("page:shop");
    await flush();
    const saved = JSON.parse(storage.data.get(KEY) ?? "{}") as { state?: Record<string, unknown> };
    expect(saved.state).toEqual({ enabled: true, seen: ["page:shop"] });

    storage.data.set(KEY, JSON.stringify({ state: { enabled: false, seen: ["landing", "game:move"] }, version: 1 }));
    await useTutorial.persist.rehydrate();
    expect(useTutorial.getState()).toMatchObject({ enabled: false, seen: ["landing", "game:move"] });
  });

  it("ignores malformed persisted data", async () => {
    const storage = memoryStorage();
    storage.data.set(KEY, JSON.stringify({ state: { enabled: "yes", seen: ["ok", 3, null] }, version: 1 }));
    vi.stubGlobal("window", { localStorage: storage });
    await useTutorial.persist.rehydrate();
    expect(useTutorial.getState()).toMatchObject({ enabled: true, seen: ["ok"] });
  });

  it("keeps working when storage throws (private mode / quota) or is missing", async () => {
    vi.stubGlobal("window", { localStorage: throwingStorage() });
    await expect(useTutorial.persist.rehydrate()).resolves.toBeUndefined();
    expect(() => useTutorial.getState().markSeen("game:dock")).not.toThrow();
    await flush();
    expect(useTutorial.getState().seen).toContain("game:dock");

    vi.stubGlobal("window", undefined);
    expect(() => useTutorial.getState().reset()).not.toThrow();
    await flush();
    expect(useTutorial.getState().seen).toEqual([]);
  });
});
