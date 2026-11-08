// Visual diffs on SwiftShader, from a local production build: fixed views (client/src/engine/views.ts) captured with
// ?shot=1 (frozen time, pixel ratio 1, HUD hidden) and ?atmos=notaa (the TAA jitter moves every edge each frame, so a
// still with TAA on never repeats), then compared pixel by pixel. The visual workflow (.github/workflows/visual.yml)
// captures main and the PR on one runner and reports the share of pixels that differ per
// view, with before | after | diff images, and how far each baked far impostor (public/assets/far) is from the POI it
// stands in for. Software rendering, so it judges what a frame shows, never how fast it draws.
//   npx tsx tools/performance/visual.mts capture --url http://127.0.0.1:3140 --out DIR [--views a,b] [--size 480x270]
//   npx tsx tools/performance/visual.mts diff --base DIR --cand DIR --out DIR [--threshold 0.1] [--max-pct 0.5]
//   npx tsx tools/performance/visual.mts far --url http://127.0.0.1:3140 --out DIR [--pois a,b] [--size 480x270]
// diff writes <out>/<view>.png (before | after | changed pixels in red), summary.json and summary.md, and exits 1 when
// a view differs in more than --max-pct percent of its pixels, or a capture is missing on one side. far boots one page
// with the POI built and one with only its impostor (__kr.showImpostors) from the same camera, writes <out>/<poi>.png
// (built | impostor | diff), summary.json and summary.md, and never fails on the numbers: they are a report.
// Only local servers (AGENTS.md rule 7): capture and far refuse any host but 127.0.0.1 / localhost.
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";
import sharp from "sharp";
import { POIS } from "../../shared/world/map";

/** The views a PR is judged on: the lobby islet, which the title modules build. A whole-island view needs more than a
 * 4 vCPU runner can software-render in time. */
export const VIEWS = ["char-02-lobby-island", "wip-lobby-tiki", "wip-lobby-dock", "wip-lobby-top", "wip-lobby-plane", "wip-lobby-rock"];
/** the title modules, the same set the CI memory jobs build */
const MODULES = "atmos,terrain,water,veg,poi:lobby-islet,showcase,weapons-showcase,gameplay-stage";
/** a far comparison builds the ground and sea around one POI, like tools/world/bake-far.mts */
const FAR_MODULES = "atmos,terrain,water";
/** the far camera: bake-far's direction (from the island centre out past the POI), FAR_DIST_M out and FAR_UP_M up,
 * with a lens that fits FAR_FIT times the POI's radius */
const FAR_DIST_M = 800, FAR_UP_M = 250, FAR_FIT = 1.6, BUILD_TIMEOUT_MS = 900_000;
/** after a view change, a frame is taken every SETTLE_MS until two in a row match, at most SETTLE_FRAMES. Frames match
 * when no channel moves more than SAME_LEVELS: with TAA off, a still frame changes by up to 2 levels a frame (the post
 * chain's per-frame dither) */
const SETTLE_MS = 3000, SETTLE_FRAMES = 20, SAME_LEVELS = 8;
const LAUNCH = { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] };

const argv = process.argv.slice(2), cmd = argv[0];
const opt = (k: string, d: string) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const raw = (f: Buffer | string) => sharp(f).removeAlpha().raw().toBuffer({ resolveWithObject: true });

function localUrl() {
  const url = new URL(opt("--url", "http://127.0.0.1:3140"));
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw Error(`capture only local servers, not ${url.hostname}`);
  return url;
}

async function same(a: Buffer, b: Buffer) {
  const [ra, rb] = await Promise.all([raw(a), raw(b)]);
  if (ra.data.length !== rb.data.length) return false;
  for (let i = 0; i < ra.data.length; i++) if (Math.abs(ra.data[i] - rb.data[i]) > SAME_LEVELS) return false;
  return true;
}

