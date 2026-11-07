// Rock meshes: masonry-like sandstone / granite course blocks (sea cliffs, mesa walls, sea stacks, inland crags — all
// world-aligned, crisp bevels, a bedding groove + joint notches, lighter weathered tops, darker undercuts), chunky
// grey boulders (lichen + moss) and faceted glossy basalt crags / obsidian shards. Instanced from the deterministic
// `terrainRocks()` list — the SAME list the server turns into colliders (terrainRockColliders), so what you see is what
// you collide with.
//
// Cost model (≤ ~0.3 ms of the terrain budget), three rings per (material, variant):
//  • NEAR: HI geometry, only the instances within ~100 m (re-packed when the camera has moved 8 m; bounding sphere →
//    frustum culled), casts shadows.
//  • MID: LO geometry, 100–330 m, same re-pack; only rocks ≥ 4 m cast (custom depth material collapses the rest).
//  • FAR: an ultra-light geometry (12–20 tris) holding EVERY instance in static buffers. The vertex shader collapses
//    instances the near / mid rings draw (aTier > 0) and small rocks far away; its depth material collapses everything
//    except big rocks seen from the air → far rocks never rasterise into the ground cascades.
import * as THREE from "three";
import { mergeGeometries, mergeVertices, toCreasedNormals } from "three/addons/utils/BufferGeometryUtils.js";
import type { WorldCtx } from "../../engine/engine";
// (the tier crossfades' screen-door noise moves with the TAA jitter — engine/dither.ts — so a rock in its
// crossfade band resolves to a soft blend instead of a fixed stipple)
import { SEED_GLSL } from "../../engine/dither";
import { Simplex2, mulberry32 } from "../../../../shared/world/noise";
import { WORLD } from "../../../../shared/world/map";
import { ROCK_CARVE, STACK_CORNER, STACK_TAPER, terrainRocks, type RockInstance, type RockKind, type TerrainData } from "../../../../shared/world/terrain-gen";
import { GLSL_COMMON, terrainCellTexture, terrainNoiseTexture } from "./material";
import { sculptStack } from "./stackgeo";
import { SKIN_HI, SKIN_MID, buildCliffSkins } from "./cliffskin";
import { layerIndex, LAYERS, type LayerArrays } from "./textures";
import { flag } from "../../flags";

type Mat = "block" | "slab" | "basalt" | "stack" | "boulder" | "crag" | "spire" | "shard" | "tor";
const MATS: Mat[] = ["block", "slab", "basalt", "stack", "boulder", "crag", "spire", "shard", "tor"];
const VARIANTS = 4;
/** (perf) shape variants actually built per material (instances of variant v use v % NV): fewer buckets = fewer
 * draws per ring — the random yaw / tilt / non-uniform scale per instance already hides the repetition */
// (perf: crag / spire / tor 1, boulder 2 — every variant is a draw call in every ring)
const NV: Record<Mat, number> = { block: 1, slab: 1, basalt: 1, stack: 1, boulder: 2, crag: 1, spire: 1, shard: 1, tor: 1 };
/** HI geometry within this distance (m) of the camera, plus 1.5 × the rock's size */
// (carved tiers: the HI grid + 3 displacement evaluations per vertex is the expensive part — keep it to the first ~36 m)
const HI_DIST: Record<Mat, number> = { block: 36, slab: 36, basalt: 36, stack: 260, boulder: 50, crag: 36, spire: 60, shard: 24, tor: 70 };
/** LO geometry out to this distance (m); beyond it the far set draws the instance (cliff blocks: a crisp 12-tri box) */
const MID_D: Record<Mat, number> = { block: 220, slab: 200, basalt: 200, stack: 350, boulder: 330, crag: 330, spire: 330, shard: 330, tor: 330 };
const matOf = (k: RockKind): Mat => k;
/** (lodv) sea-stack tier distances (m from the stack's footprint) */
const STACK_HI_D = 110, STACK_LO_D = 320;
/** dithered tier crossfades + shrink fades (?lodv=1; ?lodv=0 = off) */
export const ROCK_LODV = flag("lodv");

// 3D noise from three 2D simplex planes (cheap, seeded)
function n3(s: Simplex2, x: number, y: number, z: number) { return (s.noise(x, y) + s.noise(y + 31.7, z) + s.noise(z + 11.3, x)) / 3; }
function fbm3(s: Simplex2, x: number, y: number, z: number, o = 3) { let a = 1, f = 1, sum = 0, nrm = 0; for (let i = 0; i < o; i++) { sum += a * n3(s, x * f, y * f, z * f); nrm += a; a *= 0.5; f *= 2.1; } return sum / nrm; }

/** clamp every vertex behind K seeded planes → flat chunky facets (the soft rounding in between reads as a bevel) */
function chisel(p: THREE.BufferAttribute, cuts: Array<[THREE.Vector3, number]>) {
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    for (const [cn, d] of cuts) { const k = v.dot(cn); if (k > d) v.addScaledVector(cn, d - k); }
    p.setXYZ(i, v.x, v.y, v.z);
  }
}
function planes(rnd: () => number, n: number, depth: [number, number], yBias: number): Array<[THREE.Vector3, number]> {
  const out: Array<[THREE.Vector3, number]> = [];
  for (let i = 0; i < n; i++) {
    const v = new THREE.Vector3(rnd() * 2 - 1, (rnd() * 2 - 1) * (1 - yBias), rnd() * 2 - 1).normalize();
    out.push([v, depth[0] + rnd() * (depth[1] - depth[0])]);
  }
  return out;
}

/** per-vertex convexity (+ ridge / − cavity), from the umbrella Laplacian, normalised to about −1..1 */
function curvature(g: THREE.BufferGeometry) {
  const p = g.attributes.position as THREE.BufferAttribute, nrm = g.attributes.normal as THREE.BufferAttribute, idx = g.index!;
  const n = p.count, acc = new Float32Array(n * 3), cnt = new Float32Array(n), len = new Float32Array(n);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), nn = new THREE.Vector3();
  for (let t = 0; t < idx.count; t += 3) {
    const i0 = idx.getX(t), i1 = idx.getX(t + 1), i2 = idx.getX(t + 2);
    for (const [i, j] of [[i0, i1], [i1, i2], [i2, i0], [i1, i0], [i2, i1], [i0, i2]]) {
      acc[i * 3] += p.getX(j); acc[i * 3 + 1] += p.getY(j); acc[i * 3 + 2] += p.getZ(j); cnt[i]++;
      a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, j); len[i] += a.distanceTo(b);
    }
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (!cnt[i]) continue;
    a.fromBufferAttribute(p, i); b.set(acc[i * 3] / cnt[i], acc[i * 3 + 1] / cnt[i], acc[i * 3 + 2] / cnt[i]);
    nn.fromBufferAttribute(nrm, i);
    const el = len[i] / cnt[i] || 1;
    out[i] = Math.max(-1, Math.min(1, a.sub(b).dot(nn) / el * 4));
  }
  g.setAttribute("aCurv", new THREE.BufferAttribute(out, 1));
}


/** normals + curvature, bounds normalised to ±0.5 (instance scale = size in metres); flat = faceted (crags) */
function finish(g: THREE.BufferGeometry, flat = false): THREE.BufferGeometry {
  g.computeBoundingBox();
  const bb = g.boundingBox!, sz = new THREE.Vector3(), ct = new THREE.Vector3();
  bb.getSize(sz); bb.getCenter(ct);
  g.translate(-ct.x, -ct.y, -ct.z); g.scale(1 / sz.x, 1 / sz.y, 1 / sz.z);
  g.computeVertexNormals();
  curvature(g);
  if (flat) {
    const curv = g.attributes.aCurv;
    g = g.toNonIndexed(); g.computeVertexNormals();
    const idx = new Uint32Array(g.attributes.position.count); for (let i = 0; i < idx.length; i++) idx[i] = i;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    void curv;
  }
  g.computeBoundingBox(); g.computeBoundingSphere();
  return g;
}


/** chunky boulder: noisy sphere, 9 chisel planes (flat facets + soft bevels), flattened buried base */
function sculptBoulder(seed: number, lod: number): THREE.BufferGeometry {
  const lo = lod > 0;
  const s = new Simplex2(seed), rnd = mulberry32(seed);
  const off = rnd() * 50;
  const cuts = planes(rnd, 9, [0.27, 0.42], 0);
  let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(0.5, lod === 0 ? 3 : lod === 1 ? 1 : 0);
  g.deleteAttribute("normal"); g.deleteAttribute("uv"); g = mergeVertices(g, 1e-4);
  const p = g.attributes.position as THREE.BufferAttribute, v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    v.multiplyScalar(1 + 0.2 * fbm3(s, v.x * 1.6 + off, v.y * 1.6, v.z * 1.6, 2));
    v.y = v.y > 0 ? v.y * 0.9 : v.y * 0.75;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  chisel(p, cuts);
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    if (!lo) v.multiplyScalar(1 + 0.022 * fbm3(s, v.x * 6 + off, v.y * 6, v.z * 6, 2));
    if (v.y < -0.3) v.y = -0.3 + (v.y + 0.3) * 0.3;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  return finish(g);
}

/** basalt crag / obsidian shard: elongated, tapering, many planar cuts, then a little post-cut undulation and SMOOTH
 * normals — flat facets with softly rounded edges. (Flat-shaded cuts catch the sun's specular per facet
 * as one uniform flash → black tops + light-grey sides.) */
function sculptCrag(seed: number, lod: number, shard: boolean): THREE.BufferGeometry {
  const s = new Simplex2(seed), rnd = mulberry32(seed);
  const off = rnd() * 50;
  const cuts = planes(rnd, lod === 2 ? 8 : 16, [0.2, 0.42], 0.25);
  // (perf: HI detail 2 — the 16 chisel planes carry the shape; detail 3 cost 1280 tris per basalt chunk)
  let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(0.5, lod === 0 ? 2 : lod === 1 ? 1 : 0);
  g.deleteAttribute("normal"); g.deleteAttribute("uv"); g = mergeVertices(g, 1e-4);
  const p = g.attributes.position as THREE.BufferAttribute, v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    v.multiplyScalar(1 + 0.28 * fbm3(s, v.x * 2 + off, v.y * 2, v.z * 2, 2));
    v.y *= shard ? 1.8 : 1.3; v.x *= shard ? 0.6 : 1;
    if (v.y > 0.15) { const k = 1 - (v.y - 0.15) * (shard ? 0.95 : 0.6); v.x *= k; v.z *= k; }
    p.setXYZ(i, v.x, v.y, v.z);
  }
  chisel(p, cuts);
  if (lod === 0) for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    v.multiplyScalar(1 + 0.02 * fbm3(s, v.x * 7 + off, v.y * 7, v.z * 7, 2));
    if (v.y < -0.32) v.y = -0.32 + (v.y + 0.32) * 0.3;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  return finish(g);
}

/** A cliff TIER / stack SECTION as one continuous mass — a box grid (open at the bottom; wall columns also at
 * the back, which is buried in the wall) with rows clustered at the edges so the rounded bevels (radius `r`, metres at
 * the nominal size) keep their shape. It is deliberately plain: the vertex shader carves the world-aligned strata
 * grooves, per-band recesses, vertical joints and erosion into it (KR_DISP in rockMaterial), so strata line up across
 * neighbouring columns and never stretch with the instance scale. */
