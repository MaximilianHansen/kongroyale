// THE PLANTATION — shared layout + collision (client visuals AND the authoritative server derive from this file).
// A banana plantation on the flat SW plain (pad y=10, r=150): endless neat rows of banana plants with blue fruit bags
// (visual only — soft cover), the big red enterable packing house (tall gable block with a loft + long lower wing with
// a clerestory monitor, loading dock, upper balcony, inclined conveyor you can run up), BANANA CO. crate stacks, a
// yellow tractor + trailer, a timber water tower, worker cottages (enterable) and dirt roads that follow the island's
// path network through the pad. World metres; conventions in coast-kit.ts.
import type { Box } from "../world/colliders";
import { vegTrunkColliders, VARIANTS } from "../world/veg-scatter"; // only CALLED lazily (import cycle — see coast-kit lazyBoxes)
import { interiorColliders, interiorLoot, type InteriorRoom } from "./interior-kit";
import { panes, settleLoot } from "./pane-kit";
import { F, addKitLoot, bx, doorLeaves, floraColliders, inFrameRect, kitRoom, lazyBoxes, place, rng, settleFlora, stairs, toBoxes, toWorld, wall, type Clearing, type Flora, type Frame, type LootSpots, type Piece, type V3 } from "./coast-kit";
import * as dmath from "../sim/dmath";

export const PAD = { x: -230, z: 240, y: 10, r: 150 };
/** open glades at the pad's E rim (kept as open ground): [x, z, r] */
const GLADES: Array<[number, number, number]> = [[-92, 320, 34], [-62, 268, 34]];
const D2R = Math.PI / 180;

// ------------------------------------------------------------------------------------------------ roads
/** dirt roads (world XZ polylines, half-width) — they follow the terrain's path network through the pad */
// R1 stops at the hub; the packing house faces R1W so that road leads straight to it
export const ROADS: Array<{ pts: Array<[number, number]>; hw: number }> = [
  // narrow farm tracks (single-lane dirt roads with bananas at their verges); the SW track branches off R1W behind
  // the view camera instead of at the hub (a junction there would spread a dirt plaza across the view)
  { pts: [[-330, 190], [-230, 240], [-219, 240.6]], hw: 3.2 },
  { pts: [[-200, 130], [-222, 200], [-226, 236]], hw: 3.0 },
  { pts: [[-277, 216.5], [-300, 250], [-350, 330]], hw: 2.8 },
  // the farm track from the hub to the farmhouse veranda
  { pts: [[-231, 245], [-238, 262], [-245.5, 281]], hw: 2.4 },
];
/** distance from (x,z) to the nearest road centreline minus its half width (≤0 = on the road) */
export function roadDist(x: number, z: number): number {
  let best = Infinity;
  for (const r of ROADS) for (let i = 0; i + 1 < r.pts.length; i++) {
    const [ax, az] = r.pts[i], [bx2, bz] = r.pts[i + 1], dx = bx2 - ax, dz = bz - az, L2 = dx * dx + dz * dz;
    const u = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
    best = Math.min(best, dmath.hypot(x - ax - dx * u, z - az - dz * u) - r.hw);
  }
  return best;
}

// ------------------------------------------------------------------------------------------------ packing house
/**
 * Barn-local frame: origin = ground at the centre of the main gable (front) wall, +Z = front (the yard / the road),
 * +X = right. A tall red board-and-batten barn (x ±6, 26 m deep, eave 9, steep gable facing the yard, loft at 5.4)
 * with a long saltbox lean-to along its left side (x −16…−6, roof 7.2 → 4.8) under a clerestory strip, a two-level
 * porch across the main gable (ground dock + shed roof, upper loading deck at loft level with a railing and its own
 * roof) and an inclined truss conveyor rising across the lean-to front onto the upper deck (walkable ramp).
 */
export const BARN = {
  // the front gable faces straight down road R1W, the lean-to side N: a camera on that road (sun behind it) sees both
  // walls sunlit in a three-quarter view (front gable right, long wing + conveyor left)
  frame: F(-208.5, PAD.y, 247.2, -72 * D2R),
  t: 0.3, len: 26,
  main: { x0: -6, x1: 6, eave: 9.0, pitch: 40 * D2R, over: 0.7 },
  lean: { x0: -16, hi: 6.4, lo: 4.6, over: 0.6 },
  loft: 5.4,
  door: { x: 0.2, w: 4.4, h: 4.3 },           // big ground door in the main gable
  hatch: { x: -3.3, w: 3.6, y0: 5.4, h: 2.5 }, // upper loading hatch (conveyor delivers here)
  loftDoor: { x: 3.9, w: 1.6, h: 2.4 },        // upper deck → loft
  loftWin: { y0: 10.4, w: 1.7, h: 1.6 },       // gable loft window
  dock: { x0: 2.7, x1: 6.6, z1: 5.6, y: 1.2 },
  deck: { x0: -5.8, x1: 6.4, z1: 3.4 },        // upper deck at loft height
  shed: { x0: -3.0, x1: 6.6, z0: 3.3, z1: 6.4, y0: 5.05, y1: 4.35 }, // lower porch roof
  conv: { x0: -20.5, x1: -5.6, z: 2.3, y0: 0.45, y1: 5.7, w: 1.25 },
  stairX: 4.9,
};
/** lean-to ceiling: top y + thickness (barn-local) */
export const BARN_LEANCEIL = { y: 4.3, t: 0.15 };
export const barnRise = () => (BARN.main.x1 - BARN.main.x0) / 2 * dmath.tan(BARN.main.pitch);
/** lean-to roof height at local x (inner edge at the main wall) */
export const leanY = (x: number) => BARN.lean.lo + (BARN.lean.hi - BARN.lean.lo) * (x - BARN.lean.x0) / (BARN.main.x0 - BARN.lean.x0);

/** pitched railing collider following a line (frame-local) — bottom follows y0→y1, height h */
function railCol(x0: number, z0: number, y0: number, x1: number, z1: number, y1: number, h = 1.0): Piece {
  const L = dmath.hypot(x1 - x0, z1 - z0), yaw = dmath.atan2(x1 - x0, z1 - z0), pitch = -dmath.atan2(y1 - y0, L);
  return { k: "rail", c: [(x0 + x1) / 2, (y0 + y1) / 2 + h / 2, (z0 + z1) / 2], h: [0.05, h / 2, dmath.hypot(L, y1 - y0) / 2], yaw, pitch, col: true, noShoot: true, surf: "wood" };
}
const nr = (p: Piece): Piece => ({ ...p, k: "rail:new" }); // rails the client draws from the piece itself
/** gable roof slabs over x0..x1 (ridge along X at z=0), overhang o */
function gableRoof(k: string, x0: number, x1: number, hz: number, eave: number, pitch: number, o: number, th = 0.3, trimSide = 0): Piece[] {
  const out: Piece[] = [];
  const slope = (s: number, ov: number, extra: Partial<Piece>) => {
    const run = hz + ov, len = run / dmath.cos(pitch), cy = eave + (hz - run / 2) * dmath.tan(pitch);
    out.push({ k, c: [(x0 + x1) / 2, cy + th / 2, s * run / 2], h: [(x1 - x0) / 2 + o, th / 2, len / 2], pitch: s * pitch, surf: "metal", ...extra });
  };
  for (const s of [-1, 1]) {
    // `trimSide`: that slope's COLLIDER stops at the wall line (its drawn eave still overhangs) — over the lean-to
    // the collider overhang roofed a strip of the lean-to roof, which the scanner then read as a jump-only covered floor
    if (s === trimSide) { slope(s, o, { vis: true }); slope(s, 0, { col: true }); } else slope(s, o, {});
  }
  return out;
}
/** gable end infill as stacked collider strips (triangle above the eave) at x, spanning z ±hz */
function gableFill(k: string, x: number, hz: number, eave: number, pitch: number, t: number, holes: Array<[number, number, number, number]> = []): Piece[] {
  const out: Piece[] = [], n = 8, rise = hz * dmath.tan(pitch);
  // the strips are cut AT the hole edges (with 8 even strips a hole only opens the strips whose centre falls inside
  // it: the farmhouse attic windows [-0.5, 0.5] would open nothing and the barn loft window [-0.85, 0.85] 3 m of wall)
  const cuts = new Set<number>();
  for (let i = 0; i <= n; i++) cuts.add(-hz + (2 * hz * i) / n);
  for (const [a, b] of holes) for (const v of [a, b]) if (v > -hz && v < hz) cuts.add(v);
  const zs = [...cuts].sort((a, b) => a - b);
  for (let i = 0; i + 1 < zs.length; i++) {
    const z0 = zs[i], z1 = zs[i + 1], zt = Math.max(Math.abs(z0), Math.abs(z1));
    if (z1 - z0 < 1e-3) continue;
    const top = eave + rise * (1 - zt / hz);
    const zm = (z0 + z1) / 2;
    const hole = holes.find(([hz0, hz1]) => zm > hz0 && zm < hz1);
    if (hole) {
      if (hole[2] - eave > 0.05) out.push(bx(k, x - t / 2, eave, z0, x + t / 2, hole[2], z1, { col: true, surf: "wood" }));
      if (top - hole[3] > 0.05) out.push(bx(k, x - t / 2, hole[3], z0, x + t / 2, top, z1, { col: true, surf: "wood" }));
    } else if (top - eave > 0.05) out.push(bx(k, x - t / 2, eave, z0, x + t / 2, top, z1, { col: true, surf: "wood" }));
  }
  return out;
}
/** Z-running gable pieces (ridge along Z): built with ridge along X then turned 90° (local x → −z) */
const ZR = (z: number) => F(0, 0, z, Math.PI / 2);

/** barn window openings (u along the wall from the front, y0 over the 0.2 floor slab) — right wall + lean-to outer wall.
 *  y0 1.0 / loft + 0.8 over the slab = absolute 1.2 / loft + 1.0, where barn.ts draws the frames */
