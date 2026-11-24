// POI the-wreck — the BANANA CO. freighter aground on the west reef, broken in two; containers spilled across the
// shallows and the beach. ONE layout for visuals (client/src/world/pois/the-wreck) and collision (server + prediction).
// Coast here runs N–S: shoreline x ≈ −842 (terrain promise, WRECK_BEACH), beach rising east, shallows −1…−5 m west.
//
// Composition: the view camera stands on the north beach (4.5 m) looking SSW out to sea. The BOW half lies on the
// left, beached: its bow dug into the sand near the camera, the hull rising along the reef to the torn break (BANANA
// CO. on the flank that faces the beach). The STERN half lies to the right, broadside, listing away, its torn end
// facing the bow half across a gap of open water (the horizon shows between them). Both halves carry a white
// superstructure with a yellow funnel and a yellow mast. Containers are tumbled around the break, in the shallows and
// up the beach, doors burst open with bananas pouring out.
//
// SECTION FRAME: local x along the hull from the intact end (bow stem / stern transom, x = 0) to the break (x = L),
// y up from the keel, z across the beam (+z = starboard). world = P + Ry(yaw)·Rz(pitch)·Rx(roll)·local (three.js
// Euler order "YZX", the container convention). +pitch raises the break end, +roll lowers the +z side.
import type { Box } from "../world/colliders";
import { furnishRoom, type InteriorRoom, type RoomOpening } from "./interior-kit";
import { mulberry32 } from "../world/noise";
import ROCKS_BAKED from "./harbor-rocks-baked.json";
import { bakedRockBoxes, hash01, rockSig, type RockBake, type RockPl, type RockSet, boxGrid, capsuleClear, noLowStep, clearSpot, floorUnder, containerBoxes, faceYaw, fitBox, fitError, flight, patchBox, railRun, slabXYZ, solidColumns, stairwell, floorWithHoles, type ContainerColor, type ContainerPlacement, type Piece, type PieceMat, type V3 } from "./harbor-kit";
import * as dmath from "../sim/dmath";

export interface HullSection {
  id: "bow" | "stern";
  /** world position of the local origin (keel line at the intact end) */
  x: number; y: number; z: number;
  yaw: number; pitch: number; roll: number;
  /** length intact end → break, beam, depth keel → main deck */
  length: number; beam: number; depth: number;
  /** superstructure block: local x range, half-width, levels (2.9 m each), funnel x, mast x */
  house: { x0: number; x1: number; halfW: number; levels: number; funnelX: number; mastX: number };
  /** the broken hatch (deck open into the hold between these local x) + intact hatch covers */
  openHatch: [number, number]; hatches: Array<[number, number]>;
  /** funnel: rounded-rectangle casing half-length (along x) × half-width, height above the deck; `taper` = how much
   *  narrower the top is (fraction, default 0.07), `round` = corner radius / the smaller half-size (default 0.62) */
  funnel: { hx: number; hz: number; h: number; taper?: number; round?: number };
  /** which side (±1 = ±z) faces the beach / the camera (name letters, climbing debris) */
  beachSide: 1 | -1;
}

export const SHIP = { name: "BANANA CO.", beam: 18, depth: 11 };

/** the composition anchor: the view camera stands on the upper beach here looking SW. Spill and
 *  dressing are placed by bearing (deg, + = right) and distance from it so the frame keeps its composition. */
export const COMP = { x: -831.5, z: 63.5, fx: -0.5, fz: Math.sqrt(3) / 2 };
export function fromCam(d: number, deg: number): [number, number] {
  const t = (deg * Math.PI) / 180, c = dmath.cos(t), s = dmath.sin(t);
  const rx = -COMP.fz, rz = COMP.fx; // camera right (three.js: forward × up)
  return [COMP.x + d * (c * COMP.fx + s * rx), COMP.z + d * (c * COMP.fz + s * rz)];
}

/** a section placed from two ground points: its intact end (origin) and where its axis points (the break) */
function place(id: "bow" | "stern", from: [number, number], to: [number, number], y: number, pitch: number, roll: number, length: number, house: HullSection["house"], beachSide: 1 | -1, o: Pick<HullSection, "openHatch" | "hatches" | "funnel">): HullSection {
  return { id, x: from[0], y, z: from[1], yaw: dmath.atan2(-(to[1] - from[1]), to[0] - from[0]), pitch, roll, length, beam: 25, depth: 19, house, beachSide, ...o };
}
/** the house reaches the break: its torn end stands open (rooms exposed, floors sticking out) */
export const houseTorn = (s: HullSection) => s.house.x1 > s.length - 3;
/** depth of the exposed rooms behind a torn house end (floor only — you can walk in) */
export const TORN_ROOM = 3.2;
/** bow half: stem dug into the sand on the left of the frame, hull rising (0.26 rad ≈ 15°) along the reef to the break
 *  at the frame centre, which rests on the reef rocks */
// (at a steeper 0.4 rad ≈ 23°, every floor of the bow's house, its scissor stair and the deck would become ramps of
// yaw-only collider tiles: kongs slide, the stair treads lean along the flight's side. 15° still reads as the beached,
// rising bow; the stem stays dug in)
export const BOW: HullSection = place("bow", fromCam(104, -26.5), fromCam(95, 1), -19.6, 0.26, 0.08, 57,
  { x0: 25, x1: 40, halfW: 9.4, levels: 3, funnelX: 20.5, mastX: 29 }, 1,
  // (the bow's hatch is closed — its hold is packed solid, see bowCoreStrips)
  { openHatch: [0, 0], hatches: [[10.5, 16]], funnel: { hx: 2.9, hz: 2.1, h: 13.5 } });
/** stern half: broadside on the right (its stern at 102 m, +33°), listing away, torn end facing the bow half */
export const STERN: HullSection = place("stern", fromCam(128, 34), fromCam(104, 13), -4.2, 0.03, -0.1, 54,
  { x0: 33, x1: 52.5, halfW: 9.8, levels: 3, funnelX: 28.8, mastX: 44 }, -1,
  // a chunky tapered stern funnel: longer fore-aft, squarer corners, 30 % narrower at the top
  { openHatch: [19.2, 24.2], hatches: [[4.5, 9.5], [19.2, 24.2]], funnel: { hx: 3.6, hz: 2.2, h: 13, taper: 0.3, round: 0.3 } });
export const SECTIONS: HullSection[] = [BOW, STERN];

// ---------------------------------------------------------------- section math (shared by visuals + colliders)
/** local → world point of a section */
export function sectionToWorld(s: HullSection, x: number, y: number, z: number): [number, number, number] {
  const cr = dmath.cos(s.roll), sr = dmath.sin(s.roll), cp = dmath.cos(s.pitch), sp = dmath.sin(s.pitch), cy = dmath.cos(s.yaw), sy = dmath.sin(s.yaw);
  const y1 = y * cr - z * sr, z1 = y * sr + z * cr;           // Rx(roll)
  const x2 = x * cp - y1 * sp, y2 = x * sp + y1 * cp;           // Rz(pitch)
  return [s.x + x2 * cy + z1 * sy, s.y + y2, s.z - x2 * sy + z1 * cy]; // Ry(yaw)
}

/** the stern's transom knuckle (fraction of the depth): above it a flat transom, below it the run to the skeg */
export const STERN_KNUCKLE = 0.5;
/** where the intact end's stem / transom is at height y (the bow stem rakes forward, the stern overhangs) */
export function endX(s: HullSection, y: number): number {
  const t = Math.max(0, Math.min(1, y / s.depth));
  if (s.id === "bow") return 8.5 * dmath.pow(1 - t, 1.4);
  // the stern: a raked flat TRANSOM above the knuckle (u ≥ 0.5), below it the run sweeps up from the skeg under the
  // counter (the propeller + rudder sit in the space it leaves)
  return t >= STERN_KNUCKLE ? 1.2 * (1 - t) : 1.2 * (1 - STERN_KNUCKLE) + 9.5 * dmath.pow((STERN_KNUCKLE - t) / STERN_KNUCKLE, 0.9);
}
/** half-breadth of a section at local (x, y); 0 outside the hull */
export function halfBreadth(s: HullSection, x: number, y: number): number {
  const x0 = endX(s, y);
  if (x < x0 - 1e-4) return 0;
  const u = Math.max(0, Math.min(1, y / s.depth));
  const B = s.beam / 2;
  const bilge = u < 0.18 ? Math.sqrt(Math.max(0, 1 - dmath.pow((0.18 - u) / 0.18, 2))) : 1;
  if (s.id === "bow") {
    const t = Math.min(1, (x - x0) / 27);
    const plan = 1 - dmath.pow(1 - t, 2.2);
    const vsec = Math.min(1, dmath.pow(u / 0.9, 0.7)), e = dmath.pow(1 - t, 1.5);
    const flare = 1 + 0.08 * e * Math.max(0, (u - 0.6) / 0.4);
    return B * plan * (bilge * (1 - e) + vsec * e) * flare;
  }
  // the stern: a transom stern — at the transom (x0) the hull is already 60–92 % of its beam (a flat raked plate across
  // the stern above the knuckle), below the knuckle the sections narrow to a V at the skeg; the plan fills out to the
  // full beam over 14 m
  const t = Math.min(1, (x - x0) / 14);
  const w0 = u >= STERN_KNUCKLE ? 0.6 + 0.32 * (u - STERN_KNUCKLE) / (1 - STERN_KNUCKLE) : 0.6 * dmath.pow(u / STERN_KNUCKLE, 0.8);
  const plan = w0 + (1 - w0) * (1 - dmath.pow(1 - t, 2));
  return Math.max(0, B * plan * bilge);
}
/** deck height (local y) at local x — the bow half's forecastle rises toward the stem */
export function deckY(s: HullSection, x: number): number {
  return s.id === "bow" ? s.depth + dmath.pow(Math.max(0, 1 - x / 14), 1.6) * 2.6 : s.depth;
}
/** where the torn shell ends (local x) at a given height + side: the break is ragged (plates torn back 0–3 m) */
export function breakX(s: HullSection, y: number, side: number): number {
  const k = dmath.sin(y * 1.7 + side * 2.1 + (s.id === "bow" ? 0 : 3)) * 0.5 + dmath.sin(y * 4.3 - side) * 0.3;
  return s.length - 1.6 + k * 1.6 - (y > s.depth - 1 ? 1.2 : 0);
}

// ---------------------------------------------------------------- ground (server-safe approximation of the baked beach)
/** shoreline x (height 0) by z along the wreck beach — traced from the baked terrain */
const SHORE: Array<[number, number]> = [[-40, -838], [0, -839], [20, -841.5], [30, -843.5], [60, -845.5], [90, -845], [110, -842.5], [120, -843], [130, -839], [140, -837], [150, -833], [160, -827], [170, -820], [180, -808.5], [190, -790.5], [200, -776.5], [220, -754.5], [240, -732.5], [280, -712]];
function shoreAt(z: number): { x: number; k: number } {
  let i = 0; while (i < SHORE.length - 2 && z > SHORE[i + 1][0]) i++;
  const [z0, x0] = SHORE[i], [z1, x1] = SHORE[i + 1], t = Math.max(0, Math.min(1, (z - z0) / (z1 - z0)));
  const dxdz = (x1 - x0) / (z1 - z0);
  return { x: x0 + (x1 - x0) * t, k: 1 / dmath.hypot(1, dxdz) };
}
/** ground height (m) near the wreck — matches the baked terrain within ~0.4 m for x∈[−960,−760], z∈[0,240]. Used for
 *  BOTH the spilled containers' visuals and their colliders (so what you see is what you hit). */
export function groundY(x: number, z: number): number {
  const s = shoreAt(z), d = (x - s.x) * s.k;
  if (d >= 0) return d < 10 ? 0.05 * d : Math.min(4, 0.5 + 0.077 * (d - 10));
  return Math.max(-10, 0.072 * d);
}

// ---------------------------------------------------------------- spilled containers
/** a container at a camera bearing/distance, resting on the ground: its lowest bottom corner `sink` m into the sand (or
 *  on the seabed/reef under the water, lifted by `lift` m where it lies on rocks or other boxes) */
function CC(d: number, deg: number, yaw: number, color: ContainerColor, o: Partial<ContainerPlacement> & { sink?: number; lift?: number; floor?: number } = {}): ContainerPlacement {
  const [x, z] = fromCam(d, deg);
  const { sink = 0.3, lift = 0, floor = -9, ...rest } = o;
  const p: ContainerPlacement = { x, z, y: 0, yaw, color, ...rest };
  const L = (p.size ?? 40) === 20 ? 6.058 : 12.192, W = 2.438;
  // lowest bottom corner of the tilted box relative to the placement origin (translate · Ry · Rz(pitch) · Rx(roll))
  const pitch = p.pitch ?? 0, roll = p.roll ?? 0;
  let low = Infinity, gy = -Infinity;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const lx = (sx * L) / 2, lz = (sz * W) / 2;
    const y1 = lz * dmath.sin(roll), z1 = lz * dmath.cos(roll);
    const x2 = lx * dmath.cos(pitch) - y1 * dmath.sin(pitch), y2 = lx * dmath.sin(pitch) + y1 * dmath.cos(pitch);
    low = Math.min(low, y2);
    const c = dmath.cos(yaw), s = dmath.sin(yaw);
    gy = Math.max(gy, Math.max(floor, groundY(x + x2 * c + z1 * s, z - x2 * s + z1 * c)));
  }
  p.y = gy - sink + lift - low;
  return p;
}
const D2R = Math.PI / 180;
/** three.js yaw that points a container's DOOR end (+X) back at the view camera from (d, deg) — plus `off` radians */
function faceCam(d: number, deg: number, off = 0): number {
  const [x, z] = fromCam(d, deg);
  return dmath.atan2(-(COMP.z - z), COMP.x - x) + off;
}
/**
 * The spill: two tumbled HEAPS, 2–3 boxes high — one against the bow's buried stem (frame left), one
 * choking the gap under the break (frame centre) — plus a few strays: the red 20 ft on its side in the foreground sand
 * (doors burst toward the camera, fruit pouring out), a teal box half-sunk in the lagoon, the red box standing on end
 * in the shallows (right) and a red + yellow pair nearer the beach. Open doors face the camera. ~27 boxes.
 */
