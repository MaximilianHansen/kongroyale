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
import type { Scope } from "../../engine/res/scope";

/** proximity reach of the rings, in texels of the bake (4096² over the 2.4 km island → 0.586 m: 7 → 4.1 m) */
const R = 7;
/** the wide proximity's reach in 2.34 m cells (6 → ≈ 16 m) */
const RW = 6;
/** minimum ms between automatic incremental re-bakes to avoid back-to-back frame hitches */
const MIN_REBAKE_MS = 500;
const dropScope = (s: Scope | null) => { if (s && !s.isDisposed) s.dispose(); return null; };
const _c = new THREE.Vector3();
const _boundA = new THREE.Vector3(), _boundB = new THREE.Vector3();
const _ortho = new THREE.Matrix4(), _shear = new THREE.Matrix4(), _base = new THREE.Matrix4();
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
  readonly #scope: Scope;
  readonly #size: number;
  readonly #blurSize: number;
  readonly #wideSize: number;
  readonly #rtOpts: THREE.RenderTargetOptions;
  readonly #renderer: THREE.WebGLRenderer;
  readonly #scene: THREE.Scene;
  #accumScope: Scope | null = null;
  #wideScope: Scope | null = null;
  #rtA: THREE.WebGLRenderTarget | null = null;
  #pierceMat: THREE.ShaderMaterial;
  #rtC: THREE.WebGLRenderTarget;
  /** the WIDE proximity (G of the result): 1024², 2.34 m texels, reach ≈ 16 m — the foam churn seen from the air around
   *  hulls, quay walls, sea stacks and big rocks (the target art's aerial harbor has 5-20 m of white water there; the
   *  4.7 m ring is ~2 px from 2 km) */
  #rtW2: THREE.WebGLRenderTarget | null = null;
  #wideDown: THREE.ShaderMaterial;
  #wideEdt: THREE.ShaderMaterial;
  #cam: THREE.OrthographicCamera;
  #override: THREE.ShaderMaterial;
  #blurMat: THREE.ShaderMaterial;
  #quad: THREE.Mesh;
  #quadScene = new THREE.Scene();
  #quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  #mask: THREE.Texture | null = null;
  #unregRestore: () => void;
  #lastBakeMs = -1e9;
  bakes = 0;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, half: number, size: number, blurSize: number, parentScope: Scope) {
    this.#renderer = renderer; this.#scene = scene;
    const scope = this.#scope = parentScope.child("obstacles");
    this.#size = size;
    this.#blurSize = blurSize;
    this.#wideSize = Math.max(256, size >> 2);
    this.scale = 1 / (2 * half);
    const opts: THREE.RenderTargetOptions = { format: THREE.RedFormat, type: THREE.UnsignedByteType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, stencilBuffer: false, generateMipmaps: false };
    this.#rtOpts = opts;
    // Keep only the final sampled target permanent; raw/pierce/blur/wide targets are allocated lazily per bake and freed
    this.#rtC = scope.target(new THREE.WebGLRenderTarget(blurSize, blurSize, { ...opts, format: THREE.RGFormat }));
    this.#rtC.texture.name = "water-obstacle";
    this.texture = this.#rtC.texture;
    // Scale ring filter radius proportionally with blurSize so world-space ring reach (~4.7 m) stays constant
    const blurR = Math.max(3, Math.round((R + 1) * (blurSize / 4096)) - 1);
    const coverCut = blurSize < size ? 0.16 : 0.22;
    // looking straight down; screen-right = +x, screen-up = -z (north). near/far clip the world to the waterline slab.
    // slab y ∈ [-0.15, 1.1]: only what pierces the surface (a rock whose top stays a hand under the water gets no ring:
    // its whole top baked as "contact" and printed a white square on the sea from the air)
    this.#cam = new THREE.OrthographicCamera(-half, half, half, -half, 40 - 1.1, 40 + 0.15);
    this.#cam.position.set(0, 40, 0); this.#cam.up.set(0, 0, -1); this.#cam.lookAt(0, 0, 0); this.#cam.updateMatrixWorld(true);
    // max-blended, no depth test: every fragment inside the slab counts (occlusion does not matter for a coverage mask)
    // (a MINIMAL coverage shader — position through three's instancing / batching chunks, a flat colour out. The
    // full MeshBasicMaterial program took 25-45 ms to compile per object-kind variant on ANGLE: one > 50 ms task)
    this.#override = scope.material(new THREE.ShaderMaterial({
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
    }));
    this.#override.customProgramCacheKey = () => "kr-water-obstacle-cov2";
    const VS_QUAD = "varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}";
    const mkQuadMat = (uniforms: Record<string, THREE.IUniform>, fragmentShader: string) =>
      scope.material(new THREE.ShaderMaterial({ uniforms, vertexShader: VS_QUAD, fragmentShader, depthTest: false, depthWrite: false }));
    // PROXIMITY = separable Euclidean distance transform within blurR+1 texels (~4.7 m); only solidly covered texels
    // count so partial coverage does not inflate small rock rings. Registered foam shapes (uMask) only nudge proximity
    // (<= 0.45) near real waterline geometry so misregistered shapes stay invisible instead of drawing phantom pads.
    this.#blurMat = mkQuadMat(
      { uTex: { value: null }, uDir: { value: new THREE.Vector2(1, 0) }, uMask: { value: null }, uWide: { value: null }, uPrev: { value: null }, uUseMask: { value: 0 }, uHasPrev: { value: 0 }, uPass: { value: 0 } },
      /* glsl */ `uniform sampler2D uTex,uMask,uWide,uPrev;uniform float uUseMask,uHasPrev,uPass;uniform vec2 uDir;varying vec2 vUv;const float RR=${(blurR + 1).toFixed(1)};void main(){if(uPass>2.5){gl_FragColor=texture2D(uPrev,vUv);return;}if(uPass<0.5){float best=RR;for(int i=-${blurR};i<=${blurR};i++){float c=texture2D(uTex,vUv+uDir*float(i)).r;if(c>${coverCut.toFixed(2)})best=min(best,max(abs(float(i))+0.5-c,0.0));}gl_FragColor=vec4(vec3(best/RR),1.0);return;}vec2 prev=(uHasPrev>0.5||uPass>1.5)?texture2D(uPrev,vUv).rg:vec2(0.0);float s=prev.r,wide=prev.g;if(uPass<1.5){float b2=RR*RR;for(int j=-${blurR};j<=${blurR};j++){float dx=texture2D(uTex,vUv+uDir*float(j)).r*RR;b2=min(b2,dx*dx+float(j*j));}s=1.0-min(sqrt(b2),RR)/RR;wide=texture2D(uWide,vUv).r;if(uHasPrev>0.5){s=max(s,prev.r);wide=max(wide,prev.g);}}if(uUseMask>0.5)s=max(s,texture2D(uMask,vec2(vUv.x,1.0-vUv.y)).r*0.45*smoothstep(0.004,0.05,s));gl_FragColor=vec4(s,wide,0.0,1.0);}`);
    // PIERCE pass (full bake resolution): coverage = above-slab footprint × (below-slab geometry within ±1 texel — the
    // shear puts a wall's above / below parts on opposite sides of it)
    this.#pierceMat = mkQuadMat({ uTex: { value: null }, uTexel: { value: 1 / size } }, /* glsl */ `uniform sampler2D uTex;uniform float uTexel;varying vec2 vUv;void main(){float a=texture2D(uTex,vUv).r,b=0.0;for(int j=-1;j<=1;j++)for(int i=-1;i<=1;i++)b=max(b,texture2D(uTex,vUv+vec2(float(i),float(j))*uTexel).g);gl_FragColor=vec4(vec3(a*smoothstep(0.1,0.4,b)),1.0);}`);
    // WIDE proximity: (1) pierce coverage over 4×4 fine texels (2.34 m cells), (2) size filter requiring >= 3 covered
    // neighbors so hull sides / quay walls / sea stacks get wide churn while single-cell posts / piles do not.
    this.#wideDown = mkQuadMat({ uTex: { value: null }, uTexel: { value: 1 / size }, uMode: { value: 0 } }, /* glsl */ `uniform sampler2D uTex;uniform float uTexel,uMode;varying vec2 vUv;void main(){if(uMode>0.5){float c=texture2D(uTex,vUv).r,n=0.0;for(int j=-1;j<=1;j++)for(int i=-1;i<=1;i++)n+=step(0.5,texture2D(uTex,vUv+vec2(float(i),float(j))*uTexel).r);gl_FragColor=vec4(vec3(c*step(3.5,n)),1.0);return;}float a=0.0;for(int j=0;j<4;j++)for(int i=0;i<4;i++)a=max(a,texture2D(uTex,vUv+(vec2(float(i),float(j))-1.5)*uTexel).r);gl_FragColor=vec4(vec3(step(0.3,a)),1.0);}`);
    this.#wideEdt = mkQuadMat({ uTex: { value: null }, uDir: { value: new THREE.Vector2(1, 0) }, uPass: { value: 0 } }, /* glsl */ `
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
        }`);
    const quadGeo = this.#scope.geometry("geo.world", new THREE.PlaneGeometry(2, 2));
    this.#quad = new THREE.Mesh(quadGeo, this.#blurMat);
    this.#quad.frustumCulled = false;
    this.#quadScene.add(this.#quad);
    this.#unregRestore = onRestore("bake", () => {
      if (this.#scope.isDisposed) return;
      this.releaseScratch(false);
      this.#baked = new WeakMap(); this.#batchedIds = new WeakMap(); this.#cleared = false;
      if (this.bakes > 0) this.bake(true);
    });
    this.#scope.defer(() => {
      this.#unregRestore();
      this.#accumScope = null;
      this.#wideScope = null;
      this.#rtA = this.#rtW2 = null;
    });
  }

  #rt(rtScope: Scope, s: number, name?: string, format: THREE.PixelFormat = THREE.RGBAFormat): THREE.WebGLRenderTarget {
    const t = rtScope.target(new THREE.WebGLRenderTarget(s, s, format === THREE.RGBAFormat ? this.#rtOpts : { ...this.#rtOpts, format }));
    if (name) t.texture.name = name;
    return t;
  }

  #renderQuad(mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget) {
    this.#quad.material = mat;
    this.#renderer.setRenderTarget(target);
    this.#renderer.render(this.#quadScene, this.#quadCam);
  }

  releaseScratch(keepWide = false) {
    this.#accumScope = dropScope(this.#accumScope);
    this.#rtA = null;
    if (!keepWide) this.releaseWide();
  }

  releaseWide() {
    this.#wideScope = dropScope(this.#wideScope);
    this.#rtW2 = null;
  }

  dispose() {
    if (!this.#scope.isDisposed) this.#scope.dispose();
  }

  /** the WIDE proximity read back to the CPU (RGBA8 rows, 1024² → 4 MB; R = proximity, ≈ 1 at a big object → 0 at ~16 m),
   *  once per bake — spray.ts picks its spawn points on the windward faces of sea stacks and big rocks from it */
  wideCells(releaseAfter = false): { cells: Uint8Array; size: number } | null {
    if (this.#scope.isDisposed || !this.bakes || !this.#rtW2) return null;
    const r = this.#renderer, gl = r.getContext() as WebGL2RenderingContext;
    const size = this.#rtW2.width, cells = new Uint8Array(size * size * 4);
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.#rtW2);
    gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, cells);
    r.setRenderTarget(prev);
    if (releaseAfter) this.releaseWide();
    return { cells, size };
  }

  /** wideCells without the GPU stall (no main-thread task > 50 ms): the read goes into a pixel-pack buffer behind a
   *  fence and is collected a few frames later, once the GPU has finished the bake */
  async wideCellsAsync(releaseAfter = true): Promise<{ cells: Uint8Array; size: number } | null> {
    if (this.#scope.isDisposed || !this.bakes || !this.#rtW2) return null;
    const r = this.#renderer, gl = r.getContext() as WebGL2RenderingContext;
    if (typeof gl.fenceSync !== "function") return this.wideCells(releaseAfter);
    const size = this.#rtW2.width, n = size * size * 4;
    const buf = gl.createBuffer(), epoch = contextEpoch();
    if (!buf) return this.wideCells(releaseAfter);
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.#rtW2);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, n, gl.STREAM_READ);
    gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    r.setRenderTarget(prev);
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    const t0 = performance.now();
    while (sync && epoch === contextEpoch() && !this.#scope.isDisposed && gl.clientWaitSync(sync, 0, 0) === gl.TIMEOUT_EXPIRED && performance.now() - t0 < 5000) await new Promise((res) => setTimeout(res, 8));
    const aborted = gl.isContextLost() || epoch !== contextEpoch() || this.#scope.isDisposed;
    if (sync && !gl.isContextLost()) gl.deleteSync(sync);
    if (aborted) { if (!gl.isContextLost()) gl.deleteBuffer(buf); return null; }
    const cells = new Uint8Array(n);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, cells);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.deleteBuffer(buf);
    if (releaseAfter) this.releaseWide();
    return { cells, size };
  }

  /** the registered-foam mask to composite into the result (see FoamMask) */
  setMask(t: THREE.Texture) { this.#mask = t; }

  #accum(): THREE.WebGLRenderTarget {
    return this.#rtA ?? (this.#rtA = this.#rt(this.#accumScope ?? (this.#accumScope = this.#scope.child("accum")), this.#size, "water-obstacle-raw", THREE.RGFormat));
  }

  #copyPrev(scope: Scope): THREE.WebGLRenderTarget {
    const prevRt = this.#rt(scope, this.#blurSize, undefined, THREE.RGFormat);
    const bu = this.#blurMat.uniforms;
    bu.uPrev.value = this.#rtC.texture; bu.uPass.value = 3;
    this.#renderQuad(this.#blurMat, prevRt);
    bu.uPrev.value = null; bu.uPass.value = 0;
    return prevRt;
  }

  /** re-run only the final (mask-compositing) pass — after registered foam shapes changed */
  recomposite() {
    if (this.#scope.isDisposed || this.bakes === 0) return;
    const r = this.#renderer, prevRT = r.getRenderTarget();
    const recompScope = this.#scope.child("recomp"), bu = this.#blurMat.uniforms;
    try {
      const prevRt = this.#copyPrev(recompScope);
      bu.uPrev.value = prevRt.texture; bu.uMask.value = this.#mask; bu.uUseMask.value = this.#mask ? 1 : 0; bu.uPass.value = 2;
      this.#renderQuad(this.#blurMat, this.#rtC);
      bu.uPrev.value = bu.uMask.value = null; bu.uUseMask.value = bu.uPass.value = 0;
    } finally {
      dropScope(recompScope);
      r.setRenderTarget(prevRT);
    }
  }

  #finalPass(rtB: THREE.WebGLRenderTarget, rtW2: THREE.WebGLRenderTarget, prevTex: THREE.Texture | null) {
    const bu = this.#blurMat.uniforms;
    bu.uTex.value = rtB.texture; bu.uDir.value.set(0, 1 / rtB.width);
    bu.uWide.value = rtW2.texture;
    bu.uMask.value = this.#mask; bu.uUseMask.value = this.#mask ? 1 : 0;
    bu.uPrev.value = prevTex; bu.uHasPrev.value = prevTex ? 1 : 0;
    bu.uPass.value = 1;
    this.#renderQuad(this.#blurMat, this.#rtC);
    bu.uUseMask.value = bu.uHasPrev.value = 0; bu.uPrev.value = bu.uMask.value = bu.uTex.value = bu.uWide.value = null;
  }

  /** what has been baked: object → instance count at its bake (the bake ACCUMULATES: other areas distance-cull and
   *  LOD-switch their props every frame, so whatever was visible at one bake may be hidden at the next — every static
   *  prop that is ever drawn gets baked once and keeps its ring) */
  #baked = new WeakMap<THREE.Object3D, number>();
  #cleared = false;
  #skip = new WeakSet<THREE.Object3D>();
  /** re-bakes each already-baked object has triggered (dynamic objects stop triggering after 2) */
  #trig = new WeakMap<THREE.Object3D, number>();

  /** a mesh the bake should render: not terrain/water/sky, opaque, not skinned (kongs move), in the waterline slab */
  #relevant(o: THREE.Object3D): boolean {
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
  #countOf(o: THREE.Object3D) { return (o as THREE.InstancedMesh).isInstancedMesh ? (o as THREE.InstancedMesh).count : 1; }
  /** BatchedMesh (TownLod & co. switch LOD tiers per INSTANCE by camera distance): which instance ids have been baked.
   *  A batch counts as fresh while any currently visible instance was never baked (the near tier of a building the
   *  camera walks up to after the first bake) */
  #batchedIds = new WeakMap<THREE.Object3D, Uint8Array>();
  #batchedFresh(o: THREE.Object3D, mark: boolean): boolean {
    const bm = o as THREE.BatchedMesh & { instanceCount?: number; maxInstanceCount?: number; _instanceInfo?: Array<{ visible: boolean; active: boolean }> };
    const info = bm._instanceInfo;
    if (!Array.isArray(info)) return false;
    let ids = this.#batchedIds.get(o);
    if (!ids || ids.length < info.length) { const n = new Uint8Array(info.length); if (ids) n.set(ids); ids = n; this.#batchedIds.set(o, ids); }
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
  maybeBake(force = false, keepWide = false) {
    if (this.#scope.isDisposed) return false;
    if (!force) {
      if (this.bakes > 0 && performance.now() - this.#lastBakeMs < MIN_REBAKE_MS) return false;
      let fresh = false, culprit: THREE.Object3D | null = null;
      this.#scene.traverseVisible((o) => {
        if (fresh || this.#skip.has(o)) return;
        if ((o as THREE.BatchedMesh).isBatchedMesh && this.#baked.has(o)) { if (this.#batchedFresh(o, false)) fresh = true; return; }
        if ((this.#baked.get(o) ?? -1) >= this.#countOf(o)) return;
        if (this.#relevant(o)) { fresh = true; culprit = o; } else this.#skip.add(o);   // (static props: irrelevant once, irrelevant always)
      });
      if (!fresh) return false;
      // (a live match re-baked ~1×/s — 7 ms bakes, 20-50 ms frames contended. An object
      //  that was baked before and whose drawn count grew AGAIN is dynamic (instanced FX, loot, debris): after its 2nd
      //  re-trigger it never triggers a bake again. Every static prop is still baked once when it first shows up)
      const c = culprit as THREE.Object3D | null;
      if (c && this.#baked.has(c)) {
        const n = (this.#trig.get(c) ?? 0) + 1;
        this.#trig.set(c, n);
        if (n > 2) { this.#skip.add(c); return false; }
      }
    }
    this.bake(force, undefined, false, keepWide);
    return true;
  }

  /** the first bake compiles the override program once per object kind (mesh / instanced / batched): ~30 ms each
   *  on ANGLE — together one 100+ ms task. Warm them one kind per frame (a throw-away bake of only that kind) first */
  async warm(nextFrame: () => Promise<void>) {
    if (this.#scope.isDisposed) return;
    // (the first render of each object with the override program sets up its binding state — hundreds of meshes in
    // one frame were a 50-130 ms task: warm them in chunks of ~60 objects, one chunk per frame)
    const list: THREE.Object3D[] = [];
    this.#scene.traverseVisible((o) => { if (((o as THREE.Mesh).isMesh || (o as THREE.BatchedMesh).isBatchedMesh) && this.#relevant(o)) list.push(o); });
    const kinds: Array<(o: THREE.Object3D) => boolean> = [];
    for (let i = 0; i < list.length; i += 60) { const set = new Set(list.slice(i, i + 60)); kinds.push((o) => set.has(o)); }
    const ms: number[] = [];
    for (const k of kinds) { if (this.#scope.isDisposed) return; const t = performance.now(); this.bake(true, k, true); ms.push(Math.round(performance.now() - t)); await nextFrame(); }
    (window as unknown as { __krWaterWarm?: number[] }).__krWaterWarm = ms;
  }

  bake(fromScratch = true, only?: (o: THREE.Object3D) => boolean, warmOnly = false, keepWide = false) {
    if (this.#scope.isDisposed) return;
    const r = this.#renderer, scene = this.#scene;
    const hidden: THREE.Object3D[] = [], drawn: THREE.Object3D[] = [];
    scene.updateMatrixWorld();
    scene.traverse((o) => {
      if (!o.visible) return;
      const m = o as THREE.Mesh;
      const isMesh = m.isMesh || (o as THREE.InstancedMesh).isInstancedMesh || (o as THREE.BatchedMesh).isBatchedMesh;
      if (!isMesh) return;
      if (this.#relevant(o) && (!only || only(o))) drawn.push(o); else { o.visible = false; hidden.push(o); }
    });
    // (warm-up: the programs only — one slab, one shear; nothing is marked baked)
    const prevRT = r.getRenderTarget(), prevOv = scene.overrideMaterial, prevBg = scene.background, prevEnv = scene.environment;
    const prevSh = r.shadowMap.enabled, prevSa = r.shadowMap.autoUpdate, prevXr = r.xr.enabled, prevAc = r.autoClear;
    scene.background = scene.environment = null; r.shadowMap.enabled = r.shadowMap.autoUpdate = r.xr.enabled = false;
    let passScope: Scope | null = null;
    try {
      if (warmOnly) {
        scene.overrideMaterial = this.#override;
        r.setRenderTarget(this.#accum());
        if (drawn.length) r.render(scene, this.#cam);
        return;
      }
      passScope = this.#scope.child("bake-pass");
      const rtPrev = !fromScratch && this.bakes > 0 && !this.#rtA ? this.#copyPrev(passScope) : null;
      const rtA = this.#accum();
      const rtP = this.#rt(passScope, this.#size, "water-obstacle-pierce");
      const rtB = this.#rt(passScope, this.#blurSize);
      const rtW1 = this.#rt(passScope, this.#wideSize);
      const rtW2 = this.#rtW2 ?? (this.#rtW2 = this.#rt(this.#wideScope ?? (this.#wideScope = this.#scope.child("wide")), this.#wideSize));
      scene.overrideMaterial = this.#override;
      r.setRenderTarget(rtA);
      if (fromScratch || !this.#cleared) { r.setClearColor(0x000000, 1); r.clear(true, false, false); this.#cleared = true; }
      r.autoClear = false;
      // two sheared projections: view x/y += k·(world y) along two diagonals (k = 1 → a 1.45 m slab gives 1.45 m)
      _base.copy(this.#cam.projectionMatrix);
      // (shear 0.3: a vertical wall still gets ~0.4 m ≈ ⅔ texel of footprint, while a rock or sea stack no longer smears
      // into a 4-armed X or an inflated blob — the white "stars", squares and saucers around small rocks)
      const K = 0.3, half = this.#cam.right;
      for (const [slab, col] of [[ABOVE, 0xff0000], [BELOW, 0x00ff00]] as const) {
        // orthographic slab y ∈ [lo, hi] (camera at y = 40 looking down); the colour channel says which slab
        _ortho.makeOrthographic(-half, half, half, -half, 40 - slab[1], 40 - slab[0]);
        (this.#override.uniforms.uCol.value as THREE.Color).setHex(col);
        for (const [kx, ky] of [[K, K], [K, -K]]) {
          _shear.set(1, 0, kx, 40 * kx, 0, 1, ky, 40 * ky, 0, 0, 1, 0, 0, 0, 0, 1);
          this.#cam.projectionMatrix.multiplyMatrices(_ortho, _shear);
          this.#cam.projectionMatrixInverse.copy(this.#cam.projectionMatrix).invert();
          r.render(scene, this.#cam);
        }
      }
      (this.#override.uniforms.uCol.value as THREE.Color).setHex(0xffffff);
      this.#cam.projectionMatrix.copy(_base); this.#cam.projectionMatrixInverse.copy(_base).invert();
      scene.overrideMaterial = null; r.autoClear = prevAc;
      // (anything that was hidden by an ancestor is simply not marked: it gets its turn when it shows up)
      for (const o of drawn) {
        let vis = true; o.traverseAncestors((a) => { if (!a.visible) vis = false; });
        if (!vis) continue;
        this.#baked.set(o, this.#countOf(o));
        if ((o as THREE.BatchedMesh).isBatchedMesh) { if (fromScratch) this.#batchedIds.delete(o); this.#batchedFresh(o, true); }
      }
      // pierce A → P, then the wide & separable distance transforms P → W1/W2, P → B → C
      const wd = this.#wideDown.uniforms, we = this.#wideEdt.uniforms, bu = this.#blurMat.uniforms;
      const run = (m: THREE.ShaderMaterial, t: THREE.Texture, dst: THREE.WebGLRenderTarget) => { m.uniforms.uTex.value = t; this.#renderQuad(m, dst); };
      run(this.#pierceMat, rtA.texture, rtP); this.#pierceMat.uniforms.uTex.value = null;
      wd.uTexel.value = 1 / rtP.width; wd.uMode.value = 0; run(this.#wideDown, rtP.texture, rtW1);
      wd.uTexel.value = 1 / rtW1.width; wd.uMode.value = 1; run(this.#wideDown, rtW1.texture, rtW2); wd.uTex.value = null;
      we.uDir.value.set(1 / rtW1.width, 0); we.uPass.value = 0; run(this.#wideEdt, rtW2.texture, rtW1);
      we.uDir.value.set(0, 1 / rtW1.width); we.uPass.value = 1; run(this.#wideEdt, rtW1.texture, rtW2); we.uTex.value = null;
      bu.uDir.value.set(1 / rtB.width, 0); bu.uPass.value = 0; run(this.#blurMat, rtP.texture, rtB);
      this.#finalPass(rtB, rtW2, rtPrev ? rtPrev.texture : null);
      this.#lastBakeMs = performance.now();
      this.bakes++;
    } finally {
      r.autoClear = prevAc; scene.overrideMaterial = prevOv; scene.background = prevBg; scene.environment = prevEnv;
      r.shadowMap.enabled = prevSh; r.shadowMap.autoUpdate = prevSa; r.xr.enabled = prevXr; r.setRenderTarget(prevRT);
      for (const o of hidden) o.visible = true;
      dropScope(passScope);
      this.#cleared = false;
      if (!warmOnly) this.releaseScratch(keepWide);
    }
  }
}
