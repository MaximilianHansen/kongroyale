// POI peel-harbor — ONE layout for visuals (client/src/world/pois/peel-harbor) and collision (server + prediction).
// Pure data + derivations, no three.js.
//
// HARBOR-LOCAL FRAME. Everything below is authored in a local frame where the ship berth faces local +X, and mapped to
// the world by ONE transform (FRAME): world = (FRAME.x − lz, FRAME.z + lx), i.e. a −90° yaw (three.js rotation.y) +
// translation. So local +X (the berth, the water) = world SOUTH (the harbor inlet), local +Z = world WEST (the rocky
// headland), local −Z = world EAST (the deep east quay), local −X = world NORTH (island interior).
// The terrain area's promise (terrain-gen HARBOR_APRON / COAST / HARBOR_DEEP): apron ≤ pad inside the polygon, water
// south (inlet, −6 m) and east (berth, −10 m), the headland rises straight out of the SW corner.
//
// Composition: the view camera hangs over the inlet SW of the port (local SE: +X, +Z) looking local WNW. The berth
// quay runs from the pier (bottom centre, near end, local z = 470) away to the right; the ship lies along it (bow
// toward the camera), two gantry cranes straddle the quay, the stacked yard fills the middle, the arched warehouses +
// white fuel tanks sit left/back, the headland's jungle is the bottom-left foreground.
//
// Every part file reads its numbers from here — never hard-code positions there. Colliders are exported in WORLD space.
import type { Box } from "../world/colliders";
import { furnishRoom, type InteriorRoom, type RoomOpening } from "./interior-kit";
import { mulberry32 } from "../world/noise";
import { bakedLayouts, bakedRockBoxes, rockSig, type RockBake, type RockPl, type RockSet, bakedRooms, boxesSig, type RoomBake, boxGrid, hash01, noLowStep, containerBoxes, containerDims, faceYaw, floorUnder, flight, hutPieces, qPoint, type Opening, type PieceMat, pieceBox, qPiece, railRun, slabXYZ, stairwell, floorWithHoles, wallRun, type ContainerColor, type ContainerPlacement, type Piece, type QFrame } from "./harbor-kit";
export type { Piece } from "./harbor-kit";
// the furnished rooms + LOOT_SPOTS come from an offline bake (stale → computed live + a warning)
import BAKE from "./peel-harbor-baked.json";
import ROCKS_BAKED from "./harbor-rocks-baked.json";
import * as dmath from "../sim/dmath";

// ---------------------------------------------------------------- frame
/** local → world: world.x = x − lz, world.z = z + lx (three.js: group.position (x,0,z), group.rotation.y = yaw) */
export const FRAME = { x: 910, z: -336, yaw: -Math.PI / 2 };
export function toWorld(lx: number, lz: number): [number, number] { return [FRAME.x - lz, FRAME.z + lx]; }
export function toLocal(wx: number, wz: number): [number, number] { return [wz - FRAME.z, FRAME.x - wx]; }
/** a local yaw (three.js convention) → world yaw */
export const worldYaw = (localYaw: number) => localYaw + FRAME.yaw;

export const PAD_Y = 3.2;
/** apron slab top: 40 cm above the pad so the natural terrain never pokes through */
export const APRON_Y = PAD_Y + 0.4;
export const APRON_BOTTOM = -6;

/**
 * Apron / wharf outline (local x, z) — the terrain's HARBOR_APRON promise, with the berth pushed out to the real
 * waterline (local x = 890 = world z 556). Edge i = APRON[i] → APRON[i+1].
 */
export const APRON: Array<[number, number]> = [
  [896, 470], [896, 262], [848, 214], [805, 170], [776, 140], [772, 40], [566, 40], [566, 130], [556, 190], [526, 210],
  [526, 370], [551, 410], [576, 450], [596, 470],
];
/** apron edges that face open water (quay wall face, capping beam, fenders) */
export const WATER_EDGES = [0, 1, 2, 3, 4, 5];
/** edges of the berth itself (hazard capping + yellow/black fender panels + bollards) */
export const BERTH_EDGES = [0];

export const QUAY = {
  /** berth face (local x) and its extent along z (near end = eastZ1, by the pier) */
  eastX: 896, eastZ0: 262, eastZ1: 470,
  /** the crane rails run between these z (the near corner stays free for the pier approach) */
  railZ0: 266, railZ1: 440,
};

/**
 * Ship-to-shore gantry cranes (two, identical, on the berth rails). Local frame: legs at (railLand | railSea,
 * z ± legHalfZ); the boom reaches out over the water toward +X, the backreach + machinery house toward −X.
 * All heights are ABSOLUTE world y.
 */
export const CRANE = {
  /** z of each crane centre; [0] = the one nearer the camera */
  zs: [398, 302] as number[],
  railLand: 868, railSea: 888,
  legHalfZ: 8.5, legW: 1.9,
  sillTop: APRON_Y + 2.6,
  portalY: 31,
  girderX0: 846, girderX1: 942, girderY0: 31, girderY1: 34.2, girderHalfZ: 2.5,
  apexX: 886, apexY: 56,
  // (2.6 half width leaves a 1.5 m girder walkway beside the house — 0.7 m left no way to its door)
  house: { x0: 847, x1: 865, y0: 34.2, y1: 39.6, halfZ: 2.6 },
  cabin: { dx: -3.2, y0: 27.2, y1: 30.6, halfX: 1.5, halfZ: 1.3 },
  /** trolley x per crane + spreader height (crane[0] lifts a blue container over the ship) */
  trolleyX: [919, 906] as number[], spreaderY: [21, 14.5] as number[],
  stair: { dx: -2.6, w: 1.2, flight: 3.4 },
};

/** the moored container feeder along the berth. Bow toward +Z (the near end / the view camera). */
export const SHIP = {
  x: 909.5, z: 318, length: 150, beam: 22, yaw: 0,
  deckY: 9.2, keelY: -4.5,
  house: { z: 259, halfL: 7.5, halfW: 9.5, top: 25.5, funnelTop: 31 },
  bays: { z0: 271, z1: 373 },
  forecastle: { z0: 377, z1: 393, top: 12.2 },
};
export const BOW_Z = SHIP.z + SHIP.length / 2;
export const STERN_Z = SHIP.z - SHIP.length / 2;
/** gangway z (quay → main deck, aft of the bays) */
export const GANGWAY_Z = 287.5;
/** the accommodation ladder: from the apron beside the berth edge, climbing along the hull (+z) to the main deck at
 *  GANGWAY_Z (≈ 21°, 0.35 m treads). a = foot, b = top (on the deck edge), w = width. */
// 2.6 m wide, railed (colliders), and a SECOND gangway forward
export const GANGWAY = { a: [QUAY.eastX - 2.4, APRON_Y, GANGWAY_Z - 15] as [number, number, number], b: [SHIP.x - SHIP.beam / 2 + 0.9, SHIP.deckY, GANGWAY_Z] as [number, number, number], w: 2.6 };
export const GANGWAY2_Z = 349.5;
export const GANGWAY2 = { a: [QUAY.eastX - 2.4, APRON_Y, GANGWAY2_Z - 15] as [number, number, number], b: [SHIP.x - SHIP.beam / 2 + 0.9, SHIP.deckY, GANGWAY2_Z] as [number, number, number], w: 2.6 };
export const GANGWAYS = [GANGWAY, GANGWAY2];
/** ways OUT of the water.
 *  SEA_LADDERS: accommodation ladders down the SEAWARD hull side (x = SHIP.x + beam/2) from a landing stage at the
 *  waterline (top −0.7: a swimmer floats with the feet at −1.15 and steps onto it) up to the main deck.
 *  QUAY_STAIRS: water stairs let into the quay walls — along the berth face (in the 2.5 m gap between quay and hull)
 *  and the south inlet edge. Each: a straight flight from the water (−0.7) to the capping top; `along` = the axis the
 *  flight climbs along, `from` → `to` its foot → head coordinate on that axis, `at` the fixed coordinate of its outer
 *  face side, `out` = +1 / −1 the side away from the wall. All harbor-local. */
export const WATER_STEP_Y = -0.7;
export const SEA_LADDERS = [{ zBot: 262.0, zTop: 274.0 }, { zBot: 297.2, zTop: 309.2 }, { zBot: 342.6, zTop: 330.6 }];
export const QUAY_STAIRS: Array<{ along: "x" | "z"; from: number; to: number; at: number; out: 1 | -1; top: number }> = [
  { along: "z", from: 274.2, to: 268.6, at: QUAY.eastX, out: 1, top: APRON_Y + 0.45 },
  { along: "z", from: 331.6, to: 326.0, at: QUAY.eastX, out: 1, top: APRON_Y + 0.45 },
  { along: "z", from: 385.6, to: 380.0, at: QUAY.eastX, out: 1, top: APRON_Y + 0.45 },
  { along: "z", from: 426.6, to: 421.0, at: QUAY.eastX, out: 1, top: APRON_Y + 0.45 },
  { along: "x", from: 601.6, to: 596.0, at: 40, out: -1, top: APRON_Y + 0.3 },
  { along: "x", from: 645.6, to: 640.0, at: 40, out: -1, top: APRON_Y + 0.3 },
  { along: "x", from: 693.6, to: 688.0, at: 40, out: -1, top: APRON_Y + 0.3 },
  { along: "x", from: 735.6, to: 730.0, at: 40, out: -1, top: APRON_Y + 0.3 },
  // the inlet's east wall (edge 4 runs 776,140 → 772,40: 4 cm a metre off the z axis)
  { along: "z", from: 81.6, to: 76.0, at: 773.7, out: 1, top: APRON_Y + 0.3 },
  // the pier head's seaward face (PIER.head.x1 = 915) up to the pier deck (PIER.deckY = APRON_Y − 1)
  { along: "z", from: 462.6, to: 459.0, at: 915, out: 1, top: APRON_Y - 1.0 },
];
/** one water stair's treads: harbor-local boxes [x0, x1, y0, y1, z0, z1] (each from the sea bed to its tread top) */
export function quayStairTreads(q: (typeof QUAY_STAIRS)[number]): Array<[number, number, number, number, number, number]> {
  const n = Math.ceil((q.top - WATER_STEP_Y) / 0.33), rise = (q.top - WATER_STEP_Y) / n, run = (q.to - q.from) / (n - 1), W = 1.45;
  const out: Array<[number, number, number, number, number, number]> = [];
  const foot = Math.sign(q.from - q.to);
  for (let k = 0; k < n; k++) {
    // (the foot tread reaches 0.6 m further out: a swimmer finds it before the wall)
    const c = q.from + run * k, ext = k === 0 ? 0.6 : 0, a0 = c - Math.abs(run) / 2 - (foot < 0 ? ext : 0), a1 = c + Math.abs(run) / 2 + (foot > 0 ? ext : 0);
    const [s0, s1] = q.out > 0 ? [q.at + 0.02, q.at + W] : [q.at - W, q.at - 0.02];
    const y1 = WATER_STEP_Y + rise * k;
    if (q.along === "z") out.push([s0, s1, -4, y1, a0, a1]);
    else out.push([a0, a1, -4, y1, s0, s1]);
  }
  return out;
}
export const SHIP_CONTAINERS: ContainerPlacement[] = [];

/** wooden pier off the near corner of the berth, out into the inlet (bottom centre of the view) */
export const PIER = { z: 459, x0: 896, x1: 908, width: 5, deckY: APRON_Y - 1.0, head: { x0: 905, x1: 915, z0: 452, z1: 466 } };
/** steps from the apron edge down to the pier deck (visual + collider) */
export function pierSteps(): Array<{ x: number; z: number; y0: number; y1: number; w: number; d: number }> {
  const out = [], n = 3, rise = (APRON_Y - PIER.deckY) / n;
  for (let k = 0; k < n; k++) out.push({ x: PIER.x0 + 0.25 + k * 0.45, z: PIER.z, y0: PIER.deckY - 0.3, y1: APRON_Y - rise * (k + 1), w: 0.45, d: PIER.width });
  return out;
}

/** the pier's timber as the client draws it (client peel-harbor/pier.ts), so rounds stop at the piles, the cap
 *  beams, the mooring posts and the moored boat, not only the deck. The piles (sea bed → under the caps), the cap beams, the boat:
 *  noDrive (a boat / tuk-tuk is not stopped by them). The X braces (diagonal 14 cm timbers) stay see-through. Local. */
export function pierExtraBoxes(): Box[] {
  const P = PIER, dy = P.deckY, hw = P.width / 2, out: Box[] = [], top = dy - 0.45, bot = -7;
  const pile = (x: number, z: number) => out.push({ c: [x, (bot + top) / 2, z], h: [0.21, (top - bot) / 2, 0.21], surf: "wood", noDrive: true });
  const bents: number[] = [];
  for (let x = P.x0 + 3; x < P.head.x0; x += 3.2) { for (const sz of [-1, 1]) pile(x, P.z + sz * (hw - 0.25)); bents.push(x); }
  for (let z = P.head.z0 + 0.3; z <= P.head.z1; z += 3.4) for (const x of [P.head.x0 + 0.3, P.head.x1 - 0.3]) pile(x, z);
  // cap beams across each bent and along the head's two pile rows
  for (const x of bents) out.push({ c: [x, dy - 0.62, P.z], h: [0.18, 0.16, (2 * hw + 0.2) / 2], surf: "wood", noDrive: true });
  for (const x of [P.head.x0 + 0.3, P.head.x1 - 0.3]) out.push({ c: [x, dy - 0.62, (P.head.z0 + P.head.z1) / 2], h: [0.18, 0.16, (P.head.z1 - P.head.z0 + 0.4) / 2], surf: "wood", noDrive: true });
  // mooring posts (iron caps), the rope rail's posts along the walkway's +z edge, the two yellow bollards
  for (const [x, z] of [[P.head.x1 - 0.3, P.head.z0 + 0.3], [P.head.x1 - 0.3, P.head.z1 - 0.3], [P.x0 + 9.4, P.z - hw + 0.2], [P.x0 + 15.8, P.z + hw - 0.2]] as Array<[number, number]>)
    out.push({ c: [x, dy + 0.585, z], h: [0.22, 0.635, 0.22], surf: "wood" });
  for (let x = P.x0 + 1.6; x < P.head.x0; x += 3.2) out.push({ c: [x, dy + 0.5, P.z + hw - 0.15], h: [0.08, 0.5, 0.08], surf: "wood" });
  for (const z of [P.head.z0 + 3, P.head.z1 - 3]) out.push({ c: [P.head.x1 - 0.6, dy + 0.28, z], h: [0.22, 0.28, 0.22], surf: "metal" });
  // the moored work boat (pier.ts workBoat at head.x1 − 4, head.z0 − 2.4, long axis ≈ x): hull + wheelhouse
  { const bx = P.head.x1 - 4, bz = P.head.z0 - 2.4;
    out.push({ c: [bx, -0.18, bz], h: [2.9, 0.34, 1.05], surf: "metal", noDrive: true }, { c: [bx - 0.6, 0.9, bz + 0.06], h: [0.8, 0.65, 0.75], surf: "metal", noDrive: true }); }
  return out;
}

/** rocks (local): pier foot on the headland's sand spit + riprap along the diagonal quay + reef. r radius, moss 0..1,
 *  y = explicit base (else terrain) */
export const ROCKS: Array<{ x: number; z: number; r: number; moss: number; y?: number }> = [
  // pier foot / headland spit (mossy boulders + grey rocks at the waterline)
  { x: 893, z: 476, r: 2.6, moss: 1.0 }, { x: 899, z: 480, r: 2.0, moss: 0.9 }, { x: 887, z: 481, r: 3.0, moss: 1.0 }, { x: 905, z: 476, r: 1.5, moss: 0.4 },
  { x: 911, z: 480, r: 1.8, moss: 0.3 }, { x: 918, z: 474, r: 1.2, moss: 0.1 }, { x: 914, z: 486, r: 2.2, moss: 0.6 }, { x: 896, z: 489, r: 2.8, moss: 1.0 },
  { x: 922, z: 481, r: 1.4, moss: 0.1 }, { x: 926, z: 470, r: 1.0, moss: 0.0 }, { x: 881, z: 488, r: 2.4, moss: 1.0 }, { x: 906, z: 492, r: 2.0, moss: 0.8 },
  { x: 921, z: 463, r: 0.9, moss: 0.0 }, { x: 930, z: 478, r: 1.6, moss: 0.2 },
  // the pier root tied to the quay corner with mossy riprap (so the pier doesn't stand in open water) — boulders piled
  // against the wall on both sides of the pier's first bents, crowns breaking the surface
  { x: 898.5, z: 465.5, r: 2.4, moss: 1.0, y: -0.9 }, { x: 899.5, z: 469.5, r: 2.2, moss: 0.9, y: -1.1 }, { x: 902.5, z: 466.5, r: 1.7, moss: 0.7, y: -0.9 },
  { x: 898.5, z: 452.8, r: 2.3, moss: 0.9, y: -1.0 }, { x: 899.2, z: 448.5, r: 2.0, moss: 1.0, y: -1.2 }, { x: 902.6, z: 451.8, r: 1.5, moss: 0.6, y: -0.8 },
  { x: 897.6, z: 444.2, r: 1.8, moss: 0.8, y: -1.3 }, { x: 896.8, z: 473.5, r: 2.0, moss: 1.0, y: -1.0 },
  // riprap along the diagonal quay (world SE) — rock armour into the water
  ...[...Array(15)].map((_, i) => { const t = (i + 0.5) / 15, x = 890 + (805 - 890) * t, z = 262 + (170 - 262) * t; return { x: x + 4 + (i % 3), z: z - 3 - (i % 2) * 2, r: 1.6 + ((i * 7) % 5) * 0.3, moss: 0.3, y: -0.6 }; }),
];

export type RoofKind = "yellow" | "grey";
/**
 * Arched (barrel-vault) warehouses. Warehouse-local frame: +X = length (ridge direction), +Z = width. Long walls (±Z)
 * carry the big door openings; the gable ends (±X) carry a small door + the painted end wall. yaw rotates
 * warehouse-local → harbor-local (three.js convention).
 */
export interface WarehouseSpec { id: string; x: number; z: number; yaw: number; length: number; width: number; wallH: number; rise: number; roof: RoofKind; end: string; doors: number }
export const WAREHOUSES: WarehouseSpec[] = [
  // the near-left group along the headland edge (local z ≈ 470), right beside the pier corner:
  // yaw π/2 = ridge along local z, door walls face ±X (the +X wall looks at the yard, the pier and the camera)
  { id: "wy", x: 800, z: 442, yaw: Math.PI / 2, length: 42, width: 22, wallH: 5.2, rise: 6.4, roof: "yellow", end: "#2f67b5", doors: 3 },
  // yaw 0 = ridge along x: the red gable (+X end) faces the camera, then a row of grey
  // sheds behind it (arched roofs in a row at the back of the yard)
  { id: "wr", x: 760, z: 405, yaw: 0, length: 40, width: 22, wallH: 5.2, rise: 6.2, roof: "grey", end: "#b3382a", doors: 3 },
  { id: "wg", x: 712, z: 405, yaw: 0, length: 44, width: 22, wallH: 5.2, rise: 6.4, roof: "grey", end: "#2f5e9b", doors: 3 },
  // the CFS shed between the reefer row and the chassis park, and the old depot shed by the north quay
  { id: "wc", x: 730, z: 215, yaw: 0, length: 46, width: 22, wallH: 5.2, rise: 6.4, roof: "grey", end: "#e6e2d8", doors: 3 },
  { id: "wb", x: 650, z: 158, yaw: 0, length: 46, width: 22, wallH: 5.2, rise: 6.4, roof: "yellow", end: "#b3382a", doors: 3 },
  // the banana packing shed between the chassis park and the lay-down yard
  { id: "wd", x: 652, z: 334, yaw: 0, length: 44, width: 22, wallH: 5.2, rise: 6.4, roof: "grey", end: "#2f67b5", doors: 3 },
];
export const DOORS = { pitch: 12, hw: 2.7, h: 4.6 };
export const RACK = { rowsZ: [-7.2, 7.2], length: 26, depth: 1.3, height: 5.0, shelves: 3 };
export const END_DOOR = { hw: 2.6, h: 4.4 };

export interface TankSpec { x: number; z: number; r: number; h: number }
/** white fuel tanks behind the warehouses (back-left, three in a row) */
// (17 m tall, r 8 — the tanks stand well above the sheds in the left third of the view)
export const TANKS: TankSpec[] = [{ x: 767, z: 445, r: 8, h: 17 }, { x: 748.5, z: 446, r: 8, h: 17 }, { x: 730, z: 447, r: 8, h: 17 }];
export const TANK_BUND = { x0: 720, x1: 777, z0: 435, z1: 458, h: 0.9 };
export const PUMP_HOUSE = { x: 781, z: 427, w: 7, d: 6, h: 4 };
/** pipe rack: tank manifold → pump house → the fuel point on the quay strip (local x,z polyline, height y) */
export const PIPE_RACK = { y: 4.6, pts: [[775, 440], [781, 440], [781, 431]] as Array<[number, number]> };

export type PropKind = "forklift" | "pallet" | "pallet-stack" | "crate" | "crate-stack" | "bollard" | "lamp" | "generator" | "tyres" | "barrel" | "spool" | "reefer-rack" | "truck" | "cone" | "drum-pallet"
  | "chassis" | "hatch-cover" | "lashing-cage" | "pipe-stack" | "timber-stack" | "barrier" | "light-tower" | "scale-house" | "booth" | "tyre-wall" | "bin" | "winch";
export type PalletLoad = "bananas" | "crates" | "boxes" | "empty" | "slatted";
export interface PropSpec { kind: PropKind; x: number; z: number; yaw: number; s?: number; y?: number; /** pallet load override (default: by hash) */ load?: PalletLoad }
/** collision footprint of every prop kind (local: hx along the prop's +X, hz across, hy = half height; bottom at ground) */
export const PROP_FOOT: Record<PropKind, { hx: number; hy: number; hz: number; surf: Box["surf"]; noShoot?: boolean }> = {
  forklift: { hx: 1.75, hy: 1.12, hz: 0.72, surf: "metal" },
  pallet: { hx: 0.6, hy: 0.5, hz: 0.5, surf: "wood" },
  "pallet-stack": { hx: 0.6, hy: 0.95, hz: 0.5, surf: "wood" },
  crate: { hx: 0.55, hy: 0.5, hz: 0.55, surf: "wood" },
  "crate-stack": { hx: 0.6, hy: 1.0, hz: 0.6, surf: "wood" },
  bollard: { hx: 0.32, hy: 0.42, hz: 0.32, surf: "metal" },
  lamp: { hx: 0.2, hy: 5.5, hz: 0.2, surf: "metal" },
  generator: { hx: 1.3, hy: 0.85, hz: 0.65, surf: "metal" },
  tyres: { hx: 0.9, hy: 0.55, hz: 0.9, surf: "metal" },
  barrel: { hx: 0.3, hy: 0.45, hz: 0.3, surf: "metal" },
  spool: { hx: 0.8, hy: 0.8, hz: 0.55, surf: "wood" },
  "reefer-rack": { hx: 3, hy: 1.4, hz: 0.5, surf: "metal" },
  truck: { hx: 3.3, hy: 1.5, hz: 1.2, surf: "metal" },
  cone: { hx: 0.2, hy: 0.38, hz: 0.2, surf: "fabric", noShoot: true },
  "drum-pallet": { hx: 0.6, hy: 0.5, hz: 0.6, surf: "metal" },
  // terminal chassis (skeletal trailer, deck at 1.35 m) — a container may ride on it (CONTAINERS, y = deck)
  chassis: { hx: 6.3, hy: 0.68, hz: 1.25, surf: "metal" },
  // a stack of two steel ship hatch covers (big, low, climbable cover)
  "hatch-cover": { hx: 6.0, hy: 0.8, hz: 2.4, surf: "metal" },
  "lashing-cage": { hx: 1.2, hy: 0.9, hz: 0.9, surf: "metal" },
  "pipe-stack": { hx: 3.0, hy: 0.7, hz: 1.2, surf: "metal" },
  "timber-stack": { hx: 2.4, hy: 0.6, hz: 1.0, surf: "wood" },
  // concrete jersey barrier
  barrier: { hx: 1.5, hy: 0.45, hz: 0.3, surf: "concrete" },
  "light-tower": { hx: 0.6, hy: 12, hz: 0.6, surf: "metal" },
  "scale-house": { hx: 3.2, hy: 1.6, hz: 2.2, surf: "concrete" },
  booth: { hx: 1.1, hy: 1.3, hz: 1.1, surf: "metal" },
  "tyre-wall": { hx: 1.9, hy: 0.55, hz: 0.7, surf: "metal" },
  bin: { hx: 0.9, hy: 0.7, hz: 0.6, surf: "metal" },
  // mooring winch on the berth strip (drum + side frames + motor/gearbox): 1.3 m hard cover
  winch: { hx: 1.0, hy: 0.65, hz: 0.62, surf: "metal" },
};
/** the open-frame props collide with their MEMBERS, not their bounding box — what you see
 *  through stops nothing, what you see stops bullets. Prop-local boxes [cx, cy, cz, hx, hy, hz, flags] (x along the
 *  prop's +X, y from its ground; flags 1 = noShoot: players collide, bullets pass — the mesh cage band; 2 = noWalk). Mirrors the
 *  drawn models in client/src/world/pois/peel-harbor/props.ts (forkliftInto, tractorInto, chassisInto, lashingCageInto,
 *  lightTowerInto) — change both together. A kind without an entry collides with its PROP_FOOT box. */
type MB = [number, number, number, number, number, number, number?, number?];
/** an upright round member (drum, pole, tyre stack) as a regular OCTAGON whose corners lie on the drawn circle (radius r):
 *  the union of four slabs a × a·tan 22.5° (two crosses 45° apart, inradius a = r·cos 22.5°) — within 8 % of r of the
 *  curve all round (one square's corners stood 0.12 m proud of a drum) */
