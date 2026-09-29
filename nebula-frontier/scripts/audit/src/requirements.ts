/**
 * Master requirements list (extracted from the full project brief, sections 0–181, plus the
 * CodeRabbit and final-audit briefs). Evidence is verified mechanically by run-audit.ts.
 * Paths are relative to nebula-frontier/.
 */
import { ev, type Evidence, type Requirement } from "./types.js";

type Opts = Partial<Pick<Requirement, "integration" | "test" | "runtime" | "testExempt" | "blocked" | "partial" | "notes">>;
const list: Requirement[] = [];
function R(id: string, category: string, requirement: string, expected: string, impl: Evidence[], opts: Opts = {}): void {
  list.push({ id, category, requirement, expected, impl, ...opts });
}
const t = (file: string, pattern?: string) => ev(file, pattern);

// Frequently used paths
const GS = "apps/game-server/src";
const API = "apps/api/src";
const WEB = "apps/web/src";
const ADM = "apps/admin/src";
const GC = "apps/game-client/src";
const GR = "packages/game-renderer/src";
const CORE = "packages/game-core/src";
const ECO = "packages/economy/src";
const BC = "packages/blockchain/src";
const BCS = "apps/blockchain-service/src";
const DATA = "packages/config/data";
const SCHEMA = "prisma/schema.prisma";

// ---------------------------------------------------------------- PROJECT STRUCTURE
R("PS-01", "PROJECT STRUCTURE", "pnpm workspace monorepo", "apps/*, packages/*, scripts/*, tests managed by pnpm", [ev("pnpm-workspace.yaml", "apps/\\*"), ev("package.json", "packageManager")], { testExempt: true, runtime: "pnpm_install" });
R("PS-02", "PROJECT STRUCTURE", "Required apps exist (web, mobile, game-client, game-server, api, blockchain-service, admin)", "Each app has a package.json and source", ["web", "mobile", "game-client", "game-server", "api", "blockchain-service", "admin"].map((a) => ev(`apps/${a}/package.json`)), { testExempt: true });
R("PS-03", "PROJECT STRUCTURE", "Required packages exist", "game-core, game-renderer, game-network, game-ui, shared, database, blockchain, economy, authentication, config, validation, telemetry", ["game-core", "game-renderer", "game-network", "game-ui", "shared", "database", "blockchain", "economy", "authentication", "config", "validation", "telemetry"].map((p) => ev(`packages/${p}/src/index.ts`)), { testExempt: true });
R("PS-04", "PROJECT STRUCTURE", "Asset folders (ships, weapons, modules, drones, environments, effects, UI, audio)", "assets/* directories with pipeline notes", [ev("assets/README.md")], { testExempt: true });
R("PS-05", "PROJECT STRUCTURE", "Reference repositories under tools/reference-repos", "clone script + README; not bundled", [ev("tools/clone-reference-repos.sh", "colyseus/colyseus"), ev("tools/reference-repos/README.md"), ev(".gitignore", "tools/reference-repos")], { testExempt: true });
R("PS-06", "PROJECT STRUCTURE", "docs/REPOSITORIES.md integration table", "Repository/Role/Production Dependency/Used In/Version/License/Integration/Notes", [ev("docs/REPOSITORIES.md", "Production dependency")], { testExempt: true });
R("PS-07", "PROJECT STRUCTURE", "Strict TypeScript, no any", "tsconfig strict + eslint no-explicit-any error", [ev("tsconfig.base.json", "\"strict\": true"), ev("eslint.config.js", "no-explicit-any\": \"error")], { testExempt: true, runtime: "lint" });

// ---------------------------------------------------------------- DATA-DRIVEN
for (const f of ["ships", "weapons", "modules", "drones", "npcs", "loot_tables", "maps", "quests", "events", "economy", "items", "factions", "seasons", "shop", "battlepass"]) {
  R(`DATA-${f}`, "DATA-DRIVEN", `${f}.json exists and is loaded`, `Typed, validated, used by code`, [ev(`${DATA}/${f}.json`), ev("packages/config/src/data.ts", `${f}\\.json`)], { test: [t("packages/config/src/data.test.ts", "validateGameData")] });
}

// ---------------------------------------------------------------- WORLD
R("WORLD-01", "GALAXY", "Galaxy → Sector → Star System → Map → Zone hierarchy", "Data + DB models + API", [ev(`${DATA}/galaxy.json`, "sectors"), ev(SCHEMA, "model StarSystem"), ev(SCHEMA, "model Zone")], { integration: [ev(`${API}/routes/galaxy.ts`, "galaxy")], test: [t("packages/config/src/data.test.ts")] });
R("WORLD-02", "SECTORS", "Original named sectors (Helios, Vanta Rift, Orion Belt, Astra Graveyard, Eclipse Zone, Titan Expanse, Void Frontier, Nebula Corridor)", "Present in galaxy data", [ev(`${DATA}/galaxy.json`, "Titan Expanse"), ev(`${DATA}/galaxy.json`, "Nebula Corridor")], { test: [t("packages/config/src/data.test.ts")] });
R("WORLD-03", "ZONES", "Zone types (safe/neutral/pvp/high-risk/pirate/event/boss/gate) enforced server-side", "Safe zones block PvP damage", [ev(`${CORE}/zones.ts`, "SAFE")], { integration: [ev(`${GS}/rooms/BaseGameRoom.ts`, "isPvpAllowedAt")], test: [t(`${CORE}/world.test.ts`, "zone|Zone")] });
R("WORLD-04", "MAPS", "≥5 data-driven maps incl. 1 PvP map", "maps.json consumed by SectorRoom", [ev(`${DATA}/maps.json`, "map_eclipse_arena")], { integration: [ev(`${GS}/rooms/BaseGameRoom.ts`, "MAPS")], test: [t("packages/config/src/data.test.ts", "pvp")] , runtime: "game_join" });
R("WORLD-05", "WORLD IMMERSION", "Asteroids, nebulas, wrecks, stations, gates, derelicts, distant objects rendered", "Map decor rendered by renderer", [ev(`${DATA}/maps.json`, "DERELICT"), ev(`${GR}/world/background.ts`)], { test: [t("packages/game-renderer/src/fx/fx.test.ts", "EffectsSystem runs every effect type")], integration: [ev(`${GC}/Game.ts`, "WorldRenderer")], runtime: "renderer_showcase" });
R("WORLD-06", "SPACE STATIONS", "Stations with services", "Station defs + docking", [ev(`${DATA}/maps.json`, "QUEST_BOARD")], { integration: [ev(`${GS}/rooms/BaseGameRoom.ts`, "dock")], test: [t(`${GS}/game-server.test.ts`, "dock")] });
R("NAV-01", "PORTALS", "Portal/jump gate travel between maps", "jump message → server validates range/level → client joins target room", [ev(`${GS}/rooms/BaseGameRoom.ts`, "jump")], { integration: [ev(`packages/game-network/src/index.ts`)], test: [t(`${GS}/game-server.test.ts`, "jump|portal")] });
R("NAV-02", "NAVIGATION", "Smooth map transitions (warp effect/loading)", "Client transition screen + warp effect", [ev(`${GR}/fx/warp.ts`)], { test: [t("packages/game-renderer/src/fx/fx.test.ts", "warp")], integration: [ev(`${GC}/Game.ts`, "jump")] });

// ---------------------------------------------------------------- FACTIONS
R("FAC-01", "FACTIONS", "3 original factions with lore, emblem, colors, home, starter ship & loadout", "factions.json", [ev(`${DATA}/factions.json`, "AURORA INDUSTRIES"), ev(`${DATA}/factions.json`, "VORTEX CONSORTIUM"), ev(`${DATA}/factions.json`, "NOVA DYNASTY")], { test: [t("packages/config/src/data.test.ts")] });
R("FAC-02", "FACTIONS", "Player chooses faction (grants starter ship/loadout)", "POST /api/me/faction + UI", [ev(`${API}/routes/me.ts`, "faction")], { integration: [ev(`${WEB}/pages/onboarding/FactionSelect.tsx`)], test: [t("tests/integration/api.test.ts", "faction")], runtime: "api_faction" });
R("FAC-03", "FACTION WAR", "Global faction war scoring & seasonal leaderboard", "Faction score updated from kills/territory/resources/bosses/pvp", [ev(SCHEMA, "pvpScore"), ev(`${GS}/persistence/writer.ts`, "faction")], { test: [t(`${GS}/game-server.test.ts`, "faction")] });
R("FAC-04", "FACTIONS", "Faction reputation, missions, ranking", "PlayerFaction.reputation, faction quests, ranking API", [ev(SCHEMA, "model PlayerFaction"), ev(`${DATA}/quests.json`, "\"FACTION\"")], { test: [t("tests/integration/social-gameplay.test.ts", "faction"), t("apps/game-server/src/game-server.test.ts", "faction metrics")], integration: [ev(`${API}/routes/leaderboard.ts`, "faction")] });

