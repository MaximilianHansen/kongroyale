// THE WIRE. Binary (DataView, little-endian) for the hot path — inputs, snapshots, events — JSON for the rare path.
// Every frame is independently decodable (no delta chaining): a late-joining or lagging client is never confused.
// Every binary server→client frame carries an id (tick / sequence), so a client listening on two redundant sockets
// (see client/src/game/net.ts) processes each frame exactly once, in order.
import type { Input, Player } from "../sim/player";
import { HISTORY_TICKS, INPUT_CREDIT_MAX, POS_Q } from "../sim/const";
import { qf16 } from "../sim/hitscan";
import { VKind, VS, qVPitch, qVRoll, specOf, vehPose, PITCH_VQ, ROLL_VQ, type Vehicle } from "../sim/vehicle";
import { HELI } from "../sim/heli";
import type { EconView } from "../sim/economy";
import * as dmath from "../sim/dmath";

export const enum M { Input = 1, Ping = 2, InvOp = 3, Inputs = 4, Snapshot = 16, Events = 17, Inventory = 18, Pong = 19,
  /** (caster) the full-information snapshot a commentator seat gets: every player, exact health, every vehicle */
  CastSnap = 20,
  /** (caster) every player's loadout + match stats (~4 Hz) */
  CastStats = 21 }
export const enum EV { Hit = 1, Shot = 2, Kill = 3, Chest = 4, SpawnItem = 5, TakeItem = 6, Explosion = 7, Rocket = 8, RocketEnd = 9, Respawn = 10, Jump = 11, Land = 12, Storm = 13, Announce = 14,
  /** a pane broke — [pane u16][cause | side << 2 u8 (shared/sim/glass.ts GC)][by u8] */ Glass = 15,
  /** tuk-tuk one-shots (shared/sim/vehicle.ts): [veh u8][kind u8 (VK)][a u8][x f32][y f32][z f32] */ Veh = 16,
  /** a bullet / a blast landed on a tuk-tuk: [shooter u8][veh u8][dmg × 4 u16][x f32][y f32][z f32] */ VehHit = 17,
  // --- loot events (numbered high) ---
  /** a banana bomb was thrown: [id u16][owner u8][x y z f32][vx vy vz f32][fuse ms u16] */ Bomb = 40,
  /** a banana bomb is gone (it went off: EV.Explosion carries the blast): [id u16] */ BombEnd = 41,
  /** a crate wall was set down: [id u16][owner u8][x y z f32][yaw u16][hp u16] */ Cover = 42,
  /** a crate wall is gone: [id u16][why u8: 0 crumbled (time / replaced), 1 broken] */ CoverEnd = 43,
  /** a crate wall took damage: [id u16][hp u16] */ CoverHit = 44,
  /** end-game loot regen: an opened chest / ammo box closed again, restocked (glow + hum back): [id u16] */ ChestReset = 45 }
/** EV.Veh kinds. `a`: Enter / Exit / Flip = the kong, Crash / Land = how hard (m/s × 12, capped) */
export const enum VK { Enter = 1, Exit = 2, Tip = 3, Flip = 4, Boom = 5, Crash = 6, Land = 7, Slam = 8, Sunk = 9, Burn = 10,
  /** a helicopter's rotor cut a kong down: a = the kong, (x, y, z) = where */ Chop = 11 }

const TAU = Math.PI * 2;
export const yawEnc = (a: number) => Math.round((a / TAU) * 65536) & 0xffff;
export const yawDec = (u: number) => { let a = (u / 65536) * TAU; if (a > Math.PI) a -= TAU; return a; };
export const PITCH_MAX = 1.56;
export const pitchEnc = (p: number) => Math.round(Math.max(-PITCH_MAX, Math.min(PITCH_MAX, p)) * 20000);
export const pitchDec = (i: number) => i / 20000;
// (B.SEAT field, B.RADIO, B.THROW; B.DESCEND sits at 0x4000, off the SEAT field)
export const BUTTON_MASK = 0x7fff;
const clamp1 = (v: number) => (v < -1 ? -1 : v > 1 ? 1 : v);

