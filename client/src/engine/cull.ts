// DETAIL CULL — screen-size culling for world-module content.
// A live-match draw census (peel-harbor centre at eye level, 2560×1440) found ~45 % of the main pass's draws
// going to meshes 500-1100 m away (the lab's glass panes, the falls' spray cards, canopy planks, cave props …) that cover
// less than a pixel or two on screen — each one a full CPU draw (~10-15 µs: program / uniforms / VAO) for nothing.
// Engines often do this with a per-mesh "min screen size" or cull-distance volumes; here it is automatic:
//   • every static mesh below a registered world-module root gets its world bounding sphere once (refreshed when the
//     object moves — a translation / scale check every 16th frame per object, or at once when its matrix changes);
//   • per frame, an object whose projected RADIUS is under `minPx` pixels (opaque) / `minPxT` (transparent) is
//     removed from every camera by clearing its layer mask (three still walks its children; the module's own
//     `visible` and LOD logic are untouched), and restored beyond a 15 % hysteresis before it can matter;
//   • the threshold follows the canvas height and the camera fov: at 4K things stay twice as far.
// Never culled: skinned / batched meshes, anything with frustumCulled = false (sky, water, terrain skirts that must
// always draw), subtrees marked userData.krDynamic or userData.noCull, and gameplay objects (never registered).
// ?nocull disables it; `engine.cull.info()` / `engine.cull.minPx` for tuning.
import * as THREE from "three";
import { DITHER, clearDither, ditherable, patchShaderDissolve, setDither } from "./dither";
import { flag } from "../flags";

/** ?lodv=1 → a cut /
 * restore is a 0.3 s SCALE FADE about the mesh's bounding centre (onBeforeRender / onAfterRender — the module's own
 * matrices are never touched), the restore band is 22 % (was 13 %) plus 1.5 s before a faded-out mesh may come back
 * (no flapping at the boundary), and big meshes (r ≥ 4 m: buildings, POI modules) keep at least 0.83 × the Epic
 * distance from Medium up (`bigMaxPx`: those settings cut small-object distance, not the skyline). Low cuts them by its
 * own 4 px rule like everything else (0.6 × that distance); past a POI's far-merge switch its merged buildings draw
 * as the proxy whatever the cull does (hlod.ts). */
export const CULL_LODV = flag("lodv");
/** with DITHER (engine/dither.ts) every fade DISSOLVES instead of scaling; a dissolve reads as a soft
 *  crossfade under TAA, so it runs a little longer than the scale fade (0.3 s) */
const FADE_S = DITHER ? 0.4 : 0.3, VIS_FADE_S = DITHER ? 0.5 : 0.3, REVEAL_S = 0.9, BIG_R = 4, BIG_MAXPX = 2.4;
/** module visibility fades (see MODULE VISIBILITY FADES below): ON by default (measured pops on the Auto preset on a
 *  Mac, 5 routes: 6,469 → 1,027; the drop 926 → 13, the glide 1,294 → 16); ?visfade=0 = instant switches (A/B);
 *  switches nearer than VIS_NEAR m (to the object's box) are instant */
const VIS_FADE = typeof location !== "undefined" && flag("visfade");
// (3 m, and only for objects < 30 m across — with the dissolve a near switch reads as a short crossfade,
// not a shrinking object, so only what the player touches stays instant; gameplay-driven visibility opts out with
// userData.krInstant)
const VIS_NEAR = DITHER ? 3 : 12, INST_FADE_MAX = 4096, SETTLE = 10;
/** module switches of objects outside the view are instant (?offinstant=0 = they fade, A/B) */
const OFF_INSTANT = flag("offinstant");
/** the screen-size thresholds
 *  use the player's OWN field of view (DetailCull.fovRef, the video setting) instead of the camera's live one. The game
 *  widens the view +5° while sprinting (+7° more sliding: 72 → 84°, tan ratio 1.24) and narrows it to 58–65° in the
 *  plane / drop — each change moved every cut distance: props at the edge of the cull distance faded out when the
 *  player started sprinting or sliding (and, past the 22 % restore band, back in when they stopped). A real zoom (a
 *  scope: < 0.75 × the base FOV) still counts. ?cullfov=0 = the live FOV (A/B). */
const CULL_FOVREF = flag("cullfov");
const VIS = Symbol("krVis");
interface Vis { o: THREE.Object3D; want: boolean; committed: boolean; shown: boolean; f: number; dir: number; meshes: THREE.Object3D[] | null; b: THREE.Box3 | null; owner: DetailCull }
/** ONE getter / setter pair shared by every wrapped object (per-object closures gave each wrapped
 *  object its own hidden class). A write takes effect AT ONCE (`want`) and is only turned into a fade at the next cull
 *  update if it is still there: render passes that hide objects around their own draw (the atmos cascade caster
 *  filters, bakes — ~250 toggles a frame, measured) must see their toggle, and must not start fades (they did: the
 *  objects stayed drawn into every shadow pass — +0.7 ms per frame). `committed` = the value the last update saw. */
function visGet(this: VisObj) { const v = this[VIS]!; return v.want !== v.committed ? v.want : v.shown; }
function visSet(this: VisObj, x: boolean) { const v = this[VIS]!; x = !!x; if (x !== v.want) { v.want = x; v.owner.visPending.add(v); } }
type VisObj = THREE.Object3D & { [VIS]?: Vis };

