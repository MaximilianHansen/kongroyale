// Client-side match mirror: clock sync, local prediction + reconciliation, remote interpolation with an adaptive
// buffer, loot/chest state, and event decoding. Rendering lives in render.ts; this file has no three.js in it.
//
// Netcode contract:
// - PREDICTION: each 60 Hz tick the local player is stepped with a quantised input (bit-identical to what the server
//   decodes) and the result is stored per input seq. A snapshot carries the server's exact state after input `lastSeq`;
//   if it equals what we predicted for that seq nothing happens, otherwise we restore it and replay the unacked inputs.
// - REMOTES are drawn at a render clock driven by snapshot ARRIVALS (newest data - adaptive jitter buffer), never
//   extrapolated: when data runs out they hold the newest sample.
// - LAG COMPENSATION: every input carries the exact blend (snapshot ticks A, A+span, fraction f) of the last drawn frame;
//   the server rewinds to those same numbers with the same function (shared/sim/hitscan.ts).
import { CHEST_OPEN_DIST, DT, MAX_PLAYERS, PLANE_SPEED, SNAP_EVERY, WARMUP_S, WEAPON_DEFS } from "../../../shared/sim/const";
import { IK, lootReachable, type Chest, type Item } from "../../../shared/sim/loot";
import { B, PS, currentSpread, eyeY, invDrop, invMove, makeInput, makePlayer, pelletDamage, poseFlags, stepPlayer, weaponDef, copyInput, type Input, type Player } from "../../../shared/sim/player";
import { makeStormState, stormAt, type StormPlan, type StormState } from "../../../shared/sim/storm";
import type { StaticWorld } from "../../../shared/sim/world";
import { EV, INV, KILL_BOMB, KILL_GUN, KILL_HELI, KILL_TUK, M, Reader, yawDec, Writer, makeCastStat, makePlayerSnap, makeSelfState, makeVehSnap, quantizeInput, readCastHeader, readCastStat, readInventory, readPlayer, readSelf, readSnapHeader, readVehicle, writeInput, writeInvOp, type CastHeader, type CastStat, type GunSelf, type PlayerSnap, type SelfState, type SnapHeader, type VehSelf, type VehSnap } from "../../../shared/net/proto";
import { SEAT_EYE, TUK, VF, VKind, VS, VehicleSet, blendVeh, rayVehicle, seatPoint, seatRiderAt, vehPose, vehicleInReach, type Vehicle } from "../../../shared/sim/vehicle";
import { GUN_SHOT, TOP_BANANA, gunBarrel, gunOf } from "../../../shared/sim/heli";
import { fleetSpots, type TukSpot } from "../../../shared/sim/tuk-spots";
import { heliIslet, heliPads, heliRange } from "../../../shared/sim/heli-spots";
import { TARGET_STRIDE, blendPose, blendYaw, qf16, shotDir, traceShot, type ShotResult } from "../../../shared/sim/hitscan";
import type { Link } from "./net";
import { planeStep } from "../../../shared/sim/plane";
import type { GameInput } from "./input";
import { WEAPONS } from "../../../shared/world/map";
import { GC, GlassState, glassAim, glassShot } from "../../../shared/sim/glass";
import { manualLootCandidate } from "./hud-state";
import { killMythic } from "../../../shared/sim/mythic";
import { CoverSet } from "../../../shared/sim/cover";
import { makeEconView, STAND_ID0, STAND_SIZE } from "../../../shared/sim/economy";

export interface Remote {
  id: number; present: boolean; lastTick: number; team: number;
  ring: PlayerSnap[]; n: number;
  // interpolated
  x: number; y: number; z: number; yaw: number; pitch: number; vx: number; vy: number; vz: number; st: number; crouch: boolean; sprint: boolean; swim: boolean; grounded: boolean; hp: number; shield: number; held: number; anim: number;
  name: string;
  /** ticks between this remote's last two samples, and the extra render delay that keeps sparse (far) remotes smooth */
  gap: number; extra: number;
  /** the NEWEST server truth (not the interpolated past): exact hp + shield total (players in shooting range carry it),
   * the snapshot tick it came from, and whether that snapshot had them dead — prediction stops hitting a dead player */
  hpNow: number; hpTick: number; deadNow: boolean;
  /** PS.Ride: the tuk-tuk it sits in (−1 = not heard yet / on foot) and its seat (0 = driver) */
  veh: number; seat: number;
}
/** a tuk-tuk as this client knows it: the snapshot ring + what is DRAWN this frame (interpolated, or my own prediction
 * while I am at its bars) */
export interface VehRemote {
  id: number; live: boolean; n: number; lastTick: number; ring: VehSnap[]; gap: number; extra: number;
  /** what the slot holds (shared/sim/vehicle.ts VKind: 0 tuk-tuk, 1 helicopter) */
  kind: number;
  x: number; y: number; z: number; yaw: number; pitch: number; roll: number;
  /** forward speed (m/s), bars (rad, + = left), health, VF flags, VS state, who sits where */
  vf: number; steer: number; hp: number; flags: number; st: number; seats: [number, number, number];
  /** the flat tyres as drawn (shared/sim/vehicle.ts TYRE) */
  tyres: number;
  /** the radio station (0 = off), the server's word (latest snapshot) */
  radio: number;
  /** drawn from my prediction (I drive it) */
  mine: boolean;
  /** a helicopter's door gun as drawn: aim (world yaw / pitch), barrel spin 0..1, heat 0..1, rounds left, overheated —
   * the snapshots' blend, or my own prediction while I man it */
  gunY: number; gunP: number; gunSpin: number; gunHeat: number; gunBelt: number; gunLock: boolean;
  /** render offset bleeding out after the drawn source changed (prediction ↔ interpolation hand-over) */
  ox: number; oy: number; oz: number; oyaw: number; swap: boolean;
}
const VRING = 8;
const makeVehRemote = (id: number): VehRemote => ({ id, live: false, n: 0, lastTick: -1, ring: Array.from({ length: VRING }, makeVehSnap), gap: SNAP_EVERY, extra: 0, kind: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, vf: 0, steer: 0, hp: TUK.HP, flags: 0, st: VS.Gone, seats: [-1, -1, -1], tyres: 0, radio: 0, mine: false, gunY: 0, gunP: 0, gunSpin: 0, gunHeat: 0, gunBelt: 0, gunLock: false, ox: 0, oy: 0, oz: 0, oyaw: 0, swap: false });
const RING = 12;
const makeRemote = (id: number): Remote => ({ id, present: false, lastTick: -1, team: 0, ring: Array.from({ length: RING }, makePlayerSnap), n: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, vx: 0, vy: 0, vz: 0, st: 0, crouch: false, sprint: false, swim: false, grounded: false, hp: 0, shield: 0, held: 0xff, anim: 0, name: "", gap: SNAP_EVERY, extra: 0, hpNow: 0, hpTick: -1, deadNow: false, veh: -1, seat: 0 });

export interface EventSink {
  /** shieldBreak: this hit took the victim's shield to 0 (server verdict) */
  hit(shooter: number, victim: number, zone: number, dmg: number, x: number, y: number, z: number, kill: boolean, shieldBreak?: boolean): void;
  shot(shooter: number, weapon: number, ox: number, oy: number, oz: number, ex: number, ey: number, ez: number, surf: number, hit: boolean): void;
  kill(killer: number, victim: number, weapon: number, final: boolean): void;
  chest(id: number, by: number): void;
  /** end-game regen: an opened chest / ammo box is closed (and restocked) again */
  chestReset?(id: number): void;
  spawnItem(it: Item): void; takeItem(id: number, by: number): void;
  explosion(x: number, y: number, z: number, r: number): void;
  rocket(id: number, owner: number, x: number, y: number, z: number, vx: number, vy: number, vz: number): void; rocketEnd(id: number): void;
  respawn(id: number, x: number, y: number, z: number): void; jump(id: number): void; land(id: number, surf: number): void;
  storm(phase: number, shrinking: boolean): void; announceCode(code: number, a: number, b: number): void;
  /** local predicted shot left the barrel (pellets, spread already applied by the sim) */
  localFire(): void;
  phase(phase: number): void;
  inventory(): void;
  /** optional: the server set our active slot (the input's wanted slot must follow) */
  serverSlot?(slot: number): void;
  /** optional: the server fired `n` shot(s) of ours that this client never predicted (its hands state was a tick off —
   *  a cooldown / swap / reload edge): they still need their fire sound (or a missed sniper shot is silent) */
  unpredictedShots?(n: number): void;
  /** optional: the server's verdict on one of OUR pellets (tracer end + surface; hit = a player was hit) */
  ownShot?(weapon: number, ex: number, ey: number, ez: number, surf: number, hit: boolean): void;
  /** optional: a tuk-tuk one-shot (shared/net/proto.ts VK: boarded, tipped, flipped, crashed, blew …) */
  veh?(id: number, kind: number, a: number, x: number, y: number, z: number): void;
  /** optional: damage landed on a tuk-tuk (shooter −1 = nobody's) */
  vehHit?(shooter: number, veh: number, dmg: number, x: number, y: number, z: number): void;
  /** optional: a banana bomb was thrown (fuse = seconds left) / is gone */
  bomb?(id: number, owner: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, fuse: number): void;
  bombEnd?(id: number): void;
  /** optional: a crate wall stands / took damage / is gone (why 1 = broken) */
  cover?(id: number, owner: number, fresh: boolean): void;
  coverHit?(id: number, hp: number): void;
  coverEnd?(id: number, why: number): void;
  /** optional (economy): the wallet grew by `amount` (a pickup, a bounty, a refund) */
  cashGain?(amount: number): void;
  /** optional: MY predicted throw left the hand this tick (`cooked` s of fuse already burnt) */
  localThrow?(cooked: number): void;
  /** optional: MY tuk-tuk straight from the prediction, no round trip: what its step just reported (shared/sim/vehicle.ts
   * VE bits) and how hard (m/s) */
  tukFeel?(id: number, evt: number, hard: number): void;
}

// prediction ring: movement state AFTER each input seq + the hands flags that fed movement BEFORE it
const PRING = 256;
const PS_STRIDE = 22;
const enum PF { X = 0, Y, Z, VX, VY, VZ, COYOTE, JUMPBUF, AIRT, FALLV, ST, BITS, PREVB, SHOTSEQ, PRE, MVT, MVY, VEH, SEAT, BUFF, BREATH, SWGUN }
/** my tuk-tuk's predicted state after each input seq (while I drive): the fields of proto.ts VehSelf the step owns */
const VST = 16;
/** a helicopter's door gun after each input seq (while I man it): the fields of proto.ts GunSelf */
const GST = 9;
/** a snapshot arriving this much later than the earliest-arrival envelope counts as "late" for the jitter window */
const LATE_WIN = 64;
/** arrivals ALL this late (the last N) = the envelope is stale, re-anchor (≈ 330 ms of snapshots) */
const REBASE_N = 10;
const TICKS_RING = 32;
/** correction smaller than this is "no correction" (µm: float noise between two runtimes) */
const EPS = 1e-6;

export interface NetStats {
  /** reconciliations where our prediction for the acked input differed from the server's state */
  corrections: number; moveCorrections: number; stateCorrections: number;
  /** the visual correction applied to the local player (m) — histogram + max */
  corrOver1cm: number; corrOver2cm: number; corrOver10cm: number; corrMax: number;
  snapshots: number; dupFrames: number; staleFrames: number; holdFrames: number;
  /** very late snapshot arrivals clamped as stalls (not counted as jitter) */
  stallSamples: number;
  /** arrival-envelope re-anchors (the source clock stepped back) */
  rebases: number;
}

