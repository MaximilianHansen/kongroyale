// POI coconut-cove — abandoned pastel beach resort (S coast). Deterministic layout (hotel, raised pool terrace, tiki bar,
// terraces, beach hut, annex, pier, stilt bungalows, dressing) + colliders + clearings. Pure TS; the client module builds
// visuals from LAYOUT, the server collides against `colliders`. The terrain is flat at Y = 4 over x −10…190, z 330…505;
// the beach falls to the sea between z ≈ 505 and 540.
//
// Composition (target art poi-05-coconut-cove) is built around the view camera on the NORTH garden terrace looking
// south toward the sea with the sun (az −32°, NNW) behind it: the compact serpentine hotel runs away from the camera
// on the LEFT (east side, its arcaded facade facing west into the light, the porthole wing turned toward the camera),
// the kidney pool on its raised limestone deck sits centre-left in front of it, the tiki bar lower-left, umbrellas +
// loungers round the pool, the beach hut + pier + stilt bungalows on the right over the turquoise bay.
//
// The pool is a RAISED terrace (so the deck, the sand disc and the terrain heightfield never pave over it):
// deck top Y+1.2 on a limestone plinth, coping, water Y+1.0, floor Y+0.06 — nothing covers it, and its colliders are
// derived from the same numbers (ring of deck boxes + floor; walk in, wade, climb out by the steps).
import type { Box } from "../world/colliders";
import { poiById } from "../world/map";
import { type TownBuilding, type BuildingParts, type Deck, resolveBuilding, buildingColliders, deckColliders, deckGap, walkway, mulberry, simBoxes, type Clearing, buildingRooms, townInteriors, townLootSpots, type TownInteriorBake, coverScatter, gridH, type GroundGrid, palmBoxes, rockBoxes } from "./town-kit";
import SLOPE from "./mango-slope.json";
import type { InteriorRoom } from "./interior-kit";
import TOWN_INT from "./town-interiors.json";
import { settleLoot } from "./coast-kit";
import { HOTEL, hotelColliders, HotelPath, hotelLayout, hotelRooms, pavFrame, PLINTH } from "./town-hotel";
import * as dmath from "../sim/dmath";

const P = poiById("coconut-cove");
export const CX = P.x, CZ = P.z, Y = P.padY as number;

type V2 = [number, number];

// ---------------------------------------------------------------- view camera (shared so the layout can be tested against it)
/** view frame: camera C, heading TH (from +z toward +x); V(f, r) = f metres ahead, r metres to the screen RIGHT */
const CAM: V2 = [46, 424], TH = 22 * Math.PI / 180;
export const V = (f: number, r: number): V2 => [CAM[0] + f * dmath.sin(TH) - r * dmath.cos(TH), CAM[1] + f * dmath.cos(TH) + r * dmath.sin(TH)];
const VT = V(110, -3.5);
/** the camera stands 4.5 m forward of the terrace frame origin (over the planted front edge) with a slightly longer
 *  lens, so the hotel fills ~45 % of the width like the target art */
const VP0 = V(4.5, -0.8);
export const VIEW = { pos: [VP0[0], Y + 11.4, VP0[1]] as [number, number, number], target: [VT[0], Y - 4.2, VT[1]] as [number, number, number], fov: 54 };

// ---------------------------------------------------------------- pool (raised terrace)
export const POOL_C: V2 = [69, 469];
/** long-axis direction of the kidney (world XZ, radians from +x): mostly N–S so it spreads across the view */
const POOL_PHI = 1.36;
/** kidney outline (closed, world XZ, counter-clockwise in x/z) */
export const POOL: V2[] = (() => {
  const pts: V2[] = [];
  const n = 44, ca = dmath.cos(POOL_PHI), sa = dmath.sin(POOL_PHI);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    // bean: 13 × 8 along the facade, a bite on the hotel (east) side, a bulge toward the camera side
    const r = 1 + 0.14 * dmath.cos(a * 2 + 0.5) - 0.1 * dmath.sin(a - 0.3);
    const lx = dmath.cos(a) * 14 * r, lz = dmath.sin(a) * 8.5 * r - 1.6 * dmath.cos(a * 2);
    pts.push([POOL_C[0] + lx * ca - lz * sa, POOL_C[1] + lx * sa + lz * ca]);
  }
  return pts;
})();
export const DECK_TOP = Y + 1.2, COPING_TOP = Y + 1.28, POOL_WATER_Y = Y + 1.0, POOL_FLOOR_Y = Y + 0.06;
/** flagstone deck = pool outline offset by DECK_PAD; the coping ring is the first COPING_W metres */
export const DECK_PAD = 3.6, COPING_W = 0.62;
/** planter island in the pool */
export const ISLAND = { x: POOL_C[0] + 2.2, z: POOL_C[1] + 3.6, r: 1.7 };

/** offset a closed polygon (smooth outlines) outward by d — pure TS twin of town-geo offsetPoly */
export function offsetPolyTS(pts: V2[], d: number): V2[] {
  const n = pts.length, out: V2[] = [];
  let area = 0; for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n]; area += a[0] * b[1] - b[0] * a[1]; }
  const sgn = area > 0 ? 1 : -1;
  for (let i = 0; i < n; i++) {
    const p = pts[(i + n - 1) % n], c = pts[i], q = pts[(i + 1) % n];
    const e1 = [c[0] - p[0], c[1] - p[1]], e2 = [q[0] - c[0], q[1] - c[1]];
    const l1 = dmath.hypot(e1[0], e1[1]) || 1, l2 = dmath.hypot(e2[0], e2[1]) || 1;
    const n1 = [e1[1] / l1 * sgn, -e1[0] / l1 * sgn], n2 = [e2[1] / l2 * sgn, -e2[0] / l2 * sgn];
    let nx = n1[0] + n2[0], nz = n1[1] + n2[1]; const l = dmath.hypot(nx, nz) || 1; nx /= l; nz /= l;
    const k = 1 / Math.max(0.5, nx * n1[0] + nz * n1[1]);
    out.push([c[0] + nx * d * k, c[1] + nz * d * k]);
  }
  return out;
}
export const DECK: V2[] = offsetPolyTS(POOL, DECK_PAD);

/** a straight flight of steps going DOWN from (x, z) at yTop along (dirX, dirZ) to yBottom */
export interface Flight { x: number; z: number; dirX: number; dirZ: number; width: number; yTop: number; yBottom: number; steps: number; rise: number; tread: number }
export function flight(x: number, z: number, dirX: number, dirZ: number, yTop: number, yBottom: number, width = 3.2, tread = 0.34): Flight {
  const l = dmath.hypot(dirX, dirZ) || 1, steps = Math.max(1, Math.round((yTop - yBottom) / 0.2));
  return { x, z, dirX: dirX / l, dirZ: dirZ / l, width, yTop, yBottom, steps, rise: (yTop - yBottom) / steps, tread };
}
/** deck point + outward normal at pool-outline index i (the deck edge) */
function deckEdge(i: number): { p: V2; n: V2 } {
  const n = DECK.length, a = DECK[(i + n - 1) % n], b = DECK[(i + 1) % n], p = DECK[i];
  let dx = b[0] - a[0], dz = b[1] - a[1]; const l = dmath.hypot(dx, dz) || 1; dx /= l; dz /= l;
  // outward = away from the pool centre
  let nx = dz, nz = -dx; if ((p[0] - POOL_C[0]) * nx + (p[1] - POOL_C[1]) * nz < 0) { nx = -nx; nz = -nz; }
  return { p: [p[0] - nx * 0.02, p[1] - nz * 0.02], n: [nx, nz] };
}
/** index on the deck outline closest to a world bearing (radians, world xz) from the pool centre */
function deckIndexToward(a: number): number {
  let best = 0, bd = -2;
  for (let i = 0; i < DECK.length; i++) { const d = DECK[i]; const v = dmath.cos(a) * (d[0] - POOL_C[0]) + dmath.sin(a) * (d[1] - POOL_C[1]); const l = dmath.hypot(d[0] - POOL_C[0], d[1] - POOL_C[1]) || 1; if (v / l > bd) { bd = v / l; best = i; } }
  return best;
}
/** the pool deck's flights down to the sand: west (tiki / camera), south (beach), east (annex terrace) */
export const DECK_FLIGHTS: Flight[] = [-Math.PI * 0.62, Math.PI * 0.62, Math.PI * 0.9].map((a) => { const e = deckEdge(deckIndexToward(a)); return flight(e.p[0], e.p[1], e.n[0], e.n[1], DECK_TOP, Y); });

