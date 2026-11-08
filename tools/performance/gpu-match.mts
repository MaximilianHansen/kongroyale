// Real-GPU, in-match frame timing: one seeded practice match (trios vs bots, seed 42) in Chrome on the machine's own
// GPU, measured with the game's normal requestAnimationFrame loop at a pinned video preset. Writes one
// kong-perf-result (schema.ts) per run; compare runs with compare.mts. The browser only loads the production server
// this script starts on 127.0.0.1 (AGENTS.md rule 7).
//
//   npx tsx tools/performance/gpu-match.mts --out reports/performance/gpu-base-1.json
//   npx tsx tools/performance/gpu-match.mts --root ../kong-cand --out reports/performance/gpu-cand-1.json
//
// Options: --root <checkout> (serve that checkout's dist/; build it first), --port 3031, --w 1920 --h 1080,
// --preset low|medium|high|epic (default high), --mode trios|solo, --pan-s 15 (seconds of scripted camera pan on the
// ground), --timeout-s 420 (whole match; 1800 with --route), --headed, --chrome <path> (else the installed Chrome channel),
// --angle d3d11|metal|vulkan|default (default: d3d11 on Windows, metal on macOS, vulkan on Linux),
// --shots <dir> (a screenshot per window), --trace <file> (a Chrome performance trace of the first --trace-s 30 s of
// the match), --census <file> (the per-draw cost census of each route segment, see below), --query "a=1&b=2" (extra URL
// flags, e.g. an A/B switch), --cpuprofile <dir> (a V8 CPU profile per route segment). --query, --trace and --shots are recorded in
// config, so runs that differ in them never mix. A software renderer (SwiftShader, llvmpipe, ...) fails the run.
//
// Interleave baseline and candidate runs yourself (base, cand, base, cand ...), five or more a side, one at a time:
// a GPU runs ONE timed job at a time.
//
// What is measured. A wrapper around Engine.step (the whole frame: update hooks, culling, the post chain) records, per
// frame: the rAF interval, the main-thread step time, and an EXT_disjoint_timer_query_webgl2 TIME_ELAPSED query around
// the frame's GL work. Results are read asynchronously (never a blocking read); every query that was in flight when
// GPU_DISJOINT_EXT reports a disjoint event is discarded, and a frame without a valid sample stays unmeasured, never 0.
// The engine's own timer (dynamic resolution) is off (?dynres=0), so queries never nest. The collector is armed before
// Play and decides the match boundary in the page: it times every frame and keeps the first one at whose end inMatch is
// true (enterMatch can run inside that step's update hooks or between frames, when the offline link pumps on a timer),
// so warmup-15s starts with the first, most expensive match frame.
//
// The route. Nothing moves the player but the match itself, so every run follows the same path: warm-up on the lobby
// islet (its first 15 s are the "slow start" window), the plane's chase camera across the island, the forced drop
// (freefall + glide), then a scripted constant-rate camera pan where the player lands. The only scripted inputs are
// JUMP, held from the moment the plane passes closest to the first safe circle, and the pan, which the page starts on
// the first frame the player stands on the ground in phase play and flags per frame. Each becomes one case:
//   gpu/match/warmup-15s   the first 15 s from the first match frame (island still streaming in)
//   gpu/match/plane        riding the plane once the island has streamed in (chase camera, ~720 m up)
//   gpu/match/descent      freefall + glide down to the ground
//   gpu/match/ground-pan   the first --pan-s seconds of frames with the 0.6 rad/s yaw pan active, at eye height
//
// --route tour replaces the pan with the play route in tour.mts: from landing on, the page drives the player through
// segments (sprinting through the densest town, a close fight with bots, a tuk-tuk across the island, a helicopter
// flight), teleporting between them on the in-page host, and each segment's measured part becomes gpu/tour/<id>.
// --segments a,b runs only those (a quicker A/B of one segment). --route survey teleports to every POI and pans 360
// degrees there (gpu/survey/<poi>), for finding the densest places by draw calls and triangles. Both routes add a
// per-frame attribution of the main thread: the practice host's simulation (link.pump, in and between frames), the
// client's prediction (cm.update), the game's per-frame update (render.update, with its actors and vehicles), the
// other update hooks, the streaming / idle work, culling and the render submit, plus draw calls, triangles, programs
// created on the frame, the JS heap, and Chrome's long-animation-frame script attribution. --software lets a
// software renderer run the route (it checks the route and the counts, never the timing).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { chromium, type Browser, type Page } from "playwright";
import { arg, env, save, source, stats } from "./common.mts";
import { pathToFileURL } from "node:url";
import { RESULT_SCHEMA, RESULT_VERSION, type CaseResult, type Metric, type RunResult, type Unit } from "./schema.ts";
import { TOUR, TOUR_VERSION, steer, tourRunner, type Segment } from "./tour.mts";

const root = path.resolve(arg("--root", "."));
const out = path.resolve(arg("--out", "reports/performance/gpu-match.json"));
const PORT = Number(arg("--port", "3031")), ORIGIN = "http://127.0.0.1:" + PORT;
const W = Number(arg("--w", "1920")), H = Number(arg("--h", "1080"));
const PRESET = arg("--preset", "high") as "low" | "medium" | "high" | "epic";
const MODE = arg("--mode", "trios") === "solo" ? "solo" : "trios";
const ROUTE = arg("--route", "pan") as "pan" | "tour" | "survey";
const SOFTWARE = process.argv.includes("--software");
const ONLY = arg("--segments", "").split(",").filter(Boolean);
const PAN_S = Number(arg("--pan-s", "15")), TIMEOUT_S = Number(arg("--timeout-s", ROUTE === "pan" ? "420" : "1800"));
const PAN_RATE = 0.6, PAN_PITCH = -0.08, SEED = 42, WARM_WINDOW_S = 15;
const HEADED = process.argv.includes("--headed");
const SHOTS = arg("--shots", ""), TRACE = arg("--trace", ""), TRACE_S = Number(arg("--trace-s", "30"));
const EXTRA = arg("--query", "");
const ANGLE = arg("--angle", process.platform === "win32" ? "d3d11" : process.platform === "darwin" ? "metal" : "vulkan");
const CHROME = arg("--chrome", process.env.KR_CHROME ?? "");
const K = await import(pathToFileURL(path.join(root, "shared/sim/const.ts")).href) as { PLANE_SPEED: number; MAX_HP: number; WEAPON_DEFS: Record<string, { mag: number; ammo: string }> };
const MAP = await import(pathToFileURL(path.join(root, "shared/world/map.ts")).href) as { WEAPONS: readonly string[]; POIS: Array<{ id: string; x: number; z: number }> };
const { ammoIndex } = await import(pathToFileURL(path.join(root, "shared/sim/player.ts")).href) as { ammoIndex: (a: string) => number };
const PLANE_SPEED = K.PLANE_SPEED;
if (!["pan", "tour", "survey"].includes(ROUTE)) throw Error("--route " + ROUTE + ": one of pan, tour, survey");
// the survey: a 360 degree pan at every POI's centre (on a software GPU, a fixed 12 frames per POI)
const SEGS: Segment[] = ROUTE === "survey"
  ? MAP.POIS.filter((p) => p.id !== "lobby-islet").map((p) => ({ id: p.id, kind: "look" as const, what: "a 360 degree pan at " + p.id + "'s centre", at: [p.x, p.z] as const, yaw: 0, path: [], seconds: 10, settleS: SOFTWARE ? 1 : 3, rate: (2 * Math.PI) / 10, ...(SOFTWARE ? { frames: 12 } : {}) })).filter((s) => !ONLY.length || ONLY.includes(s.id))
  : TOUR.filter((s) => !ONLY.length || ONLY.includes(s.id));
