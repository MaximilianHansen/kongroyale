import fs from "node:fs";
import path from "node:path";

export const BUNDLE_MAX_BYTES = 8 * 1024 * 1024;
const MAX_FIELDS = 32, MAX_ROWS = 7200, MAX_FLAGS = 200, MAX_REPLAY_EVENTS = 200_000, MAX_EVENT_LEN = 16, MAX_OPTS_BYTES = 4096;
const FIELD = /^[A-Za-z][A-Za-z0-9]{0,31}$/, FLAG_NAME = /^[A-Za-z0-9_-]{1,40}$/, SHA = /^(?:[0-9a-f]{7,40}|unknown)$/;
/** player diagnostics (client/src/playtest/diag.ts snapshot() plus what report.ts adds): the event ring holds 500 and
 *  the path an hour at 1 Hz on the client, so anything longer did not come from it */
const MAX_DIAG_EVENTS = 500, MAX_PATH_ROWS = 3600, MAX_PATH_FIELDS = 16, MAX_EVENT_TEXT = 200, MAX_DROPPED = 8;
const SID = /^[0-9a-f]{1,32}$/, INSTALL = /^[A-Za-z0-9_-]{1,64}$/, WORD = /^[a-z][a-z-]{0,23}$/, CHIP = /^[A-Za-z][A-Za-z ]{0,23}$/, POI = /^[a-z0-9-]{1,40}$/;
const KINDS = new Set(["crash", "report", "diagnostics"]);

export interface Timeline { fields: string[]; rows: number[][]; dropped: number }
export interface Replay { version: 1; opts: Record<string, unknown>; warmupS: number; endAfterResults: boolean; ticks: number; events: Array<Array<number | string>> }
/** [page seconds, kind, number, text] */
export type DiagEvent = [number, string, number, string];
/** the heartbeat record of a session that died (client/src/playtest/beat.ts Beat), as far as it can be read: an older
 *  build wrote it, so a field of the wrong type is null rather than a refused report */
export interface DiagPrev { sid: string | null; sha: string | null; at: number | null; upS: number | null; phase: number | null; x: number | null; z: number | null; poi: string | null; heapMB: number | null; textures: number | null; geometries: number | null; fps: number | null; hidden: boolean | null; clean: boolean | null }
export interface Diag { v: 1; sid: string; longFrames: string | null; events: DiagEvent[]; path: { fields: string[]; rows: number[][] }; prev: DiagPrev | null; install: string | null; kind: string; chip: string | null; dropped: string[] }
export interface Bundle { mark: boolean; timeline: Timeline | null; flags: Record<string, string>; replay: Replay | null; diag: Diag | null }

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
const bad = (error: string): { ok: false; error: string } => ({ ok: false, error });
const optStr = (v: unknown, re: RegExp): v is string | null => v === null || (typeof v === "string" && re.test(v));
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function parseTimeline(v: unknown): Parsed<Timeline | null> {
  if (v === null || v === undefined) return { ok: true, value: null };
  if (!isObj(v) || !Array.isArray(v.fields) || !Array.isArray(v.rows) || !finite(v.dropped) || v.dropped < 0) return bad("timeline must be { fields, rows, dropped }");
  if (v.fields.length === 0 || v.fields.length > MAX_FIELDS || !v.fields.every((f) => typeof f === "string" && FIELD.test(f))) return bad("timeline fields must be up to 32 plain names");
  if (v.rows.length > MAX_ROWS) return bad(`timeline holds at most ${MAX_ROWS} rows`);
  const width = v.fields.length;
  if (!v.rows.every((r) => Array.isArray(r) && r.length === width && r.every(finite))) return bad("timeline rows must be finite numbers, one per field");
  return { ok: true, value: { fields: v.fields.slice(), rows: v.rows.map((r) => (r as number[]).slice()), dropped: v.dropped } };
}

function parseFlags(v: unknown): Parsed<Record<string, string>> {
  if (v === null || v === undefined) return { ok: true, value: {} };
  if (!isObj(v)) return bad("flags must be an object of strings");
  const entries = Object.entries(v);
  if (entries.length > MAX_FLAGS) return bad(`at most ${MAX_FLAGS} flags`);
  const out: Record<string, string> = Object.create(null);
  for (const [k, x] of entries) {
    if (!FLAG_NAME.test(k) || typeof x !== "string" || x.length > 500) return bad("flags must be short names with string values");
    out[k] = x;
  }
  return { ok: true, value: out };
}

