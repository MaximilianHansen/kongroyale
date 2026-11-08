// Boot. URL flags:
//   ?view=<id>      view camera (see engine/views.ts + module views)
//   ?cam=x,y,z,tx,ty,tz[,fov]   ad-hoc camera
//   ?shot           capture mode: frozen time (?t=12), pixel ratio 1, HUD hidden, window.__kr.ready when settled
//   ?fly            free-fly camera on top of a view
//   ?modules=a,b    build only these modules (ids or prefixes, e.g. atmos,terrain,water,poi:peel-harbor)
//   ?q=ultra|high|medium|low
//   ?nostream       game page: build every module before the title (A/B)
//   ?nohlod / ?nofreeze   engine A/B switches: far-POI merge (engine/hlod.ts) / static-transform cache
//                   (engine/static-cache.ts)
//   (no view/cam)   → the game (client/src/game/index.ts)
//
// Boot timeline:
//   t=0      every module import, the game import and the static-world worker start at once (network + parse overlap
//            the CPU work below)
//   title    the TITLE modules (registry.ts TITLE_MODULES / module.priority) build in registry order behind the loading
//            screen, then their afterBuild, then the game (kits + prewarm) → __kr.ready (the title is playable)
//   stream   every other module builds right after, in idle time (nearest to the islet first); each is integrated
//            (atmos patch, parallel shader compile, texture upload in slices) BEFORE its new materials may draw, so
//            nothing compiles or uploads on a frame. __kr.streamed turns true at the end; then every afterBuild runs
//            once more (the world is complete) and the far-POI proxies are built in idle frames.
// KONGBOT first: its console / error capture must see the whole boot (bug reports, client/src/kongbot)
import "./kongbot/capture";
import * as THREE from "three";
import { Engine, type Quality } from "./engine/engine";
import { installKongbot } from "./kongbot";
import { DEFAULT_VIEWS, applyView, parseCam, type CamSpec } from "./engine/views";
import { MODULES, TITLE_MODULES } from "./world/registry";
import type { WorldModule } from "./world/module";
import { loadTerrain } from "./world/terrain/load";
import { startStaticWorld } from "./engine/static-world";
import { startLootSpotsWorker } from "./engine/lootspots";
import { onStructure, gate, ungate, type Gate } from "./engine/scene-hooks";
import { POIS } from "../../shared/world/map";
import { Display, bootQuality } from "./engine/display";
import { WARMUP_S } from "../../shared/sim/const";
import { resources, type Scope } from "./engine/res/scope";
import { flag } from "./flags";
import { afterPaint as nextFrame, noFrameWaitCount } from "./engine/frame";
import { diagOn, startBeat } from "./playtest/beat";
import { asOwner, contextEpoch, onRestore } from "./engine/res/restore";

const shot = flag("shot");
const errors: string[] = [];
const report = (where: string, e: unknown) => {
  const msg = `[${where}] ${e instanceof Error ? e.stack || e.message : String(e)}`;
  errors.push(msg);
  console.error(msg);
  // players get the loading screen's reload card for a genuine boot failure (bootFail), not a raw stack: ?debug shows it
  if (!shot && flag("debug")) showError(msg);
};
addEventListener("error", (e) => report("window", e.error ?? e.message));
addEventListener("unhandledrejection", (e) => report("promise", e.reason));

const kr: Record<string, unknown> = { ready: false, errors, stage: "boot", streamed: false };
(window as unknown as { __kr: typeof kr }).__kr = kr;
// the loading screen (index.html) painted its tip and controls keycaps from the saved bindings; hand it the game's own
// labels (settings/labels.ts) so they follow a rebind or a controller from here on
if (document.getElementById("kr-loading")) void import("./ui/loading-keys").then((m) => m.attachLoadingKeys(), (e) => report("loading-keys", e));
let bootReady = false;
/** a GENUINE boot failure (the boot sequence itself threw — no WebGL, no terrain, the game didn't start — or it timed
 *  out): the game page never becomes "ready" and the loading screen offers a reload. Everything else (one POI's build
 *  throwing, a shader warning) is only reported. View-camera pages (?view / ?cam) keep going. */
const bootFail = (where: string, e: unknown) => { report(where, e); if (gameMode && !bootReady) kr.bootError = true; };

const viewId = flag("view"), camArg = flag("cam");
const gameMode = !viewId && !camArg;
// diagnostics: the crash heartbeat's first beat, before the world loads (playtest/beat.ts)
if (gameMode && !shot && diagOn()) startBeat();
const streamOn = gameMode && !flag("nostream");
const only = flag("modules");
const entries = MODULES.filter(([id]) => !only || only.some((o) => id === o || id.startsWith(o)));

// ---- t = 0: start every fetch at once (module code, the game code, the static collision world in a worker)
const imports = new Map<string, Promise<WorldModule>>();
for (const [id, load] of entries) {
  const p = load().then((m) => m.default);
  p.catch(() => { /* reported by its build */ });
  imports.set(id, p);
}
const gameImport = gameMode ? import("./game/index") : null;
let postBuild = null as typeof import("./post-build") | null;
const prepareCardImport = import("./prepare-card");
const postBuildImport = import("./post-build").then((m) => (postBuild = m), (e) => { report("post-build", e); return null; });
gameImport?.catch(() => { /* reported by the game stage */ });
if (gameMode) { startStaticWorld(); startLootSpotsWorker(); } // (perf: the loot spots off the main thread too)


