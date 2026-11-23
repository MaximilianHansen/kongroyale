// poi-harbor — plain-data placement types shared by the client kit (client/src/world/pois/_kit/containers.ts) and
// the server (colliders). No three.js here. Container local frame: length along +X, width along Z, height +Y from
// the ground contact plane; door end at +X. World transform = translate(x,y,z) · Ry(yaw) · Rz(pitch) · Rx(roll).
import type { Box } from "../world/colliders";
import { furnishRoom, interiorColliders, interiorLoot, type InteriorLayout, type InteriorRoom, type LootSlots } from "./interior-kit";
import * as dmath from "../sim/dmath";

export type ContainerColor = "yellow" | "green" | "red" | "blue" | "teal" | "white";
export type ContainerSize = 40 | 20;

export interface ContainerPlacement {
  /** centre of the bottom face (ground contact when level) */
  x: number; y: number; z: number;
  /** radians about +Y */
  yaw: number;
  size?: ContainerSize;
  color: ContainerColor;
  /** tilt about the local Z (width) axis — nose up/down. Radians. */
  pitch?: number;
  /** tilt about the local X (length) axis — roll. Radians. */
  roll?: number;
  /** doors flung open (spill variant) */
  open?: boolean;
  /** an ENTERABLE box — doors swung flat against the sides, an empty lit interior you can walk into (a hollow
   *  collider: floor, roof, both sides and the front end; the door end is open). Level boxes on a quarter-turn yaw only. */
  enter?: boolean;
  /** brightness variance 0.85..1.1 (default from a hash of the position) */
  tint?: number;
  /** decal scheme override (default by colour: yellow = text+small banana, blue = text, others = big banana) */
  decal?: "text" | "logo" | "both" | "none";
  /** slide the decal along the wall (metres, + toward the doors; e.g. −3.1 puts a yellow's BANANA CO. + banana at the
   *  FRONT end); default = a per-box random slide within the panel */
  decalSlide?: number;
  /** decal size (default ≈ 0.9–1.03 random) and paint strength 0..1 (default: ~80 % fresh, 20 % sun-faded) */
  decalScale?: number; decalFade?: number;
}

export const CONTAINER_DIMS: Record<ContainerSize, { L: number; W: number; H: number }> = {
  40: { L: 12.192, W: 2.438, H: 2.591 },
  20: { L: 6.058, W: 2.438, H: 2.591 },
};

export function containerDims(p: ContainerPlacement) { return CONTAINER_DIMS[p.size ?? 40]; }

/** ONE yaw-only collision box for a level container (Box.yaw is the SIM convention: box +X = world (cos, 0, sin),
 *  i.e. the negative of a three.js yaw). Tilted containers need `containerBoxes()`. */
export function containerBox(p: ContainerPlacement): Box {
  const d = containerDims(p);
  return { c: [p.x, p.y + d.H / 2, p.z], h: [d.L / 2, d.H / 2, d.W / 2], yaw: -p.yaw, surf: "metal" };
}

/** a vertical stack of containers at (x,z) on ground y, bottom → top colours */
export function containerStack(x: number, y: number, z: number, yaw: number, colors: ContainerColor[], size: ContainerSize = 40, o: Partial<ContainerPlacement> = {}): ContainerPlacement[] {
  const H = CONTAINER_DIMS[size].H;
  return colors.map((color, i) => ({ x, y: y + i * H, z, yaw, size, color, ...o }));
}

/** deterministic 0..1 hash of a placement (for tint / decal variety) */
export function placementHash(p: { x: number; z: number; y: number }): number {
  let h = Math.imul((p.x * 73856093) ^ (p.z * 19349663) ^ (p.y * 83492791), 2654435761) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995) >>> 0; h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

// ---------------------------------------------------------------- yaw-only collider fitting (shared by the POIs)
// The sim's static boxes rotate about Y only (Box.pitch just inflates hy — shared/sim/world.ts). Tilted solids (the
// wreck's pitched + rolled hull, tumbled containers, leaning funnels) are therefore FITTED with yaw-only boxes:
//   • fitBox(c, eu, ev, ew): one small piece (plate, deck tile) → the box through its exact centre whose extents are the
//     piece's own half-axes projected on the yawed frame (no AABB bloat). Neighbouring pieces share edge midpoints,
//     so a surface tiled this way is seamless; the error is only the tilt × the piece's half-size.
//   • solidColumns(c, axes, h, tol): any tilted box → vertical columns over its footprint (yaw = its longest
//     horizontal axis), cell widths chosen greedily so every column stays within `tol` of the true faces.
// Sim yaw convention: SIM_YAW(threeYaw) = −threeYaw.
export type V3 = [number, number, number];
export const simYaw = (threeYaw: number) => -threeYaw;
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** one yaw-only box fitted to a small oriented piece: world centre + world half-axis vectors eu (along — sets the yaw),
 *  ev and ew (the other two: each counts toward the box's height when it is mostly vertical, else toward its width).
 *  The along extent also covers ev's lean along u (eu and ev lie in the surface for plates, so that padding is
 *  tangential: sheared neighbours overlap instead of gapping). */
export function fitBox(c: V3, eu: V3, ev: V3, ew: V3, surf: Box["surf"]): Box {
  const yaw = dmath.atan2(eu[2], eu[0]), cu = dmath.cos(yaw), su = dmath.sin(yaw);
  let hy = 0, hw = 0;
  for (const e of [ev, ew]) {
    const ew2 = Math.abs(-e[0] * su + e[2] * cu), ey = Math.abs(e[1]);
    if (ey >= ew2) hy += ey; else hw += ew2;
  }
  const hu = Math.abs(eu[0] * cu + eu[2] * su) + Math.abs(ev[0] * cu + ev[2] * su);
  return { c: [c[0], c[1], c[2]], h: [Math.max(0.04, hu), Math.max(0.04, hy), Math.max(0.04, hw)], yaw, surf };
}
/** the fit's error at a piece edge from its (world) half-vector e, given the piece's along vector eu: the component
 *  that fitBox drops and that is NOT tangential (vertical-dominant e → its horizontal part across eu; else its y) */
