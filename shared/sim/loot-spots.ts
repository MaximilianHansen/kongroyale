// LOOT SPOTS. Every candidate loot location is DERIVED from the static collision
// world the server plays on, once per world (cached), then placeLoot (loot.ts) activates a seeded subset per match.
//
//  1. scan   every POI: the undersides of roof / ceiling / upper-floor slabs are sampled on a world-aligned 1.25 m grid;
//            a walkable floor 2.05–7.5 m under a ceiling with room for the kong capsule = an INTERIOR cell. Cells are
//            flood-filled into rooms (same level, no wall between — a knee-height ray) and rooms into buildings (touching
//            footprints or stacked storeys). A room the kong cannot walk out of (the solver's own enclosure test,
//            StaticWorld.findUnstick) is sealed: nothing spawns in it.
//  2. hints  the designed LOOT_SPOTS every POI exports (they already carry the interiors kit's per-room slots) are
//            validated one by one and tagged with the room they stand in; designed chests outside rooms (roofs, towers,
//            decks, the hero landmark) are the POI's landmark spots.
//  3. fill   a room without a designed spot gets scan spots: a chest against a wall (corners first, facing the room) and
//            floor spots spread over the room.
//  4. wild   between POIs: a jittered 95 m lattice of sheltered, flat, dry spots (next to a rock / trunk / wall).
//  5. canon  per POI the candidates are thinned to canonical SPOTS (Poisson-disc, hero first, designed before scan, every
//            room ≥ 1 floor spot, a chest cap per POI) — these are the spots that flip on / off each match.
// Every kept spot passes validateSpot: a walkable floor right under it, its own volume free of colliders, and a place the
// kong can STAND within reach of it with a clear line from the eyes.
import { POIS } from "../world/map";
import { PICKUP_DIST, PLAYER_H, PLAYER_R, SLOPE_LIMIT } from "./const";
import { makeHit, type StaticWorld } from "./world";
import { hotZonesById, interiorRoomsById, lootSpotsById, type HotZone, type KitRoomLite } from "../pois/index";
import { hash32 } from "./rng";
import { furnishRoom, type InteriorRoom } from "../pois/interior-kit";
import { swampWaterAt } from "../pois/the-murk";
import { AMMO_CRATE, CHEST_CRATE, type CrateShape } from "./crate";
import { pathLines } from "../world/terrain-gen";
import { ZIP_LINES } from "./zipline";
import * as dmath from "./dmath";
export { AMMO_CRATE, CHEST_CRATE, type CrateShape };

/** Chest = a weapon chest · Floor = floor loot · Ammo = an ammo box (a small container: ammo, sometimes a heal — no gun;
 * it keeps houses worth entering without inflating the weapon count) */
export const enum SpotKind { Chest = 0, Floor = 1, Ammo = 2 }
/** 0 hero (designed, outside rooms: always on) · 1 designed · 2 scan · 3 wild */
export const enum Src { Hero = 0, Designed = 1, Scan = 2, Wild = 3 }
export interface LootSpot { id: number; kind: SpotKind; src: Src; x: number; y: number; z: number; yaw: number; poi: number; bld: number; room: number;
  /** floor spots: where the ammo that comes with a floor gun lies (validated like the spot; = the spot when none fits) */
  ax?: number; ay?: number; az?: number;
  /** where the kong stands to take it (validateSpot's stand place: in reach, eyes clear) — the bots walk there */
  sx: number; sy: number; sz: number;
  /** the room unit it lies in (SpotSet.units), -1 = none */
  unit?: number;
  /** a POI's PAYOFF chest (LOOT_SPOTS.hero: the Banana Temple vault's dais): always on, a Rare Chest */
  pay?: 1;
  /** 1 = its unit's FALLBACK: placeLoot turns it on when nothing else in the unit is live (never a gun) */
  fb?: number;
  /** a hot building's storey chest: key = building * 16 + storey (16 = its roof); placeLoot keeps ≥ 1 live per key */
  hot?: number;
  /** (house guns) a floor spot kept for the building's guaranteed gun (= its building): off unless placeLoot picks it */
  house?: number;
  /** (house guns) floor spots in enterable buildings: how the bots' walk graph (Nav) gets in — 0 a door at ground level,
   * 1 only a raised door, 2 no door it knows (players walk in; bots give up "noPath") */
  navIn?: number }
/** a ROOM UNIT: every enterable room gets loot by design — an interiors-kit room with a door
 * (≥ 9 m²), a scanned room the kit does not cover, or a storey that has neither. placeLoot keeps ≥ 1 live spot in each. */
export interface Unit { id: number; poi: number; bld: number; storey: number; kind: 0 | 1 | 2; x: number; y: number; z: number; area: number;
  /** kit rooms: the rect (three.js yaw, w / d inner extents) */
  rect?: { x: number; z: number; yaw: number; w: number; d: number } }
export interface Room { id: number; bld: number; poi: number; x: number; y: number; z: number; cells: number; sealed: boolean }
export interface Building { id: number; poi: number; x: number; z: number; cells: number; rooms: number[]; storeys: number; sealed: boolean;
  /** floor cells with a wall within 1.1 m ÷ the perimeter of a square of its area in cells (an awning ≈ 0, a house ≈ 1) */
  walls: number;
  /** a real enterable building (not sealed, ≥ 12 m² of roofed floor, walled) — the "every building" population */
  enterable: boolean;
  /** the storeys' floor heights, low → high: room-cell levels (clustered 1.6 m apart) holding ≥ 8 cells and
   * ≥ 20 % of the biggest level — stair half-landings and closets are not storeys */
  levels: number[];
  /** a HOT building (≥ HOT_CELLS of roofed floor: the Coconut Cove hotel): chests on every storey + its roof */
  hot?: boolean }
export interface Rejected { kind: SpotKind; src: Src; poi: number; x: number; y: number; z: number; why: string }
export interface SpotSet {
  spots: LootSpot[]; rooms: Room[]; buildings: Building[]; rejected: Rejected[];
  /** room units (see Unit) */
  units: Unit[];
  /** (house guns) enterable buildings that got no house-gun spot, and why (for tools) */
  houseless: Array<{ bld: number; poi: number; x: number; z: number; why: string }>;
  /** coverage probes (walkable points on a 16 m lattice of every named POI + every room): the canonical spots within
   * COVER_S of each, nearest first — placeLoot keeps a weapon source live near every probe */
  probes: Array<{ x: number; y: number; z: number; poi: number; near: number[]; t: number[];
    /** a room centre (not a landing point: the canonical thinning serves it, the per-match cover does not) */
    room?: number }>;
  /** the bots' indoor walk graph (every roofed cell of every POI, walk links, doors) — navPath() */
  nav: Nav;
  /** candidates before the canonical thinning (per kind / source) */
  pool: { chest: number; floor: number; designed: number; scan: number; wild: number };
  ms: number;
}

const G = 1.25;                     // scan grid (m)
const HEAD_MIN = 2.05, HEAD_MAX = 7.5;
const ROOM_MIN_CELLS = 4;           // ≈ 6 m²
const LOBBY = "lobby-islet";
/** the promise: a weapon within 10 s of landing anywhere in a named POI; the generator plans for 8 s (slack for the
 * path detours its straight-line estimate misses) */
export const COVER_S = 9.8;
/** the tighter promise: a weapon within 8 s of every landing point — the canonical set covers every landing
 * probe within COVER_T (probes ≤ 5.5 m from any landing point) */
export const COVER_T = 7.6;
/** how far (sprint seconds) each probe's near list reaches — placeLoot's landing cover picks its promise
 * inside it (towns 10.5 s, open POIs 12 s); the canonical set still plans for COVER_S / COVER_T */
export const COVER_NEAR = 12.5;
/** lone-probe spots rejected because their stand place is enclosed (for tools) */
export let rejectedEnclosed = 0;
/** sprint time estimate between two points: 1.25 × the straight line + 2 × the climb (stairs / ramps), + 0.6 s to open a chest */
export const reachTime = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, chest: boolean) =>
  (1.25 * dmath.hypot3(bx - ax, by - ay, bz - az) + 2 * Math.max(0, by - ay)) / 7.4 + (chest ? 0.6 : 0);
/** POI tier for rarity: hot drops 2, other named POIs 1, wilderness 0. The four hot drops — the town, the
 * shipyard, the temple vault and the lab — pay more: richer rarity tables, more of their chests live, vault-grade hero
 * chests (loot.ts). Peel Harbor joined them (its cranes and ship are the island's biggest landmark). */
export const HOT_POIS = new Set(["banana-temple", "cnvs-lab", "mango-market", "peel-harbor"]);
export const poiTier = (poi: number) => poi < 0 ? 0 : HOT_POIS.has(POIS[poi].id) ? 2 : 1;

const H = makeHit(), L = makeHit();
/** the stand spot the last successful validateSpot found */
export const STAND = [0, 0, 0];
const now = () => typeof performance !== "undefined" ? performance.now() : Date.now();
/** build profile (ms) of the last lootSpots() call (for tools) */
export const SPOT_PROF = { scan: 0, link: 0, seal: 0, validate: 0, wild: 0 };

/** can a player standing at (px, py, pz) (feet) use loot at (x, y, z)? Same floor (the loot at most
 * 1.3 m below / 1.5 m above the feet) and a clear line from the chest / eye height to it through the static world
 * (walls, floors, crates block; foliage does not). The server's interact / autoPickup, the client's E prompt and the
 * spot validation (a container's stand place must pass it) share it. */
export function lootReachable(world: StaticWorld, px: number, py: number, pz: number, x: number, y: number, z: number, overStands = false): boolean {
  const dy = y - py;
  if (dy < -1.3 || dy > 1.5) return false;
  // `overStands`: a kong reaches over a Banana Stand's waist-high counter — the pickups ask for it (shared/sim/pickup.ts,
  // Match.autoPickup); the loot generator / stand placement keep the default
  const cs = overStands ? world.cover : null;
  if (cs === null) return reachRays(world, px, py, pz, x, y, z);
  cs.skipPerm = true;
  const ok = reachRays(world, px, py, pz, x, y, z);
  cs.skipPerm = false;
  return ok;
}
function reachRays(world: StaticWorld, px: number, py: number, pz: number, x: number, y: number, z: number): boolean {
  for (const eh of [1.0, 1.6]) {
    const oy = py + eh, ty = y + 0.4, dx = x - px, dyy = ty - oy, dz = z - pz;
    world.raycast(px, oy, pz, dx, dyy, dz, 1, REACH_HIT, true);
    if (!REACH_HIT.hit || REACH_HIT.t > 0.97) return true;
    // the ray ended on the chest's own supporting surface / a box within 25 cm of the loot: still fine
    if (dmath.hypot(REACH_HIT.x - x, REACH_HIT.z - z) < 0.3 && Math.abs(REACH_HIT.y - ty) < 0.5) return true;
  }
  return false;
}
const REACH_HIT = makeHit();

/** a container's stand place: 0.8–1.6 m in front of its face (the crate is ≤ 0.62 m deep → 1.1–1.95 m
 * from its centre), on its floor, the box in view — never ON the box. Fixed-yaw containers (against a wall) search a ±45°
 * cone in front; free ones (outdoors) search all round and then turn to face the place found. */
const STAND_D = [1.35, 1.6, 1.15, 1.85];
const CONE = [0, 0.26, -0.26, 0.52, -0.52, 0.79, -0.79];

/** Is this a real loot spot? Floor within 0.3 m under it (walkable), its volume free, and a standing place for the kong
 * within reach with eyes → loot clear (containers: in front of the face, see STAND_D). Returns the settled floor y and the
 * container's yaw (turned to face its stand place when `free`), or a reason. */
export function validateSpot(world: StaticWorld, kind: SpotKind, x: number, y: number, z: number, yaw = 0, free = true): { x: number; y: number; z: number; yaw: number; why: string | null } {
  const t0 = now();
  try { return validateIn(world, kind, x, y, z, yaw, free); } finally { SPOT_PROF.validate += now() - t0; }
}
function standOk(world: StaticWorld, sx: number, sz: number, fy: number, maxDy: number): number {
  world.raycast(sx, fy + 1.2, sz, 0, -1, 0, 2.4, L, false);
  if (!L.hit || L.ny < SLOPE_LIMIT) return NaN;
  const sy = L.y; if (Math.abs(sy - fy) > maxDy) return NaN;
  world.velY = 0; world.headBump = false;
  world.resolveCapsule(sx, sy + 0.02, sz, PLAYER_R, PLAYER_H, false);
  if (world.headBump || dmath.hypot(world.P[0] - sx, world.P[2] - sz) > 0.04 || Math.abs(world.P[1] - (sy + 0.02)) > 0.06) return NaN;
  return sy;
}
/** the loot's floor right under (x, y, z) and its own volume free: the settled floor y, or a reason (in `FLOOR_WHY`) */
let FLOOR_WHY = "";
function floorAt(world: StaticWorld, x: number, y: number, z: number): number {
  world.raycast(x, y + 0.3, z, 0, -1, 0, 0.6, H, false);
  if (!H.hit) { FLOOR_WHY = "floating (no floor within 0.3 m)"; return NaN; }
  if (H.ny < SLOPE_LIMIT) { FLOOR_WHY = `floor too steep (ny ${H.ny.toFixed(2)})`; return NaN; }
  if (H.y < 0.15 && H.box < 0) { FLOOR_WHY = "in the sea"; return NaN; }
  // nor under THE MURK's tea (the sim's sea is y 0, the swamp's drawn surface is 0.78 m): no chests or
  // guns knee-deep in the water of the channels
  if (H.box < 0) { const sw = swampWaterAt(x, z); if (sw !== null && H.y < sw - 0.05) { FLOOR_WHY = "under the swamp water"; return NaN; } }
  const fy = H.y;
  world.velY = 0; world.headBump = false;
  // Both item-volume tolerances must clear; solver pushes near intersecting furniture need not be monotonic in radius.
  world.resolveCapsule(x, fy + 0.02, z, 0.3, 0.6, false);
  if (dmath.hypot(world.P[0] - x, world.P[2] - z) > 0.03 || world.P[1] - (fy + 0.02) > 0.05 || world.headBump) { FLOOR_WHY = "inside a collider"; return NaN; }
  world.velY = 0; world.headBump = false;
  world.resolveCapsule(x, fy + 0.02, z, 0.33, 0.6, false);
  if (dmath.hypot(world.P[0] - x, world.P[2] - z) > 0.03 || world.P[1] - (fy + 0.02) > 0.05 || world.headBump) { FLOOR_WHY = "inside a collider"; return NaN; }
  return fy;
}
function validateIn(world: StaticWorld, kind: SpotKind, x: number, y: number, z: number, yaw: number, free: boolean): { x: number; y: number; z: number; yaw: number; why: string | null } {
  let fy = floorAt(world, x, y, z);
  if (fy !== fy) return { x, y, z, yaw, why: FLOOR_WHY };
  if (kind !== SpotKind.Floor) {
    // the whole crate and its swinging lid must fit: a container whose body or open lid would
    // poke through a wall, a shelf or a ceiling slides out from the wall (forward / sideways, ≤ 0.95 m) to where it fits —
    // on the same floor — or is rejected. A free-standing one turns to its stand place: only a turn that fits counts.
    const S = kind === SpotKind.Ammo ? AMMO_CRATE : CHEST_CRATE;
    if (!free && crateClear(world, S, x, fy, z, yaw) !== null) {
      const f = fitCrate(world, S, x, fy, z, yaw);
      if (!f) return { x, y: fy, z, yaw, why: "lid / crate would go through a wall" };
      const ny = floorAt(world, FIT[0], fy, FIT[1]);
      if (ny !== ny || Math.abs(ny - fy) > 0.12 || crateClear(world, S, FIT[0], ny, FIT[1], yaw) !== null) return { x, y: fy, z, yaw, why: "lid / crate would go through a wall" };
      x = FIT[0]; z = FIT[1]; fy = ny;
    }
    const n = free ? 24 : CONE.length;
    for (const d of STAND_D) for (let k = 0; k < n; k++) {
      const a = yaw + (free ? (k / n) * Math.PI * 2 : CONE[k]), sx = x + dmath.sin(a) * d, sz = z + dmath.cos(a) * d;
      const sy = standOk(world, sx, sz, fy, 0.45); if (sy !== sy) continue;
      world.raycast(sx, sy + 1.5, sz, x - sx, fy + 0.35 - (sy + 1.5), z - sz, 1, L, true); if (L.hit && L.t < 0.97) continue;
      if (!lootReachable(world, sx, sy, sz, x, fy, z)) continue;
      if (!world.mobile(sx, sy + 0.02, sz, PLAYER_R, PLAYER_H)) continue;
      const fyaw = free ? dmath.atan2(sx - x, sz - z) : yaw;
      if (free && crateClear(world, S, x, fy, z, fyaw) !== null) continue;
      STAND[0] = sx; STAND[1] = sy; STAND[2] = sz;
      return { x, y: fy, z, yaw: fyaw, why: null };
    }
    return { x, y: fy, z, yaw, why: "no standing place in front of it" };
  }
  const R = PICKUP_DIST;
  for (const d of [0, 0.75, 1.15, 1.55, 1.95, Math.min(2.35, R - 0.1)]) {
    const n = d === 0 ? 1 : 12;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2, sx = x + dmath.cos(a) * d, sz = z + dmath.sin(a) * d;
      const sy = standOk(world, sx, sz, fy, 1.0); if (sy !== sy) continue;
      if (d > 0.05) { world.raycast(sx, sy + 1.5, sz, x - sx, fy + 0.35 - (sy + 1.5), z - sz, 1, L, true); if (L.hit && L.t < 0.97) continue; }
      // the place you stand to take it must not be a pocket (the real solver walks 1.5 m away from it)
      if (!world.mobile(sx, sy + 0.02, sz, PLAYER_R, PLAYER_H)) continue;
      STAND[0] = sx; STAND[1] = sy; STAND[2] = sz;
      return { x, y: fy, z, yaw, why: null };
    }
  }
  return { x, y: fy, z, yaw, why: "no standing spot in reach with a clear view" };
}