const auditReady = flag("resaudit") ? import("./engine/res/audit").then((m) => { kr.resAudit = m.auditRenderer(() => (kr.engine as Engine | undefined)?.renderer); }, (e) => report("resaudit", e)) : null;
const canvas = document.getElementById("c") as HTMLCanvasElement;
// the game page builds at the tier of the player's video preset (?q= wins; view-camera pages ignore it)
const videoQ = gameMode && !shot && flag("q") === null ? bootQuality() : null;
const engine = (() => {
  try { return new Engine(canvas, { quality: (flag("q") as Quality) || videoQ || "ultra", shotMode: shot, time: flag("t") }); }
  catch (e) { bootFail("engine", e); throw e; }
})();
kr.engine = engine;
kr.sliceLog = engine.sliceLog;
if (flag("texprof")) await import("./engine/dev-probes").then((m) => m.installTexProf(engine), (e) => report("texprof", e));
if (flag("drawcensus")) await import("./engine/draw-census").then((m) => { kr.drawCensus = m.installDrawCensus(engine); }, (e) => report("drawcensus", e));
// the video settings (engine/display.ts): frame cap / 3D resolution now, the rest once atmos + veg exist
const display = gameMode && !shot ? new Display(engine) : null;
kr.display = display;
// the final point-light count from t = 0 (1 chest-system light + 4 chest-burst pool + 2 streaming reserve — see
// game/lights.ts): programs compiled during the build keep their key (engine.lightReserve)
if (streamOn) engine.lightReserve(7);
// game page: no synchronous shader-status queries on first use (three's checkShaderErrors = getProgramInfoLog +
// 2× getShaderInfoLog + LINK_STATUS per program = a GPU-process round trip each, 3.5 s of the boot for ~440 programs).
// Link failures are still reported: engine.auditShaders() checks every program once it has finished compiling, in idle
// frames (never blocking). ?shadercheck keeps three's own synchronous checks. View-camera pages keep them too.
if (gameMode && !flag("shadercheck")) { engine.renderer.debug.checkShaderErrors = false; engine.addIdle(() => engine.auditShaders(report, () => !kr.ready || !!(kr.game as { inMatch?: boolean } | undefined)?.inMatch)); }
// ?shadercheck / view-camera pages: three's synchronous check reports a failed program into __kr.errors too
// (the preset audit must catch every compile / link failure, not only a console line)
engine.renderer.debug.onShaderError = (gl, program, vs, fs) => {
  const log = (sh: WebGLShader) => (gl.getShaderParameter(sh, gl.COMPILE_STATUS) ? "" : (gl.getShaderInfoLog(sh) ?? "").trim().split("\n").slice(0, 3).join(" | "));
  const name = (engine.renderer.info.programs as unknown as Array<{ program: WebGLProgram; name?: string }> | undefined)?.find((p) => p.program === program)?.name ?? "?";
  report("shader", `program "${name}" failed: ${log(vs) || log(fs) || (gl.getProgramInfoLog(program) ?? "").trim().slice(0, 300)}`);
};
kr.bench = (n?: number) => import("./engine/dev-probes").then((m) => m.bench(engine, n));
kr.fps = () => engine.liveFps();
kr.info = () => ({ ...engine.renderer.info.render, geometries: engine.renderer.info.memory.geometries, textures: engine.renderer.info.memory.textures, programs: engine.renderer.info.programs?.length });
// AGENT LINK (dev server only): a coding agent can read and change this tab's live state (tools/agent-bridge.ts)
if (import.meta.env.DEV && !shot) { kr.THREE = THREE; void import("./dev/agent-link").then((m) => m.startAgentLink(kr), (e) => report("agent-link", e)); }
// bug reports: `/` → /kongbot <message> (screenshot + context → the server)
if (gameMode && !shot) installKongbot(engine);
if (!shot) void import("./playtest").then((m) => m.installPlaytest(engine, gameMode), (e) => report("playtest", e));

// ---- loading progress, weighted by measured cost (ms on an RTX 4080 desktop, cold dev loads). The loading
// screen (index.html) reads __kr.progress (the percentage) and the current step's time estimate as a line
// (progressFrom / progressAt / progressRate / progressTo, below). The bar follows that line on the compositor, so it
// keeps moving while a module's build blocks the main thread and never runs ahead of the percentage (Toon loading, no
// fake progress). progressEta = the step's expected ms (diagnosis).
// measured over 3 cold dev loads (an under-predicted game stage makes the pre-ready planner below build POIs that do
// not fit and delays ready)
const EXPECT: Record<string, number> = { boot: 400, atmos: 600, terrain: 2400, water: 240, veg: 640, "poi:lobby-islet": 1050, afterBuild: 700, game: 9300, settle: 1950 };
// idle build ms of the island POIs (RTX 4080 desktop; refresh the table when builds change).
// Used to weight the bar and to plan the pre-ready stream below.
const EST: Record<string, number> = {
  "poi:coconut-cove": 1100, "poi:lookout-point": 460, "poi:the-plantation": 620, "poi:peel-harbor": 3350, "poi:mango-market": 2500,
  "poi:banana-temple": 1200, "poi:peel-strip": 250, "poi:the-wreck": 600, "poi:canopy-line": 420, "poi:the-murk": 810, "poi:stilt-town": 270,
  "poi:mist-falls": 220, "poi:coco-caves": 130, "poi:ripe-peak": 450, "poi:cnvs-lab": 450, "poi:wreck-bay": 250,
};
const est = (id: string) => EXPECT[id] ?? EST[id] ?? 700;
/**
 * READY BY (ms after navigation): behind the loading screen the boot keeps building the streamed POIs (largest first)
 * while the predicted ready time — now + this module + afterBuild + game + settle, scaled by how slow this machine ran
 * the title modules — stays under it. Nothing competes with those builds (no title frames yet) and the game's prewarm
 * compiles them with everything else, so the island is usually complete when the title appears (PRACTICE → match
 * instant). Whatever does not fit streams in right after ready (the small ones: short title stalls). ?readyby=ms tunes it.
 */
// (25 s — with the corrected EXPECT table the planner now really lands ready near 25 s instead of 29 s;
// a lower target moved too much of the island into the match: POIs were still integrating in the skydive)
const READY_BY = flag("readyby");
const titleIds = entries.map(([id]) => id).filter((id) => !streamOn || TITLE_MODULES.has(id));
const steps: Array<[string, number]> = [["boot", EXPECT.boot], ...titleIds.map((id): [string, number] => [id, est(id)]), ["afterBuild", EXPECT.afterBuild]];
if (gameMode) steps.push(["game", EXPECT.game]);
steps.push(["settle", EXPECT.settle]);
let total = steps.reduce((a, s) => a + s[1], 0);
/** insert (pre-ready streamed) module steps before "afterBuild" and re-weight the bar */
function planSteps(ids: string[]) {
  const at = steps.findIndex((s) => s[0] === "afterBuild");
  steps.splice(at, 0, ...ids.map((id): [string, number] => [id, est(id)]));
  total = steps.reduce((a, s) => a + s[1], 0);
}
let stepIdx = 0, stepT0 = performance.now(), doneW = 0;
/** a step's time estimate stops at 95 % of its weight (the real end of the step moves it on); the game step's time
 *  estimate runs at half speed, its own sub-steps (gameProgress) are the real measure */