interface Item {
  o: THREE.Object3D;
  cx: number; cy: number; cz: number; r: number;
  /** matrixWorld translation + scale snapshot the sphere was computed from */
  tx: number; ty: number; tz: number; s: number;
  lr: number;          // local bounding radius (object space, before scale)
  lc: THREE.Vector3;   // local bounding centre
  transparent: boolean;
  culled: boolean;
  mask: number;        // layer mask saved while culled
  /** (lodv) scale fade 0..1 (1 = full size), its direction (−1 out, +1 in, 0 settled) and when it last finished fading out */
  f: number; dir: number; outAt: number;
}

const _v = new THREE.Vector3(), _box = new THREE.Box3();
const ROOT = "__krCullRoot";
function isBelow(o: THREE.Object3D, root: THREE.Object3D) { for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p === root) return true; return false; }

export class DetailCull {
  enabled: boolean;
  /** projected radius (px) under which an opaque mesh stops drawing */
  minPx = 2;
  /** …a transparent one (glass, spray, decals: blended, cost more, show less) */
  minPxT = 3;
  /** never cull nearer than this (m): no LOD pop anywhere near the player (none within 60 m) */
  minDist = 80;
  /** (lodv) big meshes (r ≥ BIG_R m) stop drawing under min(minPx, bigMaxPx) projected radius: the default keeps the
   *  skyline at ≥ 0.83 × the Epic distance; the Low view distance sets it to its own minPx (display.ts) */
  bigMaxPx = BIG_MAXPX;
  /** the player's own vertical FOV (deg; the engine sets it from the video settings) — see CULL_FOVREF */
  fovRef = 72;
  /** tan(half the FOV the thresholds are computed for) */
  tanFor(cam: THREE.PerspectiveCamera) {
    const f = CULL_FOVREF && cam.fov >= this.fovRef * 0.75 ? this.fovRef : cam.fov;
    return Math.tan((f * Math.PI) / 360) / Math.max(0.01, cam.zoom);
  }
  private items: Item[] = [];
  /** every instanced mesh below a root (frustumCulled or not): one with count 0 still costs a full draw setup */
  private inst: Array<{ o: THREE.InstancedMesh; off: boolean; mask: number }> = [];
  readonly roots: THREE.Object3D[] = [];
  readonly stale = new Set<THREE.Object3D>();
  /** the frame a root's structure last changed: a root is re-collected once it has been quiet for
   *  SETTLE frames — a module that builds lazily (the Murk's far crowns: two cells a frame) used to trigger a
   *  re-collect every frame, cross the churn limit below and lose its culling AND its visibility fades for good */
  readonly touchedAt = new Map<THREE.Object3D, number>();
  /** …but a root that never goes quiet is still re-collected every 120 frames (then the churn limit applies) */
  readonly staleSince = new Map<THREE.Object3D, number>();
  private frame = 0;
  culled = 0;
  /** scale fades started (each one is a prop visibly shrinking away
   *  or growing back) */
  fades = { out: 0, in: 0 };

  constructor(enabled: boolean) { this.enabled = enabled; }

  /** start culling below `root` (a world module's scene root). Idempotent. Content added later is picked up. */
  /** (set by the engine) true when a material already has a compiled program */
  compiled: (m: THREE.Material) => boolean = () => true;
  register(root: THREE.Object3D) {
    if (!this.enabled || this.roots.includes(root) || root.userData.noCull) return;
    // a POI's custom ShaderMaterials get the dissolve before their first compile (an already compiled
    // one keeps the scale fade: changing its source now would recompile it on a frame)
    if (DITHER) root.traverse((o) => {
      const mm = (o as THREE.Mesh).material; if (!mm) return;
      for (const m of Array.isArray(mm) ? mm : [mm]) if (m && (m as THREE.ShaderMaterial).isShaderMaterial && !m.userData.krDissolve && !this.compiled(m)) patchShaderDissolve(m as THREE.ShaderMaterial);
    });
    this.roots.push(root);
    (root as unknown as Record<string, number[]>)[ROOT] = [];
    this.stale.add(root);
  }

  /** the structure below a registered root changed (scene-hooks): re-collect it before the next frame */
  touched(parent: THREE.Object3D) {
    if (!this.enabled || !this.roots.length) return;
    for (let p: THREE.Object3D | null = parent; p; p = p.parent) if ((p as unknown as Record<string, unknown>)[ROOT]) { this.stale.add(p); this.touchedAt.set(p, this.frame); if (!this.staleSince.has(p)) this.staleSince.set(p, this.frame); return; }
  }



  /** a root whose structure churns (> 12 re-collects in 240 frames) is left alone for good */
  private release(root: THREE.Object3D) {
    this.drop(root);
    this.released++;
  }

  drop(root: THREE.Object3D) {
    for (const it of this.items) if ((it.culled || it.dir !== 0) && isBelow(it.o, root)) this.uncull(it);
    this.items = this.items.filter((it) => !isBelow(it.o, root));
    for (const x of this.inst) if (x.off && isBelow(x.o, root)) x.o.layers.mask |= x.mask;
    this.inst = this.inst.filter((x) => !isBelow(x.o, root));
    this.roots.splice(this.roots.indexOf(root), 1);
    delete (root as unknown as Record<string, unknown>)[ROOT];
    this.unwrapVis(root); this.reconcile();
  }
  released = 0;

