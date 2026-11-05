// THE AUTHORITATIVE MATCH. One instance per lobby on the server; the same class runs in-browser for offline practice.
// Owns players, inputs, shots (with lag compensation), loot, projectiles, storm, phases, resurgence, bots.
// Input pacing: every input a client sends is simulated exactly once, in order (1:1 with the client's prediction), paced by
// a per-player credit (1 per tick, capped) so a link stall is caught up afterwards but nobody can move faster than 60 Hz.
import { POIS, WEAPONS } from "../world/map";
import type { Terrain } from "../world/terrain";
import {
  CHEST_OPEN_DIST, CONSUMABLE_DEFS, DT, HISTORY_TICKS, INPUT_CREDIT_MAX, INPUT_MAX_PER_TICK, INPUT_QUEUE_MAX, INPUT_STARVE_TICKS,
  MAX_HP, MAX_PLAYERS, MAX_REWIND_TICKS, PICKUP_DIST, PLANE_ALT, PLANE_BAY_S, PLANE_CHORD_R, PLANE_SPEED, PLAYER_H, PLAYER_R,
  REDEPLOY_ALT, RESULTS_S, RESURGENCE_WARN_S, resurgenceDelay, SOLO_REDEPLOYS, SQUAD_SIZE, matchSeats, WARMUP_S, WEAPON_DEFS, AMMO_PICKUP, AMMO_CAP, BOMB, ECON,
  START_PISTOL_AMMO,
} from "./const";
import { CONSUMABLES } from "../world/map";
import * as islet from "../pois/lobby-islet";
import { chestRegen, IK, lootReachable, placeLoot, REGEN, rollAmmoBox, rollChestContents, settleLoot, tossClear, type Chest, type Item } from "./loot";
import { aimedItem, standNear } from "./pickup";
const NO_STANDS: ReadonlyArray<{ x: number; y: number; z: number }> = [];
import {
  AMMO_TYPES, B, PS, SK, alive, applyDamage, bombSlot, copyInput, currentSpread, eyeY, giveAmmo, height, invDrop, invMove, makeInput, makePlayer, recordHistory,
  pelletDamage, resetForMatch, stepPlayer, weaponDamage, weaponDef, type Input, type Player,
} from "./player";
import { Rng } from "./rng";
import { fillTeams } from "./teams";
import { inStorm, makeStormState, planStorm, stormAt, STORM_TICK_S, type StormPlan, type StormState } from "./storm";
import { makeHit, type StaticWorld } from "./world";
import { ANN, Events, KILL_BOMB, KILL_GUN, KILL_HELI, KILL_TUK, SURF_PLAYER, VK, histSlot, yawDec, yawEnc } from "../net/proto";
import {
  TUK, VE, VF, VH, VKind, VS, VehicleSet, blendVeh, enterVehicle, exitVehicle, flipVehicle, footDist, freeSeat, rayVehicle, RAY_TYRE, recordVehicle,
  restVehicle, seatRider, seatRiderAt, spawnVehicle, specOf, stepVehicle, vehPose, vehicleInReach, type Vehicle,
} from "./vehicle";
import { fleetSpots, isletSpots, rangeSpots, type TukSpot } from "./tuk-spots";
import { GUN_SHOT, HELI, TOP_BANANA, gunBarrel, gunOf, inRotor, stepGunIdle, stepHeli } from "./heli";
import { heliIslet, heliPads, heliRange } from "./heli-spots";
import { BotBrain, botThink, botThinksNow } from "./bots";
import { BOT_DIFFICULTY, type BotDifficulty } from "./const";
import { PLANE_OPEN_S, planeCloseTick, planeExit, planeStep, planeTime } from "./plane";
import { TARGET_STRIDE, blendPose, blendYaw, makeShotResult, rayCapsule, shotDir, traceShot, type ShotResult } from "./hitscan";
import {
  HEAL_PAD, RACK_RESTOCK_S, RANGE_RACK, RANGE_SPAWN, RANGE_TARGETS, RANGE_YAW_DOWNRANGE, RANGE_YAW_UPRANGE, SHOOTER_RESPAWN_S,
  TARGET_RESPAWN_S, healPadPos, targetPos, type RackSlot, type RangeTarget,
} from "./range";
import { sw } from "../pois/peel-strip";
import { GlassState, glassAim, glassBlast, glassPunch, glassShot, GC } from "./glass";
import { killWeapon } from "./mythic";
import { bombLaunch, bombStep, type BombBody } from "./bomb";
import { COVER, CoverSet, PLACED } from "./cover";
import { bananaStands, cashStacks, Economy, STAND_ID0, STAND_SIZE, type EconHost } from "./economy";

/** resurgence ends early once this few squads (trios) / players (solo) are left in the match */
const RES_END_SQUADS = 7, RES_END_SOLO = 20;
/** sim ticks between two storm bites */
const STORM_TICK_N = Math.round(STORM_TICK_S / DT);
/** seconds the spectator camera stays on a watched kong that went down before it moves on */
export const SPECTATE_HOLD_S = 1.4;
/** while a squadmate lives an eliminated player may only watch their own squad (anti-ghosting) */
export const SPECTATE_SQUAD_ONLY = true;

export const enum Phase { Warmup = 0, Plane = 1, Play = 2, Results = 3 }
export type Mode = "solo" | "trios";

export interface Rocket { id: number; owner: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; rarity: number }
export interface MatchOpts { seed: number; mode: Mode; world: StaticWorld; humans: Array<{ id: number; name: string; team: number }>; botNames?: string[]; botDifficulty?: BotDifficulty; botDamageToHumans?: number;
  /** practice aim nerf: beyond this range (m) a bot shooting at a human sprays wider the farther away they are */
  botAimRange?: number;
  /** FIRING RANGE (shared/sim/range.ts): no plane / storm / end — target dummies that respawn, a self-restocking rack of
   * every item, infinite reserve ammo. Everything else (damage, falloff, spread, fire rate, hit-reg) is the match code. */
  range?: boolean;
  /** seats to fill, humans + bots (default matchSeats(mode): trios 48, solo 50; never more than
   *  MAX_PLAYERS, never fewer than the humans) */
  seats?: number }

const HIT = makeHit();
const DIR = new Float64Array(3);
/** tuk-tuk pose register (x, y, z, yaw, pitch, roll) */
const VP = new Float64Array(6);
/** ticks a kong that bailed out of a flying helicopter is spared its rotor and hull (on top of their own gaps) */
const BAIL_SAFE_TICKS = 60;
/** a burnt-out wreck's last WRECK_SINK s: it settles this far (m) into the ground instead of vanishing */
const WRECK_SINK = 8, WRECK_SINK_D = [3, 4.6];
/** the pose the last seatRewound sat a rider on (what a door gunner's rounds leave the helicopter at), the barrel */
const SEATP = new Float64Array(6), BAR = new Float64Array(4);
const vslot = (tick: number) => (((tick % HISTORY_TICKS) + HISTORY_TICKS) % HISTORY_TICKS) * VH;
const RES = makeShotResult();
/** where a spawned item comes to rest (settleLoot / tossClear register) */
const LP = new Float64Array(3);
const CASH: number[] = [];

/** lab / debug probe: called once per hitscan pellet with the evaluated (rewound) time and the verdict */
export type ShotProbe = (shooter: Player, inp: Input, pellet: number, evalTick: number, clamped: boolean, res: ShotResult, targets: Float64Array) => void;

export class Match {
  readonly players: Player[] = [];
  readonly world: StaticWorld; readonly terrain: Terrain;
  readonly mode: Mode; readonly seed: number; readonly rng: Rng;
  readonly botDifficulty: BotDifficulty;
  private readonly botDamageToHumans: number;
  private readonly botAimRange: number;
  phase: Phase = Phase.Warmup; phaseT = 0; tick = 0; time = 0;
  readonly plan: StormPlan; readonly storm: StormState = makeStormState();
  chests: Chest[]; items: Item[]; nextItemId: number;
  private deathLoot: Array<{ kind: IK; sub: number; rarity: number; count: number; loaded?: number; x: number; y: number; z: number; owner: number }> = [];
  /** Publish after simulation, so a new drop cannot be picked up before its SpawnItem event. */
  private flushDeathLoot() {
    while (this.deathLoot.length && this.ev.n < 240) {
      const q = this.deathLoot.shift()!;
      const it = this.spawnItem(q.kind, q.sub, q.rarity, q.count, q.x, q.y, q.z, 1.2, q.owner);
      if (q.loaded !== undefined) it.loaded = q.loaded;
    }
  }
  rockets: Rocket[] = []; nextRocketId = 1;
  /** banana bombs in flight / rolling / lying with a burning fuse */
  bombs: Array<BombBody & { id: number; owner: number; fuse: number }> = []; nextBombId = 1;
  /** the crate walls of THIS match (shared/sim/cover.ts) — bound into the shared world before every step */
  readonly covers = new CoverSet(); nextCoverId = 1;
  /** (shared/sim/economy.ts) Banana Bucks, Banana Stands, bounties (null on the firing range) */
  readonly econ: Economy | null;
  /** breakable glass of THIS match (shared/sim/glass.ts) — bound into the shared world before every step */
  readonly glass: GlassState;
  /** the tuk-tuks of THIS match (shared/sim/vehicle.ts) — bound into the shared world like the glass */
  readonly vehs: VehicleSet;
  /** where this phase's tuk-tuks were parked (a wrecked one comes back there in the warm-up and on the range) */
  private tukHome: ReadonlyArray<TukSpot> = [];
  readonly ev = new Events();
  plane = { x0: 0, z0: 0, x1: 0, z1: 0, dx: 0, dz: 0 };
  private lastInput: Input[] = [];
  // per-human input queue (ring of preallocated inputs) + pacing state
  private qBuf: Input[][] = []; private readonly qHead = new Int32Array(MAX_PLAYERS); private readonly qLen = new Int32Array(MAX_PLAYERS);
  private readonly lastQueued = new Float64Array(MAX_PLAYERS); private readonly credit = new Float64Array(MAX_PLAYERS);
  private readonly starve = new Int32Array(MAX_PLAYERS); private readonly qMin = new Int32Array(MAX_PLAYERS); private readonly qWin = new Int32Array(MAX_PLAYERS);
  private readonly neutral = makeInput();
  /** rewound hitboxes for the shot being resolved: [x, y, z, h] per player id (h = 0: not a target) */
  readonly targets = new Float64Array(MAX_PLAYERS * TARGET_STRIDE);
  shotProbe: ShotProbe | null = null;
  /** counters (tests / telemetry) */
  readonly netStats = { inputsDropped: 0, starveSteps: 0, clampedShots: 0, driftCredits: 0 };
  readonly brains: Array<BotBrain | null> = [];
  /** match time each player last touched down from a drop / redeploy (-1e9 = never): bots give a fresh lander a moment */
  readonly dropLandT = new Float64Array(MAX_PLAYERS).fill(-1e9);
  squadCount = 0; resurgenceOn = true; warned = false; resEndAt = Infinity; winnerTeam = -1; finalAnnounced = false;
  /** recent gunfire [x, z, tick, team] × 16 (bots hunt it) */
  readonly noise = new Float64Array(16 * 4); private noiseI = 0;
  /** squads already announced as eliminated this match */
  readonly teamsOut = new Set<number>();
  /** match time (s from the plane) at which each squad got its final outcome (out, or the win) — the results card's
   *  authoritative TIME IN MATCH */
  readonly teamOutcomeTimes = new Map<number, number>();
  /** host hooks */
  onInventory: (id: number) => void = () => {};
  onPhase: (phase: Phase) => void = () => {};
  planeOpen = false; planeT = 0; skipWarmup = false;
  /** the warm-up's length (s). A test server may stretch it (KR_WARMUP_S — a scripted multi-tab test needs longer on
   * the islet than a headless pair of tabs gets); the clients' countdown still shows the standard one */
  warmupS = WARMUP_S;
  /** the warm-up waits while this says so — a client still streaming the island in. The host
   * wires it (MatchHost.holdForStream); while held the warm-up clock parks 3 s before the plane. warmHeldS = seconds held.
   * Never past the plane time of a full warm-up: warmWall = real seconds since the warm-up began, and no
   * hold once it reaches WARMUP_S — START NOW waits for the stream at most as long as the warm-up would have anyway. */
  holdWarmup: (() => boolean) | null = null; warmHeldS = 0; warmWall = 0;
  /** the tick the plane phase began in (shared/sim/plane.ts: every plane position is a function of it) */
  planeStartTick = 0;
  /** host option: after the results screen the match is OVER (back to the lobby room) instead of looping into warm-up */
  endAfterResults = false; over = false;
  private lastStormPhase = 0; private lastShrinking = false;
  /** firing range mode (see MatchOpts.range) */
  readonly range: boolean;
  private rack: Array<RackSlot & { x: number; y: number; z: number; item: number; goneAt: number }> = [];
  private dummies: Array<{ id: number; t: RangeTarget; x: number; y: number; z: number; dir: number; sign: number } | null> = [];
  private readonly dummyInput = makeInput();

