// Client boot check without a GPU. Builds the production client, serves dist/ from the real server on a local port,
// loads the game in headless Chromium on SwiftShader (software WebGL), waits for the title to become playable
// (window.__kr.ready) and then plays a short seed-42 practice match against bots. Exits 1 if the boot or the match
// fails; nothing here needs a GPU, a network or a database.
//
//   npx tsx tools/verify-boot.mts [--no-build] [--port 3027] [--boot-timeout 600] [--match 45] [--mode trios]
//                                 [--splat] [--chrome PATH] [--shot FILE]
//   --no-build        reuse the existing dist/ (default: run `npm run build` first)
//   --port N          local port for the server (default 3027; it binds 127.0.0.1 only)
//   --boot-timeout S  seconds allowed from page load to __kr.ready (default 600)
//   --match S         wall seconds to watch the practice match once it has started; 0 skips the match (default 45).
//                     Starting it (island prepare + loot spots) is allowed another --boot-timeout on top
//   --mode solo|trios practice mode (default trios). The match seed is always 42 (?seed=42)
//   --splat           keep the gaussian-splat far trees. By default the page loads with ?vegsplat=0 (the impostor cards,
//                     an A/B switch the game already has). On SwiftShader the splat bake alone takes ~130 s, and the
//                     veg-impostors hold it keeps must clear within the fixed 90 s settle budget in client/src/main.ts.
//                     Whether it fits depends on when the bake starts relative to settle, so with --splat the boot is a
//                     coin toss on software GL ("timed out waiting for: veg-impostors"): 2 of 3 runs on 4 vCPU failed.
//   --chrome PATH     Chromium or Chrome binary (also KR_CHROME). Default: Playwright's own (`npx playwright install chromium`)
//   --shot FILE       screenshot at the end (default shots/verify-boot.png; shots/ is gitignored)
//   --query "a=1&b=2" extra URL flags (e.g. hostworker=1: the practice host in its worker, which must then be the one
//                     playing: __kr.hostWorker set, a fall back to the in-tab host fails the run)
//
// Fails on: any entry in window.__kr.errors, any uncaught page error, the boot reaching stage "failed" or not reaching
// ready in time, and a match that never starts, whose tick never advances, or with one player or fewer alive.
// Console warnings, and console.error lines that never reach __kr.errors, are printed or counted but don't fail the run.
//
// The browser only ever loads the server this script starts on 127.0.0.1 (AGENTS.md rule 7).
// A full run (build, boot, 45 s of match) takes about 5 min and 3 GB of RAM on a 4-vCPU cloud machine; the boot alone
// is about 165 s of that, nearly all of it SwiftShader.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { oneOf, orExit, parseFlags } from "./gate.mts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "npx tsx tools/verify-boot.mts [--no-build] [--port 3027] [--boot-timeout 600] [--match 45] [--mode trios|solo] [--splat] [--chrome PATH] [--shot FILE] [--query a=1&b=2]";
const { flags } = orExit("verify-boot", USAGE, () => parseFlags(process.argv.slice(2), {
  "--no-build": "bool", "--port": "number", "--boot-timeout": "number", "--match": "number", "--mode": "string", "--splat": "bool", "--chrome": "string", "--shot": "string", "--query": "string",
}));
const flag = (k: "--no-build" | "--splat") => !!flags[k];

const PORT = flags["--port"] ?? 3027;
const BOOT_TIMEOUT_MS = (flags["--boot-timeout"] ?? 600) * 1000;
const MATCH_S = flags["--match"] ?? 45;
const MODE = orExit("verify-boot", USAGE, () => oneOf(flags["--mode"] ?? "trios", ["trios", "solo"] as const, "--mode"));
const CHROME = flags["--chrome"] ?? (process.env.KR_CHROME || undefined);
const SHOT = path.resolve(root, flags["--shot"] ?? "shots/verify-boot.png");
const ORIGIN = `http://127.0.0.1:${PORT}`;
const QUERY = flags["--query"] ?? "";
const URL_PATH = `/?debug&seed=42${flag("--splat") ? "" : "&vegsplat=0"}${QUERY ? "&" + QUERY : ""}`;
const PHASES = ["warmup", "plane", "play", "results"];

