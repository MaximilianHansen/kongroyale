// FAR MERGE — engine HLOD for distant POIs.
// A live-match profile showed the main pass CPU-bound at ~12 µs per draw, and ~2/3 of the draws at a
// typical eye-level spot coming from POIs 400-800 m away (ripe-peak alone: 108 draws seen from the plantation). Each
// registered POI gets, built in idle time, a LOSSLESS proxy: every small static mesh the POI shows at that moment
// (its far state) whose material is "plain" (a built-in lit/unlit material with no custom shader code other than the
// atmos patch) is baked to world space and merged per material → one draw per material instead of one per mesh.
// Beyond the POI's far distance the proxy draws and the merged sources are gated off; nearer, the POI renders as its
// module built it. Same triangles, same materials, same programs → no visual pop and no shader compile at the switch.
//   • what never merges: instanced / skinned / batched meshes, points / lines, transparent or custom-shader materials,
//     meshes > 40 k triangles (already one draw), meshes whose world matrix changed since the POI was registered
//     (animated), userData.krDynamic /
//     userData.noMerge subtrees, multi-material meshes, morph targets. Those keep drawing as the module drew them.
//   • the POI module's own visibility is respected: sources are gated through an accessor on `visible` that ANDs the
//     module's value with the gate (modules keep toggling `visible` unaware), and the proxy only draws while every
//     POI root is visible.
//   • ?nohlod disables it (A/B); it is off in ?shot captures (view-camera stills stay module-exact).
import * as THREE from "three";
import type { Engine } from "./engine";
import { gate as gateVisible, type Gate } from "./scene-hooks";
import { programMergeSafe, releaseShaderRecorder } from "./shader-src";
import { DITHER, clearDither, setDither } from "./dither";
import { flag } from "../flags";

interface FarPoi {
  id: string;
  roots: THREE.Object3D[];
  cx: number; cy: number; cz: number;
  near: number;                   // gate off below this distance (m), on beyond near + HYST
  gate: Gate;
  proxies: THREE.Mesh[];
  sources: THREE.Object3D[];
  state: "wait" | "preparing" | "compiling" | "built" | "none";
  readyAt: number;                // frame after which the proxy may be built (module LOD state settled)
  /** ms = main-thread time of the (time-sliced) preparation; elapsedMs = wall time across its slices */
  stats?: { sources: number; proxies: number; tris: number; ms: number; elapsedMs?: number; maxSliceMs?: number; yields?: number };
  /** true when the mesh's world matrix changed since registration (animated: never merged) */
  moved(o: THREE.Object3D): boolean;
  /** snapshot meshes that appeared since registration; true if there were any (the build then waits 90 frames) */
  late(): boolean;
  tries: number;
}

/** the proxy preparation (scene walk + merge) runs in slices of ~this many ms, one per frame (a far POI's merge in one
 *  go took 82 ms); merge loops yield every PREPARE_CHUNK vertices / indices */
const PREPARE_SLICE_MS = 3;
const PREPARE_CHUNK = 512;
const HYST = 25;
/** ?lodv=1: a source the engine's DetailCull would already have cut at the proxy's switch distance
 * is NOT merged (it keeps its own cut / fade) — a merged proxy brought every sub-pixel prop of a far POI back at once */
const HLOD_LODV = flag("lodv");
const MAX_TRIS = 40000;
/** instanced sources with at most this many instances expand into the proxy (ripe-peak draws 86 one-instance chunks) */
const MAX_INSTANCES = 64;
const PLAIN_TYPES = new Set(["MeshStandardMaterial", "MeshPhysicalMaterial", "MeshLambertMaterial", "MeshPhongMaterial", "MeshBasicMaterial", "MeshToonMaterial", "MeshMatcapMaterial"]);
const PROTO_HOOK = String(THREE.Material.prototype.onBeforeCompile);
const PROTO_KEY = THREE.Material.prototype.customProgramCacheKey;

