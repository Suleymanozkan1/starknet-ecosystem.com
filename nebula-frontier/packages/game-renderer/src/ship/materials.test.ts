import { MeshPhysicalMaterial, MeshStandardMaterial } from "three";
import { describe, expect, it } from "vitest";
import { MATERIAL_SLOTS, MaterialLibrary } from "./materials.js";

const palette = { primary: "#c9d6e3", secondary: "#2b3544", accent: "#4ad8ff", engine: "#7cf" };

describe("MaterialLibrary (PBR ship materials)", () => {
  it("hull materials are full PBR: base color, normal, roughness, metalness, AO and emission maps", () => {
    const lib = new MaterialLibrary({ textureSize: 64, physical: false });
    const set = lib.get(palette);
    const hull = set.primary as MeshStandardMaterial;
    expect(hull).toBeInstanceOf(MeshStandardMaterial);
    expect(hull.map).toBeTruthy();
    expect(hull.normalMap).toBeTruthy();
    expect(hull.roughnessMap).toBeTruthy();
    expect(hull.metalnessMap).toBeTruthy();
    expect(hull.aoMap).toBeTruthy();
    expect(hull.emissiveMap).toBeTruthy();
    for (const slot of MATERIAL_SLOTS) expect(set[slot]).toBeTruthy();
    lib.dispose();
  });

  it("high tiers use physical materials (clearcoat)", () => {
    const lib = new MaterialLibrary({ textureSize: 64, physical: true });
    expect(lib.get(palette).primary).toBeInstanceOf(MeshPhysicalMaterial);
    lib.dispose();
  });

  it("materials are cached per palette (shared, not re-created per ship)", () => {
    const lib = new MaterialLibrary({ textureSize: 64, physical: false });
    expect(lib.get(palette)).toBe(lib.get({ ...palette }));
    expect(lib.get(palette)).not.toBe(lib.get(palette, "wreck"));
    lib.dispose();
  });

  it("dispose() releases every material (no GPU leak)", () => {
    const lib = new MaterialLibrary({ textureSize: 64, physical: false });
    const set = lib.get(palette);
    let disposed = 0;
    for (const m of Object.values(set)) m.addEventListener("dispose", () => { disposed++; });
    lib.dispose();
    expect(disposed).toBe(Object.keys(set).length);
  });
});
