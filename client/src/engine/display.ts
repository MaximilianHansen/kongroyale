// VIDEO SETTINGS — the model behind the video menu.
// One persisted object (localStorage "kr-video"), five presets (Auto / Low / Medium / High / Epic) and per-option
// overrides ("Custom"). Everything applies LIVE through the engine and the atmos area's `video()` API:
//   3D resolution  → engine.setResolution (TAAU inside the post chain; the canvas stays at the screen's native pixels)
//   dynamic res    → engine.setDynamicRes (opt-in; 0.75 × … 1 × the 3D resolution, aiming at the frame cap)
//   frame limit    → engine.setFrameCap (30 … 240 / Unlimited = every display refresh; default = the measured refresh)
//   AA / AO / post / shadows / effects → atmos `video()` (post.ts configure, shadows.ts setQuality)
//   view distance  → engine.cull (screen-size culling) + the veg area's distances (VegApi.setQuality, when present)
//   foliage        → VegApi.setQuality (guarded: the veg area adds it)
//   FOV            → the game's own FOV setting (the pause menu slider — one source of truth)
//   show FPS       → the overlay in ui/settings.ts
// First visit: a preset from the GPU string (WEBGL_debug_renderer_info) at boot, confirmed by a ~2 s GPU bench once the
// island is built (one level down if the frame does not fit). In a match a runtime guard suggests a lower preset when the
// frame rate stays under 50 fps. View-camera pages (?view / ?cam / ?shot) and pages with ?q= ignore all of it.
import type * as THREE from "three";
import type { Engine, Quality } from "./engine";
import { flag } from "../flags";
import { contextEpoch } from "./res/restore";
import { gpuScore } from "./gpu-score";

export type Level = "low" | "medium" | "high" | "epic";
export type PresetId = "auto" | Level | "custom";
export type AAMode = "taa" | "fxaa" | "off";
export const LEVELS: Level[] = ["low", "medium", "high", "epic"];
export const FPS_CAPS = [30, 60, 120, 144, 165, 240, 0] as const;

export interface VideoSettings {
  /** 2: presets keep the 3D resolution at 100 % (v1 saves are migrated) */
  v: 2;
  /** what the menu shows as the preset (a changed option turns it into "custom") */
  preset: PresetId;
  /** the level Auto resolved to on this machine */
  auto: Level;
  /** 3D resolution, fraction of native (0.5-1). Only AUTO on a detected laptop-class GPU sets it below 1; every
   *  explicit preset renders at 100 %; the player's own slider is kept across preset changes once touched */
  res3d: number;
  /** the player moved the 3D-resolution slider: presets no longer touch it */
  resUser?: boolean;
  dynres: boolean;
  /** frame limit in fps; 0 = unlimited (every display refresh); -1 = the display refresh (default) */
  fpsCap: number;
  aa: AAMode;
  shadows: Level;
  ao: boolean;
  post: Level;
  viewDist: Level;
  foliage: Level;
  effects: Level;
  /** vertical FOV (deg), the game's own setting */
  fov: number;
  showFps: boolean;
  /** the first-visit bench stepped the preset down: shown as a persistent notice until the player dismisses it */
  stepped?: { from: Level; to: Level; res: number; ack?: boolean };
}

/** AUTO only, on laptop-class GPUs: an internal-resolution budget (megapixels). An M1 Pro's 3024×1964 backing store
 *  renders 81 % at Medium and 67 % at Low; a 1080p / 1440p screen stays at 100 %; High and Epic are always native. */
const AUTO_MPX: Record<Level, number> = { low: 2.7, medium: 3.9, high: Infinity, epic: Infinity };
export function presetRes(level: Level, backingPx: number) {
  const r = Math.sqrt((AUTO_MPX[level] * 1e6) / Math.max(1, backingPx));
  return Math.min(1, Math.max(0.67, Math.floor(r * 100) / 100));
}

/** a preset's options. `auto` = this is AUTO's pick (the only case that may lower the 3D resolution, and only on
 *  laptop-class levels); an explicit preset keeps the player's own 3D resolution (100 % unless they moved the slider) */
