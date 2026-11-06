// poi-town: the Coconut Cove serpentine resort hotel — SHARED spec + layout (pure TS, no three). The client visuals
// (client/src/world/pois/_kit/town-hotel.ts) and the server colliders (hotelColliders) derive from this ONE layout.
//
// Geometry model: the pool-facing FACADE is a smooth curve `path` (world XZ, west → east). Positions inside the building
// are curvilinear (s, v, y): s = arc length along the facade, v = metres BEHIND the facade (along the smooth normal n,
// which points north / away from the pool for a west → east path), y = world height. The body extends `depth` metres
// behind the facade. Straight pieces between two arc positions are CHORDS (walls parallel to the facade); pieces at a
// fixed s run along the normal (partitions, stair flights) and are exactly straight.
//
// Section (v): 0 facade (arched loggia wall / porthole wall) · 0.4–2.4 loggia (balcony) · 2.4–2.6 room front wall ·
// 2.6–10.8 rooms (one per bay) · 10.8–11.0 corridor wall · 11.0–(depth−0.35) corridor · back wall. Ground floor = open
// arcade + lobby (columns, reception). Stair cores (dog-leg: flight A climbs toward the facade, landing, flight B climbs
// back) replace the room of the bay at each `stairsT`, reach every floor and the roof (bulkhead with a door).
// Stairs collide as STEP boxes (≤ 0.19 m risers) — the sim resolves boxes by yaw only, so a pitched ramp box would be a
// solid block there. Box yaw follows the three.js / town-kit convention (local +x → (cos yaw, −sin yaw) in XZ).
import type { Box, Surface } from "../world/colliders";
import { wallPieces, type Opening } from "./town-kit";
import type { InteriorRoom, RoomOpening } from "./interior-kit";
import * as dmath from "../sim/dmath";

export interface HotelSpec {
  /** facade centreline samples, world XZ, west → east, ≈ 1 sample per 1–2 m (smooth) */
  path: Array<[number, number]>;
  /** ground height (pad) */
  y: number;
  /** building depth behind the facade (m) */
  depth: number;
  /** storeys including the ground-floor arcade */
  floors: number;
  /** upper storey height */
  floorH: number;
  /** ground-floor (arcade + lobby) storey height */
  groundH: number;
  /** target bay pitch along the facade (m) */
  bay: number;
  /** coral-pink plaster panels, cream limestone trims, dark green shutters/doors */
  wall: string; trim: string; accent: string;
  /** param range [t0,t1] along the path where bays get round PORTHOLE windows instead of arched balconies (west wing) */
  portholes: [number, number];
  /** where (t along the path) the rooftop pedestal + yellow banana-bunch sculpture stands */
  sculptureT: number;
  /** stair cores at these t values (interior stairs to every floor and the roof) */
  stairsT: number[];
}

type V2 = [number, number];
export interface PathFrame { p: V2; d: V2; n: V2 }

/** frame at path vertex i: tangent d, normal n = BEHIND the facade (north for a west → east path) */
export function pathFrame(path: Array<[number, number]>, i: number): PathFrame {
  const a = path[Math.max(0, i - 1)], b = path[Math.min(path.length - 1, i + 1)];
  let dx = b[0] - a[0], dz = b[1] - a[1];
  const l = dmath.hypot(dx, dz) || 1; dx /= l; dz /= l;
  return { p: [path[i][0], path[i][1]], d: [dx, dz], n: [dz, -dx] };
}

/** total path length + cumulative arc length (m) */
export function pathArc(path: Array<[number, number]>): number[] {
  const arc = [0];
  for (let i = 1; i < path.length; i++) arc.push(arc[i - 1] + dmath.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
  return arc;
}

/** point + frame at arc-length s along the path (piecewise tangent; prefer HotelPath.at for smooth normals) */
export function pathAt(path: Array<[number, number]>, arc: number[], s: number): PathFrame {
  const L = arc[arc.length - 1];
  s = Math.max(0, Math.min(L, s));
  let i = 1; while (i < arc.length - 1 && arc[i] < s) i++;
  const t = (s - arc[i - 1]) / Math.max(1e-6, arc[i] - arc[i - 1]);
  const a = path[i - 1], b = path[i];
  const p: V2 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  let dx = b[0] - a[0], dz = b[1] - a[1]; const l = dmath.hypot(dx, dz) || 1; dx /= l; dz /= l;
  return { p, d: [dx, dz], n: [dz, -dx] };
}

/** the facade curve with smoothly interpolated normals (offset curves at any depth are continuous) */
export class HotelPath {
  readonly arc: number[];
  readonly L: number;
  private readonly vn: V2[];
  constructor(readonly pts: Array<[number, number]>) {
    this.arc = pathArc(pts);
    this.L = this.arc[this.arc.length - 1];
    this.vn = pts.map((_, i) => pathFrame(pts, i).n);
  }
  /** point, unit tangent d, unit normal n (behind) at arc length s; linear extrapolation past the ends */
  at(s: number): PathFrame {
    const { arc, pts, vn } = this, last = pts.length - 1;
    if (s <= 0 || s >= this.L) {
      const i = s <= 0 ? 0 : last, f = pathFrame(pts, i), e = s <= 0 ? s : s - this.L;
      return { p: [pts[i][0] + f.d[0] * e, pts[i][1] + f.d[1] * e], d: f.d, n: f.n };
    }
    let lo = 1, hi = last;
    while (lo < hi) { const m = (lo + hi) >> 1; if (arc[m] < s) lo = m + 1; else hi = m; }
    const i = lo, t = (s - arc[i - 1]) / Math.max(1e-6, arc[i] - arc[i - 1]);
    const a = pts[i - 1], b = pts[i];
    let nx = vn[i - 1][0] + (vn[i][0] - vn[i - 1][0]) * t, nz = vn[i - 1][1] + (vn[i][1] - vn[i - 1][1]) * t;
    const l = dmath.hypot(nx, nz) || 1; nx /= l; nz /= l;
    return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], d: [-nz, nx], n: [nx, nz] };
  }
  /** world XZ at (s, v) */
  pt(s: number, v: number): V2 { const f = this.at(s); return [f.p[0] + f.n[0] * v, f.p[1] + f.n[1] * v]; }
  /** box/matrix yaw whose local +x runs along the tangent at s (local +z then points to the FRONT) */
  yaw(s: number): number { const f = this.at(s); return dmath.atan2(-f.d[1], f.d[0]); }
}

/** straight chord between (s0, v) and (s1, v). Local frame: +x along the chord, +z toward the FRONT (pool) */
export interface Chord { ax: number; az: number; dx: number; dz: number; len: number; yaw: number; v: number }
export function chordAt(P: HotelPath, s0: number, s1: number, v: number): Chord {
  const a = P.pt(s0, v), b = P.pt(s1, v);
  let dx = b[0] - a[0], dz = b[1] - a[1]; const len = dmath.hypot(dx, dz) || 1e-6; dx /= len; dz /= len;
  return { ax: a[0], az: a[1], dx, dz, len, yaw: dmath.atan2(-dz, dx), v };
}
/** point u metres along a chord, w metres toward the front */
export function chordPt(c: Chord, u: number, w = 0): V2 { return [c.ax + c.dx * u - c.dz * w, c.az + c.dz * u + c.dx * w]; }

