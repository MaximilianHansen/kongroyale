// THE SOUND BANK: every Sfx in api.ts → layered, spatial, level-matched event. This file IS the mix — every level
// below is in dB relative to the asset's category reference (set by the asset build's loudness norm).
//
// Conventions for callers (gameplay):
//   • no `pos`  → it's YOU (first-person: 2D, stereo, your own gun gets sub + mechanics + ducking)
//   • `pos`     → it's in the world (HRTF-panned, distance curves, occlusion, speed-of-sound delay, terrain echoes)
//   • loops need `loopId`; calling play() again with the same loopId UPDATES pos/volume/rate (no restart)
import type { Bus } from "./mixer";
import { WEAPONS, type WeaponId } from "../../../shared/world/map";
import type { Surface } from "../../../shared/world/colliders";
import { STEP_SURFACES, type StepSurface } from "./steps";

export interface Layer {
  /** library group (file id without the -NN variant suffix) */
  g: string;
  db?: number;
  /** ± random pitch in semitones (round-robin variance on top of the variant pick) */
  pitch?: number;
  delay?: number;
  /** random extra start delay 0..jitter s */
  jitter?: number;
  who?: "local" | "remote";
  /** distance band for spatial crossfades: near body → far report → dist(ant) report; `tail` = the near field's reverb,
   * `ftail` = the rolling outdoor tail of a distant shot (rises against the report with range, see Spatial.bands) */
  band?: "near" | "tail" | "far" | "dist" | "ftail";
  /** loudness-match this layer to another group (manifest P = max 100 ms K-weighted loudness): at weight 1 it is
   * exactly as loud as `match` at weight 1, so an equal-power crossfade never adds loudness (unmatched, the far report sat
   * +10-13 dB over the body and a gun got LOUDER from 40 to 150 m). `db` is then a deliberate offset on top. */
  match?: string;
  chance?: number;
  rate?: number;
  /** start at this fraction of the action's duration (reload keyframes, see RELOAD_KEYS) instead of `delay` */
  u?: number;
  /** (tail layers): dB on the ROOM variant (`<g>-in`) — a shot in a room rings louder than the open air */
  inDb?: number;
  /** play this layer only while group `ifMissing` is not in the library (a legacy take standing in for a new set) */
  ifMissing?: string;
  /** (loops): the layer's level wanders ± this many dB (a new random target every 1.2-3.6 s) — no loop period */
  drift?: number;
  /** (loops): re-seek to a random point of the loop every [min, max] s (equal-power 0.9 s crossfade) */
  shuffle?: [number, number];
  /** (local loops): the layer's level follows YOUR speed — [m/s at dB0, m/s at dB1, dB0, dB1] (clamped) */
  speed?: [number, number, number, number];
  /** (local loops): the layer's level follows how fast you TURN — [rad/s, rad/s, dB0, dB1]; with `speed` the louder wins */
  turn?: [number, number, number, number];
}

export interface Spatial {
  /** full level inside `ref` metres */
  ref: number;
  /** silent (culled) beyond `max` metres */
  max: number;
  /** inverse-distance rolloff (1 = physical -6 dB/doubling, lower = carries further) */
  rolloff: number;
  /** air absorption: low-pass cutoff falls as 20 kHz·e^(−d/air) */
  air?: number;
  occl?: boolean;
  /** delay by distance / 343 m/s */
  travel?: boolean;
  /** terrain / wall echoes */
  echo?: number;
  /** near band full → gone (m); far band starts → full (m) */
  near?: [number, number];
  far?: [number, number];
  /** use HRTF inside this range, cheaper equal-power beyond */
  hrtf?: number;
  /** occlusion strength — dB lost and the low-pass (Hz) at full occlusion (default 12 dB / 750 Hz). Someone's FEET are
   * gameplay information: behind a wall or a container they are muffled, not gone (7 dB / 2.2 kHz) */
  occlDb?: number; occlHz?: number;
  /**
   * a designed loudness-vs-distance curve instead of the inverse-distance one: -a dB per doubling from `ref` to
   * `knee`, then -b dB per doubling (a gun is a proximity cue up close and CARRIES far away — the distance itself is
   * told by the band crossfades, the air absorption and the rising tail, never by a level bump)
   */
  curve?: { a: number; knee: number; b: number };
  /** band edges (m): near body fades out over `near` (equal power into the far report), the far report fades into
   * the dist report over `far`, the near-field tail fades over `tail`; `ftail` = [in0, in1, dB per doubling it rises
   * against the report, from m] */
  bands?: { near: [number, number]; far: [number, number]; tail: [number, number]; ftail?: [number, number, number, number] };
}

export interface EventDef {
  bus: Bus;
  /** voice-steal priority (higher = kept longer): own gun / hit confirms > remote near > remote far > echoes */
  prio?: number;
  /**
   * burst merge: triggers of this event (`by: "name"`) or its whole cap group (`by: "group"`) inside `win` s and `radius` m
   * of each other count as ONE blast — at most `max` voices. A remote shotgun arrives as 9 per-pellet EV.Shot triggers in
   * the same tick; its impacts / whizzes as 9 too. They must sound (and cost) like one blast.
   */
  burst?: { win: number; max: number; radius: number; by?: "name" | "group" };
  /** random one-shots mixed into a loop while it plays (cabin rattles, fabric flaps): group, interval s, dB */
  sprinkle?: { g: string; every: [number, number]; db: number; pitch?: number };
  /** bus when it's you (no pos) */
  busLocal?: Bus;
  db?: number;
  dbLocal?: number;
  layers: Layer[];
  spatial?: Spatial;
  cap?: number;
  /** voices sharing a cap */
  group?: string;
  /** minimum seconds between two triggers of this event (flams become one) */
  gap?: number;
  /** own-gunfire ducking strength */
  duck?: number;
  loop?: "plain" | "freefall" | "glider" | "plane" | "storm" | "wall" | "zip" | "bay";
  /** reverb send dB (yard outdoors / room indoors) */
  send?: number;
  shock?: boolean;
  /** a cue that must read over everything (GO, RAMP OPEN): the rest of the mix dips this many dB under it */
  cueDuck?: [number, number];
  /** a hit confirm (yours): enemy guns / your own sounds dip for ~90 ms around its tick (mixer.duckConfirm) */
  confirm?: boolean;
  /** EQ on the voice when it is in the world: [type, Hz, dB, Q] (someone else's feet: a broad 1-3 kHz presence
   * lift and less boom keep a quiet step readable over the beds without making it as loud as a gun) */
  eq3p?: ["peaking" | "lowshelf" | "highshelf", number, number, number][];
}

// ---------------------------------------------------------------- weapons
// NO SHOT IS LIMITED. Every gun asset's transient is clipped by design offline (the asset build: true peak ≤
// 10-13.5 dB over its 100 ms loudness) and the levels below keep the loudest single shots — your sniper, an enemy sniper /
// shotgun / AR at ≤ 5 m — ≥ 1.5 dB under the master limiter's ceiling (measured at the limiter's gain-reduction tap).
// own (1P) levels are set for a HIERARCHY measured as 100 ms impulse loudness (I100) through the master: pistol ≈ -18,
// smg ≈ -17.5, ar ≈ -16.5, shotgun ≈ -14, rocket ≈ -13.5, sniper ≈ -12.5 — with ≤ 1 dB of master gain reduction on a single
// pistol / smg / ar shot.
// 3P: `hear` = level at 5 m; the loudness falls `a` dB per doubling to `knee` m, then `b` dB per doubling (the
// sniper and the AR carry furthest, a pistol barely leaves the block) — measured on a clear line it falls monotonically
// (≥ 2 dB per doubling) from 20 to 700 m. The near body crossfades (equal power, loudness-matched) into the gun's distant
// REPORT (its own spectral signature) and past ~350 m into the DIST report; the rolling
// far TAIL rises `rise` dB per doubling against the report beyond 120 m (the direct-to-tail ratio tells the range).
interface GunMix {
  body: number; sub: number; mech: number; tail: number; max: number; echo: number; duck: number; hear: number; pitch: number;
  a: number; knee: number; b: number; far: number; dist: number; ftail: number; rise: number;
  /** where the near body hands over to the far report (m) — default [15, 60] */
  nearBand?: [number, number];
}
const GUN: Record<WeaponId, GunMix> = {
  //         own body  sub  mech  tail    audible  echo  duck  3P level  pitch±   near/knee/far slope   report  dist  far tail  rise
  // every layer is the real take — the sub is the shot's OWN low end (< 160 Hz), so it
  // is mixed in for weight (the sniper's boom -28.3 dB re its body, the shotgun's -24.5, the AR's -27; the pistol / SMG have none)
  pistol: { body: -6.2, sub: -60.0, mech: -38.2, tail: -19.0, max: 660, echo: -30, duck: 0.6, hear: -3.5, pitch: 0.35, a: 4.5, knee: 50, b: 3.8, far: 0, dist: -2, ftail: -14, rise: 6 },
  smg: { body: -4.3, sub: -60.0, mech: -36.3, tail: -18.0, max: 680, echo: -22, duck: 0.55, hear: -3, pitch: 0.4, a: 4.5, knee: 50, b: 3.2, far: 0, dist: -2, ftail: -14, rise: 6 },
  ar: { body: -2.9, sub: -30.0, mech: -34.9, tail: -11.0, max: 760, echo: -3, duck: 0.8, hear: -3, pitch: 0.3, a: 4.2, knee: 60, b: 3.2, far: 0, dist: -2, ftail: -14, rise: 6 },
  shotgun: { body: -1.5, sub: -26.0, mech: -41.5, tail: -14.0, max: 700, echo: -2, duck: 1.0, hear: -3.5, pitch: 0.3, a: 3.9, knee: 50, b: 3.4, far: 0, dist: -2, ftail: -14, rise: 6 },
  // THE SNIPER is the loudest gun at every range (5 m: ≥ rocket + 1 dB) and carries furthest (-2.6 dB/dbl past
  // 80 m); its 1P boom is 80-250 Hz chest (the sub sits under it, not over it, or the shot reads as mostly boom)
  sniper: { body: 2.3, sub: -26.0, mech: -37.7, tail: 1.2, max: 1300, echo: 1, duck: 1.0, hear: 3.0, pitch: 0.25, a: 2.5, knee: 80, b: 3.4, far: 1.5, dist: 2.5, ftail: -14, rise: 6, nearBand: [40, 120] },
  rocket: { body: 0.3, sub: -16.9, mech: -33.7, tail: -1.9, max: 820, echo: -1, duck: 1.0, hear: -3, pitch: 0.3, a: 4.5, knee: 60, b: 3.0, far: 0, dist: -2, ftail: -14, rise: 6, nearBand: [30, 95] },
  // silent stealth bow: soft close release, inaudible past 55 m
  bow: { body: -11.5, sub: -60.0, mech: -34.0, tail: -30.0, max: 55, echo: -40, duck: 0.25, hear: -12, pitch: 0.6, a: 7.0, knee: 20, b: 6.0, far: -24, dist: -30, ftail: -30, rise: 2 },
  // heavy rotary minigun: punchy sustained bark
  minigun: { body: -1.8, sub: -26.0, mech: -32.0, tail: -9.5, max: 800, echo: -2, duck: 0.85, hear: -2.0, pitch: 0.5, a: 4.0, knee: 65, b: 3.2, far: 0, dist: -2, ftail: -13, rise: 6 },
};

