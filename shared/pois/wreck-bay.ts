// POI wreck-bay — WRECK BAY: an old wooden pirate galleon wrecked in a hidden cove on the north coast, listing in the
// turquoise shallows, tattered banana-yellow sails; a rope bridge from its waist to a rocky landing, a plank boardwalk
// to the beach, a castaway camp (bonfire, sailcloth tent, two stilt huts, a lookout tower) under leaning palms, and a
// rock headland with a waterfall closing the cove on the east.
//
// Pure TS (no three.js): the ONE layout the client visuals (client/src/world/pois/wreck-bay) AND the authoritative
// server colliders derive from. Every walkable surface / wall is a `WPiece` box; visuals render the same boxes, so what
// you see is what you collide with. Pieces live in one of two frames:
//   · "ship"  — the galleon frame: x from midship toward the BOW (+x), y = world height on the centreline before the
//               list, z across the beam. The shore side is local −z (SH = −1). The whole frame is rolled by SHIP.roll
//               about its x axis (the shore side down) and yawed by SHIP.yaw (three.js convention) at (SHIP.x, 0, SHIP.z).
//   · "world" — world metres.
// The sim's boxes only yaw (shared/sim/world.ts ignores pitch/roll), so the listed decks are cut into ≤ 1.6 m strips
// across the beam: each strip's collider top = the true deck height on the strip's centre line (±0.13 m at its edges).
//
// Plan (world, +X east, −Z north; beach waterline ≈ z −655, shelf −1…−2 m to z −685, −3…−5 m around the wreck):
//   · THE GALLEON (hero) midship at SHIP, bow WSW (30° toward the beach: a 3/4 bow view from the camp), listing 9° toward the beach. Levels (centreline heights): HOLD 0.9,
//     GUN DECK 3.7, MAIN DECK 6.5, QUARTERDECK 9.3 (great cabin under it), POOP 12.1 (chart room under it), FORECASTLE
//     9.3 (galley under it). Stairs + hatches connect every level; a spiral peg stair climbs the mainmast to the
//     CROW'S NEST ring (≈ 21.5 m). A torn breach in the hold's shore side lets waders in from the shallows.
//   · ROPE BRIDGE from the waist gangway (shore side) down to THE LANDING rock (deck 2.6 m) → BOARDWALK → the beach.
//   · CASTAWAY CAMP on the east beach: bonfire, sailcloth tent (chests), HUT A (beach), HUT B (terrace), LOOKOUT tower.
//   · THE HEADLAND: sculpted rocks + a waterfall on the east; boulders, cargo spill, a longboat, palms = beach cover.
import type { Box, Surface } from "../world/colliders";
import { furnishRoom, interiorColliders, itemColliders, itemRect, type InteriorRoom, type InteriorLayout, type InteriorItem, type RoomOpening, type Side } from "./interior-kit";
import * as dmath from "../sim/dmath";

export type V3 = [number, number, number];
export const CX = 40, CZ = -700;

// ================================================================================================ the galleon frame
/** bow direction (world xz), shore side = local −z */
const BOW = (() => { const a = 141 * Math.PI / 180; return [dmath.cos(a), dmath.sin(a)] as [number, number]; })();
export const SHIP = {
  x: 48, z: -689,
  /** the frame's origin height: the wreck sits 0.85 m proud (the whole hold floor stays above the sea, ≥ 0.1 m at its lowest corner) */
  y: 0.85,
  /** three.js yaw: local +x → world (cos, 0, −sin) */
  yaw: dmath.atan2(-BOW[1], BOW[0]),
  /** list (rad): the shore side (local −z) goes down */
  roll: 9 * Math.PI / 180,
  /** trim (rad): settled by the stern — the bow rises (a raised bowsprit), the stern hold floods */
  pitch: 3.2 * Math.PI / 180,
};
/** shore side sign in the ship frame */
export const SH = -1;
/** deck levels (floor TOP, world height on the centreline) */
export const LV = { keel: -3.6, hold: 0.9, gun: 4.1, main: 7.3, qd: 10.5, poop: 13.7, fc: 10.5 };
/** floor slab thickness */
export const SLAB = 0.3;
/** bulwark / rail height above a deck */
export const RAIL = 1.05;
/** hull ends (x) and extents */
export const HULL = { stern: -18, bow: 18, half: 5.5, qdFront: -7, poopFront: -12.5, fcAft: 9, bowsprit: 11 };
/** masts: x along the hull, height of the truck (world y on the centreline, before the list), yard heights */
export const MASTS = [
  { id: "fore", x: 12.2, top: 31.5, r: 0.4, yards: [18.4, 25.2] },
  { id: "main", x: -1.0, top: 34, r: 0.48, yards: [31] },
  { id: "mizzen", x: -10.2, top: 25, r: 0.34, yards: [20.5] },
] as const;
/** the main course yard, fallen onto the waist (ship frame, a → b), radius ~0.2 */
export const FALLEN_YARD = { a: [4.6, 7.65, 1.6] as V3, b: [-3.5, 8.55, 4.9] as V3 };
/** the quarter galleries (enclosed stern balconies) bulging off both quarters, aft of the great cabin's side windows */
export const QGAL = { x0: -17.95, x1: -16.15, y0: 7.5, y1: 10.8, out: 0.75 };
/** the crow's nest ring on the mainmast */
export const NEST = { y: 21.6, rIn: 1.86, rOut: 2.95 };
/** spiral peg stair around the mainmast */
export const SPIRAL = { rise: 0.3, perTurn: 12, rIn: 0.45, rOut: 1.8, a0: Math.PI * 0.5 };

const cY = dmath.cos(SHIP.yaw), sY = dmath.sin(SHIP.yaw);
/** roll angle of the ship frame about its x axis (three.js Rx): ρ = SH·roll lowers the shore side (local −z) and leans
 *  the rig toward the shore. The trim PITCH = SHIP.pitch raises the bow (Rz). The client's ship matrix is
 *  T(SHIP.x, 0, SHIP.z) · Ry(SHIP.yaw) · Rx(RHO) · Rz(PITCH) (= three.js Euler(RHO, yaw, PITCH, "YXZ")). */
export const RHO = SH * SHIP.roll;
export const PITCH = SHIP.pitch;
const cr = dmath.cos(RHO), sr = dmath.sin(RHO), cp = dmath.cos(PITCH), spt = dmath.sin(PITCH);
/** ship frame → world */
export function shipToWorld(x: number, y: number, z: number): V3 {
  const x0 = x * cp - y * spt, y0 = x * spt + y * cp;         // Rz(pitch): the bow up
  const y1 = y0 * cr - z * sr, z1 = y0 * sr + z * cr;          // Rx(ρ)
  return [SHIP.x + x0 * cY + z1 * sY, SHIP.y + y1, SHIP.z - x0 * sY + z1 * cY]; // Ry(yaw)
}
/** world yaw (three.js) of a ship-frame local yaw (the list is small: yaws compose) */
export const shipYaw = (localYaw: number) => SHIP.yaw + localYaw;

// ------------------------------------------------------------------------------------------------ hull shape
/** half-breadth in plan (above the bilge) at x */
export function hbPlan(x: number): number {
  const H = HULL.half;
  if (x < -13) { const t = (x - HULL.stern) / 5; return H * (0.76 + 0.24 * dmath.sin(Math.min(1, Math.max(0, t)) * Math.PI / 2)); }
  if (x <= 5) return H;
  const t = Math.min(1, (x - 5) / 13);
  return H * dmath.pow(Math.max(0, 1 - t * t), 0.55);
}
/** the bow stem rakes forward (a long raked stem above the waterline, the galleon's beak): where the hull ends at y */
export const bowEnd = (y: number) => 11.5 + 7.0 * dmath.pow(Math.min(1, Math.max(0, (y - LV.keel) / (LV.main - LV.keel))), 0.8);
/** the stern: flat transom above the hold floor, the run sweeps up under it */
export const sternEnd = (y: number) => HULL.stern + 3.2 * dmath.pow(Math.max(0, (LV.hold - y) / (LV.hold - LV.keel)), 1.4);
/** full hull half-breadth at (x, y): plan × bilge round × slight tumblehome above the main deck */
export function hb(x: number, y: number): number {
  const x0 = sternEnd(y), x1 = bowEnd(y);
  if (x < x0 - 1e-6 || x > x1 + 1e-6) return 0;
  // re-map x into the plan's range so the bow keeps its shape as the stem rakes
  const xp = x > 5 ? 5 + (x - 5) * (HULL.bow - 5) / Math.max(0.1, x1 - 5) : x < -13 ? HULL.stern + (x - x0) * 5 / Math.max(0.1, -13 - x0) : x;
  let k = 1;
  if (y < LV.hold) { const u = (LV.hold - y) / (LV.hold - LV.keel); k = Math.sqrt(Math.max(0, 1 - u * u * u)) ; }
  // tumblehome: the sides lean in above the waterline (widest at the gun deck, ~9 % narrower at the castle rails)
  else if (y > LV.gun) k = 1 - 0.09 * dmath.pow(Math.min(1, (y - LV.gun) / (LV.poop + RAIL - LV.gun)), 1.2);
  return hbPlan(xp) * k;
}
/** the sheer (top of the hull side) at x */
export function sheer(x: number): number {
  if (x < HULL.poopFront) return LV.poop + RAIL;
  if (x < HULL.qdFront) return LV.qd + RAIL;
  if (x < HULL.fcAft) return LV.main + RAIL;
  return LV.fc + RAIL;
}
/** the galleon's sheer sweep: the bulwark planking climbs toward the stem (a tall beak bulwark) and the taffrail (the
 *  carved stern) above the stepped castle rails — drawn by the shell AND solid (sheerRiseWalls) */
export function sheerRise(x: number): number {
  if (x > 13) return 1.3 * dmath.pow(Math.min(1, (x - 13) / 5), 1.6);
  if (x < -16) return 0.9 * dmath.pow(Math.min(1, (-16 - x) / 2), 1.5);
  return 0;
}
export const sheerV = (x: number) => sheer(x) + sheerRise(x);

// ================================================================================================ pieces
export interface WPiece {
  /** visual kind (client style key) */
  k: string;
  c: V3; h: V3;
  /** three.js yaw within its frame */
  yaw?: number;
  f: "ship" | "world";
  /** 0 = visual only, 1 = collider + visual, 2 = collider only */
  col: 0 | 1 | 2;
  surf?: Surface; noShoot?: boolean;
  /** visual tint override (hex) */
  tint?: string;
}
export const PIECES: WPiece[] = [];
const P = (p: WPiece) => { PIECES.push(p); return p; };
const S = (k: string, c: V3, h: V3, col: 0 | 1 | 2 = 1, yaw = 0, surf: Surface = "wood", o: Partial<WPiece> = {}) => P({ k, c, h, yaw, f: "ship", col, surf, ...o });
const Wd = (k: string, c: V3, h: V3, col: 0 | 1 | 2 = 1, yaw = 0, surf: Surface = "wood", o: Partial<WPiece> = {}) => P({ k, c, h, yaw, f: "world", col, surf, ...o });

/** an opening in a wall, in wall coordinates: u along the wall from its start, v = height above the wall's base */
export interface Opening { u0: number; u1: number; v0: number; v1: number; kind: "door" | "window" | "port" | "breach" | "gap" }
/** solid rectangles of a wall (length L, height H) around its openings (wall space) */
export function wallRects(L: number, H: number, ops: Opening[]): Array<[number, number, number, number]> {
  const out: Array<[number, number, number, number]> = [];
  const os = ops.filter((o) => o.u1 > 0 && o.u0 < L).map((o) => ({ ...o, u0: Math.max(0, o.u0), u1: Math.min(L, o.u1), v0: Math.max(0, o.v0), v1: Math.min(H, o.v1) })).sort((a, b) => a.u0 - b.u0);
  let u = 0;
  for (const o of os) {
    if (o.u0 > u + 1e-3) out.push([u, 0, o.u0, H]);
    if (o.v0 > 1e-3) out.push([o.u0, 0, o.u1, o.v0]);
    if (o.v1 < H - 1e-3) out.push([o.u0, o.v1, o.u1, H]);
    u = Math.max(u, o.u1);
  }
  if (u < L - 1e-3) out.push([u, 0, L, H]);
  return out;
}
/** wall between (ax, az) → (bx, bz) in a frame; y0..y1; thickness t centred on the line offset `inset` toward +normal */
function wall(frame: "ship" | "world", k: string, a: [number, number], b: [number, number], y0: number, y1: number, t: number, ops: Opening[] = [], col: 0 | 1 | 2 = 1, surf: Surface = "wood", inset = 0) {
  const dx = b[0] - a[0], dz = b[1] - a[1], L = dmath.hypot(dx, dz);
  if (L < 1e-3) return;
  const ux = dx / L, uz = dz / L, nx = -uz, nz = ux; // normal (left of a→b in xz)
  // three.js yaw so that local +x runs along the wall: (cos, −sin) = (ux, uz) → yaw = atan2(−uz, ux)
  const yaw = dmath.atan2(-uz, ux);
  for (const [u0, v0, u1, v1] of wallRects(L, y1 - y0, ops)) {
    const um = (u0 + u1) / 2, vm = (v0 + v1) / 2;
    const c: V3 = [a[0] + ux * um + nx * inset, y0 + vm, a[1] + uz * um + nz * inset];
    P({ k, c, h: [(u1 - u0) / 2, (v1 - v0) / 2, t / 2], yaw, f: frame, col, surf });
  }
}
/** a straight stair: treads are solid blocks from `yb` up to each tread top. Runs from the bottom (xb, zb) toward the
 *  top along (dx, dz) (unit), width w; the last riser meets the upper floor at yt. */
function stair(frame: "ship" | "world", k: string, bottom: [number, number], dir: [number, number], w: number, yb: number, yt: number, run = 0.3, surf: Surface = "wood") {
  const n = Math.max(2, Math.round((yt - yb) / 0.29));
  const rise = (yt - yb) / n;
  const yaw = dmath.atan2(-dir[1], dir[0]);
  for (let i = 1; i < n; i++) {
    const s = (i - 0.5) * run;
    const top = yb + i * rise;
    P({ k, c: [bottom[0] + dir[0] * s, (yb + top) / 2, bottom[1] + dir[1] * s], h: [run / 2, (top - yb) / 2, w / 2], yaw, f: frame, col: 1, surf });
  }
  return { n, rise, len: (n - 1) * run };
}

/** a ship stair inside a hatch: runs +x DOWN from the hatch's aft edge (top) toward its forward end */
function stairUnder(hl: Hole, yb: number, yt: number) {
  const n = Math.max(2, Math.round((yt - yb) / 0.29)), run = 0.3, len = (n - 1) * run;
  stair("ship", "stair", [hl.x0 + len, (hl.z0 + hl.z1) / 2], [-1, 0], 1.3, yb, yt, run);
}

// ------------------------------------------------------------------------------------------------ hull walls
/** x stations of the hull polylines (denser where the plan curves) */
const HX: number[] = (() => {
  const xs: number[] = [];
  for (let x = HULL.stern; x < -13; x += 1.25) xs.push(x);
  for (let x = -13; x < 5; x += 3) xs.push(x);
  for (let x = 5; x < 17.2; x += 1.2) xs.push(x);
  xs.push(17.2);
  return xs;
})();
/** hull-side openings per side: in (x0, x1, y0, y1) ship coords */
interface HullOpening { x0: number; x1: number; y0: number; y1: number; side: 1 | -1; kind: Opening["kind"] }
export const HULL_OPS: HullOpening[] = [];
{
  // gun ports along both sides of the gun deck (the cannons sit behind them)
  for (const x of [-13.5, -9.5, -5.5, -1.5, 2.5, 6.5, 10.5]) for (const side of [1, -1] as const)
    HULL_OPS.push({ x0: x - 0.45, x1: x + 0.45, y0: LV.gun + 0.62, y1: LV.gun + 1.38, side, kind: "port" });
  // great cabin + chart room + galley windows
  for (const x of [-15.5, -12, -9]) for (const side of [1, -1] as const) HULL_OPS.push({ x0: x - 0.5, x1: x + 0.5, y0: LV.main + 1.0, y1: LV.main + 1.9, side, kind: "window" });
  for (const x of [-16, -14]) for (const side of [1, -1] as const) HULL_OPS.push({ x0: x - 0.45, x1: x + 0.45, y0: LV.qd + 1.0, y1: LV.qd + 1.8, side, kind: "window" });
  for (const side of [1, -1] as const) HULL_OPS.push({ x0: 11.4, x1: 12.3, y0: LV.main + 1.0, y1: LV.main + 1.8, side, kind: "window" });
  // the waist gangway (the rope bridge lands here) — a gap in the shore-side bulwark
  // (2.4 m: a wide gangway)
  HULL_OPS.push({ x0: -0.2, x1: 2.2, y0: LV.main - 0.2, y1: LV.main + RAIL + 0.5, side: SH as 1 | -1, kind: "gap" });
  // the SEA-SIDE entry port: the boarding stair (BOARDING) climbs out of the deep water to it
  HULL_OPS.push({ x0: 3.0, x1: 4.8, y0: LV.main - 0.2, y1: LV.main + RAIL + 0.5, side: -SH as 1 | -1, kind: "gap" });
  // THE BREACH: torn planks in the hold's shore side (waders climb in from the shallows)
  HULL_OPS.push({ x0: -6.6, x1: -3.2, y0: LV.hold - 0.6, y1: LV.hold + 2.3, side: SH as 1 | -1, kind: "breach" });
  // hold scuttles (light)
  for (const x of [-11, 3, 8]) HULL_OPS.push({ x0: x - 0.3, x1: x + 0.3, y0: LV.hold + 1.3, y1: LV.hold + 1.8, side: -SH as 1 | -1, kind: "port" });
}
/** the hull side walls (collider + inner lining) between two heights, both sides, following the plan polyline */
function hullWalls(y0: number, y1: number, xa: number, xb: number, k = "lining") {
  for (const side of [1, -1] as const) for (let i = 0; i < HX.length - 1; i++) {
    const x0 = Math.max(xa, HX[i]), x1 = Math.min(xb, HX[i + 1]);
    if (x1 - x0 < 0.05) continue;
    const ym = (y0 + y1) / 2;
    const h0 = hb(x0, ym), h1 = hb(x1, ym);
    const a: [number, number] = [x0, side * h0], b: [number, number] = [x1, side * h1];
    const L = dmath.hypot(x1 - x0, h1 - h0);
    // openings on this segment (u measured from a along the segment ≈ x − x0 scaled)
    const ops: Opening[] = HULL_OPS.filter((o) => o.side === side && o.x1 > x0 && o.x0 < x1 && o.y1 > y0 && o.y0 < y1)
      .map((o) => ({ u0: (o.x0 - x0) * L / (x1 - x0), u1: (o.x1 - x0) * L / (x1 - x0), v0: o.y0 - y0, v1: o.y1 - y0, kind: o.kind }));
    // the wall's inside face is on the hull line: centre it 0.16 m inboard (normal of a→b points inboard when side = 1…)
    // left normal of a→b (x increasing) points +z: inboard is −z on the +z side, +z on the −z side
    wall("ship", k, a, b, y0, y1, 0.32, ops, 1, "wood", -0.16 * side);
  }
}

