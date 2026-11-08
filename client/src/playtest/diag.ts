// Player diagnostics (?diag): what a stream player's report needs beyond the per-second metrics ring.
//   events     the moments that explain a hitch, newest 500: long animation frames with the script that ran longest
//              (Chrome and Edge; plain long tasks where only those exist), match phase changes, world modules streamed in
//              or evicted, shader-program jumps, 3D-resolution steps, a heap drop over 50 MB (a collection), WebGL context
//              loss, visibility, fullscreen and uncaught errors. Modules come from __kr.streamMs: what streams in after the
//              title (the builds a player can feel; ?nostream has none) with its build ms, failed builds, and lowmem
//              evictions and rebuilds (residency from __kr.modules).
//   path       the player's position and view once a second in a match (up to an hour): the route a camera-path bench
//              replays on another GPU
//   heartbeat  one record per session in localStorage, first written at boot (beat.ts, so a tab killed while the
//              world loads is caught), then every 5 s from here, marked clean on pagehide and running again on a
//              back/forward-cache pageshow. Each live page holds a Web Lock named after its session, so a later load
//              knows a session with no clean exit and no lock died (tab killed, browser crashed); it claims that record
//              under one lock and keeps it as `prev`, so one crash is reported once. Browsers without Web Locks keep no
//              heartbeat.
// snapshot() is __kr.diag.snapshot(); a report sends it as bundle.diag, which the server validates (parseBundle in
// server/playtest-bundles.ts) and stores.
import type { Engine } from "../engine/engine";
import { POIS } from "../../../shared/world/map";
import { BEAT_KEY, beat, live, locks, sid, writeBeat, type Beat, type Locks } from "./beat";

const MAX_EVENTS = 500, PATH_S = 3600, PATH_W = 7, LONG_MS = 100, GC_DROP_MB = 50, BEAT_S = 5, KEEP_MS = 7 * 86_400_000;
const CLAIM_KEY = "kr.diag.claim", NEAR_POI_M = 150;
const PATH_FIELDS = ["t", "x", "y", "z", "yawDeg", "pitchDeg", "phase"] as const;

/** [page seconds, kind, number, text] */
export type DiagEvent = [number, string, number, string];
interface KrGame { inMatch?: boolean; cm?: { pred?: { x: number; y: number; z: number } } | null; input?: { yaw: number; pitch: number } }
/** main.ts: streamMs = build ms of each module streamed in after the title, once integrated (a failed build too);
 *  modules = the modules resident now (a lowmem eviction removes one) */
type Kr = Record<string, unknown> & { ready?: boolean; game?: KrGame; streamMs?: Record<string, number>; modules?: string[] };
const kr = () => (window as unknown as { __kr: Kr }).__kr;

const events: DiagEvent[] = [];
const path = new Float32Array(PATH_S * PATH_W);
const pathCursor = { rows: 0 };
let prev: Beat | null = null;
let loafKind: string | null = null;
/** settles once this load knows whether an earlier session died (report.ts waits on it for the crash card) */
export const deadChecked = { done: Promise.resolve() };

const pageS = () => Math.round(performance.now() / 10) / 100;
const r1 = (v: number) => Math.round(v * 10) / 10;
function push(kind: string, n: number, text = "", t = pageS()): void {
  events.push([t, kind, n, text.slice(0, 200)]);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}

interface LoafScript { duration: number; invoker?: string; sourceURL?: string; sourceFunctionName?: string; sourceCharPosition?: number }
const fileOf = (url = "") => url.split(/[?#]/)[0].split("/").pop() || "?";
/** the script's invoker, function and file; a classic script's invoker is its URL, cut to the file so no origin or
 *  query string leaves the browser */
function script(s: LoafScript): string {
  const by = s.invoker?.includes("//") ? fileOf(s.invoker) : s.invoker ?? "?";
  return `${by} ${s.sourceFunctionName || "anonymous"}@${fileOf(s.sourceURL)}:${s.sourceCharPosition ?? -1} ${Math.round(s.duration)} ms`;
}
function observeLongFrames(): void {
  const types = (PerformanceObserver as unknown as { supportedEntryTypes?: readonly string[] }).supportedEntryTypes ?? [];
  loafKind = types.includes("long-animation-frame") ? "long-animation-frame" : types.includes("longtask") ? "longtask" : null;
  if (!loafKind) return;
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (e.duration < LONG_MS) continue;
      const scripts = (e as unknown as { scripts?: LoafScript[] }).scripts ?? [];
      let top: LoafScript | null = null;
      for (const s of scripts) if (!top || s.duration > top.duration) top = s;
      push(loafKind === "longtask" ? "longtask" : "loaf", Math.round(e.duration), top ? script(top) : "", Math.round(e.startTime / 10) / 100);
    }
  }).observe({ type: loafKind, buffered: true });
}

function readBeats(): Beat[] {
  const out: Beat[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(BEAT_KEY) || k === BEAT_KEY + sid) continue;
      const b = JSON.parse(localStorage.getItem(k) ?? "null") as Beat | null;
      if (b && typeof b.at === "number") out.push(b);
    }
  } catch { /* blocked storage */ }
  return out;
}

/** a session that never marked clean and whose page holds no lock died. The claim runs under one lock and deletes what
 *  it takes, so two tabs loading together never report the same crash. */
