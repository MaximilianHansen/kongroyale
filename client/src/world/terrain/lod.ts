// Chunked quadtree LOD for the 2.4 km heightfield. Every node is a 75×75-cell grid (76² verts + a skirt ring, 11.3k
// tris): level 0 = 2.4 km @ 32 m … level 4 = 150 m @ 2 m (the raw samples). Vertices sit exactly on heightfield samples,
// so LOD switches never resample; skirts hide T-junction cracks. Per-pixel normals come from the 2 m data texture, so
// coarse nodes shade like fine ones.
// DRAWN GROUND == Terrain.height(): every node whose box is within NEAR_FULL (80 m) of the camera is drawn at level 4 (the
// raw 2 m samples), triangulated with the SAME diagonal rule Terrain.height() interpolates on (diagonal alternates with the
// parity of the GLOBAL cell index — two index buffers, picked per node), so players, bullets, grass and props stand on
// exactly the triangles that are drawn. Beyond that, selection is screen-space: a node splits while its vertex spacing
// would cover more than TOL_PX pixels (fov + viewport aware). Only nodes within CAST_DIST of a ground camera cast into
// atmos's two dynamic cascades (0–150 m); the static far shadow map covers the rest of the island.
//
// Draws (perf): the nodes are not ~30 separate meshes (one draw call each,
// in every pass — ~60 % of the terrain's wall-clock share was CPU submission). ALL visible nodes draw as INSTANCES of one
// 76² grid: ONE draw for the near program + one for the far program (both diagonal parities: TERRAIN_INST_PARS). The vertex shader places
// each grid vertex (x0 + j·step, z0 + i·step) and reads its height with texelFetch from an exact float atlas of the
// height pyramid (raw 2 m samples = the same Float32 values Terrain.height() interpolates → bit-identical ground). The
// instances are sorted near → far (early-z), frustum-culled per node on the CPU, and the shadow depth program collapses
// every instance that must not cast.
import * as THREE from "three";
import { WORLD } from "../../../../shared/world/map";
import type { TerrainData } from "../../../../shared/world/terrain-gen";
import { flag } from "../../flags";
import { releaseGeometryAfterUpload } from "../../engine/geometry-release";

/** the anti-sparkle + anti-pop terrain path (mipmapped 2 m
 * data, faded detail normals, specular AA, geomorphed LOD). ?lodv=0 = off (A/B, baselines). */
export const TERRAIN_LODV = flag("lodv");
const G = 75;                 // cells per node side
const MAX_LEVEL = 4;
/** split while one grid step covers more than this many pixels (lower = more triangles) */
const TOL_PX = 50;   // (50 beyond the 80 m raw ring; rough ground still refines through the geometric-error test)
/** nodes whose box is closer than this (m) are always drawn at the raw 2 m level (drawn ground == Terrain.height()) */
const NEAR_FULL = 80;
/** ground cameras: only nodes whose footprint is within this distance cast into the dynamic cascades (in practice the
 * 0–26 m contact cascade); the static far shadow map (baked once, whole island) already carries the terrain's own
 * shadows everywhere else, and atmos blends it in from ~1.2× the first split */
const CAST_DIST = 36;   // (36: atmos's far map already carries the terrain's shadows from ~31 m, min()-combined)
/** a node also splits while its GEOMETRIC error (RMS deviation of its coarse surface from the raw 2 m samples,
 * × GEO_K) covers more than TOL_GEO_PX pixels — rough ground (the cone's rim + ribs, gorge walls) refines at glide range
 * instead of aliasing into sawteeth on the 8 m level, flat ground stays coarse */
// (perf: 6 px — at 3.2 px the cone's gullies kept ~30 nodes at the raw 2 m level out to 800 m (400 k tris drawn in
// every pass: main, AO, water depth); per-pixel normals come from the 2 m data texture anyway, only the silhouette
// coarsens, and a 6 px error on it is below what the target art's own cone edge shows)
const TOL_GEO_PX = 6, GEO_K = 2;
/** geomorph band: a node's children morph from its surface (split margin q = 1) to their own (q ≥ MORPH_BAND) */
const MORPH_BAND = 1.3;
const MAX_INST = 400;