// ------------------------------------------------------------------------------------------------ container clearance
// Open and closed, a crate must stay inside its building. The drawn crates, in their local frame (origin = floor
// centre, +Z = the front, the lid hinged at the back top edge, swinging up and back to `open` rad):
// client/src/weapons/chest-geo.ts CUBE + chest.ts OPEN_A and client/src/game/ammobox.ts — the shapes live in
// ./crate.ts (the client imports its open angles from there).
const CH = makeHit();
/** the last crate ray met a wall, a shelf or a ceiling — a collider, or the terrain well above the crate's floor (a
 * hillside behind it); the ground a crate stands on a slope with is not a wall (its skids sink a few cm uphill) */
const solidAt = (floorY: number) => CH.box >= 0 || CH.y > floorY + 0.35;
/** the lid's outline in hinge space ([up, forward] pairs) */
const LID_PTS = (S: CrateShape): Array<[number, number]> => [[S.lt, 0], [S.lt, S.ld], [0, S.ld], [S.lt, S.ld / 2]];
/** null = the closed crate AND its lid at every point of the swing stay in free space; else what pokes through. Rays from
 * the crate's centre (inside its own validated volume) to the body corners and to the lid outline half and fully open. */
export function crateClear(world: StaticWorld, S: CrateShape, x: number, y: number, z: number, yaw: number): string | null {
  const c = dmath.cos(yaw), s = dmath.sin(yaw), ox = x, oy = y + Math.min(0.55, S.h * 0.6), oz = z;
  const hit = (lx: number, ly: number, lz: number) => {
    const wx = x + lx * c + lz * s, wy = y + ly, wz = z - lx * s + lz * c;
    world.raycast(ox, oy, oz, wx - ox, wy - oy, wz - oz, 1, CH, false);
    return CH.hit && CH.t < 0.999 && solidAt(y);
  };
  for (const lx of [-S.hw + 0.02, S.hw - 0.02]) for (const ly of [0.1, S.h - 0.02]) for (const lz of [S.front - 0.02, -S.back + 0.02]) if (hit(lx, ly, lz)) return "body";
  for (const a of [S.open * 0.5, S.open]) {
    const ca = dmath.cos(a), sa = dmath.sin(a);
    for (const [yr, zr] of LID_PTS(S)) {
      const ly = S.hy + yr * ca + zr * sa, lz = S.hz - yr * sa + zr * ca;
      for (const lx of [-S.hw + 0.02, 0, S.hw - 0.02]) if (hit(lx, ly, lz)) return "lid";
    }
  }
  return null;
}
/** how far behind the centre the open lid reaches (m) and how high the swing goes (m above the floor) */
function lidReach(S: CrateShape): [number, number] {
  let back = 0, top = 0;
  for (let k = 0; k <= 8; k++) {
    const a = S.open * k / 8, ca = dmath.cos(a), sa = dmath.sin(a);
    for (const [yr, zr] of LID_PTS(S)) { back = Math.max(back, -(S.hz - yr * sa + zr * ca)); top = Math.max(top, S.hy + yr * ca + zr * sa); }
  }
  return [back, top];
}
/** where the crate fits: slid forward off the wall behind it (the body's back, then the open lid's back, + 4 cm) and
 * sideways off a wall beside it, its front still clear. Writes FIT[0..1] = (x, z); false = it cannot fit here. */
const FIT = [0, 0];
function fitCrate(world: StaticWorld, S: CrateShape, x: number, y: number, z: number, yaw: number): boolean {
  const fx = dmath.sin(yaw), fz = dmath.cos(yaw), rx = dmath.cos(yaw), rz = -dmath.sin(yaw);
  const [lb, lt] = lidReach(S);
  let shF = 0;
  for (const lx of [-S.hw + 0.05, 0, S.hw - 0.05]) {
    const ox = x + rx * lx, oz = z + rz * lx;
    for (const [h, need] of [[0.3, S.back], [S.h * 0.75, S.back], [S.hy + 0.3, lb], [Math.min(lt - 0.08, S.hy + 0.75), lb]] as Array<[number, number]>) {
      world.raycast(ox, y + h, oz, -fx, 0, -fz, need + 1.2, CH, false);
      if (CH.hit && solidAt(y)) shF = Math.max(shF, need + 0.04 - CH.t);
    }
  }
  if (shF > 0.95) return false;
  let nx = x + fx * shF, nz = z + fz * shF;
  // sideways: the nearest wall on each side, at the body's back / middle / front and three heights
  let left = Infinity, right = Infinity;
  for (const lz of [-S.back + 0.05, 0, S.front - 0.05]) for (const h of [0.3, S.h * 0.75, S.hy + 0.4]) {
    const ox = nx + fx * lz, oz = nz + fz * lz;
    world.raycast(ox, y + h, oz, rx, 0, rz, S.hw + 0.8, CH, false); if (CH.hit && solidAt(y)) right = Math.min(right, CH.t);
    world.raycast(ox, y + h, oz, -rx, 0, -rz, S.hw + 0.8, CH, false); if (CH.hit && solidAt(y)) left = Math.min(left, CH.t);
  }
  const need = S.hw + 0.04;
  let shR = 0;
  if (right < need && left < need) { if (right + left < 2 * need) return false; shR = (right - left) / 2; }
  else if (right < need) shR = right - need; else if (left < need) shR = need - left;
  if (Math.abs(shR) > 0.6) return false;
  nx += rx * shR; nz += rz * shR;
  // the front still clear
  world.raycast(nx, y + 0.3, nz, fx, 0, fz, S.front + 0.04, CH, false); if (CH.hit && solidAt(y)) return false;
  FIT[0] = nx; FIT[1] = nz;
  return true;
}

// ------------------------------------------------------------------------------------------------ walk reachability
// Can the kong WALK from (x, y, z) out of the building? The solver's findUnstick floods ±10 m and only 4.5 m down, so
// it calls every storey above the second of a tall Mango house "enclosed" (and they would hold no loot). This is the
// stairs tool's fine walk graph (tools/buildings/walkgraph.mts: every standable surface of every 0.4 m column, the
// capsule resolved with step-up, links ≤ 1.0 m apart / ≤ 0.5 m rise with knee + chest + capsule-width rays clear),
// built LAZILY around the query: a breadth-first walk that stops as soon as it stands on the island's ground (terrain
// above the sea) or WALK_OUT_D m from the start. Results are memoised per world (every node a finished walk visited
// shares its answer), so a building costs one walk.
const FGR = 0.4, WALK_OUT_D = 24, WALK_CAP = 30000;
interface FineCol { x: Float32Array; y: Float32Array; z: Float32Array; ground: Uint8Array }
interface FineState { cols: Map<number, FineCol>; mark: Map<number, number> }
const FINE = new WeakMap<StaticWorld, FineState>();
const FH = makeHit();
const fkey = (i: number, j: number) => (i + 65536) * 131072 + (j + 65536);
function fineCol(world: StaticWorld, st: FineState, i: number, j: number): FineCol {
  const k = fkey(i, j); let c = st.cols.get(k); if (c) return c;
  const x = (i + 0.5) * FGR, z = (j + 0.5) * FGR, X: number[] = [], Y: number[] = [], Z: number[] = [], Gd: number[] = [];
  let y = Math.max(0, world.terrain.height(x, z)) + 60;
  for (let guard = 0; guard < 32; guard++) {
    world.raycast(x, y, z, 0, -1, 0, y + 50, FH, false);
    if (!FH.hit) break;
    const hy = FH.y, bi = FH.box;
    if (FH.ny >= 0.7) {
      world.velY = 0; world.headBump = false; world.resolveCapsule(x, hy + 0.02, z, PLAYER_R, PLAYER_H, true);
      if (!world.headBump && dmath.hypot(world.P[0] - x, world.P[2] - z) < 0.3 && world.P[1] - hy - 0.02 < 0.5 && world.P[1] - hy > -0.05) { X.push(world.P[0]); Y.push(world.P[1] - 0.02); Z.push(world.P[2]); Gd.push(bi < 0 && hy > 0.15 ? 1 : 0); }
    }
    if (bi < 0) break;
    y = world.cy[bi] - world.hy[bi] - 0.02;
  }
  c = { x: Float32Array.from(X), y: Float32Array.from(Y), z: Float32Array.from(Z), ground: Uint8Array.from(Gd) };
  st.cols.set(k, c); return c;
}
/** tools: walks run / nodes visited / ms since the last reset */
// Walking must include glass/rails marked noShoot; bullet visibility is not a movement edge.
const WALK_HIT = makeHit();
export function walkClear(world: StaticWorld, ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
  world.raycast(ax, ay, az, bx - ax, by - ay, bz - az, 1, WALK_HIT, false);
  return !WALK_HIT.hit || WALK_HIT.t >= 0.999;
}
export const WALK_PROF = { walks: 0, nodes: 0, ms: 0 };
export function walkReach(world: StaticWorld, x: number, y: number, z: number): boolean {
  let st = FINE.get(world); if (!st) FINE.set(world, st = { cols: new Map(), mark: new Map() });
  const t0 = now(); WALK_PROF.walks++;
  try {
    const i0 = Math.floor(x / FGR), j0 = Math.floor(z / FGR);
    let src = -1, bd = 1e9;
    for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) {
      const c = fineCol(world, st, i0 + a, j0 + b);
      for (let q = 0; q < c.y.length; q++) { const dy = Math.abs(c.y[q] - y); if (dy > 0.6) continue; const d = dmath.hypot(c.x[q] - x, c.z[q] - z) + dy; if (d < bd && walkClear(world, x, Math.max(y, c.y[q]) + 0.62, z, c.x[q], Math.max(y, c.y[q]) + 0.62, c.z[q]) && walkClear(world, x, Math.max(y, c.y[q]) + 1.5, z, c.x[q], Math.max(y, c.y[q]) + 1.5, c.z[q])) { bd = d; src = fkey(i0 + a, j0 + b) * 32 + q; } }
    }
    if (src < 0) return false;
    const m0 = st.mark.get(src); if (m0) return m0 === 1;
    const seen = new Set<number>([src]), queue: number[] = [src];
    let out = false;
    for (let h = 0; h < queue.length && !out; h++) {
      if (queue.length > WALK_CAP) break; // exhausted search budget is not proof of an exit
      const nk = queue[h], ck = Math.floor(nk / 32), q = nk - ck * 32;
      const ci = Math.floor(ck / 131072) - 65536, cj = ck - (ci + 65536) * 131072 - 65536;
      const A = fineCol(world, st, ci, cj), ax = A.x[q], ay = A.y[q], az = A.z[q];
      for (let a = -1; a <= 1 && !out; a++) for (let b = -1; b <= 1 && !out; b++) {
        if (!a && !b) continue;
        const B = fineCol(world, st, ci + a, cj + b), bk = fkey(ci + a, cj + b) * 32;
        for (let r = 0; r < B.y.length; r++) {
          const id = bk + r; if (seen.has(id)) continue;
          const bx = B.x[r], by = B.y[r], bz = B.z[r], d = dmath.hypot(bx - ax, bz - az);
          if (Math.abs(by - ay) > 0.5 || d > 1.0 || d < 0.04) continue;
          const ya = Math.max(ay, by);
          if (!walkClear(world, ax, ya + 0.62, az, bx, ya + 0.62, bz) || !walkClear(world, ax, ya + 1.5, az, bx, ya + 1.5, bz)) continue;
          const ux = (bz - az) / d * 0.3, uz = -(bx - ax) / d * 0.3;
          if (!walkClear(world, ax + ux, ya + 0.62, az + uz, bx + ux, ya + 0.62, bz + uz) || !walkClear(world, ax - ux, ya + 0.62, az - uz, bx - ux, ya + 0.62, bz - uz)) continue;
          const mx = (ax + bx) / 2, mz = (az + bz) / 2;
          world.velY = 0; world.headBump = false;
          world.resolveCapsule(mx, ya + 0.02, mz, PLAYER_R, PLAYER_H, true);
          if (world.headBump || dmath.hypot(world.P[0] - mx, world.P[2] - mz) > 0.1 || world.P[1] > ya + 0.52) continue;
          seen.add(id); queue.push(id);
          const m = st.mark.get(id);
          if (m === 1 || B.ground[r] || dmath.hypot(bx - x, bz - z) >= WALK_OUT_D) { out = true; break; }
        }
      }
    }
    WALK_PROF.nodes += seen.size;
    // a finished walk: every node it visited shares the answer (a successful one stopped early — its nodes still reach out)
    for (const id of seen) st.mark.set(id, out ? 1 : 2);
    return out;
  } finally { WALK_PROF.ms += now() - t0; }
}
/** is the kong standing at (x, y, z) able to walk out? findUnstick first (cheap: an open flood says yes),
 * then the fine walk graph down the stairs (findUnstick cannot see past 4.5 m of drop) */
export function walkable(world: StaticWorld, x: number, y: number, z: number): boolean {
  world.findUnstick(x, y + 0.02, z, PLAYER_R, PLAYER_H);
  if (world.enclosedAt < 0) return true;
  return walkReach(world, x, y, z);
}

// ------------------------------------------------------------------------------------------------ the interior scan
interface Cell { ix: number; iz: number; x: number; y: number; z: number; room: number }
/** the indoor walk graph the scan finds for free: roofed cells (1.25 m), links between walkable neighbours (stairs
 * included: ≤ 0.9 m rise per cell), and exits (a cell with a clear step to a standable place outside the roofed set).
 * Bots path through it to loot inside buildings (door → rooms → stairs → the spot) instead of hugging the outer wall. */
export interface Nav {
  n: number; x: Float32Array; y: Float32Array; z: Float32Array;
  /** walk component (a building's rooms + its indoor stairs) */
  comp: Int32Array;
  adjStart: Int32Array; adj: Int32Array;
  /** per cell: the outside point of its exit (x, y, z), NaN when the cell is not at a door */
  ex: Float32Array;
  /** grid column (1.25 m) → cell ids */
  col: Map<number, number[]>;
  /** the building (SpotSet.buildings index) each cell belongs to, -1 = none (a covered street, a lone cell) */
  bld: Int32Array;
  /** the room (SpotSet.rooms index) each cell belongs to, -1 = none (stairs, nooks < 4 cells) */
  room: Int32Array;
}
/** exit probe directions: straight out first (doors), diagonals last */
const EXIT_DIRS: ReadonlyArray<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const colKey = (ix: number, iz: number) => (ix + 4096) * 8192 + (iz + 4096);
/** the nav cell under (x, y, z): same level (feet within 0.7 m), nearest within 1.3 m; -1 = outdoors */
export function navCellAt(nav: Nav, x: number, y: number, z: number): number {
  const ix = Math.floor(x / G), iz = Math.floor(z / G);
  let best = -1, bd = 1.3;
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
    const col = nav.col.get(colKey(ix + a, iz + b)); if (!col) continue;
    for (const j of col) { const dy = Math.abs(nav.y[j] - y); if (dy > 0.7) continue; const d = dmath.hypot(nav.x[j] - x, nav.z[j] - z) + dy * 0.5; if (d < bd) { bd = d; best = j; } }
  }
  return best;
}
let BFS_D = new Int32Array(0), BFS_P = new Int32Array(0), BFS_Q = new Int32Array(0), BFS_STAMP = new Int32Array(0), STAMP = 0;
/** a walk route from (fx, fy, fz) to nav cell `to`: waypoints (x, y, z) into `out`, returns their count (0 = no route).
 * From outdoors the route enters through the exit that minimises (straight line to its outside point + walk inside). */
