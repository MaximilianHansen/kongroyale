// Draw-list lab: what one draw of the static world costs when it is replayed as a
// recorded GL call list, against what three.js costs for the same draw. gpu-match.mts --drawlab <file> runs drawLab() in
// the page after its route (use --route tour --segments walk-town, so the player stands in the town) and saves the result.
// Nothing in the game changes: the page function wraps the renderer and the GL context for one frame, then unwraps them.
//
// Capture. On one render of engine.scene from engine.camera (scene.onBeforeRender to onAfterRender), every
// renderer.renderBufferDirect call from that camera is one draw, and every GL call it makes (context and WEBGL_multi_draw
// methods) is recorded with its arguments; typed arrays are copied, because three reuses them. A draw belongs to the world
// module whose root (__kr.moduleRoots) it sits under. The replayed set is the static draws:
// draws of a registered world module with an opaque material.
//
// Replay. On each later render of the scene from the camera, at its onAfterRender, every variant runs --reps times over
// the set, in an order that rotates by frame, into the frame's own framebuffer with the scissor at one pixel (vertex work
// stays, raster is ~free, the image of those frames is not the game's):
//   three    renderer.renderBufferDirect per draw, after renderObject's two matrix products (no object hooks, no
//            projectObject or sort: three's own per-draw path)
//   core     the recorded calls of three classes only: useProgram, geometry (VAO and buffer binds) and the draw call
//   +texture core plus activeTexture / bindTexture / bindSampler
//   +uniform plus every uniform* call and uniform-buffer binds
//   full     plus fixed-function state (enable/disable, blend, depth, cull, stencil, polygon offset): every replayable call
// The fixed-function state the main pass inherits from earlier passes (a shadow map leaves depth test and the like switched on
// for the main pass, which then emits no enable) is recorded too: the last call per state before the first main draw is
// replayed ahead of the first retained draw, in full.
// The recorded calls are three's state DELTAS (its cache skips what is already bound), so a retained draw can rely on state an
// excluded draw (a kong, a transparent mesh) set before it. Each retained draw therefore also replays the non-draw calls of the
// excluded draws since the previous retained one (reported as calls.perDraw.bridge): a replay that stands on its own, at
// the price of counting some state calls a stand-alone static list might not need, so full is an upper bound on its cost.
// Calls a replay leaves out (framebuffer, viewport, scissor test, uploads, read-backs) are counted under skipped. renderer.resetState()
// runs before every variant, untimed, so each starts from the same GL state and three's state cache matches it. Each
// variant's time is performance.now() around its reps (the page is cross-origin isolated: 5 us resolution), divided by
// reps and by the draw count. The first replay frame is a warm-up: its gl.getError() count per variant is reported and its
// times are dropped. A replayed call goes through Function.prototype.apply (tens of ns per call; a real draw list would
// call the GL methods directly).
//
// The gate: full's us per draw on a real GPU, median over runs. Summarise saved runs with
//   npx tsx tools/performance/draw-lab.mts lab-1.json lab-2.json ...
// The summary refuses files from different renderers, segments, presets, viewports or sampling, and only prints the gate for
// a real GPU with the island streamed in (a software or still-loading run is informational).
import fs from "node:fs";
import { pathToFileURL } from "node:url";

/** options for one lab run in the page */
export interface DrawLabOptions {
  /** replay frames measured after the warm-up frame */
  frames: number;
  /** passes over the draw set per variant per frame */
  reps: number;
  /** replay every opaque draw of the main render, not only the world modules' (a title-screen smoke has no modules) */
  all?: boolean;
}

/** one variant's times over the measured frames */
export interface LabVariant { usPerDraw: { p10: number; p50: number; p90: number }; msPerPass: number; callsPerDraw: number; glErrors: number }

/** what drawLab returns (gpu-match adds the run's config around it) */
export interface LabResult {
  frames: number;
  reps: number;
  all: boolean;
  /** draws of the captured main render: all, the replayed set, and why the rest were left out */
  draws: { main: number; set: number; transparent: number; noModule: number; byModule: Record<string, number>; other: Record<string, number> };
  /** __kr.streamed when the lab ran: false means the island's locations were still loading, so few module draws */
  streamed: boolean;
  /** recorded calls per replayed draw, by class; skipped by method name (totals over the set) */
  calls: { perDraw: Record<string, number>; skipped: Record<string, number> };
  variants: Record<string, LabVariant>;
  /** us per draw each layer adds (p50 differences), and three's cost over the full replay */
  layers: Record<string, number>;
}

