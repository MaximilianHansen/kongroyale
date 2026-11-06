import { BULLET_RANGE, HITBOX, PLAYER_H, WATER_LEVEL } from "./const";
import { makeHit, surfaceIndex, type StaticWorld } from "./world";
import { TARGET_STRIDE, type ShotResult } from "./hitscan";
import * as dmath from "./dmath";

const HIT = makeHit();
const WATER_SURF = surfaceIndex("water");

/** swimming: a round fired from above the sea stops at the water surface (a splash there) —
 *  the part of a swimmer under the surface is in cover, a diver is out of reach. Open water only (the sea bed under the
 *  surface point, like the swim rule); the world hit is nearer when the round meets a dock / hull first. −1 = no water. */
export function waterT(world: StaticWorld, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): number {
  if (dy >= -1e-6 || oy <= WATER_LEVEL) return -1;
  const t = (WATER_LEVEL - oy) / dy;
  if (t >= maxT) return -1;
  return world.ground(ox + dx * t, oz + dz * t) < WATER_LEVEL - 0.05 ? t : -1;
}

/** ray (unit dir) vs the static world and every target slot; nearest wins. zone 1 = head. */
export function traceShot(world: StaticWorld, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, targets: Float64Array, n: number, out: ShotResult): ShotResult {
  world.raycast(ox, oy, oz, dx, dy, dz, BULLET_RANGE, HIT, true);
  let bestT = HIT.hit ? HIT.t : BULLET_RANGE, victim = -1, zone = 0;
  const wt = waterT(world, ox, oy, oz, dx, dy, dz, bestT), wet = wt >= 0;
  if (wet) bestT = wt;
  for (let i = 0; i < n; i++) {
    const o = i * TARGET_STRIDE, h = targets[o + 3]; if (h <= 0) continue;
    const t = rayCapsule(ox, oy, oz, dx, dy, dz, targets[o], targets[o + 1], targets[o + 2], h, bestT, targets[o + 4]);
    if (t >= 0 && t < bestT) { bestT = t; victim = i; zone = HEADZ; }
  }
  out.t = bestT; out.victim = victim; out.zone = zone; out.worldHit = victim < 0 && (wet || HIT.hit); out.surf = wet ? WATER_SURF : HIT.hit ? HIT.surf : 0; out.cover = victim < 0 && HIT.hit && !wet ? HIT.cover : -1;
  return out;
}

/** ray vs the kong hitbox (const.ts HITBOX) of a target standing at (cx, cy, cz) with height h facing `yaw`: a head
 * sphere forward of the trunk + elliptic cylinders (legs, the trunk with the hanging arms, the shoulders), all in the
 * target's local frame. Returns t (metres along the unit dir) or -1; sets HEADZ = 1 when the head wins. */
let HEADZ = 0;
export const lastZone = () => HEADZ;
export function rayCapsule(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, cx: number, cy: number, cz: number, h: number, maxT: number, yaw = 0): number {
  HEADZ = 0;
  const wx = ox - cx, wz = oz - cz;
  const dd = dx * dx + dz * dz;
  // broad phase: closest XZ approach of the (clamped) ray to the axis (every part lies within 1.1 m of it)
  if (dd > 1e-12) {
    let t = -(wx * dx + wz * dz) / dd; if (t < 0) t = 0; else if (t > maxT) t = maxT;
    const px = wx + dx * t, pz = wz + dz * t;
    if (px * px + pz * pz > 1.21) return -1;
  }
  // into the target's frame: rotate by -yaw (forward (-sin yaw, -cos yaw) → -z)
  const c = dmath.cos(yaw), s = dmath.sin(yaw);
  const lx = wx * c - wz * s, lz = wx * s + wz * c, ldx = dx * c - dz * s, ldz = dx * s + dz * c, ly = oy - cy;
  const B = HITBOX, cr = h < PLAYER_H - 0.01;
  const hd = B.head;
  const th = raySphere(lx, ly, lz, ldx, dy, ldz, 0, hy(hd.y, cr), hd.z, hd.r, maxT);
  let tb = -1;
  for (const P of B.parts) {
    const a = P[4], bz = P[5];
    const t = rayCyl((lx - P[2]) / a, ly, (lz - P[3]) / bz, ldx / a, dy, ldz / bz, 1, hy(P[0], cr), hy(P[1], cr), maxT);
    if (t >= 0 && (tb < 0 || t < tb)) tb = t;
  }
  if (th >= 0 && (tb < 0 || th <= tb + B.headBias)) { HEADZ = 1; return th; }
  return tb;
}
/** a standing hitbox height → the crouched one (HITBOX.crouch) */
function hy(y: number, crouched: boolean): number { if (!crouched) return y; const K = HITBOX.crouch; return y > K[0] ? y - K[1] : y * K[2]; }
/** ray (origin relative to the axis foot: lx, ly, lz; any-length dir) vs a vertical cylinder of radius r between heights
 * y0..y1 above the foot; entry t (or 0 when inside) or -1 */
function rayCyl(lx: number, ly: number, lz: number, dx: number, dy: number, dz: number, r: number, y0: number, y1: number, maxT: number): number {
  const dd = dx * dx + dz * dz, c = lx * lx + lz * lz - r * r;
  let tin = -Infinity, tout = Infinity;
  if (dd > 1e-12) {
    const b = 2 * (dx * lx + dz * lz), disc = b * b - 4 * dd * c;
    if (disc < 0) return -1;
    const s = Math.sqrt(disc); tin = (-b - s) / (2 * dd); tout = (-b + s) / (2 * dd);
  } else if (c > 0) return -1;
  if (Math.abs(dy) < 1e-12) { if (ly < y0 || ly > y1) return -1; }
  else { let s0 = (y0 - ly) / dy, s1 = (y1 - ly) / dy; if (s0 > s1) { const k = s0; s0 = s1; s1 = k; } if (s0 > tin) tin = s0; if (s1 < tout) tout = s1; }
  if (tin <= tout && tout >= 0) { const t = tin > 0 ? tin : 0; if (t < maxT) return t; }
  return -1;
}
function raySphere(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, sx: number, sy: number, sz: number, r: number, maxT: number): number {
  const lx = ox - sx, ly = oy - sy, lz = oz - sz;
  const a = dx * dx + dy * dy + dz * dz, b = 2 * (lx * dx + ly * dy + lz * dz), c = lx * lx + ly * ly + lz * lz - r * r;
  const disc = b * b - 4 * a * c; if (disc < 0) return -1;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return t >= 0 && t < maxT ? t : -1;
}