// ---------------------------------------------------------------- terraces
/** a curved limestone terrace (annular sector) with a parapet on its front edge and a flight down the middle */
export interface Terrace { cx: number; cz: number; r0: number; r1: number; a0: number; a1: number; y: number; /** which radius is the front (parapet + steps) */ front: "r0" | "r1"; /** angle of the flight (default: the middle) */ stair?: number; /** front edge planted instead of balustraded */ planted?: boolean }
/** raised curved terrace SOUTH of the pool deck, beyond it from the camera (the target art's limestone steps up to a raised
 *  curved terrace with a low wall, right of the pool) */
export const EAST_TERRACE: Terrace = { cx: 69, cz: 469, r0: 20, r1: 27, a0: 1.75, a1: 2.5, y: Y + 1.8, front: "r0" };
/** the north garden terrace the view camera looks from: a raised lookout garden (flight down its SW side, planted
 *  front edge = the frame's foreground foliage) */
export const WEST_TERRACE: Terrace = (() => { const c = V(-6.5, 0.5); return { cx: c[0], cz: c[1], r0: 0, r1: 10.5, a0: 0.55, a1: 2.75, y: Y + 6.6, front: "r1", stair: 2.05, planted: true } as Terrace; })();
export const TIKI = { x: 66.7, z: 441.4, r: 3.6 };

export interface CoveProp {
  kind: "umbrella" | "lounger" | "lamp" | "planter" | "rock" | "palm" | "palm-leaning" | "banana-plant" | "monstera" | "fern" | "bush" | "flowers" | "grass" | "crate" | "pot" | "bench" | "sign" | "frond" | "table" | "towel";
  x: number; z: number; yaw: number; y?: number; v?: number; s?: number;
}
export interface CoveLayout {
  buildings: TownBuilding[]; parts: BuildingParts[];
  pier: Deck[]; bungalowDecks: Deck[];
  props: CoveProp[];
  /** sand patch outline (world XZ, closed) — the client feathers its edge into the terrain */
  sand: V2[];
  /** stepping-stone paths (segments) — the client lays them, the dressing keeps clear of them */
  paths: Array<[V2, V2]>;
  /** timber stairs off the pier (beach + swim-out) — steps = colliders, drawn by the client */
  stairs: Flight[];
}

// ---------------------------------------------------------------- the PALM HILL (the target art's hill with palms +
// a ruin behind the pool, right of the hotel's far end): a grassy mound on the pad's south-east corner, a flat summit
// with a broken limestone arch, palms and banana clumps. Walkable: its collider is concentric octagon terraces 0.35 m
// apart whose tops sit in the middle of the drawn slope (parity: ≤ 0.18 m off the drawn ground everywhere).
export const HILL = { x: 88, z: 517, R: 13.5, H: 6.6, rp: 2.6 };
/** drawn height of the hill above the pad at radius r */
// (a soft DOME — half cone, half smoothstep: a gentle skirt into the sand, a rounded summit; a straight
//  cone reads as a placeholder. Steepest 37°, ≤ 0.46 m between the 0.6 m collider columns: still walkable everywhere)
export function hillH(r: number): number { const { R, H, rp } = HILL; if (r >= R) return 0; if (r <= rp) return H; const t = (R - r) / (R - rp); return H * (0.5 * t + 0.5 * t * t * (3 - 2 * t)); }
const GRID: GroundGrid = (SLOPE as unknown as { grids: Record<string, GroundGrid> }).grids["coconut-cove"];

