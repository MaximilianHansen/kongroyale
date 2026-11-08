// poi-coast client kit: shared material library + a static-geometry batcher (merge everything per material, box-
// projected UVs at world scale, vertex-colour tint, vertex "ground AO") + ground-conforming ribbons/patches + helpers
// to turn shared layout Pieces into meshes. Used by lookout-point, peel-strip and the-plantation.
import * as THREE from "three";
import { Coplanar } from "./coplanar";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import type { Terrain } from "../../../../../shared/world/terrain";
import type { Piece } from "../../../../../shared/pois/coast-kit";
import type { WorldCtx } from "../../../engine/engine";
import * as T from "./coast-tex";
import { flag } from "../../../flags";

// ------------------------------------------------------------------------------------------------ materials
export type MatKey =
  | "plaster" | "siding" | "sidingWorn" | "deck" | "wood" | "corr" | "corrRust" | "clay" | "stone" | "brick" | "concrete"
  | "pavers" | "rock" | "pmetal" | "gloss" | "steel" | "rubber" | "glass" | "darkGlass" | "lit" | "lamp" | "lampRed"
  | "asphalt" | "road" | "sandy" | "paint" | "blob" | "crate" | "logo" | "badge" | "fabric" | "plain" | "bananaFruit"
  | "chrome" | "lensGlow" | "logo1" | "screen"
  // painted PBR sets (public/assets/pois/coast/tex) — call loadCoastTextures() first
  | "gAsphalt" | "gCorr" | "gPlanks" | "gBarn" | "gConcrete" | "gDirt" | "gCliff" | "gTiles" | "gCrate" | "gPlanksH"
  | "gHull" | "gCorrPaint" | "gSoil" | "gStaves" | "gSiding" | "gBoulder" | "gCorrRoof" | "gSlab";

export type GKey = "asphalt" | "corrugated" | "planks-grey" | "barn-red" | "concrete-panels" | "dirt-road" | "cliff-rock" | "roof-tiles" | "crate-wood"
  | "hull" | "corr-painted" | "soil-litter" | "staves" | "lap-siding" | "boulder" | "cliff-slab";
const gsets = new Map<GKey, T.TexSet>();
/** load the painted texture sets (albedo + normal + roughness). Idempotent; holds readiness via ctx.assets. */
export async function loadCoastTextures(ctx: WorldCtx, keys: GKey[]) {
  // the code-painted sets come pre-baked from disk — no per-pixel painting here
  await T.preloadBaked((url, srgb, repeat) => ctx.assets.texture(url, { srgb, repeat }));
  await Promise.all(keys.map(async (k) => {
    if (gsets.has(k)) return;
    const base = `assets/pois/coast/tex/${k}`;
    const [map, normalMap, roughnessMap] = await Promise.all([
      ctx.assets.texture(`${base}.jpg`), ctx.assets.texture(`${base}_n.jpg`, { srgb: false }), ctx.assets.texture(`${base}_r.jpg`, { srgb: false }),
    ]);
    gsets.set(k, { map, normalMap, roughnessMap });
  }));
}
/** a loaded texture set (after loadCoastTextures) */
export const texSet = (k: GKey): T.TexSet => gset(k);
function gset(k: GKey): T.TexSet {
  const s = gsets.get(k);
  if (!s) throw new Error(`coast: texture set ${k} not loaded (call loadCoastTextures first)`);
  return s;
}

type AnyMat = THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial | THREE.MeshBasicMaterial;
let lib: Map<MatKey, AnyMat> | null = null;

function std(o: THREE.MeshStandardMaterialParameters & { set?: T.TexSet }): THREE.MeshStandardMaterial {
  const { set, ...p } = o;
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, ...p });
  if (set) { m.map = set.map; if (set.normalMap) m.normalMap = set.normalMap; if (set.roughnessMap) m.roughnessMap = set.roughnessMap; }
  return m;
}