export function fitError(e: V3, eu: V3): number {
  const yaw = dmath.atan2(eu[2], eu[0]), across = Math.abs(-e[0] * dmath.sin(yaw) + e[2] * dmath.cos(yaw)), y = Math.abs(e[1]);
  return y >= across ? across : y;
}

/**
 * A thin surface patch (4 world corners, A→B along, D→C the far edge) → a yaw-only box: across the patch (whichever
 * frame axis its normal favours) the outer face passes through the patch centroid and the box reaches `t` into the
 * solid; along the other axes it bounds the patch. Exact for vertical / horizontal plates; a leaning or sloped patch
 * errs by ± half its size × its lean, so callers split those small.
 */
export function patchBox(A: V3, B: V3, C: V3, D: V3, inward: V3, t: number, surf: Box["surf"]): Box {
  const eu: V3 = [B[0] + C[0] - A[0] - D[0], 0, B[2] + C[2] - A[2] - D[2]];
  const yaw = dmath.atan2(eu[2], eu[0]), cu = dmath.cos(yaw), su = dmath.sin(yaw);
  const o: V3 = [(A[0] + B[0] + C[0] + D[0]) / 4, (A[1] + B[1] + C[1] + D[1]) / 4, (A[2] + B[2] + C[2] + D[2]) / 4];
  let u0 = Infinity, u1 = -Infinity, w0 = Infinity, w1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of [A, B, C, D]) {
    const dx = p[0] - o[0], dz = p[2] - o[2], u = dx * cu + dz * su, w = -dx * su + dz * cu, y = p[1] - o[1];
    u0 = Math.min(u0, u); u1 = Math.max(u1, u); w0 = Math.min(w0, w); w1 = Math.max(w1, w); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  // across the patch (its normal-dominant axis) the outer face goes through the centroid (symmetric error), the box
  // extends t into the solid; along the other two axes it bounds the patch
  const nw = -inward[0] * su + inward[2] * cu, ny = inward[1];
  if (Math.abs(ny) > Math.abs(nw)) { if (ny > 0) { y0 = 0; y1 = t; } else { y1 = 0; y0 = -t; } }
  else { if (nw > 0) { w0 = 0; w1 = t; } else { w1 = 0; w0 = -t; } }
  const um = (u0 + u1) / 2, wm = (w0 + w1) / 2;
  return { c: [o[0] + um * cu - wm * su, o[1] + (y0 + y1) / 2, o[2] + um * su + wm * cu], h: [Math.max(0.04, (u1 - u0) / 2), Math.max(0.04, (y1 - y0) / 2), Math.max(0.04, (w1 - w0) / 2)], yaw, surf };
}

/**
 * Any oriented box (world centre c, unit axes A[0..2], half-lengths h) → yaw-only vertical columns within ~`tol` of
 * its faces. Cells are merged greedily along the yawed u axis, then along w per u-cell; a column is the true vertical
 * extent of the solid at the cell centre. Steep faces get narrow cells (the horizontal error there is half a cell),
 * shallow faces get cells as long as their slope allows.
 */
export function solidColumns(c: V3, A: [V3, V3, V3], h: V3, tol: number, surf: Box["surf"], maxCell = 6): Box[] {
  // yaw: the axis with the longest horizontal extent
  let bi = 0, best = -1;
  for (let i = 0; i < 3; i++) { const l = h[i] * dmath.hypot(A[i][0], A[i][2]); if (l > best) { best = l; bi = i; } }
  const yaw = dmath.atan2(A[bi][2], A[bi][0]), cu = dmath.cos(yaw), su = dmath.sin(yaw);
  const U: V3 = [cu, 0, su], W: V3 = [-su, 0, cu];
  // footprint bounds (relative to c)
  let u0 = Infinity, u1 = -Infinity, w0 = Infinity, w1 = -Infinity;
  for (const a of [-1, 1]) for (const b of [-1, 1]) for (const d of [-1, 1]) {
    const p: V3 = [0, 1, 2].map((k) => a * h[0] * A[0][k] + b * h[1] * A[1][k] + d * h[2] * A[2][k]) as V3;
    const pu = dot(p, U), pw = dot(p, W);
    u0 = Math.min(u0, pu); u1 = Math.max(u1, pu); w0 = Math.min(w0, pw); w1 = Math.max(w1, pw);
  }
  // vertical interval of the solid on the line (u, w) (relative y), or null
  const iv = (u: number, w: number): [number, number] | null => {
    let lo = -Infinity, hi = Infinity;
    for (let i = 0; i < 3; i++) {
      const k = A[i][1], a = u * dot(A[i], U) + w * dot(A[i], W);
      if (Math.abs(k) < 1e-7) { if (Math.abs(a) > h[i]) return null; continue; }
      let y0 = (-h[i] - a) / k, y1 = (h[i] - a) / k;
      if (y0 > y1) { const t = y0; y0 = y1; y1 = t; }
      lo = Math.max(lo, y0); hi = Math.min(hi, y1);
      if (lo > hi) return null;
    }
    return hi - lo > 0.04 ? [lo, hi] : null;
  };
  // greedy 1D partition of [a, b] where f(s) gives intervals; cells keep each face within tol
  const part = (a: number, b: number, f: (s: number) => [number, number] | null): Array<[number, number]> => {
    const n = Math.max(2, Math.ceil((b - a) / 0.04)), ds = (b - a) / n;
    const vals: Array<[number, number] | null> = [];
    for (let k = 0; k <= n; k++) vals.push(f(a + k * ds));
    const cells: Array<[number, number]> = [];
    let k0 = 0;
    while (k0 < n) {
      let k1 = k0 + 1;
      const ok = (kk: number) => {
        const width = (kk - k0) * ds;
        if (width > maxCell) return false;
        let hit = 0, miss = 0, lo0 = Infinity, lo1 = -Infinity, hi0 = Infinity, hi1 = -Infinity;
        for (let k = k0; k <= kk; k++) { const v = vals[k]; if (!v) { miss++; continue; } hit++; lo0 = Math.min(lo0, v[0]); lo1 = Math.max(lo1, v[0]); hi0 = Math.min(hi0, v[1]); hi1 = Math.max(hi1, v[1]); }
        if (hit && miss) return width <= 2 * tol; // the silhouette: keep the cell narrow
        if (!hit) return true;
        const err = (r: number) => (r / 2) / Math.sqrt(1 + dmath.pow(r / Math.max(width, 1e-3), 2));
        return err(lo1 - lo0) <= tol && err(hi1 - hi0) <= tol;
      };
      while (k1 < n && ok(k1 + 1)) k1++;
      cells.push([a + k0 * ds, a + k1 * ds]);
      k0 = k1;
    }
    return cells;
  };
  const out: Box[] = [];
  const uc = part(u0, u1, (u) => {
    // the worst of three lines across the footprint (centre + both quarter lines)
    let lo = Infinity, hi = -Infinity, any = false;
    for (const w of [(w0 + w1) / 2, w0 + (w1 - w0) * 0.2, w1 - (w1 - w0) * 0.2]) { const v = iv(u, w); if (v) { any = true; lo = Math.min(lo, v[0]); hi = Math.max(hi, v[1]); } }
    return any ? [lo, hi] : null;
  });
  for (const [ua, ub] of uc) {
    const um = (ua + ub) / 2;
    for (const [wa, wb] of part(w0, w1, (w) => iv(um, w))) {
      const wm = (wa + wb) / 2, v = iv(um, wm);
      if (!v) continue;
      out.push({ c: [c[0] + um * cu - wm * su, c[1] + (v[0] + v[1]) / 2, c[2] + um * su + wm * cu], h: [(ub - ua) / 2, (v[1] - v[0]) / 2, (wb - wa) / 2], yaw, surf });
    }
  }
  return out;
}

