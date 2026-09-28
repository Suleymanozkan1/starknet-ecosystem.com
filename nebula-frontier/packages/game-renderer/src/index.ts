/**
 * @nebula/game-renderer — procedural Three.js visual system for NEBULA FRONTIER.
 * Ships, NPCs/bosses, world objects, effects, camera, hangar viewer and
 * graphics-tier/perf infrastructure. Map (x, y) ↔ world (X, Z).
 */
export * from "./core/tiers.js";
export { ObjectPool, type PoolOptions } from "./core/pool.js";
export { createRng, hashString, type Rng } from "./core/random.js";
export {
  createRenderBackend, AdaptiveResolution, type RenderBackend, type BackendPreference, type BackendKind, type RendererLike,
} from "./core/backend.js";
export { ShipFactory, ShipModel, buildShipGeometry, shipGeometryKey, type ShipGeometrySet, type ShipModelOptions } from "./ship/ShipFactory.js";
export { MaterialLibrary, MaterialSlot, type ShipPalette } from "./ship/materials.js";
export { resolveLook, parseCosmeticIds, resolveCosmeticPayloads, npcVisual, type ResolvedLook } from "./ship/cosmetics.js";
export { HULL_TYPES, type HullType } from "./ship/hulls.js";
export { GlbLibrary, type GlbLibraryOptions } from "./ship/glb.js";
export { BossVisual, type BossLayer } from "./npc/BossVisual.js";
export { DroneFactory } from "./npc/drones.js";
export { EffectsSystem, type WeaponVisualStyle } from "./fx/EffectsSystem.js";
export { WarpTunnel } from "./fx/warp.js";
export { createCloakMaterial } from "./fx/cloak.js";
export { SpaceBackground } from "./world/background.js";
export { AsteroidLayer, RESOURCE_COLORS, createAsteroidGeometry } from "./world/asteroids.js";
export { LootLayer, RARITY_COLORS } from "./world/loot.js";
export { PortalVisual, PORTAL_COLORS } from "./world/portal.js";
export { StationVisual } from "./world/station.js";
export { buildMapDecor, createPlanet, type DecorItem } from "./world/decor.js";
export { FollowCamera, type FollowCameraOptions } from "./camera/FollowCamera.js";
export { WorldRenderer, type EntityRenderInput, type FrameStats, type WorldRendererOptions } from "./WorldRenderer.js";
export { createHangarViewer, type HangarViewer, type HangarViewerOptions } from "./hangar/HangarViewer.js";