/** the sniper's BOLT CYCLE after every shot (s after the shot; the rifle fires every 1.43 s): handle up (lugs
 * unlock), bolt back (case out), bolt forward (a round stripped into the chamber), handle down (lock-up). The weapon
 * viewmodel's bolt animation keys on these same times. */
export const SNIPER_BOLT: { part: "up" | "back" | "fwd" | "down"; t: number; db: number }[] = [
  { part: "up", t: 0.46, db: -15 }, { part: "back", t: 0.56, db: -13 }, { part: "fwd", t: 0.74, db: -13 }, { part: "down", t: 0.86, db: -12 },
];

/** YOUR whole shot event (dbLocal; every local layer — tail, mech, casing, bolt — keeps its designed level
 * relative to it) and the 1P take's own offset in it. The takes keep their real pressure spike (crest 18-23 dB), so the
 * event sits 2-5.5 dB lower and the take is set for a true peak ≈ -2.5 dBTP with no limiting at all
 * (measured on 1P renders: pistol -24, SMG -23.5, AR / shotgun / rocket -22.5, sniper -20.3 I100) */
const OWN: Record<WeaponId, number> = { pistol: -9.5, smg: -8.0, ar: -8.1, shotgun: -5.6, sniper: -12.5, rocket: -2.7, bow: -10.5, minigun: -7.2 };
const P1_DB: Record<WeaponId, number> = { pistol: 0, smg: 0, ar: 0, shotgun: 0, sniper: 0, rocket: 0, bow: 0, minigun: -0.5 };
const TAIL_1P: Record<WeaponId, number> = { pistol: 3, smg: 5, ar: 5, shotgun: 4, sniper: 9, rocket: 3, bow: 6, minigun: 5 };
const MECH_T: Record<WeaponId, number> = { pistol: 0.024, smg: 0.022, ar: 0.032, shotgun: 0.036, sniper: 0.03, rocket: 0.03, bow: 0.015, minigun: 0.018 };
const CASE_T: Record<WeaponId, number> = { pistol: 0.2, smg: 0.3, ar: 0.46, shotgun: 0, sniper: 0, rocket: 0, bow: 0, minigun: 0.28 };
// (the sniper's send is -21, not -12: its bright yard return filled 4-8 kHz of YOUR shot's first 120 ms 10 dB over the take
// itself and buried the boom; the room / valley tails are the tail layers' job)
const SEND: Record<WeaponId, number> = { pistol: -30, smg: -26, ar: -20, shotgun: -18, sniper: -21, rocket: -16, bow: -42, minigun: -19 };

function gunDef(w: WeaponId): EventDef {
  const m = GUN[w];
  if (w === "bow") {
    // Silent Bamboo Bow: taut jungle bowstring snap + crisp air whoosh, audibly stealthy (55 m max)
    return {
      bus: "p3", busLocal: "p1", db: m.hear, dbLocal: OWN.bow, duck: m.duck, cap: 12, group: "gun", send: SEND.bow, prio: 2,
      layers: [
        { g: "w/zip/attach", db: -2, pitch: 0.6, rate: 1.32, who: "local" },
        { g: "move/jump", db: -4, pitch: 0.8, rate: 1.45, delay: 0.01, who: "local" },
        { g: "w/pistol/mech", db: -14, pitch: 0.5, rate: 0.85, delay: 0.015, who: "local" },
        { g: "w/zip/attach", db: -4, pitch: 0.6, rate: 1.28, who: "remote" },
        { g: "move/jump", db: -7, pitch: 0.8, rate: 1.4, who: "remote" },
      ],
      spatial: { ref: 3, max: m.max, rolloff: 1.3, curve: { a: m.a, knee: m.knee, b: m.b }, air: 140, occl: true, hrtf: 35 },
    };
  }
  const srcW = w === "minigun" ? "ar" : w;
  const rate = w === "minigun" ? 0.84 : undefined;
  const body = `w/${srcW}/body`;
  const layers: Layer[] = [
    // your own gun has its OWN 1P body (stereo, with presence + crack — w/<g>/p1, falls back to the 3P body); others
    // hear the mono 3P body that crossfades into the far report
    // (no pitch jitter on YOUR shot — a resampled source interpolates the 2-4-sample pressure spike down by up to
    // 3 dB, which flattened the sniper's first peak to the blast's height; the 8-10 round-robins are the variation)
    { g: `w/${srcW}/p1`, db: 2.5 + P1_DB[w], pitch: 0, rate, who: "local" },
    { g: body, db: 0, pitch: m.pitch, rate, band: "near", who: "remote" },
    // NO separate 1P sub: one from another take peaks 3-6 ms
    // after p1's spike (a flam); the boom is p1's own low end. The real mechanism (bolt carrier /
    // slide / action) cycles 22-40 ms after the shot, under the blast — never inside the first-peak window
    { g: `w/${w === "minigun" ? "smg" : srcW}/mech`, db: m.mech - m.body, who: "local", delay: MECH_T[w], pitch: 0.5 },
    // YOUR tail sits TAIL_1P dB lower than the one others hear — the range's reflections (45 ms on) filled the first
    // 120 ms of your own shot with their bright roll and blurred every gun's signature (the octave shapes read 2-4 dB apart)
    { g: `w/${srcW}/tail`, db: m.tail - m.body - TAIL_1P[w], band: "tail", pitch: 0.4, delay: 0.05, jitter: 0.004, inDb: (w === "sniper" ? 9 : 4) + TAIL_1P[w], who: "local" },
    { g: `w/${srcW}/tail`, db: m.tail - m.body, band: "tail", pitch: 0.4, jitter: 0.004, inDb: w === "sniper" ? 9 : 4, who: "remote" },
    { g: `w/${srcW}/far`, db: m.far, band: "far", who: "remote", pitch: 0.4, rate, match: body },
    { g: `w/${srcW}/dist`, db: m.dist, band: "dist", who: "remote", pitch: 0.3, rate, match: body },
    { g: `w/${srcW}/far-tail`, db: m.ftail, band: "ftail", who: "remote", pitch: 0.3, jitter: 0.01, match: body },
  ];
  // the spent case hits the ground: each gun ejects its own way (a pistol's case drops close and early, the AR's flies
  // further) — the ring-outs end at different times
  if (w !== "shotgun" && w !== "rocket" && w !== "sniper") layers.push({ g: "w/casing", db: -26 - m.body, who: "local", delay: CASE_T[w], jitter: 0.06, chance: 0.45, pitch: 1.5 });
  if (w === "sniper") {
    // THE BOLT CYCLE — four moves on the viewmodel's bolt keys (SNIPER_BOLT), 6 variants each; the case spins out on
    // the back stroke and lands on the ground ~0.4 s later. Others hear it too within ~40 m (the near band)
    for (const k of SNIPER_BOLT) {
      layers.push({ g: `w/sniper/bolt-${k.part}`, db: k.db - m.body, who: "local", delay: k.t, pitch: 0.35 });
      layers.push({ g: `w/sniper/bolt-${k.part}`, db: k.db - 4, who: "remote", band: "near", delay: k.t, pitch: 0.35 });
    }
    layers.push({ g: "w/casing", db: -24 - m.body, who: "local", delay: 0.98, jitter: 0.08, pitch: 1.0 });
  }
  return {
    // (the yard-reverb send per gun — a pistol's crack barely wakes the space, a sniper fills it: each gun's
    // ring-out ends where its own tail does, not on the shared reverb's 0.8 s)
    bus: "p3", busLocal: "p1", db: m.hear, dbLocal: OWN[w], layers, duck: m.duck, cap: 30, group: "gun", send: SEND[w], prio: 2,
    // one trigger per shot: a remote shotgun blast arrives as 9 pellet EV.Shots from the same muzzle in the same tick
    burst: { win: 0.03, max: 1, radius: 3 },
    spatial: {
      ref: 5, max: m.max, rolloff: 1, curve: { a: m.a, knee: m.knee, b: m.b }, air: 320, occl: true, travel: true, echo: m.echo, hrtf: 45,
      // the sniper's report is the loudest thing on the island — a ridge between you shades it (-8 dB, a 1.8 kHz
      // low-pass at full occlusion), it does not swallow its 1-4 kHz crack the way it muffles a pistol
      ...(w === "sniper" ? { occlDb: 3, occlHz: 5000 } : {}),
      bands: { near: m.nearBand ?? [15, 60], far: [250, 480], tail: [40, 160], ftail: [25, 100, m.rise, 150] },
    },
  };
}