// ---------------------------------------------------------------- footprint tests (dressing must stay out of buildings)
const HP = new HotelPath(HOTEL.path);
/** hotel footprint polygon (facade offset −m in front, back + m behind, ends ± m) */
export function hotelFootprint(m = 0): V2[] {
  const out: V2[] = [], n = Math.ceil(HP.L / 2);
  for (let i = 0; i <= n; i++) out.push(HP.pt(HP.L * i / n, -m - 0.4));
  for (let i = n; i >= 0; i--) out.push(HP.pt(HP.L * i / n, HOTEL.depth + m));
  const f0 = HP.at(0), fL = HP.at(HP.L);
  out[0] = [out[0][0] - f0.d[0] * m, out[0][1] - f0.d[1] * m];
  out[n] = [out[n][0] + fL.d[0] * m, out[n][1] + fL.d[1] * m];
  out[n + 1] = [out[n + 1][0] + fL.d[0] * m, out[n + 1][1] + fL.d[1] * m];
  out[out.length - 1] = [out[out.length - 1][0] - f0.d[0] * m, out[out.length - 1][1] - f0.d[1] * m];
  return out;
}
export function inPoly(pts: V2[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, zi] = pts[i], [xj, zj] = pts[j];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
const HOTEL_KEEP = hotelFootprint(1.2);
const DECK_KEEP = offsetPolyTS(POOL, DECK_PAD + 0.6);

function genLayout(): CoveLayout {
  const rng = mulberry(5150);
  const buildings: TownBuilding[] = [], props: CoveProp[] = [], paths: Array<[V2, V2]> = [];
  const free = (x: number, z: number, r = 0.8) => !inPoly(HOTEL_KEEP, x, z) && !inPoly(DECK_KEEP, x, z) && dmath.hypot(x - TIKI.x, z - TIKI.z) > TIKI.r + r && !blocked(x, z, r) && dmath.hypot(x - HILL.x, z - HILL.z) > HILL.R + r;
  const taken: Array<[number, number, number]> = [];
  const blocked = (x: number, z: number, r: number) => taken.some(([tx, tz, tr]) => dmath.hypot(x - tx, z - tz) < tr + r);
  const take = (x: number, z: number, r: number) => taken.push([x, z, r]);

  // ---- beach hut (pink/cream, pointed gable roof) near the pier head, porch toward the camera
  // (clear of the east terrace — any closer, its front wall stands inside the terrace fan and the door opens onto a
  //  1.8 m retaining wall)
  const hut: V2 = [45.9, 489.9];
  buildings.push({ id: "beach-hut", use: "beach-hut", x: hut[0], z: hut[1], y: Y, yaw: 2.85, w: 5.6, d: 4.8, floors: 1, floorH: 3.0, wall: "#eea38e", trim: "#f4e9cf", shutter: "#3d6a4e", door: "#3d6a4e",
    roof: "gable", roofColor: "#b8664a", roofAxis: "z", overhang: 0.8, material: "plaster", t: 0.25, windowPitch: 2.4, balcony: false, awning: "stripe", stripe: 4, tank: null, ac: false, sign: null, shop: false, roofAccess: false, seed: 11, interior: true });
  take(hut[0], hut[1], 5);
  // ---- the resort's back lane east of the hotel — a pool house, a surf shack and the staff house,
  // each its own type / colour / roof, ≥ 12 m apart (a place, not one hotel in a palm field)
  for (const [id, x, z, yaw, w, d, extra] of [
    ["pool-house", 120, 450, -Math.PI / 2, 9.5, 6.6, { use: "pool-house", wall: "#7fc8c0", roof: "gable", roofColor: "#b8432f", roofAxis: "x", awning: "stripe", stripe: 2, material: "plaster" }],
    ["surf-shack", 123, 474, -Math.PI / 2 + 0.25, 7.2, 5.8, { use: "surf-shack", wall: "#f2c132", roof: "shed", roofColor: "#3a6fa8", material: "clapboard", t: 0.14, awning: "tin", awningColor: "#2f8f86" }],
    ["staff-house", 127, 427, -Math.PI / 2 - 0.2, 9.2, 8.2, { use: "staff-house", wall: "#e88ca0", roof: "flat", roofAccess: true, floors: 2, roofColor: "#b9aa92", balcony: true, material: "plaster", parapetH: 0.6 }],
  ] as Array<[string, number, number, number, number, number, Partial<TownBuilding>]>) {
    if (!free(x, z, Math.max(w, d) / 2 + 1.5)) continue;
    buildings.push({ id, x, z, y: Y, yaw, w, d, floors: 1, floorH: 3.2, wall: "#f4a58f", trim: "#f6ecd4", shutter: "#3d6a4e", door: "#3d6a4e", roof: "gable", roofColor: "#b8664a", overhang: 0.7,
      material: "plaster", t: 0.25, windowPitch: 2.6, balcony: false, awning: null, tank: null, ac: false, sign: null, shop: false, roofAccess: false, seed: 31 + buildings.length, interior: true, ...extra });
    take(x, z, Math.max(w, d) / 2 + 2);
  }
  // ---- pier: level with the pad (deck Y + 0.1) from the beach head SSW over the surf; the last leg is a wide open
  // platform the three stilt bungalows open onto (their decks have no rail on the pier side)
  const PY = Y + 0.1;
  const pier: Deck[] = [];
  pier.push(walkway(40, 497, 32, 520, PY, 3.0, [1, 3]));
  pier.push(walkway(32, 520, 26, 538, PY, 3.0, [1, 3]));
  // (the platform runs on past the far bungalow's porch, with rope rails and a gap at each bungalow's porch: without
  //  them a step sideways is a 4 m drop)
  pier.push(walkway(26, 538, 20 - 0.394 * 2.3, 552 + 0.919 * 2.3, PY, 4.0, [1, 3]));
  take(36, 508, 4); take(29, 529, 4);
  const bungalowDecks: Deck[] = [];
  const bung = (x: number, z: number, yaw: number, wall: string, w = 8.2, d = 6.6) => {
    buildings.push({ id: `bungalow-${buildings.length}`, use: "bungalow", x, z, y: PY, yaw, w, d, floors: 1, floorH: 3.1, wall, trim: "#f2e6cc", shutter: "#3d6a4e", door: "#3d6a4e",
      roof: "gable", roofColor: "#5f8a5c", roofAxis: "x", overhang: 0.9, material: "plaster", t: 0.22, windowPitch: 2.4, balcony: false, awning: null, tank: null, ac: false, sign: null, shop: false, roofAccess: false, seed: 21 + buildings.length, interior: true });
    const c = dmath.cos(yaw), s = dmath.sin(yaw);
    bungalowDecks.push({ x: x + 1.3 * s, z: z + 1.3 * c, yaw, w: w + 3.0, d: d + 4.6, y: PY, rail: [1, 2, 3] });
  };
  // front (+z local = porch + door) faces the pier platform (dir d, mid m): east + west of it and off its far end
  {
    const a: V2 = [26, 538], b: V2 = [20, 552], L = dmath.hypot(b[0] - a[0], b[1] - a[1]), d: V2 = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], p1: V2 = [d[1], -d[0]], m: V2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const place = (c: V2, front: V2, wall: string, w: number, dd: number) => bung(c[0], c[1], dmath.atan2(front[0], front[1]), wall, w, dd);
    const off = 2 + (6.6 + 4.6) / 2 + 1.3;
    place([m[0] + p1[0] * off + d[0] * 1.5, m[1] + p1[1] * off + d[1] * 1.5], [-p1[0], -p1[1]], "#eea38e", 8.6, 6.6);
    place([m[0] - p1[0] * off - d[0] * 3, m[1] - p1[1] * off - d[1] * 3], [p1[0], p1[1]], "#f5c3aa", 7.8, 6.6);
    place([b[0] + d[0] * off, b[1] + d[1] * off], [-d[0], -d[1]], "#f2dcbc", 8.2, 6.6);
    // the side bungalows' porches open onto the platform through a gap in its rails
    const plat = pier[2];
    for (const k of bungalowDecks.slice(0, 2)) { const fx = k.x + dmath.sin(k.yaw) * k.d / 2, fz = k.z + dmath.cos(k.yaw) * k.d / 2; deckGap(plat, fx, fz, k.w - 0.8); }
  }
  // STAIRS OFF THE PIER — the pier stands 1.2–4 m over the beach and the shallows with no way up but its head:
  // a kong under it or in the surf would walk 40–60 m round. A timber flight down to the sand off the second leg's east side
  // and a swim-out flight off the platform's free west side (bottom tread 0.3 m over the water)
  const stairs: Flight[] = [];
  {
    const st = (k: Deck, side: 1 | 3, along: number, yBot: number) => {
      const c = dmath.cos(k.yaw), s = dmath.sin(k.yaw), sg = side === 1 ? 1 : -1, lx = sg * (k.w / 2 - 0.02), lz = along;
      const x = k.x + lx * c + lz * s, z = k.z - lx * s + lz * c, dx = sg * c, dz = -sg * s;
      deckGap(k, x + dx * 0.03, z + dz * 0.03, 1.5);
      stairs.push(flight(x, z, dx, dz, k.y, yBot, 1.2, 0.3));
    };
    st(pier[1], 1, -3.5, Math.max(0.1, gridH(GRID, 33.6, 526) + 0.02));
    st(pier[2], 3, 5.6, -0.85);   // (the first tread 0.47 m over a swimmer's feet — see stilt-town WATER_FOOT)
  }

  // ---- umbrellas (coral/cream stripe row 4) + loungers: clustered round the pool (deck ring, south terrace, sand)
  const umbrella = (x: number, z: number, y: number, face: number, spread: number) => {
    props.push({ kind: "umbrella", x, z, yaw: rng() * 6.28, y, v: (rng() - 0.5) * 0.12, s: 1.7 + rng() * 0.15 });
    // two loungers side by side under it; `face` = the yaw the sitter looks along (back rest behind them)
    const c = dmath.cos(face), s = dmath.sin(face);
    for (const side of [-1, 1]) {
      if (side > 0 && rng() < 0.15) continue;
      const lx = x + c * side * spread, lz = z - s * side * spread;
      props.push({ kind: "lounger", x: lx, z: lz, yaw: face + (rng() - 0.5) * 0.18, y });
      if (rng() < 0.35) props.push({ kind: "towel", x: lx, z: lz, yaw: face, y });
    }
    if (rng() < 0.5) props.push({ kind: "table", x: x + s * 0.2, z: z + c * 0.2, yaw: rng() * 6, y });
    take(x, z, 2.2);
  };
  // deck ring: umbrellas 1.6 m in from the deck edge, loungers facing the water — the target art's row of three between
  // the pool and the hotel (east deck) + two on the far (south) end
  for (const a of [-0.55, -0.05, 0.45, 1.2, 1.75]) {
    const e = deckEdge(deckIndexToward(a));
    umbrella(e.p[0] - e.n[0] * 1.6, e.p[1] - e.n[1] * 1.6, DECK_TOP, dmath.atan2(-e.n[0], -e.n[1]), 1.05);
  }
  // south terrace
  for (const a of [1.85, 2.1, 2.35]) {
    const x = EAST_TERRACE.cx + dmath.cos(a) * 23, z = EAST_TERRACE.cz + dmath.sin(a) * 23;
    umbrella(x, z, EAST_TERRACE.y, dmath.atan2(EAST_TERRACE.cx - x, EAST_TERRACE.cz - z), 1.05);
  }
  // sand: west of the pool toward the beach hut / pier (loungers face the sea)
  for (const [x, z] of [[53, 472], [46, 466], [60, 498], [70, 502], [40, 478]] as V2[]) { if (inTerrace(x, z, 1.5) || !free(x, z, 1.5)) continue; umbrella(x, z, Y, 0.1 + (rng() - 0.5) * 0.5, 1.1); }
  // lamps: the paths, along the pier
  for (const [x, z, y] of [[58, 446, Y], [52, 462, Y], [44, 492, Y], [38.6, 506, PY], [35, 517, PY], [30.6, 528, PY], [27.6, 537, PY], [74, 452, Y]] as Array<[number, number, number]>) props.push({ kind: "lamp", x, z, yaw: 0, y });
  // terracotta planters round the deck edge (every ~7 m)
  for (let i = 0; i < DECK.length; i += 5) { const e = deckEdge(i); const x = e.p[0] - e.n[0] * 0.6, z = e.p[1] - e.n[1] * 0.6; if (DECK_FLIGHTS.some((f) => dmath.hypot(f.x - x, f.z - z) < 2.6)) continue; props.push({ kind: "planter", x, z, yaw: 0, y: DECK_TOP, s: 0.46 + rng() * 0.12 }); }
  // ---- rocks: sand-coloured mossy boulders at the grounds' edge + in the surf round the pier
  for (const [x, z, r] of [[30, 535, 1.5], [18, 550, 1.2], [-10, 542, 1.8], [44, 540, 1.3], [26, 562, 1.4], [-14, 572, 1.1], [52, 528, 1.0], [8, 520, 1.2], [60, 512, 1.4], [104, 508, 1.5], [20, 470, 1.3], [26, 490, 1.0]] as Array<[number, number, number]>) { props.push({ kind: "rock", x, z, yaw: rng() * 6.28, s: r }); take(x, z, r); }

  // ---- greenery: overgrown palms + a dense understorey reclaiming the grounds (veg api)
  const palms: Array<[number, number, number]> = [[...V(10, -12.5), 1.1] as [number, number, number], [84, 492, 1.1], [80, 500, 1.0], [56, 495, 1.05], [60, 505, 1.1], [40, 480, 1.0], [30, 494, 1.05], [48, 500, 1.0], [78, 504, 0.95], [86, 438, 1.0],
    [110, 452, 1.1], [114, 480, 1.0], [108, 504, 1.05], [40, 424, 1.0], [76, 420, 1.1], [92, 426, 1.0], [24, 452, 1.05], [16, 486, 1.0], [66, 488, 1.05], [34, 440, 1.0], [100, 512, 0.95]];
  for (const [x, z, s] of palms) { if (!free(x, z, 0.5) || inTerrace(x, z, 0.5)) continue; props.push({ kind: rng() < 0.45 ? "palm-leaning" : "palm", x, z, yaw: rng() * 6.28, s }); take(x, z, 0.8); }
  // planted garden beds (jittered grid inside polygons, clear of the paths)
  const foot = (f: { x: number; z: number; dirX: number; dirZ: number; steps: number; tread: number }): V2 => [f.x + f.dirX * f.steps * f.tread, f.z + f.dirZ * f.steps * f.tread];
  const tk: V2 = [TIKI.x - 4.8, TIKI.z + 1.6];
  const PATHS: Array<[V2, V2]> = [[foot(terraceSteps(WEST_TERRACE, Y)), tk], [tk, foot(DECK_FLIGHTS[0])], [foot(DECK_FLIGHTS[1]), [hut[0] + 3.4, hut[1] - 3]], [[hut[0] + 3.4, hut[1] - 3], [40, 497]]];
  paths.push(...PATHS);
  const nearPath = (x: number, z: number, r: number) => PATHS.some(([a, b]) => { const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz || 1; const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2)); return dmath.hypot(x - a[0] - dx * t, z - a[1] - dz * t) < r; });
  /** planted beds as CLUSTERS, never a grid — clump centres scattered over the polygon (≈ one per step² × 3), each
   *  a mixed-species clump of 2–6 plants (random scale 0.6–1.4 ×, a tall one in the middle, low ones round it) with grass
   *  tufts at its skirt; open ground between clumps (a jittered grid reads as a banana plantation) */
  const fill = (poly: V2[], step: number, mix: Array<[CoveProp["kind"], number, number]>) => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, area = 0;
    for (const [x, z] of poly) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) area += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]);
    area = Math.abs(area) / 2;
    const tot = mix.reduce((a, m) => a + m[1], 0);
    const pickKind = () => { let r = rng() * tot; for (const m of mix) { r -= m[1]; if (r <= 0) return m; } return mix[0]; };
    const nC = Math.max(1, Math.round(area / (step * step * 3)));
    for (let c = 0, tries = 0; c < nC && tries < nC * 8; tries++) {
      const cx = x0 + rng() * (x1 - x0), cz = z0 + rng() * (z1 - z0);
      if (!inPoly(poly, cx, cz) || !free(cx, cz, 1.2) || nearPath(cx, cz, 2.4) || inTerrace(cx, cz, 1)) continue;
      c++;
      const n = 2 + Math.floor(rng() * 5), R = 0.8 + rng() * 1.4;
      // the clump's anchor: the tallest species of the mix, full size, in the middle
      const kinds: Array<[CoveProp["kind"], number, number]> = [rng() < 0.6 ? mix[0] : pickKind()];
      for (let k = 1; k < n; k++) kinds.push(pickKind());
      kinds.forEach((k, i) => {
        const a = rng() * Math.PI * 2, r = i === 0 ? rng() * 0.3 : R * (0.45 + rng() * 0.6);
        const px = cx + dmath.cos(a) * r, pz = cz + dmath.sin(a) * r;
        if (!free(px, pz, 0.3) || nearPath(px, pz, 1.6) || inTerrace(px, pz, 0.4)) return;
        const sc = (i === 0 ? 1.1 + rng() * 0.3 : 0.6 + rng() * 0.6) * k[2];
        props.push({ kind: k[0], x: px, z: pz, yaw: rng() * 6.28, s: sc });
      });
      for (let g = 0; g < 3 + Math.floor(rng() * 4); g++) { const a = rng() * Math.PI * 2, r = R + 0.3 + rng() * 1.2, px = cx + dmath.cos(a) * r, pz = cz + dmath.sin(a) * r; if (free(px, pz, 0.2) && !inTerrace(px, pz, 0.2)) props.push({ kind: rng() < 0.85 ? "grass" : "flowers", x: px, z: pz, yaw: rng() * 6.28, s: 0.7 + rng() * 0.6 }); }
      take(cx, cz, R + 0.5);
    }
  };
  const LUSH: Array<[CoveProp["kind"], number, number]> = [["banana-plant", 3, 1.05], ["fern", 3, 1.35], ["monstera", 2, 1.35], ["grass", 2, 1.1]];
  const VP = (pts: V2[]): V2[] => pts.map(([f, r]) => V(f, r));
  // foreground below the camera terrace (both sides of the stair), the gap between the tiki and the hotel
  fill(VP([[4, -18], [15, -20], [15, -13], [9, -4], [4, -4]]), 2.4, LUSH);
  // the target art's FRAMING greenery — huge banana plants + monstera in both bottom corners of the view's frame
  for (const [f, r, k, sc] of [[9.5, -10.5, "banana-plant", 2.1], [8.2, -7.2, "monstera", 1.9], [11.5, -12.5, "fern", 1.8], [10.5, 10.5, "banana-plant", 2.2], [8.6, 7.8, "monstera", 1.9], [12.5, 13, "banana-plant", 1.7], [9.5, 12.5, "fern", 1.8]] as Array<[number, number, CoveProp["kind"], number]>) {
    const [x, z] = V(f, r); if (inTerrace(x, z, 0.4)) continue;
    props.push({ kind: k, x, z, yaw: rng() * 6.28, s: sc }); take(x, z, 1.4);
  }
  const LOWMIX: Array<[CoveProp["kind"], number, number]> = [["fern", 3, 1.3], ["monstera", 2, 1.3], ["banana-plant", 1, 1.05], ["grass", 3, 1.1], ["flowers", 1, 1.0]];
  fill(VP([[4, 6], [12, 4], [24, 8], [26, 20], [8, 24]]), 4.6, LOWMIX);
  // mossy sand-coloured boulders + driftwood across the open sand (the target art's middle ground)
  for (const [f, r, sz] of [[24, 7, 0.8], [31, 13, 1.1], [36, 5, 0.6], [20, 15, 0.7], [44, 19, 0.9], [28, -1, 0.55]] as Array<[number, number, number]>) {
    const [x, z] = V(f, r); if (!free(x, z, sz + 0.4) || inTerrace(x, z, sz)) continue;
    props.push({ kind: "rock", x, z, yaw: rng() * 6.28, s: sz }); take(x, z, sz + 0.3);
  }
  // along the hotel front (outside the apron) + round the hotel ends
  fill([[76, 438], [86, 438], [84, 444], [77, 446]], 2.2, [["fern", 2, 1.0], ["monstera", 2, 1.0], ["flowers", 1, 1.0], ["banana-plant", 1, 1.0]]);
  fill([[84, 500], [100, 500], [104, 512], [86, 512]], 2.6, LUSH);
  // west lawn edge (screen right) + the beach edge
  fill(VP([[20, 22], [40, 26], [44, 38], [22, 38]]), 5.0, LOWMIX);
  // planted islands in the open sand between the pool, the tiki bar and the beach hut (the target art's beds)
  fill(VP([[18, 6], [26, 5], [30, 10], [24, 14], [17, 12]]), 3.4, LOWMIX);
  // the target art's lush foreground band — dense mixed clumps in front of the tiki (left) and bottom-right, the path
  // between them kept open
  fill(VP([[10, -20], [18, -20], [19, -8], [11, -7]]), 1.9, LUSH);
  fill(VP([[10, 3], [17, 3], [18, 15], [10, 15]]), 2.0, LUSH);
  // round the tiki's back + the pool deck's west foot (planted beds like the target art)
  fill(VP([[26, -21], [34, -20], [33, -15], [26, -16]]), 2.2, LUSH);
  fill(VP([[33, 12], [42, 13], [44, 19], [36, 21]]), 3.2, LUSH);
  fill(VP([[34, 26], [52, 30], [56, 40], [36, 40]]), 5.0, LUSH);
  fill(VP([[40, 0], [60, 1], [62, 10], [42, 10]]), 2.4, [["fern", 2, 1.1], ["monstera", 2, 1.1], ["grass", 2, 1.0], ["flowers", 1, 1.0]]);
  fill([[44, 500], [80, 504], [80, 512], [44, 510]], 3.0, [["grass", 3, 1.2], ["fern", 2, 1.0], ["banana-plant", 1, 1.0]]);
  // grass tufts + flowers across the sand (denser toward its edge) + fallen palm fronds
  for (let i = 0; i < 170; i++) {
    const a = rng() * 6.28, r = 10 + Math.sqrt(rng()) * 40, x = 62 + dmath.cos(a) * r, z = 478 + dmath.sin(a) * r * 0.75;
    if (!free(x, z, 0.3) || inTerrace(x, z, 0.3)) continue;
    props.push({ kind: rng() < 0.82 ? "grass" : "flowers", x, z, yaw: rng() * 6.28, s: 0.7 + rng() * 0.6 });
  }
  for (let i = 0; i < 16; i++) { const x = 34 + rng() * 60, z = 450 + rng() * 55; if (!free(x, z, 1) || inTerrace(x, z, 1)) continue; props.push({ kind: "frond", x, z, yaw: rng() * 6.28, s: 0.8 + rng() * 0.4 }); }
  // crates by the tiki bar + beach hut
  for (const [x, z] of [[TIKI.x - 3.2, TIKI.z + 3.4], [TIKI.x - 3.9, TIKI.z + 2.9], [hut[0] + 3, hut[1] - 2], [hut[0] + 3.5, hut[1] - 1.2]] as Array<[number, number]>) props.push({ kind: "crate", x, z, yaw: rng() * 6.28, v: Math.floor(rng() * 4) });

  // ---- the palm hill's planting (on its slope: y = the drawn profile), the lush band south of the hotel
  {
    const hp = (a: number, r: number): [number, number, number] => { const x = HILL.x + dmath.cos(a) * r, z = HILL.z + dmath.sin(a) * r; return [x, z, Y + hillH(r)]; };
    for (const [a, r, k, sc] of [[0.4, 1.6, "palm", 1.25], [2.6, 1.9, "palm-leaning", 1.15], [4.4, 5.5, "palm", 1.05], [1.4, 6.8, "palm-leaning", 1.0], [5.6, 8.2, "palm", 0.95], [3.3, 8.6, "palm", 1.1]] as Array<[number, number, CoveProp["kind"], number]>) { const [x, z, y] = hp(a, r); props.push({ kind: k, x, z, y, yaw: rng() * 6.28, s: sc }); }
    for (let i = 0; i < 22; i++) { const a = rng() * 6.283, r = 3 + rng() * 7.5, [x, z, y] = hp(a, r), k = rng(); props.push({ kind: k < 0.35 ? "banana-plant" : k < 0.6 ? "fern" : k < 0.8 ? "monstera" : "grass", x, z, y, yaw: rng() * 6.28, s: 0.8 + rng() * 0.5 }); }
    for (const [a, r, sz] of [[1.0, 9.5, 1.3], [3.9, 10.2, 1.0], [5.1, 3.4, 0.8], [2.2, 10.6, 1.5]] as Array<[number, number, number]>) { const [x, z] = hp(a, r); props.push({ kind: "rock", x, z, y: Y + hillH(r), yaw: rng() * 6.28, s: sz }); }
  }
  fill([[100, 500], [109, 499], [111, 508], [104, 516], [96, 514]], 2.2, LUSH);
  fill([[60, 508], [76, 510], [76, 524], [62, 524]], 2.8, LUSH);
  // ---- OPEN-GROUND COVER over the rest of the circle (hard cover within ~8 m): sculpted boulder outcrops and palm
  // groves on a jittered 16 m grid wherever the resort leaves the pad / beach empty
  // (a grove is ONE or two palms over low planting, a 'palms' cell is a boulder outcrop with at most one palm: a hard
  //  cover rhythm for the lanes without a palm forest round the resort, clear views from the hotel to the beach and the hill)
  for (const c0 of coverScatter(GRID, { cx: P.x, cz: P.z, r: P.r, step: 16, seed: 5151, minY: 0.8, free: (x, z) => dmath.hypot(x - VIEW.pos[0], z - VIEW.pos[2]) > 22 && free(x, z, 4.5) && !(x > 20 && x < 112 && z > 430 && z < 530 && !free(x, z, 6)) && !nearPath(x, z, 3) && !inTerrace(x, z, 3) && !(x < 45 && z > 495) })) {
    const c = c0.kind === "palms" ? { ...c0, kind: "rocks" as const } : c0;
    const g = (dx: number, dz: number) => gridH(GRID, c.x + dx, c.z + dz);
    if (c.kind === "rocks" && c0.kind === "palms" && rng() < 0.4) props.push({ kind: "palm", x: c.x + 3.6, z: c.z - 1.0, y: g(3.6, -1.0), yaw: rng() * 6.28, s: 0.95 + rng() * 0.25 });
    if (c.kind === "rocks") {
      const n = 1 + Math.floor(rng() * 2.4);
      // (v 1: the cover boulders use the 320-tri rock — 400 of them at 1 280 tris would be ~0.5 M tris)
      for (let i = 0; i < n; i++) { const a = rng() * 6.283, r = i ? 1.4 + rng() * 1.0 : 0, s0 = i ? 0.75 + rng() * 0.45 : 1.45 + rng() * 0.45; props.push({ kind: "rock", x: c.x + dmath.cos(a) * r, z: c.z + dmath.sin(a) * r, y: g(dmath.cos(a) * r, dmath.sin(a) * r), yaw: rng() * 6.28, s: s0 * c.s, v: 1 }); }
      for (let i = 0; i < 3; i++) { const a = rng() * 6.283, r = 2 + rng() * 1.5; props.push({ kind: rng() < 0.6 ? "grass" : "fern", x: c.x + dmath.cos(a) * r, z: c.z + dmath.sin(a) * r, y: g(dmath.cos(a) * r, dmath.sin(a) * r), yaw: rng() * 6.28, s: 0.8 + rng() * 0.4 }); }
    } else {
      const n = 1 + (rng() < 0.45 ? 1 : 0);
      for (let i = 0; i < n; i++) { const a = rng() * 6.283, r = i ? 1.8 + rng() * 1.6 : 0; props.push({ kind: rng() < 0.4 ? "palm-leaning" : "palm", x: c.x + dmath.cos(a) * r, z: c.z + dmath.sin(a) * r, y: g(dmath.cos(a) * r, dmath.sin(a) * r), yaw: rng() * 6.28, s: 0.9 + rng() * 0.3 }); }
      for (let i = 0; i < 3; i++) { const a = rng() * 6.283, r = 1 + rng() * 2.8, k = rng(); props.push({ kind: k < 0.25 ? "banana-plant" : k < 0.55 ? "bush" : "fern", x: c.x + dmath.cos(a) * r, z: c.z + dmath.sin(a) * r, y: g(dmath.cos(a) * r, dmath.sin(a) * r), yaw: rng() * 6.28, s: 0.8 + rng() * 0.4 }); }
    }
    take(c.x, c.z, c0.kind === "palms" ? 4 : 3);
  }

  // the beaches either side of the pier would be 20–28 m of open sand from any cover (the cover scatter keeps off
  // the pier view) — sandstone outcrops: a big boulder + a smaller one beside it, seated on the sand
  for (const [x, z, s] of [[5, 513, 1.6], [14, 527, 1.35], [-5, 523, 1.25], [112, 535, 1.45], [62, 533, 1.4], [18, 505, 1.2]] as Array<[number, number, number]>) {
    if (!free(x, z, s + 1)) continue;
    const a = rng() * 6.283, x2 = x + dmath.cos(a) * (s + 0.9), z2 = z + dmath.sin(a) * (s + 0.9);
    props.push({ kind: "rock", x, z, y: gridH(GRID, x, z), yaw: rng() * 6.28, s, v: 1 });
    props.push({ kind: "rock", x: x2, z: z2, y: gridH(GRID, x2, z2), yaw: rng() * 6.28, s: s * 0.55, v: 1 });
    take(x, z, s + 1.5);
  }
  // (keep the camera → tiki-bar sight line clear of tall planting)
  { const ax = VIEW.pos[0], az = VIEW.pos[2], dx = TIKI.x - ax, dz = TIKI.z - az, L = dmath.hypot(dx, dz);
    for (let i = props.length - 1; i >= 0; i--) { const q = props[i]; if (!(q.kind === "banana-plant" || q.kind === "palm" || q.kind === "palm-leaning" || q.kind === "monstera")) continue;
      const t = ((q.x - ax) * dx + (q.z - az) * dz) / L, o = Math.abs(-(q.x - ax) * dz + (q.z - az) * dx) / L;
      if (t > 1 && t < L - 2 && o < 2.2 + t * 0.12) props.splice(i, 1); } }
  // ---- sand patch: irregular blob round the pool + tiki + the beach approach, merging into the beach
  const sand: V2[] = [];
  const SN = 72;
  for (let i = 0; i < SN; i++) {
    const a = i / SN * Math.PI * 2;
    const w = 1 + 0.12 * dmath.sin(a * 3 + 1.3) + 0.08 * dmath.sin(a * 7 + 0.4) + 0.05 * dmath.sin(a * 13 + 2.1);
    const rx = 38 * w, rz = (dmath.sin(a) > 0 ? 44 : 30) * w;
    sand.push([60 + dmath.cos(a) * rx, 470 + dmath.sin(a) * rz]);
  }
  const parts = buildings.map(resolveBuilding);
  return { buildings, parts, pier, bungalowDecks, props, sand, paths, stairs };
}
function inTerrace(x: number, z: number, m = 0): boolean {
  for (const t of [EAST_TERRACE, WEST_TERRACE]) { const r = dmath.hypot(x - t.cx, z - t.cz); if (r > t.r0 - m && r < t.r1 + m && terraceAngleIn(t, x, z)) return true; }
  return false;
}
function terraceAngleIn(t: Terrace, x: number, z: number): boolean {
  let a = dmath.atan2(z - t.cz, x - t.cx);
  while (a < t.a0 - Math.PI) a += Math.PI * 2;
  while (a > t.a0 + Math.PI) a -= Math.PI * 2;
  return a >= t.a0 && a <= t.a1;
}
export const LAYOUT: CoveLayout = genLayout();