// ------------------------------------------------------------------------------------------------ floors
export interface Hole { x0: number; x1: number; z0: number; z1: number }
/** a deck: slab strips (≤ 2 m across the beam) inside the hull at level y between x0..x1, minus holes. `k` visual kind.
 *  Visual decks are drawn by the client from the hull outline (`deckOutline`) — the strips are collider-only (2). */
export interface Deck { id: string; y: number; x0: number; x1: number; holes: Hole[] }
export const DECKS: Deck[] = [];
function deck(id: string, y: number, x0: number, x1: number, holes: Hole[]) {
  DECKS.push({ id, y, x0, x1, holes });
  // x cells follow the hull stations so the strips stay inside the lining
  const xs = [x0, ...HX.filter((x) => x > x0 + 0.05 && x < x1 - 0.05), x1];
  for (let i = 0; i < xs.length - 1; i++) {
    const a = xs[i], b = xs[i + 1];
    const w = Math.min(hb(a, y - 0.2), hb(b, y - 0.2), hb((a + b) / 2, y - 0.2)) - 0.3;
    if (w < 0.4) continue;
    const n = Math.max(1, Math.ceil((2 * w) / 1.22));
    for (let j = 0; j < n; j++) {
      const z0 = -w + (2 * w * j) / n, z1 = -w + (2 * w * (j + 1)) / n;
      // split around holes (in x): collect x-intervals of this strip that are not inside any hole
      let segs: Array<[number, number]> = [[a, b]];
      for (const hl of holes) {
        if (hl.z1 <= z0 || hl.z0 >= z1) continue;
        // a hole that partially covers the strip across z: split the strip in z instead (rare — holes are aligned to strips)
        const next: Array<[number, number]> = [];
        for (const [s0, s1] of segs) {
          if (hl.x1 <= s0 || hl.x0 >= s1) { next.push([s0, s1]); continue; }
          if (hl.x0 > s0) next.push([s0, hl.x0]);
          if (hl.x1 < s1) next.push([hl.x1, s1]);
          // the part of the strip beside the hole (z outside it) stays solid
          if (hl.z0 > z0 + 0.05) { const za = z0, zb = hl.z0; S("floor", [(Math.max(s0, hl.x0) + Math.min(s1, hl.x1)) / 2, y - SLAB / 2, (za + zb) / 2], [(Math.min(s1, hl.x1) - Math.max(s0, hl.x0)) / 2, SLAB / 2, (zb - za) / 2], 2); }
          if (hl.z1 < z1 - 0.05) { const za = hl.z1, zb = z1; S("floor", [(Math.max(s0, hl.x0) + Math.min(s1, hl.x1)) / 2, y - SLAB / 2, (za + zb) / 2], [(Math.min(s1, hl.x1) - Math.max(s0, hl.x0)) / 2, SLAB / 2, (zb - za) / 2], 2); }
        }
        segs = next;
      }
      for (const [s0, s1] of segs) if (s1 - s0 > 0.05) S("floor", [(s0 + s1) / 2, y - SLAB / 2, (z0 + z1) / 2], [(s1 - s0) / 2 + 0.01, SLAB / 2, (z1 - z0) / 2 + 0.01], 2);
    }
  }
}

// ================================================================================================ the galleon layout
// hatches (holes) — aligned to the 2 m strips' centre where possible
export const HATCH_MAIN: Hole = { x0: 0.7, x1: 4.9, z0: -1.15, z1: 1.15 };   // main → gun deck (stair runs +x down)
export const HATCH_GUN: Hole = { x0: -6.2, x1: -1.9, z0: -1.15, z1: 1.15 };   // gun → hold (stair runs +x down)

{
  const H = HULL;
  // ---- floors
  deck("hold", LV.hold, -15.8, 14.6, []);
  deck("gun", LV.gun, -17.4, 16.3, [HATCH_GUN]);
  deck("main", LV.main, -17.6, 17.2, [HATCH_MAIN]);
  deck("qd", LV.qd, -17.6, H.qdFront, []);
  deck("poop", LV.poop, -17.6, H.poopFront, []);
  deck("fc", LV.fc, H.fcAft, 17.4, []);
  // ---- the bilge: solid below the hold floor (swimmers / waders bump the hull, nothing to fall into). Columns ≤ 1.7 m
  // across the beam (the frame is listed: a wide flat-topped box would poke through the low side of the hold floor), each
  // from where the round bilge reaches it up to the underside of the hold floor
  for (let i = 0; i < HX.length - 1; i++) {
    const a = HX[i], b = HX[i + 1], xm = (a + b) / 2, yTop = LV.hold - SLAB;
    const w = Math.min(hb(a, yTop), hb(b, yTop), hb(xm, yTop));
    if (w < 0.3) continue;
    // 0.6 m columns seated where the hull is as wide as the column's MIDDLE (1.7 m columns seated at
    // their inner edge stand up to 0.9 m proud of the round bilge: an invisible wall under the waterline)
    const n = Math.max(1, Math.ceil((2 * w) / 0.6));
    for (let j = 0; j < n; j++) {
      const z0 = -w + (2 * w * j) / n, z1 = -w + (2 * w * (j + 1)) / n, zr = Math.abs((z0 + z1) / 2);
      // lowest y where the hull is still at least zr wide (bisection on the round bilge)
      let lo = LV.keel, hi = yTop;
      for (let k = 0; k < 18; k++) { const m = (lo + hi) / 2; if (Math.min(hb(a, m), hb(b, m), hb(xm, m)) >= zr) hi = m; else lo = m; }
      const y0 = Math.max(LV.keel, hi);
      if (yTop - y0 < 0.05) continue;
      S("bilge", [xm, (y0 + yTop) / 2, (z0 + z1) / 2], [(b - a) / 2, (yTop - y0) / 2, (z1 - z0) / 2], 2);
    }
  }
  // ---- the sealed ends of the hold level (aft of the hold's stern bulkhead, forward of the forepeak) are solid
  // (kind "endfill": cut into listed cells like every ship box — its top meets the gun deck's underside across the beam)
  for (const [x0, x1] of [[HULL.stern, -15.75], [14.7, 17.2]] as Array<[number, number]>) {
    const w = Math.max(hb(x0 + 0.3, 2), hb(x1 - 0.3, 2)) + 0.1;
    S("endfill", [(x0 + x1) / 2, (LV.hold - SLAB + LV.gun - SLAB) / 2, 0], [(x1 - x0) / 2, (LV.gun - LV.hold) / 2, w], 2);
  }
  // ---- hull side walls: hold → gun → main (up to the bulwark top), castles to their sheer
  hullWalls(LV.hold, LV.gun, -15.8, 14.6);
  hullWalls(LV.gun, LV.main, -17.6, 16.4);
  hullWalls(LV.main, LV.main + RAIL, H.qdFront, H.fcAft);               // waist bulwark
  hullWalls(LV.main, LV.qd + RAIL, H.poopFront, H.qdFront);             // QD: cabin walls + QD rail
  hullWalls(LV.main, LV.poop + RAIL, H.stern, H.poopFront);             // poop: 2 cabins + poop rail
  hullWalls(LV.main, LV.fc + RAIL, H.fcAft, 17.3);                      // forecastle: galley + FC rail
  // ---- the quarter galleries (solid outside the hull; drawn by the client)
  for (const side of [1, -1]) {
    const q = QGAL, w = hb((q.x0 + q.x1) / 2, (q.y0 + q.y1) / 2);
    S("qgal", [(q.x0 + q.x1) / 2, (q.y0 + q.y1) / 2 + 0.2, side * (w + q.out / 2 - 0.05)], [(q.x1 - q.x0) / 2, (q.y1 - q.y0) / 2 + 0.2, q.out / 2], 2);
  }
  // ---- the sheer sweep bulwarks (bow + stern) above the castle rails: 0.4 m wall pieces on the hull line, each as tall as
  // the sweep at its centre (the drawn top edge within ±0.12 m)
  for (const side of [1, -1] as const) for (const [xa, xb] of [[13.0, 17.3], [HULL.stern, -16.0]] as Array<[number, number]>) {
    for (let x0 = xa; x0 < xb - 1e-3; x0 += 0.4) {
      const x1 = Math.min(xb, x0 + 0.4), xm = (x0 + x1) / 2, r = sheerRise(xm);
      if (r < 0.06) continue;
      const y0 = sheer(xm), y1 = y0 + r, ym = (y0 + y1) / 2;
      const a: [number, number] = [x0, side * hb(x0, ym)], b: [number, number] = [x1, side * hb(x1, ym)];
      wall("ship", "sweep", a, b, y0, y1, 0.32, [], 1, "wood", -0.16 * side);
    }
  }
  // ---- the transom (stern) with the stern gallery windows (great cabin + chart room)
  {
    const x = H.stern + 0.16, w = hb(H.stern + 0.2, LV.main + 1);
    const ops: Opening[] = [];
    for (const u of [-3.2, -1.1, 1.1, 3.2]) ops.push({ u0: w + u - 0.55, u1: w + u + 0.55, v0: 1.0, v1: 2.0, kind: "window" });
    for (const u of [-2.2, 0, 2.2]) ops.push({ u0: w + u - 0.5, u1: w + u + 0.5, v0: LV.qd - LV.main + 1.0, v1: LV.qd - LV.main + 1.8, kind: "window" });
    wall("ship", "transom", [x, -w], [x, w], LV.main, LV.poop + RAIL, 0.32, ops);
    // the taffrail over the transom (the stern sweep's top edge)
    { const wt = hb(H.stern + 0.2, LV.poop + RAIL + 0.4); wall("ship", "transom", [x, -wt], [x, wt], LV.poop + RAIL, LV.poop + RAIL + sheerRise(HULL.stern), 0.32); }
    // below the cabins: the gun room's stern (solid, two stern-chaser ports)
    wall("ship", "transom", [x + 0.2, -w], [x + 0.2, w], LV.gun, LV.main - SLAB, 0.32, [{ u0: w - 2.4, u1: w - 1.5, v0: 0.62, v1: 1.38, kind: "port" }, { u0: w + 1.5, u1: w + 2.4, v0: 0.62, v1: 1.38, kind: "port" }]);
    wall("ship", "transom", [-15.9, -hb(-15.9, 2)], [-15.9, hb(-15.9, 2)], LV.hold, LV.gun - SLAB, 0.3);
  }
  // ---- bow: the forepeak bulkheads close the tapered ends of the lower decks
  wall("ship", "panel", [14.6, -hb(14.6, 2)], [14.6, hb(14.6, 2)], LV.hold, LV.gun - SLAB, 0.25);
  // ---- great cabin front bulkhead (x = qdFront) with a door + 2 windows; chart room front (poopFront) with a door
  {
    const x = H.qdFront - 0.12, w = hb(x, LV.main + 1) - 0.25;
    wall("ship", "panel", [x, -w], [x, w], LV.main, LV.qd - SLAB, 0.24, [
      { u0: w - 0.65, u1: w + 0.65, v0: 0, v1: 2.25, kind: "door" },
      { u0: w - 3.0, u1: w - 2.0, v0: 1.0, v1: 1.9, kind: "window" }, { u0: w + 2.0, u1: w + 3.0, v0: 1.0, v1: 1.9, kind: "window" },
    ]);
    const x2 = H.poopFront - 0.12, w2 = hb(x2, LV.qd + 1) - 0.25;
    wall("ship", "panel", [x2, -w2], [x2, w2], LV.qd, LV.poop - SLAB, 0.24, [
      { u0: w2 + 0.2, u1: w2 + 1.5, v0: 0, v1: 2.25, kind: "door" },
      { u0: w2 - 2.6, u1: w2 - 1.6, v0: 1.0, v1: 1.8, kind: "window" },
    ]);
    // galley aft bulkhead (x = fcAft) with a door + a window
    const x3 = H.fcAft + 0.12, w3 = hb(x3, LV.main + 1) - 0.25;
    wall("ship", "panel", [x3, -w3], [x3, w3], LV.main, LV.fc - SLAB, 0.24, [
      { u0: w3 - 0.65, u1: w3 + 0.65, v0: 0, v1: 2.25, kind: "door" },
      { u0: w3 + 2.0, u1: w3 + 2.9, v0: 1.0, v1: 1.8, kind: "window" },
    ]);
  }
  // ---- deck-edge rails (breastwork) at the castle fronts, with gaps where the stairs arrive
  {
    const railX = (x: number, y: number, gaps: Array<[number, number]>) => {
      const w = hb(x, y + 0.5) - 0.3;
      const ops: Opening[] = gaps.map(([z0, z1]) => ({ u0: z0 + w, u1: z1 + w, v0: 0, v1: RAIL + 1, kind: "gap" as const }));
      wall("ship", "rail", [x, -w], [x, w], y, y + RAIL, 0.18, ops);
    };
    railX(H.qdFront + 0.09, LV.qd, [[-5.25, -3.95], [3.95, 5.25]]);
    railX(H.poopFront + 0.09, LV.poop, [[4.0 * -SH - 0.65, 4.0 * -SH + 0.65].sort((a, b) => a - b) as [number, number]]);
    railX(H.fcAft - 0.09, LV.fc, [[-5.0, -3.7], [3.7, 5.0]]);
  }
  // ---- stairs: main ↔ QD (both sides), QD ↔ poop (far side), main ↔ FC (both sides)
  for (const s of [1, -1]) stair("ship", "stair", [H.qdFront + 2.75, s * 4.6], [-1, 0], 1.2, LV.main, LV.qd);
  stair("ship", "stair", [H.poopFront + 2.75, -SH * 4.0], [-1, 0], 1.2, LV.qd, LV.poop);
  for (const s of [1, -1]) stair("ship", "stair", [H.fcAft - 2.75, s * 4.35], [1, 0], 1.2, LV.main, LV.fc);
  // a balustrade on each side stair's open (inboard) edge — turned-baluster stair rails. The
  // collider is a thin wall flush with the stair block's side face, one cell per step from the deck to 0.95 m over the
  // tread (the stair keeps its full clear width; the client draws stringer + balusters + handrail at the same face)
  const stairRail = (bx: number, zEdge: number, dx: number, yb: number, yt: number) => {
    const n = Math.max(2, Math.round((yt - yb) / 0.29)), rise = (yt - yb) / n;
    for (let i = 1; i < n; i++) { const top = yb + i * rise; P({ k: "srail", c: [bx + dx * (i - 0.5) * 0.3, (yb + top + 0.95) / 2, zEdge], h: [0.15, (top + 0.95 - yb) / 2, 0.05], yaw: dmath.atan2(0, dx), f: "ship", col: 1, surf: "wood" }); }
  };
  for (const s of [1, -1]) stairRail(H.qdFront + 2.75, s * (4.6 - 0.6 - 0.05), -1, LV.main, LV.qd);
  stairRail(H.poopFront + 2.75, -SH * (4.0 - 0.6 - 0.05), -1, LV.qd, LV.poop);
  for (const s of [1, -1]) stairRail(H.fcAft - 2.75, s * (4.35 - 0.6 - 0.05), 1, LV.main, LV.fc);
  // main → gun (in the main hatch: top at the hatch's aft edge, running +x down) and gun → hold
  // (the top tread meets the hatch's aft edge; the rest of the opening is headroom over the stair's foot)
  stairUnder(HATCH_MAIN, LV.gun, LV.main);
  stairUnder(HATCH_GUN, LV.hold, LV.gun);
  // hatch coamings (low lips on the three open sides, stepped over; the stair's top side stays open)
  for (const [hl, y] of [[HATCH_MAIN, LV.main], [HATCH_GUN, LV.gun]] as Array<[Hole, number]>) {
    S("coaming", [hl.x1 + 0.08, y + 0.12, 0], [0.08, 0.12, (hl.z1 - hl.z0) / 2 + 0.16], 1);
    for (const s of [1, -1]) S("coaming", [(hl.x0 + hl.x1) / 2 + 0.08, y + 0.12, s * (hl.z1 + 0.08)], [(hl.x1 - hl.x0) / 2 + 0.08, 0.12, 0.08], 1);
  }
  // ---- masts (solid through every deck they pass) + the mainmast spiral + the crow's nest ring
  // (the masts lean with the list: one collider per 1.5 m so each follows the leaning axis within a few cm)
  for (const m of MASTS) {
    const yb = LV.hold, seg = 1.5, n = Math.ceil((m.top - yb) / seg);
    for (let i = 0; i < n; i++) {
      const y0 = yb + i * seg, y1 = Math.min(m.top, y0 + seg), t = ((y0 + y1) / 2 - yb) / (m.top - yb);
      const hh = 0.72 * m.r * (1 - 0.38 * t);
      S("mast", [m.x, (y0 + y1) / 2, 0], [hh, (y1 - y0) / 2 + 0.02, hh], 1, 0, "wood");
    }
  }
  {
    const mm = MASTS[1];
    const n = Math.round((NEST.y - LV.main) / SPIRAL.rise);
    const rise = (NEST.y - LV.main) / n, da = (Math.PI * 2) / SPIRAL.perTurn;
    const rm = (SPIRAL.rIn + SPIRAL.rOut) / 2, hr = (SPIRAL.rOut - SPIRAL.rIn) / 2;
    for (let i = 1; i < n; i++) {
      const a = SPIRAL.a0 + i * da, top = LV.main + i * rise;
      // tread: radial board (local x = radial), thin, 0.36 m wide (tangential)
      S("peg", [mm.x + dmath.cos(a) * rm, top - 0.06, dmath.sin(a) * rm], [hr, 0.06, 0.26], 1, -a, "wood");
      // the outer guard rail (rope + stanchions): a kong running round the spiral slides along it instead of flying off
      // (open for the first 2 treads = the way on, and the last 3 = the way off onto the nest ring)
      if (i > 2 && i < n - 3) S("spiralrail", [mm.x + dmath.cos(a) * (SPIRAL.rOut + 0.06), top + 0.55, dmath.sin(a) * (SPIRAL.rOut + 0.06)], [0.04, 0.55, 0.42], 1, -a, "wood", { noShoot: true });
    }
    // the nest ring: 10 boards around the mast between rIn and rOut (the spiral comes up inside it)
    const NS = 10;
    for (let i = 0; i < NS; i++) {
      const a = (i + 0.5) * (Math.PI * 2) / NS, r = (NEST.rIn + NEST.rOut) / 2;
      const half = dmath.tan(Math.PI / NS) * NEST.rOut + 0.05;
      S("nest", [mm.x + dmath.cos(a) * r, NEST.y - 0.1, dmath.sin(a) * r], [(NEST.rOut - NEST.rIn) / 2, 0.1, half], 1, -a);
      // rail (1.05 m) on the outer edge
      S("nestrail", [mm.x + dmath.cos(a) * (NEST.rOut - 0.06), NEST.y + RAIL / 2, dmath.sin(a) * (NEST.rOut - 0.06)], [0.06, RAIL / 2, half], 1, -a);
    }
    // the landing board where the last tread meets the ring
    const aL = SPIRAL.a0 + n * da;
    S("nest", [mm.x + dmath.cos(aL) * rm, NEST.y - 0.1, dmath.sin(aL) * rm], [hr, 0.1, 0.32], 1, -aL);
  }
  // ---- the bowsprit (visual; a thin collider so bullets hit it)
  // ---- furniture & cover (ship frame): cannons on the gun deck, cargo in the hold, cabin furniture, deck cargo
  const cannon = (x: number, y: number, side: number, k = "cannon") => {
    const w = hb(x, y + 1) - 0.3;
    // (top 0.74 m — between the drawn cheeks 0.64 and the barrel 0.82, both within 0.1 m; width to the wheels)
    S(k, [x, y + 0.37, side * (w - 1.05)], [0.5, 0.37, 1.0], 1, 0, "metal");
    // a shot locker beside every gun (cannonballs, powder): dressing + a knee-high step onto the gun (no jump-only top)
    S("shotbox", [x + 0.95, y + 0.225, side * (w - 1.5)], [0.3, 0.225, 0.38], 1);
  };
  for (const x of [-13.5, -9.5, -5.5, -1.5, 2.5, 6.5, 10.5]) for (const s of [1, -1]) if (!(x === -5.5 && s === SH) && !(x === 2.5 && s === -SH)) cannon(x, LV.gun, s);
  // (the cabins, the gun deck and the hold are furnished with the shared interiors kit — SHIP_ROOMS below; what stays
  //  here is the ship's own gear: the cargo in the waist of the hold, the stanchions)
  // headroom is 2.9 m: a prop is either ≤ 0.84 m — stand on it without touching the deck head — or a stack to the deck head
  const CEIL = (lvl: number) => { void lvl; return (3.2 - SLAB) / 2; }; // half height of a floor-to-ceiling stack
  // hold waist (x −8.4 … 6.6, between the two crew rooms): cargo stacks = L cover round the breach + the stair foot
  S("crates", [-7.2, LV.hold + CEIL(LV.hold), 3.2], [0.8, CEIL(LV.hold), 0.9], 1);
  S("crates", [-7.0, LV.hold + 0.42, -2.6], [0.7, 0.42, 0.8], 1);
  S("barrels", [1.6, LV.hold + 0.42, 2.9], [1.1, 0.42, 0.6], 1);
  S("barrels", [4.6, LV.hold + CEIL(LV.hold), -3.0], [1.1, CEIL(LV.hold), 0.62], 1);
  S("crates", [4.4, LV.hold + CEIL(LV.hold), 3.0], [0.8, CEIL(LV.hold), 0.8], 1);
  S("sacks", [-1.0, LV.hold + 0.38, -3.2], [0.9, 0.38, 0.6], 1);
  for (const x of [-8, 6]) S("stanchion", [x, (LV.hold + LV.gun - SLAB) / 2, 0], [0.16, (LV.gun - SLAB - LV.hold) / 2, 0.16], 1);
  // main deck cargo (cover in the waist) + the ship's wheel on the QD + deck cannons
  S("crates", [-5.6, LV.main + 0.6, SH * 3.0], [0.75, 0.6, 0.75], 1);
  S("barrels", [5.8, LV.main + 0.55, -SH * 3.1], [0.6, 0.55, 1.1], 1);
  S("crates", [6.4, LV.main + 0.45, SH * 2.2], [0.55, 0.45, 0.55], 1);
  S("capstan", [-4.6, LV.main + 0.55, 0], [0.55, 0.55, 0.55], 1);
  S("wheel", [-9.0, LV.qd + 0.8, 0], [0.25, 0.8, 0.8], 1);
  cannon(-10.6, LV.qd, SH, "deckgun");
  S("crates", [-15.9, LV.poop + 0.45, -SH * 3.0], [0.5, 0.45, 0.5], 1);
  S("barrels", [15.0, LV.fc + 0.5, 0], [0.5, 0.5, 0.5], 1);
  // the fallen main course yard across the waist (collides in 4 segments: step over its low end, vault the rest)
  {
    const [ax, ay, az] = FALLEN_YARD.a, [bx, by, bz] = FALLEN_YARD.b;
    const yaw = dmath.atan2(-(bz - az), bx - ax), L = dmath.hypot(bx - ax, bz - az);
    for (let i = 0; i < 4; i++) {
      const t0 = i / 4, t1 = (i + 1) / 4, tm = (t0 + t1) / 2;
      const top = ay + (by - ay) * t1 + 0.2;
      S("yardcol", [ax + (bx - ax) * tm, (LV.main + top) / 2, az + (bz - az) * tm], [L / 8, (top - LV.main) / 2, 0.22], 2, yaw);
    }
  }
}