export class Writer {
  dv: DataView; o = 0;
  private readonly u8a: Uint8Array;
  constructor(readonly buf = new ArrayBuffer(65536)) { this.dv = new DataView(buf); this.u8a = new Uint8Array(buf); }
  /** Copy a pre-encoded record into this packet without allocating a destination view. */
  raw(bytes: Uint8Array) { this.u8a.set(bytes, this.o); this.o += bytes.length; return this; }
  reset() { this.o = 0; return this; }
  u8(v: number) { this.dv.setUint8(this.o, v); this.o += 1; return this; }
  i8(v: number) { this.dv.setInt8(this.o, v); this.o += 1; return this; }
  u16(v: number) { this.dv.setUint16(this.o, v, true); this.o += 2; return this; }
  i16(v: number) { this.dv.setInt16(this.o, v, true); this.o += 2; return this; }
  /** signed 24-bit, little-endian */
  i24(v: number) { this.dv.setUint16(this.o, v & 0xffff, true); this.dv.setInt8(this.o + 2, v >> 16); this.o += 3; return this; }
  u32(v: number) { this.dv.setUint32(this.o, v >>> 0, true); this.o += 4; return this; }
  f32(v: number) { this.dv.setFloat32(this.o, v, true); this.o += 4; return this; }
  f64(v: number) { this.dv.setFloat64(this.o, v, true); this.o += 8; return this; }
  /** a copy of the bytes written so far */
  bytes(): Uint8Array { return new Uint8Array(this.buf.slice(0, this.o)); }
  /** a view (valid until the next write) */
  view(): Uint8Array { return new Uint8Array(this.buf, 0, this.o); }
}
export class Reader {
  dv: DataView; o = 0;
  constructor(readonly u8a: Uint8Array) { this.dv = new DataView(u8a.buffer, u8a.byteOffset, u8a.byteLength); }
  get left() { return this.dv.byteLength - this.o; }
  u8() { const v = this.dv.getUint8(this.o); this.o += 1; return v; }
  i8() { const v = this.dv.getInt8(this.o); this.o += 1; return v; }
  u16() { const v = this.dv.getUint16(this.o, true); this.o += 2; return v; }
  i16() { const v = this.dv.getInt16(this.o, true); this.o += 2; return v; }
  i24() { const lo = this.dv.getUint16(this.o, true), hi = this.dv.getInt8(this.o + 2); this.o += 3; return hi * 65536 + lo; }
  u32() { const v = this.dv.getUint32(this.o, true); this.o += 4; return v; }
  f32() { const v = this.dv.getFloat32(this.o, true); this.o += 4; return v; }
  f64() { const v = this.dv.getFloat64(this.o, true); this.o += 8; return v; }
}

// ---- input (client → server), 21 bytes. The client predicts with quantizeInput()'d values, so the server simulates
// the bit-identical input.
export const INPUT_BYTES = 21;
export const LERP_SPAN_MAX = 16;
export function writeInput(w: Writer, i: Input) {
  w.u8(M.Input).u32(i.seq); writeInputBody(w, i);
}
/** an input after its type and seq: what M.Input and each entry of M.Inputs carry */
export const INPUT_BODY_BYTES = 16;
function writeInputBody(w: Writer, i: Input) {
  w.i8(Math.round(clamp1(i.mx) * 127)).i8(Math.round(clamp1(i.mz) * 127)).u16(yawEnc(i.yaw)).i16(pitchEnc(i.pitch))
    .u16(i.buttons & BUTTON_MASK).u8(i.slot & 0xff).u32(Math.max(0, Math.floor(i.lerpA))).u8(Math.max(0, Math.min(LERP_SPAN_MAX, i.lerpSpan | 0)))
    .u16(Math.round(Math.max(0, Math.min(1, i.lerpF)) * 65535));
}
/** decode + sanitise (every field is range-checked: this is the server's trust boundary). Caller checks the length. */
export function readInput(r: Reader, out: Input) {
  out.seq = r.u32(); readInputBody(r, out);
}
/** decode + sanitise one input body (readInput's fields after the seq) */
export function readInputBody(r: Reader, out: Input) {
  out.mx = clamp1(r.i8() / 127); out.mz = clamp1(r.i8() / 127); out.yaw = yawDec(r.u16()); out.pitch = pitchDec(Math.max(-31200, Math.min(31200, r.i16())));
  out.buttons = r.u16() & BUTTON_MASK; out.slot = r.u8(); out.lerpA = r.u32(); out.lerpSpan = Math.min(LERP_SPAN_MAX, r.u8()); out.lerpF = r.u16() / 65535;
}

// ---- input window (client → server over datagrams, NET_VERSION 11): [M.Inputs][count u8][firstSeq u32][count bodies],
// seqs firstSeq .. firstSeq + count - 1, oldest first. The client sends every input not yet acknowledged (a snapshot's
// lastSeq), so a lost datagram is repaired by the next one; never more than INPUT_WINDOW, since the server can't catch
// up an input older than that anyway (INPUT_CREDIT_MAX). Over a reliable link the client sends single M.Input frames.
export const INPUT_WINDOW = INPUT_CREDIT_MAX;
export const INPUTS_HEAD_BYTES = 6;
/** inputs seq first .. first + count - 1, each read from ring[seq % ring.length] */
export function writeInputs(w: Writer, ring: readonly Input[], first: number, count: number) {
  w.u8(M.Inputs).u8(count).u32(first);
  for (let k = 0; k < count; k++) writeInputBody(w, ring[(first + k) % ring.length]);
}
/** snap an input to exactly what the server will decode (the client predicts with this) */
export function quantizeInput(i: Input) {
  i.mx = clamp1(Math.round(clamp1(i.mx) * 127) / 127); i.mz = clamp1(Math.round(clamp1(i.mz) * 127) / 127);
  i.yaw = yawDec(yawEnc(i.yaw)); i.pitch = pitchDec(pitchEnc(i.pitch)); i.buttons &= BUTTON_MASK; i.slot &= 0xff;
  i.lerpA = Math.max(0, Math.floor(i.lerpA)); i.lerpSpan = Math.max(0, Math.min(LERP_SPAN_MAX, i.lerpSpan | 0)); i.lerpF = qf16(i.lerpF);
}

// ---- inventory op (client → server, rare): [M.InvOp][seq u16][op u8][a u8][b u8]. The client sends it on both of its
// sockets, so the seq dedups it. INV.Move: drag slot a onto slot b. INV.Drop: throw slot a on the ground.
export const enum INV { Move = 1, Drop = 2,
  /** (economy) buy offer b (economy.ts Offer) at Banana Stand a */ Buy = 3,
  /** an eliminated player asks to watch player a (shared/sim/match.ts spectateOp; the server
   *  checks it and answers with the inventory frame's spectate byte) */ Spectate = 4 }
