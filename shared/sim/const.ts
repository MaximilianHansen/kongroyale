// Every tunable of the simulation in one place. Client prediction and the authoritative server import the SAME file.
import type { ConsumableId, Rarity, WeaponId } from "../world/map";
import * as dmath from "./dmath";

export const TICK_HZ = 60;
export const DT = 1 / TICK_HZ;
export const SNAP_EVERY = 2;                 // snapshots at 30 Hz
export const MAX_PLAYERS = 50;
export const SQUAD_SIZE: Record<"solo" | "trios", number> = { solo: 1, trios: 3 };
/** a TRIOS match seats this many kongs (humans + bot fill): 16 even trios. 50 = 16 trios + a duo;
 * 51 (17 trios) would need MAX_PLAYERS — every per-seat array, the caster's 50-seat model and the u8 counts' headroom —
 * raised. Lobbies cap TRIOS rooms here; more humans than this still all play (up to MAX_PLAYERS), the bots just stop filling. SOLO keeps MAX_PLAYERS. */
export const MAX_PLAYERS_TRIOS = 48;
/** seats a match of this mode fills (humans + bots) — matchSeats("trios") = 48, matchSeats("solo") = 50 */
export const matchSeats = (mode: "solo" | "trios") => (mode === "trios" ? MAX_PLAYERS_TRIOS : MAX_PLAYERS);

// ---- body
export const PLAYER_R = 0.42;                // capsule radius (m)
export const PLAYER_H = 1.9;                 // standing height
export const CROUCH_H = 1.3;
export const EYE_STAND = 1.65;
/** BULLET HITBOX: fitted to the real skinned kong (≥ 95 % of the silhouette inside from 8 azimuths, ≤ 0.15 m
 * outside it). Local frame of the target: origin at the feet, −z = facing (the recorded yaw), +x = its right, standing heights in metres. The kong is
 * hunched with the head FORWARD of the trunk, ~1.5 m wide across the hanging arms and ~0.9 m deep, so the hitbox is a
 * head sphere offset forward + a stack of elliptic cylinders (the arms are inside the wide band). Crouched (h < PLAYER_H):
 * heights above `crouch[0]` drop by `crouch[1]`, below it they scale by crouch[2]. Hit-testing only — movement keeps
 * PLAYER_R / PLAYER_H. Mutable on purpose: the fit tool tunes it in-process; the game never writes it. */
export const HITBOX = {
  /** head sphere: centre height, forward offset (−z), radius. Fitted to the kong model (v2 — its head
   *  sits between the shoulders at idle but drops ~0.3 m and leans forward when it runs: the drawn face of a moving kong
   *  sits at 1.42 m, 0.46 m forward — so the sphere is fitted on the run / strafe poses too, not only idle / crouch) */
  head: { y: 1.6, z: -0.17, r: 0.32 },
  /** body parts: vertical elliptic cylinders [y0, y1, centre x, centre z, half-width x, half-depth z] */
  parts: [
    [-0.03, 0.55, 0, -0.07, 0.49, 0.33],   // legs + the big high-tops
    [0.47, 0.91, 0, -0.14, 0.63, 0.38],    // hips + shorts + the fists hanging beside them
    [0.79, 1.41, 0, -0.04, 0.7, 0.38],     // chest + upper arms (1.4 m across the arms)
    [1.21, 1.62, 0, 0.02, 0.6, 0.33],      // shoulders / deltoids
    [0.57, 1.08, 0.58, -0.23, 0.18, 0.22], // right forearm + fist
    [0.57, 1.12, -0.58, -0.23, 0.2, 0.2],  // left forearm + fist
  ] as number[][],
  /** crouch remap: above y0 drop by dy, below it scale by k */
  crouch: [0.5, 0.3, 0.4] as number[],
  /** a head hit wins over a body entry up to this far in front of it (m): the face in front of the shoulders (and the
   *  running kong's face, low in front of its chest) */
  headBias: 0.16,
};
export const STEP_H = 0.55;                  // auto-step height
export const MAX_HP = 100;
export const MAX_SHIELD = 100;

