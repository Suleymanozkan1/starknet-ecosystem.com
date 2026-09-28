import {
  AdditiveBlending, type BufferGeometry, Color, CylinderGeometry, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial,
} from "three";
import type { Rarity } from "@nebula/shared";
import { ObjectPool } from "../core/pool.js";
import { box, chamferBox, prepare, transform } from "../ship/geometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

export const RARITY_COLORS: Readonly<Record<Rarity, string>> = {
  COMMON: "#c0c7d2",
  UNCOMMON: "#5bd96b",
  RARE: "#3fa7ff",
  EPIC: "#b25cff",
  LEGENDARY: "#ffb020",
  ANCIENT: "#ff6a3d",
  MYTHIC: "#ff3fa4",
  PROTOTYPE: "#38f5e2",
};

interface Crate { root: Group; body: Mesh; glow: Mesh; beam: Mesh; phase: number; rarity: Rarity }

/** Pooled loot crates with rarity-coloured glowing edges and a light pillar for EPIC+. */
export class LootLayer {
  readonly group = new Group();
  private readonly bodyGeo: BufferGeometry;
  private readonly edgeGeo: BufferGeometry;
  private readonly beamGeo = new CylinderGeometry(0.12, 0.35, 12, 10, 1, true).translate(0, 6, 0);
  private readonly bodyMat = new MeshStandardMaterial({ color: "#3a404c", metalness: 0.85, roughness: 0.35 });
  private readonly glowMats = new Map<Rarity, MeshBasicMaterial>();
  private readonly beamMats = new Map<Rarity, MeshBasicMaterial>();
  private readonly pool: ObjectPool<Crate>;
  private readonly live = new Map<string, Crate>();

  constructor(budget = 128) {
    this.bodyGeo = prepare(chamferBox(0.9, 0.7, 0.9, 0.18));
    const edges = [
      transform(box(1.0, 0.08, 0.08), [0, 0.36, 0.46]), transform(box(1.0, 0.08, 0.08), [0, 0.36, -0.46]),
      transform(box(0.08, 0.08, 1.0), [0.46, 0.36, 0]), transform(box(0.08, 0.08, 1.0), [-0.46, 0.36, 0]),
      transform(box(0.5, 0.06, 0.5), [0, 0.37, 0]),
    ].map((g) => prepare(g));
    const merged = mergeGeometries(edges);
    for (const e of edges) e.dispose();
    if (!merged) throw new Error("loot edge merge failed");
    this.edgeGeo = merged;
    this.pool = new ObjectPool<Crate>({
      max: budget,
      create: () => {
        const root = new Group();
        const body = new Mesh(this.bodyGeo, this.bodyMat);
        body.castShadow = true;
        const glow = new Mesh(this.edgeGeo, this.glowMat("COMMON"));
        const beam = new Mesh(this.beamGeo, this.beamMat("COMMON"));
        beam.renderOrder = 6;
        root.add(body, glow, beam);
        this.group.add(root);
        return { root, body, glow, beam, phase: 0, rarity: "COMMON" };
      },
      reset: (c) => { c.root.visible = false; },
    });
  }

  private glowMat(r: Rarity): MeshBasicMaterial {
    let m = this.glowMats.get(r);
    if (!m) {
      m = new MeshBasicMaterial({ color: new Color(RARITY_COLORS[r]).multiplyScalar(2.2), toneMapped: false });
      this.glowMats.set(r, m);
    }
    return m;
  }

  private beamMat(r: Rarity): MeshBasicMaterial {
    let m = this.beamMats.get(r);
    if (!m) {
      m = new MeshBasicMaterial({ color: new Color(RARITY_COLORS[r]), transparent: true, opacity: 0.35, blending: AdditiveBlending, depthWrite: false, toneMapped: false });
      this.beamMats.set(r, m);
    }
    return m;
  }

  add(id: string, x: number, z: number, rarity: Rarity = "COMMON"): void {
    if (this.live.has(id)) return;
    const c = this.pool.acquire();
    if (!c) return;
    c.rarity = rarity;
    c.glow.material = this.glowMat(rarity);
    c.beam.material = this.beamMat(rarity);
    const big = rarity === "EPIC" || rarity === "LEGENDARY" || rarity === "ANCIENT" || rarity === "MYTHIC" || rarity === "PROTOTYPE";
    c.beam.visible = big;
    c.root.position.set(x, 0.4, z);
    c.root.scale.setScalar(big ? 1.3 : 1);
    c.phase = Math.random() * 6;
    c.root.visible = true;
    this.live.set(id, c);
  }

  remove(id: string): void {
    const c = this.live.get(id);
    if (!c) return;
    this.live.delete(id);
    this.pool.release(c);
  }

  position(id: string): { x: number; z: number } | null {
    const c = this.live.get(id);
    return c ? { x: c.root.position.x, z: c.root.position.z } : null;
  }

  update(time: number): void {
    for (const c of this.live.values()) {
      c.body.rotation.y = c.glow.rotation.y = time * 0.8 + c.phase;
      c.body.position.y = c.glow.position.y = Math.sin(time * 2 + c.phase) * 0.15;
    }
  }

  clear(): void {
    for (const id of [...this.live.keys()]) this.remove(id);
  }

  dispose(): void {
    this.pool.dispose();
    this.group.removeFromParent();
    this.bodyGeo.dispose();
    this.edgeGeo.dispose();
    this.beamGeo.dispose();
    this.bodyMat.dispose();
    for (const m of this.glowMats.values()) m.dispose();
    for (const m of this.beamMats.values()) m.dispose();
    this.live.clear();
  }
}
