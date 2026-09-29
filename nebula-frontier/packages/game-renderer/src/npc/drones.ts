import { type BufferGeometry, Group, Mesh } from "three";
import type { DroneDef } from "@nebula/shared";
import { PartCollector, box, chamferBox, cylZ, octa, sphere, torus, transform } from "../ship/geometry.js";
import { MaterialSlot, type MaterialLibrary } from "../ship/materials.js";

type DroneShape = DroneDef["visual"]["shape"];

function build(shape: DroneShape): Map<MaterialSlot, BufferGeometry> {
  const pc = new PartCollector(2);
  switch (shape) {
    case "orb":
      pc.add(MaterialSlot.PRIMARY, sphere(0.35, 16, 12));
      pc.add(MaterialSlot.GLOW, transform(torus(0.37, 0.04, 4, 24), [0, 0, 0], [Math.PI / 2, 0, 0]));
      pc.add(MaterialSlot.GLOW, transform(sphere(0.12, 8, 6), [0, 0, 0.3]));
      break;
    case "dart":
      pc.add(MaterialSlot.PRIMARY, cylZ(0.02, 0.2, 0.8, 6));
      pc.addMirrored(MaterialSlot.SECONDARY, transform(box(0.35, 0.04, 0.25), [0.2, 0, -0.15], [0, -0.4, 0]));
      pc.add(MaterialSlot.ENGINE, transform(cylZ(0.12, 0.12, 0.05, 8), [0, 0, -0.42]));
      break;
    case "ring":
      pc.add(MaterialSlot.PRIMARY, transform(torus(0.35, 0.1, 6, 20), [0, 0, 0], [Math.PI / 2, 0, 0]));
      pc.add(MaterialSlot.GLOW, sphere(0.12, 10, 8));
      break;
    case "claw":
      pc.add(MaterialSlot.PRIMARY, chamferBox(0.4, 0.2, 0.4, 0.08));
      pc.addMirrored(MaterialSlot.SECONDARY, transform(box(0.06, 0.08, 0.45), [0.18, 0, 0.3], [0, -0.3, 0]));
      pc.add(MaterialSlot.GLOW, transform(box(0.2, 0.05, 0.05), [0, 0.11, 0.1]));
      break;
    case "prism":
      pc.add(MaterialSlot.ACCENT, transform(octa(0.4), [0, 0, 0], [0, 0, 0], [0.7, 1, 0.7]));
      pc.add(MaterialSlot.TRIM, transform(torus(0.32, 0.03, 4, 16), [0, 0, 0], [Math.PI / 2, 0, 0]));
      break;
  }
  return pc.merge();
}

/** Small companion drones (orb / dart / ring / claw / prism), geometry cached per shape. */
export class DroneFactory {
  private readonly cache = new Map<DroneShape, Map<MaterialSlot, BufferGeometry>>();
  private readonly lib: MaterialLibrary;

  constructor(lib: MaterialLibrary) {
    this.lib = lib;
  }

  create(shape: DroneShape, color: string): Group {
    let geos = this.cache.get(shape);
    if (!geos) {
      geos = build(shape);
      this.cache.set(shape, geos);
    }
    const mats = this.lib.get({ primary: "#3c424e", secondary: "#262a31", accent: color, engine: color });
    const g = new Group();
    for (const [slot, geo] of geos) {
      const m = new Mesh(geo, mats[slot]);
      m.name = slot;
      g.add(m);
    }
    return g;
  }

  dispose(): void {
    for (const geos of this.cache.values()) for (const g of geos.values()) g.dispose();
    this.cache.clear();
  }
}
