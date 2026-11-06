// TUK-TUKS — BANANA CO.'s three-wheeled taxis. One kong drives, two ride the bench behind it and shoot.
//
// Server-authoritative and DRIVER-PREDICTED: `stepVehicle` is a pure function of (vehicle state, the driver's input, the
// static world), so the driver's client steps its own tuk-tuk with exactly the inputs it sends and the server's snapshot
// (the vehicle's full-precision state after input `lastSeq`) reconciles it like the kong's own movement. Everybody else
// — passengers and onlookers — draws it interpolated from the snapshots.
//
// The feel:
//   • top speed 2 × a sprinting kong on a road, a little less on grass, less again on sand; it wades, it does not swim
//   • three wheels: one in front, two behind. The body leans out of every turn; push a turn too hard on tarmac and the
//     inside wheel lifts — ease off and it slams back down, hold it and the whole thing goes over
//   • on its side everybody is thrown out; E beside it heaves it back onto its wheels. Every tip-over and every further
//     quarter roll costs it health; at zero the engine catches fire, the horn sticks, and a moment later it explodes
//
// Frames: the BODY frame is three.js' — +X right, +Y up, −Z forward — and the pose (yaw, pitch, roll) is the Euler YXZ
// rotation three.js builds from rotation.set(pitch, yaw, roll): forward = (−sin yaw · cos pitch, sin pitch, −cos yaw · cos
// pitch) like a kong's aim, pitch > 0 = nose up, roll > 0 = LEFT side down. The origin is the ground under the middle of
// the wheelbase. Zero allocations per tick (results go into preallocated registers); never imports player.ts.
import { GRAVITY, HISTORY_TICKS, PLAYER_H, PLAYER_R, SPRINT, WATER_LEVEL, qpos } from "./const";
import { Biome } from "../world/map";
import { makeHit, type StaticWorld } from "./world";
import * as dmath from "./dmath";

/** what kind of machine a vehicle slot holds: BANANA CO.'s tuk-tuk, or KONG AIR's helicopter (shared/sim/heli.ts) */
export const enum VKind { Tuk = 0, Heli = 1 }

export const TUK = {
  /** vehicle slots per match, every kind together (the wire carries the id in a byte) */
  MAX: 24,
  HP: 600,
  // ---- drive
  /** top speed on a road (m/s) and in reverse */
  VMAX: SPRINT * 2, REV_MAX: 5.5,
  /** pull off the line (m/s²; it fades as 1 − (v / top)², so the last few m/s take a while), reverse pull, brakes;
   * off the throttle: engine braking, rolling resistance, air drag (× v²); the handbrake; what a hard corner scrubs off
   * (× lateral m/s²) */
  ENGINE: 8, REV_ACC: 6.5, BRAKE: 18, COAST: 2.2, ROLL_RES: 0.9, DRAG: 0.004, HB_DECEL: 7, SCRUB: 0.05,
  /** drive lost to the light inside wheel in a hard corner: none below UNLOAD_LO m/s² of cornering, UNLOAD of it from
   * UNLOAD_HI up (a wheel lifts at ≈ 24.5) */
  UNLOAD: 0.85, UNLOAD_LO: 14, UNLOAD_HI: 22,
  /** the nose's own weight on a slope (m/s² per sin pitch): hills slow it, it cannot climb a cliff */
  G_SLOPE: 11,
  /** steering lock (rad) at rest / at top speed, and how fast the bars follow the stick (rad/s) */
  STEER_LO: 0.62, STEER_HI: 0.28, STEER_RATE: 2.6,
  /** tyre grip (max lateral m/s²) on tarmac — more than it takes to lift a wheel: on a road it rolls before it slides;
   * with the handbrake on the tail lets go */
  MU: 32, MU_HB: 9,
  // ---- chassis (m)
  WHEELBASE: 2.2, FRONT: 1.25, REAR: 0.95, HW: 0.82, WHEEL_R: 0.36,
  /** the two circles that collide with the world: [offset along the spine (+ = back), radius], and their height */
  C_FRONT: -0.95, R_FRONT: 0.6, C_REAR: 0.55, R_REAR: 0.98, CAP_H: 1.95,
  /** footprint for kongs on foot (half width, half length, centre offset back) and the roof they can stand on */
  FOOT_HW: 0.98, FOOT_HL: 1.65, FOOT_Z: -0.1, ROOF: 2.12,
  BOUNCE: 0.2,
  /** a TREE (Box.round) caught off the nose slides it off: within
   *  GLANCE_DEG[0]° of square on it stops like any wall, past GLANCE_DEG[1]° it glances — the motion into the trunk stops,
   *  GLANCE_KEEP of its speed runs on, swung up to GLANCE_TURN rad a tick away from the trunk, the body with it */
  GLANCE_DEG: [18, 34], GLANCE_KEEP: 0.93, GLANCE_TURN: 0.2,
  /** the hop a kerb gives it (m/s upward) on top of what the slope under its wheels explains */
  KERB_HOP: 1.5,
  /** the driver's hop — all three wheels off by ≈ 0.5 m (m/s up),
   * once per HOP_S s; in the air the bars still swing the body round (rad/s at full lock) — land it sideways at speed and
   * the tyres bite: it rocks onto two wheels or over */
  HOP_V: 5, HOP_S: 1.6, AIR_YAW: 1.6,
  /** touching down sliding sideways faster than TRIP_V: the tyres dig in and rock it this much (rad/s per m/s of slide) */
  LAND_TRIP: 0.3,
  /** sliding sideways into something trips it: slides faster than TRIP_V (m/s) rock it by TRIP_K rad/s per m/s
   * stopped (≈ 10 m/s of slide puts it over) */
  TRIP_V: 2.5, TRIP_K: 0.34, WOBBLE_K: 0.3,
  /** pinned nose-first against something with the throttle on, the bars still work: the driven wheels scrub it round
   * the way they point as if it rolled at this speed (m/s) — W + a turn works it free without backing off */
  SCRAPE_V: 3.2,
  // ---- roll-over
  /** centre of mass above the road, the gravity that holds it down (the inside wheel lifts past G_ROLL · HW / H_CG ≈
   * 24.5 m/s² of cornering: a flat-out full-lock turn — below ~85 % of top speed it cannot go over on level ground), its
   * roll inertia (radius of gyration², m²), how much of a hard slam back onto three wheels carries through to the
   * other side (a left-right swerve at speed is how you really throw it over) */
  // (H_CG 0.72, K2 1.4 (it rolls a touch slower: more time to catch the wobble), TRIP_K 0.34: 32 of 68 hard
  // manoeuvres end on its side; it still lifts a wheel and still goes over flat out at full lock)
  H_CG: 0.72, G_ROLL: 21.5, K2: 1.4, REBOUND: 0.32,
  /** past this lean (rad) it is on its side */
  TIP_OVER: 1.3,
  /** on its side: sliding friction (m/s²), sideways speed that keeps it rolling (m/s), its rolling radius (m) */
  SLIDE: 9, ROLL_V: 2.6, ROLL_R: 1.05,
  /** seconds to heave it back onto its wheels, and how still it must lie first (m/s) */
  RIGHT_S: 0.85, FLIP_V: 1.2,
  // ---- damage
  TIP_DMG: 200, ROLL_DMG: 50,
  /** a wall at more than CRASH_V m/s dents it: CRASH_DMG hp per m/s over; a landing harder than LAND_V likewise */
  CRASH_V: 6.5, CRASH_DMG: 9, LAND_V: 15, LAND_DMG: 14,
  /** seconds between the engine catching fire and the bang; the bang's radius (m) and damage — all of it within
   * BLAST_CORE m (nobody beside it survives, shield or not), falling to BLAST_RIM × at the edge (a scorching) */
  FUSE_S: 2.6, BLAST_R: 10, BLAST_DMG: 220, BLAST_CORE: 2.5, BLAST_RIM: 0.1,
  /** rockets and other blasts hurt a tuk-tuk this much more than a kong */
  SPLASH_MUL: 2.4, ROCKET_MUL: 3,
  /** running a kong over: speed toward it that starts to hurt (m/s) and hp per m/s over */
  RAM_V: 4.5, RAM_DMG: 9.5,
  /** …and from this closing speed (m/s, ≈ 32 km/h) a driven tuk-tuk is lethal: run over at real speed, you are dead.
   * Squadmates are never hurt; a tuk-tuk nobody drives never kills */
  RAM_KILL_V: 9,
  // ---- water
  /** water this deep at the wheels starts to drag; this deep it floods and sinks */
  WADE: 0.3, SINK: 1.05,
  // ---- seats
  /** E reaches a tuk-tuk this far from its body (m) */
  REACH: 1.7,
  /** a wreck stays this long (s) */
  WRECK_S: 40,
  /** the radio: stations incl. OFF (0) — client/src/audio/radio.ts names them; a fresh tuk-tuk plays station 1.
   *  (one station, KONG FM 99.8 — the radio key toggles it on / off) */
  RADIO_N: 2,
} as const;

