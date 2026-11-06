// LOOKOUT POINT — shared layout + collision (client visuals AND the authoritative server derive from this file).
// A chunky red/white lighthouse on the lip of the W sea cliff (enterable: spiral stair → lantern room → gallery), an
// attached keeper's cottage (enterable), radio masts, a fenced yard, and the switchback stair down the cliff face to
// the beach. Everything that depends on the heightfield (the columnar cliff face, the stair, prop ground heights) is
// baked from island.bin into lookout-baked.json by an offline bake (re-run after a terrain re-bake; its check mode
// fails if a tread is buried). World metres; see coast-kit.ts conventions.
import { keeperMainRoof, keeperDormerPieces, keeperLayouts, keeperPartitions, keeperRooms } from "./lookout-keeper-cottage";
import type { Box } from "../world/colliders";
import baked from "./lookout-baked.json";
import { vegTrunkColliders, VARIANTS } from "../world/veg-scatter"; // only CALLED lazily (import cycle — see coast-kit lazyBoxes)
import { interiorColliders, interiorLoot, type InteriorRoom } from "./interior-kit";
import { F, addKitLoot, bx, doorLeaves, floraColliders, kitRoom, lazyBoxes, place, ringWall, rng, settleFlora, spiral, stairs, toBoxes, toWorld, wall, type Clearing, type Flora, type Frame, type LootSpots, type Piece } from "./coast-kit";
import * as dmath from "../sim/dmath";

export const PAD = { x: -590, z: 470, y: 46 };
export const BAKED = baked;
/** cliff-top level (the columns' caps = the yard) */
export const TOP = baked.top;

// ------------------------------------------------------------------------------------------------ cliff face
export interface Column { x: number; z: number; yaw: number; w: number; zin: number; zout: number; y0: number; y1: number; seed: number }
/** columnar rock prisms cladding the W sea cliff. Column-local frame F(x, 0, z, yaw): +Z = out of the face (the face
 * sits at z = zout), footprint x ∈ ±w/2, z ∈ [zin, zout], from y0 (under the beach) to the cap y1 */
export const COLUMNS: Column[] = baked.columns;
/** ground under (x,z) from the cliff caps (−∞ off the caps); the client's groundAt = max(terrain, capAt) */
export function capAt(x: number, z: number): number {
  let y = -Infinity;
  for (const c of COLUMNS) {
    const dx = x - c.x, dz = z - c.z, co = dmath.cos(c.yaw), si = dmath.sin(c.yaw);
    const lx = dx * co - dz * si, lz = dx * si + dz * co;
    if (Math.abs(lx) <= c.w / 2 && lz >= c.zin && lz <= c.zout) y = Math.max(y, c.y1);
  }
  return y;
}
/** smoothed face radius around PAD at angle (deg) */
export function faceR(deg: number): number {
  const f = baked.face as Array<[number, number]>;
  const i = Math.max(0, Math.min(f.length - 2, Math.floor(deg - f[0][0])));
  const t = Math.max(0, Math.min(1, deg - f[i][0]));
  return f[i][1] + (f[i + 1][1] - f[i][1]) * t;
}

// ------------------------------------------------------------------------------------------------ lighthouse
const [LHX, LHY, LHZ] = baked.anchors.lh;
/** outward (seaward) direction at the tower, radians in the XZ plane (position = (cos a, sin a)) */
const SEA_A = dmath.atan2(LHZ - PAD.z, LHX - PAD.x);
export const LH = {
  x: LHX, z: LHZ, y: LHY,
  plinthR: 5.0, plinthH: 2.4,
  r0: 4.55, r1: 3.8,          // body outer radius bottom → top
  /** 0.45 (not 0.7): the stair gets the 0.25 m (LH_TREAD_W) */
  wall: 0.45,
  top: LHY + 20.5,             // gallery floor (top surface)
  deckR: 5.3, deckT: 0.5,
  /** lantern room (the glazed watch room, walkable): low red wall + glazing + top ring, then the dome */
  roomR: 3.0, roomWall: 0.9, glassH: 3.4, ringH: 0.4,
  domeH: 2.6,
  /** entrance door angle (rad, position = (cos a, sin a) in XZ) — faces WSW, toward the view camera over the bay
   *  (the door + staggered window column face the camera); 40° off the sea bearing still clears the keeper's cottage
   *  porch by ~4.5 m */
  doorA: SEA_A - (40 / 180) * Math.PI,
  doorW: 1.9, doorH: 2.8,
  /** gallery door (lantern room → gallery) */
  galleryDoorA: SEA_A + (12 / 180) * Math.PI,
  // spiral
  steps: 86, stepDa: (20 / 180) * Math.PI, stepR0: 0.5,
  stairA0: SEA_A + (70 / 180) * Math.PI,
};
export const LH_RISE = (LH.top - LH.y) / LH.steps;
/** treads on solid masonry (no headroom under them) and treads under the open lantern-room hatch */
export const LH_SOLID = 10, LH_HATCH = 13;
/** outer radius of tread i (touches the inner wall face; last flight stays inside the lantern room) */
export const treadR1 = (i: number) => {
  const yy = LH.y + LH_RISE * (i + 0.5), rin = LH.r0 + (LH.r1 - LH.r0) * (yy - LH.y) / (LH.top - LH.y) - LH.wall - 0.04;
  return i >= LH.steps - 12 ? Math.min(rin, LH.roomR - 0.35) : rin;
};
/** the stair hugs the wall — treads LH_TREAD_W wide
 *  from the wall inward — and the shaft is a stack of real rooms: timber floors (octagons) at LH_FLOORS inside the
 *  spiral, each stepped onto from the stair where it passes level with it (store, oil room, watch room, lens store) */
// 1.55 m treads: the wall gives 0.25 m and the rooms 0.15 m. The body collider follows the drawn taper (lighthouse()):
// coarse bands stepping 0.15 m inward every 4.1 m catch a kong's head unless it hugs the inner rail (and the unstick
// then pushes it out THROUGH the wall).
export const LH_TREAD_W = 1.55;
export const treadR0 = (i: number) => treadR1(i) - LH_TREAD_W;
// (the first floor ≤ 4.45 m over the ground floor: the solver's enclosure flood looks 4.5 m down for the way out)
export const LH_FLOORS: number[] = [4.45, 9.0, 13.6];
/** the tread index whose top is level with a floor (relative height h) and the angle where it meets the floor */
export const lhArrival = (h: number) => { const i = Math.max(0, Math.round(h / LH_RISE) - 1); return { i, a: LH.stairA0 + LH.stepDa * (i + 0.5) }; };
/** floor octagon circumradius at relative height h: clear of every tread inner edge within head height above it */
export const lhFloorR = (h: number) => lhRadius(LH.y + h + 2.0) - LH.wall - 0.04 - LH_TREAD_W - 0.07;
/** props per floor (colliders + drawn at exactly these boxes): [floor index (-1 = ground), angle offset from the
 *  arrival point (rad), radius, width, depth, height, kind] */
export const LH_PROPS: Array<[number, number, number, number, number, number, string]> = [
  // (radii put them at the floor's rim, outside the open centre)
  // ground: the store side (away from the door at 0 and the stair foot at +110°), inside the stair's masonry (r ≤ 2.55)
  [-1, 3.4, 1.95, 1.2, 0.8, 0.85, "lh:crates"], [-1, 4.25, 1.85, 1.1, 1.1, 0.95, "lh:drums"], [-1, 5.05, 2.0, 1.0, 0.55, 0.6, "lh:chest"],
  // (0.15 m further in — the wide stair takes 0.15 m off every floor's radius)
  [0, 2.6, 1.7, 1.0, 0.85, 0.95, "lh:drums"], [0, 3.9, 1.8, 1.2, 0.42, 1.7, "lh:shelf"],
  [1, 2.7, 1.6, 1.2, 0.6, 0.78, "lh:desk"], [1, 3.9, 1.65, 1.1, 0.42, 1.7, "lh:shelf"],
  [2, 2.8, 1.4, 0.9, 0.9, 1.1, "lh:lens"], [2, 3.9, 1.5, 0.9, 0.5, 0.6, "lh:chest"],
];
export const lhRadius = (y: number) => LH.r0 + (LH.r1 - LH.r0) * Math.min(1, Math.max(0, (y - LH.y) / (LH.top - LH.y)));
/** body window positions (angle, sill height): two staggered columns (sea side + land side), one per paint band */
export const LH_WINDOWS: Array<{ a: number; y: number }> = (() => {
  const out: Array<{ a: number; y: number }> = [], bands = 7, y0 = LH.y + LH.plinthH, bh = (LH.top - y0) / bands;
  for (let i = 1; i < bands; i++) {
    const yy = y0 + i * bh + bh * 0.28, off = ((i % 2 ? 11 : -11) / 180) * Math.PI;
    out.push({ a: LH.doorA - (2 / 180) * Math.PI + off, y: yy });
    out.push({ a: LH.doorA + Math.PI - off, y: yy });
  }
  return out;
})();

