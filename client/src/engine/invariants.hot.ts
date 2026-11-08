// "A location is never invisible": the per-frame scan behind ?invariants (engine/invariants.ts installs it after the
// cull update, right before the draw, so it reads exactly the state that renders). A POI is drawn by its built model, a
// far impostor (?farimp), an HLOD proxy (engine/hlod.ts) or its module's own far proxy (a root tagged userData.farForm,
// shown while its near model is hidden: the coast kit's CoastLod). Each counts with what is left of it after the cull's fades
// and reveals and the dither's dissolve (engine/cull.ts, engine/dither.ts); the model counts with its most opaque drawn
// mesh that writes colour, and each piece counts only when it is on the camera's layers and in its frustum, as the
// renderer culls it. The POI's coverage is their sum, capped at 1: a hand-over dissolves one out with the complementary mask of the
// one dissolving in, so the two cover min(1, a + b) of its pixels. Once a POI has been drawn at w.floor or more, it must
// stay there for as long as it is in view and has something to draw it with. An impostor that hid as the model's dissolve
// began, or roots that switched in one frame, were found by people watching GPU screenshots; this makes that class of
// hand-over gap a check a software renderer can run. A POI the terrain occludes (engine/occlusion.ts) is not checked; one with nothing
// to draw it (lowmem without ?farimp, before its build) starts over. Allocates nothing.
import * as THREE from "three";
import type { DetailCull } from "./cull";
import type { FarPoi } from "./hlod";

/** the POIs watched and what draws each one, kept current by engine/invariants.ts */
export interface PoiWatch {
  /** module ids, "poi:<id>" */
  ids: string[];
  /** view sphere per POI: centre and radius (m) */
  cx: Float64Array; cy: Float64Array; cz: Float64Array; cr: Float64Array;
  /** the model's scene roots (empty while it is not built) */
  roots: THREE.Object3D[][];
  /** the far impostor mesh, null without one */
  impostors: Array<THREE.Object3D | null>;
  /** last scan, per POI: best opacity of the model's meshes, the impostor (-1 = none) and the proxies (-1 = none) */
  near: Float32Array; imp: Float32Array; hlod: Float32Array;
  /** camera distance (m) at the last scan */
  dist: Float32Array;
  /** frame the current violation began, -1 = none */
  since: Float64Array;
  /** frames each POI was in view with something to draw it */
  seen: Float64Array;
  /** frames each POI was drawn at the floor or more by its far forms alone: impostor, HLOD proxies, its module's far proxy */
  farSeen: Float64Array;
  /** at the last gap check, what would be in view were it shown: 1 the impostor, 2 an HLOD proxy, 4 a model mesh */
  inView: Uint8Array;
  /** 1 once a POI has been drawn at the floor or more since it last had nothing to draw it */
  shownOnce: Uint8Array;
  /** lowest coverage during the current violation */
  low: Float32Array;
  /** coverage a POI must keep, once drawn */
  floor: number;
  isBuilt(id: string): boolean;
  onBad(i: number, frame: number): void;
  onGood(i: number, frame: number): void;
}

type Dithered = THREE.Object3D & { __krDith?: { a: number } };

const view = new THREE.Frustum(), viewProj = new THREE.Matrix4(), sphere = new THREE.Sphere();
const stack: THREE.Object3D[] = [], one: THREE.Object3D[] = [];

function shown(o: THREE.Object3D, scene: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) {
    if (!p.visible) return false;
    if (p === scene) return true;
  }
  return false;
}

/** what is left of `o` after the cull's fades and reveals and the dither's dissolve: 1 = all of it, 0 = nothing */
function opacity(o: THREE.Object3D, cull: DetailCull): number {
  const f = cull.fadeOf(o), d = (o as Dithered).__krDith;
  return d ? Math.min(f, 1 - d.a) : f;
}

/** a material that puts colour on screen: shadow, depth and occluder proxies (colorWrite false) cover nothing;
 *  `hidden` also takes a material that is switched off */
function paints(m: THREE.Material | THREE.Material[], hidden: boolean): boolean {
  if (!Array.isArray(m)) return (hidden || m.visible) && m.colorWrite;
  for (let i = 0; i < m.length; i++) if (m[i] && (hidden || m[i].visible) && m[i].colorWrite) return true;
  return false;
}

/** whether the renderer would draw `o` for this camera: on one of its layers and, unless it opts out of frustum culling,
 *  with its bounds in the view (the same test three.js makes before each draw). `bounds` asks whether `o` shows where
 *  the camera looks: a mesh that opts out of culling draws everywhere (and its instances may move without its cached
 *  bounds following, rows.ts BananaField), so only culled meshes answer it */
function inView(o: THREE.Object3D, mask: number, bounds: boolean): boolean {
  if ((o.layers.mask & mask) === 0) return false;
  if (!(o as THREE.Mesh).geometry || !o.frustumCulled) return !bounds;
  return view.intersectsObject(o);
}

/** an impostor or proxy's share of the POI: what is left of it when it is shown and in view, else 0 */
function standIn(o: THREE.Object3D, scene: THREE.Object3D, mask: number, cull: DetailCull): number {
  const m = (o as THREE.Mesh).material;
  return shown(o, scene) && (!m || paints(m, false)) && inView(o, mask, false) ? opacity(o, cull) : 0;
}