export function navPath(nav: Nav, fx: number, fy: number, fz: number, to: number, out: Float32Array, terrain?: { height(x: number, z: number): number }): number {
  if (to < 0) return 0;
  if (BFS_D.length < nav.n) { BFS_D = new Int32Array(nav.n); BFS_P = new Int32Array(nav.n); BFS_Q = new Int32Array(nav.n); BFS_STAMP = new Int32Array(nav.n); }
  const from = navCellAt(nav, fx, fy, fz), cap = out.length / 3;
  let n = 0;
  // inside ANOTHER building (or a covered street): first walk out of it through its nearest door
  if (from >= 0 && nav.comp[from] !== nav.comp[to]) {
    let exit = bfs(nav, from, -1, fx, fy, fz, true, true);           // a door that leads outdoors first
    if (exit < 0) exit = bfs(nav, from, -1, fx, fy, fz, true);
    if (exit < 0) return 0;
    n = emit(nav, exit, out, 0, cap);                          // parents point to `from`: reversed below
    // reverse the cells (they were written exit → from) and append the door's outside point
    for (let i = 0, j = n - 1; i < j; i++, j--) for (let k = 0; k < 3; k++) { const t = out[i * 3 + k]; out[i * 3 + k] = out[j * 3 + k]; out[j * 3 + k] = t; }
    if (n < cap) { out[n * 3] = nav.ex[exit * 3]; out[n * 3 + 1] = nav.ex[exit * 3 + 1]; out[n * 3 + 2] = nav.ex[exit * 3 + 2]; n++; }
    fx = nav.ex[exit * 3]; fy = nav.ex[exit * 3 + 1]; fz = nav.ex[exit * 3 + 2];
  }
  const inside = from >= 0 && nav.comp[from] === nav.comp[to];
  const entry = bfs(nav, to, inside ? from : -1, fx, fy, fz, false);
  if (entry < 0) return 0;
  // a RAISED door (a balcony, a terrace up an outdoor stair) has no route from the ground: the bot's
  // outdoor leg only steers. Measured from the terrain at the door when known — against the bot's own feet every door
  // up a slope is "above" from 50 m downhill (300+ dropped targets per 6 matches in the hilly POIs). A bot already on
  // the door's level (a deck, a walkway) still goes in.
  if (!inside) {
    const ex = nav.ex[entry * 3], ey = nav.ex[entry * 3 + 1], ez = nav.ex[entry * 3 + 2];
    const raised = terrain ? ey - Math.max(0, terrain.height(ex, ez)) > 1.6 : ey - fy > 1.6;
    if (raised && ey - fy > 1.6) return 0;                          // (a door below: walk off the roof / ledge to it)
  }
  if (!inside && n < cap) { out[n * 3] = nav.ex[entry * 3]; out[n * 3 + 1] = nav.ex[entry * 3 + 1]; out[n * 3 + 2] = nav.ex[entry * 3 + 2]; n++; }
  // parents point toward `to`: walk them from the entry cell
  return emit(nav, entry, out, n, cap);
}
/** the door (exit cell) nearest by walk to nav cell `c`, -1 = none; its outside point is nav.ex[i * 3 ..].
 * A door whose outside point lies on ANOTHER walk component is a doorway into the next roofed area,
 * not a way out: two such areas would each send a bot to the other's threshold and it would rock across the sill for
 * minutes (Banana Temple's galleries). A door that really leads outdoors wins; only without one does an inner doorway count. */
export function navDoor(nav: Nav, c: number, avoid: Int32Array | null = null): number {
  if (c < 0) return -1;
  if (BFS_D.length < nav.n) { BFS_D = new Int32Array(nav.n); BFS_P = new Int32Array(nav.n); BFS_Q = new Int32Array(nav.n); BFS_STAMP = new Int32Array(nav.n); }
  const out = bfs(nav, c, -1, 0, 0, 0, true, true, avoid);
  return out >= 0 ? out : bfs(nav, c, -1, 0, 0, 0, true, false, avoid);
}
/** exit cell `a` leads outdoors: its outside point is on no walk cell of another component */
function exitsOutdoors(nav: Nav, a: number): boolean {
  const k = navCellAt(nav, nav.ex[a * 3], nav.ex[a * 3 + 1], nav.ex[a * 3 + 2]);
  return k < 0 || nav.comp[k] === nav.comp[a];
}
/** BFS over one walk component from `src`: returns `goal` when given (else the exit cell that minimises walk + the
 * straight line from (fx, fy, fz) to its outside point; `nearest` = the exit closest in walk distance) */
function bfs(nav: Nav, src: number, goal: number, fx: number, fy: number, fz: number, nearest: boolean, outdoor = false, avoid: Int32Array | null = null): number {
  STAMP++;
  let qh = 0, qt = 0; BFS_Q[qt++] = src; BFS_D[src] = 0; BFS_P[src] = -1; BFS_STAMP[src] = STAMP;
  let best = -1, bestCost = Infinity;
  while (qh < qt) {
    const a = BFS_Q[qh++];
    if (goal >= 0) { if (a === goal) return a; }
    else if (nav.ex[a * 3] === nav.ex[a * 3] && (!outdoor || exitsOutdoors(nav, a)) && !(avoid && avoid.includes(a))) {
      if (nearest) return a;
      const c = BFS_D[a] * G + dmath.hypot(nav.ex[a * 3] - fx, nav.ex[a * 3 + 2] - fz) + Math.abs(nav.ex[a * 3 + 1] - fy) * 12;
      if (c < bestCost) { bestCost = c; best = a; }
    }
    if (BFS_D[a] > 400) break;
    for (let q = nav.adjStart[a]; q < nav.adjStart[a + 1]; q++) {
      const b = nav.adj[q]; if (BFS_STAMP[b] === STAMP) continue;
      BFS_STAMP[b] = STAMP; BFS_D[b] = BFS_D[a] + 1; BFS_P[b] = a; BFS_Q[qt++] = b;
    }
  }
  return goal >= 0 ? -1 : best;
}
/** the parent chain from `a` as waypoints (every cell: the follower skips ahead along clear straight lines) */
function emit(nav: Nav, a: number, out: Float32Array, n: number, cap: number): number {
  while (a >= 0 && n < cap) { out[n * 3] = nav.x[a]; out[n * 3 + 1] = nav.y[a]; out[n * 3 + 2] = nav.z[a]; n++; a = BFS_P[a]; }
  return n;
}
class UF {
  p: Int32Array;
  constructor(n: number) { this.p = new Int32Array(n); for (let i = 0; i < n; i++) this.p[i] = i; }
  f(a: number): number { while (this.p[a] !== a) { this.p[a] = this.p[this.p[a]]; a = this.p[a]; } return a; }
  u(a: number, b: number) { a = this.f(a); b = this.f(b); if (a !== b) { if (a < b) this.p[b] = a; else this.p[a] = b; } }
}

/** a fine (2 m) index of the walk colliders around one POI — the world's own broadphase is 24 m, far too coarse for
 * tens of thousands of 1 m probes in a furnished town */
class LocalBoxes {
  readonly FG = 2; x0: number; z0: number; n: number; start: Int32Array; items: Int32Array;
  constructor(readonly w: StaticWorld, cx: number, cz: number, r: number) {
    const FG = this.FG; this.x0 = cx - r; this.z0 = cz - r; this.n = Math.ceil((2 * r) / FG);
    const ids: number[] = [], spans: number[] = [];
    const counts = new Int32Array(this.n * this.n);
    for (let i = 0; i < w.n; i++) {
      if (w.noWalk[i]) continue;
      const c = w.cos[i], s = w.sin[i], ex = Math.abs(c) * w.hx[i] + Math.abs(s) * w.hz[i], ez = Math.abs(s) * w.hx[i] + Math.abs(c) * w.hz[i];
      const a0 = Math.floor((w.cx[i] - ex - this.x0) / FG), a1 = Math.floor((w.cx[i] + ex - this.x0) / FG), b0 = Math.floor((w.cz[i] - ez - this.z0) / FG), b1 = Math.floor((w.cz[i] + ez - this.z0) / FG);
      if (a1 < 0 || b1 < 0 || a0 >= this.n || b0 >= this.n) continue;
      const A0 = Math.max(0, a0), A1 = Math.min(this.n - 1, a1), B0 = Math.max(0, b0), B1 = Math.min(this.n - 1, b1);
      ids.push(i); spans.push(A0, A1, B0, B1);
      for (let b = B0; b <= B1; b++) for (let a = A0; a <= A1; a++) counts[b * this.n + a]++;
    }
    this.start = new Int32Array(counts.length + 1);
    for (let k = 0; k < counts.length; k++) this.start[k + 1] = this.start[k] + counts[k];
    this.items = new Int32Array(this.start[counts.length]);
    const fill = new Int32Array(counts.length);
    for (let q = 0; q < ids.length; q++) { const [A0, A1, B0, B1] = spans.slice(q * 4, q * 4 + 4); for (let b = B0; b <= B1; b++) for (let a = A0; a <= A1; a++) { const k = b * this.n + a; this.items[this.start[k] + fill[k]++] = ids[q]; } }
  }
  private cellOf(x: number, z: number) { const a = Math.floor((x - this.x0) / this.FG), b = Math.floor((z - this.z0) / this.FG); return a < 0 || b < 0 || a >= this.n || b >= this.n ? -1 : b * this.n + a; }
  /** highest walk surface at (x, z) with its top ≤ y0 and ≥ y0 - drop: a box top (the sim treats every box as its
   * vertical AABB) or the terrain. NaN = nothing. Out: ny (1 on box tops) */
  ny = 1;
  floorBelow(x: number, y0: number, z: number, drop: number): number {
    const w = this.w; let best = w.terrain.height(x, z); this.ny = best <= y0 ? w.terrain.normal(x, z)[1] : 0;
    if (best > y0) best = -Infinity;
    const k = this.cellOf(x, z);
    if (k >= 0) for (let q = this.start[k]; q < this.start[k + 1]; q++) {
      const i = this.items[q], top = w.cy[i] + w.hy[i];
      if (top > y0 || top <= best) continue;
      const rx = x - w.cx[i], rz = z - w.cz[i], lx = rx * w.cos[i] + rz * w.sin[i], lz = -rx * w.sin[i] + rz * w.cos[i];
      if (Math.abs(lx) > w.hx[i] || Math.abs(lz) > w.hz[i]) continue;
      best = top; this.ny = 1;
    }
    return best >= y0 - drop ? best : NaN;
  }
  /** does a walk collider cut the horizontal segment a → b at height y? */
  blocked(ax: number, az: number, bx: number, bz: number, y: number): boolean {
    const w = this.w, ka = this.cellOf(ax, az), kb = this.cellOf(bx, bz);
    for (const k of ka === kb ? [ka] : [ka, kb]) {
      if (k < 0) continue;
      for (let q = this.start[k]; q < this.start[k + 1]; q++) {
        const i = this.items[q];
        if (y < w.cy[i] - w.hy[i] || y > w.cy[i] + w.hy[i]) continue;
        const c = w.cos[i], s = w.sin[i];
        const rx = ax - w.cx[i], rz = az - w.cz[i];
        const ox = rx * c + rz * s, oz = -rx * s + rz * c;
        const ddx = bx - ax, ddz = bz - az, dx = ddx * c + ddz * s, dz = -ddx * s + ddz * c;
        let t0 = 0, t1 = 1;
        const hx = w.hx[i], hz = w.hz[i];
        if (Math.abs(dx) < 1e-9) { if (ox < -hx || ox > hx) continue; } else { let a = (-hx - ox) / dx, b = (hx - ox) / dx; if (a > b) { const t = a; a = b; b = t; } t0 = Math.max(t0, a); t1 = Math.min(t1, b); if (t0 > t1) continue; }
        if (Math.abs(dz) < 1e-9) { if (oz < -hz || oz > hz) continue; } else { let a = (-hz - oz) / dz, b = (hz - oz) / dz; if (a > b) { const t = a; a = b; b = t; } t0 = Math.max(t0, a); t1 = Math.min(t1, b); if (t0 > t1) continue; }
        return true;
      }
    }
    return false;
  }
}

/** a POI's loot-scan radius: r + 6, grown to hold every declared kit room (+ 4 m), at most 1.4 r */
export function scanRadius(pi: number, kits: KitRoomLite[] = []): number {
  const poi = POIS[pi];
  let R = poi.r + 6;
  for (const k of kits) R = Math.max(R, dmath.hypot(k.x - poi.x, k.z - poi.z) + dmath.hypot(k.w, k.d) / 2 + 4);
  return Math.min(R, poi.r * 1.4);
}
/** does POI `pi` own the point (x, z)? — the POI with the smallest distance / radius among those whose (r + 6 m) covers it */
function ownsCell(pi: number, x: number, z: number): boolean {
  const own = dmath.hypot(x - POIS[pi].x, z - POIS[pi].z) / POIS[pi].r;
  for (let q = 0; q < POIS.length; q++) {
    if (q === pi || POIS[q].id === LOBBY) continue;
    const d = dmath.hypot(x - POIS[q].x, z - POIS[q].z);
    if (d < POIS[q].r + 6 && d / POIS[q].r < own) return false;
  }
  return true;
}
/** tools only: the baseline census without door links (globalThis.__krNoDoorLinks = true before import) */
const NO_DOOR_LINKS = !!(globalThis as { __krNoDoorLinks?: boolean }).__krNoDoorLinks;
/** tools only: the baseline generator without room units / hot chests (globalThis.__krNoUnits = true before import) */
const NO_UNITS = !!(globalThis as { __krNoUnits?: boolean }).__krNoUnits;
/** is there a doorway between cells A and B beside their centre line? (see the link loop in scanPoi) */
function doorLink(world: StaticWorld, LB: LocalBoxes, A: Cell, B: Cell): boolean {
  let dx = B.x - A.x, dz = B.z - A.z; const L = dmath.hypot(dx, dz) || 1; dx /= L; dz /= L;
  const y = Math.max(A.y, B.y);
  for (const o of [0.3, -0.3, 0.55, -0.55]) {
    const ox = -dz * o, oz = dx * o;
    const ax = A.x + ox, az = A.z + oz, bx = B.x + ox, bz = B.z + oz;
    if (LB.blocked(ax, az, bx, bz, y + 0.75) || LB.blocked(ax, az, bx, bz, y + 1.5)) continue;
    const mx = (ax + bx) / 2, mz = (az + bz) / 2, my = LB.floorBelow(mx, y + 0.6, mz, 1.2);
    if (my !== my) continue;
    world.velY = 0; world.headBump = false; world.resolveCapsule(mx, my + 0.02, mz, PLAYER_R, PLAYER_H, true);
    if (!world.headBump && dmath.hypot(world.P[0] - mx, world.P[2] - mz) < 0.25) return true;
  }
  return false;
}
/** storey floor heights from room-cell heights: clusters 1.6 m apart, a storey holds ≥ 8 cells (12.5 m²) and ≥ 20 %
 * of the biggest level (stair half-landings / closets are not storeys); never empty */
export function storeyLevels(ys: number[]): number[] {
  if (!ys.length) return [];
  const s = ys.slice().sort((a, b) => a - b), cl: Array<{ y: number; n: number }> = [];
  let a = 0;
  for (let i = 1; i <= s.length; i++) if (i === s.length || s[i] - s[i - 1] > 1.6) { let m = 0; for (let k = a; k < i; k++) m += s[k]; cl.push({ y: m / (i - a), n: i - a }); a = i; }
  const big = Math.max(...cl.map((c) => c.n));
  const keep = cl.filter((c) => c.n >= 8 && c.n >= 0.2 * big).map((c) => +c.y.toFixed(2));
  return keep.length ? keep : [+cl.reduce((p, c) => (c.n > p.n ? c : p)).y.toFixed(2)];
}
interface Scan { cells: Cell[]; byCol: Map<number, number[]>; edges: number[]; exits: Map<number, [number, number, number]>; comp: Int32Array; cbld: Int32Array }
/** POIs with enterable buildings beyond their radius: Peel Harbor's moored ship (house +
 *  deck boxes 213–229 m from the centre, r 190) — scanned so its 18 kit rooms become room units like every building */