// reloads are per-KEYFRAME one-shots on the weapon viewmodel's reload choreography — client/src/weapons/viewmodel.ts
// RELOAD_KEYS_VM (fractions u of the sim's reload time; mirrored here, not imported: the audio bundle stays free of three.js):
//   mag (SMG, AR)  grab .16 · out .30 · drop .31 · fetch .44 · insert .64 · slap .66 · done .84
//   pistol         release .10 · drop .20 · insert .60 · slap .62 · rack .84 · done .95
//   shell (shotgun, one per 0.55 s cycle)  fetch .20 · insert .62
//   bolt (sniper: NO magazine)  up .14 · back .22 · round1 .47 · round2 .68 · forward .78 · down .82 · done .90
//   warhead (rocket)  fetch .30 · slide .55 · seat .66 · done .86
// Each asset's transient sits at its start; nothing sounds after u = 1 (the voice is faded out there). The legacy whole take
// (`w/<g>/reload`) only plays while the keyframe set is missing from the library.
export const RELOAD_KEYS: Record<WeaponId, { g: string; u: number; db?: number; pitch?: number }[]> = {
  pistol: [{ g: "w/pistol/rl-out", u: 0.1 }, { g: "w/pistol/rl-in", u: 0.6 }, { g: "w/pistol/rl-rack", u: 0.84 }],
  smg: [{ g: "w/smg/rl-out", u: 0.3 }, { g: "w/smg/rl-in", u: 0.64 }, { g: "w/smg/rl-rack", u: 0.84, db: -4 }],
  ar: [{ g: "w/ar/rl-out", u: 0.3 }, { g: "w/ar/rl-in", u: 0.64 }, { g: "w/ar/rl-rack", u: 0.84, db: -3 }],
  // one call per SHELL (the sim loads one shell per 0.55 s): fetched at .20, thumbed into the port at .62
  shotgun: [{ g: "w/shotgun/rl-out", u: 0.2, db: -4 }, { g: "w/shotgun/rl-in", u: 0.62 }],
  // the bolt reload: the bolt cycle's own parts (6 variants each) + two rounds pressed into the open action
  sniper: [{ g: "w/sniper/bolt-up", u: 0.14 }, { g: "w/sniper/bolt-back", u: 0.22 }, { g: "w/sniper/rl-round", u: 0.47 }, { g: "w/sniper/rl-round", u: 0.68 },
    { g: "w/sniper/bolt-fwd", u: 0.78 }, { g: "w/sniper/bolt-down", u: 0.82 }],
  rocket: [{ g: "w/rocket/rl-out", u: 0.3 }, { g: "w/rocket/rl-in", u: 0.55 }, { g: "w/rocket/rl-rack", u: 0.66 }],
  bow: [{ g: "w/rocket/rl-out", u: 0.25, db: -6, pitch: 0.6 }, { g: "w/rocket/rl-in", u: 0.62, db: -5, pitch: 0.5 }],
  minigun: [{ g: "w/ar/rl-out", u: 0.24 }, { g: "w/ar/rl-in", u: 0.62 }, { g: "w/ar/rl-rack", u: 0.84, db: -2 }],
};
/** the HANDS between the keyframe clicks: per-move foley one-shots sized to each move of the viewmodel ~11 dB under the
 * clicks — the hand onto the gun, the empty mag hitting the ground (~70 ms after it is let go), the fresh one out of the
 * pouch, the hand back to the fore-end */
export const RELOAD_FOLEY: Record<WeaponId, { g: string; u: number; db: number }[]> = {
  pistol: [{ g: "w/pistol/rl-grip", u: 0.05, db: -11 }, { g: "w/pistol/rl-drop", u: 0.26, db: -9 }, { g: "w/pistol/rl-pouch", u: 0.38, db: -11 }, { g: "w/pistol/rl-hand", u: 0.72, db: -12 }],
  smg: [{ g: "w/smg/rl-grip", u: 0.16, db: -11 }, { g: "w/smg/rl-drop", u: 0.37, db: -9 }, { g: "w/smg/rl-pouch", u: 0.44, db: -11 }, { g: "w/smg/rl-hand", u: 0.7, db: -12 }],
  ar: [{ g: "w/ar/rl-grip", u: 0.16, db: -11 }, { g: "w/ar/rl-drop", u: 0.37, db: -9 }, { g: "w/ar/rl-pouch", u: 0.44, db: -11 }, { g: "w/ar/rl-hand", u: 0.7, db: -12 }],
  shotgun: [{ g: "w/shotgun/rl-grip", u: 0.05, db: -10 }],
  sniper: [{ g: "w/sniper/rl-grip", u: 0.06, db: -11 }, { g: "w/sniper/rl-pouch", u: 0.34, db: -11 }, { g: "w/sniper/rl-hand", u: 0.88, db: -12 }],
  rocket: [{ g: "w/rocket/rl-grip", u: 0.08, db: -11 }, { g: "w/rocket/rl-pouch", u: 0.3, db: -11 }],
  bow: [{ g: "w/rocket/rl-grip", u: 0.1, db: -12 }],
  minigun: [{ g: "w/ar/rl-grip", u: 0.14, db: -10 }, { g: "w/ar/rl-drop", u: 0.34, db: -8 }, { g: "w/ar/rl-pouch", u: 0.46, db: -10 }, { g: "w/ar/rl-hand", u: 0.72, db: -11 }],
};
/** the sim's reload time per weapon (shared/sim/const.ts reloadS) — the keyframes are fractions of it */
export const RELOAD_S: Record<WeaponId, number> = { pistol: 1.25, smg: 1.7, ar: 2.1, shotgun: 0.55, sniper: 2.7, rocket: 2.3, bow: 0.95, minigun: 3.4 };
const reloadDef = (w: WeaponId): EventDef => ({
  bus: "p3", busLocal: "p1", db: -6, dbLocal: -12, cap: 6, group: "reload",
  layers: [
    ...RELOAD_KEYS[w].map((k): Layer => ({ g: k.g, u: k.u, db: k.db ?? 0, pitch: k.pitch ?? 0.25 })),
    ...RELOAD_FOLEY[w].map((k): Layer => ({ g: k.g, u: k.u, db: k.db, pitch: 0.3 })),
    { g: `w/${w === "bow" ? "rocket" : w === "minigun" ? "ar" : w}/reload`, pitch: 0.2, ifMissing: RELOAD_KEYS[w][0].g },
  ],
  // (no reverb send: a reload is close foley in your hands, and nothing may ring on after the reload ends)
  spatial: { ref: 2, max: 28, rolloff: 1.3, occl: true, hrtf: 28 }, send: -99,
});

// ---------------------------------------------------------------- footsteps & bullet impacts per surface
const SURF: Surface[] = ["wood", "metal", "concrete", "stone", "sand", "grass", "water", "foliage", "glass", "fabric"];
const STEP_DB: Record<StepSurface, number> = { wood: 0, metal: 0, concrete: -1, stone: -1, sand: -1.5, grass: -1.5, water: 0, foliage: -1, glass: 0, fabric: -5, dirt: -1, mud: -0.5 };
/** every
 * step set is loudness-matched — STEP_NORM = the dB that brings each set's median 100 ms K-weighted peak loudness to one
 * reference (measured on the built files by the step-level tool, which writes this table), then the gait
 * offsets below put a walk ≥ 10 dB and a sprint ≥ 8 dB under the quietest gun's first-person level */
// STEP_NORM:BEGIN (generated by the step-level tool — do not edit by hand)
const STEP_NORM: Record<string, number> = {
  "step/concrete": -0.61,
  "step/concrete-crouch": -1.51,
  "step/concrete-land": -1.99,
  "step/concrete-run": 0.02,
  "step/dirt": 0.42,
  "step/dirt-crouch": -1.05,
  "step/dirt-land": -1.96,
  "step/dirt-run": -1.96,
  "step/fabric": -1.73,
  "step/fabric-crouch": -1.86,
  "step/fabric-land": -1.77,
  "step/fabric-run": -1.87,
  "step/foliage": 0.12,
  "step/foliage-crouch": 0.06,
  "step/foliage-land": -0.69,
  "step/foliage-run": -0.54,
  "step/glass": -0.76,
  "step/glass-crouch": -0.98,
  "step/glass-land": -1.53,
  "step/glass-run": 0.65,
  "step/grass": -1.56,
  "step/grass-crouch": -1.12,
  "step/grass-land": -1.92,
  "step/grass-run": -1.92,
  "step/metal": -1.77,
  "step/metal-crouch": -1.88,
  "step/metal-land": -1.7,
  "step/metal-run": -1.14,
  "step/mud": -1.02,
  "step/mud-crouch": -1.07,
  "step/mud-land": -1.83,
  "step/mud-run": -1.4,
  "step/sand": 0.08,
  "step/sand-crouch": -0.83,
  "step/sand-land": -1.76,
  "step/sand-run": -1.44,
  "step/stone": -1.27,
  "step/stone-crouch": -1.22,
  "step/stone-land": -1.25,
  "step/stone-run": -0.63,
  "step/water": -1.46,
  "step/water-crouch": -1.51,
  "step/water-land": -0.81,
  "step/water-run": -1.57,
  "step/wood": -1.53,
  "step/wood-crouch": -1.31,
  "step/wood-land": -2.02,
  "step/wood-run": -1.89,
};
// STEP_NORM:END
type StepKind = "walk" | "run" | "land" | "crouch";
const STEP_KIND_DB: Record<StepKind, [number, number]> = { walk: [0, 0], run: [1.5, 1.5], land: [3, 3.5], crouch: [-9, -9] };
/** per surface four recorded sets: walk (`step/<s>`, ≥ 12 round-robins),
 * sprint (`step/<s>-run`: heavier heel strike + push-off scuff), landing (`step/<s>-land`: a jump / drop onto it) and
 * crouch (`step/<s>-crouch`: the softest, rolled heel-to-toe placements) */
const stepDef = (s: StepSurface, kind: StepKind): EventDef => {
  const g = kind === "walk" ? `step/${s}` : `step/${s}-${kind}`, n = STEP_NORM[g] ?? 0;
  return {
    // enemy steps are gameplay information (readable at ~35 m over the beds, through walls muffled) — but they are FEET:
    // ~10 dB under gun level (at 12 m a pistol is ≥ 8 dB and an AR ≥ 12 dB louder; a step in your room sits ≥ 8 dB under
    // your own AR) and readable with a presence lift (heel + grit, where the beds are thin). The surface is what the feet
    // stand on (steps.ts: the drawn floor, the collider, the terrain's visible splat).
    bus: "p3", busLocal: "p1", db: -8 + n + STEP_KIND_DB[kind][0] + (STEP_NORM[g] === undefined ? STEP_DB[s] : 0),
    dbLocal: -22.5 + n + STEP_KIND_DB[kind][1] + (STEP_NORM[g] === undefined ? STEP_DB[s] : 0),
    layers: [{ g, pitch: 0.5 }], cap: 16, group: "step", gap: kind === "land" ? 0.15 : 0.06, prio: 1,
    spatial: { ref: 3, max: kind === "land" ? 55 : kind === "crouch" ? 22 : 45, rolloff: 0.8, curve: { a: 5.5, knee: 8, b: 4 }, air: 90, occl: true, occlDb: 7, occlHz: 2200, hrtf: 45 }, send: -22, eq3p: [["peaking", 1700, 5, 0.55], ["lowshelf", 260, -8, 0.7]],
  };
};
const impactDef = (s: Surface): EventDef => ({
  // a shotgun blast = 9 impacts in one tick: two of them speak for the blast
  bus: "p3", db: -1, layers: [{ g: `imp/${s}`, pitch: 1.2 }], cap: 12, group: "impact", gap: 0.02, burst: { win: 0.03, max: 2, radius: 40, by: "group" },
  spatial: { ref: 2, max: 70, rolloff: 1.0, air: 120, occl: true, hrtf: 30 }, send: -16,
});

