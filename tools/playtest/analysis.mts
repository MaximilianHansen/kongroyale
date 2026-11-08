// Shared playtest-bundle reading for tools/playtest/cli.mts and tools/playtest/triage.mts: where the bundle folder is,
// how a bundle.json is loaded and cleaned (a bundle comes from a player, so every field may be missing or the wrong
// type), the per-second timeline columns, and analyse(), the stall / lag / memory summary both tools build on.
// Pure reading: nothing here writes a file, calls a model or touches the network.
import fs from "node:fs";
import path from "node:path";

export const PHASES = ["warmup", "plane", "play", "results"];
export const PHASE_PLAY = 2;
/** a bundle.json bigger than this is skipped (the server caps what it writes at 8 MiB) */
export const BUNDLE_FILE_MAX_BYTES = 16 * 1024 * 1024;
/** a second counts as a lag spike when ping is over twice the session median plus PING_SPIKE_BASE_MS, or jitter is over JITTER_SPIKE_MS */
export const PING_SPIKE_BASE_MS = 40;
export const JITTER_SPIKE_MS = 15;

export type Rec = Record<string, unknown>;
export interface Timeline { fields: string[]; rows: number[][]; dropped: number }
/** the game server's checkout, which the server records with every report */
export interface BuildId { branch: string | null; sha: string }
export interface Saved {
  id: string; message: string; receivedAt: string;
  reporter: { name: string | null; clientId: string | null };
  ctx: Rec | null;
  logs: Array<{ t: number; level: string; text: string; n: number }>;
  bundle: { mark: boolean; timeline: Timeline | null; flags: Record<string, string>; build: BuildId | null; replay: { ticks: number; events: unknown[]; opts: { seed?: number; mode?: string } } | null };
}

export const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
export const text = (v: unknown, max = 200) => (typeof v === "string" ? v.slice(0, max) : null);
export const finite = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** read ctx.a.b.c without trusting any link of the chain */
export function dig(v: unknown, ...keys: string[]): unknown {
  let cur = v;
  for (const k of keys) { if (!isRec(cur)) return undefined; cur = cur[k]; }
  return cur;
}

export const q = (s: number[], p: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN);
export const sorted = (a: number[]) => [...a].sort((x, y) => x - y);
export const r1 = (v: number) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

/** the bundle folder: --dir, else KR_PLAYTEST_BUNDLES when it is a path, else playtest-bundles/ in the checkout */
export function resolveDir(flag: string | undefined) {
  const setting = process.env.KR_PLAYTEST_BUNDLES;
  const root = path.resolve(import.meta.dirname, "../..");
  return path.resolve(flag ?? (setting && setting !== "0" && setting !== "1" ? setting : path.join(root, "playtest-bundles")));
}

export const bundleFolders = (dir: string) => {
  try { return fs.readdirSync(dir).filter((f) => fs.existsSync(path.join(dir, f, "bundle.json"))).sort(); } catch { return []; }
};

function cleanTimeline(v: unknown): Timeline | null {
  if (!isRec(v) || !Array.isArray(v.fields) || !Array.isArray(v.rows)) return null;
  const fields = v.fields.slice(0, 64).filter((f): f is string => typeof f === "string");
  const rows = v.rows.filter((r): r is number[] => Array.isArray(r) && r.length === fields.length && r.every((x) => typeof x === "number"));
  return { fields, rows, dropped: finite(v.dropped) ?? 0 };
}

const cleanBuild = (v: unknown): BuildId | null =>
  isRec(v) && typeof v.sha === "string" ? { branch: text(v.branch, 80), sha: v.sha.slice(0, 40) } : null;

/** reduce whatever a bundle.json holds to the shape the tools read; null when it is not a playtest bundle at all */
export function cleanBundle(raw: unknown): Saved | null {
  if (!isRec(raw) || !isRec(raw.bundle)) return null;
  const b = raw.bundle;
  const flags: Record<string, string> = {};
  if (isRec(b.flags)) for (const [k, v] of Object.entries(b.flags).slice(0, 64)) if (typeof v === "string") flags[k.slice(0, 40)] = v.slice(0, 80);
  const replay = isRec(b.replay) && Array.isArray(b.replay.events) && isRec(b.replay.opts)
    ? { ticks: finite(b.replay.ticks) ?? 0, events: b.replay.events, opts: { seed: finite(b.replay.opts.seed) ?? undefined, mode: text(b.replay.opts.mode, 40) ?? undefined } }
    : null;
  // the tools read diagnostics as ctx.diag, where reports sent them before the server validated them as bundle.diag
  const ctx = isRec(b.diag) ? { ...(isRec(raw.ctx) ? raw.ctx : {}), diag: b.diag } : isRec(raw.ctx) ? raw.ctx : null;
  return {
    id: text(raw.id, 64) ?? "unknown", message: text(raw.message, 2000) ?? "", receivedAt: text(raw.receivedAt, 40) ?? "",
    reporter: { name: text(dig(raw, "reporter", "name"), 40), clientId: text(dig(raw, "reporter", "clientId"), 64) },
    ctx,
    logs: (Array.isArray(raw.logs) ? raw.logs : []).filter(isRec).slice(-1500).map((l) => ({ t: finite(l.t) ?? 0, level: text(l.level, 20) ?? "", text: text(l.text, 2000) ?? "", n: finite(l.n) ?? 1 })),
    bundle: { mark: b.mark === true, timeline: cleanTimeline(b.timeline), flags, build: cleanBuild(raw.server), replay },
  };
}