export const INVOP_BYTES = 6;
export function writeInvOp(w: Writer, seq: number, op: INV, a: number, b = 0) { w.u8(M.InvOp).u16(seq & 0xffff).u8(op).u8(a & 0xff).u8(b & 0xff); }

// ---- snapshot (server → client): header, the recipient's exact state, then quantised remote entries
export interface SnapHeader { tick: number; time: number; phase: number; alive: number; squads: number; flags: number; lastSeq: number; count: number }
export const enum SF { Resurgence = 1, ResurgenceWarn = 2, Final = 4, PlaneOpen = 8 }
export function writeSnapHeader(w: Writer, h: SnapHeader) {
  w.u8(M.Snapshot).u32(h.tick).f32(h.time).u8(h.phase).u8(h.alive).u8(h.squads).u8(h.flags).u32(h.lastSeq).u8(h.count);
}
export function readSnapHeader(r: Reader, h: SnapHeader) {
  h.tick = r.u32(); h.time = r.f32(); h.phase = r.u8(); h.alive = r.u8(); h.squads = r.u8(); h.flags = r.u8(); h.lastSeq = r.u32(); h.count = r.u8();
}

/** the recipient's own movement state after input `lastSeq`, at full precision (103 bytes): the client compares it with
 * what it predicted for that input and replays only on a real divergence — no quantisation ever reaches prediction. */
export interface SelfState {
  x: number; y: number; z: number; vx: number; vy: number; vz: number; coyote: number; jumpBuf: number; airT: number; fallV: number;
  /** traversal (slide / mantle) */
  mvT: number; mvY: number;
  st: number; crouch: boolean; grounded: boolean; swim: boolean; slope: boolean; sprint: boolean; prevButtons: number; shotSeq: number; hp: number; shield: number;
  /** PS.Ride: the tuk-tuk (−1 = on foot), the seat, and — when the recipient DRIVES it — the tuk-tuk's own exact state
   * after input `lastSeq` (`drive`): the driver's prediction is reconciled against it like its kong's movement */
  veh: number; seat: number; drive: boolean; v: VehSelf;
  /** red banana buff seconds left (f64: the prediction compares it exactly) */
  buffT: number;
  /** the recipient mans a helicopter's door gun: TOP BANANA's exact state after input `lastSeq` (its prediction is
   * reconciled against it like the driver's against `v`) */
  gun: boolean; g: GunSelf;
  /** swimming: diving under the surface, the air left (0..1), the swimmer's gun-up timer (s) */
  under: boolean; breath: number; swGun: number;
}
/** the predicted part of a helicopter's door gun (shared/sim/heli.ts stepGun), full precision */
export interface GunSelf { aimY: number; aimP: number; spin: number; heat: number; cool: number; idle: number; belt: number; lock: boolean; arm: boolean }
export const makeGunSelf = (): GunSelf => ({ aimY: 0, aimP: 0, spin: 0, heat: 0, cool: 0, idle: 0, belt: 0, lock: false, arm: false });
/** the predicted part of a Vehicle (shared/sim/vehicle.ts), full precision, + what only the server knows (hp, flags) */
/** `kind`: the vehicle's VKind; `hopT`: the tuk-tuk hop's cool-down */
export interface VehSelf { x: number; y: number; z: number; yaw: number; vx: number; vy: number; vz: number; steer: number; tip: number; tipV: number; gPitch: number; gRoll: number; st: number; air: boolean; surf: number; hp: number; flags: number; hopT: number; kind: number }
export const makeVehSelf = (): VehSelf => ({ x: 0, y: 0, z: 0, yaw: 0, vx: 0, vy: 0, vz: 0, steer: 0, tip: 0, tipV: 0, gPitch: 0, gRoll: 0, st: 0, air: false, surf: 255, hp: 0, flags: 0, hopT: 0, kind: 0 });
export const makeSelfState = (): SelfState => ({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, coyote: 0, jumpBuf: 0, airT: 0, fallV: 0, mvT: 0, mvY: 0, st: 0, crouch: false, grounded: false, swim: false, slope: false, sprint: false, prevButtons: 0, shotSeq: 0, hp: 0, shield: 0, veh: -1, seat: 0, drive: false, v: makeVehSelf(), buffT: 0, gun: false, g: makeGunSelf(), under: false, breath: 1, swGun: 0 });
/** `v`: the vehicle `p` rides (null on foot). 114 bytes (incl. the red banana buff f64; swimming: `under` in the
 * flag byte's top bit), + 16 while swimming (breath + the swim gun timer, f64), + 113 while driving
 * (incl. the hop cool-down f64 and the kind u8), + 51 while manning a helicopter's door gun. */
