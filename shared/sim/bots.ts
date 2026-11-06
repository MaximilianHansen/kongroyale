// Bots: they drive the SAME Input a human sends, so the sim never special-cases them. Behaviours: drop to a POI,
// loot (nearest useful thing first — a weapon when unarmed), hunt gunfire, fight with human-like aim (reaction time,
// a flick error that settles while engaged, bursts), push weakened enemies, break line of sight to heal / reload,
// rotate with the storm. Navigation is steering + probes against the world outdoors; indoors the loot scan's
// walk graph (loot-spots.ts Nav: roofed cells, stairs, doors) routes a bot through the door to loot inside a building.
// Tuk-tuks: a bot never drives, but when a human squadmate sits at the bars of one nearby (or honks for them) it runs
// over, climbs onto the bench, watches its flank, shoots from it, and gets off when the driver does.
// Zero per-tick allocations.
import { POIS } from "../world/map";
import { BOT_DIFFICULTY, type BotDifficulty, PLANE_SPEED } from "./const";
import { IK } from "./loot";
import { lootSpots, navCellAt, navDoor } from "./loot-spots";
import { type Player } from "./player";
import { Rng } from "./rng";
import { makeHit } from "./world";
import type { Match } from "./match";

const HIT = makeHit();
export const enum S { Drop, Loot, Roam, Fight, Heal, Rotate, Hunt }

export class BotBrain {
  rng: Rng; state = S.Drop; tx = 0; tz = 0; poi = 0; jumpAt = 1e9;
  enemy = -1; enemySeenT = 0; engagedT = 0; reactT = 0; strafe = 1; strafeT = 0; aimYaw = 0; aimPitch = 0;
  /** aim error (rad) — a flick offset on acquisition that settles while engaged, plus a slow wander */
  errYaw = 0; errPitch = 0; headAim = false;
  /** when this bot's scope sway (const.ts scopeSway) last re-settled: scoping in / after a bolt; -1 = not scoped */
  scopedAt = -1;
  /** loot targets this bot gave up on (chest id, or -1 - item id): a ring, so it never runs back to a target it could
   * not reach in time */
  readonly gaveUp = new Int32Array(16).fill(-99999); gaveUpI = 0; nearT = 0; blockedT = 0;
  /** exact spent guns this bot discarded in out-of-ammo swaps (item ids, -1 = free; a ring): skipped until Match
   * releases their self-drop cooldown */
  readonly recoveryDiscards = new Int32Array(4).fill(-1); recoveryDiscardI = 0;
  /** out of ammo: the floor gun it is recovering with, and the swap it made (picked item, slot, the spent gun's
   * id / rarity, when, and m.items.length then) — matched against the drop on the next loot think */
  recoveryItem = -1; recoverySwapItem = -1; recoverySwapSlot = -1; recoverySwapSub = -1; recoverySwapStart = -1; recoverySwapRarity = 0; recoverySwapAt = -1;
  /** indoor route to the current loot target (waypoints x, y, z; the first is the door's outside point when the bot
   * starts outdoors); pathKey = the target it was planned for */
  readonly path = new Float32Array(3 * 160); pathN = 0; pathI = 0; pathKey = -99999;
  /** loot progress: the closest the bot got to its target, and when it last got 0.75 m closer */
  bestD = Infinity; progT = 0;
  lootChest = -1; lootItem = -1; lootT = 0; lastX = 0; lastZ = 0; stuckT = 0; turnBias = 0; healT = 0; roamT = 0; skill: number; fireHold = 0;
  coverX = 0; coverZ = 0; coverT = 0; hasCover = false; lastThink = 0; landedAt = -1; aggro: number;
  /** endgame: seconds crouched at the current hold spot; idleT = seconds without 2 m of net progress (progressX/Z = where
   * that was last made) */
  holdT = 0; idleT = 0; progressX = 0; progressZ = 0;
  /** seconds since someone last hurt this bot */
  hurtT = 99;
  /** the squadmate's tuk-tuk this bot is walking to (Match.useVehicle lets a bot onto no other), seconds a honk keeps
   * calling it over, and how long it has sat on a tuk-tuk nobody drives */
  boardVeh = -1; taxiT = 0; rideT = 0;
  /** the long view of travel: where the bot was at the last 4 checks (5 s apart), and a detour it is
   *  taking (seconds left, the point) — see unstick() */
  readonly ringX = new Float32Array(4); readonly ringZ = new Float32Array(4); ringN = 0; ringT = 0; detourT = 0; detourX = 0; detourZ = 0;
  /** detours in a row that left it stuck (each next one cares less about the goal, more about a new way), the last one's heading */
  detourFails = 0; detourA = 0;
  /** doors (nav exit cells) this life could not get through — a gap the capsule does not fit, a sill it cannot
   *  climb: never routed to again (a ring of 4; cleared on respawn) */
  readonly badDoor = new Int32Array(4).fill(-1); badDoorI = 0;
  constructor(readonly id: number, seed: number, readonly difficulty: BotDifficulty = "standard") {
    const tier = BOT_DIFFICULTY[difficulty];
    this.rng = new Rng(seed); this.skill = tier.skillMin + this.rng.next() * tier.skillSpan; this.aggro = tier.aggroMin + this.rng.next() * tier.aggroSpan;
  }