// the two ground windows sit at u 10.6 / 16.2, where both the inside loft stair and the outside roof stair pass > 4 m
// overhead, so they can be vaulted in and out.
const BARN_WIN_R = [{ u: 10.6, w: 1.4, y0: 1.0, h: 1.4 }, { u: 16.2, w: 1.4, y0: 1.0, h: 1.4 }, { u: 9, w: 1.4, y0: BARN.loft + 0.8, h: 1.4 }, { u: 17, w: 1.4, y0: BARN.loft + 0.8, h: 1.4 }];
const BARN_WIN_L = [{ u: 4.5, w: 1.6, y0: 1.0, h: 1.3 }, { u: 16, w: 1.6, y0: 1.0, h: 1.3 }, { u: 22, w: 1.6, y0: 1.0, h: 1.3 }];
function barn(): Piece[] {
  const B = BARN, { t, len } = B, Mn = B.main, Ln = B.lean, out: Piece[] = [];
  const zb = -len, hw = (Mn.x1 - Mn.x0) / 2;
  // floor slab (main + lean-to)
  out.push(bx("bn:floor", Ln.x0 - 0.3, -0.5, zb - 0.3, Mn.x1 + 0.3, 0.2, 0.3, { surf: "concrete" }));
  // ---- main barn: front gable wall (big door, loading hatch, loft door), back wall, right wall; left = clerestory
  out.push(...wall("bn:wall", Mn.x0, -t / 2, Mn.x1, -t / 2, 0.2, Mn.eave - 0.2, t, [
    { u: B.door.x - Mn.x0, w: B.door.w, y0: 0, h: B.door.h },
    { u: B.hatch.x - Mn.x0, w: B.hatch.w, y0: B.hatch.y0 - 0.2, h: B.hatch.h },
    { u: B.loftDoor.x - Mn.x0, w: B.loftDoor.w, y0: B.loft - 0.2, h: B.loftDoor.h },
  ], { surf: "wood" }));
  out.push(...wall("bn:wall", Mn.x1, zb + t / 2, Mn.x0, zb + t / 2, 0.2, Mn.eave - 0.2, t, [{ u: hw, w: 3.2, y0: 0, h: 3.4 }, { u: 3, w: 1.3, y0: B.loft + 1.0, h: 1.3 }], { surf: "wood" }));
  out.push(...wall("bn:wall", Mn.x1 - t / 2, 0, Mn.x1 - t / 2, zb, 0.2, Mn.eave - 0.2, t, [
    ...BARN_WIN_R, { u: 13, w: 2.4, y0: 0, h: 3.0 },
  ], { surf: "wood" }));
  // breakable panes in the side windows + the loft window (barn.ts draws their glass at these planes)
  out.push(...panes("bn:pane", Mn.x1 - t / 2, 0, Mn.x1 - t / 2, zb, 0.2, BARN_WIN_R, 0.03), ...panes("bn:pane", Ln.x0 + t / 2, 0, Ln.x0 + t / 2, zb, 0.2, BARN_WIN_L, -0.03));
  out.push({ k: "bn:pane", c: [0, B.loftWin.y0 + B.loftWin.h / 2, -0.25], h: [B.loftWin.w / 2, B.loftWin.h / 2, 0.03], col: true, noShoot: true, surf: "glass" });
  // left (clerestory) wall above the lean-to roof, posts below it (the lean-to is open to the main floor)
  out.push(bx("bn:clere", Mn.x0 - t / 2, Ln.hi - 0.1, zb, Mn.x0 + t / 2, Mn.eave, 0, { surf: "wood" }));
  for (const z of [-4.5, -10.5, -16.5, -22]) out.push(bx("bn:post", Mn.x0 - 0.18, 0.2, z - 0.18, Mn.x0 + 0.18, Ln.hi - 0.1, z + 0.18, { surf: "wood" }));
  // gables (front with the loft window hole, back), main roof (ridge along Z)
  const W2 = B.loftWin;
  out.push(...place(ZR(-t / 2), gableFill("bn:gable", 0, hw, Mn.eave, Mn.pitch, t, [[-W2.w / 2, W2.w / 2, W2.y0, W2.y0 + W2.h]])));
  out.push(...place(ZR(zb + t / 2), gableFill("bn:gable", 0, hw, Mn.eave, Mn.pitch, t)));
  out.push(...place(ZR(0), gableRoof("bn:roofM", -0.4, len + 0.4, hw, Mn.eave, Mn.pitch, Mn.over, 0.3, -1)));
  // ---- lean-to: outer wall (door + windows), front + back walls with sloped tops (strips), single-slope roof
  const Lh = Ln.lo;
  out.push(...wall("bn:wall", Ln.x0 + t / 2, 0, Ln.x0 + t / 2, zb, 0.2, Lh - 0.2, t, [
    ...BARN_WIN_L, { u: 10, w: 3.4, y0: 0, h: 3.4 },
  ], { surf: "wood" }));
  const leanEnd = (z: number, doorAt: number | null) => {
    const n = 10;
    for (let i = 0; i < n; i++) {
      const x0 = Ln.x0 + (Mn.x0 - Ln.x0) * i / n, x1 = Ln.x0 + (Mn.x0 - Ln.x0) * (i + 1) / n, xm = (x0 + x1) / 2;
      const top = leanY(Math.min(x0, x1)) - 0.05;
      const y0 = doorAt !== null && Math.abs(xm - doorAt) < 1.5 ? 3.2 : 0.2;
      out.push(bx("bn:leanEnd", x0, y0, z - t / 2, x1, top, z + t / 2, { surf: "wood", vis: false, col: true }));
    }
  };
  leanEnd(-t / 2, -11.8);
  leanEnd(zb + t / 2, null);
  {
    const run = Mn.x0 - Ln.x0 + Ln.over, rise = (Ln.hi - Ln.lo) * run / (Mn.x0 - Ln.x0), ang = dmath.atan2(rise, run), L = dmath.hypot(run, rise);
    // (with yaw π/2 the length goes in h.x: h [L/2, 0.12, len/2] would run the 27 m length ACROSS the barn)
    out.push({ k: "bn:roofL", c: [Mn.x0 - run / 2, Ln.hi - rise / 2 + 0.15, zb / 2], h: [len / 2 + 0.5, 0.12, L / 2], yaw: Math.PI / 2, pitch: -ang, surf: "metal" });
  }
  // a boarded ceiling under the lean-to roof (packing-line storage above it). The void between the ceiling and the
  // pitched roof is filled solid (no crawl pocket), its face toward the main barn is a planked knee wall under the
  // clerestory. The ceiling is what makes the lean-to a roofed room for the loot generator (the stepped pitched roof
  // strips are each < 1.6 m wide: no ceiling at all to the scan)
  {
    const LC = BARN_LEANCEIL;
    out.push(bx("bn:leanCeil", Ln.x0 + t, LC.y - LC.t, zb + t, Mn.x0 - 0.15, LC.y, -t, { surf: "wood" }));
    out.push(bx("bn:leanKnee", Mn.x0 - 0.15, LC.y, zb + t, Mn.x0 + 0.12, Ln.hi - 0.1, -t, { surf: "wood" }));
    const nF = 10;
    for (let i = 0; i < nF; i++) {
      const x0 = Ln.x0 + t + (Mn.x0 - 0.15 - Ln.x0 - t) * i / nF, x1 = Ln.x0 + t + (Mn.x0 - 0.15 - Ln.x0 - t) * (i + 1) / nF, top = leanY(x0) - 0.3;
      if (top > LC.y + 0.05) out.push(bx("bn:leanFill", x0, LC.y, zb + t, x1, top, -t, { col: true, surf: "wood" }));
    }
  }
  // ---- loft (hole over the stair along the right wall), inside stair ground → loft, guard rails
  const sx = B.stairX, sw = 1.3, nS = 17, runS = 7.0 / nS, zs0 = -2.6, zs1 = zs0 - 7.0;
  out.push(bx("bn:loft", Mn.x0 + 0.15, B.loft - 0.3, zb + t, sx - sw / 2 - 0.1, B.loft, -t));
  // (the loft floor meets the top tread — a 0.3 m gap there would leave the stair without a landing)
  out.push(bx("bn:loft", sx - sw / 2 - 0.1, B.loft - 0.3, zb + t, Mn.x1 - t, B.loft, zs1));
  out.push(bx("bn:loft", sx - sw / 2 - 0.1, B.loft - 0.3, zs0 + 0.2, Mn.x1 - t, B.loft, -t));
  out.push(...stairs("bn:step", sx, zs0, 0.2, Math.PI, sw, (B.loft - 0.2) / nS, runS, nS, { surf: "wood" }));
  out.push(railCol(sx - sw / 2 - 0.1, zs0, B.loft, sx - sw / 2 - 0.1, zs1 - 0.3, B.loft, 1.0));
  out.push(railCol(Mn.x0 + 0.2, zb + 0.5, B.loft, Mn.x0 + 0.2, -0.5, B.loft, 1.05)); // loft edge over the lean-to
  // the loft door's open leaf on the upper deck (client barn.ts draws it at exactly this box)
  { const LD = B.loftDoor; out.push({ k: "bn:loftLeaf", c: [LD.x + LD.w / 2 + 0.15, B.loft + LD.h / 2, 0.55], h: [(LD.w - 0.05) / 2, (LD.h - 0.05) / 2, 0.04], yaw: 1.25, col: true, surf: "wood" }); }
  // ---- porch: ground dock (right) + steps, upper loading deck at loft height on posts, railing, lower shed roof
  const D = B.dock, Dk = B.deck, Sh = B.shed;
  out.push(bx("bn:dock", D.x0, 0, 0, D.x1, D.y, D.z1, { surf: "wood" }));
  out.push(...stairs("bn:dstep", D.x0 + 1.4, D.z1, 0, 0, 2.2, D.y / 4, 0.3, 4, { surf: "wood" }));
  out.push(bx("bn:deck", Dk.x0, B.loft - 0.25, 0, Dk.x1, B.loft, Dk.z1, { surf: "wood" }));
  for (const x of [Dk.x0 + 0.2, -1.2, 2.6, Dk.x1 - 0.2]) {
    const y0 = x > D.x0 ? D.y : 0;
    out.push(bx("bn:post", x - 0.14, y0, Dk.z1 - 0.34, x + 0.14, B.loft - 0.25, Dk.z1 - 0.06, { surf: "wood", col: true }));
  }
  out.push(railCol(B.conv.x1 + 1.3, Dk.z1 - 0.06, B.loft, Dk.x1, Dk.z1 - 0.06, B.loft, 1.05), railCol(Dk.x1 - 0.06, 0, B.loft, Dk.x1 - 0.06, Dk.z1, B.loft, 1.05));
  out.push(railCol(Dk.x0 + 0.06, 0, B.loft, Dk.x0 + 0.06, B.conv.z - B.conv.w / 2 - 0.05, B.loft, 1.05));
  {
    const run = Sh.z1 - Sh.z0, ang = dmath.atan2(Sh.y0 - Sh.y1, run), L = dmath.hypot(run, Sh.y0 - Sh.y1);
    out.push({ k: "bn:shed", c: [(Sh.x0 + Sh.x1) / 2, (Sh.y0 + Sh.y1) / 2, (Sh.z0 + Sh.z1) / 2], h: [(Sh.x1 - Sh.x0) / 2, 0.08, L / 2], pitch: ang, surf: "metal" });
    for (const x of [Sh.x0 + 0.2, 1.4, Sh.x1 - 0.2]) { const y0 = x > D.x0 ? D.y : 0; out.push(bx("bn:post", x - 0.12, y0, Sh.z1 - 0.35, x + 0.12, Sh.y1, Sh.z1 - 0.11, { surf: "wood", col: true })); }
  }
  // the conveyor: a truss ramp from the yard up onto the upper deck (walkable, ~20°), side rails
  const C = B.conv, L = C.x1 - C.x0, rise = C.y1 - C.y0, ang = dmath.atan2(rise, L);
  out.push({ k: "bn:conv", c: [(C.x0 + C.x1) / 2, (C.y0 + C.y1) / 2 - 0.12, C.z], h: [C.w / 2, 0.12, dmath.hypot(L, rise) / 2], yaw: Math.PI / 2, pitch: -ang, surf: "metal" });
  out.push(railCol(C.x0, C.z + C.w / 2, C.y0, C.x1, C.z + C.w / 2, C.y1, 0.5), railCol(C.x0, C.z - C.w / 2, C.y0, C.x1, C.z - C.w / 2, C.y1, 0.5));
  // crate stacks on pallets in the yard + on the dock (cover)
  for (const [x0, z0, x1, z1, h, y] of CRATE_STACKS) out.push(bx("crates", x0, y, z0, x1, y + h, z1, { col: true, surf: "wood" }));
  // interior: the packing line + loft dressing as COVER — every entry is drawn at exactly this size by
  // client/src/world/pois/the-plantation/barn.ts. Tall pieces come as walk-up staircases (0.5 / 1.0 / 1.5 m) so no
  // covered top is a jump-only floor; tables and tanks are ≤ 0.55 m (the heaps of fruit on them are soft dressing)
  for (const [x0, z0, x1, z1, h, k, y0 = 0.2] of BARN_COVER) out.push(bx(k, x0, y0, z0, x1, y0 + h, z1, { col: true, surf: k === "bn:tank" ? "metal" : k === "bn:hay" ? "grass" : "wood" }));
  // roof access: a two-flight steel stair up the right (+x) wall, outside the
  // eave overhang, landing level with the roof edge — the whole main roof (and the lean-to below it) is then a height
  // level you can walk to
  {
    const R = BARN_ROOFSTAIR, x0 = R.x, x1 = R.x + R.w, xc = (x0 + x1) / 2;
    const n1 = R.n1, r1 = R.mid / n1, run1 = (R.zMid0 - R.z0) / n1;
    out.push(...stairs("bn:rstep", xc, R.z0, 0, 0, R.w, r1, run1, n1, { surf: "metal" }));
    out.push(bx("bn:rland", x0, R.mid - 0.25, R.zMid0, x1, R.mid, R.zMid1, { surf: "metal" }));
    const n2 = R.n2, r2 = (R.top - R.mid) / n2, run2 = (R.zTop0 - R.zMid1) / n2;
    out.push(...stairs("bn:rstep", xc, R.zMid1, R.mid, 0, R.w, r2, run2, n2, { surf: "metal" }));
    out.push(bx("bn:rland", Mn.x1 + Mn.over - 0.05, R.top - 0.25, R.zTop0, x1, R.top, R.zTop1, { surf: "metal" }));
    out.push(nr(railCol(x1 - 0.05, R.z0, r1, x1 - 0.05, R.zMid0, R.mid)), nr(railCol(x1 - 0.05, R.zMid0, R.mid, x1 - 0.05, R.zMid1, R.mid)));
    out.push(nr(railCol(x1 - 0.05, R.zMid1, R.mid, x1 - 0.05, R.zTop0, R.top)), nr(railCol(x1 - 0.05, R.zTop0, R.top, x1 - 0.05, R.zTop1, R.top)));
    out.push(nr(railCol(Mn.x1 + Mn.over, R.zTop1 - 0.05, R.top, x1, R.zTop1 - 0.05, R.top)));
  }
  return out;
}
/** barn roof stair (barn-local): lane x … x + w outside the right wall, flight 1 z0 → zMid0 (0 → mid), landing,
 *  flight 2 zMid1 → zTop0 (mid → top), top landing zTop0 … zTop1 reaching in to the roof edge */
