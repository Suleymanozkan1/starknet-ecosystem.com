import type { Mesh, Object3D, WebGLRenderer } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { clone as skeletonClone } from "three/addons/utils/SkeletonUtils.js";
import type { ShipModel } from "./ShipFactory.js";

export interface GlbLibraryOptions {
  /** Path to Draco decoder files (e.g. "/draco/"), copied from three/examples/jsm/libs/draco. */
  dracoPath?: string;
  /** Path to Basis transcoder files (e.g. "/basis/"), copied from three/examples/jsm/libs/basis. */
  ktx2Path?: string;
  /** Needed by KTX2Loader.detectSupport. */
  renderer?: WebGLRenderer | null;
}

/**
 * Production asset path: loads Draco-compressed, KTX2-textured GLB ships and
 * caches the parsed scene per URL. Instances are cheap clones sharing geometry.
 * Procedural ships remain the fallback while loading or on failure.
 */
export class GlbLibrary {
  private readonly loader: GLTFLoader;
  private readonly draco: DRACOLoader | null;
  private readonly ktx2: KTX2Loader | null;
  private readonly cache = new Map<string, Promise<Object3D>>();

  constructor(opts: GlbLibraryOptions = {}) {
    this.loader = new GLTFLoader();
    this.draco = opts.dracoPath ? new DRACOLoader().setDecoderPath(opts.dracoPath) : null;
    if (this.draco) this.loader.setDRACOLoader(this.draco);
    this.ktx2 = opts.ktx2Path && opts.renderer ? new KTX2Loader().setTranscoderPath(opts.ktx2Path).detectSupport(opts.renderer) : null;
    if (this.ktx2) this.loader.setKTX2Loader(this.ktx2);
  }

  load(url: string): Promise<Object3D> {
    let p = this.cache.get(url);
    if (!p) {
      p = this.loader.loadAsync(url).then((gltf) => gltf.scene);
      this.cache.set(url, p);
      p.catch(() => this.cache.delete(url));
    }
    return p.then((scene) => skeletonClone(scene));
  }

  /** Load `model.look.visual.glb` (if any) and attach it to the model. Errors keep the procedural mesh. */
  async apply(model: ShipModel, mode: "replace" | "augment" = "replace"): Promise<boolean> {
    const url = model.look.visual.glb;
    if (!url) return false;
    try {
      const obj = await this.load(url);
      obj.traverse((o) => {
        const m = o as Mesh;
        if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; }
      });
      model.attachGlb(obj, mode);
      return true;
    } catch (err) {
      console.warn(`[renderer] failed to load GLB ${url}`, err);
      return false;
    }
  }

  dispose(): void {
    this.draco?.dispose();
    this.ktx2?.dispose();
    this.cache.clear();
  }
}