// ---- movement (m/s, m/s²)
export const WALK = 5.4;
export const SPRINT = 7.4;
export const CROUCH_SPEED = 2.8;
/** walking while aiming down sights (any gun, the scope too): speed × this. A trade-off — accuracy for mobility — and a
 * strafing ADS duelist is hittable for a newer player */
export const ADS_MOVE_MUL = 0.75;
/** swim speed (at 3.2 m/s a swimmer caught by the storm could not get out): ≈ walk speed, and holding
 * sprint swims a bit faster — still slower than running on land (SPRINT) */
export const SWIM = 4.8;
export const SWIM_SPRINT = 6.0;
export const ACCEL = 60;                     // ground acceleration toward wish velocity
export const FRICTION = 12;                  // ground stop
export const GRAVITY = 24;
export const JUMP_V = 7.6;
export const COYOTE_S = 0.1;
export const JUMP_BUFFER_S = 0.12;
export const SLOPE_LIMIT = 0.62;             // cos(51°): steeper than this = slide off
export const FALL_DMG_V = 17;                // vertical speed at which fall damage begins
export const FALL_DMG_PER_MS = 4;            // dmg per m/s over the threshold
export const WATER_LEVEL = 0;
export const SWIM_SURFACE = 1.35;            // metres of water depth to switch to swimming
/** …and back to wading only below this (hysteresis: the waterline never flips the state every few ticks) */
export const SWIM_LEAVE = 1.2;
/** swimming. On the surface the feet float at SWIM_FLOAT_Y (the head and shoulders out). */
export const SWIM_FLOAT_Y = WATER_LEVEL - 1.15;
/** a duck-dive needs at least this much water under the float line's feet (m of depth at the spot) */
export const DIVE_MIN_DEPTH = 2.6;
/** under water: speed along the look direction (m/s; Shift = UW_SPRINT), straight up / down with jump / crouch, the
 *  drift up with nothing pressed, the duck-dive's push down, the water's response rate (1/s: slower than the surface) */
export const UW_SPEED = 4.2, UW_SPRINT = 5.4, UW_VERT = 3.2, UW_BUOY = 0.45, DIVE_KICK = 5.2, UW_RESP = 3.6;
/** breath (s of air under water); refilled on the surface over BREATH_REFILL_S. Out of air the body is pushed up to the
 *  surface (no drowning damage) — a diver cannot camp under the sea */
export const BREATH_S = 20, BREATH_REFILL_S = 3.5;
/** under water the capsule is this short (the kong swims stretched out: through wreck doors, close to the bed) */
export const UW_H = 1.1;
/** the eye above the feet under water (the body is near horizontal: the head is at the front, not 1.65 m up) */
export const UW_EYE = 0.62;
/** the eye above the feet swimming on the surface (≈ 0.3 m above the water: the kong's eyes, just over the chop) */
export const SWIM_EYE = 1.45;
/** the gun while swimming: stowed (both arms stroke) until fire / aim draws it — SWIM_DRAW_S of draw, then it stays up
 *  SWIM_GUN_HOLD_S after the last shot / aim / reload / heal; the treading hold moves at SWIM_TREAD m/s */
export const SWIM_DRAW_S = 0.3, SWIM_GUN_HOLD_S = 1.6, SWIM_TREAD = 2.6;
/** air control: steer the horizontal velocity toward the wish direction at this rate (1/s); above the ground
 * speed it only turns (momentum from a slide / sprint jump is kept, never gained) */
export const AIR_STEER = 3.2;

// ---- traversal: mantle + crouch-slide. Server-authoritative + predicted.
/** mantle: ledge top this far above the floor you jumped from (m) */
export const MANTLE_MIN = 0.6;
export const MANTLE_MAX = 2.1;
/** wall face within this distance of the capsule SURFACE (m) */
export const MANTLE_REACH = 0.5;
/** pull-up speed (m/s) and the step over the lip (m/s); a hard cap on the whole move (s) */
export const MANTLE_UP = 7.2;
export const MANTLE_FWD = 5.2;
export const MANTLE_MAX_S = 0.9;
/** water exit: a swimmer pulls up onto a ledge / deck / hull whose top is this high above the water
 * SURFACE (m) — stilt decks stand at 2.2, pier and container tops 1-2 m */
