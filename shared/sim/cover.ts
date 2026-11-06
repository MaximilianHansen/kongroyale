// PORTABLE COVER, the COCONUT CRATE WALL. Select it, a ghost shows where it goes (2.1 m in front, on the floor, square to your view), fire
// sets it down: a chest-high barricade of coconut-wood crates that stops bullets, blast and kongs, takes damage and
// breaks, and crumbles on its own after COVER.lifeS.
//
// Server-authoritative dynamic colliders on the vehicle precedent: a CoverSet bound into the StaticWorld per match
// (world.cover): StaticWorld.raycast sees the walls (bullets, rockets, the bomb's bounces, blast line of sight, loot reach,
// mantle probes), the walker pushes kongs out of / onto them (pushCover, like pushKong). The server spawns / damages /
// removes walls with EV.Cover / EV.CoverHit / EV.CoverEnd; the client mirrors the set and predicts against it.
import { PLAYER_R, SLOPE_LIMIT } from "./const";
import { makeHit, surfaceIndex, type Hit, type StaticWorld } from "./world";
import * as dmath from "./dmath";

/** width (along the wall), height, thickness, hit points, life (s), walls per kong (the oldest crumbles), how far in
 * front it goes, how many on the island at once */
export const COVER = { w: 2.4, h: 1.45, t: 0.4, hp: 450, lifeS: 75, perKong: 2, reach: 2.1, max: 64,
  /** explosives hit cover harder (a rocket or a bomb is how you crack one open) */ blastMul: 1.6 };
export interface Wall { id: number; owner: number; x: number; y: number; z: number; yaw: number; hp: number; born: number; live: boolean;
  /** size (m: along, up, through) — a crate wall's COVER.w / h / t, or a Banana Stand's (economy.ts) */
  w: number; h: number; t: number;
  /** permanent (a Banana Stand): never damaged, never crumbles */
  perm: boolean }
const WOOD = surfaceIndex("wood");
const H3 = [0, 0, 0], O3 = [0, 0, 0], D3 = [0, 0, 0];

export class CoverSet {
  readonly list: Wall[] = [];
  /** live walls */
  n = 0;
  /** rays pass the permanent walls (the Banana Stands' counters) while set — lootReachable's reach over a
   *  counter; set and cleared around one test, never left on */
  skipPerm = false;
  add(id: number, owner: number, x: number, y: number, z: number, yaw: number, hp: number, born: number, size: readonly [number, number, number] | null = null): Wall {
    let w = this.list.find((q) => !q.live);
    if (!w) { w = { id, owner, x, y, z, yaw, hp, born, live: true, w: COVER.w, h: COVER.h, t: COVER.t, perm: false }; this.list.push(w); }
    w.id = id; w.owner = owner; w.x = x; w.y = y; w.z = z; w.yaw = yaw; w.hp = hp; w.born = born; w.live = true;
    w.w = size ? size[0] : COVER.w; w.h = size ? size[1] : COVER.h; w.t = size ? size[2] : COVER.t; w.perm = !!size;
    this.n++;
    return w;
  }
  byId(id: number): Wall | null { for (const w of this.list) if (w.live && w.id === id) return w; return null; }
  remove(id: number) { const w = this.byId(id); if (w) { w.live = false; this.n--; } }
  /** every crate wall gone (a new match); the Banana Stands (perm) stay unless `all` */
  reset(all = false) { for (const w of this.list) if (w.live && (all || !w.perm)) { w.live = false; this.n--; } }
  /** the walls on a ray (unit or any-length dir, t in its units): the nearest entry < out.t updates `out` (cover = id) */
  ray(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, out: Hit) {
    for (const w of this.list) {
      if (!w.live || (w.perm && this.skipPerm)) continue;
      // broad: the ray's closest approach to the wall's centre within its half diagonal
      const cx = w.x - ox, cy = w.y + w.h / 2 - oy, cz = w.z - oz, dd = dx * dx + dy * dy + dz * dz;
      let tc = (cx * dx + cy * dy + cz * dz) / dd; if (tc < 0) tc = 0; else if (tc > out.t) tc = out.t;
      const ex = cx - dx * tc, ey = cy - dy * tc, ez = cz - dz * tc;
      if (ex * ex + ey * ey + ez * ez > (w.w * w.w + w.h * w.h + w.t * w.t) * 0.26) continue;
      // slabs in the wall's frame (x along it, z through it)
      const c = dmath.cos(w.yaw), s = dmath.sin(w.yaw);
      const rx = ox - w.x, rz = oz - w.z;
      const lox = rx * c - rz * s, loz = rx * s + rz * c, loy = oy - (w.y + w.h / 2);
      const ldx = dx * c - dz * s, ldz = dx * s + dz * c;
      let tmin = 0, tmax = out.t, axis = -1, sign = 0;
      H3[0] = w.w / 2; H3[1] = w.h / 2; H3[2] = w.t / 2; O3[0] = lox; O3[1] = loy; O3[2] = loz; D3[0] = ldx; D3[1] = dy; D3[2] = ldz;
      const H = H3, O = O3, D = D3;
      let miss = false;
      for (let a = 0; a < 3; a++) {
        if (Math.abs(D[a]) < 1e-9) { if (O[a] < -H[a] || O[a] > H[a]) { miss = true; break; } continue; }
        let lo = (-H[a] - O[a]) / D[a], hi = (H[a] - O[a]) / D[a], sg = -1;
        if (lo > hi) { const k = lo; lo = hi; hi = k; sg = 1; }
        if (lo > tmin) { tmin = lo; axis = a; sign = sg; }
        if (hi < tmax) tmax = hi;
        if (tmin > tmax) { miss = true; break; }
      }
      if (miss || axis < 0 || tmin <= 0 || tmin >= out.t) continue;
      out.hit = true; out.t = tmin; out.box = -1; out.surf = WOOD; out.cover = w.id;
      out.x = ox + dx * tmin; out.y = oy + dy * tmin; out.z = oz + dz * tmin;
      const nx = axis === 0 ? sign : 0, ny = axis === 1 ? sign : 0, nz = axis === 2 ? sign : 0;
      // local → world (inverse of the rotation above)
      out.nx = nx * c + nz * s; out.ny = ny; out.nz = -nx * s + nz * c;
    }
  }
}

