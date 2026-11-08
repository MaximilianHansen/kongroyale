// Automatic summaries (server/diag-auto.ts): the row validator, the settings, and the endpoint's own limits over HTTP.
// Run: npx tsx tools/playtest/diag-auto.test.mts
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { AUTO_CAP_MB, autoCapBytes, autoDir, diagAutoApi, parseAuto } from "../../server/diag-auto";

const good = { v: 1, install: "3f2a9c1e-77aa-4b1c-9d0e-123456789abc", session: "a1b2c3d4e5f6", kind: "hitch", t: 812.4, config: "win:d3d11:rtx:high:1440", build: "0146ea0", sig: "poi.build", stats: { frameMs: 412, loafMs: 380 } };

{
  const r = parseAuto({ ...good, note: "hello", name: "KONG", stats: { ...good.stats } });
  assert.ok(r.ok);
  assert.deepEqual(Object.keys(r.value).sort(), ["build", "config", "install", "kind", "session", "sig", "stats", "t", "v"], "unknown fields are dropped");
  assert.equal(parseAuto({ ...good, sig: undefined }).ok && parseAuto({ ...good, sig: undefined }).value.sig, null);
  const hostile: Array<[string, unknown]> = [
    ["not an object", [good]], ["no version", { ...good, v: 2 }], ["short install", { ...good, install: "abc" }],
    ["markup install", { ...good, install: "<img src=x onerror=1>" }], ["bad session", { ...good, session: 12345678 }],
    ["unknown kind", { ...good, kind: "note" }], ["negative t", { ...good, t: -1 }], ["NaN t", { ...good, t: NaN }],
    ["huge t", { ...good, t: 1e7 }], ["spaced config", { ...good, config: "my laptop" }], ["long config", { ...good, config: "x".repeat(81) }],
    ["bad build", { ...good, build: "sha with spaces" }], ["markup sig", { ...good, sig: "<b>" }],
    ["stats array", { ...good, stats: [1, 2] }], ["stats string", { ...good, stats: { a: "1" } }],
    ["stats nested", { ...good, stats: { a: { b: 1 } } }], ["stats infinite", { ...good, stats: { a: Infinity } }],
    ["stats huge", { ...good, stats: { a: 2e9 } }], ["stats proto", JSON.parse('{"v":1,"install":"3f2a9c1e-77aa","session":"a1b2c3d4e5f6","kind":"match","t":1,"config":"k","build":"b","stats":{"__proto__":1}}')],
    ["too many stats", { ...good, stats: Object.fromEntries(Array.from({ length: 17 }, (_, i) => ["f" + i, i])) }],
  ];
  for (const [name, v] of hostile) assert.equal(parseAuto(v).ok, false, name);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kr-auto-"));
assert.equal(autoDir(root, undefined), null);
assert.equal(autoDir(root, "0"), null);
assert.equal(autoDir(root, "1"), path.join(root, ".kongbot", "diag-auto"), "the default folder is one the dev server never serves");
assert.equal(autoDir(root, path.join(root, "x")), path.join(root, "x"));
{
  const logs: string[] = [], log = (...a: unknown[]) => logs.push(a.join(" "));
  assert.equal(autoCapBytes(undefined, log), AUTO_CAP_MB * 1024 * 1024);
  assert.equal(autoCapBytes("64", log), 64 * 1024 * 1024);
  assert.equal(logs.length, 0);
  for (const v of ["0", "-1", "2.5", "lots"]) assert.equal(autoCapBytes(v, log), AUTO_CAP_MB * 1024 * 1024, v);
  assert.equal(logs.length, 4, "each bad value is logged");
}

async function serve(api: ReturnType<typeof diagAutoApi>, ip: () => string) {
  const server = http.createServer((req, res) => void api.handle(req, res, ip()));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/diag/auto`;
  const post = async (body: unknown, type = "application/json") => (await fetch(url, { method: "POST", headers: { "content-type": type }, body: typeof body === "string" ? body : JSON.stringify(body) })).status;
  return { server, url, post };
}
const rows = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))) : []);

{
  const off = diagAutoApi(null, () => {});
  const { server, post } = await serve(off, () => "203.0.113.1");
  assert.equal(await post(good), 404, "off unless KR_DIAG_AUTO is set");
  server.close(); off.close();
}

{
  const dir = path.join(root, "rows"), api = diagAutoApi(dir, () => {});
  let addr = 0;
  const { server, url, post } = await serve(api, () => "198.51.100." + (addr % 250));
  assert.equal(await post(good, "text/plain;charset=UTF-8"), 204, "a sendBeacon row (text/plain) is accepted");
  const saved = rows(dir);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].install, good.install);
  assert.ok(!Number.isNaN(Date.parse(saved[0].at)), "the server stamps its own time");
  assert.equal(await post(good), 204, "a repeat is answered");
  assert.equal(rows(dir).length, 1, "but a row sent twice is stored once");
  assert.equal(await post({ ...good, t: 900.2, stats: { frameMs: 500 } }), 204);
  assert.equal(rows(dir).length, 2, "a later hitch with the same signature is its own row");
  assert.equal(await post({ ...good, sig: "shader.jump" }), 204);
  assert.equal(await post({ ...good, kind: "match", t: 900, sig: null, stats: { fpsP50: 58, fpsP5: 31, frameP99Ms: 48, stallS: 2, heapPeakMb: 610, minutes: 14 } }), 204);
  assert.equal(await post({ ...good, kind: "match", t: 1900, sig: null, stats: { fpsP50: 60 } }), 204, "every finished match is a row");
  assert.equal(rows(dir).length, 5);
  assert.equal((await fetch(url)).status, 405);
  assert.equal(await post("{not json"), 400);
  assert.equal(await post({ ...good, install: "<script>" }), 400);
  assert.equal(await post({ ...good, stats: { pad: 1, note: 2 }, note: "x".repeat(5000) }), 413, "a body over 4 KB is refused");
  assert.equal(rows(dir).length, 5, "refused rows write nothing");

  addr++;
  const one = { ...good, install: "install-limit-0001" }, codes: number[] = [];
  for (let i = 0; i < 20; i++) codes.push(await post(one));
  for (let i = 0; i < 30; i++) codes.push(await post({ ...one, sig: "s" + i }));
  assert.deepEqual([codes.slice(0, 49).every((c) => c === 204), codes.slice(49)], [true, [429]], "30 rows per install per hour, and repeats don't use them up");

  addr++;
  const many: number[] = [];
  for (let i = 0; i < 62; i++) many.push(await post({ ...good, install: `address-limit-${String(i).padStart(4, "0")}` }));
  assert.deepEqual(many.slice(60), [429, 429], "60 rows per address per 10 minutes");
  const h = api.health();
  assert.equal(h.on, true);
  assert.equal(h.accepted, rows(dir).length);
  assert.ok(h.deduped >= 20 && h.limited >= 3 && h.refused >= 3);
  server.close(); api.close();
}

{
  const dir = path.join(root, "small"), logs: string[] = [], api = diagAutoApi(dir, (...a) => logs.push(a.join(" ")), 600);
  const { server, post } = await serve(api, () => "192.0.2.9");
  assert.equal(await post(good), 204);
  assert.equal(await post({ ...good, sig: "b" }), 204);
  assert.equal(await post({ ...good, sig: "c" }), 503, "the folder stops at KR_DIAG_AUTO_MB");
  assert.equal(await post({ ...good, sig: "d" }), 503);
  assert.equal(rows(dir).length, 2);
  assert.equal(logs.filter((l) => l.includes("full")).length, 1, "the cap is logged once");
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f));
  assert.equal(await post({ ...good, sig: "e" }), 204, "clearing the folder lets writing resume");
  server.close(); api.close();
}

fs.rmSync(root, { recursive: true, force: true });
console.log("automatic summaries: ok");