export const BARN_ROOFSTAIR = { x: 6.95, w: 1.2, z0: -25.2, zMid0: -18.6, zMid1: -17.4, zTop0: -10.8, zTop1: -9.6, mid: 4.4, top: 8.75, n1: 15, n2: 15 };
/** barn interior cover (barn-local): [x0, z0, x1, z1, height, kind, base y (default the 0.2 floor)] */
export const BARN_COVER: Array<[number, number, number, number, number, string, number?]> = [
  // lean-to packing line: four sorting tables (0.75 m tops), crate staircase at the back, a pallet stack + step
  [-14.0, -20.0, -12.4, -13.6, 0.55, "bn:table"], [-14.0, -12.4, -12.4, -6.0, 0.55, "bn:table"],
  [-9.8, -20.0, -8.2, -13.6, 0.55, "bn:table"], [-9.8, -12.4, -8.2, -6.0, 0.55, "bn:table"],
  [-15.6, -24.9, -14.4, -23.7, 1.5, "crates"], [-14.4, -24.9, -13.2, -23.7, 1.0, "crates"], [-13.2, -24.9, -12.0, -23.7, 0.5, "crates"],
  [-11.6, -17.2, -10.4, -16.0, 1.0, "crates"], [-11.6, -16.0, -10.4, -15.2, 0.5, "crates"],
  // main floor: two galvanised washing troughs, field bins (staircase), crate staircase by the back door, scale desk
  [-3.95, -17.5, -2.45, -8.5, 0.55, "bn:tank"], [0.45, -17.5, 1.95, -8.5, 0.55, "bn:tank"],
  [1.5, -22.6, 3.3, -20.6, 1.0, "bn:bins"], [3.3, -22.6, 5.2, -20.6, 0.5, "bn:bins"],
  [-5.6, -24.9, -4.4, -23.7, 1.5, "crates"], [-4.4, -24.9, -3.2, -23.7, 1.0, "crates"], [-3.2, -24.9, -2.0, -23.7, 0.5, "crates"],
  [-5.0, -2.6, -3.4, -1.8, 0.85, "bn:desk"], [-3.95, -2.55, -3.5, -2.3, 1.0, "bn:scalehead", 1.05],
  // loft (5.4): hay-bale staircases + a bale wall across the middle, crates at the back
  [-5.5, -4.2, -4.3, -3.0, 0.5, "bn:hay", 5.4], [-5.5, -5.4, -4.3, -4.2, 1.0, "bn:hay", 5.4], [-5.5, -6.6, -4.3, -5.4, 1.5, "bn:hay", 5.4],
  [-3.0, -13.6, 1.0, -12.4, 1.0, "bn:hay", 5.4], [1.0, -13.6, 2.2, -12.4, 0.5, "bn:hay", 5.4],
  [2.0, -24.9, 3.2, -23.7, 0.5, "crates", 5.4], [3.2, -24.9, 4.4, -23.7, 1.0, "crates", 5.4], [4.4, -24.9, 5.6, -23.7, 1.5, "crates", 5.4],
  [-5.5, -24.9, -4.3, -22.5, 1.0, "bn:hay", 5.4], [-5.5, -22.5, -4.3, -21.7, 0.5, "bn:hay", 5.4],
  [2.4, -17.2, 3.6, -16.0, 1.0, "bn:hay", 5.4], [2.4, -16.0, 3.6, -15.2, 0.5, "bn:hay", 5.4],
];
/** crate stacks (barn-local): x0, z0, x1, z1, height, base y */
export const CRATE_STACKS: Array<[number, number, number, number, number, number]> = [
  [-21.4, 3.8, -18.8, 5.6, 1.7, 0], [-17.2, 4.4, -14.6, 6.2, 0.85, 0], [-12.6, 3.6, -9.8, 5.4, 1.7, 0], [-8.0, 4.8, -5.2, 6.6, 0.85, 0],
  [-3.0, 7.4, 1.0, 9.4, 0.85, 0], [3.2, 2.2, 6.2, 4.2, 0.85, 1.2], [3.6, 4.2, 5.0, 4.75, 0.45, 1.2], [4.2, 7.8, 7.2, 9.6, 1.7, 0], [9.0, 5.0, 11.6, 6.8, 0.85, 0],
];
export const BARN_LOCAL: Piece[] = barn();

// ------------------------------------------------------------------------------------------------ yard, water tower, cottages
/** the view camera: ON the west road R1 (it leaves the hub toward WNW), ~30 m out from the hub / 55 m from the packing
 *  house's front gable — the road leads between banana rows (3–10 m each side) to the house; the midday
 *  sun (NNW) falls from behind-left */
const HUB: [number, number] = [-230, 240], R1W: [number, number] = [-0.894, -0.447];
export const roadPt = (t: number, side = 0): [number, number] => [HUB[0] + R1W[0] * t + R1W[1] * side, HUB[1] + R1W[1] * t - R1W[0] * side];
// far enough back and high enough to look OVER the canopy (bagged plants to the far rows, the cottages on the left,
// the house centre) — a 5 m eye stands inside the crowns of the first plants
export const VIEW_SPOT: [number, number] = roadPt(34, 0.3);
/** water tower (world x, z) + dims — right-rear of the packing house as seen from the road */
export const WTOWER = { x: -224, z: 262, legH: 8.2, legSpread: 2.6, tankR: 2.6, tankH: 4.2, yaw: 0.3 };
/** floodlight pole (world) */
export const FLOOD: [number, number, number] = (() => { const p = toWorld(BARN.frame, 8.6, 0, 3.2); return [p[0], p[2], 2.6]; })();
/** tractor + trailer (world x, z, yaw with local +X = forward): parked on the LEFT verge of the camera road ~15 m
 *  ahead, nosing toward the road */
export const TRACTOR: [number, number, number] = (() => { const p = roadPt(18, -6.4); return [p[0], p[1], -2.6]; })();
/** big roadside crates (world x, z, yaw) — on the RIGHT verge of the camera road (right foreground) */
export const ROADSIDE_CRATES: Array<[number, number, number]> = [[20.2, 6.6, 0.2], [22.1, 6.8, 0.05], [21.1, 6.7, 0.12]].map(([t, sd, y]) => { const p = roadPt(t, sd); return [p[0], p[1], 2.68 + y] as [number, number, number]; });
/** yard dressing in the BARN frame (breaks up the flat open yard): a second vehicle
 *  (farm pickup), stacked empty pallets, a wheelbarrow, a puddle, sacks — [x, z, yaw] */
/** cover rhythm: BANANA CO. harvest crates on pallets along the three field roads — a pair of hard cover
 *  spots every ~28 m, alternating verges (otherwise the roads are 100 m+ open dirt lanes between the rows) — [x, z, yaw];
 *  every other one carries a designed chest beside it (FIELD_CHESTS): loot where a picker would stack it */
export const FIELD_CRATES: Array<[number, number, number]> = (() => {
  const out: Array<[number, number, number]> = [];
  const avoid: Array<[number, number, number]> = [[TRACTOR[0], TRACTOR[1], 12], ...ROADSIDE_CRATES.map(([x, z]) => [x, z, 12] as [number, number, number])];
  for (const [ri, road] of ROADS.slice(0, 3).entries()) {
    const pts = road.pts, total = pts.slice(1).reduce((a, p, i) => a + dmath.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);
    let side = ri % 2 ? 1 : -1;
    for (let d = 14; d < total - 24; d += 28) {
      let rem = d, i = 0;
      while (i + 1 < pts.length && rem > dmath.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1])) { rem -= dmath.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]); i++; }
      if (i + 1 >= pts.length) break;
      const [ax, az] = pts[i], [bx2, bz] = pts[i + 1], L = dmath.hypot(bx2 - ax, bz - az), ux = (bx2 - ax) / L, uz = (bz - az) / L;
      const off = road.hw + 1.7, x = ax + ux * rem - uz * off * side, z = az + uz * rem + ux * off * side;
      side = -side;
      if (dmath.hypot(x - PAD.x, z - PAD.z) > PAD.r - 8 || avoid.some(([qx, qz, r]) => dmath.hypot(x - qx, z - qz) < r)) continue;
      if (roadDist(x, z) < 0.6) continue;
      out.push([+x.toFixed(2), +z.toFixed(2), +(dmath.atan2(ux, uz) + Math.PI / 2).toFixed(3)]); // (long side along the road)
    }
  }
  return out;
})();
/** a designed chest beside every other field crate pair, on the road side (world [x, z, yaw]) */
export const FIELD_CHESTS: Array<[number, number, number]> = FIELD_CRATES.filter((_, i) => i % 2 === 0).map(([x, z, yaw]) => {
  const a = yaw - Math.PI / 2, ux = dmath.sin(a), uz = dmath.cos(a); // along the road
  return [+(x + ux * 2.4).toFixed(2), +(z + uz * 2.4).toFixed(2), +a.toFixed(3)] as [number, number, number];
});
export const YARD_PICKUP: [number, number, number] = [11.2, 12.4, 1.25];
export const YARD_PALLETS: Array<[number, number, number, number]> = [[2.2, 13.6, 0.3, 5], [0.4, 15.0, -0.2, 3], [7.2, 16.2, 0.8, 4]];
export const YARD_PUDDLES: Array<[number, number, number, number]> = [[-2.5, 15.5, 2.4, 1.3], [3.8, 11, 1.4, 0.9]];
/** worker cottages: world frames (+Z = front door toward the road) + roof colour index — a row along the N side of
 *  road R1 east of the packing house (left background of the view), one across the road */