export function writeSelf(w: Writer, p: Player, v: Vehicle | null = null) {
  const drive = v !== null && p.st === 8 && p.seat === 0;
  const gun = v !== null && p.st === 8 && p.seat === HELI.GUN_SEAT && v.kind === VKind.Heli;
  w.f64(p.x).f64(p.y).f64(p.z).f64(p.vx).f64(p.vy).f64(p.vz).f64(p.coyote).f64(p.jumpBuf).f64(p.airT).f64(p.fallV).f64(p.mvT).f64(p.mvY)
    .u8(p.st).u8((p.crouch ? 1 : 0) | (p.grounded ? 2 : 0) | (p.swim ? 4 : 0) | (p.slope ? 8 : 0) | (p.sprint ? 16 : 0) | (drive ? 32 : 0) | (gun ? 64 : 0) | (p.under ? 128 : 0))
    .u16(p.prevButtons & 0xffff).u16(p.shotSeq & 0xffff).u8(byteOf(p.hp)).u8(byteOf(p.shield)).u8(p.veh < 0 ? 255 : p.veh).u8(p.seat).f64(p.buffT);
  if (p.swim) w.f64(p.breath).f64(p.swGun);   // (swimming only: on land the air is full and the gun is not stowed)
  if (drive) {
    w.f64(v.x).f64(v.y).f64(v.z).f64(v.yaw).f64(v.vx).f64(v.vy).f64(v.vz).f64(v.steer).f64(v.tip).f64(v.tipV).f64(v.gPitch).f64(v.gRoll)
      .u8(v.st).u8(v.air ? 1 : 0).u8(v.surf & 0xff).f32(v.hp).u8(v.flags).f64(v.hopT).u8(v.kind);   // (the hop's cool-down; the kind)
  }
  if (gun) w.f64(v.gunAimY).f64(v.gunAimP).f64(v.gunSpin).f64(v.gunHeat).f64(v.gunCool).f64(v.gunIdle).u16(v.gunBelt).u8((v.gunLock ? 1 : 0) | (v.gunArm ? 2 : 0));
}
export function readSelf(r: Reader, o: SelfState) {
  o.x = r.f64(); o.y = r.f64(); o.z = r.f64(); o.vx = r.f64(); o.vy = r.f64(); o.vz = r.f64(); o.coyote = r.f64(); o.jumpBuf = r.f64(); o.airT = r.f64(); o.fallV = r.f64(); o.mvT = r.f64(); o.mvY = r.f64();
  o.st = r.u8(); const b = r.u8(); o.crouch = (b & 1) !== 0; o.grounded = (b & 2) !== 0; o.swim = (b & 4) !== 0; o.slope = (b & 8) !== 0; o.sprint = (b & 16) !== 0; o.drive = (b & 32) !== 0; o.gun = (b & 64) !== 0; o.under = (b & 128) !== 0;
  o.prevButtons = r.u16(); o.shotSeq = r.u16(); o.hp = r.u8(); o.shield = r.u8();
  const vi = r.u8(); o.veh = vi === 255 ? -1 : vi; o.seat = r.u8(); o.buffT = r.f64();
  if (o.swim) { o.breath = r.f64(); o.swGun = r.f64(); } else { o.breath = 1; o.swGun = 0; }
  if (o.drive) {
    const v = o.v;
    v.x = r.f64(); v.y = r.f64(); v.z = r.f64(); v.yaw = r.f64(); v.vx = r.f64(); v.vy = r.f64(); v.vz = r.f64(); v.steer = r.f64(); v.tip = r.f64(); v.tipV = r.f64(); v.gPitch = r.f64(); v.gRoll = r.f64();
    v.st = r.u8(); v.air = r.u8() !== 0; v.surf = r.u8(); v.hp = r.f32(); v.flags = r.u8(); v.hopT = r.f64(); v.kind = r.u8();
  }
  if (o.gun) {
    const g = o.g;
    g.aimY = r.f64(); g.aimP = r.f64(); g.spin = r.f64(); g.heat = r.f64(); g.cool = r.f64(); g.idle = r.f64(); g.belt = r.u16(); const gb = r.u8(); g.lock = (gb & 1) !== 0; g.arm = (gb & 2) !== 0;
  }
}
const byteOf = (v: number) => Math.max(0, Math.min(255, Math.ceil(v)));

/** remote entry: 16 bytes (20 with hp/shield). Position i24 at 1/POS_Q m (≤ 0.98 mm). hp/shield ride for squadmates
 * (HUD) and for every player within shooting range of the recipient: the client needs the exact health to stop predicting
 * hits on a player its own in-flight bullets have already killed (no ghost markers in kill races). u16 at 1/100 hp,
 * rounded UP so a predicted kill is never early. */
const PITCH_Q = 80;
/** held byte (weapons): a swimmer's gun is stowed (shared/sim/player.ts stepSwimGun) — the kong strokes with both arms */
export const HELD_STOWED = 0x40;
/** withHp: squadmates (HUD bars: hp + shield, 4 bytes); withTotal: anyone in shooting range (hp + shield as one u16 —
 * all the kill-race prediction needs, 2 bytes). Flag bits: st byte 8 = hp+shield, anim byte 0x80 = total. */
