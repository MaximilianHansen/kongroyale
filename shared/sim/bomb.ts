// The BANANA BOMB in flight: one step function the server's Match and the client's
// visual mirror (and the arc preview) share, so the thrown bomb is drawn where it really bounces. Gravity, a segment ray
// against the static world per step (walk colliders: walls, floors, crates — foliage does not stop it), a bounce that
// keeps BOMB.restitution of the normal speed and BOMB.friction of the tangential, and rest on a floor once slow.
import { BOMB, WATER_LEVEL } from "./const";
import { makeHit, type StaticWorld } from "./world";
import * as dmath from "./dmath";

export interface BombBody { x: number; y: number; z: number; vx: number; vy: number; vz: number; rest: boolean }
const H = makeHit();
/** the throw from the eye (ex, ey, ez) along (yaw, pitch) with the thrower's velocity: writes the start of the flight
 * into `b` (just in front of the eye, never through a wall right in front of it) */
export function bombLaunch(world: StaticWorld, ex: number, ey: number, ez: number, yaw: number, pitch: number, pvx: number, pvz: number, b: BombBody) {
  const cp = dmath.cos(pitch), dx = -dmath.sin(yaw) * cp, dy = dmath.sin(pitch), dz = -dmath.cos(yaw) * cp;
  // the hand: a little right of and below the eye
  const rx = dmath.cos(yaw), rz = -dmath.sin(yaw);
  const hx = ex + rx * 0.22, hy = ey - 0.12, hz = ez + rz * 0.22;
  world.raycast(ex, ey, ez, hx + dx * 0.45 - ex, hy + dy * 0.45 - ey, hz + dz * 0.45 - ez, 1, H, false);
  const k = H.hit ? Math.max(0, H.t - 0.08) : 1;
  b.x = ex + (hx + dx * 0.45 - ex) * k; b.y = ey + (hy + dy * 0.45 - ey) * k; b.z = ez + (hz + dz * 0.45 - ez) * k;
  b.vx = dx * BOMB.speed + pvx * 0.6; b.vy = dy * BOMB.speed + BOMB.up; b.vz = dz * BOMB.speed + pvz * 0.6; b.rest = false;
}
/** one step of `dt`; returns the impact speed of a bounce this step (0 = none) */
export function bombStep(world: StaticWorld, b: BombBody, dt: number): number {
  if (b.rest) return 0;
  b.vy -= BOMB.gravity * dt;
  // in the sea it sinks slowly and stops (a dud splash stays where it went in)
  if (b.y < WATER_LEVEL) { b.vx *= 0.9; b.vz *= 0.9; b.vy = Math.max(b.vy * 0.9, -1.5); }
  const mx = b.vx * dt, my = b.vy * dt, mz = b.vz * dt;
  world.raycast(b.x, b.y, b.z, mx, my, mz, 1, H, false);
  if (!H.hit) { b.x += mx; b.y += my; b.z += mz; return 0; }
  // to the contact (a hair off the surface), then reflect: normal speed × restitution, tangential × friction
  const t = Math.max(0, H.t - 0.02);
  b.x += mx * t; b.y += my * t; b.z += mz * t;
  b.x += H.nx * 0.01; b.y += H.ny * 0.01; b.z += H.nz * 0.01;
  const vn = b.vx * H.nx + b.vy * H.ny + b.vz * H.nz;
  if (vn >= 0) return 0;
  const tx = b.vx - vn * H.nx, ty = b.vy - vn * H.ny, tz = b.vz - vn * H.nz;
  b.vx = tx * BOMB.friction - vn * BOMB.restitution * H.nx;
  b.vy = ty * BOMB.friction - vn * BOMB.restitution * H.ny;
  b.vz = tz * BOMB.friction - vn * BOMB.restitution * H.nz;
  if (H.ny > 0.6 && dmath.hypot3(b.vx, b.vy, b.vz) < 1.4) { b.vx = b.vy = b.vz = 0; b.rest = true; }
  return -vn;
}
