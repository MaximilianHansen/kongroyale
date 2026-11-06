// poi-jungle — MIST FALLS + the jungle river (biome-06). Pure math shared by the client (visuals) and the server
// (colliders). WORLD coordinates. The terrain area carves the bowl + gorge + river bed (shared/world/terrain-gen.ts
// FALLS / RIVER: pool bowl centre (−150,−395) floor ≈ 19.5, lip (−192,−412) ≈ 60, river pool → NE lagoon); this area
// builds everything on it: the cliff wall the falls pour over (stacked sculpted rock blocks), the north bluff with its
// walkway + hoist pillar, the plunge pool + river water, the rope bridges, the lookout, the canoe, boulders.
// Terrain-dependent heights resolve through `h(x, z)` ONCE in an offline bake (island.bin) → FallsResolved in
// shared/pois/jungle-baked.json; the server colliders and the client visuals are both built from that baked data.
import type { Box } from "../world/colliders";
import rockProfiles from "./jungle-rock-profiles.json";
import { peakTrail, trailBoxes, type TrailStep } from "./jungle-layout";
import { LADDERS } from "./ladders";
import { pathLines } from "../world/terrain-gen";
import * as dmath from "../sim/dmath";

export type H = (x: number, z: number) => number;
export type Clearing = { x: number; z: number; r: number } | { x: number; z: number; hx: number; hz: number; yaw?: number };
export function mulberry(seed: number) {
  let a = seed >>> 0 || 1;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const box = (x: number, y: number, z: number, w: number, h: number, d: number, yaw = 0, surf: Box["surf"] = "stone"): Box => ({ c: [x, y, z], h: [w / 2, h / 2, d / 2], yaw, surf });

export interface Fall { top: [number, number, number]; dir: [number, number]; width: number; v0: number; /** slides down the terrain face (top snaps to the rim edge) */ cascade?: boolean }
export interface CliffLine { pts: Array<[number, number]>; y0: number; y1: number | ((t: number) => number); size: [number, number]; depth: number; seed: number; jitter?: number;
  /** notches cut into the wall where falls pour over: blocks overlapping [z − hw, z + hw] stop at `top` */
  notches?: Array<{ z: number; hw: number; top: number }> }
export const FALLS = {
  pool: { x: -151, z: -397, rx: 27, rz: 30, level: 21.3 },
  /** the waterfalls: lip centre, outflow direction (xz), width, exit speed. Base = pool level. */
  falls: [
    { top: [-178, 57.5, -391], dir: [1, 0.08], width: 9.5, v0: 2.4 },       // A — the big left fall
    { top: [-177, 55.5, -411], dir: [1, -0.05], width: 7.0, v0: 2.0 },      // B — centre fall
    { top: [-158.5, 61, -446], dir: [0.12, 1], width: 3.0, v0: 1.4, cascade: true },   // C — side cascade down the north wall
  ] as Fall[],
  /** the cliff wall behind the falls (west), the north bluff and the south shoulder */
  cliffs: [
    { pts: [[-184, -446], [-183.5, -426], [-182, -401], [-183, -380], [-181, -364]], y0: 17, y1: 70, size: [7.5, 6.5], depth: 7, seed: 11,
      // (including the high bridge's crossing)
      notches: [{ z: -391, hw: 5.6, top: 56.3 }, { z: -411, hw: 4.3, top: 54.3 }, { z: -422.6, hw: 3.6, top: 59.6 }] },
  ] as CliffLine[],
  /** rock skin: sculpted blocks cladding every steep terrain face of the bowl + gorge (blocky blue-grey
   *  walls). Grid-sampled within an ellipse ring around the pool; skipped on gentle slopes, over the falls wall line,
   *  at the lookout and in the river outlet. */
  skin: { x: -150, z: -402, r0: 15, r1: 92, step: 5.0, minSlope: 0.4, seed: 77 },
  /** keep-outs for the rock skin: the view camera stand + the bridge head (so nothing blocks the view) */
  skinKeep: [[-108, -373.5, 8], [-125.4, -373.7, 6]] as Array<[number, number, number]>,
  /** hard-cover boulders out in the plunge pool: [x, z, radius] */
  poolCover: [[-142.5, -398, 1.6], [-154, -389.5, 1.5], [-151.5, -380.5, 1.3], [-164, -394.5, 1.4]] as Array<[number, number, number]>,
  /** plug blocks for pockets in the wall (resolveFalls): [x, z, half-size, top y]. The first three keep the high
   *  bridge's valley out of the trench behind the falls */
  plugs: [[-186.8, -414.5, 2.4, 61.8], [-191.3, -414, 2.4, 62.3], [-195.8, -413.5, 2.4, 63.6],
    [-187, -397, 3.0, 56.2], [-185, -401, 2.2, 52.1], [-186, -387, 2.4, 56.2], [-183.5, -377.4, 2.0, 57], [-208, -363, 2.6, 127.4], [-179, -371, 2.4, 63.8], [-182, -378, 2.0, 69.8], [-179, -395, 1.8, 35.1], [-187.6, -391, 2.2, 56.2]] as Array<[number, number, number, number]>,
  /** the rock pillar between fall B and the north bluff (the hoist stands on it) */
  pillar: { x: -175, z: -424, r: 5.5, top: 62 },
  /** the rock weir holding the pool at its level where the bowl opens east; the river spills through the low gap */
  weir: { x: -128.5, z0: -419, z1: -383, top: 22.0, gap: { z: -401, hw: 6.5 }, riverY: 18.6 },
  /** a mossy rock buttress splitting falls A and B */
  buttress: { x: -178, z: -401, r: 5, top: 57 },
  /** river centreline (terrain-gen RIVER) from the pool outlet downstream; levels resolved from the bed */
  river: [[-123, -401], [-110, -403], [-95, -405], [-78, -409], [-60, -413], [-42, -418], [-22, -419], [0, -415], [25, -409], [55, -401], [90, -389], [125, -372], [160, -356], [200, -341], [240, -330]] as Array<[number, number]>,
  /** lookout platform on the south shoulder (left foreground of the river view); deck height absolute */
  lookout: { x: -127.2, z: -370.2, w: 7, d: 5.5, yaw: 1.1, deckY: 35.2, roofH: 3.3 },
  /** rope bridges: [a], [b] as [x, z, deckY | null (terrain + 0.8)] */
  bridges: [
    // the gorge bridge's north end lands on the north walkway (which leads down to the river bridge), 10 m east of
    // the bluff face (at −146, −427 it would run into it), and the high bridge from the hoist pillar crosses WEST over a
    // notch in the falls wall to the upper valley behind the falls (→ the north plateau / the volcano flank)
    { id: "gorge", a: [-125.4, -373.7, 35.2], b: [-135.78, -424.17, 35.3], sag: 3.4, width: 1.9, xBrace: false },
    // the high bridge keeps ~3.3 m south of the north bluff's 67° foot (whose slope and rock veneer would stand up to
    // 3.7 m over the deck's north edge), still over the notch, a still on the pillar top: the terrain stays ≥ 0.9 m
    // under the deck edges over the whole span
    { id: "high", a: [-172.32, -423.49, 62.3], b: [-190.35, -416.8, 60.25], sag: 0.6, width: 1.5, xBrace: false },   // b: the valley floor + 0.27 (a null end sits 1.6 m up — a step a kong can't take)
    // bank to bank between the rising banks (decks meet the ground), 3 m over the water mid-span, tall lashed
    // log end frames (the bridge fills the top third of the biome-06 view, ~20–30 m from the sandbar camera)
    { id: "river", a: [-71.8, -392, 19.45], b: [-70.5, -428.5, 19.8], sag: 1.6, width: 1.9, xBrace: true },
  ] as Array<{ id: string; a: [number, number, number | null]; b: [number, number, number | null]; sag: number; width: number; xBrace: boolean }>,
  /** plank walkway on brackets along the north bluff face: [x, z, y] points. It hugs the face (inner
   *  edge ≥ 0.25 m over the ground) from the gorge bridge's north head DOWN to the river's north bank
   *  beside the river bridge: bridge → walkway → river bridge → south bank → the lookout is a loop) */
  walkway: [[-138.5, -425.25, 35.9], [-132.45, -425.25, 34.47], [-126.4, -426.5, 33.04], [-120.35, -428.75, 31.61], [-114.3, -430.5, 30.18], [-108.25, -430.5, 28.75], [-102.2, -429.75, 27.32], [-96.15, -427.75, 25.89], [-90.1, -426.25, 24.46], [-84.05, -426, 23.03], [-78, -427.5, 21.6], [-74.6, -427.6, 19.85]] as Array<[number, number, number]>,
  /** the lookout shelf (34 m) is ringed by 50–72° drops
   *  and the roads reached it down cliffs: two stone trails (jungle-layout peakTrail, the volcano's trail builder) — from
   *  the falls-ridge road's end (terrain-gen) down to the shelf, and from the shelf down to the river's south bank by the
   *  outlet (→ the river bridge). [head x, z, downhill hint x, z, max steps] */
  trails: [[-82, -362, -0.65, -0.76, 170], [-106, -369, 0.7, -0.7, 80]] as Array<[number, number, number, number, number]>,
  /** roads whose lane the bowl skin keeps clear of (terrain-gen pathLines ids) */
  skinRoads: ["falls-ridge"],
  /** a path the skin keeps clear: from the high bridge's west end up the valley behind the falls */
  skinLanes: [[[-190.35, -416.8], [-191.5, -420], [-205, -421], [-222, -424], [-240, -427]]] as Array<Array<[number, number]>>,
  hoist: { x: -175, z: -424, yaw: -0.25, jib: 6.5, drop: 4.2 },
  /** the dugout canoe, BEACHED on the north sandbar (bow down the slope toward the water), biome-06 right foreground */
  canoe: { x: -52.6, z: -427.4, yaw: 2.78, len: 5.2 },
  /** sandbar mounds (cream bars at the waterline): a smooth sand surface rising from under the water to
   *  ~0.7 m above it, meeting the bank; side +1 = north bank (inland = −z), −1 = south bank (inland = +z) */
  bars: [{ side: 1, x0: -69, x1: -33, zEdge: -423.4 }, { side: -1, x0: -64, x1: -42, zEdge: -403.4 }] as Array<{ side: number; x0: number; x1: number; zEdge: number }>,
  /** view camera stands + the first stretch of their sight lines [x, z, tx, tz] (veg keep-out corridors) */
  views: [[-108, -373.5, -150, -392], [-44, -429.5, -73, -413.5]] as Array<[number, number, number, number]>,
  /** hand-placed river boulders for the biome-06 view: [x, z, radius] (warm grey-brown, half-buried) */
  viewRocks: [[-60.6, -426.8, 1.9], [-63.6, -426.2, 1.4], [-58.4, -428.6, 1.2], [-62, -429.8, 1.6], [-44.2, -433.2, 1.4], [-58, -400.2, 3.0], [-53.6, -400.2, 1.9], [-63.2, -401.4, 2.5], [-48.8, -400.6, 1.0], [-55.6, -403.4, 1.3], [-67.4, -399.6, 2.1], [-60.8, -404.6, 0.9], [-70.2, -402.6, 1.2], [-66, -414, 1.1], [-68.6, -419.2, 0.8], [-63, -409, 0.7], [-47.2, -419.6, 0.9], [-44.6, -416.6, 0.55], [-51.2, -422.6, 0.6], [-36, -404, 1.9], [-31, -401.5, 1.2]] as Array<[number, number, number]>,
  /** cream sandbars on the river banks: [x, z, rx, rz, yaw] */
  sandbars: [[-100, -391, 12, 5, 0.1], [-84, -424, 11, 5, -0.2], [-58, -398, 16, 7, 0.25], [-38, -431, 16, 6, 0.12], [-24, -431, 10, 5, 0.3], [-66, -431, 10, 4, 0.2], [-18, -405, 11, 5, -0.2], [10, -428, 12, 5, 0.3]] as Array<[number, number, number, number, number]>,
};

export interface RockP { x: number; y: number; z: number; sx: number; sy: number; sz: number; ry: number; seed: number }
export interface FallsResolved {
  /** stone trails from the temple road's crest (bottom → top, jungle-layout TrailStep) */
  trails?: TrailStep[][];
  /** the lookout's back steps down to the shoulder: tread centre [x, z, top y], deck → ground */
  lookoutSteps?: Array<[number, number, number]>;
  /** designed loot (LOOT_SPOTS), settled + capsule-checked by the offline bake */
  loot?: { chests: Array<[number, number, number, number]>; floor: Array<[number, number, number]> };
  cliff: RockP[]; boulders: RockP[]; riverRocks: RockP[];
  riverLevel: number[]; riverHalfW: number[];
  bridges: Array<{ id: string; a: [number, number, number]; b: [number, number, number]; sag: number; width: number; xBrace: boolean; anchors: [number, number] }>;
  lookoutGround: number;
  /** ground under each lookout post [x, z, y] (posts reach the ground) */
  lookoutPosts: Array<[number, number, number]>;
  canoeY: number;
  /** canoe pitch (bow down), rad */
  canoePitch: number;
  /** sandbar mound grids (1 m): heights (null = no bar here) */
  bars: Array<{ x0: number; z0: number; nx: number; nz: number; step: number; h: Array<number | null> }>;
}

/** stack sculpted blocks along a cliff polyline, from y0 (or the ground) up to y1(t), jittered, embedded in the slope */
function stackCliff(L: CliffLine, h: H, out: RockP[]) {
  const rnd = mulberry(L.seed);
  const segLen: number[] = []; let total = 0;
  for (let i = 0; i + 1 < L.pts.length; i++) { const d = dmath.hypot(L.pts[i + 1][0] - L.pts[i][0], L.pts[i + 1][1] - L.pts[i][1]); segLen.push(d); total += d; }
  const at = (s: number): [number, number, number, number] => { let k = 0; while (k < segLen.length - 1 && s > segLen[k]) { s -= segLen[k]; k++; } const t = Math.min(1, s / segLen[k]); const a = L.pts[k], b = L.pts[k + 1]; const dx = b[0] - a[0], dz = b[1] - a[1], l = dmath.hypot(dx, dz); return [a[0] + dx * t, a[1] + dz * t, dx / l, dz / l]; };
  const n = Math.ceil(total / (L.size[0] * 0.78));
  for (let i = 0; i <= n; i++) {
    const s = (i / n) * total, [cx, cz, tx, tz] = at(s), t = s / total;
    const top = typeof L.y1 === "function" ? L.y1(t) : L.y1;
    let y = L.y0 - 2 + rnd() * 2;
    let row = 0;
    while (y < top - 1.5) {
      const w = L.size[0] * (0.75 + rnd() * 0.5), hh = L.size[1] * (0.7 + rnd() * 0.55), d = L.depth * (0.8 + rnd() * 0.4);
      const off = (rnd() - 0.5) * 2.2 + (row % 2) * 0.8, along = (rnd() - 0.5) * L.size[0] * 0.5;
      const x = cx + tx * along - tz * off, z = cz + tz * along + tx * off;
      let hTop = Math.min(hh, top - y + 1.5);
      for (const nt of L.notches ?? []) if (Math.abs(z - nt.z) < nt.hw + w * 0.45 && y + hTop > nt.top) hTop = nt.top - y;
      if (hTop < 0.8) break;
      if (y + hTop > h(x, z) - 3) out.push({ x, y: y + hTop * 0.5, z, sx: w / 2, sy: hTop / 2, sz: d / 2, ry: dmath.atan2(-tz, tx) + (rnd() - 0.5) * 0.35, seed: L.seed * 100 + i * 7 + row });
      y += hTop * (0.78 + rnd() * 0.12); row++;
    }
  }
}

/** clad the bowl + gorge walls with big overlapping slate blocks (a continuous wet blue-grey wall): every grid
 *  cell on a slope gets a block pushed into the slope so ~2 m stands proud; steeper = taller + closer spacing */
function skinRocks(h: H, out: RockP[], trails: TrailStep[][] = []) {
  const S = FALLS.skin, rnd = mulberry(S.seed);
  // lanes the skin must leave open: the named roads (half width + 1.5 m) and the stone trails (2.5 m)
  const lanes: Array<{ pts: Array<[number, number]>; r: number }> = pathLines().filter((p) => FALLS.skinRoads.includes(p.id)).map((p) => ({ pts: p.pts as Array<[number, number]>, r: p.w * 1.2 + 1.5 }));
  for (const t of trails) lanes.push({ pts: t.map((st) => [st.x, st.z] as [number, number]), r: 2.5 });
  for (const L of FALLS.skinLanes) lanes.push({ pts: L, r: 3.5 });
  const laneD = (x: number, z: number, L: { pts: Array<[number, number]> }) => { let m = Infinity; for (let i = 0; i + 1 < L.pts.length; i++) { const [ax, az] = L.pts[i], [bx, bz] = L.pts[i + 1], dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1, u = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2)); m = Math.min(m, dmath.hypot(x - ax - dx * u, z - az - dz * u)); } return m; };
  for (let gx = S.x - S.r1; gx <= S.x + S.r1; gx += S.step) for (let gz = S.z - S.r1; gz <= S.z + S.r1; gz += S.step) {
    const jx = gx + (rnd() - 0.5) * S.step * 0.7, jz = gz + (rnd() - 0.5) * S.step * 0.7, rr = rnd(), rs = rnd(), rw = rnd(), rh = rnd(), rd = rnd(), ry = rnd();
    const dc = dmath.hypot(jx - S.x, (jz - S.z) * 1.05);
    if (dc < S.r0 || dc > S.r1) continue;
    if (jx < -175 && jx > -193 && jz > -448 && jz < -362) continue;       // the falls wall line owns this strip
    if (jx > -128 && Math.abs(jz + 402) < 15) continue;                     // river outlet / valley floor
    if (dmath.hypot(jx - FALLS.lookout.x, jz - FALLS.lookout.z) < 7) continue;
    if (FALLS.skinKeep.some(([kx, kz, kr]) => dmath.hypot(jx - kx, jz - kz) < kr)) continue;
    if (FALLS.views.some(([cx, cz, tx, tz]) => { const dx = tx - cx, dz = tz - cz, L2 = dx * dx + dz * dz, u = Math.max(0, Math.min(1, ((jx - cx) * dx + (jz - cz) * dz) / L2)); return dmath.hypot(jx - cx - dx * u, jz - cz - dz * u) < 7 + u * 3; })) continue;   // judged sight lines
    const y = h(jx, jz), hx = (h(jx + 2, jz) - h(jx - 2, jz)) / 4, hz = (h(jx, jz + 2) - h(jx, jz - 2)) / 4, slope = dmath.hypot(hx, hz);
    // never through a bridge deck or the walkway: skip a block that reaches the deck's height near its line
    { let hit = false;
      for (const b of FALLS.bridges) { const ax = b.a[0], az = b.a[1], bx = b.b[0], bz = b.b[1], dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz, u = Math.max(0, Math.min(1, ((jx - ax) * dx + (jz - az) * dz) / L2));
        const ya = b.a[2] ?? h(ax, az) + 1.6, yb = b.b[2] ?? h(bx, bz) + 1.6, deck = ya + (yb - ya) * u - b.sag * 4 * u * (1 - u);
        if (dmath.hypot(jx - ax - dx * u, jz - az - dz * u) < 6.5 && y + 9 > deck - 2.5) hit = true; }
      for (let i = 0; i + 1 < FALLS.walkway.length; i++) { const [ax, az, ay] = FALLS.walkway[i], [bx, bz] = FALLS.walkway[i + 1], dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz, u = Math.max(0, Math.min(1, ((jx - ax) * dx + (jz - az) * dz) / L2)); if (dmath.hypot(jx - ax - dx * u, jz - az - dz * u) < 5 && y + 9 > ay - 2.5) hit = true; }
      if (hit) continue; }
    if (slope < S.minSlope * (0.85 + rr * 0.3)) continue;
    if (y < FALLS.pool.level - 0.5) continue;                                // never in the pool
    const nx = -hx / slope, nz = -hz / slope;                               // horizontal outward normal
    const steep = Math.min(1, (slope - 0.4) / 1.2);
    const w = 10 + rw * 6, hh = 6.5 + rh * 4.5 + steep * 5, d = 8.5 + rd * 3;
    const proud = 1.3 + steep * 1.1;
    const cx = jx - nx * (d * 0.5 - proud), cz = jz - nz * (d * 0.5 - proud);
    // the block's top never stands more than 1 m above the highest ground under it (tall ramparts along the cliff
    // tops walled off crevices players dropped into), and its foot reaches 0.8 m under the lowest ground under it (a
    // block floating over the downhill slope roofed a "covered" pocket)
    const ryy = dmath.atan2(-nx, -nz) + (ry - 0.5) * 0.5, cy0 = y + hh * (0.08 + steep * 0.12) + (rs - 0.5) * 1.2;
    let gHi = -Infinity, gLo = Infinity; { const c = dmath.cos(ryy), sn = dmath.sin(ryy); for (const [u, v] of [[0, 0], [1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]]) { const lx = u * w / 2 * 0.85, lz = v * d / 2 * 0.85, gx = cx + lx * c + lz * sn, gz = cz - lx * sn + lz * c, g = h(gx, gz); gHi = Math.max(gHi, g); gLo = Math.min(gLo, g); } }
    const top = Math.min(cy0 + hh / 2, gHi + 1.0), bot = Math.min(cy0 - hh / 2, gLo - 0.8);
    if (top - bot < 1.5) continue;
    if (lanes.some((L) => laneD(cx, cz, L) < Math.max(w, d) * 0.45 + L.r)) continue;   // off the roads + trails
    out.push({ x: cx, y: (top + bot) / 2, z: cz, sx: w / 2, sy: (top - bot) / 2, sz: d / 2, ry: ryy, seed: 30000 + out.length });   // ≥ 30000 = bowl skin (the client renders it without cascade shadows)
  }
}