/** a material whose program renders world-space geometry exactly like the object-space original (shader-src.ts) */
function mergeableMaterial(renderer: THREE.WebGLRenderer, m: THREE.Material): boolean {
  if (!PLAIN_TYPES.has(m.type) || m.userData?.noMerge) return false;
  // transparent: only built-in shading (+ the atmos patch) — the proxy then sits at the POI centre so three's
  // back-to-front sort places it where the POI is (triangle order inside one far POI does not read at ≥ 240 m)
  if (m.transparent) return plainShading(m);
  if (plainShading(m)) return true;
  // custom shader code: decided on the compiled vertex source
  return programMergeSafe(renderer, m);
}
/** built-in material shading, optionally with the atmos patch (world position via modelMatrix: translation-safe) */
function plainShading(m: THREE.Material): boolean {
  if (m.onBeforeCompile === THREE.Material.prototype.onBeforeCompile && m.customProgramCacheKey === PROTO_KEY) return true;
  // the atmos patch alone keys its program by the previous hook's source: "<proto hook source>|atmosN"
  if (m.defines && (m.defines as Record<string, unknown>).ATMOS) {
    let key = "";
    try { key = m.customProgramCacheKey(); } catch { return false; }
    if (key.startsWith(PROTO_HOOK) && /^\|atmos\d+$/.test(key.slice(PROTO_HOOK.length))) return true;
  }
  return false;
}

function attrSig(g: THREE.BufferGeometry): string {
  const parts: string[] = [];
  for (const name of Object.keys(g.attributes).sort()) {
    const a = g.attributes[name] as THREE.BufferAttribute;
    if ((a as unknown as { isInterleavedBufferAttribute?: boolean }).isInterleavedBufferAttribute) return "";
    parts.push(`${name}:${a.itemSize}:${a.normalized ? 1 : 0}:${(a.array as unknown as { constructor: { name: string } }).constructor.name}`);
  }
  return parts.join(",") + (g.index ? "|i" : "|n");
}

const _m3 = new THREE.Matrix3();
const _v = new THREE.Vector3();

export class FarMerge {
  private pois: FarPoi[] = [];
  private group = new THREE.Group();
  private building = false;
  /** diagnostics (__kr.engine.far.info()) */
  constructor(private engine: Engine, readonly enabled: boolean) {
    this.group.name = "far-merge";
    this.group.userData.krDynamic = true;
  }

  /** register a POI (module roots + centre). `near` = distance (m) inside which the POI renders as built. */
  register(id: string, roots: THREE.Object3D[], centre: { x: number; y: number; z: number }, near: number) {
    if (!this.enabled || !roots.length) return;
    if (!this.group.parent) this.engine.scene.add(this.group);
    // world-matrix snapshot of every mesh now; compared when the proxy is built (≥ 90 frames later): whatever moved
    // in between is animated and keeps drawing on its own
    const snap = new WeakMap<THREE.Object3D, Float32Array>();
    for (const r of roots) { r.updateMatrixWorld(true); r.traverse((o) => { if ((o as THREE.Mesh).isMesh) snap.set(o, Float32Array.from(o.matrixWorld.elements)); }); }
    const moved = (o: THREE.Object3D) => {
      const a = snap.get(o); if (!a) return true;
      const e = o.matrixWorld.elements;
      for (let i = 0; i < 16; i++) if (Math.abs(e[i] - a[i]) > 1e-4 * (1 + Math.abs(a[i]))) return true;
      return false;
    };
    /** meshes that appeared after registration (async loads, LOD builds): snapshot them now → true if any was new */
    const late = () => {
      let n = 0;
      for (const r of roots) r.traverse((o) => { if ((o as THREE.Mesh).isMesh && !snap.has(o)) { snap.set(o, Float32Array.from(o.matrixWorld.elements)); n++; } });
      return n > 0;
    };
    this.pois.push({ id, roots, cx: centre.x, cy: centre.y, cz: centre.z, near, gate: { active: false }, proxies: [], sources: [], state: "wait", readyAt: this.engine.frames + 90, moved, late, tries: 0 });
  }