/** load one bundle folder; the reason when it can't be used (so the caller can warn and go on) */
export function loadBundle(dir: string, folder: string): { ok: true; value: Saved } | { ok: false; reason: string } {
  const file = path.join(dir, folder, "bundle.json");
  try {
    if (fs.statSync(file).size > BUNDLE_FILE_MAX_BYTES) return { ok: false, reason: "bundle.json is too large" };
    const value = cleanBundle(JSON.parse(fs.readFileSync(file, "utf8")));
    return value ? { ok: true, value } : { ok: false, reason: "not a playtest bundle" };
  } catch (e) { return { ok: false, reason: e instanceof Error ? e.message.slice(0, 120) : "unreadable" }; }
}

/** the timeline as named columns, plus the indexes of seconds in which the game was drawing frames */
export function series(s: Saved) {
  const tl = s.bundle.timeline;
  const col = (name: string) => { const i = tl?.fields.indexOf(name) ?? -1; return i < 0 || !tl ? [] : tl.rows.map((r) => r[i]); };
  const c = {
    t: col("t"), fps: col("fps"), p95: col("p95Ms"), max: col("maxMs"), over50: col("over50"), over100: col("over100"),
    ping: col("pingMs"), jitter: col("jitterMs"), heap: col("heapMB"), tex: col("textures"), geo: col("geometries"), prog: col("programs"), phase: col("phase"), gpu: col("gpuMs"),
  };
  const live = c.fps.map((_, i) => i).filter((i) => c.fps[i] > 0);
  const where = (i: number) => (c.phase[i] >= 0 ? PHASES[c.phase[i]] ?? `phase ${c.phase[i]}` : "title");
  return { ...c, live, where, rows: tl?.rows.length ?? 0 };
}

export function analyse(s: Saved, sr = series(s)) {
  const { t, fps, p95, max, over50, over100, ping, jitter, heap, tex, geo, prog, gpu, live, where } = sr;
  const fpsLive = sorted(live.map((i) => fps[i])), p95Live = sorted(live.map((i) => p95[i]));
  const stalls = live.filter((i) => over50[i] > 0).sort((a, b) => max[b] - max[a]).slice(0, 8).map((i) => ({ t: r1(t[i]), maxMs: r1(max[i]), over50: over50[i], over100: over100[i], fps: r1(fps[i]), where: where(i) }));
  const pings = live.filter((i) => ping[i] >= 0), pingSorted = sorted(pings.map((i) => ping[i])), pingMed = q(pingSorted, 0.5);
  const lag = pings.filter((i) => ping[i] > pingMed * 2 + PING_SPIKE_BASE_MS || jitter[i] > JITTER_SPIKE_MS).map((i) => ({ t: r1(t[i]), pingMs: r1(ping[i]), jitterMs: r1(jitter[i]), where: where(i) }));
  const heapPts = live.filter((i) => heap[i] >= 0);
  let slope = NaN;
  if (heapPts.length > 10) {
    const xs = heapPts.map((i) => t[i] / 60), ys = heapPts.map((i) => heap[i]);
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
    const num = xs.reduce((a, x, k) => a + (x - mx) * (ys[k] - my), 0), den = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
    slope = den > 0 ? num / den : NaN;
  }
  const first = (a: number[]) => (a.length ? a[0] : NaN), last = (a: number[]) => (a.length ? a[a.length - 1] : NaN);
  const errors = s.logs.filter((l) => l.level === "error").slice(-8).map((l) => `${(l.t / 1000).toFixed(1)}s ${l.text.slice(0, 200)}${l.n > 1 ? ` (x${l.n})` : ""}`);
  return {
    id: s.id, message: s.message, at: s.receivedAt, reporter: s.reporter.name, mark: s.bundle.mark,
    build: s.bundle.build, flags: s.bundle.flags,
    seconds: sr.rows, droppedSeconds: s.bundle.timeline?.dropped ?? 0,
    fps: { median: r1(q(fpsLive, 0.5)), p5: r1(q(fpsLive, 0.05)), min: r1(fpsLive[0]) },
    frameP95Ms: { median: r1(q(p95Live, 0.5)), worst: r1(p95Live[p95Live.length - 1]) },
    gpuMs: { median: r1(q(sorted(gpu.filter((v) => v > 0)), 0.5)) },
    stalls: { secondsWithStall: live.filter((i) => over50[i] > 0).length, framesOver50ms: over50.reduce((a, b) => a + b, 0), framesOver100ms: over100.reduce((a, b) => a + b, 0), worst: stalls },
    network: { pingMedianMs: r1(pingMed), pingP95Ms: r1(q(pingSorted, 0.95)), lagSpikes: lag.slice(0, 12), lagSpikeSeconds: lag.length },
    memory: { heapStartMB: r1(first(heapPts.map((i) => heap[i]))), heapEndMB: r1(last(heapPts.map((i) => heap[i]))), heapMaxMB: r1(Math.max(...heapPts.map((i) => heap[i]))), heapSlopeMBPerMin: r1(slope), textures: [first(tex), last(tex)], geometries: [first(geo), last(geo)], programs: [first(prog), last(prog)] },
    replay: s.bundle.replay ? { ticks: s.bundle.replay.ticks, events: s.bundle.replay.events.length, seed: s.bundle.replay.opts.seed ?? null, mode: s.bundle.replay.opts.mode ?? null } : null,
    errors,
  };
}
