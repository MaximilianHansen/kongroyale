// FLAT TYRES TEST: the real shared/sim stepVehicle and rayVehicle on a flat synthetic world.
//   npx tsx tools/tuk/tyres-test.mts
// Asserts (exit code 1 on any failure):
//   shots:    a ray at each tyre names that tyre, from the side and from low in front; a ray at the cabin names none.
//   handling: sound tyres run straight; a flat rear tyre pulls to its own side, and steering the other way holds a line;
//             a flat front tyre leaves a small part of a full-lock turn and two flat rears a smaller turn than sound ones.
//   match:    a real shot through Match.resolveShot flattens the tyre it meets and no other, and raises VK.Tyre once.
//   wire:     the flat tyres survive the vehicle entry and the driver's self block, alongside the radio and `air`.
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const { Terrain } = await import(ROOT + "/shared/world/terrain.ts");
const { WORLD } = await import(ROOT + "/shared/world/map.ts");
const { StaticWorld } = await import(ROOT + "/shared/sim/world.ts");
const Veh = await import(ROOT + "/shared/sim/vehicle.ts");
const { DT } = await import(ROOT + "/shared/sim/const.ts");
const Proto = await import(ROOT + "/shared/net/proto.ts");
const { makePlayer, makeInput, eyeY, SK } = await import(ROOT + "/shared/sim/player.ts");
const { Match } = await import(ROOT + "/shared/sim/match.ts");
const { TUK, TYRE, VKind, makeVehicle, spawnVehicle, stepVehicle, rayVehicle, vehPose } = Veh;

const res = Math.round((2 * WORLD.HALF) / WORLD.CELL) + 1;
const world = new StaticWorld(new Terrain(new Float32Array(res * res).fill(10), new Uint8Array(res * res)), [] as never);
let failed = 0;
const check = (name: string, pass: boolean, detail: string) => { if (!pass) failed++; console.log(`${pass ? "PASS" : "FAIL"}  ${name.padEnd(44)} ${detail}`); };
const deg = (a: number) => (a * 180) / Math.PI;

/** flat out for 2 s, then `secs` with `str` held: how far the heading swung, + = left (degrees) */
function swing(tyres: number, str: number | ((v: ReturnType<typeof makeVehicle>) => number), secs = 3) {
  const v = makeVehicle(0);
  spawnVehicle(v, world, 0, 0, 0); v.flags = 0;
  for (let i = 0; i < 2 / DT; i++) stepVehicle(v, world, 1, 0, false, DT);
  v.tyres = tyres;
  const y0 = v.yaw;
  let turned = 0, last = y0;
  for (let i = 0; i < secs / DT; i++) {
    stepVehicle(v, world, 1, typeof str === "number" ? str : str(v), false, DT);
    let d = v.yaw - last; if (d > Math.PI) d -= Math.PI * 2; else if (d < -Math.PI) d += Math.PI * 2;
    turned += d; last = v.yaw;
  }
  return deg(turned);
}

// ---- shots
{
  const v = makeVehicle(0);
  spawnVehicle(v, world, 0, 0, 0);
  const P = vehPose(v, new Float64Array(6)), y = v.y;
  const ray = (ox: number, oy: number, oz: number, dx: number, dy: number, dz: number) => { const n = Math.hypot(dx, dy, dz), t = rayVehicle(P, VKind.Tuk, ox, oy, oz, dx / n, dy / n, dz / n, 50); return { t, tyre: Veh.RAY_TYRE }; };
  check("side shot at the rear left tyre", ray(-20, y + 0.3, TUK.REAR, 1, 0, 0).tyre === 1, `tyre ${ray(-20, y + 0.3, TUK.REAR, 1, 0, 0).tyre}`);
  check("side shot at the rear right tyre", ray(20, y + 0.3, TUK.REAR, -1, 0, 0).tyre === 2, `tyre ${ray(20, y + 0.3, TUK.REAR, -1, 0, 0).tyre}`);
  check("shot at the front tyre from ahead", ray(0, y + 0.3, -20, 0, 0, 1).tyre === 0, `tyre ${ray(0, y + 0.3, -20, 0, 0, 1).tyre}`);
  check("low side shot at the front tyre", ray(-20, y + 0.2, -TUK.FRONT, 1, 0, 0).tyre === 0, `tyre ${ray(-20, y + 0.2, -TUK.FRONT, 1, 0, 0).tyre}`);
  const cab = ray(-20, y + 0.8, 0, 1, 0, 0);
  check("a panel is no tyre", cab.t > 0 && cab.tyre === -1, `tyre ${cab.tyre}`);
}

