// TLC runner for the TLA+ models in tools/formal/: downloads the pinned TLA+ tools jar once (checked by SHA-256, never
// committed), model-checks a model with its .cfg, and with --mutants proves the model can fail: each mutant in
// <Model>.mutants.json removes one guard from a scratch copy of the model and must make TLC report the rule it names.
//   node tools/formal/tlc.mjs <Model>                 check one model (exit 1 on any violation or error)
//   node tools/formal/tlc.mjs <Model> --mutants       ... and every mutant must fail as its entry says
//   node tools/formal/tlc.mjs --all [--mutants]       every model in this folder
//   node tools/formal/tlc.mjs <Model> --mutants --record
//                                                     ... and when all pass, record the code it describes as verified
//                                                     (<Model>.covers.json; npm test's formal check reads it, drift.mjs)
// Needs Java 11 or newer on PATH. Each model's covers file names the skill that says when to run it.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TLA_VERSION = "1.7.4";
const TLA_SHA256 = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88";
const TLA_URL = `https://github.com/tlaplus/tlaplus/releases/download/v${TLA_VERSION}/tla2tools.jar`;
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const jar = path.join(root, "node_modules", ".cache", "tla2tools", TLA_VERSION, "tla2tools.jar");
const OK_LINE = "Model checking completed. No error has been found.";

const fail = (msg) => { console.error(`tlc: ${msg}`); process.exit(2); };
const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

async function ensureJar() {
  if (fs.existsSync(jar) && sha256(jar) === TLA_SHA256) return;
  fs.mkdirSync(path.dirname(jar), { recursive: true });
  console.log(`tlc: downloading TLA+ tools ${TLA_VERSION}`);
  const res = await fetch(TLA_URL);
  if (!res.ok) fail(`download failed: HTTP ${res.status} for ${TLA_URL}`);
  // a name of its own, so two checks downloading at once never touch each other's file
  const tmp = `${jar}.${process.pid}.${Date.now()}.part`;
  try {
    fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
    const got = sha256(tmp);
    if (got !== TLA_SHA256) { fs.rmSync(tmp, { force: true }); fail(`checksum mismatch for tla2tools.jar: got ${got}, want ${TLA_SHA256}`); }
    try { fs.renameSync(tmp, jar); }
    catch (e) { if (!(fs.existsSync(jar) && sha256(jar) === TLA_SHA256)) throw e; }   // (another check got there first)
  } finally { fs.rmSync(tmp, { force: true }); }
}

function ensureJava() {
  const r = spawnSync("java", ["-version"], { encoding: "utf8" });
  if (r.error || r.status !== 0) fail("java not found on PATH: install a JDK 11 or newer (macOS: brew install openjdk; Windows: winget install Microsoft.OpenJDK.21)");
}