// ---------------------------------------------------------------- SHIPS
R("SHIP-01", "SHIPS", "≥10 fully working ships", "ships.json ≥10, playable via game server", [ev(`${DATA}/ships.json`, "ship_riftbreaker")], { integration: [ev(`${CORE}/stats.ts`, "ShipDef")], test: [t("packages/config/src/data.test.ts", "10")] });
R("SHIP-02", "SHIP CLASSES", "All 13 ship classes represented", "Scout…Electronic Warfare", [ev(`${DATA}/ships.json`, "ELECTRONIC_WARFARE"), ev(`${DATA}/ships.json`, "CARRIER")], { test: [t("packages/config/src/data.test.ts")] });
R("SHIP-03", "SHIP STATS", "Hull/Shield/Energy/Speed/Accel/Turn/Cargo + slot counts", "ShipDef stats and slots used by stats engine", [ev("packages/shared/src/defs.ts", "turnRate"), ev(`${CORE}/stats.ts`)], { test: [t(`${CORE}/combat.test.ts`)] });
R("SHIP-04", "SHIP UPGRADES", "+1…+20 upgrades with credits/resources and success roll", "API + progression formulas", [ev(`${CORE}/progression.ts`, "upgrade"), ev(`${API}/routes/ships.ts`, "upgrade")], { test: [t(`${CORE}/progression.test.ts`, "upgrade")] });
R("SHIP-05", "SHIP CUSTOMIZATION", "Hull skin, engine effect/color, weapon skin, shield color/effect, trail, drone skin, explosion, nameplate, badge, emblem", "Cosmetic items + renderer applies them", [ev(`${DATA}/items.json`, "ENGINE_EFFECT"), ev(`${GR}/ship/cosmetics.ts`)], { test: [t("packages/game-renderer/src/ship/ShipFactory.test.ts", "cosmetic")], integration: [ev(`${WEB}/pages/Hangar.tsx`, "cosmetic|Cosmetic|skin")] });
R("SHIP-06", "SHIP CUSTOMIZATION", "Geometry-changing skins", "Skins override wings/armor/engine/hardpoints", [ev(`${DATA}/items.json`, "\"geometry\""), ev(`${GR}/ship/cosmetics.ts`, "geometry")], { test: [t(`${GR}/ship/ShipFactory.test.ts`, "skin|cosmetic")] });
R("SHIP-07", "3D SHIP RENDERING", "Distinct procedural modular ships (silhouette, cockpit, reactor, engines, wings, armor, weapons, sensors, antennas, cargo)", "ShipFactory builds each ShipVisualDef", [ev(`${GR}/ship/hulls.ts`), ev(`${GR}/ship/parts.ts`)], { test: [t(`${GR}/ship/ShipFactory.test.ts`)], runtime: "renderer_showcase" });
R("SHIP-08", "LOADOUT", "Multiple loadouts (PvP/PvE/Tank/Speed/Mining/Boss/Raid) with lasers, missiles, generators, modules, drones, formation, ammo, cosmetics", "ShipLoadout CRUD + equip", [ev(SCHEMA, "model ShipLoadout"), ev(`${API}/routes/ships.ts`, "loadout")], { integration: [ev(`${WEB}/pages/Hangar.tsx`, "loadout|Loadout")], test: [t("tests/integration/api.test.ts", "loadout|equip")] });

// ---------------------------------------------------------------- HANGAR / 3D
R("HANGAR-01", "3D HANGAR", "3D hangar: select, equip, customize, upgrade, compare, rotate, zoom, previews (engine/fire/shield/damage)", "createHangarViewer used by Hangar page", [ev(`${GR}/hangar/HangarViewer.ts`, "previewShield")], { integration: [ev(`${WEB}/components/ShipViewer.tsx`, "createHangarViewer")], runtime: "web_hangar" });
R("3D-01", "THREE.JS", "Three.js renderer with WebGPU-compatible abstraction", "WebGLRenderer default, WebGPURenderer optional", [ev(`${GR}/core/backend.ts`, "WebGLRenderer"), ev(`${GR}/core/backend.ts`, "WebGPU|webgpu")], { test: [t("packages/game-renderer/src/core/tiers.test.ts", "webgpu|WebGPU|backend")], runtime: "renderer_showcase" });
R("3D-02", "THREE.JS", "PBR materials (base, normal, metallic, roughness, emission, AO)", "MeshStandard/Physical with procedural maps", [ev(`${GR}/ship/materials.ts`, "roughness"), ev(`${GR}/textures/procedural.ts`)], { test: [t("packages/game-renderer/src/ship/materials.test.ts", "PBR")], runtime: "renderer_showcase" });
R("3D-03", "THREE.JS", "GLB/GLTF + Draco + KTX2 loading path", "GLTFLoader with DRACOLoader/KTX2Loader when ShipVisualDef.glb set", [ev(`${GR}/ship/glb.ts`, "KTX2Loader"), ev(`${GR}/ship/glb.ts`, "DRACOLoader")], { partial: "No production GLB assets exist; loader path only (procedural geometry used)" });
R("3D-04", "THREE.JS", "LOD, frustum culling, instancing, pooling", "THREE.LOD per ship, InstancedMesh asteroids/greebles, pools", [ev(`${GR}/core/pool.ts`), ev(`${GR}/ship/ShipFactory.ts`, "LOD")], { test: [t(`${GR}/core/pool.test.ts`)] });
R("3D-05", "THREE.JS", "Graphics tiers Ultra/High/Medium/Low + device detection", "tiers.ts detection", [ev(`${GR}/core/tiers.ts`, "ULTRA")], { test: [t(`${GR}/core/tiers.test.ts`)] });
R("FX-01", "EFFECTS", "Engine glow & trails", "Shader-based", [ev(`${GR}/fx/trails.ts`)], { test: [t("packages/game-renderer/src/fx/fx.test.ts", "trail")], runtime: "renderer_showcase" });
R("FX-02", "EFFECTS", "Weapon muzzle flash, laser beams, projectiles, missile trails", "Pooled effects", [ev(`${GR}/fx/beams.ts`), ev(`${GR}/fx/projectiles.ts`)], { test: [t("packages/game-renderer/src/fx/fx.test.ts", "projectiles")], runtime: "renderer_showcase" });
R("FX-03", "EFFECTS", "Shield bubble + hit ripple, EMP, warp, explosions, debris, hull damage sparks/smoke", "ShaderMaterial effects", [ev(`${GR}/fx/shield.ts`), ev(`${GR}/fx/EffectsSystem.ts`, "explosion|Explosion"), ev(`${GR}/fx/debris.ts`)], { test: [t("packages/game-renderer/src/fx/fx.test.ts", "shield|explosion")], runtime: "renderer_showcase" });
R("FX-04", "EFFECTS", "Nebula/particle fields, mining effects, boss attack effects", "Environment + effects", [ev(`${GR}/world/background.ts`, "nebula|Nebula"), ev(`${GR}/fx/beams.ts`, "mining|Mining")], { test: [t("packages/game-renderer/src/fx/fx.test.ts", "nebula|mining")], runtime: "renderer_showcase" });
R("CAM-01", "CAMERA", "Top-down follow camera: zoom, smooth follow, combat zoom, boss cinematic, target focus, auto framing", "CameraRig", [ev(`${GR}/camera/FollowCamera.ts`, "zoom")], { test: [t("packages/game-renderer/src/camera/FollowCamera.test.ts", "boss cinematic")] });
R("PHASER-01", "PHASER", "Phaser used as real 2D layer (radar/minimap/combat text)", "Phaser.Game overlay scene", [ev(`${GC}/overlay/OverlayLayer.ts`, "phaser")], { test: [t("apps/game-client/src/overlay/radar.test.ts", "radar")], integration: [ev(`${GC}/Game.ts`, "OverlayLayer")], runtime: "game_client_build" });
R("MINIMAP-01", "MINIMAP / RADAR", "Radar shows players, enemies, squad, clan, resources, NPC, portals, objectives, boss, events; stealth/scan", "RadarScene reads HUD entities", [ev(`${GC}/overlay/OverlayLayer.ts`, "PORTAL|portal")], { test: [t("apps/game-client/src/overlay/radar.test.ts", "portal")] });
R("AUDIO-01", "AUDIO", "Engine/laser/missile/explosion/shield/UI/warp/NPC alert/boss music/ambient/mining with positional audio", "WebAudio manager", [ev(`${GC}/audio/AudioManager.ts`, "boss|Boss")], { test: [t("apps/game-client/src/audio/AudioManager.test.ts", "boss")] });

