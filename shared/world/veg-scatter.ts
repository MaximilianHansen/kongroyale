// Deterministic vegetation scatter — pure TS (no three.js) so the SERVER replays it for trunk colliders and the
// client uses it for rendering. Everything derives from the seed + the Terrain sampler + POI clearings.
//
//   scatterVegetation(terrain, clearings, rules?, rocks?) → big plants (trees, palms, bushes, banana, bamboo, logs …)
//   detailCell(terrain, clearings, cx, cz, …)            → camera-local detail (grass, flowers, ferns) for one cell
//   vegTrunkColliders(instances)                          → Box[] for the server / client prediction
//   vegCollidersFor(terrain, clearings, rocks)            → the one-call version (scatter + colliders)
//   vegStaticColliders(terrain, td, clearings)            → the same from the TerrainData (rocks computed here) — what
//                                                           shared/sim/static-world.ts uses on the server AND the client
//
// ONE SOURCE OF TRUTH for trunk shapes: palmShape / jungleTreeShape / logShape / BAMBOO below are used by the client
// geometry builders (client/src/world/veg/species/*) AND by vegTrunkColliders, so the boxes follow the visible trunks.
//
// Rule order matters: every COLLIDABLE kind (trees, palms, mangroves, bamboo, logs) is placed first, then the
// decorative kinds. Terrain rocks (terrainRocks()) POST-FILTER collidable plants (never change the gap grid): the
// renderer and the collision world MUST both pass the rock list (vegStaticColliders does) or the server gets ~200 extra
// trunks buried in rocks (invisible pillars). POI collider volumes (allColliders()) are always applied — no caller input.
import { Biome, POIS, WORLD, type Poi } from "./map";
import type { Terrain } from "./terrain";
import type { Box } from "./colliders";
import { TERRAIN_CAMS, badlandsAt, terrainRocks, terrainRockColliders, type RockInstance, type TerrainData } from "./terrain-gen";
import { Simplex2, mulberry32, smoothstep } from "./noise";
import { allColliders } from "../pois/index";
import { toWorld as harborToWorld } from "../pois/peel-harbor";
import { canopyKeepAt, crownOverAuthoredLane, deepJungleAt, OPEN_FLOOR_KEEP } from './veg-landscape';
import * as dmath from "../sim/dmath";

export type VegKind =
  | "palm" | "palm-leaning" | "jungle-tree" | "bush" | "fern" | "monstera" | "banana-plant" | "flowers" | "grass"
  | "bamboo" | "mangrove" | "log" | "groundcover" | "vine" | "litter";

export const VEG_KINDS: VegKind[] = ["palm", "palm-leaning", "jungle-tree", "bush", "fern", "monstera", "banana-plant", "flowers", "grass", "bamboo", "mangrove", "log", "groundcover", "vine", "litter"];

/** number of geometry variants per kind (client builds this many; scatter picks one per instance) */
export const VARIANTS: Record<VegKind, number> = {
  palm: 3, "palm-leaning": 3, "jungle-tree": 5, bush: 3, fern: 2, monstera: 2, "banana-plant": 2, flowers: 3, grass: 4, bamboo: 2, mangrove: 3, log: 2, groundcover: 4, vine: 2,
  // palm litter: 0 fallen coconuts, 1 a dry fallen frond, 2 a split husk + nut — decorative, no colliders
  litter: 3,
};

/** kinds with trunk colliders */
export const COLLIDABLE: ReadonlySet<VegKind> = new Set<VegKind>(["palm", "palm-leaning", "jungle-tree", "mangrove", "bamboo", "log"]);

export type Clearing = { x: number; z: number; r: number } | { x: number; z: number; hx: number; hz: number; yaw?: number };

export interface VegInstance {
  kind: VegKind;
  variant: number;
  x: number; y: number; z: number;
  /** radians about +Y (three.js convention: yaw rotates the model's +X to (cos yaw, 0, −sin yaw)) */
  yaw: number;
  /** uniform scale, 1 = natural size */
  scale: number;
  /** a designed landmark (the hero tree at a jungle glade) */
  hero?: boolean;
}

/** detail cell size (m) for the on-demand grass / ferns / flowers layer */
export const DETAIL_CELL = 16;

const D2R = Math.PI / 180;

// =====================================================================================================================
// trunk shapes (shared by the geometry builders and the colliders)

export interface PalmShape {
  leaning: boolean;
  /** highlands palm: orange cup-stack trunk, yellow nuts (Grass biome only) */
  warm: boolean;
  /** trunk length (m), base radius (m) */
  h: number;
  r0: number;
  /** trunk polyline in model space (+X = lean direction), [x, y, z]; pts[0] is sunk 0.5 m below ground */
  pts: Array<[number, number, number]>;
}

const lerpN = (a: number, b: number, t: number) => a + (b - a) * t;

export function palmShape(variant: number, leaning: boolean): PalmShape {
  const rnd = mulberry32(1000 + variant * 17 + (leaning ? 500 : 0));
  const v = variant % 3;
  const warm = !leaning && v === 2;
  const sCurve = leaning && v === 2;
  const h = leaning ? 8.2 + rnd() * 2.8 : warm ? 7.5 + rnd() * 2.5 : 9.5 + rnd() * 3.5;
  // (the highland "warm" palms lean 16–22° at the foot and curve back upright toward the crown: the hero
  // palm is a visibly CURVED trunk arcing out over the trail, not a straight tilted pole)
  const a0 = (leaning ? 34 + rnd() * 14 : warm ? 16 + rnd() * 6 : 4 + rnd() * 9) * D2R;       // lean from vertical at the base
  const a1 = (leaning ? (sCurve ? -7 : 6) : warm ? -6 : 1) * D2R;       // at the top (S-curve: leans back)
  const wob = (rnd() - 0.5) * (leaning ? 0.5 : 0.7);
  // (the highland hero's cup-stack trunk is stout — 0.38 m, a chunky stack of fat cups with a real S-curve)
  const r0 = (warm ? 0.38 : 0.225) + rnd() * 0.03;
  const N = 14;
  const pts: Array<[number, number, number]> = [[0, -0.5, 0]];
  let px = 0, py = 0;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    if (i > 0) {
      // warm highland palm: a real S — a steadier foot (0.55 a0), the lean peaking a third of the way up
      // (a0 + 9°), then the crown end curling back past upright (a1)
      const ang = warm
        ? (t < 0.35 ? lerpN(a0 * 0.55, a0 + 9 * D2R, smoothstep(0, 0.35, t)) : lerpN(a0 + 9 * D2R, a1 - 3 * D2R, smoothstep(0.35, 1, t)))
        : a1 + (a0 - a1) * dmath.pow(1 - t, leaning ? (sCurve ? 1.2 : 1.8) : 1.3);
      px += dmath.sin(ang) * (h / N); py += dmath.cos(ang) * (h / N);
    }
    pts.push([px, py, dmath.sin(t * Math.PI * 1.6) * wob]);
  }
  return { leaning, warm, h, r0, pts };
}

/** palm trunk radius at arc distance d (m) from the ground point (d < 0 = the sunk part), around-angle a */
export function palmRadius(s: PalmShape, d: number, a: number): number {
  const t = Math.max(0, d) / s.h;
  let r = s.r0 * (1 - 0.3 * t);
  const f = Math.max(0, 1 - Math.max(0, d) / 0.75);
  r += s.r0 * 0.7 * f * f;                                                                     // base flare
  r += s.r0 * 0.35 * dmath.pow(Math.max(0, 1 - Math.max(0, d) / 0.35), 2) * dmath.pow(Math.max(0, dmath.cos(a * 5 + 0.3)), 3); // root knuckles
  r *= 1 + 0.1 * smoothstep(0.9, 1.0, t);                                                     // swelling under the crown
  return r;
}

export interface TreeShape {
  /** total height (canopy top), trunk length to the crown fork, base radius */
  H: number;
  trunkH: number;
  r0: number;
  /** trunk polyline in model space, pts[0] sunk 0.8 m */
  pts: Array<[number, number, number]>;
  /** buttress blades: angle (model, about +Y from +X toward −Z like yaw), reach from the trunk surface, height at the trunk, thickness, sideways sweep */
  flanges: Array<{ a: number; len: number; h: number; th: number; sweep: number }>;
  /** canopy ellipsoid: centre height, radii */
  crownY: number; rx: number; ry: number;
}

/** jungle tree silhouettes: 0 understory, 1 canopy, 2 emergent, 3 wide umbrella, 4 tall narrow */
const TREE_H = [11, 14.5, 18.5, 13, 13.5];
export function jungleTreeShape(variant: number): TreeShape {
  const v = variant % 5;
  const rnd = mulberry32(2000 + v * 29);
  const H = TREE_H[v] + rnd() * 2.5;
  const r0 = 0.4 + rnd() * 0.1 + (H - 11) * 0.035;
  const trunkH = H * (v === 3 ? 0.5 : v === 4 ? 0.62 : v === 0 ? 0.5 : 0.58);
  // canopy (1) and umbrella (3) trees lean their crown ~2 m toward model +X (the scatter turns +X toward the nearest
  // trail: trees at a forest edge reach for the light, so the canopy closes over the paths); understory a little
  const lean = (rnd() - 0.5) * 0.12 + (v === 1 || v === 3 ? 0.24 : v === 0 ? 0.12 : 0), lean2 = (rnd() - 0.5) * 0.12;
  const pts: Array<[number, number, number]> = [[0, -0.8, 0]];
  for (let i = 1; i <= 6; i++) { const t = i / 6; pts.push([lean * trunkH * t * t + dmath.sin(t * 5 + v) * 0.08, trunkH * t, lean2 * trunkH * t * t + dmath.cos(t * 4 + v) * 0.06]); }
  const n = 4 + Math.floor(rnd() * 3), ph = rnd() * Math.PI * 2;
  const flanges: TreeShape["flanges"] = [];
  // (the emergent's roots are massive mossy fins: tall thin PLANKS with deep gaps — longer and taller than the other
  // silhouettes', not thicker: thicker walls merge into one skirt and the giant reads as a plain dark cone)
  const fk = v === 2 ? { len: 1.3, h: 1.45, th: 1.05 } : { len: 1, h: 1, th: 1 };
  for (let k = 0; k < n; k++) {
    const big = rnd();
    flanges.push({
      a: ph + (k / n) * Math.PI * 2 + (rnd() - 0.5) * 0.7,
      len: (1.5 + big * 1.8) * (0.8 + (H - 11) * 0.035) * fk.len,
      h: (1.6 + big * 1.7) * (0.85 + (H - 11) * 0.03) * fk.h,
      th: (0.36 + rnd() * 0.14) * fk.th,
      sweep: (rnd() - 0.5) * 1.1,
    });
  }
  const wide = v === 3 ? 1.35 : v === 4 ? 0.8 : 1;
  const rx = (H * 0.42 + rnd() * 1.2) * wide, ry = (H * 0.25 + rnd() * 0.6) * (v === 3 ? 0.75 : v === 4 ? 1.25 : 1);
  return { H, trunkH, r0, pts, flanges, crownY: trunkH + H * 0.17, rx, ry };
}

/** crown shape per jungle-tree silhouette: [width ×, height ×, centre lift × ry] of the shared rx / ry (client canopy.ts
 * builds the canopy with it; the scatter's road keep-out uses the same extent) */
export const TREE_CROWN_K: ReadonlyArray<readonly [number, number, number]> = [[1, 1, 0], [1.05, 1, 0.1], [1.3, 0.55, 0.35], [1.12, 0.95, 0], [0.82, 1.4, 0.1]];

/**
 * Crown footprint of a big plant in MODEL space (before yaw / scale): centre offset (x, z) from the trunk base and the
 * radius the leaves reach (so the canopy never buries the dirt-road network seen from the air). Jungle trees:
 * the lobed canopy's cards reach ~1.15 × its rx around the trunk top; palms: the frond fan ~4.2 m around the tip.
 */
export function crownFootprint(kind: VegKind, variant: number): { x: number; z: number; r: number } | null {
  if (kind === "jungle-tree") {
    const s = jungleTreeShape(variant % 5), t = s.pts[s.pts.length - 1];
    return { x: t[0], z: t[2], r: s.rx * TREE_CROWN_K[variant % 5][0] * 1.15 };
  }
  if (kind === "palm" || kind === "palm-leaning") {
    const s = palmShape(variant % 3, kind === "palm-leaning"), t = s.pts[s.pts.length - 1];
    return { x: t[0], z: t[2], r: 4.2 };
  }
  return null;
}

/**
 * Crown vertical band in MODEL space (min / max y of the leaves at scale 1) — measured from the built species
 * (re-measure after changing canopy.ts / palm.ts). The scatter keeps every crown ≥ 3.2 m over
 * the highest ground under it (no crown at eye level on a slope).
 */
const CROWN_BAND: Record<string, [number, number]> = {
  "palm:0": [8.93, 14.85], "palm:1": [7.47, 13.04], "palm:2": [6.38, 11.44],
  "palm-leaning:0": [6.88, 12.43], "palm-leaning:1": [6.68, 12.39], "palm-leaning:2": [5.89, 11.06],
  "jungle-tree:0": [5.53, 14.36], "jungle-tree:1": [7.14, 17.69], "jungle-tree:2": [8.55, 20.77], "jungle-tree:3": [5.63, 14.29], "jungle-tree:4": [7.28, 20.6],
  "mangrove:0": [1.16, 6.11], "mangrove:1": [3.69, 9.99], "mangrove:2": [2.74, 7.14],
};
export function crownBand(kind: VegKind, variant: number): [number, number] | null {
  return CROWN_BAND[`${kind}:${variant}`] ?? null;
}

/**
 * Nearest DIRT ROAD (Path biome) sample for every terrain sample — an exact integer feature transform (two raster
 * passes propagating the nearest seed through the 8-neighbourhood; squared distances in whole cells, so the server and
 * the client get bit-identical answers). Cached per terrain. `near[k]` = index of the nearest Path sample, −1 if none.
 */
interface PathField { res: number; near: Int32Array }
const PATH_FIELDS = new WeakMap<Uint8Array, PathField>();
export function pathField(t: Terrain): PathField {
  let f = PATH_FIELDS.get(t.biome);
  if (f) return f;
  const r = t.res, n = r * r, near = new Int32Array(n).fill(-1), bi = t.biome;
  for (let k = 0; k < n; k++) if (bi[k] === Biome.Path) near[k] = k;
  const d2 = (k: number, s: number) => { const di = ((k / r) | 0) - ((s / r) | 0), dj = (k % r) - (s % r); return di * di + dj * dj; };
  const relax = (k: number, q: number) => {
    const s = near[q]; if (s < 0) return;
    if (near[k] < 0 || d2(k, s) < d2(k, near[k])) near[k] = s;
  };
  for (let i = 0; i < r; i++) {
    for (let j = 0; j < r; j++) {
      const k = i * r + j;
      if (i > 0) { relax(k, k - r); if (j > 0) relax(k, k - r - 1); if (j < r - 1) relax(k, k - r + 1); }
      if (j > 0) relax(k, k - 1);
    }
    for (let j = r - 2; j >= 0; j--) relax(i * r + j, i * r + j + 1);
  }
  for (let i = r - 1; i >= 0; i--) {
    for (let j = r - 1; j >= 0; j--) {
      const k = i * r + j;
      if (i < r - 1) { relax(k, k + r); if (j < r - 1) relax(k, k + r + 1); if (j > 0) relax(k, k + r - 1); }
      if (j < r - 1) relax(k, k + 1);
    }
    for (let j = 1; j < r; j++) relax(i * r + j, i * r + j - 1);
  }
  f = { res: r, near };
  PATH_FIELDS.set(t.biome, f);
  return f;
}

/** vector (dx, dz) from (x, z) to the nearest dirt-road sample and its distance to the road's EDGE (m; ≤ 0 on the road,
 * Infinity without roads) */
export function nearestRoad(t: Terrain, x: number, z: number): { dx: number; dz: number; d: number } {
  const f = pathField(t), r = f.res;
  const j = Math.min(r - 1, Math.max(0, Math.round((x + t.half) / t.cell))), i = Math.min(r - 1, Math.max(0, Math.round((z + t.half) / t.cell)));
  const s = f.near[i * r + j];
  if (s < 0) return { dx: 0, dz: 0, d: Infinity };
  const dx = t.sampleX(s % r) - x, dz = t.sampleZ((s / r) | 0) - z;
  // (a Path sample stands for its 2 m cell: the painted road's edge is ~1 m beyond the outermost sample)
  return { dx, dz, d: Math.sqrt(dx * dx + dz * dz) - t.cell * 0.5 };
}

/** trunk radius of a jungle tree at height y (m above ground), including the root flare, without the buttress blades */
export const treeRadius = (s: TreeShape, y: number) => s.r0 * (1 - 0.36 * Math.max(0, y) / s.trunkH) * (1 + 0.28 * dmath.pow(Math.max(0, 1 - Math.max(0, y) / 1.4), 2));

/**
 * Buttress ridge at height y (not a flat triangular fin glued on with a stair-step): each
 * ridge is part of the TRUNK SURFACE — a smooth Gaussian bump in the cross-section whose reach beyond the bark grows
 * concavely toward the ground (1 − y/h)^1.6 with a slight wave, and whose angle sweeps sideways near the ground (sinuous
 * in plan). trunkRadiusAt() is the full cross-section; the mesh (client canopy.ts buttressTrunk) and the colliders
 * (flangeAt below → vegTrunkColliders) both come from it.
 */
export function ridgeAt(fl: TreeShape["flanges"][number], y: number): { a: number; reach: number } {
  const t = Math.min(1, Math.max(0, y / fl.h));
  return { a: fl.a + fl.sweep * 0.35 * (1 - t) * (1 - t), reach: fl.len * dmath.pow(1 - t, 1.6) * (1 + 0.07 * dmath.sin(t * 7 + fl.a * 3)) };
}

/** angular half-width (rad) of a ridge's Gaussian at height y: ~th thick at mid-reach, widening into a fillet near the top */
export function ridgeWidth(s: TreeShape, fl: TreeShape["flanges"][number], y: number, reach: number): number {
  return fl.th / (1.67 * (treeRadius(s, y) + reach * 0.5));
}

const wrapA = (d: number) => { d = (d + Math.PI) % (2 * Math.PI); if (d < 0) d += 2 * Math.PI; return d - Math.PI; };

/** full trunk cross-section radius at height y (m above ground) and angle th (yaw convention: (cos th, −sin th)) */
export function trunkRadiusAt(s: TreeShape, y: number, th: number): number {
  let r = treeRadius(s, y);
  for (const fl of s.flanges) {
    if (y >= fl.h) continue;
    const q = ridgeAt(fl, y), w = ridgeWidth(s, fl, y, q.reach), d = wrapA(th - q.a) / w;
    r += q.reach * dmath.exp(-d * d);
  }
  return r;
}

// ---- the DRAWN jungle-tree trunk (no bullet passes through drawn bark or hits a box with
// no bark): the client mesh (canopy.ts buttressTrunk) and the bullet boxes (jungleTreeBoxes) both come from these.
const smooth01 = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
/** trunk centre (x, z) at height y (m above ground) — linear on the shared polyline */
export function treeCentreAt(s: TreeShape, y: number): [number, number] {
  const P = s.pts;
  for (let i = 1; i < P.length; i++) {
    if (y <= P[i][1] || i === P.length - 1) {
      const a = P[i - 1], b = P[i], t = Math.min(1, Math.max(0, (y - a[1]) / Math.max(1e-6, b[1] - a[1])));
      return [a[0] + (b[0] - a[0]) * t, a[2] + (b[2] - a[2]) * t];
    }
  }
  return [P[0][0], P[0][2]];
}
/** the drawn trunk tube's ring heights (LOD0 / LOD1) */
export function treeRings(s: TreeShape, lod1: boolean): number[] {
  const ys: number[] = [-0.8, -0.2, 0.25, 0.7, 1.2, 1.8, 2.5];
  for (let y = 3.3; y < s.trunkH - 0.3; y += lod1 ? 3.2 : 1.6) ys.push(y);
  ys.push(s.trunkH);
  return ys;
}
/** 0 on a root … 1 mid-gap: the crevice between two roots at height y, angle a (the tube pulls in there) */
export function treeCrevice(s: TreeShape, y: number, a: number): number {
  const HF = s.flanges.reduce((m, f) => Math.max(m, f.h), 0);
  let best = Math.PI;
  for (const fl of s.flanges) {
    if (y >= fl.h) continue;
    let d = (a - ridgeAt(fl, Math.max(0, y)).a) % (Math.PI * 2); if (d < -Math.PI) d += Math.PI * 2; if (d > Math.PI) d -= Math.PI * 2;
    best = Math.min(best, Math.abs(d));
  }
  return smooth01(0.18, 0.75, best) * (1 - smooth01(0.3, Math.max(2.4, 0.8 * HF), y));
}
/** the drawn tube radius at height y, angle a (without the LOD0 bark knobs, ±3.5 %) */
export function drawnTrunkRadius(s: TreeShape, y: number, a: number): number {
  const HF = s.flanges.reduce((m, f) => Math.max(m, f.h), 0);
  return treeRadius(s, y) * (1 - 0.3 * treeCrevice(s, y, a) * dmath.pow(Math.max(0, 1 - Math.max(0, y) / Math.max(2.6, 0.85 * HF)), 1.3));
}
export interface RootStation { x: number; z: number; y: number; hwB: number; hwT: number; f: number }
/** a buttress root's stations from the trunk (k = 0) to its tip (k = K): crest centre, crest height, half widths at the
 *  foot (hwB) and the crest (hwT) — the plank the client sweeps a rounded profile along */
