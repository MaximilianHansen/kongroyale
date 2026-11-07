// Reports what a production build makes the browser download, from dist/ after `npm run build`. It fails on a size only
// with --budgets. Sizes are as served: raw, and the .gz / .br files precompress.mjs wrote, counted by the rule
// server/static.ts serves them by (a missing, stale or larger .br falls back to the .gz, and then to the raw file).
//   npx tsx tools/check-size.mts                 (markdown tables on stdout)
//   npx tsx tools/check-size.mts --json sizes.json --dist dist
// JS sizes ignore Vite's content-hash chunk names (see sizeOf), so they do not move when an unrelated chunk is renamed.
// Three views:
// - entry: the module script index.html loads.
// - boot JS: the entry plus every chunk index.html modulepreloads, the JS that must arrive before the game boots.
// - classes: every file in dist/ by what it is. A JS chunk is a worker when another chunk starts it with
//   `new Worker(new URL("/assets/<chunk>.js", ...))`, boot when it is the entry or a modulepreload, else lazy.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { GateError, orExit, parseFlags } from "./gate.mts";

const USAGE = "npx tsx tools/check-size.mts [--dist dist] [--json FILE] [--budgets tools/size-budgets.json]";
const { flags } = orExit("check-size", USAGE, () => parseFlags(process.argv.slice(2), { "--dist": "string", "--json": "string", "--budgets": "string" }));
const dist = path.resolve(flags["--dist"] ?? "dist"), jsonOut = flags["--json"], budgetsFile = flags["--budgets"];
const BUDGET_KEYS = ["entry", "boot", "workers", "lazy"] as const;
const SLACK_PCT = 5;
const budgets = budgetsFile ? orExit("check-size", USAGE, () => {
  if (!fs.existsSync(budgetsFile)) throw new GateError(`${budgetsFile} does not exist`);
  let parsed: { gzBytes?: Record<string, unknown> };
  try { parsed = JSON.parse(fs.readFileSync(budgetsFile, "utf8")); } catch (e) { throw new GateError(`${budgetsFile} is not valid JSON: ${(e as Error).message}`); }
  const b = parsed?.gzBytes;
  if (!b || typeof b !== "object") throw new GateError(`${budgetsFile} must have a gzBytes object`);
  for (const k of Object.keys(b)) if (!(BUDGET_KEYS as readonly string[]).includes(k)) throw new GateError(`${budgetsFile}: unknown budget ${k}; use ${BUDGET_KEYS.join(", ")}`);
  for (const k of BUDGET_KEYS) if (!Number.isInteger(b[k]) || (b[k] as number) < 0) throw new GateError(`${budgetsFile}: gzBytes.${k} must be a whole number of bytes, 0 or more, got ${JSON.stringify(b[k])}`);
  return b as Record<(typeof BUDGET_KEYS)[number], number>;
}) : undefined;
const indexFile = path.join(dist, "index.html");
if (!fs.existsSync(indexFile)) { console.error(`check-size: no ${indexFile}; run npm run build first`); process.exit(2); }
if (jsonOut && (path.resolve(jsonOut) === dist || path.resolve(jsonOut).startsWith(dist + path.sep))) { console.error("check-size: write --json outside the build, or the next run counts the report"); process.exit(2); }

interface Size { raw: number; gz: number; br: number }
// Vite names a chunk by a hash of its content and every importer embeds that name, so changing one chunk changes a few
// bytes of every chunk that imports it, and a gzip of the changed file moves by 1-3 B. JS is therefore measured with every
// 8-character chunk hash replaced by one fixed string (the same length, so raw is unchanged), and compressed here with the
// settings tools/performance/precompress.mjs uses (gzip 9, brotli quality 9) instead of read from its
// sidecar. A file under 1 KB has no sidecar and is served raw, so it keeps the sidecar rule below.
const HASHED_REF = /-[A-Za-z0-9_-]{8}(?=\.(?:js|css)\b)/g;
const sizeOf = (file: string): Size => {
  const original = fs.statSync(file), raw = original.size;
  if (file.endsWith(".js") && raw >= 1024) {
    const data = Buffer.from(fs.readFileSync(file, "utf8").replace(HASHED_REF, "-HHHHHHHH"));
    const brotli = zlib.brotliCompressSync(data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } });
    return { raw, gz: Math.min(zlib.gzipSync(data, { level: 9 }).length, raw), br: Math.min(brotli.length, raw) };
  }
  // the rule server/static.ts serves by: a sidecar only when it is at least as new as the file and smaller
  const packed = (ext: string): number => { const s = fs.existsSync(file + ext) ? fs.statSync(file + ext) : null; return s && s.mtimeMs >= original.mtimeMs && s.size < raw ? s.size : ext === ".br" ? packed(".gz") : raw; };
  return { raw, gz: packed(".gz"), br: packed(".br") };
};
const add = (a: Size, b: Size): Size => ({ raw: a.raw + b.raw, gz: a.gz + b.gz, br: a.br + b.br });
const zero = (): Size => ({ raw: 0, gz: 0, br: 0 });

const files: string[] = [];
const walk = (dir: string) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (!/\.(gz|br)$/.test(e.name)) files.push(p); } };
walk(dist);

