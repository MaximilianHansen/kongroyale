// In-match frame timing at one fixed pose, in real Safari (safaridriver) or Chrome: a seeded practice match, the player
// teleported to a pose on the in-page host once the match reaches Play, a settle while that place streams in, then
// --hold-s seconds of frames standing still. It answers "why is it slow HERE" for a player report (a KONGBOT bundle
// gives the pose: ctx.game.player.pos / yawDeg / pitchDeg) and runs the same in every browser, so a Safari A/B needs no
// Chrome-only tooling. Writes one kong-perf-result (schema.ts) per run; compare runs with compare.mts. The browser only
// loads the production server this script starts on 127.0.0.1 (AGENTS.md rule 7).
//
//   npx tsx tools/performance/pose-hold.mts --browser safari --out reports/performance/hold-base-1.json
//   npx tsx tools/performance/pose-hold.mts --browser safari --query dpr=1 --out reports/performance/hold-dpr1-1.json
//
// Options: --browser safari|chrome|chromium (chromium = Playwright's own build; on a machine without a GPU add
// --software, which checks the route and the counts, never the timing), --root <checkout> (serve its dist/; build
// first), --port 3032, --viewport 1592x960 (CSS px; Safari renders at the display's own DPR, Chrome at --dpr 2),
// --preset low|medium|high|epic|auto (default high; auto leaves the game's own pick), --query "a=1&b=2" (extra URL
// flags), --pose x,z,yawDeg,pitchDeg (default: a pose at Banana Temple), --settle-s 20, --hold-s 10,
// --capture "<command>" (a shell command started when the match starts and stopped after the hold, e.g. a screen
// recorder, for the "while streaming" arm), --mode solo|trios, --seed 42, --ready-timeout-s 300, --play-timeout-s 300,
// --at-phase 2 (the match phase to teleport in: 2 = Play; 0 = the warm-up, a quick check of the harness itself).
//
// Interleave the arms yourself (a, b, a, b ...), five or more runs a side, one at a time: a GPU runs ONE timed job.
//
// What is measured. A wrapper around Engine.step records, per frame: the rAF interval, the main-thread step time, and
// renderer.info's draw calls, triangles, points and program count. Safari has no GPU timer query, so GPU time is not
// measured; attribute it with arms that remove one cost (?dpr=1 for pixels, ?vegsplat=0 for the far-tree splats).
// After the hold the engine is suspended for 180 frames (3 s at 60 Hz) and bare rAF intervals are recorded: the
// display's refresh as the browser paces it right now (a capture running or not), next to what engine.refreshHz
// measured. From the match
// start every frame also counts toward its match phase (fpsPhaseN, framesOver33msPhaseN), and the half-rate guard's
// steps (__kr.resLog, engine/res-guard.ts; add --query resguard=1, it is off under automation) are kept in
// detail.page.resLog and counted as resSteps.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { arg, env, save, source, stats } from "./common.mts";
import { RESULT_SCHEMA, RESULT_VERSION, type CaseResult, type Metric, type RunResult } from "./schema.ts";

const SCENARIO_VERSION = 1;
const BROWSER = arg("--browser", "safari") as "safari" | "chrome" | "chromium";
const root = path.resolve(arg("--root", "."));
const out = path.resolve(arg("--out", "reports/performance/pose-hold.json"));
const PORT = Number(arg("--port", "3032"));
const [VW, VH] = arg("--viewport", "1592x960").split("x").map(Number);
const PRESET = arg("--preset", "high");
const EXTRA = arg("--query", "");
const [PX, PZ, YAW_DEG, PITCH_DEG] = arg("--pose", "-41.83,-85.06,494.23,-0.13").split(",").map(Number);
const SETTLE_S = Number(arg("--settle-s", "20"));
const HOLD_S = Number(arg("--hold-s", "10"));
const CAPTURE = arg("--capture", "");
const MODE = arg("--mode", "solo");
const SEED = Number(arg("--seed", "42"));
const SOFTWARE = process.argv.includes("--software");
const SD_PORT = Number(arg("--safaridriver-port", "4472"));
const READY_S = Number(arg("--ready-timeout-s", "300"));
const PLAY_S = Number(arg("--play-timeout-s", "300"));
const AT_PHASE = Number(arg("--at-phase", "2"));
const ORIGIN = "http://127.0.0.1:" + PORT;
if (!["safari", "chrome", "chromium"].includes(BROWSER)) throw Error("--browser " + BROWSER + ": one of safari, chrome, chromium");
if (!["low", "medium", "high", "epic", "auto"].includes(PRESET)) throw Error("--preset " + PRESET + ": one of low, medium, high, epic, auto");
if (![PX, PZ, YAW_DEG, PITCH_DEG].every(Number.isFinite)) throw Error("--pose x,z,yawDeg,pitchDeg");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (s: string) => console.log("[pose-hold " + ((Date.now() - t0) / 1000).toFixed(0).padStart(4) + " s] " + s);

