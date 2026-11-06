// Instance management (perf-critical — CPU budget ≤ 0.5 ms per veg update while sprinting + turning).
//
// SpeciesPool (big plants): every instance's world matrix is composed ONCE at add() time into a flat Float32Array and
// indexed by a flat CSR grid (32 m cells). A refresh (camera moved / turned) walks only the cells in range, culls whole
// cells against a widened frustum, then per instance picks LOD0 / LOD1 by distance and copies 16 floats. Beyond LOD1
// the static impostor mesh (one quad per instance, baked once) takes over. An instance outside the view is kept only
// when it is within 40 m and its tier casts into the dynamic cascades: LOD0 stores those after the in-view instances
// and its main-pass draw stops before them (only the shadow passes draw them); LOD1 keeps them in its casting prefix.
//
// DetailPool (grass, ferns, flowers, groundcover): instances live in per-16 m-cell blocks (pre-composed matrices,
// sorted by a random thinning threshold) owned by the veg system; a refresh just copies whole blocks (TypedArray.set)
// into the LOD buffers — the cell set changes incrementally as the camera moves, nothing is re-added.
//
// Shadow policy: only LOD0 of species with `shadow` cast into the dynamic cascades (trees, palms, banana, bamboo,
// mangroves, logs). LOD1, detail, bushes and monstera never cast. Impostors (one quad per plant) cast only into atmos'
// static far map, baked once for the whole island.
import * as THREE from "three";
import type { Species } from "./species/types";
import { ImpostorBank, impostorQuad, IMP_BLEND } from "./impostor";
import { noFadeMaterial, prepassMaterial, equalMaterial, liteMaterial, VEG_FADE_T } from "./foliage-material";
import { writeMatrix } from "./detail-gen";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { flag } from "../../flags";

const CELL = 32;
const GRID_HALF = 1760;                         // covers the island and the dev studio (x = z = 1500)
const GRID_N = Math.ceil((2 * GRID_HALF) / CELL);
/** impostor quads cast the island-wide canopy shadows into atmos' static far map — ?impshadow=0 turns off */
export const IMPOSTOR_SHADOWS = flag("impshadow");
/** alpha-tested foliage: depth pre-pass + EQUAL colour pass — OFF by default (?vegpre=1 turns it on, A/B): measured
 * with GPU timer queries (p10 of 20 interleaved frames) on an M5-class tile-based GPU, the pre-pass COSTS 0.6–2.2 ms at
 * the jungle / meadow cameras (the doubled vertex + tiling work outweighs the saved shading) */
export const VEG_PREPASS = flag("vegpre");
/** LOD1 of the casting impostor species (jungle trees, palms, mangroves, bamboo; bushes and bananas where the video
 *  tier lets them cast — High / Epic) casts into the dynamic cascades too, for the instances nearer than SHADOW1_D.
 *  With only LOD0 casting, a tree crossing its LOD0 distance (22 m on Medium, 11 m for a palm) would lose its whole
 *  canopy shadow on the ground at once (the static far map only fills in from 1.2 × the cascade-0 split, fully from
 *  ~2.2 ×) and get it back on approach. Beyond SHADOW1_D the far map's impostor shadows cover. ?vegshadow1=0: off */
export const SHADOW_LOD1 = flag("vegshadow1");
const SHADOW1_D = 58;   // (the end of foliage-material uVegShadowBand — casting dissolves from 42 m)
/** the in-view test pads the sphere of an instance within 40 m (m): a selection lags the camera by up to one refresh
 *  step (veg index.ts re-selects every family once the camera is 2.5 m from where it last selected) + one frame, and
 *  a few metres from the camera that move swings an instance through a wide angle (backing past a bush) */
const VIEW_PAD = 4;
/** sort-key offset (whole metres²) of an out-of-view LOD0 caster: it sorts after every in-view instance */
const OUT_KEY = 2 ** 30;
/** opaque LOD0 parts crossfade with their tier (?vegsolidfade=0 = the old no-discard LOD0 bark) */
export const SOLID_FADE = flag("vegsolidfade");
/** ?vegdbg=noshadow,noimp,nolod0,nolod1,nodetail — perf attribution switches */
export const VEG_DBG = new Set(flag("vegdbg"));
const box = new THREE.Box3();

export interface PoolStats { n: number; lod0: number; lod1: number }
/** LOD switch counters (probes: tools check that moving cameras only ever crossfade) */
export const LOD_STATS = { instant: 0, faded: 0 };

/** frustum planes as a flat array (nx, ny, nz, d) × 6 for inline sphere tests */
export function frustumPlanes(f: THREE.Frustum, out: Float32Array) {
  for (let i = 0; i < 6; i++) { const p = f.planes[i]; out[i * 4] = p.normal.x; out[i * 4 + 1] = p.normal.y; out[i * 4 + 2] = p.normal.z; out[i * 4 + 3] = p.constant; }
}
const sphereIn = (P: Float32Array, x: number, y: number, z: number, r: number) => {
  for (let i = 0; i < 24; i += 4) if (P[i] * x + P[i + 1] * y + P[i + 2] * z + P[i + 3] < -r) return false;
  return true;
};

/** a geometry that SHARES every attribute (same GPU buffers) of `src` plus its own per-instance attributes */
function shareGeometry(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setIndex(src.index);
  for (const k of Object.keys(src.attributes)) g.setAttribute(k, src.attributes[k]);
  g.boundingBox = src.boundingBox; g.boundingSphere = src.boundingSphere;
  return g;
}

/** the instanced LOD0 / LOD1 meshes of one species + their dynamic buffers */
class LodMeshes {
  lod0: THREE.InstancedMesh[] = [];
  lod1: THREE.InstancedMesh[] = [];
  attr0: THREE.InstancedBufferAttribute; attr1: THREE.InstancedBufferAttribute;
  col0: THREE.InstancedBufferAttribute; col1: THREE.InstancedBufferAttribute;
  /** per-instance LOD crossfade (switch time, direction) — the tier clock of big plants; detail pools: (−1 sentinel,
   *  streamed-in coverage) — foliage-material V_WIND */
  fade0: THREE.InstancedBufferAttribute | null = null; fade1: THREE.InstancedBufferAttribute | null = null;
  a0: Float32Array; a1: Float32Array; c0: Float32Array; c1: Float32Array; f0: Float32Array; f1: Float32Array;
  n0 = 0; n1 = 0;
  private geos0: THREE.BufferGeometry[] = []; private geos1: THREE.BufferGeometry[] = [];

