/**
 * Renderer showcase (no server): every ship in a grid with engines/trails,
 * shields, weapons & explosions; plus world, boss and hangar views.
 *   /showcase.html?view=ships|world|boss|hangar&tier=ULTRA|HIGH|MEDIUM|LOW
 */
import { Vector3 } from "three";
import type { EntityKind, GraphicsTier, MapDef } from "@nebula/shared";
import { MAPS_BY_ID, NPCS, SHIPS } from "@nebula/config";
import {
  WorldRenderer, createHangarViewer, resolveTier, type EntityRenderInput,
} from "@nebula/game-renderer";

declare global {
  interface Window {
    __showcaseReady?: boolean;
    __showcaseStats?: unknown;
  }
}

const params = new URLSearchParams(location.search);
const view = params.get("view") ?? "ships";
const tierParam = params.get("tier");
const tier: GraphicsTier = resolveTier((tierParam as GraphicsTier | null) ?? "HIGH");
const canvas = document.getElementById("c") as HTMLCanvasElement;
const labels = document.getElementById("labels") as HTMLDivElement;
const hud = document.getElementById("hud") as HTMLDivElement;

function entity(id: string, kind: EntityKind, defId: string, x: number, y: number, heading: number, extra: Partial<EntityRenderInput> = {}): EntityRenderInput {
  return {
    id, kind, defId, cosmetics: "", x, y, heading, vx: 0, vy: 0, hull: 100, maxHull: 100, shield: 100, maxShield: 100,
    flags: 0, cloaked: false, dead: false, targetId: "", ...extra,
  };
}

function emptyMap(base: MapDef, w: number, h: number): MapDef {
  return { ...base, id: `showcase_${base.id}`, width: w, height: h, zones: [], portals: [], spawns: [], asteroidFields: [], stations: [], decor: [] };
}

