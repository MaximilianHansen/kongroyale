// NETPATH MATRIX — the real server and real sockets over an emulated WAN path, for every RTT x loss x transport arm,
// n runs per arm, interleaved: each repetition walks every RTT x loss cell once, and within a cell runs the transports
// back to back in an order that alternates by repetition, so a drifting machine moves both transports alike. Each run is
// a fresh server (KR_WT=1, so both transports meet the same server) in the kr-srv namespace and sockets.mts in kr-cli
// (--aux on ws, a WebTransport session on wt), with netpath.py relaying between them. Linux and passwordless sudo only.
//
//   npx tsx tools/performance/netpath-matrix.mts [--rtts 0,50,150,250] [--losses 0,1] [--transports ws,wt] [--n 10]
//       [--secs 30] [--jitter 20] [--players 2] [--out reports/performance/netpath-matrix.json]
//
// Writes a kong-perf-result (schema.ts) with one case per arm (each metric summarised over its runs: p50 is the median
// run), a Markdown table next to it (.md) and every run's own sockets.mts result under <out>-runs/. A run whose
// sockets.mts gates fail is kept on disk but left out of its arm's numbers, and the arm says how many it lost. The jitter
// applies to every RTT above 0; the 0 ms cell is a clean path. Results are "emulated path" results: real kernel TCP and
// QUIC, synthetic delay and loss (PERFORMANCE.md, netpath.py). Hours long at the defaults (about 100 s a run), so it is
// never part of CI or npm test.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { arg, env, save, source, stats } from "./common.mts";
import { RESULT_SCHEMA, RESULT_VERSION, type CaseResult, type Metric, type RunResult } from "./schema.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const nums = (k: string, d: string) => arg(k, d).split(",").filter(Boolean).map(Number);
const rtts = nums("--rtts", "0,50,150,250"), losses = nums("--losses", "0,1"), transports = arg("--transports", "ws,wt").split(",").filter(Boolean);
const n = Number(arg("--n", "10")), secs = Number(arg("--secs", "30")), jitter = Number(arg("--jitter", "20")), players = Number(arg("--players", "2"));
const out = arg("--out", "reports/performance/netpath-matrix.json"), runsDir = out.replace(/\.json$/, "") + "-runs", mdOut = out.replace(/\.json$/, "") + ".md";
const SRV = "10.77.0.1", PORT = 3020, user = os.userInfo().username, tsx = path.join(root, "node_modules/.bin/tsx");
if (process.platform !== "linux") throw Error("netpath needs Linux: TUN devices and network namespaces");
try { execFileSync("sudo", ["-n", "true"], { stdio: "ignore" }); } catch { throw Error("netpath needs passwordless sudo (TUN devices and namespaces)"); }
if (transports.some((t) => t !== "ws" && t !== "wt")) throw Error("--transports takes ws and wt");

const startedAt = new Date().toISOString(), t0 = performance.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const exited = (p: ChildProcess) => new Promise<number>((r) => { if (p.exitCode !== null) r(p.exitCode); else p.once("exit", (c) => r(c ?? 1)); });
const inNs = (ns: string, vars: Record<string, string>, cmd: string[], log: number) =>
  spawn("sudo", ["ip", "netns", "exec", ns, "sudo", "-u", user, "env", "PATH=" + process.env.PATH, ...Object.entries(vars).map(([k, v]) => k + "=" + v), ...cmd], { cwd: root, stdio: ["ignore", log, log] });
/** every process left in a namespace but the relay (which holds its TUN device there): a server or client that outlived
 *  its run would hold the port for the next one */
const sweep = (ns: string) => { try { execFileSync("sh", ["-c", "sudo ip netns pids " + ns + " | grep -vxF \"$(pgrep -f tools/performance/netpath.py)\" | xargs -r sudo kill -9"], { stdio: "ignore" }); } catch { /* nothing left */ } };

async function netpath(rtt: number, loss: number) {
  const p = spawn("sudo", ["python3", "tools/performance/netpath.py", "--rtt", String(rtt), "--jitter", String(rtt ? jitter : 0), "--loss", String(loss)], { cwd: root, stdio: ["ignore", "pipe", "inherit"] });
  let text = "";
  p.stdout!.on("data", (d) => { text += d; });
  for (const end = Date.now() + 30_000; !/netpath: kr-srv/.test(text); await sleep(100)) {
    if (p.exitCode !== null || Date.now() > end) throw Error("netpath did not start: " + text);
  }
  return p;
}

