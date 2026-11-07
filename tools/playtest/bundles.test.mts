import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { BUNDLE_CAP_COUNT, BUNDLE_CAP_MB, BUNDLE_MAX_BYTES, bundleDir, bundleLimits, bundleWriter, parseBundle } from "../../server/playtest-bundles";

const good = {
  mark: true,
  timeline: { fields: ["t", "fps", "p95Ms"], rows: [[1, 60, 17.5], [2, 58, 21]], dropped: 0 },
  flags: { perfhud: "", seed: "42" },
  replay: { version: 1, opts: { seed: 42, mode: "solo" }, warmupS: 20, endAfterResults: true, ticks: 600, events: [[3, 1, 0, 1, 0, 1, 0.5, 0, 0, 0, 0, 0, 0], [9, 3, "KONG", 0]] },
  extra: "dropped",
};

{
  const r = parseBundle(good);
  assert.ok(r.ok);
  assert.equal(r.value.timeline?.rows.length, 2);
  assert.equal((r.value as unknown as Record<string, unknown>).extra, undefined);
  assert.equal(r.value.replay?.events.length, 2);
}

const hostile: Array<[string, unknown]> = [
  ["not an object", "../../etc/passwd"],
  ["an array", [good]],
  ["oversized", { ...good, timeline: { fields: ["t"], rows: Array.from({ length: 7000 }, () => [1]), dropped: 0 }, flags: { pad: "x".repeat(400) }, replay: { ...good.replay, events: Array.from({ length: 199_000 }, () => [1, 1, "y".repeat(40)]) } }],
  ["mark not a boolean", { ...good, mark: "yes" }],
  ["timeline field with a path", { ...good, timeline: { fields: ["../../x"], rows: [[1]], dropped: 0 } }],
  ["timeline row with a string", { ...good, timeline: { fields: ["t"], rows: [["1"]], dropped: 0 } }],
  ["timeline row with NaN", { ...good, timeline: { fields: ["t"], rows: [[null]], dropped: 0 } }],
  ["timeline row of the wrong width", { ...good, timeline: { fields: ["t", "fps"], rows: [[1]], dropped: 0 } }],
  ["timeline too long", { ...good, timeline: { fields: ["t"], rows: Array.from({ length: 7201 }, () => [1]), dropped: 0 } }],
  ["flag name with a path", { ...good, flags: { "../../../tmp/x": "1" } }],
  ["flag value not a string", { ...good, flags: { seed: 42 } }],
  ["flag value too long", { ...good, flags: { seed: "9".repeat(501) } }],
  ["replay wrong version", { ...good, replay: { ...good.replay, version: 2 } }],
  ["replay event with an object", { ...good, replay: { ...good.replay, events: [[1, 1, { $where: "x" }]] } }],
  ["replay event string too long", { ...good, replay: { ...good.replay, events: [[1, 3, "z".repeat(41)]] } }],
  ["replay too many events", { ...good, replay: { ...good.replay, events: Array.from({ length: 200_001 }, () => [1, 6]) } }],
  ["replay opts too large", { ...good, replay: { ...good.replay, opts: { pad: "o".repeat(5000) } } }],
  ["replay opts nested", { ...good, replay: { ...good.replay, opts: { humans: [{ id: 0, name: { $ne: 1 } }] } } }],
  ["replay opts with a long string", { ...good, replay: { ...good.replay, opts: { mode: "s".repeat(41) } } }],
];
for (const [name, v] of hostile) assert.equal(parseBundle(v).ok, false, `hostile bundle accepted: ${name}`);

