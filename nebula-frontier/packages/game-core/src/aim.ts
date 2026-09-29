/**
 * Free-aim fire: while the trigger is held, weapons shoot along the pilot's aim line (towards the
 * cursor / stick direction) instead of requiring a locked target. The server resolves which ship the
 * shot meets with this helper, so aim assists cannot be forged by the client.
 */

export interface AimCandidate {
  id: string;
  x: number;
  y: number;
  /** Collision radius in map units. */
  radius: number;
}

/** Extra hit width (map units) added to every candidate's radius — a small, forgiving aim assist. */
export const AIM_TOLERANCE = 3;

/**
 * First candidate the ray from (fromX, fromY) with direction `angle` meets within `range`
 * (measured to the candidate's surface). Returns null when the line of fire is clear.
 */
export function aimTarget<T extends AimCandidate>(
  fromX: number, fromY: number, angle: number, range: number, candidates: Iterable<T>, tolerance = AIM_TOLERANCE,
): { target: T; distance: number } | null {
  if (!Number.isFinite(angle) || !(range > 0)) return null;
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  let best: T | null = null;
  let bestAlong = Infinity;
  for (const c of candidates) {
    const rx = c.x - fromX;
    const ry = c.y - fromY;
    const along = rx * dx + ry * dy;
    const r = Math.max(0, c.radius) + Math.max(0, tolerance);
    if (along < -r) continue; // behind the shooter
    const across = Math.abs(rx * dy - ry * dx);
    if (across > r) continue;
    // distance along the ray to the entry point of the hit circle
    const entry = Math.max(0, along - Math.sqrt(Math.max(0, r * r - across * across)));
    if (entry > range || entry >= bestAlong) continue;
    best = c;
    bestAlong = entry;
  }
  return best ? { target: best, distance: Math.hypot(best.x - fromX, best.y - fromY) } : null;
}

/** Collision radius for a ship given its visual scale (NPC `visual.scale`; players use 1). */
export function shipHitRadius(scale: number): number {
  return Math.max(3, 3.5 * (Number.isFinite(scale) && scale > 0 ? scale : 1));
}