function gridBox(sx: number, sy: number, sz: number, r: number, dx: number, dy: number, withBack: boolean, fine = true): THREE.BufferGeometry {
  const hx = sx / 2, hy = sy / 2, hz = sz / 2;
  // `fine`: two rows in each bevel (a round profile); coarse LODs keep one (a chamfer)
  const sym = (h: number, step: number) => {
    const out = fine ? [-h, -h + 0.3 * r, -h + r] : [-h, -h + r], n = Math.max(1, Math.round((2 * h - 2 * r) / step));
    for (let i = 1; i < n; i++) out.push(-h + r + (2 * h - 2 * r) * i / n);
    if (fine) out.push(h - r, h - 0.3 * r, h); else out.push(h - r, h);
    return out;
  };
  const xs = sym(hx, dx);
  const ys: number[] = []; { const n = Math.max(1, Math.round((2 * hy - r) / dy)); for (let i = 0; i <= n; i++) ys.push(-hy + (2 * hy - r) * i / n); if (fine) ys.push(hy - 0.3 * r); ys.push(hy); }
  // depth: symmetric for stacks; wall columns only need detail near the front (+z)
  const zs = withBack ? sym(hz, dx) : (fine ? [-hz, -hz + (2 * hz - 3.6) * 0.5, hz - 3.6, hz - 2, hz - r, hz - 0.3 * r, hz] : [-hz, hz - 3, hz - r, hz]).filter((v, i, a) => i === 0 || v > a[i - 1] + 1e-3);
  const pos: number[] = [], idx: number[] = [];
  // one face grid: p(u, v) for u in us, v in vs; `n` = outward normal (winding fixed per face)
  const face = (us: number[], vs: number[], p: (u: number, v: number) => [number, number, number], n: [number, number, number]) => {
    const base = pos.length / 3, W = us.length;
    for (const v of vs) for (const u of us) pos.push(...p(u, v));
    const P = (k: number) => new THREE.Vector3(pos[(base + k) * 3], pos[(base + k) * 3 + 1], pos[(base + k) * 3 + 2]);
    const a = P(0), b = P(1), c = P(W), cr = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    const flip = cr.x * n[0] + cr.y * n[1] + cr.z * n[2] < 0;
    for (let j = 0; j + 1 < vs.length; j++) for (let i = 0; i + 1 < W; i++) {
      const k0 = base + j * W + i, k1 = k0 + 1, k2 = k0 + W, k3 = k2 + 1;
      if (flip) idx.push(k0, k2, k1, k1, k2, k3); else idx.push(k0, k1, k2, k1, k3, k2);
    }
  };
  face(xs, ys, (u, v) => [u, v, hz], [0, 0, 1]);
  if (withBack) face(xs, ys, (u, v) => [u, v, -hz], [0, 0, -1]);
  face(zs, ys, (u, v) => [hx, v, u], [1, 0, 0]);
  face(zs, ys, (u, v) => [-hx, v, u], [-1, 0, 0]);
  face(xs, zs, (u, v) => [u, hy, v], [0, 1, 0]);
  let g: THREE.BufferGeometry = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
  g = mergeVertices(g, 1e-4);
  const p = g.attributes.position as THREE.BufferAttribute, v = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    // round every exposed edge (the bottom, and a wall column's buried back, stay square)
    c.set(Math.max(-hx + r, Math.min(hx - r, v.x)), Math.min(hy - r, v.y), withBack ? Math.max(-hz + r, Math.min(hz - r, v.z)) : Math.min(hz - r, v.z));
    const d = v.clone().sub(c); if (d.lengthSq() > 1e-9) d.normalize().multiplyScalar(r);
    p.setXYZ(i, c.x + d.x, c.y + d.y, c.z + d.z);
  }
  return finish(g);
}
/** per material: nominal size (m), bevel radius (m), [HI, LO, FAR] grid steps (dx, dy) */
const COLUMN_GEO: Partial<Record<Mat, { size: [number, number, number]; r: number; steps: Array<[number, number]>; back: boolean }>> = {
  // (1.4 m vertical-edge radius — rounded buttresses, not cardboard boxes)
  block: { size: [9, 11, 14], r: 1.4, steps: [[0.6, 0.38], [2.2, 1.1], [4.5, 3.2]], back: false },
  slab: { size: [11, 11, 14], r: 2.2, steps: [[0.7, 0.45], [2.4, 1.3], [4.5, 3.4]], back: false },
  basalt: { size: [9, 11, 14], r: 0.6, steps: [[0.5, 0.42], [2.2, 1.2], [4.5, 3.4]], back: false },
  // (one instance per stack mass, 10–40 m tall: built at 30 m nominal height so the rows stay ~0.4–0.5 m apart)
  // (corner radius 4.2 — rounded, not rectangular columns)
  stack: { size: [12, 30, 12], r: STACK_CORNER * 12, steps: [[0.7, 0.42], [1.8, 1.0], [3.4, 2.6]], back: true },
};
const colGeoCache = new Map<string, THREE.BufferGeometry>();
function sculptColumn(m: Mat, lod: number): THREE.BufferGeometry {
  const key = `${m}:${lod}`, hit = colGeoCache.get(key); if (hit) return hit;
  const c = COLUMN_GEO[m]!, [dx, dy] = c.steps[lod];
  const g = gridBox(c.size[0], c.size[1], c.size[2], c.r, dx, dy, c.back, lod === 0);
  colGeoCache.set(key, g);
  return g;
}

/** crag PEAK: a tall jagged rock mass — a tapering, pointed body
 * cut by steep planes (flat facets, crisp arêtes), vertical flutes / gully grooves down its faces, a broken summit and a
 * buried flared base. Used for the cone's rim + spur-crest crags (tor) and the jointed crag faces round the volcano
 * foot and on inland walls (spire). */
function sculptPeak(seed: number, lod: number): THREE.BufferGeometry {
  // (so the spur-crest crags never read as khaki boxes): a jagged BASALT CRAG — a steep pyramid with 6–9 sharp
  // vertical arêtes and fluted faces between them, small horizontal ledges (columnar breaks), a broken summit with 1–3
  // pinnacles, steep planar cuts (mostly vertical normals → cliffy facets, never a flat-topped box) and a flared base
  const s = new Simplex2(seed), rnd = mulberry32(seed);
  const off = rnd() * 50, lean = (rnd() - 0.5) * 0.3, nA = 6 + ((rnd() * 4) | 0), aOff = rnd() * 6.283;
  const horns: Array<[number, number, number]> = [];
  for (let h = 0, nH = 1 + ((rnd() * 3) | 0); h < nH; h++) horns.push([rnd() * 6.283, h === 0 ? 0 : 0.12 + 0.12 * rnd(), h === 0 ? 1 : 0.55 + 0.3 * rnd()]);
  // (not smooth grey pyramids): more, DEEPER planar cuts (broken faces, crisp arêtes) + creased normals below (flat
  // facets that catch the light one by one, like the target art's jagged basalt peaks)
  const cuts = planes(rnd, lod === 2 ? 10 : 18, [0.13, 0.36], 0.55);
  let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(0.5, lod === 0 ? 4 : 2);
  g.deleteAttribute("normal"); g.deleteAttribute("uv"); g = mergeVertices(g, 1e-4);
  const p = g.attributes.position as THREE.BufferAttribute, v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    v.multiplyScalar(1 + 0.24 * fbm3(s, v.x * 1.7 + off, v.y * 1.7, v.z * 1.7, 2));
    const hN = Math.max(0, Math.min(1, (v.y + 0.5)));                // 0 foot … 1 top
    v.y *= 2.1;
    // taper to a pointed summit; the extra horns lift where their bearing points
    const ang = Math.atan2(v.z, v.x);
    let k = Math.max(0.07, 1 - 0.88 * Math.pow(hN, 1.15));
    for (const [ha, hr, hs] of horns) { const da = Math.cos(ang - ha); if (hr > 0 && hN > 0.55) k = Math.max(k, hs * Math.max(0.07, 1 - 0.95 * hN) * (0.6 + 0.4 * da)); }
    // arêtes: a |sin| profile around the axis — sharp crests between concave fluted faces
    const fl = Math.abs(Math.sin((ang + aOff) * nA / 2 + 0.9 * s.noise(v.y * 1.4 + off, 3.3)));
    k *= 1 - 0.28 * (1 - Math.pow(fl, 0.5));
    // columnar breaks: small horizontal ledges every ~12 % of the height
    const band = (v.y * 4.2 + 0.6 * s.noise(ang * 2, off)) % 1;
    k *= 1 - 0.035 * Math.max(0, Math.min(1, (band < 0 ? band + 1 : band) * 6 - 5));
    v.x = v.x * k + lean * hN * 0.5; v.z *= k;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  chisel(p, cuts);
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    if (lod === 0) v.multiplyScalar(1 + 0.018 * fbm3(s, v.x * 9 + off, v.y * 3, v.z * 9, 2));
    if (v.y < -0.8) v.y = -0.8 + (v.y + 0.8) * 0.3;                  // flared, buried base
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g = finish(g);
  if (lod === 2) return g;
  const curv = g.attributes.aCurv as THREE.BufferAttribute, pos = g.attributes.position as THREE.BufferAttribute;
  const key = (x: number, y: number, z: number) => `${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}`;
  const map = new Map<string, number>(); for (let i = 0; i < pos.count; i++) map.set(key(pos.getX(i), pos.getY(i), pos.getZ(i)), curv.getX(i));
  const cg = toCreasedNormals(g, 0.5);
  const cp = cg.attributes.position as THREE.BufferAttribute, out = new Float32Array(cp.count);
  for (let i = 0; i < cp.count; i++) out[i] = map.get(key(cp.getX(i), cp.getY(i), cp.getZ(i))) ?? 0;
  cg.setAttribute("aCurv", new THREE.BufferAttribute(out, 1));
  cg.computeBoundingBox(); cg.computeBoundingSphere();
  return cg;
}

/** obsidian: an angular glassy block — few, large planar cuts,
 * almost no noise, CREASED normals (flat facets, crisp edges) */
function sculptObsidian(seed: number, lod: number, shard: boolean): THREE.BufferGeometry {
  const rnd = mulberry32(seed);
  // (fewer, deeper cuts — angular glassy chunks with crisp edges, not rounded lumps)
  const cuts = planes(rnd, lod === 2 ? 6 : 9, [0.1, 0.28], 0.15);
  // (far set: detail 0 and smooth-indexed — ~1 100 badlands rocks × a creased detail-1 mesh was 270 k far vertices)
  let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(0.5, lod === 0 ? 2 : lod === 1 ? 1 : 0);
  g.deleteAttribute("normal"); g.deleteAttribute("uv"); g = mergeVertices(g, 1e-4);
  const p = g.attributes.position as THREE.BufferAttribute, v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    v.y *= shard ? 1.9 : 0.95; v.x *= shard ? 0.65 : 1.25;
    if (shard && v.y > 0) { const k = 1 - v.y * 0.9; v.x *= k; v.z *= k; }
    p.setXYZ(i, v.x, v.y, v.z);
  }
  chisel(p, cuts);
  for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i); if (v.y < -0.3) v.y = -0.3 + (v.y + 0.3) * 0.3; p.setXYZ(i, v.x, v.y, v.z); }
  g = finish(g);
  if (lod === 2) return g;
  const curv = g.attributes.aCurv as THREE.BufferAttribute;
  // crease at 34°: the thin facets a chisel cut leaves along an edge shade with their neighbours
  // instead of flashing as separate grey slivers; the big cut faces (> 34° apart) stay crisp
  const cg = toCreasedNormals(g, 0.6);
  // carry the per-vertex curvature over (creased geometry is non-indexed: look it up by position)
  const pos = g.attributes.position as THREE.BufferAttribute, key = (x: number, y: number, z: number) => `${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}`;
  const map = new Map<string, number>(); for (let i = 0; i < pos.count; i++) map.set(key(pos.getX(i), pos.getY(i), pos.getZ(i)), curv.getX(i));
  const cp = cg.attributes.position as THREE.BufferAttribute, out = new Float32Array(cp.count);
  for (let i = 0; i < cp.count; i++) out[i] = map.get(key(cp.getX(i), cp.getY(i), cp.getZ(i))) ?? 0;
  cg.setAttribute("aCurv", new THREE.BufferAttribute(out, 1));
  cg.computeBoundingBox(); cg.computeBoundingSphere();
  return cg;
}

/** lod 0 = HI (near), 1 = LO (mid ring), 2 = ultra-light (far, whole island) */
function sculpt(m: Mat, seed: number, lod: number) {
  if (COLUMN_GEO[m]) return sculptColumn(m, lod);
  if (m === "boulder") return sculptBoulder(seed, lod);
  if (m === "tor" || m === "spire") return sculptPeak(seed, lod);
  if (m === "crag" || m === "shard") return sculptObsidian(seed, lod, m === "shard");
  return sculptCrag(seed, lod, false);
}

/** GLSL (vertex): the world-aligned carving of cliff tiers / stack sections. uDispA = (band thickness, groove depth,
 * joint depth, erosion depth) m, uDispB = (per-band recess max, joint spacing, joint coverage 0..1, top undulation).
 * Every term is an INSET (the mass never grows past its instance box = its collider). */