export const CONTAINERS: ContainerPlacement[] = [
  // ---- foreground sand (frame bottom centre): a red 20 ft on its side, doors burst toward us
  CC(27, 4, faceCam(27, 4, 0.35), "red", { size: 20, roll: 0.12, pitch: 0.05, open: true, sink: 0.25 }),
  // ---- strays on the beach in front of the bow (frame left third), doors toward the camera
  CC(50, -24, faceCam(50, -24, -0.3), "yellow", { open: true, pitch: 0.04, roll: -0.06 }),
  CC(62, -36, faceCam(62, -36, 0.5), "teal", { roll: 0.42, pitch: 0.08, size: 20, sink: 0.5, open: true }),
  // ---- HEAP A against the buried stem (frame left): 8 boxes, 2–3 high, doors spilling toward the beach
  CC(92, -30, 0.9, "yellow", { pitch: 0.03, roll: 0.02 }),
  CC(92.5, -30.5, 1.02, "red", { pitch: 0.06, roll: 0.1, size: 20, lift: 2.55, sink: 0.25 }),
  CC(86, -35, faceCam(86, -35, -0.2), "yellow", { pitch: -0.08, roll: 0.14, open: true }),
  CC(88, -37.5, 2.2, "teal", { pitch: 0.12, roll: 0.35, lift: 2.2, sink: 0.4 }),
  CC(97, -35, 2.6, "red", { pitch: 0.18, roll: 0.1, sink: 0.6 }),
  CC(99, -38, 2.55, "green", { pitch: 0.28, roll: -0.2, size: 20, lift: 2.5, sink: 0.3 }),
  CC(80, -31, faceCam(80, -31, 0.25), "yellow", { size: 20, open: true, roll: 0.05, pitch: -0.06 }),
  CC(84, -26, 1.9, "blue", { pitch: -0.2, roll: 1.1, sink: 0.5 }),
  // ---- the lagoon (frame centre): one half-sunk teal, a tipped yellow 20 ft pouring fruit, a red on its side
  CC(44, -3, faceCam(44, -3, 0.3), "red", { pitch: 0.2, roll: 0.34, open: true, sink: 0.75 }),
  CC(40, 13, faceCam(40, 13, -0.4), "yellow", { pitch: -0.42, roll: 0.12, open: true, size: 20, sink: 0.5, floor: -1.2 }),
  CC(52, 24, 1.9, "teal", { roll: 0.6, pitch: 0.3, sink: 0.95, floor: -1.6 }),
  // ---- HEAP B choking the gap under the break (frame centre): a tumbled pile 3 deep on the reef — a sunk base layer
  // (just under the surface, foam around it), a middle layer resting on it at every angle (2–3 m out of the water), a
  // top layer thrown over them, one box leaning on the torn hull; open doors toward the beach pour fruit
  CC(84, -4, 0.4, "red", { pitch: 0.12, roll: 0.2, floor: -2.3, sink: 0.2 }),
  CC(88, 2, 1.9, "teal", { pitch: -0.1, roll: 0.3, floor: -2.3, sink: 0.2 }),
  CC(86, 8, 0.9, "yellow", { pitch: 0.18, roll: -0.15, floor: -2.3, sink: 0.2 }),
  CC(79, 3, 2.6, "blue", { pitch: 0.12, roll: 0.35, floor: -2.1, sink: 0.2 }),
  CC(92, -2, 1.2, "green", { pitch: -0.18, roll: 0.1, floor: -2.4, sink: 0.2 }),
  CC(85, -1.5, faceCam(85, -1.5, 0.25), "yellow", { pitch: 0.22, roll: 0.16, floor: -2.3, lift: 2.35, open: true }),
  CC(88, 5, 2.25, "red", { pitch: -0.28, roll: 0.22, floor: -2.3, lift: 2.45 }),
  CC(80.5, 6.5, 1.45, "teal", { pitch: 0.34, roll: -0.28, floor: -2.1, lift: 1.9, size: 20, open: true }),
  CC(91, 1, 0.25, "blue", { pitch: 0.48, roll: 0.1, floor: -2.4, lift: 2.1 }),
  CC(86.5, 2.5, 1.1, "yellow", { pitch: -0.36, roll: 0.42, floor: -2.3, lift: 4.6, size: 20 }),
  CC(89, -4, 2.5, "red", { pitch: 0.55, roll: 0.2, floor: -2.4, lift: 3.9, size: 20 }),
  CC(76, -2, faceCam(76, -2, -0.35), "green", { pitch: -0.2, roll: 0.25, floor: -1.9, lift: 0.2, open: true }),
  CC(83, 11, 0.6, "yellow", { pitch: 0.3, roll: 1.25, floor: -2.2, lift: 0.4 }),
  CC(97, 10, 0.3, "green", { pitch: 0.7, roll: 0.2, floor: -3.2, lift: 1.6 }),
  // ---- the lagoon in front of the pile: a tipped red pouring fruit toward the beach, a teal on its side
  CC(66, 1, faceCam(66, 1, 0.3), "red", { pitch: -0.32, roll: 0.3, open: true, floor: -1.5, sink: 0.6, lift: 0.2 }),
  CC(70, 11, 1.4, "teal", { pitch: 0.26, roll: 1.35, floor: -1.7, sink: 0.9 }),
  // ---- more of the spill between the lookout and the break (~30 boxes in all): half-sunk in the lagoon at
  // 15–40° (30–60 % under water), tumbled on the beach with sand banked against them, one upside down
  CC(33, -12, faceCam(33, -12, -0.5), "yellow", { open: true, pitch: 0.05, roll: -0.12, sink: 0.35 }),
  CC(38, -3.5, 2.3, "green", { size: 20, roll: 1.05, pitch: 0.08, sink: 0.4 }),
  CC(47, 9, 0.7, "blue", { roll: 0.38, pitch: -0.24, sink: 1.0, floor: -1.2 }),
  CC(55, -8, faceCam(55, -8, 0.35), "yellow", { size: 20, open: true, pitch: 0.3, roll: 0.26, sink: 0.7, floor: -1.2 }),
  CC(60, 5.5, 2.5, "teal", { pitch: 0.3, roll: 0.52, sink: 1.15, floor: -1.5 }),
  CC(44, -30, 0.2, "red", { pitch: 0.14, roll: 0.22, sink: 0.45 }),
  CC(71, 7.5, 2.05, "yellow", { pitch: 0.4, roll: 0.15, sink: 0.5, floor: -1.9, lift: 0.4 }),
  CC(29, 22, faceCam(29, 22, 0.45), "green", { open: true, pitch: -0.04, roll: 0.08, sink: 0.35 }),
  CC(50, 16.5, 1.2, "red", { size: 20, roll: 2.75, pitch: 0.12, sink: 0.55, floor: -1.0 }),
  // ---- right of frame: a red box standing on end in the shallows, a red + yellow pair nearer the beach
  CC(58, 31, 0.3, "red", { pitch: 1.2, roll: 0.05, size: 20, floor: -1.8 }),
  CC(36, 36, faceCam(36, 36, 0.4), "red", { pitch: 0.03, roll: 0.05, open: true, sink: 0.4, floor: -1.0 }), CC(36, 36, faceCam(36, 36, 0.43), "yellow", { pitch: 0.03, roll: 0.05, size: 20, lift: 2.59, sink: 0.4, floor: -1.0 }),
  // ---- two boxes thrown out of the stern's torn hold onto its rubble
  CC(98, 12.5, 2.2, "yellow", { pitch: 0.45, roll: 0.3, floor: -3.2, lift: 1.6, sink: 0.3 }),
  CC(100.5, 7.5, 0.9, "blue", { size: 20, pitch: -0.35, roll: 0.95, floor: -3.4, lift: 2.2, sink: 0.3 }),
  // ---- further out beside the stern half
  CC(118, 22, 1.1, "red", { pitch: 0.5, roll: 1.2, floor: -4 }),
];
void D2R;
/** containers riding on the decks (section-local placements: x along the hull, y above the deck, z across) */
export const DECK_BOXES: Array<{ s: "bow" | "stern"; x: number; z: number; tier: number; color: ContainerColor; yaw: number; open?: boolean }> = [
  { s: "bow", x: 47, z: -4.6, tier: 0, color: "red", yaw: 0.06 }, { s: "bow", x: 47.6, z: 1.6, tier: 0, color: "yellow", yaw: -0.05 },
  { s: "bow", x: 48.4, z: -1.6, tier: 1, color: "teal", yaw: 0.28, open: true },
  { s: "stern", x: 12, z: 3.5, tier: 0, color: "blue", yaw: 0.06 }, { s: "stern", x: 12.5, z: -3.4, tier: 0, color: "yellow", yaw: -0.12, open: true },
];

/** DECK_BOXES as world placements (the container rides the tilted deck: section yaw/pitch/roll + its own small yaw) */
export function deckBoxPlacements(): ContainerPlacement[] {
  return DECK_BOXES.map((d) => {
    const s = d.s === "bow" ? BOW : STERN;
    const p = sectionToWorld(s, d.x, deckY(s, d.x) + d.tier * 2.591, d.z);
    return { x: p[0], y: p[1], z: p[2], yaw: s.yaw + d.yaw, pitch: s.pitch, roll: s.roll, color: d.color, open: d.open };
  });
}

/** reef + beach rocks (world): r radius, moss (algae) 0..1, y = base (else terrain) */
export const ROCKS: Array<{ x: number; z: number; r: number; moss: number; y?: number }> = (() => {
  const r = mulberry32(9090);
  const out: Array<{ x: number; z: number; r: number; moss: number; y?: number }> = [];
  const at = (d: number, deg: number, rad: number, moss: number, lift = 0) => { const [x, z] = fromCam(d, deg); out.push({ x, z, r: rad, moss, y: Math.max(groundY(x, z), -3.4) + lift - rad * 0.2 }); };
  // the reef the bow half's broken end rests on + the rock pile in the gap between the halves
  const brk = sectionToWorld(BOW, BOW.length - 3, 0, 0);
  const dxz = [brk[0] - COMP.x, brk[2] - COMP.z], dB = dmath.hypot(dxz[0], dxz[1]);
  const bB = dmath.atan2(dxz[0] * -COMP.fz + dxz[1] * COMP.fx, dxz[0] * COMP.fx + dxz[1] * COMP.fz) * 180 / Math.PI;
  // (the rising bow lifts its break end — the reef under it is a PILE whose crowns carry the keel: `carry` lifts a
  // rock so its top meets the hull bottom there)
  const keel = brk[1];
  const carry = (d: number, deg: number, rad: number, moss: number, k = 1) => { const [x, z] = fromCam(d, deg); const base = Math.max(groundY(x, z), -3.4) - rad * 0.2; at(d, deg, rad, moss, Math.max(0, (keel - 0.35 - rad * 0.95 - base) * k)); };
  carry(dB, bB, 5.4, 0.7); carry(dB - 4, bB - 4, 4.2, 0.8, 0.8); carry(dB + 3, bB + 3, 4.6, 0.6); carry(dB - 7, bB + 2, 3.2, 0.9, 0.55); at(dB - 2, bB - 9, 3.6, 0.6);
  carry(dB + 5, bB - 5, 3.4, 0.5, 0.6); at(dB - 9, bB - 6, 2.2, 0.9); carry(dB - 6, bB + 7, 2.6, 0.8, 0.4); at(dB + 2, bB + 9, 3.0, 0.7); at(dB - 12, bB + 1, 1.8, 1.0);
  // the stern's break sits on its own rubble: a spur of reef rocks under the torn end + at its foot on the lagoon side
  const sb = sectionToWorld(STERN, STERN.length - 2, 0, 0), sdx = [sb[0] - COMP.x, sb[2] - COMP.z], dS = dmath.hypot(sdx[0], sdx[1]);
  const bS = dmath.atan2(sdx[0] * -COMP.fz + sdx[1] * COMP.fx, sdx[0] * COMP.fx + sdx[1] * COMP.fz) * 180 / Math.PI;
  at(dS - 3, bS - 2, 3.8, 0.8, 1.2); at(dS - 6, bS + 3, 2.9, 0.9, 0.8); at(dS, bS - 6, 3.2, 0.7, 0.9); at(dS - 9, bS - 3, 2.2, 1.0, 0.5); at(dS - 4, bS + 7, 2.4, 0.9, 0.6);
  // rocks around the bow's buried stem and along the beach edge (frame left: grey, rounded, algae at the waterline)
  at(98, -31, 2.8, 0.6); at(94, -24, 2.2, 0.8); at(88, -40, 1.9, 0.4); at(70, -33, 1.4, 0.5); at(64, -26, 1.1, 0.7);
  // rounded algae rocks in the shallows around the heaps and along the waterline (grey, rounded, green algae
  // below the tide line, foam where they break the surface)
  for (let i = 0; i < 26; i++) {
    const heapB = i < 14, d = heapB ? 70 + r() * 30 : 60 + r() * 45, deg = heapB ? -14 + r() * 30 : -42 + r() * 18;
    at(d, deg, 0.6 + dmath.pow(r(), 1.5) * 1.6, 0.6 + r() * 0.4);
  }
  // rounded grey rocks clustered along the waterline in front of the spill (half out of the water, algae
  // below the tide line, foam where they break the surface): small groups of 2–4
  for (const [d0, deg0, n] of [[38, -8, 3], [46, 6, 4], [55, -14, 3], [60, 16, 2], [70, 2, 4], [66, -22, 3], [48, 22, 2], [76, 12, 3]] as Array<[number, number, number]>) {
    for (let k = 0; k < n; k++) {
      const d = d0 + (r() - 0.5) * 5, deg = deg0 + (r() - 0.5) * 6, rad = 0.9 + dmath.pow(r(), 1.3) * 1.3;
      const [x, z] = fromCam(d, deg), gy = Math.max(groundY(x, z), -3.4);
      // raised so the crown breaks the surface (the base still sits on the seabed / sand)
      out.push({ x, z, r: rad, moss: 0.6 + r() * 0.35, y: gy + Math.min(1.6, Math.max(0, -gy * 0.7)) - rad * 0.2 });
    }
  }
  // every box lying on the beach / in the shallow wash gets 3–5 rocks round its foot (never in front of its doors):
  // it looks washed up and settled, not dropped on the sand
  CONTAINERS.forEach((p, i) => {
    const L = (p.size ?? 40) === 20 ? 6.058 : 12.192, W = 2.438, c = dmath.cos(p.yaw), sn = dmath.sin(p.yaw);
    if (groundY(p.x, p.z) < -0.6 || p.y > groundY(p.x, p.z) + 1.5) return;
    const n = 3 + (i % 3);
    for (let k = 0; k < n; k++) {
      const u = ((k + 0.5) / n - 0.5) * L * 0.95 - (p.open ? L * 0.1 : 0), side = k % 2 ? 1 : -1, v = side * (W / 2 + 0.35 + r() * 0.6);
      const x = p.x + u * c + v * sn, z = p.z - u * sn + v * c, gy = groundY(x, z);
      out.push({ x, z, r: 0.35 + r() * 0.45, moss: 0.15 + r() * 0.4, y: Math.max(gy, -1.2) - 0.08 });
    }
  });
  // beach boulders + pebbles
  for (let i = 0; i < 16; i++) at(18 + r() * 60, -40 + r() * 75, 0.3 + dmath.pow(r(), 2) * 1.0, 0.2 + r() * 0.4);
  return out;
})();

/** the rocky headland left of the bow's buried stem (a jungle-topped cliff with creepers): stepped blocks,
 *  world y0 = block base. Visuals = sculpted cliff rocks filling each block; colliders = the blocks (shrunk). */
export interface BluffBlock { x: number; z: number; y0: number; w: number; h: number; d: number; ry: number }
export const BLUFF: BluffBlock[] = (() => {
  const B = (dist: number, deg: number, w: number, h: number, d: number, ry: number, y0?: number): BluffBlock => { const [x, z] = fromCam(dist, deg); return { x, z, y0: y0 ?? groundY(x, z) - 1.5, w, h, d, ry }; };
  return [
    // base tier (wide, into the sand) — the headland rises right behind the bow half's buried stem (frame left)
    B(114, -35, 17, 15, 12, 0.3), B(122, -41, 20, 20, 15, 0.8), B(106, -45, 13, 12, 11, 1.3), B(132, -34, 15, 17, 12, 0.1), B(100, -40, 9, 8, 8, 0.6),
    B(116, -48, 16, 16, 12, 0.4),
    // mid tier
    B(118, -38, 14, 16, 11, 0.5, 11.5), B(126, -40, 14, 16, 12, 1.1, 15.5), B(111, -43, 10, 10.8, 9, 0.2, 9.5) /* 10.8 (not 12): the pocket on the base block behind it steps out over it */, B(119, -46, 12, 14, 10, 0.9, 13),
    // crown
    B(122, -40, 11, 13, 10, 0.7, 27), B(119, -44, 9, 11, 8, 0.3, 26),
  ];
})();

