// "A location is never invisible" (client/src/engine/invariants.hot.ts) on a software renderer: one seeded practice
// match with ?invariants, through the warm-up and the plane (the low-memory stream builds what the plane sees, impostors
// stand in for the rest), then teleported on the in-page host through each route POI's swap ranges: the low-memory
// build distance and the HLOD switch distance. Fails on any frame where a POI in view that was drawn stopped
// being drawn (__kr.invariants.violations), on any other __kr.errors entry or uncaught page error (a failed shader draws
// nothing the scan can see), when the check never ran, when a stop's frames stopped advancing, when a route POI never
// built at its nearest stop (its hand-over to the model was not exercised), when its far stop never saw it drawn by
// its impostor or HLOD proxy (its far form was not exercised), or when a route POI was never in view with
// something to draw it. The browser only loads a server you started on 127.0.0.1 (AGENTS.md rule 7), for example:
//
//   node .agents/skills/verify-kongroyale/scripts/kr-verify.mjs up --prod --port 3140
//   npx tsx tools/verify-invariants.mts --url http://127.0.0.1:3140 --query "lowmem=1&geofree=1&farimp=1"
//
// Options: --url (default http://127.0.0.1:3140), --query "a=1&b=2" (the arm's flags), --pois a,b (route POIs, default
// ROUTE), --seed 42, --viewport 640x360, --hold-frames 12 (frames at each stop; the middle stop also waits out a
// build of the route POI already under way but not one still queued, so the model hand-over may land there or at the
// nearest stop, which counts its frames from the build; the far stop counts from when its impostor or proxy draws it),
// --hold-max-s 120 (longest wait at one stop), --near-max-s 240 (longest wait for the nearest stop's build), --far-warn
// <issue> (the far stop holds its frames without waiting for the far form, and warns, naming the open issue, instead of
// failing when it never came), --out <file> (the JSON verdict), --headed, --gpu (the machine's GPU instead of
// SwiftShader), --report-only (violations print as GitHub warnings and exit 0; the harness still fails on its own
// errors). Exit 0 = no violation.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { POIS } from "../shared/world/map.ts";

/** POIs the teleport route visits: the plantation, where an impostor was seen hiding as its model began to dissolve in. Each stop costs about 35 s on a CI runner,
 *  and the job must finish within the time of the workflow's longest job */
const ROUTE = ["the-plantation"];
/** the HLOD switch distance engine/hlod.ts registers for a POI (main.ts registerFar) and its hysteresis (m) */
const hlodNear = (r: number) => Math.max(240, r * 2.2), HLOD_HYST_M = 25;
/** the low-memory build distance from a POI's rim (flags.ts lowmemr) */
const LOWMEM_R_M = 450;

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const BASE = opt("--url", "http://127.0.0.1:3140").replace(/\/$/, "");
const QUERY = opt("--query", "");
const SEED = Number(opt("--seed", "42"));
const ONLY = opt("--pois", ROUTE.join(",")).split(",").filter(Boolean);
const [VW, VH] = opt("--viewport", "640x360").split("x").map(Number);
const HOLD_FRAMES = Number(opt("--hold-frames", "12")), HOLD_MAX_S = Number(opt("--hold-max-s", "120")), NEAR_MAX_S = Number(opt("--near-max-s", "240"));
const FAR_WARN = opt("--far-warn", "");
const OUT = opt("--out", "");
const GPU = argv.includes("--gpu"), REPORT_ONLY = argv.includes("--report-only");
for (const id of ONLY) if (!POIS.some((p) => p.id === id)) throw Error("--pois " + id + ": no such POI (" + POIS.map((p) => p.id).join(", ") + ")");
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(BASE)) throw Error("--url " + BASE + ": only a server on this machine (AGENTS.md rule 7)");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (s: string) => console.log("[invariants " + ((Date.now() - t0) / 1000).toFixed(0).padStart(4) + " s] " + s);

/** the stops of one POI's approach: [distance from its centre (m), what changes there] */
function stops(r: number): Array<[number, string]> {
  const h = hlodNear(r);
  return [
    [r + LOWMEM_R_M + 250, "far: impostor or proxy"],
    [Math.min(r + LOWMEM_R_M - 120, Math.max(h + HLOD_HYST_M + 40, r + 60)), "inside the low-memory build distance, outside the HLOD switch"],
    [Math.min(h - 40, r + 40), "inside the HLOD switch"],
  ];
}

