// Playtest triage: turns a folder of playtest bundles (the <UTC time>-<report id>/bundle.json folders the game server writes
// when KR_PLAYTEST_BUNDLES is set) into three files that rank what players are hitting, with no model call and no network:
//   index.jsonl    one line per bundle: build, kind, symptoms, config, location, worst stall, attribution, fingerprint, severity
//   clusters.json  bundles grouped by fingerprint, ranked by distinct players x worst severity x recency (adds player notes)
//   clusters.md    the same ranking for a person to read: no callsigns, no player notes, no screenshots
// Run: npx tsx tools/playtest/triage.mts [--dir DIR] [--out DIR]   (DIR as in cli.mts; the output defaults to DIR)
// Rerunning on the same bundles writes the same bytes. Everything a bundle holds came from a player, so every field is
// read defensively (analysis.mts) and the strings that reach the output are length-capped. cli.mts watch reuses the
// per-bundle and ticker functions exported here.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PHASES, PHASE_PLAY, analyse, bundleFolders, dig, finite, isRec, loadBundle, resolveDir, series, text } from "./analysis.mts";
import type { Rec, Saved } from "./analysis.mts";
import { POIS } from "../../shared/world/map";

/** a frame this long while playing is a stall */
export const STALL_MS = 100;
/** a stall this long is worse than the rest */
export const STALL_BAD_MS = 500;
export const LOW_FPS = 30;
/** low-fps and the fps numbers need at least this many live play seconds */
export const MIN_PLAY_S = 10;
export const HITCHY_STALL_S_PER_10_MIN = 10;
/** a shorter play session is too small a sample to call hitchy */
export const HITCHY_MIN_PLAY_S = 60;
export const LAG_MIN_S = 3;
export const MEMORY_SLOPE_MB_PER_MIN = 20;
/** heap at or above this share of ctx.perf.heapMB.limit counts as memory trouble */
export const HEAP_LIMIT_SHARE = 0.9;
export const SLOW_LOAD_MS = 40_000;
/** a diag event this close (page seconds) to the worst stall is its attribution */
export const ATTRIBUTION_WINDOW_S = 1;
/** a path row this close (page seconds) to the stall gives the stall's position */
export const PATH_MATCH_S = 5;
/** with no path row at the stall, where the player was when they reported stands in for it only if the stall was this recent (page seconds) */
export const STALL_RECENT_S = 10;
export const GRID_M = 100;
/** the nearest POI is named only when the player is inside it or within this many metres of its edge */
export const POI_NEAR_M = 150;
export const SEVERITY = { crash: 10, stallBad: 5, "low-fps": 3, lag: 3, memory: 3, "slow-load": 2, error: 2, hitchy: 2, stall: 2, other: 1 } as const;
export const REPRESENTATIVES = 3;
/** flags every playtest bundle carries or that don't change how the game runs: left out of the config */
export const IGNORED_FLAGS = ["perfhud", "seed"];
export const RECENT_HOUR_MS = 3_600_000;
const NOTE_MAX = 300;

export type Symptom = "crash" | "stall" | "low-fps" | "hitchy" | "lag" | "memory" | "slow-load" | "error" | "other";
const SYMPTOM_ORDER: Symptom[] = ["crash", "hitchy", "stall", "low-fps", "lag", "memory", "slow-load", "error", "other"];
const LABEL: Record<Symptom, string> = { crash: "Crash", stall: "Stall", "low-fps": "Low FPS", hitchy: "Hitching", lag: "Lag", memory: "Memory growth", "slow-load": "Slow load", error: "Error", other: "Report" };
const weight = (s: Symptom, stallMs: number | null) => (s === "stall" && (stallMs ?? 0) > STALL_BAD_MS ? SEVERITY.stallBad : SEVERITY[s]);

export interface IndexEntry {
  id: string; receivedAt: string;
  build: { branch: string | null; sha: string | null };
  kind: "crash" | "mark" | "report";
  symptoms: Symptom[];
  configKey: string;
  config: { browser: { family: string; major: number | null }; os: string; gpuVendor: string; gpuTier: string; preset: string; dprBucket: string; memoryBucket: string; nonDefaultFlags: string[] };
  location: { phase: string; poi: string | null; cell: string | null };
  worstStall: { t: number; maxMs: number; phase: string } | null;
  attribution: string | null;
  errorKey: string | null;
  fps: { p50: number | null; p5: number | null };
  heapPeakMB: number | null;
  installHash: string | null;
  fingerprint: string;
  severity: number;
}