/** the reef / beach boulders and the headland's sculpted cliff rocks as placements (world; dressing.ts draws them,
 *  an offline bake voxelises the same triangles into the colliders) */
export function rockSets(): Record<string, RockSet> {
  const big: RockPl[] = [], small: RockPl[] = [], cliff: RockPl[] = [];
  ROCKS.forEach((k, i) => {
    const gy = k.y ?? groundY(k.x, k.z), b = k.r >= 1.6;
    (b ? big : small).push({ x: k.x, y: gy + k.r * 0.18, z: k.z, sx: k.r * (1 + hash01(i, 1) * 0.3), sy: k.r * (0.7 + hash01(i, 2) * 0.3), sz: k.r * (0.85 + hash01(i, 3) * 0.3),
      ry: hash01(i, 4) * 6.28, rx: (hash01(i, 5) - 0.5) * 0.3, rz: (hash01(i, 6) - 0.5) * 0.3, proto: Math.floor(hash01(i, 7) * (b ? 4 : 3)) });
  });
  BLUFF.forEach((bb, i) => {
    // 2–3 rocks per block so the silhouette is chunky + stepped, never one smooth lump
    const n = bb.w > 12 ? 3 : 2;
    for (let k = 0; k < n; k++) {
      const t = k / (n - 1) - 0.5, c = dmath.cos(bb.ry), sn = dmath.sin(bb.ry);
      const ox = t * bb.w * 0.55, oz = (hash01(i, k, 3) - 0.5) * bb.d * 0.3;
      const sx = bb.w / n * 0.78 + 1.5, sy = bb.h * (0.5 + hash01(i, k, 4) * 0.12), sz = bb.d * 0.62;
      cliff.push({ x: bb.x + ox * c + oz * sn, y: bb.y0 + sy * 0.8, z: bb.z - ox * sn + oz * c, sx, sy, sz, ry: bb.ry + (hash01(i, k, 5) - 0.5) * 0.5, rx: (hash01(i, k, 6) - 0.5) * 0.08, rz: (hash01(i, k, 7) - 0.5) * 0.08, proto: (i + k) % 5 });
    }
  });
  return { big: { fam: "boulder", n: 4, res: 16, pl: big }, small: { fam: "boulder", n: 3, res: 10, pl: small }, cliff: { fam: "cliff", n: 5, res: 22, pl: cliff } };
}
export const ROCK_SIG = rockSig("wr1", ROCKS, BLUFF);
export const ROCK_BAKE = (ROCKS_BAKED as unknown as Record<string, RockBake>)["the-wreck"];

/** a bamboo lookout platform on the beach — the view camera stands at its seaward railing (the bamboo rail in
 *  the frame's bottom-left corner). Square deck (half size hs) at deckY, yaw = facing the wreck, a ladder of steps at the back. */
export const LOOKOUT = (() => {
  // the camera stands 0.3 m forward of the deck centre and 0.8 m right of it
  const back = 0.3, left = 0.8, rx = -COMP.fz, rz = COMP.fx;
  const x = COMP.x - COMP.fx * back - rx * left, z = COMP.z - COMP.fz * back - rz * left;
  return { x, z, deckY: 6.0, hs: 3.0, railV: -1.2, yaw: dmath.atan2(-COMP.fz, COMP.fx), ground: groundY(x, z) };
})();
/** lookout → world (u along the facing direction, v to its right) */
export function lookoutAt(u: number, v: number): [number, number] {
  const rx = -COMP.fz, rz = COMP.fx;
  return [LOOKOUT.x + COMP.fx * u + rx * v, LOOKOUT.z + COMP.fz * u + rz * v];
}

/** walkable debris ramps (world): from a low point up to a high point, width w — visuals: a fallen hatch cover /
 *  collapsed deck plates; colliders: ≤ 0.45 m steps */
export interface Ramp { a: [number, number, number]; b: [number, number, number]; w: number }
export const RAMPS: Ramp[] = [];
{
  // bow half: a fallen hatch-cover + plate slope from the beach beside the buried stem up onto the forecastle deck
  // (its top step lands ON the deck edge — the ramp never cuts through the deck)
  const top = sectionToWorld(BOW, 13, deckY(BOW, 13) - 0.04, halfBreadth(BOW, 13, deckY(BOW, 13)) - 0.5);
  // (with the bow at 15° its forecastle is ~1.3 m over the beach — the ramp comes straight in from 8 m out at x 13, clear
  //  of the spilled boxes; a run alongside the hull passes under the flared plating, where a kong's head hits the shell)
  const foot = sectionToWorld(BOW, 13, 0, BOW.beam / 2 + 8);
  // the foot 0.35 m lower: groundY (the beach promise) reads 0.3 m over the real sand here, so the first tread would
  // stand 0.64 m over the beach — over the 0.55 m step
  RAMPS.push({ a: [foot[0], Math.max(groundY(foot[0], foot[2]) - 0.35, -0.6) + 0.3, foot[2]], b: top, w: 3.8 });
  // stern half: collapsed decks sloping from the reef at the break up to the main deck
  // (the last tread rests on the listing deck's edge and you walk straight on — 0.35 m lower, the edge tile is a
  //  wall you can only mantle)
  const top2 = sectionToWorld(STERN, STERN.length - 4.5, STERN.depth + 0.25, -(STERN.beam / 2 - 1.4));
  const foot2 = sectionToWorld(STERN, STERN.length - 7, 0, -(STERN.beam / 2 + 13));
  RAMPS.push({ a: [foot2[0], -1.5, foot2[2]], b: top2, w: 4.0 });
}
// ---------------------------------------------------------------- the salvage boardwalk
/** A lashed bamboo boardwalk from the beach out to the stern's debris ramp (otherwise the stern is a 30 m swim from
 *  the shallows), routed between the spilled boxes and reef rocks (≥ 1.3 m off anything that
 *  stands over 0.6 m). Deck top WALK.y; joints are wider landings with a crate (cover every ≤ 13 m along the lane);
 *  boarding steps drop into the water every ~12 m on alternating sides so a kong who falls off climbs straight back. */
export const WALK = {
  y: 0.8, w: 2.4, landing: 3.4,
  pts: [[-844.5, 120.3], [-852.8, 120.3], [-861.8, 110.8], [-869.3, 105.8], [-879.0, 105.8], [-888.8, 105.8], [-891.3, 108.3], [-893.75, 117.77]] as Array<[number, number]>,
};
export interface WalkSeg { a: [number, number]; b: [number, number]; len: number; ux: number; uz: number; e0: number; e1: number }
export function walkSegs(): WalkSeg[] {
  const P = WALK.pts, out: WalkSeg[] = [];
  for (let i = 0; i + 1 < P.length; i++) {
    const a = P[i], b = P[i + 1], len = dmath.hypot(b[0] - a[0], b[1] - a[1]);
    // (segments run into each other's landings; the beach end and the ramp end stop exactly at their points)
    out.push({ a, b, len, ux: (b[0] - a[0]) / len, uz: (b[1] - a[1]) / len, e0: i === 0 ? 0 : WALK.w / 2, e1: i + 2 === P.length ? 0 : WALK.w / 2 });
  }
  return out;
}
/** walkway pieces (world, sim yaw = atan2(uz, ux)): deck / landing / step / crate boxes, shared by colliders + visuals */
export interface WalkPiece { kind: "deck" | "landing" | "step" | "crate"; c: V3; h: V3; yaw: number }
export function walkPieces(): WalkPiece[] {
  const out: WalkPiece[] = [], Y = WALK.y, T = 0.25, segs = walkSegs();
  for (const s of segs) {
    const m = (s.e1 - s.e0) / 2, cx = (s.a[0] + s.b[0]) / 2 + s.ux * m, cz = (s.a[1] + s.b[1]) / 2 + s.uz * m;
    out.push({ kind: "deck", c: [cx, Y - T / 2, cz], h: [s.len / 2 + (s.e0 + s.e1) / 2, T / 2, WALK.w / 2], yaw: dmath.atan2(s.uz, s.ux) });
  }
  // joint landings (square, along the incoming segment) + a crate on the outer corner of every other one
  for (let i = 1; i + 1 < WALK.pts.length; i++) {
    const s = segs[i - 1], [x, z] = WALK.pts[i], L = WALK.landing / 2, yaw = dmath.atan2(s.uz, s.ux);
    out.push({ kind: "landing", c: [x, Y - T / 2, z], h: [L, T / 2, L], yaw });
    if (i <= 5) {
      const n = segs[i], turn = s.ux * n.uz - s.uz * n.ux, side = turn > 0 ? -1 : 1, nx = -s.uz * side, nz = s.ux * side;
      const q = L - 0.62, cx = x + nx * q + s.ux * 0.3, cz = z + nz * q + s.uz * 0.3;
      out.push({ kind: "crate", c: [cx, Y + 0.55, cz], h: [0.55, 0.55, 0.55], yaw: yaw + 0.12 * side });
    }
  }
  // beach entry: two steps up from the sand
  { const s = segs[0], [x, z] = s.a, yaw = dmath.atan2(s.uz, s.ux);
    out.push({ kind: "step", c: [x - s.ux * 0.3, (0.5 - 1.2) / 2, z - s.uz * 0.3], h: [0.3, 0.6 + 0.25, WALK.w / 2], yaw });
    out.push({ kind: "step", c: [x - s.ux * 0.9, (0.2 - 1.2) / 2, z - s.uz * 0.9], h: [0.3, 0.6 + 0.1, WALK.w / 2], yaw }); }
  // boarding steps for swimmers: where the water is over wading depth, every ~12 m, alternating sides (3 treads
  // 0.5 m apart from 0.7 m under the surface up to 0.5 m under the deck)
  let side = 1, acc = 6;
  for (const s of segs) for (let u = 2.5; u < s.len - 2.5; u += 0.5) {
    acc += 0.5; if (acc < 12) continue;
    const x = s.a[0] + s.ux * u, z = s.a[1] + s.uz * u, nx = -s.uz * side, nz = s.ux * side;
    if (groundY(x + nx * 2.5, z + nz * 2.5) > -1.4) continue;
    acc = 0; const yaw = dmath.atan2(s.uz, s.ux);
    [0.3, -0.2, -0.7].forEach((top, k) => { const d = WALK.w / 2 + 0.25 + k * 0.5; out.push({ kind: "step", c: [x + nx * d, (top - 2.2) / 2, z + nz * d], h: [0.65, (top + 2.2) / 2, 0.25], yaw }); });
    side = -side;
  }
  return out;
}

// ---------------------------------------------------------------- colliders (world, yaw-only FITTED boxes)
// The sim's boxes rotate about Y only, so every tilted piece of the wreck is fitted with small yaw-only boxes
// (harbor-kit fitBox / solidColumns) derived from the SAME hull functions as the mesh: shell plates follow the
// lofted outline (0.8 m thick), the deck is pitched tiles whose tops sit on the plates, the superstructure is hollow
// wall plates + a tiled roof, the funnels/masts are stacked leaning pieces. Fit target for the gap between the visible
// surfaces and the first collider a ray meets: median ≤ 0.1 m, max ≤ 0.3 m.

/** the mushroom vent that pairs with a gooseneck at local x: 3 m aft of it, or 3 m forward when that would stand in the
 *  superstructure's front wall (shared by the mesh and the colliders) */
export function ventX2(s: HullSection, x: number): number {
  const a = x + 3;
  return a > s.house.x0 - 1.2 && a < s.house.x1 + 1.2 ? x - 3 : a;
}
/** deck gear never stands inside a house (the rooms are walkable) */
export const inHouse = (s: HullSection, x: number) => x > s.house.x0 - 0.6 && x < s.house.x1 + 0.6;
/** the shell's plate rows (local y) — shared by the mesh and the colliders */
export function hullRows(s: HullSection): number[] {
  return [0, 0.3, 0.7, 1.2, 1.9, 2.8, 3.8, 4.9, 6.0, 7.1, 8.2, 9.3, 10.2, 10.8, 11].map((v) => (v * s.depth) / 11);
}
/** a superstructure level's walls (local): x range, half width. `torn` houses stop the closed part at x1 - TORN_ROOM */
export const HOUSE_LH = 3.1;
export function houseLevel(s: HullSection, l: number): { x0: number; x1: number; hw: number; y0: number } {
  const H = s.house, inset = l === H.levels - 1 ? 1.2 : l * 0.25;
  return { x0: H.x0 + inset, x1: houseTorn(s) ? H.x1 : H.x1 - inset * 0.5, hw: H.halfW - (l > 0 ? 0.3 : 0), y0: deckY(s, (H.x0 + H.x1) / 2) + l * HOUSE_LH };
}
/** the stern half's running gear under the counter (section-local): a 4-blade propeller half out of the water, the rudder
 *  aft of it on its stock, a skeg / sole piece under both */
export const STERN_GEAR = { propX: 3.7, propY: 3.6, propR: 2.4, rudderX0: 0.3, rudderX1: 2.6, rudderY0: 0.4, rudderY1: 8.4, stockX: 1.6 };
/** torn-out wall sections of the superstructures (crumbling houses): [section, level, side (±1 = ±z),
 *  x0, x1] — the wall is missing there (dark gutted rooms behind, a back wall 2.4 m in); visuals + colliders */
export const HOUSE_HOLES: Array<{ s: "bow" | "stern"; l: number; side: 1 | -1; x0: number; x1: number }> = [
  { s: "bow", l: 1, side: 1, x0: 31.5, x1: 36 },
  { s: "bow", l: 2, side: 1, x0: 34, x1: 39 },
  { s: "bow", l: 0, side: -1, x0: 27, x1: 30.5 },
  // a breach on the BEACH side at deck level too, right where the forecastle ramp's deck lane meets the house (otherwise
  // the only way in is round the house on the sea side)
  { s: "bow", l: 0, side: 1, x0: 25.6, x1: 29.0 },
  { s: "stern", l: 1, side: -1, x0: 36, x1: 40.5 },
  { s: "stern", l: 2, side: -1, x0: 42, x1: 47 },
  { s: "stern", l: 0, side: 1, x0: 38, x1: 42 },
];
export const houseHoles = (s: HullSection, l: number, side: number) => HOUSE_HOLES.filter((h) => h.s === s.id && h.l === l && h.side === side);
/** where a torn house level's side wall ends (the plates are ripped back 0.4–1.8 m short of the tear) */
export function tornWallEnd(s: HullSection, l: number, side: number): number {
  return s.house.x1 - 0.4 - h01(l + (s.id === "bow" ? 0 : 10), side > 0 ? 1 : 2) * 1.4;
}
/** deterministic 0..1 hash (same as client harbor-geo hash) */
export function h01(...n: number[]): number {
  let h = 2166136261 >>> 0;
  for (const v of n) { h ^= Math.floor(v * 1000) | 0; h = Math.imul(h, 16777619) >>> 0; }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995) >>> 0; h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