  constructor(readonly sp: Species, scene: THREE.Scene, public cap0: number, public cap1: number, readonly detail: boolean) {
    this.a0 = new Float32Array(cap0 * 16); this.a1 = new Float32Array(cap1 * 16);
    this.c0 = new Float32Array(cap0 * 3); this.c1 = new Float32Array(cap1 * 3);
    this.f0 = new Float32Array(cap0 * 2); this.f1 = new Float32Array(cap1 * 2);
    this.attr0 = dyn(this.a0, 16); this.attr1 = dyn(this.a1, 16);
    this.col0 = dyn(this.c0, 3); this.col1 = dyn(this.c1, 3);
    this.fade0 = dyn(this.f0, 2); this.fade1 = dyn(this.f1, 2);
    const cast = !detail && !!sp.shadow && !VEG_DBG.has("noshadow");
    const cast1 = cast && SHADOW_LOD1 && !!sp.impostor;
    for (const part of sp.parts) {
      for (const lod of [0, 1] as const) {
        const src = lod === 0 ? part.lod0 : part.lod1;
        if (!src.attributes.position || src.attributes.position.count === 0) continue;
        // every pool gets its own geometry view (shared vertex buffers) carrying its per-instance fade attribute — the
        // same species geometry may feed a big-plant pool and a detail pool (flowers)
        const geo = shareGeometry(src);
        geo.setAttribute("aLodFade", lod === 0 ? this.fade0! : this.fade1!); (lod === 0 ? this.geos0 : this.geos1).push(geo);
        // LOD0 of an opaque big-plant part: no discard in its shader (hidden-surface removal) — it only collapses when
        // faded out (detail parts keep it: their distance / streaming coverage is a discard dither)
        // (SOLID_FADE — the opaque LOD0 parts (trunk, limbs, lianas) dissolve with their tier like the
        // leaves; compiled without the discard they appeared / vanished in one frame at the LOD0 ↔ LOD1 switch)
        const opaque0 = !SOLID_FADE && !detail && lod === 0 && part.mats.mat.alphaTest === 0 && !part.mats.mat.userData.vegBillboard;
        // alpha-tested parts (depth-writing): a depth-only pre-pass + an EQUAL colour pass without discard
        // (foliage-material prepassMaterial / equalMaterial) — only with ?vegpre=1 (VEG_PREPASS, A/B)
        const pre = VEG_PREPASS && part.mats.mat.alphaTest > 0 && !part.mats.mat.userData.vegNoDepth;
        const im = new THREE.InstancedMesh(geo, opaque0 ? noFadeMaterial(part.mats) : pre ? equalMaterial(part.mats) : lod === 1 && !detail ? liteMaterial(part.mats) : part.mats.mat, lod === 0 ? cap0 : cap1);
        im.instanceMatrix = lod === 0 ? this.attr0 : this.attr1;
        im.instanceColor = lod === 0 ? this.col0 : this.col1;
        im.customDepthMaterial = part.mats.depth;
        im.castShadow = (lod === 0 ? cast : cast1) && part.shadow !== false;
        if (lod === 1 && im.castShadow) {
          // (the LOD1 buffer is sorted near → far: the shadow passes draw only its first nShadow1 instances)
          let saved = -1;
          im.onBeforeShadow = () => { if (im.userData.vegWarm) return; saved = im.count; im.count = Math.min(im.count, this.nShadow1); };
          im.onAfterShadow = () => { if (saved >= 0) { im.count = saved; saved = -1; } };
        }
        if (lod === 0 && !detail) this.viewOnly(im);
        // atmos applies a scene-wide casting policy after build unless userData says otherwise; LOD sets change with the
        // camera, so they never go into atmos' static far map (the impostors stand in for them there)
        im.userData.castShadow = im.castShadow; im.userData.farShadow = false;
        im.receiveShadow = true;
        im.frustumCulled = false;
        // front-to-back across the scene: near foliage first (its depth rejects the leaves / ground behind it before they
        // are shaded — alpha-tested overdraw is most of veg's GPU cost), far tiers later; instances inside a buffer are
        // sorted near → far by SpeciesPool.update / the detail ring order
        im.renderOrder = part.mats.mat.userData.vegNoDepth ? 40 + lod : detail ? (lod === 0 ? -30 : -15) : (lod === 0 ? -22 : -10);
        im.count = 0; im.visible = false;
        im.name = `veg:${sp.id}:${part.name}:lod${lod}`;
        (lod === 0 ? this.lod0 : this.lod1).push(im);
        scene.add(im);
        if (pre) {
          const pm = new THREE.InstancedMesh(geo, prepassMaterial(part.mats), lod === 0 ? cap0 : cap1);
          pm.instanceMatrix = im.instanceMatrix; pm.instanceColor = im.instanceColor;
          pm.castShadow = false; pm.receiveShadow = false; pm.userData.castShadow = false; pm.userData.farShadow = false;
          pm.frustumCulled = false;
          // before every colour draw of the scene (the terrain and POIs behind the leaves are then depth-rejected too)
          pm.renderOrder = -80 + im.renderOrder * 0.01;
          pm.count = 0; pm.visible = false;
          if (lod === 0 && !detail) this.viewOnly(pm);
          pm.name = `veg:${sp.id}:${part.name}:lod${lod}:pre`;
          (lod === 0 ? this.lod0 : this.lod1).push(pm);
          scene.add(pm);
        }
      }
    }
  }

  /** nearest instance distance (m) of each tier in the current buffers — orders the draws near-first (setOrder) */
  near0 = 0; near1 = 0;
  /** LOD1 instances (from the front of the near → far buffer) nearer than SHADOW1_D — the ones that cast */
  nShadow1 = 0;
  /** LOD0 instances in view (the front of the buffer); the out-of-view casters after them are for the shadow passes */
  nView0 = 0;

  /** a LOD0 mesh's main-pass draw stops at nView0; its count (and so every shadow pass) keeps the whole buffer */
  private viewOnly(m: THREE.InstancedMesh) {
    let saved = -1;
    m.onBeforeRender = () => { saved = m.count; m.count = Math.min(m.count, this.nView0); };
    m.onAfterRender = () => { if (saved >= 0) { m.count = saved; saved = -1; } };
  }

  begin() { this.n0 = 0; this.n1 = 0; }

  /**
   * Perf: the draws of ALL veg meshes go near → far by their nearest instance (instances inside a buffer are
   * already sorted near → far) — a banana leaf in front of the camera fills the depth buffer BEFORE the ground cover
   * and the trees behind it are shaded (a fixed category order drew the detail layer first, then the big plants):
   * renderOrder −70 … −20 by distance. The no-depth lawn keeps its late slot.
   */
  setOrder(d0: number, d1: number) {
    this.near0 = d0; this.near1 = d1;
    const o0 = -70 + Math.min(250, Math.max(0, d0)) * 0.2, o1 = -70 + Math.min(250, Math.max(0, d1)) * 0.2;
    for (const m of this.lod0) if (!(m.material as THREE.Material).userData.vegNoDepth && !/:pre$/.test(m.name)) m.renderOrder = o0;
    for (const m of this.lod1) if (!(m.material as THREE.Material).userData.vegNoDepth && !/:pre$/.test(m.name)) m.renderOrder = o1;
  }

  /** grow a LOD buffer (rare: the caps are sized for the densest views) */
  grow(lod: 0 | 1, need: number) {
    const cap = Math.max(need, Math.ceil((lod === 0 ? this.cap0 : this.cap1) * 1.6));
    const a = new Float32Array(cap * 16), c = new Float32Array(cap * 3), f = new Float32Array(cap * 2);
    a.set(lod === 0 ? this.a0 : this.a1); c.set(lod === 0 ? this.c0 : this.c1); f.set(lod === 0 ? this.f0 : this.f1);
    const attr = dyn(a, 16), col = dyn(c, 3), fade = dyn(f, 2);
    for (const m of lod === 0 ? this.lod0 : this.lod1) { m.instanceMatrix = attr; m.instanceColor = col; (m as unknown as { count: number }).count = 0; }
    if (fade) for (const g of lod === 0 ? this.geos0 : this.geos1) g.setAttribute("aLodFade", fade);
    if (lod === 0) { this.a0 = a; this.c0 = c; this.f0 = f; this.attr0 = attr; this.col0 = col; this.fade0 = fade; this.cap0 = cap; }
    else { this.a1 = a; this.c1 = c; this.f1 = f; this.attr1 = attr; this.col1 = col; this.fade1 = fade; this.cap1 = cap; }
  }