export function browserOf(ua: string) {
  const hit = (re: RegExp) => { const m = re.exec(ua); return m ? Number(m[1]) : null; };
  const edge = hit(/Edg(?:e|A|iOS)?\/(\d+)/), opera = hit(/OPR\/(\d+)/), firefox = hit(/(?:Firefox|FxiOS)\/(\d+)/), chrome = hit(/(?:Chrome|CriOS)\/(\d+)/), safari = /Safari\//.test(ua) ? hit(/Version\/(\d+)/) : null;
  if (edge !== null) return { family: "Edge", major: edge };
  if (opera !== null) return { family: "Opera", major: opera };
  if (firefox !== null) return { family: "Firefox", major: firefox };
  if (chrome !== null) return { family: "Chrome", major: chrome };
  if (safari !== null) return { family: "Safari", major: safari };
  return { family: "other", major: null };
}

const osOf = (ua: string) => /Android/.test(ua) ? "Android" : /iPhone|iPad|iPod/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /CrOS/.test(ua) ? "ChromeOS" : /Linux|X11/.test(ua) ? "Linux" : "other";

function gpuVendorOf(renderer: string) {
  const r = renderer.toLowerCase();
  if (/swiftshader|llvmpipe|software/.test(r)) return "software";
  if (/nvidia|geforce|\brtx\b|\bgtx\b/.test(r)) return "nvidia";
  if (/apple/.test(r)) return "apple";
  if (/\bamd\b|radeon|\bati\b/.test(r)) return "amd";
  if (/intel/.test(r)) return "intel";
  if (/adreno|qualcomm/.test(r)) return "qualcomm";
  if (/\bmali\b|\barm\b/.test(r)) return "arm";
  return "unknown";
}

const dprBucket = (dpr: number | null) => (dpr === null ? "unknown" : dpr < 1.25 ? "1x" : dpr < 1.75 ? "1.5x" : dpr < 2.5 ? "2x" : "3x+");
const memoryBucket = (gb: number | null) => (gb === null ? "unknown" : gb <= 2 ? "<=2GB" : gb <= 4 ? "4GB" : "8GB+");
const word = (v: unknown) => { const s = text(v, 12)?.toLowerCase().replace(/[^a-z0-9-]/g, ""); return s || "unknown"; };

/** the volatile parts of a string removed (bundle file hashes, line numbers, counts, timings) so two reports of one cause match */
export function stripVolatile(s: string) {
  return s.replace(/[-.][A-Za-z0-9_-]{6,12}(?=\.(?:js|mjs|css|wasm)\b)/g, "").replace(/:\d+/g, "").replace(/[+-]?\d+(?:\.\d+)?/g, "").replace(/\s+/g, " ").trim().slice(0, 100);
}

const sha = (v: string) => crypto.createHash("sha256").update(v).digest("hex").slice(0, 12);
const firstLine = (s: string) => s.split(/\r?\n/, 1)[0].trim();

interface DiagEvent { t: number; kind: string; n: number; text: string }
function diagEvents(ctx: Rec | null): DiagEvent[] {
  const ev = dig(ctx, "diag", "events");
  if (!Array.isArray(ev)) return [];
  const out: DiagEvent[] = [];
  for (const e of ev.slice(0, 5000)) {
    if (!Array.isArray(e) || typeof e[1] !== "string") continue;
    const t = finite(e[0]);
    if (t !== null) out.push({ t, kind: e[1].slice(0, 20), n: finite(e[2]) ?? 0, text: text(e[3], 200) ?? "" });
  }
  return out;
}

const knownPoi = (v: unknown) => { const id = text(v, 40)?.replace(/^poi:/, ""); return id && POIS.some((p) => p.id === id) ? id : null; };
/** a stream module id ("poi:<map id>" or a plain id such as "exits") as a name safe to print; the POI's name for a map POI */
function moduleName(id: string) {
  const poi = knownPoi(id);
  if (poi) return POIS.find((p) => p.id === poi)!.name;
  return /^[a-z0-9][a-z0-9_-]{0,31}$/.test(id) ? id : "unknown";
}

/** attribution reaches clusters.md and the ticker: keep only the characters a script name and position need */
const printable = (s: string) => s.replace(/[^A-Za-z0-9 @._:/+-]/g, "").slice(0, 80);

