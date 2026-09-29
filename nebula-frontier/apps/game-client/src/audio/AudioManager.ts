import type { AudioVolumes } from "../types.js";

export type SfxKind =
  | "laser" | "plasma" | "rail" | "missile" | "explosion" | "explosion_big" | "shield_hit" | "hull_hit" | "ui" | "ui_confirm"
  | "warp" | "npc_alert" | "pickup" | "level_up" | "emp" | "dash" | "error";

interface Voice { stop(): void; end: number }

const MAX_VOICES = 18;

/**
 * Procedural WebAudio sound engine: synthesised SFX (no asset downloads),
 * engine hum & mining loops, ambient pad and a boss music layer. Sounds are
 * panned/attenuated relative to the camera focus (PositionalAudio-style, but
 * with cheap StereoPanner nodes). Mobile-safe: the context is resumed on the
 * first user gesture; voices are capped and retriggers throttled.
 */
export class AudioManager {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfx: GainNode | null = null;
  private music: GainNode | null = null;
  private ambient: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private readonly voices: Voice[] = [];
  private readonly lastPlayed = new Map<string, number>();
  private volumes: AudioVolumes = { master: 0.8, sfx: 0.8, music: 0.5, ambient: 0.6 };
  private listenerX = 0;
  private listenerY = 0;
  private hearing = 120;
  private engine: { osc: OscillatorNode; osc2: OscillatorNode; filter: BiquadFilterNode; gain: GainNode; noise: AudioBufferSourceNode } | null = null;
  private mining: { osc: OscillatorNode; lfo: OscillatorNode; gain: GainNode } | null = null;
  private pad: { nodes: AudioScheduledSourceNode[]; gain: GainNode } | null = null;
  private boss: { nodes: AudioScheduledSourceNode[]; gain: GainNode } | null = null;
  private readonly unlock: () => void;
  private disposed = false;
  private suspended = false;

  constructor(volumes?: Partial<AudioVolumes>) {
    if (volumes) this.volumes = { ...this.volumes, ...volumes };
    this.unlock = () => {
      void this.ensure()?.resume();
    };
    if (typeof window !== "undefined") {
      for (const ev of ["pointerdown", "keydown", "touchstart"] as const) window.addEventListener(ev, this.unlock, { passive: true });
    }
  }