// ================================================================================================ world-frame structures
/** the gangway point on the ship (where the rope bridge meets the bulwark gap) */
export const GANGWAY: V3 = shipToWorld(1.0, LV.main, SH * (hbPlan(1) - 0.05));
/** THE LANDING: a flat-topped rock in the shallows with a plank platform + the bridge A-frame */
export const LANDING = { x: 64.0, z: -668.0, top: 3.4, hx: 2.6, hz: 2.2, yaw: 0.35 };
/** the rope bridge planks (world): from the landing's platform edge up to the gangway, sagging */
export interface Plank { x: number; y: number; z: number; yaw: number; len: number }
export const BRIDGE: { planks: Plank[]; a: V3; b: V3; w: number } = (() => {
  const cy = dmath.cos(LANDING.yaw), sy = dmath.sin(LANDING.yaw);
  void cy; void sy;
  const b: V3 = GANGWAY;
  // start: the landing's north-west edge, toward the ship
  const dirx = b[0] - LANDING.x, dirz = b[2] - LANDING.z, dl = dmath.hypot(dirx, dirz);
  const a: V3 = [LANDING.x + (dirx / dl) * 1.9, LANDING.top, LANDING.z + (dirz / dl) * 1.9];
  const L = dmath.hypot(b[0] - a[0], b[2] - a[2]);
  const n = Math.round(L / 0.42);
  const yaw = dmath.atan2(-(b[2] - a[2]), b[0] - a[0]);
  const planks: Plank[] = [];
  const sag = 0.18;   // (a taut, sure-footed gangway, not a wobbly rope bridge)
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const y = a[1] + (b[1] - a[1]) * t - sag * 4 * t * (1 - t);
    planks.push({ x: a[0] + (b[0] - a[0]) * t, y, z: a[2] + (b[2] - a[2]) * t, yaw, len: L / n });
  }
  return { planks, a, b, w: 2.3 };
})();
{
  // bridge colliders: plank runs merged per ~0.85 m (top = the mean plank top), rope-rail walls (players only)
  const pl = BRIDGE.planks;
  for (let i = 0; i < pl.length - 1; i += 2) {
    const j = Math.min(pl.length - 1, i + 2);
    const x = (pl[i].x + pl[j].x) / 2, z = (pl[i].z + pl[j].z) / 2, y = (pl[i].y + pl[j].y) / 2;
    const len = dmath.hypot(pl[j].x - pl[i].x, pl[j].z - pl[i].z) + 0.42;
    Wd("bridgecol", [x, y - 0.06, z], [len / 2, 0.06, BRIDGE.w / 2], 2, pl[i].yaw);
    for (const s of [1, -1]) {
      const nx = -dmath.sin(pl[i].yaw) * 0 + dmath.sin(pl[i].yaw) * s * (BRIDGE.w / 2 + 0.05);
      const nz = dmath.cos(pl[i].yaw) * s * (BRIDGE.w / 2 + 0.05);
      Wd("ropewall", [x + nx, y + 0.5, z + nz], [len / 2, 0.5, 0.04], 2, pl[i].yaw, "fabric", { noShoot: true });
    }
  }
  // (0.44 m boards: a gangway deck, not a gappy rope bridge)
  for (const p of pl) Wd("plank", [p.x, p.y - 0.05, p.z], [0.22, 0.05, BRIDGE.w / 2], 0, p.yaw);
  // the landing rock (collider) + its platform + the A-frame posts + steps down to the boardwalk
  const L = LANDING;
  Wd("platform", [L.x, L.top - 0.12, L.z], [L.hx + 0.2, 0.12, L.hz + 0.2], 1, L.yaw);
}
/** the boardwalk from the landing to the beach: deck top, planks along the run */
export const BOARDWALK = { a: [65.7, -664.6] as [number, number], b: [64.2, -652.5] as [number, number], y: 1.25, w: 1.9 };
{
  // cover on the landing: a barrel pair on each of the two platform corners off the boardwalk → bridge line
  // (so the bridge's approach is no bare deck): the corners farthest from that line
  const L = LANDING, c = dmath.cos(L.yaw), sn = dmath.sin(L.yaw), A = BOARDWALK.a, Bq = BRIDGE.a;
  const ux = Bq[0] - A[0], uz = Bq[2] - A[1], ul = dmath.hypot(ux, uz);
  const off = (x: number, z: number) => Math.abs(((x - A[0]) * uz - (z - A[1]) * ux) / ul);
  const corners = [[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([sx, sz]) => { const lx = sx * (L.hx - 0.55), lz = sz * (L.hz - 0.55); return [L.x + lx * c + lz * sn, L.z - lx * sn + lz * c] as [number, number]; })
    .sort((p, q) => off(q[0], q[1]) - off(p[0], p[1])).slice(0, 2);
  for (const [x, z] of corners) Wd("barrels", [x, L.top + 0.55, z], [0.45, 0.55, 0.45], 1, L.yaw);
}
{
  const B = BOARDWALK, L = LANDING;
  const dx = B.b[0] - B.a[0], dz = B.b[1] - B.a[1], len = dmath.hypot(dx, dz), ux = dx / len, uz = dz / len;
  const yaw = dmath.atan2(-uz, ux);
  // deck (collider + visual) in 3 m sections (piles drawn by the client under each joint)
  const nSec = Math.ceil(len / 3);
  for (let i = 0; i < nSec; i++) {
    const s0 = (i * len) / nSec, s1 = ((i + 1) * len) / nSec, sm = (s0 + s1) / 2;
    Wd("bwdeck", [B.a[0] + ux * sm, B.y - 0.1, B.a[1] + uz * sm], [(s1 - s0) / 2 + 0.01, 0.1, B.w / 2], 1, yaw);
    // the piles the client draws at each section's start (r 0.13): inscribed colliders down into the seabed
    for (const sd of [-1, 1]) {
      const lx = -(s1 - s0) / 2 - 0.01 + 0.1, lz = sd * (B.w / 2 - 0.1), c = dmath.cos(yaw), sn = dmath.sin(yaw);
      Wd("pile", [B.a[0] + ux * sm + lx * c + lz * sn, (B.y - 0.2 - 3.5) / 2, B.a[1] + uz * sm - lx * sn + lz * c], [0.09, (B.y - 0.2 + 3.5) / 2, 0.09], 2, yaw);
    }
  }
  // steps from the boardwalk up onto the landing platform (the boardwalk end sits against the rock)
  stair("world", "wstair", [B.a[0] - ux * 0.2, B.a[1] - uz * 0.2], [-ux, -uz], B.w, B.y, L.top, 0.32);
  // steps down to the sand at the beach end
  const gy = 0.25;
  { const n = Math.max(2, Math.round((B.y - gy) / 0.29)), run = 0.34; stair("world", "wstair", [B.b[0] + ux * (n - 1) * run, B.b[1] + uz * (n - 1) * run], [-ux, -uz], B.w, gy, B.y, run); }
  // a boarding ladder of steps from the water on the east side (swimmers climb back up): 0.05 → 0.4 → 0.8 → deck
  const px = -uz, pz = ux, sm = len * 0.55;
  const bx = B.a[0] + ux * sm + px * (B.w / 2 + 0.5), bz = B.a[1] + uz * sm + pz * (B.w / 2 + 0.5);
  for (const [k, top] of [[0, 0.05], [1, 0.42], [2, 0.82]] as Array<[number, number]>) {
    const off = 1.05 - k * 0.3;
    Wd("wstair", [bx + px * (off - 0.5) , (top - 1.6) / 2, bz + pz * (off - 0.5)], [0.9, (top + 1.6) / 2, 0.16], 1, yaw);
  }
}

// ------------------------------------------------------------------------------------------------ ways on and off the galleon
/** nobody swims far: two more ways aboard besides the gangway bridge.
 *  · BOARDING — a plank stair on piles along the SEA side (the high side of the list), its lowest treads under the
 *    water: a swimmer who slid off the deck swims to it, steps onto a submerged tread (≤ STEP_H above the swim float
 *    height) and walks up to the new sea-side entry port in the waist bulwark (a brow bridges the tumblehome).
 *  · BREACH STEPS — spilled cargo crates stacked against the hold's shore-side breach: from the shallows up into the hold. */
const SEA_N: [number, number] = [sY, cY];          // world xz of the ship frame's +z (the sea side)
const KEEL: [number, number] = [cY, -sY];          // world xz of the ship frame's +x (toward the bow)
/** world offset of a point from the ship's centreline along SEA_N */
const seaOff = (w: V3) => (w[0] - SHIP.x) * SEA_N[0] + (w[2] - SHIP.z) * SEA_N[1];
const keelOff = (w: V3) => (w[0] - SHIP.x) * KEEL[0] + (w[2] - SHIP.z) * KEEL[1];
/** the boarding stair's hand ropes start at the first tread this high (world y): below it the stair is open on every side */
export const BOARD_RAIL_Y0 = 1.0;
export const BOARDING = (() => {
  const xTop = 3.0, W = 1.6, rise = 0.28, run = 0.3, yLow = -1.4;
  // the deck top at the port (world): the sea-side deck edge
  const edge = shipToWorld(xTop + 0.9, LV.main, hb(xTop + 0.9, LV.main) - 0.35);
  const yTop = edge[1];
  const n = Math.ceil((yTop - yLow) / rise);
  const len = n * run;
  // the hull's furthest reach toward the sea (world) over the stair's run, at any height the stair passes
  let out = 0;
  for (let x = xTop - len - 1; x <= xTop + 2; x += 0.5) for (let y = LV.keel; y <= LV.main + RAIL; y += 0.25) {
    const w = shipToWorld(x, y, hb(x, y)); if (w[1] > yLow - 0.5) out = Math.max(out, seaOff(w));
  }
  const cOff = out + 0.95 + W / 2;                  // stair centreline off the ship's centreline
  const k0 = keelOff(shipToWorld(xTop, yTop, 0));    // the stair's top end along the keel (world, ≈ the port's aft edge)
  const at = (k: number, o: number): [number, number] => [SHIP.x + KEEL[0] * k + SEA_N[0] * o, SHIP.z + KEEL[1] * k + SEA_N[1] * o];
  return { n, rise, run, W, yLow, yTop, cOff, k0, out, edgeOff: seaOff(edge), at };
})();
{
  const Bd = BOARDING, yaw = dmath.atan2(-KEEL[1], KEEL[0]);
  // treads: 0.24 m planks, the top one level with the deck; each overlaps the next by 2 cm
  for (let i = 0; i < Bd.n; i++) {
    const top = Bd.yTop - (Bd.n - 1 - i) * Bd.rise, k = Bd.k0 - (Bd.n - 1 - i) * Bd.run - Bd.run / 2;
    const [x, z] = Bd.at(k, Bd.cOff);
    Wd("wstair", [x, top - 0.12, z], [Bd.run / 2 + 0.01, 0.12, Bd.W / 2], 1, yaw);
  }
  // the brow: a plank deck from the stair's top tread across the tumblehome into the port (level with the deck)
  {
    const o0 = Bd.edgeOff - 0.25, o1 = Bd.cOff + Bd.W / 2, [x, z] = Bd.at(Bd.k0 + 0.9, (o0 + o1) / 2);
    Wd("towerfloor", [x, Bd.yTop - 0.1, z], [(o1 - o0) / 2, 0.1, 0.9], 1, yaw + Math.PI / 2);
    // rails round the brow: fore end (port → outer edge), outer edge, aft end only between the port and the stair's
    // inner edge (the stair arrives across the rest of the aft end)
    const railO = (k: number, a: number, b: number) => { const [rx, rz] = Bd.at(k, (a + b) / 2); Wd("towerrail", [rx, Bd.yTop + RAIL / 2, rz], [(b - a) / 2, RAIL / 2, 0.06], 1, yaw + Math.PI / 2); };
    railO(Bd.k0 + 1.74, o0 + 0.6, o1);
    railO(Bd.k0 + 0.06, o0 + 0.6, Bd.cOff - Bd.W / 2);
    { const [rx, rz] = Bd.at(Bd.k0 + 0.9, o1 - 0.06); Wd("towerrail", [rx, Bd.yTop + RAIL / 2, rz], [0.84, RAIL / 2, 0.06], 1, yaw); }
  }
  // hand ropes on both edges of the stair above the waterline (collider: a rope wall per tread, players only; the
  // client draws posts + ropes from BOARDING.rails) — the bottom treads stay open on every side: swimmers step on there
  for (let i = 0; i < Bd.n; i++) {
    const top = Bd.yTop - (Bd.n - 1 - i) * Bd.rise; if (top < BOARD_RAIL_Y0) continue;
    const k = Bd.k0 - (Bd.n - 1 - i) * Bd.run - Bd.run / 2;
    for (const e of [-1, 1]) { const [x, z] = Bd.at(k, Bd.cOff + e * (Bd.W / 2 + 0.04)); Wd("ropewall", [x, top + 0.55, z], [Bd.run / 2 + 0.01, 0.55, 0.04], 2, yaw, "fabric", { noShoot: true }); }
  }
  // piles down to the seabed under the stair (both edges, every ~3 m; the top third stands over a hull rock: none there)
  for (let i = 0; i < Bd.n * 0.72; i += 10) for (const e of [-1, 1]) {
    const top = Bd.yTop - (Bd.n - 1 - i) * Bd.rise - 0.24, k = Bd.k0 - (Bd.n - 1 - i) * Bd.run - Bd.run / 2;
    const [x, z] = Bd.at(k, Bd.cOff + e * (Bd.W / 2 - 0.12)), bot = -4.5;
    Wd("log", [x, (top + bot) / 2, z], [0.12, (top - bot) / 2, 0.12], 1, yaw);
  }
}
/** the breach steps: crates stacked from the seabed, each a step (0.3 m) lower than the last, outward from the hull */
export const BREACH_STEPS: Array<{ x: number; z: number; top: number }> = [];
{
  const xm = -4.9, floorW = shipToWorld(xm, LV.hold, -(hb(xm, LV.hold) - 0.3)), yaw = dmath.atan2(-KEEL[1], KEEL[0]);
  // the hull's shore-side reach (world, negative along SEA_N) between the waterline and the hold floor
  let out = 0;
  for (let y = LV.keel; y <= LV.hold + 0.4; y += 0.2) for (const x of [-6.4, -4.9, -3.4]) { const w = shipToWorld(x, y, -hb(x, y)); if (w[1] > -1.6 && w[1] < floorW[1] + 0.2) out = Math.min(out, seaOff(w)); }
  const kM = keelOff(shipToWorld(xm, LV.hold, 0));
  for (let i = 0; i < 7; i++) {
    const top = floorW[1] - 0.3 * (i + 1), o = out - 0.12 - 0.5 * (i + 0.5);
    if (top < -1.3) break;
    const [x, z] = [SHIP.x + KEEL[0] * kM + SEA_N[0] * o, SHIP.z + KEEL[1] * kM + SEA_N[1] * o];
    BREACH_STEPS.push({ x, z, top });
    // two crates side by side per step (≈ 1.2 m each, a hand's gap between: reads as spilled cargo, not a plank wall)
    for (const e of [-1, 1]) Wd("crates", [x + KEEL[0] * e * 0.63, (top - 4.0) / 2, z + KEEL[1] * e * 0.63], [0.6, (top + 4.0) / 2, 0.25], 1, yaw + e * 0.03);
  }
}

// ------------------------------------------------------------------------------------------------ the castaway camp
export interface Shack {
  id: string; x: number; z: number; yaw: number;
  /** floor top (world) */
  y: number;
  /** interior footprint (outer wall faces) */
  w: number; d: number;
  wallH: number; t: number;
  /** door on the front (+local z) at u (from the left end, metres) */
  doorU: number;
  /** windows: side (0 front +z, 1 right +x, 2 back −z, 3 left −x), u centre */
  windows: Array<[0 | 1 | 2 | 3, number]>;
  /** roof pitch rise (m) over the half-span; ridge along local x */
  rise: number;
  /** porch depth in front of the door (0 = none) and the steps down to the ground at groundY */
  porch: number; groundY: number;
  tint: string;
}
export const SHACKS: Shack[] = [
  { id: "hutA", x: 86.5, z: -646.2, yaw: 0.28, y: 1.45, w: 5.2, d: 4.2, wallH: 2.7, t: 0.22, doorU: 1.5, windows: [[0, 3.8], [1, 2.1], [3, 2.1], [2, 2.6]], rise: 1.5, porch: 1.8, groundY: 0.45, tint: "#c9a36b" },
  { id: "hutB", x: 94.5, z: -629.5, yaw: -0.12, y: 4.95, w: 4.8, d: 4.0, wallH: 2.7, t: 0.22, doorU: 3.4, windows: [[0, 1.2], [1, 2.0], [2, 2.4], [3, 2.0]], rise: 1.4, porch: 1.6, groundY: 4.25, tint: "#b79260" },
];
/** hut footprint → world (three yaw) */
export function shackToWorld(s: Shack, lx: number, lz: number): [number, number] {
  const c = dmath.cos(s.yaw), sn = dmath.sin(s.yaw);
  return [s.x + lx * c + lz * sn, s.z - lx * sn + lz * c];
}
function shack(s: Shack) {
  const hw = s.w / 2, hd = s.d / 2, T = s.t;
  const toW = (lx: number, lz: number) => shackToWorld(s, lx, lz);
  const wp = (k: string, lx: number, y: number, lz: number, h: V3, col: 0 | 1 | 2 = 1, yawL = 0, surf: Surface = "wood") => { const [x, z] = toW(lx, lz); Wd(k, [x, y, z], h, col, s.yaw + yawL, surf); };
  // floor (slab) + stilt skirt (solid below the floor down into the ground: nothing to crawl under)
  wp("hutfloor", 0, s.y - 0.1, 0, [hw + 0.05, 0.1, hd + 0.05]);
  wp("stiltskirt", 0, (s.y - 0.2 + s.groundY - 1.2) / 2, 0, [hw - 0.1, (s.y - 0.2 - (s.groundY - 1.2)) / 2, hd - 0.1], 2);
  // walls (local frame via wall() in world coords: build the four sides from corner points)
  const H = s.wallH;
  const sides: Array<{ a: [number, number]; b: [number, number]; side: 0 | 1 | 2 | 3; L: number }> = [
    { a: [-hw, hd - T / 2], b: [hw, hd - T / 2], side: 0, L: s.w },
    { a: [hw - T / 2, hd], b: [hw - T / 2, -hd], side: 1, L: s.d },
    { a: [hw, -hd + T / 2], b: [-hw, -hd + T / 2], side: 2, L: s.w },
    { a: [-hw + T / 2, -hd], b: [-hw + T / 2, hd], side: 3, L: s.d },
  ];
  for (const sd of sides) {
    const ops: Opening[] = [];
    if (sd.side === 0) ops.push({ u0: s.doorU - 0.6, u1: s.doorU + 0.6, v0: 0, v1: 2.2, kind: "door" });
    for (const [ws, u] of s.windows) if (ws === sd.side) ops.push({ u0: u - 0.55, u1: u + 0.55, v0: 1.0, v1: 1.85, kind: "window" });
    const [ax, az] = toW(...sd.a), [bx, bz] = toW(...sd.b);
    wall("world", "hutwall", [ax, az], [bx, bz], s.y, s.y + H, T, ops, 1, "wood");
  }
  // ceiling (flat, the roof space above is solid in collision: tiers approximate the pitched roof ±0.14 m)
  wp("ceiling", 0, s.y + H + 0.06, 0, [hw, 0.06, hd], 1);
  const ov = 0.45, tiers = 10, span = hd + ov;   // (10 tiers — the drawn pitch within ±0.08 m)
  for (const sg of [1, -1]) for (let i = 0; i < tiers; i++) {
    const z0 = (i / tiers) * span, z1 = ((i + 1) / tiers) * span, zm = (z0 + z1) / 2;
    const top = s.y + H + 0.12 + s.rise * (1 - zm / span);
    wp("rooftier", 0, (s.y + H + 0.12 + top) / 2, sg * zm, [hw + ov, (top - (s.y + H + 0.12)) / 2, (z1 - z0) / 2], 2, 0, "fabric");
  }
  // porch deck + steps down to the ground
  if (s.porch > 0) {
    wp("porch", 0, s.y - 0.1, hd + s.porch / 2, [hw, 0.1, s.porch / 2]);
    wp("stiltskirt", 0, (s.y - 0.2 + s.groundY - 1.2) / 2, hd + s.porch / 2, [hw - 0.3, (s.y - 0.2 - (s.groundY - 1.2)) / 2, s.porch / 2 - 0.2], 2);
    const c = dmath.cos(s.yaw), sn = dmath.sin(s.yaw);
    // the stair climbs from the ground toward the porch (−local z), its top at the porch's front edge, in line with the door
    const dirW: [number, number] = [-sn, -c];
    const n = Math.max(2, Math.round((s.y - (s.groundY - 0.15)) / 0.29)), run = 0.3;
    const [bx, bz] = toW(s.doorU - hw, hd + s.porch + (n - 1) * run);
    stair("world", "wstair", [bx, bz], dirW, 1.3, s.groundY - 0.15, s.y, run);
    // porch rail posts (visual) — the porch edge stays open (jump off)
  }
  // roof access: a staircase of stacked cargo crates against the +x gable end, its top level with the eave tier (the
  // roof tiers step 0.3 m up to the ridge) — every roof in the POI is reachable on foot
  {
    const eaveTop = s.y + H + 0.12 + s.rise * (1 - (0.9 * span) / span);
    const n = Math.max(3, Math.ceil((eaveTop - s.groundY) / 0.5)), rise = (eaveTop - s.groundY) / n, run = 0.62;
    for (let i = 0; i < n; i++) {
      const top = s.groundY + (i + 1) * rise, lz = span - 0.35 - (n - 1 - i) * run;
      // the stack stands 0.55 m clear of the eave (a kong on a step never gets its head under the roof); the top step
      // reaches in to the roof edge
      const last = i === n - 1, x0 = last ? hw + ov - 0.05 : hw + ov + 0.55, x1 = hw + ov + 1.55;
      wp("crates", (x0 + x1) / 2, (top + s.groundY - 1.0) / 2, lz, [(x1 - x0) / 2, (top - s.groundY + 1.0) / 2, run / 2], 1);
    }
  }
  // (interior furniture: the shared interiors kit — INTERIOR_ROOMS)
}
for (const s of SHACKS) shack(s);

/** the lookout tower: two platforms on four log legs (outside the floor corners); an outside stair along its +x side
 *  climbs to L1, an inside stair along −x (under a hole in L2) climbs to L2; a plank canopy tops it */
export const TOWER = { x: 104.5, z: -642.5, yaw: 0.35, g: 1.2, w: 5.0, l1: 4.4, l2: 7.6, roof: 11.0 };
export function towerToWorld(lx: number, lz: number): [number, number] {
  const c = dmath.cos(TOWER.yaw), sn = dmath.sin(TOWER.yaw);
  return [TOWER.x + lx * c + lz * sn, TOWER.z - lx * sn + lz * c];
}
{
  const T = TOWER, hw = T.w / 2;
  const c = dmath.cos(T.yaw), sn = dmath.sin(T.yaw);
  const toW = towerToWorld;
  /** the L2 stair hole spans lz HOLE_Z → hw (the inner stair's top meets its −z edge) */
  const HOLE_Z = hw - 1.0 - (Math.max(2, Math.round((T.l2 - T.l1) / 0.29)) - 1) * 0.27;
  const wp = (k: string, lx: number, y: number, lz: number, h: V3, col: 0 | 1 | 2 = 1) => { const [x, z] = toW(lx, lz); Wd(k, [x, y, z], h, col, T.yaw); };
  // legs (outside the floor corners)
  const legTop = T.l2 + RAIL + 0.15;
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) wp("log", sx * (hw + 0.12), (T.g - 1.5 + legTop) / 2, sz * (hw + 0.12), [0.15, (legTop - T.g + 1.5) / 2, 0.15]);   // (inscribed in the r 0.19 drawn log)
  // the flag mast at the +x/−z corner of the top platform (collides; a lantern hangs off its yard)
  wp("flagpole", hw - 0.3, (T.l2 + T.roof + 2.5) / 2, -hw + 0.3, [0.05, (T.roof + 2.5 - T.l2) / 2, 0.05]);
  // L1 floor (full); L2 floor minus the stair hole lx ∈ [−hw, −hw+1.25], lz ∈ [−1.0, hw]
  wp("towerfloor", 0, T.l1 - 0.1, 0, [hw, 0.1, hw]);
  wp("towerfloor", 0.625, T.l2 - 0.1, 0, [hw - 0.625, 0.1, hw]);
  wp("towerfloor", -hw + 0.625, T.l2 - 0.1, (-hw + HOLE_Z) / 2, [0.625, 0.1, (HOLE_Z + hw) / 2]);
  // rails: L1 on the back (−z) and left (−x) and the front (+z) left of the +x corner; the +x side stays open (stair)
  const rail = (y: number, lx0: number, lz0: number, lx1: number, lz1: number) => wall("world", "towerrail", toW(lx0, lz0), toW(lx1, lz1), y, y + RAIL, 0.12, [], 1);
  rail(T.l1, -hw, -hw + 0.06, hw, -hw + 0.06);
  rail(T.l1, -hw + 0.06, -hw, -hw + 0.06, hw);
  rail(T.l1, -hw, hw - 0.06, hw, hw - 0.06);
  rail(T.l2, -hw, -hw + 0.06, hw, -hw + 0.06);
  rail(T.l2, hw - 0.06, -hw, hw - 0.06, hw);
  rail(T.l2, -hw, hw - 0.06, hw, hw - 0.06);
  rail(T.l2, -hw + 0.06, -hw, -hw + 0.06, HOLE_Z);
  // along the L2 stair hole's open edge (lx = −hw+1.25, lz HOLE_Z → hw) so nobody walks into the hole
  rail(T.l2, -hw + 1.31, HOLE_Z + 0.9, -hw + 1.31, hw);
  // outside stair along +x: climbs toward +z to a landing at the front corner, which joins the L1 floor's open side
  {
    const run = 0.29, n = Math.max(2, Math.round((T.l1 - (T.g - 0.1)) / 0.29)), len = (n - 1) * run;
    const lzTop = hw - 0.9;
    const [bx, bz] = toW(hw + 0.95, lzTop - len);
    stair("world", "wstair", [bx, bz], [sn, c], 1.2, T.g - 0.1, T.l1, run);
    wp("towerfloor", hw + 0.8, T.l1 - 0.1, (lzTop + hw) / 2, [0.75, 0.1, (hw - lzTop) / 2]);
  }
  // inside stair: L1 → L2 along −x, climbing toward −z, its top at the hole's −z edge (lz = −1.0)
  {
    const run = 0.27, n = Math.max(2, Math.round((T.l2 - T.l1) / 0.29)), len = (n - 1) * run;
    const [bx, bz] = toW(-hw + 0.62, HOLE_Z + len);
    stair("world", "stair", [bx, bz], [-sn, -c], 1.05, T.l1, T.l2, run);
  }
  // (no roof: the top platform is open to the sky — landable, and reached by the stairs; a flag mast at one corner)
}
/** the sailcloth tent over the camp stores: a ridge pole on two tall poles, a canvas back wall (collides, bullets pass),
 *  the roof sloping from the ridge to the back wall and forward to an awning on two short poles; open front + sides */
