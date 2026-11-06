// HELICOPTERS — KONG AIR's three-seater. One kong flies it, two sit in the open doors with their feet on the skids
// and shoot at whatever goes past. Three wait on helipads round the island (shared/sim/heli-spots.ts); one more stands
// on the warm-up islet and one at the firing range.
//
// It is a Vehicle (shared/sim/vehicle.ts) of kind VKind.Heli: the same slots, seats, snapshot entries, prediction and
// lag compensation as the tuk-tuk. Its predicted fields are reused — `steer` = the rotor's spool (0..1), `tip` = the
// collective (−1..1), `tipV` = the yaw rate (rad/s), `gPitch` / `gRoll` = its attitude, `air` = off the skids, `hopT` =
// the seconds its stick has been empty in the air (with a pilot: NO_PILOT_S while the rotor is still below lift — the
// HUD's recovering chip) — so the driver's self block and the client's prediction ring carry it unchanged.
//
// The feel:
//   • the rotor spools up for ~3 s after the pilot climbs in; past LIFT_SPOOL the collective lifts it. Jump = up,
//     descend = down (the triggers on a controller), it hovers when neither is held
//   • the stick tilts it: nose down to go, bank to slide sideways; the pilot's look (mouse / right stick) is the heading
//     it turns toward, at most YAW_MAX rad/s — it is a helicopter, it lags
//   • a soft landing on level ground costs nothing; harder than LAND_V hurts; harder than FATAL_LAND_V, sideways faster
//     than FATAL_SLIDE_V or rolled past ROLL_TILT ends it — a helicopter that rolls over goes up at once. Set down
//     crooked (past FATAL_TILT) or onto a slope steeper than SLOPE_MAX it bangs down hurt by how fast it came (ROUGH_*)
//     and slides off a slope it cannot stand on. A wall at speed dents it; a wall
//     at FATAL_CRASH_V ends it
//   • at zero hull the engine burns: the rotor winds down, it falls, and it explodes on the fuse or on touching down,
//     whichever comes first. Everybody aboard is thrown out into the blast
//   • nobody at the stick in the air: no hover, ever. The collective sags at once
//     (it sinks), the rotor winds down (lift fades, the nose dips) and it falls — normal crash rules on impact: from a
//     low hover it bangs down hurt, from high up it is wrecked. Whoever takes the stick (C / a seat key) before it hits
//     gets it back once the rotor has spooled up past LIFT_SPOOL again (the recovery delay)
//   • the rotor is a weapon: the blade disc as it tilts, and the
//     tail fan, kill a kong they touch (inRotor) — dip the nose or bank into one; a level landing beside kongs is safe
//   • TOP BANANA, the door gun (seat GUN_SEAT, the left door): its kong's own guns are holstered, FIRE spins the barrels
//     up and hoses rounds out of the door — a finite belt on the helicopter, heat that locks it when held too long, a
//     heavy turret that swings after the gunner's look within an arc (stepGun / gunBarrel below)
// Frames, quantisation and the zero-allocation rule are vehicle.ts's. Pure in (state, pilot input, static world).
import { GRAVITY, PLAYER_R, WATER_LEVEL, qpos } from "./const";
import { makeHit, type StaticWorld } from "./world";
import { HELI_HOOKS, RIDE_ST, SPEC, VE, VF, VKind, VS, vehBasis, type Vehicle, type VehSpec } from "./vehicle";
import * as dmath from "./dmath";