async function shipsView(): Promise<void> {
  const world = await WorldRenderer.create({ canvas, tier, preserveDrawingBuffer: true });
  const base = MAPS_BY_ID.get("map_aurora_prime");
  if (!base) throw new Error("map missing");
  world.setMap(emptyMap(base, 200, 200));
  const cols = 4, cell = 17;
  const cx = 100, cy = 100;
  const ents: EntityRenderInput[] = [];
  const skins: Record<string, string> = { ship_aurora_lumen: "", ship_riftbreaker: "" };
  SHIPS.forEach((s, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const x = cx + (col - (cols - 1) / 2) * cell;
    const y = cy + (row - 1.5) * cell;
    const e = entity(s.id, "PLAYER", s.id, x, y, -Math.PI / 2, { cosmetics: skins[s.id] ?? "" });
    ents.push(e);
    const el = document.createElement("div");
    el.className = "lbl";
    el.textContent = `${s.name} · ${s.visual.hull}`;
    el.dataset.id = s.id;
    labels.appendChild(el);
  });
  // skinned variants alongside
  const skinned = [
    entity("skin_a", "PLAYER", "ship_aurora_lumen", cx - 2.6 * cell, cy - 1.5 * cell, -Math.PI / 2, { cosmetics: "skin_lumen_solar_crown,cos_trail_stardust" }),
    entity("skin_b", "PLAYER", "ship_riftbreaker", cx + 2.6 * cell, cy - 1.5 * cell, -Math.PI / 2, { cosmetics: "skin_riftbreaker_voidborn,cos_shield_hexweave" }),
    entity("skin_c", "PLAYER", "ship_nova_ember", cx - 2.6 * cell, cy + 1.5 * cell, -Math.PI / 2, { cosmetics: "skin_ember_phoenix" }),
    entity("skin_d", "PLAYER", "ship_cradle", cx + 2.6 * cell, cy + 1.5 * cell, -Math.PI / 2, { cosmetics: "skin_cradle_leviathan_bone" }),
  ];
  ents.push(...skinned);
  world.camera.follow(Number(params.get("x") ?? cx), Number(params.get("y") ?? cy));
  world.camera.setZoom(Number(params.get("zoom") ?? 132));
  const norm = params.get("norm") !== "0";
  world.camera.snap();
  const pos = { x: 0, y: 0 };
  let frames = 0;
  const loop = (now: number): void => {
    const t = now / 1000;
    for (const e of ents) {
      // gentle forward drift so engines & trails are active
      e.vx = 0;
      e.vy = -12 - (Math.sin(t + e.x) + 1) * 4;
      e.flags = frames % 240 < 120 && e.id.startsWith("ship_k") ? 2 : 0;
      world.syncEntity(e, 1 / 60);
      if (norm && frames === 0) {
        const def = SHIPS.find((x) => x.id === e.defId);
        if (def) world.setDisplayScale(e.id, Math.max(0.6, Math.min(2.2, 6.5 / def.visual.length)));
      }
    }
    if (frames % 40 === 5) {
      const a = ents[Math.floor(Math.random() * 16)], b = ents[Math.floor(Math.random() * 16)];
      if (a && b && a !== b) world.attack(a.id, a.x, a.y, b.x, b.y, ["#ff4d4d", "#48cae4", "#ffd60a", "#f72585"][frames % 4] ?? "#fff", frames % 3 === 0 ? "missile" : frames % 3 === 1 ? "bolt" : "beam", 500, true);
      if (b) world.damage(b.id, b.x + 1, b.y + 1, 10, frames % 2 === 0 ? 0 : 5, false);
    }
    if (frames % 150 === 60) world.explosionAt(cx + (Math.random() - 0.5) * 80, cy + 2.6 * cell, 1.5);
    const stats = world.frame(now);
    for (const el of Array.from(labels.children) as HTMLElement[]) {
      const e = ents.find((x) => x.id === el.dataset.id);
      if (!e) continue;
      world.mapToScreen(e.x, e.y + 6.5, pos);
      el.style.left = `${pos.x}px`;
      el.style.top = `${pos.y}px`;
    }
    hud.textContent = `tier ${tier} · ${stats.fps.toFixed(0)} fps · ${stats.drawCalls} calls · ${(stats.triangles / 1000).toFixed(0)}k tris · pr ${stats.pixelRatio}`;
    window.__showcaseStats = stats;
    frames++;
    if (frames === 150) window.__showcaseReady = true;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

async function worldView(): Promise<void> {
  const world = await WorldRenderer.create({ canvas, tier, preserveDrawingBuffer: true });
  const map = MAPS_BY_ID.get(params.get("map") ?? "map_aurora_prime");
  if (!map) throw new Error("map missing");
  world.setMap(map);
  const st = map.stations[0];
  const cx = Number(params.get("x") ?? (st ? st.x + 40 : map.width / 2));
  const cy = Number(params.get("y") ?? (st ? st.y : map.height / 2));
  const ents: EntityRenderInput[] = [];
  const me = entity("me", "PLAYER", "ship_aurora_lumen", cx, cy, -0.3);
  world.localId = "me";
  ents.push(me);
  NPCS.filter((n) => n.kind === "NPC").slice(0, 8).forEach((n, i) => {
    const a = (i / 8) * Math.PI * 2;
    ents.push(entity(`npc${i}`, "NPC", n.id, cx + Math.cos(a) * 26, cy + Math.sin(a) * 20, a + Math.PI));
  });
  for (let i = 0; i < 18; i++) {
    const res = ["TITANIUM", "PLASMA_ORE", "CRYONITE", "QUANTUM_SHARD"][i % 4] ?? "TITANIUM";
    ents.push(entity(`ast${i}`, "ASTEROID", res, cx + 30 + (i % 6) * 5 + Math.sin(i) * 2, cy - 25 + Math.floor(i / 6) * 6, 0, { maxHull: 400 }));
  }
  ["COMMON", "RARE", "EPIC", "LEGENDARY"].forEach((r, i) => ents.push(entity(`loot${i}`, "LOOT", r, cx - 12 + i * 4, cy + 14, 0)));
  world.camera.follow(cx, cy);
  world.camera.setZoom(Number(params.get("zoom") ?? 110));
  world.camera.snap();
  let frames = 0;
  const v = new Vector3();
  const loop = (now: number): void => {
    const t = now / 1000;
    for (const e of ents) {
      if (e.kind === "NPC") {
        e.heading += 0.004;
        e.vx = Math.cos(e.heading) * 15;
        e.vy = Math.sin(e.heading) * 15;
      }
      if (e.id === "me") {
        e.vx = 20; e.vy = 0;
        e.flags = 8;
        e.targetId = "ast2";
        e.hull = 45 + Math.sin(t) * 5;
      }
      world.syncEntity(e, 1 / 60);
    }
    if (frames % 30 === 3) {
      const n = ents[1 + (frames / 30) % 8];
      if (n) world.attack(n.id, n.x, n.y, me.x, me.y, "#70e000", "bolt", 400, true);
      world.damage("me", me.x, me.y - 1, 8, 0, false);
    }
    if (frames % 120 === 50) {
      world.fx.emp(v.set(cx - 20, 0.2, cy - 10), 10);
      world.explosionAt(cx + 15, cy + 18, 2);
    }
    const stats = world.frame(now);
    hud.textContent = `world ${map.name} · ${stats.fps.toFixed(0)} fps · ${stats.drawCalls} calls`;
    frames++;
    if (frames === 150) window.__showcaseReady = true;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

async function bossView(): Promise<void> {
  const world = await WorldRenderer.create({ canvas, tier, preserveDrawingBuffer: true });
  const map = MAPS_BY_ID.get("map_astra_graveyard");
  if (!map) throw new Error("map missing");
  world.setMap(emptyMap(map, 400, 400));
  const bossId = params.get("boss") ?? "boss_vanta_colossus";
  const boss = entity("boss", "BOSS", bossId, 200, 200, -Math.PI / 2, { maxShield: 1000, shield: 800, hull: 60 });
  const players = [0, 1, 2, 3, 4].map((i) => entity(`p${i}`, "PLAYER", SHIPS[i * 3]?.id ?? "ship_kestrel", 170 + i * 15, 245, -Math.PI / 2));
  const phases = ["SHIELD", "ARMOR", "REACTOR", "ENRAGE"] as const;
  const phase = params.get("phase");
  world.camera.follow(200, 212);
  world.camera.setZoom(Number(params.get("zoom") ?? 110));
  world.camera.snap();
  let frames = 0;
  const loop = (now: number): void => {
    world.syncEntity(boss, 1 / 60);
    for (const p of players) { p.vy = -6; world.syncEntity(p, 1 / 60); }
    if (frames === 1) world.setBossPhase("boss", (phase as (typeof phases)[number] | null) ?? "REACTOR");
    if (!phase && frames % 240 === 0) world.setBossPhase("boss", phases[(frames / 240) % 4] ?? "SHIELD");
    if (frames % 25 === 0) {
      const p = players[(frames / 25) % players.length];
      if (p) world.attack(p.id, p.x, p.y, 200 + (Math.random() - 0.5) * 20, 205, "#48cae4", "bolt", 350, true);
      world.damage("boss", 200 + (Math.random() - 0.5) * 20, 210, 10, 0, false);
    }
    if (frames % 180 === 20) world.telegraph(185, 240, 14, "#ff2d55", 1500, () => world.explosionAt(185, 240, 3));
    const stats = world.frame(now);
    hud.textContent = `boss ${bossId} · ${stats.fps.toFixed(0)} fps · ${stats.drawCalls} calls`;
    frames++;
    if (frames === 150) window.__showcaseReady = true;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

async function hangarView(): Promise<void> {
  const viewer = await createHangarViewer(canvas, { shipDef: params.get("ship") ?? "ship_sovereign", tier, cosmetics: [] });
  const compare = params.get("compare");
  if (compare) viewer.setCompare(compare);
  viewer.previewEngines(true);
  let n = 0;
  const iv = setInterval(() => {
    n++;
    if (n % 3 === 0) viewer.fireWeapons();
    if (n === 12) viewer.previewShield();
    if (n === 20) window.__showcaseReady = true;
  }, 100);
  window.addEventListener("beforeunload", () => { clearInterval(iv); viewer.dispose(); });
}

const views: Record<string, () => Promise<void>> = { ships: shipsView, world: worldView, boss: bossView, hangar: hangarView };
(views[view] ?? shipsView)().catch((err: unknown) => {
  hud.textContent = `showcase error: ${err instanceof Error ? err.message : String(err)}`;
  console.error(err);
});