const ATTRIBUTION_ORDER = [["loaf", "longtask"], ["programs"], ["module-failed"], ["module-built"], ["gc"], ["context-lost"]];
function attributionOf(events: DiagEvent[], at: number) {
  const near = events.filter((e) => Math.abs(e.t - at) <= ATTRIBUTION_WINDOW_S);
  for (const kinds of ATTRIBUTION_ORDER) {
    const pick = near.filter((e) => kinds.includes(e.kind)).sort((a, b) => b.n - a.n)[0];
    if (!pick) continue;
    if (pick.kind === "programs") return `shader programs +${Math.round(pick.n)}`;
    if (pick.kind === "module-failed") return `Module failed ${moduleName(pick.text)}`;
    if (pick.kind === "module-built") return `Module build ${moduleName(pick.text)}`;
    if (pick.kind === "gc") return `GC -${Math.round(pick.n)} MB`;
    if (pick.kind === "context-lost") return "context lost";
    return printable(pick.text) || `${pick.kind} ${Math.round(pick.n)} ms`;
  }
  return null;
}

function errorKeyOf(s: Saved, events: DiagEvent[]) {
  const failed = events.find((e) => e.kind === "module-failed" && !events.some((b) => b.kind === "module-built" && b.text === e.text && b.t > e.t));
  const diag = events.find((e) => e.kind === "error" || e.kind === "rejection");
  const log = s.logs.find((l) => l.level === "error" && /^\[(?:uncaught|unhandled rejection)\]/.test(l.text));
  if (!diag && !log && failed) return `module build failed ${moduleName(failed.text)}`;
  const raw = diag ? diag.text : log ? log.text : null;
  return raw === null ? null : stripVolatile(firstLine(raw)) || "unknown error";
}

function phaseName(v: unknown) {
  if (typeof v === "number") return v >= 0 ? PHASES[v] ?? "unknown" : "title";
  return typeof v === "string" && v ? word(v) : null;
}

/** where the player was at page second `at` (the diag path row nearest it), else where they were when they sent the report (at `now`) if `at` is null or recent */
function positionAt(ctx: Rec | null, at: number | null, now: number | null): [number, number] | null {
  const fields = dig(ctx, "diag", "path", "fields"), rows = dig(ctx, "diag", "path", "rows");
  if (at !== null && Array.isArray(fields) && Array.isArray(rows)) {
    const ti = fields.indexOf("t"), xi = fields.indexOf("x"), zi = fields.indexOf("z");
    let best: [number, number] | null = null, gap = PATH_MATCH_S;
    if (ti >= 0 && xi >= 0 && zi >= 0) for (const r of rows.slice(0, 20_000)) {
      const t = Array.isArray(r) ? finite(r[ti]) : null, x = Array.isArray(r) ? finite(r[xi]) : null, z = Array.isArray(r) ? finite(r[zi]) : null;
      if (t !== null && x !== null && z !== null && Math.abs(t - at) <= gap) { gap = Math.abs(t - at); best = [x, z]; }
    }
    if (best) return best;
  }
  if (at !== null && (now === null || now - at > STALL_RECENT_S)) return null;
  const pos = dig(ctx, "game", "player", "pos");
  const x = Array.isArray(pos) ? finite(pos[0]) : null, z = Array.isArray(pos) ? finite(pos[2]) : null;
  return x !== null && z !== null ? [x, z] : null;
}

/** the POI the position is inside or within POI_NEAR_M of the edge of (the closest edge wins); only ids from the map */
function poiAt(pos: [number, number]) {
  let best: string | null = null, edge = POI_NEAR_M;
  for (const p of POIS) {
    const e = Math.hypot(pos[0] - p.x, pos[1] - p.z) - p.r;
    if (e <= edge) { edge = e; best = p.id; }
  }
  return best;
}

