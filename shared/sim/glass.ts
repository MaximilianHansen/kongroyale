// BREAKABLE GLASS: every window pane on the island is a thin, vertical static box with surf "glass"
// (town kit, interiors, hotel / resort, harbour, lab, lighthouse, control tower…). Nothing here is POI-specific — the
// panes are found in the collider data, so a new POI's windows break as soon as its pane colliders say "glass".
//
//  - PANES (per StaticWorld, built once, identical on the server and every client: same boxes, same order) — the pane
//    table + an 8 m grid. Pane ids are what travels on the wire (u16).
//  - GlassState (per match) — which panes are broken. A broken pane is switched off for movement by flipping its
//    noWalk byte in a per-match copy of the world's noWalk array; the state binds that copy into the shared world
//    (`bind`) before anything of its match touches the world, so two lobbies on one server never see each other's glass.
//    Bullets always pass panes (noShoot) — a pane on the bullet's path breaks and the bullet carries on.
//  - Breakers: bullets / rockets (glassShot), blasts (glassBlast), the body (glassBody: sprinting, sliding or airborne
//    into a pane), a punch (glassPunch: E / empty-handed fire at a pane in reach) and the window vault (findVault).
// Zero allocations after construction: every query writes into preallocated registers.
import { GLASS_SURF, isPaneBox, makeHit, type StaticWorld } from "./world";
import { CROUCH_H, PLAYER_R } from "./const";
import * as dmath from "./dmath";

const CELL = 8;
/** pane geometry stride: cx, cy, cz, nx, nz, ux, uz, hw (half width along u), hh (half height), ht (half thickness) */
export const PG = 10;

export interface Panes {
  n: number;
  /** pane → world box index */
  box: Int32Array;
  /** world box index → pane (-1 = not a pane) */
  ofBox: Int32Array;
  geo: Float64Array;
  /** the world's own (pristine) noWalk array — every GlassState copies it */
  base: Uint8Array;
  gridMin: number; gridN: number; cellStart: Int32Array; cellItems: Int32Array;
  stamp: Uint32Array; gen: number;
}

const REG = new WeakMap<StaticWorld, Panes>();

/** the pane table of a world (built on first use) */
export function glassPanes(world: StaticWorld): Panes {
  let P = REG.get(world);
  if (P && P.ofBox.length === world.n) return P;
  const base = world.noWalk;
  const ids: number[] = [], geo: number[] = [];
  for (let i = 0; i < world.n; i++) {
    if (world.surf[i] !== GLASS_SURF || base[i]) continue;
    const hx = world.hx[i], hy = world.hy[i], hz = world.hz[i];
    if (!isPaneBox(hx, hy, hz)) continue;
    const thinX = hx <= hz, ht = thinX ? hx : hz, hw = thinX ? hz : hx;
    const c = world.cos[i], s = world.sin[i];
    // world.ts rayBox: local x = (c, s), local z = (-s, c) in world (x, z)
    const nx = thinX ? c : -s, nz = thinX ? s : c, ux = thinX ? -s : c, uz = thinX ? c : s;
    ids.push(i); geo.push(world.cx[i], world.cy[i], world.cz[i], nx, nz, ux, uz, hw, hy, ht);
  }
  const n = ids.length, ofBox = new Int32Array(world.n).fill(-1);
  for (let k = 0; k < n; k++) ofBox[ids[k]] = k;   // (world.ts setBoxes already made every pane noShoot)
  const half = world.terrain.half + 200, gridMin = -half, gridN = Math.ceil((2 * half) / CELL);
  const cellOf = (v: number) => Math.min(gridN - 1, Math.max(0, Math.floor((v - gridMin) / CELL)));
  const counts = new Int32Array(gridN * gridN), spans: number[] = [];
  for (let k = 0; k < n; k++) {
    const o = k * PG, ex = Math.abs(geo[o + 5]) * geo[o + 7] + Math.abs(geo[o + 3]) * geo[o + 9], ez = Math.abs(geo[o + 6]) * geo[o + 7] + Math.abs(geo[o + 4]) * geo[o + 9];
    const x0 = cellOf(geo[o] - ex), x1 = cellOf(geo[o] + ex), z0 = cellOf(geo[o + 2] - ez), z1 = cellOf(geo[o + 2] + ez);
    spans.push(x0, x1, z0, z1);
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) counts[z * gridN + x]++;
  }
  const cellStart = new Int32Array(gridN * gridN + 1);
  for (let c = 0; c < counts.length; c++) cellStart[c + 1] = cellStart[c] + counts[c];
  const cellItems = new Int32Array(cellStart[counts.length]), fill = new Int32Array(counts.length);
  for (let k = 0; k < n; k++) {
    const x0 = spans[k * 4], x1 = spans[k * 4 + 1], z0 = spans[k * 4 + 2], z1 = spans[k * 4 + 3];
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) { const c = z * gridN + x; cellItems[cellStart[c] + fill[c]++] = k; }
  }
  P = { n, box: Int32Array.from(ids), ofBox, geo: Float64Array.from(geo), base, gridMin, gridN, cellStart, cellItems, stamp: new Uint32Array(Math.max(1, n)), gen: 0 };
  REG.set(world, P);
  return P;
}
const nextGen = (P: Panes) => { if (++P.gen > 0xfffffff0) { P.stamp.fill(0); P.gen = 1; } return P.gen; };
const cellOf = (P: Panes, v: number) => Math.min(P.gridN - 1, Math.max(0, Math.floor((v - P.gridMin) / CELL)));

