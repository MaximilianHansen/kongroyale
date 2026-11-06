// POI stilt-town — fishing village on stilts over the NE lagoon. Deterministic layout (decks, walkways, plank links,
// huts, boats, islets, dressing) + colliders + clearings. Pure TS; the client module builds visuals from LAYOUT.
//
// The composition is built in the view camera's VIEW FRAME: the camera sits 2.7 m above the water east of the village
// looking WSW; W(f, r) = f metres ahead, r metres to the screen right. The fish-market shack
// is dead ahead at ~30 m facing the camera, a crescent of clapboard huts comes toward the camera on the left, a second
// row on tall stilts stands behind the market, more huts recede right, the mangrove islet frames the right edge, the red
// hero longboat floats 9 m out lower-right and the yellow one is moored at the teal hut's piles left-middle.
// Decks stand at 2.2–3.0 m (neighbours within ~0.45 m of each other, so a plank link is one step — 3.9–5.4 m
// 'tall stilt' decks need flights that run into the neighbouring huts); walkways + plank links tie every deck together.
import type { Box } from "../world/colliders";
import { poiById } from "../world/map";
import { footprint, polyGap, type TownBuilding, type BuildingParts, type Deck, resolveBuilding, buildingColliders, deckColliders, deckGap, deckAttach, walkway, mulberry, simBoxes, type Clearing, buildingRooms, townInteriors, townLootSpots, type TownInteriorBake, coverScatter, gridH, type GroundGrid, palmBoxes, rockBoxes } from "./town-kit";
import SLOPE from "./mango-slope.json";
import type { InteriorRoom } from "./interior-kit";
import TOWN_INT from "./town-interiors.json";
import { settleLoot } from "./coast-kit";
import * as dmath from "../sim/dmath";

const P = poiById("stilt-town");
export const CX = P.x, CZ = P.z;
/** deck top height above sea level */
export const DECK_Y = 2.2;
/** a water stair's foot. A swimmer floats with its feet 1.15 m under the surface and auto-steps 0.55 m
 *  (shared/sim/player.ts swim + STEP_H): a stair ending at +0.1 puts its first tread 1.4 m over a swimmer's feet,
 *  too high to climb out of the lagoon. The flight runs on down under the water: first tread −0.68 m, 0.47 m over the
 *  swimmer's feet */
export const WATER_FOOT = -0.85;

type V2 = [number, number];
// ---------------------------------------------------------------- view frame (view camera)
const CAM: V2 = [396, -318], HD: V2 = [-0.88, -0.47];
const RT: V2 = [-HD[1], HD[0]]; // screen right = (−dz, dx) for a camera looking along (dx, dz)
export const W = (f: number, r: number): V2 => [CAM[0] + HD[0] * f + RT[0] * r, CAM[1] + HD[1] * f + RT[1] * r];
const FACE = dmath.atan2(-HD[0], -HD[1]); // yaw whose +z faces the camera
const VT = W(40, 0);
// the camera 2.7 m above the water (level across at the decks, slightly down at the boats)
export const VIEW = { pos: [CAM[0], 2.7, CAM[1]] as [number, number, number], target: [VT[0], 6.4, VT[1]] as [number, number, number], fov: 52 };
/** market shack centre (world) — the view's main subject */
export const MARKET: V2 = W(30, 0);

export interface StiltProp {
  kind: "boat" | "dinghy" | "barrel" | "wbarrel" | "crate" | "lifering" | "tyre" | "net" | "swag" | "float" | "lantern" | "fishrack" | "rock" | "islet" | "palm" | "palm-leaning" | "banana-plant" | "mangrove" | "bush" | "fern" | "derrick" | "pot" | "buoy" | "sack" | "post" | "mooring" | "drum" | "bollard";
  x: number; z: number; yaw: number; y?: number; v?: number; w?: number; h?: number; s?: number;
  /** a boulder on dry land (seated at y; the lagoon rocks sit on the bed) */
  land?: boolean;
  /** boats: the world point the bow line runs to */
  moor?: [number, number, number];
}
export interface RopeWalk { a: V2; b: V2; y: number; w: number }
/** a straight timber stair going DOWN from (x, z) at yTop along (dirX, dirZ) to yBottom */
export interface StiltStair { x: number; z: number; dirX: number; dirZ: number; width: number; yTop: number; yBottom: number; steps: number; rise: number; tread: number; /** boarded sides (roof stairs: solid under the treads) */ closed?: boolean; /** a boxed stair's boards painted like its house (raw planks read as a wooden wedge stuck to it) */ paint?: string }
export interface StiltLayout { decks: Deck[]; walks: Deck[]; ropeWalks: RopeWalk[]; huts: TownBuilding[]; parts: BuildingParts[]; props: StiltProp[]; stairs: StiltStair[];
  /** the named places */
  places: Array<{ kind: "plaza" | "landmark" | "court"; name: string; x: number; z: number; poly?: V2[]; top?: number }> }

const TRIMS = ["#f6efe0", "#d9483b", "#f2c132", "#2fb3a8", "#fbf3e2", "#3a86c8"];
const ROOFS = ["#c3c8cc", "#b0b6ba", "#a0522d", "#3a6fa8", "#b8432f", "#aeb0aa", "#c9c2b0"];

/** boundary point of an oriented rect (deck) along the ray from its centre toward (tx, tz) */
function edgeToward(k: Deck, tx: number, tz: number): V2 {
  const c = dmath.cos(k.yaw), s = dmath.sin(k.yaw), dx = tx - k.x, dz = tz - k.z;
  const lx = dx * c - dz * s, lz = dx * s + dz * c, L = dmath.hypot(lx, lz) || 1;
  const ux = lx / L, uz = lz / L, t = Math.min(Math.abs(ux) > 1e-6 ? (k.w / 2) / Math.abs(ux) : 1e9, Math.abs(uz) > 1e-6 ? (k.d / 2) / Math.abs(uz) : 1e9);
  const px = ux * t, pz = uz * t;
  return [k.x + px * c + pz * s, k.z - px * s + pz * c];
}