if (ROUTE !== "pan" && !SEGS.length) throw Error("--segments " + ONLY.join(",") + ": no such segment (" + (ROUTE === "survey" ? MAP.POIS.map((p) => p.id) : TOUR.map((s) => s.id)).join(", ") + ")");
if (!["low", "medium", "high", "epic"].includes(PRESET)) throw Error("--preset " + PRESET + ": one of low, medium, high, epic");
if (!fs.existsSync(path.join(root, "dist/index.html"))) throw Error(root + "/dist is missing: run npm run build in that checkout first");

const t0 = Date.now();
const { at: _at, ...base } = env();
const log = (m: string) => console.log(((Date.now() - t0) / 1000).toFixed(1).padStart(6) + "s  " + m);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FLAGS = [
  ...(ANGLE === "default" ? [] : ["--use-angle=" + ANGLE]), "--enable-gpu", "--ignore-gpu-blocklist",
  "--autoplay-policy=no-user-gesture-required",
  // a covered or unfocused window must not throttle rAF or timers mid-run
  "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
  // the route's attribution reads the JS heap every frame: exact numbers, not the bucketed default
  ...(ROUTE === "pan" ? [] : ["--enable-precise-memory-info"]), ...(SOFTWARE ? ["--enable-unsafe-swiftshader"] : []),
];
// the video settings the game reads at boot (engine/display.ts, localStorage "kr-video"): an explicit preset at 100 %
// 3D resolution, no dynamic resolution, uncapped (every display refresh), so every run renders the same work
const PRESETS = {
  low: { aa: "fxaa", shadows: "low", ao: false, post: "low", viewDist: "low", foliage: "low", effects: "low" },
  medium: { aa: "taa", shadows: "medium", ao: true, post: "medium", viewDist: "medium", foliage: "medium", effects: "medium" },
  high: { aa: "taa", shadows: "high", ao: true, post: "high", viewDist: "high", foliage: "high", effects: "high" },
  epic: { aa: "taa", shadows: "epic", ao: true, post: "epic", viewDist: "epic", foliage: "epic", effects: "epic" },
};
const VIDEO = { v: 2, preset: PRESET, auto: PRESET, res3d: 1, resUser: true, dynres: false, fpsCap: 0, fov: 72, showFps: false, ...PRESETS[PRESET] };
// --census <file>: the per-draw cost census (client/src/engine/draw-census.ts) over each route segment's measured frames,
// saved to <file>. The page is made cross-origin isolated (COOP + COEP added to every response it loads), so
// performance.now() resolves 5 us instead of 100 us. The census wraps every draw and GL call: its timings are for
// ranking draw classes, never for comparing with a run without it.
const CENSUS = arg("--census", "");
// --cpuprofile <dir>: a sampled V8 CPU profile of each route segment's run phase, <dir>/cpu-<segment>.cpuprofile (the
// profiler slows the page: read its shares, never its milliseconds against an unprofiled run)
const CPUPROF = arg("--cpuprofile", "");
if ((CPUPROF || CENSUS) && ROUTE === "pan") throw Error("--cpuprofile and --census work per route segment: use them with --route tour or survey");
const QUERY = "seed=" + SEED + "&dynres=0&dpr=1" + (CENSUS ? "&drawcensus" : "") + (EXTRA ? "&" + EXTRA : "");

