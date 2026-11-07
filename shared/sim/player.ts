// Player state + the deterministic per-tick step (movement, drop, weapon timers, consumables). Runs identically as
// client prediction and on the authoritative server. No allocations in `stepPlayer`.
import { CONSUMABLES, WEAPONS, type ConsumableId, type Rarity, type WeaponId } from "../world/map";
import { AMMO_CAP, CONSUMABLE_DEFS, CROUCH_H, DT, HISTORY_TICKS, MAX_HP, PLAYER_H, RARITY_MUL, SWAP_S, UW_H, UW_EYE, SWIM_EYE, WEAPON_DEFS, WEAPON_SLOTS, qpos, type AmmoType } from "./const";
import { SEAT_EYE } from "./vehicle";
import * as dmath from "./dmath";

export const enum PS { Ground = 0, Freefall = 1, Glide = 2, Dead = 3, Plane = 4, Spectate = 5, /** riding a zipline (shared/sim/zipline.ts) */ Zip = 6,
  /** pulling up onto a ledge (mantle): mvY = the ledge top, mvT = elapsed, (vx, vz) = the direction × MANTLE_FWD */ Mantle = 7,
  /** in a tuk-tuk (shared/sim/vehicle.ts): `veh` = which, `seat` 0 = at the bars, 1 / 2 = on the bench. In a helicopter
   * (shared/sim/heli.ts): 0 = the pilot, 1 = the door gunner (TOP BANANA), 2 = the passenger */ Ride = 8,
  /** on a ladder / tree trunk (shared/sim/climb.ts): mvY = the climb's index in world.climbs, mvT = s on it */
  Climb = 9 }
export const B = {
  FIRE: 1, JUMP: 2, CROUCH: 4, SPRINT: 8, RELOAD: 16, USE: 32, SCOPE: 64, GLIDER: 128, DROP: 256, DIVE: 512,
  /** any vehicle: SEAT = a 2-bit field (seat + 1) sent for one input — jump to that seat (a tuk-tuk's bars /
   * bench, a helicopter's pilot / door gun / passenger seat); RADIO = next station (tuk-tuks) */
  SEAT: 1024 | 2048, RADIO: 4096,
  /** G: pull / cook / throw a banana bomb from any slot. A high bit on purpose (the low bits fill up from the bottom) */
  THROW: 0x2000,
  /** a helicopter's collective down (shared/sim/heli.ts); jump is up. (Not 1024: that is the SEAT
   * field's low bit; proto.ts BUTTON_MASK covers it) */
  DESCEND: 0x4000,
} as const;
/** the seat a SEAT field asks for (−1 = none) */
export const seatAsked = (buttons: number) => ((buttons >> 10) & 3) - 1;
export const AMMO_TYPES: AmmoType[] = ["light", "heavy", "shells", "rockets"];
export const ammoIndex = (a: AmmoType) => AMMO_TYPES.indexOf(a);

export interface Input {
  seq: number;
  mx: number; mz: number;
  yaw: number; pitch: number;
  buttons: number;
  slot: number;
  /** lag compensation: the client was drawing other players blended between snapshot ticks lerpA and lerpA+lerpSpan
   * at fraction lerpF (u16/65535). lerpSpan 0 = holding the lerpA sample. The server rewinds to exactly this. */
  lerpA: number; lerpSpan: number; lerpF: number;
}
export const makeInput = (): Input => ({ seq: 0, mx: 0, mz: 0, yaw: 0, pitch: 0, buttons: 0, slot: 0, lerpA: 0, lerpSpan: 0, lerpF: 0 });
export function copyInput(dst: Input, src: Input) { dst.seq = src.seq; dst.mx = src.mx; dst.mz = src.mz; dst.yaw = src.yaw; dst.pitch = src.pitch; dst.buttons = src.buttons; dst.slot = src.slot; dst.lerpA = src.lerpA; dst.lerpSpan = src.lerpSpan; dst.lerpF = src.lerpF; }

export const enum SK { Empty = 0, Weapon = 1, Consumable = 2 }
export interface Slot { kind: SK; id: number; rarity: number; count: number; mag: number }
export const makeSlot = (): Slot => ({ kind: SK.Empty, id: 0, rarity: 0, count: 0, mag: 0 });