/** seat anchors in the body frame [right, up, back]: the rider's feet (the footwell under its hips). 0 = driver. */
export const SEATS: ReadonlyArray<readonly [number, number, number]> = [[0, 0.38, -0.1], [-0.46, 0.38, 0.74], [0.46, 0.38, 0.74]];
/** a seated kong's eye above its seat anchor (m) */
export const SEAT_EYE = 1.2;
/** where a kong climbs out, body frame [right, back] per seat, tried in order (then the roof) */
const EXITS: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [[-1.62, -0.1], [1.62, -0.1], [-1.62, 0.9], [1.62, 0.9], [0, 2.45], [0, -2.5]],
  [[-1.62, 0.74], [1.62, 0.74], [0, 2.45], [-1.62, -0.3], [1.62, -0.3], [0, -2.5]],
  [[1.62, 0.74], [-1.62, 0.74], [0, 2.45], [1.62, -0.3], [-1.62, -0.3], [0, -2.5]],
];
/** what stops a bullet, body frame [cx, cy, cz, hx, hy, hz]: the tub (floor, side panels, wheels), the nose fairing, the
 * seat back + engine cover, the roof. Between the belt line and the roof it is open: riders are exposed from the chest up. */
export const HITBOXES: ReadonlyArray<readonly [number, number, number, number, number, number]> = [
  [0, 0.62, 0.32, 0.92, 0.36, 1.22],
  [0, 0.98, -1.16, 0.5, 0.62, 0.3],
  [0, 1.22, 1.46, 0.86, 0.5, 0.14],
  [0, 2.07, 0.3, 0.92, 0.06, 1.2],
];

/** the shape every kind shares with the seats, the bullets, the kongs on foot and the E key (the numbers above are the
 * tuk-tuk's; shared/sim/heli.ts gives the helicopter's) */
export interface VehSpec {
  HP: number;
  /** seat anchors in the body frame [right, up, back]: the rider's feet. 0 = the driver / pilot. */
  SEATS: ReadonlyArray<readonly [number, number, number]>;
  /** where a kong climbs out, body frame [right, back] per seat, tried in order (then the roof) */
  EXITS: ReadonlyArray<ReadonlyArray<readonly [number, number]>>;
  /** what stops a bullet, body frame [cx, cy, cz, hx, hy, hz] */
  HITBOXES: ReadonlyArray<readonly [number, number, number, number, number, number]>;
  /** the broad-phase ball round the cabin for rays: its centre height and its radius² */
  BALL_Y: number; BALL_R2: number;
  /** footprint for kongs on foot (half width, half length, centre offset back) and the top they can stand on */
  FOOT_HW: number; FOOT_HL: number; FOOT_Z: number; ROOF: number;
  /** E reaches it this far from its body (m) */
  REACH: number;
  /** the bang: its radius (m), damage, the core nobody survives, the rim share; rockets / other blasts hurt it this much more */
  BLAST_R: number; BLAST_DMG: number; BLAST_CORE: number; BLAST_RIM: number; SPLASH_MUL: number; ROCKET_MUL: number;
  /** seconds between catching fire and the bang; a wreck stays this long (s) */
  FUSE_S: number; WRECK_S: number;
  /** running a kong over: closing speed that starts to hurt (m/s) and hp per m/s over */
  RAM_V: number; RAM_DMG: number;
}
const TUK_SPEC: VehSpec = {
  HP: TUK.HP, SEATS, EXITS, HITBOXES, BALL_Y: 1.05, BALL_R2: 5.76,
  FOOT_HW: TUK.FOOT_HW, FOOT_HL: TUK.FOOT_HL, FOOT_Z: TUK.FOOT_Z, ROOF: TUK.ROOF, REACH: TUK.REACH,
  BLAST_R: TUK.BLAST_R, BLAST_DMG: TUK.BLAST_DMG, BLAST_CORE: TUK.BLAST_CORE, BLAST_RIM: TUK.BLAST_RIM, SPLASH_MUL: TUK.SPLASH_MUL, ROCKET_MUL: TUK.ROCKET_MUL,
  FUSE_S: TUK.FUSE_S, WRECK_S: TUK.WRECK_S, RAM_V: TUK.RAM_V, RAM_DMG: TUK.RAM_DMG,
};
/** the spec of each kind (heli.ts fills in its own at load: the two modules must not import each other's tables) */
export const SPEC: VehSpec[] = [TUK_SPEC, TUK_SPEC];
export const specOf = (kind: number): VehSpec => SPEC[kind] ?? TUK_SPEC;

export const enum VS { Ok = 0, Tipped = 1, Righting = 2, Wreck = 3, Sunk = 4, Gone = 5 }
/** flag bits (the wire's flag byte): awake (it moved / was touched this second), burning, horn held, tyres sliding,
 * wheels off the ground, brake light, reversing, parked (handbrake on, nobody at the bars) */
export const VF = { AWAKE: 1, BURN: 2, HORN: 4, SKID: 8, AIR: 16, BRAKE: 32, REV: 64, PARK: 128 } as const;
/** what the deterministic step tells the match about this tick (Vehicle.evt) */
export const VE = { TIP: 1, ROLL: 2, CRASH: 4, LAND: 8, SLAM: 16, SUNK: 32, HOP: 64 } as const;
/** pose history stride: x, y, z, yaw, pitch, roll, state — the numbers the snapshots carried (quantised) */
export const VH = 7;

export interface Vehicle {
  id: number;
  /** what this slot holds this match (VKind). A helicopter reuses the predicted fields: `steer` = the rotor's spool
   * (0..1), `tip` = the collective (−1..1), `tipV` = the yaw rate, `gPitch` / `gRoll` = its attitude, `air` = off the skids. */
  kind: VKind;
  /** this slot has held a tuk-tuk in this match: snapshots keep carrying it — also once it is Gone, so clients hear */
  live: boolean;
  /** server: the tick something about it last changed (spawned, boarded, tipped, gone …): sent at once, not on its turn */
  touch: number;
  // ---- the predicted state (the driver's snapshot carries exactly these, f64)
  x: number; y: number; z: number; yaw: number;
  /** world velocity (m/s) */
  vx: number; vy: number; vz: number;
  /** the bars (rad, + = left) */
  steer: number;
  /** lean off its wheels (rad, + = left side down; ±π/2 = on its side, π = on its roof) and its rate */
  tip: number; tipV: number;
  /** the road under the three wheels, as the body follows it (rad) */
  gPitch: number; gRoll: number;
  st: VS; air: boolean;
  /** righting: seconds in, and the lean it started from */
  rightT: number; rightFrom: number;
  /** terrain (255) or the surface of the box under the front wheel */
  surf: number;
  /** the hop's cool-down (s left; predicted — the driver's self block carries it) */
  hopT: number;
  // ---- match state (server truth, mirrored from snapshots)
  hp: number; flags: number;
  /** player id per seat, −1 = empty */
  seats: [number, number, number];
  /** the radio station (0 = off; TUK.RADIO_N): match state like hp — any rider's radio key steps it, it stays tuned
   * (tuk-tuks only: a helicopter's stays 0) */
  radio: number;
  // ---- a helicopter's door gun, TOP BANANA (shared/sim/heli.ts stepGun): its gunner's client predicts these (the
  // gunner's self block carries them, f64); the belt and the heat are the helicopter's, whoever mans it.
  /** where the barrels swing to: world yaw / pitch (rad; the arc is applied at the pose it is drawn / shot at) */
  gunAimY: number; gunAimP: number;
  /** barrel spin 0..1, heat 0..1, s to the next round, s since the last one, overheated, spun up */
  gunSpin: number; gunHeat: number; gunCool: number; gunIdle: number; gunLock: boolean; gunArm: boolean;
  /** rounds left on the belt */
  gunBelt: number;
  // ---- events of the deterministic step (the match consumes them once per tick)
  evt: number; crashV: number; rolls: number;
  // ---- server only
  fuse: number; lastBy: number; idleT: number; wreckT: number; home: number;
  /** tick each kong was last run into (no double hits) */
  ramT: Int32Array;
  /** this tick: how fast it closed on each kong its panels pushed aside (pushKong — the kong's own step matches its speed
   * to the tuk-tuk's, so afterwards the bumper and the kong look like they never met: the run-over reads this) */
  bump: Float32Array;
  hist: Float32Array;
}