const DISP_PARS = /* glsl */`
  uniform vec4 uDispA; uniform vec4 uDispB; uniform vec4 uDispC; uniform vec4 uDispD;
  float krH1(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
  // the slowly varying noises, fetched ONCE per vertex (the finite-difference taps reuse them)
  struct KrQ { float warp; float e2; float top; };
  KrQ krQ(vec3 w, float seed) {
    KrQ q;
    // strata: world-Y bands shared by neighbouring columns, gently undulating / dipping over ~100–200 m
    q.warp = (textureLod(tNoise, w.xz * (1.0 / 1280.0), 0.0).a - 0.44) * 3.0 + (textureLod(tNoise, w.xz * (1.0 / 256.0) + 0.5, 0.0).r - 0.5) * 0.6;
    q.e2 = textureLod(tNoise, (w.xz - w.y * vec2(0.3, 0.5)) * (1.0 / 160.0) + seed * 0.11, 0.0).a;   // ~20 m bulges
    q.top = textureLod(tNoise, w.xz * (1.0 / 40.0) + seed * 0.21, 0.0).a;
    return q;
  }
  // EVERY term of the carving is CONTINUOUS (stepping the per-band recess and the groove depth at every bedding plane
  // and switching the joints per band pair swung the finite-difference normals across a plane 60–80°, and N·L painted
  // hard dark tongues):
  //  • the bedding groove is a rounded U centred ON the plane (the band's top rolls back over ~45 % of the band, the band
  //    above overhangs it with a ~22 % lip) — depth 1 at the plane, 0 mid-band, zero slope at both ends
  //  • the per-band recess cross-fades between neighbouring bands INSIDE the groove (±20 % of a band, ≥ 0.4 m)
  //  • joints fade out toward every bedding plane (they end in the groove instead of jumping sideways)
  float krWallInset(vec3 w, vec2 nh, float seed, float amp, KrQ q, out vec2 info) {
    vec2 th = vec2(-nh.y, nh.x);
    float t = w.y / uDispA.x + q.warp;
    float bi = floor(t), f = fract(t), e = min(f, 1.0 - f);
    float gs = 1.0 - smoothstep(0.0, f > 0.5 ? 0.45 : 0.22, e);
    float g = gs * gs;
    float tb = t - 0.5, bb = floor(tb);
    float rec = mix(krH1(bb * 7.31 + seed), krH1((bb + 1.0) * 7.31 + seed), smoothstep(0.3, 0.7, fract(tb))) * uDispB.x;
    float jg = floor(bi * 0.5 + krH1(seed));
    float al = dot(w.xz, th) / uDispB.y + krH1(jg * 3.7 + seed * 1.3) * 5.0;
    float joint = smoothstep(0.78, 0.97, abs(fract(al) - 0.5) * 2.0) * step(krH1(jg * 5.1 + floor(al + 0.5) * 1.7 + seed * 0.7), uDispB.z)
      * smoothstep(0.0, 0.22, e);
    // erosion: ~6 m lumps (per tap) + ~20 m bulges (per vertex), always inward
    float e1 = uDispC.y > 0.5 ? 0.5 : textureLod(tNoise, (w.xz + w.y * vec2(0.6, -0.4)) * (1.0 / 48.0) + seed * 0.37, 0.0).a;
    float ero = uDispA.w * (smoothstep(0.25, 0.75, e1) * 0.55 + smoothstep(0.25, 0.75, q.e2) * 0.45);
    // x: undercut / joint darkness (the rolled-back top of each band under the lip above; a little on the lip), y: f
    info = vec2(max(g * (f > 0.5 ? 0.7 : 0.25), joint * 0.6), f);
    // far ring (coarse rows): no grooves / joints (they would alias), only the (smooth) band recesses + erosion
    return amp * ((g * uDispA.y + joint * uDispA.z) * (1.0 - uDispC.y) + rec + ero);
  }
  // one carved sample: side = wall weight (1 on the walls AND on the flat top's outer ring, so the cap follows the carved
  // wall instead of overhanging it as a lid), nh = horizontal outward direction of the column's rounded cross-section
  vec3 krDisp(vec3 w, vec2 nh, float side, float topW, float wiMax, float seed, float amp, KrQ q, out vec2 info) {
    float wi = min(krWallInset(w, nh, seed, amp, q, info), wiMax);
    float ti = uDispB.w * amp * smoothstep(0.3, 0.75, q.top) * topW;
    info.x *= side;
    return -vec3(nh.x, 0.0, nh.y) * wi * side - vec3(0.0, ti, 0.0);
  }
  // column cross-section in the instance's metric frame: (inside distance to the rounded-rect side, outward direction)
  // uDispD = (corner radius at the nominal size, nominal x, nominal z, 1 = open at the back (wall columns))
  vec3 krSection(vec2 lp, vec2 hs, vec3 ss) {
    float rr = min(uDispD.x * min(ss.x / uDispD.y, ss.z / uDispD.z), min(hs.x, hs.y) * 0.95);
    vec2 sg = vec2(lp.x >= 0.0 ? 1.0 : -1.0, lp.y >= 0.0 ? 1.0 : -1.0);
    vec2 ap = abs(lp);
    if (uDispD.w > 0.5 && lp.y < 0.0) ap.y = 0.0;                       // a wall's buried back is never an edge
    vec2 qd = ap - (hs - rr);
    float dOut = length(max(qd, 0.0)) + min(max(qd.x, qd.y), 0.0) - rr;
    // outward direction: the corner arc's normal in the corners, the nearer side elsewhere — blended over ~1 m across the
    // diagonals of the flat top (a hard switch folded narrow stack tops into an X)
    vec2 gl = normalize(max(qd, vec2(0.0)) + 0.35 * exp((qd - max(qd.x, qd.y)) / 0.5));
    return vec3(-dOut, gl * sg);
  }
  // instance frame → displaced local position + (withN: the colour pass, within ~75 m) the displaced object-space normal
  // from two finite-difference taps, clamped to ≤ 25° from the macro face and faded to the macro face with distance
  void krCarve(vec3 pos, vec3 nrm, bool withN, out vec3 dLocal, out vec3 objN, out vec2 info) {
    dLocal = vec3(0.0); objN = nrm; info = vec2(0.0);
    #ifdef USE_INSTANCING
      mat3 im = mat3(instanceMatrix);
      vec3 sc = vec3(dot(im[0], im[0]), dot(im[1], im[1]), dot(im[2], im[2]));
      vec3 ss = sqrt(sc);
      vec3 Rx = im[0] / ss.x, Ry = im[1] / ss.y, Rz = im[2] / ss.z;
      // stacks: a continuous taper (uDispC.x metres of inset per metre above the section's foot, every side, top included)
      vec3 tpos = pos;
      float hU = (pos.y + 0.5) * ss.y;
      if (uDispC.x > 0.0) { tpos.x *= 1.0 - 2.0 * uDispC.x * hU / ss.x; tpos.z *= 1.0 - 2.0 * uDispC.x * hU / ss.z; }
      vec2 hs = ss.xz * 0.5 - uDispC.x * hU;
      vec3 N = normalize(im * (nrm / sc));
      float seed = fract(sin(dot(instanceMatrix[3].xz, vec2(12.9898, 78.233))) * 43758.5453) * 91.0;
      float amp = clamp(min(ss.x, ss.y) / 6.0, 0.2, 1.0);                   // small fallen blocks: shallower carving
      // rounded top edge: the rim of the top face and the top of the walls follow one quarter-circle shoulder (radius
      // uDispC.z m) — no square cut edge, no flat lid overhanging the carved faces
      vec2 lp = tpos.xz * ss.xz;
      vec3 sec = krSection(lp, hs, ss);
      float din = max(sec.x, 0.0), depth = max((0.5 - pos.y) * ss.y, 0.0), Rq = min(uDispC.z, 0.45 * min(hs.x, hs.y));
      vec2 sh = vec2(0.0);                                                  // (inward, down) shoulder offset (m)
      if (Rq > 0.05 && din < Rq && depth < Rq) {
        vec2 v = vec2(din, depth) - Rq; float lv = length(v);
        if (lv > Rq) { vec2 np = Rq + v / lv * Rq; sh = np - vec2(din, depth); }
      }
      float vf = smoothstep(0.3, 0.75, 1.0 - abs(N.y));
      // the flat top's outer ring follows the carved wall below it; the ring is ≤ 0.8 × the top's half-width and the inset
      // it carries is capped so the ring never folds over itself (narrow stack tips)
      float rimR = min(max(2.5, 1.6 * (uDispA.y + uDispA.z + uDispA.w + uDispB.x) * amp), 0.8 * min(hs.x, hs.y));
      float side = max(vf, 1.0 - smoothstep(0.0, rimR, din));
      float wiMax = rimR / 1.6 + vf * 99.0;
      float topW = smoothstep(0.35, 0.8, N.y) * (1.0 - side);
      vec3 nhW = normalize(Rx * sec.y + Rz * sec.z);
      vec2 nh = nhW.xz;
      vec3 P = (instanceMatrix * vec4(tpos, 1.0)).xyz - nhW * sh.x - Ry * sh.y;   // (the rock group sits at the origin)
      KrQ q = krQ(P, seed);
      vec3 d0 = krDisp(P, nh, side, topW, wiMax, seed, amp, q, info);
      vec3 dW = d0 - nhW * sh.x - Ry * sh.y;
      dLocal = tpos - pos + vec3(dot(Rx, dW) / ss.x, dot(Ry, dW) / ss.y, dot(Rz, dW) / ss.z);
      // the shoulder tilts the macro face (a rounded top edge shades rounded — also in the mid / far rings)
      vec3 Nm = N;
      if (length(sh) > 1e-3) { vec3 cN = normalize(nhW * (Rq - din - sh.x) + Ry * (Rq - depth - sh.y)); Nm = normalize(mix(N, cN, smoothstep(0.0, 0.3, length(sh)))); }
      objN = vec3(dot(im[0], Nm), dot(im[1], Nm), dot(im[2], Nm));
      if (withN) {
        float camD = distance(cameraPosition, P);
        vec3 Nn = Nm;
        if (camD < 80.0) {
          vec3 T = abs(Nm.y) < 0.98 ? normalize(cross(vec3(0.0, 1.0, 0.0), Nm)) : vec3(1.0, 0.0, 0.0);
          vec3 B = normalize(cross(Nm, T));
          float ez = 0.3;                                                 // ≈ the HI grid spacing (no sub-row aliasing)
          vec2 i1;
          vec3 d1 = krDisp(P + T * ez, nh, side, topW, wiMax, seed, amp, q, i1);
          vec3 d2 = krDisp(P + B * ez, nh, side, topW, wiMax, seed, amp, q, i1);
          Nn = normalize(cross(T * ez + d1 - d0, B * ez + d2 - d0));
          if (dot(Nn, Nm) < 0.0) Nn = -Nn;
          // ≤ 25° from the macro face: undercuts darken through the albedo (info.x) + real shadows, never through a
          // normal that swings past the sun's terminator
          float c = dot(Nn, Nm); vec3 tv = Nn - Nm * c; float s = length(tv);
          if (s > 0.4663 * c) Nn = normalize(Nm + tv / max(s, 1e-5) * 0.4663);
          Nn = normalize(mix(Nn, Nm, smoothstep(50.0, 80.0, camD)));
        }
        objN = vec3(dot(im[0], Nn), dot(im[1], Nn), dot(im[2], Nn));
      }
    #endif
  }`;

/** radius (m) of the rounded shoulder along every carved mass's top edge (no square cut edges / turf lids) */
const SHOULDER: Record<keyof typeof ROCK_CARVE, number> = { block: 2.2, slab: 2.6, basalt: 0.9, stack: 1.8 };
/** the shared carving table (terrain-gen ROCK_CARVE — the colliders use the same numbers) as shader uniforms */
const carve = (k: keyof typeof ROCK_CARVE, taper = 0) => { const c = ROCK_CARVE[k], g = COLUMN_GEO[k]!;
  return { a: new THREE.Vector4(c.band, c.groove, c.joint, c.erosion), b: new THREE.Vector4(c.recess, c.jointSpacing, c.jointCover, c.top),
    c: new THREE.Vector4(taper, 0, SHOULDER[k], 0), d: new THREE.Vector4(g.r, g.size[0], g.size[2], g.back ? 0 : 1) }; };
type Disp = ReturnType<typeof carve>;

/** shadow-depth material for carved rocks (the undisplaced box would shadow the carved surface inside it) */
function dispDepthMaterial(disp: Disp) {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uDispA = { value: disp.a }; shader.uniforms.uDispB = { value: disp.b }; shader.uniforms.uDispC = { value: disp.c }; shader.uniforms.uDispD = { value: disp.d };
    shader.uniforms.tNoise = { value: terrainNoiseTexture() };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\nuniform sampler2D tNoise;\n${DISP_PARS}`)
      .replace("#include <begin_vertex>", /* glsl */`vec3 krDL, krON; vec2 krInf; krCarve(position, normal, false, krDL, krON, krInf);
        vec3 transformed = vec3(position) + krDL;`)
      .replace("#include <project_vertex>", `#include <project_vertex>\n${CAST_COLLAPSE}`);
    shader.uniforms.uRkCam = SHARED.cam;
    shader.vertexShader = shader.vertexShader.replace("#include <common>", "#include <common>\nuniform vec3 uRkCam;");
  };
  m.customProgramCacheKey = () => "kr-rock-depth-disp8";
  return m;
}

/** (perf) the near ring draws every HI instance in ONE draw; its shadow program collapses the instances beyond the
 * contact-shadow reach (CAST_NEAR + half the rock's size) (no separate casting ring: one draw less per material) */
const CAST_COLLAPSE = /* glsl */`
  #ifdef USE_INSTANCING
  { float szC = max(length(instanceMatrix[0].xyz), max(length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz)));
    if (distance(instanceMatrix[3].xyz, uRkCam) - 0.5 * szC > 32.0) gl_Position = vec4(0.0, 0.0, 2.0, 1.0); }
  #endif`;
function castDepthMaterial() {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uRkCam = SHARED.cam;
    shader.vertexShader = shader.vertexShader.replace("#include <common>", "#include <common>\nuniform vec3 uRkCam;")
      .replace("#include <project_vertex>", `#include <project_vertex>\n${CAST_COLLAPSE}`);
  };
  m.customProgramCacheKey = () => "kr-rock-depth-cast1";
  return m;
}

/** GLSL: instance centre + size from instanceMatrix; `krFarCull` collapses what the far set must not draw */
const CULL_PARS = /* glsl */`
  uniform vec3 uRkCam; uniform vec4 uRkCull; // x: small-rock size, y: small-rock max distance, z: shadow reach k, w: aerial
  attribute float aHi;
  float krInstSize() { return max(length(instanceMatrix[0].xyz), max(length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz))); }`;