const STEP_CAP = 0.95;
const timeShare = (key: string) => (key === "game" ? 0.5 : 1);
function enterStep(key: string) {
  const i = steps.findIndex((s, k) => k >= stepIdx && s[0] === key);
  if (i < 0) return;
  for (let k = stepIdx; k < i; k++) doneW += steps[k][1];
  stepIdx = i; stepT0 = performance.now();
  kr.progressEta = steps[i][1];
  // the time estimate as a line: progressFrom at progressAt (performance.now()), growing progressRate per ms (weights are
  // expected ms), up to progressTo. Set before progressTo: its setter repaints the loading screen.
  kr.progressFrom = +(doneW / total).toFixed(4);
  kr.progressAt = stepT0;
  kr.progressRate = timeShare(key) / total;
  kr.progressTo = +((doneW + steps[i][1] * STEP_CAP * timeShare(key)) / total).toFixed(4);
}
Object.defineProperty(kr, "progress", {
  enumerable: true,
  get() {
    if (kr.ready) return 1;
    const s = steps[stepIdx]; if (!s) return 1;
    let f = Math.min(STEP_CAP, (performance.now() - stepT0) / s[1]) * timeShare(s[0]);
    if (s[0] === "game" && typeof kr.gameProgress === "number") f = Math.max(f, Math.min(0.98, kr.gameProgress as number));
    return +((doneW + s[1] * f) / total).toFixed(4);
  },
});
enterStep("boot");

kr.stage = "terrain";
const tt = performance.now();
engine.terrain = await loadTerrain().catch((e) => { bootFail("terrain", e); throw e; });
kr.terrainMs = Math.round(performance.now() - tt);

// ---- world modules
const loaded: WorldModule[] = [];
const buildMs: Record<string, number> = {};
const afterBuildMs: Record<string, number> = {};
kr.buildMs = buildMs;
kr.afterBuildMs = afterBuildMs;
const views: Record<string, CamSpec> = { ...DEFAULT_VIEWS };
kr.views = () => Object.keys(views).sort();
kr.modules = loaded.map((m) => m.id);
const rootsOf = new Map<string, THREE.Object3D[]>();
let buildAdds: THREE.Object3D[] | null = null;
// a STREAMED module's scene roots stay behind a visibility gate from the moment its build adds them
// until its integration starts — a build spans many frames (ctx.yield), and the live frames in between drew the
// half-built POI: every new material compiled synchronously on a live frame, WITHOUT the atmos patch (compiled again
// after the sweep) — the hitch log showed 15-70 ms 'build:poi:the-murk' frames in the warm-up / plane. ?nobuildgate = off.
let buildGate: { active: boolean } | null = null;
const buildGates = new Map<string, { gate: { active: boolean }; adds: THREE.Object3D[] }>();
onStructure((parent, child, added) => { if (added && child && buildAdds && parent === engine.scene && !engine.inStep) { buildAdds.push(child); if (buildGate) gate(child, buildGate); } });
const modOf = new Map<string, WorldModule>();
const scopeOf = new Map<string, Scope>();

/** build one module; returns it (or null on error) with the scene roots it added */
async function buildOne(id: string, streamed: boolean): Promise<WorldModule | null> {
  await auditReady;
  kr.stage = streamed ? kr.stage : `build:${id}`;
  if (streamed) kr.streamStage = `build:${id}`;
  else { enterStep(id); await nextFrame(); }
  // attribution: the scene children added OUTSIDE engine.step while this build runs (a frame's hooks — veg impostors,
  // gameplay pumping the match — add their own objects inside step)
  const adds: THREE.Object3D[] = [];
  buildAdds = adds;
  if (streamed && !flag("nobuildgate")) { buildGate = { active: true }; buildGates.set(id, { gate: buildGate, adds }); }
  engine.beginSlice();
  const t0 = performance.now();
  let m: WorldModule | null = null;
  const scope = resources.root.child(`region:${id}`);
  const ctx = streamed && postBuild ? postBuild.moduleCtx(engine, world, id) : engine;
  try {
    m = await imports.get(id)!;
    const mod = m;
    await asOwner(id, async () => mod.build(ctx, scope));
    scopeOf.set(id, scope);
    loaded.push(m);
    modOf.set(id, m);
    kr.modules = loaded.map((x) => x.id);
    Object.assign(views, m.views ?? {});
  } catch (e) { report(`build:${id}`, e); m = null; scope.dispose(); }
  buildMs[id] = Math.round(performance.now() - t0);
  buildAdds = null; buildGate = null; engine.rebuilding = false;
  // behind the loading screen: start the parallel compile of what this module drew right away — the driver compiles on
  // its own threads while the next module builds (the game's prewarm compile then mostly hits the program cache)
  if (!streamed && gameMode && m) {
    try { atmos()?.sweep?.(); } catch { /* atmos reports */ }
    void engine.compileObjects(adds.filter((c) => c.parent === engine.scene));
  }
  rootsOf.set(id, [...new Set(adds)].filter((c) => c.parent === engine.scene));
  return m;
}

async function runAfterBuild(m: WorldModule, streamed: boolean) {
  if (!m.afterBuild) return;
  if (!streamed) kr.stage = `afterBuild:${m.id}`;
  const t0 = performance.now();
  try { await m.afterBuild(streamed && postBuild ? postBuild.moduleCtx(engine, world, m.id) : engine); } catch (e) { report(`afterBuild:${m.id}`, e); }
  engine.rebuilding = false;
  afterBuildMs[m.id] = (afterBuildMs[m.id] ?? 0) + Math.round(performance.now() - t0);
}

/** a module's scene roots (never gameplay objects: see the name / distance filter) */
const GAME_ROOT = /^(loot|chest|kong|fx|storm|glider|plane|title|prewarm|viewmodel|tracer|impact|rocket|nade|hud|far-merge)/i;
const _box = new THREE.Box3(), _c = new THREE.Vector3();
function moduleRoots(id: string, streamed: boolean): THREE.Object3D[] {
  const roots = (rootsOf.get(id) ?? []).filter((o) => !(o as THREE.Camera).isCamera && !(o as THREE.Light).isLight);
  if (!streamed) return roots;
  // streamed while the game runs: only roots that are clearly this module's (not a gameplay object added meanwhile)
  const poi = id.startsWith("poi:") ? POIS.find((p) => `poi:${p.id}` === id) : undefined;
  return roots.filter((o) => {
    if (GAME_ROOT.test(o.name) || o.userData.gameRoot) return false;
    if (!poi) return true;
    _box.setFromObject(o);
    if (_box.isEmpty()) return true;
    _box.getCenter(_c);
    return Math.hypot(_c.x - poi.x, _c.z - poi.z) < poi.r * 2.5 + 150;
  });
}

/** tools: a module's scene roots (ablation — GPU / CPU share per module) */
kr.moduleRoots = (id: string) => moduleRoots(id, false);
kr.moduleIds = () => [...rootsOf.keys()];

function registerStatics(id: string, streamed: boolean) {
  for (const r of moduleRoots(id, streamed)) { engine.statics.register(r); engine.cull.register(r); }
}