/** what broke a pane (the wire's cause byte, low 2 bits) */
export const enum GC { Shot = 0, Body = 1, Punch = 2, Blast = 3 }
const FRESH_MAX = 1024;

/** which panes are broken in ONE match (server Match / client mirror). */
export class GlassState {
  readonly panes: Panes;
  readonly broken: Uint8Array;
  /** per-match movement mask: the world's noWalk with every broken pane set */
  readonly noWalk: Uint8Array;
  /** broken pane ids in break order (late joiners get them in "match") */
  readonly order: Uint16Array; count = 0;
  /** breaks not yet published (server: → events; client: → visuals): pane, cause | side << 2, by */
  readonly fresh = new Int32Array(FRESH_MAX * 3); freshN = 0;
  /** bumped by every reset (the client's visuals restore every pane when it changes) */
  epoch = 0;
  constructor(readonly world: StaticWorld) {
    this.panes = glassPanes(world);
    this.broken = new Uint8Array(Math.max(1, this.panes.n));
    this.noWalk = this.panes.base.slice();
    this.order = new Uint16Array(Math.max(1, this.panes.n));
  }
  /** point the shared world at this match's glass (call before this match simulates / predicts) */
  bind() { const w = this.world; w.noWalk = this.noWalk; w.glass = this; }
  isBroken(k: number) { return this.broken[k] !== 0; }
  /** break pane k (idempotent). side: +1 / -1 = the side the hit came from (along the pane normal), 0 = unknown. */
  breakPane(k: number, cause: GC, side = 0, by = 255): boolean {
    if (k < 0 || k >= this.panes.n || this.broken[k]) return false;
    this.broken[k] = 1; this.noWalk[this.panes.box[k]] = 1; this.order[this.count++] = k;
    if (this.freshN < FRESH_MAX) { const o = this.freshN++ * 3; this.fresh[o] = k; this.fresh[o + 1] = (cause & 3) | ((side < 0 ? 2 : side > 0 ? 1 : 0) << 2); this.fresh[o + 2] = by; }
    return true;
  }
  /** a new match: every pane whole again */
  reset() {
    for (let i = 0; i < this.count; i++) this.noWalk[this.panes.box[this.order[i]]] = this.panes.base[this.panes.box[this.order[i]]];
    this.broken.fill(0); this.count = 0; this.freshN = 0; this.epoch++;
  }
  /** broken ids (late joiners / reconnects) */
  list(): number[] { return Array.from(this.order.subarray(0, this.count)); }
}

// ---------------------------------------------------------------- queries (no allocations)
/** ray (any-length dir) vs pane k: entry t ≥ 0 or -1 */
function rayPane(P: Panes, k: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): number {
  const g = P.geo, o = k * PG;
  const rx = ox - g[o], ry = oy - g[o + 1], rz = oz - g[o + 2];
  // local axes: n (thickness), u (width), y (height)
  const ln = rx * g[o + 3] + rz * g[o + 4], lu = rx * g[o + 5] + rz * g[o + 6];
  const dn = dx * g[o + 3] + dz * g[o + 4], du = dx * g[o + 5] + dz * g[o + 6];
  let t0 = 0, t1 = maxT;
  for (let a = 0; a < 3; a++) {
    const p = a === 0 ? ln : a === 1 ? lu : ry, d = a === 0 ? dn : a === 1 ? du : dy, h = a === 0 ? g[o + 9] + 0.02 : a === 1 ? g[o + 7] : g[o + 8];
    if (Math.abs(d) < 1e-9) { if (p < -h || p > h) return -1; continue; }
    let lo = (-h - p) / d, hi = (h - p) / d; if (lo > hi) { const q = lo; lo = hi; hi = q; }
    if (lo > t0) t0 = lo; if (hi < t1) t1 = hi; if (t0 > t1) return -1;
  }
  return t0;
}
const sideOf = (P: Panes, k: number, x: number, z: number) => { const o = k * PG; return (x - P.geo[o]) * P.geo[o + 3] + (z - P.geo[o + 2]) * P.geo[o + 4] >= 0 ? 1 : -1; };