/** sample the serpentine from A to B (west→east convention: the FRONT is the right-hand side walking A→B): a compact S
 *  — the first half bulges toward the front (the porthole wing turns to face the view camera), the second recedes —
 *  peak-to-peak 2·amp metres, ≈ 1 sample per metre */
function serpentine(A: [number, number], B: [number, number], amp: number, n: number): Array<[number, number]> {
  const dx = B[0] - A[0], dz = B[1] - A[1], L = dmath.hypot(dx, dz), fx = -dz / L, fz = dx / L; // front = (−dz, dx)
  const out: Array<[number, number]> = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, o = amp * dmath.sin(t * Math.PI * 2) + 1.2 * (1 - dmath.cos(t * Math.PI * 2)) / 2;
    out.push([A[0] + dx * t + fx * o, A[1] + dz * t + fz * o]);
  }
  return out;
}

export const HOTEL: HotelSpec = {
  // Coconut Cove: ~57 m chord running S from the tiki bar toward the beach on the EAST side of the pool, arcade facing
  // west into the NNW sun; ±4.0 m S (a 114 m hotel with a 7 m sag read as a colosseum)
  // (at ±6.5 the concave bends had a 13 m radius for a 14 m deep block: the corridor chord of a
  //  4.55 m bay shrank to 0.76 m, the room doors were cut off and three rooms per floor were sealed)
  path: serpentine([82, 443], [92, 499], 4.0, 58),
  y: 4,
  depth: 14,
  floors: 4,
  floorH: 3.6,
  groundH: 4.2,
  bay: 4.6,
  wall: "#f4a58f", trim: "#f6ecd4", accent: "#3d6a4e",
  portholes: [0, 0.12],
  sculptureT: 0.47,
  stairsT: [0.12, 0.68, 0.9],
};

// ---------- section constants (metres; v = behind the facade, heights relative to a floor level)
export const HS = {
  /** ground floor finish above the pad */
  plinth: 0.15,
  slabT: 0.3,
  arcadeT: 0.55, facadeT: 0.4, wallT: 0.2, backT: 0.35, endT: 0.45,
  /** loggia depth → room front wall v 2.4..2.6 */
  roomFront: 2.4,
  /** corridor wall v 10.8..11.0 */
  corridor: 10.8,
  /** facade pilaster width (along s) + projection */
  pier: 0.62, pierOut: 0.22,
  /** arch springing heights: ground arcade / upper loggias */
  gSpring: 2.15, spring: 1.6,
  rail: 1.05, parapet: 1.15,
  portR: 0.74, portY: 1.8,
  /** stair: flight A starts (bottom riser) at this v and climbs toward the facade */
  flightV: 9.3, tread: 0.28, maxRiser: 0.19,
  /** roof stair bulkhead: height, back wall (v) */
  bulkH: 2.8, bulkBack: 11.2,
  /** end-wall porthole positions (v) and ground arch centre */
  endPorts: [4.4, 8.2, 12.3], endArchV: 6.2,
};

export type HWallKind = "arcade" | "loggia" | "porthole" | "roomFront" | "coreFront" | "coreSide" | "corridor" | "back" | "partition" | "spine" | "end" | "parapet" | "bulkhead";
/** a wall slab. axis "s": chord between s0..s1 at depth v0..v1 (thickness = v1 − v0). axis "v": runs along the normal at
 *  s0 from v0 to v1, thickness t along the tangent (centred on s0). Opening u = metres along the wall (from s0 / v0). */
export interface HWall {
  kind: HWallKind; axis: "s" | "v";
  s0: number; s1: number; v0: number; v1: number; t: number;
  y0: number; h: number;
  openings: Opening[];
  floor: number; bay: number;
}
export interface HotelBay { i: number; s0: number; s1: number; sm: number; porthole: boolean; core: number;
  /** the guest room this bay belongs to on the upper floors: the index of its first bay (rooms span 2 bays) */
  room: number }
export interface HotelCore { i: number; bay: number; s0: number; s1: number; sm: number; front: number; colA: V2; colB: V2 }
/** one stair step (collider + visual): column centre s, v range, top height */
export interface HotelStep { core: number; floor: number; flight: 0 | 1; s: number; sA: number; sB: number; v0: number; v1: number; top: number; rise: number; first: boolean }
export interface HotelFlight { core: number; floor: number; flight: 0 | 1; s: number; sA: number; sB: number; vBot: number; vTop: number; yBot: number; yTop: number; n: number }
export interface HotelLanding { core: number; floor: number; s0: number; s1: number; v0: number; v1: number; top: number }
export type SlabZone = "ground" | "loggia" | "room" | "corridor" | "roof" | "cap";
export interface HotelSlab { level: number; bay: number; s0: number; s1: number; v0: number; v1: number; top: number; t: number; zone: SlabZone }
export interface HotelColumn { s: number; v: number; r: number; y0: number; y1: number }
export type HotelPropKind = "bed" | "wardrobe" | "table" | "desk" | "sofa" | "armchair" | "planter" | "roofPlanter" | "bench" | "dresser";
/** furniture / dressing placed in (s, v); w along the tangent, d along the normal; rot = extra yaw */
export interface HotelProp { kind: HotelPropKind; s: number; v: number; y: number; w: number; d: number; h: number; rot: number; floor: number; bay: number; collide: boolean; seed: number }
export interface HotelPavilion { s0: number; s1: number; v0: number; v1: number; y: number; h: number }
export interface HotelLayout {
  spec: HotelSpec; P: HotelPath; L: number; nBays: number; bw: number;
  /** floor levels (finished floor), lv[floors] = roof */
  lv: number[]; roof: number;
  archW: number; gArchW: number;
  bays: HotelBay[]; cores: HotelCore[];
  walls: HWall[]; slabs: HotelSlab[]; steps: HotelStep[]; flights: HotelFlight[]; landings: HotelLanding[];
  columns: HotelColumn[]; props: HotelProp[]; pavilion: HotelPavilion;
}

function hash(i: number, k: number): number { let x = (i * 374761393 + k * 668265263) | 0; x = (x ^ (x >>> 13)) * 1274126177; return ((x ^ (x >>> 16)) >>> 0) / 4294967296; }

