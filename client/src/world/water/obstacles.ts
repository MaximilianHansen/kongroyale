// Automatic intersection foam: an orthographic bake of everything that crosses the waterline (y in [-0.35, 1.1] m) —
// pilings, hulls, rocks, half-sunk containers, quay walls, mangrove roots — into a coverage mask, then max-filtered into
// a PROXIMITY texture (1 at the object → 0 at ~4.7 m, a Euclidean distance transform — rings follow the silhouette) the
// water shader turns into waterline foam (dObj = (1 − p)·4.7 m). A straight top-down view sees vertical walls (hull sides,
// quay walls, container sides) edge-on — zero area, no foam — so the slab is rendered twice through SHEARED
// projections (x/z shifted by the height, along two diagonals): every wall inside the slab gets ~1.5 m of footprint. Other areas get foam around their
// props without calling anything; `registerFoam*` (fields.ts) stays for dynamic / extra foam.
// Excluded: the terrain surface (every beach would be foam), water, sky/clouds, and alpha-tested / transparent
// materials (leaf cards would bake as solid blobs). Re-baked when the mesh count changes (async POI loads).
import * as THREE from "three";
import { contextEpoch, onRestore } from "../../engine/res/restore";

/** proximity reach of the rings, in texels of the bake (4096² over the 2.4 km island → 0.586 m: 7 → 4.1 m) */
const R = 7;
/** the wide proximity's reach in 2.34 m cells (6 → ≈ 16 m) */
const RW = 6;
const _c = new THREE.Vector3();
const _boundA = new THREE.Vector3(), _boundB = new THREE.Vector3();
/** A BatchedMesh's backing geometry is allocated for its MAX vertex count: computing its bounding sphere just for the
 *  tiny-prop rejection scanned the whole padded array (a 65 ms freeze during the drop / landing). Any two used vertices
 *  farther apart than twice the threshold prove that every enclosing sphere exceeds it, so a fixed number is sampled —
 *  from the ACTIVE geometry ranges only (reserved / unused space is zero-filled: vertices at the origin that would make a
 *  tiny batch far from it look large). Inconclusive → false: the caller falls back to the original exact bounds (no
 *  sphere is made up here — renderer culling and later geometry changes keep their existing bounds contract). */
function exceedsTinyRadius(bm: THREE.BatchedMesh, scale: number): boolean {
  const p = bm.geometry?.attributes.position;
  const info = (bm as unknown as { _geometryInfo?: Array<{ active: boolean; vertexStart: number; vertexCount: number } | undefined> })._geometryInfo;
  if (!p || !Array.isArray(info) || !Number.isFinite(scale) || scale <= 0 ||
    (p as THREE.BufferAttribute & { isGLBufferAttribute?: boolean }).isGLBufferAttribute) return false;
  const diameter = 0.44 / scale;
  // Strict margin keeps floating-point rounding at the threshold on the exact path.
  const limit = (diameter + Math.max(1, diameter) * 1e-10) ** 2;
  let have = false, ranges = 0;
  for (const g of info) {
    if (!g || !g.active || !(g.vertexCount > 0) || g.vertexStart < 0 || g.vertexStart + g.vertexCount > p.count) continue;
    const last = g.vertexCount - 1;
    for (const k of [0, 1, 2, 3, 7, 15, Math.floor(last * 0.25), Math.floor(last * 0.5), Math.floor(last * 0.75), last]) {
      const i = g.vertexStart + Math.min(k, last);
      if (!have) { _boundA.fromBufferAttribute(p, i); have = true; continue; }
      _boundB.fromBufferAttribute(p, i);
      if (_boundA.distanceToSquared(_boundB) > limit) return true;
    }
    if (++ranges >= 32) break;   // (bounded: a big batch proves itself in its first ranges)
  }
  return false;
}
const EXCLUDE = /^terrain-L|^terrain-abyss|^terrain-far|^water|^atmos-|^cloud|sky|^sun|proxy|farshadow|impostor|hlod|-lod-\d|:l[1-9]\b|flotsam/i;
/** the two waterline slabs (m): ABOVE the surface (what the eye sees piercing it — its footprint) and BELOW it (proof
 *  that the object really stands in the water, not a deck / roof above it); a texel counts only when both see geometry
 *  within ~0.6 m (otherwise rocks whose tops stay a hand under the surface bake as filled white "fried eggs") */