export const SWIM_MANTLE_MIN = 0.15;
export const SWIM_MANTLE_MAX = 2.35;
/** exit speed along the mantle direction (m/s) — you come over the top already walking */
export const MANTLE_EXIT_V = 4.2;
/** slide: entry speed (m/s), entry needs at least SLIDE_ENTRY m/s (a sprint), linear decel (m/s²), ends below SLIDE_END_V,
 * gravity share along the slope (downhill keeps you going, uphill kills it), steer rate (rad/s), new-slide cooldown (s) */
export const SLIDE_V = 9.5;
export const SLIDE_ENTRY = 6.2;
export const SLIDE_DECEL = 6.2;
export const SLIDE_END_V = 3.2;
export const SLIDE_SLOPE = 0.9;
export const SLIDE_STEER = 1.8;
export const SLIDE_CD = 1.1;
export const SLIDE_MAX_V = 16;

// ---- drop
export const PLANE_ALT = 720;
export const PLANE_SPEED = 62;
export const PLANE_CHORD_R = 1500;           // the plane's line spans a chord of this circle around the island
export const PLANE_BAY_S = 34;               // seconds the door stays open; forced jump after
// Legacy freefall / glider speeds, unused by the game (it uses FF_* and GL_* in shared/sim/player.ts).
// GLIDE_MIN_AGL and the redeploy constant below are live.
export const FREEFALL_TERMINAL = 52;         // straight down
export const FREEFALL_DIVE = 78;             // holding dive
export const FREEFALL_FWD = 22;              // horizontal steer speed
export const FREEFALL_ACCEL = 30;
export const GLIDE_DOWN = 9.5;
export const GLIDE_FWD = 26;
export const GLIDE_ACCEL = 18;
export const GLIDE_AUTO_AGL = 95;            // glider auto-opens this high above the ground
export const GLIDE_MIN_AGL = 12;             // cannot cut the glider below this
export const REDEPLOY_MIN_CLEAR = 3;         // room below the feet needed to redeploy the glider off a ledge
export const CHUTE_CUT_HOLD_S = 1;           // hold jump this long while gliding to cut the glider
export const REDEPLOY_ALT = 320;

// ---- combat timing
export const SWAP_S = 0.35;
export const MAX_REWIND_TICKS = 21;          // 350 ms lag compensation cap (server never evaluates a shot older than this);
                                             // covers ~95 % of shots up to ~270 ms RTT (RTT + interp delay); history is 533 ms
export const HISTORY_TICKS = 32;
export const BULLET_RANGE = 320;

// ---- net
/** remote positions travel as i24 fixed point: 1/512 m (≤ 0.98 mm error, ±16 km range). The server's rewind history
 * stores the SAME quantised values, so a client's interpolated target and the server's rewound target are bit-equal. */
export const POS_Q = 512;
export const qpos = (v: number) => Math.round(v * POS_Q) / POS_Q;
/** server input pacing (per human): every client input is simulated exactly once (1:1 with client prediction) */
export const INPUT_CREDIT_MAX = 30;          // ticks of backlog a stalled link may catch up (500 ms)
export const INPUT_MAX_PER_TICK = 4;         // catch-up speed after a stall
// no input this long → the server steps the player with a neutral input. Long on purpose: a loaded tab
// freezes for 0.5-1.5 s at times (GC, shader compiles, a busy GPU) and every neutral step the server inserts while the
// client is merely stalled is a step the client never predicted — 100+ corrections, up to 2.5 m, in a single drop.
// The server waits instead; the stalled body just holds still (what a lagging player looks like anyway).
export const INPUT_STARVE_TICKS = 150;
export const INPUT_QUEUE_MAX = 64;

export type AmmoType = "light" | "heavy" | "shells" | "rockets";
export const AMMO_CAP: Record<AmmoType, number> = { light: 300, heavy: 40, shells: 48, rockets: 8 };
export const AMMO_PICKUP: Record<AmmoType, number> = { light: 40, heavy: 8, shells: 10, rockets: 2 };
/** the reserve of light rounds beside the common NUB's full magazine on a match's first drop — and on a
 * redeploy (match.ts). 36 = three more magazines (48 rounds, ~12 body-shot kills' worth on paper, ~3 fights in practice
 * at a pistol's hit rate): enough to win or flee a contested landing, less than one 40-round box on the floor, so looting
 * a real gun and ammo is still the first job. */
