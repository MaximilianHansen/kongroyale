// poi-town shared kit (pure TS, no three.js): building / deck / pier layout descriptions and the ONE resolver that
// both the client visuals (client/src/world/pois/_kit/town-*.ts) and the server colliders derive from.
// Local building frame: centre at the origin, +x = local right, +z = local FRONT (street). World = R_y(yaw) · local,
// three.js convention: x' = x·cos + z·sin, z' = -x·sin + z·cos.
// Ramps (stairs, sloped roofs) are thin boxes with `pitch`: box frame = R_y(yaw) · R_x(pitch); the box's local +Z runs
// along the slope and a NEGATIVE pitch lifts the +Z end (three.js Euler about X). Step-boxes are also emitted for
// stairs (kind "step") so a sim without pitch support can use those instead — see `buildingColliders`.
import type { Box, Surface } from "../world/colliders";
import { furnishRoom, itemColliders, itemSurface, type InteriorItem, type InteriorLayout, type InteriorRoom, type InteriorStyle, type LootSlots, type RoomOpening, type RoomRole } from "./interior-kit";
import * as dmath from "../sim/dmath";

export type Vec2 = [number, number];
/** 0 = front (+z local), 1 = right (+x), 2 = back (-z), 3 = left (-x) */
export type Side = 0 | 1 | 2 | 3;
export type OpeningKind = "door" | "window" | "shop" | "arch" | "french" | "porthole" | "balcony-arch";

export interface Opening { u: number; w: number; y: number; h: number; kind: OpeningKind; shutters?: boolean }

export interface TownBuilding {
  id?: string;
  /** what it is ("house", "shop", "townhouse", "market-hall", "warehouse", "villa", "tower", "bungalow", ...) */
  use?: string;
  x: number; z: number; y: number; yaw: number;
  w: number; d: number; floors: number;
  /** storey height (default 3.2) */
  floorH?: number;
  wall: string; trim: string; shutter?: string; door?: string;
  roof: "flat" | "gable" | "shed"; roofColor: string;
  /** gable ridge runs along local x (default) or z */
  roofAxis?: "x" | "z";
  /** metres the pitched roof overhangs the walls */
  overhang?: number;
  /** gable ends (−1 / +1 along the ridge) that abut a taller neighbour: their collider is the full gable
   *  rectangle (eave → ridge), so no wall-top ledge is left in the slot between the two walls */
  gableFill?: Array<-1 | 1>;
  /** a plastered chimney through a pitched roof at this local (x, z) — roof dressing that is cover up there */
  chimney?: [number, number];
  front?: Side;
  balcony?: boolean | { u0: number; u1: number };
  awning?: "tin" | "stripe" | null;
  awningColor?: string;
  /** stripe atlas row 0..5 (see town-tex STRIPES) */
  stripe?: number;
  tank?: "blue" | "teal" | "olive" | "steel" | "tower" | null;
  ac?: boolean;
  /** painted board text (only "BANANA CO." / "CNVS.DEV" / fruit words allowed) */
  sign?: string | null;
  shop?: boolean;
  roofAccess?: boolean;
  /** furnish the interior (default true) */
  interior?: boolean;
  seed?: number;
  /** side windows only every N metres (default 3.6) */
  windowPitch?: number;
  /** door side override (default = front) */
  doorSide?: Side;
  /** collider surface */
  surf?: Surface;
  /** wall thickness (default 0.3) */
  t?: number;
  /** skip windows entirely on these sides (party walls) */
  blind?: Side[];
  /** a small gable dormer window on the front roof slope (stilt huts; visual only) */
  dormer?: boolean;
  /** "plaster" (default) | "clapboard" | "stone" — chooses the client material bin */
  material?: "plaster" | "clapboard" | "stone";
  /** plinth band colour (default darker wall) */
  plinth?: string;
  /** tin awning carried on timber posts down to the street (default: wall brackets only) */
  awningPosts?: boolean;
  /** awning depth out from the wall (default tin 1.5, stripe 1.25) */
  awningDepth?: number;
  /** pitched roofs: rise per metre of half-span (default gable 0.42, shed 0.28) */
  roofPitch?: number;
  /** window shutter state (default "mixed") */
  shutters?: "closed" | "open" | "mixed";
  /** probability of a flower box under each upper-floor window (default 0.35) */
  flowers?: number;
  /** flat-roof parapet height (default 0.6) */
  parapetH?: number;
  /** flat roofs: a corrugated-tin pent skirt (this colour) sloping out from the parapet on the front + sides */
  pent?: string;
  /** false = no corner quoins (a neighbour stands within ~2 m of a corner: the 0.15 m proud columns would pinch
   *  the alley into a capsule trap) */
  quoins?: boolean;
  /** rooftop props (visual + collider), local roof coords. Default: derived from `tank` / `ac` */
  roofProps?: RoofProp[];
}
/** rooftop dressing with collision. Local roof coords (building frame), y = roof top */
export interface RoofProp { kind: "plastic" | "steel" | "stand" | "tower" | "ac" | "planter" | "crates"; x: number; z: number; yaw?: number; color?: string; s?: number }
/** collision half-extents (x, y, z) of a roof prop at scale 1 — visuals must fit inside */
export const ROOF_PROP_HALF: Record<RoofProp["kind"], [number, number, number]> = {
  plastic: [0.72, 0.9, 0.72], steel: [0.72, 0.8, 0.72], stand: [1.25, 1.75, 1.25], tower: [1.2, 2.9, 1.2], ac: [0.48, 0.38, 0.28], planter: [0.45, 0.3, 0.45], crates: [0.45, 0.35, 0.35],
};

export interface WallPiece { u: number; y: number; w: number; h: number }
export interface ResolvedWall {
  side: Side; A: Vec2; B: Vec2; len: number; dir: Vec2; n: Vec2;
  /** openings per floor (index = floor) */
  openings: Opening[][];
  /** solid pieces per floor in wall space */
  pieces: WallPiece[][];
}
export interface Slab { x0: number; z0: number; x1: number; z1: number; y: number; t: number; floor: number }
export interface Stair { x: number; z: number; dir: Vec2; width: number; rise: number; run: number; steps: number; y: number; floor: number }
export interface RoofParts {
  kind: "flat" | "gable" | "shed";
  /** top of wall */
  y: number;
  /** flat: parapet height */
  parapet: number;
  /** gable/shed: ridge height above wall top, half-span, axis */
  rise: number; axis: "x" | "z"; overhang: number;
  /** flat roofs: resolved rooftop props (local coords) */
  props: RoofProp[];
}
export interface BalconyParts { side: Side; u0: number; u1: number; y: number; depth: number }
export interface AwningParts { side: Side; u0: number; u1: number; y: number; depth: number; kind: "tin" | "stripe" }

/** the roof-access bulkhead (a small stair house over the roof hole). Local rects; `pieces` are the solid wall
 *  boxes [x0, z0, x1, z1, y0, y1] (door gap already cut, lintel included) — colliders and visuals both use them. */
export interface Bulkhead { x0: number; z0: number; x1: number; z1: number; y: number; h: number; pieces: Array<[number, number, number, number, number, number]>; door: { side: "x" | "z"; at: number; a0: number; a1: number; /** the door's outward normal sign along its axis */ out: 1 | -1 } }

export interface BuildingParts {
  b: TownBuilding; floorH: number; H: number; t: number; front: Side;
  walls: ResolvedWall[]; slabs: Slab[]; stairs: Stair[]; roof: RoofParts;
  balcony: BalconyParts | null; awning: AwningParts | null;
  /** stair hole rects in local space per floor slab (floor >= 1) and the roof */
  holes: Array<{ floor: number; x0: number; z0: number; x1: number; z1: number }>;
  /** balustrades along the open edges of the stair wells (local segment at floor y, 1.0 m tall) */
  rails: Array<{ x0: number; z0: number; x1: number; z1: number; y: number }>;
  /** the stair shaft walls (spine + room-side wall), local boxes [x0, z0, x1, z1, y0, y1] — drawn and collided */
  hallWalls: Array<[number, number, number, number, number, number]>;
  /** the stair hall (null = no stair) */
  hall: StairHall | null;
  /** roof stair house (flat roofs with roof access) */
  bulk: Bulkhead | null;
  rng: () => number;
}

/** the stair hall's rect on floor f (local [x0, z0, x1, z1]: flights, wells, both landings) when a flight
 *  starts or arrives on that floor; null = no stair there */
export function stairZone(p: BuildingParts, f: number): [number, number, number, number] | null {
  if (!p.hall || !(p.stairs.some((s) => s.floor === f) || p.holes.some((h) => h.floor === f))) return null;
  const r = p.hall.rect;
  return [r[0] - 0.1, r[1] - 0.1, r[2] + 0.1, r[3] + 0.15];
}

// ---------- utilities
export function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export const hashXZ = (x: number, z: number) => ((Math.round(x * 7) * 73856093) ^ (Math.round(z * 7) * 19349663)) >>> 0;

/** local → world */
export function toWorld(b: { x: number; z: number; yaw: number }, lx: number, lz: number): Vec2 {
  const c = dmath.cos(b.yaw), s = dmath.sin(b.yaw);
  return [b.x + lx * c + lz * s, b.z - lx * s + lz * c];
}
/** world yaw of a local direction */
export function dirYaw(b: { yaw: number }, d: Vec2): number {
  const c = dmath.cos(b.yaw), s = dmath.sin(b.yaw);
  const wx = d[0] * c + d[1] * s, wz = -d[0] * s + d[1] * c;
  return dmath.atan2(-wz, wx);
}

const SIDES: Array<{ A: (w: number, d: number) => Vec2; B: (w: number, d: number) => Vec2; dir: Vec2; n: Vec2 }> = [
  { A: (w, d) => [-w / 2, d / 2], B: (w, d) => [w / 2, d / 2], dir: [1, 0], n: [0, 1] },     // front  (+z)
  { A: (w, d) => [w / 2, d / 2], B: (w, d) => [w / 2, -d / 2], dir: [0, -1], n: [1, 0] },    // right  (+x)
  { A: (w, d) => [w / 2, -d / 2], B: (w, d) => [-w / 2, -d / 2], dir: [-1, 0], n: [0, -1] }, // back   (-z)
  { A: (w, d) => [-w / 2, -d / 2], B: (w, d) => [-w / 2, d / 2], dir: [0, 1], n: [-1, 0] },  // left   (-x)
];

/** subtract openings from a len×h wall → solid rectangles (u,y,w,h). Openings must not overlap horizontally. */
export function wallPieces(len: number, h: number, openings: Opening[]): WallPiece[] {
  const out: WallPiece[] = [];
  const ops = [...openings].sort((a, b) => a.u - b.u);
  let u = 0;
  for (const o of ops) {
    const ou = Math.max(u, o.u), ow = Math.min(len, o.u + o.w) - ou;
    if (ow <= 0) continue;
    if (ou > u + 1e-3) out.push({ u, y: 0, w: ou - u, h });
    if (o.y > 0.02) out.push({ u: ou, y: 0, w: ow, h: o.y });
    if (o.y + o.h < h - 0.02) out.push({ u: ou, y: o.y + o.h, w: ow, h: h - o.y - o.h });
    u = ou + ow;
  }
  if (u < len - 1e-3) out.push({ u, y: 0, w: len - u, h });
  return out;
}

/** evenly spread `n` openings of width w along [u0,u1] */
function spread(u0: number, u1: number, n: number, w: number): number[] {
  const span = u1 - u0;
  if (n <= 0 || span < w) return [];
  const gap = (span - n * w) / (n + 1);
  const r: number[] = [];
  for (let i = 0; i < n; i++) r.push(u0 + gap + i * (w + gap));
  return r;
}