  /** append a block of instances (matrices + colours) to a LOD */
  pushBlock(lod: 0 | 1, mats: Float32Array, cols: Float32Array, count: number, grow = 1) {
    if (count <= 0) return;
    // a freshly streamed detail cell fades in: its COVERAGE (foliage-material V_WIND / F_FADE dither), never
    // its authored transform — every detail instance carries (−1 sentinel, visible fraction), apart from tier clocks
    if (this.detail) {
      const n = lod === 0 ? this.n0 : this.n1;
      if (n + count > (lod === 0 ? this.cap0 : this.cap1)) this.grow(lod, n + count);
      const f = lod === 0 ? this.f0 : this.f1, g = Math.max(0, Math.min(1, grow));
      for (let i = n; i < n + count; i++) { f[i * 2] = -1; f[i * 2 + 1] = g; }
    }
    if (lod === 0) {
      if (this.n0 + count > this.cap0) this.grow(0, this.n0 + count);
      this.a0.set(count * 16 === mats.length ? mats : mats.subarray(0, count * 16), this.n0 * 16);
      this.c0.set(count * 3 === cols.length ? cols : cols.subarray(0, count * 3), this.n0 * 3);
      this.n0 += count;
    } else {
      if (this.n1 + count > this.cap1) this.grow(1, this.n1 + count);
      this.a1.set(count * 16 === mats.length ? mats : mats.subarray(0, count * 16), this.n1 * 16);
      this.c1.set(count * 3 === cols.length ? cols : cols.subarray(0, count * 3), this.n1 * 3);
      this.n1 += count;
    }
  }

  end() {
    const n0 = VEG_DBG.has("nolod0") ? 0 : this.n0, n1 = VEG_DBG.has("nolod1") ? 0 : this.n1;
    // empty tiers leave the render lists entirely (an InstancedMesh with count 0 still binds its program + uniforms
    // in the main pass and every shadow cascade)
    for (const m of this.lod0) { m.count = n0; m.visible = n0 > 0; }
    for (const m of this.lod1) { m.count = n1; m.visible = n1 > 0; }
    const up = (attr: THREE.InstancedBufferAttribute | null, n: number, k: number) => {
      if (!attr || n === 0) return;
      attr.clearUpdateRanges(); attr.addUpdateRange(0, n * k); attr.needsUpdate = true;
    };
    up(this.attr0, this.n0, 16); up(this.attr1, this.n1, 16); up(this.col0, this.n0, 3); up(this.col1, this.n1, 3);
    up(this.fade0, this.n0, 2); up(this.fade1, this.n1, 2);
  }
}

function dyn(a: Float32Array, k: number): THREE.InstancedBufferAttribute {
  const at = new THREE.InstancedBufferAttribute(a, k); at.setUsage(THREE.DynamicDrawUsage); return at;
}

/** scratch sort keys shared by every pool refresh (grown on demand) */
let KEYS0 = new Float64Array(1024), KEYS1 = new Float64Array(4096);
const growKeys = (a: Float64Array, need = 0) => { const b = new Float64Array(Math.max(need, a.length * 2)); b.set(a); return b; };

/** LOD switch hysteresis: nearer switches at (1 − H)·d, farther at (1 + H)·d — nothing flickers on a boundary */
const HYST = 0.06;
const T_SETTLED = -1e6;

/**
 * The draws of one PART across several variant pools (CPU: ~86 veg draws + ~25 shadow draws cost 0.4–0.8 ms of
 * three.js / ANGLE submission per frame at the jungle cameras): every variant whose part uses the SAME material is
 * concatenated into one geometry (per-vertex aVar = the variant's slot) and drawn by ONE instanced mesh per LOD; each
 * instance carries its slot in instanceColor.g (+16 · slot) and the vertex shader collapses the other slots' vertices
 * (foliage-material V_BILLBOARD). The member pools only SELECT (tiers, crossfades, frustum); fill() merges their
 * selections near → far into the shared buffers.
 */
export class PartGroup {
  readonly meshes: LodMeshes;
  constructor(readonly members: SpeciesPool[], sp: Species, scene: THREE.Scene, cap0: number, cap1: number) {
    this.meshes = new LodMeshes(sp, scene, cap0, cap1, false);
  }

  fill() {
    const M = this.meshes, mem = this.members;
    let k0 = 0, k1 = 0;
    for (let s = 0; s < mem.length; s++) {
      const p = mem[s], b = s * 65536;
      if (k0 + p.k0 > KEYS0.length) KEYS0 = growKeys(KEYS0, k0 + p.k0);
      if (k1 + p.k1 > KEYS1.length) KEYS1 = growKeys(KEYS1, k1 + p.k1);
      // key = whole-metre² distance · 2^20 + slot · 2^16 + instance
      for (let q = 0; q < p.k0; q++) { const key = p.sel0[q], d = Math.floor(key / 65536); KEYS0[k0++] = d * 1048576 + b + (key - d * 65536); }
      for (let q = 0; q < p.k1; q++) { const key = p.sel1[q], d = Math.floor(key / 65536); KEYS1[k1++] = d * 1048576 + b + (key - d * 65536); }
    }
    const s0 = KEYS0.subarray(0, k0).sort(), s1 = KEYS1.subarray(0, k1).sort();
    M.begin();
    // (a group may draw only one tier — buildPartGroups splits heavy LOD0 / light LOD1)
    if (!M.lod0.length) k0 = 0;
    if (!M.lod1.length) k1 = 0;
    if (k0 > M.cap0) M.grow(0, k0);
    if (k1 > M.cap1) M.grow(1, k1);
    const now = VEG_NOW.t;
    const copy = (keys: Float64Array, n: number, a: Float32Array, c: Float32Array, f: Float32Array, lod: number) => {
      for (let q = 0; q < n; q++) {
        const key = keys[q], lo = key % 1048576, slot = Math.floor(lo / 65536), i = lo - slot * 65536, p = mem[slot];
        const mat = p.mat, col = p.col, mi = i * 16, ci = i * 3, oo = q * 16, oc = q * 3;
        for (let j = 0; j < 16; j++) a[oo + j] = mat[mi + j];
        c[oc] = col[ci]; c[oc + 1] = col[ci + 1] + 16 * slot; c[oc + 2] = col[ci + 2];
        const fading = now - p.tsw[i] < VEG_FADE_T;
        f[q * 2] = p.tsw[i]; f[q * 2 + 1] = !fading ? 0 : p.tier[i] === lod ? 1 : -1;
      }
    };
    copy(s0, k0, M.a0, M.c0, M.f0, 0);
    copy(s1, k1, M.a1, M.c1, M.f1, 1);
    M.n0 = k0; M.n1 = k1;
    { const lim = (SHADOW1_D * SHADOW1_D + 1) * 1048576; let n = 0; while (n < k1 && s1[n] < lim) n++; M.nShadow1 = n; }
    { const lim = OUT_KEY * 1048576; let n = 0; while (n < k0 && s0[n] < lim) n++; M.nView0 = n; }
    // (nearest SURFACE, roughly: centre distance minus half the bounding radius — a tree's centre is up in its crown)
    const near = (key: number) => { const lo = key % 1048576, slot = Math.floor(lo / 65536); return Math.max(0, Math.sqrt(Math.floor(key / 1048576)) - 0.5 * mem[slot].ctr[(lo - slot * 65536) * 4 + 3]); };
    M.setOrder(k0 ? near(s0[0]) : 999, k1 ? near(s1[0]) : 999);
    M.end();
  }
}

/** merged geometry budget (tris per LOD) — above it a part draws once per variant. The other variants' vertices exit
 * the vertex shader on its first line (foliage-material V_WIND), so a merged draw costs little more than its own
 * variant's work (CPU: ~6 µs of three.js / ANGLE submission per draw — 70 veg draws were 0.4 ms of every frame) */
