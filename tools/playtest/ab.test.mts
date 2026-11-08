// Test for tools/playtest/ab.mts, run by npm test as the "ab" check (fast, no GPU, no network): synthetic bundles, one
// per arm plus a practice match without a link, are split by arm with the right medians and per-minute rates; timeline
// rows from before the link opened (a practice match first) and outside play (a warm-up's lag) don't reach the arm;
// deferred markers are a rate over the link's own play seconds, not the kept timeline's; two bundles of one link count
// it once, from the later; the server's /health arms become input gaps per 1000 inputs; no callsign or message reaches
// the output.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { markdown, runAb, serverSide } from "./ab.mts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kr-ab-"));
const FIELDS = ["t", "fps", "p95Ms", "maxMs", "over50", "over100", "gpuMs", "pingMs", "jitterMs", "heapMB", "phase"];
/** a bundle with `before` seconds of a practice match at 500 ms ping (with lag spikes), then `playS` seconds of play at
 *  `ping` ms on its link, and the link's report (or none) */
function bundle(id: string, playS: number, ping: number, net: unknown, before = 0, warmup = 0, player = "install-" + id, at = "2026-11-07T00:00:00Z") {
  const rows = Array.from({ length: before + playS }, (_, i) => [i, 60, 17, 18, 0, 0, 5, i < before ? (i % 2 ? 500 : 40) : ping, 2, 300, 2]);
  for (let i = 0; i < warmup; i++) rows.push([before + playS + i, 60, 17, 18, 0, 0, 5, ping, 40, 300, 0]);
  const raw = { id, message: "SECRETMESSAGE", receivedAt: at, reporter: { name: "SECRETCALLSIGN", clientId: player }, ctx: { game: { net } }, logs: [], bundle: { mark: true, timeline: { fields: FIELDS, rows, dropped: 0 }, flags: {}, build: null, replay: null } };
  fs.mkdirSync(path.join(tmp, id)); fs.writeFileSync(path.join(tmp, id, "bundle.json"), JSON.stringify(raw));
}
const report = (arm: string, transport: string, fallback: string | null, p50: number, p95: number, deferred: number, playS: number, since = 0) =>
  ({ transport, fallback, arm, stats: {}, ackMs: { n: 100, p50, p95, p99: p95 }, deferred, playS, since });
bundle("A1", 120, 50, report("wt", "wt", null, 40, 80, 2, 120, 90), 90);
bundle("A2", 60, 70, report("wt", "ws", "timeout", 60, 120, 4, 60));
bundle("B0", 30, 60, report("ws", "ws", "flag-off", 70, 200, 6, 30, 5), 0, 0, "install-B1");
bundle("B1", 60, 60, report("ws", "ws", "flag-off", 70, 200, 6, 60, 5), 0, 20, "install-B1");
bundle("C1", 30, 40, report("forced-wt", "wt", null, 30, 50, 0, 30));
// one forced-wt link reported twice at the same play seconds: first on wt, then after a fallback in the room; the
// earlier report's folder sorts last
bundle("C3", 30, 40, report("forced-wt", "ws", "closed", 30, 50, 0, 30, 7), 0, 0, "install-C2", "2026-11-07T00:05:00Z");
bundle("C4", 30, 40, report("forced-wt", "wt", null, 30, 50, 0, 30, 7), 0, 0, "install-C2", "2026-11-07T00:01:00Z");
// one forced-ws link: a report taken at 60 s of play uploads slowly and lands after one taken later, at 120 s
bundle("E1", 60, 50, report("forced-ws", "ws", "flag-off", 40, 80, 9, 120, 3), 0, 0, "install-E", "2026-11-07T00:01:00Z");
bundle("E2", 60, 50, report("forced-ws", "ws", "flag-off", 40, 80, 3, 60, 3), 0, 0, "install-E", "2026-11-07T00:09:00Z");
bundle("D1", 60, 60, report("off", "ws", "server-off", 70, 90, 10, 600));
bundle("P1", 60, -1, null);

const rows = runAb(tmp, () => assert.fail("no bundle is skipped"));
const by = new Map(rows.map((r) => [r.arm, r]));
assert.deepEqual(rows.map((r) => r.arm), ["wt", "ws", "forced-wt", "forced-ws", "off"], "one row per arm with bundles; the practice match has no link and no row");
const wt = by.get("wt")!, ws = by.get("ws")!;
assert.equal(wt.bundles, 2); assert.equal(wt.players, 2); assert.equal(wt.onWt, 1);
assert.deepEqual(wt.fallbacks, { timeout: 1 });
assert.equal(wt.ackP50Ms, 60, "median of the bundles' p50 (the upper one of two)");
assert.equal(wt.deferredPerMin, 2, "6 deferred markers over 3 minutes of play");
assert.equal(wt.playMin, 3);
assert.equal(wt.pingMs, 70, "the practice match's 500 ms seconds before A1's link opened are not in the arm (median of 50 and 70)");
assert.equal(wt.lagSPer10Min, 0, "nor are its lag spikes");
assert.equal(by.get("off")!.deferredPerMin, 1, "10 markers over the link's 10 minutes of play, though the timeline kept only 1");
assert.deepEqual(by.get("forced-wt")!.fallbacks, { closed: 1 }, "the newer report of C2's link wins a tie in play seconds");
const fws = by.get("forced-ws")!;
assert.equal(fws.links, 1); assert.equal(fws.playMin, 2, "E's report with more play wins though it landed first");
assert.equal(fws.deferredPerMin, 4.5);
assert.equal(ws.bundles, 2); assert.equal(ws.links, 1, "B0 and B1 are two reports of one link (same player, same since)");
assert.deepEqual(ws.fallbacks, { "flag-off": 1 }); assert.equal(ws.ackP95Ms, 200);
assert.equal(ws.deferredPerMin, 6, "the link's 6 markers over its 1 minute, from the later report only");
assert.equal(ws.lagSPer10Min, 0, "the 20 warm-up seconds at 40 ms jitter after B1's play are not play");

const server = serverSide({ transports: { arms: {
  wt: { links: 10, settled: { wt: 8, ws: { timeout: 2, "flag-off": 0 } }, inputs: { seqs: 20000, lost: 10, recovered: 300 } },
  ws: { links: 9, settled: { wt: 0, ws: { "flag-off": 9 } }, inputs: { seqs: 18000, lost: 36, recovered: 0 } },
  off: { links: 0, settled: { wt: 0, ws: {} }, inputs: { seqs: 0, lost: 0, recovered: 0 } },
} } });
assert.deepEqual(server.map((r) => r.arm), ["wt", "ws"], "arms without links or inputs are left out");
assert.equal(server[0].lostPer1000, 0.5); assert.equal(server[0].recoveredPer1000, 15); assert.deepEqual(server[0].fallbacks, { timeout: 2 });
assert.equal(server[1].lostPer1000, 2);
assert.deepEqual(serverSide(null), [], "no /health, no server rows");

const md = markdown(rows, server);
assert.ok(md.includes("| wt | 2 | 2 | 2 | 1 | timeout 1 | 60 |"), md);
for (const secret of ["SECRETMESSAGE", "SECRETCALLSIGN", "install-"]) assert.ok(!md.includes(secret), `private text leaked: ${secret}`);
fs.rmSync(tmp, { recursive: true, force: true });
console.log("ab: all checks passed");