export class ClientMatch {
  me = -1; readonly pred: Player; readonly auth: SelfState = makeSelfState(); authTick = 0;
  readonly remotes: Remote[] = [];
  names: string[] = [];
  chests: Chest[] = []; items = new Map<number, Item>();
  plan: StormPlan | null = null; readonly storm: StormState = makeStormState();
  /** firing range match (JSON "match".range): no storm / plane, infinite reserve ammo */
  range = false;
  phase = 0; phaseTick = 0; phaseTime = 0; time = 0; alive = 50; squads = 17; flags = 0; mode: "solo" | "trios" = "solo";
  plane = { x0: 0, z0: 0, x1: 0, z1: 0, dx: 0, dz: 0 };
  /** the tick the current plane phase began in (-1 = unknown / not flying): plane exits are predicted from it */
  planeStart = -1;
  /** ping = RTT ms (smoothed); jitter = 90th-percentile snapshot lateness ms; interpTicks = render delay behind the newest data */
  ping = 0; jitter = 0; interpTicks = SNAP_EVERY + 0.5; spectate = -1;
  /** visual correction offset (pred was corrected; smooth it out) */
  errX = 0; errY = 0; errZ = 0;
  /** previous predicted pose for render interpolation */
  px = 0; py = 0; pz = 0; acc = 0;
  readonly netStats: NetStats = { corrections: 0, moveCorrections: 0, stateCorrections: 0, corrOver1cm: 0, corrOver2cm: 0, corrOver10cm: 0, corrMax: 0, snapshots: 0, dupFrames: 0, staleFrames: 0, holdFrames: 0, stallSamples: 0, rebases: 0 };
  /** test hooks: after each predicted tick (the input just simulated); on each correction (metres, state change?) */
  onTick: ((inp: Input) => void) | null = null;
  onCorrection: ((err: number, stateChange: boolean) => void) | null = null;

  // ---- inputs / prediction
  private inputSeq = 0; private ackedSeq = 0;
  private readonly inRing: Input[] = Array.from({ length: PRING }, makeInput);
  private readonly pRing = new Float64Array(PRING * PS_STRIDE); private readonly pSeq = new Int32Array(PRING).fill(-1);
  private readonly inputW = new Writer(new ArrayBuffer(64)); private readonly pingW = new Writer(new ArrayBuffer(16));
  private readonly scratch: Player;
  // ---- clocks
  private tickOffset = 0; private haveOffset = false; private lastPingAt = 0; private lastPongSent = 0;
  private arrOff = 0; private haveArr = false; private readonly late = new Float64Array(LATE_WIN); private readonly lateSort = new Float64Array(LATE_WIN); private lateN = 0; private lateI = 0;
  private rtOff = 0; private rtInit = false; private lastClockT = 0; private rt = 0; private viewValid = false;
  private readonly snapTicks = new Int32Array(TICKS_RING); private snapN = 0; private lastSnapTick = -1;
  // ---- the blend of the last drawn frame (sent with every input) + the hitboxes drawn in it
  viewA = 0; viewSpan = 0; viewF = 0;
  readonly viewTargets = new Float64Array(MAX_PLAYERS * TARGET_STRIDE);
  private readonly blend = new Float64Array(4);
  // ---- dedup ids (two redundant sockets deliver every frame twice)
  /** (read by the caster's replay recorder: the tick of the event frame being dispatched) */
  lastEvTick = -1; private lastInvSeq = -1;
  private readonly hdr: SnapHeader = { tick: 0, time: 0, phase: 0, alive: 0, squads: 0, flags: 0, lastSeq: 0, count: 0 };
  private readonly tmp = makePlayerSnap();
  private teams: number[] = [];
  lastSlotChangeAt = 0; started = false;
  /** when we last SENT an input asking for each slot (performance.now): an inventory frame whose active slot is one we
   *  asked for this recently is an echo of our own earlier choice (built before the server read our newer input), not
   *  the server moving our hands */
  private slotSentAt = [-1e9, -1e9, -1e9, -1e9, -1e9, -1e9, -1e9, -1e9];
  sink: EventSink | null = null;
  readonly cur = makeInput();
  /** breakable glass as the server rules it (EV.Glass, "match".glass) + our own predicted breaks (shots, body, vault) */
  readonly glass: GlassState;
  /** tuk-tuks: the sim copies bound into the world — my prediction steps the one I drive and keeps my kong out of the
   * rest (those hold what the server last said) — and what is drawn */
  readonly vehs: VehicleSet;
  readonly vehicles: VehRemote[] = [];
  /** the crate walls as the server rules them (EV.Cover…): my prediction collides with them */
  readonly covers = new CoverSet();
  /** (economy) my wallet + my squad's bounty contract + the bounty on my squad (the inventory frame), the
   *  Banana Stands of this island (the match info) */
  readonly econ = makeEconView();
  stands: Array<{ x: number; y: number; z: number; yaw: number; poi: number }> = [];
  /** the poses drawn in the last frame [x, y, z, yaw, pitch, roll, state (< 0 = not there)]: what my shots are tested on */
  readonly viewVehs = new Float64Array(TUK.MAX * 7);
  /** the tuk-tuk my prediction drives (−1 = none), its pose before / after the last predicted tick, and the correction
   * still bleeding out of its drawn pose [x, y, z, yaw] */
  driving = -1;
  private readonly vPrev = new Float64Array(6); private readonly vCur = new Float64Array(6); private readonly vErr = new Float64Array(4);
  private readonly vRing = new Float64Array(PRING * VST);
  /** the tuk-tuk the last predictShot stopped on (−1 = none) */
  predVeh = -1;
  /** (caster) a commentator seat: no player of ours, no prediction, no inputs — every player arrives in CastSnap frames
   *  and is drawn like a remote; CastStats fills `castStats` (loadouts, kills, status) */
  caster = false; seat = -1;
  /** (caster replay) the recorded tick this frame draws instead of the live render clock (−1 = live) */
  replayTick = -1;
  readonly castStats: CastStat[] = Array.from({ length: MAX_PLAYERS }, (_, i) => makeCastStat(i));
  /** the tick of the latest CastStats (−1 = none yet) */
  castStatsTick = -1;
  private readonly castHdr: CastHeader = { tick: 0, time: 0, phase: 0, alive: 0, squads: 0, flags: 0, count: 0 };
  /** the helicopter whose door gun my prediction steps (−1 = none): its gun's state after each input seq */
  gunning = -1;
  private readonly gRing = new Float64Array(PRING * GST);
  constructor(readonly world: StaticWorld, readonly link: Link) {
    this.glass = new GlassState(world); this.glass.bind();
    this.vehs = new VehicleSet(world); this.vehs.bind();
    for (let i = 0; i < TUK.MAX; i++) this.vehicles.push(makeVehRemote(i));
    this.pred = makePlayer(0, 0, "me", false); this.scratch = makePlayer(0, 0, "scratch", false);
    for (let i = 0; i < MAX_PLAYERS; i++) this.remotes.push(makeRemote(i));
    link.onBinary = (u8, at) => this.onBinary(u8, at);
  }

  // ---------------------------------------------------------------- clock
  private nowTicks() { return performance.now() / 1000 / DT; }
  /** estimated CURRENT server tick (ping-based) — HUD timers, the plane, staleness */
  serverTick() { return this.nowTicks() + this.tickOffset; }
  /** the newest snapshot tick received (−1 = none yet). Staleness ("not heard from in N ticks") is measured against it,
   * not against serverTick(): a stall in delivery then freezes the remotes where they were instead of hiding them all */
  snapTick() { return this.lastSnapTick; }
  /** the tick remotes are drawn at (last frame) */
  renderTick() { return this.rtInit ? this.rt : this.nowTicks() + this.arrOff - this.interpTicks; }
  private invOpSeq = 0; private readonly invOpW = new Writer(new ArrayBuffer(16));
  /** the player I asked to watch and when (performance.now): shown at once, confirmed by the server */
  private specWant = -1; private specWantAt = -1e9;
  /** eliminated: watch player `id` (the server checks it — shared/sim/match.ts spectateOp) */
  spectateTo(id: number) {
    if (id < 0 || id === this.me || id === this.spectate) return;
    this.spectate = id; this.specWant = id; this.specWantAt = performance.now();
    this.invOpSeq = (this.invOpSeq + 1) & 0xffff;
    writeInvOp(this.invOpW.reset(), this.invOpSeq, INV.Spectate, id); this.link.sendBinary(this.invOpW.view());
    this.resetJitter();
  }
  /** the inventory screen: drag slot a onto slot b / drop slot a. Applied to the prediction now (the same shared op the
   * server runs), then sent; the server's inventory frame confirms it. */
  inventoryOp(op: INV, a: number, b = 0) {
    // (economy) a purchase is the server's call: nothing to predict, just the request
    const ok = op === INV.Buy ? true : op === INV.Move ? invMove(this.pred, a, b) : invDrop(this.pred, a) !== null;
    if (!ok) return false;
    this.invOpSeq = (this.invOpSeq + 1) & 0xffff;
    writeInvOp(this.invOpW.reset(), this.invOpSeq, op, a, b); this.link.sendBinary(this.invOpW.view());
    this.sink?.inventory();
    return true;
  }
  private sendPing() { this.pingW.reset().u8(M.Ping).f64(performance.now()); this.link.sendBinary(this.pingW.view()); this.pingsSent++; }
  private readonly pings = new Float64Array(5); private readonly pingSort = new Float64Array(5); private pingN = 0; private pingsSent = 0;

  /** one snapshot arrival: `arrOff` tracks the earliest-arrival envelope (newest data tick - local time); lateness
   * behind it feeds a 90th-percentile jitter estimate → interpTicks = one snapshot interval + jitter + margin */
  private clockSample(tick: number, nowT: number, at: number) {
    const sample = tick - nowT;
    if (!this.haveArr) { this.arrOff = sample; this.haveArr = true; }
    else if (sample > this.arrOff) this.arrOff = sample;
    else this.arrOff += (sample - this.arrOff) * 0.004;          // follow a slower route / clock drift (~8 s)
    // processed right after a long frame (or a paused tab): the frame arrived some time during the stall — its
    // "lateness" is the main thread's, not the network's, and must not grow the jitter buffer
    if (this.lastFrameAt > 0 && at - this.lastFrameAt > 40) { this.netStats.stallSamples++; return; }
    let late = this.arrOff - sample;
    // the ENVELOPE went stale: every one of the last REBASE_N arrivals is ≥ 1.5 ticks behind it. That is not jitter — the
    // source's clock stepped back relative to ours (the offline host dropped time during a hitch, a server pause, a
    // slower route). Re-anchor on the recent arrivals instead of reading them all as "late" (that pinned the
    // buffer at its 14-tick cap for 15-20 s after the match start, a death or a redeploy hitch).
    this.recentLate[this.recentI] = late; this.recentI = (this.recentI + 1) % REBASE_N; if (this.recentN < REBASE_N) this.recentN++;
    if (this.recentN >= REBASE_N) {
      let mn = Infinity; for (let i = 0; i < REBASE_N; i++) if (this.recentLate[i] < mn) mn = this.recentLate[i];
      if (mn >= 1.5) {
        this.arrOff -= mn; late -= mn; this.netStats.rebases++;
        for (let i = 0; i < REBASE_N; i++) this.recentLate[i] -= mn;
        this.lateN = 0; this.lateI = 0;                           // the old lateness history described the old anchor
      }
    }
    // a burst (frames queued behind ONE stall — a server GC pause, a TCP retransmit — released within a few ms of each
    // other) is one event: only its leader is a jitter observation. Real jitter (independent per-frame delays) still
    // shows up frame after frame and grows the buffer; a stall every few seconds no longer does.
    const arrMs = nowT * DT * 1000, burst = arrMs - this.lastArrMs < 4 && late <= this.lastLate + 0.25;
    this.lastArrMs = arrMs; this.lastLate = late;
    if (burst) { this.netStats.stallSamples++; return; }
    // a stall (a TCP retransmit, a background-tab pause) delivers a burst of very late frames at once: that is an event,
    // not jitter — it is clamped so it can never pin the buffer at its cap; the p90 forgets it within ~2 s
    const p90Prev = this.lateN >= 16 ? this.jitterTicks : late;
    if (late > p90Prev * 2 + 3) { late = p90Prev * 2 + 3; this.netStats.stallSamples++; }
    this.late[this.lateI] = late; this.lateI = (this.lateI + 1) % LATE_WIN; if (this.lateN < LATE_WIN) this.lateN++;
    const n = this.lateN, s = this.lateSort;
    for (let i = 0; i < n; i++) s[i] = this.late[i];
    const v = s.subarray(0, n).sort();
    const p90 = v[Math.min(n - 1, Math.floor(n * 0.9))];
    this.jitterTicks = p90; this.jitter = p90 * DT * 1000;
    const want = Math.max(SNAP_EVERY + 0.25, Math.min(14, SNAP_EVERY + p90 + 0.25));
    this.interpTicks += (want - this.interpTicks) * (n < 16 ? 1 : 0.1);
  }
  private jitterTicks = 0; private lastFrameAt = 0; private lastArrMs = -1e9; private lastLate = 0;
  private readonly recentLate = new Float64Array(REBASE_N); private recentI = 0; private recentN = 0;
  /** forget the jitter history (the view changed: death → spectate, a respawn / redeploy): re-learn it from fresh
   * arrivals, starting from the minimum buffer instead of whatever a hitch around the event left behind */
  resetJitter() { this.lateN = 0; this.lateI = 0; this.recentN = 0; this.haveArr = false; this.lastArrMs = -1e9; }
  /** advance the render clock toward (newest data - interpTicks), slewing ≤ 8 % so remotes never jump or run backward */
  private advanceRenderClock(): number {
    const nowT = this.nowTicks();
    const want = this.arrOff - this.interpTicks;
    if (!this.rtInit) { this.rtOff = want; this.rtInit = true; }
    else {
      const d = want - this.rtOff;
      if (Math.abs(d) > 8) this.rtOff = want;
      else { const step = 0.08 * Math.max(0, nowT - this.lastClockT); this.rtOff += d > step ? step : d < -step ? -step : d; }
    }
    this.lastClockT = nowT;
    return (this.rt = nowT + this.rtOff);
  }