// the video settings the game reads at boot (engine/display.ts, localStorage "kr-video"): an explicit preset keeps
// 100 % 3D resolution and no dynamic resolution, as a player who picked it in the menu has; the display-refresh cap
const PRESETS: Record<string, Record<string, unknown>> = {
  low: { aa: "fxaa", shadows: "low", ao: false, post: "low", viewDist: "low", foliage: "low", effects: "low" },
  medium: { aa: "taa", shadows: "medium", ao: true, post: "medium", viewDist: "medium", foliage: "medium", effects: "medium" },
  high: { aa: "taa", shadows: "high", ao: true, post: "high", viewDist: "high", foliage: "high", effects: "high" },
  epic: { aa: "taa", shadows: "epic", ao: true, post: "epic", viewDist: "epic", foliage: "epic", effects: "epic" },
};
const VIDEO = PRESET === "auto" ? null : { v: 2, preset: PRESET, auto: PRESET, res3d: 1, dynres: false, fpsCap: -1, fov: 72, showFps: false, ...PRESETS[PRESET] };
const QUERY = "seed=" + SEED + (EXTRA ? "&" + EXTRA : "");

// ---- page scripts (plain JS strings: WebDriver's execute/sync and Playwright's evaluate both take them)
const SET_VIDEO = (v: unknown) => "(() => { localStorage.clear(); " + (v ? "localStorage.setItem('kr-video', " + JSON.stringify(JSON.stringify(v)) + "); localStorage.setItem('kr-fov-moved', '1'); " : "") + "return 'ok'; })()";
const STATUS = `JSON.stringify((() => { const k = window.__kr; if (!k) return { ready: false, stage: "" }; const g = k.game, cm = g && g.cm;
  return { ready: !!k.ready, stage: String(k.stage || ""), inMatch: !!(g && g.inMatch), phase: cm ? cm.phase : -1, st: cm && cm.pred ? cm.pred.st : -1,
    x: cm && cm.pred ? cm.pred.x : 0, z: cm && cm.pred ? cm.pred.z : 0, programs: k.engine ? (k.engine.renderer.info.programs || []).length : 0,
    stream: String(k.streamStage || ""), streamed: !!k.streamed }; })())`;