  planDrop(m: Match, p: Player) {
    this.resetRecovery();
    // pick a POI within 800 m of the plane line (hot drops are fine — that is where the fun is); jump near it
    // squadmates drop together: the POI roll is seeded by the team, the landing spot by the bot
    // a kong reaches ≈ 520 m sideways from the plane (12 s of freefall at 22 m/s + ~10 s of glide at 26 m/s): POIs whose
    // near half is ≤ 380 m off the line, else the nearest one
    const REACH = 380;
    const off = (q: (typeof POIS)[number]) => pointLineDist(q.x, q.z, m.plane.x0, m.plane.z0, m.plane.dx, m.plane.dz) - q.r * 0.5;
    let n = 0, near = POIS[0], nd = Infinity;
    for (const q of POIS) { if (q.id === "lobby-islet") continue; const d = off(q); if (d < REACH) n++; if (d < nd) { nd = d; near = q; } }
    const teamRng = m.mode === "trios" ? new Rng((m.seed ^ Math.imul(p.team + 1, 0x9e3779b1)) >>> 0) : this.rng;
    // the roll is weighted by LOOT CAPACITY, not uniform: √(the POI's live weapon sources) × the
    // share of its capacity (one bot per 4 weapon sources) still free. A uniform roll piles bots on the always-reachable
    // centre (Banana Temple, Peel Strip: 25 / 20 landings in 4 solo matches, 23 / 21 dead in 150 s) and leaves the
    // harbour ship at ~1 a match when the plane passes it. Squadmates share their squad's pick.
    let pick = near;
    if (n > 0) {
      const st = dropState(m), mine = m.mode === "trios" ? st.team.get(p.team) : undefined;
      if (mine !== undefined) pick = POIS[mine];
      else {
        let tot = 0; const w = (i: number) => dmath.pow(st.src[i], 0.4) * Math.max(0.12, 1 - st.n[i] / Math.max(1, st.src[i] / 3));
        POIS.forEach((q, i) => { if (q.id !== "lobby-islet" && off(q) < REACH) tot += w(i); });
        let r = teamRng.next() * tot;
        for (let i = 0; i < POIS.length; i++) { const q = POIS[i]; if (q.id === "lobby-islet" || off(q) >= REACH) continue; pick = q; r -= w(i); if (r <= 0) break; }
        if (m.mode === "trios") st.team.set(p.team, POIS.indexOf(pick));
      }
      st.n[POIS.indexOf(pick)]++;
    }
    this.poi = POIS.indexOf(pick);
    const a = this.rng.next() * Math.PI * 2, d = this.rng.next() * pick.r * (m.mode === "trios" ? 0.35 : 0.7);
    this.tx = pick.x + dmath.cos(a) * d; this.tz = pick.z + dmath.sin(a) * d;
    // aim the landing at loot: the nearest chest (or floor gun) to that spot. Indoor loot: land at its building's door
    // (the loot scan's walk graph), never on the roof above it; outdoor loot: beside it, on dry ground
    const nav = lootSpots(m.world).nav;
    let bd = 120 * 120, lx = NaN, lz = NaN, claims = true; this.lootChest = -1;
    const consider = (x: number, y: number, z: number, chest: number, item = -1) => {
      const q = dmath.pow(x - this.tx, 2) + dmath.pow(z - this.tz, 2); if (q >= bd) return;
      if (claims && claimedByOther(m, chest >= 0 ? chest : -1 - item, this.id)) return;
      const cell = navCellAt(nav, x, y, z);
      let ax = x, ay = y, az = z;
      if (cell >= 0) { const door = navDoor(nav, cell); if (door < 0) return; ax = nav.ex[door * 3]; ay = nav.ex[door * 3 + 1]; az = nav.ex[door * 3 + 2]; }
      // the landing place must be open to the sky right down to it (a street, a deck, a dock — not a roof above it) and
      // on the ground or a low deck (a balcony door leaves the bot stranded)
      m.world.raycast(ax, ay + 80, az, 0, -1, 0, 81, HIT, false);
      if (!HIT.hit || Math.abs(HIT.y - ay) > 0.6 || ay < 0.3 || ay - Math.max(0, m.world.ground(ax, az)) > 4.5) return;
      bd = q; lx = ax + (cell >= 0 ? 0 : (this.rng.next() - 0.5) * 3); lz = az + (cell >= 0 ? 0 : (this.rng.next() - 0.5) * 3); this.lootChest = chest; this.lootItem = item;
    };
    for (const c of m.chests) if (!c.box) consider(c.x, c.y, c.z, c.id);
    this.lootItem = -1;
    for (const it of m.items) if (it.kind === IK.Weapon) consider(it.x, it.y, it.z, -1, it.id);
    // everything near is claimed by the squad / other bots: share rather than land with nothing in reach
    if (lx !== lx) { claims = false; for (const c of m.chests) if (!c.box) consider(c.x, c.y, c.z, c.id); for (const it of m.items) if (it.kind === IK.Weapon) consider(it.x, it.y, it.z, -1, it.id); }
    if (lx === lx) { this.tx = lx; this.tz = lz; }
    const t = ((this.tx - m.plane.x0) * m.plane.dx + (this.tz - m.plane.z0) * m.plane.dz) / PLANE_SPEED;
    this.jumpAt = Math.max(6.5, t - 2 - this.rng.next() * 4 + (this.rng.next() - 0.5) * 3);
    // (the landing target stays claimed — lootChest / lootItem — until the bot lands and loots it)
    this.state = S.Drop; this.enemy = -1; this.landedAt = -1;
  }
  onHurt(by: number) {
    if (by < 0) return;
    this.hurtT = 0;
    if (this.enemy !== by) { this.enemy = by; this.reactT = (0.12 + (1 - this.skill) * 0.2) * BOT_DIFFICULTY[this.difficulty].reaction; this.engagedT = 0; this.flick(1.2); }
    this.enemySeenT = 0;
  }
  onRespawn(m: Match, p: Player) {
    const a = this.rng.next() * Math.PI * 2; this.tx = m.storm.tx + dmath.cos(a) * m.storm.tr * 0.5; this.tz = m.storm.tz + dmath.sin(a) * m.storm.tr * 0.5;
    // redeployed with a pistol: glide to the nearest unopened chest near the landing spot (re-arm, then fight)
    let bd = 160 * 160; this.lootChest = -1;
    for (const c of m.chests) { if (c.opened || c.box) continue; const q = dmath.pow(c.x - this.tx, 2) + dmath.pow(c.z - this.tz, 2); if (q < bd && dmath.hypot(c.x - m.storm.tx, c.z - m.storm.tz) < m.storm.tr * 0.9) { bd = q; this.lootChest = c.id; } }
    const cx = this.lootChest >= 0 ? m.chests[this.lootChest] : null;
    if (cx) { this.tx = cx.x + (this.rng.next() - 0.5) * 4; this.tz = cx.z + (this.rng.next() - 0.5) * 4; }
    this.state = S.Drop; this.enemy = -1; this.landedAt = -1; this.lootItem = -1; this.idleT = this.holdT = 0; this.ringN = 0; this.detourT = 0; this.badDoor.fill(-1); this.resetRecovery(); void p;
  }
  resetRecovery() {
    this.recoveryItem = this.recoverySwapItem = this.recoverySwapSlot = this.recoverySwapSub = this.recoverySwapStart = -1; this.recoverySwapRarity = 0; this.recoverySwapAt = -1;
    this.recoveryDiscards.fill(-1);
  }
  /** a fresh acquisition: the crosshair lands off-target by a skill-dependent amount */
  flick(scale = 1) {
    const e = (0.05 + 0.13 * (1 - this.skill)) * scale * BOT_DIFFICULTY[this.difficulty].aimError;
    this.errYaw = (this.rng.next() - 0.5) * 2 * e; this.errPitch = (this.rng.next() - 0.5) * e;
    this.headAim = this.rng.next() < 0.15 + this.skill * 0.3;
  }
}

