// Test for tools/playtest/triage.mts and the cli.mts watch ticker, run by npm test as the "triage" check (fast, no GPU, no
// network). The bundles in tools/playtest/fixtures/ are hand-written and tiny: a Safari crash, three Chrome stalls from two
// installs (one install reported twice), a lag report, a memory-growth report, an uncaught error and a truncated bundle.json.
// Every callsign and message in them is a made-up token, so the test can prove none of them reaches a public output.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanBundle } from "./analysis.mts";
import { browserOf, buildClusters, runTriage, stripVolatile, tickerLine, triageBundle } from "./triage.mts";
import type { IndexEntry } from "./triage.mts";

const FIXTURES = path.join(import.meta.dirname, "fixtures");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kr-triage-"));
const callsigns = ["ZORBLAX", "PIXELPETE", "SAFARIKONG", "LAGGYLARRY", "LEAKYLEO", "ERRORERIC"];
const words = ["froze for a second", "rubber banding", "F8 mark in match", "black screen", "tab died", "gets slower", "happened again"];
const clean = (s: string) => { for (const w of [...callsigns, ...words]) assert.ok(!s.includes(w), `private text leaked: ${w}`); };

{
  const warnings: string[] = [];
  const out = path.join(tmp, "out");
  const r = runTriage(FIXTURES, out, (m) => warnings.push(m));
  const by = new Map(r.entries.map((e) => [e.id, e]));

  assert.equal(r.entries.length, 8);
  assert.equal(r.skipped, 1);
  assert.equal(warnings.length, 1, "the truncated bundle.json is skipped with one warning");
  assert.ok(warnings[0].includes("KB-BAD1"));

  const saf = by.get("KB-SAF1")!;
  assert.equal(saf.kind, "crash");
  assert.deepEqual(saf.symptoms, ["crash"]);
  assert.equal(saf.severity, 10);
  assert.equal(saf.config.browser.family, "Safari");
  assert.equal(saf.config.browser.major, 17);
  assert.equal(saf.config.os, "macOS");
  assert.equal(saf.config.gpuVendor, "apple");
  assert.equal(saf.location.phase, "play", "a crash is placed where the dead session was");
  assert.equal(saf.location.poi, "banana-temple", "a crash takes the heartbeat's POI");
  assert.equal(saf.location.cell, "-1,-2", "and its cell from the heartbeat's x and z");
  assert.equal(saf.fingerprint, "crash|play|banana-temple|-|Safari|high");

  const c1 = by.get("KB-CHR1")!;
  assert.equal(c1.kind, "report");
  assert.deepEqual(c1.symptoms, ["stall"]);
  assert.equal(c1.severity, 5, "a stall over 500 ms weighs 5");
  assert.deepEqual(c1.worstStall, { t: 6, maxMs: 640, phase: "play" });
  assert.equal(c1.attribution, "invoker fn@main-AbC123xy.js:1234 640 ms");
  assert.equal(c1.location.cell, "-1,-2", "the grid cell comes from the path row at the stall");
  assert.deepEqual(c1.config.nonDefaultFlags, ["shadows=off"], "perfhud and seed are not config");
  assert.deepEqual(c1.fps, { p50: 60, p5: 14 });
  assert.equal(c1.heapPeakMB, 300);
  assert.match(c1.installHash!, /^[0-9a-f]{12}$/);
  assert.ok(!c1.installHash!.includes("chrome"), "the install id is hashed");

  const c2 = by.get("KB-CHR2")!, c3 = by.get("KB-CHR3")!;
  assert.equal(c2.kind, "mark");
  assert.equal(c2.attribution, "invoker fn@main-ZzZ999aa.js:77 710 ms", "the biggest loaf/longtask within 1 s wins");
  assert.equal(c1.fingerprint, c2.fingerprint, "line numbers, counts and file hashes don't split a fingerprint");
  assert.equal(c1.fingerprint, c3.fingerprint);
  assert.equal(c1.fingerprint, "stall|play|banana-temple|invoker fn@main.js ms|Chrome|high");
  assert.equal(c1.installHash, c3.installHash, "one install reporting twice");
  assert.notEqual(c1.installHash, c2.installHash);

  const soft = by.get("KB-SW1")!;
  assert.equal(soft.config.gpuVendor, "software");
  assert.deepEqual(soft.symptoms, ["other"], "SwiftShader says nothing about stalls or frame rate");
  assert.ok(soft.worstStall, "the stall is still located");

  assert.deepEqual(by.get("KB-LAG1")!.symptoms, ["lag"]);
  assert.deepEqual(by.get("KB-MEM1")!.symptoms, ["memory"]);
  assert.equal(by.get("KB-MEM1")!.config.browser.family, "Edge");
  const err = by.get("KB-ERR1")!;
  assert.deepEqual(err.symptoms, ["error"]);
  assert.equal(err.errorKey, "[uncaught] TypeError: Cannot read properties of undefined (reading 'x')");
  assert.ok(err.fingerprint.includes(err.errorKey!), "an error report is told apart by its message");
  for (const e of r.entries) assert.deepEqual(e.symptoms.length > 0, true);

  const cl = r.clusters;
  assert.equal(cl.length, 6);
  assert.deepEqual(cl.map((c) => c.symptom), ["stall", "crash", "lag", "error", "memory", "other"], "ranked by players x severity x recency");
  assert.deepEqual(cl.map((c) => c.score), [10, 5, 3, 2, 1.5, 0.5]);
  assert.deepEqual(cl.map((c) => c.recency), [1, 0.5, 1, 1, 0.5, 0.5], "a cluster a day or more behind the newest report halves");
  const stall = cl[0];
  assert.equal(stall.count, 3);
  assert.equal(stall.distinctInstalls, 2, "two installs, one of them twice");
  assert.deepEqual(stall.builds, ["b9840d6"]);
  assert.equal(stall.configs.length, 2);
  assert.equal(stall.title, "Stall in play at banana-temple: Chrome, high tier (2 players)");
  assert.equal(stall.representatives.length, 3);
  assert.deepEqual(stall.notes.map((n) => n.id).sort(), ["KB-CHR1", "KB-CHR3"], "marks carry no player note");
  assert.ok(stall.notes.every((n) => n.text.includes("note-token")));

  const md = fs.readFileSync(path.join(out, "clusters.md"), "utf8");
  assert.ok(md.indexOf("Stall in play") < md.indexOf("Crash in play") && md.indexOf("Crash in play") < md.indexOf("Memory growth"));
  clean(md);
  clean(fs.readFileSync(path.join(out, "index.jsonl"), "utf8"));
  const json = fs.readFileSync(path.join(out, "clusters.json"), "utf8");
  for (const c of callsigns) assert.ok(!json.includes(c), `callsign in clusters.json: ${c}`);
  assert.ok(json.includes("it happened again"), "notes are kept for the issue-filing step");

  const files = ["index.jsonl", "clusters.json", "clusters.md"];
  const first = files.map((f) => [fs.readFileSync(path.join(out, f), "utf8"), fs.statSync(path.join(out, f)).mtimeMs] as const);
  runTriage(FIXTURES, out, () => {});
  files.forEach((f, i) => {
    assert.equal(fs.readFileSync(path.join(out, f), "utf8"), first[i][0], `${f} changed on a rerun`);
    assert.equal(fs.statSync(path.join(out, f)).mtimeMs, first[i][1], `${f} was rewritten on a rerun`);
  });
  assert.equal(fs.readFileSync(path.join(out, "index.jsonl"), "utf8").trim().split("\n").length, 8);

  const now = Date.parse("2026-11-05T18:25:00Z");
  const line = tickerLine(r.entries, now);
  assert.equal(line, "5 reports this hour · top: Stall at banana-temple, Chrome (2) · latest: Stall, Chrome, Windows");
  assert.equal(tickerLine(r.entries, now + 86_400_000), "0 reports this hour");
  clean(line);
}

