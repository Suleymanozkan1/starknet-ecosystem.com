import { describe, expect, it } from "vitest";
import { TIER_SETTINGS, classifyGpu, detectGraphicsTier, isMobileUserAgent, resolveTier, type DeviceCaps } from "./tiers.js";

const base: DeviceCaps = {
  webgl2: true, gpuRenderer: "", maxTextureSize: 16384, maxSamples: 8, deviceMemory: 8, hardwareConcurrency: 8,
  isMobile: false, devicePixelRatio: 1, hasWebGPU: false, screenPixels: 1920 * 1080,
};

describe("graphics tier detection", () => {
  it("classifies GPU renderer strings", () => {
    expect(classifyGpu("ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 Direct3D11)", false)).toBe("discrete-high");
    expect(classifyGpu("ANGLE (NVIDIA GeForce GTX 1060)", false)).toBe("discrete");
    expect(classifyGpu("ANGLE (Intel, Intel(R) UHD Graphics 620)", false)).toBe("integrated");
    expect(classifyGpu("Adreno (TM) 740", true)).toBe("mobile-high");
    expect(classifyGpu("Mali-G52", true)).toBe("mobile");
    expect(classifyGpu("Google SwiftShader", false)).toBe("software");
    expect(classifyGpu("", false)).toBe("unknown");
  });

  it("maps devices to tiers", () => {
    expect(detectGraphicsTier({ ...base, gpuRenderer: "NVIDIA GeForce RTX 3080" })).toBe("ULTRA");
    expect(detectGraphicsTier({ ...base, gpuRenderer: "NVIDIA GeForce GTX 1060", deviceMemory: 8, hardwareConcurrency: 4 })).toBe("HIGH");
    expect(detectGraphicsTier({ ...base, gpuRenderer: "Intel(R) UHD Graphics 620", deviceMemory: 8, hardwareConcurrency: 4 })).toBe("MEDIUM");
    expect(detectGraphicsTier({ ...base, gpuRenderer: "Intel HD Graphics 4000", deviceMemory: 2, hardwareConcurrency: 2 })).toBe("LOW");
    expect(detectGraphicsTier({ ...base, gpuRenderer: "SwiftShader" })).toBe("LOW");
    expect(detectGraphicsTier({ ...base, webgl2: false, gpuRenderer: "NVIDIA GeForce RTX 4090" })).toBe("LOW");
  });

  it("caps mobile devices", () => {
    const flagship = detectGraphicsTier({ ...base, isMobile: true, gpuRenderer: "Adreno (TM) 750", deviceMemory: 8, hardwareConcurrency: 8 });
    expect(["HIGH", "MEDIUM"]).toContain(flagship);
    const budget = detectGraphicsTier({ ...base, isMobile: true, gpuRenderer: "Mali-G52", deviceMemory: 3, hardwareConcurrency: 8 });
    expect(["LOW", "MEDIUM"]).toContain(budget);
    expect(detectGraphicsTier({ ...base, isMobile: true, gpuRenderer: "NVIDIA GeForce RTX 4090" })).not.toBe("ULTRA");
  });

  it("detects mobile user agents incl. iPadOS", () => {
    expect(isMobileUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8)")).toBe(true);
    expect(isMobileUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)")).toBe(true);
    expect(isMobileUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5, "MacIntel")).toBe(true);
    expect(isMobileUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe(false);
  });

  it("respects explicit tiers and has monotonic budgets", () => {
    expect(resolveTier("LOW", base)).toBe("LOW");
    expect(resolveTier("AUTO", { ...base, gpuRenderer: "NVIDIA GeForce RTX 3080" })).toBe("ULTRA");
    const order = ["LOW", "MEDIUM", "HIGH", "ULTRA"] as const;
    for (let i = 1; i < order.length; i++) {
      const a = TIER_SETTINGS[order[i - 1] as (typeof order)[number]], b = TIER_SETTINGS[order[i] as (typeof order)[number]];
      expect(b.particleBudget).toBeGreaterThan(a.particleBudget);
      expect(b.maxPixelRatio).toBeGreaterThanOrEqual(a.maxPixelRatio);
      expect(b.starCount).toBeGreaterThan(a.starCount);
    }
    expect(TIER_SETTINGS.LOW.bloom).toBe(false);
    expect(TIER_SETTINGS.MEDIUM.bloom).toBe(false);
    expect(TIER_SETTINGS.HIGH.bloom).toBe(true);
  });
});