export function makeVehicle(id: number): Vehicle {
  return {
    id, kind: VKind.Tuk, live: false, touch: -1e9, x: 0, y: 0, z: 0, yaw: 0, vx: 0, vy: 0, vz: 0, steer: 0, tip: 0, tipV: 0, gPitch: 0, gRoll: 0, st: VS.Gone, air: false,
    rightT: 0, rightFrom: 0, surf: 255, hopT: 0, hp: TUK.HP, flags: 0, seats: [-1, -1, -1], radio: 1, evt: 0, crashV: 0, rolls: 0,
    gunAimY: 0, gunAimP: 0, gunSpin: 0, gunHeat: 0, gunCool: 0, gunIdle: 9, gunLock: false, gunArm: false, gunBelt: 0,
    fuse: -1, lastBy: -1, idleT: 0, wreckT: 0, home: -1, ramT: new Int32Array(64).fill(-1e9), bump: new Float32Array(64), hist: new Float32Array(HISTORY_TICKS * VH),
  };
}
/** park a fresh vehicle of `kind` at (x, z) facing `yaw`, sitting on whatever is under its wheels / skids */
export function spawnVehicle(v: Vehicle, world: StaticWorld, x: number, z: number, yaw: number, kind: VKind = VKind.Tuk, y?: number) {
  v.kind = kind; v.live = true; v.x = qpos(x); v.z = qpos(z); v.yaw = qyaw(yaw); v.vx = v.vy = v.vz = 0; v.steer = 0; v.tip = 0; v.tipV = 0; v.st = VS.Ok; v.air = false;
  v.rightT = 0; v.rightFrom = 0; v.hopT = 0; v.hp = specOf(kind).HP; v.flags = VF.PARK; v.seats[0] = v.seats[1] = v.seats[2] = -1; v.radio = kind === VKind.Tuk ? 1 : 0; v.evt = 0; v.crashV = 0; v.rolls = 0;
  v.fuse = -1; v.lastBy = -1; v.idleT = 0; v.wreckT = 0; v.ramT.fill(-1e9);
  v.y = y ?? world.ground(v.x, v.z) + 0.6; v.gPitch = 0; v.gRoll = 0;
  if (kind === VKind.Heli) { HELI_HOOKS.settle(v, world); HELI_HOOKS.arm(v); }
  else {
    world.drive = true; wheels(v, world); world.drive = false;
    if (WH[3] > -1e8) { v.y = qpos(WH[3]); v.gPitch = WH[4]; v.gRoll = WH[5]; v.surf = WH[6]; } else v.y = qpos(world.ground(v.x, v.z));
  }
  for (let t = 0; t < HISTORY_TICKS; t++) recordVehicle(v, t);   // it has "always" stood here: a rewind never sees the slot's past
}
/** what heli.ts plugs in (no import cycle): settle a parked helicopter onto its skids, step a wreck that is still falling,
 * give a fresh one its door gun's full belt */
export const HELI_HOOKS: { settle: (v: Vehicle, world: StaticWorld) => void; fall: (v: Vehicle, world: StaticWorld, dt: number) => void; arm: (v: Vehicle) => void } = { settle: () => {}, fall: () => {}, arm: () => {} };

const TAU = Math.PI * 2, HALF_PI = Math.PI / 2;
/** the snapshot's yaw quantisation (u16 per turn) */
const qyaw = (a: number) => { const u = Math.round((a / TAU) * 65536) & 0xffff; let r = (u / 65536) * TAU; if (r > Math.PI) r -= TAU; return r; };
const wrapPi = (a: number) => { a %= TAU; return a > Math.PI ? a - TAU : a <= -Math.PI ? a + TAU : a; };

/** the vehicles of ONE match (server Match / client mirror), bound into the shared world like the glass */
export class VehicleSet {
  readonly list: Vehicle[] = [];
  constructor(readonly world: StaticWorld) { for (let i = 0; i < TUK.MAX; i++) this.list.push(makeVehicle(i)); }
  bind() { this.world.veh = this; }
  /** a new phase: every tuk-tuk is gone (`live` stays: the clients are still told) */
  reset() { for (const v of this.list) { v.st = VS.Gone; v.seats[0] = v.seats[1] = v.seats[2] = -1; v.flags = 0; v.fuse = -1; v.evt = 0; v.home = -1; } }
  /** the first free slot (or null: the match already has its fleet) */
  free(): Vehicle | null { for (const v of this.list) if (v.st === VS.Gone) return v; return null; }
}

// ------------------------------------------------------------------------------------------------ pose
/** body frame → world rotation of pose (yaw, pitch, roll) into M (row-major 3 × 3: world = M · body) */
export function vehBasis(yaw: number, pitch: number, roll: number, M: Float64Array): Float64Array {
  const sy = dmath.sin(yaw), cy = dmath.cos(yaw), sp = dmath.sin(pitch), cp = dmath.cos(pitch), sr = dmath.sin(roll), cr = dmath.cos(roll);
  M[0] = cy * cr + sy * sp * sr; M[1] = -cy * sr + sy * sp * cr; M[2] = sy * cp;
  M[3] = cp * sr; M[4] = cp * cr; M[5] = -sp;
  M[6] = -sy * cr + cy * sp * sr; M[7] = sy * sr + cy * sp * cr; M[8] = cy * cp;
  return M;
}
/** body cross-section corners [right, up] the lean rests on: the wheels' contact line, the roof's edges */
const SECTION: ReadonlyArray<readonly [number, number]> = [[-TUK.HW - 0.14, 0], [TUK.HW + 0.14, 0], [-0.9, TUK.ROOF], [0.9, TUK.ROOF]];
/** how far the origin rises so a body leaning `tip` rad rests ON the ground (its lowest corner at road level) */
export function tipLift(tip: number): number {
  if (tip === 0) return 0;
  const s = dmath.sin(tip), c = dmath.cos(tip);
  let lo = 0;
  for (const [x, y] of SECTION) { const h = x * s + y * c; if (h < lo) lo = h; }
  return -lo;
}
/** the pose that is drawn, shot at and sat in: [x, y, z, yaw, pitch, roll] */
export function vehPose(v: Vehicle, out: Float64Array | number[]): Float64Array | number[] {
  if (v.kind === VKind.Heli) { out[0] = v.x; out[1] = v.y; out[2] = v.z; out[3] = v.yaw; out[4] = v.gPitch; out[5] = wrapPi(v.gRoll); return out; }
  let lift = tipLift(v.tip);
  if (v.st === VS.Righting) lift += dmath.sin(Math.PI * Math.min(1, v.rightT / TUK.RIGHT_S)) * 0.4;   // the heave
  out[0] = v.x; out[1] = v.y + lift; out[2] = v.z; out[3] = v.yaw; out[4] = v.gPitch; out[5] = wrapPi(v.gRoll + v.tip);
  return out;
}
/** pose quantisers — the wire's (shared/net/proto.ts writes exactly these integers; the history stores what they decode to) */
export const PITCH_VQ = 80, ROLL_VQ = 10000;
export const qVPitch = (a: number) => Math.max(-127, Math.min(127, Math.round(a * PITCH_VQ)));
export const qVRoll = (a: number) => Math.max(-32767, Math.min(32767, Math.round(wrapPi(a) * ROLL_VQ)));
const POSE = new Float64Array(6);
/** this tick's pose into the lag-compensation history (quantised like the snapshot of this tick) */
export function recordVehicle(v: Vehicle, tick: number) {
  const o = (tick % HISTORY_TICKS) * VH, h = v.hist;
  if (v.st === VS.Gone) { h[o + 6] = -1; return; }
  vehPose(v, POSE);
  h[o] = qpos(POSE[0]); h[o + 1] = qpos(POSE[1]); h[o + 2] = qpos(POSE[2]); h[o + 3] = qyaw(POSE[3]); h[o + 4] = qVPitch(POSE[4]) / PITCH_VQ; h[o + 5] = qVRoll(POSE[5]) / ROLL_VQ; h[o + 6] = v.st;
}
/** blend two pose samples exactly like the client draws them (positions linear, angles on the shortest arc, a jump of
 * more than 20 m is a respawn: never interpolated). a / b: arrays holding [x, y, z, yaw, pitch, roll] at ao / bo. */
export function blendVeh(a: ArrayLike<number>, ao: number, b: ArrayLike<number>, bo: number, f: number, out: Float64Array | number[]): Float64Array | number[] {
  const ex = b[bo] - a[ao], ey = b[bo + 1] - a[ao + 1], ez = b[bo + 2] - a[ao + 2];
  if (ex * ex + ey * ey + ez * ez > 400) { const s = f < 0.5 ? a : b, so = f < 0.5 ? ao : bo; for (let k = 0; k < 6; k++) out[k] = s[so + k]; return out; }
  out[0] = a[ao] + ex * f; out[1] = a[ao + 1] + ey * f; out[2] = a[ao + 2] + ez * f;
  out[3] = a[ao + 3] + wrapPi(b[bo + 3] - a[ao + 3]) * f; out[4] = a[ao + 4] + (b[bo + 4] - a[ao + 4]) * f; out[5] = a[ao + 5] + wrapPi(b[bo + 5] - a[ao + 5]) * f;
  return out;
}
const M3 = new Float64Array(9);
/** a body-frame point of pose P (x, y, z, yaw, pitch, roll) in the world → out[0..2] */
export function vehPoint(P: ArrayLike<number>, lx: number, ly: number, lz: number, out: Float64Array | number[]): Float64Array | number[] {
  vehBasis(P[3], P[4], P[5], M3);
  out[0] = P[0] + M3[0] * lx + M3[1] * ly + M3[2] * lz; out[1] = P[1] + M3[3] * lx + M3[4] * ly + M3[5] * lz; out[2] = P[2] + M3[6] * lx + M3[7] * ly + M3[8] * lz;
  return out;
}
/** where seat `k` of a vehicle of `kind` at pose P is (the rider's feet) → out[0..2] */
export const seatPoint = (P: ArrayLike<number>, kind: number, k: number, out: Float64Array | number[]) => { const S = specOf(kind).SEATS[k] ?? specOf(kind).SEATS[0]; return vehPoint(P, S[0], S[1], S[2], out); };

