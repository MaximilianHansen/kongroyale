#!/usr/bin/env node
// `npm test`: every automated check that needs no GPU, no network and no database, one after another.
// Exit 0 = all passed. Run `npm run build` first (the admin red-team serves the built admin bundles).
//   npm test                         every check
//   npm test -- --list               print each check's id and stop
//   npm test -- --only types,lint    only these checks (ids from --list)
//   npm test -- --fast               skip the checks marked slow (about 30 s instead of about 4 min);
//                                    run them all before a PR
// A filtered run says how many checks it skipped, so it never reads as a full pass.
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

// reports go to a temp folder: `npm test` never changes a tracked file
const tmp = (f) => path.join(os.tmpdir(), `kong-royale-${f}`);

/** id: the name --only takes; slow: skipped by --fast (each takes 10 s or more) */
const checks = [
  { id: "types", name: "types", cmd: "npx", args: ["tsc", "--noEmit"] },
  { id: "lint", name: "lint", cmd: "npx", args: ["tsx", "tools/lint/check.mts"] },
  { id: "gate", name: "verifier flag and empty-input gates", cmd: "npx", args: ["tsx", "tools/gate.test.mts"] },
  { id: "size", name: "download size (against tools/size-budgets.json)", cmd: "npx", args: ["tsx", "tools/check-size.mts", "--budgets", "tools/size-budgets.json"] },
  { id: "farbake", name: "far impostors match their POI sources", cmd: "npx", args: ["tsx", "tools/world/far-bake.test.mts"] },
  { id: "assets", name: "asset sources (against tools/verify-assets.baseline.json)", cmd: "npx", args: ["tsx", "tools/verify-assets.mts", "--baseline", "tools/verify-assets.baseline.json"] },
  { id: "dmath", name: "deterministic math (shared/sim/dmath.ts)", cmd: "npx", args: ["tsx", "tools/dmath/test.mts"] },
  { id: "movement", name: "movement", cmd: "npx", args: ["tsx", "tools/gameplay/movetest.mts"] },
  { id: "swimming", name: "swimming", cmd: "npx", args: ["tsx", "tools/swim/simtest.mts"] },
  { id: "face", name: "kong face", cmd: "npx", args: ["tsx", "tools/actors/face-test.mts"] },
  { id: "anim", name: "kong animation", cmd: "npx", args: ["tsx", "tools/actors/anim-test.mts"] },
  { id: "walkgraph", name: "building walk graph", cmd: "npx", args: ["tsx", "tools/buildings/walkgraph.test.mts"] },
  { id: "flags", name: "feature flags", cmd: "npx", args: ["tsx", "tools/flags/test.mts"] },
  { id: "solver", name: "path solver", slow: true, cmd: "npx", args: ["tsx", "tools/play/solver-tests.mts", "--json", tmp("solver-tests.json")] },
  { id: "glass", name: "glass", slow: true, cmd: "npx", args: ["tsx", "tools/glass/test.mts"] },
  { id: "planeview", name: "low-memory plane queues the POIs in view", slow: true, cmd: "npx", args: ["tsx", "tools/world/plane-view.test.mts"] },
  { id: "res", name: "resource scopes", cmd: "npx", args: ["tsx", "tools/res/test.mts"] },
  { id: "raycast", name: "raycast ties", cmd: "npx", args: ["tsx", "tools/world/raycast-test.mts"] },
  { id: "parity", name: "wire / matrix / geometry / http / splat parity", slow: true, cmd: "npm", args: ["run", "bench:verify"] },
  { id: "sim", name: "headless match (seed 42)", slow: true, cmd: "npx", args: ["tsx", "tools/sim-smoke.mts", "trios", "42", "--check"] },
  { id: "nettail", name: "network tails (against tools/performance/net-budgets.json)", slow: true, cmd: "npx", args: ["tsx", "tools/performance/net-tail.mts", "--check", "--out", tmp("net-tail.json")] },
  { id: "redteam", name: "admin lobby red team", slow: true, cmd: "node", args: ["tools/admin-lobby/redteam.mjs", "--md", tmp("redteam.md")] },
];

const usage = (why) => {
  console.error(`${why}\nusage: node tools/run-tests.mjs [--list | --fast | --only id,id]\nids: ${checks.map((c) => c.id).join(", ")}`);
  process.exit(2);
};
let only, fast = false, list = false;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--list") list = true;
  else if (a === "--fast") fast = true;
  else if (a === "--only" || a.startsWith("--only=")) {
    if (only) usage("--only given twice");
    const v = a === "--only" ? argv[++i] : a.slice("--only=".length);
    only = (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!only.length) usage("--only needs at least one check id");
    const bad = only.filter((id) => !checks.some((c) => c.id === id));
    if (bad.length) usage(`unknown check id(s): ${bad.join(", ")}`);
  } else usage(`unknown argument: ${a}`);
}
if ([list, fast, !!only].filter(Boolean).length > 1) usage("--list, --fast and --only don't combine; pick one");
if (list) {
  for (const c of checks) console.log(`${c.id.padEnd(10)} ${c.slow ? "slow" : "    "}  ${c.name}`);
  process.exit(0);
}
const selected = checks.filter((c) => (only ? only.includes(c.id) : !(fast && c.slow)));
const skipped = checks.filter((c) => !selected.includes(c));
if (skipped.length) console.log(`running ${selected.length} of ${checks.length} checks; skipping ${skipped.map((c) => c.id).join(", ")}`);

const failed = [];
for (const { name, cmd, args } of selected) {
  const t = Date.now();
  console.log(`\n▶ ${name}`);
  // npm and npx are .cmd scripts on Windows, which Node only spawns through a shell. The shell gets one command line
  // with every argument quoted, because the temp folder in the report paths can contain spaces. The command name stays
  // bare: cmd.exe starting a quoted "npx" from PATH makes %~dp0 in npx.cmd point at the current folder instead of the
  // Node install. node is a real executable, so it skips cmd.exe and its %VAR% expansion
  const r = process.platform === "win32" && cmd !== "node"
    ? spawnSync([cmd, ...args.map((a) => `"${a}"`)].join(" "), { stdio: "inherit", shell: true })
    : spawnSync(cmd, args, { stdio: "inherit" });
  const ok = r.status === 0;
  console.log(`${ok ? "✔" : "✘"} ${name} (${((Date.now() - t) / 1000).toFixed(1)} s)`);
  if (!ok) failed.push(name);
}
const ran = skipped.length ? ` (${skipped.length} of ${checks.length} skipped)` : "";
console.log(failed.length ? `\n${failed.length} failed: ${failed.join(", ")}${ran}` : `\nall ${selected.length} checks passed${ran}`);
process.exit(failed.length ? 1 : 0);