{
  assert.equal(stripVolatile("invoker fn@index-DX9s8aKf.js:123 45 ms"), "invoker fn@index.js ms");
  assert.equal(stripVolatile("shader programs +12"), "shader programs");
  assert.equal(browserOf("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.0.0 Mobile/15E148 Safari/604.1").family, "Chrome");
  assert.equal(browserOf("curl/8").family, "other");
}

{
  const hostile: unknown[] = [
    { id: 5, message: { a: 1 }, receivedAt: 7, ctx: "string", logs: "nope", bundle: { timeline: "x", flags: [1], build: 4 } },
    { id: "KB-H2", message: "x".repeat(5000), receivedAt: "not a date", bundle: { mark: "yes", timeline: { fields: ["t", "fps", "phase"], rows: [[1, 60], "row", [2, "x", 2], [3, 20, 2]], dropped: "many" } },
      ctx: { env: { ua: 7, dpr: "big", memoryGB: {} }, gpu: [], diag: { events: [null, [1], ["x", 1], [1, "loaf", "slow", 5]], path: { fields: "t", rows: [[]] }, prev: [] }, perf: { heapMB: { limit: "huge" } }, game: { player: { pos: "here", poi: [] } } },
      logs: [null, { level: "error", text: 9 }, { level: "error", text: "[uncaught] boom 42\n at x" }] },
  ];
  for (const h of hostile) {
    const s = cleanBundle(h);
    if (!s) continue;
    const { entry } = triageBundle(s);
    assert.ok(entry.symptoms.length > 0 && Number.isFinite(entry.severity));
    assert.ok(entry.fingerprint.length < 300);
  }
  assert.equal(cleanBundle("string"), null);
  assert.equal(cleanBundle({ id: "x" }), null);
  const e = triageBundle(cleanBundle(hostile[1])!).entry;
  assert.equal(e.errorKey, "[uncaught] boom", "a number in an error doesn't split its cluster");
  const entries: IndexEntry[] = [];
  assert.deepEqual(buildClusters(entries), []);
}

