// Playtest bundle command line. list / show read one bundle at a time (the summary from analysis.mts); watch prints one
// line per new bundle as it lands and keeps a one-line ticker file for OBS. Structured fields only: watch never prints
// the player's message or callsign. triage.mts writes the ranked cluster files.
//   npx tsx tools/playtest/cli.mts list [--dir DIR] [--n N]
//   npx tsx tools/playtest/cli.mts show <folder|latest> [--dir DIR] [--json]
//   npx tsx tools/playtest/cli.mts watch [--dir DIR] [--ticker FILE]
import fs from "node:fs";
import path from "node:path";
import { analyse, bundleFolders, loadBundle, resolveDir } from "./analysis.mts";
import { configLabel, tickerLine, triageBundle } from "./triage.mts";
import type { IndexEntry } from "./triage.mts";

const WATCH_POLL_MS = 2000;
const USAGE = `usage: npx tsx tools/playtest/cli.mts list [--dir DIR] [--n N]
       npx tsx tools/playtest/cli.mts show <folder|latest> [--dir DIR] [--json]
       npx tsx tools/playtest/cli.mts watch [--dir DIR] [--ticker FILE]`;
const argv = process.argv.slice(2);
const opt = (n: string) => { const i = argv.indexOf(n); return i < 0 ? undefined : argv[i + 1]; };
const dir = resolveDir(opt("--dir"));
const [cmd, which] = argv.filter((a, i) => !a.startsWith("--") && !["--dir", "--n", "--ticker"].includes(argv[i - 1] ?? ""));

function markdown(a: ReturnType<typeof analyse>, folder: string) {
  const L = [`# ${a.id} · ${a.at.replace("T", " ").slice(0, 19)} UTC${a.mark ? " · F8 mark" : ""}`, "", `> ${a.message}`, ""];
  L.push(`- **Folder:** ${path.join(dir, folder)}`);
  L.push(`- **Build:** ${a.build ? `server ${a.build.branch ?? "?"} · ${a.build.sha}` : "unknown"} · flags ${Object.keys(a.flags).map((k) => (a.flags[k] ? `${k}=${a.flags[k]}` : k)).join("&") || "none"}`);
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

function open(f: string) {
  const r = loadBundle(dir, f);
  if (!r.ok) console.error(`warning: skipping ${f}: ${r.reason}`);
  return r.ok ? r.value : null;
}

if (cmd === "list") {
  const all = bundleFolders(dir), n = Number(opt("--n") ?? 20);
  if (!all.length) { console.log(`no bundles in ${dir}`); process.exit(0); }
  for (const f of all.slice(-n).reverse()) {
    const s = open(f);
    if (!s) continue;
    const a = analyse(s);
    console.log(`${f}  ${a.build?.branch ?? "?"}@${a.build?.sha ?? "?"}  ${a.seconds}s  fps ${a.fps.median}  stalls ${a.stalls.secondsWithStall}  lag ${a.network.lagSpikeSeconds}  ${a.mark ? "[F8] " : ""}${a.message.slice(0, 70)}`);
  }
} else if (cmd === "show") {
  const all = bundleFolders(dir);
  const f = which === "latest" || !which ? all[all.length - 1] : all.find((x) => x === which || x.endsWith(which));
  if (!f) { console.error(`no bundle ${which ?? "latest"} in ${dir}`); process.exit(1); }
  const s = open(f);
  if (!s) process.exit(1);
  const a = analyse(s);
  console.log(argv.includes("--json") ? JSON.stringify(a, null, 2) : markdown(a, f));
} else if (cmd === "watch") {
  const ticker = path.resolve(opt("--ticker") ?? path.join(dir, "ticker.txt"));
  const seen = new Map<string, IndexEntry>(), warned = new Set<string>();
  let lastTicker: string | null = null, started = false;
  const poll = () => {
    const fresh: IndexEntry[] = [];
    for (const f of bundleFolders(dir)) {
      if (seen.has(f)) continue;
      const r = loadBundle(dir, f);
      if (!r.ok) {
        if (!warned.has(f)) console.error(`warning: ${f} not readable yet: ${r.reason}`);
        warned.add(f);
        continue;
      }
      const e = triageBundle(r.value).entry;
      seen.set(f, e);
      fresh.push(e);
    }
    if (!started) console.log(`watching ${dir}: ${fresh.length} bundles so far, ticker ${ticker}`);
    else for (const e of fresh) console.log(`${new Date(e.receivedAt).toLocaleTimeString("en-GB")}  ${e.symptoms[0].padEnd(9)}  ${configLabel(e)}  ${e.location.poi ?? e.location.phase}  ${e.id}`);
    started = true;
    const line = tickerLine([...seen.values()], Date.now());
    if (line !== lastTicker) { fs.mkdirSync(path.dirname(ticker), { recursive: true }); fs.writeFileSync(ticker, line + "\n"); lastTicker = line; }
  };
  poll();
  setInterval(poll, WATCH_POLL_MS);
} else { console.error(USAGE); process.exit(1); }
