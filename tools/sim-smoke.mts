// Headless sim smoke test: 50 bots play a full match. Reports tick cost, phase timeline, squad attrition, kills,
// friendly fire, how fast bots arm up after landing and how long the final circles last.
//   npx tsx tools/sim-smoke.mts [solo|trios] [seed] [maxTicks] [--check]
//   --riders[=N]: N (default 8) of the seats, one per squad, are scripted humans that hop into the nearest vehicle, drive it
//            around and climb out again, so the vehicle seat code runs (bots only ride when a human squadmate drives).
//   --check: also fail (exit 1) on a regression: no winner, friendly-fire hits, bots not arming up, tick cost over budget, a
//            vehicle seat and its rider disagreeing after any tick (with --riders, also nobody riding at all), a phase change
//            other than Warmup → Plane → Play → Results, or
//            a final-state hash other than its SIM_HASH golden (by mode, seed, riders; skipped with no golden or no Results).
//            Without --check the output and exit code are unchanged. Run: npx tsx tools/sim-smoke.mts trios 42 --check
import { Terrain } from "../shared/world/terrain";
import { decodeTerrainFile, generateTerrain } from "../shared/world/terrain-gen";
import { buildStaticWorld } from "../shared/sim/static-world";
import fsTd from "node:fs";
import { Match, Phase } from "../shared/sim/match";
import { alive, B, makeInput, PS, SK } from "../shared/sim/player";
import { footDist, VS } from "../shared/sim/vehicle";
import { Reader, EV, EV_BYTES, ANN, VK } from "../shared/net/proto";
import { stateHash as matchHash } from "./state-hash.mts";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--")), check = process.argv.includes("--check");
const ridersArg = process.argv.find((a) => a.startsWith("--riders"));
const riders = ridersArg === undefined ? 0 : ridersArg === "--riders" ? 8 : Number(ridersArg.slice("--riders=".length));
if (!Number.isInteger(riders) || riders < 0 || riders > 16) { console.error(`bad ${ridersArg}: want --riders or --riders=N with N in 0..16`); process.exit(2); }
const mode = (args[0] === "solo" ? "solo" : "trios") as "solo" | "trios";
const seed = Number(args[1] || 42);
const maxTicks = Number(args[2] || 60 * 60 * 20);
const td = (() => { try { const b = fsTd.readFileSync(new URL("../public/assets/terrain/island.bin", import.meta.url)); return decodeTerrainFile(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); } catch { return generateTerrain(); } })();
const terrain = new Terrain(td.heights, td.biome);
const { world } = await buildStaticWorld(terrain, td);
const m = new Match({ seed, mode, world, humans: Array.from({ length: riders }, (_, id) => ({ id, name: "Rider" + id, team: id })) });
// phase order (--check): Warmup → Plane → Play → Results (→ Warmup for the next round), recorded at every enter* so two
// phase changes inside one tick are both seen. The constructor has already entered Warmup.
const PHASE_NEXT: Record<number, Phase> = { [Phase.Warmup]: Phase.Plane, [Phase.Plane]: Phase.Play, [Phase.Play]: Phase.Results, [Phase.Results]: Phase.Warmup };
const phasePath = [Phase[m.phase]];
let phaseFrom = m.phase, phaseBad = "";
m.onPhase = (ph) => {
  phasePath.push(Phase[ph]);
  if (!phaseBad && (m.phase !== ph || PHASE_NEXT[phaseFrom] !== ph)) phaseBad = `tick ${m.tick}: ${Phase[phaseFrom]} → ${Phase[ph]}`;
  phaseFrom = ph;
};
m.startNow();
let rocketsFired = 0, lastPhase = -1, maxMs = 0, total = 0, events = 0, knocks = 0, finals = 0, ff = 0, hits = 0, resOffAt = -1;
const causes: Record<string, number> = {};
const landed = new Float64Array(50).fill(-1), armedCheck = new Int8Array(50).fill(-1);
// per-POI activity (bots land at and fight through every POI)
const { POIS } = await import("../shared/world/map.ts");
const poiAt = (x: number, z: number) => { let best = "open", bd = 1e9; for (const q of POIS) { const d = Math.hypot(x - q.x, z - q.z); if (d < q.r * 1.15 && d < bd) { bd = d; best = q.id; } } return best; };
const poiStats: Record<string, { landed: number; kills: number; chests: number }> = {};
const ps = (id: string) => (poiStats[id] ??= { landed: 0, kills: 0, chests: 0 });
function scanEvents() {
  const u8 = m.ev.finish(m.tick); const r = new Reader(u8); r.u8(); const n = r.u8(); r.u32();
  // a vehicle going up hurts everybody, squadmates of whoever set it off included (match.ts explode, all = true): its
  // Boom comes straight before its Explosion and its hits follow, so they are excused until another attack starts (a shot,
  // a rocket, a bomb going off, or an explosion that no Boom announced)
  const blastBy: number[] = [];
  let boomed = false;
  for (let i = 0; i < n; i++) {
    const k = r.u8(); const start = r.o;
    if (k === EV.Shot || k === EV.Rocket || k === EV.RocketEnd || k === EV.BombEnd || (k === EV.Explosion && !boomed)) blastBy.length = 0;
    boomed = false;
    if (k === EV.Kill) { r.u8(); const vic = r.u8(); const vp = m.players[vic]; if (vp) ps(poiAt(vp.x, vp.z)).kills++; const w = r.u8(); const f = r.u8(); const c = w === 255 ? "storm" : w === 254 ? "fall" : "weapon" + w; causes[c] = (causes[c] ?? 0) + 1; if (f) finals++; else knocks++; }
    else if (k === EV.Hit) { const a = r.u8(), b = r.u8(); if (a !== 255 && a !== b && m.players[a]?.team === m.players[b]?.team && !blastBy.includes(a)) ff++; hits++; }
    else if (k === EV.Veh) { const id = r.u8(); if (r.u8() === VK.Boom) { blastBy.push(m.vehs.list[id].lastBy); boomed = true; } }
    else if (k === EV.Rocket) rocketsFired++;
    else if (k === EV.Announce) { const c = r.u8(); if (c === ANN.ResurgenceOff) resOffAt = m.time; }
    const len = EV_BYTES[k]; if (len === undefined) return; r.o = start + len;
  }
}
// seat invariant (--check): a vehicle's seat k holds p exactly when p rides that vehicle in seat k, and no rider is dead or
// on a vehicle that is gone. vehicle.ts and match.ts keep the two copies (v.seats, p.st/veh/seat) in step by hand.
let rideTicks = 0, seatBad = "";
function checkSeats() {
  for (const v of m.vehs.list) for (let k = 0; k < 3; k++) {
    const id = v.seats[k]; if (id < 0) continue;
    const p = m.players[id];
    if (!p || p.st !== PS.Ride || p.veh !== v.id || p.seat !== k) return `vehicle ${v.id} seat ${k} holds player ${id}, who is st=${p ? PS[p.st] : "missing"} veh=${p?.veh} seat=${p?.seat}`;
  }
  for (const p of m.players) {
    if (p.st !== PS.Ride) continue;
    rideTicks++;
    const v = m.vehs.list[p.veh];
    if (!v || v.seats[p.seat] !== p.id) return `player ${p.id} rides vehicle ${p.veh} seat ${p.seat}, which holds ${v ? v.seats[p.seat] : "no vehicle"}`;
    if (!alive(p) || p.hp <= 0) return `player ${p.id} rides vehicle ${v.id} while dead (hp ${p.hp})`;
    if (!v.live || v.st === VS.Gone) return `player ${p.id} rides vehicle ${v.id}, which is gone`;
  }
  return "";
}
// a scripted rider: drop from the plane, walk (teleport) up to the nearest vehicle and press E, drive slow with the horn
// on for 3 s so squadmates board, then drive a weaving loop and climb out after 20 s
const rideInput = makeInput(), rodeFrom = new Float64Array(riders).fill(-1);
function driveRider(p: (typeof m.players)[number]) {
  const inp = rideInput, t = m.tick;
  inp.seq++; inp.mx = inp.mz = 0; inp.buttons = 0; inp.yaw = p.yaw; inp.pitch = 0; inp.slot = p.active; inp.lerpA = t;
  if (p.st === PS.Plane) { if (m.planeT > 4 + p.id && t % 2 === 0) inp.buttons = B.JUMP; }
  else if (p.st === PS.Ride) {
    if (rodeFrom[p.id] < 0) rodeFrom[p.id] = t;
    const s = (t - rodeFrom[p.id]) / 60;
    if (p.seat !== 0) { if (s > 4 && t % 2 === 0) inp.buttons = (t / 2) % 4 === 0 ? B.CROUCH : B.USE; }
    else if (s < 3) inp.buttons = B.FIRE;
    else if (s < 20) { inp.mz = 1; inp.mx = Math.sin(t / 50); }
    else if (t % 2 === 0) inp.buttons = B.USE;
  } else if (p.st === PS.Ground && alive(p) && m.phase === Phase.Play) {
    rodeFrom[p.id] = -1;
    let best = null, bd = Infinity;
    for (const v of m.vehs.list) { if (!v.live || (v.st !== VS.Ok && v.st !== VS.Tipped)) continue; const d = Math.hypot(v.x - p.x, v.z - p.z); if (d < bd) { bd = d; best = v; } }
    if (best) {
      if (footDist(best, p.x, p.z) > 1.2 && t % 120 === p.id) { p.x = best.x + Math.cos(best.yaw) * 1.9; p.z = best.z - Math.sin(best.yaw) * 1.9; p.y = best.y + 0.3; p.vx = p.vy = p.vz = 0; }
      if (t % 2 === 0) inp.buttons = B.USE;
    }
  }
  m.pushInput(p.id, inp);
}
const t0 = performance.now();
for (let i = 0; i < maxTicks; i++) {
  for (let id = 0; id < riders; id++) driveRider(m.players[id]);
  const a = performance.now();
  m.step();
  const ms = performance.now() - a; total += ms; if (ms > maxMs) maxMs = ms;
  if (check && !seatBad) { const bad = checkSeats(); if (bad) seatBad = `tick ${m.tick}: ${bad}`; }
  if (!m.ev.empty) { events += m.ev.n; scanEvents(); m.ev.reset(); }
  if (m.phase !== lastPhase) { lastPhase = m.phase; console.log(`t=${m.time.toFixed(1)} phase=${Phase[m.phase]} alive=${m.aliveCount()} squads=${m.squadsLeft()}`); }
  if (m.phase === Phase.Plane || m.phase === Phase.Play) for (const p of m.players) {
    if (landed[p.id] < 0 && p.st === PS.Ground && alive(p) && m.time > 1) { landed[p.id] = m.time; ps(poiAt(p.x, p.z)).landed++; }
    if (landed[p.id] >= 0 && armedCheck[p.id] < 0 && m.time >= landed[p.id] + 30) armedCheck[p.id] = alive(p) && p.slots.some((s) => s.kind === SK.Weapon) ? 1 : alive(p) ? 0 : 2;
  }
  if (i % (60 * 30) === 0 && m.phase === Phase.Play) {
    const st = m.storm; const inAir = m.players.filter((p) => p.st === PS.Freefall || p.st === PS.Glide).length;
    const inStorm = m.players.filter((p) => alive(p) && Math.hypot(p.x - st.cx, p.z - st.cz) > st.r).length;
    const weapons = m.players.filter((p) => alive(p) && p.slots.some((s) => s.kind === 1)).length;
    const waiting = m.players.filter((p) => p.st === PS.Dead && p.respawnAt >= 0).length;
    const carry: Record<number, number> = {}; for (const p of m.players) if (alive(p)) for (const s of p.slots) if (s.kind === 1) carry[s.id] = (carry[s.id] ?? 0) + 1;
    if (m.time > 100 && m.time < 131) console.log("  carried weapons (id: n):", JSON.stringify(carry));
    console.log(`  t=${m.time.toFixed(0)}s storm ph${st.phase} r=${st.r.toFixed(0)} ${st.shrinking ? "SHRINK" : "hold"} alive=${m.aliveCount()} waiting=${waiting} squads=${m.squadsLeft()} air=${inAir} inStorm=${inStorm} armed=${weapons} kills=${knocks + finals} chests=${m.chests.filter((c) => c.opened).length}/${m.chests.length}`);
  }
  if (m.phase === Phase.Results) { console.log(`RESULTS winner team ${m.winnerTeam} at t=${m.time.toFixed(0)}s`); break; }
}
const checked = [...armedCheck].filter((v) => v === 0 || v === 1), armed = checked.filter((v) => v === 1).length;
console.log(`mode=${mode} seed=${seed} ticks=${m.tick} avg=${(total / m.tick).toFixed(3)} ms max=${maxMs.toFixed(2)} ms wall=${((performance.now() - t0) / 1000).toFixed(1)} s events=${events}`);
console.log(`kills=${knocks + finals} (knocks ${knocks}, final ${finals}) hits=${hits} friendlyFireHits=${ff}`);
console.log(`armed 30 s after landing: ${armed}/${checked.length} (${Math.round((armed / Math.max(1, checked.length)) * 100)}%)`);
console.log(`final circles (resurgence off → results): ${resOffAt >= 0 ? (m.time - resOffAt).toFixed(0) + " s" : "n/a"}`);
const top = [...m.players].sort((a, b) => b.kills - a.kills).slice(0, 5).map((p) => `${p.name}:${p.kills}k/${Math.round(p.damage)}d`);
console.log("top:", top.join("  "));
console.log("kill causes:", JSON.stringify(causes), "rockets fired:", rocketsFired, "chests opened:", m.chests.filter((c) => c.opened).length + "/" + m.chests.length);
for (const c of m.chests) if (c.opened) ps(c.poi >= 0 ? POIS[c.poi].id : "open").chests++;
console.log("per POI (first landing / kills in it / chests opened):");
for (const q of [...POIS.map((p) => p.id), "open"]) { const v = poiStats[q]; if (v) console.log(`  ${q.padEnd(15)} landed ${String(v.landed).padStart(2)}  kills ${String(v.kills).padStart(3)}  chests ${String(v.chests).padStart(3)}`); else console.log(`  ${q.padEnd(15)} —`); }