  // ---------------------------------------------------------------- inbound
  onJSON(m: Record<string, unknown>) {
    if (m.t === "match") {
      const pids = m.pids as Record<string, number>;
      const myUid = (m.myUid as number) ?? Number(Object.keys(pids)[0]);
      this.caster = m.caster === true; this.seat = this.caster ? (m.seat as number) ?? 0 : -1;
      this.me = this.caster ? -1 : pids[String(myUid)] ?? Object.values(pids)[0] ?? 0;
      this.pred.id = this.me;
      // (caster) the seat's own "player" never exists: parked out of the world, on no team, never drawn
      if (this.caster) { this.pred.st = PS.Spectate; this.pred.x = 0; this.pred.y = -1000; this.pred.z = 0; this.pred.hp = 0; this.castStatsTick = -1; }
      this.seed = (m.seed as number) ?? 0; this.ranks = null;
      this.mode = m.mode as "solo" | "trios"; this.phase = m.phase as number; this.plan = m.plan as StormPlan; Object.assign(this.plane, m.plane as object);
      this.time = (m.time as number) ?? 0; this.phaseTime = (m.phaseT as number) ?? 0; this.phaseTick = (m.tick as number) - Math.round(this.phaseTime / DT);
      this.planeStart = this.phase === 1 ? this.phaseTick : -1;
      if (Array.isArray(m.teams)) { this.teams = (m.teams as number[]).slice(); for (let i = 0; i < this.remotes.length; i++) this.remotes[i].team = this.teams[i] ?? 0; this.pred.team = this.caster ? -1 : this.teams[this.me] ?? 0; }
      for (const id of (m.chestsOpened as number[]) ?? []) { const c = this.chests[id]; if (c) c.opened = true; }
      // glass: the match's broken panes so far (a late joiner / reconnect sees the same windows) — no shatter FX for these
      this.glass.reset(); for (const id of (m.glass as number[]) ?? []) this.glass.breakPane(id, GC.Shot); this.glass.freshN = 0;
      this.resetVehicles();
      // the crate walls standing when we joined
      this.covers.reset(true);
      this.stands = ((m.stands as number[][]) ?? []).map((r) => ({ x: r[0], y: r[1], z: r[2], yaw: r[3], poi: r[4] }));
      this.stands.forEach((s, i) => this.covers.add(STAND_ID0 + i, 255, s.x, s.y, s.z, s.yaw, 1e9, 0, STAND_SIZE));
      for (const c of (m.covers as number[][]) ?? []) { this.covers.add(c[0], c[1], c[2], c[3], c[4], c[5], c[6], this.time); this.sink?.cover?.(c[0], c[1], false); }
      for (const row of (m.items as number[][]) ?? []) { const it: Item = { id: row[0], kind: row[1], sub: row[2], rarity: row[3], count: row[4], x: row[5], y: row[6], z: row[7], taken: false, bornAt: 0 }; this.items.set(it.id, it); this.sink?.spawnItem(it); }
      this.started = true; this.ackedSeq = this.inputSeq;
      this.sink?.phase(this.phase);
    } else if (m.t === "phase") {
      this.phase = m.phase as number; this.phaseTick = m.tick as number; this.phaseTime = 0; Object.assign(this.plane, m.plane as object); if (m.plan) this.plan = m.plan as StormPlan;
      this.planeStart = this.phase === 1 ? this.phaseTick : -1;
      if (this.phase <= 1) { this.glass.reset(); this.resetVehicles(); for (const w of this.covers.list) if (w.live && !w.perm) { this.covers.remove(w.id); this.sink?.coverEnd?.(w.id, 0); } }   // warm-up / a new match: every pane whole again, a new fleet (the server reset too)
      this.sink?.phase(this.phase);
    }
  }
  /** `at` = when the frame ARRIVED (MessageEvent.timeStamp, performance.now() clock): a frame processed late because the
   * main thread was busy must not look like network jitter */
  onBinary(u8: Uint8Array, at = performance.now()) {
    const r = new Reader(u8); const t = r.u8();
    if (!(at > 0) || at > performance.now()) at = performance.now();
    if (t === M.Snapshot) this.onSnapshot(r, at);
    else if (t === M.CastSnap) this.onCastSnapshot(r, at);
    else if (t === M.CastStats) this.onCastStats(r);
    else if (t === M.Events) this.onEvents(r);
    else if (t === M.Inventory) this.onInventory(r);
    else if (t === M.Pong) {
      const sent = r.f64(), serverTick = r.f64();
      if (sent <= this.lastPongSent) return;                     // the redundant socket's copy
      this.lastPongSent = sent;
      const now = at; const rtt = now - sent;
      // ping readout = median of the last 5 RTTs (an EMA seeded from the first pong — taken while the page was
      // still hitching into the match — opened at 412 ms on a 60 ms link and needed 15 s to settle). A pong handled after
      // a long frame measured the main thread, not the network: skipped.
      if (performance.now() - at < 30 || this.pingN === 0) {
        this.pings[this.pingN++ % 5] = rtt;
        const n = Math.min(5, this.pingN), v = this.pingSort; for (let i = 0; i < n; i++) v[i] = this.pings[i];
        this.ping = v.subarray(0, n).sort()[n >> 1];
      }
      const est = serverTick + (rtt / 2) / 1000 / DT - now / 1000 / DT;
      if (!this.haveOffset) { this.tickOffset = est; this.haveOffset = true; } else this.tickOffset += (est - this.tickOffset) * 0.15;
    }
  }
  private onSnapshot(r: Reader, at: number) {
    const h = this.hdr; readSnapHeader(r, h);
    if (!this.started || this.me < 0) return;
    if (h.tick <= this.lastSnapTick) { if (h.tick === this.lastSnapTick) this.netStats.dupFrames++; else this.netStats.staleFrames++; return; }
    const gGap = this.lastSnapTick >= 0 ? h.tick - this.lastSnapTick : SNAP_EVERY;
    this.lastSnapTick = h.tick; this.netStats.snapshots++;
    const nowT = at / 1000 / DT;
    this.clockSample(h.tick, nowT, performance.now());
    // the snapshot tick is also a floor for the ping-based server clock
    const est = h.tick - nowT + 1;
    if (!this.haveOffset || est > this.tickOffset) { this.tickOffset = est; this.haveOffset = true; }
    this.snapTicks[this.snapN % TICKS_RING] = h.tick; this.snapN++;
    this.phase = h.phase; this.time = h.time; this.alive = h.alive; this.squads = h.squads; this.flags = h.flags;
    readSelf(r, this.auth); this.authTick = h.tick; this.authSeq = h.lastSeq;
    this.takeRemotes(r, h.count, h.tick, gGap);
    // …and only now the prediction: a replay may drive / sit in a tuk-tuk this very snapshot told us about
    this.reconcile(h.lastSeq);
  }
  /** (caster) the full-information snapshot: the same remote + vehicle entries, no self state, nothing to reconcile */
  private onCastSnapshot(r: Reader, at: number) {
    const h = this.castHdr; readCastHeader(r, h);
    if (!this.started || !this.caster) return;
    if (h.tick <= this.lastSnapTick) { if (h.tick === this.lastSnapTick) this.netStats.dupFrames++; else this.netStats.staleFrames++; return; }
    const gGap = this.lastSnapTick >= 0 ? h.tick - this.lastSnapTick : SNAP_EVERY;
    this.lastSnapTick = h.tick; this.netStats.snapshots++;
    const nowT = at / 1000 / DT;
    this.clockSample(h.tick, nowT, performance.now());
    const est = h.tick - nowT + 1;
    if (!this.haveOffset || est > this.tickOffset) { this.tickOffset = est; this.haveOffset = true; }
    this.snapTicks[this.snapN % TICKS_RING] = h.tick; this.snapN++;
    this.phase = h.phase; this.time = h.time; this.alive = h.alive; this.squads = h.squads; this.flags = h.flags;
    this.takeRemotes(r, h.count, h.tick, gGap);
  }
  /** (caster) every player's loadout + stats; `stat.flags` CSF bits */
  private onCastStats(r: Reader) {
    const tick = r.u32(), n = r.u8();
    if (tick < this.castStatsTick) return;                       // the redundant socket's older copy
    this.castStatsTick = tick;
    for (let i = 0; i < n; i++) { const id = r.dv.getUint8(r.o); const o = this.castStats[id] ?? makeCastStat(id); readCastStat(r, o); this.castStats[id] = o; }
  }
  /** the remote entries + vehicle block of a snapshot (player or caster) */
  private takeRemotes(r: Reader, count: number, tick: number, gGap: number) {
    for (let i = 0; i < this.remotes.length; i++) this.remotes[i].present = false;
    for (let i = 0; i < count; i++) {
      const s = this.tmp; readPlayer(r, s); s.tick = tick;
      const rm = this.remotes[s.id]; if (!rm || s.id === this.me) continue;
      if (s.total >= 0) { rm.hpNow = s.total; rm.hpTick = tick; }
      if (!s.hasHp) { s.hp = rm.hp; s.shield = rm.shield; }
      rm.deadNow = s.st === PS.Dead || s.st === PS.Spectate;
      s.team = rm.team;
      // a remote that was absent for a while restarts its ring: never interpolate across the absence
      if (rm.n > 0 && tick - rm.lastTick > 16) rm.n = 0;
      const gap = rm.n > 0 ? tick - rm.lastTick : SNAP_EVERY;
      rm.present = true; rm.lastTick = tick;
      copySnap(rm.ring[rm.n % RING], s); rm.n++;
      // sparse remotes (interest-managed far players, 1 snapshot in 3) are drawn a little further back so they
      // always have two samples to blend; remotes present in every snapshot use the exact shared render tick
      rm.gap = gap;
      const extra = gap - gGap;
      rm.extra = extra <= 0 ? 0 : rm.extra + (extra - rm.extra) * 0.3;
      if (s.st === PS.Ride) rm.seat = s.seat; else rm.veh = -1;
    }
    // tuk-tuks (the ones this snapshot carries: a parked or far one is only refreshed now and then)
    const nv = r.left > 0 ? r.u8() : 0;
    for (let i = 0; i < nv; i++) { const v = this.vtmp; readVehicle(r, v); v.tick = tick; this.onVehicle(v, gGap); }
  }
  private readonly vtmp = makeVehSnap();
  /** forget every tuk-tuk (a new phase parks a new fleet) */
  private resetVehicles() {
    this.vehs.reset(); this.driving = -1; this.gunning = -1; this.vErr.fill(0); this.viewVehs.fill(-1);
    for (const v of this.vehs.list) v.live = false;
    for (const vr of this.vehicles) { vr.live = false; vr.n = 0; vr.st = VS.Gone; vr.seats[0] = vr.seats[1] = vr.seats[2] = -1; vr.mine = false; vr.ox = vr.oy = vr.oz = vr.oyaw = 0; vr.swap = false; }
    for (const rm of this.remotes) rm.veh = -1;
  }
  /** one tuk-tuk entry of a snapshot: into its ring, and into the sim copy my prediction collides with — unless I am at
   * its bars (then the prediction owns the pose and only takes what the server alone knows) */
  private onVehicle(s: VehSnap, gGap: number) {
    const vr = this.vehicles[s.id], sim = this.vehs.list[s.id]; if (!vr || !sim) return;
    const gap = vr.n > 0 ? s.tick - vr.lastTick : SNAP_EVERY;
    if (vr.n > 0 && gap > 16) vr.n = 0;          // a long silence (parked / far): never blend across it
    vr.live = true; vr.lastTick = s.tick; vr.gap = gap; vr.kind = s.kind;
    const extra = gap - gGap; vr.extra = extra <= 0 || vr.n === 0 ? 0 : vr.extra + (extra - vr.extra) * 0.3;
    copyVeh(vr.ring[vr.n % VRING], s); vr.n++; vr.radio = s.radio; sim.tyres = s.tyres;
    for (const [k, id] of [[0, s.s0], [1, s.s1], [2, s.s2]] as const) { const rm = id >= 0 ? this.remotes[id] : null; if (rm) { rm.veh = s.id; rm.seat = k; } }
    if (this.driving === s.id) { sim.hp = s.hp; sim.seats[1] = s.s1; sim.seats[2] = s.s2; sim.flags = (sim.flags & ~(VF.BURN | VF.AWAKE)) | (s.flags & (VF.BURN | VF.AWAKE)); return; }
    mirrorVeh(sim, s, this.gunning !== s.id);
  }
  private onInventory(r: Reader) {
    const len = r.dv.byteLength;
    if (len >= 38) {                                              // dedup by frame seq (serial-number arithmetic)
      const seq = r.dv.getUint16(len - 2, true);
      if (this.lastInvSeq >= 0) { const d = (seq - this.lastInvSeq) & 0xffff; if (d === 0 || d > 0x8000) return; }
      this.lastInvSeq = seq;
    }
    const p = this.pred, before = p.slots.map((s) => `${s.kind}:${s.id}:${s.rarity}:${s.count}:${s.mag}`).join("|") + p.ammo.join(",");
    const magBefore = p.slots.map((s) => s.mag), kindBefore = p.slots.map((s) => s.kind + ":" + s.id);
    const cash0 = p.cash;
    const active = readInventory(r, p, this.econ);
    if (p.cash > cash0 && this.started) this.sink?.cashGain?.(p.cash - cash0);
    const spec = r.left > 0 ? r.u8() : 255;
    // my own pick wins over a frame the server built before it read the pick (≈ 1 RTT)
    if (!(this.specWant >= 0 && spec !== this.specWant && performance.now() - this.specWantAt < Math.max(1200, this.ping * 3 + 600))) { this.spectate = spec === 255 ? -1 : spec; this.specWant = -1; }
    // keep predicted magazine counts unless the server disagrees a lot (shots in flight)
    p.slots.forEach((s, i) => { if (kindBefore[i] === s.kind + ":" + s.id && Math.abs(magBefore[i] - s.mag) <= 2) s.mag = magBefore[i]; });
    // the server moved our hands (auto-equip on pickup, a redeploy, a new match): follow it, and make the input's wanted
    // slot follow too — or the next input would switch straight back to a stale (maybe empty) slot
    // Following ANY differing active slot once our own
    // switch was 500 ms old fails: an inventory frame the server built before it read the switch (RTT ≥ ~160 ms, or a tab
    // stall right after the key press) snapped the hands AND the wanted slot back: the swap silently failed. Only a slot
    // we have not asked for lately is the server's own move (auto-equip on pickup, a redeploy).
    const echo = active >= 0 && active < this.slotSentAt.length && performance.now() - this.slotSentAt[active] < Math.max(1000, this.ping * 3 + 600);
    if (active !== p.active && !echo && performance.now() - this.lastSlotChangeAt > 500) { p.active = active; this.sink?.serverSlot?.(active); }
    const after = p.slots.map((s) => `${s.kind}:${s.id}:${s.rarity}:${s.count}:${s.mag}`).join("|") + p.ammo.join(",");
    if (before !== after) this.sink?.inventory();
  }
  private onEvents(r: Reader) {
    const n = r.u8(), tick = r.u32(); const s = this.sink;
    if (tick <= this.lastEvTick) { this.netStats.dupFrames++; return; }
    this.lastEvTick = tick;
    for (let i = 0; i < n; i++) {
      const k = r.u8();
      switch (k) {
        case EV.Hit: { const a = r.u8(), b = r.u8(), z = r.u8(), d = r.u16() / 4, x = r.f32(), y = r.f32(), zz = r.f32(); s?.hit(a, b, z & 0x3f, d, x, y, zz, (z & 0x80) !== 0, (z & 0x40) !== 0); break; }
        case EV.Shot: { const a = r.u8(), w = r.u8(), ox = r.f32(), oy = r.f32(), oz = r.f32(), ex = r.f32(), ey = r.f32(), ez = r.f32(), sf = r.u8(); if (a !== this.me) s?.shot(a, w, ox, oy, oz, ex, ey, ez, sf & 0x7f, (sf & 0x80) !== 0); else s?.ownShot?.(w, ex, ey, ez, sf & 0x7f, (sf & 0x80) !== 0); break; }
        case EV.Kill: { const a = r.u8(), b = r.u8(), w = r.u8(), f = r.u8(); s?.kill(a === 255 ? -1 : a, b, w, f !== 0); break; }
        case EV.Chest: { const id = r.u16(), by = r.u8(); const c = this.chests[id]; if (c) c.opened = true; s?.chest(id, by); break; }
        case EV.ChestReset: { const id = r.u16(); const c = this.chests[id]; if (c) c.opened = false; s?.chestReset?.(id); break; }
        case EV.SpawnItem: { const id = r.u16(), kind = r.u8(), sub = r.u8(), rar = r.u8(), cnt = r.u8(), x = r.f32(), y = r.f32(), z = r.f32(); const it: Item = { id, kind, sub, rarity: rar, count: cnt, x, y, z, taken: false, bornAt: this.time }; this.items.set(id, it); s?.spawnItem(it); break; }
        case EV.TakeItem: { const id = r.u16(), by = r.u8(); const it = this.items.get(id); if (it) { it.taken = true; this.items.delete(id); } s?.takeItem(id, by); break; }
        case EV.Explosion: { const x = r.f32(), y = r.f32(), z = r.f32(), rr = r.u8() / 10; s?.explosion(x, y, z, rr); break; }
        case EV.Rocket: { const id = r.u16(), o = r.u8(), x = r.f32(), y = r.f32(), z = r.f32(), vx = r.f32(), vy = r.f32(), vz = r.f32(); s?.rocket(id, o, x, y, z, vx, vy, vz); break; }
        case EV.RocketEnd: { s?.rocketEnd(r.u16()); break; }
        // respawn / plane exit move us: the next snapshot's state reconciles the prediction (no guessing here)
        case EV.Respawn: { const id = r.u8(), x = r.f32(), y = r.f32(), z = r.f32(); s?.respawn(id, x, y, z); break; }
        case EV.Jump: { const id = r.u8(); s?.jump(id); break; }
        case EV.Land: { const id = r.u8(), sf = r.u8(); s?.land(id, sf); break; }
        case EV.Storm: { const ph = r.u8(), sh = r.u8(); s?.storm(ph, sh !== 0); break; }
        case EV.Announce: { const c = r.u8(), a = r.u8(), b = r.u8(); s?.announceCode(c, a, b); break; }
        case EV.Glass: { const id = r.u16(), c = r.u8(), by = r.u8(), sd = (c >> 2) & 3; this.glass.breakPane(id, c & 3, sd === 1 ? 1 : sd === 2 ? -1 : 0, by); break; }
        case EV.Veh: { const id = r.u8(), kind = r.u8(), a = r.u8(), x = r.f32(), y = r.f32(), z = r.f32(); s?.veh?.(id, kind, a, x, y, z); break; }
        case EV.Bomb: { const id = r.u16(), o = r.u8(), x = r.f32(), y = r.f32(), z = r.f32(), vx = r.f32(), vy = r.f32(), vz = r.f32(), f = r.u16() / 1000; s?.bomb?.(id, o, x, y, z, vx, vy, vz, f); break; }
        case EV.BombEnd: { s?.bombEnd?.(r.u16()); break; }
        case EV.Cover: { const id = r.u16(), o = r.u8(), x = r.f32(), y = r.f32(), z = r.f32(), yw = yawDec(r.u16()), hp = r.u16(); this.covers.remove(id); this.covers.add(id, o, x, y, z, yw, hp, this.time); s?.cover?.(id, o, true); break; }
        case EV.CoverEnd: { const id = r.u16(), why = r.u8(); this.covers.remove(id); s?.coverEnd?.(id, why); break; }
        case EV.CoverHit: { const id = r.u16(), hp = r.u16(); const w = this.covers.byId(id); if (w) w.hp = hp; s?.coverHit?.(id, hp); break; }
        case EV.VehHit: { const a = r.u8(), id = r.u8(), d = r.u16() / 4, x = r.f32(), y = r.f32(), z = r.f32(); s?.vehHit?.(a === 255 ? -1 : a, id, d, x, y, z); break; }
        default: return; // unknown: cannot skip → stop
      }
    }
  }