const ABOVE: [number, number] = [0.06, 1.1], BELOW: [number, number] = [-1.2, -0.06];

export class ObstacleBake {
  readonly texture: THREE.Texture;
  /** uv = (x * scale + 0.5, 0.5 - z * scale) */
  readonly scale: number;
  private rtA: THREE.WebGLRenderTarget;
  private rtP: THREE.WebGLRenderTarget;
  private pierceMat: THREE.ShaderMaterial;
  private rtB: THREE.WebGLRenderTarget;
  private rtC: THREE.WebGLRenderTarget;
  /** the WIDE proximity (G of the result): 1024², 2.34 m texels, reach ≈ 16 m — the foam churn seen from the air around
   *  hulls, quay walls, sea stacks and big rocks (the target art's aerial harbor has 5-20 m of white water there; the
   *  4.7 m ring is ~2 px from 2 km) */
  private rtW1: THREE.WebGLRenderTarget;
  private rtW2: THREE.WebGLRenderTarget;
  private wideDown: THREE.ShaderMaterial;
  private wideEdt: THREE.ShaderMaterial;
  private cam: THREE.OrthographicCamera;
  private override: THREE.ShaderMaterial;
  private blurMat: THREE.ShaderMaterial;
  private quad: THREE.Mesh;
  private quadScene = new THREE.Scene();
  private quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private mask: THREE.Texture | null = null;
  bakes = 0;

