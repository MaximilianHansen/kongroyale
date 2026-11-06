// poi-town: Mango Market FOUNTAIN (the market's hero centrepiece) — round two-level stone fountain:
// segmented outer step ring, basin wall of bevelled blocks with a mossy band low down and a rounded bullnose coping,
// turquoise water with four arcing jets + pedestal spouts (animated streams, splash foam), stone planter boxes with
// succulents and red/pink/orange flowers on the rim, a big planter pier at the front, and a chunky square stepped
// pedestal of weathered chamfered blocks with dark joints carrying the bronze gorilla statue (town-statue.ts).
// Dimensions come from shared/pois/town-fountain.ts (same data as the colliders).
import * as THREE from "three";
import type { WorldCtx } from "../../../engine/engine";
import type { LabEnv } from "./town-lab";
import type { TownBins, TownMats } from "./town-materials";
import { M, col, chamferBoxGeo, cylGeo, latheGeo, discGeo, boxProjectUV, type ColorFn } from "./town-geo";
import { poolWaterMaterial, animateWater } from "./town-water";
import { buildGorillaStatue } from "./town-statue";
import { ctxPace, type Pace } from "./pace";
import { fountainDims, type FountainDims } from "../../../../../shared/pois/town-fountain";

export interface FountainOpts { R?: number /* outer radius of the basin wall, default 4.2 */; statueHeight?: number /* default 3.4 */; statueYaw?: number }
export interface FountainInfo { waterY: number; innerR: number; pedestalTopY: number }