const OCT_T = dmath.tan(Math.PI / 8);
const oct = (cx: number, cy: number, cz: number, r: number, hy: number, fl = 0): MB[] => {
  const a = r * dmath.cos(Math.PI / 8), t = a * OCT_T;
  return [[cx, cy, cz, a, hy, t, fl, 0], [cx, cy, cz, t, hy, a, fl, 0], [cx, cy, cz, a, hy, t, fl, Math.PI / 4], [cx, cy, cz, t, hy, a, fl, Math.PI / 4]];
};
/** a pallet prop's loads (the client's protoKey reads the same): [lower, upper] for a stack, [load] for one pallet */
export function palletLoads(p: PropSpec): PalletLoad[] {
  const h = hash01(p.x, p.z);
  if (p.kind === "pallet") return [p.load ?? (h < 0.12 ? "slatted" : h < 0.6 ? "boxes" : "crates")];
  return [p.load === "slatted" ? "boxes" : p.load ?? (h < 0.5 ? "boxes" : "crates"), p.load ?? (h < 0.3 ? "slatted" : "boxes")];
}
/** drawn height of a pallet load above the pallet deck (0.136): banana-box rows, one crate, an open slatted crate */
const LOAD_H: Record<PalletLoad, number> = { boxes: 0.61, bananas: 0.915, crates: 0.95, slatted: 0.55, empty: 0 };
/** a prop's member boxes (PROP_MEMBERS, or derived from its drawn loads) */
function propMembers(p: PropSpec): MB[] | undefined {
  if (p.kind === "pallet" || p.kind === "pallet-stack") {
    const out: MB[] = []; let y = 0;
    for (const ld of palletLoads(p)) {
      // a loaded pallet is ONE box from the deck's foot to the load's top, the load's
      // footprint — with the deck's 0.136 m rim as a step, brushing a pallet the solver lifts the player onto it, the load
      // pushes them off, and they drop back — every other tick (a 14 cm camera buzz)
      const h = LOAD_H[ld];
      if (h > 0) out.push([0, y + (0.136 + h) / 2, 0, ld === "crates" ? 0.55 : 0.58, (0.136 + h) / 2, 0.47]);
      else out.push([0, y + 0.068, 0, 0.6, 0.068, 0.5]);
      y += 0.136 + h;
    }
    return out;
  }
  if (p.kind === "chassis") {
    // a LOADED chassis: the box overhangs the frame by 0.6 m a side over a 1.36 m gap — a crouch-only strip nobody can
    // reach (scanner: unreachable) → a no-shoot fill under the box, its width + length
    const c = dmath.cos(p.yaw), sn = dmath.sin(p.yaw);
    const q = CONTAINERS.find((k) => k.y > APRON_Y + 1 && k.y < APRON_Y + 2 && dmath.hypot(k.x - p.x, k.z - p.z) < 6.5 && Math.abs(-(k.x - p.x) * sn - (k.z - p.z) * c) < 0.5);
    if (q) {
      const u = (q.x - p.x) * c - (q.z - p.z) * sn, L2 = (q.size ?? 40) === 40 ? 6.08 : 3.02;
      return [...PROP_MEMBERS.chassis!, [u, 0.525, 0, L2, 0.525, 1.22, 1]];
    }
  }
  return PROP_MEMBERS[p.kind];
}
const both = (b: MB): MB[] => [b, [b[0], b[1], -b[2], b[3], b[4], b[5], b[6]]];
export const PROP_MEMBERS: Partial<Record<PropKind, MB[]>> = {
  forklift: [
    [-1.18, 0.645, 0, 0.29, 0.645, 0.6],            // counterweight
    [-1.22, 1.52, 0, 0.15, 0.15, 0.42],             // LPG bottle
    [-0.15, 0.49, 0, 0.9, 0.37, 0.57],              // chassis
    [-0.5, 0.985, 0, 0.46, 0.125, 0.51],            // engine hood
    [-0.56, 1.17, 0, 0.24, 0.06, 0.24],             // seat
    [-0.84, 1.45, 0, 0.08, 0.25, 0.24],             // backrest
    [0.12, 1.05, 0, 0.08, 0.15, 0.4],               // dash + steering column
    ...both([0.45, 0.42, 0.62, 0.42, 0.42, 0.15]),  // drive tyres + mudguard arcs
    ...both([0.305, 1.185, 0.52, 0.05, 0.325, 0.04]), ...both([0.235, 1.835, 0.52, 0.05, 0.325, 0.04]), // raked front guard pillars (2 steps)
    ...both([-0.96, 1.58, 0.52, 0.05, 0.58, 0.04]), // rear guard pillars
    [-0.37, 2.185, 0, 0.69, 0.045, 0.56],           // overhead guard
    ...both([0.82, 1.23, 0.33, 0.07, 1.14, 0.06]),  // mast channels
    [0.82, 0.18, 0, 0.06, 0.045, 0.4], [0.82, 1.25, 0, 0.06, 0.045, 0.4], [0.82, 2.33, 0, 0.06, 0.045, 0.4], // mast ties
    [0.74, 1.19, 0, 0.06, 1.01, 0.06],              // lift cylinder
    [0.96, 0.62, 0, 0.03, 0.18, 0.48],              // carriage
    [0.96, 1.4, 0, 0.025, 0.03, 0.47],              // load backrest top bar
    ...both([1.56, 0.07, 0.28, 0.57, 0.04, 0.06]),  // forks
  ],
  truck: [
    [0, 0.73, 0, 3.19, 0.18, 0.55],                 // frame rails
    [3.08, 0.72, 0, 0.11, 0.17, 1.05],              // front bumper
    ...both([2.25, 0.54, 0.9, 0.54, 0.54, 0.17]),   // steer tyres
    ...both([-1.45, 0.58, 0.93, 0.66, 0.58, 0.32]), // dual drive tyres + mudguards
    [2.35, 1.42, 0.12, 0.65, 0.475, 0.73],          // hood
    [1.35, 2.01, -0.28, 0.86, 0.94, 0.83],          // glazed cab + roof
    [1.25, 0.78, -0.92, 0.7, 0.3, 0.3],             // fuel tank
    [0.3, 0.8, 0.82, 0.35, 0.23, 0.23],             // battery box
    [0.52, 2.2, 0.72, 0.08, 1.1, 0.08],             // exhaust stack
    [-1.45, 1.1, 0, 0.65, 0.16, 0.62],              // fifth wheel
  ],
  chassis: [
    [0, 1.21, 0, 6.15, 0.16, 0.63],                 // rails + cross members + the centre walkway plate
    [0, 0.525, 0, 6.15, 0.525, 0.5, 1],             // (no-shoot) the 1.05 m crawl space under the frame: no floor nobody reaches
    [6.05, 1.24, 0, 0.12, 0.15, 1.22], [-6.05, 1.24, 0, 0.12, 0.15, 1.22], // end beams
    ...both([-4.5, 0.54, 0.86, 1.35, 0.54, 0.33]),  // tandem axle tyres + mudguards
    ...both([3.6, 0.62, 0.55, 0.18, 0.6, 0.15]),    // landing legs
    [-6.25, 0.55, 0, 0.06, 0.07, 1.1],              // ICC bumper
  ],
  // (the drawn crates are 1.1 m (the top one 0.95 × and turned 0.12 rad); the loads sit inside the pallet)
  "crate-stack": [[0, 0.5, 0, 0.56, 0.5, 0.56], [0.04, 1.475, -0.03, 0.525, 0.475, 0.525, 0, 0.12]],   // (the top crate is turned 0.12 rad)
  barrel: oct(0, 0.45, 0, 0.3, 0.45),
  bollard: [...oct(0, 0.325, 0, 0.28, 0.325), ...oct(0, 0.85, 0, 0.42, 0.2)],   // (props.ts bollard(): neck r 0.28, head r 0.42 to 1.05 m)
  // 4 tyres (torus R 0.62 + tube 0.26) to 1.33 m; the top one carries a steel rim (props.ts) — no hole to fall into
  tyres: oct(0, 0.665, 0, 0.88, 0.665),
  // a cable drum lying on its rim (axis along z, flanges r 0.8 at ±0.58): three stepped boxes inside the circle
  spool: [...[-0.54, 0.54].flatMap((fz): MB[] => [[0, 0.8, fz, 0.4, 0.8, 0.04], [0, 0.865, fz, 0.65, 0.535, 0.04], [0, 0.8, fz, 0.74, 0.3, 0.04]]),
    [0, 0.8, 0, 0.3, 0.55, 0.5], [0, 0.8, 0, 0.5, 0.35, 0.5]],                     // (the cable barrel between: r 0.55)
  // (the drums reach the floor and the deck collider sits inside their outline: the deck's rim outside the drums
  // would be a 0.136 m step that jitters the player)
  "drum-pallet": [[0, 0.068, 0, 0.45, 0.068, 0.35], ...oct(-0.3, 0.478, -0.25, 0.27, 0.478), ...oct(0.3, 0.478, -0.25, 0.27, 0.478), ...oct(-0.3, 0.478, 0.25, 0.27, 0.478), ...oct(0.3, 0.478, 0.25, 0.27, 0.478)],
  "timber-stack": [[0, 0.52, 0, 2.3, 0.52, 0.97], [0.1, 1.34, 0, 2.3, 0.3, 0.97]],   // (7 boards × 0.28 = ±0.98)
  "pipe-stack": [[0, 0.06, 0, 2.3, 0.06, 1.15], [0, 0.36, 0, 2.9, 0.24, 0.73], [0, 0.81, 0, 2.9, 0.21, 0.49], [0, 1.22, 0, 2.9, 0.21, 0.25]],
  "hatch-cover": [[0, 0.4, 0, 6.0, 0.4, 2.4], [0, 1.2, 0, 5.75, 0.4, 2.25]],
  "lashing-cage": [
    [0, 0.6, 0, 1.2, 0.6, 0.9],                     // fork-pocket skid + solid sheet sides (1.2 m)
    [0, 1.5, 0, 1.2, 0.3, 0.9, 1],                  // mesh band + mesh lid (see-through: players only)
  ],
  "light-tower": [
    [0, 0.25, 0, 0.7, 0.25, 0.7],                   // footing
    [0, 0.75, 0, 0.35, 0.25, 0.35],                 // base collar
    // tapered round pole (r 0.32 at 0.5 m → 0.16 at 23.5 m) as octagons per 2.5 m
    ...[1, 3.5, 6, 8.5, 11, 13.5, 16, 18.5, 21].flatMap((y0) => { const y1 = Math.min(23.4, y0 + 2.5); return oct(0, (y0 + y1) / 2, 0, 0.32 - 0.16 * ((y0 + y1) / 2 - 0.5) / 23, (y1 - y0) / 2); }),
    [0.37, 11.6, 0, 0.05, 10.4, 0.22],              // access ladder
    [0, 23.5, 0, 1.3, 0.07, 1.3, 2],                // head frame (2 = noWalk: bullets only — nobody climbs up there)
  ],
};

// ---------------------------------------------------------------- the yard
/** point-in-polygon for the apron (local) */
export function onApron(x: number, z: number, margin = 0): boolean {
  let inside = false;
  for (let i = 0, j = APRON.length - 1; i < APRON.length; j = i++) {
    const [xi, zi] = APRON[i], [xj, zj] = APRON[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  if (!inside || margin <= 0) return inside;
  for (let i = 0, j = APRON.length - 1; i < APRON.length; j = i++) {
    const [ax, az] = APRON[j], [bx, bz] = APRON[i];
    const dx = bx - ax, dz = bz - az, t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
    if (dmath.hypot(x - (ax + dx * t), z - (az + dz * t)) < margin) return false;
  }
  return true;
}

/** every corner (and edge midpoint) of a local rect centred (x, z) with half sizes hx, hz lies on the slab `m` m in */
export function footOnApron(x: number, z: number, hx: number, hz: number, m = 0.5): boolean {
  for (const [u, v] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, -1], [0, 1], [-1, 0], [1, 0]]) if (!onApron(x + u * hx, z + v * hz, m)) return false;
  return true;
}

/** local-frame footprint of a warehouse incl. its forecourt (for keep-outs) */
function whRect(w: WarehouseSpec, padL: number, padW: number): [number, number, number, number] {
  const alongX = Math.abs(dmath.cos(w.yaw)) > 0.5;
  const hl = w.length / 2 + padL, hw = w.width / 2 + padW;
  return alongX ? [w.x - hl, w.x + hl, w.z - hw, w.z + hw] : [w.x - hw, w.x + hw, w.z - hl, w.z + hl];
}

const YARD_SEED = 7331;
export const CONTAINERS: ContainerPlacement[] = [];
export const PROPS: PropSpec[] = [];
export const H1 = 2.591;
/** container row pitch across the long axis (2.44 + 0.31 gap) and bay pitch along it */
export const ROW = 2.75, BAY = 12.72;

/**
 * A stack block. `dir` = the boxes' long axis ("z": yaw π/2 like the berth yard, "x": yaw 0 — the rotated blocks).
 * (x0, z0) = the first row's centre line / the block's start along its bays; `rows` side by side across the long axis
 * (ROW pitch, toward +x for "z" blocks, +z for "x" blocks), `bays` along it (BAY pitch). `profile` = tiers per bay:
 * every block's skyline steps (1-2-3-4) so it reads as a stacked terminal and kongs can climb it from the low end.
 * `mix20` = share of bays holding two 20 ft boxes; `kind` picks the colour palette.
 */
export interface Block { id: string; x0: number; z0: number; dir: "x" | "z"; rows: number; bays: number; profile: number[]; mix20?: number; fill?: number; kind?: "yard" | "reefer" | "empties"; /** generated by the auto fill (slots also avoid FILL_RESERVED + jungle) */ auto?: boolean }
export const BLOCKS: Block[] = [
  // ---- the compact main yard around the cranes (dense 2–4 high stacks, tight lanes, staggered ends)
  { id: "A1", x0: 846.2, z0: 404, dir: "z", rows: 4, bays: 4, profile: [2, 3, 4, 3], mix20: 0.1 },
  { id: "A2", x0: 846.2, z0: 318, dir: "z", rows: 4, bays: 6, profile: [1, 2, 3, 4, 3, 2], mix20: 0.12 },
  // (A3's last bay is 1 high: it stands under crane 1's backreach — a covered 2nd tier no walk reaches)
  { id: "A3", x0: 846.2, z0: 240, dir: "z", rows: 3, bays: 5, profile: [3, 3, 2, 1, 1] },
  { id: "B1", x0: 829.0, z0: 392, dir: "z", rows: 4, bays: 5, profile: [1, 2, 3, 3, 2], mix20: 0.15 },
  { id: "B2", x0: 829.0, z0: 290, dir: "z", rows: 4, bays: 7, profile: [3, 4, 4, 3, 2, 3, 2], mix20: 0.1 },
  { id: "B3", x0: 829.0, z0: 222, dir: "z", rows: 4, bays: 4, profile: [2, 1, 2, 3], mix20: 0.2 },
  { id: "C1", x0: 811.8, z0: 360, dir: "z", rows: 4, bays: 4, profile: [2, 3, 2, 1], mix20: 0.12 },
  { id: "C2", x0: 811.8, z0: 268, dir: "z", rows: 4, bays: 6, profile: [1, 2, 3, 4, 3, 2], mix20: 0.1 },
  { id: "D1", x0: 794.6, z0: 330, dir: "z", rows: 4, bays: 5, profile: [3, 2, 2, 3, 1], mix20: 0.15 },
  { id: "D2", x0: 794.6, z0: 240, dir: "z", rows: 4, bays: 6, profile: [2, 3, 4, 4, 3, 1], mix20: 0.1 },
  // rotated blocks (boxes along x): across the south end + a short one between the yard and the reefer row
  { id: "R1", x0: 783, z0: 204.5, dir: "x", rows: 3, bays: 4, profile: [1, 2, 3, 2], mix20: 0.2 },
  { id: "R2", x0: 812, z0: 351.5, dir: "x", rows: 2, bays: 2, profile: [2, 1] },
  // ---- the reefer row (white refrigerated boxes, 2 high, under a steel reefer-rack gantry with walkways)
  { id: "E1", x0: 777.8, z0: 250, dir: "z", rows: 3, bays: 7, profile: [2, 2, 2, 2, 2, 2, 2], kind: "reefer", fill: 0.92 },
  // ---- retired boxes stacked in the fenced lay-down yard (weathered, the jungle creeping round them)
  { id: "L1", x0: 650, z0: 386, dir: "x", rows: 3, bays: 3, profile: [2, 3, 2], mix20: 0.3, kind: "empties", fill: 0.9 },
  { id: "L2", x0: 650, z0: 436, dir: "x", rows: 2, bays: 3, profile: [1, 2, 3], mix20: 0.3, kind: "empties", fill: 0.9 },
  // a third stack of retired boxes in the lay-down (so it doesn't read as a bare fenced patch from the plane)
  { id: "L3", x0: 668, z0: 410, dir: "x", rows: 3, bays: 2, profile: [2, 1], mix20: 0.3, kind: "empties", fill: 0.9 },
];
/** a block's footprint rect [x0, x1, z0, z1] (local, box edges) */
export function blockRect(b: Block): [number, number, number, number] {
  const across = (b.rows - 1) * ROW, along = b.bays * BAY;
  return b.dir === "z" ? [b.x0 - 1.22, b.x0 + across + 1.22, b.z0, b.z0 + along] : [b.x0, b.x0 + along, b.z0 - 1.22, b.z0 + across + 1.22];
}

/**
 * DENSE TERMINAL: so the western two-thirds of the slab don't read as a bare car park from the plane, these
 * regions are tiled with stack blocks of boxes along x (90° to the berth yard), 3–5 rows, 3–5 bays, 5.5–7 m lanes,
 * skylines stepping 1-2-3 (the odd 4 by the sheds) so every block is climbable from its low end. Slots that fall off the
 * slab, into a keep-out (sheds, tanks, quay strip), a reserved rect (chassis park, gate road, lay-down aisles) or a
 * jungle patch are simply skipped, so block ends come out ragged, like a working yard.
 */
const FILLS: Array<{ id: string; x0: number; x1: number; z0: number; z1: number; rows: number; bays: number; laneX: number; laneZ: number; kind?: Block["kind"]; hi?: number; mix20?: number; fill?: number; dir?: "x" | "z" }> = [
  // north quay depot: empties 1–3 high, 20 ft heavy
  { id: "N", x0: 648, x1: 774, z0: 48, z1: 142, rows: 4, bays: 3, laneX: 6.5, laneZ: 6, kind: "empties", hi: 3, mix20: 0.35, fill: 0.9 },
  // between the depot and the CFS shed + the diagonal SE corner
  { id: "M", x0: 684, x1: 800, z0: 150, z1: 196, rows: 4, bays: 3, laneX: 6, laneZ: 6, hi: 3, mix20: 0.2 },
  { id: "S", x0: 772, x1: 850, z0: 150, z1: 238, rows: 3, bays: 3, laneX: 6, laneZ: 6, hi: 3, mix20: 0.15, dir: "z" },
  // between the CFS shed / chassis park and the reefer row
  { id: "F", x0: 702, x1: 770, z0: 238, z1: 350, rows: 4, bays: 5, laneX: 6, laneZ: 6.5, hi: 4, mix20: 0.15 },
  // in front of the near sheds (their south door walls face this band)
  { id: "G", x0: 682, x1: 790, z0: 352, z1: 382, rows: 4, bays: 3, laneX: 7, laneZ: 6, hi: 3, mix20: 0.2 },
  // the west strip between the chassis park and the jungle + the packing shed's back yard
  { id: "W", x0: 590, x1: 700, z0: 300, z1: 366, rows: 3, bays: 3, laneX: 6, laneZ: 6, hi: 3, mix20: 0.25 },
  // the north half of the chassis park area is a
  // stacked block field (2 × 4 blocks of 2 bays, 90° to the berth yard), the park keeps its southern rows
  { id: "P", x0: 628, x1: 700, z0: 182, z1: 246, rows: 4, bays: 2, laneX: 6, laneZ: 5.5, hi: 3, mix20: 0.2 },
  // the north-quay corner (otherwise an empty 60 m plaza): a column of short blocks
  { id: "Q", x0: 740, x1: 768, z0: 52, z1: 140, rows: 3, bays: 2, laneX: 6, laneZ: 7, hi: 3, mix20: 0.3 },
];
/** rects the auto blocks keep out of (local [x0,x1,z0,z1]): chassis park, the gate road, the lay-down yard */
export const FILL_RESERVED: Array<[number, number, number, number]> = [
  [626 - 3, 700 + 3, 250 - 4, 304 + 3],   // chassis park (CHASSIS_PARK + an apron lane round it)
  [526, 640, 250, 276],                   // the gate road in from the island
  [624, 700, 364, 464],                   // the lay-down yard (its own L blocks)
];
{
  const rr = mulberry32(4401);
  const pro = (bays: number, hi: number): number[] => {
    // a stepped skyline: rises from a low end (1 or 2) to a 3-high (sometimes `hi`) crown and falls back — reads as a
    // packed 2–3-high terminal from the plane, climbable from the low end at kong eye (never a sheer 4-wall)
    const peak = Math.min(hi, rr() < 0.25 ? hi : 3), low = rr() < 0.55 ? 1 : 2, out: number[] = [];
    const up = Math.min(bays - 1, 1 + Math.floor(rr() * (bays - 1)));
    for (let i = 0; i < bays; i++) out.push(i < up ? Math.min(peak, low + i) : i === up ? peak : Math.max(2, peak - (rr() < 0.5 ? 1 : 0)));
    if (rr() < 0.5) out.reverse();
    return out;
  };
  for (const f of FILLS) {
    const dir = f.dir ?? "x";
    const along = f.bays * BAY, across = (f.rows - 1) * ROW + 2.44;
    const [sa, sc] = dir === "x" ? [along + f.laneX, across + f.laneZ] : [across + f.laneX, along + f.laneZ];
    let n = 0;
    for (let z = f.z0; z + (dir === "x" ? across : along) <= f.z1 + 0.01; z += sc) for (let x = f.x0; x + (dir === "x" ? along : across) <= f.x1 + 0.01; x += sa) {
      const b: Block = dir === "x"
        ? { id: `${f.id}${++n}`, x0: x, z0: z + 1.22, dir: "x", rows: f.rows, bays: f.bays, profile: pro(f.bays, f.hi ?? 3), mix20: f.mix20, fill: f.fill, kind: f.kind, auto: true }
        : { id: `${f.id}${++n}`, x0: x + 1.22, z0: z, dir: "z", rows: f.rows, bays: f.bays, profile: pro(f.bays, f.hi ?? 3), mix20: f.mix20, fill: f.fill, kind: f.kind, auto: true };
      BLOCKS.push(b);
    }
  }
}
/** an auto block's slot must stay clear of the reserved rects and the jungle patches */
function reservedAt(x: number, z: number, hx: number, hz: number): boolean {
  return FILL_RESERVED.some(([x0, x1, z0, z1]) => x + hx > x0 && x - hx < x1 && z + hz > z0 && z - hz < z1) || jungleAt(x, z) > 0.05 || jungleAt(x + hx, z + hz) > 0.05 || jungleAt(x - hx, z - hz) > 0.05;
}

/** the yard's lanes derived from BLOCKS: long lanes between block columns + the cross gaps inside a column
 *  (local segments: x0,z0 → x1,z1 along the lane centre, w = lane width) — apron markings, grime, drains use them */
export function yardLanes(): Array<{ x0: number; z0: number; x1: number; z1: number; w: number; cross: boolean }> {
  const out: Array<{ x0: number; z0: number; x1: number; z1: number; w: number; cross: boolean }> = [];
  const cols = new Map<number, Block[]>();
  for (const b of BLOCKS) if (b.dir === "z" && (b.kind ?? "yard") !== "empties") { const k = Math.round(b.x0); (cols.get(k) ?? cols.set(k, []).get(k)!).push(b); }
  const keys = [...cols.keys()].sort((a, b) => a - b);
  for (let i = 0; i < keys.length; i++) {
    const col = cols.get(keys[i])!.sort((a, b) => a.z0 - b.z0), r0 = blockRect(col[0]);
    for (let k = 0; k < col.length - 1; k++) {
      const a = blockRect(col[k]), b = blockRect(col[k + 1]);
      if (b[2] - a[3] > 3) out.push({ x0: a[0] - 3, z0: (a[3] + b[2]) / 2, x1: a[1] + 3, z1: (a[3] + b[2]) / 2, w: b[2] - a[3], cross: true });
    }
    if (i < keys.length - 1) {
      const next = cols.get(keys[i + 1])!, rn = blockRect(next[0]), x = (r0[1] + rn[0]) / 2;
      const zs = [...col, ...next].map(blockRect), z0 = Math.min(...zs.map((q) => q[2])) - 4, z1 = Math.max(...zs.map((q) => q[3])) + 4;
      out.push({ x0: x, z0, x1: x, z1, w: rn[0] - r0[1], cross: false });
    }
  }
  return out;
}

/** the truck/chassis park (west): rows of skeletal chassis, some loaded, tractors hooked up to a few */
export const CHASSIS_PARK = { x0: 626, x1: 700, z0: 250, z1: 304, rowPitch: 5.0, slot: 14.5 };
/** the fenced lay-down yard (north-west): pipe stacks, timber, cable drums, retired boxes; the jungle is taking it */
export const LAYDOWN = { x0: 626, x1: 698, z0: 366, z1: 462, gateZ: 414 };
/** the land gate: scale house + booths + barriers where the island road comes in (west edge) */
export const GATE = { x: 544, z: 262, halfW: 11 };
/** overgrown corners of the slab: soil + grass cover, bushes, banana plants, palms and jungle trees (VegApi) */
export interface JunglePatch { x: number; z: number; rx: number; rz: number; rot: number; trees: number }
export const JUNGLE_PATCHES: JunglePatch[] = [
  // the land side of the slab is being taken back by the jungle (it hugs the terminal) — the gate road
  // (local z ≈ 250–275) stays open
  // (the whole land-side third of the slab: the terminal itself stays compact around the cranes)
  { x: 566, z: 420, rx: 58, rz: 62, rot: 0.3, trees: 24 },
  { x: 570, z: 318, rx: 46, rz: 38, rot: 0.1, trees: 12 },
  { x: 572, z: 192, rx: 46, rz: 50, rot: 0.05, trees: 13 },
  { x: 600, z: 84, rx: 46, rz: 48, rot: -0.1, trees: 14 },
  { x: 652, z: 128, rx: 14, rz: 10, rot: 0.2, trees: 3 },
  // the land side of the north quay
  { x: 548, z: 128, rx: 24, rz: 30, rot: 0.2, trees: 8 },
  { x: 700, z: 452, rx: 16, rz: 13, rot: -0.3, trees: 3 },
  { x: 760, z: 160, rx: 14, rz: 12, rot: 0.4, trees: 2 },
];
/** inside a jungle patch (soft ellipse) → 0..1 */
export function jungleAt(x: number, z: number): number {
  let best = 0;
  for (const p of JUNGLE_PATCHES) {
    const c = dmath.cos(p.rot), s = dmath.sin(p.rot), dx = x - p.x, dz = z - p.z;
    const u = (dx * c + dz * s) / p.rx, v = (-dx * s + dz * c) / p.rz, d = dmath.hypot(u, v);
    best = Math.max(best, Math.min(1, Math.max(0, (1 - d) * 3)));
  }
  return best;
}
/** trees planted in the jungle patches (shared: the client plants them, the server gets their trunks) */
/** the slab trees' trunk radius at kong height (veg's palm / jungle-tree; yard.ts draws the same in tool pages) */
export const TRUNK_R = { palm: 0.26, tree: 0.42 };
export const JUNGLE_TREES: Array<{ x: number; z: number; kind: "palm" | "jungle-tree"; s: number; yaw: number }> = [];
/** steel access-stair towers at block ends (terminal lashing-crew stairs): reach the 2nd / 3rd tier tops */
export interface StairTower { x: number; z: number; dir: 1 | -1; axis: "x" | "z"; top: number }
export const STAIR_TOWERS: StairTower[] = [];
/** the reefer rack: a steel gantry along the reefer row with plug walkways at tier 1 and tier 2 (+ stairs) */
export const REEFER_RACK = { x: 773.8, z0: 250, z1: 339, y1: APRON_Y + 2.62, y2: APRON_Y + 5.21, w: 1.4 };
/** yard fence runs (local polylines): chain-link on posts; `gap` = gate openings [from, to] along the run (m) */
export const FENCES: Array<{ pts: Array<[number, number]>; gaps?: Array<[number, number]> }> = [];

/** rectangles no container / prop may overlap */
function keepOuts(): Array<[number, number, number, number]> {
  return [
    ...WAREHOUSES.map((w) => whRect(w, 5, 9)),
    [TANK_BUND.x0 - 6, TANK_BUND.x1 + 6, TANK_BUND.z0 - 6, TANK_BUND.z1 + 6],
    [PUMP_HOUSE.x - 8, PUMP_HOUSE.x + 8, PUMP_HOUSE.z - 7, PUMP_HOUSE.z + 7],
    [859, 906, 240, 480],   // quay strip: crane rails + transfer lane
    [858, 906, 436, 480],   // the near corner: pier approach, pallet field, hero stacks (placed by hand)
  ];
}
function blocked(x: number, z: number, hx: number, hz: number): boolean {
  return keepOuts().some(([x0, x1, z0, z1]) => x + hx > x0 && x - hx < x1 && z + hz > z0 && z - hz < z1);
}