const MERGE_TRIS = 1200;

/** the crossfade clock of the current refresh (SpeciesPool.update sets it; PartGroup.fill reads it) */
const VEG_NOW = { t: 0 };

/**
 * Build the part groups of a FAMILY of variant pools (the variants of one kind, or palm + palm-leaning): parts with the
 * same name and the same material merge into one group (their geometries concatenated with aVar = slot); a part whose
 * attributes do not match the others' gets its own group.
 */
export function buildPartGroups(pools: SpeciesPool[], scene: THREE.Scene, caps: { cap0: number; cap1: number }): PartGroup[] {
  const byKey = new Map<string, Array<{ pool: SpeciesPool; part: Species["parts"][number] }>>();
  for (const pool of pools) for (const part of pool.sp.parts) {
    const key = `${part.name}|${part.mats.mat.uuid}|${part.shadow === false ? 0 : 1}`;
    let l = byKey.get(key); if (!l) { l = []; byKey.set(key, l); } l.push({ pool, part });
  }
  const sig = (g: THREE.BufferGeometry) => Object.keys(g.attributes).filter((k) => k !== "aVar").sort().join(",") + (g.index ? "|i" : "|n");
  const groups: PartGroup[] = [];
  const make = (list: Array<{ pool: SpeciesPool; part: Species["parts"][number] }>, lods: 0 | 1 | 2 = 2) => {
    const tag = (g: THREE.BufferGeometry, slot: number) => {
      if (!g.attributes.position || g.attributes.position.count === 0) return null;
      const c = new THREE.BufferGeometry();
      if (g.index) c.setIndex(g.index);
      for (const k of Object.keys(g.attributes)) c.setAttribute(k, g.attributes[k]);
      c.setAttribute("aVar", new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count).fill(slot), 1));
      return c;
    };
    const merged = (lod: 0 | 1) => {
      if (lods !== 2 && lods !== lod) return new THREE.BufferGeometry();
      const gs = list.map((e, slot) => tag(lod === 0 ? e.part.lod0 : e.part.lod1, slot)).filter((g): g is THREE.BufferGeometry => !!g);
      if (!gs.length) return new THREE.BufferGeometry();
      if (gs.length === 1) return gs[0];
      const m = mergeGeometries(gs, false);
      if (!m) throw new Error("veg: part merge failed");
      m.computeBoundingSphere();
      return m;
    };
    const first = list[0];
    const sp: Species = { ...first.pool.sp, id: `${first.pool.sp.kind}:${first.pool.sp.variant}`, parts: [{ ...first.part, lod0: merged(0), lod1: merged(1) }] };
    const g = new PartGroup(list.map((e) => e.pool), sp, scene, caps.cap0, caps.cap1);
    for (const e of list) e.pool.groups.push(g);
    groups.push(g);
  };
  const empty = (g: THREE.BufferGeometry) => !g.attributes.position || g.attributes.position.count === 0;
  for (const list of byKey.values()) {
    // (every geometry of a merge needs the same attribute set per LOD; the odd one out draws alone)
    const ref0 = list.find((e) => !empty(e.part.lod0))?.part.lod0, ref1 = list.find((e) => !empty(e.part.lod1))?.part.lod1;
    let ok = list.filter((e) => (empty(e.part.lod0) || sig(e.part.lod0) === sig(ref0!)) && (empty(e.part.lod1) || sig(e.part.lod1) === sig(ref1!)));
    // every instance runs the vertex shader over ALL merged variants (the others collapse): merge only light parts —
    // heavy LOD0 parts (tree trunks with buttresses, palm crowns) keep one draw per variant (JS submission is only
    // ~0.14 ms for all veg draws at the jungle view — the vertex work matters more)
    const tris = (g: THREE.BufferGeometry) => (g.index ? g.index.count : g.attributes.position?.count ?? 0) / 3;
    const big0 = ok.reduce((a, e) => a + tris(e.part.lod0), 0) > MERGE_TRIS, big1 = ok.reduce((a, e) => a + tris(e.part.lod1), 0) > MERGE_TRIS;
    if (ok.length > 1 && big0 && !big1) {
      // heavy LOD0 (one draw per variant), light LOD1 (one merged draw)
      for (const e of ok) make([e], 0);
      make(ok, 1);
    } else {
      if (big0 || big1) ok = [];
      if (ok.length) make(ok);
    }
    for (const e of list) if (!ok.includes(e)) make([e]);
  }
  return groups;
}

/** one species' instances (the draws belong to its PartGroups) */
export class SpeciesPool {
  n = 0;
  cap: number;
  /** pre-composed world matrices (16 per instance), colours (3), bounding sphere centre + radius (4) */
  mat: Float32Array;
  col: Float32Array;
  ctr: Float32Array;
  /** raw placement (x, y, z, yaw, scale) — impostor rebuilds and debugging */
  raw: Float32Array;
  /** the draw groups this pool's parts belong to (buildPartGroups) */
  groups: PartGroup[] = [];
  /** the last refresh's selection: sort keys (whole-metre² distance · 65536 + instance) per tier */
  sel0 = new Float64Array(64); sel1 = new Float64Array(256); k0 = 0; k1 = 0;
  /** instances added since the impostor meshes were last filled (ImpostorSet.refresh) */
  impDirty = true;
  stats: PoolStats = { n: 0, lod0: 0, lod1: 0 };
  /** per instance: displayed tier (0 LOD0, 1 LOD1, 2 impostor / nothing), the tier before the last switch, its time */
  tier: Uint8Array; prev: Uint8Array; tsw: Float32Array;
  /** where this pool's instances live in the impostor mesh's fade buffer (ImpostorSet.refresh) */
  imp: ImpLink | null = null;
  private seen: Uint32Array; private stamp = 0;
  private active = new Int32Array(256); private nActive = 0; private isActive: Uint8Array;
  private gridDirty = true;
  private cs = new Int32Array(GRID_N * GRID_N + 1);
  private items = new Int32Array(0);
  private cy0 = new Float32Array(GRID_N * GRID_N);
  private cy1 = new Float32Array(GRID_N * GRID_N);
  private maxR = 0;
  private refreshed = false;
  private lastCam = new THREE.Vector3(Infinity, 0, 0);

  constructor(readonly sp: Species, readonly scene: THREE.Scene, o: { cap?: number; cap0?: number; cap1?: number } = {}) {
    this.cap = o.cap ?? 1024;
    this.mat = new Float32Array(this.cap * 16); this.col = new Float32Array(this.cap * 3); this.ctr = new Float32Array(this.cap * 4); this.raw = new Float32Array(this.cap * 5);
    this.tier = new Uint8Array(this.cap).fill(2); this.prev = new Uint8Array(this.cap).fill(2); this.tsw = new Float32Array(this.cap).fill(T_SETTLED);
    this.seen = new Uint32Array(this.cap); this.isActive = new Uint8Array(this.cap);
    void o;
  }