export const HELI = {
  HP: 1000,
  // ---- the rotor: seconds to full speed, seconds to wind down, the spool it lifts from
  SPOOL_UP: 3.2, SPOOL_DOWN: 7, LIFT_SPOOL: 0.8,
  /** nobody at the stick in the air: the collective drops to 0 at COLL_RATE and keeps sagging toward −1 at NO_PILOT_SAG /s (it sinks at once),
   * the rotor winds down from full in SPOOL_DOWN_AIR s (below LIFT_SPOOL after NO_PILOT_S s: the lift fades, the nose
   * dips toward NO_PILOT_NOSE rad as it does) and it falls, at up to FALL_V m/s (a rock, not a meteor). No hover
   * damping without a pilot. A pilot who takes over spools it back up (SPOOL_UP) — full lift = control again */
  NO_PILOT_S: 1.2, SPOOL_DOWN_AIR: 6, NO_PILOT_SAG: 0.6, NO_PILOT_NOSE: 0.22, FALL_V: 40,
  // ---- the collective: how fast it follows the button (1/s), climb push (m/s²), the climb / descent it settles at
  // (m/s), how hard a hover kills vertical drift (1/s)
  COLL_RATE: 2.4, CLIMB_ACC: 9, VY_UP: 11, VY_DOWN: 12, HOVER_DAMP: 3.2,
  /** within SETTLE_H m of the ground, a pilot with hands off (no UP, the stick centred) sinks onto the skids at SETTLE_V m/s */
  SETTLE_H: 3.0, SETTLE_V: 1.2,
  // ---- the cyclic: attitude limits (rad) and how fast the attitude follows the stick (1/s)
  PITCH_MAX: 0.42, ROLL_MAX: 0.36, ATT_RATE: 3.6,
  /** horizontal push at full tilt (m/s²), air drag (× v·|v|) and a little linear drag: ≈ 30 m/s flat out forward */
  TILT_ACC: 12.5, DRAG: 0.0125, LIN: 0.06,
  // ---- the pedals: yaw rate limit (rad/s), how fast the rate builds (1/s), how hard it chases the pilot's look (1/s)
  YAW_MAX: 1.9, YAW_RATE: 6, YAW_K: 3.2,
  // ---- the skids: their corners (half width, half length), friction on the ground (m/s²), the slope it stands on —
  // steeper than that it slides down (its skids' friction there, m/s²: TOO STEEP TO LAND)
  SKID_X: 1.162, SKID_Z: 1.482, GROUND_FRICTION: 9, SLOPE_MAX: 0.3, SLIDE_FRICTION: 2.5,
  // ---- the body for walls: [offset along the spine (+ = back), radius] of the nose, the cabin, the boom and the fin
  // with its fan; the engine deck's top (the model: public/assets/vehicles/heli/kong-air.glb, 7.3 m long)
  CIRCLES: [[-1.221, 0.926], [0.716, 1.053], [3.032, 0.463], [4.632, 0.758]] as ReadonlyArray<readonly [number, number]>, CAP_H: 2.821, BOUNCE: 0.15,
  /** the rotor disc (m), its hub's height over the skids and its offset back from the middle (the model's mast) */
  ROTOR_R: 4.0, ROTOR_Y: 3.03, HUB_Z: 0.464,
  /** it flies no higher than this (m above the sea; Ripe Peak's summit is 264 m): the climb fades over the last
   * CEIL_SOFT m (thin air) instead of meeting a lid */
  CEIL: 330, CEIL_SOFT: 40,
  // ---- damage
  LAND_V: 5, LAND_DMG: 45, FATAL_LAND_V: 14, FATAL_SLIDE_V: 9, FATAL_TILT: 0.3, CRASH_V: 4, CRASH_DMG: 28, FATAL_CRASH_V: 15,
  /** set down crooked (past FATAL_TILT) or onto a slope steeper than SLOPE_MAX: a rough landing, ROUGH_DMG +
   * ROUGH_DMG_V per m/s it came in at (down and sideways together) — fatal only faster than ROUGH_V, or rolled past
   * ROLL_TILT (on its side) */
  ROUGH_V: 8, ROUGH_DMG: 40, ROUGH_DMG_V: 35, ROLL_TILT: 0.7,
  /** what the rotor does to a kong it touches (the blade disc as it tilts, ±CHOP_BAND m round its plane — the blades
   * flex; level on the skids it still clears a standing kong's head by 0.33 m — and the tail fan, a ball of FAN_R m at
   * FAN in the body frame): any kong, any shield */
  ROTOR_DMG: 1000, CHOP_BAND: 0.8, FAN: [-0.741, 1.836, 4.783] as readonly [number, number, number], FAN_R: 0.5,
  /** this deep in the water it is lost */
  SINK: 0.3,
  // ---- TOP BANANA: the door-mounted minigun in the LEFT door (seat GUN_SEAT). Geometry in the body frame [right, up,
  // back] — the model's gun (client/src/actors/heli*.ts) is built round GUN_PIVOT and reaches GUN_LEN out to the muzzle
  /** the seat that mans it: its kong's own guns are holstered there, FIRE fires the minigun */
  GUN_SEAT: 1,
  /** the turret's pivot (the yoke the gun swings on, on its post in the left door) */
  GUN_PIVOT: [-0.8, 1.27, 0.52] as readonly [number, number, number],
  /** from the pivot along the barrels to the muzzle (m) */
  GUN_LEN: 1.0,
  /** the arc: yaw either side of the left door's normal (−X; + = toward the nose), pitch relative to the body (rad) */
  GUN_ARC_YAW: (75 * Math.PI) / 180, GUN_PITCH_MIN: (-60 * Math.PI) / 180, GUN_PITCH_MAX: (20 * Math.PI) / 180,
  /** an unmanned gun swings back to this (body-relative yaw, pitch: out of the door, a little nose-down) */
  GUN_REST_YAW: 0, GUN_REST_PITCH: -0.15,
  /** how fast the gun swings after the gunner's look (rad/s): a heavy gun */
  GUN_SLEW: 4.5,
  /** rounds on the belt of a fresh helicopter (no reload: the belt is the helicopter's), rounds per minute */
  GUN_BELT: 500, GUN_RPM: 1200,
  /** seconds for the barrels to spin up from rest before the first round, and to spin down once released */
  GUN_SPIN_UP: 0.4, GUN_SPIN_DOWN: 1.2,
  /** heat per round (100 rounds ≈ 5 s of fire overheats it), cooling per second once no round has left for
   * GUN_COOL_DELAY s; overheated (at 1) it will not fire again until it is down to GUN_UNLOCK */
  GUN_HEAT: 0.01, GUN_COOL: 0.45, GUN_COOL_DELAY: 0.25, GUN_UNLOCK: 0.25,
  /** spread cone (deg) cold, and what full heat adds to it */
  GUN_SPREAD: 1.6, GUN_SPREAD_HOT: 1.5,
} as const;
/** TOP BANANA's rounds (the damage shape shared/sim/player.ts pelletDamage reads; hitscan like the other guns) */
export const TOP_BANANA = { name: "TOP BANANA", dmg: 14, headMul: 1.5, falloff: [60, 160, 0.6] as [number, number, number] };

/** the helicopter's shape for vehicle.ts: seats in the body frame [right, up, back] (the rider's feet), exits, panels.
 * 0 = the pilot, 1 = the door gunner behind TOP BANANA (left door), 2 = the passenger in the right door (own guns). */
