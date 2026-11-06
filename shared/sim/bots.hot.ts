import { rarityTier } from "./mythic";
import { POIS } from "../world/map";
import { BOT_DIFFICULTY, CONSUMABLE_DEFS, DT, MAX_HP, MAX_SHIELD, PICKUP_DIST, PLAYER_H, WEAPON_DEFS, scopeSway } from "./const";
import { IK, lootReachable, type Item } from "./loot";
import { lootSpots, navCellAt, navDoor, navPath } from "./loot-spots";
import { B, PS, SK, alive, eyeY, pelletDamage, weaponDef, type Input, type Player } from "./player";
import { TUK, VF, VKind, VS, footDist } from "./vehicle";
import { makeHit } from "./world";
import type { Match } from "./match";
import { CONSUMABLES, WEAPONS } from "../world/map";
import { S, type BotBrain } from "./bots";
import * as dmath from "./dmath";

const HIT = makeHit();
/** seconds after a player's touchdown before bots start shooting at them (unless that player shoots first) */
export const LANDING_GRACE_S = 4;
const AMMO_IDX = ["light", "heavy", "shells", "rockets"];

/** does this bot think this tick? (fighting / flying bots every tick, the rest every 3rd) */
export const botThinksNow = (m: Match, p: Player, b: BotBrain) =>
  b.state === S.Fight || p.st === PS.Freefall || p.st === PS.Glide || ((m.tick + p.id) % 3) === 0;

export function botThink(m: Match, p: Player, b: BotBrain, inp: Input) {
  const dt = Math.min(0.1, Math.max(1, m.tick - b.lastThink) / 60); b.lastThink = m.tick;
  inp.seq++;
  inp.buttons &= ~(B.JUMP | B.USE | B.RELOAD | B.GLIDER | B.DROP);
  if (p.st === PS.Plane) { inp.buttons = m.planeT >= b.jumpAt ? B.DROP : 0; inp.yaw = p.yaw; return; }
  if (!alive(p)) { inp.buttons = 0; inp.mx = inp.mz = 0; b.enemy = -1; return; }
  if (p.st === PS.Freefall || p.st === PS.Glide) {
    const dx = b.tx - p.x, dz = b.tz - p.z, dist = dmath.hypot(dx, dz);
    inp.yaw = dmath.atan2(-dx, -dz);
    const agl = p.y - Math.max(0, m.world.ground(p.x, p.z));
    // freefall carries ≈ 0.42 m sideways per metre of drop, the glider ≈ 2.7:
    // a target farther than freefall + the auto-opened glider reach → open the glider now, like a player would
    if (p.st === PS.Freefall) {
      const far = dist > agl * 0.42 + 230;
      const dive = dist < 60 ? 1 : dist > agl * 0.42 ? 0 : 0.7;
      inp.pitch = -0.2 - 0.9 * dive; inp.mz = 1; inp.mx = 0;
      inp.buttons = far && agl > 40 ? B.GLIDER : dive > 0.9 && agl > 140 ? B.DIVE : 0;
    } else {
      const dive = dist < 40 ? 1 : dist > agl * 2.2 ? 0 : 0.6;
      inp.pitch = -0.2 - 0.9 * dive; inp.mz = 1; inp.mx = 0;
      inp.buttons = 0;
    }
    return;
  }
  if (m.phase === 0) {
    // the islet's two tuk-tuks: squadmates ride along there too (nobody shoots yet)
    if (p.st === PS.Ride) { ride(m, p, b, inp, dt, null, false); return; }
    b.boardVeh = taxiFor(m, p, b, dt);
    if (b.boardVeh >= 0) { inp.buttons &= ~(B.FIRE | B.SCOPE | B.CROUCH | B.SPRINT); board(m, p, b, inp); return; }
    warmup(m, p, b, inp, dt); return;
  }
  if (b.landedAt < 0) b.landedAt = m.time;
  // ---- ground
  const inStorm = dmath.hypot(p.x - m.storm.cx, p.z - m.storm.cz) > m.storm.r - 12;
  const nextOutside = dmath.hypot(p.x - m.storm.tx, p.z - m.storm.tz) > m.storm.tr - 25;
  // enemy scan: a ~200° field of view (360° up close), line of sight, every 9 ticks
  b.enemySeenT += dt;
  // (no enemy yet: every 3rd tick — 50 ms is far below a reaction time, and a line-of-sight ray per player per bot per
  // tick was half the server's tick cost in a hot drop)
  if (((m.tick + p.id) % 9) === 0 || (b.enemy < 0 && ((m.tick + p.id) % 3) === 0)) {
    // late fights retain awareness: circle closure changes the stakes, not eyesight
    let best = -1, bd = 205 * (0.7 + 0.3 * b.skill);
    const ey = eyeY(p), fx = -dmath.sin(p.yaw), fz = -dmath.cos(p.yaw);
    for (const q of m.players) {
      if (q === p || q.team === p.team || !alive(q) || q.st === PS.Plane || q.st === PS.Dead) continue;
      // nobody can fire back from the sky: players on their FIRST drop are never shot in the air (else humans
      // land at 39 hp and die 2 s later); redeploying players carry a kit and are fair game low over a fight
      const air = q.st === PS.Freefall || q.st === PS.Glide;
      if (air && (m.phase !== 2 || q.y - p.y > 90 || q.redeploys === 0)) continue;
      // landing grace: a kong that touched down moments ago is still grabbing a gun (4 s; 8 s while it has none) —
      // unless it shoots us first (onHurt sets b.enemy)
      if (!air && b.enemy !== q.id && m.time - m.dropLandT[q.id] < (hasUsableWeapon(q) ? LANDING_GRACE_S : LANDING_GRACE_S * 2)) continue;
      const dx = q.x - p.x, dz = q.z - p.z, d = dmath.hypot(dx, dz); if (d > (air ? Math.min(bd, 110) : bd)) continue;
      if (d > 30 && (dx * fx + dz * fz) / (d || 1) < -0.17) continue;           // behind us: unseen
      if (!m.world.clear(p.x, ey, p.z, q.x, q.y + PLAYER_H * 0.7, q.z)) continue;
      bd = d; best = q.id;
    }
    if (best >= 0) { if (best !== b.enemy) { b.enemy = best; b.reactT = (0.16 + (1 - b.skill) * 0.36) * BOT_DIFFICULTY[b.difficulty].reaction; b.engagedT = 0; b.flick(); } b.enemySeenT = 0; }
    else if (b.enemySeenT > 4) b.enemy = -1;
  }
  const w = weaponDef(p);
  const hasWeapon = hasUsableWeapon(p);
  const vit = p.hp + p.shield;
  b.hurtT += dt;
  // a bot with only a pistol keeps looting for a real gun: it fights back when shot or when someone is close, but does
  // not pick long fights or go hunting (that is how bots upgrade instead of spraying pistols all match)
  const geared = hasWeapon && bestWeaponValue(p) >= 2;
  const eP = b.enemy >= 0 ? m.players[b.enemy] : null;
  const engage = !!eP && hasWeapon && (geared || b.hurtT < 4 || dmath.hypot(eP.x - p.x, eP.z - p.z) < 45);
  // on a squadmate's tuk-tuk: no legs to think about
  if (p.st === PS.Ride) { ride(m, p, b, inp, dt, w, engage); return; }
  b.boardVeh = engage ? -1 : taxiFor(m, p, b, dt);
  // state selection
  if (m.phase === 2 && (inStorm || (m.storm.shrinking && nextOutside))) b.state = engage && !inStorm ? S.Fight : S.Rotate;
  else if (engage) b.state = S.Fight;                    // (warm-up bots never get here: they mill about, never shoot)
  else if (p.hp < 70 && hasConsumable(p) && b.enemySeenT > 2) b.state = S.Heal;
  else if (b.state === S.Hunt && hasWeapon) { /* keep hunting */ }
  else if (b.state !== S.Loot && b.state !== S.Roam) b.state = S.Loot;
  // gunfire nearby draws armed, healthy bots in (third parties make the match)
  if ((b.state === S.Loot || b.state === S.Roam) && geared && vit > 70 && m.phase === 2 && ((m.tick + p.id) % 20) === 0 && b.rng.next() < b.aggro) {
    const nz = m.nearestNoise(p.x, p.z, 130 + 140 * b.aggro, p.team);
    if (nz >= 0) { b.state = S.Hunt; b.tx = m.noise[nz * 4]; b.tz = m.noise[nz * 4 + 1]; b.roamT = 14; }
  }

  // geared up (35 s after landing, armed, healthy): sweep a random point of the next safe circle. No enemy-coordinate
  // seek — gunfire (above) is the only evidence of where someone is; sight (the scan) does the rest
  if ((b.state === S.Loot || b.state === S.Roam) && geared && vit > 70 && m.phase === 2 && b.landedAt >= 0 && m.time - b.landedAt > 35 && ((m.tick + p.id) % 60) === 0 && b.rng.next() < b.aggro * 0.55) {
    const a = b.rng.next() * Math.PI * 2, radius = Math.min(m.storm.tr * 0.65, 60 + b.rng.next() * 120);
    const x = m.storm.tx + dmath.cos(a) * radius, z = m.storm.tz + dmath.sin(a) * radius;
    if (m.world.ground(x, z) > 1) { b.state = S.Hunt; b.tx = x; b.tz = z; b.roamT = 12; }
  }

  // trios: help a squadmate who is fighting nearby; never wander off alone
  if (m.mode === "trios" && (b.state === S.Loot || b.state === S.Roam) && ((m.tick + p.id) % 12) === 0) {
    let lead: Player | null = null, fightMate: Player | null = null;
    for (const q of m.players) {
      if (q === p || q.team !== p.team || !alive(q) || (q.st !== PS.Ground && q.st !== PS.Ride)) continue;   // (a squadmate who drives off is still the one to follow)
      if (!lead || q.id < lead.id) lead = q;
      const qb = m.brains[q.id];
      if (hasWeapon && vit > 50 && qb && qb.enemy >= 0 && dmath.hypot(q.x - p.x, q.z - p.z) < 170) fightMate = q;
    }
    if (fightMate) { const e = m.players[m.brains[fightMate.id]!.enemy]; b.state = S.Hunt; b.tx = e.x; b.tz = e.z; b.roamT = 10; }
    // only with a usable gun: an unarmed bot is put back to LOOT on its next think (state selection above) — else
    // it flips Hunt ↔ Loot every 0.5 s, walking to the lead's door then back to the loot, and never moves
    else if (hasWeapon && lead && lead.id < p.id && dmath.hypot(lead.x - p.x, lead.z - p.z) > (bestWeaponValue(p) >= 2 ? 60 : 150)) { b.state = S.Hunt; b.tx = lead.x + (b.rng.next() - 0.5) * 16; b.tz = lead.z + (b.rng.next() - 0.5) * 16; b.roamT = 8; }
  }

  // A thinned final field searches the next safe centre instead of touring unopened chests.
  // The destination is public storm information, never an unseen opponent's position.
  const closingDuel = m.phase === 2 && !m.resurgenceOn && squadsIn(m) <= 3;
  if (closingDuel && geared && !engage && b.state !== S.Heal && b.state !== S.Rotate) {
    if (b.state !== S.Hunt || b.roamT <= 0 || dmath.hypot(b.tx - m.storm.tx, b.tz - m.storm.tz) > m.storm.tr * 0.2) {
      const a = b.rng.next() * Math.PI * 2, r = Math.min(30, m.storm.tr * 0.15);
      b.tx = m.storm.tx + dmath.cos(a) * r; b.tz = m.storm.tz + dmath.sin(a) * r; b.roamT = 6;
    }
    b.state = S.Hunt; b.lootChest = b.lootItem = -1;
  }

  // chests are the dopamine: a bot that is roaming / hunting pops any closed chest within 40 m of it on the way
  if ((b.state === S.Roam || b.state === S.Hunt) && b.enemy < 0 && !closingDuel && ((m.tick + p.id) % 30) === 0 && !inStorm) {
    let bc = -1, bd = 40 * 40;
    for (const c of m.chests) { if (c.opened || (c.box && !lowAmmo(p))) continue; const d = dmath.pow(c.x - p.x, 2) + dmath.pow(c.z - p.z, 2); if (d < bd && Math.abs(c.y - p.y) < 2.5 && !gaveUpOn(b, c.id)) { bd = d; bc = c.id; } }
    if (bc >= 0) { b.state = S.Loot; b.lootChest = bc; b.lootItem = -1; b.lootT = 0; b.nearT = 0; }
  }
  inp.buttons &= ~(B.FIRE | B.SCOPE | B.CROUCH | B.SPRINT);
  if (b.boardVeh >= 0 && b.state !== S.Fight) board(m, p, b, inp);
  else if (b.detourT > 0 && travels(b)) { b.detourT -= dt; moveTo(m, p, b, inp, b.detourX, b.detourZ, true); }
  else switch (b.state) {
    case S.Fight: fight(m, p, b, inp, dt, w); break;
    case S.Heal: heal(m, p, b, inp, dt); break;
    case S.Rotate: {
      // a rotation that has made no net progress for 10 s heads for the public centre instead of the nearest edge
      if (b.idleT > 10) { b.tx = m.storm.tx; b.tz = m.storm.tz; }
      else { const a = dmath.atan2(p.z - m.storm.tz, p.x - m.storm.tx); b.tx = m.storm.tx + dmath.cos(a) * m.storm.tr * 0.45; b.tz = m.storm.tz + dmath.sin(a) * m.storm.tr * 0.45; }
      moveTo(m, p, b, inp, b.tx, b.tz, true); break;
    }
    case S.Hunt: { b.roamT -= dt; const d = dmath.hypot(b.tx - p.x, b.tz - p.z); if (d < 12 || b.roamT <= 0) { b.state = S.Loot; } moveTo(m, p, b, inp, b.tx, b.tz, d > 20); break; }
    case S.Loot: loot(m, p, b, inp, dt); break;
    default: roam(m, p, b, inp, dt);
  }
  // net progress (2 m): centimetres of wall rocking never reset it
  if (dmath.hypot(p.x - b.progressX, p.z - b.progressZ) > 2) { b.progressX = p.x; b.progressZ = p.z; b.idleT = 0; }
  b.idleT += dt;
  // stuck detection
  const moved = dmath.hypot(p.x - b.lastX, p.z - b.lastZ);
  if (moved < 0.15 * dt * 20 && (inp.mx !== 0 || inp.mz !== 0)) { b.stuckT += dt; if (b.stuckT > 0.8) { inp.buttons |= B.JUMP; b.turnBias = (b.rng.next() - 0.5) * 2.4; if (b.stuckT > 2.5) { b.stuckT = 0; if (b.state === S.Loot && (b.lootChest >= 0 || b.lootItem >= 0)) giveUp(b, "stuck"); b.lootChest = -1; b.lootItem = -1; b.roamT = 0; b.hasCover = false; } } }
  else b.stuckT = Math.max(0, b.stuckT - dt);
  b.lastX = p.x; b.lastZ = p.z;
  unstick(m, p, b, inp, dt);
}