  add(x: number, y: number, z: number, yaw: number, scale: number, r = 1, g = 1, b = 1) {
    if (this.n >= this.cap) this.grow();
    const i = this.n++;
    writeMatrix(this.mat, i * 16, x, y, z, yaw, scale);
    this.col[i * 3] = r; this.col[i * 3 + 1] = g; this.col[i * 3 + 2] = b;
    const sp = this.sp, c = Math.cos(yaw), s = Math.sin(yaw);
    this.ctr[i * 4] = x + (sp.center.x * c + sp.center.z * s) * scale;
    this.ctr[i * 4 + 1] = y + sp.center.y * scale;
    this.ctr[i * 4 + 2] = z + (-sp.center.x * s + sp.center.z * c) * scale;
    this.ctr[i * 4 + 3] = sp.boundR * scale;
    const w = this.raw; w[i * 5] = x; w[i * 5 + 1] = y; w[i * 5 + 2] = z; w[i * 5 + 3] = yaw; w[i * 5 + 4] = scale;
    this.tier[i] = 2; this.prev[i] = 2; this.tsw[i] = T_SETTLED;
    this.gridDirty = true; this.impDirty = true;
  }

  private grow() {
    const cap = this.cap * 2;
    const g = <T extends Float32Array | Uint8Array | Uint32Array>(a: T, k: number, fill?: number): T => { const b = new (a.constructor as { new(n: number): T })(cap * k); if (fill !== undefined) b.fill(fill); b.set(a); return b; };
    this.mat = g(this.mat, 16); this.col = g(this.col, 3); this.ctr = g(this.ctr, 4); this.raw = g(this.raw, 5);
    this.tier = g(this.tier, 1, 2); this.prev = g(this.prev, 1, 2); this.tsw = g(this.tsw, 1, T_SETTLED);
    this.seen = g(this.seen, 1); this.isActive = g(this.isActive, 1);
    this.cap = cap;
  }

  private cellOf(v: number) { return Math.min(GRID_N - 1, Math.max(0, Math.floor((v + GRID_HALF) / CELL))); }

  /** CSR grid over the instance sphere centres (+ per-cell vertical bounds for the cell frustum test) */
  private rebuildGrid() {
    this.gridDirty = false;
    const n = this.n, cs = this.cs, ctr = this.ctr;
    cs.fill(0); this.cy0.fill(1e9); this.cy1.fill(-1e9);
    const cell = new Int32Array(n);
    let maxR = 0;
    for (let i = 0; i < n; i++) {
      const k = this.cellOf(ctr[i * 4 + 2]) * GRID_N + this.cellOf(ctr[i * 4]);
      cell[i] = k; cs[k + 1]++;
      const r = ctr[i * 4 + 3]; if (r > maxR) maxR = r;
      this.cy0[k] = Math.min(this.cy0[k], ctr[i * 4 + 1] - r); this.cy1[k] = Math.max(this.cy1[k], ctr[i * 4 + 1] + r);
    }
    this.maxR = maxR;
    for (let k = 0; k < GRID_N * GRID_N; k++) cs[k + 1] += cs[k];
    const fill = cs.slice(0, GRID_N * GRID_N);
    this.items = new Int32Array(n);
    for (let i = 0; i < n; i++) this.items[fill[cell[i]]++] = i;
  }

  /** the impostor quad's fade state for instance i (x = switch time, y = 0 visible | 1 in | −1 out | 2 hidden) */
  impFade(i: number, out: Float32Array, o: number) {
    const t = this.tier[i], p = this.prev[i];
    if (t === 2) { out[o] = this.tsw[i]; out[o + 1] = p === 2 || this.tsw[i] === T_SETTLED ? 0 : 1; }
    else { out[o] = this.tsw[i]; out[o + 1] = p === 2 && this.tsw[i] !== T_SETTLED ? -1 : 2; }
  }

  private switchTo(i: number, want: number, now: number, instant: boolean) {
    this.prev[i] = this.tier[i]; this.tier[i] = want; this.tsw[i] = instant ? T_SETTLED : now;
    if (instant) LOD_STATS.instant++; else LOD_STATS.faded++;
    if (!this.isActive[i]) {
      this.isActive[i] = 1;
      if (this.nActive >= this.active.length) { const b = new Int32Array(this.active.length * 2); b.set(this.active); this.active = b; }
      this.active[this.nActive++] = i;
    }
    const im = this.imp;
    if (im && (want === 2 || this.prev[i] === 2)) {
      // the master (cell-sorted) slot of this instance, and its slot in the frustum-compacted draw buffer if present
      const ms = im.g.slot[im.offset + i];
      this.impFade(i, im.g.F, ms * 2);
      if (ms < im.g.lo) im.g.lo = ms; if (ms > im.g.hi) im.g.hi = ms;
      const cs = im.g.cmap[ms];
      if (cs >= 0) { this.impFade(i, im.g.cF, cs * 2); if (cs < im.g.clo) im.g.clo = cs; if (cs > im.g.chi) im.g.chi = cs; }
    }
  }

  /**
   * Refill the LOD tiers around the camera. P = frustum planes (frustumPlanes()). `now` = the crossfade clock
   * (VEG_UNIFORMS.uFadeNow). Every instance within range updates its tier (with hysteresis) whether or not it is in
   * view; a switch starts a VEG_FADE_T crossfade (both tiers drawn, complementary dither) unless `instant`.
   */
  update(cam: THREE.Vector3, frustum: THREE.Frustum, P: Float32Array, now: number, instantAll = false) {
    if (this.gridDirty) this.rebuildGrid();
    // first fill, shots and teleports switch without a fade
    const instant = instantAll || !this.refreshed || cam.distanceTo(this.lastCam) > 40;
    this.refreshed = true; this.lastCam.copy(cam);
    const sp = this.sp;
    VEG_NOW.t = now;
    const in0 = (sp.lod0 * (1 - HYST)) ** 2, out0 = (sp.lod0 * (1 + HYST)) ** 2;
    const in1 = (sp.lod1 * (1 - HYST)) ** 2, out1 = (sp.lod1 * (1 + HYST)) ** 2;
    const stamp = ++this.stamp;
    const range = sp.lod1 * (1 + HYST) + this.maxR + 2;
    const kx0 = this.cellOf(cam.x - range), kx1 = this.cellOf(cam.x + range);
    const kz0 = this.cellOf(cam.z - range), kz1 = this.cellOf(cam.z + range);
    const cs = this.cs, items = this.items, ctr = this.ctr;
    const tier = this.tier, prev = this.prev, tsw = this.tsw, seen = this.seen;
    let k0 = 0, k1 = 0, S0 = this.sel0, S1 = this.sel1;
    // does a tier cast into the dynamic cascades (the video tier switches veg casting live)? Only then are its
    // out-of-view near instances kept, for the shadow passes (Low casts no veg: nothing out of view is drawn)
    let cast0 = false, cast1 = false;
    for (let g = 0; g < this.groups.length; g++) {
      const L = this.groups[g].meshes;
      for (let m = 0; m < L.lod0.length; m++) if (L.lod0[m].castShadow) cast0 = true;
      for (let m = 0; m < L.lod1.length; m++) if (L.lod1[m].castShadow) cast1 = true;
    }
    for (let kz = kz0; kz <= kz1; kz++) for (let kx = kx0; kx <= kx1; kx++) {
      const k = kz * GRID_N + kx, s = cs[k], e = cs[k + 1];
      if (s === e) continue;
      const x0 = kx * CELL - GRID_HALF, z0 = kz * CELL - GRID_HALF;
      const nx = Math.max(x0, Math.min(cam.x, x0 + CELL)) - cam.x, nz = Math.max(z0, Math.min(cam.z, z0 + CELL)) - cam.z;
      const near2 = nx * nx + nz * nz;
      if (near2 > range * range) continue;
      let cellVis = true;
      if (near2 > 900) {
        box.min.set(x0 - this.maxR, this.cy0[k], z0 - this.maxR); box.max.set(x0 + CELL + this.maxR, this.cy1[k], z0 + CELL + this.maxR);
        cellVis = frustum.intersectsBox(box);
      }
      for (let q = s; q < e; q++) {
        const i = items[q], o = i * 4;
        const dx = ctr[o] - cam.x, dy = ctr[o + 1] - cam.y, dz = ctr[o + 2] - cam.z;
        const dist2 = dx * dx + dy * dy + dz * dz;
        seen[i] = stamp;
        const cur = tier[i];
        let want = cur;
        if (cur === 0) { if (dist2 > out1) want = 2; else if (dist2 > out0) want = 1; }
        else if (cur === 1) { if (dist2 < in0) want = 0; else if (dist2 > out1) want = 2; }
        else if (dist2 < in0) want = 0; else if (dist2 < in1) want = 1;
        if (want !== cur) this.switchTo(i, want, now, instant);
        const t = tier[i], fading = now - tsw[i] < VEG_FADE_T, p = prev[i];
        const show0 = t === 0 || (fading && p === 0), show1 = t === 1 || (fading && p === 1);
        if (!show0 && !show1) continue;
        if (!cellVis) continue;
        // in view: the widened frustum (within 40 m the sphere padded by VIEW_PAD). Out of view, an instance within
        // 40 m stays for a tier that casts — LOD0 sorts it after every in-view instance (PartGroup.fill → nView0: the
        // main pass stops before it), LOD1 keeps it near → far inside its casting prefix (drawn by both passes)
        const near = dist2 <= 1600;
        const vis = sphereIn(P, ctr[o], ctr[o + 1], ctr[o + 2], near ? ctr[o + 3] + VIEW_PAD : ctr[o + 3]);
        if (!vis && !(near && ((show0 && cast0) || (show1 && cast1)))) continue;
        // sort key: whole-metre² distance in the high bits, instance index in the low 16 (near → far after sorting)
        const key = Math.floor(dist2) * 65536 + i;
        if (show0 && (vis || cast0)) { if (k0 >= S0.length) S0 = this.sel0 = growKeys(S0); S0[k0++] = vis ? key : key + OUT_KEY * 65536; }
        if (show1 && (vis || cast1)) { if (k1 >= S1.length) S1 = this.sel1 = growKeys(S1); S1[k1++] = key; }
      }
    }
    // instances that left the range (teleport / sprint past the ring) go back to their impostor; transitions that are
    // over leave the active list
    let w = 0;
    const act = this.active;
    for (let a = 0; a < this.nActive; a++) {
      const i = act[a];
      if (seen[i] !== stamp && tier[i] !== 2) this.switchTo(i, 2, now, instant);
      if (tier[i] !== 2 || now - tsw[i] < VEG_FADE_T) act[w++] = i; else this.isActive[i] = 0;
    }
    this.nActive = w;
    this.imp?.g.flush();
    // the part groups merge the selections of their member pools and copy them near → far (PartGroup.fill)
    this.k0 = k0; this.k1 = k1;
    this.stats.n = this.n; this.stats.lod0 = k0; this.stats.lod1 = k1;
  }
}

