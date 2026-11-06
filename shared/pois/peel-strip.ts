// PEEL STRIP — shared layout + collision (client visuals AND the authoritative server derive from this file).
// A small tropical airstrip on the flat W plateau (pad y=14): cracked asphalt runway running SSE toward the rocky E
// ridge (turned so the midday sun (NNW) lights the hangar door, the plane and the tower from behind the camera),
// an enterable concrete control tower (square stairwell → glazed cab → wrap-around balcony), a 10 m timber spotter
// platform at the threshold, an enterable corrugated barrel-roof hangar (mezzanine, BANANA CO. plane half out of
// the door) with a lean-to shed, fuel drums, a windsock mast and a crashed old transport in the grass past the far
// end of the runway. World metres; conventions in coast-kit.ts.
import type { Box } from "../world/colliders";
import { POIS } from "../world/map";
import { vegTrunkColliders, VARIANTS } from "../world/veg-scatter"; // only CALLED lazily (import cycle — see coast-kit lazyBoxes)
import { interiorColliders, interiorLoot, type InteriorRoom } from "./interior-kit";
import { panes, settleLoot } from "./pane-kit";
import { F, addKitLoot, bx, doorLeaves, floraColliders, kitRoom, lazyBoxes, place, rng, settleFlora, stairs, sub, toBoxes, toWorld, wall, type Clearing, type Flora, type Frame, type LootSpots, type Piece, type V3 } from "./coast-kit";
import * as dmath from "../sim/dmath";

export const PAD = { x: -470, z: -40, y: 14 };
/** the map's pad circle (flat terrain at PAD.y inside `pad`) */
const POIS_PAD = POIS.find((p) => p.id === "peel-strip")!;
const D2R = Math.PI / 180;

// ------------------------------------------------------------------------------------------------ strip frame
/** origin = runway threshold centre (NW end); +X = along the runway toward the rocky E ridge (bearing 125°); +Z = right
 *  of the runway (SW). Oriented so the sun (NNW) falls from behind-left of the spotter deck (a NNE runway left the
 *  hangar door, the plane and the tower's front in shade) */
export const STRIP: Frame = F(-540, PAD.y, -112, -35 * D2R);
export const RWY = { len: 150, half: 9, shoulder: 3.2 };
/** strip-local → world */
export const sw = (lx: number, lz: number, ly = 0): V3 => toWorld(STRIP, lx, ly, lz);

// ------------------------------------------------------------------------------------------------ control tower
/**
 * Tower-local frame: origin = ground centre, +Z = front (door, banana logo), +X = right (runway side).
 * A 6×6 m concrete shaft with a square stairwell: 4 flights around the walls (rise 2.1 each) from the entrance corner
 * to the cab floor (8.6). Hatch in the cab floor over the last flight. Cab: low wall + outward-leaning glass + thick
 * roof slab; balcony (1.6 m) all round; door cab→balcony on the right face.
 */
export const TWR = {
  frame: sub(STRIP, F(8.5, 0, -33, -38 * D2R)),
  S: 3.0, wt: 0.4, lane: 1.2, rise: 2.1, floor0: 0.2, cab: 8.6, slab: 0.3,
  lowWall: 0.95, glassH: 2.3, lean: 0.62, balc: 2.1, roof0: 11.85, roofT: 0.65,
  /** the glazed cab overhangs the shaft (half-size 3.95 vs the 3.0 shaft) — a real control-tower cab, one room big
   *  enough for the loot generator (a 5.7 m cab leaves two 4- / 7-cell scraps around the hatch) */
  cabS: 3.95,
  doorX: -1.45, doorW: 1.6, doorH: 2.7,
  cabDoorZ: -0.9, cabDoorW: 1.3,
};
const IN = TWR.S - TWR.wt; // 2.6 inner half
const LN = IN - TWR.lane;  // 1.4 lane boundary
/** the cab-floor hatch reaches back over flight 2's last metre (tower-local z of its back edge over x ∈ [LN, IN]) */
export const TWR_HATCH_Z = -0.1;
/** external roof stair on the tower's left side (tower-local): lane width w outside the balcony, from the balcony
 *  landing (z0…z1) down −Z to the top landing at zTop, n treads */
export const TWR_ROOFSTAIR = { w: 1.2, z0: 2.2, z1: 3.5, zTop: -2.1, n: 13 };
export const TWR_STEPS = 11;
/** cab console along the back wall (tower-local box, from the cab floor) */
// (a 0.5 m desk in front of a monitor bank: a 0.7 m deep top makes a jump-only perch under the cab roof)
export const TWR_CONSOLE = { x0: -2.4, x1: 2.0, z0: -3.42, z1: -2.92, h: 0.85, bank: { z0: -3.66, z1: -3.42, h: 1.75 } };
/** the entrance door leaf (tower-local box): hinged at the doorway's right jamb, open 90° into the stairwell */
export const TWR_LEAF = { x0: TWR.doorX + TWR.doorW / 2 + 0.02, x1: TWR.doorX + TWR.doorW / 2 + 0.1, z0: TWR.S - TWR.wt - 0.03 - (TWR.doorW - 0.06), z1: TWR.S - TWR.wt - 0.03 };
export const TWR_FLIGHTS: Array<{ x: number; z: number; yaw: number; y0: number }> = [
  { x: -(IN + LN) / 2, z: LN, yaw: Math.PI, y0: TWR.floor0 },            // left wall, front → back
  { x: -LN, z: -(IN + LN) / 2, yaw: Math.PI / 2, y0: TWR.floor0 + TWR.rise },       // back wall, left → right
  { x: (IN + LN) / 2, z: -LN, yaw: 0, y0: TWR.floor0 + TWR.rise * 2 },                // right wall, back → front
  { x: LN, z: (IN + LN) / 2, yaw: -Math.PI / 2, y0: TWR.floor0 + TWR.rise * 3 },      // front wall, right → left
];
/** corner landings [cx, cz, top] */
export const TWR_LANDINGS: Array<[number, number, number]> = [
  [-(IN + LN) / 2, -(IN + LN) / 2, TWR.floor0 + TWR.rise],
  [(IN + LN) / 2, -(IN + LN) / 2, TWR.floor0 + TWR.rise * 2],
  [(IN + LN) / 2, (IN + LN) / 2, TWR.floor0 + TWR.rise * 3],
];
export const TWR_WINDOWS: Array<{ wall: "back" | "right" | "left"; u: number; y0: number; w: number; h: number }> = [
  { wall: "back", u: 3.0, y0: 3.9, w: 0.9, h: 1.2 },
  { wall: "right", u: 3.0, y0: 6.0, w: 0.9, h: 1.2 },
  { wall: "left", u: 3.0, y0: 1.9, w: 0.9, h: 1.2 },
];
/** spotter platform (strip-local): a 10 m timber lookout on four braced posts in the overrun BEHIND the threshold's
 *  left half, 20 m from the tower, stair behind it */
// In line with the tower's front: a camera on the deck sees the tower's door face + logo in the left foreground, the
// hangar door side three-quarter with the plane rolled out, the runway receding to the upper right to the crash
export const SPOT = { x: -17, z: -18.5, half: 2.2, y: 10.2, stairW: 1.3, stairZ: -17.7, stairN: 30 };

/** pitched railing collider following a line (frame-local) — bottom follows y0→y1, height h */
function railCol(x0: number, z0: number, y0: number, x1: number, z1: number, y1: number, h = 1.0): Piece {
  const L = dmath.hypot(x1 - x0, z1 - z0), yaw = dmath.atan2(x1 - x0, z1 - z0), pitch = -dmath.atan2(y1 - y0, L);
  return { k: "rail", c: [(x0 + x1) / 2, (y0 + y1) / 2 + h / 2, (z0 + z1) / 2], h: [0.05, h / 2, dmath.hypot(L, y1 - y0) / 2], yaw, pitch, col: true, noShoot: true, surf: "metal" };
}