function parseReplay(v: unknown): Parsed<Replay | null> {
  if (v === null || v === undefined) return { ok: true, value: null };
  if (!isObj(v) || v.version !== 1 || !isObj(v.opts) || !finite(v.warmupS) || typeof v.endAfterResults !== "boolean" || !Number.isInteger(v.ticks) || (v.ticks as number) < 0 || !Array.isArray(v.events)) return bad("replay must be a version 1 replay log");
  if (JSON.stringify(v.opts).length > MAX_OPTS_BYTES) return bad("replay opts too large");
  const prim = (x: unknown) => x === null || typeof x === "boolean" || finite(x) || (typeof x === "string" && x.length <= 40);
  const okOpt = (x: unknown) => prim(x) || (Array.isArray(x) && x.length <= 64 && x.every((o) => isObj(o) && Object.values(o).every(prim)));
  if (!Object.values(v.opts).every(okOpt)) return bad("replay opts must be numbers, booleans, short strings or lists of flat records");
  if (v.events.length > MAX_REPLAY_EVENTS) return bad(`replay holds at most ${MAX_REPLAY_EVENTS} events`);
  const okEvent = (e: unknown) => Array.isArray(e) && e.length >= 2 && e.length <= MAX_EVENT_LEN && e.every((x) => finite(x) || (typeof x === "string" && x.length <= 40));
  if (!v.events.every(okEvent)) return bad("replay events must be short arrays of numbers and short strings");
  return { ok: true, value: { version: 1, opts: v.opts, warmupS: v.warmupS, endAfterResults: v.endAfterResults, ticks: v.ticks as number, events: v.events as Replay["events"] } };
}

function parsePrev(v: unknown): Parsed<DiagPrev | null> {
  if (v === null || v === undefined) return { ok: true, value: null };
  if (!isObj(v)) return bad("diag prev must be an object");
  const num = (x: unknown) => (finite(x) ? x : null), flag = (x: unknown) => (typeof x === "boolean" ? x : null);
  const str = (x: unknown, re: RegExp) => (typeof x === "string" && re.test(x) ? x : null);
  return { ok: true, value: { sid: str(v.sid, SID), sha: str(v.sha, SHA), at: num(v.at), upS: num(v.upS), phase: num(v.phase), x: num(v.x), z: num(v.z), poi: str(v.poi, POI), heapMB: num(v.heapMB), textures: num(v.textures), geometries: num(v.geometries), fps: num(v.fps), hidden: flag(v.hidden), clean: flag(v.clean) } };
}

function parseDiag(v: unknown): Parsed<Diag | null> {
  if (v === null || v === undefined) return { ok: true, value: null };
  if (!isObj(v) || v.v !== 1 || typeof v.sid !== "string" || !SID.test(v.sid) || !Array.isArray(v.events) || !isObj(v.path)) return bad("diag must be a version 1 diagnostics snapshot");
  if (!optStr(v.longFrames ?? null, WORD)) return bad("diag longFrames must be a short name");
  if (v.events.length > MAX_DIAG_EVENTS) return bad(`diag holds at most ${MAX_DIAG_EVENTS} events`);
  const okEvent = (e: unknown) => Array.isArray(e) && e.length === 4 && finite(e[0]) && typeof e[1] === "string" && WORD.test(e[1]) && finite(e[2]) && typeof e[3] === "string" && e[3].length <= MAX_EVENT_TEXT;
  if (!v.events.every(okEvent)) return bad("diag events must be [seconds, kind, number, short text]");
  const p = v.path;
  if (!Array.isArray(p.fields) || p.fields.length === 0 || p.fields.length > MAX_PATH_FIELDS || !p.fields.every((f) => typeof f === "string" && FIELD.test(f)) || !Array.isArray(p.rows)) return bad("diag path must be { fields, rows }");
  if (p.rows.length > MAX_PATH_ROWS) return bad(`diag path holds at most ${MAX_PATH_ROWS} rows`);
  const width = p.fields.length;
  if (!p.rows.every((r) => Array.isArray(r) && r.length === width && r.every(finite))) return bad("diag path rows must be finite numbers, one per field");
  const prev = parsePrev(v.prev); if (!prev.ok) return prev;
  if (!optStr(v.install ?? null, INSTALL)) return bad("diag install must be a short id");
  if (typeof v.kind !== "string" || !KINDS.has(v.kind)) return bad("diag kind must be crash, report or diagnostics");
  if (!optStr(v.chip ?? null, CHIP)) return bad("diag chip must be a short label");
  const dropped = v.dropped ?? [];
  if (!Array.isArray(dropped) || dropped.length > MAX_DROPPED || !dropped.every((d) => typeof d === "string" && WORD.test(d))) return bad("diag dropped must be a few short names");
  return { ok: true, value: {
    v: 1, sid: v.sid, longFrames: (v.longFrames as string | null | undefined) ?? null,
    events: (v.events as DiagEvent[]).map((e) => [e[0], e[1], e[2], e[3]]), path: { fields: (p.fields as string[]).slice(), rows: p.rows.map((r) => (r as number[]).slice()) },
    prev: prev.value, install: (v.install as string | null | undefined) ?? null, kind: v.kind, chip: (v.chip as string | null | undefined) ?? null, dropped: (dropped as string[]).slice(),
  } };
}