export const START_PISTOL_AMMO = 36;

export interface WeaponDef {
  id: WeaponId; name: string; ammo: AmmoType;
  auto: boolean; dmg: number; pellets: number; rpm: number; mag: number; reloadS: number;
  headMul: number;
  /** spread (cone radius, deg): standing still / moving / airborne. Crouch ×0.75, ADS × `ads` (the scope too) */
  spread: [number, number, number];
  /** ADS (right mouse, on the ground, not sprinting / reloading) spread multiplier */
  ads: number;
  /** aimed spread table (deg: still / moving / airborne) that REPLACES spread × ads while aiming (the sniper scope) */
  adsSpread?: [number, number, number];
  /** bloom: spread multiplier added per shot, its cap, and how fast it drains (per s) once you stop firing
   * (spread = base × (1 + heat)); [0, 0, 1] = none */
  bloom: [number, number, number];
  /** first-shot accuracy: standing still on the ground, a shot fired ≥ this many seconds after the previous one goes
   * exactly to the crosshair (0 = none) */
  fsa: number;
  /** recoil (client aim kick, game/render.ts): vertical kick deg per shot, horizontal random deg, recovery /s */
  recoil: [number, number, number];
  /** damage falloff: full until `a` m, `min` multiplier from `b` m */
  falloff: [number, number, number];
  /** projectile: speed m/s, gravity, splash radius, splash dmg (undefined = hitscan) */
  projectile?: { speed: number; gravity: number; splashR: number; splashDmg: number };
  scope?: number;
  /** viewmodel bullet speed for tracers (hitscan is still instant) */
  tracer: number;
}
// Balance targets: 200 HP in ~1.05–1.3 s (common) with a primary, 0.85–1.05 s (legendary); a sniper headshot is the
// only one-shot. The SMG hits harder up close (17) but falls off from 12 m to ×0.45 at 45 m and blooms wide (no laser at 30–50 m); the pump falls off
// steeply (full to 4 m, ×0.25 at 16 m: 2 body blasts inside ~5 m, 3 by 8 m) and only a LEGENDARY+ pump with all 9
// pellets on the head inside ~4 m one-shots a full 200 (common → epic peak 169–194).
export const WEAPON_DEFS: Record<WeaponId, WeaponDef> = {
  pistol:  { id: "pistol",  name: "NUB",        ammo: "light",   auto: false, dmg: 26, pellets: 1, rpm: 330, mag: 12, reloadS: 1.3,  headMul: 1.8,  spread: [0.45, 0.5, 1.8],  ads: 0.9,  bloom: [0.3, 1.6, 4],    fsa: 0.25, recoil: [1.3, 0.3, 9],   falloff: [30, 110, 0.7],  tracer: 400 },
  smg:     { id: "smg",     name: "PEELER",     ammo: "light",   auto: true,  dmg: 17, pellets: 1, rpm: 650, mag: 40, reloadS: 1.8,  headMul: 1.5,  spread: [0.9, 1.6, 3.2],   ads: 0.65, bloom: [0.12, 1.6, 4],  fsa: 0,    recoil: [0.5, 0.42, 12], falloff: [12, 45, 0.45],  tracer: 420 },
  ar:      { id: "ar",      name: "BUNCHGUN",   ammo: "light",   auto: true,  dmg: 24, pellets: 1, rpm: 400, mag: 30, reloadS: 2.3,  headMul: 1.6,  spread: [0.32, 1.0, 2.8],  ads: 0.55, bloom: [0.2, 1.6, 4],    fsa: 0.28, recoil: [0.85, 0.28, 10], falloff: [50, 150, 0.8],  tracer: 480 },
  shotgun: { id: "shotgun", name: "SPLITTER",   ammo: "shells",  auto: false, dmg: 12.5, pellets: 9, rpm: 68, mag: 5,  reloadS: 0.6,  headMul: 1.5,  spread: [2.6, 2.9, 4.6],   ads: 0.85, bloom: [0, 0, 1],        fsa: 0,    recoil: [3.2, 0.8, 8],   falloff: [4, 16, 0.25],   tracer: 380 },
  // body 80 (a legendary body shot, 97, never one-shots even an
  // unshielded 100-HP kong), head ×2.6 (208 common: a headshot still kills from full 100 + 100); no-scope spread ×3+, a
  // moving / jumping scope wider (×1.4); still the best class from 150 m
  sniper:  { id: "sniper",  name: "LONGSTEM",   ammo: "heavy",   auto: false, dmg: 80,  pellets: 1, rpm: 30, mag: 4,  reloadS: 2.7,  headMul: 2.6,  spread: [4.0, 6.0, 9.0],   ads: 0.04, bloom: [0, 0, 1],        fsa: 0,    recoil: [4.5, 0.6, 6],   falloff: [250, 400, 0.85], scope: 6, adsSpread: [0.05, 1.4, 3.5], tracer: 900 },
  rocket:  { id: "rocket",  name: "BUNCH LAUNCHER", ammo: "rockets", auto: false, dmg: 60, pellets: 1, rpm: 40, mag: 1, reloadS: 2.3, headMul: 1.0, spread: [0.2, 0.6, 1.5], ads: 1, bloom: [0, 0, 1], fsa: 0, recoil: [5, 1, 5], falloff: [400, 400, 1], projectile: { speed: 48, gravity: 5, splashR: 3.8, splashDmg: 70 }, tracer: 48 },
};
/** scope sway (client aim wander while scoped, client/src/game/render.ts): amplitude in degrees
 * (world angle) = steady + enter × e^(−t / tau), t = time since the scope settled (scoping in, and after every bolt).
 * Two incommensurate sines per axis, so it reads as breathing, never a pattern. Bullets follow the crosshair. */
