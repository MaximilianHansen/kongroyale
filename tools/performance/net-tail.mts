// NET TAIL — the network tail gate. Runs tools/netlab.mts (the real client prediction and server host code over simulated
// TCP links: deterministic, so the same checkout gives the same numbers on every machine) over a matrix of weapons, path
// profiles and RTTs on each transport: the game's two WebSockets (--aux) and WebTransport (--transport wt: input windows
// and snapshots as datagrams), and checks every row against tools/performance/net-budgets.json. A budget names the
// transports it holds on; one without `transports` holds on every transport.
//
//   npx tsx tools/performance/net-tail.mts [--transports ws,wt] [--weapons ar,shotgun] [--rtts 50,150,250] [--secs 20] [--jobs N]
//                                          [--budgets tools/performance/net-budgets.json] [--out reports/performance/net-tail.json] [--check]
//
// Report-only by default: prints one row per run and every budget it breaks, writes a kong-perf-result (schema.ts), and
// exits 0. --check exits 1 when a row breaks a budget or has nothing to judge (no pellets, no hits, a predicted
// pellet without a server verdict, or no transport samples: the "measured" gate). Metrics per row (the shooter's firing window):
//   confirmPct, ghost       predicted hits the server confirmed / rejected (what the player feels as a hit marker)
//   deferredMarkerPct       the server's hits whose marker waited for its verdict because the link was slow or stalled
//   markerDelayP95Ms        how long those markers waited: fire → the server's verdict (ClientMatch.linkSlow)
//   rttP99Ms                ping → pong
//   inputAckP99OverRttMs    each input sent → the first snapshot acknowledging it, minus the path RTT: the server's own wait
//   snapGapP99Ms            time between snapshots (33 ms at 30 Hz when nothing is late)
//   corrPct                 prediction corrections per 100 snapshots, both clients
//   holdPct                 the shooter's frames that froze the target because no newer snapshot had arrived
// Runs are independent processes on a simulated clock, so --jobs (default: CPU count) changes the time taken, never
// the numbers. The netlab duel is two players on the lobby islet: it measures the link and the netcode, not a 50-player
// server under load (bench:server) or a real network (tools/performance/netpath.py, docs in tools/performance/README.md).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { arg, env, save, source } from "./common.mts";
import { RESULT_SCHEMA, RESULT_VERSION, type CaseResult, type Gate, type RunResult } from "./schema.ts";

interface Profile { jitter: number; loss: number; why: string }
interface Budget { id: string; metric: string; max?: number; min?: number; rtt: [number, number]; profiles: string[]; transports?: string[]; why: string }
interface Config { rtts: number[]; weapons: string[]; transports: string[]; profiles: Record<string, Profile>; budgets: Budget[] }
interface Row { transport: string; weapon: string; profile: string; rtt: number; metrics: Record<string, number>; samples: Record<string, number>; raw: Record<string, unknown> }

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const budgetFile = arg("--budgets", path.join(root, "tools/performance/net-budgets.json"));
const cfg = JSON.parse(fs.readFileSync(budgetFile, "utf8")) as Config;
const list = (k: string, d: string[]) => arg(k, d.join(",")).split(",").filter(Boolean);
const transports = list("--transports", cfg.transports), weapons = list("--weapons", cfg.weapons), rtts = list("--rtts", cfg.rtts.map(String)).map(Number), secs = Number(arg("--secs", "20"));
const jobs = Math.max(1, Number(arg("--jobs", String(os.cpus().length)))), out = arg("--out", "reports/performance/net-tail.json"), check = process.argv.includes("--check");
const startedAt = new Date().toISOString(), t0 = performance.now();

