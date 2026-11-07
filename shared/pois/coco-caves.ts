// POI coco-caves — COCO CAVES: a sea-cave / lava-tube system inside a POI-owned rock massif on the west slope.
// Pure TS, deterministic: the ONE layout both the client visuals
// (client/src/world/pois/coco-caves/*) and the authoritative server colliders derive from.
//
// The heightfield cannot make caves, so the massif is built from ROCK boxes (hall walls in three tiers + outer shoulders,
// a domed roof of overlapping slabs, a ring of rim blocks round the skylight, tunnel walls + lintels, pillars, the den
// plinth + scaffold ledge, boulders, a raised pool bed, the crag mesa on top). The colliders ARE these boxes; the client
// draws the rock as ONE smooth signed-distance surface of their union (baked offline into
// public/assets/pois/caves/rock.bin), displaced by at most ±0.12 m where a kong can touch it (floors, walls up to 3.5 m
// above any walkable surface, box tops) and freely above — what you see is what you collide with. The floor is the
// natural terrain (the client lays a conforming sand / stone skin 4 cm over it).
//
// Plan (world metres, north = −z): the hall (≈ 68 × 70 m, ceiling 8–20 m) sits over a natural basin; a turquoise tidal
// pool (a wade, never deeper than BED_D) fills the basin and the valley arm to the east, held back from the mine mouth
// by a rock sill; a skylight opens above the north bank. Entrances: the WEST ARCH (sea side), the NORTH LAVA TUBE, the
// SOUTH-EAST MINE MOUTH, the SKYLIGHT (glide / drop in) and the HOIST TOWER (stairs from the north bank up through the
// skylight onto the plateau). The smugglers' DEN (2 floors + roof deck) stands on the knoll SW of the pool with its
// timber scaffold on a rock ledge; a two-storey mining gallery lines the north-west wall; the MINE OFFICE hut stands by
// the mine mouth (roof deck by an outside stair); crystals glow on the east wall and the banks; a lava fall pours down
// the north wall behind the tower; the CRAG mesa (stair to a lookout) marks the POI from the plane.
//
// CONVENTION: everything here is authored in three.js yaw (rotation.y — what the visuals use); the exported `colliders`
// negate it for the sim (Box.yaw = −rotation.y).
import type { Box, Surface } from "../world/colliders";
import { poiById } from "../world/map";
import { wallPieces, slabPieces, mulberry, type Opening } from "./town-kit";
import { interiorColliders, interiorLoot, type InteriorRoom } from "./interior-kit";
import * as dmath from "../sim/dmath";

const POI = poiById("coco-caves");
export const CX = POI.x, CZ = POI.z;
export type V2 = [number, number];
export type V3 = [number, number, number];

// ================================================================================================ ground (baked)
// @generated ground-begin (offline bake — terrain hash 3139013544)
const GROUND = { x0: -800, z0: -392, step: 2, nx: 76, nz: 72, cm: "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" };
// @generated ground-end
let grid: Int16Array | null = null;
function decodeB64(s: string): Uint8Array {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", out = new Uint8Array(Math.floor(s.length * 3 / 4));
  let o = 0;
  for (let i = 0; i + 3 < s.length; i += 4) {
    const n = (A.indexOf(s[i]) << 18) | (A.indexOf(s[i + 1]) << 12) | ((s[i + 2] === "=" ? 0 : A.indexOf(s[i + 2])) << 6) | (s[i + 3] === "=" ? 0 : A.indexOf(s[i + 3]));
    out[o++] = (n >> 16) & 255; if (s[i + 2] !== "=") out[o++] = (n >> 8) & 255; if (s[i + 3] !== "=") out[o++] = n & 255;
  }
  return out.subarray(0, o);
}
/** terrain height (== Terrain.height to the centimetre: the grid posts are the terrain's own samples and the same
 *  two-triangles-per-cell rule is used). Outside the baked patch: the nearest edge value. */
export function groundAt(x: number, z: number): number {
  if (!GROUND.nx) return 45;
  if (!grid) { const u8 = decodeB64(GROUND.cm); grid = new Int16Array(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength)); }
  const n = GROUND.nx, fx = Math.max(0, Math.min(n - 1.0001, (x - GROUND.x0) / GROUND.step)), fz = Math.max(0, Math.min(GROUND.nz - 1.0001, (z - GROUND.z0) / GROUND.step));
  const j = Math.floor(fx), i = Math.floor(fz), tx = fx - j, tz = fz - i, g = grid;
  const h00 = g[i * n + j] / 100, h01 = g[i * n + j + 1] / 100, h10 = g[(i + 1) * n + j] / 100, h11 = g[(i + 1) * n + j + 1] / 100;
  // global cell parity (terrain.ts): the patch origin sits on the global grid
  const gi = i + (GROUND.z0 + 1200) / GROUND.step, gj = j + (GROUND.x0 + 1200) / GROUND.step;
  if (((gi + gj) & 1) === 0) return tx >= tz ? h00 + (h01 - h00) * tx + (h11 - h01) * tz : h00 + (h10 - h00) * tz + (h11 - h10) * tx;
  return tx + tz <= 1 ? h00 + (h01 - h00) * tx + (h10 - h00) * tz : h11 + (h10 - h11) * (1 - tx) + (h01 - h11) * (1 - tz);
}
function groundMin(x0: number, z0: number, x1: number, z1: number, step = 1): number {
  let m = 1e9; for (let x = x0; x <= x1 + 1e-6; x += step) for (let z = z0; z <= z1 + 1e-6; z += step) m = Math.min(m, groundAt(x, z)); return m;
}
function groundMax(x0: number, z0: number, x1: number, z1: number, step = 1): number {
  let m = -1e9; for (let x = x0; x <= x1 + 1e-6; x += step) for (let z = z0; z <= z1 + 1e-6; z += step) m = Math.max(m, groundAt(x, z)); return m;
}
/** min / max ground under an oriented rect (local half extents hx, hz) */
function groundUnder(x: number, z: number, hx: number, hz: number, yaw: number, fn: "min" | "max", at: (x: number, z: number) => number = groundAt): number {
  const c = dmath.cos(yaw), s = dmath.sin(yaw); let m = fn === "min" ? 1e9 : -1e9;
  const nx = Math.max(1, Math.ceil(hx)), nz = Math.max(1, Math.ceil(hz));
  for (let a = -nx; a <= nx; a++) for (let b = -nz; b <= nz; b++) {
    const lx = hx * a / nx, lz = hz * b / nz, h = at(x + lx * c + lz * s, z - lx * s + lz * c);
    m = fn === "min" ? Math.min(m, h) : Math.max(m, h);
  }
  return m;
}

// ================================================================================================ key numbers
/** the tidal pool's surface (visual; the sim's water stays at sea level — the pool is a wade: bed ≥ WATER_Y − BED_D) */
export const WATER_Y = 44.3;
export const BED_D = 1.05;
/** skylight: centre, apothem of the rim ring, rim underside, rim top (== the hoist tower's top deck + 0.3) */
export const SKY = { x: -724, z: -336, r: 8.8, y0: 62.6, y1: 67.3 };   // (r 8.8: the opening reads from the plane)
/** hall interior outline (clockwise on a north-up map); OPEN = segment indices that are entrances */
export const HALL: V2[] = [
  // (the NE walls run inside the terrain area's 27 m cliff block at (−684, −339) so none of it shows in the hall)
  [-748, -346], [-738, -352], [-724, -355], [-712, -353], [-698, -351], [-701, -342], [-700, -334], [-692.5, -324.5], [-689, -316], [-690, -302],
  [-692.5, -293], [-700, -286], [-712, -284], [-726, -284], [-740, -285], [-750, -291], [-756, -301], [-758, -310], [-758, -322], [-756, -334],
];
export const OPEN = { north: 3, southeast: 10, west: 17 } as const;
/** the lava fall on the hall's north wall behind the hoist tower: a point on the wall's inner face, the inward normal,
 *  the fall's width at its foot and the crack's height */
export const LAVA = { x: -729.2, z: -353.9, nx: 0.2095, nz: 0.9778, w: 6.8, yTop: 60.0 };
export const HALL_C: V2 = [-721, -318];
/** the crag mesa on the north-west shoulder (landmark + lookout): centre, half extents, top */
export const CRAG = { x: -751, z: -340.7, hx: 8, hz: 7, y: 0 };
/** entrance tunnels: centreline a (hall side) → b (outside), clear width, clear height over the highest ground */
export const TUNNELS: Array<{ id: string; a: V2; b: V2; width: number; height: number }> = [
  { id: "west-arch", a: [-757, -316.1], b: [-773, -317.1], width: 10.5, height: 8.5 },     // the sea side
  { id: "lava-tube", a: [-705, -350], b: [-704, -371], width: 11, height: 8 },
  { id: "mine-mouth", a: [-696.2, -289.5], b: [-688.7, -274], width: 9.5, height: 7.5 },
];
/** wall thickness (massif shell) */
const WALL_T = 9;
/** massif top height (smooth — neighbouring roof slabs differ ≤ 0.55 m so the plateau is walkable from the rim) */
// (0.018 / m, ≤ 0.9 m, ±0.15 m swell: neighbouring roof boxes differ ≤ 0.25 m, so their tops' drawn
//  seams stay inside the parity tolerance; 0.035 / m gave 0.5 m box steps on the plateau)
export const topAt = (x: number, z: number) => SKY.y1 + Math.min(0.9, 0.018 * Math.max(0, dmath.hypot(x - SKY.x, z - SKY.z) - SKY.r - 3))
  + 0.15 * dmath.sin(x * 0.08 + 1.3) * dmath.sin(z * 0.1 + 0.4) * Math.min(1, Math.max(0, dmath.hypot(x - SKY.x, z - SKY.z) - SKY.r - 3) / 8);