{
  const r = mulberry32(YARD_SEED);
  // the yard's palette: ripe yellow dominates, then leafy green and brick red; blue + teal are rare accents
  const pal: Record<string, Array<[ContainerColor, number]>> = {
    yard: [["yellow", 0.56], ["green", 0.22], ["red", 0.14], ["blue", 0.045], ["teal", 0.035]],
    reefer: [["white", 0.9], ["yellow", 0.1]],
    empties: [["red", 0.3], ["teal", 0.2], ["blue", 0.2], ["green", 0.2], ["yellow", 0.1]],
  };
  const pick = (kind: string): ContainerColor => { let u = r(); for (const [c, w] of pal[kind]) { if (u < w) return c; u -= w; } return pal[kind][0][0]; };
  const decalFor = (c: ContainerColor, kind: string): ContainerPlacement["decal"] => {
    const dv = r();
    // ~30 % of boxes plain (or a leased box with no print); greens mostly carry the big banana, reds split
    if (kind === "empties") return dv < 0.45 ? "none" : c === "yellow" ? "text" : dv < 0.75 ? "logo" : "text";
    if (c === "white") return dv < 0.7 ? "text" : "none";
    if (c === "yellow") return dv < 0.14 ? "none" : dv < 0.3 ? "text" : undefined;
    if (c === "green") return dv < 0.68 ? "logo" : "none";
    if (c === "red") return dv < 0.38 ? "logo" : dv < 0.58 ? "text" : "none";
    return dv < 0.6 ? "text" : "none";
  };
  const box = (x: number, y: number, z: number, yaw: number, c: ContainerColor, kind: string, size: 20 | 40 = 40) =>
    CONTAINERS.push({ x, y, z, yaw, size, color: c, decal: decalFor(c, kind), tint: kind === "empties" ? 0.8 + r() * 0.12 : undefined });
  // no "container pens" or "stack-top pits": every block is PLANNED as a bays × rows grid first (the same r() draws
  // as an unplanned fill, so the skyline keeps its look), then fixed so no slot is a well: a slot enclosed on all four sides (an
  // interior row AND an interior bay) may never stand lower than its lowest neighbour (a 2.59 m tier step is above the
  // 2.1 m mantle), a randomly skipped interior slot is filled, and a lone 20 ft box never leaves a half-slot hole in an
  // interior row. The fix-up draws from its own RNG. Edge rows / end bays stay free to step down: they open onto a lane.
  const r2 = mulberry32(YARD_SEED + 4242);
  interface Slot { x: number; z: number; yaw: number; tiers: number; pair: boolean; lone: boolean; skipped: boolean; cols: ContainerColor[]; flips: boolean[]; flip20: boolean }
  for (const b of BLOCKS) {
    const kind = b.kind ?? "yard";
    const grid: Array<Array<Slot | null>> = [];
    for (let bay = 0; bay < b.bays; bay++) {
      const base = b.profile[bay] ?? 1, line: Array<Slot | null> = [];
      grid.push(line);
      for (let row = 0; row < b.rows; row++) {
        const [x, z] = b.dir === "z" ? [b.x0 + row * ROW, b.z0 + BAY / 2 + bay * BAY] : [b.x0 + BAY / 2 + bay * BAY, b.z0 + row * ROW];
        const yaw = b.dir === "z" ? Math.PI / 2 : 0;
        // (all four footprint corners on the slab — a box whose end overhangs the diagonal quay edge leaves a
        // 2.3 m gap above the sand under it, where kongs get stuck)
        if (!onApron(x, z, 2) || !footOnApron(x, z, b.dir === "z" ? 1.3 : 6.2, b.dir === "z" ? 6.2 : 1.3, 0.6) || blocked(x, z, b.dir === "z" ? 1.3 : 6.2, b.dir === "z" ? 6.2 : 1.3)) { line.push(null); continue; }
        if (b.auto && reservedAt(x, z, b.dir === "z" ? 1.3 : 6.2, b.dir === "z" ? 6.2 : 1.3)) { line.push(null); continue; }
        if (r() > (b.fill ?? 0.97)) { line.push({ x, z, yaw, tiers: 0, pair: false, lone: false, skipped: true, cols: [], flips: [], flip20: false }); continue; }
        // the skyline follows the profile; the outer rows sometimes one lower (a stepped edge, never a sheer wall)
        const outer = row === 0 || row === b.rows - 1;
        let tiers = Math.max(1, Math.min(4, base - (outer && r() < 0.3 ? 1 : 0) + (r() < 0.08 ? 1 : 0)));
        if (kind === "reefer") tiers = base;
        const pair = r() < (b.mix20 ?? 0);
        const s: Slot = { x, z, yaw, tiers, pair, lone: false, skipped: false, cols: [], flips: [], flip20: false };
        let below: ContainerColor | null = null;
        for (let l = 0; l < tiers; l++) {
          let c = pick(kind);
          // yellow-on-green (yellow still dominates)
          if (below === "yellow" && c === "yellow" && r() < 0.25) c = r() < 0.7 ? "green" : "red";
          below = c;
          s.cols.push(c);
          if (pair && l === tiers - 1) {
            // two 20 ft boxes share the slot (sometimes only one: a gap to look through / hide behind)
            if (r() < 0.75) { s.flip20 = r() < 0.5; s.cols.push(pick(kind)); } else s.lone = true;
            s.flips.push(false);
          } else s.flips.push(r() < 0.5);
        }
        line.push(s);
      }
    }
    // ---- fix-up: fill / raise enclosed slots until stable (a raised slot can close its neighbour's last exit)
    const at = (bay: number, row: number) => (bay >= 0 && bay < b.bays && row >= 0 && row < b.rows ? grid[bay][row] : undefined);
    const H = (s: Slot | null | undefined) => (s ? s.tiers : 0);
    for (let it = 0, changed = true; changed && it < 8; it++) {
      changed = false;
      for (let bay = 1; bay < b.bays - 1; bay++) for (let row = 1; row < b.rows - 1; row++) {
        const s = grid[bay][row];
        if (!s) continue;
        const nb = [at(bay - 1, row), at(bay + 1, row), at(bay, row - 1), at(bay, row + 1)];
        if (nb.some((n) => !n)) continue; // a neighbour slot is off the slab / a keep-out: open on that side
        const lo = Math.min(...nb.map(H));
        if (s.tiers >= lo) continue;
        while (s.tiers < lo) {
          // the old top 20 ft pair becomes a full box underneath; the new top is a 40 ft
          if (s.pair && s.tiers > 0) { s.cols.splice(s.cols.length - (s.lone ? 1 : 2), s.lone ? 1 : 2, s.cols[s.cols.length - (s.lone ? 1 : 2)]); s.pair = false; s.lone = false; }
          s.cols.push(pick(kind)); s.flips.push(r2() < 0.5); s.tiers++;
        }
        s.skipped = false;
        changed = true;
      }
    }
    for (let bay = 0; bay < b.bays; bay++) for (let row = 0; row < b.rows; row++) {
      const s = grid[bay][row];
      if (!s || !s.tiers) continue;
      // an interior row never keeps a lone 20 ft on top (a 6 × 2.4 m hole 2.59 m deep between its neighbours)
      if (s.pair && s.lone && row > 0 && row < b.rows - 1) { s.lone = false; s.cols.push(pick(kind)); s.flip20 = r2() < 0.5; }
      for (let l = 0; l < s.tiers; l++) {
        const y = APRON_Y + l * H1;
        if (s.pair && l === s.tiers - 1) {
          const d = 3.18, [dx, dz] = b.dir === "z" ? [0, d] : [d, 0];
          box(s.x - dx, y, s.z - dz, s.yaw, s.cols[l], kind, 20);
          if (!s.lone) box(s.x + dx, y, s.z + dz, s.yaw + (s.flip20 ? Math.PI : 0), s.cols[l + 1], kind, 20);
        } else box(s.x, y, s.z, s.yaw + (s.flips[l] ? Math.PI : 0), s.cols[l], kind);
      }
    }
  }
  // the foreground by the pier: yellow on green, 2 high broadside to the camera, a lone yellow, a red + yellow
  // pair — right beside the pier root and the pallet field. Yaw 0 (long axis along x) so their broadsides
  // face the view camera (+Z) on the SUNLIT side (the sun comes from local −X/+Z: +X faces are in shade)
  CONTAINERS.push(
    { x: 873.4, y: APRON_Y, z: 451.2, yaw: 0, color: "green", decal: "logo" }, { x: 873.3, y: APRON_Y + H1, z: 451.3, yaw: 0.015, color: "yellow", decal: "both" },
    { x: 873.8, y: APRON_Y, z: 454.2, yaw: Math.PI, color: "yellow", decal: "both" },
    { x: 866, y: APRON_Y, z: 437, yaw: Math.PI / 2, color: "yellow" },
    { x: 860.6, y: APRON_Y, z: 457.4, yaw: 0, color: "red", decal: "logo" }, { x: 860.7, y: APRON_Y + H1, z: 457.3, yaw: Math.PI - 0.02, color: "yellow", decal: "both" },
  );
  // under each crane (between the rails): no loose boxes — under the girders they are covered tops a kong can only jump onto

  // ---- ship deck stacks: 7 rows across the beam × bays along the length; blocky 2–4 high, lower toward the bow
  const S = SHIP;
  let bay = 0;
  // (planned as a bays × rows grid, then no interior stack may stand lower than its lowest neighbour — random
  // −1 dips make 2.59 m wells on the deck)
  const sg: Array<{ bz: number; t: number[] }> = [];
  for (let bz = S.bays.z0 + 6.3; bz + 6.3 <= S.bays.z1 + 0.1; bz += 12.6, bay++) {
    const bow = (bz - S.bays.z0) / (S.bays.z1 - S.bays.z0);
    const base = bay % 3 === 1 ? 4 : bow > 0.7 ? 2 : 3;
    const t: number[] = [];
    for (let row = -3; row <= 3; row++) {
      if (Math.abs(row) === 3 && bow > 0.75) { t.push(0); continue; }
      t.push(Math.max(1, Math.min(4, base - (Math.abs(row) === 3 && r() < 0.5 ? 1 : 0) - (r() < 0.15 ? 1 : 0))));
    }
    sg.push({ bz, t });
  }
  for (let it = 0, changed = true; changed && it < 8; it++) {
    changed = false;
    for (let i = 0; i < sg.length; i++) for (let k = 1; k < 6; k++) {
      const nb = [sg[i].t[k - 1], sg[i].t[k + 1], i > 0 ? sg[i - 1].t[k] : 99, i < sg.length - 1 ? sg[i + 1].t[k] : 99];
      const lo = Math.min(...nb);
      if (sg[i].t[k] < lo && lo < 99) { sg[i].t[k] = lo; changed = true; }
    }
  }
  // the deck is DESIGNED (shipDeck below: lanes, plazas, enterable boxes), not generated. The generated stacks' colour
  // picks still consume the yard's random stream so everything generated after this point keeps its place.
  for (const { t } of sg) for (let row = -3; row <= 3; row++) for (let l = 0; l < t[row + 3]; l++) void pick("yard");

  // ---- access-stair towers at the LOW ends of the tall blocks (the tier-2/3 roofs become climbable routes)
  const rects = BLOCKS.map(blockRect);
  /** the lane rect a tower needs is clear of every OTHER block, keep-out and the apron edge */
  const free = (self: number, x0: number, x1: number, z0: number, z1: number) =>
    !rects.some(([a, b, c, d], i) => i !== self && x1 > a - 1 && x0 < b + 1 && z1 > c - 1 && z0 < d + 1) && !blocked((x0 + x1) / 2, (z0 + z1) / 2, (x1 - x0) / 2, (z1 - z0) / 2) && onApron(x0, z0, 1) && onApron(x1, z1, 1) && onApron(x0, z1, 1) && onApron(x1, z0, 1);
  /** the actual stack height (tiers) standing at a local point (from the placed boxes) */
  const tiersAt = (x: number, z: number) => CONTAINERS.filter((p) => Math.abs(p.x - x) < 1.3 && Math.abs(p.z - z) < 6 && (p.size ?? 40) === 40 || (Math.abs(p.x - x) < 1.3 && Math.abs(p.z - z) < 6.5 && p.size === 20)).reduce((m, p) => Math.max(m, Math.round((p.y - APRON_Y) / H1) + 1), 0);
  const tiersAtX = (x: number, z: number) => CONTAINERS.filter((p) => Math.abs(p.z - z) < 1.3 && Math.abs(p.x - x) < 6.5).reduce((m, p) => Math.max(m, Math.round((p.y - APRON_Y) / H1) + 1), 0);
  BLOCKS.forEach((b, bi) => {
    if ((b.kind ?? "yard") !== "yard" || b.bays < 4 || Math.max(...b.profile) < 3) return;
    const [bx0, bx1, bz0, bz1] = rects[bi];
    const ends = b.profile[0] >= b.profile[b.profile.length - 1] ? [true, false] : [false, true];
    for (const lowStart of ends) {
      if (b.dir === "z") {
        const z = lowStart ? bz0 : bz1, dir = lowStart ? 1 : -1, x = bx0 + 2.9, zf = z - dir * 6.6, bayZ = z + dir * BAY / 2;
        // the landing reaches the roofs of rows 0 + 1 of the end bay: climb to the LOWER of the two
        const tiers = Math.min(tiersAt(b.x0, bayZ), tiersAt(b.x0 + ROW, bayZ));
        if (tiers < 2) continue;
        if (free(bi, x - 1.5, x + 1.5, Math.min(z, zf), Math.max(z, zf))) { STAIR_TOWERS.push({ x, z, dir, axis: "z", top: APRON_Y + Math.min(3, tiers) * H1 }); break; }
      } else {
        const x = lowStart ? bx0 : bx1, dir = lowStart ? 1 : -1, z = bz0 + 2.9, xf = x - dir * 6.6, bayX = x + dir * BAY / 2;
        const tiers = Math.min(tiersAtX(bayX, b.z0), tiersAtX(bayX, b.z0 + ROW));
        if (tiers < 2) continue;
        if (free(bi, Math.min(x, xf), Math.max(x, xf), z - 1.5, z + 1.5)) { STAIR_TOWERS.push({ x, z, dir, axis: "x", top: APRON_Y + Math.min(3, tiers) * H1 }); break; }
      }
    }
  });
  // ENTERABLE boxes — in the end bay beside a stair tower, rows ≥ 2 (the tower stands in front of rows 0–1), the
  // stack no higher than the tower's landing and stepping down from row 1 (so the roof over the box is walkable from the
  // tower), a clear lane in front of the doors. Doors swung flat, an empty lit interior: cover + loot spots.
  {
    const rr = mulberry32(YARD_SEED + 777), rects2 = BLOCKS.map(blockRect);
    for (const t of STAIR_TOWERS) {
      const bi = BLOCKS.findIndex((b, i) => b.dir === t.axis && (t.axis === "z" ? Math.abs(rects2[i][0] + 2.9 - t.x) < 0.01 && (Math.abs(rects2[i][2] - t.z) < 0.01 || Math.abs(rects2[i][3] - t.z) < 0.01) : Math.abs(rects2[i][2] + 2.9 - t.z) < 0.01 && (Math.abs(rects2[i][0] - t.x) < 0.01 || Math.abs(rects2[i][1] - t.x) < 0.01)));
      if (bi < 0) continue;
      const b = BLOCKS[bi], topT = Math.round((t.top - APRON_Y) / H1);
      const at = (row: number) => {
        const [x, z] = b.dir === "z" ? [b.x0 + row * ROW, t.z + t.dir * BAY / 2] : [t.x + t.dir * BAY / 2, b.z0 + row * ROW];
        return { x, z, boxes: CONTAINERS.filter((p) => Math.abs(p.x - x) < 0.3 && Math.abs(p.z - z) < 0.6 && (p.size ?? 40) === 40).sort((u, v) => u.y - v.y), any20: CONTAINERS.some((p) => p.size === 20 && Math.abs(p.x - x) < (b.dir === "z" ? 0.3 : 3.5) && Math.abs(p.z - z) < (b.dir === "z" ? 3.5 : 0.3)) };
      };
      let prev = Math.min(at(0).boxes.length, at(1).boxes.length);
      for (let row = 2; row < b.rows; row++) {
        const c = at(row), n = c.boxes.length;
        if (!n || c.any20 || n > prev || n > topT) break;
        prev = n;
        // the lane in front of the doors (3 m) must be free of other blocks, keep-outs and the slab edge
        const [fx, fz] = b.dir === "z" ? [c.x, t.z - t.dir * 1.6] : [t.x - t.dir * 1.6, c.z];
        const hx = b.dir === "z" ? 1.2 : 1.5, hz = b.dir === "z" ? 1.5 : 1.2;
        if (!footOnApron(fx, fz, hx, hz, 0.5) || rects2.some(([a0, a1, c0, c1], i) => i !== bi && fx + hx > a0 && fx - hx < a1 && fz + hz > c0 && fz - hz < c1)) break;
        if (rr() > 0.75) continue;
        const bot = c.boxes[0];
        bot.enter = true; bot.pitch = 0; bot.roll = 0;
        bot.yaw = b.dir === "z" ? (t.dir === 1 ? Math.PI / 2 : -Math.PI / 2) : (t.dir === 1 ? Math.PI : 0);
      }
    }
  }
  // crate steps up the 1-high block ends (crate 1.0 → two crates 2.0 → the roof 2.59: every step ≤ 1 m, a kong jumps 1.2)
  for (const b of BLOCKS) {
    if ((b.kind ?? "yard") === "reefer") continue;
    const [bx0, bx1, bz0, bz1] = blockRect(b);
    for (const end of [0, 1]) {
      if (b.dir === "z") {
        const z = end ? bz1 : bz0, dir = end ? -1 : 1, x = b.x0 + (end ? ROW * Math.min(2, b.rows - 1) : 0);
        if (tiersAt(x, z + dir * BAY / 2) !== 1 || !onApron(x, z - dir * 2, 2) || blocked(x, z - dir * 2, 1, 1)) continue;
        PROPS.push({ kind: "crate", x: x + 0.1, z: z - dir * 1.9, yaw: 0.1 }, { kind: "crate-stack", x: x, z: z - dir * 0.7, yaw: -0.05 });
      } else {
        const x = end ? bx1 : bx0, dir = end ? -1 : 1, z = b.z0 + (end ? ROW * Math.min(2, b.rows - 1) : 0);
        if (tiersAtX(x + dir * BAY / 2, z) !== 1 || !onApron(x - dir * 2, z, 2) || blocked(x - dir * 2, z, 1, 1)) continue;
        PROPS.push({ kind: "crate", x: x - dir * 1.9, z: z + 0.1, yaw: 0.1 }, { kind: "crate-stack", x: x - dir * 0.7, z, yaw: -0.05 });
      }
    }
    void bz1; void bx1;
  }

  // ---- the chassis park: rows of skeletal trailers (half loaded), tractors hooked to some, tyre walls at the row ends
  {
    const C = CHASSIS_PARK;
    for (let z = C.z0 + 3, row = 0; z < C.z1 - 3; z += C.rowPitch, row++) {
      if (row % 4 === 3) continue; // a driving lane every fourth row
      for (let x = C.x0 + 8; x < C.x1 - 6; x += C.slot) {
        if (r() < 0.18) continue;
        PROPS.push({ kind: "chassis", x, z, yaw: 0 });
        if (r() < 0.8) {
          const big = r() < 0.7;
          CONTAINERS.push({ x: big ? x : x - 3, y: APRON_Y + 1.36, z, yaw: r() < 0.5 ? 0 : Math.PI, size: big ? 40 : 20, color: pick("yard"), decal: undefined });
        }
        if (r() < 0.22) PROPS.push({ kind: "truck", x: x + 9.4, z, yaw: Math.PI });
      }
      PROPS.push({ kind: "tyre-wall", x: C.x1 - 1.5, z, yaw: Math.PI / 2 });
    }
    for (let x = C.x0 + 10; x < C.x1; x += 22) PROPS.push({ kind: "light-tower", x, z: C.z0 - 4, yaw: 0 });
  }
  // ---- the gate: scale house, two booths, jersey barriers funnelling the road in, a light tower
  {
    const G = GATE;
    PROPS.push({ kind: "scale-house", x: G.x + 10, z: G.z - G.halfW - 6, yaw: 0 });
    PROPS.push({ kind: "booth", x: G.x + 2, z: G.z - 4, yaw: 0 }, { kind: "booth", x: G.x + 2, z: G.z + 4, yaw: 0 });
    // (a crate beside each booth + a crate stack by the scale house: the flat roofs are reachable by a mantle)
    PROPS.push({ kind: "crate", x: G.x + 1.6, z: G.z - 5.95, yaw: 0.1 }, { kind: "crate", x: G.x + 1.6, z: G.z + 5.95, yaw: -0.1 });
    PROPS.push({ kind: "crate-stack", x: G.x + 10 - 2.2, z: G.z - G.halfW - 6 + 2.1 + 0.62, yaw: 0 }, { kind: "crate", x: G.x + 10 - 2.2, z: G.z - G.halfW - 6 + 2.1 + 1.9, yaw: 0.1 });
    for (let k = 0; k < 4; k++) PROPS.push({ kind: "barrier", x: G.x + 9 + k * 3.2, z: G.z - 8.5, yaw: 0 }, { kind: "barrier", x: G.x + 9 + k * 3.2, z: G.z + 8.5, yaw: 0 });
    PROPS.push({ kind: "light-tower", x: G.x + 6, z: G.z + G.halfW + 4, yaw: 0 });
    FENCES.push({ pts: [[530.5, G.z - G.halfW], [530.5, 212], [558, 193], [568.5, 132], [568.5, 44]] }, { pts: [[530.5, G.z + G.halfW], [530.5, 368]] });
    // the headland side (local z ≈ 470): stops short of the pier corner, the jungle patch breaks it
    FENCES.push({ pts: [[612, 467.5], [700, 467.5]] }, { pts: [[722, 467.5], [782, 467.5]] });
  }
  // ---- the lay-down yard: chain-link fence with a gate toward the yard, material stacks in rows, retired boxes
  {
    const Ld = LAYDOWN;
    FENCES.push({ pts: [[Ld.x1, Ld.z0], [Ld.x0, Ld.z0], [Ld.x0, Ld.z1]] }, { pts: [[Ld.x1, Ld.z0], [Ld.x1, Ld.z1]], gaps: [[Ld.gateZ - Ld.z0 - 6, Ld.gateZ - Ld.z0 + 6]] });
    const kinds: PropKind[] = ["pipe-stack", "timber-stack", "spool", "pipe-stack", "hatch-cover", "timber-stack", "lashing-cage", "crate-stack"];
    const boxed = (x: number, z: number) => BLOCKS.some((b) => { const [a, bb, c, d] = blockRect(b); return x > a - 4 && x < bb + 4 && z > c - 3 && z < d + 3; }) || [[642, 374], [664, 450], [646, 450], [684, 380], [684, 396], [640, 424]].some(([bx, bz]) => Math.abs(bx - x) < 8 && Math.abs(bz - z) < 8);
    for (let x = Ld.x0 + 9, i = 0; x < Ld.x1 - 6; x += 13) for (let z = Ld.z0 + 8; z < Ld.z1 - 6; z += 11, i++) {
      if (jungleAt(x, z) > 0.6 || r() < 0.12 || boxed(x, z)) continue;
      PROPS.push({ kind: kinds[Math.floor(r() * kinds.length)], x: x + (r() - 0.5) * 3, z: z + (r() - 0.5) * 2, yaw: (r() < 0.5 ? 0 : Math.PI / 2) + (r() - 0.5) * 0.2 });
    }
    // retired boxes dumped in the lay-down (weathered, some on their own, a pair stacked)
    for (const [x, z, yaw, two] of [[642, 374, 0.05, true], [664, 450, 1.5, false], [646, 450, 1.62, true], [684, 380, -0.04, true], [684, 396, 0.02, false], [640, 424, 1.55, false]] as Array<[number, number, number, boolean]>) {
      CONTAINERS.push({ x, y: APRON_Y, z, yaw, color: pick("empties"), decal: "none", tint: 0.8 });
      if (two) CONTAINERS.push({ x: x + 0.2, y: APRON_Y + H1, z: z + 0.3, yaw: yaw + 0.04, color: pick("empties"), decal: r() < 0.5 ? "logo" : "none", tint: 0.82 });
    }
  }
  // ---- jungle trees in the overgrown patches: dense (a tree per ~55 m², min spacing 4 m), palms toward the rim
  for (const [pi, p] of JUNGLE_PATCHES.entries()) {
    const n = Math.max(p.trees, Math.round((Math.PI * p.rx * p.rz) / 70)), c = dmath.cos(p.rot), sn = dmath.sin(p.rot);
    const placed: Array<[number, number]> = [];
    for (let k = 0, tries = 0; k < n && tries < n * 6; tries++) {
      const a = r() * Math.PI * 2, d = Math.sqrt(r()) * 0.88;
      const u = dmath.cos(a) * d * p.rx, v = dmath.sin(a) * d * p.rz;
      const x = p.x + u * c - v * sn, z = p.z + u * sn + v * c;
      if (!onApron(x, z, 1.5) || blocked(x, z, 2, 2) || placed.some(([px, pz]) => dmath.pow(px - x, 2) + dmath.pow(pz - z, 2) < 16)) continue;
      if (CONTAINERS.some((q) => Math.abs(q.x - x) < 7 && Math.abs(q.z - z) < 7)) continue;
      placed.push([x, z]); k++;
      // 2 of every 5 trees are planted — the yard's land side
      // reads as jungle breaking in, not a wall of canopy over the lanes (the draws still run: the yard's random stream,
      // and everything generated after it, stays stable)
      const kind = d > 0.62 || (k + pi) % 4 === 0 ? "palm" as const : "jungle-tree" as const, ts = 0.75 + r() * 0.5, ty = r() * 6.28;
      if (k % 5 < 2) JUNGLE_TREES.push({ x, z, kind, s: ts, yaw: ty });
    }
  }

  // ---- props: bollards along the berth + the other water edges; lamps along the quay and the lanes
  for (let z = QUAY.eastZ0 + 6; z < QUAY.eastZ1 - 3; z += 13) PROPS.push({ kind: "bollard", x: QUAY.eastX - 1.1, z, yaw: 0 });
  for (let x = 590; x < 765; x += 16) PROPS.push({ kind: "bollard", x, z: 41.1, yaw: 0 });
  for (let z = 270; z < 440; z += 44) PROPS.push({ kind: "lamp", x: 862, z, yaw: 0 });
  for (const w of WAREHOUSES) {
    const alongZ = Math.abs(dmath.sin(w.yaw)) > 0.5;
    for (const d of [-14, 14]) {
      const p = alongZ ? { x: w.x + w.width / 2 + 7, z: w.z + d } : { x: w.x + d, z: w.z - w.width / 2 - 7 };
      if (onApron(p.x, p.z, 2) && !blocked(p.x, p.z, 0.3, 0.3)) PROPS.push({ kind: "lamp", x: p.x, z: p.z, yaw: 0 });
    }
  }
  PROPS.push({ kind: "lamp", x: 890, z: 462, yaw: 0 });
  // high-mast floodlight towers over the yard lanes (tall poles with light clusters)
  for (const [x, z] of [[842, 312], [808, 356], [791, 232], [842, 384], [760, 300], [720, 180], [640, 120]] as Array<[number, number]>) PROPS.push({ kind: "light-tower", x, z, yaw: 0 });
  // THE BANANA PALLET FIELD by the pier (two dense rows of slatted crates heaped with bananas beside the quay,
  // a forklift working them): tight rows (1.72 m pitch, one or two high), a short
  // double row west of the forklift aisle (it also covers the terrain boulder that pokes 17 cm through the slab at
  // local 883.1, 442.9 — terrain's rock scatter only honours its own, smaller HARBOR_APRON)
  {
    const row = (x: number, z0: number, n: number, two: (i: number) => boolean, dz = 1.72) => {
      for (let i = 0; i < n; i++) PROPS.push({ kind: two(i) ? "pallet-stack" : "pallet", x: x + (((i * 7) % 3) - 1) * 0.03, z: z0 + i * dz, yaw: Math.PI / 2 + (((i * 5) % 3) - 1) * 0.02, load: "slatted", s: 1.35 });
    };
    row(888.9, 440.6, 7, (i) => i % 3 !== 1);
    row(887.35, 441.4, 6, (i) => i % 2 === 0);
    row(883.9, 441.0, 4, (i) => i === 1);
    row(882.4, 441.6, 3, () => false);
  }
  PROPS.push(
    // hand-placed near the camera (two yellow forklifts in front of the stacks, a generator, crates)
    { kind: "forklift", x: 878, z: 440, yaw: 2.3 }, { kind: "forklift", x: 868, z: 460.5, yaw: -1.6 }, { kind: "generator", x: 858, z: 466, yaw: Math.PI / 2 },
    { kind: "forklift", x: 885.7, z: 452.8, yaw: Math.PI / 2 - 0.1, s: 1.05 },
    { kind: "cone", x: 890, z: 437.6, yaw: 0 }, { kind: "cone", x: 892, z: 437.2, yaw: 0 },
    { kind: "drum-pallet", x: 866, z: 466, yaw: 0.05 }, { kind: "drum-pallet", x: 864.6, z: 466.1, yaw: -0.04 }, { kind: "tyres", x: 862.8, z: 466.6, yaw: 0 },
    // terminal tractors + chassis under the cranes
    { kind: "truck", x: 878, z: CRANE.zs[0] + 13, yaw: Math.PI / 2 }, { kind: "truck", x: 878, z: CRANE.zs[1] - 13, yaw: -Math.PI / 2 },
    { kind: "chassis", x: 876, z: CRANE.zs[0] + 24, yaw: Math.PI / 2 },
    // warehouse forecourts (the yellow shed faces the pier corner: pallets + a forklift at its doors, left of the view)
    { kind: "forklift", x: 818, z: 448, yaw: 0.2 }, { kind: "pallet-stack", x: 816, z: 458, yaw: 0.1 }, { kind: "pallet-stack", x: 816.2, z: 459.3, yaw: 0.0 }, { kind: "pallet-stack", x: 817.5, z: 458.6, yaw: 0.05 },
    { kind: "pallet", x: 817, z: 432, yaw: -0.1 }, { kind: "pallet", x: 818.3, z: 432.2, yaw: 0.05 }, { kind: "crate-stack", x: 816, z: 427, yaw: 0.3 }, { kind: "crate-stack", x: 817.2, z: 427.1, yaw: 0.25 }, { kind: "drum-pallet", x: 818, z: 423, yaw: 0.1 },
    { kind: "barrel", x: 784, z: 434, yaw: 0 }, { kind: "barrel", x: 784.8, z: 435, yaw: 0.5 },
    // the busy quay edge north of the pallet field: a forklift working a row of banana-box pallets stacked 2 high
    { kind: "forklift", x: 889.6, z: 432.6, yaw: Math.PI + 0.25 }, { kind: "pallet-stack", x: 886.2, z: 437.0, yaw: Math.PI / 2, load: "boxes", s: 1.2 },
    { kind: "pallet-stack", x: 886.25, z: 435.5, yaw: Math.PI / 2 + 0.04, load: "boxes", s: 1.2 }, { kind: "pallet-stack", x: 886.3, z: 434.0, yaw: Math.PI / 2 - 0.05, load: "bananas", s: 1.2 },
    { kind: "pallet-stack", x: 884.8, z: 435.5, yaw: Math.PI / 2, load: "bananas", s: 1.2 }, { kind: "pallet-stack", x: 884.8, z: 437.0, yaw: Math.PI / 2 + 0.03, load: "boxes", s: 1.2 },
    { kind: "pallet-stack", x: 870.5, z: 468.2, yaw: 0.02, load: "slatted", s: 1.3 }, { kind: "pallet-stack", x: 873.2, z: 468.3, yaw: -0.04, load: "slatted", s: 1.3 },
    { kind: "drum-pallet", x: 893, z: 454.6, yaw: 0.2 },
    // the quay corner south of the pier root: a 2 × 2 banana block + a forklift backing away from it + a crate block
    { kind: "pallet-stack", x: 885.6, z: 465.3, yaw: Math.PI / 2 + 0.03, load: "slatted", s: 1.35 }, { kind: "pallet-stack", x: 887.1, z: 465.3, yaw: Math.PI / 2 - 0.02, load: "slatted", s: 1.35 },
    { kind: "pallet", x: 885.6, z: 467.0, yaw: Math.PI / 2 + 0.01, load: "slatted", s: 1.35 }, { kind: "pallet-stack", x: 887.1, z: 467.0, yaw: Math.PI / 2 + 0.04, load: "slatted", s: 1.35 },
    { kind: "forklift", x: 891.4, z: 464.2, yaw: -2.5, s: 1.15 },
  );
  clusterAt(877.4, 464.0, 0.1, "crate-block", r);
  PROPS.push(
    // quay strip dressing: hatch covers, lashing cages, spools, tyres (cover along the berth every ~18 m)
    { kind: "hatch-cover", x: 865.5, z: 276, yaw: Math.PI / 2 }, { kind: "lashing-cage", x: 892, z: 290, yaw: 0.1 }, { kind: "tyres", x: 892, z: 272, yaw: 0 },
    { kind: "spool", x: 891, z: 350, yaw: 0.2 }, { kind: "lashing-cage", x: 864, z: 338, yaw: Math.PI / 2 }, { kind: "hatch-cover", x: 865.5, z: 362, yaw: Math.PI / 2 },
    { kind: "tyres", x: 892, z: 430, yaw: 0.4 }, { kind: "bin", x: 891.5, z: 410, yaw: 0 }, { kind: "cone", x: 874, z: 330, yaw: 0 }, { kind: "cone", x: 874, z: 333, yaw: 0 },
  );
}

/**
 * A DELIBERATE cover cluster (not loose crates scattered like confetti; one every
 * 12–15 m): 4–12 pieces packed like a working yard stages them. Local frame of the cluster: `yaw` turns it; `u` along
 * its long axis. Returns the pieces pushed (for the solid index).
 */
export type ClusterKind = "pallet-block" | "crate-block" | "drums" | "forklift-work" | "chassis20" | "genset" | "tyres" | "banana-row";
export function clusterAt(x: number, z: number, yaw: number, kind: ClusterKind, r: () => number, out: PropSpec[] = PROPS, boxes: ContainerPlacement[] = CONTAINERS): void {
  const c = dmath.cos(yaw), sn = dmath.sin(yaw);
  // (u along the cluster, v across) → local x, z (three yaw: +u = (cos, −sin))
  const at = (u: number, v: number): [number, number] => [x + u * c + v * sn, z - u * sn + v * c];
  const put = (kind2: PropKind, u: number, v: number, dy = 0, extra: Partial<PropSpec> = {}) => { const [px, pz] = at(u, v); out.push({ kind: kind2, x: px, z: pz, yaw: yaw + dy, ...extra }); };
  const jit = () => (r() - 0.5) * 0.06;
  switch (kind) {
    case "pallet-block": {
      // 2 rows × 3 pallet stacks (boxes / banana boxes), one slot sometimes empty, a single pallet in front
      const load: PalletLoad = r() < 0.5 ? "boxes" : "bananas", miss = Math.floor(r() * 8);
      for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) if (i * 2 + j !== miss) put("pallet-stack", (i - 1) * 1.3, (j - 0.5) * 1.1, jit(), { load });
      put("pallet", 2.35, (r() - 0.5) * 0.6, Math.PI / 2 + jit(), { load });
      break;
    }
    case "banana-row": {
      // the hero stock: slatted banana crates in a tight row, 2 high every other slot
      const n = 4 + Math.floor(r() * 3);
      for (let i = 0; i < n; i++) put(i % 2 ? "pallet-stack" : "pallet", (i - (n - 1) / 2) * 1.72, 0, Math.PI / 2 + jit(), { load: "slatted", s: 1.35 });
      break;
    }
    case "crate-block":
      for (const [u, v] of [[-0.6, -0.6], [0.6, -0.6], [-0.6, 0.6], [0.6, 0.6]]) put("crate-stack", u, v, jit());
      put("crate", 1.85, -0.3, 0.3 + jit()); put("crate", -1.9, 0.5, -0.2 + jit());
      break;
    case "drums":
      put("drum-pallet", -0.7, 0, jit()); put("drum-pallet", 0.7, 0, jit()); put("drum-pallet", 0, 1.3, jit());
      put("tyres", 2.3, 0.4, 0); put("barrel", -1.9, 0.9, 0); put("barrel", -1.8, 1.5, 0);
      break;
    case "forklift-work": {
      // a forklift parked nose-in to a 2 × 2 block of pallet stacks
      for (const [u, v] of [[0, -0.6], [0, 0.6], [1.3, -0.6], [1.3, 0.6]]) put("pallet-stack", u, v, jit(), { load: r() < 0.5 ? "boxes" : "crates" });
      put("forklift", -3.0, 0, 0);
      break;
    }
    case "chassis20": {
      put("chassis", 0, 0, 0);
      const [cx, cz] = at(-2.9, 0);
      boxes.push({ x: cx, y: APRON_Y + 1.36, z: cz, yaw: yaw + (r() < 0.5 ? Math.PI : 0), size: 20, color: r() < 0.5 ? "yellow" : r() < 0.5 ? "red" : "green" });
      put("drum-pallet", 3.4, 1.9, jit());
      break;
    }
    case "genset":
      put("generator", 0, 0, 0); put("drum-pallet", 0, 1.6, jit()); put("drum-pallet", 1.4, 1.6, jit()); put("crate-stack", -1.9, 1.2, jit());
      break;
    case "tyres":
      put("tyres", -1.2, 0, 0); put("tyres", 0.6, 0.2, 0); put("tyres", -0.2, 1.7, 0); put("spool", 2.3, 0.9, 0.3);
      break;
  }
}

