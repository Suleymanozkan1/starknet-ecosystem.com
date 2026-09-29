/**
 * AUDIO-01: AudioManager against a minimal fake WebAudio graph (node test env has no AudioContext).
 * The fake records node types, connections, param values/automation and start/stop calls so the
 * tests can assert what the manager actually wires up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioManager } from "./AudioManager.js";

class FakeParam {
  value = 0;
  targets: { value: number; at: number; tc: number }[] = [];
  setTargetAtTime(value: number, at: number, tc: number): this {
    this.targets.push({ value, at, tc });
    return this;
  }
  setValueAtTime(value: number): this {
    this.value = value;
    return this;
  }
  exponentialRampToValueAtTime(): this {
    return this;
  }
  get target(): number | undefined {
    return this.targets[this.targets.length - 1]?.value;
  }
}

class FakeNode {
  readonly outputs: (FakeNode | FakeParam)[] = [];
  disconnected = false;
  /** Factory that created the node (osc/buffer/gain/...); `type` is left to the WebAudio field. */
  readonly nodeKind: string;
  constructor(nodeKind: string, ctx: FakeAudioContext) {
    this.nodeKind = nodeKind;
    ctx.nodes.push(this);
  }
  connect<T extends FakeNode | FakeParam>(dest: T): T {
    this.outputs.push(dest);
    return dest;
  }
  disconnect(): void {
    this.disconnected = true;
  }
}
class FakeGain extends FakeNode {
  gain = new FakeParam();
}
class FakePanner extends FakeNode {
  pan = new FakeParam();
}
class FakeSource extends FakeNode {
  started = false;
  stops: (number | undefined)[] = [];
  onended: (() => void) | null = null;
  frequency = new FakeParam();
  detune = new FakeParam();
  type = "";
  buffer: unknown = null;
  loop = false;
  start(): void {
    this.started = true;
  }
  stop(when?: number): void {
    this.stops.push(when);
  }
}
class FakeFilter extends FakeNode {
  frequency = new FakeParam();
  Q = new FakeParam();
}
class FakeCompressor extends FakeNode {
  threshold = new FakeParam();
  ratio = new FakeParam();
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  readonly nodes: FakeNode[] = [];
  readonly destination: FakeNode;
  readonly sampleRate = 8000;
  currentTime = 10;
  state: "running" | "suspended" | "closed" = "running";
  calls: string[] = [];
  constructor() {
    this.destination = new FakeNode("destination", this);
    FakeAudioContext.instances.push(this);
  }
  createGain() { return new FakeGain("gain", this); }
  createStereoPanner() { return new FakePanner("panner", this); }
  createOscillator() { return new FakeSource("osc", this); }
  createBufferSource() { return new FakeSource("buffer", this); }
  createBiquadFilter() { return new FakeFilter("filter", this); }
  createDynamicsCompressor() { return new FakeCompressor("compressor", this); }
  createBuffer(_ch: number, length: number) {
    const data = new Float32Array(length);
    return { getChannelData: () => data };
  }
  resume(): Promise<void> {
    this.calls.push("resume");
    this.state = "running";
    return Promise.resolve();
  }
  suspend(): Promise<void> {
    this.calls.push("suspend");
    this.state = "suspended";
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.calls.push("close");
    this.state = "closed";
    return Promise.resolve();
  }
}

const listeners = new Map<string, () => void>();
let clock = 1_000_000;

