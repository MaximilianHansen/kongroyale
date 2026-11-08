import fs from "node:fs";
import { Terrain } from "../../shared/world/terrain";
import { decodeTerrainFile } from "../../shared/world/terrain-gen";
import { buildStaticWorld } from "../../shared/sim/static-world";
import { Match } from "../../shared/sim/match";
import { B, makeInput, PS } from "../../shared/sim/player";
import { RE, ReplayRecorder, packLog, replayMatch, unpackEvents, type ReplayLog, type ReplayOpts } from "../../shared/net/replay";
import { quantizeInput } from "../../shared/net/proto";
import { stateHash } from "../state-hash.mts";

const TICKS = 5000;
const b = fs.readFileSync(new URL("../../public/assets/terrain/island.bin", import.meta.url));
const td = decodeTerrainFile(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const { world } = await buildStaticWorld(new Terrain(td.heights, td.biome), td);
const fail: string[] = [];
const viaJson = (log: ReplayLog): ReplayLog => JSON.parse(JSON.stringify(log));

const opts: ReplayOpts = { seed: 9, mode: "trios", humans: [{ id: 0, name: "A", team: 0 }, { id: 1, name: "B", team: 1 }] };
const m = new Match({ ...opts, world });
m.rec = new ReplayRecorder(opts);
let asked = 0;
m.holdWarmup = () => ++asked % 3 !== 0 && asked < 30;
const inp = makeInput();
let seq = 0;
for (let t = 0; t < TICKS; t++) {
  if (t === 5) m.startNow();
  for (const id of [0, 1]) {
    const p = m.players[id];
    if (p.bot || t % 3 === id) continue;
    inp.seq = ++seq; inp.mx = Math.sin(t / 40 + id); inp.mz = 1; inp.yaw = (t / 300) % 6; inp.pitch = 0; inp.slot = 0; inp.lerpA = m.tick;
    inp.buttons = (t % 7 === 0 ? B.JUMP : 0) | (t % 11 === 0 ? B.FIRE : 0) | (p.st === PS.Plane && t % 2 === 1 ? B.JUMP : 0);
    if (id === 0) quantizeInput(inp);
    m.pushInput(id, inp);
    if (t % 5 === 0) m.pushInput(id, inp);
  }
  if (t === 1500) m.inventoryOp(0, 2, 0, 0);
  if (t === 2000) m.releaseHuman(1);
  if (t === 3000) m.reclaimHuman(1, "B");
  if (t === 4000) m.claimBot("C", 2);
  m.step(); m.ev.reset();
}
const log = m.rec.log(m), want = stateHash(m);
const count = (k: RE) => log.events.filter((e) => e[1] === k).length;
for (const [k, name] of [[RE.Input, "inputs"], [RE.Inv, "inventory ops"], [RE.Claim, "claims"], [RE.Release, "releases"], [RE.Reclaim, "reclaims"], [RE.StartNow, "START NOW"], [RE.Hold, "warm-up holds"]] as const) {
  if (count(k) === 0) fail.push(`the recording has no ${name}, so the round trip proves nothing about them`);
}
const got = stateHash(replayMatch(viaJson(log), world));
console.log(`recorded ${log.ticks} ticks, ${log.events.length} events: state hash ${want}; replayed: ${got}`);
if (got !== want) fail.push(`replay ended on ${got}, the recorded match on ${want}`);
const packed = viaJson(packLog(log)), kinds = (l: ReplayLog, k: RE) => l.events.filter((x) => x[1] === k).length;
console.log(`packed: ${kinds(packed, RE.Packed)} packed and ${kinds(packed, RE.Input)} raw inputs, ${JSON.stringify(packed).length} characters against ${JSON.stringify(log).length}`);
if (!kinds(packed, RE.Packed) || !kinds(packed, RE.Input)) fail.push("the packed log needs both packed inputs (player A's quantized ones) and raw ones (player B's) to prove anything");
if (JSON.stringify(unpackEvents(packed.events)) !== JSON.stringify(viaJson(log).events)) fail.push("unpacking a packed log does not give back the recorded events");
const gotPacked = stateHash(replayMatch(packed, world));
if (gotPacked !== want) fail.push(`the packed log replayed to ${gotPacked}, the recorded match ended on ${want}`);
if (process.argv.includes("--write")) fs.writeFileSync(process.argv[process.argv.indexOf("--write") + 1], JSON.stringify(log));

const bad = viaJson(log);
const e = bad.events.find((x) => x[1] === RE.Input && (x[0] as number) > 2000 && x[4] !== 0)!;
e[4] = -(e[4] as number);
try {
  const tampered = stateHash(replayMatch(bad, world));
  console.log(`one input flipped: ${tampered}`);
  if (tampered === want) fail.push("a log with one input changed replayed to the same hash: the hash does not see inputs");
} catch (err) { fail.push(`a log with one input changed does not replay: ${err}`); }

const o2: ReplayOpts = { seed: 3, mode: "solo", humans: [{ id: 0, name: "A", team: 0 }] };
const m2 = new Match({ ...o2, world });
m2.rec = new ReplayRecorder(o2);
for (let t = 0; t < 600; t++) { m2.step(); m2.ev.reset(); }
m2.startNow();
const snap = m2.rec.log(m2), snapHash = stateHash(m2);
for (let t = 0; t < 600; t++) { m2.step(); m2.ev.reset(); }
try {
  const r = replayMatch(viaJson(snap), world);
  if (stateHash(r) !== snapHash || !r.skipWarmup) fail.push(`a log taken after START NOW replayed to ${stateHash(r)} (skipWarmup ${r.skipWarmup}), the match was at ${snapHash}`);
} catch (err) { fail.push(`a log taken after START NOW does not replay: ${err}`); }

if (fail.length) { console.error("REPLAY ROUND TRIP FAILED:\n  " + fail.join("\n  ")); process.exit(1); }
console.log("REPLAY ROUND TRIP PASSED");
