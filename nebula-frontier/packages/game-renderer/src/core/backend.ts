import {
  ACESFilmicToneMapping, type Camera, PCFShadowMap, PMREMGenerator, type Scene, SRGBColorSpace, type Texture,
  Vector2, WebGLRenderer,
} from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import type { TierSettings } from "./tiers.js";

export type BackendPreference = "webgl" | "webgpu" | "auto";
export type BackendKind = "webgl" | "webgpu";

/** Minimal renderer surface used by the engine (satisfied by WebGLRenderer and WebGPURenderer). */
export interface RendererLike {
  domElement: HTMLCanvasElement;
  setPixelRatio(r: number): void;
  getPixelRatio(): number;
  setSize(w: number, h: number, updateStyle?: boolean): void;
  render(scene: Scene, camera: Camera): void;
  dispose(): void;
  toneMapping: number;
  toneMappingExposure: number;
  outputColorSpace: string;
  shadowMap: { enabled: boolean; type: number };
}

export interface RenderBackend {
  kind: BackendKind;
  renderer: RendererLike;
  /** Non-null when kind === "webgl". */
  webgl: WebGLRenderer | null;
  /** GLSL ShaderMaterials are only supported on the WebGL backend. */
  supportsGlsl: boolean;
  environment: Texture | null;
  setTier(t: TierSettings): void;
  setSize(w: number, h: number): void;
  setPixelRatio(r: number): void;
  readonly pixelRatio: number;
  render(scene: Scene, camera: Camera): void;
  dispose(): void;
}

export interface BackendOptions {
  canvas: HTMLCanvasElement;
  tier: TierSettings;
  preference?: BackendPreference;
  alpha?: boolean;
  preserveDrawingBuffer?: boolean;
}

interface WebGPURendererLike extends RendererLike {
  init(): Promise<unknown>;
}

/**
 * Create the renderer. WebGL is the stable default; WebGPU (three/webgpu) is used only when
 * requested (or "auto" + tier allows) and `navigator.gpu` exists. On WebGPU, GLSL ShaderMaterial
 * effects fall back to simpler node-compatible materials (`supportsGlsl === false`) and bloom is off.
 */
export async function createRenderBackend(opts: BackendOptions): Promise<RenderBackend> {
  const pref = opts.preference ?? "webgl";
  const nav = typeof navigator !== "undefined" ? (navigator as Navigator & { gpu?: unknown }) : undefined;
  const wantGpu = (pref === "webgpu" || (pref === "auto" && opts.tier.allowWebGPU)) && !!nav?.gpu;
  if (wantGpu) {
    try {
      const mod = (await import("three/webgpu")) as unknown as { WebGPURenderer: new (p: object) => WebGPURendererLike };
      const r = new mod.WebGPURenderer({ canvas: opts.canvas, antialias: opts.tier.antialias, alpha: opts.alpha ?? false });
      await r.init();
      return makeWebGpuBackend(r, opts);
    } catch (err) {
      console.warn("[renderer] WebGPU init failed, falling back to WebGL", err);
    }
  }
  return makeWebGlBackend(opts);
}

function makeWebGpuBackend(r: WebGPURendererLike, opts: BackendOptions): RenderBackend {
  r.toneMapping = ACESFilmicToneMapping;
  r.toneMappingExposure = 1.05;
  r.outputColorSpace = SRGBColorSpace;
  let ratio = 1;
  const backend: RenderBackend = {
    kind: "webgpu",
    renderer: r,
    webgl: null,
    supportsGlsl: false,
    environment: null,
    setTier(t) {
      r.shadowMap.enabled = t.shadows;
    },
    setSize(w, h) { r.setSize(w, h, false); },
    setPixelRatio(p) { ratio = p; r.setPixelRatio(p); },
    get pixelRatio() { return ratio; },
    render(scene, camera) { r.render(scene, camera); },
    dispose() { r.dispose(); },
  };
  backend.setTier(opts.tier);
  return backend;
}