const SCAN_PAD: Record<string, number> = { "peel-harbor": 45 };
function* scanPoi(world: StaticWorld, pi: number, rooms: Room[], buildings: Building[], kits: KitRoomLite[] = []): Generator<void, Scan, void> {
  const poi = POIS[pi], scanR = poi.r + (SCAN_PAD[poi.id] ?? 0);
  const t0 = now();
  // the scan reaches every interiors-kit room the POI declares: Peel Harbor's moored ship (its house, the
  // mess, the bridge: 5 storeys) lies ~220 m from the POI centre, past r + 6 — otherwise the scan never sees it.
  // Capped at 1.4 r (a POI never scans its neighbour's town; ownsCell still splits overlaps).
  // The harbor's SCAN_PAD reach (r + 45, the ship's deck boxes) is honoured as a floor.
  const R = Math.max(scanRadius(pi, kits), scanR + 6);
  const LB = new LocalBoxes(world, poi.x, poi.z, R + 6);
  yield;
  let caps = 0;
  const cells: Cell[] = [], seen = new Map<number, number[]>();   // column key → cell ids
  const key = (ix: number, iz: number) => (ix + 4096) * 8192 + (iz + 4096);
  const r2 = dmath.pow(R, 2);
  for (let i = 0; i < world.n; i++) {
    if ((i & 16383) === 0 || caps > 60) { caps = 0; yield; }
    if (world.noShoot[i]) continue;
    const hx = world.hx[i], hz = world.hz[i], hy = world.hy[i];
    if (hx < 0.8 || hz < 0.8 || hy > 2.5) continue;
    const bx = world.cx[i], bz = world.cz[i];
    if (dmath.pow(bx - poi.x, 2) + dmath.pow(bz - poi.z, 2) > r2) continue;
    const c = world.cos[i], s = world.sin[i], bot = world.cy[i] - hy;
    const ex = Math.abs(c) * hx + Math.abs(s) * hz, ez = Math.abs(s) * hx + Math.abs(c) * hz;
    for (let ix = Math.floor((bx - ex) / G); ix <= Math.floor((bx + ex) / G); ix++) for (let iz = Math.floor((bz - ez) / G); iz <= Math.floor((bz + ez) / G); iz++) {
      const x = (ix + 0.5) * G, z = (iz + 0.5) * G, rx = x - bx, rz = z - bz;
      const lx = rx * c + rz * s, lz = -rx * s + rz * c;
      if (Math.abs(lx) > hx - 0.3 || Math.abs(lz) > hz - 0.3) continue;
      // POI radii overlap (stilt-town / the next POI): a cell belongs to the POI it is relatively nearest to, so a
      // building is scanned once (a duplicate would double its loot — two items on one spot)
      if (!ownsCell(pi, x, z)) continue;
      const fy = LB.floorBelow(x, bot - 0.02, z, HEAD_MAX);
      if (fy !== fy || bot - fy < HEAD_MIN || LB.ny < 0.85 || fy < 0.3) continue;
      const k = key(ix, iz); let col = seen.get(k);
      if (col && col.some((j) => Math.abs(cells[j].y - fy) < 0.3)) continue;
      world.velY = 0; world.headBump = false; caps++;
      world.resolveCapsule(x, fy + 0.02, z, PLAYER_R, PLAYER_H, false);
      if (world.headBump || dmath.hypot(world.P[0] - x, world.P[2] - z) > 0.05 || Math.abs(world.P[1] - (fy + 0.02)) > 0.06) continue;
      if (!col) seen.set(k, col = []);
      col.push(cells.length); cells.push({ ix, iz, x, y: fy, z, room: -1 });
    }
  }
  const kitCell = new Set<number>(), kitGroups: number[][] = [];
  // every interiors-kit room the POI DECLARES is interior floor, whatever covers it: warehouse bays
  // under a 9 m truss roof, huts under thin thatch / pitched planks the ceiling pass cannot see (otherwise such doored
  // buildings get no loot)
  for (const r of kits) {
    if (r.w * r.d < 9 || !r.openings?.some((o) => o.kind === "door" || o.kind === "gap")) continue;
    const c = dmath.cos(r.yaw), s = dmath.sin(r.yaw), R = dmath.hypot(r.w, r.d) / 2, grp: number[] = [];
    for (let ix = Math.floor((r.x - R) / G); ix <= Math.floor((r.x + R) / G); ix++) for (let iz = Math.floor((r.z - R) / G); iz <= Math.floor((r.z + R) / G); iz++) {
      const x = (ix + 0.5) * G, z = (iz + 0.5) * G, dx = x - r.x, dz = z - r.z;
      if (Math.abs(dx * c - dz * s) > r.w / 2 - 0.2 || Math.abs(dx * s + dz * c) > r.d / 2 - 0.2) continue;
      if (!ownsCell(pi, x, z)) continue;
      const fy = LB.floorBelow(x, r.y + 0.5, z, 1.0);
      if (fy !== fy || Math.abs(fy - r.y) > 0.3 || LB.ny < 0.85) continue;
      const k = key(ix, iz); let col = seen.get(k);
      const had = col?.find((j) => Math.abs(cells[j].y - fy) < 0.3);
      if (had !== undefined) { kitCell.add(had); grp.push(had); continue; }
      world.velY = 0; world.headBump = false;
      world.resolveCapsule(x, fy + 0.02, z, PLAYER_R, PLAYER_H, false);
      if (world.headBump || dmath.hypot(world.P[0] - x, world.P[2] - z) > 0.05 || Math.abs(world.P[1] - (fy + 0.02)) > 0.06) continue;
      if (!col) seen.set(k, col = []);
      kitCell.add(cells.length); grp.push(cells.length); col.push(cells.length); cells.push({ ix, iz, x, y: fy, z, room: -1 });
    }
    if (grp.length) kitGroups.push(grp);
    if ((++caps & 7) === 0) yield;
  }
  const t1 = now(); SPOT_PROF.scan += t1 - t0;
  // rooms: same level, no wall between (knee-height segment); buildings: rooms touching (any level) or stacked
  const n = cells.length, room = new UF(n), bld = new UF(n), walk = new UF(n), edges: number[] = [];
  const NB: Array<[number, number]> = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (let a = 0; a < n; a++) {
    if ((a & 1023) === 1023) yield;
    const A = cells[a];
    const col = seen.get(key(A.ix, A.iz))!; for (const b of col) if (b !== a) bld.u(a, b);
    for (const [dx, dz] of NB) {
      const col2 = seen.get(key(A.ix + dx, A.iz + dz)); if (!col2) continue;
      for (const b of col2) {
        const B = cells[b], dy = B.y - A.y;
        if (Math.abs(dy) > 0.9) continue;
        if (LB.blocked(A.x, A.z, B.x, B.z, Math.max(A.y, B.y) + 0.75)) {
          // a doorway off the 1.25 m grid line (a stair core's door, a 1.1 m guest-room door): the same link
          // shifted ±0.3 / ±0.55 m across, clear at knee AND chest height, with the capsule fitting at its middle. It
          // joins the building / walk graph (else the hotel's stair cores are separate "buildings" with their own loot, and
          // the bots' graph never crosses those doors) but never merges ROOMS (a door separates two rooms).
          if (NO_DOOR_LINKS || !doorLink(world, LB, A, B)) continue;
          const DL = (globalThis as { __krDoorLog?: number[][] }).__krDoorLog; if (DL && bld.f(a) !== bld.f(b)) DL.push([A.x, A.y, A.z, B.x, B.y, B.z]);
          bld.u(a, b); walk.u(a, b); edges.push(a, b); continue;
        }
        bld.u(a, b); walk.u(a, b); edges.push(a, b);
        if (Math.abs(dy) <= 0.35) room.u(a, b);
      }
    }
  }
  // a declared kit room is ONE room of one building, even where its furniture splits the capsule cells
  for (const g of kitGroups) for (let q = 1; q < g.length; q++) { room.u(g[0], g[q]); bld.u(g[0], g[q]); }
  // The keeper cottage declares furnished rooms of ONE house. Its two-cell bedroom
  // is disconnected on the coarse census lattice, although the real door route passes.
  // Group only its declared floor cells as a building; leave room and walk unions intact.
  if (POIS[pi].id === "lookout-point") {
    const keeper = kits.filter(r => r.id?.startsWith("keeper-cottage-"));
    const ids: number[] = [];
    for (let j = 0; j < cells.length; j++) {
      const C = cells[j];
      if (keeper.some(r => {
        const dx = C.x-r.x, dz = C.z-r.z, c = dmath.cos(r.yaw), s = dmath.sin(r.yaw);
        return Math.abs(C.y-r.y)<.3 && Math.abs(dx*c-dz*s)<=r.w/2-.2 && Math.abs(dx*s+dz*c)<=r.d/2-.2;
      })) ids.push(j);
    }
    for (let j=1;j<ids.length;j++) bld.u(ids[0],ids[j]);
  }
  // exits: a walk link from a cell to a standable spot OUTSIDE the roofed set (a door, an open side, an outdoor stair
  // landing). A walk component (rooms + indoor stairs) without one is sealed — nothing may spawn in it.
  // Every door cell is recorded (the bots' nav enters there), not only the first per component.
  const exitRoot = new Set<number>(), exits = new Map<number, [number, number, number]>();
  for (let a = 0; a < n; a++) {
    if ((a & 255) === 255) yield;
    const A = cells[a];
    for (const [dx, dz] of EXIT_DIRS) {
      const col2 = seen.get(key(A.ix + dx, A.iz + dz));
      if (col2 && col2.some((b) => Math.abs(cells[b].y - A.y) <= 0.9)) continue;
      const px = A.x + dx * G, pz = A.z + dz * G;
      const fy = LB.floorBelow(px, A.y + 0.6, pz, 1.8);
      if (fy !== fy || LB.ny < 0.7 || fy < -0.5) continue;
      if (LB.blocked(A.x, A.z, px, pz, Math.max(A.y, fy) + 0.75) || LB.blocked(A.x, A.z, px, pz, Math.max(A.y, fy) + 1.5)) continue;
      world.velY = 0; world.headBump = false;
      world.resolveCapsule(px, fy + 0.02, pz, PLAYER_R, PLAYER_H, false);
      if (world.headBump || dmath.hypot(world.P[0] - px, world.P[2] - pz) > 0.08 || Math.abs(world.P[1] - (fy + 0.02)) > 0.1) continue;
      exitRoot.add(walk.f(a));
      // the bots' door point: one more cell straight out when there is room (they walk in square to the door frame)
      const qx = A.x + dx * 2 * G, qz = A.z + dz * 2 * G, qy = LB.floorBelow(qx, fy + 0.6, qz, 1.2);
      let out: [number, number, number] = [px, fy, pz];
      if (qy === qy && LB.ny >= 0.7 && !LB.blocked(px, pz, qx, qz, Math.max(fy, qy) + 0.75)) {
        world.velY = 0; world.headBump = false; world.resolveCapsule(qx, qy + 0.02, qz, PLAYER_R, PLAYER_H, false);
        if (!world.headBump && dmath.hypot(world.P[0] - qx, world.P[2] - qz) < 0.08) out = [qx, qy, qz];
      }
      exits.set(a, out); break;
    }
  }
  const t2 = now(); SPOT_PROF.link += t2 - t1;
  const roomOf = new Map<number, number>(), bldOf = new Map<number, number>(), members = new Map<number, number[]>();
  for (let a = 0; a < n; a++) { const r = room.f(a); let m = members.get(r); if (!m) members.set(r, m = []); m.push(a); }
  let mk = 0;
  for (const [r, m] of members) {
    if ((++mk & 31) === 0) yield;
    // (a declared kit room is a room even when its furniture leaves only 2–3 standable cells: a small stilt hut)
    if (m.length < ROOM_MIN_CELLS && !(m.length >= 2 && m.some((j) => kitCell.has(j)))) continue;
    let sx = 0, sy = 0, sz = 0; for (const j of m) { sx += cells[j].x; sy += cells[j].y; sz += cells[j].z; }
    sx /= m.length; sy /= m.length; sz /= m.length;
    let best = m[0], bd = Infinity; for (const j of m) { const d = dmath.pow(cells[j].x - sx, 2) + dmath.pow(cells[j].z - sz, 2) + dmath.pow(cells[j].y - sy, 2) * 4; if (d < bd) { bd = d; best = j; } }
    const C = cells[best];
    // no exit found by the coarse lattice (a door narrower than the grid, a jamb on the link): confirm with the solver's
    // own enclosure test (a fine ±5 / ±10 m flood) before calling it sealed
    let sealed = false;
    // and the fine walk graph down its stairs (walkable): findUnstick alone would seal every storey > 4.5 m up
    if (!exitRoot.has(walk.f(m[0]))) { sealed = NO_UNITS ? (world.findUnstick(C.x, C.y + 0.02, C.z, PLAYER_R, PLAYER_H), world.enclosedAt >= 0) : !walkable(world, C.x, C.y, C.z); if (!sealed) exitRoot.add(walk.f(m[0])); }
    // a room with an "exit" (a railed balcony, a window ledge, a stilt deck) the kong still cannot walk
    // out of: its stairs do not work — sealed (no loot where nobody can walk)
    else if (!NO_UNITS) sealed = !walkable(world, C.x, C.y, C.z);
    const b = bld.f(r);
    let bi = bldOf.get(b);
    if (bi === undefined) { bi = buildings.length; bldOf.set(b, bi); buildings.push({ id: bi, poi: pi, x: 0, z: 0, cells: 0, rooms: [], storeys: 0, sealed: true, walls: 0, enterable: false, levels: [] }); }
    const id = rooms.length; roomOf.set(r, id);
    rooms.push({ id, bld: bi, poi: pi, x: C.x, y: C.y, z: C.z, cells: m.length, sealed });
    const B = buildings[bi]; B.rooms.push(id); B.x = (B.x * B.cells + sx * m.length) / (B.cells + m.length); B.z = (B.z * B.cells + sz * m.length) / (B.cells + m.length); B.cells += m.length; if (!sealed) B.sealed = false;
    let wl = 0;
    for (const j of m) {
      cells[j].room = id; const Q = cells[j], y = Q.y + 0.75;
      if (LB.blocked(Q.x, Q.z, Q.x + 1.1, Q.z, y) || LB.blocked(Q.x, Q.z, Q.x - 1.1, Q.z, y) || LB.blocked(Q.x, Q.z, Q.x, Q.z + 1.1, y) || LB.blocked(Q.x, Q.z, Q.x, Q.z - 1.1, y)) wl++;
    }
    B.walls += wl;
  }
  SPOT_PROF.seal += now() - t2;
  // a building holding a declared kit room (≥ 4 standable cells of it: a furnished 12 m² hut leaves few) is
  // enterable by definition (a warehouse bay open to its hall, a stilt hut)
  const kitN = new Map<number, number>(); for (const j of kitCell) { const r = cells[j].room; if (r >= 0) { const b = rooms[r].bld; kitN.set(b, (kitN.get(b) ?? 0) + 1); } }
  for (const B of buildings) if (B.poi === pi) { B.walls = B.cells ? B.walls / (4 * Math.sqrt(B.cells)) : 0; B.enterable = !B.sealed && (B.cells >= 8 || (kitN.get(B.id) ?? 0) >= 2) && (B.walls >= 0.35 || (kitN.get(B.id) ?? 0) >= 2); const ys = B.rooms.map((q) => rooms[q].y).sort((a, b) => a - b); let s = 0, last = -1e9; for (const y of ys) if (y - last > 2) { s++; last = y; } B.storeys = s; }
  const comp = new Int32Array(n); for (let a = 0; a < n; a++) comp[a] = walk.f(a);
  // every cell's building (stairs and small nooks too: the building union, not the room) + each building's storeys
  const cbld = new Int32Array(n).fill(-1);
  for (let a = 0; a < n; a++) { const bi = bldOf.get(bld.f(a)); if (bi !== undefined) cbld[a] = bi; }
  { const ys = new Map<number, number[]>();
    for (let a = 0; a < n; a++) { if (cells[a].room < 0 || cbld[a] < 0) continue; let l = ys.get(cbld[a]); if (!l) ys.set(cbld[a], l = []); l.push(cells[a].y); }
    for (const [bi, l] of ys) buildings[bi].levels = storeyLevels(l); }
  return { cells, byCol: new Map([...seen].map(([k, v]) => [k, v])), edges, exits, comp, cbld };
}

/** an outdoor chest's place with its BACK to the nearest cover within 5 m of (x, y, z) — a rock, a trunk, a
 * wall (a near-vertical face of a collider) — 0.3 m off it and facing away, on the walkable floor there (≤ 1.2 m from y):
 * a loot nook, not a crate dropped in the middle of open ground. null = no cover face / no floor there. */
const BK = makeHit();
/** a chest's centre off the wall behind it: its open lid's reach behind the centre + 4 cm */
const CRATE_OFF = 0.85;
function backedPlace(world: StaticWorld, x: number, y: number, z: number): { x: number; y: number; z: number; yaw: number } | null {
  let wd = Infinity, wx = 0, wz = 0;
  for (let d = 0; d < 8; d++) {
    const a = d / 8 * Math.PI * 2; world.raycast(x, y + 0.9, z, dmath.cos(a), 0, dmath.sin(a), 5, BK, true);
    if (BK.hit && BK.box >= 0 && Math.abs(BK.ny) < 0.55 && BK.t < wd) { wd = BK.t; wx = dmath.cos(a); wz = dmath.sin(a); }
  }
  if (!(wd < 5)) return null;
  const push = Math.max(0, wd - CRATE_OFF), bx = x + wx * push, bz = z + wz * push;
  world.raycast(bx, y + 2.5, bz, 0, -1, 0, 5, BK, false);
  if (!BK.hit || BK.ny < 0.8 || Math.abs(BK.y - y) > 1.2) return null;
  return { x: bx, y: BK.y + 0.02, z: bz, yaw: dmath.atan2(-wx, -wz) };
}
/** chest against a wall of this room: corners first; the chest faces into the room (+Z of the crate = front) */
function wallChests(world: StaticWorld, cells: Cell[], ids: number[]): Array<{ x: number; y: number; z: number; yaw: number; score: number }> {
  const out: Array<{ x: number; y: number; z: number; yaw: number; score: number }> = [];
  for (const j of ids) {
    const C = cells[j];
    const walls: Array<[number, number, number]> = [];
    for (let d = 0; d < 4; d++) {
      const dx = d === 0 ? 1 : d === 1 ? -1 : 0, dz = d === 2 ? 1 : d === 3 ? -1 : 0;
      world.raycast(C.x, C.y + 0.45, C.z, dx, 0, dz, 1.1, H, true);
      if (H.hit && Math.abs(H.ny) < 0.3) walls.push([dx, dz, H.t]);
    }
    if (!walls.length) continue;
    walls.sort((a, b) => a[2] - b[2]);
    const [dx, dz, t] = walls[0];
    // the crate's centre this far off the wall: its open lid clears it (at 0.45 the 1 m crate would stand 10 cm inside
    // the wall and its lid swing through it)
    const push = t - CRATE_OFF, x = C.x + dx * push, z = C.z + dz * push;
    let score = walls.length >= 2 && walls[0][0] !== -walls[1][0] ? 2 : 1;
    score += 0.001 * ((hash32(C.ix, C.iz) & 1023) / 1023);
    out.push({ x, y: C.y, z, yaw: dmath.atan2(-dx, -dz), score });
  }
  return out.sort((a, b) => b.score - a.score);
}