/** steps: 5 m wide flight down the front of a terrace at its middle angle (rise 0.2, tread 0.32) */
export function terraceSteps(t: Terrace, y0: number): { x: number; z: number; dirX: number; dirZ: number; steps: number; rise: number; tread: number; width: number } {
  const a = t.stair ?? (t.a0 + t.a1) / 2, r = t.front === "r0" ? t.r0 : t.r1;
  const dir = t.front === "r0" ? -1 : 1; // downhill direction: away from the terrace
  const steps = Math.round((t.y - y0) / 0.2);
  return { x: t.cx + dmath.cos(a) * r, z: t.cz + dmath.sin(a) * r, dirX: dmath.cos(a) * dir, dirZ: dmath.sin(a) * dir, steps, rise: (t.y - y0) / steps, tread: 0.32, width: 5 };
}
function flightBoxes(f: Flight, surf: Box["surf"] = "stone"): Box[] {
  const out: Box[] = [], yaw = dmath.atan2(f.dirX, f.dirZ);
  for (let i = 0; i < f.steps; i++) {
    const u = (i + 0.5) * f.tread, top = f.yTop - (i + 1) * f.rise;
    if (top <= f.yBottom + 1e-3) break;
    out.push({ c: [f.x + f.dirX * u, (f.yBottom - 0.2 + top) / 2, f.z + f.dirZ * u], h: [f.width / 2, (top - f.yBottom + 0.2) / 2, f.tread / 2 + 0.005], yaw, surf });
  }
  return out;
}
function terraceBoxes(t: Terrace, y0: number): Box[] {
  // a curved terrace = fan of oriented boxes filling the annular sector, plus the low parapet on the front edge and the steps
  const out: Box[] = [];
  const n = 14, dr = t.r1 - t.r0, mid = (t.a0 + t.a1) / 2;
  const rf = t.front === "r0" ? t.r0 + 0.22 : t.r1 - 0.22;
  for (let i = 0; i < n; i++) {
    const a = t.a0 + (t.a1 - t.a0) * (i + 0.5) / n, da = (t.a1 - t.a0) / n;
    // (radial bands ≤ 2.6 m, each only as wide as its OUTER arc — one full-depth box per sector would be as wide as
    //  the rim right down to the apex: an invisible wall up to 1 m proud of the drawn sides of the west terrace's pie)
    const nb = Math.max(1, Math.ceil(dr / 2.6));
    for (let j = 0; j < nb; j++) {
      const rb0 = t.r0 + dr * j / nb, rb1 = t.r0 + dr * (j + 1) / nb, rm = (rb0 + rb1) / 2, w = rb1 * da + 0.12;
      out.push({ c: [t.cx + dmath.cos(a) * rm, (y0 - 0.6 + t.y) / 2, t.cz + dmath.sin(a) * rm], h: [w / 2, (t.y - y0 + 0.6) / 2, (rb1 - rb0) / 2 + 0.01], yaw: -a + Math.PI / 2, surf: "stone" });
    }
    const ph = t.planted ? 0.28 : 0.45; // planted fronts: a low planter kerb (the plants are noShoot foliage)
    if (Math.abs(a - (t.stair ?? mid)) * rf > 2.9) out.push({ c: [t.cx + dmath.cos(a) * rf, t.y + ph, t.cz + dmath.sin(a) * rf], h: [rf * da / 2 + 0.03, ph, 0.21], yaw: -a + Math.PI / 2, surf: "stone" });
  }
  const st = terraceSteps(t, y0);
  out.push(...flightBoxes({ x: st.x, z: st.z, dirX: st.dirX, dirZ: st.dirZ, width: st.width, yTop: t.y, yBottom: y0, steps: st.steps, rise: st.rise, tread: st.tread }));
  return out;
}
/** the raised pool: ring of deck boxes (pool outline → deck outline), basin floor, flights */
function poolBoxes(): Box[] {
  const out: Box[] = [], n = POOL.length;
  for (let i = 0; i < n; i++) {
    const a = POOL[i], b = POOL[(i + 1) % n], A = DECK[i], B = DECK[(i + 1) % n];
    const cx = (a[0] + b[0] + A[0] + B[0]) / 4, cz = (a[1] + b[1] + A[1] + B[1]) / 4;
    const dx = b[0] - a[0], dz = b[1] - a[1], l = dmath.hypot(dx, dz) || 1;
    const len = Math.max(l, dmath.hypot(B[0] - A[0], B[1] - A[1])) + 0.12;
    const mi: V2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], mo: V2 = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
    const dep = dmath.hypot(mo[0] - mi[0], mo[1] - mi[1]);
    out.push({ c: [cx, (Y - 0.3 + DECK_TOP) / 2, cz], h: [len / 2, (DECK_TOP - Y + 0.3) / 2, dep / 2], yaw: dmath.atan2(-dz, dx), surf: "stone" });
  }
  // basin floor (the water itself does not collide)
  out.push({ c: [POOL_C[0], POOL_FLOOR_Y - 0.2, POOL_C[1]], h: [14, 0.2, 14], yaw: 0, surf: "stone" });
  // planter island
  out.push({ c: [ISLAND.x, (POOL_FLOOR_Y + Y + 1.55) / 2, ISLAND.z], h: [ISLAND.r * 0.9, (Y + 1.55 - POOL_FLOOR_Y) / 2, ISLAND.r * 0.9], surf: "stone" });
  for (const f of DECK_FLIGHTS) out.push(...flightBoxes(f));
  // the palm hill: a 0.6 m HEIGHTFIELD of columns, each topped at the drawn profile under its centre (≤ 0.2 m off the
  //  drawn slope, ≤ 0.36 m between neighbours — climbable everywhere) + the summit arch (two piers + a broken lintel)
  { const C = 0.6, n = Math.ceil(HILL.R / C);
    for (let j = -n; j <= n; j++) for (let i = -n; i <= n; i++) {
      const x = HILL.x + (i + 0.5) * C, z = HILL.z + (j + 0.5) * C, h = hillH(dmath.hypot(x - HILL.x, z - HILL.z));
      if (h < 0.12) continue;
      out.push({ c: [x, Y + (h - 1) / 2, z], h: [C / 2, (h + 1) / 2, C / 2], surf: "grass" });
    } }
  for (const [px, ph] of ARCH_PIERS) out.push({ c: [HILL.x + px, Y + HILL.H + ph / 2, HILL.z - 0.6], h: [0.42, ph / 2, 0.42], surf: "stone" });
  out.push({ c: [HILL.x - 0.35, Y + HILL.H + 3.05, HILL.z - 0.6], h: [1.25, 0.25, 0.45], surf: "stone" });
  return out;
}
/** the summit arch: [x offset, height] of its two piers (client town-resort draws the same) */
export const ARCH_PIERS: Array<[number, number]> = [[-1.3, 2.8], [1.3, 1.9]];

