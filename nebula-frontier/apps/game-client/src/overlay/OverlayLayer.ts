import Phaser from "phaser";
import type { MapDef } from "@nebula/shared";
import type { MinimapEntity, MinimapRelation } from "../types.js";

export const RELATION_COLORS: Readonly<Record<MinimapRelation, number>> = {
  self: 0xffffff, squad: 0x3ef08a, clan: 0x5fd4ff, faction: 0x6ea8ff, hostile: 0xff4d4d, neutral: 0xc9c9c9, npc: 0xff8a3d,
  boss: 0xff2d7a, resource: 0xffd166, loot: 0xb388ff, portal: 0x6ee7ff, station: 0x9fe8ff, objective: 0xfff275, event: 0xff9f43,
  marker: 0xffffff,
};

export interface Nameplate {
  id: string;
  sx: number;
  sy: number;
  name: string;
  level: number;
  hull: number;
  shield: number;
  rel: MinimapRelation;
  visible: boolean;
}

export interface ReticleState {
  active: boolean;
  sx: number;
  sy: number;
  radius: number;
  hostile: boolean;
  lead: boolean;
  leadX: number;
  leadY: number;
  inRange: boolean;
}

/** Data the game writes every frame; the overlay scene only reads it (no per-frame allocation). */
export class OverlayModel {
  map: MapDef | null = null;
  selfX = 0;
  selfY = 0;
  selfHeading = 0;
  /** Visible world rect in map coords (camera footprint). */
  viewX = 0;
  viewY = 0;
  viewW = 0;
  viewH = 0;
  readonly radar: MinimapEntity[] = [];
  radarCount = 0;
  readonly plates: Nameplate[] = [];
  plateCount = 0;
  readonly reticle: ReticleState = { active: false, sx: 0, sy: 0, radius: 30, hostile: true, lead: false, leadX: 0, leadY: 0, inRange: false };
  compact = false;

  radarSlot(i: number): MinimapEntity {
    let e = this.radar[i];
    if (!e) {
      e = { id: "", x: 0, y: 0, rel: "neutral" };
      this.radar[i] = e;
    }
    return e;
  }

  plateSlot(i: number): Nameplate {
    let p = this.plates[i];
    if (!p) {
      p = { id: "", sx: 0, sy: 0, name: "", level: 0, hull: 1, shield: 0, rel: "neutral", visible: false };
      this.plates[i] = p;
    }
    return p;
  }
}

interface FloatText { t: Phaser.GameObjects.Text; life: number; max: number; ox: number; oy: number; vx: number; vy: number; mx: number; my: number; id: string; active: boolean }

/**
 * Map → screen projection supplied by the game (returns false when off-screen).
 * When `followId` names a live entity, its current rendered position is used.
 */
export type Projector = (mx: number, my: number, followId: string, out: { x: number; y: number }) => boolean;

const PLATE_POOL = 40;
const FLOAT_POOL = 48;

class OverlayScene extends Phaser.Scene {
  model!: OverlayModel;
  project: Projector | null = null;
  private readonly scr = { x: 0, y: 0 };
  private radarG!: Phaser.GameObjects.Graphics;
  private hudG!: Phaser.GameObjects.Graphics;
  private plateTexts: Phaser.GameObjects.Text[] = [];
  private floats: FloatText[] = [];
  private frame = 0;
  private reticleSpin = 0;

  constructor() {
    super({ key: "overlay", active: true });
  }