export const HELI_SPEC: VehSpec = {
  HP: HELI.HP,
  SEATS: [[0, 0.615, -0.8], [-0.04, 0.615, 0.55], [0.674, 0.615, 0.632]],
  EXITS: [
    [[-1.768, -0.842], [1.768, -0.842], [-1.853, 1.263], [1.853, 1.263], [0, -2.863], [0, 5.895]],
    [[-1.853, 1.263], [-1.768, -0.505], [1.853, 0.632], [0, -2.863], [0, 5.895]],
    [[1.853, 0.632], [1.768, -0.421], [-1.853, 1.263], [0, -2.863], [0, 5.895]],
  ],
  // the belly, the chin under the canopy, the dash, the roof, the engine cowling, the cabin's rear wall, the pillars
  // between the cockpit's and the cabin's openings, the tail boom, the fin, the fan's duct. Both cabin doors are open
  // and the canopy is glass: the riders are open from the floor up, the pilot through the bubble
  HITBOXES: [
    [0, 0.421, 0, 0.859, 0.202, 1.6],
    [0, 0.716, -1.684, 0.758, 0.295, 0.337],
    [0, 1.137, -1.432, 0.716, 0.126, 0.168],
    [0, 2.147, 0.253, 0.842, 0.084, 1.347],
    [0, 2.526, 0.632, 0.589, 0.295, 1.011],
    [0, 1.347, 1.642, 0.842, 0.758, 0.084],
    [-0.842, 1.347, -0.295, 0.051, 0.758, 0.084], [0.842, 1.347, -0.295, 0.051, 0.758, 0.084],
    [0, 2.021, 3.284, 0.337, 0.337, 1.6],
    [0, 2.947, 4.842, 0.067, 0.758, 0.421],
    [-0.741, 1.836, 4.783, 0.143, 0.396, 0.396],
  ],
  BALL_Y: 1.684, BALL_R2: 44,
  FOOT_HW: 1.263, FOOT_HL: 1.853, FOOT_Z: -0.211, ROOF: 2.232, REACH: 2.6,
  BLAST_R: 12, BLAST_DMG: 260, BLAST_CORE: 3.6, BLAST_RIM: 0.1, SPLASH_MUL: 2.4, ROCKET_MUL: 3,
  // (a burnt-out wreck lies there for two minutes, then settles into the ground — match.ts)
  FUSE_S: 3.2, WRECK_S: 120, RAM_V: 4, RAM_DMG: 12,
};
SPEC[VKind.Heli] = HELI_SPEC;

const TAU = Math.PI * 2;
const wrapPi = (a: number) => { a %= TAU; return a > Math.PI ? a - TAU : a <= -Math.PI ? a + TAU : a; };
const GH = makeHit();
/** skid register: [ground under the skids, its pitch, its roll, the surface] */
const SK = new Float64Array(4);
let USURF = 255;
/** the surface under (x, z) within reach of a skid at height y: the terrain, or the top of a box standing on it */
function under(world: StaticWorld, x: number, y: number, z: number): number {
  const th = world.terrain.height(x, z);
  world.raycast(x, y + 1.0, z, 0, -1, 0, 3.2, GH, false);
  if (GH.hit && GH.box >= 0) { const top = world.cy[GH.box] + world.hy[GH.box]; if (top > th) { USURF = GH.surf; return top; } }
  USURF = 255;
  return th;
}
/** the ground under the four skid corners as it stands (yaw, y) → SK: the height the skids rest at (the highest
 * corner, so a skid never sinks into a step), the slope under them */
function skids(v: Vehicle, world: StaticWorld) {
  const sy = dmath.sin(v.yaw), cy = dmath.cos(v.yaw), fx = -sy, fz = -cy, rx = cy, rz = -sy;
  const X = HELI.SKID_X, Z = HELI.SKID_Z;
  const hFL = under(world, v.x + fx * Z - rx * X, v.y, v.z + fz * Z - rz * X); const surf = USURF;
  const hFR = under(world, v.x + fx * Z + rx * X, v.y, v.z + fz * Z + rz * X);
  const hBL = under(world, v.x - fx * Z - rx * X, v.y, v.z - fz * Z - rz * X);
  const hBR = under(world, v.x - fx * Z + rx * X, v.y, v.z - fz * Z + rz * X);
  const f = (hFL + hFR) * 0.5, b = (hBL + hBR) * 0.5, l = (hFL + hBL) * 0.5, r = (hFR + hBR) * 0.5;
  SK[0] = Math.max(hFL, hFR, hBL, hBR);
  SK[1] = Math.max(-1.1, Math.min(1.1, dmath.atan2(f - b, 2 * Z)));
  SK[2] = Math.max(-1.1, Math.min(1.1, dmath.atan2(r - l, 2 * X)));
  SK[3] = surf;
  // over the sea the skids meet the water, which is level — not the seabed's slope under it (else a slow touchdown on
  // the sea over a sloping seabed would count as a landing on a cliff)
  if (WATER_LEVEL - HELI.SINK * 0.5 > SK[0]) { SK[1] = 0; SK[2] = 0; }
}
/** a parked helicopter: on its skids, level with the ground under them */
function settle(v: Vehicle, world: StaticWorld) {
  v.y = world.ground(v.x, v.z) + 0.5;
  skids(v, world);
  v.y = qpos(SK[0]); v.gPitch = SK[1]; v.gRoll = SK[2]; v.surf = SK[3]; v.air = false; v.steer = 0; v.tip = 0; v.tipV = 0;
}
HELI_HOOKS.settle = settle;

/**
 * One deterministic tick of a helicopter. `thr` −1..1 (nose down / up), `str` −1..1 (bank right +), `up` / `down` the
 * collective, `yawCmd` the heading the pilot asks for (its look yaw), `pilot` = somebody holds the stick (else, in the
 * air, it sinks and falls: the rotor winds down — a rider who takes the stick in time spools it back up). Raises `evt`
 * bits for the match:
 * VE.LAND (a hard landing, crashV = how hard), VE.CRASH (a
 * wall, crashV), VE.TIP (it is finished: rolled over on landing, flown into something too fast, or touched down on fire),
 * VE.SUNK.
 */