// ------------------------------------------------------------------------------------------------ build + cache
type Cand = { kind: SpotKind; src: Src; x: number; y: number; z: number; yaw: number; poi: number; room: number; order: number;
  /** 0 not validated yet · 1 valid · 2 rejected (validation is lazy: only candidates the thinning looks at pay for it) */
  v: number; sx?: number; sy?: number; sz?: number;
  /** a container that may turn to face its stand place (outdoors); wall chests keep their yaw */
  free?: boolean;
  /** a designed PAYOFF chest (LOOT_SPOTS.hero) */
  hero?: boolean };
type Job = { it: Generator<void, SpotSet, void>; done: SpotSet | null };
const JOBS = new WeakMap<StaticWorld, Job>();
const job = (world: StaticWorld): Job => { let j = JOBS.get(world); if (!j) JOBS.set(world, j = { it: build(world), done: null }); return j; };
/** a set built off the main thread for THIS world (same island
 *  file + recipe; the caller checked the static-world hash — client/src/engine/lootspots.ts): no in-thread build */
export function adoptLootSpots(world: StaticWorld, set: SpotSet) { const j = job(world); if (!j.done) j.done = set; }

/** the canonical loot spots of this static world (built once, cached). Finishes a sliced build (lootSpotsIdle) in place. */
export function lootSpots(world: StaticWorld): SpotSet {
  const j = job(world);
  while (!j.done) { const r = j.it.next(); if (r.done) j.done = r.value; }
  return j.done;
}
/** the same build in ≤ `budgetMs` slices with `pause()` between them (the browser runs it while the title is idle, so
 * PRACTICE never waits for it); a lootSpots() call in the middle simply finishes it */
export async function lootSpotsIdle(world: StaticWorld, pause: () => Promise<void>, budgetMs = 6): Promise<SpotSet> {
  const j = job(world);
  let t = now();
  while (!j.done) {
    const r = j.it.next(); if (r.done) { j.done = r.value; break; }
    if (now() - t > budgetMs) { await pause(); t = now(); }
  }
  return j.done;
}

function* build(world: StaticWorld): Generator<void, SpotSet, void> {
  for (const k in SPOT_PROF) SPOT_PROF[k as keyof typeof SPOT_PROF] = 0;
  let busy = 0;                                         // ms of real work (the wall clock includes the pauses)
  let t = now();
  const lap = () => { const n = now(); busy += n - t; t = n; };
  const rooms: Room[] = [], buildings: Building[] = [], rejected: Rejected[] = [];
  const spots: LootSpot[] = [];
  const designed = lootSpotsById();
  const kitRooms = interiorRoomsById();
  const units: Unit[] = [];
  const houses: LootSpot[] = [], houseless: SpotSet["houseless"] = [];
  const pool = { chest: 0, floor: 0, designed: 0, scan: 0, wild: 0 };
  const allProbes: SpotSet["probes"] = [];
  let ops = 0;
  const NX: number[] = [], NY: number[] = [], NZ: number[] = [], NC: number[] = [], NE: number[] = [], NEX: number[] = [], NB: number[] = [], NR: number[] = [];

  for (let pi = 0; pi < POIS.length; pi++) {
    const poi = POIS[pi];
    if (poi.id === LOBBY) continue;
    lap(); yield; t = now();
    const sc = yield* scanPoi(world, pi, rooms, buildings, NO_UNITS ? [] : kitRooms[poi.id] ?? []);
    lap(); yield; t = now();
    const { cells, byCol } = sc;
    { // the nav graph: global cell ids = this POI's offset + local id (a component id = offset + its local root)
      const base = NX.length;
      for (let j = 0; j < cells.length; j++) {
        const C = cells[j]; NX.push(C.x); NY.push(C.y); NZ.push(C.z); NC.push(base + sc.comp[j]); NB.push(sc.cbld[j]); NR.push(C.room);
        const e = sc.exits.get(j); NEX.push(e ? e[0] : NaN, e ? e[1] : NaN, e ? e[2] : NaN);
      }
      for (let q = 0; q < sc.edges.length; q++) NE.push(base + sc.edges[q]); }
    const roomAt = (x: number, y: number, z: number): number => {
      const ix = Math.floor(x / G), iz = Math.floor(z / G);
      let best = -1, bd = 1e9;
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
        const col = byCol.get((ix + a + 4096) * 8192 + (iz + b + 4096)); if (!col) continue;
        for (const j of col) { const C = cells[j]; if (C.room < 0) continue; const dy = Math.abs(C.y - y); if (dy > 0.45) continue; const d = dmath.hypot(C.x - x, C.z - z) + dy; if (d < bd && d < 1.3) { bd = d; best = C.room; } }
      }
      return best;
    };
    const cands: Cand[] = [];
    const add = (kind: SpotKind, src: Src, x: number, y: number, z: number, yaw: number, order: number, room = roomAt(x, y, z), free = false) => {
      if (room >= 0 && rooms[room].sealed) { rejected.push({ kind, src, poi: pi, x, y, z, why: "sealed room (no way in)" }); return; }
      cands.push({ kind, src, x, y, z, yaw, poi: pi, room, order, v: 0, free });
    };
    const valid = (c: Cand): boolean => {
      if (c.v) return c.v === 1;
      ops++;
      let v = validateSpot(world, c.kind, c.x, c.y, c.z, c.yaw, !!c.free);
      // a designed container whose front is blocked may turn (a crate on a deck): any side with a clear stand place
      if (v.why && c.kind !== SpotKind.Floor && !c.free && c.src === Src.Designed) v = validateSpot(world, c.kind, c.x, c.y, c.z, c.yaw, true);
      if (v.why) { c.v = 2; rejected.push({ kind: c.kind, src: c.src, poi: pi, x: c.x, y: c.y, z: c.z, why: v.why }); return false; }
      c.x = v.x; c.y = v.y; c.z = v.z; c.yaw = v.yaw; c.sx = STAND[0]; c.sy = STAND[1]; c.sz = STAND[2];
      // a designed spot outside every room (tower tops, ledges, decks): the solver's enclosure test at its stand spot
      if (c.room < 0 && c.src === Src.Designed) {
        if (!walkable(world, STAND[0], STAND[1], STAND[2])) { c.v = 2; rejected.push({ kind: c.kind, src: c.src, poi: pi, x: c.x, y: c.y, z: c.z, why: "enclosed (no way there)" }); return false; }
      }
      c.v = 1; return true;
    };
    const ds = designed[poi.id];
    if (ds) {
      ds.chests.forEach((c, i) => { const n = cands.length; add(SpotKind.Chest, Src.Designed, c[0], c[1], c[2], c[3], i); if (cands.length > n && ds.hero?.includes(i)) cands[n].hero = true; });
      ds.floor.forEach((f, i) => add(SpotKind.Floor, Src.Designed, f[0], f[1], f[2], 0, i));
    }
    // rooms: scan candidates (wall chests, spread floor spots) behind the designed ones
    const cellsOf = new Map<number, number[]>();
    for (let j = 0; j < cells.length; j++) { const r = cells[j].room; if (r < 0) continue; let m = cellsOf.get(r); if (!m) cellsOf.set(r, m = []); m.push(j); }
    const hasC = new Set<number>(), nF = new Map<number, number>();
    for (const c of cands) if (c.room >= 0) { if (c.kind === SpotKind.Chest) hasC.add(c.room); else nF.set(c.room, (nF.get(c.room) ?? 0) + 1); }
    let rk = 0;
    for (const [r, ids] of cellsOf) {
      if (rooms[r].sealed) continue;
      if ((++rk & 7) === 0) { lap(); yield; t = now(); }
      if (!hasC.has(r)) { let k = 0; for (const w of wallChests(world, cells, ids)) { if (k >= 3) break; add(SpotKind.Chest, Src.Scan, w.x, w.y, w.z, w.yaw, 1000 + k, r); k++; } }
      const want = (ids.length >= 16 ? 4 : ids.length >= 6 ? 3 : 2) - (nF.get(r) ?? 0);
      if (want > 0) {
        // spread: the cell nearest the room centre, then cells ≥ 3 m from the picks so far
        const R = rooms[r], picks: Cell[] = [];
        const order = ids.map((j) => cells[j]).sort((a, b) => (dmath.pow(a.x - R.x, 2) + dmath.pow(a.z - R.z, 2)) - (dmath.pow(b.x - R.x, 2) + dmath.pow(b.z - R.z, 2)));
        for (const C of order) {
          if (picks.length >= want) break;
          if (picks.some((p) => dmath.hypot(p.x - C.x, p.z - C.z) < 2.5)) continue;
          add(SpotKind.Floor, Src.Scan, C.x, C.y, C.z, 0, 1000 + picks.length, r); picks.push(C);
        }
      }
    }
    // outdoor: coverage probes on an 11 m lattice; every other one (22 m) is also a floor candidate, and a chest candidate
    // where there is cover (box tops too: rock plateaus, flat roofs, decks — where a glider lands, loot may wait)
    const probes: Array<{ x: number; y: number; z: number; room?: number }> = [], extra: Array<{ x: number; y: number; z: number }> = [];
    for (let gx = -poi.r; gx <= poi.r; gx += 11) {
      lap(); yield; t = now();
      for (let gz = -poi.r; gz <= poi.r; gz += 11) {
        const h = hash32(Math.round(gx + poi.x * 3), Math.round(gz + poi.z * 3));
        const x = poi.x + gx + ((h & 1023) / 1023 - 0.5) * 6, z = poi.z + gz + (((h >>> 10) & 1023) / 1023 - 0.5) * 6;
        if (dmath.pow(x - poi.x, 2) + dmath.pow(z - poi.z, 2) > dmath.pow(poi.r * 0.92, 2)) continue;   // (the fuzzy POI border: landings sit ≤ 0.9 r)
        // the cell's centre too (a quincunx: probes ≤ 5.5 m from any landing point, so planning at 10 s holds at 10 s)
        { const qx = poi.x + gx + 5.5, qz = poi.z + gz + 5.5;
          if (dmath.pow(qx - poi.x, 2) + dmath.pow(qz - poi.z, 2) <= dmath.pow(poi.r * 0.92, 2)) { world.raycast(qx, 600, qz, 0, -1, 0, 900, H, false); if (H.hit && H.y >= 0.4 && H.ny >= 0.75) extra.push({ x: qx, y: H.y, z: qz }); } }
        world.raycast(x, 600, z, 0, -1, 0, 900, H, false);
        // the lattice point is on a steep face: a flat ledge / rock top elsewhere in its 11 m cell is still a place a
        // glider can land (the cell's four quarter points)
        if (H.hit && H.y >= 0.4 && H.ny < 0.7) {
          const cx0 = poi.x + gx, cz0 = poi.z + gz;
          for (const [qx, qz] of [[-2.75, -2.75], [2.75, -2.75], [-2.75, 2.75], [2.75, 2.75]]) {
            world.raycast(cx0 + qx, 600, cz0 + qz, 0, -1, 0, 900, H, false);
            if (H.hit && H.y >= 0.4 && H.ny >= 0.75) extra.push({ x: cx0 + qx, y: H.y, z: cz0 + qz });
          }
          continue;
        }
        if (!H.hit || H.y < 0.4 || H.ny < 0.7) continue;
        const y = H.y;
        probes.push({ x, y, z });
        const lattice = ((Math.round(gx / 11) & 1) === 0) && ((Math.round(gz / 11) & 1) === 0);
        if (!lattice || roomAt(x, y, z) >= 0) continue;
        let cover = 0;
        for (let d = 0; d < 8; d++) { const a = d / 8 * Math.PI * 2; world.raycast(x, y + 0.9, z, dmath.cos(a), 0, dmath.sin(a), 5, L, true); if (L.hit && L.box >= 0) cover++; }
        // an outdoor chest stands with its BACK to its cover (backedPlace); when that place fails (a slope, a root), a
        // free-standing chest at the lattice point
        let backed = false;
        const bp = cover ? backedPlace(world, x, y, z) : null;
        if (bp) {
          const c0 = cands.length;
          add(SpotKind.Chest, Src.Scan, bp.x, bp.y, bp.z, bp.yaw, 2000, -1, false);
          if (cands.length > c0) backed = valid(cands[c0]);
          if (!backed && cands.length > c0) cands.pop();
        }
        if (cover && !backed) add(SpotKind.Chest, Src.Scan, x, y + 0.02, z, ((h >>> 20) & 255) / 255 * Math.PI * 2, 2000, -1, true);
        add(SpotKind.Floor, Src.Scan, x, y + 0.02, z, 0, 2000 + (cover ? 0 : 1), -1);
      }
    }
    const lattice = probes.length;
    for (const q of extra) probes.push(q);
    for (const R of rooms) if (R.poi === pi && !R.sealed) probes.push({ x: R.x, y: R.y, z: R.z, room: 1 });
    for (const c of cands) { if (c.kind === SpotKind.Chest) pool.chest++; else pool.floor++; if (c.src === Src.Designed) pool.designed++; else pool.scan++; }
    const first = spots.length;
    lap(); yield; t = now();
    const tv = SPOT_PROF.validate;
    yield* canonical(cands, pi, rooms, buildings, spots, probes, lattice, world, valid, () => ops);
    lap(); yield; t = now();
    if (!NO_UNITS) yield* roomUnits(world, pi, sc, rooms, buildings, spots, cands, kitRooms[poi.id] ?? [], valid, units, first, houses, houseless);
    void tv;
    lap(); yield; t = now();
    for (const P of probes) {
      const near: Array<[number, number]> = [];
      for (let k = first; k < spots.length; k++) { const q = spots[k]; if (Math.abs(q.x - P.x) > 60 || Math.abs(q.z - P.z) > 60) continue; const tt = reachTime(P.x, P.y, P.z, q.x, q.y, q.z, q.kind === SpotKind.Chest); if (tt <= COVER_NEAR) near.push([k, tt]); }
      near.sort((a, b) => a[1] - b[1]);
      allProbes.push({ x: P.x, y: P.y, z: P.z, poi: pi, near: near.map((q) => q[0]), t: near.map((q) => +q[1].toFixed(2)), room: P.room });
    }
  }
  lap(); yield; t = now();
  const tw = now(); yield* wild(world, spots, rejected, pool); SPOT_PROF.wild = now() - tw;
  // (house guns) the house-gun spots go LAST: every other spot keeps its id, so its per-match coins do not move
  const h0 = spots.length; for (const h of houses) spots.push(h);
  spots.forEach((q, i) => { q.id = i; });
  // …and they reach the coverage probes like any spot (a live house gun is a weapon source for placeLoot's cover)
  for (const P of allProbes) {
    let n = 0;
    for (let k = h0; k < spots.length; k++) {
      const q = spots[k]; if (q.poi !== P.poi || Math.abs(q.x - P.x) > 60 || Math.abs(q.z - P.z) > 60) continue;
      const tt = reachTime(P.x, P.y, P.z, q.x, q.y, q.z, false); if (tt <= COVER_NEAR) { P.near.push(k); P.t.push(+tt.toFixed(2)); n++; }
    }
    if (n) { const o = P.near.map((k, i) => [k, P.t[i]]).sort((a, b) => a[1] - b[1]); P.near = o.map((q) => q[0]); P.t = o.map((q) => q[1]); }
  }
  // the ammo beside a floor gun: 0.55 m off, the first of 6 directions with a floor, room for it and a clear line to the gun
  let k2 = 0;
  for (const q of spots) {
    if (q.kind !== SpotKind.Floor) continue;
    if ((++k2 & 63) === 0) { lap(); yield; t = now(); }
    q.ax = q.x; q.ay = q.y; q.az = q.z;
    const a0 = (hash32(q.id, 0xa770) & 1023) / 1023 * Math.PI * 2;
    for (let k = 0; k < 6; k++) {
      const a = a0 + k * Math.PI / 3, x = q.x + dmath.cos(a) * 0.55, z = q.z + dmath.sin(a) * 0.55;
      world.raycast(x, q.y + 0.15, z, 0, -1, 0, 0.3, H, false);
      if (!H.hit || H.ny < SLOPE_LIMIT) continue;
      const fy = H.y;
      world.velY = 0; world.headBump = false; world.resolveCapsule(x, fy + 0.02, z, 0.3, 0.6, false);
      if (dmath.hypot(world.P[0] - x, world.P[2] - z) > 0.03 || world.P[1] - (fy + 0.02) > 0.05 || world.headBump) continue;
      if (!world.clear(q.x, q.y + 0.3, q.z, x, fy + 0.3, z)) continue;
      q.ax = x; q.ay = fy; q.az = z; break;
    }
  }
  // the nav graph in CSR form (undirected links) + its column index
  const nn = NX.length, deg = new Int32Array(nn + 1);
  for (let q = 0; q < NE.length; q++) deg[NE[q] + 1]++;
  for (let a = 0; a < nn; a++) deg[a + 1] += deg[a];
  const adj = new Int32Array(NE.length), fill = deg.slice(0, nn);
  for (let q = 0; q < NE.length; q += 2) { const a = NE[q], b = NE[q + 1]; adj[fill[a]++] = b; adj[fill[b]++] = a; }
  const col = new Map<number, number[]>();
  for (let a = 0; a < nn; a++) { const k = colKey(Math.floor(NX[a] / G), Math.floor(NZ[a] / G)); let m = col.get(k); if (!m) col.set(k, m = []); m.push(a); }
  const nav: Nav = { n: nn, x: Float32Array.from(NX), y: Float32Array.from(NY), z: Float32Array.from(NZ), comp: Int32Array.from(NC), adjStart: deg, adj, ex: Float32Array.from(NEX), col, bld: Int32Array.from(NB), room: Int32Array.from(NR) };
  // (house guns) how the bots get to every other floor spot in a house (placeLoot prefers house guns they can reach)
  { const door = new Map<number, number>();
    for (let a = 0; a < nn; a++) { if (nav.ex[a * 3] !== nav.ex[a * 3]) continue; const r = navDoorRank(world, nav.ex[a * 3], nav.ex[a * 3 + 1], nav.ex[a * 3 + 2]); if (!(door.get(nav.comp[a])! <= r)) door.set(nav.comp[a], r); }
    for (const q of spots) { if (q.kind !== SpotKind.Floor || q.navIn !== undefined || q.bld < 0 || !buildings[q.bld].enterable) continue; const c = navCellAt(nav, q.x, q.y, q.z); q.navIn = c < 0 ? 2 : door.get(nav.comp[c]) ?? 2; } }
  lap();
  return { spots, rooms, buildings, rejected, units, houseless, probes: allProbes, pool, nav, ms: Math.round(busy) };
}

