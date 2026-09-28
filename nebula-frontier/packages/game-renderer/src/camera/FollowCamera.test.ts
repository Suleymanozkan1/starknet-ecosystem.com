import { describe, expect, it } from "vitest";
import { FollowCamera } from "./FollowCamera.js";

/** Runs the camera for `seconds` at 60 fps while following (x, z). */
function settle(cam: FollowCamera, x: number, z: number, seconds = 4): void {
  for (let i = 0; i < seconds * 60; i++) {
    cam.follow(x, z);
    cam.update(1 / 60);
  }
}
const eyeDistance = (cam: FollowCamera, x: number, z: number) =>
  Math.hypot(cam.camera.position.x - x, cam.camera.position.y, cam.camera.position.z - z);

describe("FollowCamera (top-down follow camera)", () => {
  it("smoothly follows the ship and ends up looking at it from above", () => {
    const cam = new FollowCamera(16 / 9);
    settle(cam, 100, -50);
    expect(cam.camera.position.y).toBeGreaterThan(0);
    // Horizontal offset stays small relative to height: top-down / isometric-like framing.
    const horiz = Math.hypot(cam.camera.position.x - 100, cam.camera.position.z + 50);
    expect(horiz).toBeLessThan(cam.camera.position.y);
  });

  it("clamps user zoom to [minDistance, maxDistance]", () => {
    const cam = new FollowCamera(1, { minDistance: 30, maxDistance: 220, distance: 64 });
    for (let i = 0; i < 50; i++) cam.zoomBy(0.5);
    expect(cam.distance).toBe(220);
    for (let i = 0; i < 50; i++) cam.zoomBy(-0.5);
    expect(cam.distance).toBe(30);
  });

  it("combat zoom pulls the camera back while fighting", () => {
    const calm = new FollowCamera(1);
    settle(calm, 0, 0);
    const fight = new FollowCamera(1);
    fight.setCombat(true);
    settle(fight, 0, 0);
    expect(eyeDistance(fight, 0, 0)).toBeGreaterThan(eyeDistance(calm, 0, 0));
  });

  it("boss cinematic framing widens the view to fit the boss", () => {
    const cam = new FollowCamera(1);
    settle(cam, 0, 0);
    const before = eyeDistance(cam, 0, 0);
    cam.setBoss(40, 0, 60);
    settle(cam, 0, 0, 8);
    expect(eyeDistance(cam, 0, 0)).toBeGreaterThan(before);
  });

  it("auto-frames a locked target so both stay on screen", () => {
    const cam = new FollowCamera(1);
    settle(cam, 0, 0);
    const alone = eyeDistance(cam, 0, 0);
    cam.setTarget(90, 0);
    settle(cam, 0, 0, 6);
    expect(eyeDistance(cam, 0, 0)).toBeGreaterThan(alone);
  });
});