/** per match: each POI's live weapon sources (weapon chests + floor guns inside r, ≥ 2), the bots
 * already headed there, and each squad's pick */
const DROP = new WeakMap<Match, { plane: string; src: number[]; n: Int32Array; team: Map<number, number> }>();
function dropState(m: Match) {
  // (keyed by this match's plane line: a lobby's rematch reuses the Match object and rolls a new line)
  const plane = `${m.plane.x0},${m.plane.z0},${m.plane.dx}`;
  let st = DROP.get(m); if (st && st.plane === plane) return st;
  const src = POIS.map((q) => {
    let k = 0; const r2 = q.r * q.r;
    for (const c of m.chests) if (!c.box && !c.opened && dmath.pow(c.x - q.x, 2) + dmath.pow(c.z - q.z, 2) < r2) k++;
    for (const it of m.items) if (it.kind === IK.Weapon && !it.taken && dmath.pow(it.x - q.x, 2) + dmath.pow(it.z - q.z, 2) < r2) k++;
    return Math.max(2, k);
  });
  DROP.set(m, st = { plane, src, n: new Int32Array(POIS.length), team: new Map() }); return st;
}

import { claimedByOther, pointLineDist } from "./bots.hot";
import * as dmath from "./dmath";
export { BOT_GIVEUP, BOT_UNSTICK, LANDING_GRACE_S, botThink, botThinksNow, weaponValue } from "./bots.hot";