// ---- server: the measured checkout's production entry point, loopback only
async function up() { try { return (await fetch(ORIGIN + "/", { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } }
if (await up()) throw Error("something already answers on " + ORIGIN + "; pick another --port");
const serverLog: string[] = [];
const server: ChildProcess = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
  cwd: root, env: { ...process.env, KR_SERVE: "1", KR_PORT: String(PORT), KR_HOST: "127.0.0.1" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
});
for (const s of [server.stdout!, server.stderr!]) s.on("data", (d: Buffer) => serverLog.push(...d.toString().split("\n").filter(Boolean)));
// wait for the exit, so a run started right after this one finds the port free
const stopServer = async () => {
  if (server.exitCode !== null || server.signalCode !== null) return;
  const gone = new Promise((r) => server.once("exit", r));
  server.kill();
  await Promise.race([gone, sleep(10_000)]);
};
process.on("exit", () => { if (server.exitCode === null) server.kill(); });
for (let i = 0; !(await up()); i++) {
  if (server.exitCode !== null || i > 120) throw Error("the server did not come up:\n" + serverLog.slice(-20).join("\n"));
  await sleep(500);
}
log("server up on " + ORIGIN + " (" + root + ")");

// ---- the in-page collector: typed arrays sized up front, so recording allocates nothing per frame
function install(cfg: { maxFrames: number; panRate: number; panPitch: number; planeSpeed: number; route: string }) {
  type GL2 = WebGL2RenderingContext;
  type Fn = (a?: unknown, b?: unknown, c?: unknown) => unknown;
  const kr = (window as unknown as { __kr: Record<string, any> }).__kr, e = kr.engine;
  const gl = e.renderer.getContext() as GL2;
  const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2") as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  const N = cfg.maxFrames, pan = cfg.route === "pan", AN = pan ? 0 : N;
  const f32 = () => new Float32Array(AN);
  const c = { arm: false, lineSeen: false, on: false, pan: false, panT0: 0, landed: false, n: 0, invalid: 0, disjoints: 0, timer: !!ext, jumping: false, jumpAt: null as null | Record<string, number>, T: new Float64Array(N), CPU: new Float32Array(N), GPU: new Float32Array(N).fill(-1), PH: new Int8Array(N).fill(-1), ST: new Int8Array(N).fill(-1), SR: new Int8Array(N), PN: new Int8Array(N),
    // the route: segment index and measured flag per frame, then the frame's attribution (ms unless named)
    SEG: new Int8Array(AN).fill(-1), MEAS: new Int8Array(AN), SIMIN: f32(), SIMOUT: f32(), ACK: f32(), PRED: f32(), RUPD: f32(), ACT: f32(), VEHU: f32(), HOOKS: f32(), IDLE: f32(), CULL: f32(), SUBMIT: f32(), CALLS: f32(), TRIS: f32(), PROGN: f32(), HEAP: f32(),
    loaf: [] as Array<Record<string, unknown>> };
  // attribution: the objects that do a frame's work are wrapped where they live (no game code changes). simOut is the
  // practice host's simulation run by its 8 ms timer between frames, charged to the next frame it delays; with the host
  // in its worker (?hostworker=1) it is what is left of the host on this thread, the delivery of the worker's messages.
  // ACK is the input-to-ack latency (ClientMatch.ackMs) of the newest input acknowledged during the frame, -1 = none
  const A = { simIn: 0, simOut: 0, pred: 0, rupd: 0, act: 0, vehu: 0, idle: 0, occ0: 0, cull1: 0, inStep: false, ackSeq: -1 };
  const timed = (o: Record<string, any> | null | undefined, name: string, add: (ms: number) => void) => {
    if (!o || o["__krTimed_" + name] || typeof o[name] !== "function") return;
    const f = o[name] as Fn; o["__krTimed_" + name] = true;
    o[name] = function (this: unknown, a?: unknown, b?: unknown, d?: unknown) { const t = performance.now(); try { return f.call(this, a, b, d); } finally { add(performance.now() - t); } };
  };
  const info = e.renderer.info;
  if (!pan) {
    info.autoReset = false;
    const wrapIdle = (fn: () => unknown) => () => { const t = performance.now(); try { return fn(); } finally { A.idle += performance.now() - t; } };
    const idle = e.idle as Array<() => unknown>;
    for (let i = 0; i < idle.length; i++) idle[i] = wrapIdle(idle[i]);
    const addIdle = e.addIdle as (fn: () => unknown) => void;
    e.addIdle = function (this: unknown, fn: () => unknown) { return addIdle.call(this, wrapIdle(fn)); };
    const occ = e.occlusion.update as Fn;
    e.occlusion.update = function (this: unknown, cam?: unknown) { if (A.inStep && !A.occ0) A.occ0 = performance.now(); return occ.call(this, cam); };
    const cull = e.cull.update as Fn;
    e.cull.update = function (this: unknown, cam?: unknown, h?: unknown) { const r = cull.call(this, cam, h); if (A.inStep) A.cull1 = performance.now(); return r; };
    if (PerformanceObserver.supportedEntryTypes?.includes("long-animation-frame")) {
      new PerformanceObserver((l) => {
        for (const en of l.getEntries() as unknown as Array<{ startTime: number; duration: number; blockingDuration: number; scripts: Array<{ sourceFunctionName: string; sourceURL: string; sourceCharPosition: number; duration: number; invoker: string }> }>) {
          if (!c.on || c.loaf.length >= 3000) continue;
          c.loaf.push({ t: en.startTime, dur: Math.round(en.duration), block: Math.round(en.blockingDuration), scripts: en.scripts.slice(0, 6).map((s) => ({ fn: s.sourceFunctionName, src: String(s.sourceURL || "").replace(/^.*\//, ""), pos: s.sourceCharPosition, dur: Math.round(s.duration), inv: String(s.invoker).slice(0, 60) })) });
        }
      }).observe({ type: "long-animation-frame", buffered: false });
    }
  }
  // pending queries and the frame each one timed (-1 = discard: a disjoint event happened while it was in flight;
  // -2 = a pre-match frame the collector dropped)
  const pq: WebGLQuery[] = [], pi: number[] = [], free: WebGLQuery[] = [];
  const step = e.step;
  e.step = function (dt: number) {
    const g = kr.game, cm = g?.cm;
    if (c.on && !c.pan && !c.landed && cm && cm.phase >= 2 && cm.pred.st === 0) { if (pan) { c.pan = true; c.panT0 = performance.now(); } else c.landed = true; }
    const panning = c.pan && !!cm && cm.pred.st === 0;
    if (panning) { g.input.yaw += cfg.panRate * Math.min(dt, 0.1); g.input.pitch = cfg.panPitch; }
    if (c.on && kr.tourTick) kr.tourTick(Math.min(dt, 0.1));
    // the drop: hold JUMP from the plane time at which its line passes closest to the first safe circle's centre (the
    // door opens at 6 s and the game ignores JUMP before that) until the player is out, so every run lands in the same
    // spot inside the circle. The player state can turn Plane a frame before the phase message brings the flight
    // line and start tick, so the jump waits until it has seen a valid line with planeT still short of tStar
    if (c.on && cm && cm.pred.st === 4) {
      const pl = cm.plane, tStar = ((cm.storm.cx - pl.x0) * pl.dx + (cm.storm.cz - pl.z0) * pl.dz) / cfg.planeSpeed;
      if (pl.dx * pl.dx + pl.dz * pl.dz > 0.5 && cm.planeT() < tStar) c.lineSeen = true;
      if (!c.jumping && c.lineSeen && cm.planeT() >= tStar) {
        const pp = { x: 0, z: 0 }; cm.planePos(pp);
        c.jumping = true; c.jumpAt = { x: Math.round(pp.x), z: Math.round(pp.z), cx: Math.round(cm.storm.cx), cz: Math.round(cm.storm.cz), tStar: +tStar.toFixed(2), planeT: +cm.planeT().toFixed(2) };
        dispatchEvent(new KeyboardEvent("keydown", { code: "Space", key: " " }));
      }
    } else if (c.jumping && cm) { c.jumping = false; dispatchEvent(new KeyboardEvent("keyup", { code: "Space", key: " " })); }
    if (ext && pq.length) {
      let avail = 0;
      while (avail < pq.length && gl.getQueryParameter(pq[avail], gl.QUERY_RESULT_AVAILABLE)) avail++;
      if (avail) {
        if (gl.getParameter(ext.GPU_DISJOINT_EXT)) { let hit = false; for (let k = 0; k < pi.length; k++) if (pi[k] >= 0) { pi[k] = -1; hit = true; } if (hit) c.disjoints++; }
        for (let k = 0; k < avail; k++) {
          const q = pq.shift()!, i = pi.shift()!;
          if (i >= 0) c.GPU[i] = (gl.getQueryParameter(q, gl.QUERY_RESULT) as number) / 1e6; else if (i === -1) c.invalid++;
          free.push(q);
        }
      }
    }
    if (!pan && g) {
      timed(g.link, "pump", (ms) => { if (A.inStep) A.simIn += ms; else A.simOut += ms; });
      timed(g.link, "deliver", (ms) => { if (A.inStep) A.simIn += ms; else A.simOut += ms; });
      timed(cm, "update", (ms) => { A.pred += ms; });
      const r = g.render;
      timed(r, "update", (ms) => { A.rupd += ms; }); timed(r, "updateActors", (ms) => { A.act += ms; }); timed(r, "updateVehicles", (ms) => { A.vehu += ms; });
    }
    if (!(c.on || c.arm) || c.n >= N) { A.simOut = 0; return step.call(this, dt); }
    const i = c.n++;
    const s0 = performance.now();
    c.T[i] = s0; c.PH[i] = cm?.phase ?? -1; c.ST[i] = cm?.pred.st ?? -1; c.SR[i] = kr.streamed ? 1 : 0; c.PN[i] = panning ? 1 : 0;
    let progs0 = 0;
    if (!pan) {
      const run = kr.tourRun; c.SEG[i] = run ? run.index : -1; c.MEAS[i] = run?.measuring ? 1 : 0;
      const dc = kr.drawCensus; if (dc) { dc.label = String(c.SEG[i]); dc.on = c.MEAS[i] === 1; }
      A.simIn = A.pred = A.rupd = A.act = A.vehu = A.idle = A.occ0 = A.cull1 = 0; A.inStep = true;
      info.reset(); progs0 = info.programs?.length ?? 0;
    }
    let q: WebGLQuery | null = null;
    if (ext && pq.length < 8) { q = free.pop() ?? gl.createQuery(); if (q) gl.beginQuery(ext.TIME_ELAPSED_EXT, q); }
    try { step.call(this, dt); }
    finally {
      if (q && ext) { gl.endQuery(ext.TIME_ELAPSED_EXT); pq.push(q); pi.push(i); }
      const s1 = performance.now();
      c.CPU[i] = s1 - s0;
      if (!pan) {
        A.inStep = false;
        c.SIMIN[i] = A.simIn; c.SIMOUT[i] = A.simOut; A.simOut = 0;
        const seq = cm ? cm.authSeq : -1; c.ACK[i] = cm && seq !== A.ackSeq && A.ackSeq >= 0 ? cm.ackMs : -1; A.ackSeq = seq; c.PRED[i] = A.pred; c.RUPD[i] = A.rupd; c.ACT[i] = A.act; c.VEHU[i] = A.vehu;
        c.IDLE[i] = A.idle; c.HOOKS[i] = A.occ0 ? A.occ0 - s0 - A.idle : 0; c.CULL[i] = A.occ0 && A.cull1 ? A.cull1 - A.occ0 : 0; c.SUBMIT[i] = A.cull1 ? s1 - A.cull1 : 0;
        c.CALLS[i] = info.render.calls; c.TRIS[i] = info.render.triangles; c.PROGN[i] = (info.programs?.length ?? 0) - progs0;
        c.HEAP[i] = ((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 1048576;
      }
      // armed, not yet in the match: keep this frame only if the match began during it, else give its slot back
      if (!c.on) {
        if (kr.game?.inMatch) { c.on = true; c.arm = false; }
        else { c.n = i; if (q && ext) pi[pi.length - 1] = -2; }
      }
    }
  };
  kr.gpuCollector = c;
}

// ---- the route (tour.mts) in the page: its runner drives GameInput the way a player's keys and mouse do, and its API
// moves things on the practice match's in-page host (an offline practice match: there is no server to touch)
function startTour(cfg: { segs: Segment[]; maxHp: number; ar: number; arMag: number; arAmmo: number }) {
  const kr = (window as unknown as { __kr: Record<string, any> }).__kr, g = kr.game, input = g.input;
  const fns = (globalThis as unknown as { __krTourFns: { steer: typeof steer; runner: typeof tourRunner } }).__krTourFns;
  // writes go through the link's host tools (client/src/game/host-tools.ts), reads through its host view: the same
  // ops whether the host runs in this tab or in its worker (?hostworker=1), where a write lands a message later and the
  // view is a copy a few ticks old
  const tool = (t: Record<string, unknown>) => g.link.hostTool({ ...t, pid: g.cm.me }), view = () => g.link.hostView();
  const me = () => view().players[g.cm.me];
  const alive = (q: Record<string, number>) => q.st !== 3 && q.st !== 5;
  const api = {
    pose() {
      const cm = g.cm, p = cm.pred, v = p.st === 8 ? cm.myVehicle() : null;
      return { x: p.x, y: p.y, z: p.z, ground: cm.world.ground(p.x, p.z), heading: v ? v.yaw : p.yaw, speed: v ? Math.abs(v.vf) : Math.hypot(p.vx, p.vz), riding: p.st === 8, onGround: p.st === 0 };
    },
    teleport(x: number, z: number, yaw: number) { tool({ op: "place", x, z, yaw }); input.yaw = yaw; },
    vehicle(kind: number, x: number, z: number) {
      let best = null as null | { x: number; y: number; z: number }, bd = Infinity;
      for (const v of view().vehs) if (v.st <= 2 && v.kind === kind && v.seats[0] < 0 && v.seats[1] < 0 && v.seats[2] < 0) { const d = Math.hypot(v.x - x, v.z - z); if (d < bd) { bd = d; best = { x: v.x, y: v.y, z: v.z }; } }
      return best;
    },
    bringBots(n: number, x: number, z: number, r0: number, r1: number) {
      const team = me()?.team;
      const foes = (view().players as Array<Record<string, any>>).filter((q) => q.bot && alive(q) && q.team !== team && q.st === 0).length;
      tool({ op: "bring", n, x, z, r0, r1 });
      return Math.min(n, foes);
    },
    enemy() {
      const p = me(); if (!p) return null;
      let best = null as null | { x: number; y: number; z: number }, bd = 60;
      for (const q of view().players as Array<Record<string, any>>) if (q.bot && alive(q) && q.team !== p.team) { const d = Math.hypot(q.x - p.x, q.z - p.z); if (d < bd) { bd = d; best = { x: q.x, y: q.y + 1.2, z: q.z }; } }
      return best;
    },
    heal() { if (g.cm.pred.hp < cfg.maxHp) tool({ op: "heal", hp: cfg.maxHp }); },
    arm() { tool({ op: "arm", weapon: cfg.ar, mag: cfg.arMag, ammo: cfg.arAmmo, reserve: 600 }); input.slotWanted = 0; },
  };
  const run = fns.runner(cfg.segs, api, fns.steer);
  const held = new Set<string>();
  const key = (code: string, on: boolean) => { if (on === held.has(code)) return; if (on) held.add(code); else held.delete(code); dispatchEvent(new KeyboardEvent(on ? "keydown" : "keyup", { code, key: code })); };
  kr.tourRun = run;
  kr.tourTick = (dt: number) => {
    if (run.done || !g.inMatch || !g.link?.hostTool) { for (const k of [...held]) key(k, false); input.fire = false; kr.tourTick = null; return; }
    const k = run.update(dt);
    key("KeyW", k.fwd); key("KeyS", k.back); key("KeyA", k.left); key("KeyD", k.right); key("Space", k.jump); key("KeyE", k.use); key("ShiftLeft", k.sprint || k.down);
    input.yaw = k.yaw; input.pitch = k.pitch;
    // firing needs a captured mouse (GameInput.engaged): the route plays as a player whose mouse is captured
    if (k.fire) input.locked = true;
    input.fire = k.fire;
  };
}

const browser: Browser = await chromium.launch({ executablePath: CHROME || undefined, channel: CHROME ? undefined : "chrome", headless: !HEADED, args: FLAGS, timeout: 120_000 });
const browserVersion = browser.version();
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
if (CENSUS) await ctx.route(ORIGIN + "/**", async (rt) => {
  const res = await rt.fetch(), headers = { ...res.headers(), "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp" };
  delete headers["content-encoding"]; delete headers["content-length"];
  await rt.fulfill({ response: res, headers });
});
await ctx.addInitScript((v) => { try { localStorage.setItem("kr-video", v); localStorage.setItem("kr-fov-moved", "1"); } catch { /* private mode */ } }, JSON.stringify(VIDEO));
// tsx compiles the page functions below with esbuild's keepNames, which calls a __name helper the page doesn't have
await ctx.addInitScript("globalThis.__name = (f) => f;");
const page: Page = await ctx.newPage();
const pageErrors: string[] = [];
page.on("pageerror", (e) => pageErrors.push(String(e.message).slice(0, 300)));
const errors: string[] = [];
const artifacts: string[] = [];
const shot = async (name: string) => {
  if (!SHOTS) return;
  const f = path.resolve(SHOTS, path.basename(out, ".json") + "-" + name + ".png");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  await page.screenshot({ path: f }).then(() => artifacts.push(f), () => { /* best effort */ });
};

let exitCode = 0;
const marks: Record<string, number> = {};
const route: Record<string, unknown> = {};
let pageInfo: Record<string, unknown> = {};
const ATTRIB = ["SEG", "MEAS", "SIMIN", "SIMOUT", "ACK", "PRED", "RUPD", "ACT", "VEHU", "HOOKS", "IDLE", "CULL", "SUBMIT", "CALLS", "TRIS", "PROGN", "HEAP"] as const;
type Series = Record<(typeof ATTRIB)[number], number[]>;
let data: ({ panT0: number; PN: number[]; n: number; invalid: number; disjoints: number; timer: boolean; T: number[]; CPU: number[]; GPU: number[]; PH: number[]; ST: number[]; SR: number[]; loaf: Array<{ t: number; dur: number; block: number; scripts: Array<Record<string, unknown>> }> } & Series) | null = null;
let tour: { results: Array<{ id: string; ok: boolean; stuck: number; skipped: number; waypoints: number; of: number; runS: number; note: string }>; log: string[] } | null = null;
try {
  const load0 = Date.now();
  await page.goto(ORIGIN + "/?" + QUERY, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.waitForFunction(() => (window as any).__kr?.ready === true || (window as any).__kr?.stage === "failed", null, { timeout: 300_000, polling: 250 });
  marks.readyWallMs = Date.now() - load0;
  pageInfo = await page.evaluate(() => {
    const kr = (window as any).__kr, r = kr.engine.renderer, gl = r.getContext() as WebGL2RenderingContext;
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    return {
      stage: kr.stage, renderer: String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)),
      vendor: String(dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR)),
      timerQuery: !!gl.getExtension("EXT_disjoint_timer_query_webgl2"), video: kr.display?.settings ?? null,
      canvas: [r.domElement.width, r.domElement.height], dpr: devicePixelRatio, dprBase: kr.engine.dprBase, refreshHz: kr.engine.refreshHz, ua: navigator.userAgent,
    };
  });
  log("ready in " + (marks.readyWallMs / 1000).toFixed(1) + " s on " + pageInfo.renderer + "; timer query " + pageInfo.timerQuery);
  if (pageInfo.stage === "failed") throw Error("boot failed");
  pageInfo.software = /swiftshader|llvmpipe|softpipe|software|microsoft basic/i.test(String(pageInfo.renderer));
  if (pageInfo.software && !SOFTWARE) throw Error("software renderer " + pageInfo.renderer + ": not a real-GPU run (--software checks the route, never the timing)");
  if (CENSUS) await page.evaluate(() => { const dc = (window as any).__kr.drawCensus; if (!dc) throw Error("?drawcensus did not install __kr.drawCensus"); dc.on = false; dc.reset(); });
  await page.evaluate(install, { maxFrames: Math.ceil(TIMEOUT_S * (ROUTE === "pan" ? 250 : 150)), panRate: PAN_RATE, panPitch: PAN_PITCH, planeSpeed: PLANE_SPEED, route: ROUTE });
  if (ROUTE !== "pan") await page.evaluate("globalThis.__krTourFns = { steer: " + steer.toString() + ", runner: " + tourRunner.toString() + " }");

  if (TRACE) await browser.startTracing(page, { path: TRACE, screenshots: false, categories: ["devtools.timeline", "disabled-by-default-devtools.timeline", "disabled-by-default-devtools.timeline.frame", "v8.execute", "blink.user_timing", "gpu", "disabled-by-default-v8.gc"] });
  const click0 = Date.now();
  await page.evaluate((m) => { (window as any).__kr.gpuCollector.arm = true; void (window as any).__kr.game.practice(m); }, MODE);
  await page.waitForFunction(() => (window as any).__kr.gpuCollector.on === true, null, { timeout: 300_000, polling: 50 });
  marks.playToMatchMs = Date.now() - click0;
  log("in match " + (marks.playToMatchMs / 1000).toFixed(1) + " s after Play");

  const read = () => page.evaluate(() => {
    const kr = (window as any).__kr, cm = kr.game.cm, run = kr.tourRun;
    return cm ? { pan: !!kr.gpuCollector.pan, landed: !!kr.gpuCollector.landed, phase: cm.phase as number, st: cm.pred.st as number, alive: cm.alive as number, streamed: !!kr.streamed, x: Math.round(cm.pred.x), z: Math.round(cm.pred.z), seg: run ? run.index as number : -1, segPhase: run ? run.phase as string : "", done: run ? !!run.done : false } : null;
  });
  const m0 = Date.now();
  let tracing = !!TRACE, landedAt = 0, last = "", lastSeg = "";
  const cdp = CPUPROF ? await ctx.newCDPSession(page) : null;
  let profiling = -1;
  const stopProfile = async () => {
    if (!cdp || profiling < 0) return;
    const { profile } = await cdp.send("Profiler.stop") as { profile: unknown };
    const f = path.resolve(CPUPROF, "cpu-" + SEGS[profiling].id + ".cpuprofile");
    fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(profile)); artifacts.push(f);
    profiling = -1;
  };
  if (cdp) { await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval: 200 }); }
  const seen = new Set<string>();
  for (;;) {
    const s = await read();
    const el = (Date.now() - m0) / 1000;
    if (tracing && el >= TRACE_S) { await browser.stopTracing(); tracing = false; artifacts.push(path.resolve(TRACE)); log("trace written " + TRACE); }
    if (s) {
      const tag = "phase " + s.phase + " st " + s.st;
      if (tag !== last) { last = tag; log(tag + " alive " + s.alive + " streamed " + s.streamed); }
      if (s.st === 4 && !seen.has("plane")) { seen.add("plane"); await sleep(8000); await shot("plane"); }
      if ((s.st === 1 || s.st === 2) && !seen.has("descent")) { seen.add("descent"); await sleep(3000); await shot("descent"); }
      if (ROUTE !== "pan") {
        if (s.landed && !landedAt) {
          landedAt = Date.now(); route.landed = { x: s.x, z: s.z };
          log("landed at " + s.x + ", " + s.z + ": the " + ROUTE + " starts (" + SEGS.map((q) => q.id).join(", ") + ")");
          await page.evaluate(startTour, { segs: SEGS, maxHp: K.MAX_HP, ar: MAP.WEAPONS.indexOf("ar"), arMag: K.WEAPON_DEFS.ar.mag, arAmmo: ammoIndex(K.WEAPON_DEFS.ar.ammo) });
        }
        const tag = s.seg + " " + s.segPhase;
        if (landedAt && tag !== lastSeg) {
          lastSeg = tag; log("  " + (SEGS[s.seg]?.id ?? "-") + " " + s.segPhase + " at " + s.x + ", " + s.z);
          if (cdp) { await stopProfile(); if (s.segPhase === "run") { await cdp.send("Profiler.start"); profiling = s.seg; } }
          if (s.segPhase === "run") { const at = s.seg; setTimeout(() => { void page.evaluate(() => (window as any).__kr.tourRun?.index).then((now) => now === at ? shot("tour-" + SEGS[at].id) : undefined).catch(() => {}); }, Math.min(8, SEGS[at].seconds / 2) * 1000); }
        }
        if (s.done) { await stopProfile(); await sleep(500); break; }
        if (landedAt && s.phase >= 3) { errors.push("the match ended at " + el.toFixed(0) + " s, in " + (SEGS[s.seg]?.id ?? "-") + ": run fewer --segments per match"); break; }
      } else if (s.pan && !landedAt) {
        landedAt = Date.now(); route.landed = { x: s.x, z: s.z };
        route.jump = await page.evaluate(() => (window as any).__kr.gpuCollector.jumpAt);
        log("landed at " + s.x + ", " + s.z + " (jumped at " + JSON.stringify(route.jump) + "): camera pan");
      }
      if (s.st === 3 || s.st === 5) { errors.push("the player died at " + el.toFixed(0) + " s; the ground window may be short"); break; }
    }
    if (ROUTE === "pan" && landedAt && Date.now() - landedAt >= PAN_S * 1000) { await shot("ground-pan"); break; }
    if (el > TIMEOUT_S) { errors.push("timed out after " + TIMEOUT_S + " s (last " + last + ")"); break; }
    await sleep(250);
  }
  if (tracing) { await browser.stopTracing(); artifacts.push(path.resolve(TRACE)); }
  data = await page.evaluate((names) => {
    const c = (window as any).__kr.gpuCollector; c.on = false; c.pan = false;
    const n = c.n, a = (x: ArrayLike<number>) => Array.from(x).slice(0, n);
    const attrib: Record<string, number[]> = {}; for (const k of names) attrib[k] = a(c[k]);
    return { panT0: c.panT0 as number, PN: a(c.PN), n, invalid: c.invalid, disjoints: c.disjoints, timer: c.timer, T: a(c.T), CPU: a(c.CPU), GPU: a(c.GPU), PH: a(c.PH), ST: a(c.ST), SR: a(c.SR), loaf: c.loaf, ...attrib } as any;
  }, [...ATTRIB]);
  if (CENSUS) {
    const rep = await page.evaluate(() => (window as any).__kr.drawCensus.report()) as Record<string, unknown>;
    const named: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rep)) named[/^\d+$/.test(k) ? SEGS[Number(k)]?.id ?? k : k] = v;
    fs.mkdirSync(path.dirname(path.resolve(CENSUS)), { recursive: true });
    fs.writeFileSync(path.resolve(CENSUS), JSON.stringify({ query: QUERY, preset: PRESET, viewport: W + "x" + H, ...named }, null, 1));
    artifacts.push(path.resolve(CENSUS));
  }
  if (ROUTE !== "pan") tour = await page.evaluate(() => { const r = (window as any).__kr.tourRun; return r ? { results: r.results, log: r.log } : null; });
  pageInfo.krErrors = await page.evaluate(() => (window as any).__kr.errors.slice(0, 20));
  pageInfo.renderScale = await page.evaluate(() => (window as any).__kr.engine.renderScale);
  pageInfo.streamedAt = await page.evaluate(() => (window as any).__kr.streamedAt ?? null);
  pageInfo.refreshHzEnd = await page.evaluate(() => (window as any).__kr.engine.refreshHz);
} catch (e) {
  errors.push("harness: " + (e instanceof Error ? e.message.split("\n")[0] : String(e)));
  exitCode = 1;
} finally {
  await browser.close().catch(() => { /* already gone */ });
  await stopServer();
}

// ---- windows -> cases
const WINDOW_DEF: Record<string, string> = {
  "gpu/match/warmup-15s": "first " + WARM_WINDOW_S + " s from the first match frame, the first frame at whose end inMatch is true (lobby islet, island streaming)",
  "gpu/match/plane": "player state Plane (chase camera) once the island has finished streaming in",
  "gpu/match/descent": "player state Freefall or Glide",
  "gpu/match/ground-pan": "frames with the scripted " + PAN_RATE + " rad/s yaw pan active (player state Ground in phase play), the first " + PAN_S + " s of them",
};
const ms = (v: number[]): Metric => v.length ? { status: "ok", unit: "ms", better: "lower", summary: stats(v) } : { status: "invalid", unit: "ms", reason: "no frames in this window" };
function caseFor(id: string, version: number, idx: number[]): CaseResult {
  const d = data!, inWin = new Set(idx);
  const iv: number[] = [], gpu: number[] = [], cpu: number[] = [];
  for (const i of idx) { if (inWin.has(i - 1)) iv.push(d.T[i] - d.T[i - 1]); cpu.push(d.CPU[i]); if (d.GPU[i] >= 0) gpu.push(d.GPU[i]); }
  const secs = idx.length ? (d.T[idx[idx.length - 1]] - d.T[idx[0]]) / 1000 : 0;
  const coverage = idx.length ? gpu.length / idx.length : 0;
  const metrics: Record<string, Metric> = {
    frameIntervalMs: ms(iv),
    gpuFrameMs: !d.timer ? { status: "unsupported", unit: "ms", reason: "EXT_disjoint_timer_query_webgl2 is not exposed" } : gpu.length ? ms(gpu) : { status: "invalid", unit: "ms", reason: "no valid timer samples" },
    cpuStepMs: ms(cpu),
    fps: iv.length ? { status: "ok", unit: "1/s", better: "higher", value: iv.length / (iv.reduce((a, b) => a + b, 0) / 1000) } : { status: "invalid", unit: "1/s", reason: "no frames" },
    framesOver33ms: { status: "ok", unit: "count", better: "lower", value: iv.filter((x) => x > 1000 / 30).length },
    framesOver100ms: { status: "ok", unit: "count", better: "lower", value: iv.filter((x) => x > 100).length },
  };
  return {
    scenario: { id, version, seed: SEED, workload: "real-play" },
    windows: { seconds: +secs.toFixed(2), frames: idx.length, definition: WINDOW_DEF[id] },
    load: { frames: idx.length, gpuSamples: gpu.length },
    metrics,
    gates: [
      { id: "gpuTimerCoverage", pass: !d.timer || coverage >= 0.5, detail: gpu.length + "/" + idx.length + " frames have a valid GPU sample (" + (coverage * 100).toFixed(0) + " %)" },
      { id: "windowLongEnough", pass: secs >= 5, detail: secs.toFixed(1) + " s" },
    ],
  };
}
/** a route segment's case: the frame metrics, then where the main thread's time went and what the GPU was asked to draw */
const longFrames: Record<string, Array<{ fn: string; ms: number; n: number }>> = {};
function routeCase(seg: Segment, k: number, idx: number[]): CaseResult {
  const d = data!, id = (ROUTE === "survey" ? "gpu/survey/" : "gpu/tour/") + seg.id;
  const c = caseFor(id, TOUR_VERSION, idx);
  c.windows.definition = seg.what + (ROUTE === "tour" ? " (" + seg.kind + "; the " + seg.settleS + " s after the teleport are not measured)" : "");
  const col = (f: (i: number) => number) => idx.map(f);
  const dist = (v: number[], unit: Unit = "ms"): Metric => v.length ? { status: "ok", unit, better: "lower", summary: stats(v) } : { status: "invalid", unit, reason: "no frames" };
  const secs = Number(c.windows.seconds) || 1;
  let alloc = 0, gcs = 0;
  for (const i of idx) { if (i === 0 || d.SEG[i - 1] !== k || d.MEAS[i - 1] !== 1) continue; const dh = d.HEAP[i] - d.HEAP[i - 1]; if (dh > 0) alloc += dh; else if (dh < -1) gcs++; }
  // long animation frames (> 50 ms) that ended inside the window: the scripts Chrome blames, by function
  const inWin = new Set(idx), byFn = new Map<string, { ms: number; n: number }>();
  let longN = 0;
  for (const L of d.loaf) {
    let lo = 0, hi = d.n - 1; const end = L.t + L.dur; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (d.T[mid] <= end) lo = mid; else hi = mid - 1; }
    if (!inWin.has(lo)) continue; longN++;
    for (const s of L.scripts) { const key = (s.fn || "(anonymous)") + " " + s.src + ":" + s.pos + " " + s.inv; const e = byFn.get(key) ?? { ms: 0, n: 0 }; e.ms += Number(s.dur); e.n++; byFn.set(key, e); }
  }
  longFrames[id] = [...byFn].sort((a, b) => b[1].ms - a[1].ms).slice(0, 8).map(([fn, v]) => ({ fn, ms: v.ms, n: v.n }));
  const attribution: Record<string, Metric> = {
    mainThreadMs: dist(col((i) => d.CPU[i] + d.SIMOUT[i])),
    simMs: dist(col((i) => d.SIMIN[i] + d.SIMOUT[i])),
    inputAckMs: dist(idx.filter((i) => d.ACK[i] >= 0).map((i) => d.ACK[i])),
    predictionMs: dist(col((i) => d.PRED[i])),
    actorsMs: dist(col((i) => d.ACT[i])),
    vehiclesMs: dist(col((i) => d.VEHU[i])),
    gameUpdateRestMs: dist(col((i) => Math.max(0, d.RUPD[i] - d.ACT[i] - d.VEHU[i]))),
    otherHooksMs: dist(col((i) => Math.max(0, d.HOOKS[i] - d.SIMIN[i] - d.PRED[i] - d.RUPD[i]))),
    streamIdleMs: dist(col((i) => d.IDLE[i])),
    cullMs: dist(col((i) => d.CULL[i])),
    submitMs: dist(col((i) => d.SUBMIT[i])),
    drawCalls: dist(col((i) => d.CALLS[i]), "count"),
    triangles: dist(col((i) => d.TRIS[i]), "count"),
    newPrograms: { status: "ok", unit: "count", better: "lower", value: idx.reduce((s, i) => s + d.PROGN[i], 0) },
    heapAllocRate: { status: "ok", unit: "bytes/s", better: "lower", value: Math.round((alloc * 1048576) / secs) },
    gcEvents: { status: "ok", unit: "count", better: "lower", value: gcs },
    longAnimationFrames: { status: "ok", unit: "count", better: "lower", value: longN },
  };
  Object.assign(c.metrics, attribution);
  const r = tour?.results[k];
  c.gates.push({ id: "routeFollowed", pass: !!r && r.ok, detail: r ? (r.ok ? "ok" : "not finished cleanly") + ": " + r.runS.toFixed(1) + " s, waypoints " + r.waypoints + "/" + r.of + ", stuck " + r.stuck + ", skipped " + r.skipped + (r.note ? ", " + r.note : "") : "the segment never ran" });
  if (ROUTE === "survey" && SOFTWARE) c.gates = c.gates.filter((g) => g.id !== "windowLongEnough");
  return c;
}
const cases: CaseResult[] = [];
if (data && data.n) {
  const d = data, idx = (f: (i: number) => boolean) => { const r: number[] = []; for (let i = 0; i < d.n; i++) if (f(i)) r.push(i); return r; };
  cases.push(caseFor("gpu/match/warmup-15s", 2, idx((i) => d.T[i] - d.T[0] <= WARM_WINDOW_S * 1000)));
  cases.push(caseFor("gpu/match/plane", 1, idx((i) => d.ST[i] === 4 && d.SR[i] === 1)));
  cases.push(caseFor("gpu/match/descent", 1, idx((i) => d.ST[i] === 1 || d.ST[i] === 2)));
  if (ROUTE === "pan") cases.push(caseFor("gpu/match/ground-pan", 2, idx((i) => d.PN[i] === 1 && d.T[i] - d.panT0 <= PAN_S * 1000)));
  else SEGS.forEach((s, k) => cases.push(routeCase(s, k, idx((i) => d.SEG[i] === k && d.MEAS[i] === 1))));
  const fmt = (m: Metric) => "summary" in m ? "p50 " + m.summary.p50.toFixed(2) + " p95 " + m.summary.p95.toFixed(2) + " p99 " + m.summary.p99.toFixed(2) : m.status;
  for (const c of cases) log(c.scenario.id + ": " + c.windows.seconds + " s, frame " + fmt(c.metrics.frameIntervalMs) + " | gpu " + fmt(c.metrics.gpuFrameMs) + " | " + c.gates.map((x) => x.id + " " + (x.pass ? "ok" : "FAIL")).join(", "));
}
const sh = (cmd: string, args: string[]) => { try { return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20_000 }).trim(); } catch { return ""; } };
const winInfo = process.platform === "win32" ? {
  powerScheme: sh("powercfg", ["/getactivescheme"]).replace(/^.*\(([^)]+)\).*$/s, "$1"),
  gpuDriver: sh("nvidia-smi", ["--query-gpu=driver_version", "--format=csv,noheader"]).split(/\r?\n/)[0] || null,
  onAC: sh("powershell.exe", ["-NoProfile", "-Command", "(Get-CimInstance Win32_Battery).BatteryStatus"]) === "2",
} : {};
const result: RunResult = {
  schema: RESULT_SCHEMA, version: RESULT_VERSION, tool: "tools/performance/gpu-match.mts", startedAt: new Date(t0).toISOString(), durationMs: Date.now() - t0,
  source: source(root), environment: { ...base, gpu: data ? String(pageInfo.renderer) : null },
  config: { browser: "chrome " + browserVersion, flags: FLAGS.join(" "), headless: !HEADED, viewport: W + "x" + H, dpr: 1, preset: PRESET, res3d: 1, dynres: false, fpsCap: "display refresh", mode: MODE, seed: SEED, ...(ROUTE === "pan" ? { panS: PAN_S } : { route: ROUTE, tourVersion: TOUR_VERSION, segments: SEGS.map((s) => s.id).join(","), software: SOFTWARE }), query: QUERY, cache: "fresh browser profile per run", ...(TRACE ? { traceS: TRACE_S } : {}), ...(SHOTS ? { shots: true } : {}), ...(CENSUS ? { census: true } : {}), ...(CPUPROF ? { cpuProfileUs: 200 } : {}) },
  cases, errors: [...errors, ...pageErrors.map((e) => "pageerror: " + e), ...((pageInfo.krErrors as string[] | undefined) ?? []).map((e) => "__kr.errors: " + e.split("\n")[0])], artifacts,
};
(result as unknown as Record<string, unknown>).detail = {
  marks, route, page: pageInfo, ...(ROUTE === "pan" ? {} : { tour, longFrames }), host: { hostname: os.hostname(), ...winInfo }, timer: data ? { invalid: data.invalid, disjoints: data.disjoints, frames: data.n } : null,
  // the raw per-frame series (ms since the first recorded frame; gpu -1 = no valid sample), for re-windowing later
  frames: data ? { t: data.T.map((x) => +(x - data!.T[0]).toFixed(2)), cpu: data.CPU.map((x) => +x.toFixed(3)), gpu: data.GPU.map((x) => +x.toFixed(3)), phase: data.PH, st: data.ST, streamed: data.SR, pan: data.PN,
    ...(ROUTE === "pan" ? {} : Object.fromEntries(ATTRIB.map((k) => [k.toLowerCase(), data![k].map((x) => +x.toFixed(3))]))) } : null,
};
save(out, result);
log("wrote " + out);
if (cases.some((c) => c.gates.some((g) => !g.pass)) || result.errors.length) exitCode = exitCode || 1;
process.exit(exitCode);
