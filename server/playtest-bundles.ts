import fs from "node:fs";
import path from "node:path";

export const BUNDLE_MAX_BYTES = 8 * 1024 * 1024;
const MAX_FIELDS = 32, MAX_ROWS = 7200, MAX_FLAGS = 200, MAX_REPLAY_EVENTS = 200_000, MAX_EVENT_LEN = 16, MAX_OPTS_BYTES = 4096;
const FIELD = /^[A-Za-z][A-Za-z0-9]{0,31}$/, FLAG_NAME = /^[A-Za-z0-9_-]{1,40}$/;

export interface Timeline { fields: string[]; rows: number[][]; dropped: number }
export interface Replay { version: 1; opts: Record<string, unknown>; warmupS: number; endAfterResults: boolean; ticks: number; events: Array<Array<number | string>> }
export interface Bundle { mark: boolean; timeline: Timeline | null; flags: Record<string, string>; replay: Replay | null }

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
const bad = (error: string): { ok: false; error: string } => ({ ok: false, error });
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

export function parseBundle(v: unknown): Parsed<Bundle> {
  if (!isObj(v)) return bad("bundle must be an object");
  if (JSON.stringify(v).length > BUNDLE_MAX_BYTES) return bad("bundle too large");
  if (v.mark !== undefined && typeof v.mark !== "boolean") return bad("bundle mark must be a boolean");
  const timeline = parseTimeline(v.timeline); if (!timeline.ok) return timeline;
  const flags = parseFlags(v.flags); if (!flags.ok) return flags;
  const replay = parseReplay(v.replay); if (!replay.ok) return replay;
  return { ok: true, value: { mark: v.mark === true, timeline: timeline.value, flags: flags.value, replay: replay.value } };
}

export function bundleDir(root: string, setting: string | undefined): string | null {
  if (!setting || setting === "0") return null;
  return path.resolve(setting === "1" ? path.join(root, "playtest-bundles") : setting);
}

export interface BundleFile { at: Date; id: string; json: unknown; shot: Buffer | null; shotMime: string | null }

function usage(dir: string): { count: number; bytes: number } {
  let count = 0, bytes = 0;
  try {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      count++;
      for (const f of fs.readdirSync(path.join(dir, d.name))) bytes += fs.statSync(path.join(dir, d.name, f)).size;
    }
  } catch { return { count: 0, bytes: 0 }; }
  return { count, bytes };
}

export function bundleWriter(dir: string, log: (...a: unknown[]) => void, limits = { count: 500, bytes: 1024 * 1024 * 1024 }) {
  let full = false;

  function write(b: BundleFile): string | null {
    const body = Buffer.from(JSON.stringify(b.json));
    const size = body.length + (b.shot?.length ?? 0);
    const { count, bytes } = usage(dir);
    if (count >= limits.count || bytes + size > limits.bytes) {
      if (!full) { full = true; log(`playtest bundles: ${dir} is full (${count} bundles, ${Math.round(bytes / 1048576)} MB); not writing more until it is cleared`); }
      return null;
    }
    full = false;
    const name = `${b.at.toISOString().replace(/[:.]/g, "-")}-${b.id.replace(/[^A-Za-z0-9-]/g, "").slice(0, 24) || "report"}`;
    const folder = path.resolve(dir, name);
    if (path.dirname(folder) !== path.resolve(dir)) return null;
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(folder, "bundle.json"), body, { mode: 0o600 });
    if (b.shot) fs.writeFileSync(path.join(folder, b.shotMime === "image/png" ? "shot.png" : b.shotMime === "image/webp" ? "shot.webp" : "shot.jpg"), b.shot, { mode: 0o600 });
    return folder;
  }
  return { dir, write };
}