/** a placement's rotation as world unit axes (three.js Ry(yaw)·Rz(pitch)·Rx(roll)) */
export function placementAxes(yaw: number, pitch: number, roll: number): [V3, V3, V3] {
  const r = (x: number, y: number, z: number): V3 => {
    const y1 = y * dmath.cos(roll) - z * dmath.sin(roll), z1 = y * dmath.sin(roll) + z * dmath.cos(roll);
    const x2 = x * dmath.cos(pitch) - y1 * dmath.sin(pitch), y2 = x * dmath.sin(pitch) + y1 * dmath.cos(pitch);
    const c = dmath.cos(yaw), s = dmath.sin(yaw);
    return [x2 * c + z1 * s, y2, -x2 * s + z1 * c];
  };
  return [r(1, 0, 0), r(0, 1, 0), r(0, 0, 1)];
}

/** the harbor's deterministic hash (identical to client _kit/harbor-geo `hash`): shared so a prop's drawn variant
 *  (pallet loads …) and its collider agree */
export function hash01(...n: number[]): number {
  let h = 2166136261 >>> 0;
  for (const v of n) { h ^= Math.floor(v * 1000) | 0; h = Math.imul(h, 16777619) >>> 0; }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995) >>> 0; h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
/** (parity) the long side walls are corrugated 3–9 cm inside the corner posts / rails — the collider face sits at
 *  the corrugation's middle (4.5 cm in), so neither the ridges nor the valleys are > 5 cm off it */
const SIDE_IN = 0.045;
/** (parity) a SOLID box's long sides lie 3 cm under the corrugation's ridge plane (ridge 3.2 cm inside the posts,
 *  valleys 6 cm deeper — containers-geo SIDE_INSET / SIDE_DEPTH): half way into the valleys — a shot glancing off a rib
 *  meets the box within 0.25 m, and no drawn steel lies more than 3 cm behind it */
const SIDE_SOLID = 0.062;
/**
 * Collision for one container: an axis-aligned box when it sits level on a quarter-turn yaw (the whole yard), ONE
 * yawed box when level at any yaw, otherwise yaw-only columns fitted within ~0.15 m of the tilted faces.
 */