/** what a pool writes its tier switches into: the impostor group, or the splat set (splat.ts SplatGroup) */
export interface ImpTarget {
  slot: Int32Array; F: Float32Array; cmap: Int32Array; cF: Float32Array;
  lo: number; hi: number; clo: number; chi: number;
  flush(): void;
}
/** a pool's link into its impostor group: instance i lives at master slot g.slot[offset + i] */
export interface ImpLink { g: ImpTarget; offset: number }

const IMP_CELL = 128;
const IMP_GRID = Math.ceil((2 * GRID_HALF) / IMP_CELL);

/**
 * One impostor bank's instances (not all 46–56 k impostor tris at every camera): the MASTER arrays
 * hold every instance sorted by 128 m cell (the static far-shadow bake draws all of them); the DRAW mesh holds only
 * the cells inside a widened view frustum, re-compacted (whole cells, TypedArray copies) when the camera has moved
 * > 16 m or turned > 15° since the last compaction (at most every 90 ms). While the view is outside the compacted
 * wedge (a fast flick between compactions) the master mesh draws instead — never a missing tree.
 */
export class ImpGroup implements ImpTarget {
  n = 0;
  M = new Float32Array(0); C = new Float32Array(0); S = new Float32Array(0); F = new Float32Array(0);
  /** per instance: vector to the nearest dirt road + its edge distance (impostor.ts road clearance from the air) */
  Rd = new Float32Array(0);
  /** pool order (offset + i) → master slot */
  slot = new Int32Array(0);
  /** master slot → compact slot (−1 = not in the draw buffer) */
  cmap = new Int32Array(0);
  cF = new Float32Array(0);
  /** per cell: [start, end) in the master arrays + vertical bounds */
  cellS = new Int32Array(IMP_GRID * IMP_GRID + 1); cellY0 = new Float32Array(IMP_GRID * IMP_GRID); cellY1 = new Float32Array(IMP_GRID * IMP_GRID);
  mesh: THREE.InstancedMesh | null = null;      // master (all) — far-shadow bake + fallback
  cmesh: THREE.InstancedMesh | null = null;     // compacted draw mesh
  fade: THREE.InstancedBufferAttribute | null = null; cfade: THREE.InstancedBufferAttribute | null = null;
  lo = 1 << 30; hi = -1; clo = 1 << 30; chi = -1;
  cPos = new THREE.Vector3(Infinity, 0, 0); cDir = new THREE.Vector3(); cTime = -1e9; cValid = false; cFar = 0;
  constructor(readonly bank: ImpostorBank, readonly pools: SpeciesPool[], readonly layer: Map<SpeciesPool, number>, readonly casts: boolean) {}

  flush() {
    if (this.fade && this.hi >= this.lo) { this.fade.addUpdateRange(this.lo * 2, (this.hi - this.lo + 1) * 2); this.fade.needsUpdate = true; }
    if (this.cfade && this.chi >= this.clo) { this.cfade.addUpdateRange(this.clo * 2, (this.chi - this.clo + 1) * 2); this.cfade.needsUpdate = true; }
    this.lo = this.clo = 1 << 30; this.hi = this.chi = -1;
  }
}

export class ImpostorSet {
  private groups: ImpGroup[] = [];
  built = false;
  /** the understory bank's reach for a ground-level eye (m) — veg quality tier (VegSystem.setQuality) */
  underFar = 330;
  /** impostors crossfade between their baked views */
  readonly blend = IMP_BLEND;
  /** ?impcull=0 draws every impostor every frame (A/B) */
  cullOn = flag("impcull");
  private cullCam = new THREE.PerspectiveCamera();
  private visCells: number[] = [];
  private frustum = new THREE.Frustum();
  /** nearest dirt road of a plant base (veg-scatter nearestRoad) — set by the veg system */
  roadAt: ((x: number, z: number) => { dx: number; dz: number; d: number }) | null = null;
  constructor(readonly scene: THREE.Scene) {}
  /** atlas sizes (albedo / normal) of the tree bank and the understory bank — set by the veg quality tier before the
   *  bake (192 px views were magnified 2.5× at the 4K switch — High / Epic bake 2048²) */
  atlas = { big: 1536, bigN: 1024, small: 768, smallN: 512 };