// ---------------------------------------------------------------- INPUT
R("INPUT-01", "INPUT", "Desktop WASD + mouse aim + left click fire + right click + 1-9 abilities + shortcuts", "InputController", [ev(`${GC}/input/InputManager.ts`, "KeyW")], { test: [t("apps/game-client/src/input/InputManager.test.ts", "WASD")] });
R("INPUT-02", "INPUT", "Gamepad support", "Gamepad API polling", [ev(`${GC}/input/InputManager.ts`, "getGamepads")], { test: [t("apps/game-client/src/input/InputManager.test.ts", "gamepad")] });
R("INPUT-03", "MOBILE INPUT", "Touch joystick + fire/ability/ultimate/EMP/shield/dash + target buttons", "Mobile combat HUD", [ev(`${WEB}/game/MobileControls.tsx`, "setJoystick|joystick")], { test: [t("tests/e2e/web.play.spec.ts", "mobile|touch"), t("apps/game-client/src/input/InputManager.test.ts", "joystick")], runtime: "web_mobile" });
R("MOVE-01", "MOVEMENT", "Acceleration, deceleration, max speed, turn rate, boost, dash", "game-core stepShip used by server + prediction", [ev(`${CORE}/movement.ts`, "boost")], { integration: [ev(`${GS}/rooms/BaseGameRoom.ts`, "stepShip")], test: [t(`${CORE}/movement.test.ts`)] });

// ---------------------------------------------------------------- MULTIPLAYER
R("MP-01", "COLYSEUS", "Colyseus server with real rooms", "defineServer/Server + rooms registered", [ev(`${GS}/server.ts`, "defineServer")], { test: [t(`${GS}/game-server.test.ts`)], runtime: "game_server_boot" });
R("MP-02", "COLYSEUS", "Room types Lobby/Galaxy/Sector/PvP/Raid/Boss/ClanWar/Arena/Event/Gate", "All registered", [ev(`${GS}/rooms/SectorRoom.ts`), ev(`${GS}/rooms/BossRoom.ts`), ev(`${GS}/rooms/GateRoom.ts`, "class RaidRoom"), ev(`${GS}/rooms/EventRoom.ts`), ev(`${GS}/rooms/GalaxyRoom.ts`), ev(`${GS}/rooms/MatchRoom.ts`, "class PvPRoom"), ev(`${GS}/rooms/MatchRoom.ts`, "class ArenaRoom"), ev(`${GS}/rooms/MatchRoom.ts`, "class ClanWarRoom"), ev(`${GS}/server.ts`, "LobbyRoom")], { test: [t(`${GS}/game-server.test.ts`)] });
R("MP-03", "SERVER AUTHORITY", "Client sends inputs only; server decides HP/damage/XP/loot/position/cooldown", "Messages validated; no client-authored state", [ev(`${GS}/protocol/messages.ts`)], { test: [t(`${GS}/game-server.test.ts`, "speed|authoritative")] });
R("MP-04", "NETWORKING", "Interpolation + prediction + reconciliation", "game-network buffers", [ev("packages/game-network/src/interpolation.ts"), ev("packages/game-network/src/prediction.ts", "reconcil")], { test: [t("packages/game-network/src/prediction.test.ts"), t("packages/game-network/src/interpolation.test.ts")] });
R("MP-05", "NETWORKING", "State patches, interest management (AOI) for large battles", "StateView / AOI filtering", [ev(`${GS}/rooms/BaseGameRoom.ts`, "StateView|aoi|AOI")], { test: [t(`${GS}/game-server.test.ts`, "AOI|aoi|view")] });
R("MP-06", "MULTIPLAYER", "Join with single-use game ticket (replay protected)", "onAuth verifies JWT + jti", [ev(`${GS}/services/tickets.ts`, "verifyGameTicket")], { test: [t(`${GS}/game-server.test.ts`, "ticket")], runtime: "game_join" });
R("MP-07", "MULTIPLAYER", "Reconnection & player/room cleanup", "allowReconnection, onLeave persistence, dispose", [ev(`${GS}/rooms/BaseGameRoom.ts`, "allowReconnection")], { test: [t("apps/game-server/src/reconnection.test.ts", "reconnect")] });
R("MP-08", "MATCHMAKING", "Matchmaking by level, gear score, region, latency, party; MMR", "game-core matchmaking + rating", [ev(`${CORE}/matchmaking.ts`, "elo|Elo|rating")], { test: [t(`${CORE}/world.test.ts`, "rating|elo|Elo|formMatches")] });
R("MP-09", "SCALING", "Horizontal scaling via Redis presence/driver, regions", "RedisPresence + RedisDriver when REDIS_URL", [ev(`${GS}/server.ts`, "RedisPresence")], { partial: "RedisPresence/RedisDriver wired when REDIS_URL is set (presence/mute keys covered by game-server tests); a two-node matchmaking run has not been tested" });
R("MP-10", "LARGE SCALE BATTLE", "50v50 capable architecture", "AOI + patch rate + tick budget", [ev(`${GS}/rooms/BaseGameRoom.ts`, "AOI|aoi")], { test: [t("apps/game-server/src/game-server.test.ts", "only replicates entities within AOI_RADIUS")], runtime: "load_100" });
R("MP-11", "REALTIME EVENTS", "player_join/leave/move/attack/damage/death/respawn/level_up, item_drop/pickup, quest_complete, match_start/end, boss_phase, event_started/finished", "ServerEvent broadcasts", [ev("packages/shared/src/protocol.ts", "BOSS_PHASE"), ev(`${GS}/rooms/BaseGameRoom.ts`, "ServerEvent")], { test: [t(`${GS}/game-server.test.ts`)] });

// ---------------------------------------------------------------- COMBAT
R("CMB-01", "WEAPONS", "Weapon types incl. laser/plasma/railgun/particle/ion/missile/rocket/torpedo/EMP/beam/mine/drone/special with full stat set", "weapons.json + combat engine", [ev(`${DATA}/weapons.json`, "RAILGUN"), ev(`${CORE}/combat.ts`, "armorPenetration")], { test: [t(`${CORE}/combat.test.ts`)] });
R("CMB-02", "WEAPONS", "Rarities COMMON…PROTOTYPE", "Rarity enum used in data", [ev("packages/shared/src/enums.ts", "PROTOTYPE"), ev(`${DATA}/weapons.json`, "LEGENDARY")], { test: [t("packages/config/src/data.test.ts")] });
R("CMB-03", "SHIELDS", "Shield → armor → hull damage pipeline, regen, energy, heat, EMP, crits, elements, resistances", "combat.ts", [ev(`${CORE}/combat.ts`, "shield"), ev(`${CORE}/combat.ts`, "heat")], { test: [t(`${CORE}/combat.test.ts`, "shield")] });
R("CMB-04", "ITEM MODIFIERS", "Random affixes with caps + PvP normalization", "loot.ts rollAffixes", [ev(`${DATA}/item_affixes.json`), ev(`${CORE}/loot.ts`, "affix")], { test: [t(`${CORE}/progression.test.ts`, "affix")] });
R("CMB-05", "MODULES", "15+ modules with cooldown/duration/energy/effect/rarity", "modules.json + abilities engine", [ev(`${DATA}/modules.json`, "REPAIR_MATRIX"), ev(`${CORE}/abilities.ts`)], { test: [t(`${CORE}/combat.test.ts`, "abilit|module")] });
R("CMB-06", "ABILITIES", "Passive/Active/Ultimate per ship; server-authoritative cooldowns", "abilities.ts", [ev(`${CORE}/abilities.ts`, "cooldown")], { test: [t(`${CORE}/anticheat.test.ts`, "cooldown")] });
R("CMB-07", "DRONES", "Drone types, level, rarity, upgrade, formations", "drones.json + stats + formations", [ev(`${DATA}/drones.json`, "RECON"), ev(`${CORE}/stats.ts`, "drone")], { test: [t(`${CORE}/combat.test.ts`, "drone")] });
R("CMB-08", "PET / COMPANION", "Pet: loot collect, repair, radar, scan, resource detection, buff, levels", "pets.json + server behavior", [ev(`${DATA}/pets.json`), ev(`${GS}/rooms/BaseGameRoom.ts`, "pet")], { test: [t("apps/game-server/src/game-server.test.ts", "pet"), t("tests/integration/social-gameplay.test.ts", "pets")] });
R("CMB-09", "COMBAT TARGETING", "Soft/hard lock, nearest enemy/player/objective, manual aim, lead indicator", "target message handling", [ev(`${GS}/protocol/messages.ts`, "NEAREST_ENEMY"), ev(`${GS}/rooms/BaseGameRoom.ts`, "NEAREST_PLAYER")], { test: [t(`${GS}/game-server.test.ts`, "target")] });
R("CMB-10", "DAMAGE VISUALIZATION", "Shield flash, sparks, smoke, broken parts, explosion, debris", "Renderer damage states", [ev(`${GR}/fx/EffectsSystem.ts`, "smoke|spark")], { test: [t("packages/game-renderer/src/fx/fx.test.ts", "damageEmit")] });
R("CMB-11", "DESTRUCTION", "Death animation, respawn, repair cost, PvP kill record", "Server death/respawn + repair sink", [ev(`${GS}/rooms/BaseGameRoom.ts`, "respawn")], { test: [t(`${GS}/game-server.test.ts`, "death|respawn")] });