export function mat(key: MatKey): AnyMat {
  if (!lib) lib = new Map();
  let m = lib.get(key);
  if (m) return m;
  switch (key) {
    case "plaster": m = std({ set: T.plaster(), roughness: 0.88 }); break;
    case "siding": m = std({ set: T.siding(0.35), roughness: 0.78 }); break;
    case "sidingWorn": m = std({ set: T.siding(1), roughness: 0.85 }); break;
    case "deck": m = std({ set: T.deck(), roughness: 0.82 }); break;
    case "wood": m = std({ set: T.wood(), roughness: 0.8 }); break;
    case "corr": m = std({ set: T.corrugated(0.35), roughness: 1, metalness: 0.45 }); break;
    case "corrRust": m = std({ set: T.corrugated(1), roughness: 1, metalness: 0.35 }); break;
    case "clay": m = std({ set: T.clayTiles(), roughness: 0.55 }); break;
    case "stone": m = std({ set: T.stone(), roughness: 0.9 }); break;
    case "brick": m = std({ set: T.brick(), roughness: 0.85 }); break;
    case "concrete": m = std({ set: T.concrete(), roughness: 0.9 }); break;
    case "pavers": m = std({ set: T.pavers(), roughness: 0.9 }); break;
    case "rock": m = std({ set: T.rock(), roughness: 0.92 }); break;
    case "pmetal": m = std({ set: T.paintedMetal(), roughness: 1, metalness: 0.15 }); break;
    case "gloss": {
      const s = T.paintedMetal();
      // perf: glossy paint as a low-roughness STANDARD material (the clearcoat lobe doubled the specular cost on
      // every vehicle / trim fragment and was invisible under the grade)
      m = new THREE.MeshStandardMaterial({ vertexColors: true, map: s.map, normalMap: s.normalMap, roughness: 0.3, metalness: 0.05, envMapIntensity: 1.25 });
      break;
    }
    case "steel": m = std({ roughness: 0.32, metalness: 0.88, color: 0xffffff }); break;
    // perf: aliases (one draw fewer per POI each; the differences never read at gameplay distance)
    case "chrome": m = mat("steel"); lib.set(key, m); return m;
    case "rubber": m = mat("plain"); lib.set(key, m); return m; // one draw fewer per POI (roughness 0.85 vs 0.7 is invisible on tyres)
    case "plain": m = std({ roughness: 0.7 }); break;
    case "fabric": m = std({ roughness: 0.95, side: THREE.DoubleSide }); break;
    case "glass": m = new THREE.MeshStandardMaterial({ color: 0xcfe6ee, roughness: 0.04, metalness: 0, transparent: true, opacity: 0.28, envMapIntensity: 2.2, depthWrite: false, side: THREE.DoubleSide }); break;
    // perf (per-draw cost measured ~0.012 ms at poi-07: 19 small-material draws of 16 k tris cost 0.22 ms): dark
    // glass = the glossy paint material with a dark tint (TINT below); red lamps = the lamp material with a red tint
    case "darkGlass": m = mat("gloss"); lib.set(key, m); return m;
    case "lit": { const s = T.litWindow(); m = new THREE.MeshStandardMaterial({ color: 0x3a2412, emissive: 0xffffff, emissiveMap: s.map, emissiveIntensity: 1.6, roughness: 0.2 }); break; }
    case "lamp": {
      // the emissive takes the vertex tint (white = warm lamp; "lampRed" pieces carry a red tint): one draw for both
      const lm = new THREE.MeshStandardMaterial({ color: 0xfff2d0, emissive: 0xffd58a, emissiveIntensity: 3.2, roughness: 0.3, vertexColors: true });
      lm.onBeforeCompile = (sh) => { sh.fragmentShader = sh.fragmentShader.replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n#ifdef USE_COLOR\n totalEmissiveRadiance *= vColor.rgb;\n#endif"); };
      lm.customProgramCacheKey = () => "coast-lamp-tint";
      m = lm; break;
    }
    case "lampRed": m = mat("lamp"); lib.set(key, m); return m;
    case "asphalt": m = std({ set: T.asphalt(), roughness: 1, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }); break;
    case "road": m = std({ set: T.dirtRoad(), roughness: 0.95, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }); break;
    case "sandy": m = std({ set: T.sandyGround(), roughness: 0.95, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }); break;
    case "paint": m = std({ set: T.wornPaint(), roughness: 0.7, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 }); break;
    case "blob": m = new THREE.MeshBasicMaterial({ map: T.blob().map, color: 0x000000, transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6, vertexColors: true }); break;
    case "crate": m = std({ set: T.crateSide(), roughness: 0.85 }); break;
    case "logo": m = std({ map: T.bananaLogo("flat").map, transparent: true, alphaTest: 0.35, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }); break;
    case "logo1": m = std({ map: T.bananaSingle().map, transparent: true, alphaTest: 0.35, roughness: 0.55, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }); break;
    case "screen": m = new THREE.MeshStandardMaterial({ color: 0x050505, emissive: 0xffffff, emissiveMap: T.screens().map, emissiveIntensity: 1.1, roughness: 0.15, metalness: 0.1 }); break;
    case "badge": m = std({ map: T.bananaLogo("badge").map, transparent: true, alphaTest: 0.35, roughness: 0.5, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }); break;
    // perf: standard (not physical clearcoat) — 60–100 k fruit tris per POI view, the clearcoat never read
    case "bananaFruit": m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42 }); break;
    case "gAsphalt": m = std({ set: gset("asphalt"), roughness: 1, normalScale: new THREE.Vector2(1.2, 1.2), polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }); break;
    case "gCorr": m = std({ set: gset("corrugated"), roughness: 1, metalness: 0.2, normalScale: new THREE.Vector2(1.4, 1.4) }); break;
    case "gPlanks": m = std({ set: gset("planks-grey"), roughness: 1, normalScale: new THREE.Vector2(1.2, 1.2) }); break;
    case "gPlanksH": m = mat("gPlanks"); lib.set(key, m); return m;
    case "gBarn": m = std({ set: gset("barn-red"), roughness: 1, normalScale: new THREE.Vector2(1.2, 1.2) }); break;
    case "gConcrete": m = std({ set: gset("concrete-panels"), roughness: 1 }); break;
    case "gDirt": m = std({ set: gset("dirt-road"), roughness: 1, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }); break;
    case "gCliff": m = std({ set: gset("cliff-rock"), roughness: 1, normalScale: new THREE.Vector2(1.3, 1.3) }); break;
    case "gTiles": m = std({ set: gset("roof-tiles"), roughness: 1, normalScale: new THREE.Vector2(1.2, 1.2) }); break;
    case "gCrate": m = std({ set: gset("crate-wood"), roughness: 1 }); break;
    case "gHull": m = std({ set: gset("hull"), roughness: 1, metalness: 0.25 }); break;
    case "gCorrPaint": m = mat("gCorrRoof"); lib.set(key, m); return m;
    // painted corrugated roofing with a metallic sheen (so the barn roof never reads as slate shingles)
    case "gCorrRoof": m = std({ set: gset("corr-painted"), roughness: 0.5, metalness: 0.22, normalScale: new THREE.Vector2(1.8, 1.8) }); break;
    case "gSoil": m = std({ set: gset("soil-litter"), roughness: 1, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }); break;
    case "gStaves": m = std({ set: gset("staves"), roughness: 1 }); break;
    case "gSiding": m = std({ set: gset("lap-siding"), roughness: 1, normalScale: new THREE.Vector2(1.3, 1.3) }); break;
    case "gBoulder": m = std({ set: gset("boulder"), roughness: 1 }); break;
    // sculpted grey slab rock (lookout cliff face, its stair landings, foot boulders, the clad terrain tiers)
    case "gSlab": m = std({ set: gset("cliff-slab"), roughness: 1, normalScale: new THREE.Vector2(1.25, 1.25) }); break;
    case "lensGlow": m = new THREE.MeshBasicMaterial({ map: T.glow().map, color: 0xffd9a0, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }); break;
  }
  m!.name = "coast:" + key;
  lib.set(key, m!);
  return m!;
}

/** keys that alias another material and carry their look as a vertex tint (multiplied into the piece colour) */
const TINT: Partial<Record<MatKey, number>> = { darkGlass: 0x1d2f3c, lampRed: 0xff3a22 };

// ------------------------------------------------------------------------------------------------ geometry helpers
export const box = (w: number, h: number, d: number, sy = 1) => { const g = new THREE.BoxGeometry(w, h, d, 1, sy, 1); g.userData.coDims = [w, h, d]; return g; };   // (coDims → the coplanar resolver)
/**
 * Bevelled box (w×h×d, edge bevel r). A single chamfer per edge with SPLIT normals (each chamfer vertex keeps its
 * face's normal, so the lighting rolls over the edge like a rounded bevel): 44 triangles instead of the 300 of a
 * 2-segment RoundedBoxGeometry. Per-face 0..1 UVs like BoxGeometry. `seg` ≥ 3 falls back to a true rounded box.
 */
export const rbox = (w: number, h: number, d: number, r = 0.06, seg = 2) => {
  const rr = Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3);
  if (seg >= 3) return new RoundedBoxGeometry(w, h, d, seg, rr);
  return chamferBox(w, h, d, Math.max(0, rr));
};

