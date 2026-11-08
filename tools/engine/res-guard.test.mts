// The half-rate guard's decisions (client/src/engine/res-guard.ts): it steps the 3D resolution down only when a match
// sits past the half-rate line and fewer pixels help, never below Auto's floor, steps back up after a run of full-rate
// seconds, and backs off instead of oscillating when an up-step falls back (RAY-186).
import assert from "node:assert/strict";
import { AUTO_RES_FLOOR, BLOCK_S, MIN_FRAMES, REF_MS, UP_AFTER_MAX_S, UP_AFTER_S, decide, guardRefMs, newGuardState, readSecond } from "../../client/src/engine/res-guard";

const H = 1000 / 60;
type Frame = { med: number; mean?: number };
/** run the guard for "seconds" with a frame model (a second's median and mean ms at a scale); the steps it took */
function run(seconds: number, frameAt: (scale: number, s: number) => Frame, opts: { capFps?: number; top?: number; cpuMs?: number; gpuMs?: number } = {}) {
  const st = newGuardState(), top = opts.top ?? 1, steps: Array<{ s: number; from: number; to: number; why: string }> = [];
  let scale = top, halfS = 0, lowS = 0;
  for (let s = 0; s < seconds; s++) {
    const f = frameAt(scale, s), mean = f.mean ?? f.med;
    if (f.med > 25) halfS++;
    if (scale < top) lowS++;
    const d = decide(st, { medMs: f.med, p95Ms: f.med, meanMs: mean, frames: Math.round(1000 / mean), refMs: guardRefMs(opts.capFps ?? 0), cpuMs: opts.cpuMs ?? 7, gpuMs: opts.gpuMs ?? 0 }, scale, top, s);
    if (!d) continue;
    steps.push({ s, from: scale, to: d.to, why: d.why });
    scale = d.to;
  }
  return { steps, scale, st, halfS, lowS };
}
const whys = (r: { steps: Array<{ why: string }> }) => r.steps.map((x) => x.why);
/** a GPU-bound scene whose GPU frame shrinks with the pixel count, presented in whole 60 Hz periods (the engine's
 *  intervals are presented frames, so the mean is quantized as much as the median) */
const gpuBound = (ms100: number) => (scale: number): Frame => { const p = Math.ceil((ms100 * scale * scale) / H - 0.15) * H; return { med: p, mean: p }; };