const cache = new WeakMap<HotelSpec, HotelLayout>();
export function hotelLayout(h: HotelSpec = HOTEL): HotelLayout {
  const hit = cache.get(h); if (hit) return hit;
  const P = new HotelPath(h.path), L = P.L, D = h.depth;
  const nBays = Math.max(3, Math.round(L / h.bay)), bw = L / nBays;
  const lv = [h.y + HS.plinth];
  for (let f = 0; f < h.floors; f++) lv.push(lv[f] + (f === 0 ? h.groundH : h.floorH));
  const roof = lv[h.floors];
  const archW = Math.min(3.5, bw - 1.1), gArchW = Math.min(3.4, bw - 1.2);

  const bays: HotelBay[] = [];
  for (let i = 0; i < nBays; i++) {
    const s0 = i * bw, s1 = s0 + bw, sm = s0 + bw / 2, t = sm / L;
    bays.push({ i, s0, s1, sm, porthole: t >= h.portholes[0] && t <= h.portholes[1], core: -1, room: i });
  }
  // pavilion (sculpture pedestal) on the roof; cores must avoid it
  const ps = h.sculptureT * L;
  const pavilion: HotelPavilion = { s0: ps - 4.3, s1: ps + 4.3, v0: 3.4, v1: 10.4, y: roof, h: 3.3 };
  const cores: HotelCore[] = [];
  for (const t of h.stairsT) {
    let bi = Math.min(nBays - 1, Math.max(0, Math.floor(t * L / bw)));
    if (bays[bi].s1 > pavilion.s0 - 1 && bays[bi].s0 < pavilion.s1 + 1) bi = bays[bi].sm < ps ? Math.max(0, Math.floor((pavilion.s0 - 1) / bw) - 1) : Math.min(nBays - 1, Math.ceil((pavilion.s1 + 1) / bw));
    if (bays[bi].core >= 0) continue;
    const b = bays[bi];
    b.core = cores.length;
    cores.push({ i: cores.length, bay: bi, s0: b.s0, s1: b.s1, sm: b.sm, front: HS.roomFront + HS.wallT, colA: [b.s0 + HS.wallT / 2, b.sm - HS.wallT / 2], colB: [b.sm + HS.wallT / 2, b.s1 - HS.wallT / 2] });
  }
  const isCore = (i: number) => i >= 0 && i < nBays && bays[i].core >= 0;
  // the guest rooms take
  // TWO bays each (~9 m wide: two loggia arches / french doors on the facade, one corridor door): neighbouring non-core
  // bays of the same kind pair up between the stair cores; a leftover single bay stays a single room. The facade keeps
  // its 4.6 m arch rhythm — from outside it is the same hotel.
  for (let i = 0; i < nBays; i++) {
    const a = bays[i], b = bays[i + 1];
    if (a.core >= 0 || a.room !== i || !b || b.core >= 0 || b.porthole !== a.porthole) continue;
    b.room = i;
  }
  const sameRoom = (k: number) => k > 0 && k < nBays && !isCore(k - 1) && !isCore(k) && bays[k].room === k - 1;

  const walls: HWall[] = [];
  const clen = (s0: number, s1: number, v: number) => chordAt(P, s0, s1, v).len;
  for (const b of bays) {
    for (let f = 0; f < h.floors; f++) {
      const y0 = lv[f], hh = lv[f + 1] - HS.slabT - y0;
      // facade
      if (f === 0) {
        const len = clen(b.s0, b.s1, HS.arcadeT / 2), r = gArchW / 2;
        walls.push({ kind: "arcade", axis: "s", s0: b.s0, s1: b.s1, v0: 0, v1: HS.arcadeT, t: HS.arcadeT, y0, h: hh, openings: [{ u: len / 2 - r, w: gArchW, y: 0, h: HS.gSpring + 0.6 * r, kind: "arch" }], floor: f, bay: b.i });
      } else if (b.porthole) {
        const len = clen(b.s0, b.s1, HS.facadeT / 2);
        walls.push({ kind: "porthole", axis: "s", s0: b.s0, s1: b.s1, v0: 0, v1: HS.facadeT, t: HS.facadeT, y0, h: hh, openings: [{ u: len / 2 - 0.52, w: 1.04, y: HS.portY - 0.52, h: 1.04, kind: "porthole" }], floor: f, bay: b.i });
      } else {
        const len = clen(b.s0, b.s1, HS.facadeT / 2), r = archW / 2;
        walls.push({ kind: "loggia", axis: "s", s0: b.s0, s1: b.s1, v0: 0, v1: HS.facadeT, t: HS.facadeT, y0, h: hh, openings: [{ u: len / 2 - r, w: archW, y: 0, h: HS.spring + 0.6 * r, kind: "balcony-arch" }], floor: f, bay: b.i });
      }
      // back wall: corridor windows upstairs, lobby doors on the ground floor every 4th bay
      const lb = clen(b.s0, b.s1, D - HS.backT / 2);
      const backOps: Opening[] = f === 0
        ? (b.i % 4 === 2 && b.core < 0 ? [{ u: lb / 2 - 0.8, w: 1.6, y: 0, h: 2.7, kind: "door" }] : [{ u: lb / 2 - 0.65, w: 1.3, y: 1.1, h: 1.5, kind: "window" }])
        : [{ u: lb / 2 - 0.6, w: 1.2, y: 1.0, h: 1.3, kind: "window" }];
      walls.push({ kind: "back", axis: "s", s0: b.s0, s1: b.s1, v0: D - HS.backT, v1: D, t: HS.backT, y0, h: hh, openings: backOps, floor: f, bay: b.i });
      // room front (loggia bays) / stair core front (every core, every floor)
      if (b.core >= 0 || (f > 0 && !b.porthole)) {
        const lf = clen(b.s0, b.s1, HS.roomFront + HS.wallT / 2);
        const ops: Opening[] = b.core >= 0 ? (f > 0 && !b.porthole ? [{ u: lf / 2 - 0.9, w: 1.8, y: HS.rail + 0.9, h: 1.1, kind: "window" }] : [])
          : [{ u: lf / 2 - 1.3, w: 1.4, y: 0, h: 2.45, kind: "french" }, { u: lf / 2 + 0.55, w: 1.1, y: 0.95, h: 1.3, kind: "window", shutters: true }];
        walls.push({ kind: b.core >= 0 ? "coreFront" : "roomFront", axis: "s", s0: b.s0, s1: b.s1, v0: HS.roomFront, v1: HS.roomFront + HS.wallT, t: HS.wallT, y0, h: hh, openings: ops, floor: f, bay: b.i });
      }
      // corridor wall (upper floors): door per room, wide opening at stair cores
      if (f > 0) {
        const lc = clen(b.s0, b.s1, HS.corridor + HS.wallT / 2);
        // (the room door is centred — on the concave bends the corridor chord of a bay is only ~2.2 m and an
        //  off-centre door at lc/2 + 0.3 ran off the end of the wall: sealed rooms)
        const ops: Opening[] = b.core >= 0 ? [{ u: 0.3, w: lc - 0.6, y: 0, h: 2.75, kind: "door" }] : b.room !== b.i ? [] : [{ u: Math.max(0.15, lc / 2 - 0.55), w: Math.min(1.1, lc - 0.3), y: 0, h: 2.35, kind: "door" }];   // one door per room
        walls.push({ kind: "corridor", axis: "s", s0: b.s0, s1: b.s1, v0: HS.corridor, v1: HS.corridor + HS.wallT, t: HS.wallT, y0, h: hh, openings: ops, floor: f, bay: b.i });
      }
    }
  }
  // partitions between bays (upper floors); stair cores are walled on the ground floor too
  for (let k = 1; k < nBays; k++) {
    const s = k * bw, near = isCore(k - 1) || isCore(k);
    for (let f = 0; f < h.floors; f++) {
      if (f === 0 && !near) continue;
      if (f > 0 && sameRoom(k)) continue;   // no partition inside a two-bay room
      walls.push({ kind: f === 0 ? "coreSide" : "partition", axis: "v", s0: s, s1: s, v0: near ? HS.roomFront : HS.facadeT, v1: HS.corridor + (f === 0 ? 0 : HS.wallT), t: HS.wallT, y0: lv[f], h: lv[f + 1] - HS.slabT - lv[f], openings: [], floor: f, bay: k });
    }
  }
  // end walls (all floors + parapet): ground arch, portholes upstairs
  for (const e of [0, 1]) {
    const s = e === 0 ? HS.endT / 2 : L - HS.endT / 2;
    for (let f = 0; f < h.floors; f++) {
      const hh = lv[f + 1] - HS.slabT - lv[f] + (f === h.floors - 1 ? 0 : 0);
      const ops: Opening[] = f === 0 ? [{ u: HS.endArchV - 1.6, w: 3.2, y: 0, h: HS.gSpring + 0.6 * 1.6, kind: "arch" }]
        : HS.endPorts.map((v) => ({ u: v - 0.52, w: 1.04, y: HS.portY - 0.52, h: 1.04, kind: "porthole" as const }));
      walls.push({ kind: "end", axis: "v", s0: s, s1: s, v0: 0, v1: D, t: HS.endT, y0: lv[f], h: hh, openings: ops, floor: f, bay: e === 0 ? -1 : nBays });
    }
  }
  // stair cores: spine walls, flights, landings; roof bulkheads
  const steps: HotelStep[] = [], flights: HotelFlight[] = [], landings: HotelLanding[] = [];
  for (const c of cores) {
    const sA = (c.colA[0] + c.colA[1]) / 2, sB = (c.colB[0] + c.colB[1]) / 2;
    for (let f = 0; f < h.floors; f++) {
      const rise = lv[f + 1] - lv[f], half = rise / 2, n = Math.ceil(half / HS.maxRiser), r = half / n;
      const run = (n - 1) * HS.tread, vEnd = HS.flightV - run, yMid = lv[f] + half;
      flights.push({ core: c.i, floor: f, flight: 0, s: sA, sA: c.colA[0], sB: c.colA[1], vBot: HS.flightV, vTop: vEnd, yBot: lv[f], yTop: yMid, n });
      flights.push({ core: c.i, floor: f, flight: 1, s: sB, sA: c.colB[0], sB: c.colB[1], vBot: vEnd, vTop: HS.flightV, yBot: yMid, yTop: lv[f + 1], n });
      for (let i = 0; i < n - 1; i++) {
        steps.push({ core: c.i, floor: f, flight: 0, s: sA, sA: c.colA[0], sB: c.colA[1], v0: HS.flightV - (i + 1) * HS.tread, v1: HS.flightV - i * HS.tread, top: lv[f] + (i + 1) * r, rise: r, first: i === 0 });
        steps.push({ core: c.i, floor: f, flight: 1, s: sB, sA: c.colB[0], sB: c.colB[1], v0: vEnd + i * HS.tread, v1: vEnd + (i + 1) * HS.tread, top: yMid + (i + 1) * r, rise: r, first: i === 0 });
      }
      landings.push({ core: c.i, floor: f, s0: c.s0 + HS.wallT / 2, s1: c.s1 - HS.wallT / 2, v0: c.front, v1: vEnd, top: yMid });
      walls.push({ kind: "spine", axis: "v", s0: c.sm, s1: c.sm, v0: vEnd, v1: HS.flightV, t: HS.wallT, y0: lv[f], h: lv[f + 1] - HS.slabT - lv[f], openings: [], floor: f, bay: c.bay });
    }
    // roof bulkhead: sides, front, back with a door on the arrival (B) side
    // (the walls run up through the 0.2 m cap slab — the cap is noWalk (a lid, not a floor: no stair reaches it),
    //  so the wall tops must not be exposed ledges under it)
    const y0 = roof, hb = HS.bulkH + 0.2;
    for (const s of [c.s0, c.s1]) walls.push({ kind: "bulkhead", axis: "v", s0: s, s1: s, v0: HS.roomFront, v1: HS.bulkBack, t: HS.wallT, y0, h: hb, openings: [], floor: h.floors, bay: c.bay });
    walls.push({ kind: "bulkhead", axis: "s", s0: c.s0, s1: c.s1, v0: HS.roomFront, v1: HS.roomFront + HS.wallT, t: HS.wallT, y0, h: hb, openings: [], floor: h.floors, bay: c.bay });
    const lbk = clen(c.s0, c.s1, HS.bulkBack - HS.wallT / 2), uB = (sB - c.s0) / (c.s1 - c.s0) * lbk;
    walls.push({ kind: "bulkhead", axis: "s", s0: c.s0, s1: c.s1, v0: HS.bulkBack - HS.wallT, v1: HS.bulkBack, t: HS.wallT, y0, h: hb, openings: [{ u: uB - 0.65, w: 1.3, y: 0, h: 2.3, kind: "door" }], floor: h.floors, bay: c.bay });
  }

  // slabs: ground, upper floors (loggia / room / corridor zones), roof; stair holes cut out of core bays
  const slabs: HotelSlab[] = [];
  for (const b of bays) {
    slabs.push({ level: 0, bay: b.i, s0: b.s0, s1: b.s1, v0: 0, v1: D, top: lv[0], t: lv[0] - h.y + 0.3, zone: "ground" });
    for (let l = 1; l <= h.floors; l++) {
      const zones: Array<[number, number, SlabZone]> = l === h.floors ? [[0, D, "roof"]]
        : b.porthole ? [[0, HS.corridor + HS.wallT / 2, "room"], [HS.corridor + HS.wallT / 2, D, "corridor"]]
          : [[0, HS.roomFront + HS.wallT / 2, "loggia"], [HS.roomFront + HS.wallT / 2, HS.corridor + HS.wallT / 2, "room"], [HS.corridor + HS.wallT / 2, D, "corridor"]];
      for (const [v0, v1, zone] of zones) {
        const cuts: Array<[number, number]> = b.core >= 0 ? [[Math.max(v0, cores[b.core].front), Math.min(v1, HS.flightV)]] : [];
        let parts: Array<[number, number]> = [[v0, v1]];
        for (const [c0, c1] of cuts) if (c1 > c0) parts = parts.flatMap(([a, z]) => (c1 <= a || c0 >= z ? [[a, z]] : [[a, c0], [c1, z]]).filter(([p, q]) => q - p > 0.01) as Array<[number, number]>);
        for (const [a, z] of parts) slabs.push({ level: l, bay: b.i, s0: b.s0, s1: b.s1, v0: a, v1: z, top: lv[l], t: HS.slabT, zone });
      }
    }
  }
  for (const c of cores) slabs.push({ level: h.floors + 1, bay: c.bay, s0: c.s0 - 0.1, s1: c.s1 + 0.1, v0: HS.roomFront - 0.1, v1: HS.bulkBack + 0.1, top: roof + HS.bulkH + 0.2, t: 0.2, zone: "cap" });

  // ground-floor columns under the room-front + corridor lines (not beside stair cores)
  const columns: HotelColumn[] = [];
  for (let k = 1; k < nBays; k++) {
    if (isCore(k - 1) || isCore(k)) continue;
    for (const v of [HS.roomFront + HS.wallT / 2, HS.corridor + HS.wallT / 2]) columns.push({ s: k * bw, v, r: 0.3, y0: lv[0], y1: lv[1] - HS.slabT });
  }

  // furniture: every room and the lobby are furnished by the shared INTERIORS KIT (hotelRooms below); the
  // hotel keeps only its reception desk and the rooftop planters
  const props: HotelProp[] = [];
  const mid = bays[Math.floor(nBays * 0.45)];
  props.push({ kind: "desk", s: mid.sm, v: 7.2, y: lv[0], w: 3.4, d: 0.8, h: 1.1, rot: 0, floor: 0, bay: mid.i, collide: true, seed: 0.3 });
  for (let k = 1; k < nBays; k++) {
    const s = k * bw;
    if (k % 2 === 0 && !(s > pavilion.s0 - 1.5 && s < pavilion.s1 + 1.5) && !isCore(k - 1) && !isCore(k)) props.push({ kind: "roofPlanter", s, v: 1.05, y: roof, w: 1.9, d: 0.9, h: 0.75, rot: 0, floor: h.floors, bay: k, collide: true, seed: hash(k, 3) });
    if (k % 5 === 3 && !isCore(k - 1) && !isCore(k) && !(s > pavilion.s0 - 1.5 && s < pavilion.s1 + 1.5)) props.push({ kind: "roofPlanter", s, v: D - 1.0, y: roof, w: 1.9, d: 0.9, h: 0.75, rot: 0, floor: h.floors, bay: k, collide: true, seed: hash(k, 4) });
  }

  const lay: HotelLayout = { spec: h, P, L, nBays, bw, lv, roof, archW, gArchW, bays, cores, walls, slabs, steps, flights, landings, columns, props, pavilion };
  cache.set(h, lay);
  return lay;
}