/**
 * Cover pass: sample the apron on a 4 m grid and drop a deliberate cover CLUSTER wherever nothing ≥ 1.2 m tall stands
 * within 6.5 m — hard cover every ~12–13 m on open concrete.
 */
function coverPass(extra: Array<[number, number, number, number]>) {
  const r = mulberry32(YARD_SEED + 99), r2c = mulberry32(YARD_SEED + 991);
  const solid: Array<[number, number]> = [];
  const addSolid = (x: number, z: number) => solid.push([x, z]);
  // only HARD cover counts (≥ 1.2 m: a crouching kong disappears behind it) — hard cover every 12–15 m
  for (const p of CONTAINERS) { const c = dmath.cos(p.yaw), sn = dmath.sin(p.yaw), L = (p.size ?? 40) === 40 ? 5 : 2; for (const u of [-L, 0, L]) addSolid(p.x + u * c, p.z - u * sn); }
  for (const p of PROPS) if (PROP_FOOT[p.kind].hy * (p.s ?? 1) >= 0.58 && p.kind !== "lamp" && p.kind !== "light-tower") addSolid(p.x, p.z);
  for (const t of JUNGLE_TREES) addSolid(t.x, t.z);
  for (const w of WAREHOUSES) { const [x0, x1, z0, z1] = whRect(w, 0, 0); for (let x = x0; x <= x1; x += 6) for (let z = z0; z <= z1; z += 6) addSolid(x, z); }
  for (const [x0, x1, z0, z1] of extra) for (let x = x0; x <= x1; x += 6) for (let z = z0; z <= z1; z += 6) addSolid(x, z);
  const CELL = 12.5, grid = new Map<string, Array<[number, number]>>();
  const key = (x: number, z: number) => `${Math.floor(x / CELL)}:${Math.floor(z / CELL)}`;
  const put = (x: number, z: number) => { const k = key(x, z); (grid.get(k) ?? grid.set(k, []).get(k)!).push([x, z]); };
  for (const [x, z] of solid) put(x, z);
  const near = (x: number, z: number, d: number) => {
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const [px, pz] of grid.get(`${cx + i}:${cz + j}`) ?? []) if (dmath.pow(px - x, 2) + dmath.pow(pz - z, 2) < d * d) return true;
    return false;
  };
  const quay = (x: number, z: number) => x > 858 && z > 262;
  // masts + light towers are not cover, but nothing may be staged on top of their foundations
  const masts = PROPS.filter((p) => p.kind === "lamp" || p.kind === "light-tower").map((p) => [p.x, p.z] as [number, number]);
  const onMast = (x: number, z: number, d: number) => masts.some(([mx, mz]) => dmath.pow(mx - x, 2) + dmath.pow(mz - z, 2) < d * d);
  const R = 7.5;
  for (let z = 44; z < 470; z += 4) for (let x = 530; x < 896; x += 4) {
    if (!onApron(x, z, 3.5) || near(x, z, R) || blocked(x, z, 1.6, 1.6) && !(quay(x, z) && x < 892)) continue;
    // the crane legs, sills + bogies stay clear (the portal lane between the rails is a truck lane: cover goes there)
    if (quay(x, z) && CRANE.zs.some((cz) => Math.abs(z - cz) < CRANE.legHalfZ + 4) && x > CRANE.railLand - 3 && x < CRANE.railSea + 3) continue;
    if (quay(x, z) && (Math.abs(x - CRANE.railLand) < 1.8 || Math.abs(x - CRANE.railSea) < 1.8)) continue;
    if (x > 880 && x < 894 && z > 436 && z < 470) continue;   // the hand-dressed quay corner by the pier
    if (onMast(x, z, 4.5)) continue;
    const jx = x + (r() - 0.5) * 2, jz = z + (r() - 0.5) * 2, u = r(), yaw = (r() < 0.5 ? 0 : Math.PI / 2) + (r() - 0.5) * 0.2;
    if (quay(x, z)) {
      if (x > CRANE.railLand + 2 && x < CRANE.railSea - 2) {
        // between the rails: a truck under the crane, a hatch-cover stack or a lashing cage (along the lane)
        if (u < 0.35) PROPS.push({ kind: "truck", x: jx, z: jz, yaw: r() < 0.5 ? Math.PI / 2 : -Math.PI / 2 });
        else if (u < 0.7) PROPS.push({ kind: "hatch-cover", x: jx, z: jz, yaw: Math.PI / 2 });
        else PROPS.push({ kind: "lashing-cage", x: jx, z: jz, yaw: Math.PI / 2 }, { kind: "spool", x: jx, z: jz + 2.4, yaw: 0.3 });
      } else if (u < 0.35) PROPS.push({ kind: "hatch-cover", x: jx, z: jz, yaw: Math.PI / 2 });
      else if (u < 0.6) clusterAt(jx, jz, Math.PI / 2, "drums", r);
      else clusterAt(jx, jz, Math.PI / 2, u < 0.8 ? "pallet-block" : "tyres", r);
    } else if (u < 0.22) clusterAt(jx, jz, yaw, "pallet-block", r);
    else if (u < 0.34) clusterAt(jx, jz, yaw, "forklift-work", r);
    else if (u < 0.46) clusterAt(jx, jz, yaw, "crate-block", r);
    else if (u < 0.56) clusterAt(jx, jz, yaw, "genset", r);
    else if (u < 0.66) clusterAt(jx, jz, yaw, "drums", r);
    else if (u < 0.72) PROPS.push({ kind: "lashing-cage", x: jx, z: jz, yaw }, { kind: "lashing-cage", x: jx + 2.5 * dmath.cos(yaw), z: jz - 2.5 * dmath.sin(yaw), yaw });
    else if (u < 0.79) PROPS.push({ kind: "hatch-cover", x: jx, z: jz, yaw });
    else if (u < 0.85) { PROPS.push({ kind: "timber-stack", x: jx, z: jz, yaw }); clusterAt(jx + 1.8 * dmath.sin(yaw), jz + 1.8 * dmath.cos(yaw), yaw, "crate-block", r); }
    else if (u < 0.92 && !blocked(jx, jz, 6.5, 6.5) && !near(jx + 6.3 * dmath.cos(yaw), jz - 6.3 * dmath.sin(yaw), 3.2) && !near(jx - 6.3 * dmath.cos(yaw), jz + 6.3 * dmath.sin(yaw), 3.2) && onApron(jx + 6.3 * dmath.cos(yaw), jz - 6.3 * dmath.sin(yaw), 2) && onApron(jx - 6.3 * dmath.cos(yaw), jz + 6.3 * dmath.sin(yaw), 2)) clusterAt(jx, jz, yaw, "chassis20", r);
    else {
      const cyaw = yaw + (r() < 0.5 ? Math.PI : 0), q: ContainerPlacement = { x: jx, y: APRON_Y, z: jz, yaw: cyaw, size: 20, color: r() < 0.55 ? "yellow" : r() < 0.5 ? "red" : "green", decal: undefined };
      // every other lone 20 ft box is ENTERABLE (quarter-turn yaw, doors flat open) with a crate at its closed end —
      // a mantle onto its roof. The doors need 2.5 m of open slab in front.
      const qy = Math.round(cyaw / (Math.PI / 2)) * (Math.PI / 2), ux = dmath.cos(qy), uz = -dmath.sin(qy);
      if (r2c() < 0.5 && onApron(jx + ux * 5.6, jz + uz * 5.6, 1) && !near(jx + ux * 5.2, jz + uz * 5.2, 1.6) && onApron(jx - ux * 4, jz - uz * 4, 1)) {
        q.yaw = qy; q.enter = true;
        PROPS.push({ kind: "crate", x: jx - ux * 3.65, z: jz - uz * 3.65, yaw: qy + 0.08 });
      }
      CONTAINERS.push(q);
    }
    put(jx, jz);
  }

  // the slab edges the pass above keeps 3.5 m off are still 7–13 m from hard cover: single ≥ 1.6 m props — a crate stack, a banana pallet stack, a genset — closer to the kerbs
  for (let z = 42; z < 472; z += 3) for (let x = 528; x < 898; x += 3) {
    if (!onApron(x, z, 1.4) || near(x, z, 7.2) || blocked(x, z, 1.0, 1.0) || onMast(x, z, 3)) continue;
    if (quay(x, z) && (CRANE.zs.some((cz) => Math.abs(z - cz) < CRANE.legHalfZ + 4) || Math.abs(x - CRANE.railLand) < 2 || Math.abs(x - CRANE.railSea) < 2)) continue;
    if (x > 880 && x < 894 && z > 436 && z < 470) continue;
    if (x > 892) continue;   // the berth's capping strip + bollards stay clear (the gangway and the mooring lines)
    const u = r(), yaw = (r() < 0.5 ? 0 : Math.PI / 2) + (r() - 0.5) * 0.3, kind: PropKind = u < 0.45 ? "crate-stack" : u < 0.8 ? "pallet-stack" : "generator";
    const f = PROP_FOOT[kind], c = Math.abs(dmath.cos(yaw)), sn = Math.abs(dmath.sin(yaw));
    if (!footOnApron(x, z, f.hx * c + f.hz * sn, f.hx * sn + f.hz * c, 0.6)) continue;
    PROPS.push({ kind, x, z, yaw });
    put(x, z);
  }
}
/**
 * Lane pass: every stack block gets one or two small obstacles in the lane along
 * its long side — pushed toward one wall so the lane stays passable (≥ 3 m clear) but no lane is a 60 m sniper alley.
 */
function lanePass() {
  const r = mulberry32(YARD_SEED + 177);
  const rects = BLOCKS.map(blockRect);
  const inBlock = (x: number, z: number, m: number) => rects.some(([a, b, c, d]) => x > a - m && x < b + m && z > c - m && z < d + m);
  for (const b of BLOCKS) {
    if ((b.kind ?? "yard") === "reefer") continue;
    const [x0, x1, z0, z1] = blockRect(b);
    const n = 1 + (r() < 0.45 ? 1 : 0);
    for (let k = 0; k < n; k++) {
      const t = n === 1 ? 0.3 + r() * 0.4 : k === 0 ? 0.15 + r() * 0.2 : 0.62 + r() * 0.2;
      const side = 1.35 + r() * 0.3;   // metres out from the block face: hugs the wall
      const [x, z, yaw] = b.dir === "x" ? [x0 + (x1 - x0) * t, z1 + side, 0] : [x1 + side, z0 + (z1 - z0) * t, Math.PI / 2];
      if (!onApron(x, z, 3) || blocked(x, z, 1, 1) || inBlock(x, z, -0.2) || jungleAt(x, z) > 0.3) continue;
      if (x > 858 && z > 262) continue;
      const u = r();
      if (u < 0.3) PROPS.push({ kind: "drum-pallet", x, z, yaw }, { kind: "pallet-stack", x: x + (b.dir === "x" ? 1.4 : 0), z: z + (b.dir === "x" ? 0 : 1.4), yaw });
      else if (u < 0.5) PROPS.push({ kind: "forklift", x, z, yaw: yaw + (r() < 0.5 ? 0 : Math.PI) + (r() - 0.5) * 0.3 });
      else if (u < 0.7) PROPS.push({ kind: "crate-stack", x, z, yaw: r() }, { kind: "crate", x: x + (b.dir === "x" ? 1.3 : 0.2), z: z + (b.dir === "x" ? 0.2 : 1.3), yaw: r() });
      else if (u < 0.85) PROPS.push({ kind: "lashing-cage", x, z, yaw });
      else PROPS.push({ kind: "generator", x, z, yaw });
    }
  }
  // the SE corner by the diagonal quay (the worst cover gap): a hatch-cover stack + a retired 20 ft pair
  PROPS.push({ kind: "hatch-cover", x: 868, z: 240, yaw: 0.8 }, { kind: "lashing-cage", x: 876, z: 250, yaw: 0.8 }, { kind: "spool", x: 884, z: 256, yaw: 0.3 });
  // along the back of the tank bund (the apron edge by the headland fence)
  for (const x of [712, 728, 744, 760]) PROPS.push({ kind: x % 32 === 8 ? "pipe-stack" : "timber-stack", x, z: 465, yaw: 0 });
}
lanePass();
coverPass([
  // the reefer rack, the tank bund, the stair towers, the jungle patches (trees + bush) count as cover
  [REEFER_RACK.x - 1, REEFER_RACK.x + 1, REEFER_RACK.z0, REEFER_RACK.z1], [TANK_BUND.x0, TANK_BUND.x1, TANK_BUND.z0, TANK_BUND.z1],
  ...STAIR_TOWERS.map((t): [number, number, number, number] => [t.x - 1, t.x + 1, t.z - 1, t.z + 1]),
  ...JUNGLE_PATCHES.map((p): [number, number, number, number] => [p.x - p.rx * 0.72, p.x + p.rx * 0.72, p.z - p.rz * 0.72, p.z + p.rz * 0.72]),
]);

// the berth's capping strip (kept clear by the cover passes for the gangway + mooring lines)
// gets mooring winches between the crane sills — hard cover ≤ 8 m along the whole quay; the gangway approach, the
// crane legs / bogies and the hand-dressed pier corner stay clear
for (const z of [322, 340, 358, 375, 423]) PROPS.push({ kind: "winch", x: QUAY.eastX - 3.6, z, yaw: Math.PI / 2 });

// a last cover-gap pass on the same 4 m slab grid as the cover passes above — wherever hard
// cover (≥ 1.15 m) is still > 7.4 m away, a crate stack / banana pallet stack (a mooring winch on the berth strip) goes
// on that open spot, clear of every prop, box, keep-out, mast, crane rail and the gangway
{
  const sol: Array<[number, number, number]> = [];
  for (const p of CONTAINERS) { const c = dmath.cos(p.yaw), sn = dmath.sin(p.yaw), L = (p.size ?? 40) === 40 ? 12.19 : 6.06; for (let u = -L / 2 + 1.2; u <= L / 2 - 1.2; u += 2.4) sol.push([p.x + u * c, p.z - u * sn, 1.2]); }
  for (const p of PROPS) { const f = PROP_FOOT[p.kind], sc = p.s ?? 1; if (f.hy * 2 * sc >= 1.15 && p.kind !== "lamp" && p.kind !== "light-tower") sol.push([p.x, p.z, Math.max(f.hx, f.hz) * sc]); }
  for (const w of WAREHOUSES) { const [x0, x1, z0, z1] = whRect(w, 0, 0); for (let x = x0; x <= x1; x += 4) for (let z = z0; z <= z1; z += 4) sol.push([x, z, 2]); }
  for (const t of TANKS) sol.push([t.x, t.z, t.r]);
  for (const t of JUNGLE_TREES) sol.push([t.x, t.z, 1.5]);
  for (const t of STAIR_TOWERS) sol.push([t.x, t.z, 1.5]);
  for (let z = REEFER_RACK.z0; z <= REEFER_RACK.z1; z += 4) sol.push([REEFER_RACK.x, z, 1]);
  for (const cz of CRANE.zs) for (const rx of [CRANE.railLand, CRANE.railSea]) for (let z = cz - CRANE.legHalfZ - 2; z <= cz + CRANE.legHalfZ + 2; z += 3) sol.push([rx, z, 1]);
  for (let x = TANK_BUND.x0; x <= TANK_BUND.x1; x += 4) for (let z = TANK_BUND.z0; z <= TANK_BUND.z1; z += 4) sol.push([x, z, 1]);
  for (let x = PUMP_HOUSE.x - PUMP_HOUSE.w / 2; x <= PUMP_HOUSE.x + PUMP_HOUSE.w / 2; x += 2) for (let z = PUMP_HOUSE.z - PUMP_HOUSE.d / 2; z <= PUMP_HOUSE.z + PUMP_HOUSE.d / 2; z += 2) sol.push([x, z, 1]);
  // (a 6 m grid over the solids: the brute-force scan cost 2 s at import)
  const GC = 6, grid = new Map<number, Array<[number, number, number]>>(), gk = (i: number, j: number) => i * 4096 + j;
  const addSol = (q: [number, number, number]) => { const k = gk(Math.floor(q[0] / GC), Math.floor(q[1] / GC)); let a = grid.get(k); if (!a) grid.set(k, a = []); a.push(q); };
  for (const q of sol) addSol(q);
  const gap = (x: number, z: number) => {
    let b = 99; const ci = Math.floor(x / GC), cj = Math.floor(z / GC);
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) for (const [sx, sz, r] of grid.get(gk(ci + i, cj + j)) ?? []) { const d = dmath.hypot(sx - x, sz - z); b = Math.min(b, Math.max(0, d - r * 0.5)); }
    return b;
  };
  const any = (x: number, z: number, rr: number) => PROPS.some((p) => Math.abs(p.x - x) < rr + 7 && Math.abs(p.z - z) < rr + 7 && dmath.hypot(p.x - x, p.z - z) < rr + Math.max(PROP_FOOT[p.kind].hx, PROP_FOOT[p.kind].hz) * (p.s ?? 1)) || CONTAINERS.some((p) => Math.abs(p.x - x) < rr + 6.3 && Math.abs(p.z - z) < rr + 6.3 && dmath.hypot(p.x - x, p.z - z) < rr + 6.3);
  const masts = PROPS.filter((p) => p.kind === "lamp" || p.kind === "light-tower");
  const r = mulberry32(YARD_SEED + 4242);
  for (let z = 42; z < 470; z += 4) for (let x = 528; x < 896; x += 4) {
    if (!onApron(x, z, 2) || jungleAt(x, z) > 0.5 || gap(x, z) <= 6.6) continue;
    // try the sample and a ring of offsets toward the open side
    for (const [dx, dz] of [[0, 0], [1.5, 0], [-1.5, 0], [0, 1.5], [0, -1.5], [2.5, 2.5], [-2.5, -2.5], [2.5, -2.5], [-2.5, 2.5], [3.5, 0], [-3.5, 0], [0, 3.5], [0, -3.5]]) {
      const px = x + dx, pz = z + dz, berth = px > 888.5;
      if (berth && (pz > GANGWAY_Z - 20 && pz < GANGWAY_Z + 4 || pz > GANGWAY2_Z - 20 && pz < GANGWAY2_Z + 4 || CRANE.zs.some((cz) => Math.abs(pz - cz) < CRANE.legHalfZ + 4.5))) continue;
      const kind: PropKind = berth ? "winch" : r() < 0.55 ? "crate-stack" : "pallet-stack", yaw = berth ? Math.PI / 2 : (r() < 0.5 ? 0 : Math.PI / 2) + (r() - 0.5) * 0.3;
      const qx = berth ? QUAY.eastX - 3.6 : px, f = PROP_FOOT[kind];
      if (!footOnApron(qx, pz, Math.max(f.hx, f.hz), Math.max(f.hx, f.hz), 0.6) || blocked(qx, pz, 1.0, 1.0) || any(qx, pz, 1.4) || masts.some((m) => dmath.hypot(m.x - qx, m.z - pz) < 3)) continue;
      if (!berth && (Math.abs(qx - CRANE.railLand) < 2 || Math.abs(qx - CRANE.railSea) < 2)) continue;
      PROPS.push({ kind, x: qx, z: pz, yaw });
      addSol([qx, pz, Math.max(f.hx, f.hz)]);
      break;
    }
  }
}

// ---------------------------------------------------------------- the ship is a fight
// The main deck is laid out as a combat space: a 2.8 m centre aisle
// the length of the bays, three open hatch PLAZAS (aft / mid / fore) with low cover, 1–2-high stacks between them
// (hard cover; crate steps up onto the 1-high roofs = perches over the aisle), four ENTERABLE boxes with their doors on
// the plazas (a chest at the back of each), railed deck edges, two wide gangways, ladders out of the sea on the far
// side, a stair up to the forecastle. The accommodation house (18 furnished rooms + the bridge) is the payoff.
/** deck-level half-breadth of the hull — ship.ts halfBreadth at y = deckY (exact: the bilge / V-section / bulb terms
 *  vanish at the deck line) */
export function shipDeckHalf(z: number): number {
  const S = SHIP, HALF = S.beam / 2, zs = S.z - S.length / 2;
  const zb = S.z + S.length / 2 - dmath.pow(1 - (S.deckY - S.keelY) / (S.forecastle.top - S.keelY), 1.3) * 9;
  if (z < zs || z > zb) return 0;
  const tb = Math.min(1, (zb - z) / 34), ts = Math.min(1, (z - zs) / 16);
  const fb = 1 - dmath.pow(1 - tb, 2.1), fs = 0.8 + 0.2 * (1 - dmath.pow(1 - ts, 2)), ef = dmath.pow(1 - Math.min(1, (zb - z) / 44), 1.2);
  return HALF * Math.min(fb, fs) * (1 + 0.26 * ef);
}
/** hatch covers: 0.5 m (a step, ≤ STEP_H) — the containers stand on them */
export const SHIP_HATCH_H = 0.5;
export const SHIP_BAYS: number[] = [...Array(8)].map((_, i) => SHIP.bays.z0 + 6.3 + 12.6 * i);
export const shipHatch = (bz: number) => ({ hw: Math.min(SHIP.beam / 2 - 2.4, Math.min(shipDeckHalf(bz - 6.2), shipDeckHalf(bz + 6.2)) - 2.4), hl: 6.2 });
/** the forecastle deck (visual: FC_TOP − 1.2, a 1.8 m step above the main deck) + the stair up to it on the centre line */
export const FC_DECK = SHIP.forecastle.top - 1.2;
export const FC_FRONT = SHIP.forecastle.z0;
export function fcStair(): Array<{ z0: number; z1: number; y1: number; hw: number }> {
  const n = 6, rise = (FC_DECK - SHIP.deckY) / n, run = 0.5, out = [];
  for (let k = 0; k < n; k++) out.push({ z0: FC_FRONT - run * (n - k), z1: FC_FRONT - run * (n - k - 1), y1: SHIP.deckY + rise * (k + 1), hw: 1.5 });
  return out;
}
/** rows −3..3 across the beam (x = SHIP.x + row · 2.6) × the 8 bays: tiers, or "a" = an enterable box, doors aft */
type DeckCell = 0 | 1 | 2 | "a";
const SHIP_DECK_PLAN: DeckCell[][] = [
  [2, 2, 1, 0, 1, 2, 2],
  [0, 0, 0, 0, 0, 0, 1],        // aft plaza (gangway 1 lands here)
  [2, 1, "a", 0, "a", 1, 2],
  [2, 2, 1, 0, 1, 2, 2],
  [1, 0, 0, 0, 0, 0, 1],        // mid plaza
  [0, "a", 1, 0, 1, "a", 2],    // (row −3 open: gangway 2 lands beside it)
  [0, 1, 2, 0, 2, 1, 1],
  [0, 0, 0, 0, 0, 0, 0],        // fore plaza under the forecastle
];
/** the deck's props (on the hatch tops) and its enterable boxes */
export const SHIP_DECK_PROPS: PropSpec[] = [];
export const SHIP_ENTER: ContainerPlacement[] = [];
{
  const S = SHIP, rr = mulberry32(YARD_SEED + 9100), y0 = S.deckY + SHIP_HATCH_H;
  const pal: Array<[ContainerColor, number]> = [["yellow", 0.5], ["green", 0.22], ["red", 0.16], ["blue", 0.07], ["teal", 0.05]];
  const pick = (): ContainerColor => { let u = rr(); for (const [c, w] of pal) { if (u < w) return c; u -= w; } return "yellow"; };
  SHIP_DECK_PLAN.forEach((rows, i) => rows.forEach((cell, k) => {
    const x = S.x + (k - 3) * 2.6, z = SHIP_BAYS[i];
    if (cell === "a") { const p: ContainerPlacement = { x, y: y0, z, yaw: Math.PI / 2, color: pick(), enter: true, open: true }; SHIP_CONTAINERS.push(p); SHIP_ENTER.push(p); return; }
    for (let l = 0; l < cell; l++) SHIP_CONTAINERS.push({ x, y: y0 + l * H1, z, yaw: Math.PI / 2, color: pick() });
  }));
  const P = (kind: PropKind, dx: number, z: number, yaw = 0) => SHIP_DECK_PROPS.push({ kind, x: S.x + dx, z, yaw, y: y0 });
  const B = SHIP_BAYS, end = 6.1 + 0.75;
  // aft plaza: a crate stack against the bay-0 row −1 box (a jump up onto its roof: a perch over the aisle), low cover
  P("crate-stack", -2.6, B[0] + end); P("crate", 3.4, B[1] + 2.4, 0.3); P("drum-pallet", 0.9, B[1] - 2.9); P("lashing-cage", -5.4, B[1] + 3.0, Math.PI / 2);
  // aisle breakers: a 1 m crate in the 2.8 m aisle (vault it or crouch behind it) — the 100 m aisle is not one sightline
  P("crate", 0, B[3] - 1.5); P("crate", 0, B[6] + 1.0);
  // mid plaza: the step onto the bay-3 row +1 roof, cover islands
  P("crate-stack", 2.6, B[3] + end); P("pallet-stack", -4.2, B[4] - 1.2, 0.2); P("spool", -0.9, B[4] + 3.3, Math.PI / 2); P("crate", 5.8, B[4] - 3.4);
  // fore plaza
  P("crate-stack", -3.2, B[7] - 2.4); P("crate-stack", 3.0, B[7] + 1.6); P("drum-pallet", 5.2, B[7] - 3.4); P("crate", -5.6, B[7] + 2.6);
  PROPS.push(...SHIP_DECK_PROPS);
}
/** the forecastle's V breakwater (ship.ts: two 1.6 m walls from the sides 7 m out to the centre line, 3 m forward) as
 *  yawed WORLD boxes — hard cover across the bow */
function forecastleBreakwater(): Box[] {
  const S = SHIP, z0 = FC_FRONT - 4;
  return [-1, 1].map((sd) => {
    const ax = S.x + sd * 7, az = z0 + 7, cx = S.x, cz = z0 + 10, L = dmath.hypot(cx - ax, cz - az);
    return yawBoxWorld((ax + cx) / 2, FC_DECK, (az + cz) / 2, L / 2, 0.8, 0.13, dmath.atan2(-(cz - az), cx - ax), "metal");
  });
}
/** ship access + safety colliders (harbor-local boxes): hatch covers, deck-edge rails (noShoot), the forecastle deck at its
 *  drawn height + its bulwarks + stair, the gangways' treads + side rails, the seaward ladders, the quay water stairs */
