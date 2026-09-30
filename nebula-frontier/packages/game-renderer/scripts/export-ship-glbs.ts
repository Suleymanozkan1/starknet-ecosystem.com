/**
 * Production GLB asset pipeline for player ships (requirement 3D-03).
 *
 *   pnpm --filter @nebula/game-renderer export:glb
 *
 * For every ship in `@nebula/config` ships.json this:
 *  1. builds the high-detail procedural model with the same code the game uses (`buildShipGeometry`),
 *     bakes the greeble instances into the trim mesh and indexes each slot mesh,
 *  2. exports it with three's GLTFExporter to binary glTF (one mesh per material slot, named after the
 *     slot, PBR factor materials from the ship palette — no textures: the runtime re-skins the slot meshes
 *     with the shared procedural panel materials so cosmetics/cloak keep working),
 *  3. re-encodes it with glTF-Transform + Draco (KHR_draco_mesh_compression, required),
 *  4. writes `apps/web/public/models/ships/<shipId>.glb` and copies the Draco decoder next to the app
 *     (`apps/web/public/draco/`) so neither the web build nor Capacitor needs a CDN.
 *
 * The `visual.glb` URL in ships.json must point at `/models/ships/<shipId>.glb` (checked by
 * `src/ship/glbAssets.test.ts`). KTX2 is not used: the exported assets carry no textures.
 */
import { copyFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BoxGeometry, type BufferGeometry, Color, Group, Matrix4, Mesh, type Material, MeshBasicMaterial, MeshStandardMaterial } from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { mergeGeometries, mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS, KHRDracoMeshCompression } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";
import { SHIPS } from "@nebula/config";
import type { ShipDef } from "@nebula/shared";
import { buildShipGeometry } from "../src/ship/ShipFactory.js";
import { prepare } from "../src/ship/geometry.js";
import { MATERIAL_SLOTS, type MaterialSlot } from "../src/ship/materials.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const PUBLIC = join(REPO, "apps/web/public");
const OUT_DIR = join(PUBLIC, "models/ships");
const DRACO_OUT = join(PUBLIC, "draco");
/** Draco decoder files used by DRACOLoader (wasm path + asm.js fallback). */
const DRACO_FILES = ["draco_decoder.js", "draco_decoder.wasm", "draco_wasm_wrapper.js"] as const;

/** URL a ship's GLB is served from (what `visual.glb` must be set to). */
export function shipGlbUrl(shipId: string): string {
  return `/models/ships/${shipId}.glb`;
}

/**
 * GLTFExporter's binary path reads Blobs through FileReader, which Node does not ship.
 * Minimal stand-in covering exactly what the exporter uses (readAsArrayBuffer/readAsDataURL + onloadend).
 */
class NodeFileReader {
  result: ArrayBuffer | string | null = null;
  onloadend: (() => void) | null = null;

  readAsArrayBuffer(blob: Blob): void {
    void blob.arrayBuffer().then((buf) => {
      this.result = buf;
      this.onloadend?.();
    });
  }

  readAsDataURL(blob: Blob): void {
    void blob.arrayBuffer().then((buf) => {
      this.result = `data:${blob.type || "application/octet-stream"};base64,${Buffer.from(buf).toString("base64")}`;
      this.onloadend?.();
    });
  }
}

function installNodeShims(): void {
  if (typeof globalThis.FileReader === "undefined") {
    Object.defineProperty(globalThis, "FileReader", { value: NodeFileReader, configurable: true, writable: true });
  }
}

/** Standalone PBR factors per slot (used by generic glTF viewers; the game re-skins by slot name). */
function slotMaterial(slot: MaterialSlot, def: ShipDef): Material {
  const v = def.visual;
  switch (slot) {
    case "primary":
      return new MeshStandardMaterial({ name: slot, color: new Color(v.primaryColor), metalness: 0.85, roughness: 0.45 });
    case "secondary":
      return new MeshStandardMaterial({ name: slot, color: new Color(v.secondaryColor), metalness: 0.8, roughness: 0.5 });
    case "trim":
      return new MeshStandardMaterial({ name: slot, color: new Color("#2a2e36"), metalness: 0.9, roughness: 0.55 });
    case "accent":
      return new MeshStandardMaterial({ name: slot, color: new Color(v.accentColor), emissive: new Color(v.accentColor), metalness: 0.2, roughness: 0.35 });
    case "glass":
      return new MeshStandardMaterial({ name: slot, color: new Color("#0b1a2a"), metalness: 1, roughness: 0.05 });
    case "glow":
      return new MeshBasicMaterial({ name: slot, color: new Color(v.accentColor) });
    case "engine":
      return new MeshBasicMaterial({ name: slot, color: new Color(v.engineColor) });
  }
}

