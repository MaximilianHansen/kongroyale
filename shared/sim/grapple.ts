// Deterministic raycasts & launch impulse for the VINE GRAPPLE and BANANA AIRSTRIKE.
// Shared identically between server Match and client prediction — zero per-tick allocations.
import { AIRSTRIKE, GRAPPLE } from "./const";
import { makeHit, type StaticWorld } from "./world";
import * as dmath from "./dmath";

const GH = makeHit();
/** last successful Vine Grapple anchor: [x, y, z, dist] */
export const GRAPPLE_TARGET = new Float64Array(4);
/** last successful Banana Airstrike ground target: [x, y, z, yaw, dist] */
export const AIRSTRIKE_TARGET = new Float64Array(5);

/** test whether aiming from eye (x, ey, z) along (yaw, pitch) hits a grappleable surface within GRAPPLE.minDist..maxDist */
export function grappleTrace(world: StaticWorld, x: number, ey: number, z: number, yaw: number, pitch: number): boolean {
  const cp = dmath.cos(pitch), sp = dmath.sin(pitch), sy = dmath.sin(yaw), cy = dmath.cos(yaw);
  const dx = -sy * cp, dy = sp, dz = -cy * cp;
  world.raycast(x, ey, z, dx, dy, dz, GRAPPLE.maxDist, GH, true);
  if (!GH.hit || GH.t < GRAPPLE.minDist) return false;
  GRAPPLE_TARGET[0] = GH.x;
  GRAPPLE_TARGET[1] = GH.y;
  GRAPPLE_TARGET[2] = GH.z;
  GRAPPLE_TARGET[3] = GH.t;
  return true;
}

/** compute launch velocity [vx, vy, vz] slinging a kong at (px, py, pz) toward GRAPPLE_TARGET */
export function grappleVelocity(px: number, py: number, pz: number, out: Float64Array): void {
  const dx = GRAPPLE_TARGET[0] - px;
  const dy = GRAPPLE_TARGET[1] - (py + 0.9);
  const dz = GRAPPLE_TARGET[2] - pz;
  const horiz = dmath.hypot(dx, dz);
  const dist = dmath.hypot3(dx, dy, dz);
  const f = Math.max(0, Math.min(1, (dist - GRAPPLE.minDist) / (GRAPPLE.maxDist - GRAPPLE.minDist)));
  const spd = GRAPPLE.speedMin + (GRAPPLE.speedMax - GRAPPLE.speedMin) * f;
  if (horiz > 0.25) {
    out[0] = (dx / horiz) * spd;
    out[2] = (dz / horiz) * spd;
  } else {
    out[0] = 0; out[2] = 0;
  }
  // crisp upward arc so the kong vaults cleanly over roofs/cliffs/branches and can chain into glider or crouch-slide
  const lift = GRAPPLE.liftBase + Math.max(0, dy) * 0.95 + Math.min(0, dy) * 0.25 + f * 3.2;
  out[1] = Math.max(6.2, Math.min(GRAPPLE.liftMax, lift));
}

/** test whether aiming from eye (x, ey, z) along (yaw, pitch) designates an airstrike spot within AIRSTRIKE.minDist..maxDist */
export function airstrikeTrace(world: StaticWorld, x: number, ey: number, z: number, yaw: number, pitch: number): boolean {
  const cp = dmath.cos(pitch), sp = dmath.sin(pitch), sy = dmath.sin(yaw), cy = dmath.cos(yaw);
  const dx = -sy * cp, dy = sp, dz = -cy * cp;
  world.raycast(x, ey, z, dx, dy, dz, AIRSTRIKE.maxDist, GH, true);
  if (!GH.hit || GH.t < AIRSTRIKE.minDist) return false;
  AIRSTRIKE_TARGET[0] = GH.x;
  AIRSTRIKE_TARGET[1] = GH.y;
  AIRSTRIKE_TARGET[2] = GH.z;
  AIRSTRIKE_TARGET[3] = yaw;
  AIRSTRIKE_TARGET[4] = GH.t;
  return true;
}