function propColliders(): Box[] {
  const out: Box[] = [];
  for (const p of LAYOUT.props) {
    const y = p.y ?? Y;
    switch (p.kind) {
      case "umbrella": out.push({ c: [p.x, y + 1.25, p.z], h: [0.08, 1.25, 0.08], surf: "wood" }); break;
      case "lounger": out.push({ c: [p.x, y + 0.22, p.z], h: [0.36, 0.22, 0.98], yaw: p.yaw, surf: "wood" }); break;
      case "lamp": out.push({ c: [p.x, y + 1.8, p.z], h: [0.15, 1.8, 0.15], surf: "metal" }); break;
      case "planter": out.push({ c: [p.x, y + 0.3, p.z], h: [(p.s ?? 0.5), 0.3, (p.s ?? 0.5)], surf: "stone" }); break;
      // (rocks on the pad stand at Y, not at sea level)
      case "rock": { const r = p.s ?? 1; out.push(...rockBoxes(p.x, p.y ?? (p.z < 505 ? Y : 0), p.z, r, p.yaw)); break; }
      // (the vegetation draws curved / leaning trunks: only the foot collides — see mango-market propColliders)
      case "palm": case "palm-leaning": out.push(...palmBoxes(p.x, y, p.z, p.s ?? 1)); break;
      case "crate": out.push({ c: [p.x, y + 0.17, p.z], h: [0.31, 0.17, 0.22], yaw: p.yaw, surf: "wood" }); break;
      default: break;
    }
  }
  // tiki bar: round counter (8 segments), roof posts
  for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4 + Math.PI / 8; if (Math.abs(dmath.cos(a - 0.35)) > 0.92 && dmath.cos(a - 0.35) > 0) continue; out.push({ c: [TIKI.x + dmath.cos(a) * (TIKI.r - 1.35), Y + 0.56, TIKI.z + dmath.sin(a) * (TIKI.r - 1.35)], h: [0.95, 0.56, 0.22], yaw: -a + Math.PI / 2, surf: "wood" }); }
  for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3; out.push({ c: [TIKI.x + dmath.cos(a) * (TIKI.r - 0.35), Y + 1.4, TIKI.z + dmath.sin(a) * (TIKI.r - 0.35)], h: [0.13, 1.4, 0.13], surf: "wood" }); }
  // the thatch dome collides (bullets don't pass through the roof). Fitted to town-resort.ts addTikiBar: per height band a hollow ring of 12 tangent boxes from the rafter line out to the dome's outer skin
  // at mid-band (±0.25 m of the drawn thatch; the bar under it stays open to its 2.5 m eave), + the cupola on the crown
  for (const [y0, y1, r0, r1] of [[2.5, 2.95, 4.1, 4.55], [2.95, 3.4, 3.4, 4.19], [3.4, 3.85, 2.61, 3.62], [3.85, 4.3, 1.83, 2.83], [4.3, 4.75, 1.04, 2.09], [4.75, 5.1, 0.34, 0.97]]) {
    for (let i = 0; i < 12; i++) { const a = i * Math.PI / 6, rc = (r0 + r1) / 2; out.push({ c: [TIKI.x + dmath.cos(a) * rc, Y + (y0 + y1) / 2, TIKI.z + dmath.sin(a) * rc], h: [r1 * dmath.tan(Math.PI / 12), (y1 - y0) / 2, (r1 - r0) / 2], yaw: -a + Math.PI / 2, surf: "wood" }); }
  }
  for (const yaw of [0, Math.PI / 4]) out.push({ c: [TIKI.x, Y + 5.28, TIKI.z], h: [0.45, 0.33, 0.45], yaw, surf: "wood" });
  return out;
}