// ---------------------------------------------------------------- the superstructures are real buildings
/** the stairwell inside each house (section-local): the stern's runs along the hull (its pitch is 1.7°), the bow's
 *  across the beam (the bow is pitched 23°: a flight along x would be 6° one way and 52° the other) */
export function houseStair(s: HullSection): { pieces: Piece[]; holes: (l: number) => Array<[number, number, number, number]> } {
  const y0 = houseLevel(s, 0).y0, n = s.house.levels;
  if (s.id === "stern") { const sw = stairwell(35.0, -5.5, y0, HOUSE_LH, n, "steel"); return { pieces: sw.pieces, holes: () => [sw.well] }; }
  // the bow (pitched 23°): a SCISSOR stair across the beam — one full-storey flight per level, alternating between two
  // lanes 2 m apart (a half-storey return flight would lean over the one below it), the openings widened for the lean
  const lanes = [31.2, 29.2], w = 1.15, z0 = 0, nT = Math.ceil(HOUSE_LH / 0.25 - 1e-6), run = nT * 0.28, pieces: Piece[] = [];
  for (let l = 0; l < n; l++) {
    const x = lanes[l % 2], up = l % 2 === 0 ? 1 : -1, zf = up > 0 ? z0 : z0 + run;
    pieces.push(...flight("z", x, zf, up as 1 | -1, y0 + l * HOUSE_LH, y0 + (l + 1) * HOUSE_LH, run, w, "steel", l === 0 ? 2.4 : 0));
  }
  const holes = (l: number): Array<[number, number, number, number]> => {
    if (l < 1) return [];
    const x = lanes[(l - 1) % 2];
    return [[x - w / 2 - 1.0, x + w / 2 + 1.0, z0 - 0.05, z0 + run + 0.05]];
  };
  return { pieces, holes };
}
/** a stair tower in the stern's open hold, from the tank top up through the broken hatch to the main deck (a
 *  landing per storey, a gap in the hatch coaming where it tops out). Section-local pieces. */
export const HOLD_STAIR = { x0: 19.4, zc: -2.4, storeys: 5 };
export function holdStairPieces(s: HullSection): Piece[] {
  if (s.id !== "stern") return [];
  const H = HOLD_STAIR, y0 = 1.5, lh = (deckY(s, H.x0 + 2) - y0) / H.storeys, sw = stairwell(H.x0, H.zc, y0, lh, H.storeys, "steel"), out = [...sw.pieces];
  for (let k = 1; k <= H.storeys; k++) out.push(slabXYZ(H.x0 - 0.1, H.x0 + 1.25, y0 + k * lh - 0.2, y0 + k * lh, k === H.storeys ? -4.0 : H.zc - 1.2, H.zc + 1.2, "grate", { kind: "landing" }));
  // the access trunk: rusted steel plates round the stair up to the deck (a doorway into the hold at the bottom of the
  // near end); the top storey's exit is over the −z plate onto the deck
  const top = y0 + H.storeys * lh, T = 0.12, xa = H.x0 - 0.1 - T, xb = H.x0 + sw.L + 0.05, za = H.zc - sw.W / 2 - 0.05, zb = H.zc + sw.W / 2 + 0.05;
  out.push(slabXYZ(xa, xb + T, y0, top - lh, za - T, za, "rust"), slabXYZ(xa, xb + T, y0, top, zb, zb + T, "rust"), slabXYZ(xb, xb + T, y0, top, za, zb, "rust"));
  out.push(slabXYZ(xa, xa + T, y0 + 2.4, top - lh, za, zb, "rust"));
  return out;
}
/** the stern house's EXTERIOR stair on its beach-facing (−z) flank — with only the 1.15 m switchback inside,
 *  L1 / L2 / the roof read as sealed. Wide steel flights climb the side deck: deck → a landing at the L1 wall breach →
 *  L2's breach → a return flight to a landing on the roof (the sniper perch by the mast). Section-local pieces;
 *  colliders + visuals use the same list. */
export const EXT_STAIR = { xA: 31.0, lane: [-12.15, -9.85] as [number, number] };
/** a winch / deck gear spot under the exterior stair's solid first flight (kept clear) */
export const underExtStair = (s: HullSection, x: number, side: number) => s.id === "stern" && side < 0 && x > EXT_STAIR.xA - 0.8 && x < EXT_STAIR.xA + 4.6;
export function extStairPieces(s: HullSection): Piece[] {
  if (s.id !== "stern") return [];
  const E = EXT_STAIR, y0 = houseLevel(s, 0).y0, y1 = houseLevel(s, 1).y0, y2 = houseLevel(s, 2).y0, roof = y0 + s.house.levels * HOUSE_LH + 0.24;
  const zl = (E.lane[0] + E.lane[1]) / 2, wl = E.lane[1] - E.lane[0], zo = E.lane[0], zr = zo - 0.03;
  const run = (a: number, b: number) => Math.ceil((b - a) / 0.25 - 1e-6) * 0.28;
  // (one wide lane, 2.3 m — the whole side deck: three straight flights forward along the flank, a landing at each
  //  breach; the roof flight tops out beside the roof's torn end)
  const xA1 = E.xA + run(y0, y1), xB0 = 40.5, xB1 = xB0 + run(y1, y2), xC0 = 46.0, xC1 = xC0 + run(y2, roof), xR1 = 51.4;
  const out: Piece[] = [];
  out.push(...flight("x", E.xA, zl, 1, y0, y1, xA1 - E.xA, wl, "steel", 9));
  out.push(slabXYZ(xA1, xB0, y1 - 0.2, y1, zo, -9.45, "grate", { kind: "landing" }));
  out.push(...flight("x", xB0, zl, 1, y1, y2, xB1 - xB0, wl, "steel", 0));
  out.push(slabXYZ(xB1, xC0, y2 - 0.2, y2, zo, -9.45, "grate", { kind: "landing" }));
  out.push(...flight("x", xC0, zl, 1, y2, roof, xC1 - xC0, wl, "steel", 0));
  out.push(slabXYZ(xC1, xR1, roof - 0.2, roof, zo, -9.0, "grate", { kind: "landing" }));
  out.push(railRun(xA1, zr, xB0, zr, y1), railRun(xB1, zr, xC0, zr, y2), railRun(xC1, zr, xR1, zr, roof), railRun(xR1 + 0.03, -9.0, xR1 + 0.03, zo, roof));
  return out;
}
/** the roof landing's x range (the client leaves the roof railing open there) */
export function extStairRoofGap(s: HullSection): [number, number] | null {
  const p = extStairPieces(s).filter((q) => q.kind === "landing").pop();
  return p ? [p.c[0] - p.h[0], p.c[0] + p.h[0]] : null;
}
export const holdCoamingGap = (s: HullSection, x: number, z: number) => s.id === "stern" && z < 0 && x > HOLD_STAIR.x0 - 0.2 && x < HOLD_STAIR.x0 + 1.35;
/** world → section-local (inverse of sectionToWorld) */
export function worldToSection(s: HullSection, wx: number, wy: number, wz: number): V3 {
  const cr = dmath.cos(s.roll), sr = dmath.sin(s.roll), cp = dmath.cos(s.pitch), sp = dmath.sin(s.pitch), cy = dmath.cos(s.yaw), sy = dmath.sin(s.yaw);
  const dx = wx - s.x, dz = wz - s.z, x2 = dx * cy - dz * sy, z1 = dx * sy + dz * cy, y2 = wy - s.y;
  const x = x2 * cp + y2 * sp, y1 = -x2 * sp + y2 * cp;
  return [x, y1 * cr + z1 * sr, -y1 * sr + z1 * cr];
}
/** the beached bow's forward hold is PACKED SOLID (sand + collapsed cargo) up to just under the deck, from the
 *  stem to a rusted collision bulkhead at BOW_CORE_X (the break's end of the hold stays open, reached from the reef):
 *  otherwise the inner ledges of the pitched plating are sealed pockets. World-level columns 1 m along the heading, the top
 *  following the deck's underside (shared by the colliders; the bulkhead plate is drawn by the client). */
export const BOW_CORE_X = 44;
export function bowCoreStrips(): Array<{ c: V3; h: V3; yaw: number }> {
  const s = BOW, out: Array<{ c: V3; h: V3; yaw: number }> = [];
  const ux = rot(s, [1, 0, 0]), hl = dmath.hypot(ux[0], ux[2]), yaw = dmath.atan2(ux[2], ux[0]), ex = [ux[0] / hl, ux[2] / hl], ez = [-ex[1], ex[0]];
  const o = sectionToWorld(s, 0, 0, 0);
  for (let u = 0; u < BOW_CORE_X * hl; u += 1) {
    // the section x under this column (at the deck's height) and the hull width there
    const xs = [0, 0.5, 1].map((t) => worldToSection(s, o[0] + ex[0] * (u + t), sectionToWorld(s, (u + t) / hl, deckY(s, (u + t) / hl), 0)[1], o[2] + ex[1] * (u + t))[0]);
    const xm = xs[1];
    if (xm > BOW_CORE_X || xm < endX(s, deckY(s, xm)) + 0.3) continue;
    const hb = Math.min(...xs.map((x) => halfBreadth(s, Math.max(endX(s, deckY(s, 0)) + 0.01, x), deckY(s, x) - 1))) - 0.9;
    if (hb < 0.5) continue;
    // strips 1 m across the beam, each topped just under ITS stretch of the rolled deck (a single top left a crouch
    // pocket under the high side)
    const n = Math.max(1, Math.round((2 * hb) / 1.0));
    for (let k = 0; k < n; k++) {
      const v0 = -hb + (2 * hb * k) / n, v1 = -hb + (2 * hb * (k + 1)) / n;
      const top = Math.min(...xs.flatMap((x) => [v0, v1].map((z) => sectionToWorld(s, Math.max(0, x), deckY(s, Math.max(0, x)) - 0.4, z)[1]))) - 0.1;
      const vm = (v0 + v1) / 2, cw = [o[0] + ex[0] * (u + 0.5) + ez[0] * vm, o[2] + ex[1] * (u + 0.5) + ez[1] * vm], bot = Math.min(groundY(cw[0], cw[1]), top - 2) - 1.5;
      out.push({ c: [cw[0], (bot + top) / 2, cw[1]], h: [0.5, (top - bot) / 2, (v1 - v0) / 2 + 0.02], yaw });
    }
  }
  return out;
}
/** a bridge wing (section-local boxes c / h): the deck plate at the bridge floor + the bulwark (1.1 m) on its outer
 *  side and both ends; the client draws the same boxes + brackets, a cap rail and a repeater console */
export function wreckWing(s: HullSection, side: number): Array<{ c: V3; h: V3; kind: "plate" | "bulwark" }> {
  const H = s.house, top = deckY(s, (H.x0 + H.x1) / 2) + H.levels * HOUSE_LH, y = top - HOUSE_LH, x = houseTorn(s) ? H.x0 + 3 : H.x1 - 3;
  const z0 = side * H.halfW, z1 = side * (H.halfW + 3.0), zc = (z0 + z1) / 2, hz = Math.abs(z1 - z0) / 2;
  return [
    { c: [x, y - 0.12, zc], h: [1.2, 0.12, hz], kind: "plate" },
    { c: [x, y + 0.55, z1 - side * 0.05], h: [1.2, 0.55, 0.05], kind: "bulwark" },
    { c: [x - 1.15, y + 0.55, zc], h: [0.05, 0.55, hz], kind: "bulwark" },
    { c: [x + 1.15, y + 0.55, zc], h: [0.05, 0.55, hz], kind: "bulwark" },
  ];
}
/** the closed part of a level (x range inside the walls, half width inside the walls) */
export function houseInner(s: HullSection, l: number): { x0: number; x1: number; hw: number; y0: number } {
  const Lv = houseLevel(s, l), torn = houseTorn(s), xc = torn ? s.house.x1 - TORN_ROOM : Lv.x1;
  return { x0: Lv.x0 + 0.5, x1: xc - (torn ? 0.3 : 0.5), hw: Lv.hw - 0.5, y0: Lv.y0 };
}
/** the doorway through the torn rooms' back wall (z range) — the colliders leave that wall cell out on every level */
export const TORN_DOOR: [number, number] = [0, 1.9];
/** the stern house's rooms for the shared interiors kit, in SECTION-LOCAL coordinates (yaw 0, y = the level's
 *  floor): the closed rooms of every level (mess, crew cabins, the bridge) and the gutted rooms at the tear. The client
 *  builds them inside a group carrying the section transform (they list with the wreck); the colliders are the kit's
 *  item boxes fitted to the tilted section (sternRoomBoxes). */
export const STERN_ROOMS: InteriorRoom[] = houseRooms(STERN);
/** a house's levels as kit rooms in SECTION-LOCAL coordinates — each closed level split into three
 *  rooms open to each other (aft / mid / fore: a 20 m planked hall reads empty with one room's worth of furniture), a
 *  derelict modern freighter's crew (galley / mess / lounge, crew cabins, the master's office + cabin + the chart room;
 *  no pirate chests), and the gutted rooms at the tear (stores spilled about) */