const _cbCache = new Map<string, THREE.BufferGeometry>();
export function chamferBox(w: number, h: number, d: number, r: number): THREE.BufferGeometry {
  const key = `${w.toFixed(4)}|${h.toFixed(4)}|${d.toFixed(4)}|${r.toFixed(4)}`;
  const hit = _cbCache.get(key);
  if (hit) return hit.clone();
  const H = [w / 2, h / 2, d / 2], I = [H[0] - r, H[1] - r, H[2] - r], E = [w, h, d];
  const pos: number[] = [], nrm: number[] = [], uv: number[] = [];
  // vertex on face (axis a, sign s) at the inset corner (u, v signs on the two other axes)
  const fv = (a: number, s: number, su: number, sv: number): [number[], number[]] => {
    const p = [0, 0, 0], n = [0, 0, 0];
    const b = (a + 1) % 3, c = (a + 2) % 3;
    p[a] = s * H[a]; p[b] = su * I[b]; p[c] = sv * I[c]; n[a] = s;
    return [p, n];
  };
  const uvOf = (p: number[], n: number[]) => {
    const ax = Math.abs(n[0]) >= Math.abs(n[1]) && Math.abs(n[0]) >= Math.abs(n[2]) ? 0 : Math.abs(n[1]) >= Math.abs(n[2]) ? 1 : 2;
    const b = ax === 0 ? 2 : 0, c = ax === 1 ? 2 : 1;
    const sg = ax === 1 ? 1 : Math.sign(n[ax]) || 1;
    return [(ax === 1 ? p[b] : sg * (ax === 0 ? -p[b] : p[b])) / E[b] + 0.5, p[c] / E[c] + 0.5];
  };
  const tri = (A: [number[], number[]], B: [number[], number[]], C: [number[], number[]]) => {
    // orient so the geometric normal agrees with the (outward) vertex normals
    const ab = [B[0][0] - A[0][0], B[0][1] - A[0][1], B[0][2] - A[0][2]], ac = [C[0][0] - A[0][0], C[0][1] - A[0][1], C[0][2] - A[0][2]];
    const gx = ab[1] * ac[2] - ab[2] * ac[1], gy = ab[2] * ac[0] - ab[0] * ac[2], gz = ab[0] * ac[1] - ab[1] * ac[0];
    const nx = A[1][0] + B[1][0] + C[1][0], ny = A[1][1] + B[1][1] + C[1][1], nz = A[1][2] + B[1][2] + C[1][2];
    const vs = gx * nx + gy * ny + gz * nz >= 0 ? [A, B, C] : [A, C, B];
    for (const [p, n] of vs) { pos.push(p[0], p[1], p[2]); nrm.push(n[0], n[1], n[2]); const t = uvOf(p, n); uv.push(t[0], t[1]); }
  };
  const quad = (a: [number[], number[]], b: [number[], number[]], c: [number[], number[]], d: [number[], number[]]) => { tri(a, b, c); tri(a, c, d); };
  // 6 faces
  for (let a = 0; a < 3; a++) for (const s of [-1, 1]) quad(fv(a, s, -1, -1), fv(a, s, 1, -1), fv(a, s, 1, 1), fv(a, s, -1, 1));
  if (r > 1e-5) {
    // 12 edge chamfers: between face (a, sa) and face (b, sb), running along axis c
    for (let a = 0; a < 3; a++) for (let k = 1; k <= 2; k++) {
      const b = (a + k) % 3;
      if (b < a) continue;
      const c = 3 - a - b;
      for (const sa of [-1, 1]) for (const sb of [-1, 1]) {
        const onA = (sc: number) => { const [p, n] = fv(a, sa, 0, 0); p[b] = sb * I[b]; p[c] = sc * I[c]; return [p, n] as [number[], number[]]; };
        const onB = (sc: number) => { const [p, n] = fv(b, sb, 0, 0); p[a] = sa * I[a]; p[c] = sc * I[c]; return [p, n] as [number[], number[]]; };
        quad(onA(-1), onA(1), onB(1), onB(-1));
      }
    }
    // 8 corner triangles
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      const s = [sx, sy, sz];
      const v = (a: number): [number[], number[]] => { const p = [s[0] * I[0], s[1] * I[1], s[2] * I[2]], n = [0, 0, 0]; p[a] = s[a] * H[a]; n[a] = s[a]; return [p, n]; };
      tri(v(0), v(1), v(2));
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  _cbCache.set(key, g);
  return g.clone();
}
export const cyl = (rt: number, rb: number, h: number, seg = 16, open = false) => new THREE.CylinderGeometry(rt, rb, h, seg, 1, open);
export const sph = (r: number, ws = 16, hs = 12) => new THREE.SphereGeometry(r, ws, hs);

const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3(), _p = new THREE.Vector3();
/** TRS matrix: position, Euler (x,y,z order YXZ by default), scale */
export function M(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx, order: THREE.EulerOrder = "YXZ") {
  _e.set(rx, ry, rz, order); _q.setFromEuler(_e); _s.set(sx, sy, sz); _p.set(x, y, z);
  return new THREE.Matrix4().compose(_p, _q, _s);
}

export interface AddOpts {
  /** placement inside the current frame (default identity) */
  m?: THREE.Matrix4;
  /** "box": box-project UVs in frame space (default) · "local": box-project before `m` · "keep": geometry UVs */
  uv?: "box" | "local" | "keep";
  /** metres per texture repeat for box/local projection (default 2) */
  tile?: number;
  /** rotate projected UVs by 90° (e.g. boards running the other way) */
  uvRot?: boolean;
  /** vertex tint */
  color?: THREE.ColorRepresentation;
  /** vertex AO toward `aoY` (frame space): colour × lerp(aoMin, 1, (y-aoY)/aoRange) */
  aoY?: number; aoRange?: number; aoMin?: number;
  /** cast shadow? (per material bucket; default true, false for lod 2) */
  shadow?: boolean;
  /** road grime — vertex colour pulled toward a dry mud brown below y0 + h
   *  (frame space after `m`), strength k (0..1), with a little per-vertex mottling */
  mud?: { y0: number; h: number; k?: number };
  /**
   * distance class (camera-driven by CoastLod): 0 = structure (shown until the POI switches to its far proxy),
   * 1 = mid props (≤ LOD.mid m: vehicles, crate stacks, fences, drums), 2 = small props / interiors / trims
   * (≤ LOD.near m, never cast). Default 0.
   */
  lod?: 0 | 1 | 2;
}

/** camera distances (m, to the chunk's bounding sphere) for the lod classes; `far` = POI switches to its proxy */
export const LOD = { near: 75, mid: 160, far: 220 };
/** chunk cell size (m): every bucket is split per cell so frustum culling + distance switching work per chunk */
export const CELL = 1000; // measured ~8-15 µs per coast draw: fewer, bigger merges beat per-chunk culling here

interface Bucket { mat: AnyMat; geos: THREE.BufferGeometry[]; shadow: boolean; lod: 0 | 1 | 2 }
const matIds = new WeakMap<object, number>();
let matSeq = 0;
const matId = (m: object) => { let i = matIds.get(m); if (i === undefined) { i = ++matSeq; matIds.set(m, i); } return i; };

/**
 * Collects geometry per (material, lod class, shadow, 64 m cell), bakes UV/tint/AO, applies the frame matrix, and
 * merges into one mesh per bucket. `frame` = the building/POI transform applied after local placement (UVs are
 * computed in frame space so the texture follows the building, not the world). Mesh userData: `lod` (0/1/2),
 * `castShadow` (read by atmos's caster policy) and `farShadow` (static far map: lod-0 only, see build()).
 */
export class Batch {
  private buckets = new Map<string, Bucket>();
  frame = new THREE.Matrix4();
  private tmpC = new THREE.Color();
  tris = 0;
  /** z-fight resolver over this batch's boxes (_kit/coplanar.ts), run once before the merge; null = off */
  co: Coplanar | null = new Coplanar();
  private coResolve() { if (this.co && this.co.boxes.length) { const r = this.co.resolve(); if (r.moved && flag("codebug")) console.info(`[coast] coplanar: ${r.boxes} boxes, ${r.pairs} pairs, ${r.moved} faces moved (${r.ms} ms)`); } }
  /** `lod`: the default distance class for every add() that doesn't pass one; `cell`: chunk size (m) — small POIs use
   *  one big cell (fewer draws), large ones ~80 m so frustum + distance culling work per chunk */
  constructor(private defaults: { lod?: 0 | 1 | 2; cell?: number } = {}) {}

  setFrame(x: number, y: number, z: number, yaw = 0) { this.frame = M(x, y, z, 0, yaw, 0); return this; }

  add(geo: THREE.BufferGeometry, key: MatKey | AnyMat, o: AddOpts = {}) {
    const material = typeof key === "string" ? mat(key) : key;
    let g = geo.index ? geo.clone() : geo.clone();
    for (const name of Object.keys(g.attributes)) if (!["position", "normal", "uv", "color"].includes(name)) g.deleteAttribute(name);
    if (!g.attributes.normal) g.computeVertexNormals();
    const uvMode = o.uv ?? "box", tile = o.tile ?? 2;
    if (uvMode === "local") boxUV(g, tile, o.uvRot);
    if (o.m) g.applyMatrix4(o.m);
    if (uvMode === "box") boxUV(g, tile, o.uvRot);
    if (!g.attributes.uv) g.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    // tint + AO into vertex colours
    const n = g.attributes.position.count, pos = g.attributes.position;
    const hasOld = g.attributes.color as THREE.BufferAttribute | undefined;
    const IS = hasOld?.itemSize === 4 ? 4 : 3;
    const col = new Float32Array(n * IS);
    const c = this.tmpC.set(o.color ?? 0xffffff);
    if (typeof key === "string" && TINT[key] !== undefined) c.multiply(new THREE.Color(TINT[key]));
    for (let i = 0; i < n; i++) {
      let k = 1;
      if (o.aoY !== undefined) {
        const t = Math.min(1, Math.max(0, (pos.getY(i) - o.aoY) / (o.aoRange ?? 1.5)));
        k = (o.aoMin ?? 0.55) + (1 - (o.aoMin ?? 0.55)) * Math.sqrt(t);
      }
      const r0 = hasOld ? hasOld.getX(i) : 1, g0 = hasOld ? hasOld.getY(i) : 1, b0 = hasOld ? hasOld.getZ(i) : 1;
      let cr = c.r * k * r0, cg = c.g * k * g0, cb = c.b * k * b0;
      if (o.mud) {
        const px = pos.getX(i), pz = pos.getZ(i), mott = 0.75 + 0.25 * Math.sin(px * 7.1 + pz * 5.3) * Math.cos(px * 3.7 - pz * 6.1);
        const t = Math.min(1, Math.max(0, 1 - (pos.getY(i) - o.mud.y0) / o.mud.h)) * (o.mud.k ?? 0.6) * mott;
        cr += (0.34 - cr) * t; cg += (0.26 - cg) * t; cb += (0.17 - cb) * t;
      }
      col[i * IS] = cr; col[i * IS + 1] = cg; col[i * IS + 2] = cb;
      if (IS === 4) col[i * 4 + 3] = hasOld!.getW(i);
    }
    g.setAttribute("color", new THREE.Float32BufferAttribute(col, IS));
    g.applyMatrix4(this.frame);
    // (the source's own bounds + axis-aligned normals are checked: a box() that was translated / rotated after it was made still registers right)
    if (geo.userData.coDims && this.co) { const pa = g.attributes.position, wm = o.m ? this.frame.clone().multiply(o.m) : this.frame; this.co.addGeometry(geo as never, wm.elements, 0, () => pa.array as Float32Array, 0, pa.count); }
    if (!g.index) { const idx = new Array(n); for (let i = 0; i < n; i++) idx[i] = i; g.setIndex(idx); }
    const lod = o.lod ?? this.defaults.lod ?? 0, shadow = o.shadow ?? true;
    // chunk cell from the piece's world bbox centre
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < n; i++) { const x = pos.getX(i), z = pos.getZ(i); if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; }
    const cs = this.defaults.cell ?? CELL, cx = Math.floor((x0 + x1) / 2 / cs), cz = Math.floor((z0 + z1) / 2 / cs);
    const bk = `${matId(material)}|${lod}|${shadow ? 1 : 0}|${cx},${cz}`;
    let b = this.buckets.get(bk);
    if (!b) { b = { mat: material, geos: [], shadow, lod }; this.buckets.set(bk, b); }
    b.geos.push(g);
    this.tris += (g.index ? g.index.count : n) / 3;
    return this;
  }

  /**
   * merge into one mesh per bucket. `farShadow`: whether lod-0 meshes go into atmos's static far shadow map (true
   * when the POI has no far proxy; false when a proxy with farShadow "force" stands in for them). lod 1/2 never do.
   */
  /** @internal the collected buckets (buildLayered merges several batches) */
  takeBuckets() { this.coResolve(); const v = [...this.buckets.values()]; this.buckets.clear(); return v; }

  build(name: string, o: { farShadow?: boolean } = {}): THREE.Group {
    this.coResolve();
    const grp = new THREE.Group();
    grp.name = name;
    for (const b of this.buckets.values()) {
      const m = b.mat;
      // mixed rgb / rgba vertex colours in one bucket → promote everything to rgba (alpha 1)
      if (b.geos.some((g) => g.attributes.color?.itemSize === 4) && b.geos.some((g) => g.attributes.color?.itemSize === 3)) {
        for (const g of b.geos) {
          const c = g.attributes.color as THREE.BufferAttribute;
          if (c.itemSize === 4) continue;
          const a = new Float32Array(c.count * 4);
          for (let i = 0; i < c.count; i++) { a[i * 4] = c.getX(i); a[i * 4 + 1] = c.getY(i); a[i * 4 + 2] = c.getZ(i); a[i * 4 + 3] = 1; }
          g.setAttribute("color", new THREE.Float32BufferAttribute(a, 4));
        }
      }
      const merged = mergeGeometries(b.geos, false);
      if (!merged) { console.warn(`[${name}] merge failed for ${m.name}`); continue; }
      merged.computeBoundingSphere(); merged.computeBoundingBox();
      const mesh = new THREE.Mesh(merged, m);
      mesh.name = `${name}:${m.name}${b.lod ? `:l${b.lod}` : ""}`;
      const transparent = (m as THREE.Material).transparent;
      mesh.castShadow = b.shadow && !transparent && m.name !== "coast:lensGlow";
      mesh.receiveShadow = m.name !== "coast:lensGlow";
      mesh.userData.castShadow = mesh.castShadow;
      mesh.userData.farShadow = mesh.castShadow && b.lod === 0 && o.farShadow !== false;
      mesh.userData.lod = b.lod;
      if (transparent) mesh.renderOrder = 2;
      grp.add(mesh);
      for (const gg of b.geos) gg.dispose();
    }
    this.buckets.clear();
    return grp;
  }
}


