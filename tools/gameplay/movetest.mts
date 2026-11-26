// MOVEMENT TEST: the real shared/sim stepPlayer on synthetic worlds.
//   npx tsx tools/gameplay/movetest.mts [--json out.json]
// Asserts (exit code 1 on any failure):
//   mantle: ledges 0.8 / 1.2 / 1.6 / 1.8 / 2.0 / 2.1 m are climbed (sprint + jump held AND standing at the wall + jump),
//           2.2 / 2.5 m are NOT; no mantle under a low ceiling, through a thin tall wall, or into a gap the capsule
//           cannot stand in; the pull-up takes 0.2-0.5 s; the kong ends standing on the ledge.
//   slide:  sprint → crouch = entry ≈ SLIDE_V, decays to the end over ~1 s, keeps going downhill, dies uphill, a jump
//           out of it keeps the momentum, crouch spam cannot chain bursts (cooldown).
//   air:    a sprint jump turns 90° in the air within a jump; no speed gain from air steering.
//   determinism: the same input stream twice → bit-identical state (client prediction == server).
import fs from "node:fs";
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const { Terrain } = await import(ROOT + "/shared/world/terrain.ts");
const { WORLD } = await import(ROOT + "/shared/world/map.ts");
const { StaticWorld } = await import(ROOT + "/shared/sim/world.ts");
const P = await import(ROOT + "/shared/sim/player.ts");
const C = await import(ROOT + "/shared/sim/const.ts");
const { makePlayer, makeInput, stepPlayer, B } = P;
const PSx = { Ground: 0, Mantle: 7 };
const DT = C.DT;
const argv = process.argv.slice(2);
const jsonOut = argv.includes("--json") ? argv[argv.indexOf("--json") + 1] : null;

const res = Math.round((2 * WORLD.HALF) / WORLD.CELL) + 1;
function terrain(fn: (x: number, z: number) => number) {
  const h = new Float32Array(res * res), bio = new Uint8Array(res * res);
  for (let i = 0; i < res; i++) for (let j = 0; j < res; j++) h[i * res + j] = fn(-WORLD.HALF + j * WORLD.CELL, -WORLD.HALF + i * WORLD.CELL);
  return new Terrain(h, bio);
}
const FLAT = terrain(() => 10);
type Box = { c: [number, number, number]; h: [number, number, number]; yaw?: number; surf?: string };
const results: Array<{ name: string; pass: boolean; detail: string }> = [];
const check = (name: string, pass: boolean, detail: string) => { results.push({ name, pass, detail }); console.log(`${pass ? "PASS" : "FAIL"}  ${name.padEnd(46)} ${detail}`); };

/** run a player from (x, z) facing -Z with a scripted input; returns the trace */
function run(world: InstanceType<typeof StaticWorld>, x: number, z: number, secs: number, script: (t: number, inp: ReturnType<typeof makeInput>, p: ReturnType<typeof makePlayer>) => void, y = 10) {
  const p = makePlayer(0, 0, "t", false);
  p.x = x; p.y = y; p.z = z; p.grounded = true; p.st = 0;
  const inp = makeInput();
  const trace: Array<{ t: number; x: number; y: number; z: number; v: number; st: number; mvT: number }> = [];
  let mantleT0 = -1, mantleT1 = -1;
  for (let i = 0; i < Math.round(secs / DT); i++) {
    const t = i * DT;
    inp.mx = 0; inp.mz = 0; inp.buttons = 0; inp.yaw = 0; inp.pitch = 0; inp.seq = i + 1;
    script(t, inp, p);
    const st0 = p.st;
    stepPlayer(p, inp, world, DT);
    if (p.st === PSx.Mantle && st0 !== PSx.Mantle) mantleT0 = t;
    if (st0 === PSx.Mantle && p.st !== PSx.Mantle) mantleT1 = t;
    trace.push({ t, x: p.x, y: p.y, z: p.z, v: Math.hypot(p.vx, p.vz), st: p.st, mvT: p.mvT });
  }
  return { p, trace, mantleS: mantleT0 >= 0 && mantleT1 >= 0 ? mantleT1 - mantleT0 : -1, mantled: mantleT0 >= 0 };
}

