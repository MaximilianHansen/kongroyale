// KONG ROYALE island generator (terrain area). Deterministic — the terrain bake tool runs this and
// writes public/assets/terrain/island.bin; client + server load the SAME bytes (decodeTerrainFile). generateTerrain()
// returns exactly what decodeTerrainFile(encodeTerrainFile(...)) returns (heights quantised to cm, content hash set),
// so a server that still generates in-process agrees bit-for-bit with a client that loads the file, as long as the
// file is fresh (the bake's check mode fails when it is not). Compare `TerrainData.hash` at join.
//
// The coastline is HAND-AUTHORED (COAST, traced from the target art's aerial of the island, then bent to every POI's
// shore promise: harbor quay faces open water S/E, cove bay south of the resort, wreck beach W, lighthouse
// cliffs W/NW, lagoon NE).
// Relief = rolling jungle hills + authored features (volcano cone with branching gullies, ridges, rock-walled mesas,
// sea-cliff plateaus), then droplet erosion, strata terracing on cliffs, POI pads, the MIST FALLS gorge + river, gentle
// dirt paths, biomes.
// Passes: coast mask (+ mangrove islet field) → signed coast distance → narrow reef shelf / beach / hills → features →
// erosion → terraces → pads → harbor keep-low → gorge + river → paths → exact coast distance → biomes → quantise + hash.
// Contract kept: POI pad promises (map.ts), sea level 0, TerrainData { heights, biome, res } + extras (coast, path, hash).
import { Biome, POIS, WORLD, poiById } from "./map";
import { Simplex2, clamp, lerp, mulberry32, smoothstep } from "./noise";
import type { Box } from "./colliders";
import { gzipSync, gunzipSync } from "three/examples/jsm/libs/fflate.module.js";
import * as dmath from "../sim/dmath";

export interface TerrainData {
  heights: Float32Array;
  biome: Uint8Array;
  res: number;
  /** signed distance to the shoreline in metres (+ land, − sea), clamped to ±127 */
  coast: Int8Array;
  /** dirt-path coverage 0..255 (255 = path centre) */
  path: Uint8Array;
  /** FNV-1a content hash of the quantised data (see terrainHash) — equal on client and server when they agree */
  hash?: number;
  /** (file v4) the molten lava channels, traced ONCE by the generator before it carved their beds + levees into
   * the heights (a re-trace on the carved ground would wander) — lavaChannels(t) returns these when present */
  lava?: LavaLine[];
  /** (file v5) rock keep-outs = every POI's vegetation / prop clearings (shared/pois/*.ts `clearings`), snapshot by
   * the terrain bake (terrain-gen cannot import the POIs: import cycle). terrainRocks() drops every rock inside one,
   * so the server's colliders and the client's rocks agree. r > 0: circle (x, z, r); r = 0: rect (x, z, hx, hz, yaw) */
  keep?: RockKeep[];
}
export interface RockKeep { x: number; z: number; r: number; hx: number; hz: number; yaw: number }

interface Ellipse { x: number; z: number; a: number; b: number; rot: number }
type Pt = [number, number];

// ================================================================ layout (metres, +X east, −Z north)
/** main island coastline, closed, Catmull-Rom smoothed. Order: N coast W→E, E coast, harbor, cove, S beach, lighthouse
 * headland, W coast, NW. Every vertex near a POI is pinned to that POI's shore promise (see comments). */
const COAST: Pt[] = [
  // north coast (volcano N flank → wreck bay → lab shoulder → lagoon barrier). East of x≈220 the north shore curves in
  // toward the lagoon lobe; the NW volcano lobe bulges out.
  [-560, -884], [-470, -906], [-395, -890], [-300, -846], [-205, -792], [-125, -770], [-78, -752],
  [-34, -708], [-2, -670], [40, -652], [86, -656], [128, -664], [168, -654], [218, -632],
  // the NE lagoon lobe — the north shore east of x≈300 is pulled in to a 50–70 m sand barrier (a spit either
  // side of the lagoon mouth) between the lagoon and the open sea
  [286, -604], [338, -568], [396, -538], [456, -530], [512, -532], [566, -516], [620, -486], [676, -446], [742, -394], [792, -322], [840, -244],
  // east coast: long white beach from the cut-back NE corner down to the port, bulging east
  [884, -160], [934, -84], [966, 0], [948, 100], [904, 170],
  // PEEL HARBOR: apron east edge x=880 (berth, water beyond), SE corner (880,430)→(770,430), diagonal to (660,540),
  // south edge z=540 (the inlet). The land stops just inside the apron so its edges are quay walls over water.
  [868, 222], [860, 262], [858, 332], [860, 408], [846, 420], [776, 422], [700, 470], [662, 524], [620, 530], [520, 530], [452, 530],
  // rocky headland between the port inlet and COCONUT COVE (cliffs both sides; the biome-03 highlands ridge ends here)
  [428, 552], [414, 592], [394, 628], [362, 652], [330, 642], [312, 612], [302, 578], [286, 552],
  // cove head + resort beach (pier crosses the waterline at ≈(195,540); bungalows (244,574),(270,600) stand in water).
  // West of the pier the bay bites north so the sand reaches the resort pad's edge (z≈510)
  [252, 540], [212, 538], [164, 534], [118, 528], [70, 525], [20, 526], [-40, 530], [-100, 534],
  // the long south beach curves north into a deeper bay (a concave south coast) to the lighthouse headland
  [-170, 532], [-260, 536], [-350, 556], [-432, 588], [-500, 624], [-540, 652],
  // LOOKOUT POINT headland: SE side → SW tip → W cliff (x≈−688, 45–55 m from the pad edge, a small bay bitten into it
  // at z≈585 so the cliff-top path looks ACROSS at layered faces — biome-05) → NW nook where the lookout's cliff stair
  // reaches the water at ≈(−655,400)
  [-576, 684], [-612, 714], [-652, 726], [-682, 702], [-694, 650], [-690, 628], [-672, 610], [-662, 586], [-668, 562], [-686, 538], [-690, 506], [-684, 470], [-674, 432], [-660, 410],
  // a deep sandy bay between the lighthouse headland and the wreck beach (the W coast is strongly concave here, so the
  // lighthouse stands on a real peninsula)
  [-664, 394], [-648, 366], [-636, 330], [-642, 292], [-668, 254], [-722, 214], [-790, 176],
  // THE WRECK beach: shoreline x≈−842 for z 40..140 (ship sections sit in the shallows west of it)
  [-842, 120], [-844, 60], [-838, 0],
  // west coast: airstrip plateau cliffs, COCO CAVES cliffs, black-lava NW coast
  [-816, -62], [-846, -124], [-888, -192], [-930, -262], [-952, -336], [-940, -410], [-905, -482], [-852, -566], [-782, -660], [-706, -748], [-630, -828],
];
/** the lobby islet (pre-game) */
const LOBBY: Ellipse = { x: 0, z: 1020, a: 125, b: 90, rot: 0.3 };
/** NE mangrove lagoon (water inside the island) + the mouth channel to the north sea. STILT TOWN sits at (330,-330)
 * (its own islet props at 318..402 × −388..−286), THE MURK swamp at its SE end. */
// (lobed east of STILT TOWN — bays and headlands every ~50 m instead of a smooth oval pool)
const LAGOON: Pt[] = [
  // (the east lobe reaches far east — veg's STILT TOWN clearing (r 120 round (350, −330)) leaves the
  // west half treeless, so the forested islets + channels live in this east half)
  [226, -330], [244, -386], [290, -426], [360, -456], [440, -472], [478, -496], [520, -474], [556, -482], [592, -462],
  [630, -446], [662, -420], [690, -390], [712, -356], [718, -318], [704, -286], [672, -270], [636, -272], [604, -262], [584, -248], [562, -250], [526, -222],
  [490, -238], [452, -228], [420, -248], [350, -262], [290, -282], [250, -302],
];
const LAGOON_MOUTH: Pt[] = catmull([[540, -452], [530, -500], [548, -540], [578, -572], [592, -630]], 6, false);
const LAGOON_MOUTH_W = 20;
function hash2(i: number, j: number, s: number) {
  let h = Math.imul(i | 0, 374761393) ^ Math.imul(j | 0, 668265263) ^ Math.imul(s | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
/** The lagoon is FULL of rounded tree-covered islets separated by winding turquoise channels, with distinct green
 * islets and visible blue channels from 2 km: an EXPLICIT islet list — one
 * islet per 44 m jittered cell, 20–44 m across (a few bigger ones), each shrunk until it keeps ≥ 14 m of open channel to
 * every neighbour, to the lagoon shore and to the keep-outs (STILT TOWN's market water, the mouth channel, the river
 * mouth). A keep-out drops or shrinks WHOLE islets — a smooth-min would slice them into bare low mud flats. Narrower
 * channels get closed over by the canopy. */
interface Islet { x: number; z: number; R: number; an: number; el: number }
let ISLETS: Islet[] | null = null;
/** metres from (x, z) to the nearest lagoon keep-out (< 0 inside one) */
function lagoonKeepD(x: number, z: number): number {
  const bx = Math.max(380 - x, x - 470, Math.abs(z + 336) - 34);
  // + veg's STILT TOWN clearing (shared/pois/stilt-town.ts: r 120 round (350, −330)) — an islet inside it would stay a
  // bare mud flat
  const vegClear = dmath.hypot(x - 350, z + 330) - 124;
  // + THE MURK's swamp (its pools / hummocks overwrite the lagoon heights out to ~1.4 r)
  const murk = dmath.hypot(x - MURK.x, (z - MURK.z) * 1.1) - MURK.r * 0.85;
  // (the mouth keep only where the channel cuts the barrier, z < −470 — inside the lagoon body islets may flank it)
  return Math.min(vegClear, murk, dmath.hypot(x - STILT_KEEP.x, z - STILT_KEEP.z) - STILT_KEEP.r, bx, z < -470 ? polyDist(LAGOON_MOUTH, x, z).d - 26 : 1e9,
    dmath.hypot(x - 280, z + 322) - 34, dmath.hypot(x - 245, z + 336) - 36);   // river mouth (poi-jungle's water ends at (240,−330))
}
export function lagoonIslets(): Islet[] {
  if (ISLETS) return ISLETS;
  const poly = LAGOON_POLY ?? (LAGOON_POLY = catmull(LAGOON, 6, true));
  const P = 52, out: Islet[] = [];
  for (let i = Math.floor(200 / P); i <= Math.ceil(680 / P); i++) for (let j = Math.floor(-520 / P); j <= Math.ceil(-200 / P); j++) {
    if (hash2(i, j, 33) < 0.06) continue;                                  // an open pool where channels meet
    const x = (i + 0.5 + 0.4 * (hash2(i, j, 31) - 0.5)) * P, z = (j + 0.5 + 0.4 * (hash2(i, j, 32) - 0.5)) * P;
    if (!inPoly(poly, x, z)) continue;
    const big = hash2(i, j, 37) < 0.25;
    const el = 1 + 0.4 * hash2(i, j, 36), major = Math.sqrt(el);
    let R = big ? 24 + 6 * hash2(i, j, 34) : 16 + 6 * hash2(i, j, 34);
    R = Math.min(R, (lagoonKeepD(x, z) - 6) / major, (-edgeDist(poly, x, z) - 10) / major);
    if (R < 8) continue;
    out.push({ x, z, R, an: hash2(i, j, 35) * Math.PI, el });
  }
  // open channels ≥ 14 m between neighbours (conservative: the ellipses' major semi-axes)
  for (let pass = 0; pass < 3; pass++) for (let a = 0; a < out.length; a++) for (let b = a + 1; b < out.length; b++) {
    const A = out[a], B = out[b], d = dmath.hypot(A.x - B.x, A.z - B.z), ra = A.R * Math.sqrt(A.el), rb = B.R * Math.sqrt(B.el);
    const over = ra + rb + 13 - d;
    if (over <= 0) continue;
    const s = (ra + rb - over) / (ra + rb);
    A.R *= s; B.R *= s;
  }
  return (ISLETS = out.filter((q) => q.R >= 8));
}
/** > 0 inside a lagoon islet (≈ metres inside its shore) */
function isletD(n: Simplex2, x: number, z: number): number {
  const wx = x + 5 * n.fbm(x / 60 + 3.3, z / 60, 2), wz = z + 5 * n.fbm(x / 60, z / 60 + 7.7, 2);
  let best = -1e9;
  for (const q of lagoonIslets()) {
    const dx = wx - q.x, dz = wz - q.z;
    if (Math.abs(dx) > 70 || Math.abs(dz) > 70) continue;
    const c = dmath.cos(q.an), s = dmath.sin(q.an), lx = dx * c + dz * s, lz = -dx * s + dz * c;
    best = Math.max(best, q.R - dmath.hypot(lx / Math.sqrt(q.el), lz * Math.sqrt(q.el)));
  }
  return best + 1.6 * n.fbm(x / 11, z / 11, 2);
}
let LAGOON_POLY: Pt[] | null = null;
/** 0..1: inside the NE lagoon or within ~60 m of its shore, or in THE MURK — the client splat keeps these shores
 * mangrove-green (only the Beach-biome islet rims are sand), instead of the open-sea "low ground → sand" rule */
export function lagoonShoreAt(x: number, z: number): number {
  if (x < 100 || x > 780 || z < -600 || z > -60) return 0;
  const poly = LAGOON_POLY ?? (LAGOON_POLY = catmull(LAGOON, 6, true));
  const e = edgeDist(poly, x, z);
  // (fades out 90–130 m from the shore — the splat's "low ground within 80 m of water → sand" rule would paint a
  // sand band 60–100 m inland round the lagoon)
  return Math.max(1 - smoothstep(90, 130, e), 1 - smoothstep(MURK.r * 0.9, MURK.r * 1.5, dmath.hypot(x - MURK.x, (z - MURK.z) * 1.1)));
}
/** STILT TOWN market (keep its water open) */
const STILT_KEEP = { x: 368, z: -333, r: 78 };
/** THE PLANTATION crop field (farmland ground) = the POI's planted disc (shared/pois/the-plantation.ts: rows fill r ≈ 150
 * around the pad centre, rows run along ROW_DIR (0.8, −0.6), 3.7 m apart). `yaw` = direction ACROSS the rows (the farm
 * texture's u axis), so the furrows run with the planted rows. */
const PLANT_POI = poiById("the-plantation");
export const PLANTATION_FIELD = { x: PLANT_POI.x, z: PLANT_POI.z, r: 150, yaw: dmath.atan2(0.8, 0.6), rowGap: 3.7 };
/** THE MURK: low mangrove swamp with pools at the lagoon's SE end */
export const MURK = { x: 572, z: -214, r: 120 };

/** the cone: crater floor `floor`, lip `rim` at r≈`crater`, concave cinder cone out to `cone` (h≈coneH), jungle skirt to
 * `base` (h≈baseH). `peak` kept for old readers. */
export const VOLCANO = { x: -380, z: -430, peak: 252, rim: 252, floor: 208, crater: 62, cone: 196, coneH: 88, base: 330, baseH: 50 };
/** black cinder badlands with lava seams (biome-04-volcanic) — lava tongues from the W foot of the cone down to the
 * black NW coast. `r` bounds the field; the exact shape is badlandsW() (a noisy fan). */
export const BADLANDS = { x: -640, z: -540, r: 170 };
/** 0..1 badlands membership (shared by biome + client material): fan of lava tongues NW of the cone */
export function badlandsW(n: Simplex2, x: number, z: number): number {
  const dx = x - VOLCANO.x, dz = z - VOLCANO.z, r = dmath.hypot(dx, dz), a = dmath.atan2(dz, dx);
  // centred on bearing ≈ 205° (WNW), spanning ±55°, from the cone foot (r≈150) out to the coast
  let da = a - 3.6; while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI;
  const tongues = 0.5 + 0.5 * dmath.sin(a * 9 + 1.3 * n.fbm(r / 90, a * 2, 2));
  const fan = 1 - smoothstep(0.32, 0.6, Math.abs(da) + 0.18 * n.fbm(x / 120 + 3, z / 120, 3) - 0.2 * tongues);
  // (the lava field runs out to the black cliffs of the NW lobe)
  return fan * smoothstep(140, 180, r) * (1 - smoothstep(400, 450, r + 30 * n.fbm(x / 80, z / 80, 2)));
}
/** rock strata: cliff terraces and the courses of the masonry-like cliff blocks share these horizontal bands (m) */
export const STRATA = { band: 5.0, off: 0.6 };
const NOISE_GULLY = new Simplex2(WORLD.SEED + 71), NOISE_GULLY_W = new Simplex2(WORLD.SEED + 72);
/** erosion-gully depth (m) on the cinder cone at (x, z): irregular BRANCHING radial channels (noise in a polar domain
 * stretched along the fall line, warped so they wander and merge), 2–3 m near the rim, up to ~10 m low on the flank.
 * U-shaped channels (rounded floor, soft shoulders — the profile has no crease, so the 2 m grid can no longer
 * zipper a V-notch along every gully line) with sharper ribs left standing between them. */
export function coneGully(x: number, z: number): number {
  const V = VOLCANO, dx = x - V.x, dz = z - V.z, vr = dmath.hypot(dx, dz);
  if (vr < V.crater * 0.8 || vr > V.cone + 40) return 0;
  const ang = dmath.atan2(dz, dx), arc = ang * 150;
  // trunk gullies: a function of the angle (continuous from the rim to the foot), wandering slowly with radius.
  // ~16 trunks round the cone, cut 3.5 m deep right below the lip — sharp ribs all the way up a ridged cone
  const wu = arc + 16 * NOISE_GULLY_W.fbm(dmath.cos(ang) * 1.7 + 3, dmath.sin(ang) * 1.7 + vr / 150, 3);
  const t = clamp((vr - V.crater) / (V.cone - V.crater), 0, 1);
  const q1 = Math.abs(NOISE_GULLY.noise(wu / 58, vr / 900));
  const trunk = 1 - smoothstep(0, 0.36, q1);
  // branches: finer tributaries that appear low on the flank and merge into the trunks
  const q2 = Math.abs(NOISE_GULLY.noise(wu / 19 + 7.3, vr / 140 + 3.1));
  const branch = (1 - smoothstep(0, 0.24, q2)) * smoothstep(0.35, 0.85, t) * 0.55;
  const g = trunk + branch - trunk * branch; // soft union (no crease where a branch meets its trunk)
  // depth: 3.5 m under the lip, ~11 m mid-flank, shallowing to ~4 m at the foot and fading out over the skirt — a
  // gully that ended 11 m deep at the foot left a pit there (lava rivers pooled in it instead of reaching the field)
  return g * (3.5 + 7.5 * smoothstep(0.08, 0.6, t) - 6.5 * smoothstep(0.72, 1.0, t)) * (1 - smoothstep(V.cone - 5, V.cone + 45, vr));
}
const NOISE_RILL = new Simplex2(WORLD.SEED + 74);
/** Fine radial RILLS (no hard-seamed flat facets on the flanks) between the trunk
 * gullies — ~44 round the cone (≈ 10 m apart under the rim, 14 m mid-flank), a second set of 88 low on the flank so the
 * spacing never exceeds ~16 m; sharp crests (two parabolas meet), rounded floors, each rill's depth varies (1–4 m), the
 * lines wander slowly. They live in the HEIGHTFIELD (the 2 m normal texture shades them at every distance — the old
 * screen-derivative flute bump drew dotted grids and moiré at eye level). Weaker on ripe-peak's terraced fan (bearing
 * 2.40 ± 0.8), where poi-jungle's benches stand. Depth (m, ≥ 0). */
export function coneRill(x: number, z: number): number {
  const V = VOLCANO, dx = x - V.x, dz = z - V.z, vr = dmath.hypot(dx, dz);
  if (vr < V.crater + 3 || vr > V.cone + 55) return 0;
  const ang = dmath.atan2(dz, dx), t = clamp((vr - V.crater) / (V.cone - V.crater), 0, 1.3);
  const wand = 0.045 * NOISE_RILL.fbm(dmath.cos(ang) * 1.6 + 2, dmath.sin(ang) * 1.6 + vr / 130, 2);
  const set = (n: number, s: number) => {
    const ph = (ang + wand) * n / (2 * Math.PI) + 0.28 * NOISE_RILL.noise(dmath.cos(ang) * 3 + s, dmath.sin(ang) * 3 + vr / 70);
    const u = Math.abs(ph - Math.floor(ph) - 0.5) * 2;   // 0 at the rill floor, 1 on the crest
    const k = 0.5 + 0.5 * NOISE_RILL.noise(Math.floor(ph) * 0.37 + s, vr / 90);   // per-rill depth (continuous at the crest)
    return (1 - u * u) * (0.35 + 0.65 * k);
  };
  const fan = 0.35 + 0.65 * smoothstep(0.5, 0.95, Math.abs(angD(ang, 2.40)));
  const depth = (1.1 + 2.9 * smoothstep(0.04, 0.45, t) - 2.2 * smoothstep(0.85, 1.25, t)) * fan * (1 - smoothstep(V.cone + 12, V.cone + 50, vr));
  // + big ARÊTES: 22 round the cone (~30 m apart mid-flank), up to ~7 m deep, cusp crests — the cone
  //   is ribbed by sharp ridges that read from 400 m and from the air
  const big = (1.5 + 5.5 * smoothstep(0.08, 0.55, t) - 4.5 * smoothstep(0.8, 1.2, t)) * fan * (1 - smoothstep(V.cone + 12, V.cone + 50, vr));
  return depth * (set(44, 0) + 0.6 * smoothstep(0.45, 0.8, t) * set(88, 17)) / (1 + 0.6 * smoothstep(0.45, 0.8, t)) + big * set(22, 41);
}
const NOISE_RIM = new Simplex2(WORLD.SEED + 73);
/** signed angle difference a − b in (−π, π] */
const angD = (a: number, b: number) => { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d <= -Math.PI) d += 2 * Math.PI; return d; };
/** bearing of the crater's breach notch (WSW, facing the biome-04 lava field): the main lava rivers pour out of it */
export const CRATER_BREACH = 3.55;
/** crater lip height at bearing `a`: an irregular, LOW-frequency lip — a high N/NE wall, a lower S rim and a
 * 12 m breach notch on the WSW side — instead of a uniform ring (a narrow uniform crest aliased into sawteeth) */
export function craterRim(a: number): number {
  const c = dmath.cos(a), s = dmath.sin(a);
  return VOLCANO.rim + 6.5 * NOISE_RIM.noise(c * 1.1 + 5, s * 1.1) + 3.5 * NOISE_RIM.noise(c * 2.4, s * 2.4 + 9) + 4.5 * dmath.cos(a - 5.5)
    - 8 * dmath.exp(-(dmath.pow(angD(a, CRATER_BREACH) / 0.14, 2)));
}
/** rocky buttress spurs (radial ridges with a sharp crest) + shoulder humps that break the cone's smooth silhouette:
 * [bearing, half-width (m), crest height (m), r0, r1]. Kept off the ripe-peak terraces (bearings 0 … 1.55). */
// (tall: stepped rocky shoulders on both flanks; 9–19 m spurs barely show)
export const CONE_SPURS: Array<[number, number, number, number, number]> = [
  [5.18, 26, 28, 70, 215], [5.62, 20, 18, 78, 190], [2.2, 24, 26, 74, 225], [2.62, 18, 17, 90, 200],
  [3.12, 15, 12, 84, 185], [4.28, 16, 14, 80, 205], [4.78, 15, 11, 96, 180],
];
/** shoulder humps (secondary rocky knolls on the flank): [bearing, radius from the cone centre, blob radius, height] */
const CONE_HUMPS: Array<[number, number, number, number]> = [[5.34, 122, 34, 26], [2.14, 150, 32, 22], [3.95, 168, 26, 10], [2.45, 120, 22, 14]];
/** extra relief of the cone at (x, z): spurs + humps (m, ≥ 0) and the crest weight 0..1 (for crag placement) */
export function coneSpur(x: number, z: number): { h: number; crest: number } {
  const V = VOLCANO, dx = x - V.x, dz = z - V.z, vr = dmath.hypot(dx, dz);
  if (vr < V.crater || vr > V.cone + 60) return { h: 0, crest: 0 };
  const a = dmath.atan2(dz, dx);
  let h = 0, crest = 0;
  for (const [sa, w, sh, r0, r1] of CONE_SPURS) {
    const lat = Math.abs(angD(a, sa + 0.06 * NOISE_RIM.noise(vr / 60, sa))) * vr;
    if (lat > w) continue;
    const along = smoothstep(r0, r0 + 35, vr) * (1 - smoothstep(r1 - 45, r1, vr));
    const p = 1 - lat / w, k = along * (0.75 + 0.25 * NOISE_RIM.noise(vr / 23 + sa * 7, sa));
    h = Math.max(h, sh * dmath.pow(p, 1.7) * k);
    crest = Math.max(crest, smoothstep(0.55, 0.9, p) * along);
  }
  for (const [ha, hr, br, hh] of CONE_HUMPS) {
    const hx = V.x + dmath.cos(ha) * hr, hz = V.z + dmath.sin(ha) * hr, d = dmath.hypot(x - hx, z - hz);
    if (d > br * 1.6) continue;
    const g = dmath.exp(-(dmath.pow(d / br, 2)) * 1.6);
    h = Math.max(h, hh * g * (0.8 + 0.2 * NOISE_RIM.noise(x / 14, z / 14)));
    crest = Math.max(crest, smoothstep(0.45, 0.85, g));
  }
  return { h, crest };
}

/** ridges: polyline [x, z, crest height], half-width to the foot `w` */
const RIDGES: Array<{ id: string; pts: Array<[number, number, number]>; w: number; sharp?: number }> = [
  // central spine: volcano SE flank → between PEEL STRIP and the temple → plantation hills
  { id: "spine", w: 200, pts: [[-250, -330, 128], [-170, -190, 102], [-120, -50, 70], [-90, 80, 50], [-30, 190, 30]] },
  // "banana ridge": grassy highland ridge from the jungle down to the cliff headland between the cove and the port
  // (sharp: a narrow crest with concave flanks — the biome-03 camera walks its crest trail, the land falling away to the
  // cove + reef on the right)
  { id: "banana", w: 118, sharp: 2.5, pts: [[110, 170, 36], [200, 262, 56], [270, 336, 68], [318, 404, 62], [350, 470, 58], [372, 545, 46], [378, 610, 30]] },
  // north highlands: the gorge's north wall → lab shoulder
  { id: "north", w: 110, pts: [[-240, -500, 96], [-160, -470, 78], [-60, -470, 62], [40, -470, 46], [110, -520, 40]] },
  // hills between the temple and the town (canopy line runs through them)
  { id: "east", w: 120, pts: [[40, -300, 52], [150, -180, 56], [250, -60, 44], [300, 90, 36]] },
  // lighthouse headland backbone (the lookout pad at 46 is its north end)
  { id: "headland", w: 90, pts: [[-590, 470, 46], [-610, 560, 44], [-630, 650, 38], [-648, 704, 30]] },
];
/** rock-walled jungle tablelands (x, z, r, top) — flat green tops, cliff sides dressed with rock meshes */
const MESAS: Array<[number, number, number, number]> = [
  [-612, -372, 58, 86], [-500, -318, 44, 70], [-40, -318, 46, 66], [-250, -80, 38, 64], [60, -560, 34, 58],
];
/** sea-cliff plateaus: the coast rises straight to `h` (with a wave-cut foot) instead of a beach. w = influence radius */
const CLIFF_ZONES: Array<{ x: number; z: number; w: number; h: number }> = [
  { x: -650, z: 560, w: 230, h: 42 },   // LOOKOUT POINT headland (pad 46): W + S + NW cliffs, sea stacks off the W face
  { x: -800, z: -150, w: 150, h: 18 },  // W coast below the airstrip plateau
  { x: -810, z: -310, w: 160, h: 30 },  // COCO CAVES coast
  { x: -700, z: -620, w: 190, h: 30 },  // black-lava NW coast (badlands)
  { x: -380, z: -800, w: 200, h: 38 },  // N volcano coast
  { x: -90, z: -745, w: 70, h: 16 },    // wreck bay west headland
  { x: 180, z: -715, w: 80, h: 18 },    // wreck bay east headland
  { x: 372, z: 600, w: 120, h: 34 },    // headland between the cove and the port
];
/** THE WRECK beach profile (the POI baked its spill against it): 0.085 m/m up the beach from x = −842, 0.07 m/m down */
const WRECK_BEACH = { x: -842, z: 90, r: 110 };
/** PEEL HARBOR apron outline (copied from shared/pois/peel-harbor.ts APRON — the ground under it is kept ≤ PAD) */
export const HARBOR_APRON: Pt[] = [[500, 215], [540, 190], [700, 190], [720, 220], [780, 230], [880, 230], [880, 430], [770, 430], [660, 540], [440, 540], [440, 260], [460, 240]];
/** deep water at the harbor berth (ship at x≈894) and the inlet */
const HARBOR_DEEP: Array<{ x0: number; x1: number; z0: number; z1: number; h: number }> = [
  { x0: 872, x1: 990, z0: 200, z1: 460, h: -10 }, { x0: 450, x1: 780, z0: 540, z1: 680, h: -6 },
];
/** MIST FALLS: pool + gorge. poi-jungle builds the water; we carve the ground. Heights are ground heights. */
export const FALLS = {
  pool: { x: -150, z: -395, r: 24, floor: 19.5 },
  /** cliff lip the water drops over (top of the fall) */
  lip: { x: -192, z: -412, h: 60 },
  /** upper gorge continues up the flank to here */
  top: { x: -238, z: -428, h: 84 },
};
/** ground heights poi-jungle built timber against (lookout posts, bridge landings): [x, z, h, radius] */
const FALLS_RIM: Array<[number, number, number, number]> = [[-119, -371, 34, 14], [-124, -377, 36, 8]];
/** river bed centreline pool → NE lagoon, [x, z]; bed descends 19.5 m → −1 m */
export const RIVER: Pt[] = [[-150, -395], [-95, -404], [-30, -420], [55, -402], [140, -362], [215, -335], [250, -325], [290, -318]];
const RIVER_W = 11;
/** max cut / fill of the graded road bed outside the POIs (pass 8) */
const ROAD_CF = 10;
/** max CUT of the graded road bed (a ridge more than ROAD_CF above the grade would leave a 40° hump — cut through it) */
const ROAD_CUT = 22;
/** steepest road grade where the design grade (11° / 14°) cannot fit the cut / fill window (pass 8) */
const ROAD_GMAX = 26;
/** hard cap of the road cut (m): beyond it the grade gives instead (pass 8) */
const ROAD_CUT_MAX = 30;
/** max rise / fall per metre from a pad's edge (pass 6b; tan 29°) */
const PAD_RIM_K = 0.55;
/** open grass (highlands / cliff tops / plateaus): everything else inland is jungle */
const MEADOWS: Ellipse[] = [
  // NB ellipse long axis points along (cos rot, −sin rot): rot = −atan2(dz, dx) of the feature's direction
  // corridors, not fields (a big meadow ellipse reads as a hole in a ~95 % canopy from the air): the banana ridge crest
  // round the biome-03-highlands camera, the headland's cliff-top turf, the airstrip's runway verge
  { x: 322, z: 455, a: 150, b: 50, rot: -1.2 },
  { x: -620, z: 560, a: 140, b: 56, rot: 1.35 },    // lighthouse headland top
  { x: -470, z: -40, a: 185, b: 34, rot: 1.08 },    // airstrip: a grass strip along the runway (runs NNE), jungle around
  { x: -612, z: -372, a: 50, b: 50, rot: 0 }, { x: -40, z: -318, a: 40, b: 40, rot: 0 }, { x: 60, z: -560, a: 30, b: 30, rot: 0 },
];
/** dirt-path polylines (POI to POI), Catmull-Rom smoothed + meander. w = half width: roads 3.4 (read from the air), trails 1.5 */
const PATHS: Array<{ id: string; pts: Pt[]; w?: number; /** meander amplitude (m), default 9 roads / 5 trails */ mw?: number }> = [
  { id: "south-loop", pts: [[-470, -40], [-430, 60], [-380, 130], [-310, 190], [-230, 240], [-150, 300], [-60, 340], [10, 390], [90, 400]] },
  { id: "cove-harbor", pts: [[90, 400], [160, 360], [230, 300], [300, 250], [380, 240], [460, 280], [540, 330], [600, 360]] },
  { id: "harbor-market", pts: [[600, 360], [600, 250], [560, 150], [500, 80], [430, 20]] },
  { id: "market-temple", pts: [[430, 20], [350, -30], [260, -40], [160, -70], [70, -110], [-40, -130]] },
  { id: "temple-plantation", pts: [[-40, -130], [-80, -40], [-130, 40], [-190, 130], [-230, 240]] },
  { id: "strip-temple", pts: [[-470, -40], [-380, -90], [-290, -110], [-190, -150], [-110, -150], [-40, -130]] },
  // A straight finish would climb a 16 m ridge at 58° and drop 37 m to the lookout shelf at up to 72°, so the road
  // stops before the ridge and "falls-ridge" (a ≤ 24° line found by A* on the shipped heightfield) crosses it to the
  // head of the stone trail down to the lookout (shared/pois/jungle-falls.ts FALLS.trails). island.bin is NOT
  // regenerated: these lines only paint the road ribbon (client terrain/data.ts); a future terrain bake grades them
  // like every road.
  { id: "temple-falls", w: 1.6, pts: [[-40, -130], [-70, -210], [-80, -290], [-88, -312]] },
  { id: "falls-ridge", w: 1.6, mw: 0, pts: [[-88, -312], [-85, -315], [-82, -318], [-78, -319], [-74, -319], [-70, -319], [-66, -319], [-62, -320], [-58, -322], [-54, -324], [-50, -326], [-50, -330], [-48, -334], [-50, -338], [-54, -338], [-58, -339], [-62, -339], [-66, -339], [-70, -339], [-74, -341], [-77, -345], [-80, -348], [-80, -352], [-82, -356], [-82, -360], [-82, -362]] },
  // (ends at the cone's foot — a line straight up the flank reads as a yellow stripe; ripe-peak's stairs climb on)
  // Starts on the flank above the gorge's 74° south wall (the lookout shelf is reached by the falls-ridge road + stone
  // trail)
  { id: "falls-cone", w: 1.5, pts: [[-163, -353], [-202, -332]] },
  // (runs on THROUGH the lab clearing to wreck bay — two paths meeting at the pad centre draw a hard kink)
  // (the tail swings east of the mesa ring S of wreck bay, clear of the ring's 60–70° wall)
  { id: "market-canopy-lab", pts: [[430, 20], [360, -80], [260, -150], [160, -230], [130, -330], [138, -420], [146, -478], [128, -548], [122, -580], [108, -615], [80, -640], [40, -652]] },
  { id: "canopy-stilt", w: 1.6, pts: [[160, -230], [230, -250], [290, -270], [330, -300]] },
  { id: "market-murk", pts: [[430, 20], [490, -60], [540, -140], [572, -214]] },
  { id: "strip-wreck", pts: [[-470, -40], [-560, 10], [-650, 40], [-730, 70], [-790, 90]] },
  { id: "strip-caves", w: 1.5, pts: [[-470, -40], [-560, -140], [-640, -220], [-720, -290]] },
  { id: "caves-badlands", w: 1.5, pts: [[-720, -290], [-700, -380], [-670, -460], [-640, -540]] },
  { id: "plantation-lookout", pts: [[-230, 240], [-320, 310], [-420, 370], [-510, 420], [-560, 450], [-590, 470]] },
  // (laid along the cliff's lip: it passes ~4 m left of the biome-05 camera, enters the frame bottom-left and runs away
  // along the edge; south of the camera it follows the plateau's cliff EDGE round the little bay — points on the bay's
  // cliff face would be erased by the slope rule)
  { id: "headland-trail", w: 1.15, mw: 0.5, pts: [[-590, 470], [-634, 492], [-656, 516], [-650, 538], [-647.5, 550], [-648.2, 560], [-648.6, 566], [-648, 570], [-646.6, 575.5], [-645.5, 581], [-644.6, 587], [-645, 593], [-647, 600], [-650, 608], [-655, 618], [-660, 630], [-662, 650], [-654, 680]] },
  { id: "temple-canopy", w: 1.6, pts: [[-40, -130], [30, -170], [100, -200], [160, -230]] },
  // a farm perimeter track round the planted field (breaks up the plantation disc)
  { id: "plantation-ring", w: 2.1, mw: 3, pts: [[-60, 240], [-64, 278], [-78, 313], [-100, 344], [-128, 368], [-160, 386], [-194, 398], [-230, 404], [-267, 403], [-303, 392], [-336, 373], [-362, 345], [-380, 312], [-390, 277], [-392, 240], [-388, 204], [-377, 169], [-360, 137], [-335, 108], [-304, 87], [-268, 75], [-230, 72], [-193, 79], [-159, 93], [-129, 113], [-103, 138], [-81, 168], [-67, 203], [-60, 240]] },
  { id: "ridge-trail", w: 1.3, mw: 3.5, pts: [[140, 200], [200, 262], [260, 322], [304, 380], [322, 412], [326, 440], [320, 470], [334, 502], [356, 526], [368, 552], [374, 580]] },
  // the coconut-cove → mango-market walk crosses the ridge-trail's ridge off-trail (a 6.5 m hump at (172, 216)):
  // a short graded saddle trail over it (after ridge-trail: it pins to that bed where they cross)
  // mist-falls → wreck-bay leaves MIST FALLS down a 33–35° hillside for 16 m before its trail starts: a graded
  // connector down to the trail head
  { id: "falls-connector", w: 1.8, mw: 0, pts: [[-86, -465], [-74, -472], [-58, -474], [-46, -478]] },
  // the coastal sinkhole W of COCO CAVES (floor 15 m, 45–53° walls): with the 43–47° slide blend it is a
  // pit you can drop into and never leave (290 m²) — a graded way out over its lowest (NW) rim
  { id: "pit-exit", w: 1.8, mw: 0, pts: [[-884, -265], [-892, -257], [-900, -250], [-908, -243], [-916, -236]] },
  { id: "ridge-saddle", w: 1.8, mw: 0, pts: [[166, 250], [166, 238], [170, 222], [176, 210], [184, 198], [190, 186]] },
  { id: "market-east-beach", w: 1.6, pts: [[430, 20], [560, -20], [690, -60], [800, -80]] },
  { id: "spine-trail", w: 1.4, pts: [[-120, -50], [-100, 40], [-80, 120], [-40, 200], [10, 300]] },
];

// rotation trails between neighbouring POIs: generated offline from the
// preferred walks on the heightfield (stretches not already on a road); pass 8 grades them like every road.
// ---- BEGIN GENERATED ROTATION TRAILS ----
const ROT_TRAILS: Array<{ id: string; pts: Pt[] }> = [
  { id: "rot-mango-market-peel-harbor", pts: [[480,146],[482,164],[518,210]] },
  { id: "rot-coconut-cove-peel-harbor", pts: [[128,270],[118,254],[136,236],[140,240],[156,240],[162,246],[170,246]] },
  { id: "rot-coconut-cove-peel-harbor-1", pts: [[186,238],[196,230],[204,230],[220,234],[230,244],[248,244],[254,250],[272,256]] },
  { id: "rot-peel-harbor-the-murk", pts: [[530,100],[530,-2]] },
  { id: "rot-peel-harbor-the-murk-1", pts: [[530,-18],[530,-108]] },
  { id: "rot-mango-market-stilt-town", pts: [[390,-110],[384,-116],[372,-162],[372,-184],[366,-190],[366,-220]] },
  { id: "rot-coconut-cove-mango-market-1-b6", pts: [[198,220.2],[198,174],[276,94],[292,90],[308,76]] },
  { id: "rot-cnvs-lab-stilt-town", pts: [[200,-404],[208,-384],[220,-368]] },
  { id: "rot-stilt-town-the-murk", pts: [[416,-250],[430,-248],[442,-238],[462,-234]] },
  { id: "rot-canopy-line-the-murk", pts: [[260,-230],[363,-229]] },
  { id: "rot-canopy-line-the-murk-b2", pts: [[374.9,-228.9],[442.2,-228.2]] },
  { id: "rot-banana-temple-cnvs-lab", pts: [[6,-248],[74,-316],[82,-344],[88,-350],[124,-334]] },
  { id: "rot-banana-temple-cnvs-lab-1", pts: [[126,-370],[102,-394],[102,-404]] },
  { id: "rot-coco-caves-ripe-peak", pts: [[-634,-320],[-578,-328],[-552,-352],[-542,-352]] },
  { id: "rot-peel-strip-ripe-peak", pts: [[-602,-194],[-588,-212],[-588,-222],[-596,-232],[-598,-242],[-574,-264],[-572,-276],[-564,-284],[-552,-284],[-512,-308]] },
  { id: "rot-cnvs-lab-mist-falls", pts: [[60,-480],[42,-466],[-36,-466],[-70,-456]] },
  { id: "rot-cnvs-lab-wreck-bay", pts: [[128,-568],[118,-602],[102,-624]] },
  { id: "rot-banana-temple-the-plantation", pts: [[-142,40],[-204,38],[-226,58],[-262,60],[-264,64]] },
  { id: "rot-lookout-point-the-wreck", pts: [[-568,382],[-564,366],[-620,310],[-620,302],[-722,200]] },
  { id: "rot-lookout-point-peel-strip-b5", pts: [[-557.6,356.7],[-556,304],[-548,290],[-548,262],[-536,212],[-532,118]] },
  { id: "rot-coco-caves-the-wreck", pts: [[-750,-204],[-750,-102],[-758,-38]] },
  { id: "rot-mist-falls-wreck-bay-b12", pts: [[-37.2,-476.7],[-18,-496],[-10,-522],[0,-534],[0,-552],[8,-570],[8,-586],[26,-602]] },
  { id: "rot-stilt-town-wreck-bay", pts: [[304,-444],[306,-526],[272,-560],[272,-572],[232,-614],[194,-626],[186,-632],[178,-632],[144,-660],[130,-660]] },
];
// ---- END GENERATED ROTATION TRAILS ----
// the open stretches of the preferred rotation routes (generated offline) — the cover pass dresses them
// ---- BEGIN GENERATED COVER LINES ----
const ROT_COVER: Pt[][] = [
  [[490,142],[490,170],[520,206]],
  [[206,330],[270,266],[298,252],[398,248],[418,254],[446,278]],
  [[558,194],[558,166],[550,150],[550,82]],
  [[560,-18],[564,-50],[602,-84],[596,-124]],
  [[480,-106],[498,-124],[498,-140]],
  [[380,-106],[380,-194],[374,-218]],
  [[240,-170],[254,-154],[286,-136],[342,-86]],
  [[-32,340],[-66,306],[-86,296]],
  [[170,290],[180,278],[182,242],[196,222],[202,174],[284,90],[304,80]],
  [[196,-402],[218,-378]],
  [[416,-250],[460,-234]],
  [[260,-230],[272,-228]],
  [[388,-228],[460,-228]],
  [[-74,-252],[-76,-308],[-48,-332],[-62,-352]],
  [[12,-246],[78,-322],[78,-334],[86,-346],[118,-332],[122,-324],[132,-328],[132,-344],[120,-368],[114,-396]],
  [[-634,-320],[-586,-326],[-548,-354]],
  [[-316,-126],[-302,-142],[-310,-152],[-310,-212],[-318,-236],[-332,-252]],
  [[60,-470],[36,-464],[-44,-464],[-68,-454]],
  [[128,-568],[126,-584],[102,-616]],
  [[132,-326],[132,-342],[114,-394]],
  [[-654,-228],[-590,-164]],
  [[-630,22],[-646,28],[-662,44],[-670,46]],
  [[-354,86],[-324,116]],
  [[-92,-14],[-120,18],[-142,74],[-164,98]],
  [[-512,424],[-456,390],[-440,388],[-420,378],[-368,326],[-360,324]],
  [[-570,382],[-570,366],[-580,342],[-720,202]],
  [[-568,382],[-564,374],[-560,302],[-548,290],[-548,258],[-540,234],[-540,118]],
  [[-750,-204],[-752,-64],[-756,-40]],
  [[-90,-476],[-76,-496],[-60,-496],[-44,-486],[-28,-490],[-16,-502],[-16,-510],[-2,-534],[8,-582],[22,-598]],
  [[302,-444],[302,-528],[274,-556],[270,-572],[214,-620],[182,-630],[170,-640],[134,-640],[126,-644]],
];
// ---- END GENERATED COVER LINES ----

/** the terrain area's fixed ground-level view cameras (client/src/world/terrain/index.ts builds its views from these).
 * y values are metres ABOVE the ground at that xz (rel). Rock scatter keeps clear of every camera (CAM_KEEP_R) and of
 * its first 35 m of view, so no rock ever sits in (or right in front of) one of these cameras. */
export const TERRAIN_CAMS: Record<string, { pos: [number, number, number]; target: [number, number, number]; fov: number }> = {
  // on the banana ridge's crest trail, looking SSW down the ridge: the trail winds away down-left toward the headland
  // knoll, big grey boulders along it, the flank falls away right to the COCONUT COVE bay (reef flats, pier, beach)
  "biome-03-highlands": { pos: [320, 3.0, 418], target: [250, 5, 640], fov: 66 },
  // on the lighthouse headland's cliff-top path, looking SW across the little bay at the layered W face, stacks right
  // (the camera stands right AT the cliff edge, pitched a little down — horizon near mid-frame, big sky: the layered skin
  // wall fills the left, the bay floor + boulders below, the hero stack pair centre-right, and the cliff-top trail runs
  // away along the edge on the left)
  "biome-05-sea-cliffs": { pos: [-652, 1.9, 563], target: [-712, 26, 655], fov: 62 },
  // in the black lava field WNW of the cone: a glowing lava river snaking toward the camera through cracked crust and
  // basalt rubble, the cone (lava rivers down its gullies) centre-right
  "biome-04-volcanic": { pos: [-690, 10, -620], target: [-455, -42, -560], fov: 66 },
};
const CAM_KEEP_R = 3;

// ================================================================ helpers
function ellipseD(e: Ellipse, x: number, z: number): number {
  const c = dmath.cos(e.rot), s = dmath.sin(e.rot);
  const lx = (x - e.x) * c - (z - e.z) * s, lz = (x - e.x) * s + (z - e.z) * c;
  const q = dmath.hypot(lx / e.a, lz / e.b);
  return (1 - q) * Math.min(e.a, e.b);
}
const smax = (a: number, b: number, k: number) => { const h = clamp(0.5 + 0.5 * (a - b) / k, 0, 1); return lerp(b, a, h) + k * h * (1 - h); };

/** distance from p to polyline + parameter t (metres along) */
function polyDist(pts: Pt[], x: number, z: number): { d: number; t: number; seg: number } {
  let best = Infinity, bt = 0, bs = 0, acc = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const ax = pts[i][0], az = pts[i][1], bx = pts[i + 1][0], bz = pts[i + 1][1];
    const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
    let u = L2 > 0 ? ((x - ax) * dx + (z - az) * dz) / L2 : 0;
    u = clamp(u, 0, 1);
    const px = ax + dx * u, pz = az + dz * u, d = dmath.hypot(x - px, z - pz);
    if (d < best) { best = d; bt = acc + Math.sqrt(L2) * u; bs = i; }
    acc += Math.sqrt(L2);
  }
  return { d: best, t: bt, seg: bs };
}
function polyLen(pts: Pt[]) { let l = 0; for (let i = 0; i + 1 < pts.length; i++) l += dmath.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]); return l; }
function polyAt(pts: Pt[], t: number): Pt {
  for (let i = 0; i + 1 < pts.length; i++) {
    const L = dmath.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    if (t <= L || i === pts.length - 2) { const u = clamp(t / L, 0, 1); return [lerp(pts[i][0], pts[i + 1][0], u), lerp(pts[i][1], pts[i + 1][1], u)]; }
    t -= L;
  }
  return pts[pts.length - 1];
}
/** Catmull-Rom (centripetal-ish uniform) resample of a polyline; closed = wraps */
export function catmull(pts: Pt[], sub: number, closed: boolean): Pt[] {
  const n = pts.length, out: Pt[] = [];
  const P = (i: number): Pt => closed ? pts[((i % n) + n) % n] : pts[clamp(i, 0, n - 1)];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    for (let s = 0; s < sub; s++) {
      const t = s / sub, t2 = t * t, t3 = t2 * t;
      out.push([
        0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ]);
    }
  }
  if (!closed) out.push(pts[n - 1]);
  return out;
}
/** even-odd scanline fill of a closed polygon into a res² mask (value v) */
function fillPoly(mask: Uint8Array, res: number, poly: Pt[], v: number) {
  const H = WORLD.HALF, C = WORLD.CELL, xs: number[] = [];
  for (let i = 0; i < res; i++) {
    const z = -H + i * C; xs.length = 0;
    for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
      const za = poly[a][1], zb = poly[b][1];
      if ((za > z) !== (zb > z)) xs.push(poly[a][0] + (z - za) / (zb - za) * (poly[b][0] - poly[a][0]));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const j0 = Math.max(0, Math.ceil((xs[k] + H) / C)), j1 = Math.min(res - 1, Math.floor((xs[k + 1] + H) / C));
      for (let j = j0; j <= j1; j++) mask[i * res + j] = v;
    }
  }
}
function inPoly(poly: Pt[], x: number, z: number): boolean {
  let c = false;
  for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
    const za = poly[a][1], zb = poly[b][1];
    if ((za > z) !== (zb > z) && x < poly[a][0] + (z - za) / (zb - za) * (poly[b][0] - poly[a][0])) c = !c;
  }
  return c;
}