export function insidePoly(poly: V2[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
/** distance from (x, z) to the hall outline (positive inside) */
export function hallDist(x: number, z: number): number {
  let d = 1e9;
  for (let i = 0; i < HALL.length; i++) {
    const [ax, az] = HALL[i], [bx, bz] = HALL[(i + 1) % HALL.length], dx = bx - ax, dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
    d = Math.min(d, dmath.hypot(x - ax - dx * t, z - az - dz * t));
  }
  return insidePoly(HALL, x, z) ? d : -d;
}

// ================================================================================================ rock
export type RockTag = "wall" | "roof" | "rim" | "tunnel" | "pillar" | "ledge" | "boulder" | "plinth" | "berm" | "bed" | "buttress" | "outcrop" | "lip";
export interface Rock {
  c: V3; h: V3; yaw: number; tag: RockTag;
  /** walkable-band precision on every face (boulders, ledges, plinths, bed, lips): visual within ±0.12 m */
  tight?: boolean;
  /** drawn (baked) but no collider — low boulder skirts (≤ 0.45 m): below the parity rays, auto-stepped by the sim
   *  anyway, and at the bake's 0.5 m voxels a box that low drew 0.2–0.4 m off its top (parity floor mismatches) */
  ghost?: boolean;
  /** NOT baked — the client models it (coco-caves/sculpt.ts: a chiselled rock round the box, within ±0.3 m of it).
   *  Boulder clusters + plateau outcrops: at the bake's 0.5 m voxels a 1.2–2 m rock can only be a rounded box. */
  sculpt?: boolean;
}
/** the sculpted rocks' colliders stand this far inside their drawn box (see assemble) */
export const SCULPT_IN = 0.06;
/** … and a small cap (min half side < 0.45 m) this far: its narrow top is a floor only where its rounded corners are drawn */
export const sculptIn = (h: V3) => (Math.min(h[0], h[2]) < 0.45 ? 0.12 : SCULPT_IN);
/** vertical clearances the roof dome must leave (the den's roof deck, the gallery, the scaffold) */
const CLEAR: Array<{ x: number; z: number; r: number; y: number }> = [
  { x: -739, z: -298, r: 10, y: 61.0 },       // den roof deck 57.4 + head room
  { x: -741.8, z: -347, r: 9, y: 57.0 },      // mining gallery
  { x: -736.5, z: -308, r: 8, y: 57.8 },      // west scaffold
];
/** roof underside (dome): 20 m over the pool, ≥ 7.5 m over the floor near the walls */
export function roofBottom(x: number, z: number): number {
  const d = dmath.hypot((x - HALL_C[0]) / 38, (z - HALL_C[1]) / 35);
  let y = 55.6 + 7.2 * Math.max(0, 1 - d * d);
  y = Math.max(y, groundAt(x, z) + 7.5);
  for (const c of CLEAR) { const k = dmath.hypot(x - c.x, z - c.z); if (k < c.r + 4) y = Math.max(y, c.y - Math.max(0, k - c.r) * 0.6); }
  return y;
}
CRAG.y = Math.round((topAt(CRAG.x, CRAG.z) + 9.5) * 100) / 100;

function segYaw(ax: number, az: number, bx: number, bz: number) { return dmath.atan2(-(bz - az), bx - ax); }
/** an oriented box along the segment a→b, offset `off` metres along the outward normal n (inner face), thickness t,
 *  extended past a / b by ext (one number, or [at a, at b]) */
function slabAlong(a: V2, b: V2, n: V2, off: number, t: number, ext: number | V2, y0: number, y1: number, tag: RockTag): Rock {
  const dx = b[0] - a[0], dz = b[1] - a[1], L = dmath.hypot(dx, dz), ux = dx / L, uz = dz / L;
  const [ea, eb] = typeof ext === "number" ? [ext, ext] : ext, sh = (eb - ea) / 2;
  const mx = (a[0] + b[0]) / 2 + ux * sh + n[0] * (off + t / 2), mz = (a[1] + b[1]) / 2 + uz * sh + n[1] * (off + t / 2);
  return { c: [mx, (y0 + y1) / 2, mz], h: [L / 2 + (ea + eb) / 2, (y1 - y0) / 2, t / 2], yaw: segYaw(a[0], a[1], b[0], b[1]), tag };
}
/** does an oriented rock box reach near a tunnel corridor? (shoulders that would are dropped: they made pits / ledges) */
/** split a slab into ~3 m FACETS along its length, each shifted in or out by up to ±j (along the slab's thickness),
 *  turned by up to ±0.07 rad and topped at a slightly different height — the SDF bake melts them into chiselled rock
 *  plates. The colliders ARE the facets, so a faceted wall stays collider-exact (unfaceted tight walls read as flat boxes). */
const facetRnd = mulberry(2718);
function facets(r: Rock, seg = 3.1, j = 0.32, dTop = 0): Rock[] {
  const L = r.h[0] * 2, n = Math.max(1, Math.round(L / seg)), c = dmath.cos(r.yaw), s = dmath.sin(r.yaw), out: Rock[] = [];
  for (let i = 0; i < n; i++) {
    const u = -r.h[0] + (i + 0.5) * L / n, dz = (facetRnd() * 2 - 1) * j, dyaw = (facetRnd() * 2 - 1) * 0.07, top = r.c[1] + r.h[1] + facetRnd() * dTop;
    const bot = r.c[1] - r.h[1];
    // local (u, dz) → world: x' = u·cos + dz·sin, z' = −u·sin + dz·cos (three yaw)
    out.push({ ...r, c: [r.c[0] + u * c + dz * s, (bot + top) / 2, r.c[2] - u * s + dz * c], h: [L / n / 2 + 0.35, (top - bot) / 2, r.h[2]], yaw: r.yaw + dyaw });
  }
  return out;
}
function hitsTunnel(r: Rock): boolean {
  const c = dmath.cos(r.yaw), s = dmath.sin(r.yaw);
  for (const t of TUNNELS) {
    const dx = t.b[0] - t.a[0], dz = t.b[1] - t.a[1], L = dmath.hypot(dx, dz), ux = dx / L, uz = dz / L;
    for (let i = -1; i <= 1; i += 0.25) for (let k = -1; k <= 1; k += 0.25) {
      const px = r.c[0] + i * r.h[0] * c + k * r.h[2] * s, pz = r.c[2] - i * r.h[0] * s + k * r.h[2] * c;
      const along = (px - t.a[0]) * ux + (pz - t.a[1]) * uz, across = Math.abs(-(px - t.a[0]) * uz + (pz - t.a[1]) * ux);
      if (along > -6 && along < L + 8 && across < t.width / 2 + 5.5) return true;
    }
  }
  return false;
}

function buildRocks(): Rock[] {
  const out: Rock[] = [], rnd = mulberry(1414);
  const N = HALL.length;
  // ---- hall walls: three tiers per segment. Tier 0 (the walkable band) has its inner face ON the outline; tiers 1 and
  // 2 overhang inward (a vaulted cave) from ≥ 6.5 m above the local floor (11.5 m where the gallery hugs the wall).
  // Outside: two shoulders step the massif down (a rock hill, not a drum).
  for (let i = 0; i < N; i++) {
    if (i === OPEN.north || i === OPEN.southeast || i === OPEN.west) continue;
    const a = HALL[i], b = HALL[(i + 1) % N];
    const dx = b[0] - a[0], dz = b[1] - a[1], L = dmath.hypot(dx, dz);
    let n: V2 = [dz / L, -dx / L];
    const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
    if ((mx - HALL_C[0]) * n[0] + (mz - HALL_C[1]) * n[1] < 0) n = [-n[0], -n[1]];
    let gIn = 0, gMin = 1e9;
    for (let k = 0; k <= 8; k++) { const t = k / 8, x = a[0] + dx * t, z = a[1] + dz * t; gIn += groundAt(x - n[0] * 1.5, z - n[1] * 1.5) / 9; for (let o = 0; o <= WALL_T; o += 3) gMin = Math.min(gMin, groundAt(x + n[0] * o, z + n[1] * o)); }
    const top = topAt(mx + n[0] * WALL_T / 2, mz + n[1] * WALL_T / 2);
    const o1 = (i <= 1 || i === N - 1) ? 11.5 : 6.5;   // north-west: the mining gallery runs along these walls
    // never run a wall past its end into an entrance (a ledge inside the tunnel mouth)
    const isOpen = (k: number) => k === OPEN.north || k === OPEN.southeast || k === OPEN.west;
    const E = (e: number): V2 => [isOpen((i + N - 1) % N) ? 0.2 : e, isOpen((i + 1) % N) ? 0.2 : e];
    out.push(...facets(slabAlong(a, b, n, 0, WALL_T, E(3.2), gMin - 3, gIn + o1 + 0.6, "wall")));
    const in1 = 0.6 + rnd() * 1.0, in2 = 1.6 + rnd() * 1.8;
    out.push(slabAlong(a, b, n, -in1, WALL_T + in1, E(2.4), gIn + o1, gIn + o1 + 5.5, "wall"));
    out.push(slabAlong(a, b, n, -in2, WALL_T + in2, E(2.0), gIn + o1 + 5, top, "wall"));
    let gOut = -1e9; for (let k = 0; k <= 6; k++) { const t = k / 6; for (const o of [WALL_T + 1, WALL_T + 6, WALL_T + 11]) gOut = Math.max(gOut, groundAt(a[0] + dx * t + n[0] * o, a[1] + dz * t + n[1] * o)); }
    const sh1 = Math.max(gOut + 2, top - 5.5 - rnd() * 3.5), sh2 = Math.max(gOut + 1.5, Math.min(sh1 - 4, gMin + 7 + rnd() * 4));
    const s1 = slabAlong(a, b, n, WALL_T - 1.5, 7 + rnd() * 2, 1.4 + rnd() * 1.5, gMin - 3, sh1, "buttress"), s2 = slabAlong(a, b, n, WALL_T + 4.6, 5 + rnd() * 2, 0.6 + rnd(), gMin - 3, sh2, "buttress");
    // (a shoulder whose top stands < 4.5 m over the ground round it is a ledge a kong reaches — its loose rounded top
    //  read 0.2–1.6 m off the box (parity): dropped, the wall behind it is the cliff)
    const rise = (r: Rock) => { const c = dmath.cos(r.yaw), sn = dmath.sin(r.yaw); let g = -1e9;
      for (let u = -1; u <= 1; u += 0.25) for (let v = -1.3; v <= 1.3; v += 0.25) { const lx = u * (r.h[0] + 1.5), lz = v * r.h[2]; g = Math.max(g, groundAt(r.c[0] + lx * c + lz * sn, r.c[2] - lx * sn + lz * c)); }
      return r.c[1] + r.h[1] - g; };
    if (sh1 > gOut + 2.5 && !hitsTunnel(s1) && rise(s1) > 4.5) out.push(s1);
    if (sh2 > gOut + 2 && !hitsTunnel(s2) && rise(s2) > 4.5) out.push(s2);
  }
  // ---- roof: overlapping slabs on a 7 m grid over the hall, underside = the dome, top = topAt; none over the skylight
  const [x0, z0, x1, z1] = [-762, -360, -680, -280];
  for (let x = x0; x <= x1; x += 7) for (let z = z0; z <= z1; z += 7) {
    const cx = x + 3.5, cz = z + 3.5;
    if (hallDist(cx, cz) < -3.5) continue;
    if (dmath.hypot(Math.max(0, Math.abs(cx - SKY.x) - 4.3), Math.max(0, Math.abs(cz - SKY.z) - 4.3)) < SKY.r + 0.8) continue;   // the rim ring covers the rest
    const yb = roofBottom(cx, cz), yt = topAt(cx, cz);
    out.push({ c: [cx, (yb + yt) / 2, cz], h: [4.3, (yt - yb) / 2, 4.3], yaw: 0, tag: "roof" });
  }
  // ---- skylight rim: 13 blocks tangent to a circle of apothem SKY.r, each pushed out 0–1.3 m and turned a little (a
  //  RAGGED opening, not a regular polygon)
  const rimRnd = mulberry(909);
  for (let k = 0; k < 13; k++) {
    const ang = (k + 0.5) * Math.PI * 2 / 13 + (rimRnd() - 0.5) * 0.12, nx = dmath.cos(ang), nz = dmath.sin(ang), t = 5.5, jr = rimRnd() * 1.3, L = 2 * (SKY.r + jr) * dmath.tan(Math.PI / 13) + 1.8;
    const cx = SKY.x + nx * (SKY.r + jr + t / 2), cz = SKY.z + nz * (SKY.r + jr + t / 2);
    // local x along the tangent (−nz, nx): (cos yaw, −sin yaw) = (−nz, nx) → yaw = atan2(−nx, −nz)
    out.push({ c: [cx, (SKY.y0 + SKY.y1) / 2 - rimRnd() * 0.4, cz], h: [L / 2, (SKY.y1 - SKY.y0) / 2, t / 2], yaw: dmath.atan2(-nx, -nz) + (rimRnd() - 0.5) * 0.16, tag: "rim" });
  }
  // ---- tunnels: two side walls + a lintel, level with the plateau
  const tunnel = (a: V2, b: V2, width: number, height: number, tag: RockTag = "tunnel") => {
    const dx = b[0] - a[0], dz = b[1] - a[1], L = dmath.hypot(dx, dz), ux = dx / L, uz = dz / L, px = -uz, pz = ux;
    const yaw = segYaw(a[0], a[1], b[0], b[1]);
    let gMin = 1e9, gMax = -1e9; for (let k = 0; k <= 10; k++) for (const s of [-1, 0, 1]) { const g = groundAt(a[0] + dx * k / 10 + px * s * width / 2, a[1] + dz * k / 10 + pz * s * width / 2); gMin = Math.min(gMin, g); gMax = Math.max(gMax, g); }
    for (const s of [-1, 1]) {
      const t = 7, off = width / 2 + t / 2, top = topAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      out.push(...facets({ c: [(a[0] + b[0]) / 2 + px * s * off, (gMin - 3 + top) / 2, (a[1] + b[1]) / 2 + pz * s * off], h: [L / 2 + 1, (top - gMin + 3) / 2, t / 2], yaw, tag }, 2.8, 0.3));
    }
    // (the lintel top sits 5 cm under the lowest plateau point along it — a mid-point top stood 0.2–0.5 m proud of
    //  the roof slabs at its hall end: parity floor mismatches on its edge row)
    const yb = gMax + height, yt = Math.min(...[0, 0.25, 0.5, 0.75, 1].map((u) => topAt(a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u))) - 0.05;
    out.push({ c: [(a[0] + b[0]) / 2, (yb + yt) / 2, (a[1] + b[1]) / 2], h: [L / 2 + 0.5, (yt - yb) / 2, width / 2 + 3], yaw, tag });
  };
  for (const t of TUNNELS) tunnel(t.a, t.b, t.width, t.height);
  // ---- pillars (floor to roof), the pool sill, the den plinth + scaffold ledge, the crag, the lava cleft, boulders
  const block = (x: number, z: number, hx: number, hz: number, yaw: number, y0: number, y1: number, tag: RockTag, tight = true, ghost = false, sculpt = tag === "boulder") => out.push({ c: [x, (y0 + y1) / 2, z], h: [hx, (y1 - y0) / 2, hz], yaw, tag, tight, ghost: ghost || undefined, sculpt: sculpt || undefined });
  block(-747.5, -325, 3.2, 2.6, 0.5, groundAt(-747.5, -325) - 2, roofBottom(-747.5, -325) + 2, "pillar", false);
  block((SILL.x0 + SILL.x1) / 2, SILL.z, (SILL.x1 - SILL.x0) / 2, 0.45, 0, groundMin(SILL.x0, SILL.z - 0.5, SILL.x1, SILL.z + 0.5) - 0.6, SILL.top, "lip");
  // den plinth: the knoll top raised to 0.3 m under the den's floor (the porch is planks laid on it)
  block(DEN.x, DEN.z, DEN.w / 2 + 1.3, DEN.d / 2 + 2.3, DEN.yaw, groundUnder(DEN.x, DEN.z, DEN.w / 2 + 1.3, DEN.d / 2 + 2.3, DEN.yaw, "min") - 1, DEN.y - 0.3, "plinth");
  // (the knoll's west flank — a 0.4 m terrace of terrain between a 2 m terrain step and the plinth was a
  //  "jump-only" pocket: this plinth rock runs over it)
  block(-746.5, -298.2, 0.95, 3.7, 0, groundMin(-747.5, -302, -745.5, -294.5) - 1, DEN.y - 0.3, "plinth");
  // the scaffold ledge: the knoll's rock runs on north as a promontory over the pool bank (the scaffold stands on it)
  block((LEDGE.x0 + LEDGE.x1) / 2, (LEDGE.z0 + LEDGE.z1) / 2, (LEDGE.x1 - LEDGE.x0) / 2, (LEDGE.z1 - LEDGE.z0) / 2, 0, groundMin(LEDGE.x0, LEDGE.z0, LEDGE.x1, LEDGE.z1) - 1, LEDGE.y, "plinth");
  // THE CRAG: a sheer rock mesa on the north-west shoulder (the landmark from the plane); a timber stair climbs its
  // south face to the lookout on top
  // (tight + faceted — a loose crag drew its top edge 0.3–0.6 m under the lookout's collider; the facets give it the
  //  sculpted silhouette instead of the ±0.75 m noise)
  out.push(...facets({ c: [CRAG.x, (topAt(CRAG.x, CRAG.z) - 4 + CRAG.y) / 2, CRAG.z], h: [CRAG.hx, (CRAG.y - topAt(CRAG.x, CRAG.z) + 4) / 2, CRAG.hz], yaw: 0, tag: "outcrop", tight: true }, 3.2, 0.55));
  // the lava cleft in the north wall: a tight plate flush with the wall face (a flat face for the fall) + a low rock lip
  // in front of the lava pool at its foot. Local x runs along the wall: (cos yaw, −sin yaw) = (−nz, nx)
  { const yw = dmath.atan2(-LAVA.nx, -LAVA.nz), g = groundAt(LAVA.x + LAVA.nx, LAVA.z + LAVA.nz);
    block(LAVA.x - LAVA.nx * 0.44, LAVA.z - LAVA.nz * 0.44, LAVA.w / 2 + 2, 0.5, yw, g - 2, LAVA.yTop + 1.5, "ledge");
    // (1.0 m thick — the 0.56 m lip fell between the bake's 0.5 m voxels: parity "invisible wall")
    block(LAVA.x + LAVA.nx * 1.52, LAVA.z + LAVA.nz * 1.52, LAVA.w / 2 + 0.4, 0.5, yw, g - 1, g + 0.55, "lip"); }
  // boulders: tall enough to hide behind, tops ≤ 1.9 × 1.2 m (in a covered cave a bigger top is a "jump-only floor")
  const boulders: Array<[number, number, number, number, number]> = [
    // x, z, half-x, half-z, height over the highest ground under it
    [-732, -330.5, 0.95, 0.6, 1.6], [-711, -327.5, 0.6, 0.95, 1.4], [-716, -303, 0.95, 0.6, 1.5], [-701, -318, 0.6, 0.95, 1.6],
    [-745, -313, 0.6, 0.95, 1.7], [-730, -291.5, 0.95, 0.6, 1.6], [-751, -318.5, 0.75, 0.5, 1.5],
    [-704.8, -346.6, 0.95, 0.6, 1.7], [-716, -292, 0.9, 0.6, 1.4], 
    [-706.3, -292.6, 0.95, 0.6, 1.5], [-763, -313, 0.6, 0.95, 1.5], [-702.6, -361.5, 0.95, 0.6, 1.5],
  ];
  // (hard cover ≤ 8 m everywhere): the open dune before the den, the north bank, the pool's
  // middle and the east bank get sculpted rock clusters (main block + apron + side chunk, see `cluster` below)
  const clusters: Array<[number, number, number, number, number]> = [
    [-721.2, -298.6, 0.95, 0.6, 1.7], [-715.6, -335.2, 1.1, 0.75, 1.6], [-719.4, -329.2, 0.9, 0.7, 1.5],
    [-701.4, -316.2, 0.95, 0.65, 1.6], [-708.8, -306.8, 0.8, 0.6, 1.5],
    // the regraded banks: the west shelf, the north bank, the south bank, the east islet
    [-740.6, -333.2, 0.95, 0.7, 1.6], [-713.2, -342.2, 0.95, 0.65, 1.6], [-711.6, -325.0, 0.85, 0.6, 1.5], [-716.4, -300.6, 0.9, 0.6, 1.5],
  ];
  // a boulder = a sculpted CLUSTER of 3 blocks the SDF bake melts together (k 0.3, 0.16 m edges): the main block, a low
  // apron turned against it and a side chunk — a faceted rock silhouette instead of one bevelled box
  const cluster = (x: number, z: number, hx: number, hz: number, h: number, yaw: number) => {
    const g = groundUnder(x, z, hx, hz, yaw, "min"), gmax = groundUnder(x, z, hx, hz, yaw, "max", floorAt);
    const c = dmath.cos(yaw), sn = dmath.sin(yaw), at = (lx: number, lz: number): V2 => [x + lx * c + lz * sn, z - lx * sn + lz * c];
    // the main block is 0.25 m lower and a smaller CAP turned 0.75 rad against it
    // crowns it (its top ≤ 1.2 × 0.8 m — no floor), so the silhouette steps and turns like a chiselled rock
    const capped = h >= 1.1, mainTop = gmax + h - (capped ? 0.25 : 0);
    block(x, z, hx, hz, yaw, g - 0.6, mainTop, "boulder");
    if (capped) { const [cx, cz] = at(hx * 0.12, -hz * 0.08); block(cx, cz, Math.min(0.6, hx * 0.62), Math.min(0.4, hz * 0.62), yaw + 0.75, g - 0.6, gmax + h, "boulder"); }
    if (h < 0.9) return;
    const [ax, az] = at(-hx * 0.35, hz * 0.55);
    // (the apron is a step ≤ 0.45 m, the side chunks low steps (a 0.6 m spire was below the bake's voxel size = invisible
    //  wall; a 1 m one a jump-only perch): none adds a standable "jump-only" top under the vault)
    const ag = groundUnder(ax, az, hx, hz, yaw + 0.55, "min", floorAt);   // (ghost skirts: 0.42 m over the LOWEST floor under them — on a beach slope the uphill side sinks in)
    // (the skirts are sculpted — drawn exactly, so they collide again: a ≤ 0.42 m step the sim walks up)
    block(ax, az, hx * 0.95, hz * 0.9, yaw + 0.55, groundUnder(ax, az, hx, hz, yaw + 0.55, "min") - 0.6, ag + 0.42, "boulder");
    const [bx, bz] = at(hx * 1.0, -hz * 0.2);
    const bg = groundUnder(bx, bz, hx * 0.6, hz * 0.8, yaw - 0.45, "min", floorAt);
    block(bx, bz, hx * 0.6, hz * 0.8, yaw - 0.45, groundUnder(bx, bz, hx * 0.6, hz * 0.8, yaw - 0.45, "min") - 0.6, bg + 0.4, "boulder");
  };
  for (const [x, z, hx, hz, h] of boulders) cluster(x, z, hx, hz, h, (x * 7 + z * 3) % 1.2);
  for (const [x, z, hx, hz, h] of clusters) cluster(x, z, hx, hz, h, (x * 5 + z * 2) % 1.4);
  // rocks breaking the pool's surface (small tops: never a "floor")
  for (const [x, z, hx, hz, above] of [[-717.5, -316.5, 0.7, 0.55, 0.55], [-729.5, -318.5, 0.6, 0.5, 0.35], [-712.5, -322.5, 0.55, 0.7, 0.7], [-697, -326, 0.6, 0.6, 0.5], [-706.5, -333.5, 0.5, 0.6, 0.3], [-724.1, -321.4, 0.7, 0.5, 1.8], [-704.6, -315.4, 0.8, 0.55, 1.45]] as Array<[number, number, number, number, number]>) {
    // (sculpted clusters too)
    cluster(x, z, hx, hz, WATER_Y + above - groundUnder(x, z, hx, hz, (x * 3 + z) % 1.3, "max", floorAt), (x * 3 + z) % 1.3);
  }
  // ---- pool: the wade bed + the shelving beaches (floor plates, see plateRocks)
  out.push(...plateRocks());
  // ---- plateau outcrops (hard cover on top; ≤ 1.45 m so a kong can jump onto them)
  const tops: Array<[number, number, number, number, number]> = [[-736, -324, 2.2, 1.6, 1.45], [-704, -326, 1.8, 2.2, 1.45], [-712.4, -302.3, 2.0, 1.5, 1.4], [-742, -300, 1.6, 1.8, 1.45], [-722, -352, 2.4, 1.4, 1.4], [-697.2, -312.6, 1.5, 1.5, 1.45], [-732, -310, 1.2, 1.4, 1.3], [-696, -295, 2.0, 1.6, 1.4]];
  for (const [x, z, hx, hz, h] of tops) { const y = topAt(x, z); block(x, z, hx, hz, (x + z) * 0.37, y - 1, y + h, "outcrop", true, false, true); }
  return out;
}

// ================================================================================================ pool
/** pool outline (the regraded basin — terrain 41 m in x −736.5…−704.5, z −336…−304 — plus the shallow east arm).
 *  The water is drawn inside it; where the floor is above WATER_Y (banks, islands) the floor hides it. */
export const POOL: V2[] = [[-737.6, -338.4], [-705.5, -338.8], [-699, -334.8], [-692.8, -326.9], [-688, -320.5], [-688, -303], [-700.4, -303], [-703.5, -302.7], [-737.6, -302.7]];
export const POOL_BOX = [-738, -339, -688, -302] as const;
/** shelving beaches (the pool's exits + the turquoise shallows): from a bank line (a → b, inward normal n,
 *  bank top) the floor drops 0.25 m per 1 m row (14°) down to the wade bed — tight rock plates under the sand skin. The
 *  line wanders (wave) so the shore reads scalloped, not ruled. */
const BEACHES: Array<{ a: V2; b: V2; n: V2; top: number; wave: number }> = [
  { a: [-737.5, -337.6], b: [-699.5, -337.6], n: [0, 1], top: 45.0, wave: 1.0 },      // the north beach (tower foot, lava path)
  { a: [-738.6, -336], b: [-738.6, -313.8], n: [1, 0], top: 45.6, wave: 0.8 },        // the west shelf (pillar, gallery, scaffold stair)
];
/** sand islands in the lagoon: flat top (radius r) shelving 0.25 m per metre into the wade (cover + the hero crystal) */
export const ISLANDS: Array<{ x: number; z: number; r: number; top: number }> = [
  { x: -710.8, z: -326.6, r: 1.9, top: 44.75 },
];
const BED_Y = WATER_Y - BED_D;
/** the floor plates on a 1 m grid: [cell → plate top] where the wade bed / a beach / an island rises over the terrain */
let plateGrid: Float32Array | null = null;
/** 0.5 m cells (even-metre bounds: the client's skin refines to 0.5 m in exactly this rect, crack-free on the terrain's
 *  2 m grid lines); rows rise 0.125 m per 0.5 m — the skin laid on the highest cell round each vertex is then ≤ 6 cm off */
export const PG = { x0: -740, z0: -340, nx: 106, nz: 80, cs: 0.5 };
function plates(): Float32Array {
  if (plateGrid) return plateGrid;
  const g = new Float32Array(PG.nx * PG.nz).fill(-1e9), h = PG.cs / 2;
  const q = (v: number) => Math.round(v * 1000) / 1000;
  for (let k = 0; k < PG.nz; k++) for (let i = 0; i < PG.nx; i++) {
    const x = PG.x0 + (i + 0.5) * PG.cs, z = PG.z0 + (k + 0.5) * PG.cs;
    const gs = [groundAt(x - h, z - h), groundAt(x + h, z - h), groundAt(x - h, z + h), groundAt(x + h, z + h), groundAt(x, z)];
    const gmin = Math.min(...gs), gmax = Math.max(...gs);
    let t = insidePoly(POOL, x, z) && gmin < BED_Y - 0.25 ? BED_Y : -1e9;
    for (const b of BEACHES) {
      const dx = b.b[0] - b.a[0], dz = b.b[1] - b.a[1], L = dmath.hypot(dx, dz), u = ((x - b.a[0]) * dx + (z - b.a[1]) * dz) / L;
      if (u < -0.5 || u > L + 0.5) continue;
      const d = (x - b.a[0]) * b.n[0] + (z - b.a[1]) * b.n[1] - b.wave * (1.2 * dmath.sin(u * 0.31 + 0.7) + 0.6 * dmath.sin(u * 0.83 + 2.1)); if (d < -1) continue;
      const top = q(b.top - 0.125 * (Math.floor(Math.max(0, d) / 0.5) + 1));
      if (top > BED_Y - 0.01 && top > gmin + 0.08) t = Math.max(t, top);
    }
    for (const il of ISLANDS) {
      const a = dmath.atan2(z - il.z, x - il.x), r = dmath.hypot(x - il.x, z - il.z) * (1 + 0.12 * dmath.sin(a * 3 + 1.1));
      const top = q(il.top - 0.125 * Math.ceil(Math.max(0, r - il.r) / 0.5));
      if (top > BED_Y - 0.01 && top > gmin + 0.08) t = Math.max(t, top);
    }
    // (a plate whose cell the bank's terrain overtops is lifted to it — parity: a box top buried in the terrain is no floor;
    //  ≤ 0.3 m, so the next row still steps up to it — or dropped when the bank is far higher)
    if (t > -1e8 && gmax > t + 0.04) t = gmax - t <= 0.3 ? Math.ceil(gmax * 40) / 40 : -1e9;
    g[k * PG.nx + i] = t;
  }
  return (plateGrid = g);
}
/** the plate top under (x, z) (−1e9 = none) */
export function plateAt(x: number, z: number): number {
  const i = Math.floor((x - PG.x0) / PG.cs), k = Math.floor((z - PG.z0) / PG.cs);
  return i < 0 || k < 0 || i >= PG.nx || k >= PG.nz ? -1e9 : plates()[k * PG.nx + i];
}
/** the walkable floor: the terrain or the floor plate over it (the bed in the pool, the beaches) */
export const floorAt = (x: number, z: number) => Math.max(groundAt(x, z), plateAt(x, z));
/** the plates as rock boxes: greedy rectangles of equal top (a few dozen boxes for the whole basin) */
function plateRocks(): Rock[] {
  const g = plates(), used = new Uint8Array(g.length), out: Rock[] = [], cs = PG.cs, N = PG.nx;
  for (let k = 0; k < PG.nz; k++) for (let i = 0; i < N; i++) {
    const t = g[k * N + i]; if (t < -1e8 || used[k * N + i]) continue;
    let w = 1; while (i + w < N && !used[k * N + i + w] && g[k * N + i + w] === t && w < 28) w++;
    let h = 1; grow: while (k + h < PG.nz && h < 28) { for (let a = 0; a < w; a++) if (used[(k + h) * N + i + a] || g[(k + h) * N + i + a] !== t) break grow; h++; }
    let gmin = 1e9; for (let a = 0; a < w; a++) for (let b = 0; b < h; b++) { used[(k + b) * N + i + a] = 1; gmin = Math.min(gmin, groundAt(PG.x0 + (i + a) * cs, PG.z0 + (k + b) * cs), groundAt(PG.x0 + (i + a + 1) * cs, PG.z0 + (k + b + 1) * cs)); }
    const y0 = gmin - 1.2;
    out.push({ c: [PG.x0 + (i + w / 2) * cs, (y0 + t) / 2, PG.z0 + (k + h / 2) * cs], h: [w * cs / 2, (t - y0) / 2, h * cs / 2], yaw: 0, tag: "bed", tight: true });
  }
  return out;
}
/** the rock sill that holds the pool back from the valley running on to the mine mouth */
export const SILL = { x0: -701.0, x1: -688.5, z: -303.0, top: WATER_Y + 0.42 };

// ================================================================================================ timber
/** a plank deck: centre, yaw, size (w along local x, d along local z), top height, thickness t; rails per side
 *  (0 = +z front, 1 = +x, 2 = −z back, 3 = −x) with optional spans [u0, u1] along the side; piles down to ground */
export interface CDeck { id: string; x: number; z: number; yaw: number; w: number; d: number; y: number; rails?: Partial<Record<0 | 1 | 2 | 3, boolean | V2[]>>; piles?: boolean; t?: number; kind?: "deck" | "jetty" | "bridge" | "landing" }
/** a straight stair rising along (sin yaw, cos yaw) from (x, z) at y0 to y1 (solid step blocks down to the ground when
 *  `ground`, else to y0 − 0.25) */
export interface CStair { id: string; x: number; z: number; yaw: number; width: number; y0: number; y1: number; tread?: number; ground?: boolean; rails?: boolean }
export interface CPost { a: V3; b: V3; r: number }

export const DEN = { x: -739, z: -297.2, yaw: Math.PI, w: 11, d: 8, y: 50.6, fh: 3.4, t: 0.26 };
export const OFFICE = { x: -697.5, z: -299.5, yaw: Math.PI * 0.62, w: 5.6, d: 4.4, y: 0, fh: 3.1, t: 0.22 };
OFFICE.y = Math.round((groundMax(-701, -303, -694, -296) + 0.28) * 100) / 100;

// ------------------------------------------------------------------------------------------------ buildings
export interface HutOpening extends Opening { side: 0 | 1 | 2 | 3; floor: number }
export interface HutSpec { id: string; x: number; z: number; yaw: number; w: number; d: number; y: number; fh: number; t: number; floors: number; roof: "deck" | "gable"; openings: HutOpening[];
  /** interior stair flights: along local x at local z, from x0 rising toward +x (dir 1) or −x (−1), from floor f to f+1 */
  flights: Array<{ z: number; x0: number; dir: 1 | -1; floor: number; width: number }>;
  /** interior partition walls (local, per floor) with a doorway */
  partitions: Array<{ floor: number; x0: number; z0: number; x1: number; z1: number; door: V2 }>;
  /** a gap in the roof-deck parapet (where an outside stair arrives): side, [u0, u1] along it */
  roofGap?: { side: 0 | 1 | 2 | 3; u: V2 };
}
export const GABLE_RISE = 1.5;
/** roof-deck parapet height: a kerb you can step over (a 1 m rail top would be a jump-only "floor" in a covered cave) */
export const PARAPET = 0.5;
export interface HutPiece { kind: "wall" | "slab" | "step" | "rail" | "part"; box: Box; floor: number; side?: number }

/** the den's two flights are 1.5 m wide (1.1 m — a capsule-and-a-half — made the loft and the roof deck read as
 *  unreachable) */
export const DEN_FW = 1.5;
export const HUTS: HutSpec[] = [
  { id: "den", ...DEN, floors: 2, roof: "deck",
    openings: [
      // GF: front door (east room) + windows, west door, back + east windows
      { side: 0, floor: 0, u: 7.3, w: 1.4, y: 0, h: 2.45, kind: "door" }, { side: 0, floor: 0, u: 1.3, w: 1.4, y: 1.0, h: 1.3, kind: "window" }, { side: 0, floor: 0, u: 9.3, w: 1.1, y: 1.0, h: 1.3, kind: "window" },
      { side: 1, floor: 0, u: 3.4, w: 1.3, y: 0, h: 2.45, kind: "door" },
      { side: 2, floor: 0, u: 7.2, w: 1.2, y: 1.1, h: 1.2, kind: "window" },
      { side: 3, floor: 0, u: 1.4, w: 1.2, y: 1.1, h: 1.2, kind: "window" },
      // 1F: balcony door (front), windows all round
      { side: 0, floor: 1, u: 4.1, w: 1.4, y: 0, h: 2.4, kind: "door" }, { side: 0, floor: 1, u: 1.0, w: 1.4, y: 1.0, h: 1.3, kind: "window" }, { side: 0, floor: 1, u: 7.4, w: 1.6, y: 1.0, h: 1.3, kind: "window" },
      { side: 1, floor: 1, u: 4.6, w: 1.3, y: 1.0, h: 1.3, kind: "window" },
      { side: 2, floor: 1, u: 2.0, w: 1.3, y: 1.1, h: 1.2, kind: "window" }, { side: 2, floor: 1, u: 7.8, w: 1.3, y: 1.1, h: 1.2, kind: "window" },
      { side: 3, floor: 1, u: 3.4, w: 1.3, y: 1.0, h: 1.3, kind: "window" },
    ],
    // back wall (local −z): flight A GF→1F rising +x from the west end, flight B 1F→roof rising −x from the east end
    flights: [{ z: -DEN.d / 2 + DEN.t + DEN_FW / 2 + 0.05, x0: -DEN.w / 2 + DEN.t + 0.2, dir: 1, floor: 0, width: DEN_FW }, { z: -DEN.d / 2 + DEN.t + DEN_FW / 2 + 0.05, x0: DEN.w / 2 - DEN.t - 0.3, dir: -1, floor: 1, width: DEN_FW }],
    partitions: [{ floor: 0, x0: 0.0, z0: -DEN.d / 2 + 1.85, x1: 0.0, z1: DEN.d / 2 - DEN.t, door: [1.6, 2.7] }],
  },
  { id: "office", ...OFFICE, floors: 1, roof: "deck",
    openings: [{ side: 0, floor: 0, u: 2.1, w: 1.35, y: 0, h: 2.4, kind: "door" }, { side: 1, floor: 0, u: 1.5, w: 1.3, y: 1.0, h: 1.2, kind: "window" }, { side: 3, floor: 0, u: 1.6, w: 1.3, y: 1.0, h: 1.2, kind: "window" }, { side: 2, floor: 0, u: 2.2, w: 1.3, y: 1.0, h: 1.2, kind: "window" }],
    flights: [], partitions: [], roofGap: { side: 1, u: [2.85, 4.4] },
  },
];

const SIDE_DEF: Array<{ A: (w: number, d: number) => V2; dir: V2; n: V2 }> = [
  { A: (w, d) => [-w / 2, d / 2], dir: [1, 0], n: [0, 1] },
  { A: (w, d) => [w / 2, d / 2], dir: [0, -1], n: [1, 0] },
  { A: (w, d) => [w / 2, -d / 2], dir: [-1, 0], n: [0, -1] },
  { A: (w, d) => [-w / 2, -d / 2], dir: [0, 1], n: [-1, 0] },
];
// ------------------------------------------------------------------ interiors (the shared interiors kit)
/** the den + mine office rooms for the interiors kit (interior-kit.ts): the kit furnishes them (furniture, trims,
 *  panelling, ceiling beams, lamps) and its colliders join ours. Room-local = the hut's local frame shifted to the room
 *  centre; y = the floor top; w / d = the inner wall faces. Stairs + stairwells are keep-outs (the approaches walkable). */
function hutRoom(h: HutSpec, id: string, lx0: number, lz0: number, lx1: number, lz1: number, floor: number, style: InteriorRoom["style"], role: InteriorRoom["role"], seed: number, openings: InteriorRoom["openings"], keepOut: InteriorRoom["keepOut"] = []): InteriorRoom {
  const cx = (lx0 + lx1) / 2, cz = (lz0 + lz1) / 2, [x, z] = hutToWorld(h, cx, cz);
  const sh = (k: typeof keepOut[number]) => { const r = Array.isArray(k) ? k : k.r, o: [number, number, number, number] = [Math.max(lx0, r[0]) - cx, Math.max(lz0, r[1]) - cz, Math.min(lx1, r[2]) - cx, Math.min(lz1, r[3]) - cz]; return Array.isArray(k) ? o : { r: o, walk: k.walk }; };
  return { id: `${h.id}-${id}`, x, y: h.y + floor * h.fh, z, yaw: h.yaw, w: lx1 - lx0, d: lz1 - lz0, h: h.fh - 0.28, style, role, seed, wallT: h.t,
    openings: openings.map((o) => ({ ...o, at: o.at - (o.side % 2 === 0 ? cx : cz) })), keepOut: (keepOut ?? []).map(sh),
    // (a plank ceiling — the pale plaster read as a white lid under the vault; narrow planks with
    //  real board lines on the floor instead of the wide "boards"; dark = under a vault: no window sun patches, dim fill)
    dark: true, finish: { wallMat: "panel", wall: "#a47a50", dado: "#5f4630", baseboard: true, ceiling: "planks", frames: true, glass: false, curtains: false, floor: "planks" } };
}
export const INTERIOR_ROOMS: InteriorRoom[] = (() => {
  const D = HUTS[0], O = HUTS[1], xi = D.w / 2 - D.t, zi = D.d / 2 - D.t, fz = D.flights[0].z, fh = DEN_FW / 2 + 0.17;   // den inner half extents, the stair strip
  const strip: [number, number, number, number] = [-xi, -zi, xi, fz + fh];
  return [
    // GF west: the smugglers' stash (racks, crates, barrels); flight A up the back wall from the west end
    hutRoom(D, "gf-w", -xi, -zi, -0.07, zi, 0, "warehouse", "storage", 141, [
      { side: 0, at: -3.5, w: 1.4, kind: "window", y0: 1.0, h: 1.3 }, { side: 3, at: -2.0, w: 1.2, kind: "window", y0: 1.1, h: 1.2 }, { side: 2, at: -2.3, w: 1.2, kind: "window", y0: 1.1, h: 1.2 },
      { side: 1, at: 0, w: 1.1, kind: "door" }, { side: 1, at: (-zi + -2.15) / 2, w: -2.15 + zi, kind: "gap" }],
      [strip, { r: [-xi, fz + fh, -xi + 1.4, fz + fh + 0.98], walk: true }]),
    // GF east: the boss's cabin (map table, sea chest, charts) by the front + side doors
    hutRoom(D, "gf-e", 0.07, -zi, xi, zi, 0, "cabin", "captain", 42, [
      { side: 0, at: 2.5, w: 1.4, kind: "door" }, { side: 0, at: 4.35, w: 1.1, kind: "window", y0: 1.0, h: 1.3 }, { side: 1, at: -0.05, w: 1.3, kind: "door" },
      { side: 3, at: 0, w: 1.1, kind: "door" }, { side: 3, at: (-zi + -2.15) / 2, w: -2.15 + zi, kind: "gap" }],
      [[0.07, -zi, 1.2, fz + fh]]),
    // 1F: the crew loft (bunks, hammocks, stove) over both; the back strip is the two stairwells
    hutRoom(D, "1f", -xi, -zi, xi, zi, 1, "hut", "bunk", 43, [
      { side: 0, at: -0.7, w: 1.4, kind: "door" }, { side: 0, at: -3.8, w: 1.4, kind: "window", y0: 1.0, h: 1.3 }, { side: 0, at: 2.7, w: 1.6, kind: "window", y0: 1.0, h: 1.3 },
      { side: 1, at: -1.25, w: 1.3, kind: "window", y0: 1.0, h: 1.3 }, { side: 2, at: 2.85, w: 1.3, kind: "window", y0: 1.1, h: 1.2 }, { side: 2, at: -2.95, w: 1.3, kind: "window", y0: 1.1, h: 1.2 },
      { side: 3, at: 0.05, w: 1.3, kind: "window", y0: 1.0, h: 1.3 }],
      [strip, { r: [-0.7, fz + fh, 0.7, fz + fh + 0.98], walk: true }, { r: [xi - 1.4, fz + fh, xi, fz + fh + 0.98], walk: true }]),
    // the mine office: the foreman's desk, map table, chart
    hutRoom(O, "office", -O.w / 2 + O.t, -O.d / 2 + O.t, O.w / 2 - O.t, O.d / 2 - O.t, 0, "cabin", "captain", 44, [
      { side: 0, at: -0.025, w: 1.35, kind: "door" }, { side: 1, at: 0.05, w: 1.3, kind: "window", y0: 1.0, h: 1.2 }, { side: 3, at: 0.05, w: 1.3, kind: "window", y0: 1.0, h: 1.2 },
      { side: 2, at: -0.05, w: 1.3, kind: "window", y0: 1.0, h: 1.2 }]),
  ];
})();
export function hutToWorld(h: { x: number; z: number; yaw: number }, lx: number, lz: number): V2 {
  const c = dmath.cos(h.yaw), s = dmath.sin(h.yaw); return [h.x + lx * c + lz * s, h.z - lx * s + lz * c];
}
function hutBox(h: HutSpec, lx0: number, lz0: number, lx1: number, lz1: number, y0: number, y1: number, surf: Surface = "wood"): Box {
  const [cx, cz] = hutToWorld(h, (lx0 + lx1) / 2, (lz0 + lz1) / 2);
  return { c: [cx, (y0 + y1) / 2, cz], h: [Math.abs(lx1 - lx0) / 2, (y1 - y0) / 2, Math.abs(lz1 - lz0) / 2], yaw: h.yaw, surf };
}
/** stair geometry of a flight: step count, rise, tread, run; hole in the slab above (local x range) — opened from 3
 *  steps before the head (+ the capsule's radius) would reach the slab's underside */
export function flightDims(h: HutSpec, f: HutSpec["flights"][number]) {
  const steps = Math.ceil(h.fh / 0.2), rise = h.fh / steps, tread = 0.27, run = steps * tread;
  const firstClash = Math.max(0, Math.floor((h.fh - 0.28 - 2.0) / rise) - 2);
  const hx0 = f.x0 + f.dir * firstClash * tread, hx1 = f.x0 + f.dir * (run + 0.05);
  return { steps, rise, tread, run, hole: [Math.min(hx0, hx1), Math.max(hx0, hx1)] as V2 };
}
/** every solid piece of a building (walls with openings, slabs with stair holes, step blocks, parapets, partitions) */
export function hutPieces(h: HutSpec): HutPiece[] {
  const out: HutPiece[] = [], t = h.t, H = h.floors * h.fh;
  for (let s = 0; s < 4; s++) {
    const S = SIDE_DEF[s], A = S.A(h.w, h.d), len = s % 2 === 0 ? h.w : h.d;
    for (let f = 0; f < h.floors; f++) {
      const ops = h.openings.filter((o) => o.side === s && o.floor === f);
      for (const pc of wallPieces(len, h.fh, ops)) {
        const u0 = pc.u, u1 = pc.u + pc.w;
        // wall rect in local coords: along dir from A, inset by t along −n
        const p0: V2 = [A[0] + S.dir[0] * u0, A[1] + S.dir[1] * u0], p1: V2 = [A[0] + S.dir[0] * u1 - S.n[0] * t, A[1] + S.dir[1] * u1 - S.n[1] * t];
        out.push({ kind: "wall", floor: f, side: s, box: hutBox(h, Math.min(p0[0], p1[0]), Math.min(p0[1], p1[1]), Math.max(p0[0], p1[0]), Math.max(p0[1], p1[1]), h.y + f * h.fh + pc.y, h.y + f * h.fh + pc.y + pc.h) });
      }
    }
  }
  // slabs: floor 0 (down to the ground / plinth), upper floors + the roof (deck roofs) with stair holes
  for (let f = 0; f <= h.floors; f++) {
    if (f === h.floors && h.roof !== "deck") { out.push({ kind: "slab", floor: f, box: hutBox(h, -h.w / 2, -h.d / 2, h.w / 2, h.d / 2, h.y + H - 0.2, h.y + H) }); continue; }
    const holes = h.flights.filter((fl) => fl.floor === f - 1).map((fl) => { const d = flightDims(h, fl); return { x0: d.hole[0], z0: fl.z - fl.width / 2 - 0.1, x1: d.hole[1], z1: fl.z + fl.width / 2 + 0.1 }; });
    const y = h.y + f * h.fh, th = f === 0 ? Math.max(0.35, y - groundUnder(h.x, h.z, h.w / 2, h.d / 2, h.yaw, "min") + 0.3) : 0.28;
    for (const r of slabPieces(-h.w / 2, -h.d / 2, h.w / 2, h.d / 2, holes)) out.push({ kind: "slab", floor: f, box: hutBox(h, r[0] - 0.01, r[1] - 0.01, r[2] + 0.01, r[3] + 0.01, y - th, y) });
  }
  // stair flights: one solid block per step (floor → step top)
  for (const fl of h.flights) {
    const d = flightDims(h, fl), y0 = h.y + fl.floor * h.fh;
    for (let i = 0; i < d.steps; i++) {
      const u = fl.x0 + fl.dir * (i + 0.5) * d.tread, top = y0 + (i + 1) * d.rise;
      out.push({ kind: "step", floor: fl.floor, box: hutBox(h, u - d.tread / 2 - 0.005, fl.z - fl.width / 2, u + d.tread / 2 + 0.005, fl.z + fl.width / 2, y0 - 0.02, top) });
    }
  }
  // roof-deck parapets (a step-over kerb), with the outside stair's gap
  if (h.roof === "deck") {
    const y = h.y + H;
    for (let sd = 0 as 0 | 1 | 2 | 3; sd < 4; sd = (sd + 1) as 0 | 1 | 2 | 3) {
      const S = SIDE_DEF[sd], A = S.A(h.w, h.d), len = sd % 2 === 0 ? h.w : h.d;
      const spans: V2[] = h.roofGap?.side === sd ? [[0, h.roofGap.u[0]], [h.roofGap.u[1], len]] : [[0, len]];
      for (const [u0, u1] of spans) {
        if (u1 - u0 < 0.1) continue;
        const p0: V2 = [A[0] + S.dir[0] * u0, A[1] + S.dir[1] * u0], p1: V2 = [A[0] + S.dir[0] * u1 - S.n[0] * 0.12, A[1] + S.dir[1] * u1 - S.n[1] * 0.12];
        out.push({ kind: "rail", floor: h.floors, box: hutBox(h, Math.min(p0[0], p1[0]), Math.min(p0[1], p1[1]), Math.max(p0[0], p1[0]), Math.max(p0[1], p1[1]), y, y + PARAPET) });
      }
    }
  }
  for (const p of h.partitions) {
    const len = dmath.hypot(p.x1 - p.x0, p.z1 - p.z0), alongX = Math.abs(p.x1 - p.x0) > Math.abs(p.z1 - p.z0);
    const y0 = h.y + p.floor * h.fh, y1 = y0 + h.fh - 0.28;
    const segs: V2[] = [[0, p.door[0]], [p.door[1], len]];
    for (const [u0, u1] of segs) {
      if (u1 - u0 < 0.05) continue;
      if (alongX) out.push({ kind: "part", floor: p.floor, box: hutBox(h, Math.min(p.x0, p.x1) + u0, p.z0 - 0.07, Math.min(p.x0, p.x1) + u1, p.z0 + 0.07, y0, y1) });
      else out.push({ kind: "part", floor: p.floor, box: hutBox(h, p.x0 - 0.07, Math.min(p.z0, p.z1) + u0, p.x0 + 0.07, Math.min(p.z0, p.z1) + u1, y0, y1) });
    }
    // lintel over the doorway
    const u0 = p.door[0], u1 = p.door[1];
    if (alongX) out.push({ kind: "part", floor: p.floor, box: hutBox(h, Math.min(p.x0, p.x1) + u0, p.z0 - 0.07, Math.min(p.x0, p.x1) + u1, p.z0 + 0.07, y0 + 2.3, y1) });
    else out.push({ kind: "part", floor: p.floor, box: hutBox(h, p.x0 - 0.07, Math.min(p.z0, p.z1) + u0, p.x0 + 0.07, Math.min(p.z0, p.z1) + u1, y0 + 2.3, y1) });
  }
  // gable roof: ridge along local x, terraced collider slabs (the sim cannot stand on pitched boxes)
  if (h.roof === "gable") {
    const rise = GABLE_RISE, y = h.y + H, ov = 0.45, span = h.d / 2 + ov, N = 5;
    for (const sg of [1, -1]) for (let k = 0; k < N; k++) {
      const a0 = k / N * span, a1 = (k + 1) / N * span, top = y + rise * (1 - (k + 0.5) / N) + 0.1;
      const lz0 = sg > 0 ? a0 : -a1, lz1 = sg > 0 ? a1 : -a0;
      out.push({ kind: "slab", floor: h.floors, box: hutBox(h, -h.w / 2 - ov, lz0, h.w / 2 + ov, lz1, top - 0.24, top, "metal") });
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ decks / stairs
const gTower = groundMax(-729.8, -340.8, -726.6, -333.2, 0.8);
/** the hoist tower inside the skylight (west part of the hole): switchback flights, landings, headframe on top
 *  (7 flights — the regraded bank is 5 m lower; base 47.4, a stair up from the north bank) */
export const TOWER = { x: -728.2, z: -337.0, w: 2.6, len: 7.2, yb: 0, rise: 2.8, flights: 7, gmax: gTower };
TOWER.yb = SKY.y1 - 0.3 - TOWER.rise * TOWER.flights;   // the top deck meets the rim (base ≥ ground)
export const GALLERY = { x: -741.8, z: -347.0, yaw: 0.54, y: 49.6, y2: 53.2 };
/** gallery frame: local x along the north-west wall, local +z toward the hall */
export const galleryW = (lx: number, lz: number): V2 => hutToWorld(GALLERY, lx, lz);
export const SCAFF = { y1: DEN.y - 0.3, y2: DEN.y + DEN.fh };
/** the rock promontory north of the den (the scaffold's footing), same height as the den plinth */
export const LEDGE = { x0: -739.2, x1: -733.2, z0: -313.0, z1: -303.2, y: DEN.y - 0.3 };

/** a stair whose TOP edge centre is (tx, tz), rising along yaw ((sin, cos) of yaw) to y1; from the ground when y0 is
 *  undefined (the foot is found by walking back until the step count agrees with the ground there) */
function stairTo(id: string, tx: number, tz: number, yaw: number, width: number, y1: number, y0?: number, o: { tread?: number; rails?: boolean } = {}): CStair {
  const tread = o.tread ?? 0.28, sx = dmath.sin(yaw), sz = dmath.cos(yaw);
  if (y0 !== undefined) { const n = Math.max(1, Math.ceil((y1 - y0) / 0.21 - 1e-6)); return { id, x: tx - sx * n * tread, z: tz - sz * n * tread, yaw, width, y0, y1, tread, rails: o.rails }; }
  let n = 1;
  for (let it = 0; it < 30; it++) { const g = floorAt(tx - sx * n * tread, tz - sz * n * tread), m = Math.max(1, Math.ceil((y1 - g) / 0.21 - 1e-6)); if (m === n) break; n = m; }
  return { id, x: tx - sx * n * tread, z: tz - sz * n * tread, yaw, width, y0: 0, y1, tread, ground: true, rails: o.rails };
}

function buildTimber() {
  const decks: CDeck[] = [], stairs: CStair[] = [], posts: CPost[] = [], panels: Box[] = [];
  const d1 = DEN.y + DEN.fh;
  // (in a fully covered cave every rail / parapet top is a "jump-only" floor — decks carry low kerbs instead,
  // only the tower in the open skylight shaft keeps full rails)
  // ---- the west scaffold: L2 (den first-floor level) over the rock ledge, a bridge to the den's first-floor balcony
  decks.push({ id: "scaff-l2", x: -736.2, z: -311.2, yaw: 0, w: 5.6, d: 3.6, y: d1, piles: true, kind: "deck" });
  decks.push({ id: "scaff-bridge", x: -737.7, z: -306.33, yaw: 0, w: 1.8, d: 6.05, y: d1, piles: true, kind: "bridge" });
  decks.push({ id: "den-balcony", x: -739.6, z: -302.3, yaw: 0, w: 5.8, d: 2.1, y: d1, kind: "deck" });
  stairs.push(stairTo("scaff-up", -734.0, -309.4, Math.PI, 1.1, d1, LEDGE.y, { tread: 0.27 }));
  stairs.push(stairTo("scaff-stair", -736.5, -313.0, 0, 1.5, LEDGE.y));
  // ---- the jetty into the pool (the foreground dock) + T head; the east pier into the arm
  decks.push({ id: "jetty", x: -723.5, z: -309.6, yaw: 0, w: 2.6, d: 8.4, y: WATER_Y + 0.5, piles: true, kind: "jetty", t: 0.62 });
  decks.push({ id: "jetty-head", x: -723.5, z: -314.9, yaw: 0, w: 6.4, d: 2.4, y: WATER_Y + 0.5, piles: true, kind: "jetty", t: 0.62 });
  decks.push({ id: "east-pier", x: -702.3, z: -333.2, yaw: 0, w: 2.2, d: 7.0, y: WATER_Y + 0.5, piles: true, kind: "jetty", t: 0.62 });   // (its north end meets the beach)
  // the east landing: from the east islet out over the lagoon, mooring posts at its head
  decks.push({ id: "east-landing", x: -705.3, z: -311.15, yaw: 0, w: 5.0, d: 2.2, y: WATER_Y + 0.5, piles: true, kind: "jetty", t: 0.62 });
  // landing steps from the jetty's root down into the wade (the regraded bank no longer reaches it)
  stairs.push(stairTo("jetty-steps", -723.5, -305.4, Math.PI, 1.6, WATER_Y + 0.5));
  // ---- the crag lookout: a timber stair up its south face from the plateau
  { let y0 = topAt(CRAG.x + 6, CRAG.z + CRAG.hz + 0.85); for (let it = 0; it < 3; it++) { const st = stairTo("crag-stair", CRAG.x + 3, CRAG.z + CRAG.hz + 0.85, -Math.PI / 2, 1.5, CRAG.y, y0); y0 = topAt(st.x, st.z); if (it === 2) stairs.push(st); } }
  // ---- north-west mining gallery: two storeys against the wall (frame yaw 0.54: local x along the wall)
  const G = GALLERY, g = galleryW, gy = G.yaw;
  { const [x, z] = g(0, 0); decks.push({ id: "gallery-1", x, z, yaw: gy, w: 12, d: 4, y: G.y, piles: true, kind: "deck" }); }
  { const [x, z] = g(-3.6, 0); decks.push({ id: "gallery-2", x, z, yaw: gy, w: 4.8, d: 4, y: G.y2, kind: "deck" }); }
  { const [x, z] = g(-1.2, 1.3); stairs.push(stairTo("gallery-up", x, z, gy - Math.PI / 2, 1.1, G.y2, G.y, { tread: 0.27 })); }
  { const [x, z] = g(2.8, 2.0); stairs.push(stairTo("gallery-stair", x, z, gy + Math.PI, 1.5, G.y)); }
  // ---- hoist tower: base crib, landings, top deck (+ the rim bridge)
  const T = TOWER, lane = T.w / 2, tz0 = T.z + T.len / 2, tz1 = T.z - T.len / 2;   // south end z0 (larger z), north end z1
  // the base is a solid timber crib down to the bank (no crawl gap under it)
  decks.push({ id: "tower-base", x: T.x, z: T.z, yaw: 0, w: T.w, d: T.len, y: T.yb, rails: {}, t: T.yb - groundMin(T.x - T.w / 2, T.z - T.len / 2, T.x + T.w / 2, T.z + T.len / 2, 0.5) + 0.3, kind: "landing" });
  for (let k = 1; k <= T.flights; k++) {
    const north = k % 2 === 1, y = T.yb + k * T.rise, zc = north ? tz1 + 0.75 : tz0 - 0.75;
    // (the landing under the top deck gets a boarded panel up to the deck on the top deck's side — a rail there left a
    //  head-height slot a jumping kong could wedge into. 7 flights end on the north landing, so the top deck runs
    //  along the WEST lane (over flight 5) and the panel is on the last south landing's west side)
    const underTop = k === T.flights - 1, px = north ? T.x + T.w / 2 - 0.05 : T.x - T.w / 2 + 0.05;
    const rails = north ? (underTop ? { 2: true, 3: true } : { 2: true, 1: true, 3: true }) : (underTop ? { 0: true, 1: true } : { 0: true, 1: true, 3: true });
    decks.push({ id: `tower-l${k}`, x: T.x, z: zc, yaw: 0, w: T.w, d: 1.5, y, rails, kind: "landing" });
    if (underTop) { const yTop = T.yb + T.flights * T.rise - 0.22; panels.push({ c: [px, (y + yTop) / 2, zc], h: [0.05, (yTop - y) / 2, 0.75], yaw: 0, surf: "wood" }); }
  }
  const topWest = T.flights % 2 === 1;
  decks.push({ id: "tower-top", x: T.x + (topWest ? -lane / 2 : lane / 2), z: T.z, yaw: 0, w: lane, d: T.len, y: T.yb + T.flights * T.rise, rails: topWest ? { 3: true } : { 1: true }, kind: "landing" });
  // (the bridge reaches 0.8 m onto the north rim whatever SKY.r is)
  const rimZ = SKY.z - Math.sqrt(Math.max(0, SKY.r * SKY.r - dmath.pow(T.x - SKY.x, 2))) - 0.8, bridgeD = tz1 - rimZ;
  decks.push({ id: "tower-rim", x: T.x, z: tz1 - bridgeD / 2, yaw: 0, w: T.w, d: bridgeD, y: T.yb + T.flights * T.rise, rails: { 1: true, 3: true }, kind: "bridge" });
  for (let k = 0; k < T.flights; k++) {
    const north = k % 2 === 0, y0 = T.yb + k * T.rise;
    // even flights: east lane rising north (yaw π); odd: west lane rising south (yaw 0); 14 × 0.2 m over 4.2 m
    if (north) stairs.push({ id: `tower-f${k}`, x: T.x + lane / 2, z: tz0 - 1.5, yaw: Math.PI, width: lane - 0.05, y0, y1: y0 + T.rise, tread: 0.3, rails: true });
    else stairs.push({ id: `tower-f${k}`, x: T.x - lane / 2, z: tz1 + 1.5, yaw: 0, width: lane - 0.05, y0, y1: y0 + T.rise, tread: 0.3, rails: true });
  }
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) posts.push({ a: [T.x + sx * (T.w / 2 + 0.14), T.gmax - 1.2, T.z + sz * (T.len / 2 + 0.14)], b: [T.x + sx * (T.w / 2 + 0.14), SKY.y1 + 4.2, T.z + sz * (T.len / 2 + 0.14)], r: 0.17 });
  // mooring posts at the jetty's corners (rope coils on them)
  for (const [x, z] of [[-726.85, -316.25], [-720.15, -316.25], [-725.0, -306.2], [-722.0, -306.2], [-708.05, -310.2], [-708.05, -312.1]] as V2[]) posts.push({ a: [x, groundAt(x, z) - 0.4, z], b: [x, WATER_Y + 1.25, z], r: 0.15 });
  // the crag lookout's flagpole (a BANANA CO. banner, visible from the plane)
  posts.push({ a: [CRAG.x - 5.5, CRAG.y - 0.5, CRAG.z - 4.5], b: [CRAG.x - 5.5, CRAG.y + 9, CRAG.z - 4.5], r: 0.14 });
  if (T.yb - floorAt(T.x, tz1 - 0.3) > 0.12) stairs.push(stairTo("tower-foot", T.x, tz1, 0, 2.0, T.yb));
  // ---- office door step + the roof stair (outside, along its +x side, arriving at the parapet gap at the back)
  { const [x, z] = hutToWorld(OFFICE, 0.075, OFFICE.d / 2 + 0.02); if (OFFICE.y - groundAt(x, z) > 0.3) stairs.push(stairTo("office-step", x, z, OFFICE.yaw + Math.PI, 1.6, OFFICE.y)); }
  { const [x, z] = hutToWorld(OFFICE, OFFICE.w / 2 + 0.72, -OFFICE.d / 2 + 0.55); stairs.push(stairTo("office-roof", x, z, OFFICE.yaw + Math.PI, 1.1, OFFICE.y + OFFICE.fh)); }
  return { decks, stairs, posts, panels };
}

// ================================================================================================ props / crystals / lamps
export type PropKind = "crate" | "crate-stack" | "barrel" | "boat" | "cart" | "table" | "shelf" | "bunk" | "chest-stand" | "sacks" | "drum" | "lantern-post" | "rails" | "stool" | "nuggets"
  // dressing (visual only, ≤ 0.45 m or soft): rope coils, draped nets, coin + gold heaps, 3D monstera / fern clumps
  | "coil" | "net" | "gold" | "monstera" | "fern";
export interface CProp { kind: PropKind; x: number; y: number; z: number; yaw: number; s?: number }
/** collider half extents at scale 1 (visuals must fit these; the boat is its floor — you stand IN it, not on the gunwales) */
export const PROP_HALF: Record<PropKind, V3 | null> = {
  crate: [0.5, 0.45, 0.5], "crate-stack": [0.55, 0.9, 0.55], barrel: [0.31, 0.5, 0.31], boat: [1.9, 0.2, 0.75], cart: [0.5, 0.6, 0.8], table: [0.9, 0.42, 0.55], shelf: [0.9, 1.0, 0.28], bunk: [1.0, 0.3, 0.5],
  "chest-stand": null, sacks: null, drum: [0.28, 0.48, 0.28], "lantern-post": [0.09, 1.2, 0.09], rails: null, stool: [0.2, 0.23, 0.2], nuggets: null, coil: null, net: null, gold: null, monstera: null, fern: null,
};
export interface Crystal { x: number; y: number; z: number; s: number; tilt: V2; n: number; seed: number; hero?: boolean }
export interface Lamp { x: number; y: number; z: number; color: string; power: number; kind: "crystal" | "lantern" | "lava" | "bounce" | "fill" }

function buildProps(): CProp[] {
  const props: CProp[] = [], add = (kind: PropKind, x: number, z: number, yaw = 0, y?: number, s?: number) => props.push({ kind, x, y: y ?? floorAt(x, z), z, yaw, s });
  const dy = DEN.y, d1 = DEN.y + DEN.fh;
  // (the den's two floors + the office are furnished by the interiors kit — INTERIOR_ROOMS; the roof deck keeps its cover)
  const L = (lx: number, lz: number): V2 => hutToWorld(DEN, lx, lz); let p: V2;
  p = L(-3.8, 2.4); add("crate-stack", p[0], p[1], 0.3, d1 + DEN.fh); p = L(3.9, -2.2); add("crate", p[0], p[1], -0.2, d1 + DEN.fh); p = L(1.2, 2.8); add("barrel", p[0], p[1], 0, d1 + DEN.fh);
  // scaffold + porch dressing
  add("crate", -738.0, -311.8, 0.2, SCAFF.y1); add("barrel", -734.5, -312.2, 0, SCAFF.y1); add("crate-stack", -738.3, -312.3, 0.35, SCAFF.y2);
  add("crate", -744.2, -302.6, 0.1, dy - 0.3); add("barrel", -742.6, -302.8, 0, dy - 0.3);
  // jetty: the boat moored alongside, a crate + drum on the head
  add("boat", -726.35, -310.4, Math.PI / 2 + 0.04, WATER_Y - 0.25); add("crate", -721.2, -315.2, 0.3, WATER_Y + 0.5); add("drum", -725.9, -315.3, 0, WATER_Y + 0.5);
  // gallery stash
  const G = galleryW;
  p = G(-5.0, -1.1); add("crate", p[0], p[1], GALLERY.yaw, GALLERY.y); p = G(1.0, -1.2); add("crate", p[0], p[1], GALLERY.yaw + 0.3, GALLERY.y); p = G(5.3, -1.1); add("barrel", p[0], p[1], 0, GALLERY.y);
  p = G(-5.2, -1.3); add("crate-stack", p[0], p[1], GALLERY.yaw, GALLERY.y2); p = G(-3.0, -1.4); add("sacks", p[0], p[1], GALLERY.yaw, GALLERY.y2);
  // hall floor cover: crate stacks + barrels round the pool
  add("crate-stack", -716.4, -338.6, 0.3); add("crate", -714.6, -339.5, 0.9); add("barrel", -718.6, -339.7);
  add("crate-stack", -709.2, -300.6, -0.2); add("crate", -707.6, -299.4, 0.5); add("sacks", -711.2, -299.1, 0.4);
  add("crate-stack", -729.8, -299.3, 0.1); add("barrel", -728.2, -300.8);
  add("crate", -747.8, -318.9, 0.6); add("barrel", -748.4, -316.9);
  add("crate-stack", -704.8, -340.2, 0.2); add("crate", -706.9, -341.3, 0.8);
  // mine mouth: rails + cart, crates
  add("rails", -692.5, -284.5, dmath.atan2(7.5, 15.5)); add("cart", -693.2, -286.2, dmath.atan2(7.5, 15.5)); add("crate-stack", -698.4, -281.6, 0.4); add("crate", -686.8, -287.9, 0.2);
  // office interior
  const O = (lx: number, lz: number): V2 => hutToWorld(OFFICE, lx, lz);
  void O;
  // west arch (sea entrance): a boat half sunk in the sand, crates
  add("boat", -768.5, -312.4, 1.2, groundAt(-768.5, -312.4) - 0.45); add("crate-stack", -765.2, -321.2, 0.3); add("barrel", -763.4, -322.4);
  // lava tube
  add("crate", -699.2, -357.4, 0.4); add("barrel", -698.4, -359.2); add("crate-stack", -707.9, -366.8, 0.2);
  // roof top: crates by the headframe
  add("crate-stack", -718.2, -344.8, 0.25, topAt(-718.2, -344.8)); add("crate", -730.5, -344.6, 0.3, topAt(-730.5, -344.6));
  // bank dressing: gold nugget piles (≤ 0.3 m, step-over, visual only) round the crystals + the jetty,
  // crates at the tower foot, more lantern posts lighting the path from the jetty over the north bank to the tower
  for (const [x, z, sc] of [[-713.2, -339.0, 1], [-719.8, -338.4, 0.8], [-733.6, -338.0, 1.1], [-697.8, -333.8, 1], [-737.6, -322.2, 0.9], [-701.0, -309.6, 1.2], [-708.2, -339.6, 0.7], [-737.4, -330.8, 0.8]] as V3[]) add("nuggets", x, z, x * 1.7, undefined, sc);
  add("nuggets", -721.6, -314.0, 0.4, WATER_Y + 0.5, 0.8);
  add("crate-stack", -724.6, -339.4, 0.5); add("barrel", -722.9, -340.2); add("crate", -732.2, -339.2, 1.1);
  // more dressing: the east landing, rope
  // coils + nets at the jetties, gold heaps by the crystals, 3D monstera / fern clumps on every bank
  add("crate", -706.4, -311.7, 0.35, WATER_Y + 0.5); add("coil", -707.5, -310.6, 0.4, WATER_Y + 0.5); add("net", -706.4, -311.7, 0.35, WATER_Y + 0.5 + 0.9);
  add("lantern-post", -703.6, -310.25, Math.PI, WATER_Y + 0.5);
  // more warm light along the water (lanterns all round the lagoon): the jetty head, the den porch,
  // the north beach by the tower foot
  add("lantern-post", -726.3, -314.0, 0, WATER_Y + 0.5); add("lantern-post", -720.7, -314.0, Math.PI, WATER_Y + 0.5);
  add("lantern-post", -744.2, -303.6, 0.4, DEN.y - 0.3); add("lantern-post", -734.0, -303.7, Math.PI - 0.4, DEN.y - 0.3);
  add("lantern-post", -730.8, -342.6, 0.9); add("lantern-post", -706.4, -337.6 - 1.4, 2.4);
  add("coil", -725.2, -314.6, 1.2, WATER_Y + 0.5); add("coil", -721.6, -306.6, 0.2, WATER_Y + 0.5); add("net", -720.9, -315.2, 0.3, WATER_Y + 0.5 + 0.9);
  for (const [x, z, sc] of [[-709.6, -328.6, 1.3], [-699.2, -334.8, 1.1], [-713.6, -340.6, 1.0], [-736.8, -339.6, 1.2], [-702.2, -309.2, 1.0], [-738.4, -323.6, 0.9]] as V3[]) add("gold", x, z, x * 1.3, undefined, sc);
  for (const [x, z, k, sc] of [[-701.6, -309.0, "monstera", 1.2], [-699.8, -313.6, "fern", 1.1], [-699.6, -312.4, "fern", 0.9], [-737.9, -326.6, "monstera", 1.1], [-738.6, -317.4, "fern", 1.0], [-716.0, -340.4, "monstera", 1.2], [-711.0, -340.6, "fern", 1.0], [-722.2, -338.4, "fern", 0.9], [-735.2, -339.8, "fern", 1.1], [-709.6, -300.4, "monstera", 1.0], [-712.6, -299.0, "fern", 1.0], [-698.8, -335.6, "monstera", 1.0], [-741.2, -331.0, "fern", 1.0], [-710.0, -324.6, "fern", 0.8]] as Array<[number, number, PropKind, number]>) add(k, x, z, x * 2.1, undefined, sc);
  // the east islet: a smugglers' cache
  add("crate-stack", -700.9, -312.9, 0.35); add("barrel", -700.4, -310.6);
  // the smugglers' stores along the north beach (barrels, a crate under a
  // net), gold spilling round the hero crystal and on the east landing, monstera / ferns on the island and the beaches
  add("barrel", -718.9, -341.4); add("barrel", -718.1, -342.3, 0.6); add("crate", -704.2, -341.6, 0.25); add("net", -704.2, -341.6, 0.25, floorAt(-704.2, -341.6) + 0.9); add("barrel", -703.0, -341.2);
  add("barrel", -735.6, -330.6); add("crate", -737.0, -329.0, 1.2);
  add("gold", -710.0, -328.6, 0.4, undefined, 1.2); add("gold", -713.6, -338.4, 2.1, undefined, 0.9); add("gold", -706.9, -311.4, 0.8, WATER_Y + 0.5, 0.7);
  add("monstera", -712.4, -327.6, 0.5, undefined, 1.0); add("monstera", -735.8, -337.9, 2.2, undefined, 1.2); add("monstera", -708.4, -301.9, 1.1, undefined, 1.1); add("fern", -731.2, -337.2, 0.3, undefined, 1.0);
  // the kit furnishes the rooms; along their walls the
  // smugglers' small stuff is added — gold heaps, ore nuggets, rope coils (≤ 0.3 m, visual only: stepped over) — on free
  // floor only: clear of doors / gaps, the keep-outs, every kit collider and every loot spot
  { const kit = interiorColliders(INTERIOR_ROOMS, { threeYaw: true }), loot = interiorLoot(INTERIOR_ROOMS);
    const lootPts: V2[] = [...loot.chests.map((q): V2 => [q[0], q[2]]), ...loot.floor.map((q): V2 => [q[0], q[2]])];
    const KINDS: Record<string, PropKind[]> = { storage: ["nuggets", "coil", "gold", "nuggets", "coil"], captain: ["gold", "coil", "gold", "nuggets", "gold"], bunk: ["coil", "gold", "nuggets", "coil", "gold"] };
    for (const r of INTERIOR_ROOMS) {
      const c = dmath.cos(r.yaw), s = dmath.sin(r.yaw), W = (lx: number, lz: number): V2 => [r.x + lx * c + lz * s, r.z - lx * s + lz * c];
      const cand: V2[] = [];
      for (const inset of [0.45, 0.8]) for (const side of [0, 1, 2, 3]) {
        const half = side % 2 === 0 ? r.w / 2 : r.d / 2, off = (side % 2 === 0 ? r.d / 2 : r.w / 2) - inset;
        for (let a = -half + 0.6; a <= half - 0.6; a += 0.5) {
          const lx = side === 0 || side === 2 ? a : side === 1 ? off : -off, lz = side === 1 || side === 3 ? a : side === 0 ? off : -off;
          if (r.openings.some((o) => o.side === side && o.kind !== "window" && Math.abs(o.at - a) < o.w / 2 + 0.7)) continue;
          if ((r.keepOut ?? []).some((k) => { const q = Array.isArray(k) ? k : k.r; return lx > q[0] - 0.4 && lx < q[2] + 0.4 && lz > q[1] - 0.4 && lz < q[3] + 0.4; })) continue;
          const [x, z] = W(lx, lz);
          if (kit.some((b) => { const yw = b.yaw ?? 0, cc = dmath.cos(yw), sn = dmath.sin(yw), dx = x - b.c[0], dz = z - b.c[2]; return b.c[1] - b.h[1] < r.y + 0.6 && Math.abs(dx * cc - dz * sn) < b.h[0] + 0.25 && Math.abs(dx * sn + dz * cc) < b.h[2] + 0.25; })) continue;
          if (lootPts.some((p) => dmath.hypot(p[0] - x, p[1] - z) < 0.9)) continue;
          cand.push([x, z]);
        }
      }
      const kinds = KINDS[r.role ?? ""] ?? KINDS.captain, picked: V2[] = [];
      for (const p of cand) { if (picked.length >= 5) break; if (picked.every((q) => dmath.hypot(q[0] - p[0], q[1] - p[1]) >= 1.3)) picked.push(p); }
      picked.forEach(([x, z], i) => add(kinds[i % kinds.length], x, z, (x * 3.1 + z) % 6.28, r.y, kinds[i % kinds.length] === "coil" ? 0.9 : 0.75));
    }
  }
  // lantern posts (lamps)
  for (const [x, z] of [[-737.7, -318.6], [-712, -339.7], [-701.4, -312.4], [-731.4, -338.9], [-700.6, -296], [-744.8, -336.5], [-703.6, -344.2], [-708.2, -364.5], [-765, -311.5], [-719.8, -338.2], [-737.7, -330.4], [-709.5, -298.6]]) add("lantern-post", x, z);
  return props;
}

function buildCrystals(): Crystal[] {
  const out: Crystal[] = [], rnd = mulberry(77);
  // (the hall's clusters 1.45×: big glowing gold heaps, 1–3 m)
  const c = (x: number, y: number, z: number, s: number, tx: number, tz: number, n = 7, hero = false) => out.push({ x, y, z, s: y < 62 ? s * 1.45 : s, tilt: [tx, tz], n, seed: Math.floor(rnd() * 1e6), hero });
  // the crystal grotto: the east wall, rising out of the water arm + clusters up the wall
  c(-692.8, floorAt(-693.0, -321.5) - 0.1, -321.5, 2.6, -0.55, 0.1, 11, true);
  c(-690.8, floorAt(-691.0, -314.5) - 0.1, -314.5, 1.9, -0.45, -0.25, 9, true);
  c(-689.6, 49.8, -312.5, 1.4, -0.8, 0.1, 7);
  c(-697.2, 52.8, -331.0, 1.6, -0.9, 0.2, 7);
  c(-701.6, 48.9, -339.0, 1.2, -0.6, 0.55, 6);
  // the pool's north-east bank + over the lava tube's mouth + the north wall toward the skylight
  c(-708.6, floorAt(-708.6, -327.4) - 0.1, -327.4, 2.1, -0.2, 0.35, 10, true);
  c(-712.8, 55.2, -352.6, 1.4, 0.1, 0.9, 7);
  c(-697.5, 52.5, -347.2, 2.0, -0.5, 0.6, 9, true); c(-699.6, 55.0, -336.5, 1.7, -0.8, 0.3, 8); c(-714.5, 58.8, -351.8, 1.5, 0.1, 0.9, 7);
  c(-719.0, 60.5, -345.0, 1.2, 0.2, 0.8, 6); c(-746.0, 54.0, -333.0, 1.4, 0.8, 0.2, 7);
  // west + north walls (smaller accents)
  c(-755.2, 50.5, -326.8, 1.2, 0.85, 0.1, 6); c(-744.9, 55.5, -349.1, 1.3, 0.4, 0.8, 7); c(-726.5, 56.0, -354.3, 1.0, 0.1, 0.9, 6);
  c(-703.2, 51.4, -350.9, 1.1, -0.3, 0.8, 6); c(-751.8, 48.6, -299.3, 1.0, 0.7, -0.5, 6);
  // the lava tube's walls
  c(-698.6, groundAt(-698.8, -364) + 2.2, -364.0, 1.0, -0.9, 0.0, 6);
  // on the crag + the plateau (the landmark: gold light on top, readable from the plane)
  c(CRAG.x - 4.5, CRAG.y - 0.2, CRAG.z - 3.5, 2.6, 0.1, -0.1, 11, true); c(CRAG.x + 5, CRAG.y - 0.2, CRAG.z - 4.5, 1.6, 0.3, 0.2, 8);
  c(-711.0, topAt(-711, -327) - 0.2, -327.0, 1.9, -0.2, 0.25, 9, true);
  // big gold clusters round the skylight on the plateau: the landmark's glow, readable from the plane
  for (const a of [0.5, 2.3, 4.1]) { const x = SKY.x + dmath.cos(a) * 14.5, z = SKY.z + dmath.sin(a) * 14.5; c(x, topAt(x, z) - 0.25, z, 4.2, dmath.cos(a) * 0.35, dmath.sin(a) * 0.35, 12, true); }
  // landmark: a crown of gold round the skylight's lip between the three giants — reads from the plane
  // (six round the lip)
  for (const a of [0.2, 1.4, 2.35, 3.2, 4.45, 5.3]) { const x = SKY.x + dmath.cos(a) * (SKY.r + 3.4), z = SKY.z + dmath.sin(a) * (SKY.r + 3.4); c(x, topAt(x, z) - 0.2, z, 2.5, dmath.cos(a) * 0.3, dmath.sin(a) * 0.3, 10, true); }
  c(-727.0, topAt(-727, -325.5) - 0.2, -325.5, 1.3, 0.3, -0.3, 7);
  return out;
}
/** one hexagonal crystal prism of a cluster: base centre, unit axis, body radius (bottom / top), length (the body runs
 *  0 … 0.74 len, the tip cone 0.74 … 1.04 len). The client draws exactly these (fx.ts) and the colliders box them. */
export interface Prism { x: number; y: number; z: number; d: V3; r: number; rt: number; len: number }
export function crystalPrisms(k: Crystal): Prism[] {
  const rnd = mulberry(k.seed), out: Prism[] = [];
  const ml = dmath.hypot3(k.tilt[0], 1, k.tilt[1]), main: V3 = [k.tilt[0] / ml, 1 / ml, k.tilt[1] / ml];
  for (let i = 0; i < k.n; i++) {
    const big = i < (k.hero ? 3 : 2);
    const len = k.s * (big ? 1.05 + rnd() * 0.45 : 0.4 + rnd() * 0.6), r = k.s * (big ? 0.19 + rnd() * 0.06 : 0.09 + rnd() * 0.07);
    // (the giants stand straighter — a tilted shard boxes loosely)
    const spread = big ? (k.s > 2.2 ? 0.14 : 0.28) : 0.75, a = rnd() * Math.PI * 2;
    const dx = main[0] + dmath.cos(a) * spread * rnd(), dz = main[2] + dmath.sin(a) * spread * rnd(), dl = dmath.hypot3(dx, main[1], dz);
    const rt = r * (0.8 + rnd() * 0.15), off = big ? 0.05 : 0.28;
    out.push({ x: k.x + dmath.cos(a) * k.s * off * rnd(), y: k.y - r * 0.4, z: k.z + dmath.sin(a) * k.s * off * rnd(), d: [dx / dl, main[1] / dl, dz / dl], r, rt, len });
  }
  return out;
}
/** is a cluster within reach of a kong (its base near the terrain, the plateau top or the crag top)? Out of reach
 *  (high on a wall) its boxes are shot-only (noWalk). */
export function crystalReachable(k: Crystal): boolean {
  const g = floorAt(k.x, k.z), t = topAt(k.x, k.z), onCrag = Math.abs(k.x - CRAG.x) < CRAG.hx && Math.abs(k.z - CRAG.z) < CRAG.hz;
  return Math.min(Math.abs(k.y - g), Math.abs(k.y - t)) < 1.6 || onCrag;
}
/** the crystal colliders are the drawn prisms — every prism ≥ 0.1 m thick as a chain of 0.5 m yaw-aligned boxes
 *  hugging its tilted axis (one 1.4 m core box per cluster left 3 m tall hero shards stood outside it = walk-through,
 *  and the core stood where no shard was drawn = invisible wall). Tops stay narrow (≤ 2 r), so no floor forms on a shard. */
export function crystalBoxes(k: Crystal): Box[] {
  const out: Box[] = [], noWalk = !crystalReachable(k) || undefined;
  // the root: the shards' bases crowd round the centre — one core box fills the gaps between them
  // (inside the shards' roots — a 0.4 s cube showed corners)
  out.push({ c: [k.x, k.y + k.s * 0.14, k.z], h: [k.s * 0.12, k.s * 0.14, k.s * 0.12], yaw: 0, surf: "glass", noWalk });
  for (const p of crystalPrisms(k)) {
    if (p.r < 0.1) continue;
    // (0.3 m segments on tilted shards — a yaw-only box round a tilted 0.5 m segment overhung the shard by 0.3 m+)
    const hl = dmath.hypot(p.d[0], p.d[2]), st = hl, ct = p.d[1], yaw = hl > 1e-4 ? dmath.atan2(-p.d[2], p.d[0]) : 0;
    // radius along the shard: body tapers r → rt over 0 … 0.74 len, the tip cone 0.8 r → 0 over 0.74 … 1.04 len (the hex's
    // corner radius; × 0.78: the square section sits 0.09 r inside the hex faces and 0.1 r past its corners)
    const rad = (t: number) => (t <= p.len * 0.74 ? p.r + (p.rt - p.r) * t / (p.len * 0.74) : p.r * 0.8 * Math.max(0, 1 - (t - p.len * 0.74) / (p.len * 0.3)));
    // (segments split at the body / tip seam, 0.3 m on tilted shards and in the tip, the MEAN radius per segment —
    //  the max radius over a segment straddling the seam boxed the narrow tip at the body's width: invisible walls)
    const segs: V2[] = [], seg = hl > 0.35 ? 0.3 : 0.5, Lb = p.len * 0.74, Lt = p.len * 1.04;
    { const n = Math.max(1, Math.ceil(Lb / seg)); for (let j = 0; j < n; j++) segs.push([Lb * j / n, Lb * (j + 1) / n]); }
    { const n = Math.max(1, Math.ceil((Lt - Lb) / 0.25)); for (let j = 0; j < n; j++) segs.push([Lb + (Lt - Lb) * j / n, Lb + (Lt - Lb) * (j + 1) / n]); }
    for (const [t0, t1] of segs) {
      const rm = (rad(t0) + rad(t1)) / 2, rho = rm * (rm > 0.55 ? 0.7 : 0.78); if (rho < 0.05) continue;   // (big shards: a 0.78 square poked out of the hex faces)
      const tm = (t0 + t1) / 2, h = (t1 - t0) / 2;
      out.push({ c: [p.x + p.d[0] * tm, p.y + p.d[1] * tm, p.z + p.d[2] * tm], h: [h * st + rho * ct, h * ct + rho * st, rho], yaw, surf: "glass", noWalk });
    }
  }
  return out;
}

function buildLamps(crystals: Crystal[], props: CProp[]): Lamp[] {
  const out: Lamp[] = [];
  for (const k of crystals) out.push({ x: k.x + k.tilt[0] * k.s * 0.8, y: k.y + k.s * 1.1, z: k.z + k.tilt[1] * k.s * 0.8, color: "#ffd452", power: 4.5 * k.s * k.s, kind: "crystal" });
  for (const p of props) if (p.kind === "lantern-post") out.push({ x: p.x, y: p.y + 2.2, z: p.z, color: "#ffd2a0", power: 5, kind: "lantern" });
  // den / gallery / tower / office / scaffold lanterns
  const gl = galleryW(0, -0.5);
  for (const [x, y, z] of [[-739, DEN.y + 2.6, -297], [-739, DEN.y + DEN.fh + 2.5, -297.5], [gl[0], GALLERY.y + 2.2, gl[1]], [-724, TOWER.yb + 8, -338.5], [-724, TOWER.yb + 14, -338.5], [-697.5, OFFICE.y + 2.4, -299.5], [-736.4, SCAFF.y2 + 2.0, -311.5]] as V3[]) out.push({ x, y, z, color: "#ffd2a0", power: 4.5, kind: "lantern" });
  // the lava fall's glow into the hall
  { const g = groundAt(LAVA.x + LAVA.nx * 2, LAVA.z + LAVA.nz * 2);
    out.push({ x: LAVA.x + LAVA.nx * 1.4, y: g + 3.5, z: LAVA.z + LAVA.nz * 1.4, color: "#ff5a18", power: 34, kind: "lava" });
    out.push({ x: LAVA.x + LAVA.nx * 3.5, y: g + 1.2, z: LAVA.z + LAVA.nz * 3.5, color: "#ff7a34", power: 14, kind: "lava" }); }
  // the sun patch on the pool / bank: warm-cyan bounce up into the hall (the skylight's one-bounce GI) + the shaft's fill
  const d = sunDrop(WATER_Y); out.push({ x: d[0], y: WATER_Y + 1.5, z: d[1], color: "#bdeee6", power: 70, kind: "bounce" });
  out.push({ x: SKY.x, y: SKY.y0 - 3, z: SKY.z, color: "#cfe6ff", power: 38, kind: "fill" });
  // (otherwise the mouths read near-black): daylight bouncing in off each tunnel's sunlit floor + walls — a soft cool
  // fill two thirds out and a warmer one at the inner end
  for (const t of TUNNELS) for (const [u, pw, c] of [[0.8, 30, "#dbe8ff"], [0.45, 18, "#e8e2d0"], [0.1, 10, "#e8dcc4"]] as Array<[number, number, string]>) {
    const x = t.a[0] + (t.b[0] - t.a[0]) * u, z = t.a[1] + (t.b[1] - t.a[1]) * u;
    out.push({ x, y: groundAt(x, z) + t.height * 0.45, z, color: c, power: pw, kind: "fill" });
  }
  return out;
}
/** the midday sun (atmos preset: elev 42°, az −32°), unit vector toward it */
export const SUN_DIR: V3 = [dmath.sin(-32 * Math.PI / 180) * dmath.cos(42 * Math.PI / 180), dmath.sin(42 * Math.PI / 180), -dmath.cos(-32 * Math.PI / 180) * dmath.cos(42 * Math.PI / 180)];
/** where the sun through the skylight's middle lands at height y */
export function sunDrop(y: number): V2 { const k = ((SKY.y0 + SKY.y1) / 2 - y) / SUN_DIR[1]; return [SKY.x - SUN_DIR[0] * k, SKY.z - SUN_DIR[2] * k]; }

// ================================================================================================ assemble
export const ROCKS = buildRocks();
export const TIMBER = buildTimber();
export const PROPS = buildProps();
export const CRYSTALS = buildCrystals();
export const LAMPS = buildLamps(CRYSTALS, PROPS);
/** fingerprint of everything the rock / light bake depends on (the bake stores it in the .bin files;
 *  the client warns when the bake is stale) */
export function bakeHash(): number {
  // (numbers rounded to 1e-5 — Chrome's and Node's V8 differ by 1 ulp in Math.atan2 for a few wall yaws, so the
  //  browser called a fresh bake stale)
  let h = 2166136261; const s = JSON.stringify([ROCKS, LAMPS, TIMBER.decks.length, HUTS.map((q) => [q.x, q.z, q.y])], (_k, v) => (typeof v === "number" ? Math.round(v * 1e5) / 1e5 : v));
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** the stair steps (solid blocks) — same numbers the client draws */
export function stairSteps(s: CStair): Array<{ box: Box; top: number }> {
  const out: Array<{ box: Box; top: number }> = [], tread = s.tread ?? 0.28;
  const y0 = s.ground ? floorAt(s.x, s.z) : s.y0;
  const n = Math.max(1, Math.ceil((s.y1 - y0) / 0.21 - 1e-6)), rise = (s.y1 - y0) / n;
  const c = dmath.cos(s.yaw), sn = dmath.sin(s.yaw);
  for (let i = 0; i < n; i++) {
    const lz = (i + 0.5) * tread, x = s.x + lz * sn, z = s.z + lz * c, top = y0 + (i + 1) * rise;
    const bottom = s.ground ? Math.min(groundUnder(x, z, s.width / 2, tread / 2, s.yaw, "min"), top) - 0.4 : s.y0 - 0.25;
    out.push({ box: { c: [x, (top + bottom) / 2, z], h: [s.width / 2, (top - bottom) / 2, tread / 2 + 0.006], yaw: s.yaw, surf: "wood" }, top });
  }
  return out;
}
/** start (bottom) of a stair: resolved foot height */
export const stairFoot = (s: CStair) => (s.ground ? floorAt(s.x, s.z) : s.y0);

/** low log kerbs along a deck's edges (decks / bridges without rails): step-over height; edges that meet another deck
 *  at the same height get none */
export const CURB_H = 0.18;
export function deckCurbs(k: CDeck): Box[] {
  if (k.rails && Object.keys(k.rails).length) return [];
  if (k.kind !== "deck" && k.kind !== "bridge") return [];
  const c = dmath.cos(k.yaw), s = dmath.sin(k.yaw), out: Box[] = [];
  const covered = (lx: number, lz: number) => { const x = k.x + lx * c + lz * s, z = k.z - lx * s + lz * c; return TIMBER.decks.some((o) => { if (o === k || Math.abs(o.y - k.y) > 0.3) return false; const oc = dmath.cos(o.yaw), os = dmath.sin(o.yaw), dx = x - o.x, dz = z - o.z, ox = dx * oc - dz * os, oz = dx * os + dz * oc; return Math.abs(ox) < o.w / 2 + 0.05 && Math.abs(oz) < o.d / 2 + 0.05; }); };
  const side = (lx: number, lz: number, hx: number, hz: number) => { if (!covered(lx + Math.sign(lx) * (hx < 0.1 ? 0.35 : 0), lz + Math.sign(lz) * (hz < 0.1 ? 0.35 : 0))) out.push({ c: [k.x + lx * c + lz * s, k.y + CURB_H / 2, k.z - lx * s + lz * c], h: [hx, CURB_H / 2, hz], yaw: k.yaw, surf: "wood" }); };
  if (k.kind === "bridge") { side(k.w / 2 - 0.08, 0, 0.08, k.d / 2); side(-k.w / 2 + 0.08, 0, 0.08, k.d / 2); }
  else { side(0, k.d / 2 - 0.08, k.w / 2, 0.08); side(0, -k.d / 2 + 0.08, k.w / 2, 0.08); side(k.w / 2 - 0.08, 0, 0.08, k.d / 2); side(-k.w / 2 + 0.08, 0, 0.08, k.d / 2); }
  return out;
}
export function deckBoxes(k: CDeck): Box[] {
  const out: Box[] = [], t = k.t ?? 0.22, c = dmath.cos(k.yaw), s = dmath.sin(k.yaw);
  out.push({ c: [k.x, k.y - t / 2, k.z], h: [k.w / 2, t / 2, k.d / 2], yaw: k.yaw, surf: "wood" });
  out.push(...deckCurbs(k));
  for (const [sideStr, spec] of Object.entries(k.rails ?? {})) {
    const side = +sideStr as 0 | 1 | 2 | 3; if (!spec) continue;
    const len = side % 2 === 0 ? k.w : k.d, spans: V2[] = spec === true ? [[0, len]] : spec as V2[];
    for (const [u0, u1] of spans) {
      const a = Math.max(0, u0), b = Math.min(len, u1); if (b - a < 0.2) continue;
      const um = (a + b) / 2 - len / 2;
      let lx = 0, lz = 0, hx = 0.05, hz = 0.05;
      if (side === 0) { lx = um; lz = k.d / 2 - 0.05; hx = (b - a) / 2; } else if (side === 2) { lx = um; lz = -k.d / 2 + 0.05; hx = (b - a) / 2; }
      else if (side === 1) { lx = k.w / 2 - 0.05; lz = um; hz = (b - a) / 2; } else { lx = -k.w / 2 + 0.05; lz = um; hz = (b - a) / 2; }
      out.push({ c: [k.x + lx * c + lz * s, k.y + 0.52, k.z - lx * s + lz * c], h: [hx, 0.52, hz], yaw: k.yaw, surf: "wood", noShoot: true });
    }
  }
  return out;
}
let pileAvoid: Box[] | null = null;
const inRock = (x: number, y: number, z: number) => ROCKS.some((r) => { const c = dmath.cos(r.yaw), s = dmath.sin(r.yaw), dx = x - r.c[0], dz = z - r.c[2], lx = dx * c - dz * s, lz = dx * s + dz * c; return Math.abs(lx) < r.h[0] && Math.abs(lz) < r.h[2] && Math.abs(y - r.c[1]) < r.h[1]; });
/** the highest solid rock-box top under (x, z) below y (−1e9 = none) */
const rockTopUnder = (x: number, z: number, y: number) => { let m = -1e9; for (const r of ROCKS) { if (r.ghost || r.tag === "bed") continue; const top = r.c[1] + r.h[1]; if (top > y || top < m) continue; const c = dmath.cos(r.yaw), s = dmath.sin(r.yaw), dx = x - r.c[0], dz = z - r.c[2], lx = dx * c - dz * s, lz = dx * s + dz * c; if (Math.abs(lx) < r.h[0] && Math.abs(lz) < r.h[2]) m = top; } return m; };
/** pile posts under a deck (visual + collider): at the corners and every ~2.4 m along the edges — never inside a stair's
 *  footprint (they blocked the gallery stairs) or inside rock */
export function deckPiles(k: CDeck): CPost[] {
  if (!k.piles) return [];
  pileAvoid ??= TIMBER.stairs.flatMap((st) => stairSteps(st).map((q) => q.box));
  const inStair = (x: number, z: number) => pileAvoid!.some((b) => { const c = dmath.cos(b.yaw ?? 0), s = dmath.sin(b.yaw ?? 0), dx = x - b.c[0], dz = z - b.c[2], lx = dx * c - dz * s, lz = dx * s + dz * c; return Math.abs(lx) < b.h[0] + 0.6 && Math.abs(lz) < b.h[2] + 0.6; });
  const out: CPost[] = [], c = dmath.cos(k.yaw), s = dmath.sin(k.yaw), t = k.t ?? 0.22;
  const nx = Math.max(1, Math.round(k.w / 2.4)), nz = Math.max(1, Math.round(k.d / 2.4));
  for (let i = 0; i <= nx; i++) for (let j = 0; j <= nz; j++) {
    if (i !== 0 && i !== nx && j !== 0 && j !== nz) continue;
    const lx = -k.w / 2 + 0.16 + (k.w - 0.32) * i / nx, lz = -k.d / 2 + 0.16 + (k.d - 0.32) * j / nz;
    const x = k.x + lx * c + lz * s, z = k.z - lx * s + lz * c;
    // (a pile stands on the highest rock top under the deck — the scaffold ledge — not on the pool bed 7 m below it)
    const g = Math.max(floorAt(x, z), rockTopUnder(x, z, k.y - t - 0.3));
    if (k.y - t - g < 0.25 || inStair(x, z) || inRock(x, k.y - t - 0.4, z)) continue;
    out.push({ a: [x, g - 0.4, z], b: [x, k.y - t, z], r: 0.13 });
  }
  return out;
}
/** a post's collider: one square, half side 0.8 r — the client draws the post as exactly this square timber (a round
 *  post round a square box either poked its corners out (invisible wall) or let grazing rays through (walk-through)) */
export const postHalf = (p: CPost) => p.r * 0.8;
export function postBoxes(p: CPost): Box[] {
  const a = postHalf(p);
  return [{ c: [(p.a[0] + p.b[0]) / 2, (p.a[1] + p.b[1]) / 2, (p.a[2] + p.b[2]) / 2], h: [a, Math.abs(p.b[1] - p.a[1]) / 2, a], yaw: 0, surf: "wood" }];
}

/** a railed stair's guards: one per side, stepped in three segments that follow the slope (noShoot; the client draws each
 *  as a boarded balustrade panel — rope + 3 posts gave a parity "invisible wall" beside the tower flights) */
export function stairRails(s: CStair): Box[] {
  if (!s.rails) return [];
  const steps = stairSteps(s), out: Box[] = [], n = steps.length, c = dmath.cos(s.yaw), sn = dmath.sin(s.yaw), tread = s.tread ?? 0.28;
  for (const sd of [-1, 1]) for (let seg = 0; seg < 3; seg++) {
    const i0 = Math.floor(seg * n / 3), i1 = Math.floor((seg + 1) * n / 3) - 1; if (i1 < i0) continue;
    const lz = (i0 + i1 + 1) / 2 * tread, lx = sd * (s.width / 2 + 0.05), top = steps[i1].top;
    out.push({ c: [s.x + lx * c + lz * sn, top + 0.5, s.z - lx * sn + lz * c], h: [0.05, 0.5 + (steps[i1].top - steps[i0].top) / 2, (i1 - i0 + 1) * tread / 2], yaw: s.yaw, surf: "wood", noShoot: true });
  }
  return out;
}
function assemble(): Box[] {
  const out: Box[] = [];
  // (a sculpted rock's collider is its box 0.06 m in on each side (a small cap's 0.12 m) — the client's chiselled
  //  rock never leaves its box, so it stands ≤ 0.06 m proud of the collider on flat faces and its corner chamfers / top
  //  bevels cut ≤ ~0.07 m past the collider's corners. Collider = the full box left grazing rays through the chamfered
  //  corners undrawn; any bulge past the collider tripped the parity check's 3 m ray end)
  for (const r of ROCKS) if (!r.ghost) out.push({ c: r.c, h: r.sculpt ? [r.h[0] - sculptIn(r.h), r.h[1], r.h[2] - sculptIn(r.h)] : r.h, yaw: r.yaw, surf: r.tag === "bed" ? "sand" : "stone" });
  for (const h of HUTS) for (const p of hutPieces(h)) out.push(p.box);
  for (const k of TIMBER.decks) { out.push(...deckBoxes(k)); for (const p of deckPiles(k)) out.push(...postBoxes(p)); }
  for (const s of TIMBER.stairs) {
    for (const st of stairSteps(s)) out.push(st.box);
    out.push(...stairRails(s));
  }
  for (const p of TIMBER.posts) out.push(...postBoxes(p));
  // the lava fall's sheet (0.3–0.9 m proud of the wall, fx.ts) — nobody walks into molten rock (parity: walk-through);
  // the braided stream's core only, flush with the sheet; 0.4 m deep: its top is no ledge a kong fits on
  { const g = groundAt(LAVA.x + LAVA.nx * 0.8, LAVA.z + LAVA.nz * 0.8);
    out.push({ c: [LAVA.x + LAVA.nx * 0.22, g + 2.5, LAVA.z + LAVA.nz * 0.22], h: [LAVA.w * 0.24, 2.8, 0.2], yaw: dmath.atan2(-LAVA.nx, -LAVA.nz), surf: "stone" }); }
  out.push(...TIMBER.panels);
  const surf = (p: CProp): Surface => (p.kind === "barrel" || p.kind === "drum" || p.kind === "cart" ? "metal" : p.kind === "sacks" ? "fabric" : "wood");
  for (const p of PROPS) {
    // (a crate stack = its two drawn crates — a 1.1 m crate + a 0.92 m one on top, both squared up — so no collider
    //  corner stands where no crate is drawn)
    // the boat: its floor + two gunwale walls (a kong stands IN it; the hull's sides stop bullets and walkers)
    // (measured on the drawn longboat (page raycasts): inner floor 0.3 m over p.y, ±0.45 m wide; gunwales ±0.5 m,
    //  top 0.72 m — ±0.66 m gunwales stood 0.16 m outside the hull = an underwater step box)
    if (p.kind === "boat") { const c = dmath.cos(p.yaw), sn = dmath.sin(p.yaw); out.push({ c: [p.x, p.y + 0.15, p.z], h: [1.75, 0.15, 0.44], yaw: p.yaw, surf: "wood" });
      for (const sd of [-1, 1]) out.push({ c: [p.x + sd * 0.47 * sn, p.y + 0.36, p.z + sd * 0.47 * c], h: [1.6, 0.36, 0.05], yaw: p.yaw, surf: "wood" }); continue; }
    if (p.kind === "crate-stack") { const sf = surf(p); out.push({ c: [p.x, p.y + 0.45, p.z], h: [0.55, 0.45, 0.55], yaw: p.yaw, surf: sf }, { c: [p.x, p.y + 0.9 + 0.42, p.z], h: [0.46, 0.42, 0.46], yaw: p.yaw, surf: sf }); continue; }
    const hh = PROP_HALF[p.kind]; if (!hh) continue; const k = p.s ?? 1;
    out.push({ c: [p.x, p.y + hh[1] * k, p.z], h: [hh[0] * k, hh[1] * k, hh[2] * k], yaw: p.yaw, surf: p.kind === "barrel" || p.kind === "drum" || p.kind === "cart" ? "metal" : p.kind === "sacks" ? "fabric" : "wood" });
  }
  for (const k of CRYSTALS) out.push(...crystalBoxes(k));
  // the kit's furniture (three yaw here: negated below). The kit boxes a sea chest to its full height over its whole
  // depth, but draws a half-round lid — the box's long edges stood 0.23 m over the lid (parity). Split: body + a lid band
  // ±0.6 of the depth (the lid is ≥ 0.92 h there). (itemLocalBoxes could do the same.)
  for (const b of interiorColliders(INTERIOR_ROOMS, { threeYaw: true })) {
    // the captain's treasure (box 0.8 of its 1.25 × 1.05 footprint, 0.5 m): the kit draws a coin heap (an ellipsoid
    // 0.525 × 0.275 × 0.48 at local (0.05, 0.05)) and an open chest (0.62 × 0.3 × 0.36 at local (−0.1, −0.325)) — boxed
    // as those two
    if (Math.abs(b.h[0] - 0.5) < 0.01 && Math.abs(b.h[1] - 0.25) < 0.01 && Math.abs(b.h[2] - 0.42) < 0.01) {
      const y0 = b.c[1] - 0.25, yw = b.yaw ?? 0, c = dmath.cos(yw), sn = dmath.sin(yw), W = (lx: number, lz: number): V2 => [b.c[0] + lx * c + lz * sn, b.c[2] - lx * sn + lz * c];
      const hp = W(0.05, 0.05), ch = W(-0.1, -0.325);
      out.push({ ...b, c: [hp[0], y0 + 0.1, hp[1]], h: [0.37, 0.1, 0.34] }, { ...b, c: [ch[0], y0 + 0.15, ch[1]], h: [0.31, 0.15, 0.18] });
      continue;
    }
    if (Math.abs(b.h[0] - 0.5) < 0.01 && Math.abs(b.h[1] - 0.3) < 0.01 && Math.abs(b.h[2] - 0.28) < 0.01) {
      const y0 = b.c[1] - 0.3, bodyH = 0.6 * 0.62;
      out.push({ ...b, c: [b.c[0], y0 + bodyH / 2, b.c[2]], h: [0.5, bodyH / 2, 0.28] }, { ...b, c: [b.c[0], y0 + bodyH + (0.6 - bodyH) / 2, b.c[2]], h: [0.5, (0.6 - bodyH) / 2, 0.28 * 0.6] });
    } else out.push(b);
  }
  return out;
}

/** the server's colliders. Everything above is authored in three.js yaw (rotation.y, the visuals'); the sim rotates a
 *  box the other way (Box.yaw = −rotation.y), so the yaw is negated here. */
export const colliders: Box[] = assemble().map((b) => (b.yaw ? { ...b, yaw: -b.yaw } : b));

/** vegetation keep-out: the whole massif (+2 m) — the POI plants its own greenery on the roof and inside */
export const clearings: Array<{ x: number; z: number; r: number } | { x: number; z: number; hx: number; hz: number; yaw?: number }> = [
  { x: -721, z: -318, r: 48 }, { x: -760, z: -300, r: 20 }, { x: -760, z: -338, r: 20 }, { x: -740, z: -362, r: 16 }, { x: -706, z: -366, r: 17 },
  { x: -684, z: -348, r: 16 }, { x: -676, z: -318, r: 14 }, { x: -684, z: -290, r: 14 }, { x: -712, z: -276, r: 14 }, { x: -742, z: -278, r: 14 }, { x: -773, z: -317, r: 10 },
  // (a trunk cluster forming a glider-only "roof" and a trunk embed, both inside the POI circle)
  { x: -642, z: -246, r: 5 }, { x: -623.6, z: -306.2, r: 2.5 },
  // (a veg-trunk pen on the east slope (−636, 86, −342) and a terrain-rock overhang over a step NE of the
  //  lava tube (−671, 58, −374) — clearings are also terrain-rock keep-outs, shared/world/rock-keeps.ts)
  { x: -636, z: -342, r: 4.5 }, { x: -671, z: -374.5, r: 5.5 },
];

// ================================================================================================ loot
/** designed loot (the LOOT_SPOTS contract): chests [x, y, z, yaw], floor [x, y, z]; y = the floor under them */
/** the kit's floor slots in the den / office sat 3 cm against a furniture box:
 *  step each one out (≤ 0.4 m) to where a 0.36 m disc of loot clears every box between 3 cm and 0.6 m over its floor */
function clearOfFurniture(f: [number, number, number]): [number, number, number] {
  const near = colliders.filter((b) => Math.abs(b.c[0] - f[0]) < 3 && Math.abs(b.c[2] - f[2]) < 3 && b.c[1] + b.h[1] > f[1] + 0.03 && b.c[1] - b.h[1] < f[1] + 0.6);
  const fits = (x: number, z: number) => near.every((b) => { let dx = x - b.c[0], dz = z - b.c[2]; if (b.yaw) { const c = dmath.cos(b.yaw), sn = dmath.sin(b.yaw); const u = dx * c + dz * sn, v = -dx * sn + dz * c; dx = u; dz = v; } const qx = Math.max(0, Math.abs(dx) - b.h[0]), qz = Math.max(0, Math.abs(dz) - b.h[2]); return qx * qx + qz * qz >= 0.4 * 0.4; });
  if (fits(f[0], f[2])) return f;
  for (const r of [0.1, 0.2, 0.3, 0.4]) for (let k = 0; k < 12; k++) { const a = (k / 12) * Math.PI * 2, x = f[0] + r * dmath.cos(a), z = f[2] + r * dmath.sin(a); if (fits(x, z)) return [x, f[1], z]; }
  return f;
}
export const LOOT_SPOTS: { chests: Array<[number, number, number, number]>; floor: Array<[number, number, number]> } = (() => {
  const chests: Array<[number, number, number, number]> = [], floor: Array<[number, number, number]> = [];
  const D = (lx: number, lz: number, f: number, yaw = 0) => { const [x, z] = hutToWorld(DEN, lx, lz); chests.push([x, DEN.y + f * DEN.fh, z, DEN.yaw + yaw]); };
  // the ORDER makes the payoffs — loot-spots turns the first listed chest standing in a room into the POI's VAULT
  // (always live, vault rarity) and the next two designed chests outside rooms into its always-live landmark chests.
  // The den's captain's room (GF east) is the vault; the hoist tower's top (the climb out of the skylight) and the
  // gallery's upper deck are the landmarks — three sure chests INSIDE the caves.
  { const K = interiorLoot(INTERIOR_ROOMS); chests.push(...K.chests.slice(1, 2)); floor.push(...K.floor.map(clearOfFurniture));
    // tower top / rim bridge (on the bridge deck — the wider skylight moved the rim off it)
    chests.push([TOWER.x - 0.2, TOWER.yb + TOWER.flights * TOWER.rise, TOWER.z - TOWER.len / 2 - 1.9, 0]);
    { const [x, z] = galleryW(-3.4, -0.55); chests.push([x, GALLERY.y2, z, GALLERY.yaw]); }                // gallery upper
    D(-0.8, -2.6, 2);                                                                                     // den roof deck
    // den GF west / 1F + the mine office: the interiors kit's own slots (free of its furniture, reachable from the doors)
    chests.push(K.chests[0], ...K.chests.slice(2)); }
  chests.push([-702.6, floorAt(-702.6, -338.2), -338.2, Math.PI / 2]);                                  // crystal grotto shore
  chests.push([CRAG.x - 2, CRAG.y, CRAG.z - 1, 0]);                                                       // the crag lookout (landmark)
  chests.push([-708.6, groundAt(-708.6, -362.5), -362.5, -Math.PI / 2]);                                 // lava tube
  chests.push([-723.6, WATER_Y + 0.5, -315.3, 0]);                                                       // jetty head
  chests.push([-766.6, groundAt(-766.6, -316.2), -316.2, Math.PI / 2]);                                  // west arch
  chests.push([-735.0, SCAFF.y2, -312.0, 0]);                                                            // scaffold L2
  const F = (x: number, z: number, y?: number) => floor.push([x, y ?? floorAt(x, z), z]);
  F(-737.8, -305.2, SCAFF.y1); { const [x, z] = galleryW(3.8, -0.4); F(x, z, GALLERY.y); } F(-723.5, -309.0, WATER_Y + 0.5); F(-702.3, -331.8, WATER_Y + 0.5);
  F(-711.5, -339.6); F(-703.4, -339.4); F(-737.6, -332.3); F(-716.8, -296.5); F(-744.0, -306.0); F(-705.6, -300.8);
  F(-701.2, -310.2); F(-693.8, -280.6); F(-759.6, -312.4); F(-706.2, -357.0); F(-727.5, -290.0); F(-750.5, -330.0);
  // (plateau spots on the roof box actually under them — topAt is the box CENTRE height, off by up to 0.3 m)
  for (const [x, z] of [[-722.0, -348.0], [-744.0, -318.0], [-703.0, -304.0]] as V2[]) F(x, z, rockTopUnder(x, z, 90));
  return { chests, floor };
})();

// ================================================================================================ view camera
/** view camera: on the island in the pool's east arm, looking west-north-west over the pool at the skylight
 *  (tower, god rays), the lava fall behind, the den scaffold on the left, the crystal bank on the right */
// (the pool fills the lower half, the boat + jetty in frame)
// (the regraded basin is all lagoon — the camera 4 m over the water at the east bank, the den scaffold left, the
//  tower shaft centre, the lava fall right of the tower, the island's hero crystal in the right foreground)
// (fov 70 — more lagoon in frame, the skylight still in it)
export const VIEW = { pos: [-702.4, 48.9, -307.6] as V3, target: [-731.5, 46.4, -329.5] as V3, fov: 70 };