  create(): void {
    this.hudG = this.add.graphics();
    this.radarG = this.add.graphics();
    for (let i = 0; i < PLATE_POOL; i++) {
      const t = this.add.text(0, 0, "", { fontFamily: "Inter, system-ui, sans-serif", fontSize: "11px", color: "#dfe9ff", stroke: "#000000", strokeThickness: 3 });
      t.setOrigin(0.5, 1).setVisible(false);
      this.plateTexts.push(t);
    }
    for (let i = 0; i < FLOAT_POOL; i++) {
      const t = this.add.text(0, 0, "", { fontFamily: "Inter, system-ui, sans-serif", fontSize: "16px", fontStyle: "bold", color: "#ffffff", stroke: "#000000", strokeThickness: 4 });
      t.setOrigin(0.5, 0.5).setVisible(false);
      this.floats.push({ t, life: 0, max: 1, ox: 0, oy: 0, vx: 0, vy: 0, mx: 0, my: 0, id: "", active: false });
    }
  }

  /** Spawn floating text anchored at map position (mx, my), with a screen-space pixel offset. */
  spawnText(mx: number, my: number, text: string, color: string, size: number, offsetY = 0, followId = ""): void {
    let f = this.floats.find((x) => !x.active);
    if (!f) {
      // recycle the oldest
      f = this.floats.reduce((a, b) => (a.life > b.life ? a : b));
    }
    f.active = true;
    f.life = 0;
    f.max = 1.1;
    f.mx = mx;
    f.my = my;
    f.id = followId;
    f.ox = (Math.random() - 0.5) * 16;
    f.oy = offsetY;
    f.vx = (Math.random() - 0.5) * 30;
    f.vy = -55 - Math.random() * 20;
    f.t.setText(text).setColor(color).setFontSize(size).setAlpha(1).setScale(1.25).setVisible(false);
  }

  override update(_time: number, deltaMs: number): void {
    if (!this.model) return;
    const dt = Math.min(0.1, deltaMs / 1000);
    this.frame++;
    this.reticleSpin += dt * 1.5;
    this.drawHud();
    if (this.frame % 2 === 0) this.drawRadar();
    for (const f of this.floats) {
      if (!f.active) continue;
      f.life += dt;
      const k = f.life / f.max;
      if (k >= 1) {
        f.active = false;
        f.t.setVisible(false);
        continue;
      }
      f.ox += f.vx * dt;
      f.oy += f.vy * dt;
      f.vy += 40 * dt;
      if (!this.project || !this.project(f.mx, f.my, f.id, this.scr)) {
        f.t.setVisible(false);
        continue;
      }
      f.t.setVisible(true).setPosition(this.scr.x + f.ox, this.scr.y + f.oy);
      f.t.setAlpha(k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3);
      f.t.setScale(1 + Math.max(0, 0.25 - k));
    }
  }

  private drawHud(): void {
    const g = this.hudG;
    const m = this.model;
    g.clear();
    // nameplates & bars
    let ti = 0;
    for (let i = 0; i < m.plateCount && ti < PLATE_POOL; i++) {
      const p = m.plates[i];
      if (!p || !p.visible) continue;
      const t = this.plateTexts[ti++];
      if (!t) break;
      const col = RELATION_COLORS[p.rel];
      t.setVisible(true).setPosition(p.sx, p.sy - 10).setText(p.level > 0 ? `${p.name}  ${p.level}` : p.name);
      t.setColor(`#${col.toString(16).padStart(6, "0")}`);
      const w = 46, x = p.sx - w / 2, y = p.sy - 7;
      g.fillStyle(0x000000, 0.55).fillRect(x - 1, y - 1, w + 2, 7);
      g.fillStyle(0x4cc9f0, 0.95).fillRect(x, y, w * Math.max(0, Math.min(1, p.shield)), 2);
      g.fillStyle(p.hull > 0.5 ? 0x52e07a : p.hull > 0.25 ? 0xffc53d : 0xff4d4d, 0.95).fillRect(x, y + 3, w * Math.max(0, Math.min(1, p.hull)), 3);
    }
    for (let i = ti; i < PLATE_POOL; i++) this.plateTexts[i]?.setVisible(false);

    // lock-on reticle + lead indicator
    const r = m.reticle;
    if (r.active) {
      const col = r.hostile ? (r.inRange ? 0xff3b3b : 0xff9a3c) : 0x6ee7ff;
      const rad = Math.max(18, r.radius);
      g.lineStyle(2, col, 0.95);
      for (let k = 0; k < 4; k++) {
        const a = this.reticleSpin + (k * Math.PI) / 2;
        const a0 = a - 0.35, a1 = a + 0.35;
        g.beginPath();
        g.arc(r.sx, r.sy, rad, a0, a1, false);
        g.strokePath();
        const tx = r.sx + Math.cos(a) * (rad + 6), ty = r.sy + Math.sin(a) * (rad + 6);
        g.fillStyle(col, 0.95).fillTriangle(tx, ty, r.sx + Math.cos(a - 0.08) * (rad + 1), r.sy + Math.sin(a - 0.08) * (rad + 1), r.sx + Math.cos(a + 0.08) * (rad + 1), r.sy + Math.sin(a + 0.08) * (rad + 1));
      }
      if (r.lead) {
        g.lineStyle(1, col, 0.7);
        g.lineBetween(r.sx, r.sy, r.leadX, r.leadY);
        g.strokeCircle(r.leadX, r.leadY, 6);
        g.fillStyle(col, 0.9).fillCircle(r.leadX, r.leadY, 2);
      }
    }
  }