/** signed distance to a closed polygon's boundary: − inside, + outside (metres) */
function edgeDist(poly: Pt[], x: number, z: number): number {
  let best = Infinity;
  for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
    const ax = poly[b][0], az = poly[b][1], dx = poly[a][0] - ax, dz = poly[a][1] - az, L2 = dx * dx + dz * dz;
    const u = L2 > 0 ? clamp(((x - ax) * dx + (z - az) * dz) / L2, 0, 1) : 0;
    best = Math.min(best, dmath.hypot(x - ax - dx * u, z - az - dz * u));
  }
  return inPoly(poly, x, z) ? -best : best;
}

/** exact Euclidean distance transform (Felzenszwalb) of a boolean mask, in cells */
function edt(mask: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e12;
  const f = new Float32Array(Math.max(w, h)), d = new Float32Array(Math.max(w, h));
  const v = new Int32Array(Math.max(w, h)), zz = new Float32Array(Math.max(w, h) + 1);
  const out = new Float32Array(w * h);
  const dt1 = (n: number) => {
    let k = 0; v[0] = 0; zz[0] = -INF; zz[1] = INF;
    for (let q = 1; q < n; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= zz[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; zz[k] = s; zz[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) { while (zz[k + 1] < q) k++; d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]; }
  };
  for (let x = 0; x < w; x++) { for (let y = 0; y < h; y++) f[y] = mask[y * w + x] ? 0 : INF; dt1(h); for (let y = 0; y < h; y++) out[y * w + x] = d[y]; }
  for (let y = 0; y < h; y++) { for (let x = 0; x < w; x++) f[x] = out[y * w + x]; dt1(w); for (let x = 0; x < w; x++) out[y * w + x] = Math.sqrt(d[x]); }
  return out;
}

function blur(src: Float32Array, res: number, r: number): Float32Array {
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  const n = 2 * r + 1;
  for (let i = 0; i < res; i++) for (let j = 0; j < res; j++) { let s = 0; for (let o = -r; o <= r; o++) s += src[i * res + clamp(j + o, 0, res - 1)]; tmp[i * res + j] = s / n; }
  for (let i = 0; i < res; i++) for (let j = 0; j < res; j++) { let s = 0; for (let o = -r; o <= r; o++) s += tmp[clamp(i + o, 0, res - 1) * res + j]; out[i * res + j] = s / n; }
  return out;
}

/** droplet hydraulic erosion (Lague-style), land only. Deterministic. */
function erode(h: Float32Array, res: number, seed: number, drops: number, landW: (k: number) => number) {
  const rnd = mulberry32(seed);
  const R = 3, inertia = 0.06, capacityK = 4.5, minCap = 0.01, deposit = 0.25, erodeK = 0.35, evap = 0.012, gravity = 4, life = 36;
  const bx: number[] = [], by: number[] = [], bw: number[] = [];
  let wsum = 0;
  for (let y = -R; y <= R; y++) for (let x = -R; x <= R; x++) { const d = dmath.hypot(x, y); if (d <= R) { bx.push(x); by.push(y); const w = 1 - d / R; bw.push(w); wsum += w; } }
  for (let i = 0; i < bw.length; i++) bw[i] /= wsum;
  const grad = (px: number, py: number) => {
    const x0 = px | 0, y0 = py | 0, u = px - x0, v = py - y0, k = y0 * res + x0;
    const a = h[k], b = h[k + 1], c = h[k + res], d = h[k + res + 1];
    return { gx: (b - a) * (1 - v) + (d - c) * v, gy: (c - a) * (1 - u) + (d - b) * u, hh: a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v };
  };
  for (let n = 0; n < drops; n++) {
    let px = 1 + rnd() * (res - 3), py = 1 + rnd() * (res - 3);
    if (landW(((py | 0) * res + (px | 0))) < 0.5) continue;
    let dx = 0, dy = 0, speed = 1, water = 1, sed = 0;
    for (let l = 0; l < life; l++) {
      const x0 = px | 0, y0 = py | 0;
      if (x0 < 1 || y0 < 1 || x0 >= res - 2 || y0 >= res - 2) break;
      const g = grad(px, py);
      dx = dx * inertia - g.gx * (1 - inertia); dy = dy * inertia - g.gy * (1 - inertia);
      const len = dmath.hypot(dx, dy); if (len === 0) break;
      dx /= len; dy /= len;
      const nx = px + dx, ny = py + dy;
      if (nx < 1 || ny < 1 || nx >= res - 2 || ny >= res - 2) break;
      const g2 = grad(nx, ny), dh = g2.hh - g.hh;
      const cap = Math.max(-dh * speed * water * capacityK, minCap);
      if (sed > cap || dh > 0) {
        const amt = dh > 0 ? Math.min(dh, sed) : (sed - cap) * deposit;
        sed -= amt;
        const u = px - x0, v = py - y0, k = y0 * res + x0;
        h[k] += amt * (1 - u) * (1 - v); h[k + 1] += amt * u * (1 - v); h[k + res] += amt * (1 - u) * v; h[k + res + 1] += amt * u * v;
      } else {
        const amt = Math.min((cap - sed) * erodeK, -dh) * landW(y0 * res + x0);
        for (let i = 0; i < bx.length; i++) {
          const kx = x0 + bx[i], ky = y0 + by[i];
          if (kx < 0 || ky < 0 || kx >= res || ky >= res) continue;
          const w = amt * bw[i], k = ky * res + kx, take = Math.max(0, Math.min(h[k], w)); // never dig below sea level
          h[k] -= take; sed += take;
        }
      }
      speed = Math.sqrt(Math.max(0, speed * speed + dh * gravity));
      water *= 1 - evap;
      px = nx; py = ny;
    }
  }
}

/** organic pad weight: 1 inside `pad`, smooth fall-off over a blend distance that varies with bearing (no perfect discs) */
/** a 40–80 m domain warp (±38 m) for POI grounds + meadows: their edges become irregular lobes and tongues, never a
 * disc or an ellipse read from the air (no pale-lime discs) */
export function groundWarp(n: Simplex2, x: number, z: number): [number, number] {
  return [x + 38 * n.fbm(x / 150 + 13.1, z / 150 + 2.7, 3), z + 38 * n.fbm(x / 150 - 5.3, z / 150 + 9.9, 3)];
}
export function padWeight(n: Simplex2, px: number, pz: number, pad: number, blend: number, x: number, z: number): number {
  const d = dmath.hypot(x - px, z - pz);
  if (d <= pad) return 1;
  if (d >= pad + blend) return 0;
  const a = dmath.atan2(z - pz, x - px);
  const wob = 0.5 + 0.5 * n.fbm(dmath.cos(a) * 1.9 + px * 0.011, dmath.sin(a) * 1.9 + pz * 0.013, 2);
  const be = blend * (0.45 + 0.55 * wob);
  const t = clamp((d - pad) / be, 0, 1);
  return 1 - t * t * t * (t * (t * 6 - 15) + 10);
}

/** smoothed, meandering path centrelines (exported so rocks/veg/props can follow the same lines) */
export function pathLines(): Array<{ id: string; pts: Pt[]; w: number }> {
  const n = new Simplex2(WORLD.SEED + 404);
  const all: Array<{ id: string; pts: Pt[]; w?: number; mw?: number }> = PATHS.concat(ROT_TRAILS.map((t) => ({ id: t.id, pts: t.pts, w: 1.8, mw: 0 })));
  return all.map((P) => {
    const sm = catmull(P.pts, 6, false);
    // meander: offset each point sideways by low-frequency noise (not at the ends — they must hit the POIs)
    const L = polyLen(sm); let acc = 0;
    const out: Pt[] = sm.map((p, i) => {
      if (i > 0) acc += dmath.hypot(p[0] - sm[i - 1][0], p[1] - sm[i - 1][1]);
      const a = sm[Math.max(0, i - 1)], b = sm[Math.min(sm.length - 1, i + 1)];
      const dx = b[0] - a[0], dz = b[1] - a[1], l = dmath.hypot(dx, dz) || 1;
      const end = smoothstep(0, 40, acc) * smoothstep(0, 40, L - acc);
      const m = (P.mw ?? (P.w ? 5 : 9)) * n.fbm(acc / 90 + P.id.length * 3.7, 0.5, 2) * end;
      return [p[0] - (dz / l) * m, p[1] + (dx / l) * m];
    });
    return { id: P.id, pts: out, w: P.w ?? 3.4 };
  });
}

/** 0..1 plantation field membership. The field follows the POI's PLANTED ROWS exactly: poi-coast plants its
 * banana rows inside r ≈ 150 (+ up to 12 m per plant) round the pad (shared/pois/the-plantation.ts bananaSpots) — a
 * rounded square would leave bare brown soil corners outside the rows. A ragged edge (±7 m lobes, ±3 m wobble); the far bake
 * paints the rows 1:1 as leafy stripes on brown furrows with ragged row ends, harvest lanes and a perimeter track. */
export function plantationW(n: Simplex2, x: number, z: number): number {
  const F = PLANTATION_FIELD, dx = x - F.x, dz = z - F.z, d = dmath.hypot(dx, dz);
  if (d > 185) return 0;
  const a = dmath.atan2(dz, dx);
  const edge = 155 + 7 * n.fbm(dmath.cos(a) * 2.1 + 9, dmath.sin(a) * 2.1, 2) + 3 * n.fbm(x / 22, z / 22, 2);
  return 1 - smoothstep(edge - 4, edge + 4, d);
}

const NOISE_BAD = new Simplex2(WORLD.SEED + 19), NOISE_FIELD = new Simplex2(WORLD.SEED + 7);
const NOISE_PG0 = new Simplex2(WORLD.SEED);
/** 0..1 POI-ground membership at (x, z) — the SAME irregular, domain-warped outline the biome pass and the splat use for
 * every POI pad ground (lobes and tongues, never a disc). For vegetation: keep trees off where this is > 0.5 (and hard
 * off inside 0.8 × pad, where the buildings stand) instead of a `p.pad + margin` circle — the circle is what reads as a
 * hard disc cut out of the jungle from the air. Harbor / plantation / lobby are excluded (their own grounds). */
export function poiGroundAt(x: number, z: number): number {
  let best = 0;
  let warped: [number, number] | null = null;
  for (const p of POIS) {
    if (p.padY === null || p.id === "peel-harbor" || p.id === "the-plantation" || p.id === "lobby-islet") continue;
    const dd = dmath.hypot(x - p.x, z - p.z);
    if (dd > p.pad + p.blend + 45) continue;
    if (dd < p.pad * 0.8) return 1;
    warped ??= groundWarp(NOISE_BAD, x, z);
    best = Math.max(best, smoothstep(0.35, 0.65, padWeight(NOISE_FIELD, p.x, p.z, p.pad, p.blend, warped[0], warped[1]) + 0.3 * NOISE_PG0.fbm(x / 40 + 3, z / 40, 2)));
  }
  return best;
}
/** badlands membership 0..1 at (x, z) — the same field the biome pass used (client material reads this too) */
export const badlandsAt = (x: number, z: number) => badlandsW(NOISE_BAD, x, z);
const NOISE_REEF_A = new Simplex2(WORLD.SEED + 7), NOISE_REEF_B = new Simplex2(WORLD.SEED);
/** 0..1 coral-head patches on the reef shelf (raised a little in the heightfield, painted dark reef by the material) */
export const reefPatch = (x: number, z: number) => smoothstep(0.16, 0.5, NOISE_REEF_A.fbm(x / 34, z / 34, 3) + 0.25 * NOISE_REEF_B.fbm(x / 150, z / 150, 2));
/** plantation field membership 0..1 at (x, z) */
export const plantationAt = (x: number, z: number) => plantationW(NOISE_FIELD, x, z);

// ================================================================ generator
export function generateTerrain(opts: { erosion?: boolean } = {}): TerrainData {
  const erosion = opts.erosion ?? true;
  const n = new Simplex2(WORLD.SEED), n2 = new Simplex2(WORLD.SEED + 7), n3 = new Simplex2(WORLD.SEED + 19);
  const res = Math.round((2 * WORLD.HALF) / WORLD.CELL) + 1, N = res * res;
  const heights = new Float32Array(N), biome = new Uint8Array(N), path8 = new Uint8Array(N), coast8 = new Int8Array(N);
  const sdf = new Float32Array(N), cliffW = new Float32Array(N), cliffH = new Float32Array(N), landW = new Float32Array(N);
  const X = (j: number) => -WORLD.HALF + j * WORLD.CELL, Z = (i: number) => -WORLD.HALF + i * WORLD.CELL;
  const V = VOLCANO;

  // ---- pass 1: land mask (coast polygon + lobby islet − lagoon − mouth + lagoon islets) → signed distance (m)
  const coastPoly = catmull(COAST, 6, true), lagoonPoly = catmull(LAGOON, 6, true);
  const mask = new Uint8Array(N);
  fillPoly(mask, res, coastPoly, 1);
  fillPoly(mask, res, lagoonPoly, 0);
  for (let i = 0; i < res; i++) for (let j = 0; j < res; j++) {
    const x = X(j), z = Z(i), k = i * res + j;
    if (ellipseD(LOBBY, x, z) > 0 || dmath.hypot(x - LOBBY.x, z - LOBBY.z) < 84) mask[k] = 1; // the pad (r 60) never reaches the shore
    if (polyDist(LAGOON_MOUTH, x, z).d < LAGOON_MOUTH_W + 5 * n3.fbm(x / 30, z / 30, 2)) mask[k] = 0;
    if (inPoly(lagoonPoly, x, z)) {
      // mangrove islets + channels; open water kept for STILT TOWN (market + its camera corridor east of it), the
      // mouth channel north to the sea and the river mouth in the west
      // whole islets from the explicit list (lagoonIslets() already keeps them clear of the keep-outs + shore)
      if (isletD(n3, x, z) > 0) mask[k] = 1;
    }
  }
  // lagoon water cells (for the mangrove shore band)
  const lagWater = new Uint8Array(N);
  for (let i = 0; i < res; i++) for (let j = 0; j < res; j++) {
    const k = i * res + j, x = X(j), z = Z(i);
    if (!mask[k] && x > 180 && x < 760 && z > -520 && z < -200 && (inPoly(lagoonPoly, x, z) || polyDist(LAGOON_MOUTH, x, z).d < LAGOON_MOUTH_W + 8)) lagWater[k] = 1;
  }
  const lagDist = edt(lagWater, res, res);
  {
    const inv = new Uint8Array(N); for (let k = 0; k < N; k++) inv[k] = mask[k] ? 0 : 1;
    const dIn = edt(inv, res, res), dOut = edt(mask, res, res);
    for (let k = 0; k < N; k++) sdf[k] = (mask[k] ? dIn[k] - 0.5 : -(dOut[k] - 0.5)) * WORLD.CELL;
  }

  // ---- pass 2: sea floor + beach + rolling hills + sea cliffs
  for (let i = 0; i < res; i++) {
    const z = Z(i);
    for (let j = 0; j < res; j++) {
      const x = X(j), k = i * res + j;
      // coast crenellation (headlands / coves); calm near the POI shores that other areas built against
      const calm = Math.max(
        1 - smoothstep(60, 140, dmath.hypot(x - 650, z - 380)), 1 - smoothstep(40, 110, dmath.hypot(x - WRECK_BEACH.x, z - WRECK_BEACH.z)),
        1 - smoothstep(50, 130, dmath.hypot(x - 180, z - 540)), 1 - smoothstep(30, 80, dmath.hypot(x - 330, z - 330)) * 0,
        1 - smoothstep(80, 150, dmath.hypot(x - LOBBY.x, z - LOBBY.z)));
      // (the lagoon bed profile only inside the lagoon + the mouth channel's banks — a wide band round the mouth line
      // would show as a squared shallow turquoise lobe in the open sea)
      const inLag = inPoly(lagoonPoly, x, z) || (x > 480 && x < 660 && z < -440 && z > -680 && polyDist(LAGOON_MOUTH, x, z).d < 34 && sdf[k] > -30);
      const warp = (1 - 0.85 * calm) * (inLag ? 0.2 : 1) * (10 * n.fbm(x / 260 + 3.1, z / 260, 3) + 7 * n2.fbm(x / 70, z / 70, 3) + 2.6 * n3.fbm(x / 20, z / 20, 2));
      const d = sdf[k] + warp;
      sdf[k] = d;

      // cliff zones (0..1)
      let cw = 0, ch = 0;
      for (const c of CLIFF_ZONES) { const w = 1 - smoothstep(c.w * 0.55, c.w, dmath.hypot(x - c.x, z - c.z)); if (w > cw) { cw = w; ch = c.h; } }
      cw *= smoothstep(-0.35, 0.1, n2.fbm(x / 200 + 9, z / 200, 3) + 0.45);
      cliffW[k] = cw; cliffH[k] = ch;

      let h: number;
      if (d < 0) {
        const od = -d;
        if (inLag) {
          // lagoon: shallow tea-turquoise water, sandy/muddy bed
          // (the bed drops to ~−2 m within ~5 m of every shore — veg's mangroves (−1.6 … 0.9 m) stay a FRINGE on
          // the islet rims instead of closing the channels into one canopy mat)
          h = -0.45 - 1.45 * smoothstep(0.5, 5.5, od) - 0.5 * smoothstep(8, 40, od) + 0.25 * n3.fbm(x / 11, z / 11, 2) * smoothstep(3, 8, od) - 0.4 * smoothstep(0.1, 0.5, n.fbm(x / 60, z / 60, 2)) * smoothstep(4, 12, od);
        } else {
          // narrow turquoise shelf (40–120 m, sand with dark coral patches) → a gradual, wobbly drop-off → deep blue
          const shelf = clamp(78 + 46 * n.fbm(x / 470 + 7, z / 470, 3), 40, 120);
          const e = od + 16 * n2.fbm(x / 95 + 2, z / 95, 3);
          h = -0.3 - 1.5 * smoothstep(0, 22, od) - 3.4 * smoothstep(12, shelf, e) - 15 * smoothstep(shelf * 0.8, shelf + 130, e)
            - 30 * smoothstep(shelf + 70, shelf + 430, e) - 20 * smoothstep(shelf + 300, 1000, e);
          const onShelf = 1 - smoothstep(shelf - 10, shelf + 70, e);
          const heads = reefPatch(x, z);
          h += (1.7 * heads + 0.3 * n3.fbm(x / 7, z / 7, 2)) * onShelf * smoothstep(12, 34, od);             // dark coral patches
          h -= 1.0 * smoothstep(0.2, 0.6, n.fbm(x / 90 + 5, z / 90, 2)) * onShelf * smoothstep(24, 60, od);  // sand channels
          // cliffs: deep water right at the foot (no beach, no reef flat)
          h = lerp(h, Math.min(h, -1.5 - 5.5 * smoothstep(0, 26, od) - 8 * smoothstep(26, 120, od)), cw * 0.85);
        }
      } else {
        // beach: wide, low, a berm at the back; the wet band lives in the first ~8 m
        const beachW = clamp(44 + 18 * n2.fbm(x / 330 + 1, z / 330, 2) + 5 * n3.fbm(x / 40, z / 40, 2), 26, 70);
        const beach = 0.12 + 2.3 * smoothstep(0, beachW, d) + 0.18 * n3.fbm(x / 6, z / 6, 2) * smoothstep(3, 14, d) * (1 - smoothstep(beachW - 8, beachW + 12, d));
        const inland = smoothstep(beachW * 0.55, beachW + 190, d);
        const cragMask = smoothstep(0.1, 0.55, n.fbm(x / 300 + 11, z / 300, 2));
        const hills = 9 + 24 * (0.5 + 0.5 * n.fbm(x / 430 + 2, z / 430, 4)) + 11 * n.fbm(x / 160 + 7, z / 160, 3) + 3.2 * n2.fbm(x / 55, z / 55, 3)
          + 22 * n.ridged(x / 240 + 3, z / 240, 4) * smoothstep(0.35, 0.85, inland) * cragMask;
        let base = beach + inland * hills;
        const ld = lagDist[k] * WORLD.CELL;
        if (ld < 90) {
          // lagoon shore + islets: low mangrove ground rising gently into the jungle; the islets inside the lagoon stand
          // 0.5–1.5 m out of the water (a sand rim, a mangrove-tufted crown)
          const lw = 1 - smoothstep(35, 90, ld);
          const islet = inPoly(lagoonPoly, x, z);
          // (a ~2.5 m sand / mud rim, then the forested crown — a 5 m rim would leave a 20 m islet 3 m of trees)
          base = islet ? 0.4 + 0.6 * smoothstep(0, 2.5, ld) + 1.4 * smoothstep(2.5, 11, ld) + 0.15 * n3.fbm(x / 7, z / 7, 2)
            : lerp(base, 0.3 + 0.9 * smoothstep(0, 16, ld) + 2.2 * smoothstep(16, 70, ld) + 0.3 * n3.fbm(x / 9, z / 9, 2), lw);
        }
        // sea cliff: foot 0..3 m, a steep wall up to ch (+ noise), plateau beyond (hills ride on top)
        // a near-VERTICAL wall (5–14 m run for a 20–45 m cliff)
        // — the carved rock tiers stand flush in it and cover it; a 16–26 m run leaves a ~60° dirt slope with the
        // tiers' upper halves sticking out of it like boxes
        const run = Math.max(4, 6.5 + 4.5 * n3.fbm(x / 60, z / 60, 2));
        const wall = smoothstep(3, 3 + run, d + 5 * n3.fbm(x / 22, z / 22, 3));
        const plateau = ch * (0.9 + 0.2 * n2.fbm(x / 120 + 7, z / 120, 3));
        const cliffProfile = 0.8 + 1.4 * smoothstep(0, 3, d) + wall * plateau + smoothstep(50, 240, d) * hills * 0.6;
        h = lerp(base, Math.max(cliffProfile, base * 0.4 + cliffProfile * 0.6), cw);
        // THE WRECK beach profile
        const wb = 1 - smoothstep(WRECK_BEACH.r * 0.6, WRECK_BEACH.r, dmath.hypot(x - WRECK_BEACH.x, (z - WRECK_BEACH.z) * 0.8));
        if (wb > 0) h = lerp(h, Math.min(h, 0.085 * d + (d > 55 ? (d - 55) * 0.35 : 0)), wb);
      }
      if (d < 0) {
        const wb = 1 - smoothstep(WRECK_BEACH.r * 0.6, WRECK_BEACH.r, dmath.hypot(x - WRECK_BEACH.x, (z - WRECK_BEACH.z) * 0.8));
        if (wb > 0) h = lerp(h, Math.max(-9, -0.07 * -d), wb);
      }
      // sink the grid rim to the abyss plane (−72 m) so the heightfield edge never shows
      // (not under the lobby islet, which sits near the south rim: its pad must hold out to r = 60)
      h = lerp(h, -72, smoothstep(1060, 1195, Math.max(Math.abs(x), Math.abs(z))) * smoothstep(100, 160, dmath.hypot(x - LOBBY.x, z - LOBBY.z)));
      heights[k] = h;
      landW[k] = smoothstep(-4, 16, d);
    }
  }

  // ---- pass 3: volcano — concave cinder cone (gullies + ribs), raised crater lip, jungle skirt; ridges; mesas; murk
  const ridgeP = RIDGES.map((r) => ({ ...r, xz: r.pts.map((p) => [p[0], p[1]] as Pt), len: polyLen(r.pts.map((p) => [p[0], p[1]] as Pt)) }));
  for (let i = 0; i < res; i++) {
    const z = Z(i);
    for (let j = 0; j < res; j++) {
      const x = X(j), k = i * res + j, d = sdf[k];
      if (d < -30) continue;
      const shore = smoothstep(0, 40, d); // features never cross the beach
      let h = heights[k];
      // volcano
      const vr = dmath.hypot(x - V.x, z - V.z);
      if (vr < V.base + 60) {
        const ang = dmath.atan2(z - V.z, x - V.x);
        const warp = 0.55 * n.fbm(dmath.cos(ang) * 2.5 + 4, dmath.sin(ang) * 2.5 + vr / 260, 3);
        let hv: number;
        // the lip height varies with bearing at LOW frequency (craterRim) and fades into the flank; a broad
        // rounded lip (~26 m wide Gaussian), since a narrow 22 m ring crest aliases into sawteeth on the 8 m LODs
        const rimA = craterRim(ang), dRim = rimA - V.rim;
        if (vr < V.cone) {
          // crest = a SMOOTH min of the rising inner bowl and the falling outer flank (both extended across the lip):
          // a rounded crest instead of a hard V-kink, which the 2 m checkerboard triangulation zigzagged into a comb
          const t = (vr - V.crater) / (V.cone - V.crater);
          const inner = lerp(V.floor, rimA - 5, dmath.pow(vr / V.crater, 2.2)) + 0.8 * n3.fbm(x / 9, z / 9, 2) * (1 - smoothstep(0.85, 1.0, vr / V.crater));
          let outer = V.coneH + (V.rim + dRim * dmath.pow(Math.max(0, 1 - t), 0.6) - V.coneH) * dmath.pow(1 - t, 1.25);
          if (t > 0) outer -= coneGully(x, z) * smoothstep(0.03, 0.25, t) + coneRill(x, z) * smoothstep(0.0, 0.1, t);
          // craggy rock relief on the flanks: sharp ridged crests + small broken ledges at 12–30 m (a faceted rock
          // cone; smooth scree reads as clay at every distance)
          // (anisotropic: ~14 m across × ~40 m down the fall line → sharp secondary ribs and broken rock buttresses)
          { const ang2 = dmath.atan2(z - V.z, x - V.x), arcM = ang2 * Math.max(vr, 40);
            // (2 octaves — a third (3.5 m × 10 m) reads as blobby lumps at 300–500 m; 1.2 m and 110 m down the fall
            // line — shorter lobes read as stacked "melted wax" at the cone foot; the rills carry the small-scale relief)
            outer += (1.2 * n2.ridged(arcM / 16 + 3.3, vr / 110 - 1.7, 2) - 0.55) * smoothstep(0.06, 0.3, t) * (1 - smoothstep(0.82, 1.0, t)); }
          hv = -smax(-inner, -outer, 16);
        } else {
          const t = smoothstep(V.cone, V.base, vr);
          hv = V.coneH - (V.coneH - V.baseH) * t + 8 * n.fbm(x / 90 + 1, z / 90, 3) * smoothstep(0.05, 0.5, t);
          hv += 4.0 * smoothstep(0.02, 0.3, t) * (1 - smoothstep(0.3, 0.75, t)) * n2.ridged(x / 70 + warp, z / 70, 3); // lava-flow lobes
          hv -= coneGully(x, z) + coneRill(x, z);   // the gullies run out over the skirt (no pit where they end)
        }
        hv += 5 * dmath.exp(-(dmath.pow((vr - V.crater - 2) / 15, 2))) * (1 - 0.7 * dmath.exp(-(dmath.pow(angD(ang, CRATER_BREACH) / 0.2, 2))));
        // buttress spurs + shoulder humps: a jagged silhouette (the rock meshes along their crests do the rest)
        hv += coneSpur(x, z).h;
        const vw = 1 - smoothstep(V.base - 20, V.base + 60, vr);
        h = smax(h, lerp(h, hv, vw * Math.max(shore, vr < V.cone ? 1 : 0)), 18);
      }
      // ridges
      for (const R of ridgeP) {
        const q = polyDist(R.xz, x, z);
        if (q.d > R.w * 1.1) continue;
        let acc = 0, hh = R.pts[R.pts.length - 1][2];
        for (let s = 0; s + 1 < R.pts.length; s++) {
          const L = dmath.hypot(R.pts[s + 1][0] - R.pts[s][0], R.pts[s + 1][1] - R.pts[s][1]);
          if (q.t <= acc + L) { hh = lerp(R.pts[s][2], R.pts[s + 1][2], (q.t - acc) / L); break; }
          acc += L;
        }
        const dd = q.d + 22 * n.fbm(x / 140 + R.id.length, z / 140, 3);
        const prof = R.sharp ? dmath.pow(1 - smoothstep(0, 1, clamp((dd - 5) / R.w, 0, 1)) * 0.25 - clamp((dd - 5) / R.w, 0, 1) * 0.75, R.sharp) : dmath.pow(1 - smoothstep(6, R.w, dd), 1.25);
        const crest = hh * (0.9 + 0.2 * n.ridged(x / 200 + 8, z / 200, 4));
        h = smax(h, lerp(h, crest, prof * shore), 10);
      }
      // mesas: flat grassy tops, steep rock sides
      for (const [mx, mz, mr, top] of MESAS) {
        const md = dmath.hypot(x - mx, z - mz);
        if (md > mr + 40) continue;
        const a = dmath.atan2(z - mz, x - mx);
        // irregular lobed outline (no cake tins): low-frequency lobes + noise
        const edge = mr * (1 + 0.3 * n.fbm(dmath.cos(a) * 1.3 + mx * 0.01, dmath.sin(a) * 1.3 + mz * 0.01, 3) + 0.14 * dmath.sin(a * 2 + mx) + 0.08 * dmath.sin(a * 3 + mz));
        const m = 1 - smoothstep(edge - 3, edge + 12, md);
        const hm = top + 1.5 * n3.fbm(x / 25, z / 25, 2);
        h = Math.max(h, lerp(h, hm, m * shore));
      }
      // badlands: broken, lumpy lava crust (pressure ridges + blocky rubble) instead of smooth dunes
      if (d > 8) {
        const bw = badlandsW(n3, x, z);
        // SOFT pressure ridges (a smoothed |noise| — no crest crease
        // for the 2 m grid to zipper into straight lines) + blocky lumps
        if (bw > 0.05) {
          // FLOW SHEETS (so the field is no empty plain) — lobes elongated down the flow (radial from the cone):
          // 20–40 m wide × 60–120 m long, ~1.3 m thick with rounded fronts, smaller toes on top of them, soft pressure
          // ridges and grit; KIPUKAS (older vegetated islands the flows went round) stand ~2 m proud of the field
          const vr2 = dmath.hypot(x - V.x, z - V.z), a2 = dmath.atan2(z - V.z, x - V.x), across = a2 * 300;
          const lobe = smoothstep(-0.05, 0.25, n2.fbm(across / 34 + 7.1, vr2 / 95 - 2.3, 3));
          const toe = smoothstep(0.0, 0.3, n3.fbm(across / 15 - 3.3, vr2 / 40 + 5.9, 2));
          const ra = n2.noise(x / 13 + 4, z / 13);
          const soft = 1 - Math.sqrt(ra * ra + 0.05);
          const relief = 1.3 * lobe + 0.55 * toe + 0.5 * soft - 0.95 + 0.3 * n3.fbm(x / 4.5, z / 4.5, 2);
          const kip = kipukaAt(x, z);
          h += smoothstep(0.05, 0.5, bw) * shore * (relief * (1 - kip) + kip * (1.9 + 0.9 * n3.fbm(x / 20, z / 20, 2)));
        }
      }
      // THE MURK: low swamp with pools, merging into the lagoon
      const md = dmath.hypot(x - MURK.x, (z - MURK.z) * 1.1);
      // (not on the lagoon's islets — they keep their forested crowns next to the swamp)
      if (md < MURK.r * 1.4 && d > -10 && !(d > 0 && inPoly(lagoonPoly, x, z))) {
        const w = 1 - smoothstep(MURK.r * 0.7, MURK.r * 1.4, md);
        const pools = n2.fbm(x / 28 + 17, z / 28, 3);
        const sw = 0.45 + 0.35 * n3.fbm(x / 12, z / 12, 2) - 1.2 * smoothstep(0.08, 0.32, pools);
        h = lerp(h, sw, w);
      }
      heights[k] = h;
    }
  }

  // ---- pass 4: erosion (land only, keeps the coast; skips the cone), then a tiny relax to kill droplet spikes
  if (erosion) {
    const pre = Float32Array.from(heights);
    erode(heights, res, WORLD.SEED + 101, 170_000, (k) => {
      const j = k % res, i = (k - j) / res, vr = dmath.hypot(X(j) - V.x, Z(i) - V.z);
      return landW[k] * smoothstep(3, 7, heights[k]) * smoothstep(V.cone + 10, V.base, vr);
    });
    const relaxed = blur(heights, res, 1);
    for (let k = 0; k < N; k++) heights[k] = pre[k] < 0.2 ? pre[k] : lerp(heights[k], relaxed[k], 0.3 * landW[k]); // water keeps its bed
    // despike: droplets can dig single-cell pits at the waterline — clamp every sample to its neighbours' range ± 4 m
    for (let i = 1; i < res - 1; i++) for (let j = 1; j < res - 1; j++) {
      const k = i * res + j, a = heights[k - 1], b = heights[k + 1], c = heights[k - res], e = heights[k + res];
      const lo = Math.min(a, b, c, e) - 4, hi = Math.max(a, b, c, e) + 4;
      if (heights[k] < lo) heights[k] = lo; else if (heights[k] > hi) heights[k] = hi;
    }
  }

  // ---- pass 5: sea-cliff + mesa terracing (layered strata) — steep coastal rock and mesa walls, never the cone
  {
    const src = Float32Array.from(heights);
    const step = STRATA.band;
    for (let i = 1; i < res - 1; i++) for (let j = 1; j < res - 1; j++) {
      const k = i * res + j;
      const x = X(j), z = Z(i);
      if (dmath.hypot(x - V.x, z - V.z) < V.cone + 30) continue;
      const sx = (src[k + 1] - src[k - 1]) / (2 * WORLD.CELL), sz = (src[k + res] - src[k - res]) / (2 * WORLD.CELL);
      const slope = dmath.hypot(sx, sz);
      const coastal = 1 - smoothstep(60, 140, sdf[k]);
      let mesa = 0; for (const [mx, mz, mr] of MESAS) mesa = Math.max(mesa, 1 - smoothstep(mr + 10, mr + 30, dmath.hypot(x - mx, z - mz)));
      // (barely on the sea cliffs — the carved tiers carry the strata; terraces there turn the wall into a
      // staircase of dirt treads with boxes on the risers)
      const c = smoothstep(0.8, 1.6, slope) * smoothstep(3, 10, src[k]) * Math.max(0.2 * cliffW[k], 0.3 * coastal * (1 - cliffW[k]), mesa);
      if (c <= 0.001) continue;
      // (soft risers: a whole 5 m step never lands inside one 2 m cell, so terraces read as ledges, not as knife edges)
      const h = src[k], f = (h - STRATA.off) / step, fl = Math.floor(f), fr = f - fl;
      const terr = (fl + smoothstep(0.15, 0.85, fr)) * step + STRATA.off;
      heights[k] = lerp(h, terr, c * 0.7);
    }
  }

  // ---- pass 6: POI pads (land only). All pads combine at once: the strongest pad dominates the target height
  // (so one pad's blend ring never tilts another pad's flat centre), the max weight drives the blend.
  const padList = POIS.filter((p) => p.padY !== null);
  for (let i = 0; i < res; i++) {
    const z = Z(i);
    for (let j = 0; j < res; j++) {
      const x = X(j), k = i * res + j;
      let W = 0, num = 0, den = 0;
      for (const p of padList) {
        if (dmath.hypot(x - p.x, z - p.z) > p.pad + p.blend) continue;
        const w = padWeight(n2, p.x, p.z, p.pad, p.blend, x, z);
        const w6 = w * w * w * w * w * w;
        num += w6 * p.padY!; den += w6; W = Math.max(W, w);
      }
      if (den <= 0) continue;
      W *= smoothstep(-3.0, -0.8, heights[k]);
      heights[k] = lerp(heights[k], num / den, W);
    }
  }
  // the CNVS lab stands on a KNOLL, not a raised cake-tin mesa with bald vertical walls — outside its flat pad the ground falls away at ~22° (±, lobed) for ~90 m instead of dropping 30 m in 20 m to
  // the river valley and the lagoon lowland; the river pass below still cuts its own banks
  {
    const L = poiById("cnvs-lab"), R = L.pad + 110;
    for (let i = 0; i < res; i++) {
      const z = Z(i); if (Math.abs(z - L.z) > R) continue;
      for (let j = 0; j < res; j++) {
        const x = X(j), k = i * res + j, dd = dmath.hypot(x - L.x, z - L.z);
        if (dd <= L.pad || dd > R || sdf[k] < 2 || inPoly(lagoonPoly, x, z)) continue;
        const a = dmath.atan2(z - L.z, x - L.x);
        const K = 0.4 + 0.12 * n3.fbm(dmath.cos(a) * 1.6 + 7, dmath.sin(a) * 1.6, 2);
        const tgt = L.padY! - K * (dd - L.pad) - 2.5 * n2.fbm(x / 35 + 2, z / 35, 2) * smoothstep(0, 25, dd - L.pad);
        heights[k] = Math.max(heights[k], lerp(heights[k], tgt, smoothstep(2, 24, sdf[k])));
      }
    }
  }
  // harbor: never above the apron slab under the apron; deep berth + inlet water beside it
  {
    const apronY = (POIS.find((p) => p.id === "peel-harbor")!.padY ?? 3.2);
    for (let i = 0; i < res; i++) {
      const z = Z(i);
      if (z < 150 || z > 720) continue;
      for (let j = 0; j < res; j++) {
        const x = X(j), k = i * res + j;
        if (x < 400 || x > 1000) continue;
        if (inPoly(HARBOR_APRON, x, z) && heights[k] > apronY) heights[k] = apronY;
        for (const b of HARBOR_DEEP) {
          const e = Math.min(x - b.x0, b.x1 - x, z - b.z0, b.z1 - z);
          if (e > -60 && !inPoly(HARBOR_APRON, x, z) && heights[k] < 0.5) heights[k] = Math.min(heights[k], lerp(heights[k], b.h + 1.2 * n3.fbm(x / 20, z / 20, 2), smoothstep(-60, 30, e) * smoothstep(0.5, -1.5, heights[k])));
        }
      }
    }
  }

  // ---- pass 6b: pad rims are ramps, not walls. The pad blend (smootherstep over 45–100 % of
  // `blend`) peaks at ~1.9× its mean grade: a 27 m climb out of the plantation's pad would hit 45–52° — a grass wall you
  // slide off. Within 1.5 × blend of a pad the ground may rise / fall at most PAD_RIM_K per metre from
  // the pad edge (a cone round the pad); below-pad fills only well inland (never the sea cliffs, the lagoon, the river).
  // LOOKOUT POINT (a headland pad on sea cliffs) keeps its cliffs.
  for (const p of padList) {
    if (p.id === "lookout-point") continue;
    const R = p.pad + p.blend * 1.5;
    for (let i = Math.max(0, Math.floor((p.z - R + WORLD.HALF) / WORLD.CELL)); i <= Math.min(res - 1, Math.ceil((p.z + R + WORLD.HALF) / WORLD.CELL)); i++) {
      const z = Z(i);
      for (let j = Math.max(0, Math.floor((p.x - R + WORLD.HALF) / WORLD.CELL)); j <= Math.min(res - 1, Math.ceil((p.x + R + WORLD.HALF) / WORLD.CELL)); j++) {
        const x = X(j), k = i * res + j, dd = dmath.hypot(x - p.x, z - p.z) - p.pad;
        if (dd <= 0 || dd > p.blend * 1.5 || heights[k] < 0.5) continue;
        // past the blend ring the cone opens quadratically, so its outer edge never leaves a step in a taller hill
        const open = dmath.pow(Math.max(0, dd - p.blend), 2) * 0.05, hi = p.padY! + PAD_RIM_K * dd + open, lo = p.padY! - PAD_RIM_K * dd - open;
        if (heights[k] > hi) heights[k] = hi;
        else if (heights[k] < lo && sdf[k] > 40 && !inPoly(lagoonPoly, x, z)) heights[k] = lo;
      }
    }
  }

  (globalThis as { __tgProbe?: (s: string, h: Float32Array) => void }).__tgProbe?.("pass 7", heights);
  // ---- pass 7: waterfall gorge + pool + river bed
  {
    const gorge: Pt[] = [[FALLS.top.x, FALLS.top.z], [FALLS.lip.x, FALLS.lip.z], [FALLS.pool.x, FALLS.pool.z]];
    const gorgeLen = polyLen(gorge), lipT = dmath.hypot(FALLS.lip.x - FALLS.top.x, FALLS.lip.z - FALLS.top.z);
    const riverLen = polyLen(RIVER);
    for (let i = 0; i < res; i++) {
      const z = Z(i);
      if (z < -520 || z > -250) continue;
      for (let j = 0; j < res; j++) {
        const x = X(j), k = i * res + j;
        if (x < -300 || x > 340) continue;
        const pd = dmath.hypot(x - FALLS.pool.x, z - FALLS.pool.z);
        if (pd < FALLS.pool.r + 30) {
          const w = 1 - smoothstep(FALLS.pool.r, FALLS.pool.r + 30, pd);
          const bowl = FALLS.pool.floor + 0.6 * dmath.pow(smoothstep(0, FALLS.pool.r, pd), 2);
          heights[k] = lerp(heights[k], Math.min(heights[k], bowl), w);
        }
        const g = polyDist(gorge, x, z);
        if (g.d < 34) {
          let floor: number;
          if (g.t < lipT) floor = lerp(FALLS.top.h, FALLS.lip.h, g.t / lipT);
          else floor = lerp(FALLS.lip.h, FALLS.pool.floor + 1.0, dmath.pow(smoothstep(0, 1, (g.t - lipT) / (gorgeLen - lipT)), 0.55));
          const w = 9 + 3 * n3.fbm(x / 9, z / 9, 2);
          const wall = floor + dmath.pow(Math.max(0, (g.d - w) / 12), 2) * 34;
          const fade = 1 - smoothstep(24, 34, g.d);
          heights[k] = lerp(heights[k], Math.min(heights[k], wall), fade);
        }
        for (const [fx, fz, fh, fr] of FALLS_RIM) {
          const fd = dmath.hypot(x - fx, z - fz);
          if (fd < fr + 20) heights[k] = lerp(heights[k], Math.min(heights[k], fh), 1 - smoothstep(fr, fr + 20, fd));
        }
        const r = polyDist(RIVER, x, z);
        if (r.d < 60) {
          const u = r.t / riverLen;
          const bed = lerp(FALLS.pool.floor - 0.4, -1.4, dmath.pow(u, 0.8)) + 0.15 * n3.fbm(x / 7, z / 7, 2);
          const w = RIVER_W * (0.8 + 0.5 * n2.fbm(r.t / 60, 3, 2));
          const bank = bed + dmath.pow(Math.max(0, (r.d - w) / 8), 1.6) * 3.5 + dmath.pow(Math.max(0, (r.d - w - 10) / 25), 2) * 12;
          const fade = 1 - smoothstep(45, 60, r.d);
          heights[k] = lerp(heights[k], Math.min(heights[k], bank), fade);
        }
      }
    }
  }

  // COCO CAVES: the basin under the pool down to ~41 m and the north-bank dune cut to
  // ≤ 45.5 m, so the pool can reach the lava (feathered 4 m, only ever lowers)
  for (const [x0, z0, x1, z1, top] of [[-735, -335, -705, -305, 41], [-730, -345, -716, -325, 45.5]] as Array<[number, number, number, number, number]>) {
    for (let i = Math.floor((z0 - 4 + WORLD.HALF) / WORLD.CELL); i <= Math.ceil((z1 + 4 + WORLD.HALF) / WORLD.CELL); i++) {
      const z = Z(i);
      for (let j = Math.floor((x0 - 4 + WORLD.HALF) / WORLD.CELL); j <= Math.ceil((x1 + 4 + WORLD.HALF) / WORLD.CELL); j++) {
        const x = X(j), k = i * res + j, e = Math.max(x0 - x, x - x1, z0 - z, z - z1, 0);
        const w = 1 - smoothstep(0, 4, e); if (w <= 0) continue;
        heights[k] = Math.min(heights[k], lerp(heights[k], top, w));
      }
    }
  }
  (globalThis as { __tgProbe?: (s: string, h: Float32Array) => void }).__tgProbe?.("pass 8", heights);
  // ---- pass 8: dirt paths = the island's rotation network.
  // OUTSIDE the POIs every road / trail is a real graded bed: the centreline profile is smoothed over ±20 m and then
  // grade-limited (roads ≤ 11°, trails ≤ 14°) by a forward + backward clamp, cut / fill ≤ ROAD_CF m; the cross-section is
  // FLAT over the ribbon + a 1.5 m shoulder (no side-hill walking) and blends back to the hillside over a bank whose
  // width grows with the cut so the bank itself stays ≤ ~27°. INSIDE a POI radius (their ground, their bakes) and on
  // pads the gentle worn track remains (±0.6 m). Never through water, never fills the river.
  {
    const src = Float32Array.from(heights);
    const sample = (x: number, z: number) => {
      const fx = clamp((x + WORLD.HALF) / WORLD.CELL, 0, res - 1.001), fz = clamp((z + WORLD.HALF) / WORLD.CELL, 0, res - 1.001);
      const j = fx | 0, i = fz | 0, tx = fx - j, tz = fz - i, k = i * res + j;
      const a = heights[k] + (heights[k + 1] - heights[k]) * tx, b = heights[k + res] + (heights[k + res + 1] - heights[k + res]) * tx;
      return a + (b - a) * tz;
    };
    const padW = (x: number, z: number) => {
      let w = 0;
      // the flat pad only, fading over ≤ 16 m: a road through a pad's blend ring (outside the POI) is graded — a
      // 0.6 × blend fade would leave the plantation drop at 55°
      for (const p of POIS) { if (p.padY === null) continue; w = Math.max(w, 1 - smoothstep(p.pad, p.pad + Math.min(16, p.blend * 0.6), dmath.hypot(x - p.x, z - p.z))); }
      for (const [fx, fz, , fr] of FALLS_RIM) w = Math.max(w, 1 - smoothstep(fr, fr + 12, dmath.hypot(x - fx, z - fz))); // poi-jungle timber
      return w;
    };
    /** 1 = open world (full regrade), 0 = inside a POI's ground (the worn track) */
    // full regrade from 0.92 r (just past the slope audit's POI boundary; the POI's own ground inside 0.8 r is never
    // touched) — a ramp out to r + 12 leaves 40–55° road wedges where the graded bed meets the worn track at the POI edge
    const openW = (x: number, z: number) => { let w = 1; for (const p of POIS) w = Math.min(w, smoothstep(p.r * 0.8, p.r * 0.92, dmath.hypot(x - p.x, z - p.z))); return w; };
    const nearRiver = (x: number, z: number) => z > -470 && z < -280 && x > -200 && x < 340 && polyDist(RIVER, x, z).d < RIVER_W + 14;
    // SEQUENTIAL (roads first, then trails): each road profiles the ground as the earlier roads left it, and every
    // profile sample on an earlier road's bed is PINNED to it, so crossings meet at one height (two roads
    // graded independently leave 50–70° steps where they cross). A later bank never tilts an earlier bed.
    const pinned = new Uint8Array(N), isBed = new Uint8Array(N), claim = new Float32Array(N), acc = new Float32Array(N), accW = new Float32Array(N), touched: number[] = [];
    for (const P of pathLines()) {
      const L = polyLen(P.pts), step = 2, nS = Math.ceil(L / step) + 1;
      const prof = new Float32Array(nS), ow = new Float32Array(nS);
      const pin = new Uint8Array(nS);
      for (let s = 0; s < nS; s++) { const p = polyAt(P.pts, Math.min(L, s * step)); prof[s] = sample(p[0], p[1]); ow[s] = openW(p[0], p[1]);
        pin[s] = pinned[clamp(Math.round((p[1] + WORLD.HALF) / WORLD.CELL), 0, res - 1) * res + clamp(Math.round((p[0] + WORLD.HALF) / WORLD.CELL), 0, res - 1)]; }
      // the worn-track profile (inside POIs)
      const sm = Float32Array.from(prof);
      for (let pass = 0; pass < 2; pass++) { const t = Float32Array.from(sm); for (let s = 0; s < nS; s++) { let a = 0, c = 0; for (let o = -3; o <= 3; o++) { const q = s + o; if (q >= 0 && q < nS) { a += t[q]; c++; } } sm[s] = a / c; } }
      for (let s = 0; s < nS; s++) sm[s] = Math.max(sm[s], prof[s] - 0.6);
      // the graded bed (outside POIs): wide smoothing, then the grade limiter, then the cut / fill clamp (twice: the clamp
      // can re-open a grade, the second limiter pass closes it again where the clamp allows)
      const G = dmath.tan(((P.w > 2 ? 11 : 14) * Math.PI) / 180) * step;
      // anchors: an earlier road's bed (pinned) and the POI's own worn track deep inside it (ow ≈ 0) are FIXED; no
      // fill near the river or in water (a ford: the bed descends to the bank instead of stopping at a 7 m wall, e.g. the
      // market-canopy-lab river crossing). Alternating [cut / fill window → grade limiter], the limiter last, so a conflict
      // ends as a deeper cut, never a step.
      const fixed = new Uint8Array(nS), fixY = new Float32Array(nS), noFill = new Uint8Array(nS);
      for (let s = 0; s < nS; s++) {
        const p = polyAt(P.pts, Math.min(L, s * step));
        // cells this pass never (or barely) moves: the road meets them at their height and ramps away at the design grade
        if (pin[s] || plantationAt(p[0], p[1]) > 0.2 || padW(p[0], p[1]) > 0.5) { fixed[s] = 1; fixY[s] = prof[s]; }
        else if (ow[s] < 0.02) { fixed[s] = 1; fixY[s] = sm[s]; }
        if (nearRiver(p[0], p[1]) || prof[s] < 0.6) noFill[s] = 1;
      }
      const gb = Float32Array.from(prof);
      for (let pass = 0; pass < 3; pass++) { const t = Float32Array.from(gb); for (let s = 0; s < nS; s++) { let a = 0, c = 0; for (let o = -10; o <= 10; o++) { const q = s + o; if (q >= 0 && q < nS) { a += t[q]; c++; } } gb[s] = a / c; } }
      // a closed loop (plantation-ring) meets itself: both ends share one height (no 2 m step where it closes)
      const p0 = P.pts[0], pN = P.pts[P.pts.length - 1];
      if (dmath.hypot(p0[0] - pN[0], p0[1] - pN[1]) < 3 && !fixed[0] && !fixed[nS - 1]) { fixed[0] = fixed[nS - 1] = 1; fixY[0] = fixY[nS - 1] = (gb[0] + gb[nS - 1]) / 2; }
      // trails (w ≤ 2) never build embankments: fill ≤ 4 m (an unbounded ridge-trail fill would fill the biome-03 view's valley)
      const CF = P.w > 2 ? ROAD_CF : 4, CFH = P.w > 2 ? ROAD_CF + 3 : 5;
      const win = (s: number) => { gb[s] = fixed[s] ? fixY[s] : clamp(gb[s], prof[s] - ROAD_CUT, noFill[s] ? prof[s] : prof[s] + CF); };
      const limit = (g: number) => {
        for (let s = 1; s < nS; s++) if (!fixed[s]) gb[s] = clamp(gb[s], gb[s - 1] - g, gb[s - 1] + g);
        for (let s = nS - 2; s >= 0; s--) if (!fixed[s]) gb[s] = clamp(gb[s], gb[s + 1] - g, gb[s + 1] + g);
      };
      // [window → design-grade limiter] × 8, the limiter LAST (a conflict ends as a deeper cut, never a step); then
      // where even that needs more than ROAD_CUT_MAX (a trail up the volcano: an unbounded cut would take 120 m off the
      // ripe-peak cone) the bed steepens toward ROAD_GMAX (26°, still full walking speed) inside the hard window
      for (let it = 0; it < 8; it++) { for (let s = 0; s < nS; s++) win(s); limit(G); }
      const GM = dmath.tan((ROAD_GMAX * Math.PI) / 180) * step;
      const hard = (s: number) => { if (!fixed[s]) gb[s] = clamp(gb[s], prof[s] - ROAD_CUT_MAX, noFill[s] ? prof[s] : prof[s] + CFH); };
      for (let it = 0; it < 6; it++) { for (let s = 0; s < nS; s++) hard(s); limit(GM); }
      // no-fill wins (never dam the river): clamp, then lower the neighbours toward it (min-cone at the design grade)
      for (let s = 0; s < nS; s++) if (noFill[s] && !fixed[s]) gb[s] = Math.min(gb[s], prof[s]);
      for (let s = 1; s < nS; s++) if (!fixed[s]) gb[s] = Math.min(gb[s], gb[s - 1] + G);
      for (let s = nS - 2; s >= 0; s--) if (!fixed[s]) gb[s] = Math.min(gb[s], gb[s + 1] + G);
      // blend: inside POIs the worn track, outside the graded bed
      const tgt = new Float32Array(nS);
      for (let s = 0; s < nS; s++) tgt[s] = sm[s] + (gb[s] - sm[s]) * ow[s];
      // the bed's cut / fill per sample, spread along the path (running max ±24 m, then a ±12 m mean): neighbouring
      // cells that map to different samples see nearly the same bank width (a per-sample width leaves 4 m scarps)
      const cfS = new Float32Array(nS), cfM = new Float32Array(nS);
      for (let s = 0; s < nS; s++) cfS[s] = Math.abs(tgt[s] - prof[s]);
      for (let s = 0; s < nS; s++) { let m = 0; for (let o = -12; o <= 12; o++) { const q = s + o; if (q >= 0 && q < nS && cfS[q] > m) m = cfS[q]; } cfM[s] = m; }
      for (let s = 0; s < nS; s++) { let a = 0, c = 0; for (let o = -6; o <= 6; o++) { const q = s + o; if (q >= 0 && q < nS) { a += cfM[q]; c++; } } cfS[s] = a / c; }
      let minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9;
      for (const p of P.pts) { minx = Math.min(minx, p[0]); maxx = Math.max(maxx, p[0]); minz = Math.min(minz, p[1]); maxz = Math.max(maxz, p[1]); }
      const PW = P.w, BANK0 = P.w > 2 ? 9 : 6.5, SH = 1.5;
      const pad = PW + SH + BANK0 + ROAD_CUT / 0.35 + 6;
      const j0 = Math.max(0, Math.floor((minx - pad + WORLD.HALF) / WORLD.CELL)), j1 = Math.min(res - 1, Math.ceil((maxx + pad + WORLD.HALF) / WORLD.CELL));
      const i0 = Math.max(0, Math.floor((minz - pad + WORLD.HALF) / WORLD.CELL)), i1 = Math.min(res - 1, Math.ceil((maxz + pad + WORLD.HALF) / WORLD.CELL));
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const x = X(j), z = Z(i), k = i * res + j;
        // (a gentle 0.2–0.5 m edge wobble at 30 m — 0.9 m at 11 m gives lumpy puzzle-piece edges)
        const wob = (PW > 2 ? 0.5 : 0.2) * n3.fbm(x / 30, z / 30, 2);
        const q = polyDist(P.pts, x, z);
        const d = q.d + wob;
        if (d > pad) continue;
        if (src[k] < 0.6) continue; // never through water
        if (plantationAt(x, z) > 0.2) continue; // the POI's own farm roads run through the field
        const sI = clamp(Math.round(q.t / step), 0, nS - 1), o = ow[sI];
        // coverage is LINEAR in the distance to the centreline (0.82 at the ribbon edge d = PW, 0.45 at PW + 1.2, 0 at
        // PW + 2.7): a 2 m grid of a linear ramp interpolates exactly → a smooth, constant-width ribbon; veg's grass
        // reaches the dirt's edge. Never painted on walls steeper than ~35°.
        if (d <= PW + 2.8) {
          let cover = clamp(0.82 - 0.3 * (d - PW), 0, 1);
          { const jx = clamp(j, 1, res - 2), iz = clamp(i, 1, res - 2), sl = dmath.hypot(src[iz * res + jx + 1] - src[iz * res + jx - 1], src[(iz + 1) * res + jx] - src[(iz - 1) * res + jx]) / (2 * WORLD.CELL);
            cover *= 1 - smoothstep(0.62 + 0.4 * o, 0.78 + 0.4 * o, sl); }
          path8[k] = Math.max(path8[k], Math.round(255 * cover));
        }
        const cover = clamp(0.82 - 0.3 * (d - PW), 0, 1);
        const target = tgt[sI] - (PW > 2 ? 0.14 : 0.2) * cover;
        let delta = target - heights[k];
        if (delta > 0 && nearRiver(x, z)) delta = 0;                        // bridges / fords are the POIs' — never dam the river
        // the bed stays inside the profile's own cut / fill window, so the cell cap never bites in the open world
        const lim = 0.6 + (ROAD_CUT_MAX + 0.5 - 0.6) * o;
        delta = clamp(delta, -lim, lim);
        // the flat bed + shoulder, then a bank as wide as the cut / fill needs to stay ≤ ~34° (tan 34° ≈ 0.67)
        // the bank's width follows the BED's own cut / fill (tgt − ground at the centreline), not this cell's
        // difference to the bed: otherwise a deep valley beside a crest trail reads as a "36 m fill" and gets a 100 m
        // embankment; one width per bed sample, so neighbouring cells never disagree (a
        // per-cell width leaves 4 m scarps where it switches)
        const bedCF = cfS[sI];
        const bank = BANK0 * (1 - o) + o * Math.max(6, bedCF / 0.35 + 3);   // smoothstep peak ≈ 1.5 × 19° ≈ 28°
        const bed = (PW + SH) * o + PW * 0.7 * (1 - o);
        // × the CELL's own openness: a bank grown by a deep cut / fill (up to ~65 m wide) never reaches into a
        // POI's ground (a trail sample just outside 0.92 r could otherwise fill 16 m inside the POI)
        const w = (1 - smoothstep(bed, bed + bank, d)) * (1 - padW(x, z)) * (d <= bed ? 1 : openW(x, z));
        if (pinned[k] && d > bed) continue;                               // an earlier road's bed: only this road's own bed may touch it
        if (w <= claim[k]) continue;                                        // an earlier road's bank holds this cell more strongly
        if (w > accW[k]) { if (accW[k] === 0) touched.push(k); acc[k] = delta; accW[k] = w; if (d <= bed) isBed[k] = 1; }
      }
      for (const k of touched) { heights[k] += acc[k] * accW[k]; claim[k] = Math.max(claim[k], accW[k]); if (accW[k] > 0.97 || isBed[k]) pinned[k] = 1; acc[k] = 0; accW[k] = 0; isBed[k] = 0; }
      touched.length = 0;
    }
    (globalThis as { __tgProbe?: (s: string, h: Float32Array) => void }).__tgProbe?.("p8road", heights);
    // bank envelope (open world): within BANK_R m of any graded bed the ground rises / falls at most PAD_RIM_K per metre
    // from the nearest bed cell (fading out over the last 8 m) — a road or trail is never flanked by a wall, whichever
    // road's bank won a cell above. Chamfer propagation of (distance, bed height) from the pinned bed cells. Never on
    // cliff zones, the coast, pads, or inside 0.9 × a POI's radius (the POI's own ground).
    {
      const BANK_R = 34, dist = new Float32Array(N).fill(1e9), hb = new Float32Array(N);
      for (let k = 0; k < N; k++) if (pinned[k]) { dist[k] = 0; hb[k] = heights[k]; }
      const D1 = WORLD.CELL, D2 = WORLD.CELL * Math.SQRT2;
      const relax = (k: number, nk: number, dd: number) => { if (dist[nk] + dd < dist[k]) { dist[k] = dist[nk] + dd; hb[k] = hb[nk]; } };
      for (let i = 1; i < res - 1; i++) for (let j = 1; j < res - 1; j++) { const k = i * res + j; relax(k, k - 1, D1); relax(k, k - res, D1); relax(k, k - res - 1, D2); relax(k, k - res + 1, D2); }
      for (let i = res - 2; i >= 1; i--) for (let j = res - 2; j >= 1; j--) { const k = i * res + j; relax(k, k + 1, D1); relax(k, k + res, D1); relax(k, k + res + 1, D2); relax(k, k + res - 1, D2); }
      // eligible bank cells, then slope-limited sweeps: each cell stays within PAD_RIM_K·step of every neighbour that is
      // closer to the bed (its "parent"), so the LOCAL slope of the bank is bounded, not just the mean from the bed; the
      // allowance opens up over the zone's last 8 m (no step where the zone ends — a steeper toe instead)
      const ok = new Uint8Array(N);
      for (let i = 1; i < res - 1; i++) {
        const z = Z(i);
        for (let j = 1; j < res - 1; j++) {
          const k = i * res + j, dd = dist[k];
          if (dd <= 0 || dd > BANK_R || src[k] < 0.6 || sdf[k] < 25 || cliffW[k] > 0.05) continue;
          const x = X(j); if (POIS.some((p) => dmath.hypot(x - p.x, z - p.z) < p.r * 0.8) || padW(x, z) > 0.95 || dmath.hypot(x - V.x, z - V.z) < V.base + 40) continue;
          // only DOWN (never a fill) near the river (never dams it) and in a POI's outer ring (0.8–0.9 r, within
          // 12 m of the bed: the road's own cut bank — otherwise a POI edge can keep a 70° wall beside the regraded road)
          const ring = POIS.some((p) => dmath.hypot(x - p.x, z - p.z) < p.r * 0.9);
          if (ring && dd > 12) continue;
          ok[k] = nearRiver(x, z) || ring ? 2 : 1;
        }
      }
      const NB = [1, -1, res, -res, res + 1, res - 1, -res + 1, -res - 1], ND = [D1, D1, D1, D1, D2, D2, D2, D2];
      const sweep = (k: number) => {
        if (!ok[k]) return;
        const dk = dist[k], open = 1 + Math.max(0, dk - (BANK_R - 14)) * 0.18;   // (a softer toe over the last 14 m of a 34 m zone)
        let lo = -1e9, hi = 1e9;
        for (let q = 0; q < 8; q++) { const nk = k + NB[q]; if (dist[nk] >= dk || !(pinned[nk] || ok[nk])) continue; const a = PAD_RIM_K * ND[q] * open; lo = Math.max(lo, heights[nk] - a); hi = Math.min(hi, heights[nk] + a); }
        if (lo > hi) return;
        if (heights[k] > hi) heights[k] = hi; else if (heights[k] < lo && ok[k] === 1) heights[k] = lo;
      };
      for (let it = 0; it < 3; it++) {
        for (let k = res + 1; k < N - res - 1; k++) sweep(k);
        for (let k = N - res - 2; k > res; k--) sweep(k);
      }
      (globalThis as { __tgProbe?: (s: string, h: Float32Array) => void }).__tgProbe?.("p8env", heights);
      // despike the road corridors: where two graded beds pass close at different heights (an earlier road's
      // pinned bed beside a later road's cut — canopy-line / lab road at (141, −334)) single cells can be left standing
      // 5–8 m proud of every neighbour: a pleated vertical sliver at eye level. Within BANK_R of a bed (never water,
      // never the POIs' inner 0.8 r) a cell stays within 1.2 m of its highest / lowest 4-neighbour.
      for (let it = 0; it < 4; it++) {
        for (let i = 1; i < res - 1; i++) {
          const z = Z(i);
          for (let j = 1; j < res - 1; j++) {
            const k = i * res + j; if (dist[k] > BANK_R || src[k] < 0.6 || pinned[k]) continue;
            const a = heights[k - 1], b = heights[k + 1], c = heights[k - res], d = heights[k + res];
            const mx = Math.max(a, b, c, d), mn = Math.min(a, b, c, d);
            if (heights[k] <= mx + 1.2 && heights[k] >= mn - 1.2) continue;
            const x = X(j); if (POIS.some((p) => dmath.hypot(x - p.x, z - p.z) < p.r * 0.8)) continue;
            heights[k] = heights[k] > mx + 1.2 ? mx + 1.2 : mn - 1.2;
          }
        }
      }
    }
  }

  (globalThis as { __tgProbe?: (s: string, h: Float32Array) => void }).__tgProbe?.("pass 9", heights);
  // ---- pass 9: exact signed coast distance (metres) from the final heights
  {
    const land = new Uint8Array(N), sea = new Uint8Array(N);
    for (let k = 0; k < N; k++) { land[k] = heights[k] >= 0 ? 1 : 0; sea[k] = 1 - land[k]; }
    const dLand = edt(land, res, res), dSea = edt(sea, res, res);
    for (let k = 0; k < N; k++) {
      const d = (land[k] ? dSea[k] : -dLand[k]) * WORLD.CELL;
      coast8[k] = Math.max(-127, Math.min(127, Math.round(d)));
    }
  }

  // ---- pass 10: biomes (slope-aware)
  // cavity (gully +, ridge −) for the cone's jungle line: jungle climbs higher in the gullies
  const cav = new Float32Array(N);
  { const b1 = blur(heights, res, 4); for (let k = 0; k < N; k++) cav[k] = clamp((b1[k] - heights[k]) / 3, -1, 1); }
  // meadows: domain-warped ellipses + 25–60 m edge noise → irregular lobes, tongues of jungle and islands of trees
  const meadow = (x: number, z: number) => {
    const [wx, wz] = groundWarp(n3, x, z);
    let m = -1e9; for (const e of MEADOWS) m = Math.max(m, ellipseD(e, wx, wz));
    // THE PLANTATION: a 10–30 m ragged grass verge round the planted field (the perimeter track runs in it)
    { const F = PLANTATION_FIELD, d = dmath.hypot(wx - F.x, wz - F.z);
      if (d < 230) m = Math.max(m, 18 - (d - 155)); }
    return m + 20 * n.fbm(x / 60 + 21, z / 60, 3) + 8 * n2.fbm(x / 24, z / 24 + 5, 2);
  };
  // POI grounds read as trampled grass (the material adds dirt + paving patches), never as a jungle-floor disc
  const poiGround = POIS.filter((p) => p.padY !== null && p.id !== "peel-harbor" && p.id !== "the-plantation" && p.id !== "lobby-islet");
  const onPoiGround = (x: number, z: number) => {
    const [wx, wz] = groundWarp(n3, x, z);
    for (const p of poiGround) {
      const dd = dmath.hypot(x - p.x, z - p.z);
      if (dd < p.pad * 0.8) return true;   // the flat pad core stays open ground under the buildings
      if (dd < p.pad + p.blend + 45 && padWeight(n2, p.x, p.z, p.pad, p.blend, wx, wz) + 0.3 * n.fbm(x / 40 + 3, z / 40, 2) > 0.5) return true;
    }
    return false;
  };
  for (let i = 0; i < res; i++) {
    const z = Z(i);
    for (let j = 0; j < res; j++) {
      const k = i * res + j, x = X(j), h = heights[k];
      const jx = clamp(j, 1, res - 2), iz = clamp(i, 1, res - 2);
      const sx = (heights[iz * res + jx + 1] - heights[iz * res + jx - 1]) / (2 * WORLD.CELL);
      const sz = (heights[(iz + 1) * res + jx] - heights[(iz - 1) * res + jx]) / (2 * WORLD.CELL);
      const slope = dmath.hypot(sx, sz), d = coast8[k];
      const vr = dmath.hypot(x - V.x, z - V.z);
      const lagD = lagDist[k] * WORLD.CELL;
      const lag = inPoly(lagoonPoly, x, z) || lagD < 40 || dmath.hypot(x - MURK.x, (z - MURK.z) * 1.1) < MURK.r * 1.2;
      let b: Biome;
      const inLagP = lag && inPoly(lagoonPoly, x, z), murkD = dmath.hypot(x - MURK.x, (z - MURK.z) * 1.1);
      if (inLagP && h >= 0 && h < 0.95 && lagD < 5 && murkD > MURK.r * 1.2 && n2.fbm(x / 30 + 4, z / 30, 2) > -0.05) b = Biome.Beach;   // islet sand rims (mangrove shores between)
      else if (lag && h > -4 && h < 1.0 && !(h >= 0 && lagD > 40 && d < 60)) b = Biome.Lagoon;
      else if (inLagP && h >= 1.0) b = Biome.Jungle;   // islet crowns: mangrove / jungle forest (not sand)
      else if (h < -7) b = Biome.DeepOcean;
      else if (h < 0) b = Biome.Reef;
      else if (path8[k] > 128) b = Biome.Path;
      else if (vr < V.cone + 10 && h > 104 + 22 * n.fbm(x / 60 + 5, z / 60, 3) + 26 * cav[k]) b = slope > 2.2 ? Biome.Rock : Biome.Cinder;
      else if (badlandsAt(x, z) > 0.5) b = slope > 0.95 ? Biome.Rock : Biome.Cinder;
      else if (slope > 1.0) b = Biome.Rock;
      else if (h < 3.2 && d < 90 && cliffW[k] < 0.4 && !lag && lagD > 75) b = Biome.Beach;
      else if (h < 2.8 && d < 34 && cliffW[k] < 0.4 && lagD > 10 && z < -400 && x > 280 && x < 760 && !inPoly(lagoonPoly, x, z)) b = Biome.Beach; // the lagoon's sand barrier / spit
      else if (x > 420 && x < 900 && z > 170 && z < 560 && inPoly(HARBOR_APRON, x, z)) b = Biome.Paved;
      else if (plantationAt(x, z) > 0.5) b = Biome.Farmland;
      else if (slope > 0.85 && h > 8) b = Biome.Rock;
      else if (meadow(x, z) > 0 || onPoiGround(x, z)) b = Biome.Grass;
      // (high threshold, small hill bonus — few random open meadows: the island is ~95 % canopy, its clearings are the POIs)
      else b = n2.fbm(x / 240 + 40, z / 240, 3) + 0.12 * smoothstep(25, 70, h) > 0.56 ? Biome.Grass : Biome.Jungle;
      biome[k] = b;
    }
  }
  // ---- pass 11: quantise exactly like the file (cm) and hash — generate === decode(encode(generate))
  for (let k = 0; k < N; k++) heights[k] = Math.max(-32768, Math.min(32767, Math.round(heights[k] * 100))) / 100;
  const out: TerrainData = { heights, biome, res, coast: coast8, path: path8 };
  // lava channels with real banks and levees, not decals: the channels are traced ONCE here on the quantised
  // heights, quantised (cm) and stored in the file (v4); then their beds are SUNK 0.4–0.9 m and crusted LEVEES 0.4–1.3 m
  // tall are raised along both banks (the lines stay the stored ones — a re-trace on the carved ground would wander)
  const lavaLines = lavaChannels(out).map((L) => ({ pts: L.pts.map(([x, z]) => [Math.round(x * 100) / 100, Math.round(z * 100) / 100] as Pt), hw: L.hw.map((w) => Math.round(w * 100) / 100) }));
  carveLava(heights, res, lavaLines);
  for (let k = 0; k < N; k++) heights[k] = Math.max(-32768, Math.min(32767, Math.round(heights[k] * 100))) / 100;
  out.lava = lavaLines;
  // KIPUKAS: islands of older, higher ground the flows went round — jungle / grass instead of cinder, except
  // within ~14 m of a molten channel
  for (let i = 0; i < res; i++) for (let j = 0; j < res; j++) {
    const k = i * res + j;
    if (biome[k] !== Biome.Cinder && biome[k] !== Biome.Rock) continue;
    const x = X(j), z = Z(i);
    if (kipukaAt(x, z) < 0.5 || dmath.hypot(x - V.x, z - V.z) < V.cone + 30) continue;
    biome[k] = n2.fbm(x / 34 + 3, z / 34, 2) > 0.1 ? Biome.Grass : Biome.Jungle;
  }
  { const near = lavaNearMask(res, lavaLines, 14);
    for (let k = 0; k < N; k++) if (near[k] && (biome[k] === Biome.Grass || biome[k] === Biome.Jungle) && badlandsAt(X(k % res), Z((k / res) | 0)) > 0.5) biome[k] = Biome.Cinder; }
  // molten lava channels (the stored lines — the same lines the client draws) are tagged Paved: no plant of any kind (veg
  // blocks Paved for trees + detail), no footstep grass (no palms or grass tufts on the molten rivers).
  for (const L of lavaLines) for (let q = 0; q < L.pts.length; q++) {
    const [px, pz] = L.pts[q], R = L.hw[q] + 1.0;
    for (let i = Math.floor((pz - R + WORLD.HALF) / WORLD.CELL); i <= Math.ceil((pz + R + WORLD.HALF) / WORLD.CELL); i++)
      for (let j = Math.floor((px - R + WORLD.HALF) / WORLD.CELL); j <= Math.ceil((px + R + WORLD.HALF) / WORLD.CELL); j++) {
        if (i < 0 || j < 0 || i >= res || j >= res) continue;
        if (dmath.hypot(X(j) - px, Z(i) - pz) < R && heights[i * res + j] > 0.3) biome[i * res + j] = Biome.Paved;
      }
  }
  out.hash = terrainHash(out);
  return out;
}

