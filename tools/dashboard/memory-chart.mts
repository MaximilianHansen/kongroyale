// Draws memory over time for one or more runs as an SVG (and a PNG through Playwright's Chromium), and converts
// tools/performance/memory.mts results into kong-memory-trace files. build.mts imports readTrace and renderSvg for the
// dashboard's Memory page; memory-chart.md describes the trace format and the command line.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type MarkerName = "title" | "play" | "plane" | "landing" | "results" | "leave";
export type TraceSample = { t: number; totalMB: number; browserMB?: number; rendererMB?: number; gpuMB?: number; heapMB?: number };
export type MemoryTrace = {
  schema: "kong-memory-trace";
  version: 1;
  label: string;
  build: string;
  browser: string;
  machine: string;
  flags: string;
  launcher: string;
  source: string;
  samples: TraceSample[];
  markers: { t: number; name: MarkerName }[];
  killed?: { t: number; MB: number; process: string };
};

type Series = "total" | "browser" | "renderer" | "gpu" | "heap";
type PerfTimelinePoint = { atS: number; totalMB: number; byType: Record<string, number>; unmeasured: string[]; phase: number };
type PerfResult = {
  tool: string;
  source?: { commit?: string };
  environment?: { gpu?: string | null; cpu?: string; memoryMB?: number; platform?: string };
  config?: { url?: string; profile?: string };
  cases?: { scenario: { id: string }; windows: { atS?: number } }[];
  timeline?: PerfTimelinePoint[];
};

const MARKER_ORDER: MarkerName[] = ["title", "play", "plane", "landing", "results", "leave"];
const MARKER_LABEL: Record<MarkerName, string> = { title: "Title", play: "Play", plane: "Plane", landing: "Landing", results: "Results", leave: "Leave" };
const SERIES_KEY: Record<Series, keyof TraceSample> = { total: "totalMB", browser: "browserMB", renderer: "rendererMB", gpu: "gpuMB", heap: "heapMB" };
const SERIES_LABEL: Record<Series, string> = { total: "whole browser", browser: "browser process", renderer: "renderer / WebContent", gpu: "GPU process", heap: "JS heap" };
const SERIES_DASH: Record<Series, string> = { total: "", renderer: "10 6", gpu: "3 5", browser: "14 4 3 4", heap: "1 4" };
const COLORS = ["#ffcc33", "#3ddc84", "#5aa9ff", "#ff6b6b", "#c58cff", "#ff9f43", "#4dd8e6", "#f368e0"];
const WIDTH_PX = 1600;
const HEIGHT_PX = 900;
const COMPACT_WIDTH_PX = 640;
const COMPACT_HEIGHT_PX = 520;

function wrapText(s: string, max: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of s.split(" ")) {
    if (line && (line + " " + word).length > max) { lines.push(line); line = word; }
    else line = line ? line + " " + word : word;
  }
  lines.push(line);
  return lines;
}

