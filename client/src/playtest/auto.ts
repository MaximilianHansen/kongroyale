// Automatic performance summaries, the player's side (server/diag-auto.ts is the endpoint). Under player
// diagnostics, a build sends small anonymous rows, by navigator.sendBeacon to POST /api/diag/auto, when:
//   hitch      a frame over 250 ms in a match, or lowfps: 5 s in a row under 20 fps (together: at most one a minute, five a session)
//   ctxlost    the WebGL context is lost (at most two a session)
//   error      the same uncaught error a second time (a short hash of its first line, never its text; at most three a session)
//   crash      the previous session died (diag.ts finds it), sent on this load
//   match      one row of per-match stats when a match ends: the denominator that turns counts into rates
// A row is the version, a random id made for this page load (not kept on the device, so nothing links one visit to the next),
// the page second, a coarse config key (browser, system, graphics vendor and tier, preset, pixel ratio, memory) and up to 16
// numbers. No picture, replay, log, callsign, note, page address or error text. It stays under 4 KB.
// Consent (consent.ts): on by default and asks nothing, but nothing leaves until a small one-time toast has been shown on the
// title (this file shows it once the title is ready: it names the stats and links to Settings, and goes away by itself),
// never under the browser's privacy signal, and never after the player turned it off in Settings. A row that comes up
// before the toast has been shown waits in memory (at most eight) and is dropped if the player turns it off or the page ends. Model: tools/formal/DiagSend.tla (AutoOnlyAfterNotice, AutoRespectsOff).
import type { Engine } from "../engine/engine";
import type { Beat } from "./beat";
import { sid } from "./beat";
import { autoMaySend, autoOn, autoTold, markTold, privacySignal } from "./consent";
import { deadChecked, snapshot } from "./diag";

const HITCH_MS = 250, LOW_FPS = 20, LOW_S = 5, PERF_GAP_S = 60, MAX_PERF = 5, MAX_CTX = 2, MAX_ERR = 3, MAX_PENDING = 8, MIN_MATCH_S = 20, MAX_ROW_CHARS = 3800;
const NOTICE_TEXT = "Kong Royale sends anonymous performance stats to help fix lag. Change this in ", NOTICE_MS = 6000;
const PLAY = 2, RESULTS = 3;
const UI = { yellow: "#ffd400", creamText: "#fbf3c9", sans: "'KR Sans', Roboto, 'Helvetica Neue', Arial, sans-serif" };
const CSS = `
.ka-notice { position: fixed; right: 24px; bottom: 24px; z-index: 100001; max-width: min(380px, calc(100vw - 48px)); box-sizing: border-box; display: flex; gap: 10px; align-items: flex-start;
  background: rgba(10,30,46,0.94); border: 1px solid rgba(255,212,0,0.5); border-radius: 8px; padding: 10px 12px; font: 600 13px/1.4 ${UI.sans}; color: ${UI.creamText}; }
.ka-notice p { margin: 0; }
.ka-notice button { font: inherit; color: ${UI.yellow}; background: none; border: 0; padding: 0; cursor: pointer; }
.ka-notice .ka-settings { text-decoration: underline; }
.ka-notice .ka-close { font-size: 16px; line-height: 1; color: rgba(246,239,198,0.75); }
`;

type Kind = "hitch" | "lowfps" | "ctxlost" | "error" | "crash" | "match";
interface Row { v: 1; install: string; session: string; kind: Kind; t: number; config: string; build: string; sig: string | null; stats: Record<string, number> }
interface Kr { ready?: boolean; game?: { inMatch?: boolean; cm?: { time?: number } | null }; display?: { gpu?: string | null; gpuLevel?: string | null; settings?: { preset?: string } }; videoMenu?: { show(cat: string, sec?: number): void } }
const kr = () => (window as unknown as { __kr: Kr }).__kr;

const r2 = (v: number) => Math.round(v * 100) / 100;
const finite = (v: unknown, fallback = -1) => (typeof v === "number" && Number.isFinite(v) ? r2(v) : fallback);
const word = (v: unknown) => (typeof v === "string" ? v.toLowerCase().replace(/[^a-z0-9]+/g, "") : "") || "x";