// ================================================================ lava channels (deterministic from the heights)
export interface LavaLine { pts: Pt[]; /** half-width (m) per point */ hw: number[] }
/** per 2 m sample: 1 within `r` m of any lava channel's bank */
function lavaNearMask(res: number, lines: LavaLine[], r: number): Uint8Array {
  const H = WORLD.HALF, C = WORLD.CELL, m = new Uint8Array(res * res);
  for (const L of lines) for (let q = 0; q < L.pts.length; q += 2) {
    const [px, pz] = L.pts[q], R = L.hw[q] + r;
    for (let i = Math.max(0, Math.floor((pz - R + H) / C)); i <= Math.min(res - 1, Math.ceil((pz + R + H) / C)); i++)
      for (let j = Math.max(0, Math.floor((px - R + H) / C)); j <= Math.min(res - 1, Math.ceil((px + R + H) / C)); j++)
        if (dmath.hypot(-H + j * C - px, -H + i * C - pz) < R) m[i * res + j] = 1;
  }
  return m;
}
const NOISE_LEVEE = new Simplex2(WORLD.SEED + 913);
/** the channel profile across a lava river at distance d (m) from its centre line, half-width hw: a SUNKEN bed
 * (−0.4 … −0.9 m at the centre) between two crusted LEVEES (+0.4 … +1.3 m, crest ~1.2 m outside the bank, back to the
 * ground ~hw + 5 m out). `lev` scales the levee (it wanders along the river; thin on the steep cone). */
