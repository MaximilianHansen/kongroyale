#!/usr/bin/env node
// Real-GPU captures (headless Chromium on ANGLE/Metal, not SwiftShader).
//
//   node tools/shot.mjs poi-01-peel-harbor biome-01-beach      capture views → shots/latest/<view>.png
//   node tools/shot.mjs --all                                   every view with a reference image in refs/ (optional:
//                                                               your own refs/<view>.png files; not part of the repo)
//   options:
//     --4k                 3840x2160 (default 2560x1440)       --w N --h N   custom size
//     --out DIR            write here instead of shots/latest (use a private dir while iterating)
//     --compare            also write <out>/compare/<view>.png: refs/<view>.png | game side by side (1280x720 each)
//     --bench              GPU-bound frame timing at the view (__kr.bench) → printed + manifest
//     --modules a,b        build only these modules        --q ultra|high|medium|low
//     --cam x,y,z,tx,ty,tz[,fov]   ad-hoc camera (file name = --name, default "cam")
//     --t SECONDS          freeze animation time           --fly-free   (ignored; for humans)
//     --timeout SECONDS    per view (default 240)
// Prints one JSON line per view: { view, file, compare, ms, bench, errors }.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// the dev server to capture (started on this port if nothing answers there); KR_SHOT_PORT picks another port
const PORT = Number(process.env.KR_SHOT_PORT) || 5317, ORIGIN = `http://localhost:${PORT}`;
const argv = process.argv.slice(2);
const flag = (k) => argv.includes(k);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const OPT_KEYS = new Set(["--w", "--h", "--out", "--modules", "--q", "--cam", "--name", "--t", "--timeout"]);
const positional = argv.filter((a, i) => !a.startsWith("--") && !OPT_KEYS.has(argv[i - 1]));

const is4k = flag("--4k");
const W = Number(opt("--w", is4k ? 3840 : 2560)), H = Number(opt("--h", is4k ? 2160 : 1440));
const outDir = path.resolve(root, opt("--out", "shots/latest"));
const timeout = Number(opt("--timeout", 240)) * 1000;

async function up() { try { const r = await fetch(ORIGIN + "/", { signal: AbortSignal.timeout(3000) }); return r.ok; } catch { return false; } }
async function ensureServer() {
  if (await up()) return;
  fs.mkdirSync(path.join(root, "shots"), { recursive: true });
  const log = fs.openSync(path.join(root, "shots", "vite.log"), "a");
  const args = ["--host", "--port", String(PORT)];
  const [cmd, cmdArgs] = process.platform === "win32" ? [process.execPath, [path.join(root, "node_modules/vite/bin/vite.js"), ...args]] : [path.join(root, "node_modules/.bin/vite"), args];
  spawn(cmd, cmdArgs, { cwd: root, detached: true, windowsHide: true, stdio: ["ignore", log, log] }).unref();
  for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 500)); if (await up()) return; }
  throw new Error(`dev server did not come up on ${PORT} (see shots/vite.log)`);
}

function viewsFromRefs() {
  if (!fs.existsSync(path.join(root, "refs"))) {
    console.error("--all needs a refs/ folder of reference images (refs/<view>.png). Name the views to capture instead, e.g. node tools/shot.mjs biome-01-beach");
    process.exit(2);
  }
  return fs.readdirSync(path.join(root, "refs")).filter((f) => f.endsWith(".png")).map((f) => f.replace(/\.png$/, "")).sort();
}

async function compare(view, gameFile, dest) {
  const ref = path.join(root, "refs", `${view}.png`);
  if (!fs.existsSync(ref)) return null;
  const cw = 1280, ch = 720, pad = 34;
  const lab = (t) => Buffer.from(`<svg width="${cw}" height="${pad}"><rect width="100%" height="100%" fill="#111"/><text x="12" y="23" font-family="Helvetica" font-weight="700" font-size="18" fill="#ffd23a">${t}</text></svg>`);
  const a = await sharp(ref).resize(cw, ch, { fit: "cover" }).toBuffer();
  const b = await sharp(gameFile).resize(cw, ch, { fit: "cover" }).toBuffer();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await sharp({ create: { width: cw * 2 + 8, height: ch + pad, channels: 3, background: "#111" } })
    .composite([
      { input: lab(`REFERENCE  ${view}`), left: 0, top: 0 }, { input: a, left: 0, top: pad },
      { input: lab(`GAME  ${new Date().toISOString().slice(0, 16)}`), left: cw + 8, top: 0 }, { input: b, left: cw + 8, top: pad },
    ]).png().toFile(dest);
  return dest;
}