  private drawRadar(): void {
    const g = this.radarG;
    const m = this.model;
    g.clear();
    const map = m.map;
    if (!map) return;
    const W = this.scale.width;
    const maxW = m.compact ? 130 : 210;
    const scale = maxW / Math.max(map.width, map.height * 1.25);
    const w = map.width * scale, h = map.height * scale;
    const x0 = W - w - 14, y0 = 14;
    g.fillStyle(0x050b18, 0.72).fillRoundedRect(x0 - 6, y0 - 6, w + 12, h + 12, 8);
    g.lineStyle(1, 0x2f5a8a, 0.9).strokeRoundedRect(x0 - 6, y0 - 6, w + 12, h + 12, 8);
    // grid
    g.lineStyle(1, 0x16304f, 0.6);
    for (let i = 1; i < 4; i++) {
      g.lineBetween(x0 + (w * i) / 4, y0, x0 + (w * i) / 4, y0 + h);
      g.lineBetween(x0, y0 + (h * i) / 4, x0 + w, y0 + (h * i) / 4);
    }
    // zones
    for (const z of map.zones) {
      const c = z.type === "SAFE" ? 0x38d98a : z.type === "PVP" || z.type === "HIGH_RISK" ? 0xff4d4d : z.type === "MINING" ? 0xffd166 : z.type === "BOSS" ? 0xc77dff : 0x5a7aa5;
      g.lineStyle(1, c, 0.45).strokeCircle(x0 + z.x * scale, y0 + z.y * scale, z.radius * scale);
    }
    // stations & portals
    for (const s of map.stations) {
      g.fillStyle(RELATION_COLORS.station, 0.95).fillRect(x0 + s.x * scale - 3, y0 + s.y * scale - 3, 6, 6);
    }
    for (const p of map.portals) {
      const px = x0 + p.x * scale, py = y0 + p.y * scale;
      g.fillStyle(RELATION_COLORS.portal, 0.95).fillTriangle(px, py - 4, px + 4, py, px, py + 4).fillTriangle(px, py - 4, px - 4, py, px, py + 4);
    }
    // camera footprint
    g.lineStyle(1, 0xffffff, 0.25).strokeRect(x0 + m.viewX * scale, y0 + m.viewY * scale, m.viewW * scale, m.viewH * scale);
    // entities
    for (let i = 0; i < m.radarCount; i++) {
      const e = m.radar[i];
      if (!e) continue;
      const ex = x0 + e.x * scale, ey = y0 + e.y * scale;
      if (ex < x0 - 2 || ey < y0 - 2 || ex > x0 + w + 2 || ey > y0 + h + 2) continue;
      const c = RELATION_COLORS[e.rel];
      switch (e.rel) {
        case "boss": g.fillStyle(c, 1).fillCircle(ex, ey, 4.5); g.lineStyle(1, 0xffffff, 0.8).strokeCircle(ex, ey, 6.5); break;
        case "resource": g.fillStyle(c, 0.7).fillRect(ex - 1, ey - 1, 2, 2); break;
        case "loot": g.fillStyle(c, 0.9).fillRect(ex - 1.5, ey - 1.5, 3, 3); break;
        case "objective": case "event": case "marker": g.lineStyle(1.5, c, 1).strokeCircle(ex, ey, 4); break;
        default: g.fillStyle(c, 1).fillCircle(ex, ey, e.rel === "npc" ? 1.8 : 2.3);
      }
    }
    // self arrow
    const sx = x0 + m.selfX * scale, sy = y0 + m.selfY * scale, a = m.selfHeading;
    g.fillStyle(0xffffff, 1).fillTriangle(
      sx + Math.cos(a) * 6, sy + Math.sin(a) * 6,
      sx + Math.cos(a + 2.5) * 4, sy + Math.sin(a + 2.5) * 4,
      sx + Math.cos(a - 2.5) * 4, sy + Math.sin(a - 2.5) * 4,
    );
  }
}