export function lavaProfile(d: number, hw: number, lev: number, bedK: number): number {
  const bedR = hw + 0.6, bed = (0.4 + 0.3 * Math.min(1.6, hw)) * bedK;
  if (d < bedR) { const u = d / bedR; return -bed * (1 - u * u) + (0.5 + 0.35 * hw) * lev * smoothstep(0.55, 1, u) * 0.6; }
  const L = 3.2 + 1.2 * hw, t = (d - bedR) / L;
  if (t >= 1) return 0;
  // levee: steep inner bank, long gentle outer slope (a rounded crest at t ≈ 0.22)
  const crest = t < 0.22 ? 0.6 + 0.4 * dmath.sin((t / 0.22) * Math.PI / 2) : dmath.pow(1 - (t - 0.22) / 0.78, 1.6);
  return (0.5 + 0.35 * hw) * lev * crest;
}
/** carve every channel's bed + levees into the heights (land only, never below 0.35 m); the strongest (nearest) channel
 * wins where two meet */
function carveLava(h: Float32Array, res: number, lines: LavaLine[]) {
  const H = WORLD.HALF, C = WORLD.CELL, V = VOLCANO;
  const bestD = new Float32Array(res * res).fill(1e9), off = new Float32Array(res * res), src = Float32Array.from(h);
  for (const L of lines) {
    let acc = 0;
    for (let q = 0; q < L.pts.length; q++) {
      const [px, pz] = L.pts[q], hw = L.hw[q];
      if (q > 0) acc += dmath.hypot(px - L.pts[q - 1][0], pz - L.pts[q - 1][1]);
      const vr = dmath.hypot(px - V.x, pz - V.z);
      const onCone = 1 - smoothstep(V.cone - 30, V.cone + 20, vr);
      // levee height wanders along the river (0.45–1.25 ×), low on the cone (the gullies are its banks there)
      const lev = (0.75 + 0.5 * NOISE_LEVEE.noise(acc / 38, L.pts.length * 0.01)) * (1 - 0.65 * onCone);
      const bedK = 1 - 0.45 * onCone;
      const R = hw + 0.6 + 3.2 + 1.2 * hw;
      for (let i = Math.max(1, Math.floor((pz - R + H) / C)); i <= Math.min(res - 2, Math.ceil((pz + R + H) / C)); i++)
        for (let j = Math.max(1, Math.floor((px - R + H) / C)); j <= Math.min(res - 2, Math.ceil((px + R + H) / C)); j++) {
          const k = i * res + j, d = dmath.hypot(-H + j * C - px, -H + i * C - pz);
          if (d >= R || src[k] < 0.3) continue;
          // nearest channel point decides (the profile is continuous along a line; where lines join the nearer wins)
          if (d < bestD[k]) { bestD[k] = d; off[k] = lavaProfile(d, hw, lev, bedK); }
        }
    }
  }
  for (let k = 0; k < h.length; k++) if (bestD[k] < 1e8) h[k] = Math.max(Math.min(0.35, src[k]), src[k] + off[k]);
}
const NOISE_KIP = new Simplex2(WORLD.SEED + 917);
/** 0..1 KIPUKA membership: islands (30–80 m) of older, higher, vegetated ground inside the lava field that the
 * flows went round — plants, palms and green pockets in the lava field; from the air the black field breaks up
 * into a mottle instead of one flat black plate. Only in the outer field (> ~240 m from the cone). */
