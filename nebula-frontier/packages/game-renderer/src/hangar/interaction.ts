/**
 * Pure (three.js-free) interaction rules of the 3D hangar viewer: orbit limits, compare framing,
 * the home camera pose, wheel/button zoom clamping and what each preview mode drives. Kept apart
 * from HangarViewer so the rules can be unit-tested without a WebGL context.
 */

export type HangarPreviewMode = "idle" | "engine" | "fire" | "shield" | "damage";

/** Static OrbitControls configuration (rotate + zoom only; panning is disabled). */
export const HANGAR_ORBIT = {
  dampingFactor: 0.08,
  enablePan: false,
  /** Never orbit below the floor. */
  maxPolarAngle: Math.PI * 0.49,
  /** Initial limits before the first ship is framed. */
  minDistance: 3,
  maxDistance: 90,
} as const;

/** Gap between the two bays in compare mode (world units). */
const COMPARE_GAP = 2;
/** Fallback footprint for a bay without a mounted model. */
const DEFAULT_WIDTH = 3;

/** Footprint of a ship on its platform: the larger of its length and its span. */
export function bayWidth(length: number, radius: number): number {
  return Math.max(length, radius * 2);
}

export interface HangarFraming {
  mainX: number;
  /** X position of the compare bay (null when not comparing). */
  compareX: number | null;
  minDistance: number;
  maxDistance: number;
  shadowFar: number;
}

/**
 * Bay placement + orbit zoom limits. Single ship: centred, zoom range scales with its footprint.
 * Compare: both bays side by side (centred around the origin) and the zoom range covers both.
 */
export function hangarFraming(mainWidth: number | null, compareWidth: number | null, comparing: boolean): HangarFraming {
  const w0 = mainWidth ?? DEFAULT_WIDTH;
  const w1 = compareWidth ?? DEFAULT_WIDTH;
  let mainX = 0;
  let compareX: number | null = null;
  if (comparing && mainWidth !== null && compareWidth !== null) {
    const gap = w0 / 2 + w1 / 2 + COMPARE_GAP;
    mainX = -gap / 2;
    compareX = gap / 2;
  }
  const extent = comparing ? w0 + w1 + COMPARE_GAP : Math.max(w0, DEFAULT_WIDTH);
  return { mainX, compareX, minDistance: extent * 0.6, maxDistance: extent * 6, shadowFar: extent * 12 };
}

export interface HangarPose {
  position: readonly [number, number, number];
  target: readonly [number, number, number];
}

/** Home camera pose ("reset view"): three-quarter view from above, far enough to fit the ship(s). */
export function hangarHomePose(main: { length: number; radius: number } | null, comparing: boolean): HangarPose {
  const L = Math.max(main?.length ?? 3, (main?.radius ?? 1.5) * 1.6);
  const ext = comparing ? L * 2.6 : L;
  const d = Math.max(9, ext * 2.7);
  return { position: [d * 0.72, d * 0.42, d * 0.85], target: [0, Math.max(0.6, L * 0.1), 0] };
}

/**
 * Camera distance after a zoom step. `delta` is relative (-0.2 = 20 % closer, +0.25 = 25 % further);
 * the result always stays within the orbit limits.
 */
export function zoomedDistance(current: number, delta: number, minDistance: number, maxDistance: number): number {
  const next = current * (1 + delta);
  return Math.min(maxDistance, Math.max(minDistance, next));
}

/** Damage preview level in [0, 1]; values above 1 are read as percentages (65 → 0.65). */
export function damageLevel(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  return Math.max(0, Math.min(1, pct > 1 ? pct / 100 : pct));
}

export interface HangarPreviewPlan {
  /** Engines at full thrust with trails. */
  engines: boolean;
  /** Hull damage level in [0, 1] (smoke/sparks above 0.3). */
  damage: number;
  /** Repeating effect fired while the mode is active. */
  pulse: "fire" | "shield" | null;
  /** Pulse period in ms (0 when there is no pulse). */
  intervalMs: number;
}

/** Damage level shown by the "damage" preview. */
export const PREVIEW_DAMAGE = 0.65;

/** What the viewer does for each preview mode. */
export function hangarPreviewPlan(mode: HangarPreviewMode): HangarPreviewPlan {
  switch (mode) {
    case "engine":
      return { engines: true, damage: 0, pulse: null, intervalMs: 0 };
    case "fire":
      return { engines: true, damage: 0, pulse: "fire", intervalMs: 900 };
    case "shield":
      return { engines: false, damage: 0, pulse: "shield", intervalMs: 1600 };
    case "damage":
      return { engines: false, damage: PREVIEW_DAMAGE, pulse: null, intervalMs: 0 };
    case "idle":
      return { engines: false, damage: 0, pulse: null, intervalMs: 0 };
  }
}
