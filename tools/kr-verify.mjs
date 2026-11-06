#!/usr/bin/env node
// Verification harness: starts an isolated dev client + game server, checks that they are worth
// driving, and plays Kong Royale through a real browser the way a player does (title, Play vs bots, Firing range, a
// two-player private lobby), writing screenshots and a result.json per run. Works on macOS, Windows and Linux.
//
//   node tools/kr-verify.mjs up            start client :5417 + server :3120
//   node tools/kr-verify.mjs doctor        is this instance worth driving?
//   node tools/kr-verify.mjs boot|play|range|room|all [options]
//   node tools/kr-verify.mjs down          stop what `up` started (evidence stays)
//
// options: --profile mac|win|nogpu (default: from the OS)  --seed N (default 42)  --secs N (play length, default 60)
//          --out DIR (default shots/verify/<run-id>)  --headed  --web PORT  --port PORT  --prod (up: serve dist/)
//          --splat (nogpu: keep the far-tree splat bake, which can exceed the 90 s settle budget)
//          --channel chrome|msedge|chromium  --url URL (drive an instance you started yourself; skips the state file)
// Exit code 0 = every check in the command passed. Each drive prints one JSON line and writes <out>/result.json.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const argv = process.argv.slice(2);
const cmd = argv[0] ?? "help";
const flag = (k) => argv.includes(k);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };

const STATE = path.join(root, "shots", "verify", ".instance.json");
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return null; } };
const state = readState();
const WEB_PORT = Number(opt("--web", state?.web ?? process.env.KR_VERIFY_WEB ?? 5417));
const GAME_PORT = Number(opt("--port", state?.port ?? process.env.KR_VERIFY_PORT ?? 3120));
const BASE = opt("--url", state?.url ?? `http://127.0.0.1:${WEB_PORT}`);
const PROFILE = opt("--profile", process.platform === "darwin" ? "mac" : process.platform === "win32" ? "win" : "nogpu");
const NOGPU = PROFILE === "nogpu";
const READY_TIMEOUT_MS = (NOGPU ? 900 : 240) * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");

async function answers(url) { try { const r = await fetch(url, { signal: AbortSignal.timeout(3000) }); return r.status; } catch { return 0; } }
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function killTree(pid) {
  if (!alive(pid)) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
  else { try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } } }
}

// ---------------------------------------------------------------- up / down
async function up() {
  if (state && state.pids.some(alive)) {
    const prod = flag("--prod"), want = { prod, port: GAME_PORT, ...(prod ? {} : { web: WEB_PORT }) };
    const differs = Object.entries(want).filter(([k, v]) => (k === "prod" ? !!state.prod : state[k]) !== v).map(([k, v]) => `${k} ${k === "prod" ? !!state.prod : state[k]} → ${v}`);
    if (differs.length) { console.error(`an instance started by up is still running (${state.url}, ${state.prod ? "prod" : "dev"}) but this up asked for something else (${differs.join(", ")}); run down first`); return 1; }
    const healthy = state.pids.every(alive) && (await answers(state.url + "/")) === 200 && (await answers(`http://127.0.0.1:${state.port}/health`)) === 200;
    if (healthy) { console.log(JSON.stringify({ ok: true, note: "already up", ...state })); return 0; }
    console.error("a previous instance is only partly alive or not answering; run down, then up"); return 1;
  }
  for (const p of [WEB_PORT, GAME_PORT]) if (await answers(`http://127.0.0.1:${p}/`)) { console.error(`port ${p} is taken by something this run did not start; pick another with --web / --port`); return 1; }
  if (!fs.existsSync("node_modules/playwright")) { console.error("node_modules missing: run npm ci first"); return 1; }
  const prod = flag("--prod");
  if (prod && !fs.existsSync("dist/index.html")) { console.error("--prod needs dist/: run npm run build first"); return 1; }
  const logDir = path.join(root, "shots", "verify", "logs"); fs.mkdirSync(logDir, { recursive: true });
  const env = { ...process.env, KR_EVENT_MODE: "0", KR_PORT: String(GAME_PORT) };
  const launch = (name, args, extra = {}) => {
    const out = fs.openSync(path.join(logDir, `${name}.log`), "w");
    const c = spawn(process.execPath, args, { cwd: root, env: { ...env, ...extra }, detached: true, stdio: ["ignore", out, out], windowsHide: true });
    c.unref(); return c.pid;
  };
  const tsx = "node_modules/tsx/dist/cli.mjs", vite = "node_modules/vite/bin/vite.js";
  const pids = [launch("server", [tsx, "server/index.ts"], prod ? { KR_SERVE: "1" } : {})];
  if (!prod) pids.push(launch("client", [vite, "--host", "127.0.0.1", "--port", String(WEB_PORT), "--strictPort"]));
  const url = prod ? `http://127.0.0.1:${GAME_PORT}` : `http://127.0.0.1:${WEB_PORT}`;
  const s = { pids, web: prod ? GAME_PORT : WEB_PORT, port: GAME_PORT, url, prod, logs: logDir, startedAt: new Date().toISOString() };
  fs.writeFileSync(STATE, JSON.stringify(s, null, 2));
  const t0 = Date.now();
  while (Date.now() - t0 < 90_000) {
    if ((await answers(`http://127.0.0.1:${GAME_PORT}/health`)) === 200 && (await answers(url + "/")) === 200) { console.log(JSON.stringify({ ok: true, ...s, ms: Date.now() - t0 })); return 0; }
    if (!pids.every(alive)) break;
    await sleep(500);
  }
  console.error(`instance did not come up; see ${logDir}/server.log and client.log, then run down`); return 1;
}
function down() {
  if (!state) { console.log(JSON.stringify({ ok: true, note: "nothing to stop" })); return 0; }
  for (const pid of state.pids) killTree(pid);
  fs.rmSync(STATE, { force: true });
  console.log(JSON.stringify({ ok: true, stopped: state.pids, evidenceKept: "shots/verify/" })); return 0;
}