/** per-match activation share of the canonical spots (hero / landmark chests 100 %; ammo boxes more in a building that
 * has little else) — placeLoot flips the coins, the thinning sizes the sets */
export const ACTIVATE = { chest: 0.4, floor: 0.34, wildChest: 0.5, wildFloor: 0.45, ammo: 0.3, rareChest: 0.08,
  /** an open POI's (≤ 1 enterable building) random chest share on top of its landing cover */
  openChest: 0.2,
  /** a hot drop's (tier 2) chests come up more often: the place pays for the fight */
  hotChest: 0.75,
  /** a hot TOWN's (≥ 15 enterable buildings: the market, the shipyard) — it already holds a gun per house */
  hotTownChest: 0.55,
  /** share of the (non-cover) floor spots that roll a gun; the rest are ammo / heals (a floor gun brings its ammo stack) */
  floorGun: 0.1 };
/** the LIVE loot a POI should hold per match (genre-typical density: ≈ 120–170 chests and ≈ 150–250 floor items for
 * 50 players, 3–4 weapons each). Sized by the POI's walkable area (`lattice` = its 11 m coverage probes on walkable
 * ground): one chest per ≈ 75 probes (≈ 9 000 m²), one floor spot per ≈ 50; hot POIs +6 chests / +5 floor spots
 * (others +1). The live set is then sized by COVERAGE first (placeLoot), which is what really sets the totals: a
 * weapon within 10 s of every landing point needs ≈ 225 weapon sources island-wide (a greedy set cover). Floor guns
 * are ≈ ⅓ of the floor spots. */
export function poiBudget(pi: number, lattice: number): { chest: number; floor: number } {
  const hot = poiTier(pi) === 2;
  // a hot drop holds more chest SPOTS too (+6): its designed rooms — the lab's server hall, labs, dish
  // platform; the temple's halls — come up as chests instead of being thinned away
  return { chest: Math.max(3, Math.round(lattice / 75) + (hot ? 6 : 0)), floor: Math.max(4, Math.round(lattice / 50) + (hot ? 5 : 1)) };
}

/** per-POI thinning to the canonical spots. Hero chests (designed, outside rooms: roofs / towers / the landmark, ≤ 3,
 * always on) first; then chests by greedy COVERAGE (each pick covers the most probes that still lack two weapon sources
 * within COVER_S, rooms preferred, ≥ 14 m apart on a level) up to the POI budget ÷ activation; floor spots by coverage +
 * spread (≥ 6 m apart, rooms preferred) the same way; a probe with no source at all gets one more spot. Last, AMMO BOXES:
 * every enterable building gets enough of them (against its walls) that it holds ≥ 1.75 live spots on average. */
function* canonical(cands: Cand[], pi: number, rooms: Room[], buildings: Building[], spots: LootSpot[], probes: Array<{ x: number; y: number; z: number }>,
  lattice: number, world: StaticWorld, valid: (c: Cand) => boolean, ops: () => number): Generator<void, void, void> {
  const budget = poiBudget(pi, lattice);
  const bldOf = (room: number) => room >= 0 ? rooms[room].bld : -1;
  const far = (list: LootSpot[], x: number, y: number, z: number, dh: number, dhOtherFloor: number) => list.every((s) => { const d = dmath.hypot(s.x - x, s.z - z); return Math.abs(s.y - y) >= 2.2 ? d >= dhOtherFloor : d >= dh; });
  const push = (c: Cand, src: Src, list: LootSpot[], kind = c.kind) => { const s: LootSpot = { id: 0, kind, src, x: c.x, y: c.y, z: c.z, yaw: c.yaw, poi: pi, bld: bldOf(c.room), room: c.room, sx: c.sx ?? c.x, sy: c.sy ?? c.y, sz: c.sz ?? c.z }; list.push(s); spots.push(s); return s; };
  let last = ops();
  const tick = () => { const o = ops(); if (o - last >= 12) { last = o; return true; } return false; };
  const chests: LootSpot[] = [], floors: LootSpot[] = [], boxes: LootSpot[] = [];
  const jit = (c: Cand) => (hash32(Math.round(c.x * 8), Math.round(c.z * 8) ^ pi) & 1023) / 1023;
  // probe coverage: need[p] = weapon sources still wanted within COVER_S (2); a chest gives 1, a floor spot ½
  const need = new Float32Array(probes.length).fill(2);
  const covers = (c: { x: number; y: number; z: number }, chest: boolean): number[] => {
    const out: number[] = [];
    for (let q = 0; q < probes.length; q++) { const P = probes[q]; if (Math.abs(P.x - c.x) > 60 || Math.abs(P.z - c.z) > 60) continue; if (reachTime(P.x, P.y, P.z, c.x, c.y, c.z, chest) <= COVER_S) out.push(q); }
    return out;
  };
  const cov = new Map<Cand, number[]>();
  const covOf = (c: Cand) => { let v = cov.get(c); if (!v) cov.set(c, v = covers(c, c.kind === SpotKind.Chest)); return v; };
  const take = (s: LootSpot, w: number) => { for (const q of covers(s, s.kind === SpotKind.Chest)) need[q] = Math.max(0, need[q] - w); };
  const minDist = (x: number, y: number, z: number) => { let m = 40; for (const s of chests) { if (Math.abs(s.y - y) < 2.2) m = Math.min(m, dmath.hypot(s.x - x, s.z - z)); } for (const s of floors) { if (Math.abs(s.y - y) < 2.2) m = Math.min(m, dmath.hypot(s.x - x, s.z - z)); } return m; };
  /** greedy: the best-scoring candidate that passes `ok` + validation, -1 = none left */
  const pick = function* (pool: Cand[], ok: (c: Cand) => boolean, score: (c: Cand) => number): Generator<void, Cand | null, void> {
    for (;;) {
      let best: Cand | null = null, bs = -Infinity;
      for (const c of pool) { if (c.v === 2 || !ok(c)) continue; const v = score(c); if (v > bs) { bs = v; best = c; } }
      if (!best) return null;
      if (valid(best)) return best;
      if (tick()) yield;
    }
  };
  const cc = cands.filter((c) => c.kind === SpotKind.Chest).sort((a, b) => (a.src - b.src) || (a.order - b.order));
  // the POI's VAULT ROOM: the first chest its author lists, when it stands in a room (Banana Temple's
  // dungeon dais, The Plantation's, Stilt Town's, Coconut Cove's, Canopy Line's headline chest) — a hero like the
  // landmarks below: always live, vault rarity (loot.ts).
  let vaults = 0;
  const heroOf = new Set<Cand>();
  { const v0 = cc.find((c) => c.src === Src.Designed && c.order === 0 && c.room >= 0); if (v0 && valid(v0)) { const s = push(v0, Src.Hero, chests); if (v0.hero) s.pay = 1; take(s, 1); heroOf.add(v0); vaults = 1; } }
  // hero: designed chests outside rooms, ≥ 12 m apart, ≤ 2 per POI (the designer lists them first)
  // the POI's PAYOFF chests first (LOOT_SPOTS.hero: a vault dais inside a room — else it loses the 14 m
  // chest spacing to outdoor coverage spots and ends up an ammo box): always on, a Rare Chest (loot.ts); they take hero slots
  // (the POI's live chest count does not grow). The vault room above may already be one of them.
  for (const c of cc) { if (!c.hero || heroOf.has(c) || chests.length >= 2 + vaults || !valid(c)) continue; const s = push(c, Src.Hero, chests); s.pay = 1; take(s, 1); heroOf.add(c); if (tick()) yield; }
  for (const c of cc) { if (c.src !== Src.Designed || c.room >= 0 || c.hero) continue; if (chests.length >= 2 + vaults) break; if (far(chests, c.x, c.y, c.z, 12, 12) && valid(c)) take(push(c, Src.Hero, chests), 1); if (tick()) yield; }
  const heroes = chests.length;
  // an OPEN POI (≤ 1 enterable building: a mountain, a falls, a beached wreck) holds fewer chest spots
  // (× 0.6): otherwise Ripe Peak's lattice points beside boulders outnumber every town's chests
  const open = buildings.filter((B) => B.poi === pi && B.enterable).length <= 1;
  // a hot TOWN (≥ 15 enterable buildings: the market, the shipyard) already holds a house gun per building —
  // it keeps a +3 hot bonus; the extra +3 goes to the hot drops with few buildings (the lab, the temple)
  const town = buildings.filter((B) => B.poi === pi && B.enterable).length >= 15;
  const nChest = heroes + Math.max(0, Math.round((budget.chest * (open ? 0.6 : 1) - (town && poiTier(pi) === 2 ? 3 : 0) - heroes) / 0.45));
  const used = new Set<Cand>();
  // DESIGNED chests first: the rooms the POI's author furnished for loot (the lab's server hall, labs,
  // control room; the market's shops) — the coverage greedy below prefers lattice chests in the open (they reach more
  // landing probes), so it alone would keep few designed room chests and many on bare ground. Same spacing rules.
  for (const c of cc) {
    if (chests.length >= nChest) break;
    if (c.src !== Src.Designed || used.has(c) || chests.some((h) => h.x === c.x && h.z === c.z && h.y === c.y)) continue;
    if (!far(chests, c.x, c.y, c.z, 14, 7) || !valid(c)) continue;
    used.add(c); take(push(c, c.src, chests), 1);
    if (tick()) yield;
  }
  while (chests.length < nChest) {
    const c = yield* pick(cc, (q) => !used.has(q) && far(chests, q.x, q.y, q.z, 14, 7),
      (q) => { let g = 0; for (const k of covOf(q)) g += Math.min(1, need[k]); return g * (q.room >= 0 ? 1.4 : 1) * (q.src === Src.Designed ? 1.2 : 1) + minDist(q.x, q.y, q.z) * 0.05 + jit(q) * 0.5; });
    if (!c) break;
    used.add(c); take(push(c, c.src, chests), 1);
    if (tick()) yield;
  }
  const fc = cands.filter((c) => c.kind === SpotKind.Floor);
  const nFloor = Math.round(budget.floor / ACTIVATE.floor);
  while (floors.length < nFloor) {
    const c = yield* pick(fc, (q) => !used.has(q) && far(floors, q.x, q.y, q.z, 6, 3) && far(chests, q.x, q.y, q.z, 2, 1),
      (q) => { let g = 0; for (const k of covOf(q)) g += Math.min(0.5, need[k]); return g * 0.5 + minDist(q.x, q.y, q.z) * 0.12 * (q.room >= 0 ? 1.5 : 1) * (q.src === Src.Designed ? 1.2 : 1) + jit(q) * 0.5; });
    if (!c) break;
    used.add(c); take(push(c, c.src, floors), 0.5);
    if (tick()) yield;
  }
  // probes nothing reaches within COVER_S (a rock plateau, a mountain flank, a lone roof): a greedy cover over the
  // remaining candidates and the probes' own places (a floor spot right there), the one that reaches the most first
  // then a TIGHT pass: probes with no canonical spot within COVER_T (8 s promise at the landing points)
  // (the tight pass stays for an OPEN POI too: its candidates are what keeps a mountain's worst landing point bounded —
  // placeLoot lights them against the 10 s promise there, so fewer come up per match)
  for (const T of [COVER_S, COVER_T]) {
    const lone: number[] = [];
    if (T === COVER_S) { for (let q = 0; q < probes.length; q++) if (need[q] >= 2) lone.push(q); }
    else for (let q = 0; q < probes.length; q++) { const P = probes[q]; if ((P as { room?: number }).room) continue; let ok = false; for (const sp of [...chests, ...floors]) if (Math.abs(sp.x - P.x) < 60 && Math.abs(sp.z - P.z) < 60 && reachTime(P.x, P.y, P.z, sp.x, sp.y, sp.z, sp.kind === SpotKind.Chest) <= T) { ok = true; break; } if (!ok) lone.push(q); }
    const lonely = new Set(lone);
    if (lone.length) {
      const pool: Cand[] = [...cc, ...fc].filter((c) => !used.has(c) && c.v !== 2);
      for (const q of lone) {
        const P = probes[q];
        // the lone ground's chest backed against its cover first (backedPlace; ties go to the first)
        const bp = backedPlace(world, P.x, P.y, P.z);
        if (bp) pool.push({ kind: SpotKind.Chest, src: Src.Scan, x: bp.x, y: bp.y, z: bp.z, yaw: bp.yaw, poi: pi, room: -1, order: 3000, v: 0, free: false });
        pool.push({ kind: SpotKind.Chest, src: Src.Scan, x: P.x, y: P.y + 0.02, z: P.z, yaw: (hash32(q, pi) & 1023) / 1023 * 6.283, poi: pi, room: -1, order: 3000, v: 0, free: true }, { kind: SpotKind.Floor, src: Src.Scan, x: P.x, y: P.y + 0.02, z: P.z, yaw: 0, poi: pi, room: -1, order: 3001, v: 0 });
      }
      const reach = new Map<Cand, number[]>();
      for (const c of pool) { const o: number[] = []; for (const q of lone) { const P = probes[q]; if (Math.abs(P.x - c.x) < 60 && Math.abs(P.z - c.z) < 60 && reachTime(P.x, P.y, P.z, c.x, c.y, c.z, c.kind === SpotKind.Chest) <= T) o.push(q); } if (o.length) reach.set(c, o); }
      for (;;) {
        let best: Cand | null = null, bn = 0;
        for (const [c, o] of reach) { if (c.v === 2) continue; let n = 0; for (const q of o) if (lonely.has(q)) n++; const v = n * (c.kind === SpotKind.Chest ? 2 : 1); if (v > bn) { bn = v; best = c; } }
        if (!best) break;
        if (!far(floors, best.x, best.y, best.z, 3, 2) || !far(chests, best.x, best.y, best.z, 3, 2) || !valid(best)) { best.v = 2; reach.delete(best); if (tick()) yield; continue; }
        // an outdoor lone-probe spot in a fenced yard / pen the kong cannot walk out of: never
        if (best.room < 0) { world.findUnstick(best.sx ?? best.x, (best.sy ?? best.y) + 0.02, best.sz ?? best.z, PLAYER_R, PLAYER_H); if (world.enclosedAt >= 0) { best.v = 2; reach.delete(best); rejectedEnclosed++; if (tick()) yield; continue; } }
        const got = reach.get(best)!.filter((q) => lonely.has(q));
        used.add(best); reach.delete(best);
        const sp = push(best, best.src, best.kind === SpotKind.Chest ? chests : floors); take(sp, 2); for (const q of got) lonely.delete(q);
        // an ALTERNATE for the same lonely ground (another ledge / rock top that reaches ≥ 60 % of it): placeLoot's cover
        // then picks one of the two each match, so a mountain flank is not the same chest every time
        if (got.length >= 2) {
          const gs = new Set(got);
          let alt: Cand | null = null, an = 0;
          for (const [c, o] of reach) { if (c.v === 2 || c.kind !== best.kind || dmath.hypot(c.x - best.x, c.z - best.z) < 5) continue; let n = 0; for (const q of o) if (gs.has(q)) n++; if (n >= 0.6 * got.length && n > an) { an = n; alt = c; } }
          if (alt && far(floors, alt.x, alt.y, alt.z, 3, 2) && far(chests, alt.x, alt.y, alt.z, 3, 2) && valid(alt)) { used.add(alt); reach.delete(alt); push(alt, alt.src, alt.kind === SpotKind.Chest ? chests : floors); }
        }
        if (tick()) yield;
      }
    }
  }
  // ammo boxes: an enterable building expects ≥ 1.75 live spots per match (≥ 1.5 on average over seeds)
  const exp = new Map<number, number>();
  for (const s of [...chests, ...floors]) if (s.bld >= 0) exp.set(s.bld, (exp.get(s.bld) ?? 0) + (s.src === Src.Hero ? 1 : s.kind === SpotKind.Chest ? ACTIVATE.chest : ACTIVATE.floor));
  const byB = new Map<number, Cand[]>();
  for (const c of [...cc, ...fc]) { const b = bldOf(c.room); if (b < 0 || used.has(c) || !buildings[b].enterable) continue; let m = byB.get(b); if (!m) byB.set(b, m = []); m.push(c); }
  for (const B of buildings) {
    if (B.poi !== pi || !B.enterable) continue;
    const e = exp.get(B.id) ?? 0;
    // ≥ 2 boxes where the building has nothing else (placeLoot raises their odds so 2 still average ≥ 1.75)
    const want = e >= 1.75 ? 0 : e >= 1.05 ? 2 : 3;
    const list = (byB.get(B.id) ?? []).sort((a, b) => (a.kind - b.kind) || (a.src - b.src) || (jit(a) - jit(b)));
    let got = 0;
    for (const c0 of list) {
      if (got >= want) break;
      if (!far(boxes, c0.x, c0.y, c0.z, B.cells < 20 ? 1.6 : 3, 1.2) || !far(chests, c0.x, c0.y, c0.z, 1.6, 1) || !far(floors, c0.x, c0.y, c0.z, 1.2, 1)) continue;
      // a box is a container: validated with the container rule (a floor candidate turns to face its stand place)
      const c: Cand = { ...c0, kind: SpotKind.Ammo, v: 0, free: c0.kind === SpotKind.Floor ? true : c0.free };
      if (!valid(c)) continue;
      used.add(c0); push(c, c.src === Src.Hero ? Src.Designed : c.src, boxes); got++;
      if (tick()) yield;
    }
  }
  void world;
}

