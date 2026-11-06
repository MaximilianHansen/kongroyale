// POI canopy-line — CANOPY LINE: a treetop zipline + rope-bridge network among gigantic jungle trees on the edge of the
// central plateau, looking NE down the escarpment valley to the lagoon. ONE deterministic layout (pure TS, no three.js)
// that both the client visuals (client/src/world/pois/canopy-line/*) and the server colliders derive from:
//   columns  — giant tree trunks (and the launch tower's mast) that decks + spiral stairs wrap around
//   helices  — spiral stairs: timber treads around a column, solid blocks where they meet a floor (no under-stair pockets)
//   rings    — round (tree) / octagonal (tower) platforms; floor holes over the arriving stairs; rope rails with gaps
//   bridges  — sagging rope bridges between ring edges (plank colliders follow the sag in < 0.35 m steps)
//   huts     — thatched treehouses / cabins with real interiors (walls with thickness, door, windows, ceiling, stairs)
//   zips     — ziplines (shared/sim/zipline.ts rides these exact parabolas)
//   props    — cover on decks and on the ground (crates, barrels, logs, rocks) with box colliders
// Ground heights come from the baked patch shared/pois/canopy-line-ground.ts (== Terrain.height).
// Angles: a point at angle `a`, radius `r` around a column is (x + cos a · r, z + sin a · r) (0 = east, +π/2 = south).
// Sim box yaw ψ maps local x → world (cos ψ, sin ψ); a radial box therefore has yaw = its angle. three.js yaw = −ψ.
import type { Box, Surface } from "../world/colliders";
import { poiById } from "../world/map";
import { groundAt } from "./canopy-line-ground";
import { interiorColliders, interiorLoot, type InteriorRoom, type RoomOpening, type InteriorStyle, type RoomRole } from "./interior-kit";
import * as dmath from "../sim/dmath";
export { groundAt };

const P = poiById("canopy-line");
export const CX = P.x, CZ = P.z, RADIUS = P.r;
export type V2 = [number, number];
export type V3 = [number, number, number];
const TAU = Math.PI * 2, D2R = Math.PI / 180;

// ------------------------------------------------------------------------------------------------ tuning constants
/** spiral stair: tread depth at the mid line (m), riser (m, ≤ STEP_H 0.55 of the sim), width (m) */
export const STAIR = { tread: 0.62, rise: 0.3, width: 1.4, thick: 0.14 };
/** clear headroom a kong needs under a floor (capsule 1.9 m + margin) */
const HEAD = 2.45;
/** zipline: feet hang this far below the cable; the pole top stands this high over its deck */
export const ZIP_HANG = 2.35, ZIP_POLE = 3.3;
/** rail height over a walking surface */
export const RAIL_H = 1.05;
const DECK_T = 0.3;

// ------------------------------------------------------------------------------------------------ types
export interface Column {
  id: string; kind: "tree" | "mast";
  x: number; z: number; gy: number;
  /** trunk radius (between the root flare and the crown fork) */
  r: number;
  /** trunk top (crown fork, world y) */
  top: number;
  /** crown: centre height, radii (trees only) */
  crown: { y: number; rx: number; ry: number } | null;
  /** root flanges (trees): angle, reach from the trunk surface, height at the trunk */
  flanges: Array<{ a: number; len: number; h: number; th: number }>;
  /** crown limbs: centre-line points (from inside the trunk top out into the crown) + radius at the base / tip —
   *  the client lofts the bark tube along them, genColliders steps boxes along the same line (colliders ≡ visuals) */
  limbs: Array<{ pts: V3[]; r0: number; r1: number }>;
  seed: number;
}
export interface Step {
  /** angle of the tread centre, its angular width, top y, radial span */
  a: number; dA: number; y: number; r0: number; r1: number;
  /** bottom of a solid block (NaN = a floating timber tread `STAIR.thick` deep) */
  solid: number;
  /** outer rope rail on this step (false near the deck exits) */
  rail: boolean;
}
export interface Helix { id: string; col: number; dir: 1 | -1; r0: number; r1: number; steps: Step[] }
export interface Ring {
  id: string; col: number; y: number;
  /** walled cabin deck (tower T1): no outer rope rail — the cabin walls (towerCabin) close it */
  cabin?: boolean;
  /** inner (at the trunk / mast) and outer radius; `rh` = the inner band's outer edge (helix band + margin) */
  r0: number; r1: number; rh: number;
  /** outer polygon sides (tower = 8, trees ≥ 24) */
  n: number;
  /** angle ranges with no outer rail (bridges, zip gates, stair exits) */
  gaps: V2[];
  /** inner-band angle ranges with no floor (the stair arriving from below) */
  holes: V2[];
  /** the angle where the arriving stair steps out onto this floor (NaN = none) */
  exitA: number;
  kind: "tree" | "tower";
}
export interface Bridge { id: string; a: V3; b: V3; w: number; sag: number }
export type Side = 0 | 1 | 2 | 3; // 0 front (+z local), 1 right (+x), 2 back (−z), 3 left (−x)
export interface Opening { side: Side; u: number; w: number; y: number; h: number; kind: "door" | "window" }
export interface Hut {
  id: string; name: string;
  x: number; z: number; y: number; yaw: number;
  w: number; d: number; floors: 1 | 2;
  /** storey height (floor to ceiling) */
  floorH: number;
  openings: Opening[];
  /** roof: hip (thatch) over the top storey; pitch = rise per metre */
  pitch: number; over: number;
  /** tint of the plank walls */
  wall: string;
  /** interior dressing preset */
  interior: "bunk" | "store" | "lodge" | "radio" | "kitchen" | "depot" | "map";
  /** 2-storey: the interior stair (local x run along the back wall) */
  stair: { x0: number; z: number; w: number; steps: number; run: number } | null;
}
export interface Zip { id: string; a: V3; b: V3; sag: number; /** deck y at each end (the pole stands on it) */ ya: number; yb: number }
export interface Prop {
  kind: "crate" | "crate-banana" | "crate-stack" | "barrel" | "drum" | "log" | "rock" | "sacks" | "winch" | "table" | "bench" | "firepit" | "tent" | "shelf" | "bunk" | "chair" | "lantern-post" | "rope-coil" | "pallet" | "fence";
  x: number; y: number; z: number; yaw: number; s: number;
  /** collider half extents at scale 1 (x, y, z) — the visual fits this box */
  hx: number; hy: number; hz: number;
  surf: Surface;
}
/** open thatched shelter on posts (a roof over the winch) — no walls, collider = posts + roof */
export interface Shelter { id: string; x: number; z: number; y: number; yaw: number; w: number; d: number; h: number; pitch: number }