export function rootStations(s: TreeShape, fl: TreeShape["flanges"][number], K: number, inner = false): RootStation[] {
  const st: RootStation[] = [];
  const [cx, cz] = treeCentreAt(s, 0);
  // (inner: two stations INSIDE the trunk above the attach height — the crest runs up into the bark as a fading ridge)
  if (inner) for (const k of [-2, -1]) {
    const g = -k / 2, q = flangeAt(s, fl, 0), y = fl.h + 0.55 * g * Math.min(1.6, fl.h * 0.4);
    const [tx, tz] = treeCentreAt(s, y), rr = treeRadius(s, y) * (1 - 0.28 * g) - 0.05;
    st.push({ x: tx + dmath.cos(q.a) * rr, z: tz - dmath.sin(q.a) * rr, y, hwB: fl.th * 0.62 * (1 - 0.35 * g), hwT: fl.th * 0.24 * (1 - 0.4 * g), f: -g * 0.1 });
  }
  for (let k = 0; k <= K; k++) {
    const f = dmath.pow(k / K, 0.85), q = flangeAt(s, fl, f), taper = 1 - 0.55 * f;
    const yC = k === K ? 0.02 : Math.max(q.h, 0.34 * (1 - f) + 0.16);
    st.push({ x: cx + dmath.cos(q.a) * q.reach, z: cz - dmath.sin(q.a) * q.reach, y: yC, hwB: fl.th * 0.56 * taper + 0.04, hwT: Math.min(fl.th * 0.22 * taper + 0.025, yC * 0.8), f });
  }
  return st;
}

/** tunables of jungleTreeBoxes (picked by a trunk-parity sweep: LOD0 A 0.8 % / B 0.9 % over
 *  3 593 trunk-near lines at ~64 boxes per tree — area = max ∫|crest − top| per root box (m²), topQ = box top within the
 *  crest range, hwAt = plank width sampled at this fraction of the crest height) */
export const TREE_BOX = { tol: 0.1, area: 0.03, topQ: 0.1, hwAt: 0.75, crevice: 0.06, bandR: 0.25, bandH: 2.6, bandHi: 4.5, roundTop: 2.4, rootIn: 0.25, rootK: 8, crevK: 0, crevQ: 0.3, crevRound: 2, coreRound: 3, minTop: 0.25, inner: 1 };
/** model-space bullet boxes of a jungle tree that follow its DRAWN LOD0 bark (canopy.ts buttressTrunk): c, h, and the box's
 *  local +x axis (ux, uz) in model xz. The trunk tube per ring band: a dodecagon (3 turned squares) where it is round,
 *  6 spokes (12 directions, each as long as the pulled-in radius there) in the crevice zone between the roots; each
 *  root: a stack of boxes along its crest (top within ±tol/2 of the crest), as wide as the plank at mid height. */
export function jungleTreeBoxes(s: TreeShape): Array<{ c: [number, number, number]; h: [number, number, number]; ux: number; uz: number; tag: string }> {
  const out: Array<{ c: [number, number, number]; h: [number, number, number]; ux: number; uz: number; tag: string }> = [];
  const B = TREE_BOX, rings0 = treeRings(s, false).filter((y) => y >= -0.2);
  // above roundTop the tube is round and tapers slowly: merge its rings into bands of ≤ bandHi
  const rings: number[] = [];
  for (const y of rings0) { const last = rings[rings.length - 1], prev = rings[rings.length - 2]; if (rings.length >= 2 && prev >= B.roundTop && y - prev <= B.bandHi && y !== rings0[rings0.length - 1]) rings[rings.length - 1] = y; else rings.push(y); void last; }
  const NA = 36, ang = (k: number) => (k / NA) * Math.PI * 2;
  const Rring = rings.map((y) => Array.from({ length: NA }, (_, k) => drawnTrunkRadius(s, y, ang(k))));
  for (let i = 0; i + 1 < rings.length; i++) {
    const ya = rings[i], yb = rings[i + 1];
    const dR = Math.max(...Rring[i].map((r, k) => Math.abs(r - Rring[i + 1][k])));
    const n = Math.max(1, Math.ceil(Math.max(dR / B.bandR, (yb - ya) / (ya >= B.roundTop ? B.bandHi : B.bandH))));
    for (let j = 0; j < n; j++) {
      const y0 = ya + (yb - ya) * j / n, y1 = ya + (yb - ya) * (j + 1) / n, ym = (y0 + y1) / 2, t = (ym - ya) / (yb - ya);
      const R = Rring[i].map((r, k) => r + (Rring[i + 1][k] - r) * t);
      const [cx, cz] = treeCentreAt(s, ym);
      const rmin = Math.min(...R), rmax = Math.max(...R), rmean = R.reduce((a, b) => a + b, 0) / NA, hy = (y1 - y0) / 2;
      // a union of k thin boxes turned by 180°/k, corner angle φ = 180°/(4k), approximates a disk within [cos φ, 1]·r:
      // round bands 3 boxes (±1.7 %), above roundTop 2 (±4 %), the crevice zone 6 boxes following the pulled-in radius
      const crev = rmax - rmin >= B.crevice, spokes = crev && B.crevK > 0;
      const k = spokes ? B.crevK : ym > B.roundTop ? 2 : crev ? B.crevRound : B.coreRound, phi = Math.PI / (4 * k), sc = 2 / (1 + dmath.cos(phi));
      // (crevice zone without spokes: a round core at a low quantile of the pulled-in radius — the root boxes reach into
      // the tube where it bulges round each root)
      const rc = crev ? R.slice().sort((a, b) => a - b)[Math.floor(B.crevQ * (NA - 1))] : rmean;
      for (let q = 0; q < k; q++) {
        const th = q * Math.PI / k, kk = Math.round((th / (Math.PI * 2)) * NA) % NA;
        const rp = (spokes ? R[kk] : rc) * sc, rn = (spokes ? R[(kk + NA / 2) % NA] : rc) * sc;
        const ux = dmath.cos(th), uz = -dmath.sin(th), off = (rp - rn) / 2 * dmath.cos(phi);
        out.push({ c: [cx + ux * off, ym, cz + uz * off], h: [(rp + rn) / 2 * dmath.cos(phi), hy, Math.min(rp, rn) * dmath.sin(phi)], ux, uz, tag: spokes ? "spoke" : crev ? "crev" : "core" });
      }
    }
  }
  // roots: the drawn plank is linear between its stations — sample it finely, then group into boxes whose crest range
  // stays within tol
  for (const fl of s.flanges) {
    const st = rootStations(s, fl, B.rootK, B.inner > 0);
    const pts: RootStation[] = [];
    for (let k = 0; k + 1 < st.length; k++) {
      const a = st[k], b = st[k + 1], m = Math.max(1, Math.ceil(Math.abs(a.y - b.y) / (B.tol * 0.5)));
      for (let j = 0; j < m; j++) { const u = j / m; pts.push({ x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u, y: a.y + (b.y - a.y) * u, hwB: a.hwB + (b.hwB - a.hwB) * u, hwT: a.hwT + (b.hwT - a.hwT) * u, f: a.f + (b.f - a.f) * u }); }
    }
    pts.push(st[st.length - 1]);
    // error area of grouping pts[a..b] under one flat top (∫ |crest − top| along the root)
    const errArea = (a: number, b: number) => {
      let lo = Infinity, hi = -Infinity; for (let k = a; k <= b; k++) { lo = Math.min(lo, pts[k].y); hi = Math.max(hi, pts[k].y); }
      const top = lo + (hi - lo) * B.topQ; let e = 0;
      for (let k = a; k < b; k++) e += (Math.abs(pts[k].y - top) + Math.abs(pts[k + 1].y - top)) / 2 * dmath.hypot(pts[k + 1].x - pts[k].x, pts[k + 1].z - pts[k].z);
      return e;
    };
    let i0 = 0;
    while (i0 < pts.length - 1) {
      let i1 = i0 + 1;
      if (B.area > 0) while (i1 + 1 < pts.length && errArea(i0, i1 + 1) <= B.area) i1++;
      else while (i1 + 1 < pts.length && pts[i0].y - pts[i1 + 1].y <= B.tol) i1++;
      const A = pts[i0], Z = pts[i1];
      let hw = 0, cnt = 0, cmin = Infinity, cmax = -Infinity;
      for (let k = i0; k <= i1; k++) {
        const p = pts[k], rT = Math.max(0.02, p.hwT), yArc = Math.max(0.01, p.y - rT), ym = p.y * B.hwAt;
        cmin = Math.min(cmin, p.y); cmax = Math.max(cmax, p.y);
        hw += p.hwB + (rT - p.hwB) * dmath.pow(Math.min(1, ym / yArc), 0.7); cnt++;
      }
      const top = cmin + (cmax - cmin) * B.topQ; hw /= cnt;
      let dx = Z.x - A.x, dz = Z.z - A.z; const L = dmath.hypot(dx, dz) || 1e-3; dx /= L; dz /= L;
      // the first box reaches back into the trunk (the root grows out of the tube)
      const back = i0 === 0 ? B.rootIn : 0, x0 = A.x - dx * back, z0 = A.z - dz * back;
      const len = L + back, y0 = -0.35;
      if (top > B.minTop) out.push({ c: [(x0 + Z.x) / 2, (y0 + top) / 2, (z0 + Z.z) / 2], h: [len / 2, (top - y0) / 2, hw], ux: dx, uz: dz, tag: `root${i0 === 0 ? "0" : ""}` });
      i0 = i1;
    }
  }
  return out;
}

// ---- mangroves: the shape the client
// sweeps its tubes along (canopy.ts buildMangrove) and the bullet boxes that follow the same sampled tubes
type V3n = [number, number, number];
/** three.js CatmullRomCurve3(pts, false, "catmullrom", tension).getPoint(u) — exact port (curveFrames samples it) */
export function catmullRomAt(pts: V3n[], u: number, tension = 0.5): V3n {
  const l = pts.length, p = (l - 1) * u;
  let ip = Math.floor(p), w = p - ip;
  if (w === 0 && ip === l - 1) { ip = l - 2; w = 1; }
  const p1 = pts[ip], p2 = pts[ip + 1];
  const p0 = ip > 0 ? pts[ip - 1] : [2 * pts[0][0] - pts[1][0], 2 * pts[0][1] - pts[1][1], 2 * pts[0][2] - pts[1][2]];
  const p3 = ip + 2 < l ? pts[ip + 2] : [2 * pts[l - 1][0] - pts[l - 2][0], 2 * pts[l - 1][1] - pts[l - 2][1], 2 * pts[l - 1][2] - pts[l - 2][2]];
  const out: V3n = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const x0 = p1[k], x1 = p2[k], t0 = tension * (x1 - p0[k]), t1 = tension * (p3[k] - x0);
    const c2 = -3 * x0 + 3 * x1 - 2 * t0 - t1, c3 = 2 * x0 - 2 * x1 + t0 + t1;
    out[k] = x0 + t0 * w + c2 * w * w + c3 * w * w * w;
  }
  return out;
}
export interface MangroveShape { H: number; trunk: V3n[]; roots: V3n[][]; nRoots: number; rnd: number }
/** a mangrove's trunk line and arching prop roots (model space; the client draws LOD0 AND LOD1 from the same roots) */
export function mangroveShape(variant: number): MangroveShape {
  const v = variant % 3;
  const rnd = mulberry32(4000 + v * 7);
  let used = 0; const R = () => { used++; return rnd(); };
  const H = [3.8, 6.4, 5.0][v] + R() * 1.2;
  const lean = v === 2 ? 0.9 : (R() - 0.5) * 0.5;
  const top: V3n = [lean + (R() - 0.5) * 0.3, H, (R() - 0.5) * 0.5];
  const trunk: V3n[] = [[0, 0.9, 0], [top[0] * 0.4, H * 0.5, top[2] * 0.4], top];
  const nRoots = [13, 9, 11][v], rr = mulberry32(4100 + v), roots: V3n[][] = [];
  for (let i = 0; i < nRoots; i++) {
    // ARCHING prop roots: they leave the trunk, bow up and out, and dive into the mud (a cage of arches)
    const a = (i / nRoots) * Math.PI * 2 + rr() * 0.5, spread = (v === 1 ? 1.2 : 1.6) + rr() * 1.3, y0 = 1.0 + rr() * 1.3;
    const c = dmath.cos(a), sn = dmath.sin(a);
    roots.push([[c * 0.12, y0, sn * 0.12], [c * spread * 0.35, y0 + 0.28, sn * spread * 0.35], [c * spread * 0.72, y0 * 0.62, sn * spread * 0.72], [c * spread, 0.1, sn * spread], [c * spread * 1.05, -1.2, sn * spread * 1.05]]);
  }
  return { H, trunk, roots, nRoots, rnd: used };
}
/** drawn tube radii (canopy.ts: tube radius(t), t = frame / (frames − 1)) */
export const mangroveRootR = (t: number) => 0.075 * (1 - 0.25 * t) + 0.03 * Math.max(0, 1 - t * 5);
export const mangroveTrunkR = (t: number) => 0.27 * (1 - 0.45 * t);
/** tube segments of the drawn LOD0 roots / trunk (curveFrames: 9 / 5 segments) */
export const MANGROVE_SEGS = { root: 9, trunk: 5 };
/** root box half-width as a fraction of the tube radius */
export const MANGROVE_BOX = { w: 0.97, maxDy: 0.5, end: 0, fit: 1 };
/** model-space bullet boxes of a mangrove: the trunk tube (2 turned boxes per segment) and every prop root (thin boxes
 *  along its sampled tube, split so that a sloped piece's box stays tight — bullets only: the root cage's walk box
 *  keeps the kong out) */
/** thin-tube bullet boxes (mangrove roots / trunk, bamboo canes): the drawn tube is linear between the curve samples
 *  catmullRomAt(pts, i / segs); `root` pieces get a rectangle inscribed in the slanted tube band (split while the lost
 *  corner ∝ ℓ·sin 2θ exceeds 4·maxDy·r), trunk pieces a 3-box disk union per ≤ 0.4 m */
export function tubeBoxes(out: Array<{ c: V3n; h: V3n; ux: number; uz: number; root: boolean }>, pts: V3n[], segs: number, rad: (t: number) => number, root: boolean, maxDy = MANGROVE_BOX.maxDy, w = MANGROVE_BOX.w) {
  const P = Array.from({ length: segs + 1 }, (_, i) => catmullRomAt(pts, i / segs));
  for (let i = 0; i < segs; i++) {
    const a = P[i], b = P[i + 1], ra = rad(i / segs), rb = rad((i + 1) / segs);
    // (roots: the inscribed box of a slanted piece loses ∝ ℓ·sin 2θ — split until that is ≤ 4·maxDy·r)
    const segL = dmath.hypot(b[0] - a[0], b[2] - a[2]), segY = Math.abs(b[1] - a[1]), s2 = 2 * segL * segY / Math.max(1e-6, segL * segL + segY * segY);
    const m = root ? Math.max(1, Math.ceil(dmath.hypot(segL, segY) * s2 / (4 * maxDy * Math.max(ra, rb)))) : Math.max(1, Math.ceil(segY / 0.4));
    for (let j = 0; j < m; j++) {
      const u0 = j / m, u1 = (j + 1) / m;
      const q0: V3n = [a[0] + (b[0] - a[0]) * u0, a[1] + (b[1] - a[1]) * u0, a[2] + (b[2] - a[2]) * u0];
      const q1: V3n = [a[0] + (b[0] - a[0]) * u1, a[1] + (b[1] - a[1]) * u1, a[2] + (b[2] - a[2]) * u1];
      const r = ra + (rb - ra) * (u0 + u1) / 2;
      if (Math.max(q0[1], q1[1]) + r < 0.05) continue;                    // under the mud / water
      let dx = q1[0] - q0[0], dz = q1[2] - q0[2]; const L = dmath.hypot(dx, dz);
      if (L > 1e-4) { dx /= L; dz /= L; } else { dx = 1; dz = 0; }
      const c: V3n = [(q0[0] + q1[0]) / 2, (q0[1] + q1[1]) / 2, (q0[2] + q1[2]) / 2], dy = Math.abs(q1[1] - q0[1]);
      // roots are thin (15 cm): a box INSCRIBED in the drawn 10-sided tube (inradius 0.95 r) — every root crossing is
      // near-grazing, so an overhang would read "clear but blocked"
      // an axis-aligned rectangle (along, up) inscribed in the slanted tube band (half-thickness w·r about the axis):
      // corners satisfy a·sinθ + b·cosθ ≤ w·r; flat pieces keep their length (a = L/2), steep ones their height
      const th = dmath.atan2(dy, L), sn = dmath.sin(th), cs = dmath.cos(th), wr = w * r;
      let ha: number, hb: number;
      if (th < Math.PI / 4) { ha = L / 2 + MANGROVE_BOX.end * r; hb = Math.max(0.3 * r, (wr - (L / 2) * sn * MANGROVE_BOX.fit) / cs); }
      else { hb = dy / 2 + MANGROVE_BOX.end * r; ha = Math.max(0.3 * r, (wr - (dy / 2) * cs * MANGROVE_BOX.fit) / sn); }
      if (root) out.push({ c, h: [Math.max(0.3 * r, ha), hb, wr], ux: dx, uz: dz, root });
      else {
        // the trunk: a 3-box disk union per ≤ 0.4 m piece (outline within ±1.7 % of the tube)
        const phi = Math.PI / 12, sc = 2 / (1 + dmath.cos(phi));
        for (let q = 0; q < 3; q++) { const a3 = q * Math.PI / 3; out.push({ c, h: [r * sc * dmath.cos(phi), dy / 2, r * sc * dmath.sin(phi)], ux: dmath.cos(a3), uz: -dmath.sin(a3), root }); }
      }
    }
  }
}

/** model-space bullet boxes of a mangrove: the trunk tube (3-box disk unions) and every prop root (thin boxes along its
 *  sampled tube — bullets only: the root cage's walk box keeps the kong out) */
export function mangroveBoxes(variant: number, maxDy = MANGROVE_BOX.maxDy): Array<{ c: V3n; h: V3n; ux: number; uz: number; root: boolean }> {
  const sh = mangroveShape(variant), out: Array<{ c: V3n; h: V3n; ux: number; uz: number; root: boolean }> = [];
  tubeBoxes(out, sh.trunk, MANGROVE_SEGS.trunk, mangroveTrunkR, false, maxDy);
  for (const r of sh.roots) tubeBoxes(out, r, MANGROVE_SEGS.root, mangroveRootR, true, maxDy);
  return out;
}

// ---- bamboo clumps (boxes per cane: one box round the whole clump would block the gaps between the canes)
export interface BambooCane { pts: V3n[]; h: number; r: number }
/** the canes of a bamboo clump (model space) — the client sweeps its tubes along them, the boxes follow them */
export function bambooCanes(variant: number): BambooCane[] {
  const rnd = mulberry32(10000 + variant * 3);
  const n = 8 + Math.floor(rnd() * 4), canes: BambooCane[] = [];
  for (let i = 0; i < n; i++) {
    const a = rnd() * 6.283, r = Math.sqrt(rnd()) * BAMBOO.r * 0.9, h = BAMBOO.h * (0.68 + rnd() * 0.32);
    const lean = (rnd() - 0.5) * 0.22 + dmath.cos(a) * r * 0.14, lean2 = (rnd() - 0.5) * 0.22 + dmath.sin(a) * r * 0.14;
    const pts: V3n[] = [[dmath.cos(a) * r, -0.2, dmath.sin(a) * r]];
    for (let k = 1; k <= 4; k++) { const t = k / 4; pts.push([dmath.cos(a) * r + lean * h * t * t, h * t, dmath.sin(a) * r + lean2 * h * t * t]); }
    canes.push({ pts, h, r: 0.055 + rnd() * 0.025 });
  }
  return canes;
}
/** drawn cane tube: radius(t) = r · (1 − 0.35 t), 6 segments (LOD0) */
export const BAMBOO_SEGS = 6;
export function bambooBoxes(variant: number): Array<{ c: V3n; h: V3n; ux: number; uz: number; root: boolean }> {
  const out: Array<{ c: V3n; h: V3n; ux: number; uz: number; root: boolean }> = [];
  // (a cane is 11–16 cm thick and nearly vertical: one inscribed box per drawn piece)
  for (const c of bambooCanes(variant)) tubeBoxes(out, c.pts, BAMBOO_SEGS, (t) => c.r * (1 - 0.35 * t), true, 99, 0.9);
  return out;
}
/** a union of k thin boxes turned by 180°/k round a vertical axis (corner angle 180°/4k): a disk of radius r within
 *  [cos φ, 1]·r·sc — trunks' round cross-sections (palms) */
function diskBoxes(out: Box[], c: [number, number, number], r: number, hy: number, k: number, surf: Box["surf"], fit = 0.5) {
  // (fit 0: inscribed [cos φ, 1]·r, 1: circumscribed; 0.5 = centred on r)
  // (a disk is a trunk — round: a tuk-tuk glancing off it slides by)
  const phi = Math.PI / (4 * k), sc = 1 / (1 - fit * (1 - dmath.cos(phi)));
  for (let q = 0; q < k; q++) out.push({ c, h: [r * sc * dmath.cos(phi), hy, r * sc * dmath.sin(phi)], yaw: q * Math.PI / k, surf, round: [c[0], c[2]] });
}

/** buttress ridge profile: crest height at fraction f of its reach (0 = at the trunk, 1 = the tip on the ground) */
export const flangeHeight = (fl: TreeShape["flanges"][number], f: number) => fl.h * (1 - dmath.pow(Math.max(0, Math.min(1, f)), 1 / 1.6));

/** the ridge crest at fraction f of its reach: distance from the trunk axis, angle, sideways offset (0), crest height */
export function flangeAt(s: TreeShape, fl: TreeShape["flanges"][number], f: number) {
  const y = flangeHeight(fl, f), q = ridgeAt(fl, y);
  return { reach: treeRadius(s, y) + q.reach, a: q.a, lat: 0, h: Math.max(0.06, y) };
}