/** ray (unit dir) vs a vehicle of `kind` at pose P: metres to the first panel it hits, or −1 */
export function rayVehicle(P: ArrayLike<number>, kind: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): number {
  const SP = specOf(kind), HITBOXES = SP.HITBOXES;
  // broad phase: a ball round the cabin
  const wx = ox - P[0], wy = oy - (P[1] + SP.BALL_Y), wz = oz - P[2];
  const b = wx * dx + wy * dy + wz * dz, c = wx * wx + wy * wy + wz * wz - SP.BALL_R2;
  if (c > 0 && (b > 0 || b * b < c)) return -1;
  vehBasis(P[3], P[4], P[5], M3);
  // into the body frame (the inverse of a rotation is its transpose)
  const px = ox - P[0], py = oy - P[1], pz = oz - P[2];
  const lx = M3[0] * px + M3[3] * py + M3[6] * pz, ly = M3[1] * px + M3[4] * py + M3[7] * pz, lz = M3[2] * px + M3[5] * py + M3[8] * pz;
  const ldx = M3[0] * dx + M3[3] * dy + M3[6] * dz, ldy = M3[1] * dx + M3[4] * dy + M3[7] * dz, ldz = M3[2] * dx + M3[5] * dy + M3[8] * dz;
  let best = -1;
  for (const B of HITBOXES) {
    let t0 = 0, t1 = best < 0 ? maxT : best, ok = true;
    for (let a = 0; a < 3 && ok; a++) {
      const o = (a === 0 ? lx : a === 1 ? ly : lz) - B[a], d = a === 0 ? ldx : a === 1 ? ldy : ldz, h = B[a + 3];
      if (Math.abs(d) < 1e-9) { if (o < -h || o > h) ok = false; continue; }
      let lo = (-h - o) / d, hi = (h - o) / d; if (lo > hi) { const k = lo; lo = hi; hi = k; }
      if (lo > t0) t0 = lo; if (hi < t1) t1 = hi; if (t0 > t1) ok = false;
    }
    if (ok && t0 > 0 && t0 < (best < 0 ? maxT : best)) best = t0;
  }
  return best;
}

// ------------------------------------------------------------------------------------------------ the ground
const GH = makeHit(), N3 = [0, 1, 0];
/** wheel register: [front, rear-left, rear-right contact heights, origin height, pitch, roll, surface, lowest contact] */
const WH = new Float64Array(8);
/** the surface under (x, z) within reach of a wheel at height y: the terrain itself (exact — a marched ray would wobble
 * a millimetre with its start height, and a parked tuk-tuk must be perfectly still) or the top of a box standing on it
 * (a deck, a quay, a kerb); −1e9 = nothing there. USURF = what it is (255 terrain / the box's surface). */
let USURF = 255;
function under(world: StaticWorld, x: number, y: number, z: number): number {
  const th = world.terrain.height(x, z);
  world.raycast(x, y + 1.15, z, 0, -1, 0, 3.4, GH, false);
  if (GH.hit && GH.box >= 0) { const top = world.cy[GH.box] + world.hy[GH.box]; if (top > th) { USURF = GH.surf; return top; } }
  USURF = 255;
  return th > y - 2.25 ? th : -1e9;
}
/** the three contacts under the wheels of v as it stands (yaw, y) → WH */
function wheels(v: Vehicle, world: StaticWorld) {
  const sy = dmath.sin(v.yaw), cy = dmath.cos(v.yaw), fx = -sy, fz = -cy, rx = cy, rz = -sy;
  const dyF = dmath.sin(v.gPitch) * TUK.FRONT, dyR = -dmath.sin(v.gPitch) * TUK.REAR, dyS = dmath.sin(v.gRoll) * TUK.HW;
  const hF = under(world, v.x + fx * TUK.FRONT, v.y + dyF, v.z + fz * TUK.FRONT); const surf = USURF;
  const hL = under(world, v.x - fx * TUK.REAR - rx * TUK.HW, v.y + dyR - dyS, v.z - fz * TUK.REAR - rz * TUK.HW);
  const hR = under(world, v.x - fx * TUK.REAR + rx * TUK.HW, v.y + dyR + dyS, v.z - fz * TUK.REAR + rz * TUK.HW);
  // a wheel over nothing hangs: it takes the lowest height the others allow (the body cannot fold)
  const top = Math.max(hF, hL, hR);
  const f = hF < -1e8 ? top - 1.2 : hF, l = hL < -1e8 ? top - 1.2 : hL, r = hR < -1e8 ? top - 1.2 : hR;
  const hr = (l + r) * 0.5;
  WH[0] = f; WH[1] = l; WH[2] = r;
  WH[3] = top < -1e8 ? -1e9 : hr + (f - hr) * (TUK.REAR / TUK.WHEELBASE);
  WH[4] = Math.max(-1.1, Math.min(1.1, dmath.atan2(f - hr, TUK.WHEELBASE)));
  WH[5] = Math.max(-1.1, Math.min(1.1, dmath.atan2(r - l, 2 * TUK.HW)));
  WH[6] = surf; WH[7] = Math.min(f, l, r);
}
/** grip × / rolling resistance × / top speed × by terrain biome (shared/world/map.ts Biome); boxes are road */
const BIOME_GRIP: ReadonlyArray<readonly [number, number, number]> = [
  [0.6, 3, 0.5], [0.6, 3, 0.5], [0.72, 2.2, 0.88], [0.86, 1.5, 0.94], [0.8, 1.9, 0.9], [0.9, 1.4, 0.95], [0.78, 1.8, 0.9], [0.96, 1.1, 1], [0.82, 1.7, 0.92], [1, 1, 1], [0.6, 3, 0.5],
];
const ROAD: readonly [number, number, number] = [1, 1, 1];

// ------------------------------------------------------------------------------------------------ the step
/**
 * One deterministic tick. `thr` −1..1 (forward / brake-reverse), `str` −1..1 (right +), `hb` handbrake. Nobody at the
 * bars = (0, 0, parked). Raises `evt` bits for the match (tip-over, rolls, crashes, hard landings, sinking).
 */
