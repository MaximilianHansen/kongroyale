// The half-rate guard (RAY-186): with dynamic resolution off (every preset's default, and what an explicit High
// pins), a GPU-bound match that misses vsync is presented at half the display rate or worse, and nothing used to bring
// it back. Once a second in a match this reads the engine's frame intervals. When the median frame stays past the
// half-rate line of a 60 Hz display (or of the player's slower frame cap) it steps the 3D render scale down (TAAU in
// the post chain; the canvas and the HUD stay native), never below Auto's floor, and steps it back up after a run of
// full-rate seconds, waiting twice as long after each up-step that fell back. It judges by evidence, not by the
// measured refresh (a match locked at half rate measures as a 30 Hz display): when the steps down reach the floor with
// no gain in the mean frame (a 30 Hz screen, Low Power Mode, a CPU-bound frame) it puts the scale back and leaves it
// for a while; a GPU timer that shows the main thread as the longer side, or a main thread that takes most of the
// frame, skips the steps. The preset's other settings stay as they are. Every step goes into a bounded log (resLog,
// __kr.resLog) that KONGBOT and diagnostics reports carry in their context. ?resguard=1 / =0 force it on / off; it is
// off under automation (navigator.webdriver) unless forced, and ?dynres=0 or a pinned ?scale also keep it off
// (engine.guardScale).
import type { Engine } from "./engine";
import { flag } from "../flags";
import { AUTO_RES_FLOOR } from "./display";

export { AUTO_RES_FLOOR };
/** a median frame this many reference periods long missed vsync: presented at half rate or worse */
export const LINE_PERIODS = 1.5;
/** a median frame within this many reference periods is full rate */
export const OK_PERIODS = 1.25;
/** the reference period: a 60 Hz frame. On a 120 Hz screen a steady 60 fps is not a frame rate to trade resolution for,
 *  and a slower display is caught by the no-gain check instead of by its refresh estimate */
export const REF_MS = 1000 / 60;
/** seconds in a row past the line before a step down */
export const DOWN_AFTER_S = 2;
/** full-rate seconds in a row before the first step up; doubled after each up-step that fell back, up to the cap */
export const UP_AFTER_S = 10;
export const UP_AFTER_MAX_S = 120;
/** a step down this soon after a step up means the step up fell back */
export const FALLBACK_S = 8;
/** seconds left alone after a step, so the new scale's frames are what the next decision reads */
export const HOLD_S = 2;
/** one step multiplies the scale by STEP (up: divides); a median past BIG_PERIODS takes the bigger BIG_STEP down */
export const STEP = 0.92;
export const BIG_STEP = 0.85;
export const BIG_PERIODS = 3;
/** at the floor after a run of steps down, a mean frame that is not MIN_GAIN shorter than before the first means pixels
 *  are not what holds the frame: the scale goes back and no step down is taken for BLOCK_S (doubled each time, up to
 *  BLOCK_MAX_S). Only at the floor: vsync quantizes the presented frames, so a GPU frame cut from 30 to 21 ms still
 *  presents every 33 ms, and only the next step shows the gain */
export const MIN_GAIN = 0.03;
export const BLOCK_S = 120;
export const BLOCK_MAX_S = 600;
/** without a GPU timer, a frame whose main thread takes at least this share of it is CPU-bound (the engine's own
 *  dynamic resolution uses the same share; the step includes the render submit, which a GPU that is behind can block) */
export const CPU_BOUND_SHARE = 0.72;
/** a second with fewer drawn frames than this (a stall, a hidden page) decides nothing */
export const MIN_FRAMES = 4;
/** log entries kept (about 150 bytes each as JSON) */
export const RES_LOG_MAX = 32;

/** the reference period for a frame cap (fps, 0 = none): a cap slower than 60 fps is the player's full rate */
export const guardRefMs = (capFps: number) => (capFps > 0 ? Math.max(1000 / capFps, REF_MS) : REF_MS);

export type StepWhy = "halfrate" | "fallback" | "headroom" | "floor" | "cpu" | "no-gain" | "left-match";
export interface GuardState { bad: number; good: number; holdS: number; upWaitS: number; lastUpS: number; atFloor: boolean; cpuNoted: boolean; downs: number; meanBefore: number; blockS: number; blockWaitS: number }
export const newGuardState = (): GuardState => ({ bad: 0, good: 0, holdS: 0, upWaitS: UP_AFTER_S, lastUpS: -Infinity, atFloor: false, cpuNoted: false, downs: 0, meanBefore: 0, blockS: 0, blockWaitS: BLOCK_S });
/** one second of frames: the median, p95 and mean interval, the frame count, the reference period (guardRefMs), the
 *  main thread's smoothed ms per frame and the GPU's (0 = no timer) */
export interface GuardSecond { medMs: number; p95Ms: number; meanMs: number; frames: number; refMs: number; cpuMs: number; gpuMs: number }

/** One second's decision at render scale `scale` under the player's 3D resolution `top`: the scale to step to and why,
 *  or null. "floor" and "cpu" are notes with no change, returned once per run of seconds past the line. */