export function houseRooms(s: HullSection): InteriorRoom[] {
  const out: InteriorRoom[] = [], torn = houseTorn(s), stern = s.id === "stern";
  const sw = stern ? [34.9, 39.6, -6.8, -4.2] : null;
  const swExit = stern ? [34.5, 36.7, -4.25, -2.4] : null;
  const fin = { wall: "#c9c0aa", glass: false, frames: false, curtains: false, wallMat: "plaster", dado: "#55636b", baseboard: true, floor: "tiles" } as const;
  const roles: Array<Array<[InteriorRoom["style"], InteriorRoom["role"]]>> = [
    [["house", "kitchen"], ["house", "dining"], ["house", "living"]],
    [["house", "bedroom"], ["house", "bedroom"], ["house", "bedroom"]],
    // (level 2: the ship's office + the master's cabin + the chart room — office desks beside the stairwell make traps)
    [["lab", "dock"], ["house", "bedroom"], ["lab", "dock"]]];
  const base = stern ? 7700 : 7800;
  for (let l = 0; l < s.house.levels; l++) {
    const I = houseInner(s, l), d = 2 * I.hw, cuts = [I.x0, I.x0 + (I.x1 - I.x0) / 3, I.x0 + (2 * (I.x1 - I.x0)) / 3, I.x1];
    for (let k = 0; k < 3; k++) {
      const x0 = cuts[k], x1 = cuts[k + 1], cx = (x0 + x1) / 2, w = x1 - x0;
      const ops: RoomOpening[] = [];
      if (k > 0) ops.push({ side: 3, at: 0, w: d - 0.3, kind: "gap" });
      if (k < 2) ops.push({ side: 1, at: 0, w: d - 0.3, kind: "gap" });
      else if (torn) ops.push({ side: 1, at: (TORN_DOOR[0] + TORN_DOOR[1]) / 2, w: TORN_DOOR[1] - TORN_DOOR[0], kind: "door" });
      for (const sd of [1, -1] as const) for (const h of houseHoles(s, l, sd)) {
        const a = Math.max(h.x0, x0 + 0.1), b = Math.min(h.x1, x1 - 0.1);
        if (b - a > 0.6) ops.push({ side: sd > 0 ? 0 : 2, at: (a + b) / 2 - cx, w: b - a, kind: "gap" });
      }
      const keepOut: InteriorRoom["keepOut"] = [];
      if (sw && sw[1] > x0 && sw[0] < x1) keepOut.push({ r: [Math.max(sw[0], x0) - cx, sw[2], Math.min(sw[1], x1) - cx, sw[3]], walk: true });
      // (the stair arrives on each level heading aft onto a 1.25 m landing and turns INTO the room — a crate in that turn
      //  leaves a 0.53 m gap that snags players coming up; keep a 2.2 × 1.8 m exit pad clear in front of every landing)
      if (swExit && swExit[1] > x0 && swExit[0] < x1) keepOut.push({ r: [Math.max(swExit[0], x0) - cx, swExit[2], Math.min(swExit[1], x1) - cx, swExit[3]], walk: true });
      // (the bow's level-1 cabin can close a 1 m pocket between the bunk, the wardrobe and a nightstand in
      //  its aft −z corner on the sloped floor — a trap; keep that corner clear)
      if (!stern && l === 1 && k === 2) keepOut.push({ r: [38.0 - cx, -8.7, 39.5 - cx, -6.8], walk: true });
      // (at the bow's 15° the top level's fore −z corner can close a 1 m² pocket — a trap; keep it clear)
      if (!stern && l === 2 && k === 0) keepOut.push({ r: [x0 - cx, -8.7, x0 + 2.2 - cx, -6.2], walk: true });
      if (!stern) for (const hz of houseStair(s).holes(l + 1).concat(houseStair(s).holes(l))) if (hz[1] > x0 && hz[0] < x1) keepOut.push({ r: [Math.max(hz[0], x0) - cx, hz[2], Math.min(hz[1], x1) - cx, hz[3]], walk: true });
      const [st, role] = roles[Math.min(l, 2)][k];
      out.push({ id: `${s.id}-house-${l}${"amf"[k]}`, x: cx, y: I.y0, z: 0, yaw: 0, w, d, h: HOUSE_LH - 0.3, style: st, role, seed: base + l * 3 + k + (stern && l === 2 && k === 2 ? 50 : 0), openings: ops, keepOut,
        density: stern ? 0.9 : 0.6, finish: { ...fin, ceiling: l === s.house.levels - 1 ? "plaster" : "beams" } });
    }
    if (torn && l > 0) {
      const x0 = s.house.x1 - TORN_ROOM, x1 = s.house.x1 - 0.4, tx = (x0 + x1) / 2, hw = houseLevel(s, l).hw - 0.6;
      out.push({ id: `${s.id}-torn-${l}`, x: tx, y: I.y0, z: 0, yaw: 0, w: x1 - x0, d: 2 * hw, h: HOUSE_LH - 0.3, style: "warehouse", role: "storage", seed: base + 40 + l, density: 0.45,
        openings: [{ side: 3, at: (TORN_DOOR[0] + TORN_DOOR[1]) / 2, w: TORN_DOOR[1] - TORN_DOOR[0], kind: "door" }, { side: 1, at: 0, w: 2 * hw - 0.2, kind: "gap" }],
        openTop: false, finish: { ...fin, wall: null, ceiling: "none", floor: "deck" } });
    }
  }
  return out;
}
/** the bow house is furnished by the kit too (it lists with the bow: the client builds the rooms inside the
 *  section transform, the colliders are tiled to the slope) */
export const BOW_ROOMS: InteriorRoom[] = houseRooms(BOW);
/** the kit's furniture colliders for STERN_ROOMS, fitted to the listing stern (yaw-only world boxes) */
export function sternRoomBoxes(): Box[] { return roomBoxes(STERN, STERN_ROOMS); }
/** a section's furnished rooms' furniture colliders: the kit's boxes (section-local) fitted to the section — tiled up
 *  to the slope on the pitched bow (TOL), one fitted box each on the near-level stern */
export function roomBoxes(s: HullSection, rooms: InteriorRoom[]): Box[] {
  const out: Box[] = [];
  for (const r of rooms) for (const b of furnishRoom(r).colliders) {
    const y = b.yaw ?? 0, c = dmath.cos(y), sn = dmath.sin(y);
    if (s.id === "stern" || Math.abs(y) > 1e-3) { const q = piece(s, b.c, [b.h[0] * c, 0, b.h[0] * sn], [0, b.h[1], 0], [-b.h[2] * sn, 0, b.h[2] * c], b.surf); if (b.noShoot) q.noShoot = true; out.push(q); continue; }
    out.push(...sectionPieceBoxes(s, { c: b.c, h: b.h, mat: "wood", surf: b.surf, noShoot: b.noShoot }));
  }
  return out;
}
/** interior pieces (section-local): the stairwell, a floor on every upper level (the well left open), lined walls, room
 *  furniture per level (galley / crew cabins / the bridge), a light per level. The walls themselves are hullBoxes. */
export function houseInteriorPieces(s: HullSection): Piece[] {
  const st = houseStair(s), out: Piece[] = [...st.pieces], n = s.house.levels;
  for (let l = 0; l < n; l++) {
    const I = houseInner(s, l), y = I.y0, top = y + HOUSE_LH;
    if (l > 0) out.push(...floorWithHoles(I.x0 - 0.5, I.x1 + (houseTorn(s) ? 0.3 : 0.5), -I.hw - 0.5, I.hw + 0.5, y, 0.25, "floor", st.holes(l)));
    // plaster liners inside the walls (visual: the walls are the hull boxes) — dado band from the floor
    const lin = (x0: number, x1: number, z0: number, z1: number) => out.push(slabXYZ(x0, x1, y, top - 0.25, z0, z1, "wallIn", { solid: false, base: y }));
    for (const sd of [-1, 1]) {
      // (split around the gutted-wall holes: they look straight into the room)
      let a = I.x0;
      for (const h of houseHoles(s, l, sd).sort((p, q) => p.x0 - q.x0)) { if (h.x0 > a + 0.1) lin(a, h.x0, sd * I.hw - 0.02, sd * I.hw + 0.02); a = Math.max(a, h.x1); }
      if (I.x1 > a + 0.1) lin(a, I.x1, sd * I.hw - 0.02, sd * I.hw + 0.02);
    }
    lin(I.x0 - 0.02, I.x0 + 0.02, -I.hw, I.hw);
    if (!houseTorn(s)) lin(I.x1 - 0.02, I.x1 + 0.02, -I.hw, I.hw);
    // a ceiling panel light
    out.push(slabXYZ((I.x0 + I.x1) / 2 + 1.5, (I.x0 + I.x1) / 2 + 2.7, y, top - 0.25, 3.0, 3.6, "wallIn", { solid: false, kind: "lamp" }));
  }
  // furniture (section-local, kept off the stairwell, the holes and the doorways)
  const f = (x0: number, x1: number, y0: number, h: number, z0: number, z1: number, mat: PieceMat, kind: Piece["kind"]) => out.push(slabXYZ(x0, x1, y0, y0 + h, z0, z1, mat, { kind }));
  const L0 = houseInner(s, 0), L1 = houseInner(s, 1), L2 = houseInner(s, n - 1);
  if (s.id === "stern") {
    // (the stern house is furnished by the shared interiors kit — STERN_ROOMS)
  } else {
    // (the bow house is furnished by the kit too — BOW_ROOMS; only the bridge consoles under its front windows stay)
    for (const z0 of [-5.0, -1.0, 5.2]) f(L2.x1 - 0.85, L2.x1 - 0.05, L2.y0, 1.0, z0, z0 + 1.8, "cabinet", "console");
    void L0; void L1;
  }
  return out;
}
/** the bow's stair treads + landings are WORLD-LEVEL (a repaired stair in the listing wreck): a flight across a 23°
 *  deck would tilt every tread sideways and its high edge would rise more than the 0.55 m step */
export const levelStairPiece = (s: HullSection, p: Piece) => s.id === "bow" && (p.kind === "tread" || p.kind === "landing" || p.kind === "stringer");
/** a section-local piece as ONE world-level yawed box: its top-centre stays where the section puts it, the footprint is
 *  the piece's horizontal projection (sim yaw convention: box +X = world (cos, 0, sin)) */
export function levelBox(s: HullSection, p: Piece): Box {
  const t = sectionToWorld(s, p.c[0], p.c[1] + p.h[1], p.c[2]), ux = rot(s, [1, 0, 0]), uz = rot(s, [0, 0, 1]);
  const b: Box = { c: [t[0], t[1] - p.h[1], t[2]], h: [p.h[0] * dmath.hypot(ux[0], ux[2]), p.h[1], p.h[2] * dmath.hypot(uz[0], uz[2])], yaw: dmath.atan2(ux[2], ux[0]), surf: "metal" };
  return b;
}
/** a section-local piece → yaw-only boxes, tiled so every tile's tilted faces stay within ~TOL (the pitch tilts along x,
 *  the roll across z) */
export function sectionPieceBoxes(s: HullSection, p: Piece): Box[] {
  if (levelStairPiece(s, p)) return [levelBox(s, p)];
  const out: Box[] = [], [cx, cy, cz] = p.c, [hx, hy, hz] = p.h;
  const nx = Math.max(1, Math.ceil((2 * hx * Math.abs(dmath.sin(s.pitch))) / (2 * TOL))), nz = Math.max(1, Math.ceil((2 * hz * Math.abs(dmath.sin(s.roll))) / (2 * TOL)));
  // TALL pieces (stair dividers, trunk plates, wall liners) are tiled up the height too — one yaw-only box round
  // a 17 m plate leaning 0.03–0.1 rad grows 0.3–0.9 m proud of it (enough to close the stern hold stair's far landing)
  const ny = Math.min(12, Math.max(1, Math.ceil((2 * hy * Math.max(Math.abs(dmath.sin(s.pitch)), Math.abs(dmath.sin(s.roll)))) / (2 * TOL))));
  for (let i = 0; i < nx; i++) for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) {
    const x = cx - hx + (2 * hx * (i + 0.5)) / nx, z = cz - hz + (2 * hz * (k + 0.5)) / nz, y = cy - hy + (2 * hy * (j + 0.5)) / ny;
    const b = piece(s, [x, y, z], [hx / nx, 0, 0], [0, hy / ny, 0], [0, 0, hz / nz], (p.surf ?? (p.mat === "wood" || p.mat === "desk" ? "wood" : "metal")) as Box["surf"]);
    if (p.noShoot) b.noShoot = true;
    out.push(b);
  }
  return out;
}