// The long stuck check: a bot rocking at the foot of a slope / against a rock on the way
// (each think moves it a few metres — the short stuck check above and the 2 m idle clock never fire — but in 15 s it has
// got nowhere). Every 5 s: a travelling bot still within 6 m of where it was 15 s ago, with its goal farther than 10 m,
// takes a 6 s detour: 24 m along the best of 12 headings that is open at chest height, dry, and never steeper than 40°
// per 4 m (toward its goal first, with some randomness so a second attempt tries another way).
const travels = (b: BotBrain) => b.state === S.Rotate || b.state === S.Hunt || b.state === S.Roam;
function unstick(m: Match, p: Player, b: BotBrain, inp: Input, dt: number) {
  if (!travels(b) || p.st !== PS.Ground || b.boardVeh >= 0 || m.phase !== 2) { b.ringN = 0; b.ringT = 0; return; }
  if ((b.ringT += dt) < 5) return;
  b.ringT = 0;
  const k = b.ringN % 4, old = (b.ringN + 1) % 4;              // the slot written 15 s ago (once 4 are in)
  const stuck = b.ringN >= 3 && b.detourT <= 0 && dmath.hypot(p.x - b.ringX[old], p.z - b.ringZ[old]) < 6
    && dmath.hypot(b.tx - p.x, b.tz - p.z) > 10 && (inp.mx !== 0 || inp.mz !== 0);
  b.ringX[k] = p.x; b.ringZ[k] = p.z; b.ringN++;
  if (!stuck) { if (b.ringN > 6) b.detourFails = 0; return; }
  const tx = b.tx - p.x, tz = b.tz - p.z, tl = dmath.hypot(tx, tz) || 1, f = b.detourFails;
  let best = -1e9, bx = 0, bz = 0, ba = 0;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 + b.rng.next() * 0.4, fx = dmath.cos(a), fz = dmath.sin(a);
    m.world.raycast(p.x, p.y + 1.2, p.z, fx * 4, 0, fz * 4, 1, HIT, false); if (HIT.hit) continue;
    let ok = true, prev = Math.max(0, p.y);
    for (let s2 = 4; s2 <= 24 && ok; s2 += 4) { const g = m.world.ground(p.x + fx * s2, p.z + fz * s2); if (g < 0.5 || g - prev > 3.4 || g < prev - 9) ok = false; prev = g; }
    if (!ok) continue;
    const again = f > 0 && Math.abs(wrap(a - b.detourA)) < 0.7 ? 1.5 : 0;   // not the way that just failed
    const sc = (fx * tx + fz * tz) / tl / (1 + f) + b.rng.next() * 0.8 * (1 + f) - again;
    if (sc > best) { best = sc; bx = p.x + fx * 24; bz = p.z + fz * 24; ba = a; }
  }
  if (best < -1e8) return;
  b.detourX = bx; b.detourZ = bz; b.detourT = 6; b.ringN = 0; b.turnBias = 0; b.detourA = ba; b.detourFails = Math.min(3, f + 1);
  BOT_UNSTICK.n++;
}
/** detours taken (read by tools) */
export const BOT_UNSTICK = { n: 0, doors: 0 };