/** runs TLC on dir/<model>.tla with dir/<model>.cfg; returns its output and how it ended */
function tlc(dir, model) {
  const meta = fs.mkdtempSync(path.join(os.tmpdir(), "kr-tlc-"));
  try {
    const r = spawnSync("java", ["-XX:+UseParallelGC", "-cp", jar, "tlc2.TLC", "-workers", "auto", "-metadir", meta, "-config", `${model}.cfg`, `${model}.tla`],
      { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (r.error) fail(String(r.error));
    const out = r.stdout + r.stderr;
    const distinct = Number((/([\d,]+) distinct states found/.exec(out)?.[1] ?? "0").replace(/,/g, ""));
    return { out, passed: out.includes(OK_LINE) && distinct > 1, distinct, states: (out.match(/^State \d+:/gm) ?? []).length };
  } finally { fs.rmSync(meta, { recursive: true, force: true }); }
}

/** the error lines TLC printed (what broke), without the trace */
const errors = (out) => out.split("\n").filter((l) => l.startsWith("Error:") && !l.startsWith("Error: The behavior up to this point is:")).join("\n");

function check(model) {
  if (!fs.existsSync(path.join(here, model + ".tla")) || !fs.existsSync(path.join(here, model + ".cfg"))) fail(`no ${model}.tla and ${model}.cfg in tools/formal`);
  const t0 = Date.now(), r = tlc(here, model), s = ((Date.now() - t0) / 1000).toFixed(1);
  if (r.passed) { console.log(`PASS ${model}: ${r.distinct} distinct states, every rule holds (${s} s)`); return true; }
  console.log(r.out);
  console.log(`FAIL ${model}: ${errors(r.out) || "TLC did not finish the check"}`);
  return false;
}

function mutants(model) {
  const file = path.join(here, model + ".mutants.json");
  if (!fs.existsSync(file)) fail(`${model} has no ${model}.mutants.json: a model nobody has seen fail proves nothing`);
  const list = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(list) || list.length === 0) fail(`${model}.mutants.json lists no mutant`);
  const src = fs.readFileSync(path.join(here, model + ".tla"), "utf8");
  let ok = true;
  for (const m of list) {
    if (typeof m.name !== "string" || typeof m.find !== "string" || typeof m.replace !== "string" || typeof m.expect !== "string" || !m.expect) fail(`${model}.mutants.json: each mutant needs name, find, replace and expect`);
    const n = src.split(m.find).length - 1;
    if (n !== 1) { console.log(`FAIL ${model} mutant "${m.name}": its find text occurs ${n} times in ${model}.tla (want 1): update the mutant`); ok = false; continue; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kr-mutant-"));
    try {
      fs.writeFileSync(path.join(dir, model + ".tla"), src.replace(m.find, () => m.replace));
      fs.copyFileSync(path.join(here, model + ".cfg"), path.join(dir, model + ".cfg"));
      const r = tlc(dir, model);
      if (!r.passed && r.out.includes(m.expect)) console.log(`PASS ${model} mutant "${m.name}": TLC reports "${m.expect}" after ${r.states} states`);
      else { ok = false; console.log(r.passed ? `FAIL ${model} mutant "${m.name}": every rule still holds without the guard` : `FAIL ${model} mutant "${m.name}": want "${m.expect}", TLC said: ${errors(r.out) || "(no error line)"}`); }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  return ok;
}

/** writes the token hashes of the code the model describes into <model>.covers.json (tools/formal/covers.mjs) */
async function recordCovers(model) {
  if (!fs.existsSync(path.join(here, model + ".covers.json"))) { console.log(`tlc: ${model} has no ${model}.covers.json: nothing to record`); return true; }
  const { modelHash, readCovers, region, strayWrites, writeCovers } = await import("./covers.mjs");
  const c = readCovers(model), regions = {};
  for (const key of c.regions) {
    const r = region(key);
    if (r.error) { console.log(`FAIL ${model} --record: ${key}: ${r.error}`); return false; }
    regions[key] = r.hash;
  }
  const stray = strayWrites(c);
  for (const s of stray) console.log(`FAIL ${model} --record: ${s.at} writes guarded state outside the code the model describes: ${s.text.trim()}`);
  if (stray.length) return false;
  c.verified = { model: modelHash(model), regions };
  writeCovers(model, c);
  console.log(`RECORDED ${model}: the model and ${c.regions.length} code regions, in tools/formal/${model}.covers.json`);
  return true;
}

const args = process.argv.slice(2);
const known = new Set(["--all", "--mutants", "--record"]);
for (const a of args) if (a.startsWith("--") && !known.has(a)) fail(`unknown flag ${a} (flags: --all, --mutants, --record)`);
const record = args.includes("--record");
if (record && !args.includes("--mutants")) fail("--record needs --mutants: the code is recorded as verified only by a model that was also seen to fail");
const names = args.filter((a) => !a.startsWith("--")).map((a) => path.basename(a).replace(/\.(tla|cfg)$/, ""));
const models = args.includes("--all") ? fs.readdirSync(here).filter((f) => f.endsWith(".tla") && fs.existsSync(path.join(here, f.slice(0, -4) + ".cfg"))).map((f) => f.slice(0, -4)).sort() : names;
if (models.length === 0) fail("name a model (a .tla file in tools/formal) or pass --all");
ensureJava();
await ensureJar();
let ok = true;
for (const model of models) {
  let passed = check(model);
  if (args.includes("--mutants")) passed = mutants(model) && passed;
  if (passed && record) passed = await recordCovers(model);
  ok = passed && ok;
}
process.exit(ok ? 0 : 1);