function netlab(transport: string, weapon: string, profile: string): Promise<Row[]> {
  const p = cfg.profiles[profile];
  const args = ["tsx", "tools/netlab.mts", rtts.join(","), "--jitter", String(p.jitter), "--loss", String(p.loss), ...(transport === "wt" ? ["--transport", "wt"] : ["--aux"]), "--secs", String(secs), "--weapon", weapon];
  return new Promise((resolve, reject) => {
    const child = spawn("npx", args, { cwd: root, stdio: ["ignore", "pipe", "inherit"], shell: process.platform === "win32" });
    let text = "";
    child.stdout.on("data", (d) => { text += d; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) return reject(Error(`netlab ${args.slice(2).join(" ")} exited ${code}`));
      resolve(text.split("\n").filter((l) => l.startsWith("{")).map((l) => {
        const r = JSON.parse(l);
        return { transport, weapon, profile, rtt: r.rtt, raw: r, samples: { rttP99Ms: r.rttMs.n, inputAckP99OverRttMs: r.inputAckMs.n, snapGapP99Ms: r.snapGapMs.n }, metrics: { confirmPct: r.confirmPct, ghost: r.ghost, rttP99Ms: r.rttMs.p99, inputAckP99OverRttMs: Math.round((r.inputAckMs.p99 - r.rtt) * 10) / 10, snapGapP99Ms: r.snapGapMs.p99, corrPct: r.corrPct, holdPct: r.holdPct, deferredMarkerPct: r.deferredMarkerPct, markerDelayP95Ms: r.markerDelayMs.p95 } };
      }));
    });
  });
}

const tasks = transports.flatMap((t) => weapons.flatMap((w) => Object.keys(cfg.profiles).map((p) => () => netlab(t, w, p))));
const rows: Row[] = [];
await Promise.all(Array.from({ length: Math.min(jobs, tasks.length) }, async () => { for (let t = tasks.shift(); t; t = tasks.shift()) rows.push(...await t()); }));
const order = (r: Row) => transports.indexOf(r.transport) * 1e9 + weapons.indexOf(r.weapon) * 1e6 + Object.keys(cfg.profiles).indexOf(r.profile) * 1e3 + r.rtt;
rows.sort((a, b) => order(a) - order(b));

const breaches: string[] = [];
const cases: CaseResult[] = rows.map((r) => {
  // a row is only judged on data it has: pellets fired, hits (shown at once or when the server's verdict came), a server verdict for every predicted pellet, and
  // transport samples in the firing window. A row without them breaks the "measured" gate instead of passing as zeros.
  const raw = r.raw as { pellets: number; predHits: number; servHits: number; predMissing: number };
  const empty = Object.entries(r.samples).filter(([, n]) => !n).map(([k]) => k);
  const why = [raw.pellets ? "" : "no pellets", raw.servHits ? "" : "no hits", raw.predMissing ? `${raw.predMissing} predicted pellets without a server verdict` : "", empty.length ? `no samples for ${empty.join(", ")}` : ""].filter(Boolean);
  const measured: Gate = { id: "measured", pass: !why.length, detail: why.length ? why.join("; ") : `${raw.pellets} pellets, ${raw.servHits} hits (${raw.predHits} predicted), every one judged` };
  const name = `${r.transport} ${r.weapon} ${r.profile} rtt ${r.rtt}`;
  if (!measured.pass) breaches.push(`${name}: measured: ${measured.detail}`);
  const gates: Gate[] = [measured, ...cfg.budgets.filter(() => measured.pass).filter((b) => b.profiles.includes(r.profile) && (!b.transports || b.transports.includes(r.transport)) && r.rtt >= b.rtt[0] && r.rtt <= b.rtt[1]).map((b) => {
    const v = r.metrics[b.metric], pass = (b.max === undefined || v <= b.max) && (b.min === undefined || v >= b.min);
    const detail = `${b.metric} ${v} (budget ${b.max !== undefined ? "≤ " + b.max : "≥ " + b.min})`;
    if (!pass) breaches.push(`${name}: ${b.id}: ${detail}`);
    return { id: b.id, pass, detail };
  })];
  const p = cfg.profiles[r.profile];
  const ms = (k: string) => r.samples[k] ? { status: "ok" as const, unit: "ms" as const, better: "lower" as const, value: r.metrics[k] } : { status: "invalid" as const, unit: "ms" as const, reason: "no samples in the firing window" };
  return {
    scenario: { id: `net/${r.weapon}/${r.profile}/rtt${r.rtt}${r.transport === "ws" ? "" : "/" + r.transport}`, version: 1, seed: 7, workload: "synthetic-play" },
    windows: { measured: "the shooter's firing window", secs, transport: `netlab ${r.transport === "wt" ? "simulated WebTransport (reliable stream + datagrams)" : "simulated TCP, 2 sockets"}, rtt ${r.rtt} ms, jitter ±${p.jitter / 2} ms per way, loss ${p.loss}%` },
    load: { pellets: r.raw.pellets as number, predHits: r.raw.predHits as number, servHits: r.raw.servHits as number },
    metrics: {
      confirmPct: { status: "ok", unit: "count", better: "higher", value: r.metrics.confirmPct },
      ghost: { status: "ok", unit: "count", better: "lower", value: r.metrics.ghost },
      rttP99Ms: ms("rttP99Ms"), inputAckP99OverRttMs: ms("inputAckP99OverRttMs"), snapGapP99Ms: ms("snapGapP99Ms"),
      corrPct: { status: "ok", unit: "count", better: "lower", value: r.metrics.corrPct },
      holdPct: { status: "ok", unit: "count", better: "lower", value: r.metrics.holdPct },
      deferredMarkerPct: { status: "ok", unit: "count", better: "lower", value: r.metrics.deferredMarkerPct },
      markerDelayP95Ms: r.metrics.deferredMarkerPct > 0 ? { status: "ok", unit: "ms", better: "lower", value: r.metrics.markerDelayP95Ms } : { status: "unsupported", unit: "ms", reason: "no marker waited for the server" },
    },
    gates, detail: r.raw,
  };
});
const result: RunResult = { schema: RESULT_SCHEMA, version: RESULT_VERSION, tool: "net-tail", startedAt, durationMs: performance.now() - t0, source: source(root), environment: env(),
  config: { transports: transports.join(","), weapons: weapons.join(","), rtts: rtts.join(","), secs, profiles: Object.keys(cfg.profiles).join(","), budgets: path.relative(root, budgetFile) }, cases, errors: [], artifacts: [] };