// ---------------------------------------------------------------- mantle
// a block 6 m wide, 30 m deep; its near face at z = -2
const ledge = (H: number, extra: Box[] = []) => new StaticWorld(FLAT, [{ c: [0, 10 + H / 2, -17], h: [3, H / 2, 15], surf: "stone" }, ...extra] as never);
for (const H of [0.8, 1.2, 1.6, 1.8, 2.0, 2.1, 2.2, 2.5]) {
  const should = H <= C.MANTLE_MAX + 1e-6;
  // (a) sprint at it, jump 1.2 m out, hold jump + forward
  const w = ledge(H);
  const sprintJump = run(w, 0, 6, 3, (t, inp, p) => { inp.mz = 1; inp.buttons = B.SPRINT; if (p.z < -2 + 0.42 + 1.4 || t > 0.95) inp.buttons |= B.JUMP; });
  const onTop = (r: ReturnType<typeof run>) => Math.abs(r.p.y - (10 + H)) < 0.05 && r.p.z < -2.3;
  check(`mantle ${H.toFixed(1)} m sprint+jump ${should ? "climbs" : "blocked"}`, onTop(sprintJump) === should && (!should || H < 1.3 || sprintJump.mantled), `end y=${(sprintJump.p.y - 10).toFixed(2)} z=${sprintJump.p.z.toFixed(2)} mantled=${sprintJump.mantled} pull-up ${sprintJump.mantleS.toFixed(2)} s`);
  // (b) standing flush at the wall, press jump (hold forward)
  const stand = run(w, 0, -2 + 0.43, 2.5, (t, inp) => { inp.mz = 1; if (t >= 0.3 && t < 0.32) inp.buttons |= B.JUMP; });
  check(`mantle ${H.toFixed(1)} m standing jump ${should ? "climbs" : "blocked"}`, onTop(stand) === should, `end y=${(stand.p.y - 10).toFixed(2)} z=${stand.p.z.toFixed(2)} pull-up ${stand.mantleS.toFixed(2)} s`);
  if (should) check(`mantle ${H.toFixed(1)} m pull-up time`, stand.mantleS >= 0.05 && stand.mantleS <= 0.55, `${stand.mantleS.toFixed(3)} s`);
}
// low ceiling over the ledge: 1.4 m ledge, a slab 1.2 m above its top (no standing room)
{
  const w = ledge(1.4, [{ c: [0, 10 + 1.4 + 1.2 + 0.1, -4.5], h: [3, 0.1, 2.5], surf: "stone" }]);
  const r = run(w, 0, -2 + 0.43, 2, (t, inp) => { inp.mz = 1; if (t >= 0.2) inp.buttons |= B.JUMP; });
  check("no mantle into a crawl gap", !r.mantled, `mantled=${r.mantled} end y=${(r.p.y - 10).toFixed(2)}`);
}
// thin tall wall (3 m) with a 1.2 m platform right behind it: must not pass through
{
  const w = new StaticWorld(FLAT, [{ c: [0, 11.5, -2.15], h: [3, 1.5, 0.15], surf: "stone" }, { c: [0, 10.6, -4.5], h: [3, 0.6, 2.2], surf: "wood" }] as never);
  const r = run(w, 0, -2 + 0.43, 2, (t, inp) => { inp.mz = 1; if (t >= 0.2) inp.buttons |= B.JUMP; });
  check("no mantle through a thin 3 m wall", !r.mantled && r.p.z > -2, `mantled=${r.mantled} z=${r.p.z.toFixed(2)}`);
}
// ceiling right above the kong (a doorway lintel at 2.4 m): no pull-up through it
{
  const w = ledge(1.6, [{ c: [0, 10 + 2.45, -1.3], h: [3, 0.1, 0.5], surf: "stone" }]);
  const r = run(w, 0, -2 + 0.43, 2, (t, inp) => { inp.mz = 1; if (t >= 0.2) inp.buttons |= B.JUMP; });
  check("no mantle through a ceiling above", !r.mantled, `mantled=${r.mantled}`);
}
// no forward input = no mantle (jumping in place next to a crate stays a jump)
{
  const w = ledge(1.2);
  const r = run(w, 0, -2 + 0.43, 2, (t, inp) => { if (t >= 0.2) inp.buttons |= B.JUMP; });
  check("jump without forward input is a jump", !r.mantled, `mantled=${r.mantled}`);
}