/** frames SETTLE_MS apart until two match (streamed vegetation cells land and grow in after a camera move); a view
 * that never settles is kept and marked */
async function settle(page: Page): Promise<{ shot: Buffer; settled: boolean }> {
  let last: Buffer | null = null;
  for (let frames = 0; frames < SETTLE_FRAMES; frames++) {
    await page.waitForTimeout(SETTLE_MS);
    // the widest lobby view (char-02-lobby-island) takes over 2 minutes per frame on a 4 vCPU runner
    const shot = await page.screenshot({ type: "png", timeout: 300_000 });
    if (last && await same(last, shot)) return { shot, settled: true };
    last = shot;
  }
  return { shot: last!, settled: false };
}

/** share of pixels whose largest channel difference passes `threshold` (0-1), and an a | b | changed-in-red image */
async function compare(a: string, b: string, file: string, threshold: number): Promise<number | null> {
  const [ra, rb] = await Promise.all([raw(a), raw(b)]);
  if (ra.info.width !== rb.info.width || ra.info.height !== rb.info.height) return null;
  const { width, height } = ra.info, px = width * height, mask = Buffer.alloc(px * 3);
  let changed = 0;
  for (let i = 0; i < px; i++) {
    const d = Math.max(Math.abs(ra.data[i * 3] - rb.data[i * 3]), Math.abs(ra.data[i * 3 + 1] - rb.data[i * 3 + 1]), Math.abs(ra.data[i * 3 + 2] - rb.data[i * 3 + 2])) / 255;
    const grey = (rb.data[i * 3] + rb.data[i * 3 + 1] + rb.data[i * 3 + 2]) / 9;
    if (d > threshold) { changed++; mask[i * 3] = 255; } else mask.fill(grey, i * 3, i * 3 + 3);
  }
  await sharp({ create: { width: width * 3 + 16, height, channels: 3, background: "#111" } })
    .composite([{ input: a, left: 0, top: 0 }, { input: b, left: width + 8, top: 0 }, { input: mask, raw: { width, height, channels: 3 }, left: width * 2 + 16, top: 0 }])
    .png().toFile(file);
  return (changed / px) * 100;
}

async function capture() {
  const url = localUrl(), out = path.resolve(opt("--out", "shots/visual")), views = opt("--views", VIEWS.join(",")).split(",");
  const [w, h] = opt("--size", "480x270").split("x").map(Number);
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch(LAUNCH);
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
  const result: Record<string, { file?: string; ms: number; errors: string[] }> = {};
  // one boot for every view (__kr.setView moves the camera, stages the scene and freezes its time): a boot on
  // SwiftShader takes about 1.5 minutes on 4 vCPUs, a view change under one
  const t0 = Date.now();
  try {
    await page.goto(`${url.origin}/?view=${encodeURIComponent(views[0])}&shot=1&seed=42&vegsplat=0&atmos=notaa&modules=${encodeURIComponent(opt("--modules", MODULES))}`, { waitUntil: "load", timeout: 300_000 });
    await page.waitForFunction(() => (window as any).__kr?.ready === true, null, { timeout: 300_000, polling: 250 });
  } catch (e) {
    // a boot that never gets ready still leaves a manifest, so the diff has a row for every view it was asked for
    for (const view of views) { fs.rmSync(path.join(out, `${view}.png`), { force: true }); result[view] = { ms: Date.now() - t0, errors: [`boot: ${String(e).split("\n")[0]}`, ...errors] }; }
    await browser.close();
    fs.writeFileSync(path.join(out, "capture.json"), JSON.stringify(result, null, 2) + "\n");
    process.exitCode = 1;
    return;
  }
  console.log(`booted in ${Date.now() - t0} ms`);
  // __kr.errors holds what the game caught itself (a module that failed to build still reaches ready): the boot's go
  // to the first view, each later one to the view it happened in
  const krErrors = async (): Promise<string[]> => await page.evaluate(() => (window as any).__kr.errors ?? []).catch(() => []);
  let krSeen = 0;
  for (const view of views) {
    const t1 = Date.now(), before = errors.length, png = path.join(out, `${view}.png`);
    fs.rmSync(png, { force: true });
    let errs: string[], file: string | undefined;
    try {
      await page.evaluate((id) => (window as any).__kr.setView(id), view);
      const { shot, settled } = await settle(page);
      fs.writeFileSync(png, shot);
      file = `${view}.png`;
      errs = settled ? [] : [`still changing after ${SETTLE_FRAMES} frames`];
    } catch (e) {
      errs = [String(e).split("\n")[0]];
    }
    const kr = await krErrors();
    errs.push(...errors.slice(before), ...kr.slice(krSeen).map((e) => String(e).slice(0, 300)));
    krSeen = kr.length;
    result[view] = { ...(file ? { file } : {}), ms: Date.now() - t1, errors: errs };
    console.log(view, JSON.stringify(result[view]));
  }
  await browser.close();
  fs.writeFileSync(path.join(out, "capture.json"), JSON.stringify(result, null, 2) + "\n");
  if (Object.values(result).some((r) => !r.file)) process.exitCode = 1;
}