/** Page function: capture one frame's static draws, then time the variants. Self-contained (Playwright serialises it). */
export function drawLab(o: DrawLabOptions): Promise<LabResult> {
  const kr = (globalThis as any).__kr, e = kr.engine, r = e.renderer, scene = e.scene, cam = e.camera;
  const gl = r.getContext() as WebGL2RenderingContext;
  const P = WebGL2RenderingContext.prototype as any;
  const CLASSES: Array<[string, RegExp]> = [
    ["draw", /^(drawArrays|drawElements|drawRangeElements|multiDraw)/],
    ["program", /^useProgram$/],
    ["geometry", /^(bindVertexArray|bindBuffer|vertexAttrib|enableVertexAttribArray|disableVertexAttribArray)/],
    ["texture", /^(activeTexture|bindTexture|bindSampler)$/],
    ["uniform", /^(uniform|bindBufferBase|bindBufferRange)/],
    ["state", /^(enable|disable|blend|depth|colorMask|cullFace|frontFace|polygonOffset|stencil|lineWidth|sampleCoverage)/],
  ];
  const classOf = (n: string, a: unknown[]) => {
    if (n === "bindBuffer" && a[0] === gl.UNIFORM_BUFFER) return "uniform";
    if ((n === "enable" || n === "disable") && a[0] === gl.SCISSOR_TEST) return "skip";
    for (const [c, re] of CLASSES) if (re.test(n)) return c;
    return "skip";
  };
  type Call = { f: Function; t: object; a: unknown[]; n: string; c: string };
  type Draw = { geometry: unknown; material: any; object: any; group: unknown; calls: Call[]; lead: Call[] };

  // ---- capture: wrap the context's and WEBGL_multi_draw's methods on the instances, and renderBufferDirect
  const md = gl.getExtension("WEBGL_multi_draw") as object | null;
  const methodNames = (proto: any) => {
    const names = new Set<string>();
    for (let p = proto; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) for (const k of Object.getOwnPropertyNames(p)) if (k !== "constructor" && typeof Object.getOwnPropertyDescriptor(p, k)?.value === "function") names.add(k);
    return names;
  };
  const targets: Array<[any, any]> = [[gl, P]];
  if (md) targets.push([md, Object.getPrototypeOf(md)]);
  let seg: Call[] | null = null;
  const copy = (x: unknown) => ArrayBuffer.isView(x) && !(x instanceof DataView) ? (x as unknown as Float32Array).slice() : x;
  for (const [t, proto] of targets) {
    for (const k of methodNames(proto)) {
      const f = t[k];
      if (typeof f !== "function") continue;
      t[k] = function (this: unknown, ...a: unknown[]) {
        if (seg) seg.push({ f, t, a: a.map(copy), n: k, c: classOf(k, a) });
        else if (capturing && !drawn && classOf(k, a) === "state") prelude.set(k + ":" + (k === "enable" || k === "disable" ? a[0] : ""), { f, t, a: a.map(copy), n: k, c: "state" });
        return f.apply(this, a);
      };
    }
  }
  const unwrapGl = () => { for (const [t, proto] of targets) for (const k of methodNames(proto)) if (Object.prototype.hasOwnProperty.call(t, k)) delete t[k]; };
  const rbd = r.renderBufferDirect;
  const draws: Draw[] = [];
  const prelude = new Map<string, Call>();
  let capturing = false, drawn = false;
  r.renderBufferDirect = function (this: unknown, camera: unknown, sc: unknown, geometry: unknown, material: any, object: any, group: unknown) {
    if (!capturing || camera !== cam || sc !== scene) return rbd.call(this, camera, sc, geometry, material, object, group);
    seg = []; drawn = true;
    try { return rbd.call(this, camera, sc, geometry, material, object, group); }
    finally { draws.push({ geometry, material, object, group, calls: seg, lead: [] }); seg = null; }
  };

  const own = (k: string) => Object.prototype.hasOwnProperty.call(scene, k) ? scene[k] : undefined;
  const ownBefore = own("onBeforeRender"), ownAfter = own("onAfterRender");
  const restore = () => {
    unwrapGl(); r.renderBufferDirect = rbd; seg = null; capturing = false;
    if (ownBefore) scene.onBeforeRender = ownBefore; else delete scene.onBeforeRender;
    if (ownAfter) scene.onAfterRender = ownAfter; else delete scene.onAfterRender;
  };

  // ---- the replayed set and its layers
  const moduleOf = new Map<object, string>();
  for (const id of kr.moduleIds?.() ?? []) for (const root of kr.moduleRoots?.(id) ?? []) moduleOf.set(root, id);
  const moduleName = (x: any) => { for (let p = x; p && p !== scene; p = p.parent) { const m = moduleOf.get(p); if (m) return m; } return ""; };
  const topName = (x: any) => { let p = x; while (p.parent && p.parent !== scene) p = p.parent; return p.parent === scene ? "~" + (p.name || p.type) : "(detached)"; };
  type Variant = { name: string; run: () => void; calls: number; errors: number; t: number[] };
  const layer = (name: string, set: Draw[], keep: string[]): Variant => {
    const fns: Function[] = [], ts: object[] = [], as: unknown[][] = [];
    for (const d of set) for (const c of [...d.lead, ...d.calls]) if (keep.includes(c.c)) { fns.push(c.f); ts.push(c.t); as.push(c.a); }
    const n = fns.length;
    return { name, calls: n / set.length, errors: 0, t: [], run: () => { for (let i = 0; i < n; i++) fns[i].apply(ts[i], as[i]); } };
  };

  return new Promise<LabResult>((resolve, reject) => {
    let stage = "arm", frame = -1, set: Draw[] = [], variants: Variant[] = [], transparent = 0, noModule = 0;
    const byModule: Record<string, number> = {}, other: Record<string, number> = {}, perDraw: Record<string, number> = {}, skipped: Record<string, number> = {};
    // a watchdog, not a deadline: a software renderer takes seconds a frame, so only a 60 s gap between renders fails
    let lastRender = performance.now();
    const fail = (err: unknown) => { clearInterval(timer); restore(); r.resetState(); reject(err instanceof Error ? err : Error(String(err))); };
    const timer = setInterval(() => { if (performance.now() - lastRender > 60_000) fail(Error("drawLab: no render of the scene from the camera for 60 s (stage " + stage + ")")); }, 5_000);
    const prepare = () => {
      unwrapGl(); r.renderBufferDirect = rbd;
      let bridge: Call[] = [];
      for (const d of draws) {
        const m = moduleName(d.object);
        if (!m) { noModule++; const t = topName(d.object); other[t] = (other[t] ?? 0) + 1; }
        const left = (!m && !o.all) || d.material.transparent;
        if (d.material.transparent && (m || o.all)) transparent++;
        if (left) { for (const c of d.calls) if (c.c !== "draw" && c.c !== "skip") bridge.push(c); continue; }
        d.lead = set.length ? bridge : [...prelude.values(), ...bridge]; bridge = [];
        byModule[m || "(none)"] = (byModule[m || "(none)"] ?? 0) + 1; set.push(d);
        for (const c of d.calls) if (c.c === "skip") skipped[c.n] = (skipped[c.n] ?? 0) + 1; else perDraw[c.c] = (perDraw[c.c] ?? 0) + 1;
      }
      if (!set.length) throw Error("drawLab: the captured frame has no " + (o.all ? "" : "static ") + "opaque draws to replay (" + draws.length + " main draws)");
      for (const d of set) for (const c of d.lead) perDraw.bridge = (perDraw.bridge ?? 0) + 1;
      for (const k in perDraw) perDraw[k] = +(perDraw[k] / set.length).toFixed(2);
      const s = set;
      variants = [
        { name: "three", calls: 0, errors: 0, t: [], run: () => {
          for (let i = 0; i < s.length; i++) {
            const d = s[i], ob = d.object;
            ob.modelViewMatrix.multiplyMatrices(cam.matrixWorldInverse, ob.matrixWorld);
            ob.normalMatrix.getNormalMatrix(ob.modelViewMatrix);
            rbd.call(r, cam, scene, d.geometry, d.material, ob, d.group);
          }
        } },
        layer("core", s, ["program", "geometry", "draw"]),
        layer("+texture", s, ["program", "geometry", "draw", "texture"]),
        layer("+uniform", s, ["program", "geometry", "draw", "texture", "uniform"]),
        layer("full", s, ["program", "geometry", "draw", "texture", "uniform", "state"]),
      ];
    };
    const runAll = () => {
      const rt = r.getRenderTarget();
      const warm = frame === 0;
      if (warm) while (gl.getError() !== gl.NO_ERROR) { /* drain errors from before */ }
      for (let j = 0; j < variants.length; j++) {
        const v = variants[(frame + j) % variants.length];
        r.resetState();
        r.setRenderTarget(rt);
        gl.enable(gl.SCISSOR_TEST); gl.scissor(0, 0, 1, 1);
        const t0 = performance.now();
        for (let k = 0; k < o.reps; k++) v.run();
        const dt = (performance.now() - t0) / o.reps;
        if (warm) { for (let g = 0; g < 16 && gl.getError() !== gl.NO_ERROR; g++) v.errors++; }
        else v.t.push(dt);
      }
      r.resetState();
    };
    const finish = () => {
      clearInterval(timer); restore();
      const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
      const out: Record<string, LabVariant> = {};
      for (const v of variants) {
        const us = v.t.map((x) => (x * 1000) / set.length);
        out[v.name] = { usPerDraw: { p10: +q(us, 0.1).toFixed(3), p50: +q(us, 0.5).toFixed(3), p90: +q(us, 0.9).toFixed(3) }, msPerPass: +q(v.t, 0.5).toFixed(4), callsPerDraw: +v.calls.toFixed(2), glErrors: v.errors };
      }
      const p = (k: string) => out[k].usPerDraw.p50;
      const layers = { core: p("core"), texture: +(p("+texture") - p("core")).toFixed(3), uniform: +(p("+uniform") - p("+texture")).toFixed(3), state: +(p("full") - p("+uniform")).toFixed(3), threeOverFull: +(p("three") - p("full")).toFixed(3) };
      resolve({ frames: o.frames, reps: o.reps, all: !!o.all, draws: { main: draws.length, set: set.length, transparent, noModule, byModule, other }, streamed: !!kr.streamed, calls: { perDraw, skipped }, variants: out, layers });
    };
    scene.onBeforeRender = function (this: unknown, ...a: any[]) {
      if (stage === "arm" && a[2] === cam) { capturing = true; stage = "capture"; }
      if (ownBefore) ownBefore.apply(this, a);
    };
    scene.onAfterRender = function (this: unknown, ...a: any[]) {
      if (ownAfter) ownAfter.apply(this, a);
      if (a[2] !== cam) return;
      lastRender = performance.now();
      try {
        if (stage === "capture") { capturing = false; prepare(); stage = "replay"; return; }
        if (stage !== "replay") return;
        frame++;
        runAll();
        if (frame >= o.frames) { stage = "done"; finish(); }
      } catch (err) { stage = "failed"; fail(err); }
    };
  });
}