export function kipukaAt(x: number, z: number): number {
  const V = VOLCANO, vr = dmath.hypot(x - V.x, z - V.z);
  if (vr < 225) return 0;
  const f = NOISE_KIP.fbm(x / 95 + 2.1, z / 95 - 4.7, 3) + 0.35 * NOISE_KIP.fbm(x / 33, z / 33 + 9, 2);
  // keep the biome-04 foreground (the camera's first ~70 m) a lava field
  const cam = TERRAIN_CAMS["biome-04-volcanic"];
  const keep = 1 - smoothstep(60, 110, dmath.hypot(x - cam.pos[0] - 45, z - cam.pos[2] - 20));
  return smoothstep(0.02, 0.2, f) * smoothstep(220, 270, vr) * (1 - keep);
}
/** Glowing lava rivers (biome-04): steepest-descent flow lines traced on the (4 m-smoothed) final heightfield — from
 * the crater lip down the cone's W / NW face (they fall into the gullies, so they run where the ground says water
 * would), and from the cone's foot across the badlands to the black coast. A line that reaches another line joins it
 * and stops (tributaries → branching). Half-widths 1.5–3 m (3–6 m wide channels). Visual (material + audio); the same
 * lines on every client. */
export function lavaChannels(t: TerrainData): LavaLine[] {
  if (t.lava) return t.lava;
  const res = t.res, H = WORLD.HALF, C = WORLD.CELL, V = VOLCANO;
  const sm = blur(t.heights, res, 2);
  const hS = (x: number, z: number) => {
    const fx = clamp((x + H) / C, 0, res - 1.001), fz = clamp((z + H) / C, 0, res - 1.001);
    const j = fx | 0, i = fz | 0, tx = fx - j, tz = fz - i, k = i * res + j;
    const a = sm[k] + (sm[k + 1] - sm[k]) * tx, b = sm[k + res] + (sm[k + res + 1] - sm[k + res]) * tx;
    return a + (b - a) * tz;
  };
  const nB = new Simplex2(WORLD.SEED + 19), nW = new Simplex2(WORLD.SEED + 911);
  const rnd = mulberry32(WORLD.SEED + 909);
  const out: LavaLine[] = [];
  const occ = new Map<number, number>();   // 3 m cells → line id (merge test)
  const key = (x: number, z: number) => (Math.floor((x + H) / 3) * 2048 + Math.floor((z + H) / 3));
  // FIVE cone rivers (not parallel equal-width tiger stripes) — two pour out of the crater's breach
  // notch, three break out of flank vents at different heights — with very different widths, forks lower down and wide
  // dark-rock gaps between them; plus four rivers across the badlands from the cone's foot to the black coast.
  // [bearing, radius from the cone centre, target half-width]
  const seeds: Array<[number, number, number, number]> = [];   // x, z, start half-width, target half-width
  // (narrow — the cone streaks are thin bright lines and the field seams 1–3 m wide meandering
  // cracks; 5–8 m bands read as wide flat peach roads)
  const cone: Array<[number, number, number]> = [
    // (1.4–2.4 m wide streaks: bright hairlines from 400 m; the shader does not
    // swell them on the cone)
    [CRATER_BREACH - 0.03, V.crater + 7, 1.25], [3.2, 96, 0.9], [3.98, 84, 0.7], [4.34, 112, 1.05], [3.36, 140, 0.75],
  ];
  for (const [a, r, w] of cone) seeds.push([V.x + dmath.cos(a) * r, V.z + dmath.sin(a) * r, w * 0.45, w]);
  // field seams from the cone's foot + a few crust vents out in the field
  for (const [a, w, dr] of [[3.02, 1.3, 22], [3.38, 0.85, 22], [3.92, 1.5, 22], [4.25, 0.8, 22], [3.62, 0.75, 70], [3.2, 0.7, 95], [3.8, 0.9, 120]] as Array<[number, number, number]>) {
    seeds.push([V.x + dmath.cos(a) * (V.cone + dr), V.z + dmath.sin(a) * (V.cone + dr), w * 0.5, w]);
  }
  // biome-04 (branching glowing lava fields in the foreground, not one thin ribbon): seams that rise in the
  // field between the camera and the cone and run down past the camera (appended: every older river keeps its path)
  const lensSeeds: Array<[number, number, number, number]> = [];
  {
    const c = TERRAIN_CAMS["biome-04-volcanic"], fx = c.target[0] - c.pos[0], fz = c.target[2] - c.pos[2], fl = dmath.hypot(fx, fz), ux = fx / fl, uz = fz / fl;
    for (const [d, l, w] of [[70, -30, 0.9], [105, 18, 1.1], [150, -8, 0.8], [190, 40, 0.9], [125, -55, 0.7], [85, 45, 0.6]] as Array<[number, number, number]>)
      lensSeeds.push([c.pos[0] + ux * d - uz * l, c.pos[2] + uz * d + ux * l, w * 0.5, w]);
  }
  const trace = (sx: number, sz: number, w0: number, target: number, id: number, fork: boolean) => {
    let x = sx, z = sz, dx = 0, dz = 0, flat = 0, taper = true;
    const pts: Pt[] = [], hw: number[] = [];
    const ph = rnd() * 100, mAmp = dmath.hypot(sx - V.x, sz - V.z) > V.cone ? 0.55 : 0.25;
    let ox = sx, oz = sz;
    for (let st = 0; st < 1400; st++) {
      // pooled: less than 8 m of progress over the last 60 steps (circling in a hollow)
      if (st % 60 === 59) { if (dmath.hypot(x - ox, z - oz) < 8) break; ox = x; oz = z; }
      const e = 2, gx = (hS(x + e, z) - hS(x - e, z)) / (2 * e), gz = (hS(x, z + e) - hS(x, z - e)) / (2 * e), gl = dmath.hypot(gx, gz);
      let ndx = dx * 0.55, ndz = dz * 0.55;
      if (gl > 1e-4) { ndx -= gx / gl * 0.45; ndz -= gz / gl * 0.45; }
      // a meander so flats do not give ruler-straight rivers (the field seams wander like cracks, the cone streaks less)
      const wob = mAmp * nW.noise(st / 28 + ph, id * 3.1);
      const rx = ndx - ndz * wob, rz = ndz + ndx * wob, rl = dmath.hypot(rx, rz) || 1;
      dx = rx / rl; dz = rz / rl;
      x += dx; z += dz;
      const h = t.heights[clamp(Math.round((z + H) / C), 0, res - 1) * res + clamp(Math.round((x + H) / C), 0, res - 1)];
      if (h < 0.3) { taper = false; break; }                      // reached the sea
      const vr = dmath.hypot(x - V.x, z - V.z);
      // only on the cone and in the lava field: a cone river that would leave the cone anywhere else (into the jungle)
      // ends on the lower flank as a cooling tongue
      if (vr > V.cone - 15 && badlandsW(nB, x, z) < 0.12) break;
      flat = gl < 0.025 ? flat + 1 : 0;
      if (flat > 30) break;                                        // pooled on a flat
      const k = key(x, z), o = occ.get(k);
      if (o !== undefined && o !== id && st > 6) { pts.push([x, z]); hw.push(hw.length ? hw[hw.length - 1] : w0); taper = false; break; } // joined another river
      const s = st;
      // width: grows from the source over 70 m, pulses ±25 % along the river, spreads a little on flats (pooling)
      // (field seams also swell into small molten pools here and there)
      const pool = mAmp > 0.3 ? 1 + 0.6 * smoothstep(0.5, 0.85, nW.noise(s / 18 + ph * 2, id + 7.7)) : 1;
      // cone streaks narrow to seams once they leave the cone (the field is threaded with 1–3 m seams, not roads)
      const leave = mAmp > 0.3 ? 1 : 1 - 0.4 * smoothstep(V.cone - 10, V.cone + 40, vr);
      const w = lerp(w0, target * pool * leave * (0.75 + 0.5 * (0.5 + 0.5 * dmath.sin(s / 37 + ph))) * (1 + 0.2 * smoothstep(0.12, 0.03, gl)), smoothstep(0, 70, s));
      pts.push([x, z]); hw.push(w);
      if (o === undefined) occ.set(k, id);
    }
    if (pts.length > 12) {
      // taper the tail (a cooling tongue) unless it reached the sea or joined another river
      if (taper) for (let q = 0; q < Math.min(14, pts.length); q++) hw[pts.length - 1 - q] *= 0.4 + 0.6 * q / 14;
      out.push({ pts, hw });
      // forks: a distributary splits off 35–60 % of the way down a wide river, a few metres to one side, and finds its
      // own gully (it may rejoin the parent lower down — a braided channel)
      if (fork && target > 0.95 && pts.length > 80) {
        const at = Math.floor(pts.length * (0.35 + 0.25 * rnd())), [fx, fz] = pts[at], [gx, gz] = pts[Math.min(pts.length - 1, at + 3)];
        const tl = dmath.hypot(gx - fx, gz - fz) || 1, side = rnd() < 0.5 ? -1 : 1, off = hw[at] + 4 + 3 * rnd();
        trace(fx - (gz - fz) / tl * off * side, fz + (gx - fx) / tl * off * side, hw[at] * 0.35, target * 0.55, 100 + id, false);
      }
    }
  };
  seeds.forEach(([sx, sz, w0, target], id) => trace(sx, sz, w0, target, id, true));
  lensSeeds.forEach(([sx, sz, w0, target], id) => trace(sx, sz, w0, target, 200 + id, true));
  return out;
}

// ================================================================ binary file (client + server load the SAME bytes)
// v3 "KRT3": u32 magic | u32 res | f32 cell | f32 half | u32 hash | u32 payload bytes | gzip(payload)
//   payload = heights (i16 cm, row-delta coded, split into a low-byte plane and a high-byte plane) | u8 biome |
//             i8 coast (m) | u8 path            (~1.3 MB on disk instead of 7.2 MB)
// v2 "KRT2" (raw, uncompressed) is still decoded.
const MAGIC2 = 0x3254524b, MAGIC3 = 0x3354524b, MAGIC4 = 0x3454524b, MAGIC5 = 0x3554524b; // "KRT2" … "KRT5" little-endian
// v4 "KRT4" = v3 + a lava section appended to the payload: u32 lines | per line: u32 n, n × (i32 x cm, i32 z cm,
// u16 half-width cm)

/** a keep-out as stored: x, z (cm), circle → (r cm, −1, 0), rect → (hx cm, hz cm, yaw mrad) */
function keepQ(q: RockKeep): [number, number, number, number, number] {
  return q.r > 0 ? [Math.round(q.x * 100), Math.round(q.z * 100), Math.round(q.r * 100), -1, 0]
    : [Math.round(q.x * 100), Math.round(q.z * 100), Math.round(q.hx * 100), Math.round(q.hz * 100), Math.round(q.yaw * 1000)];
}
/** FNV-1a 32 over the quantised content (heights as i16 cm LE, biome, coast, path). Cheap enough to run at load. */
export function terrainHash(t: TerrainData): number {
  let h = 0x811c9dc5 >>> 0;
  const N = t.res * t.res, hs = t.heights;
  for (let k = 0; k < N; k++) {
    const v = Math.max(-32768, Math.min(32767, Math.round(hs[k] * 100))) & 0xffff;
    h = Math.imul(h ^ (v & 0xff), 16777619); h = Math.imul(h ^ (v >>> 8), 16777619);
  }
  for (const arr of [t.biome, new Uint8Array(t.coast.buffer, t.coast.byteOffset, N), t.path]) for (let k = 0; k < N; k++) h = Math.imul(h ^ arr[k], 16777619);
  // (v4) the stored lava lines (cm)
  if (t.lava) for (const L of t.lava) {
    h = Math.imul(h ^ (L.pts.length & 0xff), 16777619);
    for (let q = 0; q < L.pts.length; q++) for (const v of [L.pts[q][0], L.pts[q][1], L.hw[q]]) { const c = Math.round(v * 100) | 0; h = Math.imul(h ^ (c & 0xff), 16777619); h = Math.imul(h ^ ((c >>> 8) & 0xff), 16777619); }
  }
  // (v5) the rock keep-outs are NOT hashed: they only move rocks, and every rock collider is in the static-world hash
  // (shared/sim/static-world.ts worldHash) — the terrain hash stays "the ground", so the POI ground bakes that key on it
  // (jungle / murk / caves / lookout) stay valid when only a POI clearing moved
  return h >>> 0;
}

export function encodeTerrainFile(t: TerrainData): ArrayBuffer {
  const res = t.res, N = res * res;
  let lavaBytes = 0;
  if (t.lava || t.keep) { lavaBytes = 4; for (const L of t.lava ?? []) lavaBytes += 4 + L.pts.length * 10; }
  const keepBytes = t.keep ? 4 + t.keep.length * 20 : 0;
  const payload = new Uint8Array(N * 5 + lavaBytes + keepBytes);
  if (t.keep) {
    const dv = new DataView(payload.buffer, N * 5 + lavaBytes);
    dv.setUint32(0, t.keep.length, true);
    t.keep.forEach((q, i) => { const c = keepQ(q), o = 4 + i * 20; for (let m = 0; m < 5; m++) dv.setInt32(o + m * 4, c[m], true); });
  }
  if (t.lava || t.keep) {
    const dv = new DataView(payload.buffer, N * 5);
    let o = 0; dv.setUint32(o, t.lava?.length ?? 0, true); o += 4;
    for (const L of t.lava ?? []) {
      dv.setUint32(o, L.pts.length, true); o += 4;
      for (let q = 0; q < L.pts.length; q++) { dv.setInt32(o, Math.round(L.pts[q][0] * 100), true); dv.setInt32(o + 4, Math.round(L.pts[q][1] * 100), true); dv.setUint16(o + 8, Math.round(L.hw[q] * 100), true); o += 10; }
    }
  }
  for (let i = 0; i < res; i++) {
    let prev = 0;
    for (let j = 0; j < res; j++) {
      const k = i * res + j, v = Math.max(-32768, Math.min(32767, Math.round(t.heights[k] * 100)));
      const dlt = (v - prev) & 0xffff; prev = v;
      payload[k] = dlt & 0xff; payload[N + k] = dlt >>> 8;
    }
  }
  payload.set(t.biome, N * 2);
  payload.set(new Uint8Array(t.coast.buffer, t.coast.byteOffset, N), N * 3);
  payload.set(t.path, N * 4);
  const z = gzipSync(payload, { level: 9, mem: 9 });
  const head = 24, buf = new ArrayBuffer(head + z.byteLength), dv = new DataView(buf);
  dv.setUint32(0, t.keep ? MAGIC5 : t.lava ? MAGIC4 : MAGIC3, true); dv.setUint32(4, res, true); dv.setFloat32(8, WORLD.CELL, true); dv.setFloat32(12, WORLD.HALF, true);
  dv.setUint32(16, t.hash ?? terrainHash(t), true); dv.setUint32(20, payload.byteLength, true);
  new Uint8Array(buf, head).set(z);
  return buf;
}

/** decode island.bin (v3 compressed or v2 raw). Heights come back in cm steps — exactly what generateTerrain() returns.
 * Throws when the stored hash does not match the content (a corrupt / truncated download). */