const SQ_SEEN = new Int32Array(256); let sqStamp = 0;
/** squads still in the match (Match.squadsLeft without its per-call Set: bots stay allocation-free) */
function squadsIn(m: Match): number {
  sqStamp++; let n = 0;
  for (const q of m.players) {
    if (!alive(q) && q.respawnAt < 0) continue;
    if (q.team < 0 || q.team >= SQ_SEEN.length) return m.squadsLeft();
    if (SQ_SEEN[q.team] !== sqStamp) { SQ_SEEN[q.team] = sqStamp; n++; }
  }
  return n;
}
function hasUsableWeapon(p: Player): boolean {
  for (const s of p.slots) if (s.kind === SK.Weapon && (s.mag > 0 || p.ammo[AMMO_IDX.indexOf(WEAPON_DEFS[WEAPONS[s.id]].ammo)] > 0)) return true;
  return false;
}
/** the held guns are short of reserve ammo (an ammo box is worth a detour) */
function lowAmmo(p: Player): boolean { for (const s of p.slots) if (s.kind === SK.Weapon && s.id !== 0) { const a = WEAPON_DEFS[WEAPONS[s.id]].ammo; if (p.ammo[AMMO_IDX.indexOf(a)] < (a === "rockets" ? 2 : a === "light" ? 60 : 12)) return true; } return false; }
function carriesAmmo(p: Player, ammo: string): boolean { for (const s of p.slots) if (s.kind === SK.Weapon && WEAPON_DEFS[WEAPONS[s.id]].ammo === ammo) return p.ammo[AMMO_IDX.indexOf(ammo)] < (ammo === "rockets" ? 6 : ammo === "light" ? 200 : 30); return false; }
/** warm-up on the islet: everyone mills about on their own (walk, pause, look around, hop) — no conga line behind the
 * nearest crate, no shooting (nothing counts yet) */