const T0_MS = Date.now();
const log = (msg: string) => console.log(`${((Date.now() - T0_MS) / 1000).toFixed(1).padStart(6)}s  ${msg}`);
const failures: string[] = [];
const fail = (msg: string) => { failures.push(msg); log(`FAIL ${msg}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: ChildProcess | null = null;
const stopServer = () => { if (server && server.exitCode === null) server.kill("SIGTERM"); };
process.on("exit", stopServer);
process.on("SIGINT", () => process.exit(130));

// ---- build
if (!flag("--no-build")) {
  log("npm run build");
  const b = spawnSync("npm", ["run", "build"], { cwd: root, stdio: ["ignore", "ignore", "inherit"], shell: process.platform === "win32" });
  if (b.status !== 0) { log(`FAIL build exited ${b.status}`); process.exit(1); }
  log("build done");
} else if (!fs.existsSync(path.join(root, "dist/index.html"))) {
  log("FAIL --no-build, but dist/index.html is missing"); process.exit(1);
}

// ---- server: the production entry point (what `npm start` runs), loopback only
async function up() { try { return (await fetch(ORIGIN + "/", { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } }
if (await up()) { log(`FAIL something already answers on ${ORIGIN}; pick another --port`); process.exit(1); }
const serverLog: string[] = [];
server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
  cwd: root, env: { ...process.env, KR_SERVE: "1", KR_PORT: String(PORT), KR_HOST: "127.0.0.1" }, stdio: ["ignore", "pipe", "pipe"],
});
for (const s of [server.stdout!, server.stderr!]) s.on("data", (d: Buffer) => serverLog.push(...d.toString().split("\n").filter(Boolean)));
for (let i = 0; !(await up()); i++) {
  if (server.exitCode !== null || i > 60) { log(`FAIL the server did not come up:\n${serverLog.slice(-20).join("\n")}`); process.exit(1); }
  await sleep(500);
}
log(`server up on ${ORIGIN}`);

// ---- browser: SwiftShader through ANGLE (software WebGL2)
let browser: Browser;
try {
  browser = await chromium.launch({ executablePath: CHROME, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
} catch (e) {
  log(`FAIL launching Chromium: ${(e as Error).message.split("\n")[0]}. Run \`npx playwright install chromium\` or pass --chrome`);
  process.exit(1);
}
const page: Page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const pageErrors: string[] = [];
let consoleErrors = 0, consoleWarnings = 0;
page.on("pageerror", (e) => { pageErrors.push(e.message); fail(`page error: ${e.message}`); });
page.on("console", (m) => {
  if (m.type() === "warning") consoleWarnings++;
  if (m.type() === "error") { consoleErrors++; log(`console.error ${m.text().slice(0, 400)}`); }
});

const readKr = () => page.evaluate(() => {
  const k = (window as unknown as { __kr?: { stage?: string; ready?: boolean; errors?: string[]; engine?: { pendingHolds?: () => string[] } } }).__kr;
  return k ? { stage: k.stage ?? "", ready: !!k.ready, errors: k.errors?.slice() ?? [], holds: k.engine?.pendingHolds?.() ?? [] } : null;
});
type MatchState = { phase: number; time: number; alive: number; squads: number; tick: number };
// (tick is the newest snapshot tick from the offline host, in this tab or in its worker: it advances in every phase,
// warm-up included, while time only runs in the plane and play phases)
const readMatch = () => page.evaluate(() => {
  const g = (window as unknown as { __kr: { game?: { inMatch: boolean; state: () => Omit<MatchState, "tick"> | null; cm?: { snapTick: () => number } | null } } }).__kr.game;
  const s = g?.inMatch ? g.state() : null;
  return s ? { ...s, tick: g?.cm?.snapTick() ?? -1 } : null;
});