export function stepVehicle(v: Vehicle, world: StaticWorld, thr: number, str: number, hb: boolean, dt: number, hop = false): void {
  v.flags &= ~(VF.SKID | VF.BRAKE | VF.REV | VF.AIR);
  if (v.kind === VKind.Heli) { if (v.st === VS.Wreck && v.air) HELI_HOOKS.fall(v, world, dt); return; }   // (a flying one is heli.ts stepHeli's)
  if (v.st === VS.Wreck || v.st === VS.Sunk || v.st === VS.Gone) return;
  if (v.st === VS.Righting) { stepRighting(v, world, dt); return; }
  if (v.st === VS.Tipped) { stepTumble(v, world, dt); return; }

  let sy = dmath.sin(v.yaw), cy = dmath.cos(v.yaw);
  let vf = -v.vx * sy - v.vz * cy;
  const spd = Math.abs(vf);
  // ---- steering: the lock narrows with speed; the bars follow the stick (and centre a little faster than they turn)
  const lock = TUK.STEER_LO + (TUK.STEER_HI - TUK.STEER_LO) * Math.min(1, spd / TUK.VMAX);
  const want = -str * lock, ds = want - v.steer, maxS = TUK.STEER_RATE * dt * (str === 0 ? 1.7 : 1);
  v.steer += ds > maxS ? maxS : ds < -maxS ? -maxS : ds;
  const grounded = !v.air;
  if (grounded) {
    let w = (vf * dmath.tan(v.steer)) / TUK.WHEELBASE;
    if (hb && spd > 3) w *= 1.3;                                                  // handbrake: the tail steps out
    if (v.tip !== 0) w *= 1 - 0.5 * Math.min(1, Math.abs(v.tip) / 0.6);          // on two wheels the front bites less
    v.yaw = wrapPi(v.yaw + w * dt);
    sy = dmath.sin(v.yaw); cy = dmath.cos(v.yaw);
  } else if (str !== 0) {
    // in the air the bars swing the body round its own speed (a hop is a chance to set it down crooked)
    v.yaw = wrapPi(v.yaw - str * TUK.AIR_YAW * dt);
    sy = dmath.sin(v.yaw); cy = dmath.cos(v.yaw);
  }
  // the hop: the driver throws its weight up — all three wheels off the road
  if (v.hopT > 0) v.hopT = Math.max(0, v.hopT - dt);
  if (hop && grounded && v.hopT <= 0 && Math.abs(v.tip) < 0.25) { v.vy = Math.max(v.vy, 0) + TUK.HOP_V; v.air = true; v.hopT = TUK.HOP_S; v.evt |= VE.HOP; }
  const fx = -sy, fz = -cy, rx = cy, rz = -sy;
  vf = v.vx * fx + v.vz * fz;
  let vl = v.vx * rx + v.vz * rz;
  // wading: the deeper, the slower
  const depth = WATER_LEVEL - v.y;
  const wade = depth > TUK.WADE ? Math.max(0.22, 1 - (depth - TUK.WADE) / (TUK.SINK - TUK.WADE) * 0.78) : 1;
  let lat = 0;
  if (grounded) {
    const G = v.surf === 255 ? BIOME_GRIP[world.groundBiome(v.x, v.z)] ?? ROAD : ROAD;
    // ---- the tyres: kill the sideways speed, up to their grip — what they cannot hold is a slide
    const lim = (hb ? TUK.MU_HB : TUK.MU) * G[0] * dt;
    const dvl = vl > lim ? -lim : vl < -lim ? lim : -vl;
    if (Math.abs(vl) > lim && Math.abs(vl) > 1.3) v.flags |= VF.SKID;
    vl += dvl; lat = dvl / dt;
    // ---- engine, brakes, the hill
    const vmax = TUK.VMAX * G[2] * wade;
    let a = 0;
    if (thr > 0.05) {
      // (cornering hard, the inside wheel goes light and spins the drive away: pinned in a full-lock turn it settles
      // into a circle just short of lifting a wheel — to put it over you have to arrive fast and throw the bars)
      const al = Math.abs(lat), light = al <= TUK.UNLOAD_LO ? 0 : al >= TUK.UNLOAD_HI ? 1 : (al - TUK.UNLOAD_LO) / (TUK.UNLOAD_HI - TUK.UNLOAD_LO);
      a = vf >= -0.3 ? TUK.ENGINE * thr * (0.55 + 0.45 * G[0]) * Math.max(0, 1 - (vf / vmax) * (vf / vmax)) * (1 - TUK.UNLOAD * light) : TUK.BRAKE;
    }
    else if (thr < -0.05) {
      if (vf > 0.3) { a = TUK.BRAKE * thr; v.flags |= VF.BRAKE; }
      else { a = TUK.REV_ACC * thr * Math.max(0, 1 + vf / (TUK.REV_MAX * wade)); v.flags |= VF.REV; }
    }
    a -= TUK.G_SLOPE * dmath.sin(v.gPitch);
    vf += a * dt;
    // resistances stop it, they never push it backwards (a parked tuk-tuk holds on a hill)
    // (under power the engine's own curve is the whole story: it reaches its top speed; faster than that — downhill,
    // off a road onto sand — the drag is back)
    // (water likewise: it caps the speed (vmax) and stops a tuk-tuk that ploughs in or coasts — it must never outpull
    // the engine at a crawl, or the shallows short of SINK would hold it for good)
    const free = Math.abs(thr) <= 0.05 || vf > vmax || vf < -TUK.REV_MAX * wade || hb;
    const res = ((free ? TUK.ROLL_RES * G[1] + TUK.DRAG * vf * vf + TUK.COAST + (wade < 1 ? 14 * (1 - wade) : 0) : 0) + (hb ? TUK.HB_DECEL : 0) + TUK.SCRUB * Math.abs(lat)) * dt;
    vf = vf > res ? vf - res : vf < -res ? vf + res : 0;
    v.vx = fx * vf + rx * vl; v.vz = fz * vf + rz * vl;
  }
  // ---- roll-over: the tyres push at the road, the weight rides H_CG above it; a side slope leans on it too
  if (grounded) {
    const drive = (lat + TUK.G_ROLL * dmath.sin(v.gRoll)) * TUK.H_CG, cg = dmath.cos(v.gRoll);
    if (v.tip === 0 && v.tipV === 0) {
      const hold = TUK.G_ROLL * cg * TUK.HW;
      if (drive > hold) v.tipV = 1e-9; else if (drive < -hold) v.tipV = -1e-9;     // a wheel leaves the road
    }
    if (v.tip !== 0 || v.tipV !== 0) {
      const s = v.tip > 0 || (v.tip === 0 && v.tipV > 0) ? 1 : -1, u = Math.abs(v.tip);
      const acc = (drive * s * dmath.cos(u) - TUK.G_ROLL * (cg * TUK.HW * dmath.cos(u) - TUK.H_CG * dmath.sin(u))) / TUK.K2;
      let uv = v.tipV * s + acc * dt, un = u + uv * dt;
      if (un <= 0) {                                                              // back on three wheels
        if (uv < -1.1) v.evt |= VE.SLAM;
        un = 0; uv = uv < -1.6 ? uv * TUK.REBOUND : 0;                              // (a hard slam rocks on through)
      }
      v.tip = un * s; v.tipV = uv * s;
      if (un >= TUK.TIP_OVER) { v.st = VS.Tipped; v.evt |= VE.TIP; v.steer = 0; }
    }
  } else if (v.tip !== 0 || v.tipV !== 0) {
    v.tip += v.tipV * dt;
    if (Math.abs(v.tip) >= TUK.TIP_OVER) { v.st = VS.Tipped; v.evt |= VE.TIP; v.steer = 0; }
  }
  DRIVE = grounded && Math.abs(thr) > 0.05 ? thr : 0;
  move(v, world, dt);
  DRIVE = 0;
  if (v.air) v.flags |= VF.AIR;
  // ---- water: past the axles it floods
  if (!v.air && WATER_LEVEL - v.y > TUK.SINK) { v.st = VS.Sunk; v.evt |= VE.SUNK; v.vx = v.vz = 0; v.tip = 0; v.tipV = 0; }
}

/** integrate, collide the two circles with the world, follow the ground (or fly) */
/** the throttle of the tick being stepped (stepVehicle → move): > 0 = driving forward */
let DRIVE = 0;
function move(v: Vehicle, world: StaticWorld, dt: number) {
  world.drive = true;   // (fences, hedges and crop stems do not stop a tuk-tuk — Box.noDrive)
  moveIn(v, world, dt);
  world.drive = false;
}
/** how much of a glance a tree contact is: `cosT` = cos of the angle between the motion and straight into
 *  the trunk → 0 square on (≤ GLANCE_DEG[0]°) … 1 (≥ GLANCE_DEG[1]°), smoothstep between */
