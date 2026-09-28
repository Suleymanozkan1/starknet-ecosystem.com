import {
  AdditiveBlending, Color, Group, Mesh, MeshBasicMaterial, type MeshStandardMaterial, type BufferGeometry, Vector3,
} from "three";
import type { BossPhaseDef, NpcDef } from "@nebula/shared";
import { createRng } from "../core/random.js";
import { chamferBox, cyl, prepare, sphere, torus, transform } from "../ship/geometry.js";
import type { ShipFactory, ShipModel } from "../ship/ShipFactory.js";
import { npcVisual } from "../ship/cosmetics.js";

export type BossLayer = BossPhaseDef["layer"];

const ENRAGE_CORE = new Color("#ff2020");
const ENRAGE_ACCENT = new Color("#ff1a1a");
const ENRAGE_GLOW = new Color("#ff3030");

interface Plate { mesh: Mesh; blown: boolean; offset: Vector3 }

/**
 * Huge multi-part boss: procedural hull + detachable armour plates, shield
 * pylons, glowing weak points and a hatch-covered reactor core. `setPhase`
 * changes the look (SHIELD → ARMOR → REACTOR → ENRAGE).
 */
export class BossVisual {
  readonly root = new Group();
  readonly model: ShipModel;
  readonly length: number;
  readonly weakPoints: Vector3[] = [];
  private readonly extras = new Group();
  private readonly plates: Plate[] = [];
  private readonly pylonOrbs: Mesh[] = [];
  private readonly weakMeshes: Mesh[] = [];
  private readonly hatch: Mesh[] = [];
  private readonly core: Mesh;
  private readonly geos: BufferGeometry[] = [];
  private readonly weakMat: MeshBasicMaterial;
  private readonly pylonMat: MeshBasicMaterial;
  private readonly coreMat: MeshBasicMaterial;
  private readonly accentMat: MeshStandardMaterial;
  private readonly glowMat: MeshBasicMaterial;
  private readonly accent: Color;
  private layer: BossLayer = "SHIELD";
  private hatchOpen = 0;
  private enrage = 0;
  /** Called when armour plates are blown off (for debris/explosion FX). */
  onPlateBlown: ((worldPos: Vector3) => void) | null = null;