const TANK_COLORS: Record<string, string> = { blue: "#2f4f8f", teal: "#2c8a80", olive: "#5e7a3a", steel: "#b9bec4", tower: "#2f5fa0" };
// ---------- the STAIR HALL — a real stair core in every multi-storey building.
// A canonical hall runs along one wall (x' along the wall from its left end, z' = into the building from it): two 1.4 m
// lanes (lane 0 against the wall, lane 1 in front of it) split by a SPINE wall, flight f in lane f % 2 (lane 0 climbs
// +x', lane 1 climbs back −x' — a switchback), a 1.0–1.25 m LANDING at both ends of every flight (spanning both lanes).
// On the slab above each flight a stair-well opening over its whole lane (≥ 2.3 m headroom over every tread: the next
// solid over a flight is the slab two storeys up). Every storey a flight starts on is a SHAFT: the spine + an outer wall
// on the room side (not on the ground floor, where lane 1 is open floor) — nobody falls into a well, nobody drifts off a
// flight, the room's ceiling never spans a well. A storey without a flight gets balustrades round the well instead; the
// well's start end always gets one. The hall avoids doors / shop fronts / french doors and strips the windows it would
// cross; resolveBuilding picks the wall (opposite the door first) and the end (mirror) that fit.
/** stair hall frame: canonical (x', z') → building local; linear (directions transform with the same map) */
export interface StairHall { side: Side; mirror: 1 | -1; W: number; D: number; rect: [number, number, number, number]; xs: number; xe: number; land: number; lanes: [number, number]; sw: number }
// The 0.42 m capsule can overlap two 0.25 m treads behind it. A 1 m
// side guard is then only ~0.5 m above its feet and auto-steps under STEP_H
// 0.55. Keep a 0.1 m margin beyond that overlap, with the same drawn height.
export const STAIR_GUARD_H = 1.15;
export const STAIR_SW = 1.4, STAIR_GAP = 0.14, STAIR_OUTER = 0, STAIR_LAND = 2.5, STAIR_TREAD = 0.35;
/** the shortest landing a flight may get (a kong capsule (r 0.42) must stand 1.0 m beyond each end, clear of the wall) */
export const STAIR_LAND_MIN = 2.2;
export function hallMap(side: Side, m: 1 | -1): (x: number, z: number) => Vec2 {
  return (x, z) => { const xm = x * m; return side === 2 ? [xm, z] : side === 0 ? [-xm, -z] : side === 1 ? [-z, xm] : [z, -xm]; };
}
function mapRect(P: (x: number, z: number) => Vec2, x0: number, z0: number, x1: number, z1: number): [number, number, number, number] {
  const a = P(x0, z0), c = P(x1, z1);
  return [Math.min(a[0], c[0]), Math.min(a[1], c[1]), Math.max(a[0], c[0]), Math.max(a[1], c[1])];
}
/** steps / tread / landing for a hall wall of length W' (null = too short for a stair) */
export function hallFit(Wp: number, t: number, floorH: number): { steps: number; tread: number; run: number; land: number } | null {
  const steps = Math.max(8, Math.ceil(floorH / 0.25 - 1e-6));
  const landGoal = Math.max(STAIR_LAND_MIN, Math.min(2.35, (Wp - 2 * t - steps * 0.25) / 2));
  const avail = Wp - 2 * t - 2 * landGoal;
  const tread = Math.min(STAIR_TREAD, avail / steps);
  if (tread < 0.25) return null;
  const run = steps * tread, land = Math.min(STAIR_LAND, (Wp - 2 * t - run) / 2);
  return { steps, tread, run, land };
}
/** the smallest wall length / depth that holds a stair hall for this storey height */
// Keep generated exterior footprints stable. The revised, shorter flights fit
// these established building widths; hallFit owns the internal landing layout.
export function hallMinW(floorH: number, t = 0.3): number { const steps = Math.max(8, Math.ceil(floorH / 0.2 - 1e-6)); return 2 * t + 2 * 1.85 + steps * 0.25 + 0.01; }
export const HALL_DEPTH = 2 * STAIR_SW + STAIR_GAP + STAIR_OUTER;
export const HALL_MIN_D = HALL_DEPTH + 0.6 + 1.6;
// Doorways include room for the capsule to turn at a jamb, not just pass centre-on.
export const TOWN_DOOR_W = 1.7;