export function stepHeli(v: Vehicle, world: StaticWorld, thr: number, str: number, up: boolean, down: boolean, yawCmd: number, pilot: boolean, dt: number): void {
  v.flags &= ~(VF.SKID | VF.BRAKE | VF.REV | VF.AIR);
  if (v.st === VS.Wreck) { if (v.air) fall(v, world, dt); return; }
  if (v.st !== VS.Ok) return;
  const burning = (v.flags & VF.BURN) !== 0;
  if (burning) pilot = false;
  // (the ground under THIS helicopter's skids: the register is shared, another one's step may have run since its last)
  if (!v.air) skids(v, world);
  // ---- nobody at the stick in the air: hopT counts the empty seconds
  // (the HUD); the rotor winds down, the collective sags, nothing holds it up. A pilot back at the stick spools the rotor
  // up again — while it is still below lift, hopT = NO_PILOT_S (the pilot's ROTOR RECOVERING chip). On the skids: 0
  const alone = v.air && !pilot && !burning;
  // ---- the rotor spools up with a pilot aboard and winds down without one — slowly on the ground, faster in the air
  // (nothing drives it there) — and sags on fire
  const wantSpool = burning ? 0.55 : pilot ? 1 : 0, ds = wantSpool - v.steer;
  v.steer += ds > 0 ? Math.min(ds, dt / HELI.SPOOL_UP) : Math.max(ds, -dt / (v.air && !pilot ? HELI.SPOOL_DOWN_AIR : HELI.SPOOL_DOWN));
  const L = v.steer >= HELI.LIFT_SPOOL ? 1 : (v.steer / HELI.LIFT_SPOOL) * (v.steer / HELI.LIFT_SPOOL);
  v.hopT = !v.air ? 0 : alone ? v.hopT + dt : pilot && L < 0.999 ? HELI.NO_PILOT_S : 0;
  // ---- the collective follows the buttons; nobody at the stick: it falls back to 0 at once and sags on toward −1 (it
  // sinks, then drops); on fire it sinks
  const wantColl = burning ? (v.air ? -0.45 : 0) : !pilot ? (v.air ? -1 : 0) : up && !down ? 1 : down && !up ? -1 : 0, dc = wantColl - v.tip;
  const mc = (alone && v.tip <= 0 ? HELI.NO_PILOT_SAG : HELI.COLL_RATE) * dt;
  v.tip += dc > mc ? mc : dc < -mc ? -mc : dc;
  let coll = L < 0.999 ? Math.min(0, v.tip) : v.tip;                         // no lift yet: the collective can only drop it
  // thin air under the ceiling: the climb fades out over its last CEIL_SOFT m (it hovers there)
  if (coll > 0 && v.y > HELI.CEIL - HELI.CEIL_SOFT) coll *= Math.max(0, (HELI.CEIL - v.y) / HELI.CEIL_SOFT);
  // ---- attitude: in the air the stick tilts it, on the ground it sits on the slope
  const k = 1 - dmath.exp(-HELI.ATT_RATE * dt);
  if (v.air) {
    // (alone: the nose dips as the lift goes)
    const tp = pilot ? -thr * HELI.PITCH_MAX : alone ? -HELI.NO_PILOT_NOSE * (1 - L) : 0, tr = pilot ? -str * HELI.ROLL_MAX : 0;
    v.gPitch += (tp - v.gPitch) * k; v.gRoll += (tr - v.gRoll) * k;
  } else { v.gPitch += (SK[1] - v.gPitch) * k; v.gRoll += (SK[2] - v.gRoll) * k; }
  // ---- heading: the yaw rate chases the pilot's look (shortest way round), builds and dies with a lag
  const wantRate = pilot && (v.air || L > 0.5) ? Math.max(-HELI.YAW_MAX, Math.min(HELI.YAW_MAX, wrapPi(yawCmd - v.yaw) * HELI.YAW_K)) * (v.air ? 1 : 0.5) : 0;
  v.tipV += (wantRate - v.tipV) * (1 - dmath.exp(-HELI.YAW_RATE * dt));
  if (Math.abs(v.tipV) > 1e-5) v.yaw = wrapPi(v.yaw + v.tipV * dt);
  const sy = dmath.sin(v.yaw), cy = dmath.cos(v.yaw), fx = -sy, fz = -cy, rx = cy, rz = -sy;
  // ---- the rotor's push: along the tilt, scaled by how much lift there is
  const thrust = L * (1 + coll * (HELI.CLIMB_ACC / GRAVITY));
  if (v.air) {
    const TK = HELI.TILT_ACC / dmath.sin(HELI.PITCH_MAX);
    const af = -dmath.sin(v.gPitch) * TK * L, al = -dmath.sin(v.gRoll) * TK * L;
    v.vx += (fx * af + rx * al) * dt; v.vz += (fz * af + rz * al) * dt;
    const vh = dmath.hypot(v.vx, v.vz), d = Math.min(0.95, (HELI.DRAG * vh + HELI.LIN) * dt);
    v.vx -= v.vx * d; v.vz -= v.vz * d;
    // (a pilot's hands hold the hover; nobody at the stick, nothing does)
    const damp = pilot ? HELI.HOVER_DAMP * (1 - Math.abs(coll)) * L : 0;
    v.vy += (GRAVITY * (thrust - 1) - damp * v.vy) * dt;
    const vyMin = -HELI.VY_DOWN - (1 - L) * (HELI.FALL_V - HELI.VY_DOWN);
    if (v.vy > HELI.VY_UP) v.vy = HELI.VY_UP; else if (v.vy < vyMin) v.vy = vyMin;
  } else {
    // on the skids: they hold the ground — on a slope too steep to stand on it slides down it, gravity along the
    // fall line against the skids' sliding friction — and the collective can lift it off
    let f = HELI.GROUND_FRICTION * dt;
    if (Math.max(Math.abs(SK[1]), Math.abs(SK[2])) > HELI.SLOPE_MAX) {
      // downhill: the tail when the nose is up the slope, the left side when the right one is
      const g = GRAVITY * dt, sp = dmath.sin(SK[1]), sr = dmath.sin(SK[2]);
      v.vx -= (fx * sp + rx * sr) * g; v.vz -= (fz * sp + rz * sr) * g;
      f = HELI.SLIDE_FRICTION * dt;
    }
    const vh = dmath.hypot(v.vx, v.vz);
    if (vh <= f) { v.vx = 0; v.vz = 0; } else { const q = 1 - f / vh; v.vx *= q; v.vz *= q; }
    v.vy = 0;
    if (thrust > 1.001) { v.air = true; v.vy = 0.4; }
  }
  // (hands off = no UP and the stick centred — a pilot flying low with the stick over is not set down: pulling a low
  // pass onto its skids at speed would be fatal)
  SETTLE = pilot && !up && Math.abs(thr) < 0.15 && Math.abs(str) < 0.15;
  move(v, world, dt);
  if (v.air) v.flags |= VF.AIR;
}