export function writePlayer(w: Writer, p: Player, withHp: boolean, withTotal = false) {
  const s = p.slots[p.active];
  // (poi-mythic: a mythic rides as its tier, 5; swimming: 0x40 = a swimmer's gun is stowed — both arms stroke)
  const held = s.kind === 1 ? (s.id | (Math.min(5, s.rarity) << 3) | (p.swim && (p.under || p.swGun <= 0) ? HELD_STOWED : 0)) : s.kind === 2 ? (0x80 | s.id) : 0xff;
  const total = withTotal && !withHp;
  w.u8(p.id).i24(Math.round(p.x * POS_Q)).i24(Math.round(p.y * POS_Q)).i24(Math.round(p.z * POS_Q))
    .u16(yawEnc(p.yaw)).i8(Math.max(-127, Math.min(127, Math.round(p.pitch * PITCH_Q))))
    .u8((p.st === 9 ? 0 : p.st & 7) | (withHp ? 8 : 0) | (p.crouch ? 16 : 0) | (p.sprint ? 32 : 0) | (p.swim ? 64 : 0) | (p.grounded ? 128 : 0))
    // (the anim byte: 4 state bits, then PS.Ride — the state's 4th bit — with its seat, then the health flag;
    //  the 4th bit with "seat 3" = PS.Climb, on a ladder / trunk)
    .u8(held).u8((p.anim & 0x0f) | (p.st === 8 ? 0x10 | ((p.seat & 3) << 5) : p.st === 9 ? 0x70 : 0) | (total ? 0x80 : 0));
  if (withHp) w.u16(hpQ(p.hp)).u16(hpQ(p.shield));
  else if (total) w.u16(hpQ(Math.max(0, p.hp) + Math.max(0, p.shield)));
}
const hpQ = (v: number) => Math.max(0, Math.min(65535, Math.ceil(v * 100 - 1e-6)));
export interface PlayerSnap { id: number; x: number; y: number; z: number; yaw: number; pitch: number; vx: number; vy: number; vz: number; st: number; crouch: boolean; sprint: boolean; swim: boolean; grounded: boolean; hasHp: boolean; hp: number; shield: number; held: number; anim: number; team: number; tick: number;
  /** hp + shield when the entry carried health (hasHp or the range-only total), else -1 */
  total: number;
  /** PS.Ride: which seat (0 = driver) */
  seat: number }
export const makePlayerSnap = (): PlayerSnap => ({ id: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, vx: 0, vy: 0, vz: 0, st: 0, crouch: false, sprint: false, swim: false, grounded: false, hasHp: false, hp: 0, shield: 0, held: 0xff, anim: 0, team: 0, tick: 0, total: -1, seat: 0 });
/** decodes an entry; hp/shield are only written when present (hasHp) */
export function readPlayer(r: Reader, o: PlayerSnap) {
  o.id = r.u8(); o.x = r.i24() / POS_Q; o.y = r.i24() / POS_Q; o.z = r.i24() / POS_Q; o.yaw = yawDec(r.u16()); o.pitch = r.i8() / PITCH_Q;
  const b = r.u8(); o.st = b & 7; o.hasHp = (b & 8) !== 0; o.crouch = (b & 16) !== 0; o.sprint = (b & 32) !== 0; o.swim = (b & 64) !== 0; o.grounded = (b & 128) !== 0;
  o.held = r.u8(); const an = r.u8(); o.anim = an & 0x0f; o.total = -1;
  if (an & 0x10) { const s = (an >> 5) & 3; if (s === 3) { o.st = 9; o.seat = 0; } else { o.st = 8; o.seat = s; } } else o.seat = 0;
  if (o.hasHp) { o.hp = r.u16() / 100; o.shield = r.u16() / 100; o.total = o.hp + o.shield; }
  else if (an & 0x80) o.total = r.u16() / 100;
}

// ---- vehicles (server → client, after the remote entries): [count u8] then 25 bytes each (+ 9 for a helicopter). The
// pose is the one that is drawn, sat in and shot at (shared/sim/vehicle.ts vehPose), quantised: i24 position at 1/POS_Q
// m, u16 yaw, i8 pitch, i16 roll — the server's rewind history holds exactly these numbers. The state byte carries the
// kind (VKind) in its high nibble; the hull byte is a share of that kind's HP; after the seats, the radio station
// (u8). A helicopter adds its door gun (what everybody draws): the aim (u16 world yaw, i16 pitch × 10000), barrel spin and
// heat (u8 shares), the belt (u16), overheated (bit 0).
export interface VehSnap { id: number; x: number; y: number; z: number; yaw: number; pitch: number; roll: number; vf: number; steer: number; hp: number; flags: number; st: number; kind: number; s0: number; s1: number; s2: number; tick: number; radio: number;
  /** a helicopter's door gun: aim (world yaw / pitch), spin 0..1, heat 0..1, rounds left, overheated */
  gunY: number; gunP: number; gunSpin: number; gunHeat: number; gunBelt: number; gunLock: boolean }