// ------------------------------------------------------------------------------------------------ helpers
export const rad = (col: Column, a: number, r: number): V2 => [col.x + dmath.cos(a) * r, col.z + dmath.sin(a) * r];
/** local (lx, lz) of a frame with sim yaw ψ → world offset */
export const toW = (yaw: number, lx: number, lz: number): V2 => [lx * dmath.cos(yaw) - lz * dmath.sin(yaw), lx * dmath.sin(yaw) + lz * dmath.cos(yaw)];
const wrap = (a: number) => { a %= TAU; return a < 0 ? a + TAU : a; };
/** is angle a inside [a0, a1] (a0 → a1 counter-clockwise in angle terms, lengths < 2π) */
export function inArc(a: number, arc: V2): boolean { const L = wrap(arc[1] - arc[0]); return wrap(a - arc[0]) <= L; }
export function mulberry(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** zip / bridge parabola: lerp(a, b, t) with `sag` metres of dip at mid-span */
export const sagY = (ya: number, yb: number, sag: number, t: number) => ya + (yb - ya) * t - 4 * sag * t * (1 - t);

// ------------------------------------------------------------------------------------------------ the view frame
// The view camera stands on the Launch Tree's camera deck looking NE across the valley toward the lagoon: the launch
// tower rises ahead-left, the rope bridge runs right to the Lodge Tree, ziplines fan out from the tower toward the sea.
// The camera stands at the camera deck's SE rim where the rim's tangent runs NE: the deck + crates fill the
// bottom-left, the view to the right drops straight into the valley, pitch −9°
const CAM_BEARING = -50 * D2R;
const HD: V2 = [dmath.cos(CAM_BEARING), dmath.sin(CAM_BEARING)];
const RT: V2 = [-HD[1], HD[0]];
const CAM0: V2 = [149.8 + dmath.cos(44 * D2R) * 8.9, -229.0 + dmath.sin(44 * D2R) * 8.9];
/** view frame → world (f metres ahead, r metres to screen right) */
export const W = (f: number, r: number): V2 => [CAM0[0] + HD[0] * f + RT[0] * r, CAM0[1] + HD[1] * f + RT[1] * r];
/** launch tower: its top deck ~5 m over the camera, the whole tower + pennant inside the view's frame */
const TOWER_TOP = 76, TOWER_XZ: V2 = [161.9, -249.8];
/** the crow's nest over the thatched cap: the mast stair climbs on through the cone to a small ring deck — the
 *  landmark's top is a real sniper perch, and the cap's thatch is reachable on foot from it (no glider-only roof) */
const NEST_Y = TOWER_TOP + 5.4, NEST_R = 3.05;
/** the flag mast over the crow's nest: its top stands
 *  over every crown of the POI (the Launch Tree's crown tops out at ≈ 111 m) — the first silhouette the plane reads */
const FLAG_TOP = 114;
/** the planked mid cabin: T1's octagon is walled from its floor up to T2's underside (door onto the AT bridge,
 *  windows on the other faces) — the tower reads as a mass, not a lattice, and T1 is a real room (loot, cover) */
const CABIN = { door: { w: 1.6, h: 2.4 }, win: { w: 1.5, y: 1.0, h: 1.2 } };
/** the launch tower stands on the 45° escarpment: a STONE PLINTH levels its base room. The door opens on the
 *  uphill face (floor = the ground outside that face), the plinth runs down to the lowest ground under the octagon */
const TOWER_APO = 4.3;
export const TOWER_BASE = (() => {
  let doorA = Math.PI, door = -Infinity, lo = Infinity;
  for (let k = 0; k < 8; k++) { const a = k / 8 * TAU, g = groundAt(TOWER_XZ[0] + dmath.cos(a) * (TOWER_APO + 0.7), TOWER_XZ[1] + dmath.sin(a) * (TOWER_APO + 0.7)); if (g > door) { door = g; doorA = a; } }
  for (let k = 0; k < 32; k++) { const a = k / 32 * TAU; for (const r of [0, 2, TOWER_APO, TOWER_APO / dmath.cos(Math.PI / 8)]) lo = Math.min(lo, groundAt(TOWER_XZ[0] + dmath.cos(a) * r, TOWER_XZ[1] + dmath.sin(a) * r)); }
  return { doorA, floorY: door + 0.12, lo: lo - 0.6 };
})();
/** the plateau camp: flat plateau shelf west of the tower (ground 54.8 m, span ≤ 0.2 m over 10 m) */
export const CAMP: V2 = [104, -248];

// ------------------------------------------------------------------------------------------------ generation
export interface CanopyLayout {
  columns: Column[]; helices: Helix[]; rings: Ring[]; bridges: Bridge[]; huts: Hut[]; zips: Zip[]; props: Prop[]; shelters: Shelter[];
  /** solid timber blocks (porch steps of the ground cabin): centre x/z, yaw, half extents, bottom/top y */
  blocks: Array<{ x: number; z: number; yaw: number; hx: number; hz: number; y0: number; y1: number }>;
  /** named deck ids → ring index */
  deck: Record<string, number>;
}

interface TreeSpec { id: string; x: number; z: number; r: number; decks: Array<{ id: string; y: number; r1: number }>; a0: number; dir: 1 | -1; crownUp: number; crownR: number; seed: number }

function genLayout(): CanopyLayout {
  const columns: Column[] = [], helices: Helix[] = [], rings: Ring[] = [], bridges: Bridge[] = [], huts: Hut[] = [], zips: Zip[] = [], props: Prop[] = [], shelters: Shelter[] = [];
  const blocks: CanopyLayout["blocks"] = [];
  const deck: Record<string, number> = {};

  // ---------------------------------------------------------------- columns + their stairs + rings
  const TREES: TreeSpec[] = [
    // Launch Tree: the camera deck (L1) + a small lookout (L2); on the plateau lip
    { id: "A", x: 149.8, z: -229.0, r: 2.6, decks: [{ id: "A1", y: 70, r1: 9.5 }, { id: "A2", y: 78.4, r1: 6.2 }], a0: NaN, dir: -1, crownUp: 11, crownR: 21, seed: 11 },
    // Lodge Tree: down the escarpment, its lodge deck level with the camera deck
    { id: "B", x: 184.7, z: -228.1, r: 2.9, decks: [{ id: "B0", y: 52.0, r1: 13.1 }, { id: "B1", y: 66.0, r1: 13.4 }, { id: "B2", y: 78.0, r1: 6.4 }], a0: NaN, dir: 1, crownUp: 10, crownR: 22, seed: 23 },
    // South Tree: plateau, south of the Launch Tree
    { id: "E", x: 172.0, z: -203.0, r: 2.4, decks: [{ id: "E1", y: 67.0, r1: 12.0 }], a0: NaN, dir: 1, crownUp: 10.5, crownR: 19, seed: 37 },
    // valley giants toward the sea
    { id: "C", x: 220.0, z: -280.0, r: 2.6, decks: [{ id: "C0", y: 30.0, r1: 9.6 }, { id: "C1", y: 46.0, r1: 12.2 }], a0: NaN, dir: 1, crownUp: 10.5, crownR: 20, seed: 41 },
    { id: "D", x: 230.0, z: -242.0, r: 2.5, decks: [{ id: "D1", y: 44.0, r1: 12.3 }], a0: NaN, dir: -1, crownUp: 10.5, crownR: 19, seed: 53 },
    // Hollow-valley tree H: a low bridge deck (from C0) and a hut deck above — the treehouses stepping down the valley
    { id: "H", x: 190.0, z: -290.0, r: 2.3, decks: [{ id: "H0", y: 30.0, r1: 11.9 }, { id: "H1", y: 38.4, r1: 11.6 }], a0: NaN, dir: -1, crownUp: 9.5, crownR: 17, seed: 79 },
    { id: "F", x: 250.0, z: -270.0, r: 2.3, decks: [{ id: "F1", y: 30.6, r1: 12.0 }], a0: NaN, dir: 1, crownUp: 10, crownR: 18, seed: 67 },
    // (small treehouse platforms step down the valley) two younger trees between the giants,
    // each a single deck with a sleeping pod, bridged into the low valley network (G1 → C0, K1 → H0)
    { id: "G", x: 203.0, z: -258.0, r: 1.9, decks: [{ id: "G1", y: 28.0, r1: 11.6 }], a0: NaN, dir: -1, crownUp: 8.5, crownR: 14, seed: 89 },
    { id: "K", x: 210.0, z: -305.0, r: 1.8, decks: [{ id: "K1", y: 29.2, r1: 11.1 }], a0: NaN, dir: 1, crownUp: 8.0, crownR: 13, seed: 97 },
  ];
  const TOWER = { id: "T", x: TOWER_XZ[0], z: TOWER_XZ[1], decks: [{ id: "T1", y: 70, r1: 4.3 }, { id: "T2", y: TOWER_TOP, r1: 4.3 }, { id: "T3", y: NEST_Y, r1: NEST_R }], a0: 200 * D2R, dir: 1 as 1 | -1 };

  const mkHelix = (ci: number, col: Column, a0: number, dir: 1 | -1, r0: number, w: number, tread: number, levels: number[]): { h: Helix; exits: Array<{ y: number; a: number; k: number }> } => {
    const steps: Step[] = [], exits: Array<{ y: number; a: number; k: number }> = [];
    const rm = r0 + w / 2, dA = tread / rm;
    let a = a0;
    for (let s = 0; s + 1 < levels.length; s++) {
      const y0 = levels[s], y1 = levels[s + 1], n = Math.max(1, Math.round((y1 - y0) / STAIR.rise)), rise = (y1 - y0) / n;
      for (let k = 1; k <= n; k++) {
        a += dir * dA;
        steps.push({ a, dA, y: y0 + k * rise, r0, r1: r0 + w, solid: NaN, rail: true });
      }
      exits.push({ y: y1, a, k: steps.length - 1 });
    }
    // the first step starts one tread past a0; solid blocks under every tread within HEAD of the floor it rises from
    // (the ground for the first run, each deck for the next): nobody can walk under a low tread
    let base = levels[0], seg = 0, cnt = 0;
    const segN = levels.slice(1).map((y, i) => Math.max(1, Math.round((y - levels[i]) / STAIR.rise)));
    for (let i = 0; i < steps.length; i++) {
      const st = steps[i];
      if (st.y - base < HEAD + 0.3) {
        let lo = base;
        if (seg === 0) { // on the ground: the block reaches the lowest terrain under the tread
          for (const f of [0.1, 0.5, 0.9]) for (const g of [-0.45, 0, 0.45]) { const [x, z] = rad(col, st.a + g * st.dA, st.r0 + (st.r1 - st.r0) * f); lo = Math.min(lo, groundAt(x, z)); }
          lo -= 0.25;
        }
        st.solid = lo;
      }
      if (++cnt >= segN[seg]) { cnt = 0; base = levels[seg + 1]; seg++; }
    }
    // rail gaps where the stair meets a floor (step out sideways onto the deck)
    for (const e of exits) for (let k = e.k - 2; k <= e.k + 2; k++) if (steps[k]) steps[k].rail = false;
    steps[0].rail = false; if (steps[1]) steps[1].rail = false;
    return { h: { id: `${col.id}:stair`, col: ci, dir, r0, r1: r0 + w, steps }, exits };
  };

  const addRings = (ci: number, col: Column, hx: { h: Helix; exits: Array<{ y: number; a: number; k: number }> }, decks: Array<{ id: string; y: number; r1: number }>, kind: "tree" | "tower") => {
    const h = hx.h;
    decks.forEach((d, di) => {
      const ex = hx.exits[di];
      // floor hole over every tread that is less than HEAD under this deck (arriving from below)
      const under = h.steps.filter((s) => s.y < d.y - 1e-6 && s.y > d.y - HEAD - 0.05);
      let holes: V2[] = [];
      if (under.length) {
        const as = under.map((s) => s.a);
        // margin: half a tread + a kong's width (a capsule standing on a tread's edge overhangs it by its radius)
        const m = under[0].dA * 0.5 + 0.95 / ((h.r0 + h.r1) / 2);
        holes = [[wrap(Math.min(...as) - m), wrap(Math.max(...as) + m)]];
      }
      // treads rising from this deck over its own hole (tight mast stairs) float: the stair arriving from below passes
      // under them, and there is no floor there to walk under them from
      for (const s of h.steps) if (s.y > d.y + 1e-6 && s.y < d.y + HEAD + 0.35 && Number.isFinite(s.solid) && holes.some((hl) => inArc(s.a, hl))) s.solid = NaN;
      const n = kind === "tower" ? 8 : Math.max(24, Math.round(TAU * d.r1 / 2.0));
      rings.push({ id: d.id, col: ci, y: d.y, r0: col.r + 0.02, r1: d.r1, rh: h.r1 + 0.04, n, gaps: [], holes, exitA: ex ? ex.a : NaN, kind });
      deck[d.id] = rings.length - 1;
    });
  };

  TREES.forEach((t, i) => {
    const gy = groundAt(t.x, t.z);
    const top = t.decks[t.decks.length - 1].y + t.crownUp;
    const rng = mulberry(t.seed * 977);
    const col: Column = { id: t.id, kind: "tree", x: t.x, z: t.z, gy, r: t.r, top, crown: { y: top + t.crownR * 0.42, rx: t.crownR, ry: t.crownR * 0.52 }, flanges: [], limbs: [], seed: t.seed };
    columns.push(col);
    const ci = columns.length - 1;
    // the stair starts on the UPHILL side of the trunk so it climbs clear of the slope at once (no buried treads)
    let a0 = t.a0;
    if (!Number.isFinite(a0)) { let best = -Infinity; for (let k = 0; k < 72; k++) { const a = k / 72 * TAU, h = groundAt(...rad(col, a, t.r + 0.76)); if (h > best) { best = h; a0 = a; } } }
    const foot = rad(col, a0 + t.dir * STAIR.tread / (t.r + 0.76), t.r + 0.76);
    // the stair winds on from the top deck up to the crown fork: the fork cap + the boughs are a climbable perch
    // (no glider-only surfaces in the crowns)
    const hx = mkHelix(ci, col, a0, t.dir, t.r + 0.06, STAIR.width, STAIR.tread, [groundAt(foot[0], foot[1]), ...t.decks.map((d) => d.y), top]);
    helices.push(hx.h);
    addRings(ci, col, hx, t.decks, "tree");
    {
      // crown limbs: 5 thick boughs forking out of the trunk top, bending outward into the crown's lower lobes —
      // spread round the arc the stair does NOT use for its last 3.2 m (the treads up to the fork keep their headroom,
      // the kong steps off onto the fork cap and walks out along the boughs)
      const lr = mulberry(t.seed * 613 + 3), nL = 5, cR = t.crownR;
      const lastA = hx.h.steps.filter((q) => q.y > top - 3.4).map((q) => q.a);
      const c0 = lastA[Math.floor(lastA.length / 2)] ?? 0, half = lastA.length ? Math.abs(lastA[lastA.length - 1] - lastA[0]) / 2 + 0.55 : 0;
      for (let k = 0; k < nL; k++) {
        const a = c0 + half + (TAU - 2 * half) * (k + 0.5) / nL + (lr() - 0.5) * 0.2, ca = dmath.cos(a), sa = dmath.sin(a), up = 0.85 + lr() * 0.15;
        const P = (d: number, y: number): V3 => [t.x + ca * d, top + y, t.z + sa * d];
        // every span ≤ ~45° (the collider slices are vertical: a steeper bough would need horizontal slabs, whose tops
        // leave un-collided pockets inside the drawn tube)
        col.limbs.push({ pts: [P(-t.r * 0.3, -0.9), P(t.r * 0.55, 0.2), P(cR * 0.22, cR * 0.12 * up), P(cR * 0.37, cR * 0.23 * up), P(cR * 0.53, cR * 0.34 * up)], r0: t.r * 0.5, r1: t.r * 0.1 });   // (a thick crotch flowing out of the trunk, a strong taper into the leaves)
      }
    }
    // root flanges: 5–6 buttress blades, never where the stair's first 6 m wind around the trunk
    const low = hx.h.steps.filter((s) => s.y < hx.h.steps[0].y + 6.5);
    const nF = 5 + Math.floor(rng() * 2), ph = rng() * TAU;
    for (let k = 0; k < nF * 3 && col.flanges.length < nF; k++) {
      const a = ph + (k / nF) * TAU * (k < nF ? 1 : 0.37) + (rng() - 0.5) * 0.5;
      const clash = low.some((s) => Math.abs(dmath.atan2(dmath.sin(s.a - a), dmath.cos(s.a - a))) < s.dA * 0.5 + 0.34);
      if (clash) continue;
      if (col.flanges.some((f) => Math.abs(dmath.atan2(dmath.sin(f.a - a), dmath.cos(f.a - a))) < 0.7)) continue;
      // never across a steep side-slope: the blade walls off a strip of 45° ground under the decks (a covered
      // jump-only pocket under the Lodge Tree)
      { const [mx, mz] = rad(col, a, t.r + 1.4), px = -dmath.sin(a), pz = dmath.cos(a); if (Math.abs(groundAt(mx + px * 1.2, mz + pz * 1.2) - groundAt(mx - px * 1.2, mz - pz * 1.2)) / 2.4 > 0.7) continue; }
      col.flanges.push({ a, len: 2.2 + rng() * 1.6, h: 2.2 + rng() * 1.2, th: 0.55 + rng() * 0.2 });
    }
  });
  {
    const gy = groundAt(TOWER.x, TOWER.z);
    const col: Column = { id: "T", kind: "mast", x: TOWER.x, z: TOWER.z, gy, r: 0.42, top: FLAG_TOP, crown: null, flanges: [], limbs: [], seed: 5 };   // (landmark: a tall flag mast)
    columns.push(col);
    const ci = columns.length - 1;
    // the mast stair rises from the base room's plank floor on the plinth, starting on the door side
    const a0 = TOWER_BASE.doorA - TOWER.dir * 0.6;
    const hx = mkHelix(ci, col, a0, TOWER.dir, 0.48, 1.34, 0.6, [TOWER_BASE.floorY, ...TOWER.decks.map((d) => d.y)]);
    helices.push(hx.h);
    addRings(ci, col, hx, TOWER.decks, "tower");
    rings[deck.T1].cabin = true;
  }
  const colOf = (id: string) => columns.find((c) => c.id === id)!;
  const R = (id: string) => rings[deck[id]];

  // ---------------------------------------------------------------- bridges (ring edge → ring edge)
  const bridgeW = 1.5;
  const addBridge = (id: string, da: string, db: string, sag: number) => {
    const A = R(da), B = R(db), ca = columns[A.col], cb = columns[B.col];
    const aa = dmath.atan2(cb.z - ca.z, cb.x - ca.x), ab0 = dmath.atan2(ca.z - cb.z, ca.x - cb.x);
    // on the tower the bridge lands square on an octagon face (the T1 cabin's door is centred on it)
    const ab = B.kind === "tower" ? Math.round(ab0 / (TAU / 8)) * (TAU / 8) : ab0;
    // ends 0.25 m inside each outer edge (the plank sits on the deck rim)
    const edgeR = (g: Ring) => g.kind === "tower" ? g.r1 / dmath.cos(Math.PI / g.n) * 0 + g.r1 : g.r1;
    const pa = rad(ca, aa, edgeR(A) - 0.25), pb = rad(cb, ab, edgeR(B) - 0.25);
    bridges.push({ id, a: [pa[0], A.y, pa[1]], b: [pb[0], B.y, pb[1]], w: bridgeW, sag });
    const ga = (bridgeW / 2 + 0.2) / A.r1, gb = (bridgeW / 2 + 0.2) / B.r1;
    A.gaps.push([wrap(aa - ga), wrap(aa + ga)]); B.gaps.push([wrap(ab - gb), wrap(ab + gb)]);
  };
  addBridge("AB", "A1", "B1", 0.45);
  addBridge("AT", "A1", "T1", 0.25);
  addBridge("AE", "A1", "E1", 0.7);
  addBridge("EB", "E1", "B1", 0.2);
  addBridge("CD", "C1", "D1", 1.6);
  addBridge("FC", "F1", "C0", 0.7);
  addBridge("HC", "H0", "C0", 0.9);
  addBridge("GC", "G1", "C0", 0.45);
  addBridge("KH", "K1", "H0", 0.15);

  // ---------------------------------------------------------------- ziplines
  const addZip = (id: string, da: string, db: string, sag: number, offA = 0, offB = 0) => {
    const A = R(da), B = R(db), ca = columns[A.col], cb = columns[B.col];
    const aa = dmath.atan2(cb.z - ca.z, cb.x - ca.x) + offA, ab = dmath.atan2(ca.z - cb.z, ca.x - cb.x) + offB;
    const pr = (g: Ring) => g.kind === "tower" ? g.r1 - 0.7 : g.r1 - 1.0;
    const pa = rad(ca, aa, pr(A)), pb = rad(cb, ab, pr(B));
    zips.push({ id, a: [pa[0], A.y + ZIP_POLE, pa[1]], b: [pb[0], B.y + ZIP_POLE, pb[1]], sag, ya: A.y, yb: B.y });
    const ga = 1.05 / A.r1, gb = 1.05 / B.r1;
    A.gaps.push([wrap(aa - ga), wrap(aa + ga)]); B.gaps.push([wrap(ab - gb), wrap(ab + gb)]);
  };
  // the fan from the launch tower's top deck toward the sea
  addZip("T-C", "T2", "C1", 2.2, -0.12, 0);
  addZip("T-F", "T2", "F1", 3.0, 0.1, 0);
  addZip("T-D", "T2", "D1", 2.2, 0.32, 0);
  // return lines up out of the valley (motor-driven uphill)
  addZip("D-B", "D1", "B0", 1.2, 0, 0.35);
  addZip("C-B", "C1", "B1", 1.8, 0.2, -0.25);

  // the crow's nest: four gaps in its rail where the thatch cap meets the deck edge (walk down onto the cap)
  for (let k = 0; k < 4; k++) { const a = (k + 0.5) / 4 * TAU + 0.2; R("T3").gaps.push([wrap(a - 0.26), wrap(a + 0.26)]); }
  // stair exits: no rail where the stair steps out onto a floor
  for (const g of rings) if (Number.isFinite(g.exitA)) { const w = 1.3 / g.r1 + 0.12; g.gaps.push([wrap(g.exitA - w), wrap(g.exitA + w)]); }

  // ---------------------------------------------------------------- huts (on ring decks, outside the stair band)
  // every ring keeps the angle ranges already taken (rail gaps: bridges, zip gates, stair exits; huts; props) — a hut or
  // a prop searches outward from its preferred angle for the nearest free slot, so a stair / bridge change never buries
  // a door or blocks a gate
  const taken = new Map<Ring, V2[]>();
  const occ = (g: Ring) => { let t = taken.get(g); if (!t) { t = []; taken.set(g, t); } return t; };
  const free = (g: Ring, arcs: V2[]) => arcs.every((arc) => ![...g.gaps, ...occ(g)].some((o) => inArc(arc[0], o) || inArc(arc[1], o) || inArc(o[0], arc) || inArc(o[1], arc)));
  const hutArcs = (g: Ring, col: Column, h: Hut): V2[] | null => {
    const pts: V2[] = [];
    for (const [u, v] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, 1]] as V2[]) { const [ox, oz] = toW(h.yaw, u * (h.w / 2 + h.over), v * (h.d / 2 + (v > 0 ? h.over : 0.15))); pts.push([h.x + ox, h.z + oz]); }
    const rs = pts.map(([x, z]) => dmath.hypot(x - col.x, z - col.z));
    const walls: V2[] = [];
    for (const [u, v] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as V2[]) { const [ox, oz] = toW(h.yaw, u * h.w / 2, v * h.d / 2); walls.push([h.x + ox, h.z + oz]); }
    if (Math.max(...walls.map(([x, z]) => dmath.hypot(x - col.x, z - col.z))) > g.r1 - 1.35) return null;
    void rs;
    const arcs: V2[] = [];
    const span = (ps: V2[]): V2 => { const as = ps.map(([x, z]) => dmath.atan2(z - col.z, x - col.x)); const c = dmath.atan2(h.z - col.z, h.x - col.x); const d = as.map((q) => dmath.atan2(dmath.sin(q - c), dmath.cos(q - c))); return [wrap(c + Math.min(...d)), wrap(c + Math.max(...d))]; };
    arcs.push(span(pts));
    // the landing outside every door (1.9 m) must be free deck too
    for (const o of h.openings) if (o.kind === "door") {
      const sf = sideFrame(h, o.side), lx = sf.cx + sf.dir[0] * o.u + sf.n[0] * 1.9, lz = sf.cz + sf.dir[1] * o.u + sf.n[1] * 1.9;
      const [ox, oz] = toW(h.yaw, lx, lz), q: V2 = [h.x + ox, h.z + oz], r = dmath.hypot(q[0] - col.x, q[1] - col.z);
      if (r < g.rh + 0.5 || r > g.r1 - 0.6) return null;
      arcs.push(span([q, [h.x + ox * 0.9, h.z + oz * 0.9]]));
    }
    return arcs;
  };
  /** a hut whose FRONT faces outward near ring angle `pref`; its back wall sits just outside the stair band */
  const hutOn = (ringId: string, pref: number, o0: Omit<Hut, "x" | "z" | "y" | "yaw">): Hut => {
    // chunky thatched huts, big shaggy roofs: +0.35 m eaves (the stepped roof colliders follow)
    const o = { ...o0, over: o0.over + (["lodge", "b-hut", "c-pod", "h-pod"].includes(o0.id) ? 0 : 0.35), pitch: o0.pitch };   // (the lodge keeps its slot facing the camera deck; the huts under an upper deck keep the eave the stair steps onto; steeper roofs broke the walk up the thatch)
    const g = R(ringId), col = columns[g.col];
    const rc = g.rh + 0.35 + o.d / 2;
    for (let k = 0; k < 120; k++) {
      const a = pref + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 3 * D2R;
      const [x, z] = rad(col, a, rc);
      const hut: Hut = { ...o, x, z, y: g.y, yaw: a - Math.PI / 2 };
      const arcs = hutArcs(g, col, hut);
      if (!arcs || !free(g, arcs)) continue;
      occ(g).push(...arcs);
      huts.push(hut);
      return hut;
    }
    throw new Error(`canopy-line: no room for hut ${o.id} on ${ringId}`);
  };
  const door = (side: Side, u = 0, w = 1.35): Opening => ({ side, u, w, y: 0, h: 2.35, kind: "door" });
  const win = (side: Side, u = 0, w = 1.1, y = 1.0, h = 0.95): Opening => ({ side, u, w, y, h, kind: "window" });
  // Lodge Tree: the big 2-storey thatched lodge (the treehouse on the right of the view)
  // the lodge faces the camera deck and the stair on up to the B2
  // lookout passes its back eave: step off the flight onto the thatch (roof access without the glider)
  hutOn("B1", 236 * D2R, { id: "lodge", name: "CANOPY LODGE", w: 9.0, d: 6.2, floors: 2, floorH: 3.0, pitch: 0.78, over: 0.8, wall: "#f0cf9f", interior: "lodge",
    openings: [door(1, -0.8), door(3, 0.9), win(0, -2.7, 1.3, 0.85, 1.35), win(0, 0.4, 2.2, 0.85, 1.35), win(0, 2.95, 1.2, 0.85, 1.35), win(2, 2.6), win(3, -1.4, 1.2, 0.85, 1.35), win(1, 1.7, 1.1, 0.85, 1.35)],   // (big windows — daylight + sun pools in the lodge)
    stair: { x0: -1.0, z: -2.2, w: 1.3, steps: 10, run: 0.42 } });
  // (under the lodge deck its roof is covered — it sits where the stair climbs past its back eave, so the thatch is
  // walked onto from the flight, never jump-only)
  const eaveA = (col: string, ringId: string, floorH: number) => { const hx = helices.find((q) => q.id === `${col}:stair`)!, y = R(ringId).y + floorH + 0.2 + 0.7; return wrap(hx.steps.reduce((b, q) => Math.abs(q.y - y) < Math.abs(b.y - y) ? q : b).a); };
  hutOn("B0", eaveA("B", "B0", 2.8), { id: "b-hut", name: "PEEL HUT", w: 7.0, d: 5.9, floors: 1, floorH: 2.8, pitch: 0.82, over: 0.7, wall: "#e6c08c", interior: "kitchen",
    openings: [door(3, 0.4), win(0, 0), win(1, 0.2)], stair: null });
  hutOn("E1", 160 * D2R, { id: "e-hut", name: "RANGER HUT", w: 6.8, d: 5.6, floors: 1, floorH: 2.9, pitch: 0.8, over: 0.75, wall: "#efcb98", interior: "radio",
    openings: [door(1, 0.3), win(0, -1.5), win(0, 1.5), win(3, 0)], stair: null });
  hutOn("C1", 160 * D2R, { id: "c-hut", name: "SEA HUT", w: 6.8, d: 5.6, floors: 1, floorH: 2.9, pitch: 0.8, over: 0.75, wall: "#e8c592", interior: "bunk",
    openings: [door(3, 0.3), win(0, -1.4), win(0, 1.4), win(1, 0)], stair: null });
  hutOn("D1", 350 * D2R, { id: "d-hut", name: "HOLLOW HUT", w: 7.0, d: 5.8, floors: 1, floorH: 2.9, pitch: 0.82, over: 0.75, wall: "#f2d2a2", interior: "kitchen",
    openings: [door(1, 0.3), win(0, 0, 1.4), win(3, 0)], stair: null });
  hutOn("H1", 250 * D2R, { id: "h-hut", name: "VALLEY HUT", w: 6.6, d: 5.4, floors: 1, floorH: 2.8, pitch: 0.82, over: 0.7, wall: "#efcc9a", interior: "kitchen",
    openings: [door(1, 0.3), win(0, 0, 1.4), win(3, 0)], stair: null });
  hutOn("F1", 180 * D2R, { id: "f-hut", name: "LAGOON HUT", w: 6.4, d: 5.6, floors: 1, floorH: 2.8, pitch: 0.82, over: 0.7, wall: "#ebc896", interior: "kitchen",
    openings: [door(3, 0.3), win(0, 0, 1.4), win(1, 0)], stair: null });
  // two sleeping pods on the low bridge decks
  // no pod on C0: the GC bridge takes its slot, and its roof (covered by C1) would only be reachable by jumping
  hutOn("H0", 158 * D2R, { id: "h-pod", name: "FERN POD", w: 6.3, d: 5.8, floors: 1, floorH: 2.7, pitch: 1.0, over: 0.6, wall: "#e9c592", interior: "store",
    openings: [door(1, 0.2, 1.3), win(0, 0, 1.0), win(3, 0)], stair: null });
  hutOn("G1", 143 * D2R, { id: "g-pod", name: "GIBBON POD", w: 6.0, d: 5.8, floors: 1, floorH: 2.7, pitch: 1.0, over: 0.6, wall: "#eed09c", interior: "kitchen",
    openings: [door(3, 0.2, 1.3), win(0, 0, 1.0), win(1, 0)], stair: null });
  hutOn("K1", 123 * D2R, { id: "k-pod", name: "KAPOK POD", w: 6.0, d: 5.4, floors: 1, floorH: 2.7, pitch: 1.0, over: 0.6, wall: "#e8c690", interior: "bunk",
    openings: [door(1, 0.2, 1.3), win(0, 0, 1.0), win(3, 0)], stair: null });
  // stair → hut roofs: no rope rail where a tread runs level with (up to 1.6 m over) a deck hut's back eave (the lodge,
  // the pods under the upper decks): step off the flight onto the thatch
  for (const h of huts) {
    const g = rings.find((q) => Math.abs(q.y - h.y) < 0.05 && dmath.hypot(h.x - columns[q.col].x, h.z - columns[q.col].z) < q.r1);
    if (!g) continue;
    const hx = helices.find((q) => q.col === g.col)!, col = columns[hx.col];
    const eaveTop = h.y + h.floors * h.floorH + 0.2 + 0.3, [x0, x1] = hutRoofRect(h);
    for (const st of hx.steps) {
      if (st.y < eaveTop - 0.3 || st.y > eaveTop + 1.6) continue;
      const [px, pz] = rad(col, st.a, st.r1 + 0.45), dx = px - h.x, dz = pz - h.z;
      const lx = dx * dmath.cos(h.yaw) + dz * dmath.sin(h.yaw), lz = -dx * dmath.sin(h.yaw) + dz * dmath.cos(h.yaw);
      // (a wide opening onto the thatch)
      if (lx > x0 + 0.2 && lx < x1 - 0.2 && lz > -h.d / 2 - 1.0 && lz < -h.d / 2 + 1.0) st.rail = false;
    }
  }
  // valley floor: the zip depot cabin (ground level, between the valley giants)
  {
    const x = 226, z = -257, gy = Math.max(groundAt(x - 3.4, z - 2.6), groundAt(x + 3.4, z - 2.6), groundAt(x - 3.4, z + 2.6), groundAt(x + 3.4, z + 2.6)) + 0.35;
    const h: Hut = { id: "depot", name: "ZIP DEPOT", x, z, y: gy, yaw: 30 * D2R, w: 7.2, d: 5.2, floors: 1, floorH: 3.0, pitch: 0.74, over: 0.8, wall: "#e2bc88", interior: "depot",
      openings: [door(0, -1.6, 1.5), door(2, 1.8), win(0, 1.6, 1.4), win(1, 0), win(3, 0)], stair: null };
    huts.push(h);
    // porch steps down from each door to the ground (0.28 m risers, 0.4 m treads, solid to the ground)
    for (const o of h.openings) if (o.kind === "door") {
      const sf = sideFrame(h, o.side);
      for (let i = 0; i < 12; i++) {
        const out = 0.2 + i * 0.4, lx = sf.cx + sf.dir[0] * o.u + sf.n[0] * out, lz = sf.cz + sf.dir[1] * o.u + sf.n[1] * out;
        const [ox, oz] = toW(h.yaw, lx, lz), top = gy - (i + 1) * 0.28 + 0.28;
        const gh = groundAt(x + ox, z + oz);
        if (top <= gh + 0.12) break;
        const alongX = o.side === 0 || o.side === 2;
        blocks.push({ x: x + ox, z: z + oz, yaw: h.yaw, hx: alongX ? o.w / 2 + 0.3 : 0.2, hz: alongX ? 0.2 : o.w / 2 + 0.3, y0: gh - 0.4, y1: top });
      }
    }
  }
  // the launch tower's base room: an octagonal plank skirt around the stair (see towerSkirt) — collider/visual in towerSkirt()

  // ---------------------------------------------------------------- shelter over the winch on the camera deck
  {
    const g = R("A1"), col = columns[g.col];
    // (over the winch the shelter roof would fill a third of the view's frame and hide the hero machine) — the
    // shelter covers the crate store behind the camera (the deck's west side); the winch stands in the open
    const a = 200 * D2R, [x, z] = rad(col, a, 6.6);
    shelters.push({ id: "winch-roof", x, z, y: g.y, yaw: a - Math.PI / 2, w: 3.8, d: 3.0, h: 2.7, pitch: 0.72 });
  }

  // ---------------------------------------------------------------- props (cover) — decks
  const prop = (kind: Prop["kind"], x: number, y: number, z: number, yaw: number, s = 1): Prop => {
    const H: Record<Prop["kind"], [number, number, number, Surface]> = {
      "crate": [0.5, 0.5, 0.5, "wood"], "crate-banana": [0.55, 0.52, 0.55, "wood"], "crate-stack": [0.9, 0.95, 0.48, "wood"], "barrel": [0.42, 0.55, 0.42, "wood"], "drum": [0.36, 0.5, 0.36, "metal"],
      "log": [2.6, 0.55, 0.55, "wood"], "rock": [1.3, 0.8, 1.1, "stone"], "sacks": [0.6, 0.27, 0.3, "fabric"], "winch": [1.3, 0.85, 0.8, "metal"], "table": [0.9, 0.4, 0.55, "wood"], "bench": [0.8, 0.23, 0.22, "wood"],
      "firepit": [0.8, 0.2, 0.8, "stone"], "tent": [1.75, 1.12, 1.45, "fabric"], "shelf": [0.7, 0.9, 0.22, "wood"], "bunk": [1.0, 0.8, 0.45, "wood"], "chair": [0.25, 0.25, 0.25, "wood"], "lantern-post": [0.12, 1.1, 0.12, "wood"],
      "rope-coil": [0.4, 0.14, 0.4, "fabric"], "pallet": [0.6, 0.08, 0.5, "wood"], "fence": [1.5, 0.5, 0.08, "wood"],
    };
    const [hx, hy, hz, surf] = H[kind];
    const p: Prop = { kind, x, y, z, yaw, s, hx: hx * s, hy: hy * s, hz: hz * s, surf };
    props.push(p);
    return p;
  };
  const onRing = (ringId: string, pref: number, r: number, kind: Prop["kind"], yawOff = 0, s = 1) => {
    const g = R(ringId), col = columns[g.col];
    const probe = prop(kind, 0, 0, 0, 0, s); props.pop();
    const ext = dmath.hypot(probe.hx, probe.hz);
    r = Math.min(g.r1 - ext - 0.35, Math.max(g.rh + ext + 0.15, r));
    const half = (ext + 0.3) / r;
    for (let k = 0; k < 120; k++) {
      const a = pref + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 3 * D2R;
      const arc: V2 = [wrap(a - half), wrap(a + half)];
      if (!free(g, [arc])) continue;
      occ(g).push(arc);
      const [x, z] = rad(col, a, r);
      return prop(kind, x, g.y, z, a + yawOff, s);
    }
    return null;
  };
  // camera deck (the view's foreground): BANANA CO. crates near the camera, a barrel, the big winch under its shelter
  {
    const col = colOf("A");
    const put = (f: number, r: number, kind: Prop["kind"], yaw: number, s = 1) => { const [x, z] = W(f, r); const g = R("A1"); void col; return prop(kind, x, g.y, z, yaw, s); };
    const fy = dmath.atan2(HD[1], HD[0]);
    put(2.5, -0.8, "crate-banana", fy + 0.3, 0.95);
    put(4.0, -2.5, "crate-banana", fy - 0.15, 0.95);
    put(1.4, -1.3, "barrel", 0, 1);
    { const g = R("A1"); for (const p of props.slice(-3)) { const a = dmath.atan2(p.z - col.z, p.x - col.x), r = dmath.hypot(p.x - col.x, p.z - col.z), h = (dmath.hypot(p.hx, p.hz) + 0.2) / r; occ(g).push([wrap(a - h), wrap(a + h)]); } }
    onRing("A1", -16 * D2R, 6.6, "winch", Math.PI / 2, 1);
  }
  // the foreground in the view (no empty deck in a third of the frame): rope coils,
  // a lantern post, tied sacks, a second barrel — placed in the VIEW frame (f ahead, r right), pulled onto the deck
  {
    const g = R("A1"), col = colOf("A"), vb = -42 * D2R, vp: V2 = [149.8 + dmath.cos(55 * D2R) * 8.9, -229.0 + dmath.sin(55 * D2R) * 8.9];
    const F = (f: number, r: number): V2 => { let x = vp[0] + dmath.cos(vb) * f - dmath.sin(vb) * r, z = vp[1] + dmath.sin(vb) * f + dmath.cos(vb) * r; const d = dmath.hypot(x - col.x, z - col.z), lim = g.r1 - 1.2; if (d > lim) { x = col.x + (x - col.x) * lim / d; z = col.z + (z - col.z) * lim / d; } return [x, z]; };
    for (const [f, r, kind, yaw, sc] of [[3.4, -3.0, "sacks", 1.1, 1], [4.0, -4.0, "rope-coil", 0.3, 1], [5.0, -5.0, "lantern-post", 0.8, 1], [1.8, -2.6, "rope-coil", 1.4, 0.8], [5.6, -3.3, "crate", 0.5, 0.8], [6.4, -4.6, "barrel", 0, 1]] as Array<[number, number, Prop["kind"], number, number]>) {
      const [x, z] = F(f, r), a = dmath.atan2(z - col.z, x - col.x), rr = dmath.hypot(x - col.x, z - col.z);
      const pr = prop(kind, x, g.y, z, yaw, sc), ext = dmath.hypot(pr.hx, pr.hz);
      const half = (ext + 0.25) / rr, arc: V2 = [wrap(a - half), wrap(a + half)];
      const clash = (rr + ext > g.r1 - 2.6 && !free(g, [arc])) || rr - ext < g.rh + 0.3 || rr + ext > g.r1 - 0.4 || props.some((q) => q !== pr && Math.abs(q.y - g.y) < 0.1 && dmath.hypot(q.x - x, q.z - z) < ext + dmath.hypot(q.hx, q.hz) + 0.35);
      if (clash) { props.pop(); continue; }
      occ(g).push(arc);
    }
  }
  onRing("A1", 25 * D2R, 7.4, "crate-stack", Math.PI / 2);
  onRing("A1", 150 * D2R, 7.6, "crate", 0.3);
  onRing("A1", 172 * D2R, 7.8, "barrel");
  onRing("A2", 60 * D2R, 4.6, "crate", 0.4);
  onRing("A2", 250 * D2R, 4.8, "sacks", Math.PI / 2);
  onRing("B2", 150 * D2R, 4.9, "crate", 0.3);
  onRing("B2", 300 * D2R, 5.0, "barrel");
  onRing("B1", 20 * D2R, 9.6, "crate-stack", Math.PI / 2);
  onRing("B1", 215 * D2R, 9.3, "crate-banana", 0.2);
  onRing("B1", 245 * D2R, 9.8, "barrel");
  onRing("B1", 300 * D2R, 9.4, "sacks", Math.PI / 2);
  onRing("B0", 120 * D2R, 6.2, "crate", 0.5);
  onRing("B0", 20 * D2R, 6.4, "barrel");
  onRing("E1", 60 * D2R, 8.4, "crate-stack", Math.PI / 2);
  onRing("E1", 300 * D2R, 8.6, "crate-banana", 0.3);
  onRing("C1", 40 * D2R, 8.6, "crate-stack", Math.PI / 2);
  onRing("C1", 280 * D2R, 8.8, "barrel");
  onRing("C0", 90 * D2R, 6.0, "crate", 0.2);
  onRing("D1", 200 * D2R, 8.4, "crate-stack", Math.PI / 2);
  onRing("D1", 110 * D2R, 8.6, "crate-banana", 0.4);
  onRing("F1", 200 * D2R, 8.2, "crate-stack", Math.PI / 2);
  onRing("H0", 120 * D2R, 6.0, "barrel");
  onRing("H0", 330 * D2R, 6.0, "crate", 0.3);
  onRing("H1", 0, 8.6, "barrel");
  onRing("A2", 200 * D2R, 4.8, "crate", 0.2);
  onRing("B1", 100 * D2R, 10.2, "crate-stack", Math.PI / 2);
  onRing("B1", 300 * D2R, 10.4, "crate", 0.5);
  onRing("C1", 200 * D2R, 8.8, "crate", 0.4);
  onRing("H1", 60 * D2R, 8.2, "crate-banana", 0.3);
  onRing("H1", 160 * D2R, 8.4, "crate-stack", Math.PI / 2);
  onRing("F1", 300 * D2R, 8.4, "barrel");
  // (cover rhythm on the open decks — F1 (the lagoon zip landing), B0 and H0 had spots with no hard cover
  // within 8 m: a full-height crate stack on each open side)
  onRing("F1", 60 * D2R, 8.0, "crate-stack", Math.PI / 2);
  onRing("B0", 260 * D2R, 8.0, "crate-stack", Math.PI / 2);
  onRing("H0", 230 * D2R, 6.4, "crate-stack", Math.PI / 2);
  onRing("T2", 100 * D2R, 3.3, "crate", 0.3);
  // cover on the tower's open base deck (the plinth), clear of the mast stair's band
  for (const [da, kind] of [[1.25, "crate"], [-1.2, "barrel"]] as Array<[number, Prop["kind"]]>) {
    const a = TOWER_BASE.doorA + da, x = TOWER_XZ[0] + dmath.cos(a) * 3.2, z = TOWER_XZ[1] + dmath.sin(a) * 3.2;
    prop(kind, x, TOWER_BASE.floorY, z, a + Math.PI / 2);
  }
  onRing("G1", 300 * D2R, 7.2, "crate-stack", Math.PI / 2);
  onRing("G1", 40 * D2R, 7.4, "barrel");
  onRing("G1", 250 * D2R, 7.4, "crate-banana", 0.3);
  onRing("K1", 250 * D2R, 7.0, "crate-stack", Math.PI / 2);
  onRing("K1", 170 * D2R, 7.2, "barrel");
  onRing("K1", 320 * D2R, 7.2, "crate", 0.4);
  onRing("T1", 150 * D2R, 3.3, "barrel");

  // ---------------------------------------------------------------- roof access (no glider-only roofs): every
  // single-storey treehouse gets a crate stack beside a door-less wall, just outside its eave — jump onto the stack,
  // mantle onto the thatch (the roofs are fightable high ground, reached without the glider)
  for (const h of huts) {
    if (h.floors !== 1 || h.id === "depot") continue;
    const g = rings.find((q) => Math.abs(q.y - h.y) < 0.05 && dmath.hypot(h.x - columns[q.col].x, h.z - columns[q.col].z) < q.r1);
    if (!g) continue;
    const col = columns[g.col];
    const doorSides = new Set(h.openings.filter((o) => o.kind === "door").map((o) => o.side));
    const cands: Array<[number, number, number]> = [];   // local x, local z, prop yaw offset
    // (a ≥ 0.9 m walk gap between the stack and the wall: no dead-end slot a kong could wedge into)
    const gap = Math.max(h.over + 0.3, 0.92);   // (parity: clear of the eave's rolled lip — a kong on the stack had the thatch in its face)
    for (const sd of [1, -1]) if (!doorSides.has(sd > 0 ? 1 : 3)) for (const lz of [0.6, -0.4, 1.4]) cands.push([sd * (h.w / 2 + gap + 0.55), lz, Math.PI / 2]);
    if (!doorSides.has(0)) for (const lx of [0, 1.2, -1.2]) cands.push([lx, h.d / 2 + gap + 0.55, 0]);
    for (const [lx, lz, yo] of cands) {
      const [ox, oz] = toW(h.yaw, lx, lz), x = h.x + ox, z = h.z + oz;
      const r = dmath.hypot(x - col.x, z - col.z), a = dmath.atan2(z - col.z, x - col.x);
      if (r + 1.1 > g.r1 - 0.35 || r - 1.1 < g.rh + 0.1) continue;
      const half = 1.2 / r, arc: V2 = [wrap(a - half), wrap(a + half)];
      if (g.gaps.some((o) => inArc(arc[0], o) || inArc(arc[1], o) || inArc(o[0], arc) || inArc(o[1], arc))) continue;
      if (props.some((p) => Math.abs(p.y - g.y) < 0.1 && dmath.hypot(p.x - x, p.z - z) < 1.1 + dmath.hypot(p.hx, p.hz) + 0.5)) continue;
      if (huts.some((o) => o !== h && Math.abs(o.y - g.y) < 0.1 && dmath.hypot(o.x - x, o.z - z) < dmath.hypot(o.w, o.d) / 2 + o.over + 1.6)) continue;
      prop("crate-stack", x, g.y, z, h.yaw + yo);
      occ(g).push(arc);
      break;
    }
  }

  // ---------------------------------------------------------------- the plateau camp (off the escarpment
  // slope, on the flat plateau shelf west of the tower, ground span ≤ 0.2 m over the whole camp): two A-frame tents,
  // a stone firepit with log benches, supply crates / barrels and lantern posts — the ground-level fight west of the tower
  {
    const [kx, kz] = CAMP;
    const flat = (x: number, z: number, hx: number, hz: number, yaw: number) => { let lo = Infinity; for (const [u, v] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, 0]] as V2[]) { const [ox, oz] = toW(yaw, u * hx, v * hz); lo = Math.min(lo, groundAt(x + ox, z + oz)); } return lo; };
    const put = (kind: Prop["kind"], lx: number, lz: number, yaw: number, s = 1, sink = 0) => { const x = kx + lx, z = kz + lz; const p = prop(kind, x, 0, z, yaw, s); p.y = flat(x, z, p.hx, p.hz, yaw) - sink; return p; };
    put("firepit", 0, 0, 0, 1, 0.04);
    // tents face the fire (their door end = local +x … the ridge runs along local x)
    put("tent", -4.6, -2.2, dmath.atan2(2.2, 4.6), 1, 0.02);
    put("tent", 1.4, -5.2, dmath.atan2(5.2, -1.4), 1, 0.02);
    put("log", 2.6, 1.6, 0.5, 0.55, 0.1);
    put("log", -1.9, 2.5, -0.4, 0.55, 0.1);
    put("crate-stack", 5.2, -2.6, 1.2);
    put("crate-banana", 4.4, 3.4, 0.3, 0.95);
    put("barrel", 6.0, 1.0, 0);
    put("crate", -5.4, 3.4, 0.5);
    put("sacks", -6.8, 0.6, 1.4);
    put("lantern-post", -2.8, -0.2, 0);
    put("lantern-post", 3.4, -1.2, 0);
    put("rope-coil", 3.7, 2.4, 0.4);
    put("rope-coil", -3.4, 3.0, 1.1, 0.8);
  }

  // ---------------------------------------------------------------- props — the forest floor (cover every ~8 m)
  {
    const rng = mulberry(4242);
    const blocked = (x: number, z: number, pad: number) => {
      if (dmath.hypot(x - CAMP[0], z - CAMP[1]) < 8.5 + pad) return true;
      for (const c of columns) { const rr = c.kind === "tree" ? c.r + 4.2 : 5.0; if (dmath.hypot(x - c.x, z - c.z) < rr + pad) return true; }
      for (const h of huts) if (dmath.hypot(x - h.x, z - h.z) < Math.max(h.w, h.d) / 2 + 1.6 + pad) return true;
      for (const p of props) if (dmath.hypot(x - p.x, z - p.z) < 3.2 + pad) return true;
      return false;
    };
    const kinds: Prop["kind"][] = ["log", "rock", "crate-stack", "rock", "log", "barrel", "crate", "rock"];
    // jittered grid over the POI disc: one hard-cover prop per ~9 m cell where the ground is walkable
    const cell = 9;
    for (let gz = -RADIUS; gz <= RADIUS; gz += cell) for (let gx = -RADIUS; gx <= RADIUS; gx += cell) {
      const x = CX + gx + (rng() - 0.5) * cell * 0.7, z = CZ + gz + (rng() - 0.5) * cell * 0.7;
      if (dmath.hypot(x - CX, z - CZ) > RADIUS - 2) continue;
      const gy = groundAt(x, z);
      if (gy < 0.8) continue; // lagoon
      const sl = Math.max(Math.abs(groundAt(x + 1.5, z) - groundAt(x - 1.5, z)), Math.abs(groundAt(x, z + 1.5) - groundAt(x, z - 1.5))) / 3;
      if (sl > 0.75) continue;
      if (blocked(x, z, 0)) continue;
      const k0 = kinds[Math.floor(rng() * kinds.length)];
      // under a deck a boulder's broad top is a covered floor only a jump reaches: a fallen log there instead
      const k: Prop["kind"] = k0 === "rock" && rings.some((g) => dmath.hypot(x - columns[g.col].x, z - columns[g.col].z) < g.r1 + 2.5) ? "log" : k0;
      const yaw = rng() * TAU;
      // sit on the lowest corner so nothing floats; rocks and logs sink a little into the slope
      const s = k === "rock" ? 0.8 + rng() * 0.6 : 1;
      const hx = k === "log" ? 2.6 : k === "rock" ? 1.3 * s : 0.6, hz = k === "log" ? 0.55 : k === "rock" ? 1.1 * s : 0.6;
      let lo = Infinity, hi = -Infinity;
      for (const [u, v] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, 0]] as V2[]) { const [ox, oz] = toW(yaw, u * hx, v * hz); const h = groundAt(x + ox, z + oz); lo = Math.min(lo, h); hi = Math.max(hi, h); }
      if (hi - lo > (k === "log" ? 1.2 : k === "rock" ? 1.4 : 0.5)) continue;
      // a boulder on a slope: its top never more than a step over the uphill ground (else a ledge only the
      // glider reaches) — it stays chest-high cover from downhill
      const y = k === "rock" ? Math.min(lo - 0.35 * s, Math.max(hi + 0.45, lo + 1.1) - 1.6 * s) : k === "log" ? lo - 0.12 : lo;
      prop(k, x, y, z, yaw, s);
    }
    // fill pass: wherever no hard cover of ours is within 7 m (slopes the grid skipped), a boulder sunk into the slope or
    // a fallen log across it (the island's own trunks / rocks count too in a cover check — this pass ignores
    // them, so the POI never depends on the random scatter for its cover)
    const hard = () => props.filter((p) => p.hy * 2 >= 0.9 && p.kind !== "tent");
    for (let gz = -RADIUS; gz <= RADIUS; gz += 4) for (let gx = -RADIUS; gx <= RADIUS; gx += 4) {
      const x = CX + gx, z = CZ + gz;
      if (dmath.hypot(gx, gz) > RADIUS - 1) continue;
      const gy = groundAt(x, z); if (gy < 0.8) continue;
      const near = (px: number, pz: number, r: number) => dmath.hypot(px - x, pz - z) - r < 7;
      // (cover only counts at about the same elevation — on the escarpment a rock 7 m away can be 5 m below)
      if (hard().some((p) => Math.abs(p.y + 0.3 - gy) < 1.6 && near(p.x, p.z, Math.max(p.hx, p.hz)))) continue;
      if (columns.some((c) => near(c.x, c.z, c.kind === "tree" ? c.r : 4.4))) continue;
      if (huts.some((h) => near(h.x, h.z, Math.min(h.w, h.d) / 2))) continue;
      if (blocked(x, z, -1.5)) continue;
      // never under a deck (a covered pocket between boulders there read as a jump-only floor to the reachability scan)
      if (rings.some((g) => dmath.hypot(x - columns[g.col].x, z - columns[g.col].z) < g.r1 + 2.5)) continue;
      const yaw = rng() * TAU, k: Prop["kind"] = rng() < 0.7 ? "rock" : "log";
      const sz = k === "rock" ? 0.9 + rng() * 0.5 : 1;
      const hx = k === "log" ? 2.6 : 1.3 * sz, hz = k === "log" ? 0.55 : 1.1 * sz;
      let lo = Infinity;
      let hi = -Infinity;
      for (const [u, v] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, 0]] as V2[]) { const [ox, oz] = toW(yaw, u * hx, v * hz); const g = groundAt(x + ox, z + oz); lo = Math.min(lo, g); hi = Math.max(hi, g); }

      prop(k, x, k === "rock" ? Math.min(lo - 0.3 * sz, Math.max(hi + 0.45, lo + 1.1) - 1.6 * sz) : lo - 0.15, z, yaw, sz);
    }
  }

  // hut furniture = the shared interiors kit (INTERIOR_ROOMS below): colliders, loot slots, drawing
  return { columns, helices, rings, bridges, huts, zips, props, shelters, blocks, deck };
}