/** this tick's pilot is letting it settle (a pilot aboard, UP not held): move() lets the last metre down */
let SETTLE = false;
/** integrate, collide the cabin and the tail with the world, meet the ground */
function move(v: Vehicle, world: StaticWorld, dt: number) {
  const x0 = v.x, z0 = v.z, sy0 = dmath.sin(v.yaw), cy0 = dmath.cos(v.yaw);
  v.x += v.vx * dt; v.z += v.vz * dt;
  let impact = 0;
  for (let c = 0; c < HELI.CIRCLES.length; c++) {
    const off = HELI.CIRCLES[c][0], r = HELI.CIRCLES[c][1];
    const sy = dmath.sin(v.yaw), cy = dmath.cos(v.yaw);
    const cx = v.x + sy * off, cz = v.z + cy * off, by = v.y + 0.3;
    world.velY = 0; world.wallHit = false; world.headBump = false;
    world.resolveMove(cx, by, cz, cx - (x0 + sy0 * off), 0, cz - (z0 + cy0 * off), r, c < 2 ? HELI.CAP_H - 0.3 : 1.6, false);
    const px = world.P[0] - cx, pz = world.P[2] - cz, pl = dmath.hypot(px, pz);
    if (pl < 1e-7) continue;
    v.x += px; v.z += pz;
    const nx = px / pl, nz = pz / pl, vn = v.vx * nx + v.vz * nz;
    // a glancing wall turns it away (the circle's lever arm along the spine)
    const lx = sy * off, lz = cy * off;
    v.yaw = wrapPi(v.yaw + 0.3 * (lz * px - lx * pz) / (off * off + 0.5));
    if (vn < 0) {
      if (-vn > impact && !world.depen) impact = -vn;
      v.vx -= nx * vn * (1 + HELI.BOUNCE); v.vz -= nz * vn * (1 + HELI.BOUNCE);
    }
  }
  if (impact > HELI.CRASH_V) { v.evt |= impact > HELI.FATAL_CRASH_V ? VE.TIP | VE.CRASH : VE.CRASH; if (impact > v.crashV) v.crashV = impact; }
  // world bounds, the ceiling
  const lim = world.terrain.half - 6;
  if (v.x > lim) { v.x = lim; v.vx = 0; } else if (v.x < -lim) { v.x = -lim; v.vx = 0; }
  if (v.z > lim) { v.z = lim; v.vz = 0; } else if (v.z < -lim) { v.z = -lim; v.vz = 0; }
  // ---- the ground under the skids (the sea counts as a floor it cannot land on)
  skids(v, world);
  const yG = Math.max(SK[0], WATER_LEVEL - HELI.SINK * 0.5);
  v.surf = SK[3];
  if (v.air) {
    // the last few metres: a pilot who is not holding UP is let down onto the skids at SETTLE_V (else a hands-off hover
    // just over the grass never touches down — it hangs 0.5–2 m up for good)
    if (SETTLE && v.y - yG < HELI.SETTLE_H && v.vy > -HELI.SETTLE_V) v.vy = Math.max(-HELI.SETTLE_V, v.vy - 4 * dt);
    v.y += v.vy * dt;
    if (v.y > HELI.CEIL) { v.y = HELI.CEIL; if (v.vy > 0) v.vy = 0; }
    if (v.y <= yG) {
      // touchdown: how hard, how fast sideways, how tilted, how steep — the rules above
      const hit = -v.vy, hs = dmath.hypot(v.vx, v.vz), tilt = Math.max(Math.abs(v.gPitch - SK[1]), Math.abs(v.gRoll - SK[2])), slope = Math.max(Math.abs(SK[1]), Math.abs(SK[2]));
      v.y = yG; v.vy = 0; v.air = false;
      if (v.flags & VF.BURN) { v.evt |= VE.TIP; if (hit > v.crashV) v.crashV = hit; }
      else if (hit > HELI.FATAL_LAND_V || hs > HELI.FATAL_SLIDE_V || tilt > HELI.ROLL_TILT) { v.evt |= VE.TIP | VE.LAND; if (hit > v.crashV) v.crashV = hit; }
      else if (tilt > HELI.FATAL_TILT || slope > HELI.SLOPE_MAX) {
        // a rough landing — set down crooked, or onto a slope it cannot stand on (it slides off: stepHeli): it
        // bangs down, hurt by how fast it came in (the match charges LAND_DMG per m/s of crashV over LAND_V, so crashV
        // carries that damage); only a fast one is the end
        const sev = dmath.hypot(hit, hs);
        if (sev > HELI.ROUGH_V) { v.evt |= VE.TIP | VE.LAND; if (hit > v.crashV) v.crashV = hit; }
        else { v.evt |= VE.LAND; const cv = HELI.LAND_V + (HELI.ROUGH_DMG + HELI.ROUGH_DMG_V * sev) / HELI.LAND_DMG; if (cv > v.crashV) v.crashV = cv; }
      }
      else if (hit > HELI.LAND_V) { v.evt |= VE.LAND; if (hit > v.crashV) v.crashV = hit; }
      else if (hs > 1.5) { v.evt |= VE.SLAM; }
    }
  } else {
    // on the skids it follows the ground; on a slope too steep to stand on it slides (stepHeli) — fast, it goes over
    if (yG > v.y + 0.6) { v.air = true; } else v.y = yG;
    if (Math.max(Math.abs(SK[1]), Math.abs(SK[2])) > HELI.SLOPE_MAX && dmath.hypot(v.vx, v.vz) > HELI.FATAL_SLIDE_V) v.evt |= VE.TIP;
  }
  if (!v.air && WATER_LEVEL - v.y > HELI.SINK) { v.st = VS.Sunk; v.evt |= VE.SUNK; v.vx = v.vz = 0; v.vy = 0; v.tipV = 0; }
}