/** the fingerprint, symptoms and the rest of one bundle; note is the player's own words (kept out of the index) */
export function triageBundle(s: Saved): { entry: IndexEntry; note: string | null } {
  const sr = series(s), a = analyse(s, sr), ctx = s.ctx;
  const events = diagEvents(ctx), prevRaw = dig(ctx, "diag", "prev");
  const prev = isRec(prevRaw) && prevRaw.clean !== true && Object.keys(prevRaw).length > 0 ? prevRaw : null;
  const kind = prev || /^crash/i.test(s.message.trim()) ? "crash" : s.bundle.mark ? "mark" : "report";

  const playSeconds = sr.live.filter((i) => sr.phase[i] === PHASE_PLAY);
  const stallSeconds = sr.live.filter((i) => sr.over100[i] > 0 || sr.max[i] > STALL_MS);
  const playStalls = stallSeconds.filter((i) => sr.phase[i] === PHASE_PLAY);
  const worstIdx = (list: number[]) => list.reduce<number | null>((w, i) => (w === null || sr.max[i] > sr.max[w] ? i : w), null);
  const worst = worstIdx(playStalls) ?? worstIdx(stallSeconds);
  const worstStall = worst === null ? null : { t: sr.t[worst], maxMs: sr.max[worst], phase: sr.where(worst) };

  const playFps = playSeconds.map((i) => sr.fps[i]).sort((x, y) => x - y);
  const pick = (p: number) => (playFps.length >= MIN_PLAY_S ? Math.round(playFps[Math.min(playFps.length - 1, Math.floor(p * playFps.length))] * 10) / 10 : null);
  const fps = { p50: pick(0.5), p5: pick(0.05) };

  const heapValues = [...sr.heap.filter((h) => h >= 0), finite(dig(ctx, "perf", "heapMB", "used")), finite(prev?.heapMB)].filter((v): v is number => v !== null);
  const heapPeakMB = heapValues.length ? Math.max(...heapValues) : null;
  const heapLimit = finite(dig(ctx, "perf", "heapMB", "limit"));
  const errorKey = errorKeyOf(s, events);
  const readyAtMs = finite(dig(ctx, "boot", "readyAtMs"));

  const ua = text(dig(ctx, "env", "ua"), 400) ?? "";
  const browser = browserOf(ua);
  const nonDefaultFlags = Object.entries(s.bundle.flags).filter(([k]) => !IGNORED_FLAGS.includes(k)).map(([k, v]) => (v ? `${k}=${v}` : k)).sort();
  const config = {
    browser, os: osOf(ua), gpuVendor: gpuVendorOf(text(dig(ctx, "gpu", "renderer"), 300) ?? ""), gpuTier: word(dig(ctx, "gpu", "level")),
    preset: word(dig(ctx, "video", "preset")), dprBucket: dprBucket(finite(dig(ctx, "env", "dpr"))), memoryBucket: memoryBucket(finite(dig(ctx, "env", "memoryGB"))), nonDefaultFlags,
  };
  const configKey = [browser.family + (browser.major === null ? "" : " " + browser.major), config.os, config.gpuVendor, config.gpuTier, config.preset, config.dprBucket, config.memoryBucket, nonDefaultFlags.join("+") || "-"].join("|");

  const software = config.gpuVendor === "software";
  const found = new Set<Symptom>();
  if (kind === "crash") found.add("crash");
  if (playStalls.length && !software) found.add("stall");
  if (!software && playSeconds.length >= MIN_PLAY_S && fps.p50 !== null && fps.p50 < LOW_FPS) found.add("low-fps");
  if (!software && playSeconds.length >= HITCHY_MIN_PLAY_S && playStalls.length / (playSeconds.length / 600) > HITCHY_STALL_S_PER_10_MIN) found.add("hitchy");
  if (a.network.lagSpikeSeconds >= LAG_MIN_S) found.add("lag");
  if ((a.memory.heapSlopeMBPerMin ?? 0) > MEMORY_SLOPE_MB_PER_MIN || (heapLimit !== null && heapLimit > 0 && heapPeakMB !== null && heapPeakMB >= heapLimit * HEAP_LIMIT_SHARE)) found.add("memory");
  if (readyAtMs !== null && readyAtMs > SLOW_LOAD_MS) found.add("slow-load");
  if (errorKey !== null) found.add("error");
  if (!found.size) found.add("other");

  const stallMs = found.has("stall") && worstStall ? worstStall.maxMs : null;
  const symptoms = SYMPTOM_ORDER.filter((x) => found.has(x)).sort((x, y) => weight(y, stallMs) - weight(x, stallMs));
  const top = symptoms[0];

  const prevPhase = prev ? phaseName(prev.phase) : null;
  const phase = prevPhase ?? worstStall?.phase ?? phaseName(dig(ctx, "game", "match", "phase")) ?? "title";
  const reportT = sr.t.length ? Math.max(...sr.t) : null;
  const prevX = finite(prev?.x), prevZ = finite(prev?.z);
  const position = prev ? (prevX !== null && prevZ !== null ? [prevX, prevZ] as [number, number] : null) : positionAt(ctx, worstStall?.t ?? null, reportT);
  const stale = worstStall !== null && (reportT === null || reportT - worstStall.t > STALL_RECENT_S);
  const location = { phase, poi: prev ? (position ? poiAt(position) : knownPoi(prev.poi)) : (position ? poiAt(position) : stale ? null : knownPoi(dig(ctx, "game", "player", "poi", "id"))), cell: position ? `${Math.floor(position[0] / GRID_M)},${Math.floor(position[1] / GRID_M)}` : null };

  const attribution = worstStall ? attributionOf(events, worstStall.t) : null;
  const slot = attribution ? stripVolatile(attribution) : top === "error" ? errorKey : null;
  const fingerprint = [top, phase, location.poi ?? "-", slot || "-", browser.family, config.gpuTier].join("|");

  const identity = s.reporter.clientId ?? text(dig(ctx, "diag", "install"), 64) ?? text(dig(ctx, "diag", "sid"), 64);
  const entry: IndexEntry = {
    id: s.id, receivedAt: s.receivedAt,
    build: { branch: s.bundle.build?.branch ?? null, sha: s.bundle.build?.sha ?? null },
    kind, symptoms, configKey, config, location, worstStall, attribution, errorKey, fps, heapPeakMB,
    installHash: identity ? sha(identity) : null, fingerprint, severity: Math.max(...symptoms.map((x) => weight(x, stallMs))),
  };
  return { entry, note: kind !== "mark" && s.message.trim() ? s.message.trim().slice(0, NOTE_MAX) : null };
}