export const LAYOUT: CanopyLayout = genLayout();


// ------------------------------------------------------------------------------------------------ derived geometry
/** trunk radius at height y (flare at the foot, bulge under the crown); collider sections use the same function */
export function trunkR(c: Column, y: number): number {
  const u = Math.max(0, y - c.gy);
  // (no flare: the buttress flanges carry the foot, and the spiral stair's band starts 6 cm off the bark)
  void u;
  return c.r;
}
/** the drawn trunk's groove floor (fraction of r): the trunk collider's inscribed radius (parity) */
export const TRUNK_GROOVE = 0.975;
/** the tower's T1 cabin: wall pieces per octagon face (face centred on angle a; u along the face, counter-
 *  clockwise; y absolute) — a door on the AT bridge's face, a window in every other face. Faces run 0.1 m past their
 *  corners (the walls meet behind the corner legs). */
export function towerCabin(): Array<{ a: number; u0: number; u1: number; y0: number; y1: number; door: boolean }> {
  const L = LAYOUT, c = TOWER.col, g = L.rings[L.deck.T1], A = TOWER.apothem, half = A * dmath.tan(Math.PI / 8) + 0.1, H = TOWER.cabinTop - g.y;
  const br = L.bridges.find((b) => b.id === "AT")!, bAng = dmath.atan2(br.b[2] - c.z, br.b[0] - c.x);
  const out: Array<{ a: number; u0: number; u1: number; y0: number; y1: number; door: boolean }> = [];
  for (let k = 0; k < 8; k++) {
    const a = k / 8 * TAU, door = Math.abs(dmath.atan2(dmath.sin(bAng - a), dmath.cos(bAng - a))) < Math.PI / 8;
    const op: Opening = door ? { side: 0, u: 0, w: CABIN.door.w, y: 0, h: CABIN.door.h, kind: "door" } : { side: 0, u: 0, w: CABIN.win.w, y: CABIN.win.y, h: CABIN.win.h, kind: "window" };
    for (const p of wallPieces(half * 2, H, [op])) out.push({ a, u0: p.u0, u1: p.u1, y0: g.y + p.v0, y1: g.y + p.v1, door });
  }
  return out;
}
/** the octagonal tower's outer apothem and base-room skirt (door toward the camp, west) */
export const TOWER = (() => {
  const c = LAYOUT.columns.find((q) => q.id === "T")!;
  return { col: c, apothem: TOWER_APO, capR: TOWER_APO + 1.6, legR: 0.44, cabinTop: TOWER_TOP - DECK_T, skirtH: 3.2, doorA: TOWER_BASE.doorA, floorY: TOWER_BASE.floorY, plinthLo: TOWER_BASE.lo, mid: 70, top: TOWER_TOP, roofY: TOWER_TOP + 3.1, peak: NEST_Y - 0.3, nest: NEST_Y, nestR: NEST_R, flagTop: FLAG_TOP };
})();

