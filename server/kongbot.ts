// KONGBOT server side: POST /api/kongbot (client/src/kongbot) → MongoDB, collection kongbot_reports.
//   KR_MONGO_URI (default mongodb://127.0.0.1:27017, `npm run kongbot:db` starts one), KR_MONGO_DB (default kong_royale)
// A report is never lost to a database hiccup: while Mongo is unreachable it is written to .kongbot/spool/ and imported
// on the next successful connection. Reports are private: there is no read endpoint — triage reads Mongo directly
// (npm run kongbot, tools/kongbot/cli.mts). Each report gets a short id (KB-<n>) the player sees in the toast.
import type http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { MongoClient, Binary, type Collection, type Document } from "mongodb";
import { bundleDir, bundleWriter, parseBundle, type Bundle } from "./playtest-bundles";

const URI = process.env.KR_MONGO_URI || "mongodb://127.0.0.1:27017";
const DB = process.env.KR_MONGO_DB || "kong_royale";
const MAX_BODY = 12 * 1024 * 1024, MAX_SHOT = 6 * 1024 * 1024;
const RATE_N = 20, RATE_WINDOW_MS = 10 * 60_000;
// whole-server brakes (per-address limits alone do not stop many addresses): uploads in flight (each up to MAX_BODY in
// memory), reports per hour, and files waiting in the spool while Mongo is down
const MAX_INFLIGHT = 4, MAX_PER_HOUR = 300, MAX_SPOOL_FILES = 500;

export interface KongbotDoc extends Document {
  receipt?: string;
  num: number; id: string; status: string; message: string; createdAt: Date; receivedAt: Date;
  reporter: { name: string | null; clientId: string | null; sessionId: string | null; ipHash: string };
  build: GitInfo | null; ctx: unknown; logs: unknown[]; trail: unknown[]; bundle?: Omit<Bundle, "replay"> | null;
  shot: Binary | null; shotMime: string | null; shotSize: number[] | null;
  notes: Array<{ at: Date; by: string; text: string }>; history: Array<{ at: Date; by: string; status: string; note?: string }>;
}