  /** bake every impostor species (needs its textures loaded) and fill the meshes */
  build(renderer: THREE.WebGLRenderer, pools: SpeciesPool[], which: "all" | "small" | "big" | "none" = "all") {
    if (VEG_DBG.has("noimp")) { this.built = true; return; }
    // (the big plants are drawn as gaussian splats — splat.ts — "small" bakes only the understory bank;
    // "big" is the fallback when the splat bake failed)
    const big = which === "small" || which === "none" ? [] : pools.filter((p) => p.sp.impostor && p.sp.height > 6), small = which === "big" || which === "none" ? [] : pools.filter((p) => p.sp.impostor && p.sp.height <= 6);
    // albedo 1536² (8×8 views of ~190 px, each fitted to the plant's tight bounds) / normals 1024² for the trees; the
    // small understory 768² / 512²
    const A = this.atlas;
    for (const [list, size, nsize, casts] of [[big, A.big, A.bigN, true], [small, A.small, A.smallN, false]] as const) {
      if (!list.length) continue;
      const bank = new ImpostorBank(size, list.length, 8, nsize);
      const layer = new Map<SpeciesPool, number>();
      for (const p of list) layer.set(p, bank.add(renderer, p.sp));
      this.groups.push(new ImpGroup(bank, list, layer, casts && IMPOSTOR_SHADOWS));
    }
    this.built = true;
    this.refresh(true);
  }

  private makeMesh(g: ImpGroup, n: number, master: boolean): THREE.InstancedMesh {
    const geo = impostorQuad();
    const im = new THREE.InstancedMesh(geo, g.bank.mats.mat, Math.max(1, n));
    const fade = new THREE.InstancedBufferAttribute(master ? g.F : g.cF, 2); fade.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("aSpecies", new THREE.InstancedBufferAttribute(master ? g.S : new Float32Array(Math.max(1, n)), 1));
    geo.setAttribute("aRoad", new THREE.InstancedBufferAttribute(master ? g.Rd : new Float32Array(Math.max(1, n) * 3), 3));
    geo.setAttribute("aFade", fade);
    if (master) { (im.instanceMatrix.array as Float32Array).set(g.M); im.instanceColor = new THREE.InstancedBufferAttribute(g.C, 3); g.fade = fade; }
    else { im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, n) * 3), 3); g.cfade = fade; im.instanceMatrix.setUsage(THREE.DynamicDrawUsage); im.instanceColor.setUsage(THREE.DynamicDrawUsage); (geo.attributes.aSpecies as THREE.InstancedBufferAttribute).setUsage(THREE.DynamicDrawUsage); (geo.attributes.aRoad as THREE.InstancedBufferAttribute).setUsage(THREE.DynamicDrawUsage); }
    im.instanceMatrix.needsUpdate = true;
    im.customDepthMaterial = g.bank.mats.depth;
    const casts = master && g.casts;
    im.castShadow = casts; im.receiveShadow = true;
    // (the master mesh is hidden while the compacted one draws: "force" lets atmos' far-map bake draw it anyway)
    im.userData.castShadow = casts; im.userData.farShadow = casts ? "force" : false;
    const U = g.bank.uniforms;
    let saved = -1;
    im.onBeforeShadow = (_r, _o, _c, shadowCam) => {
      const oc = shadowCam as THREE.OrthographicCamera;
      if (oc.isOrthographicCamera && oc.right - oc.left > 900) U.uNoFade.value = 1;
      else { saved = im.count; im.count = 0; }
    };
    im.onAfterShadow = () => { U.uNoFade.value = 0; if (saved >= 0) { im.count = saved; saved = -1; } };
    im.renderOrder = 1;
    im.frustumCulled = false;
    im.name = `veg:impostor:${g.bank.size}${master ? "" : ":view"}`;
    this.scene.add(im);
    return im;
  }

  /** refill the instance buffers when plants were added (POIs planting after the bake) */
  refresh(force = false) {
    for (const g of this.groups) {
      if (!force && !g.pools.some((p) => p.impDirty)) continue;
      let n = 0;
      for (const p of g.pools) { n += p.n; p.impDirty = false; }
      for (const m of [g.mesh, g.cmesh]) if (m) { this.scene.remove(m); m.dispose(); }
      g.mesh = g.cmesh = null; g.cValid = false; g.cTime = -1e9;
      g.n = n;
      if (!n) continue;
      // pool order → cell-sorted master order
      const cellOf = new Int32Array(n), cnt = new Int32Array(IMP_GRID * IMP_GRID + 1);
      const cl = (v: number) => Math.min(IMP_GRID - 1, Math.max(0, Math.floor((v + GRID_HALF) / IMP_CELL)));
      g.cellY0.fill(1e9); g.cellY1.fill(-1e9);
      let o = 0;
      for (const p of g.pools) {
        for (let i = 0; i < p.n; i++) {
          const k = cl(p.ctr[i * 4 + 2]) * IMP_GRID + cl(p.ctr[i * 4]);
          cellOf[o + i] = k; cnt[k + 1]++;
          const r = p.ctr[i * 4 + 3];
          g.cellY0[k] = Math.min(g.cellY0[k], p.ctr[i * 4 + 1] - r); g.cellY1[k] = Math.max(g.cellY1[k], p.ctr[i * 4 + 1] + r);
        }
        o += p.n;
      }
      for (let k = 0; k < IMP_GRID * IMP_GRID; k++) cnt[k + 1] += cnt[k];
      g.cellS.set(cnt);
      const fillAt = cnt.slice(0, IMP_GRID * IMP_GRID);
      g.slot = new Int32Array(n);
      for (let j = 0; j < n; j++) g.slot[j] = fillAt[cellOf[j]]++;
      g.M = new Float32Array(n * 16); g.C = new Float32Array(n * 3); g.S = new Float32Array(n); g.F = new Float32Array(n * 2); g.Rd = new Float32Array(n * 3).fill(999);
      g.cmap = new Int32Array(n).fill(-1); g.cF = new Float32Array(n * 2);
      o = 0;
      for (const p of g.pools) {
        const sp = g.layer.get(p)!;
        for (let i = 0; i < p.n; i++) {
          const ms = g.slot[o + i];
          g.M.set(p.mat.subarray(i * 16, i * 16 + 16), ms * 16);
          // strip the canopy-occlusion code from the red tint (impostors are lit from above: open sky)
          const r = p.col[i * 3];
          g.C[ms * 3] = r - 8 * Math.floor(r / 8); g.C[ms * 3 + 1] = p.col[i * 3 + 1]; g.C[ms * 3 + 2] = p.col[i * 3 + 2];
          g.S[ms] = sp;
          if (this.roadAt) { const q = this.roadAt(p.raw[i * 5], p.raw[i * 5 + 2]); if (q.d < 60) { g.Rd[ms * 3] = q.dx; g.Rd[ms * 3 + 1] = q.dz; g.Rd[ms * 3 + 2] = q.d; } }
          // the pools own each instance's tier: re-fill its current crossfade state and let the pool write switches
          p.impFade(i, g.F, ms * 2);
        }
        p.imp = { g, offset: o };
        o += p.n;
      }
      g.mesh = this.makeMesh(g, n, true);
      if (this.cullOn) { g.cmesh = this.makeMesh(g, n, false); g.cmesh.visible = false; }
    }
  }

  /**
   * Per frame: keep each bank's draw buffer to the cells in a widened frustum around the view (re-compacted when the
   * camera moved / turned past the wedge's margin); fall back to the master mesh while outside it.
   */
  cull(cam: THREE.PerspectiveCamera, now: number, force = false) {
    if (!this.cullOn) return;
    const dir = cam.getWorldDirection(TMPV);
    for (const g of this.groups) {
      if (!g.mesh || !g.cmesh) continue;
      // understory far band: continuous in the eye's altitude, so a glider descent never flips whole cells
      // off; the shader shrinks the plants out over the band
      if (g.bank.size < 1536) {
        // (the band's reach grows with the eye's height — 8 m per m above 30 m: a glider descent sweeps it in smoothly)
        const far = Math.min(8000, this.underFar + Math.max(0, cam.position.y - 30) * 8);
        g.bank.uniforms.uImpFar.value.set(far - Math.max(90, far * 0.25), far);
        // the band grew (climbing) past the compaction's 40 m margin: re-compact (the master mesh draws meanwhile)
        if (g.cValid && far > g.cFar + 35) g.cValid = false;
      }
      const stale = !g.cValid || cam.position.distanceTo(g.cPos) > 16 || dir.dot(g.cDir) < Math.cos((15 * Math.PI) / 180);
      if (stale && (force || now - g.cTime > 90)) this.compact(g, cam, dir, now);
      const ok = g.cValid && cam.position.distanceTo(g.cPos) <= 16 && dir.dot(g.cDir) >= Math.cos((15 * Math.PI) / 180);
      g.cmesh.visible = ok && g.cmesh.count > 0; g.mesh.visible = !ok;
    }
  }

  private compact(g: ImpGroup, cam: THREE.PerspectiveCamera, dir: THREE.Vector3, now: number) {
    const cc = this.cullCam;
    cc.fov = Math.min(170, cam.fov + 34); cc.aspect = cam.aspect; cc.near = 0.1; cc.far = 8000; cc.updateProjectionMatrix();
    cc.matrixWorldInverse.copy(cam.matrixWorld).invert();
    // pull the wedge's apex back 20 m so moving up to 16 m never uncovers a cell at the frame edge
    TMPM.makeTranslation(-dir.x * 20, -dir.y * 20, -dir.z * 20).premultiply(cam.matrixWorld);
    cc.matrixWorldInverse.copy(TMPM).invert();
    this.frustum.setFromProjectionMatrix(TMPM.multiplyMatrices(cc.projectionMatrix, cc.matrixWorldInverse));
    const cm = g.cmesh!, M = cm.instanceMatrix.array as Float32Array, C = cm.instanceColor!.array as Float32Array;
    const S = (cm.geometry.attributes.aSpecies as THREE.InstancedBufferAttribute).array as Float32Array;
    const Rd = (cm.geometry.attributes.aRoad as THREE.InstancedBufferAttribute).array as Float32Array;
    g.cmap.fill(-1);
    // (perf: the visible cells go into the draw buffer NEAR → FAR — the nearer impostors' depth then rejects the
    // ones behind them before they are shaded; cell-index order drew the far side of the island first half the time)
    const vis = this.visCells; vis.length = 0;
    for (let kz = 0; kz < IMP_GRID; kz++) for (let kx = 0; kx < IMP_GRID; kx++) {
      const k = kz * IMP_GRID + kx, s0 = g.cellS[k], s1 = g.cellS[k + 1];
      if (s0 === s1) continue;
      const x0 = kx * IMP_CELL - GRID_HALF, z0 = kz * IMP_CELL - GRID_HALF;
      box.min.set(x0 - 20, g.cellY0[k], z0 - 20); box.max.set(x0 + IMP_CELL + 20, g.cellY1[k], z0 + IMP_CELL + 20);
      if (!this.frustum.intersectsBox(box)) continue;
      const dx = x0 + IMP_CELL / 2 - cam.position.x, dz = z0 + IMP_CELL / 2 - cam.position.z;
      // (perf: the understory bank — bushes / banana / monstera, ≤ 6 m — ends at ~340 m for a ground-level eye:
      // there a 2 m bush is ~2 px under the tree impostors; from the air (> 150 m up) the whole island keeps it)
      if (g.bank.size < 1536) { const nx = Math.max(0, Math.abs(dx) - IMP_CELL / 2), nz = Math.max(0, Math.abs(dz) - IMP_CELL / 2), lim = g.bank.uniforms.uImpFar.value.y + 40; if (nx * nx + nz * nz > lim * lim) continue; }
      vis.push(Math.floor(dx * dx + dz * dz) * 65536 + k);
    }
    vis.sort((a, b) => a - b);
    let c = 0;
    for (const key of vis) {
      const k = key % 65536, s0 = g.cellS[k], s1 = g.cellS[k + 1];
      const m = s1 - s0;
      M.set(g.M.subarray(s0 * 16, s1 * 16), c * 16); C.set(g.C.subarray(s0 * 3, s1 * 3), c * 3);
      S.set(g.S.subarray(s0, s1), c); g.cF.set(g.F.subarray(s0 * 2, s1 * 2), c * 2); Rd.set(g.Rd.subarray(s0 * 3, s1 * 3), c * 3);
      for (let j = 0; j < m; j++) g.cmap[s0 + j] = c + j;
      c += m;
    }
    cm.count = c;
    const up = (a: THREE.BufferAttribute, k: number) => { a.clearUpdateRanges(); if (c) a.addUpdateRange(0, c * k); a.needsUpdate = true; };
    up(cm.instanceMatrix, 16); up(cm.instanceColor!, 3); up(cm.geometry.attributes.aSpecies as THREE.BufferAttribute, 1); up(g.cfade!, 2); up(cm.geometry.attributes.aRoad as THREE.BufferAttribute, 3);
    g.clo = 1 << 30; g.chi = -1;
    g.cPos.copy(cam.position); g.cDir.copy(dir); g.cTime = now; g.cValid = true; g.cFar = g.bank.uniforms.uImpFar.value.y;
  }

  get meshes() { return this.groups.flatMap((g) => [g.mesh, g.cmesh]).filter((m): m is THREE.InstancedMesh => !!m); }
  /** instances in the draw buffers (probes) */
  get drawn() { return this.groups.map((g) => (g.cmesh?.visible ? g.cmesh.count : g.n)); }
}