/** a POI's roots join the terrain-occlusion cull (engine/occlusion.ts) */
function registerOcclusion(id: string, streamed: boolean) {
  if (!id.startsWith("poi:")) return;
  engine.occlusion.register(id, moduleRoots(id, streamed));
}

function registerFar(id: string, m: WorldModule | null, streamed: boolean) {
  if (!m || m.noFarMerge || !id.startsWith("poi:")) return;
  const poi = POIS.find((p) => `poi:${p.id}` === id);
  if (!poi) return;
  const roots = moduleRoots(id, streamed);
  const y = Math.max(poi.padY ?? 0, engine.terrain.height(poi.x, poi.z));
  engine.far.register(id, roots, { x: poi.x, y, z: poi.z }, Math.max(240, poi.r * 2.2));
}

const world = { modOf, scopeOf, rootsOf, loaded, roots: (id: string) => moduleRoots(id, true), report, build: (id: string) => streamBuild(id, false) };
if (flag("invariants")) void import("./engine/invariants").then((m) => { kr.invariants = m.installInvariants(engine, world.roots, () => kr.modules, report); }, (e) => report("invariants", e));

const atmos = () => engine.shared.get("atmos") as { sweep?: () => number } | undefined;

let buildQueue: Promise<unknown> = Promise.resolve();
function streamBuild(id: string, fast: boolean): Promise<{ integrated: Promise<void> }> {
  // (engine.streamJobs: from the build's start until its integration ends, every frame interval is a stream frame)
  const built = buildQueue.then(() => {
    engine.streamJobs++;
    return buildStreamed(id, fast).then((b) => ({ integrated: b.integrated.finally(() => { engine.streamJobs--; }) }), (e) => { engine.streamJobs--; throw e; });
  });
  buildQueue = built.catch(() => {});
  return built;
}

async function buildStreamed(id: string, fast: boolean): Promise<{ integrated: Promise<void> }> {
  const m = await buildOne(id, true);
  if (m) await runAfterBuild(m, true);
  if (LOW_MEM) await postBuild!.warmTextures(moduleRoots(id, true));
  registerStatics(id, true);
  registerFar(id, m, true);
  if (LOW_MEM) startFarBuild();
  registerOcclusion(id, true);
  kr.streamStage = `integrate:${id}`;
  try { atmos()?.sweep?.(); } catch (e) { report(`stream-sweep:${id}`, e); }
  // pipelined: this module's programs compile on the driver's threads while the NEXT module builds (its fresh
  // materials stay hidden until its integration ends); at most one integration in flight
  // (the build gate stays shut until integrateFresh's offscreen first draw has uploaded the module's vertex buffers:
  // opened before it, the meshes on already-compiled materials drew on the next live frame and uploaded tens of MB of
  // geometry inside it — 180-580 ms warm-up frames while Peel Harbor integrated)
  const bg = buildGates.get(id); buildGates.delete(id);
  let shut = !!bg;
  const open = () => { if (!bg || !shut) return; shut = false; bg.gate.active = false; for (const o of bg.adds) ungate(o, bg.gate); engine.cull.reveal(bg.adds); };
  return { integrated: integrateFresh(fast, moduleRoots(id, true), bg?.gate, open).finally(open).then(() => engine.markBuilt(id)) };
}


// ---- title modules (everything, in ?view / ?cam / ?shot pages or with ?nostream)
const streamList: string[] = [];
for (const [id] of entries) {
  if (streamOn && !TITLE_MODULES.has(id)) { streamList.push(id); continue; }
  // a title-registry module that asks to be streamed
  if (streamOn) { try { if ((await imports.get(id)!).priority === "stream") { streamList.push(id); continue; } } catch { /* its build reports */ } }
  await buildOne(id, false);
}
// streamed-registry modules that ask for the title
if (streamOn) {
  for (const id of [...streamList]) {
    let pr: string | undefined;
    try { pr = (await Promise.race([imports.get(id)!, new Promise<null>((r) => setTimeout(() => r(null), 0))]))?.priority; } catch { /* its build reports */ }
    if (pr === "title") { streamList.splice(streamList.indexOf(id), 1); await buildOne(id, false); }
  }
}
const LOW_MEM = (await postBuildImport)?.lowMemoryDevice(flag("lowmem"), flag("prepare") === "full");
const owedBeforeMatch = new Set<string>();
// ---- pre-ready stream (READY_BY above): largest first, each only while the predicted ready time still fits
if (streamOn && READY_BY > 0 && !LOW_MEM && postBuild) {
  const done = titleIds.filter((id) => buildMs[id] !== undefined);
  const want = done.reduce((a, id) => a + est(id), 0), got = done.reduce((a, id) => a + buildMs[id], 0);
  const factor = Math.min(3, Math.max(0.8, want > 0 ? got / want : 1));
  kr.bootFactor = +factor.toFixed(2);
  const planner = postBuild.preReadyPlanner(est, factor, READY_BY, EXPECT.afterBuild + EXPECT.game + EXPECT.settle, flag("readyest"));
  kr.postBuildEstimate = planner.estimate;
  const planned = planner.plan(streamList);
  planSteps(planned);
  kr.preReadyPlan = planned.slice();
  const pre: string[] = [];
  for (const id of planned) {
    if (!planner.fits(id, pre.length, pre.reduce((a, p) => a + buildMs[p], 0))) continue;
    streamList.splice(streamList.indexOf(id), 1);
    pre.push(id);
    await buildOne(id, false);
  }
  kr.preReady = pre;
  for (const id of planner.owed(streamList, pre.length)) owedBeforeMatch.add(id);
  kr.owedBeforeMatch = [...owedBeforeMatch];
}
kr.programsAfterTitleModules = engine.renderer.info.programs?.length;
enterStep("afterBuild");
const postMeasure = postBuild?.measurePostBuild(noFrameWaitCount);
// (before the game's prewarm: the post chain it compiles is the one the settings ask for)
try { display?.apply(); } catch (e) { report("display", e); }
for (const m of [...loaded]) await runAfterBuild(m, false);
for (const [id, m] of modOf) { registerStatics(id, false); registerFar(id, m, false); registerOcclusion(id, false); }
for (const id of rootsOf.keys()) engine.markBuilt(id);
if (streamOn) engine.openStream();

async function setView(id: string) {
  const spec = views[id];
  if (!spec) throw new Error(`unknown view ${id}`);
  applyView(engine.camera, spec, engine.terrain);
  if (spec.stage) for (const m of loaded) { try { await m.stage?.(engine, spec.stage); } catch (e) { report(`stage:${m.id}`, e); } }
  if (spec.t !== undefined) engine.time = spec.t;
}
kr.setView = setView;