function genLayout(): StiltLayout {
  const rng = mulberry(9021);
  const pick = <T>(arr: T[]): T => arr[Math.floor(rng() * arr.length)];
  const decks: Deck[] = [], walks: Deck[] = [], ropeWalks: RopeWalk[] = [], huts: TownBuilding[] = [], props: StiltProp[] = [], stairs: StiltStair[] = [];
  const hutDeck = new Map<TownBuilding, Deck>();
  let netSquare: Deck | null = null, lookout: TownBuilding | null = null;
  const extended: Array<{ dk: Deck; plain: { x: number; z: number; w: number; d: number } }> = [];
  /** a timber stair from a deck edge point (x, z) at yTop straight out along (dx, dz) DOWN to yBottom (the water:
   *  WATER_FOOT, so swimmers climb out) — stairs, not ladders: the sim has no ladder climbing */
  const stairDown = (x: number, z: number, dx: number, dz: number, yTop: number, yBottom: number, width = 1.1, tread = 0.3) => {
    const n = Math.max(2, Math.ceil((yTop - yBottom) / 0.19));
    const st: StiltStair = { x, z, dirX: dx, dirZ: dz, width, yTop, yBottom, steps: n, rise: (yTop - yBottom) / n, tread };
    stairs.push(st);
    return st;
  };
  /** water stairs + the rail gap each one opened (dropped together if the stair runs into something) */
  const waterStairs: Array<{ st: StiltStair; dk: Deck }> = [];
  const waterStair = (dk: Deck, x: number, z: number, dx: number, dz: number, yTop: number, width: number, gapW: number) => {
    const st = stairDown(x, z, dx, dz, yTop, WATER_FOOT, width);
    deckGap(dk, x + dx * 0.03, z + dz * 0.03, gapW);
    waterStairs.push({ st, dk });
  };

  // `jit` = the village's irregularity (no regular grid from above) — ±3 m / ±12° for the huts that
  // are not composed for the view
  const sizeR = mulberry(9041);
  const hut = (f: number, r: number, yawAdd: number, w: number, d: number, extra: Partial<TownBuilding> = {}, deckY = DECK_Y, porch = 2.6, jit = 0) => {
    // (a third of the huts are big family houses / net lofts — 19 near-identical 5 × 4.4 m boxes read as a kit)
    // (the big ones are two-storey family houses / net lofts on the town stair hall)
    // (under a tin GABLE like every other hut — flat parapet roofs read as concrete
    //  blocks from the plane; the upper floor's windows keep the height advantage)
    { const k = sizeR(); if (!extra.shop && !extra.use) { if (k < 0.3) { w *= 1.75; d *= 1.6; extra = { ...extra, floors: 2, use: "family-house", roof: "gable", roofPitch: 0.62, roofAccess: false }; } } }
    if (jit) { f += (rng() - 0.5) * 6 * jit; r += (rng() - 0.5) * 6 * jit; yawAdd += (rng() - 0.5) * 0.42 * jit; }
    const [x, z] = W(f, r), yaw = FACE + yawAdd;
    const wall = extra.wall ?? "#2fb3a8";
    let trim = pick(TRIMS); while (trim === wall) trim = pick(TRIMS);
    const b: TownBuilding = {
      x, z, y: deckY, yaw, w, d, floors: 1, floorH: 2.9, wall, trim, shutter: pick(["#f6efe0", "#2f4a3a", "#d9483b", "#284b6b"]), door: pick(["#d9483b", "#f2c132", "#2fb3a8", "#f6efe0"]),
      roof: "gable", roofColor: pick(ROOFS), roofAxis: w >= d ? "x" : "z", roofPitch: 0.72 + rng() * 0.18, overhang: 0.8, material: "clapboard", t: 0.12, windowPitch: 2.6,
      balcony: false, awning: null, tank: null, ac: false, sign: null, shop: false, roofAccess: false, seed: Math.floor(rng() * 1e9), ...extra,
    };
    huts.push(b);
    // its deck: hut footprint + a porch on the front + 1.3 m walkable margins round the sides and back (0.7 /
    // 0.5 m margins leave a 0.6 m slot between the hut wall and the rail — every plank link that met a side
    // arrives in a dead end and the porch + door are unreachable)
    // (the EAVE side (back for a ridge along x, +x for a ridge along z) gets overhang + 1.4 m of deck: room for a
    //  timber stair up to the eave outside the overhang — every hut roof is a second fightable level, reached on foot)
    const ov = extra.overhang ?? 0.8, ext = ov + 1.45 - 1.3, alongX = (extra.roofAxis ?? (w >= d ? "x" : "z")) === "x";
    const dw = w + 2.6 + (alongX ? 0 : ext), dd = d + porch + 0.8 + (alongX ? ext : 0), c = dmath.cos(yaw), s = dmath.sin(yaw), fz0 = porch / 2 - 0.9, fz = fz0 - (alongX ? ext / 2 : 0), fx = alongX ? 0 : ext / 2;
    decks.push({ x: x + fx * c + fz * s, z: z - fx * s + fz * c, yaw, w: dw, d: dd, y: deckY, rail: [0, 1, 3] });
    hutDeck.set(b, decks[decks.length - 1]);
    extended.push({ dk: decks[decks.length - 1], plain: { x: x + fz0 * s, z: z + fz0 * c, w: w + 2.6, d: d + porch + 0.8 } });
    return b;
  };

  // ---- the fish-market shack: open shop front toward the camera under a deep tin porch roof
  // turned 3/4 to the camera — ridge along the open front, the left gable end toward the camera
  const market = hut(27, 2.4, 0.42, 8.6, 7.4, { shop: true, sign: "BANANA CO.", awning: "tin", awningColor: "#8e8f8a", awningDepth: 2.6, awningPosts: true, wall: "#c9553d", trim: "#f6efe0", roofColor: "#a0522d", roofAxis: "x", roofPitch: 0.8, door: "#f2c132", shutter: "#f6efe0", overhang: 1.1 }, DECK_Y, 5.0);
  decks[decks.length - 1] = { ...decks[decks.length - 1], w: 13.0, rail: [] };
  const marketDeck = decks[decks.length - 1];
  // ---- LEFT CLUSTER at three depths (not one deck line high on tall bare stilts): decks
  // 2.2–3.4 m (short thick piles), rooflines overlapping front → back:
  //   depth 1 — the big teal hut (front-left, 3/4 to the camera, its ridge inside the frame);
  //   depth 2 — a tall teal gable-front hut with a dormer peeking over it + the yellow hut between it and the market;
  //   depth 3 — a small red hut behind the yellow, an orange one behind the teal, a blue one further back
  hut(25.5, -13.8, 0.36, 6.0, 4.8, { wall: "#2fb3a8", trim: "#f6efe0", door: "#d9483b", roofColor: "#c3c8cc" }, 2.5, 2.8);
  hut(34, -10.5, 0.28, 4.8, 5.4, { wall: "#27a39a", trim: "#f6efe0", door: "#f2c132", roofColor: "#b0b6ba", roofAxis: "x", roofPitch: 1.0, floorH: 3.3, dormer: true }, 2.9, 2.2);
  hut(27.5, -6.5, 0.3, 5.4, 4.4, { wall: "#f2c132", trim: "#2fb3a8", door: "#f2c132", roofColor: "#b0b6ba" }, 2.5, 2.6);
  hut(38.5, -3.8, 0.2, 4.6, 4.0, { wall: "#d9483b", trim: "#f6efe0", roofColor: "#c9c2b0" }, 2.9, 2.2);
  hut(41.5, -20.5, 0.18, 5.2, 4.4, { wall: "#ee8a2d", trim: "#f6efe0", roofColor: "#aeb0aa" }, 2.6, 2.4);
  hut(50, -14, 0.1, 5.0, 4.4, { wall: "#3a86c8", trim: "#f2c132", roofColor: "#b8432f" }, 2.8, 2.6, 0.4);
  hut(58, -30, 0.1, 5.2, 4.4, { wall: "#e2563f", trim: "#f6efe0", roofColor: "#aeb0aa" }, DECK_Y, 2.6, 1);
  // ---- behind the market: a blue hut on tall stilts, a yellow beside it
  hut(42, 16.5, 0.05, 5.6, 4.6, { wall: "#3a86c8", trim: "#f6efe0", roofColor: "#c3c8cc" }, 3.0);
  hut(49, 19.5, -0.1, 4.8, 4.2, { wall: "#f2c132", trim: "#d9483b", roofColor: "#b0b6ba" }, 2.7);
  // ---- right: lower huts receding behind the mangroves (orange-teal + a red one on the water, the right third)
  hut(34, 15.5, -0.3, 5.4, 4.6, { wall: "#2fb3a8", trim: "#ee8a2d", roofColor: "#a0522d" }, 2.6);
  hut(31, 22, -0.25, 5.0, 4.4, { wall: "#e2563f", trim: "#f6efe0", roofColor: "#aeb0aa" }, 2.2, 2.4, 0.3);
  hut(55, 12, -0.1, 5.0, 4.4, { wall: "#c4d24a", trim: "#d9483b", roofColor: "#a0522d" }, DECK_Y, 2.6, 1);
  hut(44, 29, -0.35, 5.2, 4.4, { wall: "#f2c132", trim: "#2fb3a8", roofColor: "#3a6fa8" }, DECK_Y, 2.6, 1);
  hut(60, 26, -0.2, 5.4, 4.6, { wall: "#7fc8c0", trim: "#d9483b", roofColor: "#c3c8cc" }, DECK_Y, 2.6, 1);
  // ---- background (west) filling the gaps toward the shore
  hut(64, -5, 0, 5.4, 4.6, { wall: "#f5e2b8", trim: "#2fb3a8", roofColor: "#3a6fa8" }, DECK_Y, 2.6, 1);
  hut(72, 6, 0.05, 5.6, 4.8, { wall: "#d9483b", trim: "#f2c132", roofColor: "#b0b6ba" }, DECK_Y, 2.6, 1);
  hut(76, -33, 0.1, 5.0, 4.4, { wall: "#2fb3a8", trim: "#f6efe0", roofColor: "#b8432f" }, DECK_Y, 2.6, 1);
  hut(86, 16, -0.1, 5.2, 4.4, { wall: "#f2c132", trim: "#3a86c8", roofColor: "#aeb0aa" }, DECK_Y, 2.6, 1);
  // ---- NET SQUARE — the village's open deck (drying nets, crates, the derrick) between the west huts,
  // and the LOOKOUT: a 3-storey clapboard tower on its own deck at the square's west end, a roof terrace over the
  // lagoon — the landmark you see from the plane and from across the water (its interior is furnished, stairs = the
  // town stair hall)
  {
    const toF = (x: number, z: number): V2 => { const dx = x - CAM[0], dz = z - CAM[1]; return [dx * HD[0] + dz * HD[1], dx * RT[0] + dz * RT[1]]; };
    const [sx, sz] = [319, -342];
    decks.push({ x: sx, z: sz, yaw: FACE + 0.2, w: 20, d: 16.5, y: DECK_Y, rail: [0, 2] });
    netSquare = decks[decks.length - 1];
    const [tf, tr] = toF(304, -339);
    // (3 storeys of sun-faded BLUE painted clapboard (the huts' palette — raw timber brown reads as brick from the
    //  Canopy shore, a pale block as grey concrete) with cream trim and red shutters: the tallest hut on the lagoon, not
    //  a tower block; the roof is the sniper perch with a timber water tower; a first-floor watch balcony over the square
    //  + a tin awning on the door break up the box; every storey + the roof carry a chest (LOOT_HOT))
    hut(tf, tr, 0.2 + Math.PI / 2, 9.2, 9.2, { use: "tower", floors: 3, floorH: 2.9, roof: "flat", roofAccess: true, parapetH: 1.0, roofProps: [{ kind: "tower", x: 2.3, z: 2.3 }], wall: "#4f93bd", trim: "#f6efe0", roofColor: "#8e8f8a", shutter: "#d9483b", door: "#d9483b", balcony: true, awning: "tin", awningColor: "#b8432f" }, DECK_Y, 2.4);
    lookout = huts[huts.length - 1];
  }

  // ---- RELAX the village — as composed, the huts stand 1–4 m apart (deck rail to deck rail). Push every
  // pair apart until ≥ 10.6 m of lagoon lies between their walls (the market and the Lookout stay put), keep every hut
  // inside 66 m of the POI centre (the town radius may grow ≤ 25 % of 56.8 m), off the shore spine's corridor and off Net
  // Square; each hut's deck (and its pre-extension record) moves with it. The plank links span the water afterwards.
  {
    const fixed = new Set<TownBuilding>([market, ...(lookout ? [lookout] : [])]);
    const bz0 = W(31.2, 2.4)[1];
    const spine: Array<[V2, V2]> = [[[224, bz0 - 1.5], [262, bz0 - 4.5]], [[262, bz0 - 4.5], [300, bz0 + 3.0]], [[300, bz0 + 3.0], W(46.5, 0)], [W(46.5, 0), W(32.7, 5.0)]];
    const segD = (x: number, z: number, a: V2, b: V2) => { const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz || 1e-9, t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2)); return [dmath.hypot(x - a[0] - t * dx, z - a[1] - t * dz), a[0] + t * dx, a[1] + t * dz] as const; };
    const move = (h: TownBuilding, dx: number, dz: number) => {
      h.x += dx; h.z += dz;
      const dk = hutDeck.get(h); if (dk) { dk.x += dx; dk.z += dz; }
      const e = extended.find((q) => q.dk === dk); if (e) { e.plain.x += dx; e.plain.z += dz; }
    };
    const rad = (h: TownBuilding) => Math.max(...footprint(h).map(([x, z]) => dmath.hypot(x - CX, z - CZ)));
    const sq = netSquare;
    // each hut its own elbow room (10.6–17 m): an even 10.6 m everywhere read as a honeycomb from the air
    const rr = mulberry(9033), room = huts.map(() => 10.6 + rr() * rr() * 8);
    for (let it = 0; it < 400; it++) {
      let worst = 0;
      for (let i = 0; i < huts.length; i++) for (let j = i + 1; j < huts.length; j++) {
        const A = huts[i], B = huts[j], g = polyGap(footprint(A), footprint(B)), need = Math.max(10.6, (room[i] + room[j]) / 2) - g;
        if (need <= 0) continue;
        worst = Math.max(worst, need);
        let dx = B.x - A.x, dz = B.z - A.z; const l = dmath.hypot(dx, dz) || 1; dx /= l; dz /= l;
        const fa = fixed.has(A), fb = fixed.has(B), k = Math.min(0.6, need) * 0.5;
        if (fa && fb) continue;
        if (fa) move(B, dx * k * 2, dz * k * 2); else if (fb) move(A, -dx * k * 2, -dz * k * 2); else { move(A, -dx * k, -dz * k); move(B, dx * k, dz * k); }
      }
      for (const h of huts) {
        if (fixed.has(h)) continue;
        // the radius cap: pull toward the POI centre
        const r = rad(h); if (r > 66) { const dx = CX - h.x, dz = CZ - h.z, l = dmath.hypot(dx, dz) || 1; move(h, dx / l * Math.min(0.6, r - 66), dz / l * Math.min(0.6, r - 66)); }
        // the spine corridor: ≥ 7 m from the walkway's centreline
        for (const [a, b] of spine) { const [d, px, pz] = segD(h.x, h.z, a, b), m = 7 + Math.max(h.w, h.d) / 2; if (d < m) { const dx = h.x - px, dz = h.z - pz, l = dmath.hypot(dx, dz) || 1; move(h, dx / l * Math.min(0.6, m - d), dz / l * Math.min(0.6, m - d)); } }
        // Net Square
        if (sq) { const dx = h.x - sq.x, dz = h.z - sq.z, l = dmath.hypot(dx, dz) || 1, m = dmath.hypot(sq.w, sq.d) / 2 + Math.max(h.w, h.d) / 2 + 2; if (l < m) move(h, dx / l * Math.min(0.6, m - l), dz / l * Math.min(0.6, m - l)); }
      }
      if (worst < 0.05) break;
    }
  }
  // an eave-side deck extension that would run into another hut or deck is taken back (it would make a pen)
  {
    const rectHit = (A: { x: number; z: number; w: number; d: number; yaw: number }, B: { x: number; z: number; w: number; d: number; yaw: number }, m: number) => {
      const cs = (k: typeof A) => [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => [k.x + a * k.w / 2 * dmath.cos(k.yaw) + b * k.d / 2 * dmath.sin(k.yaw), k.z - a * k.w / 2 * dmath.sin(k.yaw) + b * k.d / 2 * dmath.cos(k.yaw)]);
      const inside = (k: typeof A, p: number[]) => { const c = dmath.cos(k.yaw), s = dmath.sin(k.yaw), dx = p[0] - k.x, dz = p[1] - k.z; return Math.abs(dx * c - dz * s) < k.w / 2 + m && Math.abs(dx * s + dz * c) < k.d / 2 + m; };
      return cs(A).some((p) => inside(B, p)) || cs(B).some((p) => inside(A, p));
    };
    for (const e of extended) {
      const others = [...decks.filter((q) => q !== e.dk), ...huts.filter((h) => hutDeck.get(h) !== e.dk).map((h) => ({ x: h.x, z: h.z, w: h.w, d: h.d, yaw: h.yaw }))];
      // only the NEW strip matters: test the extended deck against everything the plain deck did not already touch
      const plain = { ...e.plain, yaw: e.dk.yaw };
      if (others.some((o) => rectHit(e.dk, o, 0.3) && !rectHit(plain, o, 0.3))) Object.assign(e.dk, { x: plain.x, z: plain.z, w: plain.w, d: plain.d });
    }
  }
  // decks at DIFFERENT heights must not overlap in plan (a tall deck's margin over a lower deck leaves < 1.9 m of
  // headroom — crouch pockets): the lower deck gives way on the side facing the higher one (0.15 m clear)
  for (let pass = 0; pass < 3; pass++) for (let i = 0; i < decks.length; i++) for (let j = 0; j < decks.length; j++) {
    const lo = decks[i], hi = decks[j];
    if (i === j || hi.y - lo.y <= 0.5) continue;
    const c = dmath.cos(lo.yaw), s = dmath.sin(lo.yaw);
    const ch = dmath.cos(hi.yaw), sh = dmath.sin(hi.yaw);
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => { const wx = hi.x + a * hi.w / 2 * ch + b * hi.d / 2 * sh - lo.x, wz = hi.z - a * hi.w / 2 * sh + b * hi.d / 2 * ch - lo.z; return [wx * c - wz * s, wx * s + wz * c]; });
    const x0 = Math.min(...corners.map((q) => q[0])), x1 = Math.max(...corners.map((q) => q[0])), z0 = Math.min(...corners.map((q) => q[1])), z1 = Math.max(...corners.map((q) => q[1]));
    const ox = Math.min(x1, lo.w / 2) - Math.max(x0, -lo.w / 2), oz = Math.min(z1, lo.d / 2) - Math.max(z0, -lo.d / 2);
    if (ox <= 0 || oz <= 0) continue;
    // shrink along the axis of least overlap, on the side the higher deck is on
    let e0x = -lo.w / 2, e1x = lo.w / 2, e0z = -lo.d / 2, e1z = lo.d / 2;
    if (ox < oz) { if ((x0 + x1) / 2 > 0) e1x = x0 - 0.15; else e0x = x1 + 0.15; }
    else { if ((z0 + z1) / 2 > 0) e1z = z0 - 0.15; else e0z = z1 + 0.15; }
    const mx = (e0x + e1x) / 2, mz = (e0z + e1z) / 2;
    lo.x += mx * c + mz * s; lo.z += -mx * s + mz * c; lo.w = e1x - e0x; lo.d = e1z - e0z;
  }
  // ---- walkways: the shore spine (west shore → the market's back) + a south boardwalk to the crescent
  // the spine runs from the real west shore (x 224) in three legs with two bends, a square LANDING at each bend (lamp posts, benches,
  // a moored boat), to the market's back
  const shoreX = 224;
  const [bx, bz] = W(31.2, 2.4);
  const L1: V2 = [262, bz - 4.5], L2: V2 = [300, bz + 3.0];
  walks.push(walkway(shoreX, bz - 1.5, L1[0] - 2.6, L1[1], DECK_Y - 0.02, 2.6, [1, 3]));
  walks.push(walkway(L1[0] + 2.6, L1[1], L2[0] - 2.6, L2[1], DECK_Y - 0.02, 2.6, [1, 3]));
  // the last leg turns at a THIRD landing behind the red hut and meets the market deck's back edge right of it (a
  // straight leg runs through the red hut's deck at W(38.5, −3.8) and cuts off the market and every hut beyond it).
  const L3: V2 = W(46.5, 0), ME: V2 = W(32.7, 5.0);
  void bx; void bz;
  walks.push(walkway(L2[0] + 2.6, L2[1], L3[0] - 2.6, L3[1], DECK_Y - 0.02, 2.6, [1, 3]));
  walks.push(walkway(L3[0] + 2.6, L3[1], ME[0], ME[1], DECK_Y - 0.02, 2.6, [1, 3]));
  for (const [lx, lz] of [L1, L2, L3]) decks.push({ x: lx, z: lz, yaw: 0.1, w: 5.6, d: 5.6, y: DECK_Y - 0.02, rail: [0, 2] });
  // the spine's SHORE END — the walkway ends 1.7 m above the beach (x 224, sand ~0.5 m): a real timber stair down
  // onto the sand (steps = colliders)
  { const w0 = walks[0], dx = -dmath.sin(w0.yaw), dz = -dmath.cos(w0.yaw), ex = w0.x + dx * (w0.d / 2 - 0.02), ez = w0.z + dz * (w0.d / 2 - 0.02);
    stairDown(ex, ez, dx, dz, DECK_Y - 0.02, 0.42, 2.4, 0.32); }
  const landings = [L1, L2, L3];
  // ---- TWO MORE WAYS IN. The 80 m west spine alone leaves every squad off the north or south beach a 40–50 m swim
  // under fire. A boardwalk from the north beach and one from the south beach, each to the
  // nearest hut deck (rope rails, a timber stair down onto the sand at the shore end): three lanes into the hot drop
  const extraWalks: Deck[] = [];
  {
    const G: GroundGrid = (SLOPE as unknown as { grids: Record<string, GroundGrid> }).grids["stilt-town"];
    for (const [tx, tz] of [[293, -273], [298, -436]] as V2[]) {
      let dk: Deck | null = null, bd = Infinity;
      for (const k of decks) { if (k.y < 1.5) continue; const d = dmath.hypot(k.x - tx, k.z - tz); if (d < bd) { bd = d; dk = k; } }
      if (!dk) continue;
      const A = deckAttach(dk, tx, tz, 1.6);
      let dx = tx - A.x, dz = tz - A.z; const L = dmath.hypot(dx, dz) || 1; dx /= L; dz /= L;
      // march to the first sand ≥ 0.4 m; the walk stops 0.8 m short of it and a stair carries on down
      let t = 2; while (t < L + 20 && gridH(G, A.x + dx * t, A.z + dz * t) < 0.4) t += 0.5;
      const e = Math.max(4, t - 0.8), ex = A.x + dx * e, ez = A.z + dz * e, wy = DECK_Y - 0.02;
      const w = walkway(A.x - dx * 0.05, A.z - dz * 0.05, ex, ez, wy, 2.6, [1, 3]);
      walks.push(w); extraWalks.push(w);
      deckGap(dk, A.x, A.z, 2.9);
      let yb = 0.4; for (let k = 0; k < 3; k++) { const run = Math.ceil((wy - yb) / 0.19) * 0.32; yb = Math.max(0.3, gridH(G, ex + dx * run, ez + dz * run) + 0.02); }
      stairDown(ex - dx * 0.02, ez - dz * 0.02, dx, dz, wy, yb, 2.4, 0.32);
    }
  }
  // decks that overlap within 0.5 m of height are ONE platform (a step between them) — no rail across it
  for (const A of [...decks, ...walks]) for (const B of [...decks, ...walks]) {
    if (A === B || Math.abs(A.y - B.y) > 0.5) continue;
    const cB = dmath.cos(B.yaw), sB = dmath.sin(B.yaw);
    const inB = (x: number, z: number, m: number) => { const dx = x - B.x, dz = z - B.z; return Math.abs(dx * cB - dz * sB) < B.w / 2 + m && Math.abs(dx * sB + dz * cB) < B.d / 2 + m; };
    const cA = dmath.cos(A.yaw), sA = dmath.sin(A.yaw);
    const rails: Array<0 | 1 | 2 | 3> = A.rail === true ? [0, 1, 2, 3] : (A.rail || []);
    for (const side of rails) {
      const len = side % 2 === 0 ? A.w : A.d;
      // sample the side: open a gap over every stretch that lies inside B
      let run0 = -1;
      for (let k = 0; k <= 40; k++) {
        const u = len * k / 40;
        const lx = side === 0 ? -A.w / 2 + u : side === 1 ? A.w / 2 : side === 2 ? A.w / 2 - u : -A.w / 2;
        const lz = side === 0 ? A.d / 2 : side === 1 ? A.d / 2 - u : side === 2 ? -A.d / 2 : -A.d / 2 + u;
        const inside = k < 40 && inB(A.x + lx * cA + lz * sA, A.z - lx * sA + lz * cA, 0.2);
        if (inside && run0 < 0) run0 = u;
        if (!inside && run0 >= 0) { (A.gaps ??= []).push([side, run0 - 0.3, u + 0.3]); run0 = -1; }
      }
    }
  }
  // ---- plank links: every hut deck to its nearest neighbour deck / walkway (rope-railed plank bridges)
  const all = [...decks, ...walks], linked = new Set<string>();
  const link = (k: Deck, best: Deck) => {
    const key = [all.indexOf(k), all.indexOf(best)].sort((p, q) => p - q).join("-");
    if (linked.has(key)) return;
    linked.add(key);
    // (attach points kept ≥ 1.1 m from deck corners, so the 1.9 m rail gap is whole)
    const A0 = deckAttach(k, best.x, best.z), B0 = deckAttach(best, A0.x, A0.z), A1 = deckAttach(k, B0.x, B0.z);
    const a: V2 = [A1.x, A1.z], b: V2 = [B0.x, B0.z];
    const lo = Math.min(k.y, best.y), hi = Math.max(k.y, best.y);
    ropeWalks.push({ a, b, y: lo - 0.05, w: 1.5 });
    deckGap(k, a[0], a[1], 1.9); deckGap(best, b[0], b[1], 1.9);
    // (a small rise is one auto-step up from the plank — no flight; 2–3 step flights on 0.2–0.4 m rises are
    //  shorter than the capsule and read as walls. The limit is 0.35: a 0.4 m step up from a sagging plank is jump-only)
    if (hi - lo > 0.35) {
      // tall-stilt hut: the plank link runs at the LOWER deck's level; a timber STAIR (not a ladder: the sim has no
      // ladder climbing) rises over its last metres to the tall deck's edge, steps = colliders
      const top = k.y > best.y ? a : b, other = k.y > best.y ? b : a, L = dmath.hypot(top[0] - other[0], top[1] - other[1]) || 1;
      const dx = (other[0] - top[0]) / L, dz = (other[1] - top[1]) / L, n = Math.ceil((hi - lo) / 0.19), tread = 0.3;
      // (always ≥ 0.28 m treads — steeper flights stop the capsule (it overlaps ~3 treads); a flight longer than
      //  the link simply runs on down onto the lower deck)
      const tr = n * tread < L - 0.4 ? tread : 0.28;
      stairs.push({ x: top[0] - dx * 0.02, z: top[1] - dz * 0.02, dirX: dx, dirZ: dz, width: 1.3, yTop: hi, yBottom: lo, steps: n, rise: (hi - lo) / n, tread: tr });
    }
  };
  const gapOf = (k: Deck, o: Deck) => { const a = edgeToward(k, o.x, o.z), b = edgeToward(o, k.x, k.z); return dmath.hypot(b[0] - a[0], b[1] - a[1]); };
  for (let i = 0; i < decks.length; i++) {
    const k = decks[i];
    if (k === marketDeck) continue;
    let best: Deck | null = null, bd = 18;
    for (const o of all) { if (o === k) continue; const d = gapOf(k, o); if (d < bd) { bd = d; best = o; } }
    if (!best || bd < 0.3) continue;
    link(k, best);
  }
  // CONNECTIVITY — nearest-neighbour links leave islands (whole hut groups linked only to each other). Union
  // decks / walkways that touch (walkway ends on landings / the market) or share a link, then link every island to the
  // spine's component at its closest pair until everything is one network.
  {
    const idx = new Map(all.map((d, i) => [d, i])), par = all.map((_, i) => i);
    const find = (i: number): number => (par[i] === i ? i : (par[i] = find(par[i])));
    const unite = (a: number, b: number) => { par[find(a)] = find(b); };
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) if (Math.abs(all[i].y - all[j].y) < 0.35 && gapOf(all[i], all[j]) < 0.35) unite(i, j);
    for (const key of linked) { const [a, b] = key.split("-").map(Number); unite(a, b); }
    const spine = idx.get(walks[0])!;
    for (let guard = 0; guard < 40; guard++) {
      const root = find(spine);
      let bp: [number, number] | null = null, bd = Infinity;
      for (let i = 0; i < all.length; i++) {
        if (find(i) === root || all[i].y < 1) continue;
        for (let j = 0; j < all.length; j++) { if (find(j) !== root || all[j].y < 1) continue; const d = gapOf(all[i], all[j]); if (d < bd) { bd = d; bp = [i, j]; } }
      }
      if (!bp) break;
      link(all[bp[0]], all[bp[1]]);
      unite(bp[0], bp[1]);
    }
  }

  // ---- ROOF STAIRS — every hut: a timber stair on the eave side of its deck, outside the overhang, parallel to
  // the wall, up to the lowest roof terrace (then 0.45 m terraces to the ridge). Tried toward +t, then −t; dropped when a
  // plank link lands in its footprint.
  const roofStairs: StiltStair[] = [];
  for (const b of huts) {
    if (b.roof === "flat") continue; // (flat roofs are reached by the stair hall inside)
    const pr = resolveBuilding(b).roof, alongX = pr.axis === "x", N = Math.max(4, Math.ceil(pr.rise / 0.45));
    const yTop = pr.y + pr.rise * (1 - (N - 0.5) / N) + 0.07, dk = hutDeck.get(b)!;
    const c = dmath.cos(b.yaw), s = dmath.sin(b.yaw), L = (lx: number, lz: number): V2 => [b.x + lx * c + lz * s, b.z - lx * s + lz * c];
    const half = alongX ? b.d / 2 : b.w / 2, len = alongX ? b.w : b.d, off = half + pr.overhang + 0.15 + 0.55;
    const n = Math.ceil((yTop - dk.y) / 0.19), tread = 0.28, run = n * tread;
    const tries: Array<[number, number]> = [[-1, 1], [-1, -1]];
    // the porch side too, where the porch leaves room outside the overhang
    if (alongX && dk.d / 2 + ((dk.x - b.x) * s + (dk.z - b.z) * c) - half >= pr.overhang + 1.25) tries.push([1, 1], [1, -1]);
    for (const [so, sg] of tries) {
      // top point (t = along the wall, o = out from it): t = sg·(len/2 + ov·0.9), o = so·off
      const tTop = sg * (len / 2 + pr.overhang * 0.9), tBot = tTop - sg * run;
      if (Math.abs(tBot) > len / 2 + 1.3 + 0.1) continue;
      const Q = (t: number): V2 => (alongX ? L(t, so * off) : L(off, -t));
      const P0 = Q(tTop), P1 = Q(tTop - sg), mid = Q((tTop + tBot) / 2);
      const dx = (P1[0] - P0[0]), dz = (P1[1] - P0[1]);
      const near = (qx0: number, qz0: number, ma: number, mo: number) => { const qx = qx0 - mid[0], qz = qz0 - mid[1]; return Math.abs(qx * dx + qz * dz) < run / 2 + ma && Math.abs(-qx * dz + qz * dx) < 0.5 + mo; };
      // (no plank link may land, and no other stair start / end, within 1.6 m of its footprint)
      const blocked = ropeWalks.some((r) => [r.a, r.b].some((q) => near(q[0], q[1], 1.6, 1.6)))
        || stairs.some((f) => near(f.x, f.z, 1.6, 1.6) || near(f.x + f.dirX * f.steps * f.tread, f.z + f.dirZ * f.steps * f.tread, 1.6, 1.6));
      // (the whole footprint on the hut's own deck)
      const onDeck = (q: V2) => { const cd = dmath.cos(dk.yaw), sd = dmath.sin(dk.yaw), ddx = q[0] - dk.x, ddz = q[1] - dk.z; return Math.abs(ddx * cd - ddz * sd) < dk.w / 2 - 0.05 && Math.abs(ddx * sd + ddz * cd) < dk.d / 2 - 0.05; };
      const Qo = (t: number, o: number): V2 => (alongX ? L(t, so * o) : L(o, -t));
      if (blocked || ![tTop, tBot].every((t) => onDeck(Qo(t, off + 0.5)) && onDeck(Qo(t, off - 0.5)))) continue;
      const st: StiltStair = { x: P0[0], z: P0[1], dirX: dx, dirZ: dz, width: 1.0, yTop, yBottom: dk.y, steps: n, rise: (yTop - dk.y) / n, tread, closed: true, paint: b.wall };
      stairs.push(st); roofStairs.push(st);
      break;
    }
  }
  // ---- dressing on the market deck (front porch faces the camera): local frame of the market
  const mc = dmath.cos(market.yaw), ms = dmath.sin(market.yaw);
  const ML = (lx: number, lz: number): V2 => [market.x + lx * mc + lz * ms, market.z - lx * ms + lz * mc];
  const front = market.d / 2 + 0.25;
  const at = (kind: StiltProp["kind"], lx: number, lz: number, extra: Partial<StiltProp> = {}) => { const [x, z] = ML(lx, lz); props.push({ kind, x, z, yaw: market.yaw, ...extra }); };
  // big cream nets DRAPED in swags from the porch eave (bold twine, deep bellies, cork + glass floats),
  // one hung curtain at the side
  // (the swags are BUNCHED up under the eave — 2.2 m drops hang at eye height across the stall)
  at("swag", 1.4, front + 2.75, { y: DECK_Y + 2.95, w: 3.6, h: 0.85, yaw: market.yaw + 0.04 });
  at("swag", -3.0, front + 2.7, { y: DECK_Y + 2.9, w: 2.6, h: 0.8, yaw: market.yaw - 0.1 });
  at("net", 4.3, front + 1.2, { y: DECK_Y + 2.9, w: 1.8, h: 0.9, yaw: market.yaw + Math.PI / 2 - 0.1 });
  // fish rack at eye level across the open front, lanterns glowing under the porch
  at("fishrack", -0.6, front + 0.7, { y: DECK_Y + 2.05, yaw: market.yaw });
  // the derrick stands at the market's LEFT corner (its boom leans out over the left huts, the net basket
  // hanging just left of the market gable)
  at("derrick", -5.2, front + 3.0, { yaw: market.yaw + Math.PI - 0.5 });
  for (let i = 0; i < 6; i++) at("float", -3.6 + i * 0.6 + (rng() - 0.5) * 0.2, front + 0.45, { y: DECK_Y + 2.2 + rng() * 0.35, v: i });
  at("lantern", -3.6, front + 1.6, { y: DECK_Y + 2.2 });
  at("lantern", 0.2, front + 2.4, { y: DECK_Y + 2.3 });
  at("lantern", 3.4, front + 1.8, { y: DECK_Y + 2.2 });
  // teal drums, crate stacks, barrels, sacks on the porch
  at("drum", 3.9, front + 2.2, { v: 0 }); at("drum", 4.6, front + 1.7, { v: 0 }); at("drum", 3.4, front + 3.0, { v: 1 }); at("drum", -4.6, front + 3.2, { v: 0 });
  at("wbarrel", -5.2, front + 1.3); at("wbarrel", -4.8, front + 2.1);
  at("crate", -1.8, front + 1.6, { yaw: market.yaw + 0.2, v: 0 }); at("crate", -1.8, front + 1.6, { yaw: market.yaw + 0.1, v: 1, y: DECK_Y + 0.34 }); at("crate", -1.7, front + 1.62, { yaw: market.yaw - 0.1, v: 3, y: DECK_Y + 0.68 });
  at("crate", 1.8, front + 3.2, { yaw: market.yaw + 0.8, v: 2 }); at("crate", 2.4, front + 3.5, { yaw: market.yaw + 0.5, v: 0 }); at("crate", -4.0, front + 3.9, { yaw: market.yaw - 0.4, v: 3 });
  at("sack", -3.1, front + 1.5, { yaw: 0.6 }); at("sack", -2.6, front + 1.1, { yaw: 1.6 }); at("sack", -0.2, front + 3.8, { yaw: 2.2 });
  at("pot", -5.6, front + 3.9);
  const deckFront = marketDeck.d / 2 + (5.0 / 2 - 0.5) + 0.1;
  // chunky lashed log bollards along the porch edge + more cargo: crate stacks, teal drums, barrels
  for (let lx = -6.1; lx <= 6.11; lx += 2.03) { if (Math.abs(lx) < 1.0 || Math.abs(lx + 4.4) < 1.1) continue; at("bollard", lx, deckFront - 0.28, { yaw: market.yaw }); }
  at("crate", 5.3, front + 3.9, { yaw: market.yaw + 0.1, v: 1 }); at("crate", 5.3, front + 3.9, { yaw: market.yaw - 0.05, v: 0, y: DECK_Y + 0.34 }); at("crate", 5.9, front + 3.3, { yaw: market.yaw + 0.3, v: 3 });
  at("drum", -5.5, front + 2.6, { v: 0 }); at("drum", -5.9, front + 3.3, { v: 1 }); at("wbarrel", 4.6, front + 4.3); at("wbarrel", -2.6, front + 4.4);
  at("crate", -0.9, front + 4.6, { yaw: market.yaw + 0.6, v: 2 }); at("sack", 1.1, front + 4.7, { yaw: 0.3 });
  at("lifering", -2.2, deckFront, { y: DECK_Y - 0.55, yaw: market.yaw });
  // a LOW LANDING (pontoon deck 0.6 m above the water) off the market's front-left corner — crates,
  // drums and sacks under the deck line — with steps up to the porch
  {
    const [px, pz] = ML(-4.6, deckFront + 1.5);
    decks.push({ x: px, z: pz, yaw: market.yaw + 0.05, w: 3.6, d: 2.6, y: 0.6, rail: [] });
    const lp = (kind: StiltProp["kind"], lx: number, lz: number, extra: Partial<StiltProp> = {}) => { const [x, z] = ML(lx, lz); props.push({ kind, x, z, yaw: market.yaw + (rng() - 0.5) * 0.6, y: 0.6, ...extra }); };
    lp("crate", -5.95, deckFront + 1.0, { v: 0 }); lp("crate", -5.95, deckFront + 1.0, { v: 2, y: 0.94 }); lp("crate", -6.0, deckFront + 2.0, { v: 1 });
    lp("drum", -3.1, deckFront + 1.0, { v: 0 }); lp("drum", -2.95, deckFront + 1.8, { v: 1 }); lp("sack", -3.0, deckFront + 2.6); lp("wbarrel", -6.1, deckFront + 2.7);
    // timber steps from the porch edge down onto the pontoon
    { const [sx0, sz0] = ML(-4.4, deckFront - 0.02); stairDown(sx0, sz0, ms, mc, DECK_Y, 0.6, 1.2, 0.26); }
    at("tyre", -2.9, deckFront + 2.8, { y: 0.3, yaw: market.yaw });
  }
  // ---- NET SQUARE's cargo — bare, the 20 × 16.5 m deck under the Lookout is a shooting gallery from
  // the tower and both plank links. Five crate / drum stacks 6–9 m apart (crouch cover ~1 m, a waist-high drum pair) and
  // the hot drop's payoff loot between them (LOOT_SPOTS: SQUARE_LOOT)
  if (netSquare) {
    const k = netSquare, c = dmath.cos(k.yaw), s = dmath.sin(k.yaw), Q = (lx: number, lz: number): V2 => [k.x + lx * c + lz * s, k.z - lx * s + lz * c];
    const stack = (lx: number, lz: number, turn: number) => {
      const [x, z] = Q(lx, lz), y0 = k.y, yw = k.yaw + turn;
      for (let i = 0; i < 3; i++) props.push({ kind: "crate", x, z, yaw: yw + (rng() - 0.5) * 0.12, y: y0 + i * 0.34, v: Math.floor(rng() * 4) });
      const [x2, z2] = Q(lx + 0.75 * dmath.cos(turn), lz - 0.75 * dmath.sin(turn));
      props.push({ kind: "crate", x: x2, z: z2, yaw: yw + 0.3, y: y0, v: Math.floor(rng() * 4) }); props.push({ kind: "crate", x: x2, z: z2, yaw: yw + 0.2, y: y0 + 0.34, v: Math.floor(rng() * 4) });
      const [x3, z3] = Q(lx - 0.4 * dmath.sin(turn) - 0.6 * dmath.cos(turn), lz - 0.4 * dmath.cos(turn) + 0.6 * dmath.sin(turn) + 0.75);
      props.push({ kind: "drum", x: x3, z: z3, yaw: 0, y: y0, v: Math.floor(rng() * 3) });
    };
    for (const [lx, lz, t] of [[-5.5, -3.2, 0.2], [3.8, -4.6, -0.4], [-0.6, 2.9, 1.3], [6.4, 2.6, 0.7], [-7.4, 4.4, -0.9]] as Array<[number, number, number]>) stack(lx, lz, t);
    for (const [lx, lz] of [[1.6, -1.0], [-3.0, 0.6]] as V2[]) { const [x, z] = Q(lx, lz); props.push({ kind: "wbarrel", x, z, yaw: 0, y: k.y }); }
    const [nx, nz] = Q(0.8, -6.2); props.push({ kind: "net", x: nx, z: nz, yaw: k.yaw, y: k.y + 2.6, w: 2.4, h: 0.9 });
  }
  at("tyre", 3.6, deckFront, { y: DECK_Y - 0.72, yaw: market.yaw });
  at("lifering", 6.6, 1.0, { y: DECK_Y - 0.5, yaw: market.yaw + Math.PI / 2 }); // (hangs on the side piles)
  // ---- porch dressing on every hut: planter, lantern, a barrel or crate, a hanging net on some
  for (const h of huts) {
    if (h === market) continue;
    const c = dmath.cos(h.yaw), s = dmath.sin(h.yaw), y = h.y;
    const fx = h.x + (h.d / 2 + 1.0) * s, fz = h.z + (h.d / 2 + 1.0) * c;
    const r = rng();
    if (r < 0.4) props.push({ kind: "barrel", x: fx + (h.w / 2 - 0.6) * c, z: fz - (h.w / 2 - 0.6) * s, yaw: 0, y, v: Math.floor(rng() * 4) });
    else if (r < 0.8) props.push({ kind: "crate", x: fx + (h.w / 2 - 0.6) * c, z: fz - (h.w / 2 - 0.6) * s, yaw: rng() * 0.6, y, v: Math.floor(rng() * 4) });
    if (rng() < 0.6) props.push({ kind: "pot", x: fx - (h.w / 2 - 0.5) * c, z: fz + (h.w / 2 - 0.5) * s, yaw: 0, y });
    if (rng() < 0.5) props.push({ kind: "net", x: fx + (h.w / 2 - 1.4) * c, z: fz - (h.w / 2 - 1.4) * s, yaw: h.yaw, y: y + 2.75, w: 1.8, h: 0.8 });
    if (rng() < 0.55) props.push({ kind: "lifering", x: h.x + (h.d / 2 + 2.3) * s + 1.2 * c, z: h.z + (h.d / 2 + 2.3) * c - 1.2 * s, yaw: h.yaw, y: y - 0.5 });
    // most porches get a real timber stair down to the water off the porch front (steps = colliders), a gap in the porch rail
    if (rng() < 0.8) {
      const dk = hutDeck.get(h)!, fe = (dk.x - h.x) * s + (dk.z - h.z) * c + dk.d / 2 - 0.02; // porch front edge (hut-local z)
      const lx = -Math.min(1.0, h.w / 2 - 0.4), px = h.x + fe * s + lx * c, pz = h.z + fe * c - lx * s;
      waterStair(dk, px, pz, s, c, y, 1.05, 1.4);
    }
  }
  // ---- spine dressing: barrels, crates, pots every ~6 m along each leg; the landings get lamp posts, a crate stack,
  // drums, a net on a rack, a stair down + a moored boat
  for (const w of walks) {
    const c = dmath.cos(w.yaw), s2 = dmath.sin(w.yaw), n = Math.floor(w.d / 6.2);
    for (let i = 0; i < n; i++) {
      const t = -w.d / 2 + 3 + i * 6.2, side = i % 2 ? 1 : -1, off = side * 0.9;
      const x = w.x + t * s2 + off * c, z = w.z + t * c - off * s2, k = rng();
      if (k < 0.35) props.push({ kind: "barrel", x, z, yaw: 0, v: Math.floor(rng() * 4) });
      else if (k < 0.65) props.push({ kind: "crate", x, z, yaw: w.yaw + rng() * 0.6, v: Math.floor(rng() * 4) });
      else if (k < 0.8) props.push({ kind: "pot", x, z, yaw: 0 });
    }
  }
  for (const [lx, lz] of landings) {
    for (const [ox, oz] of [[2.4, 2.4], [-2.4, -2.4]]) props.push({ kind: "post", x: lx + ox, z: lz + oz, yaw: 0, y: DECK_Y });
    props.push({ kind: "crate", x: lx - 1.9, z: lz + 1.9, yaw: 0.3, v: 1 }); props.push({ kind: "crate", x: lx - 1.9, z: lz + 1.9, yaw: 0.2, v: 2, y: DECK_Y + 0.34 });
    props.push({ kind: "drum", x: lx + 1.9, z: lz - 1.8, yaw: 0, v: 0 }); props.push({ kind: "drum", x: lx + 1.3, z: lz - 2.0, yaw: 0, v: 1 });
    props.push({ kind: "net", x: lx + 0.6, z: lz + 2.55, yaw: 0.1, y: DECK_Y + 2.7, w: 2.0, h: 0.75 });
    // stair down to the water off the landing's back edge
    { const dk = decks.find((q) => q.x === lx && q.z === lz)!, yw = dk.yaw, bx0 = lx - dmath.sin(yw) * (dk.d / 2 - 0.02), bz0 = lz - dmath.cos(yw) * (dk.d / 2 - 0.02);
      waterStair(dk, bx0, bz0, -dmath.sin(yw), -dmath.cos(yw), DECK_Y - 0.02, 1.2, 1.5); }
    const [dx, dz] = [lx + 1.2, lz - 5.4];
    props.push({ kind: "dinghy", x: dx, z: dz, yaw: 0.1, moor: [lx, DECK_Y - 0.3, lz - 2.8] });
  }
  // ---- boats: red hero 9 m out lower-right (bow line to a mooring pole), yellow moored at the teal hut, more around
  const teal = decks[1];
  const tealFront = edgeToward(teal, CAM[0], CAM[1]);
  const [rbx, rbz] = W(9.5, 3.2), [mpx, mpz] = W(12.5, 9);
  props.push({ kind: "mooring", x: mpx, z: mpz, yaw: 0, h: 2.6 });
  // boat yaw: local +x = bow → world (cos yaw, −sin yaw). Red: bow toward the huts + a little toward the camera
  const yawOf = (dx: number, dz: number) => dmath.atan2(-dz, dx);
  props.push({ kind: "boat", x: rbx, z: rbz, yaw: yawOf(-RT[0] * 0.8 - HD[0] * 0.3, -RT[1] * 0.8 - HD[1] * 0.3), v: 0, moor: [mpx, 1.6, mpz] });
  const [ybx, ybz] = W(14.5, -8.6);
  props.push({ kind: "boat", x: ybx, z: ybz, yaw: yawOf(-RT[0], -RT[1]) + 0.12, v: 1, moor: [tealFront[0], DECK_Y - 0.4, tealFront[1]] });
  const [sbx, sbz] = W(36, 22);
  props.push({ kind: "boat", x: sbx, z: sbz, yaw: 0.35, v: 2, s: 0.85 });
  for (const [f, r, yaw, v] of [[70, -40, 1.3, 3], [90, 30, 2.6, 4], [80, -8, 0.2, 1]] as Array<[number, number, number, number]>) { const [x, z] = W(f, r); props.push({ kind: "boat", x, z, yaw, v }); }
  // ---- islets (sand + rock mounds the terrain does not have) with mangroves / palms
  const [ix, iz] = W(22, 17);
  props.push({ kind: "islet", x: ix, z: iz, yaw: 0.4, s: 3.8 });  // right-edge mangrove islet (frames the market, never blocks it)
  props.push({ kind: "islet", x: 362, z: -292, yaw: 1.1, s: 3.2 });
  // a rocky islet at the left edge of the view's frame, under a leaning palm + banana plant
  const [lix, liz] = W(18.5, -18.5);
  props.push({ kind: "islet", x: lix, z: liz, yaw: 0.8, s: 2.6 });
  props.push({ kind: "islet", x: 330, z: -284, yaw: 2.0, s: 3.6 });
  props.push({ kind: "islet", x: 344, z: -392, yaw: 0.2, s: 3.4 });
  props.push({ kind: "islet", x: 318, z: -372, yaw: 2.6, s: 3.0 });
  const isletR: Array<[number, number, number]> = props.filter((p) => p.kind === "islet").map((p) => [p.x, p.z, (p.s ?? 3) * 1.1]);
  // rocks among the piles + in the foreground water (never under a boat)
  const boats = props.filter((p) => p.kind === "boat");
  const clearOfBoats = (x: number, z: number, r: number) => boats.every((b) => dmath.hypot(b.x - x, b.z - z) > 3.4 * (b.s ?? 1) + r);
  // MOSSY BOULDERS 1–2 m among the piles under the left cluster and the
  // market, a couple in the open water
  for (const [f, r, s] of [[20.5, -11.5, 1.7], [23.5, -4.2, 1.2], [19.5, -16.5, 1.3], [26, 6.8, 1.5], [17.5, 10.5, 1.1], [30.5, -13.0, 1.4], [34, 12.5, 1.2], [15.5, -2.5, 0.9]] as Array<[number, number, number]>) {
    const [x, z] = W(f, r);
    if (!clearOfBoats(x, z, s)) continue;
    // (never under a deck / walkway — a boulder top 1.4 m under the planks is a crouch-only pocket)
    const under = [...decks, ...walks].some((k) => { const c = dmath.cos(k.yaw), sn = dmath.sin(k.yaw), dx = x - k.x, dz = z - k.z; return Math.abs(dx * c - dz * sn) < k.w / 2 + s + 0.3 && Math.abs(dx * sn + dz * c) < k.d / 2 + s + 0.3; });
    if (under) { rng(); continue; }
    props.push({ kind: "rock", x, z, yaw: rng() * 6.28, v: s });
  }
  // mangroves: dense on the right-edge islet, sparse on the others
  const MI = props.find((p) => p.kind === "islet")!;
  for (let i = 0; i < 9; i++) { const a = rng() * 6.28, r = rng() * (MI.s ?? 4) * 1.1; props.push({ kind: "mangrove", x: MI.x + dmath.cos(a) * r, z: MI.z + dmath.sin(a) * r, yaw: rng() * 6.28, s: 0.9 + rng() * 0.35 }); }
  for (const [x, z, s] of [[376, -392, 1.0], [366, -398, 1.1], [344, -396, 0.9], [318, -376, 1.0], [312, -366, 0.9], [410, -300, 1.0], [416, -290, 1.1], [300, -290, 1.0], [296, -300, 0.9]] as Array<[number, number, number]>) props.push({ kind: "mangrove", x, z, yaw: rng() * 6.28, s });
  // palms + banana plants on the islets and the shore behind
  { const [a, b] = W(18.3, -19.2), [c, d] = W(19.5, -17.6); props.push({ kind: "palm-leaning", x: a, z: b, yaw: 2.3, s: 1.1 }); props.push({ kind: "banana-plant", x: c, z: d, yaw: 0.6, s: 1.0 }); }
  for (const [x, z, s, k] of [[362, -290, 1.15, "palm"], [359, -294, 1.0, "banana-plant"], [366, -294, 0.9, "banana-plant"], [331, -283, 1.1, "palm-leaning"], [327, -287, 1.0, "banana-plant"], [346, -390, 1.05, "palm"], [341, -388, 0.9, "banana-plant"], [317, -373, 1.0, "palm"], [320, -369, 0.9, "banana-plant"], [MI.x + 2, MI.z - 3, 1.0, "palm-leaning"], [MI.x - 3, MI.z + 1, 0.9, "banana-plant"]] as Array<[number, number, number, StiltProp["kind"]]>) props.push({ kind: k, x, z, yaw: rng() * 6.28, s });
  // (the west shore is x ≤ 222 here and the north shore z ≥ −290; terrain-probed, every one on ground ≥ 0.5 m)
  const shorePalms: Array<[number, number]> = [[220, -344], [218, -330], [221, -318], [216, -356], [213, -338], [212, -324], [262, -281], [272, -282], [250, -287], [283, -277], [244, -292], [256, -278]];
  for (const [x, z] of shorePalms) props.push({ kind: rng() < 0.7 ? "palm" : "banana-plant", x, z, yaw: rng() * 6.28, s: 0.9 + rng() * 0.3 });
  props.push({ kind: "buoy", x: W(14, -14)[0], z: W(14, -14)[1], yaw: 0 });
  props.push({ kind: "buoy", x: W(22, 16)[0], z: W(22, 16)[1], yaw: 0 });
  void isletR;

  // a water stair (and its rail gap) is dropped when it runs into another deck / walkway / plank link / hut / boat /
  // islet / rock
  {
    type P2 = Array<[number, number]>;
    const rect = (cx: number, cz: number, yaw: number, w: number, d: number): P2 => { const c = dmath.cos(yaw), s = dmath.sin(yaw); return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => [cx + a * w / 2 * c + b * d / 2 * s, cz - a * w / 2 * s + b * d / 2 * c] as [number, number]); };
    const circ = (cx: number, cz: number, r: number): P2 => Array.from({ length: 8 }, (_, i) => [cx + dmath.cos(i * Math.PI / 4) * r, cz + dmath.sin(i * Math.PI / 4) * r] as [number, number]);
    const overlap = (A: P2, B: P2) => { for (const Q of [A, B]) for (let i = 0; i < Q.length; i++) { const a = Q[i], b = Q[(i + 1) % Q.length], nx = -(b[1] - a[1]), nz = b[0] - a[0]; let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity; for (const p of A) { const d = p[0] * nx + p[1] * nz; a0 = Math.min(a0, d); a1 = Math.max(a1, d); } for (const p of B) { const d = p[0] * nx + p[1] * nz; b0 = Math.min(b0, d); b1 = Math.max(b1, d); } if (a1 <= b0 || b1 <= a0) return false; } return true; };
    const obst: Array<{ p: P2; o: unknown }> = [
      ...[...decks, ...walks].map((d) => ({ p: rect(d.x, d.z, d.yaw, d.w, d.d), o: d as unknown })),
      ...huts.map((h) => ({ p: rect(h.x, h.z, h.yaw, h.w + 0.4, h.d + 0.4), o: h as unknown })),
      ...ropeWalks.map((r) => ({ p: rect((r.a[0] + r.b[0]) / 2, (r.a[1] + r.b[1]) / 2, dmath.atan2(r.b[0] - r.a[0], r.b[1] - r.a[1]), r.w + 0.2, dmath.hypot(r.b[0] - r.a[0], r.b[1] - r.a[1]) + 0.4), o: r as unknown })),
      ...props.filter((q) => q.kind === "boat" || q.kind === "dinghy" || q.kind === "islet" || q.kind === "rock" || q.kind === "mooring").map((q) => ({ p: circ(q.x, q.z, q.kind === "boat" ? 3.2 * (q.s ?? 1) : q.kind === "dinghy" ? 2.3 : q.kind === "islet" ? (q.s ?? 3) * 1.1 : q.kind === "rock" ? (q.v ?? 1) : 0.4), o: q as unknown })),
      ...stairs.filter((f) => !waterStairs.some((w) => w.st === f)).map((f) => ({ p: rect(f.x + f.dirX * f.steps * f.tread / 2, f.z + f.dirZ * f.steps * f.tread / 2, dmath.atan2(f.dirX, f.dirZ), f.width, f.steps * f.tread), o: f as unknown })),
    ];
    const keep: typeof waterStairs = [];
    for (const w of waterStairs) {
      const f = w.st, run = f.steps * f.tread;
      // the stair footprint starts 0.1 m past its own deck's edge
      const P = rect(f.x + f.dirX * (run / 2 + 0.1), f.z + f.dirZ * (run / 2 + 0.1), dmath.atan2(f.dirX, f.dirZ), f.width + 0.3, run);
      const hit = obst.some((ob) => ob.o !== w.dk && overlap(P, ob.p)) || keep.some((k) => overlap(P, rect(k.st.x + k.st.dirX * k.st.steps * k.st.tread / 2, k.st.z + k.st.dirZ * k.st.steps * k.st.tread / 2, dmath.atan2(k.st.dirX, k.st.dirZ), k.st.width + 0.3, k.st.steps * k.st.tread)));
      if (!hit) { keep.push(w); continue; }
      stairs.splice(stairs.indexOf(f), 1);
      w.dk.gaps!.pop();   // (its gap was the deck's latest)
    }
    // ---- SWIM-OUTS. Only ~13 water stairs survive the test above: a kong who slides off the shore spine swims up to
    // 41 m (13 s) to the nearest way out, 36 % of the water beside the decks is > 15 m from one. Greedy: candidate stairs
    // every 2.5 m along every deck side (straight out, the same footprint test), add the one that shortens the most
    // swims until no deck-side water is > 11 m from a stair or the shore
    {
      const G: GroundGrid = (SLOPE as unknown as { grids: Record<string, GroundGrid> }).grids["stilt-town"];
      const allD = [...decks, ...walks];
      const inD = (x: number, z: number, m: number) => allD.some((k) => { const c = dmath.cos(k.yaw), s = dmath.sin(k.yaw), dx = x - k.x, dz = z - k.z; return Math.abs(dx * c - dz * s) < k.w / 2 + m && Math.abs(dx * s + dz * c) < k.d / 2 + m; });
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const k of allD) { const r = dmath.hypot(k.w, k.d) / 2 + 5; x0 = Math.min(x0, k.x - r); x1 = Math.max(x1, k.x + r); z0 = Math.min(z0, k.z - r); z1 = Math.max(z1, k.z + r); }
      const water: V2[] = [], ways: V2[] = [];
      for (let x = x0; x <= x1; x += 2) for (let z = z0; z <= z1; z += 2) {
        const h = gridH(G, x, z);
        if (h > 0.4) ways.push([x, z]);
        else if (h < -0.2 && inD(x, z, 4) && !inD(x, z, 0)) water.push([x, z]);
      }
      const foot = (f: StiltStair): V2 => [f.x + f.dirX * f.steps * f.tread, f.z + f.dirZ * f.steps * f.tread];
      for (const f of stairs) if (f.yBottom < 0.5) ways.push(foot(f));
      const dist = water.map(([x, z]) => { let d = Infinity; for (const [a, b] of ways) d = Math.min(d, dmath.hypot(a - x, b - z)); return d; });
      const stairRect = (f: StiltStair) => rect(f.x + f.dirX * (f.steps * f.tread / 2 + 0.1), f.z + f.dirZ * (f.steps * f.tread / 2 + 0.1), dmath.atan2(f.dirX, f.dirZ), f.width + 0.3, f.steps * f.tread);
      type Cand = { dk: Deck; x: number; z: number; dx: number; dz: number };
      const cands: Cand[] = [];
      for (const dk of allD) {
        if (dk.y < 1) continue;
        const c = dmath.cos(dk.yaw), s = dmath.sin(dk.yaw);
        for (let side = 0; side < 4; side++) {
          const len = side % 2 === 0 ? dk.w : dk.d;
          for (let u = 1.3; u <= len - 1.3; u += 2.5) {
            const lx = side === 0 ? -dk.w / 2 + u : side === 1 ? dk.w / 2 - 0.02 : side === 2 ? dk.w / 2 - u : -dk.w / 2 + 0.02;
            const lz = side === 0 ? dk.d / 2 - 0.02 : side === 1 ? dk.d / 2 - u : side === 2 ? -dk.d / 2 + 0.02 : -dk.d / 2 + u;
            const nl: V2 = side === 0 ? [0, 1] : side === 1 ? [1, 0] : side === 2 ? [0, -1] : [-1, 0];
            cands.push({ dk, x: dk.x + lx * c + lz * s, z: dk.z - lx * s + lz * c, dx: nl[0] * c + nl[1] * s, dz: -nl[0] * s + nl[1] * c });
          }
        }
      }
      const placed: StiltStair[] = [];
      const wx = Float64Array.from(water, (w) => w[0]), wz = Float64Array.from(water, (w) => w[1]);
      for (let it = 0; it < 40; it++) {
        // (only the water still > 11 m out can gain: summing over just those, in the same order, is the same gain
        // without ~1 s of Math.hypot at import)
        const far: number[] = [];
        for (let i = 0; i < water.length; i++) if (dist[i] > 11) far.push(i);
        if (!far.length) break;
        let best: { c: Cand; st: StiltStair; gain: number } | null = null;
        for (const cd of cands) {
          const n = Math.max(2, Math.ceil((cd.dk.y - WATER_FOOT) / 0.19)), st: StiltStair = { x: cd.x, z: cd.z, dirX: cd.dx, dirZ: cd.dz, width: 1.05, yTop: cd.dk.y, yBottom: WATER_FOOT, steps: n, rise: (cd.dk.y - WATER_FOOT) / n, tread: 0.3 };
          const [fx, fz] = foot(st);
          if (gridH(G, fx, fz) > -0.3) continue;
          let gain = 0;
          for (const i of far) {
            const dx = wx[i] - fx, dz = wz[i] - fz, D = dist[i];
            if (dx * dx + dz * dz >= D * D * 1.000001) continue;   // (surely no nearer: skip the exact hypot)
            const d = dmath.hypot(dx, dz); if (d < D) gain += Math.min(D, 30) - d;
          }
          if (gain <= (best?.gain ?? 20)) continue;
          const P = stairRect(st);
          if (obst.some((ob) => ob.o !== cd.dk && overlap(P, ob.p)) || [...keep.map((k) => k.st), ...placed].some((k) => overlap(P, stairRect(k)))) continue;
          // (and clear of every rail-less stair / link landing on the same deck edge)
          if (stairs.some((f) => dmath.hypot(f.x - st.x, f.z - st.z) < 2.2) || ropeWalks.some((r) => dmath.hypot(r.a[0] - st.x, r.a[1] - st.z) < 2.4 || dmath.hypot(r.b[0] - st.x, r.b[1] - st.z) < 2.4)) continue;
          best = { c: cd, st, gain };
        }
        if (!best) break;
        stairs.push(best.st); placed.push(best.st);
        deckGap(best.c.dk, best.st.x + best.st.dirX * 0.03, best.st.z + best.st.dirZ * 0.03, 1.4);
        const [fx, fz] = foot(best.st);
        for (let i = 0; i < water.length; i++) dist[i] = Math.min(dist[i], dmath.hypot(water[i][0] - fx, water[i][1] - fz));
      }
    }
  }
  // ---- OPEN-GROUND COVER on the shore inside the circle (hard cover within ~8 m) — palm groups and mossy
  // boulder outcrops on a jittered 12 m grid, on dry ground clear of the village
  {
    const G: GroundGrid = (SLOPE as unknown as { grids: Record<string, GroundGrid> }).grids["stilt-town"];
    const near = (x: number, z: number, m: number) => [...decks, ...walks].some((k) => { const c = dmath.cos(k.yaw), sn = dmath.sin(k.yaw), dx = x - k.x, dz = z - k.z; return Math.abs(dx * c - dz * sn) < k.w / 2 + m && Math.abs(dx * sn + dz * c) < k.d / 2 + m; })
      || props.some((q) => (q.kind === "palm" || q.kind === "palm-leaning" || q.kind === "rock" || q.kind === "islet") && dmath.hypot(q.x - x, q.z - z) < m + 1);
    // (a 10 m grid of palm groups makes a palm wall along both shores — the village cannot be read from the
    //  beach. 15 m grid, 'palms' cells become boulder outcrops (hard cover) with at most one palm, groves 1–2 palms)
    for (const c0 of coverScatter(G, { cx: CX, cz: CZ, r: P.r, step: 15, seed: 9131, minY: 0.9, free: (x, z) => !near(x, z, 5) })) {
      const c = c0.kind === "palms" ? { ...c0, kind: "rocks" as const } : c0;
      const g = (dx: number, dz: number) => gridH(G, c.x + dx, c.z + dz);
      if (c0.kind === "palms" && rng() < 0.35) props.push({ kind: "palm", x: c.x + 3.6, z: c.z - 1.0, y: g(3.6, -1.0), yaw: rng() * 6.28, s: 0.95 + rng() * 0.25 });
      if (c.kind === "rocks") {
        const n = 1 + Math.floor(rng() * 2.4);
        for (let i = 0; i < n; i++) { const a = rng() * 6.283, r = i ? 1.4 + rng() : 0, v = (i ? 0.75 + rng() * 0.4 : 1.45 + rng() * 0.4) * c.s; props.push({ kind: "rock", x: c.x + dmath.cos(a) * r, z: c.z + dmath.sin(a) * r, y: g(dmath.cos(a) * r, dmath.sin(a) * r), yaw: rng() * 6.28, v, land: true }); }
        for (let i = 0; i < 3; i++) { const a = rng() * 6.283, r = 2 + rng() * 1.5; props.push({ kind: rng() < 0.5 ? "fern" : "bush", x: c.x + dmath.cos(a) * r, z: c.z + dmath.sin(a) * r, y: g(dmath.cos(a) * r, dmath.sin(a) * r), yaw: rng() * 6.28, s: 0.8 + rng() * 0.4 }); }
      } else {
        const n = 1 + (rng() < 0.45 ? 1 : 0);
        for (let i = 0; i < n; i++) { const a = rng() * 6.283, r = i ? 1.8 + rng() * 1.6 : 0; props.push({ kind: rng() < 0.4 ? "palm-leaning" : "palm", x: c.x + dmath.cos(a) * r, z: c.z + dmath.sin(a) * r, y: g(dmath.cos(a) * r, dmath.sin(a) * r), yaw: rng() * 6.28, s: 0.9 + rng() * 0.3 }); }
        for (let i = 0; i < 3; i++) { const a = rng() * 6.283, r = 1 + rng() * 2.8, k = rng(); props.push({ kind: k < 0.35 ? "banana-plant" : k < 0.7 ? "bush" : "fern", x: c.x + dmath.cos(a) * r, z: c.z + dmath.sin(a) * r, y: g(dmath.cos(a) * r, dmath.sin(a) * r), yaw: rng() * 6.28, s: 0.8 + rng() * 0.5 }); }
      }
    }
  }
  // (the shore palms seated on the ground grid — otherwise their foot colliders stand at sea level)
  { const G: GroundGrid = (SLOPE as unknown as { grids: Record<string, GroundGrid> }).grids["stilt-town"];
    for (const q of props) if ((q.kind === "palm" || q.kind === "palm-leaning") && q.y === undefined && !props.some((i) => i.kind === "islet" && dmath.hypot(i.x - q.x, i.z - q.z) < (i.s ?? 3) * 1.2)) { const g = gridH(G, q.x, q.z); if (g > 0.3) q.y = g; } }
  // (nothing stands on a roof stair's footprint)
  for (const st of roofStairs) {
    const run = st.steps * st.tread, mx = st.x + st.dirX * run / 2, mz = st.z + st.dirZ * run / 2;
    for (let i = props.length - 1; i >= 0; i--) {
      const q = props[i], qx = q.x - mx, qz = q.z - mz;
      if (Math.abs(qx * st.dirX + qz * st.dirZ) < run / 2 + 0.6 && Math.abs(-qx * st.dirZ + qz * st.dirX) < st.width / 2 + 0.6 && (q.y ?? DECK_Y) > 1) props.splice(i, 1);
    }
  }
  // (nothing stands on / grows through the two beach boardwalks or their shore stairs)
  {
    const onWalk = (x: number, z: number, m: number) => extraWalks.some((k) => { const c = dmath.cos(k.yaw), s = dmath.sin(k.yaw), dx = x - k.x, dz = z - k.z; return Math.abs(dx * c - dz * s) < k.w / 2 + m && Math.abs(dx * s + dz * c) < k.d / 2 + 3.5 + m; });
    for (let i = props.length - 1; i >= 0; i--) { const q = props[i]; const r = q.kind === "boat" ? 3.4 * (q.s ?? 1) : q.kind === "dinghy" ? 2.4 : q.kind === "islet" ? (q.s ?? 3) * 1.1 : q.kind === "rock" ? (q.v ?? 1) : q.kind === "palm" || q.kind === "palm-leaning" || q.kind === "mangrove" ? 1.2 : 0.6; if (onWalk(q.x, q.z, r)) props.splice(i, 1); }
  }
  const parts = huts.map(resolveBuilding);
  const places: StiltLayout["places"] = [];
  if (netSquare) { const k = netSquare, c = dmath.cos(k.yaw), s = dmath.sin(k.yaw); places.push({ kind: "plaza", name: "Net Square", x: k.x, z: k.z, poly: [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, e]) => { const lx = a * k.w / 2, lz = e * k.d / 2; return [k.x + lx * c + lz * s, k.z - lx * s + lz * c] as V2; }) }); }
  // (top = the roof + its timber water tower: legs 3.2 m + tank)
  if (lookout) places.push({ kind: "landmark", name: "The Lookout", x: lookout.x, z: lookout.z, top: lookout.y + lookout.floors * (lookout.floorH ?? 2.9) + 3.29 + 1.45 });
  return { decks, walks, ropeWalks, huts, parts, props, stairs, places };
}
export const LAYOUT: StiltLayout = genLayout();
export const PLACES = LAYOUT.places;