  private ensure(): AudioContext | null {
    if (this.disposed) return null;
    if (this.ctx) return this.ctx;
    const Ctor = typeof window !== "undefined" ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) : undefined;
    if (!Ctor) return null;
    const ctx = new Ctor({ latencyHint: "interactive" });
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    comp.connect(this.master);
    this.sfx = ctx.createGain();
    this.music = ctx.createGain();
    this.ambient = ctx.createGain();
    this.sfx.connect(comp);
    this.music.connect(comp);
    this.ambient.connect(comp);
    // 1s white noise buffer shared by all noise voices
    const n = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = n.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noise = n;
    this.applyVolumes();
    return ctx;
  }

  private applyVolumes(): void {
    const t = this.ctx?.currentTime ?? 0;
    this.master?.gain.setTargetAtTime(this.volumes.master, t, 0.05);
    this.sfx?.gain.setTargetAtTime(this.volumes.sfx, t, 0.05);
    this.music?.gain.setTargetAtTime(this.volumes.music * 0.6, t, 0.05);
    this.ambient?.gain.setTargetAtTime(this.volumes.ambient * 0.5, t, 0.05);
  }

  setVolumes(v: Partial<AudioVolumes>): void {
    this.volumes = { ...this.volumes, ...v };
    this.applyVolumes();
  }

  get volumeSettings(): AudioVolumes {
    return { ...this.volumes };
  }

  /** Camera focus in map coordinates + audible radius. */
  setListener(x: number, y: number, hearing: number): void {
    this.listenerX = x;
    this.listenerY = y;
    this.hearing = Math.max(40, hearing);
  }

  setSuspended(s: boolean): void {
    this.suspended = s;
    if (!this.ctx) return;
    if (s) void this.ctx.suspend();
    else void this.ctx.resume();
  }

  private spatial(x: number | undefined, y: number | undefined): { gain: number; pan: number } {
    if (x === undefined || y === undefined) return { gain: 1, pan: 0 };
    const dx = x - this.listenerX, dy = y - this.listenerY;
    const d = Math.hypot(dx, dy);
    const gain = Math.max(0, 1 - d / this.hearing);
    return { gain: gain * gain, pan: Math.max(-1, Math.min(1, dx / (this.hearing * 0.5))) };
  }

  private out(gain: number, pan: number): { node: GainNode; panner: StereoPannerNode } | null {
    const ctx = this.ctx;
    if (!ctx || !this.sfx) return null;
    const g = ctx.createGain();
    g.gain.value = gain;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    g.connect(p);
    p.connect(this.sfx);
    return { node: g, panner: p };
  }

  private track(src: AudioScheduledSourceNode, end: number, cleanup: AudioNode[]): void {
    const v: Voice = {
      end,
      stop: () => {
        try { src.stop(); } catch { /* already stopped */ }
      },
    };
    this.voices.push(v);
    src.onended = () => {
      const i = this.voices.indexOf(v);
      if (i >= 0) this.voices.splice(i, 1);
      for (const n of cleanup) n.disconnect();
    };
    if (this.voices.length > MAX_VOICES) this.voices.shift()?.stop();
  }

  /** Play a one-shot effect, optionally at a map position. */
  play(kind: SfxKind, x?: number, y?: number, volume = 1): void {
    if (this.suspended) return;
    const ctx = this.ensure();
    if (!ctx || ctx.state !== "running" || !this.noise) return;
    const now = performance.now();
    const minGap = kind === "laser" || kind === "hull_hit" || kind === "shield_hit" ? 45 : 70;
    if (now - (this.lastPlayed.get(kind) ?? 0) < minGap) return;
    this.lastPlayed.set(kind, now);
    const sp = this.spatial(x, y);
    const g = sp.gain * volume;
    if (g < 0.02) return;
    const o = this.out(g, sp.pan);
    if (!o) return;
    const t = ctx.currentTime;
    const env = (node: GainNode, a: number, peak: number, dec: number): void => {
      node.gain.setValueAtTime(0.0001, t);
      node.gain.exponentialRampToValueAtTime(peak, t + a);
      node.gain.exponentialRampToValueAtTime(0.0001, t + a + dec);
    };
    const tone = (type: OscillatorType, f0: number, f1: number, dur: number, peak: number, a = 0.004): void => {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(f0, t);
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
      const e = ctx.createGain();
      env(e, a, peak, dur);
      osc.connect(e).connect(o.node);
      osc.start(t);
      osc.stop(t + a + dur + 0.02);
      this.track(osc, t + dur, [osc, e]);
    };
    const noise = (type: BiquadFilterType, f0: number, f1: number, q: number, dur: number, peak: number, a = 0.005): void => {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.Q.value = q;
      f.frequency.setValueAtTime(f0, t);
      f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
      const e = ctx.createGain();
      env(e, a, peak, dur);
      src.connect(f).connect(e).connect(o.node);
      src.start(t, Math.random() * 0.5);
      src.stop(t + a + dur + 0.02);
      this.track(src, t + dur, [src, f, e]);
    };
    switch (kind) {
      case "laser": tone("sawtooth", 1400, 180, 0.14, 0.18); tone("square", 2600, 600, 0.06, 0.05); break;
      case "plasma": tone("square", 520, 90, 0.2, 0.16); noise("bandpass", 2000, 400, 4, 0.15, 0.1); break;
      case "rail": tone("sawtooth", 3000, 80, 0.35, 0.18); noise("highpass", 6000, 2000, 1, 0.25, 0.12); break;
      case "missile": noise("bandpass", 600, 3000, 2, 0.45, 0.22, 0.03); tone("triangle", 180, 420, 0.35, 0.08); break;
      case "explosion": noise("lowpass", 1800, 90, 0.8, 0.9, 0.6, 0.004); tone("sine", 90, 35, 0.6, 0.5); break;
      case "explosion_big": noise("lowpass", 1200, 50, 0.7, 1.8, 0.8, 0.01); tone("sine", 70, 25, 1.4, 0.7); tone("sawtooth", 55, 30, 1.2, 0.12); break;
      case "shield_hit": tone("sine", 900, 1400, 0.12, 0.12); noise("bandpass", 3000, 5000, 6, 0.18, 0.08); break;
      case "hull_hit": noise("bandpass", 900, 300, 2, 0.12, 0.25); tone("square", 140, 70, 0.08, 0.08); break;
      case "ui": tone("sine", 880, 880, 0.05, 0.1); break;
      case "ui_confirm": tone("sine", 660, 990, 0.12, 0.12); break;
      case "warp": tone("sawtooth", 80, 1600, 1.4, 0.15, 0.3); noise("bandpass", 200, 4000, 1.5, 1.6, 0.18, 0.4); break;
      case "npc_alert": tone("square", 740, 740, 0.09, 0.08); setTimeout(() => this.play("ui", x, y, 0.8), 120); break;
      case "pickup": tone("triangle", 700, 1400, 0.16, 0.14); tone("sine", 1400, 2100, 0.2, 0.08); break;
      case "level_up": tone("triangle", 440, 880, 0.35, 0.18); tone("triangle", 660, 1320, 0.5, 0.12, 0.12); break;
      case "emp": tone("sine", 220, 40, 0.8, 0.35); noise("bandpass", 4000, 300, 3, 0.7, 0.2); break;
      case "dash": noise("bandpass", 400, 2400, 2, 0.25, 0.25, 0.01); break;
      case "error": tone("square", 220, 160, 0.16, 0.08); break;
    }
  }

  /** Continuous engine hum driven by thrust (0..1) and boost. */
  setEngine(thrust: number, boost: boolean): void {
    const ctx = this.ensure();
    if (!ctx || !this.sfx || !this.noise || ctx.state !== "running") return;
    if (!this.engine) {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = 45;
      const osc2 = ctx.createOscillator();
      osc2.type = "triangle";
      osc2.frequency.value = 90.7;
      const noise = ctx.createBufferSource();
      noise.buffer = this.noise;
      noise.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 200;
      filter.Q.value = 2;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const ng = ctx.createGain();
      ng.gain.value = 0.25;
      osc.connect(filter);
      osc2.connect(filter);
      noise.connect(ng).connect(filter);
      filter.connect(gain).connect(this.sfx);
      osc.start();
      osc2.start();
      noise.start();
      this.engine = { osc, osc2, filter, gain, noise };
    }
    const t = ctx.currentTime;
    const k = Math.max(0, Math.min(1, thrust));
    this.engine.gain.gain.setTargetAtTime(0.04 + k * 0.1 + (boost ? 0.06 : 0), t, 0.15);
    this.engine.filter.frequency.setTargetAtTime(180 + k * 700 + (boost ? 900 : 0), t, 0.2);
    this.engine.osc.frequency.setTargetAtTime(42 + k * 20 + (boost ? 18 : 0), t, 0.25);
    this.engine.osc2.frequency.setTargetAtTime(85 + k * 40, t, 0.25);
  }

  setMining(on: boolean): void {
    const ctx = this.ensure();
    if (!ctx || !this.sfx || ctx.state !== "running") return;
    if (on && !this.mining) {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = 160;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 11;
      const lg = ctx.createGain();
      lg.gain.value = 0.03;
      const gain = ctx.createGain();
      gain.gain.value = 0.05;
      lfo.connect(lg).connect(gain.gain);
      osc.connect(gain).connect(this.sfx);
      osc.start();
      lfo.start();
      this.mining = { osc, lfo, gain };
    } else if (!on && this.mining) {
      const m = this.mining;
      this.mining = null;
      m.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
      m.osc.stop(ctx.currentTime + 0.3);
      m.lfo.stop(ctx.currentTime + 0.3);
    }
  }

  /** Ambient pad tinted by the map (root frequency from map id hash). */
  startAmbient(seed: number): void {
    const ctx = this.ensure();
    if (!ctx || !this.ambient) return;
    this.stopLayer(this.pad);
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 700;
    filter.connect(gain).connect(this.ambient);
    const root = 55 * Math.pow(2, (seed % 7) / 12);
    const nodes: AudioScheduledSourceNode[] = [];
    for (const [mult, det] of [[1, -6], [1.5, 4], [2, 7], [3, -3]] as const) {
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.value = root * mult;
      o.detune.value = det;
      const og = ctx.createGain();
      og.gain.value = 0.12 / mult;
      o.connect(og).connect(filter);
      o.start();
      nodes.push(o);
    }
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lg = ctx.createGain();
    lg.gain.value = 250;
    lfo.connect(lg).connect(filter.frequency);
    lfo.start();
    nodes.push(lfo);
    gain.gain.setTargetAtTime(1, ctx.currentTime, 2);
    this.pad = { nodes, gain };
  }

  /** Boss music layer: pulsing low drone + arpeggiated stabs; intensity 0..1 (phase). */
  setBossLayer(on: boolean, intensity = 0.5): void {
    const ctx = this.ensure();
    if (!ctx || !this.music) return;
    if (!on) {
      this.stopLayer(this.boss);
      this.boss = null;
      return;
    }
    if (!this.boss) {
      const gain = ctx.createGain();
      gain.gain.value = 0;
      gain.connect(this.music);
      const nodes: AudioScheduledSourceNode[] = [];
      const drone = ctx.createOscillator();
      drone.type = "sawtooth";
      drone.frequency.value = 41.2;
      const df = ctx.createBiquadFilter();
      df.type = "lowpass";
      df.frequency.value = 300;
      const pulse = ctx.createOscillator();
      pulse.type = "square";
      pulse.frequency.value = 2.2;
      const pg = ctx.createGain();
      pg.gain.value = 0.35;
      const vca = ctx.createGain();
      vca.gain.value = 0.5;
      pulse.connect(pg).connect(vca.gain);
      drone.connect(df).connect(vca).connect(gain);
      const fifth = ctx.createOscillator();
      fifth.type = "triangle";
      fifth.frequency.value = 61.7;
      const fg = ctx.createGain();
      fg.gain.value = 0.2;
      fifth.connect(fg).connect(gain);
      drone.start();
      pulse.start();
      fifth.start();
      nodes.push(drone, pulse, fifth);
      this.boss = { nodes, gain };
    }
    const t = ctx.currentTime;
    this.boss.gain.gain.setTargetAtTime(0.35 + 0.5 * intensity, t, 1.2);
    const pulse = this.boss.nodes[1] as OscillatorNode | undefined;
    pulse?.frequency.setTargetAtTime(2 + intensity * 3, t, 0.5);
  }

  private stopLayer(layer: { nodes: AudioScheduledSourceNode[]; gain: GainNode } | null): void {
    const ctx = this.ctx;
    if (!layer || !ctx) return;
    layer.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.5);
    for (const n of layer.nodes) n.stop(ctx.currentTime + 2.5);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (typeof window !== "undefined") {
      for (const ev of ["pointerdown", "keydown", "touchstart"] as const) window.removeEventListener(ev, this.unlock);
    }
    for (const v of [...this.voices]) v.stop();
    this.voices.length = 0;
    void this.ctx?.close();
    this.ctx = null;
    this.engine = null;
    this.mining = null;
    this.pad = null;
    this.boss = null;
  }
}