// ------------------------------------------------------------------------------------------------ room units
/** a building with at least this many roofed cells (1.25 m) is HOT (≈ 625 m²: the Coconut Cove hotel) */
export const HOT_CELLS = 400;
/** hot buildings: chest spots per storey (≥ 1 live per storey every match) and on the roof */
const HOT_CHESTS = 4, HOT_ROOF_CHESTS = 2;
/** a hot drop's landmark building (see the hot flagging in roomUnits): its roofed cells, and its chests per storey / roof */
const LANDMARK_CELLS = 320, LANDMARK_CHESTS = 1, LANDMARK_ROOF_CHESTS = 1;
/** the POIs' declared hot zones, read once */
let HOT_ZONES: Record<string, HotZone[]> | null = null;
/** (house guns) floor spots per enterable building that can carry its guaranteed gun (placeLoot lights one per match) */
const HOUSE_SPOTS = 2;
/** (house guns) a door's rank for the bots: 0 its outside point is ≤ 1.6 m above the ground (navPath routes a bot on
 * the ground through it), 1 a raised door (a balcony, a stilt deck: only a bot already up there) */
const navDoorRank = (world: StaticWorld, x: number, y: number, z: number) => y - Math.max(0, world.terrain.height(x, z)) > 1.6 ? 1 : 0;
const levelOf = (levels: number[], y: number) => { let k = 0; for (let i = 0; i < levels.length; i++) if (y >= levels[i] - 0.6) k = i; return k; };
/** every enterable room gets loot BY DESIGN. Units: (0) interiors-kit rooms with a door / gap,
 * ≥ 9 m², inside an enterable building; (1) scanned rooms (≥ 6 cells) the kit covers < 60 %; (2) storeys with neither.
 * Every canonical spot of the POI is tagged with its unit; a unit gets a FALLBACK spot (an ammo box — in a hot building a
 * floor heal / ammo stack — never a gun) that placeLoot lights when nothing else in the unit is live. Hot buildings also
 * get HOT_CHESTS chest spots per storey (≥ 6 m apart; ≥ 1 live per storey) and HOT_ROOF_CHESTS on their roof. */
function* roomUnits(world: StaticWorld, pi: number, sc: Scan, rooms: Room[], buildings: Building[], spots: LootSpot[], cands: Cand[], kits: KitRoomLite[],
  valid: (c: Cand) => boolean, units: Unit[], first: number, houses: LootSpot[], houseless: SpotSet["houseless"]): Generator<void, void, void> {
  const cells = sc.cells;
  const ck = (ix: number, iz: number) => (ix + 4096) * 8192 + (iz + 4096);
  const near = (x: number, z: number, r: number, f: (j: number) => void) => { for (let ix = Math.floor((x - r) / G); ix <= Math.floor((x + r) / G); ix++) for (let iz = Math.floor((z - r) / G); iz <= Math.floor((z + r) / G); iz++) for (const j of sc.byCol.get(ck(ix, iz)) ?? []) f(j); };
  const inRect = (r: { x: number; z: number; yaw: number; w: number; d: number }, x: number, z: number, m: number) => { const c = dmath.cos(r.yaw), s = dmath.sin(r.yaw), dx = x - r.x, dz = z - r.z; return Math.abs(dx * c - dz * s) <= r.w / 2 + m && Math.abs(dx * s + dz * c) <= r.d / 2 + m; };
  // + a POI's declared hot zones (LOOT_HOT: its payoff buildings, any size / storey count)
  const zones = (HOT_ZONES ??= hotZonesById())[POIS[pi].id] ?? [];
  const zoneOf = (B: Building): HotZone | undefined => zones.find((q) => dmath.hypot(B.x - q.x, B.z - q.z) <= q.r);
  for (const B of buildings) if (B.poi === pi && B.enterable && ((B.cells >= HOT_CELLS && B.levels.length >= 2) || zoneOf(B))) B.hot = true;
  // a LANDMARK of a hot drop — ≥ LANDMARK_CELLS of roofed floor over ≥ 4 storeys: Peel Harbor's ship
  // house, Mango Market's 5-storey hall — is hot too, with fewer chests per storey (otherwise it holds only fallback
  // ammo boxes and < 1 chest a match)
  const landmark = new Set<number>();
  for (const B of buildings) if (B.poi === pi && B.enterable && !B.hot && poiTier(pi) === 2 && B.cells >= LANDMARK_CELLS && B.levels.length >= 4) { B.hot = true; landmark.add(B.id); }
  const u0 = units.length;
  const covered = new Uint8Array(cells.length);
  // (0) kit rooms
  for (const r of kits) {
    if (r.w * r.d < 9 || !r.openings?.some((o) => o.kind === "door" || o.kind === "gap")) continue;
    const votes = new Map<number, number>(), mine: number[] = [];
    near(r.x, r.z, dmath.hypot(r.w, r.d) / 2, (j) => { const C = cells[j]; if (Math.abs(C.y - r.y) > 0.5 || !inRect(r, C.x, C.z, 0)) return; mine.push(j); const b = sc.cbld[j]; if (b >= 0 && buildings[b].enterable) votes.set(b, (votes.get(b) ?? 0) + 1); });
    if (!votes.size) continue;
    const b = [...votes].sort((p, q) => q[1] - p[1])[0][0];
    for (const j of mine) covered[j] = 1;
    units.push({ id: units.length, poi: pi, bld: b, storey: levelOf(buildings[b].levels, r.y), kind: 0, x: r.x, y: r.y, z: r.z, area: r.w * r.d, rect: { x: r.x, z: r.z, yaw: r.yaw, w: r.w, d: r.d } });
  }
  yield;
  // (1) scanned rooms the kit does not cover
  const roomCells = new Map<number, number[]>();
  for (let j = 0; j < cells.length; j++) { const r = cells[j].room; if (r < 0) continue; let l = roomCells.get(r); if (!l) roomCells.set(r, l = []); l.push(j); }
  const scanUnit = new Map<number, number>();
  for (const [r, l] of roomCells) {
    const R = rooms[r]; if (R.sealed || !buildings[R.bld].enterable || l.length < 6) continue;
    let cv = 0; for (const j of l) cv += covered[j];
    if (cv >= 0.6 * l.length) continue;
    scanUnit.set(r, units.length);
    units.push({ id: units.length, poi: pi, bld: R.bld, storey: levelOf(buildings[R.bld].levels, R.y), kind: 1, x: R.x, y: R.y, z: R.z, area: l.length * G * G });
  }
  // (2) storeys with no unit
  const storeyUnit = new Map<number, number>();
  for (const B of buildings) {
    if (B.poi !== pi || !B.enterable) continue;
    B.levels.forEach((L, k) => {
      if (units.some((u, i) => i >= u0 && u.bld === B.id && u.storey === k)) return;
      let sx = 0, sz = 0, n = 0; for (let j = 0; j < cells.length; j++) if (sc.cbld[j] === B.id && Math.abs(cells[j].y - L) < 0.5) { sx += cells[j].x; sz += cells[j].z; n++; }
      if (!n) return;
      storeyUnit.set(B.id * 16 + k, units.length);
      units.push({ id: units.length, poi: pi, bld: B.id, storey: k, kind: 2, x: sx / n, y: L, z: sz / n, area: n * G * G });
    });
  }
  /** the unit a point lies in, -1 = none */
  const unitOf = (x: number, y: number, z: number): number => {
    for (let i = u0; i < units.length; i++) { const u = units[i]; if (u.kind === 0 && Math.abs(y - u.y) < 0.7 && inRect(u.rect!, x, z, 0.1)) return i; }
    let best = -1, bd = 1.3; near(x, z, 1.3, (j) => { const C = cells[j]; const dy = Math.abs(C.y - y); if (dy > 0.6) return; const d = dmath.hypot(C.x - x, C.z - z) + dy; if (d < bd) { bd = d; best = j; } });
    if (best < 0) return -1;
    const C = cells[best];
    if (C.room >= 0 && scanUnit.has(C.room)) return scanUnit.get(C.room)!;
    const b = sc.cbld[best]; if (b < 0) return -1;
    const k = storeyUnit.get(b * 16 + levelOf(buildings[b].levels, C.y)); return k ?? -1;
  };
  for (let k = first; k < spots.length; k++) { const q = spots[k]; q.unit = unitOf(q.x, q.y, q.z); }
  yield;
  // candidate pools per unit (designed kit slots + scan wall chests / floor spots of this POI)
  const byUnit = new Map<number, Cand[]>();
  for (const c of cands) { if (c.v === 2) continue; const u = unitOf(c.x, c.y, c.z); if (u < 0) continue; let l = byUnit.get(u); if (!l) byUnit.set(u, l = []); l.push(c); }
  const clear = (x: number, y: number, z: number, d: number) => { for (let k = first; k < spots.length; k++) { const q = spots[k]; if (Math.abs(q.y - y) < 1.5 && dmath.hypot(q.x - x, q.z - z) < d) return false; } return true; };
  const pushSpot = (c: Cand, kind: SpotKind, u: number, extra: Partial<LootSpot> = {}) => {
    const s: LootSpot = { id: 0, kind, src: c.src === Src.Hero ? Src.Designed : c.src, x: c.x, y: c.y, z: c.z, yaw: c.yaw, poi: pi, bld: units[u]?.bld ?? -1, room: c.room, sx: c.sx ?? c.x, sy: c.sy ?? c.y, sz: c.sz ?? c.z, unit: u, ...extra };
    spots.push(s); return s;
  };
  /** try a candidate as `kind` (containers keep a wall yaw, or turn to face their stand place when they came from a floor slot) */
  const tryAs = (c0: Cand, kind: SpotKind): Cand | null => { const c: Cand = { ...c0, kind, v: 0, free: kind === SpotKind.Floor ? false : c0.kind === SpotKind.Floor ? true : c0.free }; return valid(c) ? c : null; };
  let ticks = 0;
  // a unit the kong cannot walk into (an upper storey whose stairs do not work, a sealed attic): no loot there
  const dead = new Set<number>();
  for (let u = u0; u < units.length; u++) {
    const U = units[u]; let c = -1, bd = 3;
    near(U.x, U.z, 3, (j) => { const C = cells[j]; if (Math.abs(C.y - U.y) > 0.5) return; const d = dmath.hypot(C.x - U.x, C.z - U.z); if (d < bd && (!U.rect || inRect(U.rect, C.x, C.z, 0))) { bd = d; c = j; } });
    if (c < 0) { dead.add(u); continue; }
    if (!walkable(world, cells[c].x, cells[c].y, cells[c].z)) dead.add(u);
    if ((u & 15) === 15) yield;
  }
  for (let u = u0; u < units.length; u++) {
    if ((++ticks & 7) === 0) yield;
    if (dead.has(u)) continue;
    const U = units[u], B = buildings[U.bld];
    const pool = (byUnit.get(u) ?? []).slice().sort((a, b) => (a.kind - b.kind) || (a.src - b.src) || (a.order - b.order));
    // hot buildings: a floor heal / ammo stack is the fallback (the hotel reads as looted rooms, not ammo crates)
    const fbKind = B.hot && (u & 1) === 0 ? SpotKind.Floor : SpotKind.Ammo;
    let got: LootSpot | null = null;
    for (const c of pool) {
      if (!clear(c.x, c.y, c.z, 1.2)) continue;
      const v = tryAs(c, fbKind) ?? (fbKind === SpotKind.Ammo ? tryAs(c, SpotKind.Floor) : null);
      if (v) { got = pushSpot(v, v.kind, u, { fb: 1 }); break; }
    }
    if (!got) {
      // no candidate: the unit's own cells — a wall box (corners first), then the open floor nearest its centre
      const ids: number[] = []; near(U.x, U.z, U.rect ? dmath.hypot(U.rect.w, U.rect.d) / 2 : 12, (j) => { const C = cells[j]; if (Math.abs(C.y - U.y) < 0.5 && unitOf(C.x, C.y, C.z) === u) ids.push(j); });
      for (const w of wallChests(world, cells, ids).slice(0, 4)) {
        if (!clear(w.x, w.y, w.z, 1.2)) continue;
        const v = tryAs({ kind: SpotKind.Chest, src: Src.Scan, x: w.x, y: w.y, z: w.z, yaw: w.yaw, poi: pi, room: cells[ids[0]]?.room ?? -1, order: 4000, v: 0 }, fbKind === SpotKind.Floor ? SpotKind.Floor : SpotKind.Ammo);
        if (v) { got = pushSpot(v, v.kind, u, { fb: 1 }); break; }
      }
      if (!got) for (const j of ids.sort((a, b) => dmath.hypot(cells[a].x - U.x, cells[a].z - U.z) - dmath.hypot(cells[b].x - U.x, cells[b].z - U.z)).slice(0, 6)) {
        const C = cells[j]; if (!clear(C.x, C.y, C.z, 1.2)) continue;
        const v = tryAs({ kind: SpotKind.Floor, src: Src.Scan, x: C.x, y: C.y, z: C.z, yaw: 0, poi: pi, room: C.room, order: 4001, v: 0 }, SpotKind.Floor);
        if (v) { got = pushSpot(v, SpotKind.Floor, u, { fb: 1 }); break; }
      }
    }
  }
  yield;
  // hot buildings: chests on every storey + the roof
  for (const B of buildings) {
    if (B.poi !== pi || !B.hot) continue;
    for (let k = 0; k < B.levels.length; k++) {
      // every chest slot the kit has in this storey's rooms (the POI's LOOT_SPOTS keep ~1 per 6 m) + the scan's
      const kitC: Cand[] = [];
      for (const r of kits) { if (Math.abs(r.y - B.levels[k]) > 0.6) continue; const u = unitOf(r.x, r.y, r.z); if (u < u0 || units[u].bld !== B.id || dead.has(u)) continue; for (const q of furnishRoom(r as unknown as InteriorRoom).loot.chests) kitC.push({ kind: SpotKind.Chest, src: Src.Designed, x: q[0], y: q[1], z: q[2], yaw: q[3], poi: pi, room: -1, order: 5000, v: 0 }); }
      const pool = [...cands, ...kitC].filter((c) => c.kind === SpotKind.Chest && c.v !== 2 && Math.abs(c.y - B.levels[k]) < 0.6 && (() => { const u = unitOf(c.x, c.y, c.z); return u >= u0 && units[u].bld === B.id && !dead.has(u); })())
        .sort((a, b) => (a.src - b.src) || (hash32(Math.round(a.x * 4), Math.round(a.z * 4)) - hash32(Math.round(b.x * 4), Math.round(b.z * 4))));
      let n = 0;
      const perStorey = zoneOf(B)?.chests ?? (landmark.has(B.id) ? LANDMARK_CHESTS : HOT_CHESTS);
      for (const c of pool) {
        if (n >= perStorey) break;
        const far = spots.every((q, i) => i < first || q.kind !== SpotKind.Chest || Math.abs(q.y - c.y) > 1.5 || dmath.hypot(q.x - c.x, q.z - c.z) >= 6);
        if (!far || !clear(c.x, c.y, c.z, 1.0)) continue;
        const v = tryAs(c, SpotKind.Chest); if (!v) continue;
        pushSpot(v, SpotKind.Chest, unitOf(v.x, v.y, v.z), { hot: B.id * 16 + k }); n++;
        yield;
      }
    }
    // the roof: candidates above the building's top storey whose column holds this building's cells
    const top = B.levels[B.levels.length - 1];
    // the roof surface over the top storey's cells (every 3rd cell, hash-ordered): a walkable flat ≥ 1.5 m above it
    const roof: Cand[] = [];
    for (let j = 0; j < cells.length; j++) {
      if (sc.cbld[j] !== B.id || Math.abs(cells[j].y - top) > 0.5 || (hash32(cells[j].ix, cells[j].iz) % 3) !== 0) continue;
      const C = cells[j]; world.raycast(C.x, top + 12, C.z, 0, -1, 0, 12, H, false);
      if (!H.hit || H.y < top + 1.5 || H.ny < 0.9) continue;
      roof.push({ kind: SpotKind.Chest, src: Src.Scan, x: C.x, y: H.y + 0.02, z: C.z, yaw: (hash32(C.ix * 7, C.iz) & 1023) / 1023 * 6.283, poi: pi, room: -1, order: 6000, v: 0, free: true });
    }
    roof.sort((a, b) => hash32(Math.round(a.x * 4), Math.round(a.z * 4)) - hash32(Math.round(b.x * 4), Math.round(b.z * 4)));
    let n = 0;
    const perRoof = zoneOf(B)?.roof ?? (landmark.has(B.id) ? LANDMARK_ROOF_CHESTS : HOT_ROOF_CHESTS);
    for (const c of roof) {
      if (n >= perRoof) break;
      if (!spots.every((q, i) => i < first || Math.abs(q.y - c.y) > 1.5 || dmath.hypot(q.x - c.x, q.z - c.z) >= 8)) continue;
      const v = tryAs({ ...c, free: true }, SpotKind.Chest); if (!v) continue;
      pushSpot(v, SpotKind.Chest, -1, { hot: B.id * 16 + 15 }); n++;
    }
  }
  yield;
  // (house guns) EVERY enterable building gets up to HOUSE_SPOTS floor spots for its guaranteed gun: placeLoot makes one
  // of them (or one of the building's canonical floor spots) a floor weapon every match. Same tests as every other spot:
  // validateSpot's floor rule (0.3 m item volume, a stand place in reach with a clear eye line, not a pocket), the
  // walk-out test at the stand place (loot-walk validation), never in a unit the kong cannot walk into (a storey whose
  // stairs do not work), ≥ 1 m from other loot, and the nav cell under it (same floor, clear line — the census's
  // buildingAt) in THIS building. Door storey first; the alternate ≥ 3 m away so the gun is not always in one place.
  const cellAt = (x: number, y: number, z: number): number => {
    const cand: Array<[number, number]> = [];
    near(x, z, 1.6, (j) => { const C = cells[j]; const dy = Math.abs(C.y - y); if (dy > 0.7) return; const d = dmath.hypot(C.x - x, C.z - z); if (d <= 1.6) cand.push([d + dy, j]); });
    cand.sort((p, q) => p[0] - q[0]);
    for (const [, j] of cand) if (world.clear(x, y + 0.5, z, cells[j].x, cells[j].y + 0.5, cells[j].z)) return j;
    return -1;
  };
  // the bots' view: the walk component of the nav cell under a point (navCellAt's rule) and the best door it has
  const doorOf = new Map<number, number>();
  for (const [a, e] of sc.exits) { const r = navDoorRank(world, e[0], e[1], e[2]), k = sc.comp[a]; if (!(doorOf.get(k)! <= r)) doorOf.set(k, r); }
  const navRank = (x: number, y: number, z: number): number => {
    let best = -1, bd = 1.3; near(x, z, 1.3, (j) => { const C = cells[j]; const dy = Math.abs(C.y - y); if (dy > 0.7) return; const d = dmath.hypot(C.x - x, C.z - z) + dy * 0.5; if (d < bd) { bd = d; best = j; } });
    return best < 0 ? 2 : doorOf.get(sc.comp[best]) ?? 2;
  };
  const h0 = houses.length;
  for (const B of buildings) {
    if (B.poi !== pi || !B.enterable) continue;
    if ((++ticks & 3) === 0) yield;
    const key = (c: Cand) => hash32(Math.round(c.x * 4), Math.round(c.z * 4) ^ B.id);
    const pool = cands.filter((c) => c.v !== 2 && c.room >= 0 && rooms[c.room].bld === B.id && !rooms[c.room].sealed)
      .sort((a, b) => (levelOf(B.levels, a.y) - levelOf(B.levels, b.y)) || ((a.kind === SpotKind.Floor ? 0 : 1) - (b.kind === SpotKind.Floor ? 0 : 1)) || (a.src - b.src) || (key(a) - key(b)));
    // a small hut's candidates are often all taken by its ammo boxes: then its own room cells (nearest the room centre)
    const own: Cand[] = [];
    for (let j = 0; j < cells.length; j++) { const C = cells[j]; if (sc.cbld[j] === B.id && C.room >= 0 && !rooms[C.room].sealed) own.push({ kind: SpotKind.Floor, src: Src.Scan, x: C.x, y: C.y, z: C.z, yaw: 0, poi: pi, room: C.room, order: 7000, v: 0 }); }
    const dc = (c: Cand) => dmath.hypot(c.x - rooms[c.room].x, c.z - rooms[c.room].z);
    own.sort((a, b) => (levelOf(B.levels, a.y) - levelOf(B.levels, b.y)) || (dc(a) - dc(b)) || (key(a) - key(b)));
    pool.push(...own);
    // (a spot the bots can route to first — players reach every candidate; bots only through doors their graph knows)
    const nr = new Map<Cand, number>(); for (const c of pool) nr.set(c, navRank(c.x, c.y, c.z));
    pool.sort((a, b) => nr.get(a)! - nr.get(b)!);
    const got: LootSpot[] = [], why = new Map<string, number>(), no = (w: string) => { why.set(w, (why.get(w) ?? 0) + 1); };
    for (const c0 of pool) {
      if (got.length >= HOUSE_SPOTS) break;
      const u = unitOf(c0.x, c0.y, c0.z);
      if (u >= 0 && dead.has(u)) { no("storey not walkable"); continue; }
      if (!clear(c0.x, c0.y, c0.z, 1.0) || houses.some((q, i) => i >= h0 && Math.abs(q.y - c0.y) < 1.5 && dmath.hypot(q.x - c0.x, q.z - c0.z) < (q.house === B.id ? 3 : 1.0))) { no("crowded by other loot"); continue; }
      const c: Cand = { ...c0, kind: SpotKind.Floor, v: 0, free: false };
      if (!valid(c)) { no("fails validateSpot"); continue; }
      const cl = cellAt(c.x, c.y, c.z);
      if (cl < 0 || sc.cbld[cl] !== B.id) { no("stands in another building's cell"); continue; }
      if (!walkable(world, c.sx!, c.sy!, c.sz!)) { no("stand place not walkable"); continue; }
      const sp: LootSpot = { id: 0, kind: SpotKind.Floor, src: c.src === Src.Hero ? Src.Designed : c.src, x: c.x, y: c.y, z: c.z, yaw: 0, poi: pi, bld: B.id, room: c.room, sx: c.sx!, sy: c.sy!, sz: c.sz!, unit: unitOf(c.x, c.y, c.z), house: B.id, navIn: navRank(c.x, c.y, c.z) };
      houses.push(sp); got.push(sp);
    }
    // (no house spot: placeLoot falls back to its canonical floor spots, then its room fallback floor spot, then a chest)
    if (!got.length && !spots.some((q, i) => i >= first && q.kind === SpotKind.Floor && q.bld === B.id))
      houseless.push({ bld: B.id, poi: pi, x: B.x, z: B.z, why: pool.length ? [...why].map(([w, n]) => `${w} ×${n}`).join(", ") : "no candidate spot in its rooms" });
  }
}