interface Run { rep: number; transport: string; rtt: number; loss: number; file: string; ok: boolean; failed: string[]; metrics: Record<string, number> }
const runs: Run[] = [];
const summary = (file: string): Pick<Run, "ok" | "failed" | "metrics"> => {
  if (!fs.existsSync(file)) return { ok: false, failed: ["no result"], metrics: {} };
  const c = (JSON.parse(fs.readFileSync(file, "utf8")) as RunResult).cases[0], m = c.metrics as Record<string, any>;
  const v = (k: string, f: "p99" | "value") => (m[k]?.status === "ok" ? (f === "value" ? m[k].value : m[k].summary[f]) : NaN);
  // with a handful of players the match is mostly bots, and bots die in the window: that gate is about a full match's
  // load, not the link, so it is recorded but doesn't void the run
  const failed = c.gates.filter((g) => !g.pass && g.id !== "noDeathsInWindow").map((g) => g.id);
  return { ok: !failed.length, failed, metrics: { rttP99Ms: v("rttMs", "p99"), inputAckP99Ms: v("inputToAcknowledgmentMs", "p99"), snapGapP99Ms: v("snapshotGapMs", "p99"), serverInputGapPct: v("serverInputGapPct", "value"), serverCpuMsPerS: v("serverCpuMsPerSecond", "value"), bytesPerPlayerS: v("bytesPerPlayerSecond", "value") } };
};

async function run(rep: number, transport: string, rtt: number, loss: number) {
  const file = path.resolve(runsDir, "rep" + rep + "-" + transport + "-rtt" + rtt + "-loss" + loss + ".json"), log = fs.openSync(file.replace(/\.json$/, ".log"), "w");
  // an earlier matrix's result under the same name must never stand in for a run that died before writing its own
  fs.rmSync(file, { force: true });
  const server = inNs("kr-srv", { KR_HOST: SRV, KR_PORT: String(PORT), KR_EVENT_MODE: "0", KR_WARMUP_S: "5", KR_WT: "1", KR_PERF_METRICS: "1", KR_PLAYTEST_BUNDLES: "0" }, [tsx, "server/index.ts"], log);
  try {
    for (const end = Date.now() + 60_000; ; await sleep(500)) {
      try { execFileSync("sudo", ["ip", "netns", "exec", "kr-cli", "curl", "-sf", "-m", "2", "http://" + SRV + ":" + PORT + "/health"], { stdio: "ignore" }); break; } catch { /* not up yet */ }
      if (server.exitCode !== null || Date.now() > end) throw Error("server did not start; see " + file.replace(/\.json$/, ".log"));
    }
    const client = inNs("kr-cli", {}, [tsx, "tools/performance/sockets.mts", "--url", "http://" + SRV + ":" + PORT, "--players", String(players), "--seconds", String(secs), ...(transport === "wt" ? ["--transport", "wt"] : ["--aux"]), "--warmup-s", "5", "--out", file], log);
    await exited(client);
  } finally { server.kill("SIGTERM"); await Promise.race([exited(server), sleep(3000)]); sweep("kr-srv"); sweep("kr-cli"); fs.closeSync(log); }
  const r: Run = { rep, transport, rtt, loss, file: path.relative(root, file), ...summary(file) };
  runs.push(r); save(path.join(runsDir, "runs.json"), runs);
  console.log("rep " + (rep + 1) + "/" + n + "  " + transport + "  rtt " + rtt + "  loss " + loss + "%  " + (r.ok ? "ok" : "FAILED: " + r.failed.join(", ")) + "  rtt p99 " + r.metrics.rttP99Ms?.toFixed(1) + "  ack p99 " + r.metrics.inputAckP99Ms?.toFixed(1) + "  gap p99 " + r.metrics.snapGapP99Ms?.toFixed(1));
}