/**
 * Merge several Batches (typically structure / mid props / near props) into ONE mesh per (material, casts) with the
 * geometry ordered by distance class; `userData.lodCounts` = index counts to draw for lod ≤ 0 / ≤ 1 / ≤ 2, which
 * CoastLod applies with geometry.setDrawRange — the distance switching costs no extra draw calls (measured on an
 * M5-class GPU: ~8-15 µs per coast draw; the draw count, not the triangles, dominates the POI cost).
 */
export function buildLayered(name: string, batches: Batch[], o: { farShadow?: boolean } = {}): THREE.Group {
  const grp = new THREE.Group();
  grp.name = name;
  const groups = new Map<string, { mat: AnyMat; shadow: boolean; geos: Array<{ g: THREE.BufferGeometry; lod: number }> }>();
  for (const b of batches) for (const bk of b.takeBuckets()) {
    const key = `${matId(bk.mat)}|${bk.shadow ? 1 : 0}`;
    let gr = groups.get(key);
    if (!gr) { gr = { mat: bk.mat, shadow: bk.shadow, geos: [] }; groups.set(key, gr); }
    for (const g of bk.geos) gr.geos.push({ g, lod: bk.lod });
  }
  for (const gr of groups.values()) {
    const m = gr.mat, list = gr.geos.sort((a, b) => a.lod - b.lod), geos = list.map((q) => q.g);
    if (geos.some((g) => g.attributes.color?.itemSize === 4) && geos.some((g) => g.attributes.color?.itemSize === 3)) {
      for (const g of geos) {
        const c = g.attributes.color as THREE.BufferAttribute;
        if (c.itemSize === 4) continue;
        const a = new Float32Array(c.count * 4);
        for (let i = 0; i < c.count; i++) { a[i * 4] = c.getX(i); a[i * 4 + 1] = c.getY(i); a[i * 4 + 2] = c.getZ(i); a[i * 4 + 3] = 1; }
        g.setAttribute("color", new THREE.Float32BufferAttribute(a, 4));
      }
    }
    const counts = [0, 0, 0];
    for (const q of list) { const n = q.g.index!.count; for (let l = q.lod; l < 3; l++) counts[l] += n; }
    const merged = mergeGeometries(geos, false);
    if (!merged) { console.warn(`[${name}] merge failed for ${m.name}`); continue; }
    merged.computeBoundingSphere(); merged.computeBoundingBox();
    const mesh = new THREE.Mesh(merged, m);
    mesh.name = `${name}:${m.name}`;
    const transparent = (m as THREE.Material).transparent;
    mesh.castShadow = gr.shadow && !transparent && m.name !== "coast:lensGlow";
    mesh.receiveShadow = m.name !== "coast:lensGlow";
    mesh.userData.castShadow = mesh.castShadow;
    mesh.userData.farShadow = mesh.castShadow && counts[0] > 0 && o.farShadow !== false;
    mesh.userData.lodCounts = counts;
    if (transparent) mesh.renderOrder = 2;
    grp.add(mesh);
    for (const g of geos) g.dispose();
  }
  return grp;
}

