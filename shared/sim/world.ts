// Static world for the sim: heightfield + oriented boxes in a uniform grid. Capsule resolution + raycasts.
// Zero allocations after construction (results are written into preallocated registers).
import type { Terrain } from "../world/terrain";
import type { Box, Surface } from "../world/colliders";
import { PLAYER_R, STEP_H } from "./const";
import type { GlassState } from "./glass";
import type { VehicleSet } from "./vehicle";
import type { CoverSet } from "./cover";

const GRID_CELL = 24;
/** padding (m) on each box's x/z bounds so float32 rounding can never cull a box a ray really hits */
const BOUNDS_PAD_M = 0.01;
// terrain slopes: full speed up to 35°, uphill
// speed falls to SLOPE_SLOW_MUL at 45°, steeper TERRAIN is a slide (no uphill progress, no jump). Box ramps keep the
// older SLOPE_LIMIT (51°) so designed ramps / stairs are untouched.
export const TERRAIN_FULL_NY = dmath.cos(35 * Math.PI / 180);   // 0.819
export const TERRAIN_SLIDE_NY = dmath.cos(45 * Math.PI / 180);  // 0.707
export const SLOPE_SLOW_MUL = 0.5;
/** the walk → slide transition is a blend over SLIDE_BLEND_LO..HI degrees (no hard edge at 45°) */
export const SLIDE_BLEND_LO = 43, SLIDE_BLEND_HI = 47;
const RAD = 180 / Math.PI;
/** terrain slope feel for a normal's y: [0] uphill wish factor (1 ≤ 35°, 0.6 at 43°, 0 at ≥ 47°), [1] slide amount
 * (0 ≤ 43°, smoothstep to 1 at 47°). Shared by the ground mover, the air steer over slopes and the tools. */
export function slopeFeel(ny: number, out: Float64Array | number[]): Float64Array | number[] {
  if (ny >= TERRAIN_FULL_NY) { out[0] = 1; out[1] = 0; return out; }
  const deg = dmath.acos(Math.min(1, Math.max(-1, ny))) * RAD;
  let t = (deg - SLIDE_BLEND_LO) / (SLIDE_BLEND_HI - SLIDE_BLEND_LO); t = t < 0 ? 0 : t > 1 ? 1 : t;
  const s = t;                                                            // linear: an even blend per degree
  const walk = 1 - (1 - SLOPE_SLOW_MUL) * Math.min(1, (deg - 35) / 10);   // 35° → 1, 45° → 0.5
  const atLo = 1 - (1 - SLOPE_SLOW_MUL) * 0.8;                            // 0.6 at 43°
  out[0] = deg <= SLIDE_BLEND_LO ? walk : atLo * (1 - s);
  out[1] = s;
  return out;
}
// capsule solver (see "Solver" at resolveCapsule below)
const SOLVER_ITER = 8;               // contact passes per resolve (real geometry converges in 1-3)
const DEPEN_STEP = 0.15;             // max depenetration / unstick glide per tick (m) — no teleport-looking pops
const LIP = 0.12;                    // corner skin: a corner protruding ≤ this past a face is treated square
const SQUEEZE = 0.025;               // overlap tolerated per wall when opposing walls leave no clear spot (gap ≥ 0.79 m passes)
const UNSTICK_T = 1.0;               // s of move input with < UNSTICK_D m of net progress before the pocket check
const UNSTICK_D = 0.3;
const UNSTICK_LIFT = 2 * STEP_H;     // the unstick may lift onto a floor this much higher
const UNSTICK_LIFT_FAR = 2.5;        // …from the wider windows (wedged between rocks: the nearest free spot is a rock top)
const WISH_BIAS = 0.35;              // unstick target cost × (1 − bias · cos(angle to the stick direction))
const MAXC = 64, MAXLB = 4096, MAXLV = 6, LEVEL_MERGE = 0.08;
const BKMAX = 24, BKCAP = 1 << 17;     // local search buckets (1 m) per side / total entries
const SPN = new Int32Array(4), BR = new Int32Array(3);
const CEIL_TOL = 0.01;               // a head within 1 cm of a ceiling is not in it (terrain noise under a slab)
// search window: WN × WN cells of WS m (± 2.5 m) around the capsule; FLOOD_SLIM trims the capsule for walk links so a
// doorway a hair wider than the capsule is never missed between lattice points (the target itself must fit the full r)
const WS = 0.125, WC = 20, WN = 2 * WC + 1, WC2 = 40, WN2 = 2 * WC2 + 1, FLOOD_SLIM = 0.06, WATER_Y = -1.2;
const NBX = [1, -1, 0, 0, 1, 1, -1, -1], NBZ = [0, 0, 1, -1, 1, -1, 1, -1];
/** window cells in order of distance from the centre (ties by index — deterministic), for a (2c+1)² window */
const orderFor = (c: number) => {
  const n = 2 * c + 1, a: number[] = []; for (let k = 0; k < n * n; k++) a.push(k);
  const d = (k: number) => dmath.hypot((k % n) - c, ((k / n) | 0) - c);
  a.sort((p, q) => d(p) - d(q) || p - q);
  return { order: Int32Array.from(a), dist: Float64Array.from(a, d) };   // dist in cells
};
const ORD41 = orderFor(WC), ORD81 = orderFor(WC2);
/** what the unstick reads / writes on a player (shared/sim/player.ts Player satisfies it) */
export interface UnstickBody { x: number; y: number; z: number; yaw: number; vx: number; vy: number; vz: number; grounded: boolean; swim: boolean; fallV: number; airT: number }
/** per-player solver state: [unstick timer s, anchor x, anchor z, gliding, target x, y, z, last glide x, z, last tick's step lift] */
const US = new WeakMap<object, Float64Array>();
const SURF_IDX: Surface[] = ["wood", "metal", "concrete", "stone", "sand", "grass", "water", "foliage", "glass", "fabric"];
export const surfaceIndex = (s: Surface | undefined): number => Math.max(0, SURF_IDX.indexOf(s ?? "stone"));
export const surfaceById = (i: number): Surface => SURF_IDX[i] ?? "stone";
/** breakable glass (shared/sim/glass.ts): a window pane is a thin (≤ 8 cm half-thickness), vertical surf-"glass" box at least
 * 0.4 m wide and 0.3 m tall, 3× wider than thick (cave crystals are not). Panes never stop a bullet — the bullet breaks
 * the pane and carries on — so every StaticWorld (game, server, tools) marks them noShoot at build. */
export const GLASS_SURF = 8;
export function isPaneBox(hx: number, hy: number, hz: number): boolean {
  const ht = Math.min(hx, hz), hw = Math.max(hx, hz);
  return ht <= 0.08 && hw >= 0.2 && hy >= 0.15 && hw >= 3 * ht && hy >= ht;
}

/** raycast result register */
export interface Hit { hit: boolean; t: number; x: number; y: number; z: number; nx: number; ny: number; nz: number; surf: number; box: number;
  /** the portable cover wall the ray stopped on (shared/sim/cover.ts), −1 = none */ cover: number }
export const makeHit = (): Hit => ({ hit: false, t: 0, x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, surf: 5, box: -1, cover: -1 });

import type { Climb } from "./climb";
import * as dmath from "./dmath";
/** StaticWorld.roundDx: not a tree box; an offset (m) as whole centimetres, clamped to Int16 */
const ROUND_NONE = -32768;
const cm16 = (m: number) => Math.max(-32767, Math.min(32767, Math.round(m * 100)));
export class StaticWorld {
  // SoA box data
  n = 0;
  cx!: Float32Array; cy!: Float32Array; cz!: Float32Array;
  hx!: Float32Array; hy!: Float32Array; hz!: Float32Array;
  cos!: Float32Array; sin!: Float32Array;          // yaw
  /** each box's world x/z bounds (yaw included, a little padded): rays and capsule gathers skip a box they miss */
  bx0!: Float32Array; bx1!: Float32Array; bz0!: Float32Array; bz1!: Float32Array;
  /** each box's lowest grid cell column / row: where a row-major walk of the grid first meets it */
  private gx0!: Int32Array; private gz0!: Int32Array;
  /** while a ray skips cells of its rectangle: the rectangle's first column / row (−1 = not skipping) */
  private tieX0 = -1; private tieZ0 = -1;
  surf!: Uint8Array; noShoot!: Uint8Array; noWalk!: Uint8Array;
  /** boxes a tuk-tuk drives through (fences, hedges, crop stems — Box.noDrive), and the switch the vehicle step
   * sets around its own collision queries (shared/sim/vehicle.ts move): while on, movement and ground rays skip them */
  noDrive!: Uint8Array; drive = false;
  /** tree boxes (Box.round): the trunk's axis as an offset from the box's centre (cm; ROUND_NONE = not a
   *  tree — 4 bytes a box), and — read back after a vehicle's resolve (drive on) — whether a wall contact it made was a
   *  tree / anything else (shared/sim/vehicle.ts: a tree caught off the nose is slid off, a wall is not) */
  roundDx!: Int16Array; roundDz!: Int16Array; wallRound = false; wallFlat = false;
  /** …and the deepest tree contact's trunk axis (world x, z) and depth (−1 = none) */
  roundX = 0; roundZ = 0; roundD = -1;
  /** breakable glass (shared/sim/glass.ts): the match whose glass is bound — its noWalk copy has every broken pane set */
  glass: GlassState | null = null;
  /** tuk-tuks (shared/sim/vehicle.ts): the match whose vehicles are bound — the driver's step moves them, kongs on foot
   * are kept out of them */
  veh: VehicleSet | null = null;
  /** the portable cover walls of the bound match (shared/sim/cover.ts): raycasts see them */
  cover: CoverSet | null = null;
  /** paved ground the terrain's biome map does not know (shared/sim/roads.ts): one byte per terrain sample, 0 = ask
   * the terrain. Set by buildStaticWorld */
  roads: Uint8Array | null = null;
  /** ladders + climbable tree trunks (shared/sim/climb.ts), set by buildStaticWorld / the client's copy */
  climbs: Climb[] = [];
  /** what the ground at (x, z) drives like: a Biome */
  groundBiome(x: number, z: number): number {
    const t = this.terrain, r = t.res;
    if (this.roads) {
      const j = Math.min(r - 1, Math.max(0, Math.round((x + t.half) / t.cell))), i = Math.min(r - 1, Math.max(0, Math.round((z + t.half) / t.cell)));
      const b = this.roads[i * r + j]; if (b) return b;
    }
    return t.biomeAt(x, z);
  }
  private gridMin = 0; private gridN = 0;
  private cellStart!: Int32Array; private cellItems!: Int32Array;