export const TENT = { x: 57.5, z: -639.2, yaw: 0.45, w: 6.4, d: 4.6, ridge: 3.3, awning: 2.25, back: 1.6, g: 0.4 };
/** decorative open treasure chests beside the tent (tent frame lx, lz, yaw) */
export const TREASURE: Array<[number, number, number]> = [[-4.3, -0.9, 1.25], [-4.1, 0.95, 1.7], [-3.5, 2.5, 0.8]];
/** the bonfire ring (front of the camp, between the boardwalk and the tent) */
export const FIRE = { x: 51.5, z: -642.5, r: 1.25 };
export function tentToWorld(lx: number, lz: number): [number, number] {
  const c = dmath.cos(TENT.yaw), sn = dmath.sin(TENT.yaw);
  return [TENT.x + lx * c + lz * sn, TENT.z - lx * sn + lz * c];
}
{
  const T = TENT;
  const poleAt = (lx: number, lz: number, h: number) => { const [x, z] = tentToWorld(lx, lz); Wd("pole", [x, T.g + h / 2 - 0.4, z], [0.055, h / 2 + 0.4, 0.055], 1, T.yaw); };
  for (const s of [-1, 1]) { poleAt(s * T.w / 2, 0, T.ridge); poleAt(s * T.w / 2, T.d / 2, T.awning); }
  // the canvas back wall
  { const [x, z] = tentToWorld(0, -T.d / 2); Wd("tentwall", [x, T.g + T.back / 2 - 0.2, z], [T.w / 2, T.back / 2 + 0.2, 0.05], 2, T.yaw, "fabric", { noShoot: true }); }
  const store = (k: string, lx: number, lz: number, h: V3, yawL = 0) => { const [x, z] = tentToWorld(lx, lz); Wd(k, [x, T.g + h[1], z], h, 1, T.yaw + yawL); };
  store("crates", -2.3, -1.5, [0.55, 0.55, 0.55]);
  store("crates", -1.3, -1.6, [0.45, 0.4, 0.45], 0.4);
  store("barrels", 2.3, -1.5, [0.5, 0.55, 0.5]);
  store("sacks", 0.9, -1.7, [0.8, 0.3, 0.45]);
  // the castaways' hoard spilling out beside the tent toward the fire (open treasure chests): decorative
  // (open, overflowing — never a loot chest), knee-high: a collider each (ground ≈ 0.45 there)
  for (const [lx, lz, yw] of TREASURE) { const [x, z] = tentToWorld(lx, lz); Wd("treasurecol", [x, 0.325, z], [0.47, 0.625, 0.32], 2, T.yaw + yw); }
  // bonfire stones (knee-high ring — stepped over)
  Wd("firering", [FIRE.x, 0.25, FIRE.z], [FIRE.r * 0.72, 0.18, FIRE.r * 0.72], 1, 0.3, "stone");
}

// ------------------------------------------------------------------------------------------------ rocks
/** sculpted rock placements (world): base y (bottom), half extents sx, sy (half HEIGHT: top = y + 2·sy), sz, yaw
 *  (three.js). The visual is a convex poly rock normalised to that box; the collider an inscribed box (rockBox). */