// ---------------------------------------------------------------- everything else
const S = (d: Partial<EventDef> & Pick<EventDef, "layers" | "bus">): EventDef => d;

export const BANK: Record<string, EventDef> = {
  equip: S({ bus: "p3", busLocal: "p1", db: -8, dbLocal: -10, layers: [{ g: "w/equip", pitch: 0.3 }], spatial: { ref: 2, max: 20, rolloff: 1.3 } }),
  // a click, not a shot
  dryfire: S({ bus: "p3", busLocal: "p1", db: -17, dbLocal: -16, layers: [{ g: "w/dry", pitch: 0.4 }], gap: 0.05, spatial: { ref: 2, max: 18, rolloff: 1.3 } }),

  // shooter feedback (2D on the UI bus: always readable, never ducked). With pos: someone else got hit near you.
  // The body confirm carries a bright 2-5 kHz tick ~35 ms after the shot — past your own gun's crack, where it cuts through
  // full-auto fire (the thwump alone was masked by the AR's tail).
  // the confirms are DRY (no ringing partials): YOUR hit = the tick (a crisp 'tk') over a faint flesh slap, a
  // headshot its own sharper + heavier tick, a kill the separate heavy confirm below. Someone else hit near you (pos) =
  // the flesh slap only.
  "hit:body": S({ confirm: true, bus: "p3", busLocal: "ui", db: -8, dbLocal: -13, layers: [{ g: "hit/body", pitch: 0.5, delay: 0.012, who: "remote" }, { g: "hit/body", db: -8, pitch: 0.5, delay: 0.012, who: "local" }, { g: "hit/tick", db: 3.5, delay: 0.035, pitch: 0.4, who: "local" }], gap: 0.025, cap: 6, group: "hit", prio: 3, spatial: { ref: 3, max: 40, rolloff: 1.2 } }),
  // YOU got hit: a low body blow from the inside (no confirm tick — that sound means YOU hit someone)
  // a body SMACK (250 Hz-3.4 kHz punch + slap + a knocked-out 'hff'), audible on laptop speakers — still no tick
  // (on the p1 bus — your own body — so a hit confirm's tick can push it aside for 90 ms)
  hurt: S({ bus: "p1", db: -11, layers: [{ g: "hit/hurt", pitch: 0.4 }], gap: 0.05, cap: 3, prio: 3 }),
  // the headshot is the BIGGER reward — 1-3 dB over the body confirm,
  // with its own tick (sharper, heavier — hit/head) in the body tick's slot, 35 ms after the shot
  "hit:head": S({ confirm: true, bus: "p3", busLocal: "ui", db: -6, dbLocal: -8.5, layers: [{ g: "hit/head", db: 0.5, pitch: 0.25, delay: 0.035, who: "local" }, { g: "hit/body", db: -9, pitch: 0.5, delay: 0.012, who: "local" }, { g: "hit/body", pitch: 0.5, delay: 0.012, who: "remote" }], gap: 0.025, cap: 6, group: "hit", prio: 3, spatial: { ref: 3, max: 50, rolloff: 1.2 } }),
  "hit:shield": S({ confirm: true, bus: "p3", busLocal: "ui", db: -8, dbLocal: -11.5, layers: [{ g: "hit/shield", pitch: 0.6, delay: 0.012 }, { g: "hit/tick", db: -1.5, delay: 0.035, pitch: 0.8, rate: 1.12, who: "local" }], gap: 0.025, cap: 6, group: "hit", prio: 3, spatial: { ref: 3, max: 40, rolloff: 1.2 } }),
  // a predicted hit (its tick already played) confirmed on a shield: the crackle alone — hit:shield's own
  // tick on top would make every shield hit tick twice
  "hit:shield:confirm": S({ confirm: true, bus: "ui", db: -11.5, layers: [{ g: "hit/shield", pitch: 0.6, delay: 0.012 }], gap: 0.025, cap: 6, group: "hit", prio: 3 }),
  hitmarker: S({ confirm: true, bus: "ui", db: -11, layers: [{ g: "hit/tick", pitch: 0.4 }], gap: 0.02, cap: 4, prio: 3 }),
  // a confirm's own layers start 12 ms after the shot (its tick at 35 ms): your gun's crack peaks in its first
  // ~10 ms, and a confirm landing on it summed the two peaks into the master limiter (sniper + headshot: 1 dB of limiting)
  // the KILL is the biggest reward of the fight: ≥ 2 dB over a headshot in I100 and M; the three
  // confirms stay ≥ +10 dB over your own full-auto in 1-5 kHz so the kill stands out
  // the kill confirm is a heavy DRY thwack (no chord, no mallets): spent by ~120 ms, so the medal 150 ms
  // later (ui:medal*) lands on a clear stage — the confirm is the impact, the medal the fanfare
  kill: S({ confirm: true, bus: "ui", db: 0, layers: [{ g: "hit/kill", delay: 0.012 }] }),
  "elim:self": S({ bus: "ui", db: -3, layers: [{ g: "ui/elim-self" }] }),

  jump: S({ bus: "p3", busLocal: "p1", db: -4, dbLocal: -12, layers: [{ g: "move/jump", pitch: 0.5 }], spatial: { ref: 2.5, max: 30, rolloff: 1.0, occl: true } }),
  land: S({ bus: "p3", busLocal: "p1", db: -1, dbLocal: 0, layers: [{ g: "move/land", pitch: 0.5 }], spatial: { ref: 3, max: 45, rolloff: 0.9, occl: true } }),
  slide: S({ bus: "p3", busLocal: "p1", db: -3, dbLocal: -10, layers: [{ g: "move/slide", pitch: 0.4 }], spatial: { ref: 2.5, max: 35, rolloff: 1.0, occl: true } }),

  "chest:hum": S({ bus: "world", db: -4, layers: [{ g: "loot/chest-hum", drift: 2, shuffle: [2.5, 5] }, { g: "loot/chest-hum-b", db: -3, drift: 2.5, shuffle: [2, 4.5] }], loop: "plain", spatial: { ref: 2.5, max: 24, rolloff: 1.6, occl: true, hrtf: 30 }, send: -14 }),
  "chest:open": S({ bus: "world", busLocal: "ui", db: -3, dbLocal: -6, layers: [{ g: "loot/chest-open" }], spatial: { ref: 3, max: 45, rolloff: 1.0, occl: true }, send: -14 }),
  "pickup:weapon": S({ bus: "p3", busLocal: "p1", db: -8, dbLocal: -9, layers: [{ g: "loot/pick-weapon", pitch: 0.3 }], spatial: { ref: 2, max: 18, rolloff: 1.3 } }),
  "pickup:ammo": S({ bus: "p3", busLocal: "p1", db: -8, dbLocal: -10, layers: [{ g: "loot/pick-ammo", pitch: 0.4 }], spatial: { ref: 2, max: 18, rolloff: 1.3 } }),
  "pickup:heal": S({ bus: "p3", busLocal: "p1", db: -8, dbLocal: -10, layers: [{ g: "loot/pick-heal", pitch: 0.3 }], spatial: { ref: 2, max: 18, rolloff: 1.3 } }),
  // heal / shield use: a start cue, a sip / fizz LOOP for exactly the use time, and a completion cue per consumable at the
  // end (index.ts useStart); `heal:use`/`shield:use` fall back to the one-shots below if the loop assets are missing
  "heal:use": S({ bus: "p3", busLocal: "p1", db: -7, dbLocal: -9, layers: [{ g: "loot/heal-use" }], spatial: { ref: 2, max: 25, rolloff: 1.2, occl: true } }),
  "shield:use": S({ bus: "p3", busLocal: "p1", db: -7, dbLocal: -9, layers: [{ g: "loot/shield-use" }], spatial: { ref: 2, max: 30, rolloff: 1.2, occl: true } }),
  "shield:break": S({ bus: "p3", busLocal: "ui", db: -5, dbLocal: -3, layers: [{ g: "loot/shield-break", pitch: 0.4 }], spatial: { ref: 3, max: 50, rolloff: 1.1 } }),

  // the jump plane is a BIG loud source: full level to 60 m, -6 dB per doubling beyond, audible across the island
  // cabin = three decorrelated layers of different lengths (engines 8 s, ramp air 11.3 s, airframe 13.7 s) + random
  // strap / chain rattles, so the cabin never repeats; the exterior drone is the far band
  "plane:drone": S({
    bus: "world", db: 2, loop: "plane", spatial: { ref: 60, max: 2500, rolloff: 1.0, air: 1400, hrtf: 400 },
    // the cabin sits at ≈ -21 LUFS — the drop cues must read over it
    // the exterior drone drifts ±1.5 dB and re-seeks every 4-8 s (a plain 12 s loop audibly repeats from the chase cam)
    layers: [{ g: "air/plane-int", band: "near", db: -6.5, drift: 1, shuffle: [5, 9] }, { g: "air/plane-int-b", band: "near", db: -10.5, drift: 1.5, shuffle: [3, 6.5] }, { g: "air/plane-int-c", band: "near", db: -10.5, drift: 2, shuffle: [4, 8] }, { g: "air/plane-ext", band: "far", drift: 1.5, shuffle: [4, 8] }],
    sprinkle: { g: "air/rattle", every: [0.25, 1.3], db: -14, pitch: 1.5 },
  }),
  // (the winds / cabin / bay / exit sit 2 dB lower and the canopy snap + the landing 2 dB higher
  // — the snap stands out of the freefall wind it cuts, the landing out of the glide)
  "jump:exit": S({ bus: "p1", db: -8, layers: [{ g: "air/jump-exit" }] }),
  // RAMP OPEN — the cargo bay's jump bell + buzzer + ramp clunk + air rush (gameplay: on ANN.PlaneOpen)
  "plane:ramp": S({ bus: "ui", db: -6, layers: [{ g: "air/ramp" }], cueDuck: [9, 1.4] }),
  // every layer a REAL freefall recording — the body of the fall, the bright rush that
  // rises with speed, the dive's violent buffeting that only a head-down dive (≥ 45 m/s) opens; your suit flapping on top
  "freefall:wind": S({ bus: "p1", db: -1, layers: [
    { g: "air/freefall", drift: 1.5, shuffle: [6, 12], speed: [8, 36, -8, 0] },
    { g: "air/freefall-b", db: -3, drift: 2, shuffle: [3, 6], speed: [20, 58, -20, 0] },
    { g: "air/dive", db: -1, drift: 2, shuffle: [3, 7], speed: [42, 58, -40, 0] },
  ], loop: "freefall", sprinkle: { g: "air/flap", every: [0.3, 1.4], db: -7, pitch: 2 } }),
  // your own canopy snap is 8 dB down — still ~4 dB over
  // the freefall wind it cuts
  "glider:open": S({ bus: "p3", busLocal: "p1", db: -6, dbLocal: 3, layers: [{ g: "air/glider-open" }], spatial: { ref: 4, max: 80, rolloff: 1.0 } }),
  // (both layers drift and re-seek, so the glider never audibly repeats)
  // canopy flight + a paraglider wing (real), and the fabric FLUTTER that a turn (or a fast dive) opens — the
  // creaks / flaps come 4× as often in a hard turn (index.ts sprinkle)
  "glider:wind": S({ bus: "p1", db: -8, layers: [
    { g: "air/glider", drift: 1.5, shuffle: [2.5, 5] },
    { g: "air/glider-b", db: -3, drift: 2, shuffle: [3.5, 7] },
    { g: "air/flutter", db: 15, drift: 2, shuffle: [3, 6], turn: [0.15, 0.9, -30, 0], speed: [22, 36, -36, -18] },
  ], loop: "glider", sprinkle: { g: "air/flap", every: [1.2, 3.5], db: 0, pitch: 1.5 } }),
  // the cargo ramp is OPEN — real highway-speed wind roaring through the bay under the cabin, until you jump
  // (the engine starts it itself after plane:ramp; level = the plane's ride mix × how open the ramp is)
  "plane:bay": S({ bus: "p1", db: -6, layers: [{ g: "air/bay-wind", drift: 1.5, shuffle: [4, 9] }], loop: "bay" }),

  "storm:loop": S({ bus: "world", db: -2, layers: [{ g: "storm/wall" }], loop: "storm", spatial: { ref: 20, max: 260, rolloff: 0.8, air: 400, hrtf: 260 } }),
  // THE STORM WALL (engine-driven from env.storm): a spatial emitter at the point of the safe circle nearest you (far
  // band) — audible ~200 m out on the safe side, +25 dB as you walk up to it — and the 2D surround roar (near band)
  // that takes over as you cross into the storm
  // the wall CARRIES — a 0.5-4 kHz wind-shear howl (storm/shear) leads the far band, the distance curve is -5 dB per
  // doubling out to 320 m (audible over the beds ~150 m out); inside, three co-prime layers (17.3 / 23.9 / 31.1 s) +
  // random crackles never line up, and the crossfade keeps the level as you cross
  "storm:wall": S({
    bus: "world", db: -2, loop: "wall",
    layers: [
      { g: "storm/shear", band: "far", db: 2.5 }, { g: "storm/wall", band: "far", db: -3 },
      { g: "storm/wall-b", band: "near", db: -3 }, { g: "storm/wall-c", band: "near", db: -1.5 }, { g: "storm/wall", band: "near", db: -3.5 },
    ],
    spatial: { ref: 8, max: 320, rolloff: 1.0, curve: { a: 5.0, knee: 1000, b: 5.0 }, air: 600, hrtf: 1e9 },
    sprinkle: { g: "storm/crackle", every: [0.2, 0.9], db: -8, pitch: 2 },
  }),
  "storm:shrink": S({ bus: "ui", db: -4, layers: [{ g: "storm/shrink" }] }),
  "storm:damage": S({ bus: "ui", db: -6, layers: [{ g: "storm/damage", pitch: 0.4 }], gap: 0.1 }),

  // explosion: crack + sub thump at onset, body, debris — the loudest thing on the island within ~10 m (5 m ≥ +3 LU over
  // your own AR), a rolling boom from across the map
  explosion: S({
    // louder and flatter up close (5 m ≈ own AR + 4.5 LU, 30 m ≥ your own AR: a rocket landing in your fight is THE
    // event), then -6 dB per doubling past 40 m; the blast body carries 1-4 kHz and its debris rains 0.3-1.8 s
    // (-4 dB with your guns — the shots keep their real spike and sit ~4 dB lower in loudness: same balance)
    bus: "world", busLocal: "world", db: -5.5, dbLocal: -5.5, cap: 8, group: "boom", shock: true, send: -10, prio: 3,
    layers: [{ g: "exp/near", band: "near", pitch: 0.5 }, { g: "exp/far", band: "far", db: 6, pitch: 0.5 }],
    spatial: { ref: 10, max: 1100, rolloff: 0.6, curve: { a: 2.5, knee: 40, b: 6 }, air: 450, occl: true, travel: true, echo: -1, near: [90, 260], far: [70, 220], hrtf: 150 },
  }),

  "ui:click": S({ bus: "ui", db: -10, layers: [{ g: "ui/click", pitch: 0.3 }], gap: 0.03 }),
  "ui:countdown": S({ bus: "ui", db: -4, layers: [{ g: "ui/countdown" }] }),
  "ui:countdown-go": S({ bus: "ui", db: -3, layers: [{ g: "ui/countdown-go" }], cueDuck: [9, 0.9] }),
  "ui:victory": S({ bus: "ui", db: -2, layers: [{ g: "ui/victory" }] }),
  "ui:resurgence": S({ bus: "ui", db: -3, layers: [{ g: "ui/resurgence" }] }),
  // the location banner's sting (synthesised: airy swell → D5 A5 D6 mallet arpeggio over a warm bed, 1.9 s)
  "ui:poi": S({ bus: "ui", db: -9, layers: [{ g: "ui/poi" }], gap: 1 }),
  // a place's own faint phrase, the first time you reach it in a match (assets at -24 LUFS-I, category amb):
  // ≈ -31 LUFS at the output, the level of the island's beds: barely noticed
  ...Object.fromEntries((["coast", "harbor", "jungle", "temple", "volcano", "town", "swamp", "lab", "caves"] as const).map((t) => [`ui:poi:${t}`, S({ bus: "ui", db: -6, layers: [{ g: `ui/poi-${t}` }], gap: 1 })])),
  // a medal pops (ui/medals.ts): 150 ms after the kill confirm, on the emblem's landing, ~7 dB under `kill`
  // (it rides on the confirm, it never masks it); the vehicle medals and the multi-kills get the big one
  "ui:medal": S({ bus: "ui", db: 2, layers: [{ g: "ui/medal", delay: 0.15 }], gap: 0.3 }),
  "ui:medal-big": S({ bus: "ui", db: 3.5, layers: [{ g: "ui/medal-big", delay: 0.15 }], gap: 0.3 }),
  whizz: S({ bus: "p3", db: -6, layers: [{ g: "fx/whizz", pitch: 1.0 }], gap: 0.04, cap: 6, prio: 2, burst: { win: 0.03, max: 2, radius: 1e9 }, spatial: { ref: 3, max: 30, rolloff: 1.0, hrtf: 30 } }),
  "fx:tinnitus": S({ bus: "ui", db: -16, layers: [{ g: "fx/tinnitus" }] }),
  // the ZIPLINE (shared/sim/zipline.ts): the trolley's steel wheels on the cable, a LOOP whose rate
  // (pitch) and level follow the ride speed (PlayOpts.rate = speed / 16 m/s, updated with the same loopId — the engine's
  // bridge does it from the match state until gameplay calls it), the T-bar clacking on, the stop block at the far pole
  "zip:ride": S({ bus: "p3", busLocal: "p1", db: -6, dbLocal: -9, layers: [{ g: "w/zip/ride" }], loop: "zip", spatial: { ref: 4, max: 70, rolloff: 1.0, occl: true, hrtf: 40 } }),
  "zip:attach": S({ bus: "p3", busLocal: "p1", db: -5, dbLocal: -8, layers: [{ g: "w/zip/attach", pitch: 0.6 }], gap: 0.2, spatial: { ref: 3, max: 50, rolloff: 1.0, occl: true } }),
  // glass: a pane shatters — two real glass impacts (the crack + the burst, 35 ms apart) and the shards raining
  // onto the floor (the glass-debris step recordings), all from the existing library (no gun sound touched)
  "glass:break": S({ bus: "p3", busLocal: "p1", db: 1, dbLocal: -1, layers: [{ g: "imp/glass", pitch: 1.2 }, { g: "imp/glass", pitch: 2.5, delay: 0.035, jitter: 0.02, db: -2 }, { g: "step/glass-land", pitch: 1, delay: 0.1, jitter: 0.04, db: 1 }, { g: "step/glass-run", pitch: 1.5, delay: 0.24, jitter: 0.1, db: -4 }],
    cap: 8, group: "glass", gap: 0.03, burst: { win: 0.06, max: 2, radius: 8, by: "name" }, spatial: { ref: 3, max: 90, rolloff: 1.0, air: 120, occl: true, hrtf: 35 }, send: -14 }),
  // WATER, all real recordings already in the library. The SPLASH = the body slap on the surface
  // (step/water-land + the lagoon's hull slap), the plunge (a bullet's water impact slowed to a deep plop) and the wash +
  // bubbles closing over it; `volume` = impact speed (water-fx.ts). A STROKE = a wading run step pitched down with a lap
  // of the lagoon under it (cadence = the swim bob). OUT = the body pulling free of the water + drips off the fur.
  "water:splash": S({ bus: "p3", busLocal: "p1", db: -1, dbLocal: -3, layers: [{ g: "step/water-land", pitch: 0.8, rate: 0.85 }, { g: "amb1/slap", db: -2, pitch: 1 }, { g: "imp/water", db: -3, rate: 0.55, delay: 0.02, pitch: 1 }, { g: "amb1/bubble", db: -9, delay: 0.22, jitter: 0.08 }, { g: "amb1/surge", db: -12, delay: 0.1, chance: 0.6 }],
    cap: 6, group: "water", gap: 0.12, spatial: { ref: 3, max: 70, rolloff: 1.0, air: 150, occl: true, hrtf: 35 }, send: -16 }),
  "water:stroke": S({ bus: "p3", busLocal: "p1", db: -5, dbLocal: -9, layers: [{ g: "step/water-run", pitch: 0.8, rate: 0.82 }, { g: "amb1/lap", db: -10, pitch: 1.5, chance: 0.55 }],
    cap: 6, group: "water", gap: 0.18, spatial: { ref: 3, max: 40, rolloff: 0.9, curve: { a: 5.5, knee: 8, b: 4 }, air: 90, occl: true, occlDb: 7, occlHz: 2200, hrtf: 35 } }),
  "water:out": S({ bus: "p3", busLocal: "p1", db: -3, dbLocal: -6, layers: [{ g: "step/water-land", pitch: 0.6, rate: 1.1 }, { g: "step/water", db: -4, delay: 0.16, pitch: 1 }, { g: "amb1/drip", db: -8, delay: 0.42, jitter: 0.08, pitch: 2 }, { g: "amb1/drip", db: -11, delay: 0.7, jitter: 0.12, pitch: 2 }],
    cap: 4, group: "water", gap: 0.3, spatial: { ref: 3, max: 40, rolloff: 1.0, occl: true, hrtf: 30 } }),
  // ---- SWIMMING: REAL
  // recordings only, untouched takes (cut, faded, level-matched; no EQ / compression / limiting), all mono, all on the
  // step reference (M -24). The strokes, the treading and the splashes are ONE pool session (kyles, freesound 6379xx);
  // the under-water sounds are hydrophone takes; the kong's breaths are unvoiced human breaths 2-3 semitones down.
  // Levels, as 100 ms impulse loudness (P) at the output before the bus trim: YOUR stroke -32 / sprint stroke -30.5 (≥ 6 dB
  // under your pistol's -24, ~9 dB over your own sprint step's -41), treading -37.5; SOMEONE ELSE's stroke at ≤ 3 m -26
  // (a sprint step: -26) on water:stroke's distance law: about a sprint step's level
  // at 35-40 m, muffled (not gone) behind a wall.
  //   swim:stroke       one pull on the surface; the take's loudness peak is 0.10-0.15 s in — fire at the hand entry. Takes
  //                     are 1.0-1.2 s (splash ≈ 0.5 s + drips): one pull every 0.8-0.9 s (gap 0.3 s: never a machine gun)
  //   swim:stroke-fast  a sprint-crawl pull, splashier: peak 0.06-0.10 s, one every 0.55-0.65 s
  //   swim:tread        idle sculling / lapping, no big splash: one every ~1.1 s (1.1 s takes, they overlap seamlessly)
  // UNDER WATER (local only, no pos): the mixer's under-water low-pass (uwLP, 20 kHz → 450 Hz, -6 dB) sits on p1 / p3 /
  // world / amb; the UI bus bypasses it (the hydrophone bed amb/underwater already plays there). Your own bubbles, strokes
  // and heartbeat are bone-conducted and right at your ears — they must not be smeared into the 450 Hz mud — so they ride
  // the UI bus (no reverb, never ducked) and carry the under-water colour themselves: hydrophone recordings. They sit
  // about level with the bed (bed: -32 LUFS-I, -28 M; strokes -30 M, bubbles -30.5 M) so they read over it.
  //   swim:uw-stroke    a stroke while under: the hydrophone whoosh swells to its peak 0.3-0.5 s after the trigger
  //   swim:bubbles      an exhale bubble burst rising past your ears (1.35 s): every few seconds under / when low on air
  //   swim:low-air      ONE heartbeat (lub at 0.02 s, dub at ~0.27 s) per call: fire every ~0.9 s while breath < 30 %
  //                     (~0.7 s near empty). Subtle: 4 dB under the strokes
  // THE TRANSITIONS: yours on the UI bus too (the take itself goes from air to water / water to air: the camera's muffle
  // ramp — 60 ms in, 150 ms out — would otherwise swallow the plunge / the break); others' on p3 from the air.
  //   swim:dive         yours: a nose breath in → the head under at 0.30 s → the ears under (a hydrophone's immersion) at
  //                     0.36 s → bubbles rushing past (1.5 s). Others hear the head-under splash (swim/dive-w)
  //   swim:surface      the break (peak 0.05-0.10 s) + water streaming off the fur + a blowing exhale from 0.08 s (1.6 s)
  //   (yours under water — strokes, bubbles, heartbeat, the dive / surfacing — ride the `near` bus: past the underwater
  //    muffle, on the Combat volume; mixer.ts)
  //   swim:gasp         a big desperate inhale. Fire it WITH swim:surface when surfacing low on air: it waits 0.45 s, so
  //                     the blow-out lands first, then the gasp
  "swim:stroke": S({ bus: "p3", busLocal: "p1", db: -6, dbLocal: -12, layers: [{ g: "swim/stroke", pitch: 0.4 }],
    cap: 8, group: "swim", gap: 0.3, prio: 1, spatial: { ref: 3, max: 40, rolloff: 0.9, curve: { a: 5.5, knee: 8, b: 4 }, air: 90, occl: true, occlDb: 7, occlHz: 2200, hrtf: 35 } }),
  "swim:stroke-fast": S({ bus: "p3", busLocal: "p1", db: -4.5, dbLocal: -10.5, layers: [{ g: "swim/stroke-fast", pitch: 0.4 }],
    cap: 8, group: "swim", gap: 0.25, prio: 1, spatial: { ref: 3, max: 45, rolloff: 0.9, curve: { a: 5.5, knee: 8, b: 4 }, air: 90, occl: true, occlDb: 7, occlHz: 2200, hrtf: 35 } }),
  "swim:tread": S({ bus: "p3", busLocal: "p1", db: -12, dbLocal: -17, layers: [{ g: "swim/tread", pitch: 0.5 }],
    cap: 8, group: "swim", gap: 0.5, prio: 1, spatial: { ref: 2, max: 22, rolloff: 1.0, curve: { a: 6, knee: 6, b: 5 }, air: 90, occl: true, occlDb: 7, occlHz: 2200, hrtf: 25 } }),
  "swim:dive": S({ bus: "p3", busLocal: "near", db: -6, dbLocal: -9, layers: [{ g: "swim/dive", pitch: 0.3, who: "local" }, { g: "swim/dive-w", pitch: 0.4, who: "remote" }],
    cap: 4, group: "swim-big", gap: 0.4, prio: 1, send: -28, spatial: { ref: 3, max: 45, rolloff: 0.9, curve: { a: 5, knee: 10, b: 4 }, air: 120, occl: true, occlDb: 8, occlHz: 2000, hrtf: 35 } }),
  "swim:surface": S({ bus: "p3", busLocal: "near", db: -6, dbLocal: -8.5, layers: [{ g: "swim/surface", pitch: 0.3, who: "local" }, { g: "swim/surface-w", pitch: 0.3, who: "remote" }],
    cap: 4, group: "swim-big", gap: 0.4, prio: 1, send: -28, spatial: { ref: 3, max: 40, rolloff: 0.9, curve: { a: 5, knee: 10, b: 4 }, air: 120, occl: true, occlDb: 8, occlHz: 2000, hrtf: 35 } }),
  "swim:gasp": S({ bus: "p3", busLocal: "near", db: -9, dbLocal: -8, layers: [{ g: "swim/gasp", pitch: 0.25, delay: 0.45 }],
    cap: 3, group: "swim-big", gap: 0.8, prio: 1, send: -28, spatial: { ref: 2, max: 25, rolloff: 1.1, curve: { a: 6, knee: 6, b: 5 }, air: 90, occl: true, occlDb: 9, occlHz: 1800, hrtf: 25 } }),
  "swim:uw-stroke": S({ bus: "near", db: -6, layers: [{ g: "swim/uw-stroke", pitch: 0.5 }], cap: 3, group: "swim-uw", gap: 0.3 }),
  "swim:bubbles": S({ bus: "near", db: -6.5, layers: [{ g: "swim/bubbles", pitch: 0.6 }], cap: 2, group: "swim-uw", gap: 0.6 }),
  "swim:low-air": S({ bus: "near", db: -10, layers: [{ g: "swim/low-air" }], cap: 2, group: "swim-uw", gap: 0.5 }),
  // the VOLCANO UPDRAFT (real recordings): a deep roar of high wind slowed down + the volcano's rumble bed,
  // fumarole hisses sprinkled in; the rush on you = the freefall wind recordings, rising with the lift
  "updraft:roar": S({ bus: "world", db: -2, layers: [{ g: "amb/wind-high", rate: 0.72, drift: 2, shuffle: [4, 9] }, { g: "amb/volcanic-b", db: -4, rate: 0.9, drift: 1.5, shuffle: [5, 10] }],
    loop: "plain", sprinkle: { g: "amb1/fumarole", every: [0.6, 1.8], db: -6, pitch: 2 }, spatial: { ref: 18, max: 330, rolloff: 0.9, curve: { a: 4, knee: 60, b: 6 }, air: 400, occl: false, hrtf: 60 }, send: -14 }),
  "updraft:rush": S({ bus: "p1", db: -6, layers: [{ g: "air/freefall", drift: 1.5, shuffle: [5, 10] }, { g: "air/freefall-b", db: -4, drift: 2, shuffle: [3, 6] }], loop: "plain" }),
  // climbing (real foley from the library): grabbing a ladder = a hand slap on wood + a fabric creak; a rung
  // = a soft wooden knock (the crouched wood step) with a rope creak now and then
  "climb:grab": S({ bus: "p3", busLocal: "p1", db: -5, dbLocal: -8, layers: [{ g: "step/wood-land", pitch: 1.5, rate: 1.2 }, { g: "air/creak", db: -8, pitch: 1.5, chance: 0.7 }], gap: 0.2, spatial: { ref: 3, max: 40, rolloff: 1.0, occl: true, hrtf: 30 } }),
  "climb:rung": S({ bus: "p3", busLocal: "p1", db: -7, dbLocal: -11, layers: [{ g: "step/wood-crouch", pitch: 2, rate: 1.15 }, { g: "air/creak", db: -12, pitch: 2, chance: 0.25 }], gap: 0.08, cap: 6, group: "step", spatial: { ref: 3, max: 35, rolloff: 1.0, occl: true, hrtf: 30 } }),
  "zip:detach": S({ bus: "p3", busLocal: "p1", db: -5, dbLocal: -8, layers: [{ g: "w/zip/detach", pitch: 0.6 }], gap: 0.2, spatial: { ref: 3, max: 50, rolloff: 1.0, occl: true } }),

  // ---- THE TUK-TUK (shared/sim/vehicle.ts) — real recordings only.
  // The five LOOPS are "plain": gameplay owns pos / volume / rate through one loopId per vehicle (play() again with the same
  // loopId updates them, stopLoop ends it) and decides WHICH vehicles sound — loops are not voice-capped. No `pos` = you are
  // aboard: 2D on your own bus, ≥ 9 dB under your gun at volume 1. The engine is gameplay information: on a clear line it
  // reads to ~120 m (-3.5 dB per doubling to 64 m, -6 beyond: ≈ -29 LUFS at 40 m, -37 at 120 m, gone at 150 m) and a wall
  // muffles it without removing it.
  //   tuk:idle   the two-stroke putter at rest: 18.6 firings / s at rate 1 (drive it 0.85-1.2)
  //   tuk:drive  the same engine under load: `rate` IS the revs — 0.6 crawl (42 firings / s) … 1.6 flat out (112) —
  //              `volume` the load. Level-matched to the idle as recorded: the idle sits 4.5 dB under it
  //   tuk:skid   tyre squeal, `volume` = slip
  //   tuk:fire   the burning engine / wreck (a real car fire)
  //   tuk:fuse   the horn STUCK ON (the hero horn's note) over an engine that only rattles: the seconds before it blows.
  //              A falling `rate` (1 → 0.8) droops the blare like a dying battery
  "tuk:idle": S({ bus: "p3", busLocal: "p1", db: -5.5, dbLocal: -10.5, layers: [{ g: "veh/idle" }], loop: "plain", spatial: { ref: 8, max: 150, rolloff: 1.0, curve: { a: 3.5, knee: 64, b: 6 }, occl: true, hrtf: 50 } }),
  "tuk:drive": S({ bus: "p3", busLocal: "p1", db: -1, dbLocal: -6, layers: [{ g: "veh/drive" }], loop: "plain", spatial: { ref: 8, max: 150, rolloff: 1.0, curve: { a: 3.5, knee: 64, b: 6 }, occl: true, hrtf: 50 } }),
  "tuk:skid": S({ bus: "p3", busLocal: "p1", db: -5, dbLocal: -9, layers: [{ g: "veh/skid" }], loop: "plain", spatial: { ref: 5, max: 100, rolloff: 1.0, curve: { a: 5, knee: 40, b: 7 }, occl: true, hrtf: 40 } }),
  "tuk:fire": S({ bus: "world", busLocal: "p1", db: -5, dbLocal: -11, layers: [{ g: "veh/fire", drift: 2 }], loop: "plain", spatial: { ref: 4, max: 75, rolloff: 1.1, occl: true, hrtf: 30 }, send: -16 }),
  "tuk:fuse": S({ bus: "p3", busLocal: "p1", db: 0, dbLocal: -6, layers: [{ g: "veh/fuse" }], loop: "plain", spatial: { ref: 7, max: 190, rolloff: 1.0, curve: { a: 4, knee: 56, b: 7 }, occl: true, hrtf: 60 } }),
  // ONE-SHOTS. The horn carries like a horn (-37 LUFS at 160 m, a few dB of the yard's reverb); a crunch (heard to ~90 m,
  // the tip-over to ~110 m) takes how hard it hit as its `volume`.
  // Body sounds share one voice group (a pile-up of tuk-tuks is 4 voices, not 20); `gap` drops the repeats of a scrape
  // along a wall. Backfires stay low and short: a pop, never mistaken for a shot.
  "tuk:horn": S({ bus: "p3", busLocal: "p1", db: 4, dbLocal: -3, layers: [{ g: "veh/horn", pitch: 0.2 }], gap: 0.12, cap: 4, group: "tuk-horn", prio: 2, spatial: { ref: 7, max: 200, rolloff: 1.0, curve: { a: 4, knee: 60, b: 7 }, air: 300, occl: true, occlDb: 8, occlHz: 1600, travel: true, hrtf: 60 }, send: -14 }),
  "tuk:start": S({ bus: "p3", busLocal: "p1", db: -2, dbLocal: -5, layers: [{ g: "veh/start", pitch: 0.3 }], gap: 0.3, cap: 4, group: "tuk", spatial: { ref: 5, max: 90, rolloff: 1.0, curve: { a: 5.5, knee: 30, b: 7 }, occl: true, hrtf: 40 } }),
  "tuk:stop": S({ bus: "p3", busLocal: "p1", db: -4, dbLocal: -7, layers: [{ g: "veh/stop", pitch: 0.3 }], gap: 0.3, cap: 4, group: "tuk", spatial: { ref: 5, max: 70, rolloff: 1.0, curve: { a: 5.5, knee: 30, b: 7 }, occl: true, hrtf: 40 } }),
  "tuk:crash": S({ bus: "p3", busLocal: "p1", db: 2, dbLocal: -1, layers: [{ g: "veh/crash", pitch: 0.8 }], gap: 0.15, cap: 4, group: "tuk-hit", spatial: { ref: 5, max: 120, rolloff: 1.0, curve: { a: 5, knee: 40, b: 7 }, air: 200, occl: true, hrtf: 40 }, send: -14 }),
  "tuk:tip": S({ bus: "p3", busLocal: "p1", db: 5, dbLocal: 2, layers: [{ g: "veh/tip", pitch: 0.5 }], gap: 0.5, cap: 4, group: "tuk-hit", prio: 2, spatial: { ref: 6, max: 130, rolloff: 1.0, curve: { a: 4.5, knee: 40, b: 7 }, air: 200, occl: true, hrtf: 45 }, send: -12 }),
  "tuk:flip": S({ bus: "p3", busLocal: "p1", db: 1, dbLocal: -2, layers: [{ g: "veh/flip", pitch: 0.5 }], gap: 0.4, cap: 4, group: "tuk-hit", spatial: { ref: 5, max: 80, rolloff: 1.0, occl: true, hrtf: 40 }, send: -16 }),
  "tuk:land": S({ bus: "p3", busLocal: "p1", db: 0, dbLocal: -3, layers: [{ g: "veh/land", pitch: 0.8 }], gap: 0.12, cap: 4, group: "tuk-hit", spatial: { ref: 5, max: 70, rolloff: 1.0, occl: true, hrtf: 40 } }),
  // ---- the helicopter (shared/sim/heli.ts). The two loops ride the spool: `heli:rotor` is
  //   the chop (rate 0.62 … 1.04, volume with it), `heli:turbine` the whine under it; `heli:alarm` the cockpit warning
  //   of one on fire. Start / stop: the turbine winding up as the pilot sits down, down as they leave.
  "heli:rotor": S({ bus: "p3", busLocal: "p1", db: 0, dbLocal: -5, layers: [{ g: "heli/rotor" }], loop: "plain", spatial: { ref: 14, max: 420, rolloff: 1.0, curve: { a: 3, knee: 120, b: 6 }, air: 400, occl: true, occlDb: 6, hrtf: 60 }, send: -18 }),
  "heli:turbine": S({ bus: "p3", busLocal: "p1", db: -6, dbLocal: -10, layers: [{ g: "heli/turbine" }], loop: "plain", spatial: { ref: 10, max: 260, rolloff: 1.0, curve: { a: 3.5, knee: 80, b: 6 }, occl: true, hrtf: 50 } }),
  "heli:alarm": S({ bus: "p3", busLocal: "p1", db: -9, dbLocal: -8, layers: [{ g: "heli/alarm" }], loop: "plain", spatial: { ref: 4, max: 60, rolloff: 1.2, occl: true, hrtf: 30 } }),
  "heli:start": S({ bus: "p3", busLocal: "p1", db: -2, dbLocal: -6, layers: [{ g: "heli/start" }], gap: 0.5, cap: 3, group: "heli", spatial: { ref: 10, max: 200, rolloff: 1.0, curve: { a: 4, knee: 70, b: 6 }, occl: true, hrtf: 50 } }),
  "heli:stop": S({ bus: "p3", busLocal: "p1", db: -3, dbLocal: -7, layers: [{ g: "heli/stop" }], gap: 0.5, cap: 3, group: "heli", spatial: { ref: 10, max: 200, rolloff: 1.0, curve: { a: 4, knee: 70, b: 6 }, occl: true, hrtf: 50 } }),
  // the rotor cutting a kong down: the blade's smack on the body, a metal ring off its tip, a crunch under it —
  // layered from takes already in the game (the hit, a metal impact, the tuk-tuk's crash), pitched up and short
  "heli:chop": S({ bus: "p3", busLocal: "p1", db: 1, dbLocal: -2, layers: [{ g: "imp/metal", pitch: 0.8, rate: 1.3 }, { g: "hit/body", pitch: 0.5, delay: 0.012, db: 3 }, { g: "veh/crash", pitch: 0.6, rate: 1.6, delay: 0.025, db: -7 }], gap: 0.08, cap: 4, group: "tuk-hit", prio: 3, spatial: { ref: 5, max: 140, rolloff: 1.0, curve: { a: 5, knee: 40, b: 7 }, air: 200, occl: true, hrtf: 40 }, send: -14 }),
  // ---- TOP BANANA, the helicopter's door minigun (shared/sim/heli.ts HELI.GUN_*):
  //   a REAL M134 — its fire, the burst's tail, the motor winding the barrels up, their empty clatter, their
  //   coast to a stop — the overheated barrels' sizzle and quench hiss, a heavy rifle's dry clack for the empty belt.
  //   gun:fire is ONE loop per helicopter while rounds keep leaving (render.ts), not a shot per round. Its layers: the
  //   stereo take for whoever is aboard (no pos), the mono sum for the world (a stereo source smears the HRTF's direction).
  //   Levels (ear-proxy: what the engine plays — normDb × these dB × the p1 bus — measured as LUFS):
  //   aboard the fire loop sits at -21 LUFS-I, +4 dB over the rotor + turbine
  //   flat out (-24.9) and +4 dB over your own AR in full auto (-25.1 I), so it is the big gun without burying the
  //   helicopter; the tail's last rounds match the loop's 100 ms loudness (-21 P vs -20); the spin-up 5.5 dB under the fire
  //   (the take's own ratio), the clatter / sizzle 2-4 dB under the rotor (their 2-10 kHz still reads over its chop), the
  //   lock's hiss and the dry clack about level with the rotor. In the world the fire loop rides the rotor's own distance
  //   curve at +3 dB (-3 dB per doubling to 120 m, then -5 where the rotor falls -6): 2-3 dB over the helicopter to
  //   160 m, 4-5 dB beyond; +4 dB over an AR's full auto at 5 m, ~12 dB over it at 20-160 m (the helicopter itself is
  //   ~10 dB over the AR there). The mechanism's sounds carry ~160 m, the sizzle / lock ~120 m.
  "gun:fire": S({ bus: "p3", busLocal: "p1", db: 3, dbLocal: 0, layers: [{ g: "gun/fire", who: "local" }, { g: "gun/fire-w", who: "remote" }], loop: "plain", spatial: { ref: 14, max: 760, rolloff: 1.0, curve: { a: 3, knee: 120, b: 5 }, air: 320, occl: true, occlDb: 6, hrtf: 60 } }),
  "gun:stop": S({ bus: "p3", busLocal: "p1", db: -4, dbLocal: -7, layers: [{ g: "gun/stop", who: "local" }, { g: "gun/stop-w", who: "remote" }], gap: 0.1, cap: 4, group: "gun-heli", spatial: { ref: 14, max: 760, rolloff: 1.0, curve: { a: 3, knee: 120, b: 5 }, air: 320, occl: true, occlDb: 6, hrtf: 60 } }),
  "gun:spin": S({ bus: "p3", busLocal: "p1", db: -6, dbLocal: -9, layers: [{ g: "gun/spin" }], loop: "plain", spatial: { ref: 6, max: 160, rolloff: 1.0, curve: { a: 4.5, knee: 50, b: 6 }, occl: true, hrtf: 40 } }),
  "gun:spinup": S({ bus: "p3", busLocal: "p1", db: -4, dbLocal: -7, layers: [{ g: "gun/spinup" }], gap: 0.2, cap: 4, group: "gun-heli", spatial: { ref: 6, max: 160, rolloff: 1.0, curve: { a: 4.5, knee: 50, b: 6 }, occl: true, hrtf: 40 } }),
  "gun:spindown": S({ bus: "p3", busLocal: "p1", db: -5, dbLocal: -8, layers: [{ g: "gun/spindown" }], gap: 0.2, cap: 4, group: "gun-heli", spatial: { ref: 6, max: 160, rolloff: 1.0, curve: { a: 4.5, knee: 50, b: 6 }, occl: true, hrtf: 40 } }),
  "gun:hot": S({ bus: "p3", busLocal: "p1", db: -4, dbLocal: -6, layers: [{ g: "gun/hot" }], loop: "plain", spatial: { ref: 5, max: 120, rolloff: 1.0, curve: { a: 4.5, knee: 40, b: 6 }, occl: true, hrtf: 40 } }),
  "gun:lock": S({ bus: "p3", busLocal: "p1", db: -2, dbLocal: -5, layers: [{ g: "gun/lock" }], gap: 0.5, cap: 3, group: "gun-heli", spatial: { ref: 5, max: 120, rolloff: 1.0, curve: { a: 4.5, knee: 40, b: 6 }, occl: true, hrtf: 40 } }),
  "gun:dry": S({ bus: "p3", busLocal: "p1", db: -12, dbLocal: -10, layers: [{ g: "gun/dry" }], gap: 0.05, spatial: { ref: 3, max: 40, rolloff: 1.2 } }),
  "grapple:shoot": S({ bus: "p3", busLocal: "p1", db: -3, dbLocal: -6, layers: [{ g: "w/zip/attach", pitch: 0.5, rate: 1.15 }, { g: "w/zip/detach", db: -3, delay: 0.06, pitch: 0.5 }, { g: "move/jump", db: -5, delay: 0.08, rate: 1.25 }], gap: 0.15, cap: 6, group: "grapple", spatial: { ref: 4, max: 70, rolloff: 1.0, occl: true, hrtf: 40 } }),
  "airstrike:warn": S({ bus: "world", busLocal: "ui", db: 1, dbLocal: -4, layers: [{ g: "heli/alarm", db: -2, rate: 1.15 }, { g: "heli/alarm", db: -2, delay: 1.0, rate: 1.28 }, { g: "air/ramp", db: -5, delay: 0.25 }, { g: "air/plane-ext", db: -2, delay: 1.15, rate: 1.2 }], gap: 0.4, cap: 4, group: "airstrike", prio: 3, spatial: { ref: 24, max: 450, rolloff: 0.85, air: 500, hrtf: 120 }, send: -14 }),
  "tuk:backfire": S({ bus: "p3", busLocal: "p1", db: -1, dbLocal: -7, layers: [{ g: "veh/backfire", pitch: 1.5 }], gap: 0.07, cap: 4, group: "tuk", spatial: { ref: 5, max: 120, rolloff: 1.0, curve: { a: 5, knee: 40, b: 7 }, air: 200, occl: true, hrtf: 40 } }),
};
for (const w of WEAPONS) {
  BANK[`fire:${w}`] = gunDef(w);
  BANK[`reload:${w}`] = reloadDef(w);
}
for (const s of SURF) BANK[`impact:${s}`] = impactDef(s);
for (const s of STEP_SURFACES) {
  BANK[`step:${s}`] = stepDef(s, "walk");
  BANK[`step:${s}:run`] = stepDef(s, "run");
  BANK[`step:${s}:land`] = stepDef(s, "land");
  BANK[`step:${s}:crouch`] = stepDef(s, "crouch");
}