export function resolveFalls(h: H): FallsResolved {
  const F = FALLS, cliff: RockP[] = [];
  const trails = F.trails.map(([x, z, hx, hz, n]) => peakTrail(h, x, h(x, z) + 0.02, z, hx, hz, n));
  for (const L of F.cliffs) stackCliff(L, h, cliff);
  skinRocks(h, cliff, trails);
  // pillar + buttress: a column of blocks
  for (const [P, seed] of [[F.pillar, 51], [F.buttress, 61]] as Array<[{ x: number; z: number; r: number; top: number }, number]>) {
    const rnd = mulberry(seed); let y = 16;
    while (y < P.top - 1) { const hh = 4 + rnd() * 3.5, s = P.r * (0.85 + rnd() * 0.35) * (1 - 0.12 * (y / P.top)); const top = Math.min(hh, P.top - y + 1); cliff.push({ x: P.x + (rnd() - 0.5) * 1.6, y: y + top / 2, z: P.z + (rnd() - 0.5) * 1.6, sx: s, sy: top / 2, sz: s * (0.8 + rnd() * 0.3), ry: rnd() * 6.28, seed: seed * 10 + Math.round(y) }); y += top * 0.82; }
  }
  // boulders: pool rim ring + a few IN the pool poking through (foam rings), and the foreground ledge rocks
  const boulders: RockP[] = [];
  const P = F.pool;
  for (let i = 0; i < 46; i++) {
    const g = mulberry(4000 + i), a = g() * Math.PI * 2, rr = 0.9 + g() * 0.25, x = P.x + dmath.cos(a) * P.rx * rr, z = P.z + dmath.sin(a) * P.rz * rr;
    if (x < -168) continue;                                   // the falls' landing is open water
    // the outlet: the weir is the rim there (a rim boulder beside it left a sealed sandbar pocket)
    if (x > -140 && z > -422 && z < -380) continue;
    const r = 1.4 + g() * 2.8, y = h(x, z);
    boulders.push({ x, y: y + r * 0.2, z, sx: r * (1 + g() * 0.3), sy: r * 0.75, sz: r, ry: g() * 6.28, seed: 800 + i });
  }
  for (let i = 0; i < 16; i++) { const g = mulberry(4600 + i), x = -166 + g() * 32, z = -416 + g() * 34; if (dmath.hypot(x + 150, z + 398) < 5 || (x > -140 && z > -422 && z < -380)) continue; const r = 1.0 + g() * 1.6, floor = h(x, z), top = P.level + 0.5 + r * 0.55, sy = Math.max(r * 0.65, (top - floor) / 1.6); boulders.push({ x, y: top - sy * 0.8, z, sx: r * 1.2, sy, sz: r, ry: g() * 6.28, seed: 870 + i }); }
  // hard cover out in the plunge pool: big boulders poking ~1 m out of the water
  for (const [x, z, r] of F.poolCover) { const floor = Math.min(h(x, z), h(x + r, z), h(x - r, z), h(x, z + r), h(x, z - r)), top = P.level + 0.9, sy = Math.max(r * 0.7, (top - floor + 0.3) / 1.6); boulders.push({ x, y: top - sy * 0.8, z, sx: r * 1.15, sy, sz: r, ry: (x * 7 + z) % 6.28, seed: 5100 + Math.round(Math.abs(x + z)) }); }
  // lip boulders: big rounded stones flanking each fall's lip + a few in the channel breaking the edge of the sheet
  F.falls.forEach((f, fi) => {
    if (f.cascade) return;
    const g = mulberry(4700 + fi), [dx, dz] = f.dir, dl = dmath.hypot(dx, dz), ux = dx / dl, uz = dz / dl, sx = -uz, sz = ux;
    for (const sd of [-1, 1]) { const r = 1.6 + g() * 0.8, off = f.width / 2 + r * 0.55, x = f.top[0] + sx * sd * off - ux * 0.6, z = f.top[2] + sz * sd * off - uz * 0.6; boulders.push({ x, y: f.top[1] + r * 0.2, z, sx: r * 1.1, sy: r * 0.8, sz: r, ry: g() * 6.28, seed: 4700 + fi * 10 + (sd + 1) }); }
    for (let k = 0; k < 3; k++) { const r = 0.45 + g() * 0.35, a = (g() - 0.5) * f.width * 0.8, back = 0.4 + g() * 1.6, x = f.top[0] + sx * a - ux * back, z = f.top[2] + sz * a - uz * back; boulders.push({ x, y: f.top[1] + 0.05, z, sx: r * 1.2, sy: r * 0.6, sz: r, ry: g() * 6.28, seed: 4705 + fi * 10 + k }); }
  });
  // the weir: big boulders across the outlet, lower in the spill gap
  { const W = F.weir, g = mulberry(4800); let z = W.z0;
    while (z < W.z1) { const inGap = Math.abs(z - W.gap.z) < W.gap.hw, r = inGap ? 1.1 + g() * 0.8 : 1.8 + g() * 1.6, x = W.x + (g() - 0.5) * 2.5 - (inGap ? -0.8 : 0);
      const top = inGap ? P.level - 0.25 : W.top + g() * 0.3, zc = z + r * 0.8, sxr = r * (1.1 + g() * 0.3);
      // every weir boulder reaches DOWN to the ground under it (no overhang over the downstream sandbar: a
      // 1.4 m gap under them was a stuck pocket and a camera-inside-the-rock spot)
      const floor = Math.min(h(x, zc), h(x + sxr * 0.8, zc), h(x - sxr * 0.8, zc), h(x, zc + r * 0.8), h(x, zc - r * 0.8));
      const sy = Math.max(r * 0.9, (top - floor + 0.25) / 1.55), y = top - sy;   // drawn top = y + sy, drawn foot = y − 0.55 sy
      boulders.push({ x, y, z: zc, sx: Math.max(sxr, sy * 0.9), sy, sz: Math.max(r, sy * 0.8), ry: g() * 6.28, seed: 4800 + Math.round(z) });   // round, never a stretched pillar
      // a talus of smaller stones stepping down the downstream (east) face: the weir is climbable from the river bank
      if (!inGap && g() < 0.8) { const r2 = 0.9 + g() * 0.5, x2 = x + sxr * 0.75 + r2 * 0.9, f2 = Math.min(h(x2, zc), h(x2 + r2, zc), h(x2 - r2, zc)), t2 = Math.min(top - 1.2, f2 + 1.25);
        if (t2 > f2 + 0.6) { const sy2 = (t2 - f2 + 0.25) / 1.55; boulders.push({ x: x2, y: t2 - sy2, z: zc + (g() - 0.5) * 0.8, sx: r2 * 1.15, sy: sy2, sz: r2, ry: g() * 6.28, seed: 4900 + Math.round(z) }); } }
      z += r * 1.45; } }
  // river levels: the pool level at the outlet, then bed + 1.3 (never rising downstream); half width from the banks
  const riverLevel: number[] = [], riverHalfW: number[] = [];
  let lv = P.level;
  F.river.forEach(([x, z], i) => {
    const bed = Math.min(h(x, z), h(x + 2, z), h(x - 2, z), h(x, z + 2), h(x, z - 2));
    const want = i === 0 ? F.weir.riverY : bed + 1.25;
    lv = Math.min(lv - (i ? 0.05 : 0), want); riverLevel.push(lv);
    // half width: march outward (normal to the local tangent) until the ground rises above the level
    const nb = F.river[Math.min(F.river.length - 1, i + 1)], pb = F.river[Math.max(0, i - 1)], tx = nb[0] - pb[0], tz = nb[1] - pb[1], tl = dmath.hypot(tx, tz), nx = -tz / tl, nz = tx / tl;
    let hw = 6; for (const s of [-1, 1]) { let d = 2; while (d < 30 && h(x + nx * d * s, z + nz * d * s) < lv + 0.05) d += 1; hw = Math.max(hw, d + 3); }
    riverHalfW.push(Math.min(34, hw));
  });
  // river boulders along the banks + a few mid-stream (biome-06: big smooth grey-brown stones, 2–5 m)
  const riverRocks: RockP[] = [];
  /** water level at (x, z): the river level of the nearest centreline segment (interpolated) */
  const lvAt = (x: number, z: number) => { let best = riverLevel[0], bd = Infinity; for (let i = 0; i + 1 < F.river.length; i++) { const [ax, az] = F.river[i], [bx, bz] = F.river[i + 1], dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz, u = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2)), d = dmath.hypot(x - ax - dx * u, z - az - dz * u); if (d < bd) { bd = d; best = riverLevel[i] + (riverLevel[i + 1] - riverLevel[i]) * u; } } return best; };
  /** a river boulder sits on the bed and always shows a crown above the water (0.25–0.55 of its height) */
  const rockY = (x: number, z: number, r: number, sy: number, above: number) => Math.max(h(x, z) + r * 0.15, lvAt(x, z) + sy * (above * 2 - 1));
  // river boulders are ROUND (height ≈ 0.7 × width), sitting in the sand / water — never pancakes
  F.viewRocks.forEach(([x, z, r], i) => { const g = mulberry(5900 + i); riverRocks.push({ x, y: rockY(x, z, r, r * 0.95, 0.56 + g() * 0.15), z, sx: r * (1.02 + g() * 0.2), sy: r * 0.95, sz: r * 0.92, ry: g() * 6.28, seed: 990 + i }); });
  const pts = F.river;
  for (let s = 0; s + 1 < pts.length && s < 9; s++) {
    const dx = pts[s + 1][0] - pts[s][0], dz = pts[s + 1][1] - pts[s][1], l = dmath.hypot(dx, dz), nx = -dz / l, nz = dx / l;
    const n = Math.round(l / 3.2);
    for (let i = 0; i < n; i++) {
      const g = mulberry(5000 + s * 100 + i), t = (i + g()) / n, side = g() < 0.5 ? -1 : 1;
      const px = pts[s][0] + dx * t, pz = pts[s][1] + dz * t, hw = riverHalfW[s] + (riverHalfW[s + 1] - riverHalfW[s]) * t;
      const off = side * (hw * (0.55 + g() * 0.45)), x = px + nx * off, z = pz + nz * off;
      const q = g(), r = q < 0.25 ? 2.2 + g() * 2.0 : q < 0.6 ? 1.1 + g() * 0.8 : 0.45 + g() * 0.45;   // 3 size classes
      if (F.views.some(([vx, vz]) => dmath.hypot(x - vx, z - vz) < r + 3.5) || dmath.hypot(x - F.views[1][0], z - F.views[1][1]) < r + 11) continue;   // never inside a view (biome-06: the near water stays open)
      riverRocks.push({ x, y: rockY(x, z, r, r * 0.84, 0.3 + g() * 0.3), z, sx: r * (1 + g() * 0.3), sy: r * 0.84, sz: r, ry: g() * 6.28, seed: 900 + s * 50 + i });
    }
    for (let i = 0; i < 3; i++) { const g = mulberry(5500 + s * 100 + i), t = g(), px = pts[s][0] + dx * t, pz = pts[s][1] + dz * t, off = (g() - 0.5) * 8; const r = 0.6 + g() * 1.0; const x = px + nx * off, z = pz + nz * off; if (dmath.hypot(x - F.views[1][0], z - F.views[1][1]) < r + 11) continue; riverRocks.push({ x, y: rockY(x, z, r, r * 0.6, 0.3), z, sx: r * 1.3, sy: r * 0.6, sz: r, ry: g() * 6.28, seed: 950 + s * 50 + i }); }
  }
  const bridges = F.bridges.map((b) => ({
    id: b.id, sag: b.sag, width: b.width, xBrace: b.xBrace,
    a: [b.a[0], b.a[2] ?? h(b.a[0], b.a[1]) + 1.6, b.a[1]] as [number, number, number],
    b: [b.b[0], b.b[2] ?? h(b.b[0], b.b[1]) + 1.6, b.b[1]] as [number, number, number],
    anchors: [0, 0] as [number, number],
  }));
  for (const b of bridges) {
    const dx = b.b[0] - b.a[0], dz = b.b[2] - b.a[2], l = dmath.hypot(dx, dz);
    b.anchors = [h(b.a[0] - dx / l * 2.6, b.a[2] - dz / l * 2.6), h(b.b[0] + dx / l * 2.6, b.b[2] + dz / l * 2.6)];
  }
  // water level of the nearest river reach (the canoe floats when it sits in the water)

  // sandbar mounds: y = level − 0.3 → +0.7 m inland over ~7 m, tapered at the ends, never below the terrain it covers
  const bars: FallsResolved["bars"] = F.bars.map((B, bi) => {
    const step = 1, x0 = B.x0 - 2, x1 = B.x1 + 2, zA = B.zEdge - B.side * 20, zB = B.zEdge + B.side * 5, z0 = Math.min(zA, zB), z1 = Math.max(zA, zB);
    const nx = Math.round((x1 - x0) / step) + 1, nz = Math.round((z1 - z0) / step) + 1, hs: Array<number | null> = [], g = mulberry(7100 + bi);
    const ph = g() * 6.28, ph2 = g() * 6.28;
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const x = x0 + i * step, z = z0 + j * step, ze = B.zEdge + 1.1 * dmath.sin(x * 0.19 + ph) + 0.6 * dmath.sin(x * 0.47 + ph2), dz = (ze - z) * B.side;
      const t = Math.min(1, Math.max(0, (dz + 1) / 3.5)), rise = t * t * (3 - 2 * t), end = Math.min(1, Math.max(0, (x - B.x0) / 6)) * Math.min(1, Math.max(0, (B.x1 - x) / 6));
      // a BROAD sand terrace (a wide cream bar with the canoe + boulders on it) — rises 0.8 m at the waterline,
      // then keeps climbing gently (up to ~2 m) until it meets the bank
      const L = lvAt(x, z), y = L - 0.32 + (0.8 * rise + 0.095 * Math.min(14, Math.max(0, dz))) * (0.6 + 0.4 * end) - 1.6 * (1 - end) + 0.05 * dmath.sin(x * 1.3 + z * 0.9), th = h(x, z);
      hs.push(y > th - 0.6 && dz > -6 ? r3(Math.max(y, th - 0.6)) : null);
    }
    return { x0, z0, nx, nz, step, h: hs };
  });
  const barAt = (x: number, z: number) => { let best = -Infinity; for (const b of bars) { const fi = (x - b.x0) / b.step, fj = (z - b.z0) / b.step, i = Math.floor(fi), j = Math.floor(fj); if (i < 0 || j < 0 || i >= b.nx - 1 || j >= b.nz - 1) continue; const q = [b.h[j * b.nx + i], b.h[j * b.nx + i + 1], b.h[(j + 1) * b.nx + i], b.h[(j + 1) * b.nx + i + 1]]; if (q.some((v) => v === null)) continue; const u = fi - i, v = fj - j; best = Math.max(best, ((q[0] as number) * (1 - u) + (q[1] as number) * u) * (1 - v) + ((q[2] as number) * (1 - u) + (q[3] as number) * u) * v); } return best; };
  const gnd = (x: number, z: number) => Math.max(h(x, z), barAt(x, z));
  // the canoe rests on the sand: height at its middle, pitch from stern → bow ground heights (bow down toward the water)
  const cn = F.canoe, cbx = dmath.cos(cn.yaw), cbz = -dmath.sin(cn.yaw), hb = gnd(cn.x + cbx * cn.len * 0.4, cn.z + cbz * cn.len * 0.4), hs2 = gnd(cn.x - cbx * cn.len * 0.4, cn.z - cbz * cn.len * 0.4);
  const canoeY = gnd(cn.x, cn.z) + 0.05, canoePitch = dmath.atan2(hb - hs2, cn.len * 0.8);
  const lo = F.lookout, lookoutGround = Math.min(h(lo.x - 3, lo.z - 3), h(lo.x + 3, lo.z - 3), h(lo.x - 3, lo.z + 3), h(lo.x + 3, lo.z + 3));
  const fx = dmath.cos(lo.yaw), fz = -dmath.sin(lo.yaw), lookoutPosts: Array<[number, number, number]> = [];
  for (const a of [-lo.w / 2 + 0.25, 0, lo.w / 2 - 0.25]) for (const sd of [-lo.d / 2 + 0.25, lo.d / 2 - 0.25]) { const x = lo.x + fx * a - fz * sd, z = lo.z + fz * a + fx * sd; lookoutPosts.push([x, z, h(x, z)]); }
  // plug blocks closing the pockets a reachability scan found between the wall's blocks after the terrain re-bakes:
  // [x, z, half-size, top y]; foot 1 m under the lowest ground (a wall block: seed < 30000, collides like the wall)
  for (const [x, z, r, top] of F.plugs) { let lo = Infinity; for (const [dx, dz] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]]) lo = Math.min(lo, h(x + dx, z + dz)); const bot = Math.min(lo - 1, top - 2 * r), sy = (top - bot) / 2 / 0.95;
    cliff.push({ x, y: (top + bot) / 2, z, sx: r / 0.85, sy, sz: r / 0.85, ry: 0.4, seed: 29000 + Math.round(Math.abs(x * 3 + z)) % 900 }); }
  const rk = (r: RockP): RockP => ({ x: r3(r.x), y: r3(r.y), z: r3(r.z), sx: r3(r.sx), sy: r3(r.sy), sz: r3(r.sz), ry: r3(r.ry), seed: r.seed });
  const v3 = (v: [number, number, number]): [number, number, number] => [r3(v[0]), r3(v[1]), r3(v[2])];
  return {
    cliff: cliff.map(rk), boulders: boulders.map(rk), riverRocks: riverRocks.map(rk), riverLevel: riverLevel.map(r3), riverHalfW: riverHalfW.map(r3),
    bridges: bridges.map((b) => ({ ...b, a: v3(b.a), b: v3(b.b), anchors: [r3(b.anchors[0]), r3(b.anchors[1])] as [number, number] })),
    lookoutGround: r3(lookoutGround), lookoutPosts: lookoutPosts.map(v3), canoeY: r3(canoeY), canoePitch: r3(canoePitch), bars,
    trails, lookoutSteps: lookoutSteps(h).map(([x, z, y]) => [r3(x), r3(z), r3(y)] as [number, number, number]),
  };
}
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** the lookout's back end is open: timber steps from the deck down to the shoulder (a second way off besides the
 *  gorge bridge). Tread centres [x, z, top y] along −fwd from the back edge. */
