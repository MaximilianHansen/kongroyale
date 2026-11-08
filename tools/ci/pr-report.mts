// The PR metrics comment: one table of every budgeted number, main against the pull request, so an author sees a number
// move before it crosses its budget. CI's jobs upload their reports as artifacts (ci-metrics-test, ci-metrics-boot,
// memory-result, memory-lowmem-result); .github/workflows/pr-metrics.yml downloads a PR run's and main's, runs this file with plain Node
// (type stripping, no npm install) from main's checkout, and posts the markdown as one comment it keeps updating.
//   node --experimental-strip-types tools/ci/pr-report.mts --head DIR [--base DIR] [--head-sha SHA] [--base-sha SHA] [--out FILE]
// DIR is a folder of downloaded artifacts, one sub-folder per artifact. Every report is untrusted data from a PR's run:
// this file only reads JSON, keeps finite numbers under names it already knows, and writes markdown. It never fails a
// PR; the budgets themselves are enforced where they always were (npm test, the memory jobs).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Where a group of metrics comes from: the report file inside an artifact, and the budget file next to it. */
interface Source {
  id: string;
  title: string;
  report: string;
  budgets: string;
  kind: "size" | "perf";
  /** a change smaller than this (percent of main) is noise and shows as unchanged; from a main of zero, only 0 counts any change */
  noisePct: number;
  /** only budget verdicts: these numbers vary between runs well inside their ceilings, so a move is not news */
  budgetOnly?: boolean;
  /** perf reports: case ids are this prefix plus the budget file's key */
  casePrefix?: string;
}

/** Every source the comment knows, in table order. A missing file is a missing group, never an error. */
export const SOURCES: Source[] = [
  { id: "size", title: "Download size (gzip bytes)", report: "ci-metrics-test/size.json", budgets: "ci-metrics-test/budgets/size-budgets.json", kind: "size", noisePct: 0 },
  { id: "alloc", title: "Host allocation (real-play, per tick)", report: "ci-metrics-test/alloc.json", budgets: "ci-metrics-test/budgets/alloc-budgets.json", kind: "perf", noisePct: 5 },
  { id: "title", title: "Memory at the title (SwiftShader)", report: "ci-metrics-boot/result.json", budgets: "ci-metrics-test/budgets/memory-budgets.json", kind: "perf", noisePct: 2, casePrefix: "memory/" },
  { id: "warmup", title: "Memory in the first warm-up (SwiftShader)", report: "memory-result/result.json", budgets: "ci-metrics-test/budgets/memory-warmup-budgets.json", kind: "perf", noisePct: 2, casePrefix: "memory/" },
  { id: "leak", title: "Match-to-match memory (3 warm-ups)", report: "memory-result/result.json", budgets: "ci-metrics-test/budgets/memory-leak-budgets.json", kind: "perf", noisePct: 0, budgetOnly: true, casePrefix: "memory/" },
  { id: "lowmem", title: "Low-memory setup: title, plane, match (SwiftShader)", report: "memory-lowmem-result/result.json", budgets: "ci-metrics-test/budgets/memory-lowmem-budgets.json", kind: "perf", noisePct: 3, casePrefix: "memory/" },
];

/** One budgeted number from one run. */
export interface Metric { source: string; name: string; value: number | null; budget: number; underPct: number }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
// names come from a PR's own budget files, and the comment is posted as github-actions[bot]: keep only plain identifiers so
// a budget key can't carry markdown, links or mentions into it
const safeName = (k: string) => /^[A-Za-z0-9_.\/-]{1,64}$/.test(k);
const readJson = (file: string): unknown => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return undefined; } };

/** Reads every source's budgets and report under dir; a budget without a measured value comes back with value null. */
export function extract(dir: string): Metric[] {
  const out: Metric[] = [];
  for (const s of SOURCES) {
    const budgets = readJson(path.join(dir, s.budgets)), report = readJson(path.join(dir, s.report));
    if (!isObj(budgets) || report === undefined) continue;
    if (s.kind === "size") {
      const b = budgets.gzBytes, r = isObj(report) ? report : {};
      if (!isObj(b)) continue;
      const cls = (k: string) => { const c = isObj(r.classes) ? r.classes[k] : undefined; return isObj(c) ? num(c.gz) : null; };
      const boot = isObj(r.boot) && isObj(r.boot.total) ? num(r.boot.total.gz) : null;
      const actual: Record<string, number | null> = { entry: isObj(r.entry) ? num(r.entry.gz) : null, boot, workers: cls("js: workers"), lazy: cls("js: lazy") };
      for (const [k, v] of Object.entries(b)) if (num(v) !== null && k in actual) out.push({ source: s.id, name: k, value: actual[k], budget: v as number, underPct: 5 });
      continue;
    }
    const cases = isObj(report) && Array.isArray(report.cases) ? report.cases.filter(isObj) : [];
    const underPct = num(budgets.underPct) ?? 0, groups = budgets.budgets;
    if (!isObj(groups)) continue;
    for (const [key, metrics] of Object.entries(groups)) {
      if (!isObj(metrics) || !safeName(key)) continue;
      const c = cases.find((x) => isObj(x.scenario) && x.scenario.id === (s.casePrefix ?? "") + key);
      const ms = c && isObj(c.metrics) ? c.metrics : {};
      for (const [name, budget] of Object.entries(metrics)) {
        if (num(budget) === null || !safeName(name)) continue;
        const m = ms[name];
        out.push({ source: s.id, name: `${key}.${name}`, value: isObj(m) && m.status === "ok" ? num(m.value) : null, budget: budget as number, underPct: (isObj(budgets.underPctBy) ? num(budgets.underPctBy[`${key}.${name}`]) : null) ?? underPct });
      }
    }
  }
  return out;
}