const INSTALL = `(() => {
  const k = window.__kr, e = k.engine, info = e.renderer.info, N = 20000;
  const c = { on: false, n: 0, T: new Float64Array(N), CPU: new Float32Array(N), CALLS: new Float32Array(N), TRIS: new Float32Array(N), PTS: new Float32Array(N), PROG: new Float32Array(N), last: 0, phaseOn: true, phases: {} };
  e.hitchLog = [];
  const step = e.step;
  e.step = function (dt) {
    // renderer.info resets on every render() call (the post chain makes many): count the whole frame instead
    const s0 = performance.now(), ar = info.autoReset, g = k.game, ph = g && g.inMatch && g.cm ? g.cm.phase : -1;
    // every frame from the match start on, by match phase: [frames, ms, frames over 33 ms]
    if (c.phaseOn && c.last && ph >= 0) { const d = s0 - c.last, a = c.phases[ph] || (c.phases[ph] = [0, 0, 0]); a[0]++; a[1] += d; if (d > 1000 / 30) a[2]++; }
    c.last = s0;
    if (c.on) { info.autoReset = false; info.reset(); }
    try { step.call(this, dt); }
    finally {
      info.autoReset = ar;
      if (c.on && c.n < N) { const i = c.n++; c.T[i] = s0; c.CPU[i] = performance.now() - s0; c.CALLS[i] = info.render.calls; c.TRIS[i] = info.render.triangles; c.PTS[i] = info.render.points; c.PROG[i] = (info.programs || []).length; }
    }
  };
  k.holdC = c;
  return "ok";
})()`;
const START = (mode: string) => "(() => { window.__kr.game.practice(" + JSON.stringify(mode) + "); return 'ok'; })()";
// place the player on the practice match's in-page host (as gpu-match's tour does) and point the view; healed so a bot
// or the storm can't end the hold
const PLACE = (x: number, z: number, yaw: number, pitch: number) => `(() => {
  const g = window.__kr.game, m = g.link && g.link.match; if (!m) return "no host";
  const q = m.players[g.cm.me], w = m.world;
  w.velY = 0; w.resolveCapsule(${x}, Math.max(w.ground(${x}, ${z}), 0) + 0.05, ${z}, 0.4, 1.8, false);
  q.x = w.P[0]; q.y = w.P[1]; q.z = w.P[2]; q.vx = q.vy = q.vz = 0; q.grounded = true; q.st = 0; q.yaw = ${yaw};
  g.input.yaw = ${yaw}; g.input.pitch = ${pitch};
  return "ok";
})()`;
const KEEP = (yaw: number, pitch: number) => "(() => { const g = window.__kr.game, m = g.link && g.link.match; if (!m) return 'no host'; const q = m.players[g.cm.me]; q.hp = Math.max(q.hp, 90); g.input.yaw = " + yaw + "; g.input.pitch = " + pitch + "; return 'ok'; })()";
// the phase counters stop with the hold, so the rAF probe's suspended frames after it count toward no phase
const COLLECT = (on: boolean) => "(() => { const c = window.__kr.holdC; c.on = " + on + "; " + (on ? "" : "c.phaseOn = false; ") + "return String(c.n); })()";
const RAF_PROBE = "(() => { const e = window.__kr.engine; e.suspended = true; const d = []; let last = 0; const f = (t) => { if (last) d.push(t - last); last = t; if (d.length < 180) requestAnimationFrame(f); else { e.suspended = false; window.__kr.rafProbe = d; } }; requestAnimationFrame(f); return 'ok'; })()";
const READ = `JSON.stringify((() => {
  const k = window.__kr, c = k.holdC, e = k.engine, r = e.renderer, gl = r.getContext(), n = c.n, a = (x) => Array.from(x).slice(0, n);
  const dbg = gl.getExtension("WEBGL_debug_renderer_info"), d = k.display;
  const veg = k.veg && k.veg.splats ? { big: k.veg.splats.drawn, bigPoints: k.veg.splats.points, small: k.veg.splatsSmall ? k.veg.splatsSmall.drawn : null, smallPoints: k.veg.splatsSmall ? k.veg.splatsSmall.points : null } : null;
  return { n, T: a(c.T), CPU: a(c.CPU), CALLS: a(c.CALLS), TRIS: a(c.TRIS), PTS: a(c.PTS), PROG: a(c.PROG),
    renderer: String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)), timerQuery: !!gl.getExtension("EXT_disjoint_timer_query_webgl2"),
    parallelCompile: !!gl.getExtension("KHR_parallel_shader_compile"), canvas: [r.domElement.width, r.domElement.height], dpr: devicePixelRatio, dprBase: e.dprBase,
    renderScale: e.renderScale, refreshHz: e.refreshHz, dynamicRes: e.dynamicRes, video: d ? d.settings : null, gpuLevel: d ? d.gpuLevel : null,
    gpuScore: (() => { try { return JSON.parse(localStorage.getItem("kr-gpu-score") || "null"); } catch (x) { return null; } })(),
    programsAtReady: k.programsAtReady ?? null, programs: (r.info.programs || []).length, programNames: (r.info.programs || []).map((p) => p.name + "|" + String(p.cacheKey || "").slice(0, 80)),
    geometries: r.info.memory.geometries, textures: r.info.memory.textures,
    newPrograms: e.newPrograms.map((p) => ({ at: p.at, ms: p.ms, stream: p.stream, programs: p.programs })), hitches: (e.hitchLog || []).slice(-200), rafProbe: k.rafProbe || null, phases: c.phases, resLog: k.resLog || null,
    veg, errors: (k.errors || []).slice(0, 20).map(String), ua: navigator.userAgent, inner: [innerWidth, innerHeight], pos: k.game.cm ? [k.game.cm.pred.x, k.game.cm.pred.y, k.game.cm.pred.z] : null };
})())`;