// ---- handling
{
  const sound = swing(0, 0), left = swing(TYRE.LEFT, 0), right = swing(TYRE.RIGHT, 0);
  check("sound tyres run straight", Math.abs(sound) < 0.01, `${sound.toFixed(3)}°`);
  check("a flat left tyre pulls left", left > 30 && left < 120, `${left.toFixed(1)}° in 3 s`);
  check("a flat right tyre pulls right", right < -30 && right > -120, `${right.toFixed(1)}° in 3 s`);
  // the driver taps against the pull: held bars at the share of full lock that cancels it
  const held = swing(TYRE.LEFT, (v) => { const lock = TUK.STEER_LO + (TUK.STEER_HI - TUK.STEER_LO) * Math.min(1, Math.abs(v.vx * Math.sin(v.yaw) + v.vz * Math.cos(v.yaw)) / TUK.VMAX); return TUK.FLAT_PULL / lock; });
  check("steering against the pull holds a line", Math.abs(held) < 5, `${held.toFixed(1)}°`);
  const full = swing(0, -1, 1), front = swing(TYRE.FRONT, -1, 1), rears = swing(TYRE.LEFT | TYRE.RIGHT, -1, 1);
  check("a flat front tyre barely steers", Math.abs(front) < Math.abs(full) * 0.25, `${front.toFixed(1)}° of ${full.toFixed(1)}° in 1 s`);
  check("two flat rears run straight, steer less", Math.abs(swing(TYRE.LEFT | TYRE.RIGHT, 0)) < 0.01 && Math.abs(rears) < Math.abs(full) * 0.8, `${rears.toFixed(1)}° of ${full.toFixed(1)}° in 1 s`);
}

// ---- match
{
  const m = new Match({ seed: 7, mode: "solo", world, humans: [{ id: 0, name: "T", team: 0 }] }) as never as { players: Array<ReturnType<typeof makePlayer>>; vehs: { list: Array<ReturnType<typeof makeVehicle>> }; tick: number; resolveShot(p: unknown, i: unknown): void; ev: { veh(...a: number[]): void } };
  const p = m.players[0], v = m.vehs.list.find((q) => q.st === Veh.VS.Gone)!;
  spawnVehicle(v, world, 0, 0, 0);
  for (const q of m.vehs.list) if (q !== v) q.st = Veh.VS.Gone;
  p.x = -4; p.z = TUK.REAR; p.y = v.y; p.st = 0; p.grounded = true; p.crouch = false;
  const s = p.slots[0]; s.kind = SK.Weapon; s.id = 0; s.rarity = 0; s.mag = 99; s.count = 1; p.active = 0;
  const tx = -TUK.HW, ty = v.y + 0.3, tz = TUK.REAR;
  p.yaw = Math.atan2(-(tx - p.x), -(tz - p.z)); p.pitch = Math.atan2(ty - eyeY(p), Math.hypot(tx - p.x, tz - p.z));
  let events = 0; const veh = m.ev.veh.bind(m.ev); m.ev.veh = (...a) => { if (a[1] === 12 /* VK.Tyre: a const enum, gone at run time */) events++; veh(...a); };
  const inp = makeInput(); inp.lerpA = m.tick - 1;
  for (let i = 0; i < 40; i++) { p.fired = 1; p.shotSeq++; m.resolveShot(p, inp); }
  check("a shot flattens the tyre it meets", v.tyres === TYRE.LEFT, `tyres ${v.tyres}`);
  check("the burst is announced once", events === 1, `${events} event(s)`);
}

// ---- wire
{
  const v = makeVehicle(3);
  spawnVehicle(v, world, 0, 0, 0); v.tyres = TYRE.FRONT | TYRE.RIGHT; v.radio = 1; v.air = true;
  const w = new Proto.Writer(new ArrayBuffer(4096));
  Proto.writeVehicle(w, v);
  const s = Proto.makeVehSnap(); Proto.readVehicle(new Proto.Reader(w.view()), s);
  check("vehicle entry carries the tyres", s.tyres === v.tyres && s.radio === 1, `tyres ${s.tyres}, radio ${s.radio}`);
  const p = makePlayer(0, 0, "t", false); p.st = 8; p.seat = 0; p.veh = 3;
  const w2 = new Proto.Writer(new ArrayBuffer(4096));
  Proto.writeSelf(w2, p, v);
  const o = Proto.makeSelfState(); Proto.readSelf(new Proto.Reader(w2.view()), o);
  check("self block carries the tyres", o.drive && o.v.tyres === v.tyres && o.v.air, `tyres ${o.v.tyres}, air ${o.v.air}`);
}
process.exit(failed ? 1 : 0);