/** the coarse config key, read from the display settings and the browser each time so a preset changed mid-visit is seen */
function configKey(): string {
  const K = kr(), ua = navigator.userAgent, gpu = (K.display?.gpu ?? "").toLowerCase();
  const browser = /Edg\//.test(ua) ? "edge" : /OPR\//.test(ua) ? "opera" : /Firefox\//.test(ua) ? "firefox" : /Chrom(e|ium)\//.test(ua) ? "chrome" : /Safari\//.test(ua) ? "safari" : "other";
  const os = /Android/.test(ua) ? "android" : /iPhone|iPad/.test(ua) ? "ios" : /Windows/.test(ua) ? "win" : /Mac OS/.test(ua) ? "mac" : /Linux/.test(ua) ? "linux" : "other";
  const vendor = /swiftshader|llvmpipe|software/.test(gpu) ? "software" : /nvidia|geforce/.test(gpu) ? "nvidia" : /amd|radeon/.test(gpu) ? "amd" : /intel/.test(gpu) ? "intel" : /apple/.test(gpu) ? "apple" : gpu ? "other" : "unknown";
  const dpr = devicePixelRatio, mem = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
  return [browser, os, vendor, word(K.display?.gpuLevel), word(K.display?.settings?.preset), dpr <= 1.25 ? "d1" : dpr <= 2.25 ? "d2" : "d3", typeof mem !== "number" ? "m0" : mem <= 4 ? "m4" : mem <= 8 ? "m8" : "m16"].join(":");
}

function hashOf(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return "e" + (h >>> 0).toString(16);
}

const base = () => (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/";
const idOf = (sha: string) => sha.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40) || "unknown";
const build = idOf((import.meta as unknown as { env?: { VITE_KR_SHA?: string } }).env?.VITE_KR_SHA ?? "");
const pending: Row[] = [];

function beacon(row: Row): void {
  const json = JSON.stringify(row);
  if (json.length > MAX_ROW_CHARS) return;
  try { navigator.sendBeacon?.(base() + "api/diag/auto", new Blob([json], { type: "application/json" })); } catch { /* summaries are best effort */ }
}

/** send now when the player was told and the setting is on; hold it until then while that can still happen; else drop it */
function emit(kind: Kind, stats: Record<string, number>, sig: string | null = null): void {
  const row: Row = { v: 1, install: sid, session: sid, kind, t: Math.round((performance.now() / 1000) * 10) / 10, config: configKey(), build, sig, stats };
  if (autoMaySend()) beacon(row);
  else if (!autoTold() && autoOn() && pending.length < MAX_PENDING) pending.push(row);
}

function showNotice(): HTMLElement {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
  const card = document.createElement("div"), text = document.createElement("p"), link = document.createElement("button"), close = document.createElement("button");
  card.className = "ka-notice"; card.setAttribute("role", "status");
  link.type = close.type = "button"; link.className = "ka-settings"; link.textContent = "Settings";
  close.className = "ka-close"; close.textContent = "×"; close.setAttribute("aria-label", "Close");
  text.append(NOTICE_TEXT, link, ".");
  link.addEventListener("click", () => { card.remove(); kr().videoMenu?.show("video", 2); });
  close.addEventListener("click", () => card.remove());
  card.append(text, close);
  document.body.appendChild(card);
  setTimeout(() => card.remove(), NOTICE_MS);
  markTold();
  return card;
}