// ------------------------------------------------------------------------------------------------ rails
// Every rope rail = a run of posts. The client draws posts + a peeled timber handrail + hanging ropes between them, and
// genColliders puts ONE box per post-to-post chord (the 0.26 × 0.16 m handrail plank) — colliders ≡ visuals, no rope-top
// ledge a kong can stand on without a drawn surface under its feet.
const ringOuterR = (g: Ring, t: number) => g.kind === "tower" ? g.r1 / dmath.cos(t - Math.round(t / (TAU / g.n)) * (TAU / g.n)) : g.r1;
/** the deck's outer rail: posts every ~1.7 m 0.1 m inside the rim (tower: at the octagon corners), broken at every gap */
export function ringRailRuns(g: Ring, c: Column): V3[][] {
  if (g.cabin) return [];
  const tower = g.kind === "tower", NP = tower ? 8 : Math.max(16, Math.round(TAU * g.r1 / 1.7));
  const T = (i: number) => (tower ? i + 0.5 : i) / NP * TAU, inGap = (t: number) => g.gaps.some((h) => inArc(t, h));
  let start = 0;
  for (let i = 0; i < NP; i++) if (inGap(T(i))) { start = i + 1; break; }
  const runs: V3[][] = []; let run: V3[] = [];
  for (let k = 0; k <= NP; k++) {
    const t = T((start + k) % NP);
    if (inGap(t)) { if (run.length > 1) runs.push(run); run = []; continue; }
    // a gate narrower than the post spacing between two posts: break the chord across it too
    if (run.length && inGap(t - TAU / NP / 2)) { if (run.length > 1) runs.push(run); run = []; }
    const [x, z] = rad(c, t, ringOuterR(g, t) - 0.1); run.push([x, g.y, z]);
  }
  if (run.length > 1) runs.push(run);
  return runs;
}
/** the rail round the stair hole in the inner band (none at the stair exit) */
export function holeRailRuns(g: Ring, c: Column): V3[][] {
  const runs: V3[][] = [];
  for (const h of g.holes) {
    const L0 = wrap(h[1] - h[0]), m = Math.max(2, Math.ceil(L0 * g.rh / 1.4));
    let pts: V3[] = [];
    for (let k = 0; k <= m; k++) {
      const t = h[0] + k / m * L0;
      if (Number.isFinite(g.exitA) && Math.abs(dmath.atan2(dmath.sin(t - g.exitA), dmath.cos(t - g.exitA))) < 1.2 / g.rh) { if (pts.length > 1) runs.push(pts); pts = []; continue; }
      const [x, z] = rad(c, t, g.rh); pts.push([x, g.y, z]);
    }
    if (pts.length > 1) runs.push(pts);
  }
  return runs;
}
/** the spiral stair's outer rail: a point on every railed tread (the client draws a post on every second one) */
export function stairRailRuns(h: Helix, c: Column): V3[][] {
  const runs: V3[][] = [[]];
  for (const s of h.steps) {
    if (s.rail) { const [x, z] = rad(c, s.a, s.r1 - 0.06); runs[runs.length - 1].push([x, s.y, z]); }
    else if (runs[runs.length - 1].length) runs.push([]);
  }
  return runs.filter((r) => r.length > 1);
}
/** collider boxes of a rail run: one per chord = the handrail plank (mid height) */
export function railBoxes(run: V3[], postEvery = 1): Box[] {
  const out: Box[] = [];
  // the posts (0.075 m logs, floor → 1.17 m; the client draws one on every `postEvery`-th point and the last)
  for (let i = 0; i < run.length; i++) if (i % postEvery === 0 || i === run.length - 1) { const q = run[i]; out.push({ c: [q[0], q[1] + 0.585, q[2]], h: [0.06, 0.585, 0.06], yaw: 0, surf: "wood", noShoot: true }); }
  for (let i = 0; i + 1 < run.length; i++) {
    const a = run[i], b = run[i + 1], dx = b[0] - a[0], dz = b[2] - a[2], L = dmath.hypot(dx, dz);
    if (L < 0.05) continue;
    // the HANDRAIL only (0.26 m plank at 0.84–1.1 m): a kong's capsule can't pass under it, and nothing un-drawn hangs
    // between it and the floor (the ropes below are dressing)
    const mid = (a[1] + b[1]) / 2, y0 = mid + RAIL_H - 0.21, y1 = mid + RAIL_H + 0.05;
    out.push({ c: [(a[0] + b[0]) / 2, (y0 + y1) / 2, (a[2] + b[2]) / 2], h: [L / 2 + 0.05, (y1 - y0) / 2, 0.07], yaw: dmath.atan2(dz, dx), surf: "wood", noShoot: true });
  }
  return out;
}