/**
 * Transparent Phaser 4 overlay canvas above the Three.js world: minimap/radar,
 * nameplates + bars, floating combat text, lock-on reticle and lead indicator.
 * Input is disabled — pointer events pass through to the world canvas.
 */
export class OverlayLayer {
  readonly model = new OverlayModel();
  private readonly game: Phaser.Game;
  private scene: OverlayScene | null = null;
  private readonly pending: { mx: number; my: number; text: string; color: string; size: number; offsetY: number; followId: string }[] = [];
  private projector: Projector | null = null;
  private readonly parent: HTMLElement;

  constructor(parent: HTMLElement, width: number, height: number) {
    this.parent = parent;
    const scene = new OverlayScene();
    scene.model = this.model;
    this.game = new Phaser.Game({
      type: Phaser.WEBGL,
      parent,
      width: Math.max(1, Math.floor(width)),
      height: Math.max(1, Math.floor(height)),
      transparent: true,
      banner: false,
      audio: { noAudio: true },
      input: { keyboard: false, mouse: false, touch: false, gamepad: false },
      render: { antialias: true, powerPreference: "low-power" },
      scale: { mode: Phaser.Scale.NONE },
      scene: [scene],
      callbacks: {
        postBoot: () => {
          this.scene = scene;
          scene.project = this.projector;
          for (const p of this.pending) scene.spawnText(p.mx, p.my, p.text, p.color, p.size, p.offsetY, p.followId);
          this.pending.length = 0;
          const c = this.game.canvas;
          c.style.pointerEvents = "none";
          c.style.position = "absolute";
          c.style.inset = "0";
        },
      },
    });
  }

  setProjector(p: Projector): void {
    this.projector = p;
    if (this.scene) this.scene.project = p;
  }

  /** Floating combat text anchored at a MAP position (follows the camera). */
  floatText(mx: number, my: number, text: string, color: string, size = 16, offsetY = 0, followId = ""): void {
    if (this.scene) this.scene.spawnText(mx, my, text, color, size, offsetY, followId);
    else if (this.pending.length < 16) this.pending.push({ mx, my, text, color, size, offsetY, followId });
  }

  resize(w: number, h: number): void {
    const width = Math.max(1, Math.floor(w)), height = Math.max(1, Math.floor(h));
    this.game.scale.resize(width, height);
  }

  setPaused(p: boolean): void {
    if (p) this.game.loop.sleep();
    else this.game.loop.wake();
  }

  destroy(): void {
    this.scene = null;
    this.game.destroy(true, false);
    void this.parent;
  }
}