const nr = (p: Piece): Piece => ({ ...p, k: "rail:new" }); // rails the client draws from the piece itself
function tower(): Piece[] {
  const { S, wt, floor0, cab, slab } = TWR, out: Piece[] = [];
  const top = cab - slab; // walls stop under the cab floor slab
  out.push(bx("tw:slab", -S - 0.35, -0.4, -S - 0.35, S + 0.35, floor0, S + 0.35, { surf: "concrete" }));
  const win = (w: "back" | "right" | "left") => TWR_WINDOWS.filter((q) => q.wall === w).map((q) => ({ u: q.u, w: q.w, y0: q.y0, h: q.h }));
  // front (door), back, left, right shaft walls
  out.push(...wall("tw:wall", -S, S - wt / 2, S, S - wt / 2, 0, top, wt, [{ u: TWR.doorX + S, w: TWR.doorW, y0: 0, h: floor0 + TWR.doorH }], { surf: "concrete" }));
  out.push(...wall("tw:wall", S, -S + wt / 2, -S, -S + wt / 2, 0, top, wt, win("back"), { surf: "concrete" }));
  out.push(...wall("tw:wall", -S + wt / 2, -S + wt, -S + wt / 2, S - wt, 0, top, wt, win("left"), { surf: "concrete" }));
  out.push(...wall("tw:wall", S - wt / 2, S - wt, S - wt / 2, -S + wt, 0, top, wt, win("right"), { surf: "concrete" }));
  // stair flights (visual steps + one ramp collider each) and corner landings
  const run = (IN - TWR.lane) * 2 / TWR_STEPS, rise = TWR.rise / TWR_STEPS;
  for (const f of TWR_FLIGHTS) out.push(...stairs("tw:step", f.x, f.z, f.y0, f.yaw, TWR.lane, rise, run, TWR_STEPS, { base: f.y0 - 0.25, surf: "concrete" }));
  for (const [cx, cz, t] of TWR_LANDINGS) out.push(bx("tw:land", cx - TWR.lane / 2, t - 0.3, cz - TWR.lane / 2, cx + TWR.lane / 2, t, cz + TWR.lane / 2, { surf: "concrete" }));
  // solid pier under the first corner landing (kept out of flight 0's lane, where it would be a 1.75 m wall at the stair foot)
  out.push(bx("tw:fill", -IN, floor0, -IN, -LN, floor0 + TWR.rise - 0.3, -LN, { col: true, surf: "concrete" }));
  // inner guard rails along each flight (bullets pass)
  for (const f of TWR_FLIGHTS) {
    const fx = dmath.sin(f.yaw), fz = dmath.cos(f.yaw), L = run * TWR_STEPS;
    // inner edge = the side toward the stairwell centre
    const ix = f.x + (Math.abs(fx) < 0.5 ? -Math.sign(f.x) * TWR.lane / 2 : 0), iz = f.z + (Math.abs(fz) < 0.5 ? -Math.sign(f.z) * TWR.lane / 2 : 0);
    out.push(railCol(ix, iz, f.y0, ix + fx * L, iz + fz * L, f.y0 + TWR.rise));
  }
  // cab floor (hatch open over the last flight + the front-right landing + the top 1 m of flight 2: a slab
  // edge at z = LN leaves 1.8 m of headroom over flight 2's last treads, the movement solver refuses the step and the
  // cab is unreachable), hatch guard rails round the opening
  out.push(bx("tw:cabfloor", -S, top, -S, LN, cab, LN, { surf: "concrete" }));
  out.push(bx("tw:cabfloor", LN, top, -S, S, cab, TWR_HATCH_Z, { surf: "concrete" }));
  out.push(bx("tw:cabfloor", IN, top, TWR_HATCH_Z, S, cab, LN, { surf: "concrete" }));
  out.push(bx("tw:cabfloor", -S, top, LN, -LN, cab, S, { surf: "concrete" }));
  out.push({ ...railCol(-LN, LN, cab, LN, LN, cab), k: "tw:hatchrail" });
  out.push({ ...railCol(LN, LN, cab, LN, TWR_HATCH_Z, cab), k: "tw:hatchrail" });
  out.push({ ...railCol(LN, TWR_HATCH_Z, cab, IN, TWR_HATCH_Z, cab), k: "tw:hatchrail" });
  // balcony deck all round (planks on the concrete edge)
  const B = S + TWR.balc;
  out.push(bx("tw:balc", -B, top, S, B, cab, B, { surf: "wood" }));
  out.push(bx("tw:balc", -B, top, -B, B, cab, -S, { surf: "wood" }));
  out.push(bx("tw:balc", -B, top, -S, -S, cab, S, { surf: "wood" }));
  out.push(bx("tw:balc", S, top, -S, B, cab, S, { surf: "wood" }));
  // balcony railing colliders (gap on the left side for the roof stair)
  const RS = TWR_ROOFSTAIR;
  out.push(railCol(-B, B, cab, B, B, cab, 1.1), railCol(B, B, cab, B, -B, cab, 1.1), railCol(B, -B, cab, -B, -B, cab, 1.1));
  out.push(railCol(-B, -B, cab, -B, RS.z0, cab, 1.1), railCol(-B, RS.z1, cab, -B, B, cab, 1.1));
  // roof access: a steel fire-escape stair outside the balcony's left side —
  // landing at balcony level, 13 treads along −Z, top landing flush with the roof slab (outside the roof's footprint,
  // so full headroom everywhere)
  {
    const x0 = -B - RS.w, x1 = -B - 0.1, roofTop = TWR.roof0 + TWR.roofT;
    out.push(bx("tw:rland", x0, cab - 0.25, RS.z0, -B + 0.05, cab, RS.z1, { surf: "metal" }));
    const n = RS.n, rise = (roofTop - cab) / n, run = (RS.z0 - RS.zTop) / n;
    out.push(...stairs("tw:rstep", (x0 + x1) / 2, RS.z0, cab, Math.PI, x1 - x0, rise, run, n, { surf: "metal" }));
    out.push(bx("tw:rland", x0, roofTop - 0.25, RS.zTop - 1.3, -(TWR.cabS + TWR.lean + 0.55) + 0.02, roofTop, RS.zTop, { surf: "metal" }));
    out.push(nr(railCol(x0 + 0.05, RS.z1, cab, x0 + 0.05, RS.z0, cab, 1.05)));
    out.push(nr(railCol(x0 + 0.05, RS.z0, cab, x0 + 0.05, RS.zTop, roofTop, 1.0)));
    out.push(nr(railCol(x0 + 0.05, RS.zTop, roofTop, x0 + 0.05, RS.zTop - 1.3, roofTop, 1.05)));
    out.push(nr(railCol(x0, RS.zTop - 1.25, roofTop, -(TWR.cabS + TWR.lean + 0.55), RS.zTop - 1.25, roofTop, 1.05)));
    out.push(nr(railCol(x0, RS.z1 - 0.05, cab, -B, RS.z1 - 0.05, cab, 1.05)));
  }
  // cab: low wall ring with the balcony door on the right face, glazing above (bullets pass), roof slabs
  const c0 = cab, hw = TWR.lowWall, gh = TWR.glassH, ci = TWR.cabS - 0.15;
  const door = [{ u: TWR.cabDoorZ + ci, w: TWR.cabDoorW, y0: 0, h: hw + gh }];
  out.push(...wall("tw:cabwall", -ci, ci, ci, ci, c0, hw, 0.3, [], { surf: "metal" }));
  out.push(...wall("tw:cabwall", ci, -ci, -ci, -ci, c0, hw, 0.3, [], { surf: "metal" }));
  out.push(...wall("tw:cabwall", -ci, -ci, -ci, ci, c0, hw, 0.3, [], { surf: "metal" }));
  out.push(...wall("tw:cabwall", ci, -ci, ci, ci, c0, hw, 0.3, door.map((d) => ({ ...d, h: hw })), { surf: "metal" }));
  const g0 = c0 + hw;
  out.push(...wall("tw:glass", -ci, ci, ci, ci, g0, gh, 0.15, [], { surf: "glass", noShoot: true, col: true }));
  out.push(...wall("tw:glass", ci, -ci, -ci, -ci, g0, gh, 0.15, [], { surf: "glass", noShoot: true, col: true }));
  out.push(...wall("tw:glass", -ci, -ci, -ci, ci, g0, gh, 0.15, [], { surf: "glass", noShoot: true, col: true }));
  out.push(...wall("tw:glass", ci, -ci, ci, ci, g0, gh, 0.15, [{ u: TWR.cabDoorZ + ci, w: TWR.cabDoorW, y0: 0, h: gh - 0.25 }], { surf: "glass", noShoot: true, col: true }));
  const R = TWR.cabS + TWR.lean + 0.55;
  out.push(bx("tw:roof", -R, TWR.roof0, -R, R, TWR.roof0 + TWR.roofT, R, { surf: "concrete", col: true }));
  out.push(bx("tw:roof2", -R + 0.5, TWR.roof0 + TWR.roofT, -R + 0.5, R - 0.5, TWR.roof0 + TWR.roofT + 0.35, R - 0.5, { surf: "concrete", col: true }));
  // console + mast collider
  // the radar / radio console runs along the back wall (in the middle of the cab it splits the floor into two
  // dead-end pockets — 4- and 7-cell scraps to the loot generator, not a room)
  out.push(bx("tw:console", TWR_CONSOLE.x0, cab, TWR_CONSOLE.z0, TWR_CONSOLE.x1, cab + TWR_CONSOLE.h, TWR_CONSOLE.z1, { col: true, surf: "metal" }));
  out.push(bx("tw:console", TWR_CONSOLE.x0, cab, TWR_CONSOLE.bank.z0, TWR_CONSOLE.x1, cab + TWR_CONSOLE.bank.h, TWR_CONSOLE.bank.z1, { col: true, surf: "metal" }));
  // the entrance door leaf, swung inward flat against the doorway's right jamb (drawn at exactly this box)
  out.push(bx("tw:leaf", TWR_LEAF.x0, floor0, TWR_LEAF.z0, TWR_LEAF.x1, floor0 + TWR.doorH - 0.04, TWR_LEAF.z1, { col: true, surf: "metal" }));
  out.push(bx("tw:mast", 1.2, TWR.roof0 + 1, -1.8, 1.7, TWR.roof0 + 8, -1.3, { col: true, surf: "metal", noShoot: true }));
  // crates + drums stacked by the door (cover)
  out.push(bx("tw:crates", 0.9, 0, S + 0.2, 2.9, 1.6, S + 1.3, { col: true, surf: "wood" }));
  return out;
}
export const TWR_LOCAL: Piece[] = tower();

// ------------------------------------------------------------------------------------------------ hangar
/**
 * Hangar-local frame: origin = floor centre, +X = toward the runway (big door gable), +Z = the long side facing the
 * threshold (banana mural, lean-to shed). Plank walls 4.6 m, segmental barrel roof (rise 5.4 → ridge 10 m).
 */
export const HGR = {
  frame: sub(STRIP, F(40, 0, -33, -122 * D2R)),
  L: 26, W: 20, HW: 4.6, AR: 5.4, over: 0.35, floor: 0.15,
  doorW: 13, doorH: 7.2,
  mezz: { x1: -7, y: 3.0 },
};
/** mezzanine stair (hangar-local): n treads over `len` m along the −z wall, from x = mezz.x1 + len down to mezz.x1 */
export const HGR_STAIR = { n: 10, len: 3.8 };
/** back gable openings (hangar-local z, from the floor): the workshop door and the high window */
export const HGR_BACKDOOR = { z: 4.0, w: 1.8, h: 2.8 };
export const HGR_BACKWIN: Array<[number, number, number, number]> = [[-5, -2.6, 5.6, 6.8]];
/** hangar workshop cover (hangar-local): [x0, z0, x1, z1, height, kind, base y (default floor)] — the client draws
 *  each at exactly this size (benches, shelving runs, the engine on its stand, crate staircases, tool chest) */