/** a leaf hinged on a chord wall: chord-local hinge (u, z), turned by `th` (three RotY) then offset (ox, oz) */
function leafBox(c: Chord, u: number, z: number, th: number, ox: number, oz: number, w: number, y0: number, h: number, t: number, glass: boolean): Box {
  const cs = dmath.cos(th), sn = dmath.sin(th);
  const lu = u + ox * cs + oz * sn, lz = z - ox * sn + oz * cs;
  const [x, wz] = chordPt(c, lu, lz);
  const du = cs, dw = -sn, wx = c.dx * du - c.dz * dw, wzz = c.dz * du + c.dx * dw;
  return { c: [x, y0 + h / 2, wz], h: [w / 2, h / 2, t / 2], yaw: dmath.atan2(-wzz, wx), surf: glass ? "glass" : "wood", ...(glass ? { noShoot: true } : {}) };
}
/** french leaves swing 92° out onto the loggia, flat against nothing, square to the wall — at 62° the two
 *  0.68 m leaves pinched the 1.4 m opening to ~0.7 m (< the 0.84 m capsule) and sealed every loggia */
export const FRENCH_DEG = 92;
export function hotelFill(lay: HotelLayout): Box[] {
  const P = lay.P, out: Box[] = [], D2R = Math.PI / 180;
  for (const w of lay.walls) {
    if (w.axis === "v") {
      // (a THIN pane on the end wall's mid plane — the wall's full 0.45 m thickness is not a pane to the glass
      //  system (isPaneBox: ≤ 0.16 m): a full-thickness box would make portholes no body or punch can break.
      //  The drawn glass sits 0.055 m off this plane.)
      if (w.kind === "end") for (const op of w.openings) if (op.kind === "porthole") out.push({ ...normalBox(P, w.s0, 0.02, w.v0 + op.u, w.v0 + op.u + op.w, w.y0 + op.y, w.y0 + op.y + op.h, "glass"), noShoot: true });
      continue;
    }
    const c = wallChord(P, w), T = w.v1 - w.v0;
    for (const op of w.openings) {
      // (a thin pane on the wall's mid plane — the drawn glass sits ≤ 0.1 m off it on either side)
      if (op.kind === "window" || op.kind === "porthole") out.push({ ...chordBox(c, op.u, op.u + op.w, -0.02, 0.02, w.y0 + op.y, w.y0 + op.y + op.h, "glass"), noShoot: true });
      else if (op.kind === "french" && (w.kind === "roomFront" || w.kind === "coreFront")) {
        const lw = op.w / 2 - 0.02;
        for (const sgn of [-1, 1]) out.push(leafBox(c, sgn < 0 ? op.u : op.u + op.w, T / 2, (sgn < 0 ? -FRENCH_DEG : FRENCH_DEG) * D2R, -sgn * lw / 2, 0.03, lw, w.y0 + 0.02, op.h - 0.04, 0.05, true));
      } else if (op.kind === "door" && op.w <= 2) {
        if (w.kind === "corridor") out.push(leafBox(c, op.u, T / 2, -82 * D2R, op.w / 2 - 0.02, 0, op.w - 0.05, w.y0 + 0.025, op.h - 0.05, 0.08, false));
        else if (w.kind === "back") out.push(leafBox(c, op.u, 0, -75 * D2R, op.w / 2 - 0.02, 0, op.w - 0.05, w.y0 + 0.025, op.h - 0.05, 0.08, false));
      }
    }
  }
  return out;
}



