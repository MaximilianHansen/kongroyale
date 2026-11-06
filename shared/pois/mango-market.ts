// POI mango-market — the island's dense town centre. Deterministic layout (buildings, streets, plaza dressing) +
// colliders + clearings. Pure TS: the server imports this for collision, the client builds the visuals from the SAME
// LAYOUT (client/src/world/pois/mango-market).
//
// Composition is built around the view camera (CAM_BUILDING): a long market plaza near the NORTH edge of the town pad,
// seen from the flat roof of building "A" on its near (south-west) side, looking NNE along the plaza axis — fountain +
// gorilla statue centre, stall rows under striped canopies on the far side, yellow balcony house on the left, coral/red
// houses on the right, layered roofs stepping out toward the lagoon beyond the far row (upper-left) and the jungle
// ridge east of town (upper-right).
//
// Plaza frame: origin = fountain centre F, v axis = the camera's view heading (HEAD, toward the far side), u axis =
// right. Plaza floor u ∈ [-PU, PU], v ∈ [PV0, PV1]. Town fabric = dense blocks in the same frame: 5.5 m streets, 3 m
// alleys, every block filled with back-to-back rows (no lawns), each block turned a few degrees so streets bend, side
// walls windowed, cover (scooters, crate stacks, barrels, carts, planters) every 10–15 m along every street.
import type { Box } from "../world/colliders";
import { poiById } from "../world/map";
import { type TownBuilding, type BuildingParts, resolveBuilding, buildingColliders, simBoxes, mulberry, type Clearing, type RoofProp, ROOF_PROP_HALF, buildingRooms, townInteriors, townLootSpots, toWorld, type TownInteriorBake, coverScatter, gridH, type GroundGrid, palmBoxes, rockBoxes, type Vec2, type TownStreet, type TownPlace, TownSite, splinePts, polyArc, polyAt, footprint, hallMinW, HALL_MIN_D } from "./town-kit";
import type { InteriorRoom } from "./interior-kit";
import TOWN_INT from "./town-interiors.json";
import { fountainColliders } from "./town-fountain";
import SLOPE_H from "./mango-slope.json";
import * as dmath from "../sim/dmath";

const P = poiById("mango-market");
export const CX = P.x, CZ = P.z, Y = P.padY as number;
const DEG = Math.PI / 180;
/** view heading of the plaza axis: 35° east of north */
export const HEAD = 35 * DEG;
/** fountain centre (world) */
export const FX = 455, FZ = -55;
/** unit vectors of the plaza frame in world xz */
export const AXV: [number, number] = [dmath.sin(HEAD), -dmath.cos(HEAD)];
export const AXU: [number, number] = [dmath.cos(HEAD), dmath.sin(HEAD)];
export const PU = 13, PV0 = -27.5, PV1 = 24;
/** front wall of the view camera's building "A" (plaza frame v). A fronts the plaza DIRECTLY — no forecourt street (a
 *  camera looking down a street between C's and B's walls reads as an alley shot). C (left) and B (right) stand 1.5–4.5 m
 *  proud of A's front, their roofs the frame's bottom corners; the 4.5 m recess in front of A is below the frame's bottom edge. */
export const A_FRONT = -25.5;
/** plaza floor outline (plaza frame): the recess u -4.6..3.2 in front of the camera building, main plaza u -12..13 */
export const PLAZA_POLY: Array<[number, number]> = [[-4.6, A_FRONT], [3.2, A_FRONT], [3.2, -20], [13, -20], [13, 24], [-12, 24], [-12, -21.3], [-4.6, -21.3]];
/** fountain: outer radius of the basin wall, statue height (feet → raised bunch) — shared with town-fountain colliders.
 *  Sized as the hero landmark: ~10 % of the view's frame, and it must read from the plane and the map */
export const FOUNTAIN_R = 5.0, STATUE_H = 7.4;
/** plaza frame → world */
export const toW = (u: number, v: number): [number, number] => [FX + u * AXU[0] + v * AXV[0], FZ + u * AXU[1] + v * AXV[1]];
/** world → plaza frame */
export const toUV = (x: number, z: number): [number, number] => { const dx = x - FX, dz = z - FZ; return [dx * AXU[0] + dz * AXU[1], dx * AXV[0] + dz * AXV[1]]; };
/** world yaw for a direction given in the plaza frame */
export const yawUV = (du: number, dv: number) => { const x = du * AXU[0] + dv * AXV[0], z = du * AXU[1] + dv * AXV[1]; return dmath.atan2(x, z); };
/** the statue faces the camera (−v) */
export const STATUE_YAW = yawUV(0, -1);

export type PropKind = "stall" | "scooter" | "bench" | "planter" | "pot" | "lamp" | "crate" | "pcrate" | "cratestack" | "barrel" | "cart" | "sack" | "basket" | "table"
  | "palm" | "banana-plant" | "bush" | "monstera" | "fern" | "tank" | "rock" | "bin"
  /** yards: `s` = run length (local +x along it) */
  | "fence" | "hedge" | "gwall" | "tree" | "laundry"
  /** a raised street planter (1.1 m stone box, `s` long) — the streets' crouch-proof cover */
  | "splanter";
export interface Prop { kind: PropKind; x: number; z: number; yaw: number; y?: number; v?: number; s?: number; color?: string; fruit?: "mango" | "banana" | "mixed"; hero?: boolean }
export interface Line { kind: "lights" | "bunting"; a: [number, number, number]; b: [number, number, number]; sag: number }
/** a stone foundation under a slope house (plaza frame rect → world box), from y0 up to y1 */
export interface Plinth { x: number; z: number; yaw: number; w: number; d: number; y0: number; y1: number }
export interface MarketLayout { buildings: TownBuilding[]; parts: BuildingParts[]; props: Prop[]; lines: Line[]; ids: Record<string, number>; blocks: Array<[number, number, number, number]>; ring: number; plinths: Plinth[];
  /** the street network (world polylines, widths) and the named places (squares, landmarks, court, gardens) */
  streets: TownStreet[]; places: TownPlace[]; squares: Vec2[][] }

const WALLS = ["#f2c132", "#e2563f", "#3fb8b0", "#ee8a2d", "#4f9fd6", "#e88ca0", "#c4d24a", "#f5e2b8", "#7fc8c0", "#f0a24a", "#d94f6a", "#5bb3e0", "#e8b53a", "#d9573e"];
const ROOFS = ["#b8432f", "#2f8f86", "#8e5a3a", "#b7bcc0", "#3a6fa8", "#c9553d", "#a0522d", "#3f8f6a"];
const TRIMS = ["#f6efe0", "#fbf3e2", "#f2e8d0", "#f6efe0"];
const SHUT = ["#2f4a3a", "#284b6b", "#5a3a2a", "#3b6a5a", "#7a3a30", "#3a3f44"];
const DOORS = ["#6b4a2b", "#8a3a2a", "#2f5f7a", "#3f6a4a", "#5a3a2a"];
const SIGNS = ["BANANA CO.", "BANANA CO.", "CNVS.DEV"];
const TANKS: Record<string, string> = { blue: "#2f4f8f", teal: "#2c8a80", olive: "#5e7a3a" };

/** the flat town ground (terrain at padY), measured in the plaza frame: flat from v −160 up to
 *  VMAX(u), where the ground starts falling toward the NE lagoon */
const VMAX: Array<[number, number]> = [[-112, 20], [-100, 30], [-90, 40], [-80, 42], [-70, 50], [-60, 52], [-50, 60], [-40, 62], [-30, 60], [-20, 62], [-10, 70], [0, 72], [60, 72], [70, 70], [80, 62], [90, 60], [100, 42], [110, 30]];
function vmax(u: number) { for (let i = 1; i < VMAX.length; i++) if (u <= VMAX[i][0]) { const [u0, v0] = VMAX[i - 1], [u1, v1] = VMAX[i]; return v0 + (v1 - v0) * (u - u0) / (u1 - u0); } return 20; }
/** is a world point on the flat town ground (the pad circle, short of the north slope)? */
export function townFlat(x: number, z: number, m = 0): boolean { const [u, v] = toUV(x, z); return dmath.hypot(x - CX, z - CZ) < P.pad - 4 - m && v < vmax(u) - 1 - m; }
/** does a world point sit on the flat town pad? */
function onPad(x: number, z: number, margin = 0) { const [u, v] = toUV(x, z); return Math.abs(u) < 110 - margin && v > -160 + margin && v < vmax(u) - margin; }

/** baked terrain height on the north slope (mango-slope.json), plaza-frame coords */
export function slopeH(u: number, v: number): number {
  const S = SLOPE_H as { u0: number; v0: number; step: number; nu: number; nv: number; h: number[] };
  const fi = Math.max(0, Math.min(S.nu - 1.001, (u - S.u0) / S.step)), fj = Math.max(0, Math.min(S.nv - 1.001, (v - S.v0) / S.step));
  const i = Math.floor(fi), j = Math.floor(fj), a = fi - i, b = fj - j, H = (ii: number, jj: number) => S.h[jj * S.nu + ii];
  return (H(i, j) * (1 - a) + H(i + 1, j) * a) * (1 - b) + (H(i, j + 1) * (1 - a) + H(i + 1, j + 1) * a) * b;
}
/** rooftop clutter for a flat roof (local roof coords), clear of the stair bulkhead (back-left corner) */
function roofClutter(w: number, d: number, rng: () => number, o: { tank?: string | null; ac?: boolean } = {}): RoofProp[] {
  const out: RoofProp[] = [];
  const free = (x: number, z: number, r: number) => !(x < -w / 2 + 5 && z < -d / 2 + 2.4) && Math.abs(x) < w / 2 - r - 0.35 && Math.abs(z) < d / 2 - r - 0.35 && out.every((p) => dmath.hypot(p.x - x, p.z - z) > r + ROOF_PROP_HALF[p.kind][0] * (p.s ?? 1) + 0.35);
  const tryPut = (kind: RoofProp["kind"], color?: string, s = 1) => {
    const r = ROOF_PROP_HALF[kind][0] * s;
    for (let k = 0; k < 12; k++) {
      const x = (rng() - 0.5) * (w - 2 * r - 0.8), z = (rng() - 0.3) * (d - 2 * r - 0.8) * 0.9;
      if (free(x, z, r)) { out.push({ kind, x, z, yaw: rng() * 6.28, color, s }); return; }
    }
  };
  if (o.tank !== null) {
    const t = o.tank ?? (rng() < 0.08 ? "tower" : rng() < 0.22 ? "stand" : rng() < 0.4 ? "steel" : "plastic");
    tryPut(t === "tower" || t === "stand" || t === "steel" ? t as RoofProp["kind"] : "plastic", t === "stand" ? "#5e7a3a" : TANKS[["blue", "blue", "blue", "teal", "olive"][Math.floor(rng() * 5)]]);
    // the roofscape bristles with tanks — a second one on most roofs
    if (rng() < 0.6 && w > 6) tryPut(rng() < 0.25 ? "steel" : "plastic", TANKS[["blue", "blue", "teal", "olive"][Math.floor(rng() * 4)]], 0.8 + rng() * 0.2);
  }
  if (o.ac ?? rng() < 0.55) tryPut("ac");
  if (rng() < 0.7) tryPut("planter", undefined, 1 + rng() * 0.3);
  if (rng() < 0.35) tryPut("crates");
  if (rng() < 0.3) tryPut("planter");
  return out;
}