// ---------------------------------------------------------------------------------------------------------------
// small helpers
function h3(i: number, j: number, k: number) {
  let h = (i * 374761393 + j * 668265263 + k * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function vn(x: number, y: number, z: number) {
  const i = Math.floor(x), j = Math.floor(y), k = Math.floor(z), fx = x - i, fy = y - j, fz = z - k;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), uz = fz * fz * (3 - 2 * fz), l = (a: number, b: number, t: number) => a + (b - a) * t;
  return l(l(l(h3(i, j, k), h3(i + 1, j, k), ux), l(h3(i, j + 1, k), h3(i + 1, j + 1, k), ux), uy),
    l(l(h3(i, j, k + 1), h3(i + 1, j, k + 1), ux), l(h3(i, j + 1, k + 1), h3(i + 1, j + 1, k + 1), ux), uy), uz);
}
const sat = (v: number) => Math.max(0, Math.min(1, v));
const smooth = (a: number, b: number, v: number) => { const t = sat((v - a) / (b - a)); return t * t * (3 - 2 * t); };

/** bevelled annular-sector block: closed CCW profile [[r, y], …] swept a0→a1 around +y, both ends chamfered by `b`
 *  (x = cos θ · r, z = sin θ · r). Smooth normals → soft edge highlights; metre box-projected UVs. */
function sweepBlock(profile: Array<[number, number]>, a0: number, a1: number, b = 0.025): THREE.BufferGeometry {
  const np = profile.length;
  let cr = 0, cy = 0; for (const [r, y] of profile) { cr += r; cy += y; } cr /= np; cy /= np;
  const inset = profile.map(([r, y]): [number, number] => { const dr = cr - r, dy = cy - y, l = Math.hypot(dr, dy) || 1; return [r + dr / l * b, y + dy / l * b]; });
  const rm = cr, da = b / rm, arc = (a1 - a0) * rm;
  const seg = Math.max(2, Math.ceil(arc / 0.22));
  const rings: Array<{ a: number; p: Array<[number, number]> }> = [{ a: a0, p: inset }];
  for (let i = 0; i <= seg; i++) rings.push({ a: a0 + da + (a1 - a0 - 2 * da) * i / seg, p: profile });
  rings.push({ a: a1, p: inset });
  const pos: number[] = [], idx: number[] = [];
  for (const rg of rings) { const c = Math.cos(rg.a), s = Math.sin(rg.a); for (const [r, y] of rg.p) pos.push(c * r, y, s * r); }
  for (let i = 0; i < rings.length - 1; i++) for (let j = 0; j < np; j++) {
    const a = i * np + j, bb = i * np + (j + 1) % np, c = (i + 1) * np + (j + 1) % np, d = (i + 1) * np + j;
    idx.push(a, bb, c, a, c, d);
  }
  // caps (own vertices so the ends stay flat)
  for (const [ri, start] of [[0, true], [rings.length - 1, false]] as Array<[number, boolean]>) {
    const rg = rings[ri], c = Math.cos(rg.a), s = Math.sin(rg.a), base = pos.length / 3;
    pos.push(c * cr, cy, s * cr);
    for (const [r, y] of rg.p) pos.push(c * r, y, s * r);
    for (let j = 0; j < np; j++) { const p0 = base + 1 + j, p1 = base + 1 + (j + 1) % np; if (start) idx.push(base, p1, p0); else idx.push(base, p0, p1); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return boxProjectUV(g, 1, [h3(Math.round(a0 * 100), 3, 1) * 7, h3(Math.round(a0 * 100), 5, 2) * 7]);
}
/** rectangle profile with chamfered corners */
const rectProfile = (r0: number, r1: number, y0: number, y1: number, c: number): Array<[number, number]> =>
  [[r0 + c, y0], [r1 - c, y0], [r1, y0 + c], [r1, y1 - c], [r1 - c, y1], [r0 + c, y1], [r0, y1 - c], [r0, y0 + c]];
/** bullnose coping profile: flat underside, both top edges rounded by `rr` */
function bullnoseProfile(r0: number, r1: number, y0: number, y1: number, rr: number): Array<[number, number]> {
  const out: Array<[number, number]> = [[r0 + 0.02, y0], [r1 - 0.025, y0], [r1, y0 + 0.025]];
  for (let i = 0; i <= 4; i++) { const t = i / 4 * Math.PI / 2; out.push([r1 - rr + Math.cos(t) * rr, y1 - rr + Math.sin(t) * rr]); }
  for (let i = 0; i <= 4; i++) { const t = Math.PI / 2 + i / 4 * Math.PI / 2; out.push([r0 + rr + Math.cos(t) * rr, y1 - rr + Math.sin(t) * rr]); }
  out.push([r0, y0 + 0.02]);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// flowers + succulents for the stone planters (leaf / fruit bins)
/** 5-lobed blossom (flat cup facing +y), ~30 tris */
function blossomGeo(r: number): THREE.BufferGeometry {
  const n = 15, pos: number[] = [0, r * 0.25, 0], idx: number[] = [];
  for (let i = 0; i <= n; i++) {
    const a = i / n * Math.PI * 2, rr = r * (0.55 + 0.45 * Math.abs(Math.cos(a * 2.5)));
    pos.push(Math.cos(a) * rr, r * 0.35 * (rr / r), Math.sin(a) * rr);
  }
  for (let i = 1; i <= n; i++) idx.push(0, i + 1, i);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}
/** pointed leaf blade in XZ pointing +z with a centre fold and a droop (like town-building leafGeo, local copy) */
function bladeGeo(len: number, wid: number): THREE.BufferGeometry {
  const pts: Array<[number, number]> = [], n = 6;
  for (let i = 0; i <= n; i++) { const t = i / n; pts.push([-(Math.sin(t * Math.PI) ** 0.7) * wid / 2, t * len]); }
  for (let i = n - 1; i > 0; i--) { const t = i / n; pts.push([(Math.sin(t * Math.PI) ** 0.7) * wid / 2, t * len]); }
  const g = new THREE.ShapeGeometry(new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, -z))), 3);
  g.rotateX(-Math.PI / 2);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) { const x = p.getX(i), z = p.getZ(i); p.setY(i, Math.abs(x) * 0.5 - (z / len) ** 2 * len * 0.35); }
  g.computeVertexNormals();
  return g;
}
function addPlanting(bins: TownBins, m: THREE.Matrix4, w: number, rng: () => number, style: "flowers" | "succulent" | "mixed") {
  const green = ["#3f7f33", "#4e8f3a", "#35702c", "#5a9a42"];
  const bloom = ["#e8383d", "#ff5f86", "#ff8a2a", "#ffcf3a", "#d9304f", "#ff7a59"];
  if (style !== "succulent") {
    // leafy clump: blades radiating from 2–3 crowns
    const crowns = style === "flowers" ? 3 : 2;
    for (let c = 0; c < crowns; c++) {
      const cx = (rng() - 0.5) * w * 0.4, cz = (rng() - 0.5) * w * 0.4, n = 9;
      for (let i = 0; i < n; i++) {
        const a = i / n * Math.PI * 2 + rng() * 0.5, len = w * (0.28 + rng() * 0.14);
        bins.leaf.add(bladeGeo(len, len * 0.42), m.clone().multiply(M(cx, 0.02, cz, a, -(0.35 + rng() * 0.5))), col(green[Math.floor(rng() * 4)], 0.85 + rng() * 0.3));
      }
    }
    const nf = style === "flowers" ? 14 : 6;
    for (let i = 0; i < nf; i++) {
      const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * w * 0.32, y = w * (0.12 + rng() * 0.13);
      const fm = m.clone().multiply(M(Math.cos(a) * r, y, Math.sin(a) * r, rng() * 6, (rng() - 0.5) * 0.6, (rng() - 0.5) * 0.6));
      bins.leaf.add(cylGeo(0.006, 0.008, y, 3), m.clone().multiply(M(Math.cos(a) * r * 0.8, y / 2, Math.sin(a) * r * 0.8)), col("#4d7f35"));
      bins.fruit.add(blossomGeo(0.05 + rng() * 0.025), fm, col(bloom[Math.floor(rng() * bloom.length)]));
      bins.fruit.add(new THREE.IcosahedronGeometry(0.014, 0), fm.clone().multiply(M(0, 0.02, 0)), col("#ffd84a"));
    }
  }
  // succulent / aloe rosette: thick tapering blades
  if (style !== "flowers") {
    const n = style === "succulent" ? 12 : 7, blade = new THREE.ConeGeometry(0.05, 1, 5, 1);
    blade.translate(0, 0.5, 0);
    for (let i = 0; i < n; i++) {
      const a = i / n * Math.PI * 2 + rng() * 0.4, len = w * (0.32 + rng() * 0.3) * (i % 3 === 0 ? 1.25 : 1), tilt = 0.3 + rng() * 0.6;
      bins.leaf.add(blade, m.clone().multiply(M((style === "mixed" ? w * 0.15 : 0), w * 0.03, 0, a, tilt, 0, 1, len, 0.5)), col(i % 2 ? "#6f9e58" : "#58884a"));
    }
    if (style === "succulent") for (let i = 0; i < 3; i++) {
      const a = rng() * 6.28, r = w * 0.16, hh = w * (0.5 + rng() * 0.2);
      bins.leaf.add(cylGeo(0.008, 0.011, hh, 4), m.clone().multiply(M(Math.cos(a) * r, hh / 2, Math.sin(a) * r)), col("#6c8f3a"));
      for (let k = 0; k < 4; k++) bins.fruit.add(blossomGeo(0.03), m.clone().multiply(M(Math.cos(a) * r + (rng() - 0.5) * 0.05, hh - k * 0.03, Math.sin(a) * r + (rng() - 0.5) * 0.05, rng() * 6)), col(k % 2 ? "#ffc93a" : "#ff9a2e"));
    }
  }
}
/** hollow stone planter box (walls + soil) with planting; origin = bottom centre */
function addPlanterBox(bins: TownBins, m: THREE.Matrix4, w: number, h: number, rng: () => number, style: "flowers" | "succulent" | "mixed", base: THREE.Color, fn?: ColorFn) {
  const t = 0.08;
  bins.trim.add(chamferBoxGeo(w, 0.08, w, 0.02), m.clone().multiply(M(0, 0.04, 0)), base, fn);
  for (let i = 0; i < 4; i++) {
    const side = m.clone().multiply(M(0, 0, 0, i * Math.PI / 2));
    bins.trim.add(chamferBoxGeo(w, h, t, 0.025, [i * 0.7, 0]), side.multiply(M(0, h / 2, w / 2 - t / 2)), base.clone().multiplyScalar(0.94 + 0.12 * rng()), fn);
  }
  // a thin lip course on top (reads as a carved rim)
  for (let i = 0; i < 4; i++) bins.trim.add(chamferBoxGeo(w + 0.04, 0.05, t + 0.04, 0.018), m.clone().multiply(M(0, 0, 0, i * Math.PI / 2)).multiply(M(0, h + 0.02, w / 2 - t / 2)), base.clone().multiplyScalar(1.05), fn);
  bins.sand.add(chamferBoxGeo(w - 2 * t + 0.01, 0.04, w - 2 * t + 0.01, 0.01), m.clone().multiply(M(0, h - 0.06, 0)), col("#4a3322"));
  addPlanting(bins, m.clone().multiply(M(0, h - 0.05, 0)), w, rng, style);
}