export function decodeTerrainFile(buf: ArrayBuffer): TerrainData {
  const dv = new DataView(buf);
  const magic = dv.getUint32(0, true);
  if (magic !== MAGIC2 && magic !== MAGIC3 && magic !== MAGIC4 && magic !== MAGIC5) throw new Error("terrain: bad magic");
  const res = dv.getUint32(4, true), N = res * res;
  if (Math.abs(dv.getFloat32(8, true) - WORLD.CELL) > 1e-6 || Math.abs(dv.getFloat32(12, true) - WORLD.HALF) > 1e-3) throw new Error("terrain: file does not match WORLD");
  const heights = new Float32Array(N);
  if (magic === MAGIC2) {
    const head = 16, hs = new Int16Array(buf.slice(head, head + N * 2));
    for (let k = 0; k < N; k++) heights[k] = hs[k] / 100;
    const t: TerrainData = {
      heights, res,
      biome: new Uint8Array(buf.slice(head + N * 2, head + N * 3)),
      coast: new Int8Array(buf.slice(head + N * 3, head + N * 4)),
      path: new Uint8Array(buf.slice(head + N * 4, head + N * 5)),
    };
    t.hash = terrainHash(t);
    return t;
  }
  const want = dv.getUint32(16, true), len = dv.getUint32(20, true);
  const p = gunzipSync(new Uint8Array(buf, 24));
  if (p.byteLength !== len || (magic === MAGIC3 ? len !== N * 5 : len < N * 5 + 4)) throw new Error("terrain: bad payload size");
  let lava: LavaLine[] | undefined, keep: RockKeep[] | undefined;
  if (magic === MAGIC4 || magic === MAGIC5) {
    const dv2 = new DataView(p.buffer, p.byteOffset + N * 5, len - N * 5);
    let o = 0; const nL = dv2.getUint32(o, true); o += 4; lava = [];
    for (let l = 0; l < nL; l++) {
      const n = dv2.getUint32(o, true); o += 4; const pts: Pt[] = [], hw: number[] = [];
      for (let q = 0; q < n; q++) { pts.push([dv2.getInt32(o, true) / 100, dv2.getInt32(o + 4, true) / 100]); hw.push(dv2.getUint16(o + 8, true) / 100); o += 10; }
      lava.push({ pts, hw });
    }
    if (magic === MAGIC5) {
      const nK = dv2.getUint32(o, true); o += 4; keep = [];
      for (let q = 0; q < nK; q++, o += 20) {
        const x = dv2.getInt32(o, true) / 100, z = dv2.getInt32(o + 4, true) / 100, a = dv2.getInt32(o + 8, true), b = dv2.getInt32(o + 12, true), yaw = dv2.getInt32(o + 16, true) / 1000;
        keep.push(b < 0 ? { x, z, r: a / 100, hx: 0, hz: 0, yaw: 0 } : { x, z, r: 0, hx: a / 100, hz: b / 100, yaw });
      }
      if (!nL) lava = undefined;
    }
  }
  for (let i = 0; i < res; i++) {
    let v = 0;
    for (let j = 0; j < res; j++) {
      const k = i * res + j;
      v = (v + (p[k] | (p[N + k] << 8))) & 0xffff;
      heights[k] = (v >= 0x8000 ? v - 0x10000 : v) / 100;
    }
  }
  const t: TerrainData = {
    heights, res,
    biome: p.slice(N * 2, N * 3),
    coast: new Int8Array(p.buffer.slice(p.byteOffset + N * 3, p.byteOffset + N * 4)),
    path: p.slice(N * 4, N * 5),
    ...(lava ? { lava } : {}),
    ...(keep ? { keep } : {}),
  };
  t.hash = terrainHash(t);
  if (t.hash !== want) throw new Error(`terrain: content hash ${t.hash.toString(16)} != file ${want.toString(16)}`);
  return t;
}

// ================================================================ rocks (deterministic scatter; client renders, server collides)
/** block = tan layered sandstone course block (sea cliffs, mesa walls, sea stacks) — world-aligned, never tilted;
 * slab = the same masonry block in grey granite (inland crags, volcano-base walls); basalt = the same block in dark
 * columnar basalt (the black NW lava coast, its sea stacks);
 * boulder = rounded chunky grey rock (shore, highlands); crag = sharp dark basalt (cone rim + flanks, badlands);
 * spire = the same jagged faceted shape in grey granite (inland crags poking through the jungle, the volcano's foot);
 * shard = small obsidian splinter (badlands); tor = matte grey-brown cone rock (crater-rim teeth, rib outcrops on the
 * upper flank). "stack" is kept for old readers (stacks are built from blocks now). */
export type RockKind = "boulder" | "block" | "slab" | "basalt" | "crag" | "spire" | "stack" | "shard" | "tor";
export interface RockInstance {
  kind: RockKind;
  /** variant index 0..3 */
  v: number;
  /** centre of the rock's bounds (metres) */
  x: number; y: number; z: number;
  /** yaw radians; sx/sy/sz = size in metres (bounding extents) */
  yaw: number; sx: number; sy: number; sz: number;
  /** tilt (pitch about local x) — 0 for every block / slab */
  tilt: number;
  /** 1 = the top block of a column / stack or a deep ledge (flat turf cap — veg plants on it) */
  cap?: number;
  /** column id: every block of one cliff column / stack mass shares it → ONE collider box for the column */
  grp?: number;
  /** stacks: "basalt" = a black columnar lava-coast stack (the renderer sculpts tall courses of narrow columns) */
  style?: "basalt";
}

/** How the renderer carves cliff tiers / stack sections INTO their instance box (metres; client/src/world/terrain/rocks.ts
 * DISP_PARS): strata band thickness, groove depth, joint depth, erosion depth, per-band recess max, joint spacing, joint
 * coverage, top undulation. Shared so the colliders can sit at the carved surface's MEAN depth (± a few dm) instead of the
 * uncarved envelope. */
export const ROCK_CARVE: Record<"block" | "slab" | "basalt" | "stack", { band: number; groove: number; joint: number; erosion: number; recess: number; jointSpacing: number; jointCover: number; top: number }> = {
  // (deep 6 / 20 m erosion bulges + a lumpy top — otherwise the tiers read as boxes from the glide)
  block: { band: 1.9, groove: 0.5, joint: 0.35, erosion: 0.95, recess: 0.55, jointSpacing: 3.6, jointCover: 0.6, top: 0.55 },
  // (blocky jointed columns — shallow bedding, deep + dense vertical joints; deep per-band recesses on a rounded
  // section read as stacked tyres)
  stack: { band: 2.6, groove: 0.4, joint: 0.5, erosion: 0.8, recess: 0.45, jointSpacing: 5.5, jointCover: 0.3, top: 0.25 },
  slab: { band: 4.2, groove: 0.35, joint: 0.3, erosion: 1.0, recess: 0.5, jointSpacing: 6.0, jointCover: 0.3, top: 0.35 },
  basalt: { band: 4.0, groove: 0.2, joint: 0.45, erosion: 0.3, recess: 0.35, jointSpacing: 1.6, jointCover: 0.9, top: 0.12 },
};
/** mean inward depth of the carved wall surface (groove ≈ 0.2 × depth, half the recess, half the erosion) */
export const carveMean = (k: RockKind) => { const c = ROCK_CARVE[k as keyof typeof ROCK_CARVE]; return c ? 0.2 * c.groove + 0.5 * c.recess + 0.5 * c.erosion + 0.1 * c.joint * c.jointCover : 0; };
/** sea-stack taper (m of inset per m of height, each side): the renderer carves it continuously into every stack
 * section, and each section above starts exactly that much narrower → one smooth tapering mass */
export const STACK_TAPER = 0.025;
/** sea-stack cross-section: a rounded rectangle whose corner radius is STACK_CORNER × min(width, depth) (the renderer's
 * stack geometry — client rocks.ts COLUMN_GEO.stack, r 4.2 at a 12 m nominal size: rounded, not rectangular) */
export const STACK_CORNER = 0.18;
/** sea stacks (x, z, radius, height above water) — off the lighthouse headland's W face (seen from the cliff path) and
 * the black NW coast */
// ================================================================ cliff skins
/** One sample of a sea-cliff SKIN chain: a ray from the coastline polygon inland (origin o, unit direction n, metres),
 * the wall's foot / lip distances along the ray and their heights. The client (client/src/world/terrain/cliffskin.ts)
 * re-reads the ground profile along the ray and wraps the wall in one continuous carved rock skin; the terrain's own
 * face is pushed back behind it (render only). Collision = the heightfield itself (the skin stays within ±0.7 m of it). */
export interface SkinSample { ox: number; oz: number; nx: number; nz: number; d0: number; d1: number; h0: number; h1: number }
export interface SkinChain { pts: SkinSample[]; dark: boolean }
/** skins stay off poi-coast's LOOKOUT W face (their own grey columnar face + stair, shared/pois/lookout-baked.json):
 * the arc 132°…254° round the pad (180 = W, 270 = N) within 165 m */
const SKIN_EXCLUDE = { x: -590, z: 470, r: 165, a0: 132, a1: 254 };
let SKIN_CACHE: { hash: number | undefined; chains: SkinChain[] } | null = null;
/** the island's steep sea cliffs as continuous chains (deterministic from the heights — client + server agree) */
export function cliffSkins(t: TerrainData): SkinChain[] {
  if (SKIN_CACHE && SKIN_CACHE.hash === t.hash && t.hash !== undefined) return SKIN_CACHE.chains;
  const res = t.res, H = WORLD.HALF, C = WORLD.CELL;
  const hAt = (x: number, z: number) => {
    const fx = clamp((x + H) / C, 0, res - 1.001), fz = clamp((z + H) / C, 0, res - 1.001);
    const j = fx | 0, i = fz | 0, tx = fx - j, tz = fz - i, k = i * res + j, s = t.heights;
    const a = s[k] + (s[k + 1] - s[k]) * tx, b = s[k + res] + (s[k + res + 1] - s[k + res]) * tx;
    return a + (b - a) * tz;
  };
  const cliffy = (x: number, z: number) => { let w = 0; for (const c of CLIFF_ZONES) w = Math.max(w, 1 - smoothstep(c.w * 0.6, c.w * 1.15, dmath.hypot(x - c.x, z - c.z))); return w; };
  const poly = catmull(COAST, 6, true);
  // arc-length resample (1 m)
  const P: Pt[] = [];
  for (let a = 0; a < poly.length; a++) {
    const p = poly[a], q = poly[(a + 1) % poly.length], L = dmath.hypot(q[0] - p[0], q[1] - p[1]);
    for (let s = 0; s < L; s += 1) P.push([p[0] + (q[0] - p[0]) * s / L, p[1] + (q[1] - p[1]) * s / L]);
  }
  const n = P.length;
  const acc: Array<SkinSample | null> = new Array(n).fill(null);
  const STEP = 0.5, D0 = -50, D1 = 90, ND = Math.round((D1 - D0) / STEP) + 1;
  const prof = new Float32Array(ND);
  for (let i = 0; i < n; i++) {
    const [ox, oz] = P[i];
    if (cliffy(ox, oz) < 0.15) continue;
    const ea = dmath.atan2(oz - SKIN_EXCLUDE.z, ox - SKIN_EXCLUDE.x) * 180 / Math.PI, ang = (ea + 360) % 360;
    if (dmath.hypot(ox - SKIN_EXCLUDE.x, oz - SKIN_EXCLUDE.z) < SKIN_EXCLUDE.r && ang > SKIN_EXCLUDE.a0 && ang < SKIN_EXCLUDE.a1) continue;
    const a = P[(i + n - 3) % n], b = P[(i + 3) % n];
    let tx = b[0] - a[0], tz = b[1] - a[1]; const tl = dmath.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
    let nx = -tz, nz = tx;
    if (!inPoly(poly, ox + nx * 6, oz + nz * 6)) { nx = -nx; nz = -nz; }
    for (let k = 0; k < ND; k++) { const d = D0 + k * STEP; prof[k] = hAt(ox + nx * d, oz + nz * d); }
    // the steepest climb: the run of 4 m-window slope > 0.9 with the largest height gain, widened while slope > 0.45
    const sl = (k: number) => (prof[Math.min(ND - 1, k + 4)] - prof[Math.max(0, k - 4)]) / (STEP * (Math.min(ND - 1, k + 4) - Math.max(0, k - 4)));
    let best = -1, bk0 = 0, bk1 = 0;
    for (let k = 0; k < ND; k++) {
      if (sl(k) <= 0.9) continue;
      let k1 = k; while (k1 + 1 < ND && sl(k1 + 1) > 0.9) k1++;
      const gain = prof[k1] - prof[k];
      if (gain > best) { best = gain; bk0 = k; bk1 = k1; }
      k = k1;
    }
    if (best < 3) continue;
    while (bk0 > 0 && sl(bk0 - 1) > 0.45 && prof[bk0 - 1] > -1.5) bk0--;
    while (bk1 + 1 < ND && sl(bk1 + 1) > 0.45) bk1++;
    const h0 = Math.max(prof[bk0], -1.5), h1 = prof[bk1], Hw = h1 - h0, run = (bk1 - bk0) * STEP;
    if (Hw < 6 || h1 < 5 || run > 1.4 * Hw + 3) continue;
    acc[i] = { ox, oz, nx, nz, d0: D0 + bk0 * STEP, d1: D0 + bk1 * STEP, h0, h1 };
  }
  // chains of consecutive accepted samples (no jump of the wall line); smoothed foot / lip
  const chains: SkinChain[] = [];
  let start = 0; while (start < n && acc[start]) start++;           // begin at a gap so wrap-around chains stay whole
  let cur: SkinSample[] = [];
  const flush = () => { if (cur.length >= 10) chains.push({ pts: cur, dark: false }); cur = []; };
  for (let c = 0; c < n; c++) {
    const i = (start + c) % n, s = acc[i];
    if (!s) { flush(); continue; }
    const pv = cur[cur.length - 1];
    if (pv && (Math.abs(s.d0 - pv.d0) > 5 || Math.abs(s.h1 - pv.h1) > 6)) flush();
    cur.push(s);
  }
  flush();
  for (const ch of chains) {
    const src = ch.pts.map((q) => ({ ...q })), m = src.length;
    for (let k = 0; k < m; k++) {
      let d0 = 0, d1 = 0, h0 = 0, h1 = 0, w = 0;
      for (let o = -4; o <= 4; o++) { const q = src[Math.min(m - 1, Math.max(0, k + o))]; d0 += q.d0; d1 += q.d1; h0 += q.h0; h1 += q.h1; w++; }
      Object.assign(ch.pts[k], { d0: d0 / w, d1: d1 / w, h0: h0 / w, h1: h1 / w });
    }
    const mid = ch.pts[m >> 1], fx = mid.ox + mid.nx * mid.d0, fz = mid.oz + mid.nz * mid.d0;
    ch.dark = (dmath.hypot(fx - BADLANDS.x, fz - BADLANDS.z) < BADLANDS.r * 1.35 && badlandsAt(fx, fz) > 0.15) || dmath.hypot(fx + 700, fz + 620) < 210;
  }
  SKIN_CACHE = { hash: t.hash, chains };
  return chains;
}

export const SEA_STACKS: Array<[number, number, number, number]> = [
  // lighthouse headland W face (the biome-05 view looks across the little bay at these)
  [-718, 612, 9.5, 36], [-742, 552, 6, 22], [-752, 660, 8, 28], [-778, 604, 4.5, 13], [-724, 752, 6.5, 16], [-700, 800, 5.5, 10],
  [-800, -640, 8, 24], [-726, -752, 6.5, 18], [-852, -552, 5.5, 14], [410, 700, 5.5, 12],
  // the plane's approach side (island-03): rock stacks off the cove–harbor headland and the east beach
  [336, 712, 6, 14], [300, 690, 3.5, 7], [1004, 52, 5, 11], [990, -70, 3.5, 7], [972, 170, 4, 8],
];

/** Every rock of the island (deterministic from the terrain data — the server replays it for collision):
 *  1. cliff walls: world-aligned masonry blocks in horizontal courses (STRATA.band) placed on each
 *     course's contour wherever the ground is a steep wall (sea-cliff zones, coastal bluffs, mesa walls, inland crags);
 *     one grid of columns for all courses, so vertical joints line up and each column steps back a little;
 *  2. sea stacks: tapering, aligned columns of blocks with a flat cap; fallen blocks at the foot;
 *  3. shore boulders in groups; 4. ridge-top crags; 5. highland boulder groups; 6. badlands shards + basalt crags;
 *  7. a crag ring on the crater rim + crags along the cone's ribs; 8. grey crag towers ringing the volcano's foot. */