function rockMaterial(arrays: LayerArrays, layer: number, opts: { moss: number; strata: boolean; wear: number; gloss?: number; tint?: [number, number, number]; tile?: number; nrm?: number; top?: string; topMix?: number; bounce?: number; capOnly?: number; groundTint?: boolean; nearD?: number; grit?: string; disp?: Disp; stack?: boolean; glow?: boolean; loMerged?: boolean; lod?: [number, number, number]; skinTier?: 0 | 1 | 2; stackTier?: 0 | 1 | 2 }, tier: 0 | 1 | 2) {
  // tier 0 = near rings (HI geometry, full carving + finite-difference normals), 1 = mid ring (LO geometry, band steps +
  // erosion only, geometric normals; the band shading still paints the strata), 2 = far set (carved only from the air)
  const far = tier === 2;
  const L = LAYERS[layer];
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  const tint = opts.tint ?? L.tint;
  const uniforms = {
    tAlb: { value: arrays.albedo }, tNrm: { value: arrays.normal },
    uLayer: { value: layer }, uTile: { value: L.tile * (opts.tile ?? 0.55) }, uTint: { value: new THREE.Vector3(...tint) }, uNrm: { value: opts.nrm ?? 0.8 },
    uSat: { value: L.sat }, uMoss: { value: opts.moss }, uStrata: { value: opts.strata ? 1 : 0 }, uRough: { value: L.rough },
    uWear: { value: opts.wear }, uGloss: { value: opts.gloss ?? 0 },
    /** layer sampled on up-facing faces (weathered sandy / gritty tops instead of the wall texture's bedding lines), −1 = same */
    uTop: { value: opts.top ? layerIndex(opts.top) : -1 },
    uTopTint: { value: new THREE.Vector3(...(opts.top ? LAYERS[layerIndex(opts.top)].tint : [1, 1, 1])) },
    uTopSat: { value: opts.top ? LAYERS[layerIndex(opts.top)].sat : 0 },
    /** 1 = the top layer everywhere on top faces, 0..1 = mottled with the wall's own grit */
    uTopMix: { value: opts.topMix ?? 1 },
    uMossTint: { value: new THREE.Vector3(0.30, 0.46, 0.13) },
    uRkCam: SHARED.cam, uRkCull: SHARED.cull, tNoise: { value: terrainNoiseTexture() },
    /** painted bounce: faces turned away from the sun get a warm lift (dark rock never crushes to black in shade) */
    uBounce: { value: opts.bounce ?? 0 }, uRkSun: SHARED.sun,
    /** 1 = the top layer (turf) only on instances flagged cap (true tops + deep ledges); other tops = weathered grit */
    uCapOnly: { value: opts.capOnly ?? 0 },
    /** carved cliff tiers / stack sections: world-aligned strata grooves, joints, erosion (vertex shader) */
    uDispA: { value: opts.disp?.a ?? new THREE.Vector4() }, uDispB: { value: opts.disp?.b ?? new THREE.Vector4() }, uDispC: { value: opts.disp?.c ?? new THREE.Vector4() }, uDispD: { value: opts.disp?.d ?? new THREE.Vector4() },
    uDispOn: { value: opts.disp ? 1 : 0 },
    /** mid / far rings: the same carving without grooves / joints (uDispC.y = 1) */
    uDispCFar: { value: opts.disp ? new THREE.Vector4(opts.disp.c.x, 1, opts.disp.c.z, 0) : new THREE.Vector4() },
    /** the terrain's baked top-down albedo (turf tops take the ground's colour); y = 1 when present */
    tGround: SHARED.ground, uGround: SHARED.groundOn,
    /** 0 = never (sea stacks stand in water: the ground map there is sea-floor sand) */
    uGroundMat: { value: opts.groundTint === false ? 0 : 1 },
    /** full triplanar + detail normals within this distance (m); beyond it one projection (faceted tors stretch there) */
    uNearD: { value: opts.nearD ?? 70 },
    /** layer for the tops of bare (non-cap) ledges, −1 = the wall's own texture */
    uGritL: { value: opts.grit ? layerIndex(opts.grit) : -1 },
    /** sculpted sea stacks (stackgeo.ts): per-block tone (aTint), turf only on the top ~3 m, moss on ledges above
     * the splash zone, a wet dark band at the waterline (world metres, not the unit box) */
    uStack: { value: opts.stack ? 1 : 0 },
    /** lava-field obsidian: glowing fissures through the lower half of the rocks near the volcano */
    tCell: { value: terrainCellTexture() }, uTime: SHARED.time,
    /** merged far-stack mesh: centres of the stacks currently drawn by their own HI mesh (collapsed here) */
    uHiStacks: { value: Array.from({ length: 8 }, () => new THREE.Vector4(1e9, 0, 0, 0)) },
    /** (lodv) x = HI distance, y = MID distance, z = crag (rubble rule), w = 1 */
    uRkLod: { value: new THREE.Vector4(...(opts.lod ?? [0, 0, 0]), 1) },
  };
  const disp = !!opts.disp;
  // (lodv) instanced rock tiers DITHER-CROSSFADE over a distance band (near ↔
  // mid ↔ far, complementary screen-door masks: never both, never neither), rubble with no far tier SHRINKS out, the far
  // set's small-rock cut shrinks out — no rock appears, vanishes or switches shape in one frame (?lodv=1)
  const lodv = ROCK_LODV && !!opts.lod;
  // (lodv) sculpted cliff skins: HI < 90 m < MID < 420 m < LO, dithered over 20 / 60 m bands (per-tile centre attribute)
  const skin = ROCK_LODV && (opts.skinTier !== undefined || opts.stackTier !== undefined);
  const stk = opts.stackTier;
  mat.userData.hiU = uniforms.uHiStacks.value;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    if (tier > 0) shader.uniforms.uDispC = uniforms.uDispCFar;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>
        attribute float aCurv; varying vec3 vRWPos; varying float vCurv; varying vec3 vLocal; varying vec3 vRScale; varying float vRkCap; varying vec2 vDsp;
        ${opts.stack ? "attribute float aTint; varying float vTint; attribute float aDepth; varying float vDepth;" : ""}
        ${opts.loMerged ? "attribute vec3 aStack; uniform vec4 uHiStacks[8];" : ""}
        ${disp ? "uniform sampler2D tNoise;\n" + DISP_PARS : ""}
        ${far ? CULL_PARS : ""}
        ${lodv ? `${far ? "" : "uniform vec3 uRkCam; uniform vec4 uRkCull;"} uniform vec4 uRkLod; attribute vec2 aRkI; varying float vRkW;
        // tier weight (signed: > 0 keep where dither < w, < 0 keep where dither ≥ 1 + w) and shrink scale of this instance
        void krRkW(out float w, out float s) {
          float reach = aRkI.x, sz = aRkI.y, dc = distance(instanceMatrix[3].xyz, uRkCam), d = max(0.0, dc - reach);
          float Hn = uRkLod.x + 0.5 * sz, B1 = max(6.0, 0.25 * Hn), E = uRkLod.y + 2.0 * sz;
          if (sz < 3.2) E = min(E, uRkLod.z > 0.5 ? 170.0 : 220.0);
          if (sz < 2.0) E = min(E, uRkLod.z > 0.5 ? 100.0 : 150.0);
          if (sz < 1.2) E = min(E, 100.0);
          float B2 = max(20.0, 0.2 * E), up = smoothstep(Hn, Hn + B1, d), dn = smoothstep(E, E + B2, d);
          s = 1.0;
          ${tier === 0 ? "w = 1.0 - up;"
            : tier === 1 ? `if (d < Hn + B1) w = -up; else if (sz >= ${FAR_MIN.toFixed(2)}) w = 1.0 - dn; else { w = 1.0; float Bs = max(15.0, 0.15 * E); s = 1.0 - smoothstep(E - Bs, E, d); }`
            : `w = -dn; if (sz < uRkCull.x) s = 1.0 - smoothstep(uRkCull.y * 0.85, uRkCull.y, dc);`}
        }` : ""}
        ${skin && stk !== undefined ? `uniform vec3 uRkCam; varying float vRkW;
        // sea stacks: HI < ${STACK_HI_D} m < MID < ${STACK_LO_D} m < merged LO (only the ≤ 8 slotted stacks per material crossfade)
        void krRkW(out float w, out float s) {
          s = 1.0; float d;
          ${stk < 2 ? `d = max(0.0, distance(instanceMatrix[3].xyz, uRkCam) - 0.5 * max(length(instanceMatrix[0].xyz), length(instanceMatrix[2].xyz)));`
            : `d = 1e9; for (int i = 0; i < 8; i++) if (distance(aStack, uHiStacks[i].xyz) < 0.5) d = max(0.0, distance(aStack, uRkCam) - uHiStacks[i].w);`}
          float up = smoothstep(${STACK_HI_D.toFixed(1)}, ${(STACK_HI_D + 20).toFixed(1)}, d), dn = smoothstep(${STACK_LO_D.toFixed(1)}, ${(STACK_LO_D + 50).toFixed(1)}, d);
          ${stk === 0 ? "w = 1.0 - up;" : stk === 1 ? `w = d < ${(STACK_HI_D + 20).toFixed(1)} ? -up : 1.0 - dn;` : "w = d > 1e8 ? 1.0 : -dn;"}
        }` : ""}
        ${skin && stk === undefined ? `${far ? "" : "uniform vec3 uRkCam;"} attribute vec4 aSkinC; varying float vRkW;
        void krRkW(out float w, out float s) {
          float d = max(0.0, distance(aSkinC.xyz, uRkCam) - aSkinC.w), up = smoothstep(${SKIN_HI.toFixed(1)}, ${(SKIN_HI + 20).toFixed(1)}, d), dn = smoothstep(${SKIN_MID.toFixed(1)}, ${(SKIN_MID + 60).toFixed(1)}, d);
          s = 1.0; ${opts.skinTier === 0 ? "w = 1.0 - up;" : opts.skinTier === 1 ? "w = d < " + (SKIN_HI + 20).toFixed(1) + " ? -up : 1.0 - dn;" : "w = -dn;"}
        }` : ""}`)
      .replace("#include <beginnormal_vertex>", disp ? /* glsl */`vec3 krDL = vec3(0.0), objectNormal = normal; vec2 krInf = vec2(0.0);
        ${far ? (lodv ? `{ float w0, s0; krRkW(w0, s0);   // far instances that are not drawn: no carving work; the aerial carve eases in
          if (uRkCull.w > 0.001 && abs(w0) > 0.001 && s0 > 0.001) { krCarve(position, normal, false, krDL, objectNormal, krInf); krDL *= uRkCull.w; objectNormal = normalize(mix(normal, objectNormal, uRkCull.w)); } }`
          : `{ float sz0 = krInstSize(), d0 = distance(instanceMatrix[3].xyz, uRkCam);   // collapsed far instances: no carving work
          if (uRkCull.w > 0.5 && !(aHi > 0.5 || (sz0 < uRkCull.x && d0 > uRkCull.y) || (sz0 < 1.2 && d0 > uRkCull.y * 0.45))) krCarve(position, normal, false, krDL, objectNormal, krInf); }`)
          : `krCarve(position, normal, ${tier === 0}, krDL, objectNormal, krInf);`}
        vDsp = krInf;`
        : "#include <beginnormal_vertex>\n vDsp = vec2(0.0);")
      // cap flag (turf top) rides in the instance colour's red channel (+10 = cap), decoded here
      .replace("#include <color_vertex>", `#include <color_vertex>
        vRkCap = ${opts.stack ? "1.0" : "0.0"};
        #ifdef USE_INSTANCING_COLOR
          vRkCap = step(5.0, instanceColor.x); vColor.x -= 10.0 * vRkCap;
        #endif`)
      .replace("#include <begin_vertex>", /* glsl */`${disp ? "vec3 transformed = vec3(position) + krDL;" : "#include <begin_vertex>"}
        ${lodv ? "float krW, krS; krRkW(krW, krS); vRkW = krW; transformed *= krS;" : skin ? "float krW, krS; krRkW(krW, krS); vRkW = krW;" : ""}
        vCurv = aCurv; vLocal = position;${opts.stack ? " vTint = aTint; vDepth = aDepth;" : ""}
        { vec4 wp = vec4(transformed, 1.0);
          vRScale = vec3(1.0);
          #ifdef USE_INSTANCING
            wp = instanceMatrix * wp;
            vRScale = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
          #endif
          vRWPos = (modelMatrix * wp).xyz; }`)
      .replace("#include <project_vertex>", lodv || skin ? /* glsl */`#include <project_vertex>
        if (abs(krW) < 0.001 || krS < 0.001) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);` : opts.loMerged ? /* glsl */`#include <project_vertex>
        for (int i = 0; i < 8; i++) if (distance(aStack, uHiStacks[i].xyz) < 0.5) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);` : far ? /* glsl */`#include <project_vertex>
        { float sz = krInstSize(); float d = distance(instanceMatrix[3].xyz, uRkCam);
          if (aHi > 0.5 || (sz < uRkCull.x && d > uRkCull.y) || (sz < 1.2 && d > uRkCull.y * 0.45)) gl_Position = vec4(0.0, 0.0, 2.0, 1.0); }` : "#include <project_vertex>");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", /* glsl */`#include <common>
        precision highp sampler2DArray;
        uniform sampler2DArray tAlb; uniform sampler2DArray tNrm;
        uniform int uLayer; uniform float uTile; uniform vec3 uTint; uniform float uSat; uniform float uMoss; uniform float uStrata; uniform float uRough;
        uniform float uWear; uniform float uGloss; uniform vec3 uMossTint; uniform float uNrm; uniform float uTop;
        uniform vec3 uTopTint; uniform float uTopSat; uniform float uTopMix; uniform float uBounce; uniform vec3 uRkSun;
        varying vec3 vRWPos; varying float vCurv; varying vec3 vLocal; varying vec3 vRScale; varying float vRkCap; uniform float uCapOnly;
        varying vec2 vDsp; uniform float uDispOn; uniform sampler2D tGround; uniform vec2 uGround; uniform float uGroundMat; uniform float uNearD; uniform float uGritL;
        uniform float uStack; ${opts.stack ? "varying float vTint; varying float vDepth;" : ""}
        ${opts.glow ? "uniform sampler2D tCell; uniform float uTime; vec3 rkEmis;" : ""}
        ${GLSL_COMMON}
        vec3 rkAlb; float rkRough; vec3 rkN;
        ${lodv || skin ? "varying float vRkW;" : ""}`)
      .replace("#include <clipping_planes_fragment>", lodv || skin ? /* glsl */`#include <clipping_planes_fragment>
        if (abs(vRkW) < 0.999) {
          float krDi = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))${SEED_GLSL});
          if (vRkW > 0.0 ? krDi >= vRkW : krDi < 1.0 + vRkW) discard;
        }` : "#include <clipping_planes_fragment>")
      .replace("#include <map_fragment>", /* glsl */`
        {
          vec3 p = vRWPos; float layer = float(uLayer);
          vec3 wN = normalize(transpose(mat3(viewMatrix)) * normalize(vNormal));
          // carved tiers: where a strata step falls inside one grid row the triangle is a sliver whose interpolated
          // normal disagrees with its real facing (an overhang's underside shaded like a lit face, with stretched texture):
          // use the true facet normal there and darken it like the shadowed undercut it is
          float rkSliver = 0.0;
          if (uDispOn > 0.5) {
            vec3 gN = normalize(cross(dFdx(vRWPos), dFdy(vRWPos)));
            if (dot(gN, cameraPosition - vRWPos) < 0.0) gN = -gN;
            // (only strong disagreements — the carving is continuous, so real slivers are rare)
            rkSliver = smoothstep(0.45, 0.15, dot(gN, wN)) * step(gN.y, 0.2);
            wN = normalize(mix(wN, gN, rkSliver));
          }
          float rkD = distance(cameraPosition, p);
          bool rkNear = rkD < uNearD;
          // hard-edged dark tongues on the sunlit stack faces came from here: beyond
          // uNearD, picking ONE projection (the dominant axis) made the albedo jump on every bulging / turned face
          // between the x- and z-projected textures along the 45° diagonal: hard-edged light / dark tongues exactly where
          // the carved faces turned (and only in sun: the texture's baked shading reads strongest lit). Far blends the
          // projections softly (power 4 — usually 2 fetches) and skips only the normal maps.
          vec3 tw = pow(abs(wN), vec3(rkNear ? 10.0 : 4.0)); tw /= (tw.x + tw.y + tw.z);
          vec2 ux = vec2(p.z, -p.y) / uTile, uy = p.xz / uTile, uz = vec2(p.x, -p.y) / uTile;
          // up-facing faces of sandstone / basalt blocks: a weathered TOP (grass turf mottled with sand for sandstone —
          // the target art's grassy ledges and stack caps; gritty cinder for basalt) instead of the wall's bedding
          // lines (every carved TIER top is a planted ledge — tiers are 14–20 m tall, their tops are the target art's
          // grassy ledges; bare sandy grit read as bald beige shelves)
          bool tierTop = (0.5 - vLocal.y) * vRScale.y < 2.2 && wN.y > 0.3;
          bool topF = uTop >= 0.0 && wN.y > 0.0 && (uCapOnly < 0.5 || vRkCap > 0.5 || (uDispOn > 0.5 && tierTop));
          ${opts.stack ? "topF = topF && vDepth < 3.2;" : ""}
          // bare ledge tops of carved tiers: sandy grit (albedo AND normal — the wall's normal map from above drew its
          // bedding lines as bright stripes along every lip)
          // (+ the UNDERSIDES of carved overhangs: the wall texture projected from above drew its bedding lines along them)
          bool gritF = !topF && ((uGritL >= 0.0 && wN.y > 0.25) || (uDispOn > 0.5 && wN.y < -0.2));
          float topL = topF ? uTop : layer;
          vec2 uyT = topF ? uy * 2.6 : uy;
          // (axes with a negligible blend weight are not fetched — most rock pixels face one axis)
          tw = mix(vec3(0.0), tw, step(vec3(0.03), tw)); tw /= max(1e-4, tw.x + tw.y + tw.z);
          vec4 flatN = vec4(0.5, 0.5, 1.0, 0.9);
          // (bare ledge tops: the wall texture's MEAN colour (a deep mip) + a flat normal — any projected texture turned the
          // narrow rounded lips into striped "birch-bark" rails)
          vec4 ax = tw.x > 0.0 ? texture(tAlb, vec3(ux, layer)) : vec4(0.0), ay = tw.y > 0.0 ? (gritF ? textureLod(tAlb, vec3(uyT * 0.5, topL), 6.0) : texture(tAlb, vec3(uyT, topL))) : vec4(0.0), az = tw.z > 0.0 ? texture(tAlb, vec3(uz, layer)) : vec4(0.0);
          vec4 nx4 = rkNear && tw.x > 0.0 ? texture(tNrm, vec3(ux, layer)) : flatN, ny4 = rkNear && tw.y > 0.0 && !gritF ? texture(tNrm, vec3(uyT, topL)) : flatN, nz4 = rkNear && tw.z > 0.0 ? texture(tNrm, vec3(uz, layer)) : flatN;
          vec3 cx = satAdjust(ax.rgb, uSat) * uTint, cz = satAdjust(az.rgb, uSat) * uTint, cy;
          if (topF && tw.y > 0.0) {
            vec3 turf = satAdjust(ay.rgb, uTopSat) * uTopTint;
            vec3 grit = satAdjust(texture(tAlb, vec3(uy * 1.3, layer)).rgb, uSat) * uTint * 0.9;
            float tm = smoothstep(0.38, 0.55, nT(p.xz * 0.045 + 0.3).a + 0.25 * smoothstep(0.3, 0.45, vLocal.y));
            tm = tm * uTopMix + (1.0 - uTopMix);
            // cap blocks (column tops, deep ledges): solid turf with a thin weathered stone lip along the edges
            // (the turf runs right over the rounded shoulder and spills down the faces — no stone lip, no lid)
            if (uCapOnly > 0.5) tm = 1.0;
            // stack tops: olive moss mottled with bare rock (the target art's tops are rock with tufts + plants, not
            // a lime lawn lid)
            if (uStack > 0.5) { tm = smoothstep(0.34, 0.62, nT(p.xz * 0.09 + 0.2).a + 0.12 * (nT(p.xz * 0.5).b - 0.5)); turf *= vec3(0.7, 0.78, 0.6); }
            // the turf takes the colour of the island's ground right there (the baked top-down albedo): cliff
            // tops melt into the plateau's grass instead of reading as lime squares from the air
            if (uGround.y > 0.5 && uGroundMat > 0.5) {
              vec3 gcol = texture(tGround, vec2((p.x + uGround.x) / (2.0 * uGround.x), 1.0 - (p.z + uGround.x) / (2.0 * uGround.x))).rgb;
              float det = clamp(dot(turf, vec3(0.3, 0.5, 0.2)) / max(1e-3, dot(uTopTint, vec3(0.3, 0.5, 0.2)) * 0.32), 0.55, 1.5);
              turf = mix(turf, gcol * mix(1.0, det, 0.55), mix(0.6, 1.0, smoothstep(40.0, 220.0, rkD)));
            }
            cy = mix(grit, turf, tm);
          } else if (gritF) {
            // weathered sandstone TOPS of bare ledges: sandy grit, a little lighter than the face
            cy = satAdjust(ay.rgb, -0.05) * uTint * (wN.y > 0.0 ? 1.08 + 0.12 * (nT(p.xz * 0.3).a - 0.5) : 0.6);
          } else cy = satAdjust(ay.rgb, uSat) * uTint * (uCapOnly > 0.5 ? 1.12 : 1.0);
          vec4 a = ax * tw.x + ay * tw.y + az * tw.z;
          vec3 nx = nx4.xyz * 2.0 - 1.0, ny = ny4.xyz * 2.0 - 1.0, nz = nz4.xyz * 2.0 - 1.0;
          vec3 wx = vec3(nx.z * sign(wN.x), nx.y, nx.x), wy = vec3(ny.x, ny.z, -ny.y), wz = vec3(nz.x, nz.y, nz.z * sign(wN.z));
          vec3 dn = normalize(wx * tw.x + wy * tw.y + wz * tw.z);
          vec3 col = cx * tw.x + cy * tw.y + cz * tw.z;
          if (uStrata > 0.5) col *= strata(p);
          // carved tiers: faces seen at a grazing angle (the rounded strata lips from the cliff foot) take the texture's
          // mean colour, a touch lighter — the wall texture's bedding lines compressed onto them read as stripes
          if (uDispOn > 0.5) {
            float graze = 1.0 - smoothstep(0.06, 0.22, abs(dot(wN, normalize(cameraPosition - p))));
            if (graze > 0.01) col = mix(col, satAdjust(textureLod(tAlb, vec3(uz * 0.3, layer), 7.0).rgb, uSat) * uTint, graze * 0.7);
          }
          // stylized wear: worn lighter edges, darker dirty cavities
          col *= 1.0 + uWear * (0.26 * smoothstep(0.05, 0.6, vCurv) - 0.3 * smoothstep(0.0, -0.7, vCurv));
          // sunlit weathered tops lighter, darker damp undercut at the base of every block / boulder
          col *= 0.92 + 0.16 * smoothstep(-0.2, 0.8, wN.y);
          if (uDispOn > 0.5) {
            // carved tiers: dark damp grooves / joints, the upper lip of every band sun-bleached, a damp foot (metres)
            col *= (1.0 - 0.5 * vDsp.x) * (1.0 + 0.12 * smoothstep(0.5, 0.75, vDsp.y) * (1.0 - smoothstep(0.75, 0.85, vDsp.y)));
            col *= mix(0.72, 1.0, smoothstep(0.0, 1.8, (vLocal.y + 0.5) * vRScale.y));
          } else if (uStack > 0.5) {
            // sculpted stacks: per-block tone, a dark wet band + algae line at the waterline, sun-bleached upper courses
            ${opts.stack ? "col *= vTint;" : ""}
            // (else the SW sea cliff reads as a smeared flat brown wall) from ~150 m the carved
            // courses are sub-pixel — paint them: 2–3 m bedding bands of varied tone with dark partings, less orange
            { float farB = smoothstep(110.0, 300.0, rkD);
              if (farB > 0.001) {
                float bw = p.y / 2.6 + (nT(p.xz * 0.004 + 0.7).a - 0.5) * 1.8, f = fract(bw), h1 = fract(sin(floor(bw) * 12.9898) * 43758.5453);
                float band = (0.74 + 0.36 * h1) * (1.0 - 0.38 * (1.0 - smoothstep(0.0, 0.16, f)));
                band *= 0.85 + 0.3 * nT(vec2(dot(p.xz, vec2(0.7, -0.7)) * 0.05, p.y * 0.01) + 0.31).r;
                col = mix(col, satAdjust(col, -0.3) * band, farB);
              } }
            col *= mix(0.55, 1.0, smoothstep(0.4, 2.2, p.y)) * (1.0 + 0.08 * smoothstep(8.0, 20.0, p.y));
            col = mix(col, vec3(0.1, 0.13, 0.07), 0.45 * smoothstep(1.4, 0.5, p.y) * smoothstep(-0.8, 0.2, p.y));
          } else col *= mix(0.64, 1.0, smoothstep(-0.5, -0.22, vLocal.y)) * (1.0 + 0.1 * smoothstep(0.3, 0.5, vLocal.y));
          // moss / lichen on up-facing faces (clumped), a thin green lip creeping over the top edge
          float moss = 0.0;
          if (uMoss > 0.0) {
            float mossN = nT((p.xz * 0.28 + p.y * 0.15) * 0.125).a;
            float up = smoothstep(0.55, 0.9, wN.y);
            float mossH = uStack > 0.5 ? smoothstep(3.0, 6.0, p.y) : smoothstep(0.1, 0.35, vLocal.y);
            moss = uMoss * up * smoothstep(0.36, 0.6, mossN) * mossH * (uCapOnly > 0.5 && vRkCap < 0.5 ? 0.2 : 1.0);
            col = mix(col, uMossTint * (0.72 + 0.55 * mossN), moss);
            if (rkNear) {
              // pale grey lichen crusts on the faces + dark rain streaks running down from the top edges
              float lichen = uMoss * 0.6 * smoothstep(0.6, 0.7, nT((p.xy * 0.9 + p.zy * 0.7) * 0.125).a) * (1.0 - up);
              col = mix(col, vec3(dot(col, vec3(0.33))) * vec3(1.08, 1.1, 1.06) + vec3(0.03), lichen);
              float streakR = smoothstep(0.55, 0.8, nT(vec2((p.x + p.z) * 0.07, p.y * 0.012)).a) * smoothstep(-0.1, 0.45, vLocal.y) * (1.0 - up);
              col *= 1.0 - 0.18 * streakR * uMoss;
            }
          }
          // (no square turf lids) cap masses: moss / turf DRAPES 1–3 m down the faces below the rounded
          // shoulder in uneven vertical tongues, with a darker damp fringe at its lower edge
          if ((uCapOnly > 0.5 && (vRkCap > 0.5 || uDispOn > 0.5) || uStack > 0.5) && uTop >= 0.0 && wN.y < 0.75) {
            float dTop = ${opts.stack ? "vDepth" : "(0.5 - vLocal.y) * vRScale.y"};
            float drape = nT(vec2((p.x + p.z) * 0.09, p.y * 0.015) + 0.13).a + 0.35 * (nT(vec2((p.x - p.z) * 0.37, p.y * 0.05)).r - 0.5);
            float patchy = smoothstep(0.32, 0.6, nT(vec2(p.x - p.z, p.y) * 0.017 + 0.71).a);
            float reach = mix(0.3, 0.6 + 2.3 * smoothstep(0.35, 0.75, drape), patchy);
            float spill = 1.0 - smoothstep(reach - 0.6, reach + 0.3, dTop);
            if (spill > 0.001) {
              vec3 turfC = satAdjust(texture(tAlb, vec3(vec2(p.x + p.z, p.y) * 0.34, uTop)).rgb, uTopSat) * uTopTint;
              if (uGround.y > 0.5 && uGroundMat > 0.5) turfC = mix(turfC, texture(tGround, vec2((p.x + uGround.x) / (2.0 * uGround.x), 1.0 - (p.z + uGround.x) / (2.0 * uGround.x))).rgb, 0.55);
              turfC *= 0.8 + 0.25 * smoothstep(-0.2, 0.6, wN.y);
              col = mix(col * (1.0 - 0.3 * smoothstep(reach + 0.8, reach + 0.1, dTop) * (1.0 - spill)), turfC, spill);
              moss = max(moss, spill);
            } else col *= 1.0 - 0.3 * smoothstep(reach + 0.8, reach + 0.1, dTop);
          }
          if (uBounce > 0.0) { float ndl = dot(wN, uRkSun); col *= mix(1.0 + uBounce, 1.0, smoothstep(-0.2, 0.6, ndl)) * mix(vec3(1.0), vec3(1.18, 1.04, 0.86), smoothstep(0.4, -0.2, ndl) * uBounce); }
          ${opts.glow ? `
          // (the target art's black rocks glow at their seams) cooling fissures — a cell-crack network
          // projected on the dominant face, glowing orange in the lower half of rocks in the lava field (some rocks, not all)
          rkEmis = vec3(0.0);
          {
            float vd = length(p.xz - vec2(-380.0, -430.0));
            float field = smoothstep(470.0, 400.0, vd) * smoothstep(0.3, 1.2, p.y) * (1.0 - smoothstep(120.0, 170.0, rkD));
            if (field > 0.01) {
              vec3 aw = abs(wN); vec2 cuv = aw.x > aw.z ? p.zy : p.xy; if (aw.y > 0.75) cuv = p.xz;
              // irregular branching fissures = the
              // lava-rock texture's crack pixels (hand-painted, never a regular cell net), ~2.6 m tiles
              // (only the cracks' hot yellow cores — a few long fissures, not a speckle of orange flecks)
              vec4 lt = texture(tAlb, vec3(cuv / 5.5 + 0.37, ${layerIndex("lava")}.0));
              float fis = smoothstep(0.05, 0.22, lt.r - lt.b) * smoothstep(0.14, 0.42, lt.r) * smoothstep(0.06, 0.22, lt.g - lt.b);
              float low = smoothstep(0.45, -0.1, vLocal.y) * smoothstep(0.22, 0.45, nT(p.xz * 0.013 + 0.77).a);
              float pulse = 0.8 + 0.2 * sin(uTime * 1.4 + p.x * 0.3 + p.z * 0.2);
              col *= 1.0 - 0.6 * fis * low * field;
              rkEmis = vec3(3.0, 0.8, 0.07) * fis * low * field * pulse + vec3(0.5, 0.08, 0.0) * smoothstep(-0.25, -0.45, vLocal.y) * field * low;   // + a warm underglow at the foot
            }
          }` : ""}
          rkAlb = col * (1.0 - 0.3 * rkSliver);
          // roughness from the normal maps' alpha (the arm roughness); glossy basalt: polished convex edges (edge highlights)
          float texR = nx4.a * tw.x + ny4.a * tw.y + nz4.a * tw.z;
          rkRough = mix(mix(texR * uRough, 0.3, uGloss * smoothstep(-0.2, 0.4, vCurv)), 1.0, moss);
          rkN = normalize(mix(wN, dn, uNrm * (1.0 - 0.6 * moss)));
        }
        diffuseColor.rgb *= rkAlb;`)
      .replace("#include <roughnessmap_fragment>", "float roughnessFactor = clamp(rkRough, 0.22, 1.0);")
      .replace("#include <emissivemap_fragment>", opts.glow ? "totalEmissiveRadiance += rkEmis;" : "#include <emissivemap_fragment>")
      .replace("#include <normal_fragment_maps>", "normal = normalize((viewMatrix * vec4(rkN, 0.0)).xyz);");
  };
  mat.customProgramCacheKey = () => `kr-rock15-${tier}-${disp ? 1 : 0}-${opts.stack ? 1 : 0}-${opts.glow ? 1 : 0}-${opts.loMerged ? 1 : 0}${lodv ? "-lodv1" : ""}${skin ? "-skin" + (opts.skinTier ?? "s" + stk) : ""}`;
  return mat;
}

/** far-ring shadow caster: collapses instances drawn by the near / mid rings and, on the ground, everything; from the
 * air (glide, aerial) the big rocks cast within a height-scaled reach */
function farDepthMaterial() {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uRkCam = SHARED.cam; shader.uniforms.uRkCull = SHARED.cull;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${CULL_PARS}`)
      .replace("#include <project_vertex>", /* glsl */`#include <project_vertex>
        { float sz = krInstSize(); float d = distance(instanceMatrix[3].xyz, uRkCam);
          if (aHi > 0.5 || uRkCull.w < 0.5 || sz < 3.5 || d > uRkCull.z) gl_Position = vec4(0.0, 0.0, 2.0, 1.0); }`);
  };
  m.customProgramCacheKey = () => "kr-rock-depth-far2";
  return m;
}
/** the rocks build before the terrain's far albedo bake: hand them the baked ground map after */
export function setRockGround(tex: THREE.Texture | null) { SHARED.ground.value = tex; SHARED.groundOn.value.set(WORLD.HALF, tex ? 1 : 0); }
const SHARED = {
  cam: { value: new THREE.Vector3(0, 1e5, 0) },
  ground: { value: null as THREE.Texture | null },
  groundOn: { value: new THREE.Vector2(1200, 0) },
  /** unit vector toward the sun (copied from atmos's ctx.shared "sunDir" in update) */
  sun: { value: new THREE.Vector3(-0.39, 0.67, -0.63) },
  time: { value: 0 },
  /** x: small-rock size (m), y: small rocks hidden beyond (m), z: shadow reach of a medium rock (m), w: aerial (1) */
  cull: { value: new THREE.Vector4(3, 260, 220, 0) },
};

