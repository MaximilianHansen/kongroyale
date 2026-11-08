// Automatic performance summaries: POST /api/diag/auto. A player who opts in to "send anonymous
// performance stats automatically" sends one small row per event (a long frame, a low-fps stretch, a lost WebGL
// context, a repeated error, a session that died) and one per finished match, by navigator.sendBeacon. Rows carry no
// picture, replay, logs, callsign or note: only a random install id, a config key and up to 16 numbers.
//
// The endpoint has its own limits, separate from /api/kongbot's, so automatic traffic never crowds out a player's own
// report: a 4 KB body, per-address, per-install and server-wide rates, and dedupe of a row sent twice.
// Accepted rows are appended to <folder>/<UTC date>.jsonl (KR_DIAG_AUTO, off unless set; `npm run server` defaults it
// on, under .kongbot/ which the dev server never serves), and the folder stops growing at KR_DIAG_AUTO_MB. Counters are in /health as diagAuto.
import type http from "node:http";
import fs from "node:fs";
import path from "node:path";

/** a row's body; sendBeacon can't retry or read the answer, so a client keeps its rows well under it */
export const AUTO_MAX_BODY_BYTES = 4096;
export const AUTO_KINDS = ["hitch", "lowfps", "ctxlost", "error", "crash", "match"] as const;
export type AutoKind = (typeof AUTO_KINDS)[number];
const MAX_STATS = 16, MAX_ABS = 1e9, MAX_T_S = 1e6;
const ID = /^[A-Za-z0-9-]{8,64}$/, CONFIG = /^[A-Za-z0-9:._-]{1,80}$/, BUILD = /^[A-Za-z0-9._-]{1,40}$/;
const SIG = /^[A-Za-z0-9_.:-]{1,40}$/, FIELD = /^[a-zA-Z][a-zA-Z0-9_]{0,23}$/;
/** rows per address in RATE_WINDOW_MS, per install per hour, and for the whole server per hour */
const PER_ADDRESS = 60, RATE_WINDOW_MS = 10 * 60_000, HOUR_MS = 3_600_000, PER_INSTALL_HOUR = 30, SERVER_HOUR = 6000;
/** a row seen again inside this window (same install, session, kind, page time and signature) is answered, not stored */
const DEDUPE_MS = 10 * 60_000, MAX_DEDUPE_KEYS = 50_000;
/** the folder's default cap; KR_DIAG_AUTO_MB overrides it */
export const AUTO_CAP_MB = 256;

export interface AutoRow {
  v: 1; install: string; session: string; kind: AutoKind; t: number; config: string; build: string;
  sig: string | null; stats: Record<string, number>;
}

/** a rebuilt copy of the row with only the known fields, or why it was refused */
export function parseAuto(v: unknown): { ok: true; value: AutoRow } | { ok: false; error: string } {
  const bad = (error: string) => ({ ok: false as const, error });
  if (!v || typeof v !== "object" || Array.isArray(v)) return bad("row must be an object");
  const r = v as Record<string, unknown>;
  if (r.v !== 1) return bad("unknown version");
  if (typeof r.install !== "string" || !ID.test(r.install)) return bad("install must be a random id");
  if (typeof r.session !== "string" || !ID.test(r.session)) return bad("session must be a random id");
  if (!AUTO_KINDS.includes(r.kind as AutoKind)) return bad("unknown kind");
  if (typeof r.t !== "number" || !Number.isFinite(r.t) || r.t < 0 || r.t > MAX_T_S) return bad("t must be page seconds");
  if (typeof r.config !== "string" || !CONFIG.test(r.config)) return bad("config must be a short key");
  if (typeof r.build !== "string" || !BUILD.test(r.build)) return bad("build must be a short id");
  if (r.sig !== undefined && r.sig !== null && (typeof r.sig !== "string" || !SIG.test(r.sig))) return bad("sig must be a short word");
  if (!r.stats || typeof r.stats !== "object" || Array.isArray(r.stats)) return bad("stats must be an object");
  const entries = Object.entries(r.stats as Record<string, unknown>);
  if (entries.length > MAX_STATS) return bad(`at most ${MAX_STATS} stats`);
  const stats: Record<string, number> = {};
  for (const [k, x] of entries) {
    if (!FIELD.test(k) || typeof x !== "number" || !Number.isFinite(x) || Math.abs(x) > MAX_ABS) return bad("stats must be plain names with finite numbers");
    stats[k] = x;
  }
  return { ok: true, value: { v: 1, install: r.install, session: r.session, kind: r.kind as AutoKind, t: r.t, config: r.config, build: r.build, sig: typeof r.sig === "string" ? r.sig : null, stats } };
}

/** the folder rows go to, from KR_DIAG_AUTO: unset or 0 is off, 1 is <root>/.kongbot/diag-auto, anything else is a path */
export function autoDir(root: string, setting: string | undefined): string | null {
  if (!setting || setting === "0") return null;
  return path.resolve(setting === "1" ? path.join(root, ".kongbot", "diag-auto") : setting);
}

