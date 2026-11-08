// Engine core: renderer, scene, camera, frame loop, and the WorldCtx handed to every world module.
// World modules plug in through WorldCtx (post pipeline, shared handles, update hooks, time-slicing, streaming)
// instead of editing this file; keep any engine change small.
import * as THREE from "three";
import { Terrain } from "../../../shared/world/terrain";
import { Assets } from "./assets";
import { FarMerge } from "./hlod";
import { DetailCull } from "./cull";
import { PoiOcclusion } from "./occlusion";
import { StaticCache } from "./static-cache";
import { onStructure, ownVisible, activeGates, type Gate } from "./scene-hooks";
import { installShaderRecorder } from "./shader-src";
import { installDitherChunks } from "./dither";
import { afterPaint } from "./frame";
import { RefreshEstimate, WEBKIT_CEILING_HZ } from "./refresh";
import { flag } from "../flags";
import { contextEpoch, watchContext } from "./res/restore";
import "./geometry-release"; // in boot: the geofree owners in lazy chunks share this copy, fewer bytes than a chunk of its own

const STREAM_SLICE_MS: readonly number[] = flag("streamslice") ?? [];

// engine fades dissolve instead of scaling — three's shared chunks are patched before the first compile
installDitherChunks();

export type Quality = "ultra" | "high" | "medium" | "low";

export interface PostPipeline {
  render(dt: number): void;
  setSize(w: number, h: number): void;
  /** Height in pixels of the main scene target, before any upscaling. */
  getSceneHeight?(): number;
}

export interface WorldCtx {
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  /** the main camera (player / view camera). Modules may read it every frame for LOD, streaming, shadows. */
  camera: THREE.PerspectiveCamera;
  terrain: Terrain;
  assets: Assets;
  quality: Quality;
  /** true while capturing a view-camera still (?shot): animation time is frozen at `time` */
  shotMode: boolean;
  /** cross-module handles, e.g. "sun" (DirectionalLight), "sunDir" (Vector3), "envMap", "water" … document keys you publish */
  shared: Map<string, unknown>;
  /** per-frame hook; dt seconds, t = animation time seconds */
  onUpdate(fn: (dt: number, t: number) => void): void;
  readonly rebuilding: boolean;
  /** replace the final render (post-processing). Default: renderer.render(scene, camera). */
  setPost(p: PostPipeline): void;
  /** Current main-view height for screen-size selection; independent of active offscreen passes. */
  getSceneHeight(): number;
  /** hold the "ready" flag until the returned function is called (async textures, models, shader warmup) */
  hold(label: string): () => void;
  /**
   * TIME-SLICING. `await ctx.yield()` inside any long build loop (per building, per texture row
   * block, per chunk). It returns at once while the current slice is under budget (`ctx.sliceMs`: ≤ 40 ms behind the
   * loading screen, ~6 ms while a module streams in during the title / lobby / warm-up) and otherwise lets a frame
   * render (and the loading bar repaint) first. Cheap enough to call thousands of times per build.
   */
  yield(): Promise<void>;
  /** a task boundary after the next paint, without waiting for a frame the browser isn't painting (engine/frame.ts) */
  afterPaint(): Promise<void>;
  /** the current slice budget in ms (read-only for modules; the boot sets it) */
  readonly sliceMs: number;
  /**
   * MODULE STREAMING. Resolves once world module `id` (registry id, e.g. "poi:mango-market") has
   * built and been integrated (programs compiled, textures uploaded, visible). Ids not in this page (?modules=…)
   * resolve when the stream ends. In ?view / ?cam / ?shot pages every module is built before ready.
   */
  whenBuilt(id: string): Promise<void>;
  /** true once `id` is built (see whenBuilt) */
  isBuilt(id: string): boolean;
  /** true while world modules are still streaming in after the title became ready */
  readonly streaming: boolean;
}

const RESOLVED = Promise.resolve();

export class Engine implements WorldCtx {
  readonly scene = new THREE.Scene();
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  readonly assets: Assets;
  readonly shared = new Map<string, unknown>();
  readonly shotMode: boolean;
  quality: Quality;
  terrain!: Terrain;
  /** animation time; frozen in shot mode unless ?t is advanced by the caller */
  time = 0;
  timeScale = 1;
  readonly updates: Array<(dt: number, t: number) => void> = [];
  private failed = new Set<number>();
  private post: PostPipeline | null = null;
  private holds = new Map<number, string>();
  private holdSeq = 0;
  private last = performance.now();
  /** the newest drawn frames' intervals (ms), a ring indexed by frameCount (res-guard.ts reads it) */
  readonly frameMs = new Float32Array(240);
  /** 1 where module streaming ran in that interval of frameMs (a build or integration slice, engine.yield): its length
   *  is main-thread work between frames, not the frame's own cost (res-guard.ts leaves these out) */
  readonly frameStream = new Uint8Array(240);
  /** module builds and integrations in flight (main.ts); while > 0 every frame interval counts as a stream frame */
  streamJobs = 0;
  private streamTouched = false;
  private frameIdx = 0;
  /** frames drawn so far; frameMs[(frameCount - 1) % frameMs.length] is the newest */
  get frameCount() { return this.frameIdx; }
  frames = 0;
  /** static-transform cache for world-module content (engine/static-cache.ts) */
  readonly statics: StaticCache;
  /** far-POI merge (engine/hlod.ts): lossless per-material merge of a distant POI's small static meshes */
  readonly far: FarMerge;
  /** screen-size culling of world-module meshes (engine/cull.ts) */
  readonly cull: DetailCull;
  /** terrain occlusion of whole POIs (engine/occlusion.ts) */
  readonly occlusion: PoiOcclusion;
  /** time-slicing budget (ms) and the start of the current slice */
  sliceMs = 40;
  private sliceT0 = performance.now();
  /** ?slicelog=N (default 50): main-thread slices of build or stream work over N ms between two yields, newest last */
  readonly sliceLog: Array<{ at: number; ms: number; stage: string; where: string }> = [];
  private readonly sliceLogMs = flag("slicelog");
  /** when the last requestAnimationFrame task ended: build work after it runs in a later task */
  private rafEnd = 0;
  private builtIds = new Set<string>();
  private builtWaiters = new Map<string, Array<() => void>>();
  private streamOpen = false;
  private streamEnded = false;
  private lightListeners: Array<(root: THREE.Object3D) => void> = [];
  /** called with any subtree holding a PointLight that joins the live scene (the game's light balancer tracks it) */
  onPointLight(fn: (root: THREE.Object3D) => void) { this.lightListeners.push(fn); }
  /** per-frame work queued by the boot (streaming integration, idle warm-up); runs after the update hooks */
  private idle: Array<() => boolean | void> = [];