interface Node {
  id: number;
  level: number; x0: number; z0: number; size: number;
  /** min / max height of the node's drawn surface (incl. skirt) */
  y0: number; y1: number;
  /** diagonal parity of the node's cells (global origin index at its own spacing) */
  flip: number;
  /** height-pyramid level the node samples */
  k: number;
  children: Node[] | null;
  /** RMS deviation (m) of this node's drawn surface from the raw samples it covers (0 at the finest level) */
  err: number;
}

/** `flip` = the node's global origin index (i0 + j0) is odd: the diagonal rule follows the GLOBAL cell parity, exactly
 * like Terrain.height() (even → (i,j)–(i+1,j+1), odd → (i,j+1)–(i+1,j)) */
function buildIndex(flip: number): THREE.BufferAttribute {
  const V = G + 1, tris: number[] = [];
  for (let i = 0; i < G; i++) for (let j = 0; j < G; j++) {
    const a = i * V + j, b = a + 1, c = a + V, d = c + 1;
    if ((i + j + flip) & 1) tris.push(a, c, b, b, c, d); else tris.push(a, c, d, a, d, b);
  }
  // skirts: 4 edges × V verts, appended after the grid (order: north(i=0), south(i=G), west(j=0), east(j=G))
  let base = V * V;
  const edge = (idx: (n: number) => number, flip: boolean) => {
    for (let n = 0; n < G; n++) {
      const a = idx(n), b = idx(n + 1), sa = base + n, sb = base + n + 1;
      if (flip) tris.push(a, sa, b, b, sa, sb); else tris.push(a, b, sa, b, sb, sa);
    }
    base += V;
  };
  edge((n) => n, true);                 // north edge (z = z0), winding faces outward
  edge((n) => G * V + n, false);        // south
  edge((n) => n * V, false);            // west
  edge((n) => n * V + G, true);         // east
  return new THREE.BufferAttribute(new Uint16Array(tris), 1);
}

/** the unit grid: position = (j, skirt 0/1, i) — the vertex shader turns it into world space per instance */
function gridPositions(): THREE.BufferAttribute {
  const V = G + 1, pos = new Float32Array((V * V + 4 * V) * 3);
  let o = 0;
  for (let i = 0; i < V; i++) for (let j = 0; j < V; j++) { pos[o++] = j; pos[o++] = 0; pos[o++] = i; }
  const put = (j: number, i: number) => { pos[o++] = j; pos[o++] = 1; pos[o++] = i; };
  for (let n = 0; n < V; n++) put(n, 0);
  for (let n = 0; n < V; n++) put(n, G);
  for (let n = 0; n < V; n++) put(0, n);
  for (let n = 0; n < V; n++) put(G, n);
  return new THREE.BufferAttribute(pos, 3);
}

/** GLSL (vertex): instance node → world position. aNode = (x0, z0, step, k + 8·cast + 16·flip). tTH = the height pyramid
 * atlas. A flip-1 node (odd global cell parity) uses the SAME index buffer with the grid rotated 90° — (j, i) → (i, 75 − j)
 * maps every cell onto a cell of the same parity and turns its diagonal the other way, winding preserved — so one draw
 * covers both parities. */