async function diff() {
  const baseDir = opt("--base", ""), candDir = opt("--cand", ""), out = path.resolve(opt("--out", "shots/visual/diff"));
  const threshold = Number(opt("--threshold", "0.1")), maxPct = Number(opt("--max-pct", "0.5"));
  if (!baseDir || !candDir) throw Error("diff needs --base DIR and --cand DIR");
  fs.mkdirSync(out, { recursive: true });
  // every view either capture was asked for (capture.json), plus any image without one, so a view both sides failed
  // still gets a row
  const manifest = (d: string): Record<string, { file?: string; errors: string[] }> => {
    const f = path.join(d, "capture.json");
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
  };
  const ma = manifest(baseDir), mb = manifest(candDir);
  const pngs = [baseDir, candDir].flatMap((d) => fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith(".png")).map((f) => f.replace(/\.png$/, "")) : []);
  const views = [...new Set([...Object.keys(ma), ...Object.keys(mb), ...pngs])].sort();
  const rows: Array<{ view: string; pct: number | null; note: string }> = [];
  for (const view of views) {
    const a = path.join(baseDir, `${view}.png`), b = path.join(candDir, `${view}.png`);
    const failed = [["main", ma[view]], ["PR", mb[view]]].filter(([, m]) => m && (m as { errors: string[] }).errors.length).map(([side]) => side);
    const errNote = failed.length ? `capture errors on ${failed.join(" and ")} (capture.json)` : "";
    if (!fs.existsSync(a) || !fs.existsSync(b)) {
      const missing = [!fs.existsSync(a) && "main", !fs.existsSync(b) && "PR"].filter(Boolean).join(" and ");
      rows.push({ view, pct: null, note: [`missing on ${missing}`, errNote].filter(Boolean).join("; ") });
      continue;
    }
    const pct = await compare(a, b, path.join(out, `${view}.png`), threshold);
    rows.push({ view, pct, note: [pct === null ? "sizes differ" : pct > maxPct ? `over ${maxPct}%` : "", errNote].filter(Boolean).join("; ") });
  }
  const md = [`| view | pixels changed | |`, `|---|---:|---|`, ...rows.map((r) => `| ${r.view} | ${r.pct === null ? "" : r.pct.toFixed(3) + "%"} | ${r.note} |`)].join("\n") + "\n";
  fs.writeFileSync(path.join(out, "summary.json"), JSON.stringify({ threshold, maxPct, rows }, null, 2) + "\n");
  fs.writeFileSync(path.join(out, "summary.md"), md);
  process.stdout.write(md);
  if (!rows.length || rows.some((r) => r.note)) process.exitCode = 1;
}