export const LOOKOUT_STEP = { tread: 0.42, rise: 0.34, width: 1.8 };
function lookoutSteps(h: H): Array<[number, number, number]> {
  const lo = FALLS.lookout, fx = dmath.cos(lo.yaw), fz = -dmath.sin(lo.yaw), S = LOOKOUT_STEP, out: Array<[number, number, number]> = [];
  for (let i = 0; i < 12; i++) {
    const d = lo.w / 2 + S.tread * (i + 0.5), x = lo.x - fx * d, z = lo.z - fz * d, y = lo.deckY - S.rise * (i + 1);
    const g = Math.max(h(x - fz * S.width / 2, z + fx * S.width / 2), h(x, z), h(x + fz * S.width / 2, z - fx * S.width / 2));
    if (y < g + 0.05) break;
    out.push([x, z, y]);
  }
  return out;
}

/** the north walkway's outer rail stays open where the gorge bridge lands on it: true when (x, z) lies
 *  within `r` + 1.3 m of the gorge bridge's north end (client wood.ts skips its rope + posts there too) */
export function walkwayGap(x: number, z: number, r = 0): boolean {
  const g = FALLS.bridges.find((b) => b.id === "gorge")!;
  return dmath.hypot(x - g.b[0], z - g.b[1]) < r + 1.3;
}