/** wilderness: a 95 m lattice (hash-jittered) of flat, dry, sheltered spots outside every POI radius.
 * Each lattice cell tries up to 8 jittered places for its sheltered spot (one try finds only 24 on the whole
 * island: 8 % of the land > 30 s from any weapon — a glider landing between POIs runs half a minute unarmed). Every
 * spot sits against cover (a rock, a trunk, a wall): a loot pocket on the rotation, not a chest in the middle of a field. */
function* wild(world: StaticWorld, spots: LootSpot[], rejected: Rejected[], pool: SpotSet["pool"]): Generator<void, void, void> {
  const half = world.terrain.half - 40, STEP = 95;
  for (let gx = -half; gx <= half; gx += STEP) for (let gz = -half; gz <= half; gz += STEP) {
    if (gz === -half) yield;
    for (let k = 0; k < 8; k++) {
      const h = hash32(Math.round(gx) + k * 7919, Math.round(gz) - k * 104729);
      const x = gx + ((h & 1023) / 1023 - 0.5) * STEP * 0.7, z = gz + (((h >>> 10) & 1023) / 1023 - 0.5) * STEP * 0.7;
      if (POIS.some((p) => dmath.pow(p.x - x, 2) + dmath.pow(p.z - z, 2) < dmath.pow(p.r + 25, 2))) continue;
      const y = world.ground(x, z);
      if (y < 1.5) continue;
      const n = world.terrain.normal(x, z); if (n[1] < 0.9) continue;
      // sheltered: something solid (rock / trunk / wall) within 6 m at chest height in ≥ 1 of 8 directions
      let cover = 0;
      for (let d = 0; d < 8; d++) { const a = d / 8 * Math.PI * 2; world.raycast(x, y + 0.9, z, dmath.cos(a), 0, dmath.sin(a), 6, H, true); if (H.hit && H.box >= 0) cover++; }
      if (!cover) continue;
      const kind = ((h >>> 20) & 7) < 2 ? SpotKind.Chest : SpotKind.Floor;
      const v = validateSpot(world, kind, x, y + 0.05, z, ((h >>> 23) & 255) / 255 * Math.PI * 2, true);
      if (v.why) { rejected.push({ kind, src: Src.Wild, poi: -1, x, y, z, why: v.why }); continue; }
      pool.wild++;
      spots.push({ id: 0, kind, src: Src.Wild, x: v.x, y: v.y, z: v.z, yaw: kind === SpotKind.Chest ? v.yaw : 0, poi: -1, bld: -1, room: -1, sx: STAND[0], sy: STAND[1], sz: STAND[2] });
      break;
    }
  }
}

// ------------------------------------------------------------------------------------------------ rotation-path spots
// Floor spots for the EXTRA HEALS placeLoot lays along the island's rotation routes: the roads and trails
// between POIs (terrain-gen pathLines: the drawn roads + the generated rotation trails), the bridges they cross, and the
// zipline decks. One candidate per PATH_STEP m of route outside the POIs, on the route's shoulder (not its crown) and
// next to cover when there is some; every one passes validateSpot (a walkable floor right under it, its volume free, a
// clear standing place in reach) and is dry (≥ PATH_DRY m: never in a river, the surf or a swamp). Cached per world.
export interface PathSpot { x: number; y: number; z: number; sx: number; sy: number; sz: number;
  /** 0 a road / trail shoulder · 1 a bridge deck · 2 a zipline deck */
  kind: 0 | 1 | 2; line: string }
/** route metres between two candidates; candidates closer than PATH_GAP (two routes meeting) collapse into one */
const PATH_STEP = 55, PATH_GAP = 30, PATH_DRY = 1.1;
const PATH_C = new WeakMap<StaticWorld, PathSpot[]>();
const PH = makeHit();
/** the walk surface at (x, z): a box top (a bridge / boardwalk deck) or the terrain — NaN when steep / none */
function walkTop(world: StaticWorld, x: number, z: number): { y: number; deck: boolean } | null {
  const g = world.ground(x, z);
  world.raycast(x, Math.max(g, 0) + 5, z, 0, -1, 0, 10, PH, false);
  if (!PH.hit || PH.ny < SLOPE_LIMIT) return null;
  // a box top more than 0.6 m over the ground counts only as a wide deck (a bridge / boardwalk), never a rock / crate top
  if (PH.box >= 0 && PH.y > g + 0.6) { if (Math.min(world.hx[PH.box], world.hz[PH.box]) < 1.2) return null; return { y: PH.y, deck: true }; }
  return { y: PH.y, deck: PH.box >= 0 && g < PATH_DRY };
}
export function pathSpots(world: StaticWorld): PathSpot[] {
  const got = PATH_C.get(world); if (got) return got;
  const out: PathSpot[] = [];
  const far = (x: number, z: number) => !out.some((q) => dmath.pow(q.x - x, 2) + dmath.pow(q.z - z, 2) < PATH_GAP * PATH_GAP);
  const inPoi = (x: number, z: number) => POIS.some((p) => dmath.pow(p.x - x, 2) + dmath.pow(p.z - z, 2) < dmath.pow(p.r + 10, 2));
  const sheltered = (x: number, y: number, z: number) => { for (let d = 0; d < 8; d++) { const a = d / 8 * Math.PI * 2; world.raycast(x, y + 0.9, z, dmath.cos(a), 0, dmath.sin(a), 5, PH, true); if (PH.hit && PH.box >= 0) return true; } return false; };
  const tryAt = (x: number, z: number, line: string, deckOnly: boolean): boolean => {
    const t = walkTop(world, x, z); if (!t || t.y < PATH_DRY || (deckOnly && !t.deck)) return false;
    if (!t.deck && world.terrain.normal(x, z)[1] < 0.85) return false;
    if (!t.deck) { const sw = swampWaterAt(x, z); if (sw !== null && t.y < sw + 0.1) return false; }
    const v = validateSpot(world, SpotKind.Floor, x, t.y + 0.05, z);
    if (v.why) return false;
    out.push({ x: v.x, y: v.y, z: v.z, sx: STAND[0], sy: STAND[1], sz: STAND[2], kind: t.deck ? 1 : 0, line });
    return true;
  };
  for (const L of pathLines()) {
    const P = L.pts; let acc = PATH_STEP * 0.5;
    for (let i = 1; i < P.length; i++) {
      const ax = P[i - 1][0], az = P[i - 1][1], bx = P[i][0], bz = P[i][1], seg = dmath.hypot(bx - ax, bz - az);
      if (seg < 1e-3) continue;
      if (inPoi(bx, bz)) { acc = Math.min(acc, PATH_STEP * 0.5); continue; }
      const ux = (bx - ax) / seg, uz = (bz - az) / seg;
      // a bridge: the route leaves dry ground for a deck over water — one spot on the deck itself
      const wet = world.ground(bx, bz) < PATH_DRY;
      if (wet && far(bx, bz) && tryAt(bx, bz, L.id, true)) { acc = 0; continue; }
      acc += seg;
      if (acc < PATH_STEP || !far(bx, bz)) continue;
      // the shoulder: 0.9 × the half width + 1.4 m out from the centre line, either side (seeded), the sheltered side first
      const h = hash32(Math.round(bx * 4), Math.round(bz * 4));
      const sides = (h & 1) ? [1, -1] : [-1, 1], off = [L.w * 0.9 + 1.4, L.w * 0.9 + 2.4, L.w * 0.9 + 0.6];
      let best: [number, number] | null = null, done = false;
      for (const o of off) { for (const sd of sides) {
        const x = bx - uz * o * sd, z = bz + ux * o * sd, t = walkTop(world, x, z);
        if (!t || t.deck || t.y < PATH_DRY) continue;
        if (sheltered(x, t.y, z)) { if (tryAt(x, z, L.id, false)) { done = true; break; } }
        else if (!best) best = [x, z];
      } if (done) break; }
      if (!done && best) done = tryAt(best[0], best[1], L.id, false);
      if (done) acc = 0;
    }
  }
  // the zipline decks: a spot beside each pole, off the cable's line
  for (const Z of ZIP_LINES) {
    for (const [px, py, pz, s] of [[Z.ax, Z.ya, Z.az, 1], [Z.bx, Z.yb, Z.bz, -1]] as const) {
      const ux = Z.dx / Z.Lh * s, uz = Z.dz / Z.Lh * s;
      let ok = false;
      for (const [f, l] of [[-1.2, 1.4], [-1.2, -1.4], [0, 1.6], [0, -1.6], [-1.8, 0]]) {
        const x = px + ux * f - uz * l, z = pz + uz * f + ux * l;
        if (!far(x, z)) { ok = true; break; }
        const v = validateSpot(world, SpotKind.Floor, x, py + 0.05, z);
        if (v.why || v.y < PATH_DRY) continue;
        out.push({ x: v.x, y: v.y, z: v.z, sx: STAND[0], sy: STAND[1], sz: STAND[2], kind: 2, line: Z.id }); ok = true; break;
      }
      void ok;
    }
  }
  PATH_C.set(world, out);
  return out;
}