/** the highest opacity among the drawn meshes below `roots` that are in view; stops early once one reaches `enough`.
 *  `hidden`: 1 when any mesh below `roots` would be in view were it shown, whatever hides it now, else 0 */
function nearOpacity(roots: THREE.Object3D[], scene: THREE.Object3D, mask: number, cull: DetailCull, enough: number, hidden: boolean): number {
  let best = 0;
  stack.length = 0;
  for (let i = 0; i < roots.length; i++) if (hidden || shown(roots[i], scene)) stack.push(roots[i]);
  while (stack.length) {
    const o = stack.pop()!;
    if (!hidden && !o.visible) continue;
    const m = o as THREE.Mesh;
    if (m.material && (m.isMesh || (o as THREE.Points).isPoints || (o as THREE.Line).isLine) && paints(m.material, hidden) && inView(o, mask, hidden)) {
      const f = hidden ? 1 : opacity(o, cull);
      if (f > best) best = f;
      if (best >= enough) { stack.length = 0; return best; }
    }
    for (let i = 0; i < o.children.length; i++) stack.push(o.children[i]);
  }
  return best;
}

function proxyOf(far: readonly FarPoi[], id: string): FarPoi | null {
  for (let i = 0; i < far.length; i++) if (far[i].id === id) return far[i];
  return null;
}

/** one frame: check every watched POI against `camera`; calls w.onBad / w.onGood when a POI's state changes */
export function scanPois(w: PoiWatch, camera: THREE.Camera, scene: THREE.Object3D, cull: DetailCull, far: readonly FarPoi[], occluded: readonly string[], frame: number) {
  camera.updateMatrixWorld();
  view.setFromProjectionMatrix(viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  const e = camera.matrixWorld.elements, farM = (camera as THREE.PerspectiveCamera).far ?? Infinity, mask = camera.layers.mask;
  for (let i = 0; i < w.ids.length; i++) {
    const id = w.ids[i], roots = w.roots[i], imp = w.impostors[i], proxy = proxyOf(far, id);
    const built = roots.length > 0 && w.isBuilt(id), merged = proxy !== null && proxy.proxies.length > 0;
    if (!built && imp === null && !merged) { w.shownOnce[i] = 0; end(w, i, frame); continue; }
    const d = Math.hypot(e[12] - w.cx[i], e[14] - w.cz[i]);
    w.dist[i] = d;
    sphere.center.set(w.cx[i], w.cy[i], w.cz[i]);
    sphere.radius = w.cr[i];
    if (d - w.cr[i] >= farM || !view.intersectsSphere(sphere) || occluded.includes(id)) { end(w, i, frame); continue; }
    w.seen[i]++;
    let hl = -1;
    if (merged) {
      hl = 0;
      for (let k = 0; k < proxy.proxies.length; k++) hl = Math.max(hl, standIn(proxy.proxies[k], scene, mask, cull));
    }
    const ip = imp === null ? -1 : standIn(imp, scene, mask, cull);
    const other = Math.max(ip, 0) + Math.max(hl, 0);
    const near = built && other < 1 ? nearOpacity(roots, scene, mask, cull, 1 - other, false) : 0;
    w.near[i] = near; w.imp[i] = ip; w.hlod[i] = hl;
    const cover = Math.min(1, near + other);
    let own = 0;
    if (built) for (let k = 0; k < roots.length; k++) {
      if (!roots[k].userData.farForm || !shown(roots[k], scene)) continue;
      one[0] = roots[k]; one.length = 1;
      own = Math.max(own, nearOpacity(one, scene, mask, cull, 1, false));
    }
    if (other + own >= w.floor) w.farSeen[i]++;
    if (cover >= w.floor) { w.shownOnce[i] = 1; end(w, i, frame); continue; }
    if (!w.shownOnce[i]) continue;
    if (!couldDraw(w, i, built, merged ? proxy : null, scene, mask, cull)) { end(w, i, frame); continue; }
    if (w.since[i] < 0) { w.since[i] = frame; w.low[i] = cover; w.onBad(i, frame); }
    else if (cover < w.low[i]) w.low[i] = cover;
  }
}

/** whether anything that stands for POI `i` would be in view were it shown: when nothing would, the camera only grazes
 *  the POI's view sphere and an empty frame is no gap */
function couldDraw(w: PoiWatch, i: number, built: boolean, proxy: FarPoi | null, scene: THREE.Object3D, mask: number, cull: DetailCull): boolean {
  const imp = w.impostors[i];
  let parts = 0;
  if (imp !== null && inView(imp, mask, true)) parts |= 1;
  if (proxy) for (let k = 0; k < proxy.proxies.length; k++) if (inView(proxy.proxies[k], mask, true)) { parts |= 2; break; }
  if (built && nearOpacity(w.roots[i], scene, mask, cull, 1, true) > 0) parts |= 4;
  w.inView[i] = parts;
  return parts !== 0;
}

function end(w: PoiWatch, i: number, frame: number) {
  if (w.since[i] < 0) return;
  w.onGood(i, frame);
  w.since[i] = -1;
}