const url = BASE + "/?invariants&seed=" + SEED + (QUERY ? "&" + QUERY : "");
const args = GPU ? ["--enable-gpu", "--ignore-gpu-blocklist"] : ["--use-angle=swiftshader", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"];
const browser = await chromium.launch({ headless: !argv.includes("--headed"), args: [...args, "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"] });
const page = await (await browser.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: 1 })).newPage();
const pageErrors: string[] = [], harness: string[] = [], warnings: string[] = [];
page.on("pageerror", (e) => pageErrors.push(String(e.message).slice(0, 300)));
type Status = { ready: boolean; failed: boolean; inMatch: boolean; phase: number; frames: number; stream: string; violations: number };
const status = (): Promise<Status> => page.evaluate(() => {
  const k = (window as any).__kr, g = k?.game, cm = g?.cm;
  return { ready: !!k?.ready, failed: !!k?.bootError, inMatch: !!g?.inMatch, phase: cm ? cm.phase : -1, frames: k?.invariants?.frames ?? 0, stream: String(k?.streamStage ?? ""), violations: k?.invariants?.violations.length ?? 0 };
});
/** "built": integrated and drawn by its model; "building": in the module list, not integrated yet; "" otherwise */
const built = (id: string): Promise<string> => page.evaluate((m) => { const k = (window as any).__kr; return k.modules.includes(m) ? (k.engine.isBuilt(m) ? "built" : "building") : ""; }, "poi:" + id);
/** frames the route POI was drawn by its impostor and HLOD proxies alone */
const farFrames = (id: string): Promise<number> => page.evaluate((m) => (window as any).__kr.invariants?.farSeen[m] ?? 0, "poi:" + id);
/** the route POI's HLOD entry (engine/hlod.ts): "<state>, active|inactive, <proxies> proxies", or "none" */
const hlodOf = (id: string): Promise<string> => page.evaluate((m) => { const f = (window as any).__kr.engine.far.info().find((p: { id: string }) => p.id === m); return f ? f.state + ", " + (f.active ? "active" : "inactive") + ", " + (f.proxies ?? 0) + " proxies" : "none"; }, "poi:" + id);
let reported = 0;
const newViolations = async () => {
  const vs = await page.evaluate((from) => (window as any).__kr.invariants.violations.slice(from) as Array<Record<string, unknown>>, reported);
  reported += vs.length;
  for (const v of vs) log("  violation " + JSON.stringify(v));
};
const place = (x: number, z: number, yaw: number) => page.evaluate(([x, z, yaw]) => {
  const g = (window as any).__kr.game, l = g?.link;
  if (!l?.hostTool || !g.cm) return false;
  l.hostTool({ op: "place", pid: g.cm.me, x, z, yaw });
  if (g.cm.pred.hp < 90) l.hostTool({ op: "heal", pid: g.cm.me, hp: 100 });
  g.input.yaw = yaw; g.input.pitch = -0.05;
  return true;
}, [x, z, yaw] as const);