if (!gameMode) {
  kr.stage = "view";
  try {
    if (camArg) {
      const spec = parseCam(camArg);
      if (!spec) throw new Error(`bad ?cam=${camArg}`);
      applyView(engine.camera, spec, engine.terrain);
    } else await setView(viewId!);
  } catch (e) { report("view", e); }
  kr.showImpostors = async () => (await postBuildImport)?.showImpostors(engine, world);
  if (flag("fly")) void import("./engine/dev-probes").then((m) => m.enableFly(engine.camera, canvas, (fn) => engine.onUpdate(fn)), (e) => report("fly", e));
  engine.start();
} else {
  kr.stage = "game";
  enterStep("game");
  try {
    const game = await gameImport!;
    await game.startGame(engine, { views, modules: loaded });
  } catch (e) { bootFail("game", e); }
}

// ---- readiness: all holds released, then let a few frames settle (shadows, env, shader compiles)
kr.stage = "settle";
enterStep("settle");
const t0 = performance.now();
// game page: ONE offscreen first draw of every module built so far — every LOD level, hidden detail and the far detail
// the screen-size cull (engine/cull.ts) will skip included — so vertex buffers / VAOs / textures are on the GPU before
// the title shows, not uploaded on the frame a player first walks up to them (programs are compiled by now: the game's
// prewarm waited for the parallel compile). Streamed modules get the same draw when they are integrated.
if (gameMode) {
  const tw = performance.now();
  try { engine.warmDraw([...rootsOf.keys()].flatMap((id) => moduleRoots(id, false))); } catch (e) { report("warm", e); }
  kr.warmAllMs = Math.round(performance.now() - tw);
}
// the live title does not wait for what only a match shows (the HUD map image is painted in a worker: 2-3 s after the
// prewarm on a fast desktop), nor for the far big trees' splat bake: it is cosmetic, can outlast the 90 s budget on a
// slow GPU (~130 s on SwiftShader), and finishes after ready on its own (until then those trees are unlinked and not
// drawn; the bake re-links every pool, or falls back to impostor cards). View-camera pages (?view / ?cam / ?shot) wait
// for every hold.
const MATCH_ONLY_HOLDS = /^(ui:map|veg-impostors$)/;
const blocking = () => engine.pendingHolds().filter((h) => !(gameMode && MATCH_ONLY_HOLDS.test(h)));
kr.settleHolds = engine.pendingHolds();
// the 90 s budget counts only time the browser paints (a frame within the last 5 s): frame hooks release some holds
// (veg-impostors on view pages), and Safari paints nothing while its window is off screen — the player who comes back should find the
// load going on, not the reload card. A slow renderer (frames seconds apart) still counts.
let settling = true, paintedAt = performance.now(), heldMs = 0;
const watchPaint = () => { paintedAt = performance.now(); if (settling) requestAnimationFrame(watchPaint); };
requestAnimationFrame(watchPaint);
while (!kr.bootError && blocking().length && heldMs < 90_000) {
  const t = performance.now();
  await new Promise((r) => setTimeout(r, 50));
  if (performance.now() - paintedAt < 5_000) heldMs += performance.now() - t;
}
settling = false;
if (!kr.bootError && blocking().length) bootFail("ready", `timed out waiting for: ${blocking().join(", ")}`);
kr.settleHoldsMs = Math.round(performance.now() - t0);
const settleFrom = engine.frames;
// (a view-camera capture needs 20 frames: shadow cascades, TAA history, env; the live title needs a few — its first frames
// already ran inside the game's prewarm)
const SETTLE = gameMode ? 6 : 20;
while (!kr.bootError && engine.frames - settleFrom < SETTLE) await new Promise((r) => requestAnimationFrame(r));
kr.programsAtReady = engine.renderer.info.programs?.length;
kr.noFrameWaits = noFrameWaitCount();
postMeasure?.stop();
if (kr.bootError) {
  // a failed boot never becomes a playable "ready" title (the loading screen shows the reload card)
  kr.stage = "failed";
  document.documentElement.dataset.ready = "0";
} else {
  bootReady = true;
  kr.stage = "ready";
  kr.readyAt = Math.round(performance.now());
  postMeasure?.finish(kr, gameMode && streamOn);
  kr.ready = true;
  document.documentElement.dataset.ready = "1";
}
// DEV VIEW: ?dev=annotate opens it, ?dev alone waits for F8. Without ?dev nothing of it
// is fetched or run (a dynamic import behind the flag).
if (bootReady && flag("dev") !== null) {
  const go = () => import("./dev/annotate").then((m) => m.startDevView(kr as unknown as Parameters<typeof m.startDevView>[0])).catch((e) => report("devview", e));
  if (flag("dev") === "annotate") void go();
  else addEventListener("keydown", function f8(e) { if (e.code !== "F8") return; removeEventListener("keydown", f8); void go(); });
}
if (display && bootReady) void import("./ui/settings").then(({ createVideoMenu, mountVideoUi }) => {
  const menu = createVideoMenu(engine, display);
  const ui = mountVideoUi(engine, display, menu);
  kr.videoMenu = menu;
  display.apply();
  const first = display.firstVisit;
  // (automated tools — navigator.webdriver — get no toasts over their captures unless ?announce / ?guard asks for them)
  const bot = !!navigator.webdriver;
  void display.firstVisitBench().then(() => { if (first && !flag("noannounce") && (!bot || flag("announce"))) ui.announceAuto(); }).catch((e) => report("display-bench", e));
  if (!bot || flag("guard")) display.startGuard(inMatch);
  void import("./engine/res-guard").then((m) => m.startResGuard(engine), (e) => report("res-guard", e));
}).catch((e) => report("settings-ui", e));

// ---- stream the rest of the island in (game page)
let urgent = false;
/** a streamed module whose build (est, ms) is this long is built behind the PRACTICE card, never in the warm-up */
// (default: none — the match starts at once; a module that ignores the ctx.yield() contract then stalls warm-up frames,
// which the POI modules should fix. ?heavyms=1500 = build the heavy ones behind the card.)
const HEAVY_MS = flag("heavyms");
const beforeMatch = (id: string) => est(id) >= HEAVY_MS || owedBeforeMatch.has(id);
let streamNow: string | null = null;
/** while PRACTICE waits only for the game's prefab warm-up, the island stream holds between modules — the
 *  measured 5.5 s click → match was 2.7 s of prefab warm-up + a 2.2 s module build the card sat through */