/** the wreck of one that blew in the air: it tumbles down and lies where it lands */
function fall(v: Vehicle, world: StaticWorld, dt: number) {
  v.vy -= GRAVITY * dt; if (v.vy < -45) v.vy = -45;
  v.x += v.vx * dt; v.z += v.vz * dt; v.y += v.vy * dt;
  const d = Math.min(0.9, 0.35 * dt); v.vx -= v.vx * d; v.vz -= v.vz * d;
  v.gPitch = Math.max(-1.0, Math.min(1.0, v.gPitch + 0.9 * dt)); v.gRoll = wrapPi(v.gRoll + 1.4 * dt); v.yaw = wrapPi(v.yaw + 0.8 * dt);
  const lim = world.terrain.half - 6;
  if (v.x > lim) { v.x = lim; v.vx = 0; } else if (v.x < -lim) { v.x = -lim; v.vx = 0; }
  if (v.z > lim) { v.z = lim; v.vz = 0; } else if (v.z < -lim) { v.z = -lim; v.vz = 0; }
  skids(v, world);
  const yG = Math.max(SK[0], WATER_LEVEL - 1.5);
  if (v.y <= yG) { v.y = yG; v.vy = 0; v.vx = v.vz = 0; v.air = false; v.gPitch = SK[1] + 0.12; v.gRoll = Math.round(v.gRoll / (Math.PI / 2)) * (Math.PI / 2) * 0.5 + 0.25; v.evt |= VE.SLAM; }
}
HELI_HOOKS.fall = fall;

const RB = new Float64Array(9);
/**
 * The rotor against a kong on foot standing at (qx, qy, qz), its capsule up to qy + qh (a weapon): the blade
 * disc where it is now — tilted with the body round the mast (HUB_Z back), ±CHOP_BAND round its plane, out to the tips
 * plus a kong's radius — or the tail fan. Level on its skids the disc clears a standing kong's head by 1.1 m: it takes a
 * dip of the nose or a bank low over a kong (or a kong up on something) to cut it down.
 */
export function inRotor(v: Vehicle, qx: number, qy: number, qz: number, qh: number): boolean {
  if (v.kind !== VKind.Heli || v.st !== VS.Ok || v.steer < 0.4) return false;
  const dx = qx - v.x, dz = qz - v.z;
  if (dx * dx + dz * dz > 64) return false;                  // (the tips reach 4.9 m from the middle, the fan 4.9 m back)
  vehBasis(v.yaw, v.gPitch, v.gRoll, RB);
  // the hub, and the disc's normal (the body's up)
  const nx = RB[1], ny = RB[4], nz = RB[7];
  const hx = v.x + RB[1] * HELI.ROTOR_Y + RB[2] * HELI.HUB_Z, hy = v.y + RB[4] * HELI.ROTOR_Y + RB[5] * HELI.HUB_Z, hz = v.z + RB[7] * HELI.ROTOR_Y + RB[8] * HELI.HUB_Z;
  // the disc's plane crosses the kong's (upright) axis t m above its feet: in the band, how far out from the hub
  const t = ((hx - qx) * nx + (hy - qy) * ny + (hz - qz) * nz) / ny;
  if (t > -HELI.CHOP_BAND && t < qh + HELI.CHOP_BAND) {
    const px = qx - hx, py = qy + (t < 0 ? 0 : t > qh ? qh : t) - hy, pz = qz - hz, pn = px * nx + py * ny + pz * nz;
    const ex = px - pn * nx, ey = py - pn * ny, ez = pz - pn * nz, R = HELI.ROTOR_R + PLAYER_R;
    if (ex * ex + ey * ey + ez * ez < R * R) return true;
  }
  // the tail fan: a ball against the kong's capsule
  const F = HELI.FAN;
  const fx = v.x + RB[0] * F[0] + RB[1] * F[1] + RB[2] * F[2], fy = v.y + RB[3] * F[0] + RB[4] * F[1] + RB[5] * F[2], fz = v.z + RB[6] * F[0] + RB[7] * F[1] + RB[8] * F[2];
  const ey = fy < qy ? qy - fy : fy > qy + qh ? fy - qy - qh : 0, ex = fx - qx, ez = fz - qz, Rf = HELI.FAN_R + PLAYER_R;
  return ex * ex + ey * ey + ez * ez < Rf * Rf;
}
/** the slope (rad) under the skids of a helicopter standing at (x, y, z) facing yaw — the HUD's TOO STEEP TO LAND */
export function padSlope(world: StaticWorld, x: number, y: number, z: number, yaw: number): number {
  SLOPE_V.x = x; SLOPE_V.y = y; SLOPE_V.z = z; SLOPE_V.yaw = yaw;
  skids(SLOPE_V as unknown as Vehicle, world);
  return Math.max(Math.abs(SK[1]), Math.abs(SK[2]));
}
const SLOPE_V = { x: 0, y: 0, z: 0, yaw: 0 };