export interface Cluster {
  fingerprint: string; title: string; symptom: Symptom; count: number; distinctInstalls: number;
  builds: string[]; configs: string[]; severity: number; recency: number; score: number; newestAt: string;
  attribution: string | null; representatives: string[]; notes: Array<{ id: string; text: string }>;
}

const ms = (iso: string) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : 0; };
export const configLabel = (e: IndexEntry) => [e.config.browser.family + (e.config.browser.major === null ? "" : " " + e.config.browser.major), e.config.os, e.config.gpuVendor, e.config.gpuTier].join(" · ");
export const symptomLabel = (e: IndexEntry) => LABEL[e.symptoms[0]];
const players = (n: number) => `${n} player${n === 1 ? "" : "s"}`;

export function buildClusters(entries: IndexEntry[], notes: Map<string, string> = new Map()): Cluster[] {
  const newest = Math.max(0, ...entries.map((e) => ms(e.receivedAt)));
  const groups = new Map<string, IndexEntry[]>();
  for (const e of entries) groups.set(e.fingerprint, [...(groups.get(e.fingerprint) ?? []), e]);
  const out: Cluster[] = [];
  for (const [fingerprint, list] of groups) {
    const reps = [...list].sort((x, y) => y.severity - x.severity || ms(y.receivedAt) - ms(x.receivedAt) || (x.id < y.id ? -1 : 1));
    const lead = reps[0];
    const distinctInstalls = new Set(list.map((e) => e.installHash).filter((h) => h !== null)).size + list.filter((e) => e.installHash === null).length;
    const severity = lead.severity;
    const ageDays = (newest - Math.max(...list.map((e) => ms(e.receivedAt)))) / 86_400_000;
    const recency = 0.5 ** Math.max(0, Math.ceil(ageDays) - 1);
    const attrs = new Map<string, number>();
    for (const e of list) if (e.attribution) attrs.set(e.attribution, (attrs.get(e.attribution) ?? 0) + 1);
    const commonAttribution = [...attrs].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))[0]?.[0] ?? null;
    out.push({
      fingerprint,
      title: `${symptomLabel(lead)} in ${lead.location.phase}${lead.location.poi ? " at " + lead.location.poi : ""}: ${lead.config.browser.family}, ${lead.config.gpuTier} tier (${players(distinctInstalls)})`,
      symptom: lead.symptoms[0], count: list.length, distinctInstalls,
      builds: [...new Set(list.map((e) => (e.build.sha ? (e.build.branch ? `${e.build.branch}@${e.build.sha}` : e.build.sha) : "unknown")))].sort(),
      configs: [...new Set(list.map((e) => e.configKey))].sort(),
      severity, recency, score: Math.round(distinctInstalls * severity * recency * 1000) / 1000,
      newestAt: new Date(Math.max(...list.map((e) => ms(e.receivedAt)))).toISOString(), attribution: commonAttribution,
      representatives: reps.slice(0, REPRESENTATIVES).map((e) => e.id),
      notes: reps.filter((e) => notes.has(e.id)).slice(0, 5).map((e) => ({ id: e.id, text: notes.get(e.id)! })),
    });
  }
  return out.sort((x, y) => y.score - x.score || y.count - x.count || (x.fingerprint < y.fingerprint ? -1 : 1));
}

