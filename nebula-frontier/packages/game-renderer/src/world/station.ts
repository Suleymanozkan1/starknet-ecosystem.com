import { type BufferGeometry, Group, Mesh, MeshStandardMaterial, Color } from "three";
import { createRng } from "../core/random.js";
import { PartCollector, box, chamferBox, cyl, cylZ, latheZ, sphere, torus, transform } from "../ship/geometry.js";
import { MaterialSlot, type MaterialLibrary, type ShipPalette } from "../ship/materials.js";

export interface StationOptions {
  id: string;
  palette: ShipPalette;
  /** Broken ruin variant (decor). */
  ruined?: boolean;
  scale?: number;
}

/**
 * Modular space station generated from a seed: core spindle, rotating habitat
 * ring(s), spokes, docking arms with guide lights, solar arrays, comms mast.
 */
export class StationVisual {
  readonly root = new Group();
  private readonly ring = new Group();
  private readonly geos: BufferGeometry[] = [];
  private readonly solarMat: MeshStandardMaterial;
  readonly radius: number;
  private readonly spin: number;

  constructor(lib: MaterialLibrary, opts: StationOptions) {
    const rng = createRng(opts.id);
    const s = opts.scale ?? 1;
    const R = 11 * s;
    this.radius = R * 1.5;
    this.spin = rng.range(0.03, 0.08) * rng.sign();
    const mats = lib.get(opts.palette, opts.ruined ? "wreck" : "");
    this.solarMat = new MeshStandardMaterial({ color: new Color("#1d3b8a"), metalness: 0.9, roughness: 0.25, emissive: new Color("#0a1a44"), emissiveIntensity: opts.ruined ? 0 : 0.6 });

    // --- static core -----------------------------------------------------------------
    const core = new PartCollector(0.35);
    core.add(MaterialSlot.PRIMARY, transform(latheZ([[0.001, R * 0.55], [R * 0.18, R * 0.5], [R * 0.24, R * 0.3], [R * 0.24, -R * 0.3], [R * 0.3, -R * 0.36], [R * 0.3, -R * 0.44], [0.001, -R * 0.5]], 24), [0, 0, 0], [-Math.PI / 2, 0, 0]));
    core.add(MaterialSlot.SECONDARY, transform(cyl(R * 0.36, R * 0.36, R * 0.16, 24), [0, R * 0.05, 0]));
    core.add(MaterialSlot.GLOW, transform(torus(R * 0.37, R * 0.012, 4, 32), [0, R * 0.14, 0], [Math.PI / 2, 0, 0]));
    // docking arms
    const arms = rng.int(2, 4);
    for (let i = 0; i < arms; i++) {
      if (opts.ruined && rng() < 0.4) continue;
      const a = (i / arms) * Math.PI * 2 + rng.range(-0.2, 0.2);
      const len = R * rng.range(0.55, 0.8);
      const cx = Math.cos(a), cz = Math.sin(a);
      core.add(MaterialSlot.TRIM, transform(chamferBox(R * 0.1, R * 0.08, len, R * 0.02), [cx * (R * 0.3 + len / 2), 0, cz * (R * 0.3 + len / 2)], [0, Math.PI / 2 - a, 0]));
      core.add(MaterialSlot.SECONDARY, transform(chamferBox(R * 0.22, R * 0.12, R * 0.18, R * 0.03), [cx * (R * 0.3 + len), 0, cz * (R * 0.3 + len)], [0, Math.PI / 2 - a, 0]));
      for (let k = 1; k < 5; k++) {
        core.add(MaterialSlot.GLOW, transform(box(R * 0.03, R * 0.03, R * 0.03), [cx * (R * 0.3 + (len * k) / 5), R * 0.06, cz * (R * 0.3 + (len * k) / 5)]));
      }
    }
    // solar arrays
    const panels = rng.int(1, 2);
    for (let i = 0; i < panels; i++) {
      const y = -R * (0.15 + i * 0.12);
      core.add(MaterialSlot.TRIM, transform(box(R * 2.4, R * 0.02, R * 0.03), [0, y, 0], [0, i * 1.1, 0]));
    }
    // comms mast
    core.add(MaterialSlot.TRIM, transform(cyl(R * 0.012, R * 0.02, R * 0.5, 6), [0, R * 0.8, 0]));
    core.add(MaterialSlot.GLOW, transform(sphere(R * 0.03, 8, 6), [0, R * 1.06, 0]));
    core.add(MaterialSlot.SECONDARY, transform(latheZ([[0.001, 0], [R * 0.12, -R * 0.02], [R * 0.18, -R * 0.08]], 16), [R * 0.1, R * 0.62, 0], [-1.2, 0, 0]));
    this.addGroup(core.merge(), mats, this.root);

    for (let i = 0; i < panels; i++) {
      const y = -R * (0.15 + i * 0.12);
      for (const side of [1, -1]) {
        if (opts.ruined && rng() < 0.5) continue;
        const g = transform(box(R * 0.7, R * 0.01, R * 0.32), [side * R * 0.85, y, 0], [0, 0, 0]);
        g.rotateY(i * 1.1);
        this.geos.push(g);
        const m = new Mesh(g, this.solarMat);
        m.receiveShadow = true;
        this.root.add(m);
      }
    }

    // --- rotating habitat ring --------------------------------------------------------
    const ring = new PartCollector(0.35);
    const ringR = R * 0.95;
    const hab = latheZ([[ringR - R * 0.08, R * 0.07], [ringR + R * 0.08, R * 0.07], [ringR + R * 0.1, 0], [ringR + R * 0.08, -R * 0.07], [ringR - R * 0.08, -R * 0.07], [ringR - R * 0.1, 0], [ringR - R * 0.08, R * 0.07]], 48, 0, opts.ruined ? Math.PI * 1.35 : Math.PI * 2);
    hab.rotateX(Math.PI / 2);
    ring.add(MaterialSlot.PRIMARY, hab);
    ring.add(MaterialSlot.GLOW, transform(torus(ringR + R * 0.1, R * 0.008, 3, 64), [0, 0, 0], [Math.PI / 2, 0, 0]));
    const spokes = opts.ruined ? 2 : 4;
    for (let i = 0; i < spokes; i++) {
      const a = (i / 4) * Math.PI * 2;
      ring.add(MaterialSlot.TRIM, transform(cylZ(R * 0.025, R * 0.025, ringR - R * 0.35, 8), [Math.cos(a) * (ringR + R * 0.35) / 2, 0, Math.sin(a) * (ringR + R * 0.35) / 2], [0, Math.PI / 2 - a, 0]));
    }
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      if (opts.ruined && a > Math.PI * 1.35) continue;
      ring.add(MaterialSlot.SECONDARY, transform(chamferBox(R * 0.14, R * 0.16, R * 0.2, R * 0.03), [Math.cos(a) * ringR, R * 0.02, Math.sin(a) * ringR], [0, -a, 0]));
    }
    this.addGroup(ring.merge(), mats, this.ring);
    this.ring.position.y = R * 0.05;
    this.root.add(this.ring);
    if (opts.ruined) this.root.rotation.set(rng.range(-0.25, 0.25), 0, rng.range(-0.25, 0.25));
  }

  private addGroup(geos: Map<MaterialSlot, BufferGeometry>, mats: ReturnType<MaterialLibrary["get"]>, parent: Group): void {
    for (const [slot, g] of geos) {
      this.geos.push(g);
      const m = new Mesh(g, mats[slot]);
      m.castShadow = slot !== "glow" && slot !== "engine";
      m.receiveShadow = true;
      parent.add(m);
    }
  }

  update(time: number): void {
    this.ring.rotation.y = time * this.spin;
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const g of this.geos) g.dispose();
    this.solarMat.dispose();
  }
}