async function far() {
  const url = localUrl(), out = path.resolve(opt("--out", "shots/visual/far")), threshold = Number(opt("--threshold", "0.1"));
  const index = JSON.parse(fs.readFileSync("public/assets/far/index.json", "utf8")) as { pois: Record<string, unknown> };
  const ids = opt("--pois", Object.keys(index.pois).join(",")).split(",");
  const [w, h] = opt("--size", "480x270").split("x").map(Number);
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch(LAUNCH);
  const rows: Array<{ poi: string; pct: number | null; note: string }> = [];
  for (const id of ids) {
    const p = POIS.find((q) => q.id === id);
    if (!p) { rows.push({ poi: id, pct: null, note: "not in shared/world/map.ts" }); continue; }
    const len = Math.hypot(p.x, p.z) || 1, dx = p.x / len, dz = p.z / len, y = p.padY ?? 0;
    const fov = (2 * Math.atan((p.r * FAR_FIT) / Math.hypot(FAR_DIST_M, FAR_UP_M - 20)) * 180) / Math.PI;
    const cam = [p.x + dx * FAR_DIST_M, y + FAR_UP_M, p.z + dz * FAR_DIST_M, p.x, y + 20, p.z, fov].map((v) => v.toFixed(1)).join(",");
    const notes: string[] = [];
    for (const side of ["built", "impostor"] as const) {
      fs.rmSync(path.join(out, `${id}.${side}.png`), { force: true });
      const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
      const t0 = Date.now();
      try {
        const modules = side === "built" ? `${FAR_MODULES},poi:${id}` : FAR_MODULES;
        await page.goto(`${url.origin}/?cam=${cam}&shot=1&seed=42&atmos=notaa&noocc&modules=${encodeURIComponent(modules)}`, { waitUntil: "load", timeout: 300_000 });
        await page.waitForFunction(() => (window as any).__kr?.ready === true, null, { timeout: BUILD_TIMEOUT_MS, polling: 1000 });
        await page.evaluate(() => (window as any).__kr.showImpostors());
        const { shot, settled } = await settle(page);
        fs.writeFileSync(path.join(out, `${id}.${side}.png`), shot);
        const krErrors = await page.evaluate(() => (window as any).__kr.errors ?? []) as string[];
        if (!settled) notes.push(`${side} still changing`);
        if (krErrors.length || errors.length) notes.push(`${side}: ${[...krErrors, ...errors].join(" | ").slice(0, 200)}`);
        console.log(`${id} ${side}: ${Date.now() - t0} ms`);
      } catch (e) {
        notes.push(`${side}: ${String(e).split("\n")[0].slice(0, 200)}`);
      }
      await page.close();
    }
    const a = path.join(out, `${id}.built.png`), b = path.join(out, `${id}.impostor.png`);
    const pct = fs.existsSync(a) && fs.existsSync(b) ? await compare(a, b, path.join(out, `${id}.png`), threshold) : null;
    rows.push({ poi: id, pct, note: notes.join("; ") });
    console.log(id, JSON.stringify(rows[rows.length - 1]));
  }
  await browser.close();
  const md = [`| far impostor | pixels unlike the built POI | |`, `|---|---:|---|`, ...rows.map((r) => `| ${r.poi} | ${r.pct === null ? "" : r.pct.toFixed(2) + "%"} | ${r.note} |`)].join("\n") + "\n";
  fs.writeFileSync(path.join(out, "summary.json"), JSON.stringify({ threshold, rows }, null, 2) + "\n");
  fs.writeFileSync(path.join(out, "summary.md"), md);
  process.stdout.write(md);
}

if (cmd === "capture") await capture();
else if (cmd === "diff") await diff();
else if (cmd === "far") await far();
else { console.log("usage: visual.mts capture --url http://127.0.0.1:PORT --out DIR | diff --base DIR --cand DIR --out DIR | far --url http://127.0.0.1:PORT --out DIR"); process.exitCode = cmd === "help" ? 0 : 2; }