{
  const base = () => JSON.parse(fs.readFileSync(path.join(FIXTURES, "2026-11-05T18-00-00Z-KB-CHR1", "bundle.json"), "utf8"));
  const entryOf = (b: unknown) => triageBundle(cleanBundle(b)!).entry;

  const exited = base();
  exited.ctx.diag.prev = { sid: "old", phase: 2, poi: "peel-harbor", clean: true };
  assert.equal(entryOf(exited).kind, "report", "a clean exit isn't a crash");
  assert.deepEqual(entryOf(exited).symptoms, ["stall"]);

  const travelled = base();
  travelled.ctx.game.player.pos = [600, 10, 360];
  assert.equal(entryOf(travelled).location.poi, "banana-temple", "the stall's own path row decides, not where they were when they reported");
  assert.equal(entryOf(travelled).location.cell, "-1,-2");

  const crashed = base();
  crashed.ctx.diag.prev = { sid: "old", phase: 2, poi: "buy-now", x: null, z: null, clean: false };
  assert.equal(entryOf(crashed).location.poi, null, "a heartbeat POI that isn't on the map is ignored");
  assert.equal(entryOf(crashed).location.cell, null, "a crash outside a match has no cell, and takes none from the new session");

  crashed.ctx.diag.prev = { sid: "old", phase: 2, poi: "the-wreck", x: -1200, z: 90, clean: false };
  assert.equal(entryOf(crashed).location.poi, null, "a crash far from every POI is placed by its coordinates, not by the heartbeat's nearest POI");
  assert.equal(entryOf(crashed).location.cell, "-12,0");

  const stale = base();
  stale.ctx.diag.path.rows = [];
  stale.bundle.timeline.rows[11][stale.bundle.timeline.fields.indexOf("t")] = 600;
  assert.equal(entryOf(stale).location.poi, null, "a stall long before the report isn't placed where the player is now");
  assert.equal(entryOf(stale).location.cell, null);

  const wreck = base();
  wreck.ctx.diag.path.rows = [];
  wreck.ctx.game.player.pos = [-1050, 10, 90];
  assert.equal(entryOf(wreck).location.poi, "the-wreck", "250 m from the centre of a 150 m POI is 100 m from its edge");
  wreck.ctx.game.player.pos = [-1300, 10, 90];
  assert.equal(entryOf(wreck).location.poi, null);

  const hostileText = base();
  hostileText.ctx.diag.events = [[6.2, "loaf", 640, "invoker <b>BUY NOW</b> fn@main.js:12 640 ms"]];
  hostileText.ctx.game.player.poi.id = "buy-now";
  hostileText.ctx.diag.path.rows = [];
  delete hostileText.ctx.game.player.pos;
  const ht = entryOf(hostileText);
  assert.equal(ht.attribution, "invoker bBUY NOW/b fn@main.js:12 640 ms", "markup characters are dropped");
  assert.equal(ht.location.poi, null, "a POI id that isn't on the map is ignored");
  const built = (text: string) => { hostileText.ctx.diag.events = [[6.1, "module-built", 420, text]]; return entryOf(hostileText).attribution; };
  assert.equal(built("poi:banana-temple"), "Module build BANANA TEMPLE", "a map POI is named");
  assert.equal(built("exits"), "Module build exits", "other stream modules are kept");
  assert.equal(built("poi:buy-now"), "Module build unknown");
  assert.equal(built("<b>x</b>\nBUY"), "Module build unknown");
  hostileText.ctx.diag.events = [[6.1, "module-built", 420, "exits"], [6.3, "module-failed", 15, "poi:banana-temple"]];
  assert.equal(entryOf(hostileText).attribution, "Module failed BANANA TEMPLE", "a failed build outranks a slow one");
  hostileText.ctx.diag.events = [[40, "module-failed", 15, "exits"]];
  const failedBuild = entryOf(hostileText);
  assert.ok(failedBuild.symptoms.includes("error"), "a failed module build is an error");
  assert.equal(failedBuild.errorKey, "module build failed exits");
  hostileText.ctx.diag.events = [[40, "module-failed", 15, "exits"], [41, "module-built", 80, "exits"]];
  assert.ok(!entryOf(hostileText).symptoms.includes("error"), "a module that failed and then built isn't an error");
  hostileText.ctx.diag.events = [[5.8, "module-failed", 15, "exits"], [30, "module-built", 80, "exits"]];
  assert.equal(entryOf(hostileText).attribution, "Module failed exits", "but it still explains the stall it overlapped");
  hostileText.ctx.diag.events = [[40, "module-built", 80, "exits"], [41, "module-failed", 15, "exits"]];
  assert.equal(entryOf(hostileText).errorKey, "module build failed exits", "a failure after the last build still counts");
  hostileText.ctx.diag.events = [[6.1, "poi-built", 420, "poi:banana-temple"]];
  assert.equal(entryOf(hostileText).attribution, null, "the old event kind is gone");

  const hitchy = base();
  delete hitchy.ctx.diag;
  const fields = hitchy.bundle.timeline.fields as string[], at = (n: string) => fields.indexOf(n);
  hitchy.bundle.timeline.rows = Array.from({ length: 70 }, (_, i) => {
    const row = hitchy.bundle.timeline.rows[0].slice();
    row[at("t")] = i + 1;
    if (i % 25 === 9) { row[at("maxMs")] = 150; row[at("over100")] = 1; }
    return row;
  });
  const hy = entryOf(hitchy);
  assert.deepEqual(hy.symptoms, ["hitchy", "stall"], "three stall seconds in 70 play seconds is hitching, and still a stall");
  assert.ok(hy.fingerprint.startsWith("hitchy|"));
}