// ---------------------------------------------------------------- NPC / PVE
R("NPC-01", "NPC", "≥10 NPCs incl. Mining Drone, Pirate Raider, Alien Scout/Fighter/Elite, Destroyer, Leviathan, World Boss", "npcs.json", [ev(`${DATA}/npcs.json`, "npc_leviathan")], { test: [t("packages/config/src/data.test.ts")] });
R("NPC-02", "NPC AI", "AI states Idle/Patrol/Search/Aggro/Attack/Flee/Assist/Retreat/Respawn", "npc-ai.ts state machine run by rooms", [ev(`${CORE}/npc-ai.ts`, "RETREAT")], { integration: [ev(`${GS}/rooms/BaseGameRoom.ts`, "npc")], test: [t(`${CORE}/world.test.ts`, "npc|Npc|NPC")] });
R("NPC-03", "NPC", "Independent NPC factions with weakness/resistance/drops", "npc_factions.json", [ev(`${DATA}/npc_factions.json`, "weakness")], { test: [t("packages/config/src/data.test.ts")] });
R("PVE-01", "PVE", "Kill NPC → XP, credits, loot (server-side)", "Persisted via ledger + inventory", [ev(`${GS}/persistence/writer.ts`, "GAME_ISSUANCE")], { test: [t(`${GS}/game-server.test.ts`, "loot|xp|XP")], runtime: "game_kill_npc" });
R("BOSS-01", "WORLD BOSS", "World boss with 4 phases, weak points, special attacks, adds, enrage, contribution rewards", "BossRoom", [ev(`${GS}/rooms/BossRoom.ts`, "phase")], { test: [t(`${GS}/game-server.test.ts`, "boss|Boss")] });
R("RAID-01", "RAID", "Raids for 4/8/16/25 players with mechanics", "RaidRoom", [ev(`${GS}/rooms/GateRoom.ts`, "class RaidRoom"), ev(`${GS}/rooms/GateRoom.ts`, "25")], { test: [t("apps/game-server/src/game-server.test.ts", "raids"), t("packages/game-core/src/review-fixes.test.ts", "raid loot")] });
R("GATE-01", "GATE / WAVE CONTENT", "Waves 1,2,3,Elite,Mini Boss,Final Boss with Normal/Hard/Nightmare/Mythic", "GateRoom + gates.json", [ev(`${DATA}/gates.json`, "MYTHIC"), ev(`${GS}/rooms/GateRoom.ts`, "wave")], { test: [t(`${GS}/game-server.test.ts`, "gate|Gate")] });
R("EVT-01", "EVENTS", "Event engine (invasion, world boss, treasure hunt, double XP, faction war, mining festival, PvP weekend, raid, special, season) with multipliers", "events.json + game-core events", [ev(`${DATA}/events.json`, "MINING_FESTIVAL"), ev(`${CORE}/events.ts`)], { integration: [ev(`${GS}/services/events.ts`)], test: [t(`${CORE}/world.test.ts`, "event")] });
R("EVT-02", "GLOBAL EVENTS", "Dynamic global event 'VOID RIFT OPENED' with collective damage + tiers", "Broadcast across rooms", [ev(`${DATA}/events.json`, "VOID RIFT"), ev(`${GS}/rooms/BaseGameRoom.ts`, "GLOBAL_RIFT")], { test: [t("apps/game-server/src/game-server.test.ts", "void rift")] });

// ---------------------------------------------------------------- ECONOMY LOOPS
R("MINE-01", "MINING", "Mining lasers/drills/drones, risky zones", "mine message + mining yield", [ev(`${CORE}/mining.ts`), ev(`${GS}/rooms/BaseGameRoom.ts`, "mine")], { test: [t(`${CORE}/world.test.ts`, "min")] });
R("RES-01", "RESOURCES", "7 resources from asteroids/wrecks/NPC/quest/event/raid", "PlayerResource persistence", [ev("packages/shared/src/enums.ts", "VOID_ESSENCE"), ev(SCHEMA, "model PlayerResource")], { test: [t("apps/game-server/src/game-server.test.ts", "mining")], integration: [ev(`${GS}/persistence/writer.ts`, "playerResource")] });
R("CRAFT-01", "CRAFTING", "Craft weapons/modules/ammo/drones/parts/consumables", "API start/claim", [ev(`${API}/routes/crafting.ts`, "claim")], { integration: [ev(`${WEB}/pages/Crafting.tsx`)], test: [t("tests/integration/api.test.ts", "craft")] });
R("CRAFT-02", "BLUEPRINTS", "Blueprint tiers with resources, time, level, success chance", "blueprints.json", [ev(`${DATA}/blueprints.json`, "successChance"), ev(`${CORE}/crafting.ts`)], { test: [t(`${CORE}/world.test.ts`, "craft|blueprint")] });
R("LOOT-01", "LOOT", "Server-side loot tables with rarities; unique originRef prevents duplicates", "loot.ts + InventoryItem.originRef", [ev(`${CORE}/loot.ts`), ev(SCHEMA, "originRef +String\\? +@unique")], { test: [t(`${CORE}/progression.test.ts`, "loot|Loot")] });
R("QUEST-01", "QUESTS", "Quest types & objectives tracked server-side; claim via API", "UserQuest progress from game events", [ev(`${CORE}/quests.ts`), ev(`${API}/routes/quests.ts`, "claim")], { integration: [ev(`${WEB}/pages/Missions.tsx`)], test: [t("tests/integration/api.test.ts", "quest")] });
R("STORY-01", "STORY", "Original story chapters 1-5", "MAIN_STORY quests with chapters", [ev(`${DATA}/quests.json`, "\"chapter\": 5")], { test: [t("packages/config/src/data.test.ts")] });

// ---------------------------------------------------------------- SOCIAL
R("CLAN-01", "CLAN", "Clan create/join/roles/bank/announcements/missions/diplomacy/ranking", "API + UI", [ev(`${API}/routes/clans.ts`, "OFFICER")], { integration: [ev(`${WEB}/pages/Clan.tsx`)], test: [t("tests/integration/api.test.ts", "clan")] });
R("CLAN-02", "CLAN WAR", "Clan war phases Preparation→Declaration→Matchmaking→Battle→Scoring→Reward", "ClanWar model + ClanWarRoom", [ev(SCHEMA, "model ClanWar"), ev(`${GS}/rooms/MatchRoom.ts`, "class ClanWarRoom")], { test: [t("apps/game-server/src/game-server.test.ts", "clan war"), t("tests/integration/platform.test.ts", "war")], integration: [ev(`${API}/routes/clans.ts`, "war")] });
R("CLAN-03", "CLAN STATION", "Clan battle station with modules, attackable", "ClanStation + modules API", [ev(SCHEMA, "model ClanStationModule"), ev(`${API}/routes/clans.ts`, "station")], { test: [t("tests/integration/clan-station.test.ts", "station")] });
R("SQUAD-01", "SQUAD", "4-8 player squads with shared target/marker/rewards/chat", "API + game marker message", [ev(`${API}/routes/social.ts`, "squad")], { test: [t("tests/integration/api.test.ts", "squads")] });
R("FRIEND-01", "FRIENDS", "Add/remove/block/online/invite", "API", [ev(`${API}/routes/social.ts`, "friend")], { test: [t("tests/integration/api.test.ts", "friends"), t("tests/integration/platform.test.ts", "friend")] });
R("CHAT-01", "CHAT", "Global/Faction/Clan/Squad/Private chat with spam/rate limit/mute/report/ban", "Game chat + API history/report", [ev(`${GS}/rooms/BaseGameRoom.ts`, "chat"), ev(`${API}/routes/social.ts`, "report")], { test: [t("apps/game-server/src/game-server.test.ts", "blocks chat when muted"), t("tests/integration/api.test.ts", "chat report")] });
R("MAIL-01", "MAILBOX", "Internal mail with reward attachments", "API list/read/claim", [ev(`${API}/routes/social.ts`, "mail")], { test: [t("tests/integration/api.test.ts", "mail attachments")] });
R("NOTIF-01", "NOTIFICATIONS", "Web + mobile notifications for key events", "Notification model + push registration", [ev(`${API}/lib/notify.ts`), ev(`${WEB}/native/push.ts`)], { test: [t("tests/integration/platform.test.ts", "push notifications"), t("apps/api/src/lib/push.test.ts", "push")] });
R("PROF-01", "PROFILE", "Profile: level, rank, ship, gear score, PvP/PvE stats, achievements, clan, faction, title", "GET /api/profile + page", [ev(`${API}/routes/me.ts`, "profile")], { test: [t("tests/integration/social-gameplay.test.ts", "profile")], integration: [ev(`${WEB}/pages/Profile.tsx`)] });
R("RANK-01", "RANK", "Level 1-50, ranks, prestige, gear score", "progression.json + progression.ts", [ev(`${DATA}/progression.json`, "ranks"), ev(`${CORE}/progression.ts`, "prestige")], { test: [t(`${CORE}/progression.test.ts`)] });
R("ACH-01", "ACHIEVEMENTS", "Achievements (supports hundreds) unlocked server-side", "achievements.json + unlock", [ev(`${DATA}/achievements.json`, "ach_"), ev(`${GS}/persistence/writer.ts`, "chievement")], { test: [t("tests/integration/api.test.ts", "achievements unlock")] });
R("BP-01", "BATTLE PASS", "Free/premium tracks with pass XP and claims", "battlepass.json + API + UI", [ev(`${DATA}/battlepass.json`, "premium"), ev(`${API}/routes/season.ts`, "claim")], { test: [t("tests/integration/api.test.ts", "battle pass")], integration: [ev(`${WEB}/pages/BattlePass.tsx`)] });
R("SEASON-01", "SEASONS", "Seasons 1-3 with leaderboard, missions, cosmetics, boss, rewards", "seasons.json + DB Season", [ev(`${DATA}/seasons.json`, "season_3"), ev(SCHEMA, "model Season")], { test: [t("tests/integration/api.test.ts", "seasons")], integration: [ev(`${API}/routes/season.ts`)] });
R("LB-01", "LEADERBOARD", "Leaderboards updated from gameplay (PvP kills etc.)", "LeaderboardEntry upserts + API", [ev(`${API}/routes/leaderboard.ts`), ev(`${GS}/persistence/writer.ts`, "leaderboard")], { test: [t("apps/game-server/src/game-server.test.ts", "leaderboard|pvp_kills"), t("tests/integration/social-gameplay.test.ts", "leaderboard")], integration: [ev(`${WEB}/pages/Leaderboard.tsx`)], runtime: "leaderboard_update" });
R("BOUNTY-01", "BOUNTY", "PvP bounties with amount/target/creator/expiration/status", "Bounty model + API + claim on kill", [ev(SCHEMA, "model Bounty"), ev(`${API}/routes/social.ts`, "ount")], { test: [t("tests/integration/api.test.ts", "bounty"), t("apps/game-server/src/game-server.test.ts", "bount")] });
R("REP-01", "REPUTATION", "Karma statuses Neutral/Friendly/Hostile/Outlaw/Bounty Target", "Unprovoked attacks affect reputation", [ev("packages/shared/src/enums.ts", "OUTLAW"), ev(`${GS}/rooms/BaseGameRoom.ts`, "karma|OUTLAW")], { test: [t("apps/game-server/src/game-server.test.ts", "karma"), t("packages/game-core/src/social.test.ts", "karma|reputation")] });
R("PVP-01", "PVP", "Open-world PvP, duel, arena, TDM, KOTH, escort, capture zone, faction war, clan war, large battle", "PvP rooms & modes", [ev(`${GS}/rooms/MatchRoom.ts`, "class PvPRoom"), ev(`${GS}/rooms/MatchRoom.ts`, "class ArenaRoom")], { test: [t(`${GS}/game-server.test.ts`, "pvp|PvP")], runtime: "game_pvp_kill" });
R("RANKED-01", "RANKED", "Ranked seasons with MMR and rank rewards", "pvpRating updates", [ev(SCHEMA, "pvpRating"), ev(`${CORE}/matchmaking.ts`)], { test: [t(`${CORE}/world.test.ts`, "rating|elo|Elo|formMatches")] });