/** load order: what you need in the first seconds of a match first */
export function loadPriority(id: string): number {
  if (id.startsWith("ui/") || id.startsWith("air/") || id.startsWith("hit/")) return 0;
  if (id.startsWith("amb/") && /-b(-\d\d)?$/.test(id)) return 3; // second bed layers: after everything else
  if (id.startsWith("w/") || id.startsWith("step/")) return 1;
  if (id.startsWith("amb/")) return 2;
  return 3;
}

/** decode rate per file id — the PCM budget. Only LONG LOOPS and BEDS decode below the context rate (and every voice of
 * such a buffer passes an anti-image low-pass: mixer.aaIn / antiImage — the source node's linear-interpolation resampling
 * mirrored a 24 kHz bed's 6-8 kHz cicadas to 16-18 kHz). Beds / the drop's winds / the cabin at 24 kHz (10 kHz of
 * bandwidth), the ambience one-shots, the storm and the long item loops at 32 kHz (14 kHz); every one-shot of the fight —
 * bodies, reports, far tails, room tails, explosions, hits, steps — keeps the context's full rate (at 24-32 kHz the far /
 * tail layers lose their top) */
export function decodeRate(id: string): number | null {
  const g = id.replace(/-\d\d$/, "");
  if (g.startsWith("amb/") || /^air\/(plane-(int|ext)|freefall|glider$|glider-b$|bay-wind|dive|flutter)/.test(g)) return 24000;
  if (g.startsWith("amb1/") || g.startsWith("storm/")) return 32000;
  // the places' soft arrival phrases (≈3 s stereo each, mellow above 8 kHz): loaded with the rest, half the PCM
  if (g.startsWith("ui/poi-")) return 32000;
  if (/^loot\/(chest-hum|use-|heal-loop|shield-loop)/.test(g)) return 32000;
  return null;
}
/** groups decoded on demand around you and released when idle (live only): beds, the storm, the drop's winds, the rare
 * one-shots of a few places */