let streamHold = false;
const streamDone: Promise<void> = streamOn ? stream() : Promise.resolve();
let streamFailed = false;
streamDone.catch((e) => { streamFailed = true; report("stream", e); });
if (!streamOn) { kr.streamed = true; engine.endStream(); startFarBuild(); }
/**
 * called by the game before a match can start (PRACTICE / CREATE / JOIN): resolves at once when the island is complete;
 * otherwise the rest of the stream (and the game's prefab warm-up) runs back to back behind a "preparing" card, so a
 * match never shows an unbuilt POI and never hitches on a module build.
 */
let preparing: Promise<void> | null = null;
kr.prepare = () => {
  const prefabs = kr.prefabWarmP as Promise<void> | undefined;
  if (kr.streamed && (!prefabs || kr.warmDone === true)) return Promise.resolve();
  // the warm-up happens on the lobby islet (a title
  // module), so the match does NOT wait for the whole island. Behind the card only the HEAVY modules still pending
  // (est ≥ HEAVY_MS — builds that are one long main-thread task today and would freeze the warm-up for 1-3 s) are built,
  // largest first, plus the game's prefab warm-up; the light rest streams in during the warm-up, time-sliced. The
  // offline host's warm-up clock is held until the island is complete, so the plane never flies over an unbuilt POI;
  // online, the plane phase switches the stream to back to back. ?prepare=full = build everything behind the card.
  if (flag("prepare") !== "full") {
    holdWarmupUntilStreamed();
    const heavyLeft = () => !kr.streamed && !streamFailed && (streamList.some(beforeMatch) || (streamNow !== null && beforeMatch(streamNow)));
    if (!heavyLeft() && (!prefabs || kr.warmDone === true)) return Promise.resolve();
    return (preparing ??= (async () => {
      const card = (await prepareCardImport).prepareCard(kr); const tick = setInterval(() => card.set(), 100);
      const t0 = performance.now();
      streamList.sort((a, b) => Number(beforeMatch(b)) - Number(beforeMatch(a)) || est(b) - est(a));
      urgent = true; kr.prepareUrgent = true; engine.sliceMs = 1e9; engine.suspended = true;
      try {
        while (heavyLeft()) await new Promise((r) => setTimeout(r, 30));
        // only the prefab warm-up left: the stream holds (it resumes, time-sliced, in the warm-up)
        urgent = false; streamHold = true; engine.sliceMs = 6;
        await prefabs;
      } catch (e) { report("prepare", e); }
      urgent = false; kr.prepareUrgent = false; engine.suspended = false;
      // the stream resumes once the match is in (else the next module's build — single tasks of up to 3 s today — runs
      // between the card and the match start: measured 7.5 s click → match)
      if (streamHold) { const t = performance.now(); const rel = () => { if (inMatch() || performance.now() - t > 4000) streamHold = false; else setTimeout(rel, 50); }; rel(); }
      clearInterval(tick); kr.prepareMs = Math.round(performance.now() - t0); card.remove(); preparing = null;
    })());
  }
  return (preparing ??= (async () => {
    urgent = true; kr.prepareUrgent = true;
    engine.sliceMs = 1e9;
    const card = (await prepareCardImport).prepareCard(kr);
    // the card covers the title: no title frames while the island finishes (the main thread goes to the stream)
    engine.suspended = true;
    const t0 = performance.now();
    const tick = setInterval(() => card.set(), 100);
    try { await streamDone; await prefabs; } catch (e) { report("prepare", e); }
    clearInterval(tick);
    engine.suspended = false;
    kr.prepareMs = Math.round(performance.now() - t0);
    card.remove();
    preparing = null;
  })());
};

let holding = 0;
function holdWarmupUntilStreamed() {
  if (holding || kr.streamed) return;
  kr.warmupHeld = 0;
  holding = window.setInterval(() => {
    if (kr.streamed) { clearInterval(holding); holding = 0; return; }
    const m = (kr.game as { link?: { host?: { m?: { phase: number; phaseT: number } } } } | undefined)?.link?.host?.m;
    if (!m || !inMatch()) return;
    const lim = WARMUP_S - 3;
    // (never past a full warm-up's plane time — Match.warmWall)
    if (m.phase === 0 && m.phaseT > lim && ((m as { warmWall?: number }).warmWall ?? 0) < WARMUP_S) { kr.warmupHeld = (kr.warmupHeld as number) + (m.phaseT - lim); m.phaseT = lim; }
  }, 100);
}

function startFarBuild() {
  engine.addIdle(() => engine.far.buildNext());
}

function inMatch(): boolean { return !!(kr.game as { inMatch?: boolean } | undefined)?.inMatch; }
/** ms of warm-up left before the plane (offline host; 0 when unknown / online) */
function warmLeftMs(): number {
  const m = (kr.game as { link?: { host?: { m?: { phase: number; warmWall?: number } } } } | undefined)?.link?.host?.m;
  return m && m.phase === 0 ? Math.max(0, (WARMUP_S - (m.warmWall ?? 0)) * 1000) : 0;
}
function matchPhase(): number { return ((kr.game as { cm?: { phase?: number } } | undefined)?.cm?.phase) ?? -1; }