export interface Player {
  id: number; team: number; name: string; bot: boolean; connected: boolean;
  x: number; y: number; z: number; vx: number; vy: number; vz: number; yaw: number; pitch: number;
  st: PS; grounded: boolean; crouch: boolean; sprint: boolean; swim: boolean; surf: number; slope: boolean;
  hp: number; shield: number;
  slots: Slot[]; active: number; ammo: Int16Array;
  cool: number; reloadT: number; reloadTotal: number; useT: number; useTotal: number; swapT: number;
  jumpBuf: number; coyote: number; airT: number; fallV: number;
  /** traversal. Ground: mvT = seconds into the current slide (0 = not sliding), mvY = slide cooldown left (s).
   * Mantle: mvT = seconds into the pull-up, mvY = the ledge top (feet target). Both ride in the self state (f64).
   * Freefall / Glide: mvT / mvY = the x / z acceleration of the drop's velocity springs, fallV the vertical one
   * (stepAir; zeroed whenever the player leaves the air). */
  mvT: number; mvY: number;
  shotSeq: number; fired: number; scoped: boolean; prevButtons: number;
  /** weapon handling: ADS held this tick (any gun), bloom heat (spread × (1 + heat)), seconds since
   * the last shot (first-shot accuracy). Hands state: evolves identically on the server and in the prediction. */
  ads: boolean; heat: number; shotAgo: number;
  kills: number; damage: number; deadAt: number; respawnAt: number; killer: number; placement: number;
  lastSeq: number; lastInputAt: number; stormT: number; landedAt: number; spectate: number;
  /** server: pose history ring [x, y, z, yaw, flags] × HISTORY_TICKS, indexed by tick % HISTORY_TICKS. Positions are
   * quantised exactly like snapshots (qpos) so lag compensation evaluates the numbers the client interpolated. */
  hist: Float32Array;
  /** state bits for the renderer: 1 = reloading, 2 = using, 4 = hurt this tick, 8 = fired this tick */
  anim: number;
  eliminated: boolean;
  /** resurgence redeploys used this match (solo has a limited number) */
  redeploys: number;
  /** firing range: reloads never draw down the reserve (set on the server AND the client's prediction) */
  infAmmo: boolean;
  /** PS.Ride: the tuk-tuk (VehicleSet index, −1 = on foot) and the seat in it (0 = driver) */
  veh: number; seat: number;
  /** E this tick belongs to something the prompt shows ahead of a zipline (aimed tuk-tuk, window, chest, gun on the
   * floor): set by the caller right before stepPlayer (Match.simulate / the client's prediction, from the same pick as the
   * HUD prompt), consumed + cleared by stepPlayer — then the E press never grabs a zipline trolley. Not on the wire. */
  useTaken: boolean;
  /** red banana: seconds of the speed / jump buff left (0 = none) — rides in the self state */
  buffT: number;
  /** banana bomb: seconds the pulled bomb has been cooking (0 = none in hand); `thrown` = this tick's throw
   *  (> 0: the seconds it cooked — the match spawns the bomb, like `fired`) */
  cookT: number; thrown: number;
  /** a crate wall was set down this tick (cover.ts PLACED holds where — the match spawns it) */
  placed: number;
  /** Banana Bucks in the wallet (this match; dropped on death) */
  cash: number;
  /** swimming: `under` = diving below the surface (p.swim stays true), `breath` 0..1 of the
   *  air left (BREATH_S under water), `swGun` = s the swimmer's gun stays drawn (0 = stowed: both arms stroke). All three
   *  ride in the self state at full precision. */
  under: boolean; breath: number; swGun: number;
}

export function makePlayer(id: number, team: number, name: string, bot: boolean): Player {
  const slots: Slot[] = []; for (let i = 0; i < WEAPON_SLOTS; i++) slots.push(makeSlot());
  return {
    id, team, name, bot, connected: !bot,
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0,
    st: PS.Ground, grounded: false, crouch: false, sprint: false, swim: false, surf: 5, slope: false,
    hp: MAX_HP, shield: 0,
    slots, active: 0, ammo: new Int16Array(4),
    cool: 0, reloadT: 0, reloadTotal: 0, useT: 0, useTotal: 0, swapT: 0,
    jumpBuf: 0, coyote: 0, airT: 0, fallV: 0, mvT: 0, mvY: 0,
    shotSeq: 0, fired: 0, scoped: false, prevButtons: 0, ads: false, heat: 0, shotAgo: 9,
    kills: 0, damage: 0, deadAt: -1, respawnAt: -1, killer: -1, placement: 0,
    lastSeq: 0, lastInputAt: 0, stormT: 0, landedAt: -1, spectate: -1,
    hist: new Float32Array(HISTORY_TICKS * 5),
    anim: 0, eliminated: false, redeploys: 0, infAmmo: false, veh: -1, seat: 0, useTaken: false, buffT: 0, cookT: 0, thrown: 0, placed: 0, cash: 0,
    under: false, breath: 1, swGun: 0,
  };
}