export interface LogShape { L: number; R: number }
export function logShape(variant: number): LogShape {
  const rnd = mulberry32(11000 + (variant % 2) * 3);
  return { L: 4.5 + rnd() * 1.8, R: 0.4 + rnd() * 0.12 };
}

/** bamboo clump: canes within `r` of the centre, heights up to `h` */
export const BAMBOO = { r: 0.85, h: 8.5 };

// =====================================================================================================================
// rules

interface Rule {
  kind: VegKind;
  /** mean spacing (m) of the stratified grid; density = 1 / spacing² */
  spacing: number;
  /** acceptance weight per biome (0 = never) */
  biome: Partial<Record<Biome, number>>;
  /** minimum distance to any previously placed plant with a gap (m) */
  minGap?: number;
  /** slope limits (rise/run) */
  maxSlope: number;
  minSlope?: number;
  /** min / max height above sea level */
  minY: number;
  maxY?: number;
  /** clumping noise: frequency (1/m) and threshold 0..1 (higher = patchier) */
  clump?: [number, number];
  /** scale range */
  scale: [number, number];
  /** lean toward the sea (yaw = direction of the water) */
  seaward?: boolean;
  /** keep-out radius from POI pads (padY != null) — plants must not stand on pads (POIs dress them) */
  padMargin?: number;
  /** keep-out from Path / Paved / ocean samples (m); default 2.2 (1.2 for detail) */
  pathMargin?: number;
  /** within `r` m of a trail, turn the model's +X toward it (edge trees lean their crowns over the path) */
  faceTrail?: number;
  /** only within `r` m of the given biome (treeline bands) */
  edge?: { biome: Biome | Biome[]; r: number };
  /** only within `r` m of a terrain rock (bushes hugging boulders; needs the rock list) */
  nearRock?: number;
  /** camera-local detail layer (grass etc.) */
  detail?: boolean;
  /** restrict to these geometry variants */
  variants?: number[];
  /** groups (crossing beach palms): n members within r of the grid point, members lean toward each other */
  group?: { n: [number, number]; r: [number, number]; gap: number; upright?: number };
  /** share the clump noise field with other rules of the same key (copse trees + copse palms stand together) */
  clumpKey?: number;
  /** never inside a composed vista (VISTAS: the highlands crest keeps its open meadow view) */
  vistaFree?: boolean;
  /** skip where the volcanic badlands field exceeds this (black lava crust: no grass) */
  badlandsMax?: number;
  /** detail on painted trails: allowed where the path mask ≤ max, or within `band` m of the trail's edge (default by kind) */
  trail?: { max: number; band: number };
  /** design layer (jungle understory / mid-storey): "thicket" = the thicket / open-forest field + slope thinning
   * only, "floor" = also trunk affinity (gathers round the tree bases) + clean trail / river edges for tall plants */
  design?: "thicket" | "floor";
}

const J = Biome.Jungle, G = Biome.Grass, B = Biome.Beach, C = Biome.Cinder, R = Biome.Rock, L = Biome.Lagoon, F = Biome.Farmland;

export const BIG_RULES: Rule[] = [
  // ---- COLLIDABLE (placed first; see the header)
  // canopy: emergent (2) sparse, canopy (1) + umbrella (3), understory (0) + narrow (4) fill the gaps → 40–60 trees/ha
  { kind: "jungle-tree", spacing: 30, biome: { [J]: 1 }, minGap: 11, maxSlope: 0.72, minY: 1.5, clump: [1 / 120, 0.2], scale: [0.85, 1.35], padMargin: 8, pathMargin: 3.5, variants: [2] },
  { kind: "jungle-tree", spacing: 15, biome: { [J]: 1 }, minGap: 8.5, maxSlope: 0.75, minY: 1.2, clump: [1 / 90, 0.16], scale: [0.78, 1.28], padMargin: 6, pathMargin: 3, faceTrail: 10, variants: [1, 1, 3] },
  { kind: "jungle-tree", spacing: 12, biome: { [J]: 1 }, minGap: 6.5, maxSlope: 0.8, minY: 1.2, clump: [1 / 70, 0.14], scale: [0.7, 1.2], padMargin: 5, pathMargin: 3, faceTrail: 9, variants: [0, 4] },
  // slope-tolerant canopy filler: the steep hill faces (harbor hills, ridges) read as continuous jungle, not bare dirt
  { kind: "jungle-tree", spacing: 16, biome: { [J]: 1, [R]: 0.35 }, minGap: 7.5, minSlope: 0.68, maxSlope: 1.25, minY: 3, clump: [1 / 60, 0.24], scale: [0.8, 1.05], padMargin: 6, pathMargin: 3.5, variants: [0, 3, 4], edge: { biome: J, r: 18 } },
  // tall palms on the steep jungle hill faces (harbor hills, ridges): the target art's hills carry palm silhouettes on the
  // skyline, not only broadleaf blobs
  { kind: "palm", spacing: 24, biome: { [J]: 1, [R]: 0.3 }, minGap: 5, minSlope: 0.5, maxSlope: 1.15, minY: 3, clump: [1 / 50, 0.2], scale: [1.45, 1.85], padMargin: 6, pathMargin: 3, variants: [0, 1], edge: { biome: J, r: 18 } },
  // palms: tall jungle palms poke out of the canopy (the aerial's palm stars), beach groups lean over the sand,
  // lone highland palms on the meadows (the orange "warm" variant lives only there), hardy sparse volcano palms
  // jungle palms: tall (15–22 m) so their stars poke out of the broadleaf canopy — the aerial's palm-studded jungle
  // (palm stars over the whole jungle between the round crowns; these palms stay on the gentle jungle floor (slope
  // ≤ 0.5) so the hills keep a broadleaf share ≥ 50 % instead of a carpet of identical palms)
  { kind: "palm", spacing: 9.5, biome: { [J]: 0.8 }, minGap: 4, maxSlope: 0.5, minY: 0.7, clump: [1 / 60, 0.18], scale: [1.45, 1.95], padMargin: 4, pathMargin: 3, variants: [0, 1] },
  // meadow copses (Grass biome): distinct groves of broadleaf trees + palms with open meadow between (the aerial reads
  // wooded, the meadows stay meadows), and a feathered forest edge instead of a hard jungle / lawn line
  // (big, dense groves and a 50 m feathered forest edge for a ~70 % wooded island; open meadow stays between the
  // groves and around the POIs / trails / the highlands vista)
  { kind: "jungle-tree", spacing: 9.5, biome: { [G]: 1 }, minGap: 6.5, maxSlope: 0.8, minY: 2, clump: [1 / 85, 0.27], clumpKey: 71, scale: [0.8, 1.15], padMargin: 8, pathMargin: 3, variants: [0, 1, 3, 4, 2], vistaFree: true },
  { kind: "palm", spacing: 8.5, biome: { [G]: 0.85 }, minGap: 5, maxSlope: 0.7, minY: 2, clump: [1 / 85, 0.26], clumpKey: 71, scale: [1.25, 1.75], padMargin: 6, pathMargin: 3, variants: [0, 1], vistaFree: true },
  { kind: "jungle-tree", spacing: 10, biome: { [G]: 1 }, minGap: 7, maxSlope: 0.8, minY: 2, clump: [1 / 40, 0.24], scale: [0.8, 1.1], padMargin: 8, pathMargin: 3, variants: [0, 1, 4, 3], edge: { biome: J, r: 50 }, vistaFree: true },
  // beach palms: crossing pairs / trios rooted along the TOP of the sand (≤ 16 m from the treeline — terrain keeps ~60 %
  // of the beach width open) leaning out over the sand toward the sea; a sparse second row a little further down
  { kind: "palm-leaning", spacing: 17, biome: { [B]: 1 }, minGap: 7, maxSlope: 0.6, minY: 0.55, maxY: 6, clump: [1 / 70, 0.1], scale: [0.95, 1.2], seaward: true, padMargin: 4, pathMargin: 2.5, edge: { biome: [J, G, R], r: 14 }, group: { n: [2, 3], r: [2.2, 3.6], gap: 1.6, upright: 0.2 } },
  { kind: "palm-leaning", spacing: 34, biome: { [B]: 1 }, minGap: 9, maxSlope: 0.6, minY: 0.55, maxY: 6, scale: [0.9, 1.1], seaward: true, padMargin: 4, pathMargin: 2.5, edge: { biome: [J, G, R], r: 24 } },
  // palm fringe: 1–2 rows of tall coconut palms along the land side of every beach — the target art's palm-lined coasts
  // (not a hard broadleaf wall where the forest meets the sand, nor a wall of same-size palms: scale 0.75–1.5, and the
  // fringe clumps into stands with gaps — Tinter gives a third of the palms an older, deeper crown)
  { kind: "palm", spacing: 8, biome: { [J]: 1, [G]: 1, [R]: 0.5 }, minGap: 4.5, maxSlope: 0.75, minY: 0.8, maxY: 22, clump: [1 / 45, 0.2], scale: [0.75, 1.5], padMargin: 5, pathMargin: 2.5, variants: [0, 1], edge: { biome: B, r: 12 } },
  { kind: "palm-leaning", spacing: 14, biome: { [J]: 1, [G]: 1 }, minGap: 5, maxSlope: 0.75, minY: 0.8, maxY: 16, scale: [0.75, 1.3], seaward: true, padMargin: 5, pathMargin: 2.5, edge: { biome: B, r: 7 } },
  { kind: "palm", spacing: 26, biome: { [F]: 0.3 }, minGap: 6, maxSlope: 0.6, minY: 0.8, maxY: 8, scale: [0.9, 1.2], padMargin: 4, pathMargin: 2.5, variants: [0, 1] },
  { kind: "palm", spacing: 22, biome: { [G]: 0.4 }, minGap: 25, maxSlope: 0.55, minY: 2, clump: [1 / 90, 0.3], scale: [0.95, 1.2], padMargin: 5, pathMargin: 3, variants: [2, 2, 0] },
  { kind: "palm", spacing: 30, biome: { [C]: 0.25, [R]: 0.12 }, minGap: 14, maxSlope: 0.6, minY: 1, scale: [0.85, 1.1], padMargin: 4, variants: [2] },
  { kind: "mangrove", spacing: 7.5, biome: { [L]: 1, [J]: 0.02 }, minGap: 3.2, maxSlope: 2, minY: -1.6, maxY: 0.9, clump: [1 / 30, 0.14], scale: [0.7, 1.35] },
  { kind: "bamboo", spacing: 17, biome: { [J]: 1, [G]: 0.12 }, minGap: 3.5, maxSlope: 0.6, minY: 2, clump: [1 / 45, 0.38], scale: [0.85, 1.2], padMargin: 3, pathMargin: 3.5, design: "thicket" },
  // (logs lie only inside the jungle, well off the trails (8 m keep-out), plus the glades' own: collidable logs along
  // the trail verges snag players and clutter the rotations)
  { kind: "log", spacing: 40, biome: { [J]: 1 }, minGap: 3.2, maxSlope: 0.35, minY: 1.2, scale: [0.8, 1.2], padMargin: 4, pathMargin: 8 },
  // ---- DECORATIVE
  // (no scattered "vine" rule: vines dropped on a grid end up in open air with no crown to hang from. Vines come only
  // from anchoredVines(): strung between two real jungle-tree crowns inside the deep-jungle stands.)
  { kind: "banana-plant", spacing: 11.5, biome: { [J]: 1, [G]: 0.05 }, minGap: 2.2, maxSlope: 0.7, minY: 1, clump: [1 / 40, 0.3], scale: [0.85, 1.2], padMargin: 3, pathMargin: 1.8, design: "floor" },
  // (no isolated bushes out on the open sand — the beach's bushes are the treeline band below, ≤ 5 m from it)
  { kind: "bush", spacing: 7, biome: { [J]: 0.75, [C]: 0.045 }, minGap: 1.8, maxSlope: 0.9, minY: 0.8, clump: [1 / 35, 0.28], scale: [0.35, 0.55], padMargin: 2, design: "floor" },   // (jungle shrubs stay under eye height — the lanes read; bananas carry the mid-storey walls)
  { kind: "bush", spacing: 6, biome: { [G]: 0.3, [R]: 0.26 }, minGap: 1.6, maxSlope: 1.1, minY: 0.8, scale: [0.6, 1.2], padMargin: 2, nearRock: 2.4 },
  { kind: "bush", spacing: 28, biome: { [G]: 0.2 }, minGap: 3, maxSlope: 0.9, minY: 0.8, clump: [1 / 50, 0.42], scale: [0.6, 1.1], padMargin: 2 },
  { kind: "monstera", spacing: 7, biome: { [J]: 1, [G]: 0.05 }, minGap: 1.6, maxSlope: 0.8, minY: 0.9, clump: [1 / 30, 0.3], scale: [0.42, 0.65], padMargin: 2, pathMargin: 2.5, design: "floor" },
  // (sparse beach bands — open sand, the palms are the heroes)
  // beach treeline band: banana / monstera / bushes along the land side of the sand edge + the top of the sand right
  // under the treeline (the target art's lush beach edge) — never down on the open sand
  // (the land-side band grows in clumps, not a hedge of identical saplings — bananas in
  // groves of 3–6 with bushes / monstera between, gaps where the jungle floor shows)
  { kind: "banana-plant", spacing: 4.8, biome: { [J]: 1, [G]: 1 }, minGap: 2, maxSlope: 0.9, minY: 1.4, maxY: 14, clump: [1 / 30, 0.55], clumpKey: 84, scale: [0.7, 1.3], padMargin: 3, edge: { biome: B, r: 9 } },
  { kind: "monstera", spacing: 5.2, biome: { [J]: 1, [G]: 1 }, minGap: 1.4, maxSlope: 0.9, minY: 1.3, maxY: 14, clump: [1 / 20, 0.2], scale: [0.85, 1.35], padMargin: 2, edge: { biome: B, r: 8 } },
  { kind: "bush", spacing: 4.4, biome: { [J]: 1, [G]: 1 }, minGap: 1.5, maxSlope: 0.9, minY: 1.3, maxY: 14, clump: [1 / 25, 0.2], scale: [0.7, 1.4], padMargin: 2, edge: { biome: B, r: 7 } },
  // (the band on the sand grows in
  // 2–3 clumps per 100 m (shared clump field, strong threshold, denser inside a clump), open sand between them)
  { kind: "banana-plant", spacing: 4.2, biome: { [B]: 1 }, minGap: 2, maxSlope: 0.9, minY: 1.2, maxY: 14, clump: [1 / 34, 0.52], clumpKey: 83, scale: [0.7, 1.25], padMargin: 3, edge: { biome: [J, G], r: 6 } },
  { kind: "monstera", spacing: 4.0, biome: { [B]: 1 }, minGap: 1.4, maxSlope: 0.9, minY: 1.2, maxY: 14, clump: [1 / 34, 0.5], clumpKey: 83, scale: [0.8, 1.3], padMargin: 2, edge: { biome: [J, G], r: 5 } },
  { kind: "bush", spacing: 4.4, biome: { [B]: 1 }, minGap: 1.5, maxSlope: 0.9, minY: 1.2, maxY: 14, clump: [1 / 34, 0.5], clumpKey: 83, scale: [0.7, 1.2], padMargin: 2, edge: { biome: [J, G], r: 5 } },
  { kind: "flowers", spacing: 3.6, biome: { [B]: 1 }, minGap: 1.2, maxSlope: 0.9, minY: 1.2, maxY: 14, clump: [1 / 34, 0.5], clumpKey: 83, scale: [0.9, 1.3], padMargin: 2, variants: [1], edge: { biome: [J, G], r: 7 } },
  // (the 1.4–2 m heliconia clumps are big-scatter plants with an understory impostor: in the detail ring they would
  // shrink out at 38 m in full view)
  { kind: "flowers", spacing: 6, biome: { [J]: 1, [G]: 1, [B]: 0.15 }, minGap: 1.2, padMargin: 2, maxSlope: 0.9, minY: 1.6, maxY: 14, clump: [1 / 14, 0.34], scale: [0.9, 1.3], variants: [1], edge: { biome: B, r: 7 } },
];

export const DETAIL_RULES: Rule[] = [
  // meadow (Grass biome): small soft blade tufts at 0.5 m over the terrain's painted lawn (variants 0 plain / 1 with tiny
  // daisies) — no carpet squares / long strips (their edges draw a tile web over the lawn)
  // (3 cards per near tuft: dense blade tufts with light warm tips within 15 m; the thinning from 18 m keeps the far
  // meadow cheap)
  // (the meadow trails stay clean dirt with a lawn edge — the jungle rule's 1.9 m overgrown band would scatter tufts
  // over the whole narrow highland trail)
  { kind: "grass", spacing: 0.42, biome: { [G]: 1 }, maxSlope: 1.1, minY: 0.6, scale: [0.75, 1.35], detail: true, variants: [0, 0, 0, 1], trail: { max: 0.35, band: 0.45 } },
  { kind: "grass", spacing: 1.15, biome: { [J]: 0.45, [C]: 0.15, [R]: 0.12, [F]: 0.3 }, maxSlope: 1.1, minY: 0.6, scale: [0.65, 0.95], detail: true, badlandsMax: 0.3, variants: [2, 3] },
  { kind: "grass", spacing: 2.4, biome: { [B]: 1 }, maxSlope: 1.1, minY: 1.4, scale: [0.7, 1.1], detail: true, edge: { biome: G, r: 6 }, variants: [2, 3] },
  // daisies / buttercups dotted through the lawn in loose drifts
  { kind: "flowers", spacing: 0.8, biome: { [G]: 1 }, maxSlope: 0.9, minY: 0.8, clump: [1 / 12, 0.3], scale: [0.4, 0.75], detail: true, variants: [2], trail: { max: 0.3, band: 0 } },
  { kind: "flowers", spacing: 3.8, biome: { [J]: 1, [G]: 0.12 }, maxSlope: 0.9, minY: 0.8, clump: [1 / 14, 0.38], scale: [0.85, 1.25], detail: true, variants: [0] },
  { kind: "fern", spacing: 2.2, biome: { [J]: 1, [G]: 0.2, [B]: 0.05 }, maxSlope: 0.9, minY: 0.9, clump: [1 / 18, 0.25], scale: [0.35, 0.58], detail: true },   // (≤ 0.95 m: a small plant — it may fade by scale)
  // (no moss / litter mats — flat-shaded slabs read as faceted dark-green plates on the dirt; the leafy ground cover
  // below + ferns carry the floor layer)
  // jungle floor: PATCHES of ground cover with leaf litter / dirt between them, not an even carpet of identical rosettes
  // (ferns carry the gaps), and a calm knee-low layer of short green moss / lawn tufts in soft patches (0.35 m: under
  // every sightline) carries the floor between them — a lit green forest floor
  { kind: "groundcover", spacing: 2.0, biome: { [J]: 1, [G]: 0.05 }, maxSlope: 1.0, minY: 0.9, clump: [1 / 15, 0.3], scale: [1.2, 1.8], detail: true, variants: [0, 1] },
  { kind: "grass", spacing: 0.62, biome: { [J]: 1 }, maxSlope: 1.0, minY: 0.9, clump: [1 / 11, 0.36], clumpKey: 61, scale: [0.8, 1.3], detail: true, variants: [0, 1], trail: { max: 0.4, band: 1.2 } },
  // dune creeper on the upper sand (instead of meadow grass tufts dotted on the beach)
  { kind: "groundcover", spacing: 3.2, biome: { [B]: 1 }, maxSlope: 0.8, minY: 1.0, clump: [1 / 16, 0.3], scale: [0.9, 1.6], detail: true, variants: [2], edge: { biome: [J, G], r: 10 } },
];

// =====================================================================================================================

const hash2 = (x: number, z: number, k: number) => {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(z | 0, 668265263) + Math.imul(k | 0, 2246822519)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
};

/** clearings on a 16 m grid (~950 clearings: too many to test linearly for every scatter candidate) */
const CLEAR_GRID = new WeakMap<Clearing[], Map<number, Clearing[]>>();
function clearGrid(cl: Clearing[]): Map<number, Clearing[]> {
  let g = CLEAR_GRID.get(cl);
  if (g) return g;
  g = new Map();
  for (const c of cl) {
    const r = "r" in c ? c.r : dmath.hypot(c.hx, c.hz);
    for (let gx = Math.floor((c.x - r) / 16); gx <= Math.floor((c.x + r) / 16); gx++)
      for (let gz = Math.floor((c.z - r) / 16); gz <= Math.floor((c.z + r) / 16); gz++) {
        const k = (gx + 4096) * 8192 + gz + 4096;
        let a = g.get(k); if (!a) g.set(k, (a = [])); a.push(c);
      }
  }
  CLEAR_GRID.set(cl, g);
  return g;
}
export function inClearing(x: number, z: number, all: Clearing[]): boolean {
  const cl = clearGrid(all).get((Math.floor(x / 16) + 4096) * 8192 + Math.floor(z / 16) + 4096);
  if (!cl) return false;
  for (const c of cl) {
    if ("r" in c) { if (dmath.pow(x - c.x, 2) + dmath.pow(z - c.z, 2) < c.r * c.r) return true; }
    else {
      const cy = dmath.cos(c.yaw ?? 0), sy = dmath.sin(c.yaw ?? 0);
      const lx = (x - c.x) * cy + (z - c.z) * sy, lz = -(x - c.x) * sy + (z - c.z) * cy;
      if (Math.abs(lx) < c.hx && Math.abs(lz) < c.hz) return true;
    }
  }
  return false;
}

const PADS: Poi[] = POIS.filter((p) => p.padY !== null);
function nearPad(x: number, z: number, margin: number): boolean {
  for (const p of PADS) if (dmath.hypot(x - p.x, z - p.z) < p.pad + margin) return true;
  return false;
}