export const SCOPE_SWAY = { steady: 0.8, enter: 2.1, tau: 0.8,
  /** hold breath (sprint key while scoped): sway × breathMul for up to breathS s; refills in refillS s; emptied lungs
   * shake × outMul until half refilled. The base sway is wider than without breath (0.5 / 1.5) so the AVERAGE player's
   * effective sway stays put: breath is a skill, not a free buff. */
  breathMul: 0.4, breathS: 2.5, refillS: 4, outMul: 1.35 };
export function scopeSway(t: number, since: number, out: number[]): number[] {
  const S = SCOPE_SWAY, a = S.steady + S.enter * dmath.exp(-Math.max(0, since) / S.tau);
  out[0] = a * (0.75 * dmath.sin(t * 2.17) + 0.25 * dmath.sin(t * 4.9 + 1.3));
  out[1] = a * 0.7 * (0.8 * dmath.sin(t * 2.71 + 0.6) + 0.2 * dmath.sin(t * 5.3 + 2.1));
  return out;
}
// a mythic hits like a legendary + ~12 % (1.35 / 1.21): the best gun on the island, not a different game —
// e.g. AR body shot 32.4 vs legendary 29.0 (200 hp: 7 body shots either way, one headshot in it makes the mythic 6);
// a point-blank shotgun blast 170 vs 152
export const RARITY_MUL: Record<Rarity, number> = { common: 1, uncommon: 1.05, rare: 1.1, epic: 1.15, legendary: 1.21, mythic: 1.35 };

export interface ConsumableDef { id: ConsumableId; name: string; hp: number; shield: number; useS: number; stack: number;
  /** a timed buff instead of a heal: seconds, ground-speed multiplier, jump-speed multiplier */
  buffS?: number; speedMul?: number; jumpMul?: number }