/** a kong's capsule against the walls: pushed out sideways, or standing on top (you can vault / stand on your cover) */
export function pushCover(set: CoverSet, p: { x: number; y: number; z: number; vx: number; vy: number; vz: number; grounded: boolean; fallV: number; airT: number; surf: number }, h: number) {
  for (const w of set.list) {
    if (!w.live) continue;
    const dx = p.x - w.x, dz = p.z - w.z;
    if (dx * dx + dz * dz > (w.w * w.w + w.t * w.t) * 0.25 + 1.2) continue;
    const top = w.y + w.h;
    if (p.y >= top || p.y + h <= w.y + 0.05) continue;
    const c = dmath.cos(w.yaw), s = dmath.sin(w.yaw);
    const lx = dx * c - dz * s, lz = dx * s + dz * c;
    const ox = Math.abs(lx) - w.w / 2 - PLAYER_R, oz = Math.abs(lz) - w.t / 2 - PLAYER_R;
    if (ox >= 0 || oz >= 0) continue;
    const cxo = Math.abs(lx) - w.w / 2, czo = Math.abs(lz) - w.t / 2;
    if (cxo > 0 && czo > 0 && cxo * cxo + czo * czo >= PLAYER_R * PLAYER_R) continue;
    if (p.y > top - 0.4 && p.vy <= 0.5) { p.y = top; p.vy = 0; p.grounded = true; p.fallV = 0; p.airT = 0; p.surf = WOOD; continue; }
    let nx: number, nz: number, d: number;
    if (ox > oz) { nx = lx >= 0 ? 1 : -1; nz = 0; d = -ox; } else { nx = 0; nz = lz >= 0 ? 1 : -1; d = -oz; }
    const wx = nx * c + nz * s, wz = -nx * s + nz * c;
    p.x += wx * d; p.z += wz * d;
    const vn = p.vx * wx + p.vz * wz; if (vn < 0) { p.vx -= wx * vn; p.vz -= wz * vn; }
  }
}

const PH = makeHit();
/** where a kong at (x, y, z) facing `yaw` would set a wall down: COVER.reach in front, on a flat floor within a metre of
 * its feet, the whole length standing on it (not over a ledge), nothing in the wall's volume or between the kong and it,
 * not on top of another wall. Writes [x, y, z, yaw] into PLACED; false = it does not fit there. */
export const PLACED = new Float64Array(4);
export function coverPlace(world: StaticWorld, x: number, y: number, z: number, yaw: number): boolean {
  const fx = -dmath.sin(yaw), fz = -dmath.cos(yaw), rx = dmath.cos(yaw), rz = -dmath.sin(yaw);
  const cx = x + fx * COVER.reach, cz = z + fz * COVER.reach;
  PLACED[0] = cx; PLACED[1] = y; PLACED[2] = cz; PLACED[3] = yaw;
  world.raycast(x, y + 1.0, z, cx - x, 0, cz - z, 1, PH, false); if (PH.hit) return false;
  world.raycast(cx, y + 1.2, cz, 0, -1, 0, 2.4, PH, false);
  if (!PH.hit || PH.ny < 0.75 || Math.abs(PH.y - y) > 1.0) return false;
  const fy = PH.y; PLACED[1] = fy;
  for (const e of [-1, 1]) {
    const ex = cx + rx * e * (COVER.w / 2 - 0.15), ez = cz + rz * e * (COVER.w / 2 - 0.15);
    world.raycast(ex, fy + 0.6, ez, 0, -1, 0, 1.2, PH, false);
    if (!PH.hit || Math.abs(PH.y - fy) > 0.45 || PH.ny < SLOPE_LIMIT) return false;
    for (const h of [0.35, 1.0]) { world.raycast(cx, fy + h, cz, rx * e, 0, rz * e, COVER.w / 2, PH, false); if (PH.hit) return false; }
  }
  for (const h of [0.35, 1.0]) for (const e of [-1, 1]) { world.raycast(cx, fy + h, cz, fx * e, 0, fz * e, COVER.t / 2 + 0.05, PH, false); if (PH.hit) return false; }
  world.raycast(cx, fy + 0.4, cz, 0, 1, 0, COVER.h, PH, false); if (PH.hit) return false;
  const set = world.cover;
  if (set) for (const w of set.list) if (w.live && dmath.hypot(w.x - cx, w.z - cz) < 1.6 + (w.perm ? w.w / 2 : 0) && Math.abs(w.y - fy) < w.h) return false;
  return true;
}