/** a bridge's walk surface: plank segments (centre t, length) — the collider and the visual deck share them */
export function bridgeSegs(b: Bridge): Array<{ t0: number; t1: number; y: number }> {
  const L = dmath.hypot(b.b[0] - b.a[0], b.b[2] - b.a[2]);
  const n = Math.max(2, Math.ceil(L / 0.6));
  const out: Array<{ t0: number; t1: number; y: number }> = [];
  for (let i = 0; i < n; i++) { const t0 = i / n, t1 = (i + 1) / n; out.push({ t0, t1, y: sagY(b.a[1], b.b[1], b.sag, (t0 + t1) / 2) }); }
  return out;
}
/** y of the zip cable at parameter t */
export const zipY = (z: Zip, t: number) => sagY(z.a[1], z.b[1], z.sag, t);
/** the pole stands BESIDE the cable
 *  end, ZIP_POLE_OFF to the cable's left, holding the cable on a cantilever arm: a rider arriving under the cable steps
 *  straight onto the deck past it (a pole dead ahead, on the line, blocks the way). The cable ends (a / b) — the ride — are unchanged. */
export const ZIP_POLE_OFF = 0.75;
export function zipPole(z: Zip, end: 0 | 1): [number, number] {
  const dx = z.b[0] - z.a[0], dz = z.b[2] - z.a[2], l = dmath.hypot(dx, dz), p = end ? z.b : z.a;
  return [p[0] - (dz / l) * ZIP_POLE_OFF, p[2] + (dx / l) * ZIP_POLE_OFF];
}