  constructor(o: MatchOpts) {
    this.world = o.world; this.terrain = o.world.terrain; this.mode = o.mode; this.seed = o.seed; this.rng = new Rng(o.seed);
    this.glass = new GlassState(o.world); this.glass.bind();
    this.vehs = new VehicleSet(o.world); this.vehs.bind();
    // a tier caps the caller's nerfs; no tier (the server, a client that predates tiers): the nerfs exactly as passed —
    // the classic practice client's 10 % damage is the easy tier, everything else standard
    const tier = o.botDifficulty ? BOT_DIFFICULTY[o.botDifficulty] : null;
    this.botDifficulty = o.botDifficulty ?? ((o.botDamageToHumans ?? 1) < 1 ? "easy" : "standard");
    this.botDamageToHumans = tier ? Math.min(o.botDamageToHumans ?? 1, tier.damageToHumans) : o.botDamageToHumans ?? 1;
    this.botAimRange = tier ? Math.min(o.botAimRange ?? Infinity, tier.aimRange) : o.botAimRange ?? Infinity;
    this.range = !!o.range;
    const size = SQUAD_SIZE[o.mode];
    // humans keep the team they were given by the lobby; bots fill the seats (trios 48 = 16 even
    // trios, solo 50) — human solos get a partner first, then human squads fill up, then bot squads with no lone bot
    // (shared/sim/teams.ts)
    const humans = o.humans.filter((h) => h.id >= 0 && h.id < MAX_PLAYERS);
    for (const h of humans) this.players[h.id] = makePlayer(h.id, h.team, h.name, false);
    const fill = fillTeams(humans, Math.min(MAX_PLAYERS, o.seats ?? matchSeats(o.mode)), size);
    const names = o.botNames ?? BOT_NAMES;
    for (const b of fill.bots) this.players[b.id] = makePlayer(b.id, b.team, names[b.id % names.length] + (b.id >= names.length ? "-" + Math.floor(b.id / names.length + 1) : ""), true);
    this.squadCount = new Set(this.players.map((p) => p.team)).size;
    for (let id = 0; id < this.players.length; id++) {
      this.lastInput[id] = makeInput(); this.qBuf[id] = Array.from({ length: INPUT_QUEUE_MAX }, makeInput); this.qMin[id] = 1 << 30;
      this.brains[id] = this.players[id].bot ? new BotBrain(id, this.rng.next() * 1e9 | 0, this.botDifficulty) : null;
    }
    this.plan = planStorm(o.seed, this.terrain, this.world);
    if (this.range) { this.chests = []; this.items = []; this.nextItemId = 0; }
    else { const loot = placeLoot(o.seed, this.world); this.chests = loot.chests; this.items = loot.items; this.nextItemId = this.items.length; }
    // the stands stand all match long: solid counters in the cover set (permanent, never hurt)
    this.econ = this.range ? null : new Economy(this.econHost(), bananaStands(this.world));
    if (this.econ) this.econ.stands.forEach((s, i) => this.covers.add(STAND_ID0 + i, 255, s.x, s.y, s.z, s.yaw, 1e9, 0, STAND_SIZE));
    this.enterWarmup();
    if (this.range) this.setupRange();
  }

  // ---------------------------------------------------------------- firing range
  private setupRange() {
    // seat 0.. = humans; the first bots become the target dummies (own team each: always hittable); the rest sit out
    const bots = this.players.filter((p) => p.bot);
    const za = sw(0, 0), zb = sw(0, 1), zx = zb[0] - za[0], zz = zb[2] - za[2];
    for (const p of this.players) { this.brains[p.id] = null; this.dummies[p.id] = null; }
    RANGE_TARGETS.forEach((t, i) => {
      const p = bots[i]; if (!p) return;
      p.name = t.name; p.team = 100 + i;
      const [x, , z] = targetPos(t);
      const yaw = RANGE_YAW_UPRANGE;
      // +mx moves along (cos yaw, -sin yaw) (player.ts right vector): which sign walks toward strip +Z
      const sign = Math.sign(Math.cos(yaw) * zx - Math.sin(yaw) * zz) || 1;
      this.dummies[p.id] = { id: p.id, t, x, y: this.world.ground(x, z), z, dir: 1, sign };
      this.placeDummy(p);
    });
    for (const p of bots.slice(RANGE_TARGETS.length)) { resetForMatch(p); p.st = PS.Spectate; p.eliminated = true; p.x = p.z = 0; p.y = -50; }
    for (const p of this.players) if (!p.bot) this.spawnShooter(p, true);
    for (const r of RANGE_RACK) {
      const [x, , z] = sw(r.lx, r.lz);
      const e = { ...r, x, y: this.world.ground(x, z) + 0.05, z, item: -1, goneAt: -1 };
      this.rack.push(e); this.stockRack(e);
    }
  }
  private placeDummy(p: Player) {
    const d = this.dummies[p.id]!;
    resetForMatch(p);
    p.x = d.x; p.y = d.y; p.z = d.z; p.yaw = RANGE_YAW_UPRANGE; p.pitch = 0;
    p.st = PS.Ground; p.grounded = true; p.hp = MAX_HP; p.shield = d.t.shield; p.respawnAt = -1;
  }
  /** the shooter: back on the firing line with full health, the inventory kept (first spawn: a common BUNCHGUN) */
  private spawnShooter(p: Player, first: boolean) {
    const [x, , z] = RANGE_SPAWN;
    if (first) {
      resetForMatch(p);
      const s = p.slots[0]; s.kind = SK.Weapon; s.id = WEAPONS.indexOf("ar"); s.rarity = 0; s.mag = WEAPON_DEFS.ar.mag; s.count = 1; p.active = 0;
    }
    p.infAmmo = true;
    for (let i = 0; i < AMMO_TYPES.length; i++) p.ammo[i] = AMMO_CAP[AMMO_TYPES[i]];
    p.x = x; p.y = this.world.ground(x, z) + 0.02; p.z = z; p.vx = p.vy = p.vz = 0; p.yaw = RANGE_YAW_DOWNRANGE; p.pitch = 0;
    p.st = PS.Ground; p.grounded = true; p.hp = MAX_HP; p.shield = 0; p.respawnAt = -1; p.reloadT = 0; p.useT = 0; p.cool = 0;
    this.onInventory(p.id);
  }
  private stockRack(e: { kind: number; sub: number; rarity: number; count: number; x: number; y: number; z: number; item: number; goneAt: number }) {
    const it: Item = { id: this.nextItemId++ & 0xffff, kind: e.kind as IK, sub: e.sub, rarity: e.rarity, count: e.count, x: e.x, y: e.y, z: e.z, taken: false, bornAt: this.time };
    this.items.push(it); this.ev.spawnItem(it.id, it.kind, it.sub, it.rarity, it.count, it.x, it.y, it.z);
    e.item = it.id; e.goneAt = -1;
  }
  private stepRange() {
    this.tick++;
    this.phaseT += DT;
    for (const p of this.players) {
      if (p.st === PS.Spectate) continue;
      if (!p.bot) {
        this.runHuman(p);
        // heal test pad: drains shield, then health, never below 1 hp
        if (alive(p)) {
          const [hx, , hz] = healPadPos();
          if (Math.hypot(p.x - hx, p.z - hz) < HEAL_PAD.r) {
            let dmg = HEAL_PAD.dps * DT;
            const sh = Math.min(p.shield, dmg); p.shield -= sh; dmg -= sh;
            if (dmg > 0) p.hp = Math.max(1, p.hp - dmg);
            p.anim |= 4;
          }
        }
        continue;
      }
      const d = this.dummies[p.id];
      if (!d || !alive(p)) continue;
      const inp = this.dummyInput;
      inp.seq++; inp.buttons = 0; inp.mz = 0; inp.mx = 0; inp.yaw = RANGE_YAW_UPRANGE; inp.pitch = 0;
      if (d.t.strafe > 0) {
        const za = sw(0, 0), zb = sw(0, 1);
        const lat = (p.x - d.x) * (zb[0] - za[0]) + (p.z - d.z) * (zb[2] - za[2]);
        if (lat > d.t.strafe) d.dir = -1; else if (lat < -d.t.strafe) d.dir = 1;
        inp.mx = d.dir * d.sign;
      }
      this.simulate(p, inp);
    }
    this.stepVehicles();
    this.stepRockets();
    this.stepBombs();
    this.stepCovers();
    for (const p of this.players) {
      if (p.st !== PS.Dead || p.respawnAt < 0 || this.phaseT < p.respawnAt) continue;
      if (p.bot) { if (!this.dummies[p.id]) continue; this.placeDummy(p); }
      else this.spawnShooter(p, false);
      this.ev.respawn(p.id, p.x, p.y, p.z);
    }
    // restock the rack; drop the taken items from the list (it would grow with every pick-up)
    let gone = false;
    for (const e of this.rack) {
      const it = e.item >= 0 ? this.itemById(e.item) : null;
      if (e.goneAt < 0 && (!it || it.taken)) e.goneAt = this.phaseT;
      if (e.goneAt >= 0 && this.phaseT - e.goneAt >= RACK_RESTOCK_S) { this.stockRack(e); gone = true; }
    }
    if (gone) this.items = this.items.filter((i) => !i.taken);
    this.recordAll();
  }

  // ---------------------------------------------------------------- inputs
  /** queue one decoded input for human `id`. Duplicates (redundant sockets) and stale inputs are ignored. */
  pushInput(id: number, i: Input) {
    const p = this.players[id]; if (!p || p.bot) return;
    if (!(i.seq > this.lastQueued[id])) return;
    this.lastQueued[id] = i.seq;
    let len = this.qLen[id];
    if (len >= INPUT_QUEUE_MAX) { this.qHead[id] = (this.qHead[id] + 1) % INPUT_QUEUE_MAX; len--; this.netStats.inputsDropped++; }
    copyInput(this.qBuf[id][(this.qHead[id] + len) % INPUT_QUEUE_MAX], i); this.qLen[id] = len + 1;
  }
  /** inputs waiting for player `id` (telemetry) */
  queued(id: number) { return this.qLen[id]; }
  /** one tick of a human: simulate queued inputs 1:1 (paced by credit); if the link is silent for too long, step a neutral input */
  private runHuman(p: Player) {
    const id = p.id, q = this.qBuf[id], last = this.lastInput[id];
    let c = Math.min(INPUT_CREDIT_MAX, this.credit[id] + 1), n = 0;
    while (this.qLen[id] > 0 && c >= 1 && n < INPUT_MAX_PER_TICK) {
      const h = this.qHead[id];
      copyInput(last, q[h]); this.qHead[id] = (h + 1) % INPUT_QUEUE_MAX; this.qLen[id]--;
      c -= 1; n++;
      this.simulate(p, last);
    }
    this.credit[id] = c;
    if (n > 0) this.starve[id] = 0;
    else if (++this.starve[id] > INPUT_STARVE_TICKS) {
      // the client went silent (tab hidden, dead link): the server keeps its body alive — gravity, storm, no movement
      const nI = this.neutral; copyInput(nI, last); nI.mx = 0; nI.mz = 0; nI.buttons &= B.CROUCH | B.SCOPE;
      this.simulate(p, nI); this.netStats.starveSteps++;
    }
    // clock drift: a queue that never drains below 2 for 0.5 s earns one extra step (≤ 3 % speed, far below any exploit)
    const len = this.qLen[id]; if (len < this.qMin[id]) this.qMin[id] = len;
    if (++this.qWin[id] >= 30) { if (this.qMin[id] >= 2) { this.credit[id] += 1; this.netStats.driftCredits++; } this.qMin[id] = 1 << 30; this.qWin[id] = 0; }
  }
  private resetInputs(id: number) {
    this.qHead[id] = 0; this.qLen[id] = 0; this.lastQueued[id] = 0; this.credit[id] = 0; this.starve[id] = 0; this.qMin[id] = 1 << 30; this.qWin[id] = 0;
    const li = this.lastInput[id]; li.buttons = 0; li.mx = li.mz = 0; li.seq = 0;
  }

  // ---------------------------------------------------------------- phases
  private enterWarmup() {
    this.teamOutcomeTimes.clear(); this.glass.reset(); this.bombs.length = 0; this.covers.reset();
    this.spawnTuks(this.range ? [...rangeSpots(this.world), ...heliRange(this.world)] : [...isletSpots(this.world), ...heliIslet(this.world)]);
    this.phase = Phase.Warmup; this.phaseT = 0; this.time = 0; this.warmWall = 0; this.warmHeldS = 0;
    const islet = POIS.find((p) => p.id === "lobby-islet")!;
    void islet;
    for (const p of this.players) { resetForMatch(p); this.spawnWarmup(p); p.shield = 0; giveWarmupKit(p, this.rng); }
    this.onPhase(this.phase);
  }
  private enterPlane() {
    this.phase = Phase.Plane; this.phaseT = 0; this.time = 0; this.planeT = 0; this.planeOpen = false; this.planeStartTick = this.tick;
    this.glass.reset();   // every pane whole again for the new match
    this.bombs.length = 0; this.covers.reset(); this.econ?.reset();
    this.spawnTuks([...fleetSpots(this.world, this.seed), ...heliPads(this.world, this.seed)]);   // the taxis wait at their ranks, the helicopters on their pads (Peel Strip's + one or two picked by the seed)
    const a = this.rng.next() * Math.PI * 2, off = this.rng.range(-380, 380);
    const dx = Math.cos(a), dz = Math.sin(a), px = -dz * off, pz = dx * off;
    this.plane.x0 = px - dx * PLANE_CHORD_R; this.plane.z0 = pz - dz * PLANE_CHORD_R; this.plane.x1 = px + dx * PLANE_CHORD_R; this.plane.z1 = pz + dz * PLANE_CHORD_R; this.plane.dx = dx; this.plane.dz = dz;
    this.dropLandT.fill(-1e9);
    for (const p of this.players) {
      resetForMatch(p); p.st = PS.Plane; p.x = this.plane.x0; p.y = PLANE_ALT; p.z = this.plane.z0; p.yaw = Math.atan2(-dx, -dz);
      giveStartKit(p);   // everybody — humans and bots — boards with a gray pistol and some light rounds
      this.brains[p.id]?.planDrop(this, p);
      this.onInventory(p.id);
    }
    this.resurgenceOn = true; this.warned = false; this.resEndAt = Infinity; this.winnerTeam = -1; this.finalAnnounced = false; this.lastStormPhase = 0; this.lastShrinking = false; this.teamsOut.clear(); this.teamOutcomeTimes.clear();
    this.ev.announce(ANN.MatchStart);
    this.onPhase(this.phase);
  }
  /** the economy's narrow view of this match */
  private econHost(): EconHost {
    const m = this;
    return {
      get players() { return m.players; }, get mode() { return m.mode; }, get time() { return m.time; }, get rng() { return m.rng; }, get resurgenceOn() { return m.resurgenceOn; },
      announce: (c, a, b) => m.ev.announce(c, a, b),
      drop: (kind, sub, rarity, count, x, y, z, scatter) => { m.spawnItem(kind, sub, rarity, count, x, y, z, scatter, -1); },
      inventory: (id) => m.onInventory(id),
      buyBack: (q) => { q.eliminated = false; q.placement = 0; q.respawnAt = m.time; },
    };
  }
  private enterPlay() { this.phase = Phase.Play; this.phaseT = 0; this.onPhase(this.phase); }
  private enterResults(winner: number) {
    this.phase = Phase.Results; this.phaseT = 0; this.winnerTeam = winner;
    if (this.players.some((p) => p.team === winner)) this.teamOutcomeTimes.set(winner, this.time);
    for (const p of this.players) if (p.team === winner) { p.placement = 1; }
    // every spectator watches the winners for the end: stepSpectate stops with Play, and whoever they watched may be
    // the kong that just fell (else the camera sits on its body until it is cleared away)
    const champ = this.players.find((q) => q.team === winner && alive(q) && q.st !== PS.Plane);
    if (champ) for (const p of this.players) {
      if (p.bot || p.st !== PS.Dead || p.respawnAt >= 0 || p.spectate < 0) continue;
      const t = this.players[p.spectate];
      if (t && t.team === winner && alive(t)) continue;
      p.spectate = champ.id; this.onInventory(p.id);
    }
    this.ev.announce(ANN.Victory, winner & 0xff);
    this.onPhase(this.phase);
  }
  /** host: leave warmup now */
  startNow() { if (this.phase === Phase.Warmup) this.skipWarmup = true; }