const diag = {
  v: 1, sid: "a1b2c3d4e5f6", longFrames: "long-animation-frame",
  events: [[12.3, "loaf", 240, "invoker main@index.js:12 240 ms"], [30, "module-built", 410, "banana-temple"]],
  path: { fields: ["t", "x", "y", "z", "yawDeg", "pitchDeg", "phase"], rows: [[30, 100.5, 4, -220.1, 90, -5, 2]] },
  prev: { v: 1, sid: "0f0f0f0f0f0f", sha: "b9840d6", at: 1762500000000, upS: 120, phase: 2, x: 10, z: -20, poi: "banana-temple", heapMB: 900, textures: 300, geometries: 2000, fps: 41, hidden: false, clean: false, extra: "dropped" },
  install: "kb-install-1", kind: "crash", chip: "Crashed", dropped: ["replay"], more: "dropped",
};
{
  const r = parseBundle({ ...good, diag });
  assert.ok(r.ok);
  assert.equal(r.value.diag?.events.length, 2);
  assert.equal(r.value.diag?.prev?.poi, "banana-temple");
  assert.equal((r.value.diag as unknown as Record<string, unknown>).more, undefined);
  assert.equal((r.value.diag?.prev as unknown as Record<string, unknown>).extra, undefined);
  assert.equal(parseBundle(good).ok && parseBundle(good).value.diag, null, "a bundle without diagnostics still parses");
  const old = parseBundle({ ...good, diag: { ...diag, prev: { sid: "abc", phase: "2", poi: "../x", clean: "no" } } });
  assert.ok(old.ok, "a heartbeat an older build wrote is read as far as it can be");
  assert.deepEqual([old.value.diag?.prev?.phase, old.value.diag?.prev?.poi, old.value.diag?.prev?.clean], [null, null, null]);
}
const hostileDiag: Array<[string, unknown]> = [
  ["diag not an object", "x"],
  ["diag wrong version", { ...diag, v: 2 }],
  ["diag sid with a path", { ...diag, sid: "../../x" }],
  ["diag too many events", { ...diag, events: Array.from({ length: 501 }, () => [1, "loaf", 1, ""]) }],
  ["diag event kind with markup", { ...diag, events: [[1, "<b>x</b>", 1, ""]] }],
  ["diag event text too long", { ...diag, events: [[1, "loaf", 1, "t".repeat(201)]] }],
  ["diag event with an object", { ...diag, events: [[1, "loaf", { $gt: 1 }, ""]] }],
  ["diag path too long", { ...diag, path: { ...diag.path, rows: Array.from({ length: 3601 }, () => [1, 2, 3, 4, 5, 6, 7]) } }],
  ["diag path row of the wrong width", { ...diag, path: { ...diag.path, rows: [[1, 2]] } }],
  ["diag path row with a string", { ...diag, path: { ...diag.path, rows: [[1, 2, 3, 4, 5, 6, "7"]] } }],
  ["diag prev not an object", { ...diag, prev: [1] }],
  ["diag kind unknown", { ...diag, kind: "admin" }],
  ["diag chip too long", { ...diag, chip: "C".repeat(25) }],
  ["diag install with a path", { ...diag, install: "../../etc" }],
  ["diag dropped not names", { ...diag, dropped: [{ $where: 1 }] }],
];
for (const [name, v] of hostileDiag) assert.equal(parseBundle({ ...good, diag: v }).ok, false, `hostile diagnostics accepted: ${name}`);
assert.ok(JSON.stringify(hostile[2][1]).length > BUNDLE_MAX_BYTES);