let verdict: Record<string, unknown> = {};
try {
  log("open " + url + " (" + (GPU ? "GPU" : "SwiftShader") + ", " + VW + "x" + VH + ")");
  await page.goto(url, { waitUntil: "commit", timeout: 120_000 });
  for (let s = await status(); !s.ready; s = await status()) {
    if (s.failed) throw Error("boot failed");
    if (Date.now() - t0 > 900_000) throw Error("not ready after 900 s");
    await sleep(1000);
  }
  log("ready; practice match");
  await page.evaluate(() => { (window as any).__kr.game.practice("solo"); return "ok"; });
  let s = await status();
  for (let last = 0, p0 = Date.now(); !(s.inMatch && s.phase >= 2); s = await status()) {
    if (Date.now() - p0 > 900_000) throw Error("no play phase after 900 s (phase " + s.phase + ")");
    if (Date.now() - last > 30_000) { last = Date.now(); log("phase " + s.phase + ", " + s.frames + " frames checked, stream " + (s.stream || "-")); await newViolations(); }
    await sleep(1000);
  }
  log("play phase, " + s.frames + " frames checked through the warm-up and the plane; route " + ONLY.join(", "));
  for (const id of ONLY) {
    const p = POIS.find((q) => q.id === id)!, n = Math.hypot(p.x, p.z) || 1, ux = -p.x / n, uz = -p.z / n;
    for (const [d, what] of stops(p.r)) {
      const x = p.x + ux * d, z = p.z + uz * d, yaw = Math.atan2(-(p.x - x), -(p.z - z));
      if (!(await place(x, z, yaw))) throw Error("no practice host to teleport on");
      const [far, , nearest] = stops(p.r).map(([dd]) => dd === d), f0 = (await status()).frames, h0 = Date.now(), far0 = await farFrames(id);
      const maxS = nearest ? NEAR_MAX_S : HOLD_MAX_S;
      let state = "", from = nearest || (far && !FAR_WARN) ? -1 : f0;
      for (;;) {
        await sleep(1000);
        await place(x, z, yaw);
        s = await status();
        state = await built(id);
        if (from < 0 && (nearest ? state === "built" : (await farFrames(id)) > far0)) from = s.frames;
        if ((from >= 0 && s.frames - from >= HOLD_FRAMES && state !== "building") || Date.now() - h0 > maxS * 1000) break;
      }
      if (s.frames === f0) harness.push(id + " at " + Math.round(d) + " m: no frame was checked in " + maxS + " s");
      else if (nearest && from < 0) harness.push(id + " at " + Math.round(d) + " m: not built after " + maxS + " s, so its hand-over to the model was not exercised");
      else if (from >= 0 && s.frames - from < HOLD_FRAMES) harness.push(id + " at " + Math.round(d) + " m: " + (s.frames - from) + " of " + HOLD_FRAMES + " hold frames in " + maxS + " s");
      if (far && (await farFrames(id)) === far0) {
        const msg = id + " at " + Math.round(d) + " m: never drawn by its impostor or HLOD proxy at this stop, so its far form was not exercised";
        if (FAR_WARN) { warnings.push(msg + " (" + FAR_WARN + ")"); console.log("::warning title=invariant far form (" + FAR_WARN + ")::" + msg); }
        else harness.push(msg);
      }
      log(id + " at " + Math.round(d) + " m (" + what + "): " + (s.frames - f0) + " frames, " + (state || "not built") + ", hlod " + (await hlodOf(id)) + ", stream " + (s.stream || "-") + ", " + s.violations + " violation(s) so far");
      await newViolations();
    }
  }
} catch (e) {
  harness.push(e instanceof Error ? e.message.split("\n")[0] : String(e));
} finally {
  const errors = await page.evaluate(() => ((window as any).__kr?.errors ?? []).filter((e: string) => !String(e).startsWith("[invariant]")) as string[]).catch(() => [] as string[]);
  const inv = await page.evaluate(() => { const k = (window as any).__kr; return k?.invariants ? { frames: k.invariants.frames, floor: k.invariants.floor, seen: k.invariants.seen, violations: k.invariants.violations, evictions: (k.evictions ?? []).map((e: { id: string }) => e.id) } : null; }).catch(() => null);
  await browser.close();
  const unseen = inv ? ONLY.filter((id) => !(inv.seen["poi:" + id] > 0)) : ONLY;
  if (!inv) harness.push("__kr.invariants is missing: was the page built with the ?invariants check?");
  else if (!inv.frames) harness.push("the check ran on no frame");
  if (inv && unseen.length) harness.push("never in view with something to draw it: " + unseen.join(", "));
  for (const e of errors.slice(0, 10)) harness.push("__kr.errors: " + String(e).split("\n")[0].slice(0, 300));
  for (const e of pageErrors.slice(0, 10)) harness.push("page error: " + e);
  const ok = !harness.length && !!inv && inv.violations.length === 0;
  verdict = { ok, url: url.replace(BASE, ""), renderer: GPU ? "gpu" : "swiftshader", viewport: VW + "x" + VH, route: ONLY, seconds: Math.round((Date.now() - t0) / 1000), harness, warnings, pageErrors: pageErrors.slice(0, 20), ...inv };
  if (OUT) { fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(verdict, null, 2) + "\n"); }
  for (const v of (inv?.violations ?? []) as Array<Record<string, unknown>>) console.log((REPORT_ONLY ? "::warning title=invariant::" : "VIOLATION ") + JSON.stringify(v));
  for (const h of harness) console.log("HARNESS " + h);
  log((ok ? "PASS" : REPORT_ONLY && !harness.length ? "REPORTED" : "FAIL") + ": " + (inv?.violations.length ?? "?") + " violation(s) in " + (inv?.frames ?? 0) + " frames; seen " + JSON.stringify(inv?.seen ?? {}));
  process.exitCode = ok || (REPORT_ONLY && !harness.length) ? 0 : 1;
}