// memo per TerrainData + keep-out list: the client asked for the same list 3× (rocks render, veg scatter, prediction)
const ROCKS_MEMO = new WeakMap<TerrainData, { keep: RockKeep[] | undefined; n: number; rocks: RockInstance[] }>();
export function terrainRocks(t: TerrainData): RockInstance[] {
  const m = ROCKS_MEMO.get(t);
  if (m && m.keep === t.keep && m.n === (t.keep?.length ?? -1)) return m.rocks;
  const rocks = terrainRocksBuild(t);
  ROCKS_MEMO.set(t, { keep: t.keep, n: t.keep?.length ?? -1, rocks });
  return rocks;
}
/** seed the memo with a list computed elsewhere from the same bytes + keep-outs (the client's terrain worker) */
export function primeTerrainRocks(t: TerrainData, rocks: RockInstance[]) { ROCKS_MEMO.set(t, { keep: t.keep, n: t.keep?.length ?? -1, rocks }); }
function terrainRocksBuild(t: TerrainData): RockInstance[] {
  const rnd = mulberry32(WORLD.SEED + 555), out: RockInstance[] = [];
  const res = t.res, H = WORLD.HALF, C = WORLD.CELL;
  const n = new Simplex2(WORLD.SEED + 3);
  const V = VOLCANO;
  const hAt = (x: number, z: number) => {
    const fx = clamp((x + H) / C, 0, res - 1.001), fz = clamp((z + H) / C, 0, res - 1.001);
    const j = fx | 0, i = fz | 0, tx = fx - j, tz = fz - i, k = i * res + j, s = t.heights;
    const a = s[k] + (s[k + 1] - s[k]) * tx, b = s[k + res] + (s[k + res + 1] - s[k + res]) * tx;
    return a + (b - a) * tz;
  };
  const slopeAt = (x: number, z: number, e = 3) => { const dx = hAt(x + e, z) - hAt(x - e, z), dz = hAt(x, z + e) - hAt(x, z - e); return { s: dmath.hypot(dx, dz) / (2 * e), dx, dz }; };
  const nearPad = (x: number, z: number, f = 0.95) => { for (const p of POIS) { if (p.padY !== null && dmath.hypot(x - p.x, z - p.z) < p.pad * f) return true; } return false; };
  const cliffy = (x: number, z: number) => { let w = 0; for (const c of CLIFF_ZONES) w = Math.max(w, 1 - smoothstep(c.w * 0.6, c.w * 1.15, dmath.hypot(x - c.x, z - c.z))); return w; };
  const mesaW = (x: number, z: number) => { let w = 0; for (const [mx, mz, mr] of MESAS) w = Math.max(w, 1 - smoothstep(mr + 8, mr + 26, dmath.hypot(x - mx, z - mz))); return w; };
  const inApron = (x: number, z: number) => x > 420 && x < 900 && z > 170 && z < 560 && inPoly(HARBOR_APRON, x, z);
  const idx = (x: number, z: number) => clamp(Math.round((z + H) / C), 0, res - 1) * res + clamp(Math.round((x + H) / C), 0, res - 1);
  const fallsCarve = (x: number, z: number) => dmath.hypot(x + 170, z + 405) < 60 || (Math.abs(z + 400) < 40 && x > -180 && x < 300);
  const cams = Object.values(TERRAIN_CAMS).map((c) => {
    const gy = Math.max(0, hAt(c.pos[0], c.pos[2])), ty = Math.max(0, hAt(c.target[0], c.target[2]));
    const p = [c.pos[0], gy + c.pos[1], c.pos[2]], q = [c.target[0], ty + c.target[1], c.target[2]];
    const d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], L = dmath.hypot3(d[0], d[1], d[2]);
    return { p, d: d.map((v) => v / L), gy };
  });
  /** view-camera clearance (small, so foreground rubble stays in frame): nothing within CAM_KEEP_R (3 m) of the camera,
   * and nothing in the first 8 m of the central view ray whose top is above the eye (it would fill the frame) */
  const inCamKeep = (r: RockInstance) => {
    const rr = Math.max(r.sx, r.sz) * 0.5, top = r.y + r.sy * 0.5;
    for (const c of cams) {
      const dxz = dmath.hypot(r.x - c.p[0], r.z - c.p[2]) - rr;
      if (dxz < CAM_KEEP_R && top > c.p[1] - 3) return true;
      const vx = r.x - c.p[0], vy = r.y - c.p[1], vz = r.z - c.p[2], along = vx * c.d[0] + vy * c.d[1] + vz * c.d[2];
      if (along > 0 && along < 8) {
        const px = c.p[0] + c.d[0] * along, pz = c.p[2] + c.d[2] * along;
        if (dmath.hypot(r.x - px, r.z - pz) < rr + 1.5 && top > c.p[1] - 0.5) return true;
      }
    }
    return false;
  };
  // lava rivers: no rock sits in (or on the bank of) a molten channel (no crags floating on the melt)
  const lavaCells = new Set<number>();
  for (const L of lavaChannels(t)) for (let q = 0; q < L.pts.length; q += 2) {
    const [px, pz] = L.pts[q], R = L.hw[q] + 1.2;
    for (let i = Math.floor((pz - R + H) / C); i <= Math.ceil((pz + R + H) / C); i++) for (let j = Math.floor((px - R + H) / C); j <= Math.ceil((px + R + H) / C); j++) {
      if (dmath.hypot(-H + j * C - px, -H + i * C - pz) < R) lavaCells.add(i * res + j);
    }
  }
  const onLava = (r: RockInstance) => {
    if (!lavaCells.size || dmath.hypot(r.x - V.x, r.z - V.z) > 700) return false;
    const rr = Math.max(r.sx, r.sz) * 0.4;
    for (const [ox, oz] of [[0, 0], [rr, 0], [-rr, 0], [0, rr], [0, -rr]]) if (lavaCells.has(idx(r.x + ox, r.z + oz))) return true;
    return false;
  };
  // view vistas: no big rock inside the view wedge toward the subject (biome-03: the cove bay + pier, 8–45° right of
  // the camera axis within 150 m)
  const VISTAS: Array<{ id: string; a0: number; a1: number; r1: number }> = [{ id: "biome-03-highlands", a0: 6, a1: 42, r1: 150 }];
  const vistas = VISTAS.map((v) => { const c = TERRAIN_CAMS[v.id], fx = c.target[0] - c.pos[0], fz = c.target[2] - c.pos[2], fl = dmath.hypot(fx, fz); return { ...v, x: c.pos[0], z: c.pos[2], fx: fx / fl, fz: fz / fl }; });
  const inVista = (r: RockInstance) => {
    if (Math.max(r.sx, r.sy, r.sz) < 1.6) return false;
    for (const v of vistas) {
      const dx = r.x - v.x, dz = r.z - v.z, fwd = dx * v.fx + dz * v.fz, right = dx * -v.fz + dz * v.fx;   // three.js right = (−fz, fx)
      if (fwd <= 4 || dmath.hypot(dx, dz) > v.r1) continue;
      const a = dmath.atan2(right, fwd) * 180 / Math.PI;
      if (a > v.a0 && a < v.a1) return true;
    }
    return false;
  };
  const push = (r: RockInstance) => { if (!inApron(r.x, r.z) && !inCamKeep(r) && !onLava(r) && !inVista(r)) out.push(r); };

  // ---- 1. cliff walls: VERTICAL COLUMNS (not stacked cushions with a grass fringe on every course) — each wall cell
  //         along a steep face gets one column standing on the wall's foot and reaching past its top edge, built of
  //         tiers (see below), flush eroded fronts, turf only on the true top
  //         and on the odd deep ledge where the upper tiers step back. Tan sandstone on the coast, grey mossy granite on
  //         tall inland walls (cove backslope, gorge), black basalt on the lava coast.
  //         Columns share a group id (grp).
  let grpId = 1;
  /** one cliff column standing on the wall's foot (fx, fz), uphill (ux, uz), `prof` = the ground's [distance uphill from
   * the foot, height] every metre up to the top edge. The column rises in TIERS of ~9–13 m: each tier's vertical face
   * sits where the ground is ~20 % up that tier's band (so the stepped face follows the wall and the cliff edge stays
   * where the terrain's is), every tier reaches back to one plane 3 m past the top edge; a tier that steps back more
   * than 1.4 m leaves a turf ledge (cap) on the one below — planted ledges. */
  const column = (kind: RockKind, fx: number, fz: number, ux: number, uz: number, W: number, prof: Array<[number, number]>, yBot: number, yTop: number, seed: number, plinthMax: number) => {
    const yaw = dmath.atan2(-ux, -uz), c = dmath.cos(yaw), sn = dmath.sin(yaw), g = grpId++;
    const r = mulberry32(seed);
    const sTop = prof[prof.length - 1][0], back = sTop + 1.5;
    const faceAt = (y: number) => { for (const [sp, hp] of prof) if (hp >= y) return sp; return sTop; };
    // ONE instance per tier: the renderer sculpts it as a continuous rock mass (world-aligned strata grooves,
    // vertical joints, eroded silhouette — client/src/world/terrain/rocks.ts) and it is also that tier's collider box.
    // Small stacked course blocks read as Lego walls, and a union collider per column would stick out metres in front
    // of the stepped-back upper tiers.
    const emit = (lx: number, sw: number, y0: number, y1: number, zFace: number, cap: boolean) => {
      const d = back + zFace, lz = zFace - d / 2;             // zFace ≤ 0 (behind the foot); the tier reaches the back plane
      // granite faces: each tier turned a little off the wall line → a jumble of big weathered masses, not a staircase
      const jy = kind === "slab" ? (r() - 0.5) * 0.5 : 0;
      push({ kind, v: (r() * 4) | 0, x: fx + lx * c + lz * sn, y: (y0 + y1) / 2, z: fz - lx * sn + lz * c, yaw: yaw + jy,
        sx: sw, sy: y1 - y0, sz: Math.max(1.5, d), tilt: 0, cap: cap ? 1 : 0, grp: g });
    };
    // (tall tiers — 14–20 m — so a sea cliff reads as a continuous layered wall with a few planted ledges, not
    // a staircase of cubes)
    const Htot = yTop - yBot, nT = Math.max(1, Math.round(Htot / (14 + 6 * r())));
    // tier boundaries jittered ±35 % per column: neighbouring columns never line their steps up into a grid
    const cuts = [yBot]; for (let k = 1; k < nT; k++) cuts.push(yBot + Htot * (k + (r() - 0.5) * 0.7) / nT); cuts.push(yTop);
    for (let k = 0; k < nT; k++) {
      const tb = cuts[k], tt = cuts[k + 1];
      // (the face stands where the ground is 8 % up the tier's band — at 20 % the terrain's own steep face covers
      // the lower half of every tier, and the cliff reads as a smooth dirt wall with box tops sticking out)
      const sK = faceAt(tb + 0.08 * (tt - tb)), sNext = k < nT - 1 ? faceAt(tt + 0.08 * (cuts[k + 2] - tt)) : sK;
      // a ledge ≥ 2 m deep in front of the next tier carries turf (a planted ledge); otherwise bare rock
      const ledge = k < nT - 1 && sNext - sK > 2.0;
      // upper tiers start 0.6 m inside the one below (no seam), each a little narrower (a gently tapering buttress)
      emit((r() - 0.5) * 0.5, W * (1 - 0.035 * k), k === 0 ? tb : tb - 0.6, tt, -sK + (r() - 0.5) * 0.5, k === nT - 1 || ledge);
    }
    // wave-cut foot / talus plinth: a low, wider course standing a little proud of the face at the waterline
    // (on ~40 % of the columns, low and barely proud — a plinth on every column reads as a row of cubes)
    if (plinthMax > 0 && r() < 0.4) {
      const ph = 0.8 + 1.2 * r();
      emit((r() - 0.5) * 0.6, W * 1.02, yBot, yBot + ph + 2.5, -faceAt(yBot + 2.5 + ph * 0.3) + plinthMax * (0.2 + 0.25 * r()), false);
    }
  };
  // sea cliffs wrapped in a continuous SKIN (cliffSkins) get no column tiers: a spatial hash of every skin
  // sample's foot + mid-wall point
  const skinCells = new Set<number>();
  for (const ch of cliffSkins(t)) for (const q of ch.pts) for (const f of [0, 0.5, 1]) {
    const d = q.d0 + (q.d1 - q.d0) * f, x = q.ox + q.nx * d, z = q.oz + q.nz * d;
    skinCells.add(Math.floor(x / 4) * 4096 + Math.floor(z / 4));
  }
  const skinned = (x: number, z: number) => { for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) if (skinCells.has((Math.floor(x / 4) + a) * 4096 + Math.floor(z / 4) + b)) return true; return false; };
  const G = 9.6;
  // one column per stretch of wall: a candidate is dropped when an emitted column's face centre lies within 0.72 × G
  // (every cell up / down the same wall estimates the same face)
  const faces = new Map<number, Array<[number, number]>>();
  const fKey = (x: number, z: number) => Math.floor(x / 16) * 4096 + Math.floor(z / 16);
  const faceTaken = (x: number, z: number) => {
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const [qx, qz] of faces.get(fKey(x + a * 16, z + b * 16)) ?? []) if (dmath.hypot(qx - x, qz - z) < G * 0.72) return true;
    return false;
  };
  const takeFace = (x: number, z: number) => { const k = fKey(x, z); (faces.get(k) ?? faces.set(k, []).get(k)!).push([x, z]); };
  // inland crag faces: one per ~26 m of wall
  const inland = new Map<number, Array<[number, number]>>();
  const iKey = (x: number, z: number) => Math.floor(x / 32) * 4096 + Math.floor(z / 32);
  const inlandTaken = (x: number, z: number) => {
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const [qx, qz] of inland.get(iKey(x + a * 32, z + b * 32)) ?? []) if (dmath.hypot(qx - x, qz - z) < 26) return true;
    return false;
  };
  const inlandTake = (x: number, z: number) => { const k = iKey(x, z); (inland.get(k) ?? inland.set(k, []).get(k)!).push([x, z]); };
  /** ground profile uphill from (x, z): [distance, height] every metre (running max, so it never dips) */
  const profOf = (x: number, z: number, ux: number, uz: number, len: number): Array<[number, number]> => {
    const out: Array<[number, number]> = []; let mx = -1e9;
    for (let s2 = 0; s2 <= len; s2 += 1) { mx = Math.max(mx, hAt(x + ux * s2, z + uz * s2)); out.push([s2, mx]); }
    return out;
  };
  for (let m = 0; (-H + 30 + m * G) < H - 30; m++) for (let n = 0; (-H + 30 + n * G) < H - 30; n++) {
    const gx = -H + 30 + n * G, gz = -H + 30 + m * G, ci = n, cj = m;
    const cx = gx + (hash2(ci, cj, 11) - 0.5) * G * 0.3, cz = gz + (hash2(ci, cj, 12) - 0.5) * G * 0.3;
    const h0 = hAt(cx, cz);
    if (h0 < -1 || h0 > 150) continue;
    const vr = dmath.hypot(cx - V.x, cz - V.z);
    if (vr < V.cone + 25 || fallsCarve(cx, cz) || nearPad(cx, cz, 1.0)) continue;
    const sl = slopeAt(cx, cz, 4);
    if (sl.s < 0.75) continue;
    const k0 = idx(cx, cz);
    if (t.path[k0] > 30) continue;
    const coast = t.coast[k0];
    const cw = cliffy(cx, cz), mw = mesaW(cx, cz);
    const coastal = 1 - smoothstep(50, 140, coast);
    const inland = smoothstep(1.0, 1.4, sl.s) * smoothstep(8, 16, h0);
    const zone = Math.max(cw, 0.8 * coastal, mw, 0.85 * inland);
    if (zone < 0.32) continue;
    const gl = dmath.hypot(sl.dx, sl.dz) || 1, ux = sl.dx / gl, uz = sl.dz / gl;       // uphill unit vector
    // black basalt on the lava coast: the badlands fan + the whole black NW coast around it (no tan sandstone
    // columns right beside the black lava field)
    const dark = (dmath.hypot(cx - BADLANDS.x, cz - BADLANDS.z) < BADLANDS.r * 1.35 && badlandsAt(cx, cz) > 0.15) || dmath.hypot(cx + 700, cz + 620) < 210;
    const tan = !dark && (cw > 0.35 || coastal > 0.5);
    if (dark && (cw < 0.35 || coast > 60)) continue;   // black columns only on the lava sea cliffs; inland the crust stays open
    // the wall's extent along the fall line through the cell: foot and top edge where the slope over an 8 m window
    // (terrace ledges average out) eases below 0.32; the foot also stops at the waterline
    const wsl = (x: number, z: number) => (hAt(x + ux * 4, z + uz * 4) - hAt(x - ux * 4, z - uz * 4)) / 8;
    let fs = 0; for (let st = 1.5; st <= 60; st += 1.5) { const qx = cx - ux * st, qz = cz - uz * st; if (hAt(qx, qz) < -1.5 || wsl(qx, qz) < 0.32) break; fs = st; }
    let ts = 0; for (let st = 1.5; st <= 60; st += 1.5) { if (wsl(cx + ux * st, cz + uz * st) < 0.32) break; ts = st; }
    const fx = cx - ux * fs, fz = cz - uz * fs, tx = cx + ux * ts, tz = cz + uz * ts;
    const hf = Math.max(hAt(fx, fz), -1.5), ht = hAt(tx, tz), Hw = ht - hf;
    const seed = (hash2(ci, cj, 50) * 4294967296) >>> 0;
    if (!dark && !tan) {
      // inland: only REAL walls (> ~48° over the whole face, ≥ 10 m tall) get grey mossy granite faces — columns on
      // every steep bank make the island read as a grey box city from the air; short steep banks → a few
      // half-buried boulders
      if (Hw >= 9 && sl.s > 1.0 && Hw / Math.max(1, fs + ts) > 0.95) {
        // FEW, BIG features (not grey dice scattered on bald slopes): one per ~26 m of real wall; the slope between
        // them is jungle floor + turf (data.ts).
        if (inlandTaken(fx, fz)) continue; inlandTake(fx, fz);
        // a rock OUTCROP (granite slab columns read as mossy crates from the glide) — a lead
        // boulder sized to the wall (7–16 m) and 1–2 companions along the face, half-buried in the slope, chunky
        // chiselled mossy granite like the highlands; jungle floor + turf between them (data.ts)
        const tx2 = -uz, tz2 = ux;                                          // along the wall
        const nB = 1 + (hash2(ci, cj, 23) < 0.7 ? 1 : 0) + (hash2(ci, cj, 24) < 0.35 ? 1 : 0);
        for (let q = 0; q < nB; q++) {
          const s2 = Math.min(16, Math.max(6, Hw * 0.75)) * (q === 0 ? 1 : 0.5 + 0.3 * hash2(ci + q, cj, 25));
          const along = q === 0 ? 0 : (q === 1 ? 1 : -1) * (0.45 + 0.25 * hash2(ci, cj + q, 26)) * s2 * 1.4;
          const up = 0.35 + 0.3 * hash2(ci + q, cj, 27);                    // how far up the face (fraction of its run)
          const bx = fx + ux * (fs + ts) * up + tx2 * along, bz = fz + uz * (fs + ts) * up + tz2 * along;
          const sy = s2 * (0.62 + 0.2 * hash2(ci, cj + q, 28));
          // centred on the face, a little proud of it: the uphill half is inside the hill, the downhill face stands out
          push({ kind: "boulder", v: (hash2(ci + q, cj, 29) * 4) | 0, x: bx - ux * s2 * 0.08, y: hAt(bx, bz) + sy * 0.12, z: bz - uz * s2 * 0.08,
            yaw: dmath.atan2(-ux, -uz) + (hash2(ci, cj + q, 30) - 0.5) * 0.8, sx: s2 * (1.05 + 0.25 * hash2(ci + q, cj, 31)), sy, sz: s2 * 0.85, tilt: (hash2(ci, cj + q, 32) - 0.5) * 0.25 });
        }
      } else if (hash2(ci, cj, 21) < 0.2) {
        const s2 = 1.6 + 2.6 * hash2(ci, cj, 22), sy = s2 * 0.7;
        push({ kind: "boulder", v: (hash2(ci, cj, 25) * 4) | 0, x: cx, y: h0 + sy * (0.5 - 0.4), z: cz, yaw: hash2(ci, cj, 26) * 6.283, sx: s2 * 1.2, sy, sz: s2, tilt: (hash2(ci, cj, 28) - 0.5) * 0.2 });
      }
      continue;
    }
    // only real faces: steeper than ~40° over the whole wall (tiers on hillsides read as box piles)
    if (Hw < 5 || Hw / Math.max(1, fs + ts) < 0.85) continue;
    const kind: RockKind = dark ? "basalt" : "block";
    // wide, overlapping columns with shallow set-backs → one continuous eroded wall, not rows of tan cubes; only ~12 %
    // clefts (more clefts set 3–4.5 m back leave gaps showing box sides)
    const cleft = hash2(ci, cj, 40) < 0.12;
    if (skinned(fx, fz) || skinned(cx, cz)) continue;
    if (faceTaken(fx, fz)) continue; takeFace(fx, fz);
    // per column: set back 0–1.6 m (clefts 3–4.5 m) — the foot point moves uphill, the profile is re-read from there
    const sb = cleft ? 1.5 + 1.0 * hash2(ci, cj, 41) : hash2(ci, cj, 13) * 0.9, px = fx + ux * sb, pz = fz + uz * sb;
    const W = G * (1.45 + 0.55 * hash2(ci, cj, 14)) * (cleft ? 0.75 : 1);
    // tops sit just under the plateau's edge (the grass meets the capstone; nothing sticks up as a raised strip), a
    // little lower on clefts → a stepped skyline
    // (the turf runs to the edge over them, no box lids)
    const yTop = ht - 1.1 - 0.9 * hash2(ci, cj, 17) - (cleft ? 1.0 : 0);
    column(kind, px, pz, ux, uz, W, profOf(px, pz, ux, uz, Math.max(2, fs + ts - sb)), Math.min(hAt(px, pz), hf + 1) - 2.5, yTop, seed, coast < 30 ? 3 : 1.5);
    // fallen blocks on the talus / in the surf at the foot
    if (hash2(ci, cj, 60) < 0.45) {
      const a2 = hash2(ci, cj, 61) * 6.283, s2 = 1.4 + 2.2 * hash2(ci, cj, 62), bx = fx - ux * (2 + 4 * hash2(ci, cj, 63)) + dmath.cos(a2) * 2, bz = fz - uz * (2 + 4 * hash2(ci, cj, 63)) + dmath.sin(a2) * 2;
      push({ kind, v: (hash2(ci, cj, 64) * 4) | 0, x: bx, y: hAt(bx, bz) + s2 * 0.25, z: bz, yaw: hash2(ci, cj, 65) * 6.283, sx: s2 * 1.3, sy: s2 * 0.8, sz: s2, tilt: (hash2(ci, cj, 66) - 0.5) * 0.3 });
    }
  }

  // ---- 2. sea stacks: 1–2 tall masses per stack with strata lines and a mossy cap,
  //         each 2–4 SECTIONS (one instance each, sculpted by the renderer as one rounded,
  //         strata-grooved mass; sections overlap 0.8 m so the mass is continuous), a gentle taper with one stepped-in
  //         shoulder, a turf cap; rounded fallen boulders in the surf at the foot
  for (const [x, z, r, hh] of SEA_STACKS) {
    const dark = dmath.hypot(x - BADLANDS.x, z - BADLANDS.z) < 320;
    const yaw0 = rnd() * Math.PI, ca = dmath.cos(yaw0), sa = dmath.sin(yaw0);
    const base = Math.min(hAt(x, z), -2) - 1.5;
    const nM = r > 7 ? 2 : 1;
    for (let mi = 0; mi < nM; mi++) {
      // ONE mass per instance, sculpted on the client as
      // a unique mesh (client/src/world/terrain/stackgeo.ts: courses of jointed blocks, bulges, a wave-cut notch, a rounded
      // domed top) — box tiers per mass read as stacked boxes with lids. Slender: height ≈ 3 × width.
      const lat = nM === 2 ? (mi - 0.5) * r * 0.9 : 0, cxm = x + ca * lat, czm = z - sa * lat;
      const top = hh * (mi === 0 ? 1 : 0.55 + 0.25 * rnd()), Wm = r * (nM === 2 ? 1.25 : 1.7), Dm = r * (nM === 2 ? 1.4 : 1.55);
      const yaw = yaw0 + (rnd() - 0.5) * 0.5;
      push({ kind: "stack", v: (rnd() * 4) | 0, x: cxm, y: (base + top) / 2, z: czm, yaw, sx: Wm, sy: top - base, sz: Dm, tilt: 0, cap: 1, grp: grpId++, ...(dark ? { style: "basalt" as const } : {}) });
    }
    for (let b2 = 0; b2 < 5; b2++) {
      const a = rnd() * 6.283, dd = r * 1.1 + 2 + rnd() * 7, s2 = 1.6 + rnd() * 3.2;
      const bx = x + dmath.cos(a) * dd, bz = z + dmath.sin(a) * dd, sy = s2 * 0.72;
      out.push({ kind: dark ? "crag" : "boulder", v: (rnd() * 4) | 0, x: bx, y: Math.max(hAt(bx, bz) + sy * 0.3, -sy * 0.15), z: bz, yaw: rnd() * 6.283, sx: s2 * 1.25, sy, sz: s2, tilt: (rnd() - 0.5) * 0.25 });
    }
  }

  const group = (kind: RockKind, cxx: number, czz: number, nB: number, s0: number, s1: number, spread: number, bury: number) => {
    for (let c = 0; c < nB; c++) {
      const ox = c === 0 ? 0 : (rnd() - 0.5) * spread, oz = c === 0 ? 0 : (rnd() - 0.5) * spread;
      const bx = cxx + ox, bz = czz + oz;
      if (t.path[idx(bx, bz)] > 30) continue;
      const s = (c === 0 ? s1 : s0 + (s1 - s0) * rnd() * rnd()) * (0.85 + 0.3 * rnd());
      const sy = s * 0.72; // `bury` = fraction of the rock's height below the ground (downhill side shows more)
      push({ kind, v: (rnd() * 4) | 0, x: bx, y: hAt(bx, bz) + sy * (0.5 - bury), z: bz, yaw: rnd() * 6.283, sx: s * (0.85 + 0.4 * rnd()), sy, sz: s * (0.85 + 0.4 * rnd()), tilt: (rnd() - 0.5) * 0.25 });
    }
  };
  const step = 6;
  const lavaNear = lavaNearMask(res, lavaChannels(t), 12);
  for (let z = -H + 40; z < H - 40; z += step) for (let x = -H + 40; x < H - 40; x += step) {
    const jx = x + (rnd() - 0.5) * step, jz = z + (rnd() - 0.5) * step;
    const h = hAt(jx, jz), k = idx(jx, jz);
    const coast = t.coast[k], pathW = t.path[k] / 255, sl = slopeAt(jx, jz);
    if (pathW > 0.05 || nearPad(jx, jz) || fallsCarve(jx, jz)) continue;
    const cw = cliffy(jx, jz);
    const cl = n.fbm(jx / 90, jz / 90, 3); // clustering
    const vr = dmath.hypot(jx - V.x, jz - V.z), bd = dmath.hypot(jx - BADLANDS.x, jz - BADLANDS.z);
    const lagoon = t.biome[k] === Biome.Lagoon || dmath.hypot(jx - 430, jz + 350) < 230;
    // 3. shore boulders in groups (in the shallows & on the beach line) — dense on cliffy / headland coasts
    if (coast > -50 && coast < 12 && h > -6 && !lagoon) {
      const headland = smoothstep(-0.05, 0.35, n.fbm(jx / 140 + 20, jz / 140, 3));
      // the SW lighthouse headland + W coast: dozens of big rounded grey boulders in the shallows
      const sw = Math.max(1 - smoothstep(170, 280, dmath.hypot(jx + 640, jz - 590)),
        jx < -740 && Math.abs(jz - 90) > 120 && jz < 330 && jz > -420 ? 1 : 0) * smoothstep(12, -4, coast);
      const p = (0.012 + 0.2 * cw + 0.08 * headland + 0.16 * sw) * (0.5 + 0.5 * cl);
      if (rnd() < p) {
        const dark = bd < BADLANDS.r * 1.4;
        group(dark ? "crag" : "boulder", jx, jz, 1 + ((rnd() * 4) | 0), 1.4 + 1.2 * sw, 2.4 + rnd() * 6 * (0.4 + cw) + 3 * sw * rnd(), 7 + 4 * sw, 0.32);
        continue;
      }
    }
    // 4. ridge-top outcrops: clusters of big rounded grey boulders on the highland crests (rocky knolls)
    if (h > 26 && t.biome[k] !== Biome.Cinder && coast > 50 && vr > V.cone + 40) {
      const crest = h - (hAt(jx + 10, jz) + hAt(jx - 10, jz) + hAt(jx, jz + 10) + hAt(jx, jz - 10)) * 0.25;
      if (crest > 0.8 && rnd() < 0.2 * smoothstep(0.8, 2.4, crest)) {
        group("boulder", jx, jz, 2 + ((rnd() * 4) | 0), 1.2, 3.5 + rnd() * 3.5, 9, 0.36);
        continue;
      }
    }
    // 5. badlands: half-buried clusters of 3–8 glossy basalt blocks (one material), a few obsidian splinters between them,
    //    and now and then a big basalt outcrop — 5–15 clusters per 50 m square (biome-04's foreground rubble)
    if (bd < BADLANDS.r * 1.2 && h > 0.5 && badlandsAt(jx, jz) > 0.2 && kipukaAt(jx, jz) < 0.5) {
      // (sparse, many of them big — a few hero obsidian heaps, not gravel; most heaps gather along the rivers + vents,
      // 5b below)
      if (rnd() < 0.04 * (0.55 + 0.45 * cl)) {
        const big = rnd() < 0.2;
        group("crag", jx, jz, big ? 2 + ((rnd() * 3) | 0) : 3 + ((rnd() * 6) | 0), big ? 1.6 : 0.6, big ? 5 + rnd() * 4 : 1.8 + rnd() * 2.2, big ? 9 : 5.5, 0.38);
        if (rnd() < 0.5) {
          const a = rnd() * 6.283, dd = 2 + rnd() * 3, s = 0.6 + rnd() * 1.1;
          push({ kind: "shard", v: (rnd() * 4) | 0, x: jx + dmath.cos(a) * dd, y: hAt(jx + dmath.cos(a) * dd, jz + dmath.sin(a) * dd) + s * 0.25, z: jz + dmath.sin(a) * dd, yaw: rnd() * 6.283, sx: s, sy: s * 1.4, sz: s * 0.8, tilt: (rnd() - 0.5) * 0.5 });
        }
      }
      // loose RUBBLE (so the midground is no empty plain) — 0.3–1.1 m angular basalt blocks scattered
      // over the field, 3× denser within ~12 m of a lava river; sub-collider
      // size, drawn only near (the rock rings cull < 1.2 m beyond ~100 m)
      if (rnd() < (lavaNear[k] ? 0.6 : 0.2)) {
        const nR = 1 + ((rnd() * (lavaNear[k] ? 4 : 2.5)) | 0);
        for (let c = 0; c < nR; c++) {
          const bx = jx + (rnd() - 0.5) * 5.5, bz = jz + (rnd() - 0.5) * 5.5, s = 0.3 + 0.8 * rnd() * rnd(), sy = s * (0.55 + 0.3 * rnd());
          push({ kind: "crag", v: (rnd() * 4) | 0, x: bx, y: hAt(bx, bz) + sy * 0.18, z: bz, yaw: rnd() * 6.283, sx: s * (0.9 + 0.4 * rnd()), sy, sz: s * (0.8 + 0.3 * rnd()), tilt: (rnd() - 0.5) * 0.5 });
        }
      }
      continue;
    }
    // 6. tors on the upper cone flank: chunky outcrops of the cone's own rock along the ribs between gullies, denser
    //    toward the rim (they break the silhouette into a jagged cone)
    if (vr > V.crater + 14 && vr < V.cone + 30 && h > V.coneH - 10) {
      // the buttress spurs' crests carry jagged crags (tall, tilted, half-buried) — they break the cone's
      // silhouette; elsewhere only a sparse scatter of small outcrops on the ribs (not a regular field of dice)
      // spur crests: SPARSE chunky outcrops of mixed size (one per cell along every crest makes a
      // regular dinosaur-plate row of shark fins on the silhouette)
      const sp = coneSpur(jx, jz);
      if (sp.crest > 0.5 && rnd() < 0.06 * sp.crest) {
        const s = 4 + rnd() * rnd() * 9 + 3 * sp.crest;
        const sy = s * (1.2 + 0.6 * rnd());
        push({ kind: "tor", v: (rnd() * 4) | 0, x: jx, y: h + sy * (0.5 - 0.45), z: jz, yaw: rnd() * 6.283, sx: s * (0.85 + 0.3 * rnd()), sy, sz: s * (0.8 + 0.3 * rnd()), tilt: (rnd() - 0.5) * 0.3 });
        continue;
      }
      const rib = coneGully(jx, jz) < 0.8;
      const hi = smoothstep(V.cone, V.crater + 30, vr);
      if (rib && rnd() < (0.006 + 0.014 * hi) * smoothstep(0.4, 1.1, sl.s) * (0.6 + 0.4 * cl)) {
        const s = 2.5 + rnd() * 4 + 2 * hi, sy = s * (0.7 + 0.6 * rnd());
        push({ kind: "tor", v: (rnd() * 4) | 0, x: jx, y: h + sy * (0.5 - 0.42), z: jz, yaw: rnd() * 6.283, sx: s * 1.1, sy, sz: s * 0.85, tilt: (rnd() - 0.5) * 0.25 });
      }
      continue;
    }
    // 7. highland boulder groups (grass, gentle slopes) — chunky grey, half-buried, lichen
    if ((t.biome[k] === Biome.Grass || t.biome[k] === Biome.Jungle) && h > 5 && sl.s > 0.03 && sl.s < 0.8 && coast > 30) {
      // (sparse on jungle floor — under the canopy they cost draws and read as grey dots from the air)
      const p = 0.16 * smoothstep(-0.15, 0.45, cl) * (t.biome[k] === Biome.Grass ? 1 : 0.08);
      if (rnd() < p) group("boulder", jx, jz, 2 + ((rnd() * rnd() * 6) | 0), 0.7, 1.8 + rnd() * rnd() * 4.5, 10, 0.34);
    }
  }
  // 5b. HEAPS of
  //     glossy black basalt (one lead block 2.5–4 m, a few 1.2–2.4 m, many 0.5–1.1 m, half-buried, spilling down-slope)
  //     every 25–45 m along the lava rivers out in the field, on alternating banks just outside the levees, and a bigger
  //     heap round every field vent (a river's source out in the field)
  {
    const heap = (hx: number, hz: number, nR: number, lead: number) => {
      for (let c = 0; c < nR; c++) {
        const big = c === 0, mid = c > 0 && c < 4;
        const s = big ? lead : mid ? 1.2 + 1.2 * rnd() : 0.5 + 0.6 * rnd();
        const a = rnd() * 6.283, dd = big ? 0 : (0.45 + 0.55 * Math.sqrt(rnd())) * (lead * 0.9 + 1.6);
        const bx = hx + dmath.cos(a) * dd, bz = hz + dmath.sin(a) * dd, sy = s * (0.6 + 0.25 * rnd());
        push({ kind: "crag", v: (rnd() * 4) | 0, x: bx, y: hAt(bx, bz) + sy * (0.5 - (big ? 0.34 : 0.3 + 0.12 * rnd())), z: bz, yaw: rnd() * 6.283, sx: s * (0.9 + 0.35 * rnd()), sy, sz: s * (0.8 + 0.3 * rnd()), tilt: (rnd() - 0.5) * 0.4 });
      }
    };
    for (const L of lavaChannels(t)) {
      const P = L.pts; if (P.length < 20) continue;
      const [sx, sz] = P[0];
      if (dmath.hypot(sx - V.x, sz - V.z) > V.cone + 30 && badlandsAt(sx, sz) > 0.3) heap(sx + (rnd() - 0.5) * 4, sz + (rnd() - 0.5) * 4, 10 + ((rnd() * 6) | 0), 3.2 + rnd());
      let next = 12 + rnd() * 20, side = rnd() < 0.5 ? -1 : 1, acc = 0;
      for (let q = 1; q < P.length - 2; q++) {
        acc += dmath.hypot(P[q][0] - P[q - 1][0], P[q][1] - P[q - 1][1]);
        if (acc < next) continue;
        next = acc + 25 + 20 * rnd();
        const [px, pz] = P[q], [qx, qz] = P[Math.min(P.length - 1, q + 3)], tl = dmath.hypot(qx - px, qz - pz) || 1;
        if (dmath.hypot(px - V.x, pz - V.z) < V.cone + 25 || badlandsAt(px, pz) < 0.35 || rnd() < 0.3) continue;
        side = rnd() < 0.7 ? -side : side;
        const off = L.hw[q] + 4.2 + 1.2 * L.hw[q] + 2.5 * rnd();
        heap(px - (qz - pz) / tl * off * side, pz + (qx - px) / tl * off * side, 5 + ((rnd() * 9) | 0), 2.3 + 1.6 * rnd());
      }
    }
  }
  // 7b. the banana ridge's boulder fields (biome-03): grey rounded boulders in groups down both flanks of the crest trail
  {
    const R = RIDGES.find((r) => r.id === "banana")!, pts = R.pts.map((p) => [p[0], p[1]] as Pt);
    const L = polyLen(pts);
    for (let d = 20; d < L - 30; d += 7) {
      const [px, pz] = polyAt(pts, d);
      for (const side of [-1, 1]) {
        if (rnd() < 0.45) continue;
        const [qx, qz] = polyAt(pts, d + 4), tx = qx - px, tz = qz - pz, tl = dmath.hypot(tx, tz) || 1;
        const off = side * (12 + rnd() * 55), bx = px - (tz / tl) * off, bz = pz + (tx / tl) * off;
        const k = idx(bx, bz);
        if (t.path[k] > 20 || t.biome[k] !== Biome.Grass || hAt(bx, bz) < 8 || nearPad(bx, bz)) continue;
        group("boulder", bx, bz, 1 + ((rnd() * 4) | 0), 0.8, 1.6 + rnd() * 3.2, 7, 0.34);
      }
    }
  }
  // 8. the crater rim: broken clusters of jagged tors of mixed size with wide gaps (an eroded lip whose teeth break the
  //    cone's silhouette — never a regular crown of spikes)
  // 7 irregular clusters at uneven bearings (none in the breach notch), each
  // 2–5 outcrops of very mixed size, 35–55 % of their height sunk into the lip, long axis along the rim
  {
    let a = rnd() * 6.283;
    for (let c = 0; c < 7; c++) {
      a += 0.45 + rnd() * 0.75;
      if (Math.abs(angD(a, CRATER_BREACH)) < 0.35) continue;
      const nC = 2 + ((rnd() * 4) | 0);
      for (let q = 0; q < nC; q++) {
        // (the lead crag of every cluster is a 9–16 m jagged peak — a broken, toothed summit skyline)
        const aa = a + (rnd() - 0.5) * 0.22, rr = V.crater + 1 + rnd() * 9, x = V.x + dmath.cos(aa) * rr, z = V.z + dmath.sin(aa) * rr;
        const s2 = (q === 0 ? 10 + 6 * rnd() : 3.5 + rnd() * rnd() * 7), sy = s2 * (1.0 + 0.5 * rnd()), bury = q === 0 ? 0.3 + 0.1 * rnd() : 0.35 + 0.2 * rnd();
        push({ kind: "tor", v: (rnd() * 4) | 0, x, y: hAt(x, z) + sy * (0.5 - bury), z, yaw: aa + Math.PI / 2 + (rnd() - 0.5) * 0.7, sx: s2 * (0.75 + 0.4 * rnd()), sy, sz: s2 * (0.7 + 0.35 * rnd()), tilt: (rnd() - 0.5) * 0.35 });
      }
    }
  }
  // 8b. big carved crag MASSES on the cone's buttress spurs (a crag skyline): one 18–28 m jagged
  //     peak per major spur (mid-flank, on its crest) with 1–2 smaller teeth beside it — they break the smooth cone line
  //     into rocky shoulders
  for (const [sa, , sh, r0, r1] of CONE_SPURS) {
    if (sh < 11) continue;
    for (let q = 0; q < 3; q++) {
      const rr = lerp(r0 + 40, r1 - 45, q === 0 ? 0.45 + 0.2 * rnd() : rnd()), aa = sa + (q === 0 ? 0 : (rnd() - 0.5) * 0.12);
      const x = V.x + dmath.cos(aa) * rr, z = V.z + dmath.sin(aa) * rr;
      // (tall, slim jagged crags, 35 % buried — sculptPeak is a pointed pyramid with arêtes)
      const s2 = q === 0 ? 18 + 8 * rnd() : 8 + 5 * rnd(), sy = s2 * (1.05 + 0.35 * rnd());
      push({ kind: "tor", v: (rnd() * 4) | 0, x, y: hAt(x, z) + sy * (0.5 - 0.35), z, yaw: aa + Math.PI / 2 + (rnd() - 0.5) * 0.5, sx: s2 * (0.8 + 0.3 * rnd()), sy, sz: s2 * (0.65 + 0.25 * rnd()), tilt: (rnd() - 0.5) * 0.2 });
    }
  }
  // 9. jagged crag faces ringing the volcano's foot (rock pinnacles around the cone) — FEW and
  //    BIG (14–24 m jointed crag masses, 1–2 per cluster, well apart), not a ring of scattered grey dice
  for (let a = 0; a < 6.283; a += 0.38 + rnd() * 0.3) {
    const rr = V.cone + 10 + rnd() * 45, x = V.x + dmath.cos(a) * rr, z = V.z + dmath.sin(a) * rr;
    if (fallsCarve(x, z) || nearPad(x, z) || badlandsAt(x, z) > 0.3 || rnd() < 0.35) continue;
    if (t.path[idx(x, z)] > 20) continue;
    const nC = 1 + (rnd() < 0.4 ? 1 : 0);
    for (let q = 0; q < nC; q++) {
      const bx = x + (rnd() - 0.5) * 14, bz = z + (rnd() - 0.5) * 14, s2 = (q === 0 ? 14 : 8) + rnd() * 9;
      push({ kind: "spire", v: (rnd() * 4) | 0, x: bx, y: hAt(bx, bz) + s2 * 0.2, z: bz, yaw: rnd() * 6.283, sx: s2 * 0.85, sy: s2 * (1.1 + 0.5 * rnd()), sz: s2 * 0.7, tilt: (rnd() - 0.5) * 0.15 });
    }
  }
  // 10. view dressing (camera-relative, composed for the frame): biome-03's big grey boulders along the
  //     crest trail (left) and a few down the grass flank (right, below the line of sight to the bay)
  const dress = (id: string, list: Array<[number, number, number, number]>, kind: RockKind = "boulder", cluster = 0) => {
    const c = TERRAIN_CAMS[id]; if (!c) return;
    const fx = c.target[0] - c.pos[0], fz = c.target[2] - c.pos[2], fl = dmath.hypot(fx, fz), ux = fx / fl, uz = fz / fl;
    for (const [fwd, right, sz, bury] of list) {
      const x = c.pos[0] + ux * fwd - uz * right, z = c.pos[2] + uz * fwd + ux * right;
      if (t.path[idx(x, z)] > 20) continue;
      if (cluster) group(kind, x, z, cluster + ((rnd() * 3) | 0), sz * 0.35, sz, sz * 1.6, bury);
      else { const sy = sz * 0.72; push({ kind, v: (rnd() * 4) | 0, x, y: hAt(x, z) + sy * (0.5 - bury), z, yaw: rnd() * 6.283, sx: sz * (0.9 + 0.35 * rnd()), sy, sz: sz * (0.85 + 0.3 * rnd()), tilt: (rnd() - 0.5) * 0.2 }); }
    }
  };
  dress("biome-03-highlands", [
    // beyond the trail (it runs ~12–16 m left of the camera axis, then away): big grey boulders on the crest side
    [9, -19, 2.4, 0.3], [14, -22, 4.6, 0.34], [22, -25, 5.8, 0.36], [31, -27, 3.0, 0.32],
    // between the trail and the camera axis
    [10, -4.5, 2.2, 0.32], [17, -5.5, 3.4, 0.34], [26, -7, 2.6, 0.32],
    // down the flank to the right, low and small so the bay + pier stay in view (a 4 m boulder at (20, 13) would hide
    // the pier)
    [7, 5, 1.4, 0.3], [11, 12, 1.8, 0.36], [26, 26, 2.6, 0.4],
  ]);
  // biome-04: heaps of glossy black basalt blocks in the foreground either side of the lava river
  // (big hero outcrops framing both sides of the view: black boulders at the frame edges)
  dress("biome-04-volcanic", [
    [8, -8, 3.6, 0.3], [13, -15, 4.6, 0.32], [22, -11, 2.6, 0.3], [30, -21, 4.2, 0.32], [10, 11, 3.8, 0.3], [18, 17, 4.4, 0.32],
    [28, 13, 2.4, 0.3], [40, -4, 2.8, 0.3], [46, 22, 3.8, 0.32], [60, -30, 5.0, 0.34], [70, 30, 4.4, 0.34],
  ], "crag", 3);
  // 11. open-world COVER along the rotation network: every 20–26 m along each road /
  // trail outside the POIs, alternating sides 3–7 m off the ribbon's edge, a cover cluster unless hard rock cover already
  // stands within 9 m — one big chest-to-head-high rock (collider top 1.3–1.9 m over the ground: a kong ducks behind it)
  // plus 1–2 small ones; boulders in the green, jagged crags on the volcano / badlands ground, now and then a low ruined
  // wall of 2–3 grey granite blocks. Own RNG (appended last: every earlier rock keeps its seed / place).
  {
    const cr = mulberry32(WORLD.SEED + 9091);
    // cover must hide a whole kong: ≥ 1.6 m above the feet and ≥ 0.9 m wide
    const isCover = (q: RockInstance) => q.sy >= 2.1 && Math.min(q.sx, q.sz) >= 1.2;
    const tall: RockInstance[] = out.filter(isCover);
    const cell = 12, grid = new Map<number, RockInstance[]>();
    const gk = (x: number, z: number) => Math.floor(x / cell) * 100003 + Math.floor(z / cell);
    const add = (q: RockInstance) => { const k = gk(q.x, q.z); (grid.get(k) ?? grid.set(k, []).get(k)!).push(q); };
    for (const q of tall) add(q);
    // an existing rock counts only if it hides a kong standing at trail level gy (collider top ≥ gy + 1.6, foot ≤ gy + 1)
    let coverY = 0;
    const coverNear = (x: number, z: number, r: number) => {
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const q of grid.get(gk(x + a * cell, z + b * cell)) ?? [])
        if (dmath.hypot(q.x - x, q.z - z) < r + Math.max(q.sx, q.sz) * 0.4 && q.y + q.sy * 0.43 >= coverY + 1.6 && q.y - q.sy * 0.43 <= coverY + 1.0) return true;
      return false;
    };
    const inPoiR = (x: number, z: number) => POIS.some((p) => dmath.hypot(x - p.x, z - p.z) < p.r * 0.9);
    const inKeepXZ = (x: number, z: number, m: number) => {
      for (const c of t.keep ?? []) {
        const dx = x - c.x, dz = z - c.z;
        if (c.r > 0) { if (dx * dx + dz * dz < dmath.pow(c.r + m, 2)) return true; continue; }
        const cy = dmath.cos(c.yaw), sy = dmath.sin(c.yaw), lx = dx * cy + dz * sy, lz = -dx * sy + dz * cy;
        if (Math.abs(lx) < c.hx + m && Math.abs(lz) < c.hz + m) return true;
      }
      return false;
    };
    for (const P of [...pathLines(), ...ROT_COVER.map((pts) => ({ id: "cover", pts, w: 0 }))]) {
      const L = polyLen(P.pts); let side = cr() < 0.5 ? -1 : 1;
      for (let d = 8 + cr() * 8; d < L - 6; d += (P.w ? 15 : 13) + cr() * 5) {   // a piece every 13–20 m
        const [px, pz] = polyAt(P.pts, d), [qx, qz] = polyAt(P.pts, Math.min(L, d + 3)), tl = dmath.hypot(qx - px, qz - pz) || 1;
        side = cr() < 0.75 ? -side : side;
        const o0 = P.w + 5.5 + cr() * 4, gP = hAt(px, pz); coverY = gP;
        // the rock's size decides how far off every painted ribbon it must stand: the road filter below drops a
        // loose rock within 0.45 × size + 1.2 m of a ribbon — a 3–5 m cover boulder placed closer would be silently removed
        const sz0 = 3.2 + cr() * 1.5, rrN = sz0 * 1.3 * 0.45 + 1.3;
        const nearRibbon = (x: number, z: number) => { if (t.path[idx(x, z)] >= 60) return true; for (let a = 0; a < 8; a++) if (t.path[idx(x + dmath.cos(a * Math.PI / 4) * rrN, z + dmath.sin(a * Math.PI / 4) * rrN)] >= 60) return true; return false; };
        // the preferred side, else the other one (a POI clearing / the lagoon / a slope on one side of the trail);
        // on the SAME level as the trail (±1 m): a boulder 4 m down the bank hides nobody standing on the trail — try
        // the offset, then closer / further on both sides
        let bx = 0, bz = 0, h = 0, why = "";
        const tryAt = (sd: number, o: number) => {
          const off = sd * o; bx = px - ((qz - pz) / tl) * off; bz = pz + ((qx - px) / tl) * off; h = hAt(bx, bz);
          why = h < -1.1 ? "water" : inPoiR(bx, bz) ? "poi" : nearPad(bx, bz, 1.05) ? "pad" : inApron(bx, bz) ? "apron" : coverNear(bx, bz, 9) ? "near" : fallsCarve(bx, bz) ? "falls" : slopeAt(bx, bz).s > 0.6 ? "slope" : t.path[idx(bx, bz)] > 20 ? "path" : inKeepXZ(bx, bz, 2.5) ? "keep" : Math.abs(h - gP) > 1.0 ? "level" : nearRibbon(bx, bz) ? "ribbon" : "";
          return !why || why === "near";
        };
        let found = false;
        for (const o of [o0, o0 + 3, P.w + rrN + 1.5, o0 + 6]) { for (const sd of [side, -side]) if (tryAt(sd, o)) { found = true; break; } if (found) break; }
        if (why) continue;
        const volc = dmath.hypot(bx - V.x, bz - V.z) < V.base + 60 || badlandsAt(bx, bz) > 0.3;
        const k0 = out.length;
        if (!volc && cr() < 0.18) {
          // a low ruined wall: 2–3 granite blocks in a line along the trail, the middle one tallest, slightly skewed
          const n = 2 + ((cr() * 2) | 0), ux = (qx - px) / tl, uz = (qz - pz) / tl, yaw = dmath.atan2(ux, uz) + (cr() - 0.5) * 0.3;
          for (let b = 0; b < n; b++) {
            const along = (b - (n - 1) / 2) * 2.3, wx = bx + ux * along, wz = bz + uz * along;
            const sy = b === ((n - 1) >> 1) ? 2.3 + cr() * 0.5 : 1.95 + cr() * 0.4;   // tops 1.65–2.5 m: a kong hides
            push({ kind: "slab", v: (cr() * 4) | 0, x: wx, y: hAt(wx, wz) + sy * 0.5 - 0.3, z: wz, yaw: yaw + (cr() - 0.5) * 0.12, sx: 2.2 + cr() * 0.4, sy, sz: 1.0 + cr() * 0.3, tilt: 0 });
          }
        } else {
          const kind: RockKind = volc ? "crag" : "boulder", s = sz0, sy = s * 0.72;   // 3.2–4.7 m
          push({ kind, v: (cr() * 4) | 0, x: bx, y: h + sy * (0.5 - 0.22), z: bz, yaw: cr() * 6.283, sx: s * (1.0 + 0.3 * cr()), sy, sz: s * (0.85 + 0.25 * cr()), tilt: (cr() - 0.5) * 0.2 });
          for (let c = 0, m = 1 + ((cr() * 2) | 0); c < m; c++) {
            const a = cr() * 6.283, r0 = s * 0.55 + 0.6 + cr() * 1.2, sx2 = bx + dmath.cos(a) * r0, sz2 = bz + dmath.sin(a) * r0, s2 = 0.9 + cr() * 0.8, sy2 = s2 * 0.72;
            push({ kind, v: (cr() * 4) | 0, x: sx2, y: hAt(sx2, sz2) + sy2 * (0.5 - 0.3), z: sz2, yaw: cr() * 6.283, sx: s2 * (0.9 + 0.3 * cr()), sy: sy2, sz: s2 * (0.85 + 0.3 * cr()), tilt: (cr() - 0.5) * 0.3 });
          }
        }
        for (let q = k0; q < out.length; q++) if (isCover(out[q])) add(out[q]);
      }
    }
    // greedy FILL along the open route stretches (ROT_COVER): every 5 m, if
    // no rock within 13 m would hide a kong at that sample's ground level (collider top ≥ ground + 1.6, foot ≤ + 1,
    // ≥ 0.9 m wide), place a 3–4.5 m boulder (or a ruined wall) on a ring 5–12 m round the sample: same level (±1 m), off
    // every ribbon by its size, never in a POI / clearing / pad / water / on a > 31° slope.
    {
      const fy = (q: RockInstance) => (q.kind === "block" || q.kind === "slab" || q.kind === "basalt" || q.kind === "stack" ? 0.49 : 0.43);
      const fw = (q: RockInstance) => (q.kind === "block" || q.kind === "slab" || q.kind === "basalt" || q.kind === "stack" ? 0.47 : q.kind === "boulder" ? 0.36 : 0.33);
      const hides = (q: RockInstance, gy: number) => q.y + q.sy * fy(q) >= gy + 1.6 && q.y - q.sy * fy(q) <= gy + 1.0 && Math.min(q.sx, q.sz) * fw(q) >= 0.45;
      const fillGrid = new Map<number, RockInstance[]>();
      const fadd = (q: RockInstance) => { const k = gk(q.x, q.z); (fillGrid.get(k) ?? fillGrid.set(k, []).get(k)!).push(q); };
      for (const q of out) if (q.sy >= 1.5 && Math.min(q.sx, q.sz) >= 0.9) fadd(q);
      const covered = (x: number, z: number, gy: number) => {
        for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) for (const q of fillGrid.get(gk(x + a * cell, z + b * cell)) ?? [])
          if (dmath.hypot(q.x - x, q.z - z) < 13 && hides(q, gy)) return true;
        return false;
      };
      const fr = mulberry32(WORLD.SEED + 9127);
      for (const line of ROT_COVER) {
        const L = polyLen(line);
        for (let d = 0; d <= L; d += 5) {
          const [px, pz] = polyAt(line, d), gy = hAt(px, pz);
          if (gy < -0.6 || inPoiR(px, pz) || covered(px, pz, gy)) continue;
          const [qx, qz] = polyAt(line, Math.min(L, d + 2)), [ux, uz] = [qx - px, qz - pz], ul = dmath.hypot(ux, uz) || 1;
          const s0 = 3.2 + fr() * 1.3, rr = s0 * 1.3 * 0.45 + 1.3, a0 = dmath.atan2(uz / ul, ux / ul) + (fr() < 0.5 ? 1 : -1) * Math.PI / 2;
          let ok = false, bx = 0, bz = 0, h = 0;
          search: for (const rad of [7, 10, 5.5, 12, 14]) for (let k = 0; k < 24; k++) {
            const a = a0 + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * (Math.PI / 12);
            bx = px + dmath.cos(a) * rad; bz = pz + dmath.sin(a) * rad; h = hAt(bx, bz);
            const why = h < -0.6 ? "water" : h - gy > 1.4 || h - gy < -0.9 ? "level" : inPoiR(bx, bz) ? "poi" : nearPad(bx, bz, 1.05) ? "pad" : inApron(bx, bz) ? "apron" : fallsCarve(bx, bz) ? "falls" : slopeAt(bx, bz).s > 0.6 ? "slope" : inKeepXZ(bx, bz, s0 * 0.5 + 1) ? "keep" : "";
            if (why) continue;
            if (t.path[idx(bx, bz)] >= 20) continue;
            let rib = false; for (let m = 0; m < 8; m++) if (t.path[idx(bx + dmath.cos(m * Math.PI / 4) * rr, bz + dmath.sin(m * Math.PI / 4) * rr)] >= 60) { rib = true; break; }
            if (rib) continue;
            // push() silently refuses lava, camera keep-outs and view corridors: probe with the main rock's footprint
            const n0 = out.length;
            push({ kind: "boulder", v: 0, x: bx, y: h, z: bz, yaw: 0, sx: s0 * 1.3, sy: s0 * 0.72, sz: s0, tilt: 0 });
            if (out.length === n0) continue;
            out.length = n0;
            ok = true; break search;
          }
          if (!ok) continue;
          const volc = dmath.hypot(bx - V.x, bz - V.z) < V.base + 60 || badlandsAt(bx, bz) > 0.3;
          const k0 = out.length;
          if (!volc && fr() < 0.2) {
            const yaw = dmath.atan2(ux, uz) + (fr() - 0.5) * 0.4, dx = ux / ul, dz = uz / ul;
            for (let b = 0; b < 3; b++) {
              const along = (b - 1) * 2.2, wx = bx + dx * along, wz = bz + dz * along, sy = Math.max(b === 1 ? 2.4 + fr() * 0.4 : 2.0 + fr() * 0.4, gy + 2.05 - hAt(wx, wz));
              push({ kind: "slab", v: (fr() * 4) | 0, x: wx, y: hAt(wx, wz) + sy * 0.5 - 0.3, z: wz, yaw: yaw + (fr() - 0.5) * 0.12, sx: 2.2 + fr() * 0.4, sy, sz: 1.0 + fr() * 0.3, tilt: 0 });
            }
          } else {
            // tall enough to hide a kong standing at the SAMPLE's level (collider top = foot + 0.71 sy ≥ gy + 1.75)
            const kind: RockKind = volc ? "crag" : "boulder", sy = Math.max(s0 * 0.72, (gy + 1.75 - h) / 0.71);
            push({ kind, v: (fr() * 4) | 0, x: bx, y: h + sy * (0.5 - 0.22), z: bz, yaw: fr() * 6.283, sx: s0 * (1.0 + 0.3 * fr()), sy, sz: s0 * (0.85 + 0.25 * fr()), tilt: (fr() - 0.5) * 0.2 });
            const a = fr() * 6.283, r0 = s0 * 0.55 + 0.7, sx2 = bx + dmath.cos(a) * r0, sz2 = bz + dmath.sin(a) * r0, s2 = 0.9 + fr() * 0.7;
            push({ kind, v: (fr() * 4) | 0, x: sx2, y: hAt(sx2, sz2) + s2 * 0.72 * 0.2, z: sz2, yaw: fr() * 6.283, sx: s2, sy: s2 * 0.72, sz: s2 * 0.9, tilt: (fr() - 0.5) * 0.3 });
          }
          for (let q = k0; q < out.length; q++) fadd(out[q]);
        }
      }
    }
  }
  // 12. view dressing. biome-04: a foreground of CHUNKY black lava boulders (1.5–4 m, in clusters) framing the glowing
  //     field, not a bare slope with small chunks; biome-03: grey granite outcrops + boulders along the ridge trail and
  //     down the flank (kept out of the sea-view wedge by the vista rule).
  //     Own RNG, appended (every earlier rock keeps its place); the usual filters (camera, lava, roads, keep-outs) apply.
  {
    const hr = mulberry32(WORLD.SEED + 9311);
    const lens = (id: string) => { const c = TERRAIN_CAMS[id], fx = c.target[0] - c.pos[0], fz = c.target[2] - c.pos[2], fl = dmath.hypot(fx, fz); return { x: c.pos[0], z: c.pos[2], ux: fx / fl, uz: fz / fl }; };
    const at = (L: { x: number; z: number; ux: number; uz: number }, d: number, l: number): [number, number] => [L.x + L.ux * d - L.uz * l, L.z + L.uz * d + L.ux * l];
    const cluster = (kind: RockKind, cx: number, cz: number, s0: number, n: number, sink: number) => {
      push({ kind, v: (hr() * 4) | 0, x: cx, y: hAt(cx, cz) + s0 * 0.72 * (0.5 - sink), z: cz, yaw: hr() * 6.283, sx: s0 * (1 + 0.3 * hr()), sy: s0 * 0.72, sz: s0 * (0.85 + 0.25 * hr()), tilt: (hr() - 0.5) * 0.25 });
      for (let k = 0; k < n; k++) {
        const a = hr() * 6.283, r0 = s0 * 0.6 + 0.4 + hr() * 1.6, x = cx + dmath.cos(a) * r0, z = cz + dmath.sin(a) * r0, s2 = s0 * (0.3 + 0.35 * hr());
        push({ kind, v: (hr() * 4) | 0, x, y: hAt(x, z) + s2 * 0.72 * (0.5 - sink), z, yaw: hr() * 6.283, sx: s2 * (1 + 0.3 * hr()), sy: s2 * 0.72, sz: s2 * (0.8 + 0.3 * hr()), tilt: (hr() - 0.5) * 0.4 });
      }
    };
    // biome-04: [distance along the view axis, lateral (+ = right), size, companions]
    const L4 = lens("biome-04-volcanic");
    for (const [d, l, sz, n] of [[14, -9, 3.2, 3], [18, 8, 2.6, 2], [26, -15, 3.8, 3], [30, 14, 2.2, 2], [38, -4, 1.8, 2], [44, 20, 3.4, 3], [52, -22, 2.8, 2],
      [60, 6, 2.0, 2], [70, -30, 3.6, 3], [78, 26, 2.6, 2], [95, -12, 3.0, 2], [110, 34, 3.2, 3], [128, -38, 3.4, 2],
      [10, -14, 3.8, 3], [12, 13, 3.4, 3], [22, -24, 4.2, 3], [34, 24, 3.8, 3], [48, -34, 4.0, 3]] as Array<[number, number, number, number]>) {
      const [x, z] = at(L4, d, l); cluster("crag", x, z, sz, n, 0.28);
    }
    // biome-03: along the ridge trail below the camera (left of the sea-view wedge) + flank boulders beyond it
    const L3 = lens("biome-03-highlands");
    for (const [d, l, sz, n] of [[16, -7, 2.8, 2], [24, -12, 3.6, 3], [34, -6, 2.4, 2], [46, -14, 3.8, 3], [58, -9, 2.6, 2], [72, -18, 3.2, 2], [90, -12, 3.6, 3],
      [110, -20, 3.0, 2], [22, 5, 1.4, 1], [40, 9, 1.5, 1], [60, 14, 1.4, 1], [135, 30, 3.4, 2], [160, 48, 3.8, 3], [185, 22, 3.2, 2]] as Array<[number, number, number, number]>) {
      const [x, z] = at(L3, d, l); cluster("boulder", x, z, sz, n, 0.22);
    }
  }
  // roads + rotation trails stay clear (a rock collider on a road is an invisible wall across it): nothing within ~1.2 m of a painted path ribbon (path ≥ 60). A cliff
  // column / stack mass touching a road goes as a whole (a road through a cliff band leaves a clean gap, no floating tier).
  {
    const onRoad = (q: RockInstance) => {
      const rr = Math.max(q.sx, q.sz) * 0.45 + 1.2;
      if (t.path[idx(q.x, q.z)] >= 60) return true;
      for (let a = 0; a < 8; a++) { const x = q.x + dmath.cos(a * Math.PI / 4) * rr, z = q.z + dmath.sin(a * Math.PI / 4) * rr; if (t.path[idx(x, z)] >= 60) return true; }
      return false;
    };
    // POI clearings (file v5 `keep`, snapshot of every shared/pois clearing by the bake): no loose rock inside the ground a
    // POI dresses itself (e.g. canopy-line decks, coco-caves massif, mist-falls view, harbor apron). Cliff columns /
    // stacks (grp) stay — a clearing never punches a hole into a sea cliff.
    // (+ (−654, −311): terrain rocks there formed a jump-only covered floor inside COCO CAVES)
    // (+ (−657.7, −394.3): a 3-rock crevice that could trap a player)
    const K = (t.keep ?? []).concat([{ x: -654, z: -311, r: 9, hx: 0, hz: 0, yaw: 0 }, { x: -657.7, z: -394.3, r: 2.5, hx: 0, hz: 0, yaw: 0 }]);
    const inKeep = (q: RockInstance) => {
      const m = Math.max(q.sx, q.sz) * 0.35;
      for (const c of K) {
        const dx = q.x - c.x, dz = q.z - c.z;
        if (c.r > 0) { if (dx * dx + dz * dz < dmath.pow(c.r + m, 2)) return true; continue; }
        if (Math.abs(dx) > c.hx + c.hz + m || Math.abs(dz) > c.hx + c.hz + m) continue;
        const cy = dmath.cos(c.yaw), sy = dmath.sin(c.yaw), lx = dx * cy + dz * sy, lz = -dx * sy + dz * cy;
        if (Math.abs(lx) < c.hx + m && Math.abs(lz) < c.hz + m) return true;
      }
      return false;
    };
    const dropG = new Set<number>();
    for (const q of out) if (q.grp !== undefined && onRoad(q)) dropG.add(q.grp);
    const keep = out.filter((q) => (q.grp !== undefined ? !dropG.has(q.grp) : !onRoad(q) && !inKeep(q)));
    out.length = 0; for (const q of keep) out.push(q);
  }
  // column tops: a tier whose next tier was dropped by a keep-out becomes the top → turf cap (no bare cut top shows)
  {
    const byG = new Map<number, RockInstance[]>();
    for (const q of out) if (q.grp !== undefined) (byG.get(q.grp) ?? byG.set(q.grp, []).get(q.grp)!).push(q);
    for (const list of byG.values()) for (const q of list) {
      if (q.cap === 1) continue;
      const top = q.y + q.sy / 2;
      if (!list.some((o) => o !== q && o.y - o.sy / 2 < top && o.y + o.sy / 2 > top + 0.5)) q.cap = 1;
    }
  }
  return out;
}