  // ---------------------------------------------------------------- prediction
  private savePred(seq: number, pre: number) {
    const p = this.pred, k = seq % PRING, o = k * PS_STRIDE, R = this.pRing;
    R[o + PF.X] = p.x; R[o + PF.Y] = p.y; R[o + PF.Z] = p.z; R[o + PF.VX] = p.vx; R[o + PF.VY] = p.vy; R[o + PF.VZ] = p.vz;
    R[o + PF.COYOTE] = p.coyote; R[o + PF.JUMPBUF] = p.jumpBuf; R[o + PF.AIRT] = p.airT; R[o + PF.FALLV] = p.fallV; R[o + PF.MVT] = p.mvT; R[o + PF.MVY] = p.mvY;
    R[o + PF.ST] = p.st; R[o + PF.BITS] = moveBits(p); R[o + PF.PREVB] = p.prevButtons; R[o + PF.SHOTSEQ] = p.shotSeq & 0xffff; R[o + PF.PRE] = pre;
    R[o + PF.VEH] = p.veh; R[o + PF.SEAT] = p.seat; R[o + PF.BUFF] = p.buffT; R[o + PF.BREATH] = p.breath; R[o + PF.SWGUN] = p.swGun;
    this.pSeq[k] = seq;
  }
  /** my tuk-tuk after input `seq` (while I drive it) */
  private saveVeh(seq: number, v: Vehicle) {
    const o = (seq % PRING) * VST, R = this.vRing;
    R[o] = v.x; R[o + 1] = v.y; R[o + 2] = v.z; R[o + 3] = v.yaw; R[o + 4] = v.vx; R[o + 5] = v.vy; R[o + 6] = v.vz; R[o + 7] = v.steer; R[o + 8] = v.tip; R[o + 9] = v.tipV;
    R[o + 10] = v.gPitch; R[o + 11] = v.gRoll; R[o + 12] = v.st; R[o + 13] = v.air ? 1 : 0; R[o + 14] = v.surf; R[o + 15] = v.hopT;
  }
  /** did I predict my tuk-tuk exactly where the server has it after `seq`? */
  private vehSame(seq: number, a: VehSelf): boolean {
    const o = (seq % PRING) * VST, R = this.vRing;
    return near(R[o], a.x) && near(R[o + 1], a.y) && near(R[o + 2], a.z) && near(R[o + 3], a.yaw) && near(R[o + 4], a.vx) && near(R[o + 5], a.vy) && near(R[o + 6], a.vz) && near(R[o + 7], a.steer)
      && near(R[o + 8], a.tip) && near(R[o + 9], a.tipV) && near(R[o + 10], a.gPitch) && near(R[o + 11], a.gRoll) && R[o + 12] === a.st && (R[o + 13] !== 0) === a.air && R[o + 14] === a.surf && near(R[o + 15], a.hopT);
  }
  /** the door gun I man after input `seq` */
  private saveGun(seq: number, v: Vehicle) {
    const o = (seq % PRING) * GST, R = this.gRing;
    R[o] = v.gunAimY; R[o + 1] = v.gunAimP; R[o + 2] = v.gunSpin; R[o + 3] = v.gunHeat; R[o + 4] = v.gunCool; R[o + 5] = v.gunIdle; R[o + 6] = v.gunBelt; R[o + 7] = v.gunLock ? 1 : 0; R[o + 8] = v.gunArm ? 1 : 0;
  }
  /** did I predict the door gun exactly as the server has it after `seq`? */
  private gunSame(seq: number, g: GunSelf): boolean {
    const o = (seq % PRING) * GST, R = this.gRing;
    return near(R[o], g.aimY) && near(R[o + 1], g.aimP) && near(R[o + 2], g.spin) && near(R[o + 3], g.heat) && near(R[o + 4], g.cool) && near(R[o + 5], g.idle)
      && R[o + 6] === g.belt && (R[o + 7] !== 0) === g.lock && (R[o + 8] !== 0) === g.arm;
  }
  /** the prediction no longer steps a door gun: its sim copy goes back to what the server last said */
  private stopGunning() {
    const id = this.gunning; if (id < 0) return;
    this.gunning = -1;
    const vr = this.vehicles[id], sim = this.vehs.list[id];
    if (vr.n > 0) mirrorGun(sim, vr.ring[(vr.n - 1) % VRING]);
  }
  /** the prediction no longer drives a tuk-tuk: its sim copy goes back to what the server last said, and its drawn pose
   * hands over from the prediction to the interpolation without a jump */
  private stopDriving() {
    const id = this.driving; if (id < 0) return;
    this.driving = -1; this.vErr.fill(0);
    const vr = this.vehicles[id], sim = this.vehs.list[id];
    vr.swap = true; vr.mine = false; sim.evt = 0; sim.crashV = 0; sim.rolls = 0;
    if (vr.n > 0) mirrorVeh(sim, vr.ring[(vr.n - 1) % VRING]);
  }
  /** a passenger sits on its tuk-tuk as it is DRAWN — the blend this frame's inputs report, which the server rewinds to */
  private seatDrawn(p: Player) {
    const vr = this.vehicles[p.veh], sim = this.vehs.list[p.veh]; if (!vr || !sim || !vr.live) return;
    const o = p.veh * 7, V = this.viewVehs;
    if (V[o + 6] < 0) { seatRiderAt(p, sim.kind, vehPose(sim, POSE)); return; }
    sim.x = V[o]; sim.y = V[o + 1]; sim.z = V[o + 2]; sim.yaw = V[o + 3]; sim.gPitch = V[o + 4]; sim.gRoll = V[o + 5]; if (sim.kind !== 1) sim.tip = 0;
    seatRiderAt(p, sim.kind, V.subarray(o, o + 6));
  }
  /** the server's state after input `lastSeq` (this.auth) vs what we predicted for it: equal → done; else replay */
  private reconcile(lastSeq: number) {
    const a = this.auth, p = this.pred;
    this.glass.bind(); this.vehs.bind(); this.world.cover = this.covers;
    p.hp = a.hp; p.shield = a.shield;
    if (lastSeq > this.ackedSeq) this.ackedSeq = lastSeq;
    const k = lastSeq % PRING, o = k * PS_STRIDE, R = this.pRing;
    const have = lastSeq > 0 && this.pSeq[k] === lastSeq;
    // spread seeds: the server's shot counter after lastSeq vs ours → shift ours (and the unacked ring entries)
    if (have) {
      const d = ((a.shotSeq - R[o + PF.SHOTSEQ]) << 16) >> 16;
      // the server fired more shots than we predicted by lastSeq: voice them (once — the counters agree again below)
      if (d > 0 && d <= 3 && a.st === PS.Ground && p.st === PS.Ground) this.sink?.unpredictedShots?.(d);
      if (d !== 0) { p.shotSeq += d; for (let s = lastSeq + 1; s <= this.inputSeq; s++) { const e = (s % PRING) * PS_STRIDE; R[e + PF.SHOTSEQ] = (R[e + PF.SHOTSEQ] + d) & 0xffff; } }
    }
    // server-driven states (dead, spectating): follow silently
    if (a.st === PS.Dead || a.st === PS.Spectate) {
      if (p.st !== a.st || p.x !== a.x || p.y !== a.y || p.z !== a.z) { loadMove(p, a); this.px = p.x; this.py = p.y; this.pz = p.z; this.errX = this.errY = this.errZ = 0; }
      this.stopDriving(); this.stopGunning();
      return;
    }
    // riding the plane at lastSeq: the plane moves us (nothing to predict) — unless we predicted an exit at or before
    // lastSeq that the server did not make (then restore + replay below)
    if (a.st === PS.Plane && (have ? R[o + PF.ST] === PS.Plane : p.st === PS.Plane)) {
      // (aboard, nothing is in your hands: a reload / heal / swap / aim from the warm-up does not ride along)
      if (p.st === PS.Plane) { p.reloadT = p.useT = p.swapT = 0; p.scoped = p.ads = false; loadMove(p, a); this.px = p.x; this.py = p.y; this.pz = p.z; this.errX = this.errY = this.errZ = 0; }
      return;
    }
    // in a tuk-tuk the kong itself is carried: what must agree is the seat — and, at the bars, the tuk-tuk's own state
    const ride = a.st === PS.Ride;
    const stateChange = !have || R[o + PF.ST] !== a.st || (ride && (R[o + PF.VEH] !== a.veh || R[o + PF.SEAT] !== a.seat));
    if (have && !stateChange && R[o + PF.PREVB] === a.prevButtons) {
      if (ride) { if ((!a.drive || this.vehSame(lastSeq, a.v)) && (!a.gun || this.gunSame(lastSeq, a.g))) { if (a.drive) { const sim = this.vehs.list[a.veh]; sim.hp = a.v.hp; sim.flags = (sim.flags & ~VF.BURN) | (a.v.flags & VF.BURN); } return; } }
      else if (near(R[o + PF.X], a.x) && near(R[o + PF.Y], a.y) && near(R[o + PF.Z], a.z) && near(R[o + PF.VX], a.vx) && near(R[o + PF.VY], a.vy) && near(R[o + PF.VZ], a.vz)
        && near(R[o + PF.COYOTE], a.coyote) && near(R[o + PF.JUMPBUF], a.jumpBuf) && near(R[o + PF.AIRT], a.airT) && near(R[o + PF.FALLV], a.fallV) && near(R[o + PF.MVT], a.mvT) && near(R[o + PF.MVY], a.mvY)
        && near(R[o + PF.BUFF], a.buffT) && near(R[o + PF.BREATH], a.breath) && near(R[o + PF.SWGUN], a.swGun) && R[o + PF.BITS] === moveBitsOf(a)) return;   // prediction was exact
    }
    // diverged: restore the server's state and replay every unacked input (hands flags as they were predicted)
    const s = this.scratch;
    s.id = p.id; s.team = p.team;
    loadMove(s, a); for (const sl of s.slots) sl.kind = 0; s.swapT = 0; s.cool = 1e9;
    // my tuk-tuk: the server's state of it after lastSeq — the unacked inputs then drive it again
    const droveBefore = this.driving;
    if (droveBefore >= 0) VOLD.set(this.vCur);
    if (a.drive && a.veh >= 0) {
      if (droveBefore >= 0 && droveBefore !== a.veh) this.stopDriving();
      const sim = this.vehs.list[a.veh];
      loadVeh(sim, a.v); sim.live = true; sim.seats[0] = p.id; this.driving = a.veh;
    }
    // the door gun I man: the server's state of it after lastSeq — the unacked inputs then step it again
    if (a.gun && a.veh >= 0) {
      if (this.gunning >= 0 && this.gunning !== a.veh) this.stopGunning();
      loadGun(this.vehs.list[a.veh], a.g); this.gunning = a.veh;
    }
    let prevBuff = have ? R[o + PF.BUFF] : a.buffT;
    const first = Math.max(lastSeq + 1, this.inputSeq - PRING + 2);
    for (let seq = first; seq <= this.inputSeq; seq++) {
      const e = (seq % PRING) * PS_STRIDE, inp = this.inRing[seq % PRING], pre = R[e + PF.PRE];
      s.scoped = (pre & 1) !== 0; s.reloadT = (pre & 2) !== 0 ? 1 : 0; s.useT = (pre & 4) !== 0 ? 1 : 0; s.ads = (pre & 8) !== 0; s.useTaken = (pre & 16) !== 0;
      if (s.st === PS.Plane) this.ridePlane(s, inp);
      else { if (s.st === PS.Ride && s.seat !== 0) this.seatDrawn(s); stepPlayer(s, inp, this.world, DT); }
      R[e + PF.X] = s.x; R[e + PF.Y] = s.y; R[e + PF.Z] = s.z; R[e + PF.VX] = s.vx; R[e + PF.VY] = s.vy; R[e + PF.VZ] = s.vz;
      R[e + PF.COYOTE] = s.coyote; R[e + PF.JUMPBUF] = s.jumpBuf; R[e + PF.AIRT] = s.airT; R[e + PF.FALLV] = s.fallV; R[e + PF.MVT] = s.mvT; R[e + PF.MVY] = s.mvY;
      // (the replay has no hands: a red banana the prediction finished eating in this input starts its buff here too)
      const ob = R[e + PF.BUFF];
      if (ob > prevBuff + 1e-6 && ob > s.buffT + 1e-6) s.buffT = ob;
      prevBuff = ob;
      R[e + PF.ST] = s.st; R[e + PF.BITS] = moveBits(s); R[e + PF.PREVB] = s.prevButtons; R[e + PF.VEH] = s.veh; R[e + PF.SEAT] = s.seat; R[e + PF.BUFF] = s.buffT; R[e + PF.BREATH] = s.breath; R[e + PF.SWGUN] = s.swGun;
      if (s.st === PS.Ride && s.seat === 0 && s.veh >= 0) { const sim = this.vehs.list[s.veh]; this.saveVeh(seq, sim); sim.evt = 0; sim.crashV = 0; sim.rolls = 0; }
      { const g = gunOf(this.vehs, s); if (g) this.saveGun(seq, g); }
    }
    const ex = s.x - p.x, ey = s.y - p.y, ez = s.z - p.z, err = Math.hypot(ex, ey, ez);
    p.x = s.x; p.y = s.y; p.z = s.z; p.vx = s.vx; p.vy = s.vy; p.vz = s.vz; p.coyote = s.coyote; p.jumpBuf = s.jumpBuf; p.airT = s.airT; p.fallV = s.fallV; p.mvT = s.mvT; p.mvY = s.mvY;
    p.st = s.st; p.grounded = s.grounded; p.crouch = s.crouch; p.swim = s.swim; p.slope = s.slope; p.sprint = s.sprint; p.prevButtons = s.prevButtons; p.veh = s.veh; p.seat = s.seat; p.buffT = s.buffT;
    p.under = s.under; p.breath = s.breath; p.swGun = s.swGun;
    // my tuk-tuk's drawn pose stays continuous the same way (its own correction offset)
    const drive = p.st === PS.Ride && p.seat === 0 && p.veh >= 0;
    if (drive) {
      this.driving = p.veh;
      vehPose(this.vehs.list[p.veh], this.vCur);
      if (droveBefore === p.veh) {
        const E = this.vErr, dx = VOLD[0] - this.vCur[0], dy = VOLD[1] - this.vCur[1], dz = VOLD[2] - this.vCur[2];
        if (dx * dx + dy * dy + dz * dz < 9) { E[0] += dx; E[1] += dy; E[2] += dz; E[3] += wrapPi(VOLD[3] - this.vCur[3]); for (let k = 0; k < 6; k++) this.vPrev[k] += this.vCur[k] - VOLD[k]; }
        else { E.fill(0); this.vPrev.set(this.vCur); }
      } else { this.vErr.fill(0); this.vPrev.set(this.vCur); this.vehicles[p.veh].swap = true; }
    } else this.stopDriving();
    { const g = gunOf(this.vehs, p); if (g) this.gunning = g.id; else this.stopGunning(); }
    // keep the drawn pose continuous: the correction bleeds out through errX over ~100 ms (snap if it is huge)
    this.px += ex; this.py += ey; this.pz += ez;
    if (err < 2.5 && p.st !== PS.Ride && a.st !== PS.Ride) { this.errX -= ex; this.errY -= ey; this.errZ -= ez; } else { this.errX = this.errY = this.errZ = 0; }
    const st = this.netStats; st.corrections++;
    if (stateChange || err > 30) st.stateCorrections++;     // a teleport (spawn, redeploy) is a state change, not drift
    else { st.moveCorrections++; if (err > 0.01) st.corrOver1cm++; if (err > 0.02) st.corrOver2cm++; if (err > 0.1) st.corrOver10cm++; if (err > st.corrMax) st.corrMax = err; }
    this.onCorrection?.(err, stateChange);
  }