/** a bullet / rocket segment: breaks every whole pane it crosses before maxT (dir need not be unit). Returns the count. */
export function glassShot(st: GlassState, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number, cause = GC.Shot, by = 255): number {
  const P = st.panes; if (P.n === 0 || st.count >= P.n) return 0;
  const gen = nextGen(P);
  const ex = ox + dx * maxT, ez = oz + dz * maxT;
  let cx = cellOf(P, ox), cz = cellOf(P, oz);
  const tcx = cellOf(P, ex), tcz = cellOf(P, ez);
  const sx = dx > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
  const tdx = dx !== 0 ? Math.abs(CELL / dx) : 1e9, tdz = dz !== 0 ? Math.abs(CELL / dz) : 1e9;
  const bx = P.gridMin + cx * CELL, bz = P.gridMin + cz * CELL;
  let tmx = dx !== 0 ? ((dx > 0 ? bx + CELL - ox : ox - bx) / Math.abs(dx)) : 1e9;
  let tmz = dz !== 0 ? ((dz > 0 ? bz + CELL - oz : oz - bz) / Math.abs(dz)) : 1e9;
  let n = 0;
  for (let guard = 0; guard < 512; guard++) {
    const c = cz * P.gridN + cx;
    for (let q = P.cellStart[c]; q < P.cellStart[c + 1]; q++) {
      const k = P.cellItems[q];
      if (P.stamp[k] === gen) continue; P.stamp[k] = gen;
      if (st.broken[k]) continue;
      const t = rayPane(P, k, ox, oy, oz, dx, dy, dz, maxT);
      if (t >= 0 && st.breakPane(k, cause, sideOf(P, k, ox, oz), by)) n++;
    }
    if (cx === tcx && cz === tcz) break;
    if (tmx < tmz) { if (tmx > maxT) break; cx += sx; tmx += tdx; } else { if (tmz > maxT) break; cz += sz; tmz += tdz; }
    if (cx < 0 || cz < 0 || cx >= P.gridN || cz >= P.gridN) break;
  }
  return n;
}

/** every whole pane within r of (x, y, z) (an explosion) */
export function glassBlast(st: GlassState, x: number, y: number, z: number, r: number, by = 255): number {
  const P = st.panes; if (P.n === 0) return 0;
  const gen = nextGen(P), g = P.geo;
  const x0 = cellOf(P, x - r), x1 = cellOf(P, x + r), z0 = cellOf(P, z - r), z1 = cellOf(P, z + r);
  let n = 0;
  for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) {
    const c = cz * P.gridN + cx;
    for (let q = P.cellStart[c]; q < P.cellStart[c + 1]; q++) {
      const k = P.cellItems[q];
      if (P.stamp[k] === gen || st.broken[k]) continue; P.stamp[k] = gen;
      const o = k * PG, rx = x - g[o], ry = y - g[o + 1], rz = z - g[o + 2];
      const lu = Math.max(0, Math.abs(rx * g[o + 5] + rz * g[o + 6]) - g[o + 7]), lv = Math.max(0, Math.abs(ry) - g[o + 8]), ln = Math.abs(rx * g[o + 3] + rz * g[o + 4]);
      if (lu * lu + lv * lv + ln * ln <= r * r && st.breakPane(k, GC.Blast, sideOf(P, k, x, z), by)) n++;
    }
  }
  return n;
}

/** the body: a capsule at (x, y, z) (feet) of height h moving (vx, vy, vz) for dt — smashes a whole pane it is about to
 * touch when it hits it with ≥ BODY_V along the pane normal. `fast` = sprinting / sliding / airborne (walking into a
 * window never breaks it). Called by the mover before it integrates, on the server and in the client's prediction. */