function shipAccessBoxes(): Box[] {
  const S = SHIP, out: Box[] = [];
  const bx = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, surf: Box["surf"], noShoot = false): void => {
    const b: Box = { c: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], h: [(x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2], surf };
    if (noShoot) b.noShoot = true;
    out.push(b);
  };
  for (const bz of SHIP_BAYS) { const h = shipHatch(bz); bx(S.x - h.hw, S.x + h.hw, S.deckY, S.deckY + SHIP_HATCH_H, bz - h.hl, bz + h.hl, "metal"); }
  // deck-edge rails (1.05 m, see-through: players stop, bullets pass) — gaps where the gangways and ladders arrive
  const gapsW = GANGWAYS.map((g) => g.b[2]), gapsE = SEA_LADDERS.map((l) => l.zTop);
  for (let z = S.z - S.length / 2 + 1.2; z < FC_FRONT - 0.3; z += 2) {
    // (on the hull collider: ±beam/2 amidships, ±(beam/2 − 1.5) over the stern block — the drawn deck flares a little wider)
    const z1 = Math.min(z + 2, FC_FRONT - 0.3), zc = (z + z1) / 2, h = Math.min(shipDeckHalf(zc), z < S.z - S.length / 2 + 14 ? S.beam / 2 - 1.5 : S.beam / 2) - 0.14;
    if (h < 3) continue;
    // (a gangway crosses the deck edge over its last ~5 m: the gap runs from there to just past its head)
    if (!gapsW.some((g) => zc > g - 6.2 && zc < g + 2.2)) bx(S.x - h - 0.06, S.x - h + 0.06, S.deckY, S.deckY + 1.05, z, z1, "metal", true);
    if (!gapsE.some((g) => Math.abs(zc - g) < 1.8)) bx(S.x + h - 0.06, S.x + h + 0.06, S.deckY, S.deckY + 1.05, z, z1, "metal", true);
  }
  // the forecastle: its deck where it is drawn (was a block 1.2 m above it, 3.5 m short of each side: you walked on air
  // over the bulwark line and fell through the drawn deck into the sea), its bulwarks, the stair
  const zb = S.z + S.length / 2 - 1.2;
  for (let z = FC_FRONT; z < zb; z += 2) {
    const z1 = Math.min(z + 2, zb), h = Math.min(shipDeckHalf(z), shipDeckHalf(z1)) - 0.3;
    if (h < 1) continue;
    bx(S.x - h, S.x + h, S.deckY, FC_DECK, z, z1, "metal");
    for (const sd of [-1, 1]) bx(S.x + sd * h - 0.12, S.x + sd * h + 0.12, FC_DECK, S.forecastle.top, z, z1, "metal");
  }
  for (const st of fcStair()) bx(S.x - st.hw, S.x + st.hw, S.deckY, st.y1, st.z0, st.z1, "metal");
  // the forecastle's fittings collide like they are drawn (ship.ts forecastle — they were walk-through scenery while
  // the deck was unreachable): the V breakwater (1.6 m: hard cover across the bow), the two windlasses, the bollards and
  // the bow mast
  { const fy = FC_DECK, bow = S.z + S.length / 2;
    for (const sd of [-1, 1]) {
      // (the breakwater's two diagonal walls are WORLD boxes — forecastleBreakwater, in `colliders`)
      bx(S.x + sd * 0.9 - (sd > 0 ? 0 : 2.6), S.x + sd * 0.9 + (sd > 0 ? 2.6 : 0), fy, fy + 1.55, bow - 9.1, bow - 6.9, "metal");
      for (const bz of [bow - 11.5, bow - 4]) bx(S.x + sd * 6.35 - 0.65, S.x + sd * 6.35 + 0.65, fy, fy + 0.8, bz - 0.3, bz + 0.3, "metal");
    }
    bx(S.x - 0.3, S.x + 0.3, fy, fy + 9.5, bow - 4.3, bow - 3.7, "metal"); }
  // the stern mooring deck's winch drums (1.4 m: cover) + bollards (ship.ts superstructure)
  { const sz = S.z - S.length / 2;
    for (const sd of [-1, 1]) {
      bx(Math.min(S.x + sd * 2, S.x + sd * 4), Math.max(S.x + sd * 2, S.x + sd * 4), S.deckY, S.deckY + 1.4, sz + 4.4, sz + 5.6, "metal");
      for (const bz of [sz + 2.5, sz + 8]) bx(S.x + sd * 8 - 0.3, S.x + sd * 8 + 0.3, S.deckY, S.deckY + 0.8, bz - 0.3, bz + 0.3, "metal");
    } }
  // (the hull block ended at z 373 and the bow block began at 375: a 2 m slot through the deck at the forecastle break)
  { const h = Math.min(shipDeckHalf(372), shipDeckHalf(FC_FRONT + 0.5)); bx(S.x - h, S.x + h, S.keelY, S.deckY, 372, FC_FRONT + 0.5, "metal"); }
  // the gangways: treads (axis-aligned: they run almost straight along z) + a railing each side (noShoot)
  for (const G of GANGWAYS) {
    const [ax, ay, az] = G.a, [gx, gy, gz] = G.b, n = Math.ceil((gy - ay) / 0.3);
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n, x = ax + (gx - ax) * t, y = ay + (gy - ay) * ((k + 1) / n), z0 = az + (gz - az) * (k / n) - 0.03, z1 = az + (gz - az) * ((k + 1) / n) + 0.03;
      bx(x - G.w / 2, x + G.w / 2, y - 0.2, y, z0, z1, "metal");
      // (no inboard rail once the treads reach over the hull: below the deck the hull side is the wall, at the top you
      // step off sideways onto the deck)
      for (const sd of [-1, 1]) { const rx = x + sd * (G.w / 2 + 0.03); if (sd > 0 && rx > S.x - S.beam / 2 - 0.2) continue; bx(rx - 0.05, rx + 0.05, y, y + 1.0, z0, z1, "metal", true); }
    }
  }
  // the seaward ladders: a landing stage at the waterline, 0.33 m treads up the hull to the deck, the outboard rail
  for (const L of SEA_LADDERS) {
    const x0 = S.x + S.beam / 2 + 0.05, x1 = x0 + 1.6, n = Math.ceil((S.deckY - WATER_STEP_Y) / 0.33), dir = Math.sign(L.zTop - L.zBot), run = (L.zTop - L.zBot) / n;
    bx(x0, x1 + 1.0, WATER_STEP_Y - 0.4, WATER_STEP_Y, Math.min(L.zBot, L.zBot - dir * 2.4), Math.max(L.zBot, L.zBot - dir * 2.4), "metal");
    for (let k = 1; k <= n; k++) {
      const za = L.zBot + run * (k - 1), zc = L.zBot + run * k, y = WATER_STEP_Y + (S.deckY - WATER_STEP_Y) * (k / n);
      bx(x0, x1, y - 0.15, y, Math.min(za, zc) - 0.02, Math.max(za, zc) + 0.02, "metal");
      bx(x1, x1 + 0.08, y, y + 1.0, Math.min(za, zc), Math.max(za, zc), "metal", true);
    }
  }
  for (const q of QUAY_STAIRS) quayStairTreads(q).forEach(([x0, x1, y0, y1, z0, z1], k) => {
    bx(x0, x1, y0, y1, z0, z1, "concrete");
    // the railing along the open side (access.ts draws it) — not on the two foot treads: a swimmer boards from the side
    if (k < 2) return;
    if (q.along === "z") { const rx = q.out > 0 ? x1 - 0.06 : x0 + 0.06; bx(rx - 0.05, rx + 0.05, y1, y1 + 1.0, z0, z1, "metal", true); }
    else { const rz = q.out > 0 ? z1 - 0.06 : z0 + 0.06; bx(x0, x1, y1, y1 + 1.0, rz - 0.05, rz + 0.05, "metal", true); }
  });
  return out;
}


// ---------------------------------------------------------------- colliders + clearings (derived, LOCAL → WORLD at the end)
function apronBoxes(): Box[] {
  // interior: strips along z spanning the polygon's x-range at that strip (the MIN over the strip, so it never pokes
  // past a diagonal edge). 6 m strips only where the edges are straight across the strip, else 1 m — 6 m strips
  // + 2.4 m tiles leave holes along the diagonal quay (a kong falls through the slab onto the sand below) and the
  // tiles stand 1.2 m proud of the quay face. The diagonal edges get exact yawed boxes (apronEdgeBoxes, world space).
  const cy = (APRON_Y + APRON_BOTTOM) / 2, hy = (APRON_Y - APRON_BOTTOM) / 2;
  const out: Box[] = [];
  // (2 cm inside the drawn slab's straight z edges — rays exactly on the edge find no drawn floor)
  const zMin = Math.min(...APRON.map((p) => p[1])) + 0.02, zMax = Math.max(...APRON.map((p) => p[1])) - 0.02;
  const span = (zz: number): [number, number] | null => {
    const xs: number[] = [];
    for (let i = 0, j = APRON.length - 1; i < APRON.length; j = i++) {
      const [xi, zi] = APRON[i], [xj, zj] = APRON[j];
      if ((zi > zz) !== (zj > zz)) xs.push(xi + ((xj - xi) * (zz - zi)) / (zj - zi));
    }
    xs.sort((a, b) => a - b);
    return xs.length < 2 ? null : [xs[0], xs[xs.length - 1]];
  };
  const strip = (z0: number, z1: number) => {
    let lo = -Infinity, hi = Infinity;
    for (let k = 0; k <= 4; k++) { const sp = span(z0 + 0.01 + ((z1 - z0 - 0.02) * k) / 4); if (!sp) return; lo = Math.max(lo, sp[0]); hi = Math.min(hi, sp[1]); }
    if (hi - lo > 0.5) out.push({ c: [(lo + hi) / 2, cy, (z0 + z1) / 2], h: [(hi - lo) / 2, hy, (z1 - z0) / 2], surf: "concrete" });
  };
  for (let z0 = zMin; z0 < zMax - 1e-6; z0 += 6) {
    const z1 = Math.min(zMax, z0 + 6), a = span(z0 + 0.01), b = span(z1 - 0.01);
    if (a && b && Math.abs(a[0] - b[0]) < 0.05 && Math.abs(a[1] - b[1]) < 0.05) { strip(z0, z1); continue; }
    for (let z = z0; z < z1 - 1e-6; z += 1) strip(z, Math.min(z1, z + 1));
  }
  return out;
}
/** the diagonal quay edges: one yawed WORLD box per edge, its outer face exactly on the edge, 3.2 m deep inward */
function apronEdgeBoxes(): Box[] {
  const cy = (APRON_Y + APRON_BOTTOM) / 2, hy = (APRON_Y - APRON_BOTTOM) / 2, D = 3.2, out: Box[] = [];
  for (let i = 0; i < APRON.length; i++) {
    const [ax, az] = APRON[i], [bx, bz] = APRON[(i + 1) % APRON.length];
    if (Math.abs(ax - bx) < 0.01 || Math.abs(az - bz) < 0.01) continue;
    const len = dmath.hypot(bx - ax, bz - az), ux = (bx - ax) / len, uz = (bz - az) / len;
    let nx = -uz, nz = ux;
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    if (!onApron(mx + nx, mz + nz)) { nx = -nx; nz = -nz; }
    const [wx, wz] = toWorld(mx + nx * D / 2, mz + nz * D / 2), [w0x, w0z] = toWorld(ax, az), [w1x, w1z] = toWorld(bx, bz);
    out.push({ c: [wx, cy, wz], h: [len / 2, hy, D / 2], yaw: dmath.atan2(w1z - w0z, w1x - w0x), surf: "concrete" });
  }
  return out;
}

/** the edge furniture drawn ON the slab (apron.ts): the berth's hazard capping beam (0.9 × 0.45 m),
 *  the plain capping on the other water edges (0.8 × 0.3) and the raised kerb on the land edges (0.4 × 0.24) — each
 *  a step (≤ STEP_H), so feet don't sink into them. WORLD boxes. */
function cappingBoxes(): Box[] {
  const out: Box[] = [];
  for (let i = 0; i < APRON.length; i++) {
    const [ax, az] = APRON[i], [bx, bz] = APRON[(i + 1) % APRON.length], len = dmath.hypot(bx - ax, bz - az);
    const dx = (bx - ax) / len, dz = (bz - az) / len;
    let nx = dz, nz = -dx;
    if (onApron((ax + bx) / 2 + nx, (az + bz) / 2 + nz)) { nx = -nx; nz = -nz; }
    const rot = dmath.atan2(-dz, dx), mx = (ax + bx) / 2, mz = (az + bz) / 2;
    const [w, h, L] = BERTH_EDGES.includes(i) ? [0.9, 0.45, len - 0.2] : WATER_EDGES.includes(i) ? [0.8, 0.3, len] : [0.4, 0.24, len];
    // (outer face 4 cm inside the drawn edge: probe rays exactly on the slab's edge line found no drawn surface)
    out.push(yawBoxWorld(mx - nx * (w / 2 + 0.01), APRON_Y - 0.03, mz - nz * (w / 2 + 0.01), L / 2, (h + 0.03) / 2 - 0.01, w / 2 - 0.03, rot, "concrete"));
  }
  return out;
}
/** warehouse-local (length x, width z) → harbor-local */
export function whToWorld(w: WarehouseSpec, lx: number, lz: number): [number, number] {
  const c = dmath.cos(w.yaw), s = dmath.sin(w.yaw);
  return [w.x + lx * c + lz * s, w.z - lx * s + lz * c];
}
export function archY(w: WarehouseSpec, lz: number): number {
  const hw = w.width / 2, R = (hw * hw + w.rise * w.rise) / (2 * w.rise);
  const dz = Math.min(hw, Math.abs(lz));
  return w.wallH + Math.sqrt(Math.max(0, R * R - dz * dz)) - (R - w.rise);
}
export function doorCentres(w: WarehouseSpec): number[] {
  return [...Array(w.doors)].map((_, i) => (i - (w.doors - 1) / 2) * DOORS.pitch);
}

/** an axis-aligned harbor-local box from warehouse-local centre + half extents (warehouse yaws are multiples of π/2) */
function whBox(w: WarehouseSpec, lx: number, lz: number, hx: number, hy: number, hz: number, y0: number, surf: Box["surf"]): Box {
  const [x, z] = whToWorld(w, lx, lz);
  const swap = Math.abs(dmath.sin(w.yaw)) > 0.5;
  return { c: [x, y0 + hy, z], h: swap ? [hz, hy, hx] : [hx, hy, hz], surf };
}
/** the arched roof's collider steps (warehouse-local z bands from the ridge out past the eave): each band's rise ≤ 0.3 m,
 *  its top = the arch at the band's middle + the sheet (walkable from the eave to the ridge; 6 coarse steps would
 *  stand up to 2.7 m proud of the eave and not be walkable) */
export function roofBands(w: WarehouseSpec): Array<{ z0: number; z1: number; top: number; bot: number }> {
  const hw = w.width / 2, out: Array<{ z0: number; z1: number; top: number; bot: number }> = [];
  let z = 0;
  while (z < hw - 1e-3) {
    let z1 = Math.min(hw, z + 3);
    // (≤ 0.12 m per band and the top ON the arch at the band's middle — the drawn sheet (28 chords, no offset)
    // stays within ±0.08 m of the walkable top; a +0.08 lift leaves it 0.15–0.17 m under the band at the edges)
    while (z1 - z > 0.08 && archY(w, z) - archY(w, z1) > 0.12) z1 = z + (z1 - z) * 0.85;
    if (hw - z1 < 0.1) z1 = hw;
    out.push({ z0: z, z1, top: archY(w, (z + z1) / 2) + 0.02, bot: archY(w, z1) - 0.35 });
    z = z1;
  }
  out[out.length - 1].z1 = hw + 0.05;
  return out;
}
/** warehouse interior + roof access (every building a real playable building), warehouse-local, y above the
 *  floor. Site office at the −x gable (tall single storey, its roof = the mezzanine at rack-top height), a stair up to
 *  the mezzanine along the office front, a bridge onto the −z rack tops, a catwalk across to the +z rack, and a fire-
 *  escape stair on the +z long wall up to the eave (the roof collider is walkable from there to the ridge). */
export const WH = { officeD: 4.4, officeZ1: -3.6, deckY: RACK_TOP(), deckZ0: -9.4, stairW: 1.2, fireX0: 2.95 };
function RACK_TOP() { return 5.0; }
export function warehouseLocalPieces(w: WarehouseSpec): Piece[] {
  const hl = w.length / 2, hw = w.width / 2, t = 0.35, out: Piece[] = [];
  const X0 = -hl + t, X1 = X0 + WH.officeD, Z0 = -hw + t, Z1 = WH.officeZ1, D = WH.deckY, SW = WH.stairW;
  // ---- the office: +x front (door-less: the stair runs along it), +z face with the door + a window, the gable and the
  // side wall are the shed's own walls; ceiling slab = the mezzanine deck
  out.push(...wallRun("z", Z0, Z1, X1 - 0.1, 0, D - 0.3, 0.2, "wallIn", [{ a0: -9.7, a1: -8.1, y0: 1.0, y1: 2.2, kind: "window" }]));
  out.push(...wallRun("x", X0, X1, Z1 + 0.1, 0, D - 0.3, 0.2, "wallIn", [{ a0: X1 - 1.75, a1: X1 - 0.55, y0: 0, y1: 2.3, kind: "door" }, { a0: X0 + 0.7, a1: X0 + 2.3, y0: 1.0, y1: 2.2, kind: "window" }]));
  out.push(slabXYZ(X0, X1, D - 0.3, D, Z0, Z1 + 0.2, "floor", { kind: "panel" }));
  // (the office furniture comes from the shared interiors kit — INTERIOR_ROOMS below)
  // ---- the mezzanine stair: up the central aisle toward the office, topping out onto the deck at z ≈ −4.6
  const SZ = -4.6, run = Math.ceil(D / 0.25 - 1e-6) * 0.3;
  out.push(...flight("x", X1 + run, SZ, -1, 0, D, run, SW, "steel", 2.4));
  // deck rails: +z edge; +x edge except where the bridge and the stair meet it
  // (interior rails are visual only: a covered rail top is a 'floor' only a jump reaches — the scanner's jump-only)
  const vis = (p: Piece): Piece => ({ ...p, solid: false });
  out.push(vis(railRun(X0, Z1 + 0.2, X1, Z1 + 0.2, D)));
  out.push(vis(railRun(X1, Z0 + 0.2, X1, -7.95, D)), vis(railRun(X1, -6.45, X1, SZ - SW / 2 - 0.1, D)), vis(railRun(X1, SZ + SW / 2 + 0.1, X1, Z1 + 0.2, D)));
  // ---- bridge onto the −z rack top; a catwalk across the shed at the racks' far (+x) end joins the +z rack
  const rz0 = RACK.rowsZ[0], rz1 = RACK.rowsZ[1], rx0 = -RACK.length / 2, rx1 = RACK.length / 2, rd = RACK.depth / 2;
  out.push(slabXYZ(X1, rx0, D - 0.15, D, rz0 - rd, rz0 + rd, "grate", { kind: "landing" }));
  out.push(slabXYZ(rx1 - 1.0, rx1, D - 0.15, D, rz0 + rd, rz1 - rd, "grate", { kind: "landing" }));
  out.push(vis(railRun(rx1 + 0.05, rz0 + rd + 0.05, rx1 + 0.05, rz1 - rd - 0.05, D)), vis(railRun(rx1 - 1.05, rz0 + rd + 0.05, rx1 - 1.05, -1.0, D)), vis(railRun(rx1 - 1.05, 1.0, rx1 - 1.05, rz1 - rd - 0.05, D)));
  // ---- fire escape: the +z long wall, outside, from beside the middle door up to the eave; a landing onto the roof
  const bands = roofBands(w), eave = bands[bands.length - 1].top, nF = Math.ceil(eave / 0.25 - 1e-6), fx1 = WH.fireX0 + nF * 0.3;
  out.push(...flight("x", WH.fireX0, hw + 0.1 + SW / 2, 1, 0, eave, nF * 0.3, SW, "steel", 2.4));
  out.push(slabXYZ(fx1, fx1 + 1.5, eave - 0.2, eave, hw + 0.05, hw + 0.1 + SW, "steel", { kind: "landing" }));
  out.push(railRun(fx1 + 1.5, hw + 0.1, fx1 + 1.5, hw + 0.1 + SW, eave), railRun(fx1, hw + 0.1 + SW, fx1 + 1.5, hw + 0.1 + SW, eave));
  // steel posts carrying the landing + the upper flight (outer side) down to the slab
  for (const px of [fx1 + 1.4, fx1 - 0.1, (WH.fireX0 + fx1) / 2 + 1.2]) { const top = Math.min(eave - 0.2, ((px - WH.fireX0) / (fx1 - WH.fireX0)) * eave - 0.2); out.push(slabXYZ(px - 0.07, px + 0.07, 0, top, hw + 0.1 + SW - 0.14, hw + 0.1 + SW, "steel", { kind: "post" })); }
  return out;
}
/** warehouse pieces in HARBOR-LOCAL coordinates (y absolute) */
export function warehousePieces(w: WarehouseSpec): Piece[] {
  const f: QFrame = { x: w.x, y: APRON_Y, z: w.z, yaw: w.yaw };
  return warehouseLocalPieces(w).map((p) => qPiece(f, p));
}
/** mid-floor cover in every hall — pallet blocks, a parked forklift at work, crate + drum
 *  stacks in the central aisle and along the strips behind the racks (clear of every door lane, the office stair and
 *  the bays). WAREHOUSE-LOCAL (x along the length, z across, yaw relative to the shed); drawn by warehouse.ts with the
 *  indoor materials, colliders = the props' own (PROP_MEMBERS / PROP_FOOT) through hallPropBoxes. */
export function hallProps(w: WarehouseSpec): PropSpec[] {
  const out: PropSpec[] = [];
  const k = WAREHOUSES.indexOf(w), flip = k % 2 ? -1 : 1;     // alternate the layout so no two halls read the same
  const P = (kind: PropKind, x: number, z: number, yaw = 0, load?: PalletLoad) => out.push({ kind, x, z: z * flip, yaw: yaw * flip, load });
  // aisle island 1: a 2 × 2 block of banana pallet stacks (1.9 m) with a loose pallet + drum pallet beside it
  for (const [dx, dz] of [[0, 0], [1.25, 0], [0, 1.08], [1.25, 1.08]]) P("pallet-stack", -6.6 + dx, 1.6 + dz, 0, dx ? "bananas" : "boxes");
  P("drum-pallet", -4.4, 2.1, 0.2); P("pallet", -8.4, 1.9, 0.1, "slatted");
  // aisle island 2: a forklift putting away a pallet stack, a second stack waiting
  P("forklift", 3.4, -2.4, Math.PI); P("pallet-stack", 1.4, -2.4, 0, "crates"); P("pallet-stack", 1.4, -3.65, 0.05, "bananas");
  // aisle island 3: crate stacks + a drum pallet
  P("crate-stack", 9.6, 2.2, 0.1); P("crate-stack", 9.7, 3.5, -0.05); P("drum-pallet", 8.2, 2.4, 0); P("crate", 11.0, 2.4, 0.3);
  // the strips behind the racks (between the long-wall doors): a crate stack + a drum pallet against the wall, both sides
  for (const sz of [-1, 1]) { P("crate-stack", 8.5, sz * 10.0, 0.05); P("drum-pallet", -8.0, sz * 10.0, 0); }
  return out;
}
/** the x of the steel portal columns under the roof arches (the arches stand every 6 m from −hl + 3): between the
 *  door openings and clear of the office / end bays (|x| ≤ hl − 6) */
export function hallColumns(w: WarehouseSpec): number[] {
  const hl = w.length / 2, out: number[] = [];
  for (let x = -hl + 3; x < hl; x += 6) if (Math.abs(x) <= hl - 6 && !doorCentres(w).some((c) => Math.abs(x - c) < DOORS.hw + 0.5)) out.push(x);
  return out;
}
/** a hall prop → its harbor-local spec (frame of the shed) */
export function hallToLocal(w: WarehouseSpec, p: PropSpec): PropSpec {
  const [x, z] = whToWorld(w, p.x, p.z);
  return { ...p, x, z, yaw: p.yaw + w.yaw, y: APRON_Y };
}
function hallPropBoxes(w: WarehouseSpec): Box[] {
  return hallProps(w).flatMap((p) => propBoxes(hallToLocal(w, p)));
}
export function warehouseBoxes(w: WarehouseSpec): Box[] {
  const hl = w.length / 2, hw = w.width / 2, t = 0.35;
  const out: Box[] = [];
  const dc = doorCentres(w);
  for (const side of [1, -1]) {
    const lz = side * (hw - t / 2);
    const edges = [-hl, ...dc.flatMap((c) => [c - DOORS.hw, c + DOORS.hw]), hl];
    for (let i = 0; i < edges.length; i += 2) {
      const a = edges[i], b = edges[i + 1];
      if (b - a > 0.05) out.push(whBox(w, (a + b) / 2, lz, (b - a) / 2, w.wallH / 2, t / 2, APRON_Y, "concrete"));

    }
    for (const c of dc) out.push(whBox(w, c, lz, DOORS.hw, (w.wallH - DOORS.h) / 2, t / 2, APRON_Y + DOORS.h, "concrete"));
    // the downpipes at both ends of the long walls + the gutter along the eave (warehouse.ts)
    for (const e of [-1, 1]) out.push(whBox(w, e * (hl - 0.6), side * (hw + 0.3), 0.07, w.wallH / 2 - 0.05, 0.07, APRON_Y + 0.1, "metal"));
    out.push(whBox(w, 0, side * (hw + 0.28), hl + 0.6, 0.11, 0.13, APRON_Y + w.wallH - 0.06, "metal"));
    // the blue corner pilasters (0.4 wide, 12 cm proud of both faces)
    for (const e of [-1, 1]) out.push(whBox(w, e * (hl - 0.15), side * (hw - t / 2 + 0.05), 0.2, w.wallH / 2, (t + 0.14) / 2, APRON_Y, "metal"));
    // the door jamb trims stand 13 cm proud of the wall face
    for (const c of dc) for (const e of [-1, 1]) out.push(whBox(w, c + e * (DOORS.hw + 0.12), side * (hw + 0.065), 0.13, DOORS.h / 2, 0.065, APRON_Y, "metal"));
  }
  // arched roof: walkable bands (≤ 0.3 m rise each) on both sides of the ridge
  for (const b of roofBands(w)) for (const side of [1, -1]) out.push(whBox(w, 0, side * (b.z0 + b.z1) / 2, hl, (b.top - b.bot) / 2, (b.z1 - b.z0) / 2 + 0.02, APRON_Y + b.bot, "metal"));
  // the galvanised ridge cap (drawn 0.8 m wide, 0.38 m proud of the ridge) is walkable too
  out.push(whBox(w, 0, 0, hl - 2, 0.3, 0.4, APRON_Y + w.wallH + w.rise - 0.22, "metal"));
  for (const e of [1, -1]) {
    // (the gable follows the arch in 1 m strips, top = the arch at the strip's outer edge — two side blocks up
    // to the RIDGE height would stand through the roof sheet near the eaves)
    const lx = e * (hl - t / 2);
    for (const sg of [-1, 1]) for (let z0 = END_DOOR.hw; z0 < hw - 1e-3; z0 += 1.0) {
      const z1 = Math.min(hw, z0 + 1.0), top = archY(w, z1);
      out.push(whBox(w, lx, sg * (z0 + z1) / 2, t / 2, top / 2, (z1 - z0) / 2, APRON_Y, "concrete"));
    }
    for (let z0 = -END_DOOR.hw; z0 < END_DOOR.hw - 1e-3; z0 += 1.3) {
      const z1 = Math.min(END_DOOR.hw, z0 + 1.3), top = archY(w, Math.max(Math.abs(z0), Math.abs(z1)));
      out.push(whBox(w, lx, (z0 + z1) / 2, t / 2, (top - END_DOOR.h) / 2, (z1 - z0) / 2, APRON_Y + END_DOOR.h, "concrete"));
    }
  }
  for (const rz of RACK.rowsZ) out.push(whBox(w, 0, rz, RACK.length / 2, RACK.height / 2, RACK.depth / 2, APRON_Y, "metal"));
  // the portal columns along both long walls (I-sections, 0.32 × 0.25)
  for (const cx of hallColumns(w)) for (const sz of [-1, 1]) out.push(whBox(w, cx, sz * (hw - 0.35 - 0.13), 0.17, w.wallH / 2, 0.13, APRON_Y, "metal"));
  // the yellow end-of-aisle protectors at both rack ends
  for (const rz of RACK.rowsZ) for (const e of [-1, 1]) out.push(whBox(w, e * (RACK.length / 2 + 0.16), rz, 0.1, 0.45, RACK.depth / 2 + 0.15, APRON_Y, "metal"));
  out.push(...warehousePieces(w).filter((p) => p.solid !== false).map(pieceBox));
  return out;
}

// ---------------------------------------------------------------- small buildings (pieces → visuals + colliders)
/** the pump house by the tank farm: a door on the −x face, a window toward the tanks, two pumps + a control panel
 *  inside, a steel stair up the −z face to the roof (harbor-local, y absolute) */
export function pumpHousePieces(): Piece[] {
  const P = PUMP_HOUSE, H = P.h, out: Piece[] = [];
  out.push(...hutPieces(P.w, P.d, H, [
    { side: "-x", a: 0, w: 1.3, y0: 0, y1: 2.4, kind: "door" },
    { side: "+z", a: 0, w: 2.4, y0: 1.9, y1: 3.1, kind: "window" },
    { side: "+x", a: -1.2, w: 1.6, y0: 1.2, y1: 2.4, kind: "window" },
  ], { roof: "concrete" }));
  // (the two pump sets are modelled by tanks.ts pumpSet(); their colliders are pumpSetBoxes)
  // (the rest of the room — workbench, lockers, crates — is the interiors kit's workshop, INTERIOR_ROOMS)
  // roof stair along the −z face (outside): foot at the +x end, up toward −x, step onto the roof
  const top = H + 0.25, n = Math.ceil(top / 0.25 - 1e-6), run = n * 0.3;
  out.push(...flight("x", P.w / 2 + 0.2, -P.d / 2 - 0.65, -1, 0, top, run, 1.2, "steel", 2.4));
  out.push(railRun(-P.w / 2, P.d / 2, P.w / 2, P.d / 2, top), railRun(-P.w / 2, -P.d / 2, -P.w / 2, P.d / 2, top), railRun(P.w / 2, -P.d / 2, P.w / 2, P.d / 2, top));
  out.push(railRun(P.w / 2 + 0.2 - run - 0.05, -P.d / 2 - 1.3, P.w / 2 + 0.2 - run - 0.05, -P.d / 2, top));
  const f: QFrame = { x: P.x, y: APRON_Y, z: P.z, yaw: 0 };
  return out.map((p) => qPiece(f, p));
}
/** the pump house's two horizontal centrifugal pump sets (house-local x centres; skid along
 *  x, z centre PUMP_Z) and their discharge lines: a riser from each volute up through the roof, a run over the roof
 *  (on sleepers) to the PIPE_RACK's end pipes. House-local coordinates, y from the floor. tanks.ts draws them. */
export const PUMP_SETS = [-1.35, 1.55], PUMP_Z = 1.9, PUMP_PIPE_Y = 5.0;
export function pumpRiser(i: number): Array<[number, number, number]> {
  const x = PUMP_SETS[i] + 0.55, tx = i === 0 ? -0.7 : 0.7, y = PUMP_PIPE_Y;
  return [[x, 0.98, PUMP_Z], [x, y, PUMP_Z], [tx, y, PUMP_Z], [tx, y, 3.75]];
}
/** the pump sets + discharge lines as WORLD boxes */
function pumpSetBoxes(): Box[] {
  const P = PUMP_HOUSE, roof = P.h + 0.25, out: Piece[] = [];
  PUMP_SETS.forEach((x, i) => {
    out.push(slabXYZ(x - 1.0, x + 1.0, 0, 0.98, PUMP_Z - 0.45, PUMP_Z + 0.45, "machine"));
    // (a no-shoot drop from the ceiling to 1.2 m over the set: its top is no covered ledge a jump reaches — scanner)
    out.push(slabXYZ(x - 1.0, x + 1.0, 2.2, P.h, PUMP_Z - 0.45, PUMP_Z + 0.45, "machine", { noShoot: true }));
    const [a, b, c, d] = pumpRiser(i), r = 0.17;
    out.push(slabXYZ(a[0] - r, a[0] + r, 0.98, b[1] + r, a[2] - r, a[2] + r, "steel"));
    out.push(slabXYZ(Math.min(b[0], c[0]) - r, Math.max(b[0], c[0]) + r, roof, b[1] + r, b[2] - r, b[2] + r, "steel"));
    out.push(slabXYZ(c[0] - r, c[0] + r, roof, c[1] + r, c[2] - r, P.d / 2, "steel"));
    out.push(slabXYZ(c[0] - r, c[0] + r, c[1] - r, c[1] + r, P.d / 2, d[2], "steel"));
  });
  const f: QFrame = { x: P.x, y: APRON_Y, z: P.z, yaw: 0 };
  return out.map((p) => boxToWorld(pieceBox(qPiece(f, p))));
}
/** the pipe rack's portal posts, footings and cross beams (tanks.ts) — WORLD boxes */
function pipeRackBoxes(): Box[] {
  const out: Box[] = [], pts = PIPE_RACK.pts, top = APRON_Y + PIPE_RACK.y;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i], [cx, cz] = pts[i + 1], len = dmath.hypot(cx - ax, cz - az), n = Math.max(1, Math.round(len / 6));
    const ux = (cx - ax) / len, uz = (cz - az) / len, px = -uz, pz = ux;
    for (let k = 0; k <= n; k++) {
      const fx = ax + (cx - ax) * (k / n), fz = az + (cz - az) * (k / n);
      for (const sg of [-1, 1]) out.push(boxToWorld({ c: [fx + px * sg * 1.1, (APRON_Y + top) / 2, fz + pz * sg * 1.1], h: [0.125, (top - APRON_Y) / 2, 0.125], surf: "metal" }));
      out.push(boxToWorld({ c: [fx, APRON_Y + 0.15, fz], h: [(Math.abs(px) * 2.6 + 0.6) / 2, 0.15, (Math.abs(pz) * 2.6 + 0.6) / 2], surf: "concrete" }));
      out.push(boxToWorld({ c: [fx, top, fz], h: [Math.abs(px) * 1.3 + Math.abs(ux) * 0.15, 0.15, Math.abs(pz) * 1.3 + Math.abs(uz) * 0.15], surf: "metal" }));
    }
  }
  return out;
}
/** the weighbridge scale house (gate): door on −x with steps, a counter + console inside, windows all round */
export function scaleHouseLocalPieces(): Piece[] {
  const out = hutPieces(6.2, 4.2, 3.0, [
    { side: "-x", a: -0.9, w: 1.1, y0: 0, y1: 2.2, kind: "door" },
    { side: "+z", a: 0.6, w: 3.2, y0: 1.2, y1: 2.4, kind: "window" }, { side: "-z", a: 0.6, w: 3.2, y0: 1.2, y1: 2.4, kind: "window" },
    { side: "+x", a: 0, w: 2.4, y0: 1.2, y1: 2.4, kind: "window" },
  ], { roof: "trim" });
  // (furnished by the interiors kit — a weighbridge office, INTERIOR_ROOMS)
  return out;
}
/** a gate booth: glazed on three sides, door on −x */
export function boothLocalPieces(): Piece[] {
  const out = hutPieces(2.3, 2.3, 2.4, [
    { side: "-x", a: 0, w: 1.0, y0: 0, y1: 2.15, kind: "door" },
    { side: "+x", a: 0, w: 1.6, y0: 1.0, y1: 2.1, kind: "window" }, { side: "+z", a: 0, w: 1.6, y0: 1.0, y1: 2.1, kind: "window" }, { side: "-z", a: 0, w: 1.6, y0: 1.0, y1: 2.1, kind: "window" },
  ], { t: 0.12, rt: 0.18, roof: "yellow" });
  out.push(slabXYZ(0.35, 1.03, 0, 0.9, -0.9, 0.9, "desk", { kind: "desk" }));
  return out;
}
/** crane machinery house on the backreach: hollow, door on −z by the stair landing, hoist machinery inside, a stair up
 *  the +x end to the railed roof; the operator cab under the trolley reached by a stair down from the +z walkway */