function propColliders(): Box[] {
  const out: Box[] = [];
  for (const p of LAYOUT.props) {
    const y = p.y ?? DECK_Y;
    switch (p.kind) {
      case "boat": out.push({ c: [p.x, 0.35, p.z], h: [2.8 * (p.s ?? 1), 0.45, 0.8 * (p.s ?? 1)], yaw: p.yaw, surf: "wood" }); break;
      case "barrel": case "wbarrel": case "drum": for (const yw of [0, Math.PI / 4]) out.push({ c: [p.x, y + 0.44, p.z], h: [0.29, 0.44, 0.29], yaw: yw, surf: p.kind === "wbarrel" ? "wood" : "metal" }); break;
      case "crate": out.push({ c: [p.x, y + 0.17, p.z], h: [0.31, 0.17, 0.22], yaw: p.yaw, surf: "wood" }); break;
      case "sack": out.push({ c: [p.x, y + 0.25, p.z], h: [0.35, 0.25, 0.3], yaw: p.yaw, surf: "fabric" }); break;
      case "rock": if (p.land) out.push(...rockBoxes(p.x, p.y ?? 0, p.z, p.v ?? 1, p.yaw)); else out.push({ c: [p.x, 0, p.z], h: [(p.v ?? 1) * 0.9, (p.v ?? 1) * 0.7, (p.v ?? 1) * 0.9], surf: "stone" }); break;
      case "islet": out.push({ c: [p.x, 0.1, p.z], h: [(p.s ?? 3) * 0.95, 0.6, (p.s ?? 3) * 0.8], yaw: p.yaw, surf: "sand" }); break;
      // (veg-drawn curved trunks — only the foot collides)
      case "palm": case "palm-leaning": out.push(...palmBoxes(p.x, p.y ?? 0, p.z, p.s ?? 1)); break;
      case "mangrove": out.push({ c: [p.x, (p.y ?? 0) + 0.75, p.z], h: [0.22 * (p.s ?? 1), 0.75, 0.22 * (p.s ?? 1)], surf: "wood" }); break;
      case "derrick": out.push({ c: [p.x, y + 2.5, p.z], h: [0.18, 2.5, 0.18], surf: "wood" }); break;
      case "post": out.push({ c: [p.x, y + 1.4, p.z], h: [0.07, 1.4, 0.07], surf: "wood" }); break;
      case "bollard": out.push({ c: [p.x, y + 0.45, p.z], h: [0.16, 0.45, 0.16], surf: "wood" }); break;
      case "mooring": out.push({ c: [p.x, (p.h ?? 2.5) / 2 - 0.5, p.z], h: [0.16, (p.h ?? 2.5) / 2 + 0.5, 0.16], surf: "wood" }); break;
      default: break;
    }
  }
  // stairs: one solid box per step (lower deck → step top)
  for (const f of LAYOUT.stairs) {
    const yaw = dmath.atan2(f.dirX, f.dirZ);
    for (let i = 0; i < f.steps; i++) {
      const u = (i + 0.5) * f.tread, top = f.yTop - (i + 1) * f.rise;
      if (top <= f.yBottom + 1e-3) break;
      out.push({ c: [f.x + f.dirX * u, (f.yBottom - 0.1 + top) / 2, f.z + f.dirZ * u], h: [f.width / 2, (top - f.yBottom + 0.1) / 2, f.tread / 2 + 0.005], yaw, surf: "wood" });
    }
  }
  // plank links: thin wood slabs (+ rope rails as low walls so players don't slide off)
  for (const r of LAYOUT.ropeWalks) {
    const dx = r.b[0] - r.a[0], dz = r.b[1] - r.a[1], len = dmath.hypot(dx, dz), yaw = dmath.atan2(dx, dz);
    out.push({ c: [(r.a[0] + r.b[0]) / 2, r.y - 0.08, (r.a[1] + r.b[1]) / 2], h: [r.w / 2, 0.08, len / 2 + 0.3], yaw, surf: "wood" });
    // (the rail posts + the piles under long spans, as client town-lagoon addPlankBridge draws them)
    const mx = (r.a[0] + r.b[0]) / 2, mz = (r.a[1] + r.b[1]) / 2, cy = dmath.cos(yaw), sy = dmath.sin(yaw), np = Math.max(1, Math.round(len / 2.4));
    for (let i = 0; i <= np; i++) for (const sd of [-1, 1]) {
      const lx = sd * (r.w / 2 - 0.05), lz = (i / np - 0.5) * len, x = mx + lx * cy + lz * sy, z = mz - lx * sy + lz * cy;
      out.push({ c: [x, r.y + 0.5, z], h: [0.05, 0.53, 0.05], surf: "wood" });
      if (i > 0 && i < np && len > 5) out.push({ c: [x, (r.y - 0.1 - 4) / 2, z], h: [0.1, (r.y - 0.1 + 4) / 2, 0.1], surf: "wood" });
    }
  }
  return out;
}
// (simBoxes — the layout's three.js yaws → the sim's convention, see town-kit simBoxes)
// hut interiors by the shared interiors kit (fisher's huts / bunk rooms; the market = a fish shop)
export const INTERIOR_ROOMS: InteriorRoom[] = LAYOUT.parts.flatMap((p) => buildingRooms(p, { style: "hut", shopStyle: "hut" }));
const INTERIORS = townInteriors("stilt-town", INTERIOR_ROOMS, (TOWN_INT as unknown as Record<string, TownInteriorBake | undefined>)["stilt-town"]);
export const INTERIOR_LOOT = INTERIORS.loot;
export const colliders: Box[] = [...simBoxes([
  ...LAYOUT.parts.flatMap(buildingColliders),
  ...LAYOUT.decks.flatMap(deckColliders),
  ...LAYOUT.walks.flatMap(deckColliders),
  ...propColliders(),
]), ...INTERIORS.colliders];
/** LOOT_SPOTS: every hut room (interiors kit: a chest + floor spots), floor loot on the walkway decks and the
 *  porches (the fish market is a shop room of the kit).
 *  The payoff a hot drop expects — a chest on the Lookout's roof (the sniper perch), a chest + floor loot among
 *  Net Square's cargo, a chest on the market's porch under the nets. No loot in the boats (a swimmer climbs out of a
 *  rowing boat with nowhere to stand), and every spot is settled against the village's own colliders
 *  (porch spots otherwise land inside barrels / crates / stair cheeks) */