/** deck height of a bridge at parameter t (0 at a → 1 at b) */
export const bridgeDeckY = (a: [number, number, number], b: [number, number, number], sag: number, t: number) => a[1] + (b[1] - a[1]) * t - sag * 4 * t * (1 - t);

/** Box.yaw is the SIM convention (box +X = world (cos, 0, sin)) = −(three.js yaw). Everything below converts. */
const sy = (threeYaw: number) => -threeYaw;
export function fallsColliders(R: FallsResolved, tags?: string[]): Box[] {
  const out: Box[] = [];
  /** dev: label every box pushed since the last call (pocket debugging) */
  const tag = (l: string) => { if (tags) while (tags.length < out.length) tags.push(l); };
  // every rock collides as the COLUMNS of its drawn prototype (jungle-rock-profiles.json: a 4 × 4 grid fitted to the
  // hi mesh's surface), not one box at 0.95 × its half height — the sculpted tops only reach 0.55–0.8 of it, so every
  // rock had an invisible slab 0.3–2 m over its visible top (and box corners outside its round silhouette). The
  // client draws variant seed % 5 of the same family (mist-falls/index.ts lodPair → rockLOD3 proto = seed).
  const rockCols = (r: RockP, fam: "slate" | "boulder") => {
    const cols = (rockProfiles as Record<string, number[][][]>)[fam][r.seed % 5], c = dmath.cos(r.ry), sn = dmath.sin(r.ry);
    for (const [x0, x1, z0, z1, y0, y1] of cols) {
      const lx = (x0 + x1) / 2 * r.sx, lz = (z0 + z1) / 2 * r.sz, ly = (y0 + y1) / 2 * r.sy;
      out.push(box(r.x + lx * c + lz * sn, r.y + ly, r.z - lx * sn + lz * c, (x1 - x0) * r.sx, (y1 - y0) * r.sy, (z1 - z0) * r.sz, sy(r.ry)));
    }
  };
  // the falls WALL itself (stacked blocks, the pillar, the buttress, plugs: seed < 30000) keeps its overlapping single
  // boxes — a sheer rampart nobody walks on, and fitted columns opened crevices between its blocks (reach scan: 16 → 72
  // stuck spots behind the falls); the bowl skin (seed ≥ 30000) is fitted
  R.cliff.forEach((r, i) => { if (r.seed < 30000) out.push(box(r.x, r.y, r.z, r.sx * 2 * 0.85, r.sy * 2 * 0.95, r.sz * 2 * 0.85, sy(r.ry))); else rockCols(r, "slate"); tag("cliff" + i); });
  R.boulders.forEach((r, i) => { rockCols(r, "boulder"); tag("boulder" + i); });
  R.riverRocks.forEach((r, i) => { rockCols(r, "boulder"); tag("rrock" + i); });
  // bridges: flat deck segments (≤ 1.2 m, auto-step handles the sag) + rope-rail walls + end posts
  for (const b of R.bridges) {
    const dx = b.b[0] - b.a[0], dz = b.b[2] - b.a[2], span = dmath.hypot(dx, dz), yaw = dmath.atan2(dz, dx), sx = -dz / span, sz = dx / span;
    const n = Math.max(10, Math.round(span / 1.2));
    for (let i = 0; i < n; i++) {
      const tm = (i + 0.5) / n, ym = bridgeDeckY(b.a, b.b, b.sag, tm), cx = b.a[0] + dx * tm, cz = b.a[2] + dz * tm, len = span / n;
      out.push({ c: [cx, ym - 0.1, cz], h: [len / 2 + 0.04, 0.12, b.width / 2], yaw, surf: "wood" });
      for (const sd of [-1, 1]) out.push({ c: [cx + sx * sd * (b.width / 2 + 0.1), ym + 0.55, cz + sz * sd * (b.width / 2 + 0.1)], h: [len / 2 + 0.04, 0.55, 0.06], yaw, surf: "wood", noShoot: true });
    }
    const tall = b.id === "river";   // lashed log end frames (client: ropeBridge frames) — posts 1.9 m below → ~3 m above the deck
    for (const e of [b.a, b.b]) for (const sd of [-1, 1]) out.push(box(e[0] + sx * sd * (b.width / 2 + 0.22), e[1] + (tall ? 0.5 : 0), e[2] + sz * sd * (b.width / 2 + 0.22), tall ? 0.46 : 0.4, tall ? 4.8 : 3.2, tall ? 0.46 : 0.4, 0, "wood"));
    tag("bridge-" + b.id);
  }
  const lo = FALLS.lookout;
  out.push({ c: [lo.x, lo.deckY - 0.12, lo.z], h: [lo.w / 2, 0.14, lo.d / 2], yaw: sy(lo.yaw), surf: "wood" });
  // the rope railing on the deck's two long sides collides like it draws; the back
  // end is open onto the steps, the front onto the gorge bridge
  { const fx = dmath.cos(lo.yaw), fz = -dmath.sin(lo.yaw);
    for (const sd of [-1, 1]) { const o = sd * (lo.d / 2 - 0.25); out.push({ c: [lo.x - fz * o, lo.deckY + 0.55, lo.z + fx * o], h: [lo.w / 2 - 0.25, 0.55, 0.06], yaw: sy(lo.yaw), surf: "wood", noShoot: true }); }
    for (const [x, z, y] of R.lookoutSteps ?? []) out.push({ c: [x, (y + R.lookoutGround - 0.5) / 2, z], h: [LOOKOUT_STEP.tread / 2 + 0.02, (y - R.lookoutGround + 0.5) / 2, LOOKOUT_STEP.width / 2], yaw: sy(lo.yaw), surf: "wood" }); }
  for (const [x, z, gy] of R.lookoutPosts) out.push(box(x, (gy + lo.deckY + lo.roofH) / 2, z, 0.4, lo.deckY + lo.roofH - gy + 0.6, 0.4, 0, "wood"));
  // walkway (flat 1.2 m segments)
  const W = FALLS.walkway;
  for (let i = 0; i + 1 < W.length; i++) {
    const a = W[i], b = W[i + 1], dx = b[0] - a[0], dz = b[1] - a[1], span = dmath.hypot(dx, dz), n = Math.max(4, Math.round(span / 1.2));
    // + the outer rope rail (pool side) collides like the bridges' rails
    const sx = -dz / span, sz = dx / span;
    for (let k = 0; k < n; k++) { const t = (k + 0.5) / n, y = a[2] + (b[2] - a[2]) * t; out.push({ c: [a[0] + dx * t, y - 0.08, a[1] + dz * t], h: [span / n / 2 + 0.04, 0.1, 0.8], yaw: dmath.atan2(dz, dx), surf: "wood" });
      const rx = a[0] + dx * t + sx * 0.72, rz = a[1] + dz * t + sz * 0.72;
      if (!walkwayGap(rx, rz, span / n / 2 + 0.6)) out.push({ c: [rx, y + 0.55, rz], h: [span / n / 2 + 0.04, 0.55, 0.05], yaw: dmath.atan2(dz, dx), surf: "wood", noShoot: true }); }
  }
  const ho = FALLS.hoist; out.push(box(ho.x, FALLS.pillar.top + 2.6, ho.z, 0.5, 5.4, 0.5, 0, "wood"));
  tag("lookout/walkway/hoist");
  for (const t of R.trails ?? []) trailBoxes(t, out);
  tag("trails");
  const c = FALLS.canoe; out.push({ ...box(c.x, R.canoeY + 0.35, c.z, c.len, 0.7, 1.1, sy(c.yaw), "wood"), pitch: R.canoePitch }); tag("canoe");
  // sandbar mounds: 2 m flat cells where the sand stands proud of the terrain (steps ≤ 0.2 m → auto-step)
  for (const b of R.bars ?? []) for (let j = 0; j + 2 < b.nz; j += 2) for (let i = 0; i + 2 < b.nx; i += 2) {
    const q = [b.h[j * b.nx + i], b.h[j * b.nx + i + 2], b.h[(j + 2) * b.nx + i], b.h[(j + 2) * b.nx + i + 2], b.h[(j + 1) * b.nx + i + 1]];
    if (q.some((v) => v === null)) continue;
    const top = Math.max(...(q as number[])) - 0.03, x = b.x0 + (i + 1) * b.step, z = b.z0 + (j + 1) * b.step;
    out.push(box(x, top - 1, z, 2 * b.step, 2, 2 * b.step, 0, "sand"));
  }
  tag("sandbar");
  return out;
}