export const COTTAGES: Array<{ f: Frame; roof: number }> = [
  // three in the left background of the view (behind the rows, N of the packing house), facing the road
  { f: F(-176, PAD.y, 216.5, -83 * D2R), roof: 0 },
  { f: F(-158, PAD.y, 213, -80 * D2R), roof: 1 },
  { f: F(-166, PAD.y, 200, -76 * D2R), roof: 0 },
  { f: F(-131, PAD.y, 275, -26.6 * D2R), roof: 1 },
  { f: F(-152, PAD.y, 294, 153.4 * D2R), roof: 0 },
];
// 8.0 × 6.4: a smaller furnished room (6 × 4.8) leaves the loot generator only 4–10 standable cells, not a room
export const COT = { w: 8.0, d: 6.4, h: 3.0, pitch: 24 * D2R, doorX: 1.4 };
export const COT_SWING = -1.25;
/** interiors-kit seeds per cottage (picked so the furnished room stays one open room: ≥ 8 standable cells) */
export const COT_SEEDS = [610, 617, 624, 631, 638];

function cottage(): Piece[] {
  const { w, d, h, pitch } = COT, hw = w / 2, hd = d / 2, t = 0.2, out: Piece[] = [];
  out.push(bx("ct:floor", -hw - 0.2, -0.4, -hd - 0.2, hw + 0.2, 0.45, hd + 0.2, { surf: "wood" }));
  out.push(...wall("ct:wall", -hw, hd - t / 2, hw, hd - t / 2, 0.45, h, t, [{ u: hw + COT.doorX, w: 1.2, y0: 0, h: 2.35 }, { u: 1.3, w: 1.1, y0: 0.9, h: 1.0 }], { surf: "wood" }));
  out.push(...wall("ct:wall", hw, -hd + t / 2, -hw, -hd + t / 2, 0.45, h, t, [{ u: w / 2, w: 1.1, y0: 0.9, h: 1.0 }], { surf: "wood" }));
  out.push(...wall("ct:wall", -hw + t / 2, -hd + t, -hw + t / 2, hd - t, 0.45, h, t, [{ u: d / 2 - t, w: 0.9, y0: 1.0, h: 0.9 }], { surf: "wood" }));
  out.push(...wall("ct:wall", hw - t / 2, hd - t, hw - t / 2, -hd + t, 0.45, h, t, [], { surf: "wood" }));
  // breakable glass in the three windows (yard.ts win() draws it 4 cm inside the outer face)
  out.push(...panes("ct:pane", -hw, hd - t / 2, hw, hd - t / 2, 0.45, [{ u: 1.3, w: 1.1, y0: 0.9, h: 1.0 }], 0.06));
  out.push(...panes("ct:pane", hw, -hd + t / 2, -hw, -hd + t / 2, 0.45, [{ u: w / 2, w: 1.1, y0: 0.9, h: 1.0 }], 0.06));
  out.push(...panes("ct:pane", -hw + t / 2, -hd + t, -hw + t / 2, hd - t, 0.45, [{ u: d / 2 - t, w: 0.9, y0: 1.0, h: 0.9 }], 0.06));
  // gable roof: ridge along X; porch step
  const run = hd + 0.5, len = run / dmath.cos(pitch), eave = 0.45 + h, cy = eave + (hd - run / 2) * dmath.tan(pitch);
  for (const s of [-1, 1]) out.push({ k: "ct:roof", c: [0, cy + 0.06, s * run / 2], h: [hw + 0.45, 0.06, len / 2], pitch: s * pitch, surf: "metal" });
  out.push(...gableFill("ct:gable", -hw + t / 2, hd, eave, pitch, t), ...gableFill("ct:gable", hw - t / 2, hd, eave, pitch, t));
  out.push(bx("ct:step", COT.doorX - 0.8, 0, hd, COT.doorX + 0.8, 0.22, hd + 0.6, { surf: "wood" }));
  // the porch awning's two posts (client yard.ts: 0.12 m, 2.5 m tall at doorX ± 1.3, 1.6 m out) — solid
  for (const x of [COT.doorX - 1.3, COT.doorX + 1.3]) out.push(bx("ct:post", x - 0.06, 0, hd + 1.54, x + 0.06, 2.5, hd + 1.66, { col: true, surf: "wood" }));
  // a boarded ceiling at the eave (1.1 m under the ridge — no one stands up there) and furniture that is cover, all
  // drawn at exactly these sizes (yard.ts); the ceiling runs over the wall tops so the loot generator's roofed cells
  // reach the walls
  out.push(bx("ct:ceil", -hw, eave - 0.12, -hd, hw, eave + 0.04, hd, { surf: "wood" }));
  out.push(...doorLeaves("ct:leaf", -hw, hd - t / 2, hw, hd - t / 2, 0.45, [{ u: hw + COT.doorX, w: 1.2, y0: 0, h: 2.35 }], t, COT_SWING));
  // (the room is furnished by the shared interiors kit — INTERIOR_ROOMS below)
  // the roof route (parkour): a rain barrel → the woodshed's roof → the cottage eave by its gable end
  for (const [x0, z0, x1, z1, h, k] of COT_OUT) out.push(bx(k, x0, 0, z0, x1, h, z1, { col: true, surf: k === "ct:barrel" ? "metal" : "wood" }));
  return out;
}
/** outside the right gable (cottage-local, from the ground): rain barrel + firewood shed */
export const COT_OUT: Array<[number, number, number, number, number, string]> = [
  [4.3, -1.9, 5.1, -1.1, 1.05, "ct:barrel"], [4.25, -0.8, 5.45, 1.5, 2.1, "ct:woodshed"],
];
export const COT_LOCAL: Piece[] = cottage();

// ------------------------------------------------------------------------------------------------ farmhouse
/**
 * The planter's farmhouse: a two-storey timber house on a stone plinth among the
 * rows S of the hub, a full-width veranda whose roof is the first floor's balcony, an attic under a 40° roof.
 * Farmhouse-local frame: origin = ground at the centre, +Z = front (veranda, facing the hub), +X = right.
 * Ground floor 0.6 (living room left, kitchen right, fireplace + chimney on the right gable), straight solid stair
 * along the back wall to the first floor 3.9 (two bedrooms either side of a partition), a steep stair in the right
 * room up through a hatch to the attic 7.0 (knee walls at |z| = 1.75 keep everyone where the roof leaves headroom).
 */
export const FARM = {
  frame: F(-250, PAD.y, 292, 2.775),
  hx: 6, hz: 4.5, t: 0.3, f0: 0.6, f1: 3.9, f2: 7.0, eave: 7.0, pitch: 40 * D2R, over: 0.5,
  porch: 2.5, knee: 2.95, // knee walls where the roof leaves < 1.3 m behind them (1.75 would seal a crouch pocket)
  // the foot stands 1 m off the gable wall (a turning pocket you walk into), 16 risers over 4.4 m: a flight starting AT
  // the wall has no standing room on its first treads, so the walk graph never reaches it and the upper storeys seal
  stair1: { x0: -4.7, x1: -0.3, z0: -4.05, z1: -2.85, n: 16 },
  // the attic stair runs along the partition, climbing +z (clear of the right bedroom, its foot reachable); 16 risers
  // over 4.4 m — at 41° the walk scan finds the attic a trap (reachable, no way back)
  stair2: { x0: 1.0, x1: 2.2, z0: -3.4, z1: 1.0, n: 16 },
  chimney: { x0: 4.7, x1: 5.7, z0: 2.3, z1: 3.3, top: 11.4 },
};
/** door-leaf swing per wall [front, back] — client dress.ts draws the leaves with these */
export const FARM_SWING: [number, number] = [-1.3, -3.02];
export const FARM_OPEN = {
  front0: [{ u: 2.5, w: 1.3, y0: 0.9, h: 1.5 }, { u: 6, w: 1.4, y0: 0, h: 2.5 }, { u: 9.5, w: 1.3, y0: 0.9, h: 1.5 }],
  back0: [{ u: 3.5, w: 1.2, y0: 0, h: 2.4 }, { u: 8.0, w: 1.2, y0: 0.9, h: 1.4 }, { u: 10.5, w: 1.1, y0: 0.9, h: 1.4 }],
  right0: [{ u: 6.3, w: 1.2, y0: 0.9, h: 1.4 }],
  left0: [{ u: 4.5, w: 1.3, y0: 0.9, h: 1.5 }],
  front1: [{ u: 2.5, w: 1.2, y0: 0.8, h: 1.4 }, { u: 6, w: 1.2, y0: 0, h: 2.3 }, { u: 9.5, w: 1.2, y0: 0.8, h: 1.4 }],
  back1: [{ u: 2.5, w: 1.1, y0: 0.9, h: 1.3 }, { u: 6, w: 1.1, y0: 0.9, h: 1.3 }, { u: 9.5, w: 1.1, y0: 0.9, h: 1.3 }],
  right1: [{ u: 3.5, w: 1.1, y0: 0.9, h: 1.3 }],
  left1: [{ u: 4.5, w: 1.1, y0: 0.9, h: 1.3 }],
};
/** farmhouse furniture (farmhouse-local): [x0, z0, x1, z1, height, kind, base y] */
export const FARM_FURN: Array<[number, number, number, number, number, string, number]> = [
  // (the ground floor + both bedrooms are furnished by the shared interiors kit — INTERIOR_ROOMS)
  // attic: crate staircase + an old trunk
  [-5.5, -1.3, -4.3, -0.1, 1.0, "fh:crate", 7.0], [-4.3, -1.3, -3.5, -0.1, 0.5, "fh:crate", 7.0], [-2.6, 0.3, -1.5, 1.2, 0.55, "fh:trunk", 7.0],
];