export const HGR_COVER: Array<[number, number, number, number, number, string, number?]> = [
  [-4.2, 8.8, -1.6, 9.7, 0.95, "hg:bench"], [0.2, 8.8, 2.8, 9.7, 0.95, "hg:bench"],
  [4.9, 9.0, 6.1, 9.7, 1.0, "hg:chest"],
  [1.0, -8.4, 2.1, -7.2, 1.5, "hg:crate"], [2.1, -8.4, 3.2, -7.2, 1.0, "hg:crate"], [3.2, -8.4, 4.3, -7.2, 0.5, "hg:crate"],
  [-5.5, 2.6, -2.5, 3.4, 2.0, "hg:shelf"], [-5.5, -3.4, -2.5, -2.6, 2.0, "hg:shelf"],
  // the work bay — a radial engine on its wheeled stand, two
  // loaded pallet racks (0.6 m deep: tops too narrow to stand on), two roll cabinets, an engine crate + step, a pallet
  [2.4, -0.6, 3.3, 0.65, 1.65, "hg:engine"],
  [-1.6, -5.65, 1.6, -5.05, 2.2, "hg:rack"], [-1.6, 5.05, 1.6, 5.65, 2.2, "hg:rack"],
  [4.6, -2.8, 5.4, -2.2, 1.05, "hg:cab"], [4.2, 1.2, 5.0, 1.8, 1.05, "hg:cab"],
  [-0.6, -1.7, 0.6, -0.6, 1.0, "hg:crate"], [0.6, -1.7, 1.2, -0.6, 0.5, "hg:crate"],
  [-3.6, -8.2, -2.4, -7.2, 0.55, "hg:pallet"],
  // on the mezzanine: two crate staircases (cover + a climb), the loot corner between them
  [-11.6, -6.2, -10.5, -5.0, 1.5, "hg:crate", 3.0], [-10.5, -6.2, -9.4, -5.0, 1.0, "hg:crate", 3.0], [-9.4, -6.2, -8.3, -5.0, 0.5, "hg:crate", 3.0],
  [-11.6, 5.0, -10.5, 6.2, 1.5, "hg:crate", 3.0], [-10.5, 5.0, -9.4, 6.2, 1.0, "hg:crate", 3.0], [-9.4, 5.0, -8.3, 6.2, 0.5, "hg:crate", 3.0],
];
/** barrel radius for the roof chord (W + 2·over) */
export const HGR_R = (dmath.pow(HGR.W / 2 + HGR.over, 2) + dmath.pow(HGR.AR, 2)) / (2 * HGR.AR);
/** roof (outer) height at local z */
export const hgrArch = (z: number) => HGR.HW + Math.sqrt(Math.max(0, HGR_R * HGR_R - z * z)) - (HGR_R - HGR.AR);
export const SHED = { x0: -12.5, x1: -5.5, z0: HGR.W / 2, z1: HGR.W / 2 + 4.8, eave: 2.9, rise: 1.5, doorX: -7.2, winX: -10.4 };
/** plane placement in hangar-local (nose +X): rolled half out of the door (door plane at x = 13) */
export const PLANE_AT = { x: 13.4, z: 0.4 }; // half out of the door (door plane x = 13): nose + prop in the sun
/** mobile airstair (hangar-local): up +z from z0 to the fuselage side at z1, n steps to the fuselage back (top) */
export const PLANE_STAIR = { x: 10.6, z0: -3.6, z1: -0.36, w: 1.1, top: 2.1, n: 6 };

function hangar(): Piece[] {
  const { L, W, HW, floor } = HGR, hl = L / 2, hw = W / 2, out: Piece[] = [];
  out.push(bx("hg:floor", -hl - 0.3, -0.4, -hw - 0.3, hl + 0.3, floor, hw + 0.3, { surf: "concrete" }));
  const t = 0.3, wh = HW - floor;
  // long walls
  out.push(...wall("hg:wall", -hl, hw - t / 2, hl, hw - t / 2, floor, wh, t, [{ u: 4.0, w: 1.8, y0: 0, h: 2.8 }], { surf: "wood" }));
  out.push(...wall("hg:wall", hl, -hw + t / 2, -hl, -hw + t / 2, floor, wh, t, [{ u: 13, w: 1.8, y0: 0, h: 2.8 }, { u: 6, w: 2.2, y0: 2.1, h: 1.1 }, { u: 20, w: 2.2, y0: 2.1, h: 1.1 }], { surf: "wood" }));
  // gable ends: lower walls + arch infill as vertical strips (collision); visuals use a true arch. The strip
  // edges fall EXACTLY on the openings' edges (fixed 1 m strips closed 0.5 m of each side of the big door — an
  // invisible wall the plane's wingtip turned into a 0.8 m slot nobody could pass)
  const gable = (x: number, ops: Array<[number, number, number, number]>) => {
    const cuts = new Set<number>();
    for (let i = 0; i <= 20; i++) cuts.add(+(-hw + (W * i) / 20).toFixed(4));
    for (const [z0, z1] of ops) { cuts.add(z0); cuts.add(z1); }
    const zs = [...cuts].sort((a, b) => a - b);
    for (let i = 0; i + 1 < zs.length; i++) {
      const z0 = zs[i], z1 = zs[i + 1], zm = (z0 + z1) / 2;
      if (z1 - z0 < 0.02) continue;
      const topY = hgrArch(Math.max(Math.abs(z0), Math.abs(z1))) - 0.25;
      const op = ops.find(([a, b2]) => zm > a && zm < b2);
      if (op) {
        if (op[2] > floor + 0.02) out.push(bx("hg:gable", x - t / 2, floor, z0, x + t / 2, op[2], z1, { surf: "wood", vis: false, col: true }));
        if (topY > op[3] + 0.02) out.push(bx("hg:gable", x - t / 2, op[3], z0, x + t / 2, topY, z1, { surf: "wood", vis: false, col: true }));
      } else out.push(bx("hg:gable", x - t / 2, floor, z0, x + t / 2, topY, z1, { surf: "wood", vis: false, col: true }));
    }
  };
  gable(hl - t / 2, [[-HGR.doorW / 2, HGR.doorW / 2, floor, floor + HGR.doorH]]);
  gable(-hl + t / 2, [[HGR_BACKDOOR.z - HGR_BACKDOOR.w / 2, HGR_BACKDOOR.z + HGR_BACKDOOR.w / 2, floor, floor + HGR_BACKDOOR.h], ...HGR_BACKWIN.map(([z0, z1, y0, y1]) => [z0, z1, y0, y1] as [number, number, number, number])]);
  // barrel roof: 14 pitched slabs (walkable)
  const n = 14, R = HGR_R, zEdge = hw + HGR.over;
  for (let i = 0; i < n; i++) {
    const z0 = -zEdge + (2 * zEdge * i) / n, z1 = -zEdge + (2 * zEdge * (i + 1)) / n;
    const y0 = hgrArch(z0), y1 = hgrArch(z1), zm = (z0 + z1) / 2, len = dmath.hypot(z1 - z0, y1 - y0), pitch = dmath.atan2(y0 - y1, z1 - z0);
    const th = 0.25, nx = dmath.sin(pitch), ny = dmath.cos(pitch);
    void nx; void ny; void R;
    out.push({ k: "hg:roof", c: [0, (y0 + y1) / 2 - th / 2, zm], h: [hl + 0.5, th / 2, len / 2 + 0.03], pitch, surf: "metal", col: true });
  }
  // mezzanine at the rear + its stair along the -z wall + guard rail. Deck at 3.0 m: at 3.9 the outer 3 m under the
  // barrel roof had < 1.9 m headroom (embeds, 3P camera in the roof); at 3.0 every standable spot up
  // to the wall has ≥ 1.95 m under the roof's stepped collider, and 2.55 m stays clear under the deck
  const my = HGR.mezz.y, mx = HGR.mezz.x1;
  out.push(bx("hg:mezz", -hl + t, my - 0.3, -hw + t, mx, my, hw - t, { surf: "wood" }));
  const nS = HGR_STAIR.n, run = HGR_STAIR.len / nS, sz = -hw + t + 0.72;
  out.push(...stairs("hg:step", mx + HGR_STAIR.len, sz, floor, -Math.PI / 2, 1.4, (my - floor) / nS, run, nS, { surf: "wood" }));
  out.push(railCol(mx, sz + 0.78, my, mx, hw - t, my, 1.05));
  out.push(railCol(mx + HGR_STAIR.len, sz + 0.73, floor, mx, sz + 0.73, my, 1.0));
  for (const z of [-5, 0, 5]) out.push(bx("hg:post", mx - 0.4, floor, z - 0.12, mx - 0.16, my - 0.3, z + 0.12, { surf: "metal", col: true }));
  // ---- workshop dressing that is COVER: every piece here has a mesh
  // of the same size in client/src/world/pois/peel-strip/hangar.ts. Tall pieces (shelving, crate stacks) come with a
  // walk-up (a low crate / step ≤ 0.55 m) or have tops too small to stand on
  for (const [x0, z0, x1, z1, h, k, y0 = floor] of HGR_COVER) out.push(bx(k, x0, y0, z0, x1, y0 + h, z1, { col: true, surf: k === "hg:shelf" || k === "hg:engine" || k === "hg:chest" || k === "hg:rack" || k === "hg:cab" ? "metal" : "wood" }));
  // the plane (fuselage + wing + tail colliders)
  const P = PLANE_AT;
  // fitted to what client/src/world/pois/_kit/
  // coast-vehicles.ts bananaPlane draws (10° nose-up, body origin 1.25 m over the floor): the fuselage in four sections
  // following the pitch (the cowl and the canopy were above the old 2.25 m box), each wing in two spans following its
  // dihedral (the old wing box sat at 0.8-1.2 m, under most of the drawn wing: bullets went through it), the wheel spats
  const fl = HGR.floor, pb = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): Piece => ({ k: "plane", c: [P.x + (x0 + x1) / 2, fl + (y0 + y1) / 2, P.z + (z0 + z1) / 2], h: [(x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2], col: true, surf: "metal" });
  out.push(pb(1.58, 3.75, 0.95, 2.4, -0.7, 0.7), pb(-0.6, 1.58, 0.57, 2.37, -0.66, 0.66), pb(-2.8, -0.6, 0.45, 1.55, -0.56, 0.56), pb(-4.5, -2.8, 0.35, 1.05, -0.36, 0.36));
  for (const sd of [1, -1]) {
    const z = (a: number, b: number): [number, number] => sd > 0 ? [a, b] : [-b, -a];
    out.push(pb(0.2, 2.06, 0.78, 1.47, ...z(0.45, 3.1)), pb(0.3, 1.9, 1.0, 1.63, ...z(3.1, 5.8)), pb(1.15, 2.1, 0, 0.8, ...z(1.2, 1.64)));
  }
  // tail: the stabiliser + the fin as drawn (a single 1 × 1.8 × 3.6 block is mostly air)
  out.push({ k: "plane", c: [P.x - 4.06, HGR.floor + 0.68, P.z], h: [0.5, 0.1, 1.8], col: true, surf: "metal" });
  out.push({ k: "plane", c: [P.x - 4.0, HGR.floor + 1.4, P.z], h: [0.62, 0.7, 0.1], col: true, surf: "metal" });
  // yellow mobile airstair against the fuselage's aft cabin door: the fuselage back (2.1 m, under the hangar
  // roof) would be a jump-only perch — this makes it a walk-up vantage point over the door, and cover on the apron
  {
    const A = PLANE_STAIR, rise = (A.top - floor) / A.n;
    // solid stepped body (the airstair's side panels close it down to the chassis) = visual AND collider
    out.push(...stairs("ps:airstair", A.x, A.z0, floor, 0, A.w, rise, (A.z1 - A.z0) / A.n, A.n, { surf: "metal", base: floor, ramp: false }));
    for (const s of [-1, 1]) out.push(nr(railCol(A.x + s * (A.w / 2 - 0.04), A.z0, floor + rise, A.x + s * (A.w / 2 - 0.04), A.z1, A.top, 1.0)));
  }
  // sliding door leaves, parked open outside the gable
  // telescoping door leaves (2 per side) parked stacked in front of the gable wall beside the opening
  out.push(bx("hg:leaf", hl + 0.05, floor, -hw + 0.05, hl + 0.6, floor + HGR.doorH + 0.2, -HGR.doorW / 2 - 0.05, { surf: "metal" }));
  out.push(bx("hg:leaf", hl + 0.05, floor, HGR.doorW / 2 + 0.05, hl + 0.6, floor + HGR.doorH + 0.2, hw - 0.05, { surf: "metal" }));
  // lean-to shed (enterable): floor, walls (door + windows), roof slopes (ridge along z)
  const s = SHED, st = 0.25;
  out.push(bx("sh:floor", s.x0, -0.3, s.z0, s.x1, 0.2, s.z1, { surf: "wood" }));
  out.push(...wall("sh:wall", s.x0, s.z1 - st / 2, s.x1, s.z1 - st / 2, 0.2, s.eave - 0.2, st, [{ u: s.doorX - s.x0, w: 1.3, y0: 0, h: 2.3 }, { u: s.winX - s.x0, w: 1.2, y0: 0.9, h: 1.0 }], { surf: "wood" }));
  out.push(...wall("sh:wall", s.x1 - st / 2, s.z1, s.x1 - st / 2, s.z0, 0.2, s.eave - 0.2, st, [{ u: 2.4, w: 1.2, y0: 0.9, h: 1.0 }], { surf: "wood" }));
  out.push(...wall("sh:wall", s.x0 + st / 2, s.z0, s.x0 + st / 2, s.z1, 0.2, s.eave - 0.2, st, [], { surf: "wood" }));
  out.push(...panes("sh:pane", s.x0, s.z1 - st / 2, s.x1, s.z1 - st / 2, 0.2, [{ u: s.winX - s.x0, w: 1.2, y0: 0.9, h: 1.0 }]), ...panes("sh:pane", s.x1 - st / 2, s.z1, s.x1 - st / 2, s.z0, 0.2, [{ u: 2.4, w: 1.2, y0: 0.9, h: 1.0 }]));
  const half = (s.x1 - s.x0) / 2, pitch = dmath.atan2(s.rise, half + 0.4), slen = dmath.hypot(half + 0.4, s.rise) + 0.1;
  for (const sg of [-1, 1]) {
    const cx = (s.x0 + s.x1) / 2 + sg * (half + 0.4) / 2;
    out.push({ k: "sh:roof", c: [cx, s.eave + s.rise / 2 + 0.1, (s.z0 + s.z1) / 2 + 0.2], h: [(s.z1 - s.z0) / 2 + 0.45, 0.08, slen / 2], yaw: Math.PI / 2 * sg, pitch, surf: "metal", col: true });
  }
  // the shed's open door leaf (drawn hinged at doorX + 0.65, swung 2.0 rad outward) — its collider
  { const hx0 = s.doorX + 0.65, hz0 = s.z1 - 0.12 + 0.15, a = 2.0, cx2 = hx0 - dmath.cos(a) * 0.625, cz2 = hz0 + dmath.sin(a) * 0.625;
    out.push({ k: "sh:leaf", c: [cx2, 0.2 + 1.13, cz2], h: [0.625, 1.125, 0.04], yaw: a, col: true, surf: "wood" }); }
  // fuel drum cluster at the front corner by the mural + inside the door
  out.push(bx("drums", 8.0, 0, hw + 0.4, 11.0, 1.0, hw + 1.6, { col: true, surf: "metal" }));
  out.push(bx("drums", 10.6, 0, -hw + 0.6, 12.4, 1.0, -hw + 2.4, { col: true, surf: "metal" }));
  return out;
}
export const HGR_LOCAL: Piece[] = hangar();