export function lazyGroup(g: string): boolean {
  // (every ambience one-shot too — each place's sprinkles decode when you get there, the first one of a kind only
  // asks for its group; and the legacy whole-reload takes, which play only while a keyframe set is missing)
  return g.startsWith("amb/") || g.startsWith("amb1/") || g.startsWith("storm/") || /^air\/(plane|freefall|glider(?!-open)|flap|creak|rattle|bay-wind|dive|flutter)/.test(g) || /^w\/[a-z]+\/reload$/.test(g) || /^(loot\/chest-hum(-b)?|veh\/(idle|drive|skid|fire|fuse)|heli\/(rotor|turbine|alarm)|w\/zip\/ride|gun\/(fire|fire-w|hot|spin))$/.test(g);
}
/** lazy groups prefetched at load. The PLANE (cabin layers, exterior drone, rattles — ~9 MB of PCM): it must sound the
 * frame the plane phase starts, whatever the main thread is doing (fetched from idle slices, a stalled match rode a
 * silent plane for ~15 s). The freefall / glider winds are requested — and start loading at once — with the plane loop,
 * ≥ 10 s before anyone can jump; everything of the drop is released after the landing */
export function prefetchGroup(g: string): boolean {
  return /^air\/(plane-int|plane-int-b|plane-int-c|plane-ext|rattle)$/.test(g);
}
/** requested together the moment the plane phase starts (the whole drop: cabin, flyover, freefall, glider) */
export const DROP_GROUPS = ["air/plane-int", "air/plane-int-b", "air/plane-int-c", "air/plane-ext", "air/rattle", "air/freefall", "air/freefall-b", "air/flap", "air/glider", "air/glider-b", "air/creak", "air/bay-wind", "air/dive", "air/flutter"];
export const HELI_GUN_GROUPS = ["gun/fire", "gun/fire-w", "gun/hot", "gun/spin"];