const html = fs.readFileSync(indexFile, "utf8");
const entryHref = html.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/)?.[1];
if (!entryHref?.includes("/assets/")) { console.error("check-size: index.html has no module script under assets/"); process.exit(2); }
// URLs carry the deploy base (DEPLOY_BASE, e.g. /kong/assets/...) but Vite writes the files at dist/assets/...
const base = entryHref.slice(0, entryHref.indexOf("/assets/") + 1);
const servedPath = (href: string) => path.join(dist, href.startsWith(base) ? href.slice(base.length) : href.replace(/^\//, ""));
const preloads = [...html.matchAll(/<link[^>]*rel="modulepreload"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
const boot = new Set([entryHref, ...preloads].map(servedPath));

const js = files.filter((f) => f.endsWith(".js"));
const workers = new Set<string>();
for (const f of js) for (const m of fs.readFileSync(f, "utf8").matchAll(/new Worker\(\s*new URL\(\s*["'`]([^"'`]+\.js)["'`]/g)) workers.add(servedPath(m[1]));

const CLASSES: Array<[string, RegExp]> = [
  ["textures", /\.(webp|jpe?g|png|ktx2|avif)$/], ["audio", /\.(ogg|m4a|mp3|flac|wav)$/], ["models", /\.(glb|gltf)$/],
  ["wasm", /\.wasm$/], ["fonts", /\.(woff2?|ttf)$/], ["data", /\.(bin|json|txt|svg)$/], ["html", /\.html$/],
];
const classOf = (f: string) => f.endsWith(".js") ? (boot.has(f) ? "js: boot" : workers.has(f) ? "js: workers" : "js: lazy") : CLASSES.find(([, re]) => re.test(f))?.[0] ?? "other";
const classes = new Map<string, { files: number; size: Size }>();
for (const f of files) { const k = classOf(f), c = classes.get(k) ?? { files: 0, size: zero() }; c.files++; c.size = add(c.size, sizeOf(f)); classes.set(k, c); }
let total = zero(); for (const c of classes.values()) total = add(total, c.size);

const rel = (f: string) => path.relative(dist, f);
const bootRows = [...boot].map((f) => ({ file: rel(f), ...sizeOf(f) })).sort((a, b) => b.gz - a.gz);
const bootTotal = bootRows.reduce((s, r) => add(s, r), zero());
const workerRows = [...workers].filter((f) => fs.existsSync(f)).map((f) => ({ file: rel(f), ...sizeOf(f) })).sort((a, b) => b.raw - a.raw);
const entry = sizeOf(servedPath(entryHref));

const kb = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(2)} MB` : `${(n / 1e3).toFixed(1)} KB`;
const row = (name: string, s: Size, extra = "") => `| ${name} |${extra} ${kb(s.raw)} | ${kb(s.gz)} | ${kb(s.br)} |`;
console.log(`# Download size of ${path.relative(process.cwd(), dist) || "."}\n`);
console.log("| what | raw | gz | br |\n|---|---|---|---|");
console.log(row(`entry ${rel(servedPath(entryHref))}`, entry));
console.log(row(`boot JS (entry + ${preloads.length} modulepreloads)`, bootTotal));
console.log(row(`everything in dist (${files.length} files)`, total));
console.log("\n## Boot JS\n\n| file | raw | gz | br |\n|---|---|---|---|");
for (const r of bootRows) console.log(row(r.file, r));
console.log("\n## By class\n\n| class | files | raw | gz | br |\n|---|---|---|---|---|");
for (const [k, c] of [...classes].sort((a, b) => b[1].size.br - a[1].size.br)) console.log(row(k, c.size, ` ${c.files} |`));
console.log("\n## Worker bundles\n\n| file | raw | gz | br |\n|---|---|---|---|");
for (const r of workerRows) console.log(row(r.file, r));
if (jsonOut) {
  fs.mkdirSync(path.dirname(path.resolve(jsonOut)), { recursive: true });
  fs.writeFileSync(jsonOut, JSON.stringify({ dist, entry: { file: rel(servedPath(entryHref)), ...entry }, boot: { total: bootTotal, files: bootRows },
    classes: Object.fromEntries([...classes].map(([k, c]) => [k, { files: c.files, ...c.size }])), total, workers: workerRows }, null, 2) + "\n");
}
if (budgets) {
  const actual = { entry: entry.gz, boot: bootTotal.gz, workers: classes.get("js: workers")?.size.gz ?? 0, lazy: classes.get("js: lazy")?.size.gz ?? 0 };
  const errors: string[] = [];
  console.log(`\n## Against ${budgetsFile} (gz)\n\n| what | size | budget |\n|---|---|---|`);
  for (const k of BUDGET_KEYS) {
    console.log(`| ${k} | ${actual[k]} | ${budgets[k]} |`);
    if (actual[k] > budgets[k]) errors.push(`${k} JS is ${actual[k]} bytes gz, over its budget of ${budgets[k]}: shrink it; budgets only go down`);
    else if (actual[k] < budgets[k] * (1 - SLACK_PCT / 100)) errors.push(`${k} JS is ${actual[k]} bytes gz, more than ${SLACK_PCT}% under its budget of ${budgets[k]}: lower gzBytes.${k} in ${budgetsFile} to ${Math.ceil(actual[k] * 1.01)} so the saving stays`);
  }
  if (errors.length) { console.error(`\ncheck-size FAILED:\n  ${errors.join("\n  ")}`); process.exitCode = 1; }
  else console.log(`\nOK: every size is within its budget in ${budgetsFile}.`);
}