  private collect(root: THREE.Object3D) {
    const hist = (root as unknown as Record<string, number[]>)[ROOT];
    if (!hist) return;
    hist.push(this.frame);
    while (hist.length && this.frame - hist[0] > 240) hist.shift();
    if (hist.length > 12) { this.release(root); return; }
    // drop this root's old items (restoring any it had culled)
    const keep: Item[] = [];
    const mine = new Set<THREE.Object3D>();
    root.traverse((o) => { mine.add(o); });
    for (const it of this.items) {
      if (mine.has(it.o) || !it.o.parent) { if (it.culled || it.dir !== 0) this.uncull(it); continue; }
      keep.push(it);
    }
    this.items = keep;
    this.inst = this.inst.filter((x) => { if (mine.has(x.o) || !x.o.parent) { if (x.off) x.o.layers.mask |= x.mask; return false; } return true; });
    if (!root.parent) return;
    const walk = (o: THREE.Object3D) => {
      if (o.userData.noCull) return;
      if ((o as THREE.InstancedMesh).isInstancedMesh) this.inst.push({ o: o as THREE.InstancedMesh, off: false, mask: 0 });
      if (o.userData.krDynamic) return;
      const m = o as THREE.Mesh;
      if ((m.isMesh || (o as THREE.Points).isPoints || (o as THREE.Line).isLine) && m.geometry && o.frustumCulled
        && !(o as THREE.SkinnedMesh).isSkinnedMesh && !(o as unknown as { isBatchedMesh?: boolean }).isBatchedMesh) {
        const im = o as THREE.InstancedMesh;
        let bs: THREE.Sphere | null;
        if (im.isInstancedMesh) { if (im.boundingSphere === null) im.computeBoundingSphere(); bs = im.boundingSphere; }
        else { if (m.geometry.boundingSphere === null) m.geometry.computeBoundingSphere(); bs = m.geometry.boundingSphere; }
        if (bs && Number.isFinite(bs.radius) && bs.radius > 0) {
          const mats = Array.isArray(m.material) ? m.material : [m.material];
          const transparent = mats.some((x) => x && (x as THREE.Material).transparent);
          const it: Item = { o, cx: 0, cy: 0, cz: 0, r: 0, tx: NaN, ty: 0, tz: 0, s: 0, lr: bs.radius, lc: bs.center.clone(), transparent, culled: false, mask: 0, f: 1, dir: 0, outAt: -1e9 };
          this.sphere(it);
          this.items.push(it); this.byObj.set(o, it);
        }
      }
      for (const c of o.children) walk(c);
    };
    walk(root);
    this.wrapVis(root);
  }

  private sphere(it: Item) {
    const e = it.o.matrixWorld.elements;
    it.tx = e[12]; it.ty = e[13]; it.tz = e[14];
    const sx = e[0] * e[0] + e[1] * e[1] + e[2] * e[2], sy = e[4] * e[4] + e[5] * e[5] + e[6] * e[6], sz = e[8] * e[8] + e[9] * e[9] + e[10] * e[10];
    it.s = Math.sqrt(Math.max(sx, sy, sz));
    _v.copy(it.lc).applyMatrix4(it.o.matrixWorld);
    it.cx = _v.x; it.cy = _v.y; it.cz = _v.z; it.r = it.lr * it.s;
  }

  private uncull(it: Item) {
    // OR the saved layers back over whatever is there now: while the mask was 0, atmos may have enabled its cascade-1
    // shadow layer (29) — a `mask === 0` guard then never restored the object (trees / props vanished for good)
    if (it.culled) it.o.layers.mask |= it.mask;
    it.culled = false;
    if (it.dir !== 0 || it.f < 1) this.unhook(it);
    it.f = 1; it.dir = 0;
  }