  // ---------------------------------------------------------------- the tick
  step() {
    this.glass.bind(); this.vehs.bind(); this.world.cover = this.covers;
    if (this.range) { this.stepRange(); this.flushGlass(); return; }
    this.tick++;
    this.phaseT += DT;
    if (this.phase === Phase.Plane || this.phase === Phase.Play) this.time += DT;
    if (this.phase === Phase.Warmup) this.warmWall += DT;
    const W = this.warmupS;
    if (this.phase === Phase.Warmup && (this.phaseT >= W - 3 || this.skipWarmup) && this.warmWall < W && this.holdWarmup?.()) {
      this.warmHeldS += DT; if (this.phaseT > W - 3) this.phaseT = W - 3;
    } else if (this.phase === Phase.Warmup && (this.phaseT >= W || this.skipWarmup || this.warmWall >= W)) { this.skipWarmup = false; this.enterPlane(); }
    if (this.phase === Phase.Plane) this.stepPlane();
    if (this.phase === Phase.Results && this.phaseT > RESULTS_S) {
      // lobbies send everyone back to the room (the host can switch SOLO/TRIOS, friends can join, START again)
      if (this.endAfterResults) { this.over = true; return; }
      this.enterWarmup(); this.recordAll(); return;
    }

    // storm
    if (this.phase === Phase.Play || this.phase === Phase.Plane) {
      stormAt(this.plan, this.time, this.storm);
      if (this.storm.phase !== this.lastStormPhase || this.storm.shrinking !== this.lastShrinking) { this.ev.storm(this.storm.phase, this.storm.shrinking); this.lastStormPhase = this.storm.phase; this.lastShrinking = this.storm.shrinking; }
      // RESURGENCE ends at the scheduled storm phase — or earlier once the lobby has thinned out (few squads left), so
      // the final circles always have a real field of players. Either way: a 20 s warning, then kills are final.
      if (this.resurgenceOn) {
        const few = this.storm.phase >= 3 && this.phase === Phase.Play && (this.mode === "trios" ? this.squadsLeft() <= RES_END_SQUADS : this.squadsLeft() <= RES_END_SOLO);
        const sched = this.storm.shrinking && this.storm.phase < this.plan.res.length && !this.plan.res[this.storm.phase] ? this.time + this.storm.timer : Infinity;
        if (!this.warned && (few || sched - this.time <= RESURGENCE_WARN_S)) { this.warned = true; this.resEndAt = Math.min(sched, this.time + RESURGENCE_WARN_S); this.ev.announce(ANN.ResurgenceWarn); }
        if (!this.storm.resurgence || (this.warned && this.time >= this.resEndAt)) {
          this.resurgenceOn = false; this.ev.announce(ANN.ResurgenceOff);
          const wait = this.players.filter((p) => p.st === PS.Dead && p.respawnAt >= 0); for (const p of wait) p.respawnAt = -1; for (const p of wait) this.eliminate(p);
        }
      }
    }

    // players
    for (const p of this.players) {
      if (p.st === PS.Plane) { p.x = this.planeX(); p.y = PLANE_ALT; p.z = this.planeZ(); }
      const brain = this.brains[p.id];
      if (brain) {
        if (botThinksNow(this, p, brain)) {
          const bi = this.lastInput[p.id];
          botThink(this, p, brain, bi);
          // bots steer with directions, always at full speed (the step scales an analog stick's partial push)
          const l = Math.hypot(bi.mx, bi.mz); if (l > 0) { bi.mx /= l; bi.mz /= l; }
        }
        this.simulate(p, this.lastInput[p.id]);
      } else this.runHuman(p);
      if (((this.tick + p.id) & 3) === 0 && alive(p) && p.st === PS.Ground) this.autoPickup(p);
    }
    // storm damage (hp only; never through shield). One tick a second on the match clock for the zone's
    // whole damage/s (storm.ts STORM_TICK_S), not a 60 Hz drain
    if (this.phase === Phase.Play && this.storm.dps > 0) {
      const bite = this.tick % STORM_TICK_N === 0;
      for (const p of this.players) {
        if (!alive(p) || p.st === PS.Plane) continue;
        if (inStorm(this.storm, p.x, p.z)) { p.stormT += DT; p.anim |= 4; if (bite) { p.hp -= this.storm.dps * STORM_TICK_S; if (p.hp <= 0) this.kill(p, -1, 255); } }
        else p.stormT = 0;
      }
    }
    // deep end-game loot regen: looted chests / ammo boxes re-close and restock (loot.ts REGEN)
    if (this.phase === Phase.Play && this.tick % REGEN.everyTicks === 0) {
      for (const id of chestRegen(this.chests, this.storm, this.time, this.seed, (c) => this.players.some((q) => alive(q) && Math.abs(q.y - c.y) < 2.5 && (q.x - c.x) ** 2 + (q.z - c.z) ** 2 < REGEN.clearR ** 2))) this.ev.chestReset(id);
    }
    this.stepVehicles();
    this.stepRockets();
    this.stepBombs();
    this.stepCovers();
    if (this.econ && this.phase === Phase.Play) this.econ.step();
    this.stepRespawns();
    if (this.phase === Phase.Play) this.checkEnd();
    if (this.phase === Phase.Play && (this.tick & 7) === 0) this.stepSpectate();
    if (this.phase === Phase.Warmup) for (const p of this.players) if (p.st === PS.Dead && this.phaseT * 1 >= p.respawnAt) { p.hp = MAX_HP; p.shield = 0; this.spawnWarmup(p); giveWarmupKit(p, this.rng); this.onInventory(p.id); this.ev.respawn(p.id, p.x, p.y, p.z); }
    this.flushDeathLoot();
    this.flushGlass();
    this.recordAll();
  }
  /** lag-compensation history for this tick, written AFTER every state change of the tick (moves, shots, deaths,
   * warm-up respawns, redeploys) — it must equal what this tick's snapshot carries, or a rewind to it disagrees */
  private recordAll() { for (const p of this.players) recordHistory(p, this.tick); for (const v of this.vehs.list) if (v.live) recordVehicle(v, this.tick); }

  /** apply ONE input to a player: movement + hands (stepPlayer), then everything that input triggers */
  private simulate(p: Player, inp: Input) {
    if (p.st === PS.Plane) {
      // exit at the plane position of the tick the client was showing (inp.lerpA while riding), clamped to a short
      // window around ours — the client predicts the very same exit (shared/sim/plane.ts), so there is no snap
      const T = p.bot ? this.tick : Math.min(this.tick + 6, Math.max(this.tick - 60, inp.lerpA | 0));
      if (planeStep(p, inp, this.plane, this.planeStartTick, T)) this.ev.jump(p.id);
      p.lastSeq = inp.seq;
      return;
    }
    const wasSt = p.st, hpBefore = p.hp, rodeVeh = p.st === PS.Ride ? p.veh : -1;
    const hadUse = (inp.buttons & B.USE) !== 0 && (p.prevButtons & B.USE) === 0;
    const hadFire = (inp.buttons & B.FIRE) !== 0 && (p.prevButtons & B.FIRE) === 0;
    // on a tuk-tuk's bench: this input is played from the seat as the kong's client DREW it when it sampled the input
    // (the tuk-tuk rewound like the targets), so its predicted shot and this one leave the very same eye
    if (wasSt === PS.Ride && p.seat !== 0) this.seatRewound(p, inp);
    // E at a zipline pole grabs the trolley only when nothing the prompt ranks above it is in reach (render.ts fillHud)
    if (hadUse && p.st === PS.Ground && alive(p)) { p.yaw = inp.yaw; p.pitch = inp.pitch; p.useTaken = this.useClaimed(p); }
    // the radio key (any seat): the next station — match state, not the predicted step (a replay must not re-tune it)
    if (wasSt === PS.Ride && (inp.buttons & ~p.prevButtons & B.RADIO)) { const rv = this.vehs.list[p.veh]; if (rv && rv.st === VS.Ok && rv.kind === VKind.Tuk) { rv.radio = (rv.radio + 1) % TUK.RADIO_N; rv.touch = this.tick; } }
    stepPlayer(p, inp, this.world, DT);
    p.lastSeq = inp.seq;
    // out of a helicopter's door in the air: its rotor and its hull spare this kong for a moment (they still move
    // as one — the kong drops away from the door: vehicle.ts exitVehicle)
    if (rodeVeh >= 0 && p.st !== PS.Ride) { const ov = this.vehs.list[rodeVeh]; if (ov && ov.kind === VKind.Heli && ov.air) ov.ramT[p.id] = this.tick + BAIL_SAFE_TICKS; }
    if ((wasSt === PS.Freefall || wasSt === PS.Glide) && p.st === PS.Ground) { this.ev.land(p.id, p.surf); this.dropLandT[p.id] = this.time; }
    if (p.fired > 0 && alive(p)) this.resolveShot(p, inp);
    if (p.thrown > 0 && alive(p)) this.throwBomb(p, p.thrown);
    if (p.placed > 0 && alive(p)) this.placeCover(p);
    // E on foot (one that grabbed a zipline or climbed out of a tuk-tuk does nothing else): the tuk-tuk under the
    // crosshair (climb in / heave it upright), else a window in arm's reach (punched out), a chest, a gun on the ground,
    // and failing all that a tuk-tuk you merely stand beside
    if (hadUse && alive(p) && p.st !== PS.Zip && p.st !== PS.Ride && wasSt !== PS.Ride && p.st !== PS.Climb && wasSt !== PS.Climb) {
      if (!this.useVehicle(p, true) && !(p.st === PS.Ground && this.punchGlass(p)) && !this.interact(p)) this.useVehicle(p, false);
    }
    else if (hadFire && alive(p) && p.st === PS.Ground && p.slots[p.active].kind === 0) this.punchGlass(p);
    if (p.hp < hpBefore && p.hp <= 0 && alive(p)) this.kill(p, -1, 254);
  }
  planeX() { return this.plane.x0 + this.plane.dx * PLANE_SPEED * this.planeT; }
  planeZ() { return this.plane.z0 + this.plane.dz * PLANE_SPEED * this.planeT; }
  private stepPlane() {
    this.planeT = planeTime(this.planeStartTick, this.tick);
    if (!this.planeOpen && this.planeT >= PLANE_OPEN_S) { this.planeOpen = true; this.ev.announce(ANN.PlaneOpen); }
    // the bay closes at 6 + PLANE_BAY_S: every rider's next input exits (predicted by the client too); this is the net
    // for riders whose link went quiet
    if (this.planeT >= PLANE_OPEN_S + PLANE_BAY_S + 0.5) {
      for (const p of this.players) if (p.st === PS.Plane) { planeExit(p, this.plane, this.planeStartTick, planeCloseTick(this.planeStartTick)); this.ev.jump(p.id); }
    }
    if (this.planeT >= PLANE_OPEN_S + PLANE_BAY_S + 1) this.enterPlay();
  }