/** the ranking as a page for a person: structured fields only, so no callsign, player note or screenshot can reach it */
export function clustersMarkdown(entries: IndexEntry[], clusters: Cluster[]) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const newest = entries.length ? new Date(Math.max(...entries.map((e) => ms(e.receivedAt)))).toISOString().replace("T", " ").slice(0, 16) : "-";
  const L = ["# Playtest triage", "", `${entries.length} reports in ${clusters.length} clusters. Newest report ${newest} UTC.`, ""];
  clusters.forEach((c, i) => {
    const configs = c.configs.slice(0, 5).map((k) => k.split("|").slice(0, 4).join(" · "));
    L.push(`## ${i + 1}. ${c.title}`, "",
      `Score ${c.score} · ${c.count} report${c.count === 1 ? "" : "s"} from ${players(c.distinctInstalls)} · worst severity ${c.severity} · newest ${c.newestAt.replace("T", " ").slice(0, 16)} UTC`, "");
    if (c.attribution) L.push(`- Likely cause: ${c.attribution}`);
    L.push(`- Builds: ${c.builds.slice(0, 5).join(", ")}`, `- Configs: ${[...new Set(configs)].join("; ")}`, `- Reports: ${c.representatives.filter((id) => byId.has(id)).join(", ")}`, "");
  });
  return L.join("\n");
}

/** one line for the OBS ticker: reports in the last hour, the top cluster of those, and the newest report */
export function tickerLine(entries: IndexEntry[], now: number) {
  const recent = entries.filter((e) => now - ms(e.receivedAt) <= RECENT_HOUR_MS);
  const head = `${recent.length} report${recent.length === 1 ? "" : "s"} this hour`;
  if (!recent.length) return head;
  const top = buildClusters(recent)[0], lead = recent.find((e) => e.id === top.representatives[0])!;
  const latest = [...recent].sort((x, y) => ms(y.receivedAt) - ms(x.receivedAt) || (x.id < y.id ? -1 : 1))[0];
  return `${head} · top: ${symptomLabel(lead)}${lead.location.poi ? " at " + lead.location.poi : ""}, ${lead.config.browser.family} (${top.distinctInstalls}) · latest: ${symptomLabel(latest)}, ${latest.config.browser.family}, ${latest.config.os}`;
}

function writeIfChanged(file: string, content: string) {
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === content) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** triage every bundle in dir and write the three files to out; returns what it found */
export function runTriage(dir: string, out: string, warn: (msg: string) => void = (m) => console.error(m)) {
  const entries = new Map<string, IndexEntry>(), notes = new Map<string, string>();
  let skipped = 0;
  for (const folder of bundleFolders(dir)) {
    const loaded = loadBundle(dir, folder);
    if (!loaded.ok) { skipped++; warn(`warning: skipping ${folder}: ${loaded.reason}`); continue; }
    const { entry, note } = triageBundle(loaded.value);
    const old = entries.get(entry.id);
    if (old && ms(old.receivedAt) > ms(entry.receivedAt)) continue;
    entries.set(entry.id, entry);
    if (note) notes.set(entry.id, note); else notes.delete(entry.id);
  }
  const list = [...entries.values()].sort((x, y) => ms(x.receivedAt) - ms(y.receivedAt) || (x.id < y.id ? -1 : 1));
  const clusters = buildClusters(list, notes);
  writeIfChanged(path.join(out, "index.jsonl"), list.map((e) => JSON.stringify(e) + "\n").join(""));
  writeIfChanged(path.join(out, "clusters.json"), JSON.stringify({ reports: list.length, clusters }, null, 2) + "\n");
  writeIfChanged(path.join(out, "clusters.md"), clustersMarkdown(list, clusters) + "\n");
  return { entries: list, clusters, skipped };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  const opt = (n: string) => { const i = argv.indexOf(n); return i < 0 ? undefined : argv[i + 1]; };
  const dir = resolveDir(opt("--dir")), out = path.resolve(opt("--out") ?? dir);
  if (!fs.existsSync(dir)) { console.error(`no bundle folder ${dir}`); process.exit(1); }
  const r = runTriage(dir, out);
  console.log(`${r.entries.length} reports, ${r.clusters.length} clusters${r.skipped ? `, ${r.skipped} skipped` : ""} -> ${out}`);
}