function farmhouse(): Piece[] {
  const H = FARM, { hx, hz, t, f0, f1, f2 } = H, out: Piece[] = [], o = (a: Array<{ u: number; w: number; y0: number; h: number }>) => a.map((q) => ({ ...q }));
  const S1 = H.stair1, S2 = H.stair2, C = H.chimney;
  // plinth + ground floor, veranda deck, steps (front + back door)
  out.push(bx("fh:floor", -hx, -0.4, -hz, hx, f0, hz, { surf: "wood" }));
  out.push(bx("fh:porch", -hx, -0.4, hz, hx, f0, hz + H.porch, { surf: "wood" }));
  out.push(...stairs("fh:pstep", 0, hz + H.porch + 0.9, 0, Math.PI, 2.6, 0.2, 0.3, 3, { surf: "wood", ramp: false }));
  out.push(...stairs("fh:pstep", hx - FARM_OPEN.back0[0].u, -hz - 0.9, 0, 0, 1.6, 0.2, 0.3, 3, { surf: "wood", ramp: false }));
  // walls, two storeys (the first-floor walls stand on the floor slab edge), eave 7.0
  const wallsAt = (y0: number, h: number, fr: typeof FARM_OPEN.front0, bk: typeof FARM_OPEN.back0, rt: typeof FARM_OPEN.right0, lf: typeof FARM_OPEN.left0) => {
    out.push(...wall("fh:wall", -hx, hz - t / 2, hx, hz - t / 2, y0, h, t, o(fr), { surf: "wood" }));
    out.push(...wall("fh:wall", hx, -hz + t / 2, -hx, -hz + t / 2, y0, h, t, o(bk), { surf: "wood" }));
    out.push(...wall("fh:wall", hx - t / 2, hz - t, hx - t / 2, -hz + t, y0, h, t, o(rt), { surf: "wood" }));
    out.push(...wall("fh:wall", -hx + t / 2, -hz + t, -hx + t / 2, hz - t, y0, h, t, o(lf), { surf: "wood" }));
    // breakable glass in every window (dress.ts dressOpenings glazes them 2 cm off the centre line)
    out.push(...panes("fh:pane", -hx, hz - t / 2, hx, hz - t / 2, y0, fr, 0.02), ...panes("fh:pane", hx, -hz + t / 2, -hx, -hz + t / 2, y0, bk, 0.02));
    out.push(...panes("fh:pane", hx - t / 2, hz - t, hx - t / 2, -hz + t, y0, rt, 0.02), ...panes("fh:pane", -hx + t / 2, -hz + t, -hx + t / 2, hz - t, y0, lf, 0.02));
  };
  wallsAt(f0, f1 - 0.3 - f0, FARM_OPEN.front0, FARM_OPEN.back0, FARM_OPEN.right0, FARM_OPEN.left0);
  // the leaves dress.ts draws — front onto the veranda, back
  // swung flat against the outer wall (clear of the back steps)
  out.push(...doorLeaves("fh:leaf", -hx, hz - t / 2, hx, hz - t / 2, f0, FARM_OPEN.front0, t, FARM_SWING[0]));
  out.push(...doorLeaves("fh:leaf", hx, -hz + t / 2, -hx, -hz + t / 2, f0, FARM_OPEN.back0, t, FARM_SWING[1]));
  wallsAt(f1 - 0.3, H.eave - (f1 - 0.3), FARM_OPEN.front1.map((q) => ({ ...q, y0: q.y0 + 0.3 })), FARM_OPEN.back1.map((q) => ({ ...q, y0: q.y0 + 0.3 })), FARM_OPEN.right1.map((q) => ({ ...q, y0: q.y0 + 0.3 })), FARM_OPEN.left1.map((q) => ({ ...q, y0: q.y0 + 0.3 })));
  // first floor slab with the stairwell hole over stair 1 (whole lane + 0.15)
  const fl1 = (x0: number, z0: number, x1: number, z1: number) => out.push(bx("fh:floor1", x0, f1 - 0.3, z0, x1, f1, z1, { surf: "wood" }));
  fl1(-hx + t, S1.z1 + 0.15, hx - t, hz - t); fl1(S1.x1, -hz + t, hx - t, S1.z1 + 0.15);
  out.push(nr(railCol(-hx + t + 0.05, S1.z1 + 0.1, f1, S1.x1 + 0.05, S1.z1 + 0.1, f1, 1.0)));
  // attic floor with the hatch over stair 2
  const fl2 = (x0: number, z0: number, x1: number, z1: number) => out.push(bx("fh:floor2", x0, f2 - 0.25, z0, x1, f2, z1, { surf: "wood" }));
  fl2(-hx + t, -hz + t, S2.x0 - 0.1, hz - t); fl2(S2.x1 + 0.1, -hz + t, hx - t, hz - t); fl2(S2.x0 - 0.1, S2.z1 + 0.05, S2.x1 + 0.1, hz - t);
  out.push(nr(railCol(S2.x0 - 0.15, -H.knee, f2, S2.x0 - 0.15, S2.z1, f2, 1.0)), nr(railCol(S2.x1 + 0.15, -H.knee, f2, S2.x1 + 0.15, S2.z1, f2, 1.0)));
  // stairs: 1 = solid (a cupboard under it), 2 = steep open timber stair (thin treads)
  out.push(...stairs("fh:step", S1.x0, (S1.z0 + S1.z1) / 2, f0, Math.PI / 2, S1.z1 - S1.z0, (f1 - f0) / S1.n, (S1.x1 - S1.x0) / S1.n, S1.n, { surf: "wood", ramp: false }));
  // an OPEN-riser timber stair (thin tread colliders, drawn treads,
  // stringers + rail) with a boarded cupboard under its low end, where the treads leave < 1.95 m of headroom
  out.push(...stairs("fh:step2", (S2.x0 + S2.x1) / 2, S2.z0, f1, 0, S2.x1 - S2.x0, (f2 - f1) / S2.n, (S2.z1 - S2.z0) / S2.n, S2.n, { surf: "wood" }));
  {
    const rise = (f2 - f1) / S2.n, run = (S2.z1 - S2.z0) / S2.n, th = Math.min(Math.max(0.3, rise * 2), rise + 0.3);
    for (let i = 0; i < S2.n; i++) {
      const under = rise * (i + 1) - th;
      if (under >= 1.95) break;
      if (under > 0.05) out.push(bx("fh:closet", S2.x0, f1, S2.z0 + i * run, S2.x1, f1 + under, S2.z0 + (i + 1) * run, { surf: "wood" }));
    }
  }
  // first-floor partition with a doorway
  out.push(bx("fh:part", 0.65, f1, -hz + t, 0.95, H.eave - 0.25, 0.8, { surf: "wood" }), bx("fh:part", 0.65, f1, 2.2, 0.95, H.eave - 0.25, hz - t, { surf: "wood" }));
  out.push(bx("fh:part", 0.65, f1 + 2.3, 0.8, 0.95, H.eave - 0.25, 2.2, { surf: "wood" }));
  // attic knee walls (the roof is < 1.9 m above the floor outside them)
  const kneeTop = H.eave + (hz - H.knee - 0.12) * dmath.tan(H.pitch) - 0.05;
  out.push(bx("fh:knee", -hx + t, f2, -H.knee - 0.12, S2.x0 - 0.1, kneeTop, -H.knee, { surf: "wood" }), bx("fh:knee", S2.x1 + 0.1, f2, -H.knee - 0.12, hx - t, kneeTop, -H.knee, { surf: "wood" }));
  out.push(bx("fh:knee", -hx + t, f2, H.knee, hx - t, kneeTop, H.knee + 0.12, { surf: "wood" }));
  // chimney: one brick column from the fireplace through both floors and out of the roof
  out.push(bx("fh:chimney", C.x0, f0, C.z0, C.x1, C.top, C.z1, { surf: "stone" }));
  // roof: gable slabs (ridge along X), gable infill with the attic windows
  out.push(...gableRoof("fh:roof", -hx, hx, hz, H.eave, H.pitch, H.over, 0.3));
  for (const sx of [-1, 1]) out.push(...place(F(sx * (hx - t / 2), 0, 0, 0), gableFill("fh:gable", 0, hz, H.eave, H.pitch, t, [[-0.5, 0.5, f2 + 0.6, f2 + 1.6]])));
  // the attic windows (open, see gableFill) get their pane — an attic exit you smash and vault
  for (const sx of [-1, 1]) out.push({ k: "fh:pane", c: [sx * (hx - t / 2), f2 + 1.1, 0], h: [0.03, 0.5, 0.5], col: true, noShoot: true, surf: "glass" });
  // veranda: posts + the balcony slab on top of them + a solid balcony parapet (cover) open at the balcony door
  for (const x of [-hx + 0.2, -2.2, 2.2, hx - 0.2]) out.push(bx("fh:post", x - 0.13, f0, hz + H.porch - 0.3, x + 0.13, f1 - 0.3, hz + H.porch - 0.04, { surf: "wood", col: true }));
  out.push(bx("fh:balc", -hx, f1 - 0.3, hz, hx, f1, hz + H.porch, { surf: "wood" }));
  out.push(bx("fh:parapet", -hx, f1, hz + H.porch - 0.14, hx, f1 + 1.0, hz + H.porch, { surf: "wood" }));
  for (const sx of [-1, 1]) out.push(bx("fh:parapet", sx > 0 ? hx - 0.14 : -hx, f1, hz, sx > 0 ? hx : -hx + 0.14, f1 + 1.0, hz + H.porch - 0.14, { surf: "wood" }));
  for (const [x0, z0, x1, z1, h, k, y0] of FARM_FURN) out.push(bx(k, x0, y0, z0, x1, y0 + h, z1, { col: true, surf: "wood" }));
  return out;
}
export const FARM_LOCAL: Piece[] = farmhouse();

/** water-tower access: a timber stair outside the trestle's −x face, 26 treads up
 *  to a landing beside the deck; deck railing colliders with the gap at the landing (tower-local, y from the ground) */
/** the deck is 1.1 m wider than the trestle (at 0.6 only 0.76 m is left between the tank and the rail — no one fits) */
export const WT_DECK = 1.1;
export const WT_STAIR = { x0: -5.05, x1: -3.85, z0: 4.6, zTop: -2.4, zEnd: -3.6, n: 26 };
function waterTowerStair(): Piece[] {
  const W = WTOWER, S2 = WT_STAIR, D = W.legSpread + WT_DECK, out: Piece[] = [];
  const rise = W.legH / S2.n, run = (S2.z0 - S2.zTop) / S2.n, xc = (S2.x0 + S2.x1) / 2;
  out.push(...stairs("wt:step", xc, S2.z0, 0, Math.PI, S2.x1 - S2.x0, rise, run, S2.n, { surf: "wood" }));
  out.push(bx("wt:land", S2.x0, W.legH - 0.25, S2.zEnd, -D + 0.05, W.legH, S2.zTop, { surf: "wood" }));
  out.push(nr(railCol(S2.x0 + 0.05, S2.z0, rise, S2.x0 + 0.05, S2.zTop, W.legH)), nr(railCol(S2.x0 + 0.05, S2.zTop, W.legH, S2.x0 + 0.05, S2.zEnd, W.legH)));
  out.push(nr(railCol(S2.x0, S2.zEnd + 0.05, W.legH, -D, S2.zEnd + 0.05, W.legH)));
  // deck rails (bullets pass) — open on the −x side where the landing meets the deck
  out.push(railCol(-D + 0.05, D, W.legH, D, D, W.legH, 0.95), railCol(D, D, W.legH, D, -D, W.legH, 0.95), railCol(D, -D + 0.05, W.legH, -D, -D + 0.05, W.legH, 0.95));
  out.push(railCol(-D + 0.05, -D, W.legH, -D + 0.05, S2.zEnd, W.legH, 0.95), railCol(-D + 0.05, S2.zTop, W.legH, -D + 0.05, D, W.legH, 0.95));
  return out;
}