function updateManifest(entry) {
  if (outDir !== path.join(root, "shots/latest")) return;
  const f = path.join(root, "shots/manifest.json");
  let m = {};
  try { m = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
  m[entry.view] = entry;
  fs.writeFileSync(f, JSON.stringify(m, null, 2));
}

const views = flag("--all") ? viewsFromRefs() : positional;
const camArg = opt("--cam");
if (!views.length && !camArg) { console.error("usage: node tools/shot.mjs <view...> | --all | --cam x,y,z,tx,ty,tz[,fov] [--4k] [--compare] [--bench] [--out dir]"); process.exit(2); }

await ensureServer();
fs.mkdirSync(outDir, { recursive: true });
// the GPU-slot wrapper (Linux, shared machines) when present, else KR_CHROME, else Playwright's own Chromium; the
// graphics backend follows the platform (Vulkan on Linux, Metal on macOS, the default elsewhere)
const slot = new URL("lib/chromium-slot.sh", import.meta.url).pathname;
const angle = process.platform === "linux" ? ["--use-angle=vulkan", "--enable-features=Vulkan"] : process.platform === "darwin" ? ["--use-angle=metal"] : [];
const executablePath = process.env.KR_CHROME || (fs.existsSync(slot) ? slot : undefined);
const browser = await chromium.launch({ executablePath, channel: !executablePath && process.platform === "win32" ? "chrome" : undefined, timeout: 0,
  headless: true,
  args: [...angle, "--enable-gpu", "--ignore-gpu-blocklist", "--enable-gpu-rasterization", "--disable-gpu-driver-bug-workarounds", "--autoplay-policy=no-user-gesture-required"],
});
const jobs = camArg ? [{ view: opt("--name", "cam"), qs: `cam=${camArg}` }] : views.map((v) => ({ view: v, qs: `view=${encodeURIComponent(v)}` }));
let failed = 0;
for (const job of jobs) {
  const t0 = Date.now();
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 400)); });
  page.on("pageerror", (e) => consoleErrors.push(String(e).slice(0, 400)));
  const params = [job.qs, "shot=1"];
  if (opt("--modules")) params.push(`modules=${opt("--modules")}`);
  if (opt("--q")) params.push(`q=${opt("--q")}`);
  if (opt("--t")) params.push(`t=${opt("--t")}`);
  const res = { view: job.view, file: null, compare: null, ms: 0, bench: null, errors: [] };
  try {
    await page.goto(`${ORIGIN}/?${params.join("&")}`, { waitUntil: "load", timeout });
    await page.waitForFunction(() => window.__kr?.ready === true, null, { timeout, polling: 250 });
    const file = path.join(outDir, `${job.view}.png`);
    // a broken file elsewhere makes vite broadcast an error overlay to every page — never let it into a capture
    await page.evaluate(() => document.querySelectorAll("vite-error-overlay").forEach((el) => el.remove())).catch(() => {});
    await page.screenshot({ path: file, type: "png" });
    res.file = path.relative(root, file);
    if (flag("--bench")) res.bench = await page.evaluate(async () => ({ ...(await window.__kr.bench(90)), info: window.__kr.info(), buildMs: window.__kr.buildMs, terrainMs: window.__kr.terrainMs }));
    if (flag("--compare")) res.compare = path.relative(root, (await compare(job.view, file, path.join(outDir, "compare", `${job.view}.png`))) ?? "") || null;
    res.errors = (await page.evaluate(() => window.__kr.errors)).concat(consoleErrors);
  } catch (e) {
    failed++;
    const stage = await page.evaluate(() => window.__kr?.stage).catch(() => "?");
    res.errors = [`capture failed at stage=${stage}: ${String(e).split("\n")[0]}`, ...consoleErrors];
  }
  res.ms = Date.now() - t0;
  res.when = new Date().toISOString();
  updateManifest(res);
  console.log(JSON.stringify(res));
  await page.close();
}
await browser.close();
try { await import("./gallery.mjs"); } catch {}
process.exit(failed ? 1 : 0);