// full rate at 60 Hz: nothing happens
assert.equal(run(120, () => ({ med: H })).steps.length, 0, "full rate");
// Ray's case: High at DPR 2 in Safari, a 30 ms GPU frame presented at 30 fps; fewer pixels bring it back under the line
{
  const r = run(600, gpuBound(30));
  assert.deepEqual(whys(r).slice(0, 3), ["halfrate", "halfrate", "halfrate"]);
  assert.equal(r.steps[0].s, 1, "two seconds past the line before the first step");
  assert.ok(r.scale < 0.9 && r.scale >= AUTO_RES_FLOOR, "settles under 0.9: " + r.scale);
  assert.ok(!whys(r).includes("no-gain"), "fewer pixels do help here");
  assert.ok(r.halfS < 45, "under 8 % of ten minutes at half rate: " + r.halfS + " s");
  assert.ok(r.steps.length < 20, "bounded steps: " + r.steps.length);
}
// a frame too heavy for the floor: it steps down to the floor and says so once
{
  const r = run(60, gpuBound(60));
  assert.equal(r.scale, AUTO_RES_FLOOR, "stops at Auto's floor");
  assert.equal(whys(r).filter((w) => w === "floor").length, 1, "the floor is logged once");
  assert.ok(r.steps.length <= 7, "bounded steps: " + r.steps.length);
}
// back under the line only at 0.85 and below: up-steps fall back, the wait doubles up to UP_AFTER_MAX_S, no oscillation
{
  const r = run(1800, (scale) => (scale > 0.85 ? { med: 2 * H, mean: 2 * H * scale } : { med: H }));
  const ups = r.steps.filter((x) => x.why === "headroom");
  assert.ok(r.steps.filter((x) => x.why === "fallback").length >= 3, "up-steps that fell back");
  for (let i = 1; i < ups.length; i++) assert.ok(ups[i].s - ups[i - 1].s >= Math.min(UP_AFTER_MAX_S, UP_AFTER_S * 2 ** i), "backoff " + i);
  assert.equal(r.st.upWaitS, UP_AFTER_MAX_S, "the wait is capped");
  assert.ok(r.steps.length < 40, "no oscillation: " + r.steps.length + " steps in 30 min");
  assert.ok(r.halfS < 120, "under 7 % of the match at half rate: " + r.halfS + " s");
}
// headroom comes back for good (the player left the heavy view): it climbs back to the player's 3D resolution
{
  const r = run(200, (scale, s) => (s < 20 ? gpuBound(40)(scale) : { med: H }));
  assert.equal(r.scale, 1, "back at 100 %");
  assert.equal(r.steps.at(-1)?.why, "headroom");
}
// a display or a browser that presents at 30 Hz (a 30 Hz screen, Low Power Mode): fewer pixels change nothing, so at
// the floor it puts the scale back and waits BLOCK_S, then twice that
{
  const r = run(900, () => ({ med: 1000 / 30 }));
  const first = whys(r).indexOf("no-gain");
  assert.ok(first > 0 && whys(r).slice(0, first).every((w) => w === "halfrate"), "steps to the floor, then no-gain: " + whys(r).join(","));
  assert.equal(r.steps[first].to, 1, "the scale goes back");
  const tries = r.steps.filter((x) => x.why === "no-gain").map((x) => x.s);
  assert.ok(tries.length <= 3 && tries[1] - tries[0] >= BLOCK_S, "blocked between tries: " + tries.join(", "));
  assert.ok(r.steps.filter((x) => x.to < 1).length <= 6 * tries.length, "at most a walk to the floor per try");
  assert.ok(r.lowS <= 25 * tries.length && r.lowS < 0.1 * 900, "under 25 s below 100 % per try, under 10 % in all: " + r.lowS + " s");
}
// a GPU frame that needs three steps to cross the vsync boundary, with the mean quantized like the median: no step is
// abandoned before the boundary
{
  const r = run(60, gpuBound(30));
  assert.ok(!whys(r).includes("no-gain"));
  assert.ok(r.scale <= 0.8, "crossed the boundary: " + r.scale);
}
// a 120 Hz screen at a steady 60 fps is not past the line; 30 fps on it is
assert.equal(run(60, () => ({ med: H })).steps.length, 0, "60 fps on 120 Hz");
assert.equal(run(10, gpuBound(22)).steps[0]?.why, "halfrate", "30 fps on 120 Hz");
// a player's 30 fps cap is the reference: 30 fps is full rate there, and a cap above 60 never shortens it
assert.equal(run(60, () => ({ med: 1000 / 30 }), { capFps: 30 }).steps.length, 0, "30 fps cap");
assert.equal(guardRefMs(144), REF_MS, "a 144 fps cap");
// the player's own 3D resolution under the floor: nothing to step, the floor is logged once
{
  const r = run(30, () => ({ med: 2 * H }), { top: 0.5 });
  assert.equal(r.scale, 0.5);
  assert.deepEqual(whys(r), ["floor"]);
}
// a far-too-slow frame takes the bigger step
assert.equal(run(3, () => ({ med: 4 * H })).steps[0].to, 0.85, "big step at 15 fps");
// CPU-bound (the main thread takes most of the frame, or the GPU timer shows the GPU as the shorter side): the scale
// stays and the log says so once; a submit that a busy GPU blocks for half the frame is still GPU-bound
assert.deepEqual(whys(run(30, () => ({ med: 2 * H }), { cpuMs: 28 })), ["cpu"], "CPU-bound, no timer");
assert.deepEqual(whys(run(30, () => ({ med: 2 * H }), { cpuMs: 12, gpuMs: 9 })), ["cpu"], "CPU-bound by the GPU timer");
assert.equal(run(10, gpuBound(22), { cpuMs: 7, gpuMs: 22 }).steps[0].why, "halfrate", "GPU-bound by the GPU timer");
assert.equal(run(10, gpuBound(22), { cpuMs: 16 }).steps[0].why, "halfrate", "submit backpressure");
// a stalled second (a few frames) decides nothing
{
  const st = newGuardState();
  for (let s = 0; s < 10; s++) assert.equal(decide(st, { medMs: 500, p95Ms: 500, meanMs: 500, frames: 2, refMs: H, cpuMs: 7, gpuMs: 0 }, 1, 1, s), null);
}
// module streaming: a POI build slice between frames makes that interval long while the frame itself stays
// cheap. Those intervals are left out, so a lowmem descent whose own frames run at full rate takes no step down
{
  const N = 240, ring = new Float32Array(N), stream = new Uint8Array(N), out = new Float32Array(N);
  const draw = (count: number, ms: number, st: boolean) => { ring[count % N] = ms; stream[count % N] = st ? 1 : 0; return count + 1; };
  // a second of the descent: 30 frames, every other one behind a 7 ms slice plus a 40-560 ms build step; the ring wraps
  let count = 225;
  for (let i = 0; i < 30; i++) count = draw(count, i % 2 ? 40 + i * 18 : H, i % 2 === 1);
  const s = readSecond(ring, stream, count, 30, out);
  assert.deepEqual([s.frames, s.streamFrames], [15, 15], "stream frames counted apart");
  assert.ok(Math.abs(s.medMs - H) < 1e-3 && Math.abs(s.p95Ms - H) < 1e-3 && Math.abs(s.meanMs - H) < 1e-3, "only the clean frames: " + JSON.stringify(s));
  const st = newGuardState();
  for (let t = 0; t < 30; t++) assert.equal(decide(st, { ...s, refMs: H, cpuMs: 7, gpuMs: 0 }, 1, 1, t), null, "no step at full rate");
  // a second where every interval held a slice decides nothing, however long its frames
  for (let i = 0; i < 20; i++) count = draw(count, 120, true);
  const all = readSecond(ring, stream, count, 20, out);
  assert.ok(all.frames === 0 && all.frames < MIN_FRAMES && all.streamFrames === 20);
  for (let t = 0; t < 30; t++) assert.equal(decide(newGuardState(), { ...all, refMs: H, cpuMs: 7, gpuMs: 0 }, 1, 1, t), null);
  // a GPU-bound second keeps its say when a few of its frames streamed
  for (let i = 0; i < 30; i++) count = draw(count, i < 3 ? 300 : 2 * H, i < 3);
  const gpu = readSecond(ring, stream, count, 30, out), gs = newGuardState();
  assert.equal(gpu.frames, 27);
  assert.equal(decide(gs, { ...gpu, refMs: H, cpuMs: 7, gpuMs: 0 }, 1, 1, 0), null);
  assert.equal(decide(gs, { ...gpu, refMs: H, cpuMs: 7, gpuMs: 0 }, 1, 1, 1)?.why, "halfrate", "still steps on its own frames");
}
console.log("res-guard: ok");