{
  const r = parseBundle({ ...good, flags: JSON.parse('{"__proto__": "x", "seed": "1"}') });
  assert.ok(r.ok);
  assert.equal(Object.getPrototypeOf({}), Object.prototype);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kr-bundles-"));
assert.equal(bundleDir(root, undefined), null);
assert.equal(bundleDir(root, ""), null);
assert.equal(bundleDir(root, "0"), null);
assert.equal(bundleDir(root, "1"), path.join(root, "playtest-bundles"));
assert.equal(bundleDir(root, path.join(root, "elsewhere")), path.join(root, "elsewhere"));

{
  const dir = path.join(root, "caps"), logs: string[] = [];
  const w = bundleWriter(dir, (...a) => logs.push(a.join(" ")), { count: 2, bytes: 1024 * 1024 });
  const at = new Date("2026-11-04T12:00:00Z");
  const a = w.write({ at, id: "../../../escape", json: { a: 1 }, shot: null, shotMime: null });
  assert.ok(a && path.dirname(a) === dir, "a path-like id stays inside the bundle dir");
  assert.ok(!fs.existsSync(path.join(root, "escape")));
  assert.ok(w.write({ at, id: "KB-2", json: { a: 2 }, shot: Buffer.from("jpg"), shotMime: "image/jpeg" }));
  assert.equal(w.write({ at, id: "KB-3", json: { a: 3 }, shot: null, shotMime: null }), null, "count cap");
  assert.equal(w.write({ at, id: "KB-4", json: { a: 4 }, shot: null, shotMime: null }), null);
  assert.equal(logs.filter((l) => l.includes("full")).length, 1, "the cap is logged once");
  const big = bundleWriter(path.join(root, "bytes"), () => {}, { count: 10, bytes: 100 });
  assert.equal(big.write({ at, id: "KB-5", json: { pad: "b".repeat(200) }, shot: null, shotMime: null }), null, "byte cap");
  const again = bundleWriter(dir, () => {}, { count: 2, bytes: 1024 * 1024 });
  assert.equal(again.write({ at, id: "KB-6", json: {}, shot: null, shotMime: null }), null, "a second writer on the same folder sees the same cap");
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { recursive: true });
  assert.ok(w.write({ at, id: "KB-7", json: {}, shot: null, shotMime: null }), "clearing the folder lets writing resume");
  assert.ok(again.write({ at, id: "KB-8", json: {}, shot: null, shotMime: null }));
  assert.equal(w.write({ at, id: "KB-9", json: {}, shot: null, shotMime: null }), null, "a bundle another writer added counts toward the cap");
  const failing = path.join(root, "failing"), fw = bundleWriter(failing, () => {}, { count: 10, bytes: 1024 * 1024 });
  assert.throws(() => fw.write({ at, id: "KB-10", json: {}, shot: {} as Buffer, shotMime: "image/jpeg" }), "a write that fails part way throws");
  assert.deepEqual(fs.readdirSync(failing), [], "and leaves no partial bundle to count toward the caps");

  const mixed = path.join(root, "mixed"), filling = path.join(mixed, "2026-11-04T12-00-02-000Z-KB-60");
  fs.mkdirSync(filling, { recursive: true });
  const mw = bundleWriter(mixed, () => {}, { count: 10, bytes: 300 });
  assert.ok(mw.write({ at, id: "KB-61", json: {}, shot: null, shotMime: null }), "an empty folder another server just made counts as nothing yet");
  fs.writeFileSync(path.join(filling, "bundle.json"), "d".repeat(298));
  assert.equal(mw.write({ at, id: "KB-62", json: {}, shot: null, shotMime: null }), null, "its bytes count once that server fills it");
  assert.ok(parseBundle({ ...good, replay: { ...good.replay, opts: { seed: 1, botAimRange: "Infinity", humans: [{ id: 0, name: "KONG", team: 0 }] } } }).ok);
}

{
  const logs: string[] = [], log = (...a: unknown[]) => logs.push(a.join(" "));
  assert.deepEqual(bundleLimits({}, log), { count: BUNDLE_CAP_COUNT, bytes: BUNDLE_CAP_MB * 1024 * 1024 }, "unset settings keep the default caps");
  assert.deepEqual(bundleLimits({ KR_PLAYTEST_BUNDLES_MAX: "", KR_PLAYTEST_BUNDLES_MB: "" }, log), { count: 500, bytes: 1024 * 1024 * 1024 });
  assert.deepEqual(bundleLimits({ KR_PLAYTEST_BUNDLES_MAX: "5000", KR_PLAYTEST_BUNDLES_MB: "20480" }, log), { count: 5000, bytes: 20480 * 1024 * 1024 });
  assert.equal(logs.length, 0, "valid settings log nothing");
  for (const v of ["0", "-3", "1.5", "abc", "1e400", "9007199254740993", " "]) {
    const n = logs.length;
    assert.deepEqual(bundleLimits({ KR_PLAYTEST_BUNDLES_MAX: v, KR_PLAYTEST_BUNDLES_MB: v }, log), { count: BUNDLE_CAP_COUNT, bytes: BUNDLE_CAP_MB * 1024 * 1024 }, `${JSON.stringify(v)} keeps the defaults`);
    assert.equal(logs.length, n + 2, `${JSON.stringify(v)} is logged for each setting`);
  }
}

