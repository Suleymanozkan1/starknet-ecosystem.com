import type { MoveInput } from "@nebula/game-core";

/** Discrete actions produced by keyboard/mouse/gamepad. */
export type InputAction =
  | { type: "fire"; on: boolean }
  | { type: "secondary"; on: boolean }
  | { type: "selectAt"; sx: number; sy: number; button: 0 | 2 }
  | { type: "moveTo"; sx: number; sy: number }
  | { type: "ability"; slot: number }
  | { type: "dash" }
  | { type: "targetNearest" }
  | { type: "targetCycle" }
  | { type: "clearTarget" }
  | { type: "interact" }
  | { type: "pickup" }
  | { type: "mine" }
  | { type: "respawn" }
  | { type: "zoom"; delta: number }
  | { type: "toggleSecondary" };

/**
 * Movement intent in MAP space (x right, y down) plus desired facing. The game
 * converts it into thrust/strafe relative to the ship's current heading, so
 * WASD / joystick movement is screen-relative (DarkOrbit-style) while the ship
 * can face the aim direction (twin-stick).
 */
export interface MoveIntent {
  mx: number;
  my: number;
  /** Desired heading (radians) or NaN = face movement direction / keep. */
  aim: number;
  boost: boolean;
}

/** Convert a map-space move intent to a game-core MoveInput for a ship at `heading`. */
export function intentToMoveInput(intent: MoveIntent, heading: number, out: MoveInput): MoveInput {
  const mag = Math.min(1, Math.hypot(intent.mx, intent.my));
  let desired = intent.aim;
  if (Number.isNaN(desired) && mag > 0.05) desired = Math.atan2(intent.my, intent.mx);
  if (mag <= 0.05) {
    out.thrust = 0;
    out.strafe = 0;
  } else {
    const dx = intent.mx / Math.max(1e-6, Math.hypot(intent.mx, intent.my));
    const dy = intent.my / Math.max(1e-6, Math.hypot(intent.mx, intent.my));
    const fx = Math.cos(heading), fy = Math.sin(heading);
    // right vector (heading + 90°) in screen space, matching stepShip
    const rx = -fy, ry = fx;
    out.thrust = Math.max(-1, Math.min(1, (dx * fx + dy * fy) * mag));
    out.strafe = Math.max(-1, Math.min(1, (dx * rx + dy * ry) * mag));
  }
  out.heading = desired;
  out.boost = intent.boost;
  out.moveTo = null;
  return out;
}

const DEADZONE = 0.18;
const dz = (v: number): number => (Math.abs(v) < DEADZONE ? 0 : (v - Math.sign(v) * DEADZONE) / (1 - DEADZONE));

/**
 * Desktop keyboard + mouse and Gamepad API input. Touch is driven externally
 * (web app → setJoystick / setAim). All listeners are removed on dispose().
 */
export class InputManager {
  private readonly keys = new Set<string>();
  private readonly el: HTMLElement;
  private readonly disposers: (() => void)[] = [];
  private mouseX = -1;
  private mouseY = -1;
  private mouseActive = false;
  private joyX = 0;
  private joyY = 0;
  private externalAim: number | null = null;
  private externalBoost = false;
  private padPrev: boolean[] = [];
  private padAim: number | null = null;
  private padMoveX = 0;
  private padMoveY = 0;
  enabled = true;
  /** Mouse aim resolution (screen → map heading), provided by the game. */
  aimFromScreen: ((sx: number, sy: number) => number | null) | null = null;
  onAction: ((a: InputAction) => void) | null = null;
  readonly touchMode: boolean;

  constructor(el: HTMLElement, touchMode: boolean) {
    this.el = el;
    this.touchMode = touchMode;
    const on = <K extends keyof WindowEventMap>(target: Window | HTMLElement, type: K, fn: (e: WindowEventMap[K]) => void, opts?: AddEventListenerOptions): void => {
      target.addEventListener(type, fn as EventListener, opts);
      this.disposers.push(() => target.removeEventListener(type, fn as EventListener, opts));
    };
    on(window, "keydown", (e) => this.onKey(e, true));
    on(window, "keyup", (e) => this.onKey(e, false));
    on(window, "blur", () => {
      this.keys.clear();
      this.emit({ type: "fire", on: false });
    });
    if (!touchMode) {
      on(el, "pointermove", (e) => {
        const r = el.getBoundingClientRect();
        this.mouseX = e.clientX - r.left;
        this.mouseY = e.clientY - r.top;
        this.mouseActive = true;
      });
      on(el, "pointerleave", () => { this.mouseActive = false; });
      on(el, "pointerdown", (e) => {
        if (e.pointerType === "touch") return;
        const r = el.getBoundingClientRect();
        const sx = e.clientX - r.left, sy = e.clientY - r.top;
        if (e.button === 0) {
          this.emit({ type: "selectAt", sx, sy, button: 0 });
          this.emit({ type: "fire", on: true });
        } else if (e.button === 2) {
          this.emit({ type: "selectAt", sx, sy, button: 2 });
        }
      });
      on(window, "pointerup", (e) => {
        if (e.pointerType === "touch") return;
        if (e.button === 0) this.emit({ type: "fire", on: false });
      });
      on(el, "contextmenu", (e) => e.preventDefault());
      on(el, "wheel", (e) => {
        e.preventDefault();
        this.emit({ type: "zoom", delta: Math.sign(e.deltaY) * 0.1 });
      }, { passive: false });
    }
  }

  private emit(a: InputAction): void {
    if (this.enabled) this.onAction?.(a);
  }

