import { BoxGeometry, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial } from "three";
import { describe, expect, it } from "vitest";
import { SHIPS } from "@nebula/config";
import { ShipFactory } from "./ShipFactory.js";
import { MaterialLibrary } from "./materials.js";
import { resolveLook } from "./cosmetics.js";

function fakeGlb(): Group {
  const g = new Group();
  const primary = new Mesh(new BoxGeometry(1, 0.5, 4), new MeshStandardMaterial({ name: "primary" }));
  primary.name = "primary";
  const custom = new Mesh(new BoxGeometry(0.2, 0.2, 0.2), new MeshStandardMaterial({ name: "decal" }));
  custom.name = "decal";
  g.add(primary, custom);
  return g;
}

describe("ShipModel.attachGlb", () => {
  const ship = SHIPS[0];
  if (!ship) throw new Error("no ships in config");

  it("re-skins slot meshes with the ship's materials, hides the procedural high LOD and fits the bounds", () => {
    const materials = new MaterialLibrary({ textureSize: 32, physical: false });
    const factory = new ShipFactory({ materials, greebles: false, lodBias: 1 });
    const model = factory.createFromDef(ship);
    const high = model.lod.levels[0]?.object;
    const procedural = [...(high?.children ?? [])];
    const glb = fakeGlb();
    model.attachGlb(glb);
    expect(model.hasGlb).toBe(true);
    for (const c of procedural) expect(c.visible).toBe(false);
    expect(glb.parent).toBe(high);
    const [primary, custom] = glb.children as Mesh[];
    expect(primary?.material).toBe(model.materials.primary);
    expect((custom?.material as MeshStandardMaterial).name).toBe("decal");
    // 4 units long fake asset scaled to the procedural forward extent.
    const targetZ = model.bounds.max.z - model.bounds.min.z;
    expect(glb.scale.z).toBeCloseTo(targetZ / 4, 5);

    // Cloak override + restore keeps slot / embedded materials.
    const cloak = new MeshBasicMaterial();
    model.overrideMaterial(cloak);
    expect(primary?.material).toBe(cloak);
    model.overrideMaterial(null);
    expect(primary?.material).toBe(model.materials.primary);
    expect((custom?.material as MeshStandardMaterial).name).toBe("decal");

    // Only the first GLB is attached.
    const second = fakeGlb();
    model.attachGlb(second);
    expect(second.parent).toBeNull();
    model.dispose();
    factory.dispose();
    materials.dispose();
  });

  it("geometry-changing hull skins drop the production GLB (it would no longer match)", () => {
    const withGlb = { ...ship.visual, glb: "/models/ships/x.glb" };
    expect(resolveLook(withGlb, [{ slot: "HULL_SKIN", colors: ["#ff0000"] }]).visual.glb).toBe("/models/ships/x.glb");
    expect(resolveLook(withGlb, [{ slot: "HULL_SKIN", geometry: { wings: "delta" } }]).visual.glb).toBeUndefined();
  });
});