save(out, result);

const pad = (s: string | number, n: number) => String(s).padStart(n);
console.log(`${"tr".padEnd(4)}${"weapon".padEnd(8)}${"profile".padEnd(10)}${pad("rtt", 5)}${pad("confirm%", 10)}${pad("ghost", 7)}${pad("rtt p99", 9)}${pad("ack-rtt p99", 13)}${pad("gap p99", 9)}${pad("corr%", 7)}${pad("hold%", 7)}${pad("late%", 7)}${pad("late p95", 10)}  budgets`);
for (const c of cases) {
  const r = rows[cases.indexOf(c)], m = r.metrics, bad = c.gates.filter((g) => !g.pass).map((g) => g.id);
  if (!c.gates[0].pass) { console.log(`${r.transport.padEnd(4)}${r.weapon.padEnd(8)}${r.profile.padEnd(10)}${pad(r.rtt, 5)}  NOT MEASURED: ${c.gates[0].detail}`); continue; }
  console.log(`${r.transport.padEnd(4)}${r.weapon.padEnd(8)}${r.profile.padEnd(10)}${pad(r.rtt, 5)}${pad(m.confirmPct, 10)}${pad(m.ghost, 7)}${pad(m.rttP99Ms, 9)}${pad(m.inputAckP99OverRttMs, 13)}${pad(m.snapGapP99Ms, 9)}${pad(m.corrPct, 7)}${pad(m.holdPct, 7)}${pad(m.deferredMarkerPct, 7)}${pad(m.markerDelayP95Ms, 10)}  ${c.gates.length > 1 ? (bad.length ? "OVER: " + bad.join(", ") : "ok") : "-"}`);
}
console.log(`wrote ${out}`);
if (!breaches.length) console.log(`NET TAIL: every row measured and within budget (${cases.reduce((n, c) => n + c.gates.length - 1, 0)} budget checks)`);
else {
  console.log(`NET TAIL: ${breaches.length} over budget${check ? "" : " (report-only; --check fails on these)"}:\n  ${breaches.join("\n  ")}`);
  if (check) process.exitCode = 1;
}