{
  process.env.KR_MONGO_URI = "mongodb://127.0.0.1:9";
  process.env.KR_PLAYTEST_BUNDLES = path.join(root, "http");
  const { kongbotDb } = await import("../../server/kongbot");
  const kb = kongbotDb(root);
  const server = http.createServer((req, res) => void kb.handle(req, res, "203.0.113.7"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const post = async (body: unknown) => (await fetch(`http://127.0.0.1:${port}/api/kongbot`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status;
  const report = (bundle: unknown) => ({ v: 1, message: "F8 mark in match at 1:02", reporter: { name: "TEST" }, ctx: null, logs: [], trail: [], shot: null, bundle });
  const written = () => (fs.existsSync(process.env.KR_PLAYTEST_BUNDLES!) ? fs.readdirSync(process.env.KR_PLAYTEST_BUNDLES!) : []);
  assert.equal(await post(report(good)), 200);
  assert.equal(written().length, 1);
  const saved = JSON.parse(fs.readFileSync(path.join(process.env.KR_PLAYTEST_BUNDLES!, written()[0], "bundle.json"), "utf8"));
  assert.deepEqual(saved.bundle.timeline, good.timeline);
  assert.equal(saved.bundle.extra, undefined);
  for (const [name, v] of hostile.slice(3, 8)) assert.equal(await post(report(v)), 400, `hostile bundle over HTTP: ${name}`);
  assert.equal(written().length, 1, "a rejected bundle writes nothing");
  assert.equal(await post(report({ ...good, diag: hostileDiag[4][1] })), 400, "hostile diagnostics over HTTP");
  assert.equal(await post(report({ ...good, diag })), 200);
  const withDiag = written().map((f) => JSON.parse(fs.readFileSync(path.join(process.env.KR_PLAYTEST_BUNDLES!, f, "bundle.json"), "utf8"))).find((j) => j.bundle.diag);
  assert.deepEqual(withDiag?.bundle.diag.events, diag.events, "the validated diagnostics are what the bundle folder keeps");
  assert.equal(withDiag?.bundle.diag.more, undefined);
  const raw = async (body: Buffer | string, encoding: string) => (await fetch(`http://127.0.0.1:${port}/api/kongbot`, { method: "POST", headers: { "content-type": "application/json", "content-encoding": encoding }, body })).status;
  const before = written().length;
  assert.equal(await raw(zlib.gzipSync(JSON.stringify(report({ ...good, diag }))), "gzip"), 200, "a gzip upload is inflated and accepted");
  assert.equal(written().length, before + 1, "a gzip upload writes its bundle");
  const bomb = zlib.gzipSync(Buffer.alloc(13 * 1024 * 1024, 32));
  assert.ok(bomb.length < 64 * 1024, "the bomb is small on the wire");
  assert.equal(await raw(bomb, "gzip"), 413, "an upload that inflates past the body cap is refused");
  assert.equal(await raw(Buffer.from("not gzip at all"), "gzip"), 400, "a broken gzip upload is refused");
  assert.equal(await raw(JSON.stringify(report(good)), "br"), 415, "an encoding the server doesn't inflate is refused");
  assert.equal(written().length, before + 1, "a refused upload writes nothing");
  const codes: number[] = [];
  for (let i = 0; i < 30; i++) codes.push(await post(report(good)));
  assert.ok(codes.includes(429), "F8 marks hit the per-address rate limit");
  assert.ok(written().length <= 20);
  server.close();
  await kb.close();

  process.env.KR_PLAYTEST_BUNDLES = path.join(root, "capped");
  process.env.KR_PLAYTEST_BUNDLES_MAX = "1";
  const capped = kongbotDb(root);
  delete process.env.KR_PLAYTEST_BUNDLES_MAX;
  const one = http.createServer((req, res) => void capped.handle(req, res, "203.0.113.8"));
  await new Promise<void>((r) => one.listen(0, "127.0.0.1", r));
  const at = `http://127.0.0.1:${(one.address() as { port: number }).port}/api/kongbot`;
  for (let i = 0; i < 2; i++) assert.equal((await fetch(at, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(report(good)) })).status, 200, "a report is accepted when the bundle folder is full");
  assert.equal(fs.readdirSync(process.env.KR_PLAYTEST_BUNDLES).length, 1, "KR_PLAYTEST_BUNDLES_MAX caps the folder");
  one.close();
  await capped.close();
}

fs.rmSync(root, { recursive: true, force: true });
console.log("playtest bundles: ok");