export function containerBoxes(p: ContainerPlacement): Box[] {
  const d = containerDims(p), pitch = p.pitch ?? 0, roll = p.roll ?? 0;
  const level = Math.abs(pitch) < 0.01 && Math.abs(roll) < 0.01;
  const k = Math.round(p.yaw / (Math.PI / 2));
  if (level && Math.abs(p.yaw - k * (Math.PI / 2)) < 0.01) {
    const swap = Math.abs(k) % 2 === 1;
    if (p.enter) {
      // hollow: floor (0.16 m), roof (0.12), side walls + the closed front end (0.1 m); local +X = the open door end
      const c = Math.round(dmath.cos(p.yaw)), s = Math.round(dmath.sin(p.yaw)), out: Box[] = [];
      const L2 = d.L / 2, W2 = d.W / 2, T = 0.1;
      const P = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) => {
        const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, hx = (x1 - x0) / 2, hz = (z1 - z0) / 2;
        out.push({ c: [p.x + cx * c + cz * s, p.y + (y0 + y1) / 2, p.z - cx * s + cz * c], h: swap ? [hz, (y1 - y0) / 2, hx] : [hx, (y1 - y0) / 2, hz], surf: "metal" });
      };
      P(-L2, L2, 0, 0.22, -W2, W2);
      P(-L2, L2, d.H - 0.12, d.H, -W2, W2);
      P(-L2, L2, 0.22, d.H - 0.12, W2 - T, W2 - SIDE_IN);
      P(-L2, L2, 0.22, d.H - 0.12, -W2 + SIDE_IN, -W2 + T);
      P(-L2, -L2 + T, 0.22, d.H - 0.12, -W2 + T, W2 - T);
      // (parity) the cargo wall drawn at the closed end (containers-geo `open && enter`): two rows of cartons
      // stacked to the ceiling — one solid block (stepped carton tops were crouch-only floors nobody could reach)
      P(-L2 + 0.14, -L2 + 1.0, 0.22, d.H - 0.12, -W2 + T, W2 - T);
      // (parity) the two door leaves swung 262° back against the side walls (drawn, had no collider)
      P(L2 - 1.15, L2 + 0.02, 0.05, d.H - 0.1, W2 - SIDE_IN, W2 + 0.04);
      P(L2 - 1.15, L2 + 0.02, 0.05, d.H - 0.1, -W2 - 0.04, -W2 + SIDE_IN);
      return out;
    }
    // (+ the corner-post frames at both ends at the full width: the posts stand proud of the corrugated walls)
    const ex = Math.round(dmath.cos(p.yaw)), ez = -Math.round(dmath.sin(p.yaw)), e = d.L / 2 - 0.09;
    return [{ c: [p.x, p.y + d.H / 2, p.z], h: swap ? [d.W / 2 - SIDE_SOLID, d.H / 2, d.L / 2] : [d.L / 2, d.H / 2, d.W / 2 - SIDE_SOLID], surf: "metal" },
      ...[-1, 1].map((sg): Box => ({ c: [p.x + ex * e * sg, p.y + d.H / 2, p.z + ez * e * sg], h: swap ? [d.W / 2, d.H / 2, 0.09] : [0.09, d.H / 2, d.W / 2], surf: "metal" }))];
  }
  if (level) return [containerBox(p)];
  const A = placementAxes(p.yaw, pitch, roll);
  const c: V3 = [p.x + A[1][0] * d.H / 2, p.y + A[1][1] * d.H / 2, p.z + A[1][2] * d.H / 2];
  // (10 cm tolerance — the wreck's measured p99 gap on the tilted spill was 0.16–0.2 m at 15 cm; 8 cm left thin edge columns a capsule sank between)
  return solidColumns(c, A, [d.L / 2, d.H / 2, d.W / 2], 0.1, "metal", 3);
}

// ================================================================ playable buildings (one layout → visuals + colliders)
// A building is a list of PIECES: axis-aligned boxes in a building-local frame (x along its length, y up from its floor
// datum, z across) with a paint tag. The client draws every piece as a bevelled, painted box (+ dressing keyed on
// `kind`); the sim gets the SAME boxes (solid ones) as colliders. Frames rotate by quarter turns only, so the boxes
// stay axis-aligned all the way to the world (what you see is what you collide with, exactly).
export type PieceMat =
  | "wall" | "wallIn" | "floor" | "ceiling" | "concrete" | "steel" | "grate" | "yellow" | "trim" | "wood" | "rail"
  | "desk" | "cabinet" | "locker" | "machine" | "crate" | "pipe" | "glass" | "rust" | "deckPlate" | "hull";
export interface Piece {
  /** centre + half extents (building-local, y absolute in the building's frame) */
  c: V3; h: V3;
  mat: PieceMat;
  /** default true: also a collider */
  solid?: boolean;
  /** players collide, bullets pass (glass, railings) */
  noShoot?: boolean;
  surf?: Box["surf"];
  /** walls: the storey floor they stand on (the client paints the dado band from there) */
  base?: number;
  /** "flight" pieces (visual only, the flight's bounding box): the horizontal direction the stair climbs toward */
  up?: [number, number];
  /** dressing hint for the client (a desk is drawn as a desk inside its box, a tread as a grated step…) */
  kind?: "tread" | "landing" | "desk" | "cabinet" | "locker" | "console" | "machine" | "crate" | "bunk" | "rail" | "door" | "window" | "stringer" | "shelf" | "seat" | "pipe" | "panel" | "hatch" | "lamp" | "table" | "flight" | "post";
}
/** a quarter-turn frame: building-local (x, y, z) → parent (x·c − z·s … three.js Ry(yaw) convention) + translation */
export interface QFrame { x: number; y: number; z: number; /** multiple of π/2 */ yaw: number }
export function qPoint(f: QFrame, x: number, y: number, z: number): V3 {
  const c = Math.round(dmath.cos(f.yaw)), s = Math.round(dmath.sin(f.yaw));
  return [f.x + x * c + z * s, f.y + y, f.z - x * s + z * c];
}
/** a piece in frame f → a piece in the parent frame (half extents swap on odd quarter turns) */
export function qPiece(f: QFrame, p: Piece): Piece {
  const odd = Math.abs(Math.round(dmath.sin(f.yaw))) === 1;
  const q: Piece = { ...p, c: qPoint(f, p.c[0], p.c[1], p.c[2]), h: odd ? [p.h[2], p.h[1], p.h[0]] : [p.h[0], p.h[1], p.h[2]] };
  if (p.base !== undefined) q.base = p.base + f.y;
  if (p.up) { const c = Math.round(dmath.cos(f.yaw)), sn = Math.round(dmath.sin(f.yaw)); q.up = [p.up[0] * c + p.up[1] * sn, -p.up[0] * sn + p.up[1] * c]; }
  return q;
}
export const pieceBox = (p: Piece): Box => {
  const b: Box = { c: [p.c[0], p.c[1], p.c[2]], h: [p.h[0], p.h[1], p.h[2]], surf: p.surf ?? surfOf(p.mat) };
  if (p.noShoot) b.noShoot = true;
  return b;
};
function surfOf(m: PieceMat): Box["surf"] {
  return m === "wood" || m === "desk" || m === "crate" ? "wood" : m === "wall" || m === "wallIn" || m === "floor" || m === "ceiling" || m === "concrete" ? "concrete" : m === "glass" ? "glass" : "metal";
}
/** an axis box from min/max corners */
export function slabXYZ(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, mat: PieceMat, o: Partial<Piece> = {}): Piece {
  return { c: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], h: [Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, Math.abs(z1 - z0) / 2], mat, ...o };
}