const fmt = (v: number) => (Number.isInteger(v) ? v.toLocaleString("en-US") : v.toLocaleString("en-US", { maximumFractionDigits: 1 }));

/** Markdown for the comment: what needs attention first, then every number per source. */
export function render(head: Metric[], base: Metric[] | null, meta: { headSha?: string; baseSha?: string } = {}): string {
  const key = (m: Metric) => `${m.source} ${m.name}`, baseBy = new Map((base ?? []).map((m) => [key(m), m]));
  const rows = head.map((m) => {
    const s = SOURCES.find((x) => x.id === m.source)!, b = baseBy.get(key(m))?.value ?? null;
    const delta = m.value !== null && b !== null ? m.value - b : null, pct = delta !== null && b ? (delta / Math.abs(b)) * 100 : null;
    const moved = !s.budgetOnly && delta !== null && delta !== 0 && (pct === null ? s.noisePct === 0 : Math.abs(pct) > s.noisePct);
    const verdict = m.value === null ? "not measured" : m.value > m.budget ? "over budget"
      : m.value < m.budget * (1 - m.underPct / 100) ? "far under: lower the budget" : moved ? (delta! > 0 ? "up" : "down") : "";
    const change = delta === null ? "" : delta === 0 ? "0" : `${delta > 0 ? "+" : ""}${fmt(delta)}${pct === null ? "" : ` (${pct > 0 ? "+" : ""}${pct.toFixed(Math.abs(pct) < 0.1 ? 3 : 1)}%)`}`;
    return { m, s, b, change, verdict };
  });
  const attention = rows.filter((r) => r.verdict && r.verdict !== "down");
  const line = (r: (typeof rows)[number]) => `| ${r.m.name} | ${r.b === null ? "" : fmt(r.b)} | ${r.m.value === null ? "" : fmt(r.m.value)} | ${r.change} | ${fmt(r.m.budget)} | ${r.verdict} |`;
  const head_ = "| metric | main | this PR | change | budget | |\n|---|---:|---:|---:|---:|---|";
  const out = ["<!-- kong-pr-metrics -->", "### PR metrics"];
  const vs = `${meta.headSha ? `\`${meta.headSha.slice(0, 7)}\`` : "this PR"} against ${base ? (meta.baseSha ? `main at \`${meta.baseSha.slice(0, 7)}\`` : "main") : "no main run with metrics yet"}`;
  out.push(`${vs}. ${attention.length ? `**${attention.length} to look at** (over budget, far under, not measured, or up past its noise band).` : "Nothing over budget or up past its noise band."} This comment never fails the PR; the budgets fail in their own checks.`);
  if (attention.length) out.push("", head_, ...attention.map(line));
  out.push("", "<details><summary>Every number</summary>");
  for (const s of SOURCES) {
    const rs = rows.filter((r) => r.s === s);
    if (rs.length) out.push("", `**${s.title}**${s.budgetOnly ? " (budget verdicts only)" : s.noisePct ? ` (noise band ±${s.noisePct}%)` : ""}`, "", head_, ...rs.map(line));
  }
  const missing = SOURCES.filter((s) => !rows.some((r) => r.s === s));
  if (missing.length) out.push("", `Not in this run: ${missing.map((s) => s.title).join(", ")}.`);
  out.push("", "</details>");
  return out.join("\n") + "\n";
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  const opt = (k: string) => { const i = process.argv.indexOf(k); return i < 0 ? undefined : process.argv[i + 1]; };
  const headDir = opt("--head"), baseDir = opt("--base");
  if (!headDir) { console.error("usage: node --experimental-strip-types tools/ci/pr-report.mts --head DIR [--base DIR] [--head-sha SHA] [--base-sha SHA] [--out FILE]"); process.exit(2); }
  const md = render(extract(headDir), baseDir ? extract(baseDir) : null, { headSha: opt("--head-sha"), baseSha: opt("--base-sha") });
  const out = opt("--out");
  if (out) fs.writeFileSync(out, md); else process.stdout.write(md);
}