export interface RocksHandle { group: THREE.Group; update(cam: THREE.Camera): void; instances: RockInstance[]; stats(): { near: number; mid: number; far: number } }

interface Ring { mesh: THREE.InstancedMesh; n: number; ai: THREE.InstancedBufferAttribute }
interface RockSet { mat: Mat; list: RockInstance[]; sizes: Float32Array; reach: Float32Array; matrices: Float32Array; colors: Float32Array; near: Ring; mid: Ring; flag: Float32Array;
  /** index of each instance in its material's far set (−1 = too small for the far set) */ farIdx: Int32Array; aHi: THREE.InstancedBufferAttribute[];
  /** spatial cells (CELL m) → instance indices; `maxSize` bounds the reach; `flagged` = indices flagged last pass */
  cells: Map<number, number[]>; maxSize: number; flagged: number[] }
const CELL = 64;
/** far-set chunk size (m): one frustum-culled InstancedMesh per chunk per material */
// (measured: 600 m chunks made ~40 far draws and cost MORE than one draw per material — draw overhead beats the saved
// vertex work of collapsed instances; kept as a knob)
const FAR_CHUNK = 1e5;
/** rocks smaller than this (m) are not in the far set */
const FAR_MIN = 2.5;
const cellKey = (cx: number, cz: number) => (cx + 512) * 1024 + (cz + 512);