export const CONSUMABLE_DEFS: Record<ConsumableId, ConsumableDef> = {
  // 25 × a full stack of 4 = one slot fills one bar; hold fire to chain the next use
  "leaf-bundle":   { id: "leaf-bundle",   name: "LEAF BUNDLE",     hp: 25,  shield: 0,   useS: 2.0, stack: 4 },
  "smoothie":      { id: "smoothie",      name: "BANANA SMOOTHIE", hp: 0,   shield: 25,  useS: 2.0, stack: 4 },
  "golden-banana": { id: "golden-banana", name: "GOLDEN BANANA",   hp: 100, shield: 100, useS: 4.5, stack: 1 },
  // eat it (1 s) → 8 s of ~1.85× run speed and a
  // jump that goes twice as high (1.2 → 2.3 m) and much further; eating another one refreshes the timer
  "red-banana":    { id: "red-banana",    name: "RED BANANA",      hp: 0,   shield: 0,   useS: 1.0, stack: 2, buffS: 8, speedMul: 1.85, jumpMul: 1.38 },
  // --- throwables and placeables --- (no heal: G / fire throws the bomb, fire places the wall — player.ts stepHands)
  "banana-bomb":   { id: "banana-bomb",   name: "BANANA BOMB",     hp: 0,   shield: 0,   useS: 0,   stack: 4 },
  "crate-wall":    { id: "crate-wall",    name: "COCONUT CRATE WALL", hp: 0, shield: 0,  useS: 0,   stack: 1 },
};
/** the BANANA BOMB: a frag grenade with a 3 s peel fuse that starts burning when you
 * pull it (G / fire with it in hand) — hold to cook, let go to throw; it bounces and rolls; area damage with falloff and
 * line of sight (Match.explode, like a rocket's splash). speed / up: throw velocity along the look + an upward lob (m/s);
 * gravity m/s²; restitution / friction per bounce; radius / core (full damage) / floor (damage share at the rim) */
export const BOMB = { fuseS: 3.0, speed: 22, up: 3.5, gravity: 19, restitution: 0.35, friction: 0.55, radius: 6.0, core: 1.4, dmg: 105, floor: 0.15, cooldownS: 0.45 };

/** BANANA BUCKS (shared/sim/economy.ts) */
export const ECON = {
  /** a wallet holds at most this much */
  cap: 30000,
  /** what a kong drops on top of its wallet when it is knocked out */
  killTax: 100,
  /** chest cash by rarity (common … legendary, mythic), ammo boxes (1 in 3), floor stacks (min / max) */
  chest: [100, 150, 200, 300, 400, 600], box: 50, boxChance: 0.33, floorMin: 50, floorMax: 200,
  /** a stand serves kongs this close (m, horizontal) */
  standReach: 4,
  bounty: { s: 90, range: 400, reward: 1500, survive: 500, circleR: 90, refreshS: 5 },
} as const;


export const RESURGENCE_S: Record<"solo" | "trios", number> = { solo: 16, trios: 11 };
/** redeploy wait grows with the storm (a death costs more as the circle tightens): +3 s per phase after the first */
export const resurgenceDelay = (mode: "solo" | "trios", stormPhase: number) => RESURGENCE_S[mode] + 3 * Math.max(0, stormPhase - 1);
export const RESURGENCE_WARN_S = 20;
/** solo: redeploys per match (the next death after the last one is final) — keeps attrition gradual */
export const SOLO_REDEPLOYS = 4;
export type BotDifficulty = "easy" | "standard" | "hard";
/** Bot tiers: skill / aggro = min + a seeded roll × span per bot; reaction scales the reaction delays, aimError the flick
 * and the settled aim error. damageToHumans / aimRange cap MatchOpts.botDamageToHumans / botAimRange (a bot's damage to
 * humans, and the range past which its shots at a human spray wider). Easy = the classic practice bots (10 % damage,
 * accurate only within ~8 m), standard = the classic online bots, hard = sharper, quicker, more aggressive brains. */
export const BOT_DIFFICULTY = {
  easy: { skillMin: 0.35, skillSpan: 0.65, aggroMin: 0.4, aggroSpan: 0.6, reaction: 1, aimError: 1, damageToHumans: 0.1, aimRange: 8 },
  standard: { skillMin: 0.35, skillSpan: 0.65, aggroMin: 0.4, aggroSpan: 0.6, reaction: 1, aimError: 1, damageToHumans: 1, aimRange: Infinity },
  hard: { skillMin: 0.65, skillSpan: 0.3, aggroMin: 0.65, aggroSpan: 0.3, reaction: 0.75, aimError: 0.8, damageToHumans: 1, aimRange: Infinity },
} as const;
export const WARMUP_S = 25;                  // pregame on the lobby islet after START
export const RESULTS_S = 14;

// ---- loot
export const CHEST_OPEN_DIST = 2.6;
export const PICKUP_DIST = 2.2;
export const LOOT_PER_CHEST = 3;

export const WEAPON_SLOTS = 5;