export interface Rock { x: number; y: number; z: number; sx: number; sy: number; sz: number; yaw: number; seed: number; col: boolean; top?: number }
export const ROCKS: Rock[] = [
  // THE HEADLAND (east): a stepped cliff mass in the shallows + beach foot (the waterfall pours off its crown)
  { x: 124, y: -4, z: -676, sx: 13, sy: 11.5, sz: 11, yaw: 0.3, seed: 1, col: true },
  { x: 115, y: -4, z: -697, sx: 10, sy: 7.5, sz: 8.5, yaw: -0.4, seed: 2, col: true },
  { x: 134, y: -3, z: -656, sx: 12, sy: 10.5, sz: 10, yaw: 0.9, seed: 3, col: true },
  { x: 106, y: -4.5, z: -713, sx: 6.5, sy: 3.6, sz: 6, yaw: 0.2, seed: 4, col: true },
  { x: 112.5, y: -1.5, z: -663, sx: 4.2, sy: 3.2, sz: 3.8, yaw: 1.2, seed: 5, col: true },
  // boulders on the beach + in the surf (cover)
  { x: 66.5, y: -1.2, z: -663.5, sx: 2.2, sy: 1.5, sz: 1.9, yaw: 0.5, seed: 11, col: true },
  { x: 47.5, y: -1.1, z: -658.5, sx: 1.8, sy: 1.2, sz: 1.5, yaw: 1.4, seed: 12, col: true },
  { x: 36.5, y: -0.9, z: -652.0, sx: 1.4, sy: 1.1, sz: 1.3, yaw: 0.2, seed: 13, col: true },
  { x: 22.0, y: -0.8, z: -655.5, sx: 2.0, sy: 1.4, sz: 1.7, yaw: 2.2, seed: 14, col: true },
  { x: 4.0, y: -0.6, z: -662.0, sx: 1.7, sy: 1.3, sz: 1.6, yaw: 0.8, seed: 15, col: true },
  { x: -16.0, y: -0.4, z: -675.0, sx: 2.3, sy: 1.6, sz: 2.0, yaw: 1.9, seed: 16, col: true },
  { x: -34.0, y: 0.0, z: -690.0, sx: 2.6, sy: 1.9, sz: 2.2, yaw: 0.6, seed: 17, col: true },
  { x: 81.0, y: -0.6, z: -657.0, sx: 1.6, sy: 1.1, sz: 1.4, yaw: 1.0, seed: 18, col: true },
  // around the wreck (in the water: rocks crowding the hull) — placed in the SHIP frame below (WRECK_ROCKS)
  // cover (hard cover within ~8 m of every land spot): backshore, west beach, the hills behind the cove
  { x: -4.0, y: 1.6, z: -645.0, sx: 1.9, sy: 0.9, sz: 1.5, yaw: 0.7, seed: 31, col: true },
  { x: -28.0, y: 1.8, z: -657.0, sx: 2.1, sy: 0.95, sz: 1.6, yaw: 2.4, seed: 32, col: true },
  { x: -34.0, y: -0.5, z: -708.0, sx: 1.8, sy: 1.0, sz: 1.5, yaw: 0.2, seed: 33, col: true },
  { x: -16.0, y: 1.9, z: -649.5, sx: 1.5, sy: 0.8, sz: 1.3, yaw: 1.3, seed: 34, col: true },
  { x: -46.0, y: 0.7, z: -690.0, sx: 2.0, sy: 1.0, sz: 1.7, yaw: 0.9, seed: 35, col: true },
  { x: -58.0, y: 12.6, z: -715.0, sx: 2.6, sy: 1.5, sz: 2.2, yaw: 1.7, seed: 36, col: true },
  { x: -54.0, y: 0.0, z: -727.0, sx: 2.2, sy: 1.7, sz: 1.7, yaw: 0.4, seed: 37, col: true },
  { x: -57.5, y: 8.6, z: -703.0, sx: 2.2, sy: 1.3, sz: 1.8, yaw: 2.9, seed: 38, col: true },
  { x: 106.0, y: 13.0, z: -615.0, sx: 2.6, sy: 1.5, sz: 2.2, yaw: 0.6, seed: 39, col: true },
  { x: 26.0, y: 8.0, z: -602.0, sx: 2.0, sy: 1.1, sz: 1.7, yaw: 1.1, seed: 40, col: true },
  { x: -31.0, y: 2.0, z: -651.0, sx: 1.8, sy: 1.15, sz: 1.5, yaw: 0.3, seed: 45, col: true },
  { x: -52.0, y: 3.1, z: -695.0, sx: 1.9, sy: 1.0, sz: 1.6, yaw: 0.5, seed: 42, col: true },
  { x: 0.0, y: 0.3, z: -655.5, sx: 1.7, sy: 1.05, sz: 1.4, yaw: 2.2, seed: 43, col: true },
  { x: -45.0, y: -0.2, z: -719.0, sx: 2.0, sy: 1.15, sz: 1.7, yaw: 1.5, seed: 44, col: true },
  { x: 14.0, y: 12.8, z: -597.0, sx: 2.2, sy: 1.3, sz: 1.8, yaw: 2.0, seed: 41, col: true },
  { x: 103.5, y: 8.0, z: -626.0, sx: 1.8, sy: 0.9, sz: 1.5, yaw: 0.8, seed: 46, col: true },
  // a mossy boulder in the jungle fringe behind the camp (hard cover for the beach in front of the camp; outside the
  // poi-16-wreck-bay view's frame and the fire's sight lines)
  { x: 38.6, y: 1.05, z: -631.6, sx: 1.3, sy: 0.85, sz: 1.1, yaw: 2.2, seed: 47, col: true },
  // cover: the west cliff-foot strand, the west beach, the headland's beach foot
  { x: -51.0, y: 1.0, z: -722.5, sx: 2.0, sy: 1.6, sz: 1.7, yaw: 1.1, seed: 48, col: true },
  { x: -41.0, y: 0.0, z: -704.5, sx: 1.9, sy: 1.2, sz: 1.5, yaw: 0.3, seed: 49, col: true },
  { x: 115.5, y: 0.0, z: -649.0, sx: 1.8, sy: 1.2, sz: 1.5, yaw: 2.6, seed: 50, col: true },
  // surf boulders left of the fire (a rock cluster at the waterline; cover for the beach front)
  { x: 43.5, y: 0.0, z: -652.5, sx: 1.9, sy: 1.1, sz: 1.5, yaw: 0.7, seed: 51, col: true },
  { x: 39.0, y: 0.0, z: -655.5, sx: 1.4, sy: 0.8, sz: 1.2, yaw: 2.1, seed: 52, col: true },
];
/** a rock is drawn + collided as BLOCKS: boulders are one block; the headland rocks (index < HEADLAND) are stepped
 *  cliff masses — 2–3 tiers, each tier split into 2×2 jittered blocks, upper tiers inset (the chunky sandstone ledges
 *  of the right-hand cliff). Every block = one convex poly rock (visual) + one inscribed box (collider). */
export const HEADLAND = 5;
/** rocks hugging the wreck at the waterline, in the SHIP frame (x along the keel, z across; shore = −z):
 *  boulders crowding the hull. Kept clear of the breach (x −9 … 0 on the shore side) so waders reach it. */
const WRECK_ROCKS: Array<[number, number, number, number, number, number]> = [
  // [ship x, ship z, half w, half h, top (world y), seed]
  [9.0, -8.6, 2.2, 1.9, 1.3, 21], [-13.0, -8.4, 1.9, 1.7, 1.0, 22], [4.0, 8.9, 2.7, 2.2, 1.6, 23], [-12.0, 8.4, 2.3, 1.9, 1.2, 24],
  [16.5, 6.2, 2.3, 1.8, 0.9, 25], [-22.5, 1.5, 2.9, 2.5, 1.9, 26], [-21.5, -5.2, 2.1, 1.8, 1.1, 27], [22.5, -2.6, 3.0, 2.3, 0.8, 28],
  [20.0, 4.6, 2.0, 1.7, 0.6, 29],
];
for (const [lx, lz, w, hh, top, seed] of WRECK_ROCKS) {
  const [x, , z] = shipToWorld(lx, 0, lz);
  ROCKS.push({ x, y: top - 2 * hh, z, sx: w, sy: hh, sz: w * 0.85, yaw: seed * 0.7, seed, col: true, top });
}
// ---- faceted rock SOLIDS: collider ≡ visual BY CONSTRUCTION. A rock is a convex plan polygon extruded into
// rings (vertical-ish walls that taper per vertex, a chamfered lip, a flat-topped cap). The client draws exactly those
// rings; the sim gets, per height band, one yaw box per polygon EDGE (the edge is the box's outer face, the box reaches
// inward to the centre), so the union of a band's boxes IS the band's polygon (the drawn rock at the band's
// mid-height): within taper·band/2 ≤ 0.13 m everywhere, no box corner outside the rock.
export type P2 = [number, number];
const rngOf = (seed: number) => { let a = (seed * 2654435761) >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
function hull2(pts: P2[]): P2[] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: P2[] = [], up: P2[] = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.reverse()) { while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  lo.pop(); up.pop(); return lo.concat(up);
}
/** push reflex vertices out onto their neighbours' chord (keeps the vertex count: rings stay in correspondence) */
function convexify(p: P2[]): P2[] {
  const q = p.map((v) => [v[0], v[1]] as P2), n = q.length;
  let area = 0; for (let i = 0; i < n; i++) { const a = q[i], b = q[(i + 1) % n]; area += a[0] * b[1] - b[0] * a[1]; }
  const sg = Math.sign(area) || 1;
  for (let pass = 0; pass < 4; pass++) for (let i = 0; i < n; i++) {
    const a = q[(i + n - 1) % n], b = q[i], c = q[(i + 1) % n];
    const cr = ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) * sg;
    if (cr < 0) { const ex = c[0] - a[0], ez = c[1] - a[1], l2 = ex * ex + ez * ez || 1, t = Math.max(0, Math.min(1, ((b[0] - a[0]) * ex + (b[1] - a[1]) * ez) / l2)); q[i] = [a[0] + ex * t + 1e-4 * -ez * sg, a[1] + ez * t + 1e-4 * ex * sg]; }
  }
  return q;
}
/** cut every corner sharper than `minDeg` (two vertices at `f` along its edges): an edge box needs obtuse neighbours */
export function bluntCorners(p: P2[], minDeg = 105, f = 0.22): P2[] {
  let q = p;
  for (let pass = 0; pass < 3; pass++) {
    const out: P2[] = []; let cut = false;
    for (let i = 0; i < q.length; i++) {
      const a = q[(i + q.length - 1) % q.length], b = q[i], c = q[(i + 1) % q.length];
      const ux = a[0] - b[0], uz = a[1] - b[1], vx = c[0] - b[0], vz = c[1] - b[1];
      const ang = (dmath.acos(Math.max(-1, Math.min(1, (ux * vx + uz * vz) / ((dmath.hypot(ux, uz) * dmath.hypot(vx, vz)) || 1)))) * 180) / Math.PI;
      if (ang < minDeg) { out.push([b[0] + ux * f, b[1] + uz * f], [b[0] + vx * f, b[1] + vz * f]); cut = true; } else out.push(b);
    }
    q = out; if (!cut) break;
  }
  return q;
}
export const centroid2 = (p: P2[]): P2 => { let x = 0, z = 0; for (const q of p) { x += q[0]; z += q[1]; } return [x / p.length, z / p.length]; };
/** an irregular convex n-gon inscribed in the ellipse (sx, sz) at (x, z), rotated by the three.js yaw */
export function rockPlan(x: number, z: number, sx: number, sz: number, yaw: number, seed: number, n: number, rough = 0.16): P2[] {
  const rnd = rngOf(seed * 7 + 3), c = dmath.cos(yaw), s = dmath.sin(yaw), pts: P2[] = [];
  for (let i = 0; i < n; i++) {
    const a = ((i + (rnd() - 0.5) * 0.5) / n) * Math.PI * 2, rho = 1 - rough + rough * rnd();
    const lx = dmath.cos(a) * rho * sx, lz = dmath.sin(a) * rho * sz;
    pts.push([x + lx * c + lz * s, z - lx * s + lz * c]);
  }
  return bluntCorners(hull2(pts), 112, 0.25);
}
/** move every vertex toward the centroid by d[i] metres */
export function shrink2(p: P2[], d: number[] | number): P2[] {
  const c = centroid2(p);
  return p.map((q, i) => { const dx = c[0] - q[0], dz = c[1] - q[1], l = dmath.hypot(dx, dz) || 1, k = Math.min(l * 0.9, typeof d === "number" ? d : d[i]) / l; return [q[0] + dx * k, q[1] + dz * k] as P2; });
}
export function inPoly2(p: P2[], x: number, z: number, pad = 0): boolean {
  return polyInside(p)(x, z, pad);
}
/** inPoly2 for one polygon tested many times: its edges' inward normals computed once (the same arithmetic, so the
 *  same answers bit for bit). polyBoxes tests ~10⁵ points per rock; recomputing them per point cost ~1 s at import. */
function polyInside(p: P2[]): (x: number, z: number, pad: number) => boolean {
  const c = centroid2(p), n = p.length, ax = new Float64Array(n), az = new Float64Array(n), nxs = new Float64Array(n), nzs = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = p[i], b = p[(i + 1) % n], ex = b[0] - a[0], ez = b[1] - a[1], l = dmath.hypot(ex, ez) || 1;
    let nx = -ez / l, nz = ex / l; if ((c[0] - a[0]) * nx + (c[1] - a[1]) * nz < 0) { nx = -nx; nz = -nz; }
    ax[i] = a[0]; az[i] = a[1]; nxs[i] = nx; nzs[i] = nz;
  }
  return (x, z, pad) => {
    for (let i = 0; i < n; i++) if ((x - ax[i]) * nxs[i] + (z - az[i]) * nzs[i] < pad - 1e-6) return false;
    return true;
  };
}
/** the boxes whose union is the convex polygon `p` between y0 and y1 (one per edge + a centre box) */
export function polyBoxes(p: P2[], y0: number, y1: number, surf: Surface = "stone"): Box[] {
  const c = centroid2(p), out: Box[] = [], hy = (y1 - y0) / 2, cy = (y0 + y1) / 2, inside = polyInside(p);
  let minAp = Infinity;
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length], ex = b[0] - a[0], ez = b[1] - a[1], l = dmath.hypot(ex, ez);
    if (l < 0.05) continue;
    let nx = -ez / l, nz = ex / l; if ((c[0] - a[0]) * nx + (c[1] - a[1]) * nz < 0) { nx = -nx; nz = -nz; }
    let d = (c[0] - a[0]) * nx + (c[1] - a[1]) * nz; minAp = Math.min(minAp, d);
    // the inner corners must stay inside the polygon (an acute neighbour would push them out)
    for (let k = 0; k < 12 && !(inside(a[0] + nx * d, a[1] + nz * d, -0.01) && inside(b[0] + nx * d, b[1] + nz * d, -0.01)); k++) d *= 0.85;
    out.push({ c: [(a[0] + b[0]) / 2 + (nx * d) / 2, cy, (a[1] + b[1]) / 2 + (nz * d) / 2], h: [l / 2, hy, d / 2], yaw: dmath.atan2(ez, ex), surf });
  }
  // the centre: a square around the centroid (closes the fan where an edge's foot falls outside it)
  const q = minAp * 0.68, yaw0 = dmath.atan2(p[1][1] - p[0][1], p[1][0] - p[0][0]);
  if (q > 0.1) out.push({ c: [c[0], cy, c[1]], h: [q, hy, q], yaw: yaw0, surf });
  // any hole left (a short edge next to a long one): inscribed strips across the polygon, only where a hole is
  // (each box's cos / sin once: `out` only grows, so box i's pair is computed the first time a test reaches it)
  const cs: number[] = [], sn: number[] = [];
  const inAny = (x: number, z: number) => {
    for (let i = 0; i < out.length; i++) {
      const b = out[i];
      if (i === cs.length) { const yw = b.yaw ?? 0; cs.push(dmath.cos(yw)); sn.push(dmath.sin(yw)); }
      const dx = x - b.c[0], dz = z - b.c[2];
      if (Math.abs(dx * cs[i] + dz * sn[i]) <= b.h[0] + 1e-3 && Math.abs(-dx * sn[i] + dz * cs[i]) <= b.h[2] + 1e-3) return true;
    }
    return false;
  };
  const ux = dmath.cos(yaw0), uz = dmath.sin(yaw0), vx = -uz, vz = ux;
  let v0 = Infinity, v1 = -Infinity, u0 = Infinity, u1 = -Infinity;
  for (const [x, z] of p) { const u = (x - c[0]) * ux + (z - c[1]) * uz, v = (x - c[0]) * vx + (z - c[1]) * vz; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
  // the chord of the polygon along u at a given v
  const chord = (v: number): [number, number] => {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      const va = (a[0] - c[0]) * vx + (a[1] - c[1]) * vz, vb = (b[0] - c[0]) * vx + (b[1] - c[1]) * vz;
      if ((va - v) * (vb - v) > 0 || va === vb) continue;
      const t = (v - va) / (vb - va), u = ((a[0] - c[0]) * ux + (a[1] - c[1]) * uz) * (1 - t) + ((b[0] - c[0]) * ux + (b[1] - c[1]) * uz) * t;
      lo = Math.min(lo, u); hi = Math.max(hi, u);
    }
    return [lo, hi];
  };
  const W = 0.5;
  for (let va = v0 + 0.05; va < v1 - 0.05; va += W) {
    const vb = Math.min(v1 - 0.05, va + W);
    let hole = false;
    for (let v = va + 0.05; v <= vb - 0.05 + 1e-6 && !hole; v += 0.1) for (let u = u0; u <= u1; u += 0.1) {
      const x = c[0] + ux * u + vx * v, z = c[1] + uz * u + vz * v;
      if (inside(x, z, 0.03) && !inAny(x, z)) { hole = true; break; }
    }
    if (!hole) continue;
    const [l0, h0] = chord(va), [l1, h1] = chord(vb), lo = Math.max(l0, l1), hi = Math.min(h0, h1);
    if (hi - lo < 0.1) continue;
    const um = (lo + hi) / 2, vm = (va + vb) / 2;
    out.push({ c: [c[0] + ux * um + vx * vm, cy, c[1] + uz * um + vz * vm], h: [(hi - lo) / 2, hy, (vb - va) / 2 + 0.02], yaw: yaw0, surf });
  }
  // last slivers: a 0.24 m plug at any point still uncovered (0.12 m inside the rim — the plug stays inside)
  for (let u = u0; u <= u1; u += 0.08) for (let v = v0; v <= v1; v += 0.08) {
    const x = c[0] + ux * u + vx * v, z = c[1] + uz * u + vz * v;
    if (inside(x, z, 0.12) && !inAny(x, z)) out.push({ c: [x, cy, z], h: [0.12, hy, 0.12], yaw: yaw0, surf });
  }
  return out;
}
export interface RockSolid { rings: Array<{ y: number; pts: P2[] }>; capRise: number; boxes: Box[]; top: number; seed: number; kind: "boulder" | "cliff" | "landing" }
interface SolidSpec {
  plan: P2[]; y0: number; yg: number; top: number; seed: number; kind: RockSolid["kind"]; colBot?: number; capRise?: number;
  /** wall taper (m inset per m of height, per vertex in [a, b]) · top chamfer (height, inset) */
  taper: [number, number]; ch: number; chIn: number;
  /** dome: the upper part rounds in by up to dome·R (per vertex 0.6–1.4 ×) along h^2.4 · lean (m at the top) · twist (rad) */
  dome?: number; lean?: number; twist?: number;
  /** a new ring whenever any vertex moved more than maxStep since the last ring, or every `band` metres */
  maxStep: number; band: number;
}
function rockSolid(s: SolidSpec): RockSolid {
  const rnd = rngOf(s.seed * 13 + 5);
  const tp = s.plan.map(() => s.taper[0] + (s.taper[1] - s.taper[0]) * rnd());
  const ci = s.plan.map(() => s.chIn * (0.7 + 0.6 * rnd()));
  const dk = s.plan.map(() => 0.6 + 0.8 * rnd());
  const c0 = centroid2(s.plan), Rv = s.plan.map((q) => dmath.hypot(q[0] - c0[0], q[1] - c0[1]));
  const la = rnd() * Math.PI * 2, lean = s.lean ?? 0, tw = (s.twist ?? 0) * (rnd() < 0.5 ? -1 : 1), dome = s.dome ?? 0;
  const yw = s.top - s.ch, H = Math.max(0.1, s.top - s.yg);
  const ring = (y: number): P2[] => {
    const h = Math.max(0, Math.min(1, (y - s.yg) / H));
    const sh = shrink2(s.plan, s.plan.map((_, i) => tp[i] * Math.max(0, Math.min(y, yw) - s.yg) + dome * Rv[i] * dk[i] * dmath.pow(h, 2.4) + (y > yw ? (ci[i] * (y - yw)) / s.ch : 0)));
    const ang = tw * h, ca = dmath.cos(ang), sa = dmath.sin(ang), ox = dmath.cos(la) * lean * dmath.pow(h, 1.5), oz = dmath.sin(la) * lean * dmath.pow(h, 1.5);
    return convexify(sh.map(([x, z]) => { const dx = x - c0[0], dz = z - c0[1]; return [c0[0] + dx * ca - dz * sa + ox, c0[1] + dx * sa + dz * ca + oz] as P2; }));
  };
  // adaptive rings: a ring where the shape has moved maxStep (the drawn facet between two rings is their lerp; the
  // sim band = that lerp at mid-height → |drawn − collider| ≤ maxStep / 2)
  const rings = [{ y: s.y0, pts: ring(s.y0) }, { y: s.yg, pts: ring(s.yg) }];
  let last = rings[1];
  const dist = (a: P2[], b: P2[]) => Math.max(...a.map((q, i) => dmath.hypot(q[0] - b[i][0], q[1] - b[i][1])));
  for (let y = s.yg + 0.02; y < s.top - 1e-6; y += 0.02) {
    const cand = ring(y), nxt = ring(Math.min(s.top, y + 0.02));
    const crossW = y < yw && y + 0.02 >= yw;
    if (crossW || dist(nxt, last.pts) > s.maxStep || y + 0.02 - last.y > s.band) { last = { y, pts: cand }; rings.push(last); }
  }
  rings.push({ y: s.top, pts: ring(s.top) });
  const boxes: Box[] = [];
  for (let j = 1; j < rings.length - 1; j++) {
    const A = rings[j], B = rings[j + 1], mid = A.pts.map((q, i) => [(q[0] + B.pts[i][0]) / 2, (q[1] + B.pts[i][1]) / 2] as P2);
    boxes.push(...polyBoxes(bluntCorners(hull2(mid), 96, 0.1), j === 1 ? s.colBot ?? s.y0 : A.y, B.y));
  }
  return { rings, capRise: s.capRise ?? 0, boxes, top: s.top, seed: s.seed, kind: s.kind };
}
/** where each boulder meets the terrain: [min, max] of the baked terrain under its footprint (an offline bake
 *  rewrites this block; the server has no terrain sampler at import). Keyed "x,z" (1 decimal). */