// (simBoxes — the layout's three.js yaws → the sim's convention, see town-kit simBoxes)
// bungalow interiors by the shared interiors kit
// (+ every hotel guest room and lobby bay — the kit furnishes the hotel too)
export const INTERIOR_ROOMS: InteriorRoom[] = [...LAYOUT.parts.flatMap((p) => buildingRooms(p, { style: "house" })), ...hotelRooms(hotelLayout(HOTEL))];
const INTERIORS = townInteriors("coconut-cove", INTERIOR_ROOMS, (TOWN_INT as unknown as Record<string, TownInteriorBake | undefined>)["coconut-cove"]);
export const INTERIOR_LOOT = INTERIORS.loot;
export const colliders: Box[] = [...INTERIORS.colliders, ...simBoxes([
  ...hotelColliders(HOTEL, [VIEW.pos[0], VIEW.pos[2]]),
  ...LAYOUT.parts.flatMap(buildingColliders),
  ...LAYOUT.pier.flatMap(deckColliders),
  ...LAYOUT.bungalowDecks.flatMap(deckColliders),
  ...LAYOUT.stairs.flatMap((f) => flightBoxes(f, "wood")),
  ...poolBoxes(),
  ...terraceBoxes(EAST_TERRACE, Y),
  ...terraceBoxes(WEST_TERRACE, Y),
  ...propColliders(),
])];
/** LOOT_SPOTS: every hotel room on every floor (a chest beside the bed on the table side, a floor spot by the
 *  wardrobe end), the lobby, the roof, the tiki bar, then the bungalows / beach hut / annex from the interiors kit */