const RING8: Array<[number, number]> = Array.from({ length: 8 }, (_, i) => [dmath.cos((i / 8) * Math.PI * 2), dmath.sin((i / 8) * Math.PI * 2)]);

const isBlockedBiome = (b: Biome) => b === Biome.Path || b === Biome.Paved || b === Biome.DeepOcean || b === Biome.Reef;
/** true when (x,z) or any of 8 samples on the ring of radius m (and m/2) is a path / paved / water biome */
function nearBlocked(t: Terrain, x: number, z: number, m: number): boolean {
  if (isBlockedBiome(t.biomeAt(x, z))) return true;
  for (const [dx, dz] of RING8) {
    if (isBlockedBiome(t.biomeAt(x + dx * m, z + dz * m))) return true;
    if (m > 2.5 && isBlockedBiome(t.biomeAt(x + dx * m * 0.5, z + dz * m * 0.5))) return true;
  }
  return false;
}

function nearBiome(t: Terrain, x: number, z: number, b: Biome | Biome[], r: number): boolean {
  for (const [dx, dz] of RING8) for (const k of [0.5, 1]) {
    const q = t.biomeAt(x + dx * r * k, z + dz * r * k);
    if (Array.isArray(b) ? b.includes(q) : q === b) return true;
  }
  return false;
}

class GapGrid {
  private cells = new Map<number, number[]>();
  constructor(private cell = 8) {}
  private key(x: number, z: number) { return (Math.floor(x / this.cell) + 4096) * 8192 + (Math.floor(z / this.cell) + 4096); }
  add(x: number, z: number) { const k = this.key(x, z); let a = this.cells.get(k); if (!a) { a = []; this.cells.set(k, a); } a.push(x, z); }
  tooClose(x: number, z: number, gap: number): boolean {
    const g2 = gap * gap, n = Math.ceil(gap / this.cell);
    for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) {
      const a = this.cells.get(this.key(x + i * this.cell, z + j * this.cell));
      if (!a) continue;
      for (let k = 0; k < a.length; k += 2) if (dmath.pow(a[k] - x, 2) + dmath.pow(a[k + 1] - z, 2) < g2) return true;
    }
    return false;
  }
}

/** spatial hash over terrain rocks: footprint circle + vertical extent */
export class RockIndex {
  private cells = new Map<number, RockInstance[]>();
  private readonly C = 16;
  constructor(readonly list: RockInstance[]) {
    const rocks = list;
    for (const r of rocks) {
      const rad = Math.max(r.sx, r.sz) * 0.5;
      for (let gx = Math.floor((r.x - rad) / this.C); gx <= Math.floor((r.x + rad) / this.C); gx++)
        for (let gz = Math.floor((r.z - rad) / this.C); gz <= Math.floor((r.z + rad) / this.C); gz++) {
          const k = (gx + 4096) * 8192 + gz + 4096;
          let a = this.cells.get(k); if (!a) { a = []; this.cells.set(k, a); } a.push(r);
        }
    }
  }
  /** distance (m) from (x,z) to the nearest rock footprint edge within `r` (negative = inside), or Infinity */
  near(x: number, z: number, r: number, y?: number): number {
    let best = Infinity;
    for (let gx = Math.floor((x - r) / this.C); gx <= Math.floor((x + r) / this.C); gx++)
      for (let gz = Math.floor((z - r) / this.C); gz <= Math.floor((z + r) / this.C); gz++) {
        const a = this.cells.get((gx + 4096) * 8192 + gz + 4096); if (!a) continue;
        for (const k of a) {
          if (y !== undefined && (y > k.y + k.sy * (k.kind === "stack" ? 1 : 0.55) || y < k.y - k.sy * 0.5 - 1)) continue;
          const d = dmath.hypot(x - k.x, z - k.z) - Math.max(k.sx, k.sz) * 0.42;
          if (d < best) best = d;
        }
      }
    return best;
  }
}

/**
 * POI collider volumes (buildings, terraces, containers, walls …, allColliders()) in a 16 m grid: no plant may stand
 * inside one. Pure data → identical on the server, the
 * client and the detail worker.
 */
export class BoxIndex {
  private cells = new Map<number, number[]>();
  private readonly C = 16;
  private cx: Float32Array; private cy: Float32Array; private cz: Float32Array;
  private hx: Float32Array; private hy: Float32Array; private hz: Float32Array;
  private co: Float32Array; private si: Float32Array;
  constructor(boxes: Box[]) {
    const n = boxes.length;
    this.cx = new Float32Array(n); this.cy = new Float32Array(n); this.cz = new Float32Array(n);
    this.hx = new Float32Array(n); this.hy = new Float32Array(n); this.hz = new Float32Array(n);
    this.co = new Float32Array(n); this.si = new Float32Array(n);
    boxes.forEach((b, i) => {
      const yaw = b.yaw ?? 0, c = dmath.cos(yaw), s = dmath.sin(yaw);
      this.cx[i] = b.c[0]; this.cy[i] = b.c[1]; this.cz[i] = b.c[2];
      this.hx[i] = b.h[0]; this.hy[i] = b.h[1] + (b.pitch ? Math.abs(dmath.sin(b.pitch)) * b.h[2] : 0); this.hz[i] = b.h[2];
      this.co[i] = c; this.si[i] = s;
      const ex = Math.abs(c) * b.h[0] + Math.abs(s) * b.h[2], ez = Math.abs(s) * b.h[0] + Math.abs(c) * b.h[2];
      for (let gx = Math.floor((b.c[0] - ex) / this.C); gx <= Math.floor((b.c[0] + ex) / this.C); gx++)
        for (let gz = Math.floor((b.c[2] - ez) / this.C); gz <= Math.floor((b.c[2] + ez) / this.C); gz++) {
          const k = (gx + 4096) * 8192 + gz + 4096;
          let a = this.cells.get(k); if (!a) { a = []; this.cells.set(k, a); } a.push(i);
        }
    });
  }
  /** does a horizontal disc of `radius` at (x, z) overlap a box's oriented x/z footprint? (every touched grid cell) */
  footprintHits(x: number, z: number, radius: number): boolean {
    for(let gx=Math.floor((x-radius)/this.C);gx<=Math.floor((x+radius)/this.C);gx++)
      for(let gz=Math.floor((z-radius)/this.C);gz<=Math.floor((z+radius)/this.C);gz++) {
        const cells=this.cells.get((gx+4096)*8192+gz+4096);
        if(!cells) continue;
        for(const i of cells) {
          const dx=x-this.cx[i],dz=z-this.cz[i],c=this.co[i],s=this.si[i];
          const outsideX=Math.max(0,Math.abs(dx*c+dz*s)-this.hx[i]);
          const outsideZ=Math.max(0,Math.abs(-dx*s+dz*c)-this.hz[i]);
          if(outsideX*outsideX+outsideZ*outsideZ<radius*radius) return true;
        }
      }
    return false;
  }
  /** does a vertical segment [y0, y1] of radius r at (x, z) enter a box? (r < 0 = only well inside) */
  hits(x: number, y0: number, y1: number, z: number, r: number): boolean {
    const a = this.cells.get((Math.floor(x / this.C) + 4096) * 8192 + Math.floor(z / this.C) + 4096);
    if (a) for (const i of a) {
      if (y1 < this.cy[i] - this.hy[i] || y0 > this.cy[i] + this.hy[i]) continue;
      const dx = x - this.cx[i], dz = z - this.cz[i], c = this.co[i], s = this.si[i], ex = this.hx[i] + r, ez = this.hz[i] + r;
      // both yaw senses: the sim's (above) and three.js makeRotationY's (lx = dx·cos − dz·sin) — some POI visuals are
      // built with the latter, and a plant must be clear of the box that is DRAWN as well as the one that collides
      if (Math.abs(dx * c + dz * s) < ex && Math.abs(-dx * s + dz * c) < ez) return true;
      if (s !== 0 && Math.abs(dx * c - dz * s) < ex && Math.abs(dx * s + dz * c) < ez) return true;
    }
    return false;
  }
}
let POI_INDEX: BoxIndex | null = null;
let ROOF_INDEX: BoxIndex | null = null;
function roofIndex(): BoxIndex {
  // Horizontal authored slabs above ground: roof/deck outlines are their actual oriented rectangles, not POI radii.
  if (!ROOF_INDEX) ROOF_INDEX = new BoxIndex(allColliders().filter(b => b.h[1] <= 1.5 && b.h[0] >= 2 && b.h[2] >= 2 && b.c[1] > 4));
  return ROOF_INDEX;
}
function poiIndex(): BoxIndex {
  if (!POI_INDEX) { let b: Box[] = []; try { b = allColliders(); } catch (e) { console.warn("veg: POI colliders unavailable", e); } POI_INDEX = new BoxIndex(b); }
  return POI_INDEX;
}
/** a plant (base at x, y, z) that would grow inside a POI volume: trunks are tested up to 4.5 m (leaning palms along
 * their curve), decorative plants up to 1 m, detail (grass …) only at the root */
function inPoiVolume(kind: VegKind, variant: number, x: number, y: number, z: number, yaw: number, scale: number, detail: boolean): boolean {
  const P = poiIndex();
  if (detail) return P.hits(x, y + 0.1, y + 0.3, z, -0.05);
  if (!COLLIDABLE.has(kind)) return P.hits(x, y + 0.15, y + 1.0, z, 0.05);
  if (kind === "palm" || kind === "palm-leaning") {
    const s = palmShape(variant % 3, kind === "palm-leaning"), c = dmath.cos(yaw), sn = dmath.sin(yaw);
    for (const [mx, my, mz] of s.pts) {
      if (my < 0 || my > 6) continue;
      const wx = x + (mx * c + mz * sn) * scale, wz = z + (-mx * sn + mz * c) * scale, wy = y + my * scale;
      if (P.hits(wx, wy, wy + 0.5, wz, 0.3 * scale)) return true;
    }
    return false;
  }
  const r = kind === "jungle-tree" ? 0.55 : kind === "log" ? 0.5 : kind === "bamboo" ? 0.7 : 0.3;
  return P.hits(x, y + 0.15, y + (kind === "log" ? 0.8 : 4.5), z, r * scale);
}

// ---------------------------------------------------------------------------------------------------------------------
// plant seating: every scattered plant is SEATED on its footprint and rejected where it would read wrong. Shared by
// the client scatter, the detail worker and the server's trunk replay.
/** per kind: footprint radius (m), how far the model's base may sit above the lowest ground under it (the trunk / stem
 * sinks below its origin that much), footprint scales with the plant */
const SEAT: Partial<Record<VegKind, [number, number, boolean]>> = {
  "jungle-tree": [1.4, 0.7, true], mangrove: [0.5, 1.4, false], palm: [0.35, 0.3, false], "palm-leaning": [0.35, 0.3, false], bamboo: [0.8, 0.25, true],
  log: [0.45, 0.2, false], bush: [0.5, 0.1, true], "banana-plant": [0.3, 0.1, false], monstera: [0.4, 0.08, true],
  litter: [0.3, 0.06, false], vine: [0.2, 0.5, false], fern: [0.3, 0.06, true], flowers: [0.2, 0.05, false], grass: [0.15, 0.05, false], groundcover: [0.35, 0.05, true],
};
/** max slope (rise / run, ±1.5 m) a kind may stand on — every placement path (rules, hero slots, hand-placed, dressing)
 *  goes through seatPlant, which applies it */
export const MAX_SLOPE: Partial<Record<VegKind, number>> = {
  "jungle-tree": 0.8, palm: 0.8, "palm-leaning": 0.8, mangrove: 0.8, bamboo: 0.8, log: 0.7, bush: 0.8, "banana-plant": 0.8,
  monstera: 0.8, vine: 1.2, litter: 0.6, fern: 1.2, flowers: 1.2, grass: 1.2, groundcover: 1.2,
};
/** every big plant: ≤ 0.8 rise / run (38.7°) measured at ±1.5 m AND at ±2 m (the terrain normal's stencil), at the
 * base and under its footprint — no tree, palm or shrub on a cliff face */
const BIG_SLOPE = new Set<VegKind>(["jungle-tree", "palm", "palm-leaning", "mangrove", "bamboo", "bush", "banana-plant", "monstera"]);
function steepUnder(t: Terrain, kind: VegKind, x: number, z: number, r: number): boolean {
  const ms = MAX_SLOPE[kind]; if (ms === undefined) return false;
  if (slopeAt(t, x, z) > ms) return true;
  if (!BIG_SLOPE.has(kind)) return false;
  const e = 2, n = (px: number, pz: number) => dmath.hypot(t.height(px + e, pz) - t.height(px - e, pz), t.height(px, pz + e) - t.height(px, pz - e)) / (2 * e);
  if (n(x, z) > ms) return true;
  for (let k = 0; k < 4; k++) { const a = k * 1.5707963 + 0.39; if (n(x + dmath.cos(a) * r, z + dmath.sin(a) * r) > ms + 0.08) return true; }
  return false;
}
/** footprint radius and base sink allowance of a plant (seatPlant) */
export function seatFoot(kind: VegKind, scale: number): [number, number] | null {
  const f = SEAT[kind]; return f ? [f[0] * (f[2] ? scale : 1), f[1]] : null;
}
const ROCK_BOXES = new WeakMap<RockIndex, BoxIndex>();
function rockBoxes(ri?: RockIndex): BoxIndex | null {
  if (!ri) return null;
  let b = ROCK_BOXES.get(ri);
  if (!b) { b = new BoxIndex(terrainRockColliders(ri.list)); ROCK_BOXES.set(ri, b); }
  return b;
}
/**
 * The plant's seated base height, or null when the spot reads wrong: the base is lowered until no part of its footprint
 * hangs in the air (slopes, lips); rejected when it would stand in a hole, inside a terrain rock or a POI volume (trunk /
 * root boxes for trees), under a roof / deck / overhang, or when a crown would hang at eye level over the ground under
 * it or grow through a POI box or a rock.
 */
export function seatPlant(t: Terrain, kind: VegKind, variant: number, x: number, z: number, yaw: number, scale: number, detail: boolean, ri?: RockIndex): number | null {
  const f = SEAT[kind];
  let y = t.height(x, z);
  const footprint = crownFootprint(kind,variant);
  if (footprint) {
    const c = dmath.cos(yaw), s = dmath.sin(yaw);
    const cx = x + (footprint.x*c+footprint.z*s)*scale, cz = z + (-footprint.x*s+footprint.z*c)*scale;
    const radius = footprint.r*scale;
    if (roofIndex().footprintHits(cx,cz,radius+1.5) || crownOverAuthoredLane(cx,cz,radius)) return null;
  }
  if (!f) return y;
  const r = f[0] * (f[2] ? scale : 1);
  let lo = y, hi = y;
  for (let k = 0; k < 8; k++) { const a = k * 0.7853981633974483, h = t.height(x + dmath.cos(a) * r, z + dmath.sin(a) * r); if (h < lo) lo = h; if (h > hi) hi = h; }
  if (y - lo > f[1]) y = lo + f[1];
  if (kind === "jungle-tree") y = Math.min(y, rootSeatY(t, variant, x, z, yaw, scale));   // no root in the air
  const col = COLLIDABLE.has(kind);
  if (!col && hi - y > r + 0.3) return null;                                   // in a pit / against a bank
  if (steepUnder(t, kind, x, z, r)) return null;
  // drawn inland water / drawn POI or rock surfaces over the base (the spawn mask)
  if (maskRejects(t, kind, x, y, z, r, col ? 10 : 6)) return null;
  const P = poiIndex(), R = rockBoxes(ri);
  if (col) {
    for (const b of vegTrunkColliders([{ kind, variant, x, y, z, yaw, scale }])) {
      const rr = dmath.hypot(b.h[0], b.h[2]) * 0.8, y0 = b.c[1] - b.h[1] + 0.1, y1 = b.c[1] + b.h[1];
      if (P.hits(b.c[0], y0, y1, b.c[2], rr)) return null;
      if (R && R.hits(b.c[0], y0 + 0.15, y1, b.c[2], rr * 0.75)) return null;
    }
  } else {
    const h = detail ? 0.3 : 0.8;
    if (P.hits(x, y + 0.1, y + h, z, detail ? 0 : 0.1)) return null;
    if (R && R.hits(x, y + 0.15, y + h, z, detail ? -0.2 : 0.1)) return null;
  }
  // covered: a roof / deck / overhang right above (interiors, stilt huts, boulder overhangs)
  if (P.hits(x, y + 0.9, y + (col ? 12 : 3), z, 0)) return null;
  if (!col && R && R.hits(x, y + 0.9, y + 3, z, 0)) return null;
  // crowns: never at eye level over the ground under them, never through a POI box or a rock
  const cw = crownCheck(t, kind, variant, x, y, z, yaw, scale, ri);
  if (cw && (cw.low || cw.poi || cw.rock)) return null;
  return y;
}
/** a crown's clearance over the highest ground under it + whether it grows through a POI box / a rock (null: no crown) */
export function crownCheck(t: Terrain, kind: VegKind, variant: number, x: number, y: number, z: number, yaw: number, scale: number, ri?: RockIndex): { clear: number; low: boolean; poi: boolean; rock: boolean } | null {
  const fp = crownFootprint(kind, variant), band = crownBand(kind, variant);
  if (!fp || !band) return null;
  const P = poiIndex(), R = rockBoxes(ri);
  const c = dmath.cos(yaw), sn = dmath.sin(yaw);
  const cx = x + (fp.x * c + fp.z * sn) * scale, cz = z + (-fp.x * sn + fp.z * c) * scale, cr = fp.r * scale * 0.8;
  const bottom = y + band[0] * scale, top = y + band[1] * scale;
  let gmax = t.height(cx, cz);
  for (const k of [0.25, 0.55, 0.85]) for (let q = 0; q < 8; q++) { const a = q * 0.7853981633974483 + k; gmax = Math.max(gmax, t.height(cx + dmath.cos(a) * cr * k, cz + dmath.sin(a) * cr * k)); }
  const mid = (bottom + top) / 2, hh = (top - bottom) / 2;
  return {
    clear: bottom - gmax,
    // (mangroves: a low skirt over the lagoon water / mud is their look — only their POI / rock checks apply)
    low: kind !== "mangrove" && bottom - gmax < CROWN_CLEAR,
    poi: P.hits(cx, mid - hh * 0.6, mid + hh * 0.6, cz, cr * 0.7),
    rock: !!R && R.hits(cx, mid - hh * 0.6, mid + hh * 0.6, cz, cr * 0.6),
  };
}
/** a crown's lowest leaves stay this far above the highest ground under it (a kong is 1.8 m; room to see under) */
export const CROWN_CLEAR = 3.2;

// ---------------------------------------------------------------------------------------------------------------------
// The SPAWN MASK (no plant under drawn inland water or under a drawn POI / cliff / rock surface): what is DRAWN,
// baked from the live client by an offline tool into public/assets/veg/spawn-mask.bin (gzip). Per 0.5 m cell
// (conservative): the highest drawn inland water surface and the lowest drawn opaque POI / rock surface ≥ 0.3 m over
// the ground, as absolute heights. seatPlant rejects a plant under either. Every consumer loads the SAME file before
// it scatters — the client scatter worker and detail worker (bytes passed by the main thread), the static world
// (shared/sim/veg-colliders.ts → loadSpawnMask, server + client) and the tools — so the server's trunk boxes stay
// exactly the drawn trunks. No file → no mask (warned; client and server then still agree).
/** content id of public/assets/veg/spawn-mask.bin — WRITTEN BY the mask bake on every run: editing this file
 *  restarts `tsx watch` game servers (they load the new mask with it — the static-world hash stays equal to the
 *  clients'), and it cache-busts the client's fetch */
export const SPAWN_MASK_ID = "9884996f";
interface SpawnMask { tile: number; cell: number; water: Map<number, Uint16Array>; cover: Map<number, Uint16Array>; top: Map<number, Uint16Array> }
let MASK: SpawnMask | null = null, MASK_RAW: ArrayBuffer | null = null, MASK_JOB: Promise<boolean> | null = null;
const maskKey = (tx: number, tz: number) => (tx + 32768) * 65536 + (tz + 32768);
/** install the (decompressed) mask bytes; null clears it */
export function setSpawnMask(raw: ArrayBuffer | null): boolean {
  MASK = null; MASK_RAW = null;
  if (!raw || raw.byteLength < 16) return false;
  const dv = new DataView(raw);
  if (dv.getUint32(0, true) !== 0x4d56524b /* "KRVM" */) { console.warn("veg: spawn mask has a bad header"); return false; }
  if (dv.getUint32(4, true) !== 4) { console.warn("veg: spawn mask version ≠ 4 — re-bake the spawn mask"); return false; }
  const cell = dv.getUint32(8, true) / 1000, tile = dv.getUint32(12, true), n2 = tile * tile, m: SpawnMask = { tile, cell, water: new Map(), cover: new Map(), top: new Map() };
  let o = 16;
  for (const layer of [m.water, m.cover, m.top]) {
    const n = dv.getUint32(o, true); o += 4;
    for (let i = 0; i < n; i++) {
      const tx = dv.getInt16(o, true), tz = dv.getInt16(o + 2, true); o += 4;
      const a = new Uint16Array(n2);                     // rows are delta-coded (mod 65536)
      for (let r = 0; r < tile; r++) { let v = 0; for (let k = 0; k < tile; k++) { v = (v + dv.getUint16(o + (r * tile + k) * 2, true)) & 0xffff; a[r * tile + k] = v; } }
      layer.set(maskKey(tx, tz), a); o += n2 * 2;
    }
  }
  MASK = m; MASK_RAW = raw;
  return true;
}
/** the decompressed mask bytes in effect (the client hands them to its workers) */
export function spawnMaskBytes(): ArrayBuffer | null { return MASK_RAW; }
async function gunzip(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const u = new Uint8Array(buf);
  if (u[0] !== 0x1f || u[1] !== 0x8b) return buf;
  const DS = (globalThis as unknown as { DecompressionStream?: new (f: string) => TransformStream<Uint8Array, Uint8Array> }).DecompressionStream;
  if (DS && typeof Response !== "undefined") return new Response(new Blob([u]).stream().pipeThrough(new DS("gzip"))).arrayBuffer();
  const zlib = await import(/* @vite-ignore */ ["node", "zlib"].join(":")) as { gunzipSync(b: Uint8Array): Uint8Array };
  const out = zlib.gunzipSync(u); return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}