/** Bake greeble instance matrices (runtime: InstancedMesh of unit boxes, trim material) into real geometry. */
function bakeGreebles(matrices: Float32Array, uvScale: number): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  const m = new Matrix4();
  for (let i = 0; i + 16 <= matrices.length; i += 16) {
    m.fromArray(matrices, i);
    out.push(prepare(new BoxGeometry(1, 1, 1).applyMatrix4(m), uvScale));
  }
  return out;
}

/** Build the export scene for one ship: one indexed mesh per material slot, named after the slot. */
export function buildShipExportScene(def: ShipDef): Group {
  const set = buildShipGeometry(def.visual, true);
  const high = set.levels[0];
  if (!high) throw new Error(`${def.id}: no high LOD`);
  const root = new Group();
  root.name = def.id;
  const uvScale = 0.75 / Math.sqrt(Math.max(1, def.visual.length / 3));
  for (const slot of MATERIAL_SLOTS) {
    let geo = high.get(slot);
    if (!geo) continue;
    if (slot === "trim" && set.greebles.length > 0) {
      const merged = mergeGeometries([geo, ...bakeGreebles(set.greebles, uvScale)], false);
      if (!merged) throw new Error(`${def.id}: failed to merge greebles`);
      geo = merged;
    }
    const indexed = mergeVertices(geo, 1e-5);
    const mesh = new Mesh(indexed, slotMaterial(slot, def));
    mesh.name = slot;
    root.add(mesh);
  }
  return root;
}

async function exportGlb(scene: Group): Promise<Uint8Array> {
  const result = await new GLTFExporter().parseAsync(scene, { binary: true, onlyVisible: true });
  if (!(result instanceof ArrayBuffer)) throw new Error("GLTFExporter did not return a binary GLB");
  return new Uint8Array(result);
}

async function main(): Promise<void> {
  installNodeShims();
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(DRACO_OUT, { recursive: true });

  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    "draco3d.encoder": await draco3d.createEncoderModule(),
    "draco3d.decoder": await draco3d.createDecoderModule(),
  });

  let total = 0;
  for (const def of SHIPS) {
    const raw = await exportGlb(buildShipExportScene(def));
    const doc = await io.readBinary(raw);
    doc.getRoot().getAsset().generator = "nebula-frontier export-ship-glbs (three GLTFExporter + glTF-Transform)";
    doc.createExtension(KHRDracoMeshCompression).setRequired(true).setEncoderOptions({
      method: KHRDracoMeshCompression.EncoderMethod.EDGEBREAKER,
      encodeSpeed: 3,
      decodeSpeed: 5,
      quantizationBits: { POSITION: 14, NORMAL: 10, TEXCOORD_0: 12 },
    });
    const glb = await io.writeBinary(doc);
    const file = join(OUT_DIR, `${def.id}.glb`);
    writeFileSync(file, glb);
    total += glb.byteLength;
    console.info(`${shipGlbUrl(def.id)}  raw ${(raw.byteLength / 1024).toFixed(1)} KiB -> draco ${(glb.byteLength / 1024).toFixed(1)} KiB`);
  }
  console.info(`ships: ${SHIPS.length} GLBs, ${(total / 1024).toFixed(1)} KiB total`);

  // Draco decoder: resolved from the installed three so it always matches DRACOLoader's version.
  const require = createRequire(import.meta.url);
  let dracoBytes = 0;
  for (const f of DRACO_FILES) {
    copyFileSync(require.resolve(`three/examples/jsm/libs/draco/gltf/${f}`), join(DRACO_OUT, f));
    dracoBytes += statSync(join(DRACO_OUT, f)).size;
  }
  console.info(`draco decoder: ${DRACO_FILES.length} files, ${(dracoBytes / 1024).toFixed(1)} KiB -> /draco/`);
}

await main();
