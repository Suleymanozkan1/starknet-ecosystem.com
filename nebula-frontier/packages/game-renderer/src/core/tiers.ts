import { GraphicsTier } from "@nebula/shared";

/** Everything the tier heuristic looks at. Pure data so it is unit-testable in node. */
export interface DeviceCaps {
  webgl2: boolean;
  /** UNMASKED_RENDERER_WEBGL string (or "" if unavailable). */
  gpuRenderer: string;
  maxTextureSize: number;
  maxSamples: number;
  /** navigator.deviceMemory in GB (Chrome only). */
  deviceMemory?: number;
  hardwareConcurrency?: number;
  isMobile: boolean;
  devicePixelRatio: number;
  hasWebGPU: boolean;
  screenPixels: number;
}

export type GpuClass = "discrete-high" | "discrete" | "integrated" | "mobile-high" | "mobile" | "software" | "unknown";

export interface TierSettings {
  tier: GraphicsTier;
  /** Upper bound for renderer pixel ratio (clamped by devicePixelRatio). */
  maxPixelRatio: number;
  /** Lower bound for adaptive resolution. */
  minPixelRatio: number;
  antialias: boolean;
  shadows: boolean;
  shadowMapSize: number;
  bloom: boolean;
  bloomStrength: number;
  /** Physical/clearcoat materials for hulls. */
  physicalMaterials: boolean;
  /** Procedural texture resolution. */
  textureSize: number;
  /** Max live GPU particles per particle layer. */
  particleBudget: number;
  /** Max simultaneous ribbon trails. */
  trailBudget: number;
  trailSegments: number;
  /** Max projectiles/bolts drawn. */
  projectileBudget: number;
  /** Max explosions/debris sets alive. */
  debrisBudget: number;
  greebles: boolean;
  /** LOD distance multiplier (higher = keep high detail further). */
  lodBias: number;
  starCount: number;
  dustCount: number;
  asteroidDetail: number;
  /** Target FPS for adaptive resolution. */
  targetFps: number;
  anisotropy: number;
  /** Allow WebGPU backend when user setting = auto. */
  allowWebGPU: boolean;
}

export const TIER_SETTINGS: Readonly<Record<GraphicsTier, TierSettings>> = {
  ULTRA: {
    tier: "ULTRA", maxPixelRatio: 2, minPixelRatio: 1, antialias: true, shadows: true, shadowMapSize: 2048,
    bloom: true, bloomStrength: 0.6, physicalMaterials: true, textureSize: 512, particleBudget: 6000,
    trailBudget: 96, trailSegments: 40, projectileBudget: 768, debrisBudget: 48, greebles: true, lodBias: 1.6,
    starCount: 9000, dustCount: 1400, asteroidDetail: 4, targetFps: 60, anisotropy: 8, allowWebGPU: true,
  },
  HIGH: {
    tier: "HIGH", maxPixelRatio: 1.5, minPixelRatio: 0.85, antialias: true, shadows: true, shadowMapSize: 1024,
    bloom: true, bloomStrength: 0.5, physicalMaterials: false, textureSize: 256, particleBudget: 3500,
    trailBudget: 64, trailSegments: 28, projectileBudget: 512, debrisBudget: 32, greebles: true, lodBias: 1.2,
    starCount: 6000, dustCount: 900, asteroidDetail: 3, targetFps: 60, anisotropy: 4, allowWebGPU: false,
  },
  MEDIUM: {
    tier: "MEDIUM", maxPixelRatio: 1.25, minPixelRatio: 0.75, antialias: false, shadows: false, shadowMapSize: 512,
    bloom: false, bloomStrength: 0, physicalMaterials: false, textureSize: 256, particleBudget: 1800,
    trailBudget: 32, trailSegments: 18, projectileBudget: 320, debrisBudget: 16, greebles: false, lodBias: 0.9,
    starCount: 3500, dustCount: 450, asteroidDetail: 2, targetFps: 45, anisotropy: 2, allowWebGPU: false,
  },
  LOW: {
    tier: "LOW", maxPixelRatio: 1, minPixelRatio: 0.6, antialias: false, shadows: false, shadowMapSize: 256,
    bloom: false, bloomStrength: 0, physicalMaterials: false, textureSize: 128, particleBudget: 800,
    trailBudget: 16, trailSegments: 10, projectileBudget: 192, debrisBudget: 8, greebles: false, lodBias: 0.6,
    starCount: 1800, dustCount: 200, asteroidDetail: 1, targetFps: 30, anisotropy: 1, allowWebGPU: false,
  },
};

const HIGH_END_GPU = /(rtx\s?[2-9]0|rtx\s?a\d|radeon rx\s?[67]\d{3}|radeon pro|apple m[1-9] (pro|max|ultra)|apple m[2-9]|arc a7)/i;
const DISCRETE_GPU = /(nvidia|geforce|quadro|radeon|rx\s?\d{3,4}|arc a\d)/i;
const INTEGRATED_GPU = /(intel|iris|uhd|hd graphics|vega \d+ graphics|radeon\(tm\) graphics|apple m1|apple gpu)/i;
const MOBILE_HIGH_GPU = /(adreno \(tm\) (7[3-9]\d|8\d\d)|adreno 7[3-9]\d|mali-g7[1-9]|mali-g[7-9]\d{2}|immortalis|apple a1[5-9])/i;
const MOBILE_GPU = /(adreno|mali|powervr|apple a\d|videocore|tegra)/i;
const SOFTWARE_GPU = /(swiftshader|llvmpipe|software|microsoft basic render|softpipe)/i;