  constructor(readonly canvas: HTMLCanvasElement, opts: { quality: Quality; shotMode: boolean; time: number }) {
    this.quality = opts.quality;
    this.shotMode = opts.shotMode;
    this.time = opts.time;
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: false, powerPreference: "high-performance", stencil: false, preserveDrawingBuffer: opts.shotMode,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    watchContext(this.canvas, this);
    // initTexture runs outside the frame loop (stream integration, the GPU warmer, the title art) and three never stops it
    // on a lost context: a first compressed upload there caches the BPTC/ASTC extensions as missing. It uploads on its
    // first draw after the restore instead.
    const initTexture = this.renderer.initTexture.bind(this.renderer);
    this.renderer.initTexture = (t) => { if (!this.contextLost) initTexture(t); };
    // ?dpr=N overrides the device pixel ratio (A/B of the fill-rate share). The canvas backing store is the
    // screen's NATIVE pixels (devicePixelRatio, e.g. 1.5 on a 150 %-scaled 4K monitor, 2 on a Retina MacBook; capped at
    // 2 for phones); the "3D resolution" setting scales the scene inside the post chain (TAAU), never the canvas
    const dprQ = flag("dpr");
    this.dprBase = opts.shotMode ? 1 : dprQ > 0 ? Math.min(dprQ, 2) : Math.min(devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(this.dprBase);
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.1, 12000);
    this.scene.add(this.camera);
    this.assets = new Assets(this.renderer, (l) => this.hold(l));
    this.statics = new StaticCache(!flag("nofreeze"));
    this.statics.skipHiddenRoots(this.scene);
    this.cheapCameraUpdates();
    this.far = new FarMerge(this, !flag("nohlod") && !opts.shotMode);
    this.cull = new DetailCull(!flag("nocull") && !opts.shotMode);
    { const props = () => this.renderer.properties as unknown as { get(o: object): { programs?: unknown; currentProgram?: unknown } };
      this.cull.compiled = (m) => { const p = props().get(m); return p.programs !== undefined || p.currentProgram !== undefined; }; }
    this.occlusion = new PoiOcclusion(!flag("noocc") && !opts.shotMode, this.scene, () => this.terrain);
    onStructure((parent) => { this.structGen++; this.cull.touched(parent); });
    if (this.far.enabled) installShaderRecorder(this.renderer.getContext() as WebGL2RenderingContext);
    // point lights that join the live scene (a streamed POI's braziers) are reported before the next frame renders, so
    // the game's light balancer keeps the light count — part of every lit program's key — constant (no recompiles)
    onStructure((parent, child, added) => {
      if (!added || !child || !this.lightListeners.length) return;
      let p: THREE.Object3D | null = parent; while (p && p !== this.scene) p = p.parent;
      if (!p) return;
      let found = false;
      child.traverse((o) => { if ((o as THREE.PointLight).isPointLight && !o.userData.krDummy) found = true; });
      if (found) for (const fn of this.lightListeners) fn(child);
    });
    addEventListener("resize", () => this.resize());
    this.resize();
  }

  /**
   * `camera.updateMatrixWorld()` outside the render's scene walk updates the CAMERA only (matrix, matrixWorld,
   * matrixWorldInverse — exactly as three does), not its children. A live-match census counted ~6 000
   * updateMatrixWorld calls per frame inside the camera subtree alone (the first-person viewmodel, ~120 objects,
   * re-walked by every LOD / material hook that refreshes the camera first) — 2/3 of all matrix work in the frame. The
   * children are brought up to date (forced) by the scene walk that precedes every draw; code that needs a
   * camera CHILD's world matrix mid-frame calls `child.updateWorldMatrix(true, false)` / `getWorldPosition` (unchanged).
   */
  private inSceneWalk = false;
  /** runtime A/B switch (tools) for the camera-only update above */
  cheapCam = !flag("fullcam");
  private cheapCameraUpdates() {
    const self = this, cam = this.camera as THREE.PerspectiveCamera & { __krKidsStale?: boolean };
    const camUMW = cam.updateMatrixWorld;
    const NONE: THREE.Object3D[] = [];
    cam.updateMatrixWorld = function (this: typeof cam, force?: boolean) {
      if (self.inSceneWalk || !self.cheapCam || !this.children.length) {
        if (this.__krKidsStale) { this.__krKidsStale = false; force = true; }
        return camUMW.call(this, force);
      }
      const kids = this.children;
      this.children = NONE;
      try { camUMW.call(this, force); } finally { this.children = kids; }
      this.__krKidsStale = true;
    };
    const sceneUMW = this.scene.updateMatrixWorld;
    this.scene.updateMatrixWorld = function (this: THREE.Scene, force?: boolean) {
      const was = self.inSceneWalk; self.inSceneWalk = true;
      try { sceneUMW.call(this, force); } finally { self.inSceneWalk = was; }
    };
  }

  /** ?texprof: every texture upload call (tex(Sub)Image2D/3D, texStorage) with its
   *  size, ms, the boot / stream stage and — for calls over 8 ms — the JS call site. tools: __kr.engine.texProf */
  texProf: Array<{ fn: string; w: number; h: number; d: number; ms: number; stage: string; at: number; site?: string; kind?: string; src?: string }> = [];
  /** the canvas pixel ratio before the 3D-resolution setting (display.ts) */
  dprBase = 1;
  resize() {
    // a monitor change (window dragged to another screen / browser zoom) changes devicePixelRatio: follow it
    const dprQ = flag("dpr");
    if (!this.shotMode && !(dprQ > 0)) {
      const d = Math.min(devicePixelRatio || 1, 2);
      if (d !== this.dprBase) { this.dprBase = d; this.applyPixelRatio(); }
    }
    const w = this.canvas.clientWidth || innerWidth, h = this.canvas.clientHeight || innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.post?.setSize(w, h);
  }

  rebuilding = false;
  onUpdate(fn: (dt: number, t: number) => void) {
    this.updates.push(fn);
    // (hitch attribution: the stage that registered the hook — main.ts sets __kr.stage / streamStage per module build)
    const kr = (globalThis as { __kr?: { stage?: string; streamStage?: string } }).__kr;
    this.updLabels.push(String(kr?.streamStage || kr?.stage || "?"));
  }
  readonly updLabels: string[] = [];