/** an opening in a wall run: along-wall range [a0, a1], height range [y0, y1] */
export interface Opening { a0: number; a1: number; y0: number; y1: number; kind: "door" | "window" }
/**
 * A straight wall along x (axis "x": from a0 to a1 at z = c) or along z (axis "z": at x = c), thickness t, from y0 to
 * y1, with openings cut out (doors down to the floor, windows with a sill + lintel). Window openings stay OPEN (shoot
 * through, too small to climb: sill ≥ 0.9 m, height ≤ 1.3 m); the client frames them.
 */
export function wallRun(axis: "x" | "z", a0: number, a1: number, c: number, y0: number, y1: number, t: number, mat: PieceMat, openings: Opening[] = []): Piece[] {
  const out: Piece[] = [];
  const P = (b0: number, b1: number, q0: number, q1: number, kind?: Piece["kind"]) => {
    if (b1 - b0 < 0.02 || q1 - q0 < 0.02) return;
    out.push(axis === "x" ? slabXYZ(b0, b1, q0, q1, c - t / 2, c + t / 2, mat, kind ? { kind, base: y0 } : { base: y0 }) : slabXYZ(c - t / 2, c + t / 2, q0, q1, b0, b1, mat, kind ? { kind, base: y0 } : { base: y0 }));
  };
  const ops = [...openings].sort((p, q) => p.a0 - q.a0);
  let a = a0;
  for (const o of ops) {
    P(a, o.a0, y0, y1);
    P(o.a0, o.a1, y0, o.y0);   // sill (door: nothing)
    P(o.a0, o.a1, o.y1, y1);   // lintel
    // the opening itself: drawn by the client (jambs, head, sill, mullion + a pane). (parity) A glazed window
    // too low for a kong to climb through is a no-shoot collider (players stop at the glass, bullets pass);
    // doors (and storey-high openings) stay open
    const glazed = o.kind === "window" && o.y1 - o.y0 < 1.95;
    const fl: Partial<Piece> = glazed ? { noShoot: true, kind: o.kind, surf: "glass" } : { solid: false, kind: o.kind };
    // A breakable pane is ≤ 8 cm half-thick (shared/sim/world.ts isPaneBox), so the glazed collider is not the WALL's
    // thickness (0.2–0.3 m: the glass could not be broken) but a 10 cm pane at the wall's centre, where the client draws the glass
    // (harbor-rooms "window"): bullets, rockets, a punch or a sprint break it, and the opening is then a vault route
    const pt = glazed ? Math.min(t, 0.1) : t;
    out.push(axis === "x" ? slabXYZ(o.a0, o.a1, o.y0, o.y1, c - pt / 2, c + pt / 2, mat, fl) : slabXYZ(c - pt / 2, c + pt / 2, o.y0, o.y1, o.a0, o.a1, mat, fl));
    a = o.a1;
  }
  P(a, a1, y0, y1);
  return out;
}

/**
 * A straight stair flight along an axis: foot at (x, z) (the lower end of the flight), climbing toward +dir along
 * `axis` from y0 to y1, width w (centred on the flight line). Treads ≤ 0.25 m rise, ≥ 0.28 m run (run = len / n).
 * `solidBelow` (m): treads whose top is below that height are closed down to y0 (no wedge under a low flight).
 */
export function flight(axis: "x" | "z", x: number, z: number, dir: 1 | -1, y0: number, y1: number, len: number, w: number, mat: PieceMat = "grate", solidBelow = 2.4): Piece[] {
  const n = Math.max(1, Math.ceil((y1 - y0) / 0.25 - 1e-6)), run = len / n, out: Piece[] = [];
  for (let k = 0; k < n; k++) {
    const top = y0 + ((y1 - y0) * (k + 1)) / n, a = (k + 0.5) * run * dir, bot = top - y0 < solidBelow ? y0 : top - 0.18;
    const [cx, cz] = axis === "x" ? [x + a, z] : [x, z + a];
    const hx = axis === "x" ? run / 2 + 0.015 : w / 2, hz = axis === "x" ? w / 2 : run / 2 + 0.015;
    out.push({ c: [cx, (top + bot) / 2, cz], h: [hx, (top - bot) / 2, hz], mat, kind: "tread" });
  }
  // the flight as a whole (visual only): the client hangs the stringers + handrails on it
  const [fx0, fx1] = axis === "x" ? [Math.min(x, x + len * dir), Math.max(x, x + len * dir)] : [x - w / 2, x + w / 2];
  const [fz0, fz1] = axis === "z" ? [Math.min(z, z + len * dir), Math.max(z, z + len * dir)] : [z - w / 2, z + w / 2];
  out.push(slabXYZ(fx0, fx1, y0, y1, fz0, fz1, mat, { solid: false, kind: "flight", up: axis === "x" ? [dir, 0] : [0, dir] }));
  return out;
}
/** a guard rail (collider: players stop, bullets pass) along a segment at floor y, 1.05 m tall */
export function railRun(x0: number, z0: number, x1: number, z1: number, y: number): Piece {
  const t = 0.06;
  return slabXYZ(Math.min(x0, x1) - (x0 === x1 ? t : 0), Math.max(x0, x1) + (x0 === x1 ? t : 0), y, y + 1.05, Math.min(z0, z1) - (z0 === z1 ? t : 0), Math.max(z0, z1) + (z0 === z1 ? t : 0), "rail", { noShoot: true, kind: "rail" });
}

/**
 * A switchback stairwell (inside a building): flights along x in two lanes (z = zc ∓ laneOff), landings at both ends,
 * `levels` storeys of height `lh` from y0, each storey = 2 flights. Returns the pieces + the rect that every floor
 * slab above y0 must leave open (the well). Footprint: x ∈ [x0, x0 + L], z ∈ [zc − W/2, zc + W/2].
 */