  /** advance the local simulation by real time; sends one input per sim tick */
  update(dt: number, input: GameInput, allowFire: boolean): number {
    if (!this.started) return 0;
    if (this.caster) return this.castUpdate();
    this.glass.bind(); this.vehs.bind(); this.world.cover = this.covers;   // (offline practice: the in-tab Match shares this world and binds its own glass / tuk-tuks every tick)
    { const k2 = Math.exp(-dt * 12), E = this.vErr; E[0] *= k2; E[1] *= k2; E[2] *= k2; E[3] *= k2; }
    if (performance.now() - this.lastPingAt > (this.pingsSent < 8 ? 250 : 1000)) { this.lastPingAt = performance.now(); this.sendPing(); }
    // decay the correction offset (100 ms)
    const k = Math.exp(-dt * 25); this.errX *= k; this.errY *= k; this.errZ *= k;
    if (!this.viewValid) this.interpolate();
    this.acc += dt;
    let ticks = 0;
    while (this.acc >= DT && ticks < 6) {
      this.acc -= DT; ticks++;
      const p = this.pred;
      this.px = p.x; this.py = p.y; this.pz = p.z;
      const inp = this.cur;
      input.rideSeat = p.st === PS.Ride ? p.seat : -1;
      input.poll(inp, allowFire);
      inp.seq = ++this.inputSeq; inp.yaw = input.yaw; inp.pitch = input.pitch;
      // lag compensation: the blend of the frame the player was LOOKING at when this input was sampled; while riding the
      // plane: the server tick we are showing (the plane exit happens at that tick's plane position, shared/sim/plane.ts)
      if (p.st === PS.Plane) { inp.lerpA = Math.max(0, Math.floor(this.serverTick())); inp.lerpSpan = 0; inp.lerpF = 0; }
      else { inp.lerpA = this.viewA; inp.lerpSpan = this.viewSpan; inp.lerpF = this.viewF; }
      quantizeInput(inp);                                          // predict with exactly what the server will decode
      if (inp.slot !== p.active) this.lastSlotChangeAt = performance.now();
      if (inp.slot < this.slotSentAt.length) this.slotSentAt[inp.slot] = performance.now();
      // E: a chest / gun / window / aimed tuk-tuk in reach wins over a zipline pole (Match.useClaimed — the prompt's order)
      if (p.st === PS.Ground && (inp.buttons & B.USE) !== 0 && (p.prevButtons & B.USE) === 0) { p.yaw = inp.yaw; p.pitch = inp.pitch; p.useTaken = this.useClaimed(p); }
      const pre = (p.scoped ? 1 : 0) | (p.reloadT > 0 ? 2 : 0) | (p.useT > 0 ? 4 : 0) | (p.ads ? 8 : 0) | (p.useTaken ? 16 : 0);   // 8: ADS walk (combat)
      if (p.st === PS.Plane) { if (this.ridePlane(p, inp)) { this.px = p.x; this.py = p.y; this.pz = p.z; this.errX = this.errY = this.errZ = 0; } }
      else {
        // in a tuk-tuk: at the bars my prediction drives it (its pose before this tick is kept for the render blend);
        // on the bench I sit on it as it is drawn
        if (p.st === PS.Ride) {
          if (p.seat === 0 && p.veh >= 0) { if (this.driving !== p.veh) { this.stopDriving(); this.driving = p.veh; vehPose(this.vehs.list[p.veh], this.vCur); this.vehicles[p.veh].swap = true; } this.vPrev.set(this.vCur); }
          else { this.stopDriving(); this.seatDrawn(p); }
        }
        { const g = gunOf(this.vehs, p); if (g) { if (this.gunning !== g.id) { this.stopGunning(); this.gunning = g.id; } } else this.stopGunning(); }
        stepPlayer(p, inp, this.world, DT);
        if (this.gunning >= 0) { const g = gunOf(this.vehs, p); if (g && g.id === this.gunning) this.saveGun(inp.seq, g); else this.stopGunning(); }
        if (this.driving >= 0) {
          const sim = this.vehs.list[this.driving];
          if (sim.evt) { this.sink?.tukFeel?.(sim.id, sim.evt, sim.crashV); sim.evt = 0; sim.crashV = 0; sim.rolls = 0; }
          if (p.st === PS.Ride && p.seat === 0 && p.veh === this.driving) { vehPose(sim, this.vCur); this.saveVeh(inp.seq, sim); }
          else { vehPose(sim, this.vCur); this.stopDriving(); }
        }
      }
      this.savePred(inp.seq, pre);
      copyInput(this.inRing[inp.seq % PRING], inp);
      if (p.fired > 0) this.sink?.localFire();
      if (p.thrown > 0) this.sink?.localThrow?.(p.thrown);
      this.onTick?.(inp);
      writeInput(this.inputW.reset(), inp); this.link.sendBinary(this.inputW.view());
    }
    if (this.acc > DT * 6) this.acc = 0;
    this.stepStorm();
    this.lastFrameAt = performance.now();
    return ticks;
  }
  /** (caster) a seat's frame: the clock (pings), the storm — nothing to predict, nothing to send */
  private castUpdate(): number {
    this.glass.bind(); this.vehs.bind(); this.world.cover = this.covers;
    if (performance.now() - this.lastPingAt > (this.pingsSent < 8 ? 250 : 1000)) { this.lastPingAt = performance.now(); this.sendPing(); }
    if (!this.viewValid) this.interpolate();
    this.stepStorm();
    this.lastFrameAt = performance.now();
    return 0;
  }
  /** one input while riding the plane — the server's rule exactly (shared/sim/plane.ts); true = we just jumped */
  private ridePlane(p: Player, inp: Input): boolean {
    if (this.planeStart < 0) { p.yaw = inp.yaw; p.pitch = inp.pitch; p.prevButtons = inp.buttons; return false; }
    return planeStep(p, inp, this.plane, this.planeStart, inp.lerpA);
  }
  private stepStorm() { if (this.plan) stormAt(this.plan, this.time + (this.phase === 1 || this.phase === 2 ? this.acc : 0), this.storm); }

