import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { BUNDLE_MAX_BYTES, bundleDir, bundleWriter, parseBundle } from "../../server/playtest-bundles";

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
  assert.ok(parseBundle({ ...good, replay: { ...good.replay, opts: { seed: 1, botAimRange: "Infinity", humans: [{ id: 0, name: "KONG", team: 0 }] } } }).ok);
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
  const codes: number[] = [];
  for (let i = 0; i < 30; i++) codes.push(await post(report(good)));
  assert.ok(codes.includes(429), "F8 marks hit the per-address rate limit");
  assert.ok(written().length <= 20);
  server.close();
  await kb.close();
}

fs.rmSync(root, { recursive: true, force: true });
console.log("playtest bundles: ok");