function lighthouse(): Piece[] {
  const { x, z, y } = LH, out: Piece[] = [];
  const dg = LH.doorW / 2 / LH.plinthR + 0.04;
  const doorGap: [number, number] = [LH.doorA - dg, LH.doorA + dg];
  // plinth ring + tapering body bands. The plinth collider steps in at the cornice — a 0.2 m lip at 2.1 m and a
  // 0.25 m one at 2.42 m, too narrow for the capsule to stand on (a 0.45 m ledge 2.4 m up under the gallery reads
  // as a jump-only covered floor)
  out.push(...ringWall("lh:plinth", x, z, y, 2.1, LH.plinthR, 0.9, 24, [doorGap], { surf: "stone" }));
  out.push(...ringWall("lh:plinth", x, z, y + 2.1, LH.plinthH - 2.1, LH.plinthR - 0.2, 0.7, 24, [doorGap], { surf: "stone", col: true }));
  // body: ~1 m rings that stay INSIDE the drawn tapering shell — outer face at the ring's top radius, inner face at its
  // bottom radius (the drawn inner face never sits nearer the axis than the collider), so the stair's full drawn width is
  // walkable (5 × 4.1 m bands would step 0.15 m inward at every joint: a ledge at head height over the stair)
  { const dTop = LH.doorH + 0.2, cuts = [0, 1.0, 2.0, dTop], n = Math.ceil((LH.top - y - dTop) / 1.0);
    for (let k = 1; k <= n; k++) cuts.push(dTop + (LH.top - y - dTop) * k / n);
    for (let k = 0; k + 1 < cuts.length; k++) {
      const y0 = y + cuts[k], y1 = y + cuts[k + 1], rO = lhRadius(y1), rI = lhRadius(y0) - LH.wall, door = cuts[k] < dTop;
      out.push(...ringWall("lh:body", x, z, y0, y1 - y0, rO, rO - rI, 24, door ? [[LH.doorA - LH.doorW / 2 / rO - 0.05, LH.doorA + LH.doorW / 2 / rO + 0.05]] : [], { surf: "concrete" }));
    } }
  // ground floor slab (the tower may stand partly over the cliff caps) + central newel column
  out.push({ k: "lh:slab", c: [x, y - 0.6, z], h: [LH.plinthR - 0.3, 0.6, LH.plinthR - 0.3], surf: "stone", col: true });
  // (no central newel — the stair hangs on the wall and the centre holds the floors)
  // spiral treads — outer end reaches the (tapering) inner wall; the last flight stays inside the lantern room.
  // the first LH_SOLID treads stand on solid masonry down to the floor (the space under the first turn has 0.3–
  // 1.6 m of headroom: a wedge that traps kongs between the stair and the store's props)
  for (let i = 0; i < LH.steps; i++) {
    const solid = i < LH_SOLID;
    out.push(...spiral("tread:stone", x, z, y + LH_RISE * i, LH.stairA0 + LH.stepDa * i, LH.stepDa, LH_RISE, 1, treadR0(i), treadR1(i), { surf: "stone", thick: solid ? LH_RISE * (i + 1) + 0.05 : 0.28 }));
  }
  // inner guard rail on every tread (a baluster panel at the open edge, bullets pass), open where a floor meets the
  // stair (±0.55 m of its level) and over the ground room's entrance flight
  for (let i = LH_SOLID; i < LH.steps - LH_HATCH; i++) {
    const top = LH_RISE * (i + 1);
    if (LH_FLOORS.some((h) => Math.abs(top - h) < 1.05)) continue;
    const a = LH.stairA0 + LH.stepDa * (i + 0.5), r = treadR0(i) + 0.05, len = 2 * r * dmath.tan(LH.stepDa / 2) + 0.04;
    out.push({ k: "lh:rail", c: [x + dmath.cos(a) * r, y + top + 0.5, z + dmath.sin(a) * r], h: [0.03, 0.5, len / 2], yaw: -a, col: true, noShoot: true, surf: "metal" });
  }
  // the floors: two squares (0° and 45°) whose corners touch the octagon's vertices — their union is the drawn
  // octagon less 8 slivers (≤ 0.2 m), and each square is wide enough for the room scan
  for (const h of LH_FLOORS) {
    const R = lhFloorR(h), s = R * Math.SQRT1_2, ri = R * dmath.cos(Math.PI / 8), aa = R * dmath.sin(Math.PI / 8), fy = y + h, th = 0.25;
    // + four strips (0/45/90/135°): the union is then exactly the drawn octagon (no unsupported rim slivers)
    for (const yaw of [0, Math.PI / 4]) out.push({ k: "lh:floorW", c: [x, fy - th / 2, z], h: [s, th / 2, s], yaw, col: true, surf: "wood" });
    for (let k = 0; k < 4; k++) out.push({ k: "lh:floorW", c: [x, fy - th / 2, z], h: [ri, th / 2, aa], yaw: (k * Math.PI) / 4, col: true, surf: "wood" });
  }
  // the cast-iron column that carries the floors (ground → the lantern floor; drawn Ø 0.44, the box inside it)
  out.push({ k: "lh:column", c: [x, (y + LH.top - 0.25) / 2, z], h: [0.17, (LH.top - 0.25 - y) / 2, 0.17], col: true, surf: "metal" });
  // props (drawn at exactly these boxes by lookout-point/index.ts)
  for (const [fi, da, r, w, d, hh, k] of LH_PROPS) {
    const h = fi < 0 ? 0 : LH_FLOORS[fi], a = (fi < 0 ? LH.doorA : lhArrival(h).a) + da;
    out.push({ k, c: [x + dmath.cos(a) * r, y + h + hh / 2, z + dmath.sin(a) * r], h: [w / 2, hh / 2, d / 2], yaw: Math.PI / 2 - a, col: true, surf: k === "lh:drums" ? "metal" : "wood" });
  }
  // the door portal's pilasters + jambs (drawn proud of the plinth beside the door gap)
  {
    const th = Math.PI / 2 - LH.doorA, ca = dmath.cos(LH.doorA), sa = dmath.sin(LH.doorA), tx = dmath.cos(th), tz = -dmath.sin(th);
    const rIn = lhRadius(y) - LH.wall, rO = LH.plinthR, rm = (rIn + rO) / 2, depth = rO - rIn + 0.2;
    for (const s of [-1, 1]) {
      const lp = s * (LH.doorW / 2 + 0.3), lj = s * (LH.doorW / 2 + 0.12);
      out.push({ k: "lh:pilaster", c: [x + ca * (rO + 0.1) + tx * lp, y + 1.6, z + sa * (rO + 0.1) + tz * lp], h: [0.21, 1.6, 0.17], yaw: th, col: true, surf: "stone" });
      out.push({ k: "lh:jamb", c: [x + ca * rm + tx * lj, y + LH.doorH / 2, z + sa * rm + tz * lj], h: [0.12, LH.doorH / 2, depth / 2], yaw: th, col: true, surf: "stone" });
    }
  }
  // the two red leaves swung out against the portal
  {
    const th = Math.PI / 2 - LH.doorA, rO = LH.plinthR + 0.22;
    for (const s of [-1, 1]) {
      const hx = x + dmath.cos(LH.doorA) * rO + s * (LH.doorW / 2) * dmath.cos(th), hz = z + dmath.sin(LH.doorA) * rO - s * (LH.doorW / 2) * dmath.sin(th);
      const ly = th + s * 1.9, cx = hx + dmath.cos(ly) * (-s * 0.475), cz = hz - dmath.sin(ly) * (-s * 0.475);
      out.push({ k: "lh:leaf", c: [cx, y + 1.38, cz], h: [0.475, 1.36, 0.05], yaw: ly, col: true, surf: "wood" });
    }
  }
  // top floor (lantern room) + gallery deck: 24 sectors; the stairwell hatch is left open over the last LH_HATCH steps
  const aEnd = LH.stairA0 + LH.stepDa * LH.steps;
  const hatch0 = aEnd - LH.stepDa * LH_HATCH;
  const sectors = 24, da = (Math.PI * 2) / sectors, norm = (a: number) => ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  for (let i = 0; i < sectors; i++) {
    const a = da * (i + 0.5);
    const rel = norm(a - hatch0), open = rel < norm(aEnd - hatch0) + 0.05;
    const seg = (r0: number, r1: number, k: string, th: number) => {
      const rm = (r0 + r1) / 2, w = 2 * r1 * dmath.tan(da / 2) + 0.06;
      out.push({ k, c: [x + dmath.cos(a) * rm, LH.top - th / 2, z + dmath.sin(a) * rm], h: [(r1 - r0) / 2, th / 2, w / 2], yaw: -a, surf: "concrete" });
    };
    // (the lantern-room floor is a 0.25 m steel-plate floor — with a 0.5 m slab the treads just short of the hatch
    // have 1.83 m under it and the solver refuses the climb: the lantern room is unreachable)
    if (!open) seg(0.3, LH.roomR - 0.25, "lh:floor", 0.25);
    // gallery deck collider stops 0.45 m inside the drawn lip: the rail ring (r ≥ 5.18) keeps the capsule's centre
    // within 4.76 anyway, and the plinth ledge 18 m below is then "open sky" to the scanner, not a covered floor
    seg(LH.roomR - 0.25, LH.deckR - 0.45, "lh:deck", 0.25);
  }
  // lantern room: low solid wall + glazing (players blocked, bullets pass), door gap onto the gallery; railing; dome
  const gd = 1.0 / LH.roomR + 0.05, gap: [number, number] = [LH.galleryDoorA - gd, LH.galleryDoorA + gd];
  // (the lantern's wall + glazing run EXACTLY the drawn arc ga + gd … ga + 2π − gd — ringWall drops whole 20° segments
  //  whose centre falls in the door gap, which would leave ~8° of drawn glass on each side of the door with no
  //  collider. Every drawn pane is a breakable pane.)
  const arc = (k: string, y0: number, h: number, t: number, o: Partial<Piece>) => {
    const a0 = gap[1], a1 = gap[0] + Math.PI * 2, n = 18, da = (a1 - a0) / n, rm = LH.roomR - t / 2, w = 2 * LH.roomR * dmath.tan(da / 2) + 0.05;
    for (let i = 0; i < n; i++) { const a = a0 + da * (i + 0.5); out.push({ k, c: [x + dmath.cos(a) * rm, y0 + h / 2, z + dmath.sin(a) * rm], h: [t / 2, h / 2, w / 2], yaw: -a, ...o }); }
  };
  arc("lh:roomwall", LH.top, LH.roomWall, 0.3, { surf: "metal" });
  arc("lh:glass", LH.top + LH.roomWall, LH.glassH + LH.ringH, 0.12, { surf: "glass", noShoot: true });
  out.push(...ringWall("lh:rail", x, z, LH.top, 1.15, LH.deckR, 0.12, 24, [], { surf: "metal", noShoot: true }));
  const rt = LH.top + LH.roomWall + LH.glassH + LH.ringH;
  out.push({ k: "lh:roof", c: [x, rt + LH.domeH * 0.35, z], h: [LH.roomR * 0.8, LH.domeH * 0.35, LH.roomR * 0.8], surf: "metal", col: true });
  // lamp pedestal (newel continues up) — the lens sits above head height
  out.push({ k: "lh:pedestal", c: [x, LH.top + 1.0, z], h: [0.45, 1.0, 0.45], surf: "metal", col: true });
  // entrance steps (3 curved stone steps, as flat boxes) in front of the door
  for (let s = 0; s < 3; s++) {
    const r = LH.plinthR + 0.45 + (2 - s) * 0.45;
    out.push({ k: "step:stone", c: [x + dmath.cos(LH.doorA) * r, y + 0.09 + s * 0.18 - 0.09 * s, z + dmath.sin(LH.doorA) * r], h: [0.23 + (2 - s) * 0.22, 0.09 + s * 0.09, 1.5 - s * 0.15], yaw: -LH.doorA, surf: "stone" });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ keeper's cottage
const [CX, CY, CZ, CYAW] = baked.anchors.cot;
/** cottage frame: +X runs along the rim away from the lighthouse, +Z faces the sea (porch side, the view camera) */
export const COT = {
  L: 12, D: 8, t: 0.35, floor: 0.35, wallH: 3.9, pitch: (48 / 180) * Math.PI, over: 0.65,
  frame: F(CX, CY, CZ, CYAW) as Frame,
};
export const COT_EAVE = COT.floor + COT.wallH;
export const COT_RISE = (COT.D / 2) * dmath.tan(COT.pitch);
/** openings in local metres along each wall (u from the wall's start corner) */
export const COT_OPEN = {
  front: [{ u: 2.0, w: 1.3, y0: 1.0, h: 1.5, kind: "window" }, { u: 4.3, w: 1.7, y0: 0, h: 2.7, kind: "door" }, { u: 8.4, w: 1.4, y0: 1.0, h: 1.5, kind: "window" }, { u: 10.3, w: 1.4, y0: 1.0, h: 1.5, kind: "window" }],
  back: [{ u: 2.5, w: 1.3, y0: 1.0, h: 1.4, kind: "window" }, { u: 6.5, w: 1.7, y0: 0, h: 2.7, kind: "door" }, { u: 10.0, w: 1.3, y0: 1.0, h: 1.4, kind: "window" }],
  far: [{ u: 5.1, w: 1.4, y0: 1.0, h: 1.5, kind: "window" }],
  // past the attic stair (at u 4 the window sits at waist height beside the stair's upper flight — the
  // solver glides climbers out through it)
  near: [{ u: 6.3, w: 1.1, y0: 1.2, h: 1.2, kind: "window" }],
} as const;
export const COT_CHIMNEYS: Array<[number, number]> = [[-0.65, -1.0]];
export const COT_DORMER = { x: 1.2, w: 2.6 };
export const PORCH = { x0: -5.2, x1: 1.4, depth: 2.4, y: 0.35 };
/** attic (cottage-local): knee walls at |z| = knee, the window-seat top under the dormer, the stair along the near
 *  wall (x0…x1, climbing +z from z0 to z1, n treads) */
export const COT_ATTIC = { knee: 2.15, seat: 4.7, stair: { x0: -5.75, x1: -4.15, z0: -3.55, z1: 0.9, n: 18 } };
/** cottage furniture colliders (cottage-local; height < 0 = in the attic, standing on its floor): kitchen counter,
 *  stove, dresser, table, bed; attic: sea chests + a crate staircase */
export const COT_FURN: Array<[number, number, number, number, number, string]> = [
  // (the ground floor is furnished by the shared interiors kit — INTERIOR_ROOMS; the attic keeps its chests)
  [2.4, -1.2, 3.4, -0.4, -0.55, "cot:chest"], [-3.5, -1.6, -2.4, -0.8, -0.55, "cot:chest"],
];

function cottage(): Piece[] {
  const { L, D, t, floor, wallH } = COT, hl = L / 2, hd = D / 2, out: Piece[] = [];
  const y0 = floor;
  out.push(...keeperDormerPieces(COT_EAVE, hd, COT.pitch, COT_DORMER.x, COT_DORMER.w));
  out.push(...keeperPartitions(floor, wallH - 0.2));
  // stone plinth / floor slab (reaches down: the cottage stands on the cliff caps / the pad blend)
  out.push(bx("cot:floor", -hl, -0.6, -hd, hl, floor, hd, { surf: "wood" }));
  const o = (a: readonly { u: number; w: number; y0: number; h: number }[]) => a.map((q) => ({ ...q }));
  out.push(...wall("cot:wall", -hl, hd - t / 2, hl, hd - t / 2, y0, wallH, t, o(COT_OPEN.front), { surf: "wood" }));
  out.push(...wall("cot:wall", -hl, -hd + t / 2, hl, -hd + t / 2, y0, wallH, t, o(COT_OPEN.back), { surf: "wood" }));
  out.push(...wall("cot:wall", hl - t / 2, -hd, hl - t / 2, hd, y0, wallH, t, o(COT_OPEN.far), { surf: "wood" }));
  out.push(...wall("cot:wall", -hl + t / 2, -hd, -hl + t / 2, hd, y0, wallH, t, o(COT_OPEN.near), { surf: "wood" }));
  // gable ends (stacked boxes approximating the triangle, collision only; visuals are true triangles)
  const eave = y0 + wallH;
  for (let s = 0; s < 3; s++) {
    const f0 = s / 3, f1 = (s + 1) / 3, w = D * (1 - f1) + 0.2;
    for (const ex of [hl - t / 2, -hl + t / 2]) out.push({ k: "cot:gable", c: [ex, eave + COT_RISE * (f0 + f1) / 2, 0], h: [t / 2, COT_RISE / 6, w / 2], col: true, surf: "wood" });
  }
  // roof: two pitched slabs resting on the wall tops (pitch about local X: +Z end down for the front slope)
  out.push(...keeperMainRoof(eave, hd, hl, COT.pitch, COT_DORMER.x, COT_DORMER.w));
  for (const [cx, cz] of COT_CHIMNEYS) out.push(bx("cot:chimney", cx - 0.35, eave, cz - 0.35, cx + 0.35, eave + COT_RISE + 2.4, cz + 0.35, { surf: "stone" }));
  // a real attic behind the dormer: a boarded attic floor at the eave (the room below gets its ceiling), knee walls where
  // the roof comes lower than head height (open at the dormer: a window seat), and a straight stair up along the
  // near (lighthouse-side) wall through a hatch
  const A = COT_ATTIC, S2 = A.stair;
  const af = (x0: number, z0: number, x1: number, z1: number) => out.push(bx("cot:attic", x0, eave - 0.2, z0, x1, eave, z1, { surf: "wood" }));
  af(-hl + t, S2.z1 + 0.15, hl - t, hd - t); af(S2.x1 + 0.1, -hd + t, hl - t, S2.z1 + 0.15);
  out.push({ ...railCol(S2.x1 + 0.08, S2.z0, eave, S2.x1 + 0.08, S2.z1 + 0.1, eave, 1.0), k: "rail:new" });
  // Two deep starter treads make the side entry a normal 0.43 m step instead of a 0.65 m snap.
  let treadZ = S2.z0;
  for (let i = 0; i < S2.n; i++) {
    const run = i < 2 ? 0.5 : (S2.z1 - S2.z0 - 1.0) / (S2.n - 2);
    out.push(bx("cot:step", S2.x0, floor, treadZ, S2.x1, floor + (eave - floor) * (i + 1) / S2.n, treadZ + run, { surf: "wood" }));
    treadZ += run;
  }
  const kTop = (z: number) => eave + (hd - Math.abs(z)) * dmath.tan(COT.pitch) - 0.08;
  const dx0 = COT_DORMER.x - COT_DORMER.w / 2 - 0.1, dx1 = COT_DORMER.x + COT_DORMER.w / 2 + 0.1;
  // back knee wall (full length), front knee wall with the dormer bay (low sill wall = the window seat under it)
  // (stops short of the stair lane — across it, the knee wall would be a head-height wall over the upper flight)
  out.push(bx("cot:knee", S2.x1 + 0.1, eave, -A.knee - 0.12, hl - t, kTop(A.knee + 0.12), -A.knee, { surf: "wood" }));
  out.push(bx("cot:knee", -hl + t, eave, A.knee, dx0, kTop(A.knee + 0.12), A.knee + 0.12, { surf: "wood" }), bx("cot:knee", dx1, eave, A.knee, hl - t, kTop(A.knee + 0.12), A.knee + 0.12, { surf: "wood" }));
  out.push(bx("cot:bay-step", dx0, eave, A.knee - 0.28, dx1, eave + (A.seat - eave) / 2, A.knee, { surf: "wood" }));
  out.push(bx("cot:seat", dx0, eave, A.knee, dx1, A.seat, hd - 1.0, { surf: "wood" }));
  for (const [x0, z0, x1, z1, h, k] of COT_FURN) out.push(bx(k, x0, h < 0 ? eave : floor, z0, x1, (h < 0 ? eave : floor) + Math.abs(h), z1, { col: true, surf: "wood" }));
  // the open door leaves (client index.ts: hinged 0.1 m inside the outer face at the door's left edge, turned
  // inward at front (+1.7 rad), outward at rear (−1.7 rad)) get their colliders
  for (const [wk, bxp, bzp, byaw] of [["front", -hl, hd, 0], ["back", -hl, -hd, Math.PI]] as Array<["front" | "back", number, number, number]>) for (const op of COT_OPEN[wk]) {
    if (op.kind !== "door") continue;
    const c0 = dmath.cos(byaw), s0 = dmath.sin(byaw), hx0 = bxp + op.u + (-op.w / 2) * c0 + (-0.1) * s0, hz0 = bzp - (-op.w / 2) * s0 + (-0.1) * c0;
    const ly = byaw + (wk === "front" ? 1.7 : -1.7), w2 = (op.w - 0.05) / 2;
    out.push({ k: "cot:leaf", c: [hx0 + dmath.cos(ly) * w2, floor + op.h / 2, hz0 - dmath.sin(ly) * w2], h: [w2, (op.h - 0.05) / 2, 0.045], yaw: ly, col: true, surf: "wood" });
  }
  // porch deck + awning posts + rails (with a gap for 2 steps at the right end)
  const P = PORCH, pz0 = hd, pz1 = hd + P.depth;
  out.push(bx("porch:deck", P.x0, -0.4, pz0, P.x1, P.y, pz1, { surf: "wood" }));
  out.push(bx("porch:rail", P.x0, P.y, pz1 - 0.08, P.x1 - 1.6, P.y + 1.0, pz1, { surf: "wood", noShoot: true }));
  out.push(bx("porch:rail", P.x0, P.y, pz0, P.x0 + 0.08, P.y + 1.0, pz1, { surf: "wood", noShoot: true }));
  out.push(...stairs("step:wood", P.x1 - 0.8, pz1 + 0.64, 0, Math.PI, 1.5, P.y / 2, 0.32, 2, { surf: "wood", ramp: false }));
  return out;
}
/** cottage pieces in the cottage's LOCAL frame (the client builds visuals in this frame so textures follow the walls) */
export const COT_LOCAL: Piece[] = cottage();

// ------------------------------------------------------------------------------------------------ yard
type V4 = [number, number, number, number];
/** radio masts: [x, ground y, z, height] */
export const MASTS = baked.anchors.masts as V4[];
/** red pickup: [x, ground y, z, yaw] */
export const TRUCK = baked.anchors.truck as V4;
/** picnic tables [x, ground y, z, yaw] */
export const PICNIC = baked.anchors.picnic as V4[];
/** crate stacks: [x, ground y, z, yaw, stack height 1..2] */
export const CRATES = baked.anchors.crates as Array<[number, number, number, number, number]>;
export const WINDSOCK = baked.anchors.windsock as [number, number, number];
/** where the yard path meets the stair head (fence gap) */
export const STAIR_HEAD = baked.anchors.stairHead as [number, number, number];
/** fence polylines along the lip [x, ground y, z-order: x, z, y] = [x, z, groundY], broken at the stair head */
export const FENCE = baked.fence as Array<Array<[number, number, number]>>;

function yard(): Piece[] {
  const out: Piece[] = [];
  // a core inside the 3-leg lattice (a 1 m box would be an invisible wall around the open lattice)
  for (const [x, y, z, h] of MASTS) out.push({ k: "mast", c: [x, y + 0.45 + h / 2, z], h: [0.22, h / 2, 0.22], surf: "metal", noShoot: true, col: true });
  // collider parity with the drawn pickup: hood, cab, and the open bed (floor + sides + tailgate)
  const [tx, ty, tz, tyaw] = TRUCK;
  out.push(...place(F(tx, ty, tz, tyaw), [
    bx("truck", 0.95, 0, -0.98, 2.45, 1.33, 0.98, { col: true, surf: "metal" }),
    bx("truck", -0.5, 0, -0.95, 0.95, 2.06, 0.95, { col: true, surf: "metal" }),
    bx("truck", -2.43, 0, -0.95, -0.5, 0.8, 0.95, { col: true, surf: "metal" }),
    bx("truck", -2.43, 0.8, 0.8, -0.5, 1.33, 0.95, { col: true, surf: "metal" }), bx("truck", -2.43, 0.8, -0.95, -0.5, 1.33, -0.8, { col: true, surf: "metal" }),
    bx("truck", -2.43, 0.8, -0.8, -2.33, 1.33, 0.8, { col: true, surf: "metal" }),
  ]));
  for (const [x, y, z, yaw] of PICNIC) out.push({ k: "picnic", c: [x, y + 0.42, z], h: [1.0, 0.42, 0.9], yaw, surf: "wood", col: true });
  for (const [x, y, z, yaw, n] of CRATES) out.push({ k: "crate", c: [x, y + 0.4 * n, z], h: [0.62, 0.4 * n, 0.42], yaw, surf: "wood", col: true });
  out.push({ k: "wsmast", c: [WINDSOCK[0], WINDSOCK[1] + 3.3, WINDSOCK[2]], h: [0.12, 3.3, 0.12], surf: "metal", noShoot: true, col: true });
  for (const line of FENCE) for (let i = 0; i + 1 < line.length; i++) {
    const [ax, az, ay] = line[i], [bx2, bz, by] = line[i + 1], y0 = Math.min(ay, by) - 0.3;
    if (Math.abs(ay - by) > 1.2) continue; // no fence across a drop (it would be an 11 m invisible panel over the lip)
    out.push(...wall("fence", ax, az, bx2, bz, y0, Math.max(ay, by) + 1.1 - y0, 0.12, [], { surf: "wood", noShoot: true, col: true, driveStop: true }));   // (the lip railing guards a 10–28 m drop — a tuk-tuk must not drive through it)
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ cliff columns + stair
/** the stair zone frame: x along the face (+x = toward the tower / smaller angle), +z out of the face */
export const ZONE = baked.zone;
export const ZONE_F: Frame = F(ZONE.x, 0, ZONE.z, ZONE.yaw);
/** a flight in zone-local coords: x0 → x1 descending y0 → y1, in the band z0..z1 (outer band = even flights, inner
 *  band against the rock = odd flights, so consecutive flights never stack in plan) */
export interface Run { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number }
export const FLIGHTS: Run[] = baked.flights;
/** fallen blocks that plug beach pockets at the cliff foot (scan traps): [x, base y, z, w, h, d, yaw] (drawn as faceted
 *  rock blocks at exactly these boxes) */
export const LK_FILL: Array<[number, number, number, number, number, number, number]> = [[-691.3, 0.3, 541.2, 3.0, 1.9, 2.8, 0.95]];
export const LANDINGS: Array<{ x0: number; x1: number; y: number; z0: number; z1: number }> = baked.landings;
export const EXIT: Run | null = baked.exit;
/** the whole stair band (zone z): landings span it */
export const STAIR_Z0 = -ZONE.NOTCH, STAIR_Z1 = -ZONE.NOTCH + ZONE.SW;
export const TREAD_RUN = 0.34;
/** the treads of a flight: [x centre, tread top] in zone-local, n treads of run `run` */
export function treads(f: Run): { n: number; run: number; rise: number; list: Array<[number, number]> } {
  const L = Math.abs(f.x1 - f.x0), n = Math.max(1, Math.round(L / TREAD_RUN)), run = L / n, rise = (f.y0 - f.y1) / n, dir = Math.sign(f.x1 - f.x0);
  const list: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) list.push([f.x0 + dir * run * (i + 0.5), f.y0 - rise * (i + 1)]);
  return { n, run, rise, list };
}
/** pitched railing collider between two zone-local points (bottom follows y0 → y1). NB the sim treats a pitched box
 *  as its vertical bounding box (shared/sim/world.ts) — fine for a thin noShoot rail at a band edge. */
function railCol(x0: number, z0: number, y0: number, x1: number, z1: number, y1: number, h = 1.05): Piece {
  const L = dmath.hypot(x1 - x0, z1 - z0), yaw = dmath.atan2(x1 - x0, z1 - z0), pitch = -dmath.atan2(y1 - y0, L);
  return { k: "crail", c: [(x0 + x1) / 2, (y0 + y1) / 2 + h / 2, (z0 + z1) / 2], h: [0.05, h / 2, dmath.hypot(L, y1 - y0) / 2], yaw, pitch, col: true, noShoot: true, surf: "metal" };
}
function cliff(): Piece[] {
  const out: Piece[] = [];
  for (const c of COLUMNS) {
    const f = F(c.x, 0, c.z, c.yaw);
    out.push(...place(f, [bx("rock:col", -c.w / 2, c.y0, c.zin, c.w / 2, c.y1, c.zout, { surf: "stone", col: true })]));
  }
  // stair (zone-local): one collider box PER TREAD (0.45 m thick, no pitched ramp — the sim auto-steps ≤ 0.55 m),
  // landings, a noShoot rail on the open side of every flight + along the landings' outer edge
  const zp: Piece[] = [];
  for (const f of [...FLIGHTS, ...(EXIT ? [EXIT] : [])]) {
    const t = treads(f), zc = (f.z0 + f.z1) / 2, w = f.z1 - f.z0;
    for (const [x, top] of t.list) zp.push(bx("ctread", x - t.run / 2 - 0.01, top - 0.45, zc - w / 2, x + t.run / 2 + 0.01, top, zc + w / 2, { surf: "stone", col: true }));
    if (f.z1 >= STAIR_Z1 - 0.01) zp.push(railCol(f.x0, f.z1 - 0.06, f.y0, f.x1, f.z1 - 0.06, f.y1));
    else {
      // the rail between the bands stops 1.1 m short of both landings so you can turn round it
      const dir = Math.sign(f.x1 - f.x0), k = 1.1 / Math.abs(f.x1 - f.x0), zr = f.z1 + ZONE.BG / 2;
      zp.push(railCol(f.x0 + dir * 1.1, zr, f.y0 + (f.y1 - f.y0) * k, f.x1 - dir * 1.1, zr, f.y1 - (f.y1 - f.y0) * k));
    }
  }
  for (const l of LANDINGS) {
    zp.push(bx("landing", l.x0, l.y - 0.7, l.z0, l.x1, l.y, l.z1, { surf: "stone" }));
    const xe = l.x0 < 0 ? l.x0 + 0.06 : l.x1 - 0.06;
    zp.push(railCol(xe, l.z0, l.y, xe, l.z1, l.y));
    zp.push(railCol(l.x0, STAIR_Z1 - 0.06, l.y, l.x1, STAIR_Z1 - 0.06, l.y));
  }
  out.push(...place(ZONE_F, zp));
  // a fallen block fills a 5 m² trap pocket between the north columns and the beach rocks
  for (const [x, y, z, w, h, d, yaw] of LK_FILL) out.push({ k: "lk:fill", c: [x, y + h / 2, z], h: [w / 2, h / 2, d / 2], yaw, col: true, surf: "stone" });
  // big foot boulders (≥ 1.5 m): one box each
  for (const [x, y, z, s] of baked.boulders as Array<[number, number, number, number, number]>) {
    if (s < 1.5) continue;
    out.push({ k: "boulder", c: [x, y + s * 0.2, z], h: [s * 0.72, s * 0.5, s * 0.62], surf: "stone", col: true });
  }
  return out;
}
export const CLIFF_PIECES: Piece[] = cliff();

// ------------------------------------------------------------------------------------------------ plateau
/** the terrain's footpath onto the headland ("plantation-lookout") + the lane on to the yard */
export const LK_PATH: Array<[number, number]> = [[-460, 395], [-510, 420], [-560, 450], [-590, 470], [-622, 468], [-646, 462]];
export function pathDist(x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i + 1 < LK_PATH.length; i++) {
    const [ax, az] = LK_PATH[i], [bx2, bz] = LK_PATH[i + 1], dx = bx2 - ax, dz = bz - az, u = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
    best = Math.min(best, dmath.hypot(x - ax - dx * u, z - az - dz * u));
  }
  return best;
}
/** the view camera (bearing / distance / height from the lighthouse — the client derives its aim from it);
 *  here so the plateau planting keeps its sight lines: nothing tall BEHIND the tower + cottage as seen from it */
export const VIEW_BEARING = 133.5, VIEW_DIST = 57.5, VIEW_H = 13.2;
export const VIEW_POS: [number, number, number] = [LH.x + dmath.cos(VIEW_BEARING * Math.PI / 180) * VIEW_DIST, TOP + VIEW_H, LH.z + dmath.sin(VIEW_BEARING * Math.PI / 180) * VIEW_DIST];
/** "front" = between the camera and the tower/cottage, "behind" = the backdrop behind them, else "clear" */
export function viewSight(x: number, z: number): "front" | "behind" | "clear" {
  const [cx0, , cz0] = VIEW_POS, bearing = (px: number, pz: number) => dmath.atan2(px - cx0, pz - cz0);
  const tgt: Array<[number, number]> = [[LH.x, LH.z], ...[[-6.5, -4.5], [6.5, -4.5], [-6.5, 7], [6.5, 7]].map(([lx, lz]) => { const p = toWorld(COT.frame, lx, 0, lz); return [p[0], p[2]] as [number, number]; })];
  const tc = bearing(LH.x, LH.z), rel = (a: number) => { let d = a - tc; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return d; };
  const tb = tgt.map(([px, pz]) => rel(bearing(px, pz))), s0 = Math.min(...tb) - 0.07, s1 = Math.max(...tb) + 0.07;
  const d = rel(bearing(x, z)), dist = dmath.hypot(x - cx0, z - cz0), dT = dmath.hypot(LH.x - cx0, LH.z - cz0);
  if (dist < dT - 6) return d > s0 - 0.14 && d < s1 + 0.1 ? "front" : "clear";
  if (d < s0 || d > s1) return "clear";
  return dist > dT - 2 ? "behind" : "clear";
}
/** the signal hut on the E plateau (a clifftop BANANA CO. hut): a stone room with a door, windows,
 *  a flat roof you reach by the crate staircase outside. Hut-local: +Z = door side (toward the path). */
// 7.2 × 5.8 m (furnished at 5.2 × 4.2 the room leaves the loot generator < 4 standable cells: not a building)
export const HUT = { frame: F(-604, 46, 497, 2.9) as Frame, hx: 3.6, hz: 2.9, t: 0.4, h: 3.0, roofT: 0.25, parapet: 0.5 };
export const HUT_FURN: Array<[number, number, number, number, number, string, number]> = [
  // (the room itself is furnished by the shared interiors kit — INTERIOR_ROOMS)
  // outside the right wall: the crate staircase to the roof
  [3.7, -1.6, 4.7, -0.7, 1.5, "hut:crate", 0], [3.7, -0.7, 4.7, 0.2, 1.0, "hut:crate", 0], [3.7, 0.2, 4.7, 1.1, 0.5, "hut:crate", 0],
];
function hut(): Piece[] {
  const H = HUT, { hx, hz, t, h } = H, out: Piece[] = [];
  out.push(bx("hut:floor", -hx, -0.5, -hz, hx, 0.2, hz, { surf: "stone" }));
  out.push(...wall("hut:wall", -hx, hz - t / 2, hx, hz - t / 2, 0.2, h - 0.2, t, [{ u: hx - 0.3, w: 1.2, y0: 0, h: 2.25 }], { surf: "stone" }));
  out.push(...wall("hut:wall", hx, -hz + t / 2, -hx, -hz + t / 2, 0.2, h - 0.2, t, [{ u: hx, w: 0.9, y0: 0.9, h: 0.8 }], { surf: "stone" }));
  out.push(...wall("hut:wall", hx - t / 2, hz - t, hx - t / 2, -hz + t, 0.2, h - 0.2, t, [{ u: hz - t, w: 0.8, y0: 1.0, h: 0.8 }], { surf: "stone" }));
  out.push(...wall("hut:wall", -hx + t / 2, -hz + t, -hx + t / 2, hz - t, 0.2, h - 0.2, t, [{ u: hz - t, w: 0.8, y0: 1.0, h: 0.8 }], { surf: "stone" }));
  out.push(bx("hut:roof", -hx - 0.15, h, -hz - 0.15, hx + 0.15, h + H.roofT, hz + 0.15, { surf: "concrete" }));
  const rt = h + H.roofT, pt = 0.25;
  out.push(bx("hut:parapet", -hx - 0.15, rt, -hz - 0.15, hx + 0.15, rt + H.parapet, -hz + pt - 0.15, { surf: "stone" }), bx("hut:parapet", -hx - 0.15, rt, hz - pt + 0.15, hx + 0.15, rt + H.parapet, hz + 0.15, { surf: "stone" }));
  out.push(bx("hut:parapet", -hx - 0.15, rt, -hz + pt - 0.15, -hx + pt - 0.15, rt + H.parapet, hz - pt + 0.15, { surf: "stone" }));
  // right parapet open over the crate staircase (the way up)
  out.push(bx("hut:parapet", hx - pt + 0.15, rt, -hz + pt - 0.15, hx + 0.15, rt + H.parapet, -1.6, { surf: "stone" }), bx("hut:parapet", hx - pt + 0.15, rt, 1.1, hx + 0.15, rt + H.parapet, hz - pt + 0.15, { surf: "stone" }));
  out.push(...doorLeaves("hut:leaf", -hx, hz - t / 2, hx, hz - t / 2, 0.2, [{ u: hx - 0.3, w: 1.2, y0: 0, h: 2.25 }], t, -1.2, { surf: "wood" }));
  for (const [x0, z0, x1, z1, hh, k, y0] of HUT_FURN) out.push(bx(k, x0, y0, z0, x1, y0 + hh, z1, { col: true, surf: k === "hut:shelf" ? "metal" : "wood" }));
  return out;
}
export const HUT_LOCAL: Piece[] = hut();

/** plateau cover (hard cover within ~8 m everywhere): dry-stone field
 *  walls + boulders where the view camera sees the backdrop (low: the lighthouse keeps its silhouette), palm and
 *  jungle-tree clumps (collidable flora) everywhere else on the flat plateau top (terrain 46.0, x ≥ −642) */
export const LK_WALLS: Array<[number, number, number, number]> = [
  // [x, z, yaw, length]
  [-628, 440, 0.4, 6.5], [-612, 452, -0.2, 7], [-626, 492, 1.3, 6], [-574, 452, 0.9, 7], [-560, 488, -0.6, 6.5], [-582, 506, 0.2, 7], [-548, 462, 1.6, 6],
  [-597, 436, -0.1, 6], [-548, 510, 0.5, 5.5], [-634, 483, 1.5, 5],
  // (filling cover gaps): the SW lawn, the E rim, the S lawn, by the lighthouse lane
  [-634, 525, 0.3, 6], [-529, 510, 1.0, 5.5], [-618, 466, 0.5, 4.5], [-636, 424, 0.1, 5], [-652, 490, 1.2, 4.5], [-540, 432, 0.7, 5],
  [-626, 538, -0.5, 5], [-651, 474, 0.25, 4], [-538, 530, 0.6, 5],
];
/** base height of each field wall (the lowest ground under it; walls on uneven ground > 0.8 m are dropped by the client
 *  and the collider alike — NaN) */
export const LK_WALL_BASE: number[] = [];
const PLATEAU_Y = 46;
/** terrain height on the headland from the bake's 3 m grid (bilinear; NaN outside it) — the plateau cover and the
 *  collidable flora stand on it (the server has no terrain sampler at import) */
let HG_DATA: Int16Array | null = null;
export function lookoutGround(x: number, z: number): number {
  const g = (baked as { hgrid?: { x0: number; z0: number; step: number; nx: number; nz: number; data: string } }).hgrid;
  if (!g) return NaN;
  if (!HG_DATA) { const bin = atob(g.data), a = new Int16Array(bin.length / 2); for (let i = 0; i < a.length; i++) { const v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8); a[i] = v > 32767 ? v - 65536 : v; } HG_DATA = a; }
  const fx = (x - g.x0) / g.step, fz = (z - g.z0) / g.step, i = Math.floor(fx), j = Math.floor(fz);
  if (i < 0 || j < 0 || i >= g.nx - 1 || j >= g.nz - 1) return NaN;
  const u = fx - i, v = fz - j, h = (a: number, b: number) => HG_DATA![b * g.nx + a] / 100;
  return (h(i, j) * (1 - u) + h(i + 1, j) * u) * (1 - v) + (h(i, j + 1) * (1 - u) + h(i + 1, j + 1) * u) * v;
}
/** local relief (m) over ±r — the plateau cover only goes where the ground is near-flat */
const relief = (x: number, z: number, r = 2.5) => { let lo = Infinity, hi = -Infinity; for (const [dx, dz] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) { const y = lookoutGround(x + dx, z + dz); lo = Math.min(lo, y); hi = Math.max(hi, y); } return hi - lo; };
export const LK_BOULDERS: Array<[number, number, number, number, number]> = []; // x, ground y, z, size, seed
export const FLORA: Flora[] = [];
(() => {
  // (thinning roll per lattice cell — its own hash, so the r() sequence and every other placement stay put)
  const thin = (gx: number, gz: number) => { let h = Math.imul((gx * 73856093) ^ (gz * 19349663), 2654435761) >>> 0; h ^= h >>> 15; h = Math.imul(h, 2246822519) >>> 0; h ^= h >>> 13; return (h >>> 0) / 4294967296; };
  const r = rng(4747), hutAt = (x: number, z: number) => dmath.hypot(x - HUT.frame.x, z - HUT.frame.z) < 7.5;
  const wallAt = (x: number, z: number) => LK_WALLS.some(([wx, wz, , L]) => dmath.hypot(x - wx, z - wz) < L / 2 + 2.5);
  const yard = (x: number, z: number) => { const f = COT.frame, dx = x - f.x, dz = z - f.z, c = dmath.cos(f.yaw), sn = dmath.sin(f.yaw), lx = dx * c - dz * sn, lz = dx * sn + dz * c; return lx > -33 && lx < 19 && lz > -15 && lz < 20; };
  for (let gx = -689; gx <= -482; gx += 9) for (let gz = 371; gz <= 569; gz += 9) {
    const x = gx + (r() - 0.5) * 5, z = gz + (r() - 0.5) * 5, k = r(), s = 0.85 + r() * 0.3, yaw = r() * 6.283, roll = r(), sz = 1.25 + r() * 0.6, seed = Math.floor(r() * 1e6);
    if (dmath.hypot(x - PAD.x, z - PAD.z) > 100) continue;             // (the veg scatter's own trees start at the clearing's edge)
    const y = lookoutGround(x, z);
    if (!(y > TOP - 30) || capAt(x, z) > -Infinity) continue;           // on the headland (+ its upper slopes), not on the cliff caps
    // Apply the approach guard before the steep-flank branch too: otherwise buttress trunks get planted beside
    // the footpath whenever relief is high, bypassing the ordinary path check below.
    if (pathDist(x,z) < 8) continue;
    const rl = relief(x, z), top = y > TOP - 3, sl = viewSight(x, z);
    if (rl > (top ? 0.6 : 2.0)) {
      // steeper flanks (≤ ~35°): jungle trees rooted in the slope (tall trunks are cover from above and below; a boulder
      // on a slope is not — cover means ≥ 1 m above the ground where you stand)
      if (!top && rl < 7 && sl !== "front" && thin(gx, gz) > 0.4) { const kd: Flora[0] = k < 0.6 || rl > 5 ? "jungle-tree" : "palm"; FLORA.push([kd, settleFlora(kd, x, z), y, z, yaw, kd === "jungle-tree" ? s * 0.85 : s]); }
      continue;
    }
    if (pathDist(x, z) < 3.2 || hutAt(x, z) || wallAt(x, z) || yard(x, z) || dmath.hypot(x - LH.x, z - LH.z) < 13) continue;
    // (cover ≤ 8 m everywhere): low boulders also in the camera's foreground / backdrop (≤ 1.6 m: the hero
    // camera looks down on them from 13 m) and on gentle ground (their base sinks into the slope)
    if (sl === "front" && roll > 0.55) continue;
    if (sl !== "clear" || roll < 0.22) { const rb = relief(x, z, 1.5); if (rb < (top ? 0.45 : 0.7)) LK_BOULDERS.push([x, y - Math.min(0.35, rb * 0.5), z, sz, seed]); continue; }
    // (light tree coverage — the headland top is a sniper's lawn: ~55 % of its lattice trees are skipped, three in four
    //  of those leave a low boulder behind so the 8 m cover rhythm holds without a wall of trunks)
    const tn = thin(gx, gz);
    if (tn < 0.55) { if (tn < 0.42) { const rb = relief(x, z, 1.5); if (rb < (top ? 0.45 : 0.7)) LK_BOULDERS.push([x, y - Math.min(0.35, rb * 0.5), z, sz, seed]); } continue; }
    const kind: Flora[0] = k < 0.55 ? "palm" : k < 0.75 ? "palm-leaning" : "jungle-tree";
    FLORA.push([kind, settleFlora(kind, x, z), y, z, yaw, kind === "jungle-tree" ? s * 0.85 : s]);
  }
  // hand-placed trees where the lattice left > 8 m to cover (SW lawn slope, E flank)
  for (const [x, z, kind] of [[-645, 528, "palm"], [-617, 532, "jungle-tree"], [-493, 464, "jungle-tree"], [-518, 491, "palm"], [-574, 548, "palm"]] as Array<[number, number, Flora[0]]>) {
    const y = lookoutGround(x, z);
    if (y > TOP - 30 && !FLORA.some((f) => dmath.hypot(f[1] - x, f[3] - z) < 3)) FLORA.push([kind, settleFlora(kind, x, z), y, z, (x * 0.37) % 6.28, kind === "jungle-tree" ? 0.85 : 1.0]);
  }
  // cover gaps ((−565, 398) up to 21 m, (−678, 511) 19 m, (−669, 477) 14 m, (−540, 429) 13 m without them): boulder
  // clusters on the open slopes there (each ≥ 1.1 m tall — hard cover), skipped where the ground is steep or taken
  for (const [x, z, sz] of [[-565, 398, 1.9], [-571, 405, 1.6], [-558, 391, 1.7], [-561, 410, 1.5], [-552, 400, 1.6], [-575, 393, 1.7],
    [-678, 511, 1.7], [-672, 505, 1.5], [-669, 477, 1.6], [-664, 471, 1.5], [-540, 429, 1.7], [-533, 424, 1.5], [-644, 516, 1.6], [-650, 523, 1.5],
    [-515, 414, 1.6], [-618, 404, 1.6], [-582, 538, 1.5],
    // (the thinned headland's open patches — boulder pockets instead of trunks)
    [-523, 446, 1.7], [-529, 439, 1.5], [-516, 453, 1.6], [-505, 514, 1.7], [-498, 507, 1.5], [-608, 557, 1.6], [-634, 467, 1.5]] as Array<[number, number, number]>) {
    const cap = capAt(x, z), y = cap > -Infinity ? cap : lookoutGround(x, z), rl = cap > -Infinity ? 0 : relief(x, z, 1.5);
    if (!(y > TOP - 40) || pathDist(x, z) < 3 || rl > 3.5) continue;
    if (FLORA.some((f) => dmath.hypot(f[1] - x, f[3] - z) < 2.5) || LK_BOULDERS.some((b) => dmath.hypot(b[0] - x, b[2] - z) < 2.5)) continue;
    // on a slope: a bigger outcrop sunk into it (its uphill side still stands ≥ 1 m proud)
    LK_BOULDERS.push([x, y - Math.min(1.2, rl * 0.45), z, sz + rl * 0.35, Math.round(x * 13 + z * 7)]);
  }
  // cover along the entry path (the lattice keeps 3.2 m off it): a tree or boulder every ~11 m, alternating
  // sides, 4.3 m off the centreline
  const r2 = rng(4848);
  for (let i = 0; i + 1 < LK_PATH.length; i++) {
    const [ax, az] = LK_PATH[i], [bx2, bz] = LK_PATH[i + 1], L = dmath.hypot(bx2 - ax, bz - az), nx = -(bz - az) / L, nz = (bx2 - ax) / L;
    for (let u = 5; u < L; u += 11) {
      const side = (Math.round(u / 11) + i) % 2 ? 1 : -1, x = ax + (bx2 - ax) * u / L + nx * side * 4.3, z = az + (bz - az) * u / L + nz * side * 4.3;
      if (dmath.hypot(x - PAD.x, z - PAD.z) > 100 || hutAt(x, z) || wallAt(x, z) || yard(x, z) || capAt(x, z) > -Infinity || dmath.hypot(x - LH.x, z - LH.z) < 13 || pathDist(x, z) < 3.4) continue;
      if (FLORA.some((f) => dmath.hypot(f[1] - x, f[3] - z) < 3) || LK_BOULDERS.some((b) => dmath.hypot(b[0] - x, b[2] - z) < 3)) continue;
      const y = lookoutGround(x, z), rl = relief(x, z), sz = 1.3 + r2() * 0.5, k = r2();
      if (!(y > TOP - 30)) continue;
      if (rl < 0.45) LK_BOULDERS.push([x, y - 0.05, z, sz, Math.floor(r2() * 1e6)]);
      else if (rl < 5.2 && viewSight(x, z) !== "front") { const kind: Flora[0] = k < 0.5 ? "jungle-tree" : "palm"; FLORA.push([kind, settleFlora(kind, x, z), y, z, r2() * 6.283, kind === "jungle-tree" ? 0.8 : 1.0]); }
    }
  }
})();
function plateau(): Piece[] {
  const out: Piece[] = [];
  for (const [i, [x, z, yaw, L]] of LK_WALLS.entries()) {
    const g = [-0.5, 0, 0.5].map((u) => lookoutGround(x + dmath.cos(yaw) * u * L, z - dmath.sin(yaw) * u * L)), lo = Math.min(...g), hi = Math.max(...g);
    const base = !(lo > 0) || hi - lo > 0.8 ? NaN : Math.min(lo, PLATEAU_Y) - 0.05;
    LK_WALL_BASE[i] = base;
    if (Number.isNaN(base)) continue;
    // the collider stands 1.24 m above the HIGHEST ground under it (the drawn wall's top)
    out.push({ k: "lk:wall", c: [x, (base + hi + 1.24) / 2, z], h: [L / 2, (hi + 1.24 - base) / 2, 0.36], yaw, surf: "stone", col: true });
  }
  // (inside the drawn rock — dress.ts draws an ellipsoid 0.76 × 0.52 × 0.66 sz centred 0.33 sz up: a flat box
  // top at 0.85 sz would float over its rounded crown)
  for (const [x, y, z, sz] of LK_BOULDERS) { const top = y + sz * 0.7, bot = y - sz * 0.15; out.push({ k: "boulder", c: [x, (top + bot) / 2, z], h: [sz * 0.62, (top - bot) / 2, sz * 0.52], surf: "stone", col: true }); }
  return out;
}

export const PIECES: Piece[] = [...lighthouse(), ...place(COT.frame, COT_LOCAL), ...yard(), ...CLIFF_PIECES, ...place(HUT.frame, HUT_LOCAL), ...plateau()];
// ------------------------------------------------------------------------------------------------ interiors
/** the keeper's cottage ground floor and the signal hut, furnished by the shared interiors kit */
export const INTERIOR_ROOMS: InteriorRoom[] = (() => {
  const W = (side: 0 | 1 | 2 | 3, at: number, w: number, y0 = 1.0, h = 1.5) => ({ side, at, w, kind: "window" as const, y0, h });
  const D = (side: 0 | 1 | 2 | 3, at: number, w: number, h = 2.6) => ({ side, at, w, kind: "door" as const, h });
  const C = COT, H = HUT;
  return [
    ...keeperRooms(C.frame, C.floor, C.wallH - 0.2),
    // The pitched roof is sampled in thin collision strips. Declare the actual walkable attic footprint so
    // production census, room guarantees and stacked building attribution do not depend on roof strip width.
    kitRoom(C.frame, .8, COT_EAVE, 0, {
      id: "keeper-cottage-attic", w: 9.7, d: 4.1, h: 2.8, style: "house", role: "studio", seed: 714,
      finish: { floor: "none", wall: null, dado: null, ceiling: "none", shell: false, frames: false, baseboard: false, glass: false },
      openings: [{ side: 3, at: 1.4, w: 1.5, kind: "gap" }],
    }),
    kitRoom(H.frame, 0, 0.2, 0, {
      id: "signal-hut", w: 2 * (H.hx - H.t), d: 2 * (H.hz - H.t), h: H.h - 0.2, style: "lab", role: "dock", seed: 733, wallT: H.t, density: 0.45,
      finish: { floor: "boards", wallMat: "stone", wall: "#cfc6b4", dado: null, ceiling: "beams", glass: false, frames: false },
      openings: [D(0, -0.3, 1.2, 2.25), W(2, 0, 0.9, 0.9, 0.8), W(1, 0, 0.8, 1.0, 0.8), W(3, 0, 0.8, 1.0, 0.8)],
      keepOut: [{ r: [-1.6, -1.2, 1.6, 1.2], walk: true }],
    }),
  ];
})();

export const COT_INTERIOR = keeperLayouts(INTERIOR_ROOMS.filter(r => r.id?.startsWith("keeper-cottage") && r.id !== "keeper-cottage-attic"));
export const colliders: Box[] = lazyBoxes([...toBoxes(PIECES), ...COT_INTERIOR.flatMap(r => r.colliders), ...interiorColliders(INTERIOR_ROOMS.filter(r => !r.id?.startsWith("keeper-cottage")))], () => floraColliders(FLORA, vegTrunkColliders, VARIANTS));

// ------------------------------------------------------------------------------------------------ designed loot
/** LOOT_SPOTS: chests in the lantern room, on the gallery, in the lighthouse store, the keeper's cottage + its attic,
 *  on stair landings, at the cliff foot, in + on the signal hut; floor loot through the yard, cottage, plateau, stair */
export const LOOT_SPOTS: LootSpots = (() => {
  const chests: LootSpots["chests"] = [], floor: LootSpots["floor"] = [];
  const at = (a: number, r: number, y: number): [number, number, number] => [LH.x + dmath.cos(a) * r, y, LH.z + dmath.sin(a) * r];
  const C = (p: [number, number, number] | number[], yaw: number) => chests.push([p[0], p[1], p[2], yaw]);
  const L = (p: [number, number, number] | number[]) => floor.push([p[0], p[1], p[2]]);
  const cf = COT.frame, zf = ZONE_F;
  C(at(LH.galleryDoorA - 0.6, 1.8, LH.top), 0); C(at(LH.galleryDoorA + 0.9, 4.4, LH.top), 0);
  // the lighthouse rooms — a chest in the store (ground) and in the watch room, floor loot in the oil room
  C(at(LH.doorA + 3.4, 1.0, LH.y), LH.doorA); C(at(lhArrival(LH_FLOORS[1]).a + Math.PI, 0.9, LH.y + LH_FLOORS[1]), 0);
  // (floor loot on the upper floors: the generator's own scan finds them — a designed one by the column read "enclosed")
  C(toWorld(cf, 1.2, COT_EAVE, 0.4), cf.yaw + Math.PI);
  const l2 = LANDINGS[2], l5 = LANDINGS[Math.min(5, LANDINGS.length - 1)];
  C(toWorld(zf, (l2.x0 + l2.x1) / 2, l2.y, (l2.z0 + l2.z1) / 2), zf.yaw); C(toWorld(zf, (l5.x0 + l5.x1) / 2, l5.y, (l5.z0 + l5.z1) / 2), zf.yaw);
  C(toWorld(HUT.frame, -1.0, HUT.h + HUT.roofT, 0), HUT.frame.yaw);
  L(at(LH.galleryDoorA - 1.4, 4.4, LH.top)); L(toWorld(cf, 0.5, COT_EAVE, 1.0));
  L(toWorld(cf, -2.2, PORCH.y, COT.D / 2 + 1.3)); L(toWorld(cf, -12, 0, 8)); L(toWorld(cf, 8, 0, 9));
  L([STAIR_HEAD[0], STAIR_HEAD[1], STAIR_HEAD[2]]);
  { const l1 = LANDINGS[1]; L(toWorld(zf, (l1.x0 + l1.x1) / 2, l1.y, (l1.z0 + l1.z1) / 2)); }
  { const l4 = LANDINGS[Math.min(4, LANDINGS.length - 1)]; L(toWorld(zf, (l4.x0 + l4.x1) / 2, l4.y, (l4.z0 + l4.z1) / 2)); }
  L([-600, PLATEAU_Y, 470]); L([-570, PLATEAU_Y, 490]); L([-620, PLATEAU_Y, 455]); L([-585, PLATEAU_Y, 440]);
  const spots = { chests, floor };
  for (const layout of COT_INTERIOR) { spots.chests.push(...layout.loot.chests); spots.floor.push(...layout.loot.floor); }
  addKitLoot(spots, INTERIOR_ROOMS.filter(r => !r.id?.startsWith("keeper-cottage")), interiorLoot);
  // the signal hut on the open plateau
  // (30 m from the POI centre, the only building out there) holds the VAULT — loot-spots makes the first listed chest
  // standing in a room the POI's always-live vault-rarity chest. The lantern gallery stays the always-live sniper payoff.
  const hut = interiorLoot(INTERIOR_ROOMS.filter(r => r.id === "signal-hut")).chests[0];
  if (hut) { const i = spots.chests.findIndex((c) => c[0] === hut[0] && c[2] === hut[2]); if (i >= 0) spots.chests.splice(i, 1); spots.chests.unshift(hut); }
  return spots;
})();

/** areas vegetation / random scatter must leave clear (the POI dresses them itself). Circles or yaw-rotated rects
 *  (veg rect yaw = the OPPOSITE sense of three's rotation.y). */
export const clearings: Clearing[] = [
  // the whole plateau top is an open lawn (yard, lawn and a few palms — no jungle behind the tower); the
  // POI dresses it itself (palms, ferns, grass tufts, flowers) in client/src/world/pois/lookout-point/index.ts
  { x: PAD.x, z: PAD.z, r: 92 },
  { x: LH.x, z: LH.z, r: 9 },
  { x: COT.frame.x, z: COT.frame.z, r: 11 },
  ...MASTS.map(([x, , z]) => ({ x, z, r: 2.5 })),
  { x: TRUCK[0], z: TRUCK[2], r: 4 },
  ...PICNIC.map(([x, , z]) => ({ x, z, r: 2.5 })),
  { x: WINDSOCK[0], z: WINDSOCK[2], r: 2 },
  // every cliff column (the veg scatter would grow trees up through the caps) + the stair zone
  ...COLUMNS.map((c) => { const m = toWorld(F(c.x, 0, c.z, c.yaw), 0, 0, (c.zin + c.zout) / 2); return { x: m[0], z: m[2], hx: c.w / 2 + 0.6, hz: (c.zout - c.zin) / 2 + 1.5, yaw: -c.yaw }; }),
  (() => { const m = toWorld(ZONE_F, 0, 0, -1); return { x: m[0], z: m[2], hx: ZONE.HZ + 2, hz: 6, yaw: -ZONE.yaw }; })(),
  // keep the yard between the buildings and the fence open
  (() => { const m = toWorld(COT.frame, -6, 0, 8); return { x: m[0], z: m[2], hx: 16, hz: 6, yaw: -COT.frame.yaw }; })(),
];