  /** interpolated render pose of the local player */
  localPose(out: { x: number; y: number; z: number }) {
    const f = Math.min(1, this.acc / DT); const p = this.pred;
    if (p.st === PS.Ride && p.veh >= 0 && this.vehicles[p.veh].live) { const vr = this.vehicles[p.veh]; POSE[0] = vr.x; POSE[1] = vr.y; POSE[2] = vr.z; POSE[3] = vr.yaw; POSE[4] = vr.pitch; POSE[5] = vr.roll; seatPoint(POSE, vr.kind, p.seat, S3); out.x = S3[0]; out.y = S3[1]; out.z = S3[2]; return; }
    out.x = this.px + (p.x - this.px) * f + this.errX; out.y = this.py + (p.y - this.py) * f + this.errY; out.z = this.pz + (p.z - this.pz) * f + this.errZ;
  }
  /** once per drawn frame: advance the render clock, blend every remote, remember the blend + hitboxes for lag comp */
  interpolate() {
    // (caster replay, client/src/caster/replay.ts) a replay draws a recorded past: it swaps recorded rings into the
    // remotes / vehicles for the frame and sets the tick to draw here; −1 (always, outside a caster replay) = live
    const rt = this.replayTick >= 0 ? this.replayTick : this.advanceRenderClock();
    this.viewValid = true;
    // the shared blend (snapshot ticks A..B) — what every remote present in each snapshot is drawn with
    const n = Math.min(this.snapN, TICKS_RING);
    let A = -1, Bt = -1;
    for (let i = 1; i <= n; i++) { const t = this.snapTicks[(this.snapN - i) % TICKS_RING]; if (t <= rt) { A = t; break; } Bt = t; }
    if (A < 0) { A = Bt; Bt = -1; }
    if (A < 0) { this.viewA = 0; this.viewSpan = 0; this.viewF = 0; }
    else if (Bt < 0) { this.viewA = A; this.viewSpan = 0; this.viewF = 0; this.netStats.holdFrames++; }
    else { this.viewA = A; this.viewSpan = Bt - A; this.viewF = qf16((rt - A) / (Bt - A)); }
    const T = this.viewTargets, bl = this.blend, stale = rt - 90;
    for (const rm of this.remotes) {
      const o = rm.id * TARGET_STRIDE;
      if (rm.n === 0 || rm.id === this.me) { T[o + 3] = 0; continue; }
      const rtr = rt - rm.extra;
      // newest sample a with tick <= rtr, and its successor b
      let a: PlayerSnap | null = null, b: PlayerSnap | null = null;
      const cnt = Math.min(rm.n, RING);
      for (let i = 1; i <= cnt; i++) {
        const s = rm.ring[(rm.n - i) % RING];
        if (s.tick <= rtr) { a = s; break; } b = s;
      }
      if (!a) { a = b!; b = null; }
      const bb = b ?? a;
      const f = b ? qf16((rtr - a.tick) / (b.tick - a.tick)) : 0;
      blendPose(a.x, a.y, a.z, poseFlags(a.st, a.crouch || a.swim), bb.x, bb.y, bb.z, poseFlags(bb.st, bb.crouch || bb.swim), f, bl, 0);
      if (b) { const dts = (b.tick - a.tick) * DT; rm.vx = (b.x - a.x) / dts; rm.vy = (b.y - a.y) / dts; rm.vz = (b.z - a.z) / dts; }
      rm.x = bl[0]; rm.y = bl[1]; rm.z = bl[2];
      let dy = bb.yaw - a.yaw; if (dy > Math.PI) dy -= Math.PI * 2; else if (dy < -Math.PI) dy += Math.PI * 2;
      rm.yaw = a.yaw + dy * f; rm.pitch = a.pitch + (bb.pitch - a.pitch) * f;
      copySnapMeta(rm, f < 0.5 ? a : bb);
      // squadmates are never targets (no friendly fire — the server zeroes them identically)
      T[o] = bl[0]; T[o + 1] = bl[1]; T[o + 2] = bl[2]; T[o + 3] = rm.lastTick < stale || rm.team === this.pred.team || this.predictedDead(rm) ? 0 : bl[3];
      T[o + 4] = blendYaw(a.yaw, bb.yaw, f);   // hitbox facing (combat), bit-equal to the server's rewind
    }
    this.drawVehicles(rt);
  }
  private lastDrawAt = 0;
  /** every tuk-tuk's drawn pose for this frame: the snapshot blend (the same ticks + fraction the kongs use, so a shot at
   * one is rewound to what was on screen) — or my own prediction for the one I drive */
  private drawVehicles(rt: number) {
    const VV = this.viewVehs, now = performance.now(), dt = Math.min(0.1, Math.max(0, (now - this.lastDrawAt) / 1000)); this.lastDrawAt = now;
    const kOff = Math.exp(-dt * 7);
    for (const vr of this.vehicles) {
      const o = vr.id * 7;
      if (!vr.live || vr.n === 0) { VV[o + 6] = -1; continue; }
      const px = vr.x + vr.ox, py = vr.y + vr.oy, pz = vr.z + vr.oz, pyaw = vr.yaw + vr.oyaw, had = vr.st !== VS.Gone;
      if (this.driving === vr.id) {
        // mine: between the last two predicted ticks, plus what is left of the last correction
        const f = Math.min(1, this.acc / DT), E = this.vErr;
        blendVeh(this.vPrev, 0, this.vCur, 0, f, POSE);
        const sim = this.vehs.list[vr.id];
        vr.x = POSE[0] + E[0]; vr.y = POSE[1] + E[1]; vr.z = POSE[2] + E[2]; vr.yaw = POSE[3] + E[3]; vr.pitch = POSE[4]; vr.roll = POSE[5];
        vr.vf = -sim.vx * Math.sin(sim.yaw) - sim.vz * Math.cos(sim.yaw); vr.steer = sim.steer; vr.hp = sim.hp; vr.flags = sim.flags | VF.AWAKE; vr.st = sim.st; vr.tyres = sim.tyres;
        vr.seats[0] = this.me; vr.seats[1] = sim.seats[1]; vr.seats[2] = sim.seats[2]; vr.mine = true;
      } else {
        const rtr = rt - vr.extra, cnt = Math.min(vr.n, VRING);
        let a: VehSnap | null = null, b: VehSnap | null = null;
        for (let i = 1; i <= cnt; i++) { const s = vr.ring[(vr.n - i) % VRING]; if (s.tick <= rtr) { a = s; break; } b = s; }
        if (!a) { a = b!; b = null; }
        const bb = b ?? a, f = b ? qf16((rtr - a.tick) / (b.tick - a.tick)) : 0;
        VA[0] = a.x; VA[1] = a.y; VA[2] = a.z; VA[3] = a.yaw; VA[4] = a.pitch; VA[5] = a.roll;
        VB[0] = bb.x; VB[1] = bb.y; VB[2] = bb.z; VB[3] = bb.yaw; VB[4] = bb.pitch; VB[5] = bb.roll;
        blendVeh(VA, 0, VB, 0, f, POSE);
        vr.x = POSE[0]; vr.y = POSE[1]; vr.z = POSE[2]; vr.yaw = POSE[3]; vr.pitch = POSE[4]; vr.roll = POSE[5];
        const m = f < 0.5 ? a : bb;
        vr.vf = a.vf + (bb.vf - a.vf) * f; vr.steer = a.steer + (bb.steer - a.steer) * f; vr.hp = m.hp; vr.flags = m.flags; vr.st = m.st; vr.tyres = m.tyres;
        vr.seats[0] = m.s0; vr.seats[1] = m.s1; vr.seats[2] = m.s2; vr.mine = false;
      }
      // a helicopter's door gun: my own prediction while I man it, else the snapshots' blend (the same render tick)
      if (vr.kind === VKind.Heli) {
        if (this.gunning === vr.id) { const g = this.vehs.list[vr.id]; vr.gunY = g.gunAimY; vr.gunP = g.gunAimP; vr.gunSpin = g.gunSpin; vr.gunHeat = g.gunHeat; vr.gunBelt = g.gunBelt; vr.gunLock = g.gunLock; }
        else {
          const rtr = rt - vr.extra, cnt = Math.min(vr.n, VRING);
          let a: VehSnap | null = null, b: VehSnap | null = null;
          for (let i = 1; i <= cnt; i++) { const s = vr.ring[(vr.n - i) % VRING]; if (s.tick <= rtr) { a = s; break; } b = s; }
          if (!a) { a = b!; b = null; }
          const bb = b ?? a, f = b ? (rtr - a.tick) / (b.tick - a.tick) : 0, m = f < 0.5 ? a : bb;
          vr.gunY = wrapPi(a.gunY + wrapPi(bb.gunY - a.gunY) * f); vr.gunP = a.gunP + (bb.gunP - a.gunP) * f;
          vr.gunSpin = a.gunSpin + (bb.gunSpin - a.gunSpin) * f; vr.gunHeat = a.gunHeat + (bb.gunHeat - a.gunHeat) * f; vr.gunBelt = m.gunBelt; vr.gunLock = m.gunLock;
        }
      }
      // what my bullets meet (and where a passenger sits) is the blend itself — the hand-over offset below is only drawn
      VV[o] = vr.x; VV[o + 1] = vr.y; VV[o + 2] = vr.z; VV[o + 3] = vr.yaw; VV[o + 4] = vr.pitch; VV[o + 5] = vr.roll; VV[o + 6] = vr.st === VS.Gone || vr.st === VS.Sunk ? -1 : vr.st;
      // the drawn source just changed (I took / left the bars): start from where it was drawn, ease onto the new source
      if (vr.swap) { vr.swap = false; if (had) { const dx = px - vr.x, dy = py - vr.y, dz = pz - vr.z; if (dx * dx + dy * dy + dz * dz < 64) { vr.ox = dx; vr.oy = dy; vr.oz = dz; vr.oyaw = wrapPi(pyaw - vr.yaw); } } }
      else { vr.ox *= kOff; vr.oy *= kOff; vr.oz *= kOff; vr.oyaw *= kOff; }
    }
  }
  /** the nearest drawn tuk-tuk panel on a ray (unit dir) within maxT; −1 = none (the distance in `vehT`). `skip`: mine. */
  vehT = 0;
  rayVehicles(skip: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): number {
    let best = -1; this.vehT = maxT;
    const VV = this.viewVehs;
    for (let i = 0; i < TUK.MAX; i++) {
      const o = i * 7; if (i === skip || VV[o + 6] < 0) continue;
      const t = rayVehicle(VV.subarray(o, o + 6), this.vehicles[i].kind, ox, oy, oz, dx, dy, dz, this.vehT);
      if (t >= 0 && t < this.vehT) { this.vehT = t; best = i; }
    }
    return best;
  }
  // ---- kill races: our own bullets in flight (inputs the server has not acknowledged yet) vs the newest known health
  private readonly flSeq = new Int32Array(FLIGHT_N); private readonly flVic = new Int16Array(FLIGHT_N); private readonly flDmg = new Float64Array(FLIGHT_N);
  private flHead = 0; private flLen = 0; private authSeq = 0;
  /** health the server will see for `id` once every one of our unacknowledged predicted hits has landed (Infinity = unknown) */
  predictedHealth(id: number): number {
    const rm = this.remotes[id]; if (!rm || rm.hpTick < 0 || rm.hpTick !== this.lastSnapTick) return rm && rm.deadNow ? 0 : Infinity;
    let left = rm.hpNow;
    while (this.flLen > 0 && this.flSeq[this.flHead] <= this.authSeq) { this.flHead = (this.flHead + 1) % FLIGHT_N; this.flLen--; }
    for (let i = 0; i < this.flLen; i++) { const k = (this.flHead + i) % FLIGHT_N; if (this.flVic[k] === id) left -= this.flDmg[k]; }
    return left;
  }
  private predictedDead(rm: Remote) { return rm.deadNow || this.predictedHealth(rm.id) <= 1e-6; }
  /** a pellet of the shot fired this tick is predicted to hit `id` for `dmg`: remember it until the server has seen the
   * input; if it kills, the rest of the blast (and every later shot) passes through, exactly like the server. Returns the
   * predicted health left. */
  notePredictedHit(id: number, dmg: number): number {
    if (this.flLen >= FLIGHT_N) { this.flHead = (this.flHead + 1) % FLIGHT_N; this.flLen--; }
    const k = (this.flHead + this.flLen) % FLIGHT_N; this.flSeq[k] = this.inputSeq; this.flVic[k] = id; this.flDmg[k] = dmg; this.flLen++;
    const left = this.predictedHealth(id);
    if (left <= 1e-6) this.viewTargets[id * TARGET_STRIDE + 3] = 0;
    return left;
  }
  /**
   * Client-side verdict for pellet `k` of the shot the local player fired THIS tick (call from onTick when pred.fired > 0),
   * against the hitboxes drawn in the last frame. Same function + same numbers as the server's lag-compensated check.
   */
  predictShot(k: number, out: ShotResult, dir: Float64Array = DIR): ShotResult {
    const p = this.pred, w = weaponDef(p);
    this.predDmg = 0; this.predLeft = Infinity;
    this.predVeh = -1;
    // a round of TOP BANANA (I man a helicopter's door gun): along its barrels at the pose I sat at for this input (my
    // seat was put on the helicopter as drawn — the server rewinds to the same blend)
    const gun = gunOf(this.vehs, p);
    if (gun) {
      gunBarrel(gun, vehPose(gun, POSE), BAR);
      shotDir(p.id, p.shotSeq - 1, k, GUN_SHOT[0], BAR[2], BAR[3], dir);
      const ey = eyeY(p);
      traceShot(this.world, p.x, ey, p.z, dir[0], dir[1], dir[2], this.viewTargets, this.remotes.length, out);
      this.predVeh = this.rayVehicles(gun.id, p.x, ey, p.z, dir[0], dir[1], dir[2], out.t);
      if (this.predVeh >= 0) { out.t = this.vehT; out.victim = -1; out.zone = 0; out.worldHit = true; out.surf = 1; }
      glassShot(this.glass, p.x, ey, p.z, dir[0], dir[1], dir[2], out.t, GC.Shot, this.me);
      if (out.victim >= 0) { this.predDmg = pelletDamage(TOP_BANANA, 0, out.t, out.zone); this.predLeft = this.notePredictedHit(out.victim, this.predDmg); }
      return out;
    }
    if (!w || w.projectile) { out.victim = -1; out.t = 0; out.zone = 0; out.worldHit = false; out.surf = 0; return out; }
    shotDir(p.id, p.shotSeq - 1, k, currentSpread(p, w), p.yaw, p.pitch, dir);
    traceShot(this.world, p.x, eyeY(p), p.z, dir[0], dir[1], dir[2], this.viewTargets, this.remotes.length, out);
    // a tuk-tuk's panels stop it first (never the one I sit in) — the server rules on the same drawn poses
    this.predVeh = this.rayVehicles(p.st === PS.Ride ? p.veh : -1, p.x, eyeY(p), p.z, dir[0], dir[1], dir[2], out.t);
    if (this.predVeh >= 0) { out.t = this.vehT; out.victim = -1; out.zone = 0; out.worldHit = true; out.surf = 1; }
    glassShot(this.glass, p.x, eyeY(p), p.z, dir[0], dir[1], dir[2], out.t, GC.Shot, this.me);   // our panes shatter now; EV.Glass confirms
    // kill races: book the damage of this predicted hit; once our in-flight bullets take the target to 0, the rest of the
    // blast and every later pellet passes through it — exactly what the server will rule
    if (out.victim >= 0) { this.predDmg = pelletDamage(w, p.slots[p.active].rarity, out.t, out.zone); this.predLeft = this.notePredictedHit(out.victim, this.predDmg); }
    return out;
  }
  /** damage + the target's predicted health left after the last predictShot (0 dmg = no player hit) */
  predDmg = 0; predLeft = Infinity;
  /** seconds left in the current phase's countdown (warm-up → plane) */
  warmupLeft() { return this.phase === 0 ? Math.max(0, WARMUP_S - (this.serverTick() - this.phaseTick) * DT) : 0; }
  /** the player being watched (self, or spectate target when dead) */
  viewTarget(): Remote | null { if (this.pred.st !== PS.Dead || this.spectate < 0) return null; const r = this.remotes[this.spectate]; return r && r.n > 0 ? r : null; }
  weapon() { return weaponDef(this.pred); }
  ammoIndexOfActive() { const w = weaponDef(this.pred); return w ? ["light", "heavy", "shells", "rockets"].indexOf(w.ammo) : -1; }
  planeT() { return this.phase === 1 ? Math.max(0, (this.serverTick() - this.phaseTick + 1) * DT) : 0; }
  planePos(out: { x: number; z: number }) { const t = this.planeT(); out.x = this.plane.x0 + this.plane.dx * PLANE_SPEED * t; out.z = this.plane.z0 + this.plane.dz * PLANE_SPEED * t; }
  /** `reach`: exactly the server's interact() pick (same floor, clear line, crosshair-weighted) — the E prompt;
   * `chestsOnly`: skip ammo boxes (the chest hum) */
  nearestChest(maxD: number, reach = false, chestsOnly = false): Chest | null {
    let best: Chest | null = null, bd = reach ? Infinity : maxD; const p = this.pred;
    const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
    for (const c of this.chests) {
      if (c.opened || (chestsOnly && c.box)) continue;
      if (!reach) { const d = Math.hypot(c.x - p.x, c.z - p.z, (c.y - p.y) * 0.5); if (d < bd) { bd = d; best = c; } continue; }
      const dx = c.x - p.x, dz = c.z - p.z, d = Math.hypot(dx, dz);
      if (d > maxD) continue;
      const score = d * (1.35 - 0.5 * (d > 1e-3 ? (dx * fx + dz * fz) / d : 1));
      if (score < bd && lootReachable(this.world, p.x, p.y, p.z, c.x, c.y, c.z)) { bd = score; best = c; }
    }
    return best;
  }
  /** an E press now goes to something ranked above a zipline — the server's Match.useClaimed on what this client knows
   * (the tuk-tuk under the crosshair, a window in reach, a chest, a gun on the floor); `p` faces the input's view */
  useClaimed(p: Player): boolean {
    const cp = Math.cos(p.pitch), dx = -Math.sin(p.yaw) * cp, dy = Math.sin(p.pitch), dz = -Math.cos(p.yaw) * cp;
    return (!p.swim && vehicleInReach(this.vehs, p.x, p.y, p.z, eyeY(p), dx, dy, dz, true, !p.grounded) >= 0) || glassAim(this.glass, p.x, eyeY(p), p.z, dx, dy, dz) >= 0
      || this.nearestChest(CHEST_OPEN_DIST + 0.6, true) !== null || manualLootCandidate(this.items.values(), p, this.world, this.range, this.stands) !== null;
  }
  nearestItem(maxD: number, kind: IK, reach = false): Item | null { let best: Item | null = null, bd = maxD; const p = this.pred; for (const it of this.items.values()) { if (it.kind !== kind) continue; const d = Math.hypot(it.x - p.x, it.z - p.z, (it.y - p.y) * 0.6); if (d < bd && (!reach || this.range || lootReachable(this.world, p.x, p.y, p.z, it.x, it.y, it.z))) { bd = d; best = it; } } return best; }
  weaponName(i: number) { const my = killMythic(i); if (my) return my.name; return i < 6 ? WEAPON_DEFS[WEAPONS[i]].name : i === 255 ? "STORM" : i === 254 ? "FALL" : i === KILL_TUK ? "TUK-TUK" : i === KILL_HELI ? "HELICOPTER" : i === KILL_GUN ? TOP_BANANA.name : i === KILL_BOMB ? "BANANA BOMB" : "?"; }
  /** this match's seed, and where its taxis wait once the plane leaves (the server parks them from the same seed) */
  seed = 0; private ranks: TukSpot[] | null = null;
  taxiRanks(): TukSpot[] { return (this.ranks ??= fleetSpots(this.world, this.seed)); }
  /** the tuk-tuk I am in (drawn state), or null */
  myVehicle(): VehRemote | null { const p = this.pred; return p.st === PS.Ride && p.veh >= 0 && this.vehicles[p.veh].live ? this.vehicles[p.veh] : null; }
  /** the feet of a kong seated in `vr`'s seat k as drawn (world) */
  seatFeet(vr: VehRemote, k: number, out: { x: number; y: number; z: number }) { POSE[0] = vr.x + vr.ox; POSE[1] = vr.y + vr.oy; POSE[2] = vr.z + vr.oz; POSE[3] = vr.yaw + vr.oyaw; POSE[4] = vr.pitch; POSE[5] = vr.roll; seatPoint(POSE, vr.kind, k, S3); out.x = S3[0]; out.y = S3[1]; out.z = S3[2]; }
  /** the eye of a kong seated in `vr`'s seat k (world) */
  seatEye(vr: VehRemote, k: number, out: { x: number; y: number; z: number }) { POSE[0] = vr.x + vr.ox; POSE[1] = vr.y + vr.oy; POSE[2] = vr.z + vr.oz; POSE[3] = vr.yaw + vr.oyaw; POSE[4] = vr.pitch; POSE[5] = vr.roll; seatPoint(POSE, vr.kind, k, S3); out.x = S3[0]; out.y = S3[1] + SEAT_EYE; out.z = S3[2]; }
  /** this match's helipads (the decals; the warm-up map): Peel Strip's and the one or two the seed picked (the server
   * parks them from the same seed), the warm-up islet's — or the firing range's alone */
  heliSpots(range = false): TukSpot[] {
    const key = range ? -1 : this.seed;
    if (this.pads === null || this.padsKey !== key) { this.padsKey = key; this.pads = range ? heliRange(this.world) : [...heliPads(this.world, this.seed), ...heliIslet(this.world)]; }
    return this.pads;
  }
  private pads: TukSpot[] | null = null; private padsKey = 0;
  /** inputs sent but not yet acknowledged by a snapshot */
  get unacked() { return this.inputSeq - this.ackedSeq; }
  get buttons() { return B; }
}
const DIR = new Float64Array(3);
const FLIGHT_N = 128;
const near = (a: number, b: number) => Math.abs(a - b) <= EPS;
// movement state that carries into the next tick (sprint is recomputed every tick, so it is not compared)
const moveBits = (p: Player) => (p.grounded ? 1 : 0) | (p.crouch ? 2 : 0) | (p.swim ? 4 : 0) | (p.slope ? 8 : 0) | (p.under ? 16 : 0);
const moveBitsOf = (a: SelfState) => (a.grounded ? 1 : 0) | (a.crouch ? 2 : 0) | (a.swim ? 4 : 0) | (a.slope ? 8 : 0) | (a.under ? 16 : 0);
function loadMove(p: Player, a: SelfState) {
  p.x = a.x; p.y = a.y; p.z = a.z; p.vx = a.vx; p.vy = a.vy; p.vz = a.vz; p.coyote = a.coyote; p.jumpBuf = a.jumpBuf; p.airT = a.airT; p.fallV = a.fallV; p.mvT = a.mvT; p.mvY = a.mvY;
  p.st = a.st; p.crouch = a.crouch; p.grounded = a.grounded; p.swim = a.swim; p.slope = a.slope; p.sprint = a.sprint; p.prevButtons = a.prevButtons; p.buffT = a.buffT;
  p.under = a.under; p.breath = a.breath; p.swGun = a.swGun;
  p.veh = a.st === PS.Ride ? a.veh : -1; p.seat = a.st === PS.Ride ? a.seat : 0;
}
const POSE = new Float64Array(6), VA = new Float64Array(6), VB = new Float64Array(6), VOLD = new Float64Array(6), S3 = new Float64Array(3), BAR = new Float64Array(4);
const wrapPi = (a: number) => { a %= Math.PI * 2; return a > Math.PI ? a - Math.PI * 2 : a <= -Math.PI ? a + Math.PI * 2 : a; };
/** the server's exact state of the tuk-tuk I drive → its sim copy */
function loadVeh(v: Vehicle, a: VehSelf) {
  v.kind = a.kind; v.x = a.x; v.y = a.y; v.z = a.z; v.yaw = a.yaw; v.vx = a.vx; v.vy = a.vy; v.vz = a.vz; v.steer = a.steer; v.tip = a.tip; v.tipV = a.tipV; v.gPitch = a.gPitch; v.gRoll = a.gRoll;
  v.st = a.st; v.air = a.air; v.surf = a.surf === 255 ? 255 : a.surf; v.hp = a.hp; v.hopT = a.hopT; v.tyres = a.tyres; v.flags = (v.flags & (VF.HORN | VF.SKID | VF.BRAKE | VF.REV | VF.AIR)) | (a.flags & ~(VF.HORN | VF.SKID | VF.BRAKE | VF.REV | VF.AIR));
  v.rightT = 0; v.rightFrom = 0; v.evt = 0; v.crashV = 0; v.rolls = 0;
}
/** a snapshot entry → the sim copy a kong on foot collides with: the drawn pose AS the pose (its lean is in the roll);
 * `gun`: and the door gun (not while my prediction mans it) */