// ---------------------------------------------------------------- slide
const open = new StaticWorld(FLAT, [] as never);
{
  const r = run(open, 0, 0, 3.2, (t, inp) => { inp.mz = 1; inp.buttons = B.SPRINT | (t >= 1.0 ? B.CROUCH : 0); });
  const at = (s: number) => r.trace[Math.round(s / DT)];
  const v0 = at(0.98).v, v1 = at(1.0 + 0.02).v, v3 = at(1.3).v, v6 = at(1.6).v, v10 = at(2.0).v, v15 = at(2.5).v;
  let endT = -1; for (const s of r.trace) if (s.t > 1.0 && s.mvT === 0 && endT < 0) endT = s.t - 1.0;
  const dist = Math.hypot(at(2.0).x - at(1.0).x, at(2.0).z - at(1.0).z);
  check("slide entry ≈ 9.5 m/s from a sprint", v1 > 9.0 && v1 < 9.8 && v0 > 7.2, `sprint ${v0.toFixed(2)} → ${v1.toFixed(2)} m/s`);
  check("slide decays over ~1 s", v3 > 7 && v6 > 5 && endT > 0.8 && endT < 1.25, `0.3 s ${v3.toFixed(2)} · 0.6 s ${v6.toFixed(2)} · 1.0 s ${v10.toFixed(2)} · 1.5 s ${v15.toFixed(2)} m/s · ends at ${endT.toFixed(2)} s · ${dist.toFixed(1)} m in the first second`);
}
{
  // jump out of the slide 0.1 s in: horizontal speed in the air stays ≥ 8.5
  const r = run(open, 0, 0, 2.2, (t, inp) => { inp.mz = 1; inp.buttons = B.SPRINT | (t >= 1.0 ? B.CROUCH : 0) | (t >= 1.1 && t < 1.12 ? B.JUMP : 0); });
  const air = r.trace.filter((s) => s.t > 1.15 && s.t < 1.6);
  const vmin = Math.min(...air.map((s) => s.v));
  check("jump out of a slide keeps momentum", vmin > 8.5, `min air speed ${vmin.toFixed(2)} m/s`);
}
{
  // crouch spam: sprint, then tap crouch every 0.25 s for 3 s — the average speed must not beat sprinting much
  const r = run(open, 0, 0, 5, (t, inp) => { inp.mz = 1; inp.buttons = B.SPRINT | (t >= 1.0 && Math.floor(t / 0.25) % 2 === 0 ? B.CROUCH : 0); });
  const a = r.trace[Math.round(1.0 / DT)], b = r.trace[r.trace.length - 1];
  const avg = Math.hypot(b.x - a.x, b.z - a.z) / 4;
  check("crouch spam does not chain bursts", avg < C.SPRINT * 1.12, `avg ${avg.toFixed(2)} m/s over 4 s (sprint ${C.SPRINT})`);
}
{
  // downhill 15° vs uphill: a slope along z (ground rises toward +z → running -Z is downhill)
  const s = Math.tan(15 * Math.PI / 180);
  const slope = terrain((_x, z) => 200 + z * s);
  const w = new StaticWorld(slope, [] as never);
  const down = run(w, 0, 300, 3.5, (t, inp) => { inp.mz = 1; inp.buttons = B.SPRINT | (t >= 1.0 ? B.CROUCH : 0); }, 200 + 300 * s);
  const vd = down.trace[Math.round(2.2 / DT)].v;
  // uphill: face +Z (yaw = π)
  const up = run(w, 0, -300, 3.5, (t, inp) => { inp.yaw = Math.PI; inp.mz = 1; inp.buttons = B.SPRINT | (t >= 1.0 ? B.CROUCH : 0); }, 200 - 300 * s);
  let upEnd = -1; for (const q of up.trace) if (q.t > 1.0 && q.mvT === 0 && upEnd < 0) upEnd = q.t - 1.0;
  check("downhill slide keeps going", vd > 8, `1.2 s into a 15° downhill slide: ${vd.toFixed(2)} m/s`);
  check("uphill slide dies early", upEnd > 0 && upEnd < 0.8, `uphill slide lasted ${upEnd.toFixed(2)} s`);
}