// ---- CLI: summarise saved runs (median over runs of each variant's p50)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = process.argv.slice(2);
  if (!files.length) { console.error("usage: npx tsx tools/performance/draw-lab.mts lab-1.json [lab-2.json ...]"); process.exit(2); }
  const runs = files.map((f) => JSON.parse(fs.readFileSync(f, "utf8")) as LabResult & { renderer?: string; query?: string; segments?: string; preset?: string; viewport?: string });
  const sig = (x: (typeof runs)[number]) => [x.renderer, x.segments, x.preset, x.viewport, x.query, x.frames, x.reps, x.all].join(" | ");
  if (runs.some((x) => sig(x) !== sig(runs[0]))) { console.error("the lab files differ in renderer, segments, preset, viewport, frames, reps or all; summarise one kind at a time:\n" + files.map((f, i) => "  " + f + ": " + sig(runs[i])).join("\n")); process.exit(1); }
  const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  console.log(runs.length + " run(s) on " + [...new Set(runs.map((x) => x.renderer ?? "?"))].join(", ") + "; set " + runs.map((x) => x.draws.set).join("/") + " draws of " + runs.map((x) => x.draws.main).join("/") + (runs.every((x) => x.streamed) ? "" : "; NOT streamed in every run"));
  console.log("variant    us/draw p50 (median of runs)  min..max of runs   calls/draw  glErrors");
  for (const k of Object.keys(runs[0].variants)) {
    const v = runs.map((x) => x.variants[k].usPerDraw.p50);
    console.log(k.padEnd(10) + " " + med(v).toFixed(2).padStart(8) + "                      " + (Math.min(...v).toFixed(2) + ".." + Math.max(...v).toFixed(2)).padEnd(18) + " " + String(runs[0].variants[k].callsPerDraw).padStart(10) + "  " + runs.map((x) => x.variants[k].glErrors).join("/"));
  }
  for (const k of Object.keys(runs[0].layers)) console.log("layer " + k.padEnd(14) + med(runs.map((x) => x.layers[k])).toFixed(2) + " us/draw");
  const full = med(runs.map((x) => x.variants.full.usPerDraw.p50));
  const soft = /swiftshader|llvmpipe|softpipe|software|microsoft basic/i.test(runs[0].renderer ?? ""), complete = runs.every((x) => x.streamed) && !runs[0].all;
  console.log(soft || !complete ? "gate not applied (" + (soft ? "software renderer" : "island not streamed in every run, or --all") + "): full " + full.toFixed(2) + " us/draw, informational" : "gate (full replay < ~8 us/draw): " + (full < 8 ? "PASS" : "FAIL") + " at " + full.toFixed(2) + " us/draw");
}