  constructor(private renderer: THREE.WebGLRenderer, private scene: THREE.Scene, half: number, size = 4096, blurSize = 2048) {
    this.scale = 1 / (2 * half);
    const opts: THREE.RenderTargetOptions = { format: THREE.RedFormat, type: THREE.UnsignedByteType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, stencilBuffer: false, generateMipmaps: false };
    this.rtA = new THREE.WebGLRenderTarget(size, size, { ...opts, format: THREE.RGFormat });
    this.rtP = new THREE.WebGLRenderTarget(size, size, opts);
    this.rtP.texture.name = "water-obstacle-pierce";
    this.rtB = new THREE.WebGLRenderTarget(blurSize, blurSize, opts);
    this.rtC = new THREE.WebGLRenderTarget(blurSize, blurSize, { ...opts, format: THREE.RGFormat });
    const WS = Math.max(256, size >> 2);
    this.rtW1 = new THREE.WebGLRenderTarget(WS, WS, opts);
    this.rtW2 = new THREE.WebGLRenderTarget(WS, WS, opts);
    this.rtA.texture.name = "water-obstacle-raw"; this.rtC.texture.name = "water-obstacle";
    this.texture = this.rtC.texture;
    // looking straight down; screen-right = +x, screen-up = -z (north). near/far clip the world to the waterline slab.
    // slab y ∈ [-0.15, 1.1]: only what pierces the surface (a rock whose top stays a hand under the water gets no ring:
    // its whole top baked as "contact" and printed a white square on the sea from the air)
    this.cam = new THREE.OrthographicCamera(-half, half, half, -half, 40 - 1.1, 40 + 0.15);
    this.cam.position.set(0, 40, 0); this.cam.up.set(0, 0, -1); this.cam.lookAt(0, 0, 0); this.cam.updateMatrixWorld(true);
    // max-blended, no depth test: every fragment inside the slab counts (occlusion does not matter for a coverage mask)
    // (a MINIMAL coverage shader — position through three's instancing / batching chunks, a flat colour out. The
    // full MeshBasicMaterial program took 25-45 ms to compile per object-kind variant on ANGLE: one > 50 ms task)
    this.override = new THREE.ShaderMaterial({
      name: "water-obstacle-cov",
      uniforms: { uCol: { value: new THREE.Color(1, 1, 1) } },
      vertexShader: /* glsl */ `
        #include <common>
        #include <batching_pars_vertex>
        void main() {
          #include <batching_vertex>
          #include <begin_vertex>
          #include <project_vertex>
        }`,
      fragmentShader: /* glsl */ `uniform vec3 uCol; void main() { gl_FragColor = vec4(uCol, 1.0); }`,
      side: THREE.DoubleSide, fog: false, toneMapped: false, depthTest: false, depthWrite: false, lights: false,
      blending: THREE.CustomBlending, blendEquation: THREE.MaxEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    });
    this.override.customProgramCacheKey = () => "kr-water-obstacle-cov2";
    this.blurMat = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: null }, uDir: { value: new THREE.Vector2(1, 0) }, uMask: { value: null }, uWide: { value: this.rtW2.texture }, uUseMask: { value: 0 }, uPass: { value: 0 } },
      vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uTex; uniform sampler2D uMask; uniform sampler2D uWide; uniform float uUseMask; uniform float uPass; uniform vec2 uDir; varying vec2 vUv;
        // PROXIMITY = a separable EUCLIDEAN distance transform within ${R + 1} texels (≈ 4.7 m): pass X stores the distance to
        // the nearest covered texel along the row, pass Y combines the rows (min over j of dx² + j²). The ring then
        // follows the object's silhouette with round ends (a separable max filter draws rounded SQUARES around
        // rocks and sea stacks). Partial coverage (anti-aliased edges) shifts the distance by up to half a texel.
        const float RR = ${(R + 1).toFixed(1)};
        void main(){
          float best = RR;
          if (uPass < 0.5) {
            for (int i = -${R}; i <= ${R}; i++) {
              float c = texture2D(uTex, vUv + uDir * float(i)).r;
              // (only solidly covered texels count: faint partial coverage inflated every small rock's ring by a texel)
              if (c > 0.22) best = min(best, max(abs(float(i)) + 0.5 - c, 0.0));
            }
            gl_FragColor = vec4(vec3(best / RR), 1.0);
            return;
          }
          float b2 = RR * RR;
          for (int j = -${R}; j <= ${R}; j++) {
            float dx = texture2D(uTex, vUv + uDir * float(j)).r * RR;
            b2 = min(b2, dx * dx + float(j * j));
          }
          float s = 1.0 - min(sqrt(b2), RR) / RR;
          // the registered foam shapes (WaterApi.registerFoam*) live in the same texture: max() on the final pass.
          // mask uv = (x, z) mapped like the obstacle view (screen-up = north = -z)
          // registered shapes only count NEAR real waterline geometry (the bake): a shape registered in the wrong frame
          // (open sea, nothing there) stays invisible instead of drawing a phantom white box / line
          // (a registered shape only nudges the proximity — ≤ 0.45, the outer lapping wisps. At full strength the
          // overlapping circles other areas register around container ends / along hulls / at piles filled whole discs
          // with foam: "fried eggs" and flat white pads. The bake of the real waterline geometry draws the
          // contact line and the wash)
          if (uUseMask > 0.5) s = max(s, texture2D(uMask, vec2(vUv.x, 1.0 - vUv.y)).r * 0.45 * smoothstep(0.004, 0.05, s));
          gl_FragColor = vec4(s, texture2D(uWide, vUv).r, 0.0, 1.0);
        }`,
      depthTest: false, depthWrite: false,
    });
    // PIERCE pass (full bake resolution): coverage = above-slab footprint × (below-slab geometry within ±1 texel — the
    // shear puts a wall's above / below parts on opposite sides of it)
    this.pierceMat = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: null }, uTexel: { value: 1 / size } },
      vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uTex; uniform float uTexel; varying vec2 vUv;
        void main(){
          float a = texture2D(uTex, vUv).r, b = 0.0;
          for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) b = max(b, texture2D(uTex, vUv + vec2(float(i), float(j)) * uTexel).g);
          gl_FragColor = vec4(vec3(a * smoothstep(0.1, 0.4, b)), 1.0);
        }`,
      depthTest: false, depthWrite: false,
    });
    // WIDE proximity: (1) the pierce coverage averaged over 4×4 texels (2.34 m cells) — only objects ≳ 1.5 m across
    // count, so small rocks and posts never print 16 m foam discs from the air — (2) a separable EDT of ±RW cells
    this.wideDown = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: null }, uTexel: { value: 1 / size }, uMode: { value: 0 } },
      vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uTex; uniform float uTexel; varying vec2 vUv;
        uniform float uMode;
        void main(){
          if (uMode > 0.5) {
            // SIZE filter (2.34 m cells): a covered cell counts only with ≥ 3 covered cells around it — hull sides, quay
            // walls, sea stacks and big rocks span several; a post, a pile or a small rock (one cell) never gets churn
            float c = texture2D(uTex, vUv).r, n = 0.0;
            for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) n += step(0.5, texture2D(uTex, vUv + vec2(float(i), float(j)) * uTexel).r);
            gl_FragColor = vec4(vec3(c * step(3.5, n)), 1.0);
            return;
          }
          // the pierce coverage at 2.34 m: max over the 4×4 fine texels (thin sheared walls are ~0.4 m wide)
          float a = 0.0;
          for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) a = max(a, texture2D(uTex, vUv + (vec2(float(i), float(j)) - 1.5) * uTexel).r);
          gl_FragColor = vec4(vec3(step(0.3, a)), 1.0);
        }`,
      depthTest: false, depthWrite: false,
    });
    this.wideEdt = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: null }, uDir: { value: new THREE.Vector2(1, 0) }, uPass: { value: 0 } },
      vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uTex; uniform vec2 uDir; uniform float uPass; varying vec2 vUv;
        const float RR = ${(RW + 1).toFixed(1)};
        void main(){
          if (uPass < 0.5) {
            float best = RR;
            for (int i = -${RW}; i <= ${RW}; i++) { float c = texture2D(uTex, vUv + uDir * float(i)).r; if (c > 0.3) best = min(best, max(abs(float(i)) + 0.5 - c, 0.0)); }
            gl_FragColor = vec4(vec3(best / RR), 1.0);
            return;
          }
          float b2 = RR * RR;
          for (int j = -${RW}; j <= ${RW}; j++) { float dx = texture2D(uTex, vUv + uDir * float(j)).r * RR; b2 = min(b2, dx * dx + float(j * j)); }
          gl_FragColor = vec4(vec3(1.0 - min(sqrt(b2), RR) / RR), 1.0);
        }`,
      depthTest: false, depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.blurMat);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
    onRestore("bake", () => {
      this.baked = new WeakMap(); this.batchedIds = new WeakMap(); this.cleared = false;
      if (this.bakes > 0) this.bake(true);
    });
  }

  /** the WIDE proximity read back to the CPU (RGBA8 rows, 1024² → 4 MB; R = proximity, ≈ 1 at a big object → 0 at ~16 m),
   *  once per bake — spray.ts picks its spawn points on the windward faces of sea stacks and big rocks from it */
  wideCells(): { cells: Uint8Array; size: number } | null {
    if (this.bakes === 0) return null;
    const r = this.renderer, gl = r.getContext() as WebGL2RenderingContext;
    const size = this.rtW2.width, cells = new Uint8Array(size * size * 4);
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.rtW2);
    gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, cells);
    r.setRenderTarget(prev);
    return { cells, size };
  }

  /** wideCells without the GPU stall (no main-thread task > 50 ms): the read goes into a pixel-pack buffer behind a
   *  fence and is collected a few frames later, once the GPU has finished the bake */
  async wideCellsAsync(): Promise<{ cells: Uint8Array; size: number } | null> {
    if (this.bakes === 0) return null;
    const r = this.renderer, gl = r.getContext() as WebGL2RenderingContext;
    if (typeof gl.fenceSync !== "function") return this.wideCells();
    const size = this.rtW2.width, n = size * size * 4;
    const buf = gl.createBuffer(), epoch = contextEpoch();
    if (!buf) return this.wideCells();
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.rtW2);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, n, gl.STREAM_READ);
    gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    r.setRenderTarget(prev);
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    const t0 = performance.now();
    while (sync && epoch === contextEpoch() && gl.clientWaitSync(sync, 0, 0) === gl.TIMEOUT_EXPIRED && performance.now() - t0 < 5000) await new Promise((res) => setTimeout(res, 8));
    if (gl.isContextLost() || epoch !== contextEpoch()) return null;
    if (sync) gl.deleteSync(sync);
    const cells = new Uint8Array(n);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, cells);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.deleteBuffer(buf);
    return { cells, size };
  }

  /** the registered-foam mask to composite into the result (see FoamMask) */
  setMask(t: THREE.Texture) { this.mask = t; }

  /** re-run only the final (mask-compositing) pass — after registered foam shapes changed */
  recomposite() {
    if (this.bakes === 0) return;
    const r = this.renderer, prevRT = r.getRenderTarget();
    this.finalPass();
    r.setRenderTarget(prevRT);
  }

  private finalPass() {
    const r = this.renderer;
    this.blurMat.uniforms.uTex.value = this.rtB.texture; this.blurMat.uniforms.uDir.value.set(0, 1 / this.rtB.width);
    this.blurMat.uniforms.uMask.value = this.mask; this.blurMat.uniforms.uUseMask.value = this.mask ? 1 : 0;
    this.blurMat.uniforms.uPass.value = 1;
    r.setRenderTarget(this.rtC); r.render(this.quadScene, this.quadCam);
    this.blurMat.uniforms.uUseMask.value = 0;
  }

  /** what has been baked: object → instance count at its bake (the bake ACCUMULATES: other areas distance-cull and
   *  LOD-switch their props every frame, so whatever was visible at one bake may be hidden at the next — every static
   *  prop that is ever drawn gets baked once and keeps its ring) */
  private baked = new WeakMap<THREE.Object3D, number>();
  private cleared = false;
  private skip = new WeakSet<THREE.Object3D>();
  /** re-bakes each already-baked object has triggered (dynamic objects stop triggering after 2) */
  private trig = new WeakMap<THREE.Object3D, number>();

  /** a mesh the bake should render: not terrain/water/sky, opaque, not skinned (kongs move), in the waterline slab */
  private relevant(o: THREE.Object3D): boolean {
    const m = o as THREE.Mesh;
    const inst = (o as THREE.InstancedMesh).isInstancedMesh || (o as THREE.BatchedMesh).isBatchedMesh;
    if (!(m.isMesh || inst) || (o as THREE.SkinnedMesh).isSkinnedMesh) return false;
    if (EXCLUDE.test(o.name) || o.userData.noFoam === true) return false;
    const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.Material | undefined;
    if (!mat || mat.transparent || (mat as THREE.MeshStandardMaterial).alphaTest > 0 || (mat as THREE.MeshStandardMaterial).alphaHash) return false;
    // tiny props (bananas, pebbles, shells) get no ring — a pile of them would bake into a foam blob
    { const g = m.geometry; if (g) {
      const scale = o.matrixWorld.getMaxScaleOnAxis();
      // BatchedMesh computes renderer bounds from its active geometry ranges, not this padded backing array.
      // InstancedMesh still needs the geometry sphere for its own renderer bounds: skipping it would move the hitch.
      if (!g.boundingSphere && !((o as THREE.BatchedMesh).isBatchedMesh && exceedsTinyRadius(o as THREE.BatchedMesh, scale))) g.computeBoundingSphere();
      const bs = g.boundingSphere; if (bs && bs.radius * scale < 0.22) return false;
    } }
    if (!inst) { // world-space bounding sphere must reach the slab
      const g = m.geometry;
      if (g) {
        if (!g.boundingSphere) g.computeBoundingSphere();
        const bs = g.boundingSphere;
        if (bs && Number.isFinite(bs.radius)) {
          _c.copy(bs.center).applyMatrix4(o.matrixWorld);
          const r = bs.radius * o.matrixWorld.getMaxScaleOnAxis();
          if (_c.y - r > 1.1 || _c.y + r < -0.15) return false;
        }
      }
    }
    return true;
  }
  private countOf(o: THREE.Object3D) { return (o as THREE.InstancedMesh).isInstancedMesh ? (o as THREE.InstancedMesh).count : 1; }
  /** BatchedMesh (TownLod & co. switch LOD tiers per INSTANCE by camera distance): which instance ids have been baked.
   *  A batch counts as fresh while any currently visible instance was never baked (the near tier of a building the
   *  camera walks up to after the first bake) */
  private batchedIds = new WeakMap<THREE.Object3D, Uint8Array>();
  private batchedFresh(o: THREE.Object3D, mark: boolean): boolean {
    const bm = o as THREE.BatchedMesh & { instanceCount?: number; maxInstanceCount?: number; _instanceInfo?: Array<{ visible: boolean; active: boolean }> };
    const info = bm._instanceInfo;
    if (!Array.isArray(info)) return false;
    let ids = this.batchedIds.get(o);
    if (!ids || ids.length < info.length) { const n = new Uint8Array(info.length); if (ids) n.set(ids); ids = n; this.batchedIds.set(o, ids); }
    let fresh = false;
    for (let i = 0; i < info.length; i++) {
      const e = info[i];
      if (!e || !e.active || !e.visible || ids[i]) continue;
      if (mark) ids[i] = 1; else return true;
      fresh = true;
    }
    return fresh;
  }

  /** bake if any relevant visible prop was never baked (late async loads, LOD switches, distance-culled groups coming
   *  into view) — or always when force (then from scratch). Cheap check: one traverse of the visible scene */
  maybeBake(force = false) {
    if (!force) {
      let fresh = false, culprit: THREE.Object3D | null = null;
      this.scene.traverseVisible((o) => {
        if (fresh || this.skip.has(o)) return;
        if ((o as THREE.BatchedMesh).isBatchedMesh && this.baked.has(o)) { if (this.batchedFresh(o, false)) fresh = true; return; }
        if ((this.baked.get(o) ?? -1) >= this.countOf(o)) return;
        if (this.relevant(o)) { fresh = true; culprit = o; } else this.skip.add(o);   // (static props: irrelevant once, irrelevant always)
      });
      if (!fresh) return false;
      // (a live match re-baked ~1×/s — 7 ms bakes, 20-50 ms frames contended. An object
      //  that was baked before and whose drawn count grew AGAIN is dynamic (instanced FX, loot, debris): after its 2nd
      //  re-trigger it never triggers a bake again. Every static prop is still baked once when it first shows up)
      const c = culprit as THREE.Object3D | null;
      if (c && this.baked.has(c)) {
        const n = (this.trig.get(c) ?? 0) + 1;
        this.trig.set(c, n);
        if (n > 2) { this.skip.add(c); return false; }
      }
    }
    this.bake(force);
    return true;
  }

  /** the first bake compiles the override program once per object kind (mesh / instanced / batched): ~30 ms each
   *  on ANGLE — together one 100+ ms task. Warm them one kind per frame (a throw-away bake of only that kind) first */
  async warm(nextFrame: () => Promise<void>) {
    // (the first render of each object with the override program sets up its binding state — hundreds of meshes in
    // one frame were a 50-130 ms task: warm them in chunks of ~60 objects, one chunk per frame)
    const list: THREE.Object3D[] = [];
    this.scene.traverseVisible((o) => { if (((o as THREE.Mesh).isMesh || (o as THREE.BatchedMesh).isBatchedMesh) && this.relevant(o)) list.push(o); });
    const kinds: Array<(o: THREE.Object3D) => boolean> = [];
    for (let i = 0; i < list.length; i += 60) { const set = new Set(list.slice(i, i + 60)); kinds.push((o) => set.has(o)); }
    const ms: number[] = [];
    for (const k of kinds) { const t = performance.now(); this.bake(true, k, true); ms.push(Math.round(performance.now() - t)); await nextFrame(); }
    (window as unknown as { __krWaterWarm?: number[] }).__krWaterWarm = ms;
  }

  bake(fromScratch = true, only?: (o: THREE.Object3D) => boolean, warmOnly = false) {
    const r = this.renderer, scene = this.scene;
    const hidden: THREE.Object3D[] = [], drawn: THREE.Object3D[] = [];
    scene.updateMatrixWorld();
    scene.traverse((o) => {
      if (!o.visible) return;
      const m = o as THREE.Mesh;
      const isMesh = m.isMesh || (o as THREE.InstancedMesh).isInstancedMesh || (o as THREE.BatchedMesh).isBatchedMesh;
      if (!isMesh) return;
      if (this.relevant(o) && (!only || only(o))) drawn.push(o); else { o.visible = false; hidden.push(o); }
    });
    // (warm-up: the programs only — one slab, one shear; nothing is marked baked)
    if (warmOnly) {
      const prevRT = r.getRenderTarget(), prevOverride = scene.overrideMaterial, prevBg = scene.background, prevEnv = scene.environment;
      const prevShadow = r.shadowMap.enabled, prevAuto = r.shadowMap.autoUpdate;
      scene.overrideMaterial = this.override; scene.background = null; scene.environment = null;
      r.shadowMap.enabled = false; r.shadowMap.autoUpdate = false;
      r.setRenderTarget(this.rtA);
      if (drawn.length) r.render(scene, this.cam);
      scene.overrideMaterial = prevOverride; scene.background = prevBg; scene.environment = prevEnv;
      r.shadowMap.enabled = prevShadow; r.shadowMap.autoUpdate = prevAuto;
      r.setRenderTarget(prevRT);
      for (const o of hidden) o.visible = true;
      this.cleared = false;
      return;
    }
    const prevRT = r.getRenderTarget(), prevOverride = scene.overrideMaterial, prevBg = scene.background, prevEnv = scene.environment;
    const prevShadow = r.shadowMap.enabled, prevAuto = r.shadowMap.autoUpdate, prevXR = r.xr.enabled;
    scene.overrideMaterial = this.override; scene.background = null; scene.environment = null;
    r.shadowMap.enabled = false; r.shadowMap.autoUpdate = false; r.xr.enabled = false;
    r.setRenderTarget(this.rtA);
    if (fromScratch || !this.cleared) { r.setClearColor(0x000000, 1); r.clear(true, false, false); this.cleared = true; }
    const prevAutoClear = r.autoClear; r.autoClear = false;
    // two sheared projections: view x/y += k·(world y) along two diagonals (k = 1 → a 1.45 m slab gives 1.45 m)
    const base = this.cam.projectionMatrix.clone();
    // (shear 0.3: a vertical wall still gets ~0.4 m ≈ ⅔ texel of footprint, while a rock or sea stack no longer smears
    // into a 4-armed X or an inflated blob — the white "stars", squares and saucers around small rocks)
    const K = 0.3;
    const half = this.cam.right;
    for (const [slab, col] of [[ABOVE, 0xff0000], [BELOW, 0x00ff00]] as const) {
      // orthographic slab y ∈ [lo, hi] (camera at y = 40 looking down); the colour channel says which slab
      const ortho = new THREE.Matrix4().makeOrthographic(-half, half, half, -half, 40 - slab[1], 40 - slab[0]);
      (this.override.uniforms.uCol.value as THREE.Color).setHex(col);
      for (const [kx, ky] of [[K, K], [K, -K]]) {
        const S = new THREE.Matrix4().set(1, 0, kx, 40 * kx, 0, 1, ky, 40 * ky, 0, 0, 1, 0, 0, 0, 0, 1);
        this.cam.projectionMatrix.multiplyMatrices(ortho, S);
        this.cam.projectionMatrixInverse.copy(this.cam.projectionMatrix).invert();
        r.render(scene, this.cam);
      }
    }
    (this.override.uniforms.uCol.value as THREE.Color).setHex(0xffffff);
    this.cam.projectionMatrix.copy(base); this.cam.projectionMatrixInverse.copy(base).invert();
    r.autoClear = prevAutoClear;
    scene.overrideMaterial = prevOverride; scene.background = prevBg; scene.environment = prevEnv;
    r.shadowMap.enabled = prevShadow; r.shadowMap.autoUpdate = prevAuto; r.xr.enabled = prevXR;
    for (const o of hidden) o.visible = true;
    // (anything that was hidden by an ancestor is simply not marked: it gets its turn when it shows up)
    for (const o of drawn) {
      let vis = true; o.traverseAncestors((a) => { if (!a.visible) vis = false; });
      if (!vis) continue;
      this.baked.set(o, this.countOf(o));
      if ((o as THREE.BatchedMesh).isBatchedMesh) { if (fromScratch) this.batchedIds.delete(o); this.batchedFresh(o, true); }
    }
    // pierce A → P, then the separable distance transform P → B → C
    this.quad.material = this.pierceMat;
    this.pierceMat.uniforms.uTex.value = this.rtA.texture;
    r.setRenderTarget(this.rtP); r.render(this.quadScene, this.quadCam);
    // the wide proximity P → W1 (4×4 max) → W2 (size filter) → W1 (EDT x) → W2 (EDT y) = the result
    const wd = this.wideDown.uniforms;
    this.quad.material = this.wideDown; wd.uTex.value = this.rtP.texture; wd.uTexel.value = 1 / this.rtP.width; wd.uMode.value = 0;
    r.setRenderTarget(this.rtW1); r.render(this.quadScene, this.quadCam);
    wd.uTex.value = this.rtW1.texture; wd.uTexel.value = 1 / this.rtW1.width; wd.uMode.value = 1;
    r.setRenderTarget(this.rtW2); r.render(this.quadScene, this.quadCam);
    this.quad.material = this.wideEdt;
    this.wideEdt.uniforms.uTex.value = this.rtW2.texture; this.wideEdt.uniforms.uDir.value.set(1 / this.rtW1.width, 0); this.wideEdt.uniforms.uPass.value = 0;
    r.setRenderTarget(this.rtW1); r.render(this.quadScene, this.quadCam);
    this.wideEdt.uniforms.uTex.value = this.rtW1.texture; this.wideEdt.uniforms.uDir.value.set(0, 1 / this.rtW1.width); this.wideEdt.uniforms.uPass.value = 1;
    r.setRenderTarget(this.rtW2); r.render(this.quadScene, this.quadCam);
    this.quad.material = this.blurMat;
    const texel = 1 / this.rtB.width;
    this.blurMat.uniforms.uTex.value = this.rtP.texture; this.blurMat.uniforms.uDir.value.set(texel, 0);
    this.blurMat.uniforms.uPass.value = 0;
    r.setRenderTarget(this.rtB); r.render(this.quadScene, this.quadCam);
    this.finalPass();
    r.setRenderTarget(prevRT);
    this.bakes++;
  }
}