// @generated rock-ground-begin (terrain hash 31007852)
const ROCK_GROUND: Record<string, [number, number]> = {
  "66.5,-663.5": [-1.12, -0.80],
  "47.5,-658.5": [-0.84, -0.58],
  "36.5,-652.0": [-0.08, 0.15],
  "22.0,-655.5": [-0.14, 0.20],
  "4.0,-662.0": [0.14, 0.28],
  "-16.0,-675.0": [0.22, 0.45],
  "-34.0,-690.0": [0.40, 0.63],
  "81.0,-657.0": [-0.39, -0.24],
  "-4.0,-645.0": [1.95, 2.29],
  "-28.0,-657.0": [2.24, 2.39],
  "-34.0,-708.0": [-0.31, 0.17],
  "-16.0,-649.5": [2.25, 2.49],
  "-46.0,-690.0": [1.11, 1.38],
  "-58.0,-715.0": [12.33, 14.63],
  "-54.0,-727.0": [-0.99, 2.12],
  "-57.5,-703.0": [8.20, 10.18],
  "106.0,-615.0": [7.65, 8.55],
  "26.0,-602.0": [10.55, 10.72],
  "-31.0,-651.0": [2.67, 2.87],
  "-52.0,-695.0": [2.76, 4.19],
  "0.0,-655.5": [0.74, 1.03],
  "-45.0,-719.0": [-0.98, 1.19],
  "14.0,-597.0": [11.37, 11.72],
  "103.5,-626.0": [5.89, 6.64],
  "38.6,-631.6": [1.15, 1.35],
  "-51.0,-722.5": [0.68, 2.19],
  "-41.0,-704.5": [0.73, 2.01],
  "115.5,-649.0": [0.45, 0.62],
  "43.5,-652.5": [-0.37, -0.07],
  "39.0,-655.5": [-0.39, -0.32],
  "46.4,-676.7": [-2.25, -2.00],
  "63.2,-690.8": [-2.65, -1.23],
  "39.4,-693.3": [-2.34, -1.70],
  "52.0,-703.1": [-3.38, -2.51],
  "31.4,-683.3": [-2.47, -1.46],
  "64.4,-704.4": [-3.09, -1.84],
  "67.8,-698.7": [-2.78, -1.68],
  "32.3,-672.7": [-1.97, -1.44],
  "29.7,-679.8": [-2.40, -2.14],
  "c:30.5,-649.5": [0.14, 0.40],
  "c:13.0,-652.5": [0.42, 0.57],
  "c:15.2,-653.8": [0.29, 0.36],
  "c:-6.0,-666.0": [0.28, 0.45],
  "c:-27.0,-683.0": [0.41, 0.54],
  "c:2.0,-650.0": [1.13, 1.49],
  "c:45.5,-646.5": [0.18, 0.23],
  "c:77.5,-640.0": [0.67, 0.82],
  "c:99.0,-652.0": [0.21, 0.27],
  "c:66.0,-637.5": [0.82, 1.01],
  "c:40.0,-620.0": [2.12, 3.12],
  "c:27.0,-614.0": [2.78, 2.91],
  "c:16.0,-621.5": [2.52, 2.63],
  "c:8.5,-626.0": [2.61, 2.66],
  "c:5.0,-632.0": [2.39, 2.51],
  "c:14.0,-640.0": [1.30, 1.49],
  "c:-10.0,-636.0": [2.70, 2.76],
  "c:75.5,-645.5": [0.34, 0.42],
  "c:20.5,-633.0": [1.67, 1.84],
  "c:42.5,-645.0": [0.23, 0.30],
  "c:-40.0,-678.0": [1.21, 1.77],
  "c:-24.0,-668.0": [0.99, 1.55],
  "c:34.5,-646.0": [0.33, 0.42],
  "c:22.0,-628.0": [2.01, 2.18],
  "c:-19.0,-664.0": [1.35, 1.56],
  "p:58.0,-649.5": [0.12, 0.13],
  "p:80.5,-634.0": [3.20, 3.29],
  "p:72.0,-633.5": [3.46, 3.54],
  "p:29.5,-636.5": [1.25, 1.30],
  "p:25.5,-642.0": [0.95, 1.00],
  "p:8.5,-646.0": [1.28, 1.34],
  "p:-12.0,-660.0": [1.18, 1.24],
  "p:-30.0,-674.5": [1.17, 1.27],
  "p:92.0,-619.5": [4.87, 4.96],
  "p:111.0,-636.5": [4.47, 4.63],
};
// @generated rock-ground-end
export const rockKey = (r: { x: number; z: number }) => `${r.x.toFixed(1)},${r.z.toFixed(1)}`;
/** the plan polygon of a boulder (8 facets) or a headland rock's bottom tier (12) */
export const boulderPlan = (r: Rock) => rockPlan(r.x, r.z, r.sx, r.sz, r.yaw, r.seed, 7 + (r.seed % 3), 0.28);
/** seat a boulder on the terrain: bottom 0.3 m under the lowest ground under it, the designed size kept, at least 1 m
 *  proud of the highest ground (wreck rocks keep their designed top above the sea) */
export function seatRock(r: Rock): { y0: number; yg: number; top: number } {
  const g = ROCK_GROUND[rockKey(r)];
  if (!g) return { y0: r.y - 0.3, yg: r.y, top: r.y + 2 * r.sy };
  const [gmin, gmax] = g, y0 = gmin - 0.3;
  const top = r.top !== undefined ? Math.max(r.top, gmax + 0.6) : Math.max(y0 + 2 * r.sy, gmax + 1.0);
  return { y0, yg: gmin, top };
}
/** how much each cliff tier steps in (the ledge width, metres, per vertex 0.6–1.4 ×) */
export const CLIFF_LEDGE = 0.45;
function solidsOf(r: Rock, i: number): RockSolid[] {
  if (i >= HEADLAND) {
    const { y0, yg, top } = seatRock(r);
    return [rockSolid({ plan: boulderPlan(r), y0, yg, top, taper: [0.02, 0.12], ch: 0.18, chIn: 0.14, dome: 0.42, lean: 0.35, twist: 0.25, maxStep: 0.24, band: 1.1, seed: r.seed, colBot: y0 - 1.5, capRise: 0.07, kind: "boulder" })];
  }
  // the headland: stacked sandstone tiers, each standing INSIDE the one below (a ledge, never an overhanging lid)
  const nT = r.sy > 5 ? 3 : 2, H = (2 * r.sy) / nT, out: RockSolid[] = [], rnd = rngOf(r.seed * 31 + 7);
  let plan = rockPlan(r.x, r.z, r.sx, r.sz * 0.92, r.yaw, r.seed, 12, 0.12);
  for (let t = 0; t < nT; t++) {
    const yb = r.y + t * H, top = r.y + (t + 1) * H;
    const s = rockSolid({ plan, y0: t ? yb - 0.6 : r.y - 3, yg: yb, top, taper: [0.015, 0.06], ch: 0.35, chIn: 0.3, maxStep: 0.24, band: 4.2, seed: r.seed * 8 + t, colBot: t ? yb - 0.6 : r.y - 3, kind: "cliff" });
    out.push(s);
    plan = hull2(shrink2(hull2(s.rings[s.rings.length - 1].pts), plan.map(() => CLIFF_LEDGE * (0.6 + 0.8 * rnd()))));
  }
  return out;
}
/** every rock's solids (index = ROCKS index): what the client draws and the sim collides with */
export const ROCK_SOLIDS: RockSolid[][] = ROCKS.map((r, i) => solidsOf(r, i));
/** palms crowning the tall headland plateaus (palms over the cliff): deterministic, ≥ 2 m inside the
 *  top tier's rim, ≥ 3.5 m apart, each with a trunk collider (a solid-looking trunk must block; client-scattered
 *  plateau palms would have none) */
export const HEADLAND_PALMS: Array<{ x: number; z: number; y: number; yaw: number; s: number }> = (() => {
  const out: Array<{ x: number; z: number; y: number; yaw: number; s: number }> = [];
  ROCKS.slice(0, HEADLAND).forEach((r, i) => {
    if (r.sy < 5) return;
    const T = ROCK_SOLIDS[i][ROCK_SOLIDS[i].length - 1], ring = T.rings[T.rings.length - 1].pts, rnd = rngOf(r.seed * 97 + 11);
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of ring) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    const n = Math.max(2, Math.round(((x1 - x0) * (z1 - z0)) / 70));
    for (let k = 0, t = 0; k < n && t < 200; t++) {
      const x = x0 + rnd() * (x1 - x0), z = z0 + rnd() * (z1 - z0);
      if (!inPoly2(ring, x, z, 2.0) || out.some((p) => dmath.hypot(p.x - x, p.z - z) < 3.5)) continue;
      out.push({ x, z, y: T.top, yaw: rnd() * 6.28, s: 0.9 + rnd() * 0.35 }); k++;
    }
  });
  return out;
})();
for (const p of HEADLAND_PALMS) Wd("trunk", [p.x, p.y + 2.0, p.z], [0.17, 2.6, 0.17], 2, 0, "wood");
/** THE LANDING rock under the bridge platform: a chamfered block (its top = the platform's underside) */
export const LANDING_SOLID: RockSolid = (() => {
  const L = LANDING, c = dmath.cos(L.yaw), s = dmath.sin(L.yaw), k = 0.55, hx = L.hx, hz = L.hz;
  const loc: P2[] = [[-hx + k, -hz], [hx - k, -hz], [hx, -hz + k], [hx, hz - k], [hx - k, hz], [-hx + k, hz], [-hx, hz - k], [-hx, -hz + k]];
  const plan = hull2(loc.map(([lx, lz]) => [L.x + lx * c + lz * s, L.z - lx * s + lz * c] as P2));
  return rockSolid({ plan, y0: -5.5, yg: -3.2, top: L.top - 0.24, taper: [0.03, 0.09], ch: 0.3, chIn: 0.25, maxStep: 0.24, band: 2.4, seed: 31, colBot: -5.5, kind: "landing" });
})();

// ------------------------------------------------------------------------------------------------ beach cover
/** cargo spill / wreckage on the beach (world): kind, x, z, yaw, half extents; y from the ground (client) — the
 *  collider reaches 0.6 m into the sand so the sampled ground never shows a gap */
export interface Cover { k: string; x: number; z: number; yaw: number; h: V3; gy: number }
export const COVER: Cover[] = [
  { k: "longboat", x: 30.5, z: -649.5, yaw: 0.5, h: [2.6, 0.55, 0.95], gy: 0.35 },
  { k: "crates", x: 13.0, z: -652.5, yaw: 0.3, h: [0.6, 0.6, 0.6], gy: 0.75 },
  { k: "barrels", x: 15.2, z: -653.8, yaw: 1.1, h: [0.55, 0.55, 0.55], gy: 0.6 },
  { k: "cannonbeach", x: -6.0, z: -666.0, yaw: 2.0, h: [1.2, 0.45, 0.45], gy: 0.2 },
  { k: "crates", x: -27.0, z: -683.0, yaw: 0.8, h: [0.65, 0.65, 0.65], gy: 0.5 },
  { k: "mastlog", x: 2.0, z: -650.0, yaw: -0.25, h: [4.5, 0.42, 0.42], gy: 1.1 },
  { k: "crates", x: 45.5, z: -646.5, yaw: -0.3, h: [0.6, 0.6, 0.6], gy: 0.3 },
  { k: "barrels", x: 77.5, z: -640.0, yaw: 0.2, h: [0.5, 0.55, 0.5], gy: 0.6 },
  { k: "crates", x: 99.0, z: -652.0, yaw: 0.9, h: [0.6, 0.6, 0.6], gy: 0.35 },
  { k: "mastlog", x: 66.0, z: -637.5, yaw: 0.15, h: [3.2, 0.36, 0.36], gy: 0.9 },
  // backshore + west beach cover (low: the poi-16-wreck-bay view's corridor stays open)
  { k: "crates", x: 40.0, z: -620.0, yaw: 0.4, h: [0.62, 0.9, 0.62], gy: 2.6 },
  { k: "crates", x: 27.0, z: -614.0, yaw: 1.3, h: [0.6, 0.76, 0.6], gy: 3.0 },
  { k: "crates", x: 16.0, z: -621.5, yaw: 0.4, h: [0.66, 0.66, 0.66], gy: 2.8 },
  { k: "crates", x: 8.5, z: -626.0, yaw: -0.5, h: [0.6, 0.62, 0.6], gy: 2.85 },
  { k: "crates", x: 5.0, z: -632.0, yaw: -0.3, h: [0.65, 0.62, 0.65], gy: 2.65 },
  { k: "crates", x: 14.0, z: -640.0, yaw: 0.9, h: [0.6, 0.6, 0.6], gy: 1.6 },
  { k: "crates", x: -10.0, z: -636.0, yaw: 0.2, h: [0.6, 0.62, 0.6], gy: 2.9 },
  { k: "crates", x: 75.5, z: -645.5, yaw: 0.2, h: [0.6, 0.64, 0.6], gy: 0.6 },
  { k: "crates", x: 20.5, z: -633.0, yaw: 1.0, h: [0.6, 0.62, 0.6], gy: 1.96 },
  { k: "crates", x: 42.5, z: -645.0, yaw: 0.7, h: [0.58, 0.66, 0.58], gy: 0.6 },
  { k: "mastlog", x: -40.0, z: -678.0, yaw: 1.1, h: [3.6, 0.45, 0.45], gy: 1.7 },
  { k: "longboat", x: -24.0, z: -668.0, yaw: 1.2, h: [2.6, 0.55, 0.95], gy: 1.45 },
  // washed-up cargo closing the last > 8 m gaps of the cover lattice
  { k: "barrels", x: 34.5, z: -646.0, yaw: 1.4, h: [0.62, 0.68, 0.62], gy: 0.31 },
  { k: "crates", x: 22.0, z: -628.0, yaw: 0.3, h: [0.6, 0.62, 0.6], gy: 2.08 },
  { k: "crates", x: -19.0, z: -664.0, yaw: 1.1, h: [0.6, 0.68, 0.6], gy: 1.46 },
];
/** where a cover piece stands: the lowest baked ground under its footprint (from the rock-ground bake; a
 *  hand-typed gy goes stale when the terrain changes) − 3 cm. The client draws it from here, the collider is
 *  [base − 0.6, base + 2·h[1]]: drawn top ≡ collider top. */
