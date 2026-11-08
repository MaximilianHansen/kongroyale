// Allocation and GC over the PLAY window of the real-play workload: bytes allocated per host tick, and how many
// garbage collections that costs. Writes a kong-perf-result (schema.ts) that compare.mts and run.mts read.
//   npx tsx tools/performance/alloc.mts --out reports/performance/alloc.json
//   npx tsx tools/performance/run.mts --runner alloc --base ../kong-base --cand . --metrics allocBytesPerTick
//   npx tsx tools/performance/alloc.mts --budgets tools/alloc-budgets.json   (what npm test runs: exit 1 over a ceiling)
// The match is host.mts's real-play (scenarios/real-play.mts): the same seed, setup and timed window, ticked through
// MatchHost with one fake peer per seat, so snapshot fan-out counts as it does on the server. Its state digest equals
// host.mts's, so run.mts can check that a change replays the same match.
// Bytes come from v8.GCProfiler, not the inspector: every GC reports the heap before and after it, so the bytes
// allocated between two GCs are (used before this GC) - (used after the last one). With no inspector attached the
// optimizer runs as it does on the server. --sample adds V8's sampling heap profiler and lists the top allocating
// functions in detail.topAllocators (B/tick). Sampling perturbs the JIT, so sampled runs never compare with unsampled.
import fs from "node:fs";
import path from "node:path";
import v8 from "node:v8";
import inspector from "node:inspector";
import { pathToFileURL } from "node:url";
import { arg, env, save, source, stateDigest } from "./common.mts";
import { RESULT_SCHEMA, RESULT_VERSION, type CaseResult, type RunResult } from "./schema.ts";
import { REAL_PLAY } from "./scenarios/real-play.mts";
import { checkBudgets } from "./budget-check.mts";

const root = path.resolve(arg("--root", ".")), out = arg("--out", "reports/performance/alloc.json"), sample = process.argv.includes("--sample");
const budgets = arg("--budgets", "");
if (budgets && sample) throw Error("--budgets judges unsampled runs only: --sample perturbs the JIT");
const scenario = arg("--scenario", "real-play");
if (scenario !== "real-play") throw Error(`alloc.mts measures --scenario real-play only, not ${scenario}`);
const mod = (p: string) => import(pathToFileURL(path.join(root, p)).href);
const [{ Terrain }, { decodeTerrainFile }, { buildStaticWorld }, { Match, Phase }, { MatchHost }] = await Promise.all([
  mod("shared/world/terrain.ts"), mod("shared/world/terrain-gen.ts"), mod("shared/sim/static-world.ts"), mod("shared/sim/match.ts"), mod("shared/net/host.ts"),
]);
const startedAt = new Date().toISOString(), run0 = performance.now(), environment = env();
const b = fs.readFileSync(path.join(root, "public/assets/terrain/island.bin"));
const td = decodeTerrainFile(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const { world, hash } = await buildStaticWorld(new Terrain(td.heights, td.biome), td);

const m = new Match({ seed: REAL_PLAY.seed, mode: "trios", world, humans: [] }), host = new MatchHost(m);
host.peers.push(...m.players.map((p: any) => ({ pid: p.id, invSeq: 0, send() {}, sendResult() {} })));
let setupTicks = 0;
m.startNow();
while (m.phase !== Phase.Play) { if (++setupTicks > 60 * 120) throw Error("real-play: match never reached PLAY"); host.tick(); }

const session = sample ? new inspector.Session() : null;
const post = (method: string, params?: object) => new Promise<any>((res, rej) => session!.post(method, params, (e, r) => e ? rej(e) : res(r)));
if (session) { session.connect(); await post("HeapProfiler.enable"); await post("HeapProfiler.startSampling", { samplingInterval: 4096, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true }); }

const ticks = REAL_PLAY.measuredTicks, phaseTicks: Record<string, number> = {};
const profiler = new v8.GCProfiler();
profiler.start();
const used0 = v8.getHeapStatistics().used_heap_size, t0 = performance.now();
for (let i = 0; i < ticks; i++) { host.tick(); phaseTicks[Phase[m.phase]] = (phaseTicks[Phase[m.phase]] ?? 0) + 1; }
const wallMs = performance.now() - t0, used1 = v8.getHeapStatistics().used_heap_size;
const gcs = profiler.stop().statistics;

let allocated = 0, last = used0, gcMs = 0;
const gcTypes: Record<string, number> = {};
for (const g of gcs) {
  allocated += g.beforeGC.heapStatistics.usedHeapSize - last;
  last = g.afterGC.heapStatistics.usedHeapSize;
  gcMs += g.cost / 1000;
  gcTypes[g.gcType] = (gcTypes[g.gcType] ?? 0) + 1;
}
allocated += used1 - last;

let topAllocators: Array<[string, number]> | undefined;
if (session) {
  const { profile } = await post("HeapProfiler.stopSampling");
  const by = new Map<string, number>(), prefix = pathToFileURL(root).href + "/";
  const walk = (n: any) => {
    if (n.selfSize) { const c = n.callFrame, k = `${c.url.replace(prefix, "") || "(builtin)"} ${c.functionName || "(anonymous)"}`; by.set(k, (by.get(k) ?? 0) + n.selfSize); }
    n.children.forEach(walk);
  };
  walk(profile.head);
  topAllocators = [...by].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, v]) => [k, Math.round(v / ticks)]);
  session.disconnect();
}

const value = (unit: "bytes" | "count" | "ms", v: number) => ({ status: "ok" as const, unit, better: "lower" as const, value: v });
const c: CaseResult = {
  scenario: { id: REAL_PLAY.id, version: REAL_PLAY.version, seed: REAL_PLAY.seed, workload: REAL_PLAY.workload },
  windows: { untimedMatchSetupTicks: setupTicks, measuredTicks: ticks, allocAndGc: "measured ticks only" },
  load: { seats: m.players.length, peers: host.peers.length, aliveAtEnd: m.aliveCount(), kills: m.players.reduce((n: number, p: any) => n + p.kills, 0),
    ...Object.fromEntries(Object.entries(phaseTicks).map(([k, v]) => ["ticksIn" + k, v])) },
  metrics: { allocBytesPerTick: value("bytes", allocated / ticks), gcCount: value("count", gcs.length), gcMs: value("ms", gcMs) },
  gates: [{ id: "measuredInPlay", pass: phaseTicks.Play === ticks, detail: `measured ticks by phase: ${JSON.stringify(phaseTicks)}` }],
  detail: { stateDigest: stateDigest(m), allocatedBytes: allocated, wallMs, gcTypes, ...(topAllocators ? { topAllocators } : {}) },
};
const result: RunResult = { schema: RESULT_SCHEMA, version: RESULT_VERSION, tool: "alloc", startedAt, durationMs: performance.now() - run0, source: source(root), environment,
  config: { scenarios: "real-play", worldHash: hash, mode: "trios", sample }, cases: [c], errors: [], artifacts: [] };
save(out, result);
console.log(`${c.scenario.id}: ${Math.round(allocated / ticks)} B/tick allocated, ${gcs.length} GCs (${gcMs.toFixed(1)} ms) in ${ticks} PLAY ticks, ${c.load.aliveAtEnd} alive`);
if (topAllocators) for (const [k, v] of topAllocators) console.log(`${String(v).padStart(9)} B/tick  ${k}`);
console.log("wrote", out);
for (const g of c.gates) if (!g.pass) { console.error(`FAIL: ${c.scenario.id} ${g.id}: ${g.detail}`); process.exitCode = 1; }
if (budgets && !checkBudgets(result, budgets)) process.exitCode = 1;