// ---------- the hotel's rooms + lobby as interiors-kit rooms (the kit furnishes, collides and lists loot slots)
/** one kit room per guest room (floors 1..n−1, every non-core bay) and per lobby bay (ground floor, not the reception /
 *  core bays). Rect = the bay's room inscribed in the chord frame at mid depth: local +x along the facade, +z toward the
 *  FRONT (side 0 = the loggia / porthole wall, side 2 = the corridor / back wall, sides 1 / 3 = the partitions). */
export function hotelRooms(lay: HotelLayout = hotelLayout()): InteriorRoom[] {
  const out: InteriorRoom[] = [], P = lay.P, h = lay.spec, mid = lay.bays[Math.floor(lay.nBays * 0.45)];
  const room = (b: HotelBay, f: number, v0: number, v1: number, openings: RoomOpening[], keepOut: NonNullable<InteriorRoom["keepOut"]>, style: InteriorRoom["style"], role: InteriorRoom["role"], bEnd: HotelBay = b) => {
    const vm = (v0 + v1) / 2, c = chordAt(P, b.s0, bEnd.s1, vm);
    // the room is a WEDGE on the serpentine's bends (2.2 … 6.9 m across): the rect takes the mid-depth width and the
    // slices where the real partitions close in are solid keep-outs
    const hwAt = (v: number) => chordAt(P, b.s0, bEnd.s1, v).len / 2 - HS.wallT / 2 - 0.05;
    const w = 2 * hwAt(vm) - 0.1, d = v1 - v0;
    for (let k = 0; k < 6; k++) {
      const va = v0 + d * k / 6, vb = v0 + d * (k + 1) / 6, hw = Math.min(hwAt(va), hwAt(vb));
      if (hw < w / 2 - 0.05) for (const sx of [-1, 1]) keepOut.push({ r: sx < 0 ? [-w / 2, d / 2 - (vb - v0), -hw, d / 2 - (va - v0)] : [hw, d / 2 - (vb - v0), w / 2, d / 2 - (va - v0)], solid: true });
    }
    const [x, z] = chordPt(c, c.len / 2, 0), y = lay.lv[f], top = lay.lv[f + 1] - HS.slabT;
    out.push({ id: `hotel-b${b.i}f${f}`, x, y, z, yaw: c.yaw, w, d, h: top - y, style, role, seed: (b.i * 7919 + f * 104729 + 17) >>> 0, openings, keepOut, wallT: HS.wallT,
      finish: { floor: "none", wall: null, dado: null, baseboard: false, ceiling: "none", glass: false } });
  };
  for (const b of lay.bays) {
    if (b.core >= 0) continue;
    // one kit room per guest room — a pair of bays (the second bay of a pair is furnished with the first)
    const b2 = lay.bays.find((q) => q.i !== b.i && q.room === b.i) ?? b;
    for (let f = 1; f < h.floors && b.room === b.i; f++) {
      const v0 = b.porthole ? HS.facadeT : HS.roomFront + HS.wallT, v1 = HS.corridor, d = v1 - v0;
      // per bay of the room: its facade opening(s) at the bay's centre (offset from the room's centre along the facade)
      const offs = (b2 === b ? [0] : [-(b.s1 - b.s0) / 2, (b2.s1 - b2.s0) / 2]).map((o) => o * chordAt(P, b.s0, b2.s1, (v0 + v1) / 2).len / (b2.s1 - b.s0));
      const ops: RoomOpening[] = [];
      for (const o of offs) ops.push(...(b.porthole
        ? [{ side: 0 as const, at: o, w: 1.04, kind: "window" as const, y0: HS.portY - 0.52, h: 1.04 }]
        : [{ side: 0 as const, at: o - 0.6, w: 1.4, kind: "door" as const, y0: 0, h: 2.45 }, { side: 0 as const, at: o + 1.1, w: 1.1, kind: "window" as const, y0: 0.95, h: 1.3 }]));
      // the corridor door (the first bay's) — the leaf swings into the room (hotelFill: hinge at the door's −x jamb, 82°)
      ops.push({ side: 2, at: offs[0], w: 1.1, kind: "door", y0: 0, h: 2.35 });
      room(b, f, v0, v1, ops, [{ r: [offs[0] - 0.8, -d / 2, offs[0] + 0.7, -d / 2 + 1.3], walk: true }], "house", (["bedroom", "bedroom", "studio", "living"] as const)[(b.i + f) % 4], b2);
    }
    // lobby bay: open to its neighbours (the partitions are columns) and to the arcade
    if (b.i === mid.i) continue;
    const v0 = HS.arcadeT + 0.3, v1 = h.depth - HS.backT - 0.05, d = v1 - v0;
    const lb = chordAt(P, b.s0, b.s1, d / 2).len;
    const ops: RoomOpening[] = [{ side: 0, at: 0, w: Math.min(lay.gArchW, lb - 1), kind: "gap" }, { side: 1, at: 0, w: d - 0.4, kind: "gap" }, { side: 3, at: 0, w: d - 0.4, kind: "gap" }];
    if (b.i % 4 === 2) ops.push({ side: 2, at: 0, w: 1.6, kind: "door", y0: 0, h: 2.7 });
    else ops.push({ side: 2, at: 0, w: 1.3, kind: "window", y0: 1.1, h: 1.5 });
    const keep: NonNullable<InteriorRoom["keepOut"]> = [];
    // the columns on the bay lines (room-front + corridor lines) + a walkway along the arcade
    for (const v of [HS.roomFront + HS.wallT / 2, HS.corridor + HS.wallT / 2]) { const z = d / 2 - (v - v0); for (const sx of [-1, 1]) keep.push({ r: [sx * lb / 2 - 0.55, z - 0.55, sx * lb / 2 + 0.55, z + 0.55], solid: true }); }
    keep.push({ r: [-lb / 2, d / 2 - 1.6, lb / 2, d / 2], walk: true });
    room(b, 0, v0, v1, ops, keep, "house", b.i % 2 ? "living" : "dining");
  }
  return out;
}