export const TERRAIN_INST_PARS = /* glsl */`
  attribute vec4 aNode;
  uniform highp sampler2D tTH; uniform float uTHRes[4]; uniform float uTHOff[4]; uniform vec2 uTHHC;
  float krTH(int k, vec2 xz) {
    float mc = uTHHC.y * exp2(float(k));
    int res = int(uTHRes[k] + 0.5);
    ivec2 ij = clamp(ivec2(floor((xz + uTHHC.x) / mc + 0.5)), ivec2(0), ivec2(res - 1));
    return texelFetch(tTH, ivec2(ij.x, int(uTHOff[k] + 0.5) + ij.y), 0).r;
  }
  vec3 krGridPos(vec3 gp) {
    float wl = mod(aNode.w, 32.0);
    int k = int(mod(wl, 8.0) + 0.5);
    vec2 g = wl >= 15.5 ? vec2(gp.z, ${G}.0 - gp.x) : gp.xz;
    vec2 xz = aNode.xy + g * aNode.z;
    float h = krTH(k, xz);
    // GEOMORPH: aNode.w / 32 = morph 0..255 → this node's surface blends toward its PARENT's (the
    // parent's vertex lattice at 2× the spacing, its height mip, its exact triangle — same diagonal rule as the parent's
    // draw), so a split / merge never snaps the relief: at morph 1 the children draw exactly the parent
    float mo = floor(aNode.w / 32.0 + 1e-3) / 255.0;
    if (mo > 0.0) {
      float sp = aNode.z * 2.0;
      int kp = clamp(int(floor(log2(sp / uTHHC.y) + 0.5)) - 1, 0, 3);
      vec2 q = (xz + uTHHC.x) / sp, c0 = floor(q + 1e-4), f = clamp(q - c0, 0.0, 1.0);
      vec2 o = c0 * sp - uTHHC.x;
      float h00 = krTH(kp, o), h10 = krTH(kp, o + vec2(sp, 0.0)), h01 = krTH(kp, o + vec2(0.0, sp)), h11 = krTH(kp, o + vec2(sp, sp));
      float hp;
      if (mod(c0.x + c0.y, 2.0) < 0.5) hp = f.x >= f.y ? h00 + f.x * (h10 - h00) + f.y * (h11 - h10) : h00 + f.y * (h01 - h00) + f.x * (h11 - h01);
      else hp = f.x + f.y <= 1.0 ? h00 + f.x * (h10 - h00) + f.y * (h01 - h00) : h11 + (1.0 - f.x) * (h01 - h11) + (1.0 - f.y) * (h10 - h11);
      h = mix(h, hp, mo);
    }
    return vec3(xz.x, h - gp.y * (aNode.z * 2.5 + 1.5), xz.y);
  }`;

export class TerrainLOD {
  readonly group = new THREE.Group();
  readonly nodes: Node[] = [];
  private root: Node;
  private tmp = new THREE.Vector3();
  private lastCam = new THREE.Vector3(1e9, 1e9, 1e9);
  private lastKey = "";
  /** nodes drawn last update, and their triangle count */
  drawn = 0;
  tris = 0;
  /** multiply the pixel tolerance (quality tiers / debugging) */
  tolScale = 1;

  /** box-filtered height pyramid: mips[k] has 2^k-sample spacing — coarse nodes use the matching mip so narrow
   * features (cone gullies, path banks) are averaged instead of point-sampled (no sawtooth aliasing at distance) */
  private mips: Array<{ res: number; h: Float32Array }> = [];
  /** the pyramid levels 0..3 packed into one R32F atlas (rows), for the vertex shader */
  readonly heightTex: THREE.DataTexture;
  readonly instUniforms: Record<string, THREE.IUniform>;

  /** (perf) the cheap far program (material.ts KR_FAR) for nodes wholly beyond `farStart` m */
  farMaterial: THREE.Material | null = null;
  farStart = 350;

  /** [program near/far][flip] instanced meshes */
  private meshes: THREE.Mesh[][] = [];
  private attrs: THREE.InstancedBufferAttribute[][] = [];
  private selected: Array<{ n: Node; d: number; cast: boolean; far: boolean; m: number }> = [];
  private frustum = new THREE.Frustum();
  private pv = new THREE.Matrix4();
  private box = new THREE.Box3();
  private sig = "";