/** wire the triggers; returns the recorder's per-second hook (it gets the new row's offset in the metrics ring) */
export function installAuto(engine: Engine, ring: Float32Array): (at: number) => void {
  const counts = { perf: 0, ctx: 0, err: 0 }, seen = new Map<string, number>();
  const perf = { last: -Infinity, low: 0 };
  const match = { on: false, sent: false, fps: [] as number[], p95: [] as number[], gpu: [] as number[], max: 0, stallS: 0, over50: 0, heap: -1, scale: 1 };
  const last = { phase: -1, clock: -1 };
  let notice: HTMLElement | null = null, noticed = false;

  engine.renderer.domElement.addEventListener("webglcontextlost", () => { if (counts.ctx++ < MAX_CTX) emit("ctxlost", { upS: finite(performance.now() / 1000) }); });
  const failed = (message: string) => {
    const sig = hashOf(message.split("\n")[0].replace(/[0-9]+/g, "0").slice(0, 120)), n = (seen.get(sig) ?? 0) + 1;
    seen.set(sig, n);
    if (n === 2 && counts.err++ < MAX_ERR) emit("error", { count: n }, sig);
  };
  addEventListener("error", (e) => failed(e.message || String(e.error)));
  addEventListener("unhandledrejection", (e) => failed(String((e.reason as Error | undefined)?.message ?? e.reason)));

  void deadChecked.done.then(() => {
    const prev = (snapshot() as { prev: Beat | null }).prev;
    if (!prev) return;
    emit("crash", { ageS: Math.round((Date.now() - prev.at) / 1000), upS: finite(prev.upS), phase: finite(prev.phase), heapMB: finite(prev.heapMB), textures: finite(prev.textures), geometries: finite(prev.geometries), fps: finite(prev.fps), hidden: prev.hidden ? 1 : 0 });
  });

  const median = (v: number[], p: number) => (v.length ? v.slice().sort((a, b) => a - b)[Math.min(v.length - 1, Math.floor(p * v.length))] : -1);
  const endMatch = () => {
    if (match.sent) return;
    match.sent = true;
    if (match.fps.length < MIN_MATCH_S) return;
    emit("match", { playS: match.fps.length, fpsP50: finite(median(match.fps, 0.5)), fpsP5: finite(median(match.fps, 0.05)), frameP95Ms: finite(median(match.p95, 0.5)), gpuMs: finite(median(match.gpu, 0.5)), maxMs: finite(match.max), stallS: match.stallS, over50: match.over50, heapPeakMB: finite(match.heap), renderScaleMin: finite(match.scale) });
  };

  return (at) => {
    const K = kr(), t = ring[at], fps = ring[at + 1], phase = ring[at + 15], maxMs = ring[at + 4], inMatch = phase >= 0;
    if (!noticed && K.ready && !K.game?.inMatch && document.visibilityState === "visible" && !privacySignal() && !autoTold()) { noticed = true; notice = showNotice(); }
    if (notice && K.game?.inMatch) { notice.remove(); notice = null; }
    if (pending.length) {
      if (autoMaySend()) for (const row of pending.splice(0)) beacon(row);
      else if (!autoOn()) pending.length = 0;
    }
    const clock = K.game?.cm?.time ?? -1, restarted = match.on && inMatch && (phase < last.phase || clock < last.clock - 1);
    last.phase = phase; last.clock = clock;
    if (restarted) { endMatch(); match.on = false; }
    if (inMatch && !match.on) Object.assign(match, { on: true, sent: false, fps: [], p95: [], gpu: [], max: 0, stallS: 0, over50: 0, heap: -1, scale: 1 });
    if (!inMatch && match.on) { endMatch(); match.on = false; }
    if (!inMatch || fps <= 0) { perf.low = 0; return; }
    if (phase === PLAY) {
      match.fps.push(fps); match.p95.push(ring[at + 3]); match.gpu.push(ring[at + 7]);
      match.max = Math.max(match.max, maxMs); match.over50 += ring[at + 5]; if (ring[at + 6] > 0) match.stallS++;
      match.heap = Math.max(match.heap, ring[at + 10]); match.scale = Math.min(match.scale, ring[at + 14]);
    }
    if (phase === RESULTS) endMatch();
    perf.low = fps < LOW_FPS ? perf.low + 1 : 0;
    const hitch = maxMs > HITCH_MS;
    if (!(hitch || perf.low >= LOW_S) || counts.perf >= MAX_PERF || t - perf.last < PERF_GAP_S) return;
    counts.perf++; perf.last = t; perf.low = 0;
    emit(hitch ? "hitch" : "lowfps", { fps: finite(fps), p50Ms: finite(ring[at + 2]), p95Ms: finite(ring[at + 3]), maxMs: finite(maxMs), over50: finite(ring[at + 5]), over100: finite(ring[at + 6]), gpuMs: finite(ring[at + 7]), heapMB: finite(ring[at + 10]), renderScale: finite(ring[at + 14]), phase: finite(phase), upS: finite(t) });
  };
}