async function stream(): Promise<void> {
  const s0 = performance.now();
  // nearest to the lobby islet (the title + warm-up camera) first: the island's south coast pops in before the north
  const islet = POIS.find((p) => p.id === "lobby-islet");
  const dist = (id: string) => { const p = POIS.find((x) => `poi:${x.id}` === id); return p && islet ? Math.hypot(p.x - islet.x, p.z - islet.z) : 1e9; };
  streamList.sort((a, b) => dist(a) - dist(b));
  // the HEAVY modules first (the PRACTICE card waits only for them — the longer the player stays in the title, the
  // likelier they are done), then nearest to the islet first
  streamList.sort((a, b) => Number(owedBeforeMatch.has(b)) - Number(owedBeforeMatch.has(a)) || (est(b) >= 1500 ? 1 : 0) - (est(a) >= 1500 ? 1 : 0));
  kr.streamTotal = streamList.length;
  kr.streamPending = () => streamList.slice();
  const streamMs: Record<string, number> = {};
  kr.streamMs = streamMs;
  const trim = (incoming: string | null) => postBuild!.trimStreamed(engine, world, incoming, streamList, streamMs, POIS);
  if (LOW_MEM) setInterval(() => void trim(null), 2000);
  const inflight: Promise<void>[] = [];
  // a grace of 2.5 s after ready before the first module build — several streamed POIs still build in single
  // 1-3 s tasks, and a PRACTICE click right at ready sat through one (measured 5.5-6.3 s click → match with a
  // 1.7-1.8 s card). A click in the grace holds the stream until the match is in; otherwise it starts 2.5 s later.
  { const graceUntil = performance.now() + flag("streamgrace");
    while (!urgent && !inMatch() && performance.now() < graceUntil) await new Promise((r) => setTimeout(r, 50)); }
  while (streamList.length || LOW_MEM) {
    const id = LOW_MEM ? await postBuild!.nextNearModule(streamList, engine.camera, POIS, flag("lowmemr"), flag("lowmemview")) : streamList.shift()!;
    if (LOW_MEM && id.startsWith("poi:")) await trim(id);
    streamNow = id;
    // in the title / lobby: one module per idle gap at the title's slice budget. In a match (warm-up) the plane must
    // not see an unbuilt POI: go flat out, and once the plane phase starts build the rest back to back.
    // title / lobby: one module per idle gap at the title's slice budget. Once a match waits for the island (__kr.prepare)
    // or — should one ever start on a half-built island — the plane phase begins: back to back.
    while (streamHold) await new Promise((r) => setTimeout(r, 30));
    // never back to back in a live match — the plane phase used to
    // switch to sliceMs 1e9 + urgent compiles / warm draws: 300-960 ms frames in the plane.
    // Only the PRACTICE card (urgent) goes flat out; a match keeps time-slicing (engine.streamSlice)
    const fast = urgent;
    engine.sliceMs = fast ? 1e9 : engine.streamSlice(inMatch(), matchPhase(), 1.4 * (est(id) + streamList.reduce((a, x) => a + est(x), 0)), warmLeftMs()); // (×1.4: + integration)
    if (!fast) await nextFrame();
    const t0 = performance.now();
    const { integrated } = await streamBuild(id, fast);
    const done = integrated.then(() => { streamMs[id] = Math.round(performance.now() - t0); });
    inflight.push(done);
    if (inflight.length > 1) await inflight.shift();
    if (beforeMatch(id)) await done; // (the PRACTICE card waits for the heavy ones — integrated, not just built)
    streamNow = null;
  }
  await Promise.all(inflight.splice(0));
  // the world is complete: every afterBuild once more (atmos shadow policy + far bake, water foam, veg programs)
  kr.streamStage = "afterBuild";
  for (const m of [...loaded]) { await runAfterBuild(m, true); if (!urgent && !inMatch()) await nextFrame(); }
  try { atmos()?.sweep?.(); } catch { /* reported by atmos */ }
  await integrateFresh(urgent);
  engine.sliceMs = 6;
  engine.endStream();
  kr.streamStage = "done";
  kr.streamedMs = Math.round(performance.now() - s0);
  kr.streamedAt = Math.round(performance.now());
  kr.streamed = true;
  startFarBuild();
}

/** a material hidden by an integrateFresh still in flight: its ORIGINAL visibility + how many
 *  integrations hold it. Two overlapping integrations (a streamed module + the match's urgent pass) both saw the not-yet
 *  compiled material, the second recorded `visible = false` (the first one's hiding) and restored THAT — Mist Falls' wood
 *  (all three bridges, the lookout) and its water stayed invisible for the whole session. */
const heldFresh = new Map<THREE.Material, { vis: boolean; n: number }>();
// materials in the scene when the context came back: their programs are gone, but they were shown before (or were about
// to be), so the next frame compiles them where they are instead of an integration hiding the whole world until it has
// compiled everything again. Integrations wait for the restore to finish, so this marking always comes first.
const drawnBeforeLoss = new WeakSet<THREE.Material>();
onRestore("source", () => engine.scene.traverse((o) => { const mm = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined; if (mm) for (const m of Array.isArray(mm) ? mm : [mm]) if (m) drawnBeforeLoss.add(m); }));
const holdFresh = (m: THREE.Material) => { const h = heldFresh.get(m); if (h) h.n++; else heldFresh.set(m, { vis: m.visible, n: 1 }); m.visible = false; };
const releaseFresh = (m: THREE.Material) => { const h = heldFresh.get(m); if (!h) return; if (--h.n <= 0) { heldFresh.delete(m); m.visible = h.vis; } };
/**
 * Materials that have never been compiled are hidden (material.visible = false), compiled in parallel against the
 * post chain's HDR target (KHR_parallel_shader_compile — the main thread never waits on the driver), first-used, their
 * textures uploaded one per slice, and only then shown. Nothing a streamed module adds can stall a frame.
 */
async function integrateFresh(urgent: boolean, roots: THREE.Object3D[] = [], buildGate?: Gate, openGate?: () => void) {
  while (!await integrateOnce(urgent, roots, buildGate, openGate));
}