function glance(cosT: number): number {
  const th = dmath.acos(cosT > 1 ? 1 : cosT < -1 ? -1 : cosT) * (180 / Math.PI), [a, b] = TUK.GLANCE_DEG;
  const t = (th - a) / (b - a);
  return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
}
function moveIn(v: Vehicle, world: StaticWorld, dt: number) {
  const x0 = v.x, z0 = v.z, sy0 = dmath.sin(v.yaw), cy0 = dmath.cos(v.yaw);
  v.x += v.vx * dt; v.z += v.vz * dt;
  // the sideways slide it came in with (+ = to its right), and how much of it the walls stopped
  const slide = v.vx * cy0 - v.vz * sy0, ahead = -v.vx * sy0 - v.vz * cy0;
  let impact = 0, hit = false, trip = 0, shove = 0, glanced = false;
  for (let k = 0; k < 2; k++) {
    const off = k === 0 ? TUK.C_FRONT : TUK.C_REAR, r = k === 0 ? TUK.R_FRONT : TUK.R_REAR;
    const sy = dmath.sin(v.yaw), cy = dmath.cos(v.yaw);
    const cx = v.x + sy * off, cz = v.z + cy * off;
    const by = v.y - dmath.sin(v.gPitch) * off + 0.06;
    // the kong's own mover (world.resolveMove), with this circle's motion of the tick: walls push it out, a gap too
    // narrow for it takes the move back, and a circle that somehow starts INSIDE something glides out a little per tick
    // (never wedged for good)
    world.velY = 0; world.wallHit = false; world.headBump = false; world.wallRound = false; world.wallFlat = false; world.roundD = -1;
    world.resolveMove(cx, by, cz, cx - (x0 + sy0 * off), 0, cz - (z0 + cy0 * off), r, TUK.CAP_H, true);
    const px = world.P[0] - cx, pz = world.P[2] - cz, pl = dmath.hypot(px, pz);
    if (pl < 1e-7) continue;
    v.x += px; v.z += pz;
    const nx = px / pl, nz = pz / pl;
    // a glancing wall turns the body away from it (the circle's lever arm along the spine)
    const lx = sy * off, lz = cy * off;
    let turn = 0.55 * (lz * px - lx * pz) / (off * off + 0.3);
    // held against it by the engine: scrub round the way the front wheel points (once per tick) — the driver's turn
    // wins over the wall's
    if (DRIVE !== 0 && v.steer !== 0 && (nx * sy + nz * cy) * DRIVE > 0.25 * Math.abs(DRIVE)) {
      const scrub = (TUK.SCRAPE_V * dmath.tan(v.steer) / TUK.WHEELBASE) * DRIVE * dt;
      turn = turn * scrub < 0 ? scrub : turn + scrub; DRIVE = 0;
    }
    v.yaw = wrapPi(v.yaw + turn);
    const vn = v.vx * nx + v.vz * nz;
    hit = true;
    if (vn < 0) {
      if (-vn > impact && !world.depen) impact = -vn;
      // a TREE (only trees touched) caught off the nose: g 0 = square on — it stops as on any wall — … 1 = a
      // glance: the motion into the trunk stops, most of the speed runs on, swung away from the trunk with the body. The
      // angle is the trunk's own: from its axis (the boxes' faces of a disk union only point 4 ways)
      const sp = dmath.hypot(v.vx, v.vz);
      let g = 0, rnx = nx, rnz = nz;
      // (a slide round a trunk can push the circle out further than it moved this tick — the solver calls that a
      // depenetration glide; for a trunk it is still the slide)
      if (!glanced && v.st === VS.Ok && world.wallRound && !world.wallFlat && sp > 0.5 && world.roundD >= 0) {   // (on its wheels only)
        const qx = world.P[0] - world.roundX, qz = world.P[2] - world.roundZ, ql = dmath.hypot(qx, qz);
        if (ql > 1e-6) { rnx = qx / ql; rnz = qz / ql; }
        const rvn = v.vx * rnx + v.vz * rnz;
        g = rvn < 0 ? glance(-rvn / sp) : 1;
      }
      if (g > 0) {
        glanced = true;
        const rx = v.vx - nx * vn * (1 + TUK.BOUNCE), rz = v.vz - nz * vn * (1 + TUK.BOUNCE);   // what a wall would leave
        const rvn = Math.min(0, v.vx * rnx + v.vz * rnz);
        const ux = v.vx / sp, uz = v.vz / sp, tx = v.vx - rnx * rvn, tz = v.vz - rnz * rvn, tl = dmath.hypot(tx, tz);
        // swing the motion toward the trunk's tangent (≤ GLANCE_TURN this tick): +a = counter-clockwise in x-z
        const cu = tl > 1e-6 ? Math.max(-1, Math.min(1, (ux * tx + uz * tz) / tl)) : 1;
        const a = Math.min(dmath.acos(cu), TUK.GLANCE_TURN) * (ux * tz - uz * tx >= 0 ? 1 : -1) * g;
        const ca = dmath.cos(a), sa = dmath.sin(a), keep = sp * (1 - (1 - TUK.GLANCE_KEEP) * g);
        const gx = (ux * ca - uz * sa) * keep, gz = (ux * sa + uz * ca) * keep;
        v.vx = rx + (gx - rx) * g; v.vz = rz + (gz - rz) * g;
        v.yaw = wrapPi(v.yaw - a);                                                     // (the motion turned by a ↔ yaw by −a)
      } else {
        v.vx -= nx * vn * (1 + TUK.BOUNCE); v.vz -= nz * vn * (1 + TUK.BOUNCE);
        const nr = nx * cy0 - nz * sy0; if (slide * nr < 0) trip += slide * nr * nr;
        shove += ahead * (nx * sy0 + nz * cy0) * nr;                                  // what the hit knocks it sideways (+ = right)
      }
    }
  }
  if (hit) {
    // What a wall does to the speed is the wall's doing, not the tyres': left in the velocity, its sideways part would
    // be answered next tick as cornering force and lift a wheel (a tuk-tuk grinding along a block at walking pace
    // would roll onto its side). So what is left runs along the spine — plus the slide it came in with, unless the wall
    // stood in its way: then that slide is over, and a quick one trips it (it rocks the way it was going; a
    // handbrake slide into a kerb at speed puts it over).
    const sy = dmath.sin(v.yaw), cy = dmath.cos(v.yaw), keep = trip !== 0 ? 0 : slide, vl = v.vx * cy - v.vz * sy;
    v.vx += cy * (keep - vl); v.vz -= sy * (keep - vl);
    if (!v.air && v.st === VS.Ok) {
      if (Math.abs(trip) > TUK.TRIP_V) v.tipV -= TUK.TRIP_K * trip;
      // a real crash off-centre knocks it onto two wheels, away from the corner that took it (it slams back down)
      // (never enough by itself to put it over)
      if (impact > TUK.CRASH_V) v.tipV -= TUK.WOBBLE_K * (shove > 8 ? 8 : shove < -8 ? -8 : shove);
    }
  }
  if (impact > 3) { v.evt |= VE.CRASH; if (impact > v.crashV) v.crashV = impact; }
  // world bounds
  const lim = world.terrain.half - 6;
  if (v.x > lim) { v.x = lim; v.vx = 0; } else if (v.x < -lim) { v.x = -lim; v.vx = 0; }
  if (v.z > lim) { v.z = lim; v.vz = 0; } else if (v.z < -lim) { v.z = -lim; v.vz = 0; }
  // ---- the ground under the three wheels
  wheels(v, world);
  const yG = WH[3];
  v.surf = WH[6];
  if (v.air) {
    v.vy -= GRAVITY * dt; if (v.vy < -60) v.vy = -60;
    v.y += v.vy * dt;
    v.gPitch = Math.max(-0.6, v.gPitch - 0.5 * dt);                                // the nose drops in the air
    if (v.y <= yG) {
      const hit = -v.vy;
      v.y = yG; v.vy = 0; v.air = false;
      // set down crooked at speed (a hop with the bars over): the tyres dig in and it rocks the way it slides
      if (v.st === VS.Ok) { const sl = v.vx * dmath.cos(v.yaw) - v.vz * dmath.sin(v.yaw); if (Math.abs(sl) > TUK.TRIP_V) v.tipV -= TUK.LAND_TRIP * (sl - Math.sign(sl) * TUK.TRIP_V); }
      if (hit > 3.5) { v.evt |= VE.LAND; if (hit > v.crashV) v.crashV = hit; }   // (a hop's landing thumps too)
    }
  } else {
    // follow the road while it stays under the wheels; when it falls away faster than gravity can follow, it flies
    const yB = v.y + v.vy * dt - 0.5 * GRAVITY * dt * dt;
    if (yG >= yB - 0.03) {
      let vy = (yG - v.y) / dt;
      // a kerb is not a ramp: the wheels step up it, they do not launch off it (else a 25 cm step at full speed throws
      // it 4 m into the air). The climb its attitude had settled into (a ramp it has been on for a moment — not the
      // jolt of this tick's wheel contacts) may carry it off a crest; the rest of a sudden rise is a hop
      const ramp = dmath.hypot(v.vx, v.vz) * (Math.abs(dmath.sin(v.gPitch)) + 0.5 * Math.abs(dmath.sin(v.gRoll))) + TUK.KERB_HOP;
      if (vy > ramp) vy = ramp;
      v.vy = vy > 14 ? 14 : vy < -30 ? -30 : vy; v.y = yG;
      const k = 1 - dmath.exp(-dt * 14);
      v.gPitch += (WH[4] - v.gPitch) * k; v.gRoll += (WH[5] - v.gRoll) * k;
    } else { v.air = true; v.y = yB; v.vy -= GRAVITY * dt; }
  }
}

/** on its side or its roof: it slides, the slope pulls it, sideways speed keeps it rolling; it comes to rest on a side,
 * on the roof — or, after a whole turn, back on its wheels */
function stepTumble(v: Vehicle, world: StaticWorld, dt: number) {
  const sy = dmath.sin(v.yaw), cy = dmath.cos(v.yaw), rx = cy, rz = -sy;
  if (!v.air) {
    if (v.surf === 255) { const n = world.terrain.normal(v.x, v.z, N3); v.vx += n[0] * TUK.G_SLOPE * dt; v.vz += n[2] * TUK.G_SLOPE * dt; }
    // (a body that is rolling loses speed half as fast as one scraping along on its side)
    const sp = dmath.hypot(v.vx, v.vz), f = (Math.abs(v.vx * rx + v.vz * rz) > TUK.ROLL_V ? TUK.SLIDE * 0.5 : TUK.SLIDE) * dt;
    if (sp <= f) { v.vx = 0; v.vz = 0; } else { const k = 1 - f / sp; v.vx *= k; v.vz *= k; }
  }
  const vl = v.vx * rx + v.vz * rz, rolling = Math.abs(vl) > TUK.ROLL_V;
  const q0 = Math.round(v.tip / HALF_PI);
  if (rolling) v.tipV += (-vl / TUK.ROLL_R - v.tipV) * (1 - dmath.exp(-dt * 7));
  else v.tipV += ((q0 * HALF_PI - v.tip) * 70 - v.tipV * 11) * dt;                 // settle onto the nearest rest
  v.tip += v.tipV * dt;
  const q1 = Math.round(v.tip / HALF_PI);
  if (q1 !== q0) { v.evt |= VE.ROLL; v.rolls++; }
  move(v, world, dt);
  if (v.air) v.flags |= VF.AIR;
  if (!rolling && !v.air && Math.abs(v.tipV) < 0.08 && Math.abs(v.tip - q1 * HALF_PI) < 0.012) {
    v.tipV = 0;
    if (q1 % 4 === 0) { v.tip = 0; v.st = VS.Ok; v.evt |= VE.SLAM; }                // a whole turn: wheels down again
    else v.tip = wrapPi(q1 * HALF_PI);
  }
  if (!v.air && WATER_LEVEL - v.y > TUK.SINK) { v.st = VS.Sunk; v.evt |= VE.SUNK; v.vx = v.vz = 0; }
}

function stepRighting(v: Vehicle, world: StaticWorld, dt: number) {
  v.rightT += dt;
  const u = Math.min(1, v.rightT / TUK.RIGHT_S), e = u * u * (3 - 2 * u);
  v.tip = v.rightFrom * (1 - e); v.tipV = 0; v.vx = 0; v.vz = 0;
  move(v, world, dt);
  if (u >= 1) { v.st = VS.Ok; v.tip = 0; v.rightT = 0; v.evt |= VE.SLAM; }
}
/** it has come to rest: snap its pose onto the wire's grid, so every client's copy of a sleeping tuk-tuk (what a kong
 * on foot collides with in its prediction) is the server's to the bit */