function yard(): Piece[] {
  const out: Piece[] = [];
  const W = WTOWER, wf = F(W.x, PAD.y, W.z, W.yaw);
  const s = W.legSpread;
  out.push(...place(wf, [
    // the legs splay (client yard.ts: feet at s + 0.35, heads at s − 0.05): three stacked boxes follow each one
    ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].flatMap(([a, b]) => [0, 1, 2].map((k) => {
      const y0 = (W.legH * k) / 3, y1 = (W.legH * (k + 1)) / 3, t = ((y0 + y1) / 2 - 0.35) / (W.legH - 0.65), q = s + 0.35 - 0.4 * Math.min(1, Math.max(0, t));
      return bx("wt:leg", a * q - 0.2, y0, b * q - 0.2, a * q + 0.2, y1, b * q + 0.2, { surf: "wood" as const, col: true });
    })),
    bx("wt:deck", -s - WT_DECK, W.legH - 0.25, -s - WT_DECK, s + WT_DECK, W.legH, s + WT_DECK, { surf: "wood", col: true }),
    // the round stave tank as a regular octagon (four strips at 0/45/90/135°, circumradius 0.97 R: inside the drawn
    // Ø, ≤ 0.26 m from its staves), its cone roof as a smaller box
    ...[0, 1, 2, 3].map((k) => ({ k: "wt:tank", c: [0, W.legH + W.tankH / 2, 0] as V3, h: [W.tankR * 0.97 * dmath.cos(Math.PI / 8), W.tankH / 2, W.tankR * 0.97 * dmath.sin(Math.PI / 8)] as V3, yaw: (k * Math.PI) / 4, col: true, surf: "wood" as const })),
    bx("wt:tank", -1.25, W.legH + W.tankH, -1.25, 1.25, W.legH + W.tankH + 0.9, 1.25, { surf: "metal", col: true }),
    ...waterTowerStair(),
  ]));
  out.push({ k: "flood", c: [FLOOD[0], PAD.y + 5.5, FLOOD[1]], h: [0.1, 5.5, 0.1], col: true, noShoot: true, surf: "metal" });
  const tf = F(TRACTOR[0], PAD.y, TRACTOR[1], TRACTOR[2]);
  out.push(...place(tf, [
    // body + wheels, and the cab above it
    { k: "tractor", c: [0.45, 0.83, 0], h: [1.95, 0.83, 1.2], col: true, surf: "metal" },
    { k: "tractor", c: [-0.48, 2.4, 0], h: [0.85, 0.74, 0.76], col: true, surf: "metal" },
    { k: "trailer", c: [-4.2, 0.78, 0], h: [1.65, 0.7, 0.95], col: true, surf: "wood" }, // top = the drawn side boards (1.47)
  ]));
  out.push(...place(BARN.frame, [
    { k: "pickup", c: [YARD_PICKUP[0], 0.95, YARD_PICKUP[1]], h: [2.3, 0.95, 1.05], yaw: YARD_PICKUP[2], col: true, surf: "metal" },
    ...YARD_PALLETS.map(([x, z, yaw, n]) => ({ k: "pallets", c: [x, n * 0.07 + 0.02, z] as V3, h: [0.62, n * 0.07 + 0.02, 0.62] as V3, yaw, col: true, surf: "wood" as const })),
  ]));
  // the boxes are the DRAWN crate (1.8 × 1.2 m crate × 1.5 on a 0.14 m pallet, client yard.ts); the third roadside
  // crate (stacked on top) gets its own box
  for (const [x, z, yaw] of ROADSIDE_CRATES.slice(0, 2)) out.push({ k: "crates", c: [x, PAD.y + 0.69, z], h: [0.92, 0.69, 0.62], yaw, col: true, surf: "wood" });
  { const [x, z, yaw] = ROADSIDE_CRATES[2]; out.push({ k: "crates", c: [x, PAD.y + 1.34 + 0.62, z], h: [0.92, 0.62, 0.62], yaw: yaw + 0.1, col: true, surf: "wood" }); }
  for (const [x, z, yaw] of FIELD_CRATES) out.push({ k: "crates", c: [x, PAD.y + 0.69, z], h: [0.92, 0.69, 0.62], yaw, col: true, surf: "wood" });
  for (const c of COTTAGES) out.push(...place(c.f, COT_LOCAL));
  return out;
}

/** crates on the barn's upper loading deck (barn-local x, z, stack height) */
export const DECK_CRATES: Array<[number, number, number]> = [[-2.9, 1.2, 2], [-0.9, 1.4, 1], [1.3, 1.1, 1], [4.2, 1.3, 2], [5.5, 2.3, 1]];
const deckCrates = (): Piece[] => DECK_CRATES.map(([x, z, n]) => ({ k: "crates", c: [x, BARN.loft + n * 0.41, z] as V3, h: [0.62, n * 0.41, 0.42] as V3, yaw: (x * 0.37) % 0.3, col: true, surf: "wood" as const }));

export const PIECES: Piece[] = [...place(BARN.frame, [...BARN_LOCAL, ...deckCrates()]), ...yard(), ...place(FARM.frame, FARM_LOCAL)];

// ------------------------------------------------------------------------------------------------ banana rows
/** plantation rows run parallel to the camera road (R3); returns deterministic plant spots [x, z, yaw, scale, variant, bag] */
export const ROW_DIR: [number, number] = [0.8, -0.6];
export function bananaSpots(): Array<[number, number, number, number, number, number]> {
  const r = rng(9090), out: Array<[number, number, number, number, number, number]> = [];
  const [ux, uz] = ROW_DIR, vx = -uz, vz = ux, rowGap = 3.7, step = 2.9;
  for (let j = -46; j <= 46; j++) {
    const lateral = j * rowGap;
    for (let i = -56; i <= 56; i++) {
      const along = i * step + (j % 2) * step * 0.5;
      const x = PAD.x + ux * along + vx * lateral + (r() - 0.5) * 0.7, z = PAD.z + uz * along + vz * lateral + (r() - 0.5) * 0.7;
      // taller spread (0.9–1.3) and the rows along a road carry more bags
      const yaw = r() * 6.283, sc = 0.78 + r() * 0.36, variant = Math.floor(r() * 3), bagR = r(), bag = bagR < (roadDist(x, z) < 12 ? 0.94 : 0.72) ? 1 : 0;
      const dc = dmath.hypot(x - PAD.x, z - PAD.z), gap = r();
      if (dc > PAD.r + 2 * r()) continue; // ≤ 152 m (the pad is flat to 150 — the stem colliders assume it)
      // harvest lanes every 7 rows (a 7.4 m walkable lane every ~26 m: cross-field rotations and
      // mid-range sight lines between the rows) + ~5 % missing plants (the field reads planted, not tiled)
      if (((j + 46) % 7 === 3) || gap < 0.05) continue;
      if (!plantable(x, z)) continue;
      out.push([x, z, yaw, sc, variant, bag]);
    }
  }
  return out;
}
/** keep-outs for rows (roads + verges, barn + yard, cottages, water tower, tractor, crates) */
export function plantable(x: number, z: number): boolean {
  if (roadDist(x, z) < 1.5) return false;
  const inFrame = (f: Frame, x0: number, x1: number, z0: number, z1: number) => {
    const dx = x - f.x, dz = z - f.z, c = dmath.cos(f.yaw), s = dmath.sin(f.yaw);
    const lx = dx * c - dz * s, lz = dx * s + dz * c;
    return lx > x0 && lx < x1 && lz > z0 && lz < z1;
  };
  // packing house + its yard: an L (the conveyor foot + tractor lane on the left stays narrow, so the rows crowd the
  // road's left verge)
  if (inFrame(BARN.frame, -30, 16, -32, 8) || inFrame(BARN.frame, -18, 16, -32, 15)) return false;
  for (const c of COTTAGES) if (inFrame(c.f, -8, 8, -7, 10)) return false;
  if (inFrame(FARM.frame, -10, 10, -8, 12)) return false;
  if (dmath.hypot(x - WTOWER.x, z - WTOWER.z) < 7.5) return false;
  if (dmath.hypot(x - FLOOD[0], z - FLOOD[1]) < 3) return false;
  if (dmath.hypot(x - TRACTOR[0], z - TRACTOR[1]) < 7.5) return false;
  // keep the view's sight line to the tractor + trailer open (a wedge of the left verge rows)
  { const [cx, cz] = roadPt(34, -3.5), [tx, tz] = [TRACTOR[0], TRACTOR[1]], dx = tx - cx, dz = tz - cz, L = dmath.hypot(dx, dz), u = ((x - cx) * dx + (z - cz) * dz) / (L * L);
    if (u > 0.05 && u < 1 && Math.abs((x - cx) * dz - (z - cz) * dx) / L < 2.2 + 3.5 * u) return false; }
  if (dmath.hypot(x - ROADSIDE_CRATES[0][0], z - ROADSIDE_CRATES[0][1]) < 4) return false;
  for (const [cx, cz] of FIELD_CRATES) if (dmath.hypot(x - cx, z - cz) < 3.4) return false;
  for (const [cx, cz] of FIELD_CHESTS) if (dmath.hypot(x - cx, z - cz) < 2.2) return false;
  return true;
}