// ---- drivers
interface Driver { version: string; open(url: string): Promise<void>; run(expr: string): Promise<string>; shot(file: string): Promise<void>; close(): Promise<void> }
const SAFARIDRIVER = ["/System/Cryptexes/App/usr/bin/safaridriver", "/usr/bin/safaridriver"].find((p) => fs.existsSync(p)) ?? "safaridriver";
async function safari(): Promise<Driver> {
  const base = "http://127.0.0.1:" + SD_PORT;
  const proc = spawn(SAFARIDRIVER, ["-p", String(SD_PORT)], { stdio: "ignore" });
  const wd = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(base + p, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = (await r.json()) as { value: { error?: string; message?: string } & Record<string, unknown> };
    if (j.value && j.value.error) throw new Error("safaridriver " + method + " " + p + ": " + j.value.error + ": " + j.value.message);
    return j.value as any;
  };
  for (let i = 0; i < 40; i++) { try { await wd("GET", "/status"); break; } catch { await sleep(250); } }
  const s = await wd("POST", "/session", { capabilities: { alwaysMatch: { browserName: "safari" } } });
  const sid = "/session/" + s.sessionId;
  try {
    await wd("POST", sid + "/timeouts", { script: 120_000, pageLoad: 300_000, implicit: 0 });
    await wd("POST", sid + "/url", { url: ORIGIN + "/__pose-hold-blank" });
    let w = VW, h = VH + 100;
    for (let i = 0; i < 3; i++) {
      await wd("POST", sid + "/window/rect", { x: 0, y: 0, width: w, height: h });
      const [iw, ih] = JSON.parse(await wd("POST", sid + "/execute/sync", { script: "return JSON.stringify([innerWidth, innerHeight])", args: [] })) as number[];
      if (iw === VW && ih === VH) break;
      w += VW - iw; h += VH - ih;
    }
  } catch (e) { await wd("DELETE", sid).catch(() => { /* gone */ }); proc.kill(); throw e; }
  return {
    version: String(s.capabilities?.browserVersion ?? "?"),
    open: async (url) => { await wd("POST", sid + "/url", { url }); },
    run: async (expr) => String(await wd("POST", sid + "/execute/sync", { script: "return " + expr, args: [] })),
    shot: async (file) => { fs.writeFileSync(file, Buffer.from(String(await wd("GET", sid + "/screenshot")), "base64")); },
    close: async () => { try { await wd("DELETE", sid); } catch { /* gone */ } proc.kill(); },
  };
}
async function chromium(kind: "chrome" | "chromium"): Promise<Driver> {
  const pw = await import("playwright");
  const angle = SOFTWARE ? "swiftshader" : process.platform === "darwin" ? "metal" : process.platform === "win32" ? "d3d11" : "vulkan";
  const b = await pw.chromium.launch({ channel: kind === "chrome" ? "chrome" : undefined, headless: !process.argv.includes("--headed"), args: ["--use-angle=" + angle, "--enable-gpu", "--ignore-gpu-blocklist", ...(SOFTWARE ? ["--enable-unsafe-swiftshader"] : []), "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"] });
  const ctx = await b.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: Number(arg("--dpr", "2")) });
  const page = await ctx.newPage();
  await page.goto(ORIGIN + "/__pose-hold-blank");
  return { version: b.version(), open: async (u) => { await page.goto(u, { waitUntil: "commit", timeout: 120_000 }); }, run: (x) => page.evaluate(x) as Promise<string>, shot: async (f) => { await page.screenshot({ path: f }); }, close: async () => { await b.close(); } };
}