// ------------------------------------------------------------------------------------------------ colliders
function genColliders(L: CanopyLayout): Box[] {
  const out: Box[] = [];
  const B = (cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, yaw: number, surf: Surface, o: { noShoot?: boolean; noDrive?: boolean } = {}) =>
    out.push({ c: [cx, cy, cz], h: [hx, hy, hz], yaw, surf, ...(o.noShoot ? { noShoot: true } : {}), ...(o.noDrive ? { noDrive: true } : {}) });
  /** radial box at angle a around a column: radial span [r0, r1], tangential half ht, vertical [y0, y1] */
  const RB = (col: Column, a: number, r0: number, r1: number, ht: number, y0: number, y1: number, surf: Surface, o: { noShoot?: boolean } = {}) => {
    const [x, z] = rad(col, a, (r0 + r1) / 2);
    B(x, (y0 + y1) / 2, z, (r1 - r0) / 2, (y1 - y0) / 2, ht, a, surf, o);
  };

  // trunks: 4 inscribed bands 45° apart (half extents R·cos 22.5°, R·sin 22.5°) — their union is a disc whose edge
  // stays within [0.924 R, R] (squares would stick out as an 8-point star). ONE box each from under the ground to the
  // crown fork: stacked sections leave invisible ledges at every seam (the solver steps onto any top within 0.6 m)
  for (const c of L.columns) {
    // from under the LOWEST ground round the trunk (the escarpment trunks: the downhill side is up to 4 m below gy)
    let gMin = c.gy; for (let k = 0; k < 24; k++) { const a = k / 24 * TAU; gMin = Math.min(gMin, groundAt(c.x + dmath.cos(a) * c.r * 1.05, c.z + dmath.sin(a) * c.r * 1.05)); }
    const y0 = Math.min(c.gy - 3, gMin - 1.2), y1 = c.top;
    if (c.kind === "tree") {
      // (parity) 8 bands 22.5° apart: a 32-gon whose edge stays within [0.975 r, 0.994 r] = the drawn trunk's groove
      // floor (TRUNK_GROOVE); the strangler strands stand ≤ 0.02 r proud of it (client trees.ts addTrunk) — no grazing band
      const R0 = trunkR(c, c.gy + 5) * TRUNK_GROOVE / dmath.cos(Math.PI / 16);
      for (let k = 0; k < 8; k++) B(c.x, (y0 + y1) / 2, c.z, R0 * dmath.cos(Math.PI / 16), (y1 - y0) / 2, R0 * dmath.sin(Math.PI / 16), k * Math.PI / 8, "wood");
    } else {
      const R0 = trunkR(c, c.gy + 5) / 0.962;
      for (let k = 0; k < 4; k++) B(c.x, (y0 + y1) / 2, c.z, R0 * dmath.cos(Math.PI / 8), (y1 - y0) / 2, R0 * dmath.sin(Math.PI / 8), k * Math.PI / 4, "wood");
    }
    // crown limbs: stepped boxes along the lofted centre line (limbSamples), each as tall as the drawn tube over its span
    for (const l of c.limbs) for (const q of limbSamples(l)) B(q.x, q.y, q.z, q.hl, q.hy, q.hw, q.yaw, "wood");
    // buttress flanges: stepped blades (the visual blade's top follows the same staircase within ±0.15 m)
    for (const f of c.flanges) {
      const n = Math.max(3, Math.ceil(f.h / 0.28)), r0 = trunkR(c, c.gy) * 0.8;
      for (let i = 0; i < n; i++) {
        const ra = r0 + (f.len + (trunkR(c, c.gy) - r0)) * (i / n), rb = r0 + (f.len + (trunkR(c, c.gy) - r0)) * ((i + 1) / n);
        const top = c.gy + f.h * (1 - (i + 0.5) / n);
        const [mx, mz] = rad(c, f.a, (ra + rb) / 2);
        const lo = Math.min(groundAt(...rad(c, f.a, ra)), groundAt(...rad(c, f.a, rb)), groundAt(mx, mz)) - 0.4;
        if (top <= lo + 0.05) continue;
        RB(c, f.a, ra, rb, f.th / 2 * (1 - 0.4 * i / n), lo, top, "wood");
      }
    }
  }
  // spiral stairs
  for (const h of L.helices) {
    const c = L.columns[h.col];
    for (const run of stairRailRuns(h, c)) out.push(...railBoxes(run, 2));
    for (const s of h.steps) {
      // a wedge tread = radial slices (tight mast stairs need 3: one box per tread would overhang its neighbours)
      // (parity: slices as wide as the wedge at their INNER radius — an outer-radius width hung 5–10 cm past the
      // drawn tread, a vertical ray there met the tread below, 0.3 m down)
      const nr = 3, y0 = Number.isFinite(s.solid) ? s.solid : s.y - STAIR.thick;
      for (let i = 0; i < nr; i++) {
        const ra = s.r0 + (s.r1 - s.r0) * i / nr, rb = s.r0 + (s.r1 - s.r0) * (i + 1) / nr;
        RB(c, s.a, ra, rb, ra * dmath.tan(s.dA / 2), y0, s.y, "wood");
      }
    }
  }
  // ring floors: outer band polygon segments + inner band segments except the holes; outer rail except gaps
  for (const g of L.rings) {
    const c = L.columns[g.col];
    const n = g.n;
    for (let k = 0; k < n; k++) {
      const a = (g.kind === "tower" ? k : k + 0.5) / n * TAU;
      const ht = g.r1 * dmath.tan(Math.PI / n) + 0.02;
      RB(c, a, g.rh, g.r1, ht, g.y - DECK_T, g.y, "wood");
    }
    for (const run of ringRailRuns(g, c)) out.push(...railBoxes(run));
    const ni = Math.max(12, Math.round(TAU * g.rh / 0.6));
    for (let k = 0; k < ni; k++) {
      const a = (k + 0.5) / ni * TAU;
      const inHole = g.holes.some((hl) => inArc(a, hl) || inArc(a - Math.PI / ni, hl) || inArc(a + Math.PI / ni, hl));
      if (inHole) continue;
      RB(c, a, g.r0, g.rh + 0.02, g.rh * dmath.tan(Math.PI / ni) + 0.02, g.y - DECK_T, g.y, "wood");
    }
    // hole rail along the band edge (not at the exit, where the stair steps out)
    for (const run of holeRailRuns(g, c)) out.push(...railBoxes(run));
  }
  // tower: 8 posts, the base-room skirt (door west), roof cap over the top deck
  {
    const T = TOWER, c = T.col;
    for (let k = 0; k < 8; k++) {
      const a = (k + 0.5) / 8 * TAU, rr = T.apothem / dmath.cos(Math.PI / 8) - 0.2, [x, z] = rad(c, a, rr);
      // (parity) the chunky log leg + its splayed foot block (0.9 × 0.5 m)
      B(x, (c.gy - 1 + T.roofY) / 2, z, T.legR * 0.82, (T.roofY - c.gy + 1) / 2, T.legR * 0.82, a, "wood");   // (r 0.44 → 0.38 logs)
      const g = groundAt(x, z); B(x, g + 0.1, z, 0.45, 0.25, 0.45, a, "wood");
    }
    // the stone plinth (8 radial boxes = the octagon) up to the open base deck
    for (let k = 0; k < 8; k++) RB(c, k / 8 * TAU, 0, T.apothem, T.apothem * dmath.tan(Math.PI / 8) + 0.02, T.plinthLo, T.floorY, "stone");
    // (3.2 m skirt walls' tops would be an unreachable floor — the base is an open plank deck on the plinth,
    // the legs + a crate stack are its cover)
    // the BANANA CO. board on the top deck's rail (structures.ts addTower: 2.4 × 0.9 m, bottom 1.1 m over the deck)
    { const a = 1.93, [x, z] = rad(c, a, T.apothem - 0.02); B(x, T.top + 1.55, z, 0.06, 0.45, 1.2, a, "wood"); }
    // the T1 cabin walls (towerCabin: the same pieces the client planks)
    for (const w of towerCabin()) { const [x, z] = rad(c, w.a, T.apothem - 0.11), tx = -dmath.sin(w.a), tz = dmath.cos(w.a), um = (w.u0 + w.u1) / 2; B(x + tx * um, (w.y0 + w.y1) / 2, z + tz * um, 0.11, (w.y1 - w.y0) / 2, (w.u1 - w.u0) / 2, w.a, "wood"); }
    // roof: an 8-sided thatch cap from the eave (R0) up to the crow's nest rim (nestR) — stepped ANNULAR layers (8 radial
    // boxes each, the mast stair passes through the middle); the thatch surface stays within ±0.15 m of the steps
    const eave = T.roofY, peak = T.peak, R0 = T.capR, Ri = T.nestR - 0.05, dy = 0.3;
    const n = Math.max(2, Math.round((peak - eave) / dy));
    for (let i = 0; i < n; i++) {
      const y0 = eave + (peak - eave) * i / n, y1 = eave + (peak - eave) * (i + 1) / n;
      const r = R0 - (R0 - T.nestR) * (i + 0.5) / n;
      for (let k = 0; k < 8; k++) { const a = k / 8 * TAU; RB(c, a, Ri, r, r * dmath.tan(Math.PI / 8) + 0.02, y0, y1, "fabric"); }
    }
  }
  // bridges: plank segments + rope rails both sides (noShoot)
  for (const b of L.bridges) {
    const dx = b.b[0] - b.a[0], dz = b.b[2] - b.a[2], Lh = dmath.hypot(dx, dz), yaw = dmath.atan2(dz, dx);
    for (const s of bridgeSegs(b)) {
      const tm = (s.t0 + s.t1) / 2, x = b.a[0] + dx * tm, z = b.a[2] + dz * tm, hl = (s.t1 - s.t0) * Lh / 2 + 0.01;
      B(x, s.y - 0.09, z, hl, 0.09, b.w / 2, yaw, "wood");
      for (const sd of [-1, 1]) { const [ox, oz] = toW(yaw, 0, sd * (b.w / 2 + 0.05)); B(x + ox, s.y + RAIL_H / 2, z + oz, hl, RAIL_H / 2, 0.05, yaw, "fabric", { noShoot: true }); }
    }
  }
  for (const k of L.blocks) B(k.x, (k.y0 + k.y1) / 2, k.z, k.hx, (k.y1 - k.y0) / 2, k.hz, k.yaw, "wood");
  // huts: walls (with openings), floors of upper storeys, interior stair, ceiling, stepped hip roof
  for (const h of L.huts) out.push(...hutColliders(h));
  // shelters: 4 posts + stepped roof
  for (const s of L.shelters) {
    for (const [u, v] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as V2[]) { const [ox, oz] = toW(s.yaw, u * (s.w / 2 - 0.15), v * (s.d / 2 - 0.15)); B(s.x + ox, s.y + s.h / 2, s.z + oz, 0.12, s.h / 2, 0.12, s.yaw, "wood"); }
    // (the shelter roof sits under the A2 deck, a jump-only parkour ledge from the stair rail — its thatch
    // stops bullets but not kongs: a kong on it drops 2.7 m onto the camera deck, never a pocket)
    out.push(...hipRoof(s.x, s.y + s.h, s.z, s.yaw, -s.w / 2 - 0.5, s.w / 2 + 0.5, -s.d / 2 - 0.5, s.d / 2 + 0.5, s.pitch).map((b) => ({ ...b, noWalk: true })));
  }
  // zip poles
  for (const zp of L.zips) for (const [e, p, y] of [[0, zp.a, zp.ya], [1, zp.b, zp.yb]] as Array<[0 | 1, V3, number]>) { const [px, pz] = zipPole(zp, e); B(px, (y + p[1] + 0.3) / 2, pz, 0.12, (p[1] + 0.3 - y) / 2, 0.12, 0, "wood"); }   // (inside the 0.15–0.17 m pole)
  // props
  for (const p of L.props) {
    // walk-over dressing (the firepit too — a 0.3 m stone ring round the embers, stepped over like a campfire)
    if (p.kind === "rope-coil" || p.kind === "pallet" || p.kind === "firepit") continue;
    if (p.kind === "lantern-post") { B(p.x, p.y + 1.0, p.z, 0.06, 1.25, 0.06, p.yaw, "wood", { noShoot: true }); continue; }   // the 2.25 m pole
    if (p.kind === "tent") {
      // A-frame: 4 layers narrowing toward the ridge (the canvas slopes stay within ±0.15 m of the steps)
      // (parity: 8 layers as wide as the canvas at their TOP — each layer's exposed top edge sits on the canvas)
      for (let i = 0; i < 8; i++) { const y0 = p.hy * 2 * i / 8, y1 = p.hy * 2 * (i + 1) / 8, k = Math.max(0.06, 1 - y1 / (p.hy * 2)); B(p.x, p.y + (y0 + y1) / 2, p.z, p.hx, (y1 - y0) / 2, p.hz * k, p.yaw, p.surf); }
      continue;
    }
    if (p.kind === "crate-stack") {
      // two crates side by side + one on top (the visual): a full-width lower box and a crate-sized upper box
      B(p.x, p.y + 0.5, p.z, p.hx, 0.5, p.hz, p.yaw, p.surf);
      // (between the 0.95 m top crate's body and its frame boards)
      B(p.x, p.y + 1.0 + (p.hy * 2 - 1.0) / 2, p.z, 0.47, (p.hy * 2 - 1.0) / 2, 0.47, p.yaw, p.surf);
      continue;
    }
    if (p.kind === "winch") {
      // (parity) the machine's three masses (structures.ts addProp winch): steel skid, cable drum + flanges + gears,
      // the motor housing — not one 2.6 × 1.7 m block with air at both ends
      const W3 = (lx: number, ly: number, lz: number, hx: number, hy: number, hz: number) => { const [ox, oz] = toW(p.yaw, lx, lz); B(p.x + ox, p.y + ly, p.z + oz, hx, hy, hz, p.yaw, p.surf); };
      W3(0, 0.105, 0, 1.3, 0.105, 0.72); W3(-0.8, 0.52, -0.05, 0.4, 0.31, 0.48);   // skid + cross bars, motor housing
      W3(0.1, 0.685, 0, 0.3, 0.115, 0.6); W3(0.1, 1.08, 0, 0.5, 0.28, 0.6); W3(0.1, 1.47, 0, 0.3, 0.11, 0.6);   // the rope-wound drum in 3 bands
      continue;
    }
    if (p.kind === "barrel") {
      // an octagon (two boxes 45° apart) inside the round lid: the lid covers every top the solver stands on
      for (const q of [0, Math.PI / 4]) B(p.x, p.y + p.hy, p.z, 0.33, p.hy, 0.33, p.yaw + q, p.surf);
      continue;
    }
    if (p.kind === "log") {
      // a round log: three stepped boxes (the curved top stays within ±0.15 m of the box tops)
      const r = p.hz, cy = p.y + p.hy;
      for (const [w, top] of [[r, cy + r * 0.27], [r * 0.91, cy + r * 0.6], [r * 0.69, cy + r]] as Array<[number, number]>) B(p.x, (p.y + top) / 2, p.z, p.hx, (top - p.y) / 2, w, p.yaw, p.surf);
      continue;
    }
    if (p.kind === "rock") {
      // (parity) the chiselled block (rockPlanes): full box to 2hy − ROCK_CT, the top ROCK_CT inset by ROCK_CT/2 —
      // every chamfer / chip of the drawn rock stays within ±0.15 m of these two boxes
      const h0 = p.hy * 2 - ROCK_CT;
      B(p.x, p.y + h0 / 2, p.z, p.hx, h0 / 2, p.hz, p.yaw, p.surf);
      B(p.x, p.y + h0 + ROCK_CT / 2, p.z, p.hx - ROCK_CT / 2, ROCK_CT / 2, p.hz - ROCK_CT / 2, p.yaw, p.surf);
      continue;
    }
    const noShoot = p.kind === "fence";
    B(p.x, p.y + p.hy, p.z, p.hx, p.hy, p.hz, p.yaw, p.surf, { noShoot, noDrive: noShoot });
  }
  // hut furniture (interiors kit, sim yaw)
  out.push(...interiorColliders(INTERIOR_ROOMS));
  return out;
}