// ---------------------------------------------------------------- SHOP / INVENTORY / MARKET
R("INV-01", "INVENTORY", "Inventory with filters, sort, search; equip/unequip server-validated", "API + page", [ev(`${API}/routes/inventory.ts`, "equip")], { integration: [ev(`${WEB}/pages/Inventory.tsx`)], test: [t("tests/integration/api.test.ts", "equip")], runtime: "api_inventory" });
R("INV-02", "INVENTORY", "Tradeable/soulbound/premium/cosmetic/powerItem/nftEligible metadata", "Item model + items.json", [ev(SCHEMA, "nftEligible"), ev(`${DATA}/items.json`, "soulbound")], { test: [t("packages/config/src/data.test.ts")] });
R("SHOP-01", "SHOP", "Shop from DB/config, no hardcoded prices, idempotent purchase", "ShopProduct + purchase route", [ev(`${API}/routes/shop.ts`, "purchase"), ev(`${API}/lib/purchase.ts`, "idempotencyKey")], { integration: [ev(`${WEB}/pages/Shop.tsx`)], test: [t("tests/integration/api.test.ts", "purchase")], runtime: "api_shop" });
R("PREM-01", "PREMIUM", "FREE/VIP/ELITE premium (cosmetic/convenience, not investment)", "Premium tier grants", [ev(`${DATA}/shop.json`, "sku_premium_vip_30"), ev(`${API}/lib/purchase.ts`, "premiumTier|premiumUntil")], { test: [t("tests/integration/premium.test.ts", "VIP")] });
R("MKT-01", "MARKETPLACE", "Player marketplace with fee accounting, escrow lock, anti-manipulation", "market routes", [ev(`${API}/routes/market.ts`, "MARKETPLACE_REVENUE|marketplaceFee|fee")], { integration: [ev(`${WEB}/pages/Market.tsx`)], test: [t("tests/integration/market.test.ts")] });
R("AUC-01", "AUCTION", "Auction house: listing fee, bid, buyout, expiration, tax, cancellation, types, anti-bid-abuse", "auction routes + settlement", [ev(`${API}/routes/auctions.ts`, "buyout")], { integration: [ev(`${WEB}/pages/Auction.tsx`)], test: [t("tests/integration/market.test.ts", "auction|bid")] });
R("CUR-01", "CREDITS", "Credits off-chain with sinks (repair, ammo, crafting, travel, upgrade, NPC fees)", "Ledger CREDITS issuance/sinks", [ev(`${GS}/persistence/writer.ts`, "CREDITS"), ev(`${API}/lib/balances.ts`)], { test: [t("packages/database/src/ledger.test.ts")] });
R("CUR-02", "GEMS", "Premium gems (off-chain) spend on cosmetics/pass/convenience", "Ledger GEMS → PREMIUM_REVENUE", [ev(`${API}/lib/purchase.ts`, "GEMS")], { test: [t("tests/integration/api.test.ts", "GEMS|gems")] });

// ---------------------------------------------------------------- BLOCKCHAIN
R("BC-01", "SOLANA", "@solana/kit real integration (RPC, tx build, confirm)", "packages/blockchain", [ev(`${BC}/rpc.ts`, "createSolanaRpc"), ev(`${BC}/transfer.ts`, "sendAndConfirmTransactionFactory")], { test: [t(`${BC}/blockchain.test.ts`)], runtime: "devnet_payout" });
R("BC-02", "WALLETS", "Wallet adapter with Phantom, Solflare, Backpack (Wallet Standard)", "Web providers", [ev(`${WEB}/wallet/WalletProviders.tsx`, "PhantomWalletAdapter"), ev(`${WEB}/wallet/WalletProviders.tsx`, "Solflare")], { runtime: "web_wallet_ui" , notes: "Backpack is picked up through Wallet Standard auto-detection" });
R("BC-03", "WALLET SIGNATURE", "Nonce → signature → backend verification → session; replay + expiry protection", "auth routes + verifyWalletSignature", [ev(`${BC}/auth.ts`, "verifySignature"), ev(`${API}/routes/auth.ts`, "nonce")], { test: [t("tests/integration/auth.test.ts", "replay|nonce")], runtime: "api_wallet_login" });
R("BC-04", "DEPOSIT", "Deposit flow with network/mint/amount/recipient/confirmation/signature uniqueness checks", "prepare/verify routes", [ev(`${BC}/deposit.ts`, "memo"), ev(`${API}/routes/wallet.ts`, "deposit/verify")], { integration: [ev(`${WEB}/pages/Wallet.tsx`, "deposit")], test: [t(`${BC}/blockchain.test.ts`, "verifyDepositTransaction|Deposit")], runtime: "devnet_deposit" });
R("BC-05", "WITHDRAWAL", "Withdrawal with limits, cooldown, review, statuses, signature, retry/backoff, idempotency", "API + blockchain-service", [ev(`${API}/routes/wallet.ts`, "withdraw"), ev(`${BCS}/processor.ts`, "CONFIRMED")], { integration: [ev(`${WEB}/pages/Wallet.tsx`, "withdraw")], test: [t(`${BCS}/processor.test.ts`)], runtime: "devnet_payout" });
R("BC-06", "BLOCKCHAIN SERVICE", "Separate blockchain service, sole treasury key holder", "apps/blockchain-service", [ev(`${BCS}/index.ts`), ev(`${BC}/keys.ts`, "SERVICE_ROLE")], { test: [t("packages/blockchain/src/blockchain.test.ts", "SERVICE_ROLE")], runtime: "blockchain_service_boot" });
R("BC-07", "TRANSACTION QUEUE", "States CREATED/QUEUED/SUBMITTED/CONFIRMING/CONFIRMED/FAILED/RETRYING, durable in Postgres", "ChainTransaction + BullMQ", [ev(SCHEMA, "model ChainTransaction"), ev(`${BCS}/queue.ts`, "bullmq")], { test: [t(`${BCS}/processor.test.ts`, "recover")] });
R("BC-08", "TREASURY SECURITY", "Private key never in frontend/repo/logs/browser", "keys.ts guarded, redaction", [ev(`${BC}/keys.ts`, "TREASURY_SECRET"), ev("packages/telemetry/src/logger.ts", "redact")], { test: [t("packages/telemetry/src/telemetry.test.ts", "redact")] });
R("BC-09", "NFT", "Metaplex token metadata for eligible assets", "nft.ts", [ev(`${BC}/nft.ts`, "mpl-token-metadata")], { partial: "Feature-flagged; not minted in the vertical slice" });
R("BC-10", "SMART CONTRACT", "Anchor program architecture for settlement/escrow", "programs/nebula_settlement", [ev("programs/nebula_settlement/src/lib.rs", "#\\[program\\]")], { test: [t("programs/nebula_settlement/src/lib.rs", "#\\[test\\]")], runtime: "anchor_cargo_test", partial: "cargo check + 6 Rust unit tests pass; Anchor/Solana CLI not installed here, so not built as BPF, no on-chain (bankrun) tests, not deployed (MVP settles off-chain via blockchain-service)" });
R("BC-11", "DEVNET", "Devnet-only operation", "SOLANA_NETWORK=devnet enforced", [ev(`${BC}/rpc.ts`, "devnet")], { runtime: "devnet_payout" });
R("BC-12", "TOKENOMICS", "Max supply, allocations, no infinite mint", "economy.json tokenomics", [ev(`${DATA}/economy.json`, "maxSupply"), ev("docs/ECONOMY.md", "supply")], { testExempt: true });