// ---------------------------------------------------------------- browser
async function browser() {
  const { chromium } = await import("playwright");
  const gpu = ["--enable-gpu", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"];
  const args = PROFILE === "mac" ? ["--use-angle=metal", ...gpu]
    : PROFILE === "win" ? ["--use-angle=d3d11", ...gpu]
    : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];
  const channel = opt("--channel", NOGPU ? "chromium" : "chrome");
  return chromium.launch({ channel: channel === "chromium" ? undefined : channel, headless: !flag("--headed"), args, timeout: 120_000 });
}
async function openGame(b, query) {
  // nogpu: at 1600x900 SwiftShader cannot settle the vegetation impostors inside the game's own 90 s ready budget
  // (main.ts), and frames are seconds apart, so a smaller viewport and long Playwright timeouts; the far-tree splat
  // bake alone takes ~130 s there, so nogpu adds ?vegsplat=0 unless --splat
  const ctx = await b.newContext({ viewport: NOGPU ? { width: 640, height: 360 } : { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  if (NOGPU) page.setDefaultTimeout(180_000);
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300)); });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${String(e.message).slice(0, 300)}`));
  const t0 = Date.now();
  const q = NOGPU && !flag("--splat") ? `${query}&vegsplat=0` : query;
  await page.goto(`${BASE}/?${q}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.waitForFunction(() => window.__kr?.ready === true || window.__kr?.stage === "failed", null, { timeout: READY_TIMEOUT_MS, polling: 500 });
  const boot = await page.evaluate(() => {
    const c = document.createElement("canvas").getContext("webgl2");
    const ext = c?.getExtension("WEBGL_debug_renderer_info");
    return { ready: window.__kr.ready, stage: window.__kr.stage, readyAtMs: window.__kr.readyAt, gpu: ext ? c.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "unknown" };
  });
  return { ctx, page, consoleErrors, boot: { ...boot, wallMs: Date.now() - t0 } };
}
const krErrors = (page) => page.evaluate(() => window.__kr.errors.slice());
// snapTick = the newest authoritative snapshot tick the client received: it only moves while the simulation runs and
// its snapshots arrive, so a stalled match or a dead socket cannot pass on inMatch alone
const snap = (page) => page.evaluate(() => ({ fps: Math.round(window.__kr.fps?.() ?? 0), inMatch: !!window.__kr.game?.inMatch, snapTick: window.__kr.game?.cm?.snapTick?.() ?? -1, state: window.__kr.game?.state?.() ?? null }));
function gpuOk(gpu) {
  const g = String(gpu).toLowerCase();
  if (PROFILE === "mac") return g.includes("metal");
  if (PROFILE === "win") return g.includes("d3d11") && !g.includes("swiftshader") && !g.includes("basic render");
  return true;
}