// ------------------------------------------------------------------------------------------------ camera LOD
/**
 * Camera-distance switching for a POI built from Batches: lod-0 meshes show until the POI (centre + radius) is more
 * than `far` metres away, then the far `proxy` (if any) takes over; lod-1/2 meshes hide per chunk beyond `mid`/`near`.
 * `extra` objects (sprites, instanced helpers) follow a lod class too. Re-evaluated when the camera moves > 1 m.
 */
/** `?nocull` (for the collider ≡ visual parity check) — every coast mesh at its full detail at any
 *  distance, no far proxy (the parity page looks from 120 m up; distance switching would hide most of the drawn geometry from it) */
export const NOCULL = flag("nocull");
export class CoastLod {
  private items: Array<{ o: THREE.Object3D; lod: number; c: THREE.Vector3; r: number; counts?: number[] }> = [];
  private last = new THREE.Vector3(Infinity, 0, 0);
  far = false;
  constructor(private o: { center: [number, number, number]; radius: number; proxy?: THREE.Object3D; far?: number; mid?: number; near?: number }) {
    // the module's own far form: ?invariants (engine/invariants.hot.ts) counts it like an impostor or HLOD proxy
    if (o.proxy) o.proxy.userData.farForm = true;
  }

  add(root: THREE.Object3D, lodOverride?: number) {
    root.updateMatrixWorld(true);
    root.traverse((c) => {
      const m = c as THREE.Mesh;
      if (!m.isMesh && !(c as THREE.Points).isPoints && !(c as THREE.Sprite).isSprite) return;
      const lod = lodOverride ?? (c.userData.lod as number | undefined) ?? 0;
      let cc = new THREE.Vector3(), r = 0;
      if ((c as THREE.Sprite).isSprite) { c.getWorldPosition(cc); r = c.scale.x; }
      else {
        const g = m.geometry; if (!g.boundingSphere) g.computeBoundingSphere();
        cc = g.boundingSphere!.center.clone().applyMatrix4(c.matrixWorld); r = g.boundingSphere!.radius;
      }
      this.items.push({ o: c, lod, c: cc, r, counts: c.userData.lodCounts as number[] | undefined });
    });
    return this;
  }