function warmup(m: Match, p: Player, b: BotBrain, inp: Input, dt: number) {
  inp.buttons &= ~(B.FIRE | B.SCOPE | B.CROUCH | B.SPRINT);
  b.roamT -= dt;
  const d = dmath.hypot(b.tx - p.x, b.tz - p.z);
  if (b.roamT <= 0 || d > 90) {
    // a fresh spot near where we stand (spawns are spread over the open sand), never someone else's
    for (let k = 0; k < 10; k++) {
      const a = b.rng.next() * Math.PI * 2, r = 5 + b.rng.next() * 16;
      const x = p.x + dmath.cos(a) * r, z = p.z + dmath.sin(a) * r;
      if (m.world.ground(x, z) > 0.4 && Math.abs(m.world.ground(x, z) - p.y) < 2.5) { b.tx = x; b.tz = z; break; }
    }
    b.roamT = 2.5 + b.rng.next() * 5; b.healT = b.rng.next() < 0.45 ? 0.8 + b.rng.next() * 2.2 : 0;   // healT = pause first
  }
  if (b.healT > 0) { b.healT -= dt; inp.mx = inp.mz = 0; inp.yaw += (b.id & 1 ? 1 : -1) * 0.6 * dt; inp.pitch = 0; return; }
  if (d < 1.5) { inp.mx = inp.mz = 0; b.roamT = Math.min(b.roamT, 0.6); return; }
  moveTo(m, p, b, inp, b.tx, b.tz, false);
  if (b.rng.next() < 0.004 * dt * 60) inp.buttons |= B.JUMP;
}
/** carrying a consumable that would still do something (a leaf bundle while hurt, a smoothie while the shield is down) */
function hasConsumable(p: Player): boolean {
  for (const s of p.slots) {
    if (s.kind !== SK.Consumable || s.count <= 0) continue;
    const c = CONSUMABLE_DEFS[CONSUMABLES[s.id]];
    if ((c.hp > 0 && p.hp < MAX_HP) || (c.shield > 0 && p.shield < MAX_SHIELD)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------- tuk-tuks
/** how near a squadmate's tuk-tuk must wait for this bot to walk over (m), how slow it must roll for that (m/s), and
 * how far / how long its horn calls the squad */
const TAXI_NEAR = 26, TAXI_SLOW = 3.5, TAXI_CALL = 85, TAXI_CALL_S = 30;
/** the tuk-tuk to board, or −1: upright and not burning, a HUMAN squadmate at the bars, a place free on the bench —
 * waiting nearby, or anywhere in earshot after its horn */
function taxiFor(m: Match, p: Player, b: BotBrain, dt: number): number {
  if (b.taxiT > 0) b.taxiT -= dt;
  let best = -1, bd = Infinity;
  for (const v of m.vehs.list) {
    if (!v.live || v.kind !== VKind.Tuk || v.st !== VS.Ok || (v.flags & VF.BURN) || v.seats[0] < 0 || (v.seats[1] >= 0 && v.seats[2] >= 0)) continue;
    const d = m.players[v.seats[0]]; if (!d || d.bot || d.team !== p.team) continue;
    const dist = dmath.hypot(v.x - p.x, v.z - p.z); if (dist > TAXI_CALL || Math.abs(v.y - p.y) > 6) continue;
    if (v.flags & VF.HORN) b.taxiT = TAXI_CALL_S;
    if (dist < bd && (b.taxiT > 0 || (dist < TAXI_NEAR && dmath.hypot(v.vx, v.vz) < TAXI_SLOW))) { bd = dist; best = v.id; }
  }
  return best;
}
/** run to the bench's nearer flank and climb on (E under the crosshair — Match.useVehicle) */
function board(m: Match, p: Player, b: BotBrain, inp: Input) {
  const v = m.vehs.list[b.boardVeh], sy = dmath.sin(v.yaw), cy = dmath.cos(v.yaw);
  // body frame → world: right = (cy, −sy), back = (sy, cy); the bench is 0.74 m behind the middle
  const side = (p.x - v.x) * cy - (p.z - v.z) * sy >= 0 ? 1 : -1;
  const tx = v.x + cy * side * 1.7 + sy * 0.7, tz = v.z - sy * side * 1.7 + cy * 0.7;
  const d = dmath.hypot(tx - p.x, tz - p.z);
  if (footDist(v, p.x, p.z) < TUK.REACH - 0.25) {
    const dx = v.x + sy * 0.7 - p.x, dz = v.z + cy * 0.7 - p.z;
    inp.mx = inp.mz = 0; inp.yaw = dmath.atan2(-dx, -dz); inp.pitch = dmath.atan2(v.y + 0.9 - eyeY(p), Math.max(0.6, dmath.hypot(dx, dz)));
    if (((m.tick / 9) | 0) % 2 === 0) inp.buttons |= B.USE;
    return;
  }
  moveTo(m, p, b, inp, tx, tz, d > 5);
}
/** on the bench: watch the flank, shoot what the scan found (fight()'s aim and trigger, no footwork), and get off when
 * nobody drives any more, the driver is not a squadmate, or it burns. C would swap seats and E gets off — never held */
function ride(m: Match, p: Player, b: BotBrain, inp: Input, dt: number, w: ReturnType<typeof weaponDef>, engage: boolean) {
  const v = m.vehs.list[p.veh];
  inp.mx = inp.mz = 0; inp.buttons &= ~(B.FIRE | B.SCOPE | B.CROUCH | B.SPRINT | B.JUMP | B.USE);
  b.boardVeh = -1; b.lootChest = b.lootItem = -1;
  const drv = v && v.seats[0] >= 0 ? m.players[v.seats[0]] : null, burning = !!v && (v.flags & VF.BURN) !== 0;
  const stay = p.seat > 0 && !!drv && drv.team === p.team && !burning;
  let off = false;
  if (stay) b.rideT = 0;
  else { b.rideT += dt; if (b.rideT > (burning || p.seat === 0 ? 0.25 : 1.4)) { off = true; b.rideT = 0; } }
  if (engage && w) { b.state = S.Fight; fight(m, p, b, inp, dt, w); inp.mx = inp.mz = 0; inp.buttons &= ~(B.CROUCH | B.SPRINT | B.JUMP | B.USE); }
  else {
    b.state = S.Roam;
    const want = (v ? v.yaw : p.yaw) + (p.seat === 1 ? 1 : -1) * 0.95 + dmath.sin(m.time * 0.6 + b.id * 1.7) * 0.55;
    const k = 1 - dmath.exp(-dt * 4);
    inp.yaw = p.yaw + wrap(want - p.yaw) * k; inp.pitch = p.pitch * (1 - k);
    const s = p.slots[p.active];
    if (w && s.kind === SK.Weapon && s.mag < w.mag * 0.5 && p.reloadT <= 0) inp.buttons |= B.RELOAD;
  }
  if (off) inp.buttons |= B.USE;
}

function fight(m: Match, p: Player, b: BotBrain, inp: Input, dt: number, w: ReturnType<typeof weaponDef>) {
  const e = m.players[b.enemy]; if (!e || !alive(e) || e.team === p.team) { b.enemy = -1; b.hasCover = false; return; }
  b.reactT -= dt; b.engagedT += dt;
  let dx = e.x - p.x, dz = e.z - p.z;
  const dist = dmath.hypot(dx, dz);
  let aimH = b.headAim ? (e.crouch ? 1.1 : 1.62) : (e.crouch ? 0.8 : 1.15);
  const pj = w?.projectile;
  if (pj) {
    // rockets: into the ground at the feet (the 3.8 m splash forgives a strafe) when the feet are in sight, else at
    // the hips; leading a moving target by the flight time, lifted for the drop
    const tf = dist / pj.speed;
    dx += e.vx * tf * 0.85; dz += e.vz * tf * 0.85;
    const feet = m.world.clear(p.x, eyeY(p), p.z, p.x + dx, e.y + 0.35, p.z + dz);
    aimH = (feet ? 0.05 : 0.85) + 0.5 * pj.gravity * tf * tf;
  }
  const dy = (e.y + aimH) - eyeY(p);
  // pick a better weapon for the range
  const bestSlot = pickWeaponSlot(p, dist); if (bestSlot >= 0 && bestSlot !== p.active) inp.slot = bestSlot;
  // aim error: settles (exp decay) onto a slow per-bot drift around the target whose size is the skill floor — a
  // crosshair that wanders off and back like a hand, not per-tick jitter; moving makes it worse
  const settle = dmath.exp(-dt * (1.6 + 2.2 * b.skill));
  const floor = (0.008 + (1 - b.skill) * 0.018 + (dmath.hypot(p.vx, p.vz) > 1 ? 0.005 : 0)) * BOT_DIFFICULTY[b.difficulty].aimError;
  b.errYaw = b.errYaw * settle + dmath.sin(m.time * 1.7 + b.id * 2.3) * floor * (1 - settle);
  b.errPitch = b.errPitch * settle + dmath.sin(m.time * 1.3 + b.id * 1.9) * floor * 0.65 * (1 - settle);
  const tgtYaw = dmath.atan2(-dx, -dz), tgtPitch = dmath.atan2(dy, dist);
  // the scope sway a player fights is on the bots' crosshair too — strongest right after scoping
  // in and after each bolt; the trigger waits until the sway carries the crosshair back onto the body (onTarget below)
  let swY = 0, swP = 0;
  if (p.scoped && w?.scope) {
    if (b.scopedAt < 0) b.scopedAt = m.time;
    if (p.shotAgo < DT * 1.5) b.scopedAt = m.time + 60 / w.rpm;
    scopeSway(m.time, m.time - b.scopedAt, SWAY); swY = SWAY[0] * DEG; swP = SWAY[1] * DEG;
  } else b.scopedAt = -1;
  const wantYaw = tgtYaw + b.errYaw + swY, wantPitch = tgtPitch + b.errPitch + swP;
  // smooth turn (humans do not snap)
  const turn = 1 - dmath.exp(-dt * (9 + 12 * b.skill));
  b.aimYaw = p.yaw + wrap(wantYaw - p.yaw) * turn; b.aimPitch = p.pitch + (wantPitch - p.pitch) * turn;
  inp.yaw = b.aimYaw; inp.pitch = b.aimPitch;
  // pull the trigger once the crosshair is roughly on the body (tolerance = the target's angular half-width + slop)
  const tol = dmath.atan2(0.5, Math.max(1, dist)) + 0.02 + (1 - b.skill) * 0.03;
  const onTarget = Math.abs(wrap(tgtYaw - b.aimYaw)) < tol && Math.abs(tgtPitch - b.aimPitch) < tol * 1.6;
  const s = p.slots[p.active];
  const vit = p.hp + p.shield, evit = e.hp + e.shield;
  if (w && s.kind === SK.Weapon) {
    if (s.mag === 0) inp.buttons |= B.RELOAD;
    // (the SMG falls off from 12 m and blooms wide — no hosing past 60 m)
    else if (b.reactT <= 0 && onTarget && dist < (w.id === "shotgun" ? 26 : w.id === "sniper" ? 320 : w.id === "pistol" ? 90 : w.id === "smg" ? 60 : w.id === "rocket" ? 62 : 140)
      // a rocket needs a clear flight path (a crouched bot behind cover blew itself up on the cover) and some room
      && (w.id !== "rocket" || (dist > 9 && m.world.clear(p.x, eyeY(p), p.z, p.x + dx, e.y + Math.max(0.35, aimH), p.z + dz)))) {
      // fire discipline for the handling model (bloom per shot, first-shot accuracy on the AR / pistol):
      // close = hold the trigger; mid range = bursts that shorten with skill and
      // range; long range = a skilled bot taps (waits ~0.28 s so every shot is a first shot), an average one bursts
      const tapGun = w.id === "ar" || w.id === "pistol";
      if (tapGun && dist > 35 && b.skill > 0.55) { if (p.shotAgo >= 0.28 && ((m.tick / 2) | 0) % 2 === 0) inp.buttons |= B.FIRE; }
      else if (w.auto) {
        b.fireHold -= dt;
        const burst = dist < 15 ? 0.45 : dist < 40 ? 0.16 + b.rng.next() * 0.16 : 0.08 + b.rng.next() * 0.1;
        const pause = dist < 15 ? 0.05 : 0.2 + (1 - b.skill) * 0.3;   // seconds off the trigger between bursts
        if (b.fireHold <= -pause) b.fireHold = burst;
        if (b.fireHold > 0) inp.buttons |= B.FIRE;
      }
      else if (((m.tick / 3) | 0) % 2 === 0) inp.buttons |= B.FIRE;
      if (w.id === "sniper" && dist > 40) inp.buttons |= B.SCOPE;
      // aim down sights beyond close range with the hitscan primaries (a tighter cone while standing / strafing)
      else if (w.id !== "shotgun" && w.id !== "rocket" && dist > 12) inp.buttons |= B.SCOPE;
    }
  }
  // ---- movement: cover when hurt / reloading, push when winning, strafe otherwise
  const reloading = p.reloadT > 0 || (s.kind === SK.Weapon && s.mag === 0);
  const hurt = vit < 45 + 30 * (1 - b.aggro);
  if ((hurt || reloading) && !b.hasCover && b.coverT <= 0) { findCover(m, p, e, b); b.coverT = 0.8; }
  b.coverT -= dt;
  if ((hurt || reloading) && b.hasCover) {
    const cd = dmath.hypot(b.coverX - p.x, b.coverZ - p.z);
    if (cd > 1.2) { moveToward(p, inp, b.coverX, b.coverZ, true); inp.yaw = b.aimYaw; avoidHazards(m, p, inp); return; }
    inp.mx = 0; inp.mz = 0; inp.buttons |= B.CROUCH;
    // out of sight + hurt: heal (the heal state takes over once the enemy loses us)
    if (hurt && hasConsumable(p) && !m.world.clear(p.x, eyeY(p), p.z, e.x, e.y + 1.4, e.z)) { b.enemySeenT = 3; b.state = S.Heal; }
    return;
  }
  if (!hurt && !reloading) b.hasCover = false;
  b.strafeT -= dt; if (b.strafeT <= 0) { b.strafe = b.rng.next() < 0.5 ? -1 : 1; b.strafeT = 0.5 + b.rng.next() * 1.2; }
  const pref = w?.id === "shotgun" ? 7 : w?.id === "sniper" ? 90 : w?.id === "smg" ? 14 : 24;
  const pushing = evit < vit * 0.6 || (e.anim & 1) !== 0 || (b.aggro > 0.75 && evit < vit);
  inp.mx = b.strafe * (0.6 + 0.4 * b.rng.next());
  inp.mz = pushing ? (dist > 4 ? 1 : 0) : dist > pref * 1.3 ? 0.9 : dist < pref * 0.6 ? -0.6 : 0;
  if (pushing && dist > 18) { inp.buttons |= B.SPRINT; inp.mx *= 0.3; }
  else if (dist > 60 && !onTarget) inp.buttons |= B.SPRINT;
  if (dist < 20 && b.rng.next() < 0.05 * dt * 60) inp.buttons |= B.JUMP;
  if (dist > 60 && w?.id === "sniper" && b.rng.next() < 0.2) inp.buttons |= B.CROUCH;
  avoidHazards(m, p, inp);
}
/** a spot 5-14 m away that breaks line of sight to the enemy (8 probes, reused registers) */
function findCover(m: Match, p: Player, e: Player, b: BotBrain) {
  b.hasCover = false;
  const base = dmath.atan2(p.z - e.z, p.x - e.x);
  let best = 1e9;
  for (let i = 0; i < 8; i++) {
    const a = base + (i - 3.5) * 0.55, r = 5 + (i % 3) * 4.5;
    const x = p.x + dmath.cos(a) * r, z = p.z + dmath.sin(a) * r, g = m.world.ground(x, z);
    if (g < 0.3 || Math.abs(g - p.y) > 4) continue;
    if (m.world.clear(x, g + 1.2, z, e.x, e.y + 1.4, e.z)) continue;           // still exposed
    m.world.raycast(p.x, p.y + 0.9, p.z, x - p.x, 0, z - p.z, 1, HIT, false);    // reachable in a straight line?
    if (HIT.hit && HIT.t < 0.85) continue;
    const cost = r + Math.abs(i - 3.5);
    if (cost < best) { best = cost; b.coverX = x; b.coverZ = z; b.hasCover = true; }
  }
}
/** how much a bot wants a weapon, independent of range (loot decisions): pistol < smg ≈ sniper < shotgun < ar < rocket */
const WEAPON_VALUE: Record<string, number> = { pistol: 1, smg: 2.2, sniper: 2.3, shotgun: 2.4, ar: 2.8, rocket: 2.9 };
export const weaponValue = (sub: number, rarity: number) => (WEAPON_VALUE[WEAPONS[sub]] ?? 1) * (1 + 0.12 * rarityTier(rarity));
function bestWeaponValue(p: Player): number {
  let v = 0; for (const s of p.slots) if (s.kind === SK.Weapon) v = Math.max(v, weaponValue(s.id, s.rarity)); return v;
}
/** the weapon slot a bot would give up for a better gun (its weakest weapon; -1 = no weapon) */
function weakestWeaponSlot(p: Player): number {
  let wi = -1, wv = 1e9;
  for (let i = 0; i < p.slots.length; i++) { const s = p.slots[i]; if (s.kind === SK.Weapon) { const v = weaponValue(s.id, s.rarity); if (v < wv) { wv = v; wi = i; } } }
  return wi;
}
function hasEmptySlot(p: Player): boolean { for (const s of p.slots) if (s.kind === SK.Empty) return true; return false; }
function firstEmptySlot(p: Player): number { for (let i = 0; i < p.slots.length; i++) if (p.slots[i].kind === SK.Empty) return i; return -1; }
function holdsWeapon(p: Player, sub: number): boolean { for (const s of p.slots) if (s.kind === SK.Weapon && s.id === sub) return true; return false; }
/** is floor weapon (sub, rarity) worth walking to: an empty slot, or better than the weakest gun held */
function wantsWeapon(p: Player, sub: number, rarity: number): boolean {
  if (hasEmptySlot(p)) return true;
  const wi = weakestWeaponSlot(p);
  let nW = 0; for (const s of p.slots) if (s.kind === SK.Weapon) nW++;
  if (wi < 0 || nW < 2) return true;                                           // swap a consumable slot
  return weaponValue(sub, rarity) > weaponValue(p.slots[wi].id, p.slots[wi].rarity) + 0.25;
}
/** Total-ammo exhaustion only: a real loaded/spawned magazine can restore the ability to fire.
 * Ordinary usable-inventory swaps still use wantsWeapon and their original weakest-slot preference.
 * (Item.loaded is set by the loot-conservation drops; without it every floor gun counts as loaded, as pickup refills it.) */
function recoveryWeaponSlot(p: Player, it: Item): number {
  if ((it.loaded ?? WEAPON_DEFS[WEAPONS[it.sub]].mag) <= 0) return -1;
  const empty = firstEmptySlot(p);
  if (empty >= 0) return empty;
  // Recover a spent counterpart without a rarity downgrade or consuming a heal slot.
  for (let i = 0; i < p.slots.length; i++) {
    const s = p.slots[i];
    if (s.kind === SK.Weapon && s.id === it.sub && s.mag === 0 && s.rarity <= it.rarity) return i;
  }
  if (!wantsWeapon(p, it.sub, it.rarity)) return -1;
  let give = weakestWeaponSlot(p), nW = 0; for (const s of p.slots) if (s.kind === SK.Weapon) nW++;
  if (nW < 2) {
    // A rejected lower-rarity counterpart must not fall through to sacrificing a consumable for the duplicate.
    if (holdsWeapon(p, it.sub)) return -1;
    for (let i = p.slots.length - 1; i >= 0; i--) if (p.slots[i].kind === SK.Consumable) { give = i; break; }
  }
  return give;
}
/** E takes the nearest reachable weapon, regardless of aim. Guard exhaustion swaps against a different floor gun. */
function nearestRecoveryWeapon(m: Match, p: Player): Item | null {
  let best: Item | null = null, bd = PICKUP_DIST + 0.5;
  for (const it of m.items) {
    if (it.taken || it.kind !== IK.Weapon) continue;
    const d = dmath.hypot3(it.x - p.x, it.z - p.z, (it.y - p.y) * 0.6);
    if (d < bd && lootReachable(m.world, p.x, p.y, p.z, it.x, it.y, it.z)) { bd = d; best = it; }
  }
  return best;
}
function recoveryDiscarded(b: BotBrain, id: number): boolean { for (let i = 0; i < b.recoveryDiscards.length; i++) if (b.recoveryDiscards[i] === id) return true; return false; }
function pickWeaponSlot(p: Player, dist: number): number {
  let best = -1, bs = -1;
  for (let i = 0; i < p.slots.length; i++) {
    const s = p.slots[i];
    if (s.kind !== SK.Weapon) continue;
    const w = WEAPON_DEFS[WEAPONS[s.id]];
    // DPS at THIS range — the real falloff (pelletDamage), so a bot holding an SMG and an AR
    // takes the AR past ~25 m and the pump only up close
    let score = pelletDamage(w, s.rarity, dist, 0) * w.pellets * (w.rpm / 60);
    // the right tool for the range: shotgun up close, sniper far, AR everywhere, rockets into a fight at mid range
    if (dist > 30 && w.id === "shotgun") score *= 0.15; if (dist < 12 && w.id === "shotgun") score *= 1.6;
    if (w.id === "sniper") score = dist < 20 ? 15 : dist < 60 ? 150 : 420;
    if (dist > 80 && (w.id === "smg" || w.id === "pistol")) score *= 0.4;
    if (dist > 130 && w.id === "ar") score *= 0.6;
    if (w.id === "rocket") score = dist > 10 && dist < 55 ? 320 : dist < 90 ? 120 : 5;
    if (s.mag === 0 && p.ammo[AMMO_IDX.indexOf(w.ammo)] === 0) score = 0;
    if (score > bs) { bs = score; best = i; }
  }
  return best;
}
function heal(m: Match, p: Player, b: BotBrain, inp: Input, dt: number) {
  let idx = -1, best = 0;
  for (let i = 0; i < p.slots.length; i++) {
    const s = p.slots[i]; if (s.kind !== SK.Consumable || s.count <= 0) continue;
    const c = CONSUMABLE_DEFS[CONSUMABLES[s.id]];
    const gain = Math.min(c.hp, MAX_HP - p.hp) * 1.2 + Math.min(c.shield, MAX_SHIELD - p.shield);
    if (gain > best) { best = gain; idx = i; }
  }
  if (idx < 0) { b.state = S.Loot; return; }
  inp.slot = idx; inp.mx = 0; inp.mz = 0; inp.buttons |= B.CROUCH;
  b.healT += dt;
  if (p.active === idx && p.useT <= 0 && b.healT > 0.3) { inp.buttons |= B.FIRE; b.healT = 0; }
  if ((p.hp >= MAX_HP - 1 && p.shield >= 50) || (p.useT <= 0 && b.healT > 1.2)) { b.state = S.Loot; b.healT = 0; for (let i = 0; i < p.slots.length; i++) if (p.slots[i].kind === SK.Weapon) { inp.slot = i; break; } }
  void m;
}
/** loot on a structure above the bot (a deck, a ship, a rock shelf) that the indoor walk graph does not lead to: the
 * outdoor steering cannot climb there — leave it to someone who is up there already */
function perched(m: Match, p: Player, x: number, y: number, z: number): boolean {
  if (y - p.y <= 1.6 || y - m.world.ground(x, z) < 0.8) return false;
  return navCellAt(lootSpots(m.world).nav, x, y, z) < 0;
}
function gaveUpOn(b: BotBrain, code: number): boolean { for (let i = 0; i < b.gaveUp.length; i++) if (b.gaveUp[i] === code) return true; return false; }
/** loot claims: is another living bot already going for this target (chest id / -1 - item id)? Without it squads
 * land on the same chest and two of the three stay unarmed. Read off the other brains' live targets, so a claim
 * ends the moment that bot drops or takes it. */
export function claimedByOther(m: Match, key: number, me: number): boolean {
  for (let i = 0; i < m.brains.length; i++) {
    const o = m.brains[i]; if (!o || i === me || !alive(m.players[i])) continue;
    if ((key >= 0 && o.lootChest === key) || (key < 0 && o.lootItem === -1 - key)) return true;
  }
  return false;
}
/** why bots dropped loot targets (diagnostics) */
export const BOT_GIVEUP = { stuck: 0, timeout: 0, noPath: 0, blocked: 0, noProgress: 0, nearNoOpen: 0 };
const SWAY = [0, 0], DEG = Math.PI / 180;
function giveUp(b: BotBrain, why?: keyof typeof BOT_GIVEUP) {
  if (why) BOT_GIVEUP[why]++; b.gaveUp[b.gaveUpI++ & 15] = b.lootChest >= 0 ? b.lootChest : b.lootItem >= 0 ? -1 - b.lootItem : -99999; b.lootChest = -1; b.lootItem = -1; b.recoveryItem = -1; }
function loot(m: Match, p: Player, b: BotBrain, inp: Input, dt: number) {
  b.lootT += dt;
  const exhausted = !hasUsableWeapon(p);
  // Attribute actual post-simulation drops, never predict a globally allocated item ID.
  // An acquisition plus our resulting slot and the discarded gun's owner/type/rarity/time witness the swap.
  if (b.recoverySwapItem >= 0) {
    const acquired = m.itemById(b.recoverySwapItem), slot = p.slots[b.recoverySwapSlot];
    if (acquired && acquired.taken && slot && slot.kind === SK.Weapon && slot.id === acquired.sub && slot.rarity === acquired.rarity) {
      for (let i = b.recoverySwapStart; i >= 0 && i < m.items.length; i++) {
        const dropped = m.items[i];
        if (!dropped.taken && dropped.kind === IK.Weapon && dropped.loaded === 0 && dropped.dropper === p.id && dropped.sub === b.recoverySwapSub && dropped.rarity === b.recoverySwapRarity && dropped.bornAt === b.recoverySwapAt) { b.recoveryDiscards[b.recoveryDiscardI++ & 3] = dropped.id; break; }
      }
    }
    b.recoverySwapItem = b.recoverySwapSlot = b.recoverySwapSub = b.recoverySwapStart = -1; b.recoverySwapRarity = 0; b.recoverySwapAt = -1;
  }
  for (let i = 0; i < b.recoveryDiscards.length; i++) {
    const id = b.recoveryDiscards[i]; if (id < 0) continue;
    const dropped = m.itemById(id);
    if (!dropped || dropped.taken || dropped.dropper !== p.id) b.recoveryDiscards[i] = -1;
  }
  if (b.lootChest < 0 && b.lootItem < 0) {
    // nearest useful target, weighted: an unarmed bot runs for a weapon; chests are always attractive
    // "armed" = a real gun: everyone drops with the NUB sidearm and should still run for something better first
    const armed = !exhausted && bestWeaponValue(p) >= 2, full = !hasEmptySlot(p);
    const heldAmmo = weaponDef(p)?.ammo;
    // (the nearest gun can be 100 m+ away — an unarmed bot keeps going for one)
    let bc = -1, bi = -1, bestCost = armed ? 130 : 320;
    const dyMax = armed ? 7.5 : 12;
    const ammoLow = (armed || exhausted) && lowAmmo(p);
    for (const c of m.chests) {
      // an ammo box (it holds no weapon) for a bot short of ammo for its real guns — even when they are empty
      if (c.opened || (c.box && !ammoLow)) continue;
      const d = Math.abs(c.x - p.x) + Math.abs(c.z - p.z); if (d > bestCost * 1.5) continue;
      const dy = Math.abs(c.y - p.y); if (dy > dyMax || gaveUpOn(b, c.id) || perched(m, p, c.x, c.y, c.z)) continue;
      let cost = dmath.hypot(c.x - p.x, c.z - p.z) * (c.box ? 1.4 : armed ? 1 : 0.9) + dy * 4;
      if (cost < bestCost && claimedByOther(m, c.id, p.id)) cost = cost * 2.5 + 20;   // someone is already on it
      if (cost < bestCost) { bestCost = cost; bc = c.id; bi = -1; }
    }
    for (const it of m.items) {
      if (it.taken || ((recoveryDiscarded(b, it.id) && it.dropper === p.id) || (exhausted && it.dropper === p.id && dmath.hypot(it.x - p.x, it.z - p.z) <= PICKUP_DIST + 1))) continue;
      const d0 = Math.abs(it.x - p.x) + Math.abs(it.z - p.z); if (d0 > bestCost * 1.5) continue;
      let wgt = 1;
      if (it.kind === IK.Weapon) { if (exhausted ? recoveryWeaponSlot(p, it) < 0 : armed && !wantsWeapon(p, it.sub, it.rarity)) continue; wgt = armed ? (full ? 1.1 : 1.3) : 0.55; }
      else if (it.kind === IK.Cash) continue;   // bots do not go shopping
      else if (it.kind === IK.Consumable && !CONSUMABLE_DEFS[CONSUMABLES[it.sub]].hp && !CONSUMABLE_DEFS[CONSUMABLES[it.sub]].shield) continue;   // nor throw bombs
      else if (it.kind === IK.Ammo) { if ((!armed && !exhausted) || !carriesAmmo(p, AMMO_IDX[it.sub])) continue; wgt = AMMO_IDX[it.sub] === heldAmmo || AMMO_IDX[it.sub] === "rockets" ? 1.3 : 1.7; }
      else { if (full || (p.hp >= MAX_HP && p.shield >= 100)) continue; wgt = 1.2; }
      const dy = Math.abs(it.y - p.y); if (dy > dyMax || gaveUpOn(b, -1 - it.id) || perched(m, p, it.x, it.y, it.z)) continue;
      let cost = dmath.hypot(it.x - p.x, it.z - p.z) * wgt + dy * 4;
      if (cost < bestCost && claimedByOther(m, -1 - it.id, p.id)) cost = cost * 2.5 + 20;
      if (cost < bestCost) { bestCost = cost; bi = it.id; bc = -1; }
    }
    if (bc >= 0) b.lootChest = bc; else if (bi >= 0) b.lootItem = bi;
    else { b.state = S.Roam; b.roamT = 0; roam(m, p, b, inp, dt); return; }
    b.lootT = 0; b.nearT = 0; b.recoveryItem = -1;
  }
  const c = b.lootChest >= 0 ? m.chests[b.lootChest] : null;
  const it = b.lootItem >= 0 ? m.itemById(b.lootItem) : null;
  if ((c && c.opened) || (b.lootItem >= 0 && (!it || it.taken))) { b.lootChest = -1; b.lootItem = -1; b.recoveryItem = -1; return; }
  if (exhausted && it && it.kind === IK.Weapon) b.recoveryItem = it.id;
  // If ammunition arrives en route, release an exhaustion-only target that ordinary policy would refuse.
  if (!exhausted && it && b.recoveryItem === it.id && !wantsWeapon(p, it.sub, it.rarity)) { giveUp(b); return; }
  const tx = c ? c.x : it ? it.x : p.x, ty = c ? c.y : it ? it.y : p.y, tz = c ? c.z : it ? it.z : p.z;
  if (b.lootT > 18) { giveUp(b, "timeout"); return; }
  // the goal: a chest's validated stand place (in reach, eyes clear — never the far side of a post or a rail), else the
  // item itself. Indoor goals route through the building's walk graph (door → rooms → stairs); outdoor ones steer.
  const gx = c && c.sx !== undefined ? c.sx : tx, gy = c && c.sy !== undefined ? c.sy : ty, gz = c && c.sz !== undefined ? c.sz : tz;
  const key = c ? c.id : -1 - b.lootItem;
  if (b.pathKey !== key) {
    b.pathKey = key; b.pathI = 0; b.pathN = 0; b.bestD = Infinity; b.progT = 0; b.blockedT = 0;
    const nav = lootSpots(m.world).nav, tc = navCellAt(nav, gx, gy, gz);
    if (tc >= 0) { b.pathN = navPath(nav, p.x, p.y, p.z, tc, b.path, m.world.terrain); if (!b.pathN) { giveUp(b, "noPath"); return; } }
  }
  const d = dmath.hypot(tx - p.x, tz - p.z), dg = dmath.hypot(gx - p.x, gz - p.z);
  const close = (d < 1.9 || dg < 0.7) && Math.abs(ty - p.y) < 1.4 && lootReachable(m.world, p.x, p.y, p.z, tx, ty, tz);
  // right next to it but it cannot be used from here (the far side of a wall, the floor below) and the
  // stand place is not being reached: drop it after 1.5 s instead of parking there
  if (!close && d < 2.8 && dg > 0.7) { if ((b.blockedT += dt) > 1.5) { giveUp(b, "blocked"); return; } } else b.blockedT = 0;
  // no progress for 4 s (circling at a wall, a ledge it cannot climb): try something else
  const walk = b.pathI < b.pathN ? (b.pathN - b.pathI) * 1.25 + dmath.hypot(b.path[b.pathI * 3] - p.x, b.path[b.pathI * 3 + 2] - p.z) : dg + Math.abs(gy - p.y);
  if (walk < b.bestD - 0.75) { b.bestD = walk; b.progT = 0; } else if (!close && (b.progT += dt) > 4) { giveUp(b, "noProgress"); return; }
  if (!close && b.pathI < b.pathN) { b.nearT = 0; followPath(m, p, b, inp); return; }
  if (!close) {
    // the last metres to the stand place: straight at it (probing steering would swerve off a wall beside it)
    b.nearT = 0;
    if (dg < 3.5) { inp.yaw = dmath.atan2(-(gx - p.x), -(gz - p.z)); inp.pitch = 0; inp.mz = 1; inp.mx = 0; if (gy - p.y > 0.45 && dg < 1.6) inp.buttons |= B.JUMP; }
    else moveTo(m, p, b, inp, gx, gz, dg > 12);
    return;
  }
  if (close) {
    b.nearT += dt;
    inp.mx = 0; inp.mz = 0;
    if (c && ((m.tick / 3) | 0) % 3 === 0) inp.buttons |= B.USE;         // floor items are auto-picked up (or swapped below)
    if (it && it.kind === IK.Weapon && exhausted) {
      const give = recoveryWeaponSlot(p, it);
      if (give < 0) { giveUp(b); return; }
      const duplicate = holdsWeapon(p, it.sub);
      // Nonduplicates with space retain auto-pickup. Only exhaustion recovery enables E for an empty-slot duplicate.
      if (!hasEmptySlot(p) || duplicate) {
        if (nearestRecoveryWeapon(m, p) === it) {
          inp.slot = give;
          if (p.active === give && p.swapT <= 0 && ((m.tick / 3) | 0) % 3 === 0) {
            inp.buttons |= B.USE;
            if (!hasEmptySlot(p) && p.slots[give].kind === SK.Weapon && p.slots[give].mag === 0) {
              b.recoverySwapItem = it.id; b.recoverySwapSlot = give; b.recoverySwapSub = p.slots[give].id;
              b.recoverySwapRarity = p.slots[give].rarity; b.recoverySwapAt = m.time; b.recoverySwapStart = m.items.length;
            }
          }
        }
      }
    } else {
      // full hands: hold the slot to give up (the weakest gun, or a consumable while carrying < 2 guns), then take it
      if (it && it.kind === IK.Weapon && !hasEmptySlot(p)) {
        if (!wantsWeapon(p, it.sub, it.rarity)) b.lootItem = -1;
        else {
          let give = weakestWeaponSlot(p), nW = 0; for (const q of p.slots) if (q.kind === SK.Weapon) nW++;
          if (nW < 2) for (let i = p.slots.length - 1; i >= 0; i--) if (p.slots[i].kind === SK.Consumable) { give = i; break; }
          if (give >= 0) inp.slot = give;
          if (p.active === give && p.swapT <= 0) inp.buttons |= B.USE;
        }
      }
    }
    inp.yaw = dmath.atan2(-(tx - p.x), -(tz - p.z)); inp.pitch = -0.4;
    if (b.nearT > 2.5) giveUp(b, "nearNoOpen");
  }
}
/** follow the indoor route: steer at the next waypoint (the outdoor leg to the door with the usual probes), skip ahead
 * while a later waypoint on the same level is in a clear straight line */
function followPath(m: Match, p: Player, b: BotBrain, inp: Input) {
  const P = b.path;
  while (b.pathI < b.pathN) {
    const i = b.pathI * 3;
    if (dmath.hypot(P[i] - p.x, P[i + 2] - p.z) < 0.6 && Math.abs(P[i + 1] - p.y) < 1.2) b.pathI++; else break;
  }
  // skip ahead along a clear straight line: same level, two knee-high rays at the capsule's edges, floor under the
  // middle and the end of the shortcut (never across a stairwell or off a balcony)
  for (let k = 0; k < 8 && b.pathI + 1 < b.pathN; k++) {
    const j = (b.pathI + 1) * 3;
    if (Math.abs(P[j + 1] - p.y) > 0.3 || Math.abs(P[b.pathI * 3 + 1] - p.y) > 0.3) break;
    const dx = P[j] - p.x, dz = P[j + 2] - p.z, l = dmath.hypot(dx, dz) || 1, ox = -dz / l * 0.34, oz = dx / l * 0.34;
    m.world.raycast(p.x + ox, p.y + 0.45, p.z + oz, dx, 0, dz, 1, HIT, false); if (HIT.hit) break;
    m.world.raycast(p.x - ox, p.y + 0.45, p.z - oz, dx, 0, dz, 1, HIT, false); if (HIT.hit) break;
    m.world.raycast(p.x + dx * 0.5, p.y + 0.4, p.z + dz * 0.5, 0, -1, 0, 1.0, HIT, false); if (!HIT.hit) break;
    b.pathI++;
  }
  if (b.pathI >= b.pathN) return;
  const i = b.pathI * 3, wx = P[i], wy = P[i + 1], wz = P[i + 2], d = dmath.hypot(wx - p.x, wz - p.z);
  // an outdoor leg (to a door's outside point, still a few metres away): the usual steering with probes
  if (d > 3 && navCellAt(lootSpots(m.world).nav, p.x, p.y, p.z) < 0) { moveTo(m, p, b, inp, wx, wz, d > 12); return; }
  inp.yaw = dmath.atan2(-(wx - p.x), -(wz - p.z)); inp.pitch = 0; inp.mz = 1; inp.mx = 0;
  if (wy - p.y > 0.45 && d < 1.6) inp.buttons |= B.JUMP;       // a tall step / ledge on the route
  inp.buttons &= ~B.SPRINT; if (d > 5) inp.buttons |= B.SPRINT;
}
function roam(m: Match, p: Player, b: BotBrain, inp: Input, dt: number) {
  b.roamT -= dt;
  // an unarmed bot never just wanders: it looks for a weapon again every second on the way
  if (m.phase === 2 && ((m.tick + p.id) % 30) === 0 && !(hasUsableWeapon(p) && bestWeaponValue(p) >= 2)) { b.state = S.Loot; b.lootChest = -1; b.lootItem = -1; }
  const d = dmath.hypot(b.tx - p.x, b.tz - p.z);
  if (!m.resurgenceOn && m.phase === 2) {
    // endgame: watch briefly from a spot inside the next circle, then peek from a different angle — a quiet final never
    // becomes an indefinite crouch (holds capped at 4 s)
    const far = dmath.hypot(b.tx - m.storm.tx, b.tz - m.storm.tz) > m.storm.tr * 0.7;
    if (d < 5) b.holdT += dt; else b.holdT = 0;
    if (b.roamT <= 0 || far || b.holdT > 4) {
      const minMove = Math.min(8, m.storm.tr * 0.4);
      for (let k = 0; k < 8; k++) {
        const a = b.rng.next() * Math.PI * 2, r = (0.3 + b.rng.next() * 0.3) * m.storm.tr;
        const x = m.storm.tx + dmath.cos(a) * r, z = m.storm.tz + dmath.sin(a) * r;
        if (dmath.hypot(x - p.x, z - p.z) < minMove || m.world.ground(x, z) <= 0.8) continue;
        b.tx = x; b.tz = z; break;
      }
      b.roamT = 5 + b.rng.next() * 5; b.holdT = 0;
    }
    const distance = dmath.hypot(b.tx - p.x, b.tz - p.z);
    if (distance < 5) { inp.mx = 0; inp.mz = 0; inp.buttons |= B.CROUCH; inp.yaw += 0.7 * dt * (b.id & 1 ? 1 : -1); return; }
    moveTo(m, p, b, inp, b.tx, b.tz, distance > 30);
    return;
  }
  if (b.roamT <= 0 || d < 6) {
    // next: a POI inside the next safe circle (people are there), else a point toward the centre
    let ok = false;
    for (let k = 0; k < 8 && !ok; k++) {
      if (b.rng.next() < 0.6) { const q = POIS[b.rng.int(POIS.length - 1)]; b.tx = q.x + (b.rng.next() - 0.5) * q.r; b.tz = q.z + (b.rng.next() - 0.5) * q.r; }
      else { const a = b.rng.next() * Math.PI * 2, r = 50 + b.rng.next() * 140; b.tx = p.x + dmath.cos(a) * r; b.tz = p.z + dmath.sin(a) * r; }
      ok = dmath.hypot(b.tx - m.storm.tx, b.tz - m.storm.tz) < m.storm.tr * 0.85 && m.world.ground(b.tx, b.tz) > 1;
    }
    if (!ok) { b.tx = m.storm.tx; b.tz = m.storm.tz; }
    b.roamT = 10 + b.rng.next() * 12;
    if (b.rng.next() < 0.5) { b.state = S.Loot; b.lootChest = -1; b.lootItem = -1; }
  }
  moveTo(m, p, b, inp, b.tx, b.tz, d > 25);
}

function moveToward(p: Player, inp: Input, tx: number, tz: number, sprint: boolean) {
  // world-space wish direction → input axes relative to the current yaw
  const dx = tx - p.x, dz = tz - p.z, l = dmath.hypot(dx, dz) || 1;
  const sy = dmath.sin(inp.yaw), cy = dmath.cos(inp.yaw);
  // forward = (-sy, -cy), right = (cy, -sy)
  inp.mz = (dx * -sy + dz * -cy) / l; inp.mx = (dx * cy + dz * -sy) / l;
  if (sprint && inp.mz > 0.5) inp.buttons |= B.SPRINT;
}
/** steer toward (tx, tz): probe for walls/water, sidestep, jump small obstacles */
const SHORE_R = [8, 20, 45, 90];
function moveTo(m: Match, p: Player, b: BotBrain, inp: Input, tx: number, tz: number, sprint: boolean) {
  // Hunting / rotating from a building must use its authored doors and stairs, just like indoor looting.
  // Outdoor wall probes cannot find an upstairs exit and would pin final-circle survivors for minutes.
  if (b.state !== S.Loot && m.phase === 2) {
    const nav = lootSpots(m.world).nav, cell = navCellAt(nav, p.x, p.y, p.z);
    if (cell >= 0) {
      const target = navCellAt(nav, tx, m.world.ground(tx, tz), tz);
      if (target < 0 || nav.comp[cell] !== nav.comp[target]) {
        const door = navDoor(nav, cell, b.badDoor), key = -1000000 - door;
        if (door >= 0) {
          // 8 s at this door without 2 m of net progress: it does not let the bot out — ban it, try another
          if (b.pathKey === key && b.idleT > 8) { b.badDoor[b.badDoorI++ & 3] = door; b.pathKey = -99999; b.idleT = 0; BOT_UNSTICK.doors++; return; }
          if (b.pathKey !== key || b.pathI >= b.pathN) {
            // the walk to the door cell, then its outside point (keys ≤ -1000000 never clash with a loot target's)
            b.pathKey = key; b.pathI = 0;
            b.pathN = navPath(nav, p.x, p.y, p.z, door, b.path);
            if (b.pathN > 0 && b.pathN < b.path.length / 3) { const o = b.pathN * 3; b.path[o] = nav.ex[door * 3]; b.path[o + 1] = nav.ex[door * 3 + 1]; b.path[o + 2] = nav.ex[door * 3 + 2]; b.pathN++; }
          }
          if (b.pathI < b.pathN) { followPath(m, p, b, inp); return; }
        }
      }
    }
  }
  let dx = tx - p.x, dz = tz - p.z, dist = dmath.hypot(dx, dz);
  if (dist < 0.5) { inp.mx = inp.mz = 0; return; }
  // swimming: every probe below reads "water ahead" — head for the nearest shore first (toward the target when tied)
  if ((p.swim || p.y < 0) && dist > 3) {
    let best = -1, bs = Infinity;
    for (let k = 0; k < 16; k++) {
      const a = k / 16 * Math.PI * 2, fx = dmath.cos(a), fz = dmath.sin(a);
      for (const r of SHORE_R) if (m.world.ground(p.x + fx * r, p.z + fz * r) > 0.5) { const sc = r - 6 * (fx * dx + fz * dz) / dist; if (sc < bs) { bs = sc; best = k; } break; }
    }
    if (best >= 0) { const a = best / 16 * Math.PI * 2; dx = dmath.cos(a); dz = dmath.sin(a); inp.yaw = dmath.atan2(-dx, -dz); inp.pitch = 0; inp.mz = 1; inp.mx = 0; inp.buttons |= B.SPRINT; return; }
  }
  const heading = dmath.atan2(-dx, -dz) + b.turnBias;
  b.turnBias *= 0.9;
  const ey = p.y + 0.9;
  let chosen = heading, blocked = true;
  for (let oi = 0; oi < OFFSETS.length; oi++) {
    const o = OFFSETS[oi];
    const h = heading + o, fx = -dmath.sin(h), fz = -dmath.cos(h);
    const probe = 3.2;
    m.world.raycast(p.x, ey, p.z, fx * probe, 0, fz * probe, 1, HIT, false);
    if (HIT.hit) { // low obstacle? probe from higher
      m.world.raycast(p.x, p.y + 1.7, p.z, fx * probe, 0, fz * probe, 1, HIT, false);
      if (HIT.hit) continue;
      if (o === 0) inp.buttons |= B.JUMP;
    }
    const gx = p.x + fx * 5, gz = p.z + fz * 5;
    const g = m.world.ground(gx, gz);
    if (g < 0.2 && m.phase !== 0 && !(p.swim || p.y < 0.2)) continue;   // water ahead (unless already wading)
    if (g < p.y - 9) continue;                                     // cliff
    // a hillside too steep to walk up (> 46°: the climb limit is 45°): pushing
    // straight at it only slides the bot back to the foot of the hill — take a heading along / around it instead
    if (m.world.terrain.height(p.x + fx * 2.5, p.z + fz * 2.5) - Math.max(p.y, 0) > 2.6 && !p.swim) continue;
    chosen = h; blocked = false; break;
  }
  if (blocked) { chosen = heading + Math.PI * 0.5 * (b.rng.next() < 0.5 ? 1 : -1); inp.buttons |= B.JUMP; }
  inp.yaw = chosen; inp.pitch = 0; inp.mz = 1; inp.mx = 0;
  if (sprint) inp.buttons |= B.SPRINT; else inp.buttons &= ~B.SPRINT;
  const ax = p.x - dmath.sin(chosen) * 1.5, az = p.z - dmath.cos(chosen) * 1.5;
  if (m.world.ground(ax, az) > p.y + 0.8) inp.buttons |= B.JUMP;
}
const OFFSETS = [0, 0.5, -0.5, 1.0, -1.0, 1.6, -1.6, 2.4, -2.4];
function avoidHazards(m: Match, p: Player, inp: Input) {
  const sy = dmath.sin(inp.yaw), cy = dmath.cos(inp.yaw);
  const mx = inp.mx, mz = inp.mz; const l = dmath.hypot(mx, mz) || 1;
  const wx = (mz * -sy + mx * cy) / l, wz = (mz * -cy + mx * -sy) / l;
  const g = m.world.ground(p.x + wx * 3, p.z + wz * 3);
  if (g < 0.2 || g < p.y - 6) { inp.mx = -inp.mx; inp.mz = -inp.mz * 0.5; }
}
const wrap = (a: number) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };
export function pointLineDist(px: number, pz: number, x0: number, z0: number, dx: number, dz: number) { const t = (px - x0) * dx + (pz - z0) * dz; return dmath.hypot(px - (x0 + dx * t), pz - (z0 + dz * t)); }