/** Catmull-Rom point on a limb's centre line (the client's curveFrames uses the same centripetal-free 0.5 tension spline) */
function crPoint(pts: V3[], u: number): V3 {
  const n = pts.length - 1, f = Math.min(n - 1e-9, Math.max(0, u * n)), i = Math.floor(f), t = f - i;
  const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(n, i + 2)];
  const out: V3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const v0 = (p2[k] - p0[k]) * 0.5, v1 = (p3[k] - p1[k]) * 0.5, t2 = t * t, t3 = t2 * t;
    out[k] = (2 * p1[k] - 2 * p2[k] + v0 + v1) * t3 + (-3 * p1[k] + 3 * p2[k] - 2 * v0 - v1) * t2 + v0 * t + p1[k];
  }
  return out;
}
/** limb radius at u (0 base → 1 tip) */
export const limbR = (l: { r0: number; r1: number }, u: number) => l.r0 + (l.r1 - l.r0) * dmath.pow(u, 0.75);
/** the limb's centre line resampled every ~0.3 m (u, point) — the client lofts THIS polyline, the colliders box it */
export function limbLine(l: { pts: V3[] }): Array<{ u: number; p: V3 }> {
  const dense: V3[] = []; for (let i = 0; i <= 200; i++) dense.push(crPoint(l.pts, i / 200));
  let L = 0; const acc = [0]; for (let i = 1; i < dense.length; i++) { L += dmath.hypot3(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1], dense[i][2] - dense[i - 1][2]); acc.push(L); }
  const n = Math.max(4, Math.ceil(L / 0.3)), out: Array<{ u: number; p: V3 }> = [];   // 0.3 m: the stepped boxes' exposed ledges stay ≤ 0.25 m off the drawn tube
  for (let k = 0, j = 0; k <= n; k++) { const s = L * k / n; while (j < acc.length - 2 && acc[j + 1] < s) j++; const t = (s - acc[j]) / Math.max(1e-9, acc[j + 1] - acc[j]); const a = dense[j], b = dense[j + 1]; out.push({ u: k / n, p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t] }); }
  return out;
}
/** collider boxes along a limb: one per centre-line span, horizontal half-length = the span's, width = the tube radius,
 *  vertical extent = the drawn tube's (radius / cos of the span's slope) around the span's mid point */
export function limbSamples(l: { pts: V3[]; r0: number; r1: number }): Array<{ x: number; y: number; z: number; hl: number; hy: number; hw: number; yaw: number }> {
  const line = limbLine(l), out: Array<{ x: number; y: number; z: number; hl: number; hy: number; hw: number; yaw: number }> = [];
  for (let i = 0; i + 1 < line.length; i++) {
    if (line[i + 1].u > 0.94) break;   // the capped tip (deep in the foliage): a slab would hang past the drawn end
    const a = line[i].p, b = line[i + 1].p, dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2], h = dmath.hypot(dx, dz), L = dmath.hypot(h, dy);
    const r = limbR(l, (line[i].u + line[i + 1].u) / 2) * 0.96, cosT = h / Math.max(1e-6, L), sinT = Math.abs(dy) / Math.max(1e-6, L);
    // shallow span: a vertical slice (the tube's top / bottom sit r / cos θ off the axis); steep span: a horizontal slice
    // (the tube's sides sit r / sin θ off the axis along the span's heading)
    // the tube's cross-section in the slice plane is an ellipse (lateral r × r / cos θ vertical, or r / sin θ along the
    // heading for a steep slab): three boxes (a cross + its core) whose corners all sit on / inside it — no box corner
    // hangs past the round limb (parity), no part of the limb stands > 0.1 r out of the boxes
    const steep = sinT > cosT, x = (a[0] + b[0]) / 2, y = (a[1] + b[1]) / 2, z = (a[2] + b[2]) / 2, yaw = dmath.atan2(dz, dx);
    // a steep slab's uphill half is normally under the next slab; where the next span is NOT a steep slab (the bend into
    // the shallow run, or the tip) it stops at the span's top end — the drawn bough rises above anything further uphill
    const nb = line[i + 2]?.p, nextSteep = !!nb && line[i + 2].u <= 0.94 && Math.abs(nb[1] - b[1]) > dmath.hypot(nb[0] - b[0], nb[2] - b[2]);
    const ux = h > 1e-6 ? dx / h : 0, uz = h > 1e-6 ? dz / h : 0;
    for (const [kw, ke] of [[0.7, 0.7], [0.92, 0.38], [0.38, 0.92]]) {
      if (steep) {
        const A = r / sinT * ke, lo = -A, hi = nextSteep ? A : Math.min(A, h / 2 + 0.02), m = (lo + hi) / 2;
        out.push({ x: x + ux * m, y, z: z + uz * m, hl: (hi - lo) / 2, hy: Math.abs(dy) / 2 + 0.02, hw: r * kw, yaw });
      } else out.push({ x, y, z, hl: h / 2 + 0.02, hy: r / cosT * ke, hw: r * kw, yaw });
    }
  }
  return out;
}

/** chiselled rock: the top chamfer band the collider steps in by half (see genColliders) */
export const ROCK_CT = 0.3;
/** the drawn rock of a `rock` prop = its box (local frame: x ±hx, z ±hz, y 0..2hy, bottom = p.y) cut by these planes
 *  (n·q ≤ d): top-edge chamfers 0.16–0.3 m, vertical corner chamfers 0.06–0.12 m, top-corner chips. Deterministic per
 *  prop; the client clips the box with them (a convex faceted block), the collider is the 2-box step in genColliders */
export function rockPlanes(p: Prop, k = 1): Array<[number, number, number, number]> {
  const r = mulberry(Math.floor(p.x * 73.1) * 7919 + Math.floor(p.z * 31.7) * 104729 + 17);
  const { hx, hz } = p, top = p.hy * 2, s2 = Math.SQRT1_2, s3 = 1 / Math.sqrt(3);
  const out: Array<[number, number, number, number]> = [];
  // top edges (±x, ±z): the plane through (edge − c, top) and (edge, top − c)
  for (const [nx, nz, e] of [[1, 0, hx], [-1, 0, hx], [0, 1, hz], [0, -1, hz]] as V3[]) { const c = (0.16 + r() * 0.14) * k; out.push([nx * s2, s2, nz * s2, (e + top - c) * s2]); }
  // vertical corners
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as V2[]) { const c = (0.06 + r() * 0.06) * k; out.push([sx * s2, 0, sz * s2, (hx + hz - c) * s2]); }
  // top corner chips
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as V2[]) { const q = (0.3 + r() * 0.15) * k; out.push([sx * s3, s3, sz * s3, (hx + top + hz - q) * s3]); }
  return out;
}

/** stepped hip roof collider over the local rect [x0, x1] × [z0, z1] (frame at x, z, yaw): 0.3 m layers shrinking by
 *  rise/pitch on every side — the visual thatch surface stays within ±0.15 m of the steps */
export function hipRoof(x: number, y: number, z: number, yaw: number, x0: number, x1: number, z0: number, z1: number, pitch: number): Box[] {
  const out: Box[] = [], dy = 0.3, inset = dy / pitch;
  for (let i = 0; ; i++) {
    const w = (x1 - x0) / 2 - (i + 0.5) * inset, d = (z1 - z0) / 2 - (i + 0.5) * inset;
    if (w < 0.25 || d < 0.25) break;
    const [ox, oz] = toW(yaw, (x0 + x1) / 2, (z0 + z1) / 2);
    out.push({ c: [x + ox, y + i * dy + dy / 2, z + oz], h: [w, dy / 2, d], yaw, surf: "fabric" });
  }
  return out;
}
/** the hut roofs are OCTAGONAL: the roof rect with its
 *  corners chamfered (c0 = 0.42 of the short half side) — a conical / round thatch read from every side. Every outline
 *  level (inset s, rise s·pitch) is the rect shrunk by s with a chamfer shrinking to 0 at the top: all 8 faces planar.
 *  Collider: 0.3 m layers, each = 2 crossed boxes + 4 boxes rotated 45° along the chamfers (inside the outline). */
export const ROOF_CHAMFER = 0.42;
export function octRoofOutline(h: Hut, s: number): { cx: number; cz: number; a: number; b: number; c: number } {
  const [x0, x1, z0, z1] = hutRoofRect(h), a0 = (x1 - x0) / 2, b0 = (z1 - z0) / 2, m = Math.min(a0, b0);
  return { cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, a: a0 - s, b: b0 - s, c: ROOF_CHAMFER * m * Math.max(0, 1 - s / m) };
}
export function octRoof(h: Hut, y: number): Box[] {
  const out: Box[] = [], dy = 0.3, inset = dy / h.pitch;
  const Lw = (lx: number, lz: number): V2 => { const [ox, oz] = toW(h.yaw, lx, lz); return [h.x + ox, h.z + oz]; };
  for (let i = 0; ; i++) {
    const o = octRoofOutline(h, (i + 0.5) * inset);
    if (o.a < 0.25 || o.b < 0.25) break;
    const yc = y + i * dy + dy / 2;
    { const [x, z] = Lw(o.cx, o.cz); out.push({ c: [x, yc, z], h: [o.a, dy / 2, o.b - o.c], yaw: h.yaw, surf: "fabric" }, { c: [x, yc, z], h: [o.a - o.c, dy / 2, o.b], yaw: h.yaw, surf: "fabric" }); }
    if (o.c < 0.12) continue;
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as V2[]) {
      const lx = o.cx + sx * ((2 * o.a - o.c) / 2 - o.c / 4), lz = o.cz + sz * ((2 * o.b - o.c) / 2 - o.c / 4), [x, z] = Lw(lx, lz);
      out.push({ c: [x, yc, z], h: [o.c * Math.SQRT2 / 2, dy / 2, o.c * Math.SQRT2 / 4], yaw: h.yaw + dmath.atan2(-sz, sx), surf: "fabric" });
    }
  }
  return out;
}
/** the roof rect of a hut (local): the back eave stays short on deck huts so it never reaches over the stair band */
export function hutRoofRect(h: Hut): [number, number, number, number] {
  const back = h.id === "depot" ? h.over : 0.15;
  return [-h.w / 2 - h.over, h.w / 2 + h.over, -h.d / 2 - back, h.d / 2 + h.over];
}

/** wall pieces of one side of a hut storey (wall space u along the side, v up from the storey floor) */
export function wallPieces(len: number, H: number, ops: Opening[]): Array<{ u0: number; u1: number; v0: number; v1: number }> {
  const out: Array<{ u0: number; u1: number; v0: number; v1: number }> = [];
  const sorted = ops.slice().sort((a, b) => a.u - b.u);
  let u = -len / 2;
  for (const o of sorted) {
    const a = o.u - o.w / 2, b = o.u + o.w / 2;
    if (a > u + 1e-3) out.push({ u0: u, u1: a, v0: 0, v1: H });
    if (o.y > 1e-3) out.push({ u0: a, u1: b, v0: 0, v1: o.y });            // sill
    if (o.y + o.h < H - 1e-3) out.push({ u0: a, u1: b, v0: o.y + o.h, v1: H }); // lintel
    u = b;
  }
  if (u < len / 2 - 1e-3) out.push({ u0: u, u1: len / 2, v0: 0, v1: H });
  return out;
}
/** local frame of a hut side: centre offset (lx, lz) of u = 0, direction of +u, outward normal */
export function sideFrame(h: Hut, side: Side): { cx: number; cz: number; dir: V2; n: V2; len: number } {
  const W2 = h.w / 2, D2 = h.d / 2;
  switch (side) {
    case 0: return { cx: 0, cz: D2, dir: [1, 0], n: [0, 1], len: h.w };
    case 1: return { cx: W2, cz: 0, dir: [0, -1], n: [1, 0], len: h.d };
    case 2: return { cx: 0, cz: -D2, dir: [-1, 0], n: [0, -1], len: h.w };
    default: return { cx: -W2, cz: 0, dir: [0, 1], n: [-1, 0], len: h.d };
  }
}
export const WALL_T = 0.2;
/** how far the log courses' crests stand out of the wall plane (structures.ts addHut) — the wall collider covers them
 *  (parity: the valleys between the log courses — a ray grazing along the wall ran 0.76 m inside a 0.12 m collider
 *  skin; the crests stand ≤ 0.06 m proud of it) */
export const WALL_OUT = 0.08;

/** interior stair: tread tops up to this height sit on the closed under-stair cupboard (no headroom there anyway) */
export const STAIR_CAB = 1.55;
export function hutColliders(h: Hut): Box[] {
  const out: Box[] = [];
  const Lw = (lx: number, lz: number): V2 => { const [ox, oz] = toW(h.yaw, lx, lz); return [h.x + ox, h.z + oz]; };
  const H = h.floorH;
  for (let f = 0; f < h.floors; f++) {
    const fy = h.y + f * H;
    for (const side of [0, 1, 2, 3] as Side[]) {
      const sf = sideFrame(h, side);
      const ops = f === 0 ? h.openings.filter((o) => o.side === side) : h.openings.filter((o) => o.side === side && o.kind === "window").map((o) => ({ ...o }));
      // walls run corner to corner along x (front/back) and between them along z (left/right)
      const len = side === 0 || side === 2 ? sf.len : sf.len - 2 * WALL_T;
      // (parity) the box reaches out to the crests of the round log courses (WALL_OUT past the wall plane; the
      // front / back walls also past the corners, where the logs cross) — inner face unchanged (the interiors kit's room)
      const alongX = side === 0 || side === 2;
      for (const p of wallPieces(len, H, ops)) {
        const u0 = alongX && p.u0 <= -len / 2 + 1e-6 ? p.u0 - WALL_OUT : p.u0, u1 = alongX && p.u1 >= len / 2 - 1e-6 ? p.u1 + WALL_OUT : p.u1;
        const um = (u0 + u1) / 2, off = (WALL_T - WALL_OUT) / 2, th = (WALL_T + WALL_OUT) / 2;
        const lx = sf.cx + sf.dir[0] * um - sf.n[0] * off, lz = sf.cz + sf.dir[1] * um - sf.n[1] * off;
        const [x, z] = Lw(lx, lz);
        out.push({ c: [x, fy + (p.v0 + p.v1) / 2, z], h: alongX ? [(u1 - u0) / 2, (p.v1 - p.v0) / 2, th] : [th, (p.v1 - p.v0) / 2, (u1 - u0) / 2], yaw: h.yaw, surf: "wood" });
      }
    }
    // storey floor slab (upper storeys; the ground storey stands on its deck / its own floor)
    if (f > 0 && h.stair) {
      const s = h.stair, x0 = s.x0 - 0.05, x1 = s.x0 + s.steps * s.run + 0.05, z1 = s.z + s.w / 2 + 0.05;
      const iw = h.w / 2 - WALL_T, id = h.d / 2 - WALL_T;
      // slab = the interior minus the stair opening (the opening spans the whole stair run's upper part)
      const rects: Array<[number, number, number, number]> = [[-iw, iw, z1, id], [-iw, x0, -id, z1], [x1, iw, -id, z1]];
      for (const [a, b, c, d] of rects) if (b - a > 0.05 && d - c > 0.05) { const [x, z] = Lw((a + b) / 2, (c + d) / 2); out.push({ c: [x, fy - 0.12, z], h: [(b - a) / 2, 0.12, (d - c) / 2], yaw: h.yaw, surf: "wood" }); }
      // rail along the opening's open long side
      const [rx, rz] = Lw((x0 + x1) / 2 + 0.6, z1 + 0.04);
      out.push({ c: [rx, fy + RAIL_H / 2, rz], h: [(x1 - x0) / 2 - 0.6, RAIL_H / 2, 0.04], yaw: h.yaw, surf: "wood", noShoot: true });
    }
  }
  if (!Number.isFinite(h.y)) return out;
  // ground-storey floor for huts on the ground (depot): a plank floor box
  if (h.id === "depot") { const [x, z] = Lw(0, 0); out.push({ c: [x, h.y - 0.6, z], h: [h.w / 2, 0.6, h.d / 2], yaw: h.yaw, surf: "wood" }); }
  // interior stair (2-storey) along the back wall — an OPEN stair (not a solid boxed plank mass): the
  // low flight (tread tops ≤ STAIR_CAB) sits on a closed under-stair cupboard (solid to the floor), the upper treads are
  // 0.12 m slabs on stringers with open risers (the alcove under them has full headroom); a balustrade on the open side
  if (h.stair) {
    const s = h.stair, rise = h.floorH / s.steps;
    for (let i = 0; i < s.steps; i++) {
      const top = (i + 1) * rise, bot = top <= STAIR_CAB + 1e-6 ? 0 : top - 0.12, [x, z] = Lw(s.x0 + (i + 0.5) * s.run, s.z);
      out.push({ c: [x, h.y + (top + bot) / 2, z], h: [s.run / 2 + 0.01, (top - bot) / 2, s.w / 2], yaw: h.yaw, surf: "wood" });
      // balustrade (handrail + balusters) on the room side, from the 3rd tread up (the cupboard closes the low end)
      if (i >= 2) { const [bx, bz] = Lw(s.x0 + (i + 0.5) * s.run, s.z + s.w / 2 + 0.03); out.push({ c: [bx, h.y + top + 0.48, bz], h: [s.run / 2 + 0.01, 0.48, 0.03], yaw: h.yaw, surf: "wood", noShoot: true }); }
    }
  }
  // ceiling (top storey) + stepped hip roof
  const top = h.y + h.floors * H;
  { const [x, z] = Lw(0, 0); out.push({ c: [x, top + 0.1, z], h: [h.w / 2, 0.1, h.d / 2], yaw: h.yaw, surf: "wood" }); }
  out.push(...octRoof(h, top + 0.2));
  {
    // (parity) the ridge bundle (a 0.24 m thatch roll along the ridge, structures.ts addHut) — the stepped layers stop
    // short of it
    const [x0, x1, z0, z1] = hutRoofRect(h), hw = (x1 - x0) / 2, hd = (z1 - z0) / 2, rise = Math.min(hw, hd) * h.pitch, rl = Math.abs(hw - hd);
    const [x, z] = Lw((x0 + x1) / 2, (z0 + z1) / 2), alongX = hw >= hd;
    out.push({ c: [x, top + 0.2 + rise - 0.02, z], h: alongX ? [rl + 0.2, 0.22, 0.22] : [0.22, 0.22, rl + 0.2], yaw: h.yaw, surf: "fabric" });
  }
  // front porch step for the depot doors (ground hut): a plank step so the 0.35 m sill is a step, not a wall
  return out;
}