/** the cap from KR_DIAG_AUTO_MB; a value that isn't a whole number above zero keeps the default and says so */
export function autoCapBytes(setting: string | undefined, log: (...a: unknown[]) => void): number {
  if (setting === undefined || setting === "") return AUTO_CAP_MB * 1024 * 1024;
  const n = Number(setting);
  if (Number.isSafeInteger(n) && n > 0) return n * 1024 * 1024;
  log(`KR_DIAG_AUTO_MB=${JSON.stringify(setting.slice(0, 40))} is not a whole number above zero; using ${AUTO_CAP_MB}`);
  return AUTO_CAP_MB * 1024 * 1024;
}

export function diagAutoApi(dir: string | null, log: (...a: unknown[]) => void, capBytes = AUTO_CAP_MB * 1024 * 1024) {
  const byAddress = new Map<string, number[]>(), byInstall = new Map<string, number[]>(), seen = new Map<string, number>();
  const hour: number[] = [];
  const counts = { accepted: 0, deduped: 0, limited: 0, refused: 0, full: 0 };
  let full = false;

  function reply(res: http.ServerResponse, code: number, error?: string) {
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(error ? JSON.stringify({ ok: false, error }) : undefined);
  }

  /** the folder's size, listed on every write so servers sharing it share the cap and clearing it resumes writing */
  function used(folder: string): number {
    let bytes = 0;
    try { for (const f of fs.readdirSync(folder)) if (f.endsWith(".jsonl")) bytes += fs.statSync(path.join(folder, f)).size; } catch { /* no folder yet */ }
    return bytes;
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse, ip: string) {
    if (!dir) { reply(res, 404, "automatic summaries are off on this server"); req.resume(); return; }
    if (req.method !== "POST") { reply(res, 405, "POST only"); req.resume(); return; }
    const now = Date.now();
    while (hour.length && now - hour[0] >= HOUR_MS) hour.shift();
    const addressHits = (byAddress.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    byAddress.set(ip, addressHits);
    if (hour.length >= SERVER_HOUR || addressHits.length >= PER_ADDRESS) { counts.limited++; reply(res, 429, "too many rows"); req.resume(); return; }
    addressHits.push(now);
    const chunks: Buffer[] = []; let size = 0;
    try {
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > AUTO_MAX_BODY_BYTES) { counts.refused++; reply(res, 413, "row too large"); req.destroy(); return; }
        chunks.push(c as Buffer);
      }
    } catch { counts.refused++; reply(res, 400, "bad body"); return; }
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { counts.refused++; reply(res, 400, "bad json"); return; }
    const parsed = parseAuto(body);
    if (!parsed.ok) { counts.refused++; reply(res, 400, parsed.error); return; }
    const row = parsed.value;
    const key = `${row.install}|${row.session}|${row.kind}|${row.t}|${row.sig ?? ""}`;
    const last = seen.get(key);
    if (last !== undefined && now - last < DEDUPE_MS) { counts.deduped++; reply(res, 204); return; }
    // the server-wide cap is checked again now the body has arrived (other rows may have been stored meanwhile), and an
    // install's quota is charged only for a row that is stored; nothing below awaits
    const installHits = (byInstall.get(row.install) ?? []).filter((t) => now - t < HOUR_MS);
    byInstall.set(row.install, installHits);
    if (hour.length >= SERVER_HOUR || installHits.length >= PER_INSTALL_HOUR) { counts.limited++; reply(res, 429, "too many rows"); return; }
    const at = new Date(now), line = JSON.stringify({ at: at.toISOString(), ...row }) + "\n";
    if (used(dir) + Buffer.byteLength(line) > capBytes) {
      counts.full++;
      if (!full) { full = true; log(`automatic summaries: ${dir} is full (${Math.round(capBytes / 1048576)} MB); not writing more until it is cleared`); }
      reply(res, 503, "summaries are full"); return;
    }
    full = false;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.appendFileSync(path.join(dir, at.toISOString().slice(0, 10) + ".jsonl"), line, { mode: 0o600 });
    } catch (e) { log("automatic summary not written:", e instanceof Error ? e.message : e); reply(res, 500, "could not store the row"); return; }
    if (seen.size >= MAX_DEDUPE_KEYS) seen.delete(seen.keys().next().value!);
    seen.set(key, now); hour.push(now); installHits.push(now); counts.accepted++;
    reply(res, 204);
  }

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of byAddress) if (!v.some((t) => now - t < RATE_WINDOW_MS)) byAddress.delete(k);
    for (const [k, v] of byInstall) if (!v.some((t) => now - t < HOUR_MS)) byInstall.delete(k);
    for (const [k, t] of seen) if (now - t >= DEDUPE_MS) seen.delete(k);
  }, RATE_WINDOW_MS);
  sweep.unref();

  return { dir, handle, health: () => ({ on: !!dir, ...counts }), close: () => clearInterval(sweep) };
}