let exitCode = 1;
try {
  log(`open ${ORIGIN}${URL_PATH}`);
  await page.goto(ORIGIN + URL_PATH, { waitUntil: "load", timeout: 120_000 });
  const bootT0 = Date.now();
  const gl = await page.evaluate(() => {
    const c = document.createElement("canvas").getContext("webgl2");
    const ext = c?.getExtension("WEBGL_debug_renderer_info");
    return c ? String(ext ? c.getParameter(ext.UNMASKED_RENDERER_WEBGL) : c.getParameter(c.RENDERER)) : "no WebGL2";
  });
  log(`WebGL renderer: ${gl}`);

  // ---- boot: log every stage change until ready, failed or the timeout
  let state: Awaited<ReturnType<typeof readKr>> = null, lastStage = "";
  for (;;) {
    state = await readKr();
    if (state && state.stage !== lastStage) { lastStage = state.stage; log(`stage ${lastStage}${state.holds.length ? `  (holds: ${state.holds.join(", ")})` : ""}`); }
    const late = Date.now() - bootT0 > BOOT_TIMEOUT_MS;
    if (!late && (state?.ready || state?.stage === "failed" || pageErrors.length)) break;
    if (late) { if (state) state.ready = false; fail(`not ready after ${BOOT_TIMEOUT_MS / 1000} s (stage ${lastStage}, holds: ${state?.holds.join(", ") || "none"})`); break; }
    await sleep(1000);
  }
  for (const e of state?.errors ?? []) fail(`__kr.errors: ${e.split("\n")[0]}`);
  if (state?.ready) log(`READY ${((Date.now() - bootT0) / 1000).toFixed(1)} s after load`);
  else if (state?.stage === "failed") fail("boot failed (the page shows \"The island couldn't load\")");

  // ---- a short practice match: seed 42 from the URL, bots, the real offline host running in the page
  if (state?.ready && !failures.length && MATCH_S > 0) {
    log(`practice ${MODE}, seed 42, watching for ${MATCH_S} s`);
    // (practice() resolves only after the island prepare: fire it without waiting so the deadline below covers that too)
    const startT0 = Date.now();
    await page.evaluate((mode) => { void (window as unknown as { __kr: { game: { practice: (m: string) => unknown } } }).__kr.game.practice(mode); }, MODE);
    let first: MatchState | null = null;
    while (!(first = await readMatch()) && Date.now() - startT0 < BOOT_TIMEOUT_MS && !pageErrors.length) await sleep(1000);
    if (first) log(`match started ${((Date.now() - startT0) / 1000).toFixed(1)} s after Play`);
    const matchT0 = Date.now();
    let last = first, lastPhase = -1;
    while (first && Date.now() - matchT0 < MATCH_S * 1000 && !pageErrors.length) {
      const s = await readMatch();
      if (s) {
        last = s;
        if (s.phase !== lastPhase) { lastPhase = s.phase; log(`match phase ${PHASES[s.phase] ?? s.phase}  t=${s.time.toFixed(1)} s  alive=${s.alive}  squads=${s.squads}`); }
      }
      await sleep(2000);
    }
    if (!first || !last) fail(`the practice match did not start within ${BOOT_TIMEOUT_MS / 1000} s`);
    else {
      const ticks = last.tick - first.tick;
      log(`match advanced ${ticks} ticks (clock ${(last.time - first.time).toFixed(1)} s) in ${MATCH_S} s of wall time; phase ${PHASES[last.phase] ?? last.phase}, alive=${last.alive}, squads=${last.squads}`);
      if (!(ticks > 0)) fail("the match did not advance");
      if (!(last.alive > 1)) fail(`only ${last.alive} player(s) alive`);
    }
    if (/(^|&)hostworker=1(&|$)/.test(QUERY)) {
      const hw = await page.evaluate(() => { const h = (window as unknown as { __kr: { hostWorker?: { buildMs: number; busyMs: number } } }).__kr.hostWorker; return h ? { buildMs: h.buildMs, busyMs: Math.round(h.busyMs) } : null; });
      if (hw) log(`the host ran in its worker: world built in ${hw.buildMs} ms, ${hw.busyMs} ms of host pumps there`);
      else fail("?hostworker=1, but the practice host did not run in its worker");
    }
    for (const e of (await readKr())?.errors ?? []) fail(`__kr.errors after the match: ${e.split("\n")[0]}`);
  }
  fs.mkdirSync(path.dirname(SHOT), { recursive: true });
  await page.screenshot({ path: SHOT }).then(() => log(`screenshot ${path.relative(root, SHOT)}`), () => log("screenshot failed"));
  exitCode = failures.length ? 1 : 0;
} catch (e) {
  fail(`harness: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  await browser.close().catch(() => {});
  stopServer();
}
log(`console: ${consoleErrors} errors, ${consoleWarnings} warnings (not failures)`);
log(exitCode === 0 ? "PASS" : `FAIL (${new Set(failures).size}):\n  ${[...new Set(failures)].join("\n  ")}`);
process.exit(exitCode);