// ---------------------------------------------------------------- ambience beds (see ambience.ts)
export const AMB_DB: Record<string, number> = {
  // bed levels (dB) — tuned so every place sits near -32 LUFS integrated at the listener (audition amb__* tours)
  "amb/surf-near": -1, "amb/surf-wash": -6, "amb/surf-far": -3, "amb/jungle": -3, "amb/insects": -13, "amb/meadow": -3, "amb/wind-high": -4,
  "amb/harbor": -3.5, "amb/lagoon": -1, "amb/volcanic": 0, "amb/waterfall": 0, "amb/river": -2, "amb/lab": -5,
  "amb/room": -14, "amb/altitude": -3, "storm/inside": -4, "amb/chimes": -4,
  // the towns' own bed + the plaza's point sources (fountain, stall / tiki-bar radio)
  "amb/town": -2, "amb/fountain": 0, "amb/radio": -6,
  // the newer POIs' own beds (THE MURK swamp, COCO CAVES sea cave, CANOPY LINE crowns) + the WRECK BAY galleon (a
  // point source at midship, ambience.ts)
  "amb/swamp": -5, "amb/cave": -1, "amb/canopy": 1, "amb/galleon": -1,
};

/** asset groups that may be missing from an older library → the stand-in the engine uses meanwhile (null = skip layer) */
export const ALIAS: Record<string, string | null> = {
  "hit/tick": "hit/marker", "hit/hurt": "hit/body", "loot/heal-done": "loot/pick-heal", "loot/shield-done": "loot/pick-heal",
  "loot/chest-hum-b": null, "air/plane-int-b": null, "air/plane-int-c": null, "air/freefall-b": null, "air/glider-b": null,
  "air/rattle": null, "air/flap": null, "air/creak": null, "air/bay-wind": null, "air/dive": null, "air/flutter": null, "storm/wall-b": null, "storm/crackle": null, "storm/wall-c": null, "storm/shear": "storm/wall",
  // (optional until built)
  ...Object.fromEntries(WEAPONS.flatMap((w) => [[`w/${w}/dist`, null], [`w/${w}/far-tail`, null], [`w/${w}/p1`, `w/${w}/body`]])),
};