// ---------- the rooftop pavilion — a stone stair up its east side, the plinth and the banana bunch as colliders
/** pavilion-local frame: x along the pavilion chord (0 = centre), z toward the FRONT (pool), y from the roof (pv.y) */
export interface PavFrame { c: Chord; W: number; Dp: number; H: number; top: number }
export function pavFrame(lay: HotelLayout): PavFrame {
  const pv = lay.pavilion, c = chordAt(lay.P, pv.s0, pv.s1, (pv.v0 + pv.v1) / 2);
  return { c, W: c.len, Dp: pv.v1 - pv.v0, H: pv.h, top: pv.h + 0.55 };
}
/** the stair: `n` steps up the east face (x = W/2 … W/2 + width), from the back (−z) toward the front, the last one a
 *  landing level with the pavilion top. Local boxes [x0, z0, x1, z1, y1] (solid from the roof). */
export function pavStair(f: PavFrame): Array<[number, number, number, number, number]> {
  const n = Math.ceil(f.top / 0.19), rise = f.top / n, tread = 0.27, land = 1.0, x0 = f.W / 2 + 0.04, x1 = x0 + 1.1;
  const z0 = -f.Dp / 2 + 0.2, out: Array<[number, number, number, number, number]> = [];
  for (let i = 0; i < n - 1; i++) out.push([x0, z0 + i * tread, x1, z0 + (i + 1) * tread, (i + 1) * rise]);
  out.push([x0, z0 + (n - 1) * tread, x1, z0 + (n - 1) * tread + land, f.top]);
  return out;
}
/** the plinth under the bunch (client: cream bar W−2.4 × 3.8 at x +0.3, top + a 0.12 cap bar) */
export const PLINTH = { x: 0.3, dw: 2.4, d: 3.8, top: 0.96 /* above f.H */ };
/** the three bananas: [P0, D0 (chord), U0 (bulge), len, radius, bend, tint] in the bunch frame (on the plinth, turned) */
export const BANANAS: Array<[[number, number, number], [number, number, number], [number, number, number], number, number, number, number]> = [
  [[-1.5, 0.05, -0.3], [0.2, 1, 0.04], [-1, 0.1, 0.2], 6.4, 0.95, 0.85, 1.0],     // tall, back-left, stem up
  [[-1.25, 0.1, 0.35], [1, 0.62, 0.12], [-0.35, 1, 0], 5.6, 0.92, 0.8, 0.97],      // lying across, curving up-right
  [[-0.7, 0.05, 1.0], [1, 0.3, 0.28], [-0.2, 1, -0.1], 4.8, 0.86, 0.75, 1.03],     // front, lower, to the right
];
/** banana spine point (bulge +y) at t ∈ [0, 1], blossom end at the origin (client bananaGeo) */
export function bananaSpine(len: number, bend: number, t: number): [number, number] {
  const R = len / bend, a = (t - 0.5) * bend;
  return [R * dmath.sin(a) + R * dmath.sin(bend / 2), R * dmath.cos(a) - R * dmath.cos(bend / 2)];
}
export function bananaRadius(r: number, t: number): number { return r * (0.2 + 0.8 * dmath.pow(dmath.sin(Math.PI * Math.min(1, Math.max(0, t * 0.96 + 0.02))), 0.5)); }
/** yaw (three RotY) that turns the bunch's broad side toward a world xz point */
export function bunchYaw(f: PavFrame, face?: [number, number]): number {
  if (!face) return 0;
  const dx = face[0] - f.c.ax, dz = face[1] - f.c.az;
  const x = dx * f.c.dx + dz * f.c.dz - f.W / 2, z = -dx * f.c.dz + dz * f.c.dx;
  return dmath.atan2(x, z);
}
/** bunch-frame point → pavilion-local [x, y, z] */
function bunchPt(f: PavFrame, yaw: number, p: [number, number, number]): [number, number, number] {
  const cs = dmath.cos(yaw), sn = dmath.sin(yaw);
  return [p[0] * cs + p[2] * sn, f.top + 0.35 + p[1], -p[0] * sn + p[2] * cs];
}
function nrm(v: number[]): [number, number, number] { const l = dmath.hypot3(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
/** banana colliders: each banana as a chain of boxes along its spine (inscribed: 0.8 r across, 0.92 r up / down), so
 *  the lying ones are a climbable ramp of ≤ 0.3 m steps and the standing one's top is a < 2 m² cap */
export function bananaBoxes(lay: HotelLayout, face?: [number, number]): Box[] {
  const f = pavFrame(lay), yaw = bunchYaw(f, face), out: Box[] = [], y0 = lay.pavilion.y;
  for (const [P0, D0, U0, len, r, bend] of BANANAS) {
    const D = nrm(D0), du = U0[0] * D[0] + U0[1] * D[1] + U0[2] * D[2], U = nrm([U0[0] - D[0] * du, U0[1] - D[1] * du, U0[2] - D[2] * du]);
    const at = (t: number) => { const [a, b] = bananaSpine(len, bend, t); return bunchPt(f, yaw, [P0[0] + D[0] * a + U[0] * b, P0[1] + D[1] * a + U[1] * b, P0[2] + D[2] * a + U[2] * b]); };
    const K = 10;
    for (let k = 0; k < K; k++) {
      const ta = (k + 0.08) / K, tb = (k + 0.92) / K, A = at(ta), B = at(tb), rr = bananaRadius(r, (ta + tb) / 2);
      if (rr < 0.3) continue;
      const hx = B[0] - A[0], hz = B[2] - A[2], hl = dmath.hypot(hx, hz);
      const ux = hl > 1e-3 ? hx / hl : 1, uz = hl > 1e-3 ? hz / hl : 0;
      const mx = (A[0] + B[0]) / 2, mz = (A[2] + B[2]) / 2, ylo = Math.min(A[1], B[1]) - rr * 0.92, yhi = Math.max(A[1], B[1]) + rr * 0.92;
      const [wx, wz] = chordPt(f.c, mx + f.W / 2, mz);
      // pavilion-local direction → world
      const dxw = f.c.dx * ux - f.c.dz * uz, dzw = f.c.dz * ux + f.c.dx * uz;
      out.push({ c: [wx, y0 + (ylo + yhi) / 2, wz], h: [hl / 2 + rr * 0.3, (yhi - ylo) / 2, rr * 0.8], yaw: dmath.atan2(-dzw, dxw), surf: "wood" });
    }
  }
  return out;
}

// ---------- collider helpers (also used by the client to place geometry identically)
/** oriented box for a chord piece: u0..u1 along the chord, w0..w1 toward the front, world y0..y1 */
export function chordBox(c: Chord, u0: number, u1: number, w0: number, w1: number, y0: number, y1: number, surf: Surface): Box {
  const [x, z] = chordPt(c, (u0 + u1) / 2, (w0 + w1) / 2);
  return { c: [x, (y0 + y1) / 2, z], h: [Math.abs(u1 - u0) / 2, (y1 - y0) / 2, Math.abs(w1 - w0) / 2], yaw: c.yaw, surf };
}
/** oriented box running along the normal at s: v0..v1, half thickness along the tangent, world y0..y1 */
export function normalBox(P: HotelPath, s: number, halfT: number, v0: number, v1: number, y0: number, y1: number, surf: Surface): Box {
  const [x, z] = P.pt(s, (v0 + v1) / 2);
  return { c: [x, (y0 + y1) / 2, z], h: [halfT, (y1 - y0) / 2, Math.abs(v1 - v0) / 2], yaw: P.yaw(s), surf };
}
/** chord of an axis-"s" wall at its mid depth */
export function wallChord(P: HotelPath, w: HWall): Chord { return chordAt(P, w.s0, w.s1, (w.v0 + w.v1) / 2); }
/** solid pieces of a wall (collider rectangles; arches are cut as rectangles up to ~60 % of the arch radius) */
export function wallBoxes(P: HotelPath, w: HWall): Box[] {
  const out: Box[] = [];
  const surf: Surface = w.kind === "spine" || w.kind === "partition" || w.kind === "coreSide" ? "concrete" : "stone";
  if (w.axis === "s") {
    const c = wallChord(P, w), t = w.v1 - w.v0;
    for (const pc of wallPieces(c.len, w.h, w.openings)) out.push(chordBox(c, pc.u, pc.u + pc.w, -t / 2, t / 2, w.y0 + pc.y, w.y0 + pc.y + pc.h, surf));
  } else {
    const len = w.v1 - w.v0;
    for (const pc of wallPieces(len, w.h, w.openings)) out.push(normalBox(P, w.s0, w.t / 2, w.v0 + pc.u, w.v0 + pc.u + pc.w, w.y0 + pc.y, w.y0 + pc.y + pc.h, surf));
  }
  return out;
}

/** oriented boxes for the server: every wall piece, slab strip, stair step, landing, column, furniture, parapet, pilaster,
 *  the rooftop pavilion + banana sculpture. Derived from hotelLayout — the client draws the same layout. */
export function hotelColliders(h: HotelSpec = HOTEL, face?: [number, number]): Box[] {
  const lay = hotelLayout(h), P = lay.P, D = h.depth, out: Box[] = [];
  for (const w of lay.walls) out.push(...wallBoxes(P, w));
  // what fills the openings, as drawn by client town-hotel (windows / portholes: glass panes, bullets pass;
  // french leaves opened out onto the loggia at FRENCH_DEG; room / lobby door leaves at 82° / 75°)
  out.push(...hotelFill(lay));
  // loggia balustrades (in the arch opening, in the facade wall plane)
  for (const w of lay.walls) {
    if (w.kind !== "loggia") continue;
    const c = wallChord(P, w), op = w.openings[0];
    out.push(chordBox(c, op.u, op.u + op.w, -0.15, 0.15, w.y0, w.y0 + HS.rail, "stone"));
  }
  // facade pilasters
  for (let k = 1; k < lay.nBays; k++) out.push(normalBox(P, k * lay.bw, HS.pier / 2, -HS.pierOut, 0.05, h.y, lay.roof, "stone"));
  // the four 1.4 m corner piers (client facadeFrame: they wrap both faces, 0.3 m proud) — walk-through without these
  for (const [s, v, sx, sz] of [[0, 0, 1, 1], [lay.L, 0, -1, 1], [0, D, 1, -1], [lay.L, D, -1, -1]] as Array<[number, number, number, number]>) {
    const f = P.at(s), cx = f.p[0] + f.n[0] * v + f.d[0] * sx * 0.4 + f.n[0] * sz * 0.4, cz = f.p[1] + f.n[1] * v + f.d[1] * sx * 0.4 + f.n[1] * sz * 0.4;
    out.push({ c: [cx, (h.y - 0.05 + lay.roof - 0.4) / 2, cz], h: [0.7, (lay.roof - 0.4 - h.y + 0.05) / 2, 0.7], yaw: P.yaw(s), surf: "stone" });
  }
  // slabs: split into ≤ 3.6 m deep strips so chord boxes never overhang into a neighbouring stairwell
  for (const s of lay.slabs) {
    const n = s.level === 0 ? 1 : Math.max(1, Math.ceil((s.v1 - s.v0) / 3.6));
    for (let i = 0; i < n; i++) {
      const v0 = s.v0 + (s.v1 - s.v0) * i / n, v1 = s.v0 + (s.v1 - s.v0) * (i + 1) / n;
      const c = chordAt(P, s.s0, s.s1, (v0 + v1) / 2);
      out.push({ ...chordBox(c, -0.03, c.len + 0.03, -(v1 - v0) / 2, (v1 - v0) / 2, s.top - s.t, s.top, s.zone === "room" ? "wood" : "stone"), ...(s.zone === "cap" ? { noWalk: true } : {}) });
    }
  }
  // stairs: one box per step (0.3 m thick tread block), landings, width measured at each step's depth
  for (const st of lay.steps) {
    const vm = (st.v0 + st.v1) / 2, a = P.pt(st.sA, vm), b = P.pt(st.sB, vm), w = dmath.hypot(b[0] - a[0], b[1] - a[1]);
    // (ground-floor flights + landing are SOLID to the floor like the drawn ones — 0.3 m treads left a sealed
    //  1.8 m crouch pocket under the landing)
    out.push(normalBox(P, st.s, w * 0.49, st.v0, st.v1, st.floor === 0 ? lay.lv[0] : st.top - 0.3, st.top, "stone"));
  }
  for (const l of lay.landings) {
    const c = chordAt(P, l.s0, l.s1, (l.v0 + l.v1) / 2);
    out.push(chordBox(c, 0, c.len, -(l.v1 - l.v0) / 2, (l.v1 - l.v0) / 2, l.floor === 0 ? lay.lv[0] : l.top - 0.28, l.top, "stone"));
  }
  for (const col of lay.columns) out.push(normalBox(P, col.s, col.r, col.v - col.r, col.v + col.r, col.y0, col.y1, "stone"));
  for (const p of lay.props) {
    // (every drawn piece collides)
    const [x, z] = P.pt(p.s, p.v);
    out.push({ c: [x, p.y + p.h / 2, z], h: [p.w / 2, p.h / 2, p.d / 2], yaw: P.yaw(p.s) + p.rot, surf: p.kind === "planter" || p.kind === "roofPlanter" ? "stone" : p.kind === "sofa" || p.kind === "armchair" || p.kind === "bed" ? "fabric" : "wood" });
  }
  // roof parapets (front + back chords per bay, end walls)
  for (const b of lay.bays) {
    const cf = chordAt(P, b.s0, b.s1, 0.175), cb = chordAt(P, b.s0, b.s1, D - 0.175);
    out.push(chordBox(cf, 0, cf.len, -0.175, 0.175, lay.roof, lay.roof + HS.parapet, "stone"));
    out.push(chordBox(cb, 0, cb.len, -0.175, 0.175, lay.roof, lay.roof + HS.parapet, "stone"));
  }
  for (const s of [HS.endT / 2, lay.L - HS.endT / 2]) out.push(normalBox(P, s, HS.endT / 2, 0, D, lay.roof, lay.roof + HS.parapet, "stone"));
  // pavilion (solid pedestal), its east stair, the plinth and the banana bunch (stair + climbable bunch)
  const pv = lay.pavilion, pf = pavFrame(lay), pc = pf.c;
  out.push(chordBox(pc, 0, pc.len, -(pv.v1 - pv.v0) / 2, (pv.v1 - pv.v0) / 2, pv.y, pv.y + pf.top, "stone"));
  for (const [x0, z0, x1, z1, y1] of pavStair(pf)) out.push(chordBox(pc, x0 + pf.W / 2, x1 + pf.W / 2, z0, z1, pv.y, pv.y + y1, "stone"));
  out.push(chordBox(pc, pf.W / 2 + PLINTH.x - (pf.W - PLINTH.dw) / 2, pf.W / 2 + PLINTH.x + (pf.W - PLINTH.dw) / 2, -PLINTH.d / 2, PLINTH.d / 2, pv.y + pf.top, pv.y + pf.H + PLINTH.top, "stone"));
  out.push(...bananaBoxes(lay, face));
  return out;
}