export function cranePieces(cz: number, idx: number): Piece[] {
  const C = CRANE, H = C.house, out: Piece[] = [];
  const hw = H.halfZ, L = H.x1 - H.x0, hh = H.y1 - H.y0;
  const house = hutPieces(L, 2 * hw, hh, [
    { side: "-z", a: L / 2 - 3, w: 1.2, y0: 0, y1: 2.3, kind: "door" },
    { side: "-z", a: -L / 2 + 6.2, w: 1.6, y0: 1.4, y1: 2.5, kind: "window" }, { side: "+z", a: -L / 2 + 14.2, w: 1.6, y0: 1.4, y1: 2.5, kind: "window" },
    { side: "-x", a: 0, w: 2.0, y0: 1.4, y1: 2.5, kind: "window" },
  ], { wall: "yellow", roof: "yellow", rt: 0.24, floor: "deckPlate" });
  // (hoist drums + trolley drive: big machinery up to 1.8 m under the ceiling — no standable tops inside)
  house.push(slabXYZ(-L / 2 + 1.5, -L / 2 + 6.5, 0, hh - 1.1, -1.3, 1.3, "machine", { kind: "machine" }), slabXYZ(-L / 2 + 8, -L / 2 + 11.5, 0, hh - 1.1, -1.9, 0.4, "machine", { kind: "machine" }));
  house.push(slabXYZ(L / 2 - 1.2, L / 2 - 0.3, 0, 1.9, 0.4, 2.3, "cabinet", { kind: "console" }));
  // roof units (cover up there) + railings (a gap where the stair tops out at the +x end)
  const R = hh + 0.24;
  house.push(slabXYZ(-L / 2 + 2.7, -L / 2 + 5.3, R, R + 1.0, -2.1, -0.3, "machine", { kind: "machine" }), slabXYZ(-L / 2 + 7.4, -L / 2 + 10.6, R, R + 0.6, 0.8, 2.0, "steel"));
  house.push(railRun(-L / 2, -hw, L / 2, -hw, R), railRun(-L / 2, hw, L / 2, hw, R), railRun(-L / 2, -hw, -L / 2, hw, R), railRun(L / 2, -hw, L / 2, hw - 1.5, R));
  // the roof stair: a straight flight down the boom's girder top from the +x end (it tops out onto the roof at z ≈ +1.8)
  const n = Math.ceil(R / 0.25 - 1e-6), run = n * 0.28;
  house.push(...flight("x", L / 2 + run, hw - 0.7, -1, 0, R, run, 1.2, "steel", 2.4));
  const fh: QFrame = { x: (H.x0 + H.x1) / 2, y: H.y0, z: cz, yaw: 0 };
  out.push(...house.map((p) => qPiece(fh, p)));
  // ---- the operator cab (hangs under the trolley) + its access: a stair down from the +z walkway, a platform to the door
  const cab = C.cabin, cx = C.trolleyX[idx] + cab.dx, cy0 = cab.y0, cy1 = cab.y1;
  out.push(slabXYZ(cx - cab.halfX, cx + cab.halfX, cy0 - 0.2, cy0, cz - cab.halfZ, cz + cab.halfZ, "deckPlate", { kind: "panel" }));
  out.push(slabXYZ(cx - cab.halfX, cx + cab.halfX, cy1 - 0.15, cy1, cz - cab.halfZ, cz + cab.halfZ, "yellow", { kind: "panel" }));
  out.push(slabXYZ(cx - cab.halfX, cx - cab.halfX + 0.1, cy0, cy1 - 0.15, cz - cab.halfZ, cz + cab.halfZ, "yellow"));
  out.push(slabXYZ(cx + cab.halfX - 0.06, cx + cab.halfX, cy0, cy1 - 0.15, cz - cab.halfZ, cz + cab.halfZ, "glass", { noShoot: true }));
  out.push(slabXYZ(cx - cab.halfX + 0.1, cx + cab.halfX - 0.06, cy0, cy1 - 0.15, cz - cab.halfZ, cz - cab.halfZ + 0.06, "glass", { noShoot: true }));
  out.push(...wallRun("x", cx - cab.halfX + 0.1, cx + cab.halfX - 0.06, cz + cab.halfZ - 0.04, cy0, cy1 - 0.15, 0.08, "yellow", [{ a0: cx - 1.2, a1: cx - 0.2, y0: cy0, y1: cy0 + 2.1, kind: "door" }]));
  out.push(slabXYZ(cx + 0.3, cx + cab.halfX - 0.1, cy0, cy0 + 0.9, cz - 0.8, cz + 0.8, "cabinet", { kind: "console" }), slabXYZ(cx - 0.4, cx + 0.2, cy0, cy0 + 0.55, cz - 0.3, cz + 0.3, "cabinet", { kind: "seat" }));
  const gzO = C.girderHalfZ + 0.625 + 1.0, lane0 = cz + gzO + 0.08, SW = 1.2;
  const nC = Math.ceil((C.girderY1 - cy0) / 0.25 - 1e-6), runC = nC * 0.28, foot = cx + cab.halfX + 0.3;
  out.push(slabXYZ(cx - cab.halfX, foot, cy0 - 0.2, cy0, cz + cab.halfZ, lane0 + SW, "grate", { kind: "landing" }));
  out.push(...flight("x", foot, lane0 + SW / 2, 1, cy0, C.girderY1, runC, SW, "steel", 0));
  out.push(railRun(cx - cab.halfX, lane0 + SW, foot, lane0 + SW, cy0), railRun(cx - cab.halfX, cz + cab.halfZ, cx - cab.halfX, lane0 + SW, cy0));
  return out;
}
/** where the switchback tower's top landing crosses the −z walkway edge (x range) — the railing opens there */
export function craneStairGap(): [number, number] {
  const C = CRANE, w = C.stair.w, xA = C.railLand - C.legW / 2 - 0.25 - w / 2, xB = xA - w - 0.1;
  return [(xA + xB) / 2 - w - 0.15, (xA + xB) / 2 + w + 0.15];
}
/** where the cab stair tops out on the +z walkway (x range) — the walkway railing leaves a gap there */
export function cabStairTop(idx: number): [number, number] {
  const C = CRANE, cx = C.trolleyX[idx] + C.cabin.dx, foot = cx + C.cabin.halfX + 0.3, runC = Math.ceil((C.girderY1 - C.cabin.y0) / 0.25 - 1e-6) * 0.28;
  return [foot + runC - 1.2, foot + runC + 0.1];
}

// ---------------------------------------------------------------- the tank farm is climbable
/** cone roof height above the shell top (local ρ from the tank axis) — the visual lathe profile */
export function tankRoofY(t: TankSpec, rho: number): number {
  const pts: Array<[number, number]> = [[t.r + 0.08, 0.22], [t.r * 0.5, 0.9], [0.9, 1.25], [0, 1.3]];
  if (rho >= pts[0][0]) return pts[0][1];
  for (let i = 0; i < pts.length - 1; i++) if (rho <= pts[i][0] && rho >= pts[i + 1][0]) { const u = (pts[i][0] - rho) / (pts[i][0] - pts[i + 1][0]); return pts[i][1] + (pts[i + 1][1] - pts[i][1]) * u; }
  return 1.3;
}
/** the stepped roof tiers (radius, top above the shell top): a kong walks up the shallow cone */
export const TANK_TIERS = (t: TankSpec): Array<[number, number]> => {
  // (within ±0.15 of the drawn roof) the outer tier stays at 0.3 (the rim railing + stair top stand on it); inward, rings whose drawn
  // cone rises ≤ 0.24 m across them, each topped at the middle of its rise — the drawn roof within ±0.12 m everywhere
  const out: Array<[number, number]> = [[t.r + 0.05, 0.3]];
  let ro = t.r + 0.05;
  while (ro > 0.05 && tankRoofY(t, ro) < 0.42) ro -= 0.05;
  while (ro > 0.05) {
    let ri = ro;
    while (ri > 0 && tankRoofY(t, ri - 0.05) - tankRoofY(t, ro) <= 0.24) ri -= 0.05;
    ri = Math.max(0, ri);
    out.push([ro, (tankRoofY(t, ro) + tankRoofY(t, ri)) / 2]);
    ro = ri;
  }
  return out;
};
/** a disc of radius rho as z strips (half-width at each strip's middle) — harbor-local boxes from y0 to y1 */
function discStrips(x: number, z: number, rho: number, y0: number, y1: number, surf: Box["surf"]): Box[] {
  const n = Math.max(2, Math.round(rho / 0.5)), out: Box[] = [];
  for (let i = 0; i < n; i++) {
    const za = -rho + (2 * rho * i) / n, zb = -rho + (2 * rho * (i + 1)) / n, zm = (za + zb) / 2, hwid = Math.sqrt(Math.max(0, rho * rho - zm * zm));
    if (hwid > 0.1) out.push({ c: [x, (y0 + y1) / 2, z + zm], h: [hwid, (y1 - y0) / 2, (zb - za) / 2], surf });
  }
  return out;
}
/** the entries through each tank's rim railing (harbor-local angle θ: direction (cos θ, sin θ) in x, z) */
export function tankEntries(i: number): number[] {
  if (i === 0) return [Math.PI];
  if (i === TANKS.length - 1) return [0];
  // the middle tank also opens toward the stair's top landing (north-west of it)
  const t = TANKS[i], n = Math.ceil((t.h + TANK_TIERS(TANKS[0])[0][1]) / 0.25 - 1e-6), xt = TANKS[0].x - 1 - n * 0.3;
  return [0, Math.PI, dmath.atan2(TANK_BUND.z1 - 2.2 - 1.9 - t.z, xt - 1.3 - t.x)];
}
/** the stair behind the tanks (inside the bund, north side) up to the east tank's roof, the bridges between the roofs */
export function tankStairPieces(): Piece[] {
  const t0 = TANKS[0], top = APRON_Y + t0.h + TANK_TIERS(t0)[0][1], out: Piece[] = [];
  const n = Math.ceil((top - APRON_Y) / 0.25 - 1e-6), run = n * 0.3, x1 = t0.x - 1, lane = TANK_BUND.z1 - 2.2;
  out.push(...flight("x", x1, lane, -1, APRON_Y, top, run, 1.2, "steel", 2.4));
  // (the flight climbs WEST from the bund's east end; its top meets a landing that reaches the middle tank's rim — and a
  // bridge back east along the rim line joins the east tank)
  const xt = x1 - run, t1 = TANKS[1];
  out.push(slabXYZ(xt - 2.6, xt, top - 0.2, top, t1.z + 5.4, lane + 0.6, "grate", { kind: "landing" }));
  for (let i = 0; i < TANKS.length - 1; i++) {
    const a = TANKS[i], b = TANKS[i + 1], xa = a.x - a.r + 0.6, xb = b.x + b.r - 0.6, zb = (a.z + b.z) / 2;
    out.push(slabXYZ(xb, xa, top - 0.2, top, zb - 0.6, zb + 0.6, "grate", { kind: "landing" }));
    out.push(railRun(xb + 0.8, zb - 0.66, xa - 0.8, zb - 0.66, top), railRun(xb + 0.8, zb + 0.66, xa - 0.8, zb + 0.66, top));
  }
  out.push(railRun(xt - 2.6, lane + 0.6, xt, lane + 0.6, top), railRun(xt - 2.6, t1.z + 5.4, xt - 2.6, lane + 0.6, top));
  return out;
}
function tankBoxes(): Box[] {
  const out: Box[] = [];
  TANKS.forEach((t, i) => {
    // the shell is a RING of 48 yawed 1 m boxes whose outer faces lie on the cylinder (sagitta 1.7 cm)
    // round an inscribed strip core — plain z-strips' corners stand up to 0.8 m proud of the curve for grazing rays
    const y0 = APRON_Y, y1 = APRON_Y + t.h + TANK_TIERS(t)[0][1], N = 48, rr = t.r + 0.05;
    for (let k = 0; k < N; k++) {
      const a = ((k + 0.5) / N) * Math.PI * 2, cx = t.x + dmath.cos(a) * (rr - 0.5), cz = t.z + dmath.sin(a) * (rr - 0.5);
      out.push(yawBoxWorld(cx, y0, cz, 0.5, (y1 - y0) / 2, rr * dmath.sin(Math.PI / N) + 0.01, -a, "metal"));
    }
    out.push(...discStrips(t.x, t.z, rr - 0.85, y0, y1, "metal").map(boxToWorld));
    for (const [rho, top] of TANK_TIERS(t).slice(1)) out.push(...discStrips(t.x, t.z, rho, APRON_Y + t.h, APRON_Y + t.h + top, "metal").map(boxToWorld));
    void i;
  });
  return out;
}
/** the rim railings as yawed WORLD boxes (24 chords a tank, open at the entries) */
function tankRailBoxes(): Box[] {
  const out: Box[] = [];
  TANKS.forEach((t, i) => {
    const rr = t.r - 0.15, y = APRON_Y + t.h + TANK_TIERS(t)[0][1], ent = tankEntries(i), N = 24;
    for (let k = 0; k < N; k++) {
      const a0 = (k / N) * Math.PI * 2, a1 = ((k + 1) / N) * Math.PI * 2, am = (a0 + a1) / 2;
      if (ent.some((e) => Math.abs(dmath.atan2(dmath.sin(am - e), dmath.cos(am - e))) < 0.3)) continue;
      const x0 = t.x + dmath.cos(a0) * rr, z0 = t.z + dmath.sin(a0) * rr, x1 = t.x + dmath.cos(a1) * rr, z1 = t.z + dmath.sin(a1) * rr;
      const b = yawBoxWorld((x0 + x1) / 2, y, (z0 + z1) / 2, dmath.hypot(x1 - x0, z1 - z0) / 2, 0.525, 0.05, -dmath.atan2(z1 - z0, x1 - x0), "metal", true);
      out.push(b);
    }
  });
  return out;
}

// ---------------------------------------------------------------- the moored ship's superstructure is a real building
export const SHIP_DECK_H = 3.25;
/** the accommodation corridor: partition walls at z = ±SHIP_CORR (house-local), a door at x ∈ SHIP_CORR_DOOR */
export const SHIP_CORR = 1.45, SHIP_CORR_DOOR: [number, number] = [1.6, 2.6];
/** the house levels (house-local: x along the ship toward the bow, z across; y above the main deck) — the stepped
 *  wedding-cake setbacks of the visual (every level 1.1 m shorter forward, narrower above the 1st, the bridge wide) */
export function shipLevels(): Array<{ xa: number; xb: number; hw: number; y0: number; bridge: boolean }> {
  const H = SHIP.house, n = Math.floor((H.top - SHIP.deckY) / SHIP_DECK_H), out = [];
  for (let l = 0; l < n; l++) {
    const bridge = l === n - 1, hw = bridge ? H.halfW - 0.6 : H.halfW - (l === 0 ? 0 : 0.6 + (l > 2 ? 0.7 : 0));
    out.push({ xa: -H.halfL + (l > 1 ? 1.2 : 0), xb: H.halfL - l * 1.1, hw, y0: l * SHIP_DECK_H, bridge });
  }
  return out;
}
const SHIP_FRAME = (): QFrame => ({ x: SHIP.x, y: SHIP.deckY, z: SHIP.house.z, yaw: -Math.PI / 2 });
/** hollow house: walls with windows + doors (the forward door of every upper level opens onto its stepped deck), a
 *  stairwell through every level to a roof hatch, bridge consoles, mess tables, bunks, lockers (harbor-local pieces) */
/** the fore / aft bulkhead of a ship level (house-local x) and its door (z range) on side sd */
export function shipXm(v: ReturnType<typeof shipLevels>[number]): number {
  // (between two side windows — they sit every 2.2 m from xa + 1.4, ±0.45 — nearest the middle of the level)
  const xm = (v.xa + v.xb) / 2, k = Math.round((xm - v.xa - 2.5) / 2.2);
  return v.xa + 2.5 + 2.2 * k;
}
/** the corridor partitions' door at the stair landing (house-local x range: aft of the well, x0 … x0 + land of
 *  the stairwell at x0 = −5.95, clear of the aft wall) */
export function shipLandingDoor(v: ReturnType<typeof shipLevels>[number]): [number, number] {
  return [Math.max(v.xa + 0.32, -6.1), -4.76];
}
export function shipPartDoor(v: ReturnType<typeof shipLevels>[number], l: number, sd: number): [number, number] {
  const zc = sd * (SHIP_CORR + (v.hw - SHIP_CORR) / 2), w = l === 0 ? 2.0 : 1.0;
  return [zc - w / 2, zc + w / 2];
}
/** cover every ≤ 5 m in the ship's rooms: the steel fitting standing in the middle of every side room —
 *  a back-to-back locker bank (1.9 m, hides a kong) in the cabins and offices, a serving counter (0.95 m) in the mess /
 *  galley. House-local box; the kit keeps its furniture 0.8 m clear of it (keepOut), ship.ts draws it. */
export function shipIsland(v: ReturnType<typeof shipLevels>[number], l: number, sd: number, fore: number): { x0: number; x1: number; z0: number; z1: number; h: number; kind: "locker" | "cabinet" } {
  const T = 0.3, xp = shipXm(v), xa = fore ? xp + 0.1 : v.xa + T, xb = fore ? v.xb - T : xp - 0.1;
  const zi = sd * (SHIP_CORR + 0.1), zo = sd * (v.hw - T), cx = (xa + xb) / 2, cz = (zi + zo) / 2;
  const [hx, hz, h, kind] = l === 0 ? [0.9, 0.4, 0.95, "cabinet" as const] : [0.7, 0.3, 1.9, "locker" as const];
  return { x0: cx - hx, x1: cx + hx, z0: cz - hz, z1: cz + hz, h, kind };
}
/** the ship house's window openings per level (house-local: fore/aft faces along z, the side walls along x) — shared by
 *  the hull pieces and the furnished rooms (the rooms' panelled liners leave every window open to daylight) */
export function shipWindows(v: ReturnType<typeof shipLevels>[number], l: number): { doors: Opening[]; fore: Opening[]; aft: Opening[]; side: Opening[] } {
  const doors: Opening[] = l === 0 ? [{ a0: -4.5, a1: -3.5, y0: v.y0, y1: v.y0 + 2.15, kind: "door" }, { a0: 3.5, a1: 4.5, y0: v.y0, y1: v.y0 + 2.15, kind: "door" }] : [{ a0: -6.6, a1: -5.6, y0: v.y0, y1: v.y0 + 2.15, kind: "door" }];
  const fore: Opening[] = [];
  if (v.bridge) { for (let z = -v.hw + 0.9; z + 1.2 < v.hw - 0.6; z += 1.4) if (!doors.some((d) => z + 1.2 > d.a0 - 0.2 && z < d.a1 + 0.2)) fore.push({ a0: z, a1: z + 1.2, y0: v.y0 + 1.15, y1: v.y0 + 2.4, kind: "window" }); }
  else for (let z = -v.hw + 1.4; z < v.hw - 0.9; z += 1.8) if (!doors.some((d) => z + 0.5 > d.a0 - 0.2 && z - 0.5 < d.a1 + 0.2)) fore.push({ a0: z - 0.47, a1: z + 0.47, y0: v.y0 + 1.25, y1: v.y0 + 2.15, kind: "window" });
  const aft: Opening[] = [{ a0: -v.hw + 2, a1: -v.hw + 2.9, y0: v.y0 + 1.25, y1: v.y0 + 2.15, kind: "window" }, { a0: v.hw - 2.9, a1: v.hw - 2, y0: v.y0 + 1.25, y1: v.y0 + 2.15, kind: "window" }];
  const side: Opening[] = [];
  for (let x = v.xa + 1.4; x < v.xb - 0.9; x += 2.2) side.push({ a0: x - 0.45, a1: x + 0.45, y0: v.y0 + 1.25, y1: v.y0 + 2.15, kind: "window" });
  return { doors, fore, aft, side };
}
export function shipHousePieces(): Piece[] {
  const L = shipLevels(), T = 0.3, DH = SHIP_DECK_H, out: Piece[] = [];
  const sw = stairwell(-L[L.length - 1].xb + L[L.length - 1].xb - 5.95, 0, 0, DH, L.length, "steel");
  for (const [l, v] of L.entries()) {
    const wy1 = v.y0 + DH - 0.25;
    // forward face: windows on a 1.8 m grid (the bridge: a wrap band of big panes), doors
    const W = shipWindows(v, l);
    out.push(...wallRun("z", -v.hw, v.hw, v.xb - T / 2, v.y0, wy1, T, "hull", [...W.doors, ...W.fore]));
    // aft face: a door on the main deck (to the stern mooring deck), two portholes-sized windows
    const aw: Opening[] = [...W.aft];
    if (l === 0) aw.push({ a0: 2.6, a1: 3.6, y0: 0, y1: 2.15, kind: "door" });
    out.push(...wallRun("z", -v.hw, v.hw, v.xa + T / 2, v.y0, wy1, T, "hull", aw));
    for (const sd of [-1, 1]) out.push(...wallRun("x", v.xa + T, v.xb - T, sd * (v.hw - T / 2), v.y0, wy1, T, "hull", W.side));
    // the floor slab above this level: the union of this level and the next (the setback decks + the bridge overhang)
    const nx = L[l + 1], top = v.y0 + DH;
    const fa = Math.min(v.xa, nx?.xa ?? v.xa), fb = Math.max(v.xb, nx?.xb ?? v.xb), fh = Math.max(v.hw, nx?.hw ?? v.hw);
    out.push(...floorWithHoles(fa, fb, -fh, fh, top, 0.25, l === L.length - 1 ? "hull" : "floor", [sw.well]));
    if (l > 0) out.push(slabXYZ(v.xa + T, v.xb - T, v.y0, v.y0 + 0.02, -v.hw + T, v.hw - T, "floor", { kind: "panel", solid: false }));
    // a central corridor round the stairwell — partitions with a door into the port / starboard rooms (every
    // deck but the open bridge)
    // (+ a door at the stair landing — without it the landing pocket aft of the well is boxed in by the aft wall, these
    // partitions and the well rails (a 0.1 m slot), and the loot walk graph seals the bridge. Every storey's landing
    // opens into both aft side rooms)
    if (!v.bridge) for (const sd of [-1, 1]) { const [la0, la1] = shipLandingDoor(v); out.push(...wallRun("x", v.xa + T, v.xb - T, sd * SHIP_CORR, v.y0, wy1, 0.2, "wallIn", [{ a0: la0, a1: la1, y0: v.y0, y1: v.y0 + 2.15, kind: "door" }, { a0: SHIP_CORR_DOOR[0], a1: SHIP_CORR_DOOR[1], y0: v.y0, y1: v.y0 + 2.15, kind: "door" }])); }
    // (cover every ≤ 5 m on the 15 m decks) a bulkhead splits every side room fore / aft —
    // two 7 × 7.5 m rooms joined by a door (the mess and the galley by a 2 m serving opening)
    if (!v.bridge) for (const sd of [-1, 1]) { const [d0, d1] = shipPartDoor(v, l, sd); out.push(...wallRun("z", Math.min(sd * (SHIP_CORR + 0.1), sd * (v.hw - T)), Math.max(sd * (SHIP_CORR + 0.1), sd * (v.hw - T)), shipXm(v), v.y0, wy1, 0.2, "wallIn", [{ a0: d0, a1: d1, y0: v.y0, y1: v.y0 + 2.15, kind: "door" }])); }
    // service runs along the corridor bulkhead under the ceiling of every side room — a cable tray
    // + a red fire main + a white fresh-water line (visual only: above every head)
    if (!v.bridge) for (const sd of [-1, 1]) {
      const zc = sd * (SHIP_CORR + 0.1 + 0.3), X0 = v.xa + T + 0.05, X1 = v.xb - T - 0.05;
      out.push(slabXYZ(X0, X1, v.y0 + 2.62, v.y0 + 2.7, zc - 0.17, zc + 0.17, "steel", { solid: false, kind: "panel" }));
      out.push(slabXYZ(X0, X1, v.y0 + 2.36, v.y0 + 2.5, zc + sd * 0.05 - 0.07, zc + sd * 0.05 + 0.07, "pipe", { solid: false, kind: "pipe" }));
      out.push(slabXYZ(X0, X1, v.y0 + 2.4, v.y0 + 2.5, zc + sd * 0.3 - 0.05, zc + sd * 0.3 + 0.05, "wallIn", { solid: false, kind: "pipe" }));
    }
    if (!v.bridge) for (const sd of [-1, 1]) for (const fore of [0, 1]) { const q = shipIsland(v, l, sd, fore); out.push(slabXYZ(q.x0, q.x1, v.y0, v.y0 + q.h, q.z0, q.z1, "cabinet", { kind: q.kind })); }
    // a ceiling lamp in the middle of every level
    out.push(slabXYZ(1.0, 2.2, v.y0, wy1, -0.4, 0.4, "wallIn", { solid: false, kind: "lamp" }));
  }
  out.push(...sw.pieces);
  // furniture (cover), kept clear of the stairwell (x < −1.3 around z 0) and the doors
  const f = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, mat: PieceMat, kind: Piece["kind"]) => out.push(slabXYZ(x0, x1, y0, y1, z0, z1, mat, { kind }));
  // (the mess, the cabins and the ship's office are furnished by the interiors kit — INTERIOR_ROOMS)
  // bridge: console segments under the forward windows, a chart table
  { const y = 4 * DH, v = L[4]; for (const z0 of [-7.4, -3.4, 0.8, 4.8]) f(v.xb - 1.1, v.xb - 0.3, y, y + 1.0, z0, z0 + 1.8, "cabinet", "console"); }
  // bridge wings (open platforms to the ship side at the bridge roof line) + the roof hatch rail
  const vb = L[4];
  for (const sd of [-1, 1]) out.push(slabXYZ(vb.xb - 2.8, vb.xb, vb.y0 + DH - 1.8, vb.y0 + DH, sd > 0 ? SHIP.house.halfW - 0.6 : -(SHIP.beam / 2 - 0.2), sd > 0 ? SHIP.beam / 2 - 0.2 : -(SHIP.house.halfW - 0.6), "hull"));
  const [wx0, wx1, wz0, wz1] = sw.well, rt = L.length * DH;
  out.push(railRun(wx0, wz0, wx1, wz0, rt), railRun(wx0, wz1, wx1, wz1, rt), railRun(wx1, wz0, wx1, wz1, rt));
  // a railing along both long sides of the stair well on every upper floor (the bridge is open-plan round it).
  // Not across its far end: that rail would hang 1.6 m over the half-landing below (head-bump traps on every landing)
  for (let l = 1; l < L.length; l++) { const y = l * DH; out.push(railRun(wx0, wz0, wx1, wz0, y), railRun(wx0, wz1, wx1, wz1, y)); }
  const F = SHIP_FRAME();
  return out.map((p) => qPiece(F, p));
}

/** the house's outdoor deck edges as see-through rail colliders (house-local, mapped like the house) — the
 *  white railings ship.ts draws round the stepped decks of levels 1–4: without them a kong walks off a 10–16 m edge,
 *  and from the upper levels momentum carries him past the hull into the sea. The wheelhouse roof (the
 *  stairwell tops out there: a perch over the whole deck) + its bridge wings get a rail round the edge too. */
export function shipHouseRails(): Piece[] {
  const L = shipLevels(), DH = SHIP_DECK_H, out: Piece[] = [];
  for (let l = 0; l < L.length - 1; l++) {
    const v = L[l], y = v.y0 + DH, hw = v.hw + 0.35, xf = v.xb + 0.5;
    // (the drawn deck plate overhangs the floor collider by 0.9 m at the front and 0.3 m at the sides — the lip the
    // railing stands on was air: a kong slid off between the floor edge and the rail)
    out.push(slabXYZ(v.xb, v.xb + 0.9, y - 0.16, y, -(v.hw + 0.3), v.hw + 0.3, "hull"));
    for (const sd of [-1, 1]) out.push(slabXYZ(v.xa - 0.3, v.xb, y - 0.16, y, Math.min(sd * v.hw, sd * (v.hw + 0.3)), Math.max(sd * v.hw, sd * (v.hw + 0.3)), "hull"));
    out.push(railRun(xf, -hw, xf, hw, y));
    for (const sd of [-1, 1]) out.push(railRun(v.xa, sd * hw, xf, sd * hw, y));
  }
  // the wheelhouse roof (+ the bridge wings out to the ship side over its forward 2.8 m)
  const vb = L[L.length - 1], y = vb.y0 + DH, hw = vb.hw, wx = vb.xb - 2.8, ww = SHIP.beam / 2 - 0.25;
  out.push(railRun(vb.xa + 0.1, -hw + 0.1, vb.xa + 0.1, hw - 0.1, y), railRun(vb.xb - 0.1, -ww, vb.xb - 0.1, ww, y));
  for (const sd of [-1, 1]) out.push(railRun(vb.xa + 0.1, sd * (hw - 0.1), wx, sd * (hw - 0.1), y), railRun(wx, sd * (hw - 0.1), wx, sd * ww, y), railRun(wx, sd * ww, vb.xb - 0.1, sd * ww, y));
  const F = SHIP_FRAME();
  return out.map((p) => qPiece(F, p));
}