export const makeVehSnap = (): VehSnap => ({ id: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, vf: 0, steer: 0, hp: 0, flags: 0, st: VS.Gone, kind: 0, s0: -1, s1: -1, s2: -1, tick: 0, radio: 0, gunY: 0, gunP: 0, gunSpin: 0, gunHeat: 0, gunBelt: 0, gunLock: false });
export const VEH_BYTES = 25, VEH_GUN_BYTES = 9;
const VPOSE = new Float64Array(6);
const seatByte = (id: number) => (id < 0 ? 255 : id);
export function writeVehicle(w: Writer, v: Vehicle) {
  vehPose(v, VPOSE);
  const vf = -v.vx * dmath.sin(v.yaw) - v.vz * dmath.cos(v.yaw);
  w.u8(v.id).i24(Math.round(VPOSE[0] * POS_Q)).i24(Math.round(VPOSE[1] * POS_Q)).i24(Math.round(VPOSE[2] * POS_Q))
    .u16(yawEnc(VPOSE[3])).i8(qVPitch(VPOSE[4])).i16(qVRoll(VPOSE[5]))
    .i16(Math.max(-32767, Math.min(32767, Math.round(vf * 256)))).i8(Math.max(-127, Math.min(127, Math.round(v.steer * 127))))
    .u8(Math.max(0, Math.min(255, Math.ceil((v.hp / specOf(v.kind).HP) * 255)))).u8(v.flags & 0xff).u8((v.st & 0x0f) | ((v.kind & 0x0f) << 4))
    .u8(seatByte(v.seats[0])).u8(seatByte(v.seats[1])).u8(seatByte(v.seats[2])).u8(v.radio & 0xff);   // (the radio station)
  if (v.kind === VKind.Heli) {
    w.u16(yawEnc(v.gunAimY)).i16(Math.max(-32767, Math.min(32767, Math.round(v.gunAimP * 10000)))).u8(Math.round(Math.max(0, Math.min(1, v.gunSpin)) * 255))
      .u8(Math.round(Math.max(0, Math.min(1, v.gunHeat)) * 255)).u16(Math.max(0, Math.min(65535, v.gunBelt))).u8(v.gunLock ? 1 : 0);
  }
}
export function readVehicle(r: Reader, o: VehSnap) {
  o.id = r.u8(); o.x = r.i24() / POS_Q; o.y = r.i24() / POS_Q; o.z = r.i24() / POS_Q; o.yaw = yawDec(r.u16()); o.pitch = r.i8() / PITCH_VQ; o.roll = r.i16() / ROLL_VQ;
  o.vf = r.i16() / 256; o.steer = r.i8() / 127; const hq = r.u8() / 255; o.flags = r.u8(); const sb = r.u8(); o.st = sb & 0x0f; o.kind = sb >> 4; o.hp = hq * specOf(o.kind).HP;
  const a = r.u8(), b = r.u8(), c = r.u8(); o.s0 = a === 255 ? -1 : a; o.s1 = b === 255 ? -1 : b; o.s2 = c === 255 ? -1 : c; o.radio = r.u8();
  if (o.kind === VKind.Heli) { o.gunY = yawDec(r.u16()); o.gunP = r.i16() / 10000; o.gunSpin = r.u8() / 255; o.gunHeat = r.u8() / 255; o.gunBelt = r.u16(); o.gunLock = (r.u8() & 1) !== 0; }
  else { o.gunSpin = 0; o.gunHeat = 0; o.gunBelt = 0; o.gunLock = false; }
}

// ---- inventory (server → client, on change + every second): 1 + 5*5 + 4*2 + 1 (active) + 9 (economy) + 1 (spectate) + 2 (seq)
// = 47 bytes. (economy) after the active slot: the wallet u16, the squad's bounty contract (target team u8,
// 255 = none · seconds left u8 · the circle's centre i16 x / z, m) and the seconds left of a bounty ON the squad u8
export function writeInventory(w: Writer, p: Player, e: EconView | null = null) {
  w.u8(M.Inventory);
  for (const s of p.slots) w.u8(s.kind).u8(s.id).u8(s.rarity).u8(s.count).u8(s.mag);
  for (let i = 0; i < 4; i++) w.u16(p.ammo[i]);
  w.u8(p.active);
  w.u16(Math.max(0, Math.min(65535, Math.round(p.cash))));
  w.u8(e ? e.huntTeam & 0xff : 255).u8(e ? Math.min(255, e.huntLeft) : 0).i16(e ? Math.round(e.hx) : 0).i16(e ? Math.round(e.hz) : 0).u8(e ? Math.min(255, e.huntedLeft) : 0);
}
/** returns the active slot; the caller then reads the spectate target (255 = none) and the u16 frame seq */
export function readInventory(r: Reader, p: Player, e: EconView | null = null) {
  for (const s of p.slots) { s.kind = r.u8(); s.id = r.u8(); s.rarity = r.u8(); s.count = r.u8(); s.mag = r.u8(); }
  for (let i = 0; i < 4; i++) p.ammo[i] = r.u16();
  const active = r.u8();
  p.cash = r.u16();
  const ht = r.u8(), hl = r.u8(), hx = r.i16(), hz = r.i16(), hd = r.u8();
  if (e) { e.cash = p.cash; e.huntTeam = ht; e.huntLeft = hl; e.hx = hx; e.hz = hz; e.huntedLeft = hd; }
  return active;
}

/** the wire's version (2: EV.Glass · 3: tuk-tuks — PS.Ride, the vehicle entries, EV.Veh / EV.VehHit · 4: analog move
 *  (a partial stick push walks slower) + helicopters · 5: red banana buff + tuk hop in the self state,
 *  seat/radio/throw input bits, climb state, banana bomb / crate wall / economy events + inventory bytes, squad map pings
 *  · 6: the helicopter's door gun (its state in a
 *  gunner's self block and on every helicopter entry, KILL_GUN; B.DESCEND at 0x4000, KILL_HELI at 250, the radio its own
 *  byte on the vehicle entry) · 8: swimming — `under` + breath + the swim gun timer in the self state, HELD_STOWED on the
 *  held byte, bullets stop at the water surface · 9: INV.Spectate (the spectator picks who
 *  to watch) and EV.ChestReset (end-game loot regen re-closes a chest) · 10: event lobbies
 *  (admin lobby: shared/net/event.ts — JSON only, the binary frames are unchanged) — the server's "welcome" carries it; a
 *  client on another version reloads · 11: M.Inputs, the window of unacknowledged inputs a WebTransport client sends as
 *  one datagram per tick */