export function restVehicle(v: Vehicle) {
  const lift = v.kind === VKind.Heli ? 0 : tipLift(v.tip);
  v.x = qpos(v.x); v.z = qpos(v.z); v.y = qpos(v.y + lift) - lift; v.yaw = qyaw(v.yaw); v.vx = v.vy = v.vz = 0; v.tipV = 0; v.steer = 0;
}
/** heave a tuk-tuk lying still back onto its wheels; false = it is not lying down, or still sliding */
export function flipVehicle(v: Vehicle): boolean {
  if (v.kind !== VKind.Tuk || v.st !== VS.Tipped || dmath.hypot(v.vx, v.vz) > TUK.FLIP_V) return false;
  v.st = VS.Righting; v.rightT = 0; v.rightFrom = wrapPi(v.tip); v.tipV = 0; v.vx = v.vz = 0;
  return true;
}

// ------------------------------------------------------------------------------------------------ riders
/** the subset of Player the seats touch (structural: no import of player.ts) */
export interface Rider {
  id: number; team: number; st: number; veh: number; seat: number;
  x: number; y: number; z: number; vx: number; vy: number; vz: number; yaw: number;
  grounded: boolean; crouch: boolean; sprint: boolean; swim: boolean; under: boolean; slope: boolean; scoped: boolean;
  coyote: number; jumpBuf: number; airT: number; fallV: number; mvT: number; mvY: number; surf: number;
}
/** PS.Ride / PS.Ground (shared/sim/player.ts), numeric here so this module never imports player.ts */
export const RIDE_ST = 8;
const P6 = new Float64Array(6), S3 = new Float64Array(3);

/** put a rider on its seat of v as v stands NOW (the driver also faces where the tuk-tuk does) */
export function seatRider(p: Rider, v: Vehicle) {
  seatPoint(vehPose(v, P6), v.kind, p.seat, S3);
  p.x = S3[0]; p.y = S3[1]; p.z = S3[2]; p.vx = v.vx; p.vy = v.vy; p.vz = v.vz;
  if (p.seat === 0) p.yaw = v.yaw;
}
/** put a rider on its seat of a vehicle of `kind` drawn at pose P (a passenger's client: the interpolated pose it is
 * looking from; the server: the same pose rewound from the history — so both fire from the same eye) */
export function seatRiderAt(p: Rider, kind: number, P: ArrayLike<number>) { seatPoint(P, kind, p.seat, S3); p.x = S3[0]; p.y = S3[1]; p.z = S3[2]; }

/** which seat a kong of `team` may take in v: the bars if they are free, else the bench; −1 = full, wrecked, on its
 * side, or carrying another squad */
export function freeSeat(v: Vehicle, team: number, teamOf: (id: number) => number): number {
  if (v.st !== VS.Ok) return -1;
  for (let k = 0; k < 3; k++) if (v.seats[k] >= 0 && teamOf(v.seats[k]) !== team) return -1;
  for (let k = 0; k < 3; k++) if (v.seats[k] < 0) return k;
  return -1;
}
export function enterVehicle(p: Rider, v: Vehicle, seat: number) {
  v.seats[seat] = p.id; v.flags = (v.flags | VF.AWAKE) & ~VF.PARK; v.idleT = 0;
  p.st = RIDE_ST; p.veh = v.id; p.seat = seat;
  p.grounded = true; p.crouch = false; p.sprint = false; p.swim = false; p.under = false; p.slope = false; p.scoped = false;
  p.coyote = 0; p.jumpBuf = 0; p.airT = 0; p.fallV = 0; p.mvT = 0; p.mvY = 0;
  seatRider(p, v);
}
/** a spot beside v where a kong can stand: body-frame (right, back) tried in the seat's order, then the roof */
function exitSpot(p: Rider, v: Vehicle, world: StaticWorld, out: Float64Array): void {
  const SP = specOf(v.kind), SEATS = SP.SEATS, EXITS = SP.EXITS, heli = v.kind === VKind.Heli;
  const sy = dmath.sin(v.yaw), cy = dmath.cos(v.yaw), rx = cy, rz = -sy, bx = sy, bz = cy;
  const lift = heli ? 0 : tipLift(v.tip);
  const ex = v.x + rx * SEATS[p.seat][0] + bx * SEATS[p.seat][2], ez = v.z + rz * SEATS[p.seat][0] + bz * SEATS[p.seat][2], ey = v.y + lift + 1.3;
  // a helicopter in the air: out of the door, into the air beside it (the kong falls — or pulls its chute), well
  // clear of the hull, a little under the floor, and away from the door — exitVehicle — so the hull never sweeps
  // the kong up and the camera is outside; the match spares it from the rotor for a moment
  if (heli && (v.air || v.y - world.ground(v.x, v.z) > 1.6)) {
    const side = p.seat === 2 ? 1 : -1, lx = side * (SP.FOOT_HW + PLAYER_R + (v.air ? 1.4 : 0.9)), lz = SEATS[p.seat][2];
    out[0] = v.x + rx * lx + bx * lz; out[1] = v.y + (v.air ? -0.2 : 0.3); out[2] = v.z + rz * lx + bz * lz; if (v.air) AIR_OUT = side; return;
  }
  for (const [lx, lz] of EXITS[p.seat] ?? EXITS[0]) {
    const x = v.x + rx * lx + bx * lz, z = v.z + rz * lx + bz * lz;
    world.raycast(x, v.y + 1.6, z, 0, -1, 0, 4.5, GH, false);
    if (!GH.hit || GH.ny < 0.6) continue;
    const y = GH.y;
    if (y < WATER_LEVEL - 0.9 && v.y > WATER_LEVEL - 0.5) continue;                 // not into deep water off a quay
    world.velY = 0; world.headBump = false; world.wallHit = false;
    world.resolveCapsule(x, y + 0.02, z, PLAYER_R, PLAYER_H, false);
    if (world.headBump || world.overlap || Math.abs(world.P[0] - x) + Math.abs(world.P[2] - z) > 0.1 || Math.abs(world.P[1] - (y + 0.02)) > 0.35) continue;
    // nothing between the seat and the spot (never out through a wall)
    world.raycast(ex, ey, ez, x - ex, y + 1.0 - ey, z - ez, 1, GH, false);
    if (GH.hit) continue;
    out[0] = x; out[1] = world.P[1]; out[2] = z; return;
  }
  out[0] = v.x; out[1] = v.y + lift + SP.ROOF + 0.05; out[2] = v.z;   // boxed in: out through the roof
}
/** out of a flying helicopter's door (exitSpot): which side (−1 left, +1 right, 0 = not that way), and the push away
 * from the door it leaves with (m/s) */
let AIR_OUT = 0;
const BAIL_PUSH = 2.5;
/** leave the seat. `thrown`: it tipped / blew — the kong is flung clear with a hop instead of stepping out. */
export function exitVehicle(p: Rider, v: Vehicle | null, world: StaticWorld, thrown = false) {
  if (v) {
    if (v.seats[p.seat] === p.id) v.seats[p.seat] = -1;
    AIR_OUT = 0;
    exitSpot(p, v, world, S3);
    p.x = S3[0]; p.y = S3[1]; p.z = S3[2];
    p.vx = v.vx; p.vz = v.vz; p.vy = Math.max(0, v.vy);
    // out of a flying helicopter: all of its velocity (one coming down keeps coming down beside the kong, not
    // onto it) and a push away from the door
    if (AIR_OUT !== 0) { const s = AIR_OUT * BAIL_PUSH; p.vy = v.vy; p.vx += dmath.cos(v.yaw) * s; p.vz -= dmath.sin(v.yaw) * s; }
    if (thrown) { const dx = p.x - v.x, dz = p.z - v.z, d = dmath.hypot(dx, dz) || 1; p.vx += (dx / d) * 3.5; p.vz += (dz / d) * 3.5; p.vy += 5; }
    // nobody left at the bars: a slow tuk-tuk is left parked, a fast one rolls on by itself
    if (v.seats[0] < 0 && dmath.hypot(v.vx, v.vz) < 2.5) v.flags |= VF.PARK;
    v.idleT = 0;
  }
  p.st = 0; p.veh = -1; p.seat = 0; p.grounded = false; p.crouch = false; p.sprint = false; p.swim = false; p.under = false; p.slope = false;
  p.coyote = 0; p.jumpBuf = 0; p.airT = 0; p.fallV = Math.min(0, p.vy); p.mvT = 0; p.mvY = 0;
}
/** move to the next free seat (driver → bench → bars …); false = nowhere to go */
export function switchSeat(p: Rider, v: Vehicle): boolean {
  for (let i = 1; i < 3; i++) {
    const k = (p.seat + i) % 3;
    if (v.seats[k] >= 0) continue;
    if (v.seats[p.seat] === p.id) v.seats[p.seat] = -1;
    v.seats[k] = p.id; p.seat = k;
    return true;
  }
  return false;
}

/** jump straight to seat k (F1–F3 / 1–3): false = taken, the same seat, or no such seat */
export function takeSeat(p: Rider, v: Vehicle, k: number): boolean {
  if (k < 0 || k > 2 || k === p.seat || v.seats[k] >= 0) return false;
  if (v.seats[p.seat] === p.id) v.seats[p.seat] = -1;
  v.seats[k] = p.id; p.seat = k;
  return true;
}