// ---- server: the measured checkout's production entry point, loopback only
async function up() { try { return (await fetch(ORIGIN + "/", { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } }
if (await up()) throw Error("something already answers on " + ORIGIN + "; pick another --port");
const server: ChildProcess = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], { cwd: root, env: { ...process.env, KR_SERVE: "1", KR_PORT: String(PORT), KR_HOST: "127.0.0.1", KR_PLAYTEST_BUNDLES: "0" }, stdio: "ignore", windowsHide: true });
process.on("exit", () => { if (server.exitCode === null) server.kill(); });
for (let i = 0; !(await up()); i++) { if (server.exitCode !== null || i > 120) throw Error("the server did not come up"); await sleep(500); }

const locked = () => process.platform === "darwin" && /CGSSessionScreenIsLocked<\/key>\s*<true\/>/.test(spawnSync("ioreg", ["-n", "Root", "-d1", "-a"], { encoding: "utf8" }).stdout ?? "");
if (BROWSER === "safari" && locked()) throw Error("the screen is locked: Safari renders no frames then. Unlock the Mac for the run");
const awake = process.platform === "darwin" ? spawn("caffeinate", ["-d", "-i"], { stdio: "ignore" }) : null;
const yaw = (YAW_DEG * Math.PI) / 180, pitch = (PITCH_DEG * Math.PI) / 180;
const errors: string[] = [], marks: Record<string, number> = {}, artifacts: string[] = [];
let page: any = null, capture: ChildProcess | null = null, d: Driver | null = null;
const status = async () => JSON.parse(await d!.run(STATUS));
try {
  d = BROWSER === "safari" ? await safari() : await chromium(BROWSER);
  await d.run(SET_VIDEO(VIDEO));
  const load0 = Date.now();
  await d.open(ORIGIN + "/?" + QUERY);
  for (let s = await status(); !s.ready; s = await status()) { if (s.stage === "failed") throw Error("boot failed"); if (Date.now() - load0 > READY_S * 1000) throw Error("not ready after " + READY_S + " s (" + s.stage + ")"); await sleep(500); }
  marks.readyMs = Date.now() - load0;
  log("ready in " + (marks.readyMs / 1000).toFixed(1) + " s");
  await d.run(INSTALL);
  if (CAPTURE) { capture = spawn("sh", ["-c", CAPTURE], { stdio: "ignore", detached: true }); log("capture started: " + CAPTURE); }
  const play0 = Date.now();
  await d.run(START(MODE));
  let s = await status();
  for (let lastLog = 0; !(s.inMatch && s.phase >= AT_PHASE); s = await status()) {
    if (Date.now() - play0 > PLAY_S * 1000) throw Error("no phase " + AT_PHASE + " after " + PLAY_S + " s (phase " + s.phase + ", inMatch " + s.inMatch + ")");
    if (Date.now() - lastLog > 30_000) { lastLog = Date.now(); log("waiting for phase " + AT_PHASE + ": inMatch " + s.inMatch + ", phase " + s.phase + ", st " + s.st + ", stream " + (s.stream || "-")); }
    await sleep(500);
  }
  marks.playMs = Date.now() - play0; marks.programsAtPlay = s.programs;
  log("phase " + s.phase + " after " + (marks.playMs / 1000).toFixed(0) + " s, " + s.programs + " programs; teleporting");
  await d.run(PLACE(PX, PZ, yaw, pitch));
  const set0 = Date.now();
  while (Date.now() - set0 < SETTLE_S * 1000) { await d.run(KEEP(yaw, pitch)); await sleep(500); }
  s = await status();
  marks.programsAtHold = s.programs;
  log("settled " + SETTLE_S + " s at " + s.x.toFixed(1) + ", " + s.z.toFixed(1) + " (st " + s.st + ", stream " + (s.stream || "-") + "), " + s.programs + " programs; holding " + HOLD_S + " s");
  await d.run(COLLECT(true));
  const hold0 = Date.now();
  while (Date.now() - hold0 < HOLD_S * 1000) { await d.run(KEEP(yaw, pitch)); await sleep(500); }
  await d.run(COLLECT(false));
  const shotFile = out.replace(/\.json$/, "") + ".png";
  fs.mkdirSync(path.dirname(shotFile), { recursive: true });
  await d.shot(shotFile).then(() => artifacts.push(shotFile), () => { /* best effort */ });
  await d.run(RAF_PROBE);
  for (const probe0 = Date.now(); (await d.run("String(!!window.__kr.rafProbe)")) !== "true" && Date.now() - probe0 < 15_000;) await sleep(500);
  page = JSON.parse(await d.run(READ));
} catch (e) {
  errors.push("harness: " + (e instanceof Error ? e.message.split("\n")[0] : String(e)));
} finally {
  if (capture?.pid) { try { process.kill(-capture.pid, "SIGINT"); } catch { /* gone */ } await sleep(1500); }
  await d?.close().catch(() => { /* gone */ });
  awake?.kill();
  server.kill();
}

const cases: CaseResult[] = [];
if (page && page.n > 1) {
  const iv: number[] = []; for (let i = 1; i < page.n; i++) iv.push(page.T[i] - page.T[i - 1]);
  const dist = (v: number[], unit: "ms" | "count" = "ms"): Metric => v.length ? { status: "ok", unit, better: "lower", summary: stats(v) } : { status: "invalid", unit, reason: "no frames" };
  const secs = iv.reduce((a, b) => a + b, 0) / 1000;
  const software = /swiftshader|llvmpipe|softpipe|software/i.test(page.renderer);
  const rp: number[] = (page.rafProbe ?? []).slice(5);
  cases.push({
    scenario: { id: "gpu/hold/" + [PX, PZ].join(","), version: SCENARIO_VERSION, seed: SEED, workload: "real-play" },
    windows: { settleS: SETTLE_S, seconds: +secs.toFixed(2), frames: iv.length, definition: "standing still at the pose, the " + SETTLE_S + " s after the teleport not measured" },
    load: { frames: iv.length },
    metrics: {
      frameIntervalMs: dist(iv), cpuStepMs: dist(page.CPU.slice(1)),
      fps: { status: "ok", unit: "1/s", better: "higher", value: iv.length / Math.max(secs, 1e-3) },
      framesOver33ms: { status: "ok", unit: "count", better: "lower", value: iv.filter((x) => x > 1000 / 30).length },
      framesOver50ms: { status: "ok", unit: "count", better: "lower", value: iv.filter((x) => x > 50).length },
      drawCalls: dist(page.CALLS.slice(1), "count"), triangles: dist(page.TRIS.slice(1), "count"), points: dist(page.PTS.slice(1), "count"),
      newPrograms: { status: "ok", unit: "count", better: "lower", value: page.PROG[page.n - 1] - page.PROG[0] },
      rafProbeMs: rp.length ? { status: "ok", unit: "ms", better: "lower", summary: stats(rp) } : { status: "invalid", unit: "ms", reason: "no probe" },
      ...Object.fromEntries(Object.entries(page.phases as Record<string, number[]>).flatMap(([p, [frames, ms, over]]): Array<[string, Metric]> => [
        ["fpsPhase" + p, { status: "ok", unit: "1/s", better: "higher", value: (frames * 1000) / Math.max(ms, 1) }],
        ["framesOver33msPhase" + p, { status: "ok", unit: "count", better: "lower", value: over }],
      ])),
      resSteps: { status: "ok", unit: "count", better: "lower", value: (page.resLog ?? []).filter((s: { why: string }) => s.why !== "floor").length },
    },
    gates: [
      { id: "hardwareGpu", pass: SOFTWARE || !software, detail: page.renderer },
      { id: "windowLongEnough", pass: secs >= HOLD_S * 0.8, detail: secs.toFixed(1) + " s" },
      { id: "noErrors", pass: !page.errors.length, detail: page.errors.slice(0, 3).join(" | ") || "none" },
      { id: "atPose", pass: !!page.pos && Math.hypot(page.pos[0] - PX, page.pos[2] - PZ) < 3, detail: JSON.stringify(page.pos) },
    ],
  });
  const f = (m: Metric) => "summary" in m ? "p50 " + m.summary.p50.toFixed(1) + " p95 " + m.summary.p95.toFixed(1) + " p99 " + m.summary.p99.toFixed(1) : "value" in m ? m.value.toFixed(1) : m.status;
  const c = cases[0].metrics;
  log("frame " + f(c.frameIntervalMs) + " | fps " + f(c.fps) + " | cpu " + f(c.cpuStepMs) + " | calls " + f(c.drawCalls) + " | points " + f(c.points) + " | raf probe " + f(c.rafProbeMs) + " | refreshHz " + page.refreshHz + " | programs " + page.programsAtReady + " -> " + page.programs);
}
const result: RunResult = {
  schema: RESULT_SCHEMA, version: RESULT_VERSION, tool: "tools/performance/pose-hold.mts", startedAt: new Date(t0).toISOString(), durationMs: Date.now() - t0,
  source: source(root), environment: { ...env(), gpu: page ? String(page.renderer) : null },
  config: { browser: BROWSER + " " + (d?.version ?? "?"), viewport: VW + "x" + VH, preset: PRESET, query: QUERY, pose: [PX, PZ, YAW_DEG, PITCH_DEG].join(","), settleS: SETTLE_S, holdS: HOLD_S, mode: MODE, capture: CAPTURE ? "on" : "off", atPhase: AT_PHASE, dpr: page ? Number(page.dpr) : -1, headed: BROWSER === "safari" || process.argv.includes("--headed") },
  cases, errors, artifacts,
};
(result as unknown as Record<string, unknown>).detail = { marks, host: os.hostname(), page: page ? { ...page, T: undefined, frames: { t: page.T.map((x: number) => +(x - page.T[0]).toFixed(2)), cpu: page.CPU, calls: page.CALLS, tris: page.TRIS, points: page.PTS, programs: page.PROG } } : null };
save(out, result);
log("wrote " + out + (errors.length ? " with errors: " + errors.join("; ") : ""));
process.exit(errors.length || !cases.length || cases.some((c) => c.gates.some((g) => !g.pass)) ? 1 : 0);