  // ---- (lodv) scale fades: the draw sees matrixWorld scaled about the bounding centre by f; restored right after.
  // One hook per object, whatever fades it: its own DetailCull item (it.f) × every fading ancestor whose module toggled
  // `visible` (Vis.f). reconcile() adds / removes the hooks once per update.
  private fading = new Set<Item>();
  private time = 0;
  private hooked = new Set<THREE.Object3D>();
  private hook(it: Item) { this.fading.add(it); }
  private unhook(it: Item) { this.fading.delete(it); }
  /** the draw scale of `o` now (1 = full): its own cull fade × its fading ancestors' visibility fades */
  private factorOf(o: THREE.Object3D): number {
    const it = this.byObj.get(o);
    let f = it ? (it.culled ? 0 : it.f) : 1;
    this.inDir = it ? it.dir > 0 : false;
    const rv = this.reveals.get(o); if (rv !== undefined) { f *= rv; this.inDir = true; }
    for (let p: THREE.Object3D | null = o; p; p = p.parent) { const v = (p as VisObj)[VIS]; if (v && v.dir !== 0) { f *= v.f; if (v.dir > 0) this.inDir = true; } }
    return f;
  }
  /** (set by factorOf) some fade on the object is a fade IN — the dissolve uses the complementary mask */
  private inDir = false;
  /** objects dissolving now (engine/dither.ts) instead of scaling */
  private dithered = new Set<THREE.Object3D>();
  private hookObj(o: THREE.Object3D & { __krCullSaved?: THREE.Matrix4; __krCullPrev?: [unknown, unknown] }) {
    if (o.__krCullSaved) return;
    const m = o as THREE.Mesh;
    let c = this.byObj.get(o)?.lc;
    if (!c) { if (!m.geometry) return; if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere(); c = m.geometry.boundingSphere?.center; if (!c) return; }
    const saved = (o.__krCullSaved = new THREE.Matrix4()), lc = c;
    // the object's hooks keep running (chained), inherited ones too (a BatchedMesh rebuilds its per-camera draw list in
    // onBeforeRender / onBeforeShadow); its own ones come back unchanged after the fade
    const own = (k: string) => (Object.prototype.hasOwnProperty.call(o, k) ? (o as unknown as Record<string, unknown>)[k] : undefined);
    o.__krCullPrev = [own("onBeforeRender"), own("onAfterRender"), own("onBeforeShadow")] as unknown as [unknown, unknown];
    const pb = o.onBeforeRender, pa = o.onAfterRender, ps = o.onBeforeShadow;
    const scaled = (out: THREE.Matrix4) => {
      const f = Math.max(1e-3, this.factorOf(o)), e = out.elements, s = o.matrixWorld.elements;
      // M' = M · T(c) · S(f) · T(−c): columns scaled, translation moved so the bounding centre stays put
      for (let k = 0; k < 16; k++) e[k] = (k & 3) !== 3 && k < 12 ? s[k] * f : s[k];
      const g = 1 - f, wx = s[0] * lc.x + s[4] * lc.y + s[8] * lc.z, wy = s[1] * lc.x + s[5] * lc.y + s[9] * lc.z, wz = s[2] * lc.x + s[6] * lc.y + s[10] * lc.z;
      e[12] += wx * g; e[13] += wy * g; e[14] += wz * g;
      return out;
    };
    const tmp = new THREE.Matrix4();
    o.onBeforeRender = (...args: Parameters<THREE.Object3D["onBeforeRender"]>) => {
      pb.apply(o, args);
      saved.copy(o.matrixWorld);
      o.matrixWorld.copy(scaled(tmp));
    };
    o.onAfterRender = (...args: Parameters<THREE.Object3D["onAfterRender"]>) => { o.matrixWorld.copy(saved); pa.apply(o, args); };
    // the shadow pass computed modelViewMatrix before this hook: redo it with the scaled matrix (shadows fade too;
    // with ?visfade only until measured)
    if (VIS_FADE) o.onBeforeShadow = (...args: Parameters<THREE.Object3D["onBeforeShadow"]>) => {
      ps.apply(o, args);
      const sc = args[3] as THREE.Camera;
      o.modelViewMatrix.multiplyMatrices(sc.matrixWorldInverse, scaled(tmp));
    };
    this.hooked.add(o);
  }
  private unhookObj(o: THREE.Object3D & { __krCullSaved?: THREE.Matrix4; __krCullPrev?: [unknown, unknown] }) {
    this.hooked.delete(o);
    if (!o.__krCullSaved) return;
    const oo = o as unknown as Record<string, unknown>, prev = (o.__krCullPrev ?? []) as unknown[];
    // back to exactly what was there (the prototype's no-ops when nothing was — hlod.ts tests identity)
    const put = (k: string, v: unknown) => { if (v !== undefined) oo[k] = v; else delete oo[k]; };
    put("onBeforeRender", prev[0]); put("onAfterRender", prev[1]); put("onBeforeShadow", prev[2]);
    delete o.__krCullSaved; delete o.__krCullPrev;
  }
  /** hooks follow the fades: every fading item's mesh + every drawable below a fading visibility state */
  private reconcile() {
    const want = new Set<THREE.Object3D>();
    for (const it of this.fading) if (it.o.parent) want.add(it.o);
    for (const v of this.visFading) for (const m of this.visMeshes(v)) want.add(m);
    for (const o of this.reveals.keys()) want.add(o);
    for (const o of this.hooked) if (!want.has(o)) this.unhookObj(o);
    for (const [o, x] of this.instFades) if (!want.has(o)) { this.instEnd(o, x); this.instFades.delete(o); }
    for (const o of this.dithered) if (!want.has(o)) { clearDither(o); this.dithered.delete(o); }
    for (const o of want) {
      // a mesh whose materials carry the dissolve chunk fades by dissolving — a 50 m crane no longer
      // grows out of its centre like a spawn-in effect; instanced meshes dissolve as one (the module switched them as one)
      if (DITHER && (this.dithered.has(o) || ditherable(o))) {
        const f = this.factorOf(o);
        setDither(o, 1 - f, this.inDir);
        this.dithered.add(o);
        continue;
      }
      const im = o as THREE.InstancedMesh;
      // (per-instance fades only with ?visfade — untested; otherwise the batch scales as one)
      if (im.isInstancedMesh && VIS_FADE) { if (!this.instFades.has(im)) this.instStart(im); }
      else if (!this.hooked.has(o)) this.hookObj(o);
    }
    for (const [o, x] of this.instFades) this.instApply(o, x);
  }
  // instanced meshes fade PER INSTANCE (each scaled about its own centre: the batch must not contract toward its middle):
  // the module's matrices are kept and written back when the fade ends; a module that rewrites them meanwhile wins
  private instFades = new Map<THREE.InstancedMesh, { orig: Float32Array; ver: number; f: number }>();
  private instStart(o: THREE.InstancedMesh) {
    if (o.count > INST_FADE_MAX) return;
    const a = o.instanceMatrix.array as Float32Array;
    this.instFades.set(o, { orig: a.slice(0, o.count * 16), ver: o.instanceMatrix.version, f: 1 });
  }
  private instEnd(o: THREE.InstancedMesh, x: { orig: Float32Array; ver: number }) {
    if (o.instanceMatrix.version !== x.ver) return;   // the module re-packed: its data stands
    (o.instanceMatrix.array as Float32Array).set(x.orig.subarray(0, Math.min(x.orig.length, o.count * 16)));
    o.instanceMatrix.needsUpdate = true;
  }
  private instApply(o: THREE.InstancedMesh, x: { orig: Float32Array; ver: number; f: number }) {
    if (o.instanceMatrix.version !== x.ver || o.count * 16 > x.orig.length) { this.instEnd(o, x); this.instFades.delete(o); return; }
    const f = Math.max(1e-3, this.factorOf(o));
    if (Math.abs(f - x.f) < 1e-4) return;
    x.f = f;
    const g = o.geometry; if (!g.boundingSphere) g.computeBoundingSphere();
    const c = g.boundingSphere!.center, a = o.instanceMatrix.array as Float32Array, s = x.orig, h = 1 - f;
    for (let i = 0, n = o.count; i < n; i++) {
      const k = i * 16;
      for (let j = 0; j < 12; j++) a[k + j] = (j & 3) === 3 ? s[k + j] : s[k + j] * f;
      a[k + 12] = s[k + 12] + (s[k] * c.x + s[k + 4] * c.y + s[k + 8] * c.z) * h;
      a[k + 13] = s[k + 13] + (s[k + 1] * c.x + s[k + 5] * c.y + s[k + 9] * c.z) * h;
      a[k + 14] = s[k + 14] + (s[k + 2] * c.x + s[k + 6] * c.y + s[k + 10] * c.z) * h;
      a[k + 15] = s[k + 15];
    }
    o.instanceMatrix.needsUpdate = true;
    x.ver = o.instanceMatrix.version;
  }
  // ---- STREAM REVEALS: a module that finishes streaming in while the player looks (the warm-up, the
  // plane) used to appear in one frame — first the meshes whose materials were already compiled (when its build gate
  // opened), then the rest when its fresh programs were ready. main.ts hands both sets here; they dissolve in.
  private reveals = new Map<THREE.Object3D, number>();
  /** dissolve every drawable below `roots` in over REVEAL_S (only when the dissolve is available; otherwise nothing) */
  reveal(roots: THREE.Object3D[]) {
    if (!DITHER || !this.enabled) return;
    for (const r of roots) r.traverse((o) => {
      const m = o as THREE.Mesh;
      if ((m.isMesh || (o as THREE.Line).isLine || (o as THREE.Points).isPoints) && m.geometry && !(o as THREE.SkinnedMesh).isSkinnedMesh && ditherable(o)) this.reveals.set(o, 0);
    });
  }
  private revealStep(dt: number) {
    for (const [o, f] of this.reveals) { const g = f + dt / REVEAL_S; if (g >= 1 || !o.parent) this.reveals.delete(o); else this.reveals.set(o, g); }
  }
  /** visible fraction of a registered mesh (tools: 1 = full, 0 = cut) */
  fadeOf(o: THREE.Object3D): number { return this.factorOf(o); }
  /** (tools) true while `o` fades by dissolving (engine/dither.ts) — false = a scale fade (a visible shrink / grow) */
  isDithered(o: THREE.Object3D): boolean { return this.dithered.has(o); }
  private byObj = new WeakMap<THREE.Object3D, Item>();