export interface StairFlight { x: number; z: number; y0: number; y1: number; len: number; run: number; w: number; pitch: number; dir: 1 | -1 }
/** the crane's switchback stair: two 1.2 m lanes west of the north land leg, flights along z, landings at both ends */
export function craneStair(cz: number): { flights: StairFlight[]; landings: Array<{ x: number; z: number; y: number; hx: number; hz: number }> } {
  const C = CRANE, w = C.stair.w, run = 4.6;
  // an EVEN number of flights: the last one climbs toward +z and tops out beside the girder walkway, so the bridge
  // to the walkway never passes over a flight (it used to, and bumped every climber's head off the last flight)
  const top = C.girderY1, rise = top - APRON_Y, n = 2 * Math.round(rise / 5.6), fr = rise / n;
  const xA = C.railLand - C.legW / 2 - 0.25 - w / 2, xB = xA - w - 0.1, zc = cz - C.legHalfZ;
  const flights: StairFlight[] = [], landings: Array<{ x: number; z: number; y: number; hx: number; hz: number }> = [];
  for (let i = 0; i < n; i++) {
    const a = i % 2 === 0, y0 = APRON_Y + i * fr, y1 = y0 + fr;
    const pitch = dmath.atan2(fr, run) * (a ? 1 : -1);
    flights.push({ x: a ? xA : xB, z: zc, y0, y1, len: dmath.hypot(run, fr), run, w, pitch, dir: a ? -1 : 1 });
    landings.push({ x: (xA + xB) / 2, z: a ? zc - run / 2 - 0.75 : zc + run / 2 + 0.75, y: y1, hx: w + 0.05, hz: 0.75 });
  }
  const last = landings[landings.length - 1];
  const zg = cz - C.girderHalfZ - 0.9;
  landings.push({ x: (xA + xB) / 2, z: (last.z + zg) / 2, y: top, hx: w + 0.05, hz: Math.abs(zg - last.z) / 2 + 0.4 });
  return { flights, landings };
}

function craneBoxes(cz: number): Box[] {
  const C = CRANE, out: Box[] = [];
  // the sill beam is drawn 1.3 m above the slab on its bogie groups (open underneath, 1.3 m < a kong) —
  // collide with the beam + the bogies + the rail clamps, not one block down to the slab
  const sillY0 = C.sillTop - 1.3;
  for (const rx of [C.railLand, C.railSea]) {
    out.push({ c: [rx, (sillY0 + C.sillTop) / 2, cz], h: [0.86, (C.sillTop - sillY0) / 2, C.legHalfZ + 2.7], surf: "metal" });
    for (const e of [-1, 1]) {
      out.push({ c: [rx, (APRON_Y + sillY0) / 2, cz + e * (C.legHalfZ + 0.6)], h: [0.72, (sillY0 - APRON_Y) / 2, 2.3], surf: "metal" });
      out.push({ c: [rx, APRON_Y + 0.4, cz + e * (C.legHalfZ + 3.6)], h: [0.45, 0.4, 0.4], surf: "metal" });
    }
    for (const sz of [-1, 1]) out.push({ c: [rx, (C.sillTop + C.portalY) / 2, cz + sz * C.legHalfZ], h: [C.legW / 2, (C.portalY - C.sillTop) / 2, C.legW / 2], surf: "metal" });
    // the travel-drive motors on the outside of every bogie truck
    for (const e of [-1, 1]) for (const tz of [-1.25, 1.25]) out.push({ c: [rx + (rx === C.railLand ? -0.95 : 0.95), APRON_Y + 1.0, cz + e * (C.legHalfZ + 0.6) + tz], h: [0.3, 0.3, 0.5], surf: "metal" });
  }
  // the cable reel drum beside the land sill (r 1.35, axis along x) as 5 disc bands + its yellow stand
  { const rz = cz + (C.zs.indexOf(cz) === 0 ? 1 : -1) * 3, yc = C.sillTop - 0.3, R = 1.35;
    for (let k = 0; k < 5; k++) { const y0 = yc - R + (2 * R * k) / 5, y1 = y0 + (2 * R) / 5, ym = Math.max(Math.abs(y0 - yc), Math.abs(y1 - yc)) * 0.6, hz = Math.sqrt(Math.max(0.01, R * R - ym * ym)); out.push({ c: [C.railLand - 1.7, (y0 + y1) / 2, rz], h: [0.6, (y1 - y0) / 2, hz], surf: "metal" }); }
    out.push({ c: [C.railLand - 1.7, C.sillTop - 1.3, rz], h: [0.75, 0.5, 0.25], surf: "metal" }); }
  // the girder is two trusses (chords + verticals; the diagonals are see-through) with a grating deck
  // between them over the backreach + portal, the boom part open between the trusses, and the walkway plates
  // outboard — not one 8 × 3.2 m block over all of it (open truss that stops bullets, a walkway with air under it)
  const gzO = C.girderHalfZ + 0.625 + 1.0, gw = 1.25, chH = 0.75, G0 = C.girderY0, G1 = C.girderY1;
  const xb = C.railLand + 2, xs = C.railSea + 2;
  for (const sz of [-1, 1]) {
    const zc = cz + sz * C.girderHalfZ;
    out.push({ c: [(C.girderX0 + xb) / 2, (G0 + G1) / 2, zc], h: [(xb - C.girderX0) / 2, (G1 - G0) / 2, gw / 2], surf: "metal" });
    out.push({ c: [(xb + C.girderX1) / 2, G1 - chH / 2, zc], h: [(C.girderX1 - xb) / 2, chH / 2, gw / 2], surf: "metal" });
    // (bottom chord: bullets only — its top was a 1.7 m-high covered ledge between the chords, scanner jump-only)
    out.push({ c: [(xb + C.girderX1) / 2, G0 + chH / 2, zc], h: [(C.girderX1 - xb) / 2, chH / 2, gw / 2], surf: "metal", noWalk: true });
    const n = Math.round((C.girderX1 - xb) / 3.2), dx = (C.girderX1 - xb) / n;
    for (let i = 0; i <= n; i++) out.push({ c: [xb + i * dx, (G0 + G1) / 2, zc], h: [0.17, (G1 - G0) / 2 - chH, gw * 0.36], surf: "metal" });
    // outboard walkway plate (drawn 8 cm thick at G1 − 0.06)
    out.push({ c: [(C.girderX0 + C.girderX1) / 2, G1 - 0.06, cz + sz * (C.girderHalfZ + gw / 2 + 0.5)], h: [(C.girderX1 - C.girderX0) / 2, 0.04, 0.5], surf: "metal" });
  }
  // the A-frame legs (1.05 m box beams, stepped along their slope), the head + tie beams
  const apxB = C.apexX - 8.5, apxF = C.apexX + 7.5, Ytop = C.apexY - 1;
  for (const az of [cz - C.girderHalfZ, cz + C.girderHalfZ]) {
    for (const [x0, x1] of [[apxB, C.apexX - 0.5], [apxF, C.apexX + 0.5]]) for (let y = G1; y < Ytop - 0.01; y += 1.0) {
      const yc = Math.min(y + 0.5, Ytop - 0.5), t = (yc - G1) / (Ytop - G1);
      out.push({ c: [x0 + (x1 - x0) * t, yc, az], h: [0.6, 0.5, 0.525], surf: "metal" });
    }
    out.push({ c: [C.apexX, 45.5, az], h: [(apxF - apxB - 6.4) / 2, 0.3, 0.3], surf: "metal" });
  }
  out.push({ c: [C.apexX, C.apexY - 0.3, cz], h: [1.2, 0.9, C.girderHalfZ + 0.7], surf: "metal" });
  out.push({ c: [C.apexX, 45.5, cz], h: [0.35, 0.35, C.girderHalfZ], surf: "metal" });
  { const t = (39.5 - G1) / (Ytop - G1); for (const [x0, x1] of [[apxB, C.apexX - 0.5], [apxF, C.apexX + 0.5]]) out.push({ c: [x0 + (x1 - x0) * t, 39.5, cz], h: [0.3, 0.3, C.girderHalfZ], surf: "metal" }); }
  // the grating deck between the trusses (backreach → past the sea leg) + the cross members under the open boom
  out.push({ c: [(C.girderX0 + xs) / 2, G1 - 0.06, cz], h: [(xs - C.girderX0) / 2, 0.04, C.girderHalfZ - gw / 2], surf: "metal" });
  // (the bottom cross members get no collider: their tops were floors between the trusses nobody can reach / leave)
  for (let x = C.girderX0 + 1; x < C.girderX1; x += 6.4) if (x + 3.2 > xs) out.push({ c: [x + 3.2, G1 - 0.25, cz], h: [0.2, 0.2, C.girderHalfZ], surf: "metal", noWalk: true });
  // walkway guard rails (players stop, bullets pass), a gap on the +z side where the cab stair tops out
  const idx = C.zs.indexOf(cz), [g0, g1] = cabStairTop(idx);
  const [s0, s1] = craneStairGap();
  out.push(pieceBox(railRun(C.girderX0, cz - gzO, s0, cz - gzO, C.girderY1)), pieceBox(railRun(s1, cz - gzO, C.girderX1, cz - gzO, C.girderY1)));
  out.push(pieceBox(railRun(C.girderX0, cz + gzO, g0, cz + gzO, C.girderY1)), pieceBox(railRun(g1, cz + gzO, C.girderX1, cz + gzO, C.girderY1)));
  out.push(...cranePieces(cz, idx).filter((p) => p.solid !== false).map(pieceBox));
  // the machinery house's outside wall ribs + louvre panels (crane.ts) stand 5–13 cm proud
  { const H = C.house, hy = (H.y0 + H.y1) / 2;
    for (const sz of [-1, 1]) {
      const fz = cz + sz * (H.halfZ + 0.03);
      for (let x = H.x0 + 0.8; x < H.x1 - 0.4; x += 1.2) { if (Math.abs(x - (H.x1 - 3)) < 0.8 || Math.abs(x - (H.x0 + (sz < 0 ? 6.2 : 14.2))) < 1.0) continue; out.push({ c: [x, hy, fz + sz * 0.05], h: [0.05, (H.y1 - H.y0 - 0.6) / 2, 0.06], surf: "metal" }); }
      for (const lx of [H.x0 + 3, H.x0 + 9.5]) out.push({ c: [lx, hy + 0.6, fz + sz * 0.05], h: [1.2, 0.8, 0.06], surf: "metal" });
    } }
  // (the portal beams: their tops under the girder were sealed covered floors — scanner jump-only; bullets only on top)
  for (const rx of [C.railLand, C.railSea]) out.push({ c: [rx, C.portalY - 0.9, cz], h: [1.0, 0.9, C.legHalfZ], surf: "metal", noWalk: true });
  // stair tower: every flight as ≤ 0.3 m treads (the sim ignores Box.pitch)
  const st = craneStair(cz);
  for (const f of st.flights) {
    const n = Math.ceil((f.y1 - f.y0) / 0.3), z0 = f.z - (f.dir * f.run) / 2;
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n, y = f.y0 + (f.y1 - f.y0) * ((k + 1) / n);
      out.push({ c: [f.x, y - 0.1, z0 + f.dir * f.run * t], h: [f.w / 2, 0.1, f.run / n / 2 + 0.02], surf: "metal" });
    }
  }
  for (const l of st.landings) out.push({ c: [l.x, l.y - 0.12, l.z], h: [l.hx, 0.12, l.hz], surf: "metal" });
  // the stair tower's four corner posts + its ring beams every 5.6 m (crane.ts draws them; no collider)
  const sx0 = Math.min(...st.flights.map((f) => f.x)) - 0.75, sx1 = Math.max(...st.flights.map((f) => f.x)) + 0.75;
  const sz0 = Math.min(...st.landings.map((l) => l.z)) - 0.75, sz1 = cz - C.legHalfZ + 3.1;
  for (const px of [sx0, sx1]) for (const pz of [sz0, sz1]) out.push({ c: [px, (APRON_Y + C.girderY1) / 2, pz], h: [0.11, (C.girderY1 - APRON_Y) / 2, 0.11], surf: "metal" });
  for (let y = APRON_Y + 5.6; y < C.girderY1; y += 5.6) {
    out.push({ c: [(sx0 + sx1) / 2, y, sz0], h: [(sx1 - sx0) / 2, 0.08, 0.07], surf: "metal", noWalk: true });
    out.push({ c: [sx0, y, (sz0 + sz1) / 2], h: [0.07, 0.08, (sz1 - sz0) / 2], surf: "metal", noWalk: true });
  }
  return out;
}

function shipBoxes(): Box[] {
  const S = SHIP, hl = S.length / 2;
  const cy = (S.deckY + S.keelY) / 2, hy = (S.deckY - S.keelY) / 2;
  const out: Box[] = [
    { c: [S.x, cy, S.z - 4], h: [S.beam / 2, hy, hl - 16], surf: "metal" },
    { c: [S.x, cy, S.z + hl - 10], h: [S.beam / 2 - 4, hy, 8], surf: "metal" },
    { c: [S.x, cy, S.z - hl + 7], h: [S.beam / 2 - 1.5, hy, 7], surf: "metal" },
    // (the house is hollow — shipHousePieces; the funnel aft of it gets its own collider)
    { c: [S.x, (S.deckY + 3 * SHIP_DECK_H + S.house.funnelTop) / 2, S.house.z - S.house.halfL - 2.2], h: [2.9, (S.house.funnelTop - S.deckY - 3 * SHIP_DECK_H) / 2, 2.2], surf: "metal" },
    ...shipHousePieces().filter((p) => p.solid !== false).map(pieceBox),
    ...shipHouseRails().map(pieceBox),
    // (the forecastle deck is in shipAccessBoxes, with the gangways, rails, hatch covers and the ways out of
    // the water)
    ...shipAccessBoxes(),
  ];
  return out;
}

/** a harbor-local box with a local (three.js) yaw → a WORLD box with the sim's yaw convention */
export function yawBoxWorld(lx: number, y0: number, lz: number, hx: number, hy: number, hz: number, localYaw: number, surf: Box["surf"], noShoot = false): Box {
  const [wx, wz] = toWorld(lx, lz);
  const b: Box = { c: [wx, y0 + hy, wz], h: [hx, hy, hz], yaw: -(localYaw + FRAME.yaw), surf };
  if (noShoot) b.noShoot = true;
  return b;
}
/** a prop's collision (WORLD boxes, yawed like the prop) — built INSIDE the visual by props.ts */
function propBoxes(p: PropSpec): Box[] {
  const f = PROP_FOOT[p.kind], s = p.s ?? 1, y = p.y ?? APRON_Y;
  const mem = propMembers(p);
  if (mem) {
    // member boxes: rotate the prop-local centre by the prop's (three.js) yaw, then the frame
    // (the light tower is drawn unrotated: lightTowerInto ignores the spec's yaw)
    const yaw = p.kind === "light-tower" ? 0 : p.yaw, c = dmath.cos(yaw), sn = dmath.sin(yaw), sc = p.kind === "light-tower" ? 1 : s;
    return mem.map(([cx, cy, cz, hx, hy, hz, fl, my]) => { const b = yawBoxWorld(p.x + (cx * c + cz * sn) * sc, y + (cy - hy) * sc, p.z + (-cx * sn + cz * c) * sc, hx * sc, hy * sc, hz * sc, yaw + (my ?? 0), f.surf, fl === 1); if (fl === 2) b.noWalk = true; return b; });
  }
  if (p.kind === "lamp") return [yawBoxWorld(p.x, y, p.z, f.hx, f.hy, f.hz, p.yaw, "metal")];
  if (p.kind === "scale-house" || p.kind === "booth") {
    // real rooms (pieces) — quarter-turn yaws only
    const fr: QFrame = { x: p.x, y: y, z: p.z, yaw: Math.round(p.yaw / (Math.PI / 2)) * (Math.PI / 2) };
    return (p.kind === "booth" ? boothLocalPieces() : scaleHouseLocalPieces()).filter((q) => q.solid !== false).map((q) => boxToWorld(pieceBox(qPiece(fr, q))));
  }
  return [yawBoxWorld(p.x, y, p.z, f.hx * s, f.hy * s, f.hz * s, p.yaw, f.surf, !!f.noShoot)];
}

/** an access-stair tower at a block end: switchback flights (≤ 0.3 m treads) + landings, the top landing bridging
 *  onto the stack's roof. Shared by the visuals (props.ts) and the colliders. Local frame; `a` = along the tower axis
 *  (toward the block), `c` = across. */
export function towerStair(t: StairTower): { flights: Array<{ c: number; a0: number; a1: number; y0: number; y1: number; up: 1 | -1 }>; landings: Array<{ c0: number; c1: number; a0: number; a1: number; y: number }>; toLocal: (a: number, c: number) => [number, number]; w: number } {
  const w = 1.2, rise = t.top - APRON_Y, n = rise > 6 ? 5 : 3, fr = rise / n, run = 3.6;
  // along-axis coordinate measured from the block end face back into the lane: a = 0 at the face, negative = lane
  const toLocal = (a: number, c: number): [number, number] => t.axis === "z" ? [t.x + c, t.z + t.dir * a] : [t.x + t.dir * a, t.z + c];
  const flights: Array<{ c: number; a0: number; a1: number; y0: number; y1: number; up: 1 | -1 }> = [];
  const landings: Array<{ c0: number; c1: number; a0: number; a1: number; y: number }> = [];
  const nearA = -0.4, farA = -0.4 - 1.2 - run - 1.2;
  for (let i = 0; i < n; i++) {
    const toward = i % 2 === 0;                 // even flights climb toward the block (lane c = -0.65), odd back out (+0.65)
    const c = toward ? -0.65 : 0.65, y0 = APRON_Y + i * fr, y1 = y0 + fr;
    flights.push({ c, a0: toward ? farA + 1.2 : nearA - 1.2, a1: toward ? nearA - 1.2 : farA + 1.2, y0, y1, up: toward ? 1 : -1 });
    landings.push(toward ? { c0: -1.3, c1: 1.3, a0: nearA - 1.2, a1: nearA, y: y1 } : { c0: -1.3, c1: 1.3, a0: farA, a1: farA + 1.2, y: y1 });
  }
  // the top landing reaches onto the roof (a > 0)
  landings[landings.length - 1].a1 = 1.2;
  return { flights, landings, toLocal, w };
}
function towerBoxes(t: StairTower): Box[] {
  const st = towerStair(t), out: Box[] = [];
  const box = (a0: number, a1: number, c0: number, c1: number, y0: number, y1: number, surf: Box["surf"]) => {
    const [x, z] = st.toLocal((a0 + a1) / 2, (c0 + c1) / 2), ha = Math.abs(a1 - a0) / 2, hc = Math.abs(c1 - c0) / 2;
    out.push({ c: [x, (y0 + y1) / 2, z], h: t.axis === "z" ? [hc, (y1 - y0) / 2, ha] : [ha, (y1 - y0) / 2, hc], surf });
  };
  st.flights.forEach((f, fi) => {
    const n = Math.ceil((f.y1 - f.y0) / 0.28);
    for (let k = 0; k < n; k++) {
      const u = (k + 0.5) / n, a = f.a0 + (f.a1 - f.a0) * u, y = f.y0 + (f.y1 - f.y0) * ((k + 1) / n), da = Math.abs(f.a1 - f.a0) / n;
      // (the first flight is a SOLID stair down to the slab — a capsule wedged under its low treads: embeds)
      box(a - da / 2 - 0.02, a + da / 2 + 0.02, f.c - st.w / 2, f.c + st.w / 2, fi === 0 ? APRON_Y : y - 0.16, y, "metal");
    }
  });
  // (a landing lower than a standing kong is closed down to the slab — no crouch pocket under it)
  for (const l of st.landings) box(l.a0, l.a1, l.c0, l.c1, l.y - APRON_Y < 2.4 ? APRON_Y : l.y - 0.14, l.y, "metal");
  // corner posts (bullets hit the frame)
  // (at the DRAWN posts — the far pair stands at the farthest landing's end, yard.ts towers())
  const aF = st.landings.reduce((m, l) => Math.min(m, l.a0), 0) + 0.1;
  for (const a of [-0.3, aF]) for (const c of [-1.35, 1.35]) box(a - 0.08, a + 0.08, c - 0.08, c + 0.08, APRON_Y, t.top + 1.1, "metal");
  return out;
}
/** the reefer rack: two walkway decks along the row (tier-1 + tier-2 roof height) on columns, stairs at the south end */
export function reeferRackStairs(): Array<{ z0: number; z1: number; y0: number; y1: number }> {
  const R = REEFER_RACK;
  return [{ z0: R.z0 - 7.4, z1: R.z0 - 0.4, y0: APRON_Y, y1: R.y1 }, { z0: R.z0 + 0.6, z1: R.z0 + 7.6, y0: R.y1, y1: R.y2 }];
}
function reeferRackBoxes(): Box[] {
  const R = REEFER_RACK, out: Box[] = [];
  out.push({ c: [R.x, R.y1 - 0.08, (R.z0 + R.z1) / 2], h: [R.w / 2, 0.08, (R.z1 - R.z0) / 2], surf: "metal" });
  out.push({ c: [R.x, R.y2 - 0.08, (R.z0 + 7.6 + R.z1) / 2], h: [R.w / 2, 0.08, (R.z1 - R.z0 - 7.6) / 2], surf: "metal" });
  for (let z = R.z0; z <= R.z1 + 0.1; z += 12.72) for (const dx of [-R.w / 2, R.w / 2]) out.push({ c: [R.x + dx, (APRON_Y + R.y2 + 1.1) / 2, z], h: [0.12, (R.y2 + 1.1 - APRON_Y) / 2, 0.12], surf: "metal" });
  for (const st of reeferRackStairs()) {
    const n = Math.ceil((st.y1 - st.y0) / 0.28);
    for (let k = 0; k < n; k++) { const u = (k + 0.5) / n, z = st.z0 + (st.z1 - st.z0) * u, y = st.y0 + (st.y1 - st.y0) * ((k + 1) / n); out.push({ c: [R.x, y - 0.08, z], h: [R.w / 2, 0.08, (st.z1 - st.z0) / n / 2 + 0.02], surf: "metal" }); }
  }
  // outer handrail (chest height, the rack's seaward side stays open to the reefer roofs)
  for (const y of [R.y1, R.y2]) out.push({ c: [R.x - R.w / 2 - 0.05, y + 0.55, (R.z0 + R.z1) / 2], h: [0.04, 0.55, (R.z1 - R.z0) / 2], surf: "metal" });
  return out;
}
/** chain-link fences: posts + mesh (players collide, bullets pass the mesh) */
function fenceBoxes(): Box[] {
  const out: Box[] = [];
  for (const f of FENCES) {
    let acc = 0;
    for (let i = 0; i < f.pts.length - 1; i++) {
      const [ax, az] = f.pts[i], [bx, bz] = f.pts[i + 1], L = dmath.hypot(bx - ax, bz - az);
      const segs: Array<[number, number]> = [[0, L]];
      for (const [g0, g1] of f.gaps ?? []) {
        const s0 = g0 - acc, s1 = g1 - acc;
        for (let k = segs.length - 1; k >= 0; k--) { const [a, b] = segs[k]; if (s1 <= a || s0 >= b) continue; segs.splice(k, 1, ...([[a, Math.max(a, s0)], [Math.min(b, s1), b]] as Array<[number, number]>).filter(([p, q]) => q - p > 0.2)); }
      }
      for (const [a, b] of segs) {
        const m = (a + b) / 2, x = ax + ((bx - ax) * m) / L, z = az + ((bz - az) * m) / L;
        const yaw = dmath.atan2(-(bz - az), bx - ax);
        // (5 cm thick like the drawn mesh + posts)
        out.push({ ...yawBoxWorld(x, APRON_Y, z, (b - a) / 2, 1.2, 0.025, yaw, "metal", true), noDrive: true });   // (a tuk-tuk drives through)
      }
      acc += L;
    }
  }
  return out;
}

const localColliders: Box[] = [
  ...apronBoxes(),
  ...CONTAINERS.flatMap(containerBoxes),
  ...SHIP_CONTAINERS.flatMap(containerBoxes),
  ...WAREHOUSES.flatMap(warehouseBoxes),
  ...tankStairPieces().filter((p) => p.solid !== false).map(pieceBox),
  ...pumpHousePieces().filter((p) => p.solid !== false).map(pieceBox),
  ...CRANE.zs.flatMap(craneBoxes),
  ...shipBoxes(),
  ...STAIR_TOWERS.flatMap(towerBoxes),
  ...reeferRackBoxes(),
  // tank bund walls (0.9 m, jumpable) with the east gap
  { c: [(TANK_BUND.x0 + TANK_BUND.x1) / 2, APRON_Y + TANK_BUND.h / 2, TANK_BUND.z0], h: [(TANK_BUND.x1 - TANK_BUND.x0) / 2, TANK_BUND.h / 2, 0.18], surf: "concrete" },
  { c: [(TANK_BUND.x0 + TANK_BUND.x1) / 2, APRON_Y + TANK_BUND.h / 2, TANK_BUND.z1], h: [(TANK_BUND.x1 - TANK_BUND.x0) / 2, TANK_BUND.h / 2, 0.18], surf: "concrete" },
  { c: [TANK_BUND.x0, APRON_Y + TANK_BUND.h / 2, (TANK_BUND.z0 + TANK_BUND.z1) / 2], h: [0.18, TANK_BUND.h / 2, (TANK_BUND.z1 - TANK_BUND.z0) / 2], surf: "concrete" },
  { c: [TANK_BUND.x1, APRON_Y + TANK_BUND.h / 2, (TANK_BUND.z0 * 3 + TANK_BUND.z1) / 4 - 1], h: [0.18, TANK_BUND.h / 2, (TANK_BUND.z1 - TANK_BUND.z0) / 4 - 1], surf: "concrete" },
  { c: [TANK_BUND.x1, APRON_Y + TANK_BUND.h / 2, (TANK_BUND.z0 + TANK_BUND.z1 * 3) / 4 + 1], h: [0.18, TANK_BUND.h / 2, (TANK_BUND.z1 - TANK_BUND.z0) / 4 - 1], surf: "concrete" },
  // tank bund slab (the bund sits partly beyond the apron on the pad)
  { c: [(TANK_BUND.x0 + TANK_BUND.x1) / 2, APRON_Y - 1, (TANK_BUND.z0 + TANK_BUND.z1) / 2], h: [(TANK_BUND.x1 - TANK_BUND.x0) / 2 + 1, 1, (TANK_BUND.z1 - TANK_BUND.z0) / 2 + 1], surf: "concrete" },
  // pier steps, deck + head
  ...pierSteps().map((s): Box => ({ c: [s.x, (s.y0 + s.y1) / 2, s.z], h: [s.w / 2, (s.y1 - s.y0) / 2, s.d / 2], surf: "concrete" })),
  { c: [(PIER.x0 + PIER.x1) / 2 + 0.3, PIER.deckY - 0.15, PIER.z], h: [(PIER.x1 - PIER.x0) / 2, 0.15, PIER.width / 2], surf: "wood" },
  { c: [(PIER.head.x0 + PIER.head.x1) / 2, PIER.deckY - 0.15, (PIER.head.z0 + PIER.head.z1) / 2], h: [(PIER.head.x1 - PIER.head.x0) / 2, 0.15, (PIER.head.z1 - PIER.head.z0) / 2], surf: "wood" },
  ...pierExtraBoxes(),
];

/** local box → world box (the frame yaw is −π/2: swap the x/z half extents; boxes stay axis-aligned) */
export function boxToWorld(b: Box): Box {
  const [x, z] = toWorld(b.c[0], b.c[2]);
  const out: Box = { ...b, c: [x, b.c[1], z], h: [b.h[2], b.h[1], b.h[0]] };
  if (b.yaw) out.yaw = b.yaw; // non-axis-aligned local boxes keep their (small) yaw — none are emitted today
  return out;
}

/** ROCKS need terrain heights; the server can't sample the client's terrain here, so their boxes are sized from the
 *  rock's own base y when given (riprap) — the headland rocks sit on terrain and are left to the heightfield + a
 *  low box. */
/** granite domes breaking out of the jungle canopy on the west
 *  headland behind the yard (harbor-local; r / h = the dome's half width / height above the ground) + their satellite
 *  boulders. Drawn by pier.ts (one merged mesh), colliders voxelised by the offline rock bake, veg keeps clear. */
export const HILL_ROCKS: Array<{ x: number; z: number; r: number; h: number; yaw: number }> = [
  // (inselbergs: 30–60 m bald granite domes standing well over the 20 m canopy, seen from the whole yard)
  { x: 425, z: 212, r: 30, h: 68, yaw: 2.2 }, { x: 405, z: 300, r: 26, h: 56, yaw: 0.4 }, { x: 362, z: 160, r: 24, h: 52, yaw: 0.9 },
  { x: 340, z: 272, r: 20, h: 44, yaw: 1.3 }, { x: 468, z: 140, r: 15, h: 32, yaw: 1.7 }, { x: 382, z: 238, r: 14, h: 30, yaw: 2.9 },
];
/** the pier / riprap boulders as sculpted-rock placements (harbor-local; pier.ts draws them, the offline rock
 *  bake voxelises the same triangles into the colliders). `height(lx, lz)` = the terrain under a local point. */