  /** diagnostics: why a POI's visible meshes did / did not merge (reason → count) */
  explain(id: string): Record<string, number> {
    const p = this.pois.find((q) => q.id === id); if (!p) return {};
    const out: Record<string, number> = {}; const bump = (k: string) => { out[k] = (out[k] ?? 0) + 1; };
    const walk = (o: THREE.Object3D) => {
      if (!o.visible) { bump("hidden-subtree"); return; }
      const m = o as THREE.Mesh, im = o as THREE.InstancedMesh;
      if (m.isMesh) {
        const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.Material;
        if ((o as THREE.SkinnedMesh).isSkinnedMesh) bump("skinned");
        else if ((o as unknown as { isBatchedMesh?: boolean }).isBatchedMesh) bump("batched");
        else if (Array.isArray(m.material)) bump("multi-material");
        else if (!o.frustumCulled) bump("frustumCulled=false");
        else if (im.isInstancedMesh && (im.count > MAX_INSTANCES || im.instanceColor)) bump(`instanced(n=${im.count > MAX_INSTANCES ? ">" + MAX_INSTANCES : im.count},color=${!!im.instanceColor})`);
        else if (p.moved(o)) bump("moved/late");
        else if (!PLAIN_TYPES.has(mat.type)) bump("type:" + mat.type + (mat.transparent ? "/T" : ""));
        else if (mat.transparent && !mergeableMaterial(this.engine.renderer, mat)) bump("transparent-custom:" + (mat.name || "?").slice(0, 24));
        else if (!mergeableMaterial(this.engine.renderer, mat)) bump("custom-shader:" + (mat.name || "?").slice(0, 24));
        else bump("mergeable");
      }
      for (const ch of o.children) walk(ch);
    };
    for (const r of p.roots) walk(r);
    return out;
  }

  info() { return this.pois.map((p) => ({ id: p.id, state: p.state, active: p.gate.active, near: p.near, ...(p.stats ?? {}) })); }

  /** build the next pending proxy (one per call; the boot calls it from idle frames) → true when none is left */
  buildNext(): boolean {
    if (!this.enabled) return true;
    if (this.building) return false;
    if (!this.pois.some((q) => q.state === "wait")) { if (!this.engine.streaming) releaseShaderRecorder(); return true; }
    // capture a POI's FAR state only: the camera beyond its near distance, every POI root drawn (a module that hides
    // its POI at that distance is retried later), and every mesh observed static for ≥ 90 frames
    const c = this.engine.camera.position, f = this.engine.frames;
    const p = this.pois.find((q) => q.state === "wait" && f >= q.readyAt && Math.hypot(c.x - q.cx, c.y - q.cy, c.z - q.cz) > q.near + HYST * 2
      && q.roots.every((r) => r.visible && r.parent));
    if (!p) return false;
    if (p.late()) { p.readyAt = f + 90; return false; }
    this.prepare(p);
    if (this.building || this.pois.some((q) => q.state === "wait")) return false;
    if (!this.engine.streaming) releaseShaderRecorder();
    return true;
  }

  /** run build(p) in ~PREPARE_SLICE_MS slices, one per frame (buildNext starts nothing else meanwhile) */
  private prepare(p: FarPoi) {
    this.building = true;
    p.state = "preparing";
    const started = performance.now(), work = this.build(p);
    let cpuMs = 0, maxSliceMs = 0, yields = 0;
    const pump = () => {
      const start = performance.now();
      let finished = false;
      try {
        do { finished = !!work.next().done; }
        while (!finished && performance.now() - start < PREPARE_SLICE_MS);
      } catch (e) {
        console.warn("[far-merge] prepare", e);
        // (no source is gated before the compile finishes: dropping this POI's proxies leaves it drawing as built)
        for (const o of [...this.group.children]) if (o.userData.krFar === p.id) { o.removeFromParent(); (o as THREE.Mesh).geometry.dispose(); }
        p.state = "none"; finished = true;
      }
      const ms = performance.now() - start;
      cpuMs += ms; maxSliceMs = Math.max(maxSliceMs, ms);
      if (finished) {
        this.building = false;
        if (p.stats) Object.assign(p.stats, { ms: Math.round(cpuMs), elapsedMs: Math.round(performance.now() - started), maxSliceMs: +maxSliceMs.toFixed(1), yields });
      } else {
        yields++;
        // a task boundary (input, rendering and the module updates run in between; microtasks would not let them)
        if (typeof requestAnimationFrame === "function") requestAnimationFrame(pump);
        else setTimeout(pump, 0);
      }
    };
    pump();
  }