export function resetForMatch(p: Player) {
  p.hp = MAX_HP; p.shield = 0; p.vx = p.vy = p.vz = 0; p.st = PS.Ground; p.crouch = false; p.sprint = false; p.swim = false; p.under = false;
  for (const s of p.slots) { s.kind = SK.Empty; s.count = 0; s.mag = 0; s.id = 0; s.rarity = 0; }
  p.active = 0; p.ammo.fill(0);
  p.cool = p.reloadT = p.useT = p.swapT = 0; p.jumpBuf = p.coyote = p.airT = 0; p.fallV = 0; p.mvT = p.mvY = 0; p.shotSeq = 0; p.fired = 0; p.scoped = false; p.ads = false; p.heat = 0; p.shotAgo = 9;
  p.kills = 0; p.damage = 0; p.deadAt = -1; p.respawnAt = -1; p.killer = -1; p.placement = 0; p.stormT = 0; p.landedAt = -1; p.spectate = -1; p.eliminated = false;
  p.hist.fill(0); p.anim = 0; p.redeploys = 0; p.veh = -1; p.seat = 0; p.buffT = 0; p.cookT = 0; p.thrown = 0; p.placed = 0; p.cash = 0;
  p.under = false; p.breath = 1; p.swGun = 0;
}

export const alive = (p: Player) => p.st !== PS.Dead && p.st !== PS.Spectate;
export const height = (p: Player) => (p.under && p.st === PS.Ground ? UW_H : p.crouch && p.st === PS.Ground ? CROUCH_H : PLAYER_H);
export const eyeY = (p: Player) => p.y + (p.st === PS.Ride ? SEAT_EYE : p.under && p.st === PS.Ground ? UW_EYE : p.swim && p.st === PS.Ground ? SWIM_EYE : p.crouch && (p.st === PS.Ground || p.st === PS.Mantle) ? 1.05 : 1.65);
export const weaponDef = (p: Player) => { const s = p.slots[p.active]; return s.kind === SK.Weapon ? WEAPON_DEFS[WEAPONS[s.id]] : null; };
export const consumableDef = (p: Player) => { const s = p.slots[p.active]; return s.kind === SK.Consumable ? CONSUMABLE_DEFS[CONSUMABLES[s.id]] : null; };
export const weaponId = (i: number): WeaponId => WEAPONS[i];
export const consumableId = (i: number): ConsumableId => CONSUMABLES[i];
export const rarityOf = (i: number): Rarity => (i >= 5 ? "mythic" : (["common", "uncommon", "rare", "epic", "legendary"] as Rarity[])[i] ?? "common");

/** returns damage dealt (after shield); `by` = attacker id or -1. Does NOT kill — the match decides on hp <= 0. */
export function applyDamage(p: Player, dmg: number, by: number): number {
  // a corpse takes nothing (the rest of a shotgun blast, a splash on a body): no damage credit, no second kill
  if (dmg <= 0 || p.hp <= 0 || p.st === PS.Dead || p.st === PS.Spectate) return 0;
  // credited damage never exceeds what the target had left (a 13-damage pellet on a 5-hp kong deals 5)
  const dealt = Math.min(dmg, Math.max(0, p.hp) + Math.max(0, p.shield));
  const sh = Math.min(p.shield, dmg);
  p.shield -= sh;
  const rest = dmg - sh;
  p.hp -= rest;
  p.anim |= 4;
  void by;
  return dealt;
}

/** fall damage (a hard landing, a freefall crash): health only — the shield is armour against weapons, never the
 *  ground. Same code on the server and in the client's prediction. */