  // ---- (lodv) MODULE VISIBILITY FADES: the POI modules' own LOD /
  // distance switches (jungle-lod distanceSwitch, interiors, hi / lo variants, far chunks …) flip `visible` in one frame.
  // Every object below a POI root gets an accessor on `visible`: the module writes its wish unaware; the renderer
  // reads the SHOWN state — a switch further than VIS_NEAR m from the camera becomes a 0.3 s scale fade of every mesh
  // below it (a hide keeps drawing while it shrinks; a hi / lo swap crossfades), a switch near the player or right
  // after a camera cut is instant (gameplay: doors, chests, pickups). Instanced / skinned meshes and objects behind a
  // scene-hooks gate (far merge, occlusion) keep their own behaviour. Default on (?visfade=0 or ?lodv=0 = off).
  private visFading = new Set<Vis>();
  /** @internal wrapped objects written since the last update (visSet) */
  visPending = new Set<Vis>();
  private cam: THREE.Camera | null = null;
  private frustum = new THREE.Frustum();
  private pv = new THREE.Matrix4();
  private camPrev = new THREE.Vector3(1e9, 0, 0);
  private camCut = 0;
  private visRoots = new WeakSet<THREE.Object3D>();
  private isPoiRoot(root: THREE.Object3D): boolean {
    const kr = (globalThis as unknown as { __kr?: { moduleIds?: () => string[]; moduleRoots?: (id: string) => THREE.Object3D[] } }).__kr;
    if (!kr?.moduleIds || !kr.moduleRoots) return false;
    for (const id of kr.moduleIds()) if (id.startsWith("poi:") && kr.moduleRoots(id).includes(root)) return true;
    return false;
  }
  /** LAZY wrapping: every eligible object below a POI root is a candidate, polled once per update
   *  (a plain read, ~3 k objects ≈ 30 µs); the first time a module's write to `visible` is still there at an update,
   *  the object gets the accessor and that switch already fades. An accessor on all ~3 k POI objects cost +0.6 ms of
   *  render CPU a frame (three reads `visible` per object in the main pass and every shadow pass); only the few objects
   *  modules really switch (LOD groups, interiors, far tiers) carry one now. */
  private visCand = new Map<THREE.Object3D, Array<{ o: THREE.Object3D; last: boolean }>>();
  private wrapVis(root: THREE.Object3D) {
    if (!VIS_FADE || !CULL_LODV) return;
    if (!this.visRoots.has(root)) { if (!this.isPoiRoot(root)) return; this.visRoots.add(root); }
    const list: Array<{ o: THREE.Object3D; last: boolean }> = [];
    // (krDynamic subtrees too: the transform cache marks a whole POI root krDynamic when it releases it for churn —
    // the Murk, whose crowns build lazily — and its near / far crown swap then never faded. A fade scales the live
    // matrixWorld, moving objects are fine; only DetailCull's culling skips them)
    const walk = (o: THREE.Object3D) => {
      if (o.userData.noCull || o.userData.krFar) return;
      if ((o as THREE.Light).isLight || (o as THREE.Camera).isCamera) return;
      // (the root itself too — a module that adds a group straight to the scene and distance-culls it —
      // Peel Harbor's ship / shed interiors at 80 m — switched it in one frame; gated roots stay excluded)
      if (!(o as VisObj)[VIS] && this.visEligible(o)) list.push({ o, last: o.visible });
      for (const c of o.children) walk(c);
    };
    walk(root);
    this.visCand.set(root, list);
  }
  private visEligible(o: THREE.Object3D) {
    const im = o as THREE.InstancedMesh;
    // (an instanced mesh that DISSOLVES fades as one draw — no per-instance matrix rewrite, so no instance
    // limit: Mist Falls' rock-face / river-rock tiers (> 4,096 instances) switched in one frame)
    if ((o as unknown as { __krGates?: unknown }).__krGates || (o as THREE.SkinnedMesh).isSkinnedMesh || (im.isInstancedMesh && im.count > INST_FADE_MAX && !(DITHER && ditherable(o)))) return false;
    const d = Object.getOwnPropertyDescriptor(o, "visible");
    return !!d && "value" in d;
  }
  /** per update: candidates whose `visible` a module changed (and left changed) → wrap them; that switch fades */
  private visPoll() {
    for (const list of this.visCand.values()) {
      for (let i = 0; i < list.length; i++) {
        const c = list[i], now = c.o.visible;
        if (now === c.last) continue;
        list[i] = list[list.length - 1]; list.pop(); i--;
        if ((c.o as VisObj)[VIS] || !c.o.parent || !this.visEligible(c.o)) continue;
        const v: Vis = { o: c.o, want: now, committed: now, shown: c.last, f: c.last ? 1 : 0, dir: 0, meshes: null, b: null, owner: this };
        (c.o as VisObj)[VIS] = v;
        Object.defineProperty(c.o, "visible", { configurable: true, enumerable: true, get: visGet, set: visSet });
        this.visChange(v);
      }
    }
  }
  private unwrapVis(root: THREE.Object3D) {
    this.visCand.delete(root);
    root.traverse((o) => {
      const v = (o as VisObj)[VIS]; if (!v) return;
      this.visFading.delete(v); this.visPending.delete(v);
      Object.defineProperty(o, "visible", { configurable: true, enumerable: true, writable: true, value: v.want });
      delete (o as VisObj)[VIS];
    });
  }
  private visMeshes(v: Vis): THREE.Object3D[] {
    if (!v.meshes) {
      const out: THREE.Object3D[] = [];
      v.o.traverse((o) => { const m = o as THREE.Mesh; if ((m.isMesh || (o as THREE.Line).isLine || (o as THREE.Points).isPoints) && m.geometry && !(o as THREE.SkinnedMesh).isSkinnedMesh) out.push(o); });
      v.meshes = out;
    }
    return v.meshes;
  }
  /** a wrapped object's module changed its `visible` and it is still changed at this update: fade (or switch at once) */
  private visChange(v: Vis) {
    const cam = this.cam;
    // (userData.krInstant: a module's gameplay-driven visibility — a door, a broken pane, a pickup — never fades)
    let instant = !cam || this.camCut > 0 || !this.enabled || !!v.o.userData.krInstant;
    if (!instant) {
      // near = within VIS_NEAR of the object's BOX, not of its bounding sphere: a sphere around a
      // swamp-wide canopy (the Murk's near / far crowns, r ≈ 150 m) made every switch "near" → instant
      // (cached once it has content: a group built lazily — the Murk's far crowns — is measured again until then)
      let b = v.b;
      if (!b) { b = new THREE.Box3().setFromObject(v.o); if (b.isEmpty()) b.setFromCenterAndSize(v.o.getWorldPosition(new THREE.Vector3()), _v.set(0, 0, 0)); else v.b = b; }
      // (with the dissolve, "near" only makes small things instant — a big LOD tile / tier group the camera
      // stands inside (Mist Falls' far cliff-skin cells, 209 instances blinking out at once on the temple route) dissolves)
      instant = b.distanceToPoint(cam!.position) < VIS_NEAR && (!DITHER || b.getSize(_v).length() < 30);
      // a switch nobody can see is instant: a module that hides what is off-screen (Peel Harbor's
      // per-frame frustum cull of its crane / ship / shed groups) used to START a fade-in when the group's box entered
      // the view — turning toward the cranes, they grew in at the screen edge. The box test is the module's own
      // padded box against the current view, so the switch lands before any of it can be on screen
      // (only with a box measured NOW: a cached box of a group that builds lazily or moves — the Murk's crowns — said
      // "off-screen" for crowns in plain view and cut their dissolves short)
      if (OFF_INSTANT && !instant && !b.isEmpty()) {
        const now = _box.setFromObject(v.o);
        if (!now.isEmpty() && !this.frustum.intersectsBox(now)) instant = true;
      }
    }
    if (instant) { v.shown = v.want; v.f = v.want ? 1 : 0; v.dir = 0; this.visFading.delete(v); return; }
    if (v.want) { if (!v.shown) v.f = 0; v.shown = true; v.dir = 1; }
    else { if (!v.shown) return; v.dir = -1; }
    v.meshes = null;
    this.visFading.add(v);
  }
  private visCommit() {
    for (const v of this.visPending) if (v.want !== v.committed) { v.committed = v.want; this.visChange(v); }
    this.visPending.clear();
  }
  private visStep(step: number) {
    for (const v of this.visFading) {
      if (!v.o.parent) { v.shown = v.want; v.f = v.want ? 1 : 0; v.dir = 0; this.visFading.delete(v); continue; }
      v.f = Math.min(1, Math.max(0, v.f + v.dir * step));
      if (v.dir < 0 && v.f <= 0) { v.shown = false; v.dir = 0; this.visFading.delete(v); }
      else if (v.dir > 0 && v.f >= 1) { v.dir = 0; this.visFading.delete(v); }
    }
  }