interface GitInfo { sha: string; branch: string; dirtyFiles: number; subject: string }
export function kongbotDb(root: string) {
  const spool = path.join(root, ".kongbot", "spool");
  const salt = crypto.randomBytes(16).toString("hex");
  const hits = new Map<string, number[]>();
  let client: MongoClient | null = null, reports: Collection<KongbotDoc> | null = null, counters: Collection<{ _id: string; seq: number }> | null = null;
  let connecting: Promise<boolean> | null = null, lastFail = 0, stopped = false;
  let storageState: "connecting" | "database" | "server-queue" | "unavailable" = "connecting";
  let changedAt = new Date().toISOString();
  const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), "[kongbot]", ...a);
  const bundleRoot = bundleDir(root, process.env.KR_PLAYTEST_BUNDLES);
  const bundles = bundleRoot ? bundleWriter(bundleRoot, log) : null;
  if (bundles) log(`playtest bundles are written to ${bundles.dir}`);
  function state(next: typeof storageState) {
    if (next === storageState) return;
    storageState = next; changedAt = new Date().toISOString();
    log(next === "database" ? "database ready" : next === "server-queue" ? "database unavailable; reports are saved in the server queue" : "report storage unavailable");
  }
  function health() {
    let queued = 0, queueWritable = false;
    try { fs.mkdirSync(spool, { recursive: true, mode: 0o700 }); fs.accessSync(spool, fs.constants.W_OK); queueWritable = true; queued = fs.readdirSync(spool).filter(f => f.endsWith(".json")).length; } catch { /* reported as degraded */ }
    return { state: storageState, database: !!reports, queueWritable, queued, changedAt };
  }

  let git: { at: number; v: GitInfo | null } = { at: 0, v: null };
  function gitInfo(): GitInfo | null {
    if (Date.now() - git.at < 30_000) return git.v;
    let v: GitInfo | null = null;
    try {
      const run = (...a: string[]) => execFileSync("git", a, { cwd: root, encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim();
      v = { sha: run("rev-parse", "HEAD"), branch: run("rev-parse", "--abbrev-ref", "HEAD"), subject: run("log", "-1", "--format=%s").slice(0, 160), dirtyFiles: run("status", "--porcelain").split("\n").filter(Boolean).length };
    } catch { /* no git (a deployed dist) */ }
    git = { at: Date.now(), v };
    return v;
  }

  async function connect(): Promise<boolean> {
    if (stopped) return false;
    if (reports) return true;
    if (Date.now() - lastFail < 15_000) return false;
    connecting ??= (async () => {
      const c = new MongoClient(URI, { serverSelectionTimeoutMS: 2500 });
      try {
        await c.connect();
        const db = c.db(DB);
        const collection = db.collection<KongbotDoc>("kongbot_reports");
        await collection.createIndex({ num: 1 }, { unique: true });
        await collection.createIndex({ receipt: 1 }, { unique: true, sparse: true });
        await collection.createIndex({ status: 1, createdAt: -1 });
        if (stopped) { await c.close(); return false; }
        await client?.close();
        reports = collection; counters = db.collection("kongbot_counters");
        client = c;
        c.on("close", () => { /* the driver reconnects by itself */ });
        state("database");
        void flushSpool();
        return true;
      } catch (e) {
        lastFail = Date.now(); reports = null;
        await c.close().catch(() => {});
        state(health().queueWritable ? "server-queue" : "unavailable");
        return false;
      } finally { connecting = null; }
    })();
    return connecting;
  }

  async function nextNum() {
    const r = await counters!.findOneAndUpdate({ _id: "report" }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: "after" });
    return r!.seq;
  }

  async function store(doc: Omit<KongbotDoc, "num" | "id">, receipt: string): Promise<string> {
    const num = await nextNum();
    const id = `KB-${num}`;
    // A database acknowledgement can be lost after the write. Re-importing the durable queue must not duplicate it.
    const saved = await reports!.findOneAndUpdate({ receipt }, { $setOnInsert: { ...doc, receipt, num, id } as KongbotDoc }, { upsert: true, returnDocument: "after" });
    return saved!.id;
  }

  let flushing: Promise<void> | null = null;
  function flushSpool() {
    if (!flushing) flushing = importSpool().finally(() => { flushing = null; });
    return flushing;
  }
  async function importSpool() {
    let files: string[] = [];
    try { files = fs.readdirSync(spool).filter((f) => f.endsWith(".json")).sort(); } catch { return; }
    for (const f of files) {
      // an unreadable file (cut short by a crash before writes were atomic) is set aside, never retried forever
      let j: Record<string, any>;
      try { j = JSON.parse(fs.readFileSync(path.join(spool, f), "utf8")); }
      catch (e) { try { fs.renameSync(path.join(spool, f), path.join(spool, f + ".bad")); } catch { /* left for a human */ } log(`unreadable spooled report ${f} set aside (.bad):`, e instanceof Error ? e.message : e); continue; }
      try {
        const doc = { ...j, createdAt: new Date(j.createdAt), receivedAt: new Date(j.receivedAt), shot: j.shot ? new Binary(Buffer.from(j.shot, "base64")) : null, history: (j.history ?? []).map((h: { at: string }) => ({ ...h, at: new Date(h.at) })) };
        const receipt = String(j.receipt || crypto.createHash("sha256").update(f).digest("hex"));
        const id = await store(doc, receipt);
        fs.unlinkSync(path.join(spool, f));
        log(`imported spooled report ${f} → ${id}`);
      } catch { reports = null; lastFail = Date.now(); state("server-queue"); return; }
    }
  }

  /** Mongo field names may not start with "$" (and dots are trouble in queries): the ctx comes from browsers */
  function clean(v: unknown, depth = 0): unknown {
    if (depth > 12 || v === null || typeof v !== "object") return typeof v === "string" && v.length > 20_000 ? v.slice(0, 20_000) : v;
    if (Array.isArray(v)) return v.slice(0, 5000).map((x) => clean(x, depth + 1));
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k.replace(/^\$/, "_").replace(/\./g, "_")] = clean(x, depth + 1);
    return o;
  }

  function reply(res: http.ServerResponse, code: number, body: unknown) {
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse, ip: string) {
    if (req.method !== "POST") { reply(res, 405, { ok: false, error: "POST only" }); return; }
    const hourAgo = Date.now() - 3_600_000; while (recent.length && recent[0] < hourAgo) recent.shift();
    if (inflight >= MAX_INFLIGHT || recent.length >= MAX_PER_HOUR) { reply(res, 503, { ok: false, error: "the report desk is busy, try again in a minute" }); req.resume(); return; }
    inflight++;
    try { await handleOne(req, res, ip); } finally { inflight--; }
  }
  let inflight = 0; const recent: number[] = [];
  async function handleOne(req: http.IncomingMessage, res: http.ServerResponse, ip: string) {
    const now = Date.now(), h = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    if (h.length >= RATE_N) { reply(res, 429, { ok: false, error: "too many reports, try again in a few minutes" }); return; }
    h.push(now); hits.set(ip, h); recent.push(now);

    const chunks: Buffer[] = []; let size = 0, over = false;
    try {
      for await (const c of req) { size += (c as Buffer).length; if (size > MAX_BODY) { over = true; break; } chunks.push(c as Buffer); }
    } catch { reply(res, 400, { ok: false, error: "bad body" }); return; }
    if (over) { reply(res, 413, { ok: false, error: "report too large" }); req.destroy(); return; }
    let b: Record<string, unknown>;
    try { b = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { reply(res, 400, { ok: false, error: "bad json" }); return; }
    if (!b || typeof b !== "object" || Array.isArray(b)) { reply(res, 400, { ok: false, error: "report must be an object" }); return; }
    const message = String(b.message ?? "").trim().slice(0, 2000);
    if (message.length < 3) { reply(res, 400, { ok: false, error: "empty message" }); return; }
    const parsed = b.bundle === undefined || b.bundle === null ? null : parseBundle(b.bundle);
    if (parsed && !parsed.ok) { reply(res, 400, { ok: false, error: `bad bundle: ${parsed.error}` }); return; }
    const bundle = parsed?.ok ? parsed.value : null;

    let shot: Buffer | null = null, shotMime: string | null = null;
    const m = typeof b.shot === "string" ? /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(b.shot) : null;
    if (m) { shot = Buffer.from(m[2], "base64"); shotMime = m[1]; if (shot.length > MAX_SHOT) { shot = null; shotMime = null; } }
    const rep = (b.reporter ?? {}) as Record<string, unknown>;
    const str = (v: unknown, n: number) => (typeof v === "string" && v ? v.slice(0, n) : null);
    const at = new Date(), sent = new Date(String(b.sentAt ?? ""));
    const receipt = crypto.randomUUID();
    const doc = {
      receipt,
      status: "new", message, createdAt: isNaN(+sent) ? at : sent, receivedAt: at,
      reporter: { name: str(rep.name, 40), clientId: str(rep.clientId, 64), sessionId: str(rep.sessionId, 64), ipHash: crypto.createHash("sha256").update(salt + ip).digest("hex").slice(0, 12) },
      build: gitInfo(), ua: str(req.headers["user-agent"], 400),
      ctx: clean(b.ctx ?? null), logs: Array.isArray(b.logs) ? (clean(b.logs.slice(-1500)) as unknown[]) : [], trail: Array.isArray(b.trail) ? (clean(b.trail.slice(-400)) as unknown[]) : [],
      shot: shot ? new Binary(shot) : null, shotMime, shotSize: Array.isArray(b.shotSize) ? (b.shotSize as number[]).slice(0, 2) : null,
      bundle: bundle ? { mark: bundle.mark, timeline: clean(bundle.timeline) as Bundle["timeline"], flags: bundle.flags } : null,
      notes: [], history: [{ at, by: "reporter", status: "new" }],
    };
    const saveBundle = (id: string) => {
      if (!bundles || !bundle) return;
      try {
        const folder = bundles.write({ at, id, shot, shotMime, json: { id, message, receivedAt: at.toISOString(), reporter: { name: doc.reporter.name }, server: doc.build, ctx: doc.ctx, logs: doc.logs, trail: doc.trail, bundle } });
        if (folder) log(`${id} bundle written to ${folder}`);
      } catch (e) { log(`${id} bundle not written:`, e instanceof Error ? e.message : e); }
    };
    const where = ((doc.ctx as { game?: { player?: { poi?: { name?: string } } } } | null)?.game?.player?.poi?.name) ?? "title";
    if (await connect()) {
      try {
        const id = await store(doc, receipt);
        log(`${id} from ${doc.reporter.name ?? "?"} @ ${where}: ${message.slice(0, 120)}`);
        saveBundle(id);
        reply(res, 200, { ok: true, id, storage: "database" });
        return;
      } catch { reports = null; lastFail = Date.now(); state("server-queue"); }
    }
    try {
      fs.mkdirSync(spool, { recursive: true, mode: 0o700 });
      if (fs.readdirSync(spool).length >= MAX_SPOOL_FILES) throw new Error(`spool full (${MAX_SPOOL_FILES} reports waiting for the database)`);
      const f = `${at.toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}.json`;
      const temporary = path.join(spool, f + ".tmp");
      const fd = fs.openSync(temporary, "wx", 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ ...doc, shot: shot ? shot.toString("base64") : null })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, path.join(spool, f));
      state("server-queue");
      log(`spooled report from ${doc.reporter.name ?? "?"} @ ${where}: ${message.slice(0, 120)}`);
      saveBundle(`LOCAL-${receipt.slice(0, 8)}`);
      reply(res, 200, { ok: true, id: `LOCAL-${receipt.slice(0, 8)}`, queued: true, storage: "server-queue" });
    } catch (e) { state("unavailable"); reply(res, 500, { ok: false, error: "could not store the report" }); log("spool failed:", e); }
  }

  const rateTimer = setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some((t) => now - t < RATE_WINDOW_MS)) hits.delete(k); }, RATE_WINDOW_MS); rateTimer.unref();
  // Mongo came back: import the spool without waiting for the next report
  async function retryPending() {
    if (stopped) return;
    if (reports && client) {
      try { await client.db(DB).command({ ping: 1 }, { timeoutMS: 3000 }); }
      catch { reports = null; lastFail = Date.now(); state(health().queueWritable ? "server-queue" : "unavailable"); }
    }
    if (await connect()) await flushSpool();
  }
  const retryTimer = setInterval(() => { void retryPending(); }, 60_000); retryTimer.unref();
  void connect();
  return { handle, health, retryPending, close: async () => { stopped = true; clearInterval(rateTimer); clearInterval(retryTimer); await connecting; await flushing; await client?.close(); } };
}