async function integrateOnce(urgent: boolean, roots: THREE.Object3D[], buildGate?: Gate, openGate?: () => void): Promise<boolean> {
  while (engine.contextLost) await nextFrame();
  const r = engine.renderer;
  const props = r.properties as unknown as { get(o: object): Record<string, unknown> };
  const fresh = new Map<THREE.Material, boolean>();
  const objs: THREE.Object3D[] = [...roots];
  engine.scene.traverse((o) => {
    const mm = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (!mm) return;
    let isFresh = false;
    for (const m of Array.isArray(mm) ? mm : [mm]) {
      if (!m) continue;
      if (fresh.has(m)) { isFresh = true; continue; }
      const p = props.get(m);
      if (p.programs === undefined && p.currentProgram === undefined && !drawnBeforeLoss.has(m)) { fresh.set(m, m.visible); holdFresh(m); isFresh = true; }
    }
    if (isFresh) objs.push(o);
  });
  // materials the atmos sweep just patched that ALREADY had a program (drawn unpatched while their
  // module was still building — e.g. interiors added into already-integrated POI groups): their patched program is new,
  // and the next live frame compiled it synchronously (440-530 ms frames). Hidden + compiled like fresh ones.
  const repatched = new Set((engine.shared.get("atmos") as { drainPatched?: () => THREE.Material[] } | undefined)?.drainPatched?.() ?? []);
  if (repatched.size) engine.scene.traverse((o) => {
    const mm = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (!mm) return;
    let hit = false;
    for (const m of Array.isArray(mm) ? mm : [mm]) {
      if (!m || !repatched.has(m) || fresh.has(m)) continue;
      // (only when its current program is the UNPATCHED one — patched cache keys end in atmos' "|atmos21" tag)
      const cp = props.get(m).currentProgram as { cacheKey?: string } | undefined;
      if (!cp || String(cp.cacheKey ?? "").includes("atmos")) continue;
      hit = true; fresh.set(m, m.visible); holdFresh(m);
    }
    if (hit) objs.push(o);
  });
  if (!fresh.size && !roots.length) return true;
  // a context loss resets every program, so an integration in flight would wait on compiles that never finish and
  // keep its materials hidden: the restore resolves `restored`, this pass returns false, `finally` shows them again, and
  // integrateFresh runs a new pass on the restored context
  const epoch = contextEpoch();
  let onRestored = () => {};
  const restored = new Promise<void>((res) => { onRestored = res; });
  const stopWatching = onRestore("source", () => onRestored());
  const live = (p: Promise<unknown>) => Promise.race([p, restored]);
  const gone = () => contextEpoch() !== epoch;
  try {
    const t0 = performance.now();
    // compile (parallel, against the post chain's HDR target) this module's objects + everything holding a fresh material.
    // without KHR_parallel_shader_compile (Linux / ANGLE-Vulkan, some drivers) every compile is synchronous —
    // then the objects go in small batches between frames (the program cache makes repeats free), so a module's shaders
    // never freeze one frame for 0.5-2.7 s (measured in the warm-up)
    const parallel = !!r.getContext().getExtension("KHR_parallel_shader_compile");
    const tag = String(kr.streamStage ?? "").replace(/:(compile|draw|first-use|textures)$/, "");
    const phase = (p: string) => { if (tag.startsWith("integrate")) kr.streamStage = `${tag}:${p}`; };
    phase("compile");
    if (parallel || urgent) await live(engine.compileObjects(objs));
    else {
      const leaves: THREE.Object3D[] = [];
      // (each mesh once: `objs` holds the module roots AND the fresh objects below them)
      const selected = new Set<THREE.Object3D>();
      for (const o of objs) o.traverse((x) => { if ((x as THREE.Mesh).material && !selected.has(x)) { selected.add(x); leaves.push(x); } });
      // (smaller steps under a small slice — the plane / skydive run at 7 ms; bigger ones made 57-166 ms compile gaps)
      const cb = engine.sliceMs <= 8 ? 2 : 6;
      // (already flattened: compiling a leaf's children again would repeat them across batches)
      for (let i = 0; i < leaves.length && !gone(); i += cb) { await live(engine.compileObjects(leaves.slice(i, i + cb), false)); await engine.yield(); }
    }
    // textures FIRST, one per slice (a first draw uploads every texture it meets in that one task — the
    // hitch log had 130-320 ms 'integrate:*:draw' gaps in the warm-up and the plane), then the first draw in chunks of
    // ≤ 24 meshes (a top-level group can hold hundreds), then the programs' first use.
    if (gone()) return false;
    phase("textures");
    const seen = new Set<THREE.Texture>();
    const upload = (m: THREE.Material) => {
      const out: THREE.Texture[] = [];
      for (const v of Object.values(m as unknown as Record<string, unknown>)) {
        const t = v as THREE.Texture;
        if (!t || !t.isTexture || seen.has(t) || (t as unknown as { isRenderTargetTexture?: boolean }).isRenderTargetTexture) continue;
        seen.add(t);
        if (props.get(t).__webglTexture || !t.image) continue;
        out.push(t);
      }
      // (a ShaderMaterial keeps its textures in uniforms)
      const us = (m as THREE.ShaderMaterial).uniforms;
      if (us) for (const k in us) { const t = us[k]?.value as THREE.Texture | undefined; if (t && t.isTexture && !seen.has(t) && !(t as unknown as { isRenderTargetTexture?: boolean }).isRenderTargetTexture) { seen.add(t); if (!props.get(t).__webglTexture && t.image) out.push(t); } }
      return out;
    };
    for (const [m] of fresh) for (const t of upload(m)) { try { r.initTexture(t); } catch { /* skip */ } if (!urgent) await engine.yield(); }
    // first draw of this module's content (all LOD levels) offscreen: buffers / VAOs / first use, now — not on the frame the
    // player first looks at it (the arrival hitch). Restored before any frame runs.
    if (gone()) return false;
    phase("draw");
    if (roots.length) {
      // (a streamed module's build gate is still shut: open for each synchronous offscreen draw only)
      const warm = (c: THREE.Object3D[]) => { if (buildGate) buildGate.active = false; try { engine.warmDraw(c); } finally { if (buildGate) buildGate.active = true; } };
      if (urgent) warm(roots);
      else {
        await nextFrame();
        const chunks: THREE.Object3D[][] = [];
        let cur: THREE.Object3D[] = [], n = 0;
        const CH = engine.sliceMs <= 8 ? 12 : 24;
        // whole subtrees while they are small, their children otherwise (the mesh count bounds one warm draw)
        const meshes = (o: THREE.Object3D) => { let k = 0; o.traverse((x) => { if ((x as THREE.Mesh).isMesh) k++; }); return k; };
        const split = (o: THREE.Object3D) => {
          const k = meshes(o);
          if (k <= CH || !o.children.length) { if (n + k > CH && cur.length) { chunks.push(cur); cur = []; n = 0; } cur.push(o); n += k; return; }
          if ((o as THREE.Mesh).isMesh) { cur.push(o); n++; } // (its own draw; children follow)
          for (const c of o.children) split(c);
        };
        for (const root of roots) split(root);
        if (cur.length) chunks.push(cur);
        for (const c of chunks) { warm(c); await engine.yield(); }
      }
    }
    // first use: uniform / attribute tables of the new programs (a sync driver round trip — the compile is done now)
    if (gone()) return false;
    openGate?.();
    phase("first-use");
    for (const pr of (r.info.programs ?? []) as unknown as Array<{ getUniforms?: () => unknown; getAttributes?: () => unknown; isReady?: () => boolean }>) {
      try { if (!pr.isReady || pr.isReady()) { pr.getUniforms?.(); pr.getAttributes?.(); } } catch { /* reported by three */ }
      if (!urgent) await engine.yield();
    }
    // (what held a fresh material dissolves in instead of appearing in one frame — engine/cull.ts reveal)
    engine.cull.reveal(objs.slice(roots.length));
    const log = (kr.integrateLog as Array<unknown> | undefined) ?? (kr.integrateLog = []) as Array<unknown>;
    log.push({ materials: fresh.size, textures: seen.size, ms: Math.round(performance.now() - t0) });
    return true;

  } finally {
    stopWatching();
    for (const [m] of fresh) releaseFresh(m);
  }
}

function showError(msg: string) {
  let el = document.getElementById("kr-errors");
  if (!el) {
    el = document.createElement("pre");
    el.id = "kr-errors";
    el.style.cssText = "position:fixed;left:8px;bottom:8px;max-width:60vw;max-height:40vh;overflow:auto;margin:0;padding:8px 10px;background:rgba(120,0,0,.85);color:#fff;font:11px/1.35 ui-monospace,monospace;z-index:99;white-space:pre-wrap;pointer-events:none";   // never blocks clicks on the menus under it
    document.body.appendChild(el);
  }
  el.textContent += msg.slice(0, 600) + "\n";
}