export function presetSettings(level: Level, backingPx: number, keep?: Partial<VideoSettings>, auto = false): VideoSettings {
  const base = {
    low: { aa: "fxaa", shadows: "low", ao: false, post: "low", viewDist: "low", foliage: "low", effects: "low" },
    medium: { aa: "taa", shadows: "medium", ao: true, post: "medium", viewDist: "medium", foliage: "medium", effects: "medium" },
    high: { aa: "taa", shadows: "high", ao: true, post: "high", viewDist: "high", foliage: "high", effects: "high" },
    epic: { aa: "taa", shadows: "epic", ao: true, post: "epic", viewDist: "epic", foliage: "epic", effects: "epic" },
  }[level] as Pick<VideoSettings, "aa" | "shadows" | "ao" | "post" | "viewDist" | "foliage" | "effects">;
  const res3d = keep?.resUser ? keep.res3d ?? 1 : auto ? presetRes(level, backingPx) : 1;
  return {
    v: 2, preset: level, auto: keep?.auto ?? level, res3d, resUser: keep?.resUser, dynres: false,
    fpsCap: keep?.fpsCap ?? -1, fov: keep?.fov ?? 72, showFps: keep?.showFps ?? false, stepped: keep?.stepped, ...base,
  };
}

// ---- GPU classification (WEBGL_debug_renderer_info). Deliberately conservative: the bench only ever steps DOWN.
const RULES: Array<[RegExp, Level]> = [
  [/swiftshader|llvmpipe|softpipe|software|microsoft basic/i, "low"],
  [/mali|adreno|powervr|videocore|apple gpu|apple a\d/i, "low"],
  [/intel.*(hd|uhd|iris|xe)|intel\(r\) (hd|uhd|iris)|radeon\(tm\) graphics|vega \d|radeon graphics|radeon 7[0-9]0m/i, "low"],
  [/apple m\d(?! (pro|max|ultra))/i, "low"],
  [/apple m[1-2] pro|apple m3 pro|gtx 10[5-6]0|gtx 16[0-9]0|rtx 20[5-6]0|rtx 30[5]0|rtx 40[5]0|rx 5[5-7]00|rx 6[4-5]00|arc a[3-5]/i, "medium"],
  [/apple m[4-9](?! (pro|max|ultra))|apple m[4-9] pro|apple m\d max|apple m\d ultra|rtx 20[7-8]0|rtx 30[6]0|rtx 40[6]0|rtx 50[5-6]0|gtx 10[7-8]0|rx 6[6-7]00|rx 7[6]00|arc a7|arc b/i, "high"],
  [/rtx 30[7-9]0|rtx 40[7-9]0|rtx 50[7-9]0|rtx a\d000|rx 6[8-9]00|rx 7[7-9]00|rx 9\d{3}|titan/i, "epic"],
];
const APPLE_HIGH_DRAWS_PER_S = 2000, APPLE_MEDIUM_DRAWS_PER_S = 1300;
const SCORE_KEY = "kr-gpu-score";
const anonymousMacGpu = (gpu: string) => /^apple gpu$/i.test(gpu.trim()) && /Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints < 2;
function storedScore(): number | null {
  try {
    const v = Number((JSON.parse(localStorage.getItem(SCORE_KEY) ?? "null") as { score?: unknown } | null)?.score);
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch { return null; }
}
let pageScore: number | null | undefined;
function measuredScore(gpu: string): number | null {
  if (pageScore !== undefined) return pageScore;
  const r = gpuScore();
  if (r) try { localStorage.setItem(SCORE_KEY, JSON.stringify({ score: r.score, gpu })); } catch { void 0; }
  return pageScore = r?.score ?? null;
}
export function deviceLevel(gpu: string): Level {
  if (!anonymousMacGpu(gpu)) return classifyGpu(gpu);
  const score = storedScore() ?? measuredScore(gpu);
  return score === null ? "low" : score >= APPLE_HIGH_DRAWS_PER_S ? "high" : score >= APPLE_MEDIUM_DRAWS_PER_S ? "medium" : "low";
}
export function gpuString(gl: WebGLRenderingContext | WebGL2RenderingContext): string {
  try {
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const s = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    return String(s ?? "");
  } catch { return ""; }
}
export function classifyGpu(gpu: string): Level {
  let lvl: Level | null = null;
  for (const [re, l] of RULES) if (re.test(gpu)) lvl = l; // later (stronger) rules win: "rtx 3070 laptop" → epic
  if (lvl) return lvl;
  if (/nvidia|geforce|quadro/i.test(gpu)) return "high";
  if (/radeon|amd/i.test(gpu)) return "medium";
  return "medium";
}

const KEY = "kr-video";
let migrated = false;
const store = {
  get(): VideoSettings | null {
    try {
      const v = JSON.parse(localStorage.getItem(KEY) || "null");
      if (v && v.v === 1) {
        // v1: presets lowered the 3D resolution from a megapixel budget (High = 79 % at 4K), which read as
        // blurry. Migrate: explicit presets back to 100 %, AUTO to the new laptop-only budget (set in the ctor)
        v.v = 2; v.resUser = false; v.res3d = v.preset === "auto" ? -1 : 1; migrated = true;
      }
      return v && v.v === 2 ? v : null;
    } catch { return null; }
  },
  set(v: VideoSettings) { try { localStorage.setItem(KEY, JSON.stringify(v)); localStorage.setItem(FOV_MOVED, "1"); } catch { /* private mode */ } },
  /** this store has been written since the FOV moved here from the pause card */
  fovMoved() { try { return localStorage.getItem(FOV_MOVED) === "1"; } catch { return true; } },
};
const FOV_MOVED = "kr-fov-moved";
/** the legacy pause card's FOV (vertical degrees), NaN when absent */
function legacyPauseFov() {
  try { const v = (JSON.parse(localStorage.getItem("kr-settings") || "{}") as { fov?: unknown }).fov; return typeof v === "number" ? v : NaN; } catch { return NaN; }
}

/** the world-module build tier for this boot (?q= wins): Low / Medium presets build the lighter water / clouds / AO */
export function bootQuality(): Quality | null {
  const s = store.get();
  const lvl = !s || (s.preset === "auto" && !s.stepped) ? detectLevel() ?? s?.auto : s.preset === "custom" || s.preset === "auto" ? (s.post ?? s.auto) : s.preset;
  return ({ low: "low", medium: "medium", high: "high", epic: "ultra" } as const)[lvl as Level] ?? null;
}

function detectLevel(): Level | null {
  const spoof = flag("gpu");
  if (spoof) return deviceLevel(spoof);
  const gl = document.createElement("canvas").getContext("webgl2", { powerPreference: "high-performance", antialias: false, stencil: false });
  if (!gl) return null;
  const level = deviceLevel(gpuString(gl));
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return level;
}

interface AtmosVideoApi { video?(v: { aa: AAMode; ao: boolean; post: Level; shadows: Level; effects: Level }): { aa: AAMode; ao: boolean } }
/** VegApi.setQuality (veg area): ONE tier string → { tier, dist, density, shadows } in effect */
export interface VegQualityState { tier: string; dist: number; density: number; shadows: string }
interface VegQualityApi { setQuality?(tier: Level): VegQualityState }

export class Display {
  settings: VideoSettings;
  readonly gpu: string;
  readonly gpuLevel: Level;
  firstVisit: boolean;
  private recalibrating = false;
  /** first-visit bench result (tools) */
  bench: { gpuMs: number; fps: number; from: Level; to: Level; timer: boolean } | null = null;
  /** what veg reported for the last apply (tools read it per preset) */
  vegState: VegQualityState | null = null;
  /** ui hooks (ui/settings.ts) */
  onShowFps: (on: boolean) => void = () => { /* set by the ui */ };
  onSuggest: (level: Level, fps: number) => void = () => { /* set by the ui */ };
  /** the first-visit bench stepped the preset down (persistent notice until dismissed) */
  onStepped: (s: NonNullable<VideoSettings["stepped"]>) => void = () => { /* set by the ui */ };
  onChange: Array<(s: VideoSettings) => void> = [];

  constructor(private engine: Engine) {
    this.gpu = gpuString(engine.renderer.getContext());
    const spoof = flag("gpu"); // tools: ?gpu=<renderer string>
    this.gpuLevel = deviceLevel(spoof || this.gpu);
    const saved = store.get();
    const reclassified = !!saved && saved.preset === "auto" && !saved.stepped && saved.auto !== this.gpuLevel;
    this.firstVisit = !saved || reclassified;
    this.recalibrating = reclassified;
    this.settings = saved && !reclassified ? saved : { ...presetSettings(this.gpuLevel, this.backingPx(), { ...saved, auto: this.gpuLevel }, true), dynres: saved?.dynres ?? false };
    if (!saved || reclassified) this.settings.preset = "auto";
    // the FOV used to live on the pause card too (kr-settings.fov, re-synced to this store at every boot and then moved by
    // that slider): it holds the FOV last in effect — adopt it once; the first write of this store retires it
    const legacyFov = store.fovMoved() ? NaN : legacyPauseFov();
    if (Number.isFinite(legacyFov)) this.settings.fov = legacyFov;
    this.settings.fov = Number.isFinite(this.settings.fov) ? Math.max(60, Math.min(90, this.settings.fov)) : 72;
    this.applyFov();
    if (this.settings.res3d < 0) this.settings.res3d = presetRes(this.settings.auto, this.backingPx());
    if (migrated || (saved && Number.isFinite(legacyFov))) store.set(this.settings);
    engine.onRefresh(() => this.applyCap());
  }

  backingPx() {
    const c = this.engine.renderer.domElement;
    return Math.max(1, (c.clientWidth || innerWidth) * (c.clientHeight || innerHeight) * this.engine.dprBase * this.engine.dprBase);
  }

  /** apply (and persist) a partial change; a preset id applies the whole preset (Auto = the detected level) */
  set(patch: Partial<VideoSettings>) {
    let s = { ...this.settings, ...patch };
    // the 3D-resolution slider is the player's own: it never turns the preset into CUSTOM, and once
    // moved no preset touches it again ("RESET TO AUTO" hands it back: patch.resUser = false)
    if ("res3d" in patch && patch.res3d !== undefined && patch.resUser === undefined) s.resUser = true;
    if (patch.preset && patch.preset !== "custom") {
      const lvl = patch.preset === "auto" ? s.auto : patch.preset;
      s = { ...presetSettings(lvl, this.backingPx(), s, patch.preset === "auto"), preset: patch.preset };
    } else if (!patch.preset && Object.keys(patch).some((k) => !["fpsCap", "fov", "showFps", "dynres", "res3d", "resUser", "stepped"].includes(k))) s.preset = "custom";
    this.settings = s;
    store.set(s);
    this.apply();
  }

  private applyCap() {
    const c = this.settings.fpsCap;
    this.engine.setFrameCap(c < 0 ? 0 : c);
  }

  apply() {
    const s = this.settings, e = this.engine;
    this.applyCap();
    const atmos = e.shared.get("atmos") as AtmosVideoApi | undefined;
    try { atmos?.video?.({ aa: s.aa, ao: s.ao, post: s.post, shadows: s.shadows, effects: s.effects }); } catch (err) { console.warn("[display] atmos video", err); }
    e.setResolution(s.res3d);
    e.setDynamicRes(s.dynres);
    // view distance: the engine's screen-size cull (a mesh stops drawing under minPx projected radius, never within minDist)
    const vd = { low: [4, 60], medium: [3, 60], high: [2.4, 70], epic: [2, 80] }[s.viewDist];
    e.cull.minPx = vd[0]; e.cull.minPxT = vd[0] * 1.5; e.cull.minDist = vd[1];
    // foliage → the veg tier (ONE string: density + distances + shadow casting — an object here pinned
    // veg to HIGH on every preset); the tier in effect is read back into vegState
    const veg = e.shared.get("veg") as VegQualityApi | undefined;
    try { this.vegState = veg?.setQuality?.(s.foliage) ?? null; } catch (err) { console.warn("[display] veg quality", err); }
    this.applyAniso(s.viewDist);
    e.shared.set("display:effects", s.effects);
    e.shared.set("display:viewDist", s.viewDist);
    this.applyFov();
    this.onShowFps(s.showFps);
    for (const f of this.onChange) f(s);
  }

  /** texture filtering by view distance (without it the ridges at 900 m read as a flat slab): the terrain's
   *  layer arrays and its far bake are created with anisotropy <= 4; High / Epic raise
   *  them to 16x (Medium 8x) IN PLACE — one sampler parameter per texture, no re-upload, applied live */
  anisoApplied = 0;
  private applyAniso(level: Level) {
    const r = this.engine.renderer;
    const u = this.engine.shared.get("terrainUniforms") as Record<string, THREE.IUniform> | undefined;
    if (!u) return;
    const gl = r.getContext() as WebGL2RenderingContext;
    const ext = gl.getExtension("EXT_texture_filter_anisotropic");
    if (!ext) return;
    const want = Math.min(level === "epic" || level === "high" ? 16 : level === "medium" ? 8 : 4, r.capabilities.getMaxAnisotropy());
    const props = r.properties as unknown as { get(o: object): { __webglTexture?: WebGLTexture; __currentAnisotropy?: number } };
    const state = r.state as unknown as { bindTexture(target: number, tex: WebGLTexture | null): void };
    for (const k of ["tAlb", "tNrm", "tFar"]) {
      const t = u[k]?.value as (THREE.Texture & { isDataArrayTexture?: boolean }) | null | undefined;
      if (!t?.isTexture) continue;
      t.anisotropy = want;
      const p = props.get(t), wt = p.__webglTexture;
      if (!wt) continue; // not uploaded yet: the upload uses t.anisotropy
      const target = t.isDataArrayTexture ? gl.TEXTURE_2D_ARRAY : gl.TEXTURE_2D;
      state.bindTexture(target, wt);
      gl.texParameterf(target, ext.TEXTURE_MAX_ANISOTROPY_EXT, want);
      p.__currentAnisotropy = want;
    }
    this.anisoApplied = want;
  }

  /** the display owns the one persistent vertical FOV: publish it (game/render.ts reads "display:fov" every frame) */
  applyFov() { this.engine.shared.set("display:fov", this.settings.fov); }
  /** (kept for ui/settings.ts: there is no second FOV control to mirror any more) */
  readFov() { /* nothing to mirror */ }

  /** first visit: ~2 s of GPU time on the live title once the island is built; one level down if it does not fit the
   *  display's refresh (capped at 120 Hz: "smooth" is the goal on a laptop, not 240). Never on an
   *  Epic-class GPU; without a GPU timer query (Mac Chrome / Safari) only after the stream has ended plus 3 s of idle
   *  frames, and only for a clear miss (frame time > 1.5 × the budget); every step down is persisted and shown as a
   *  notice with the new 3D resolution until the player dismisses it. */
  async firstVisitBench(): Promise<void> {
    if (!this.firstVisit) return;
    this.firstVisit = false;
    const e = this.engine;
    const t0 = performance.now();
    while (!(globalThis as { __kr?: { streamed?: boolean } }).__kr?.streamed && performance.now() - t0 < 40000) await sleep(250);
    const timer = hasTimer(e);
    await sleep(timer ? 1200 : 3000);
    const r = await measure(e, 2000);
    // (a refresh measured under a starved main thread reads far below 60 Hz — e.g. "7 Hz" → a 140 ms budget that
    // never stepped down; a display is 60-120 Hz for this purpose)
    const hz = Math.min(Math.max(e.refreshHz || 60, 60), 120);
    const budget = 1000 / (e.frameCap > 0 ? Math.min(hz, e.frameCap) : hz);
    const from = this.settings.auto;
    let to = from;
    const gpuOk = r.gpuMs > 0 && r.timer;
    if (this.gpuLevel !== "epic" && from !== "low") {
      if (gpuOk) {
        if (r.gpuMs > budget * 0.9) to = LEVELS[LEVELS.indexOf(from) - 1];
        if (r.gpuMs > budget * 1.8 && to !== "low") to = LEVELS[LEVELS.indexOf(to) - 1];
      } else if (r.frameMs > budget * 1.5) to = LEVELS[LEVELS.indexOf(from) - 1];
    }
    this.bench = { gpuMs: +r.gpuMs.toFixed(2), fps: Math.round(1000 / Math.max(r.frameMs, 0.1)), from, to, timer: gpuOk };
    if (to !== from && this.settings.preset === "auto") {
      this.set({ auto: to, preset: "auto" });
      const st = { from, to, res: this.settings.res3d };
      this.set({ stepped: st });
      this.onStepped(st);
    } else if (to !== from) this.settings = { ...this.settings, auto: to };
    else if (this.recalibrating) store.set(this.settings);
  }
  /** the player saw the step-down notice */
  ackStepped() { if (this.settings.stepped && !this.settings.stepped.ack) this.set({ stepped: { ...this.settings.stepped, ack: true } }); }

  /** in a match: a lower preset is suggested when the frame rate stays < 50 fps for 8 s (once per level per session) */
  startGuard(inMatch: () => boolean) {
    let low = 0;
    const offered = new Set<string>();
    setInterval(() => {
      const e = this.engine, s = this.settings;
      if (!inMatch() || document.visibilityState !== "visible" || e.suspended) { low = 0; return; }
      const cap = e.frameCap;
      if (cap > 0 && cap < 55) { low = 0; return; }
      const fps = e.liveFps();
      low = fps > 0 && fps < 50 ? low + 1 : 0;
      const cur: Level = s.preset === "auto" ? s.auto : s.preset === "custom" ? s.post : s.preset;
      if (low >= 8 && cur !== "low" && !offered.has(cur)) {
        offered.add(cur); low = 0;
        this.onSuggest(LEVELS[LEVELS.indexOf(cur) - 1], fps);
      }
    }, 1000);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** GPU ms (timer query when available) and frame ms (median) over `ms` of real frames */
const NO_TIMER = flag("notimer"); // tools: a Mac-like browser
function hasTimer(e: Engine) {
  if (NO_TIMER) return false;
  try { return !!(e.renderer.getContext() as WebGL2RenderingContext).getExtension("EXT_disjoint_timer_query_webgl2"); } catch { return false; }
}
async function measure(e: Engine, ms: number): Promise<{ gpuMs: number; frameMs: number; timer: boolean }> {
  const gl = e.renderer.getContext() as WebGL2RenderingContext;
  const ext = NO_TIMER ? null : gl.getExtension("EXT_disjoint_timer_query_webgl2") as { TIME_ELAPSED_EXT: number } | null;
  const gpu: number[] = [], dts: number[] = [];
  const pending: WebGLQuery[] = [];
  const step = e.step;
  let epoch = contextEpoch();
  const own = !!ext && !e.dynamicRes;
  e.gpuHold = own;
  let last = performance.now();
  e.step = function (this: Engine, dt: number) {
    const now = performance.now(); dts.push(now - last); last = now;
    let q: WebGLQuery | null = null;
    if (epoch !== contextEpoch()) { epoch = contextEpoch(); pending.length = 0; gl.getExtension("EXT_disjoint_timer_query_webgl2"); }
    if (ext && own && !(globalThis as { __stormTimer?: unknown }).__stormTimer && !pending.length) { q = gl.createQuery(); if (q) gl.beginQuery(ext.TIME_ELAPSED_EXT, q); }
    try { step.call(this, dt); } finally { if (q && ext) { gl.endQuery(ext.TIME_ELAPSED_EXT); pending.push(q); } }
    while (pending.length && gl.getQueryParameter(pending[0], gl.QUERY_RESULT_AVAILABLE)) {
      const pq = pending.shift()!;
      const v = (gl.getQueryParameter(pq, gl.QUERY_RESULT) as number) / 1e6;
      if (v > 0 && v < 500) gpu.push(v);
      gl.deleteQuery(pq);
    }
  };
  await sleep(ms);
  e.step = step;
  e.gpuHold = false;
  if (epoch === contextEpoch()) for (const q of pending) gl.deleteQuery(q);
  const med = (a: number[]) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
  return { gpuMs: med(gpu), frameMs: med(dts.slice(5)), timer: gpu.length >= 5 };
}
