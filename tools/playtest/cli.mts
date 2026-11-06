import fs from "node:fs";
import path from "node:path";

const USAGE = `usage: npx tsx tools/playtest/cli.mts list [--dir DIR] [--n N]
       npx tsx tools/playtest/cli.mts show <folder|latest> [--dir DIR] [--json]`;
const argv = process.argv.slice(2);
const opt = (n: string) => { const i = argv.indexOf(n); return i < 0 ? undefined : argv[i + 1]; };
const root = path.resolve(import.meta.dirname, "../..");
const setting = process.env.KR_PLAYTEST_BUNDLES;
const dir = path.resolve(opt("--dir") ?? (setting && setting !== "0" && setting !== "1" ? setting : path.join(root, "playtest-bundles")));
const [cmd, which] = argv.filter((a, i) => !a.startsWith("--") && !["--dir", "--n"].includes(argv[i - 1] ?? ""));

interface Saved {
  id: string; message: string; receivedAt: string; reporter?: { name?: string | null }; server?: { sha: string; branch: string } | null;
  ctx?: { game?: { match?: { mode?: string; phase?: string; time?: number } | null } } | null;
  logs?: Array<{ t: number; level: string; text: string; n: number }>;
  bundle: { mark: boolean; timeline: { fields: string[]; rows: number[][]; dropped: number } | null; flags: Record<string, string>; replay: { ticks: number; events: unknown[]; opts: { seed?: number; mode?: string } } | null };
}

const folders = () => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => fs.existsSync(path.join(dir, f, "bundle.json"))).sort() : []);
const load = (f: string): Saved => JSON.parse(fs.readFileSync(path.join(dir, f, "bundle.json"), "utf8"));
const q = (s: number[], p: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN);
const sorted = (a: number[]) => [...a].sort((x, y) => x - y);
const r1 = (v: number) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
const PHASES = ["warmup", "plane", "play", "results"];