export function decide(st: GuardState, s: GuardSecond, scale: number, top: number, nowS: number): { to: number; why: StepWhy } | null {
  if (st.blockS > 0) st.blockS--;
  if (st.holdS > 0) { st.holdS--; return null; }
  if (s.frames < MIN_FRAMES) { st.bad = 0; st.good = 0; return null; }
  const line = s.refMs * LINE_PERIODS, floor = Math.min(top, AUTO_RES_FLOOR);
  if (s.medMs > line) { st.bad++; st.good = 0; }
  else if (s.medMs <= s.refMs * OK_PERIODS && s.p95Ms <= line) { st.good++; st.bad = 0; st.downs = 0; st.cpuNoted = false; }
  else { st.bad = 0; st.good = 0; }
  if (st.bad >= DOWN_AFTER_S) {
    st.bad = 0;
    if (s.gpuMs > 0 ? s.gpuMs < s.cpuMs : s.cpuMs >= s.medMs * CPU_BOUND_SHARE) {
      if (st.cpuNoted) return null;
      st.cpuNoted = true;
      return { to: scale, why: "cpu" };
    }
    if (st.blockS > 0) return null;
    if (scale <= floor + 1e-3) {
      if (st.downs > 0 && s.meanMs > st.meanBefore * (1 - MIN_GAIN)) {
        st.downs = 0; st.holdS = HOLD_S; st.blockS = st.blockWaitS; st.blockWaitS = Math.min(BLOCK_MAX_S, st.blockWaitS * 2); st.atFloor = false;
        return { to: top, why: "no-gain" };
      }
      if (st.atFloor) return null;
      st.atFloor = true;
      return { to: scale, why: "floor" };
    }
    if (st.downs++ === 0) st.meanBefore = s.meanMs;
    const fell = nowS - st.lastUpS < FALLBACK_S;
    if (fell) st.upWaitS = Math.min(UP_AFTER_MAX_S, st.upWaitS * 2);
    st.holdS = HOLD_S;
    return { to: Math.round(Math.max(floor, scale * (s.medMs > s.refMs * BIG_PERIODS ? BIG_STEP : STEP)) * 1000) / 1000, why: fell ? "fallback" : "halfrate" };
  }
  if (st.good >= st.upWaitS && scale < top - 1e-3) {
    st.good = 0; st.holdS = HOLD_S; st.lastUpS = nowS; st.atFloor = false;
    return { to: Math.round(Math.min(top, scale / STEP) * 1000) / 1000, why: "headroom" };
  }
  return null;
}

/** one step: page and match seconds, phase, the second's fps and frame p95 before it, the scale before and after,
 *  why, the engine's display refresh estimate, the canvas backing size, and whether the page was hidden or focused */
export interface ResStep { at: number; t: number; ph: number; fps: number; p95: number; from: number; to: number; why: StepWhy; hz: number; cv: [number, number]; hid: boolean; foc: boolean }
export const resLog: ResStep[] = [];

interface KrMatch { phase: number; time: number }
type Kr = Record<string, unknown> & { game?: { inMatch?: boolean; cm?: KrMatch | null } };

/** start the guard's once-a-second check (main.ts loads this chunk once the video settings are applied) */
export function startResGuard(engine: Engine): void {
  const forced = flag("resguard");
  if (forced === "0" || (forced !== "1" && navigator.webdriver)) return;
  const kr = (window as unknown as { __kr: Kr }).__kr;
  kr.resLog = resLog;
  const st = newGuardState(), iv = new Float32Array(engine.frameMs.length);
  let seen = engine.frameCount, stepped = false;
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const log = (why: StepWhy, from: number, to: number, fps: number, p95: number) => {
    const cm = kr.game?.inMatch ? kr.game.cm ?? null : null, c = engine.renderer.domElement;
    resLog.push({ at: r1(performance.now() / 1000), t: cm ? r1(cm.time) : -1, ph: cm ? cm.phase : -1, fps: r1(fps), p95: r1(p95), from, to, why, hz: engine.refreshHz, cv: [c.width, c.height], hid: document.visibilityState === "hidden", foc: document.hasFocus() });
    if (resLog.length > RES_LOG_MAX) resLog.splice(0, resLog.length - RES_LOG_MAX);
  };
  setInterval(() => {
    const ring = engine.frameMs, count = engine.frameCount, n = Math.min(count - seen, ring.length);
    seen = count;
    const top = engine.resBase, scale = engine.renderScale;
    if (!kr.game?.inMatch) {
      Object.assign(st, newGuardState());
      if (stepped && scale < top) { if (engine.guardScale(top)) { log("left-match", scale, top, 0, 0); stepped = false; } }
      else stepped = false;
      return;
    }
    if (document.visibilityState !== "visible" || engine.suspended || engine.dynamicRes) { st.bad = 0; st.good = 0; return; }
    let sum = 0;
    for (let i = 0; i < n; i++) { const v = ring[(count - n + i) % ring.length]; iv[i] = v; sum += v; }
    const s = iv.subarray(0, n).sort();
    const med = n ? s[n >> 1] : 0, p95 = n ? s[Math.min(n - 1, Math.floor(n * 0.95))] : 0;
    const meanMs = n ? sum / n : 0, fps = meanMs > 0 ? 1000 / meanMs : 0;
    const d = decide(st, { medMs: med, p95Ms: p95, meanMs, frames: n, refMs: guardRefMs(engine.frameCap), cpuMs: engine.stepEma, gpuMs: engine.gpuMs }, scale, top, performance.now() / 1000);
    if (!d) return;
    if (d.to === scale) { log(d.why, scale, scale, fps, p95); return; }
    if (!engine.guardScale(d.to)) return;
    stepped = true;
    log(d.why, scale, d.to, fps, p95);
  }, 1000);
}