// @rim-baked-begin (offline bake — 233 trees: x, ground y, z, kind 0 palm / 1 leaning / 2 jungle tree)
export const RIM_BAKED: Array<[number, number, number, number]> = [[-77.35,10.03,239.79,0],[-75.44,10.06,249.4,0],[-76.29,10.04,255.66,0],[-78.92,10.02,266.7,1],[-80.08,10.03,274.23,1],[-83.08,10.02,281.77,0],[-84.37,10.04,291.64,0],[-88.05,10.03,298.6,1],[-90.45,10.03,305.03,1],[-96.08,10.03,314.13,0],[-100.12,10.03,321.77,2],[-105.15,10.02,327.75,1],[-109.51,10.03,335.08,2],[-114.53,10.04,342.8,2],[-120.01,10.03,347.33,2],[-125.71,10.03,354.06,2],[-132.9,10.02,357.75,0],[-139.67,10.02,363.11,0],[-145.3,10.02,367.95,0],[-153.39,10.03,373.91,0],[-159.8,10.03,378.52,2],[-167.06,10.03,381.62,2],[-175.1,10.02,383.74,1],[-184.67,10.02,386.97,0],[-194.04,10.02,388.91,1],[-200.58,10.03,391.73,0],[-207.74,10.03,392.66,1],[-218.61,10.04,394.42,0],[-225.5,10.02,393.31,0],[-234.57,10.02,394.45,1],[-244.45,10.02,392.87,2],[-251.53,10.03,393.94,0],[-259.1,10.03,392.03,0],[-268.47,10.02,387.87,0],[-277.04,10.02,385.6,0],[-284.81,10.02,383.62,2],[-293.77,10.02,380.12,1],[-298.63,10.02,378.01,1],[-308.69,10.02,372.13,1],[-315.05,10.02,366.99,0],[-322.61,10.04,363.87,0],[-326.27,10.02,358.52,0],[-333.87,10.04,354.08,0],[-340.79,10.05,348.34,1],[-345.24,10.04,341.79,2],[-352.35,10.09,335.47,0],[-357.09,10.04,325.86,0],[-361.54,10.04,319.02,2],[-366.95,10.08,312.92,0],[-369.07,10.05,306.45,0],[-372.72,10.06,298.57,0],[-375.03,10.03,288.59,2],[-376.94,10.03,281.04,0],[-380.45,10.04,271.81,0],[-380.29,10.03,266.11,1],[-384.31,10.06,254.71,0],[-384.38,10.04,246.64,1],[-384.25,10.03,239.21,0],[-383.68,10.04,229.64,2],[-382.27,10.03,224.09,2],[-381.53,10.04,215.41,0],[-380.18,10.05,204.69,0],[-377.87,10.04,199.14,0],[-376.28,10.06,190.18,0],[-372.32,10.05,180.71,0],[-369.87,10.06,173.7,0],[-366.09,10.06,167.1,0],[-360.2,10.03,160.04,0],[-356.5,10.04,152.26,0],[-351.6,10.04,146.05,1],[-345.32,10.02,140.1,1],[-338.54,10.03,132.31,0],[-334.5,10.06,125.79,1],[-327.89,10.03,121.8,2],[-320.26,10.05,113.44,0],[-312.98,10.02,111.23,0],[-306.23,10.03,106.78,2],[-299.22,10.04,102.19,2],[-290.64,10.07,96.83,0],[-281.68,10.04,95.13,0],[-275.71,10.04,93.02,0],[-268.38,10.03,91.25,0],[-258.45,10.03,89.17,0],[-250.39,10.03,87.87,0],[-241.93,10.04,86.29,2],[-232.32,10.05,85.29,0],[-224.04,10.05,85.75,0],[-217.82,10.03,87.4,2],[-208.06,10.06,86.83,0],[-198.39,10.03,90.49,0],[-191.75,10.11,89.99,0],[-182.21,10.11,92.87,1],[-174.46,10.09,96.31,0],[-167.19,10.06,100.24,2],[-159.64,10.07,103.24,0],[-150.75,10.12,106.96,1],[-145.7,10.04,112.65,0],[-138.86,10.04,117.11,0],[-130.44,10.11,121.82,0],[-125.61,10.03,128.59,1],[-117.96,10.14,132.38,2],[-112.05,10.07,140.72,0],[-108.89,10.03,146.44,1],[-104.18,10.03,153.3,0],[-99.54,10.03,159.97,2],[-93.05,10.04,169.18,2],[-90.17,10.07,173.6,2],[-87.29,10.03,184.99,2],[-83.81,10.09,190.32,1],[-82.25,10.03,200.1,0],[-80.26,10.04,206.7,0],[-78.78,10.04,216.95,0],[-77.91,10.03,225,0],[-77.11,10.03,232.42,2],[-68.15,10.87,242.59,0],[-68.01,10.68,252.73,2],[-68.83,10.52,260.19,0],[-70.7,10.42,270.81,0],[-72.15,10.39,276.49,0],[-76.32,10.29,286.89,0],[-76.83,10.42,295.82,0],[-79.99,10.32,302.99,2],[-83.97,10.38,310.85,0],[-88.23,10.38,316.56,2],[-92.74,10.46,323.58,0],[-97.17,10.43,330.55,0],[-103.61,10.35,339.33,1],[-105.8,10.51,344.85,0],[-111.42,10.46,350.98,1],[-118.92,10.45,359.95,2],[-126.19,10.28,363.96,1],[-130.65,10.32,369.3,2],[-139.06,10.21,372.92,0],[-146.53,10.12,379.04,0],[-151.97,10.11,381.33,0],[-161,10.13,386.25,1],[-167.97,10.13,389.22,2],[-176.15,10.1,393.05,1],[-184.31,10.16,396.67,2],[-191.86,10.17,397.94,1],[-200.39,10.16,398.08,2],[-207.91,10.22,400.05,1],[-216.96,10.22,400.84,0],[-225.29,10.13,401.07,0],[-234.99,10.08,403.16,0],[-243.18,10.04,399.96,0],[-251.26,10.02,400.95,1],[-260.13,10.01,400.01,0],[-269.35,10.06,397.79,0],[-277.82,10.01,395.89,2],[-284.51,10,393.7,1],[-293.17,10.02,389.45,2],[-300.15,10.09,386.75,2],[-307.72,10.1,381.16,1],[-316.13,10.19,376.91,0],[-322.12,10.18,371.51,0],[-328.84,10.34,368.49,2],[-335.58,10.45,363.37,1],[-342.15,10.32,354.87,2],[-347.59,10.54,351.08,1],[-351.92,10.52,345.09,1],[-358.25,10.73,339.16,0],[-365,11.03,329.75,2],[-369.24,11.15,323.29,0],[-372.09,10.77,315.79,0],[-375.56,10.64,307.97,1],[-378.94,10.87,301.72,0],[-382.18,11,292.5,0],[-384.56,10.86,283.72,0],[-387.48,10.93,275.67,2],[-390.51,11.08,268.27,2],[-390.76,10.71,259.42,1],[-391.62,10.58,251.77,0],[-391.31,10.42,244.42,2],[-391.77,10.52,233.26,0],[-390.6,10.49,226.33,2],[-390.08,10.61,218.72,0],[-387.83,10.65,208.8,0],[-387.99,10.91,200.71,2],[-386.31,10.93,192.09,2],[-381.38,10.6,184.17,2],[-378.65,10.66,175.61,0],[-374.16,10.55,168.81,0],[-371.18,10.83,160.29,1],[-366.41,10.67,153.13,1],[-364.35,10.81,147.91,2],[-357.76,10.81,139.14,0],[-352.6,10.59,134.02,2],[-348.26,10.77,127.89,1],[-339.57,10.61,121,2],[-334.15,10.7,114.7,2],[-328.56,10.56,110.3,0],[-320.72,10.28,107.17,1],[-312.07,10.35,101.43,2],[-304.15,10.44,97.33,1],[-297.46,10.44,94.3,1],[-291.28,10.45,91.49,0],[-282.92,10.98,85.74,2],[-275.52,10.62,85.84,2],[-264.79,10.65,81.89,2],[-258.41,10.45,81.22,2],[-249.67,10.75,80.54,0],[-240.12,10.47,79.48,2],[-234.15,10.79,77.01,0],[-223.27,10.63,78.81,1],[-216.84,10.63,79.26,2],[-208.25,10.71,79.91,0],[-197.15,11.48,80.04,2],[-191.2,11.03,84.19,0],[-180.86,12.06,84.74,2],[-173.95,11.66,89.2,0],[-166.72,13.64,89.47,2],[-151.54,12.08,98.54,0],[-144.45,11.34,103.79,2],[-137.66,11.54,107.77,0],[-131.47,11.63,112.02,2],[-122.84,11.49,119.68,2],[-117.55,11.76,122.89,0],[-112.21,10.88,130.67,2],[-105.29,11.06,137.94,2],[-100.71,11.53,141.27,0],[-96.48,10.92,149.8,1],[-91.51,10.78,156.65,0],[-86.82,10.71,165.36,1],[-82.58,11.03,171.85,0],[-80.96,10.96,178.72,0],[-77.38,11.17,189.25,2],[-72.59,11.82,195.82,2],[-73.16,10.9,204.41,1],[-71.22,11.04,213.66,0],[-67.87,12.02,221.17,0],[-69.45,11.16,230.05,0],[-66.78,11.56,239.53,1]];
// @rim-baked-end

/** the veg scatter stays out of the whole cultivated pad (the rows are the vegetation here) */
export const clearings: Clearing[] = [{ x: PAD.x, z: PAD.z, r: PAD.r + 6 }, ...GLADES.map(([x, z, r]) => ({ x, z, r }))];

// ------------------------------------------------------------------------------------------------ flora + colliders
/** palms + bushes the POI plants itself round the cottages, the farmhouse and the barn yard (on the flat pad) — the
 *  collidable ones get the veg area's trunk colliders (coast-kit floraColliders) */
export const FLORA: Flora[] = (() => {
  const r = rng(6262), out: Flora[] = [];
  const put = (k: Flora[0], x: number, z: number, s: number) => { x = settleFlora(k, x, z); out.push([k, x, PAD.y, z, r() * 6.283, s]); };
  const clear = (x: number, z: number) => roadDist(x, z) > 1.5 && !COTTAGES.some((c) => inFrameRect(c.f, x, z, -5.5, 6.5, -4.5, 5)) && !inFrameRect(FARM.frame, x, z, -8, 8, -6.5, 10.5)
    && !inFrameRect(BARN.frame, x, z, -30, 16, -32, 16) && dmath.hypot(x - WTOWER.x, z - WTOWER.z) > 7.5;
  for (const c of COTTAGES) for (let k = 0; k < 3; k++) {
    for (let tries = 0; tries < 12; tries++) {
      const a = r() * 6.283, d = 6.5 + r() * 2.5, x = c.f.x + dmath.cos(a) * d, z = c.f.z + dmath.sin(a) * d;
      if (!clear(x, z)) continue;
      put(k === 2 ? "bush" : k === 1 ? "palm-leaning" : "palm", x, z, 0.9 + r() * 0.3); break;
    }
  }
  for (const [lx, lz, k] of [[-8.5, -5.5, "palm"], [9.2, -3.0, "palm"], [9.8, 6.5, "palm-leaning"], [-9.5, 4.0, "bush"], [8.8, 9.5, "bush"]] as Array<[number, number, Flora[0]]>) {
    const p = toWorld(FARM.frame, lx, 0, lz); put(k, p[0], p[2], 1.0 + r() * 0.2);
  }
  // (cover ≤ 8 m out to the POI edge): a windbreak of palms + jungle trees on the pad's rim (r 144–149, flat
  // pad), every ~8 m, clear of the roads and the rows' outermost plants
  const spots = bananaSpots();
  // (one tree every ~20 m — denser, with the outer ring below, it reads as a double wall of palms round the field)
  for (let a = 0; a < Math.PI * 2; a += 20 / 146.5) {
    const d = 144 + r() * 5, aa = a + (r() - 0.5) * 0.02, x = PAD.x + dmath.cos(aa) * d, z = PAD.z + dmath.sin(aa) * d;
    if (roadDist(x, z) < 2.5 || spots.some(([sx, sz]) => dmath.pow(sx - x, 2) + dmath.pow(sz - z, 2) < 2.2)) continue;
    const k = r();
    put(k < 0.55 ? "palm" : k < 0.75 ? "palm-leaning" : "jungle-tree", x, z, 0.95 + r() * 0.3);
  }
  // … and the outer windbreak on the blend slope (terrain heights baked offline)
  for (const [i, [x, y, z, ki]] of RIM_BAKED.entries()) {
    if (i % 2) continue; // half the outer windbreak (less tree coverage, clean rotations onto the pad)
    if (GLADES.some(([mx, mz]) => dmath.hypot(x - mx, z - mz) < 32)) continue; // (the open glades)
    const kind: Flora[0] = ki === 0 ? "palm" : ki === 1 ? "palm-leaning" : "jungle-tree";
    out.push([kind, settleFlora(kind, x, z), y, z, r() * 6.283, kind === "jungle-tree" ? 0.9 : 1.0 + r() * 0.25]);
  }
  return out;
})();

/** banana pseudostem colliders (so the field gives cover): one box per plant round the main pseudostem (r ≈ 0.17 × scale, 2.4 × scale tall — the
 *  leaves above stay soft). Plants past the pad's flat edge get a box reaching 1.5 m lower (the blend slope). */