function analyse(s: Saved) {
  const tl = s.bundle.timeline;
  const col = (name: string) => { const i = tl?.fields.indexOf(name) ?? -1; return i < 0 || !tl ? [] : tl.rows.map((r) => r[i]); };
  const t = col("t"), fps = col("fps"), p95 = col("p95Ms"), max = col("maxMs"), over50 = col("over50"), over100 = col("over100");
  const ping = col("pingMs"), jitter = col("jitterMs"), heap = col("heapMB"), tex = col("textures"), geo = col("geometries"), prog = col("programs"), phase = col("phase"), gpu = col("gpuMs");
  const live = fps.map((v, i) => i).filter((i) => fps[i] > 0);
  const fpsLive = sorted(live.map((i) => fps[i])), p95Live = sorted(live.map((i) => p95[i]));
  const where = (i: number) => (phase[i] >= 0 ? PHASES[phase[i]] ?? `phase ${phase[i]}` : "title");
  const stalls = live.filter((i) => over50[i] > 0).sort((a, b) => max[b] - max[a]).slice(0, 8).map((i) => ({ t: r1(t[i]), maxMs: r1(max[i]), over50: over50[i], over100: over100[i], fps: r1(fps[i]), where: where(i) }));
  const pings = live.filter((i) => ping[i] >= 0), pingSorted = sorted(pings.map((i) => ping[i])), pingMed = q(pingSorted, 0.5);
  const lag = pings.filter((i) => ping[i] > pingMed * 2 + 40 || jitter[i] > 15).map((i) => ({ t: r1(t[i]), pingMs: r1(ping[i]), jitterMs: r1(jitter[i]), where: where(i) }));
  const heapPts = live.filter((i) => heap[i] >= 0);
  let slope = NaN;
  if (heapPts.length > 10) {
    const xs = heapPts.map((i) => t[i] / 60), ys = heapPts.map((i) => heap[i]);
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
    const num = xs.reduce((a, x, k) => a + (x - mx) * (ys[k] - my), 0), den = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
    slope = den > 0 ? num / den : NaN;
  }
  const first = (a: number[]) => (a.length ? a[0] : NaN), last = (a: number[]) => (a.length ? a[a.length - 1] : NaN);
  const errors = (s.logs ?? []).filter((l) => l.level === "error").slice(-8).map((l) => `${(l.t / 1000).toFixed(1)}s ${l.text.slice(0, 200)}${l.n > 1 ? ` (x${l.n})` : ""}`);
  return {
    id: s.id, message: s.message, at: s.receivedAt, reporter: s.reporter?.name ?? null, mark: s.bundle.mark,
    build: s.server ?? null, flags: s.bundle.flags,
    seconds: tl?.rows.length ?? 0, droppedSeconds: tl?.dropped ?? 0,
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

function markdown(a: ReturnType<typeof analyse>, folder: string) {
  const L = [`# ${a.id} · ${a.at.replace("T", " ").slice(0, 19)} UTC${a.mark ? " · F8 mark" : ""}`, "", `> ${a.message}`, ""];
  L.push(`- **Folder:** ${path.join(dir, folder)}`);
  L.push(`- **Build:** ${a.build ? `server ${a.build.branch} · ${a.build.sha}` : "unknown"} · flags ${Object.keys(a.flags).map((k) => (a.flags[k] ? `${k}=${a.flags[k]}` : k)).join("&") || "none"}`);
  L.push(`- **Timeline:** ${a.seconds} s${a.droppedSeconds ? ` (oldest ${a.droppedSeconds} s dropped)` : ""}`);
  L.push(`- **Frame rate:** median ${a.fps.median} fps, 5th percentile ${a.fps.p5}, worst second ${a.fps.min} · frame p95 median ${a.frameP95Ms.median} ms, worst ${a.frameP95Ms.worst} ms · GPU median ${a.gpuMs.median ?? "–"} ms`);
  L.push(`- **Stalls:** ${a.stalls.secondsWithStall} seconds held a frame over 50 ms (${a.stalls.framesOver50ms} frames over 50 ms, ${a.stalls.framesOver100ms} over 100 ms)`);
  for (const s of a.stalls.worst) L.push(`  - t=${s.t}s ${s.where}: worst frame ${s.maxMs} ms, ${s.over50} over 50 ms, ${s.fps} fps`);
  L.push(`- **Network:** ping median ${a.network.pingMedianMs ?? "–"} ms, p95 ${a.network.pingP95Ms ?? "–"} ms · ${a.network.lagSpikeSeconds} lag-spike seconds`);
  for (const s of a.network.lagSpikes) L.push(`  - t=${s.t}s ${s.where}: ping ${s.pingMs} ms, jitter ${s.jitterMs} ms`);
  L.push(`- **Memory:** heap ${a.memory.heapStartMB} → ${a.memory.heapEndMB} MB (max ${a.memory.heapMaxMB}, trend ${a.memory.heapSlopeMBPerMin ?? "–"} MB/min) · textures ${a.memory.textures.join(" → ")} · geometries ${a.memory.geometries.join(" → ")} · programs ${a.memory.programs.join(" → ")}`);
  L.push(`- **Replay:** ${a.replay ? `${a.replay.events} input events over ${a.replay.ticks} ticks (seed ${a.replay.seed}, ${a.replay.mode})` : "none (online match or no match)"}`);
  if (a.errors.length) L.push("- **Errors:**", ...a.errors.map((e) => `  - ${e}`));
  return L.join("\n");
}

if (cmd === "list") {
  const all = folders(), n = Number(opt("--n") ?? 20);
  if (!all.length) { console.log(`no bundles in ${dir}`); process.exit(0); }
  for (const f of all.slice(-n).reverse()) {
    const a = analyse(load(f));
    console.log(`${f}  ${a.build?.branch ?? "?"}@${a.build?.sha ?? "?"}  ${a.seconds}s  fps ${a.fps.median}  stalls ${a.stalls.secondsWithStall}  lag ${a.network.lagSpikeSeconds}  ${a.mark ? "[F8] " : ""}${a.message.slice(0, 70)}`);
  }
} else if (cmd === "show") {
  const all = folders();
  const f = which === "latest" || !which ? all[all.length - 1] : all.find((x) => x === which || x.endsWith(which));
  if (!f) { console.error(`no bundle ${which ?? "latest"} in ${dir}`); process.exit(1); }
  const a = analyse(load(f));
  console.log(argv.includes("--json") ? JSON.stringify(a, null, 2) : markdown(a, f));
} else { console.error(USAGE); process.exit(1); }