export const coverBase = (cv: Cover) => (ROCK_GROUND[`c:${rockKey(cv)}`]?.[0] ?? cv.gy) - 0.03;
{
  for (const cv of COVER) { const b = coverBase(cv); Wd("cover", [cv.x, b + cv.h[1] - 0.3, cv.z], [cv.h[0], cv.h[1] + 0.3, cv.h[2]], 2, cv.yaw); }
}
/** palms planted by the POI (client → veg api "palm-leaning" / "palm"); each gets a trunk collider at its base */
export const PALMS: Array<{ x: number; z: number; yaw: number; s: number; lean: boolean; g: number }> = [
  // (veg "palm-leaning" leans along its local +x: yaw 1.57 = north over the water, 2.6 = WNW over the beach)
  // g = the baked terrain under the trunk (the trunk collider stands on it)
  { x: 58.0, z: -649.5, yaw: 2.55, s: 1.2, lean: true, g: 0.1 },
  { x: 80.5, z: -634.0, yaw: 1.9, s: 1.05, lean: true, g: 3.26 },
  { x: 72.0, z: -633.5, yaw: 0.0, s: 0.95, lean: false, g: 2.95 },
  { x: 29.5, z: -636.5, yaw: 1.4, s: 1.1, lean: true, g: 1.27 },
  { x: 25.5, z: -642.0, yaw: 1.75, s: 1.0, lean: true, g: 0.97 },
  { x: 8.5, z: -646.0, yaw: 1.3, s: 1.05, lean: true, g: 1.31 },
  { x: -12.0, z: -660.0, yaw: 1.9, s: 1.1, lean: true, g: 1.21 },
  { x: -30.0, z: -674.5, yaw: 1.2, s: 1.0, lean: true, g: 1.21 },
  { x: 92.0, z: -619.5, yaw: 0.0, s: 1.0, lean: false, g: 4.99 },
  { x: 111.0, z: -636.5, yaw: 2.3, s: 1.15, lean: true, g: 4.55 },
];
/** the baked ground under a palm's trunk (rock-ground bake), else its typed g */
export const palmBase = (p: { x: number; z: number; g: number }) => ROCK_GROUND[`p:${rockKey(p)}`]?.[0] ?? p.g;
// a leaning trunk leaves a vertical box above ~2 m: its collider stops there (bullets pass the leaning crown)
for (const p of PALMS) { const g = palmBase(p), top = p.lean ? 2.0 : 4.6; Wd("trunk", [p.x, g + (top - 0.6) / 2, p.z], [0.17, (top + 0.6) / 2, 0.17], 2, 0, "wood"); }

// ================================================================================================ interiors (kit)
/** the galleon's rooms, furnished by the shared interiors kit, in the SHIP FRAME (x toward the bow, z across the beam,
 *  y = the deck top on the centreline; yaw 0 = room local x along the keel). Kit sides: 0 = +z (sea side), 1 = +x (bow),
 *  2 = −z (shore side), 3 = −x (stern). Every room is a rectangle inside the hull lining; the kit's finish is off (the
 *  ship draws its own decks, lining, deck heads, windows) — the kit adds furniture, lanterns + light pools, clutter,
 *  loot slots. Colliders / loot go through `shipBoxes` / `shipToWorld` (the frame is listed). */
const win = (side: 0 | 1 | 2 | 3, at: number, w = 1.0, y0 = 1.0, h = 0.9): RoomOpening => ({ side, at, w, kind: "window", y0, h });
const gap = (side: 0 | 1 | 2 | 3, at: number, w: number): RoomOpening => ({ side, at, w, kind: "gap" });
const SHIP_FIN = { floor: "none", wall: null, dado: null, baseboard: false, ceiling: "none", frames: false, glass: false, curtains: false } as const;
/** sides of a ship room that are NOT a real wall (open to the next room / in front of the guns): no wall decor there */
const VIRTUAL: Record<string, Side[]> = { "gun-room": [0, 1, 2], "gun-mid": [0, 1, 2, 3], "gun-fwd": [0, 2, 3], "hold-aft": [1], "hold-fwd": [1, 3], forecastle: [1] };
const mastKeep = (mx: number, cx: number, r = 0.62): [number, number, number, number] => [mx - cx - r, -r, mx - cx + r, r];
export const SHIP_ROOMS: InteriorRoom[] = (() => {
  const R: InteriorRoom[] = [];
  const room = (id: string, x0: number, x1: number, y: number, d: number, role: InteriorRoom["role"], seed: number, openings: RoomOpening[], keepOut: InteriorRoom["keepOut"] = [], density = 1) => {
    const cx = (x0 + x1) / 2;
    R.push({ id, x: cx, y, z: 0, yaw: 0, w: x1 - x0, d, h: 3.2 - SLAB, style: "cabin", role, seed, density, finish: { ...SHIP_FIN }, wallT: 0.32,
      openings: openings.map((o) => ({ ...o, at: o.side === 0 || o.side === 2 ? o.at - cx : o.at })), keepOut });
  };
  // GREAT CABIN (main deck, under the quarterdeck): door + 2 windows in the front bulkhead, 4 stern-gallery windows,
  // 3 windows a side; the mizzen passes through it
  room("great-cabin", -17.55, -7.3, LV.main, 7.6, "captain", 11,
    [{ side: 1, at: 0, w: 1.3, kind: "door" }, win(1, -2.5), win(1, 2.5), ...[-3.2, -1.1, 1.1, 3.2].map((u) => win(3, u, 1.1, 1.0, 1.0)),
      ...[-15.5, -12, -9].flatMap((x) => [win(0, x), win(2, x)])],
    [mastKeep(MASTS[2].x, (-17.55 - 7.3) / 2)]);
  // CHART ROOM (quarterdeck, under the poop)
  room("chart-room", -17.55, -12.74, LV.qd, 7.2, "captain", 12,
    [{ side: 1, at: -SH * 0.85, w: 1.3, kind: "door" }, win(1, SH * 2.1), ...[-2.2, 0, 2.2].map((u) => win(3, u, 1.0, 1.0, 0.8)),
      ...[-16, -14].flatMap((x) => [win(0, x, 0.9, 1.0, 0.8), win(2, x, 0.9, 1.0, 0.8)])]);
  // FORECASTLE crew quarters (main deck, under the forecastle): door + window aft, a window a side; the foremast
  room("forecastle", 9.35, 14.6, LV.main, 6.4, "crew", 13,
    [{ side: 3, at: 0, w: 1.3, kind: "door" }, win(3, 2.45, 0.9, 1.0, 0.8), win(0, 11.85, 0.9, 1.0, 0.8), win(2, 11.85, 0.9, 1.0, 0.8)],
    [mastKeep(MASTS[0].x, (9.35 + 14.6) / 2)]);
  // GUN DECK aft: the gun room (stern) + the mid gun deck (→ the gun hatch): crew hammocks between the guns; gaps keep
  // gun ports on both sides reachable
  room("gun-room", -17.0, -10.9, LV.gun, 6.2, "crew", 14, [gap(0, -13.5, 1.3), gap(2, -13.5, 1.3), gap(1, 0, 3.0)]);
  {
    const x0 = -10.9, x1 = -1.6, cx = (x0 + x1) / 2;
    room("gun-mid", x0, x1, LV.gun, 6.2, "crew", 18, [gap(3, 0, 3.0), gap(0, -5.5, 1.3), gap(2, -9.5, 1.3), gap(1, 0, 2.4)],
      [[HATCH_GUN.x0 - 0.3 - cx, HATCH_GUN.z0 - 0.3, HATCH_GUN.x1 + 0.2 - cx, HATCH_GUN.z1 + 0.3], { r: [HATCH_GUN.x0 - 1.6 - cx, -0.7, HATCH_GUN.x0 - 0.3 - cx, 0.7], walk: true }, mastKeep(MASTS[2].x, cx)]);
  }
  // GUN DECK forward (the main-hatch stair's foot → the bow)
  {
    const x0 = 4.6, x1 = 14.6, cx = (x0 + x1) / 2;
    room("gun-fwd", x0, x1, LV.gun, 5.0, "crew", 15, [gap(3, 0, 2.2), gap(0, 6.5, 1.3), gap(2, 10.5, 1.3)], [mastKeep(MASTS[0].x, cx)]);
  }
  // THE HOLD: crew berths aft + forward; the waist (x −8.4 … 6.6: breach, stair foot, cargo stacks) stays the cargo hold
  room("hold-aft", -15.6, -8.5, LV.hold, 9.0, "crew", 16, [gap(1, 0, 6.0)], [mastKeep(MASTS[2].x, (-15.6 - 8.5) / 2)]);
  room("hold-fwd", 7.0, 12.6, LV.hold, 6.8, "crew", 17, [gap(3, 0, 5.0)], [mastKeep(MASTS[0].x, (7.0 + 12.6) / 2)]);
  return R;
})();

/** the hull lining's inner face (|z|, ship frame) on side `sd` (±1) at (x, y): the lining pieces are straight chords
 *  between the hull stations, 0.32 m thick — furniture / decor placed against a room's hull wall snaps to it */
function liningZ(sd: number, x: number, y: number): number | null {
  let best: number | null = null;
  for (const p of PIECES) {
    if (p.k !== "lining" || p.f !== "ship" || Math.sign(p.c[2]) !== sd || Math.abs(y - p.c[1]) > p.h[1] + 0.3) continue;
    const yw = p.yaw ?? 0, cs = dmath.cos(yw), sn = dmath.sin(yw);
    // along-wall coordinate of x (local x axis = (cos, −sin) in (x, z)) — the chord spans ±hx
    const u = (x - p.c[0]) / Math.max(0.2, cs);
    if (Math.abs(u) > p.h[0] + 0.05) continue;
    // inner face: the side of the box toward z = 0 (local z axis = (sin, cos))
    const zc = p.c[2] - u * sn, zi = Math.abs(zc) - p.h[2] / Math.max(0.2, Math.abs(cs));
    if (best === null || zi < best) best = zi;
  }
  return best;
}
/** the ship rooms' layouts: the kit's layout, then furniture against a hull side slides out to the (curved, tumbling-home)
 *  lining, wall decor moves onto the lining, and decor on an open side (no wall) is dropped. Colliders re-derived. */
export const SHIP_LAYOUTS: InteriorLayout[] = SHIP_ROOMS.map((room) => {
  const L = furnishRoom(room);
  const virt = VIRTUAL[room.id ?? ""] ?? [];
  const hd = room.d / 2, hw = room.w / 2;
  const items: InteriorItem[] = L.items.map((it) => ({ ...it }));
  const rects = items.map((it) => itemRect(it));
  // the wall an item stands against: its rect touches that wall AND it faces away from it (kit wall yaw: side 0 → π,
  // 1 → −π/2, 2 → 0, 3 → π/2); decor faces the same way
  const SIDE_YAW = [Math.PI, -Math.PI / 2, 0, Math.PI / 2];
  const yawIs = (a: number, b: number) => Math.abs(dmath.atan2(dmath.sin(a - b), dmath.cos(a - b))) < 0.35;
  const sideOf = (r: { x0: number; z0: number; x1: number; z1: number }, yaw: number): Side | -1 => {
    const touch = [r.z1 > hd - 0.12, r.x1 > hw - 0.12, r.z0 < -hd + 0.12, r.x0 < -hw + 0.12];
    for (const s of [0, 1, 2, 3] as Side[]) if (touch[s] && yawIs(yaw, SIDE_YAW[s])) return s;
    return -1;
  };
  const isDecor = (it: InteriorItem) => it.col === 0 && it.y > 0.3 && it.d < 0.12;
  /** room-local |z| of the lining over an x-range and a height range (min) */
  const wallAt = (sd: number, x0: number, x1: number, y0: number, y1: number) => {
    let wz = Infinity;
    for (const x of [x0, (x0 + x1) / 2, x1]) for (const yy of [y0, y1]) { const z = liningZ(sd, room.x + x, room.y + yy); if (z !== null) wz = Math.min(wz, z); }
    return wz;
  };
  const drop = new Set<number>();
  const shift = new Array<number>(items.length).fill(0), anchor = new Array<boolean>(items.length).fill(false);
  items.forEach((it, i) => {
    const r = rects[i], side = sideOf(r, it.yaw);
    if (side < 0) return;
    if (virt.includes(side as Side)) { if (isDecor(it)) drop.add(i); return; }
    if (side !== 0 && side !== 2) return;
    const sd = side === 0 ? 1 : -1, wz = wallAt(sd, r.x0, r.x1, it.y + 0.05, it.y + Math.max(0.1, it.h));
    if (!Number.isFinite(wz)) return;
    const dz = wz - 0.03 - (sd > 0 ? r.z1 : -r.z0);
    if (dz > 0.02 || (isDecor(it) && Math.abs(dz) > 0.01)) { shift[i] = sd * dz; anchor[i] = true; }
  });
  // the rest of a wall group (chair at a desk, lamp on a desk, stools at a table) follows its anchor
  items.forEach((it, i) => {
    if (anchor[i] || isDecor(it)) return;
    const r = rects[i];
    let best = 0;
    items.forEach((_, j) => {
      if (!anchor[j] || isDecor(items[j])) return;
      const a = rects[j];
      if (r.x1 < a.x0 - 0.1 || r.x0 > a.x1 + 0.1) return;
      const gapZ = shift[j] > 0 ? a.z0 - r.z1 : r.z0 - a.z1; // how far inboard of the anchor
      if (gapZ > 0.9 || (shift[j] > 0 ? r.z0 > a.z1 : r.z1 < a.z0)) return;
      if (best === 0 || Math.abs(shift[j]) < Math.abs(best)) best = shift[j];
    });
    shift[i] = best;
  });
  // sparse walkable decks: no knee-high clutter piles, stools or second hammock, one plunder heap (the great
  // cabin's); the cover pieces (sea chests, crates, barrels, tables, desks, shelves) stay
  let hammocks = 0;
  items.forEach((it, i) => {
    const t: string = it.kind;
    if (t === "clutter" || t === "stool" || (t === "treasure" && room.id !== "great-cabin") || (t === "hammock" && hammocks++ > 0)) drop.add(i);
  });
  const out: InteriorItem[] = [];
  items.forEach((it, i) => { if (!drop.has(i)) out.push({ ...it, z: it.z + shift[i] }); });
  // chest slots against a hull side slide out too (their back ≈ 0.45 m from the lining)
  const chests = L.loot.chests.map(([x, y, z, yaw]) => {
    const sd = Math.sign(z - room.z) || 1, lz = Math.abs(z - room.z);
    if (lz < hd - 0.9 || virt.includes(sd > 0 ? 0 : 2)) return [x, y, z, yaw] as [number, number, number, number];
    const wz = wallAt(sd, x - room.x - 0.5, x - room.x + 0.5, 0.05, 0.7);
    const nz = Number.isFinite(wz) ? Math.max(lz, wz - 0.45) : lz;
    return [x, y, room.z + sd * nz, yaw] as [number, number, number, number];
  });
  const colliders = out.filter((it) => it.col).flatMap((it) => itemColliders(room, it));
  return { ...L, items: out, colliders, loot: { chests, floor: L.loot.floor } };
});

/** the galleon's rooms in the WORLD frame, for the loot generator's census only (shared/pois/index.ts
 *  interiorRoomsById): its ceiling scan cannot see the listed decks (every deck is cut into < 1.6 m strips), so without
 *  this the ship would be no building at all — no room units, no house gun. Declared here,
 *  every cabin / gun deck / hold room is a room of ONE building (the ship) with a storey per deck. The client never
 *  builds these (SHIP_LAYOUTS draws + collides the rooms in the listed frame). */
export const LOOT_ROOMS: InteriorRoom[] = SHIP_ROOMS.map((r) => {
  const [x, y, z] = shipToWorld(r.x, r.y, r.z);
  return { ...r, id: `ship:${r.id}`, x, y, z, yaw: shipYaw(r.yaw) };
});
/** the galleon is the POI's payoff: a HOT building (chests on every deck + the poop roof, hot rarity) */
export const LOOT_HOT = [{ x: SHIP.x, z: SHIP.z, r: 18, chests: 3, roof: 1 }];

/** the stilt huts' single rooms (WORLD frame, kit convention — the match generator reads these directly) */
export const INTERIOR_ROOMS: InteriorRoom[] = SHACKS.map((s, i) => {
  const hw = s.w / 2, hd = s.d / 2, T = s.t;
  const openings: RoomOpening[] = [{ side: 0, at: s.doorU - hw, w: 1.2, kind: "door", h: 2.2 }];
  for (const [side, u] of s.windows) {
    const at = side === 0 ? u - hw : side === 1 ? hd - u : side === 2 ? hw - u : -hd + u;
    openings.push({ side, at, w: 1.1, kind: "window", y0: 1.0, h: 0.85 });
  }
  return { id: s.id, x: s.x, y: s.y, z: s.z, yaw: s.yaw, w: s.w - 2 * T, d: s.d - 2 * T, h: s.wallH, style: "hut", role: i ? "bunk" : "fisher", seed: 21 + i,
    openings, wallT: T, finish: { floor: "none", wall: null, dado: null, ceiling: "none", frames: false, glass: false, curtains: false, baseboard: false } };
});

// ================================================================================================ exports
// ------------------------------------------------------------------------------------------------ deck / wall seams
/** where a deck's drawn planking starts aft: 0.25 m INTO the transom (the collider strips stop at its inner face) */
export const DECK_X0: Record<string, number> = { main: -17.93, qd: -17.93, poop: -17.93, gun: -17.7, hold: -15.95 };
const SEAM_WALLS = new Set(["lining", "transom", "sweep"]);
let _seamWalls: WPiece[] | null = null;
/** is the ship-frame point inside a hull wall (the drawn lining board reaches 0.35 m below its box)? */
export function inHullWall(x: number, y: number, z: number): boolean {
  _seamWalls ??= PIECES.filter((p) => p.f === "ship" && SEAM_WALLS.has(p.k));
  return _seamWalls.some((p) => {
    const yaw = p.yaw ?? 0, c = dmath.cos(yaw), s = dmath.sin(yaw), dx = x - p.c[0], dz = z - p.c[2];
    const drop = p.k === "lining" ? 0.35 : 0;
    return Math.abs(dx * c - dz * s) <= p.h[0] + 1e-3 && Math.abs(dx * s + dz * c) <= p.h[2] + 1e-3 && y >= p.c[1] - p.h[1] - drop && y <= p.c[1] + p.h[1];
  });
}
/** the smallest |z| ≥ zmin (on side sd) inside a hull wall at (x, y) — exact: each yawed box cut by the line is an
 *  interval in z (Infinity when none) */