  private isTyping(e: KeyboardEvent): boolean {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (this.isTyping(e)) return;
    const code = e.code;
    const was = this.keys.has(code);
    if (down) this.keys.add(code);
    else this.keys.delete(code);
    if (!down || was) return; // edge-triggered actions below
    switch (code) {
      case "Space": e.preventDefault(); this.emit({ type: "dash" }); break;
      case "Tab": e.preventDefault(); this.emit({ type: "targetNearest" }); break;
      case "KeyE": this.emit({ type: "interact" }); break;
      case "KeyF": this.emit({ type: "pickup" }); break;
      case "KeyM": this.emit({ type: "mine" }); break;
      case "KeyQ": this.emit({ type: "toggleSecondary" }); break;
      case "KeyR": this.emit({ type: "respawn" }); break;
      case "Escape": this.emit({ type: "clearTarget" }); break;
      case "Equal": case "NumpadAdd": this.emit({ type: "zoom", delta: -0.1 }); break;
      case "Minus": case "NumpadSubtract": this.emit({ type: "zoom", delta: 0.1 }); break;
      default:
        if (/^Digit[1-9]$/.test(code)) this.emit({ type: "ability", slot: Number(code.slice(5)) - 1 });
    }
  }

  setJoystick(x: number, y: number): void {
    const m = Math.hypot(x, y);
    const k = m > 1 ? 1 / m : 1;
    this.joyX = Number.isFinite(x) ? x * k : 0;
    this.joyY = Number.isFinite(y) ? y * k : 0;
  }

  setAim(angle: number | null): void {
    this.externalAim = angle !== null && Number.isFinite(angle) ? angle : null;
  }

  setBoost(on: boolean): void {
    this.externalBoost = on;
  }

  /** Poll gamepads (call once per frame). */
  pollGamepad(): void {
    const pads = typeof navigator !== "undefined" && navigator.getGamepads ? navigator.getGamepads() : [];
    let pad: Gamepad | null = null;
    for (const p of pads) if (p && p.connected) { pad = p; break; }
    if (!pad) {
      this.padMoveX = this.padMoveY = 0;
      this.padAim = null;
      return;
    }
    const ax = (i: number): number => dz(pad?.axes[i] ?? 0);
    this.padMoveX = ax(0);
    this.padMoveY = ax(1);
    const rx = ax(2), ry = ax(3);
    this.padAim = Math.hypot(rx, ry) > 0.3 ? Math.atan2(ry, rx) : null;
    const btn = (i: number): boolean => !!pad?.buttons[i]?.pressed;
    const edge = (i: number): boolean => btn(i) && !this.padPrev[i];
    const release = (i: number): boolean => !btn(i) && !!this.padPrev[i];
    if (edge(7)) this.emit({ type: "fire", on: true });
    if (release(7)) this.emit({ type: "fire", on: false });
    if (edge(6)) this.emit({ type: "secondary", on: true });
    if (release(6)) this.emit({ type: "secondary", on: false });
    if (edge(0)) this.emit({ type: "dash" });
    if (edge(2)) this.emit({ type: "interact" });
    if (edge(3)) this.emit({ type: "pickup" });
    if (edge(4) || edge(5)) this.emit({ type: "targetCycle" });
    if (edge(12)) this.emit({ type: "ability", slot: 0 });
    if (edge(15)) this.emit({ type: "ability", slot: 1 });
    if (edge(13)) this.emit({ type: "ability", slot: 2 });
    if (edge(14)) this.emit({ type: "ability", slot: 3 });
    if (edge(9)) this.emit({ type: "respawn" });
    if (edge(8)) this.emit({ type: "mine" });
    this.padPrev.length = pad.buttons.length;
    for (let i = 0; i < pad.buttons.length; i++) this.padPrev[i] = btn(i);
    this.gamepadBoost = btn(1) || btn(10);
  }

  private gamepadBoost = false;

  /** Current movement intent in map space. */
  readIntent(out: MoveIntent): MoveIntent {
    let mx = 0, my = 0;
    if (this.enabled) {
      if (this.keys.has("KeyW") || this.keys.has("ArrowUp")) my -= 1;
      if (this.keys.has("KeyS") || this.keys.has("ArrowDown")) my += 1;
      if (this.keys.has("KeyA") || this.keys.has("ArrowLeft")) mx -= 1;
      if (this.keys.has("KeyD") || this.keys.has("ArrowRight")) mx += 1;
      const km = Math.hypot(mx, my);
      if (km > 1) { mx /= km; my /= km; }
      mx += this.joyX + this.padMoveX;
      my += this.joyY + this.padMoveY;
    }
    out.mx = mx;
    out.my = my;
    let aim = Number.NaN;
    if (this.externalAim !== null) aim = this.externalAim;
    else if (this.padAim !== null) aim = this.padAim;
    else if (!this.touchMode && this.mouseActive && this.aimFromScreen) {
      const a = this.aimFromScreen(this.mouseX, this.mouseY);
      if (a !== null) aim = a;
    }
    out.aim = aim;
    out.boost = this.enabled && (this.keys.has("ShiftLeft") || this.keys.has("ShiftRight") || this.externalBoost || this.gamepadBoost);
    return out;
  }

  get mouse(): { x: number; y: number; active: boolean } {
    return { x: this.mouseX, y: this.mouseY, active: this.mouseActive };
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers.length = 0;
    this.keys.clear();
    this.onAction = null;
    this.aimFromScreen = null;
  }
}