beforeEach(() => {
  FakeAudioContext.instances = [];
  listeners.clear();
  vi.stubGlobal("window", {
    AudioContext: FakeAudioContext,
    addEventListener: (ev: string, fn: () => void) => listeners.set(ev, fn),
    removeEventListener: (ev: string, fn: () => void) => {
      if (listeners.get(ev) === fn) listeners.delete(ev);
    },
  });
  // play() throttles retriggers per kind with performance.now(); advance it explicitly.
  vi.spyOn(performance, "now").mockImplementation(() => (clock += 1000));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Build the context (first user gesture) and return it plus its bus gains in creation order. */
function boot() {
  listeners.get("pointerdown")?.();
  const ctx = FakeAudioContext.instances[0];
  if (!ctx) throw new Error("AudioContext was not created");
  const gains = ctx.nodes.filter((n): n is FakeGain => n instanceof FakeGain);
  const [master, sfx, music, ambient] = gains;
  if (!master || !sfx || !music || !ambient) throw new Error("buses missing");
  return { ctx, master, sfx, music, ambient };
}

/** The per-sound output stage: gain → StereoPanner → sfx bus. */
function outputStages(ctx: FakeAudioContext, sfx: FakeGain) {
  return ctx.nodes
    .filter((n): n is FakePanner => n instanceof FakePanner && n.outputs.includes(sfx))
    .map((panner) => {
      const gain = ctx.nodes.find((n): n is FakeGain => n instanceof FakeGain && n.outputs.includes(panner));
      return { pan: panner.pan.value, gain: gain?.gain.value ?? Number.NaN };
    });
}

describe("AudioManager", () => {
  it("creates the context lazily on the first gesture and routes buses master ← compressor ← sfx/music/ambient", () => {
    const am = new AudioManager();
    expect(FakeAudioContext.instances).toHaveLength(0);
    const { ctx, master, sfx, music, ambient } = boot();
    expect(ctx.calls).toContain("resume");
    expect(master.outputs).toEqual([ctx.destination]);
    const comp = ctx.nodes.find((n) => n instanceof FakeCompressor);
    expect(comp?.outputs).toEqual([master]);
    for (const bus of [sfx, music, ambient]) expect(bus.outputs).toEqual([comp]);
    am.dispose();
  });

  it("applies category volumes (music/ambient are scaled) and supports muting a category", () => {
    const am = new AudioManager({ master: 0.9, sfx: 0.7, music: 0.5, ambient: 0.4 });
    const { master, sfx, music, ambient } = boot();
    expect(master.gain.target).toBe(0.9);
    expect(sfx.gain.target).toBe(0.7);
    expect(music.gain.target).toBeCloseTo(0.5 * 0.6);
    expect(ambient.gain.target).toBeCloseTo(0.4 * 0.5);

    am.setVolumes({ music: 0 });
    expect(music.gain.target).toBe(0);
    expect(sfx.gain.target).toBe(0.7); // other categories untouched
    expect(am.volumeSettings).toEqual({ master: 0.9, sfx: 0.7, music: 0, ambient: 0.4 });
    // The returned settings are a copy.
    am.volumeSettings.sfx = 0;
    expect(am.volumeSettings.sfx).toBe(0.7);
    am.setVolumes({ master: 0 });
    expect(master.gain.target).toBe(0);
    am.dispose();
  });

  it("attenuates by distance (quadratic falloff) and pans left/right relative to the listener", () => {
    const am = new AudioManager();
    const { ctx, sfx } = boot();
    am.setListener(1000, 1000, 200);

    am.play("ui", 1000, 1000); // at the listener
    am.play("ui_confirm", 1100, 1000); // half the hearing radius to the right
    am.play("pickup", 950, 1000); // a quarter to the left
    am.play("error"); // non-positional
    const stages = outputStages(ctx, sfx);
    expect(stages).toHaveLength(4);
    expect(stages[0]).toEqual({ gain: 1, pan: 0 });
    expect(stages[1]?.gain).toBeCloseTo(0.25); // (1 - 100/200)^2
    expect(stages[1]?.pan).toBeCloseTo(1); // 100 / (200 * 0.5)
    expect(stages[2]?.gain).toBeCloseTo(0.5625); // (1 - 50/200)^2
    expect(stages[2]?.pan).toBeCloseTo(-0.5);
    expect(stages[3]).toEqual({ gain: 1, pan: 0 });

    // Beyond hearing range (or effectively inaudible) nothing is synthesised at all.
    const before = ctx.nodes.length;
    am.play("explosion", 1300, 1000);
    am.play("laser", 1000, 1195); // gain (5/200)^2 < 0.02
    expect(ctx.nodes.length).toBe(before);
    // Volume scales the positional gain.
    am.play("hull_hit", 1000, 1000, 0.5);
    expect(outputStages(ctx, sfx).at(-1)?.gain).toBeCloseTo(0.5);
    am.dispose();
  });

  it("clamps the hearing radius and the pan", () => {
    const am = new AudioManager();
    const { ctx, sfx } = boot();
    am.setListener(0, 0, 5); // clamped up to 40
    am.play("ui", 20, 0);
    expect(outputStages(ctx, sfx)[0]?.gain).toBeCloseTo(0.25); // (1 - 20/40)^2
    expect(outputStages(ctx, sfx)[0]?.pan).toBe(1); // 20 / 20, clamped to [-1, 1]
    am.play("pickup", -30, 0);
    expect(outputStages(ctx, sfx)[1]?.pan).toBe(-1);
    am.dispose();
  });

  it("throttles rapid retriggers of the same sound", () => {
    const am = new AudioManager();
    const { ctx, sfx } = boot();
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(5_000_000);
    am.play("ui");
    am.play("ui"); // same instant → dropped
    expect(outputStages(ctx, sfx)).toHaveLength(1);
    now.mockReturnValue(5_000_100);
    am.play("ui");
    expect(outputStages(ctx, sfx)).toHaveLength(2);
    am.dispose();
  });

  it("does not play while suspended (mute) and suspends/resumes the context", () => {
    const am = new AudioManager();
    const { ctx, sfx } = boot();
    am.setSuspended(true);
    expect(ctx.calls.at(-1)).toBe("suspend");
    am.play("ui");
    expect(outputStages(ctx, sfx)).toHaveLength(0);
    am.setSuspended(false);
    expect(ctx.calls.at(-1)).toBe("resume");
    am.play("ui");
    expect(outputStages(ctx, sfx)).toHaveLength(1);
    am.dispose();
  });

  it("caps simultaneous voices by stopping the oldest", () => {
    const am = new AudioManager();
    const { ctx } = boot();
    const sources = () => ctx.nodes.filter((n): n is FakeSource => n instanceof FakeSource);
    // Each tone/noise is one voice (22 in total here); distinct kinds avoid the retrigger throttle.
    const kinds = ["ui", "ui_confirm", "error", "pickup", "level_up", "laser", "plasma", "rail", "shield_hit", "hull_hit", "explosion_big", "emp"] as const;
    for (const k of kinds) am.play(k);
    const all = sources();
    expect(all.length).toBeGreaterThan(18);
    // Voices beyond the cap were force-stopped (stop() without a time), oldest first.
    const forced = all.filter((s) => s.stops.includes(undefined));
    expect(forced.length).toBe(all.length - 18);
    expect(forced[0]).toBe(all[0]);
    am.dispose();
  });

  it("boss music: starts one layer on the music bus, follows intensity, and stops it", () => {
    const am = new AudioManager();
    const { ctx, music } = boot();
    ctx.currentTime = 50;
    am.setBossLayer(true, 0.5);
    const layerGain = ctx.nodes.find((n): n is FakeGain => n instanceof FakeGain && n.outputs.includes(music));
    expect(layerGain).toBeDefined();
    const oscs = () => ctx.nodes.filter((n): n is FakeSource => n instanceof FakeSource && n.nodeKind === "osc");
    expect(oscs()).toHaveLength(3);
    expect(oscs().every((o) => o.started)).toBe(true);
    expect(layerGain?.gain.target).toBeCloseTo(0.35 + 0.5 * 0.5);
    const pulse = oscs()[1];
    expect(pulse?.frequency.target).toBeCloseTo(2 + 0.5 * 3);

    // Raising intensity reuses the running layer.
    am.setBossLayer(true, 1);
    expect(oscs()).toHaveLength(3);
    expect(layerGain?.gain.target).toBeCloseTo(0.85);
    expect(pulse?.frequency.target).toBeCloseTo(5);

    am.setBossLayer(false);
    expect(layerGain?.gain.target).toBe(0);
    for (const o of oscs()) expect(o.stops).toEqual([50 + 2.5]);
    // Stopping twice is a no-op; starting again builds a fresh layer.
    am.setBossLayer(false);
    for (const o of oscs()) expect(o.stops).toHaveLength(1);
    am.setBossLayer(true, 0);
    expect(oscs()).toHaveLength(6);
    am.dispose();
  });

  it("dispose stops voices, closes the context, removes gesture listeners and silences later calls", () => {
    const am = new AudioManager();
    const { ctx } = boot();
    am.play("explosion");
    const srcs = ctx.nodes.filter((n): n is FakeSource => n instanceof FakeSource);
    expect(srcs.length).toBeGreaterThan(0);
    am.dispose();
    expect(ctx.calls.at(-1)).toBe("close");
    for (const s of srcs) expect(s.stops).toContain(undefined);
    expect(listeners.size).toBe(0);
    const count = ctx.nodes.length;
    am.play("ui");
    am.setBossLayer(true);
    expect(ctx.nodes.length).toBe(count);
    expect(FakeAudioContext.instances).toHaveLength(1);
  });
});