// ------------------------------------------------------------------------------------------------ yard, far end
/** the wreck is drawn 1.5× (at 1× it reads as a speck from the deck) */
export const CRASH_SCALE = 1.5;
/** crashed transport at the far end (world x, z, yaw) */
export const CRASH: [number, number, number] = (() => { const p = sw(RWY.len + 20, -4); return [p[0], p[2], STRIP.yaw + 0.55]; })();
/** boulders around the crash & the far end: strip-local [x, z, radius, seed] */
export const BOULDERS: Array<[number, number, number, number]> = [
  [RWY.len + 4, -26, 4.2, 11], [RWY.len + 32, -28, 5.6, 12], [RWY.len + 44, 8, 3.4, 13], [RWY.len + 24, 22, 4.8, 14], [RWY.len - 2, 22, 2.6, 15],
  [RWY.len + 40, -34, 6.5, 16], [RWY.len - 18, -24, 2.2, 17], [RWY.len + 10, 28, 3.2, 18], [RWY.len + 46, 20, 4.0, 19],
];
/** windsock lattice mast behind the hangar (strip-local) */
export const WINDSOCK: [number, number] = [74, -58];
/** runway edge light bollards every 15 m (strip-local x) */
export const BOLLARD_X: number[] = Array.from({ length: Math.floor(RWY.len / 15) + 1 }, (_, i) => i * 15);
/** paver walkway polyline (strip-local) from the tower door to the hangar's mural corner */
export const WALKWAY: Array<[number, number]> = [[4.8, -29.8], [11, -27.6], [18, -26.2], [26, -26.2], [30.5, -26.8]];
/** taxiway apron in HANGAR-local coords (door → runway) */
export const TAXI = { x0: 12.9, x1: 24, z0: -7.2, z1: 7.2 };
/** concrete apron slabs at the threshold end (strip-local rect) */
export const APRON = { x0: -21, x1: 0, z0: -11.5, z1: 12 };

/** the crashed transport's parts (crash-local, UNscaled — × CRASH_SCALE in the world; y from the crash pad, +x = the
 *  nose). Every box is a drawn part: fuselage sections (rounded-square hull filling the box), the stepped cockpit nose,
 *  the torn-off rear with its sloped cargo-ramp underside, the high tailplane + twin fins, the two broken wings lying on
 *  the ground (one with its engine nacelle), spilled cargo crates. */
export interface CrashPart { k: string; c: V3; h: V3; yaw: number }
export function crashParts(): CrashPart[] {
  const out: CrashPart[] = [];
  const grp = (gx: number, gz: number, gyaw: number, parts: Array<[string, number, number, number, number, number, number, number?]>) => {
    const c = dmath.cos(gyaw), s = dmath.sin(gyaw);
    for (const [k, x, y, z, hx, hy, hz, yaw = 0] of parts) out.push({ k, c: [gx + x * c + z * s, y, gz - x * s + z * c], h: [hx, hy, hz], yaw: gyaw + yaw });
  };
  // front fuselage + cockpit (lying on its belly, sunk 0.2 m, torn open at its −x end)
  grp(0, 0, 0.06, [
    ["cr:fusF", 2.8, 1.0, 0, 3.2, 1.2, 1.25],
    ["cr:nose1", 6.4, 0.825, 0, 0.4, 1.025, 1.15],
    ["cr:nose2", 7.15, 0.6, 0, 0.35, 0.8, 0.95],
  ]);
  // the rear fuselage, torn off and slewed round: open break toward the front section, cargo-ramp underside, tailplane,
  // twin fins
  grp(-2.9, 1.7, 0.42, [
    ["cr:fusR", -2.4, 1.0, 0, 2.2, 1.2, 1.25],
    ["cr:ramp1", -5.05, 1.175, 0, 0.45, 1.025, 1.2],
    ["cr:ramp2", -5.95, 1.4, 0, 0.45, 0.8, 1.1],
    ["cr:stab", -6.2, 2.29, 0, 0.75, 0.09, 2.85],
    ["cr:fin", -6.3, 3.39, 2.72, 0.7, 1.01, 0.08],
    ["cr:fin", -6.3, 3.39, -2.72, 0.7, 1.01, 0.08],
  ]);
  // the right wing broke off at the root and lies flat beside the cabin (engine nacelle still on it)
  grp(2.9, -5.5, 0.1, [
    ["cr:wing", 0, 0.2, 0, 0.95, 0.2, 4.0],
    ["cr:nac", 0.55, 0.64, 1.6, 1.25, 0.44, 0.42],
  ]);
  // the left wing, snapped, lying on the other side
  grp(0.6, 6.4, 1.2, [["cr:wing", 0, 0.2, 0, 0.95, 0.2, 3.5]]);
  // spilled cargo by the break (BANANA CO. crates)
  grp(-1.2, 3.6, 0.5, [["cr:crate", 0, 0.4, 0, 0.6, 0.4, 0.4], ["cr:crate", 1.4, 0.4, 0.7, 0.6, 0.4, 0.4, 0.7], ["cr:crate", -0.3, 0.4, 1.5, 0.6, 0.4, 0.4, 1.9]]);
  return out;
}
/** the two fuselage sections are HOLLOW: floor, roof, side walls and a bulkhead at the closed end — you walk in
 *  through the torn break (a looted cabin, a fight inside the wreck). The front section is open at its −x end (the
 *  break), the rear section at its +x end. */
const HOLLOW = new Set(["cr:fusF", "cr:fusR"]);
export const CRASH_SHELL = { floor: 0.3, wall: 0.15, roof: 0.15 };
/** a hollow section's collider shell in the crash frame (SCALED) */
export function crashShell(q: CrashPart): Piece[] {
  const K = CRASH_SCALE, [cx, cy, cz] = q.c.map((v) => v * K), [hx, hy, hz] = q.h.map((v) => v * K), c = dmath.cos(q.yaw), s = dmath.sin(q.yaw);
  const { floor: fl, wall: wt, roof: rt } = CRASH_SHELL, closed = q.k === "cr:fusF" ? 1 : -1;
  const P = (dx: number, dy: number, dz: number, ex: number, ey: number, ez: number, k = q.k): Piece => ({ k, c: [cx + dx * c + dz * s, cy + dy, cz - dx * s + dz * c], h: [ex, ey, ez], yaw: q.yaw, col: true, surf: "metal" });
  return [P(0, -hy + fl / 2, 0, hx, fl / 2, hz), P(0, hy - rt / 2, 0, hx, rt / 2, hz), P(0, 0, hz - wt / 2, hx, hy, wt / 2), P(0, 0, -hz + wt / 2, hx, hy, wt / 2),
    P(closed * (hx - wt / 2), 0, 0, wt / 2, hy, hz - wt)];
}