/** distance from (x, z) to v's footprint (0 inside) — the E reach, and who a blast / a bumper touches */
export function footDist(v: Vehicle, x: number, z: number): number {
  const SP = specOf(v.kind), sy = dmath.sin(v.yaw), cy = dmath.cos(v.yaw), dx = x - v.x, dz = z - v.z;
  const lx = dx * cy - dz * sy, lz = dx * sy + dz * cy - SP.FOOT_Z;
  const ox = Math.abs(lx) - SP.FOOT_HW, oz = Math.abs(lz) - SP.FOOT_HL;
  return dmath.hypot(Math.max(0, ox), Math.max(0, oz));
}
/**
 * The tuk-tuk an E press of a kong on foot at (x, y, z) looking along (dx, dy, dz) from its eye would act on: the one
 * under the crosshair within arm's reach (`aimed` = true), else the nearest within REACH. −1 = none. ONE rule for the
 * server's interact and the client's prompt. `airborne`: the kong is off the ground — it climbs into nothing that flies
 * (an E pressed again on the way down after bailing out must not put it straight back into the helicopter).
 */
export function vehicleInReach(set: VehicleSet, x: number, y: number, z: number, eye: number, dx: number, dy: number, dz: number, aimed: boolean, airborne = false): number {
  let best = -1, bd = aimed ? 4.2 : 1e9;
  for (const v of set.list) {
    if (v.st !== VS.Ok && v.st !== VS.Tipped) continue;
    if (airborne && v.air) continue;
    const SP = specOf(v.kind), ex = v.x - x, ez = v.z - z;
    if (ex * ex + ez * ez > 64 || y - v.y > 2.6 || v.y - y > 2.2) continue;
    if (aimed) { const t = rayVehicle(vehPose(v, P6), v.kind, x, eye, z, dx, dy, dz, bd); if (t >= 0 && t < bd && footDist(v, x, z) <= SP.REACH + 0.6) { bd = t; best = v.id; } }
    else { const d = footDist(v, x, z); if (d < SP.REACH && d < bd) { bd = d; best = v.id; } }
  }
  return best;
}

// ------------------------------------------------------------------------------------------------ kongs on foot
/** what pushKong reads / writes (Player satisfies it) */
export interface Walker { id: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; grounded: boolean; fallV: number; airT: number; surf: number }
/**
 * Keep a kong on foot out of every tuk-tuk: pushed out through the nearest side of the footprint (its speed into the
 * panel removed), or standing on the roof when it comes down on one. Runs in the kong's own step — on the server
 * against where the tuk-tuks are, in the prediction against where the client last heard they were (identical for a
 * parked one). Returns true when it touched one.
 */
export function pushKong(set: VehicleSet, p: Walker, h: number): boolean {
  let hit = false;
  for (const v of set.list) {
    if (v.st === VS.Gone || v.st === VS.Sunk) continue;
    const SP = specOf(v.kind), heli = v.kind === VKind.Heli, dx = p.x - v.x, dz = p.z - v.z;
    if (dx * dx + dz * dz > (heli ? 20 : 9.5)) continue;
    const base = v.y + (heli ? 0 : tipLift(v.tip)), top = base + (v.st === VS.Tipped ? 1.75 : SP.ROOF);
    if (p.y >= top || p.y + h <= base + 0.2) continue;
    const sy = dmath.sin(v.yaw), cy = dmath.cos(v.yaw);
    const lx = dx * cy - dz * sy, lz = dx * sy + dz * cy - SP.FOOT_Z;
    const ox = Math.abs(lx) - SP.FOOT_HW - PLAYER_R, oz = Math.abs(lz) - SP.FOOT_HL - PLAYER_R;
    if (ox >= 0 || oz >= 0) continue;
    // corners: a circle against the footprint's rounded corner
    const cxo = Math.abs(lx) - SP.FOOT_HW, czo = Math.abs(lz) - SP.FOOT_HL;
    if (cxo > 0 && czo > 0 && cxo * cxo + czo * czo >= PLAYER_R * PLAYER_R) continue;
    hit = true;
    // coming down on the roof: stand on it
    if (p.y > top - 0.45 && p.vy <= 0.5) { p.y = top; p.vy = 0; p.grounded = true; p.fallV = 0; p.airT = 0; p.surf = 1; continue; }
    let nx: number, nz: number, d: number;
    if (ox > oz) { nx = lx >= 0 ? 1 : -1; nz = 0; d = -ox; } else { nx = 0; nz = lz >= 0 ? 1 : -1; d = -oz; }
    // body frame (right, back) → world: right = (cy, −sy), back = (sy, cy)
    const wx = nx * cy + nz * sy, wz = -nx * sy + nz * cy;
    p.x += wx * d; p.z += wz * d;
    const vn = (p.vx - v.vx) * wx + (p.vz - v.vz) * wz;
    if (vn < 0) { p.vx -= wx * vn; p.vz -= wz * vn; if (-vn > v.bump[p.id & 63]) v.bump[p.id & 63] = -vn; }
  }
  return hit;
}

// ------------------------------------------------------------------------------------------------ parking
/** a taxi rank is a roadside thing: a paved yard or a dirt road up to this much farther from the anchor beats grass (m) */
export const ROAD_PULL = 16;
const onRoad = (world: StaticWorld, x: number, z: number) => { const b = world.groundBiome(x, z); return b === Biome.Path || b === Biome.Paved; };
/**
 * A parking spot near (ax, az): level ground above the sea with the open sky over it, both collision circles clear,
 * and room to drive off. Deterministic rings (≤ `reach` m), nearest first; `pull` > 0 = a taxi rank: paving and dirt
 * roads up to `pull` m farther out come first, and it parks along the road. Writes [x, z, yaw] — nose toward the most
 * open side — and returns false when the neighbourhood has nowhere to park. (Once per world: this one allocates.)
 */
export function findParking(world: StaticWorld, ax: number, az: number, reach: number, yawHint: number, out: Float64Array, taken: ReadonlyArray<readonly [number, number]> = [], pull = 0): boolean {
  const T = world.terrain;
  const cand: Array<[number, number, number]> = [];
  for (let ring = 0; ring * 2.5 <= reach; ring++) {
    const r = ring * 2.5, n = ring === 0 ? 1 : Math.max(8, Math.round((TAU * r) / 3));
    for (let k = 0; k < n; k++) {
      const a = yawHint + (k / n) * TAU, x = ax + dmath.cos(a) * r, z = az + dmath.sin(a) * r;
      if (T.height(x, z) < 1.2 || T.normal(x, z, N3)[1] < 0.985) continue;
      cand.push([x, z, r + (pull > 0 && !onRoad(world, x, z) ? pull : 0)]);
    }
  }
  if (pull > 0) cand.sort((p, q) => p[2] - q[2]);
  const HEADS = 16;
  for (const [x, z] of cand) {
    const y = T.height(x, z);
    if (taken.some(([tx, tz]) => (tx - x) * (tx - x) + (tz - z) * (tz - z) < 64)) continue;
    // the open sky: never in a room, under a roof or a canopy deck
    world.raycast(x, y + 0.4, z, 0, 1, 0, 40, GH, false);
    if (GH.hit) continue;
    // nose toward the most room (a 9 m probe at bumper + roof-rail height) — a rank: down the road first
    let bestYaw = 0, bestFree = -1, bestRun = -1, open = 0;
    for (let h = 0; h < HEADS; h++) {
      const yaw = yawHint + (h / HEADS) * TAU, fx = -dmath.sin(yaw), fz = -dmath.cos(yaw);
      let free = 9, run = 0;
      for (const hy of [0.5, 1.5]) { world.raycast(x, y + hy, z, fx, 0, fz, 9, GH, false); if (GH.hit && GH.t < free) free = GH.t; }
      if (free >= 5.5) open++;
      if (free < 7) continue;
      if (pull > 0) for (let k = 1; k <= 5; k++) { if (!onRoad(world, x + fx * k * 2.4, z + fz * k * 2.4)) break; run++; }
      if (run > bestRun || (run === bestRun && free > bestFree + 0.05)) { bestRun = run; bestFree = free; bestYaw = yaw; }
    }
    if (open * 2 < HEADS || bestFree < 7) continue;
    // its own footprint: both circles stand free and level where it would park
    const sy = dmath.sin(bestYaw), cy = dmath.cos(bestYaw);
    let ok = true;
    for (let c = 0; c < 2 && ok; c++) {
      const off = c === 0 ? TUK.C_FRONT : TUK.C_REAR, rr = (c === 0 ? TUK.R_FRONT : TUK.R_REAR) + 0.25;
      const cx = x + sy * off, cz = z + cy * off, gy = T.height(cx, cz);
      if (Math.abs(gy - y) > 0.3) { ok = false; break; }
      world.velY = 0; world.headBump = false; world.wallHit = false;
      world.resolveCapsule(cx, gy + 0.6, cz, rr, TUK.CAP_H - 0.6, false);
      if (world.overlap || world.headBump || Math.abs(world.P[0] - cx) + Math.abs(world.P[2] - cz) > 0.02) ok = false;
    }
    if (!ok) continue;
    out[0] = x; out[1] = z; out[2] = bestYaw;
    return true;
  }
  return false;
}