function wallFrom(x: number, y: number, sd: 1 | -1, zmin: number): number {
  _seamWalls ??= PIECES.filter((p) => p.f === "ship" && SEAM_WALLS.has(p.k));
  let best = Infinity;
  for (const p of _seamWalls) {
    const drop = p.k === "lining" ? 0.35 : 0;
    if (y < p.c[1] - p.h[1] - drop || y > p.c[1] + p.h[1]) continue;
    const yaw = p.yaw ?? 0, c = dmath.cos(yaw), s = dmath.sin(yaw), dx = x - p.c[0];
    // u = dx·c − dz·s, v = dx·s + dz·c with dz = sd·z − pz  →  |A + B·z| ≤ h
    let lo = -Infinity, hi = Infinity;
    for (const [A, B, h] of [[dx * c + p.c[2] * s, -sd * s, p.h[0] + 1e-3], [dx * s - p.c[2] * c, sd * c, p.h[2] + 1e-3]] as Array<[number, number, number]>) {
      if (Math.abs(B) < 1e-9) { if (Math.abs(A) > h) { lo = Infinity; break; } continue; }
      const a = (-h - A) / B, b = (h - A) / B;
      lo = Math.max(lo, Math.min(a, b)); hi = Math.min(hi, Math.max(a, b));
    }
    if (lo > hi || hi < zmin) continue;
    best = Math.min(best, Math.max(lo, zmin));
  }
  return best;
}
/** the drawn deck's half width at x (ship.ts deckGeo) */
export const deckEdge = (d: Deck, x: number) => {
  const e = Math.max(0.05, hb(x, d.y - 0.15) - 0.18);
  // at the deck's fore end (the bow tip / a bulkhead) no lining stands on the edge: run the planking out to the shell
  return x > d.x1 - 0.45 ? Math.max(e, Math.min(hb(x, d.y), hb(x, d.y - 0.3)) - 0.03) : e;
};
/** the waterway SKIRTS: where the hull wall above a deck stands outboard of the deck's edge (the raked bow, the stern
 *  run, the tumblehome steps) a sloped board runs from under the deck edge up into the wall face — no slit between the
 *  planking and the lining shows the sea. Per side: [x, z at the deck edge, z of the wall face 0.45 m up]. */
export function deckSkirts(d: Deck): Array<{ sd: 1 | -1; pts: Array<[number, number, number]> }> {
  const out: Array<{ sd: 1 | -1; pts: Array<[number, number, number]> }> = [];
  const x0 = DECK_X0[d.id] ?? d.x0;
  for (const sd of [1, -1] as const) {
    let run: Array<[number, number, number]> = [];
    for (let x = x0; x <= d.x1 + 1e-6; x += 0.1) {
      const e = deckEdge(d, x);
      // the wall face just above the deck: the first z ≥ e − 0.6 (outward) inside a hull wall at either height —
      // solved per wall box as an interval (a 1 cm march costs ~2.5 s of main thread on the client)
      const z = Math.max(e - 0.6, Math.min(wallFrom(x, d.y + 0.05, sd, e - 0.6), wallFrom(x, d.y + 0.45, sd, e - 0.6)));
      const open = z >= e + 0.9 || HULL_OPS.some((o) => o.side === sd && (o.kind === "breach" || o.kind === "gap") && x > o.x0 - 0.2 && x < o.x1 + 0.2 && d.y + 0.2 > o.y0 && d.y < o.y1);
      if (open || z < e - 0.07) { if (run.length === 1) run.push([run[0][0] + 0.1, run[0][1], run[0][2]]); if (run.length > 1) out.push({ sd, pts: run }); run = []; continue; }
      run.push([x, e, z]);
    }
    if (run.length > 1) out.push({ sd, pts: run });
  }
  return out;
}

/** a SHIP-frame box (centre, half extents, three.js yaw within the frame) → yaw-only world colliders. The frame is
 *  listed (rolled) but the sim's boxes only yaw, so the box is cut into cells ≤ 1.0 m tall and ≤ 1.7 m across the beam,
 *  each placed at its own rolled centre: a drawn face and its collider then agree within sin(9°)·0.85 ≈ 0.13 m across the
 *  beam, sin(4.5°)·0.85 ≈ 0.07 m along it and ±0.08 m up and down (tolerance 0.15 m). */
export function shipBoxes(c: V3, h: V3, yaw: number, surf: Surface, noShoot = false, split = true): Box[] {
  const cy = dmath.cos(yaw), sy = dmath.sin(yaw);
  // local x spans (cos, −sin)·2hx of the frame's (x, z), local z (sin, cos)·2hz: both the list (across the beam, z)
  // and the trim (along the keel, x) tilt a long box, so its footprint is cut to ≤ 1.7 m along both frame axes
  // (cells ≤ 1.25 m across the beam — the list — and ≤ 1.4 m along it — the trim: 0.63·sin 9° + 0.7·sin 4.5° < 0.15 m)
  const nX = split ? Math.max(1, Math.ceil(Math.max((2 * h[0] * Math.abs(sy)) / 1.25, (2 * h[0] * Math.abs(cy)) / 1.4) - 1e-6)) : 1;
  const nZ = split ? Math.max(1, Math.ceil(Math.max((2 * h[2] * Math.abs(cy)) / 1.25, (2 * h[2] * Math.abs(sy)) / 1.4) - 1e-6)) : 1;
  const nY = split && 2 * h[1] > 1.05 ? Math.ceil((2 * h[1]) / 1.0 - 1e-6) : 1;
  const out: Box[] = [];
  const hx = h[0] / nX, hy = h[1] / nY, hz = h[2] / nZ, wy = -shipYaw(yaw);
  for (let i = 0; i < nX; i++) for (let j = 0; j < nY; j++) for (let k = 0; k < nZ; k++) {
    const ox = -h[0] + (2 * i + 1) * hx, oy = -h[1] + (2 * j + 1) * hy, oz = -h[2] + (2 * k + 1) * hz;
    // local x → frame (cos, −sin), local z → frame (sin, cos)   (three.js Ry)
    const fx = c[0] + ox * cy + oz * sy, fz = c[2] - ox * sy + oz * cy;
    const b: Box = { c: shipToWorld(fx, c[1] + oy, fz), h: [hx, hy, hz], yaw: wy, surf };
    if (noShoot) b.noShoot = true;
    out.push(b);
  }
  return out;
}
/** piece → world colliders */
function toBoxes(p: WPiece): Box[] {
  if (p.f === "ship") return shipBoxes(p.c, p.h, p.yaw ?? 0, p.surf ?? "wood", !!p.noShoot);
  const b: Box = { c: [...p.c] as V3, h: [p.h[0], p.h[1], p.h[2]], yaw: -(p.yaw ?? 0), surf: p.surf ?? "wood" };
  if (p.noShoot) b.noShoot = true;
  return [b];
}
/** the kit's furniture colliders of the ship rooms (ship frame, sim yaw) → world */
const shipRoomColliders = (): Box[] => SHIP_LAYOUTS.flatMap((l) => l.colliders).flatMap((b) => shipBoxes(b.c as V3, b.h as V3, -(b.yaw ?? 0), b.surf ?? "wood", !!b.noShoot));
export const colliders: Box[] = [
  ...PIECES.filter((p) => p.col > 0).flatMap(toBoxes),
  ...shipRoomColliders(),
  ...interiorColliders(INTERIOR_ROOMS),
  ...ROCK_SOLIDS.flatMap((ss, i) => (ROCKS[i].col ? ss.flatMap((s) => s.boxes) : [])),
  ...LANDING_SOLID.boxes,
];

/** areas vegetation / random scatter must leave clear (the POI dresses them itself). Circles or yaw-rotated rects. */
export const clearings: Array<{ x: number; z: number; r: number } | { x: number; z: number; hx: number; hz: number; yaw?: number }> = [
  { x: 72, z: -644, hx: 26, hz: 12, yaw: -0.05 },          // the camp beach (tent, fire, hut A, cover)
  { x: 44, z: -635, r: 8 },                                // the backshore behind the fire (the poi-16-wreck-bay view's corridor)
  { x: 94.5, z: -629.5, r: 6.5 },                          // hut B
  { x: TOWER.x, z: TOWER.z, r: 5.5 },                      // lookout
  { x: 58, z: -664, hx: 5, hz: 14, yaw: -0.23 },           // boardwalk
  { x: 30.5, z: -649.5, r: 4 },                            // longboat
  { x: 2, z: -650, hx: 6, hz: 2 },                         // mast log
];

/** the nearest spot (≤ 0.9 m away) where a loot capsule rests on ONE collider top without touching anything else — the
 *  match generator's validateSpot test (no push, no lift, no head bump), done analytically on this POI's own boxes */
function settleSpot(p: V3): V3 {
  const R = 0.36, near = colliders.filter((b) => dmath.hypot(b.c[0] - p[0], b.c[2] - p[2]) < dmath.hypot(b.h[0], b.h[2]) + 1.5 && Math.abs(b.c[1] - p[1]) < b.h[1] + 3);
  const loc = (b: Box, x: number, z: number) => { const yw = b.yaw ?? 0, c = dmath.cos(yw), s = dmath.sin(yw), dx = x - b.c[0], dz = z - b.c[2]; return [dx * c + dz * s, -dx * s + dz * c]; };
  const dist = (b: Box, x: number, z: number) => { const [lx, lz] = loc(b, x, z); return dmath.hypot(Math.max(0, Math.abs(lx) - b.h[0]), Math.max(0, Math.abs(lz) - b.h[2])); };
  // well inside (5 cm): the spot is rounded to the centimetre when exported
  const inside = (b: Box, x: number, z: number) => { const [lx, lz] = loc(b, x, z); return Math.abs(lx) < b.h[0] - 0.05 && Math.abs(lz) < b.h[2] - 0.05; };
  const ok = (x: number, z: number): number | null => {
    let fy = -Infinity;
    for (const b of near) { const t = b.c[1] + b.h[1]; if (!b.noShoot && b.h[0] > 0.3 && b.h[2] > 0.3 && t > p[1] - 0.35 && t < p[1] + 0.3 && inside(b, x, z)) fy = Math.max(fy, t); }
    if (!Number.isFinite(fy)) return null;
    for (const b of near) {
      const t = b.c[1] + b.h[1], bot = b.c[1] - b.h[1];
      if (t <= fy + 0.03 || bot >= fy + 0.75) continue;
      if (dist(b, x, z) < R) return null;
    }
    return fy;
  };
  for (let r = 0; r <= 0.9 + 1e-6; r += 0.1) {
    const n = r ? 16 : 1;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2, x = p[0] + dmath.cos(a) * r, z = p[2] + dmath.sin(a) * r, fy = ok(x, z);
      if (fy !== null) return [x, fy, z];
    }
  }
  return p;
}
/** designed loot (the LOOT_SPOTS contract): world metres, y = the floor the loot stands on */
export const LOOT_SPOTS: { chests: [number, number, number, number][]; floor: [number, number, number][] } = (() => {
  const chests: [number, number, number, number][] = [];
  const floor: [number, number, number][] = [];
  // ship-frame spots: y = the deck top on the centreline → the true (listed) floor height at that point
  // the listed decks are cut into strips / cells (each its own height): a spot is SETTLED onto the nearest place where a
  // loot capsule (r 0.36, 0.65 m tall) sits on one cell without touching a higher neighbour, a wall or a prop
  const sp = (x: number, lvl: number, z: number): V3 => settleSpot(shipToWorld(x, lvl, z));
  const ch = (x: number, lvl: number, z: number, yawL: number) => { const w = sp(x, lvl, z); chests.push([+w[0].toFixed(2), +w[1].toFixed(2), +w[2].toFixed(2), +(shipYaw(yawL)).toFixed(3)]); };
  const fl = (x: number, lvl: number, z: number) => { const w = sp(x, lvl, z); floor.push([+w[0].toFixed(2), +w[1].toFixed(2), +w[2].toFixed(2)]); };
  // the ship's rooms: the interiors kit's slots (ship frame → world; the list tilts the floor under them)
  for (const { loot: l } of SHIP_LAYOUTS) {
    for (const [x, y, z, yaw] of l.chests) { const w = sp(x, y, z); chests.push([+w[0].toFixed(2), +w[1].toFixed(2), +w[2].toFixed(2), +shipYaw(yaw).toFixed(3)]); }
    for (const [x, y, z] of l.floor) { const w = sp(x, y, z); floor.push([+w[0].toFixed(2), +w[1].toFixed(2), +w[2].toFixed(2)]); }
  }
  // the galleon is the payoff: more chest slots below decks (on the cargo, by the guns, the cabin tables) — the
  // generator's hot-building pass (LOOT_HOT) lights ~3 a deck from these + the kit's
  ch(2.8, LV.hold, 0.0, 0); ch(-5.0, LV.hold, 2.6, Math.PI); ch(-11.5, LV.hold, 0.0, 0); ch(10.0, LV.hold, 0.0, Math.PI);
  ch(-8.5, LV.gun, 0.6, 0); ch(8.5, LV.gun, 0.0, Math.PI); ch(-15.0, LV.gun, 0.0, 0); ch(0.0, LV.gun, -SH * 1.6, 0);
  ch(-13.0, LV.main, 0.0, 0); ch(11.0, LV.main, 1.8, Math.PI); ch(-15.5, LV.qd, 0.0, 0);
  // + wall chest slots in every ship room (ship frame: 0.55 m off the room's walls, facing in, ≥ 2.4 m apart,
  // clear of the kit's furniture + 0.4 m, the keep-outs, the doorways / gaps) — the hot pass picks ≥ 6 m apart per deck
  SHIP_ROOMS.forEach((r, ri) => {
    const Lr = SHIP_LAYOUTS[ri], hw = r.w / 2, hd = r.d / 2;
    const rects = Lr.items.filter((it) => it.col).map((it) => { const q = itemRect(it); return [q.x0 - 0.4, q.z0 - 0.4, q.x1 + 0.4, q.z1 + 0.4]; });
    for (const k of r.keepOut ?? []) { const q = Array.isArray(k) ? k : k.r; rects.push([q[0] - 0.3, q[1] - 0.3, q[2] + 0.3, q[3] + 0.3]); }
    const took: Array<[number, number]> = [];
    const SIDE_YAW = [Math.PI, -Math.PI / 2, 0, Math.PI / 2];
    for (const side of [0, 1, 2, 3] as const) {
      const len = side === 0 || side === 2 ? r.w : r.d;
      for (let u = -len / 2 + 0.9; u <= len / 2 - 0.9 + 1e-6; u += 0.6) {
        const lx = side === 0 || side === 2 ? u : side === 1 ? hw - 0.55 : -hw + 0.55;
        const lz = side === 1 || side === 3 ? u : side === 0 ? hd - 0.55 : -hd + 0.55;
        if (r.openings.some((o) => o.side === side && o.kind !== "window" && Math.abs(u - o.at) < o.w / 2 + 0.7)) continue;
        if (rects.some((q) => lx > q[0] && lx < q[2] && lz > q[1] && lz < q[3])) continue;
        if (took.some((t) => dmath.hypot(t[0] - lx, t[1] - lz) < 2.4)) continue;
        // the hull lining curves in: keep the slot inside the hull at the room's height (0.55 m clear of it)
        if (Math.abs(r.z + lz) > hb(r.x + lx, r.y + 0.5) - 0.85) continue;
        took.push([lx, lz]);
        ch(r.x + lx, r.y, r.z + lz, r.yaw + SIDE_YAW[side]);
      }
    }
  });
  // crow's nest
  { const a = Math.PI * 1.25, r = (NEST.rIn + NEST.rOut) / 2, w = sp(MASTS[1].x + dmath.cos(a) * r, NEST.y, dmath.sin(a) * r); chests.push([+w[0].toFixed(2), +w[1].toFixed(2), +w[2].toFixed(2), +shipYaw(-a).toFixed(3)]); }
  // the stilt huts: the interiors kit's slots (world frame)
  for (const room of INTERIOR_ROOMS) {
    const l = furnishRoom(room).loot;
    for (const [x, y, z, yaw] of l.chests) { const w = settleSpot([x, y, z]); chests.push([+w[0].toFixed(2), +w[1].toFixed(2), +w[2].toFixed(2), +yaw.toFixed(3)]); }
    for (const [x, y, z] of l.floor) { const w = settleSpot([x, y, z]); floor.push([+w[0].toFixed(2), +w[1].toFixed(2), +w[2].toFixed(2)]); }
  }
  // camp: the tent stores, the lookout top
  { const [x, z] = tentToWorld(-0.3, -1.3); chests.push([+x.toFixed(2), 0.49, +z.toFixed(2), TENT.yaw]); }
  { const T = TOWER, c = dmath.cos(T.yaw), s = dmath.sin(T.yaw); chests.push([+(T.x + 0.9 * c - 0.9 * s).toFixed(2), T.l2, +(T.z - 0.9 * s - 0.9 * c).toFixed(2), T.yaw]); }
  // floor loot: open decks, the hold waist, the bridge landing, the camp, the beach
  fl(-3.0, LV.main, SH * 1.5); fl(8.0, LV.main, 0.5); fl(-8.0, LV.qd, SH * 2.2); fl(13.2, LV.fc, 1.0);
  fl(-15.0, LV.poop, 0); fl(-0.5, LV.hold, -SH * 1.5); fl(2.0, LV.gun, SH * 2.2);
  floor.push([LANDING.x, LANDING.top, LANDING.z]);
  floor.push([+(FIRE.x + 2.6).toFixed(2), 0.43, +(FIRE.z + 1.0).toFixed(2)]);
  { const T = TOWER; floor.push([T.x, T.l1, T.z]); }
  // (ground spots: y = the baked terrain there)
  floor.push([30.5, 0.48, -645.5], [-20.0, 1.03, -668.5], [98.0, 0.15, -655.0]);
  return { chests, floor };
})();