/** load public/assets/veg/spawn-mask.bin once (browser / worker: fetch; Node: the file next to the repo) */
export function loadSpawnMask(): Promise<boolean> {
  if (MASK) return Promise.resolve(true);
  if (!MASK_JOB) MASK_JOB = (async () => {
    try {
      const g = globalThis as unknown as { process?: { versions?: { node?: string } }; window?: unknown; importScripts?: unknown; location?: unknown };
      let buf: ArrayBuffer;
      if (typeof g.process?.versions?.node === "string" && !g.window && !g.importScripts && !g.location) {
        const fs = await import(/* @vite-ignore */ ["node", "fs"].join(":")) as { readFileSync(p: URL): Uint8Array };
        const b = fs.readFileSync(new URL("../../public/assets/veg/spawn-mask.bin", import.meta.url));
        buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
      } else {
        const base = ((import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/").replace(/\/?$/, "/");
        const r = await fetch(`${base}assets/veg/spawn-mask.bin?v=${SPAWN_MASK_ID}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        buf = await r.arrayBuffer();
      }
      return setSpawnMask(await gunzip(buf));
    } catch (e) { console.warn("veg: spawn mask unavailable — plants are not tested against drawn water / cover", e); return false; }
  })();
  return MASK_JOB;
}
/** at (x, z): [the highest drawn inland water surface, the lowest drawn opaque POI / rock surface ≥ 0.3 m over the
 *  ground, the highest such surface where the cell is layered] as world heights (NaN = none), over the cell
 *  (conservative) — null: no mask loaded */
export function spawnMaskAt(t: Terrain, x: number, z: number): [number, number, number] | null {
  if (!MASK) return null;
  const T = MASK.tile, C = MASK.cell, ix = Math.floor(x / C), iz = Math.floor(z / C), tx = Math.floor(ix / T), tz = Math.floor(iz / T), k = maskKey(tx, tz);
  const i = (iz - tz * T) * T + (ix - tx * T);
  const w = MASK.water.get(k)?.[i] ?? 0, c = MASK.cover.get(k)?.[i] ?? 0, tp = MASK.top.get(k)?.[i] ?? 0;
  void t;   // (absolute heights since v3: a terrain re-bake does not shift the drawn water / POI surfaces)
  return [w ? w * 0.01 - 100 : NaN, c ? c * 0.01 - 100 : NaN, tp ? tp * 0.01 - 100 : NaN];
}
/** the plant (base y) stands under DRAWN inland water (mangroves excepted) or under a drawn surface that is 0.3 m …
 *  `reach` over its base (a slab, deck, roof, overhang, cliff skin, outcrop) — the drawn-geometry half of seatPlant */
export function maskRejects(t: Terrain, kind: VegKind, x: number, y: number, z: number, footR: number, reach: number): "water" | "cover" | null {
  if (!MASK) return null;
  const pts = footR > 0.6 ? [[0, 0], [0.7, 0], [-0.7, 0], [0, 0.7], [0, -0.7]] : [[0, 0]];
  for (const [ox, oz] of pts) {
    const m = spawnMaskAt(t, x + ox * footR, z + oz * footR)!;
    if (kind !== "mangrove" && m[0] > y + 0.05) return "water";
    if (ox === 0 && oz === 0) {
      const top = m[1] - y; if (top > 0.3 && top < reach) return "cover";
      // an elevated plant (rock cap, POI tier) with a slab / overhang higher up in a layered cell
      const hi = m[2] - y; if (top <= 0.3 && hi > 0.4 && hi < reach) return "cover";
      // (a plant standing on a rock cap well over the terrain: any drawn surface higher up in the cell — the mask keeps
      // only the lowest and highest layers, a slab between them would be missed)
      if (top <= 0.3 && hi > 0.4 && y > t.height(x, z) + 0.5) return "cover";
    }
  }
  return null;
}

const slopeAt = (t: Terrain, x: number, z: number) => {
  const e = 1.5;
  const dx = t.height(x + e, z) - t.height(x - e, z), dz = t.height(x, z + e) - t.height(x, z - e);
  return dmath.hypot(dx, dz) / (2 * e);
};

/** direction (yaw) toward the nearest water, sampled on a ring — for leaning beach palms */
function seawardYaw(t: Terrain, x: number, z: number): number {
  let best = 0, bestH = 1e9;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const h = t.height(x + dmath.cos(a) * 18, z + dmath.sin(a) * 18) + 0.3 * t.height(x + dmath.cos(a) * 36, z + dmath.sin(a) * 36);
    if (h < bestH) { bestH = h; best = a; }
  }
  // lean direction is +X of the model; three.js yaw rotates +X to (cos yaw, −sin yaw) → yaw = −a
  return -best;
}

/** world angle a (x = cos a, z = sin a) toward the nearest Path sample within r, or null */
function trailDir(t: Terrain, x: number, z: number, r: number): number | null {
  for (let d = 2; d <= r; d += 1.5) for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    if (t.biomeAt(x + dmath.cos(a) * d, z + dmath.sin(a) * d) === Biome.Path) return a;
  }
  return null;
}

export interface ScatterEnv {
  /** terrain rocks (terrainRocks(data)) — optional: filters plants buried in rock */
  rocks?: RockIndex;
  /** path coverage mask (TerrainData.path, 0..255 on the terrain grid) — optional, detail layer only */
  path?: Uint8Array;
  pathRes?: number;
  /** canopy coverage above (x, z) (client CanopyGrid) — detail layer only: under a closed crown the meadow floor grows
   * jungle floor (ground cover, ferns) instead of lawn (copses, the forest edge, the jungle view's grassy left bank) */
  canopy?: (x: number, z: number) => number;
  /** keep-out discs for scattered (not hand-placed) big plants: hero slots reserve their surroundings (a
   * scattered palm 5 m from the highlands hero palm reads as one crown on two trunks) */
  keep?: Array<{ x: number; z: number; r: number }>;
  /** view cones behind hero plants (camera x, z, direction, cos of the half angle, distance range): nothing tall may
   * line up with a hero's trunk in the view's frame (a palm 90 m behind the hero palm reads as a second trunk) */
  cones?: Array<{ x: number; z: number; fx: number; fz: number; cos: number; d0: number; d1: number; crownR?: number }>;
  /** design layer: the jungle glades (big plants keep out) and the canopy trunks placed so far (trunk affinity) */
  glades?: Glade[];
  trunks?: Map<number, number[]>;
}

function pathAt(env: ScatterEnv, x: number, z: number): number {
  const p = env.path!, res = env.pathRes!;
  const fx = (x + WORLD.HALF) / WORLD.CELL, fz = (z + WORLD.HALF) / WORLD.CELL;
  const j = Math.min(res - 1, Math.max(0, Math.round(fx))), i = Math.min(res - 1, Math.max(0, Math.round(fz)));
  return p[i * res + j] / 255;
}

/** composed vistas that must stay open (terrain's highlands crest: open grass, ≤ 2 trees in frame): a 300 m view
 * wedge (±42°) in front of the camera + 25 m around it */
const VISTAS = ["biome-03-highlands"].map((id) => TERRAIN_CAMS[id]).filter(Boolean).map((c) => {
  const dx = c.target[0] - c.pos[0], dz = c.target[2] - c.pos[2], L = dmath.hypot(dx, dz) || 1;
  return { x: c.pos[0], z: c.pos[2], fx: dx / L, fz: dz / L };
});
function inVista(x: number, z: number): boolean {
  for (const v of VISTAS) {
    const dx = x - v.x, dz = z - v.z, d = dmath.hypot(dx, dz);
    if (d < 25) return true;
    // (±52°: the frame's horizontal half-angle is 49° — a copse crown cut by the left edge reads as a dark green blob
    // beside the hero palm)
    if (d < 300 && (dx * v.fx + dz * v.fz) / d > dmath.cos(52 * D2R)) return true;
  }
  return false;
}

/**
 * View-camera keep-outs (a lagoon mangrove 5 m beside the beach camera would fill a third of the frame): no
 * SCATTERED big plant within `r` m of the camera or inside the ±`deg` cone out to `cone` m — the hand-placed dressing
 * composes that space. Filled below once the view constants exist.
 */
const LENSES: Array<{ x: number; z: number; fx: number; fz: number; r: number; cone: number; cos: number; kinds?: VegKind[]; bearing?: [number, number] }> = [];
function inLens(x: number, z: number, kind?: VegKind): boolean {
  for (const l of LENSES) {
    if (l.kinds && (!kind || !l.kinds.includes(kind))) continue;
    const dx = x - l.x, dz = z - l.z, d2 = dx * dx + dz * dz;
    if (d2 > l.cone * l.cone) continue;
    if (l.bearing) {
      // a bearing wedge (degrees from the view axis, − = left): a frame-edge keep-out, not the whole cone
      const b = dmath.atan2(dx * -l.fz + dz * l.fx, dx * l.fx + dz * l.fz) / D2R;
      if (b >= l.bearing[0] && b <= l.bearing[1]) return true;
      continue;
    }
    if (d2 < l.r * l.r) return true;
    const d = Math.sqrt(d2);
    if ((dx * l.fx + dz * l.fz) / d > l.cos) return true;
  }
  return false;
}

/** some sample within r m (rings of r and r/2) is off the trail — the trail's overgrown edge band */
function nearOffTrail(t: Terrain, x: number, z: number, r: number): boolean {
  for (const [dx, dz] of RING8) for (const k of [0.5, 1]) { const q = t.biomeAt(x + dx * r * k, z + dz * r * k); if (q !== Biome.Path && q !== Biome.Paved) return true; }
  return false;
}

/** the biome just off the trail (nearest non-trail sample on rings of 2.5 / 4.5 m), Path if none */
function besideTrail(t: Terrain, x: number, z: number): Biome {
  for (const r of [2.5, 4.5]) for (const [dx, dz] of RING8) {
    const b = t.biomeAt(x + dx * r, z + dz * r);
    if (b !== Biome.Path && b !== Biome.Paved) return b;
  }
  return Biome.Path;
}

/** within `d` m of the trail's edge (any of 8 samples at distance d is off the trail) */
function nearPathEdge(env: ScatterEnv, x: number, z: number, d: number): boolean {
  for (const [dx, dz] of RING8) if (pathAt(env, x + dx * d, z + dz * d) < 0.45) return true;
  return false;
}

/** a crown may hang this far (m) over a dirt road — keeps the roads readable from the air */
const ROAD_OVERHANG = 0.5;
/** the plant's crown (crownFootprint, yawed + scaled) overhangs no dirt road by more than ROAD_OVERHANG */
function crownClearOfRoads(t: Terrain, kind: VegKind, variant: number, x: number, z: number, yaw: number, scale: number): boolean {
  const cf = crownFootprint(kind, variant);
  if (!cf) return true;
  const c = dmath.cos(yaw), sn = dmath.sin(yaw);
  const cx = x + (cf.x * c + cf.z * sn) * scale, cz = z + (-cf.x * sn + cf.z * c) * scale;
  return nearestRoad(t, cx, cz).d >= cf.r * scale - ROAD_OVERHANG;
}


// =====================================================================================================================
// The jungle's DESIGN layer: still thick, but a little less everywhere and placed with intent. The canopy stays; the
// understory / mid-storey is art-directed, not uniform fill.
//   glades    designed clearings (r 9–13 m) on a jittered ~110 m lattice through the jungle interiors (away from the
//             trails, off POI ground, gentle ground): no big plant on the floor (canopy trunks keep r + 1 m back so the
//             edge crowns roof the rim), a HERO tree (a giant emergent buttress tree) standing on the rim, a fallen log
//             for cover in most of them, and a denser framing ring of understory around the glade
//   gradient  a low-frequency thicket / open-forest field (dense pockets and airy stretches instead of an even carpet)
//             and slope thinning (steep faces carry canopy, not shrubs)
//   floor     trunk affinity: shrubs, banana and monstera gather round the tree bases and thin out in the lanes between
//             trees — the eye-height sightlines open up while the jungle still reads THICK from the trail
//   edges     tall understory (banana, bush) keeps clear of the trails and drawn rivers: clean, readable edges
// Tunables: DESIGN.
export interface Glade { x: number; z: number; r: number }
export const DESIGN = {
  glade: { spacing: 94, jitter: 0.3, r: [9.5, 13] as [number, number], trail: 30, slope: 0.42, pad: 26, heroScale: [1.42, 1.6] as [number, number], logP: 0.65 },
  thicket: { freq: 1 / 150, lo: 0.25, hi: 1.12, a: 0.3, b: 0.7 },   // (open forest keeps 25 % of the eye-height understory)
  trunk: { root: 1.8, near: 6.0, far: 9.5, pRoot: 0.5, pMid: 0.66, pFar: 0.4 },
  slope: { a: 0.3, b: 0.75, cut: 0.6 },
  ring: { w: 7, k: 1.5 },
  edge: { trail: 5.0, river: 4.0 },
};
const GLADE_CACHE = new WeakMap<Float32Array, Glade[]>();
const dHash = (x: number, z: number, k: number) => hash2(Math.floor(x * 13.7), Math.floor(z * 13.7), k) / 4294967296;
/** the designed jungle glades — deterministic from the terrain + POI clearings (client, server and tools agree) */
export function jungleGlades(t: Terrain, clearings: Clearing[]): Glade[] {
  const c = GLADE_CACHE.get(t.heights); if (c) return c;
  const G = DESIGN.glade, out: Glade[] = [], H = WORLD.HALF, dz = G.spacing * 0.866;
  for (let row = 0; row * dz < 2 * H; row++) for (let col = 0; col * G.spacing < 2 * H; col++) {
    const bx = -H + col * G.spacing + (row & 1 ? G.spacing / 2 : 0), bz = -H + row * dz;
    const rnd = mulberry32(hash2(col, row, 90210));
    let best: Glade | null = null;
    for (let tries = 0; tries < 6 && !best; tries++) {
      const x = bx + (rnd() - 0.5) * 2 * G.jitter * G.spacing, z = bz + (rnd() - 0.5) * 2 * G.jitter * G.spacing;
      const r = G.r[0] + rnd() * (G.r[1] - G.r[0]);
      if (t.biomeAt(x, z) !== Biome.Jungle || t.height(x, z) < 1.5) continue;
      let jungle = 0, steep = false;
      for (let q = 0; q < 12 && !steep; q++) {
        const a = (q / 12) * Math.PI * 2;
        for (const k of [0.5, 1]) { const px = x + dmath.cos(a) * r * k, pz = z + dmath.sin(a) * r * k; if (slopeAt(t, px, pz) > G.slope) steep = true; }
        if (t.biomeAt(x + dmath.cos(a) * (r + 5), z + dmath.sin(a) * (r + 5)) === Biome.Jungle) jungle++;
      }
      if (steep || jungle < 10 || slopeAt(t, x, z) > G.slope) continue;
      if (nearestRoad(t, x, z).d < G.trail || nearPad(x, z, G.pad) || nearBlocked(t, x, z, r + 4)) continue;
      let poi = false; for (let q = 0; q < 8 && !poi; q++) { const a = (q / 8) * Math.PI * 2; if (inClearing(x + dmath.cos(a) * (r + 10), z + dmath.sin(a) * (r + 10), clearings)) poi = true; }
      if (poi || inClearing(x, z, clearings)) continue;
      const m = spawnMaskAt(t, x, z); if (m && m[0] > t.height(x, z) - 0.5) continue;
      best = { x, z, r };
    }
    if (best) out.push(best);
  }
  GLADE_CACHE.set(t.heights, out);
  return out;
}
/** glades near (x, z) — a 32 m grid (the scatter asks for every candidate: no linear scan) */
const GLADE_GRID = new WeakMap<Glade[], Map<number, Glade[]>>();
function gladesNear(glades: Glade[], x: number, z: number): Glade[] | undefined {
  let g = GLADE_GRID.get(glades);
  if (!g) {
    g = new Map();
    const reach = 13 + 2 + DESIGN.ring.w;
    for (const q of glades) for (let gx = Math.floor((q.x - reach) / 32); gx <= Math.floor((q.x + reach) / 32); gx++) for (let gz = Math.floor((q.z - reach) / 32); gz <= Math.floor((q.z + reach) / 32); gz++) {
      const k = (gx + 4096) * 8192 + gz + 4096; let a = g.get(k); if (!a) g.set(k, (a = [])); a.push(q);
    }
    GLADE_GRID.set(glades, g);
  }
  return g.get((Math.floor(x / 32) + 4096) * 8192 + Math.floor(z / 32) + 4096);
}
/** inside a glade (big plants keep out; canopy trunks keep r + 1 m back so the rim crowns roof the edge) */
function inGlade(glades: Glade[] | undefined, x: number, z: number, extra: number): boolean {
  const near = glades && gladesNear(glades, x, z); if (!near) return false;
  for (const g of near) { const r = g.r + extra; if (dmath.pow(x - g.x, 2) + dmath.pow(z - g.z, 2) < r * r) return true; }
  return false;
}
function gladeRing(glades: Glade[] | undefined, x: number, z: number): boolean {
  const near = glades && gladesNear(glades, x, z); if (!near) return false;
  for (const g of near) { const d = dmath.hypot(x - g.x, z - g.z); if (d >= g.r && d < g.r + DESIGN.ring.w) return true; }
  return false;
}
function trunkGrid(out: VegInstance[]): Map<number, number[]> {
  const m = new Map<number, number[]>();
  for (const p of out) {
    if (p.kind !== "jungle-tree" && p.kind !== "palm") continue;
    const k = (Math.floor(p.x / 8) + 4096) * 8192 + Math.floor(p.z / 8) + 4096; let a = m.get(k); if (!a) m.set(k, (a = [])); a.push(p.x, p.z, p.kind === "jungle-tree" ? p.scale : 0.4);
  }
  return m;
}
function nearestTrunk(m: Map<number, number[]>, x: number, z: number): number {
  let best = 1e9;
  for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
    const a = m.get((Math.floor(x / 8) + i + 4096) * 8192 + Math.floor(z / 8) + j + 4096); if (!a) continue;
    for (let k = 0; k < a.length; k += 3) { const d = dmath.hypot(a[k] - x, a[k + 1] - z) - a[k + 2] * 1.2; if (d < best) best = d; }
  }
  return best;
}
/** the design layer's accept probability for an understory plant at (x, z) */
function designKeep(t: Terrain, env: ScatterEnv, noise: Simplex2, rule: Rule, x: number, z: number): number {
  const D = DESIGN;
  if (inGlade(env.glades, x, z, 0)) return 0;
  const th = 0.5 + 0.5 * noise.fbm(x * D.thicket.freq + 311.7, z * D.thicket.freq - 97.1, 2);
  let p = D.thicket.lo + (D.thicket.hi - D.thicket.lo) * smoothstep(D.thicket.a, D.thicket.b, th);
  const sl = slopeAt(t, x, z);
  p *= 1 - D.slope.cut * smoothstep(D.slope.a, D.slope.b, sl);
  // tall mid-storey (banana: 3.5–6.5 m, a wall at eye height) lives in the thickets, at the glade rims and the edges
  if (rule.kind === "banana-plant") p *= 0.15 + 0.85 * smoothstep(0.45, 0.62, th);
  // Tall paddle leaves make visual concealment clusters. Between intentional deep-jungle stands they occupy only
  // the strongest thicket cores, so a player can read the low floor and solid tree cover through the lanes.
  if (rule.kind === 'banana-plant' && !deepJungleAt(t,x,z,nearestRoad(t,x,z).d))
    p *= 0.02 + 0.98 * smoothstep(0.64,0.78,th);
  if (rule.design === "floor") {
    const d = env.trunks ? nearestTrunk(env.trunks, x, z) : 5;
    const f = d < D.trunk.root ? D.trunk.pRoot : d < D.trunk.near ? 1 : d < D.trunk.far ? D.trunk.pMid : D.trunk.pFar;
    // (the low layer — monstera, mostly under eye height — carpets more evenly than the shrubs and bananas)
    p *= rule.kind === "monstera" ? 0.5 + 0.5 * f : f;
    // the open floor between the groves, outside the deep jungle, reads clean: far from any trunk the
    // understory keeps OPEN_FLOOR_KEEP of its share — the shrubs gather under the groves as cover pockets
    if (d >= D.trunk.far && !deepJungleAt(t, x, z, nearestRoad(t, x, z).d)) p *= OPEN_FLOOR_KEEP;
    // clean edges: tall understory steps back from the trails and the drawn rivers
    if (rule.kind !== "monstera") {
      if (nearBlocked(t, x, z, D.edge.trail)) return 0;
      for (let q = 0; q < 8; q++) { const a = q * 0.7853981633974483, px = x + dmath.cos(a) * D.edge.river, pz = z + dmath.sin(a) * D.edge.river; const m = spawnMaskAt(t, px, pz); if (m && m[0] > t.height(px, pz) + 0.05) return 0; }
    }
  }
  if (gladeRing(env.glades, x, z)) p = Math.max(p, 0.75) * D.ring.k;
  return p;
}

function runRule(t: Terrain, rule: Rule, clearings: Clearing[], gaps: GapGrid, noise: Simplex2, out: VegInstance[], bounds: [number, number, number, number], kindIndex: number, env: ScatterEnv) {
  const [x0, z0, x1, z1] = bounds;
  const s = rule.spacing;
  const gx0 = Math.floor(x0 / s), gx1 = Math.ceil(x1 / s), gz0 = Math.floor(z0 / s), gz1 = Math.ceil(z1 / s);
  const nVar = VARIANTS[rule.kind];
  const pm = rule.pathMargin ?? (rule.detail ? 1.2 : 2.2);
  const usePathMask = !!(rule.detail && env.path);
  const ok = (x: number, z: number, y: number) => {
    if (y < rule.minY || (rule.maxY !== undefined && y > rule.maxY)) return false;
    const sl = slopeAt(t, x, z);
    if (sl > rule.maxSlope || (rule.minSlope !== undefined && sl < rule.minSlope)) return false;
    if (usePathMask) {
      const b = t.biomeAt(x, z);
      if (b === Biome.Paved || b === Biome.DeepOcean || b === Biome.Reef) return false;
      // the trails are ~9 m of dirt; grass / ground cover / ferns overgrow only a band along each edge (ground cover
      // 2.3 m, grass 1.9 m, ferns 1.1 m): the walked line in the middle stays ~2–3 m of bare dirt like the target art's
      // jungle path, whatever the trail's painted width
      if (pathAt(env, x, z) > (rule.trail?.max ?? (rule.kind === "grass" ? 0.82 : rule.kind === "groundcover" ? 0.7 : rule.kind === "fern" ? 0.6 : 0.5))) {
        // (wide overgrown bands: the walked line is ~2.5 m of dirt between leafy edges, not a 5 m cream road)
        const band = rule.trail?.band ?? (rule.kind === "groundcover" ? 3.0 : rule.kind === "grass" ? 2.4 : rule.kind === "fern" ? 1.5 : 0);
        if (!band || !nearPathEdge(env, x, z, band)) return false;
        // (the band is DENSE at the edge and thins toward the walked middle — lone rosettes out on the
        // dirt read as stickers; only a third of the plants in the band's inner half survive)
        if (!nearPathEdge(env, x, z, band * 0.5) && hash2(Math.floor(x * 7), Math.floor(z * 7), 4099) % 1000 > 330) return false;
      }
    } else if (nearBlocked(t, x, z, pm)) return false;
    if (rule.padMargin !== undefined && nearPad(x, z, rule.padMargin)) return false;
    if (rule.vistaFree && inVista(x, z)) return false;
    if (!rule.detail && (inLens(x, z, rule.kind) || (env.keep && env.keep.some((k) => dmath.pow(x - k.x, 2) + dmath.pow(z - k.z, 2) < k.r * k.r)))) return false;
    if (!rule.detail && env.cones && COLLIDABLE.has(rule.kind) && env.cones.some((c) => {
      const dx = x - c.x, dz = z - c.z, d = dmath.hypot(dx, dz);
      if (d <= c.d0 || d >= c.d1) return false;
      // crown cones widen by the angular radius of a big crown at that distance (no canopy may sit behind a hero crown)
      const cs = c.crownR ? dmath.cos(Math.min(Math.PI / 2, dmath.acos(c.cos) + dmath.atan(c.crownR / d))) : c.cos;
      return (dx * c.fx + dz * c.fz) / d > cs;
    })) return false;
    if (rule.badlandsMax !== undefined && t.biomeAt(x, z) === Biome.Cinder && badlandsAt(x, z) > rule.badlandsMax) return false;
    if (!rule.detail && nearPad(x, z, 0)) return false;
    // (no pale leaf card lying flat on the harbour water) sand plants (dune creeper, beach grass) never
    // grow on a POI pad — the harbour apron / quay edges are Beach under the POI's own deck
    if (rule.detail && rule.biome[Biome.Beach] && !rule.biome[Biome.Jungle] && nearPad(x, z, 2)) return false;
    if (inClearing(x, z, clearings)) return false;
    if (!rule.detail && env.glades && inGlade(env.glades, x, z, COLLIDABLE.has(rule.kind) && rule.kind !== "log" ? 1 : 0)) return false;
    if (rule.edge && !nearBiome(t, x, z, rule.edge.biome, rule.edge.r)) return false;
    if (rule.nearRock !== undefined) { if (!env.rocks) return false; const d = env.rocks.near(x, z, rule.nearRock + 6); if (d > rule.nearRock || d < 0) return false; }
    // detail may grow into the rock's footprint circle a little (it is ~0.42 of the rock's larger size): half-buried
    // stones sit IN the lawn instead of in a bare pit
    else if (env.rocks && !COLLIDABLE.has(rule.kind) && env.rocks.near(x, z, 6, y) < (rule.detail ? -0.35 : 0.6)) return false;
    return true;
  };
  for (let gz = gz0; gz < gz1; gz++) for (let gx = gx0; gx < gx1; gx++) {
    const rnd = mulberry32(hash2(gx, gz, kindIndex * 131 + WORLD.SEED));
    const x = (gx + rnd()) * s, z = (gz + rnd()) * s;
    if (x < x0 || x >= x1 || z < z0 || z >= z1) continue;
    let b = t.biomeAt(x, z);
    // detail on a trail's edge band grows as the biome beside the trail (ok() keeps the walked middle bare)
    if (b === Biome.Path && usePathMask) b = besideTrail(t, x, z);
    // under a closed canopy the meadow floor is jungle floor (no lawn in the shade of a copse / the forest edge)
    if (rule.detail && b === Biome.Grass && env.canopy && env.canopy(x, z) > 0.75) b = Biome.Jungle;
    const w = rule.biome[b] ?? 0;
    if (w <= 0) continue;
    const r1 = rnd(), r2 = rnd(), r3 = rnd(), r4 = rnd();
    if (r1 > w) continue;
    // Shared placement decision, before gap insertion: rendering and server cover cannot disagree.
    // Beach groves and hand-authored heroes keep their identity; only the procedural inland canopy is redistributed.
    // (bamboo too — 8.5 m cane walls on the open ground between the groves would block the lanes; they follow the same
    // grove field, open verges included: bamboo stands sit in the groves)
    if (!rule.detail && (rule.kind === 'jungle-tree' || rule.kind === 'palm' || rule.kind === 'bamboo') && (b === J || b === G)) {
      const rd = nearestRoad(t,x,z).d, keep = canopyKeepAt(t,x,z,rd);
      if (dHash(x,z,kindIndex*29+8107) > (rule.kind === 'bamboo' ? (0.3 + 0.7 * keep) * smoothstep(6,16,rd) : keep)) continue;
    }
    const y = t.height(x, z);
    if (rule.clump) {
      const c = 0.5 + 0.5 * noise.fbm(x * rule.clump[0] + (rule.clumpKey ?? kindIndex) * 7.3, z * rule.clump[0], 3);
      if (c < rule.clump[1] + r2 * 0.25) continue;
    }
    if (rule.design && t.biomeAt(x, z) === Biome.Jungle) {
      if (!env.trunks) env.trunks = trunkGrid(out);
      if (dHash(x, z, kindIndex * 17 + 5) >= designKeep(t, env, noise, rule, x, z)) continue;
    }
    if (!ok(x, z, y)) continue;
    if (rule.minGap && gaps.tooClose(x, z, rule.minGap)) continue;
    let yaw = rule.seaward ? seawardYaw(t, x, z) + (r4 - 0.5) * 0.5 : r4 * Math.PI * 2;
    if (rule.faceTrail) {
      const a = trailDir(t, x, z, rule.faceTrail);
      if (a !== null) yaw = -a + (r4 - 0.5) * 0.6;
    }
    const scale = rule.scale[0] + (rule.scale[1] - rule.scale[0]) * r3;
    const vr = rnd();
    const variant = rule.variants ? rule.variants[Math.floor(vr * rule.variants.length)] : Math.floor(vr * nVar);
    // crowns keep off the dirt roads: an edge tree that would lean its crown over a trail turns its lean along
    // (or away from) the trail, else it is not planted
    if (!rule.detail && !rule.group) {
      let ok2 = false;
      for (const dy of rule.faceTrail ? [0, Math.PI / 2, -Math.PI / 2, Math.PI] : [0]) if (crownClearOfRoads(t, rule.kind, variant, x, z, yaw + dy, scale)) { yaw += dy; ok2 = true; break; }
      if (!ok2) continue;
    }
    if (inPoiVolume(rule.kind, variant, x, y, z, yaw, scale, !!rule.detail)) continue;
    if (!rule.group) {
      const ys = seatPlant(t, rule.kind, variant, x, z, yaw, scale, !!rule.detail, env.rocks);
      if (ys === null) continue;
      out.push({ kind: rule.kind, variant, x, y: ys, z, yaw, scale });
      if (rule.minGap) gaps.add(x, z);
      continue;
    }
    // group: members spread across the lean direction, each leaning toward the group axis → crossing trunks
    const g = rule.group;
    const n = g.n[0] + Math.floor(rnd() * (g.n[1] - g.n[0] + 1));
    const lx = dmath.sin(yaw), lz = dmath.cos(yaw);            // lateral (⟂ to the lean (cos yaw, −sin yaw))
    const placed: Array<[number, number]> = [];
    for (let m = 0; m < n; m++) {
      const side = m === 0 ? 0 : (m % 2 ? 1 : -1) * (g.r[0] + rnd() * (g.r[1] - g.r[0])) * (m > 2 ? 1.7 : 1);
      const back = (rnd() - 0.5) * 2.2;
      const mx = x + lx * side + dmath.cos(yaw) * back, mz = z + lz * side - dmath.sin(yaw) * back;
      if (m > 0) {
        if ((rule.biome[t.biomeAt(mx, mz)] ?? 0) <= 0) continue;
        const my = t.height(mx, mz);
        if (!ok(mx, mz, my)) continue;
        if (placed.some(([px, pz]) => dmath.pow(px - mx, 2) + dmath.pow(pz - mz, 2) < g.gap * g.gap)) continue;
        if (gaps.tooClose(mx, mz, g.gap)) continue;
      }
      const my = t.height(mx, mz);
      // lean toward the other side of the group: crossing trunks
      const cross = m === 0 ? (rnd() - 0.5) * 0.5 : -Math.sign(side) * (0.3 + rnd() * 0.35);
      const upright = m > 0 && rnd() < (g.upright ?? 0);
      const mv = upright ? Math.floor(rnd() * 2) : Math.floor(rnd() * nVar);
      const mk: VegKind = upright ? "palm" : rule.kind, ms = rule.scale[0] + (rule.scale[1] - rule.scale[0]) * rnd();
      if (!crownClearOfRoads(t, mk, mv, mx, mz, yaw + cross, ms)) continue;
      if (inPoiVolume(mk, mv, mx, my, mz, yaw + cross, ms, false)) continue;
      const mys = seatPlant(t, mk, mv, mx, mz, yaw + cross, ms, false, env.rocks);
      if (mys === null) continue;
      out.push({ kind: mk, variant: mv, x: mx, y: mys, z: mz, yaw: yaw + cross, scale: ms });
      placed.push([mx, mz]);
    }
    for (const [px, pz] of placed) gaps.add(px, pz);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// hand-placed set dressing (composed views) — resolved against the terrain height; part of the shared scatter so
// the server gets the same log / trunk colliders

export interface Placed { kind: VegKind; variant: number; x: number; z: number; yaw: number; scale: number; dy?: number }

/** the biome-02-jungle composition camera (client/src/world/veg/index.ts views) — dressing is placed relative to it */
// (here the trail runs through Jungle on the right and ahead, into a bright clearing)
export const JUNGLE_VIEW = { x: -429.2, z: 377.8, tx: -393.3, tz: 360.2 };
/** camera-relative placement: f metres forward, r metres right; yaw given relative to the view direction */
function camRel(c: { x: number; z: number; tx: number; tz: number }, list: Array<[VegKind, number, number, number, number, number, number?]>): Placed[] {
  const L = dmath.hypot(c.tx - c.x, c.tz - c.z), fx = (c.tx - c.x) / L, fz = (c.tz - c.z) / L;
  const rx = -fz, rz = fx;                                    // right = forward × up
  const viewYaw = dmath.atan2(-fz, fx);                        // yaw that points a model's +X along the view
  return list.map(([kind, variant, f, r, yaw, scale, dy]) => ({ kind, variant, x: c.x + fx * f + rx * r, z: c.z + fz * f + rz * r, yaw: viewYaw + yaw, scale, dy }));
}
export const HAND_PLACED: Placed[] = camRel(JUNGLE_VIEW, [
  // [kind, variant, forward m, right m, yaw rel. to the view (+ turns the model's +X to the left), scale, dy]
  // (the trail runs r −3.5 … +3.5 ahead of the camera, descending 6 m over 44 m)
  // LEFT: the mossy log lies diagonally on the trail's left edge, bromeliads in front of it, the
  // banana with its big bunch behind it, and behind that the BUTTRESS GIANT (the emergent silhouette at 1.7×: a ~3 m
  // trunk whose ridges spread 5–7 m; turned so its widest ridge gap faces the trail — no buttress blade on the path)
  // (the log is big, turned across the trail's left edge, its far end on the overgrown edge band; the banana a little
  // further left so the giant's roots show beside it)
  ["log", 0, 6.5, -4.8, -0.45, 1.6, -0.2],
  ["banana-plant", 0, 7.8, -6.7, -2.1, 1.45],
  ["jungle-tree", 2, 12.5, -8.8, -1.81, 1.7],
  // (the trail is ~9 m of dirt here, r −4.2 … +4.6; the ground cover overgrows a band along each edge and these
  // decorative pieces stand in that band — HAND_PLACED lets non-collidable kinds sit within 2.2 m of the trail's edge)
  ["flowers", 0, 3.4, -2.5, 0.4, 1.2],
  ["flowers", 0, 10.2, -4.6, 2.2, 1.05],
  ["flowers", 0, 4.0, 3.8, 1.1, 1.1],
  ["flowers", 0, 10.5, 4.0, 0.6, 1.0],
  ["flowers", 0, 5.0, -2.2, 1.6, 0.95],
  ["fern", 0, 3.0, -3.6, 1.0, 1.05],
  ["fern", 1, 10.4, -6.0, 2.6, 1.1],
  // RIGHT: huge banana + monstera leaves at the trail edge, bamboo mid-right, a fern
  ["banana-plant", 1, 5.2, 4.4, 4.2, 1.3],
  ["monstera", 1, 6.4, 5.0, 1.2, 1.35],
  ["monstera", 0, 3.8, 4.1, 3.4, 1.3],
  ["fern", 1, 7.8, 4.2, 2.0, 1.15],
  ["bamboo", 1, 12, 7.2, 0.3, 1.05],
  // canopy trees on both edges lean their crowns over the trail so the canopy closes overhead (the target art's deep shade)
  ["jungle-tree", 0, 7.5, 8.6, 1.57, 1.0],
  ["jungle-tree", 1, 17, 8.2, 1.57, 1.0],
  ["jungle-tree", 4, 21, -7.4, -1.57, 1.0],
  ["jungle-tree", 1, 27, 8.4, 1.57, 1.0],
  ["jungle-tree", 0, 32, -7.4, -1.57, 0.95],
  ["banana-plant", 0, 16, -5.6, 3.0, 1.0],
  // a wide canopy crown on the right edge closes the sky over the trail (the target art's canopy roof with one bright gap);
  // (no umbrella on the left: the sun comes from behind-left (NW, 42°) and its crown would put the whole trail and the
  // right-hand foliage in shade; the right side and the trail stay sunlit)
  ["jungle-tree", 1, 12.5, 11.5, 1.57, 1.05],
  // thick lianas looping across the sky gap over the trail (hung high: 9.5 m + the terrain drop ahead)
  // (two loops, not three — three crossing ropes over the gap read as rigging)
  ["vine", 0, 11, 0.5, -1.57, 1.1],
  ["vine", 0, 19, -0.5, -1.3, 1.2],
  // leafy vine CURTAINS hanging 3–6 m out of the canopy across the top third of the frame: over the left and
  // right trail edges and one deeper on the left (the sky gap over the trail stays open — the target art's bright opening)
  ["vine", 1, 13, -4.6, -1.35, 1.0],
  ["vine", 1, 18.5, 5.2, -1.85, 0.95],
  ["vine", 1, 26, -8.5, -1.3, 1.05, 1.2],
]);
/** the biome-03-highlands composition camera (TERRAIN_CAMS) — lone palms dotting the slopes like the target art */
const HC = TERRAIN_CAMS["biome-03-highlands"] ?? { pos: [318, 1.9, 390], target: [372, -8, 660], fov: 66 };
export const HIGHLANDS_VIEW = { x: HC.pos[0], z: HC.pos[2], tx: HC.target[0], tz: HC.target[2] };
HAND_PLACED.push(...camRel(HIGHLANDS_VIEW, [
  // (the crest trail runs from the left foreground down-left; a big boulder stands right of centre)
  // left: banana leaves at the hero palm's foot (the hero palm itself is a searched SLOT — HERO_SLOTS); right foreground:
  // big banana + monstera leaves in front of the boulder (the target art's bottom-right), heliconia, fern; lone palms below
  ["banana-plant", 1, 3.4, -11.5, 0.4, 1.05],
  ["fern", 0, 5.5, -9.8, 1.4, 1.2],
  // (the right third stays open down to the coast — a low monstera at the frame bottom only)
  ["monstera", 0, 3.4, 3.2, 3.0, 1.0],
  ["flowers", 1, 6.2, 4.4, 0.5, 1.15],
  ["fern", 1, 3.6, 2.6, 0.8, 1.15],
  ["monstera", 1, 9.5, 7.2, 1.0, 1.2],
  ["palm", 0, 36, 18, 1.0, 1.05],
  ["palm", 2, 44, 9, 0.2, 0.95],
  ["palm", 0, 70, -21, 2.0, 1.0],
  ["palm", 2, 55, 12, 1.2, 1.0],
]));

/**
 * Hero plants that define a view's composition, as SEARCHED slots (the terrain generator can move trails and slopes under
 * any fixed offset): the first (distance, angle) candidate — angle in degrees from the view axis, − = left — whose
 * ground is plantable (no trail / pad / clearing / POI volume / rock, slope ok) wins; its scale is solved so the crown
 * top lands at `frameTop` (0 = frame top, 1 = bottom) of the view (`cam` = eye / target heights above the terrain,
 * fov), within `scaleRange`. Deterministic: the server replays the same search for the trunk colliders. Each hero
 * reserves `keep` m around itself from scattered big plants.
 */
interface HeroSlot {
  view: { x: number; z: number; tx: number; tz: number }; cam: { eye: number; target: number; fov: number; seaTarget?: boolean };
  kind: VegKind; variant: number; yaw: number; frameTop: number; scaleRange: [number, number]; dists: number[]; angles: number[]; clear: number; keep: number;
}
/** dev: the hero-slot search's reasons (set to an array before a scatter to collect them) */
export let HERO_LOG: string[] | null = null;
export const setHeroLog = (a: string[] | null) => { HERO_LOG = a; };
const HERO_SLOTS: HeroSlot[] = [
  // highlands: the target art's big lone highland palm (orange ringed trunk, yellow nuts) on the left, leaning in over the
  // trail, its crown near the top-left of the frame (crown top at ~8 % of the height)
  { view: HIGHLANDS_VIEW, cam: { eye: HC.pos[1], target: HC.target[1], fov: HC.fov, seaTarget: true }, kind: "palm", variant: 2, yaw: -1.2, frameTop: 0.07, scaleRange: [0.85, 1.6],
    dists: [11, 13, 15, 17, 19, 22, 25, 28, 32, 36], angles: [-37, -34, -40, -31, -43, -28, -46, -25], clear: 2.2, keep: 9 },
];

/** the biome-01-beach composition camera as the water's solver (client/src/world/water/beachcam.ts) currently places
 * it: 492, −529 looking az −78° (WNW along the north-coast beach, sea on the right, 40 m of sand on the left). The
 * target art's composition is dressed around it: big coconut palms rooted up the sand on the left leaning out over the
 * beach, a hummock of monstera / heliconia / banana spilling into the bottom-left corner.
 * (the solver can flip between this spot and 392, −537 when the coast changes; the client re-places the decorative
 * hummock around the LIVE camera when they differ, index.ts beachDressing. Palm bases stay outside the solver's ±26° view cone.) */
export const BEACH_VIEW = { x: 492, z: -529, tx: 394.2, tz: -549.8 };
HAND_PLACED.push(...camRel(BEACH_VIEW, [
  // palms (−yaw = the crown leans right, out over the sand toward the sea): bases at −50° … −30° / > 30 m
  ["palm-leaning", 0, 5.5, -6.8, -0.75, 1.22],
  ["palm-leaning", 2, 12.5, -10.8, -0.95, 1.15],
  ["palm-leaning", 0, 22, -12, -1.3, 1.2],
  ["palm-leaning", 1, 34, -8.5, -1.5, 1.3],
  ["palm", 1, 27, -21, 0, 1.1],
  ["palm-leaning", 0, 40, -19, -1.0, 1.05],
  ["palm-leaning", 2, 48, -26, -0.8, 1.1],
]));
/** the target art's left-foreground hummock spilling onto the sand (monstera, heliconia, banana, fern, bush): decorative
 * only — also re-placed by the client relative to the LIVE beach camera if the solver moves it */
export const BEACH_HUMMOCK: Array<[VegKind, number, number, number, number, number, number?]> = [
  ["monstera", 0, 2.9, -3.2, 2.4, 1.15],
  ["flowers", 1, 5.0, -4.7, 0.4, 1.4],
  ["fern", 0, 3.9, -4.4, 1.0, 1.1],
  ["monstera", 1, 6.4, -6.4, 0.9, 1.3],
  ["flowers", 1, 7.8, -6.9, 1.9, 1.3],
  ["bush", 2, 9.8, -9.6, 0.2, 1.1],
  ["banana-plant", 0, 10.5, -11.2, 3.4, 1.1],
  ["flowers", 1, 11.5, -9.0, 2.9, 1.25],
  ["banana-plant", 1, 14.5, -13.0, 1.4, 1.1],
  ["monstera", 0, 13.0, -11.5, 2.0, 1.25],
  // palm litter on the sand in front of the hummock (the target art's coconuts + dry frond)
  ["litter", 0, 5.2, -2.2, 0.4, 1.1],
  ["litter", 1, 7.5, -3.4, 2.1, 1.05],
  ["litter", 2, 9.5, -4.3, 1.2, 1.0],
  ["litter", 0, 13.5, -6.0, 3.0, 1.0],
];
HAND_PLACED.push(...camRel(BEACH_VIEW, BEACH_HUMMOCK));
{
  // camera keep-outs (LENSES) of the dressed views (no scattered big plant in the composed foreground)
  const L = dmath.hypot(BEACH_VIEW.tx - BEACH_VIEW.x, BEACH_VIEW.tz - BEACH_VIEW.z);
  LENSES.push({ x: BEACH_VIEW.x, z: BEACH_VIEW.z, fx: (BEACH_VIEW.tx - BEACH_VIEW.x) / L, fz: (BEACH_VIEW.tz - BEACH_VIEW.z) / L, r: 10, cone: 20, cos: dmath.cos(52 * D2R) });
  // the highlands view's foreground stays low (the target art's bottom-right is banana / monstera leaves in front of the
  // open sea): no scattered tree, palm or bamboo within 32 m inside the frame (±52°)
  {
    const V = HIGHLANDS_VIEW, VL = dmath.hypot(V.tx - V.x, V.tz - V.z);
    LENSES.push({ x: V.x, z: V.z, fx: (V.tx - V.x) / VL, fz: (V.tz - V.z) / VL, r: 6, cone: 32, cos: dmath.cos(52 * D2R), kinds: ["jungle-tree", "palm", "palm-leaning", "bamboo", "mangrove"] });
  }
  // no scattered palm stands on the frame's left edge within 140 m of the harbour camera (the POI's own headland
  // dressing stays)
  const [hx, hz] = harborToWorld(969.5, 492.3), [htx, htz] = harborToWorld(858, 393.2), HL = dmath.hypot(htx - hx, htz - hz);
  LENSES.push({ x: hx, z: hz, fx: (htx - hx) / HL, fz: (htz - hz) / HL, r: 0, cone: 140, cos: 1, kinds: ["palm", "palm-leaning"], bearing: [-48, -24] });
}
/** camera-relative placement (exported for the client's live-camera fallback) */
export const placeRelative = camRel;

/** the rock index last used with each terrain (keyed by its height array): a later caller without the rock list (an
 * tool, a solver) still gets the SAME plants as the renderer did in this process */
const ROCKS_FOR = new WeakMap<Float32Array, RockIndex>();

/** all big plants on the island (deterministic). `rocks` removes collidable plants buried in rock — pass it (the
 * renderer and vegStaticColliders do); without it the rocks registered for this terrain earlier are used, if any. */
export function scatterVegetation(t: Terrain, clearings: Clearing[], rules: Rule[] = BIG_RULES, rocks?: RockInstance[] | RockIndex): VegInstance[] {
  let out: VegInstance[] = [];
  const gaps = new GapGrid(8);
  const noise = new Simplex2(WORLD.SEED + 101);
  const H = WORLD.HALF;
  const ri = rocks ? (rocks instanceof RockIndex ? rocks : new RockIndex(rocks)) : ROCKS_FOR.get(t.heights);
  if (ri) ROCKS_FOR.set(t.heights, ri);
  const env: ScatterEnv = { rocks: ri, keep: [], cones: [] };
  // hand-placed first (they reserve their space)
  const hand: VegInstance[] = [];
  // design layer: the glades + their hero trees / logs (placed first: they reserve their space)
  if (rules === BIG_RULES) {
    env.glades = jungleGlades(t, clearings);
    for (const g of env.glades) {
      const rnd = mulberry32(hash2(Math.round(g.x * 10), Math.round(g.z * 10), 4711));
      const a0 = rnd() * Math.PI * 2, sc = DESIGN.glade.heroScale[0] + rnd() * (DESIGN.glade.heroScale[1] - DESIGN.glade.heroScale[0]);
      for (let k = 0; k < 8; k++) {
        const a = a0 + k * 0.7853981633974483, d = g.r + 2.2 * sc;
        const x = g.x + dmath.cos(a) * d, z = g.z + dmath.sin(a) * d;
        if (t.biomeAt(x, z) !== Biome.Jungle || nearBlocked(t, x, z, 4) || inClearing(x, z, clearings) || gaps.tooClose(x, z, 6)) continue;
        // the crown leans over the glade: the model's crown offset (+X lean) turned toward the glade centre
        const yaw = dmath.atan2(-(g.z - z), g.x - x) + (rnd() - 0.5) * 0.4;
        const y0 = t.height(x, z);
        if (inPoiVolume("jungle-tree", 2, x, y0, z, yaw, sc, false)) continue;
        const ys = seatPlant(t, "jungle-tree", 2, x, z, yaw, sc, false, ri);
        if (ys === null) continue;
        const q: VegInstance = { kind: "jungle-tree", variant: 2, x, y: ys, z, yaw, scale: sc, hero: true };
        if (ri && buriedInRock(ri, q)) continue;
        hand.push(q); gaps.add(x, z);
        break;
      }
      if (rnd() < DESIGN.glade.logP) {
        const a = rnd() * Math.PI * 2, d = g.r * (0.35 + rnd() * 0.3), x = g.x + dmath.cos(a) * d, z = g.z + dmath.sin(a) * d, yaw = rnd() * Math.PI * 2, sc = 0.95 + rnd() * 0.25;
        if (slopeAt(t, x, z) < 0.3 && !inPoiVolume("log", 0, x, t.height(x, z), z, yaw, sc, false)) {
          const ys = seatPlant(t, "log", 0, x, z, yaw, sc, false, ri);
          if (ys !== null) { hand.push({ kind: "log", variant: Math.floor(rnd() * VARIANTS.log), x, y: ys, z, yaw, scale: sc }); gaps.add(x, z); }
        }
      }
    }
  }
  if (rules === BIG_RULES) for (const h of HERO_SLOTS) {
    const L = dmath.hypot(h.view.tx - h.view.x, h.view.tz - h.view.z), fx = (h.view.tx - h.view.x) / L, fz = (h.view.tz - h.view.z) / L;
    const viewYaw = dmath.atan2(-fz, fx);
    // the view's camera (terrain-relative heights, as the terrain resolves TERRAIN_CAMS)
    const ey = Math.max(0, t.height(h.view.x, h.view.z)) + h.cam.eye;
    const ty = (h.cam.seaTarget ? Math.max(0, t.height(h.view.tx, h.view.tz)) : t.height(h.view.tx, h.view.tz)) + h.cam.target;
    const F = [h.view.tx - h.view.x, ty - ey, h.view.tz - h.view.z]; { const l = dmath.hypot3(F[0], F[1], F[2]); F[0] /= l; F[1] /= l; F[2] /= l; }
    const Rv = [-F[2], 0, F[0]]; { const l = dmath.hypot(Rv[0], Rv[2]); Rv[0] /= l; Rv[2] /= l; }
    const U = [Rv[1] * F[2] - Rv[2] * F[1], Rv[2] * F[0] - Rv[0] * F[2], Rv[0] * F[1] - Rv[1] * F[0]];
    const tanY = dmath.tan((h.cam.fov / 2) * D2R), tanX = tanY * 16 / 9;
    const screen = (px: number, py: number, pz: number) => {
      const d = [px - h.view.x, py - ey, pz - h.view.z], zf = d[0] * F[0] + d[1] * F[1] + d[2] * F[2];
      return [0.5 + (d[0] * Rv[0] + d[2] * Rv[2]) / zf / tanX / 2, 0.5 - (d[0] * U[0] + d[1] * U[1] + d[2] * U[2]) / zf / tanY / 2];
    };
    const shape = palmShape(h.variant % 3, h.kind === "palm-leaning"), tip = shape.pts[shape.pts.length - 1];
    let done = false;
    for (const d of h.dists) {
      for (const aDeg of h.angles) {
        const a = aDeg * D2R, f = dmath.cos(a) * d, r = dmath.sin(a) * d;
        const x = h.view.x + fx * f - fz * r, z = h.view.z + fz * f + fx * r;
        const b = t.biomeAt(x, z);
        const why = (r: string) => { HERO_LOG?.push(`d ${d} a ${aDeg}: ${r}`); };
        if (b === Biome.Paved || b === Biome.DeepOcean || b === Biome.Reef || b === Biome.Lagoon || b === Biome.Path || b === Biome.Beach) { why(`biome ${b}`); continue; }
        if (nearBlocked(t, x, z, h.clear) || nearPad(x, z, 2) || inClearing(x, z, clearings) || slopeAt(t, x, z) > 0.7) { why(`blocked/pad/clearing/slope ${slopeAt(t, x, z).toFixed(2)}`); continue; }
        const y = t.height(x, z), yaw = viewYaw + h.yaw, c = dmath.cos(yaw), sn = dmath.sin(yaw);
        // solve the scale that puts the crown top at frameTop (the crown reaches ~1.6 m above the trunk tip)
        const top = (sc: number) => screen(x + (tip[0] * c + tip[2] * sn) * sc, y + tip[1] * sc + 1.6 * sc, z + (-tip[0] * sn + tip[2] * c) * sc);
        let lo = h.scaleRange[0], hi = h.scaleRange[1];
        if (top(hi)[1] > h.frameTop || top(lo)[1] < h.frameTop) { why(`scale: top y ${top(lo)[1].toFixed(2)}..${top(hi)[1].toFixed(2)}`); continue; }
        for (let k = 0; k < 24; k++) { const m = (lo + hi) / 2; if (top(m)[1] > h.frameTop) lo = m; else hi = m; }
        const sc = (lo + hi) / 2, tx = top(sc)[0];
        if (tx < 0.02 || tx > 0.45) { why(`tx ${tx.toFixed(2)}`); continue; }
        if (inPoiVolume(h.kind, h.variant, x, y, z, yaw, sc, false)) { why("poi"); continue; }
        const ys = seatPlant(t, h.kind, h.variant, x, z, yaw, sc, false, env.rocks);
        if (ys === null) { why("seat (pit / rock / roof / crown)"); continue; }
        const q: VegInstance = { kind: h.kind, variant: h.variant, x, y: ys, z, yaw, scale: sc };
        if (env.rocks && (env.rocks.near(x, z, 8, y + 0.3) < 0.7 || buriedInRock(env.rocks, q))) { why(`rock ${env.rocks.near(x, z, 8, y + 0.3).toFixed(2)}`); continue; }
        HERO_LOG?.push(`d ${d} a ${aDeg}: OK scale ${sc.toFixed(2)} tx ${tx.toFixed(2)}`);
        hand.push(q); gaps.add(x, z); (env.keep ??= []).push({ x, z, r: h.keep });
        const dx = x - h.view.x, dz = z - h.view.z, dd = dmath.hypot(dx, dz);
        (env.cones ??= []).push({ x: h.view.x, z: h.view.z, fx: dx / dd, fz: dz / dd, cos: dmath.cos(4.5 * D2R), d0: dd + 3, d1: dd + 160 });
        // (no broadleaf canopy behind the hero palm's crown) ±10° around the CROWN as
        // seen from the camera, widened by a big crown's angular radius — the crown stands against the sky
        const tx0 = x + (tip[0] * c + tip[2] * sn) * sc - h.view.x, tz0 = z + (-tip[0] * sn + tip[2] * c) * sc - h.view.z, td = dmath.hypot(tx0, tz0);
        env.cones.push({ x: h.view.x, z: h.view.z, fx: tx0 / td, fz: tz0 / td, cos: dmath.cos(10 * D2R), d0: Math.max(4, td - 6), d1: td + 220, crownR: 9 });
        done = true; break;
      }
      if (done) break;
    }
  }
  if (rules === BIG_RULES) for (const p of HAND_PLACED) {
    // the terrain may move trails / biomes: drop any piece that would stand on the trail, water or a POI
    const b = t.biomeAt(p.x, p.z);
    const onTrail = b === Biome.Path && p.kind !== "vine" && (COLLIDABLE.has(p.kind) || !nearOffTrail(t, p.x, p.z, 2.2));
    if (b === Biome.Paved || b === Biome.DeepOcean || b === Biome.Reef || b === Biome.Lagoon || onTrail || (COLLIDABLE.has(p.kind) && p.kind !== "log" && nearBlocked(t, p.x, p.z, 1.5)) || nearPad(p.x, p.z, 0) || inClearing(p.x, p.z, clearings)) continue;
    const ys = seatPlant(t, p.kind, p.variant, p.x, p.z, p.yaw, p.scale, false, ri);
    if (ys === null) continue;
    const y = ys + (p.dy ?? 0);
    if (inPoiVolume(p.kind, p.variant, p.x, y, p.z, p.yaw, p.scale, false)) continue;
    hand.push({ kind: p.kind, variant: p.variant, x: p.x, y, z: p.z, yaw: p.yaw, scale: p.scale });
    if (COLLIDABLE.has(p.kind)) gaps.add(p.x, p.z);          // decorative pieces never displace the scattered trees
  }
  rules.forEach((rule, i) => runRule(t, rule, clearings, gaps, noise, out, [-H, -H, H, H], i + 1, env));
  if (rules === BIG_RULES) out = thinTrees(t, hand, out);
  if (rules === BIG_RULES) out.push(...anchoredVines(t, clearings, hand.concat(out)));
  if (rules === BIG_RULES) out.push(...palmLitter(t, clearings, hand.concat(out), env.rocks));
  if (env.rocks) {
    out = out.filter((p) => !COLLIDABLE.has(p.kind) || !buriedInRock(env.rocks!, p));
    if (rules === BIG_RULES) out.push(...rockCapPlants(env.rocks, clearings, t));
  }
  return hand.concat(out);
}

/** the tall trees the forest thinning counts (the species that stand as far canopy / skyline) */
const THIN_KINDS: ReadonlySet<VegKind> = new Set<VegKind>(["jungle-tree", "palm", "palm-leaning", "mangrove", "bamboo"]);
/** share of the tall trees the thinning removes (at least 15 % fewer trees) */
const THIN_SHARE = 0.17;
/** no species loses more than this share */
const THIN_KIND_CAP = 0.24;
/** neighbourhood radius (m) of the density the thinning reads */
const THIN_R = 16;
/**
 * Forest thinning: ~17 % fewer tall trees, deterministic, and only where the forest is
 * densest. Every scattered tall tree (hand-placed, glade and hero trees never) gets its local density (tall trees,
 * incl. the hand-placed ones, within 16 m); the densest is removed first, its neighbours' densities drop, repeat — so
 * dense clumps and repeated filler thin out evenly and nothing gets hollowed. Never removed: trees with ≤ 3 neighbours
 * (forest edges, lone silhouettes, small groves — 16 m), trees within 9 m of a dirt road (roadside cover + silhouettes), trees
 * inside a POI's area (r · 0.8 + 12 m: the cover players fight around), the coast's palm fringe (≤ 14 m from the
 * sand) and the beach's leaning palms (designed pairs / trios along the coast). Runs before the vines / palm litter, so those follow the surviving crowns.
 */
function thinTrees(t: Terrain, hand: VegInstance[], out: VegInstance[]): VegInstance[] {
  const all: VegInstance[] = [];
  for (const p of hand) if (THIN_KINDS.has(p.kind)) all.push(p);
  const firstOut = all.length;
  for (const p of out) if (THIN_KINDS.has(p.kind)) all.push(p);
  const n = all.length;
  if (!n) return out;
  // THIN_R grid of every tall tree
  const G = THIN_R, grid = new Map<number, number[]>();
  const gk = (gx: number, gz: number) => (gx + 4096) * 8192 + gz + 4096;
  for (let i = 0; i < n; i++) { const k = gk(Math.floor(all[i].x / G), Math.floor(all[i].z / G)); let a = grid.get(k); if (!a) grid.set(k, (a = [])); a.push(i); }
  const nbr: number[][] = new Array(n);
  const dens = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = all[i], gx = Math.floor(p.x / G), gz = Math.floor(p.z / G), l: number[] = [];
    for (let u = -1; u <= 1; u++) for (let w = -1; w <= 1; w++) for (const j of grid.get(gk(gx + u, gz + w)) ?? []) {
      const dx = all[j].x - p.x, dz = all[j].z - p.z;   // (squared, no Math.hypot: bit-identical in every JS engine — world hash)
      if (j !== i && dx * dx + dz * dz < THIN_R * THIN_R) l.push(j);
    }
    nbr[i] = l; dens[i] = l.length;
  }
  // candidates: scattered (not hand / hero), not protected
  const cand = new Uint8Array(n);
  const kindN = new Map<VegKind, number>(), kindCut = new Map<VegKind, number>();
  for (const p of all) kindN.set(p.kind, (kindN.get(p.kind) ?? 0) + 1);
  for (let i = firstOut; i < n; i++) {
    const p = all[i];
    if (p.hero || p.kind === "palm-leaning") continue;
    if (POIS.some((q) => { const dx = p.x - q.x, dz = p.z - q.z, r = q.r * 0.8 + 12; return dx * dx + dz * dz < r * r; })) continue;
    if (nearestRoad(t, p.x, p.z).d < 9) continue;
    // the coast's palm fringe (within 14 m of the sand): the island's skyline from the sea and the drop
    if (t.biomeAt(p.x, p.z) === Biome.Beach || RING8.some(([c, s]) => t.biomeAt(p.x + c * 14, p.z + s * 14) === Biome.Beach || t.biomeAt(p.x + c * 7, p.z + s * 7) === Biome.Beach)) continue;
    cand[i] = 1;
  }
  // deterministic tie-break (position hash, < 1 neighbour's worth)
  const jit = new Float64Array(n);
  for (let i = 0; i < n; i++) jit[i] = (hash2(Math.round(all[i].x * 10), Math.round(all[i].z * 10), 9127) % 1000) / 1000 * 0.9;
  const dead = new Uint8Array(n);
  const target = Math.ceil(n * THIN_SHARE);
  let cut = 0;
  while (cut < target) {
    let best = -1, bs = -1;
    for (let i = firstOut; i < n; i++) {
      if (!cand[i] || dead[i] || dens[i] <= 3) continue;
      const p = all[i];
      if ((kindCut.get(p.kind) ?? 0) + 1 > (kindN.get(p.kind) ?? 0) * THIN_KIND_CAP) continue;
      const s = dens[i] + jit[i];
      if (s > bs) { bs = s; best = i; }
    }
    if (best < 0) break;
    dead[best] = 1; cut++;
    kindCut.set(all[best].kind, (kindCut.get(all[best].kind) ?? 0) + 1);
    for (const j of nbr[best]) dens[j]--;
  }
  const gone = new Set<VegInstance>();
  for (let i = firstOut; i < n; i++) if (dead[i]) gone.add(all[i]);
  return out.filter((p) => !gone.has(p));
}

/** model-space geometry of the two vine variants (client/src/world/veg/species/canopy.ts buildVine): the span between
 *  the rope's two ends along +X, the ends' height, and the lowest leaf / tendril tip */
const VINE_GEO: ReadonlyArray<{ span: number; endY: number; lowY: number; p: number }> = [
  { span: 13, endY: 11.9, lowY: 5.9, p: 0.55 },   // 0 liana loops: ends 12.2 / 11.6, sag 3.6, tendrils ≤ 2.3 m
  { span: 8.5, endY: 13.0, lowY: 5.2, p: 0.35 },  // 1 leafy curtain: ends 13.2 / 12.8, sag 1.9, strands ≤ 5.8 m
];
/** hanging lianas / leafy vine curtains ONLY where two real jungle-tree crowns hold them, inside the
 *  deep-jungle stands: both rope ends sit inside a crown (≤ ½ crown radius in from its centre, 1 m into its leaf band
 *  from below, 1.5 m under its top), the lowest leaf hangs ≥ 3.2 m over the ground under the whole span, no vine over a
 *  trail / road (6 m), a POI pad or clearing, ≥ 24 m between vines. Deterministic (pair hash) — client only draws them
 *  (not collidable), but they stay in the shared scatter so every tool sees the same list. */
function anchoredVines(t: Terrain, clearings: Clearing[], plants: VegInstance[]): VegInstance[] {
  type Crown = { x: number; z: number; r: number; lo: number; hi: number; y: number };
  const crowns: Crown[] = [];
  for (const p of plants) {
    if (p.kind !== "jungle-tree") continue;
    const f = crownFootprint(p.kind, p.variant), band = crownBand(p.kind, p.variant);
    if (!f || !band) continue;
    if (!deepJungleAt(t, p.x, p.z, nearestRoad(t, p.x, p.z).d)) continue;
    const c = dmath.cos(p.yaw), s = dmath.sin(p.yaw);
    crowns.push({ x: p.x + (f.x * c + f.z * s) * p.scale, z: p.z + (-f.x * s + f.z * c) * p.scale, r: f.r * p.scale, lo: p.y + band[0] * p.scale, hi: p.y + band[1] * p.scale, y: p.y });
  }
  const G = 16, grid = new Map<number, number[]>();
  const gk = (gx: number, gz: number) => (gx + 4096) * 8192 + gz + 4096;
  crowns.forEach((c, i) => { const k = gk(Math.floor(c.x / G), Math.floor(c.z / G)); let a = grid.get(k); if (!a) grid.set(k, (a = [])); a.push(i); });
  const out: VegInstance[] = [];
  const gaps = new GapGrid(8);
  for (let i = 0; i < crowns.length; i++) {
    const A = crowns[i], gx = Math.floor(A.x / G), gz = Math.floor(A.z / G);
    for (let u = -1; u <= 1; u++) for (let w = -1; w <= 1; w++) for (const j of grid.get(gk(gx + u, gz + w)) ?? []) {
      if (j <= i) continue;
      const B = crowns[j], dx = B.x - A.x, dz = B.z - A.z, d = dmath.hypot(dx, dz);
      if (d < 6) continue;
      for (let v = 0; v < VINE_GEO.length; v++) {
        const V = VINE_GEO[v];
        const sc = Math.min(1.2, Math.max(0.8, d / V.span)), L = V.span * sc, inset = d - L;
        if (inset < 0 || inset > 0.5 * (A.r + B.r)) continue;
        const ux = dx / d, uz = dz / d, a0 = inset * A.r / (A.r + B.r) + L / 2;
        const mx = A.x + ux * a0, mz = A.z + uz * a0;
        if (dHash(mx, mz, 6151 + v * 7) > V.p) continue;
        // the rope's ends inside both crowns' leaf bands
        const lo = Math.max(A.lo, B.lo) + 1.0, hi = Math.min(A.hi, B.hi) - 1.5;
        if (hi < lo) continue;
        const H = lo + (hi - lo) * 0.35, y = H - V.endY * sc;
        // head room under the whole span, off trails / pads / clearings, spaced out
        let g = -1e9, gLo = 1e9;
        for (let k = 0; k <= 6; k++) { const q = k / 6 - 0.5, h = t.height(mx + ux * q * L, mz + uz * q * L); g = Math.max(g, h); gLo = Math.min(gLo, h); }
        if (y + V.lowY * sc < g + 3.2 || gLo < 1.5 || y < 0.6) continue;
        const wm = spawnMaskAt(t, mx, mz); if (wm && wm[0] > t.height(mx, mz) - 0.5) continue;   // not over a drawn river / pool
        if (nearBlocked(t, mx, mz, 6) || nearPad(mx, mz, 6) || inClearing(mx, mz, clearings) || gaps.tooClose(mx, mz, 24)) continue;
        if (t.biomeAt(mx, mz) !== Biome.Jungle) continue;
        out.push({ kind: "vine", variant: v, x: mx, y, z: mz, yaw: dmath.atan2(-uz, ux), scale: sc });
        gaps.add(mx, mz);
        break;
      }
    }
  }
  return out;
}

/**
 * Palm litter (coconuts and dry fronds lie on the sand under the palms): under every
 * palm whose crown hangs over sand or the beach edge, 0–3 pieces (fallen nuts, a dry frond, a split husk) scattered
 * under the crown's ground projection. Decorative (no colliders); deterministic from the palm's position.
 */
function palmLitter(t: Terrain, clearings: Clearing[], plants: VegInstance[], rocks?: RockIndex): VegInstance[] {
  const out: VegInstance[] = [];
  for (const p of plants) {
    if (p.kind !== "palm" && p.kind !== "palm-leaning") continue;
    const s = palmShape(p.variant % 3, p.kind === "palm-leaning"), tip = s.pts[s.pts.length - 1];
    const c = dmath.cos(p.yaw), sn = dmath.sin(p.yaw);
    const cx = p.x + (tip[0] * c + tip[2] * sn) * p.scale, cz = p.z + (-tip[0] * sn + tip[2] * c) * p.scale;
    const b = t.biomeAt(cx, cz);
    const sandy = b === Biome.Beach || t.biomeAt(p.x, p.z) === Biome.Beach;
    if (!sandy && b !== Biome.Grass) continue;
    const rnd = mulberry32(hash2(Math.round(p.x * 10), Math.round(p.z * 10), 9091));
    const n = sandy ? Math.floor(rnd() * 3.2) : rnd() < 0.3 ? 1 : 0;
    for (let k = 0; k < n; k++) {
      const a = rnd() * Math.PI * 2, d = 0.6 + rnd() * 2.6;
      const x = cx + dmath.cos(a) * d, z = cz + dmath.sin(a) * d, y = t.height(x, z);
      const bb = t.biomeAt(x, z);
      if (y < 0.45 || bb === Biome.Path || bb === Biome.Paved || bb === Biome.DeepOcean || bb === Biome.Reef || bb === Biome.Lagoon) continue;
      if (nearPad(x, z, 1) || inClearing(x, z, clearings) || slopeAt(t, x, z) > 0.5) continue;
      const r = rnd(), variant = r < 0.5 ? 0 : r < 0.78 ? 1 : 2;
      const q: VegInstance = { kind: "litter", variant, x, y, z, yaw: rnd() * Math.PI * 2, scale: 0.9 + rnd() * 0.25 };
      if (inPoiVolume(q.kind, q.variant, x, y, z, q.yaw, q.scale, true)) continue;
      const ys = seatPlant(t, "litter", variant, x, z, q.yaw, q.scale, true, rocks);
      if (ys !== null) { q.y = ys; out.push(q); }
    }
  }
  return out;
}

/**
 * The flat mossy tops of stacks / cliff-lip blocks (terrain rocks with cap === 1): a bush, ferns, now and then a
 * monstera or banana growing up there. DECORATIVE kinds only — the server replays the scatter without
 * the rock list, so nothing collidable may depend on it.
 */
function rockCapPlants(rocks: RockIndex, clearings: Clearing[], t?: Terrain): VegInstance[] {
  const out: VegInstance[] = [];
  const KINDS: VegKind[] = ["bush", "fern", "fern", "bush", "monstera", "banana-plant"];
  for (const r of rocks.list) {
    if (r.cap !== 1) continue;
    if (inClearing(r.x, r.z, clearings) || nearPad(r.x, r.z, 2)) continue;
    const rnd = mulberry32(hash2(Math.round(r.x * 10), Math.round(r.z * 10), 7771));
    const top = r.y + r.sy * 0.5 - 0.08, reach = Math.min(r.sx, r.sz) * 0.26;
    // (the tall stacks / crags set in cliffs draw a narrower, rounder cap than their collider box: shrubs there would
    // float up the canyon walls) only low boulders on gentle ground carry plants
    if (t && (top - t.height(r.x, r.z) > 2.2 || slopeAt(t, r.x, r.z) > 0.55)) continue;
    // (1–2 plants per cap)
    const n = 1 + Math.floor(rnd() * 2.3);
    for (let k = 0; k < n; k++) {
      const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * reach;
      const kind = KINDS[Math.floor(rnd() * (k === 0 ? 2 : KINDS.length))];
      const q: VegInstance = { kind, variant: Math.floor(rnd() * VARIANTS[kind]), x: r.x + dmath.cos(a) * d, y: top, z: r.z + dmath.sin(a) * d, yaw: rnd() * Math.PI * 2, scale: 0.7 + rnd() * 0.45 };
      if (inPoiVolume(q.kind, q.variant, q.x, q.y, q.z, q.yaw, q.scale, false)) continue;
      // only on a real, open, supported cap: not inside the terrain (a rock embedded in a cliff), no rock
      // above it, the footprint fully on the rock (no plant hanging off the lip)
      if (t && t.height(q.x, q.z) > top - 0.05) continue;
      const R = rockBoxes(rocks)!;
      if (R.hits(q.x, top + 0.9, top + 3, q.z, 0)) continue;
      // nor under a DRAWN slab / overhang (the spawn mask)
      if (t && maskRejects(t, q.kind, q.x, q.y, q.z, 0, 6)) continue;
      const fr = (SEAT[kind]?.[0] ?? 0.4) * q.scale * 0.8;
      let onCap = true;
      for (let k = 0; k < 4 && onCap; k++) { const b = k * 1.5707963 + 0.4; if (!R.hits(q.x + dmath.cos(b) * fr, top - 0.35, top - 0.05, q.z + dmath.sin(b) * fr, 0)) onCap = false; }
      if (onCap) out.push(q);
    }
  }
  return out;
}

/** a collidable plant whose trunk base or lower trunk (0–4 m) passes through a terrain rock */
function buriedInRock(rocks: RockIndex, p: VegInstance): boolean {
  if (rocks.near(p.x, p.z, 6, p.y + 0.3) < 0.5) return true;
  if (p.kind === "palm" || p.kind === "palm-leaning") {
    const s = palmShape(p.variant, p.kind === "palm-leaning");
    const c = dmath.cos(p.yaw), sn = dmath.sin(p.yaw);
    for (const [mx, my, mz] of s.pts) {
      if (my < 0.5 || my > 5.5) continue;
      const wx = p.x + (mx * c + mz * sn) * p.scale, wz = p.z + (-mx * sn + mz * c) * p.scale;
      if (rocks.near(wx, wz, 6, p.y + my * p.scale) < 0.2) return true;
    }
  }
  return false;
}

/** detail plants (grass / flowers / ferns) inside one DETAIL_CELL cell (cx, cz = cell indices) */
export function detailCell(t: Terrain, clearings: Clearing[], cx: number, cz: number, rules: Rule[] = DETAIL_RULES, noise?: Simplex2, env: ScatterEnv = {}): VegInstance[] {
  const out: VegInstance[] = [];
  const gaps = new GapGrid(4);
  const n = noise ?? new Simplex2(WORLD.SEED + 101);
  const x0 = cx * DETAIL_CELL, z0 = cz * DETAIL_CELL;
  rules.forEach((rule, i) => runRule(t, rule, clearings, gaps, n, out, [x0, z0, x0 + DETAIL_CELL, z0 + DETAIL_CELL], 100 + i, env));
  return out;
}

// =====================================================================================================================
// colliders — axis-aligned (yaw 0) boxes that hug the visible trunks. Leaning trunks become a stack of boxes that
// follow the curve (a new box whenever the curve drifts > 0.2 m sideways below 3.5 m, > 0.45 m above), so the stack
// sits within ~0.1 m of the rendered trunk from the ground to 3 m. No yawed boxes: the result is independent of the
// yaw sign convention of the consumer.

const rotY = (x: number, z: number, yaw: number): [number, number] => {
  const c = dmath.cos(yaw), s = dmath.sin(yaw);
  return [x * c + z * s, -x * s + z * c];                  // three.js rotation about +Y
};


/** disk-union boxes along a trunk polyline (world samples [x, y, z, r]): pieces of ≤ 1.2 m (≤ 0.4 m drift), k turned
 *  boxes each (the piece's drift widens the along-axis a little) */
function trunkDisks(samples: Array<[number, number, number, number]>, out: Box[], surf: Box["surf"], k: number) {
  let i0 = 0;
  for (let i = 1; i < samples.length; i++) {
    const [x0, y0, z0, r0] = samples[i0], [x, y, z, r] = samples[i];
    if (dmath.hypot(x - x0, z - z0) > (y0 < 3.5 ? 0.12 : 0.25) || Math.abs(r - r0) > 0.06 || y - y0 > 2.0 || i === samples.length - 1) {
      let rm = 0; for (let q = i0; q <= i; q++) rm = Math.max(rm, samples[q][3]);
      diskBoxes(out, [(x0 + x) / 2, (y0 + y) / 2, (z0 + z) / 2], rm, Math.max(0.05, (y - y0) / 2), k, surf, 0.25);
      i0 = i;
    }
  }
}

/** sample a polyline every `step` m of arc length, with a radius callback (arc distance from ground) */
function samplePolyline(pts: Array<[number, number, number]>, ground: number, step: number, radius: (d: number) => number, topD?: number) {
  const out: Array<[number, number, number, number]> = [];
  let d = -ground;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay, az] = pts[i - 1], [bx, by, bz] = pts[i];
    const L = dmath.hypot3(bx - ax, by - ay, bz - az);
    for (let s = 0; s < L; s += step) {
      const f = s / L, dd = d + s;
      if (dd < 0) continue;
      if (topD !== undefined && dd > topD) return out;
      out.push([ax + (bx - ax) * f, ay + (by - ay) * f, az + (bz - az) * f, radius(dd)]);
    }
    d += L;
  }
  const [lx, ly, lz] = pts[pts.length - 1];
  out.push([lx, ly, lz, radius(d)]);
  return out;
}

const shapeCache = new Map<string, unknown>();
const cached = <T>(k: string, f: () => T): T => { let v = shapeCache.get(k) as T | undefined; if (!v) { v = f(); shapeCache.set(k, v); } return v; };

/** the drawn FOOT of a buttress tree in model space: every root plank's foot (canopy.ts buttressTrunk sweeps the
 *  plank from model y −0.35 up to its crest, rootStations k = 0…K) and the trunk tube's sunk bottom ring (y −0.8, 12 points)
 *  as [x, z, depth] — the depth the drawn part reaches under the base */
function treeFoot(variant: number): Array<[number, number, number]> {
  return cached(`treeFoot:${variant % 5}`, () => {
    const s = jungleTreeShape(variant % 5), out: Array<[number, number, number]> = [];
    for (const fl of s.flanges) for (const st of rootStations(s, fl, 6)) out.push([st.x, st.z, 0.35]);
    const [cx, cz] = treeCentreAt(s, -0.8), r = treeRadius(s, -0.8);
    for (let k = 0; k < 12; k++) { const a = (k / 12) * Math.PI * 2; out.push([cx + dmath.cos(a) * r, cz - dmath.sin(a) * r, 0.8]); }
    return out;
  });
}
/** the highest base a buttress jungle tree may stand at so no part of its drawn foot hangs in the air: every root plank's
 *  foot and the trunk's bottom ring reach ≥ 5 cm into the ground under it. On a slope the tree sinks by the drop under its
 *  downhill roots (the uphill roots / trunk bury themselves, like a real tree on a slope). seatPlant clamps every scattered
 *  and hand-placed tree to it (the trunk / root colliders follow p.y: server ≡ client); the client clamps POI plantings. */
export function rootSeatY(t: { height(x: number, z: number): number }, variant: number, x: number, z: number, yaw: number, scale: number): number {
  let y = Infinity;
  for (const [mx, mz, d] of treeFoot(variant)) { const [wx, wz] = rotY(mx, mz, yaw); y = Math.min(y, t.height(x + wx * scale, z + wz * scale) + d * scale - 0.05); }
  return y;
}

/** trunk collision boxes for the server / client prediction (trees, palms, bamboo, mangroves, logs) */
export function vegTrunkColliders(instances: VegInstance[]): Box[] {
  const out: Box[] = [];
  for (const p of instances) {
    const S = p.scale;
    const toWorld = (m: [number, number, number, number]): [number, number, number, number] => {
      const [wx, wz] = rotY(m[0], m[2], p.yaw);
      return [p.x + wx * S, p.y + m[1] * S, p.z + wz * S, m[3] * S];
    };
    switch (p.kind) {
      case "palm": case "palm-leaning": {
        const s = cached(`palm:${p.variant % 3}:${p.kind}`, () => palmShape(p.variant % 3, p.kind === "palm-leaning"));
        // (up to the crown top incl. the fibrous boot under the fronds)
        const loc = cached(`palmS:${p.variant % 3}:${p.kind}`, () => samplePolyline(s.pts, 0.5, 0.1, (d) => Math.max(palmRadius(s, Math.max(0.35, d), 1.0), d > s.h - 0.3 ? 0.27 : 0), s.h + 0.15));
        // (a 2-box disk union per trunk piece, ±4 % — square boxes stick out 25 % at their corners)
        trunkDisks(loc.map(toWorld), out, "wood", 2);
        break;
      }
      case "jungle-tree": {
        // boxes that follow the drawn tube and roots (jungleTreeBoxes)
        const s = cached(`tree:${p.variant % 5}`, () => jungleTreeShape(p.variant % 5));
        const mb = cached(`treeB:${p.variant % 5}`, () => jungleTreeBoxes(s));
        for (const b of mb) {
          const [wx, wz] = rotY(b.c[0], b.c[2], p.yaw), [ax, az] = rotY(b.ux, b.uz, p.yaw);
          out.push({ c: [p.x + wx * S, p.y + b.c[1] * S, p.z + wz * S], h: [b.h[0] * S, b.h[1] * S, b.h[2] * S], yaw: dmath.atan2(az, ax), surf: "wood", round: [p.x, p.z] });
        }
        // the pocket between neighbouring blades is filled wherever it is narrower than a kong can turn in (< 1.7 m
        // between the blade boxes): the kong stands at the pocket's mouth instead of in it. noShoot: bullets still
        // see the gap.
        {
          const fls = s.flanges.slice().sort((a, b) => a.a - b.a);
          for (let k = 0; k < fls.length; k++) {
            const A = fls[k], B = fls[(k + 1) % fls.length];
            // a second, inner station plugs every crevice next to the trunk (a kong dropped into a deep crevice there
            // could not climb out)
            for (const [f, maxGap] of [[0.12, 2.6], [0.33, 1.7]] as const) {
              const qa = flangeAt(s, A, f), qb = flangeAt(s, B, f);
              const pa = [dmath.cos(qa.a) * qa.reach + dmath.sin(qa.a) * qa.lat, -dmath.sin(qa.a) * qa.reach + dmath.cos(qa.a) * qa.lat];
              const pb = [dmath.cos(qb.a) * qb.reach + dmath.sin(qb.a) * qb.lat, -dmath.sin(qb.a) * qb.reach + dmath.cos(qb.a) * qb.lat];
              const gap = dmath.hypot(pa[0] - pb[0], pa[1] - pb[1]) * S;
              if (gap > maxGap || gap < 0.2) continue;
              const [wx, wz] = rotY((pa[0] + pb[0]) / 2 * 0.92, (pa[1] + pb[1]) / 2 * 0.92, p.yaw);
              const hh = Math.min(qa.h, qb.h) * S * 0.9, half = gap * 0.4;
              if (hh < 0.35) continue;
              out.push({ c: [p.x + wx * S, p.y + hh / 2 - 0.15, p.z + wz * S], h: [half, hh / 2 + 0.15, half], surf: "wood", noShoot: true, round: [p.x, p.z] });
            }
          }
        }
        break;
      }
      case "mangrove": {
        // (the trunk tube and every drawn prop root get bullet boxes — mangroveBoxes; the root cage stays a
        // walk-only box)
        const mb = cached(`mangB:${p.variant % 3}`, () => mangroveBoxes(p.variant % 3));
        for (const b of mb) {
          const [wx, wz] = rotY(b.c[0], b.c[2], p.yaw), [ax, az] = rotY(b.ux, b.uz, p.yaw);
          out.push({ c: [p.x + wx * S, p.y + b.c[1] * S, p.z + wz * S], h: [b.h[0] * S, b.h[1] * S, b.h[2] * S], yaw: dmath.atan2(az, ax), surf: "wood", noWalk: b.root || undefined });
        }
        out.push({ c: [p.x, p.y + 0.3 * S, p.z], h: [1.1 * S, 0.9 * S, 1.1 * S], surf: "wood", noShoot: true });
        break;
      }
      case "bamboo": {
        // (every cane, not one box round the clump — bullets pass between the canes like they look)
        const mb = cached(`bambooB:${p.variant % 2}`, () => bambooBoxes(p.variant % 2));
        for (const b of mb) {
          const [wx, wz] = rotY(b.c[0], b.c[2], p.yaw), [ax, az] = rotY(b.ux, b.uz, p.yaw);
          out.push({ c: [p.x + wx * S, p.y + b.c[1] * S, p.z + wz * S], h: [b.h[0] * S, b.h[1] * S, b.h[2] * S], yaw: dmath.atan2(az, ax), surf: "wood", round: [p.x, p.z] });
        }
        // a walk-only core inside the cane ring (noShoot: bullets still pass between the canes) — no way in, no trap
        diskBoxes(out, [p.x, p.y + 2.1 * S, p.z], BAMBOO.r * 0.78 * S, 2.3 * S, 2, "wood", 0.5);
        out[out.length - 1].noShoot = true; out[out.length - 2].noShoot = true;
        break;
      }
      case "log": {
        const s = logShape(p.variant);
        const n = Math.max(2, Math.round(s.L / (s.R * 1.8)));
        const [ax, az] = rotY(1, 0, p.yaw);
        for (let k = 0; k < n; k++) {
          const u = ((k + 0.5) / n - 0.5) * s.L * S;
          const r = s.R * (1 - 0.12 * ((k + 0.5) / n)) * S;
          out.push({ c: [p.x + ax * u, p.y + r * 0.78, p.z + az * u], h: [r * 0.95, r * 0.85, r * 0.95], surf: "wood" });
        }
        break;
      }
      default: break;
    }
  }
  return out;
}

/** the one call for the server / client prediction: replay the scatter and return trunk colliders. `rocks` =
 * terrainRocks(td) — REQUIRED for parity with what the client renders (it filters trunks buried in rock). */
export function vegCollidersFor(t: Terrain, clearings: Clearing[], rocks: RockInstance[] | RockIndex): Box[] {
  return vegTrunkColliders(scatterVegetation(t, clearings, BIG_RULES, rocks));
}

/** the static-world entry point (shared/sim/static-world.ts → shared/sim/veg-colliders.ts): trunk-following boxes for
 * exactly the plants the client draws — rocks computed from the same TerrainData bytes the renderer uses */
export function vegStaticColliders(t: Terrain, td: TerrainData, clearings: Clearing[]): Box[] {
  return vegCollidersFor(t, clearings, terrainRocks(td));
}
/** the same plants + their trunk boxes in one pass: the climbable giant trees are picked from
 *  exactly the trees the client draws (shared/pois/climb-trees.ts) */
export function vegStaticPlants(t: Terrain, td: TerrainData, clearings: Clearing[]): { plants: VegInstance[]; boxes: Box[] } {
  const plants = scatterVegetation(t, clearings, BIG_RULES, terrainRocks(td));
  return { plants, boxes: vegTrunkColliders(plants) };
}

export const vegSmooth = smoothstep;