export function bananaColliders(): Box[] {
  const out: Box[] = [];
  // (parity: no box corners outside the round stem, box top under the drawn crown): a slim box INSIDE the straight
  // drawn pseudostem (radius 0.10–0.25·sc; the box half 0.11·sc — corners ≤ 0.05 out at the top), its top at the drawn stem top of the
  // field's distance variant (client rows.ts buildVariant v0: h = 2.7 + rng(700)·0.3, instance y-scale ky)
  const H0 = 2.7 + rng(700)() * 0.3;
  for (const [x, z, , sc] of bananaSpots()) {
    const ky = 0.92 + (((x * 7.13) % 1) + 1) % 1 * 0.16;
    const off = dmath.hypot(x - PAD.x, z - PAD.z) > PAD.r ? 1.5 : 0.1, base = PAD.y - 0.06, hs = H0 * sc * ky, top = base + hs - 0.03, mid = base + hs * 0.6, bot = PAD.y - off;
    // two courses following the taper: 0.11·sc wide to 0.6 h, 0.075·sc above (the top corners stay inside the cap)
    // (a tuk-tuk ploughs through the banana rows — noDrive; kongs and bullets still meet the stems)
    out.push({ c: [x, (mid + bot) / 2, z], h: [0.11 * sc, (mid - bot) / 2, 0.11 * sc], surf: "foliage", noDrive: true });
    out.push({ c: [x, (top + mid) / 2, z], h: [0.075 * sc, (top - mid) / 2, 0.075 * sc], surf: "foliage", noDrive: true });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ interiors
/** every enterable room, furnished by the shared interiors kit (furniture = cover + colliders + loot candidates):
 *  the five worker cottages, the farmhouse's ground floor and its two bedrooms (stairs / chimney kept clear) */
export const INTERIOR_ROOMS: InteriorRoom[] = (() => {
  const out: InteriorRoom[] = [];
  const W = (side: 0 | 1 | 2 | 3, at: number, w: number, y0 = 0.9, h = 1.0) => ({ side, at, w, kind: "window" as const, y0, h });
  const D = (side: 0 | 1 | 2 | 3, at: number, w: number, h = 2.3) => ({ side, at, w, kind: "door" as const, h });
  // cottages: inner 6.0 × 4.8, floor 0.45, boarded ceiling at the eave − 0.12
  COTTAGES.forEach((c, i) => out.push(kitRoom(c.f, 0, 0.45, 0, {
    id: `cottage-${i}`, w: COT.w - 0.4, d: COT.d - 0.4, h: COT.h - 0.12, style: i % 2 ? "house" : "hut", role: i % 2 ? "bedroom" : "bunk", seed: COT_SEEDS[i], density: 0.6,
    wallT: 0.2, finish: { glass: false, frames: false }, openings: [D(0, COT.doorX, 1.2, 2.35), W(0, -COT.w / 2 + 1.3, 1.1), W(2, 0, 1.1), W(3, 0, 0.9, 1.0, 0.9)],
    // an open centre (furniture along the walls): one room to fight through, not a maze of tables
    keepOut: [{ r: [-1.9, -1.3, 1.9, 1.3], walk: true }],
  })));
  // farmhouse (inner ±5.7 × ±4.2): the ground floor is furnished as two
  // rooms with an open side between them — the living room (left, the stair) and the kitchen / dining room (right,
  // the fireplace) — each with its own hero pieces
  const H = FARM, f = H.frame, hIn = H.hz - H.t, gh = H.f1 - 0.3 - H.f0, LX = (-5.7 + 1.0) / 2, KX = (1.0 + 5.7) / 2;
  const G = (side: 0 | 1 | 2 | 3, w: number) => ({ side, at: 0, w, kind: "gap" as const });
  out.push(kitRoom(f, LX, H.f0, 0, {
    id: "farm-living", w: 1.0 + 5.7, d: 2 * hIn, h: gh, style: "house", role: "living", seed: 651, wallT: H.t, finish: { glass: false, frames: false, ceiling: "none", shell: false },
    openings: [W(0, -3.5 - LX, 1.3, 0.9, 1.5), D(0, -LX, 1.4, 2.5), W(2, -2 - LX, 1.2, 0.9, 1.4), W(2, -4.5 - LX, 1.1, 0.9, 1.4), W(3, 0.3, 1.3, 0.9, 1.5), G(1, 2 * hIn)],
    // the stair along the back wall (stepped onto from its open side)
    keepOut: [[-5.7 - LX, -4.2, H.stair1.x1 - LX, -2.8], { r: [-5.7 - LX, -2.85, H.stair1.x1 + 0.3 - LX, -0.9], walk: true }],
  }));
  out.push(kitRoom(f, KX, H.f0, 0, {
    id: "farm-kitchen", w: 5.7 - 1.0, d: 2 * hIn, h: gh, style: "house", role: "kitchen", seed: 654, wallT: H.t, finish: { glass: false, frames: false },
    openings: [W(0, 3.5 - KX, 1.3, 0.9, 1.5), D(2, 2.5 - KX, 1.2, 2.4), W(1, -2.1, 1.2, 0.9, 1.4), G(3, 2 * hIn)],
    // the fireplace / chimney on the right gable
    keepOut: [[4.5 - KX, 2.1, 5.7 - KX, 3.5]],
  }));
  const lx = (-5.7 + 0.65) / 2, rx = (0.95 + 5.7) / 2, h1 = H.f2 - 0.25 - H.f1;
  out.push(kitRoom(f, lx, H.f1, 0, {
    id: "farm-bed-l", w: 0.65 + 5.7, d: 2 * hIn, h: h1, style: "house", role: "bedroom", seed: 652, wallT: H.t, finish: { glass: false, frames: false },
    openings: [W(0, -3.5 - lx, 1.2, 0.8, 1.4), D(0, -lx, 1.2, 2.3), W(2, -lx, 1.1, 0.9, 1.3), W(2, -3.5 - lx, 1.1, 0.9, 1.3), W(3, 0.3, 1.1, 0.9, 1.3), D(1, 1.5, 1.4, 2.3)],
    keepOut: [[-5.7 - lx, -4.2, H.stair1.x1 - lx, -2.65], { r: [H.stair1.x1 - 0.9 - lx, -4.2, 0.65 - lx, -1.9], walk: true }],
  }));
  out.push(kitRoom(f, rx, H.f1, 0, {
    id: "farm-bed-r", w: 5.7 - 0.95, d: 2 * hIn, h: h1, style: "house", role: "studio", seed: 653, wallT: H.t, finish: { glass: false, frames: false, ceiling: "none", shell: false },
    openings: [W(0, 3.5 - rx, 1.2, 0.8, 1.4), W(2, 3.5 - rx, 1.1, 0.9, 1.3), W(1, 0.7, 1.1, 0.9, 1.3), D(3, 1.5, 1.4, 2.3)],
    keepOut: [[0.95 - rx, H.stair2.z0 - 0.05, 2.4 - rx, H.stair2.z1 + 0.1], { r: [0.95 - rx, -4.2, 3.2 - rx, H.stair2.z0 - 0.05], walk: true }, { r: [2.2 - rx, H.stair2.z0, 3.2 - rx, -1.8], walk: true }, [4.5 - rx, 2.1, 5.7 - rx, 3.5]],
  }));
  // the packing barn's main floor and its
  // lean-to (warehouse: racking, tool chests, pallets, barrels along the walls — the designed packing line stays a
  // solid keep-out) and the hay loft (storage)
  {
    const B = BARN.frame, s = (r: [number, number, number, number], cx: number, cz: number) => ({ r: [r[0] - cx, r[1] - cz, r[2] - cx, r[3] - cz] as [number, number, number, number], solid: true });
    const MX = -0.06, MZ = -13.0, cov = (k: string, y0 = 0.2) => BARN_COVER.filter((q) => q[5] === k || (k === "*" && (q[6] ?? 0.2) === y0));
    const solidsAt = (y0: number, cx: number, cz: number) => cov("*", y0).map((q) => s([q[0], q[1], q[2], q[3]], cx, cz));
    out.push(kitRoom(B, MX, 0.2, MZ, {
      id: "barn-floor", w: 11.52, d: 25.4, h: 4.9, style: "warehouse", role: "storage", seed: 671, wallT: 0.3, openTop: true, density: 0.8,
      finish: { floor: "none", wall: null, dado: null, frames: false, glass: false },
      openings: [D(0, 0.2 - MX, 4.4, 4.3), D(2, -MX, 3.2, 3.4), D(1, 0, 2.4, 3.0), W(1, 13 - BARN_WIN_R[0].u, 1.4, 1.0, 1.4), W(1, 13 - BARN_WIN_R[1].u, 1.4, 1.0, 1.4), G(3, 25.4)],
      keepOut: [...solidsAt(0.2, MX, MZ).filter((q) => q.r[0] > -5.9 - MX), { r: [4.2 - MX, -9.65 - MZ, 5.6 - MX, -2.55 - MZ], solid: true }, { r: [1.6 - MX, -2.55 - MZ, 5.6 - MX, -0.3 - MZ], walk: true }],
    }));
    const LXb = -10.925;
    out.push(kitRoom(B, LXb, 0.2, MZ, {
      id: "barn-pack", w: 9.55, d: 25.4, h: BARN_LEANCEIL.y - BARN_LEANCEIL.t - 0.2, style: "warehouse", role: "workshop", seed: 673, wallT: 0.3, density: 0.75,
      finish: { floor: "none", wall: null, dado: null, frames: false, glass: false, ceiling: "none" },
      openings: [D(3, 3, 3.4, 3.4), W(3, 8.5, 1.6, 1.0, 1.3), W(3, -3, 1.6, 1.0, 1.3), W(3, -9, 1.6, 1.0, 1.3), D(0, -11.8 - LXb, 3.0, 3.0), G(1, 25.4)],
      keepOut: solidsAt(0.2, LXb, MZ).filter((q) => q.r[0] < -6.2 - LXb),
    }));
    const LZx = -0.075;
    out.push(kitRoom(B, LZx, BARN.loft, MZ, {
      id: "barn-loft", w: 11.55, d: 25.4, h: 3.4, style: "warehouse", role: "storage", seed: 691, wallT: 0.3, openTop: true, density: 0.7,
      finish: { floor: "none", wall: null, dado: null, frames: false, glass: false },
      openings: [D(0, -3.3 - LZx, 3.6, 2.5), D(0, 3.9 - LZx, 1.6, 2.4), W(2, 3 - LZx, 1.3, 1.0, 1.3), W(1, 4, 1.4, 1.0, 1.4), W(1, -4, 1.4, 1.0, 1.4)],
      keepOut: [...solidsAt(BARN.loft, LZx, MZ), { r: [4.15 - LZx, -9.95 - MZ, 5.7 - LZx, -2.35 - MZ], solid: true }, { r: [4.1 - LZx, -11.5 - MZ, 5.7 - LZx, -9.95 - MZ], walk: true }],
    }));
  }
  return out;
})();

export const colliders: Box[] = lazyBoxes([...toBoxes(PIECES), ...interiorColliders(INTERIOR_ROOMS)], () => [...bananaColliders(), ...floraColliders(FLORA, vegTrunkColliders, VARIANTS)]);

// ------------------------------------------------------------------------------------------------ designed loot
/** LOOT_SPOTS (designed-loot contract): chests in the barn (ground, lean-to, loft, deck), the water-tower deck, the
 *  farmhouse (kitchen, bedroom, attic) and every cottage; floor loot along the packing line, loft, veranda, yards */
export const LOOT_SPOTS: LootSpots = (() => {
  const chests: LootSpots["chests"] = [], floor: LootSpots["floor"] = [];
  const at = (f: Frame, lx: number, ly: number, lz: number) => toWorld(f, lx, ly, lz);
  const C = (f: Frame, lx: number, ly: number, lz: number, yaw: number) => { const p = at(f, lx, ly, lz); chests.push([p[0], p[1], p[2], f.yaw + yaw]); };
  const L = (f: Frame, lx: number, ly: number, lz: number) => { const p = at(f, lx, ly, lz); floor.push([p[0], p[1], p[2]]); };
  const B = BARN.frame, loft = BARN.loft, H = FARM.frame;
  C(B, -1.0, loft, -20.0, 0); C(B, -3.5, loft, -9.0, Math.PI / 2); C(B, -15.0, 0.2, -21.5, 0); C(B, 4.4, 0.2, -18.5, Math.PI); C(B, 3.0, loft, 2.0, Math.PI);
  C(F(WTOWER.x, PAD.y, WTOWER.z, WTOWER.yaw), 3.0, WTOWER.legH, 3.0, Math.PI * 0.75);
  // the attic payoff chest in the far gable corner, facing the hatch (mid-attic it sits < 7 m above the ground-floor
  // chest and the generator's spacing never picks it)
  C(H, -4.9, FARM.f2, -2.2, Math.PI / 2);
  L(B, -11.0, 0.2, -10.0); L(B, -11.0, 0.2, -20.0); L(B, -1.0, 0.2, -6.0); L(B, 1.0, 0.2, -20.0); L(B, 0.0, loft, -6.0); L(B, 0.0, loft, -17.0);
  L(B, 4.6, BARN.dock.y, 1.0); L(B, -9.0, 0.0, 10.0); L(B, 7.0, 0.0, 12.0);
  L(H, -3.0, FARM.f0, 5.7); L(H, 3.0, FARM.f1, 5.7);
  // (the porch spot clears the swung-open door leaf, which covers x 1.2)
  L(COTTAGES[1].f, 2.0, 0.0, 4.3); L(COTTAGES[3].f, 2.0, 0.0, 4.3);
  { const W = F(WTOWER.x, PAD.y, WTOWER.z, WTOWER.yaw); L(W, -4.3, WTOWER.legH, -3.0); }
  for (const [x, z, yaw] of FIELD_CHESTS) chests.push([x, PAD.y, z, yaw]);
  // the furnished rooms: the kit's own reachable chest slot + floor slots per room
  const spots = { chests, floor };
  addKitLoot(spots, INTERIOR_ROOMS, interiorLoot);
  settleLoot(spots, [...toBoxes(PIECES), ...interiorColliders(INTERIOR_ROOMS)]);
  return spots;
})();