function makeWebGlBackend(opts: BackendOptions): RenderBackend {
  const r = new WebGLRenderer({
    canvas: opts.canvas,
    antialias: opts.tier.antialias,
    alpha: opts.alpha ?? false,
    powerPreference: "high-performance",
    preserveDrawingBuffer: opts.preserveDrawingBuffer ?? false,
    stencil: false,
  });
  r.toneMapping = ACESFilmicToneMapping;
  r.toneMappingExposure = 1.05;
  r.outputColorSpace = SRGBColorSpace;
  r.shadowMap.type = PCFShadowMap;
  r.info.autoReset = false;
  const pmrem = new PMREMGenerator(r);
  const room = new RoomEnvironment();
  const envRT = pmrem.fromScene(room, 0.04);
  room.dispose();
  pmrem.dispose();

  let composer: EffectComposer | null = null;
  let bloom: UnrealBloomPass | null = null;
  let renderPass: RenderPass | null = null;
  let tier = opts.tier;
  let width = 1, height = 1, ratio = 1;

  const ensureComposer = (scene: Scene, camera: Camera): EffectComposer | null => {
    if (!tier.bloom) return null;
    if (!composer) {
      composer = new EffectComposer(r);
      renderPass = new RenderPass(scene, camera);
      bloom = new UnrealBloomPass(new Vector2(width, height), tier.bloomStrength, 0.4, 0.92);
      composer.addPass(renderPass);
      composer.addPass(bloom);
      composer.addPass(new OutputPass());
      composer.setPixelRatio(ratio);
      composer.setSize(width, height);
    }
    if (renderPass) {
      renderPass.scene = scene;
      renderPass.camera = camera;
    }
    return composer;
  };

  const disposeComposer = (): void => {
    if (!composer) return;
    bloom?.dispose();
    composer.dispose();
    composer = null;
    bloom = null;
    renderPass = null;
  };

  const backend: RenderBackend = {
    kind: "webgl",
    renderer: r,
    webgl: r,
    supportsGlsl: true,
    environment: envRT.texture,
    setTier(t) {
      tier = t;
      r.shadowMap.enabled = t.shadows;
      if (!t.bloom) disposeComposer();
      else if (bloom) bloom.strength = t.bloomStrength;
    },
    setSize(w, h) {
      width = Math.max(1, w);
      height = Math.max(1, h);
      r.setSize(width, height, false);
      composer?.setSize(width, height);
    },
    setPixelRatio(p) {
      ratio = p;
      r.setPixelRatio(p);
      composer?.setPixelRatio(p);
    },
    get pixelRatio() { return ratio; },
    render(scene, camera) {
      r.info.reset();
      const c = ensureComposer(scene, camera);
      if (c) c.render();
      else r.render(scene, camera);
    },
    dispose() {
      disposeComposer();
      envRT.dispose();
      r.dispose();
    },
  };
  backend.setTier(opts.tier);
  return backend;
}

/**
 * Adaptive resolution: lowers the pixel ratio when the smoothed frame time stays
 * above target, raises it back when there is headroom. Pure logic (testable).
 */
export class AdaptiveResolution {
  private ema = 0;
  private overFor = 0;
  private underFor = 0;
  ratio: number;
  min: number;
  max: number;
  targetMs: number;
  enabled = true;

  constructor(opts: { min: number; max: number; targetFps: number; initial?: number }) {
    this.min = opts.min;
    this.max = opts.max;
    this.ratio = opts.initial ?? opts.max;
    this.targetMs = 1000 / opts.targetFps;
  }

  configure(min: number, max: number, targetFps: number): void {
    this.min = min;
    this.max = max;
    this.targetMs = 1000 / targetFps;
    this.ratio = Math.min(max, Math.max(min, this.ratio));
  }

  /** Feed a frame time; returns the new ratio when it changed, otherwise null. */
  sample(frameMs: number): number | null {
    if (!this.enabled || frameMs <= 0 || frameMs > 1000) return null;
    this.ema = this.ema === 0 ? frameMs : this.ema * 0.92 + frameMs * 0.08;
    if (this.ema > this.targetMs * 1.18) {
      this.overFor += frameMs;
      this.underFor = 0;
    } else if (this.ema < this.targetMs * 0.8) {
      this.underFor += frameMs;
      this.overFor = 0;
    } else {
      this.overFor = 0;
      this.underFor = 0;
    }
    if (this.overFor > 1500 && this.ratio > this.min) {
      this.ratio = Math.max(this.min, Math.round((this.ratio - 0.1) * 100) / 100);
      this.overFor = 0;
      return this.ratio;
    }
    if (this.underFor > 5000 && this.ratio < this.max) {
      this.ratio = Math.min(this.max, Math.round((this.ratio + 0.05) * 100) / 100);
      this.underFor = 0;
      return this.ratio;
    }
    return null;
  }

  get smoothedFrameMs(): number {
    return this.ema;
  }
}