  private *build(p: FarPoi): Generator<void> {
    // the POI's far state: effectively visible meshes right now (instanced meshes with few instances expand)
    const groups = new Map<string, THREE.Mesh[]>();
    const walk = function* (this: FarMerge, o: THREE.Object3D): Generator<void> {
      if (!o.visible || o.userData.krDynamic || o.userData.noMerge) return;
      // this node only (its parent was just updated): a recursive root update would run the whole POI in one slice
      o.updateWorldMatrix(false, false);
      const m = o as THREE.Mesh, im = o as THREE.InstancedMesh;
      if (m.isMesh && !(o as THREE.SkinnedMesh).isSkinnedMesh && !(o as unknown as { isBatchedMesh?: boolean }).isBatchedMesh
        && !Array.isArray(m.material) && m.geometry && !m.geometry.morphAttributes.position && o.frustumCulled
        && (!im.isInstancedMesh || (im.count > 0 && im.count <= MAX_INSTANCES && !im.instanceColor && !im.morphTexture))
        && o.onBeforeRender === THREE.Object3D.prototype.onBeforeRender && !p.moved(o)) {
        const g = m.geometry, mat = m.material as THREE.Material;
        const tris = (g.index ? g.index.count : g.attributes.position?.count ?? 0) / 3 * (im.isInstancedMesh ? im.count : 1);
        if (tris > 0 && tris <= MAX_TRIS && g.attributes.position && mergeableMaterial(this.engine.renderer, mat)) {
          const sig = attrSig(g);
          if (sig) {
            // (the layers it draws with when uncut: a source the detail cull had cut right now would give its whole
            // group a zero-mask proxy that never draws while the switch hides the source — cull.ts layersOf)
            const key = `${mat.uuid}|${sig}|${o.castShadow ? 1 : 0}${o.receiveShadow ? 1 : 0}|${this.engine.cull.layersOf(o)}|${o.renderOrder}`;
            let arr = groups.get(key); if (!arr) groups.set(key, (arr = []));
            arr.push(m);
          }
        }
      }
      yield;
      for (const c of o.children) yield* walk.call(this, c);
    };
    for (const r of p.roots) { r.updateWorldMatrix(true, false); yield* walk.call(this, r); }
    if (HLOD_LODV) {
      // the smallest bounding radius DetailCull keeps at the switch distance (current view-distance setting, canvas, fov)
      const cam = this.engine.camera, cull = this.engine.cull, hpx = this.engine.renderer.domElement.height || 1440;
      const tanH = cull.tanFor(cam), dSw = p.near + HYST;
      const rMin = cull.enabled ? (dSw * 2 * cull.minPx * tanH) / hpx : 0;
      if (rMin > 0) for (const [key, arr] of groups) {
        const keep: THREE.Mesh[] = [];
        for (const m of arr) {
          const g = m.geometry; if (!g.boundingSphere) g.computeBoundingSphere(); const e = m.matrixWorld.elements; const sc = Math.sqrt(Math.max(e[0] * e[0] + e[1] * e[1] + e[2] * e[2], e[4] * e[4] + e[5] * e[5] + e[6] * e[6], e[8] * e[8] + e[9] * e[9] + e[10] * e[10]));
          if ((m as THREE.InstancedMesh).isInstancedMesh || (g.boundingSphere?.radius ?? 0) * sc >= rMin) keep.push(m);
          yield;
        }
        if (keep.length !== arr.length) groups.set(key, keep);
      }
    }
    let tris = 0, nsrc = 0;
    const made: Array<[THREE.Mesh, THREE.Mesh[]]> = [];
    for (const [, meshes] of groups) {
      // one draw → one draw: only merge where it saves draws (an instanced source with n > 1 is one draw already)
      if (meshes.length < 2) continue;
      // (the source's state as grouped — read before the merge, which yields)
      const src = meshes[0], mat = src.material as THREE.Material, name = `far:${p.id}:${mat.name || src.name}`;
      const cast = src.castShadow, receive = src.receiveShadow, mask = this.engine.cull.layersOf(src), order = src.renderOrder;
      // transparent proxies live at the POI centre (vertices relative to it): three sorts transparent draws by the
      // object origin, and the world origin would put a far POI's glass in front of / behind the wrong things
      const origin = mat.transparent ? new THREE.Vector3(p.cx, p.cy, p.cz) : null;
      const geo = yield* mergeWorld(meshes, origin);
      if (!geo) continue;
      const proxy = new THREE.Mesh(geo, mat);
      if (origin) proxy.position.copy(origin);
      proxy.name = name;
      proxy.castShadow = cast; proxy.receiveShadow = receive;
      proxy.layers.mask = mask; proxy.renderOrder = order;
      proxy.userData.castShadow = cast; proxy.userData.receiveShadow = receive; proxy.userData.krFar = p.id;
      proxy.updateMatrix(); proxy.matrixAutoUpdate = false; proxy.updateMatrixWorld(true);
      proxy.visible = false;
      this.group.add(proxy);
      made.push([proxy, meshes]);
      tris += (geo.index ? geo.index.count : geo.attributes.position.count) / 3; nsrc += meshes.length;
    }
    p.stats = { sources: nsrc, proxies: made.length, tris: Math.round(tris), ms: 0 };   // (ms: prepare() fills it in)
    if (!made.length) {
      // nothing mergeable in this far state: try again later (another LOD state), a few times
      if (++p.tries < 3) { p.state = "wait"; p.readyAt = this.engine.frames + 600; } else p.state = "none";
      return;
    }
    // the proxies' program variant (non-instanced, for instanced sources) compiles in parallel BEFORE the switch can
    // happen: never a synchronous compile on the frame a POI goes far
    p.state = "compiling";
    const list = made.map(([x]) => x);
    const fake = { traverse(fn: (o: THREE.Object3D) => void) { for (const o of list) fn(o); }, traverseVisible() { /* lights: from the scene */ } } as unknown as THREE.Object3D;
    const r = this.engine.renderer;
    const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType });
    const prev = r.getRenderTarget();
    let done: Promise<unknown> = Promise.resolve();
    r.setRenderTarget(rt);
    try { done = r.compileAsync(fake, this.engine.camera, this.engine.scene); } catch (e) { console.warn("[far-merge] compile", e); }
    r.setRenderTarget(prev);
    done.catch(() => undefined).then(() => {
      rt.dispose();
      // first draw offscreen now (vertex buffers / VAOs of the merged geometry): the frame a POI first goes far never
      // uploads megabytes of merged vertices (a landing / teleport hitch otherwise)
      try { this.engine.warmDraw(list); } catch (e) { console.warn("[far-merge] warm", e); }
      for (const [proxy, meshes] of made) { p.proxies.push(proxy); for (const m of meshes) { gateVisible(m, p.gate); p.sources.push(m); } }
      p.state = "built";
    });
  }

  /** runtime A/B switch (tools) */
  active = true;
  /** per frame: switch each POI between as-built (near) and its proxy (far) */
  update() {
    if (!this.enabled || !this.pois.length) return;
    if (!this.active) { for (const p of this.pois) if (p.gate.active) { p.gate.active = false; for (const x of p.proxies) x.visible = false; } return; }
    const c = this.engine.camera.position;
    for (const p of this.pois) {
      if (p.state !== "built") continue;
      const d = Math.hypot(c.x - p.cx, c.y - p.cy, c.z - p.cz);
      const want = p.gate.active ? d > p.near : d > p.near + HYST;
      // the module's own POI-level culling wins: no proxy while any POI root is hidden
      let rootsVisible = true;
      for (const r of p.roots) if (!r.visible || !r.parent) { rootsVisible = false; break; }
      const active = want && rootsVisible;
      if (active !== p.gate.active) {
        p.gate.active = active;
        // approaching a POI: its as-built sources dissolve in (engine/cull.ts reveal) while the proxy
        // dissolves out — the proxy holds the POI's FAR state, the module may already show nearer tiers (Mist Falls'
        // far cliff-skin cells: 209 instances blinking out at once on the temple route)
        if (!active && DITHER && rootsVisible) {
          this.engine.cull.reveal(p.sources);
          const t0 = performance.now();
          for (const x of p.proxies) { this.outgoing.set(x, t0); setDither(x, 0); }
        } else for (const x of p.proxies) { this.outgoing.delete(x); clearDither(x); x.visible = active; }
      }
    }
    if (this.outgoing.size) {
      const now = performance.now();
      for (const [x, t0] of this.outgoing) {
        const a = (now - t0) / 500;
        if (a >= 1) { this.outgoing.delete(x); clearDither(x); x.visible = false; } else setDither(x, a);
      }
    }
  }
  /** proxies dissolving out after their POI switched to as-built (mesh → start ms) */
  private outgoing = new Map<THREE.Object3D, number>();
}