  constructor(readonly terrain: Terrain, boxes: Box[]) { this.setBoxes(boxes); }

  setBoxes(boxes: Box[]) {
    const n = this.n = boxes.length;
    this.cx = new Float32Array(n); this.cy = new Float32Array(n); this.cz = new Float32Array(n);
    this.hx = new Float32Array(n); this.hy = new Float32Array(n); this.hz = new Float32Array(n);
    this.cos = new Float32Array(n); this.sin = new Float32Array(n);
    this.gx0 = new Int32Array(n); this.gz0 = new Int32Array(n);
    this.bx0 = new Float32Array(n); this.bx1 = new Float32Array(n); this.bz0 = new Float32Array(n); this.bz1 = new Float32Array(n);
    this.surf = new Uint8Array(n); this.noShoot = new Uint8Array(n); this.noWalk = new Uint8Array(n); this.noDrive = new Uint8Array(n);
    this.roundDx = new Int16Array(n).fill(ROUND_NONE); this.roundDz = new Int16Array(n);
    this.glass = null;
    const half = this.terrain.half + 200;
    this.gridMin = -half; this.gridN = Math.ceil((2 * half) / GRID_CELL);
    const counts = new Int32Array(this.gridN * this.gridN);
    const spans: Array<[number, number, number, number]> = [];
    for (let i = 0; i < n; i++) {
      const b = boxes[i];
      this.cx[i] = b.c[0]; this.cy[i] = b.c[1]; this.cz[i] = b.c[2];
      this.hx[i] = b.h[0]; this.hy[i] = b.h[1] + (b.pitch ? Math.abs(dmath.sin(b.pitch)) * b.h[2] : 0); this.hz[i] = b.h[2];
      const yaw = b.yaw ?? 0; this.cos[i] = dmath.cos(yaw); this.sin[i] = dmath.sin(yaw);
      this.surf[i] = surfaceIndex(b.surf); this.noShoot[i] = b.noShoot ? 1 : 0; this.noWalk[i] = b.noWalk ? 1 : 0; this.noDrive[i] = b.noDrive ? 1 : 0;
      if (b.round) { this.roundDx[i] = cm16(b.round[0] - this.cx[i]); this.roundDz[i] = cm16(b.round[1] - this.cz[i]); }
      if (this.surf[i] === GLASS_SURF && !b.noWalk && !b.pitch && isPaneBox(this.hx[i], this.hy[i], this.hz[i])) this.noShoot[i] = 1;   // glass: bullets break it, pass on
      const ex = Math.abs(this.cos[i]) * b.h[0] + Math.abs(this.sin[i]) * b.h[2];
      const ez = Math.abs(this.sin[i]) * b.h[0] + Math.abs(this.cos[i]) * b.h[2];
      const x0 = this.cell(b.c[0] - ex), x1 = this.cell(b.c[0] + ex), z0 = this.cell(b.c[2] - ez), z1 = this.cell(b.c[2] + ez);
      spans.push([x0, x1, z0, z1]);
      this.gx0[i] = x0; this.gz0[i] = z0;
      const bex = Math.abs(this.cos[i]) * this.hx[i] + Math.abs(this.sin[i]) * this.hz[i] + BOUNDS_PAD_M, bez = Math.abs(this.sin[i]) * this.hx[i] + Math.abs(this.cos[i]) * this.hz[i] + BOUNDS_PAD_M;
      this.bx0[i] = this.cx[i] - bex; this.bx1[i] = this.cx[i] + bex; this.bz0[i] = this.cz[i] - bez; this.bz1[i] = this.cz[i] + bez;
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) counts[z * this.gridN + x]++;
    }
    this.cellStart = new Int32Array(this.gridN * this.gridN + 1);
    for (let c = 0; c < counts.length; c++) this.cellStart[c + 1] = this.cellStart[c] + counts[c];
    this.cellItems = new Int32Array(this.cellStart[counts.length]);
    const fill = new Int32Array(counts.length);
    for (let i = 0; i < n; i++) {
      const [x0, x1, z0, z1] = spans[i];
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) { const c = z * this.gridN + x; this.cellItems[this.cellStart[c] + fill[c]++] = i; }
    }
    this.initScratch();
  }
  private cell(v: number) { return Math.min(this.gridN - 1, Math.max(0, Math.floor((v - this.gridMin) / GRID_CELL))); }
  /** (the client's fence-break effect, never the sim) the first box with `flag[i]` set that a vertical cylinder at
   * (x, z), radius r, from y0 to y1 overlaps, or −1 */
  firstFlagged(x: number, z: number, r: number, y0: number, y1: number, flag: Uint8Array): number {
    const x0 = this.cell(x - r - 1), x1 = this.cell(x + r + 1), z0 = this.cell(z - r - 1), z1 = this.cell(z + r + 1);
    for (let gz = z0; gz <= z1; gz++) for (let gx = x0; gx <= x1; gx++) {
      const c = gz * this.gridN + gx;
      for (let k = this.cellStart[c]; k < this.cellStart[c + 1]; k++) {
        const i = this.cellItems[k];
        if (!flag[i] || this.cy[i] + this.hy[i] < y0 || this.cy[i] - this.hy[i] > y1) continue;
        const dx = x - this.cx[i], dz = z - this.cz[i], lx = dx * this.cos[i] + dz * this.sin[i], lz = -dx * this.sin[i] + dz * this.cos[i];
        if (Math.abs(lx) < this.hx[i] + r && Math.abs(lz) < this.hz[i] + r) return i;
      }
    }
    return -1;
  }

  /** ground height + surface (terrain only) */
  ground(x: number, z: number) { return this.terrain.height(x, z); }

  // ---- capsule vs boxes. Capsule = vertical segment from (x, y+r) to (x, y+h-r), radius r. Writes the corrected
  // position into P (px, py, pz) and reports ground contact / normal into G.
  //
  // Solver:
  //  - every pass gathers ALL boxes the capsule overlaps (each box once), lifts onto the highest step / floor first
  //    (only when there is headroom above it), bumps the head only while moving up, and resolves the rest as
  //    half-planes with an accumulated minimum translation (Gauss-Seidel), up to SOLVER_ITER passes — opposing pushes
  //    do not cancel each other out the way three sequential passes do (legacySolver).
  //  - box corners that protrude ≤ LIP past the face you slide along are squared off (corner skin): a proud kit seam
  //    nudges the capsule sideways instead of eating the sprint speed.
  //  - with a known start of the move (resolveMove, the mover): an unresolvable overlap (a slot narrower than the capsule)
  //    reverts the horizontal move (the slot acts as a wall); an overlap that was already there (spawned / pushed inside a
  //    box) glides to the nearest free spot at ≤ DEPEN_STEP per tick instead of popping out in one tick.
  //  - `unstick(p, …)` (called once per ground tick by the mover): ≥ 1 s of move input with < 0.3 m of net progress in a
  //    pocket the capsule cannot walk out of → glide to the nearest free, open, standable spot within 2.5 m (lifts up to
  //    2 × STEP_H). Deterministic: the server and the client prediction run the same code on the same state.
  readonly P = new Float64Array(3);
  readonly G = new Float64Array(5);   // [grounded(0/1), nx, ny, nz, surf]
  private boxesTouched = 0;
  /** set by the mover before resolveCapsule; read back after (wall clipping + head bump) */
  velY = 0; wallHit = false; wallNx = 0; wallNz = 0; headBump = false;
  /** read back after a resolve: the step-up lift it applied (m, ≥ 0 — the client can smooth it visually), true when it
   * was a capped depenetration glide, true when an overlap was left unresolved (probe callers without a move start) */
  stepDy = 0; depen = false; overlap = false;
  /** tools only (scanner precision checks): disable the pocket unstick */
  unstickOff = false;
  /** tools only (A/B + the scanner's planted embed self-test): the legacy solver — 3 sequential per-box pushes, no
   * depenetration cap, no unstick. Never set in the game. */
  legacySolver = false;
  private hasFrom = false; private fromX = 0; private fromY = 0; private fromZ = 0;

  // scratch (allocated once; tools/play attachWorld calls initScratch on a shared-memory world)
  private stamp!: Uint32Array; private gen = 0;
  private cI!: Int32Array; private cK!: Uint8Array; private cNX!: Float64Array; private cNZ!: Float64Array; private cD!: Float64Array;
  private LB!: Int32Array; private nLB = 0; private lcx = 0; private lcz = 0;
  private LV!: Float64Array; private LN!: Uint8Array; private LF!: Uint8Array; private LD!: Uint8Array; private CP!: Int32Array; private CO!: Uint8Array; private STK!: Int32Array;
  /** result register of findFree / unstick searches */
  readonly FT = new Float64Array(3);

  initScratch() {
    this.stamp = new Uint32Array(Math.max(1, this.n)); this.gen = 0;
    this.cI = new Int32Array(MAXC); this.cK = new Uint8Array(MAXC);
    this.cNX = new Float64Array(MAXC); this.cNZ = new Float64Array(MAXC); this.cD = new Float64Array(MAXC);
    this.LB = new Int32Array(MAXLB);
    const W2 = WN2 * WN2;
    this.LV = new Float64Array(W2 * MAXLV); this.LN = new Uint8Array(W2); this.LF = new Uint8Array(W2 * MAXLV); this.LD = new Uint8Array(W2 * MAXLV);
    this.CP = new Int32Array(W2 * MAXLV); this.CO = new Uint8Array(W2 * MAXLV + 2); this.STK = new Int32Array(W2 * MAXLV);
  }
  private nextGen() { if (++this.gen > 0xfffffff0) { this.stamp.fill(0); this.gen = 1; } return this.gen; }

  /** the mover's resolve: (x, y, z) is the integrated position, (dx, dy, dz) the motion that got it there this (sub)step */
  resolveMove(x: number, y: number, z: number, dx: number, dy: number, dz: number, r: number, h: number, stepUp: boolean): void {
    this.hasFrom = true; this.fromX = x - dx; this.fromY = y - dy; this.fromZ = z - dz;
    this.resolveCapsule(x, y, z, r, h, stepUp);
    this.stepAcc += this.stepDy;
  }
  // per-player step-up of the last ground tick (the renderer smooths the body / camera over ~90 ms instead of showing a
  // 0.55 m single-tick snap): the mover's unstick() call opens a player's tick, resolveMove accumulates its lifts
  private stepBody: object | null = null; private stepAcc = 0;
  /** metres the solver stepped player `p` up during its last ground tick (0 = none). Client render: on a new value > 0,
   * add −value to a render-only Y offset that decays to 0 over 80-100 ms. */
  stepLift(p: object): number { if (p === this.stepBody) return this.stepAcc; const S = US.get(p); return S ? S[9] : 0; }
  private openTick(p: object) {
    if (this.stepBody && this.stepBody !== p) { let S = US.get(this.stepBody); if (!S) US.set(this.stepBody, S = new Float64Array(10)); S[9] = this.stepAcc; }
    this.stepBody = p; this.stepAcc = 0;
  }

  /**
   * Move a capsule from its current position (already integrated) out of every box it penetrates. Also sets G.
   * `stepUp` allows walking up boxes lower than STEP_H.
   */
  resolveCapsule(x: number, y: number, z: number, r: number, h: number, stepUp: boolean): void {
    const P = this.P, G = this.G;
    P[0] = x; P[1] = y; P[2] = z;
    G[0] = 0; G[1] = 0; G[2] = 1; G[3] = 0; G[4] = 5;
    this.stepDy = 0; this.depen = false; this.overlap = false;
    const hasFrom = this.hasFrom; this.hasFrom = false;
    this.floorTerrain();
    this.boxesTouched = 0;
    if (this.legacySolver) { this.legacyResolve(r, h, stepUp); return; }
    const ok = this.solve(r, h, stepUp);
    if (!hasFrom) { this.overlap = !ok; return; }
    const fx = this.fromX, fy = this.fromY, fz = this.fromZ;
    if (!ok) {
      // 1. no position satisfies every contact (a slot narrower than the capsule, two walls closing in): take back the
      //    horizontal part of this move — the gap acts as a wall — if the start of the move was clear
      const wallX = this.wallNx, wallZ = this.wallNz;
      P[0] = fx; P[1] = y; P[2] = fz; G[0] = 0; G[1] = 0; G[2] = 1; G[3] = 0; G[4] = 5; this.stepDy = 0;
      this.floorTerrain();
      if (this.solve(r, h, stepUp)) {
        const bx = fx - x, bz = fz - z, bl = dmath.hypot(bx, bz);
        if (bl > 1e-9) { this.wallHit = true; this.wallNx = bx / bl; this.wallNz = bz / bl; } else { this.wallNx = wallX; this.wallNz = wallZ; }
        return;
      }
      // 2. already embedded where the move started: glide toward the nearest free standable spot
      if (this.findFree(fx, fy, fz, r, h)) { this.glide(fx, fy, fz, this.FT[0], this.FT[1], this.FT[2]); return; }
      // 3. buried in a volume with no free spot in reach (a POI collider box swallowing the terrain surface): the boxes
      //    cannot mean anything here — take the move exactly as integrated (on the terrain) so the player walks out
      //    under their own control. Never keep solve()'s best-effort push: that carries a player who gives no input
      //    0.5 m per tick uphill
      P[0] = x; P[1] = y; P[2] = z; G[0] = 0; G[1] = 0; G[2] = 1; G[3] = 0; G[4] = 5; this.stepDy = 0;
      this.floorTerrain();
      this.overlap = true; return;
    }
    // converged, but the push goes far beyond this tick's own motion (the capsule started inside a box): glide out over
    // several ticks — toward the nearest free standable spot (a stable target tick after tick), else where it converged
    const dx = P[0] - fx, dz = P[2] - fz, dl = dmath.hypot(dx, dz);
    const moveLen = dmath.hypot(x - fx, z - fz);
    if (dl > DEPEN_STEP && dl > moveLen + 0.02) {
      const cx = P[0], cy = P[1], cz = P[2];
      if (this.findFree(fx, fy, fz, r, h)) this.glide(fx, fy, fz, this.FT[0], this.FT[1], this.FT[2]);
      else this.glide(fx, cy, fz, cx, cy, cz);
    }
  }

  /** P = from + (to - from) capped to DEPEN_STEP; held as grounded, the wall normal = the glide direction */
  private glide(fx: number, fy: number, fz: number, tx: number, ty: number, tz: number) {
    const P = this.P, G = this.G;
    const dx = tx - fx, dy = ty - fy, dz = tz - fz, d = dmath.hypot3(dx, dy, dz);
    const k = d > DEPEN_STEP ? DEPEN_STEP / d : 1;
    P[0] = fx + dx * k; P[1] = fy + dy * k; P[2] = fz + dz * k;
    const gy = this.terrain.height(P[0], P[2]); if (P[1] < gy) P[1] = gy;
    G[0] = 1; G[1] = 0; G[2] = 1; G[3] = 0;
    const hl = dmath.hypot(dx, dz);
    if (hl > 1e-9) { this.wallHit = true; this.wallNx = dx / hl; this.wallNz = dz / hl; }
    this.depen = true;
  }

  private floorTerrain() {
    const P = this.P, G = this.G;
    const gy = this.terrain.height(P[0], P[2]);
    if (P[1] < gy) { P[1] = gy; G[0] = 1; const nn = this.terrain.normal(P[0], P[2], TN); G[1] = nn[0]; G[2] = nn[1]; G[3] = nn[2]; G[4] = 255; }
    else if (P[1] - gy < 0.04) { G[0] = 1; const nn = this.terrain.normal(P[0], P[2], TN); G[1] = nn[0]; G[2] = nn[1]; G[3] = nn[2]; G[4] = 255; }
  }

  /** contact passes on P; true = nothing left overlapping (≤ 1 cm) */
  private solve(r: number, h: number, stepUp: boolean): boolean {
    const P = this.P, G = this.G, cK = this.cK, cI = this.cI, cNX = this.cNX, cNZ = this.cNZ, cD = this.cD;
    for (let it = 0; it < SOLVER_ITER; it++) {
      const n = this.gather(r, h, stepUp);
      if (n === 0) return true;
      this.boxesTouched += n;
      // 1. floors: lift onto the highest step / top in reach — only if the head then fits under whatever is above
      let L = -Infinity, ls = 0;
      for (let k = 0; k < n; k++) if (cK[k] === 0) { const top = this.cy[cI[k]] + this.hy[cI[k]]; if (top > L) { L = top; ls = this.surf[cI[k]]; } }
      if (L > -Infinity) {
        if (this.headroom(L, r, h)) {
          this.stepDy += L - P[1]; P[1] = L;
          G[0] = 1; G[1] = 0; G[2] = 1; G[3] = 0; G[4] = ls;
          continue;
        }
        for (let k = 0; k < n; k++) if (cK[k] === 0) cK[k] = 2;   // no headroom: the step is a wall
      }
      // 2. ceilings: bump the head while moving up; otherwise a slab edge at head height is a wall
      let bump = Infinity;
      for (let k = 0; k < n; k++) if (cK[k] === 1) {
        this.headBump = true;
        if (this.velY > 0.5) { const bot = this.cy[cI[k]] - this.hy[cI[k]]; if (bot < bump) bump = bot; } else cK[k] = 2;
      }
      if (bump < Infinity) { P[1] = bump - h; if (this.velY > 0) this.velY = 0; continue; }
      // 3. walls: the smallest horizontal move that clears every contact half-plane (accumulated MTVs). If none exists
      //    (opposing walls closer than the capsule is wide), allow SQUEEZE of overlap per wall — a gap a few cm narrower
      //    than the capsule is still passable — and otherwise report failure.
      let vx = 0, vz = 0, viol = 0, ns = 0;
      for (let pass = 0; pass < 2; pass++) {
        const slack = pass === 0 ? 0 : SQUEEZE;
        vx = 0; vz = 0;
        for (let sw = 0; sw < 24; sw++) {
          for (let k = 0; k < n; k++) if (cK[k] === 2) {
            const e = cD[k] - slack - (cNX[k] * vx + cNZ[k] * vz);
            if (e > 0) { vx += cNX[k] * e; vz += cNZ[k] * e; }
          }
          viol = 0; ns = 0;
          for (let k = 0; k < n; k++) if (cK[k] === 2) { ns++; const e = cD[k] - slack - (cNX[k] * vx + cNZ[k] * vz); if (e > viol) viol = e; }
          if (viol < 1e-5) break;
        }
        if (viol <= 0.004) break;
      }
      if (ns === 0) return true;
      const vl = dmath.hypot(vx, vz);
      if (viol > 0.004 || vl > 3) {                     // opposing contacts: no single move clears them all
        const k = vl > 0.5 ? 0.5 / vl : 1; P[0] += vx * k; P[2] += vz * k;   // best effort (probe callers see it moved)
        return false;
      }
      if (vl < 1e-9) return true;
      P[0] += vx; P[2] += vz;
      this.wallHit = true; this.wallNx = vx / vl; this.wallNz = vz / vl;
    }
    // out of passes: converged if what is left is a hair
    const n = this.gather(r, h, stepUp);
    for (let k = 0; k < n; k++) {
      const i = cI[k];
      const d = cK[k] === 0 ? this.cy[i] + this.hy[i] - P[1] : cK[k] === 1 ? P[1] + h - (this.cy[i] - this.hy[i]) : cD[k];
      if (d > 0.01 + SQUEEZE) return false;
    }
    return true;
  }

  /**
   * every box the capsule at P overlaps (each once): kind 0 = floor / step to lift onto, 1 = ceiling, 2 = wall with its
   * world-space push normal (cNX, cNZ) and depth cD. Returns the count.
   */
  private gather(r: number, h: number, stepUp: boolean): number {
    const P = this.P, px = P[0], pz = P[2], capBot = P[1], capTop = P[1] + h;
    const gen = this.nextGen(), stamp = this.stamp;
    let n = 0;
    const x0 = this.cell(px - r - 1), x1 = this.cell(px + r + 1), z0 = this.cell(pz - r - 1), z1 = this.cell(pz + r + 1);
    for (let gz = z0; gz <= z1; gz++) for (let gx = x0; gx <= x1; gx++) {
      const c = gz * this.gridN + gx;
      for (let k = this.cellStart[c]; k < this.cellStart[c + 1]; k++) {
        const i = this.cellItems[k];
        if (stamp[i] === gen) continue; stamp[i] = gen;
        if (this.noWalk[i] || (this.drive && this.noDrive[i])) continue;
        if (this.bx1[i] < px - r || this.bx0[i] > px + r || this.bz1[i] < pz - r || this.bz0[i] > pz + r) continue;
        const top = this.cy[i] + this.hy[i], bot = this.cy[i] - this.hy[i];
        if (capBot >= top || capTop <= bot + CEIL_TOL) continue;
        const dx = px - this.cx[i], dz = pz - this.cz[i];
        const cs = this.cos[i], sn = this.sin[i];
        const lx = dx * cs + dz * sn, lz = -dx * sn + dz * cs;
        const hx = this.hx[i], hz = this.hz[i];
        const sx = lx >= 0 ? 1 : -1, sz = lz >= 0 ? 1 : -1;
        const ox = sx * lx - hx, oz = sz * lz - hz;       // > 0 = outside that slab
        let nx: number, nz: number, side: number;
        if (ox <= 0 && oz <= 0) {                          // centre inside the footprint: out through the nearest face
          if (-ox < -oz) { nx = sx; nz = 0; side = r - ox; } else { nx = 0; nz = sz; side = r - oz; }
        } else if (oz <= 0) { if (ox >= r) continue; nx = sx; nz = 0; side = r - ox; }
        else if (ox <= 0) { if (oz >= r) continue; nx = 0; nz = sz; side = r - oz; }
        else {
          const d2 = ox * ox + oz * oz; if (d2 >= r * r) continue;
          const fx = r - ox, fz = r - oz;
          // corner skin: a corner that sticks out ≤ LIP past a face is treated square (slide along that face)
          if (fz <= LIP && fz <= fx) { nx = 0; nz = sz; side = fz; }
          else if (fx <= LIP) { nx = sx; nz = 0; side = fx; }
          else { const d = Math.sqrt(d2); nx = sx * ox / d; nz = sz * oz / d; side = r - d; }
        }
        if (n >= MAXC) return n;
        const upDist = top - capBot, downDist = capTop - bot;
        let kind = 2;
        if (upDist <= 0.6 && ((stepUp && upDist <= STEP_H + 0.02) || upDist < side) && this.velY <= 0.5) kind = 0;
        else if (downDist < side && downDist < 0.5) kind = 1;
        if (kind === 2 && this.drive) {
          const rdx = this.roundDx[i];
          if (rdx === ROUND_NONE) this.wallFlat = true;
          else { this.wallRound = true; if (side > this.roundD) { this.roundD = side; this.roundX = this.cx[i] + rdx * 0.01; this.roundZ = this.cz[i] + this.roundDz[i] * 0.01; } }
        }
        this.cI[n] = i; this.cK[n] = kind; this.cD[n] = side + (kind === 2 ? 0.001 : 0);
        this.cNX[n] = nx * cs - nz * sn; this.cNZ[n] = nx * sn + nz * cs;
        n++;
      }
    }
    return n;
  }

  // ---- the legacy solver, verbatim (tools only: legacySolver)
  private legacyResolve(r: number, h: number, stepUp: boolean) {
    const P = this.P;
    for (let iter = 0; iter < 3; iter++) {
      let any = false;
      const x0 = this.cell(P[0] - r - 1), x1 = this.cell(P[0] + r + 1), z0 = this.cell(P[2] - r - 1), z1 = this.cell(P[2] + r + 1);
      for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) {
        const c = cz * this.gridN + cx;
        for (let k = this.cellStart[c]; k < this.cellStart[c + 1]; k++) {
          const i = this.cellItems[k];
          if (this.noWalk[i] || (this.drive && this.noDrive[i])) continue;
          if (this.legacyPushOut(i, r, h, stepUp)) any = true;
        }
      }
      if (!any) break;
    }
  }
  private legacyPushOut(i: number, r: number, h: number, stepUp: boolean): boolean {
    const P = this.P;
    const dx = P[0] - this.cx[i], dz = P[2] - this.cz[i];
    const c = this.cos[i], s = this.sin[i];
    const lx = dx * c + dz * s, lz = -dx * s + dz * c;
    const hx = this.hx[i], hz = this.hz[i], hy = this.hy[i];
    const top = this.cy[i] + hy, bot = this.cy[i] - hy;
    const capBot = P[1], capTop = P[1] + h;
    if (capBot >= top || capTop <= bot) return false;
    const qx = Math.max(-hx, Math.min(hx, lx)), qz = Math.max(-hz, Math.min(hz, lz));
    const ddx = lx - qx, ddz = lz - qz, d2 = ddx * ddx + ddz * ddz;
    if (d2 >= r * r) return false;
    const upDist = top - capBot;
    const sideDist = r - Math.sqrt(d2);
    const canStep = stepUp && upDist <= STEP_H + 0.02;
    const insideRect = d2 === 0;
    if (upDist <= 0.6 && (canStep || upDist < sideDist) && this.velY <= 0.5) {
      P[1] = top; this.G[0] = 1; this.G[1] = 0; this.G[2] = 1; this.G[3] = 0; this.G[4] = this.surf[i]; this.boxesTouched++;
      return true;
    }
    const downDist = capTop - bot;
    if (downDist < sideDist && downDist < 0.5) { P[1] = bot - h; if (this.velY > 0) this.velY = 0; this.headBump = true; return true; }
    let nx: number, nz: number;
    if (insideRect) {
      const ex = hx - Math.abs(lx), ez = hz - Math.abs(lz);
      if (ex < ez) { nx = lx >= 0 ? 1 : -1; nz = 0; P[0] += (nx * (ex + r)) * c; P[2] += (nx * (ex + r)) * s; }
      else { nx = 0; nz = lz >= 0 ? 1 : -1; P[0] += -(nz * (ez + r)) * s; P[2] += (nz * (ez + r)) * c; }
    } else {
      const d = Math.sqrt(d2); nx = ddx / d; nz = ddz / d;
      const push = r - d + 0.001;
      P[0] += (nx * push) * c - (nz * push) * s;
      P[2] += (nx * push) * s + (nz * push) * c;
    }
    this.wallNx = nx * c - nz * s; this.wallNz = nx * s + nz * c; this.wallHit = true;
    this.boxesTouched++;
    return true;
  }

  /** can the capsule stand with its feet at L (after a lift) without its head going deep into something above? */
  private headroom(L: number, r: number, h: number): boolean {
    const P = this.P, px = P[0], pz = P[2];
    const gen = this.nextGen(), stamp = this.stamp;
    const x0 = this.cell(px - r - 1), x1 = this.cell(px + r + 1), z0 = this.cell(pz - r - 1), z1 = this.cell(pz + r + 1);
    for (let gz = z0; gz <= z1; gz++) for (let gx = x0; gx <= x1; gx++) {
      const c = gz * this.gridN + gx;
      for (let k = this.cellStart[c]; k < this.cellStart[c + 1]; k++) {
        const i = this.cellItems[k];
        if (stamp[i] === gen) continue; stamp[i] = gen;
        if (this.noWalk[i] || (this.drive && this.noDrive[i])) continue;
        const bot = this.cy[i] - this.hy[i];
        if (bot <= L + 0.02 || bot >= L + h - 0.01) continue;
        if (this.sideDepth(i, px, pz, r) > 0.1) return false;
      }
    }
    return true;
  }

  /** horizontal penetration of a circle (x, z, r) into box i's footprint (0 = clear) */
  private sideDepth(i: number, x: number, z: number, r: number): number {
    const dx = x - this.cx[i], dz = z - this.cz[i];
    const lx = dx * this.cos[i] + dz * this.sin[i], lz = -dx * this.sin[i] + dz * this.cos[i];
    const ox = Math.abs(lx) - this.hx[i], oz = Math.abs(lz) - this.hz[i];
    if (ox <= 0 && oz <= 0) return r - Math.max(ox, oz);
    const qx = ox > 0 ? ox : 0, qz = oz > 0 ? oz : 0;
    const d = Math.sqrt(qx * qx + qz * qz);
    return d < r ? r - d : 0;
  }

  // ---- local search window (depenetration target + unstick): WN × WN cells of `ws` m around (lcx, lcz), each with up to
  // MAXLV standable levels (terrain + box tops), a free flag per level, a drop flag (walking off a ledge: no floor in
  // step / fall reach, the capsule fits in the air there) and a flood-fill component id.
  private ws = WS; private yref = 0; private wc = WC; private wn = WN;
  private buildLocal(x: number, y: number, z: number, r: number, ws: number, wc = WC) {
    this.lcx = x; this.lcz = z; this.nLB = 0; this.ws = ws; this.yref = y; this.wc = wc; this.wn = 2 * wc + 1;
    const R = wc * ws + r + 0.5;
    const gen = this.nextGen(), stamp = this.stamp;
    const x0 = this.cell(x - R), x1 = this.cell(x + R), z0 = this.cell(z - R), z1 = this.cell(z + R);
    for (let gz = z0; gz <= z1; gz++) for (let gx = x0; gx <= x1; gx++) {
      const c = gz * this.gridN + gx;
      for (let k = this.cellStart[c]; k < this.cellStart[c + 1]; k++) {
        const i = this.cellItems[k];
        if (stamp[i] === gen) continue; stamp[i] = gen;
        if (this.noWalk[i] || (this.drive && this.noDrive[i])) continue;
        const top = this.cy[i] + this.hy[i], bot = this.cy[i] - this.hy[i];
        if (top < y - 4 || bot > y + 4) continue;
        const ex = Math.abs(this.cos[i]) * this.hx[i] + Math.abs(this.sin[i]) * this.hz[i];
        const ez = Math.abs(this.sin[i]) * this.hx[i] + Math.abs(this.cos[i]) * this.hz[i];
        if (Math.abs(this.cx[i] - x) > ex + R || Math.abs(this.cz[i] - z) > ez + R) continue;
        if (this.nLB < MAXLB) this.LB[this.nLB++] = i;
      }
    }
    this.LN.fill(255, 0, this.wn * this.wn); this.CP.fill(0, 0, this.wn * this.wn * MAXLV);
    // 1 m buckets over the window: each local box listed in every bucket its footprint (+ r + 0.1) overlaps, so a free /
    // level test looks at a handful of boxes instead of all of them (the ±10 m window holds up to thousands in town)
    const nb = this.bkN = Math.min(BKMAX, Math.ceil(2 * R) + 1), BKS = this.BKS, BKI = this.BKI;
    this.bkX0 = x - R; this.bkZ0 = z - R; BKS.fill(0, 0, nb * nb + 1);
    const span = (k: number, out: Int32Array) => {
      const i = this.LB[k], m = r + 0.1;
      const ex = Math.abs(this.cos[i]) * this.hx[i] + Math.abs(this.sin[i]) * this.hz[i] + m, ez = Math.abs(this.sin[i]) * this.hx[i] + Math.abs(this.cos[i]) * this.hz[i] + m;
      out[0] = Math.max(0, Math.floor(this.cx[i] - ex - this.bkX0)); out[1] = Math.min(nb - 1, Math.floor(this.cx[i] + ex - this.bkX0));
      out[2] = Math.max(0, Math.floor(this.cz[i] - ez - this.bkZ0)); out[3] = Math.min(nb - 1, Math.floor(this.cz[i] + ez - this.bkZ0));
    };
    let total = 0;
    for (let k = 0; k < this.nLB; k++) { span(k, SPN); for (let bz = SPN[2]; bz <= SPN[3]; bz++) for (let bx = SPN[0]; bx <= SPN[1]; bx++) { BKS[bz * nb + bx + 1]++; total++; } }
    this.bkOk = total <= BKI.length;
    if (!this.bkOk) return;
    for (let b = 0; b < nb * nb; b++) BKS[b + 1] += BKS[b];
    const fill = this.BKF; fill.set(BKS.subarray(0, nb * nb));
    for (let k = 0; k < this.nLB; k++) { span(k, SPN); for (let bz = SPN[2]; bz <= SPN[3]; bz++) for (let bx = SPN[0]; bx <= SPN[1]; bx++) BKI[fill[bz * nb + bx]++] = this.LB[k]; }
  }
  private bkN = 0; private bkX0 = 0; private bkZ0 = 0; private bkOk = false;
  private BKS = new Int32Array(BKMAX * BKMAX + 1); private BKF = new Int32Array(BKMAX * BKMAX); private BKI = new Int32Array(BKCAP);
  /** [start, end) of the local boxes to test at (x, z): its bucket, or every local box when bucketing overflowed */
  private bucket(x: number, z: number): void {
    if (!this.bkOk) { BR[0] = 0; BR[1] = this.nLB; BR[2] = 0; return; }
    const n = this.bkN, bx = Math.floor(x - this.bkX0), bz = Math.floor(z - this.bkZ0);
    if (bx < 0 || bz < 0 || bx >= n || bz >= n) { BR[0] = 0; BR[1] = 0; BR[2] = 1; return; }
    const b = bz * n + bx; BR[0] = this.BKS[b]; BR[1] = this.BKS[b + 1]; BR[2] = 1;
  }
  private cellX(c: number) { return this.lcx + ((c % this.wn) - this.wc) * this.ws; }
  private cellZ(c: number) { return this.lcz + (((c / this.wn) | 0) - this.wc) * this.ws; }
  /** levels of window cell c between ylo and yhi (computed once per buildLocal); free = the capsule (radius rf) fits */
  private cellLevels(c: number, ylo: number, yhi: number, rf: number, h: number): number {
    if (this.LN[c] !== 255) return this.LN[c];
    const cx = this.cellX(c), cz = this.cellZ(c);
    const base = c * MAXLV, LV = this.LV, yref = this.yref;
    let n = 0, near = false, steepAt = -1;
    const gy = this.terrain.height(cx, cz);
    if (gy >= ylo && gy <= yhi && gy > WATER_Y) {
      this.terrain.normal(cx, cz, TN);
      // a slide slope: a way out for findFree; for the unstick flood a surface you only move DOWN on (never a target)
      if (TN[1] < TERRAIN_SLIDE_NY) steepAt = n;
      LV[base + n++] = gy;
    }
    this.bucket(cx, cz); const k0 = BR[0], k1 = BR[1], viaB = BR[2] === 1;
    for (let k = k0; k < k1 && n < MAXLV - 1; k++) {
      const i = viaB ? this.BKI[k] : this.LB[k], top = this.cy[i] + this.hy[i];
      if (top < ylo || top > yhi || top < gy - 0.02) continue;
      const dx = cx - this.cx[i], dz = cz - this.cz[i];
      const lx = dx * this.cos[i] + dz * this.sin[i], lz = -dx * this.sin[i] + dz * this.cos[i];
      // a capsule stands on a top its circle overlaps (the solver lifts it there), not only where its centre is over it
      if (Math.abs(lx) > this.hx[i] + rf || Math.abs(lz) > this.hz[i] + rf) continue;
      // levels a few cm apart are one floor (a plaza slab 5 cm over the terrain): keep the higher, where the capsule rests
      let dup = false; for (let j = 0; j < n; j++) if (Math.abs(LV[base + j] - top) < LEVEL_MERGE) { if (top > LV[base + j]) LV[base + j] = top; dup = true; break; }
      if (!dup) LV[base + n++] = top;
    }
    for (let j = 0; j < n; j++) {
      this.LF[base + j] = this.fits(cx, LV[base + j], cz, rf, h) ? 1 : 0; this.LD[base + j] = j === steepAt ? 2 : 0;
      const dy = LV[base + j] - yref; if (dy >= -1.6 && dy <= STEP_H + 0.05) near = true;
    }
    // nothing to stand on within step / short-fall reach of the reference height and a real drop below (> 1.6 m, or
    // water), the capsule fitting in the air there: walking off this ledge is a way out
    if (!near && n < MAXLV && (yref > gy + 1.6 || gy <= WATER_Y) && this.fits(cx, yref, cz, rf, h)) { LV[base + n] = yref; this.LF[base + n] = 1; this.LD[base + n] = 1; n++; }
    this.LN[c] = n;
    return n;
  }
  /** box tops this far above the feet do not block `fits` (set per search: STEP_H for walk links — the solver lifts the
   * capsule onto a step — but only a lip of LEVEL_MERGE for a place the capsule must truly stand free in) */
  private stepTol = LEVEL_MERGE;
  /** does a capsule (radius rf) stand at (x, fy, z) without overlapping any local box? */
  private fits(x: number, fy: number, z: number, rf: number, h: number, tol = this.stepTol): boolean {
    this.bucket(x, z); const k0 = BR[0], k1 = BR[1], viaB = BR[2] === 1;
    for (let k = k0; k < k1; k++) {
      const i = viaB ? this.BKI[k] : this.LB[k];
      const top = this.cy[i] + this.hy[i], bot = this.cy[i] - this.hy[i];
      if (top <= fy + tol || bot >= fy + h - CEIL_TOL) continue;
      if (this.sideDepth(i, x, z, rf) > 0.005) return false;
    }
    return true;
  }

  /**
   * nearest spot within 2.5 m (else 5 m) of (x, y, z) where the capsule stands free (terrain — slide slopes included —
   * or a box top, −3 .. +2·STEP_H from y). Deterministic scan order. Result in FT. Used for depenetration.
   */
  findFree(x: number, y: number, z: number, r: number, h: number): boolean {
    this.steepOk = true;
    try { return this.findFreeIn(x, y, z, r, h); } finally { this.steepOk = false; }
  }
  private steepOk = false;
  private findFreeIn(x: number, y: number, z: number, r: number, h: number): boolean {
    this.stepTol = LEVEL_MERGE;
    for (let pass = 0; pass < 2; pass++) {
      this.buildLocal(x, y, z, r, pass === 0 ? WS : WS * 2);
      const ylo = y - 3, yhi = y + UNSTICK_LIFT, ws = this.ws;
      let best = Infinity;
      const ORD = ORD41;
      for (let o = 0; o < ORD.order.length; o++) {
        const c = ORD.order[o], dist = ORD.dist[o] * ws;
        if (dist > best) break;
        const n = this.cellLevels(c, ylo, yhi, r + 0.01, h);
        for (let j = 0; j < n; j++) {
          const id = c * MAXLV + j;
          if (!this.LF[id] || this.LD[id] === 1 || (this.LD[id] === 2 && !this.steepOk)) continue;
          const ly = this.LV[id], dy = ly - y;
          const cost = dist + (dy > 0 ? 0.5 * dy : -0.35 * dy);
          if (cost < best) { best = cost; this.FT[0] = this.cellX(c); this.FT[1] = ly; this.FT[2] = this.cellZ(c); }
        }
      }
      if (best < Infinity) return true;
    }
    return false;
  }

  /** can the capsule walk 1.5 m away from (x, y, z) in any of 16 straight directions? (the real solver, 0.1 m steps,
   * sliding along walls, stepping up — a walk test without the clock). A pocket fails it. */
  mobile(x: number, y: number, z: number, r: number, h: number): boolean {
    const acc = this.stepAcc;                           // probe lifts must not count as the player's step
    try {
      for (let d = 0; d < 16; d++) {
        const a = d / 16 * Math.PI * 2, dx = dmath.sin(a) * 0.1, dz = dmath.cos(a) * 0.1;
        let px = x, py = y, pz = z;
        for (let k = 0; k < 24; k++) {
          this.velY = 0; this.headBump = false; this.wallHit = false;
          this.resolveMove(px + dx, py, pz + dz, dx, 0, dz, r, h, true);    // exactly as the mover moves (reverts a squeeze)
          if (this.depen || this.overlap) break;                             // a depenetration glide is not walking
          const prog = dmath.hypot(this.P[0] - px, this.P[2] - pz);
          px = this.P[0]; py = this.P[1]; pz = this.P[2];
          if (dmath.hypot(px - x, pz - z) >= 1.5) return true;
          if (prog < 0.02) break;
        }
      }
      return false;
    } finally { this.stepAcc = acc; }
  }

  /**
   * Is a capsule standing at (x, y, z) enclosed — in a pocket / pen it cannot walk out of (the walkable area it is in
   * never leaves the ±2.5 m, ±5 m or ±10 m window and has no ledge to walk off)? If so, FT = the nearest free standable
   * spot in an OPEN area (one that reaches the window edge or a ledge) and true. Walk links: 8-neighbour cells (0.125 m:
   * any doorway ≥ 0.9 m wide is found), up ≤ STEP_H, down ≤ 1.6 m.
   */
  findUnstick(x: number, y: number, z: number, r: number, h: number, wx = 0, wz = 0, pocket = false): boolean {
    // ±2.5 m at 0.125 m (pockets), then ±5 m at 0.25 m and ±10 m at 0.5 m (pens / courtyards / alleys that trap a player
    // without being a tight pocket). Coarse walk links check the midpoint too, so they never leak through a thin wall.
    let enclosed = false; this.enclosedAt = -1;
    for (let pass = 0; pass < 3; pass++) {
      // ±2.5 m at 0.125 m · ±5 m at 0.25 m · ±10 m at 0.25 m (81² cells); coarse links: capsule 0.30 m + midpoint test
      const ws = pass === 0 ? WS : WS * 2, wc = pass === 2 ? WC2 : WC, rc = pass === 0 ? r - FLOOD_SLIM : r - 0.12;
      this.midCheck = pass > 0; this.stepTol = STEP_H + 0.02;
      this.buildLocal(x, y, z, r, ws, wc);
      const ylo = y - (pass === 0 ? 3 : 4.5), yhi = y + (pass === 0 ? UNSTICK_LIFT : UNSTICK_LIFT_FAR) + 0.6;
      // seed: the level the player stands on (the solver keeps it clear; a box edge the centre is just off may not be
      // one of the cell's levels) — else the highest free level at the centre cell at or below the feet
      const c0 = wc * this.wn + wc; let n0 = this.cellLevels(c0, ylo, yhi, rc, h);
      { let has = false; for (let j = 0; j < n0; j++) if (Math.abs(this.LV[c0 * MAXLV + j] - y) < 0.05) { this.LF[c0 * MAXLV + j] = 1; this.LD[c0 * MAXLV + j] = 0; has = true; }
        if (!has && n0 < MAXLV) { this.LV[c0 * MAXLV + n0] = y; this.LF[c0 * MAXLV + n0] = 1; this.LD[c0 * MAXLV + n0] = 0; this.LN[c0] = ++n0; } }
      let seed = -1;
      for (let j = 0; j < n0; j++) { const id = c0 * MAXLV + j, ly = this.LV[id]; if (ly <= y + 0.1 && this.LF[id] && this.LD[id] !== 1 && (seed < 0 || ly > this.LV[seed])) seed = id; }
      const open = seed >= 0 && this.flood(seed, 1, ylo, yhi, rc, h);
      // a pocket (the real solver cannot walk 1.5 m away) is enclosed whatever the lattice flood says (a gap narrower
      // than the capsule can look open to it); otherwise only a closed flood at this scale means enclosed (a pen)
      if (pass === 0 ? !pocket : open && !enclosed) continue;
      if (!enclosed) this.enclosedAt = pass;
      enclosed = true;
      // nearest level that fits the full capsule, is not in the enclosure and belongs to an open area (reaches the edge
      // of this window or a ledge); a coarser window may leak out of a pocket a finer one proved closed → keep ≥ 1.5 m
      const minD = open ? 1.5 : 0;
      let best = Infinity, label = 2;
      const ORD = pass === 2 ? ORD81 : ORD41;
      for (let o = 0; o < ORD.order.length; o++) {
        const c = ORD.order[o], dist = ORD.dist[o] * ws;
        if (dist * (1 - WISH_BIAS) > best) break;
        if (dist < minD) continue;
        const n = this.cellLevels(c, ylo, yhi, rc, h);
        for (let j = 0; j < n; j++) {
          const id = c * MAXLV + j;
          if (!this.LF[id] || (this.CP[id] === 1 && !open)) continue;
          const ly = this.LV[id], dy = ly - y;
          if (this.LD[id] === 2 && (dist < 1.2 || dy > -0.2)) continue;      // onto a slide slope: only away and downhill
          if (dy > (pass === 0 ? UNSTICK_LIFT : UNSTICK_LIFT_FAR) || dy < (this.LD[id] === 2 && pass > 0 ? -4 : -1.6)) continue;
          const cx = this.cellX(c), cz = this.cellZ(c);
          const along = dist > 1e-9 ? ((cx - x) * wx + (cz - z) * wz) / dist : 0;
          const cost = dist * (1 - WISH_BIAS * along) + (dy > 0 ? 0.5 * dy : -0.35 * dy);
          if (cost >= best) continue;
          if (this.CP[id] === 0) {
            if (label >= this.CO.length) break;
            this.CO[label] = this.flood(id, label, ylo, yhi, rc, h) ? 1 : 0; label++;
          }
          if (this.CP[id] !== 1 && !this.CO[this.CP[id]]) continue;
          if (!this.fits(cx, ly, cz, r + 0.01, h, LEVEL_MERGE)) continue;     // the target itself: truly free
          best = cost; this.FT[0] = cx; this.FT[1] = ly; this.FT[2] = cz;
        }
      }
      if (best < Infinity) { this.midCheck = false; this.stepTol = LEVEL_MERGE; return true; }
    }
    this.midCheck = false; this.stepTol = LEVEL_MERGE;
    return false;
  }
  private midCheck = false;
  /** tools: the window (0 = ±2.5 m, 1 = ±5 m, 2 = ±10 m) at which the last findUnstick found the player enclosed, −1 = not */
  enclosedAt = -1;
  /** depth-first walk over free levels from node s, labelling them; true as soon as it reaches the window edge or a ledge */
  private flood(s: number, label: number, ylo: number, yhi: number, rc: number, h: number): boolean {
    const STK = this.STK, CP = this.CP, LV = this.LV, LF = this.LF, LD = this.LD;
    let sp = 0; STK[sp++] = s; CP[s] = label;
    while (sp > 0) {
      const WNn = this.wn, WCn = this.wc;
      const id = STK[--sp], c = (id / MAXLV) | 0, ix = c % WNn, iz = (c / WNn) | 0, y0 = LV[id];
      if (LD[id] === 1 || ix === 0 || iz === 0 || ix === WNn - 1 || iz === WNn - 1) return true;
      for (let d = 0; d < 8; d++) {
        const nc = (iz + NBZ[d]) * WNn + ix + NBX[d];
        const n = this.cellLevels(nc, ylo, yhi, rc, h);
        for (let j = 0; j < n; j++) {
          const nid = nc * MAXLV + j;
          if (CP[nid] !== 0 || !LF[nid]) continue;
          const dy = LV[nid] - y0;
          if (dy > STEP_H + 0.02 || dy < -1.6) continue;
          if ((LD[nid] === 2 || LD[id] === 2) && dy > 0.02) continue;          // a slide slope only takes you down
          if (this.midCheck && LD[nid] !== 1 && !this.fits(this.lcx + (ix + NBX[d] * 0.5 - WCn) * this.ws, Math.max(y0, LV[nid]), this.lcz + (iz + NBZ[d] * 0.5 - WCn) * this.ws, rc, h)) continue;
          CP[nid] = label; if (sp < STK.length) STK[sp++] = nid;
        }
      }
    }
    return false;
  }

  /**
   * Unstick (called by the mover once per ground tick, before locomotion). Returns true when this tick was an unstick
   * glide (the mover then skips its own movement). Per-player state lives here, keyed by the player object.
   */
  unstick(p: UnstickBody, mx: number, mz: number, r: number, h: number, dt: number): boolean {
    this.openTick(p);
    if (this.unstickOff || this.legacySolver) return false;
    const moving = mx !== 0 || mz !== 0;
    let S = US.get(p);
    if (!S) { S = new Float64Array(10); S[1] = p.x; S[2] = p.z; US.set(p, S); }
    if (S[3] !== 0) {
      if (Math.abs(p.x - S[7]) + Math.abs(p.z - S[8]) > 0.5) S[3] = 0;             // moved by something else: drop it
      else {
        const dx = S[4] - p.x, dy = S[5] - p.y, dz = S[6] - p.z, d = dmath.hypot3(dx, dy, dz);
        if (d <= DEPEN_STEP) { p.x = S[4]; p.y = S[5]; p.z = S[6]; S[3] = 0; S[0] = 0; S[1] = p.x; S[2] = p.z; }
        else { const k = DEPEN_STEP / d; p.x += dx * k; p.y += dy * k; p.z += dz * k; }
        p.vx = 0; p.vy = 0; p.vz = 0; p.grounded = true; p.fallV = 0; p.airT = 0;
        S[7] = p.x; S[8] = p.z;
        return true;
      }
    }
    if (!moving || p.swim) { S[0] = 0; S[1] = p.x; S[2] = p.z; return false; }
    if (dmath.hypot(p.x - S[1], p.z - S[2]) > UNSTICK_D) { S[0] = 0; S[1] = p.x; S[2] = p.z; return false; }
    S[0] += dt;
    if (S[0] < UNSTICK_T) return false;
    S[0] = 0;                                                                        // re-arm: next check in 1 s
    // the direction the player is steering (forward = (-sin yaw, -cos yaw), right = (cos yaw, -sin yaw)): prefer a way out
    // that way, so holding the stick carries on instead of walking straight back into the next pocket
    const sy = dmath.sin(p.yaw), cy = dmath.cos(p.yaw);
    let wx = mz * -sy + mx * cy, wz = mz * -cy + mx * -sy; const wl = dmath.hypot(wx, wz); wx /= wl; wz /= wl;
    // judge from the floor under the player (mid-jump the feet are up to 1.2 m above it)
    let fy = p.y;
    if (!p.grounded) { this.raycast(p.x, p.y + 0.05, p.z, 0, -1, 0, 3.05, UH, false); if (UH.hit) fy = UH.y; }
    if (!this.findUnstick(p.x, fy, p.z, r, h, wx, wz, !this.mobile(p.x, fy, p.z, r, h))) return false;
    S[3] = 1; S[4] = this.FT[0]; S[5] = this.FT[1]; S[6] = this.FT[2]; S[7] = p.x; S[8] = p.z;
    return this.unstick(p, mx, mz, r, h, dt);
  }
  /** is this player in the middle of an unstick glide? */
  unsticking(p: object): boolean { const S = US.get(p); return !!S && S[3] !== 0; }
  /** forget a player's unstick state (tools teleporting a reused player object) */
  unstickReset(p: object) { US.delete(p); }

  // ---- raycast against boxes + terrain. Writes into `out`. dir need not be normalised (t in units of dir).
  // `firstHit` stops at the first hit found, which need not be the nearest: only for yes/no tests like clear().
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number, out: Hit, bullets = true, firstHit = false): Hit {
    out.hit = false; out.t = maxT; out.box = -1; out.cover = -1;
    // terrain: march with adaptive steps, refine with bisection
    const len = dmath.hypot3(dx, dy, dz);
    if (len > 0) {
      let t = 0, prevAbove = oy - this.terrain.height(ox, oz);
      if (prevAbove < 0) { // start under ground → immediate hit
        out.hit = true; out.t = 0; out.x = ox; out.y = oy; out.z = oz; const n = this.terrain.normal(ox, oz, TN); out.nx = n[0]; out.ny = n[1]; out.nz = n[2]; out.surf = 255;
      } else {
        const step0 = Math.max(0.5, Math.min(4, prevAbove * 0.5)) / len;
        let step = step0;
        while (t < out.t) {
          const nt = Math.min(out.t, t + step);
          const px = ox + dx * nt, py = oy + dy * nt, pz = oz + dz * nt;
          const above = py - this.terrain.height(px, pz);
          if (above < 0) {
            // bisect between t and nt
            let a = t, b = nt;
            for (let k = 0; k < 8; k++) { const m = (a + b) * 0.5; const ay = oy + dy * m - this.terrain.height(ox + dx * m, oz + dz * m); if (ay < 0) b = m; else a = m; }
            out.hit = true; out.t = a; out.x = ox + dx * a; out.y = oy + dy * a; out.z = oz + dz * a;
            const n = this.terrain.normal(out.x, out.z, TN); out.nx = n[0]; out.ny = n[1]; out.nz = n[2]; out.surf = 255; out.box = -1;
            break;
          }
          t = nt; prevAbove = above;
          step = Math.max(0.35, Math.min(6, above * 0.6)) / len;
        }
      }
    }
    // firstHit (a line-of-sight test): any hit decides the answer, so stop at the first one instead of finding the nearest
    if (firstHit && out.hit) return out;
    // boxes: walk grid cells along the ray (2D DDA over x/z)
    const ex = ox + dx * out.t, ez = oz + dz * out.t;
    const rx0 = Math.min(ox, ex), rx1 = Math.max(ox, ex), rz0 = Math.min(oz, ez), rz1 = Math.max(oz, ez);
    const cx0 = this.cell(rx0 - 1), cx1 = this.cell(rx1 + 1), cz0 = this.cell(rz0 - 1), cz1 = this.cell(rz1 + 1);
    const span = (cx1 - cx0 + 1) * (cz1 - cz0 + 1);
    if (span <= 64) {
      // a diagonal ray's cell rectangle is mostly cells it never enters: skip a cell (grown by the 1 m margin above)
      // unless the segment up to the nearest hit so far passes through it; the rest keep their row-major order
      // Skipping changes which cell first offers a box, so rayBox settles an exact tie as the full walk would have.
      const ix = 1 / dx, iz = 1 / dz;
      if (span > 2) { this.tieX0 = cx0; this.tieZ0 = cz0; }
      cells: for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) {
        if (span > 2) {
          const x0 = this.gridMin + cx * GRID_CELL - 1, z0 = this.gridMin + cz * GRID_CELL - 1, x1 = x0 + GRID_CELL + 2, z1 = z0 + GRID_CELL + 2;
          let t0 = 0, t1 = out.t;
          if (dx === 0) { if (ox < x0 || ox > x1) continue; }
          else { const a = (x0 - ox) * ix, b = (x1 - ox) * ix; t0 = Math.max(t0, Math.min(a, b)); t1 = Math.min(t1, Math.max(a, b)); }
          if (dz === 0) { if (oz < z0 || oz > z1) continue; }
          else { const a = (z0 - oz) * iz, b = (z1 - oz) * iz; t0 = Math.max(t0, Math.min(a, b)); t1 = Math.min(t1, Math.max(a, b)); }
          if (t0 > t1) continue;
        }
        this.rayCell(cz * this.gridN + cx, ox, oy, oz, dx, dy, dz, out, bullets, rx0, rx1, rz0, rz1);
        if (firstHit && out.hit) break cells;
      }
      this.tieX0 = this.tieZ0 = -1;
    } else {
      // long ray: DDA
      let cx = this.cell(ox), cz = this.cell(oz);
      const tcx = this.cell(ex), tcz = this.cell(ez);
      const sx = dx > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
      const tdx = dx !== 0 ? Math.abs(GRID_CELL / dx) : 1e9, tdz = dz !== 0 ? Math.abs(GRID_CELL / dz) : 1e9;
      const bx = this.gridMin + cx * GRID_CELL, bz = this.gridMin + cz * GRID_CELL;
      let tmx = dx !== 0 ? ((dx > 0 ? bx + GRID_CELL - ox : ox - bx) / Math.abs(dx)) : 1e9;
      let tmz = dz !== 0 ? ((dz > 0 ? bz + GRID_CELL - oz : oz - bz) / Math.abs(dz)) : 1e9;
      for (let guard = 0; guard < 400; guard++) {
        // visit this cell and its neighbours across (boxes may straddle)
        this.rayCell(cz * this.gridN + cx, ox, oy, oz, dx, dy, dz, out, bullets, rx0, rx1, rz0, rz1);
        if ((firstHit && out.hit) || (cx === tcx && cz === tcz)) break;
        if (tmx < tmz) { if (tmx > out.t) break; cx += sx; tmx += tdx; } else { if (tmz > out.t) break; cz += sz; tmz += tdz; }
        if (cx < 0 || cz < 0 || cx >= this.gridN || cz >= this.gridN) break;
      }
    }
    if (!(firstHit && out.hit) && this.cover !== null && this.cover.n > 0) this.cover.ray(ox, oy, oz, dx, dy, dz, out);
    return out;
  }
  private lastCellVisited = -1;
  /** test the boxes of grid cell c; rx0..rz1 bound the ray segment in x/z (a box outside it can't be hit) */
  private rayCell(c: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, out: Hit, bullets: boolean, rx0: number, rx1: number, rz0: number, rz1: number) {
    for (let k = this.cellStart[c]; k < this.cellStart[c + 1]; k++) {
      const i = this.cellItems[k];
      if (bullets ? this.noShoot[i] : this.noWalk[i] || (this.drive && this.noDrive[i])) continue;
      if (this.bx1[i] < rx0 || this.bx0[i] > rx1 || this.bz1[i] < rz0 || this.bz0[i] > rz1) continue;
      this.rayBox(i, ox, oy, oz, dx, dy, dz, out);
    }
  }
  private rayBox(i: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, out: Hit) {
    // Exact Y-slab rejection before the x/z transforms. Keep the original slab order below
    // for survivors so equal-distance axes retain their original normal and hit semantics.
    const yo = oy - this.cy[i], yh = this.hy[i];
    if (Math.abs(dy) < 1e-9) { if (yo < -yh || yo > yh) return; }
    else {
      const yi = 1 / dy; let yl = (-yh - yo) * yi, yu = (yh - yo) * yi;
      if (yl > yu) { const tmp = yl; yl = yu; yu = tmp; }
      if (Math.max(0, yl) > Math.min(out.t, yu)) return;
    }
    const c = this.cos[i], s = this.sin[i];
    const rx = ox - this.cx[i], rz = oz - this.cz[i];
    const lox = rx * c + rz * s, loz = -rx * s + rz * c, loy = oy - this.cy[i];
    const ldx = dx * c + dz * s, ldz = -dx * s + dz * c, ldy = dy;
    let tmin = 0, tmax = out.t, axis = -1, sign = 0;
    // slab x
    let lo: number, hi: number;
    for (let a = 0; a < 3; a++) {
      const o = a === 0 ? lox : a === 1 ? loy : loz, d = a === 0 ? ldx : a === 1 ? ldy : ldz, h = a === 0 ? this.hx[i] : a === 1 ? this.hy[i] : this.hz[i];
      if (Math.abs(d) < 1e-9) { if (o < -h || o > h) return; continue; }
      const inv = 1 / d; lo = (-h - o) * inv; hi = (h - o) * inv;
      let sg = -1; if (lo > hi) { const tmp = lo; lo = hi; hi = tmp; sg = 1; }
      if (lo > tmin) { tmin = lo; axis = a; sign = sg; }
      if (hi < tmax) tmax = hi;
      if (tmin > tmax) return;
    }
    if (axis < 0 || tmin > out.t || tmin <= 0) return;
    // an exact tie keeps the box found first, in the full row-major walk of the ray's cell rectangle
    if (tmin === out.t && !(this.tieZ0 >= 0 && out.box >= 0 && this.walkedFirst(i, out.box))) return;
    out.hit = true; out.t = tmin; out.box = i; out.surf = this.surf[i];
    out.x = ox + dx * tmin; out.y = oy + dy * tmin; out.z = oz + dz * tmin;
    const nx = axis === 0 ? sign : 0, ny = axis === 1 ? sign : 0, nz = axis === 2 ? sign : 0;
    out.nx = nx * c - nz * s; out.ny = ny; out.nz = nx * s + nz * c;
  }

  /** does the row-major walk of the current ray's cell rectangle reach box a before box b? (cell, then box index) */
  private walkedFirst(a: number, b: number): boolean {
    const za = Math.max(this.tieZ0, this.gz0[a]), zb = Math.max(this.tieZ0, this.gz0[b]);
    if (za !== zb) return za < zb;
    const xa = Math.max(this.tieX0, this.gx0[a]), xb = Math.max(this.tieX0, this.gx0[b]);
    return xa !== xb ? xa < xb : a < b;
  }

  /** quick line-of-sight test (no hit details) */
  clear(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    this.raycast(ax, ay, az, bx - ax, by - ay, bz - az, 1, LOS, true, true);
    return !LOS.hit;
  }
}
const TN = [0, 1, 0];
const LOS = makeHit(), UH = makeHit();
export { PLAYER_R };