export const NET_VERSION = 11;
export class Events {
  readonly w = new Writer(new ArrayBuffer(32768));
  n = 0;
  constructor() { this.reset(); }
  reset() { this.w.reset(); this.w.u8(M.Events).u8(0).u32(0); this.n = 0; }
  private begin(kind: EV) { this.n++; this.w.u8(kind); return this.w; }
  get empty() { return this.n === 0; }
  /** a view over the frame (valid until reset) */
  finish(tick: number): Uint8Array { this.w.dv.setUint8(1, Math.min(255, this.n)); this.w.dv.setUint32(2, tick >>> 0, true); return this.w.view(); }
  /** zone in the low 6 bits; 0x40 = this hit broke the victim's shield, 0x80 = lethal (same frame length) */
  hit(shooter: number, victim: number, zone: number, dmg: number, x: number, y: number, z: number, kill: boolean, shieldBreak = false) { this.begin(EV.Hit).u8(shooter).u8(victim).u8((zone & 0x3f) | (shieldBreak ? 0x40 : 0) | (kill ? 0x80 : 0)).u16(Math.min(65535, Math.round(dmg * 4))).f32(x).f32(y).f32(z); }
  shot(shooter: number, weapon: number, ox: number, oy: number, oz: number, ex: number, ey: number, ez: number, surf: number, hit: boolean) { this.begin(EV.Shot).u8(shooter).u8(weapon).f32(ox).f32(oy).f32(oz).f32(ex).f32(ey).f32(ez).u8((surf & 0x7f) | (hit ? 0x80 : 0)); }
  kill(killer: number, victim: number, weapon: number, final: boolean) { this.begin(EV.Kill).u8(killer & 0xff).u8(victim).u8(weapon).u8(final ? 1 : 0); }
  chest(id: number, by: number) { this.begin(EV.Chest).u16(id).u8(by); }
  spawnItem(id: number, kind: number, sub: number, rarity: number, count: number, x: number, y: number, z: number) { this.begin(EV.SpawnItem).u16(id).u8(kind).u8(sub).u8(rarity).u8(count).f32(x).f32(y).f32(z); }
  takeItem(id: number, by: number) { this.begin(EV.TakeItem).u16(id).u8(by); }
  explosion(x: number, y: number, z: number, r: number) { this.begin(EV.Explosion).f32(x).f32(y).f32(z).u8(Math.round(r * 10)); }
  rocket(id: number, owner: number, x: number, y: number, z: number, vx: number, vy: number, vz: number) { this.begin(EV.Rocket).u16(id).u8(owner).f32(x).f32(y).f32(z).f32(vx).f32(vy).f32(vz); }
  rocketEnd(id: number) { this.begin(EV.RocketEnd).u16(id); }
  respawn(id: number, x: number, y: number, z: number) { this.begin(EV.Respawn).u8(id).f32(x).f32(y).f32(z); }
  jump(id: number) { this.begin(EV.Jump).u8(id); }
  land(id: number, surf: number) { this.begin(EV.Land).u8(id).u8(surf); }
  storm(phase: number, shrinking: boolean) { this.begin(EV.Storm).u8(phase).u8(shrinking ? 1 : 0); }
  announce(code: number, a = 0, b = 0) { this.begin(EV.Announce).u8(code).u8(a).u8(b); }
  glass(pane: number, cause: number, by: number) { this.begin(EV.Glass).u16(pane).u8(cause).u8(by & 0xff); }
  veh(id: number, kind: number, a: number, x: number, y: number, z: number) { this.begin(EV.Veh).u8(id).u8(kind).u8(Math.max(0, Math.min(255, Math.round(a))) & 0xff).f32(x).f32(y).f32(z); }
  bomb(id: number, owner: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, fuse: number) { this.begin(EV.Bomb).u16(id).u8(owner).f32(x).f32(y).f32(z).f32(vx).f32(vy).f32(vz).u16(Math.max(0, Math.min(65535, Math.round(fuse * 1000)))); }
  bombEnd(id: number) { this.begin(EV.BombEnd).u16(id); }
  cover(id: number, owner: number, x: number, y: number, z: number, yaw: number, hp: number) { this.begin(EV.Cover).u16(id).u8(owner & 0xff).f32(x).f32(y).f32(z).u16(yawEnc(yaw)).u16(Math.max(0, Math.min(65535, Math.ceil(hp)))); }
  coverEnd(id: number, why: number) { this.begin(EV.CoverEnd).u16(id).u8(why); }
  coverHit(id: number, hp: number) { this.begin(EV.CoverHit).u16(id).u16(Math.max(0, Math.min(65535, Math.ceil(hp)))); }
  chestReset(id: number) { this.begin(EV.ChestReset).u16(id); }
  vehHit(shooter: number, veh: number, dmg: number, x: number, y: number, z: number) { this.begin(EV.VehHit).u8(shooter & 0xff).u8(veh).u16(Math.min(65535, Math.round(dmg * 4))).f32(x).f32(y).f32(z); }
}
/** the kill feed's cause for a tuk-tuk: run over by one, or caught in its blast — and a helicopter's: its rotor, its
 * body at speed, its blast */