  constructor(factory: ShipFactory, npc: Pick<NpcDef, "id" | "visual" | "kind">) {
    const visual = npcVisual(npc);
    this.length = visual.length;
    this.model = factory.create(visual, { variant: "boss" });
    this.root.add(this.model.root);
    this.root.add(this.extras);
    const L = this.length;
    const rng = createRng(npc.id);
    this.accent = new Color(npc.visual.accent);

    // own copies of emissive materials so phase changes do not leak to other bosses
    this.accentMat = (this.model.materials.accent as MeshStandardMaterial).clone();
    this.glowMat = (this.model.materials.glow as MeshBasicMaterial).clone();
    this.model.lod.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh) return;
      if (m.name === "accent") m.material = this.accentMat;
      if (m.name === "glow") m.material = this.glowMat;
    });

    const plateMat = this.model.materials.secondary;
    // armour plates ring
    const plateGeo = prepare(chamferBox(L * 0.12, L * 0.05, L * 0.16, L * 0.02));
    this.geos.push(plateGeo);
    const hw = Math.max(L * 0.18, this.model.radius * 0.45);
    const nPlates = 10;
    for (let i = 0; i < nPlates; i++) {
      const a = (i / nPlates) * Math.PI * 2;
      const m = new Mesh(plateGeo, plateMat);
      const off = new Vector3(Math.cos(a) * hw, L * 0.06, Math.sin(a) * hw * 1.4);
      m.position.copy(off);
      m.rotation.set(0, -a + Math.PI / 2, rng.range(-0.2, 0.2));
      m.castShadow = true;
      this.extras.add(m);
      this.plates.push({ mesh: m, blown: false, offset: off });
    }

    // shield pylons
    this.pylonMat = new MeshBasicMaterial({ color: this.accent.clone().multiplyScalar(2.5), toneMapped: false });
    const pylonGeo = prepare(cyl(L * 0.015, L * 0.03, L * 0.2, 8));
    const orbGeo = prepare(sphere(L * 0.028, 12, 8));
    this.geos.push(pylonGeo, orbGeo);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const p = new Mesh(pylonGeo, this.model.materials.trim);
      p.position.set(Math.cos(a) * hw * 1.25, L * 0.1, Math.sin(a) * hw * 1.25);
      const orb = new Mesh(orbGeo, this.pylonMat);
      orb.position.set(p.position.x, L * 0.21, p.position.z);
      this.extras.add(p, orb);
      this.pylonOrbs.push(orb);
    }

    // weak points
    this.weakMat = new MeshBasicMaterial({ color: new Color("#ff2d55").multiplyScalar(2), toneMapped: false, transparent: true, blending: AdditiveBlending });
    const weakGeo = prepare(sphere(L * 0.035, 14, 10));
    const ringGeo = prepare(transform(torus(L * 0.05, L * 0.006, 4, 24), [0, 0, 0], [Math.PI / 2, 0, 0]));
    this.geos.push(weakGeo, ringGeo);
    const nWeak = 4;
    for (let i = 0; i < nWeak; i++) {
      const a = (i / nWeak) * Math.PI * 2;
      const pos = new Vector3(Math.cos(a) * hw * 0.6, L * 0.09, Math.sin(a) * hw * 0.8);
      const m = new Mesh(weakGeo, this.weakMat);
      m.position.copy(pos);
      const r = new Mesh(ringGeo, this.weakMat);
      r.position.copy(pos);
      this.extras.add(m, r);
      this.weakMeshes.push(m, r);
      this.weakPoints.push(pos);
    }

    // reactor core under a two-part hatch
    this.coreMat = new MeshBasicMaterial({ color: this.accent.clone().multiplyScalar(3), toneMapped: false });
    const coreGeo = prepare(sphere(L * 0.07, 24, 16));
    this.geos.push(coreGeo);
    this.core = new Mesh(coreGeo, this.coreMat);
    this.core.position.set(0, L * 0.08, -L * 0.05);
    this.extras.add(this.core);
    const hatchGeo = prepare(chamferBox(L * 0.09, L * 0.02, L * 0.18, L * 0.01));
    this.geos.push(hatchGeo);
    for (const s of [1, -1]) {
      const h = new Mesh(hatchGeo, plateMat);
      h.position.set(s * L * 0.045, L * 0.14, -L * 0.05);
      h.userData.side = s;
      this.extras.add(h);
      this.hatch.push(h);
    }
    this.setPhase("SHIELD");
  }

  get phase(): BossLayer {
    return this.layer;
  }

  setPhase(layer: BossLayer): void {
    const prev = this.layer;
    this.layer = layer;
    const blow = layer === "REACTOR" || layer === "ENRAGE";
    if (blow && prev !== layer) {
      const tmp = new Vector3();
      for (const p of this.plates) {
        if (p.blown) continue;
        p.blown = true;
        p.mesh.visible = false;
        this.onPlateBlown?.(p.mesh.getWorldPosition(tmp));
      }
    }
    if (!blow) for (const p of this.plates) { p.blown = false; p.mesh.visible = true; }
    for (const o of this.pylonOrbs) o.visible = layer === "SHIELD";
  }

  /** Per-frame animation. */
  update(time: number, dt: number): void {
    const L = this.length;
    const open = this.layer === "REACTOR" || this.layer === "ENRAGE" ? 1 : 0;
    this.hatchOpen += (open - this.hatchOpen) * Math.min(1, dt * 1.5);
    for (const h of this.hatch) {
      const s = (h.userData.side as number) ?? 1;
      h.position.x = s * L * (0.045 + this.hatchOpen * 0.08);
      h.rotation.z = s * this.hatchOpen * 0.9;
    }
    const en = this.layer === "ENRAGE" ? 1 : 0;
    this.enrage += (en - this.enrage) * Math.min(1, dt * 2);
    const pulse = 0.5 + 0.5 * Math.sin(time * (4 + this.enrage * 8));
    // weak points brighten when exposed
    const exposure = this.layer === "SHIELD" ? 0.25 : this.layer === "ARMOR" ? 0.55 : 1;
    this.weakMat.opacity = 0.4 + exposure * 0.6 * (0.6 + 0.4 * pulse);
    for (const m of this.weakMeshes) m.scale.setScalar(1 + exposure * 0.25 * pulse);
    this.coreMat.color.copy(this.accent).lerp(ENRAGE_CORE, this.enrage).multiplyScalar(2 + this.hatchOpen * 2 * (0.7 + 0.3 * pulse));
    this.core.scale.setScalar(0.8 + this.hatchOpen * 0.4 + pulse * 0.08 * this.hatchOpen);
    this.accentMat.emissive.copy(this.accent).lerp(ENRAGE_ACCENT, this.enrage);
    this.accentMat.emissiveIntensity = 2 + this.enrage * 2.5 * pulse;
    this.glowMat.color.copy(this.accent).lerp(ENRAGE_GLOW, this.enrage).multiplyScalar(2.2 + this.enrage * 1.5 * pulse);
    for (const o of this.pylonOrbs) o.scale.setScalar(1 + 0.3 * pulse);
  }

  dispose(): void {
    this.root.removeFromParent();
    this.model.dispose();
    for (const g of this.geos) g.dispose();
    this.weakMat.dispose();
    this.pylonMat.dispose();
    this.coreMat.dispose();
    this.accentMat.dispose();
    this.glowMat.dispose();
  }
}