function genLayout(): MarketLayout {
  const rng = mulberry(4212);
  const pick = <T>(arr: T[]): T => arr[Math.floor(rng() * arr.length)];
  const buildings: TownBuilding[] = [];
  const props: Prop[] = [];
  const lines: Line[] = [];
  const ids: Record<string, number> = {};
  let lastWall = "";
  const wallColor = () => { let c = pick(WALLS); while (c === lastWall) c = pick(WALLS); lastWall = c; return c; };

  /** building occupying the plaza-frame rect [u0,u1]×[v0,v1] with its front facing (fu,fv) (a unit axis); `turn` rotates
   *  it (and its position) about the pivot (pu, pv) — blocks are turned a few degrees so the streets bend */
  const place = (u0: number, u1: number, v0: number, v1: number, fu: number, fv: number, spec: Partial<TownBuilding> = {}, id?: string, turn = 0, pu = 0, pv = 0): TownBuilding => {
    let cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
    if (turn) { const c = dmath.cos(turn), s = dmath.sin(turn), du = cu - pu, dv = cv - pv; cu = pu + du * c - dv * s; cv = pv + du * s + dv * c; }
    const [x, z] = toW(cu, cv);
    const alongU = fv !== 0; // front faces ±v → width runs along u
    const w = alongU ? u1 - u0 : v1 - v0, d = alongU ? v1 - v0 : u1 - u0;
    const floors = spec.floors ?? (rng() < 0.12 ? 1 : rng() < 0.7 ? 2 : 3);
    const flat = spec.roof ? spec.roof === "flat" : rng() < 0.6;
    const b: TownBuilding = {
      x, z, y: Y, yaw: yawUV(fu, fv) + turn, w, d, floors, floorH: 3.3, wall: wallColor(), trim: pick(TRIMS), shutter: pick(SHUT), door: pick(DOORS),
      roof: flat ? "flat" : "gable", roofColor: pick(ROOFS), roofAxis: w >= d ? "x" : "z", overhang: 0.55, roofPitch: 0.42 + rng() * 0.2,
      balcony: floors > 1 && rng() < 0.5, awning: rng() < 0.62 ? (rng() < 0.5 ? "tin" : "stripe") : null, awningColor: pick(ROOFS), stripe: Math.floor(rng() * 6),
      awningPosts: rng() < 0.35,
      tank: null, ac: false, sign: rng() < 0.14 ? pick(SIGNS) : null, shop: rng() < 0.35,
      // (EVERY flat roof has its stair house — without one it is glider-only)
      roofAccess: (rng(), flat), seed: Math.floor(rng() * 1e9), material: "plaster", shutters: pick(["closed", "mixed", "mixed", "open"] as const), flowers: 0.2 + rng() * 0.4,
      windowPitch: 2.8,
      ...spec,
    };
    // a house that cannot hold a stair hall (town-kit hallMinW / HALL_MIN_D) is single-storey with a pitched
    // (walkable) roof
    if ((b.floors > 1 || b.roof === "flat") && !(Math.max(b.w, b.d) >= hallMinW(b.floorH ?? 3.2) && Math.min(b.w, b.d) >= HALL_MIN_D)) { b.floors = 1; b.roof = "gable"; b.roofAccess = false; b.balcony = false; }
    // (the fabric's multi-storey houses get flat roofs with a stair house — a 2–3 storey tin gable is a roof no
    //  stair or jump reaches; the hand-authored ring keeps its gables, each beside a taller or equal flat roof)
    else if (!spec.roof && b.floors > 1 && b.roof !== "flat") { b.roof = "flat"; b.roofAccess = true; }
    b.interior = true;
    if (b.roof === "flat" && !spec.roofProps) b.roofProps = roofClutter(b.w, b.d, rng);
    if (spec.wall) lastWall = spec.wall;
    if (id) ids[id] = buildings.length;
    buildings.push(b);
    return b;
  };

  /** a building at a world centre / yaw (the street plan) with the same defaults as `place`; a multi-storey house
   *  (or a flat roof with access) that cannot hold a stair hall becomes a one-storey gable */
  const mk = (x: number, z: number, yaw: number, w: number, d: number, spec: Partial<TownBuilding> = {}, id?: string): TownBuilding | null => {
    const floors = spec.floors ?? 2;
    const flat = spec.roof ? spec.roof === "flat" : rng() < 0.5;
    const b: TownBuilding = {
      x, z, y: Y, yaw, w, d, floors, floorH: 3.2, wall: wallColor(), trim: pick(TRIMS), shutter: pick(SHUT), door: pick(DOORS),
      roof: flat ? "flat" : "gable", roofColor: pick(ROOFS), roofAxis: w >= d ? "x" : "z", overhang: 0.55, roofPitch: 0.42 + rng() * 0.2,
      balcony: floors > 1 && rng() < 0.5, awning: rng() < 0.55 ? (rng() < 0.5 ? "tin" : "stripe") : null, awningColor: pick(ROOFS), stripe: Math.floor(rng() * 6),
      awningPosts: rng() < 0.35, tank: null, ac: false, sign: rng() < 0.12 ? pick(SIGNS) : null, shop: false, roofAccess: flat, seed: Math.floor(rng() * 1e9),
      material: "plaster", shutters: pick(["closed", "mixed", "mixed", "open"] as const), flowers: 0.2 + rng() * 0.4, windowPitch: 2.8,
      ...spec,
    };
    if (b.roof !== "flat") b.roofAccess = false;
    else if (spec.roofAccess === undefined) b.roofAccess = true;
    const fh = b.floorH ?? 3.2, long = Math.max(b.w, b.d), short = Math.min(b.w, b.d);
    if ((b.floors > 1 || b.roofAccess) && !(long >= hallMinW(fh, b.t ?? 0.3) && short >= HALL_MIN_D)) { b.floors = 1; if (b.roof === "flat") b.roof = "gable"; b.roofAccess = false; b.balcony = false; }
    if (b.floors < 2) b.balcony = false;
    b.interior = b.interior ?? true;
    if (b.roof === "flat" && !spec.roofProps) b.roofProps = roofClutter(b.w, b.d, rng);
    if (spec.wall) lastWall = spec.wall;
    if (id) ids[id] = buildings.length;
    buildings.push(b);
    return b;
  };

  // ======================= PLAZA RING (hand-authored) =======================
  // Near side = the camera side: A (camera roof) with C (left, teal tank) and B (right, protruding,
  // blank yellow side wall with pipes, olive tank on a timber stand). A forecourt (u -8..3) leads into the main plaza.
  // (A is 2 storeys — its roof level with C's and B's, so the view camera on A's front parapet looks
  // across their roofs)
  // (no roof stair house on A — at 7.8 m wide its stair hall runs along a SIDE wall and the 2.6 m stair house
  //  would stand right in front of the view camera)
  place(-4.6, 3.2, A_FRONT - 11, A_FRONT, 0, 1, { floors: 2, floorH: 3.1, roof: "flat", wall: "#ee8a2d", trim: "#f6efe0", balcony: false, awning: "tin", awningColor: "#2f8f86", awningPosts: false, parapetH: 0.3, roofAccess: false, sign: null, shop: true, roofProps: [] }, "A");
  // C: the yellow house on the left — fronts the plaza beside A (front +v, 2.5 m proud of A's), teal tin awning on posts
  // over a banana stall, wooden balcony with flower pots, teal ribbed tank on its front roof corner next to the camera
  // (the frame's bottom-left)
  place(-14.6, -4.6, -35.2, -23.0, 0, 1, { floors: 2, floorH: 3.0, roof: "flat", wall: "#f0b23a", trim: "#f6efe0", shutter: "#3a3f44", balcony: true, awning: "tin", awningColor: "#2f8f86", awningPosts: true, parapetH: 0.45, roofAccess: true, sign: null, shop: true, flowers: 1, shutters: "closed",
    roofProps: [{ kind: "plastic", x: -3.9, z: 5.0, color: "#2c8a80", s: 1.1 }, { kind: "crates", x: 1.2, z: 4.6 }, { kind: "ac", x: 2.6, z: -3.4 }, { kind: "planter", x: 3.6, z: 4.8, s: 1.0 }] }, "C");
  // B: the right-hand neighbour — yellow, blank pipe wall toward the forecourt, red tin pent, olive tank on a
  // timber stand at its forecourt edge (the frame's right third)
  place(3.2, 12.6, -34, -20, 0, 1, { floors: 2, floorH: 3.1, roof: "flat", wall: "#f2c132", trim: "#f6efe0", balcony: true, awning: "stripe", stripe: 0, parapetH: 0.5, roofAccess: true, sign: "BANANA CO.", shop: true, blind: [1], pent: "#c2452f",
    roofProps: [{ kind: "stand", x: 2.9, z: 5.2, color: "#5e7a3a", s: 1.3 }, { kind: "ac", x: -3.2, z: -3.4 }, { kind: "plastic", x: -2.6, z: 1.6, color: "#2f4f8f" }] }, "B");
  // (every ring gap is 0 (party wall) or a real street — 0.4–1.0 m slots between the ring houses are stuck spots)
  place(12.6, 22, -31, -21.6, 0, 1, { floors: 2, roof: "gable", wall: "#7fc8c0", roofColor: "#b8432f", balcony: false, awning: "tin", awningColor: "#b8432f" });
  // behind C / B (beside the camera building): back-street houses so kong-eye views never see a gap
  place(-24.2, -14.6, -47.2, -35.2, -1, 0, { floors: 2, roof: "gable", awning: null });
  place(-14.6, -4.6, -47.2, -35.2, 1, 0, { floors: 2, roof: "flat", awning: null });
  place(3.2, 12.6, -47.2, -34, 0, -1, { floors: 2, roof: "flat", awning: null });
  place(12.6, 24.2, -47.2, -31, 0, -1, { floors: 2, roof: "gable", awning: null });
  // left side (fronts face +u)
  place(-21, -12, -15.5, -3.6, 1, 0, { floors: 2, roof: "gable", roofColor: "#2f8f86", roofPitch: 0.5, wall: "#eab33c", trim: "#f6efe0", shutter: "#3a3f44", balcony: true, awning: "tin", awningColor: "#2f8f86", awningPosts: true, shop: true, flowers: 0.9, shutters: "closed" }, "D1");
  place(-21, -12, -3.6, 6, 1, 0, { floors: 2, roof: "flat", wall: "#e2563f", trim: "#fbf3e2", balcony: true, awning: "stripe", stripe: 0, shop: true, flowers: 0.6 }, "D2");
  place(-21, -12, 10.6, 17, 1, 0, { floors: 3, roof: "flat", wall: "#3fb8b0", trim: "#f6efe0", balcony: true, awning: "stripe", stripe: 2, shop: true, sign: "BANANA CO." });
  place(-21, -12, 17, 24, 1, 0, { floors: 2, roof: "gable", wall: "#f0a24a", roofColor: "#c9553d", awning: "tin", awningColor: "#b8432f", shop: true });
  // far side (fronts face -v); the far-left street runs at u ∈ [-12, -6.2]
  place(-6.2, 1.9, 24, 33, 0, -1, { floors: 2, roof: "gable", roofColor: "#c9553d", wall: "#4f9fd6", awning: "stripe", stripe: 3, shop: true, balcony: true });
  place(1.9, 9.3, 24, 33.5, 0, -1, { floors: 3, roof: "flat", wall: "#ee8a2d", awning: "tin", awningColor: "#2f8f86", shop: true, balcony: true, roofProps: [{ kind: "tower", x: 1.5, z: -1.2 }, { kind: "ac", x: -2, z: 2.6 }] });
  // (a 0.4 m parapet — the lime gable beside it is reached by stepping over it; at 0.6 m it is jump-only)
  place(9.3, 16.3, 24, 32.5, 0, -1, { floors: 2, roof: "flat", wall: "#e88ca0", awning: "stripe", stripe: 1, shop: true, parapetH: 0.4 });
  place(16.3, 22, 24, 33, 0, -1, { floors: 2, roof: "gable", wall: "#c4d24a", roofColor: "#b8432f", awning: "tin", awningColor: "#3a6fa8", shop: true });
  // right side (fronts face -u); a street leaves the plaza at v ∈ [4, 10]
  place(13, 22, -15.6, -5.4, -1, 0, { floors: 2, roof: "flat", wall: "#d9573e", trim: "#f6efe0", balcony: true, awning: "tin", awningColor: "#2f8f86", shop: true, flowers: 0.9 }, "F1");
  place(13, 22, -5.4, 4, -1, 0, { floors: 2, roof: "gable", wall: "#f2c132", roofColor: "#b8432f", awning: "stripe", stripe: 5, shop: true, balcony: true });
  place(13, 22, 10, 17, -1, 0, { floors: 3, roof: "flat", wall: "#7fc8c0", awning: "tin", awningColor: "#b8432f", shop: true, ac: true });
  place(13, 22, 17, 24, -1, 0, { floors: 2, roof: "gable", roofColor: "#2f8f86", wall: "#f0a24a", awning: "stripe", stripe: 0, shop: true, balcony: true });
  const ringCount = buildings.length;

  // ======================= THE TOWN PLAN — a street hierarchy, not a grid =======================
  // Curved MAIN streets radiating from the market plaza (Market Street west, Harbour Road east, Banana Avenue south to a second square with
  // the town's lookout tower + market hall, a ring road round the east and south), SIDE streets between them, ALLEYS as
  // shortcuts; lots placed along every street side with their own frontage, depth, setback and gap (a dense shop-house
  // core near the plaza, detached houses with yards further out, villas / warehouses at the edge), every house turned to
  // face its (curving) street; yards fenced / hedged / walled and planted. Declared as STREETS / PLACES.
  const PADC: [number, number] = toUV(CX, CZ);
  /** flat pad (plaza frame): inside the pad circle and short of the north slope */
  const flatUV = (u: number, v: number, m = 0) => dmath.hypot(u - PADC[0], v - PADC[1]) < P.pad - 4 - m && v < vmax(u) - 1 - m;
  const site = new TownSite();
  const W2 = (pts: Array<[number, number]>): Vec2[] => pts.map(([u, v]) => toW(u, v));
  const street = (name: string, kind: TownStreet["kind"], w: number, ctrl: Array<[number, number]>) => { const s: TownStreet = { name, kind, w, pts: splinePts(W2(ctrl), 3) }; site.addStreet(s); return s; };
  // reserved open ground (plaza frame polygons): the market plaza + ring, the second square, the court, the gardens
  const SQ: [number, number] = [20, -97];
  const reserved: Vec2[][] = [];
  const reserveUV = (pts: Array<[number, number]>) => { const p = W2(pts); reserved.push(p); return p; };
  reserveUV([[-25.5, -48], [25.5, -48], [25.5, 34.5], [-25.5, 34.5]]);
  const squarePoly = reserveUV([[SQ[0] - 19, SQ[1] - 8], [SQ[0] - 8, SQ[1] - 18], [SQ[0] + 12, SQ[1] - 15], [SQ[0] + 19, SQ[1] + 2], [SQ[0] + 9, SQ[1] + 16], [SQ[0] - 12, SQ[1] + 13]]);
  const courtUV: [number, number] = [-24, -110];
  const courtPoly = reserveUV([[courtUV[0] - 12, courtUV[1] - 9], [courtUV[0] + 12, courtUV[1] - 9], [courtUV[0] + 12, courtUV[1] + 9], [courtUV[0] - 12, courtUV[1] + 9]]);
  const orchardUV: [number, number] = [86, -106];
  const orchardPoly = reserveUV([[orchardUV[0] - 14, orchardUV[1] - 10], [orchardUV[0] + 10, orchardUV[1] - 14], [orchardUV[0] + 15, orchardUV[1] + 8], [orchardUV[0] - 8, orchardUV[1] + 13]]);
  for (const p of reserved) site.addPoly(p);
  const nRes = reserved.length;
  // the network (plaza frame control points → world splines)
  street("Market Street", "main", 9, [[-21.5, 8.3], [-40, 9], [-62, 6], [-82, -2], [-97, -13]]);
  street("Harbour Road", "main", 9, [[22.5, 7], [44, 10], [66, 18], [84, 26], [96, 34]]);
  street("Banana Avenue", "main", 10, [[-0.6, -47.6], [0, -60], [5, -74], [12, -84]]);
  street("Banana Avenue south", "main", 9, [[28, -110], [33, -126], [36, -146], [34, -172], [28, -205]]);
  street("Ring Road", "main", 9, [[80, 24], [98, 2], [111, -28], [116, -64], [111, -100], [95, -132], [69, -157], [37, -170], [4, -168], [-26, -156], [-50, -134], [-64, -104], [-70, -72], [-68, -40], [-62, -16], [-60, 6.5]]);
  street("Back Street", "side", 6, [[-66, -31], [-42, -45], [-20, -53], [-0.6, -55.5], [22, -53], [44, -45], [68, -34], [92, -25], [110, -24]]);
  street("Church Lane", "side", 6, [[-69, -74], [-46, -82], [-22, -89], [2, -93]]);
  street("Orchard Lane", "side", 6, [[39, -90], [62, -84], [88, -76], [115, -70]]);
  street("Well Street", "side", 6, [[-46, -82], [-44, -106], [-30, -128], [-4, -142], [35, -143]]);
  street("Mill Street", "side", 6, [[88, -76], [90, -100], [84, -124], [72, -150]]);
  street("Lagoon Lane", "side", 6, [[-9, 34], [-12, 46], [-28, 51], [-42, 44]]);
  street("Mango Row", "side", 6, [[-12, 46], [10, 52], [32, 52], [54, 46], [70, 34], [80, 24]]);
  street("Old Lane", "side", 6, [[-21.5, -19], [-36, -21], [-50, -20], [-64, -17]]);
  street("Spice Lane", "side", 6, [[22.5, -18.6], [38, -22], [56, -17], [78, -8], [101, -4]]);
  street("Steps Alley", "alley", 3.2, [[-36, -20], [-39, -33], [-42, -45]]);
  street("Fig Alley", "alley", 3.2, [[38, -22], [42, -34], [44, -45]]);
  street("Lantern Alley", "alley", 3.2, [[-40, 9], [-42, 26], [-42, 44]]);
  street("Cooper Alley", "alley", 3.2, [[62, -84], [64, -110], [58, -140], [36, -146]]);
  // ---- the second square's hero buildings: the LOOKOUT TOWER (5 storeys + roof terrace: the landmark seen from the
  // plane and across town) and the MARKET HALL (one tall storey under a big gable)
  {
    const [tx, tz] = toW(SQ[0] + 15, SQ[1] + 16), [hx, hz] = toW(SQ[0] - 17, SQ[1] - 22);
    const ty = yawUV(-0.6, -0.8), hy = yawUV(0, 1);
    const tw = mk(tx, tz, ty, 9.2, 9.2, { use: "tower", floors: 6, floorH: 3.2, roof: "flat", roofAccess: true, shop: false, balcony: true, awning: null, wall: "#f6efe0", trim: "#c9553d", shutter: "#2f8f86", parapetH: 1.1, sign: "BANANA CO.", roofProps: [{ kind: "tower", x: 2.3, z: 2.3, s: 1.15 }] }, "TOWER");
    if (tw) site.addPoly(footprint(tw));
    const mh = mk(hx, hz, hy, 22, 12.5, { use: "market-hall", floors: 1, floorH: 5.2, roof: "gable", roofAxis: "x", roofPitch: 0.5, shop: true, balcony: false, awning: "stripe", stripe: 2, wall: "#e2563f", trim: "#f6efe0", material: "stone", sign: "BANANA CO." }, "HALL");
    if (mh) site.addPoly(footprint(mh));
  }
  // ---- lots along every street side
  type Zone = "core" | "mid" | "outer";
  const zoneOf = (u: number, v: number): Zone => { const d = dmath.hypot(u, v * (v < 0 ? 0.8 : 1)); return d < 72 ? "core" : d < 118 ? "mid" : "outer"; };
  const R = (a: number, b: number) => a + (b - a) * rng();
  const ZP: Record<Zone, { fw: [number, number]; d: [number, number]; sb: [number, number]; gap: [number, number] }> = {
    core: { fw: [11, 17], d: [11, 15], sb: [0.6, 2.8], gap: [4.5, 9.0] },
    mid: { fw: [11, 17.5], d: [10.5, 14.5], sb: [1.5, 4.5], gap: [10.4, 13.5] },
    outer: { fw: [12, 19], d: [10.5, 15], sb: [2.0, 6.0], gap: [10.6, 15] },
  };
  /** a building spec for a zone / lot (types: shop-house, townhouse, house, villa, bungalow, warehouse) */
  const specFor = (zone: Zone, w: number, d: number, onMain: boolean): Partial<TownBuilding> => {
    const k = rng();
    if (zone === "core") {
      const floors = k < 0.15 ? 2 : k < 0.6 ? 3 : k < 0.93 ? 4 : 5;
      return { use: onMain || rng() < 0.45 ? "shop-house" : "townhouse", floors, roof: rng() < 0.62 ? "flat" : "gable", shop: onMain ? rng() < 0.8 : rng() < 0.35, balcony: rng() < 0.6, floorH: 3.3 };
    }
    if (zone === "mid") {
      if (w > 13 && d > 11 && rng() < 0.3) return { use: "warehouse", floors: 2, roof: "gable", material: "stone", shop: false, balcony: false, awning: null, floorH: 3.6, roofPitch: 0.36 };
      // (4-storey flat boxes read as apartment blocks from the plane — houses are mostly 2–3 storeys under
      //  pitched tin / terracotta roofs)
      const floors = k < 0.42 ? 2 : k < 0.88 ? 3 : 4;
      return { use: "house", floors, roof: rng() < 0.68 ? "gable" : "flat", shop: onMain && rng() < 0.3, balcony: rng() < 0.5, roofPitch: 0.45 + rng() * 0.25 };
    }
    if (w > 13.5 && rng() < 0.45) return { use: "villa", floors: rng() < 0.6 ? 2 : 3, roof: rng() < 0.6 ? "gable" : "flat", shop: false, balcony: true, material: rng() < 0.3 ? "stone" : "plaster" };
    const floors = k < 0.08 ? 1 : k < 0.72 ? 2 : 3;
    return { use: floors === 1 ? "bungalow" : "house", floors, roof: rng() < 0.78 ? "gable" : rng() < 0.5 ? "shed" : "flat", shop: false, balcony: rng() < 0.35, material: rng() < 0.18 ? "clapboard" : "plaster", roofPitch: 0.45 + rng() * 0.3 };
  };
  const lots: Array<{ bi: number; street: number; zone: Zone; sb: number; side: -1 | 1 }> = [];
  /** try a building rect (world centre, yaw, w along the street, d deep); returns its index or −1 */
  let lastPoly = -1;
  const tryPlace = (x: number, z: number, yaw: number, w: number, d: number, gapMin: number, spec: Partial<TownBuilding>, own: number, attachTo = -1): number => {
    const poly = footprint({ x, z, yaw, w, d });
    for (const [px, pz] of [...poly, [x, z] as Vec2]) { const [u, v] = toUV(px, pz); if (!flatUV(u, v)) return -1; }
    if (site.gap(poly, gapMin + 2, attachTo) < gapMin) return -1;
    if (site.streetClear(poly, -1) < (own >= 0 ? 0.55 : 1.2)) return -1;
    const b = mk(x, z, yaw, w, d, spec);
    if (!b) return -1;
    lastPoly = site.addPoly(footprint(b));
    return buildings.length - 1;
  };
  for (let si = 0; si < site.streets.length; si++) {
    const st = site.streets[si];
    if (st.kind === "alley") continue;
    const arc = polyArc(st.pts), L = arc[arc.length - 1];
    for (const side of [-1, 1] as const) {
      let s = 5 + rng() * 4, lastSb = -9;
      while (s < L - 5) {
        const at0 = polyAt(st.pts, arc, s), [u0, v0] = toUV(at0.p[0], at0.p[1]), zone = zoneOf(u0, v0), Z = ZP[zone];
        // the CORE: terrace runs of 2–4 attached shop-houses on one straight line (party walls, a stepped roofline: each
        // its own width / depth / storeys / colour), then an alley — the market quarter's dense street wall
        if (zone === "core") {
          const k = 2 + Math.floor(rng() * 3), ws = Array.from({ length: k }, () => R(7.6, 11.5)), runL = ws.reduce((a, b) => a + b, 0);
          const pa = polyAt(st.pts, arc, s), pb = polyAt(st.pts, arc, Math.min(L - 1, s + runL));
          let dt = Math.abs(dmath.atan2(pb.d[1], pb.d[0]) - dmath.atan2(pa.d[1], pa.d[0])); if (dt > Math.PI) dt = 2 * Math.PI - dt;
          if (s + runL < L - 4 && dt < 9 * DEG) {
            const cl = dmath.hypot(pb.p[0] - pa.p[0], pb.p[1] - pa.p[1]) || 1, dir: Vec2 = [(pb.p[0] - pa.p[0]) / cl, (pb.p[1] - pa.p[1]) / cl];
            const n: Vec2 = [-dir[1] * side, dir[0] * side], yaw = dmath.atan2(-n[0], -n[1]);
            const sb = rng() < 0.5 ? R(0.4, 1.4) : R(2.2, 4.0), dBase = R(10, 13.5);
            let along = 0, prev = -1, placed = 0;
            for (let j = 0; j < k; j++) {
              const w = ws[j], d = dBase + R(-1, 1.2), off = st.w / 2 + sb + d / 2;
              const bi = tryPlace(pa.p[0] + dir[0] * (along + w / 2) + n[0] * off, pa.p[1] + dir[1] * (along + w / 2) + n[1] * off, yaw, w, d, Z.gap[0], { ...specFor("core", w, d, st.kind === "main"), use: j === 0 && rng() < 0.5 ? "shop-house" : "townhouse" }, si, prev);
              if (bi < 0) break;
              lots.push({ bi, street: si, zone, sb, side }); prev = lastPoly; placed++; along += w;
            }
            if (placed) { s += along + R(3.2, 5.5); continue; }
          }
        }
        let fw = R(Z.fw[0], Z.fw[1]), dd = R(Z.d[0], Z.d[1]);
        // (setbacks vary along a street: a third of the houses sit back behind a front garden)
        // (never two neighbours on one building line: the setback swings between a shallow front (shop / stoop) and a front
        //  garden, with a random amplitude — a street of equal setbacks is the "calculated" look)
        const deep = lastSb < (zone === "core" ? 1.8 : 3.6);
        const sb = zone === "core" ? (deep ? R(2.4, 3.8) : R(0.4, 1.3)) : (deep ? R(4.8, 8.5) : R(0.7, 2.6));
        const mid = polyAt(st.pts, arc, Math.min(L - 1, s + fw / 2));
        const n: Vec2 = [-mid.d[1] * side, mid.d[0] * side];
        // the front faces the street: local +z = −n
        const yaw = dmath.atan2(-n[0], -n[1]) + (rng() - 0.5) * 6 * DEG;
        const off = st.w / 2 + sb + dd / 2;
        const spec = specFor(zone, fw, dd, st.kind === "main");
        let bi = -1;
        // (big lots first: a failed lot shrinks once, then the cursor moves on — a shrink loop filled the town with
        //  8 m boxes; small houses come last, in the infill)
        for (let tries = 0; tries < 2 && bi < 0; tries++) {
          const off2 = st.w / 2 + sb + dd / 2;
          bi = tryPlace(mid.p[0] + n[0] * off2, mid.p[1] + n[1] * off2, yaw, fw, dd, Z.gap[0], spec, si);
          if (bi < 0) { fw = Math.max(Z.fw[0], fw * 0.9); dd = Math.max(Z.d[0], dd * 0.88); }
        }
        void off;
        if (bi >= 0) { lots.push({ bi, street: si, zone, sb, side }); s += buildings[bi].w + R(Z.gap[0], Z.gap[1]); lastSb = sb; }
        else s += 2.5;
      }
    }
  }
  // ---- infill: detached houses on the deep ground between streets, each facing its nearest street (a path to it)
  {
    const cands: Array<[number, number]> = [];
    for (let u = -120; u <= 165; u += 5) for (let v = -215; v <= 60; v += 5) cands.push([u + (rng() - 0.5) * 3, v + (rng() - 0.5) * 3]);
    // nearest-to-a-street first (front rows before back lots)
    const key = cands.map(([u, v]) => { const [x, z] = toW(u, v), ns = site.nearestStreet(x, z, 48); return (ns ? ns.d : 99) + rng() * 4; });
    const order = cands.map((_, i) => i).sort((a, b) => key[a] - key[b]);
    for (const ci of order) {
      const [u, v] = cands[ci];
      if (!flatUV(u, v, 5)) continue;
      const [x, z] = toW(u, v), ns = site.nearestStreet(x, z, 48);
      if (!ns || ns.d < 7 || ns.d > 44) continue;
      const zone = zoneOf(u, v), zz: Zone = zone === "core" ? "mid" : zone, Z = ZP[zz];
      const dx = ns.b[0] - ns.a[0], dz = ns.b[1] - ns.a[1], l = dmath.hypot(dx, dz) || 1;
      const cx = (ns.a[0] + ns.b[0]) / 2 - x, cz = (ns.a[1] + ns.b[1]) / 2 - z;
      let nx = -dz / l, nz = dx / l; if (nx * cx + nz * cz < 0) { nx = -nx; nz = -nz; }
      const yaw = dmath.atan2(nx, nz) + (rng() - 0.5) * 16 * DEG;
      let w = R(Z.fw[0], Z.fw[1]), d = R(Z.d[0], Z.d[1]), bi = -1;
      const spec = specFor(zz, w, d, false);
      for (let t = 0; t < 4 && bi < 0; t++) { bi = tryPlace(x, z, yaw, w, d, Z.gap[0], spec, -1); w = Math.max(9, w * 0.88); d = Math.max(8.6, d * 0.9); }
      if (bi >= 0) lots.push({ bi, street: ns.i, zone, sb: ns.d - d / 2, side: 1 });
    }
  }
  // ======================= NORTH SLOPE: low houses stepping down toward the lagoon (spaced, turned to the contour) =====
  const plinths: Plinth[] = [];
  for (const [r0, r1] of [[75, 84], [95, 104]] as Array<[number, number]>) {
    let u = -104 + rng() * 10 + (r0 > 90 ? 9 : 0);
    while (u < 104) {
      const w = 6.5 + rng() * 4, d = r1 - r0 - rng() * 1.5, v0 = r0 + rng() * 2.5, v1 = v0 + d;
      const cs = [[u, v0], [u + w, v0], [u, v1], [u + w, v1], [u + w / 2, (v0 + v1) / 2]].map(([a, c]) => slopeH(a, c));
      const hi = Math.max(...cs), lo = Math.min(...cs);
      // (the door side (−v, uphill) must be the high side — a house whose front corner stands 0.4 m+ under its
      //  floor is a sealed room: the door 1–3 m up a plinth wall)
      const frontLo = Math.min(slopeH(u, v0), slopeH(u + w, v0), slopeH(u + w / 2, v0));
      if (lo > 0.9 && hi - lo < 3.6 && hi < Y + 0.2 && hi - frontLo < 0.3) {
        const y = hi + 0.15, [cx, cz] = toW(u + w / 2, (v0 + v1) / 2);
        // turned toward the contour: the downhill direction from the baked heights (±12° max)
        const gu = slopeH(u + w / 2 + 2, (v0 + v1) / 2) - slopeH(u + w / 2 - 2, (v0 + v1) / 2), turn = Math.max(-0.12, Math.min(0.12, gu * 0.08)) + (rng() - 0.5) * 0.08;
        const b = mk(cx, cz, yawUV(0, -1) + turn, w, d, { y, floors: rng() < 0.25 ? 1 : 2, shop: false, use: "house" });
        if (b) {
          site.addPoly(footprint(b));
          if (y - lo > 0.25) plinths.push({ x: b.x, z: b.z, yaw: b.yaw, w: b.w + 0.3, d: b.d + 0.3, y0: lo - 0.4, y1: y });
          if (rng() < 0.45) { const [px, pz] = toW(u + w + 2.4, v0 + 1); props.push({ kind: rng() < 0.7 ? "palm" : "banana-plant", x: px, z: pz, y: slopeH(u + w + 2.4, v0 + 1), yaw: rng() * 6.28, s: 0.9 + rng() * 0.3 }); }
        }
      }
      u += w + 10.5 + rng() * 8;
    }
  }
  const kept: Array<[number, number, number, number]> = [];

  // ======================= PLAZA DRESSING (plaza frame → world) =======================
  const at = (kind: PropKind, u: number, v: number, du: number, dv: number, extra: Partial<Prop> = {}) => {
    const [x, z] = toW(u, v); props.push({ kind, x, z, yaw: yawUV(du, dv), ...extra });
  };
  // stall rows (dense — the plaza edges are packed with produce stalls, each fronted by a neat row
  // of fruit crates): far side (facing the fountain), left row (under D1/D2/D3's awnings) and right row
  const FR = (i: number) => (i % 3 === 1 ? "banana" : i % 3 === 2 ? "mixed" : "mango") as "mango" | "banana" | "mixed";
  const crateRow = (u: number, v: number, du: number, dv: number, n: number, seed: number) => {
    // n crates side by side across the stall front (along the row), 1.55 m in front of the stall centre
    const tu = -dv, tv = du; // along the row
    for (let j = 0; j < n; j++) {
      const off = (j - (n - 1) / 2) * 0.78 + (rng() - 0.5) * 0.08;
      const k = (seed + j) % 5;
      at(k === 3 ? "pcrate" : k === 4 ? "basket" : "crate", u + du * 1.55 + tu * off, v + dv * 1.55 + tv * off, du + (rng() - 0.5) * 0.3, dv + (rng() - 0.5) * 0.3, { v: (seed + j * 3) % 4, fruit: (seed + j) % 3 === 1 ? "banana" : "mango" });
    }
  };
  for (let i = 0; i < 6; i++) { const u = -4.0 + i * 2.75; at("stall", u, 21.1, 0, -1, { v: [1, 3, 0, 4, 2, 5][i], fruit: FR(i) }); crateRow(u, 21.1, 0, -1, i % 2 ? 3 : 2, i * 7); }
  const LR: Array<[number, number]> = [[-18.2, 0], [-15.4, 2], [-12.6, 5], [-9.8, 3], [-1.6, 1], [1.2, 4], [12.4, 3], [15.2, 0], [18.0, 2]];
  LR.forEach(([v, k], i) => { at("stall", -9.65, v, 1, 0, { v: k, fruit: FR(i + 1) }); if (i % 3 !== 2) crateRow(-9.65, v, 1, 0, 2, i * 5 + 1); });
  const RR: Array<[number, number]> = [[-15.2, 0], [-12.4, 2], [-1.8, 5], [1.0, 3], [13.0, 1], [15.8, 4], [18.6, 5]];
  RR.forEach(([v, k], i) => { at("stall", 10.65, v, -1, 0, { v: k, fruit: FR(i + 2) }); if (i % 3 !== 1) crateRow(10.65, v, -1, 0, 2, i * 3 + 2); });
  // crate stacks + barrels in the gaps between the rows (cover + clutter)
  for (const [u, v, du, dv] of [[-10.8, 4.4, 1, 0], [11.5, -9.6, -1, 0.1], [11.6, 3.8, -1, 0], [-7.6, 22.4, 0.2, -1], [11.8, 22.2, -0.3, -1]] as Array<[number, number, number, number]>) at("cratestack", u, v, du, dv);
  for (const [u, v, k] of [[-11.2, -6.0, 0], [-11.0, -5.3, 2], [11.9, -8.2, 1], [12.1, 5.6, 3], [-11.3, 9.6, 1]] as Array<[number, number, number]>) at("barrel", u, v, 0, 1, { v: k });
  // the recess in front of A (A_FRONT .. -21, below the view's frame) + C's front under its teal awning: a stall, a
  // crate-table, crates, a planter, a red scooter (kong-eye cover; the camera looks over them)
  at("stall", -9.4, -21.4, 0, 1, { v: 2, fruit: "banana" });
  at("table", 0.6, -22.2, 0.1, 1, { fruit: "mango" });
  at("pcrate", -3.6, -21.8, 0.3, 1, { v: 0, color: "#3f8f3a" });
  at("planter", 3.0, -21.6, 0, 1, { s: 0.5 });
  at("scooter", -3.1, -20.6, 0.4, 1, { color: "#d9483b" });
  // (clear of A's door (u 1.3…2.6) and shop front (u −2.6…0.8) — A's local +x runs toward −u)
  at("cratestack", -4.0, -24.9, 0, 1); at("barrel", -4.0, -23.6, 0, 1, { v: 1 });
  // the near half of the main plaza: a stall row each side, crate tables, planters, a bench,
  // two scooters — all within ~10 m of the fountain or lining the near edge
  at("table", -3.2, -9.6, 0.4, 1, { fruit: "banana" }); at("table", 3.6, -8.2, -0.3, 1, { fruit: "mango" });
  at("pcrate", -2.2, -8.8, 0.2, 1, { v: 0, color: "#3f8f3a" }); at("crate", 4.6, -9.4, 0.6, 1, { v: 1, fruit: "mango" });
  at("scooter", -5.2, -6.2, 0.3, 1, { color: "#f2c132" });
  at("bench", 1.2, -6.6, 0, -1);
  // the camera-side market — stalls within 12 m of the fountain: two more in each side row (the side
  // streets' mouths) + a market island each side of the sight line, facing the near plaza
  for (const [u, v, du, dv, k, f] of [[-9.6, -7.0, 1, 0, 4, 0], [-9.6, -4.2, 1, 0, 1, 1], [10.2, -5.8, -1, 0, 3, 2], [-6.4, -8.6, -0.25, -1, 5, 1], [6.6, -8.4, 0.3, -1, 2, 2]] as Array<[number, number, number, number, number, number]>) {
    at("stall", u, v, du, dv, { v: k, fruit: (["mango", "banana", "mixed"] as const)[f] });
    crateRow(u, v, du, dv, 2, k * 3 + f);
  }
  // the near edge of the plaza (the view's bottom centre): a crate table, a green crate, planters, a barrel pair,
  // a cart and sacks — cover for the forecourt mouth too
  at("table", -2.6, -18.4, 0.15, 1, { fruit: "mango" });
  at("planter", 2.2, -19.0, 0, 1, { s: 0.55 }); at("planter", -5.6, -19.8, 0, 1, { s: 0.5 });
  at("barrel", 5.6, -18.2, 0, 1, { v: 0 }); at("barrel", 6.2, -17.6, 0, 1, { v: 2 });
  at("cart", -5.4, -16.6, 0.8, 1, { fruit: "mango" });
  // the near plaza below the view camera — a fruit cart, a crate stack, a potted palm, a flower planter (no loose
  // crates / sacks on the open paving)
  at("cart", 2.6, -14.2, -0.7, 1, { fruit: "banana" }); at("cratestack", 5.4, -16.4, -0.2, 1);
  at("planter", -1.4, -13.2, 0, 1, { s: 0.6 }); at("pot", 0.6, -12.2, 0, 1, { s: 0.55 });
  at("bench", -3.8, 8.8, 0, -1);
  at("bench", 6.8, 0.2, -1, 0);
  // scooters: yellow at the start of the left row, red on the right, more along the edges
  at("scooter", -7.6, -20.2, 0.25, 1, { color: "#f2c132" });
  at("scooter", 7.9, -4.6, -0.15, -1, { color: "#d9483b" });
  at("scooter", -8.6, 8.2, 0.2, -1, { color: "#2fb3a8" });
  at("scooter", 8.9, -17.4, 0.9, 1, { color: "#f4efe1" });
  at("scooter", 11.9, 6.8, 1, 0.2, { color: "#e58a2a" });
  // the fountain gets its own market ring — four stalls on the
  // far / side arcs facing the basin, fruit carts and crate stacks on the near arc (low: the camera looks over them), potted
  // palms at the four diagonals; hard cover within ~6 m anywhere on the plaza
  const RAD: Partial<Record<PropKind, number>> = { stall: 1.5, table: 0.7, cart: 1.05, scooter: 0.95, bench: 0.95, planter: 0.6, pot: 0.35, lamp: 0.2, crate: 0.35, pcrate: 0.35, cratestack: 0.65, barrel: 0.3, sack: 0.35 };
  const freeAt = (u: number, v: number, r: number) => { const [x, z] = toW(u, v); return props.every((q) => dmath.hypot(q.x - x, q.z - z) >= r + (RAD[q.kind] ?? 0) + 0.25); };
  for (const [a, k, f] of [[0.62, 1, 0], [1.25, 4, 1], [1.9, 2, 2], [2.52, 0, 1]] as Array<[number, number, number]>) {
    const r = FOUNTAIN_R + 5.6, u = dmath.cos(a) * r, v = dmath.sin(a) * r;
    if (!freeAt(u, v, 1.5) || !freeAt(u - dmath.cos(a) * 1.55, v - dmath.sin(a) * 1.55, 0.9)) continue;
    at("stall", u, v, -dmath.cos(a), -dmath.sin(a), { v: k, fruit: (["mango", "banana", "mixed"] as const)[f] });
    crateRow(u, v, -dmath.cos(a), -dmath.sin(a), 2, k * 5 + f);
  }
  for (const [a, kind] of [[-0.55, "cart"], [-2.6, "cart"], [-1.25, "cratestack"], [-1.9, "cratestack"], [-0.95, "barrel"], [-2.25, "barrel"]] as Array<[number, PropKind]>) {
    const r = FOUNTAIN_R + 5.2, u = dmath.cos(a) * r, v = dmath.sin(a) * r;
    if (!freeAt(u, v, RAD[kind] ?? 0.5)) continue;
    at(kind, u, v, -dmath.sin(a), dmath.cos(a), kind === "cart" ? { fruit: a < -1.5 ? "banana" : "mango" } : kind === "barrel" ? { v: 1 } : {});
  }
  for (const a of [0.0, Math.PI / 2 + 0.15, Math.PI, -Math.PI / 2 - 0.3]) { const r = FOUNTAIN_R + 2.6, u = dmath.cos(a) * r, v = dmath.sin(a) * r; if (freeAt(u, v, 0.35)) at("pot", u, v, 0, 1, { s: 0.6 }); }
  // planter boxes round the fountain + crate tables on the plaza (small tables of fruit)
  for (const a of [0.6, 2.4, 4.0, 5.5]) at("planter", dmath.cos(a) * 6.4, dmath.sin(a) * 6.4, 0, 1, { s: 0.45 });
  at("table", -5.6, 12.8, -0.2, -1, { fruit: "banana" });
  at("cratestack", 3.2, 14.5, 0.2, -1); at("cratestack", -6.8, -3.2, 1, 0.1);
  at("lamp", -11.4, -16.3, 0, 1); at("lamp", 12.5, -20.5, 0, 1); at("lamp", -11.4, 23.4, 0, 1); at("lamp", 12.5, 23.4, 0, 1);
  // potted monstera / banana plants by the building fronts
  for (const [u, v] of [[-11.4, -3.3], [12.4, -15.2], [-11.5, 23], [12.4, 23.2], [-5.8, -21], [3.8, -20.4], [12.4, 9.6]] as Array<[number, number]>) at(rng() < 0.5 ? "monstera" : "banana-plant", u, v, 0, 1, { s: 0.75 });

  // ======================= LINES: string lights + bunting =======================
  const wtop = (b: TownBuilding) => b.y + b.floors * (b.floorH ?? 3.2);
  const LINE = (kind: Line["kind"], ua: number, va: number, ya: number, ub: number, vb: number, yb: number, sag: number) => {
    const [ax, az] = toW(ua, va), [bx, bz] = toW(ub, vb);
    lines.push({ kind, a: [ax, Y + ya, az], b: [bx, Y + yb, bz], sag });
  };
  // the foreground catenaries: big warm bulbs from C's front parapet to B's front-left corner, across the bottom of
  // the view's frame (below the camera)
  LINE("lights", -7.4, -23.1, 6.5, 3.4, -21.1, 6.8, 1.3);
  LINE("lights", -4.8, -23.1, 6.4, 3.4, -24.4, 7.0, 1.1);
  // (no foreground bunting strand across the camera: it would cover ~15 % of the view's frame)
  // zig-zag of string lights across the plaza between the left and right rows (eave height)
  const Z: Array<[number, number, number]> = [[3.3, -21.2, 6.4], [-12.1, -10, 6.2], [13.1, -8, 6.0], [-12.1, 3, 6.2], [13.1, 2, 6.0], [-12.1, 14, 7.0], [13.1, 16, 6.0], [-6.2, 24.3, 6.2]];
  for (let i = 0; i < Z.length - 1; i++) LINE("lights", Z[i][0], Z[i][1], Z[i][2], Z[i + 1][0], Z[i + 1][1], Z[i + 1][2], 1.2);
  // bunting: three strands straight across the plaza at eave height, beyond the fountain's near rim (more read as a net
  // over the plaza), + the street mouths
  for (const [va, vb, ya, yb] of [[-3, -7, 7.0, 6.8], [9, 12, 7.0, 7.2], [20, 22.5, 6.6, 6.8]] as Array<[number, number, number, number]>) LINE("bunting", -12.1, va, ya, 13.1, vb, yb, 0.9);
  LINE("bunting", -12.1, 21, 5.4, -6.2, 25, 5.6, 0.5);
  LINE("bunting", -12.1, 28, 5.2, -6.2, 30, 5.4, 0.5);
  LINE("bunting", -12.1, 34, 5.0, -6.2, 36, 5.2, 0.5);
  LINE("bunting", -12.1, 6.2, 5.6, -12.1, 10.4, 5.8, 0.4);
  LINE("bunting", 13.1, 4.2, 5.6, 13.1, 9.8, 5.8, 0.4);
  LINE("bunting", 3.3, -21.2, 5.0, 13.1, -16, 5.4, 0.6);
  // street strands: across the streets between facing fabric buildings (lights on odd, bunting on even)
  let k = 0;
  for (let i = ringCount; i < buildings.length; i++) {
    const a = buildings[i];
    if (rng() > 0.3) continue;
    const fa = frontPoint(a, 0.25, wtop(a) - 0.4), fb = frontPoint(a, 0.75, wtop(a) - 0.4);
    let best: TownBuilding | null = null, bd = 9;
    for (let j = ringCount; j < buildings.length; j++) {
      if (j === i) continue;
      const b = buildings[j];
      const dx = b.x - a.x, dz = b.z - a.z, dist = dmath.hypot(dx, dz);
      const facing = dmath.cos(b.yaw - a.yaw) < -0.9;
      if (facing && dist < bd + 12) { const fp = frontPoint(b, 0.5, 0); const dd = dmath.hypot(fp[0] - fa[0], fp[1] - fa[1]); if (dd < bd) { bd = dd; best = b; } }
    }
    if (!best) continue;
    const fbp = frontPoint(best, 0.5, wtop(best) - 0.5);
    const src = k % 2 ? fa : fb;
    lines.push({ kind: k % 2 ? "lights" : "bunting", a: [src[0], src[2], src[1]], b: [fbp[0], fbp[2], fbp[1]], sag: 0.6 });
    k++;
  }
  // ======================= STREET COVER: a cluster every ~6 m along every fabric frontage =======================
  const clearOfOthers = (x: number, z: number, r: number) => props.every((p) => dmath.hypot(p.x - x, p.z - z) > r + 0.8);
  // along the SIDE walls that face a street too; never inside a neighbour's footprint
  const inAnyBuilding = (x: number, z: number, m: number) => buildings.some((q) => { const c = dmath.cos(q.yaw), s = dmath.sin(q.yaw), dx = x - q.x, dz = z - q.z; const lx = dx * c - dz * s, lz = dx * s + dz * c; return Math.abs(lx) < q.w / 2 + m && Math.abs(lz) < q.d / 2 + m; });
  const sidePoint = (b: TownBuilding, side: number, t: number, out: number): [number, number] => { const c = dmath.cos(b.yaw), s = dmath.sin(b.yaw), lx = side * (b.w / 2 + out), lz = (t - 0.5) * b.d; return [b.x + lx * c + lz * s, b.z - lx * s + lz * c]; };
  // never in front of a doorway / shop opening — the openings come
  // from the SAME resolver the colliders use (deterministic per building seed)
  const doorsOf = (b: TownBuilding) => resolveBuilding(b).walls[b.front ?? 0].openings[0].filter((o) => o.kind === "door" || o.kind === "shop").map((o) => [o.u - 1.0, o.u + o.w + 1.0] as [number, number]);
  const atDoor = (b: TownBuilding, t: number) => { const u = t * b.w; return doorsOf(b).some(([a, c]) => u > a && u < c); };
  for (let i = ringCount; i < buildings.length; i++) {
    const b = buildings[i];
    const nC = Math.max(1, Math.round(b.w / 6));
    const spots: Array<[number, number, number]> = [];
    for (let c = 0; c < nC; c++) { if (rng() < 0.15) continue; const t = (c + 0.3 + rng() * 0.4) / nC, [fx, fz] = frontPoint(b, t, 0, 0.9 + rng() * 0.5); spots.push([fx, fz, t]); }
    for (const side of [-1, 1]) if (rng() < 0.55) { const t = 0.3 + rng() * 0.4, [sx, sz] = sidePoint(b, side, t, 0.8 + rng() * 0.4); spots.push([sx, sz, -1]); }
    for (const [fx, fz, t] of spots) {
      if (!clearOfOthers(fx, fz, 0.9) || !onPad(fx, fz, 2) || inAnyBuilding(fx, fz, 0.35) || (t >= 0 && atDoor(b, t))) continue;
      const r = rng();
      const along = b.yaw + Math.PI / 2 + (rng() - 0.5) * 0.4;
      if (r < 0.2) props.push({ kind: "scooter", x: fx, z: fz, yaw: along, color: pick(["#f2c132", "#d9483b", "#2fb3a8", "#f4efe1", "#e58a2a", "#3a86c8"]) });
      else if (r < 0.4) props.push({ kind: "cratestack", x: fx, z: fz, yaw: b.yaw + (rng() - 0.5) * 0.5 });
      else if (r < 0.52) props.push({ kind: "planter", x: fx, z: fz, yaw: b.yaw, s: 0.5 });
      else if (r < 0.66) { props.push({ kind: "barrel", x: fx, z: fz, yaw: rng() * 6.28, v: Math.floor(rng() * 4) }); if (t >= 0 && rng() < 0.6) { const [gx, gz] = frontPoint(b, Math.min(1, t + 0.06), 0, 0.8); if (!inAnyBuilding(gx, gz, 0.3)) props.push({ kind: "barrel", x: gx, z: gz, yaw: rng() * 6.28, v: Math.floor(rng() * 4) }); } }
      else if (r < 0.76) props.push({ kind: "cart", x: fx, z: fz, yaw: along, fruit: rng() < 0.5 ? "mango" : "banana" });
      else if (r < 0.86) props.push({ kind: "pot", x: fx, z: fz, yaw: rng() * 6.28, s: 0.45 });
      else props.push({ kind: "sack", x: fx, z: fz, yaw: rng() * 6.28 });
    }
    if (b.shop && rng() < 0.4 && dmath.hypot(b.x - FX, b.z - FZ) < 60) { const [sx, sz] = frontPoint(b, 0.5, 0, 2.2); if (clearOfOthers(sx, sz, 1.5) && !atDoor(b, 0.5)) props.push({ kind: "stall", x: sx, z: sz, yaw: b.yaw, v: Math.floor(rng() * 6), fruit: pick(["mango", "banana", "mixed"] as const) }); }
  }
  // a planted TOWN EDGE: a loose band of palms, banana plants
  // and bushes just outside the last street on the south, east and west sides of the pad
  const edgePlant = (x: number, z: number) => { if (!clearOfOthers(x, z, 1.2) || inAnyBuilding(x, z, 2.5)) return; const k = rng(); props.push({ kind: k < 0.14 ? "palm" : k < 0.5 ? "banana-plant" : k < 0.82 ? "bush" : "monstera", x, z, yaw: rng() * 6.28, s: 0.8 + rng() * 0.45 }); };
  // (the planted band follows the pad's round edge)
  for (let a = 0; a < Math.PI * 2; a += 0.045 + rng() * 0.03) {
    const r = P.pad - 4 - rng() * 5, [x, z] = [CX + dmath.cos(a) * r, CZ + dmath.sin(a) * r], [u, v] = toUV(x, z);
    if (v > vmax(u) - 6) continue;
    const ns = site.nearestStreet(x, z, 20); if (ns && ns.d - site.streets[ns.i].w / 2 < 2.5) continue;
    edgePlant(x, z);
  }
  // palms: in the back yards / on pavement corners (never on a carriageway) — beside a front, 0.6 m out, at the ends
  for (let i = ringCount; i < buildings.length; i += 7) {
    const b = buildings[i];
    const [x, z] = frontPoint(b, rng() < 0.5 ? -0.02 : 1.02, 0, 0.7);
    if (onPad(x, z, 4) && clearOfOthers(x, z, 1)) props.push({ kind: rng() < 0.6 ? "palm" : "banana-plant", x, z, yaw: rng() * 6.28, s: 0.9 + rng() * 0.25 });
  }
  // ---- WALL DRESSING — every wall that faces a street or alley gets a prop against it every ~4.5 m (wheelie
  // bins, barrel pairs, crate stacks, plastic crates, pots): 2–4 props per 10 m of side street reads lived-in.
  // Never in a door / shop approach, never where it would leave < 1.7 m of street.
  {
    const SD: Array<{ A: (w: number, d: number) => [number, number]; dir: [number, number]; n: [number, number] }> = [
      { A: (w, d) => [-w / 2, d / 2], dir: [1, 0], n: [0, 1] }, { A: (w, d) => [w / 2, d / 2], dir: [0, -1], n: [1, 0] },
      { A: (w, d) => [w / 2, -d / 2], dir: [-1, 0], n: [0, -1] }, { A: (w, d) => [-w / 2, -d / 2], dir: [0, 1], n: [-1, 0] }];
    const KINDS: PropKind[] = ["bin", "barrel", "cratestack", "pcrate", "bin", "pot", "barrel", "cratestack"];
    let kk = 0;
    for (let i = 0; i < buildings.length; i++) {
      const b = buildings[i];
      if (i === ids.A || i === ids.B || i === ids.C) continue;
      const rp = resolveBuilding(b), c = dmath.cos(b.yaw), sn = dmath.sin(b.yaw);
      const W = (lx: number, lz: number): [number, number] => [b.x + lx * c + lz * sn, b.z - lx * sn + lz * c];
      for (let side = 0; side < 4; side++) {
        const S = SD[side], len = side % 2 === 0 ? b.w : b.d, A0 = S.A(b.w, b.d);
        const ops = rp.walls[side].openings[0].filter((o) => o.kind === "door" || o.kind === "shop");
        for (let u = 1.0 + rng() * 1.5; u < len - 0.9; u += 3.6 + rng() * 1.8) {
          if (ops.some((o) => u > o.u - 1.1 && u < o.u + o.w + 1.1)) continue;
          const at = (o: number) => W(A0[0] + S.dir[0] * u + S.n[0] * o, A0[1] + S.dir[1] * u + S.n[1] * o);
          const [x, z] = at(0.45), far = at(2.55);
          if (!onPad(x, z, 1) || inAnyBuilding(far[0], far[1], 0.1) || inAnyBuilding(x, z, 0.12) || !clearOfOthers(x, z, 0.7)) continue;
          const kind = KINDS[kk++ % KINDS.length], yaw = b.yaw + [0, -Math.PI / 2, Math.PI, Math.PI / 2][side];
          props.push({ kind, x, z, yaw, v: Math.floor(rng() * 4), s: kind === "pot" ? 0.42 : undefined, color: kind === "pcrate" ? ["#3f8f3a", "#3a6fb0", "#d9483b", "#f1c232"][kk % 4] : undefined });
          if (kind === "barrel") { const [x2, z2] = at(0.45 + 0.0).map((v, k) => v + (k === 0 ? S.dir[0] * c + S.dir[1] * sn : -S.dir[0] * sn + S.dir[1] * c) * 0.66) as [number, number]; if (!inAnyBuilding(x2, z2, 0.12)) props.push({ kind: "barrel", x: x2, z: z2, yaw, v: Math.floor(rng() * 4) }); }
        }
      }
    }
  }
  // ---- OPEN-GROUND COVER round the town (so the slope edges + pad corners have no 400 m² holes 20 m from any
  // cover) — palm groups and mossy boulder outcrops on a jittered 12 m grid, only outside the built blocks
  {
    const G: GroundGrid = (SLOPE_H as unknown as { grids: Record<string, GroundGrid> }).grids["mango-market"];
    // (anywhere clear of houses, streets, squares; in town a palm group / grove, boulders only beyond the pad)
    const inBlock = (x: number, z: number) => { const [u, v] = toUV(x, z); if (Math.abs(u) < 30 && v > -50 && v < 40) return true; if (reserved.some((p) => polyGapPt(p, x, z) < 4)) return true; const ns = site.nearestStreet(x, z, 20); return !!ns && ns.d - site.streets[ns.i].w / 2 < 3.5; };
    for (const c of coverScatter(G, { cx: CX, cz: CZ, r: P.r, step: 12, seed: 4313, minY: 1, free: (x, z) => !inBlock(x, z) && !inAnyBuilding(x, z, 5) && clearOfOthers(x, z, 3) })) {
      const g = (dx: number, dz: number) => gridH(G, c.x + dx, c.z + dz);
      const [cu, cv] = toUV(c.x, c.z);
      if (c.kind === "rocks" && flatUV(cu, cv, -6)) c.kind = "palms";
      if (c.kind === "rocks") {
        const n = 1 + Math.floor(rng() * 2.4);
        // (every boulder itself clear of houses and props — a satellite rock can wedge a crate against a
        //  wall: a stuck pocket)
        for (let i = 0; i < n; i++) { const a = rng() * 6.283, r = i ? 1.4 + rng() : 0, rx = c.x + dmath.cos(a) * r, rz = c.z + dmath.sin(a) * r; if (inAnyBuilding(rx, rz, 2.0) || !clearOfOthers(rx, rz, 1.4)) continue; props.push({ kind: "rock", x: rx, z: rz, y: g(dmath.cos(a) * r, dmath.sin(a) * r), yaw: rng() * 6.28, s: (i ? 0.75 + rng() * 0.4 : 1.45 + rng() * 0.4) * c.s }); }
        for (let i = 0; i < 3; i++) { const a = rng() * 6.283, r = 2 + rng() * 1.5; props.push({ kind: rng() < 0.5 ? "fern" : "bush", x: c.x + dmath.cos(a) * r, z: c.z + dmath.sin(a) * r, y: g(dmath.cos(a) * r, dmath.sin(a) * r), yaw: rng() * 6.28, s: 0.8 + rng() * 0.4 }); }
      } else {
        // (light tree coverage, so the outskirts ring is no palm forest: every third cluster is left open ground, a
        //  group is ONE palm, a grove two; the undergrowth stays knee-high)
        if (rng() < 0.34) continue;
        const n = c.kind === "grove" ? 2 : 1;
        for (let i = 0; i < n; i++) { const a = rng() * 6.283, r = i ? 1.4 + rng() * 1.6 : 0; props.push({ kind: "palm", x: c.x + dmath.cos(a) * r, z: c.z + dmath.sin(a) * r, y: g(dmath.cos(a) * r, dmath.sin(a) * r), yaw: rng() * 6.28, s: 0.9 + rng() * 0.3 }); }
        for (let i = 0; i < (c.kind === "grove" ? 3 : 2); i++) { const a = rng() * 6.283, r = 1 + rng() * 2.8, k = rng(); props.push({ kind: k < 0.2 ? "banana-plant" : k < 0.6 ? "bush" : "fern", x: c.x + dmath.cos(a) * r, z: c.z + dmath.sin(a) * r, y: g(dmath.cos(a) * r, dmath.sin(a) * r), yaw: rng() * 6.28, s: 0.8 + rng() * 0.5 }); }
      }
    }
  }
  // ======================= the second square, the orchard, the street lamps =======================
  {
    // Banana Square: a ring of stalls in front of the market hall, benches + potted palms round the edge, a fruit cart
    const [scx, scz] = toW(SQ[0], SQ[1]);
    for (let k = 0; k < 7; k++) {
      const a = -0.6 + k * 0.62, r = 11.5, u = SQ[0] + dmath.cos(a) * r, v = SQ[1] + dmath.sin(a) * r * 0.8;
      const [x, z] = toW(u, v);
      if (!clearOfOthers(x, z, 1.4) || inAnyBuilding(x, z, 1.5)) continue;
      const kind: PropKind = k % 3 === 0 ? "bench" : k % 3 === 1 ? "planter" : "pot";
      props.push({ kind, x, z, yaw: dmath.atan2(scx - x, scz - z) + Math.PI, s: kind === "planter" ? 0.55 : kind === "pot" ? 0.6 : undefined });
    }
    if (ids.HALL !== undefined) {
      const h = buildings[ids.HALL];
      for (let k = 0; k < 4; k++) {
        const [fx, fz] = frontPoint(h, 0.18 + k * 0.21, 0, 3.4);
        if (clearOfOthers(fx, fz, 1.6)) props.push({ kind: "stall", x: fx, z: fz, yaw: h.yaw + Math.PI, v: (k * 2 + 1) % 6, fruit: (["mango", "banana", "mixed"] as const)[k % 3] });
      }
    }
    { const [x, z] = toW(SQ[0] + 3, SQ[1] - 5); if (clearOfOthers(x, z, 1.6)) props.push({ kind: "cart", x, z, yaw: 0.6, fruit: "mango" }); }
    // the square's heart: a ring of tall palms round a flower bed, benches under them facing out
    for (let k = 0; k < 5; k++) { const a = k * 1.2566 + 0.3, [x, z] = toW(SQ[0] + dmath.cos(a) * 3.4, SQ[1] + dmath.sin(a) * 3.4); props.push({ kind: "palm", x, z, yaw: rng() * 6.28, s: 1.15 + rng() * 0.2 }); }
    for (let k = 0; k < 5; k++) { const a = k * 1.2566 + 0.93, [x, z] = toW(SQ[0] + dmath.cos(a) * 2.2, SQ[1] + dmath.sin(a) * 2.2); props.push({ kind: k % 2 ? "bush" : "banana-plant", x, z, yaw: rng() * 6.28, s: 0.9 }); }
    for (let k = 0; k < 3; k++) { const a = k * 2.094 + 0.6, [x, z] = toW(SQ[0] + dmath.cos(a) * 5.4, SQ[1] + dmath.sin(a) * 5.4); if (clearOfOthers(x, z, 0.9)) props.push({ kind: "bench", x, z, yaw: dmath.atan2(x - scx, z - scz) + Math.PI / 2 }); }
    // the Mango Orchard: mango trees (broadleaf) in loose rows, a low wall round it with two gaps
    const oc = orchardPoly.reduce((a, p) => [a[0] + p[0] / orchardPoly.length, a[1] + p[1] / orchardPoly.length], [0, 0]);
    for (let i = -2; i <= 2; i++) for (let j = -1; j <= 2; j++) {
      const [x, z] = toW(orchardUV[0] + i * 5.4 + (rng() - 0.5) * 1.6, orchardUV[1] + j * 5.4 - 2.7 + (rng() - 0.5) * 1.6);
      if (polyGapPt(orchardPoly, x, z) > 0 || dmath.hypot(x - oc[0], z - oc[1]) > 13) continue;
      props.push({ kind: "tree", x, z, yaw: rng() * 6.28, s: 0.5 + rng() * 0.18 });
    }
    // street lamps: every ~24 m along the main + side streets, alternating sides, 0.9 m in from the kerb
    for (const st of site.streets) {
      if (st.kind === "alley") continue;
      const arc = polyArc(st.pts), L = arc[arc.length - 1];
      let side = 1;
      for (let s = 8; s < L - 6; s += 22 + rng() * 6) {
        const q = polyAt(st.pts, arc, s), off = st.w / 2 + 0.9, x = q.p[0] - q.d[1] * off * side, z = q.p[1] + q.d[0] * off * side;
        side = -side;
        if (!townFlat(x, z, 1) || inAnyBuilding(x, z, 1.2) || !clearOfOthers(x, z, 1.0)) continue;
        props.push({ kind: "lamp", x, z, yaw: 0 });
      }
    }
  }
  // ======================= YARDS — the gaps between houses become gardens, not leftover =======================
  // Back + side yards behind most detached houses: a low plastered wall, a clipped hedge or a picket fence (open to the
  // street, a gate in the back), shade trees / palms / banana plants inside, and a bit of life (a washing line, a table
  // under a tree, barrels, a parked scooter). A run is kept only ≥ 2.2 m from every other house / fence / street edge
  // (no slots a kong squeezes into); each kept run is one Prop (collider = what is drawn).
  {
    const fenceSamples: Vec2[] = [];
    const inB = (x: number, z: number, m: number, skip: TownBuilding) => buildings.some((q) => { if (q === skip) return false; const c = dmath.cos(q.yaw), sn = dmath.sin(q.yaw), dx = x - q.x, dz = z - q.z; return Math.abs(dx * c - dz * sn) < q.w / 2 + m && Math.abs(dx * sn + dz * c) < q.d / 2 + m; });
    const okPt = (x: number, z: number, b: TownBuilding) => {
      const [u, v] = toUV(x, z);
      if (!flatUV(u, v, 1)) return false;
      if (inB(x, z, 2.2, b)) return false;
      if (reserved.some((p) => polyGapPt(p, x, z) < 2.0)) return false;
      const ns = site.nearestStreet(x, z, 20); if (ns && ns.d - site.streets[ns.i].w / 2 < 2.0) return false;
      if (fenceSamples.some(([fx, fz]) => dmath.hypot(fx - x, fz - z) < 2.2)) return false;
      // (no slot between a yard run and the street dressing against a wall: a crate stack wedged there was a stuck spot)
      if (props.some((q) => q.kind !== "palm" && q.kind !== "banana-plant" && q.kind !== "bush" && q.kind !== "fern" && q.kind !== "monstera" && q.kind !== "tree" && dmath.hypot(q.x - x, q.z - z) < 1.9)) return false;
      return true;
    };
    const KIND: Array<"hedge" | "gwall" | "fence"> = ["hedge", "gwall", "fence"];
    for (let i = ringCount; i < buildings.length; i++) {
      const b = buildings[i], [bu, bv] = toUV(b.x, b.z), zone = zoneOf(bu, bv);
      if (b.y !== Y || b.use === "tower" || b.use === "market-hall") continue;
      if (rng() > (zone === "core" ? 0.12 : zone === "mid" ? 0.62 : 0.82)) continue;
      const m = R(2.8, 4.6), kind = KIND[Math.floor(rng() * 3)], c = dmath.cos(b.yaw), sn = dmath.sin(b.yaw);
      const W = (lx: number, lz: number): Vec2 => [b.x + lx * c + lz * sn, b.z - lx * sn + lz * c];
      const hw = b.w / 2 + m, back = -b.d / 2 - m, fz = b.d / 2 - 1.0, gate = R(-hw + 1.5, hw - 3.0);
      // segments in local coords [ax, az, bx, bz] — back (with a 1.5 m gate), left, right
      const segs: Array<[number, number, number, number]> = [[-hw, back, gate, back], [gate + 1.5, back, hw, back], [-hw, back, -hw, fz], [hw, back, hw, fz]];
      const color = kind === "gwall" ? b.trim : kind === "fence" ? pick(["#f4efe1", "#2f8f86", "#e8c15a", "#f0a24a", "#4f9fd6"]) : undefined;
      let any = false;
      for (const [ax, az, bx2, bz2] of segs) {
        const L = dmath.hypot(bx2 - ax, bz2 - az); if (L < 2.2) continue;
        // split into runs of good samples (every 0.8 m)
        const n = Math.ceil(L / 0.8); let run0 = -1;
        const flush = (k0: number, k1: number) => {
          const t0 = k0 / n, t1 = k1 / n, len = (t1 - t0) * L; if (len < 2.4) return;
          const p0 = W(ax + (bx2 - ax) * t0, az + (bz2 - az) * t0), p1 = W(ax + (bx2 - ax) * t1, az + (bz2 - az) * t1);
          props.push({ kind, x: (p0[0] + p1[0]) / 2, z: (p0[1] + p1[1]) / 2, yaw: dmath.atan2(-(p1[1] - p0[1]), p1[0] - p0[0]), s: len, color, v: Math.floor(rng() * 4) });
          for (let k = 0; k <= Math.ceil(len / 0.8); k++) { const t = k / Math.ceil(len / 0.8); fenceSamples.push([p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t]); }
          any = true;
        };
        const good: boolean[] = [];
        for (let k = 0; k <= n; k++) { const [x, z] = W(ax + (bx2 - ax) * k / n, az + (bz2 - az) * k / n); good.push(okPt(x, z, b)); }
        for (let k = 0; k <= n; k++) { if (good[k] && run0 < 0) run0 = k; if ((!good[k] || k === n) && run0 >= 0) { flush(run0, good[k] ? k : k - 1); run0 = -1; } }
      }
      // the garden: a shade tree / palm in a back corner, banana plants / bushes along the fence, a bit of life
      const spots: Array<[number, number]> = [[-hw + 1.4, back + 1.4], [hw - 1.4, back + 1.4], [-hw + 1.3, -b.d / 4], [hw - 1.3, -b.d / 4]];
      for (const [lx, lz] of spots) {
        if (rng() < (any ? 0.35 : 0.6)) continue;
        const [x, z] = W(lx, lz); if (!flatUV(...toUV(x, z), 1) || inB(x, z, 1.4, b) || !clearOfOthers(x, z, 0.6)) continue;
        const k = rng();
        props.push({ kind: k < 0.3 ? "tree" : k < 0.55 ? "palm" : k < 0.8 ? "banana-plant" : "bush", x, z, yaw: rng() * 6.28, s: k < 0.3 ? 0.55 + rng() * 0.25 : 0.8 + rng() * 0.35 });
      }
      if (rng() < 0.55) {
        const [x, z] = W(R(-b.w / 4, b.w / 4), back + m * 0.5);
        if (flatUV(...toUV(x, z), 1) && !inB(x, z, 1.6, b) && clearOfOthers(x, z, 1.2)) {
          const k = rng();
          if (k < 0.35) props.push({ kind: "laundry", x, z, yaw: b.yaw, s: Math.min(4.2, b.w * 0.5), v: Math.floor(rng() * 4) });
          else if (k < 0.55) props.push({ kind: "bench", x, z, yaw: b.yaw + Math.PI });
          else if (k < 0.75) { props.push({ kind: "barrel", x, z, yaw: rng() * 6, v: Math.floor(rng() * 4) }); props.push({ kind: "barrel", x: x + 0.7 * c, z: z - 0.7 * sn, yaw: rng() * 6, v: Math.floor(rng() * 4) }); }
          else props.push({ kind: "planter", x, z, yaw: b.yaw, s: 0.55 });
        }
      }
    }
  }
  // ======================= STREET COVER RHYTHM =======================
  // A BR town street is a lane WITH a cover rhythm, not 40–80 m of bare paving between a bin and a cart: every
  // ~13–18 m, alternating sides, ~2.3 m in from the kerb (≥ 2.2 m from any
  // wall, never at a junction, a square, a door or a lamp), one cover piece: a raised planter (the crouch-proof 1.1 m
  // box), a fruit cart + crate stack, or a barrel / bin row. Main streets keep ≥ 4 m of carriageway beside it.
  {
    const PLC = ["#f2e8d0", "#e9d3a8", "#f6efe0", "#e8c9a0", "#d9e3d0"];
    const offStreet = (x: number, z: number, self: number, m: number) => site.streets.some((o, oi) => {
      if (oi === self) return false;
      for (let k = 1; k < o.pts.length; k++) { const a = o.pts[k - 1], b = o.pts[k], dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz || 1e-9, t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2)); if (dmath.hypot(x - a[0] - t * dx, z - a[1] - t * dz) < o.w / 2 + m) return true; }
      return false;
    });
    const okAt = (x: number, z: number, si: number) => townFlat(x, z, 2) && !inAnyBuilding(x, z, 2.2) && clearOfOthers(x, z, 1.5) && !offStreet(x, z, si, 5)
      && !reserved.some((p) => polyGapPt(p, x, z) < 3) && polyGapPt(squarePoly, x, z) > 3;
    site.streets.forEach((st, si) => {
      if (st.kind === "alley") return;
      const arc = polyArc(st.pts), L = arc[arc.length - 1];
      let side = rng() < 0.5 ? 1 : -1;
      for (let s = 9 + rng() * 5; s < L - 8; s += 13 + rng() * 5) {
        const q = polyAt(st.pts, arc, s), sd = side;
        side = -side;
        const yaw = dmath.atan2(-q.d[1], q.d[0]);
        // the planned slot (~2.3 m in from the kerb on this side), else nearer the centreline, else the other side; the
        // piece's ends must be clear too (it is up to 3.2 m long along the street)
        let x = 0, z = 0, ok = false;
        for (const [off, sg] of [[Math.max(0.6, st.w / 2 - 2.3), sd], [Math.max(0.6, st.w / 2 - 3.2), sd], [Math.max(0.6, st.w / 2 - 2.3), -sd], [Math.max(0.6, st.w / 2 - 3.2), -sd]]) {
          x = q.p[0] - q.d[1] * off * sg; z = q.p[1] + q.d[0] * off * sg;
          if (okAt(x, z, si) && okAt(x + q.d[0] * 1.6, z + q.d[1] * 1.6, si) && okAt(x - q.d[0] * 1.6, z - q.d[1] * 1.6, si)) { ok = true; break; }
        }
        if (!ok) continue;
        const k = rng();
        if (k < 0.45) props.push({ kind: "splanter", x, z, yaw, s: 2.6 + rng() * 0.6, color: pick(PLC) });
        else if (k < 0.72) {
          props.push({ kind: "cart", x: x + q.d[0] * 0.5, z: z + q.d[1] * 0.5, yaw: yaw + (rng() - 0.5) * 0.2, fruit: rng() < 0.5 ? "mango" : "banana" });
          props.push({ kind: "cratestack", x: x - q.d[0] * 1.15, z: z - q.d[1] * 1.15, yaw: yaw + (rng() - 0.5) * 0.3 });
        } else {
          props.push({ kind: "barrel", x: x - q.d[0] * 0.95, z: z - q.d[1] * 0.95, yaw: rng() * 6.28, v: Math.floor(rng() * 4) });
          props.push({ kind: "barrel", x: x - q.d[0] * 0.3, z: z - q.d[1] * 0.3, yaw: rng() * 6.28, v: Math.floor(rng() * 4) });
          props.push({ kind: "bin", x: x + q.d[0] * 0.55, z: z + q.d[1] * 0.55, yaw, v: Math.floor(rng() * 4) });
          props.push({ kind: "cratestack", x: x + q.d[0] * 1.55, z: z + q.d[1] * 1.55, yaw: yaw + (rng() - 0.5) * 0.3 });
        }
      }
    });
  }
  // Banana Square has 40 m of open paving round its palm ring (benches 0.5 m high): a broken ring of four
  // street planters between the palms and the edge — crossing cover with four open gaps, every planter tangent to it
  const sqA: number[] = [];
  for (let k = 0; k < 16 && sqA.length < 4; k++) {
    const a = 0.35 + k * 0.3927;
    if (sqA.some((b) => Math.abs(dmath.atan2(dmath.sin(a - b), dmath.cos(a - b))) < 1.2)) continue;
    const u = SQ[0] + dmath.cos(a) * 8.6, v = SQ[1] + dmath.sin(a) * 7.4, [x, z] = toW(u, v);
    const [tx, tz] = toW(SQ[0] - dmath.sin(a) * 8.6, SQ[1] + dmath.cos(a) * 7.4), [cx, cz] = toW(SQ[0], SQ[1]);
    const dx = tx - cx, dz = tz - cz;
    if (!clearOfOthers(x, z, 1.6) || inAnyBuilding(x, z, 2.2)) continue;
    props.push({ kind: "splanter", x, z, yaw: dmath.atan2(-dz, dx), s: 2.8, color: "#f2e8d0" }); sqA.push(a);
  }
  autoBlind(buildings);
  clearDoors(buildings, props);
  // (a pitched roof whose eave would run INTO a taller neighbour (≤ 0.75 m away) loses its overhang — otherwise the
  //  eave intrudes into the neighbour's stairwell at head height and its flights stop one step short)
  for (const b of buildings) {
    if (b.roof === "flat") continue;
    const eave = b.y + b.floors * (b.floorH ?? 3.2), c = dmath.cos(b.yaw), s = dmath.sin(b.yaw);
    const pts: Array<[number, number]> = [];
    for (let k = 0; k <= 8; k++) { const t = k / 8 - 0.5; for (const [lx, lz] of [[t * b.w, b.d / 2 + 0.3], [t * b.w, -b.d / 2 - 0.3], [b.w / 2 + 0.3, t * b.d], [-b.w / 2 - 0.3, t * b.d]]) pts.push([b.x + lx * c + lz * s, b.z - lx * s + lz * c]); }
    const hit = buildings.some((q) => q !== b && q.y + q.floors * (q.floorH ?? 3.2) > eave + 0.3 && pts.some(([x, z]) => { const qc = dmath.cos(q.yaw), qs = dmath.sin(q.yaw), dx = x - q.x, dz = z - q.z; return Math.abs(dx * qc - dz * qs) < q.w / 2 + 0.45 && Math.abs(dx * qs + dz * qc) < q.d / 2 + 0.45; }));
    if (hit) b.overhang = 0.06;
    // the gable end(s) facing a taller neighbour ≤ 0.6 m away: one full block (no ledges in the slot)
    const along = (b.roofAxis ?? "x") === "x", fill: Array<-1 | 1> = [];
    for (const e of [-1, 1] as const) {
      const ends: Array<[number, number]> = [];
      for (let k = 0; k <= 6; k++) { const t = (k / 6 - 0.5) * 0.9; const [lx, lz] = along ? [e * (b.w / 2 + 0.35), t * b.d] : [t * b.w, e * (b.d / 2 + 0.35)]; ends.push([b.x + lx * c + lz * s, b.z - lx * s + lz * c]); }
      if (buildings.some((q) => q !== b && q.y + q.floors * (q.floorH ?? 3.2) > eave + 0.3 && ends.filter(([x, z]) => { const qc = dmath.cos(q.yaw), qs = dmath.sin(q.yaw), dx = x - q.x, dz = z - q.z; return Math.abs(dx * qc - dz * qs) < q.w / 2 + 0.3 && Math.abs(dx * qs + dz * qc) < q.d / 2 + 0.3; }).length >= 3)) fill.push(e);
    }
    if (fill.length) b.gableFill = fill;
    // a chimney on ~60 % of the gables (the roofscape is never bare): a quarter in from one end, off the ridge
    if (openingHashLocal(b.x, b.z) < 0.6) { const L0 = (along ? b.w : b.d) / 2 - 1.2, a = (openingHashLocal(b.z, b.x) < 0.5 ? -1 : 1) * L0 * 0.55; b.chimney = along ? [a, 0.35] : [0.35, a]; }
  }
  // (no proud corner quoins in narrow gaps — they pinch alleys into capsule traps)
  for (const b of buildings) {
    const c = dmath.cos(b.yaw), s = dmath.sin(b.yaw);
    for (const [cx, cz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const lx = cx * b.w / 2, lz = cz * b.d / 2, x = b.x + lx * c + lz * s, z = b.z - lx * s + lz * c;
      if (buildings.some((q) => { if (q === b) return false; const qc = dmath.cos(q.yaw), qs = dmath.sin(q.yaw), dx = x - q.x, dz = z - q.z; return Math.abs(dx * qc - dz * qs) < q.w / 2 + 2.0 && Math.abs(dx * qs + dz * qc) < q.d / 2 + 2.0; })) { b.quoins = false; break; }
    }
  }
  const parts = buildings.map(resolveBuilding);
  // ---- the named places
  const places: TownPlace[] = [];
  const cen = (p: Vec2[]): Vec2 => [p.reduce((a, q) => a + q[0], 0) / p.length, p.reduce((a, q) => a + q[1], 0) / p.length];
  places.push({ kind: "plaza", name: "Market Plaza", x: FX, z: FZ, poly: W2([[-12, -21.3], [13, -21.3], [13, 24], [-12, 24]]) });
  places.push({ kind: "landmark", name: "Gorilla statue", x: FX, z: FZ, top: Y + 0.12 + 2.2 + STATUE_H });
  { const c = cen(squarePoly); places.push({ kind: "plaza", name: "Banana Square", x: c[0], z: c[1], poly: squarePoly }); }
  // (its top = the roof + the timber water tower on it: legs 3.2 m + tank, ×1.15)
  if (ids.TOWER !== undefined) { const t = buildings[ids.TOWER]; places.push({ kind: "landmark", name: "Lookout Tower", x: t.x, z: t.z, top: t.y + t.floors * (t.floorH ?? 3.2) + (3.29 + 1.45) * 1.15 }); }
  { const c = cen(courtPoly); places.push({ kind: "court", name: "School Court", x: c[0], z: c[1], poly: courtPoly }); }
  { const c = cen(orchardPoly); places.push({ kind: "garden", name: "Mango Orchard", x: c[0], z: c[1], poly: orchardPoly }); }
  for (const st of site.streets) if (st.kind === "alley") { const m = st.pts[Math.floor(st.pts.length / 2)]; places.push({ kind: "alley", name: st.name, x: m[0], z: m[1] }); }
  void nRes; void lots;
  return { buildings, parts, props, lines, ids, blocks: kept, ring: ringCount, plinths, streets: site.streets, places, squares: [squarePoly] };
}