export function stairwell(x0: number, zc: number, y0: number, lh: number, levels: number, mat: PieceMat = "steel"): { pieces: Piece[]; well: [number, number, number, number]; L: number; W: number } {
  const w = 1.15, land = 1.25, gap = 0.1, W = 2 * w + gap;
  const half = lh / 2, run = Math.ceil(half / 0.25 - 1e-6) * 0.28, L = run + 2 * land;
  const pieces: Piece[] = [];
  for (let l = 0; l < levels; l++) {
    const ya = y0 + l * lh;
    // up the −z lane toward +x, landing at the far end, back along the +z lane toward −x
    pieces.push(...flight("x", x0 + land, zc - (w + gap) / 2, 1, ya, ya + half, run, w, mat, l === 0 ? 2.4 : 0));
    // (the ground storey is closed underneath: the far landing and the base under the return flight are solid — no
    // capsule-height wedge under a 1.4 m landing)
    pieces.push(slabXYZ(x0 + land + run, x0 + L, l === 0 ? ya : ya + half - 0.2, ya + half, zc - W / 2, zc + W / 2, mat, { kind: "landing" }));
    if (l === 0) pieces.push(slabXYZ(x0 + land, x0 + land + run, ya, ya + half - 0.1, zc + gap / 2, zc + W / 2, mat, { kind: "stringer" }));
    pieces.push(...flight("x", x0 + land + run, zc + (w + gap) / 2, -1, ya + half, ya + lh, run, w, mat, 0));
    // (the next storey's floor slab provides the landing at x0 … x0 + land; the well stays open over the flights)
  }
  // the central divider wall between the up and the down lane (a kong straddling the 10 cm gap climbed the wrong flight)
  pieces.push(slabXYZ(x0 + land, x0 + land + run, y0, y0 + levels * lh, zc - gap / 2, zc + gap / 2, mat, { kind: "stringer" }));
  return { pieces, well: [x0 + land - 0.05, x0 + L + 0.05, zc - W / 2 - 0.05, zc + W / 2 + 0.05], L, W };
}
/** a floor slab over rect [x0,x1]×[z0,z1] at top y, thickness t, with rectangular holes cut (split into ≤ 4 pieces each) */
export function floorWithHoles(x0: number, x1: number, z0: number, z1: number, y: number, t: number, mat: PieceMat, holes: Array<[number, number, number, number]>): Piece[] {
  let rects: Array<[number, number, number, number]> = [[x0, x1, z0, z1]];
  for (const [hx0, hx1, hz0, hz1] of holes) {
    const next: Array<[number, number, number, number]> = [];
    for (const r of rects) {
      const [a0, a1, b0, b1] = r;
      if (hx1 <= a0 || hx0 >= a1 || hz1 <= b0 || hz0 >= b1) { next.push(r); continue; }
      const cx0 = Math.max(a0, hx0), cx1 = Math.min(a1, hx1);
      if (cx0 > a0) next.push([a0, cx0, b0, b1]);
      if (cx1 < a1) next.push([cx1, a1, b0, b1]);
      if (hz0 > b0) next.push([cx0, cx1, b0, hz0]);
      if (hz1 < b1) next.push([cx0, cx1, hz1, b1]);
    }
    rects = next;
  }
  return rects.filter(([a0, a1, b0, b1]) => a1 - a0 > 0.05 && b1 - b0 > 0.05).map(([a0, a1, b0, b1]) => slabXYZ(a0, a1, y - t, y, b0, b1, mat, { kind: "panel" }));
}

/** a hut: four walls (w along x, d along z, h tall, thickness t) with openings per side (`a` = centre along the wall,
 *  `w` = width), a roof slab of thickness rt on top, a visual floor finish. Building-local, floor at y = 0. */
export interface HutOpening { side: "+x" | "-x" | "+z" | "-z"; a: number; w: number; y0: number; y1: number; kind: "door" | "window" }
export function hutPieces(w: number, d: number, h: number, openings: HutOpening[], o: { t?: number; rt?: number; wall?: PieceMat; roof?: PieceMat; floor?: PieceMat } = {}): Piece[] {
  const t = o.t ?? 0.22, rt = o.rt ?? 0.25, wm = o.wall ?? "wall", out: Piece[] = [];
  const ops = (side: HutOpening["side"]) => openings.filter((q) => q.side === side).map((q): Opening => ({ a0: q.a - q.w / 2, a1: q.a + q.w / 2, y0: q.y0, y1: q.y1, kind: q.kind }));
  out.push(...wallRun("x", -w / 2, w / 2, d / 2 - t / 2, 0, h, t, wm, ops("+z")));
  out.push(...wallRun("x", -w / 2, w / 2, -d / 2 + t / 2, 0, h, t, wm, ops("-z")));
  out.push(...wallRun("z", -d / 2 + t, d / 2 - t, w / 2 - t / 2, 0, h, t, wm, ops("+x")));
  out.push(...wallRun("z", -d / 2 + t, d / 2 - t, -w / 2 + t / 2, 0, h, t, wm, ops("-x")));
  out.push(slabXYZ(-w / 2, w / 2, h, h + rt, -d / 2, d / 2, o.roof ?? "concrete", { kind: "panel" }));
  out.push(slabXYZ(-w / 2 + t, w / 2 - t, 0, 0.02, -d / 2 + t, d / 2 - t, o.floor ?? "floor", { kind: "panel", solid: false }));
  return out;
}

// ---------------------------------------------------------------- designed loot helpers (LOOT_SPOTS contract)
/** the highest walkable collider top under (x, z) at or below yHint + 0.6 (world boxes, sim yaw convention); yHint when
 *  none (the terrain) — designed spots are authored by room and settle onto the exact floor of the shared colliders */
