import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import { TIER_SETTINGS } from "../core/tiers.js";
import { EffectsSystem } from "./EffectsSystem.js";
import { ProjectileStyle, ProjectileSystem } from "./projectiles.js";
import { ParticleLayer } from "./particles.js";

describe("effects pools (headless)", () => {
  it("projectiles respect their budget and report impacts", () => {
    const p = new ProjectileSystem(16);
    p.setBudget(8);
    const a = new Vector3(0, 0, 0), b = new Vector3(10, 0, 0);
    let spawned = 0;
    for (let i = 0; i < 20; i++) if (p.spawn(a, b, "#ff0000", ProjectileStyle.BOLT, 0.5, 0)) spawned++;
    expect(spawned).toBe(8);
    const impacts: number[] = [];
    p.onImpact = (i) => impacts.push(i.x);
    p.update(0.25);
    expect(p.mesh.count).toBe(8);
    p.update(1);
    expect(impacts).toHaveLength(8);
    expect(p.active).toBe(0);
    expect(p.mesh.count).toBe(0);
    p.dispose();
  });

  it("particle ring buffer wraps within the budget and uploads only dirty ranges", () => {
    const layer = new ParticleLayer(64, "additive");
    layer.setBudget(32);
    for (let i = 0; i < 40; i++) layer.emit(i, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1);
    layer.update(0.1);
    const pos = layer.points.geometry.attributes.position;
    expect(pos?.getX(0)).toBe(32); // wrapped: slot 0 overwritten by particle #32
    expect(pos?.updateRanges.length).toBe(1);
    layer.dispose();
  });

  it("EffectsSystem runs every effect type headless without exceeding tier budgets", () => {
    const fx = new EffectsSystem(TIER_SETTINGS.LOW);
    const v = new Vector3(1, 0, 1);
    const w = new Vector3(20, 0, 5);
    for (const style of ["beam", "bolt", "slug", "missile", "torpedo", "wave", "mine"]) fx.fire(v, w, "#48cae4", style, 0.3);
    fx.explosion(v, 2, ["#fff", "#f80", "#f00"], "supernova");
    fx.emp(v, 10);
    fx.energyPulse(v, 5, "#52ffa8");
    fx.warpFlash(v, 1, 0);
    let done = false;
    fx.telegraph(v, 8, "#ff2d55", 0.2, () => { done = true; });
    for (let t = 0; t < 60; t++) {
      fx.damageEmit(v, 0.2, 1 / 60, 3);
      fx.miningChips(v, "#ffd166", 1 / 60);
      fx.update(t / 60, 1 / 60);
    }
    expect(done).toBe(true);
    expect(fx.projectiles.active).toBeLessThanOrEqual(TIER_SETTINGS.LOW.projectileBudget);
    for (let i = 0; i < TIER_SETTINGS.LOW.trailBudget + 5; i++) fx.trails.acquire({ color: "#fff", width: 0.3 }, v);
    expect(fx.trails.active).toBe(TIER_SETTINGS.LOW.trailBudget);
    fx.dispose();
  });
});
