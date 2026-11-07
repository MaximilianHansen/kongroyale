// Hitscan hit-testing, shared by the authoritative server (lag-compensated) and the client (predicted hits). Both sides
// run THESE functions on bit-identical numbers (quantised snapshot poses == the server's rewind history), so what the
// shooter saw hit is what the server rules a hit. Zero allocations (results go into preallocated registers).
import { CROUCH_H, PLAYER_H } from "./const";
import { PF_CROUCH, PF_HITTABLE, spreadOffset } from "./player";
import * as dmath from "./dmath";

export { PF_CROUCH, PF_HITTABLE };
export { lastZone, rayCapsule, traceShot, waterT } from "./hitscan.hot";
/** a pose jump larger than this between two samples is a teleport (respawn, plane exit): never interpolate across it */
export const TELEPORT_M = 15;

/** target register layout: [x, y, z, h, yaw] per slot; h = 0 → absent. The yaw (facing) orients the hitbox: the kong's
 * head sits forward of its trunk and it is wider across the arms than it is deep (const.ts HITBOX). */
export const TARGET_STRIDE = 5;
const TAU = Math.PI * 2;
/** the snapshot's yaw quantisation (shared/net/proto.ts yawEnc / yawDec, u16 per turn) — applied on BOTH sides so the
 * server's history yaw (raw float) and the client's snapshot yaw give bit-identical hitboxes */
const qyaw = (a: number) => { const u = Math.round((a / TAU) * 65536) & 0xffff; let r = (u / 65536) * TAU; if (r > Math.PI) r -= TAU; return r; };
/** facing of a blended pose, exactly like the client draws it (shortest-arc lerp between the two samples) */
export function blendYaw(a: number, b: number, f: number): number {
  const ya = qyaw(a), yb = qyaw(b);
  let d = yb - ya; if (d > Math.PI) d -= TAU; else if (d < -Math.PI) d += TAU;
  return ya + d * f;
}

/** blend two samples exactly like the client renders them: linear position, discrete flags from the nearer sample.
 * Writes [x, y, z, hitbox height] (height 0 = not hittable, position still valid for drawing). */
export function blendPose(ax: number, ay: number, az: number, af: number, bx: number, by: number, bz: number, bf: number, f: number, out: Float64Array, o: number) {
  const ex = bx - ax, ey = by - ay, ez = bz - az;
  const near = f < 0.5;
  const fl = near ? af : bf;
  if (ex * ex + ey * ey + ez * ez > TELEPORT_M * TELEPORT_M) {
    if (near) { out[o] = ax; out[o + 1] = ay; out[o + 2] = az; } else { out[o] = bx; out[o + 1] = by; out[o + 2] = bz; }
  } else { out[o] = ax + ex * f; out[o + 1] = ay + ey * f; out[o + 2] = az + ez * f; }
  out[o + 3] = !(fl & PF_HITTABLE) ? 0 : fl & PF_CROUCH ? CROUCH_H : PLAYER_H;
}
/** interpolation fraction as it travels in an input (u16): both sides blend with exactly this value */
export const qf16 = (f: number) => Math.round((f < 0 ? 0 : f > 1 ? 1 : f) * 65535) / 65535;

/** direction of pellet k of shot `shot` (deterministic spread), unit vector into out[0..2] */
const SP = new Float64Array(2);
export function shotDir(pid: number, shot: number, k: number, spreadDeg: number, yaw: number, pitch: number, out: Float64Array) {
  spreadOffset(pid, shot, k, spreadDeg, SP);
  const y = yaw + SP[0], pt = pitch + SP[1], cp = dmath.cos(pt);
  out[0] = -dmath.sin(y) * cp; out[1] = dmath.sin(pt); out[2] = -dmath.cos(y) * cp;
}

export interface ShotResult { t: number; victim: number; zone: number; worldHit: boolean; surf: number;
  /** the cover wall the shot stopped on, −1 = none */ cover: number }
export const makeShotResult = (): ShotResult => ({ t: 0, victim: -1, zone: 0, worldHit: false, surf: 0, cover: -1 });