export const BODY_V = 2.2;
export function glassBody(st: GlassState, x: number, y: number, z: number, h: number, vx: number, vz: number, dt: number, by = 255): number {
  const P = st.panes; if (P.n === 0 || st.count >= P.n) return 0;
  const g = P.geo, reach = PLAYER_R + dmath.hypot(vx, vz) * dt + 0.06;
  const x0 = cellOf(P, x - reach), x1 = cellOf(P, x + reach), z0 = cellOf(P, z - reach), z1 = cellOf(P, z + reach);
  const gen = nextGen(P);
  let n = 0;
  for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) {
    const c = cz * P.gridN + cx;
    for (let q = P.cellStart[c]; q < P.cellStart[c + 1]; q++) {
      const k = P.cellItems[q];
      if (P.stamp[k] === gen || st.broken[k]) continue; P.stamp[k] = gen;
      const o = k * PG, rx = x - g[o], rz = z - g[o + 2];
      const s = rx * g[o + 3] + rz * g[o + 4], vn = vx * g[o + 3] + vz * g[o + 4];
      if (s * vn >= 0 || Math.abs(vn) < BODY_V) continue;                       // moving away / grazing along it
      if (Math.abs(s) > PLAYER_R + g[o + 9] + Math.abs(vn) * dt + 0.06) continue;   // not touching it this tick
      if (Math.abs(rx * g[o + 5] + rz * g[o + 6]) > g[o + 7] + PLAYER_R * 0.6) continue;
      if (y + h < g[o + 1] - g[o + 8] + 0.05 || y > g[o + 1] + g[o + 8] - 0.05) continue;
      if (st.breakPane(k, GC.Body, s > 0 ? 1 : -1, by)) n++;
    }
  }
  return n;
}

/** a punch (E at a pane / fire with empty hands): the first pane on the view ray within PUNCH_R of the eye */
export const PUNCH_R = 1.9;
/** the whole pane a punch from this eye ray would hit (-1 = none). No side effects: the HUD's "SMASH WINDOW" prompt. */
export function glassAim(st: GlassState, ex: number, ey: number, ez: number, dx: number, dy: number, dz: number): number {
  const P = st.panes; if (P.n === 0 || st.count >= P.n) return -1;
  const gen = nextGen(P);
  const x0 = cellOf(P, ex - PUNCH_R), x1 = cellOf(P, ex + PUNCH_R), z0 = cellOf(P, ez - PUNCH_R), z1 = cellOf(P, ez + PUNCH_R);
  let best = -1, bt = PUNCH_R;
  for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) {
    const c = cz * P.gridN + cx;
    for (let q = P.cellStart[c]; q < P.cellStart[c + 1]; q++) {
      const k = P.cellItems[q];
      if (P.stamp[k] === gen || st.broken[k]) continue; P.stamp[k] = gen;
      const t = rayPane(P, k, ex, ey, ez, dx, dy, dz, bt);
      if (t >= 0 && t < bt) { bt = t; best = k; }
    }
  }
  if (best < 0) return -1;
  // the world in front of the pane (a wall, a closed shutter) wins
  st.world.raycast(ex, ey, ez, dx, dy, dz, bt, PH, true);
  return PH.hit ? -1 : best;
}
export function glassPunch(st: GlassState, ex: number, ey: number, ez: number, dx: number, dy: number, dz: number, by = 255): number {
  const k = glassAim(st, ex, ey, ez, dx, dy, dz);
  return k >= 0 && st.breakPane(k, GC.Punch, sideOf(st.panes, k, ex, ez), by) ? 1 : 0;
}
const PH = makeHit(), VH = makeHit();

/**
 * WINDOW VAULT: jump while moving at a window → through it. Looks for a pane (whole: it is smashed on the way; broken:
 * the opening) facing the move direction (fx, fz) within reach, whose sill is a jump away (0.3-1.75 m over the feet)
 * and whose opening fits the kong (≥ 0.86 m wide, ≥ VAULT_MIN_H tall). Writes the vault into V:
 * [path y (feet), exit x, exit z, path length, dir x, dir z] and returns the pane id, or -1.
 * Openings from 0.85 m tall are a DIVE — the scripted path runs the
 * feet below the sill so the crouched eye (1.05 m) passes inside the opening — and the exit is searched (two depths ×
 * three slides along the sill, a small push-out accepted) instead of one fixed spot that a stair tread, a stall or a
 * crate beside the window would veto.
 */