// ---------------------------------------------------------------- LEDGER / ECONOMY
R("LED-01", "LEDGER", "Double-entry immutable ledger with idempotency and no negative user balances", "ledger.ts", [ev("packages/database/src/ledger.ts", "INSUFFICIENT_BALANCE")], { test: [t("packages/database/src/ledger.test.ts")] });
R("LED-02", "DOUBLE ENTRY ACCOUNTING", "Separate system accounts (TREASURY, PLAYER_REWARD_POOL, OPERATING_REVENUE, WITHDRAWAL_RESERVE, MARKETPLACE_REVENUE, PREMIUM_REVENUE…)", "LedgerAccountType", [ev("packages/shared/src/enums.ts", "WITHDRAWAL_RESERVE")], { test: [t("packages/database/src/ledger.test.ts", "integrity")] });
R("LED-03", "LEDGER", "Transaction types DEPOSIT/GAME_REWARD/PURCHASE/REFUND/WITHDRAWAL/FEE/MARKETPLACE_FEE/AUCTION_FEE/ADMIN_ADJUSTMENT; compensating corrections", "LedgerTxType + reverse()", [ev("packages/shared/src/enums.ts", "ADMIN_ADJUSTMENT"), ev("packages/database/src/ledger.ts", "COMPENSATION")], { test: [t("packages/database/src/ledger.test.ts", "reverse")] });
R("ECO-01", "REWARD ENGINE", "grantCryptoReward with eligibility, caps, risk review, breaker, emission", "rewards.ts", [ev(`${ECO}/rewards.ts`, "grantCryptoReward")], { integration: [ev(`${GS}/persistence/writer.ts`, "grantCryptoReward")], test: [t(`${ECO}/rewards.db.test.ts`, "DUPLICATE")] });
R("ECO-02", "REWARD LIABILITY", "Outstanding liability tracked and settled on claim", "RewardLiability", [ev(SCHEMA, "model RewardLiability"), ev(`${ECO}/rewards.ts`, "rewardLiability")], { test: [t(`${ECO}/economy.test.ts`, "liabilit")] });
R("ECO-03", "TREASURY", "Separate reserves OPERATING/REWARD/WITHDRAWAL/EMERGENCY", "Ledger accounts + bootstrap", [ev("packages/shared/src/enums.ts", "EMERGENCY_RESERVE"), ev(`${ECO}/treasury.ts`)], { test: [t(`${ECO}/economy.test.ts`, "treasury|Treasury")] });
R("ECO-04", "TREASURY RESERVE", "Treasury health states & multipliers", "treasury.ts", [ev(`${ECO}/treasury.ts`, "CRITICAL")], { test: [t(`${ECO}/economy.test.ts`, "CRITICAL")] });
R("ECO-05", "REWARD EMISSION", "Dynamic emission with MAX_REWARD_RATE hard cap", "emission.ts", [ev(`${ECO}/emission.ts`, "maxRewardRate")], { test: [t(`${ECO}/economy.test.ts`, "cap")] });
R("ECO-06", "REWARD BUDGET", "Budget = seasonRevenue × ratio; allocation ≤100%", "rewardBudget.ts", [ev(`${ECO}/rewardBudget.ts`, "rewardBudgetRatio")], { test: [t(`${ECO}/economy.test.ts`, "allocation")] });
R("ECO-07", "REWARD ELIGIBILITY", "Account age, anti-cheat, gameplay time, matches, cooldown, mode", "eligibility.ts", [ev(`${ECO}/eligibility.ts`, "minAccountAgeHours")], { test: [t(`${ECO}/economy.test.ts`, "eligib")] });
R("ECO-08", "USER REWARD LIMIT", "Daily/weekly/season caps shown to players", "caps.ts + UI", [ev(`${ECO}/caps.ts`, "weekly")], { integration: [ev(`${WEB}/pages/Wallet.tsx`, "cap|Cap")], test: [t(`${ECO}/economy.test.ts`, "cap")] });
R("ECO-09", "ECONOMY CONTROLLER", "Monitor emission/sinks/treasury/inflation, anomalies, throttle", "controller.ts run by blockchain-service", [ev(`${ECO}/controller.ts`, "inflation")], { integration: [ev(`${BCS}/index.ts`, "Controller|controller")], test: [t(`${ECO}/rewards.db.test.ts`, "controller|Controller")] });
R("ECO-10", "CIRCUIT BREAKER", "REWARD_PAUSE/MARKET_PAUSE/WITHDRAWAL_REVIEW/EVENT_PAUSE", "breakers.ts", [ev(`${ECO}/breakers.ts`), ev(`${ECO}/controller.ts`, "WITHDRAWAL_REVIEW")], { test: [t(`${ECO}/economy.test.ts`, "breaker|PAUSE")] });
R("ECO-11", "INFLATION CONTROL", "Issued/burned/spent/stored/withdrawn + daily/weekly/30d inflation", "controller + EconomySnapshot", [ev(`${ECO}/controller.ts`, "burned"), ev(SCHEMA, "model EconomySnapshot")], { test: [t(`${ECO}/inflation.db.test.ts`, "inflation")] });
R("ECO-12", "MARKETPLACE FEES", "Marketplace fee 7.5% shown and separately accounted", "fees.ts + market route", [ev(`${ECO}/fees.ts`, "marketplace"), ev(`${DATA}/economy.json`, "0.075")], { test: [t(`${ECO}/economy.test.ts`, "fee")] });
R("ECO-13", "AUCTION FEES", "Listing/sale/cancellation fees", "fees.ts", [ev(`${ECO}/fees.ts`, "auction")], { test: [t(`${ECO}/economy.test.ts`, "auction")] });
R("ECO-14", "WITHDRAWAL FEES", "Requested/service/network/final shown", "quote", [ev(`${ECO}/fees.ts`, "networkFee")], { integration: [ev(`${WEB}/pages/Wallet.tsx`, "Network")], test: [t(`${ECO}/economy.test.ts`, "withdraw")] });
R("ECO-15", "ECONOMY SIMULATION", "11 scenarios × user counts × horizons; ECONOMY_SIMULATION.md", "scripts/economy-simulation", [ev("scripts/economy-simulation/src/index.ts", "MARKET_CRASH"), ev("docs/ECONOMY_SIMULATION.md", "SERVER_COST_SPIKE")], { test: [t(`${ECO}/economy.test.ts`, "simulat")], runtime: "economy_simulation" });
R("ECO-16", "ECONOMY HEALTH REPORT", "docs/ECONOMY_HEALTH_REPORT.md with required sections", "Generated report", [ev("docs/ECONOMY_HEALTH_REPORT.md", "Worst Case")], { testExempt: true });
R("ECO-17", "OWNER REVENUE", "Revenue sources tracked separately; profitability dashboard", "Admin economy + revenue accounts", [ev(`${API}/routes/admin-economy.ts`, "revenue")], { test: [t("tests/integration/wallet.test.ts", "admin/economy")], integration: [ev(`${ADM}/pages/Dashboards.tsx`, "ARPPU")] });
R("ECO-18", "TRANSPARENCY", "Reward rules, pool, fees, eligibility, limits, season rules visible to players", "Wallet/Rewards UI + API", [ev(`${API}/routes/economy.ts`, "rules")], { test: [t("tests/integration/wallet.test.ts", "rules")], integration: [ev(`${WEB}/pages/Wallet.tsx`, "rules|Rules")] });
R("ECO-19", "TERMINOLOGY", "No APY/interest/guaranteed return/passive income in player UI", "Audit grep", [ev("docs/ECONOMY.md", "APY")], { test: [t("tests/integration/terminology.test.ts")] });
R("ECO-20", "ADMIN ECONOMY PARAMS", "Admin config with audit (old/new/reason/admin/timestamp)", "updateEconomyConfig", [ev(`${ECO}/config.ts`, "auditLog")], { integration: [ev(`${API}/routes/admin-economy.ts`, "config")], test: [t(`${ECO}/economy.test.ts`, "config")] });
R("ECO-21", "WORST CASE ECONOMY", "70% claims, deposits drop, spending down, price drop, RPC cost up, bots up, withdrawals up — treasury protected", "Worst-case test/simulation", [ev(`${ECO}/simulation.ts`, "worst|WORST")], { test: [t(`${ECO}/economy.test.ts`, "worst|Worst")] });
R("ECO-22", "COMPLIANCE", "Feature flags / region / account restrictions ready for KYC/AML/age/tax", "FeatureFlag + requireFeature", [ev(SCHEMA, "model FeatureFlag"), ev(`${API}/plugins/core.ts`, "requireFeature")], { test: [t("tests/integration/api.test.ts", "feature flags")] });