export const LOOT_SPOTS = (() => {
  const lay = hotelLayout(HOTEL), P = lay.P;
  const chests: Array<[number, number, number, number]> = [], floor: Array<[number, number, number]> = [];
  // (the guest rooms' chests / floor spots come from the interiors kit — INTERIOR_LOOT)
  for (const b of lay.bays) {
    const [gx, gz] = P.pt(b.sm, 3.4); if (b.i % 2 === 0) floor.push([gx, lay.lv[0], gz]);
    const pv = lay.pavilion;
    if (b.i % 3 === 1 && (b.s1 < pv.s0 - 1 || b.s0 > pv.s1 + 1)) { const [rx, rz] = P.pt(b.sm, 7); floor.push([rx, lay.roof, rz]); }
  }
  // lobby reception + the tiki bar (behind the counter)
  const mid = lay.bays[Math.floor(lay.nBays * 0.45)], [dx, dz] = P.pt(mid.sm, 8.4);
  chests.push([dx, lay.lv[0], dz, P.yaw(mid.sm) + Math.PI]);
  chests.push([TIKI.x, Y + 0.05, TIKI.z, 0.35]);
  // the pier's end platform — the dead end out on the water pays: a chest between the three bungalows' porches
  { const k = LAYOUT.pier[2]; chests.push([k.x - dmath.sin(k.yaw) * 1.2, k.y, k.z - dmath.cos(k.yaw) * 1.2, k.yaw]); }
  // every spot settled against the resort's own colliders (hotel spots inside columns / furniture, a roof spot over open
  // air) — slid to the nearest clear point on the same floor, or dropped
  const L = townLootSpots(INTERIOR_LOOT, { chests, floor, chestSep: 6 }), up = (q: number[]) => q[1] > Y + 0.6;
  return { chests: settleLoot(L.chests, colliders, { chest: true, needFloor: up, snap: 0.2 }), floor: settleLoot(L.floor, colliders, { needFloor: up }) };
})();


