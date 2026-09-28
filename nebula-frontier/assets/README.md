# Assets

No external AAA art was supplied, so the game ships with a **procedural visual system** (`packages/game-renderer`): modular hard-surface ship parts, procedural PBR textures (normal/roughness/metalness/emissive/AO), shader effects and generated SVG UI. The pipeline is ready for production assets; drop them into these folders and reference them from data.

| Folder | Content | Format | Referenced from |
|---|---|---|---|
| `ships/` | Ship hulls & modular parts | `.glb` (Draco-compressed meshes, KTX2/Basis textures, 3 LODs: `_lod0/_lod1/_lod2`) | `ShipVisualDef.glb` in `packages/config/data/ships.json` |
| `weapons/` | Weapon meshes, muzzle sprites | `.glb`, `.ktx2` | `WeaponDef.visual` |
| `modules/` | Module icons | `.svg`, `.ktx2` | items.json |
| `drones/` | Drone meshes | `.glb` | `DroneDef.visual` |
| `environments/` | Skyboxes, planets, stations, asteroids | `.ktx2` cubemaps, `.glb` | `MapDef.environment.skybox`, decor |
| `effects/` | Flipbooks, noise textures | `.ktx2` | effects system |
| `UI/` | Icons, emblems | `.svg` | game-ui |
| `audio/` | SFX & music | `.ogg` + `.m4a` (iOS) | AudioManager (procedural WebAudio fallback today) |

## Pipeline
1. Author in Blender (Y-up, meters, 1 unit ≈ interceptor length / 3), PBR metal/rough.
2. Export glTF 2.0 binary; compress with `gltf-transform optimize in.glb out.glb --compress draco --texture-compress ktx2`.
3. Keep ≤ 25k tris for LOD0 ships (≤ 150k for bosses); LOD1 ~40%, LOD2 ~10%.
4. Transcoders: copy `three/examples/jsm/libs/draco/` and `basis/` to the web public folder (`/decoders/draco/`, `/decoders/basis/`).