/** loot CANDIDATES at the falls (x, z[, yaw]; y is settled on the walk floor by the offline bake): chests on the
 *  lookout deck, the pillar top by the hoist, both bridge heads, the weir crest, the canoe's sandbar, the river bridge
 *  bank, the north bluff; floor loot along the walkway, the gorge bridge, the sandbars, the pool shore, the banks */
export function fallsLootCandidates(R: FallsResolved): { chests: Array<[number, number, number, number]>; floor: Array<[number, number, number]> } {
  const F = FALLS, lo = F.lookout, c = dmath.cos(lo.yaw), s = dmath.sin(lo.yaw), gb = F.bridges[0], hb = F.bridges[1], rb = F.bridges[2];
  const chests: Array<[number, number, number, number]> = [
    [lo.x - c * 1.8, lo.deckY, lo.z + s * 1.8, lo.yaw],                          // lookout deck (away from the stair side)
    [F.pillar.x + 2.2, F.pillar.top, F.pillar.z + 1.2, -0.25],                   // pillar top beside the hoist
    [gb.b[0] + 2.2, gb.b[2] ?? 0, gb.b[1] - 1.8, 0],                              // gorge bridge north head
    [hb.b[0] + 1.6, (hb.b[2] ?? 0), hb.b[1] - 2.2, 0],                            // high bridge / north bluff top
    [F.weir.x, F.weir.top, -410.5, Math.PI / 2],                                  // the weir crest (a dare over the pool)
    [F.canoe.x + 2.2, 0, F.canoe.z + 1.6, F.canoe.yaw],                           // beside the beached canoe
    [rb.a[0] + 2.6, rb.a[2] ?? 0, rb.a[1] + 2.0, 0],                              // river bridge south bank
    [-104, 0, -384, 0.4],                                                          // south bank above the outlet
    [-121, 0, -366, 0.9],                                                          // the lookout's foot (the trail up)
    [-150, 0, -432, 0],                                                            // north rim above the walkway
  ];
  const floor: Array<[number, number, number]> = [];
  for (const [x, z, y] of F.walkway) floor.push([x, y, z]);
  // on the bridge decks (resolved ends [x, y, z]): gorge 30 / 70 %, river mid-span
  for (const [id, ts] of [["gorge", [0.3, 0.7]], ["river", [0.5]]] as Array<[string, number[]]>) { const b = R.bridges.find((q) => q.id === id); if (b) for (const t of ts) floor.push([b.a[0] + (b.b[0] - b.a[0]) * t, bridgeDeckY(b.a, b.b, b.sag, t), b.a[2] + (b.b[2] - b.a[2]) * t]); }
  // the sandbar mounds: the two highest cells of every bar
  for (const b of R.bars ?? []) { const cells: Array<[number, number, number]> = []; for (let j = 0; j < b.nz; j += 2) for (let i = 0; i < b.nx; i += 2) { const v = b.h[j * b.nx + i]; if (v !== null) cells.push([b.x0 + i * b.step, v, b.z0 + j * b.step]); } cells.sort((a, c) => c[1] - a[1]); floor.push(...cells.filter((c, k) => k === 0 || dmath.hypot(c[0] - cells[0][0], c[2] - cells[0][2]) > 8).slice(0, 2)); }
  floor.push([F.pillar.x - 1.8, F.pillar.top, F.pillar.z - 1.6], [lo.x + c * 1.6, lo.deckY, lo.z - s * 1.6], [-141, 0, -424], [-130, 0, -380], [-110, 0, -422], [-95, 0, -432], [-86, 0, -382], [-160, 0, -362], [-165, 0, -436], [-120, 0, -360]);
  void R;
  return { chests, floor };
}
export function fallsClearings(R?: FallsResolved): Clearing[] {
  const F = FALLS, out: Clearing[] = [
    { x: F.pool.x, z: F.pool.z, r: Math.max(F.pool.rx, F.pool.rz) + 3 },
    { x: -182, z: -405, hx: 10, hz: 44 },                  // cliff wall + falls
    { x: -154, z: -436, hx: 26, hz: 7 },                    // north bluff face
    { x: F.lookout.x, z: F.lookout.z, r: 6 },
    { x: F.canoe.x, z: F.canoe.z, r: 5 },
    // the poi-09 camera stand + its sight line to the falls (no tree may stand in the view)
    ...F.views.map(([x, z, tx, tz]) => ({ x: (x + tx) / 2, z: (z + tz) / 2, hx: dmath.hypot(tx - x, tz - z) / 2, hz: 5, yaw: dmath.atan2(tz - z, tx - x) })),
    ...F.views.map(([x, z]) => ({ x, z, r: 8 })),
    { x: -70, z: -392, hx: 17, hz: 8, yaw: 0.1 },         // biome-06: the sky window over the far (south) bank (open sky upper-left)
  ];
  // the falls-ridge road, the stone trails' line and the north walkway stay clear of scatter, terrain rocks
  // and trees (a rock / trunk in the lane blocks the road)
  { const lane = (P: Array<[number, number]>, r: number) => { for (let i = 0; i + 1 < P.length; i++) { const [ax, az] = P[i], [bx, bz] = P[i + 1], n = Math.max(1, Math.ceil(dmath.hypot(bx - ax, bz - az) / 3)); for (let k = 0; k <= n; k++) out.push({ x: ax + (bx - ax) * k / n, z: az + (bz - az) * k / n, r }); } };
    for (const p of pathLines()) if (F.skinRoads.includes(p.id)) lane(p.pts as Array<[number, number]>, p.w * 1.2 + 2);
    lane(F.walkway.map(([x, z]) => [x, z] as [number, number]), 2.5);
    for (const L of F.skinLanes) lane(L, 3.5);
    for (const t of R?.trails ?? []) for (let i = 0; i < t.length; i += 3) out.push({ x: t[i].x, z: t[i].z, r: 2.6 });
    // the lookout's back steps and the foot of every Mist Falls ladder (no fern / grass through a tread)
    for (const [x, z] of R?.lookoutSteps ?? []) out.push({ x, z, r: 1.6 });
    for (const l of LADDERS) if (l.poi === "mist-falls") out.push({ x: l.c.x + l.c.nx * 0.8, z: l.c.z + l.c.nz * 0.8, r: 1.6 }); }
  const pts = F.river; for (let s = 0; s + 1 < pts.length && s < 10; s++) { for (let i = 0; i < 3; i++) { const t = (i + 0.5) / 3; out.push({ x: pts[s][0] + (pts[s + 1][0] - pts[s][0]) * t, z: pts[s][1] + (pts[s + 1][1] - pts[s][1]) * t, r: 13 }); } }
  for (const [x, z, rx, rz] of F.sandbars) out.push({ x, z, r: Math.max(rx, rz) * 0.9 });
  // the pale terrain boulders perched on the gorge's north rim / the lookout shoulder (hanging
  // off 70°+ faces in the poi-09 + biome-06 skylines): small keep-outs so terrain-rocks leaves them out (shared/world/rock-keeps)
  for (const [x, z, r] of [[-135.7, -349.9, 7], [-146.5, -351.3, 6.5], [-173.2, -356.9, 5], [-141, -349.8, 4.5], [-144.4, -345.9, 2.5], [-99.9, -355.3, 4], [-101, -354.5, 2.5], [-99.9, -358.1, 2], [-102, -447.6, 2.4]] as Array<[number, number, number]>) out.push({ x, z, r });
  return out;
}