// ------------------------------------------------------------------------------------------------ TOP BANANA
// The gun's state lives on the Vehicle (the belt and the heat are the helicopter's, whoever mans it): `gunAimY` /
// `gunAimP` = where the barrels are swinging to as a WORLD yaw / pitch (the gunner's look, slew-limited — so the step is
// a pure function of (gun state, the gunner's input): the gunner's client predicts it with exactly the inputs it sends,
// whatever pose it drew the helicopter at), `gunSpin` 0..1, `gunHeat` 0..1, `gunCool` s to the next round, `gunIdle` s
// since the last one, `gunLock` overheated, `gunArm` spun up (firing resumes at once while the barrels still turn),
// `gunBelt` rounds left. The ARC is applied at the pose the gun is drawn / shot at (gunBarrel): the barrels stop at the
// edge of the door, the aim behind them does not.
/** the spread (deg) the round fired by the last stepGun that fired left with (heat before that round) */
export const GUN_SHOT = new Float64Array(1);
const GM = new Float64Array(9);
const GUN_EPS = 1e-9;

/** a fresh belt, cold barrels at rest, swung out of the door (spawnVehicle → HELI_HOOKS.arm) */
function armGun(v: Vehicle) {
  v.gunAimY = wrapPi(v.yaw + Math.PI / 2 - HELI.GUN_REST_YAW); v.gunAimP = HELI.GUN_REST_PITCH;
  v.gunSpin = 0; v.gunHeat = 0; v.gunCool = 0; v.gunIdle = 9; v.gunLock = false; v.gunArm = false; v.gunBelt = HELI.GUN_BELT;
}
HELI_HOOKS.arm = armGun;

/** the trigger, the barrels' spin, the heat, the belt: one tick. true = a round left (its spread in GUN_SHOT[0]) */
function gunTrigger(v: Vehicle, fire: boolean, dt: number): boolean {
  if (v.gunCool > 0) v.gunCool -= dt;
  if (v.gunIdle < 9) v.gunIdle += dt;
  if (fire) { v.gunSpin += dt / HELI.GUN_SPIN_UP; if (v.gunSpin >= 1 - GUN_EPS) { v.gunSpin = 1; v.gunArm = true; } }
  else { v.gunSpin -= dt / HELI.GUN_SPIN_DOWN; if (v.gunSpin <= GUN_EPS) { v.gunSpin = 0; v.gunArm = false; } if (v.gunCool < 0) v.gunCool = 0; }
  if (v.gunIdle >= HELI.GUN_COOL_DELAY - GUN_EPS && v.gunHeat > 0) { v.gunHeat -= HELI.GUN_COOL * dt; if (v.gunHeat < 0) v.gunHeat = 0; }
  if (v.gunLock && v.gunHeat <= HELI.GUN_UNLOCK + GUN_EPS) v.gunLock = false;
  if (!fire || !v.gunArm || v.gunLock || v.gunBelt <= 0 || v.gunCool > GUN_EPS) return false;
  // (cool += carries the sub-tick remainder: 1200 rpm at 60 Hz is a round every third tick, exactly)
  GUN_SHOT[0] = HELI.GUN_SPREAD + HELI.GUN_SPREAD_HOT * v.gunHeat;
  v.gunBelt--; v.gunCool += 60 / HELI.GUN_RPM; v.gunIdle = 0;
  v.gunHeat += HELI.GUN_HEAT;
  if (v.gunHeat >= 1 - GUN_EPS) { v.gunHeat = 1; v.gunLock = true; }
  return true;
}

/**
 * One tick of TOP BANANA for its gunner: the barrels swing toward the gunner's look (world yaw / pitch) at GUN_SLEW,
 * spin while FIRE is held and fire every 60 / GUN_RPM s once spun up — while the belt lasts and it is not overheated.
 * Pure in (gun state, input). Returns true when a round left this tick (its spread: GUN_SHOT[0]; its direction:
 * gunBarrel at the pose the gunner sat at).
 */
export function stepGun(v: Vehicle, fire: boolean, lookYaw: number, lookPitch: number, dt: number): boolean {
  const m = HELI.GUN_SLEW * dt;
  const dy = wrapPi(lookYaw - v.gunAimY);
  v.gunAimY = wrapPi(v.gunAimY + (dy > m ? m : dy < -m ? -m : dy));
  const dp = lookPitch - v.gunAimP;
  v.gunAimP += dp > m ? m : dp < -m ? -m : dp;
  return gunTrigger(v, fire, dt);
}

/** nobody behind it (the server, once a tick): the barrels spin down, it cools, and it swings back to rest relative
 * to the body (the aim follows the helicopter round) */
export function stepGunIdle(v: Vehicle, dt: number): void {
  gunTrigger(v, false, dt);
  P6[0] = v.x; P6[1] = v.y; P6[2] = v.z; P6[3] = v.yaw; P6[4] = v.gPitch; P6[5] = v.gRoll;
  gunAngles(v.gunAimY, v.gunAimP, P6, GA);
  const m = HELI.GUN_SLEW * dt, dy = HELI.GUN_REST_YAW - GA[0], dp = HELI.GUN_REST_PITCH - GA[1];
  if (Math.abs(dy) < 1e-6 && Math.abs(dp) < 1e-6) return;
  gunWorld(GA[0] + (dy > m ? m : dy < -m ? -m : dy), GA[1] + (dp > m ? m : dp < -m ? -m : dp), P6, GA);
  v.gunAimY = GA[2]; v.gunAimP = GA[3];
}
const P6 = new Float64Array(6), GA = new Float64Array(4);

/** a body-relative barrel (yaw a: 0 = out of the left door, + toward the nose; pitch e: + up) at pose P → its world
 * yaw / pitch into out[2], out[3] (out[0], out[1] = a, e) */