  update(cam: THREE.Vector3, force = false) {
    if (!force && cam.distanceToSquared(this.last) < 1) return;
    this.last.copy(cam);
    const o = this.o, F = o.far ?? LOD.far, Md = o.mid ?? LOD.mid, N = o.near ?? LOD.near;
    const dp = NOCULL ? 0 : Math.hypot(cam.x - o.center[0], cam.y - o.center[1], cam.z - o.center[2]) - o.radius;
    this.far = !!o.proxy && dp > F;
    if (o.proxy) o.proxy.visible = this.far;
    for (const it of this.items) {
      if (it.counts) {
        // layered mesh: one draw, the distance class picks how much of the index buffer to draw
        const n = this.far ? 0 : dp < N ? it.counts[2] : dp < Md ? it.counts[1] : it.counts[0];
        it.o.visible = n > 0;
        (it.o as THREE.Mesh).geometry.setDrawRange(0, n || 0);
        continue;
      }
      const d = NOCULL ? 0 : Math.max(0, it.c.distanceTo(cam) - it.r);
      // lod 3 = landscape (cliffs, rock): independent of the proxy, visible within 1400 m
      it.o.visible = it.lod === 3 ? d < 1400 : !this.far && (it.lod === 0 ? (o.proxy ? true : d < 900) : it.lod === 1 ? d < Md : d < N);
    }
  }

  /** register on the engine: evaluated every frame (cheap when the camera is still) */
  attach(ctx: WorldCtx) {
    const p = new THREE.Vector3();
    ctx.onUpdate(() => { ctx.camera.getWorldPosition(p); this.update(p); });
    ctx.camera.getWorldPosition(p); this.update(p, true);
    return this;
  }
}

let _pool: THREE.MeshBasicMaterial | null = null;
/** warm additive light pool (floor / wall wash under a lamp): a fake light — no real light, no program recompiles */
export function lightPoolMat() {
  if (_pool) return _pool;
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const g = c.getContext("2d")!, gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, "rgba(255,190,110,0.5)"); gr.addColorStop(0.45, "rgba(255,160,80,0.2)"); gr.addColorStop(1, "rgba(255,140,60,0)");
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  _pool = new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 });
  _pool.name = "coast:lightPool";
  return _pool;
}

/**
 * All the small warm lamp halos of a POI in ONE draw (THREE.Points, additive, size-attenuated). Daylight-aware: the
 * halos are for dusk/night and interior pools; by day they are faint so they never tint the sky lavender.
 */