export function fallDamage(p: Player, dmg: number): number {
  if (dmg <= 0 || p.hp <= 0 || p.st === PS.Dead || p.st === PS.Spectate) return 0;
  const dealt = Math.min(dmg, Math.max(0, p.hp));
  p.hp -= dmg; p.anim |= 4;
  return dealt;
}

export function weaponDamage(w: { dmg: number }, rarity: number) { return w.dmg * RARITY_MUL[rarityOf(rarity)]; }
/** damage of one hitscan pellet that hit at distance t (falloff) in zone (1 = head) — ONE formula for server + prediction */
export function pelletDamage(w: { dmg: number; falloff: [number, number, number]; headMul: number }, rarity: number, t: number, zone: number): number {
  const fo = w.falloff; const fm = t <= fo[0] ? 1 : t >= fo[1] ? fo[2] : 1 + (fo[2] - 1) * ((t - fo[0]) / (fo[1] - fo[0]));
  let dmg = weaponDamage(w, rarity) * fm; if (zone === 1) dmg *= w.headMul;
  return dmg;
}

/** deterministic spread offset for pellet k of shot n: writes [dx, dy] in radians into out */
export function spreadOffset(seedPlayer: number, shot: number, k: number, spreadDeg: number, out: Float64Array) {
  let h = (seedPlayer * 73856093) ^ (shot * 19349663) ^ (k * 83492791); h = Math.imul(h ^ (h >>> 13), 0x5bd1e995); h ^= h >>> 15;
  const a = ((h & 0xffff) / 65536) * Math.PI * 2;
  const r = Math.sqrt(((h >>> 16) & 0xffff) / 65536) * spreadDeg * (Math.PI / 180);
  out[0] = dmath.cos(a) * r; out[1] = dmath.sin(a) * r;
}

/** bloom bookkeeping for the shot fired last tick (called at the top of the next step, so the server's resolveShot and
 * the client's predictShot — both run right after the firing step — see the spread the shot left the barrel with) */
export function noteShot(p: Player) {
  const w = weaponDef(p); if (!w) return;
  p.heat = Math.min(w.bloom[1], p.heat + w.bloom[0]); p.shotAgo = 0;
}
/** per tick: time since the last shot; the bloom drains once the trigger is off for longer than one shot interval */
export function coolHeat(p: Player, dt: number) {
  if (p.shotAgo < 9) p.shotAgo += dt;
  if (p.heat > 0) {
    const w = weaponDef(p);
    if (!w) p.heat = 0;
    else if (p.shotAgo > 60 / w.rpm + 0.04) p.heat = Math.max(0, p.heat - w.bloom[2] * dt);
  }
}
/** the spread cone (deg) the NEXT shot leaves the barrel with — server, prediction, HUD crosshair and the balance tools */
export function currentSpread(p: Player, w: { spread: [number, number, number]; ads: number; fsa: number; scope?: number; adsSpread?: [number, number, number] }): number {
  // (a tuk-tuk's bench is never a steady platform: a rider always shoots with the moving spread, parked or flat out —
  //  which also keeps the server and the rider's prediction on the same number whatever the tuk-tuk's speed was)
  const ride = p.st === PS.Ride;
  const air = (p.st !== PS.Ground && !ride) || !p.grounded, moving = !air && (ride || dmath.hypot(p.vx, p.vz) > 1);
  // first-shot accuracy: planted feet + a pause → the shot goes exactly where the crosshair is
  if (w.fsa > 0 && !air && !moving && p.shotAgo >= w.fsa) return 0;
  let s = air ? w.spread[2] : moving ? w.spread[1] : w.spread[0];
  if (p.crouch) s *= 0.75;
  // a gun with its own aimed table (the scoped sniper) uses it — a jump- or run-scope is no laser
  if ((p.ads || p.scoped) && w.adsSpread) return (air ? w.adsSpread[2] : moving ? w.adsSpread[1] : w.adsSpread[0] * (p.crouch ? 0.75 : 1)) * (1 + p.heat);
  if (p.ads || p.scoped) s *= w.ads;
  return s * (1 + p.heat);
}

/** give ammo, returns amount actually taken */
export function giveAmmo(p: Player, type: AmmoType, n: number): number {
  const i = ammoIndex(type); const cap = AMMO_CAP[type];
  const take = Math.max(0, Math.min(n, cap - p.ammo[i])); p.ammo[i] += take; return take;
}