export function parseBundle(v: unknown): Parsed<Bundle> {
  if (!isObj(v)) return bad("bundle must be an object");
  if (JSON.stringify(v).length > BUNDLE_MAX_BYTES) return bad("bundle too large");
  if (v.mark !== undefined && typeof v.mark !== "boolean") return bad("bundle mark must be a boolean");
  const timeline = parseTimeline(v.timeline); if (!timeline.ok) return timeline;
  const flags = parseFlags(v.flags); if (!flags.ok) return flags;
  const replay = parseReplay(v.replay); if (!replay.ok) return replay;
  const diag = parseDiag(v.diag); if (!diag.ok) return diag;
  return { ok: true, value: { mark: v.mark === true, timeline: timeline.value, flags: flags.value, replay: replay.value, diag: diag.value } };
}

export function bundleDir(root: string, setting: string | undefined): string | null {
  if (!setting || setting === "0") return null;
  return path.resolve(setting === "1" ? path.join(root, "playtest-bundles") : setting);
}

export interface BundleFile { at: Date; id: string; json: unknown; shot: Buffer | null; shotMime: string | null }

/** the bundle folder's default caps: KR_PLAYTEST_BUNDLES_MAX bundles and KR_PLAYTEST_BUNDLES_MB megabytes override them */
export const BUNDLE_CAP_COUNT = 500, BUNDLE_CAP_MB = 1024;

/** the caps from the two settings; a value that isn't a whole number above zero keeps the default and says so */
export function bundleLimits(env: { KR_PLAYTEST_BUNDLES_MAX?: string; KR_PLAYTEST_BUNDLES_MB?: string }, log: (...a: unknown[]) => void): { count: number; bytes: number } {
  const read = (name: "KR_PLAYTEST_BUNDLES_MAX" | "KR_PLAYTEST_BUNDLES_MB", fallback: number) => {
    const v = env[name];
    if (v === undefined || v === "") return fallback;
    const n = Number(v);
    if (Number.isSafeInteger(n) && n > 0) return n;
    log(`${name}=${JSON.stringify(v.slice(0, 40))} is not a whole number above zero; using ${fallback}`);
    return fallback;
  };
  return { count: read("KR_PLAYTEST_BUNDLES_MAX", BUNDLE_CAP_COUNT), bytes: read("KR_PLAYTEST_BUNDLES_MB", BUNDLE_CAP_MB) * 1024 * 1024 };
}

/** a bundle folder untouched this long is final, so its size is counted once */
const SETTLED_MS = 60_000;

export function bundleWriter(dir: string, log: (...a: unknown[]) => void, limits = { count: BUNDLE_CAP_COUNT, bytes: BUNDLE_CAP_MB * 1024 * 1024 }) {
  let full = false;
  // The folder is listed before every write, so servers sharing it share the cap and clearing it resumes writing.
  // A bundle is never rewritten, so its bytes are kept once its folder has settled (untouched for SETTLED_MS) and a
  // write costs one listing instead of a stat per file, which took 70 ms at 5000 bundles. A newer folder, such as one
  // another server is still filling, is counted afresh each time. The folder is counted in full once, at start.
  const sizes = new Map<string, number>();

  function usage(): { count: number; bytes: number } {
    let names: string[];
    try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); }
    catch { sizes.clear(); return { count: 0, bytes: 0 }; }
    const listed = new Set(names);
    for (const name of sizes.keys()) if (!listed.has(name)) sizes.delete(name);
    let bytes = 0;
    for (const name of names) {
      const known = sizes.get(name);
      if (known !== undefined) { bytes += known; continue; }
      let size = 0, settled = false;
      try {
        const folder = path.join(dir, name);
        for (const f of fs.readdirSync(folder)) size += fs.statSync(path.join(folder, f)).size;
        settled = Date.now() - fs.statSync(folder).mtimeMs > SETTLED_MS;
      } catch { /* removed while being counted */ }
      if (settled) sizes.set(name, size);
      bytes += size;
    }
    return { count: names.length, bytes };
  }

  function write(b: BundleFile): string | null {
    const body = Buffer.from(JSON.stringify(b.json));
    const size = body.length + (b.shot?.length ?? 0);
    const { count, bytes } = usage();
    if (count >= limits.count || bytes + size > limits.bytes) {
      if (!full) { full = true; log(`playtest bundles: ${dir} is full (${count} bundles, ${Math.round(bytes / 1048576)} MB); not writing more until it is cleared`); }
      return null;
    }
    full = false;
    const name = `${b.at.toISOString().replace(/[:.]/g, "-")}-${b.id.replace(/[^A-Za-z0-9-]/g, "").slice(0, 24) || "report"}`;
    const folder = path.resolve(dir, name);
    if (path.dirname(folder) !== path.resolve(dir)) return null;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(folder, { mode: 0o700 });
    try {
      fs.writeFileSync(path.join(folder, "bundle.json"), body, { mode: 0o600 });
      if (b.shot) fs.writeFileSync(path.join(folder, b.shotMime === "image/png" ? "shot.png" : b.shotMime === "image/webp" ? "shot.webp" : "shot.jpg"), b.shot, { mode: 0o600 });
    } catch (e) { fs.rmSync(folder, { recursive: true, force: true }); throw e; }
    sizes.set(name, size);
    return folder;
  }
  usage();
  return { dir, limits, write };
}