function fail(msg: string): never {
  throw new Error("memory-chart: " + msg);
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function fromPerfResult(r: PerfResult, file: string): MemoryTrace {
  const timeline = r.timeline ?? [];
  const samples: TraceSample[] = timeline.filter((p) => !p.unmeasured.length).map((p) => ({ t: p.atS, totalMB: p.totalMB, browserMB: p.byType.browser, rendererMB: p.byType.renderer, gpuMB: p.byType.GPU }));
  if (!samples.length) fail(file + " has no timeline samples with every process measured");
  const markers: MemoryTrace["markers"] = [];
  const caseAt = (id: string) => r.cases?.find((c) => c.scenario.id === id)?.windows.atS;
  const title = caseAt("memory/title");
  if (finite(title)) markers.push({ t: title, name: "title" });
  const matchStart = timeline.findIndex((p) => p.phase >= 0);
  if (matchStart >= 0) {
    const leaveAt = timeline.findIndex((p, i) => i > matchStart && p.phase < 0);
    const firstMatch = timeline.slice(matchStart, leaveAt < 0 ? timeline.length : leaveAt);
    const firstPhase = (phase: number) => firstMatch.find((p) => p.phase >= phase)?.atS;
    markers.push({ t: timeline[matchStart].atS, name: "play" });
    const plane = caseAt("memory/plane") ?? firstPhase(1);
    if (finite(plane)) markers.push({ t: plane, name: "plane" });
    const landing = firstPhase(2);
    if (finite(landing)) markers.push({ t: landing, name: "landing" });
    const results = firstPhase(3);
    if (finite(results)) markers.push({ t: results, name: "results" });
    if (leaveAt >= 0) markers.push({ t: timeline[leaveAt].atS, name: "leave" });
  }
  const commit = r.source?.commit ? "harness " + r.source.commit.slice(0, 7) : "unknown build";
  const profile = r.config?.profile;
  return {
    schema: "kong-memory-trace", version: 1,
    label: path.basename(path.dirname(file)),
    build: commit,
    browser: (profile === "nogpu" ? "Chromium" : "Chrome") + (profile ? " (" + profile + " profile)" : ""),
    machine: [r.environment?.cpu, r.environment?.memoryMB ? Math.round(r.environment.memoryMB / 1024) + " GB" : ""].filter(Boolean).join(", ") || "unknown machine",
    flags: r.config?.url ?? "",
    launcher: "playwright",
    source: file,
    samples, markers: markers.sort((a, b) => a.t - b.t),
  };
}

export function readTrace(file: string): MemoryTrace {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<MemoryTrace> & PerfResult;
  const trace = raw.schema === "kong-memory-trace" ? raw as MemoryTrace : raw.tool === "memory" ? fromPerfResult(raw, file) : fail(file + " is neither a kong-memory-trace nor a memory.mts result");
  if (trace.version !== 1) fail(file + ": unsupported kong-memory-trace version " + String(trace.version));
  if (!trace.samples.length) fail(file + " has no samples");
  for (const s of trace.samples) if (!finite(s.t) || !finite(s.totalMB)) fail(file + " has a sample without a finite t and totalMB");
  for (const m of trace.markers) if (!MARKER_ORDER.includes(m.name)) fail(file + ": unknown marker " + m.name);
  return trace;
}

function phaseAxis(traces: MemoryTrace[]): MarkerName[] {
  return MARKER_ORDER.filter((name) => traces.every((tr) => tr.markers.some((m) => m.name === name)));
}

function phaseX(tr: MemoryTrace, axis: MarkerName[], t: number): number {
  const knots = [{ t: tr.samples[0].t, x: 0 }];
  axis.forEach((name, i) => knots.push({ t: tr.markers.find((m) => m.name === name)!.t, x: i + 1 }));
  knots.push({ t: tr.samples[tr.samples.length - 1].t, x: axis.length + 1 });
  for (let i = 1; i < knots.length; i++) {
    const a = knots[i - 1], b = knots[i];
    if (t <= b.t) return b.t === a.t ? b.x : a.x + ((t - a.t) / (b.t - a.t)) * (b.x - a.x);
  }
  return axis.length + 1;
}

export function renderSvg(traces: MemoryTrace[], opts: { title: string; series: Series[]; xMode: "time" | "phase"; killMB?: number; killLabel?: string; compact?: boolean }): string {
  const compact = opts.compact === true;
  const w = compact ? COMPACT_WIDTH_PX : WIDTH_PX;
  const top = compact ? 124 : 90, left = compact ? 84 : 110, right = compact ? 20 : 40;
  const wrapChars = compact ? Math.floor((w - left - 40) / 10.5) : Infinity;
  const legendLines = traces.map((tr) => wrapText(tr.label + "\u00a0\u00a0" + [tr.build === tr.label ? "" : tr.build, tr.browser, tr.machine, tr.flags].filter(Boolean).join(" · ") + (tr.killed ? "; " + tr.killed.process + " killed at " + tr.killed.MB + " MB" : ""), wrapChars));
  const styleKey = opts.series.length === 1 ? SERIES_LABEL[opts.series[0]] : opts.series.map((se) => SERIES_LABEL[se] + (SERIES_DASH[se] ? " (" + (se === "renderer" ? "dashed" : se === "gpu" ? "dotted" : se === "heap" ? "fine dots" : "dash-dot") + ")" : " (solid)")).join(", ");
  const noteLines = wrapText("Lines: " + styleKey + (opts.xMode === "time" && traces.length > 1 ? ". Phase markers are from " + traces[0].label + "." : ""), wrapChars + 4);
  if (traces.some((tr) => tr.launcher === "playwright")) noteLines.push(...wrapText("Playwright-launched runs: totals after Play may be inflated by the launcher.", wrapChars + 4));
  const legendRows = legendLines.reduce((n, l) => n + l.length, 0) + Math.max(0, noteLines.length - 2);
  const bottom = (opts.xMode === "time" ? 170 : 120) + legendRows * 30;
  const h = (compact ? COMPACT_HEIGHT_PX : HEIGHT_PX) + legendRows * 30 + (opts.xMode === "time" ? 50 : 0);
  const plotW = w - left - right, plotH = h - top - bottom;
  const axis = phaseAxis(traces);
  const xOf = (tr: MemoryTrace, t: number) => opts.xMode === "phase" ? phaseX(tr, axis, t) : t;
  let xMax = 0, yMax = opts.killMB ?? 0;
  for (const tr of traces) for (const s of tr.samples) {
    xMax = Math.max(xMax, xOf(tr, s.t));
    for (const se of opts.series) { const v = s[SERIES_KEY[se]]; if (finite(v)) yMax = Math.max(yMax, v); }
  }
  for (const tr of traces) if (tr.killed) { xMax = Math.max(xMax, xOf(tr, tr.killed.t)); yMax = Math.max(yMax, tr.killed.MB); }
  const yMaxGB = Math.max(1, Math.ceil((yMax / 1024) * 1.08));
  const xs = (x: number) => left + (xMax ? (x / xMax) * plotW : 0);
  const ys = (mb: number) => top + plotH - (mb / 1024 / yMaxGB) * plotH;
  const out: string[] = [];
  out.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + " " + h + '" font-family="-apple-system,Segoe UI,Inter,Roboto,sans-serif">');
  out.push('<rect width="100%" height="100%" fill="#0b0d12"/>');
  if (!compact) out.push('<text x="' + left + '" y="52" fill="#f2f4f8" font-size="32" font-weight="800">' + esc(opts.title) + "</text>");
  const stepGB = yMaxGB <= 4 ? 0.5 : yMaxGB <= 10 ? 1 : 2;
  for (let g = 0; g <= yMaxGB + 1e-9; g += stepGB) {
    const y = ys(g * 1024);
    out.push('<line x1="' + left + '" x2="' + (left + plotW) + '" y1="' + y + '" y2="' + y + '" stroke="#252b3a"/>');
    out.push('<text x="' + (left - 14) + '" y="' + (y + 6) + '" fill="#8d96ab" font-size="18" text-anchor="end">' + g + " GB</text>");
  }
  if (opts.xMode === "time") {
    const step = xMax > 600 ? 120 : xMax > 240 ? 60 : 30;
    for (let t = 0; t <= xMax; t += step) out.push('<text x="' + xs(t) + '" y="' + (top + plotH + 30) + '" fill="#8d96ab" font-size="18" text-anchor="middle">' + t + " s</text>");
    out.push('<text x="' + (left + plotW / 2) + '" y="' + (top + plotH + 62) + '" fill="#8d96ab" font-size="18" text-anchor="middle">seconds since launch</text>');
  }
  const markerTrace = traces[0];
  const markerNames = opts.xMode === "phase" ? axis : MARKER_ORDER.filter((n) => markerTrace.markers.some((m) => m.name === n));
  let lastLabelX = -Infinity, lastRow = 1;
  markerNames.forEach((name, i) => {
    const x = opts.xMode === "phase" ? xs(i + 1) : xs(markerTrace.markers.find((m) => m.name === name)!.t);
    out.push('<line x1="' + x + '" x2="' + x + '" y1="' + top + '" y2="' + (top + plotH) + '" stroke="#4a5266" stroke-dasharray="4 6"/>');
    const nearRight = x > left + plotW - 90;
    const row = compact ? (x - lastLabelX < 80 ? (lastRow + 1) % 4 : 0) : x - lastLabelX < 90 && lastRow === 0 ? 1 : 0;
    lastLabelX = x; lastRow = row;
    out.push('<text x="' + (nearRight ? x - 6 : x + 6) + '" y="' + (top + 22 + row * 24) + '" fill="#c7cede" font-size="18" font-weight="700" text-anchor="' + (nearRight ? "end" : "start") + '">' + MARKER_LABEL[name] + "</text>");
  });
  if (finite(opts.killMB)) {
    const y = ys(opts.killMB);
    out.push('<line x1="' + left + '" x2="' + (left + plotW) + '" y1="' + y + '" y2="' + y + '" stroke="#ff6b6b" stroke-width="2.5" stroke-dasharray="12 8"/>');
    out.push('<text x="' + (left + plotW - 8) + '" y="' + (y - top < 70 ? y + 26 : y - 10) + '" fill="#ff6b6b" font-size="19" font-weight="700" text-anchor="end">' + esc(opts.killLabel ?? "kill line") + "</text>");
  }
  traces.forEach((tr, i) => {
    const color = COLORS[i % COLORS.length];
    for (const se of opts.series) {
      const runs: string[][] = [[]];
      for (const s of tr.samples) {
        const v = s[SERIES_KEY[se]];
        if (finite(v)) runs[runs.length - 1].push(xs(xOf(tr, s.t)).toFixed(1) + "," + ys(v).toFixed(1));
        else if (runs[runs.length - 1].length) runs.push([]);
      }
      for (const pts of runs) {
        if (pts.length === 1) { const [cx, cy] = pts[0].split(","); out.push('<circle cx="' + cx + '" cy="' + cy + '" r="' + (se === "total" ? 5 : 3.5) + '" fill="' + color + '"/>'); }
        else if (pts.length) out.push('<polyline fill="none" stroke="' + color + '" stroke-width="' + (se === "total" || opts.series.length === 1 ? 4 : 2.5) + '" stroke-linejoin="round" stroke-dasharray="' + (opts.series.length === 1 ? "" : SERIES_DASH[se]) + '" points="' + pts.join(" ") + '"/>');
      }
    }
    if (tr.killed) out.push('<text x="' + xs(xOf(tr, tr.killed.t)) + '" y="' + (ys(tr.killed.MB) - 12) + '" fill="' + color + '" font-size="26" font-weight="800" text-anchor="middle">✕</text>');
  });
  let ly = top + plotH + (opts.xMode === "time" ? 100 : 50);
  traces.forEach((tr, i) => {
    out.push('<rect x="' + left + '" y="' + (ly - 14) + '" width="28" height="8" rx="4" fill="' + COLORS[i % COLORS.length] + '"/>');
    legendLines[i].forEach((line, j) => {
      const split = j === 0 ? line.indexOf("\u00a0\u00a0") : -1;
      const body = split < 0 ? esc(line) : "<tspan font-weight=\"700\">" + esc(line.slice(0, split)) + "</tspan>  " + esc(line.slice(split + 2));
      out.push('<text x="' + (left + 40) + '" y="' + ly + '" fill="#f2f4f8" font-size="19">' + body + "</text>");
      ly += 30;
    });
  });
  noteLines.forEach((line, i) => out.push('<text x="' + left + '" y="' + (ly + 4 + i * 26) + '" fill="#8d96ab" font-size="17">' + esc(line) + "</text>"));
  out.push("</svg>");
  return out.join("\n");
}