/** the resort's named places — the pool terrace (plaza), the banana sculpture on the
 *  hotel roof (landmark), the palm hill (garden) */
export const PLACES: Array<{ kind: "plaza" | "landmark" | "garden"; name: string; x: number; z: number; poly?: V2[]; top?: number }> = (() => {
  const lay = hotelLayout(HOTEL), pf = pavFrame(lay), pc = pf.c, mid = [pc.ax + pc.dx * pf.W / 2, pc.az + pc.dz * pf.W / 2];
  const hill: V2[] = []; for (let k = 0; k < 16; k++) hill.push([HILL.x + dmath.cos(k * Math.PI / 8) * HILL.R, HILL.z + dmath.sin(k * Math.PI / 8) * HILL.R]);
  return [
    { kind: "plaza", name: "Pool Terrace", x: POOL_C[0], z: POOL_C[1], poly: DECK },
    { kind: "landmark", name: "Banana sculpture", x: mid[0], z: mid[1], top: lay.pavilion.y + pf.H + PLINTH.top + 5.5 },
    { kind: "garden", name: "Palm Hill", x: HILL.x, z: HILL.z, poly: hill },
  ];
})();
/** areas vegetation / random scatter must leave clear (the POI dresses them itself). Circles or yaw-rotated rects. */
// (+ a small one round a rock / trunk pocket at the west edge that would be a 1 m² trap)
export const clearings: Array<Clearing | { x: number; z: number; hx: number; hz: number; yaw?: number }> = [{ x: 72, z: 470, r: 72 }, { x: 8, z: 548, r: 30 }, { x: -47, z: 459, r: 5 }, { x: 14, z: 304.6, r: 4 }];