export function floorUnder(boxes: Box[], x: number, yHint: number, z: number, m = 0): number {
  let best = -Infinity;
  for (const b of boxes) {
    const top = b.c[1] + b.h[1];
    if (top > yHint + 0.6 || top <= best || b.noShoot) continue;
    let dx = x - b.c[0], dz = z - b.c[2];
    if (b.yaw) { const c = dmath.cos(b.yaw), s = dmath.sin(b.yaw); const u = dx * c + dz * s, v = -dx * s + dz * c; dx = u; dz = v; }
    if (Math.abs(dx) <= b.h[0] - m && Math.abs(dz) <= b.h[2] - m) best = top;
  }
  return best > yHint - 3 ? best : yHint;
}
/** three.js yaw that turns a chest's +z front toward (tx, tz) from (x, z) (world) */
export const faceYaw = (x: number, z: number, tx: number, tz: number) => dmath.atan2(tx - x, tz - z);
/** a spatial index for floorUnder over many boxes (cell 8 m) */
export function boxGrid(boxes: Box[], cell = 8): (x: number, z: number, pad?: number) => Box[] {
  const g = new Map<string, Box[]>();
  for (const b of boxes) {
    const r = dmath.hypot(b.h[0], b.h[2]);
    for (let i = Math.floor((b.c[0] - r) / cell); i <= Math.floor((b.c[0] + r) / cell); i++)
      for (let k = Math.floor((b.c[2] - r) / cell); k <= Math.floor((b.c[2] + r) / cell); k++) { const key = i + "," + k; let a = g.get(key); if (!a) g.set(key, (a = [])); a.push(b); }
  }
  // (every cell within `pad` of the point: a box just across a cell edge still counts)
  return (x, z, pad = 1.5) => {
    const i0 = Math.floor((x - pad) / cell), i1 = Math.floor((x + pad) / cell), k0 = Math.floor((z - pad) / cell), k1 = Math.floor((z + pad) / cell);
    if (i0 === i1 && k0 === k1) return g.get(i0 + "," + k0) ?? [];
    const out = new Set<Box>();
    for (let i = i0; i <= i1; i++) for (let k = k0; k <= k1; k++) for (const b of g.get(i + "," + k) ?? []) out.add(b);
    return [...out];
  };
}
/** is a standing kong capsule (radius r, from y + 0.15 to y + 1.9) clear of every box at (x, y, z)? (world, sim yaw) */
export function capsuleClear(boxes: Box[], x: number, y: number, z: number, r = 0.55, step = 0.5): boolean {
  for (const b of boxes) {
    if (b.c[1] + b.h[1] < y + step || b.c[1] - b.h[1] > y + 1.9) continue;
    let dx = x - b.c[0], dz = z - b.c[2];
    if (b.yaw) { const c = dmath.cos(b.yaw), s = dmath.sin(b.yaw); const u = dx * c + dz * s, v = -dx * s + dz * c; dx = u; dz = v; }
    const qx = Math.max(0, Math.abs(dx) - b.h[0]), qz = Math.max(0, Math.abs(dz) - b.h[2]);
    if (qx * qx + qz * qz < r * r) return false;
  }
  return true;
}
/** the first of a spiral of offsets around (x, z) (steps of `step` m, up to `max` m) where the settled floor is clear */
export function clearSpot(near: (x: number, z: number, pad?: number) => Box[], x: number, yHint: number, z: number, step = 0.5, max = 3): [number, number, number] | null {
  for (let r = 0; r <= max + 1e-6; r += step) {
    const n = r === 0 ? 1 : Math.max(6, Math.round((2 * Math.PI * r) / step));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2, px = x + r * dmath.cos(a), pz = z + r * dmath.sin(a), bs = near(px, pz), y = floorUnder(bs, px, yHint, pz);
      if (Math.abs(y - yHint) < 1.2 && capsuleClear(bs, px, y, pz)) return [px, y, pz];
    }
  }
  return null;
}
/** no box top between y + lo and y + hi within r of (x, z): nothing a kong standing there would be stepped up onto */
export function noLowStep(boxes: Box[], x: number, y: number, z: number, r = 0.8, lo = 0.1, hi = 0.6): boolean {
  for (const b of boxes) {
    const top = b.c[1] + b.h[1];
    if (top <= y + lo || top > y + hi || b.c[1] - b.h[1] > y + hi) continue;
    let dx = x - b.c[0], dz = z - b.c[2];
    if (b.yaw) { const c = dmath.cos(b.yaw), s = dmath.sin(b.yaw); const u = dx * c + dz * s, v = -dx * s + dz * c; dx = u; dz = v; }
    const qx = Math.max(0, Math.abs(dx) - b.h[0]), qz = Math.max(0, Math.abs(dz) - b.h[2]);
    if (qx * qx + qz * qz < r * r) return false;
  }
  return true;
}

// ---------------------------------------------------------------- baked furnished rooms
/** The furnished rooms' colliders + loot slots, baked per room (shared/pois/<poi>-baked.json, by an offline bake)
 *  so the server and the client's main thread do not furnish every room at import. A stale bake (the rooms' key or 2
 *  probe rooms furnished live differ — the interiors kit changed) falls back to furnishing live with a warning. */