async function writePng(svg: string, file: string): Promise<void> {
  const { chromium } = await import("playwright");
  const m = svg.match(/width="(\d+)" height="(\d+)"/);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: Number(m?.[1] ?? WIDTH_PX), height: Number(m?.[2] ?? HEIGHT_PX) } });
    await page.setContent('<html><body style="margin:0;background:#0b0d12">' + svg + "</body></html>");
    await page.screenshot({ path: file, omitBackground: false });
  } finally {
    await browser.close();
  }
}

function opt(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const valueFlags = new Set(["--out", "--title", "--series", "--x", "--kill-mb", "--kill-label", "--label", "--emit"]);
  const files: string[] = [];
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (valueFlags.has(a)) i++;
    else if (a.startsWith("--")) { if (a !== "--no-png") fail("unknown flag " + a); }
    else files.push(a);
  }
  if (!files.length) fail("usage: npx tsx tools/dashboard/memory-chart.mts <run.json>... --out chart.svg [--title T] [--series total,renderer,gpu,browser,heap] [--x time|phase] [--kill-mb N --kill-label L] [--label a,b] [--emit dir] [--no-png]");
  const traces = files.map(readTrace);
  const labels = opt("--label")?.split(",");
  if (labels) { if (labels.length !== traces.length) fail("--label needs one label per run"); traces.forEach((tr, i) => { tr.label = labels[i]; tr.build = labels[i]; }); }
  const emit = opt("--emit");
  if (emit) {
    fs.mkdirSync(emit, { recursive: true });
    traces.forEach((tr, i) => fs.writeFileSync(path.join(emit, String(i + 1).padStart(2, "0") + "-" + tr.label.replace(/[^\w.-]+/g, "-") + ".json"), JSON.stringify(tr, null, 2) + "\n"));
  }
  const out = opt("--out");
  if (!out) { if (emit) return; fail("--out <file.svg> is required"); }
  const series = (opt("--series") ?? "total").split(",") as Series[];
  for (const se of series) if (!(se in SERIES_KEY)) fail("unknown series " + se);
  const xMode = (opt("--x") ?? "time") as "time" | "phase";
  if (xMode !== "time" && xMode !== "phase") fail("--x is time or phase");
  const killRaw = opt("--kill-mb");
  const killMB = killRaw === undefined ? undefined : Number(killRaw);
  if (killRaw !== undefined && !finite(killMB)) fail("--kill-mb must be a number");
  const svg = renderSvg(traces, { title: opt("--title") ?? "Memory over time", series, xMode, killMB, killLabel: opt("--kill-label") });
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, svg);
  console.log("memory-chart: " + out);
  if (!process.argv.includes("--no-png")) {
    const png = out.replace(/\.svg$/i, "") + ".png";
    await writePng(svg, png);
    console.log("memory-chart: " + png);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