export function classifyGpu(renderer: string, isMobile: boolean): GpuClass {
  const r = renderer.toLowerCase();
  if (!r) return "unknown";
  if (SOFTWARE_GPU.test(r)) return "software";
  if (MOBILE_HIGH_GPU.test(r)) return "mobile-high";
  if (MOBILE_GPU.test(r) || (isMobile && r.includes("apple"))) return isMobile ? "mobile" : "integrated";
  if (HIGH_END_GPU.test(r)) return "discrete-high";
  if (INTEGRATED_GPU.test(r) && !/nvidia|geforce/.test(r)) return "integrated";
  if (DISCRETE_GPU.test(r)) return "discrete";
  return "unknown";
}

/**
 * Pick a graphics tier from device capabilities.
 * Scoring combines GPU class, memory, cores, and screen size; mobile is capped at HIGH.
 */
export function detectGraphicsTier(caps: DeviceCaps): GraphicsTier {
  if (!caps.webgl2) return GraphicsTier.LOW;
  const gpu = classifyGpu(caps.gpuRenderer, caps.isMobile);
  if (gpu === "software") return GraphicsTier.LOW;

  let score = 0;
  switch (gpu) {
    case "discrete-high": score += 6; break;
    case "discrete": score += 4; break;
    case "integrated": score += 2; break;
    case "mobile-high": score += 2; break;
    case "mobile": score += 0; break;
    case "unknown": score += 2; break;
  }
  const mem = caps.deviceMemory;
  if (mem !== undefined) {
    if (mem >= 8) score += 1;
    else if (mem <= 2) score -= 2;
    else if (mem <= 4) score -= 1;
  }
  const cores = caps.hardwareConcurrency;
  if (cores !== undefined) {
    if (cores >= 8) score += 1;
    else if (cores <= 2) score -= 2;
    else if (cores <= 4) score -= 1;
  }
  if (caps.maxTextureSize < 4096) score -= 2;
  if (caps.maxSamples < 4) score -= 1;
  // Very large framebuffers (4K+) cost a lot of fill-rate.
  if (caps.screenPixels * caps.devicePixelRatio * caps.devicePixelRatio > 8_000_000) score -= 1;

  let tier: GraphicsTier;
  if (score >= 7) tier = GraphicsTier.ULTRA;
  else if (score >= 4) tier = GraphicsTier.HIGH;
  else if (score >= 2) tier = GraphicsTier.MEDIUM;
  else tier = GraphicsTier.LOW;

  if (caps.isMobile) {
    if (tier === GraphicsTier.ULTRA) tier = GraphicsTier.HIGH;
    if (gpu === "mobile" && tier === GraphicsTier.HIGH) tier = GraphicsTier.MEDIUM;
  }
  return tier;
}

const MOBILE_UA = /android|iphone|ipad|ipod|mobile|silk|kindle|opera mini|iemobile/i;

export function isMobileUserAgent(ua: string, maxTouchPoints = 0, platform = ""): boolean {
  if (MOBILE_UA.test(ua)) return true;
  // iPadOS 13+ reports as Mac
  return /mac/i.test(platform) && maxTouchPoints > 1;
}

interface NavigatorExt extends Navigator {
  deviceMemory?: number;
  gpu?: unknown;
}

/** Browser-only probe of the device. Creates (and releases) a throwaway WebGL2 context. */
export function probeDeviceCaps(): DeviceCaps {
  const nav = (typeof navigator !== "undefined" ? navigator : undefined) as NavigatorExt | undefined;
  const ua = nav?.userAgent ?? "";
  const isMobile = isMobileUserAgent(ua, nav?.maxTouchPoints ?? 0, nav?.platform ?? "");
  const caps: DeviceCaps = {
    webgl2: false,
    gpuRenderer: "",
    maxTextureSize: 0,
    maxSamples: 0,
    deviceMemory: nav?.deviceMemory,
    hardwareConcurrency: nav?.hardwareConcurrency,
    isMobile,
    devicePixelRatio: typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
    hasWebGPU: !!nav && "gpu" in nav && !!nav.gpu,
    screenPixels: typeof screen !== "undefined" ? screen.width * screen.height : 1920 * 1080,
  };
  if (typeof document === "undefined") return caps;
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2", { failIfMajorPerformanceCaveat: false });
  if (!gl) return caps;
  caps.webgl2 = true;
  caps.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  caps.maxSamples = gl.getParameter(gl.MAX_SAMPLES) as number;
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  caps.gpuRenderer = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return caps;
}

export function resolveTier(requested: GraphicsTier | "AUTO" | undefined, caps?: DeviceCaps): GraphicsTier {
  if (requested && requested !== "AUTO") return requested;
  return detectGraphicsTier(caps ?? probeDeviceCaps());
}