export function resolveBuilding(b: TownBuilding): BuildingParts {
  const rng = mulberry(b.seed ?? hashXZ(b.x, b.z));
  const floorH = b.floorH ?? 3.2, t = b.t ?? 0.3, front = b.front ?? 0;
  const H = floorH * b.floors;
  const doorSide = b.doorSide ?? front;
  const wp = b.windowPitch ?? 3.6;
  const blind = new Set(b.blind ?? []);
  const balcony = b.balcony && b.floors > 1 ? (b.balcony === true ? { u0: 0.5, u1: b.w - 0.5 } : b.balcony) : null;

  // ---- openings first (so the stair hall never shifts their rng sequence)
  const ops: Opening[][][] = [];
  for (let s = 0 as Side; s < 4; s = (s + 1) as Side) {
    const len = s % 2 === 0 ? b.w : b.d;
    const perFloor: Opening[][] = [];
    for (let f = 0; f < b.floors; f++) {
      const o: Opening[] = [];
      const isFront = s === front, isDoor = s === doorSide && f === 0;
      if (!blind.has(s)) {
        if (f === 0 && isFront && b.shop) {
          const sw = Math.min(3.4, len - 2.6);
          const du = 0.6, su = du + TOWN_DOOR_W + 0.5;
          o.push({ u: du, w: TOWN_DOOR_W, y: 0, h: 2.6, kind: "door" });
          if (su + sw < len - 0.5) o.push({ u: su, w: sw, y: 0.05, h: 2.7, kind: "shop" });
          for (const u of spread(su + sw + 0.3, len - 0.4, Math.floor((len - su - sw - 0.7) / 2.2), 1.1)) o.push({ u, w: 1.1, y: 1.0, h: 1.4, kind: "window", shutters: true });
        } else if (isDoor) {
          const du = len / 2 - TOWN_DOOR_W / 2 + (rng() - 0.5) * Math.max(0, len - 4) * 0.5;
          o.push({ u: du, w: TOWN_DOOR_W, y: 0, h: 2.6, kind: "door" });
          const left = Math.floor((du - 0.5) / 2.3), right = Math.floor((len - du - TOWN_DOOR_W - 0.5) / 2.3);
          for (const u of spread(0.4, du - 0.3, Math.min(left, 3), 1.2)) o.push({ u, w: 1.2, y: 1.0, h: 1.4, kind: "window", shutters: true });
          for (const u of spread(du + TOWN_DOOR_W + 0.3, len - 0.4, Math.min(right, 3), 1.2)) o.push({ u, w: 1.2, y: 1.0, h: 1.4, kind: "window", shutters: true });
        } else if (isFront && f >= 1 && balcony && f === 1) {
          const n = Math.max(1, Math.min(3, Math.floor((balcony.u1 - balcony.u0) / 3.2)));
          for (const u of spread(balcony.u0 + 0.2, balcony.u1 - 0.2, n, 1.4)) o.push({ u, w: 1.4, y: 0, h: 2.3, kind: "french" });
        } else if (isFront && f >= 1) {
          const n = Math.max(1, Math.min(4, Math.floor(len / 2.8)));
          for (const u of spread(0.4, len - 0.4, n, 1.2)) o.push({ u, w: 1.2, y: 0.95, h: 1.5, kind: "window", shutters: rng() < 0.8 });
        } else {
          const n = Math.max(0, Math.min(4, Math.floor((len - 1) / wp)));
          const keep = rng() < 0.85;
          if (keep) for (const u of spread(0.6, len - 0.6, n, 1.1)) o.push({ u, w: 1.1, y: 1.0, h: 1.3, kind: "window", shutters: rng() < 0.6 });
        }
      }
      perFloor.push(o);
    }
    ops.push(perFloor);
  }
  /** local segment of an opening, 0.1 m inside the wall's inner face */
  const opSeg = (s: Side, op: Opening): [Vec2, Vec2] => { const S = SIDES[s], A = S.A(b.w, b.d), n = S.n, k = t + 0.1; return [[A[0] + S.dir[0] * op.u - n[0] * k, A[1] + S.dir[1] * op.u - n[1] * k], [A[0] + S.dir[0] * (op.u + op.w) - n[0] * k, A[1] + S.dir[1] * (op.u + op.w) - n[1] * k]]; };
  const segHits = (sg: [Vec2, Vec2], r: [number, number, number, number], m: number) => { for (let k = 0; k <= 6; k++) { const x = sg[0][0] + (sg[1][0] - sg[0][0]) * k / 6, z = sg[0][1] + (sg[1][1] - sg[0][1]) * k / 6; if (x > r[0] - m && x < r[2] + m && z > r[1] - m && z < r[3] + m) return true; } return false; };

  // ---- the stair hall
  const roofStair = !!(b.roofAccess && b.roof === "flat");
  const nStairs = b.floors - 1 + (roofStair ? 1 : 0);
  const stairs: Stair[] = [], holes: BuildingParts["holes"] = [], rails: BuildingParts["rails"] = [], hallWalls: BuildingParts["hallWalls"] = [];
  let hall: StairHall | null = null;
  let bulk: Bulkhead | null = null;
  if (nStairs > 0) {
    const opp = ((doorSide + 2) % 4) as Side;
    const order: Side[] = [opp, ...([0, 1, 2, 3] as Side[]).filter((s) => s !== opp && s !== doorSide && s !== front), ...([front, doorSide] as Side[]).filter((s, i, a) => s !== opp && a.indexOf(s) === i)];
    let best: { side: Side; m: 1 | -1; fit: NonNullable<ReturnType<typeof hallFit>>; Wp: number; Dp: number; bad: number } | null = null;
    for (const side of order) for (const m of [1, -1] as const) {
      const Wp = side % 2 === 0 ? b.w : b.d, Dp = side % 2 === 0 ? b.d : b.w;
      const fit = hallFit(Wp, t, floorH);
      if (!fit || Dp < HALL_MIN_D) continue;
      const P = hallMap(side, m), zb = -Dp / 2 + t;
      const zone = mapRect(P, -Wp / 2, -Dp / 2, -Wp / 2 + t + 2 * fit.land + fit.run, zb + HALL_DEPTH);
      let bad = 0;
      for (let s = 0 as Side; s < 4; s = (s + 1) as Side) for (let f = 0; f < b.floors; f++) for (const op of ops[s][f]) if (op.kind !== "window" && segHits(opSeg(s, op), zone, 0.35)) bad++;
      if (!best || bad < best.bad) best = { side, m, fit, Wp, Dp, bad };
      if (bad === 0) break;
    }
    if (best && best.bad > 0) {
      // Keep the best hall, but move its conflicting doorways along their wall.
      // Deleting a ground door here could seal a narrow shop completely.
      const P = hallMap(best.side, best.m), zb = -best.Dp / 2 + t;
      const zone = mapRect(P, -best.Wp / 2, -best.Dp / 2, -best.Wp / 2 + t + 2 * best.fit.land + best.fit.run, zb + HALL_DEPTH);
      for (let s = 0 as Side; s < 4; s = (s + 1) as Side) for (let f = 0; f < b.floors; f++) {
        const len = s % 2 === 0 ? b.w : b.d;
        const moved: Opening[] = [];
        for (const op of ops[s][f]) {
          if (op.kind === "window" || !segHits(opSeg(s, op), zone, 0.35)) { moved.push(op); continue; }
          let replacement: Opening | null = null;
          if (op.kind === "door" || op.kind === "french") {
            for (let u = t + 0.05; u + op.w <= len - t - 0.05 + 1e-6; u += 0.05) {
              const candidate = { ...op, u };
              if (segHits(opSeg(s, candidate), zone, 0.35)) continue;
              if (moved.some((o) => o.kind !== "window" && candidate.u < o.u + o.w + 0.1 && candidate.u + candidate.w > o.u - 0.1)) continue;
              replacement = candidate; break;
            }
          }
          if (replacement) moved.push(replacement);
          else if (f === 0 && op.kind === "door") moved.push(op);
        }
        // Windows give way to the relocated passage; never create overlapping wall openings.
        ops[s][f] = moved.filter((op) => op.kind !== "window" || !moved.some((o) => o.kind !== "window" && op.u < o.u + o.w + 0.1 && op.u + op.w > o.u - 0.1));
      }
    }
    if (best) {
      const { side, m, fit, Wp, Dp } = best, P = hallMap(side, m);
      const xw0 = -Wp / 2 + t, xs = xw0 + fit.land, xe = xs + fit.run, zb = -Dp / 2 + t;
      const lz = [zb + STAIR_SW / 2, zb + STAIR_SW + STAIR_GAP + STAIR_SW / 2] as [number, number];
      const zh1 = zb + 2 * STAIR_SW + STAIR_GAP, zo1 = zh1 + STAIR_OUTER, xh1 = xe + fit.land;
      hall = { side, mirror: m, W: Wp, D: Dp, rect: mapRect(P, -Wp / 2 + t, zb, xh1, zo1), xs, xe, land: fit.land, lanes: lz, sw: STAIR_SW };
      const mapDir = (dx: number): Vec2 => P(dx, 0);
      const wall = (a0: number, c0: number, a1: number, c1: number, y0: number, y1: number) => { const r = mapRect(P, a0, c0, a1, c1); hallWalls.push([r[0], r[1], r[2], r[3], y0, y1]); };
      const rail = (ax: number, az: number, bx: number, bz: number, y: number) => { const [p0, p1] = [P(ax, az), P(bx, bz)]; rails.push({ x0: p0[0], z0: p0[1], x1: p1[0], z1: p1[1], y }); };
      // the SPINE between the lanes on every storey a flight starts on. (the room side stays OPEN — a 1.4 m lane
      //  walled on both sides is a corridor the loot generator's 1.25 m scan cannot thread: every storey above the
      //  first comes out "sealed", no loot. A kong who steps off a flight's open side lands on the same storey's floor.)
      for (let g = 0; g < nStairs; g++) {
        const y0 = b.y + g * floorH + (g === 0 ? 0.05 : 0), y1 = b.y + (g + 1) * floorH - 0.1; // (into the slab above)
        // (the spine stops 1.4 m short at the U-turn end of storey g — where flight g starts and flight g−1 arrives — so the
        //  turn round its end is never a corner to clip; at that end the other lane is the shallow top of a well)
        // (running the spine on 0.6 m into the landing makes walkers clip its end, so it stops short)
        if (g % 2 === 0) wall(xs + 1.4, zb + STAIR_SW, xe, zb + STAIR_SW + STAIR_GAP, y0, y1); else wall(xs, zb + STAIR_SW, xe - 1.4, zb + STAIR_SW + STAIR_GAP, y0, y1);
      }
      for (let f = 0; f < nStairs; f++) {
        const lane = f % 2, z = lz[lane], x0 = lane === 0 ? xs : xe;
        const [sx, sz] = P(x0, z);
        stairs.push({ x: sx, z: sz, dir: mapDir(lane === 0 ? 1 : -1), width: STAIR_SW, rise: floorH, run: fit.run, steps: fit.steps, y: b.y + f * floorH, floor: f });
        // Both flight edges are guarded. The continuous drawn handrail sits
        // over these shared guards, outside the 1.4 m usable tread lane.
        const tread = fit.run / fit.steps;
        for (let i = 0; i < fit.steps; i++) {
          const a = x0 + (lane === 0 ? 1 : -1) * i * tread, e = x0 + (lane === 0 ? 1 : -1) * (i + 1) * tread;
          for (const edge of [-1, 1]) rail(a, z + edge * (STAIR_SW / 2 + 0.06), e, z + edge * (STAIR_SW / 2 + 0.06), b.y + f * floorH + (i + 1) * floorH / fit.steps);
        }
        // Open both switchback lanes. A kong can approach the open side diagonally;
        // a lane-only well leaves the adjacent floor slab above its shoulders.
        const clearance = 0.45;
        // the ROOF well (inside the
        // stair house) opens the last flight's lane only, up to the spine: both lanes leave a 2-storey drop beside the stair
        // (under the other lane the flight below arrives with 2.66 m of head room either way)
        const roofWell = roofStair && f === nStairs - 1, mid = zb + STAIR_SW + STAIR_GAP / 2;
        const hz0 = roofWell && lane === 1 ? mid : zb - 0.02, hz1 = roofWell && lane === 0 ? mid : zh1 + 0.02;
        // Step-up lifts the capsule while its centre is still before the first
        // tread. Extend the foot only: at the arrival the slab is under the feet,
        // so retaining it preserves the full landing for the switchback turn.
        const [hx0, hzz0, hx1, hzz1] = mapRect(P, xs - (lane === 0 ? clearance : 0.02), hz0, xe + (lane === 1 ? clearance : 0.02), hz1);
        holes.push({ floor: f + 1, x0: hx0, z0: hzz0, x1: hx1, z1: hzz1 });
        const g = f + 1, yF = b.y + g * floorH;
        if (g >= b.floors) continue;                       // the roof: the stair house encloses the well
        // (the spine walls the well's lane-side edge when a flight starts on this storey; the room-side edge of a lane-1
        //  well always gets a balustrade)
        const walled = g < nStairs;
        // the start end of the well (never the arrival end): lane 0 starts at xs, lane 1 at xe
        const foot = lane === 0 ? xs - clearance : xe + clearance;
        rail(foot, zb + 0.05, foot, hz1 + 0.03, yF);
        // the long open edge when this storey has no shaft
        // (it stops 1.6 m short of the arrival end: up there the treads are within a metre of the floor, and a kong
        //  stepping off the top turns straight out — a rail to the very end makes a corner every walker clips)
        if (!walled) rail(xs - (lane === 0 ? clearance : 0.02), hz1 + 0.03, xe + (lane === 1 ? clearance : 0.02), hz1 + 0.03, yF);
      }
      // roof stair house over the last flight's well: encloses both lanes + both landings, a door in its room-side wall at
      // the arrival landing (lane 0 arrives at xe, lane 1 at xs)
      if (roofStair) {
        const y = b.y + b.floors * floorH, h = 2.6, wt = 0.2, dh = 2.4, last = (nStairs - 1) % 2;
        const X0 = -Wp / 2, Z0 = -Dp / 2, X1 = Math.min(Wp / 2, xh1 + wt), Z1 = zo1 + wt;
        const pieces: Bulkhead["pieces"] = [];
        const piece = (a0: number, c0: number, a1: number, c1: number, y0: number, y1: number) => { const r = mapRect(P, a0, c0, a1, c1); pieces.push([r[0], r[1], r[2], r[3], y0, y1]); };
        piece(X0, Z0, X0 + t, Z1, y, y + h); piece(X0, Z0, X1, Z0 + t, y, y + h); piece(X1 - wt, Z0, X1, Z1, y, y + h);
        // the spine runs on up inside the stair house (the arrival lane's side)
        piece(xs, zb + STAIR_SW, xe, zb + STAIR_SW + STAIR_GAP, y, y + h);
        const la0 = last === 0 ? xe : xw0, la1 = last === 0 ? Math.min(X1 - wt, xe + fit.land) : xs;
        const dw = Math.min(1.4, la1 - la0 - 0.06), dm = (la0 + la1) / 2, d0 = dm - dw / 2, d1 = dm + dw / 2;
        piece(X0 + t, Z1 - wt, d0, Z1, y, y + h); piece(d1, Z1 - wt, X1 - wt, Z1, y, y + h); piece(d0, Z1 - wt, d1, Z1, y + dh, y + h);
        const r = mapRect(P, X0, Z0, X1, Z1), nrm = P(0, 1), alongX = Math.abs(nrm[1]) > 0.5;
        const wa = P(d0, Z1 - wt / 2), wb = P(d1, Z1 - wt / 2);
        bulk = { x0: r[0], z0: r[1], x1: r[2], z1: r[3], y, h, pieces,
          door: alongX ? { side: "z", at: wa[1], a0: Math.min(wa[0], wb[0]), a1: Math.max(wa[0], wb[0]), out: nrm[1] > 0 ? 1 : -1 } : { side: "x", at: wa[0], a0: Math.min(wa[1], wb[1]), a1: Math.max(wa[1], wb[1]), out: nrm[0] > 0 ? 1 : -1 } };
      }
      // windows the hall would cross (it stands against them on every floor) go
      for (let s = 0 as Side; s < 4; s = (s + 1) as Side) for (let f = 0; f < b.floors; f++) ops[s][f] = ops[s][f].filter((op) => op.kind !== "window" || !segHits(opSeg(s, op), hall!.rect, 0.25));
    }
  }

  const walls: ResolvedWall[] = [];
  for (let s = 0 as Side; s < 4; s = (s + 1) as Side) {
    const S = SIDES[s], len = s % 2 === 0 ? b.w : b.d;
    walls.push({ side: s, A: S.A(b.w, b.d), B: S.B(b.w, b.d), len, dir: S.dir, n: S.n, openings: ops[s], pieces: ops[s].map((o) => wallPieces(len, floorH, o)) });
  }

  const slabs: Slab[] = [];
  for (let f = 0; f <= b.floors; f++) {
    if (f === b.floors && b.roof !== "flat") break;
    slabs.push({ x0: -b.w / 2, z0: -b.d / 2, x1: b.w / 2, z1: b.d / 2, y: b.y + f * floorH, t: f === 0 ? 0.3 : 0.28, floor: f });
  }
  if (b.roof !== "flat") slabs.push({ x0: -b.w / 2, z0: -b.d / 2, x1: b.w / 2, z1: b.d / 2, y: b.y + H, t: 0.22, floor: b.floors });

  const props: RoofProp[] = [];
  if (b.roof === "flat") {
    if (b.roofProps) props.push(...b.roofProps);
    else {
      if (b.tank) props.push({ kind: b.tank === "tower" ? "tower" : b.tank === "steel" ? "steel" : "plastic", x: b.w / 2 - 1.45, z: -b.d / 2 + 1.45, yaw: rng() * 6.28, color: TANK_COLORS[b.tank] });
      if (b.ac) props.push({ kind: "ac", x: -b.w / 2 + 1.1, z: b.d / 2 - 0.75, yaw: 0 });
    }
  }
  // no rooftop prop over the stair house / in front of its door
  if (bulk) {
    const k = bulk;
    for (let i = props.length - 1; i >= 0; i--) {
      const pr = props[i], hh = ROOF_PROP_HALF[pr.kind], r = dmath.hypot(hh[0], hh[2]) * (pr.s ?? 1) + 0.45;
      const dm = (k.door.a0 + k.door.a1) / 2;
      if (pr.x + r > k.x0 && pr.x - r < k.x1 && pr.z + r > k.z0 && pr.z - r < k.z1) props.splice(i, 1);
      else if (k.door.side === "x" && Math.abs(pr.z - dm) < r + 0.6 && (k.door.out > 0 ? pr.x - r < k.door.at + 1.8 && pr.x > k.door.at - 0.5 : pr.x + r > k.door.at - 1.8 && pr.x < k.door.at + 0.5)) props.splice(i, 1);
      else if (k.door.side === "z" && Math.abs(pr.x - dm) < r + 0.6 && (k.door.out > 0 ? pr.z - r < k.door.at + 1.8 && pr.z > k.door.at - 0.5 : pr.z + r > k.door.at - 1.8 && pr.z < k.door.at + 0.5)) props.splice(i, 1);
    }
  }
  const roof: RoofParts = b.roof === "flat"
    ? { kind: "flat", y: b.y + H, parapet: b.parapetH ?? 0.6, rise: 0, axis: "x", overhang: 0, props }
    : { kind: b.roof, y: b.y + H, parapet: 0, rise: (b.roofPitch ?? (b.roof === "gable" ? 0.42 : 0.28)) * ((b.roofAxis ?? "x") === "x" ? b.d / 2 : b.w / 2) + 0.2, axis: b.roofAxis ?? "x", overhang: b.overhang ?? 0.6, props };

  const bal: BalconyParts | null = balcony ? { side: front, u0: balcony.u0, u1: balcony.u1, y: b.y + floorH, depth: 1.05 } : null;
  const awn: AwningParts | null = b.awning ? { side: front, u0: 0.25, u1: (front % 2 === 0 ? b.w : b.d) - 0.25, y: b.y + 2.95, depth: b.awningDepth ?? (b.awning === "tin" ? 1.5 : 1.25), kind: b.awning } : null;
  return { b, floorH, H, t, front, walls, slabs, stairs, roof, balcony: bal, awning: awn, holes, rails, hallWalls, hall, bulk, rng };
}

/** positions (wall u) of the timber posts under a tin awning with awningPosts */
export function awningPostUs(a: AwningParts): number[] {
  const len = a.u1 - a.u0, n = Math.max(1, Math.round(len / 3.2));
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(a.u0 + 0.12 + (len - 0.24) * i / n);
  return out;
}
/** rect minus holes → rects (slab pieces) */
export function slabPieces(x0: number, z0: number, x1: number, z1: number, holes: Array<{ x0: number; z0: number; x1: number; z1: number }>): Array<[number, number, number, number]> {
  let rects: Array<[number, number, number, number]> = [[x0, z0, x1, z1]];
  for (const h of holes) {
    const next: Array<[number, number, number, number]> = [];
    for (const r of rects) {
      const ix0 = Math.max(r[0], h.x0), iz0 = Math.max(r[1], h.z0), ix1 = Math.min(r[2], h.x1), iz1 = Math.min(r[3], h.z1);
      if (ix0 >= ix1 || iz0 >= iz1) { next.push(r); continue; }
      if (r[0] < ix0) next.push([r[0], r[1], ix0, r[3]]);
      if (ix1 < r[2]) next.push([ix1, r[1], r[2], r[3]]);
      if (r[1] < iz0) next.push([ix0, r[1], ix1, iz0]);
      if (iz1 < r[3]) next.push([ix0, iz1, ix1, r[3]]);
    }
    rects = next;
  }
  return rects;
}

