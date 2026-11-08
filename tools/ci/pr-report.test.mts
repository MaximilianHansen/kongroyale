// Tests for the PR metrics comment (tools/ci/pr-report.mts): what it reads from hostile or partial artifacts, the verdict
// on each row, and that plain Node runs it with no install, as .github/workflows/pr-metrics.yml does.
//   npx tsx tools/ci/pr-report.test.mts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extract, render } from "./pr-report.mts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kong-pr-report-"));
const write = (dir: string, file: string, data: unknown) => { const f = path.join(root, dir, file); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === "string" ? data : JSON.stringify(data)); };
const ok = (value: unknown) => ({ status: "ok", unit: "bytes", better: "lower", value });
const side = (dir: string, size: { boot: number; lazy: number }, alloc: unknown, title: Record<string, unknown> | string) => {
  write(dir, "ci-metrics-test/budgets/size-budgets.json", { gzBytes: { entry: 100, boot: 1000, workers: 500, lazy: 2000 } });
  write(dir, "ci-metrics-test/budgets/alloc-budgets.json", { underPct: 12, budgets: { "host/real-play": { allocBytesPerTick: 1000, gcCount: 80 } } });
  write(dir, "ci-metrics-test/budgets/memory-budgets.json", { underPct: 5, underPctBy: { "title.webglMB": 50 }, budgets: { title: { webglMB: 100, textureCount: 10, "x | [click](https://e.vil) @someone": 1 }, "**bold**": { webglMB: 1 } } });
  write(dir, "ci-metrics-test/size.json", { entry: { gz: 99 }, boot: { total: { gz: size.boot } }, classes: { "js: workers": { gz: 480 }, "js: lazy": { gz: size.lazy } } });
  write(dir, "ci-metrics-test/alloc.json", { cases: [{ scenario: { id: "host/real-play" }, metrics: { allocBytesPerTick: ok(alloc), gcCount: ok(76) } }] });
  write(dir, "ci-metrics-boot/result.json", typeof title === "string" ? title : { cases: [{ scenario: { id: "memory/title" }, metrics: title }] });
};
side("base", { boot: 990, lazy: 1990 }, 900, { webglMB: ok(98), textureCount: ok(10) });
side("head", { boot: 1003, lazy: 1700 }, "1e9", "{ not json");

const head = extract(path.join(root, "head")), base = extract(path.join(root, "base"));
const get = (ms: typeof head, name: string) => ms.find((m) => m.name === name);
assert.equal(get(head, "boot")?.value, 1003);
assert.equal(get(head, "host/real-play.allocBytesPerTick")?.value, null, "a string where a number belongs reads as not measured");
assert.equal(get(head, "title.webglMB"), undefined, "an unparseable report drops its group");
assert.equal(get(base, "title.webglMB")?.value, 98);
assert.equal(get(base, "title.webglMB")?.underPct, 50, "a number's own floor (underPctBy) replaces underPct");
assert.equal(get(base, "title.textureCount")?.underPct, 5, "and only for that number");
assert.ok(base.every((m) => /^[\w./-]+$/.test(m.name)), "a budget key with markdown never reaches the comment");

const md = render(head, base, { headSha: "abcdef1234567", baseSha: "0123456789" });
const row = (name: string) => md.split("\n").find((l) => l.startsWith(`| ${name} |`)) ?? "";
assert.match(md, /^<!-- kong-pr-metrics -->\n/, "the marker the workflow finds its comment by comes first");
assert.match(md, /`abcdef1` against main at `0123456`/);
assert.match(row("boot"), /\| 990 \| 1,003 \| \+13 \(\+1\.3%\) \| 1,000 \| over budget \|$/);
assert.match(row("lazy"), /far under: lower the budget/);
assert.match(row("workers"), /\| 480 \| 480 \| 0 \| 500 \|  \|$/);
assert.match(row("host/real-play.allocBytesPerTick"), /not measured/);
assert.match(md, /\*\*3 to look at\*\*/);
assert.match(md, /Not in this run: Memory at the title \(SwiftShader\), Memory in the first warm-up \(SwiftShader\), Match-to-match memory/);

const leak = (v: number) => [{ source: "leak", name: "leak.webglMB", value: v, budget: 8, underPct: 100 }];
assert.doesNotMatch(render(leak(3), leak(1)), /to look at/, "a leak row moving under its ceiling is not flagged");
assert.match(render(leak(9), leak(1)), /to look at/, "a leak row over its ceiling is");
assert.match(render(head, null), /against no main run with metrics yet/);
assert.doesNotMatch(render(base, base), /to look at/, "identical runs flag nothing");

const plain = spawnSync(process.execPath.endsWith("node") ? process.execPath : "node", ["--experimental-strip-types", "--no-warnings", "tools/ci/pr-report.mts", "--head", path.join(root, "head")], { encoding: "utf8" });
assert.equal(plain.status, 0, `plain node failed to run pr-report.mts: ${plain.stderr}`);
assert.match(plain.stdout, /<!-- kong-pr-metrics -->/);

fs.rmSync(root, { recursive: true, force: true });
console.log("pr-report: all checks passed");
