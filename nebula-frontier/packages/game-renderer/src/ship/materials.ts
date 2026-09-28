import {
  AdditiveBlending, Color, DoubleSide, type Material, MeshBasicMaterial, MeshPhysicalMaterial, MeshStandardMaterial,
  Vector2,
} from "three";
import { createPanelTextures, type PanelTextureSet } from "../textures/procedural.js";

const tmpHsl = { h: 0, s: 0, l: 0 };

/** Hull paint: real paint never reaches pure white/black under ACES — clamp lightness. */
function paint(hex: string): Color {
  const c = new Color(hex);
  c.getHSL(tmpHsl);
  c.setHSL(tmpHsl.h, tmpHsl.s, Math.min(0.68, Math.max(0.06, tmpHsl.l)));
  return c;
}

function luminanceOf(hex: string): number {
  const c = new Color(hex);
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

/** Material slots a ship part can be assigned to. Geometry is merged per slot → ~7 draw calls per ship. */
export const MaterialSlot = {
  PRIMARY: "primary",
  SECONDARY: "secondary",
  TRIM: "trim",
  ACCENT: "accent",
  GLASS: "glass",
  GLOW: "glow",
  ENGINE: "engine",
} as const;
export type MaterialSlot = (typeof MaterialSlot)[keyof typeof MaterialSlot];
export const MATERIAL_SLOTS: readonly MaterialSlot[] = Object.values(MaterialSlot);

export interface ShipPalette {
  primary: string;
  secondary: string;
  accent: string;
  engine: string;
}

export type SlotMaterials = Record<MaterialSlot, Material>;

export interface MaterialLibraryOptions {
  textureSize: number;
  physical: boolean;
  anisotropy?: number;
}

/**
 * Shared, cached PBR materials. One set per palette (+ variant such as "wreck"),
 * sharing a single procedural texture set. Disposed only via `dispose()`.
 */
export class MaterialLibrary {
  private readonly textures: PanelTextureSet;
  private readonly sets = new Map<string, SlotMaterials>();
  private readonly extra = new Map<string, Material>();
  private readonly opts: MaterialLibraryOptions;

  constructor(opts: MaterialLibraryOptions) {
    this.opts = opts;
    this.textures = createPanelTextures(opts.textureSize, 7331);
    const aniso = opts.anisotropy ?? 1;
    this.textures.normal.anisotropy = aniso;
    this.textures.orm.anisotropy = aniso;
    this.textures.albedo.anisotropy = aniso;
  }

  get panelTextures(): PanelTextureSet {
    return this.textures;
  }

  static paletteKey(p: ShipPalette, variant = ""): string {
    return `${p.primary}|${p.secondary}|${p.accent}|${p.engine}|${variant}`;
  }

  private hull(color: string, roughness: number, metalness: number, accent: string, emissiveStrength: number): Material {
    const t = this.textures;
    const params = {
      color: paint(color),
      map: t.albedo,
      normalMap: t.normal,
      normalScale: new Vector2(0.9, 0.9),
      roughnessMap: t.orm,
      metalnessMap: t.orm,
      aoMap: t.orm,
      aoMapIntensity: 0.8,
      roughness,
      metalness,
      emissive: new Color(accent),
      emissiveMap: t.emissive,
      emissiveIntensity: emissiveStrength,
      envMapIntensity: 1.0,
    };
    if (this.opts.physical) {
      return new MeshPhysicalMaterial({ ...params, clearcoat: 0.35, clearcoatRoughness: 0.35 });
    }
    return new MeshStandardMaterial(params);
  }

  /** Materials for a ship palette. `variant` "wreck" gives burnt, unlit materials for decor. */
  get(p: ShipPalette, variant: "" | "wreck" | "boss" = ""): SlotMaterials {
    const key = MaterialLibrary.paletteKey(p, variant);
    let set = this.sets.get(key);
    if (set) return set;
    const wreck = variant === "wreck";
    const burnt = (hex: string): string => (wreck ? `#${new Color(hex).multiplyScalar(0.35).getHexString()}` : hex);
    const primary = this.hull(burnt(p.primary), wreck ? 0.9 : 1, wreck ? 0.4 : 1, p.accent, wreck ? 0 : 0.9);
    const secondary = this.hull(burnt(p.secondary), wreck ? 0.9 : 0.85, wreck ? 0.3 : 0.9, p.accent, wreck ? 0 : 0.5);
    const trim = new MeshStandardMaterial({
      color: new Color(wreck ? "#15161a" : "#2a2e36"),
      roughness: 0.55,
      metalness: 0.9,
      normalMap: this.textures.normal,
      roughnessMap: this.textures.orm,
    });
    const accentLum = luminanceOf(p.accent);
    const accent = new MeshStandardMaterial({
      color: new Color(p.accent),
      emissive: new Color(p.accent),
      emissiveIntensity: (wreck ? 0.05 : variant === "boss" ? 1.8 : 0.9) * (1 - accentLum * 0.55),
      roughness: 0.35,
      metalness: 0.2,
    });
    const glass = new MeshStandardMaterial({
      color: new Color(wreck ? "#050608" : "#0b1a2a"),
      emissive: new Color(p.secondary).multiplyScalar(wreck ? 0 : 0.18),
      roughness: 0.05,
      metalness: 1,
      envMapIntensity: 2.2,
    });
    const glow = new MeshBasicMaterial({
      color: new Color(p.accent).multiplyScalar(wreck ? 0.08 : 1.6),
      toneMapped: false,
    });
    const engine = new MeshBasicMaterial({
      color: new Color(p.engine).multiplyScalar(wreck ? 0.05 : 2.0),
      toneMapped: false,
      transparent: true,
      opacity: wreck ? 0.3 : 0.95,
      blending: AdditiveBlending,
      depthWrite: false,
      side: DoubleSide,
    });
    set = { primary, secondary, trim, accent, glass, glow, engine };
    this.sets.set(key, set);
    return set;
  }

  /** Arbitrary named shared material (created once). */
  shared<M extends Material>(key: string, create: () => M): M {
    let m = this.extra.get(key);
    if (!m) {
      m = create();
      this.extra.set(key, m);
    }
    return m as M;
  }

  dispose(): void {
    for (const set of this.sets.values()) for (const m of Object.values(set)) m.dispose();
    for (const m of this.extra.values()) m.dispose();
    this.sets.clear();
    this.extra.clear();
    this.textures.dispose();
  }
}