fs.mkdirSync(runsDir, { recursive: true });
try {
  for (let rep = 0; rep < n; rep++) for (const rtt of rtts) for (const loss of losses) {
    const relay = await netpath(rtt, loss);
    try { for (const t of rep % 2 ? [...transports].reverse() : transports) await run(rep, t, rtt, loss); }
    finally { relay.kill("SIGTERM"); await Promise.race([exited(relay), sleep(3000)]); }
  }
} finally { try { execFileSync("sudo", ["python3", "tools/performance/netpath.py", "--down"], { cwd: root, stdio: "ignore" }); } catch { /* already down */ } }

const METRICS: [string, string, Metric["unit"]][] = [["rttP99Ms", "rtt p99", "ms"], ["inputAckOverRttP99Ms", "ack−rtt p99", "ms"], ["snapGapP99Ms", "snap gap p99", "ms"], ["serverInputGapPct", "input-gap %", "%"], ["serverCpuMsPerS", "server CPU ms/s", "ms"], ["bytesPerPlayerS", "bytes/player/s", "bytes/s"]];
const cases: CaseResult[] = [], rows: string[] = [];
for (const rtt of rtts) for (const loss of losses) for (const transport of transports) {
  const arm = runs.filter((r) => r.transport === transport && r.rtt === rtt && r.loss === loss), good = arm.filter((r) => r.ok);
  for (const r of good) r.metrics.inputAckOverRttP99Ms = r.metrics.inputAckP99Ms - rtt;
  const metrics: Record<string, Metric> = {}, cells: string[] = [];
  for (const [k, , unit] of METRICS) {
    const vals = good.map((r) => r.metrics[k]).filter(Number.isFinite);
    if (!vals.length) { metrics[k] = { status: "invalid", unit, reason: "no run passed its gates" }; cells.push("-"); continue; }
    const s = stats(vals), lo = Math.min(...vals), f = (x: number) => (Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(1));
    metrics[k] = { status: "ok", unit, better: "lower", summary: s };
    cells.push(f(s.p50) + " (" + f(lo) + "–" + f(s.max) + ")");
  }
  cases.push({ scenario: { id: "netpath/" + transport + "/rtt" + rtt + "/loss" + loss, version: 1, seed: -1, workload: "socket-load" },
    windows: { measured: "sockets.mts PLAY window, " + secs + " s per run; each metric summarised over runs (p50 = the median run)", transport: "emulated path (netpath.py): rtt " + rtt + " ms, jitter ±" + (rtt ? jitter / 2 : 0) + " ms per way, loss " + loss + "% per direction; " + (transport === "wt" ? "WebSocket JSON + WebTransport session" : "two WebSockets (--aux)") },
    load: { players, runs: arm.length, passed: good.length },
    metrics, gates: [{ id: "everyRunPassed", pass: good.length === n, detail: good.length + " of " + n + " runs passed sockets.mts's gates" + (arm.length > good.length ? "; failed: " + arm.filter((r) => !r.ok).map((r) => "rep " + (r.rep + 1) + " " + r.failed.join("/")).join(", ") : "") }],
    detail: { runs: arm.map((r) => r.file) } });
  rows.push("| " + rtt + " | " + loss + "% | " + transport + " | " + good.length + "/" + n + " | " + cells.join(" | ") + " |");
}
const result: RunResult = { schema: RESULT_SCHEMA, version: RESULT_VERSION, tool: "netpath-matrix", startedAt, durationMs: performance.now() - t0, source: source(root), environment: env(),
  config: { rtts: rtts.join(","), losses: losses.join(","), transports: transports.join(","), n, secs, jitter, players }, cases, errors: [], artifacts: [path.relative(root, mdOut), path.relative(root, runsDir)] };
save(out, result);
const md = ["# netpath matrix (emulated path)", "", "Real server and sockets over netpath.py, " + n + " runs per arm of " + secs + " s, " + players + " players, jitter " + jitter + " ms above 0 ms RTT, source " + JSON.stringify(result.source) + ". Each cell is the median run (min–max over the runs that passed).", "",
  "| rtt ms | loss | transport | runs ok | " + METRICS.map((m) => m[1]).join(" | ") + " |", "|" + "---|".repeat(4 + METRICS.length), ...rows, ""].join("\n");
fs.writeFileSync(mdOut, md);
console.log("\n" + md + "\nwrote " + out + " and " + mdOut);
if (cases.some((c) => !c.gates[0].pass)) process.exitCode = 1;