/** section-local vector → world (rotation only) */
function rot(s: HullSection, v: V3): V3 {
  const o = sectionToWorld(s, 0, 0, 0), p = sectionToWorld(s, v[0], v[1], v[2]);
  return [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
}
/** a fitted box for a section-local piece: centre + half-axis vectors (along, up, across) */
function piece(s: HullSection, c: V3, eu: V3, ev: V3, ew: V3, surf: Box["surf"] = "metal"): Box {
  return fitBox(sectionToWorld(s, c[0], c[1], c[2]), rot(s, eu), rot(s, ev), rot(s, ew), surf);
}
/** world slope of the section's local x axis at local (x, y): how much a horizontal tile tilts there */
function worldSlope(s: HullSection, x: number, y: (x: number) => number): number {
  const a = sectionToWorld(s, x, y(x), 0), b = sectionToWorld(s, x + 0.2, y(x + 0.2), 0);
  return Math.abs(b[1] - a[1]) / Math.max(1e-3, dmath.hypot(b[0] - a[0], b[2] - a[2]));
}
/** adaptive tile edges along local x over [a, b]: each tile keeps its tilted top within `tol` */
function tileEdges(s: HullSection, a: number, b: number, y: (x: number) => number, tol: number, maxL = 4): number[] {
  const xs = [a];
  let x = a;
  while (x < b - 1e-3) { const dx = Math.max(0.3, Math.min(maxL, (2 * tol) / Math.max(1e-3, worldSlope(s, x, y)))); x = Math.min(b, x + dx); if (b - x < 0.15) x = b; xs.push(x); }
  return xs;
}
/** tiles across the beam over [z0, z1]: the roll tilts them */
function acrossEdges(s: HullSection, z0: number, z1: number, tol: number): number[] {
  const dz = Math.max(0.6, Math.min(6, (2 * tol) / Math.max(1e-3, Math.abs(dmath.tan(s.roll))))), n = Math.max(1, Math.ceil((z1 - z0) / dz));
  return [...Array(n + 1)].map((_, i) => z0 + ((z1 - z0) * i) / n);
}
/** a horizontal-ish slab over local x [xa, xb] × z [za, zb] whose TOP follows y(x), thickness t */
function slab(s: HullSection, xa: number, xb: number, za: number, zb: number, y: (x: number) => number, t: number, surf: Box["surf"] = "metal"): Box {
  const ya = y(xa), yb = y(xb);
  return piece(s, [(xa + xb) / 2, (ya + yb) / 2 - t / 2, (za + zb) / 2], [(xb - xa) / 2, (yb - ya) / 2, 0], [0, t / 2, 0], [0, 0, (zb - za) / 2], surf);
}
const TOL = 0.08;   // (0.08: at 0.065 a capsule embeds on the bow deck and the hold stair seals)
/** the client's harbor-geo hash() (which strips of the tween deck it tears short) — bit-identical copy */
function clientHash(...n: number[]): number {
  let h = 2166136261 >>> 0;
  for (const v of n) { h ^= Math.floor(v * 1000) | 0; h = Math.imul(h, 16777619) >>> 0; }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995) >>> 0; h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** debug: which generator produced a collider (the probe prints it) */
export const COLLIDER_TAGS = new WeakMap<Box, string>();
function hullBoxes(s: HullSection): Box[] {
  const out: Box[] = [];
  let tagged = 0;
  const mark = (tag: string) => { for (; tagged < out.length; tagged++) COLLIDER_TAGS.set(out[tagged], tag); };
  const L = s.length, T = 0.8;
  // ---- shell plates: a regular x grid inside each row; the raked stem / ragged break ends as thin sub-rows
  const rows = hullRows(s), dxShell = s.pitch > 0.3 ? 1.25 : s.pitch > 0.1 ? 2 : 3;
  /** a shell plate on the lofted surface over local x [xa, xb] × y [ya, yb] (top edge optionally following top(x)) */
  const plate = (side: number, xa: number, xb: number, ya: number, yb: number, top?: (x: number) => number) => {
    const yt = (x: number) => (top ? top(x) : yb);
    // (x clamped just aft of the stem / transom line: at the stern the side starts at the transom's full width)
    const P = (x: number, y: number): V3 => [x, y, side * halfBreadth(s, Math.max(x, endX(s, y) + 1e-3), y)];
    // the bilge turns hard over its first metres: split those rows so each plate stays near its chord (the rising
    // bow lifts the bilge of its break end into view — 0.4–0.5 m gaps there otherwise)
    if (!top && ya < s.depth * 0.25 && yb - ya > 0.5) {
      const n = Math.ceil((yb - ya) / 0.45);
      for (let k = 0; k < n; k++) { const y0 = ya + ((yb - ya) * k) / n, y1 = ya + ((yb - ya) * (k + 1)) / n; quadPlate(P(xa, y0), P(xb, y0), P(xb, y1), P(xa, y1), T, [0, 0, -side], (q0: number, q1: number) => [P(xa, q0), P(xb, q0), P(xb, q1), P(xa, q1)], y0, y1); }
      return;
    }
    quadPlate(P(xa, ya), P(xb, ya), P(xb, yt(xb)), P(xa, yt(xa)), T, [0, 0, -side], (y0: number, y1: number) => [P(xa, y0), P(xb, y0), P(xb, y1), P(xa, y1)], ya, yt((xa + xb) / 2));
  };
  /** push a fitted plate for the local quad A B C D (A→B along, D→C its top edge), thickness t away from `inward`;
   *  split into sub-rows (via `row(y0, y1)`) while its up-vector strays > 2·TOL from its fitted axis */
  const quadPlate = (A: V3, B: V3, C: V3, D: V3, t: number, inward: V3, row: ((y0: number, y1: number) => V3[]) | null, y0 = 0, y1 = 0) => {
    const eu: V3 = [0, 1, 2].map((k) => (B[k] + C[k] - A[k] - D[k]) / 4) as V3;
    const ev: V3 = [0, 1, 2].map((k) => (C[k] + D[k] - A[k] - B[k]) / 4) as V3;
    if (dmath.hypot3(eu[0], eu[1], eu[2]) < 0.03 || dmath.hypot3(ev[0], ev[1], ev[2]) < 0.03) return;
    if (row && y1 - y0 > 0.2 && fitError(rot(s, ev), rot(s, eu)) > TOL) {
      const ym = (y0 + y1) / 2, lo = row(y0, ym), hi = row(ym, y1);
      quadPlate(lo[0], lo[1], lo[2], lo[3], t, inward, row, y0, ym); quadPlate(hi[0], hi[1], hi[2], hi[3], t, inward, row, ym, y1);
      return;
    }
    let n: V3 = [eu[1] * ev[2] - eu[2] * ev[1], eu[2] * ev[0] - eu[0] * ev[2], eu[0] * ev[1] - eu[1] * ev[0]];
    const nl = dmath.hypot3(n[0], n[1], n[2]) || 1; n = [n[0] / nl, n[1] / nl, n[2] / nl];
    if (n[0] * inward[0] + n[1] * inward[1] + n[2] * inward[2] < 0) n = [-n[0], -n[1], -n[2]];
    const W = (p: V3) => sectionToWorld(s, p[0], p[1], p[2]) as V3;
    out.push(patchBox(W(A), W(B), W(C), W(D), rot(s, n), t, "metal"));
  };
  /** cells of the global station grid (so vertically adjacent plates share edges: no pitch staircase between rows) */
  const cells = (a: number, b: number, d: number): Array<[number, number]> => {
    const out2: Array<[number, number]> = [];
    for (let k = Math.floor(a / d); k * d < b - 1e-6; k++) { const x0 = Math.max(a, k * d), x1 = Math.min(b, (k + 1) * d); if (x1 - x0 > 0.05) out2.push([x0, x1]); }
    // fold slivers into their neighbour
    if (out2.length > 1 && out2[0][1] - out2[0][0] < 0.5) { out2[1][0] = out2[0][0]; out2.shift(); }
    if (out2.length > 1 && out2[out2.length - 1][1] - out2[out2.length - 1][0] < 0.5) { out2[out2.length - 2][1] = out2[out2.length - 1][1]; out2.pop(); }
    return out2;
  };
  for (const side of [1, -1]) for (let r = 0; r < rows.length - 1; r++) {
    const y0 = rows[r], lastRow = r === rows.length - 2;
    // the top row stops under the deck tiles (they own the top 0.35 m out to the outer face)
    const y1 = rows[r + 1], top = lastRow ? (x: number) => deckY(s, x) - 0.35 : undefined;
    const xs0 = Math.max(endX(s, y0), endX(s, y1)), xe0 = Math.min(breakX(s, y0, side), breakX(s, y1, side));
    if (xe0 - xs0 > 0.3) for (const [xa, xb] of cells(xs0, xe0, dxShell)) plate(side, xa, xb, y0, y1, top);
    // the raked stem / transom and the ragged tear: thin sub-rows so the staircase stays within ~0.15 m
    const sub = Math.max(1, Math.ceil((y1 - y0) / 0.5));
    for (let k = 0; k < sub; k++) {
      const ya = y0 + ((y1 - y0) * k) / sub, yb = y0 + ((y1 - y0) * (k + 1)) / sub, ym = (ya + yb) / 2;
      const ybT = lastRow ? Math.min(yb, deckY(s, xs0) - 0.35) : yb;
      const xa = endX(s, ym); if (xs0 - xa > 0.12 && ybT > ya + 0.05) plate(side, xa, xs0, ya, ybT);
      const xb = breakX(s, ym, side); if (xb - xe0 > 0.12) plate(side, xe0, xb, ya, lastRow ? Math.min(yb, deckY(s, xe0) - 0.35) : yb);
    }
  }
  mark("shell");
  // stern transom: a raked plate closing the intact stern end (the mesh's transom quads), sub-rows follow the rake
  if (s.id === "stern") for (let r = 0; r < rows.length - 1; r++) {
    const ya = rows[r], yb = rows[r + 1], hb = Math.min(halfBreadth(s, endX(s, ya) + 1e-3, ya), halfBreadth(s, endX(s, yb) + 1e-3, yb));
    if (hb < 0.3) continue;
    const ze = acrossEdges(s, -hb, hb, TOL);
    for (let j = 0; j < ze.length - 1; j++) {
      const za = ze[j], zb = ze[j + 1];
      const row = (y0: number, y1: number): V3[] => [[endX(s, y0), y0, zb], [endX(s, y0), y0, za], [endX(s, y1), y1, za], [endX(s, y1), y1, zb]];
      const q = row(ya, yb);
      quadPlate(q[0], q[1], q[2], q[3], 0.8, [1, 0, 0], row, ya, yb);
    }
  }
  mark("transom");
  // ---- main deck: pitched tiles whose tops ARE the deck plates, out to the shell's outer face
  const dk = (x: number) => deckY(s, x);
  // (0.085 m tiles: deck fit p99 0.17 m)
  const xe = tileEdges(s, endX(s, s.depth) + 0.05, L - 2.2, dk, 0.085);
  for (let i = 0; i < xe.length - 1; i++) {
    const xa = xe[i], xb = xe[i + 1], xm = (xa + xb) / 2, hb = halfBreadth(s, xm, dk(xm));
    if (hb < 0.4) continue;
    const hatch = xm > s.openHatch[0] && xm < s.openHatch[1];
    const spans: Array<[number, number]> = hatch ? [[-hb, -4], [4, hb]] : [[-hb, hb]];
    for (const [z0, z1] of spans) { const ze = acrossEdges(s, z0, z1, 0.085); for (let k = 0; k < ze.length - 1; k++) out.push(slab(s, xa, xb, ze[k], ze[k + 1], dk, 0.35)); }
  }
  mark("deck");
  // ---- hold floor (tank top at 1.5 m) — reached through the break and the broken hatch
  const hf = () => 1.5;
  const xh = tileEdges(s, 4, L - 1, hf, 0.25);
  for (let i = 0; i < xh.length - 1; i++) {
    const xm = (xh[i] + xh[i + 1]) / 2, hb = halfBreadth(s, xm, 1.5) - 0.4;
    if (hb < 0.6) continue;
    const ze = acrossEdges(s, -hb, hb, 0.25);
    for (let k = 0; k < ze.length - 1; k++) out.push(slab(s, xh[i], xh[i + 1], ze[k], ze[k + 1], hf, 0.4));
  }
  mark("hold");
  // ---- the tween deck the client draws inside the torn end
  // (the-wreck/freighter.ts breakDetail: a floor at depth·0.57 from L−14 to the tear in 1.2 m strips, the last ones torn
  // short by the same hash) stops rounds going into the hold. Same strips, tiled to the tilt
  { const tw = s.depth * 0.57, top = () => tw + 0.1;
    for (let x = L - 14; x < L - 1.5; x += 1.2) {
      const hb = halfBreadth(s, x, tw) - 0.3, torn = x > L - 4 ? clientHash(x, s.x) * 3 : 0, h = hb - torn / 2;
      if (h < 0.6) continue;
      const xe2 = tileEdges(s, x, x + 1.2, top, TOL), ze = acrossEdges(s, -h, h, TOL);
      for (let i = 0; i < xe2.length - 1; i++) for (let k = 0; k < ze.length - 1; k++) out.push(slab(s, xe2[i], xe2[i + 1], ze[k], ze[k + 1], top, 0.2));
    } }
  mark("tween");
  // ---- hatch coamings (0.9 m steel lips = cover) + the intact hatch covers
  for (const [ha, hb2] of s.hatches) {
    const y = dk((ha + hb2) / 2), open = ha === s.openHatch[0];
    for (const z of [-4.1, 4.1]) {
      const xs = tileEdges(s, ha - 0.15, hb2 + 0.15, dk, TOL * 2);
      if (open && s.id === "stern" && z < 0) xs.push(HOLD_STAIR.x0 - 0.2, HOLD_STAIR.x0 + 1.35), xs.sort((p, q) => p - q);
      for (let i = 0; i < xs.length - 1; i++) { if (open && holdCoamingGap(s, (xs[i] + xs[i + 1]) / 2, z)) continue; if (xs[i + 1] - xs[i] < 0.05) continue; out.push(piece(s, [(xs[i] + xs[i + 1]) / 2, y + 0.45, z], [(xs[i + 1] - xs[i]) / 2, 0, 0], [0, 0.45, 0], [0, 0, 0.11])); }
    }
    for (const x of [ha, hb2]) for (const [z0, z1] of [[-4.2, 0], [0, 4.2]]) out.push(piece(s, [x, y + 0.45, (z0 + z1) / 2], [0.11, 0, 0], [0, 0.45, 0], [0, 0, (z1 - z0) / 2]));
    if (!open) { const xs = tileEdges(s, ha, hb2, () => y + 1.06, TOL); for (let i = 0; i < xs.length - 1; i++) for (const [z0, z1] of [[-4.05, 0], [0, 4.05]]) out.push(slab(s, xs[i], xs[i + 1], z0, z1, () => y + 1.06, 1.06)); }
  }
  mark("hatches");
  // winches (twin drums) + mushroom vents on deck
  for (let x = 6; x < L - 8; x += 9.5) for (const side of [-1, 1]) {
    if (underExtStair(s, x, side)) continue;
    const y = dk(x), hb = halfBreadth(s, x, y);
    out.push(piece(s, [x + 0.35, y + 0.35, side * (hb - 1.0)], [0.63, 0, 0], [0, 0.35, 0], [0, 0, 0.28]));
  }
  // ventilators (gooseneck + mushroom) and twin bollards along the bulwarks — the client's deckGear() draws the same
  for (const [x, z] of [[11, 2.6], [L * 0.55, 2.6], [L * 0.3, -3.2]] as Array<[number, number]>) {
    const y = dk(x);
    if (!inHouse(s, x)) out.push(piece(s, [x + 0.15, y + 1.05, z], [0.45, 0, 0], [0, 1.05, 0], [0, 0, 0.4]));
    const x2 = ventX2(s, x);
    if (!inHouse(s, x2)) out.push(piece(s, [x2, dk(x2) + 0.65, -z * 0.6], [0.42, 0, 0], [0, 0.65, 0], [0, 0, 0.42]));
  }
  for (let x = 4; x < L - 6; x += 12) for (const side of [1, -1]) {
    const y = dk(x), z = side * (halfBreadth(s, x, y) - 0.8);
    out.push(piece(s, [x, y + 0.28, z], [0.6, 0, 0], [0, 0.28, 0], [0, 0, 0.25]));
  }
  mark("winches+vents");
  // ---- superstructure: hollow wall plates per level (the closed rooms are never entered), bridge wings, a tiled roof
  const H = s.house, torn = houseTorn(s), WT = 0.5;
  for (let l = 0; l < H.levels; l++) {
    const Lv = houseLevel(s, l), y0 = Lv.y0, y1 = y0 + HOUSE_LH, ym = (y0 + y1) / 2, hw = Lv.hw;
    const xClosed = torn ? H.x1 - TORN_ROOM : Lv.x1;
    for (const side of [1, -1]) {
      const xEnd = torn ? tornWallEnd(s, l, side) : Lv.x1, holes = houseHoles(s, l, side);
      // (the holes open into the rooms — no gutted-room back wall; the level-0 holes are the doorways in)
      // wall pieces are level boxes: on a pitched section their length must keep the sloping bottom/top edges in TOL
      const wallCell = Math.max(0.6, Math.min(2, (4 * TOL) / Math.max(0.05, Math.abs(dmath.sin(s.pitch)))));
      for (const [xa, xb] of cells(Lv.x0, xEnd, wallCell).flatMap(([a, b]): Array<[number, number]> => {
        let segs: Array<[number, number]> = [[a, b]];
        for (const hl of holes) segs = segs.flatMap(([p, q]) => (hl.x1 <= p || hl.x0 >= q ? [[p, q]] : [[p, Math.max(p, hl.x0)], [Math.min(q, hl.x1), q]]).filter(([u, v]) => v - u > 0.15) as Array<[number, number]>);
        return segs;
      })) {
        // sub-rows: the roll leans the wall across, the pitch along (the fit pads a leaning piece along its length —
        // at the house corners that padding would stand up to 0.43 m proud of the front wall)
        const endCell = xa - Lv.x0 < 0.05 || xEnd - xb < 0.05;
        const sub = Math.max(1, Math.ceil((HOUSE_LH / 2) * Math.max(Math.abs(dmath.sin(s.roll)), endCell ? Math.abs(dmath.sin(s.pitch)) : 0) / TOL));
        for (let k = 0; k < sub; k++) { const ya = y0 + (HOUSE_LH * k) / sub, yb = y0 + (HOUSE_LH * (k + 1)) / sub; out.push(piece(s, [(xa + xb) / 2, (ya + yb) / 2, side * (hw - WT / 2)], [(xb - xa) / 2, 0, 0], [0, (yb - ya) / 2, 0], [0, 0, WT / 2])); }
      }
    }
    // end walls (front x0, the closed back wall at x1 or the torn rooms' back wall): lean with the pitch → sub-rows
    const sub = Math.max(1, Math.ceil((HOUSE_LH / 2) * Math.abs(dmath.sin(s.pitch)) / 0.1));
    const zn = Math.max(1, Math.ceil((2 * hw) / 2)), ze = [...Array(zn + 1)].map((_, i) => -hw + (2 * hw * i) / zn);
    for (const [xw, t] of [[Lv.x0 + WT / 2, WT], [xClosed - (torn ? 0.15 : WT / 2), torn ? 0.3 : WT]] as Array<[number, number]>) for (let k = 0; k < sub; k++) for (let j = 0; j < ze.length - 1; j++) {
      const ya = y0 + (HOUSE_LH * k) / sub, yb = y0 + (HOUSE_LH * (k + 1)) / sub;
      // (the torn rooms' back wall has a doorway into the house on every level — its lintel stays)
      const door = torn && xw !== Lv.x0 + WT / 2 && ze[j] < TORN_DOOR[1] - 0.05 && ze[j + 1] > TORN_DOOR[0] + 0.05;
      if (door) { if (yb > y0 + 2.3) { const y2 = Math.max(ya, y0 + 2.3); out.push(piece(s, [xw, (y2 + yb) / 2, (TORN_DOOR[0] + TORN_DOOR[1]) / 2], [0, 0, (TORN_DOOR[1] - TORN_DOOR[0]) / 2], [0, (yb - y2) / 2, 0], [t / 2, 0, 0])); } continue; }
      out.push(piece(s, [xw, (ya + yb) / 2, (ze[j] + ze[j + 1]) / 2], [0, 0, (ze[j + 1] - ze[j]) / 2], [0, (yb - ya) / 2, 0], [t / 2, 0, 0]));
    }
    // torn rooms: the floor of every upper level runs out to the tear (you can climb in and walk the rooms)
    if (torn && l > 0) { const xs = tileEdges(s, xClosed, H.x1 - 0.2, () => y0, TOL); for (let i = 0; i < xs.length - 1; i++) for (let j = 0; j < ze.length - 1; j++) out.push(slab(s, xs[i], xs[i + 1], ze[j], ze[j + 1], () => y0, 0.25)); }
    void ym;
  }
  {
    const Lt = houseLevel(s, H.levels - 1), top = Lt.y0 + HOUSE_LH;
    const x0 = Lt.x0, x1 = torn ? H.x1 - 2.0 : Lt.x1;
    const [w0, w1, v0, v1] = houseStair(s).holes(H.levels)[0];
    // (tile edges split at the hatch so the opening is exact)
    const cutIn = (a: number[], e: number[]) => [...new Set([...a, ...e.filter((v) => v > a[0] + 0.05 && v < a[a.length - 1] - 0.05)])].sort((p, q) => p - q);
    const xs = cutIn(tileEdges(s, x0, x1, () => top + 0.24, 0.1), [w0, w1]), ze = cutIn(acrossEdges(s, -Lt.hw, Lt.hw, 0.1), [v0, v1]);
    for (let i = 0; i < xs.length - 1; i++) for (let j = 0; j < ze.length - 1; j++) {
      // (the stairwell comes up through a hatch in the roof)
      const xm = (xs[i] + xs[i + 1]) / 2, zm = (ze[j] + ze[j + 1]) / 2;
      if (xm > w0 && xm < w1 && zm > v0 && zm < v1) continue;
      out.push(slab(s, xs[i], xs[i + 1], ze[j], ze[j + 1], () => top + 0.24, 0.6));
    }
    // open bridge wings at the bridge deck — a plate on
    // brackets with a bulwark round its three open sides (wreckWing: the same numbers draw them)
    for (const side of [1, -1]) for (const q of wreckWing(s, side)) out.push(piece(s, q.c, [q.h[0], 0, 0], [0, q.h[1], 0], [0, 0, q.h[2]]));
  }
  // the interior (stairwell, floors, furniture) + the hold stair — fitted to the tilted section
  for (const p of [...houseInteriorPieces(s), ...holdStairPieces(s), ...extStairPieces(s)]) if (p.solid !== false) out.push(...sectionPieceBoxes(s, p));
  mark("house");
  // ---- funnel: stacked leaning pieces (rounded-rect casing ≈ a cross of two boxes), rake + taper like the mesh
  {
    const F = s.funnel, x = H.funnelX, fdk = dk(x), rake = 0.9 * (s.id === "bow" ? 1 : -1), r = Math.min(F.hx, F.hz) * (F.round ?? 0.62), tp = F.taper ?? 0.07;
    const n = Math.max(2, Math.ceil(F.h / Math.max(0.8, Math.min(6, (2 * TOL) / Math.max(1e-3, Math.abs(dmath.sin(s.pitch)) + 0.05, tp * Math.max(F.hx, F.hz) / F.h)))));
    for (let i = 0; i < n; i++) {
      const ya = -0.5 + ((F.h + 0.5) * i) / n, yb = -0.5 + ((F.h + 0.5) * (i + 1)) / n, yy = (ya + yb) / 2, k = 1 - tp * (yy / F.h);
      const c: V3 = [x + rake * (yy / F.h), fdk + yy, 0];
      out.push(piece(s, c, [F.hx * k, 0, 0], [0, (yb - ya) / 2, 0], [0, 0, (F.hz - r * 0.3) * k]));
      out.push(piece(s, c, [(F.hx - r * 0.3) * k, 0, 0], [0, (yb - ya) / 2, 0], [0, 0, F.hz * k]));
    }
  }
  mark("funnel");
  // ---- mast (tapered pole): stacked pieces
  {
    const x = H.mastX, base = dk(x) + H.levels * HOUSE_LH, h = 15, n = s.pitch > 0.1 ? 10 : 4;
    for (let i = 0; i < n; i++) { const ya = (h * i) / n, yb = (h * (i + 1)) / n, rr = 0.26 - 0.1 * ((ya + yb) / 2 / h); out.push(piece(s, [x, base + (ya + yb) / 2, 0], [rr, 0, 0], [0, (yb - ya) / 2, 0], [0, 0, rr])); }
  }
  mark("mast");
  if (s.id === "stern") {
    const G = STERN_GEAR;
    out.push(piece(s, [(G.rudderX0 + G.rudderX1) / 2, (G.rudderY0 + G.rudderY1) / 2, 0], [(G.rudderX1 - G.rudderX0) / 2, 0, 0], [0, (G.rudderY1 - G.rudderY0) / 2, 0], [0, 0, 0.2]));
    out.push(piece(s, [G.propX + 0.3, G.propY, 0], [0.7, 0, 0], [0, 0.55, 0], [0, 0, 0.55]));
    mark("stern-gear");
  }
  // pieces buried in the beach (the bow's stem is dug into the sand): the heightfield already stops everything there
  return out.filter((b) => b.c[1] + b.h[1] > groundY(b.c[0], b.c[2]) - 0.6);
}

/**
 * DEBRIS CASCADES at the breaks: slabs of deck / tween deck
 * folded down out of the tear onto the reef. Section-local hinge on the torn edge, `len` out from it at `drop` rad below
 * the section's horizontal, `w` wide across the beam centred at `z`, a slight `skew` about the vertical; `t` thick.
 * Visual (client freighter.ts) + colliders (yaw-only columns fitted to the slab) come from the same numbers.
 */
export interface DebrisSlab { s: "bow" | "stern"; hinge: V3; len: number; drop: number; w: number; skew: number; t: number; deck: boolean }
export const BREAK_DEBRIS: DebrisSlab[] = [
  // stern: the main deck at the break folded down into the rubble, the tween deck slumped out under it, a hull plate
  // hanging off the beach-side corner
  { s: "stern", hinge: [STERN.length - 2.4, STERN.depth - 0.2, -1.5], len: 9.5, drop: 0.95, w: 11, skew: 0.12, t: 0.32, deck: true },
  { s: "stern", hinge: [STERN.length - 1.2, STERN.depth * 0.57, 3.5], len: 6.5, drop: 0.55, w: 8, skew: -0.25, t: 0.28, deck: true },
  { s: "stern", hinge: [STERN.length - 1.5, STERN.depth - 1.5, -(STERN.beam / 2 - 2.5)], len: 7, drop: 1.25, w: 4.5, skew: 0.3, t: 0.2, deck: false },
  // the collapse continues down to the waterline — tween-deck chunks, torn shell plates and a hatch-cover slab shingled
  // over each other beyond the tear, stepping from ~11 m down onto the reef rocks and heap B
  { s: "stern", hinge: [STERN.length + 2.5, 11.5, -4.5], len: 6.5, drop: 0.75, w: 6, skew: 0.35, t: 0.28, deck: true },
  { s: "stern", hinge: [STERN.length + 3.5, 8.2, 2.5], len: 6, drop: 0.5, w: 6.5, skew: -0.45, t: 0.3, deck: false },
  { s: "stern", hinge: [STERN.length + 6, 7.4, -6.5], len: 5.5, drop: 0.62, w: 5, skew: 0.6, t: 0.22, deck: true },
  { s: "stern", hinge: [STERN.length + 1.5, 14.5, -8], len: 5, drop: 1.0, w: 3.5, skew: -0.2, t: 0.2, deck: false },
  { s: "stern", hinge: [STERN.length + 5, 5.8, 5.5], len: 5, drop: 0.32, w: 5, skew: 0.3, t: 0.25, deck: true },
  // bow: a deck slab hanging from the high break down onto heap B + a torn shell plate on the beach side
  { s: "bow", hinge: [BOW.length - 2.4, BOW.depth - 0.2, 2.5], len: 8.5, drop: 1.05, w: 9, skew: -0.18, t: 0.32, deck: true },
  { s: "bow", hinge: [BOW.length - 1.6, BOW.depth - 2.5, BOW.beam / 2 - 2.2], len: 6.5, drop: 1.3, w: 4.2, skew: -0.35, t: 0.2, deck: false },
];
/** a debris slab's section-local frame: centre + unit axes (along = down the slab from the hinge, up = its top normal,
 *  across) and half sizes */
export function debrisFrame(d: DebrisSlab): { c: V3; A: [V3, V3, V3]; h: V3 } {
  const ca = dmath.cos(d.drop), sa = dmath.sin(d.drop), cs = dmath.cos(d.skew), ss = dmath.sin(d.skew);
  const along: V3 = [ca * cs, -sa, ca * ss], up: V3 = [sa * cs, ca, sa * ss], across: V3 = [-ss, 0, cs];
  const c: V3 = [d.hinge[0] + along[0] * d.len / 2 - up[0] * d.t / 2, d.hinge[1] + along[1] * d.len / 2 - up[1] * d.t / 2, d.hinge[2] + along[2] * d.len / 2 - up[2] * d.t / 2];
  return { c, A: [along, up, across], h: [d.len / 2, d.t / 2, d.w / 2] };
}
function debrisBoxes(): Box[] {
  const cols = BREAK_DEBRIS.flatMap((d) => {
    const s = d.s === "bow" ? BOW : STERN, f = debrisFrame(d);
    return solidColumns(sectionToWorld(s, f.c[0], f.c[1], f.c[2]), [rot(s, f.A[0]), rot(s, f.A[1]), rot(s, f.A[2])], f.h, 0.15, "metal", 3);
  }).filter((b) => b.c[1] + b.h[1] > groundY(b.c[0], b.c[2]) - 0.5);
  // the crawl space under a leaning plate (its underside < 2.2 m over the ground) is packed rubble for the
  // capsule (noShoot: bullets still pass under the plate) — with the reef boulders' real colliders round it, one such
  // 4 m² wedge under the bow's beach-side plate would be a sealed pocket
  const fill: Box[] = [];
  for (const b of cols) {
    const g = groundY(b.c[0], b.c[2]), bot = b.c[1] - b.h[1];
    if (bot > g + 0.05 && bot < g + 3.6) fill.push({ c: [b.c[0], (g - 0.3 + bot) / 2, b.c[2]], h: [b.h[0], (bot - g + 0.3) / 2, b.h[2]], yaw: b.yaw, surf: "metal", noShoot: true });
  }
  // (and the 4 m² wedge on the reef rocks under the bow's beach-side plate, world (−888, 0, 140): rock tops 0–0.4 m,
  // the plate 1.3–2.4 m over them, walled in by the boulders — a sealed pocket for the scanner)
  fill.push({ c: [-887.9, 0.6, 140.35], h: [1.15, 1.0, 0.75], yaw: 0, surf: "stone", noShoot: true });
  return [...cols, ...fill];
}

/** the ramp as steps (shared by the colliders and the client's plate visuals): per step the segment [t0,t1], the
 *  step top, and the width split into lanes */
export function rampSteps(r: Ramp): Array<{ t0: number; t1: number; top: number; lane0: number; lane1: number }> {
  const [ax, ay, az] = r.a, [bx, by, bz] = r.b;
  const len = dmath.hypot(bx - ax, bz - az), n = Math.max(2, Math.ceil(Math.max(len / 0.7, (by - ay) / 0.26)));
  const lanes = 1;
  const out: Array<{ t0: number; t1: number; top: number; lane0: number; lane1: number }> = [];
  for (let i = 0; i < n; i++) for (let k = 0; k < lanes; k++) out.push({ t0: i / n, t1: (i + 1) / n, top: ay + (by - ay) * ((i + 1) / n), lane0: -r.w / 2 + (r.w * k) / lanes, lane1: -r.w / 2 + (r.w * (k + 1)) / lanes });
  return out;
}
/** each step = ONE yawed box along the ramp heading (exact: the steps are level) */
function rampBoxes(r: Ramp): Box[] {
  const [ax, , az] = r.a, [bx, , bz] = r.b;
  const len = dmath.hypot(bx - ax, bz - az), dx = (bx - ax) / len, dz = (bz - az) / len, px = -dz, pz = dx;
  const yaw = dmath.atan2(dz, dx);
  return rampSteps(r).map((st) => {
    const t = (st.t0 + st.t1) / 2, lm = (st.lane0 + st.lane1) / 2;
    return { c: [ax + (bx - ax) * t + px * lm, st.top - 0.6, az + (bz - az) * t + pz * lm], h: [(len * (st.t1 - st.t0)) / 2, 0.6, (st.lane1 - st.lane0) / 2], yaw, surf: "metal" } as Box;
  });
}

/** where a debris ramp crosses the hull edge, the shell under it is crumpled flat: drop shell/deck pieces that would
 *  poke through the ramp's walking surface (so the ramp walks straight onto the deck) */
function clipUnderRamps(boxes: Box[]): Box[] {
  const out: Box[] = [];
  for (const b0 of boxes) {
    let b: Box | null = b0;
    for (const r of RAMPS) {
      if (!b) break;
      const [ax, ay, az] = r.a, [bx, by, bz] = r.b, dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
      const cur: Box = b;
      const t: number = ((cur.c[0] - ax) * dx + (cur.c[2] - az) * dz) / L2;
      // (the last 12 % lands on the deck — clipping the deck tiles there would leave a 1 m hole in the bow deck)
      // (…but on the listing STERN the side shell plate and the deck's edge tile there stand 0.7–1.2 m over
      //  the treads, overhanging them — a wall you could only mantle; on that ramp every piece is
      //  cut to the treads right up to the top, the deck edge becomes the ramp's last tread)
      if (t < 0 || t > (r === RAMPS[1] ? 1.0 : 0.88)) continue;
      const px = ax + dx * t, pz = az + dz * t;
      if (dmath.hypot(cur.c[0] - px, cur.c[2] - pz) > r.w / 2 + 0.3) continue;
      const rampY: number = ay + (by - ay) * t;
      // (only pieces that would poke THROUGH the walking surface: tiles flush with it — the deck at the ramp's top — stay)
      if (cur.c[1] + cur.h[1] > rampY + 0.12 && cur.c[1] - cur.h[1] < rampY + 2.4) {
        // cut the piece down to just under the walking surface instead of dropping it (dropping leaves a 1 m hole in
        // the shell under the stern ramp's top: bullets go into the hold)
        const bot: number = cur.c[1] - cur.h[1], top: number = rampY - 0.05;
        b = top - bot > 0.12 ? { ...cur, c: [cur.c[0], (bot + top) / 2, cur.c[2]], h: [cur.h[0], (top - bot) / 2, cur.h[2]] } : null;
      }
    }
    if (b) out.push(b);
  }
  return out;
}

/** the lookout (u along the facing direction, v to its right) as yawed boxes */
function lookoutBox(u0: number, u1: number, v0: number, v1: number, y0: number, y1: number, surf: Box["surf"]): Box {
  const [x, z] = lookoutAt((u0 + u1) / 2, (v0 + v1) / 2);
  return { c: [x, (y0 + y1) / 2, z], h: [(u1 - u0) / 2, (y1 - y0) / 2, (v1 - v0) / 2], yaw: dmath.atan2(COMP.fz, COMP.fx), surf };
}

/** the wreck's colliders by part (the probe + debug views use the split; the sim gets `colliders`) */
export function colliderParts(): Record<string, Box[]> {
  const L = LOOKOUT, look: Box[] = [];
  look.push(lookoutBox(-L.hs, L.hs, -L.hs, L.hs, L.deckY - 0.25, L.deckY, "wood"));
  look.push(lookoutBox(L.hs - 0.15, L.hs + 0.05, -L.hs, L.railV, L.deckY, L.deckY + 1.05, "wood"));
  look.push(lookoutBox(-L.hs + 1.2, L.hs, -L.hs - 0.1, -L.hs + 0.1, L.deckY, L.deckY + 1.05, "wood"));
  const n = Math.ceil((L.deckY - L.ground) / 0.4);
  for (let k = 0; k < n; k++) {
    const t = (k + 1) / n, u = -L.hs - 0.2 - (1 - t) * (L.deckY - L.ground) * 0.75;
    look.push(lookoutBox(u - 0.2, u + 0.2, -L.hs, -L.hs + 1.1, L.ground + (L.deckY - L.ground) * t - 0.12, L.ground + (L.deckY - L.ground) * t, "wood"));
  }
  return {
    bow: clipUnderRamps(hullBoxes(BOW)),
    stern: clipUnderRamps(hullBoxes(STERN)),
    ramps: RAMPS.flatMap(rampBoxes),
    // the salvage boardwalk (deck, landings, crates, beach steps, boarding steps)
    walk: walkPieces().map((p): Box => ({ c: p.c, h: p.h, yaw: p.yaw, surf: "wood" })),
    debris: debrisBoxes(),
    // (column pieces buried in the sand / seabed are dropped: the heightfield already stops everything there)
    spill: CONTAINERS.flatMap(containerBoxes).filter((b) => b.c[1] + b.h[1] > groundY(b.c[0], b.c[2]) - 0.5),
    deckBoxes: deckBoxPlacements().flatMap(containerBoxes),
    // reef/beach rocks: base k.y (the visual sits its sculpted boulder there, top ≈ base + 0.75 r)
    lookout: look,
    // the stern house's furniture (shared interiors kit)
    sternRooms: sternRoomBoxes(),
    // the bow house's furniture (kit, tiled to the 23° slope)
    bowRooms: roomBoxes(BOW, BOW_ROOMS),
    core: [...bowCoreStrips().map((q): Box => ({ c: q.c, h: q.h, yaw: q.yaw, surf: "metal" })),
      // the ledge pocket between the packed core and the stepped starboard plating under the deck (a sealed 4 m²
      // floor) — filled with collapsed cargo up to the deck's underside
      piece(BOW, [19.6, 17.3, 10.3], [1.4, 0, 0], [0, 1.25, 0], [0, 0, 1.0])],
    // (voxelised offline from the drawn rocks; the approximate boxes below when stale)
    ...((): { rocks: Box[]; bluff: Box[] } => {
      const baked = bakedRockBoxes("the-wreck", ROCK_BAKE, ROCK_SIG);
      if (baked) return { rocks: baked, bluff: [] };
      return {
    rocks: ROCKS.filter((k) => k.r > 1.2).map((k): Box => ({ c: [k.x, (k.y ?? -1) + k.r * 0.2, k.z], h: [k.r * 0.8, k.r * 0.55, k.r * 0.8], surf: "stone" })),
    // the headland: each block with its own yaw (visual rocks use three.js Ry(ry) → sim yaw −ry), shrunk to the rocks
    // (every block is a solid column down into the sand — stacked blocks leave pockets between them that read as
    // sealed rooms under a 'roof' at the crown)
    bluff: BLUFF.map((b): Box => { const base = Math.min(b.y0, groundY(b.x, b.z) - 1.5), top = b.y0 + b.h; return { c: [b.x, (base + top) / 2, b.z], h: [(b.w / 2) * 0.86, (top - base) / 2, (b.d / 2) * 0.86], yaw: -b.ry, surf: "stone" }; }),
      };
    })(),
  };
}
export const colliders: Box[] = Object.values(colliderParts()).flat();

/** vegetation keep-out: the hulls, the spill on the beach + in the shallows (world) — the beach palms are placed by the client */
export const clearings: Array<{ x: number; z: number; r: number } | { x: number; z: number; hx: number; hz: number; yaw?: number }> = [
  ...SECTIONS.map((sec) => { const m = sectionToWorld(sec, sec.length / 2, 0, 0); return { x: m[0], z: m[2], r: sec.length / 2 + 10 }; }),
  ...[[30, -20, 22], [70, -30, 26], [60, 10, 30]].map(([d, deg, r]) => { const [x, z] = fromCam(d, deg); return { x, z, r }; }),
  ...BLUFF.filter((b) => b.y0 < 2).map((b) => ({ x: b.x, z: b.z, r: Math.max(b.w, b.d) / 2 + 2 })),
];

// ---------------------------------------------------------------- designed loot (the LOOT_SPOTS contract)
/** Chests in every level of both superstructures (mess, cabins, bridge), in the stern's open hold, the torn rooms and
 *  the open deck boxes; floor loot along the decks, the forecastle, the hold stair, the lookout, the spill on the beach.
 *  Authored in section-local coordinates; y settles onto the shared colliders (world metres). */
/** nothing pokes into the loot's own volume (a 0.36 m disc from 3 cm over its floor to 0.6 m) */
function lootFits(bs: Box[], x: number, y: number, z: number): boolean {
  for (const b of bs) {
    if (b.c[1] + b.h[1] <= y + 0.03 || b.c[1] - b.h[1] >= y + 0.6) continue;
    let dx = x - b.c[0], dz = z - b.c[2];
    if (b.yaw) { const c = dmath.cos(b.yaw), s = dmath.sin(b.yaw); const u = dx * c + dz * s, v = -dx * s + dz * c; dx = u; dz = v; }
    const qx = Math.max(0, Math.abs(dx) - b.h[0]), qz = Math.max(0, Math.abs(dz) - b.h[2]);
    if (qx * qx + qz * qz < 0.36 * 0.36) return false;
  }
  return true;
}
export const LOOT_SPOTS: { chests: Array<[number, number, number, number]>; floor: Array<[number, number, number]> } = (() => {
  const near = boxGrid(colliders);
  const chests: Array<[number, number, number, number]> = [], floor: Array<[number, number, number]> = [];
  /** a section-local spot → the nearest clear, settled world spot within 2.5 m (the pitched / rolled decks and the torn
   *  rooms make exact authoring brittle); dropped when there is none */
  const W = (s: HullSection, x: number, y: number, z: number) => { const p = sectionToWorld(s, x, y, z); return clearSpot(near, p[0], p[1] + 0.2, p[2], 0.5, 2.5); };
  const W2 = (p: V3) => clearSpot(near, p[0], p[1] + 0.2, p[2], 0.25, 1.0);
  const chest = (s: HullSection, x: number, y: number, z: number, fx: number, fz: number) => { const p = W(s, x, y, z), f = sectionToWorld(s, fx, y, fz); if (p) chests.push([p[0], p[1], p[2], faceYaw(p[0], p[2], f[0], f[2])]); };
  const item = (s: HullSection, x: number, y: number, z: number) => { const p = W(s, x, y, z); if (p) floor.push(p); };
  // the stern house: the kit's own chest + floor slot per furnished room (section-local → world, settled + cleared)
  for (const r of STERN_ROOMS) {
    const l = furnishRoom(r).loot, c = l.chests[0], f = l.floor[l.floor.length - 1];
    // (one chest per level: the aft rooms' kit slot — the dining room's slot sat against the liner foot, lifted 0.4 m)
    if (c && /^stern-(house-\da|torn-2)$/.test(r.id ?? "")) { const p = sectionToWorld(STERN, c[0], c[1], c[2]), q = W2(p); if (q) { const a = sectionToWorld(STERN, c[0] + dmath.sin(c[3]), c[1], c[2] + dmath.cos(c[3])); chests.push([q[0], q[1], q[2], faceYaw(q[0], q[2], a[0], a[2])]); } }
    if (f) { const q = W2(sectionToWorld(STERN, f[0], f[1], f[2])); if (q) floor.push(q); }
  }
  // the bow house (pitched 23°): the kit's chest slot of one room per level + a floor slot per level, settled + cleared
  for (const [i, r] of BOW_ROOMS.entries()) {
    const l = furnishRoom(r).loot, c = l.chests[0], f = l.floor[l.floor.length - 1];
    // (no chests in the bow house — its floors lean with the bow, the kit's chest slots sit in the slope
    //  with nowhere level for a kong to stand and open them; the stern roof + quarterdeck chests replace them)
    void c;
    if (f && i % 3 === 0) { const q = W(BOW, f[0], f[1], f[2]); if (q) floor.push(q); }
  }
  // the stern's open hold (tank top) + the hold stair's landings
  // (the tank top itself is flooded: loot sits on the stair's upper landings and at the deck exit)
  { const s = STERN, lh = (deckY(s, HOLD_STAIR.x0 + 2) - 1.5) / HOLD_STAIR.storeys; item(s, HOLD_STAIR.x0 + 0.6, 1.5 + 3 * lh, HOLD_STAIR.zc); item(s, HOLD_STAIR.x0 + 0.6, deckY(s, HOLD_STAIR.x0), -3.4); }
  // main decks: aft mooring deck, between the hatches, the forecastle
  { const s = STERN; item(s, 12, deckY(s, 12), 3.5); item(s, 14, deckY(s, 14), 4.0); item(s, 3.5, deckY(s, 3.5), 0); }
  { const s = BOW; item(s, 8.5, deckY(s, 8.5), -2.5); item(s, 19, deckY(s, 19), 4.0); }
  // the stern's torn rooms at the break (the gutted end of every level), the lookout platform
  { const s = STERN, xr = s.house.x1 - TORN_ROOM / 2; chest(s, xr, houseInner(s, 0).y0, 4.0, xr, 0); }
  { const [x, z] = lookoutAt(-1.2, 1.4), [fx, fz] = lookoutAt(1.5, 1.4); chests.push([x, LOOKOUT.deckY, z, faceYaw(x, z, fx, fz)]); }
  // more deck: the stern's quarterdeck beside the house, the bow's break end
  { const s = STERN; item(s, 30, deckY(s, 30), 6.5); item(s, 30, deckY(s, 30), -6.5); }
  { const s = BOW; item(s, 46, deckY(s, 46), -4.0); }
  // a walk of spots along both decks (the pitched bow's too): every one that settles clear
  for (const [x, z] of [[6, 4], [26.5, -5], [48, 5], [50, -4]] as Array<[number, number]>) item(STERN, x, deckY(STERN, x), z);
  for (const [x, z] of [[4, 2], [22, -4], [30, 5], [40, -5], [52, 3]] as Array<[number, number]>) item(BOW, x, deckY(BOW, x), z);
  // the lookout + the spill on the beach (beside the tumbled boxes above the tide line)
  { const [x, z] = lookoutAt(0.2, 0.9); floor.push([x, LOOKOUT.deckY, z]); }
  // (each bearing walks in from the sea until the sand is dry: ≥ 0.9 m, off every collider top)
  for (const [d, deg] of [[34, -12], [48, 4], [40, 22], [58, 28], [26, 12], [70, 40]] as Array<[number, number]>) {
    for (let k = d; k > 6; k -= 1.5) { const [x, z] = fromCam(k, deg), g = groundY(x, z); if (g < 0.9) continue; const p = clearSpot(near, x, g, z, 0.5, 1.5); if (p) { floor.push(p); break; } }
  }
  // the stern house ROOF is a sniper perch (the house stair runs up to it) — a chest by the mast with a
  // clear view over the lagoon, the beach and both decks; and a chest on the stern's quarterdeck by the hold stair exit
  { const s = STERN, I = houseLevel(s, s.house.levels - 1), y = I.y0 + HOUSE_LH; chest(s, 40.5, y, 3.0, 40.5, 8); chest(s, 22.5, deckY(s, 22.5), -6.0, 22.5, 0); }
  // the boardwalk: a floor item on the middle landing (bait in the open lane between the beach and the stern)
  { const [x, z] = WALK.pts[4]; floor.push([x - 0.6, WALK.y, z - 0.4]); }
  // floor loot never sits against a low prop edge (a kong picking it up would be lifted onto it)
  // (two kit chest slots per bow level)
  // (a chest spot with a step under the capsule's own footprint lifts the kong)
  // every spot is SETTLED — moved ≤ 1.2 m to where the loot's own 0.36 m footprint rests on one floor (the
  // pitched deck tiles step ~0.15 m: a chest straddling two sinks into the upper one) and a kong can stand beside it —
  // or dropped (the bow house's sloped rooms put chests in the slope with nowhere to stand)
  const settle = <T extends number[]>(p: T): T | null => {
    for (const r of [0, 0.35, 0.7, 1.0, 1.2]) for (let k = 0, n = r === 0 ? 1 : 10; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + 0.3, x = p[0] + r * dmath.cos(a), z = p[2] + r * dmath.sin(a), bs = near(x, z), y = Math.max(floorUnder(bs, x, p[1] + 0.25, z), groundY(x, z));
      if (!(Math.abs(y - p[1]) < 0.45) || !lootFits(bs, x, y, z)) continue;
      let stand = false;
      for (const d of [0.9, 1.3, 1.7]) { for (let j = 0; j < 12 && !stand; j++) { const b = (j / 12) * Math.PI * 2, sx = x + d * dmath.cos(b), sz = z + d * dmath.sin(b), sb = near(sx, sz), sy = Math.max(floorUnder(sb, sx, y + 0.5, sz), groundY(sx, sz)); if (Math.abs(sy - y) < 0.5 && capsuleClear(sb, sx, sy, sz, 0.45, 0.6)) stand = true; } if (stand) break; }
      if (stand) { const q = [...p] as T; q[0] = x; q[1] = y; q[2] = z; return q; }
    }
    return null;
  };
  const S1 = chests.map(settle).filter((c): c is [number, number, number, number] => !!c), F1 = floor.map(settle).filter((f): f is [number, number, number] => !!f);
  // the dry beach is where most drops land: two SALVAGE chests washed up on the upper beach are listed first, so
  // loot-spots makes them the POI's always-live landmark chests — between them every landing point on the sand is
  // ≤ 8.9 s from a chest — and a line of floor guns across the sand every ~20 m. On open terrain (no boxes) y is the
  // terrain under each spot (sampled from island.bin); loot-spots' validateSpot re-snaps it (±0.3 m) or rejects it.
  const BEACH_HERO: V3[] = [[-818, 1.59, 112], [-764, 5.83, 76]];
  const BEACH_FLOOR: V3[] = [[-800, 3.05, 75], [-818, 1.75, 108], [-795, 4.06, 100], [-775, 4.73, 102], [-808, 2.59, 60], [-770, 4.89, 62], [-792, 1.97, 138], [-828, 1.28, 80], [-758, 4.57, 112], [-783, 3.97, 40], [-752, 6.62, 72], [-800, 2.44, 120]];
  const S2 = S1.filter((c) => noLowStep(near(c[0], c[2]), c[0], c[1], c[2], 0.45, 0.25, 0.6)), F2 = F1.filter((f) => noLowStep(near(f[0], f[2]), f[0], f[1], f[2], 0.8, 0.25, 0.6));
  return { chests: [...BEACH_HERO.map(([x, y, z]): [number, number, number, number] => [x, y, z, faceYaw(x, z, -800, 90)]), ...S2], floor: [...F2, ...BEACH_FLOOR] };
})();