  // ---------------------------------------------------------------- shooting with lag compensation
  private addNoise(p: Player) {
    const o = this.noiseI * 4; this.noise[o] = p.x; this.noise[o + 1] = p.z; this.noise[o + 2] = this.tick; this.noise[o + 3] = p.team;
    this.noiseI = (this.noiseI + 1) & 15;
  }
  /** index of the nearest enemy gunfire within r metres in the last 4 s, or -1 */
  nearestNoise(x: number, z: number, r: number, team: number): number {
    let best = -1, bd = r * r;
    for (let i = 0; i < 16; i++) {
      const o = i * 4; if (this.tick - this.noise[o + 2] > 240 || this.noise[o + 3] === team || this.noise[o + 2] === 0) continue;
      const d = (this.noise[o] - x) ** 2 + (this.noise[o + 1] - z) ** 2; if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
  itemById(id: number): Item | null { const it = this.items[id]; if (it && it.id === id) return it; for (const q of this.items) if (q.id === id) return q; return null; }

  /**
   * Rewind every other player to what the shooter was looking at: the blend of snapshot ticks A and A+span at fraction f
   * (the client's exact interpolation, see ClientMatch.interpolate). History holds the same quantised numbers the snapshots
   * carried, and blendPose() is the client's function, so the rewound hitboxes are bit-identical to the drawn ones.
   * Capped: never older than MAX_REWIND_TICKS (350 ms); never newer than the last completed tick. Returns the view tick.
   */
  private rewindTo(shooter: Player, A: number, span: number, f: number): number {
    const t = this.viewBlend(A, span, f);
    const ia = histSlot(this.vA), ib = histSlot(this.vB), T = this.targets; f = this.vF;
    for (const q of this.players) {
      const o = q.id * TARGET_STRIDE;
      // no friendly fire: squadmates are never hitscan targets (the client zeroes them the same way)
      if (q === shooter || !alive(q) || q.team === shooter.team) { T[o + 3] = 0; continue; }
      const h = q.hist;
      blendPose(h[ia], h[ia + 1], h[ia + 2], h[ia + 4], h[ib], h[ib + 1], h[ib + 2], h[ib + 4], f, T, o);
      T[o + 4] = blendYaw(h[ia + 3], h[ib + 3], f);   // hitbox facing (the head sits forward of the trunk)
    }
    return t;
  }
  private clamped = false;
  /** the blend a client drew (snapshot ticks A, A + span at fraction f) as the server may rewind to it: never older
   * than MAX_REWIND_TICKS, never newer than the last completed tick → vA / vB / vF; returns the view tick */
  private vA = 0; private vB = 0; private vF = 0;
  private viewBlend(A: number, span: number, f: number): number {
    const hi = this.tick - 1, lo = this.tick - MAX_REWIND_TICKS;
    let a = A, b = A + span;
    let t = a + (b - a) * f;
    this.clamped = false;
    if (!(t >= lo)) { a = b = lo; f = 0; t = lo; this.clamped = true; }
    else if (t > hi) { a = b = hi; f = 0; t = hi; }
    else if (b > hi || a < this.tick - HISTORY_TICKS + 1) { a = b = Math.min(hi, Math.max(lo, Math.round(t))); f = 0; }
    this.vA = a; this.vB = b; this.vF = f;
    return t;
  }
  private dealDamage(victim: Player, damage: number, by: number): number {
    const attacker = by >= 0 ? this.players[by] : null;
    return applyDamage(victim, attacker?.bot && !victim.bot ? damage * this.botDamageToHumans : damage, by);
  }
  private resolveShot(p: Player, inp: Input) {
    // a helicopter's door gunner fired TOP BANANA (shared/sim/heli.ts): its rounds, along its barrels at the pose the
    // gunner sat at for this input (seatRewound — the gunner's client predicted it on the very same pose)
    const gun = gunOf(this.vehs, p);
    if (gun) { this.resolveGunShot(p, inp, gun); return; }
    const w = weaponDef(p); if (!w) return;
    const s = p.slots[p.active];
    const shot = p.shotSeq - 1;
    if ((p.shotSeq & 3) === 1 && this.phase === Phase.Play) this.addNoise(p);
    const ox = p.x, oy = eyeY(p), oz = p.z;
    if (w.projectile) {
      const cp = Math.cos(p.pitch), sp = Math.sin(p.pitch), sy = Math.sin(p.yaw), cy = Math.cos(p.yaw);
      const dx = -sy * cp, dy = sp, dz = -cy * cp;
      const r: Rocket = { id: this.nextRocketId++ & 0xffff, owner: p.id, x: ox + dx * 0.8, y: oy + dy * 0.8 - 0.15, z: oz + dz * 0.8, vx: dx * w.projectile.speed + p.vx * 0.5, vy: dy * w.projectile.speed, vz: dz * w.projectile.speed + p.vz * 0.5, life: 6, rarity: s.rarity };
      this.rockets.push(r); this.ev.rocket(r.id, p.id, r.x, r.y, r.z, r.vx, r.vy, r.vz);
      return;
    }
    // bots aim at the live state they just observed → evaluate at the latest tick; humans at what they were drawing
    const evalTick = p.bot ? this.rewindTo(p, this.tick - 1, 0, 0) : this.rewindTo(p, inp.lerpA, inp.lerpSpan, inp.lerpF);
    if (this.clamped) this.netStats.clampedShots++;
    let spread = currentSpread(p, w);
    const T = this.targets;
    const foe = p.bot ? this.players[this.brains[p.id]?.enemy ?? -1] : undefined;
    if (foe && !foe.bot) {
      // practice nerf: past botAimRange the shot lands within a circle growing 0.25 m per metre of extra distance
      const d = Math.hypot(foe.x - p.x, foe.z - p.z), extra = d - this.botAimRange;
      if (extra > 0) spread += Math.atan2(0.25 * extra, d) * (180 / Math.PI);
    }
    for (let k = 0; k < p.fired; k++) {
      shotDir(p.id, shot, k, spread, p.yaw, p.pitch, DIR);
      const dx = DIR[0], dy = DIR[1], dz = DIR[2];
      traceShot(this.world, ox, oy, oz, dx, dy, dz, T, this.players.length, RES);
      // a tuk-tuk's panels stop the bullet (its riders are open from the chest up; nobody hits the one they sit in)
      const tuk = this.rayTuks(p.st === PS.Ride ? p.veh : -1, ox, oy, oz, dx, dy, dz, RES.t, false);
      if (tuk >= 0) { RES.t = this.vt; RES.victim = -1; RES.zone = 0; RES.worldHit = true; RES.surf = 1; RES.cover = -1; }
      glassShot(this.glass, ox, oy, oz, dx, dy, dz, RES.t, GC.Shot, p.id);   // panes on the way shatter; the bullet carries on
      this.shotProbe?.(p, inp, k, evalTick, this.clamped, RES, T);
      const bestT = RES.t;
      const victim = RES.victim >= 0 ? this.players[RES.victim] : null, zone = RES.zone;
      if (victim && alive(victim) && victim.hp > 0) {
        const dmg = pelletDamage(w, s.rarity, bestT, zone);
        const hadShield = victim.shield > 0;
        const dealt = this.dealDamage(victim, dmg, p.id);
        p.damage += dealt;
        const killed = victim.hp <= 0;
        this.ev.hit(p.id, victim.id, killed ? zone : hadShield && victim.shield > 0 ? 2 : zone, dealt, ox + dx * bestT, oy + dy * bestT, oz + dz * bestT, killed, hadShield && victim.shield <= 0);
        this.ev.shot(p.id, WEAPONS.indexOf(w.id), ox, oy, oz, ox + dx * bestT, oy + dy * bestT, oz + dz * bestT, SURF_PLAYER, true);
        // the rest of this blast passes through the body (the client's prediction drops the target the same way)
        if (killed) { T[victim.id * TARGET_STRIDE + 3] = 0; this.kill(victim, p.id, killWeapon(WEAPONS.indexOf(w.id), s.rarity)); }
        else this.brains[victim.id]?.onHurt(p.id);
      } else {
        if (tuk >= 0) {
          this.burstTyre(this.vehs.list[tuk], ox + dx * bestT, oy + dy * bestT, oz + dz * bestT);
          this.hurtTuk(this.vehs.list[tuk], pelletDamage(w, s.rarity, bestT, 0), p.id, ox + dx * bestT, oy + dy * bestT, oz + dz * bestT);
        }
        if (RES.cover >= 0) this.hurtCover(RES.cover, pelletDamage(w, s.rarity, bestT, 0));
        this.ev.shot(p.id, WEAPONS.indexOf(w.id), ox, oy, oz, ox + dx * bestT, oy + dy * bestT, oz + dz * bestT, RES.worldHit ? RES.surf : 0, RES.worldHit);
      }
    }
  }
  /** one round of TOP BANANA (the gunner's p.fired = 1): hitscan from the gunner's eye along the barrels, lag-compensated
   * like any gun; the gunner's own helicopter is never in the way */
  private resolveGunShot(p: Player, inp: Input, v: Vehicle) {
    const shot = p.shotSeq - 1, w = TOP_BANANA;
    if ((p.shotSeq & 3) === 1 && this.phase === Phase.Play) this.addNoise(p);
    const ox = p.x, oy = eyeY(p), oz = p.z;
    const evalTick = p.bot ? this.rewindTo(p, this.tick - 1, 0, 0) : this.rewindTo(p, inp.lerpA, inp.lerpSpan, inp.lerpF);
    if (this.clamped) this.netStats.clampedShots++;
    gunBarrel(v, SEATP, BAR);
    shotDir(p.id, shot, 0, GUN_SHOT[0], BAR[2], BAR[3], DIR);
    const dx = DIR[0], dy = DIR[1], dz = DIR[2], T = this.targets;
    traceShot(this.world, ox, oy, oz, dx, dy, dz, T, this.players.length, RES);
    const tuk = this.rayTuks(v.id, ox, oy, oz, dx, dy, dz, RES.t, false);
    if (tuk >= 0) { RES.t = this.vt; RES.victim = -1; RES.zone = 0; RES.worldHit = true; RES.surf = 1; }
    glassShot(this.glass, ox, oy, oz, dx, dy, dz, RES.t, GC.Shot, p.id);
    this.shotProbe?.(p, inp, 0, evalTick, this.clamped, RES, T);
    const t = RES.t, victim = RES.victim >= 0 ? this.players[RES.victim] : null, zone = RES.zone;
    const ex = ox + dx * t, ey = oy + dy * t, ez = oz + dz * t;
    if (victim && alive(victim) && victim.hp > 0) {
      const hadShield = victim.shield > 0, dealt = this.dealDamage(victim, pelletDamage(w, 0, t, zone), p.id);
      p.damage += dealt;
      const killed = victim.hp <= 0;
      this.ev.hit(p.id, victim.id, killed ? zone : hadShield && victim.shield > 0 ? 2 : zone, dealt, ex, ey, ez, killed, hadShield && victim.shield <= 0);
      this.ev.shot(p.id, KILL_GUN, ox, oy, oz, ex, ey, ez, SURF_PLAYER, true);
      if (killed) { T[victim.id * TARGET_STRIDE + 3] = 0; this.kill(victim, p.id, KILL_GUN); }
      else this.brains[victim.id]?.onHurt(p.id);
    } else {
      if (tuk >= 0) { this.burstTyre(this.vehs.list[tuk], ex, ey, ez); this.hurtTuk(this.vehs.list[tuk], pelletDamage(w, 0, t, 0), p.id, ex, ey, ez); }
      this.ev.shot(p.id, KILL_GUN, ox, oy, oz, ex, ey, ez, RES.worldHit ? RES.surf : 0, RES.worldHit);
    }
  }
  private stepRockets() {
    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const r = this.rockets[i]; const w = WEAPON_DEFS.rocket.projectile!;
      r.vy -= w.gravity * DT; r.life -= DT;
      const nx = r.x + r.vx * DT, ny = r.y + r.vy * DT, nz = r.z + r.vz * DT;
      this.world.raycast(r.x, r.y, r.z, nx - r.x, ny - r.y, nz - r.z, 1, HIT, true);
      glassShot(this.glass, r.x, r.y, r.z, nx - r.x, ny - r.y, nz - r.z, HIT.hit ? HIT.t : 1, GC.Shot, r.owner);
      let boom = HIT.hit || r.life <= 0 || ny < -1;
      let bx = HIT.hit ? HIT.x : nx, by = HIT.hit ? HIT.y : ny, bz = HIT.hit ? HIT.z : nz;
      // a tuk-tuk in the way takes it on the nose (not the one the shooter sits in, while the rocket is still leaving it)
      { const sl = Math.hypot(nx - r.x, ny - r.y, nz - r.z), own = this.players[r.owner];
        if (sl > 1e-6) {
          const ux = (nx - r.x) / sl, uy = (ny - r.y) / sl, uz = (nz - r.z) / sl;
          const tk = this.rayTuks(own.st === PS.Ride && r.life > 5.5 ? own.veh : -1, r.x, r.y, r.z, ux, uy, uz, (HIT.hit ? HIT.t : 1) * sl, true);
          if (tk >= 0) { boom = true; bx = r.x + ux * this.vt; by = r.y + uy * this.vt; bz = r.z + uz * this.vt; this.hurtTuk(this.vehs.list[tk], weaponDamage(WEAPON_DEFS.rocket, r.rarity) * specOf(this.vehs.list[tk].kind).ROCKET_MUL, r.owner, bx, by, bz); }
        } }
      if (!boom) {
        for (const q of this.players) {
          if (!alive(q) || q.id === r.owner || q.st === PS.Plane || q.team === this.players[r.owner].team) continue;
          const t = rayCapsule(r.x, r.y, r.z, nx - r.x, ny - r.y, nz - r.z, q.x, q.y, q.z, q.crouch || q.swim ? 1.3 : PLAYER_H, 1, q.yaw);
          if (t >= 0) { boom = true; bx = r.x + (nx - r.x) * t; by = r.y + (ny - r.y) * t; bz = r.z + (nz - r.z) * t; const own = this.players[r.owner]; const dmg = weaponDamage(WEAPON_DEFS.rocket, r.rarity); const hadShield = q.shield > 0; const d = this.dealDamage(q, dmg, r.owner); own.damage += d; this.ev.hit(r.owner, q.id, 0, d, bx, by, bz, q.hp <= 0, hadShield && q.shield <= 0); if (q.hp <= 0) this.kill(q, r.owner, killWeapon(5, r.rarity)); break; }
        }
      }
      if (boom) {
        this.explode(bx, by, bz, w.splashR, weaponDamage({ dmg: w.splashDmg }, r.rarity), r.owner, killWeapon(5, r.rarity));
        this.ev.rocketEnd(r.id); this.rockets[i] = this.rockets[this.rockets.length - 1]; this.rockets.pop();
      } else { r.x = nx; r.y = ny; r.z = nz; }
    }
  }
  // ---------------------------------------------------------------- banana bombs (shared/sim/bomb.ts)
  /** a throw (stepPlayer counted the bomb out and set p.thrown = the seconds it cooked): the bomb leaves the hand with
   * what is left of its fuse — a bomb cooked to the end goes off in the hand */
  private throwBomb(p: Player, cooked: number) {
    const b = { id: this.nextBombId++ & 0xffff, owner: p.id, fuse: BOMB.fuseS - cooked, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, rest: false };
    bombLaunch(this.world, p.x, eyeY(p), p.z, p.yaw, p.pitch, p.vx, p.vz, b);
    if (b.fuse <= 0.02) { b.x = p.x; b.y = p.y + 1.2; b.z = p.z; }
    this.bombs.push(b); this.ev.bomb(b.id, p.id, b.x, b.y, b.z, b.vx, b.vy, b.vz, b.fuse);
  }
  private stepBombs() {
    for (let i = this.bombs.length - 1; i >= 0; i--) {
      const b = this.bombs[i];
      b.fuse -= DT;
      if (b.fuse > 0) { bombStep(this.world, b, DT); continue; }
      this.bombs[i] = this.bombs[this.bombs.length - 1]; this.bombs.pop();
      this.ev.bombEnd(b.id);
      this.explode(b.x, b.y + 0.15, b.z, BOMB.radius, BOMB.dmg, this.players[b.owner] ? b.owner : -1, KILL_BOMB, false, BOMB.core, BOMB.floor);
    }
  }
  // ---------------------------------------------------------------- crate walls (shared/sim/cover.ts)
  /** stepPlayer set one down (PLACED holds where): the kong's oldest wall crumbles past COVER.perKong, then the island's */
  private placeCover(p: Player) {
    const mine = this.covers.list.filter((w) => w.live && !w.perm && w.owner === p.id).sort((a, b) => a.born - b.born);
    while (mine.length >= COVER.perKong) { const w = mine.shift()!; this.covers.remove(w.id); this.ev.coverEnd(w.id, 0); }
    if (this.covers.n >= COVER.max) { const w = this.covers.list.filter((q) => q.live && !q.perm).sort((a, b) => a.born - b.born)[0]; if (w) { this.covers.remove(w.id); this.ev.coverEnd(w.id, 0); } }
    // (what the wire carries: f32 position, u16 yaw — the clients predict against exactly these numbers)
    const yaw = yawDec(yawEnc(PLACED[3])), w = this.covers.add(this.nextCoverId++ & 0xffff, p.id, Math.fround(PLACED[0]), Math.fround(PLACED[1]), Math.fround(PLACED[2]), yaw, COVER.hp, this.phase === Phase.Warmup ? this.phaseT : this.time);
    this.ev.cover(w.id, p.id, w.x, w.y, w.z, w.yaw, w.hp);
  }
  private hurtCover(id: number, dmg: number) {
    const w = this.covers.byId(id); if (!w || dmg <= 0 || w.perm) return;
    w.hp -= dmg;
    if (w.hp <= 0) { this.covers.remove(id); this.ev.coverEnd(id, 1); } else this.ev.coverHit(id, w.hp);
  }
  private stepCovers() {
    if (this.covers.n === 0) return;
    const now = this.phase === Phase.Warmup ? this.phaseT : this.time;
    for (const w of this.covers.list) if (w.live && !w.perm && (now - w.born > COVER.lifeS || now < w.born)) { this.covers.remove(w.id); this.ev.coverEnd(w.id, 0); }
  }
  /** a kong killed with a pulled bomb drops it, still burning, where it fell */
  private dropCookedBomb(v: Player) {
    if (v.cookT <= 0) return;
    const k = bombSlot(v), cooked = v.cookT; v.cookT = 0;
    if (k < 0) return;
    const s = v.slots[k]; s.count--; if (s.count <= 0) { s.kind = SK.Empty; s.id = 0; s.count = 0; s.rarity = 0; }
    const b = { id: this.nextBombId++ & 0xffff, owner: v.id, fuse: Math.max(0.05, BOMB.fuseS - cooked), x: v.x, y: v.y + 1.0, z: v.z, vx: 0, vy: 1, vz: 0, rest: false };
    this.bombs.push(b); this.ev.bomb(b.id, v.id, b.x, b.y, b.z, b.vx, b.vy, b.vz, b.fuse);
  }
  /** a punch at the pane under the crosshair within arm's reach (shared/sim/glass.ts glassPunch) */
  private punchGlass(p: Player): boolean {
    const cp = Math.cos(p.pitch);
    return glassPunch(this.glass, p.x, eyeY(p), p.z, -Math.sin(p.yaw) * cp, Math.sin(p.pitch), -Math.cos(p.yaw) * cp, p.id) > 0;
  }
  /** publish this tick's breaks (EV.Glass, ≤ the frame's event budget; the rest go next tick) */
  private flushGlass() {
    const g = this.glass; if (g.freshN === 0) return;
    const n = Math.min(g.freshN, Math.max(0, 240 - this.ev.n)), F = g.fresh;
    for (let i = 0; i < n; i++) this.ev.glass(F[i * 3], F[i * 3 + 1], F[i * 3 + 2]);
    if (n < g.freshN) F.copyWithin(0, n * 3, g.freshN * 3);
    g.freshN -= n;
  }
  /** `all`: a blast that spares nobody (a tuk-tuk going up) — squadmates take it, and whoever set it off takes it in full */
  /** `core` / `floor`: kongs inside `core` m take it all, then it falls off to `floor` × at the edge (a rocket: no core,
   * 35 % at the rim of its small splash; a tuk-tuk's big blast: everything beside it, a scorching at 10 m) */
  private explode(x: number, y: number, z: number, radius: number, dmg: number, by: number, weapon = 5, all = false, core = 0, floor = 0.35) {
    this.ev.explosion(x, y, z, radius);
    glassBlast(this.glass, x, y, z, radius * 0.9, by);
    const team = by >= 0 ? this.players[by].team : -1;
    // crate walls in the blast (explosives are how you crack cover open)
    if (this.covers.n > 0) for (const w of this.covers.list) {
      if (!w.live || w.perm) continue;
      const d = Math.hypot(w.x - x, w.y + COVER.h / 2 - y, w.z - z);
      if (d <= radius + 1.3) this.hurtCover(w.id, dmg * COVER.blastMul * (0.4 + 0.6 * Math.max(0, 1 - Math.max(0, d - 1.3) / radius)));
    }
    // tuk-tuks in the blast (a parked row of them goes up one after the other)
    for (const v of this.vehs.list) {
      if (!v.live || (v.st !== VS.Ok && v.st !== VS.Tipped && v.st !== VS.Righting)) continue;
      const d = Math.hypot(v.x - x, v.y + 0.9 - y, v.z - z);
      if (d <= radius + 1.6) this.hurtTuk(v, dmg * (0.35 + 0.65 * (1 - Math.max(0, d - 1.6) / radius)) * specOf(v.kind).SPLASH_MUL, by, v.x, v.y + 0.9, v.z);
    }
    for (const q of this.players) {
      if (!alive(q) || q.st === PS.Plane) continue;
      if (!all && q.team === team && q.id !== by) continue;   // no friendly fire (self-splash still 0.5)
      const cx = q.x, cy = q.y + PLAYER_H * 0.5, cz = q.z;
      const d = Math.hypot(cx - x, cy - y, cz - z);
      if (d > radius + PLAYER_R) continue;
      // line of sight from just above the blast point: a rocket that bursts ON the ground (the usual splash shot at the
      // feet) must not have its own impact surface block the blast (or rockets fired at the feet do no splash at all)
      if (!this.world.clear(x, y + 0.35, z, cx, cy, cz)) continue;
      const f = 1 - Math.max(0, d - PLAYER_R - core) / (radius - core);
      const hadShield = q.shield > 0;
      const dealt = this.dealDamage(q, dmg * (floor + (1 - floor) * f) * (!all && q.id === by ? 0.5 : 1), by);
      if (by >= 0 && by !== q.id && this.players[by].team !== q.team) this.players[by].damage += dealt;
      this.ev.hit(by, q.id, 0, dealt, cx, cy, cz, q.hp <= 0, hadShield && q.shield <= 0);
      if (q.hp <= 0) this.kill(q, by, weapon);
      this.brains[q.id]?.onHurt(by);
    }
  }

  // ---------------------------------------------------------------- tuk-tuks (shared/sim/vehicle.ts)
  /** a new phase: the old fleet is gone, a vehicle of each spot's kind parks on it */
  private spawnTuks(spots: ReadonlyArray<TukSpot>) {
    this.vehs.reset(); this.tukHome = spots;
    for (const v of this.vehs.list) v.touch = this.tick;
    spots.forEach((s, i) => { const v = this.vehs.free(); if (!v) return; spawnVehicle(v, this.world, s.x, s.z, s.yaw, s.kind ?? VKind.Tuk); v.home = i; });
  }
  /** E: climb into the tuk-tuk under the crosshair (`aimed`) / beside you, or heave one that lies on its side upright */
  private useVehicle(p: Player, aimed: boolean): boolean {
    if (p.st !== PS.Ground || p.swim) return false;
    const cp = Math.cos(p.pitch);
    const id = vehicleInReach(this.vehs, p.x, p.y, p.z, eyeY(p), -Math.sin(p.yaw) * cp, Math.sin(p.pitch), -Math.cos(p.yaw) * cp, aimed, !p.grounded);
    if (id < 0) return false;
    const v = this.vehs.list[id];
    // a bot's E is for chests: it climbs only onto the squadmate's tuk-tuk its brain picked, and heaves none upright
    if (p.bot && (v.st !== VS.Ok || this.brains[p.id]?.boardVeh !== id)) return false;
    if (v.st === VS.Tipped) {
      if (!flipVehicle(v)) return false;
      v.flags |= VF.AWAKE; v.idleT = 0; v.touch = this.tick; this.ev.veh(v.id, VK.Flip, p.id, v.x, v.y + 0.8, v.z);
      return true;
    }
    const seat = freeSeat(v, p.team, (i) => this.players[i]?.team ?? -1);
    if (seat < 0) return false;
    enterVehicle(p, v, seat); v.touch = this.tick;
    p.reloadT = 0; p.useT = 0; p.ads = false;
    this.ev.veh(v.id, VK.Enter, p.id, v.x, v.y + 0.8, v.z);
    return true;
  }
  /** a passenger's seat on its tuk-tuk as its client drew it for this input (bots look at the live one) */
  private seatRewound(p: Player, inp: Input) {
    const v = this.vehs.list[p.veh]; if (!v || !v.live) return;
    if (p.bot) this.viewBlend(this.tick - 1, 0, 0); else this.viewBlend(inp.lerpA, inp.lerpSpan, inp.lerpF);
    const h = v.hist;
    seatRiderAt(p, v.kind, blendVeh(h, vslot(this.vA), h, vslot(this.vB), this.vF, SEATP));
  }
  /** the nearest tuk-tuk panel on a ray (unit dir) within `maxT`: as the shooter SAW them (the last viewBlend — the
   * rewind of a hitscan shot), or `now` as they stand (rockets). Returns its id (the distance in `vt`, the tyre it met
   * in `vTyre`: −1 = a panel) or −1. */
  private vt = 0;
  private vTyre = -1;
  private rayTuks(skip: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number, now: boolean): number {
    let best = -1; this.vt = maxT;
    const ia = vslot(this.vA), ib = vslot(this.vB);
    for (const v of this.vehs.list) {
      if (!v.live || v.id === skip || v.st === VS.Gone || v.st === VS.Sunk) continue;
      // cheap reject on where it stands now (it cannot have gone 8 m inside the rewind window)
      const wx = v.x - ox, wy = v.y + 1 - oy, wz = v.z - oz, along = wx * dx + wy * dy + wz * dz;
      if (along < -10.5 || along > this.vt + 10.5 || wx * wx + wy * wy + wz * wz - along * along > 110) continue;
      if (now) vehPose(v, VP);
      else { const h = v.hist; if (h[ia + 6] < 0 || h[ib + 6] < 0) continue; blendVeh(h, ia, h, ib, this.vF, VP); }
      const t = rayVehicle(VP, v.kind, ox, oy, oz, dx, dy, dz, this.vt);
      if (t >= 0 && t < this.vt) { this.vt = t; this.vTyre = RAY_TYRE; best = v.id; }
    }
    return best;
  }
  /** a bullet the last rayTuks stopped: if it met a tyre, that tyre is flat for the rest of this tuk-tuk's life */
  private burstTyre(v: Vehicle, x: number, y: number, z: number) {
    const k = this.vTyre;
    if (k < 0 || v.tyres & (1 << k) || (v.st !== VS.Ok && v.st !== VS.Tipped && v.st !== VS.Righting)) return;
    v.tyres |= 1 << k; v.flags |= VF.AWAKE; v.idleT = 0; v.touch = this.tick;
    this.ev.veh(v.id, VK.Tyre, k, x, y, z);
  }
  /** damage on a tuk-tuk (a bullet, a blast, a wall, a roll). by ≥ 0 = whose doing: the blast it ends in is theirs. */
  private hurtTuk(v: Vehicle, dmg: number, by: number, x: number, y: number, z: number) {
    if (dmg <= 0 || (v.st !== VS.Ok && v.st !== VS.Tipped && v.st !== VS.Righting)) return;
    // practice bots hit a tuk-tuk with a human aboard as softly as they hit the human
    if (by >= 0 && this.players[by].bot && v.seats.some((id) => id >= 0 && !this.players[id].bot)) dmg *= this.botDamageToHumans;
    v.hp = Math.max(0, v.hp - dmg); v.flags |= VF.AWAKE; v.idleT = 0;
    if (by >= 0) { v.lastBy = by; this.ev.vehHit(by, v.id, dmg, x, y, z); }
  }
  private ejectAll(v: Vehicle, thrown: boolean) {
    for (let k = 0; k < 3; k++) {
      const id = v.seats[k]; if (id < 0) continue;
      const q = this.players[id]; v.seats[k] = -1;
      if (q && q.st === PS.Ride && q.veh === v.id) { q.seat = k; exitVehicle(q, v, this.world, thrown); }
    }
  }
  /** what the deterministic step reported this tick: the damage it does, the kongs it throws out, the events it sends */
  private tukEvents(v: Vehicle) {
    const e = v.evt, x = v.x, y = v.y + 0.8, z = v.z, hit = Math.min(255, v.crashV * 12);
    v.evt = 0; v.touch = this.tick;
    if (v.kind === VKind.Heli) {
      // a helicopter: a hard touchdown or a wall dents it; rolled over, flown into something or down on fire = the end
      if (e & VE.LAND && !(e & VE.TIP)) { this.hurtTuk(v, (v.crashV - HELI.LAND_V) * HELI.LAND_DMG, -1, x, y, z); this.ev.veh(v.id, VK.Land, hit, x, y, z); }
      if (e & VE.CRASH) { this.hurtTuk(v, (v.crashV - HELI.CRASH_V) * HELI.CRASH_DMG, -1, x, y, z); this.ev.veh(v.id, VK.Crash, hit, x, y, z); }
      if (e & VE.SLAM) this.ev.veh(v.id, VK.Slam, 0, x, y, z);
      if (e & VE.SUNK) { this.ejectAll(v, false); v.wreckT = 0; v.fuse = -1; v.flags &= ~(VF.BURN | VF.HORN); this.ev.veh(v.id, VK.Sunk, 0, x, y, z); }
      else if (e & VE.TIP) { this.ev.veh(v.id, VK.Tip, hit, x, y, z); this.blowTuk(v); }
      v.crashV = 0; v.rolls = 0;
      return;
    }
    if (e & VE.TIP) { this.ejectAll(v, true); this.hurtTuk(v, TUK.TIP_DMG, -1, x, y, z); this.ev.veh(v.id, VK.Tip, 0, x, y, z); }
    if (e & VE.ROLL) { this.hurtTuk(v, TUK.ROLL_DMG * Math.max(1, v.rolls), -1, x, y, z); this.ev.veh(v.id, VK.Crash, 110, x, y, z); }
    if (e & VE.CRASH) { this.hurtTuk(v, (v.crashV - TUK.CRASH_V) * TUK.CRASH_DMG, -1, x, y, z); this.ev.veh(v.id, VK.Crash, hit, x, y, z); }
    if (e & VE.LAND) { this.hurtTuk(v, (v.crashV - TUK.LAND_V) * TUK.LAND_DMG, -1, x, y, z); this.ev.veh(v.id, VK.Land, hit, x, y, z); }
    if (e & VE.SLAM) this.ev.veh(v.id, VK.Slam, 0, x, y, z);
    if (e & VE.SUNK) { this.ejectAll(v, false); v.wreckT = 0; v.fuse = -1; v.flags &= ~(VF.BURN | VF.HORN); this.ev.veh(v.id, VK.Sunk, 0, x, y, z); }
    v.crashV = 0; v.rolls = 0;
  }
  /** the bang: everybody aboard is thrown out INTO it, the blast spares nobody near, a burning wreck stays behind */
  private blowTuk(v: Vehicle) {
    const SP = specOf(v.kind), heli = v.kind === VKind.Heli, x = v.x, y = v.y + (heli ? 1.4 : 0.9), z = v.z;
    this.ejectAll(v, true);
    v.st = VS.Wreck; v.wreckT = 0; v.fuse = -1; v.hp = 0; v.tipV = 0; v.steer = 0; v.touch = this.tick;
    if (!heli || !v.air) { v.vx = v.vy = v.vz = 0; }   // (a helicopter that blows in the air keeps falling — heli.ts fall)
    v.flags = (v.flags | VF.BURN | VF.AWAKE) & ~(VF.HORN | VF.SKID | VF.BRAKE | VF.REV);
    this.ev.veh(v.id, VK.Boom, 0, x, y, z);
    this.explode(x, y, z, SP.BLAST_R, SP.BLAST_DMG, v.lastBy, heli ? KILL_HELI : KILL_TUK, true, SP.BLAST_CORE, SP.BLAST_RIM);
  }
  /** a moving tuk-tuk runs kongs on foot over: sent flying, hurt by how fast it closed on them (squadmates only shoved) */
  private ramKongs(v: Vehicle) {
    const SP = specOf(v.kind), heli = v.kind === VKind.Heli, cause = heli ? KILL_HELI : KILL_TUK;
    const drv = v.seats[0] >= 0 ? this.players[v.seats[0]] : null;
    for (const q of this.players) {
      if (!alive(q) || q.st === PS.Ride || q.st === PS.Plane || q.st === PS.Freefall || q.st === PS.Glide) continue;
      const dx = q.x - v.x, dz = q.z - v.z;
      // a helicopter's rotor: the pilot's weapon — the blade disc as it
      // tilts, or the tail fan, kills a kong it touches: a dip of the nose or a strafing run low over one, a kong up on
      // something (heli.ts inRotor; a crouching kong is shorter). Credited to the pilot; never the pilot's own squad (no
      // friendly fire), and with nobody at the stick it cuts nobody (a pilot who just stepped out, an empty one falling)
      if (heli && drv !== null && q.team !== drv.team && this.tick - v.ramT[q.id] >= 30 && inRotor(v, q.x, q.y, q.z, height(q))) {
        v.ramT[q.id] = this.tick;
        const by = drv.id, hadShield = q.shield > 0, dealt = this.dealDamage(q, HELI.ROTOR_DMG, by);
        drv.damage += dealt;
        q.vx += (dx / (Math.hypot(dx, dz) || 1)) * 6; q.vz += (dz / (Math.hypot(dx, dz) || 1)) * 6; q.vy = 3; q.grounded = false;
        this.ev.hit(by, q.id, 0, dealt, q.x, q.y + 1.7, q.z, q.hp <= 0, hadShield && q.shield <= 0);
        this.ev.veh(v.id, VK.Chop, q.id, q.x, q.y + 1.4, q.z);
        if (q.hp <= 0) this.kill(q, by, cause); else this.brains[q.id]?.onHurt(by);
        continue;
      }
      if (dx * dx + dz * dz > (heli ? 24 : 12) || q.y > v.y + SP.ROOF - 0.3 || q.y + PLAYER_H < v.y) continue;
      if (footDist(v, q.x, q.z) > PLAYER_R + 0.12) continue;
      const d = Math.hypot(dx, dz) || 1, nx = dx / d, nz = dz / d;
      // (what a tuk-tuk's panels already pushed aside this tick counts too — pushKong matched the kong's speed to
      // it. Not a helicopter's: it rams whenever its rotor turns, so a kong running into a landed one would "be run over")
      const close = Math.max((v.vx - q.vx) * nx + (v.vz - q.vz) * nz, heli ? 0 : v.bump[q.id & 63]);
      if (close < SP.RAM_V || this.tick - v.ramT[q.id] < 45) continue;
      v.ramT[q.id] = this.tick;
      q.vx = v.vx * 1.05 + nx * 2; q.vz = v.vz * 1.05 + nz * 2; q.vy = 5.5; q.grounded = false; q.coyote = 0; q.mvT = 0;
      if (q.st === PS.Mantle || q.st === PS.Zip || q.st === PS.Climb) { q.st = PS.Ground; q.crouch = false; q.mvY = 0; }
      if (drv !== null && drv.team === q.team) continue;
      const by = drv ? drv.id : -1, hadShield = q.shield > 0;
      // a tuk-tuk at real speed with somebody at the bars is a kill (through any shield); slower it shoves and
      // hurts — a helicopter's body always hurts by how fast it closed (its rotor is the killer, above)
      const lethal = !heli && drv !== null && close >= TUK.RAM_KILL_V;
      const dealt = this.dealDamage(q, lethal ? 1000 : (close - SP.RAM_V) * SP.RAM_DMG, by);
      if (drv) drv.damage += dealt;
      this.ev.hit(by, q.id, 0, dealt, q.x, q.y + 1, q.z, q.hp <= 0, hadShield && q.shield <= 0);
      if (q.hp <= 0) this.kill(q, by, cause); else this.brains[q.id]?.onHurt(by);
    }
  }
  private stepVehicles() {
    for (const v of this.vehs.list) {
      if (!v.live || v.st === VS.Gone) continue;
      // nobody at the bars: it coasts, or holds on its parking brake (a driver steps it once per input, in stepPlayer —
      // a driver whose link is silent leaves it standing, like its own kong)
      const drv = v.seats[0], heli = v.kind === VKind.Heli;
      if ((drv < 0 || this.players[drv].st !== PS.Ride) && (v.flags & VF.AWAKE)) {
        if (heli) stepHeli(v, this.world, 0, 0, false, false, v.yaw, false, DT); else stepVehicle(v, this.world, 0, 0, (v.flags & VF.PARK) !== 0, DT);
        v.flags &= ~VF.HORN;
      }
      if (v.evt) this.tukEvents(v);
      if (v.st === VS.Wreck || v.st === VS.Sunk) {
        // a wreck burns out and is cleared away; on the islet and the range a fresh one is brought round
        // (a helicopter's wreck still in the air keeps falling first — heli.ts fall)
        if (heli && v.air && v.st === VS.Wreck) { stepHeli(v, this.world, 0, 0, false, false, v.yaw, false, DT); if (v.evt) { v.evt = 0; this.ev.veh(v.id, VK.Slam, 0, v.x, v.y + 0.8, v.z); } v.touch = this.tick; continue; }
        v.wreckT += DT;
        const play = this.range || this.phase === Phase.Warmup, h = this.tukHome[v.home];
        if (v.wreckT > 12) v.flags &= ~VF.BURN;
        const life = play ? 6 : v.st === VS.Sunk ? 8 : specOf(v.kind).WRECK_S;
        // a burnt-out wreck's last WRECK_SINK s: it settles into the ground, faster and faster,
        // instead of vanishing where it lay
        if (!play && v.st === VS.Wreck && v.wreckT > life - WRECK_SINK) { v.y -= (2 * WRECK_SINK_D[heli ? 1 : 0] / WRECK_SINK) * Math.min(1, (v.wreckT - life + WRECK_SINK) / WRECK_SINK) * DT; v.flags |= VF.AWAKE; }
        if (v.wreckT > life) { v.touch = this.tick; if (play && h) { spawnVehicle(v, this.world, h.x, h.z, h.yaw, h.kind ?? VKind.Tuk); v.flags |= VF.AWAKE; } else { v.st = VS.Gone; v.flags = 0; } }
        continue;
      }
      // out of health: the engine catches fire, the horn sticks — and then it goes up
      if (v.hp <= 0 && v.fuse < 0) { v.fuse = specOf(v.kind).FUSE_S; v.flags |= VF.BURN | VF.AWAKE; v.touch = this.tick; this.ev.veh(v.id, VK.Burn, 0, v.x, v.y + 1, v.z); }
      if (v.fuse >= 0) { v.fuse -= DT; if (v.fuse <= 0) { this.blowTuk(v); continue; } }
      // riders sit where it is NOW (this tick's snapshot + history); a seat whose kong has gone is free again
      let riders = 0;
      for (let k = 0; k < 3; k++) {
        const id = v.seats[k]; if (id < 0) continue;
        const q = this.players[id];
        if (!q || q.st !== PS.Ride || q.veh !== v.id || q.seat !== k) { v.seats[k] = -1; v.touch = this.tick; continue; }
        seatRider(q, v); q.grounded = true; riders++;
      }
      // a helicopter's door gun with nobody behind it spins down, cools and swings back to rest (a gunner's own inputs
      // step it — stepRide → heli.ts stepGun — like the pilot's step the helicopter)
      if (heli && v.st === VS.Ok && v.seats[HELI.GUN_SEAT] < 0) stepGunIdle(v, DT);
      if (v.st === VS.Ok && (Math.hypot(v.vx, v.vz) >= specOf(v.kind).RAM_V || (heli && v.steer >= 0.4))) this.ramKongs(v);
      v.bump.fill(0);
      // a second of nothing: it sleeps, its pose snapped onto the wire's grid (every client's copy is then exact)
      const still = riders === 0 && v.vx === 0 && v.vz === 0 && Math.abs(v.vy) < 1e-3 && !v.air && v.tipV === 0 && v.st !== VS.Righting && v.fuse < 0 && (!heli || (v.steer === 0 && v.tip === 0 && v.gunSpin === 0 && v.gunHeat === 0));
      if (!still) { v.idleT = 0; v.flags |= VF.AWAKE; }
      else if ((v.flags & VF.AWAKE) && (v.idleT += DT) > 1) { restVehicle(v); v.flags = (v.flags & ~VF.AWAKE) | VF.PARK; }
    }
  }

  // ---------------------------------------------------------------- deaths / resurgence / results
  private kill(v: Player, by: number, weapon: number) {
    if (!alive(v)) return;
    // (a kong that dies in a tuk-tuk leaves its seat: with nobody at the bars it rolls on by itself)
    if (v.st === PS.Ride) { const t = this.vehs.list[v.veh]; if (t && t.seats[v.seat] === v.id) t.seats[v.seat] = -1; }
    v.veh = -1;
    this.dropCookedBomb(v);
    v.st = PS.Dead; v.hp = 0; v.vx = v.vy = v.vz = 0; v.grounded = false; /* (the body drops to the floor — stepCorpse) */ v.deadAt = this.phase === Phase.Warmup ? this.phaseT : this.time; v.killer = by; v.scoped = false;
    if (by >= 0 && by !== v.id) { const k = this.players[by]; if (k.team !== v.team) k.kills++; }
    if (this.range) { v.respawnAt = this.phaseT + (v.bot ? TARGET_RESPAWN_S : SHOOTER_RESPAWN_S); this.ev.kill(by, v.id, weapon, false); return; }
    if (this.phase === Phase.Warmup) { v.respawnAt = this.phaseT + 3; this.ev.kill(by, v.id, weapon, false); return; }
    // Snapshot the full inventory once. Bounded publication avoids the u8 event-frame limit during mass deaths.
    for (const s of v.slots) {
      if (s.kind !== SK.Empty) this.deathLoot.push({ kind: s.kind === SK.Weapon ? IK.Weapon : IK.Consumable, sub: s.id, rarity: s.rarity, count: s.kind === SK.Weapon ? 1 : s.count, loaded: s.kind === SK.Weapon ? s.mag : undefined, x: v.x, y: v.y, z: v.z, owner: v.id });
      s.kind = SK.Empty; s.count = 0; s.mag = 0;
    }
    for (let a = 0; a < v.ammo.length; a++) {
      for (let remaining = v.ammo[a]; remaining > 0;) { const count = Math.min(255, remaining); remaining -= count; this.deathLoot.push({ kind: IK.Ammo, sub: a, rarity: 0, count, x: v.x, y: v.y, z: v.z, owner: v.id }); }
      v.ammo[a] = 0;
    }
    // the wallet spills too, with the kong tax on top; a bounty hunter that got its mark is paid
    if (this.econ) { for (const n of cashStacks(v.cash + ECON.killTax, CASH)) this.deathLoot.push({ kind: IK.Cash, sub: 0, rarity: 0, count: n, x: v.x, y: v.y, z: v.z, owner: v.id }); v.cash = 0; this.econ.onKill(v, by); }
    this.onInventory(v.id);
    // RESURGENCE (from the moment people leave the plane until it is switched off): solo always redeploys; trios
    // redeploy only while a squadmate is still ALIVE — a squad wipe is final for everyone waiting.
    const live = this.phase === Phase.Play || this.phase === Phase.Plane;
    const mateAlive = this.players.some((q) => q !== v && q.team === v.team && alive(q));
    const canRes = this.resurgenceOn && live && (this.mode === "solo" ? v.redeploys < SOLO_REDEPLOYS : mateAlive);
    if (canRes) { v.respawnAt = this.time + resurgenceDelay(this.mode, this.storm.phase); this.ev.kill(by, v.id, weapon, false); return; }
    v.respawnAt = -1; this.ev.kill(by, v.id, weapon, true);
    if (!mateAlive) for (const q of this.players) if (q !== v && q.team === v.team && q.st === PS.Dead && q.respawnAt >= 0) { q.respawnAt = -1; q.eliminated = true; }
    this.eliminate(v);
  }
  private eliminate(v: Player) {
    v.eliminated = true; v.respawnAt = -1;
    // squad eliminated?
    const squadAlive = this.players.some((q) => q.team === v.team && (alive(q) || q.respawnAt >= 0));
    if (!squadAlive && !this.teamsOut.has(v.team)) {
      this.teamsOut.add(v.team);
      this.teamOutcomeTimes.set(v.team, this.time);
      const left = this.squadsLeft();
      for (const q of this.players) if (q.team === v.team) { q.eliminated = true; if (q.placement === 0) q.placement = left + 1; }
      this.ev.announce(ANN.SquadEliminated, v.team & 0xff, Math.min(255, left));
    }
    // spectate a squadmate or the killer (a squadmate already watching someone keeps watching: when
    // that was `v`, stepSpectate moves the camera on after SPECTATE_HOLD_S, like any watched kong going down)
    for (const q of this.players) if (q.team === v.team && q.st === PS.Dead && q.respawnAt < 0 && (q === v || q.spectate < 0)) {
      const mate = this.players.find((m) => m.team === v.team && alive(m));
      q.spectate = mate ? mate.id : v.killer >= 0 && alive(this.players[v.killer]) ? v.killer : this.anyAliveId();
    }
  }
  private anyAliveId(): number { for (const q of this.players) if (alive(q) && q.st !== PS.Plane) return q.id; return -1; }
  // ---- spectating: an eliminated player picks who to watch (INV.Spectate); a watched player who
  // dies hands the camera on after SPECTATE_HOLD_S (their killer if alive, else a squadmate, else whoever is nearest).
  // The snapshot's interest management centres on the watched player (host.ts writeSnapshotFor), so the server must
  // know who that is. While a squadmate of yours is still alive only your squad can be watched (no ghosting for them).
  /** may `p` (eliminated) watch `t` right now */
  canSpectate(p: Player, t: Player | undefined): boolean {
    if (!t || t === p || !alive(t) || t.st === PS.Plane) return false;
    if (!SPECTATE_SQUAD_ONLY || t.team === p.team) return true;
    return !this.players.some((q) => q !== p && q.team === p.team && alive(q));
  }
  /** INV.Spectate: watch player `target` (ignored unless `p` is out for good and may watch them) */
  spectateOp(p: Player, target: number) {
    if (p.st !== PS.Dead || p.respawnAt >= 0 || !this.canSpectate(p, this.players[target]) || p.spectate === target) return;
    p.spectate = target; this.onInventory(p.id);
  }
  private stepSpectate() {
    for (const p of this.players) {
      if (p.bot || p.st !== PS.Dead || p.respawnAt >= 0 || !p.eliminated) continue;
      const t = p.spectate >= 0 ? this.players[p.spectate] : undefined;
      if (t && this.canSpectate(p, t)) continue;
      // the watched kong just fell: a beat on the knock-down (the kill feed names the killer), then on to the next
      if (t && !alive(t) && this.time - t.deadAt < SPECTATE_HOLD_S) continue;
      const next = this.pickSpectate(p, t);
      if (next !== p.spectate) { p.spectate = next; this.onInventory(p.id); }
    }
  }
  /** who `p` watches next after `from` (the one that went down / became unwatchable): the killer, a squadmate, the
   * nearest living kong to where `from` was — or -1 when nobody is left */
  private pickSpectate(p: Player, from: Player | undefined): number {
    if (from && !alive(from) && from.killer >= 0 && this.canSpectate(p, this.players[from.killer])) return from.killer;
    const mate = this.players.find((q) => q.team === p.team && this.canSpectate(p, q)); if (mate) return mate.id;
    const ox = from ? from.x : p.x, oz = from ? from.z : p.z;
    let best = -1, bd = Infinity;
    for (const q of this.players) { if (!this.canSpectate(p, q)) continue; const d = (q.x - ox) ** 2 + (q.z - oz) ** 2; if (d < bd) { bd = d; best = q.id; } }
    return best;
  }
  squadsLeft(): number { const s = new Set<number>(); for (const q of this.players) if (this.phase === Phase.Warmup || alive(q) || q.respawnAt >= 0) s.add(q.team); return s.size; }
  /** warm-up deaths do not count (everyone respawns in 3 s): the HUD's alive counter stays at the full field until the plane */
  aliveCount(): number { if (this.phase === Phase.Warmup) return this.players.length; let n = 0; for (const q of this.players) if (alive(q)) n++; return n; }
  private stepRespawns() {
    if (this.phase !== Phase.Play && this.phase !== Phase.Plane) return;
    for (const p of this.players) {
      if (p.st !== PS.Dead || p.respawnAt < 0 || this.time < p.respawnAt) continue;
      const mate = this.players.find((q) => q.team === p.team && alive(q) && q.st === PS.Ground);
      let x: number, z: number;
      if (mate) { const a = this.rng.next() * Math.PI * 2; x = mate.x + Math.cos(a) * 70; z = mate.z + Math.sin(a) * 70; }
      else { const a = this.rng.next() * Math.PI * 2, d = Math.sqrt(this.rng.next()) * this.storm.r * 0.6; x = this.storm.cx + Math.cos(a) * d; z = this.storm.cz + Math.sin(a) * d; }
      // back into the fight from the sky: a short freefall (dive to speed it up), the glider pops at 95 m AGL
      const kills = p.kills, dmg = p.damage, used = p.redeploys;   // match stats survive a redeploy
      resetForMatch(p); p.kills = kills; p.damage = dmg; p.redeploys = used + 1;
      p.x = x; p.z = z; p.y = Math.max(this.world.ground(x, z), 0) + REDEPLOY_ALT; p.st = PS.Freefall; p.vy = -18; p.hp = MAX_HP; p.shield = 0;
      // redeploy kit: a random common primary in hand (SMG / AR / shotgun) + the pistol as a sidearm, some ammo for both
      const prim = 1 + this.rng.int(3), pw = WEAPON_DEFS[WEAPONS[prim]];
      const s0 = p.slots[0]; s0.kind = SK.Weapon; s0.id = prim; s0.rarity = 0; s0.mag = pw.mag; s0.count = 1;
      const s1 = p.slots[1]; s1.kind = SK.Weapon; s1.id = 0; s1.rarity = 0; s1.mag = WEAPON_DEFS.pistol.mag; s1.count = 1;
      p.ammo[0] = START_PISTOL_AMMO; giveAmmo(p, pw.ammo, Math.round(AMMO_PICKUP[pw.ammo] * 1.5)); p.active = 0;
      this.brains[p.id]?.onRespawn(this, p);
      this.ev.respawn(p.id, p.x, p.y, p.z); this.onInventory(p.id);
    }
  }
  private checkEnd() {
    const left = this.squadsLeft();
    if (left <= 1 && this.time > 5) {
      const w = this.players.find((q) => alive(q) || q.respawnAt >= 0);
      this.enterResults(w ? w.team : -1);
    }
  }

  // ---------------------------------------------------------------- loot
  private spawnItem(kind: IK, sub: number, rarity: number, count: number, x: number, y: number, z: number, scatter: number, avoid: number) {
    const a = this.rng.next() * Math.PI * 2, d = scatter * (0.5 + this.rng.next() * 0.5);
    // tossed on this side of any wall, then it falls to the floor below (a kong shot off its glider drops
    // its loot on the ground under it, not in the sky)
    const y0 = Math.max(y, this.world.ground(x, z));
    tossClear(this.world, x, y0 + 0.6, z, x + Math.cos(a) * d, z + Math.sin(a) * d, LP);
    settleLoot(this.world, LP[0], y0, LP[2], LP);
    const it: Item = { id: this.nextItemId++ & 0xffff, kind, sub, rarity, count, x: LP[0], y: LP[1], z: LP[2], taken: false, bornAt: this.time, dropper: avoid };
    this.items.push(it); this.ev.spawnItem(it.id, kind, sub, rarity, count, it.x, it.y, it.z);
    return it;
  }
  /** chest loot spills in a fan toward the opener: clear of the box (≥ SPILL_R) and ≥ SPILL_GAP apart, so every item can
   * be singled out. Walls can push an item back while it settles, so a spot that lands too close to the chest or to
   * another item is retried a little further out / further round the fan. */
  private spillChest(c: Chest, p: Player, contents: Array<{ kind: IK; sub: number; rarity: number; count: number }>) {
    const SPILL_R = 1.7, SPILL_GAP = 1.2, n = contents.length;
    const face = Math.hypot(p.x - c.x, p.z - c.z) > 0.3 ? Math.atan2(p.z - c.z, p.x - c.x) : c.yaw;
    const step = SPILL_GAP / SPILL_R * 1.08;                     // arc spacing slightly over the minimum gap
    const placed: Item[] = [];
    for (let k = 0; k < n; k++) {
      const { kind, sub, rarity, count } = contents[k];
      const base = face + (k - (n - 1) / 2) * step;
      let it: Item | null = null;
      // each try lands ON the floor (settleLoot); one on the chest's own floor beats one that fell off its
      // deck / roof edge (kept only when no try stays up), and the SPILL_R / SPILL_GAP spread rule
      let fb: Item | null = null, fbScore = Infinity;
      for (let t = 0; t < 6; t++) {
        const a = base + (this.rng.next() - 0.5) * 0.12 + (t ? (t % 2 ? 1 : -1) * Math.ceil(t / 2) * 0.35 : 0);
        const r = SPILL_R + (this.rng.next() * 0.2) + t * 0.15;
        tossClear(this.world, c.x, c.y + 0.6, c.z, c.x + Math.cos(a) * r, c.z + Math.sin(a) * r, LP);
        settleLoot(this.world, LP[0], c.y, LP[2], LP);
        const ix = LP[0], iy = LP[1], iz = LP[2];
        const level = Math.abs(iy - c.y) < 0.6;
        const ok = level && Math.hypot(ix - c.x, iz - c.z) >= SPILL_R * 0.75 && placed.every((o) => Math.hypot(o.x - ix, o.z - iz) >= SPILL_GAP * 0.85);
        const make = (): Item => ({ id: 0, kind, sub, rarity, count, x: ix, y: iy, z: iz, taken: false, bornAt: this.time });
        if (ok) { it = make(); break; }
        const sc = (level ? 0 : 10 + Math.abs(iy - c.y)) + t * 0.01;
        if (sc < fbScore) { fbScore = sc; fb = make(); }
      }
      it ??= fb!;
      it.id = this.nextItemId++ & 0xffff;
      this.items.push(it!); placed.push(it!); this.ev.spawnItem(it!.id, kind, sub, rarity, count, it!.x, it!.y, it!.z);
    }
  }
  /** an E press now would go to something ranked above a zipline (no side effects): the tuk-tuk under the crosshair, a
   * window in arm's reach, a chest, a gun on the floor — the order of the E chain below and of the HUD prompt */
  private useClaimed(p: Player): boolean {
    const cp = Math.cos(p.pitch), dx = -Math.sin(p.yaw) * cp, dy = Math.sin(p.pitch), dz = -Math.cos(p.yaw) * cp;
    return (!p.swim && vehicleInReach(this.vehs, p.x, p.y, p.z, eyeY(p), dx, dy, dz, true, !p.grounded) >= 0) || glassAim(this.glass, p.x, eyeY(p), p.z, dx, dy, dz) >= 0
      || this.reachChest(p) !== null || this.manualItem(p) !== null;
  }
  /** the chest an E press opens: nearest in reach — same floor + a clear line (never through a wall or
   * a floor); the one under the crosshair wins */
  private reachChest(p: Player): Chest | null {
    let best: Chest | null = null, bd = Infinity;
    const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
    for (const c of this.chests) {
      if (c.opened) continue;
      const dx = c.x - p.x, dz = c.z - p.z, d = Math.hypot(dx, dz);
      if (d > CHEST_OPEN_DIST + 0.6) continue;
      const score = d * (1.35 - 0.5 * (d > 1e-3 ? (dx * fx + dz * fz) / d : 1));
      if (score < bd && lootReachable(this.world, p.x, p.y, p.z, c.x, c.y, c.z)) { bd = score; best = c; }
    }
    return best;
  }
  private interact(p: Player): boolean {
    const best = this.reachChest(p);
    if (best) {
      best.opened = true; best.openedAt = this.time; this.ev.chest(best.id, p.id);
      const rng = new Rng(this.seed ^ (best.id * 2654435761) ^ this.tick);
      const contents = best.box ? rollAmmoBox(rng) : rollChestContents(rng, best.rarity, best.poi);
      this.spillChest(best, p, contents);
      return true;
    }
    // the item under the crosshair (swap the active slot when full); the range rack takes anything with E
    const it = this.manualItem(p);
    if (it) this.takeItem(p, it, true);
    return !!it;
  }
  /** the item an E press takes: a human's — the weapon or consumable nearest its crosshair in reach
   * (shared/sim/pickup.ts, the prompt's own rule); a bot's — the nearest weapon */
  private manualItem(p: Player): Item | null {
    if (p.bot) return this.nearestItem(p, PICKUP_DIST + 0.5, this.range ? -1 : IK.Weapon);
    const cp = Math.cos(p.pitch);
    return aimedItem(this.items, p.x, p.y, p.z, eyeY(p), -Math.sin(p.yaw) * cp, Math.sin(p.pitch), -Math.cos(p.yaw) * cp, this.world, this.range, !standNear(this.econ?.stands ?? NO_STANDS, p.x, p.y, p.z));
  }
  private nearestItem(p: Player, r: number, kind: IK | -1): Item | null {
    let best: Item | null = null, bd = r;
    for (const it of this.items) { if (it.taken || (kind >= 0 && it.kind !== kind)) continue; const d = Math.hypot(it.x - p.x, it.z - p.z, (it.y - p.y) * 0.6); if (d < bd && (this.range || lootReachable(this.world, p.x, p.y, p.z, it.x, it.y, it.z))) { bd = d; best = it; } }
    return best;
  }
  private autoPickup(p: Player) {
    for (const it of this.items) {
      if (it.taken) continue;
      const dx = it.x - p.x, dz = it.z - p.z, d2 = dx * dx + dz * dz;
      // something you dropped stays on the ground until you have walked away from it once (then walking over it grabs it)
      if (it.dropper === p.id) { if (d2 > (PICKUP_DIST + 1) ** 2) it.dropper = -1; continue; }
      if (d2 > PICKUP_DIST * PICKUP_DIST || it.y - p.y < -1.3 || it.y - p.y > 1.5) continue;
      if (!this.range && !lootReachable(this.world, p.x, p.y, p.z, it.x, it.y, it.z, !p.bot)) continue;
      // walking over a gun you already carry (same weapon, any rarity) never fills a second slot with it — take it with E
      if (it.kind === IK.Weapon) { if (p.slots.some((s) => s.kind === SK.Empty) && !p.slots.some((s) => s.kind === SK.Weapon && s.id === it.sub)) this.takeItem(p, it, false); }
      // bots never use bombs / crate walls: they leave them for the humans instead of filling slots with them
      else if (p.bot && it.kind === IK.Consumable && !CONSUMABLE_DEFS[CONSUMABLES[it.sub]].hp && !CONSUMABLE_DEFS[CONSUMABLES[it.sub]].shield) continue;
      else this.takeItem(p, it, false);
    }
  }
  /** the inventory screen (Tab): op 1 = drag slot a onto slot b, op 2 = drop slot a on the ground */
  inventoryOp(pid: number, op: number, a: number, b: number) {
    const p = this.players[pid]; if (!p) return;
    if (op === 1) { if (invMove(p, a, b)) this.onInventory(p.id); return; }
    if (op === 3) { if (this.econ && (this.phase === Phase.Play || this.phase === Phase.Warmup)) this.econ.buy(p, a, b); return; }
    if (op === 4) { if (this.phase === Phase.Play) this.spectateOp(p, a); return; }   // INV.Spectate
    if (op !== 2) return;
    const s = invDrop(p, a); if (!s) return;
    const fx = p.x - Math.sin(p.yaw) * 1.2, fz = p.z - Math.cos(p.yaw) * 1.2;   // a step in front, where you can see it
    if (s.kind === SK.Weapon) this.spawnItem(IK.Weapon, s.id, s.rarity, 1, fx, p.y, fz, 0.3, p.id).loaded = s.mag;
    else this.spawnItem(IK.Consumable, s.id, s.rarity, s.count, fx, p.y, fz, 0.3, p.id);
    this.onInventory(p.id);
  }
  takeItem(p: Player, it: Item, swap: boolean) {
    if (it.kind === IK.Cash) {
      p.cash = Math.min(ECON.cap, p.cash + it.count * 10); it.taken = true;
      this.ev.takeItem(it.id, p.id); this.onInventory(p.id); return;
    }
    if (it.kind === IK.Ammo) {
      const got = giveAmmo(p, AMMO_TYPES[it.sub], it.count); if (got <= 0) return;
      it.count -= got;
      if (it.count > 0) { this.ev.takeItem(it.id, p.id); this.ev.spawnItem(it.id, it.kind, it.sub, it.rarity, it.count, it.x, it.y, it.z); this.onInventory(p.id); return; }
      it.taken = true;
    }
    else if (it.kind === IK.Consumable) {
      const def = CONSUMABLE_DEFS[CONSUMABLES[it.sub]];
      let slot = p.slots.find((s) => s.kind === SK.Consumable && s.id === it.sub && s.count < def.stack) ?? null;
      if (!slot) slot = p.slots.find((s) => s.kind === SK.Empty) ?? null;
      // a full backpack: E swaps it for what is in your hands, dropped where you stand like a swapped gun —
      // never mid-use / mid-cook, never for a full stack of the same (range: the rack restocks, nothing is dropped)
      if (!slot && swap && p.useT <= 0 && p.cookT <= 0) {
        const act = p.slots[p.active];
        if (!(act.kind === SK.Consumable && act.id === it.sub)) {
          slot = act;
          if (!this.range) { if (act.kind === SK.Weapon) this.spawnItem(IK.Weapon, act.id, act.rarity, 1, p.x, p.y, p.z, 0.8, p.id).loaded = act.mag; else if (act.kind === SK.Consumable) this.spawnItem(IK.Consumable, act.id, act.rarity, act.count, p.x, p.y, p.z, 0.8, p.id); }
        }
      }
      if (slot && !(slot.kind === SK.Consumable && slot.id === it.sub)) { slot.kind = SK.Consumable; slot.id = it.sub; slot.rarity = it.rarity; slot.count = 0; slot.mag = 0; }
      if (!slot) return;
      const take = Math.min(it.count, def.stack - slot.count); slot.count += take; it.count -= take; if (it.count > 0) { this.ev.takeItem(it.id, p.id); this.ev.spawnItem(it.id, it.kind, it.sub, it.rarity, it.count, it.x, it.y, it.z); this.onInventory(p.id); return; }
      it.taken = true;
    } else {
      let slot = p.slots.find((s) => s.kind === SK.Empty) ?? null;
      if (!slot) { if (!swap) return; slot = p.slots[p.active]; if (this.range) { /* the rack restocks: nothing to drop */ } else if (slot.kind === SK.Weapon) this.spawnItem(IK.Weapon, slot.id, slot.rarity, 1, p.x, p.y, p.z, 0.8, p.id).loaded = slot.mag; else if (slot.kind === SK.Consumable) this.spawnItem(IK.Consumable, slot.id, slot.rarity, slot.count, p.x, p.y, p.z, 0.8, p.id); }
      const w = WEAPON_DEFS[WEAPONS[it.sub]];
      slot.kind = SK.Weapon; slot.id = it.sub; slot.rarity = it.rarity; slot.count = 1; slot.mag = it.loaded ?? w.mag;
      if (it.loaded === undefined) giveAmmo(p, w.ammo, AMMO_PICKUP[w.ammo]);
      // the first gun you touch goes to your hands when you are not holding one (landing: a pistol first, then an AR)
      // …and a real gun replaces the starter sidearm in your hands
      const act = p.slots[p.active];
      if (swap || act.kind === SK.Empty || (act.kind === SK.Consumable && p.useT <= 0) || (act.kind === SK.Weapon && act.id === 0 && it.sub !== 0 && p.reloadT <= 0 && p.cool <= 0.05)) { const idx = p.slots.indexOf(slot); if (idx >= 0) { p.active = idx; p.swapT = 0.2; } }
      it.taken = true;
    }
    this.ev.takeItem(it.id, p.id); this.onInventory(p.id);
  }

  // ---------------------------------------------------------------- late joiners / leavers
  /** a human joins mid-lobby: takes over a bot seat (prefers a bot on a squad with room for this human's squad) */
  claimBot(name: string, team: number): number {
    const bots = this.players.filter((p) => p.bot);
    let pick = bots.find((p) => p.team === team) ?? null;
    if (!pick) {
      // steal from the squad with the most bots
      const cnt = new Map<number, number>(); for (const b of bots) cnt.set(b.team, (cnt.get(b.team) ?? 0) + 1);
      let bestTeam = -1, bc = 0; for (const [t, c] of cnt) if (c > bc) { bc = c; bestTeam = t; }
      pick = bots.find((p) => p.team === bestTeam) ?? null;
    }
    if (!pick) return -1;
    pick.bot = false; pick.connected = true; pick.name = name; this.brains[pick.id] = null;
    this.resetInputs(pick.id); pick.lastSeq = 0;
    return pick.id;
  }
  /** a human leaves: the seat becomes a bot again */
  releaseHuman(id: number) {
    const p = this.players[id]; if (!p || p.bot) return;
    p.bot = true; p.connected = false; p.name = BOT_NAMES[id % BOT_NAMES.length];
    const b = new BotBrain(id, this.rng.next() * 1e9 | 0, this.botDifficulty); this.brains[id] = b;
    if (this.phase === Phase.Plane && p.st === PS.Plane) b.planDrop(this, p);
    else if (alive(p)) { b.onRespawn(this, p); }
  }
  /** a human who dropped comes back to the seat that was theirs (the host checks it was): the inverse of
   *  releaseHuman, while the seat still plays — a bot holds it, not dead, not eliminated. false = it can't be had back */
  reclaimHuman(id: number, name: string): boolean {
    const p = this.players[id]; if (!p || !p.bot || p.eliminated || !alive(p)) return false;
    p.bot = false; p.connected = true; p.name = name; this.brains[id] = null;
    this.resetInputs(id); p.lastSeq = 0;
    return true;
  }
  /** team of a human by lobby squad: used when claiming seats */
  teamOf(id: number) { return this.players[id]?.team ?? -1; }

  // ---------------------------------------------------------------- helpers
  /** warm-up (re)spawn on the islet: only on the open sand the islet keeps clear of plants (its beach front + the strip
   * between the toys and the runway), never inside a bush or a prop, facing inland where the kongs play */
  spawnWarmup(p: Player) {
    for (let i = 0; i < 40; i++) {
      const zone = this.rng.next() < 0.6 ? WARM_ZONES[0] : WARM_ZONES[1];
      const lx = zone[0] + (this.rng.next() * 2 - 1) * zone[2], d = zone[1] + (this.rng.next() * 2 - 1) * zone[3];
      const [x, z] = isletToWorld(lx, d), h = this.world.ground(x, z);
      if (h < 1) continue;
      this.world.velY = 0; this.world.resolveCapsule(x, h + 0.05, z, PLAYER_R + 0.6, PLAYER_H, false);
      if (Math.hypot(this.world.P[0] - x, this.world.P[2] - z) > 0.05 || this.world.P[1] - h > 0.3) continue;   // a prop is here
      p.x = x; p.y = this.world.P[1]; p.z = z; p.st = PS.Ground; p.grounded = true; p.vx = p.vy = p.vz = 0;
      p.yaw = isletYaw() + (this.rng.next() - 0.5) * 1.2;
      return;
    }
    const islet = POIS.find((q) => q.id === "lobby-islet")!;
    this.spawnAt(p, islet.x, islet.z, 40);
  }
  spawnAt(p: Player, cx: number, cz: number, r: number) {
    for (let i = 0; i < 30; i++) {
      const a = this.rng.next() * Math.PI * 2, d = Math.sqrt(this.rng.next()) * r;
      const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d, h = this.world.ground(x, z);
      if (h < 1) continue;
      this.world.velY = 0; this.world.resolveCapsule(x, h + 0.05, z, PLAYER_R, PLAYER_H, false);
      p.x = this.world.P[0]; p.y = this.world.P[1]; p.z = this.world.P[2]; p.st = PS.Ground; p.grounded = true; p.vx = p.vy = p.vz = 0; p.yaw = this.rng.next() * Math.PI * 2;
      return;
    }
    p.x = cx; p.z = cz; p.y = Math.max(0, this.world.ground(cx, cz)) + 0.1; p.st = PS.Ground;
  }
  headerFlags(): number {
    let f = 0; if (this.resurgenceOn) f |= 1; if (this.warned && this.resurgenceOn) f |= 2; if (!this.resurgenceOn && this.phase === Phase.Play) f |= 4; if (this.planeOpen) f |= 8; if (this.range) f |= 16; return f;
  }
}

/** open sand on the lobby islet in its own frame: [lx, d, half-width, half-depth] (see shared/pois/lobby-islet clearings) */
const WARM_ZONES: Array<[number, number, number, number]> = [[-2, 20, 26, 12], [10, 30, 17, 6]];
/** where warm-up spawns land (zone centres + corners, world x/z) and the spawn heading — the client's boot prewarm draws
 * the world from exactly these spots so nothing is uploaded / compiled the moment a match starts */
export function warmupViewpoints(): { pts: Array<[number, number]>; yaw: number } {
  const pts: Array<[number, number]> = [];
  for (const z of WARM_ZONES) for (const [sx, sd] of [[0, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]]) pts.push(isletToWorld(z[0] + sx * z[2] * 0.8, z[1] + sd * z[3] * 0.8) as [number, number]);
  return { pts, yaw: isletYaw() };
}
const isletToWorld = (lx: number, d: number) => islet.toWorld(lx, d);
const isletYaw = () => islet.worldYaw(0);

/** a match's first drop: a common (gray) NUB pistol, magazine full, in slot 1 and in hand, and
 * START_PISTOL_AMMO light rounds (const.ts says why 36). Redeploys keep their own kit (respawns: + a random primary) */
function giveStartKit(p: Player) {
  const s = p.slots[0]; s.kind = SK.Weapon; s.id = WEAPONS.indexOf("pistol"); s.rarity = 0; s.mag = WEAPON_DEFS.pistol.mag; s.count = 1;
  p.ammo[AMMO_TYPES.indexOf("light")] = START_PISTOL_AMMO; p.active = 0;
}
function giveWarmupKit(p: Player, rng: Rng) {
  const w = rng.int(4); // pistol..shotgun
  const s = p.slots[0]; s.kind = SK.Weapon; s.id = w; s.rarity = 1 + rng.int(2); s.mag = WEAPON_DEFS[WEAPONS[w]].mag; s.count = 1;
  giveAmmo(p, WEAPON_DEFS[WEAPONS[w]].ammo, AMMO_PICKUP[WEAPON_DEFS[WEAPONS[w]].ammo] * 3);
  const c = p.slots[1]; c.kind = SK.Consumable; c.id = CONSUMABLES.indexOf("leaf-bundle"); c.rarity = 0; c.count = 2; p.active = 0;
}

const BOT_NAMES = ["Bongo", "Kiki", "Mango", "Peel", "Rumble", "Tusk", "Koko", "Banjo", "Dizzy", "Chunk", "Ripe", "Zuzu", "Bruiser", "Nana", "Split", "Husk", "Fuzz", "Grit", "Loco", "Pip", "Rex", "Sable", "Tango", "Umbo", "Vex", "Waffle", "Yuca", "Zed", "Ape-X", "Bam", "Cocoa", "Dune", "Ember", "Fig", "Gogo", "Hopper", "Ivo", "Jumbo", "Kong-Jr", "Lush", "Moss", "Nib", "Ozzy", "Pulp", "Quill", "Rango", "Sprout", "Tiki", "Ubu", "Volt"];