  /** tools set `engine.hitchLog = []` → every frame whose step takes > 30 ms,
   *  or whose interval is > 50 ms, is logged with the costliest update hooks (by registering stage), idle work, render */
  hitchLog: Array<Record<string, unknown>> | null = null;
  /** while hitchLog is on: every frame whose render created programs (live shader compiles), with their names */
  newPrograms: Array<{ at: number; ms: number; stream: string; programs: string[] }> = [];
  setPost(p: PostPipeline) { this.post = p; this.resize(); }
  getSceneHeight() { return this.post?.getSceneHeight?.() ?? this.renderer.domElement.height; }
  hold(label: string) {
    const id = ++this.holdSeq;
    this.holds.set(id, label);
    return () => { this.holds.delete(id); };
  }
  pendingHolds() { return [...this.holds.values()]; }

  // ---- time-slicing
  /** start a fresh slice (the boot calls this before each module build) */
  beginSlice() { this.sliceT0 = performance.now(); }
  /** ms used by the current slice */
  sliceUsed() { return performance.now() - this.sliceT0; }
  /**
   * the island stream's slice budget (ms of build per frame) by where the player is. The title / lobby gets 14 ms (the
   * stream must finish before PRACTICE starts a match), the warm-up 12 ms (running around the islet), the plane /
   * skydive / match 7 ms — it never goes back to back in a live match (that was 300-960 ms frames in the plane).
   * ?streamslice=title,warm,match overrides (A/B).
   */
  streamSlice(inMatch: boolean, phase: number, workLeftMs = 0, warmLeftMs = 0) {
    const o = STREAM_SLICE_MS;
    // (the title gets 14 ms — the island must be complete before a match starts: every ms of stream left at PRACTICE
    // lands in warm-up / plane frames. The title is a menu over the islet: ~45 fps there while it streams.)
    if (!inMatch) return o[0] > 0 ? o[0] : 14;
    if (phase > 0) return o[2] > 0 ? o[2] : 7;
    const base = o[1] > 0 ? o[1] : 12;
    // warm-up: the island must be complete before the plane (a POI popping in under the plane is visible, and a
    // build in the plane hitches). With `workLeftMs` of builds left and `warmLeftMs` of warm-up
    // left, a slice s next to a frame of f ms builds s / (s + f) of the time → raise s to fit, never past 24 ms (+ the
    // frame stays under 33 ms). f = the measured step ms (EMA), ≥ 6.
    const f = Math.max(6, this.stepEma || 10);
    // (the slice and the frame share one rAF interval — slice + frame must stay under ~27 ms or the stream itself
    // makes > 33 ms frames: a 24 ms slice + a 10-12 ms frame is 34-36 ms)
    const cap = Math.max(4, Math.min(24, 27 - f));
    if (workLeftMs > 0 && warmLeftMs > workLeftMs) return Math.min(cap, Math.max(Math.min(base, cap), Math.ceil((f * workLeftMs) / (warmLeftMs - workLeftMs))));
    return workLeftMs > 0 && warmLeftMs > 0 ? cap : Math.min(base, cap);
  }
  yield(): Promise<void> {
    this.streamTouched = true;
    const now = performance.now();
    if (now - this.sliceT0 < this.sliceMs) return RESOLVED;
    if (this.sliceLogMs > 0) this.logSlice(now);
    // let the next frame (or the loading screen) paint, then continue in a fresh task right after it (engine/frame.ts:
    // without waiting for a frame the browser isn't painting)
    return afterPaint().then(() => { this.sliceT0 = performance.now(); });
  }
  /** ?slicelog: the slice this yield ends (the no-op yields before it included; only a yield that gives way ends one),
   *  measured from the slice's start or the end of the last animation frame task, whichever is later: an await that
   *  spans a frame (a worker, a fetch) ends in a later task, so only the work after it counts, and the window can then be
   *  shorter than sliceMs (N is the floor). Before engine.start() no frame marks those tasks, so boot builds are not
   *  logged. "where" is the stack of the yield that ended it */
  private logSlice(now: number) {
    const ms = now - Math.max(this.sliceT0, this.rafEnd);
    if (ms < this.sliceLogMs || !this.started) return;
    const kr = (globalThis as { __kr?: { streamStage?: string; stage?: string } }).__kr;
    const where = (new Error().stack ?? "").split("\n").slice(3, 7).join(" <").slice(0, 400);
    this.sliceLog.push({ at: Math.round(now), ms: Math.round(ms), stage: String(kr?.streamStage || kr?.stage || ""), where });
    if (this.sliceLog.length > 500) this.sliceLog.shift();
  }
  afterPaint() { return afterPaint(); }