export const KILL_TUK = 253;
/** the kill feed's cause for a banana bomb */
export const KILL_BOMB = 252;
/** (250: off KILL_BOMB) */
export const KILL_HELI = 250;
/** a helicopter's door gun, TOP BANANA: the kill feed's cause and EV.Shot's weapon byte for its rounds */
export const KILL_GUN = 251;
/** EV.Shot surface code for "a player was hit" (7 bits on the wire: terrain 255 arrives as 127, so this is 126) */
export const SURF_PLAYER = 126;
export const enum ANN { ResurgenceOff = 1, ResurgenceWarn = 2, PlaneOpen = 3, PlaneClosing = 4, Final = 5, Victory = 6, MatchStart = 7, SquadEliminated = 8 }
/** bytes of each event body after its kind byte (for parsers that skip events) */
export const EV_BYTES: Record<number, number> = { 1: 17, 2: 27, 3: 4, 4: 3, 5: 18, 6: 3, 7: 13, 8: 27, 9: 2, 10: 13, 11: 1, 12: 2, 13: 2, 14: 3, 15: 4, 16: 15, 17: 16, 40: 29, 41: 2, 42: 19, 43: 3, 44: 4, 45: 2 };

// ---- caster (commentator seats, client/src/caster): a seat holds no player. It gets the events every player gets, plus
// two frames of its own. CastSnap = the snapshot header minus lastSeq, then EVERY player in the match with exact hp +
// shield (writePlayer's withHp entry: interest management is for players, a caster sees all) and every live vehicle.
// CastStats = per player: team, status bits, kills, damage, wallet, placement, redeploys, the active slot, the five
// slots and the four reserves, seconds to its resurgence, its killer.
export interface CastHeader { tick: number; time: number; phase: number; alive: number; squads: number; flags: number; count: number }
export function writeCastHeader(w: Writer, h: CastHeader) { w.u8(M.CastSnap).u32(h.tick).f32(h.time).u8(h.phase).u8(h.alive).u8(h.squads).u8(h.flags).u8(h.count); }
export function readCastHeader(r: Reader, h: CastHeader) { h.tick = r.u32(); h.time = r.f32(); h.phase = r.u8(); h.alive = r.u8(); h.squads = r.u8(); h.flags = r.u8(); h.count = r.u8(); }
/** CastStats status bits */
export const enum CSF { Bot = 1, Connected = 2, Eliminated = 4, Alive = 8, Resurging = 16, SquadOut = 32, Plane = 64, Winner = 128 }
export interface CastStat {
  id: number; team: number; flags: number; kills: number; damage: number; cash: number; placement: number; redeploys: number; active: number;
  /** five slots: kind, id, rarity, count, mag (shared/sim/player.ts Slot) */
  slots: Array<{ kind: number; id: number; rarity: number; count: number; mag: number }>;
  ammo: number[];
  /** seconds until the resurgence brings it back (−1 = none), who killed it last (−1 = nobody / the storm) */
  respawnIn: number; killer: number;
}
export const makeCastStat = (id: number): CastStat => ({ id, team: 0, flags: 0, kills: 0, damage: 0, cash: 0, placement: 0, redeploys: 0, active: 0, slots: Array.from({ length: 5 }, () => ({ kind: 0, id: 0, rarity: 0, count: 0, mag: 0 })), ammo: [0, 0, 0, 0], respawnIn: -1, killer: -1 });
/** one player's CastStats record: 49 bytes */
export function writeCastStat(w: Writer, p: Player, flags: number, time: number) {
  w.u8(p.id).u8(p.team & 0xff).u8(flags).u8(Math.min(255, p.kills)).u16(Math.max(0, Math.min(65535, Math.round(p.damage)))).u16(Math.max(0, Math.min(65535, Math.round(p.cash))))
    .u8(Math.min(255, p.placement)).u8(Math.min(255, p.redeploys)).u8(p.active);
  for (let i = 0; i < 5; i++) { const s = p.slots[i]; w.u8(s ? s.kind : 0).u8(s ? s.id : 0).u8(s ? s.rarity : 0).u8(s ? Math.min(255, s.count) : 0).u8(s ? Math.min(255, s.mag) : 0); }
  for (let i = 0; i < 4; i++) w.u16(Math.max(0, Math.min(65535, p.ammo[i])));
  w.u16(p.respawnAt >= 0 ? Math.max(0, Math.min(65535, Math.round((p.respawnAt - time) * 10))) : 65535).u8(p.killer >= 0 ? p.killer & 0xff : 255);
}
export function readCastStat(r: Reader, o: CastStat) {
  o.id = r.u8(); o.team = r.u8(); o.flags = r.u8(); o.kills = r.u8(); o.damage = r.u16(); o.cash = r.u16(); o.placement = r.u8(); o.redeploys = r.u8(); o.active = r.u8();
  for (const s of o.slots) { s.kind = r.u8(); s.id = r.u8(); s.rarity = r.u8(); s.count = r.u8(); s.mag = r.u8(); }
  for (let i = 0; i < 4; i++) o.ammo[i] = r.u16();
  const ri = r.u16(); o.respawnIn = ri === 65535 ? -1 : ri / 10; const k = r.u8(); o.killer = k === 255 ? -1 : k;
}

/** interpolation helper: history slot for a tick */
export const histSlot = (tick: number) => (((tick % HISTORY_TICKS) + HISTORY_TICKS) % HISTORY_TICKS) * 5;