// ---------------------------------------------------------------- drives
async function driveBoot(b, out) {
  const { ctx, page, consoleErrors, boot } = await openGame(b, "debug");
  await page.screenshot({ path: path.join(out, "boot-title.png") });
  const cta = await page.locator("button.tn-play-cta").getAttribute("aria-label").catch(() => null);
  const errors = await krErrors(page);
  await ctx.close();
  return { feature: "boot", ok: boot.ready && errors.length === 0 && gpuOk(boot.gpu) && !!cta, boot, playButton: cta, errors, consoleErrors: consoleErrors.slice(0, 20) };
}
async function drivePlay(b, out) {
  const seed = opt("--seed", "42"), secs = Number(opt("--secs", NOGPU ? 20 : 60));
  if (!(secs > 0)) throw new Error("--secs must be a positive number");
  const { ctx, page, consoleErrors, boot } = await openGame(b, `debug&seed=${seed}`);
  await page.screenshot({ path: path.join(out, "play-0-title.png") });
  await page.locator("button.tn-play-cta").click();
  await page.waitForFunction(() => window.__kr.game?.inMatch === true, null, { timeout: NOGPU ? 300_000 : 120_000, polling: 500 });
  const t0 = Date.now(), samples = [{ at: 0, ...(await snap(page)) }];
  for (const at of [5, 15, 30, secs].filter((s, i, a) => s <= secs && a.indexOf(s) === i)) {
    await sleep(Math.max(0, at * 1000 - (Date.now() - t0)));
    samples.push({ at, ...(await snap(page)) });
    await page.screenshot({ path: path.join(out, `play-${String(at).padStart(2, "0")}s.png`) });
  }
  const errors = await krErrors(page);
  await ctx.close();
  const first = samples[0], last = samples.at(-1);
  const advanced = last.snapTick > first.snapTick, reachedPlane = NOGPU || secs < 30 || (last.state?.phase ?? 0) >= 1;
  return { feature: "play", seed, ok: errors.length === 0 && last.inMatch && advanced && reachedPlane, advanced, reachedPlane, boot, samples, errors, consoleErrors: consoleErrors.slice(0, 20) };
}
async function driveRange(b, out) {
  const { ctx, page, consoleErrors, boot } = await openGame(b, "debug");
  await page.locator(".tn-play-links button", { hasText: "Firing range" }).click();
  await page.waitForFunction(() => window.__kr.game?.inMatch === true && !!window.__kr.game?.render?.range, null, { timeout: NOGPU ? 300_000 : 120_000, polling: 500 });
  await sleep(NOGPU ? 15_000 : 6_000);
  const before = await snap(page);
  await page.screenshot({ path: path.join(out, "range-0-spawn.png") });
  const vp = page.viewportSize();
  await page.mouse.click(vp.width / 2, vp.height / 2).catch(() => {});
  const pointerLocked = await page.waitForFunction(() => !!document.pointerLockElement, null, { timeout: NOGPU ? 30_000 : 5_000, polling: 250 }).then(() => true, () => false);
  await page.keyboard.down("w"); await sleep(2000); await page.keyboard.up("w");
  await sleep(500);
  const after = await snap(page);
  await page.screenshot({ path: path.join(out, "range-1-after-walk.png") });
  const moved = before.state && after.state ? Math.hypot(after.state.x - before.state.x, after.state.z - before.state.z) : 0;
  const errors = await krErrors(page);
  await ctx.close();
  return { feature: "range", ok: errors.length === 0 && pointerLocked && after.inMatch && after.snapTick > before.snapTick && moved > 1, pointerLocked, walkedM: +moved.toFixed(1), before, after, boot, errors, consoleErrors: consoleErrors.slice(0, 20) };
}
async function driveRoom(b, out) {
  const host = await openGame(b, "debug&dev"), guest = await openGame(b, "debug&dev");
  const friends = (p) => p.locator("summary", { hasText: "Friends" }).click();
  await friends(host.page);
  await host.page.getByRole("button", { name: "Create lobby" }).click();
  const code = (await host.page.locator(".tn-play-roomcode").filter({ hasText: /^[A-Z0-9]{3,6}$/ }).first().textContent({ timeout: 30_000 })).trim();
  await friends(guest.page);
  await guest.page.getByLabel("Lobby code").fill(code);
  await guest.page.getByRole("button", { name: "Join", exact: true }).click();
  await guest.page.locator(".tn-play-roomcode", { hasText: code }).waitFor({ timeout: 30_000 });
  await host.page.screenshot({ path: path.join(out, "room-0-host-lobby.png") });
  await guest.page.screenshot({ path: path.join(out, "room-0-guest-lobby.png") });
  await host.page.locator("button.tn-play-cta").click();
  const inMatch = (p) => p.waitForFunction(() => window.__kr.game?.inMatch === true, null, { timeout: 120_000, polling: 500 });
  await Promise.all([inMatch(host.page), inMatch(guest.page)]);
  await sleep(NOGPU ? 20_000 : 10_000);
  const h0 = await snap(host.page), g0 = await snap(guest.page);
  await sleep(3000);
  const hs = await snap(host.page), gs = await snap(guest.page);
  const live = (a, b) => b.inMatch && b.snapTick > a.snapTick && (b.state?.ping ?? 0) > 0;
  await host.page.screenshot({ path: path.join(out, "room-1-host-match.png") });
  await guest.page.screenshot({ path: path.join(out, "room-1-guest-match.png") });
  const errors = [...(await krErrors(host.page)), ...(await krErrors(guest.page))];
  await host.ctx.close(); await guest.ctx.close();
  return { feature: "room", code, ok: errors.length === 0 && live(h0, hs) && live(g0, gs), host: hs, guest: gs, boot: host.boot, errors, consoleErrors: [...host.consoleErrors, ...guest.consoleErrors].slice(0, 20) };
}