export interface RoomBake { key: string; probe: number[]; rooms: Array<{ cols: number[]; chests: number[]; floor: number[]; /** the drawn layout (finish + items) — the client skips furnishRoom */ lay?: { finish: unknown; items: unknown[] } }> }
const SURF_I: Array<NonNullable<Box["surf"]>> = ["wood", "metal", "concrete", "stone", "sand", "grass", "water", "foliage", "glass", "fabric"];
const r3 = (v: number) => Math.round(v * 1000) / 1000;
function roomKey(rooms: InteriorRoom[]): string {
  const str = JSON.stringify(rooms, (_k, v) => (typeof v === "number" ? Math.round(v * 1e5) / 1e5 : v));
  let h1 = 0x811c9dc5, h2 = 0x1b873593;
  for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619); h2 = Math.imul(h2 ^ c, 2246822519); }
  return `${rooms.length}:${(h1 >>> 0).toString(16)}${(h2 >>> 0).toString(16)}`;
}
function flatBoxes(bs: Box[], out: number[] = []): number[] {
  for (const b of bs) out.push(r3(b.c[0]), r3(b.c[1]), r3(b.c[2]), r3(b.h[0]), r3(b.h[1]), r3(b.h[2]), r3(b.yaw ?? 0), SURF_I.indexOf(b.surf ?? "wood"), (b.noShoot ? 1 : 0) | (b.noWalk ? 2 : 0));
  return out;
}
function unflatBoxes(a: number[]): Box[] {
  const out: Box[] = [];
  for (let i = 0; i < a.length; i += 9) {
    const b: Box = { c: [a[i], a[i + 1], a[i + 2]], h: [a[i + 3], a[i + 4], a[i + 5]], surf: SURF_I[a[i + 7]] };
    if (a[i + 6]) b.yaw = a[i + 6];
    if (a[i + 8] & 1) b.noShoot = true;
    if (a[i + 8] & 2) b.noWalk = true;
    out.push(b);
  }
  return out;
}
const probeOf = (rooms: InteriorRoom[]): number[] => { const out: number[] = []; for (const i of [rooms.length - 1]) if (rooms[i]) { const L = furnishRoom(rooms[i]); out.push(L.items.length); flatBoxes(interiorColliders([rooms[i]]), out); } return out; };
export function bakeRooms(rooms: InteriorRoom[]): RoomBake {
  const rnd = (o: unknown) => JSON.parse(JSON.stringify(o, (_k, v) => (typeof v === "number" ? r3(v) : v)));
  return { key: roomKey(rooms), probe: probeOf(rooms), rooms: rooms.map((r) => { const l = interiorLoot([r]), L = furnishRoom(r); return { cols: flatBoxes(interiorColliders([r])), chests: l.chests.flat().map(r3), floor: l.floor.flat().map(r3), lay: { finish: rnd(L.finish), items: rnd(L.items) } }; }) };
}
/** the furnished rooms' DRAWN layouts from a current bake (aligned with `rooms`; undefined = furnish live) —
 *  hand them to the client kit's buildInteriors({ layouts }) so it does not re-run furnishRoom on the main thread */
export function bakedLayouts(rooms: InteriorRoom[], bake?: RoomBake | null): Array<InteriorLayout | undefined> {
  if (!bake || bake.key !== roomKey(rooms) || !bake.rooms.every((q) => q.lay)) return rooms.map(() => undefined);
  return rooms.map((room, i) => ({ room, role: "storage", finish: bake.rooms[i].lay!.finish, items: bake.rooms[i].lay!.items, colliders: [], loot: { chests: [], floor: [] }, stats: { free: 0, reachable: 0, connected: true, tries: 0 } }) as unknown as InteriorLayout);
}
export function bakedRooms(poi: string, rooms: InteriorRoom[], bake?: RoomBake | null): Array<{ colliders: Box[]; loot: LootSlots }> {
  let B = bake ?? null, why = B ? "" : "no bake";
  if (B && B.key !== roomKey(rooms)) { why = "rooms changed"; B = null; }
  if (B) { const p = probeOf(rooms); if (p.length !== B.probe.length || p.some((v, k) => Math.abs(v - B!.probe[k]) > 1e-3)) { why = "the interiors kit changed"; B = null; } }
  if (!B) { console.warn(`[${poi}] rooms bake is stale (${why}) — furnishing ${rooms.length} rooms live; re-bake: npx tsx tools/harbor/bake-json.mts`); B = bakeRooms(rooms); }
  return B.rooms.map((q) => {
    const chests: LootSlots["chests"] = [], floor: LootSlots["floor"] = [];
    for (let i = 0; i < q.chests.length; i += 4) chests.push([q.chests[i], q.chests[i + 1], q.chests[i + 2], q.chests[i + 3]]);
    for (let i = 0; i < q.floor.length; i += 3) floor.push([q.floor[i], q.floor[i + 1], q.floor[i + 2]]);
    return { colliders: unflatBoxes(q.cols), loot: { chests, floor } };
  });
}
/** a cheap signature of a collider list (LOOT_SPOTS bake staleness) */
export function boxesSig(bs: Box[]): string {
  let a = 0, b = 0;
  for (let i = 0; i < bs.length; i++) { const q = bs[i]; a += q.c[0] * 1.3 + q.c[1] * 7.1 + q.c[2] * 0.7 + q.h[0] + q.h[1] * 3 + q.h[2] * 5; b += (i % 97) * (q.c[0] - q.c[2]); }
  return `${bs.length}:${a.toFixed(2)}:${b.toFixed(1)}`;
}

// ================================================================ sculpted rocks — one placement list, baked colliders
/** a sculpted rock instance (client: poi-jungle's rockProtos(fam, n, res)[proto], composed T·R(rx, ry, rz)·S) */
export interface RockPl { x: number; y: number; z: number; sx: number; sy: number; sz: number; ry: number; rx: number; rz: number; proto: number }
/** a set of rocks drawn from one prototype family */
export interface RockSet { fam: "boulder" | "cliff" | "cleftout"; n: number; res: number; pl: RockPl[] }
/** the offline rock bake's output per POI: the placements (y settled on the terrain) + the colliders voxelised from
 *  the very triangles the client draws (columns ≤ 0.4 m, merged): [cx, cy, cz, hx, hy, hz] in the POI's collider frame */
export interface RockBake { sig: string; sets: Record<string, RockSet>; boxes: number[][] }
/** signature of a rock layout's INPUTS (stale bake → the caller falls back to its approximate boxes + a warning) */
export function rockSig(v: string, ...inputs: unknown[]): string {
  const s = v + JSON.stringify(inputs, (_k, x) => (typeof x === "number" ? Math.round(x * 1000) / 1000 : x));
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return `${v}:${s.length}:${h.toString(16)}`;
}
/** the baked rock colliders when the bake is current, else null (with a console warning) */
export function bakedRockBoxes(poi: string, bake: RockBake | undefined, sig: string, surf: Box["surf"] = "stone"): Box[] | null {
  if (!bake || bake.sig !== sig) { console.warn(`[${poi}] rock bake is stale — approximate rock colliders; re-bake: npx tsx tools/harbor/bake-rocks.mts`); return null; }
  return bake.boxes.map((b): Box => ({ c: [b[0], b[1], b[2]], h: [b[3], b[4], b[5]], surf }));
}