/** oriented box for a local rect (x0,z0,x1,z1) at height range [y0,y1] */
export function localBox(b: { x: number; z: number; yaw: number }, x0: number, z0: number, x1: number, z1: number, y0: number, y1: number, surf: Surface = "concrete"): Box {
  const [cx, cz] = toWorld(b, (x0 + x1) / 2, (z0 + z1) / 2);
  return { c: [cx, (y0 + y1) / 2, cz], h: [(x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2], yaw: b.yaw, surf };
}

/** set true if the sim has no `pitch` support: stairs then also emit one thin box per step (≈12 boxes per stair) */
/** bulkhead wall colliders reach this far up into the drawn lid (client town-building draws the tin just above it) */
export const BULK_LID_IN = 0.08;
/** the roof stair house's open door leaf (0.9 m, swung 80° outward from its a1 jamb): local centre + direction —
 *  shared by the collider and the client */
export function bulkLeaf(k: Bulkhead): [number, number, Vec2] {
  // swung open ~170°: hinged on the a1 jamb 0.1 m outside the wall line, lying back along the wall beyond the jamb,
  // tilted 10° off it (never in the doorway, never a fin across the approach)
  const o = k.door.out, a = 10 * Math.PI / 180;
  const piv: Vec2 = k.door.side === "x" ? [k.door.at + 0.1 * o, k.door.a1] : [k.door.a1, k.door.at + 0.1 * o];
  const dir: Vec2 = k.door.side === "x" ? [dmath.sin(a) * o, dmath.cos(a)] : [dmath.cos(a), dmath.sin(a) * o];
  return [piv[0] + dir[0] * 0.47, piv[1] + dir[1] * 0.47, dir];
}
export function buildingColliders(p: BuildingParts): Box[] {
  const { b, t, floorH } = p;
  const surf: Surface = b.surf ?? (b.material === "clapboard" ? "wood" : "concrete");
  const out: Box[] = [];
  // walls
  for (const w of p.walls) {
    const yaw = dirYaw(b, w.dir);
    for (let f = 0; f < b.floors; f++) for (const pc of w.pieces[f]) {
      const lx = w.A[0] + w.dir[0] * (pc.u + pc.w / 2) - w.n[0] * t / 2, lz = w.A[1] + w.dir[1] * (pc.u + pc.w / 2) - w.n[1] * t / 2;
      const [cx, cz] = toWorld(b, lx, lz);
      out.push({ c: [cx, b.y + f * floorH + pc.y + pc.h / 2, cz], h: [pc.w / 2, pc.h / 2, t / 2], yaw, surf });
    }
  }
  out.push(...openingFill(p, surf));
  // slabs (with stair holes)
  for (const s of p.slabs) {
    const holes = p.holes.filter((h) => h.floor === s.floor);
    // (pieces overlap by 1 cm so a probe / foot exactly on a piece seam never falls between them)
    // (under a pitched roof the top slab is a CEILING, not an attic floor — no stair reaches it, so it is noWalk:
    //  bullets hit it like the drawn ceiling, nobody stands on it, and no attic counts as an unreachable floor)
    const attic = s.floor === b.floors && p.roof.kind !== "flat";
    for (const r of slabPieces(s.x0, s.z0, s.x1, s.z1, holes)) out.push({ ...localBox(b, r[0] - 0.01, r[1] - 0.01, r[2] + 0.01, r[3] + 0.01, s.y - s.t, s.y + (s.floor === 0 ? 0.05 : 0), surf), ...(attic ? { noWalk: true } : {}) });
  }
  // stairs: one solid box per step (floor → step top). NOTE: the sim treats a pitched box as a solid block spanning
  // its full rise (shared/sim/world.ts inflates hy), so ramps are NOT walkable — steps (≤ STEP_H) are.
  for (const st of p.stairs) {
    const c = dmath.cos(b.yaw), s = dmath.sin(b.yaw);
    const wdx = st.dir[0] * c + st.dir[1] * s, wdz = -st.dir[0] * s + st.dir[1] * c;
    const yaw = dmath.atan2(wdx, wdz);
    const tread = st.run / st.steps;
    for (let i = 0; i < st.steps; i++) {
      const u = (i + 0.5) * tread, top = (i + 1) * st.rise / st.steps;
      const [sx, sz] = toWorld(b, st.x + st.dir[0] * u, st.z + st.dir[1] * u);
      out.push({ c: [sx, st.y + top / 2, sz], h: [st.width / 2, top / 2, tread / 2 + 0.005], yaw, surf: "wood" });
    }
  }
  // roof stair house
  if (p.bulk) {
    const k = p.bulk;
    // (the pieces that reach the lid run 0.08 m up INTO the drawn 0.12 m metal lid — otherwise their tops are exposed
    //  walkable ledges 0.16–0.3 m under the drawn tin)
    for (const [x0, z0, x1, z1, y0, y1] of k.pieces) out.push(localBox(b, x0, z0, x1, z1, y0, y1 >= k.y + k.h - 1e-6 ? y1 + BULK_LID_IN : y1, surf));
    // (its open door leaf, 0.9 × 2.05 m, as drawn by client town-building)
    {
      const [lx, lz, dir] = bulkLeaf(k);
      const [wx, wz] = toWorld(b, lx, lz);
      out.push({ c: [wx, k.y + 1.04, wz], h: [0.45, 1.025, 0.04], yaw: dirYaw(b, dir), surf: "wood" });
    }
    // (cap noWalk: a 3 × 2 m tin lid 2.5 m above the roof is not a place to stand — glider-only 'roofs' for the scanner)
    out.push({ ...localBox(b, k.x0, k.z0, k.x1, k.z1, k.y + k.h, k.y + k.h + 0.12, "metal"), noWalk: true });
  }
  // stair-well balustrades: 1.0 m, bullets pass (a rail of balusters)
  for (const rl of p.rails) {
    const dx = rl.x1 - rl.x0, dz = rl.z1 - rl.z0, L = dmath.hypot(dx, dz); if (L < 0.2) continue;
    const [cx, cz] = toWorld(b, (rl.x0 + rl.x1) / 2, (rl.z0 + rl.z1) / 2);
    out.push({ c: [cx, rl.y + STAIR_GUARD_H / 2, cz], h: [L / 2, STAIR_GUARD_H / 2, 0.04], yaw: dirYaw(b, [dx / L, dz / L]), surf: "wood", noShoot: true });
  }
  for (const [x0, z0, x1, z1, y0, y1] of p.hallWalls) out.push(localBox(b, x0, z0, x1, z1, y0, y1, surf));
  // roof
  const r = p.roof;
  if (r.kind === "flat") {
    for (const w of p.walls) {
      const yaw = dirYaw(b, w.dir);
      const lx = (w.A[0] + w.B[0]) / 2 - w.n[0] * 0.13, lz = (w.A[1] + w.B[1]) / 2 - w.n[1] * 0.13;
      const [cx, cz] = toWorld(b, lx, lz);
      out.push({ c: [cx, r.y + r.parapet / 2, cz], h: [w.len / 2, r.parapet / 2, 0.13], yaw, surf });
    }
    for (const pr of r.props) {
      const hh = ROOF_PROP_HALF[pr.kind], k = pr.s ?? 1;
      // (the drawn shape — round tanks as octagons (two boxes), stands / towers as legs + deck + tank — plain
      //  bounding boxes are invisible walls round every tank and a solid block under every stand)
      void hh; void k;
      const yaw = b.yaw + (pr.yaw ?? 0), c = dmath.cos(yaw), s = dmath.sin(yaw);
      const [px, pz] = toWorld(b, pr.x, pr.z);
      const surf: Surface = pr.kind === "planter" ? "stone" : pr.kind === "crates" ? "wood" : "metal";
      for (const q of roofPropShape(pr)) {
        const [mx, mz] = [(q[0] + q[3]) / 2, (q[2] + q[5]) / 2];
        const box: Box = { c: [px + mx * c + mz * s, r.y + (q[1] + q[4]) / 2, pz - mx * s + mz * c], h: [(q[3] - q[0]) / 2, (q[4] - q[1]) / 2, (q[5] - q[2]) / 2], yaw: yaw + (q[6] ?? 0), surf: q[7] ?? surf };
        out.push(box);
      }
    }
  } else {
    // pitched: terraced slabs following the slope (the sim cannot stand on pitched boxes, see stairs)
    const alongX = r.axis === "x", shed = r.kind === "shed";
    const span = shed ? (alongX ? b.d : b.w) + 2 * r.overhang : (alongX ? b.d : b.w) / 2 + r.overhang;
    const ridgeLen = (alongX ? b.w : b.d) + 2 * r.overhang;
    // (≤ 0.45 m between terraces — a kong who reaches an eave can walk up to the ridge; 0.6–0.9 m terraces are
    //  jump-only)
    const N = Math.max(4, Math.ceil(r.rise / 0.45));
    const sides = shed ? [1] : [1, -1];
    for (const sgn of sides) for (let k = 0; k < N; k++) {
      const a0 = k / N, a1 = (k + 1) / N;
      // distance from the ridge (gable) or from the high edge (shed: high edge at -span/2 across)
      const d0 = shed ? -span / 2 + a0 * span : a0 * span * sgn, d1 = shed ? -span / 2 + a1 * span : a1 * span * sgn;
      const mid = (d0 + d1) / 2, half = Math.abs(d1 - d0) / 2;
      // (terrace tops at the slope's mid-band height + the rafters + sheet (+0.07: parity-measured; +0.18 leaves the tops 0.3 m proud))
      const topY = r.y + r.rise * (1 - (k + 0.5) / N) + 0.07;
      const lx = alongX ? 0 : mid, lz = alongX ? mid : 0;
      const [cx, cz] = toWorld(b, lx, lz);
      out.push({ c: [cx, topY - 0.12, cz], h: [alongX ? ridgeLen / 2 : half, 0.12, alongX ? half : ridgeLen / 2], yaw: b.yaw, surf: "metal" });
      // (the ATTIC is solid — a block under every terrace band, from the ceiling slab up to the band, inside the
      //  walls: with only a noWalk ceiling a kong jumps through it from a table into the roof void and the wall / tall
      //  furniture tops in there are 'unreachable' floors)
      if (!shed) {
        const inner = (alongX ? b.d : b.w) / 2 - t, a0 = Math.min(Math.abs(d0), Math.abs(d1)), a1 = Math.min(inner, Math.max(Math.abs(d0), Math.abs(d1)));
        const fy0 = r.y - 0.22, fy1 = topY - 0.24, along = (alongX ? b.w : b.d) - 2 * t;
        if (a1 - a0 > 0.02 && fy1 - fy0 > 0.05) {
          const fm = sgn * (a0 + a1) / 2, [fx, fz] = toWorld(b, alongX ? 0 : fm, alongX ? fm : 0);
          out.push({ c: [fx, (fy0 + fy1) / 2, fz], h: [alongX ? along / 2 : (a1 - a0) / 2, (fy1 - fy0) / 2, alongX ? (a1 - a0) / 2 : along / 2], yaw: b.yaw, surf, noShoot: true });
        }
      }
      // (the GABLE walls under this band at both ends — without them a neighbour's roof walks through into the
      //  attic) — stepped like the terraces, in the end-wall plane
      const endH = topY - 0.14 - r.y, endHalf = (alongX ? b.w : b.d) / 2 - t / 2;
      if (endH > 0.05 && half > 0.05) for (const e of [-1, 1]) {
        if (k === 0 && sgn === sides[0] && b.gableFill?.includes(e as -1 | 1)) {
          // the whole gable end as one block, eave → ridge, across the whole end wall (+ the eave strip)
          const ex = alongX ? e * ((b.w / 2) - t / 2) : 0, ez = alongX ? 0 : e * ((b.d / 2) - t / 2);
          const [gx, gz] = toWorld(b, ex, ez), H2 = r.rise + 0.07, hw = (alongX ? b.d : b.w) / 2 + r.overhang;
          out.push({ c: [gx, r.y + H2 / 2, gz], h: [alongX ? t / 2 : hw, H2 / 2, alongX ? hw : t / 2], yaw: b.yaw, surf });
        }
        if (b.gableFill?.includes(e as -1 | 1)) continue;
        const ex = alongX ? e * endHalf : mid, ez = alongX ? mid : e * endHalf;
        const [gx, gz] = toWorld(b, ex, ez);
        out.push({ c: [gx, r.y + endH / 2, gz], h: [alongX ? t / 2 : half, endH / 2, alongX ? half : t / 2], yaw: b.yaw, surf });
      }
    }
  }
  // the chimney: one block from the attic floor to 0.95 m over the ridge (client draws the same)
  if (b.chimney && r.kind !== "flat") { const [cx, cz] = b.chimney; out.push(localBox(b, cx - 0.36, cz - 0.36, cx + 0.36, cz + 0.36, r.y, r.y + r.rise + 0.95, surf)); }
  // balcony
  if (p.balcony) {
    const w = p.walls[p.balcony.side];
    const u = (p.balcony.u0 + p.balcony.u1) / 2, L = p.balcony.u1 - p.balcony.u0;
    const lx = w.A[0] + w.dir[0] * u + w.n[0] * p.balcony.depth / 2, lz = w.A[1] + w.dir[1] * u + w.n[1] * p.balcony.depth / 2;
    const [cx, cz] = toWorld(b, lx, lz);
    const yaw = dirYaw(b, w.dir);
    out.push({ c: [cx, p.balcony.y - 0.1, cz], h: [L / 2, 0.1, p.balcony.depth / 2], yaw, surf: "wood" });
    const rx = w.A[0] + w.dir[0] * u + w.n[0] * (p.balcony.depth - 0.05), rz = w.A[1] + w.dir[1] * u + w.n[1] * (p.balcony.depth - 0.05);
    const [rcx, rcz] = toWorld(b, rx, rz);
    out.push({ c: [rcx, p.balcony.y + 0.5, rcz], h: [L / 2, 0.5, 0.05], yaw, surf: "wood" });
  }
  // awning (walkable, flat box at its mean height) + posts
  if (p.awning) {
    const w = p.walls[p.awning.side];
    const u = (p.awning.u0 + p.awning.u1) / 2, L = p.awning.u1 - p.awning.u0;
    const lx = w.A[0] + w.dir[0] * u + w.n[0] * p.awning.depth / 2, lz = w.A[1] + w.dir[1] * u + w.n[1] * p.awning.depth / 2;
    const [cx, cz] = toWorld(b, lx, lz);
    const drop = p.awning.kind === "tin" ? 0.45 : 0.3;
    // (noWalk — bullets hit the sheet, kongs pass: a 1 m stall / barrel / crate stack under a 2.7 m awning leaves
    //  0.8–1.7 m of headroom, a pinning pocket for anyone who jumped onto it)
    out.push({ c: [cx, p.awning.y - drop / 2, cz], h: [L / 2, 0.06, p.awning.depth / 2], yaw: dirYaw(b, w.dir), surf: p.awning.kind === "tin" ? "metal" : "fabric", noWalk: true });
    if (b.awningPosts && p.awning.kind === "tin") for (const pu of awningPostUs(p.awning)) {
      const px = w.A[0] + w.dir[0] * pu + w.n[0] * (p.awning.depth - 0.12), pz = w.A[1] + w.dir[1] * pu + w.n[1] * (p.awning.depth - 0.12);
      const [qx, qz] = toWorld(b, px, pz);
      out.push({ c: [qx, (b.y + p.awning.y - drop) / 2, qz], h: [0.07, (p.awning.y - drop - b.y) / 2, 0.07], yaw: b.yaw, surf: "wood" });
    }
  }
  return out;
}

// ---------- what stands in an opening collides like it is drawn (client town-building draws the same)
/** deterministic per-opening choice (shared by LOD0, LOD1 and the colliders so the shutters never disagree) */
export function openingHash(b: { x: number; z: number }, f: number, u: number, salt = 0): number {
  let h = (Math.round(b.x * 10) * 73856093) ^ (Math.round(b.z * 10) * 19349663) ^ ((f + 1) * 83492791) ^ (Math.round(u * 100) * 2654435761) ^ (salt * 97531);
  h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
/** shutter state of a window (LOD0 + LOD1 + colliders agree) */
export function windowClosed(b: TownBuilding, f: number, op: { u: number }): boolean {
  const mode = b.shutters ?? "mixed";
  // (a window is a route — glass you smash and vault. Most louvred shutters stand folded open beside
  //  the glass; a few stay closed so the facades keep their rhythm: ~13 % of shuttered windows)
  return mode === "open" ? false : openingHash(b, f, op.u) < (mode === "closed" ? 0.3 : 0.12);
}
/** corner quoins (plaster buildings of 2+ storeys, ~55 %): a 0.36 m column on every corner, 0.15 m proud */
export function hasQuoins(b: TownBuilding): boolean { return b.quoins !== false && (b.material ?? "plaster") === "plaster" && b.floors > 1 && openingHash(b, 0, 0, 11) < 0.55; }
/** which open shutter leaves of a window are drawn (-1 = left, +1 = right): only those lying on solid wall */
export function shutterLeaves(op: { u: number; w: number }, wlen: number, sibs: Array<{ u: number; w: number }>): Array<-1 | 1> {
  const sw = op.w / 2 - 0.01, out: Array<-1 | 1> = [];
  for (const s of [-1, 1] as const) {
    const hinge = s < 0 ? op.u - 0.15 : op.u + op.w + 0.15;
    const e0 = s < 0 ? hinge - sw - 0.05 : hinge, e1 = s < 0 ? hinge : hinge + sw + 0.05;
    if (e0 < 0.08 || e1 > wlen - 0.08 || sibs.some((q) => q !== op && q.u < e1 && q.u + q.w > e0)) continue;
    out.push(s);
  }
  return out;
}
/** open door leaves: swung just past square into the room (the leaf clears the whole doorway) / french pairs */
export const DOOR_SWING = 92 * Math.PI / 180, FRENCH_SWING = 85 * Math.PI / 180;
/** local rect a swung door leaf occupies inside the room (for furniture keep-outs): [x0, z0, x1, z1] building-local */
export function doorLeafRect(p: BuildingParts, w: ResolvedWall, op: Opening): [number, number, number, number] {
  const a = op.kind === "door" ? DOOR_SWING : FRENCH_SWING, L = op.kind === "door" ? op.w : op.w / 2, t = p.t;
  const pts: Vec2[] = [];
  const hinges: Array<[number, number]> = op.kind === "door" ? [[op.u, 1]] : [[op.u, 1], [op.u + op.w, -1]];
  for (const [hu, sg] of hinges) for (const e of [0, L]) {
    const u = hu + sg * dmath.cos(a) * e, off = t / 2 + dmath.sin(a) * e;
    pts.push([w.A[0] + w.dir[0] * u - w.n[0] * off, w.A[1] + w.dir[1] * u - w.n[1] * off]);
  }
  const xs = pts.map((q) => q[0]), zs = pts.map((q) => q[1]);
  return [Math.min(...xs) - 0.1, Math.min(...zs) - 0.1, Math.max(...xs) + 0.1, Math.max(...zs) + 0.1];
}
/** colliders of what fills the openings of a building: window panes (glass: bullets pass) / closed shutters, the open
 *  door leaf, the open french leaves, the shop counter with its goods (the shop front is entered by its door) */
export function openingFill(p: BuildingParts, surf: Surface = "concrete"): Box[] {
  const { b, t, floorH } = p, out: Box[] = [];
  void surf;
  for (const w of p.walls) {
    const wyaw = dirYaw(b, w.dir);
    const P = (u: number, off: number): Vec2 => toWorld(b, w.A[0] + w.dir[0] * u - w.n[0] * off, w.A[1] + w.dir[1] * u - w.n[1] * off);
    for (let f = 0; f < b.floors; f++) {
      const fy = b.y + f * floorH;
      for (const op of w.openings[f]) {
        if (op.kind === "window") {
          const closed = op.shutters !== false && windowClosed(b, f, op);
          // open louvred leaves folded back 12° against the wall, 0.075 m out (client addOpening)
          if (!closed && op.shutters !== false) for (const s of shutterLeaves(op, w.len, w.openings[f])) {
            const sw = op.w / 2 - 0.01, a = (s < 0 ? 12 : -12) * Math.PI / 180, hinge = s < 0 ? op.u - 0.15 : op.u + op.w + 0.15;
            // leaf frame: at(hinge, cy, -0.075) · RotY(a) · T(±sw/2): local (u along wall, z outward)
            const ox = s * sw / 2, cu = hinge + ox * dmath.cos(a), cz = 0.075 - ox * dmath.sin(a);
            const [lx, lz] = [w.A[0] + w.dir[0] * cu + w.n[0] * cz, w.A[1] + w.dir[1] * cu + w.n[1] * cz];
            const [wx, wz] = toWorld(b, lx, lz);
            const ld: Vec2 = [w.dir[0] * dmath.cos(a) + w.n[0] * -dmath.sin(a), w.dir[1] * dmath.cos(a) + w.n[1] * -dmath.sin(a)];
            out.push({ c: [wx, fy + op.y + op.h / 2, wz], h: [sw / 2, (op.h - 0.02) / 2, 0.03], yaw: dirYaw(b, ld), surf: "wood" });
          }
          // (a thin pane in the plane that is drawn: closed louvred leaves 0.06 m in, the glass 0.17 m in)
          const [cx, cz] = P(op.u + op.w / 2, closed ? 0.06 : 0.17);
          out.push({ c: [cx, fy + op.y + op.h / 2, cz], h: [op.w / 2, op.h / 2, 0.04], yaw: wyaw, surf: closed ? "wood" : "glass", ...(closed ? {} : { noShoot: true }) });
        } else if (op.kind === "door" || op.kind === "french") {
          const door = op.kind === "door", a = door ? DOOR_SWING : FRENCH_SWING, L = door ? op.w - 0.03 : op.w / 2 - 0.02;
          const hinges: Array<[number, number]> = door ? [[op.u, 1]] : [[op.u, 1], [op.u + op.w, -1]];
          for (const [hu, sg] of hinges) {
            const u = hu + sg * dmath.cos(a) * L / 2, off = t / 2 + dmath.sin(a) * L / 2;
            const [cx, cz] = P(u, off);
            const ld: Vec2 = [w.dir[0] * sg * dmath.cos(a) - w.n[0] * dmath.sin(a), w.dir[1] * sg * dmath.cos(a) - w.n[1] * dmath.sin(a)];
            const hh = door ? op.h - 0.04 : op.h - 0.02;
            out.push({ c: [cx, fy + op.y + 0.02 + hh / 2, cz], h: [L / 2, hh / 2, door ? 0.04 : 0.03], yaw: dirYaw(b, ld), surf: door ? "wood" : "glass", ...(door ? {} : { noShoot: true }) });
          }
        } else if (op.kind === "shop") {
          // counter (0.95 m) + the crates / fruit on it (to ~1.3 m), 0.3–0.9 m inside the wall face. The collider runs to
          // 1.5 m: under the shop lintel there is < 1.3 m of headroom above it, so it is never a floor (a 1.0 m top was a
          // covered 'jump-only' shelf in every shop, a 1.35 m one a sealed 'unreachable' one)
          const [cx, cz] = P(op.u + op.w / 2, 0.6);
          out.push({ c: [cx, fy + 0.75, cz], h: [(op.w - 0.3) / 2, 0.75, 0.3], yaw: wyaw, surf: "wood" });
        }
      }
    }
  }
  // corner quoins (client addBuildingFull: at(0, …, 0.03) on every wall = each corner, 0.36 × (H − 0.5) × 0.36)
  if (hasQuoins(b)) for (const w of p.walls) {
    const [lx, lz] = [w.A[0] - w.n[0] * 0.03, w.A[1] - w.n[1] * 0.03], [wx, wz] = toWorld(b, lx, lz), H = floorH * b.floors;
    out.push({ c: [wx, b.y + 0.5 + (H - 0.5) / 2, wz], h: [0.18, (H - 0.5) / 2, 0.18], yaw: dirYaw(b, w.dir), surf: "stone" });
  }
  return out;
}
/** rooftop prop collision shape, prop-local [x0, y0, z0, x1, y1, z1, extraYaw?, surf?] (y from the roof top) — the
 *  SAME dimensions client town-building addRoofProp / addTank / addWaterTower draw */
export type PropQ = [number, number, number, number, number, number, number?, Surface?];
/** a vertical cylinder as an octagon of two boxes (apothem ≈ r) */
export function octagon(x: number, z: number, r: number, y0: number, y1: number): PropQ[] {
  // (a PLUS of two bars + a 45° square inside the circle — a union of two squares is an 8-point STAR
  //  whose points stand 0.4 r OUTSIDE the drawn tank: invisible walls / floors round every rooftop tank)
  const a = r * 0.98, b = a * 0.414, h = a * 0.707;
  return [[x - a, y0, z - b, x + a, y1, z + b], [x - b, y0, z - a, x + b, y1, z + a], [x - h, y0, z - h, x + h, y1, z + h, Math.PI / 4]];
}
export function roofPropShape(pr: RoofProp): PropQ[] {
  // (tank bodies stop at the shoulder of the drawn dome: its top is a walkable, drawn surface)
  // dimensions = client town-market addWaterTank / addACUnit / addPot (every rooftop tank, AC and planter is drawn by that
  // kit — full detail on the plaza ring, its low copy elsewhere) and town-building addRoofProp's crates
  const s = pr.s ?? 1, sc = (q: PropQ): PropQ => [q[0] * s, q[1] * s, q[2] * s, q[3] * s, q[4] * s, q[5] * s, q[6], q[7]];
  const withSurf = (qs: PropQ[], surf: Surface) => qs.map((q) => { q[7] = surf; return q; });
  switch (pr.kind) {
    case "plastic": return [[-0.7, 0, -0.39, 0.7, 0.1, 0.39, 0, "wood"] as PropQ, ...octagon(0, 0, 0.6, 0.1, 0.1 + 1.3 * 0.9)].map(sc);
    case "steel": return [[-0.72, 0, -0.72, 0.72, 0.14, 0.72, 0, "stone"] as PropQ, ...octagon(0, 0, 0.62, 0.14, 0.14 + 1.12 * 0.95)].map(sc);
    case "stand": return [[-0.95, 0, -0.95, 0.95, 0.86, 0.95, 0, "wood"] as PropQ, ...octagon(0, 0, 0.84, 0.86, 0.86 + 1.85 * 0.9)].map(sc);
    case "tower": {
      const out: PropQ[] = [];
      for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) out.push([sx * 0.74 - 0.08, 0, sz * 0.74 - 0.08, sx * 0.74 + 0.08, 3.2, sz * 0.74 + 0.08, 0, "wood"]);
      out.push([-0.95, 3.19, -0.98, 0.95, 3.29, 0.98, 0, "wood"], ...octagon(0, 0, 0.72, 3.29, 3.29 + 1.45 * 0.9));
      return out.map(sc);
    }
    case "ac": return [[-0.43, 0, -0.2, 0.43, 0.66, 0.2]].map((q) => sc(q as PropQ));
    case "planter": return withSurf(octagon(0, 0, 0.176 * s, 0, 0.48 * s), "stone");
    case "crates": return [[-0.62, 0, -0.24, 0.62, 0.34, 0.24, 0, "wood"], [-0.3, 0.34, -0.22, 0.3, 0.68, 0.22, 0, "wood"]];
  }
}

// ---------- the interiors kit rooms of a town building (one room per storey, the building's own frame)
/** local wall-centre coordinate of an opening on side s (the kit's `at`: local x on sides 0 / 2, local z on 1 / 3) */
function openingAt(b: { w: number; d: number }, s: Side, op: Opening): number {
  const c = op.u + op.w / 2;
  return s === 0 ? -b.w / 2 + c : s === 1 ? b.d / 2 - c : s === 2 ? b.w / 2 - c : -b.d / 2 + c;
}
/** every storey of a furnished town building as an interiors-kit room: the town kit draws the shell, floors, ceilings,
 *  skirting and glazing; the kit furnishes (furniture + colliders + loot slots), frames the openings inside and hangs
 *  lamps / curtains. Stairs (+ the stairwell and the flight arriving from below) and swung door leaves are keep-outs. */
export function buildingRooms(p: BuildingParts, o: { style?: InteriorStyle; roles?: RoomRole[]; density?: number; shopStyle?: InteriorStyle } = {}): InteriorRoom[] {
  const { b, t, floorH } = p;
  if (b.interior === false || b.w <= 4.2 || b.d <= 4.2) return [];
  const out: InteriorRoom[] = [];
  const iw = b.w - 2 * t, id = b.d - 2 * t;
  for (let f = 0; f < b.floors; f++) {
    const slab = p.slabs.find((s) => s.floor === f), above = p.slabs.find((s) => s.floor === f + 1);
    const y = (slab?.y ?? b.y + f * floorH) + (f === 0 ? 0.05 : 0);
    const top = above ? above.y - above.t : b.y + (f + 1) * floorH - 0.25;
    const openings: RoomOpening[] = [];
    const keepOut: NonNullable<InteriorRoom["keepOut"]> = [];
    for (const w of p.walls) for (const op of w.openings[f]) {
      const at = openingAt(b, w.side, op);
      if (op.kind === "door" || op.kind === "french") {
        openings.push({ side: w.side, at, w: op.w, kind: "door", y0: 0, h: Math.min(op.h, top - y - 0.05) });
        const r = doorLeafRect(p, w, op);
        keepOut.push([Math.max(-iw / 2, r[0]), Math.max(-id / 2, r[1]), Math.min(iw / 2, r[2]), Math.min(id / 2, r[3])]);
      } else if (op.kind === "window") openings.push({ side: w.side, at, w: op.w, kind: "window", y0: op.y, h: op.h });
      else if (op.kind === "shop") {
        // the counter across the shop front (0.3–0.9 m in) + the goods: a window above 1.0 m, the counter kept clear
        openings.push({ side: w.side, at, w: op.w, kind: "window", y0: 1.0, h: op.h - 0.95 });
        // (the band runs 1.6 m in and 0.7 m past both counter ends — clutter tucked beside a counter end makes
        //  1 m² pockets the scanner reads as traps)
        const ua = Math.max(0, op.u - 0.7), ub = Math.min(w.len, op.u + op.w + 0.7);
        const P0 = [w.A[0] + w.dir[0] * ua - w.n[0] * 1.6, w.A[1] + w.dir[1] * ua - w.n[1] * 1.6], P1 = [w.A[0] + w.dir[0] * ub - w.n[0] * t, w.A[1] + w.dir[1] * ub - w.n[1] * t];
        keepOut.push([Math.min(P0[0], P1[0]), Math.min(P0[1], P1[1]), Math.max(P0[0], P1[0]), Math.max(P0[1], P1[1])]);
      }
    }
    const sz = stairZone(p, f);
    // (the whole stair hall — flights, wells, both 1.25 m landings — plus a 1.0 m approach band in front of it)
    if (sz) {
      const fr = p.hall!.side, nb = 1.0;
      const r: [number, number, number, number] = [Math.max(-iw / 2, sz[0] - (fr === 1 ? nb : 0)), Math.max(-id / 2, sz[1] - (fr === 0 ? nb : 0)), Math.min(iw / 2, sz[2] + (fr === 3 ? nb : 0)), Math.min(id / 2, sz[3] + (fr === 2 ? nb : 0))];
      keepOut.push({ r, walk: true });
    }
    // (a 1.2 m band along every door wall — otherwise the kit's shop gondolas / counters wall the stair foot off from
    //  the door: upper floors 'jump-only')
    if (f === 0 && sz) {
      for (const w of p.walls) if (w.openings[0].some((op) => op.kind === "door")) {
        const s2 = w.side;
        keepOut.push({ r: s2 === 0 ? [-iw / 2, id / 2 - 1.2, iw / 2, id / 2] : s2 === 2 ? [-iw / 2, -id / 2, iw / 2, -id / 2 + 1.2] : s2 === 1 ? [iw / 2 - 1.2, -id / 2, iw / 2, id / 2] : [-iw / 2, -id / 2, -iw / 2 + 1.2, id / 2], walk: true });
      }
    }
    const shop = f === 0 && !!b.shop;
    const style: InteriorStyle = shop ? (o.shopStyle ?? "shop") : (o.style ?? "house");
    out.push({
      id: `${b.id ?? ""}f${f}`, x: b.x, y, z: b.z, yaw: b.yaw, w: iw, d: id, h: Math.max(2.3, top - y), style,
      role: o.roles?.[f % (o.roles.length || 1)], seed: ((b.seed ?? hashXZ(b.x, b.z)) + f * 7919) >>> 0,
      openings, keepOut, density: o.density, wallT: t,
      finish: { floor: "none", wall: null, dado: null, baseboard: false, ceiling: "none", glass: false },
      // (the stair wells in this storey's ceiling — the kit's lit-shell liner / beams / panels skip them; as a
      //  full plane you would climb through a drawn ceiling)
      ...(p.holes.some((h) => h.floor === f) ? { floorHoles: p.holes.filter((h) => h.floor === f).map((h) => [h.x0, h.z0, h.x1, h.z1] as [number, number, number, number]) } : {}),
      ...(p.holes.some((h) => h.floor === f + 1) ? { ceilHoles: p.holes.filter((h) => h.floor === f + 1).map((h) => [h.x0, h.z0, h.x1, h.z1] as [number, number, number, number]) } : {}),
    });
  }
  return out;
}

/** the furnished interiors of a POI (colliders in the SIM convention + loot slots), read from the bake
 *  (shared/pois/town-interiors.json, written by an offline bake tool) when it matches the rooms AND the kit (3 probe
 *  rooms are furnished live and compared), else furnished live (~2.4 ms a room: 1.4 s for Mango's 604 rooms at import,
 *  on the server and on the client's main thread — re-bake after layout / kit changes; a warning says so). */
export interface TownInteriorBake { key: string; probe: number[]; cols: number[]; chests: number[]; floor: number[] }
const SURF_I: Surface[] = ["wood", "metal", "concrete", "stone", "sand", "grass", "water", "foliage", "glass", "fabric"];
const r3 = (v: number) => Math.round(v * 1000) / 1000;
export function roomsKey(rooms: InteriorRoom[]): string {
  // (numbers rounded to 1e-5: the browser's and Node's V8 differ in the last ulp of Math.atan2 / cos — layout yaws)
  const str = JSON.stringify(rooms, (_k, v) => (typeof v === "number" ? Math.round(v * 1e5) / 1e5 : v));
  let h1 = 0x811c9dc5, h2 = 0x1b873593;
  for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619); h2 = Math.imul(h2 ^ c, 2246822519); }
  return `${rooms.length}:${(h1 >>> 0).toString(16)}${(h2 >>> 0).toString(16)}`;
}
function flatCols(bs: Box[], out: number[] = []): number[] {
  for (const b of bs) out.push(r3(b.c[0]), r3(b.c[1]), r3(b.c[2]), r3(b.h[0]), r3(b.h[1]), r3(b.h[2]), r3(b.yaw ?? 0), SURF_I.indexOf(b.surf ?? "wood"), b.noShoot ? 1 : 0);
  return out;
}
function probeSig(rooms: InteriorRoom[]): number[] {
  const out: number[] = [];
  for (const i of [0, rooms.length >> 1, rooms.length - 1]) if (rooms[i]) { const L = furnishRoom(rooms[i]); out.push(L.items.length); flatCols(L.colliders, out); }
  return out;
}
/** the town's colliders for a furnished room: the kit's, with the shapes of a few items replaced by what the
 *  kit actually DRAWS (client interior-draw): the tiered fruit display (3 steps, not a 0.95 m block whose top nothing is
 *  drawn on), chair backs as the 5 cm slat frame, open shelving as its back 0.3 m (the shelves in front are see-through
 *  and the goods stand inside the box) — parity floor-mismatch / invisible-wall in every town shop */