/** the smallest opening (m) the kong vaults / dives through; under it a window is visibly too small */
export const VAULT_MIN_H = 0.85;
/** the opening height a crouched kong passes upright; under it the path dips so the eye stays inside the opening */
const VAULT_UPRIGHT_H = 1.2;
const EXIT_OUT = [PLAYER_R + 0.4, PLAYER_R + 0.75], EXIT_SLIDE = [0, 0.3, -0.3];
export const V = new Float64Array(6);
export function findVault(st: GlassState, x: number, y: number, z: number, fx: number, fz: number, by = 255): number {
  const P = st.panes; if (P.n === 0) return -1;
  const g = P.geo, R = PLAYER_R + 0.95;
  const gen = nextGen(P);
  const x0 = cellOf(P, x - R), x1 = cellOf(P, x + R), z0 = cellOf(P, z - R), z1 = cellOf(P, z + R);
  let best = -1, bd = 1e9;
  for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) {
    const c = cz * P.gridN + cx;
    for (let q = P.cellStart[c]; q < P.cellStart[c + 1]; q++) {
      const k = P.cellItems[q];
      if (P.stamp[k] === gen) continue; P.stamp[k] = gen;
      const o = k * PG, hw = g[o + 7], hh = g[o + 8];
      if (hw < PLAYER_R + 0.01 || hh * 2 < VAULT_MIN_H) continue;
      const rx = x - g[o], rz = z - g[o + 2], s = rx * g[o + 3] + rz * g[o + 4], l = rx * g[o + 5] + rz * g[o + 6];
      const fn = fx * g[o + 3] + fz * g[o + 4];
      if (s * fn >= 0 || Math.abs(fn) < 0.55 || Math.abs(s) > R || Math.abs(l) > hw + 0.1) continue;
      const sill = g[o + 1] - hh, rise = sill - y;
      if (rise < -0.45 || rise > 1.75) continue;
      const d = Math.abs(s) - Math.abs(l) * 0.5;
      if (d < bd) { bd = d; best = k; }
    }
  }
  if (best < 0) return -1;
  const o = best * PG, s = (x - g[o]) * g[o + 3] + (z - g[o + 2]) * g[o + 4], sg = s > 0 ? -1 : 1;   // sg: travel along n
  const hw = g[o + 7], hh = g[o + 8], sill = g[o + 1] - hh + 0.02, dip = Math.max(0, VAULT_UPRIGHT_H - hh * 2);
  const l0 = (x - g[o]) * g[o + 5] + (z - g[o + 2]) * g[o + 6];
  const lim = Math.max(0, hw - PLAYER_R - 0.01);
  // the way through is open past the pane: nothing at knee / eye height between the window and the exit, and the
  // crouched kong fits at the exit (a wardrobe right behind the window = no vault; the pane still breaks on impact)
  const w = st.world, wasBroken = st.broken[best] !== 0, bi = P.box[best], keep = st.noWalk[bi];
  st.noWalk[bi] = 1;   // look through the pane itself
  let ok = false, exX = 0, exZ = 0, l = 0;
  for (let a = 0; a < EXIT_OUT.length && !ok; a++) for (let b = 0; b < EXIT_SLIDE.length && !ok; b++) {
    l = l0 + EXIT_SLIDE[b]; l = l < -lim ? -lim : l > lim ? lim : l;
    if (b > 0 && Math.abs(l - (l0 < -lim ? -lim : l0 > lim ? lim : l0)) < 0.05) continue;   // the slide was clamped away
    const out = EXIT_OUT[a], cxp = g[o] + g[o + 5] * l, czp = g[o + 2] + g[o + 6] * l;
    let ex = cxp + g[o + 3] * sg * out, ez = czp + g[o + 4] * sg * out;
    w.velY = 0; w.headBump = false; w.wallHit = false;
    w.resolveCapsule(ex, sill, ez, PLAYER_R, CROUCH_H, false);
    // a small push-out (a stair tread, a stall rail beside the exit) is fine as long as it stays clear of the wall
    const px = w.P[0] - ex, pz = w.P[2] - ez, depth = (w.P[0] - cxp) * g[o + 3] * sg + (w.P[2] - czp) * g[o + 4] * sg;
    if (w.headBump || dmath.hypot(px, pz) > 0.35 || w.P[1] - sill > 0.6 || depth < PLAYER_R + 0.2) continue;
    ex = w.P[0]; ez = w.P[2];
    let clear = true;
    for (let k = 0; k < 2 && clear; k++) {
      const yy = sill + (k === 0 ? 0.15 : Math.min(1.0, hh * 2 - 0.15));
      w.raycast(cxp - g[o + 3] * sg * 0.05, yy, czp - g[o + 4] * sg * 0.05, ex - cxp, 0, ez - czp, 1, VH, false);
      if (VH.hit) clear = false;
    }
    if (clear) { ok = true; exX = ex; exZ = ez; }
  }
  st.noWalk[bi] = keep;
  if (!ok) return -1;
  if (!wasBroken) st.breakPane(best, GC.Body, -sg, by);
  const px = exX - x, pz = exZ - z, len = dmath.hypot(px, pz) || 1;
  V[0] = sill - dip; V[1] = exX; V[2] = exZ; V[3] = len; V[4] = px / len; V[5] = pz / len;
  return best;
}