  constructor(private t: TerrainData, readonly material: THREE.Material) {
    this.group.name = "terrain-lod";
    let cur = { res: t.res, h: t.heights };
    this.mips.push(cur);
    for (let k = 1; k <= 4; k++) {
      // odd-sized grids (2^n + 1): sample i of the next level sits on sample 2i; filter with a 3×3 tent (1-2-1)
      const r = (cur.res - 1) / 2 + 1, h = new Float32Array(r * r), src = cur.h, R = cur.res;
      for (let i = 0; i < r; i++) for (let j = 0; j < r; j++) {
        let acc = 0, wsum = 0;
        for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
          const ii = Math.min(R - 1, Math.max(0, 2 * i + di)), jj = Math.min(R - 1, Math.max(0, 2 * j + dj)), w = (2 - Math.abs(di)) * (2 - Math.abs(dj));
          acc += src[ii * R + jj] * w; wsum += w;
        }
        h[i * r + j] = acc / wsum;
      }
      cur = { res: r, h }; this.mips.push(cur);
    }
    // height atlas: pyramid levels 0..3 stacked as row blocks of one R32F texture (width = the raw resolution)
    const W = t.res, offs: number[] = [], ress: number[] = [];
    let rows = 0; for (let k = 0; k < 4; k++) { offs.push(rows); ress.push(this.mips[k].res); rows += this.mips[k].res; }
    const atlas = new Float32Array(W * rows);
    for (let k = 0; k < 4; k++) { const m = this.mips[k]; for (let i = 0; i < m.res; i++) atlas.set(m.h.subarray(i * m.res, (i + 1) * m.res), (offs[k] + i) * W); }
    this.heightTex = new THREE.DataTexture(atlas, W, rows, THREE.RedFormat, THREE.FloatType);
    this.heightTex.minFilter = this.heightTex.magFilter = THREE.NearestFilter; this.heightTex.generateMipmaps = false;
    this.heightTex.needsUpdate = true; this.heightTex.name = "terrain-height-atlas";
    this.instUniforms = {
      tTH: { value: this.heightTex }, uTHRes: { value: ress }, uTHOff: { value: offs },
      uTHHC: { value: new THREE.Vector2(WORLD.HALF, WORLD.CELL) },
    };
    this.root = this.makeNode(0, -WORLD.HALF, -WORLD.HALF, 2 * WORLD.HALF);
    this.group.frustumCulled = false;
  }

  /** build the 4 instanced meshes (call once the materials are known) */
  private ensureMeshes() {
    if (this.meshes.length) return;
    const pos = gridPositions(), idx = buildIndex(0);
    const depth = this.depthMaterial();
    for (let p = 0; p < 2; p++) {
      const row: THREE.Mesh[] = [], arow: THREE.InstancedBufferAttribute[] = [];
      for (let f = 0; f < 1; f++) {
        const g = new THREE.InstancedBufferGeometry();
        g.setAttribute("position", pos); g.setIndex(idx);
        const a = new THREE.InstancedBufferAttribute(new Float32Array(MAX_INST * 4), 4); a.setUsage(THREE.DynamicDrawUsage);
        g.setAttribute("aNode", a); g.instanceCount = 0;
        g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
        g.boundingBox = new THREE.Box3(new THREE.Vector3(-1e6, -1e3, -1e6), new THREE.Vector3(1e6, 1e3, 1e6));
        const m = new THREE.Mesh(g, p === 0 ? this.material : (this.farMaterial ?? this.material));
        m.name = `terrain-L${p === 0 ? "near" : "far"}`;
        m.frustumCulled = false; m.matrixAutoUpdate = false; m.visible = false;
        m.castShadow = false; m.receiveShadow = true;
        // camera-LOD'd: never in atmos's static far map (the whole-island shadow proxy is); casting set per update()
        m.userData.farShadow = false; m.userData.castShadow = false;
        if (p === 0) m.customDepthMaterial = depth;
        this.group.add(m); row.push(m); arow.push(a);
      }
      this.meshes.push(row); this.attrs.push(arow);
    }
  }

  /** shadow depth program: the instanced placement, and every instance not flagged to cast collapses */
  private depthMaterial() {
    const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.instUniforms);
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>\n${TERRAIN_INST_PARS}`)
        .replace("#include <begin_vertex>", "vec3 transformed = krGridPos(position);")
        .replace("#include <project_vertex>", "#include <project_vertex>\n if (mod(aNode.w, 16.0) < 7.5) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);");
    };
    m.customProgramCacheKey = () => "kr-terrain-inst-depth2";
    return m;
  }

  private makeNode(level: number, x0: number, z0: number, size: number): Node {
    const step = size / G, C = WORLD.CELL, H = WORLD.HALF;
    // the mip whose spacing is half this node's vertex spacing (keeps a little detail, kills aliasing)
    const k = Math.max(0, Math.min(3, Math.round(Math.log2(step / C)) - 1));
    const mp = this.mips[k], mres = mp.res, mc = C * 2 ** k;
    const hAt = (x: number, z: number) => {
      const j = Math.min(mres - 1, Math.max(0, Math.round((x + H) / mc))), i = Math.min(mres - 1, Math.max(0, Math.round((z + H) / mc)));
      return mp.h[i * mres + j];
    };
    const V = G + 1, hs = new Float32Array(V * V);
    let y0 = 1e9, y1 = -1e9;
    for (let i = 0; i < V; i++) for (let j = 0; j < V; j++) { const h = hAt(x0 + j * step, z0 + i * step); hs[i * V + j] = h; y0 = Math.min(y0, h); y1 = Math.max(y1, h); }
    y0 -= step * 2.5 + 1.5;
    const gi = Math.round((z0 + H) / step), gj = Math.round((x0 + H) / step);
    const node: Node = { id: this.nodes.length, level, x0, z0, size, y0, y1, flip: (gi + gj) & 1, k, children: null, err: level < MAX_LEVEL ? this.nodeError(x0, z0, size, hs) : 0 };
    this.nodes.push(node);
    if (level < MAX_LEVEL) {
      const h = size / 2;
      node.children = [this.makeNode(level + 1, x0, z0, h), this.makeNode(level + 1, x0 + h, z0, h), this.makeNode(level + 1, x0, z0 + h, h), this.makeNode(level + 1, x0 + h, z0 + h, h)];
    }
    return node;
  }

  /** RMS height deviation (m) between a node's vertex grid (bilinear) and the raw 2 m samples under it; sea floor
   * deeper than 3 m is ignored (the water hides it) */
  private nodeError(x0: number, z0: number, size: number, hv: Float32Array): number {
    const V = G + 1, step = size / G, C = WORLD.CELL, H = WORLD.HALF, R = this.t.res, hs = this.t.heights;
    const cells = Math.round(size / C), stride = size > 700 ? 3 : size > 350 ? 2 : 1;
    const i0 = Math.round((z0 + H) / C), j0 = Math.round((x0 + H) / C);
    let s2 = 0, n = 0;
    for (let a = 0; a <= cells; a += stride) for (let b = 0; b <= cells; b += stride) {
      const i = i0 + a, j = j0 + b; if (i >= R || j >= R) continue;
      const fz = a * C / step, fx = b * C / step, vi = Math.min(G - 1, Math.floor(fz)), vj = Math.min(G - 1, Math.floor(fx)), tz = fz - vi, tx = fx - vj;
      const h00 = hv[vi * V + vj], h01 = hv[vi * V + vj + 1], h10 = hv[(vi + 1) * V + vj], h11 = hv[(vi + 1) * V + vj + 1];
      const hh = (h00 * (1 - tx) + h01 * tx) * (1 - tz) + (h10 * (1 - tx) + h11 * tx) * tz, hf = hs[i * R + j];
      if (hf < -3 && hh < -3) continue;
      s2 += (hh - hf) ** 2; n++;
    }
    return n ? Math.sqrt(s2 / n) : 0;
  }

  /** Whole-island shadow caster for atmos's STATIC far shadow map: one 4 m-spaced mesh (the box-filtered mip), hidden
   * (never drawn, never in the dynamic cascades), `userData.farShadow = "force"` so the bake shows it — the far map no
   * longer depends on which LOD nodes the camera happened to select when it was baked. */
  shadowProxy(): THREE.Mesh {
    const mp = this.mips[1], R = mp.res, C = WORLD.CELL * 2, H = WORLD.HALF;
    const arrays = () => {
      const position = new Float32Array(R * R * 3);
      for (let i = 0, o = 0; i < R; i++) for (let j = 0; j < R; j++) { position[o++] = -H + j * C; position[o++] = Math.max(mp.h[i * R + j], -6); position[o++] = -H + i * C; }
      const index = new Uint32Array((R - 1) * (R - 1) * 6);
      for (let i = 0, o = 0; i < R - 1; i++) for (let j = 0; j < R - 1; j++) {
        const a = i * R + j, b = a + 1, c = a + R, d = c + 1;
        index[o++] = a; index[o++] = c; index[o++] = d; index[o++] = a; index[o++] = d; index[o++] = b;
      }
      return { position, index };
    };
    const { position, index } = arrays();
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(position, 3)); g.setIndex(new THREE.BufferAttribute(index, 1));
    g.computeBoundingBox(); g.computeBoundingSphere();
    releaseGeometryAfterUpload(g, arrays);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ colorWrite: false }));
    m.name = "terrain-shadow-proxy"; m.visible = false; m.castShadow = true; m.receiveShadow = false; m.frustumCulled = false;
    m.userData.farShadow = "force"; m.userData.castShadow = true; m.userData.receiveShadow = false;
    m.matrixAutoUpdate = false;
    return m;
  }

  /** write the selected nodes into the 4 instance buffers (sorted near → far) */
  private upload(sel: Array<{ n: Node; d: number; cast: boolean; far: boolean; m?: number }>, anyCast: boolean) {
    this.ensureMeshes();
    sel.sort((a, b) => a.d - b.d);
    const cnt = [[0], [0]];
    for (const s of sel) {
      const p = s.far && this.farMaterial ? 1 : 0, f = 0, c = cnt[p][f]++;
      if (c >= MAX_INST) { cnt[p][f]--; continue; }
      const arr = this.attrs[p][f].array as Float32Array;
      arr[c * 4] = s.n.x0; arr[c * 4 + 1] = s.n.z0; arr[c * 4 + 2] = s.n.size / G; arr[c * 4 + 3] = s.n.k + (s.cast ? 8 : 0) + (s.n.flip ? 16 : 0) + 32 * Math.round((s.m ?? 0) * 255);
    }
    for (let p = 0; p < 2; p++) for (let f = 0; f < 1; f++) {
      const m = this.meshes[p][f], a = this.attrs[p][f], n = cnt[p][f];
      (m.geometry as THREE.InstancedBufferGeometry).instanceCount = n;
      a.clearUpdateRanges(); a.addUpdateRange(0, n * 4); a.needsUpdate = true;
      m.visible = n > 0;
      if (p === 1) m.material = this.farMaterial ?? this.material;
      // (drawn before every other opaque — early-z rejects the hidden far ground and whatever stands behind a hill)
      m.renderOrder = -999 + p;
      m.castShadow = p === 0 && anyCast && n > 0; m.userData.castShadow = m.castShadow;
    }
  }

  /** draw every node of one level with `mat` (the far-albedo bake), ignoring the camera */
  showLevel(level: number, mat: THREE.Material) {
    this.ensureMeshes();
    const prevFar = this.farMaterial; this.farMaterial = null;
    const saveMat = this.meshes[0].map((m) => m.material);
    for (const m of this.meshes[0]) m.material = mat;
    this.upload(this.nodes.filter((n) => n.level === level).map((n) => ({ n, d: 0, cast: false, far: false, m: 0 })), false);
    this.farMaterial = prevFar;
    return () => { this.meshes[0].forEach((m, i) => { m.material = saveMat[i]; }); this.lastKey = ""; };
  }

  /** choose the node set for this camera (call every frame). The tree walk re-runs every frame (it is ~100 box tests);
   * the instance buffers are only rewritten when the selected set changes. `viewH` = drawing-buffer height in pixels. */
  update(camera: THREE.Camera, viewH = 1440, force = false) {
    const cam = this.tmp.setFromMatrixPosition(camera.matrixWorld);
    const fov = (camera as THREE.PerspectiveCamera).fov ?? 60;
    const key = `${fov}|${viewH}|${this.tolScale}`;
    const moved = force || key !== this.lastKey || cam.distanceToSquared(this.lastCam) >= 1;
    if (moved) { this.lastKey = key; this.lastCam.copy(cam); }
    const proj = viewH / (2 * Math.tan(THREE.MathUtils.degToRad(fov) / 2));
    const aerial = cam.y > 300;
    // from the air the cone / ridges are silhouettes against the sea: finer (the aerial budget is larger)
    // (TERRAIN_LODV eases 1 → 0.42 between 250 and 350 m — a hard step would re-split half the island in one frame)
    const ak = TERRAIN_LODV ? Math.min(1, Math.max(0, (cam.y - 250) / 100)) : (aerial ? 1 : 0);
    const tol = TOL_PX * this.tolScale * (1 - 0.58 * ak * ak * (3 - 2 * ak));
    camera.updateMatrixWorld();
    this.pv.multiplyMatrices((camera as THREE.PerspectiveCamera).projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pv);
    const sel = this.selected; sel.length = 0;
    let sig = "", tris = 0, anyCast = false;
    const visit = (n: Node, qp: number) => {
      // distance from the camera to the node's box (xz footprint + height band)
      const dx = Math.max(n.x0 - cam.x, 0, cam.x - (n.x0 + n.size)), dz = Math.max(n.z0 - cam.z, 0, cam.z - (n.z0 + n.size));
      const dy = Math.max(n.y0 - cam.y, 0, cam.y - n.y1);
      const d = Math.sqrt(dx * dx + dz * dz + dy * dy);
      // (perf) sea floor ≥ 9 m deep over the whole node: the water above it is opaque blue there — not drawn while
      // the camera is above the sea (every pass saved: main, depth, AO)
      if (cam.y > 1 && n.y1 < -9) return;
      const errPx = (n.size / G) / Math.max(d, 1) * proj, geoPx = n.err * GEO_K / Math.max(d, 1) * proj;
      if (TERRAIN_LODV) {
        // split margin q (> 1 = split). The near rule splits from NEAR_FULL × MORPH_BAND so the raw ring (< 80 m) is never
        // morphed (drawn ground == Terrain.height() there); children morph toward this node's surface while q < MORPH_BAND
        const q = Math.max(errPx / tol, geoPx / (TOL_GEO_PX * this.tolScale), (NEAR_FULL * MORPH_BAND) / Math.max(d, 1e-3));
        if (n.children && q > 1) { for (const c of n.children) visit(c, q); return; }
      } else if (n.children && (errPx > tol || geoPx > TOL_GEO_PX * this.tolScale || d < NEAR_FULL)) { for (const c of n.children) visit(c, 9); return; }
      this.box.min.set(n.x0, n.y0, n.z0); this.box.max.set(n.x0 + n.size, n.y1, n.z0 + n.size);
      const cast = !aerial && Math.hypot(dx, dz) < CAST_DIST;
      // outside the view: skipped unless it casts into the contact cascade (a hill behind you still shadows your feet)
      if (!cast && !this.frustum.intersectsBox(this.box)) return;
      const far = d > this.farStart;
      // morph toward the parent while the parent's split margin is inside the band (continuous in the camera position)
      const mk = TERRAIN_LODV && n.level > 0 ? 1 - Math.min(1, Math.max(0, (qp - 1) / (MORPH_BAND - 1))) : 0;
      const m = mk * mk * (3 - 2 * mk);
      sel.push({ n, d, cast, far, m }); anyCast ||= cast;
      sig += `${n.id}${far ? "f" : ""}${cast ? "c" : ""}${m > 0 ? "m" + Math.round(m * 255) : ""},`; tris += G * G * 2;
    };
    visit(this.root, 9);
    this.drawn = sel.length; this.tris = tris;
    // same node set and the camera has not moved: nothing to rewrite (a moved camera re-sorts near → far for early-z)
    if (!force && sig === this.sig && !moved) return;
    this.sig = sig;
    this.upload(sel.slice(), anyCast);
  }
}