// ---------------------------------------------------------------- SECURITY / ANTI-CHEAT
R("SEC-01", "AUTHENTICATION", "Email/password (argon2) + wallet login, short-lived access + refresh rotation, httpOnly secure cookies", "auth package + routes", [ev("packages/authentication/src/password.ts", "argon2"), ev("packages/authentication/src/session.ts", "refresh")], { test: [t("tests/integration/auth.test.ts")], runtime: "api_wallet_login" });
R("SEC-02", "AUTHORIZATION", "RBAC SUPER_ADMIN/ADMIN/MODERATOR/SUPPORT/ECONOMY_MANAGER", "rbac.ts + requireRole", [ev("packages/authentication/src/rbac.ts", "ECONOMY_MANAGER"), ev(`${API}/plugins/core.ts`, "requireRole")], { test: [t("tests/integration/auth.test.ts", "403|admin")] });
R("SEC-03", "SECURITY", "CSRF, CORS, helmet headers, zod validation, rate limits (auth/wallet/withdraw/chat/purchase/market)", "API plugins", [ev(`${API}/plugins/core.ts`, "csrf|CSRF"), ev(`${API}/plugins/core.ts`, "helmet")], { test: [t("tests/integration/auth.test.ts", "csrf|CSRF")] });
R("SEC-04", "LOGGING", "Structured logging with redaction; LOGIN/LOGOUT/MATCH/KILL/…/ADMIN_ACTION events", "telemetry logger", [ev("packages/telemetry/src/logger.ts", "redact")], { test: [t("packages/telemetry/src/telemetry.test.ts")] });
R("SEC-05", "OBSERVABILITY", "Request/correlation/match/tx ids", "ids.ts", [ev("packages/telemetry/src/ids.ts", "correlation")], { test: [t("packages/telemetry/src/telemetry.test.ts")] });
R("SEC-06", "MONITORING", "/health, /ready, /metrics on services", "Endpoints", [ev(`${API}/routes/health.ts`, "ready"), ev("packages/telemetry/src/metrics.ts", "prom-client")], { test: [t("tests/integration/platform-config.test.ts", "/health")], runtime: "api_health" });
R("SEC-07", "ACCOUNT SECURITY", "New wallet/wallet change/new device/suspicious login checks", "Device + wallet change lock", [ev(SCHEMA, "model Device"), ev(`${API}/routes/wallet.ts`, "walletChangeLock|wallet change|lock")], { test: [t("tests/integration/account-security.test.ts", "SUSPICIOUS_LOGIN")] });
R("AC-01", "ANTI-CHEAT", "Speed hack/teleport detection", "anticheat.ts validators", [ev(`${CORE}/anticheat.ts`, "TELEPORT|teleport")], { test: [t(`${CORE}/anticheat.test.ts`, "speed")] });
R("AC-02", "ANTI-CHEAT", "Attack speed/cooldown bypass/damage manipulation", "Fire-rate & cooldown gating server-side", [ev(`${CORE}/anticheat.ts`, "cooldown|fireRate")], { test: [t(`${CORE}/anticheat.test.ts`, "cooldown")] });
R("AC-03", "ANTI-CHEAT", "Packet replay/spam (seq + token bucket)", "anticheat.ts", [ev(`${CORE}/anticheat.ts`, "seq"), ev(`${CORE}/anticheat.ts`, "bucket|Bucket")], { test: [t(`${CORE}/anticheat.test.ts`, "replay|spam")] });
R("AC-04", "ANTI-CHEAT", "Duplicate loot/reward/inventory/trade exploits prevented", "Unique constraints + conditional updates", [ev(SCHEMA, "@@unique\\(\\[userId, source, sourceRef\\]\\)"), ev(SCHEMA, "originRef")], { test: [t("tests/integration/market.test.ts", "race|duplicate")] });
R("BOT-01", "BOT PROTECTION", "Repeated movement, impossible reaction, abnormal farming, clustering → risk levels + review queue", "risk.ts + anticheat heuristics", [ev(`${ECO}/risk.ts`, "cluster"), ev(`${CORE}/anticheat.ts`, "repeat|Repeat")], { test: [t(`${ECO}/economy.test.ts`, "risk")] });
R("BOT-02", "MULTI-ACCOUNT PROTECTION", "Device/IP/behavior/wallet heuristics, manual review, no auto permanent ban", "risk.ts", [ev(`${ECO}/risk.ts`, "device|ip")], { test: [t(`${ECO}/economy.test.ts`, "multi|cluster")] });
R("FRAUD-01", "ANTI-FRAUD", "Chargeback/payment abuse/fake tx/double credit/duplicate withdrawal/market manipulation/reward farming detection", "Controls across deposit/withdraw/market", [ev(`${BC}/deposit.ts`, "reject|Reject"), ev(`${API}/routes/market.ts`, "wash|cluster")], { test: [t(`${BC}/blockchain.test.ts`, "fake|wrong")] });
R("BOTS-01", "DEV BOTS", "Development bots Scout/Miner/Fighter/Tank/Support (wander/collect/attack/flee/assist)", "bots script", [ev(`${GS}/bots/behaviors.ts`, "miner|Miner")], { test: [t("apps/game-server/src/review-fixes.test.ts", "fighter bots|Attack")] });

// ---------------------------------------------------------------- ADMIN / ANALYTICS
R("ADM-01", "ADMIN PANEL", "Admin dashboard (players, rooms, revenue, purchases, deposits, withdrawals, liability, treasury, suspicious, reports, health)", "apps/admin", [ev(`${ADM}/pages/Dashboards.tsx`, "Online|online")], { test: [t("tests/e2e/admin.spec.ts", "every section")], integration: [ev(`${API}/routes/admin.ts`, "overview")], runtime: "admin_build" });
R("ADM-02", "ADMIN PANEL", "Admin management (users, catalog, events, seasons, shop, market, clan, rewards, withdrawals, economy)", "Admin pages + API", [ev(`${ADM}/pages/Operations.tsx`, "ban|Ban"), ev(`${API}/routes/admin.ts`, "ban")], { test: [t("tests/e2e/admin.spec.ts", "/users")] });
R("ADM-03", "ECONOMY ADMIN", "Economy dashboard with required graphs", "Recharts graphs", [ev(`${ADM}/components/Charts.tsx`, "recharts"), ev(`${ADM}/pages/Dashboards.tsx`, "Treasury vs liability"), ev(`${ADM}/pages/Dashboards.tsx`, "Revenue vs rewards")], { test: [t("tests/e2e/admin.spec.ts", "/economy")] });
R("ANA-01", "ANALYTICS", "DAU/MAU/retention/session/match time/kills/ship & weapon usage/win rate/economy sources & sinks/market & withdrawal volume", "AnalyticsEvent + admin queries", [ev(SCHEMA, "model AnalyticsEvent"), ev(`${API}/routes/admin.ts`, "dau|DAU")], { test: [t("tests/integration/platform.test.ts", "analytics")] });