const stateHash = matchHash(m);
if (check) {
  console.log(`state hash: ${stateHash}`);
  const SIM_HASH: Record<string, string> = { "trios 42 riders 0": "63fac427", "solo 1 riders 0": "459b89b6", "trios 7 riders 0": "6f032131", "trios 7 riders 8": "f6a0f4a1" };
  const golden = m.phase === Phase.Results ? SIM_HASH[`${mode} ${seed} riders ${riders}`] : undefined;
  const MAX_AVG_TICK_MS = 3, MAX_TICK_MS = 100, MIN_ARMED_PCT = 90;
  const fail: string[] = [];
  if (m.phase !== Phase.Results || m.winnerTeam < 0) fail.push(`no winner (phase ${Phase[m.phase]}, winnerTeam ${m.winnerTeam}, ticks ${m.tick})`);
  if (ff > 0) fail.push(`${ff} friendly-fire hits (expected 0)`);
  if (checked.length === 0 || (armed / checked.length) * 100 < MIN_ARMED_PCT) fail.push(`only ${armed}/${checked.length} bots armed 30 s after landing (need ${MIN_ARMED_PCT}%)`);
  if (total / m.tick > MAX_AVG_TICK_MS) fail.push(`average tick ${(total / m.tick).toFixed(3)} ms over budget ${MAX_AVG_TICK_MS} ms`);
  if (maxMs > MAX_TICK_MS) fail.push(`max tick ${maxMs.toFixed(2)} ms over budget ${MAX_TICK_MS} ms`);
  console.log(`phases: ${phasePath.join(" → ")}`);
  if (phaseBad) fail.push(`illegal phase change (${mode} seed ${seed}) at ${phaseBad}`);
  else if (phasePath.join() !== "Warmup,Plane,Play,Results") fail.push(`phases ran ${phasePath.join(" → ")}, expected Warmup → Plane → Play → Results`);
  console.log(`seat invariant: ${rideTicks} rider-ticks checked`);
  if (seatBad) fail.push(`seat invariant broken (${mode} seed ${seed}) at ${seatBad}`);
  if (riders > 0 && rideTicks === 0) fail.push("seat invariant checked no riders (nobody rode a vehicle, so the check proved nothing)");
  if (golden !== undefined && stateHash !== golden) fail.push(`state hash ${stateHash} != golden ${golden} for ${mode} seed ${seed} riders ${riders} (deterministic outcome changed; if intended, update SIM_HASH)`);
  if (fail.length) { console.error("SIM CHECK FAILED:\n  " + fail.join("\n  ")); process.exit(1); }
  console.log("SIM CHECK PASSED");
}