// ---------------------------------------------------------------------------------------------------------------
// water: streams + foam share one scrolling alpha texture (rows 0–0.5 = stream streaks, 0.5–1 = foam blobs)
let jetTexCache: THREE.CanvasTexture | null = null;
function jetTexture(): THREE.CanvasTexture {
  if (jetTexCache) return jetTexCache;
  const W = 256, H = 128, c = document.createElement("canvas"); c.width = W; c.height = H;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, W, H);
  let s = 7; const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  // stream: bright glassy core + broken streaks along u
  for (let y = 0; y < H / 2; y++) {
    const v = y / (H / 2), edge = Math.sin(v * Math.PI);
    g.fillStyle = `rgba(225,248,255,${0.28 + 0.3 * edge})`; g.fillRect(0, y, W, 1);
  }
  for (let i = 0; i < 90; i++) {
    const y = r() * H / 2, x = r() * W, len = 20 + r() * 90;
    g.fillStyle = `rgba(255,255,255,${0.35 + r() * 0.55})`; g.fillRect(x, y, len, 1 + r() * 2);
    if (x + len > W) g.fillRect(x - W, y, len, 2);
  }
  // foam: soft white blobs
  for (let i = 0; i < 170; i++) {
    const x = r() * W, y = H / 2 + 4 + r() * (H / 2 - 8), rad = 2 + r() * 6;
    const gr = g.createRadialGradient(x, y, 0, x, y, rad);
    gr.addColorStop(0, `rgba(255,255,255,${0.3 + r() * 0.5})`); gr.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();
    if (x + rad > W) { g.beginPath(); g.arc(x - W, y, rad, 0, Math.PI * 2); g.fill(); }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  jetTexCache = t;
  return t;
}
/** variable-radius tube along a polyline; u = length (metres × uScale), v = around mapped into [v0, v1] */
function streamGeo(pts: THREE.Vector3[], radius: (t: number) => number, radial: number, uScale: number, v0: number, v1: number, pos: number[], uv: number[], idx: number[]) {
  const base = pos.length / 3, n = pts.length;
  let len = 0;
  const up = new THREE.Vector3(0, 1, 0), T = new THREE.Vector3(), N = new THREE.Vector3(), B = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    if (i > 0) len += pts[i].distanceTo(pts[i - 1]);
    T.subVectors(pts[Math.min(n - 1, i + 1)], pts[Math.max(0, i - 1)]).normalize();
    N.crossVectors(T, up); if (N.lengthSq() < 1e-6) N.set(1, 0, 0); N.normalize(); B.crossVectors(N, T).normalize();
    const r = radius(i / (n - 1));
    for (let j = 0; j <= radial; j++) {
      const a = j / radial * Math.PI * 2;
      pos.push(pts[i].x + (N.x * Math.cos(a) + B.x * Math.sin(a)) * r, pts[i].y + (N.y * Math.cos(a) + B.y * Math.sin(a)) * r, pts[i].z + (N.z * Math.cos(a) + B.z * Math.sin(a)) * r);
      uv.push(len * uScale, v0 + (v1 - v0) * j / radial);
    }
  }
  for (let i = 0; i < n - 1; i++) for (let j = 0; j < radial; j++) {
    const a = base + i * (radial + 1) + j, b = a + radial + 1;
    idx.push(a, b, a + 1, a + 1, b, b + 1);
  }
}
/** flat foam ring on the water: u = radius (scrolls outward), v = angle in [0.52, 0.98] */
function foamRing(cx: number, cz: number, y: number, r0: number, r1: number, seg: number, pos: number[], uv: number[], idx: number[], uScale = 2.2) {
  const base = pos.length / 3;
  for (let i = 0; i <= seg; i++) {
    const a = i / seg * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
    pos.push(cx + c * r0, y, cz + s * r0, cx + c * r1, y, cz + s * r1);
    const v = 0.52 + 0.46 * (i / seg);
    uv.push(r0 * uScale, v, r1 * uScale, v);
  }
  for (let i = 0; i < seg; i++) { const a = base + i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
}
/** square foam band hugging the pedestal plinth at the waterline */
function foamSquare(half: number, y: number, wdt: number, pos: number[], uv: number[], idx: number[], m: THREE.Matrix4) {
  const pts: Array<[number, number]> = [];
  const n = 10;
  for (let sgn = 0; sgn < 4; sgn++) for (let i = 0; i < n; i++) {
    const t = -half + 2 * half * i / n;
    const p: [number, number] = sgn === 0 ? [t, -half] : sgn === 1 ? [half, t] : sgn === 2 ? [-t, half] : [-half, -t];
    pts.push(p);
  }
  const base = pos.length / 3, v = new THREE.Vector3();
  for (let i = 0; i <= pts.length; i++) {
    const [x, z] = pts[i % pts.length], l = Math.max(Math.abs(x), Math.abs(z)), k = (l + wdt) / l;
    v.set(x, y, z).applyMatrix4(m); pos.push(v.x, v.y, v.z);
    v.set(x * k, y, z * k).applyMatrix4(m); pos.push(v.x, v.y, v.z);
    const vv = 0.52 + 0.46 * ((i * 0.37) % 1);
    uv.push(0, vv, wdt * 2.2, vv);
  }
  for (let i = 0; i < pts.length; i++) { const a = base + i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
}

// ---------------------------------------------------------------------------------------------------------------
/** full fountain at `at` (origin = plaza floor at the fountain centre): step ring, basin, water (+ animated jets),
 *  rim planters, pedestal, statue. Geometry into bins; water/jets/statue meshes into `extra`. `at` should be a
 *  translation (orientation of the square pedestal / pier / statue comes from `o.statueYaw`, like the colliders). */
export async function addFountain(ctx: WorldCtx, bins: TownBins, mats: TownMats, at: THREE.Matrix4, extra: THREE.Object3D[], rng: () => number, o: FountainOpts = {}, pace: Pace = ctxPace(ctx)): Promise<FountainInfo> {
  void mats;
  const d = fountainDims(o);
  const yaw = d.statueYaw;
  const base = new THREE.Vector3().setFromMatrixPosition(at), Y0 = base.y;
  const rot = at.clone().multiply(M(0, 0, 0, yaw));   // decoration frame (statue faces local +z)
  const stoneA = col("#aa9f8c"), stoneB = col("#9a907f"), pedC = col("#958b7c"), copC = col("#9da489"), moss = col("#6f8a44"), mossDark = col("#4c6532");

  // weathering colour functions (world coords in, local height from Y0)
  const weather = (mossLow: number, mossAmt: number, wetY = -1, wetR = 1e9): ColorFn => (x, y, z, b, out) => {
    const ly = y - Y0;
    const n = vn(x * 1.7, ly * 2.3, z * 1.7), n2 = vn(x * 6.1 + 3, ly * 6.1, z * 6.1);
    out.multiplyScalar(0.9 + 0.2 * n2);
    // mossy band low on the wall + moss creeping along joints
    const band = smooth(mossLow + 0.35, mossLow, ly) * sat(n * 1.6 - 0.2) * mossAmt;
    out.lerp(n2 > 0.5 ? moss : mossDark, band * 0.75);
    // grime at the foot
    out.multiplyScalar(0.72 + 0.28 * smooth(0, 0.25, ly));
    // wet band at the waterline (darker, greener)
    if (wetY > 0 && ly < wetY + 0.12 && Math.hypot(x - base.x, z - base.z) < wetR) { out.multiplyScalar(0.68 + 0.32 * smooth(wetY - 0.3, wetY + 0.12, ly)); out.lerp(mossDark, 0.35 * smooth(wetY + 0.12, wetY - 0.05, ly) * (0.5 + n)); }
  };

  await pace.pause();
  // ---- outer step ring: 24 bevelled blocks with 1 cm joints
  {
    const n = Math.max(12, Math.round(2 * Math.PI * d.stepR / 1.25)), gap = 0.012;
    for (let i = 0; i < n; i++) {
      const a0 = i * 2 * Math.PI / n + gap / d.stepR, a1 = (i + 1) * 2 * Math.PI / n - gap / d.stepR;
      const hj = (rng() - 0.5) * 0.012;
      const g = sweepBlock(rectProfile(d.R - 0.12, d.stepR, -0.02, d.stepH + hj, 0.03), a0, a1, 0.025);
      bins.trim.add(g, at, stoneA.clone().multiplyScalar(0.9 + rng() * 0.18), weather(0.1, 0.5));
      await pace.pause();
    }
    // dark joint filler under the blocks
    bins.stone.add(latheGeo([[d.R - 0.1, 0.0], [d.stepR - 0.02, 0.0], [d.stepR - 0.02, d.stepH - 0.02], [d.R - 0.1, d.stepH - 0.02]], 64), at, col("#4a4239"));
  }
  await pace.pause();
  // ---- basin wall: bevelled blocks, inner face runs down to the pool floor
  {
    const n = Math.max(12, Math.round(2 * Math.PI * d.R / 1.35)), gap = 0.012;
    for (let i = 0; i < n; i++) {
      const a0 = (i + 0.5) * 2 * Math.PI / n + gap / d.R, a1 = (i + 1.5) * 2 * Math.PI / n - gap / d.R;
      const g = sweepBlock(rectProfile(d.innerR, d.R, 0.0, d.copY0 + 0.01, 0.03), a0, a1, 0.028);
      bins.trim.add(g, at, stoneB.clone().multiplyScalar(0.88 + rng() * 0.2), weather(d.stepH + 0.05, 1.0, d.waterY, d.innerR + 0.04));
      await pace.pause();
    }
    bins.stone.add(latheGeo([[d.innerR + 0.02, 0.0], [d.R - 0.02, 0.0], [d.R - 0.02, d.copY0], [d.innerR + 0.02, d.copY0]], 64), at, col("#3e382f"));
  }
  await pace.pause();
  // ---- rounded bullnose coping (mossy grey-green), joints offset from the wall's
  {
    const n = Math.max(10, Math.round(2 * Math.PI * d.R / 1.6)), gap = 0.01;
    const prof = bullnoseProfile(d.copIn, d.copOut, d.copY0, d.copY1, 0.065);
    for (let i = 0; i < n; i++) {
      const a0 = i * 2 * Math.PI / n + gap / d.R, a1 = (i + 1) * 2 * Math.PI / n - gap / d.R;
      bins.trim.add(sweepBlock(prof, a0, a1, 0.02), at, copC.clone().multiplyScalar(0.9 + rng() * 0.16), (x, y, z, b, out) => {
        const n1 = vn(x * 2.2, y * 3, z * 2.2), n2 = vn(x * 7, y * 7, z * 7);
        out.multiplyScalar(0.88 + 0.22 * n2);
        out.lerp(n1 > 0.55 ? moss : mossDark, sat((n1 - 0.45) * 2.2) * 0.45);
      });
      await pace.pause();
    }
  }
  await pace.pause();
  // ---- pool floor (tiled, pale aqua) + a few coins
  bins.paving.add(discGeo(d.innerR + 0.02, 64, 0.8), at.clone().multiply(M(0, d.floorY, 0)), col("#8fd0cb"), (x, y, z, b, out) => {
    const r = Math.hypot(x - base.x, z - base.z); out.multiplyScalar(0.75 + 0.25 * smooth(d.innerR, d.innerR - 0.6, r));
  });
  for (let i = 0; i < 26; i++) {
    const a = rng() * Math.PI * 2, r = d.ps * 1.6 + rng() * (d.innerR - d.ps * 1.6 - 0.2);
    bins.metal.add(cylGeo(0.035, 0.035, 0.006, 8), at.clone().multiply(M(Math.cos(a) * r, d.floorY + 0.004, Math.sin(a) * r, rng() * 6, (rng() - 0.5) * 0.3)), col(rng() < 0.7 ? "#d8b04a" : "#b8b8b0"));
  }

  await pace.pause();
  // ---- pedestal: plinth in the water, collar, 3-course masonry shaft, two-step cornice, statue plinth
  {
    const P = (x: number, y: number, z: number, ry = 0) => rot.clone().multiply(M(x, y, z, ry));
    const block = (w: number, h: number, dd: number, m: THREE.Matrix4, c: THREE.Color, bev = 0.035, wetY = d.waterY) =>
      bins.trim.add(chamferBoxGeo(w, h, dd, bev, [rng() * 5, rng() * 5]), m, c.clone().multiplyScalar(0.88 + rng() * 0.2), weather(-1, 0, wetY));
    // plinth: 2 × 2 blocks
    const ph = d.plinth.h, py = (d.plinth.y0 + d.plinth.y1) / 2, pH = d.plinth.y1 - d.plinth.y0;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) block(ph - 0.012, pH, ph - 0.012, P(sx * ph / 2, py, sz * ph / 2), pedC, 0.04);
    bins.stone.add(chamferBoxGeo(ph * 2 - 0.06, pH - 0.02, ph * 2 - 0.06, 0.01), P(0, py, 0), col("#3a342c"));
    // collar slab (overhangs the plinth)
    const ch = d.collar.h, cyc = (d.collar.y0 + d.collar.y1) / 2, cH = d.collar.y1 - d.collar.y0;
    for (const sx of [-1, 1]) block(ch - 0.01, cH, ch * 2, P(sx * ch / 2, cyc, 0), pedC.clone().multiplyScalar(1.04), 0.04);
    // shaft: courses alternate their joint direction (running bond)
    const sh = d.shaft.h, cn = d.shaft.courses, courseH = (d.shaft.y1 - d.shaft.y0) / cn;
    bins.stone.add(chamferBoxGeo(sh * 2 - 0.05, d.shaft.y1 - d.shaft.y0, sh * 2 - 0.05, 0.01), P(0, (d.shaft.y0 + d.shaft.y1) / 2, 0), col("#3a342c"));
    for (let c = 0; c < cn; c++) {
      const y = d.shaft.y0 + courseH * (c + 0.5), split = (c % 2 ? 0.18 : -0.22) * sh;
      const alongX = c % 2 === 0;
      const aW = sh + split, bW = sh - split;
      if (alongX) {
        block(aW - 0.012, courseH - 0.012, sh * 2, P(-sh + aW / 2, y, 0), pedC);
        block(bW - 0.012, courseH - 0.012, sh * 2, P(sh - bW / 2, y, 0), pedC);
      } else {
        block(sh * 2, courseH - 0.012, aW - 0.012, P(0, y, -sh + aW / 2), pedC);
        block(sh * 2, courseH - 0.012, bW - 0.012, P(0, y, sh - bW / 2), pedC);
      }
    }
    // cornice: two stepped slabs + statue plinth
    const k1 = d.cap1, k2 = d.cap2, tp = d.top;
    block(k1.h * 2, k1.y1 - k1.y0, k1.h * 2, P(0, (k1.y0 + k1.y1) / 2, 0), pedC.clone().multiplyScalar(1.03), 0.035);
    for (const sx of [-1, 1]) block(k2.h - 0.01, k2.y1 - k2.y0, k2.h * 2, P(sx * k2.h / 2, (k2.y0 + k2.y1) / 2, 0), pedC.clone().multiplyScalar(1.06), 0.045);
    block(tp.h * 2, tp.y1 - tp.y0, tp.h * 2, P(0, (tp.y0 + tp.y1) / 2, 0), pedC.clone().multiplyScalar(1.02), 0.05);
    // bronze spouts on the collar faces
    for (let i = 0; i < 4; i++) {
      const sp = rot.clone().multiply(M(0, 0, 0, i * Math.PI / 2 + Math.PI / 4)).multiply(M(0, d.collar.y1 - 0.1, ch * 0.72));
      bins.metal.add(latheGeo([[0, 0], [0.07, 0], [0.07, 0.03], [0.045, 0.05], [0.045, 0.2], [0.06, 0.22], [0.06, 0.25], [0, 0.25]], 10), sp.clone().multiply(M(0, 0, 0, 0, Math.PI / 2 - 0.25)), col("#6a5a3e"));
    }
  }

  await pace.pause();
  // ---- front planter pier (statue's facing direction) + rim planters
  {
    const pw = d.pier.w, pd = d.pier.d;
    const pm = rot.clone().multiply(M(0, 0, d.pier.r));
    bins.trim.add(chamferBoxGeo(pw, d.pier.y1 - 0.2, pd, 0.045), pm.clone().multiply(M(0, (d.pier.y1 - 0.2) / 2, 0)), stoneA.clone().multiplyScalar(1.02), weather(0.12, 0.6));
    addPlanterBox(bins, pm.clone().multiply(M(0, d.pier.y1 - 0.2, 0)), pw * 0.92, 0.36, rng, "flowers", stoneA.clone().multiplyScalar(1.06), weather(-1, 0));
    const styles: Array<"succulent" | "mixed"> = ["succulent", "mixed", "succulent"];
    d.rimPlanters.forEach((p, i) => {
      const r = d.R - 0.17;
      const m = rot.clone().multiply(M(Math.sin(p.a) * r, d.copY1 - 0.01, Math.cos(p.a) * r, p.a));
      addPlanterBox(bins, m, p.w, p.h, rng, styles[i % 3], stoneA.clone().multiplyScalar(0.98 + rng() * 0.1), weather(-1, 0));
    });
  }

  await pace.pause();
  // ---- water surface
  // bright turquoise, stronger ripple normals + a glossier surface so the sky and the sun glint break up on it
  const water = poolWaterMaterial("#2fd0da", 0.78);
  water.normalScale.set(0.75, 0.75); water.roughness = 0.03; water.envMapIntensity = 1.5;
  const wmesh = new THREE.Mesh(discGeo(d.innerR + 0.01, 72, 2), water);
  wmesh.applyMatrix4(at.clone().multiply(M(0, d.waterY, 0)));
  wmesh.receiveShadow = true; wmesh.name = "fountain:water";
  extra.push(wmesh);

  await pace.pause();
  // ---- jets (4 arcing streams from bronze nozzles near the rim + 4 pedestal spouts) and foam
  {
    const pos: number[] = [], uv: number[] = [], idx: number[] = [];
    const v = new THREE.Vector3();
    const toW = (x: number, y: number, z: number) => v.set(x, y, z).applyMatrix4(rot).clone();
    const wy = d.waterY;
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2 + Math.PI / 4, c = Math.sin(a), s = Math.cos(a);
      const r0 = d.innerR - 0.42, r1 = d.plinth.h * 1.42 + 0.35, hApex = 1.45 + 0.1 * d.ps;
      // nozzle
      bins.metal.add(latheGeo([[0, -0.1], [0.07, -0.1], [0.075, 0.0], [0.05, 0.05], [0.03, 0.09], [0.022, 0.1], [0, 0.1]], 10), rot.clone().multiply(M(c * r0, wy, s * r0)), col("#6a5a3e"));
      const pts: THREE.Vector3[] = [];
      for (let k = 0; k <= 22; k++) {
        const t = k / 22, r = r0 + (r1 - r0) * t, y = wy + 0.1 + hApex * 4 * t * (1 - t) * (1 - 0.25 * t) - 0.12 * t;
        pts.push(toW(c * r, y, s * r));
      }
      streamGeo(pts, (t) => 0.028 + 0.03 * t * t, 8, 1.2, 0.02, 0.48, pos, uv, idx);
      const lp = toW(c * r1, wy + 0.012, s * r1);
      foamRing(lp.x, lp.z, lp.y, 0.02, 0.42, 24, pos, uv, idx);
      // splash crown
      const crown: THREE.Vector3[] = [];
      for (let k = 0; k <= 4; k++) crown.push(new THREE.Vector3(lp.x, lp.y + k * 0.05, lp.z));
      streamGeo(crown, (t) => 0.06 + 0.12 * t, 10, 1.2, 0.02, 0.48, pos, uv, idx);
    }
    // pedestal spouts: short arcs out of the collar
    const ch = d.collar.h;
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2 + Math.PI / 4, c = Math.sin(a), s = Math.cos(a), r0 = ch * 0.72 * Math.SQRT1_2 * 1.414 + 0.22;
      const y0 = d.collar.y1 - 0.1 + 0.06;
      const pts: THREE.Vector3[] = [];
      for (let k = 0; k <= 12; k++) { const t = k / 12, r = r0 + 0.55 * t, y = y0 + 0.08 * Math.sin(t * Math.PI * 0.5) - (y0 - wy + 0.08) * t * t; pts.push(toW(c * r, y, s * r)); }
      streamGeo(pts, (t) => 0.024 + 0.02 * t, 6, 1.2, 0.02, 0.48, pos, uv, idx);
      const lp = toW(c * (r0 + 0.55), wy + 0.012, s * (r0 + 0.55));
      foamRing(lp.x, lp.z, lp.y, 0.02, 0.26, 18, pos, uv, idx);
    }
    // foam hugging the plinth + the inner wall at the waterline
    foamSquare(d.plinth.h, wy + 0.01, 0.1, pos, uv, idx, rot);
    { const w0 = toW(0, 0, 0); foamRing(w0.x, w0.z, Y0 + wy + 0.008, d.innerR - 0.06, d.innerR + 0.005, 96, pos, uv, idx, 4); }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx); g.computeVertexNormals();
    const tex = jetTexture().clone(); tex.needsUpdate = true;
    const jm = new THREE.MeshStandardMaterial({ map: tex, color: "#f4fdff", transparent: true, depthWrite: false, roughness: 0.08, metalness: 0, emissive: "#9fdde6", emissiveIntensity: 0.25, side: THREE.DoubleSide, name: "town:fountain-jets" });
    const jets = new THREE.Mesh(g, jm);
    jets.name = "fountain:jets"; jets.renderOrder = 2;
    extra.push(jets);
    ctx.onUpdate((_dt, t) => { tex.offset.x = -t * 1.6; animateWater([water], t); });
  }

  await pace.pause();
  // ---- the statue
  const statue = await buildGorillaStatue(ctx, d.statueHeight, pace);
  statue.applyMatrix4(rot.clone().multiply(M(0, d.top.y1, 0)));
  extra.push(statue);

  return { waterY: d.waterY, innerR: d.innerR, pedestalTopY: d.top.y1 };
}

// ---------------------------------------------------------------------------------------------------------------
// asset lab (slot "fountain"): hero fountain facing north (the midday sun is NNW → front-lit) + a
// smaller variant to show the R / statueHeight parameters
export async function lab(env: LabEnv) {
  await addFountain(env.ctx, env.bins, env.mats, env.at(0, 0, 0), env.extra, env.rng, { statueYaw: Math.PI });
  await addFountain(env.ctx, env.bins, env.mats, env.at(-11.5, 0, 9.5), env.extra, env.rng, { R: 3.0, statueHeight: 2.4, statueYaw: Math.PI * 0.75 });
}
export type { FountainDims };