function spotter(): Piece[] {
  const o = SPOT, out: Piece[] = [], h = o.half;
  out.push(bx("sp:deck", o.x - h, o.y - 0.3, o.z - h, o.x + h, o.y, o.z + h, { surf: "wood" }));
  for (const [px, pz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) out.push(bx("sp:post", o.x + px * (h - 0.25) - 0.18, 0, o.z + pz * (h - 0.25) - 0.18, o.x + px * (h - 0.25) + 0.18, o.y - 0.3, o.z + pz * (h - 0.25) + 0.18, { surf: "wood", col: true }));
  const run = 0.5, rise = o.y / o.stairN, L = run * o.stairN;
  out.push(...stairs("sp:step", o.x - h - L, o.stairZ, 0, Math.PI / 2, o.stairW, rise, run, o.stairN, { surf: "wood" }));
  // deck railing (open at the stair head) + stair rails
  out.push(railCol(o.x - h, o.z + h, o.y, o.x + h, o.z + h, o.y, 1.05), railCol(o.x + h, o.z - h, o.y, o.x + h, o.z + h, o.y, 1.05), railCol(o.x - h, o.z - h, o.y, o.x + h, o.z - h, o.y, 1.05));
  out.push(railCol(o.x - h, o.z - h, o.y, o.x - h, o.stairZ - o.stairW / 2, o.y, 1.05));
  for (const dz of [-o.stairW / 2, o.stairW / 2]) out.push(railCol(o.x - h - L, o.stairZ + dz, 0, o.x - h, o.stairZ + dz, o.y, 1.0));
  return out;
}

function yard(): Piece[] {
  const out: Piece[] = [];
  // the crash is a BOXY high-wing utility transport (square fuselage) — every part is drawn by the client
  // to fill exactly its box (peel-strip/crash.ts), so collider ≡ visual by construction
  const cf = F(CRASH[0], PAD.y, CRASH[1], CRASH[2]), K = CRASH_SCALE;
  const sc = (p: Piece): Piece => ({ ...p, c: [p.c[0] * K, p.c[1] * K, p.c[2] * K], h: [p.h[0] * K, p.h[1] * K, p.h[2] * K] });
  out.push(...place(cf, crashParts().flatMap((q) => HOLLOW.has(q.k) ? crashShell(q) : [sc({ k: q.k, c: q.c, h: q.h, yaw: q.yaw, col: true, surf: q.k === "cr:crate" ? "wood" : "metal" })])));
  // the box sits INSIDE the drawn rock (field.ts: an ellipsoid r × 0.72r × 0.85r, sunk 0.18r, turned by its seed)
  // and follows its yaw (a box above the dome or off its yaw is an invisible wall + floor on every boulder)
  for (const [x, z, r, seed] of BOULDERS) {
    const p = sw(x, z), y0 = PAD.y - 0.1, y1 = PAD.y + r * 0.25, y2 = PAD.y + r * 0.46;   // two courses follow the dome
    out.push({ k: "boulder", c: [p[0], (y0 + y1) / 2, p[2]], h: [r * 0.7, (y1 - y0) / 2, r * 0.58], yaw: seed, col: true, surf: "stone" });
    out.push({ k: "boulder", c: [p[0], (y1 + y2) / 2, p[2]], h: [r * 0.46, (y2 - y1) / 2, r * 0.38], yaw: seed, col: true, surf: "stone" });
  }
  // lawn props (client field.ts): drum cluster + tyres by the walkway, crate stack + pallet near the tower
  out.push(...place(STRIP, [bx("drums", 12.1, 0, -16.8, 15.7, 1.0, -14.7, { surf: "metal", col: true }), bx("crates", -3.3, 0, -19.3, -1.7, 1.6, -17.7, { surf: "wood", col: true })]));
  { const p = sw(WINDSOCK[0], WINDSOCK[1]); out.push({ k: "wsmast", c: [p[0], PAD.y + 5, p[2]], h: [0.14, 5, 0.14], col: true, noShoot: true, surf: "metal" }); } // (a core inside the open lattice)
  return out;
}

/** spotter platform pieces in STRIP-local coords (the client builds them in the strip frame) */
// ------------------------------------------------------------------------------------------------ terminal
/**
 * The strip's little terminal: a two-storey concrete block with
 * a flat walkable roof behind a parapet, beyond the hangar on the runway's left side. Terminal-local frame: origin =
 * ground centre, +Z = front (toward the runway), +X = along the runway. Ground floor 0.3 (check-in hall: counters,
 * baggage belt, seat rows, vending machine; front doors + big windows, back door, baggage door on the right end),
 * solid stair along the back wall to the first floor 3.8 (flight office + lounge), second flight on to the roof 7.2
 * through an open stairwell.
 */
export const TERM = {
  frame: sub(STRIP, F(88, 0, -38, 0)),
  hx: 9, hz: 6, t: 0.3, f0: 0.3, f1: 3.8, roof: 7.2, parapet: 1.0,
  // stair 1 starts by the front door: it runs along the LEFT wall from 3 m inside the
  // front (its foot left of the door, in view as you walk in) up toward the back, and arrives on the first floor's
  // back-left landing. x0..x1 = the flight's width, zFoot → zTop its run (−Z).
  stair1: { x0: -8.55, x1: -7.15, zFoot: 3.0, zTop: -1.5, n: 16 },
  stair2: { x0: -2.4, x1: 2.1, z0: -5.55, z1: -4.25, n: 16 },
  /** the first floor's open well over the whole of stair 1 (double height: the flight and where it arrives are in view
   *  from the hall), wider than the flight; a balustrade round its edges upstairs */
  well: { x0: -8.7, x1: -5.6, z0: -1.5, z1: 3.4 },
};
/** a deep entrance canopy on four posts, a steel
 *  fire stair the length of the back wall straight to the roof (an outside route + a height level), and a rooftop
 *  PEEL STRIP sign board on the front parapet (cover on the roof, the landmark from the runway) */
export const TERM_CANOPY = { x0: -4.8, x1: 4.8, z1: 6 + 4.0, y0: 3.0, y1: 3.28, posts: [-4.45, -1.6, 1.6, 4.45] };
export const TERM_BACKSTAIR = { x0: -8.6, w: 1.3, n: 33, run: 0.48, gap0: 7.2, gap1: 8.7 };
export const TERM_SIGN = { x0: -5.4, x1: 5.4, y0: 1.0, y1: 2.55, t: 0.14 };
/** door-leaf swing (three.js yaw about the hinge) — client dress.ts draws the leaves with the same value */
export const TERM_SWING = -1.25;
export const TERM_OPEN = {
  front0: [{ u: 3, w: 3.2, y0: 0.9, h: 1.9 }, { u: 9, w: 2.4, y0: 0, h: 2.6 }, { u: 15, w: 3.2, y0: 0.9, h: 1.9 }],
  back0: [{ u: 4, w: 1.4, y0: 0, h: 2.4 }, { u: 12, w: 2.0, y0: 1.0, h: 1.4 }],
  right0: [{ u: 6, w: 1.8, y0: 0, h: 2.5 }],
  // the left wall's window sits behind the stair's top (stair 1 runs along this wall)
  left0: [{ u: 1.8, w: 2.0, y0: 0.9, h: 1.6 }],
  front1: [{ u: 2.5, w: 3.0, y0: 0.8, h: 1.8 }, { u: 9, w: 3.4, y0: 0.8, h: 1.8 }, { u: 15.5, w: 3.0, y0: 0.8, h: 1.8 }],
  back1: [{ u: 6, w: 1.6, y0: 1.0, h: 1.3 }, { u: 13, w: 1.6, y0: 1.0, h: 1.3 }],
  right1: [{ u: 4, w: 1.8, y0: 0.9, h: 1.5 }],
  left1: [{ u: 8, w: 1.8, y0: 0.9, h: 1.5 }],
};
/** terminal furniture + roof kit (terminal-local): [x0, z0, x1, z1, height, kind, base y] */
export const TERM_FURN: Array<[number, number, number, number, number, string, number]> = [
  // (the check-in hall + the flight office are furnished by the shared interiors kit — INTERIOR_ROOMS)
  // roof: AC units + a water tank (cover), all walk-up by jumping (open sky); the first AC stands clear of stair 2's head
  [3.6, -2.0, 5.4, -0.6, 1.3, "tm:ac", 7.2], [5.6, 1.4, 7.4, 2.8, 1.3, "tm:ac", 7.2], [-7.6, 1.2, -5.8, 3.0, 1.6, "tm:tank", 7.2],
];

function terminal(): Piece[] {
  const T = TERM, { hx, hz, t, f0, f1 } = T, out: Piece[] = [], o = (a: Array<{ u: number; w: number; y0: number; h: number }>, dy = 0) => a.map((q) => ({ ...q, y0: q.y0 + dy }));
  const S1 = T.stair1, S2 = T.stair2, rt = T.roof;
  out.push(bx("tm:slab", -hx - 0.3, -0.4, -hz - 0.3, hx + 0.3, f0, hz + 0.3, { surf: "concrete" }));
  const walls = (y0: number, h: number, fr: typeof TERM_OPEN.front0, bk: typeof TERM_OPEN.back0, rgt: typeof TERM_OPEN.right0, lft: typeof TERM_OPEN.left0, dy: number) => {
    out.push(...wall("tm:wall", -hx, hz - t / 2, hx, hz - t / 2, y0, h, t, o(fr, dy), { surf: "concrete" }));
    out.push(...wall("tm:wall", hx, -hz + t / 2, -hx, -hz + t / 2, y0, h, t, o(bk, dy), { surf: "concrete" }));
    out.push(...wall("tm:wall", hx - t / 2, hz - t, hx - t / 2, -hz + t, y0, h, t, o(rgt, dy), { surf: "concrete" }));
    out.push(...wall("tm:wall", -hx + t / 2, -hz + t, -hx + t / 2, hz - t, y0, h, t, o(lft, dy), { surf: "concrete" }));
    // a breakable pane in every window (dress.ts glazes them 2 cm
    // off the wall's centre line) — the check-in hall's 3.2 m picture windows and the office band shatter
    out.push(...panes("tm:pane", -hx, hz - t / 2, hx, hz - t / 2, y0, o(fr, dy), 0.02), ...panes("tm:pane", hx, -hz + t / 2, -hx, -hz + t / 2, y0, o(bk, dy), 0.02));
    out.push(...panes("tm:pane", hx - t / 2, hz - t, hx - t / 2, -hz + t, y0, o(rgt, dy), 0.02), ...panes("tm:pane", -hx + t / 2, -hz + t, -hx + t / 2, hz - t, y0, o(lft, dy), 0.02));
  };
  walls(f0, f1 - 0.3 - f0, TERM_OPEN.front0, TERM_OPEN.back0, TERM_OPEN.right0, TERM_OPEN.left0, 0);
  // the open (outward-swung) door leaves the client draws get their colliders
  out.push(...doorLeaves("tm:leaf", -hx, hz - t / 2, hx, hz - t / 2, f0, TERM_OPEN.front0, t, TERM_SWING, { surf: "metal" }));
  out.push(...doorLeaves("tm:leaf", hx, -hz + t / 2, -hx, -hz + t / 2, f0, TERM_OPEN.back0, t, TERM_SWING, { surf: "metal" }));
  out.push(...doorLeaves("tm:leaf", hx - t / 2, hz - t, hx - t / 2, -hz + t, f0, TERM_OPEN.right0, t, TERM_SWING, { surf: "metal" }));
  out.push(...doorLeaves("tm:leaf", -hx + t / 2, -hz + t, -hx + t / 2, hz - t, f0, TERM_OPEN.left0, t, TERM_SWING, { surf: "metal" }));
  walls(f1 - 0.3, rt - 0.3 - (f1 - 0.3), TERM_OPEN.front1, TERM_OPEN.back1, TERM_OPEN.right1, TERM_OPEN.left1, 0.3);
  // first floor slab round the well over stair 1 (+ its balustrade); roof slab, stairwell hole over stair 2 (+ rails)
  const slab = (k: string, y: number, x0: number, z0: number, x1: number, z1: number) => out.push(bx(k, x0, y - 0.3, z0, x1, y, z1, { surf: "concrete" }));
  const W1 = T.well, ix = hx - t, iz = hz - t;
  slab("tm:floor1", f1, -ix, -iz, W1.x1, W1.z0); slab("tm:floor1", f1, -ix, W1.z1, W1.x1, iz); slab("tm:floor1", f1, W1.x1, -iz, ix, iz);
  // the well's balustrade: its hall-side edge, its front edge, and the back edge beside the flight's arrival
  out.push(nr(railCol(W1.x1 + 0.05, W1.z0 - 0.05, f1, W1.x1 + 0.05, W1.z1 + 0.05, f1, 1.0)), nr(railCol(-ix, W1.z1 + 0.05, f1, W1.x1 + 0.05, W1.z1 + 0.05, f1, 1.0)),
    nr(railCol(S1.x1 + 0.05, W1.z0 - 0.05, f1, W1.x1 + 0.05, W1.z0 - 0.05, f1, 1.0)));
  // the flight's open side: a guard rail up its length (bullets pass)
  out.push(nr(railCol(S1.x1 + 0.05, S1.zFoot - 0.3, f0, S1.x1 + 0.05, S1.zTop, f1, 1.0)));
  slab("tm:roofslab", rt, -hx, S2.z1 + 0.15, hx, hz); slab("tm:roofslab", rt, S2.x1, -hz, hx, S2.z1 + 0.15); slab("tm:roofslab", rt, -hx, -hz, S2.x0 - 0.2, S2.z1 + 0.15);
  out.push(nr(railCol(S2.x0 - 0.2, S2.z1 + 0.1, rt, S2.x1, S2.z1 + 0.1, rt, 1.0)), nr(railCol(S2.x0 - 0.15, -hz + 0.2, rt, S2.x0 - 0.15, S2.z1 + 0.1, rt, 1.0)));
  // stairs (solid — storage under the first, the first-floor corridor wall under the second)
  out.push(...stairs("tm:step", (S1.x0 + S1.x1) / 2, S1.zFoot, f0, Math.PI, S1.x1 - S1.x0, (f1 - f0) / S1.n, (S1.zFoot - S1.zTop) / S1.n, S1.n, { surf: "concrete", ramp: false }));
  out.push(...stairs("tm:step", S2.x0, (S2.z0 + S2.z1) / 2, f1, Math.PI / 2, S2.z1 - S2.z0, (rt - f1) / S2.n, (S2.x1 - S2.x0) / S2.n, S2.n, { surf: "concrete", ramp: false }));
  // roof parapet (solid: cover all round) with the PEEL STRIP letters on the front
  out.push(bx("tm:parapet", -hx, rt, hz - 0.3, hx, rt + T.parapet, hz, { surf: "concrete" }));
  // back parapet: open over the fire stair's top landing
  out.push(bx("tm:parapet", -hx, rt, -hz, TERM_BACKSTAIR.gap0, rt + T.parapet, -hz + 0.3, { surf: "concrete" }), bx("tm:parapet", TERM_BACKSTAIR.gap1, rt, -hz, hx, rt + T.parapet, -hz + 0.3, { surf: "concrete" }));
  // the rooftop sign board standing on the front parapet
  out.push(bx("tm:sign", TERM_SIGN.x0, rt + TERM_SIGN.y0, hz - 0.22 - TERM_SIGN.t / 2, TERM_SIGN.x1, rt + TERM_SIGN.y1, hz - 0.22 + TERM_SIGN.t / 2, { surf: "metal" }));
  out.push(bx("tm:parapet", -hx, rt, -hz + 0.3, -hx + 0.3, rt + T.parapet, hz - 0.3, { surf: "concrete" }), bx("tm:parapet", hx - 0.3, rt, -hz + 0.3, hx, rt + T.parapet, hz - 0.3, { surf: "concrete" }));
  // front canopy over the doors (4 m deep, on four posts)
  const CN = TERM_CANOPY;
  out.push(bx("tm:canopy", CN.x0, CN.y0, hz, CN.x1, CN.y1, CN.z1, { surf: "concrete" }));
  for (const x of CN.posts) out.push(bx("tm:post", x - 0.13, 0, CN.z1 - 0.45, x + 0.13, CN.y0, CN.z1 - 0.19, { surf: "metal", col: true }));
  // the back fire stair: one straight steel flight outside the back wall from the ground to the roof, a top landing
  // reaching the roof through a gap in the back parapet, outer rail
  {
    const B = TERM_BACKSTAIR, zc = -hz - 0.1 - B.w / 2, rise = rt / B.n;
    out.push(...stairs("tm:fstep", B.x0, zc, 0, Math.PI / 2, B.w, rise, B.run, B.n, { surf: "metal" }));
    const xe = B.x0 + B.run * B.n;
    out.push(bx("tm:fland", xe, rt - 0.2, -hz - 0.1 - B.w, B.gap1, rt, -hz + 0.02, { surf: "metal" }));
    out.push(nr(railCol(B.x0, -hz - 0.1 - B.w + 0.04, 0, xe, -hz - 0.1 - B.w + 0.04, rt, 1.0)), nr(railCol(xe, -hz - 0.1 - B.w + 0.04, rt, B.gap1, -hz - 0.1 - B.w + 0.04, rt, 1.05)));
    out.push(nr(railCol(B.gap1 - 0.04, -hz - 0.1 - B.w, rt, B.gap1 - 0.04, -hz, rt, 1.05)));
  }
  for (const [x0, z0, x1, z1, h, k, y0] of TERM_FURN) out.push(bx(k, x0, y0, z0, x1, y0 + h, z1, { col: true, surf: k === "tm:ac" || k === "tm:tank" || k === "tm:vending" || k === "tm:locker" ? "metal" : "wood" }));
  return out;
}
export const TERM_LOCAL: Piece[] = terminal();

// ------------------------------------------------------------------------------------------------ airfield cover
/** The runway is a 150 m open lane, so shoot-blocking props stand every ≤ 12 m on
 *  BOTH sides of the runway (staggered 6 m), the centre 3 m kept clear for the long lane, and more on the lawns.
 *  [kind, strip-local x, z, yaw]; each kind's collider boxes are COVER_KIT (kind-local, y from the ground) and the
 *  client draws each kind at exactly those sizes (peel-strip/dress.ts). */
export type CoverKind = "sandbags" | "barrier" | "crates" | "cart" | "drums" | "bowser" | "tug" | "container" | "wreck" | "tanks" | "van" | "boulders";
export const COVER_KIT: Record<CoverKind, Array<[number, number, number, number, number, number]>> = {
  // [cx, cy, cz, hx, hy, hz]
  sandbags: [[0, 0.62, 0, 1.5, 0.62, 0.35], [-1.5, 0.62, 0.75, 0.35, 0.62, 0.45], [1.5, 0.62, 0.75, 0.35, 0.62, 0.45]],
  barrier: [[-1.55, 0.55, 0, 1.5, 0.55, 0.32], [1.55, 0.55, 0.12, 1.5, 0.55, 0.32]],
  crates: [[0, 0.85, 0, 1.3, 0.85, 0.85]],
  cart: [[0, 0.7, 0, 1.45, 0.7, 0.72]],
  drums: [[0, 0.6, 0, 0.95, 0.6, 0.95]],
  bowser: [[2.35, 1.3, 0, 0.95, 1.3, 1.2], [-1.05, 1.35, 0, 2.45, 1.05, 1.15], [-1.05, 0.28, 0, 2.45, 0.28, 1.0]],
  tug: [[0, 0.75, 0, 1.6, 0.75, 0.95]],
  container: [[0, 1.3, 0, 3.05, 1.3, 1.22]],
  wreck: [[0, 0.95, 0, 2.9, 0.95, 0.75], [0.7, 0.35, 0, 0.8, 0.35, 4.2]],
  tanks: [[0, 1.05, 0, 2.6, 1.05, 1.1]],
  // a cab-over box van (chassis between the wheels, cargo box,
  // cab) and a cluster of three faceted boulders (one stacked) — each drawn to fill exactly these boxes
  van: [[0, 0.3, 0, 2.2, 0.3, 0.9], [-0.85, 1.45, 0, 1.75, 0.85, 1.05], [1.75, 1.3, 0, 0.85, 0.7, 1.0]],
  boulders: [[-1.0, 0.75, 0, 1.3, 0.75, 1.0], [1.15, 0.55, 0.25, 0.95, 0.55, 0.85], [-0.75, 1.75, 0.05, 0.75, 0.25, 0.6]],
};
/** the firing range (gameplay's shared/sim/range.ts) shoots DOWN the runway from strip x = −58: its targets fan out
 *  to |z| = 2 + 0.025·d. Runway cover stays outside that cone (+1.2 m for the shooter and the target capsule) */
export const rangeCone = (x: number) => 3.2 + 0.025 * Math.max(0, x + 58);
/** inner half-depth (strip z, yaw ≈ 0) of each kind — how far it reaches toward the runway centre */
const INNER: Record<CoverKind, number> = { sandbags: 0.35, barrier: 0.44, crates: 0.85, cart: 0.72, drums: 0.95, bowser: 1.2, tug: 0.95, container: 1.22, wreck: 0.75, tanks: 1.1, van: 1.05, boulders: 1.1 };
// small pieces alternate with chunky ones (containers, vans, boulder clusters) on the same 12 m rhythm
const RIGHT: CoverKind[] = ["sandbags", "container", "barrier", "van", "boulders", "drums", "crates", "container", "sandbags", "cart", "boulders", "van", "barrier"];
const LEFT: CoverKind[] = ["barrier", "drums", "bowser", "sandbags", "container", "tug", "boulders", "van", "sandbags", "container", "barrier", "crates"];
const runwayCover = (): Array<[CoverKind, number, number, number]> => {
  const out: Array<[CoverKind, number, number, number]> = [];
  const put = (k: CoverKind, x: number, side: number) => {
    const z = side * Math.max(4.6, rangeCone(x) + INNER[k] + 0.35);
    out.push([k, x, z, k === "sandbags" ? (side > 0 ? 0 : Math.PI) : (x * 0.013) % 0.12 - 0.06]);
  };
  RIGHT.forEach((k, i) => put(k, 6 + 12 * i, 1));
  LEFT.forEach((k, i) => put(k, 12 + 12 * i, -1));
  return out;
};
export const COVER: Array<[CoverKind, number, number, number]> = [
  // runway: both sides every 12 m, staggered 6 m, outside the firing-range cone (the centre stays a long lane)
  ...runwayCover(),
  // threshold apron + overrun
  ["drums", -8, 6.8, 0], ["crates", -12, -8.5, 0.2], ["barrier", 160, -9, 1.2], ["sandbags", 158, 10, -1.4], ["wreck", 118, 17, 0.5],
  // lawns: tower ↔ hangar ↔ terminal (the spotter deck looks over them — low-ish, grouped drums + carts)
  ["drums", 20, -20, 0], ["cart", 30, -13.5, 0.3], ["tanks", 64, -20, 0.1], ["crates", 70, -30, 0.4], ["tug", 76, -14, -0.6], ["cart", 100, -24, 0.2],
  ["sandbags", -4, -40, 0.5], ["crates", 12, -46, -0.3], ["drums", 60, -48, 0], ["container", 104, -40, 1.57], ["sandbags", 118, -26, -0.4], ["drums", 124, -16, 0],
  ["crates", -26, -26, 0.3], ["barrier", -30, 20, 1.3], ["crates", 84, 18, 0], ["drums", 44, 17, 0], ["sandbags", 20, 18, 3.3],
];
function cover(): Piece[] {
  const out: Piece[] = [];
  for (const [k, x, z, yaw] of COVER) {
    const f = sub(STRIP, F(x, 0, z, yaw));
    out.push(...place(f, COVER_KIT[k].map(([cx, cy, cz, hx, hy, hz]) => ({ k: `cv:${k}`, c: [cx, cy, cz] as V3, h: [hx, hy, hz] as V3, col: true, surf: (k === "sandbags" ? "sand" : k === "crates" ? "wood" : k === "barrier" ? "concrete" : k === "boulders" ? "stone" : "metal") as Box["surf"] }))));
  }
  return out;
}

export const PIECES_SPOT: Piece[] = spotter();
export const PIECES: Piece[] = [...place(TWR.frame, TWR_LOCAL), ...place(HGR.frame, HGR_LOCAL), ...place(STRIP, PIECES_SPOT), ...yard(), ...place(TERM.frame, TERM_LOCAL), ...cover()];

// ------------------------------------------------------------------------------------------------ flora
/** strip-local keep-outs for the airfield's planted jungle (runway + shoulders, buildings + their aprons, the crash,
 *  the firing range, the spotter deck's sight lines over the lawns) */
export function floraKeep(x: number, z: number): boolean {
  // clean 14 m grass shoulders either side of the runway — the strip reads as an airfield from the air
  if (x > -30 && x < RWY.len + 10 && Math.abs(z) < RWY.half + 14) return true;
  if (x > -38 && x < 16 && z > -42 && z < 16) return true;                      // tower, apron, spotter + stair
  if (x > -6 && x < 72 && z > -50 && z < -9) return true;                      // tower → hangar lawns
  if (x > 66 && x < 110 && z > -58 && z < -9) return true;                     // terminal + its forecourt
  if (x > RWY.len - 6 && x < RWY.len + 50 && z > -34 && z < 28) return true;   // crash (1.5×) + boulders
  if (x > -90 && x < -18 && Math.abs(z) < 17) return true;                     // firing range
  if (dmath.hypot(x - WINDSOCK[0], z - WINDSOCK[1]) < 5) return true;
  if (dmath.hypot(x - 262, z - 12) < 34 || dmath.hypot(x - 250, z + 40) < 34) return true; // open meadow glades past the crash
  const hf = HGR.frame, w = toWorld(STRIP, x, 0, z), dx = w[0] - hf.x, dz = w[2] - hf.z, c = dmath.cos(hf.yaw), sn = dmath.sin(hf.yaw);
  const lx = dx * c - dz * sn, lz = dx * sn + dz * c;
  if (lx > -HGR.L / 2 - 6 && lx < TAXI.x1 + 4 && lz > -HGR.W / 2 - 6 && lz < SHED.z1 + 6) return true;
  for (const [k, cx, cz] of COVER) if (dmath.hypot(x - cx, z - cz) < (k === "container" || k === "bowser" ? 5 : 3.2)) return true;
  return false;
}
/** the airfield's jungle belt + right-hand grove: a jittered ~13 m lattice (8.5 m makes a closed canopy wall;
 *  13 m leaves sight lines between the trees, ~55 % fewer trunks) of palms / jungle trees (collidable, the
 *  veg area's trunk colliders) with bushes + banana plants between, only on the flat pad (r ≤ pad − 4) */
export const FLORA: Flora[] = (() => {
  const r = rng(4343), out: Flora[] = [], P = POIS_PAD;
  for (let gx = -95; gx <= 270; gx += 13) for (let gz = -170; gz <= 200; gz += 13) {
    const x = gx + (r() - 0.5) * 7, z = gz + (r() - 0.5) * 7, k = r(), s = 0.85 + r() * 0.35, yaw = r() * 6.283;
    const w = sw(x, z), dp = dmath.hypot(w[0] - P.x, w[2] - P.z);
    if (dp > P.pad + 6 || floraKeep(x, z)) continue;
    let kind: Flora[0] = k < 0.58 ? "palm" : k < 0.78 ? "palm-leaning" : "jungle-tree";
    // understorey between the trunks (soft, no colliders)
    const k2 = r(), a2 = r() * 6.283;
    if (k2 < 0.45 && dp < P.pad - 4 && !floraKeep(x + dmath.cos(a2) * 3, z + dmath.sin(a2) * 3)) { const u = sw(x + dmath.cos(a2) * 3, z + dmath.sin(a2) * 3); out.push([k2 < 0.2 ? "bush" : k2 < 0.33 ? "banana-plant" : "fern", u[0], PAD.y, u[2], a2, 0.9 + k2]); }
    // past the flat pad (≤ 6 m into the blend, terrain within ~0.5 m of the pad) only straight trunks: their colliders
    // stand on PAD.y and still wrap the drawn trunk at body height
    if (dp > P.pad - 4) { if (kind === "palm-leaning") kind = "palm"; else if (kind !== "palm" && kind !== "jungle-tree") continue; }
    const wx = settleFlora(kind, w[0], w[2]);
    out.push([kind, wx, PAD.y, w[2], yaw, kind === "jungle-tree" ? s * 0.9 : s]);
  }
  // the hand-placed framing palms (shared, so their trunks collide): strip-local [x, z, scale]
  const L = RWY.len, r2 = rng(4242);
  const hand: Array<[Flora[0], number, number, number]> = [
    ...([[22, 17, 1.25], [34, 22, 1.15], [48, 18, 1.3], [62, 25, 1.1], [80, 19, 1.2], [96, 26, 1.1], [112, 18, 1.25], [128, 24, 1.1], [144, 19, 1.2],
      [L + 6, 26, 1.1], [L + 22, 20, 1.2], [L + 40, 12, 1.15], [L + 36, -24, 1.1], [L + 14, -30, 1.2], [L - 8, -26, 1.05],
      [66, -62, 1.2], [80, -56, 1.1], [92, -66, 1.25], [56, -70, 1.0], [30, -62, 1.15], [18, -50, 1.1], [8, -44, 1.2], [-8, -36, 1.05],
      [104, -40, 1.1], [120, -34, 1.2], [136, -28, 1.05], [-20, -26, 1.15], [-30, -14, 1.0]] as Array<[number, number, number]>).map(([x, z, sc]) => ["palm", x, z, sc] as [Flora[0], number, number, number]),
    ...([[-9, 17.5, 1.2], [40, 28, 1.1], [70, 31, 1.0], [26, -58, 1.05], [L + 28, -36, 1.0], [-24, 12, 1.0]] as Array<[number, number, number]>).map(([x, z, sc]) => ["palm-leaning", x, z, sc] as [Flora[0], number, number, number]),
  ];
  for (const [k0, x, z, sc] of hand) {
    const w = sw(x, z), dp = dmath.hypot(w[0] - P.x, w[2] - P.z), yaw = r2() * 6.283;
    if (dp > P.pad + 6) continue;
    if (COVER.some(([, cx, cz]) => dmath.hypot(x - cx, z - cz) < 3.5)) continue;
    const kind: Flora[0] = dp > P.pad - 4 ? "palm" : k0;
    if (out.some((f) => dmath.hypot(f[1] - w[0], f[3] - w[2]) < 3)) continue;
    out.push([kind, settleFlora(kind, w[0], w[2]), PAD.y, w[2], yaw, sc]);
  }
  return out;
})();

// ------------------------------------------------------------------------------------------------ interiors
/** rooms furnished by the shared interiors kit: the terminal's check-in hall + first-floor flight office, the store
 *  under the hangar mezzanine, the lean-to workshop shed */
export const INTERIOR_ROOMS: InteriorRoom[] = (() => {
  const W = (side: 0 | 1 | 2 | 3, at: number, w: number, y0: number, h: number) => ({ side, at, w, kind: "window" as const, y0, h });
  const D = (side: 0 | 1 | 2 | 3, at: number, w: number, h = 2.4) => ({ side, at, w, kind: "door" as const, h });
  const T = TERM, S1 = T.stair1, S2 = T.stair2, W1 = T.well, ix = T.hx - T.t, iz = T.hz - T.t, H = HGR, hl = H.L / 2, hw = H.W / 2, sh = SHED;
  const mzx0 = -hl + 0.3, mzx1 = H.mezz.x1 - 0.65;
  return [
    kitRoom(T.frame, 0, T.f0, 0, {
      id: "term-hall", w: 2 * ix, d: 2 * iz, h: T.f1 - 0.3 - T.f0, style: "shop", role: "general", seed: 817, wallT: T.t,
      // (no kit ceiling — its drop ceiling would span the stairwell hole: a plane you climb through)
      finish: { glass: false, frames: false, ceiling: "none", shell: false, wall: "#ece6d8", dado: "#3f7fb0", baseboard: true },
      openings: [W(0, -6, 3.2, 0.9, 1.9), D(0, 0, 2.4, 2.6), W(0, 6, 3.2, 0.9, 1.9), D(2, 5, 1.4, 2.4), W(2, -3, 2.0, 1.0, 1.4), D(1, -0.3, 1.8, 2.5), W(3, -3.9, 2.0, 0.9, 1.6)],
      // stair 1 along the left wall: its block, the walk-up at its foot (left of the front door), and the
      // open floor beside it under the double-height well (kept clear: the flight reads from the hall)
      keepOut: [[-ix, S1.zTop - 0.1, S1.x1 + 0.1, S1.zFoot + 0.1], { r: [-ix, S1.zFoot, S1.x1 + 0.4, S1.zFoot + 1.4], walk: true }, { r: [S1.x1 + 0.1, S1.zTop, W1.x1, S1.zFoot], walk: true }],
    }),
    kitRoom(T.frame, 0, T.f1, 0, {
      id: "term-office", w: 2 * ix, d: 2 * iz, h: T.roof - 0.3 - T.f1, style: "lab", role: "office", seed: 812, wallT: T.t, density: 0.7,
      // a pale dado: from the hall the well reads as a lit opening, not a dark slot in the ceiling (+ the pendant lamp over it, client peel-strip/dress.ts)
      finish: { glass: false, frames: false, ceiling: "none", shell: false, wall: "#e9eef0", dado: "#c2d3d7", baseboard: true },
      openings: [W(0, -6.5, 3.0, 0.8, 1.8), W(0, 0, 3.4, 0.8, 1.8), W(0, 6.5, 3.0, 0.8, 1.8), W(2, 3, 1.6, 1.0, 1.3), W(2, -4, 1.6, 1.0, 1.3), W(1, 1.7, 1.8, 0.9, 1.5), W(3, 2.3, 1.8, 0.9, 1.5)],
      // the well over stair 1, stair 2 on to the roof, and the landing + lane between them (the flight arrives at the back
      // left, stair 2 starts 5 m on along the back wall)
      keepOut: [[-ix, W1.z0 - 0.05, W1.x1 + 0.15, W1.z1 + 0.15], [S2.x0 - 0.3, -iz, S2.x1 + 0.2, S2.z1 + 0.2], { r: [-ix, -iz, S2.x0, W1.z0], walk: true }],
    }),
    // the airfield ops room at the stair foot — a dock
    // office (desk + VHF radio, lockers, charts, notice board) along the right wall and front-right, under the upper
    // flights (≥ 4 m headroom there); the first flight's lane, the solid pier and the low end of flight 1 stay clear
    kitRoom(TWR.frame, 0, TWR.floor0, 0, {
      id: "tower-ops", w: 2 * IN, d: 2 * IN, h: 4.0, style: "lab", role: "dock", seed: 833, wallT: TWR.wt, openTop: true, density: 0.8,
      finish: { glass: false, frames: false, wall: null, dado: null, floor: "concrete" },
      openings: [D(0, TWR.doorX, TWR.doorW, TWR.doorH), W(3, TWR_WINDOWS[2].u - IN, TWR_WINDOWS[2].w, TWR_WINDOWS[2].y0 - TWR.floor0, TWR_WINDOWS[2].h)],
      keepOut: [{ r: [-IN, -IN, -LN + 0.1, LN + 0.9], walk: true }, { r: [-IN, -IN, -LN, -LN], solid: true }, [-LN, -IN, 0.4, -LN + 0.2],
        { r: [TWR_LEAF.x0 - 0.1, TWR_LEAF.z0 - 0.1, TWR_LEAF.x1 + 0.1, IN], solid: true }],
    }),
    kitRoom(H.frame, (mzx0 + mzx1) / 2, H.floor, 0, {
      id: "hangar-store", w: mzx1 - mzx0, d: 2 * (hw - 0.3), h: H.mezz.y - 0.3 - H.floor, style: "warehouse", role: "storage", seed: 821, wallT: 0.3, openTop: true,
      finish: { floor: "none", wall: null, dado: null, frames: false, glass: false },
      openings: [{ side: 1, at: 0, w: 2 * (hw - 0.3) - 0.2, kind: "gap" }, D(3, HGR_BACKDOOR.z, HGR_BACKDOOR.w, 2.5), D(0, -9 - (mzx0 + mzx1) / 2, 1.8, 2.5)],
    }),
    kitRoom(H.frame, (sh.x0 + sh.x1) / 2, 0.2, (sh.z0 + sh.z1 - 0.25) / 2, {
      id: "hangar-shed", w: sh.x1 - sh.x0 - 0.5, d: sh.z1 - 0.25 - sh.z0, h: sh.eave - 0.2, style: "warehouse", role: "workshop", seed: 827, wallT: 0.25, openTop: true, density: 0.35,
      finish: { wall: null, dado: null, glass: false, frames: false },
      openings: [D(0, sh.doorX - (sh.x0 + sh.x1) / 2, 1.3, 2.3), W(0, sh.winX - (sh.x0 + sh.x1) / 2, 1.2, 0.9, 1.0), W(1, 0.125, 1.2, 0.9, 1.0)],
    }),
  ];
})();

export const colliders: Box[] = lazyBoxes([...toBoxes(PIECES), ...interiorColliders(INTERIOR_ROOMS)], () => floraColliders(FLORA, vegTrunkColliders, VARIANTS));

// ------------------------------------------------------------------------------------------------ designed loot
/** LOOT_SPOTS: chests in the control-tower cab, on its roof and stair landing, in the hangar (floor, mezzanine), the
 *  shed, the terminal (check-in, office, roof), the crash fuselage and on the spotter deck; floor loot along them */
export const LOOT_SPOTS: LootSpots = (() => {
  const chests: LootSpots["chests"] = [], floor: LootSpots["floor"] = [];
  const C = (f: Frame, lx: number, ly: number, lz: number, yaw: number) => { const p = toWorld(f, lx, ly, lz); chests.push([p[0], p[1], p[2], f.yaw + yaw]); };
  const L = (f: Frame, lx: number, ly: number, lz: number) => { const p = toWorld(f, lx, ly, lz); floor.push([p[0], p[1], p[2]]); };
  const Tw = TWR.frame, Hg = HGR.frame, Tm = TERM.frame, roofTop = TWR.roof0 + TWR.roofT, hzT = TERM.hz;
  C(Tw, 2.0, TWR.cab, -1.7, -Math.PI / 2); C(Tw, 0.5, roofTop + 0.35, 1.5, 0); C(Tw, -(IN + LN) / 2, TWR.floor0 + TWR.rise, -(IN + LN) / 2, 0);
  C(Hg, -10.5, HGR.mezz.y, 0, Math.PI / 2); C(Hg, -1.0, HGR.floor, 6.5, Math.PI); 
  C(Tm, 0, TERM.roof, 3.5, Math.PI); L(Tm, 6.5, 0, -hzT - 0.8);
  C(STRIP, SPOT.x + 1.0, SPOT.y, SPOT.z - 1.0, 0);
  // the crash: a chest in the slewed rear cabin (by the bulkhead), floor loot in the front cabin
  { const cf = F(CRASH[0], PAD.y, CRASH[1], CRASH[2]); C(cf, -5.75 * CRASH_SCALE, 0, 3.6 * CRASH_SCALE, 0.42 - Math.PI / 2); L(cf, 3.6 * CRASH_SCALE, 0, 0.2); }
  L(Tw, -1.5, TWR.cab, -0.5); L(Tw, 0, TWR.floor0, 0.3); L(Tw, 2.2, TWR.cab, -4.55);
  L(Hg, 5.0, HGR.floor, -4.0); L(Hg, -3.0, HGR.floor, 6.0); L(Hg, -9.5, HGR.mezz.y, -2.0); L(Hg, -9.5, HGR.mezz.y, 3.0);
  L(Tm, -4.0, TERM.roof, -1.0);
  L(STRIP, 30, 0, -3.0); L(STRIP, 90, 0, 2.5); L(STRIP, SPOT.x - 1.0, SPOT.y, SPOT.z + 1.0);
  // runway chests tucked behind the shipping containers (outer side, ~0.9 m off the box) — loot on the long
  // lane sits where the cover is, not at random lattice points in the jungle
  for (const [k, x, z] of COVER) if (k === "container" && Math.abs(z) < 12) { const sd = Math.sign(z); C(STRIP, x, 0, z + sd * (COVER_KIT.container[0][5] + 0.9), sd > 0 ? 0 : Math.PI); }
  const spots = { chests, floor };
  addKitLoot(spots, INTERIOR_ROOMS, interiorLoot);
  settleLoot(spots, [...toBoxes(PIECES), ...interiorColliders(INTERIOR_ROOMS)]);   // clear of the colliders
  return spots;
})();

/** vegetation keep-out: runway + shoulders, tower & deck, hangar & shed & taxiway, crash site, windsock */
export const clearings: Clearing[] = (() => {
  const c: Clearing[] = [];
  // NB: the veg scatter's rect yaw turns local +X toward (cos, +sin) in XZ — the opposite sense of three's rotation.y
  const rect = (x0: number, x1: number, z0: number, z1: number) => { const p = sw((x0 + x1) / 2, (z0 + z1) / 2); c.push({ x: p[0], z: p[2], hx: (x1 - x0) / 2, hz: (z1 - z0) / 2, yaw: -STRIP.yaw }); };
  rect(-24, RWY.len + 6, -RWY.half - 2.5, RWY.half + 2.5);
  rect(-26, 10, -37, 14);                      // tower, apron, spotter platform
  rect(SPOT.x - SPOT.half - 0.5 * SPOT.stairN - 2, SPOT.x - SPOT.half, SPOT.stairZ - 1.3, SPOT.stairZ + 1.3); // spotter stair
  { const p = sw(SPOT.x, SPOT.z); c.push({ x: p[0], z: p[2], r: 12 }); } // around the spotter deck (framing plants are placed by the POI)
  // the spotter deck's sight lines: tower → hangar → runway stay open (low dressing only, placed by the POI)
  rect(0, 60, -32, -9);
  rect(86.5, 89.5, -28.5, -12.5);              // the paved terminal walk (no grass growing over the slabs)
  { const hf = HGR.frame, p = toWorld(hf, 3, 0, 1); c.push({ x: p[0], z: p[2], hx: 18, hz: 17, yaw: -hf.yaw }); } // hangar, shed, taxiway
  rect(RWY.len + 2, RWY.len + 42, -20, 14);    // crash (drawn 1.5×)
  rect(-82, -24, -13, 13);                     // firing range (shared/sim/range.ts): firing line, rack, heal pad, near lanes
  { const p = sw(WINDSOCK[0], WINDSOCK[1]); c.push({ x: p[0], z: p[2], r: 3 }); }
  // open meadow glades past the crash (terrain rocks + jungle stay out)
  for (const [sx, sz] of [[262, 12], [250, -40]]) { const p = sw(sx, sz); c.push({ x: p[0], z: p[2], r: 36 }); }
  return c;
})();