/** every ground-floor door opens onto walkable space (a door facing a neighbour's wall 0.3 m away or a lamp / crate
 *  stack / planter leaves a room reachable only through the windows, a trap once the windows collide). A door
 *  approach (0.5–1.6 m out, ±0.45 m across) inside another building moves the door to a free side; a prop there is
 *  removed. Deterministic post-pass (no rng). */
/** distance from a point to a polygon (0 inside) */
function polyGapPt(p: Vec2[], x: number, z: number): number {
  let ins = false; for (let i = 0, j = p.length - 1; i < p.length; j = i++) { const [xi, zi] = p[i], [xj, zj] = p[j]; if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) ins = !ins; }
  if (ins) return 0;
  let m = Infinity; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length], dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz || 1e-9, t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2)); m = Math.min(m, dmath.hypot(x - a[0] - t * dx, z - a[1] - t * dz)); }
  return m;
}
function openingHashLocal(x: number, z: number): number { let h = (Math.round(x * 13) * 73856093) ^ (Math.round(z * 17) * 19349663); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
function clearDoors(bs: TownBuilding[], props: Prop[]) {
  const inB = (q: TownBuilding, x: number, z: number, m: number) => { const c = dmath.cos(q.yaw), s = dmath.sin(q.yaw), dx = x - q.x, dz = z - q.z; const lx = dx * c - dz * s, lz = dx * s + dz * c; return Math.abs(lx) < q.w / 2 + m && Math.abs(lz) < q.d / 2 + m; };
  const approach = (b: TownBuilding, side: number, u: number): Array<[number, number]> => {
    const S = [{ A: [-b.w / 2, b.d / 2], dir: [1, 0], n: [0, 1] }, { A: [b.w / 2, b.d / 2], dir: [0, -1], n: [1, 0] }, { A: [b.w / 2, -b.d / 2], dir: [-1, 0], n: [0, -1] }, { A: [-b.w / 2, -b.d / 2], dir: [0, 1], n: [-1, 0] }][side];
    const out: Array<[number, number]> = [];
    for (const d of [0.5, 1.0, 1.6]) for (const a of [-0.45, 0, 0.45]) {
      const lx = S.A[0] + S.dir[0] * (u + a) + S.n[0] * d, lz = S.A[1] + S.dir[1] * (u + a) + S.n[1] * d;
      const c = dmath.cos(b.yaw), s = dmath.sin(b.yaw);
      out.push([b.x + lx * c + lz * s, b.z - lx * s + lz * c]);
    }
    return out;
  };
  const doorsOf = (b: TownBuilding) => { const p = resolveBuilding(b), side = b.doorSide ?? b.front ?? 0; return { side, us: p.walls[side].openings[0].filter((o) => o.kind === "door").map((o) => o.u + o.w / 2) }; };
  const blockedBy = (b: TownBuilding, pts: Array<[number, number]>) => bs.some((q) => q !== b && pts.some(([x, z]) => inB(q, x, z, 0.1)));
  for (const b of bs) {
    const { side, us } = doorsOf(b);
    if (!us.length || !us.some((u) => blockedBy(b, approach(b, side, u)))) continue;
    // try the other sides (their midpoint door); keep the front's shop window unless the shop door itself was blocked
    for (const s2 of [1, 3, 2, 0].filter((k) => k !== side) as Array<0 | 1 | 2 | 3>) {
      const len = s2 % 2 === 0 ? b.w : b.d;
      if (len < 3) continue;
      if (!blockedBy(b, approach(b, s2, len / 2)) && !blockedBy(b, approach(b, s2, len / 2 - 1)) && !blockedBy(b, approach(b, s2, len / 2 + 1))) {
        b.doorSide = s2; b.shop = false; if (b.blind) b.blind = b.blind.filter((k) => k !== s2); break;
      }
    }
  }
  // props in any door approach (incl. the new ones) go
  const approaches = bs.flatMap((b) => { const { side, us } = doorsOf(b); return us.flatMap((u) => approach(b, side, u)); });
  // (a capsule (r 0.42) standing on the door's centre line 0.5 / 1.0 m out must not overlap the prop's collider)
  const near = approaches.filter((_, k) => k % 9 === 4 || k % 9 === 1);
  for (let i = props.length - 1; i >= 0; i--) {
    const bx = propBoxes([props[i]]);
    if (bx.some((q) => near.some(([x, z]) => { const c = dmath.cos(q.yaw ?? 0), s = dmath.sin(q.yaw ?? 0), dx = x - q.c[0], dz = z - q.c[2]; return Math.abs(dx * c - dz * s) < q.h[0] + 0.42 && Math.abs(dx * s + dz * c) < q.h[2] + 0.42; }))) props.splice(i, 1);
  }
}

/** perf: a side / back wall that stands within ~0.9 m of a neighbour's wall over most of its length is never seen
 *  (party walls, back-to-back rows) — make it BLIND (no windows: no trims, shutters, glass or wall cut-outs behind it) */
function autoBlind(bs: TownBuilding[]) {
  const inside = (b: TownBuilding, x: number, z: number, m: number) => {
    const c = dmath.cos(b.yaw), s = dmath.sin(b.yaw), dx = x - b.x, dz = z - b.z;
    const lx = dx * c - dz * s, lz = dx * s + dz * c;
    return Math.abs(lx) < b.w / 2 + m && Math.abs(lz) < b.d / 2 + m;
  };
  const cell = 24, grid = new Map<string, number[]>();
  bs.forEach((b, i) => { const k = `${Math.floor(b.x / cell)},${Math.floor(b.z / cell)}`; (grid.get(k) ?? grid.set(k, []).get(k)!).push(i); });
  const near = (x: number, z: number) => { const out: number[] = []; const cx = Math.floor(x / cell), cz = Math.floor(z / cell); for (let a = -1; a <= 1; a++) for (let b2 = -1; b2 <= 1; b2++) out.push(...(grid.get(`${cx + a},${cz + b2}`) ?? [])); return out; };
  // local side frames (see town-kit SIDES): 0 front +z, 1 right +x, 2 back -z, 3 left -x
  const SD: Array<{ n: [number, number]; dir: [number, number] }> = [{ n: [0, 1], dir: [1, 0] }, { n: [1, 0], dir: [0, -1] }, { n: [0, -1], dir: [-1, 0] }, { n: [-1, 0], dir: [0, 1] }];
  bs.forEach((b, i) => {
    const c = dmath.cos(b.yaw), s = dmath.sin(b.yaw), cand = near(b.x, b.z).filter((j) => j !== i);
    const blind = new Set(b.blind ?? []);
    for (let side = 0; side < 4; side++) {
      if (side === (b.front ?? 0) || side === (b.doorSide ?? b.front ?? 0)) continue;
      const S = SD[side], len = side % 2 === 0 ? b.w : b.d, half = side % 2 === 0 ? b.d / 2 : b.w / 2;
      let hit = 0; const n = 6;
      for (let k = 0; k < n; k++) {
        const u = (k + 0.5) / n - 0.5, off = half + 0.9;
        const lx = S.n[0] * off + S.dir[0] * u * len, lz = S.n[1] * off + S.dir[1] * u * len;
        const x = b.x + lx * c + lz * s, z = b.z - lx * s + lz * c;
        if (cand.some((j) => inside(bs[j], x, z, 0.05))) hit++;
      }
      if (hit >= n - 1) blind.add(side as 0 | 1 | 2 | 3);
    }
    if (blind.size) b.blind = [...blind] as TownBuilding["blind"];
  });
}

/** world point on a building's front wall line at fraction t along it, `out` metres in front; returns [x, z, y] */
export function frontPoint(b: TownBuilding, t: number, y: number, out = 0): [number, number, number] {
  const c = dmath.cos(b.yaw), s = dmath.sin(b.yaw), lx = -b.w / 2 + b.w * t, lz = b.d / 2 + out;
  return [b.x + lx * c + lz * s, b.z - lx * s + lz * c, y];
}

export const LAYOUT: MarketLayout = genLayout();
export const CAM_BUILDING = LAYOUT.buildings[LAYOUT.ids.A];
/** declared design data */
export const STREETS = LAYOUT.streets, PLACES = LAYOUT.places;

// ---------- colliders
function propColliders(): Box[] { return propBoxes(LAYOUT.props); }
/** street / plaza prop colliders (three.js yaw convention — simBoxes converts the exported list) */
/** a prop-local box (three.js yaw: local +x → (cos, −sin), +z → (sin, cos)) */
function pb(p: Prop, lx: number, ly: number, lz: number, hx: number, hy: number, hz: number, surf: Box["surf"]): Box {
  const c = dmath.cos(p.yaw), s = dmath.sin(p.yaw);
  return { c: [p.x + lx * c + lz * s, (p.y ?? Y) + ly, p.z - lx * s + lz * c], h: [hx, hy, hz], yaw: p.yaw, surf };
}
function propBoxes(props: Prop[]): Box[] {
  const out: Box[] = [];
  for (const p of props) {
    const y = p.y ?? Y;
    switch (p.kind) {
      // (stall = its display table (tilted top 0.8–0.88, 2.24 × 0.78 at z +0.26) + the four canopy posts; cart =
      //  its bed + heap (0.67); scooter = seat / cowl (0.83) + leg shield (1.0) + floorboard — every box top is
      //  something drawn)
      case "stall": out.push(pb(p, 0, 0.44, 0.26, 1.12, 0.44, 0.39, "wood")); for (const x of [-1.24, 1.24]) for (const z of [0.55, -0.75]) out.push(pb(p, x, 1.15, z, 0.05, 1.15, 0.05, "wood")); break;
      case "table": out.push({ c: [p.x, y + 0.45, p.z], h: [0.6, 0.45, 0.4], yaw: p.yaw, surf: "wood" }); break;
      case "cart": out.push(pb(p, -0.07, 0.335, 0, 0.65, 0.335, 0.44, "wood")); break;
      case "scooter": out.push(pb(p, -0.38, 0.415, 0, 0.4, 0.415, 0.22, "metal"), pb(p, 0.55, 0.5, 0, 0.18, 0.5, 0.2, "metal"), pb(p, 0.1, 0.15, 0, 0.28, 0.15, 0.16, "metal")); break;
      case "bench": out.push({ c: [p.x, y + 0.25, p.z], h: [0.9, 0.25, 0.25], yaw: p.yaw, surf: "stone" }); break;
      // (the drawn planter BOX — town-market addPlanterBox w = 2.2 s, 0.38 deep, 0.4 tall)
      case "planter": out.push({ c: [p.x, y + 0.21, p.z], h: [(p.s ?? 0.5) * 1.1, 0.21, 0.2], yaw: p.yaw, surf: "wood" }); break;
      case "lamp": out.push({ c: [p.x, y + 1.8, p.z], h: [0.14, 1.8, 0.14], surf: "metal" }); break;
      case "crate": case "pcrate": out.push({ c: [p.x, y + 0.18, p.z], h: [0.32, 0.18, 0.23], yaw: p.yaw, surf: "wood" }); break;
      // (the two-crate base of the drawn stack)
      case "cratestack": out.push({ c: [p.x, y + 0.31, p.z], h: [0.62, 0.31, 0.24], yaw: p.yaw, surf: "wood" }); break;
      // (round barrels as octagons; palms: the veg area draws a curved / leaning trunk, so only its foot collides
      //  (0–1.5 m, where it is still over its root) — a full-height upright box would be an invisible wall)
      case "barrel": for (const yw of [0, Math.PI / 4]) out.push({ c: [p.x, y + 0.44, p.z], h: [0.29, 0.44, 0.29], yaw: yw, surf: "metal" }); break;
      case "palm": out.push(...palmBoxes(p.x, y, p.z, p.s ?? 1)); break;
      case "bin": out.push(pb(p, 0, 0.53, 0, 0.31, 0.53, 0.36, "wood")); break;
      case "rock": out.push(...rockBoxes(p.x, y, p.z, p.s ?? 1, p.yaw)); break;
      // (yards) runs along local +x, `s` long — the drawn wall / hedge / fence (bullets pass a fence and a hedge)
      case "gwall": out.push(pb(p, 0, 0.48, 0, (p.s ?? 2) / 2, 0.48, 0.14, "stone")); break;
      // the planter box to its stone cap (1.1 m); the shrub crown over it is foliage (no collider)
      case "splanter": out.push(pb(p, 0, 0.55, 0, (p.s ?? 2.8) / 2 + 0.06, 0.55, 0.5, "stone")); break;
      case "hedge": out.push({ ...pb(p, 0, 0.62, 0, (p.s ?? 2) / 2, 0.62, 0.36, "wood"), noShoot: true, noDrive: true }); break;
      case "fence": out.push({ ...pb(p, 0, 0.5, 0, (p.s ?? 2) / 2, 0.5, 0.05, "wood"), noShoot: true, noDrive: true }); break;
      case "tree": out.push({ c: [p.x, y + 0.9, p.z], h: [0.34 * (p.s ?? 1) + 0.1, 0.9, 0.34 * (p.s ?? 1) + 0.1], surf: "wood" }); break;
      case "laundry": for (const x of [-(p.s ?? 3) / 2, (p.s ?? 3) / 2]) out.push(pb(p, x, 0.95, 0, 0.05, 0.95, 0.05, "wood")); break;
      default: break;
    }
  }
  return out;
}

// ---------- furnished interiors (shared interiors kit) — every storey of every building is a room; the
// furniture collides (sim convention already) and gives the loot candidates. Baked: shared/pois/town-interiors.json.
export const INTERIOR_ROOMS: InteriorRoom[] = LAYOUT.parts.flatMap((p) => buildingRooms(p));
const INTERIORS = townInteriors("mango-market", INTERIOR_ROOMS, (TOWN_INT as unknown as Record<string, TownInteriorBake | undefined>)["mango-market"]);
/** every interior loot candidate (world) — the match generator's building spots; do NOT call interiorLoot(INTERIOR_ROOMS) (1.4 s) */
export const INTERIOR_LOOT = INTERIORS.loot;
/** a free spot on a flat roof (clear of its props + stair house), world [x, y, z] */
function roofSpot(p: BuildingParts, skip: Array<[number, number, number]> = [], sep = 0): [number, number, number] | null {
  if (p.roof.kind !== "flat") return null;
  const b = p.b;
  for (const [fx, fz] of [[0.25, 0.25], [-0.2, 0.3], [0.3, -0.1], [0, 0], [-0.3, -0.25], [0.3, -0.3], [-0.3, 0.05]]) {
    const lx = fx * b.w, lz = fz * b.d;
    if (p.bulk && lx > p.bulk.x0 - 1 && lx < p.bulk.x1 + 1 && lz > p.bulk.z0 - 1 && lz < p.bulk.z1 + 1.6) continue;
    if (p.roof.props.some((q) => dmath.hypot(q.x - lx, q.z - lz) < dmath.hypot(ROOF_PROP_HALF[q.kind][0], ROOF_PROP_HALF[q.kind][2]) * (q.s ?? 1) + 0.9)) continue;
    const [x, z] = toWorld(b, lx, lz);
    if (skip.some((q) => dmath.hypot(q[0] - x, q[2] - z) < sep)) continue;
    return [x, p.roof.y, z];
  }
  return null;
}
/** LOOT_SPOTS (designed hints for the match generator): the statue's plinth, the plaza ring's rooftops, then
 *  ~one chest per building block and one floor spot per room from the furnished interiors */
export const LOOT_SPOTS = (() => {
  const chests: Array<[number, number, number, number]> = [];
  const [sx, sz] = toW(0, -FOUNTAIN_R - 1.0);
  chests.push([sx, Y + 0.12, sz, STATUE_YAW + Math.PI]);
  for (const id of ["C", "B", "D2", "F1"]) { const p = LAYOUT.parts[LAYOUT.ids[id]], r = p && roofSpot(p); if (r) chests.push([r[0], r[1], r[2], p.b.yaw]); }
  // the LOOKOUT TOWER's roof terrace = the town's high-risk payoff: the tallest perch in town (6 storeys, seen
  // from every street) holds two always-on chests and floor loot — climb the stair core under fire, win the rooftop
  const floor: Array<[number, number, number]> = [];
  {
    const p = LAYOUT.ids.TOWER !== undefined ? LAYOUT.parts[LAYOUT.ids.TOWER] : undefined;
    if (p) {
      const got: Array<[number, number, number]> = [];
      for (let k = 0; k < 2; k++) { const r = roofSpot(p, got, 2.6); if (r) { got.push(r); chests.push([r[0], r[1], r[2], p.b.yaw + k * Math.PI]); } }
      for (let k = 0; k < 2; k++) { const r = roofSpot(p, got, 1.8); if (r) { got.push(r); floor.push([r[0], r[1], r[2]]); } }
    }
  }
  return townLootSpots(INTERIOR_LOOT, { chests, floor });
})();

export const colliders: Box[] = [...simBoxes([...LAYOUT.parts.flatMap(buildingColliders), ...propColliders(), ...fountainColliders(FX, Y + 0.12, FZ, { R: FOUNTAIN_R, statueHeight: STATUE_H, statueYaw: STATUE_YAW }),
  ...LAYOUT.plinths.map((p): Box => ({ c: [p.x, (p.y0 + p.y1) / 2, p.z], h: [p.w / 2, (p.y1 - p.y0) / 2, p.d / 2], yaw: p.yaw, surf: "stone" }))]), ...INTERIORS.colliders];

/** areas vegetation / random scatter must leave clear (the POI dresses them itself) */
/** the north slope (plaza frame u -140..34, v 34..150) keeps the jungle off the view from the plaza to the lagoon */
export const SLOPE = { u0: -140, u1: 80, v0: 34, v1: 150 };
const slopeC = toW((SLOPE.u0 + SLOPE.u1) / 2, (SLOPE.v0 + SLOPE.v1) / 2);
/** the SEA WINDOW — the low shore between the slope houses and the lagoon on the left of the view is kept
 *  clear of tall trees, so the rooftop camera sees the turquoise bay upper-left (plaza frame) */
export const SEA_WINDOW = { u0: -175, u1: 25, v0: 150, v1: 245 };
const seaC = toW((SEA_WINDOW.u0 + SEA_WINDOW.u1) / 2, (SEA_WINDOW.v0 + SEA_WINDOW.v1) / 2);
export const clearings: Array<Clearing | { x: number; z: number; hx: number; hz: number; yaw?: number }> = [
  { x: CX, z: CZ, r: 140 },
  { x: slopeC[0], z: slopeC[1], hx: (SLOPE.u1 - SLOPE.u0) / 2, hz: (SLOPE.v1 - SLOPE.v0) / 2, yaw: HEAD },
  { x: seaC[0], z: seaC[1], hx: (SEA_WINDOW.u1 - SEA_WINDOW.u0) / 2, hz: (SEA_WINDOW.v1 - SEA_WINDOW.v0) / 2, yaw: HEAD },
];

export type { RoofProp };