/** collision for every rock ≥ 1.5 m (server + client prediction): an oriented box inscribed in the sculpted shape —
 * full extents for masonry blocks, ~70 % for rounded boulders / faceted crags so no invisible corners stick out. */
export function terrainRockColliders(rocks: RockInstance[]): Box[] {
  // YAW CONVENTION: RockInstance.yaw is a three.js rotation.y (world = Ry(yaw)·local:
  // x' = c·x + s·z, z' = −s·x + c·z), but the sim's Box.yaw rotates the other way (shared/sim/world.ts: local x =
  // dx·cos + dz·sin → world x' = c·x − s·z). Every Box below therefore carries −r.yaw; the local offsets (column pull)
  // are still computed in the three convention, which matches the drawn rock. Without the sign flip every rotated rock
  // collider is mirrored: rocks you see ≠ rocks that block kongs and bullets.
  const out: Box[] = [];
  // cliff tiers / stack sections (grp): one box per tier / section = its sculpted envelope (the renderer only carves
  // INTO it: strata grooves, joints, erosion), pulled in 0.3 m on the exposed sides so no invisible edge sticks out of
  // an eroded face (a union box per column would stand metres in front of the stepped-back upper tiers)
  for (const r of rocks) {
    if (r.grp === undefined) continue;
    const c = dmath.cos(r.yaw), s = dmath.sin(r.yaw);
    // the box faces sit at the carved surface's MEAN depth (carveMean), so the rock you see is within a few dm of what
    // you collide with and what stops a bullet
    const cm = Math.min(1.0, carveMean(r.kind));
    if (r.kind === "stack") {
      // a stack mass: stacked sections ≤ 8 m tall, each inset by the carved mean + the taper at its mid-height; the
      // rounded cross-section (STACK_CORNER) is covered by THREE boxes — the two arms of a cross plus a box whose corners
      // touch the corner arcs at 45° — so no invisible box corner stands outside the rounded rock
      const nB = Math.max(1, Math.ceil(r.sy / 8)), hb = r.sy / nB;
      const rr0 = STACK_CORNER * Math.min(r.sx, r.sz);
      for (let b = 0; b < nB; b++) {
        const k = cm + 0.15 + STACK_TAPER * hb * (b + 0.5);
        const hx = Math.max(0.4, r.sx / 2 - k), hz = Math.max(0.4, r.sz / 2 - k), rr = Math.max(0, Math.min(rr0 - cm, 0.95 * Math.min(hx, hz)));
        // the top section stops 0.5 m under the rounded shoulder
        const top = b === nB - 1 ? 0.5 : 0, cy = r.y - r.sy / 2 + hb * (b + 0.5) - top / 2, hy = (hb - top) / 2;
        for (const [ax, az] of [[hx, hz - rr], [hx - rr, hz], [hx - 0.293 * rr, hz - 0.293 * rr]]) {
          out.push({ c: [r.x, cy, r.z], h: [Math.max(0.4, ax), hy, Math.max(0.4, az)], yaw: -r.yaw, surf: "stone" });
        }
      }
    } else {
      // columns: the front (local +z) and the two ends are exposed, the back is buried in the wall
      const pull = cm, lz = -pull / 2;
      out.push({ c: [r.x + lz * s, r.y, r.z + lz * c], h: [Math.max(0.4, r.sx / 2 - cm), r.sy / 2, Math.max(0.4, r.sz / 2 - pull / 2)], yaw: -r.yaw, surf: "stone" });
    }
  }
  for (const r of rocks) {
    if (r.grp !== undefined) continue;
    if (Math.max(r.sx, r.sy, r.sz) < 1.5) continue;
    const blocky = r.kind === "block" || r.kind === "slab" || r.kind === "basalt" || r.kind === "stack";
    const f = blocky ? 0.47 : r.kind === "boulder" ? 0.36 : 0.33, fy = blocky ? 0.49 : 0.43;
    out.push({ c: [r.x, r.y, r.z], h: [r.sx * f, r.sy * fy, r.sz * f], yaw: -r.yaw, surf: "stone" });
  }
  return out;
}

/** all static terrain colliders (rocks) for a terrain — concat with allColliders() + vegTrunkColliders() */
export function terrainColliders(t: TerrainData): Box[] { return terrainRockColliders(terrainRocks(t)); }