function townRoomColliders(room: InteriorRoom, L: InteriorLayout): Box[] {
  const drop = new Set<string>(), add: Box[] = [];
  const key = (b: Box) => `${b.c.map((v) => v.toFixed(3))}|${b.h.map((v) => v.toFixed(3))}`;
  const boxes = (it: InteriorItem, lb: Array<[number, number, number, number, number, number]>): Box[] => {
    const surf = itemSurface(it.kind, room.style), yaw = room.yaw + it.yaw, ci = dmath.cos(it.yaw), si = dmath.sin(it.yaw), c = dmath.cos(room.yaw), sn = dmath.sin(room.yaw);
    return lb.map(([x0, y0, z0, x1, y1, z1]) => {
      const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2, lx = it.x + mx * ci + mz * si, lz = it.z - mx * si + mz * ci;
      const b: Box = { c: [room.x + lx * c + lz * sn, room.y + it.y + (y0 + y1) / 2, room.z - lx * sn + lz * c], h: [(x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2], surf };
      const sy = -yaw; if (Math.abs(dmath.sin(sy)) > 1e-6 || dmath.cos(sy) < 0) b.yaw = sy;
      return b;
    });
  };
  const CAP = new Set(["fruit-display", "counter", "sink", "stove", "shop-counter"]);
  const capped = new Set<string>();
  for (const it of L.items) {
    const X = it.w / 2, Z = it.d / 2, h = it.h;
    // fruit displays, kitchen runs, counters, low shelving: tops nobody needs to stand on (rows of them read as
    // 'jump-only' floors at ~1 m) — they get a ceiling DROP below (see the end)
    if (CAP.has(it.kind) || (it.kind === "shelf-goods" && h < 1.2)) for (const q of itemColliders(room, it)) capped.add(key(q));
    let lb: Array<[number, number, number, number, number, number]> | null = null;
    if (it.kind === "chair") lb = [[-X * 0.9, 0, -Z * 0.9, X * 0.9, 0.5, Z * 0.9], [-X * 0.9, 0.5, -Z + 0.01, X * 0.9, h, -Z + 0.06]];
    // (shelf-goods keep the kit's full box: a shallower one opened a stuck pocket beside a cooler)
    else if (it.kind === "bookshelf" || it.kind === "rack") lb = [[-X, 0, -Z, X, h, -Z + Math.min(0.3, it.d)]];
    if (!lb) continue;
    for (const q of itemColliders(room, it)) drop.add(key(q));
    add.push(...boxes(it, lb));
  }
  const cols = [...(drop.size ? L.colliders.filter((q) => !drop.has(key(q))) : L.colliders), ...add];
  // a no-shoot DROP hung from the ceiling over a furniture top whose headroom would let a kong crouch / stand on it
  // where nobody should (tall cabinets ≥ 1.6 m, gondolas, counters in low rooms, the capped kinds above): it leaves
  // 1.2 m — no floor at all — sits above head height for anyone walking past, and above the parity tool's 1.7 m ray
  const caps: Box[] = [];
  for (const q of cols) {
    if (q.noShoot) continue;
    const top = q.c[1] + q.h[1], bot = q.c[1] - q.h[1], head = room.y + room.h - top;
    if (bot - room.y > 0.6 || head < 1.2) continue;
    if (!(top - room.y >= 1.4 || head < 1.95 || capped.has(key(q)))) continue;
    const y0 = top + 1.2, y1 = room.y + room.h + 0.02;
    if (y0 - room.y < 1.75) continue;   // (never at head height over a walkable floor)
    caps.push({ ...q, c: [q.c[0], (y0 + y1) / 2, q.c[2]], h: [q.h[0], (y1 - y0) / 2, q.h[2]], noShoot: true });
  }
  return caps.length ? [...cols, ...caps] : cols;
}
export function bakeTownInteriors(rooms: InteriorRoom[]): TownInteriorBake {
  const cols: number[] = [], chests: number[] = [], floor: number[] = [];
  for (const r of rooms) { const L = furnishRoom(r); flatCols(townRoomColliders(r, L), cols); for (const c of L.loot.chests) chests.push(...c.map(r3)); for (const f of L.loot.floor) floor.push(...f.map(r3)); }
  return { key: roomsKey(rooms), probe: probeSig(rooms), cols, chests, floor };
}
export function townInteriors(poi: string, rooms: InteriorRoom[], bake?: TownInteriorBake): { colliders: Box[]; loot: LootSlots; baked: boolean } {
  let B = bake;
  let why = "";
  const stale = (): boolean => { const ps = probeSig(rooms); const i = ps.findIndex((v, k) => Math.abs(v - B!.probe[k]) > 1e-3); if (ps.length !== B!.probe.length || i >= 0) { why = `probe ${ps.length}/${B!.probe.length} @${i}: ${ps[i]} vs ${B!.probe[i]}`; return true; } return false; };
  const key = roomsKey(rooms);
  if (!B || B.key !== key || stale()) {
    if (!why) why = B ? `key ${key} vs ${B.key}` : "no bake";
    if (rooms.length > 40) console.warn(`[${poi}] interiors bake is stale (${why}) — furnishing ${rooms.length} rooms live; re-bake: npx tsx tools/dev/town-interiors-bake.mts`);
    B = bakeTownInteriors(rooms);
    return { ...unbake(B), baked: false };
  }
  return { ...unbake(B), baked: true };
}
function unbake(B: TownInteriorBake): { colliders: Box[]; loot: LootSlots } {
  const colliders: Box[] = [];
  for (let i = 0; i < B.cols.length; i += 9) {
    const b: Box = { c: [B.cols[i], B.cols[i + 1], B.cols[i + 2]], h: [B.cols[i + 3], B.cols[i + 4], B.cols[i + 5]], surf: SURF_I[B.cols[i + 7]] };
    if (B.cols[i + 6]) b.yaw = B.cols[i + 6];
    if (B.cols[i + 8]) b.noShoot = true;
    colliders.push(b);
  }
  const loot: LootSlots = { chests: [], floor: [] };
  for (let i = 0; i < B.chests.length; i += 4) loot.chests.push([B.chests[i], B.chests[i + 1], B.chests[i + 2], B.chests[i + 3]]);
  for (let i = 0; i < B.floor.length; i += 3) loot.floor.push([B.floor[i], B.floor[i + 1], B.floor[i + 2]]);
  return { colliders, loot };
}

/** `LOOT_SPOTS` from the interior candidates: greedy spatial thinning (list order, deterministic) — about one
 *  chest per building storey block (`chestSep` m) and one floor spot per room (`floorSep` m) — plus designed hero spots.
 *  The match generator activates a seeded subset per match; INTERIOR_LOOT keeps every candidate. */
export function townLootSpots(loot: LootSlots, o: { chestSep?: number; floorSep?: number; chests?: Array<[number, number, number, number]>; floor?: Array<[number, number, number]> } = {}): { chests: Array<[number, number, number, number]>; floor: Array<[number, number, number]> } {
  const cs = o.chestSep ?? 8, fs = o.floorSep ?? 5;
  const far = <T extends number[]>(list: T[], p: T, sep: number, ky = 2.2) => list.every((q) => dmath.hypot3(q[0] - p[0], (q[1] - p[1]) * ky, q[2] - p[2]) >= sep);
  const chests: Array<[number, number, number, number]> = [...(o.chests ?? [])], floor: Array<[number, number, number]> = [...(o.floor ?? [])];
  // (chests: horizontal separation only — ≈ one per building; floor spots: storeys count apart)
  for (const c of loot.chests) if (far(chests, c, cs, 0)) chests.push(c);
  for (const f of loot.floor) if (far(floor, f, fs) && far(chests.map((c) => [c[0], c[1], c[2]] as [number, number, number]), f, 1.5)) floor.push(f);
  return { chests, floor };
}

// ---------- stilt decks / piers (shared by stilt town + coconut cove)
/** `gaps`: openings in the rails (a rail along the full side blocks every plank link / stair that meets it, so
 *  links and stairs open one): [side, u0, u1] metres along the side from its A corner */
export interface Deck { x: number; z: number; yaw: number; w: number; d: number; y: number; rail?: boolean | Side[]; surf?: Surface; gaps?: Array<[Side, number, number]> }
/** solid rail runs of a deck side (u ranges along the side, gaps removed) */
export function railRuns(k: Deck, s: Side): Array<[number, number]> {
  const len = s % 2 === 0 ? k.w : k.d;
  let runs: Array<[number, number]> = [[0, len]];
  for (const [gs, g0, g1] of k.gaps ?? []) if (gs === s) runs = runs.flatMap(([a, b]) => (g1 <= a || g0 >= b ? [[a, b]] : [[a, g0], [g1, b]]).filter(([p, q]) => q - p > 0.25) as Array<[number, number]>);
  return runs;
}
export function deckSides(k: Deck): Side[] { return k.rail === true ? [0, 1, 2, 3] : (k.rail || []); }
/** local point on side s at u metres from its A corner */
export function sidePoint(k: { w: number; d: number }, s: Side, u: number, inset = 0): Vec2 {
  const S = SIDES[s], A = S.A(k.w, k.d);
  return [A[0] + S.dir[0] * u - S.n[0] * inset, A[1] + S.dir[1] * u - S.n[1] * inset];
}
/** open a rail gap of width w on the deck side nearest to the world point (x, z) */
export function deckGap(k: Deck, x: number, z: number, w = 1.8) {
  const c = dmath.cos(k.yaw), s = dmath.sin(k.yaw), dx = x - k.x, dz = z - k.z;
  const lx = dx * c - dz * s, lz = dx * s + dz * c;
  const dists = [Math.abs(lz - k.d / 2), Math.abs(lx - k.w / 2), Math.abs(lz + k.d / 2), Math.abs(lx + k.w / 2)];
  const side = dists.indexOf(Math.min(...dists)) as Side;
  const u = side === 0 ? lx + k.w / 2 : side === 1 ? k.d / 2 - lz : side === 2 ? k.w / 2 - lx : lz + k.d / 2;
  (k.gaps ??= []).push([side, u - w / 2, u + w / 2]);
}
/** a point on the deck's boundary facing the world point (tx, tz), kept ≥ `m` metres from the corners (a link / stair
 *  meeting a corner half-misses its rail gap) — returns the world point and the side it is on */
export function deckAttach(k: Deck, tx: number, tz: number, m = 1.1): { x: number; z: number; side: Side } {
  const c = dmath.cos(k.yaw), s = dmath.sin(k.yaw), dx = tx - k.x, dz = tz - k.z;
  const lx = dx * c - dz * s, lz = dx * s + dz * c;
  // side = the one the ray from the centre leaves through
  const sx = Math.abs(lx) / (k.w / 2), sz = Math.abs(lz) / (k.d / 2);
  let px: number, pz: number, side: Side;
  if (sz >= sx) { side = lz >= 0 ? 0 : 2; pz = Math.sign(lz || 1) * k.d / 2; px = Math.max(-k.w / 2 + m, Math.min(k.w / 2 - m, lz ? lx * (k.d / 2) / Math.abs(lz) : 0)); }
  else { side = lx >= 0 ? 1 : 3; px = Math.sign(lx || 1) * k.w / 2; pz = Math.max(-k.d / 2 + m, Math.min(k.d / 2 - m, lx ? lz * (k.w / 2) / Math.abs(lx) : 0)); }
  const [x, z] = toWorld(k, px, pz);
  return { x, z, side };
}
/** the deck's pile grid (local, nominal — the client jitters each by ≤ 6 cm): perimeter every ~3.2 m, the interior on a
 *  checkerboard (`skip` = no pile drawn there). Shared so the piles collide. */
export function deckPiles(k: Deck): Array<{ lx: number; lz: number; i: number; j: number; skip: boolean }> {
  const nx = Math.max(2, Math.round(k.w / 3.2)), nz = Math.max(2, Math.round(k.d / 3.2)), out: Array<{ lx: number; lz: number; i: number; j: number; skip: boolean }> = [];
  for (let i = 0; i <= nx; i++) for (let j = 0; j <= nz; j++) {
    const inner = i > 0 && i < nx && j > 0 && j < nz;
    out.push({ lx: -k.w / 2 + 0.3 + (k.w - 0.6) * i / nx, lz: -k.d / 2 + 0.3 + (k.d - 0.6) * j / nz, i, j, skip: inner && (i + j) % 2 === 1 });
  }
  return out;
}
export function deckColliders(k: Deck): Box[] {
  const out: Box[] = [localBox(k, -k.w / 2, -k.d / 2, k.w / 2, k.d / 2, k.y - 0.22, k.y, k.surf ?? "wood")];
  // piles (r ≈ 0.17–0.21 drawn): sea bed → under the deck
  for (const q of deckPiles(k)) if (!q.skip) out.push(localBox(k, q.lx - 0.15, q.lz - 0.15, q.lx + 0.15, q.lz + 0.15, -4, k.y - 0.22, "wood"));
  for (const s of deckSides(k)) {
    const S = SIDES[s];
    for (const [u0, u1] of railRuns(k, s)) {
      const a = sidePoint(k, s, u0, 0.06), b = sidePoint(k, s, u1, 0.06);
      const [cx, cz] = toWorld(k, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      out.push({ c: [cx, k.y + 0.5, cz], h: [(u1 - u0) / 2, 0.5, 0.05], yaw: dirYaw(k, S.dir), surf: "wood" });
    }
  }
  return out;
}

/** a walkway is a deck between two points */
export function walkway(ax: number, az: number, bx: number, bz: number, y: number, w = 2.2, rail: boolean | Side[] = [1, 3]): Deck {
  const dx = bx - ax, dz = bz - az, len = dmath.hypot(dx, dz);
  return { x: (ax + bx) / 2, z: (az + bz) / 2, yaw: dmath.atan2(dx, dz), w, d: len, y, rail };
}

/** every town layout computes box yaws in the three.js convention (local +x → world
 *  (cos, −sin)), but the sim's Box.yaw is the NEGATIVE of that (shared/sim/world.ts: box +x = world (cos, 0, sin); see
 *  harbor-kit `SIM_YAW = −threeYaw`). Unconverted, every rotated town box is mirrored about its own centre in the sim —
 *  walls across streets and doorways (invisible walls), open air where the walls stand (walk-throughs). Every POI's
 *  exported `colliders` goes through this once, at the very end. */
export function simBoxes(bs: Box[]): Box[] { return bs.map((b) => (b.yaw ? { ...b, yaw: -b.yaw } : b)); }

export interface Clearing { x: number; z: number; r: number }
export const circle = (x: number, z: number, r: number): Clearing => ({ x, z, r });

// ---------- open-ground COVER (hard cover within ~8 m of every outdoor spot in the POI circle)
/** a world-frame ground grid (baked offline into mango-slope.json `grids`) */
export interface GroundGrid { x0: number; z0: number; step: number; nx: number; nz: number; h: number[] }
export function gridH(g: GroundGrid, x: number, z: number): number {
  const fi = Math.max(0, Math.min(g.nx - 1.001, (x - g.x0) / g.step)), fj = Math.max(0, Math.min(g.nz - 1.001, (z - g.z0) / g.step));
  const i = Math.floor(fi), j = Math.floor(fj), a = fi - i, b = fj - j, H = (ii: number, jj: number) => g.h[jj * g.nx + ii];
  return (H(i, j) * (1 - a) + H(i + 1, j) * a) * (1 - b) + (H(i, j + 1) * (1 - a) + H(i + 1, j + 1) * a) * b;
}
export interface CoverCluster { kind: "rocks" | "palms" | "grove"; x: number; z: number; y: number; yaw: number; s: number }
/** clusters on a jittered `step` grid over the circle where the ground is dry and gentle and `free(x, z)` (nothing of
 *  the POI already stands within ~6 m) — rock outcrops (2–4 sculpted boulders ≥ 1.2 m) and palm groups (foot colliders
 *  1.5 m), alternating by a smooth noise so they read as groves and outcrops, not a grid */
export function coverScatter(g: GroundGrid, o: { cx: number; cz: number; r: number; step?: number; seed: number; free: (x: number, z: number) => boolean; minY?: number }): CoverCluster[] {
  const rng = mulberry(o.seed), step = o.step ?? 12, out: CoverCluster[] = [], minY = o.minY ?? 0.6;
  for (let z = o.cz - o.r; z <= o.cz + o.r; z += step) for (let x = o.cx - o.r; x <= o.cx + o.r; x += step) {
    const px = x + (rng() - 0.5) * step * 0.7, pz = z + (rng() - 0.5) * step * 0.7, k = rng(), yaw = rng() * 6.283, s = 0.85 + rng() * 0.4;
    if (dmath.hypot(px - o.cx, pz - o.cz) > o.r * 0.95) continue;
    const y = gridH(g, px, pz), sl = Math.max(Math.abs(gridH(g, px + 2, pz) - gridH(g, px - 2, pz)), Math.abs(gridH(g, px, pz + 2) - gridH(g, px, pz - 2))) / 4;
    if (y < minY || sl > 0.22 || !o.free(px, pz)) continue;   // (gentle ground only: the 4 m grid misplaces things on hillsides)
    const band = dmath.sin(px * 0.045 + 1.3) * dmath.cos(pz * 0.052 - 0.4);
    out.push({ kind: band > 0.25 ? "grove" : band < -0.2 || k < 0.35 ? "rocks" : "palms", x: px, z: pz, y, yaw, s });
  }
  return out;
}

/** a planted palm: the 1.5 m foot collides (the veg area draws a curved / leaning trunk above it) + a no-shoot
 *  drop 1.2 m over the foot so its 0.44 m top is never a 'floor' (nothing drawn there) */
export function palmBoxes(x: number, y: number, z: number, s = 1): Box[] {
  // (the trunk's own width: a slimmer foot let side rays past it onto the drawn trunk = walk-through)
  const r = 0.22 * s;
  return [{ c: [x, y + 0.75, z], h: [r, 0.75, r], surf: "wood" }];
}
/** a sculpted town boulder (client town-lagoon addRock at y + 0.1 r): two stacked boxes that follow its
 *  rounded / flattened profile (a single box stands 0.3–0.7 m over the drawn top) */
export function rockBoxes(x: number, y: number, z: number, r: number, yaw = 0): Box[] {
  // (the drawn rock turns at random in the client: round footprints; three tiers measured against the parity tool:
  //  the crown stands ~0.8 r over the ground, the flanks ~0.3 r)
  const tier = (hw: number, top: number, k: number): Box => ({ c: [x, y + (top - 0.6 * r) / 2, z], h: [hw * r, (top + 0.6 * r) / 2, hw * r], yaw: yaw + k * Math.PI / 8, surf: "stone" });
  return [tier(0.92, 0.28 * r, 0), tier(0.68, 0.55 * r, 1), tier(0.42, 0.78 * r, 2)];
}

// ---------- TOWN PLANNING — streets as curved polylines, lots placed along them (varied frontage,
// depth, setback and gap; the house turned to face its street), a spatial index for gap / street clearance tests.
// Shared by the three towns' layouts (pure TS: the server and the client derive everything from the same numbers).
export interface TownStreet { name: string; kind: "main" | "side" | "alley"; w: number; pts: Vec2[] }
export interface TownPlace { kind: "plaza" | "landmark" | "yard" | "garden" | "court" | "alley"; name: string; x: number; z: number; poly?: Vec2[]; top?: number }
/** Catmull-Rom through the control points, sampled every ~`step` metres (open curve) */
export function splinePts(ctrl: Vec2[], step = 3): Vec2[] {
  if (ctrl.length < 3) return ctrl.slice();
  const out: Vec2[] = [];
  for (let i = 0; i < ctrl.length - 1; i++) {
    const p0 = ctrl[Math.max(0, i - 1)], p1 = ctrl[i], p2 = ctrl[i + 1], p3 = ctrl[Math.min(ctrl.length - 1, i + 2)];
    const n = Math.max(1, Math.ceil(dmath.hypot(p2[0] - p1[0], p2[1] - p1[1]) / step));
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(ctrl[ctrl.length - 1]);
  return out;
}
/** polyline arc lengths */
export function polyArc(pts: Vec2[]): number[] { const a = [0]; for (let i = 1; i < pts.length; i++) a.push(a[i - 1] + dmath.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])); return a; }
/** point + unit tangent at arc length s */
export function polyAt(pts: Vec2[], arc: number[], s: number): { p: Vec2; d: Vec2 } {
  let i = 1; while (i < pts.length - 1 && arc[i] < s) i++;
  const a = pts[i - 1], b = pts[i], L = arc[i] - arc[i - 1] || 1e-6, t = Math.max(0, Math.min(1, (s - arc[i - 1]) / L));
  return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], d: [(b[0] - a[0]) / L, (b[1] - a[1]) / L] };
}
const segDist2 = (x: number, z: number, a: Vec2, b: Vec2) => { const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz || 1e-9; const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2)); return dmath.hypot(x - a[0] - t * dx, z - a[1] - t * dz); };
/** footprint corners of a building (world) */
export function footprint(b: { x: number; z: number; yaw: number; w: number; d: number }, m = 0): Vec2[] {
  const c = dmath.cos(b.yaw), s = dmath.sin(b.yaw);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, e]) => { const lx = a * (b.w / 2 + m), lz = e * (b.d / 2 + m); return [b.x + lx * c + lz * s, b.z - lx * s + lz * c] as Vec2; });
}
function inPolyXZ(p: Vec2[], x: number, z: number) { let ins = false; for (let i = 0, j = p.length - 1; i < p.length; j = i++) { const [xi, zi] = p[i], [xj, zj] = p[j]; if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) ins = !ins; } return ins; }
const crossSeg = (a: Vec2, b: Vec2, c: Vec2, d: Vec2) => { const o = (p: Vec2, q: Vec2, r: Vec2) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])); return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b); };
/** clear distance between two convex polygons (0 = touching / overlapping) */
export function polyGap(P: Vec2[], Q: Vec2[]): number {
  for (let i = 0; i < P.length; i++) for (let j = 0; j < Q.length; j++) if (crossSeg(P[i], P[(i + 1) % P.length], Q[j], Q[(j + 1) % Q.length])) return 0;
  if (inPolyXZ(Q, P[0][0], P[0][1]) || inPolyXZ(P, Q[0][0], Q[0][1])) return 0;
  let m = Infinity;
  for (const p of P) for (let j = 0; j < Q.length; j++) m = Math.min(m, segDist2(p[0], p[1], Q[j], Q[(j + 1) % Q.length]));
  for (const q of Q) for (let i = 0; i < P.length; i++) m = Math.min(m, segDist2(q[0], q[1], P[i], P[(i + 1) % P.length]));
  return m;
}
/** a growing set of footprints + street segments with a 16 m spatial hash: gap and street-clearance queries */
export class TownSite {
  private G = 16; private fh = new Map<number, number[]>(); private sh = new Map<number, Array<[Vec2, Vec2, number, number]>>();
  readonly polys: Vec2[][] = [];
  readonly streets: TownStreet[] = [];
  // (a numeric cell key: the maps are only looked up, never iterated; a string key per cell visit cost ~0.15 s at import)
  private key(a: number, b: number) { return (a + 32768) * 65536 + (b + 32768); }
  private cells(x0: number, z0: number, x1: number, z1: number, f: (k: number) => void) { for (let a = Math.floor(x0 / this.G); a <= Math.floor(x1 / this.G); a++) for (let b = Math.floor(z0 / this.G); b <= Math.floor(z1 / this.G); b++) f(this.key(a, b)); }
  addStreet(s: TownStreet) {
    const i = this.streets.length; this.streets.push(s);
    for (let k = 1; k < s.pts.length; k++) { const a = s.pts[k - 1], b = s.pts[k], r = s.w / 2 + 2; this.cells(Math.min(a[0], b[0]) - r, Math.min(a[1], b[1]) - r, Math.max(a[0], b[0]) + r, Math.max(a[1], b[1]) + r, (q) => { (this.sh.get(q) ?? this.sh.set(q, []).get(q)!).push([a, b, s.w, i]); }); }
  }
  addPoly(p: Vec2[]): number {
    const i = this.polys.length; this.polys.push(p);
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity; for (const [x, z] of p) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
    this.cells(x0, z0, x1, z1, (q) => { (this.fh.get(q) ?? this.fh.set(q, []).get(q)!).push(i); });
    return i;
  }
  /** the smallest clear gap from polygon p to any stored footprint within `r` (Infinity if none) */
  gap(p: Vec2[], r = 30, skip = -1): number {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity; for (const [x, z] of p) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
    const seen = new Set<number>(); let m = Infinity;
    this.cells(x0 - r, z0 - r, x1 + r, z1 + r, (q) => { for (const i of this.fh.get(q) ?? []) { if (i === skip || seen.has(i)) continue; seen.add(i); m = Math.min(m, polyGap(p, this.polys[i])); } });
    return m;
  }
  /** clearance of polygon p from every street EDGE (negative = it stands on a carriageway); ignore street `skip` */
  streetClear(p: Vec2[], skip = -1): number {
    let m = Infinity;
    const pts: Vec2[] = [...p]; for (let k = 0; k < p.length; k++) { const a = p[k], b = p[(k + 1) % p.length]; for (const t of [0.25, 0.5, 0.75]) pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
    pts.push([pts.slice(0, p.length).reduce((s, q) => s + q[0], 0) / p.length, pts.slice(0, p.length).reduce((s, q) => s + q[1], 0) / p.length]);
    for (const [x, z] of pts) for (const [a, b, w, i] of this.sh.get(this.key(Math.floor(x / this.G), Math.floor(z / this.G))) ?? []) { if (i === skip) continue; m = Math.min(m, segDist2(x, z, a, b) - w / 2); }
    // a polygon spanning a street: test the street centrelines against the polygon edges
    for (let k = 0; k < p.length; k++) { const a = p[k], b = p[(k + 1) % p.length]; this.cells(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1]), (q) => { for (const [c, d, , i] of this.sh.get(q) ?? []) if (i !== skip && crossSeg(a, b, c, d)) m = -1; }); }
    return m;
  }
  /** distance from a point to the nearest street centreline (+ which) */
  nearestStreet(x: number, z: number, r = 48): { d: number; i: number; a: Vec2; b: Vec2 } | null {
    let best: { d: number; i: number; a: Vec2; b: Vec2 } | null = null;
    this.cells(x - r, z - r, x + r, z + r, (q) => { for (const [a, b, , i] of this.sh.get(q) ?? []) { const d = segDist2(x, z, a, b); if (!best || d < best.d) best = { d, i, a, b }; } });
    return best;
  }
}