async function doctor() {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  const [maj, min] = process.versions.node.split(".").map(Number);
  add("node >= 22.12", maj > 22 || (maj === 22 && min >= 12), process.versions.node);
  add("node_modules", fs.existsSync("node_modules/playwright"), "npm ci");
  if (!opt("--url")) add("instance started by up", !!state && state.pids.every(alive), state ? state.pids : "no shots/verify/.instance.json");
  add("client answers", (await answers(BASE + "/")) === 200, BASE);
  const health = await fetch(`http://127.0.0.1:${GAME_PORT}/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json()).catch(() => null);
  add("game server /health", !!health, health ?? `http://127.0.0.1:${GAME_PORT}/health`);
  if (checks.every((c) => c.ok)) {
    const b = await browser();
    try {
      const { ctx, boot } = await openGame(b, "debug");
      await ctx.close();
      add("title ready", boot.ready, boot);
      add(`GPU matches profile ${PROFILE}`, gpuOk(boot.gpu), boot.gpu);
    } catch (e) { add("title ready", false, String(e).slice(0, 300)); } finally { await b.close(); }
  }
  const ok = checks.every((c) => c.ok);
  console.log(JSON.stringify({ ok, profile: PROFILE, base: BASE, checks }, null, 1));
  return ok ? 0 : 1;
}

async function drive(names) {
  const runId = `${PROFILE}-${stamp()}`;
  const out = path.resolve(opt("--out", path.join("shots", "verify", runId)));
  fs.mkdirSync(out, { recursive: true });
  const fns = { boot: driveBoot, play: drivePlay, range: driveRange, room: driveRoom };
  const b = await browser();
  const results = [];
  try {
    for (const n of names) {
      const t0 = Date.now();
      let r;
      try { r = await fns[n](b, out); } catch (e) { r = { feature: n, ok: false, failure: String(e?.message ?? e).slice(0, 500) }; }
      r.ms = Date.now() - t0;
      results.push(r);
      console.log(JSON.stringify({ feature: n, ok: r.ok, ms: r.ms, failure: r.failure }));
    }
  } finally { await b.close(); }
  const summary = { runId, profile: PROFILE, platform: `${process.platform}-${process.arch}`, node: process.versions.node, base: BASE, out, ok: results.every((r) => r.ok), results };
  fs.writeFileSync(path.join(out, "result.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ok: summary.ok, out, result: path.join(out, "result.json") }));
  return summary.ok ? 0 : 1;
}

const DRIVES = ["boot", "play", "range", "room"];
const code = cmd === "up" ? await up()
  : cmd === "down" ? down()
  : cmd === "doctor" ? await doctor()
  : cmd === "all" ? await drive(NOGPU ? ["boot", "play"] : DRIVES)
  : DRIVES.includes(cmd) ? await drive([cmd])
  : (console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 15).join("\n")), cmd === "help" ? 0 : 2);
process.exit(code);