// ---------------------------------------------------------------- air control + jump arc
{
  const r = run(open, 0, 0, 2.2, (t, inp) => { inp.mz = t < 1.2 ? 1 : 0; inp.mx = t >= 1.2 ? 1 : 0; inp.buttons = (t < 1.2 ? B.SPRINT : 0) | (t >= 1.18 && t < 1.2 ? B.JUMP : 0); });
  const air = r.trace.filter((s) => s.t > 1.2 && s.t < 1.8);
  const last = air[air.length - 1], prev = air[air.length - 2];
  const vx = (last.x - prev.x) / DT, vz = (last.z - prev.z) / DT;
  const ang = Math.atan2(vx, -vz) * 180 / Math.PI;
  const apex = Math.max(...r.trace.map((s) => s.y)) - 10;
  const vmax = Math.max(...air.map((s) => s.v));
  check("air control turns a jump", ang > 50, `heading after 0.6 s of strafing: ${ang.toFixed(0)}° (90 = full) · apex ${apex.toFixed(2)} m · max air speed ${vmax.toFixed(2)}`);
  check("air steering never adds speed", vmax <= C.SPRINT + 0.05, `max ${vmax.toFixed(2)} m/s`);
}

// ---------------------------------------------------------------- anti-tunneling (high-speed roofs & 2nd-floor walls)
{
  const PS_FREEFALL = 1, PS_GLIDE = 2;
  // 2-story house: ground floor y=10, 2nd floor y=14, thin 0.20 m roof at y=18 (top=18.0, bot=17.8), thin 0.20 m front wall at z=0
  const house = new StaticWorld(FLAT, [
    { c: [0, 14 - 0.12, -4], h: [5, 0.12, 4], surf: "wood" },      // 2nd floor slab (0.24 m)
    { c: [0, 18 - 0.10, -4], h: [5, 0.10, 4], surf: "concrete" },  // thin roof slab (0.20 m, top=18.0)
    { c: [0, 14, 0], h: [5, 4, 0.10], surf: "concrete" },          // thin exterior wall (0.20 m, z in [-0.1, +0.1])
  ] as never);

  // (a) Parachute full-speed dive straight onto thin 0.20 m roof (starts ahead so trajectory hits roof centre z ≈ -4)
  {
    const p = makePlayer(0, 0, "g", false);
    p.st = PS_GLIDE; p.x = 0; p.y = 26; p.z = 5; p.vx = 0; p.vy = -22; p.vz = -24; p.grounded = false;
    const inp = makeInput();
    for (let i = 0; i < 60; i++) {
      inp.mz = 1; inp.buttons = B.DIVE; inp.yaw = 0; inp.pitch = -1.2; inp.seq = i + 1;
      stepPlayer(p, inp, house, DT);
      if (p.st === 0) break;
    }
    check("glide full dive lands ON thin 0.20 m roof", p.st === 0 && p.y >= 17.95, `st=${p.st} y=${p.y.toFixed(2)} z=${p.z.toFixed(2)}`);
  }

  // (b) Parachute full-speed dive onto terraced pitched roof (town-kit 0.45 m steps, 0.24 m thick)
  {
    const terraces: Box[] = [];
    for (let k = 0; k < 5; k++) {
      const topY = 18.0 + (4 - k) * 0.45;
      terraces.push({ c: [0, topY - 0.12, -4 + k * 1.1], h: [5, 0.12, 0.56], surf: "metal" });
    }
    const pitched = new StaticWorld(FLAT, terraces as never);
    const p = makePlayer(0, 0, "gp", false);
    p.st = PS_GLIDE; p.x = 0; p.y = 25; p.z = 2; p.vx = 0; p.vy = -22; p.vz = -24; p.grounded = false;
    const inp = makeInput();
    for (let i = 0; i < 60; i++) {
      inp.mz = 1; inp.buttons = B.DIVE; inp.yaw = 0; inp.pitch = -1.1; inp.seq = i + 1;
      stepPlayer(p, inp, pitched, DT);
      if (p.st === 0) break;
    }
    check("glide dive lands ON terraced pitched roof", p.st === 0 && p.y >= 17.95, `st=${p.st} y=${p.y.toFixed(2)} z=${p.z.toFixed(2)}`);
  }

  // (c) Parachute flying sideways/forward at 26 m/s directly into thin 0.20 m 2nd-floor exterior wall
  {
    const p = makePlayer(0, 0, "gw", false);
    p.st = PS_GLIDE; p.x = 0; p.y = 14.8; p.z = 4.0; p.vx = 0; p.vy = -4; p.vz = -26; p.grounded = false;
    const inp = makeInput();
    let minZ = p.z;
    for (let i = 0; i < 25; i++) {
      inp.mz = 1; inp.buttons = 0; inp.yaw = 0; inp.pitch = 0; inp.seq = i + 1;
      stepPlayer(p, inp, house, DT);
      if (p.z < minZ) minZ = p.z;
    }
    check("glide 26 m/s blocked by 2nd-floor thin wall", minZ >= 0.45, `minZ=${minZ.toFixed(2)} end=(${p.z.toFixed(2)}, y=${p.y.toFixed(2)})`);
  }

  // (d) Terminal-velocity fall (-60 m/s) in PS.Ground & PS.Freefall onto razor-thin 0.16 m roof
  {
    const thinRoof = new StaticWorld(FLAT, [{ c: [0, 18 - 0.08, -4], h: [5, 0.08, 4], surf: "metal" }] as never);
    const p1 = makePlayer(0, 0, "f1", false);
    p1.st = 0; p1.x = 0; p1.y = 22; p1.z = -4; p1.vy = -60; p1.grounded = false;
    const inp = makeInput();
    for (let i = 0; i < 20; i++) { inp.seq = i + 1; stepPlayer(p1, inp, thinRoof, DT); }
    check("terminal fall (-60 m/s) stops ON 0.16 m roof", p1.grounded && p1.y >= 17.95, `grounded=${p1.grounded} y=${p1.y.toFixed(2)}`);

    const p2 = makePlayer(0, 0, "f2", false);
    p2.st = PS_FREEFALL; p2.x = 0; p2.y = 22; p2.z = -4; p2.vy = -60; p2.grounded = false;
    for (let i = 0; i < 20; i++) { inp.buttons = B.DIVE; inp.pitch = -1.4; inp.seq = i + 1; stepPlayer(p2, inp, thinRoof, DT); if (p2.st === 0) break; }
    check("freefall (-60 m/s) lands ON 0.16 m roof", p2.st === 0 && p2.y >= 17.95, `st=${p2.st} y=${p2.y.toFixed(2)}`);
  }

  // (e) Fast 25 m/s horizontal dash at thin 0.20 m 2nd-floor wall
  {
    const p = makePlayer(0, 0, "gr", false);
    p.st = 0; p.x = 0; p.y = 14.5; p.z = 2.0; p.vx = 0; p.vy = 2; p.vz = -25; p.grounded = false;
    const inp = makeInput();
    let minZ = p.z;
    for (let i = 0; i < 20; i++) {
      inp.mz = 1; inp.buttons = B.SPRINT; inp.yaw = 0; inp.seq = i + 1;
      stepPlayer(p, inp, house, DT);
      if (p.z < minZ) minZ = p.z;
    }
    check("fast 25 m/s dash blocked by thin 2nd-floor wall", minZ >= 0.45, `minZ=${minZ.toFixed(2)} end=(${p.z.toFixed(2)}, y=${p.y.toFixed(2)})`);
  }
}

// ---------------------------------------------------------------- determinism (prediction == server)
{
  const w = ledge(1.9);
  const script = (t: number, inp: ReturnType<typeof makeInput>) => { inp.mz = 1; inp.yaw = Math.sin(t * 1.3) * 0.2; inp.buttons = B.SPRINT | (t > 0.6 && t < 0.9 ? B.CROUCH : 0) | (t > 1.1 ? B.JUMP : 0); };
  const a = run(w, 0.3, 8, 4, script), b = run(w, 0.3, 8, 4, script);
  const same = a.trace.every((s, i) => s.x === b.trace[i].x && s.y === b.trace[i].y && s.z === b.trace[i].z && s.st === b.trace[i].st);
  check("deterministic replay", same && a.mantled, `mantled=${a.mantled} identical=${same}`);
}

const fails = results.filter((r) => !r.pass);
console.log(`\n${results.length - fails.length}/${results.length} pass`);
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ at: new Date().toISOString(), results }, null, 1));
process.exit(fails.length ? 1 : 0);