function mirrorVeh(v: Vehicle, s: VehSnap, gun = true) {
  v.live = true; v.kind = s.kind; v.x = s.x; v.y = s.y; v.z = s.z; v.yaw = s.yaw; v.gPitch = s.pitch; v.gRoll = s.roll; v.tip = 0; v.tipV = 0; v.steer = s.steer;
  v.vx = -Math.sin(s.yaw) * s.vf; v.vz = -Math.cos(s.yaw) * s.vf; v.vy = 0; v.st = s.st; v.air = (s.flags & VF.AIR) !== 0; v.hp = s.hp; v.flags = s.flags;
  v.seats[0] = s.s0; v.seats[1] = s.s1; v.seats[2] = s.s2; v.evt = 0; v.rightT = 0;
  if (gun) mirrorGun(v, s);
}
/** a snapshot entry's door gun → the sim copy (quantised: a gunner's first reconcile replaces it with the exact state) */
function mirrorGun(v: Vehicle, s: VehSnap) {
  if (s.kind !== VKind.Heli) return;
  v.gunAimY = s.gunY; v.gunAimP = s.gunP; v.gunSpin = s.gunSpin; v.gunHeat = s.gunHeat; v.gunBelt = s.gunBelt; v.gunLock = s.gunLock;
  v.gunArm = s.gunSpin > 0.999; v.gunCool = 0; v.gunIdle = s.gunHeat > 0 ? 0 : 9;
}
/** the server's exact state of the door gun I man → its sim copy */
function loadGun(v: Vehicle, g: GunSelf) {
  v.gunAimY = g.aimY; v.gunAimP = g.aimP; v.gunSpin = g.spin; v.gunHeat = g.heat; v.gunCool = g.cool; v.gunIdle = g.idle; v.gunBelt = g.belt; v.gunLock = g.lock; v.gunArm = g.arm;
}
function copyVeh(d: VehSnap, s: VehSnap) {
  d.id = s.id; d.x = s.x; d.y = s.y; d.z = s.z; d.yaw = s.yaw; d.pitch = s.pitch; d.roll = s.roll; d.vf = s.vf; d.steer = s.steer; d.hp = s.hp; d.flags = s.flags; d.st = s.st; d.kind = s.kind; d.s0 = s.s0; d.s1 = s.s1; d.s2 = s.s2; d.tick = s.tick; d.radio = s.radio; d.tyres = s.tyres;
  d.gunY = s.gunY; d.gunP = s.gunP; d.gunSpin = s.gunSpin; d.gunHeat = s.gunHeat; d.gunBelt = s.gunBelt; d.gunLock = s.gunLock;
}
function copySnap(d: PlayerSnap, s: PlayerSnap) {
  d.id = s.id; d.x = s.x; d.y = s.y; d.z = s.z; d.yaw = s.yaw; d.pitch = s.pitch; d.vx = s.vx; d.vy = s.vy; d.vz = s.vz; d.st = s.st; d.crouch = s.crouch; d.sprint = s.sprint; d.swim = s.swim; d.grounded = s.grounded;
  d.hasHp = s.hasHp; d.hp = s.hp; d.shield = s.shield; d.held = s.held; d.anim = s.anim; d.team = s.team; d.tick = s.tick; d.total = s.total;
}
function copySnapMeta(rm: Remote, s: PlayerSnap) { rm.st = s.st; rm.crouch = s.crouch; rm.sprint = s.sprint; rm.swim = s.swim; rm.grounded = s.grounded; rm.hp = s.hp; rm.shield = s.shield; rm.held = s.held; rm.anim = s.anim; }