/** the Lookout is the village's HOT building (shared/sim/loot-spots.ts roomUnits): a chest spot on every
 *  storey (≥ 1 live per storey) + one on the roof perch — without them its 2nd storey is empty in 80-90 % of seeds and
 *  the whole village has 6 chest spots / 38 % live against 26 floor guns */
export const LOOT_HOT = (() => { const t = LAYOUT.parts.find((p) => p.b.use === "tower"); return t ? [{ x: t.b.x, z: t.b.z, r: 4, chests: 1, roof: 1 }] : []; })();
export const LOOT_SPOTS = (() => {
  const floor: Array<[number, number, number]> = [], chests: Array<[number, number, number, number]> = [];
  const tower = LAYOUT.parts.find((p) => p.b.use === "tower");
  if (tower) { const b = tower.b, c = dmath.cos(b.yaw), s = dmath.sin(b.yaw); chests.push([b.x - 2.2 * c - 2.2 * s, tower.roof.y, b.z + 2.2 * s - 2.2 * c, b.yaw]); }
  const sq = LAYOUT.places.find((q) => q.name === "Net Square"), nsq = LAYOUT.decks.find((k) => sq && k.x === sq.x && k.z === sq.z);
  if (nsq) { const c = dmath.cos(nsq.yaw), s = dmath.sin(nsq.yaw), Q = (lx: number, lz: number): [number, number] => [nsq.x + lx * c + lz * s, nsq.z - lx * s + lz * c];
    { const [x, z] = Q(-1.4, -2.2); chests.push([x, nsq.y, z, nsq.yaw]); }
    for (const [lx, lz] of [[2.6, 1.0], [-6.0, 1.2], [5.0, -1.6]]) { const [x, z] = Q(lx, lz); floor.push([x, nsq.y, z]); } }
  { const m = LAYOUT.huts[0], c = dmath.cos(m.yaw), s = dmath.sin(m.yaw), lz = m.d / 2 + 2.3; chests.push([m.x + 2.6 * c + lz * s, DECK_Y, m.z - 2.6 * s + lz * c, m.yaw + Math.PI]); }
  for (const w of LAYOUT.walks) if (w.d > 6) floor.push([w.x, w.y, w.z]);
  for (const k of LAYOUT.decks) if (k.y > 1) floor.push([k.x + dmath.sin(k.yaw) * (k.d / 2 - 0.9), k.y, k.z + dmath.cos(k.yaw) * (k.d / 2 - 0.9)]);
  const L = townLootSpots(INTERIOR_LOOT, { floor, chests, chestSep: 5 });
  return { chests: settleLoot(L.chests, colliders, { chest: true, needFloor: () => true, snap: 0.2 }), floor: settleLoot(L.floor, colliders, { needFloor: () => true }) };
})();

/** areas vegetation / random scatter must leave clear (the POI dresses them itself). Circles or yaw-rotated rects. */
// (+ a small one round a trunk / rock pocket on the north shore the scanner reads as a 1 m² trap)
export const clearings: Array<Clearing | { x: number; z: number; hx: number; hz: number; yaw?: number }> = [{ x: CX + 20, z: CZ, r: 120 }, { x: 382, z: -212.6, r: 4 }];