/** merge meshes (same material + attribute layout) into one world-space geometry; instanced meshes expand per instance.
 *  A generator (FarMerge.prepare runs it in time slices): yields every PREPARE_CHUNK vertices / indices. */
function* mergeWorld(meshes: THREE.Mesh[], origin: THREE.Vector3 | null = null): Generator<void, THREE.BufferGeometry | null> {
  // one "part" per drawn copy: (attributes, index, world matrix) — identities and matrices frozen before the first
  // yield, so a module update between slices cannot mix two states into one bake
  const parts: Array<{ attributes: THREE.BufferGeometry["attributes"]; index: THREE.BufferAttribute | null; mw: THREE.Matrix4 }> = [];
  for (const m of meshes) {
    const im = m as THREE.InstancedMesh;
    if (im.isInstancedMesh) {
      for (let i = 0; i < im.count; i++) { const t = new THREE.Matrix4(); im.getMatrixAt(i, t); parts.push({ attributes: { ...m.geometry.attributes }, index: m.geometry.index, mw: t.premultiply(m.matrixWorld) }); }
    } else parts.push({ attributes: { ...m.geometry.attributes }, index: m.geometry.index, mw: m.matrixWorld.clone() });
  }
  const g0 = parts[0];
  const names = Object.keys(g0.attributes);
  let nv = 0, ni = 0;
  for (const p of parts) { nv += p.attributes.position.count; if (p.index) ni += p.index.count; }
  const indexed = !!g0.index;
  const out = new THREE.BufferGeometry();
  for (const name of names) {
    const a0 = g0.attributes[name] as THREE.BufferAttribute;
    const Ctor = (a0.array as unknown as { constructor: new (n: number) => THREE.TypedArray }).constructor;
    const arr = new Ctor(nv * a0.itemSize);
    let off = 0;
    for (const p of parts) {
      const a = p.attributes[name] as THREE.BufferAttribute;
      const src = a.array as THREE.TypedArray;
      const n = a.count * a.itemSize;
      for (let i = 0; i < n; i += PREPARE_CHUNK) {
        (arr as THREE.TypedArray).set(src.subarray(i, Math.min(i + PREPARE_CHUNK, n)) as never, off + i);
        yield;
      }
      off += n;
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, a0.itemSize, a0.normalized));
  }
  // bake transforms: position (point), normal (normal matrix), tangent (xyz by the upper 3x3, w flips on mirror)
  const pos = out.attributes.position as THREE.BufferAttribute, nor = out.attributes.normal as THREE.BufferAttribute | undefined, tan = out.attributes.tangent as THREE.BufferAttribute | undefined;
  if (pos.itemSize !== 3 || (pos.array as unknown as { BYTES_PER_ELEMENT: number }).BYTES_PER_ELEMENT !== 4 || pos.normalized) return null;
  const idx = indexed ? new Uint32Array(ni) : null;
  let vOff = 0, iOff = 0;
  for (const p of parts) {
    const n = p.attributes.position.count;
    const mw = p.mw;
    const mirror = mw.determinant() < 0;
    for (let i = vOff; i < vOff + n; i++) { _v.fromBufferAttribute(pos, i).applyMatrix4(mw); if (origin) _v.sub(origin); pos.setXYZ(i, _v.x, _v.y, _v.z); if ((i - vOff + 1) % PREPARE_CHUNK === 0) yield; }
    if (nor && nor.itemSize === 3) {
      _m3.getNormalMatrix(mw);
      for (let i = vOff; i < vOff + n; i++) { _v.fromBufferAttribute(nor, i).applyMatrix3(_m3).normalize(); nor.setXYZ(i, _v.x, _v.y, _v.z); if ((i - vOff + 1) % PREPARE_CHUNK === 0) yield; }
    }
    if (tan && tan.itemSize === 4) {
      _m3.setFromMatrix4(mw);
      for (let i = vOff; i < vOff + n; i++) { _v.set(tan.getX(i), tan.getY(i), tan.getZ(i)).applyMatrix3(_m3).normalize(); tan.setXYZW(i, _v.x, _v.y, _v.z, tan.getW(i) * (mirror ? -1 : 1)); if ((i - vOff + 1) % PREPARE_CHUNK === 0) yield; }
    }
    if (idx) {
      const src = p.index!;
      const c = src.count;
      for (let k = 0; k < c; k += 3) {
        const a = src.getX(k) + vOff, b = src.getX(k + 1) + vOff, d = src.getX(k + 2) + vOff;
        idx[iOff + k] = a; idx[iOff + k + 1] = mirror ? d : b; idx[iOff + k + 2] = mirror ? b : d;
        if (k % (PREPARE_CHUNK * 3) === 0) yield;
      }
      iOff += c;
    } else if (mirror) {
      // non-indexed + mirrored: swap the 2nd and 3rd vertex of every triangle in every attribute
      for (const name of names) {
        const a = out.attributes[name] as THREE.BufferAttribute, s = a.itemSize, arr = a.array as THREE.TypedArray;
        for (let t = vOff; t + 2 < vOff + n; t += 3) { for (let k = 0; k < s; k++) { const i1 = (t + 1) * s + k, i2 = (t + 2) * s + k; const tmp = arr[i1]; arr[i1] = arr[i2]; arr[i2] = tmp; } if ((t - vOff) % (PREPARE_CHUNK * 3) === 0) yield; }
      }
    }
    vOff += n;
  }
  if (idx) {
    // (the final width allocated once; the 16-bit copy yields too)
    if (nv > 65535) out.setIndex(new THREE.BufferAttribute(idx, 1));
    else {
      const small = new Uint16Array(ni);
      for (let i = 0; i < ni; i += PREPARE_CHUNK) { small.set(idx.subarray(i, i + PREPARE_CHUNK), i); yield; }
      out.setIndex(new THREE.BufferAttribute(small, 1));
    }
  }
  // bounds as computeBoundingBox / computeBoundingSphere make them (box centre, farthest vertex), in slices
  const box = new THREE.Box3();
  for (let i = 0; i < nv; i++) { box.expandByPoint(_v.fromBufferAttribute(pos, i)); if ((i + 1) % PREPARE_CHUNK === 0) yield; }
  const sphere = new THREE.Sphere(); box.getCenter(sphere.center);
  let radiusSq = 0;
  for (let i = 0; i < nv; i++) { radiusSq = Math.max(radiusSq, sphere.center.distanceToSquared(_v.fromBufferAttribute(pos, i))); if ((i + 1) % PREPARE_CHUNK === 0) yield; }
  sphere.radius = Math.sqrt(radiusSq); out.boundingBox = box; out.boundingSphere = sphere;
  return out;
}