/** hitbox flags (shared with the client's snapshot decoding): bit0 crouched hitbox, bit1 hittable. Callers pass
 *  `crouch || swim`: a swimmer is the crouched hitbox — its head and shoulders are what is out of the water */
export const PF_CROUCH = 1, PF_HITTABLE = 2;
export const poseFlags = (st: number, crouch: boolean) =>
  // (a kong seated in a tuk-tuk is the crouched hitbox: head and shoulders over the belt line)
  (st === PS.Ground || st === PS.Freefall || st === PS.Glide || st === PS.Zip || st === PS.Mantle || st === PS.Ride || st === PS.Climb ? PF_HITTABLE : 0) | ((crouch && st === PS.Ground) || st === PS.Ride ? PF_CROUCH : 0);

export function recordHistory(p: Player, tick: number) {
  const i = (tick % HISTORY_TICKS) * 5;
  p.hist[i] = qpos(p.x); p.hist[i + 1] = qpos(p.y); p.hist[i + 2] = qpos(p.z); p.hist[i + 3] = p.yaw; p.hist[i + 4] = poseFlags(p.st, p.crouch || p.swim);
}
export { DT };

// ---- inventory screen ops (Tab): run on the client's prediction the moment you drop the icon AND on the server when
// the op frame arrives, so both agree without a round trip.
/** can this player rearrange / drop right now (not dead, riding the plane, or spectating) */
export const canEditInventory = (p: Player) => alive(p) && p.st !== PS.Plane;
/** anything held in slot `i` changed under the hands: cancel the reload / heal and play the swap */
function touchedHands(p: Player, i: number) { if (i === p.active) { p.reloadT = 0; p.useT = 0; p.scoped = false; p.swapT = SWAP_S; } }
/** drag slot a onto slot b: the same consumable stacks (up to its stack size), anything else swaps. The hands stay on
 * their slot index. Returns false when nothing changed. */
export function invMove(p: Player, a: number, b: number): boolean {
  if (!canEditInventory(p) || a === b || a < 0 || b < 0 || a >= WEAPON_SLOTS || b >= WEAPON_SLOTS) return false;
  const A = p.slots[a], Bs = p.slots[b];
  if (A.kind === SK.Empty) return false;
  if (A.kind === SK.Consumable && Bs.kind === SK.Consumable && A.id === Bs.id) {
    const room = CONSUMABLE_DEFS[CONSUMABLES[A.id]].stack - Bs.count;
    if (room > 0) {
      const n = Math.min(room, A.count); Bs.count += n; A.count -= n;
      if (A.count <= 0) { A.kind = SK.Empty; A.id = 0; A.rarity = 0; A.count = 0; A.mag = 0; }
      touchedHands(p, a); touchedHands(p, b); return true;
    }
  }
  const k = A.kind, id = A.id, r = A.rarity, c = A.count, m = A.mag;
  A.kind = Bs.kind; A.id = Bs.id; A.rarity = Bs.rarity; A.count = Bs.count; A.mag = Bs.mag;
  Bs.kind = k; Bs.id = id; Bs.rarity = r; Bs.count = c; Bs.mag = m;
  touchedHands(p, a); touchedHands(p, b);
  return true;
}
/** empty slot i (the caller spawns what was in it on the ground). Returns the removed slot's contents, or null. */
export function invDrop(p: Player, i: number): Slot | null {
  if (!canEditInventory(p) || i < 0 || i >= WEAPON_SLOTS) return null;
  const s = p.slots[i]; if (s.kind === SK.Empty) return null;
  const out: Slot = { ...s };
  s.kind = SK.Empty; s.id = 0; s.rarity = 0; s.count = 0; s.mag = 0;
  touchedHands(p, i);
  return out;
}


export const BUSY_IN: Input = makeInput();
export { stepPlayer, WALL_ID, canPullChute, CORPSE_FLOAT_Y, FF_DOWN, FF_DIVE_DOWN, FF_FWD, FF_DIVE_P0, FF_DIVE_P1, FF_WV, FF_WH, GL_WV, GL_WH, GL_DOWN, GL_DIVE_DOWN, GL_FWD, GL_NEUTRAL, GL_BACK, GL_DIVE_P0, GL_DIVE_P1, AUTO_DEPLOY, dropAgl, BOMB_ID, bombSlot } from "./player.hot";