// ---------------------------------------------------------------- WEB / UI
for (const [id, page] of [["Home", "Home"], ["Play", "Play"], ["Galaxy", "Galaxy"], ["Hangar", "Hangar"], ["Inventory", "Inventory"], ["Ships", "Ships"], ["Missions", "Missions"], ["Clan", "Clan"], ["Market", "Market"], ["Auction", "Auction"], ["Leaderboard", "Leaderboard"], ["Season", "Season"], ["BattlePass", "BattlePass"], ["Wallet", "Wallet"], ["Shop", "Shop"], ["Settings", "Settings"], ["Profile", "Profile"]] as const) {
  R(`UI-${id}`, "WEB", `${page} screen wired to real API`, "Route + page component using typed API client", [ev(`${WEB}/pages/${page}.tsx`)], { integration: [ev(`${WEB}/App.tsx`, page)], test: [page === "Play" ? t("tests/e2e/web.play.spec.ts", "joins the galaxy") : t("tests/e2e/web.pages.spec.ts", `"/${page.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()}"`)], runtime: "web_pages" });
}
R("UI-HUD", "HUD", "HUD: health/shield/energy/ammo/speed/target/minimap/skills/cooldowns/quest/objective/squad/notifications", "Play HUD from HudState", [ev(`${WEB}/game/Hud.tsx`, "shield|Shield")], { test: [t("tests/e2e/web.play.spec.ts", "HUD")], runtime: "web_pages" });
R("UI-STYLE", "UI QUALITY", "AAA sci-fi holographic UI, transitions, loading screens", "game-ui components + styles", [ev("packages/game-ui/src/HoloPanel.tsx")], { test: [t("tests/e2e/web.pages.spec.ts", "This panel failed to load")], runtime: "web_pages" });
R("UI-MOBILE", "MOBILE UI", "Bottom nav Home/Hangar/Galaxy/Clan/Shop/Wallet; critical-only combat HUD", "Mobile layout", [ev(`${WEB}/components/nav.ts`, "Wallet|wallet"), ev(`${WEB}/components/AppShell.tsx`, "bottom|Bottom")], { test: [t("tests/e2e/web.pages.spec.ts", "bottom navigation")], runtime: "web_mobile" });
R("UI-I18N", "WEB", "TR/EN localization", "i18n dictionary", [ev(`${WEB}/lib/i18n.ts`, "tr")], { test: [t("apps/web/src/lib/i18n.test.ts", "Envanter"), t("tests/e2e/web.pages.spec.ts", "Envanter")] });

// ---------------------------------------------------------------- MOBILE
R("MOB-01", "CAPACITOR", "Capacitor config & native project", "capacitor.config.ts", [ev("apps/mobile/capacitor.config.ts", "appId")], { test: [t("tests/integration/platform-config.test.ts", "Capacitor")], runtime: "cap_sync" });
R("MOB-02", "ANDROID", "Android project generated and buildable", "apps/mobile/android + gradle build", [ev("apps/mobile/android/app/src/main/AndroidManifest.xml")], { test: [t("tests/integration/platform-config.test.ts", "AndroidManifest")], runtime: "android_build" });
R("MOB-03", "IOS", "iOS project + build", "apps/mobile/ios", [ev("apps/mobile/ios/App/App/Info.plist")], { blocked: "macOS/Xcode not available in this Linux environment — iOS build cannot run" });
R("MOB-04", "MOBILE NATIVE", "Push, secure storage, deep links, lifecycle, haptics, clipboard, share, biometric", "apps/web/src/native/*", ["push", "secureStorage", "deepLinks", "lifecycle", "haptics", "clipboard", "share", "biometric"].map((n) => ev(`${WEB}/native/${n}.ts`)), { test: [t(`${WEB}/native/deepLinks.test.ts`)] });
R("MOB-05", "MOBILE PERFORMANCE", "Battery/GPU/network optimization, background pause", "Lifecycle pause + tier detection", [ev(`${WEB}/native/lifecycle.ts`, "pause|Pause")], { test: [t("tests/integration/platform-config.test.ts", "lifecycle")] });
R("MOB-06", "DEEP LINKS", "Deep/universal/app links architecture", "AndroidManifest intent filters + docs", [ev("docs/MOBILE.md", "App Links|Universal Links")], { testExempt: true });

// ---------------------------------------------------------------- INFRA
R("INF-01", "DATABASE", "Prisma schema with ≥60 required models + indexes", "schema.prisma", [ev(SCHEMA, "model EconomyConfig"), ev(SCHEMA, "model LeaderboardEntry")], { runtime: "db_migrate" , testExempt: true });
R("INF-02", "PRISMA", "Migrations + seed", "prisma/migrations + seed.ts", [ev("prisma/seed.ts", "upsert")], { runtime: "db_seed", testExempt: true });
R("INF-03", "REDIS", "Redis for presence, rate limits, queues (non-critical state)", "ioredis + BullMQ", [ev(`${API}/plugins/core.ts`, "ioredis|Redis"), ev(`${BCS}/queue.ts`, "Redis|redis")], { test: [t("apps/game-server/src/game-server.test.ts", "Redis"), t("apps/blockchain-service/src/processor.test.ts", "queue|recover")], runtime: "redis" });
R("INF-04", "DOCKER", "Docker Compose (Postgres, Redis, API, Game Server, Blockchain Service)", "docker-compose.yml", [ev("docker-compose.yml", "blockchain-service"), ev("docker/node.Dockerfile")], { runtime: "docker_compose", testExempt: true });
R("INF-05", "ENVIRONMENT", ".env.example with required vars", ".env.example", [ev(".env.example", "TREASURY_PUBLIC_KEY"), ev(".env.example", "WITHDRAWAL_FEE")], { testExempt: true });
R("INF-06", "DEPLOYMENT", "Cloudflare/nginx/VPS deployment architecture", "DEPLOYMENT.md + nginx", [ev("docs/DEPLOYMENT.md", "Cloudflare"), ev("docker/nginx/nginx.conf")], { testExempt: true });
R("INF-07", "BACKUP", "Daily backup + PITR + DR plan", "DEPLOYMENT.md", [ev("docs/DEPLOYMENT.md", "point-in-time"), ev("scripts/backup/pg-backup.sh", "pg_dump"), ev("scripts/backup/pg-restore-drill.sh", "pg_restore"), ev("docker-compose.yml", "archive_mode=on")], { testExempt: true, runtime: "backup_drill", partial: "Daily dump + restore drill verified; WAL archiving configured in compose but a PITR restore has not been drilled (Docker daemon unavailable when added)" });
R("INF-08", "TESTING", "Unit/integration/E2E/game server/economy/blockchain tests", "vitest + playwright", [ev("vitest.config.ts"), ev("tests/e2e/web.desktop.spec.ts"), ev("tests/e2e/web.play.spec.ts")], { test: [t("tests/integration/vertical-slice.test.ts", "withdraw")], runtime: "tests" });
R("INF-09", "BUILD", "pnpm lint/typecheck/test/build pass", "Commands succeed", [ev("package.json", "\"build\"")], { runtime: "build", testExempt: true });

// ---------------------------------------------------------------- DOCS
for (const d of ["ARCHITECTURE", "GAME_DESIGN", "NETWORKING", "DATABASE", "BLOCKCHAIN", "ECONOMY", "SECURITY", "MOBILE", "DEPLOYMENT", "REPOSITORIES", "ECONOMY_SIMULATION"]) {
  R(`DOC-${d}`, "DOCUMENTATION", `docs/${d}.md`, "Document exists with substantive content", [ev(`docs/${d}.md`, "\\w{3,}")], { testExempt: true });
}
R("DOC-README", "DOCUMENTATION", "README with setup/env/db/redis/game/api/web/mobile/devnet/wallet/deposit/withdraw/admin/testing/docker/deployment", "README.md", [ev("README.md", "Devnet"), ev("README.md", "Withdrawal")], { testExempt: true });
R("DOC-CLAUDE", "DOCUMENTATION", "CLAUDE.md project rules + .coderabbit.yaml", "Both files", [ev("CLAUDE.md", "Economy rules"), ev("../.coderabbit.yaml", "path_instructions")], { testExempt: true });

// ---------------------------------------------------------------- VERTICAL SLICE (section 144)
const SLICE: [string, string, string][] = [
  ["account", "User enters website → account", "api_wallet_login"],
  ["wallet", "Connect wallet", "web_wallet_ui"],
  ["faction", "Choose faction", "api_faction"],
  ["ship", "Choose ship", "api_faction"],
  ["enter", "Enter galaxy (join room)", "game_join"],
  ["move", "Move (authoritative)", "game_move"],
  ["target", "Target NPC", "game_kill_npc"],
  ["shoot", "Shoot", "game_kill_npc"],
  ["kill", "Kill NPC", "game_kill_npc"],
  ["xp", "Gain XP / level up", "game_kill_npc"],
  ["loot", "Receive loot", "game_loot"],
  ["inventory", "Open inventory", "api_inventory"],
  ["equip", "Equip item / change configuration", "api_inventory"],
  ["pvp", "Enter PvP and kill player", "game_pvp_kill"],
  ["leaderboard", "Leaderboard update", "leaderboard_update"],
  ["event", "Event reward", "event_reward"],
  ["crypto", "Crypto-eligible reward", "crypto_reward"],
  ["wallet page", "Wallet page", "web_pages"],
  ["withdraw", "Devnet withdrawal → tx hash", "devnet_payout"],
];
for (const [k, label, rt] of SLICE) {
  R(`SLICE-${k}`, "MVP VERTICAL SLICE", label, "Works end-to-end at runtime", [ev("tests/integration/vertical-slice.test.ts", k)], { runtime: rt, test: [t("tests/integration/vertical-slice.test.ts", k)] });
}

// ---------------------------------------------------------------- CODERABBIT
R("CR-01", "CODE REVIEW", "CodeRabbit continuous review with fixes", "Reviews run, findings fixed, report", [ev("docs/CODERABBIT_REPORT.md", "Review Date")], { testExempt: true, runtime: "coderabbit" });

export const REQUIREMENTS: Requirement[] = list;