const TMPV = new THREE.Vector3();
const TMPM = new THREE.Matrix4();

/** a detail species (grass, ferns …): filled from the veg system's per-cell blocks every refresh */
export class DetailPool {
  meshes: LodMeshes;
  /** drawn without depth write (lawn): blocks must arrive far → near */
  readonly noDepth: boolean;
  stats: PoolStats = { n: 0, lod0: 0, lod1: 0 };
  /** the thinning band [start, end] (m) of the species' first part (its material's uFade) */
  fade: [number, number];
  constructor(readonly sp: Species, scene: THREE.Scene, o: { cap0: number; cap1: number }) {
    this.meshes = new LodMeshes(sp, scene, o.cap0, o.cap1, true);
    this.noDepth = !!sp.parts[0].mats.mat.userData.vegNoDepth;
    const f = (sp.parts[0].mats.mat.userData.veg as { uFade: { value: THREE.Vector4 } }).uFade.value;
    this.fade = [f.x, f.y];
  }
  private d0 = 999; private d1 = 999;
  begin() { this.meshes.begin(); this.d0 = this.d1 = 999; }
  /** `dmin` = the block's cell distance (blocks arrive near → far for depth-writing pools) */
  push(lod: 0 | 1, mats: Float32Array, cols: Float32Array, count: number, dmin = 0, grow = 1) {
    // (ground plants: at least the eye height away even in the camera's own cell)
    const d = Math.hypot(dmin, 1.6);
    if (lod === 0) this.d0 = Math.min(this.d0, d); else this.d1 = Math.min(this.d1, d);
    this.meshes.pushBlock(lod, mats, cols, count, grow);
  }
  end() { this.meshes.setOrder(this.d0, this.d1); this.meshes.end(); this.stats.lod0 = this.meshes.n0; this.stats.lod1 = this.meshes.n1; this.stats.n = this.meshes.n0 + this.meshes.n1; }
}