  /** per frame, before the render */
  private lastT = -1;
  update(cam: THREE.PerspectiveCamera, heightPx: number) {
    if (!this.enabled) return;
    if (CULL_LODV) {
      const t = performance.now() / 1000, dt = this.lastT < 0 ? 1 / 60 : t - this.lastT; this.lastT = t;
      this.updateFade(cam, heightPx, dt); return;
    }
    if (this.stale.size) this.collectSettled();
    this.frame++;
    const tanH = this.tanFor(cam);
    // distance beyond which a sphere of radius 1 projects under minPx: r * H / (2 * px * tanH)
    const kO = heightPx / (2 * this.minPx * tanH), kT = heightPx / (2 * this.minPxT * tanH);
    const px = cam.position.x, py = cam.position.y, pz = cam.position.z;
    const f15 = this.frame & 15, md = this.minDist;
    let n = 0;
    const items = this.items;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      // moved? (static content almost never does: sampled 1/16 per frame)
      if ((i & 15) === f15) {
        const e = it.o.matrixWorld.elements;
        if (e[12] !== it.tx || e[13] !== it.ty || e[14] !== it.tz) this.sphere(it);
      }
      const k = (it.transparent ? kT : kO) * it.r;
      const dx = it.cx - px, dy = it.cy - py, dz = it.cz - pz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (it.culled) {
        const kk = Math.max(k * 0.87 + it.r, md);          // hysteresis: come back 13 % nearer than the cut
        if (d2 < kk * kk) this.uncull(it); else n++;
      } else {
        const kk = Math.max(k + it.r, md + 5);
        if (d2 > kk * kk && it.o.layers.mask !== 0) { it.culled = true; it.mask = it.o.layers.mask; it.o.layers.mask = 0; n++; }
      }
    }
    // empty instanced meshes (a veg / prop batch whose LOD cell holds no instance right now): no draw at all
    const inst = this.inst;
    for (let i = 0; i < inst.length; i++) {
      const x = inst[i];
      if (x.o.count === 0) { if (!x.off && x.o.layers.mask !== 0) { x.off = true; x.mask = x.o.layers.mask; x.o.layers.mask = 0; } }
      else if (x.off) { x.off = false; x.o.layers.mask |= x.mask; }
      if (x.off) n++;
    }
    this.culled = n;
  }

  /** (lodv) the same screen-size rule with scale fades, a wider restore band, a re-entry delay and the big-mesh floor */
  private updateFade(cam: THREE.PerspectiveCamera, heightPx: number, dt: number) {
    if (this.stale.size) this.collectSettled();
    this.frame++;
    const now = (this.time += Math.min(0.1, Math.max(0, dt)));
    // camera cut (respawn, spectate, teleport, a tool jump): module switches during the next 2 frames are instant
    this.cam = cam;
    this.frustum.setFromProjectionMatrix(this.pv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    if (this.camPrev.distanceToSquared(cam.position) > 40 * 40) this.camCut = 2; else if (this.camCut > 0) this.camCut--;
    this.camPrev.copy(cam.position);
    const tanH = this.tanFor(cam);
    const kO = heightPx / (2 * this.minPx * tanH), kT = heightPx / (2 * this.minPxT * tanH);
    const minBig = Math.min(this.minPx, this.bigMaxPx), kB = heightPx / (2 * minBig * tanH), kBT = heightPx / (2 * Math.min(this.minPxT, this.bigMaxPx * 1.5) * tanH);
    const px = cam.position.x, py = cam.position.y, pz = cam.position.z;
    const f15 = this.frame & 15, md = this.minDist, step = dt / FADE_S;
    let n = 0;
    const items = this.items;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if ((i & 15) === f15) {
        const e = it.o.matrixWorld.elements;
        if (e[12] !== it.tx || e[13] !== it.ty || e[14] !== it.tz) this.sphere(it);
      }
      const big = it.r >= BIG_R;
      const k = (it.transparent ? (big ? kBT : kT) : (big ? kB : kO)) * it.r;
      const dx = it.cx - px, dy = it.cy - py, dz = it.cz - pz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (it.culled) {
        // come back 22 % nearer than the cut, and not within 1.5 s of having faded out (unless well inside: 50 %)
        const kk = Math.max(k * 0.78 + it.r, md), kNear = Math.max(k * 0.5 + it.r, md);
        if (d2 < kNear * kNear || (d2 < kk * kk && now - it.outAt > 1.5)) {
          it.culled = false; it.o.layers.mask |= it.mask;
          it.f = 0; it.dir = 1; this.hook(it); this.fading.add(it); this.fades.in++;
        } else n++;
        continue;
      }
      if (it.dir === 0) {
        const kk = Math.max(k + it.r, md + 5);
        if (d2 > kk * kk && it.o.layers.mask !== 0) { it.dir = -1; this.hook(it); this.fading.add(it); this.fades.out++; }
      } else if (it.dir === 1) {
        // fading in but already beyond the cut again: turn round (no pop either way)
        const kk = Math.max(k + it.r, md + 5);
        if (d2 > kk * kk) it.dir = -1;
      }
    }
    for (const it of this.fading) {
      it.f = Math.min(1, Math.max(0, it.f + it.dir * step));
      if (it.dir < 0 && it.f <= 0) {
        it.culled = true; it.mask = it.o.layers.mask; it.o.layers.mask = 0; it.dir = 0; it.outAt = now; this.unhook(it); n++;
      } else if (it.dir > 0 && it.f >= 1) { it.f = 1; it.dir = 0; this.unhook(it); }
    }
    this.visPoll();
    // (candidates are re-listed every 120 frames, right after a poll — nothing switched since is missed: an object that
    // was not eligible when its root was collected — behind a far-merge gate then, the Murk's crowns when the page
    // opened 120 m above Mango — or a root collected before its POI module was listed would otherwise never fade)
    if (VIS_FADE && (this.frame % 120) === 0) for (const r of this.roots) if (r.parent) this.wrapVis(r);
    this.visCommit();
    this.visStep(dt / VIS_FADE_S);
    if (this.reveals.size) this.revealStep(Math.min(0.1, Math.max(0, dt)));
    this.reconcile();
    const inst = this.inst;
    for (let i = 0; i < inst.length; i++) {
      const x = inst[i];
      if (x.o.count === 0) { if (!x.off && x.o.layers.mask !== 0) { x.off = true; x.mask = x.o.layers.mask; x.o.layers.mask = 0; } }
      else if (x.off) { x.off = false; x.o.layers.mask |= x.mask; }
      if (x.off) n++;
    }
    this.culled = n;
  }

  /** re-collect the stale roots that have been quiet for SETTLE frames (a first registration: at once) */
  private collectSettled() {
    for (const r of this.stale) {
      const t = this.touchedAt.get(r);
      if (t !== undefined && this.frame - t < SETTLE && this.frame - (this.staleSince.get(r) ?? this.frame) < 120) continue;
      this.stale.delete(r); this.touchedAt.delete(r); this.staleSince.delete(r);
      this.collect(r);
    }
  }

  /** restore everything (A/B switch) */
  setEnabled(on: boolean) {
    if (!on) {
      for (const it of this.items) if (it.culled || it.dir !== 0) this.uncull(it); for (const x of this.inst) if (x.off) { x.off = false; x.o.layers.mask |= x.mask; }
      for (const v of this.visPending) v.committed = v.want;
      this.visPending.clear();
      for (const v of this.visFading) { v.shown = v.want; v.f = v.want ? 1 : 0; v.dir = 0; }
      this.visFading.clear(); this.reconcile();
    }
    this.enabled = on;
    if (on) for (const r of this.roots) this.stale.add(r);
  }

  /** the layer mask `o` draws with when nothing is cut: its own, or the one saved while this cull has it cut (mask 0).
   *  The far merge groups and masks its proxies by it — a source cut when its POI's proxy was built gave the proxy a zero
   *  mask, and the proxy never drew while it gated the source off: the mesh was missing from the switch distance out to
   *  its own cut distance */
  layersOf(o: THREE.Object3D): number { const it = this.byObj.get(o); return it?.culled ? it.mask : o.layers.mask; }

  info() { return { roots: this.roots.length, items: this.items.length, culled: this.culled, released: this.released, minPx: this.minPx, minPxT: this.minPxT, bigMaxPx: this.bigMaxPx }; }
}
