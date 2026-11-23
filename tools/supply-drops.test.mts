// Supply drops are round-local: repeated rounds restart the quota and schedule, and clients discard old beacons.
import assert from "node:assert/strict";
import fs from "node:fs";
import { ClientMatch } from "../client/src/game/client";
import type { Link } from "../client/src/game/net";
import { matchInfo } from "../shared/net/host";
import { DT, RESULTS_S } from "../shared/sim/const";
import { Match, Phase } from "../shared/sim/match";
import { buildStaticWorld } from "../shared/sim/static-world";
import { Terrain } from "../shared/world/terrain";
import { decodeTerrainFile } from "../shared/world/terrain-gen";

const bytes = fs.readFileSync(new URL("../public/assets/terrain/island.bin", import.meta.url));
const td = decodeTerrainFile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
const { world } = await buildStaticWorld(new Terrain(td.heights, td.biome), td);
const m = new Match({ seed: 42, mode: "solo", world, seats: 2, humans: [{ id: 0, name: "DROPS", team: 0 }] });
// Exercise the drop scheduler without spending three minutes on bot movement between spawns.
const scheduler = m as unknown as { stepSupplyDrops(): void };
const ordinaryIds = m.chests.map(c => c.id);
const link: Link = {
  offline: true, onJSON() {}, onBinary() {}, onClose() {}, sendJSON() {}, sendBinary() {}, close() {},
};
const cm = new ClientMatch(world, link);
cm.chests = m.chests.map(c => ({ ...c }));
m.onPhase = phase => cm.onJSON({ t: "phase", phase, tick: m.tick, plane: m.plane, plan: m.plan });

for (let round = 0; round < 3; round++) {
  m.phase = Phase.Play; m.storm.cx = 0; m.storm.cz = 0; m.storm.r = 5;
  m.time = 44; scheduler.stepSupplyDrops();
  assert.equal(m.chests.filter(c => c.supply).length, 0, "no drop before the first scheduled time");
  for (const time of [45, 135, 225, 315]) { m.time = time; scheduler.stepSupplyDrops(); }
  const drops = m.chests.filter(c => c.supply);
  assert.equal(drops.length, 3, `round ${round + 1} must get exactly three fresh drops`);
  assert.deepEqual(drops.map(c => c.id), [ordinaryIds.length, ordinaryIds.length + 1, ordinaryIds.length + 2]);
  drops[0].opened = true;
  cm.onJSON(matchInfo(m, m.seed, { 1: 0 }));
  assert.equal(cm.supplyDrops.length, 3, "a late joiner receives all current drops");
  assert.equal(cm.supplyDrops[0].opened, true, "late join preserves opened state");
  if (round === 0) {
    cm.onJSON({ t: "phase", phase: Phase.Plane, tick: m.tick, plane: m.plane });
    assert.equal(cm.supplyDrops.length, 0, "Plane also clears drops if the client missed Warmup");
    assert.ok(cm.chests.every(c => !c.supply));
    cm.onJSON(matchInfo(m, m.seed, { 1: 0 }));
  }
  m.phase = Phase.Results; m.phaseT = RESULTS_S - DT / 2;
  m.step();
  assert.equal(m.phase, Phase.Warmup, "the real Results timeout begins a new round");
  assert.deepEqual(m.chests.map(c => c.id), ordinaryIds, "reset removes supply crates and preserves ordinary chests");
  assert.equal(cm.supplyDrops.length, 0, "Warmup removes the client's old map beacons");
  assert.deepEqual(cm.chests.map(c => c.id), ordinaryIds, "client and server keep matching ordinary chest IDs");
}
console.log("supply drops: three repeated rounds, late joins and missed-Warmup reset passed");