export function gunWorld(a: number, e: number, P: ArrayLike<number>, out: Float64Array): Float64Array {
  vehBasis(P[3], P[4], P[5], GM);
  const ce = dmath.cos(e), bx = -dmath.cos(a) * ce, by = dmath.sin(e), bz = -dmath.sin(a) * ce;
  const wx = GM[0] * bx + GM[1] * by + GM[2] * bz, wy = GM[3] * bx + GM[4] * by + GM[5] * bz, wz = GM[6] * bx + GM[7] * by + GM[8] * bz;
  out[0] = a; out[1] = e; out[2] = dmath.atan2(-wx, -wz); out[3] = dmath.asin(wy > 1 ? 1 : wy < -1 ? -1 : wy);
  return out;
}
/**
 * Where the barrels point at pose P (x, y, z, yaw, pitch, roll) when they swing after the world aim (yaw, pitch): the
 * aim in the body frame, clamped to the arc → out[0] yaw (rad, 0 = straight out of the left door along −X, + = toward
 * the nose), out[1] pitch (+ = up); and that clamped barrel's world yaw / pitch → out[2], out[3] (what a round flies
 * along). ONE function for the server's shot, the gunner's predicted shot and every client's drawn turret.
 */
export function gunAngles(aimYaw: number, aimPitch: number, P: ArrayLike<number>, out: Float64Array): Float64Array {
  vehBasis(P[3], P[4], P[5], GM);
  const cp = dmath.cos(aimPitch), lx = -dmath.sin(aimYaw) * cp, ly = dmath.sin(aimPitch), lz = -dmath.cos(aimYaw) * cp;
  // into the body frame (the inverse of a rotation is its transpose)
  const bx = GM[0] * lx + GM[3] * ly + GM[6] * lz, by = GM[1] * lx + GM[4] * ly + GM[7] * lz, bz = GM[2] * lx + GM[5] * ly + GM[8] * lz;
  let a = dmath.atan2(-bz, -bx), e = dmath.asin(by > 1 ? 1 : by < -1 ? -1 : by);
  const A = HELI.GUN_ARC_YAW;
  if (a > A) a = A; else if (a < -A) a = -A;
  if (e > HELI.GUN_PITCH_MAX) e = HELI.GUN_PITCH_MAX; else if (e < HELI.GUN_PITCH_MIN) e = HELI.GUN_PITCH_MIN;
  return gunWorld(a, e, P, out);
}
/** the barrels of helicopter v at pose P (gunAngles of its aim) */
export const gunBarrel = (v: Vehicle, P: ArrayLike<number>, out: Float64Array) => gunAngles(v.gunAimY, v.gunAimP, P, out);
/** the helicopter whose door gun `p` mans (riding seat GUN_SEAT of a helicopter in `set`), or null */
export function gunOf(set: { list: Vehicle[] } | null, p: { st: number; veh: number; seat: number }): Vehicle | null {
  if (set === null || p.st !== RIDE_ST || p.seat !== HELI.GUN_SEAT || p.veh < 0) return null;
  const v = set.list[p.veh];
  return v && v.kind === VKind.Heli ? v : null;
}

// ------------------------------------------------------------------------------------------------ helipads
const N3 = [0, 1, 0];
/**
 * A helipad near (ax, az): level open ground above the sea with nothing round it to the rotor's reach and the open sky
 * over it. Deterministic rings (≤ `reach` m), nearest first. Writes [x, z, yaw] — nose toward the most open side — and
 * returns false when the neighbourhood has nowhere. (Once per world: this one allocates.)
 */
export function findHelipad(world: StaticWorld, ax: number, az: number, reach: number, yawHint: number, out: Float64Array, taken: ReadonlyArray<readonly [number, number]> = []): boolean {
  const T = world.terrain, R = HELI.ROTOR_R + 1.2;
  for (let ring = 0; ring * 3 <= reach; ring++) {
    const r = ring * 3, n = ring === 0 ? 1 : Math.max(8, Math.round((TAU * r) / 3.5));
    for (let k = 0; k < n; k++) {
      const a = yawHint + (k / n) * TAU, x = ax + dmath.cos(a) * r, z = az + dmath.sin(a) * r, y = T.height(x, z);
      if (y < 1.5 || T.normal(x, z, N3)[1] < 0.985) continue;
      if (taken.some(([tx, tz]) => (tx - x) * (tx - x) + (tz - z) * (tz - z) < 14 * 14)) continue;
      let ok = true;
      for (let i = 0; i < 12 && ok; i++) {
        const b = (i / 12) * TAU, dx = dmath.cos(b), dz = dmath.sin(b);
        for (const q of [0.4, 0.75, 1]) if (Math.abs(T.height(x + dx * R * q, z + dz * R * q) - y) > 0.5) ok = false;
        for (const h of [0.6, 2.0, 3.4]) { world.raycast(x, y + h, z, dx, 0, dz, R, GH, false); if (GH.hit) ok = false; }
      }
      if (!ok) continue;
      world.raycast(x, y + 0.4, z, 0, 1, 0, 60, GH, false); if (GH.hit) continue;
      // nose toward the most room (a 24 m probe at cabin height, 16 headings, the hint first)
      let bestYaw = yawHint, bestFree = -1;
      for (let h = 0; h < 16; h++) {
        const yaw = yawHint + (h / 16) * TAU, fx = -dmath.sin(yaw), fz = -dmath.cos(yaw);
        let free = 24;
        for (const hy of [1.2, 3.0]) { world.raycast(x, y + hy, z, fx, 0, fz, 24, GH, false); if (GH.hit && GH.t < free) free = GH.t; }
        if (free > bestFree + 0.05) { bestFree = free; bestYaw = yaw; }
      }
      out[0] = x; out[1] = z; out[2] = bestYaw;
      return true;
    }
  }
  return false;
}