async function findDeadSession(locks: Locks): Promise<void> {
  const now = Date.now();
  for (const b of readBeats()) if (b.clean || now - b.at > KEEP_MS) localStorage.removeItem(BEAT_KEY + b.sid);
  const dead = (await locks.request(CLAIM_KEY, async () => {
    const held = new Set(((await locks.query()).held ?? []).map((l) => l.name));
    const out = readBeats().filter((b) => !b.clean && !held.has(BEAT_KEY + b.sid));
    for (const b of out) localStorage.removeItem(BEAT_KEY + b.sid);
    return out;
  })) as Beat[];
  for (const b of dead) if (!prev || b.at > prev.at) prev = b;
  if (prev) push("prev-session", Math.round((Date.now() - prev.at) / 1000), prev.phase >= 0 ? "died in a match" : "died outside a match");
}

/** the POI whose edge is nearest, if within NEAR_POI_M (kongbot/context.ts nearestPoi, kept here so this lazy chunk
 *  doesn't make the entry export it) */
function poiAt(x: number, z: number): string | null {
  let best: string | null = null, edge = NEAR_POI_M;
  for (const p of POIS) {
    const d = Math.hypot(x - p.x, z - p.z) - p.r;
    if (d <= edge) { edge = d; best = p.id; }
  }
  return best;
}

/** start sampling; returns the per-second hook for the recorder (it gets the new row's offset in the metrics ring) */
export function installDiag(engine: Engine, ring: Float32Array): (at: number) => void {
  observeLongFrames();
  const canvas = engine.renderer.domElement;
  canvas.addEventListener("webglcontextlost", () => push("context-lost", 0));
  canvas.addEventListener("webglcontextrestored", () => push("context-restored", 0));
  addEventListener("fullscreenchange", () => push("fullscreen", document.fullscreenElement ? 1 : 0));
  addEventListener("error", (e) => push("error", 0, e.message || String(e.error)));
  addEventListener("unhandledrejection", (e) => push("rejection", 0, String((e.reason as Error | undefined)?.message ?? e.reason)));

  const resident = new Set<string>(), failed = new Set<string>();
  const last = { phase: -2, programs: -1, scale: -1, heap: -1 };
  const held = locks;
  if (held) deadChecked.done = live.done.then(() => findDeadSession(held));
  addEventListener("visibilitychange", () => {
    push("visibility", document.visibilityState === "visible" ? 1 : 0, document.visibilityState);
    beat.hidden = document.visibilityState === "hidden"; beat.at = Date.now(); writeBeat(beat);
  });
  let seconds = 0;

  return (at) => {
    const K = kr(), g = K.game, p = g?.inMatch ? g.cm?.pred ?? null : null;
    const phase = ring[at + 15], programs = ring[at + 13], scale = ring[at + 14], heap = ring[at + 10];
    if (phase !== last.phase && last.phase !== -2) push("phase", phase);
    if (K.ready && last.programs >= 0 && programs > last.programs) push("programs", programs - last.programs);
    if (last.scale >= 0 && scale !== last.scale) push("scale", r1(scale * 100) / 100);
    if (last.heap >= 0 && heap >= 0 && last.heap - heap > GC_DROP_MB) push("gc", Math.round(last.heap - heap));
    last.phase = phase; last.programs = programs; last.scale = scale; last.heap = heap;
    const streamed = K.streamMs ?? {}, modules = K.modules ?? [];
    for (const id in streamed) {
      if (resident.has(id)) continue;
      if (modules.includes(id)) { failed.delete(id); resident.add(id); push("module-built", streamed[id], id); }
      else if (!failed.has(id)) { failed.add(id); push("module-failed", streamed[id], id); }
    }
    for (const id of failed) if (!(id in streamed)) failed.delete(id);
    for (const id of resident) if (!modules.includes(id)) { resident.delete(id); push("module-dropped", 0, id); }
    if (p && g?.input) {
      const row = (pathCursor.rows % PATH_S) * PATH_W;
      path[row] = ring[at]; path[row + 1] = p.x; path[row + 2] = p.y; path[row + 3] = p.z;
      path[row + 4] = (g.input.yaw * 180) / Math.PI; path[row + 5] = (g.input.pitch * 180) / Math.PI; path[row + 6] = phase;
      pathCursor.rows++;
    }
    if (++seconds % BEAT_S === 0) {
      Object.assign(beat, { at: Date.now(), upS: Math.round(ring[at]), phase, x: p ? Math.round(p.x) : null, z: p ? Math.round(p.z) : null, poi: p ? poiAt(p.x, p.z) : null, heapMB: Math.round(heap), textures: ring[at + 11], geometries: ring[at + 12], fps: Math.round(ring[at + 1]), hidden: document.visibilityState === "hidden" });
      writeBeat(beat);
    }
  };
}

/** what a report carries as bundle.diag */
export function snapshot() {
  const kept = Math.min(pathCursor.rows, PATH_S), rows: number[][] = [];
  for (let r = pathCursor.rows - kept; r < pathCursor.rows; r++) {
    const at = (r % PATH_S) * PATH_W;
    rows.push([r1(path[at]), r1(path[at + 1]), r1(path[at + 2]), r1(path[at + 3]), Math.round(path[at + 4]), Math.round(path[at + 5]), path[at + 6]]);
  }
  return { v: 1, sid, longFrames: loafKind, events: events.slice(), path: { fields: PATH_FIELDS, rows }, prev };
}