{
  const dir = path.join(tmp, "watch");
  fs.cpSync(FIXTURES, dir, { recursive: true });
  const ticker = path.join(dir, "ticker.txt");
  const child = spawn(process.execPath, ["--import", "tsx", path.join(import.meta.dirname, "cli.mts"), "watch", "--dir", dir], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  const until = async (ok: () => boolean, what: string) => {
    for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 200));
    assert.ok(ok(), `watch did not ${what}\n${stdout}`);
  };
  try {
    await until(() => fs.existsSync(ticker), "write the ticker");
    assert.equal(fs.readFileSync(ticker, "utf8").trim(), "0 reports this hour", "the fixtures are old news");
    const live = JSON.parse(fs.readFileSync(path.join(FIXTURES, "2026-11-05T18-00-00Z-KB-CHR1", "bundle.json"), "utf8"));
    live.id = "KB-LIVE1"; live.receivedAt = new Date().toISOString();
    fs.mkdirSync(path.join(dir, "9999-KB-LIVE1"));
    fs.writeFileSync(path.join(dir, "9999-KB-LIVE1", "bundle.json"), JSON.stringify(live));
    await until(() => stdout.includes("KB-LIVE1"), "print the new bundle");
    await until(() => fs.readFileSync(ticker, "utf8").startsWith("1 report this hour"), "update the ticker");
    const whole = JSON.stringify(live);
    fs.mkdirSync(path.join(dir, "9998-KB-LIVE2"));
    fs.writeFileSync(path.join(dir, "9998-KB-LIVE2", "bundle.json"), whole.slice(0, 40));
    await until(() => stderr.includes("9998-KB-LIVE2 not readable yet"), "warn about a half-written bundle");
    live.id = "KB-LIVE2";
    fs.writeFileSync(path.join(dir, "9998-KB-LIVE2", "bundle.json"), JSON.stringify(live));
    await until(() => stdout.includes("KB-LIVE2"), "pick up the bundle once it was complete");
    assert.equal(stderr.split("9998-KB-LIVE2 not readable yet").length, 2, "the half-written bundle is warned about once");
    const mine = stdout.split("\n").filter((l) => l.includes("KB-LIVE1"));
    assert.equal(mine.length, 1, "one line per bundle");
    assert.match(mine[0], /stall .*Chrome 131 · Windows · nvidia · high  banana-temple  KB-LIVE1$/);
    clean(stdout);
    clean(fs.readFileSync(ticker, "utf8"));
  } finally { child.kill(); }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("playtest triage: ok");
