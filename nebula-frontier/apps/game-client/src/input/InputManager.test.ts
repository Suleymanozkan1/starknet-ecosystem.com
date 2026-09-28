import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InputManager, intentToMoveInput, type InputAction, type MoveIntent } from "./InputManager.js";
import type { MoveInput } from "@nebula/game-core";

/** Minimal DOM stand-ins (vitest runs in node): EventTarget-based window + canvas element. */
class FakeEl extends EventTarget {
  getBoundingClientRect() { return { left: 10, top: 20, width: 800, height: 600 }; }
}
const key = (type: "keydown" | "keyup", code: string) => Object.assign(new Event(type), { code, preventDefault() {} });
const ptr = (type: string, button: number, x = 110, y = 220) => Object.assign(new Event(type), { button, clientX: x, clientY: y, pointerType: "mouse" });

let pads: (Gamepad | null)[] = [];
const g = globalThis as unknown as { window?: EventTarget; navigator: { getGamepads?: () => (Gamepad | null)[] } };
const pad = (axes: number[], pressed: number[]): Gamepad =>
  ({ connected: true, axes, buttons: Array.from({ length: 16 }, (_, i) => ({ pressed: pressed.includes(i), value: pressed.includes(i) ? 1 : 0, touched: false })) }) as unknown as Gamepad;

describe("InputManager (desktop keyboard/mouse + gamepad)", () => {
  let el: FakeEl;
  let input: InputManager;
  let actions: InputAction[];
  const intent = (): MoveIntent => input.readIntent({ mx: 0, my: 0, aim: Number.NaN, boost: false });

  beforeEach(() => {
    g.window = new EventTarget();
    Object.defineProperty(g.navigator, "getGamepads", { value: () => pads, configurable: true });
    pads = [];
    el = new FakeEl();
    input = new InputManager(el as unknown as HTMLElement, false);
    actions = [];
    input.onAction = (a) => actions.push(a);
  });
  afterEach(() => { input.dispose(); delete g.window; });

  it("WASD moves in map space (diagonals normalized) and Shift boosts", () => {
    g.window!.dispatchEvent(key("keydown", "KeyW"));
    g.window!.dispatchEvent(key("keydown", "KeyD"));
    g.window!.dispatchEvent(key("keydown", "ShiftLeft"));
    const i = intent();
    expect(i.mx).toBeCloseTo(Math.SQRT1_2);
    expect(i.my).toBeCloseTo(-Math.SQRT1_2);
    expect(i.boost).toBe(true);
    g.window!.dispatchEvent(key("keyup", "KeyW"));
    g.window!.dispatchEvent(key("keyup", "KeyD"));
    expect(intent().mx).toBe(0);
  });

  it("number keys 1-9 trigger abilities, shortcuts are edge-triggered", () => {
    g.window!.dispatchEvent(key("keydown", "Digit1"));
    g.window!.dispatchEvent(key("keydown", "Digit9"));
    g.window!.dispatchEvent(key("keydown", "Space"));
    g.window!.dispatchEvent(key("keydown", "Space")); // auto-repeat → no second dash
    g.window!.dispatchEvent(key("keydown", "Tab"));
    expect(actions).toEqual([
      { type: "ability", slot: 0 }, { type: "ability", slot: 8 }, { type: "dash" }, { type: "targetNearest" },
    ]);
  });

  it("left click selects + fires, release stops fire; right click selects; mouse aims", () => {
    input.aimFromScreen = (sx, sy) => Math.atan2(sy, sx);
    el.dispatchEvent(ptr("pointermove", 0, 110, 120));
    el.dispatchEvent(ptr("pointerdown", 0));
    g.window!.dispatchEvent(ptr("pointerup", 0));
    el.dispatchEvent(ptr("pointerdown", 2));
    expect(actions).toEqual([
      { type: "selectAt", sx: 100, sy: 200, button: 0 }, { type: "fire", on: true }, { type: "fire", on: false },
      { type: "selectAt", sx: 100, sy: 200, button: 2 },
    ]);
    expect(intent().aim).toBeCloseTo(Math.atan2(100, 100));
  });

  it("window blur releases held keys and stops firing (no stuck input)", () => {
    g.window!.dispatchEvent(key("keydown", "KeyW"));
    g.window!.dispatchEvent(new Event("blur"));
    expect(intent().my).toBe(0);
    expect(actions).toContainEqual({ type: "fire", on: false });
  });

  it("gamepad: sticks move/aim with deadzone, triggers fire, buttons are edge-triggered", () => {
    pads = [pad([0.1, 1, 1, 0], [7, 0])];
    input.pollGamepad();
    let i = intent();
    expect(i.mx).toBe(0); // inside deadzone
    expect(i.my).toBeCloseTo(1);
    expect(i.aim).toBeCloseTo(0); // right stick → aim east
    expect(actions).toEqual([{ type: "fire", on: true }, { type: "dash" }]);
    input.pollGamepad(); // held: no repeats
    expect(actions).toHaveLength(2);
    pads = [pad([0, 0, 0, 0], [])];
    input.pollGamepad();
    expect(actions.at(-1)).toEqual({ type: "fire", on: false });
    pads = [];
    input.pollGamepad();
    i = intent();
    expect(i.my).toBe(0);
    expect(Number.isNaN(i.aim)).toBe(true);
  });

  it("touch joystick input is clamped to unit length", () => {
    input.setJoystick(3, 4);
    const i = intent();
    expect(Math.hypot(i.mx, i.my)).toBeCloseTo(1);
    input.setJoystick(Number.NaN, 0);
    expect(intent().mx).toBe(0);
  });

  it("disabled input emits nothing and produces no movement; dispose removes listeners", () => {
    input.enabled = false;
    g.window!.dispatchEvent(key("keydown", "KeyW"));
    g.window!.dispatchEvent(key("keydown", "Digit2"));
    expect(actions).toHaveLength(0);
    expect(intent().my).toBe(0);
    input.enabled = true;
    input.dispose();
    g.window!.dispatchEvent(key("keydown", "Digit3"));
    expect(actions).toHaveLength(0);
  });
});

describe("intentToMoveInput", () => {
  it("converts screen-relative movement into ship thrust/strafe", () => {
    const out = { thrust: 0, strafe: 0, heading: 0, boost: false, moveTo: null } as unknown as MoveInput;
    intentToMoveInput({ mx: 1, my: 0, aim: Number.NaN, boost: false }, 0, out);
    expect(out.thrust).toBeCloseTo(1);
    expect(out.strafe).toBeCloseTo(0);
    intentToMoveInput({ mx: 0, my: 1, aim: Number.NaN, boost: true }, 0, out);
    expect(out.thrust).toBeCloseTo(0);
    expect(out.strafe).toBeCloseTo(1);
    expect(out.boost).toBe(true);
    intentToMoveInput({ mx: 0, my: 0, aim: 1, boost: false }, 0, out);
    expect(out.thrust).toBe(0);
    expect(out.heading).toBe(1);
  });
});