// ------------------------------------------------------------------------------------------------ interiors (kit)
/** hut → interiors-kit style / role per storey: every treehouse + the depot is furnished by the shared kit */
const HUT_ROOM: Record<Hut["interior"], Array<{ style: InteriorStyle; role: RoomRole }>> = {
  lodge: [{ style: "house", role: "living" }, { style: "hut", role: "bunk" }],
  // (parity: the kit's warehouse racks / sack piles don't match their colliders yet)
  store: [{ style: "hut", role: "fisher" }],
  radio: [{ style: "cabin", role: "captain" }],
  bunk: [{ style: "hut", role: "bunk" }],
  kitchen: [{ style: "house", role: "kitchen" }],
  map: [{ style: "cabin", role: "captain" }],
  depot: [{ style: "cabin", role: "crew" }],
};
/** furniture density per hut room: the loot generator needs ≥ 12.5 m² of capsule-free roofed floor per
 *  building (8 cells of 1.25 m) to call it enterable — the kit's full set filled the small treehouses */
const HUT_DENSITY = 1;
/** kit re-rolls: the Gibbon Pod's first roll stood a kit bench whose collider top had no drawn seat (parity) */
const KIT_RESEED: Record<string, number> = { lodge: 3, "c-hut": 2 };
/** the kit's room frame = the hut frame (three.js yaw = −sim yaw; same local axes, same side numbering). Opening `at`
 *  runs along local x on sides 0 / 2 and local z on 1 / 3; our `u` runs along the side's direction (sideFrame) */
function hutRooms(h: Hut, hi: number): InteriorRoom[] {
  const iw = h.w - 2 * WALL_T, id = h.d - 2 * WALL_T;
  const toAt = (o: Opening) => { const sf = sideFrame(h, o.side); return o.side === 0 || o.side === 2 ? sf.dir[0] * o.u : sf.dir[1] * o.u; };
  const ops = (f: number): RoomOpening[] => h.openings.filter((o) => f === 0 || o.kind === "window").map((o) => ({ side: o.side, at: toAt(o), w: o.w, kind: o.kind, y0: o.y, h: o.h }));
  // (not a dark uniform brown box) lighter limed panelling + pale boards: the room reads in the shade of the deck above
  const lodge = h.interior === "lodge";
  // (the lodge: limewashed plaster over a timber dado — a cabin-interior read: bright walls, wood trims)
  const finish = { floor: "boards" as const, wallMat: lodge ? "plaster" as const : "panel" as const, wall: lodge ? "#f1e2c2" : "#e2c08e", dado: lodge ? "#b8875a" : null, frames: false, glass: false, curtains: h.interior === "lodge" || h.interior === "kitchen", baseboard: true, ceiling: "beams" as const };
  return HUT_ROOM[h.interior].slice(0, h.floors).map((sr, f) => {
    const room: InteriorRoom = { id: `${h.id}:${f}`, x: h.x, y: h.y + f * h.floorH, z: h.z, yaw: -h.yaw, w: iw, d: id, h: h.floorH, style: sr.style, role: sr.role, seed: 7100 + hi * 13 + f + (KIT_RESEED[h.id] ?? 0), openings: ops(f), finish, wallT: WALL_T, density: HUT_DENSITY };
    // single-storey huts: an open floor in the middle (the kit stood its table + chairs there; the 1.25 m loot
    // lattice then split the room in two too-small halves) — furniture goes against the walls, the room scans as one
    if (!h.stair && h.id !== "b-hut") room.keepOut = [{ r: [-iw * 0.17, -id * 0.15, iw * 0.17, id * 0.15], walk: true }];
    if (h.stair) {
      const s = h.stair, x0 = s.x0 - 0.05, x1 = s.x0 + s.steps * s.run + 0.05, z0 = s.z - s.w / 2 - 0.05, z1 = s.z + s.w / 2 + 0.05;
      if (f === 0) { room.keepOut = [[x0 - 0.1, z0 - 0.1, x1 + 0.1, z1 + 0.1], { r: [x0 - 1.4, z0, x0, z1 + 0.2], walk: true }]; room.openTop = true; }
      // (the kit stood a wardrobe column across the loft at x ≈ 1.2 — the far half of the
      // loft was only reachable by jumping over a bunk) the stair arrival + a 1.15 m aisle along the opening's rail
      // across the whole loft stay free: every part of the loft is walked to from the stair top
      else room.keepOut = [{ r: [x0 - 0.1, z0 - 0.1, x1 + 0.1, z1 + 0.15], solid: true }, { r: [x1, z0, iw / 2, z1 + 0.9], walk: true }, { r: [-iw / 2, z1 + 0.1, iw / 2, z1 + 1.25], walk: true }];
    }
    return room;
  });
}
/** every furnished room of CANOPY LINE (one per storey) — the match's loot generator reads these (interiorLoot) */
export const INTERIOR_ROOMS: InteriorRoom[] = LAYOUT.huts.flatMap((h, i) => hutRooms(h, i));

export const colliders: Box[] = genColliders(LAYOUT);

// ------------------------------------------------------------------------------------------------ clearings
/** areas vegetation / random scatter must leave clear: every deck footprint, the tower, huts on the ground, bridges */
export const clearings: Array<{ x: number; z: number; r: number } | { x: number; z: number; hx: number; hz: number; yaw?: number }> = (() => {
  const out: Array<{ x: number; z: number; r: number } | { x: number; z: number; hx: number; hz: number; yaw?: number }> = [];
  for (const c of LAYOUT.columns) {
    const rs = LAYOUT.rings.filter((g) => LAYOUT.columns[g.col] === c).map((g) => g.r1);
    out.push({ x: c.x, z: c.z, r: Math.max(c.kind === "tree" ? c.r + 4.5 : 6, ...rs) + 1.5 });
  }
  for (const h of LAYOUT.huts) if (h.id === "depot") out.push({ x: h.x, z: h.z, hx: h.w / 2 + 2.5, hz: h.d / 2 + 2.5, yaw: -h.yaw });
  for (const b of LAYOUT.bridges) {
    const x = (b.a[0] + b.b[0]) / 2, z = (b.a[2] + b.b[2]) / 2, L = dmath.hypot(b.b[0] - b.a[0], b.b[2] - b.a[2]);
    // only where the bridge is low over the ground (tall trees under a high bridge would poke through the planks)
    out.push({ x, z, hx: L / 2 + 1, hz: 3.5, yaw: -dmath.atan2(b.b[2] - b.a[2], b.b[0] - b.a[0]) });
  }
  out.push({ x: CAMP[0], z: CAMP[1], r: 10 }); // plateau camp
  // (a clump of thin veg stems penned a 1 m pocket at (161.97, 51.74, −181.43) on
  // the plateau path south of the South Tree — 6/8 live escapes) keep veg's scatter off that spot
  out.push({ x: 162.2, z: -181.4, r: 3 });
  return out;
})();

// ------------------------------------------------------------------------------------------------ loot
/** designed loot (the LOOT_SPOTS contract): chests in every treehouse, the lodge loft, the tower top + base,
 *  the depot; floor loot on decks, bridge heads and the forest floor */
export const LOOT_SPOTS: { chests: [number, number, number, number][]; floor: [number, number, number][] } = (() => {
  const chests: [number, number, number, number][] = [], floor: [number, number, number][] = [];
  // every spot is nudged (spiral, ≤ 2.5 m) to the nearest point that is clear of every collider (a 0.5 m disc, 1 m tall)
  // and has a floor right under it (a box top or the ground within 6 cm) — loot never sits inside a crate or a bunk
  const inBox = (b: Box, x: number, z: number, r: number) => { const dx = x - b.c[0], dz = z - b.c[2], c = dmath.cos(b.yaw ?? 0), s = dmath.sin(b.yaw ?? 0), lx = dx * c + dz * s, lz = -dx * s + dz * c; const qx = Math.max(-b.h[0], Math.min(b.h[0], lx)), qz = Math.max(-b.h[2], Math.min(b.h[2], lz)); return dmath.hypot(lx - qx, lz - qz) < r; };
  const ok = (x: number, y: number, z: number) => {
    let floorHit = Math.abs(groundAt(x, z) - y) < 0.06;
    for (const b of colliders) {
      const top = b.c[1] + b.h[1], bot = b.c[1] - b.h[1];
      if (!floorHit && Math.abs(top - y) < 0.06 && inBox(b, x, z, 0.01)) floorHit = true;
      if (top > y + 0.05 && bot < y + 1.0 && inBox(b, x, z, 0.5)) return false;
    }
    return floorHit;
  };
  const settle = <T extends number[]>(q: T): T => {
    for (let k = 0; k < 200; k++) { const r = Math.sqrt(k) * 0.18, a = k * 2.39996; const x = q[0] + dmath.cos(a) * r, z = q[2] + dmath.sin(a) * r; if (ok(x, q[1], z)) { q[0] = x; q[2] = z; return q; } }
    return q;
  };
  // every furnished room: its first chest slot + up to 2 floor slots from the interiors kit (the match generator reads
  // INTERIOR_ROOMS for the full candidate set; these are the designed hints)
  for (const r of INTERIOR_ROOMS) {
    const l = interiorLoot([r]);
    if (l.chests[0]) chests.push([...l.chests[0]] as [number, number, number, number]);
    for (const f of l.floor.slice(0, r.role === "living" ? 2 : 1)) floor.push([...f] as [number, number, number]);
  }
  // tower top (the landmark) + tower base room
  { const c = TOWER.col; const [x, z] = rad(c, 20 * D2R, 3.2); chests.push([x, TOWER.top, z, -20 * D2R]); const [x2, z2] = rad(c, TOWER.doorA + Math.PI, 3.1); chests.push([x2, TOWER.floorY, z2, 0]); }
  // decks
  for (const [id, a, r] of [["A1", 110, 6.5], ["A2", 330, 4.4], ["B1", 330, 8.2], ["B0", 60, 5.8], ["E1", 20, 7.5], ["C1", 320, 8.0], ["C0", 200, 5.6], ["D1", 60, 7.8], ["F1", 250, 7.5], ["T1", 60, 3.1], ["H0", 300, 5.8], ["H1", 330, 8.0], ["B2", 60, 5.0], ["G1", 300, 6.0], ["K1", 20, 5.8]] as Array<[string, number, number]>) {
    const g = LAYOUT.rings[LAYOUT.deck[id]], [x, z] = rad(LAYOUT.columns[g.col], a * D2R, r); floor.push([x, g.y, z]);
  }
  // forest floor: by the camp, under the Lodge Tree, in the valley between the giants
  for (const [x, z] of [[CAMP[0] + 2, CAMP[1] + 4.5], [188, -208], [205, -240], [231, -262], [238, -222], [170, -262]] as V2[]) floor.push([x, groundAt(x, z), z]);
  // the camp: a chest between the tents
  { const x = CAMP[0] - 1.2, z = CAMP[1] - 3.6; chests.push([x, groundAt(x, z), z, 0.6]); }
  return { chests: chests.map(settle), floor: floor.map(settle) };
})();

// ------------------------------------------------------------------------------------------------ views
/** the view camera: standing on the Launch Tree's camera deck, looking NE across the valley to the lagoon */
export const VIEW = (() => {
  // the view is wide and far round the rim: at 55° on the camera deck's rim, eye 4.3 m, bearing −42°
  // (tower + winch shelter left, the Lodge Tree + lodge + the AB bridge centre-right, the valley decks and the sea
  // below), 70° — the props placed in the W() frame (crates, barrel, greens) stay in the bottom-left foreground
  const g = LAYOUT.rings[LAYOUT.deck.A1], b = -42 * D2R;
  const p: V2 = [149.8 + dmath.cos(55 * D2R) * 8.9, -229.0 + dmath.sin(55 * D2R) * 8.9];
  return { pos: [p[0], g.y + 4.3, p[1]] as V3, target: [p[0] + dmath.cos(b) * 100, g.y + 4.3 - 16.5, p[1] + dmath.sin(b) * 100] as V3, fov: 70 };
})();