export function rockSets(height: (lx: number, lz: number) => number): Record<string, RockSet> {
  const big: RockPl[] = [], small: RockPl[] = [];
  ROCKS.forEach((k, i) => {
    const gy = k.y ?? height(k.x, k.z), sc = k.r * (k.moss > 0.7 ? 1.25 : 1), b = k.r >= 1.5;
    (b ? big : small).push({ x: k.x, y: gy + sc * 0.16, z: k.z, sx: sc * (1 + hash01(i, 1) * 0.3), sy: sc * (0.75 + hash01(i, 2) * 0.3), sz: sc * (0.85 + hash01(i, 3) * 0.3),
      ry: hash01(i, 4) * 6.28, rx: (hash01(i, 5) - 0.5) * 0.25, rz: (hash01(i, 6) - 0.5) * 0.25, proto: Math.floor(hash01(i, 7) * (b ? 4 : 3)) });
  });
  const hills: RockPl[] = [];
  HILL_ROCKS.forEach((k, i) => {
    const g = height(k.x, k.z);
    // the dome (its base 0.1 h under the ground) + 3 satellites leaning on it
    // (the island's cleaved rock (cleftout, the ripe peak's chunky polyhedra) on a wide, squat mass: a broken
    // granite outcrop over the canopy — the soft boulder family stretched tall reads as a placeholder egg)
    hills.push({ x: k.x, y: g - 0.1 * k.h, z: k.z, sx: k.r * 1.2, sy: k.h * 0.95, sz: k.r * 1.05, ry: k.yaw, rx: (hash01(i, 21) - 0.5) * 0.12, rz: (hash01(i, 22) - 0.5) * 0.12, proto: i % 4 });
    for (let j = 0; j < 3; j++) {
      const a = k.yaw + j * 2.1 + hash01(i, j, 23), d = k.r * (0.75 + hash01(i, j, 24) * 0.3), x = k.x + dmath.cos(a) * d, z = k.z + dmath.sin(a) * d, sc = k.r * (0.22 + hash01(i, j, 25) * 0.2);
      hills.push({ x, y: height(x, z) - 0.1 * sc, z, sx: sc, sy: sc * 0.85, sz: sc * 0.9, ry: a, rx: (hash01(i, j, 26) - 0.5) * 0.3, rz: (hash01(i, j, 27) - 0.5) * 0.3, proto: (i + j + 1) % 4 });
    }
  });
  return { big: { fam: "boulder", n: 4, res: 15, pl: big }, small: { fam: "boulder", n: 3, res: 10, pl: small }, hills: { fam: "cleftout", n: 4, res: 14, pl: hills } };
}
export const ROCK_SIG = rockSig("hr3", ROCKS, HILL_ROCKS);
/** the rock bake of this POI, or undefined */
export const ROCK_BAKE = (ROCKS_BAKED as unknown as Record<string, RockBake>)["peel-harbor"];
function rockBoxes(): Box[] {
  const baked = bakedRockBoxes("peel-harbor", ROCK_BAKE, ROCK_SIG);
  if (baked) return baked;
  // (matches pier.ts: the mossiest boulders are drawn 1.25× their radius, sitting 0.16 of it above their base)
  return ROCKS.map((k): Box => { const sc = k.r * (k.moss > 0.7 ? 1.25 : 1), y0 = k.y ?? 0.4, top = y0 + sc * 0.84; return { c: [k.x, (y0 + top) / 2, k.z], h: [sc * 0.72, (top - y0) / 2, sc * 0.72], surf: "stone" }; });
}

// ---------------------------------------------------------------- furnished rooms (shared interiors kit)
/** Every enclosed room at the harbor, furnished by the shared kit (shared/pois/interior-kit.ts): the site office + the
 *  two open ends of every warehouse hall, the pump house, the gate's scale house, the ship's four accommodation decks
 *  + the bridge. World frame (y = floor top, three.js yaw); the harbor already draws the walls, floors and windows. */
/** a room's seed re-rolled (≤ 8 tries) until no cluster of furniture tops between 0.55 and 2.4 m (gaps < 0.9 m join) covers ≥ 1.8 m²
 *  (a sack pile / crate block under the shed's roof is a covered floor only a jump reaches — the scanner's jump-only) */
// ROOM_PICK (generated by the offline room bake): room id → [authored seed, picked seed, density]. A room
// whose authored seed still matches uses the baked pick (one furnish at load instead of up to 16); otherwise it re-rolls.
// BEGIN ROOM_PICK
const ROOM_PICK: Record<string, [number, number, number | null]> = {
  "wy-office": [9100, 9100, null],
  "wy-bay-w": [9101, 9404, 0.9],
  "wy-bay-ne": [9102, 9304, 0.9],
  "wy-bay-se": [9103, 9103, 0.9],
  "wr-office": [9117, 9117, null],
  "wr-bay-w": [9118, 9219, 0.9],
  "wr-bay-ne": [9119, 9422, 0.9],
  "wr-bay-se": [9120, 9120, 0.9],
  "wg-office": [9134, 10144, 0.5],
  "wg-bay-w": [9135, 9135, 0.9],
  "wg-bay-ne": [9136, 9237, 0.9],
  "wg-bay-se": [9137, 9440, 0.9],
  "wc-office": [9151, 9151, null],
  "wc-bay-w": [9152, 9455, 0.9],
  "wc-bay-ne": [9153, 10163, 0.5],
  "wc-bay-se": [9154, 9659, 0.9],
  "wb-office": [9168, 9168, null],
  "wb-bay-w": [9169, 9169, 0.9],
  "wb-bay-ne": [9170, 9170, 0.9],
  "wb-bay-se": [9171, 9171, 0.9],
  "wd-office": [9185, 9185, null],
  "wd-bay-w": [9186, 9489, 0.9],
  "wd-bay-ne": [9187, 9187, 0.9],
  "wd-bay-se": [9188, 9289, 0.9],
  "pump-house": [9301, 9402, null],
  "scale-house": [9311, 9412, null],
  "ship-0pa": [9400, 9400, 1],
  "ship-0pf": [9401, 9401, 1],
  "ship-0sa": [9402, 9402, 1],
  "ship-0sf": [9403, 9403, 1],
  "ship-1pa": [9404, 9404, 1],
  "ship-1pf": [9405, 9405, 1],
  "ship-1sa": [9406, 9406, 1],
  "ship-1sf": [9407, 9407, 1],
  "ship-2pa": [9408, 9408, 1],
  "ship-2pf": [9409, 9409, 1],
  "ship-2sa": [9410, 9410, 1],
  "ship-2sf": [9411, 9411, 1],
  "ship-3pa": [9412, 9412, 1],
  "ship-3pf": [9413, 9817, 1],
  "ship-3sa": [9414, 9919, 1],
  "ship-3sf": [9415, 9415, 1],
  "ship-4p": [9416, 9416, 0.55],
  "ship-4s": [9418, 9418, 0.55],
};
// END ROOM_PICK
export function pickSeed(r: InteriorRoom, bake = false): InteriorRoom {
  const b = ROOM_PICK[r.id ?? ""];
  if (!bake && b && b[0] === r.seed) return { ...r, seed: b[1], density: b[2] ?? r.density };
  for (let t = 0; t < 16; t++) {
    const q = { ...r, seed: r.seed + t * 101, density: t < 8 ? r.density : Math.min(r.density ?? 1, 0.5) }, its = furnishRoom(q).items.filter((i) => i.col && i.y + i.h > 0.55 && i.y + i.h < 2.4);
    const par = its.map((_, i) => i), f = (i: number): number => (par[i] === i ? i : (par[i] = f(par[i])));
    const ext = (i: typeof its[number]) => { const c = Math.abs(dmath.cos(i.yaw)), s = Math.abs(dmath.sin(i.yaw)); return [i.w * c + i.d * s, i.w * s + i.d * c]; };
    for (let a = 0; a < its.length; a++) for (let b = a + 1; b < its.length; b++) { const [wa, da] = ext(its[a]), [wb, db] = ext(its[b]); if (Math.abs(its[a].x - its[b].x) < (wa + wb) / 2 + 0.9 && Math.abs(its[a].z - its[b].z) < (da + db) / 2 + 0.9) par[f(a)] = f(b); }
    const area = new Map<number, number>(); its.forEach((it, i) => area.set(f(i), (area.get(f(i)) ?? 0) + it.w * it.d));
    if (Math.max(0, ...area.values()) < 1.8) return q;
  }
  return r;
}
/** the rooms as authored (before the seed pick) */
export function authoredRooms(): InteriorRoom[] {
  return AUTHORED;
}
const AUTHORED: InteriorRoom[] = [];
export const INTERIOR_ROOMS: InteriorRoom[] = (() => {
  const out: InteriorRoom[] = [];
  const bare = { wall: null, glass: false, frames: false } as const;
  /** a room authored in a quarter-turn building frame (bx, bz, byaw: harbor-local) → world */
  const room = (bx: number, bz: number, byaw: number, lx: number, lz: number, r: Omit<InteriorRoom, "x" | "z" | "yaw">): InteriorRoom => {
    const c = Math.round(dmath.cos(byaw)), sn = Math.round(dmath.sin(byaw)), [x, z] = toWorld(bx + lx * c + lz * sn, bz - lx * sn + lz * c);
    return { ...r, x, z, yaw: byaw + FRAME.yaw };
  };
  WAREHOUSES.forEach((w, i) => {
    const hl = w.length / 2, hw = w.width / 2, X0 = -hl + 0.35, X1 = X0 + WH.officeD, Z0 = -hw + 0.35, Z1 = WH.officeZ1, seed = 9100 + i * 17;
    // the site office (door + window on its +z wall, a window in its front wall)
    { const cx = (X0 + X1 - 0.2) / 2, cz = (Z0 + Z1) / 2;
      out.push(room(w.x, w.z, w.yaw, cx, cz, { id: `${w.id}-office`, y: APRON_Y, w: X1 - 0.2 - X0, d: Z1 - Z0, h: WH.deckY - 0.3, style: "lab", role: "office", seed,
        openings: [{ side: 0, at: X1 - 1.15 - cx, w: 1.2, kind: "door" }, { side: 0, at: X0 + 1.5 - cx, w: 1.6, kind: "window", y0: 1.0, h: 1.2 }, { side: 1, at: -8.9 - cz, w: 1.6, kind: "window", y0: 1.0, h: 1.2 }],
        finish: { ...bare, wall: "#e4e6df" } })); }
    // the open bays (no partitions: every side but the shed's own walls is an open gap): one beside the office at the −x
    // gable, two flanking the +x gable's big door. Each < 40 m² so the kit dresses them as workshops (benches, lockers,
    // crates, drums) — its 2.7 m racks under the 10 m vault would be covered floors only a jump reaches (scanner)
    const bay = (id: string, x0: number, x1: number, z0: number, z1: number, wallSide: 1 | 3, seedK: number) => {
      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, sides: RoomOpening["side"][] = [0, 1, 2, 3];
      const outerZ = z1 > hw - 0.5 ? 0 : z0 < -hw + 0.5 ? 2 : -1;
      out.push((room(w.x, w.z, w.yaw, cx, cz, { id: `${w.id}-${id}`, y: APRON_Y, w: x1 - x0, d: z1 - z0, h: 2.6, style: "warehouse", role: "workshop", seed: seed + seedK, openTop: true, density: 0.9,
        openings: sides.filter((sd) => sd !== wallSide && sd !== outerZ).map((sd): RoomOpening => ({ side: sd, at: 0, w: (sd === 0 || sd === 2 ? x1 - x0 : z1 - z0) - 0.4, kind: "gap" })),
        finish: { ...bare, floor: "none", ceiling: "none", baseboard: false, dado: null } })));
    };
    bay("bay-w", X0, -hl + 5.5, 3.0, hw - 0.35, 3, 1);
    bay("bay-ne", hl - 5.35, hl - 0.35, Z0, -3.0, 1, 2);
    bay("bay-se", hl - 5.35, hl - 0.35, 3.0, hw - 0.35, 1, 3);
  });
  // the pump house (door −x; the two pumps stay as the POI's machines — kept out)
  { const P = PUMP_HOUSE, t = 0.22;
    out.push(room(P.x, P.z, 0, 0, 0, { id: "pump-house", y: APRON_Y, w: P.w - 2 * t, d: P.d - 2 * t, h: P.h, style: "warehouse", role: "workshop", seed: 9301,
      openings: [{ side: 3, at: 0, w: 1.3, kind: "door" }, { side: 0, at: 0, w: 2.4, kind: "window", y0: 1.9, h: 1.2 }, { side: 1, at: -1.2, w: 1.6, kind: "window", y0: 1.2, h: 1.2 }],
      keepOut: [[-2.45, 1.25, 2.65, P.d / 2 - t]], finish: { ...bare, ceiling: "none" } })); }
  // the gate's scale house (door −x at z −0.9)
  for (const p of PROPS) if (p.kind === "scale-house") {
    const q = Math.round(p.yaw / (Math.PI / 2)) * (Math.PI / 2), t = 0.22;
    out.push(room(p.x, p.z, q, 0, 0, { id: "scale-house", y: APRON_Y, w: 6.2 - 2 * t, d: 4.2 - 2 * t, h: 3.0, style: "lab", role: "office", seed: 9311,
      openings: [{ side: 3, at: -0.9, w: 1.1, kind: "door" }, { side: 0, at: 0.6, w: 3.2, kind: "window", y0: 1.2, h: 1.2 }, { side: 2, at: 0.6, w: 3.2, kind: "window", y0: 1.2, h: 1.2 }, { side: 1, at: 0, w: 2.4, kind: "window", y0: 1.2, h: 1.2 }],
      finish: { ...bare, ceiling: "none" } }));
  }
  // the ship's accommodation: each deck split port / starboard by the central corridor (the stairwell) and fore / aft
  // (by a bulkhead with a door — the aft room is reached through the fore one): mess + lounge / galley + mess (main deck), four crew cabins on each of the next
  // two decks, the chief's offices + the captain's day room and bedroom, the bridge (its consoles stay) + chart room
  { const L = shipLevels(), T = 0.3, F = SHIP_FRAME(), sw = stairwell(-5.95, 0, 0, SHIP_DECK_H, L.length, "steel"), [wx0, wx1, wz0, wz1] = sw.well;
    type SR = [InteriorRoom["style"], InteriorRoom["role"]];
    // [level] → [port aft, port fore, starboard aft, starboard fore]
    // a modern banana freighter's crew, not pirates — mess / lounge / galley, crew cabins (beds,
    // wardrobes, desks), the ship's office + the master's day room and cabin, the bridge + chart room as dock offices
    const kinds: SR[][] = [
      [["house", "dining"], ["house", "living"], ["house", "kitchen"], ["house", "dining"]],
      [["house", "bedroom"], ["house", "bedroom"], ["house", "bedroom"], ["house", "bedroom"]],
      [["house", "bedroom"], ["house", "bedroom"], ["house", "bedroom"], ["house", "bedroom"]],
      [["lab", "office"], ["lab", "dock"], ["lab", "office"], ["house", "bedroom"]],
      [["lab", "dock"], ["lab", "dock"], ["lab", "dock"], ["lab", "dock"]]];
    L.forEach((v, l) => {
      const X0 = v.xa + T, X1 = v.xb - T;
      for (const side of [-1, 1] as const) {
        const zi = v.bridge ? (side < 0 ? wz0 - 0.05 : wz1 + 0.05) : side * (SHIP_CORR + 0.1), zo = side * (v.hw - T), z0 = Math.min(zi, zo), z1 = Math.max(zi, zo), cz = (z0 + z1) / 2;
        const xp = shipXm(v), parts: Array<[number, number, number]> = v.bridge ? [[X0, X1, 0]] : [[X0, xp - 0.1, 0], [xp + 0.1, X1, 1]];
        for (const [x0, x1, fore] of parts) {
          const cx = (x0 + x1) / 2, doors: RoomOpening[] = [];
          if (fore || v.bridge) for (const dz of l === 0 ? [-4, 4] : [-6.1]) if (dz > z0 && dz < z1) doors.push({ side: 1, at: dz - cz, w: 1.0, kind: "door" });
          if (!fore && l === 0 && 3.1 > z0 && 3.1 < z1) doors.push({ side: 3, at: 3.1 - cz, w: 1.0, kind: "door" });
          if (!v.bridge) { const [d0, d1] = shipPartDoor(v, l, side); doors.push({ side: fore ? 3 : 1, at: (d0 + d1) / 2 - cz, w: d1 - d0, kind: "door" }); }
          // the corridor side: its door (the bridge has no partition: open to the stairwell along its length)
          const dc = (SHIP_CORR_DOOR[0] + SHIP_CORR_DOOR[1]) / 2;
          if (v.bridge) doors.push({ side: side < 0 ? 0 : 2, at: 0, w: x1 - x0 - 0.3, kind: "gap" });
          else if (dc > x0 && dc < x1) doors.push({ side: side < 0 ? 0 : 2, at: dc - cx, w: SHIP_CORR_DOOR[1] - SHIP_CORR_DOOR[0], kind: "door" });
          if (!v.bridge) { const [la0, la1] = shipLandingDoor(v), lc = (la0 + la1) / 2; if (lc > x0 && lc < x1) doors.push({ side: side < 0 ? 0 : 2, at: lc - cx, w: la1 - la0, kind: "door" }); }
          const keep: InteriorRoom["keepOut"] = v.bridge ? [{ r: [wx0 - 1.35 - cx, Math.max(z0, wz0 - 0.1) - cz, Math.min(x1, wx1 + 0.1) - cx, Math.min(z1, wz1 + 0.1) - cz], walk: true }, [x1 - 1.3 - cx, z0 - cz, x1 - cx, z1 - cz]] : [];
          if (!v.bridge) { const q = shipIsland(v, l, side, fore); keep.push({ r: [q.x0 - cx, q.z0 - cz, q.x1 - cx, q.z1 - cz], solid: true }, [q.x0 - 0.8 - cx, q.z0 - 0.8 - cz, q.x1 + 0.8 - cx, q.z1 + 0.8 - cz]); }
          // the hull's windows are the rooms' windows too (the panelled liner leaves them open, not blind frames)
          const W = shipWindows(v, l), win = (o: Opening, sd: RoomOpening["side"], c: number): RoomOpening => ({ side: sd, at: (o.a0 + o.a1) / 2 - c, w: o.a1 - o.a0, kind: "window", y0: o.y0 - v.y0, h: o.y1 - o.y0 });
          const inZ = (o: Opening) => o.a0 > z0 + 0.05 && o.a1 < z1 - 0.05, inX = (o: Opening) => o.a0 > x0 + 0.05 && o.a1 < x1 - 0.05;
          for (const o of W.side) if (inX(o)) doors.push(win(o, side < 0 ? 2 : 0, cx));
          if (fore || v.bridge) for (const o of W.fore) if (inZ(o)) doors.push(win(o, 1, cz));
          if (!fore || v.bridge) for (const o of W.aft) if (inZ(o)) doors.push(win(o, 3, cz));
          const [hx, , hz] = qPoint(F, cx, 0, cz), [x, z] = toWorld(hx, hz), k = (side < 0 ? 0 : 2) + fore, [st, role] = kinds[l][k];
          out.push({ id: `ship-${l}${side < 0 ? "p" : "s"}${v.bridge ? "" : fore ? "f" : "a"}`, x, y: SHIP.deckY + v.y0, z, yaw: F.yaw + FRAME.yaw, w: x1 - x0, d: z1 - z0, h: SHIP_DECK_H - 0.25, style: st, role, seed: 9400 + l * 4 + k,
            openings: doors, keepOut: keep, density: v.bridge ? 0.55 : 1,
            // (painted steel-panel bulkheads: light plaster-look paint over a blue-grey dado, lino tiles, a drop ceiling)
            finish: { ...bare, floor: "tiles", wallMat: "plaster", wall: v.bridge ? "#e4e8e7" : l === 0 ? "#ece6d6" : "#eae6dc", dado: "#5b6f7a", baseboard: true, frames: false, glass: false, curtains: false, ceiling: "grid" } });
        }
      }
    });
  }
  AUTHORED.push(...out);
  return out.map((r) => pickSeed(r));
})();

/** the furnished rooms' colliders + loot slots (one entry per INTERIOR_ROOMS room), from the bake when it is current */
export const ROOMS_FURNISHED = bakedRooms("peel-harbor", INTERIOR_ROOMS, (BAKE as unknown as { rooms?: RoomBake }).rooms);
/** the drawn layouts of INTERIOR_ROOMS from the bake (client: buildInteriors({ layouts })), undefined where stale */
export const ROOM_LAYOUTS = (): ReturnType<typeof bakedLayouts> => bakedLayouts(INTERIOR_ROOMS, (BAKE as unknown as { rooms?: RoomBake }).rooms);
export const colliders: Box[] = [
  ...[...localColliders, ...rockBoxes()].map(boxToWorld),
  ...apronEdgeBoxes(),
  ...tankRailBoxes(),
  ...tankBoxes(),
  ...PROPS.flatMap(propBoxes),
  ...WAREHOUSES.flatMap(hallPropBoxes),
  ...pumpSetBoxes(),
  ...cappingBoxes(),
  ...forecastleBreakwater(),
  ...pipeRackBoxes(),
  ...fenceBoxes(),
  // the furnished rooms' furniture (cover) — baked
  ...ROOMS_FURNISHED.flatMap((r) => r.colliders),
  // jungle trees growing out of the cracked slab: trunks
  // (a regular OCTAGON — four slabs, two crosses 45° apart, corners on the bark — round the round trunk (palm r 0.26, broadleaf
  // 0.42): one yawed square's corners stood 0.14–0.22 m proud of the bark, grazing shots hit air)
  ...JUNGLE_TREES.flatMap((t) => { const a = (t.kind === "palm" ? TRUNK_R.palm : TRUNK_R.tree) * dmath.cos(Math.PI / 8), w = a * dmath.tan(Math.PI / 8); return [0, Math.PI / 4].flatMap((y) => [yawBoxWorld(t.x, APRON_Y, t.z, a, 4, w, y, "wood"), yawBoxWorld(t.x, APRON_Y, t.z, w, 4, a, y, "wood")]); }),
];

/** vegetation keep-out (WORLD, axis-aligned): the apron, the berth + ship, the pier foot */
export const clearings: Array<{ x: number; z: number; r: number } | { x: number; z: number; hx: number; hz: number; yaw?: number }> = (() => {
  const out: Array<{ x: number; z: number; r: number } | { x: number; z: number; hx: number; hz: number }> = [];
  // apron: 20 m strips in local z, spanning the polygon's x range (+4 m)
  for (let z = 40; z < 470; z += 20) {
    let lo = Infinity, hi = -Infinity;
    for (let x = 500; x <= 900; x += 2) if (onApron(x, z + 10) || onApron(x, z) || onApron(x, z + 20)) { lo = Math.min(lo, x); hi = Math.max(hi, x); }
    if (hi > lo) { const [wx, wz] = toWorld((lo + hi) / 2, z + 10); out.push({ x: wx, z: wz, hx: 14, hz: (hi - lo) / 2 + 4 }); }
  }
  const [sx, sz] = toWorld(SHIP.x, SHIP.z);
  out.push({ x: sx, z: sz, hx: SHIP.length / 2 + 6, hz: SHIP.beam / 2 + 6 });
  const [px, pz] = toWorld(PIER.x1, PIER.z);
  out.push({ x: px, z: pz, r: 14 });
  // the granite domes on the west headland
  for (const k of HILL_ROCKS) { const [hx, hz] = toWorld(k.x, k.z); out.push({ x: hx, z: hz, r: k.r * 1.05 }); }
  const [tx, tz] = toWorld((TANK_BUND.x0 + TANK_BUND.x1) / 2, (TANK_BUND.z0 + TANK_BUND.z1) / 2);
  out.push({ x: tx, z: tz, hx: (TANK_BUND.z1 - TANK_BUND.z0) / 2 + 8, hz: (TANK_BUND.x1 - TANK_BUND.x0) / 2 + 8 });
  return out;
})();

// ---------------------------------------------------------------- designed loot (the LOOT_SPOTS contract)
/** Chests inside every building (warehouse site offices + mezzanines, the pump house, the scale house, both crane
 *  machinery houses, the ship's mess + bridge, the enterable boxes' closed ends); floor loot on the rack tops, the
 *  crane cabs, the tank roofs, the stair-tower tops, the booths, the warehouse roofs, the ship deck and the pier.
 *  Authored per room in harbor-local coordinates; y settles onto the shared colliders' floor (world metres). The match
 *  generator activates a seeded subset per match (designed spots are hints). */
export const LOOT_SPOTS: { chests: Array<[number, number, number, number]>; floor: Array<[number, number, number]> } = (() => {
  const bl = (BAKE as unknown as { loot?: { sig: string; chests: Array<[number, number, number, number]>; floor: Array<[number, number, number]> } }).loot;
  if (bl && bl.sig === boxesSig(colliders)) return { chests: bl.chests, floor: bl.floor };
  return lootSpotsLive();
})();
/** LOOT_SPOTS computed from the layout (the bake tool writes its result into peel-harbor-baked.json) */
export function lootSpotsLive(): { chests: Array<[number, number, number, number]>; floor: Array<[number, number, number]> } {
  const near = boxGrid(colliders);
  const chests: Array<[number, number, number, number]> = [], floor: Array<[number, number, number]> = [];
  const W = (lx: number, y: number, lz: number): [number, number, number] => { const [x, z] = toWorld(lx, lz); return [x, floorUnder(near(x, z), x, y, z), z]; };
  /** a chest at harbor-local (lx, lz), its front toward harbor-local (fx, fz) */
  const chest = (lx: number, y: number, lz: number, fx: number, fz: number) => {
    const p = W(lx, y, lz), [tx, tz] = toWorld(fx, fz);
    chests.push([p[0], p[1], p[2], faceYaw(p[0], p[2], tx, tz)]);
  };
  const item = (lx: number, y: number, lz: number) => floor.push(W(lx, y, lz));
  // warehouses: the site office (every shed), the mezzanine over it (every other shed), the −z rack top, the roof ridge
  WAREHOUSES.forEach((w, i) => {
    const hl = w.length / 2, X0 = -hl + 0.35, D = APRON_Y + WH.deckY;
    const at = (lx: number, lz: number) => whToWorld(w, lx, lz);
    if (i % 2 === 0) { const [x, z] = at(X0 + 1.7, -8.6), [fx, fz] = at(X0 + 3.4, -8.6); chest(x, D, z, fx, fz); }
    { const [x, z] = at(2.0, RACK.rowsZ[0]); item(x, D, z); }
    if (i % 2 === 1) { const [x, z] = at(-6, 0.4); item(x, APRON_Y + archY(w, 0) + 0.3, z); }
    { const [x, z] = at(6, 0); item(x, APRON_Y, z); }
  });
  // the furnished rooms (offices, the pump house, the scale house, the ship's decks, every other storage bay): the kit's
  // own reachable chest slot + a floor slot per room
  INTERIOR_ROOMS.forEach((r, i) => {
    const l = ROOMS_FURNISHED[i].loot, id = r.id ?? "", bayR = id.includes("-bay-"), ship = id.startsWith("ship-");
    // (the ship is the harbor's hot drop — a chest on every deck of the house, both bridge wings' chart tables,
    // floor loot in every one of its rooms)
    const chestHere = ship ? /^ship-(0sa|0pf|1pa|2pf|3sa|4p|4s)$/.test(id) : !bayR || (id.endsWith("bay-ne") && i % 2 === 0);
    if (l.chests.length && chestHere) chests.push(l.chests[0]);
    if (l.floor.length) floor.push(l.floor[l.floor.length - 1]);
  });
  // the booths
  for (const p of PROPS) {
    if (p.kind === "booth") { const f: QFrame = { x: p.x, y: APRON_Y, z: p.z, yaw: Math.round(p.yaw / (Math.PI / 2)) * (Math.PI / 2) }; const a = qPoint(f, -0.25, 0, -0.55); item(a[0], APRON_Y, a[2]); }
  }
  // the crane machinery houses (hoist room) + the operator cabs
  CRANE.zs.forEach((cz, idx) => {
    const hx = (CRANE.house.x0 + CRANE.house.x1) / 2;
    chest(hx + 3.8, CRANE.house.y0, cz + 1.35, hx + 3.8, cz);
    item(CRANE.trolleyX[idx] + CRANE.cabin.dx - 0.9, CRANE.cabin.y0, cz - 0.7);
  });
  // the tank roofs (the east tank's stair tops out there; bridges join the others)
  for (const t of TANKS) item(t.x + t.r * 0.6, APRON_Y + t.h + 0.62, t.z);
  // the ship's open decks: by the house, the three hatch plazas, the two perches, the forecastle (a chest up the stair)
  item(SHIP.x + 4, SHIP.deckY, SHIP.house.z + SHIP.house.halfL + 2.2);
  { const y0 = SHIP.deckY + SHIP_HATCH_H, B = SHIP_BAYS;
    item(SHIP.x + 1.6, y0 + 0.2, B[1] + 0.6); item(SHIP.x - 1.8, y0 + 0.2, B[4] + 0.4); item(SHIP.x + 0.4, y0 + 0.2, B[7] - 0.6);
    item(SHIP.x - 2.6, y0 + H1 + 0.2, B[0] + 2); item(SHIP.x + 2.6, y0 + H1 + 0.2, B[3] + 2); }
  item(SHIP.x + 2.2, FC_DECK + 0.2, FC_FRONT + 1.6);
  // (the ship's open-deck chests go FIRST in the list — the loot system makes the first two designed chests
  // outside rooms the POI's HERO chests, live every match: the forecastle + the aft-plaza box. The ship lies 213–229 m
  // from the POI centre, beyond its 190 m radius, where nothing else of the loot system reaches)
  const c0 = chests.length;
  chest(SHIP.x - 2.4, FC_DECK + 0.2, FC_FRONT + 1.4, SHIP.x - 2.4, FC_FRONT - 4);
  // the mid plaza's chest on the hatch, facing the aisle (the second hero: live every match, in the open — contested)
  chest(SHIP.x + 3.0, SHIP.deckY + SHIP_HATCH_H + 0.2, SHIP_BAYS[4] + 1.0, SHIP.x, SHIP_BAYS[4] + 1.0);
  // the deck's enterable boxes: a chest against the cargo wall at the back of every one, floor loot inside the doors
  for (const p of SHIP_ENTER) {
    const L2 = containerDims(p).L / 2, c = dmath.cos(p.yaw), sn = dmath.sin(p.yaw), P = (u: number): [number, number] => [p.x + u * c, p.z - u * sn];
    { const [x, z] = P(-L2 + 2.35), [fx, fz] = P(L2); chest(x, p.y + 0.22, z, fx, fz); }
    { const [x, z] = P(L2 * 0.35); item(x, p.y + 0.22, z); }
  }
  chests.unshift(...chests.splice(c0));
  // the enterable containers: a chest at the closed end of every third one, floor loot mid-box in the others
  CONTAINERS.filter((p) => p.enter).forEach((p, i) => {
    const L2 = containerDims(p).L / 2, c = dmath.cos(p.yaw), s = dmath.sin(p.yaw);
    const P = (u: number): [number, number] => [p.x + u * c, p.z - u * s];
    // (in front of the carton stacks at the closed end — containers-geo / containerBoxes)
    if (i % 3 === 0) { const [x, z] = P(-L2 + 2.35), [fx, fz] = P(L2); chest(x, p.y + 0.22, z, fx, fz); }
    else if (i % 3 === 1) { const [x, z] = P(-L2 * 0.3); item(x, p.y + 0.22, z); }
  });
  // stair-tower tops (container roofs) + the pier head
  for (const t of STAIR_TOWERS.slice(0, 6)) { const st = towerStair(t), [x, z] = st.toLocal(3.2, -0.9); item(x, t.top, z); }
  item((PIER.head.x0 + PIER.head.x1) / 2, PIER.deckY, (PIER.head.z0 + PIER.head.z1) / 2);
  // floor loot never sits against a low prop / pallet edge (a kong picking it up would be lifted onto it)
  return { chests, floor: floor.filter((f) => noLowStep(near(f[0], f[2]), f[0], f[1], f[2], 1.0, 0.1, 0.6)) };
}