  // ---- module streaming
  get streaming() { return this.streamOpen && !this.streamEnded; }
  openStream() { this.streamOpen = true; }
  markBuilt(id: string) {
    this.builtIds.add(id);
    const w = this.builtWaiters.get(id);
    if (w) { this.builtWaiters.delete(id); for (const f of w) f(); }
  }
  endStream() {
    this.streamEnded = true;
    for (const [, w] of this.builtWaiters) for (const f of w) f();
    this.builtWaiters.clear();
  }
  isBuilt(id: string) { return this.builtIds.has(id); }
  whenBuilt(id: string): Promise<void> {
    if (this.builtIds.has(id) || this.streamEnded) return RESOLVED;
    return new Promise<void>((r) => { const w = this.builtWaiters.get(id) ?? []; w.push(r); this.builtWaiters.set(id, w); });
  }
  private audited = new WeakSet<object>();
  /** idle: link status of every program whose (parallel) compile has finished, a few per frame; never returns true
   *  (programs keep appearing). A failed program is reported through `report` with its info log. */
  auditShaders(report: (where: string, e: unknown) => void, busy?: () => boolean): boolean {
    const gl = this.renderer.getContext();
    if (busy?.() || gl.isContextLost()) return false;
    let n = 0;
    for (const p of (this.renderer.info.programs ?? []) as unknown as Array<{ name?: string; program: WebGLProgram; isReady?: () => boolean }>) {
      if (this.audited.has(p)) continue;
      if (p.isReady && !p.isReady()) continue;
      this.audited.add(p);
      if (!gl.getProgramParameter(p.program, gl.LINK_STATUS)) report("shader", `program "${p.name}" failed to link: ${gl.getProgramInfoLog(p.program) ?? ""}`);
      // one per frame: each query is a GPU-process round trip (~1-2 ms)
      if (++n >= 1) break;
    }
    return false;
  }
  /**
   * point-light stand-ins (intensity 0, 5 km below the island), made before the world builds: the number of point lights
   * is part of every lit program's key, so with the final count in the scene from t = 0 the programs compiled while the
   * modules build are the ones the title and the match draw with. The game's light balancer adopts them
   * (userData.krReserve) and keeps the count constant from then on.
   */
  lightReserve(n: number) {
    const g = new THREE.Group(); g.name = "light-reserve";
    for (let i = 0; i < n; i++) {
      const d = new THREE.PointLight(0x000000, 0, 1, 2); d.position.set(0, -5000, 0);
      d.userData.krDummy = true; d.userData.krReserve = true; d.castShadow = false; g.add(d);
    }
    this.scene.add(g);
  }
  /**
   * issue the parallel compile of `objects` against the post chain's HDR target (KHR_parallel_shader_compile: the driver
   * compiles on its own threads while the main thread keeps building). Returns when every program is ready.
   * `descendants = false`: `objects` is an already-flattened batch (each object once, its children not revisited).
   */
  compileObjects(objects: THREE.Object3D[], descendants = true): Promise<unknown> {
    if (!objects.length) return RESOLVED;
    const r = this.renderer;
    const list: THREE.Object3D[] = [];
    const seen = new Set<THREE.Object3D>();
    const add = (x: THREE.Object3D) => { if (!seen.has(x)) { seen.add(x); list.push(x); } };
    for (const o of objects) { if (descendants) o.traverse(add); else add(o); }
    const fake = { traverse(fn: (o: THREE.Object3D) => void) { for (const o of list) fn(o); }, traverseVisible() { /* lights: the scene's */ } } as unknown as THREE.Object3D;
    const rt = this.compileTarget ??= new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType });
    const prev = r.getRenderTarget();
    r.setRenderTarget(rt);
    let p: Promise<unknown> = RESOLVED;
    try { p = r.compileAsync(fake, this.camera, this.scene); } catch (e) { console.warn("[engine] compile", e); }
    r.setRenderTarget(prev);
    return p.catch(() => undefined);
  }
  private compileTarget: THREE.WebGLRenderTarget | null = null;
  private warmTarget: THREE.WebGLRenderTarget | null = null;
  /**
   * draw `roots` ONCE into a small offscreen HDR target, every descendant forced visible and un-culled (hidden LOD
   * levels included), on a private layer with the scene's lights — never on screen, shadow maps untouched. Uploads what
   * a first draw would (vertex buffers / VAOs, textures, program first use), so none of it lands on the frame a player
   * first sees the content. Synchronous: no frame runs while visibility is forced. Compile first (compileObjects), or
   * this draw compiles synchronously. Objects behind a visibility gate (far-POI merge) keep their state.
   */
  warmDraw(roots: THREE.Object3D[], depthOnly = false) {
    if (!roots.length || this.contextLost) return;
    if (!this.depthVariantsWarm && this.warmShadowOn) this.warmDepthVariants();
    const LAYER = 30, DEPTH_LAYER = 28, ROOT_LAYER = depthOnly ? DEPTH_LAYER : LAYER;
    const r = this.renderer;
    const touched: Array<[THREE.Object3D, boolean, number, boolean]> = [];
    const mats = new Map<THREE.Material, boolean>();
    // (a root may be a sub-group — its ancestors must be visible for the draw to reach it)
    // An ancestor that reads hidden only because a gate is active (terrain occlusion, far merge) used to
    // be recorded as [p, false] and restored with `p.visible = false` — which wrote false into the gate's OWNER value, so
    // a POI occluded from the camera at its warm-up (Stilt Town, Wreck Bay from the title camera) stayed hidden all
    // session. Save / restore the owner value, and open the ancestors' active gates for this synchronous offscreen draw
    // only (the warm then reaches an occluded POI's chunks too; no frame runs while they are open).
    const anc: Array<[THREE.Object3D, boolean]> = [];
    const opened: Gate[] = [];
    for (const root of roots) for (let p = root.parent; p && p !== this.scene; p = p.parent) {
      for (const g of activeGates(p)) { g.active = false; opened.push(g); }
      if (!ownVisible(p)) { anc.push([p, false]); p.visible = true; }
    }
    for (const root of roots) root.traverse((o) => {
      // (an ACTIVE gate keeps its state — the far-POI merge; an empty / inactive list is an opened stream build gate)
      const gs = (o as unknown as { __krGates?: Array<{ active: boolean }> }).__krGates;
      if (gs && gs.some((g) => g.active)) return;
      touched.push([o, o.visible, o.layers.mask, o.frustumCulled]);
      o.visible = true; o.layers.enable(ROOT_LAYER); o.frustumCulled = false;
      const mm = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (mm) for (const m of Array.isArray(mm) ? mm : [mm]) if (m && !mats.has(m)) { mats.set(m, m.visible); m.visible = true; }
    });
    // (the scene's lights are collected once per frame — the stream warms a POI in many small chunks per frame)
    if (this.warmLightsAt !== this.frames || this.warmLightsGen !== this.structGen) { this.warmLightsAt = this.frames; this.warmLightsGen = this.structGen; this.warmLights.length = 0; this.scene.traverse((o) => { if ((o as THREE.Light).isLight) this.warmLights.push(o); }); }
    const lights: THREE.Object3D[] = [];
    for (const o of this.warmLights) if (o.parent && !o.layers.isEnabled(LAYER)) { lights.push(o); o.layers.enable(LAYER); }
    const cam = this.warmCam ??= new THREE.PerspectiveCamera();
    cam.copy(this.camera, false); cam.layers.set(LAYER); cam.updateMatrixWorld(true);
    const rt = this.warmTarget ??= new THREE.WebGLRenderTarget(64, 64, { type: THREE.HalfFloatType });
    const prev = r.getRenderTarget(), sm = r.shadowMap, au = sm.autoUpdate, nu = sm.needsUpdate;
    const scene = this.scene, ownAfter = Object.prototype.hasOwnProperty.call(scene, "onAfterRender") ? scene.onAfterRender : undefined;
    sm.autoUpdate = false;
    try {
      // the shadow-DEPTH programs too (alpha-tested / instanced / skinned / double-sided casters):
      // a compile pass never makes them, so the first cascade that caught a freshly streamed POI's caster compiled one on
      // a live frame. One depth draw of the roots into a private 64² map with a stand-in sun (same depth-material keys).
      // It must run INSIDE a scene render: three's shadow renderer needs the live render state, and r186 nulls it when
      // render() returns (a direct sm.render after the draw threw in setProgram — the catch hid it: no depth program was
      // ever warmed). So it runs from this warm render's onAfterRender: after the render's setupLights (the depth programs
      // get the light-state key the real cascade passes use), the stand-in light never joins the scene (no extra light in
      // any colour program, no throwaway colour variants) and is the only light drawn (the sun's cascades are untouched).
      if (sm.enabled && this.warmShadowOn) {
        const L = this.warmLight ??= (() => { const l = new THREE.DirectionalLight(0xffffff, 0); l.castShadow = true; l.shadow.mapSize.set(64, 64); l.shadow.autoUpdate = true; l.updateMatrixWorld(true); l.target.updateMatrixWorld(true); return l; })();
        let done = false;
        scene.onAfterRender = (...args: Parameters<THREE.Scene["onAfterRender"]>) => {
          ownAfter?.apply(scene, args);
          const rr = args[0];
          if (done || args[2] !== cam) return;   // (a nested render of the scene from another camera: not ours)
          done = true;
          // (throwing here would leave three's render-state stack unpopped: report and go on)
          const cc = rr.getClearColor(this.warmClear), ca = rr.getClearAlpha();
          try { sm.needsUpdate = true; L.shadow.needsUpdate = true; cam.layers.set(ROOT_LAYER); sm.render([L], scene, cam); }
          catch (e) { console.warn("[engine] warmDraw shadow", e); }
          finally { cam.layers.set(LAYER); }
          rr.setClearColor(cc, ca);   // (the depth pass leaves a white clear colour behind)
        };
      }
      r.setRenderTarget(rt); r.render(scene, cam);
    }
    catch (e) { console.warn("[engine] warmDraw", e); }
    finally {
      if (ownAfter) scene.onAfterRender = ownAfter; else delete (scene as { onAfterRender?: unknown }).onAfterRender;
      r.setRenderTarget(prev); sm.autoUpdate = au; sm.needsUpdate = nu;
      for (const l of lights) l.layers.disable(LAYER);
      for (const [o, v, mask, fc] of touched) { o.visible = v; o.layers.mask = mask; o.frustumCulled = fc; }
      for (const [o, v] of anc) o.visible = v;
      for (const g of opened) g.active = true;
      for (const [m, v] of mats) m.visible = v;
    }
  }
  private warmCam: THREE.PerspectiveCamera | null = null;
  private warmLight: THREE.DirectionalLight | null = null;
  private warmClear = new THREE.Color();
  private warmLights: THREE.Object3D[] = [];
  private warmLightsAt = -1;
  private warmLightsGen = -1;
  /** bumped on every scene-graph add / remove (scene-hooks) */
  private structGen = 0;
  private depthVariantsWarm = false;
  /**
   * every shadow-DEPTH program variant a caster can need — {plain, instanced, instanced + colour,
   * skinned} × {opaque, alpha-tested map} × {front, back, double side} — compiled ONCE, behind the loading screen (the
   * first warmDraw: the boot's settle draw). The sun's cascades only draw casters near the camera, so before this a
   * variant first met mid-match (a kong entering cascade 0, an alpha-tested crown, a far-merge proxy) compiled on a live
   * frame: the hitch log showed 13-25 ms '|depth' compiles at 34-74 s of a match. 24 tiny meshes, one depth draw, then freed.
   */
  warmDepthVariants() {
    this.depthVariantsWarm = true;
    const r = this.renderer, sm = r.shadowMap;
    if (!sm.enabled) return;
    const t0 = performance.now(), before = r.info.programs?.length ?? 0;
    const g = new THREE.Group(), LAYER = 30;
    const geo = new THREE.PlaneGeometry(0.1, 0.1);
    const sgeo = new THREE.PlaneGeometry(0.1, 0.1);
    const n = sgeo.attributes.position.count;
    sgeo.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(new Uint16Array(n * 4), 4));
    sgeo.setAttribute("skinWeight", new THREE.Float32BufferAttribute(new Float32Array(n * 4).map((_, i) => (i % 4 === 0 ? 1 : 0)), 4));
    const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1); tex.needsUpdate = true;
    const mats: THREE.Material[] = [];
    for (const side of [THREE.FrontSide, THREE.BackSide, THREE.DoubleSide]) for (const alpha of [false, true]) {
      const m = new THREE.MeshStandardMaterial({ side, map: alpha ? tex : null, alphaTest: alpha ? 0.5 : 0 }); mats.push(m);
      const plain = new THREE.Mesh(geo, m);
      const inst = new THREE.InstancedMesh(geo, m, 1);
      const instC = new THREE.InstancedMesh(geo, m, 1); instC.setColorAt(0, new THREE.Color(1, 1, 1));
      const skin = new THREE.SkinnedMesh(sgeo, m); const b = new THREE.Bone(); skin.add(b); skin.bind(new THREE.Skeleton([b]));
      for (const o of [plain, inst, instC, skin]) { o.castShadow = true; o.frustumCulled = false; o.layers.disableAll(); g.add(o); }
    }
    this.scene.add(g);
    g.updateMatrixWorld(true);
    const cam = this.warmCam ??= new THREE.PerspectiveCamera();
    cam.copy(this.camera, false); cam.layers.set(LAYER); cam.updateMatrixWorld(true);
    const au = sm.autoUpdate, nu = sm.needsUpdate;
    // (through warmDraw: the depth draw needs a live scene render — see there)
    try { this.warmDraw([g], true); }
    catch (e) { console.warn("[engine] depth variants", e); }
    finally {
      sm.autoUpdate = au; sm.needsUpdate = nu;
      this.scene.remove(g);
      g.traverse((o) => { (o as THREE.InstancedMesh).dispose?.(); (o as THREE.SkinnedMesh).skeleton?.dispose(); });
      for (const m of mats) m.dispose();
      geo.dispose(); sgeo.dispose(); tex.dispose();
    }
    const kr = (globalThis as { __kr?: Record<string, unknown> }).__kr;
    if (kr) kr.depthVariants = { programs: (r.info.programs?.length ?? 0) - before, ms: Math.round(performance.now() - t0) };
  }
  /** warmDraw also draws the roots' shadow-depth programs (?nowarmshadow = off, A/B) */
  warmShadowOn = !flag("nowarmshadow");
  private excursionTarget: THREE.WebGLRenderTarget | null = null;
  /**
   * EXCURSION: an invisible frame from another viewpoint. `setup` moves the main camera; every update hook runs once for
   * that view (module LOD selection, veg batches, cloud impostors, crowd LODs …) with `dt`, the scene is drawn into a
   * small offscreen HDR target (first draws: buffers / VAOs / textures / programs; shadow maps untouched), and the camera
   * is restored — all synchronously, so no real frame ever shows the excursion view, and the post chain / TAA history
   * never see it. The next real frame's hooks re-select everything for the real camera. Used by the game's post-title
   * warm-up (warm-up spawns, plane altitude, the kong pool at match distances) instead of real frames behind the
   * loading screen.
   */
  excursion(setup: (cam: THREE.PerspectiveCamera) => void, dt = 0) {
    if (this.contextLost) return;
    const cam = this.camera;
    const pos = cam.position.clone(), quat = cam.quaternion.clone(), fov = cam.fov, near = cam.near, far = cam.far;
    try {
      setup(cam); cam.updateProjectionMatrix(); cam.updateMatrixWorld();
      this.inStep = true;
      try { for (let i = 0; i < this.updates.length; i++) { try { this.updates[i](dt, this.time); } catch { /* reported by the real frames */ } } }
      finally { this.inStep = false; }
      const r = this.renderer, sm = r.shadowMap, au = sm.autoUpdate;
      const rt = this.excursionTarget ??= new THREE.WebGLRenderTarget(320, 180, { type: THREE.HalfFloatType });
      const prev = r.getRenderTarget();
      sm.autoUpdate = false;
      try { r.setRenderTarget(rt); r.render(this.scene, cam); }
      finally { r.setRenderTarget(prev); sm.autoUpdate = au; }
    } catch (e) { console.warn("[engine] excursion", e); }
    finally {
      cam.position.copy(pos); cam.quaternion.copy(quat); cam.fov = fov; cam.near = near; cam.far = far;
      cam.updateProjectionMatrix(); cam.updateMatrixWorld();
    }
  }
  /** queue per-frame work: fn runs once per frame after the update hooks until it returns true */
  addIdle(fn: () => boolean | void) { this.idle.push(fn); }

  /** while set, replaces the frame's draw (post chain / scene render) — update hooks, idle work
   *  and module streaming run as usual. game/title.ts draws only its key art + the hero kong while the title is up. */
  drawOverride: ((dt: number) => void) | null = null;
  /** true while step() runs (update hooks + render): the boot attributes scene adds made outside it to the building module */
  inStep = false;
  /** one frame; dt in seconds (clamped) */
  step(dt: number) {
    this.inStep = true;
    try { this.stepInner(dt); } finally { this.inStep = false; }
  }
  private stepInner(dt: number) {
    dt = Math.min(dt, 0.1);
    if (!this.shotMode) this.time += dt * this.timeScale;
    // one module's per-frame exception must never freeze the whole game (it used to kill the rAF loop): report it
    // once per hook, keep rendering
    const hl = this.hitchLog, h0 = hl ? performance.now() : 0;
    let top: Array<[string, number]> | null = hl ? [] : null;
    for (let i = 0; i < this.updates.length; i++) {
      const u0 = top ? performance.now() : 0;
      try { this.updates[i](dt, this.time); }
      catch (e) { if (!this.failed.has(i)) { this.failed.add(i); console.error(`[update hook ${i}]`, e); ((globalThis as unknown as { __kr?: { errors?: string[] } }).__kr?.errors)?.push(`[update hook ${i}] ${e instanceof Error ? e.stack || e.message : String(e)}`); } }
      if (top) { const d = performance.now() - u0; if (d > 2) top.push([`${i}:${this.updLabels[i]}`, +d.toFixed(1)]); }
    }
    const h1 = hl ? performance.now() : 0;
    if (this.idle.length) {
      for (let i = 0; i < this.idle.length; i++) {
        let done: boolean | void = true;
        try { done = this.idle[i](); } catch (e) { console.error("[engine idle]", e); }
        if (done) this.idle.splice(i--, 1);
      }
    }
    this.occlusion.update(this.camera);
    this.far.update();
    this.statics.update();
    this.cull.fovRef = (this.shared.get("display:fov") as number | undefined) ?? this.cull.fovRef;
    this.cull.update(this.camera, this.renderer.domElement.height);
    const h2 = hl ? performance.now() : 0;
    const progs = hl ? (this.renderer.info.programs?.length ?? 0) : 0;
    if (this.drawOverride) this.drawOverride(dt);
    else if (this.post) this.post.render(dt);
    else this.renderer.render(this.scene, this.camera);
    this.frames++;
    if (hl && top) {
      const h3 = performance.now();
      // programs first created in THIS frame's render = a shader compile on a live frame (a material
      // nothing warmed: a shadow-depth variant, a runtime-made material) — logged with its name, whatever the frame cost
      const pl = this.renderer.info.programs as unknown as Array<{ name?: string; cacheKey?: string }> | undefined;
      const fresh = pl && pl.length > progs ? pl.slice(progs).map((p) => `${p.name ?? "?"}|${String(p.cacheKey ?? "").slice(0, 60)}`) : null;
      if (fresh) { this.newPrograms.push({ at: Math.round(h0), ms: +(h3 - h0).toFixed(1), stream: (globalThis as { __kr?: { streamStage?: string } }).__kr?.streamStage ?? "", programs: fresh }); if (this.newPrograms.length > 400) this.newPrograms.shift(); }
      if (h3 - h0 > 30) {
        top.sort((a, b) => b[1] - a[1]); top = top.slice(0, 4);
        const kr = (globalThis as { __kr?: { streamStage?: string } }).__kr;
        hl.push({ at: Math.round(h0), stepMs: +(h3 - h0).toFixed(1), updMs: +(h1 - h0).toFixed(1), idleMs: +(h2 - h1).toFixed(1), renderMs: +(h3 - h2).toFixed(1), top, stream: kr?.streamStage ?? "", programs: this.renderer.info.programs?.length ?? 0 });
        if (hl.length > 400) hl.shift();
      }
    }
  }

  /**
   * true = the frame loop keeps ticking (requestAnimationFrame promises resolve) but runs no hooks and draws nothing:
   * the canvas keeps its last frame. The boot sets it while a full-screen card covers the game (PRACTICE waiting for
   * the island stream) so the main thread goes to the stream, not to frames nobody sees.
   */
  suspended = false;
  private lost = false;
  /**
   * true from the moment the GL context is lost until the restore has rebuilt everything (set by watchContext). The
   * browser queues `webglcontextlost` as a later task, and three stops drawing only at that event: frames in between
   * upload into a dead context, and three caches the extensions it first asks for there as missing (the BPTC warnings).
   */
  get contextLost() { return this.lost || this.renderer.getContext().isContextLost(); }
  set contextLost(v: boolean) { this.lost = v; }
  restores = 0;
  start() {
    if (this.started) return;
    this.started = true;
    let prevRaf = 0;
    const loop = (frameT: number) => {
      const now = performance.now();
      // display refresh: from the rAF timestamps (vsync-aligned, unlike the time this callback got to run) of 90 frames
      // after start, then every 20 s again (a window moved to another monitor); see refresh.ts
      if (prevRaf) this.sampleRefresh(frameT - prevRaf);
      prevRaf = frameT;
      if (this.suspended || this.contextLost) { this.last = now; this.rafEnd = performance.now(); requestAnimationFrame(loop); return; }
      requestAnimationFrame(loop);
      // frame limiter (display settings): draw only when the cap's interval has elapsed (a 0.6 ms slack absorbs vsync
      // jitter; the cadence advances by whole intervals so 144 on a 240 Hz screen alternates 1-2 vsyncs evenly)
      if (this.capMs > 0) {
        const since = now - this.lastDraw;
        if (since < this.capMs - 0.6) { this.rafEnd = performance.now(); return; }
        this.lastDraw = since > this.capMs * 2 ? now : this.lastDraw + this.capMs;
      }
      const dt = (now - this.last) / 1000;
      if (this.hitchLog && now - this.last > 50) {
        const kr = (globalThis as { __kr?: { streamStage?: string } }).__kr;
        this.hitchLog.push({ at: Math.round(now), gapMs: +(now - this.last).toFixed(1), lastStepMs: +this.lastStepMs.toFixed(1), stream: kr?.streamStage ?? "" });
      }
      if (this.onDraw) this.onDraw(now - this.last);
      const fi = this.frameIdx++ % this.frameMs.length;
      this.frameMs[fi] = now - this.last;
      this.frameStream[fi] = this.streamTouched || this.streamJobs > 0 ? 1 : 0;
      this.streamTouched = false;
      this.last = now;
      const c0 = performance.now();
      const q = this.gpuBegin();
      this.step(dt);
      this.lastStepMs = performance.now() - c0;
      if (this.lastStepMs < 60) this.stepEma = this.stepEma ? this.stepEma + (this.lastStepMs - this.stepEma) * 0.05 : this.lastStepMs;
      this.gpuEnd(q);
      this.dynamicResolution(dt * 1000, performance.now() - c0);
      this.rafEnd = performance.now();
    };
    requestAnimationFrame(loop);
  }
  private started = false;
  private lastStepMs = 0;
  /** smoothed main-thread ms of a frame (hooks + render submit), without hitches — the stream's slice planner reads it */
  stepEma = 0;

  // ---- frame limiter + display refresh
  /** ms between drawn frames (0 = every vsync — "Unlimited": a browser presents at most once per display refresh) */
  private capMs = 0;
  private lastDraw = 0;
  /** the frame cap in fps (0 = unlimited) */
  get frameCap() { return this.capMs > 0 ? Math.round(1000 / this.capMs) : 0; }
  setFrameCap(fps: number) {
    // a cap at or above the display's refresh is the same as unlimited (vsync paces it)
    this.capMs = fps > 0 && (!this.refreshHz || fps < this.refreshHz - 2) ? 1000 / fps : 0;
    this.capWanted = fps;
    this.lastDraw = performance.now();
  }
  private capWanted = 0;
  /** measured display refresh (Hz, 0 until known) */
  refreshHz = 0;
  private rafSamples: number[] = [];
  private rafNext = 0;
  private refreshEst = new RefreshEstimate(/^((?!chrome|chromium|android|crios|fxios|edg).)*safari/i.test(navigator.userAgent) ? WEBKIT_CEILING_HZ : 0);
  private refreshListeners: Array<(hz: number) => void> = [];
  onRefresh(fn: (hz: number) => void) { this.refreshListeners.push(fn); if (this.refreshHz) fn(this.refreshHz); }
  private sampleRefresh(d: number) {
    const now = performance.now();
    if (now < this.rafNext || d <= 0 || d > 100) return;
    this.rafSamples.push(d);
    if (this.rafSamples.length < 90) return;
    const sc = globalThis.screen as (Screen & { availLeft?: number; availTop?: number }) | undefined;
    const v = this.refreshEst.add(this.rafSamples, sc ? [sc.width, sc.height, sc.availLeft, sc.availTop].join() : "");
    this.rafSamples = [];
    this.rafNext = now + 20000;
    if (v !== this.refreshHz) {
      this.refreshHz = v;
      if (this.capWanted) this.setFrameCap(this.capWanted);
      for (const f of this.refreshListeners) f(v);
    }
  }

  // ---- 3D resolution + dynamic resolution. The post chain (atmos) renders the scene at renderScale × the canvas and its
  // TAA resolve reconstructs the full-resolution frame (TAAU — post.setRenderScale); without TAA the canvas pixel ratio
  // is scaled instead. The scale is the player's 3D-resolution setting (100 %
  // by default) and dynamic resolution is OPT-IN (video settings or ?dynres=1): it then works between 0.75 × that and
  // that, aiming at the frame cap (or the display refresh when uncapped), lowering only while the frame is GPU-bound.
  // ?dynres=0 forces it off, ?scale=0.75 pins the scale.
  /** current internal render scale (tools read it) */
  renderScale = 1;
  /** the player's 3D resolution (0.5-1) */
  resBase = 1;
  /** frame budget the dynamic-resolution controller aims for (ms) */
  get frameBudgetMs() { return this.capMs > 0 ? this.capMs : 1000 / (this.refreshHz || 60); }
  private dynOn = flag("dynres") === "1";
  private dynForcedOff = flag("dynres") === "0";
  private dynPin = flag("scale") || 0;
  get dynamicRes() { return this.dynOn; }
  setDynamicRes(on: boolean) {
    this.dynOn = on && !this.dynForcedOff;
    if (this.dynOn && this.tq === null) this.tq = undefined; // (re)try the GPU timer query
    if (!this.dynOn) this.applyScale(this.resBase);
  }
  /** the 3D resolution (fraction of native, 0.5-1) */
  setResolution(s: number) {
    this.resBase = Math.min(1, Math.max(0.5, Number.isFinite(s) ? s : 1));
    this.applyPixelRatio();
    this.applyScale(this.resBase);
  }
  /** the post chain rebuilt itself (AA mode switch): re-derive the canvas pixel ratio and the render scale */
  onPostRebuilt() { this.applyPixelRatio(); this.applyScale(this.resBase); }
  /** the post chain renders the scene at a render scale and upscales it itself (every AA mode — TAAU with TAA, a
   *  Catmull-Rom upscale with FXAA / off; the canvas, the HUD and the viewmodel stay at native pixels) */
  private postTaa() { const p = this.post as (PostPipeline & { setRenderScale?: (s: number) => void; composer?: unknown }) | null; return !!(p?.setRenderScale && p.composer); }
  /** no post chain to upscale in: the 3D resolution scales the canvas backing store instead */
  applyPixelRatio() {
    const pr = this.postTaa() ? this.dprBase : this.dprBase * this.resBase;
    if (Math.abs(this.renderer.getPixelRatio() - pr) > 1e-3) { this.renderer.setPixelRatio(pr); this.resize(); }
  }
  private applyScale(s: number) {
    const post = this.post as (PostPipeline & { setRenderScale?: (s: number) => void }) | null;
    const v = this.postTaa() ? s : 1;
    this.renderScale = +v.toFixed(3);
    post?.setRenderScale?.(this.renderScale);
  }
  /** the half-rate guard (res-guard.ts) sets the render scale while dynamic resolution is off; false = not here (dynamic
   *  resolution on, ?dynres=0, a pinned ?scale, capture mode, or no post chain to upscale in) */
  guardScale(s: number): boolean {
    if (this.dynOn || this.dynForcedOff || this.dynPin > 0 || this.shotMode || !this.postTaa()) return false;
    this.applyScale(Math.min(this.resBase, Math.max(0.5, s)));
    return true;
  }
  private emaDt = 0; private emaCpu = 0; private dynHold = 0;
  // GPU time per frame (EXT_disjoint_timer_query_webgl2 when the browser exposes it): the controller then knows the
  // GPU's share instead of inferring it from dt vs CPU
  private tq: { ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number }; free: WebGLQuery[]; pending: WebGLQuery[]; epoch: number } | null | undefined;
  /** smoothed GPU ms per frame (0 = unknown) */
  gpuMs = 0;
  private gpuTimed = false;
  gpuHold = false;
  onDraw: ((dtMs: number) => void) | null = null;
  timeGpu() {
    this.gpuTimed = true;
    if (this.tq === null) this.tq = undefined;
  }
  private gpuBegin(): WebGLQuery | null {
    if (this.tq && this.tq.epoch !== contextEpoch()) this.tq = undefined;
    if (this.tq === undefined) {
      const gl = this.renderer.getContext() as WebGL2RenderingContext;
      // (never in view-camera captures; never while a dev tool times its own pass — nested TIME_ELAPSED queries are an error)
      const ext = (this.dynOn || this.dynPin || this.gpuTimed) && !this.shotMode ? gl.getExtension("EXT_disjoint_timer_query_webgl2") : null;
      this.tq = ext ? { ext, free: [], pending: [], epoch: contextEpoch() } : null;
    }
    const t = this.tq; if (!t || this.gpuHold || (globalThis as { __stormTimer?: unknown }).__stormTimer) return null;
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    // collect finished queries (oldest first)
    while (t.pending.length) {
      const q = t.pending[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      t.pending.shift();
      // (no GPU_DISJOINT_EXT check: getParameter may be a synchronous round trip; outliers are clamped + smoothed)
      const ms = (gl.getQueryParameter(q, gl.QUERY_RESULT) as number) / 1e6;
      if (ms > 0 && ms < 200) this.gpuMs = this.gpuMs ? this.gpuMs + (ms - this.gpuMs) * 0.1 : ms;
      t.free.push(q);
    }
    if (t.pending.length > 6) return null;
    const q = t.free.pop() ?? gl.createQuery();
    if (!q) return null;
    gl.beginQuery(t.ext.TIME_ELAPSED_EXT, q);
    return q;
  }
  private gpuEnd(q: WebGLQuery | null) {
    if (!q || !this.tq) return;
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    gl.endQuery(this.tq.ext.TIME_ELAPSED_EXT);
    this.tq.pending.push(q);
  }
  private dynamicResolution(dtMs: number, cpuMs: number) {
    const post = this.post as (PostPipeline & { setRenderScale?: (s: number) => void }) | null;
    if (!post?.setRenderScale || this.shotMode) return;
    if (this.dynPin > 0) { if (this.renderScale !== this.dynPin) { this.renderScale = Math.min(1, Math.max(0.5, this.dynPin)); post.setRenderScale(this.renderScale); } return; }
    if (!this.dynOn || !this.postTaa() || dtMs <= 0 || dtMs > 250) return;
    const a = 0.08;
    this.emaDt = this.emaDt ? this.emaDt + (dtMs - this.emaDt) * a : dtMs;
    this.emaCpu = this.emaCpu ? this.emaCpu + (cpuMs - this.emaCpu) * a : cpuMs;
    if (--this.dynHold > 0) return;
    const budget = this.frameBudgetMs, dt = this.emaDt, cpu = this.emaCpu, gpu = this.gpuMs;
    let s = this.renderScale;
    const gpuBound = gpu > 0 ? gpu > budget * 1.02 && gpu > cpu * 0.95 : cpu < dt * 0.72;
    const headroom = gpu > 0 ? gpu < budget * 0.72 || gpu < cpu * 0.7 : dt < budget * 0.9 || cpu > dt * 0.85;
    // GPU-bound and over budget: the GPU work, not the JS, sets the frame time → fewer pixels
    const top = this.resBase, floor = Math.max(0.5, top * 0.75);
    if (dt > budget * 1.08 && gpuBound) s = Math.max(floor, s * (dt > budget * 1.5 ? 0.9 : 0.95));
    // headroom (or CPU-bound: resolution is not what limits the frame) → back toward the player's 3D resolution
    else if (s < top && headroom) s = Math.min(top, s * 1.04);
    if (s > top) s = top;
    if (Math.abs(s - this.renderScale) >= 0.01 || (s === top && this.renderScale !== top)) {
      this.renderScale = +s.toFixed(3);
      post.setRenderScale(this.renderScale);
      this.dynHold = 20;   // let the EMA see the new scale before the next step
    }
  }

  liveFps() {
    const v = [...this.frameMs].filter((x) => x > 0);
    return v.length ? Math.round(1000 / (v.reduce((a, b) => a + b, 0) / v.length)) : 0;
  }
}