export function glowPoints(pts: Array<{ p: THREE.Vector3; size: number; color?: THREE.ColorRepresentation }>, o: { opacity?: number } = {}) {
  const pos = new Float32Array(pts.length * 3), col = new Float32Array(pts.length * 3), sz = new Float32Array(pts.length);
  const c = new THREE.Color();
  pts.forEach((q, i) => { pos.set([q.p.x, q.p.y, q.p.z], i * 3); c.set(q.color ?? 0xffb860); col.set([c.r, c.g, c.b], i * 3); sz[i] = q.size; });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute("size", new THREE.Float32BufferAttribute(sz, 1));
  g.computeBoundingSphere();
  const m = new THREE.ShaderMaterial({
    uniforms: { map: { value: T.glow().map }, uOpacity: { value: o.opacity ?? 0.35 }, uScale: { value: 700 } },
    vertexShader: `attribute float size; attribute vec3 color; varying vec3 vC; uniform float uScale;
      void main() { vC = color; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(size * uScale / max(1.0, -mv.z), 0.0, 256.0); }`,
    fragmentShader: `uniform sampler2D map; uniform float uOpacity; varying vec3 vC;
      void main() { float a = texture2D(map, gl_PointCoord).a; if (a < 0.01) discard; gl_FragColor = vec4(vC * a * uOpacity, 1.0); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
  });
  const p = new THREE.Points(g, m);
  p.name = "coast:glow";
  p.renderOrder = 3;
  p.userData.castShadow = false; p.userData.farShadow = false;
  return p;
}

/** box-projected UVs in the geometry's current space (metres / tile) */
export function boxUV(g: THREE.BufferGeometry, tile: number, rot = false) {
  const p = g.attributes.position, n = g.attributes.normal, cnt = p.count;
  const uv = new Float32Array(cnt * 2);
  // use face normals where possible (non-indexed geometry or flat faces) → avoids smeared UVs on rounded boxes
  for (let i = 0; i < cnt; i++) {
    const nx = Math.abs(n.getX(i)), ny = Math.abs(n.getY(i)), nz = Math.abs(n.getZ(i));
    let u: number, v: number;
    if (ny >= nx && ny >= nz) { u = p.getX(i); v = p.getZ(i); }
    else if (nx >= nz) { u = p.getZ(i) * Math.sign(n.getX(i) || 1); v = p.getY(i); }
    else { u = -p.getX(i) * Math.sign(n.getZ(i) || 1); v = p.getY(i); }
    if (rot) [u, v] = [v, u];
    uv[i * 2] = u / tile; uv[i * 2 + 1] = v / tile;
  }
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
}

// ------------------------------------------------------------------------------------------------ layout → meshes
export interface KindStyle { mat: MatKey; color?: THREE.ColorRepresentation; tile?: number; round?: number; uvRot?: boolean; ao?: boolean; skip?: boolean }

/** add shared-layout pieces (world space) to a batch whose frame is identity */
export function addPieces(b: Batch, pieces: Piece[], styles: Record<string, KindStyle>, aoBaseY?: number) {
  for (const p of pieces) {
    if (p.col) continue;
    const st = styles[p.k] ?? styles[p.k.split(":")[0]];
    if (!st) { console.warn("coast: no style for piece kind", p.k); continue; }
    if (st.skip) continue;
    const [w, h, d] = [p.h[0] * 2, p.h[1] * 2, p.h[2] * 2];
    const g = st.round ? rbox(w, h, d, st.round) : box(w, h, d, Math.max(1, Math.round(h / 1.2)));
    b.add(g, st.mat, {
      m: M(p.c[0], p.c[1], p.c[2], p.pitch ?? 0, p.yaw ?? 0, 0),
      uv: "box", tile: st.tile ?? 2, color: st.color, uvRot: st.uvRot,
      aoY: st.ao && aoBaseY !== undefined ? aoBaseY : undefined, aoRange: 2.2, aoMin: 0.6,
    });
  }
}

// ------------------------------------------------------------------------------------------------ ground-conforming
/**
 * A ribbon along a polyline that hugs the terrain: UV u = 0..1 across, v = metres/tile along. Used for roads,
 * runway, paint lines. `lift` metres above the ground; `step` sample spacing.
 */
export function ribbon(terrain: Terrain, pts: Array<[number, number]>, width: number, o: { lift?: number; step?: number; tile?: number; across?: number; flatY?: number } = {}) {
  const lift = o.lift ?? 0.04, step = o.step ?? 2, tile = o.tile ?? 8, across = Math.max(1, o.across ?? Math.ceil(width / 2));
  // resample the polyline uniformly
  const samp: Array<[number, number]> = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1], L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(L / step));
    for (let k = 0; k < n; k++) samp.push([ax + (bx - ax) * k / n, az + (bz - az) * k / n]);
  }
  samp.push(pts[pts.length - 1]);
  const rows = samp.length, cols = across + 1;
  const pos = new Float32Array(rows * cols * 3), uv = new Float32Array(rows * cols * 2);
  let dist = 0;
  for (let i = 0; i < rows; i++) {
    const a = samp[Math.max(0, i - 1)], b = samp[Math.min(rows - 1, i + 1)];
    let tx = b[0] - a[0], tz = b[1] - a[1]; const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
    const nx = -tz, nz = tx;
    if (i > 0) dist += Math.hypot(samp[i][0] - samp[i - 1][0], samp[i][1] - samp[i - 1][1]);
    for (let j = 0; j < cols; j++) {
      const s = j / across - 0.5, x = samp[i][0] + nx * s * width, z = samp[i][1] + nz * s * width;
      const y = (o.flatY ?? terrain.height(x, z)) + lift;
      const k = (i * cols + j);
      pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
      uv[k * 2] = j / across; uv[k * 2 + 1] = dist / tile;
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < rows - 1; i++) for (let j = 0; j < cols - 1; j++) {
    const a = i * cols + j, b = a + 1, c = a + cols, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  // make sure normals point up
  const nrm = g.attributes.normal;
  if (nrm.count && nrm.getY(0) < 0) { for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]]; g.setIndex(idx); g.computeVertexNormals(); }
  return g;
}

/** a terrain-hugging disc/ellipse patch (world XZ), UV = world metres / tile, vertex alpha feather at the rim via colour? (alpha from texture) */
export function patch(terrain: Terrain, cx: number, cz: number, rx: number, rz: number, o: { lift?: number; seg?: number; rings?: number; tile?: number; yaw?: number; wobble?: number; seed?: number } = {}) {
  const seg = o.seg ?? 48, rings = o.rings ?? 8, lift = o.lift ?? 0.05, tile = o.tile ?? 6, yaw = o.yaw ?? 0, wob = o.wobble ?? 0.12;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const pos: number[] = [], uv: number[] = [], alpha: number[] = [], idx: number[] = [];
  pos.push(cx, terrain.height(cx, cz) + lift, cz); uv.push(cx / tile, cz / tile); alpha.push(1);
  const seed = o.seed ?? 3;
  for (let r = 1; r <= rings; r++) {
    const t = r / rings;
    for (let k = 0; k < seg; k++) {
      const a = (k / seg) * Math.PI * 2;
      const w = 1 + wob * (Math.sin(a * 3 + seed) * 0.6 + Math.sin(a * 7 + seed * 2.3) * 0.4);
      const lx = Math.cos(a) * rx * t * w, lz = Math.sin(a) * rz * t * w;
      const x = cx + lx * c + lz * s, z = cz - lx * s + lz * c;
      pos.push(x, terrain.height(x, z) + lift, z); uv.push(x / tile, z / tile);
      alpha.push(t < 0.8 ? 1 : 1 - (t - 0.8) / 0.2);
    }
  }
  for (let k = 0; k < seg; k++) idx.push(0, 1 + ((k + 1) % seg), 1 + k);
  for (let r = 1; r < rings; r++) for (let k = 0; k < seg; k++) {
    const a = 1 + (r - 1) * seg + k, b = 1 + (r - 1) * seg + ((k + 1) % seg), cc = a + seg, d = b + seg;
    idx.push(a, b, cc, b, d, cc);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  const col = new Float32Array(alpha.length * 4);
  for (let i = 0; i < alpha.length; i++) { col[i * 4] = col[i * 4 + 1] = col[i * 4 + 2] = 1; col[i * 4 + 3] = alpha[i]; }
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 4));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** add a soft contact-shadow blob (flat quad hugging the ground) */
export function blobShadow(b: Batch, terrain: Terrain | null, x: number, z: number, w: number, d: number, yaw = 0, y?: number, strength = 1) {
  const g = new THREE.PlaneGeometry(w, d, 2, 2);
  g.rotateX(-Math.PI / 2);
  g.rotateY(yaw);
  g.translate(x, 0, z);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) p.setY(i, (y ?? terrain!.height(p.getX(i), p.getZ(i))) + 0.06);
  b.add(g, "blob", { uv: "keep", color: new THREE.Color(strength, strength, strength), shadow: false });
}

/** vertical-plane decal (logo) facing +Z in local space, placed with matrix m */
export function decal(b: Batch, key: MatKey, w: number, h: number, m: THREE.Matrix4) {
  const g = new THREE.PlaneGeometry(w, h);
  b.add(g, key, { m, uv: "keep", shadow: false });
}


export { T };

// ------------------------------------------------------------------------------------------------ lathe & shapes
/**
 * Lathe around +Y from a profile [[r, y], ...] (bottom → top), swept over angles a0..a1 where a point at angle a sits
 * at (cos a·r, y, sin a·r). UVs: u = arc length at the mean radius / tile, v = profile length / tile. `inner` flips
 * the faces inward (interior walls).
 */
export function lathe(profile: Array<[number, number]>, o: { a0?: number; a1?: number; segs?: number; tile?: number; inner?: boolean; vTile?: number } = {}) {
  const a0 = o.a0 ?? 0, a1 = o.a1 ?? Math.PI * 2, segs = o.segs ?? 48, tile = o.tile ?? 2, vTile = o.vTile ?? tile;
  const np = profile.length, rm = profile.reduce((s, p) => s + p[0], 0) / np;
  const vAcc = [0];
  for (let j = 1; j < np; j++) vAcc.push(vAcc[j - 1] + Math.hypot(profile[j][0] - profile[j - 1][0], profile[j][1] - profile[j - 1][1]));
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let i = 0; i <= segs; i++) {
    const a = a0 + (a1 - a0) * (i / segs), c = Math.cos(a), s = Math.sin(a);
    for (let j = 0; j < np; j++) {
      pos.push(c * profile[j][0], profile[j][1], s * profile[j][0]);
      uv.push((a * rm) / tile, vAcc[j] / vTile);
    }
  }
  for (let i = 0; i < segs; i++) for (let j = 0; j < np - 1; j++) {
    const a = i * np + j, b = a + 1, c = a + np, d = c + 1;
    if (o.inner) idx.push(a, c, b, b, c, d); else idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** rectangle with a semicircular top: width w, total height h (h ≥ w/2), bottom at y=y0, centred on x */
export function archShape(w: number, h: number, y0 = 0) {
  const s = new THREE.Shape(), r = w / 2, sh = y0 + h - r;
  s.moveTo(-r, y0); s.lineTo(r, y0); s.lineTo(r, sh);
  s.absarc(0, sh, r, 0, Math.PI, false);
  s.lineTo(-r, y0);
  return s;
}

/** window/door frame around an opening w×h (opening bottom at y=0): border f, extruded `d` deep centred on z=0 */
export function frameGeo(w: number, h: number, f: number, d: number, arched: boolean) {
  const outer = arched ? archShape(w + 2 * f, h + 2 * f, -f) : rectShape(w + 2 * f, h + 2 * f, -f);
  outer.holes.push(arched ? archShape(w, h) : rectShape(w, h));
  const g = new THREE.ExtrudeGeometry(outer, { depth: d, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.02, bevelSegments: 1, curveSegments: 12 });
  g.translate(0, 0, -d / 2);
  return g;
}
export function rectShape(w: number, h: number, y0 = 0) {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, y0); s.lineTo(w / 2, y0); s.lineTo(w / 2, y0 + h); s.lineTo(-w / 2, y0 + h); s.lineTo(-w / 2, y0);
  return s;
}
/** flat shape → geometry (for glass panes, gables) */
export function shapeGeo(s: THREE.Shape) { return new THREE.ShapeGeometry(s, 12); }

/** triangular prism (gable infill) width w (X), height h (Y), thickness t (Z), base at y=0 */
export function gableGeo(w: number, h: number, t: number) {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, 0); s.lineTo(w / 2, 0); s.lineTo(0, h); s.lineTo(-w / 2, 0);
  const g = new THREE.ExtrudeGeometry(s, { depth: t, bevelEnabled: false });
  g.translate(0, 0, -t / 2);
  return g;
}

// ------------------------------------------------------------------------------------------------ openings
export interface OpeningDress {
  /** frame colour + material */
  frame?: THREE.ColorRepresentation; frameKey?: MatKey; frameW?: number;
  /** glass in windows (openings with y0 > 0.05): "glass" (clear, real) or "lit" (warm interior glow) */
  glass?: "glass" | "lit" | "none";
  /** mullion cross in windows */
  mullions?: boolean;
  /** sill board under windows */
  sill?: THREE.ColorRepresentation;
  /** door leaf (openings from the floor), swung open by `swing` rad about its hinge; colour */
  leaf?: THREE.ColorRepresentation; swing?: number; leafKey?: MatKey;
}
/**
 * Dress the openings of a straight wall built by shared coast-kit wall(): frames through the wall thickness `t`,
 * glass panes + mullions + sills in windows, an open door leaf in doors. Same (x0, z0) → (x1, z1), base y and opening
 * list (u from the start corner) as the collider wall, so the frames sit exactly in the collider's holes.
 */
export function dressOpenings(b: Batch, x0: number, z0: number, x1: number, z1: number, y0: number, ops: ReadonlyArray<{ u: number; w: number; y0: number; h: number }>, t: number, o: OpeningDress = {}) {
  const dx = x1 - x0, dz = z1 - z0, L = Math.hypot(dx, dz), ux = dx / L, uz = dz / L, yaw = Math.atan2(-uz, ux);
  const fk = o.frameKey ?? "wood", fc = o.frame ?? 0xf0ead8, fw = o.frameW ?? 0.1;
  for (const op of ops) {
    const cx = x0 + ux * op.u, cz = z0 + uz * op.u, m0 = M(cx, y0 + op.y0, cz, 0, yaw, 0);
    b.add(frameGeo(op.w, op.h, fw, t + 0.06, false), fk, { m: m0, uv: "local", tile: 1, color: fc });
    const isWin = op.y0 > 0.05;
    if (isWin) {
      if ((o.glass ?? "glass") !== "none") b.add(shapeGeo(rectShape(op.w, op.h)), o.glass === "lit" ? "lit" : "glass", { m: mul4(m0, M(0, 0, 0.02)), uv: "keep", shadow: false });
      if (o.mullions !== false) {
        b.add(box(0.05, op.h, 0.06), fk, { m: mul4(m0, M(0, op.h / 2, 0.03)), color: fc });
        if (op.h > 1.0) b.add(box(op.w, 0.05, 0.06), fk, { m: mul4(m0, M(0, op.h * 0.55, 0.03)), color: fc });
      }
      if (o.sill !== undefined) for (const s of [-1, 1]) b.add(rbox(op.w + 0.25, 0.07, 0.16, 0.02), "wood", { m: mul4(m0, M(0, -0.04, s * (t / 2 + 0.06))), color: o.sill });
    } else if (o.leaf !== undefined) {
      const lw = op.w - 0.06, lh = Math.min(op.h - 0.04, 2.3), sw = o.swing ?? -1.3;
      const lm = mul4(m0, M(-op.w / 2 + 0.03, 0, t / 2 + 0.02, 0, sw, 0));
      b.add(rbox(lw, lh, 0.05, 0.015), o.leafKey ?? "wood", { m: mul4(lm, M(lw / 2, lh / 2, 0)), color: o.leaf });
      for (const py of [lh * 0.28, lh * 0.72]) b.add(rbox(lw * 0.7, lh * 0.3, 0.03, 0.01), o.leafKey ?? "wood", { m: mul4(lm, M(lw / 2, py, 0.03)), color: new THREE.Color(o.leaf).multiplyScalar(0.85) });
      b.add(sph(0.035, 8, 6), "chrome", { m: mul4(lm, M(lw - 0.1, 1.0, 0.05)), color: 0xd8b25a });
    }
  }
}
const mul4 = (a: THREE.Matrix4, c: THREE.Matrix4) => new THREE.Matrix4().multiplyMatrices(a, c);

/** a solid box drawn at exactly a shared piece's collider size (furniture / cover), with an optional inset lip */
export function pieceBox(b: Batch, p: { c: number[]; h: number[]; yaw?: number }, key: MatKey, color?: THREE.ColorRepresentation, o: { round?: number; tile?: number; lod?: 0 | 1 | 2; shadow?: boolean } = {}) {
  const g = o.round ? rbox(p.h[0] * 2, p.h[1] * 2, p.h[2] * 2, o.round) : box(p.h[0] * 2, p.h[1] * 2, p.h[2] * 2);
  b.add(g, key, { m: M(p.c[0], p.c[1], p.c[2], 0, p.yaw ?? 0, 0), tile: o.tile ?? 1.5, color, lod: o.lod, shadow: o.shadow });
}