export async function buildRocks(ctx: WorldCtx, t: TerrainData, arrays: LayerArrays): Promise<RocksHandle> {
  const instances = terrainRocks(t);
  await ctx.yield();   // (slice the terrain build: as ONE task it took 4–8 s)
  const ground = ctx.shared.get("terrainAlbedoMap") as THREE.Texture | undefined;
  SHARED.ground.value = ground ?? null; SHARED.groundOn.value.set(WORLD.HALF, ground ? 1 : 0);
  const group = new THREE.Group(); group.name = "terrain-rocks";
  const OPTS: Record<Mat, Parameters<typeof rockMaterial>[2] & { layer: string }> = {
    // turf ONLY on cap blocks (column tops + deep ledges); other course tops are weathered sandstone
    // carved tiers: the displacement params per rock type (see DISP_PARS: band, groove, joint, erosion | recess,
    // joint spacing, joint coverage, top undulation)
    block: { layer: "cliff", moss: 0.35, strata: false, wear: 0.8, tile: 1.1, nrm: 0.6, top: "grass", topMix: 0.85, capOnly: 1, grit: "sand", disp: carve("block") },
    stack: { layer: "cliff", moss: 0.45, strata: false, wear: 0.8, tile: 1.1, nrm: 0.6, top: "grass", topMix: 0.85, capOnly: 1, grit: "sand", groundTint: false, disp: carve("stack", STACK_TAPER) },
    // grey mossy granite faces on the tall inland walls (cove backslope, gorge): thicker, softer bands, more erosion
    // (the inland crag faces — warm grey-tan bedded granite, moss on the ledges)
    slab: { layer: "rock", moss: 0.6, strata: true, wear: 0.9, tint: [1.0, 0.95, 0.85], top: "grass", topMix: 0.6, capOnly: 1, disp: carve("slab") },
    // columnar basalt (black lava coast): thick bands, dense deep vertical joints
    basalt: { layer: "basalt", moss: 0.15, strata: false, wear: 0.9, gloss: 0.5, tile: 1.0, nrm: 0.6, top: "cinder", topMix: 1, disp: carve("basalt") },
    boulder: { layer: "rock", moss: 0.75, strata: false, wear: 1, tint: [1.0, 1.0, 0.98] },
    // glassy lava rock: warm dark grey with a readable value
    // range, worn lighter edges, satin (a 0.9 gloss mirrors the sky on every thin chisel facet as grey slivers)
    crag: { layer: "basalt", moss: 0.0, strata: false, wear: 1.3, gloss: 0.3, tint: [0.95, 0.9, 0.9], nrm: 0.75, glow: true, bounce: 0.2 },
    // the pinnacles ringing the cone's foot: the cone's own dark slate rock,
    // cool slate basalt, crisp worn edges (wear), no painted strata stripes
    spire: { layer: "basalt", moss: 0.08, strata: false, wear: 1.6, tint: [1.75, 1.85, 2.2], nrm: 0.8, gloss: 0.1, bounce: 0.3, nearD: 150 },
    shard: { layer: "basalt", moss: 0.0, strata: false, wear: 0.8, gloss: 0.95, tint: [0.42, 0.44, 0.52], nrm: 0.35 },
    // tor: slate basalt crags (the target art's cone rock: cool dark grey, lighter worn arêtes), matching the cone's
    // rib rock, with a painted bounce (a strong basalt tint crushes to near-black in shade with hot white sunlit tops)
    tor: { layer: "basalt", moss: 0.0, strata: false, wear: 1.6, tint: [1.75, 1.85, 2.2], nrm: 0.8, gloss: 0.1, bounce: 0.3, nearD: 150 },
  };
  const matNear = {} as Record<Mat, THREE.Material>, matMid = {} as Record<Mat, THREE.Material>, matFar = {} as Record<Mat, THREE.Material>, depthNear = {} as Partial<Record<Mat, THREE.Material>>;
  for (const m of MATS) {
    const o = { ...OPTS[m], lod: [HI_DIST[m], MID_D[m], m === "crag" ? 1 : 0] as [number, number, number] };
    matNear[m] = rockMaterial(arrays, layerIndex(o.layer), o, 0); matFar[m] = rockMaterial(arrays, layerIndex(o.layer), o, 2);
    // (lodv: the mid ring always gets its own program — its tier weights differ from the near ring's)
    matMid[m] = o.disp || ROCK_LODV ? rockMaterial(arrays, layerIndex(o.layer), o, 1) : matNear[m];
    depthNear[m] = o.disp ? dispDepthMaterial(o.disp) : castDepthMaterial();
  }
  const depthFar = farDepthMaterial();

  const buckets = new Map<string, RockInstance[]>();
  // carved tiers / stacks share ONE geometry per material (the shader carves each instance differently): one bucket, not
  // four identical ones (−27 draws)
  // sea stacks are unique sculpted meshes (stackgeo.ts) — not in the instanced buckets
  for (const r of instances) { if (r.kind === "stack") continue; const m = matOf(r.kind), key = `${m}:${r.v % NV[m]}`; (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(r); }
  const sets: RockSet[] = [];
  const q = new THREE.Quaternion(), e = new THREE.Euler(), sc = new THREE.Vector3(), pv = new THREE.Vector3(), m4 = new THREE.Matrix4();
  const tint = mulberry32(4242);
  const ring = (g: THREE.BufferGeometry, mat: THREE.Material, n: number, name: string, cast: boolean): Ring => {
    const mesh = new THREE.InstancedMesh(g, mat, n);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    mesh.count = 0; mesh.castShadow = cast; mesh.receiveShadow = true; mesh.name = name; mesh.visible = false;
    // camera-dependent content: explicit casting flag, never in the static far map (the far caster proxy is)
    mesh.userData.castShadow = cast; mesh.userData.farShadow = false;
    // (lodv) per-instance footprint reach + size for the shader's tier weights (rings own their geometry clone)
    const ai = new THREE.InstancedBufferAttribute(new Float32Array(n * 2), 2); ai.setUsage(THREE.DynamicDrawUsage);
    if (ROCK_LODV) { mesh.geometry = g.clone(); mesh.geometry.setAttribute("aRkI", ai); }
    group.add(mesh);
    return { mesh, n: 0, ai };
  };
  const farMeshes: THREE.InstancedMesh[] = [];
  for (const m of MATS) {
    await ctx.yield();
    // one FAR mesh per material (all variants share the ultra-light geometry of variant 0) — ≤ 8 draws for the island.
    // Only rocks ≥ FAR_MIN m: smaller ones are never drawn beyond the mid ring on the ground (and are sub-pixel from the air)
    const all: RockInstance[] = []; for (let v = 0; v < VARIANTS; v++) all.push(...(buckets.get(`${m}:${v}`) ?? []));
    if (!all.length) continue;
    const nFar = all.filter((r) => Math.max(r.sx, r.sy, r.sz) >= FAR_MIN).length;
    const gFar = sculpt(m, 900 + MATS.indexOf(m) * 10, 2);
    const farMat = new Float32Array(Math.max(1, nFar) * 16), farCol = new Float32Array(Math.max(1, nFar) * 3), farRk = new Float32Array(Math.max(1, nFar) * 2);
    // the far set is split into FAR_CHUNK-metre chunks (one frustum-culled InstancedMesh each): the ground
    // views skip the ~2/3 of the island behind / beside the camera
    const flagAll = new Float32Array(Math.max(1, nFar)), aHiList: THREE.InstancedBufferAttribute[] = [];
    const matSets: RockSet[] = [];
    let off = 0;
    for (let v = 0; v < VARIANTS; v++) {
      const list = buckets.get(`${m}:${v}`); if (!list?.length) continue;
      await ctx.yield();   // one sculpted variant per slice
      const seed = 900 + MATS.indexOf(m) * 10 + v;
      const gHi = sculpt(m, seed, 0), gLo = sculpt(m, seed, 1);
      const n = list.length;
      const matrices = new Float32Array(n * 16), colors = new Float32Array(n * 3), sizes = new Float32Array(n), farIdx = new Int32Array(n).fill(-1), reach = new Float32Array(n);
      list.forEach((r, i) => {
        e.set(r.tilt, r.yaw, 0); q.setFromEuler(e); sc.set(r.sx, r.sy, r.sz); pv.set(r.x, r.y, r.z);
        m4.compose(pv, q, sc).toArray(matrices, i * 16);
        const k = 0.86 + tint() * 0.26, w = (tint() - 0.5) * 0.08;
        colors[i * 3] = k * (1 + w) + (r.cap === 1 ? 10 : 0); colors[i * 3 + 1] = k; colors[i * 3 + 2] = k * (1 - w);
        sizes[i] = Math.max(r.sx, r.sy, r.sz);
        // footprint radius (deep wall tiers: half their width + a little, not half their buried depth)
        reach[i] = r.grp !== undefined && r.kind !== "stack" ? 0.5 * Math.max(r.sx, r.sy) : 0.5 * Math.max(r.sx, r.sz);
        if (sizes[i] >= FAR_MIN) { farMat.set(matrices.subarray(i * 16, i * 16 + 16), off * 16); farCol.set(colors.subarray(i * 3, i * 3 + 3), off * 3); farRk[off * 2] = reach[i]; farRk[off * 2 + 1] = sizes[i]; farIdx[i] = off++; }
      });
      // only the rocks within ~40 m cast into the dynamic cascades (the contact shadows); everything else gets its shadow
      // from atmos's static far map through the hidden far-caster proxy below. HI geometry in both near rings.
      const near = ring(gHi, matNear[m], n, `rocks-near-${m}-${v}`, true);
      if (depthNear[m]) near.mesh.customDepthMaterial = depthNear[m];

      const mid = ring(gLo, matMid[m], n, `rocks-mid-${m}-${v}`, false);
      const cells = new Map<number, number[]>(); let maxSize = 0;
      list.forEach((r, i) => { const key = cellKey(Math.floor(r.x / CELL), Math.floor(r.z / CELL)); (cells.get(key) ?? cells.set(key, []).get(key)!).push(i); maxSize = Math.max(maxSize, sizes[i]); });
      const set: RockSet = { mat: m, list, sizes, reach, matrices, colors, near, mid, flag: flagAll, farIdx, aHi: aHiList, cells, maxSize, flagged: [] };
      sets.push(set); matSets.push(set);
    }
    if (!nFar) continue;
    // sort the far instances by chunk, remap every set's farIdx, one InstancedMesh per chunk (aHi = a view of flagAll)
    const chunkOf = new Int32Array(nFar);
    // (one chunk: `floor(x / 1e5)` quadrant chunks would cost 4 far draws per material)
    for (let f = 0; f < nFar; f++) chunkOf[f] = FAR_CHUNK >= 1e4 ? 0 : cellKey(Math.floor(farMat[f * 16 + 12] / FAR_CHUNK), Math.floor(farMat[f * 16 + 14] / FAR_CHUNK));
    const order = Array.from({ length: nFar }, (_, f) => f).sort((a, b) => chunkOf[a] - chunkOf[b]);
    const newIdx = new Int32Array(nFar); order.forEach((f, i) => { newIdx[f] = i; });
    for (const st of matSets) for (let i = 0; i < st.farIdx.length; i++) if (st.farIdx[i] >= 0) st.farIdx[i] = newIdx[st.farIdx[i]];
    const fm2 = new Float32Array(nFar * 16), fc2 = new Float32Array(nFar * 3), fr2 = new Float32Array(nFar * 2);
    order.forEach((f, i) => { fm2.set(farMat.subarray(f * 16, f * 16 + 16), i * 16); fc2.set(farCol.subarray(f * 3, f * 3 + 3), i * 3); fr2[i * 2] = farRk[f * 2]; fr2[i * 2 + 1] = farRk[f * 2 + 1]; });
    for (let a = 0; a < nFar;) {
      let b = a; while (b < nFar && chunkOf[order[b]] === chunkOf[order[a]]) b++;
      const g = gFar.clone(), attr = new THREE.InstancedBufferAttribute(flagAll.subarray(a, b), 1);
      attr.setUsage(THREE.DynamicDrawUsage); g.setAttribute("aHi", attr); aHiList.push(attr);
      if (ROCK_LODV) g.setAttribute("aRkI", new THREE.InstancedBufferAttribute(fr2.slice(a * 2, b * 2), 2));
      const far = new THREE.InstancedMesh(g, matFar[m], b - a);
      far.instanceMatrix = new THREE.InstancedBufferAttribute(fm2.slice(a * 16, b * 16), 16); far.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      far.instanceColor = new THREE.InstancedBufferAttribute(fc2.slice(a * 3, b * 3), 3);
      far.customDepthMaterial = depthFar;
      far.computeBoundingSphere();
      // never casts: the dynamic cascades only cover the first ~120 m (the near / mid rings), the static far map gets
      // the rocks from the hidden far-caster proxy below
      far.frustumCulled = true; far.castShadow = false; far.receiveShadow = true; far.name = `rocks-far-${m}`;
      far.userData.castShadow = false; far.userData.farShadow = false;
      group.add(far); farMeshes.push(far);
      a = b;
    }
    // static far-map caster: every rock ≥ 4 m with the far geometry, hidden; atmos's bake forces it visible
    const big: number[] = []; for (let k = 0; k < all.length; k++) if (Math.max(all[k].sx, all[k].sy, all[k].sz) >= 4) big.push(k);
    if (big.length) {
      const px = new THREE.InstancedMesh(gFar, new THREE.MeshBasicMaterial({ colorWrite: false }), big.length);
      // carved kinds: the proxy box is pulled in by the carving depth, so the surface carved INTO the envelope never sits
      // inside its own far-map caster (self-shadowed sunlit cliff faces)
      // (pulled in by the FULL carve depth + 0.25 m, and the top by the shoulder — a shallower pull leaves joint and
      // bedding grooves inside their own caster: dark rectangular blotches on sunlit stack faces)
      const cv = OPTS[m].disp, carve = cv ? cv.a.y + cv.a.z + cv.a.w + cv.b.x + 0.25 : 0, drop = cv ? cv.c.z * 0.5 + 0.3 : 0;
      big.forEach((k, i) => { const r = all[k]; e.set(r.tilt, r.yaw, 0); q.setFromEuler(e); sc.set(Math.max(r.sx * 0.5, r.sx - 2 * carve), Math.max(r.sy * 0.6, r.sy - drop), Math.max(r.sz * 0.5, r.sz - 2 * carve)); pv.set(r.x, r.y - drop * 0.5, r.z); px.setMatrixAt(i, m4.compose(pv, q, sc)); });
      px.name = `rocks-shadow-proxy-${m}`; px.visible = false; px.castShadow = true; px.receiveShadow = false; px.frustumCulled = false;
      px.userData.farShadow = "force"; px.userData.castShadow = true; px.userData.receiveShadow = false;
      group.add(px);
    }
  }

  // ---- sculpted sea stacks: one unique mesh per mass (HI within STACK_HI m, LO beyond), a hidden LO caster for
  //      atmos's static far map, dynamic casting only close up
  const STACK_HI = 320, STACK_CAST = 40;
  const stkO = {
    sand: { moss: 0.5, strata: false, wear: 1.0, tile: 1.1, nrm: 0.55, top: "grass", topMix: 0.85, capOnly: 1, groundTint: false, stack: true },
    basalt: { moss: 0.12, strata: false, wear: 0.9, gloss: 0.5, tile: 1.0, nrm: 0.6, top: "cinder", topMix: 1, capOnly: 1, groundTint: false, stack: true },
  };
  // (lodv) HI / MID / merged-LO each with its own dither weight program; else one program for HI + MID
  const stackMat = {
    sand: rockMaterial(arrays, layerIndex("cliff"), { ...stkO.sand, ...(ROCK_LODV ? { stackTier: 0 as const } : {}) }, 0),
    basalt: rockMaterial(arrays, layerIndex("basalt"), { ...stkO.basalt, ...(ROCK_LODV ? { stackTier: 0 as const } : {}) }, 0),
  };
  const stackMidMat = ROCK_LODV ? {
    sand: rockMaterial(arrays, layerIndex("cliff"), { ...stkO.sand, stackTier: 1 }, 0),
    basalt: rockMaterial(arrays, layerIndex("basalt"), { ...stkO.basalt, stackTier: 1 }, 0),
  } : stackMat;
  const stackLoMat = {
    sand: rockMaterial(arrays, layerIndex("cliff"), { ...stkO.sand, loMerged: true, ...(ROCK_LODV ? { stackTier: 2 as const } : {}) }, 0),
    basalt: rockMaterial(arrays, layerIndex("basalt"), { ...stkO.basalt, loMerged: true, ...(ROCK_LODV ? { stackTier: 2 as const } : {}) }, 0),
  };
  const stacks: Array<{ r: RockInstance; hi: THREE.InstancedMesh; mid: THREE.InstancedMesh; bas: boolean }> = [];
  const loParts: Record<"sand" | "basalt", THREE.BufferGeometry[]> = { sand: [], basalt: [] };
  let nStack = 0;
  for (const r of instances) {
    if (r.kind !== "stack") continue;
    if ((++nStack & 3) === 0) await ctx.yield();
    const bas = r.style === "basalt", mat = bas ? stackMat.basalt : stackMat.sand, midMat = bas ? stackMidMat.basalt : stackMidMat.sand;
    e.set(0, r.yaw, 0); q.setFromEuler(e); sc.set(r.sx, r.sy, r.sz); pv.set(r.x, r.y, r.z); m4.compose(pv, q, sc);
    const one = (g: THREE.BufferGeometry, name: string, mt: THREE.Material = mat) => {
      const im = new THREE.InstancedMesh(g, mt, 1);
      im.setMatrixAt(0, m4); im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array([11, 1, 1]), 3);   // cap flag (+10)
      im.computeBoundingSphere(); im.name = name; im.castShadow = false; im.receiveShadow = true; im.visible = false;
      im.userData.castShadow = false; im.userData.farShadow = false;
      group.add(im); return im;
    };
    const hi = one(sculptStack(r, 0, bas), "rocks-stack-hi"), mid = one(sculptStack(r, 2, bas), "rocks-stack-mid", midMat);
    const gLo = sculptStack(r, 1, bas);
    // merged far set: world-space copy tagged with its stack centre (collapsed while the HI mesh draws it)
    const w = gLo.clone(); w.applyMatrix4(m4);
    const n = w.attributes.position.count, tag = new Float32Array(n * 3); for (let i = 0; i < n; i++) { tag[i * 3] = r.x; tag[i * 3 + 1] = r.y; tag[i * 3 + 2] = r.z; }
    w.setAttribute("aStack", new THREE.BufferAttribute(tag, 3));
    loParts[bas ? "basalt" : "sand"].push(w);
    // the far-map caster sits INSIDE the carved surface (pulled in by ~the deepest block recess): a caster poking out of
    // the sculpted faces self-shadowed them in sharp blotches
    const px = new THREE.InstancedMesh(gLo, new THREE.MeshBasicMaterial({ colorWrite: false }), 1);
    sc.set(Math.max(r.sx * 0.5, r.sx - 3.2), r.sy - 1.0, Math.max(r.sz * 0.5, r.sz - 3.2)); pv.set(r.x, r.y - 0.5, r.z);
    px.setMatrixAt(0, new THREE.Matrix4().compose(pv, q, sc)); px.name = "rocks-stack-shadow-proxy"; px.visible = false; px.castShadow = true; px.receiveShadow = false; px.frustumCulled = false;
    px.userData.farShadow = "force"; px.userData.castShadow = true; px.userData.receiveShadow = false;
    group.add(px);
    stacks.push({ r, hi, mid, bas });
  }
  const loMerged: Array<{ mesh: THREE.Mesh; mat: THREE.Material; key: "sand" | "basalt" }> = [];
  for (const key of ["sand", "basalt"] as const) {
    if (!loParts[key].length) continue;
    const g = mergeGeometries(loParts[key], false)!; g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, stackLoMat[key]); mesh.name = `rocks-stack-lo-${key}`; mesh.castShadow = false; mesh.receiveShadow = true;
    mesh.userData.castShadow = false; mesh.userData.farShadow = false; mesh.matrixAutoUpdate = false;
    group.add(mesh); loMerged.push({ mesh, mat: stackLoMat[key], key });
  }
  await ctx.yield();
  // ---- continuous sculpted sea-cliff skins (cliffskin.ts) — the tiers are gone where these stand
  const skinO = {
    tan: { moss: 0.5, strata: false, wear: 1.0, tile: 1.1, nrm: 0.55, top: "grass", topMix: 0.85, capOnly: 0, groundTint: true, stack: true },
    dark: { moss: 0.12, strata: false, wear: 0.9, gloss: 0.5, tile: 1.0, nrm: 0.6, top: "cinder", topMix: 1, capOnly: 0, groundTint: false, stack: true },
  };
  // (lodv) one program per skin tier (HI / MID / LO dither weights); otherwise one material for every tier
  const skinTiers = (layer: string, o: typeof skinO.tan): [THREE.Material, THREE.Material, THREE.Material] => {
    if (!ROCK_LODV) { const m = rockMaterial(arrays, layerIndex(layer), o, 0); return [m, m, m]; }
    return [0, 1, 2].map((k) => rockMaterial(arrays, layerIndex(layer), { ...o, skinTier: k as 0 | 1 | 2 }, 0)) as unknown as [THREE.Material, THREE.Material, THREE.Material];
  };
  const skinMat = { tan: skinTiers("cliff", skinO.tan), dark: skinTiers("basalt", skinO.dark) };
  const tSkin = performance.now();
  const skins = buildCliffSkins(t, ctx.terrain, skinMat, ROCK_LODV);
  group.add(skins.group);
  console.info(`[terrain] cliff skins: ${skins.chains.length} chains, ${(performance.now() - tSkin).toFixed(0)} ms`);
  const updateStacks = () => {
    skins.update(cam);
    const hiSlots = { sand: 0, basalt: 0 };
    for (const lm of loMerged) for (const v of lm.mat.userData.hiU as THREE.Vector4[]) v.set(1e9, 0, 0, 0);
    for (const st of stacks) {
      const d = Math.hypot(st.r.x - cam.x, st.r.y - cam.y, st.r.z - cam.z) - 0.5 * Math.max(st.r.sx, st.r.sz);
      const key = st.bas ? "basalt" : "sand";
      // HI within STACK_HI m (at most 8 per material — the merged far mesh collapses those 8)
      // (lodv: distance only, every band dithered — HI ↔ MID at 110–130 m, MID ↔ merged LO at 320–370 m; slot .w = reach)
      const near = ROCK_LODV ? d < STACK_LO_D + 50 && hiSlots[key] < 8 : d < STACK_HI && cam.y < 300 && hiSlots[key] < 8;
      if (ROCK_LODV) { st.hi.visible = near && d < STACK_HI_D + 20; st.mid.visible = near && d > STACK_HI_D; }
      else { st.hi.visible = near && d < 110; st.mid.visible = near && d >= 110; }
      if (near) { const lm = loMerged.find((l) => l.key === key); if (lm) (lm.mat.userData.hiU as THREE.Vector4[])[hiSlots[key]].set(st.r.x, st.r.y, st.r.z, ROCK_LODV ? 0.5 * Math.max(st.r.sx, st.r.sz) : 1); hiSlots[key]++; }
      st.hi.castShadow = st.hi.userData.castShadow = near && d < STACK_CAST;
    }
  };

  const last = new THREE.Vector3(1e9, 1e9, 1e9), cam = new THREE.Vector3();
  const put = (r: Ring, s: RockSet, i: number) => {
    (r.mesh.instanceMatrix.array as Float32Array).set(s.matrices.subarray(i * 16, i * 16 + 16), r.n * 16);
    const c = r.mesh.instanceColor!.array as Float32Array; c[r.n * 3] = s.colors[i * 3]; c[r.n * 3 + 1] = s.colors[i * 3 + 1]; c[r.n * 3 + 2] = s.colors[i * 3 + 2];
    const ai = r.ai.array as Float32Array; ai[r.n * 2] = s.reach[i]; ai[r.n * 2 + 1] = s.sizes[i];
    r.n++;
  };
  const flush = (r: Ring) => {
    const m = r.mesh; m.count = r.n; m.visible = r.n > 0;
    m.instanceMatrix.clearUpdateRanges(); m.instanceMatrix.addUpdateRange(0, r.n * 16); m.instanceMatrix.needsUpdate = true;
    m.instanceColor!.clearUpdateRanges(); m.instanceColor!.addUpdateRange(0, r.n * 3); m.instanceColor!.needsUpdate = true;
    if (ROCK_LODV) { r.ai.clearUpdateRanges(); r.ai.addUpdateRange(0, r.n * 2); r.ai.needsUpdate = true; }
    m.boundingSphere = null; if (r.n) m.computeBoundingSphere();
  };
  /** re-pack one set's near / mid rings + its far-mesh flags (only the cells within reach are visited) */
  const assignSet = (s: RockSet, aerial: boolean) => {
    const H = HI_DIST[s.mat], flag = s.flag, fi = s.farIdx;
    for (const i of s.flagged) if (fi[i] >= 0) flag[fi[i]] = 0;
    s.flagged.length = 0;
    s.near.n = 0; s.mid.n = 0;
    if (ROCK_LODV) {
      // the same tier distances as the shader (krRkW) + a margin for the amortised re-pack (≤ 8 m of camera travel)
      // (+ the camera's speed × the re-pack period — in the dive (60 m/s) the rings fell behind the camera and
      // mid-ring rocks were packed in already half-faded: 10 rocks popping in at ~200 m on the drop)
      const crag = s.mat === "crag", MARGIN = 14 + Math.min(90, camSpeed * 0.6);
      const reach = Math.max(MID_D[s.mat], 220) + s.maxSize * 3 + 120;
      const c0x = Math.floor((cam.x - reach) / CELL), c1x = Math.floor((cam.x + reach) / CELL);
      const c0z = Math.floor((cam.z - reach) / CELL), c1z = Math.floor((cam.z + reach) / CELL);
      for (let cx = c0x; cx <= c1x; cx++) for (let cz = c0z; cz <= c1z; cz++) {
        const idx = s.cells.get(cellKey(cx, cz)); if (!idx) continue;
        for (const i of idx) {
          const r = s.list[i], size = s.sizes[i];
          const d = Math.max(0, Math.hypot(r.x - cam.x, r.y - cam.y, r.z - cam.z) - s.reach[i]);
          const Hn = H + 0.5 * size, B1 = Math.max(6, 0.25 * Hn);
          let E = MID_D[s.mat] + 2 * size;
          if (size < 3.2) E = Math.min(E, crag ? 170 : 220);
          if (size < 2) E = Math.min(E, crag ? 100 : 150);
          if (size < 1.2) E = Math.min(E, 100);
          const hasFar = fi[i] >= 0, B2 = Math.max(20, 0.2 * E);
          const inNear = d < Hn + B1 + MARGIN, inMid = d > Hn - MARGIN && d < E + (hasFar ? B2 : 0) + MARGIN;
          if (inNear) put(s.near, s, i);
          if (inMid) put(s.mid, s, i);
          // far DEPTH collapse flag (its colour pass weighs by distance itself): drawn fully by the rings
          if (hasFar && d < E) { flag[fi[i]] = 1; s.flagged.push(i); }
        }
      }
    } else if (!aerial) {
      const reach = MID_D[s.mat] + s.maxSize * 3;
      const c0x = Math.floor((cam.x - reach) / CELL), c1x = Math.floor((cam.x + reach) / CELL);
      const c0z = Math.floor((cam.z - reach) / CELL), c1z = Math.floor((cam.z + reach) / CELL);
      for (let cx = c0x; cx <= c1x; cx++) for (let cz = c0z; cz <= c1z; cz++) {
        const idx = s.cells.get(cellKey(cx, cz)); if (!idx) continue;
        for (const i of idx) {
          const r = s.list[i], size = s.sizes[i];
          // distance to the rock's footprint (a 30 m deep cliff tier is not "30 m bigger": by size alone 40+ tiers
          // standing behind the volcanic camera would cast)
          const d = Math.max(0, Math.hypot(r.x - cam.x, r.y - cam.y, r.z - cam.z) - s.reach[i]);
          if (d < H + size * 0.5) put(s.near, s, i);
          // (small rubble fades out early: < 2 m beyond 150 m, < 3.2 m beyond 220 m — sub-pixel-ish, dozens of draws' worth)
          // (badlands obsidian rubble fades sooner — ~1 100 of them)
          else if (d < MID_D[s.mat] + size * 2 && !(size < 3.2 && d > (s.mat === "crag" ? 170 : 220)) && !(size < 2 && d > (s.mat === "crag" ? 100 : 150)) && !(size < 1.2 && d > 100)) put(s.mid, s, i);
          else continue;
          if (fi[i] >= 0) flag[fi[i]] = 1;
          s.flagged.push(i);
        }
      }
    }
    flush(s.near); flush(s.mid);
    for (const at of s.aHi) at.needsUpdate = true;
  };
  // amortised: after a small move the sets re-pack round-robin (SETS_PER_FRAME per frame); a jump re-packs all at once
  const SETS_PER_FRAME = 8;
  // the camera's smoothed speed (m/s), the far small-rock reach (rate-limited) and the last frame time
  let camSpeed = 0, reach = -1, lastT = -1;
  const prevCam = new THREE.Vector3(1e9, 0, 0);
  let rr = 0, pending = 0, pendAerial = false;
  const assign = () => { const aerial = cam.y > 300; for (const s of sets) assignSet(s, aerial); pending = 0; };
  const update = (camera: THREE.Camera) => {
    cam.setFromMatrixPosition(camera.matrixWorld);
    SHARED.time.value = performance.now() / 1000;
    const sd = ctx.shared.get("sunDir") as THREE.Vector3 | undefined;
    if (sd) SHARED.sun.value.copy(sd);
    SHARED.cam.value.copy(cam);
    // aerial / glide: big rocks cast from far away; ground: small rocks vanish beyond 260 m, far rocks never cast
    const aerial = cam.y > 300;
    const now = performance.now(), dt = lastT < 0 ? 1 / 60 : Math.min(0.25, Math.max(0.001, (now - lastT) / 1000)); lastT = now;
    if (prevCam.x < 1e8) camSpeed += (cam.distanceTo(prevCam) / dt - camSpeed) * Math.min(1, dt * 4);
    prevCam.copy(cam);
    if (ROCK_LODV) {
      // (lodv) the ground → aerial switch eases over 250–350 m: small-rock reach 260 → 900 m, far carving 0 → 1
      const k0 = Math.min(1, Math.max(0, (cam.y - 250) / 100)), k = k0 * k0 * (3 - 2 * k0);
      // (the reach follows at ≤ 160 m/s — the dive crosses the 100 m band in ~2 s, which swept the small
      // rocks' 15 % shrink band over them faster than a frame: ~30 far rocks vanishing at 400–780 m on the drop)
      const want = 260 + 640 * k;
      reach = reach < 0 ? want : reach + Math.max(-160 * dt, Math.min(160 * dt, want - reach));
      SHARED.cull.value.set(3, reach, k > 0.5 ? Math.max(700, cam.y * 1.6) : 0, k);
    } else SHARED.cull.value.set(3, aerial ? 900 : 260, aerial ? Math.max(700, cam.y * 1.6) : 0, aerial ? 1 : 0);
    for (const f of farMeshes) f.castShadow = false; // (re-asserted: the static far map gets the rocks from the proxy)
    if (pending > 0) {
      for (let k = 0; k < SETS_PER_FRAME && pending > 0; k++, pending--) { assignSet(sets[rr], pendAerial); rr = (rr + 1) % sets.length; }
    }
    const moved = cam.distanceTo(last);
    updateStacks();
    if (moved < 8 && (last.y > 300) === aerial) return;
    if (moved > 60 || (last.y > 300) !== aerial) { last.copy(cam); assign(); return; }
    last.copy(cam); pending = sets.length; pendAerial = aerial;
  };
  cam.set(0, 1e5, 0); assign(); updateStacks();
  void ctx;
  return { group, update, instances, stats: () => ({ near: sets.reduce((a, s) => a + s.near.n, 0), mid: sets.reduce((a, s) => a + s.mid.n, 0), far: farMeshes.reduce((a, f) => a + f.count, 0) }) };
}
