// First-person viewmodel: the kong's gloved hands (./hands.ts — skinned, fingers wrapped AROUND
// every grip by a solver, never through it) holding the banana guns / heal items. Everything is spring-driven: idle
// breathing, walk/sprint bob, look inertia, jump/land, per-weapon fire recoil, equip / holster, aim-down-sights for
// every gun, and per-weapon reload choreography where the left hand really carries what it loads:
//   mag     (SMG, AR)   hand grabs the mag, pulls it, lets it drop (a spinning copy falls away), fetches a fresh one from
//                       below the frame, seats it with a slap, back to the fore-end
//   pistol              thumb release → the mag falls out of the grip; the left hand brings a fresh one up into the
//                       grip, then racks the slide
//   shell   (shotgun)   one visible shell per sim shell-cycle: from below the frame to the loading port, thumbed in
//   bolt    (sniper)    the right hand lifts + pulls the bolt, the left presses two rounds into the open action, bolt home
//   warhead (rocket)    a fresh coconut warhead comes up in the left hand and slides onto the tube
// Reload timing is a pure function of u = elapsed / duration (the sim's reload time), so the audio foley keyframes
// (audio/bank.ts RELOAD_KEYS) line up with the same fractions — see RELOAD_KEYS_VM below.
//
// Camera space: −Z forward, +Y up, +X right. object → sway (inertia + bob) → kick (recoil) → pose (hip / ADS / reload)
// → gun (+ hands, parented in gun space). Zero allocation per frame.
import * as THREE from "three";
import type { ConsumableId, Rarity, WeaponId } from "../../../shared/world/map";
import { WEAPONS } from "../../../shared/world/map";
import type { ViewModel, ViewModelMotion } from "./api";
import { gunInstance } from "./guns/index";
import { buildHeal } from "./heals";
import { createHand, handMaterials, type Hand } from "./hands";
import { tintAccent } from "./rarity";
import { camoSkin } from "./camo";
import { flag } from "../flags";

type Equip = WeaponId | ConsumableId;
type V3 = [number, number, number];
export interface VmFx { muzzleFlash?(pos: THREE.Vector3, dir: THREE.Vector3, weapon: WeaponId, firstPerson: boolean): void; shell?(pos: THREE.Vector3, vel: THREE.Vector3, weapon: WeaponId): void }

// ------------------------------------------------------------------------------------------------ tuning per weapon
/** a hand on a grip, in gun space: the grip-section centre, the grip axis (toward the index finger), the direction from
 *  the axis to the palm, and the section's semi-axes (a along the palm direction, b across it) */
interface GripCfg { at: V3; up: V3; palm: V3; a: number; b: number }
type ReloadKind = "mag" | "pistol" | "shell" | "bolt" | "warhead";
interface Hold {
  pos: V3; rot: V3; scale: number;
  r: GripCfg; l: GripCfg | null;
  /** recoil: back (m), up (rad), roll (rad, random ±), yaw (rad, random ±), recovery stiffness */
  recoil: [number, number, number, number, number];
  /** ADS: the sight point (gun space) put on the view axis `dist` m ahead */
  ads: { sight: V3; dist: number };
  reload: ReloadKind;
  /** where the left hand holds the mag / warhead when it is seated (gun space); shell / round insertion point */
  magGrip?: GripCfg; port?: V3;
  /** this gun's right elbow (camera space, hip) when ELBOW_R would run the forearm over the HUD */
  elR?: V3;
  /** the gun scale the ADS layout (distance, ADS elbows) was authored and verified at; the bigger hip scale is
   *  undone in ADS by scaling the whole ADS layout about the eye (same image, sight still centred) */
  adsScale?: number;
}
// rot = (pitch, yaw, roll), YXZ; +yaw turns the muzzle left. Gun space: −Z muzzle, +Y up, +X right (the side 1P sees).
// ONE hip composition for every
// long gun — each muzzle ends on the same screen spot (ndc ≈ 0.21, −0.255: the SMG / AR / shotgun muzzles sat at
// 0.11-0.13, nearly on the crosshair, the pistol's / sniper's at 0.19-0.23), solved by moving the grip out
// — the centre of the view stays clear; the SMG / AR / shotgun a touch smaller and
// a little less turned in (yaw 0.25 → 0.21) so they keep their length above the hotbar
export const VM_HOLD: Record<WeaponId, Hold> = {
  pistol: {
    // right of centre, barrel converging on the crosshair, forearms down
    pos: [0.242, -0.198, -0.5], rot: [0.02, 0.22, -0.18], scale: 0.822, elR: [0.1, -1.0, -0.4], adsScale: 0.587,
    r: { at: [0, -0.07, 0.046], up: [0, 0.884, -0.467], palm: [1, 0, 0], a: 0.031, b: 0.046 },
    l: null, recoil: [0.045, 0.08, 0.025, 0.012, 26],   // calmer kicks (less random roll / yaw)
    ads: { sight: [0, 0.075, 0.05], dist: 0.3 }, reload: "pistol",
    magGrip: { at: [0, -0.218, 0.102], up: [0, 0.884, -0.467], palm: [-1, 0, 0], a: 0.03, b: 0.042 },
  },
  smg: {
    // right of centre, barrel converging on the crosshair, forearms down
    pos: [0.314, -0.272, -0.53], rot: [-0.03, 0.21, -0.2], scale: 0.92, elR: [0.1, -1.0, -0.4], adsScale: 0.559,
    r: { at: [0, -0.063, 0.042], up: [0, 0.953, -0.302], palm: [1, 0, 0], a: 0.028, b: 0.04 },
    l: { at: [0, -0.06, -0.362], up: [0, 1, -0.06], palm: [-1, 0, 0], a: 0.02, b: 0.02 },
    recoil: [0.022, 0.026, 0.01, 0.006, 34],
    ads: { sight: [0, 0.1, 0.02], dist: 0.3 }, reload: "mag",
    magGrip: { at: [0, -0.142, -0.189], up: [0, 0.923, 0.384], palm: [-1, 0, 0], a: 0.025, b: 0.036 },
  },
  ar: {
    // right of centre, barrel converging on the crosshair, forearms down
    pos: [0.337, -0.243, -0.53], rot: [0.11, 0.21, -0.2], scale: 0.62, elR: [0.1, -1.0, -0.4], adsScale: 0.464,
    r: { at: [0, -0.063, 0.031], up: [0, 0.923, -0.385], palm: [1, 0, 0], a: 0.025, b: 0.034 },
    // the left palm on the NEAR side of the lower tube, fingers over the top, forearm down —
    // the back of the glove faces the camera (hidden under the tube behind the drum it read as an open C-ring)
    l: { at: [-0.012, -0.035, -0.43], up: [0, 0.08, 1], palm: [-1, 0, 0], a: 0.04, b: 0.045 },
    recoil: [0.03, 0.03, 0.01, 0.006, 30],
    ads: { sight: [0, 0.13, 0.0], dist: 0.32 }, reload: "mag",
    magGrip: { at: [0, -0.14, -0.2], up: [0, 1, 0], palm: [-1, 0, 0], a: 0.07, b: 0.07 },
  },
  shotgun: {
    // right of centre, barrel converging on the crosshair, forearms down
    pos: [0.316, -0.197, -0.53], rot: [0.08, 0.21, -0.2], scale: 1.0, elR: [0.1, -1.0, -0.4], adsScale: 0.561,
    r: { at: [0, -0.06, 0.047], up: [0, 0.827, -0.562], palm: [1, 0, 0], a: 0.039, b: 0.048 },
    l: { at: [0, -0.085, -0.265], up: [0, 0.05, -1], palm: [0, -1, 0], a: 0.05, b: 0.075 },
    recoil: [0.09, 0.2, 0.04, 0.02, 16],
    ads: { sight: [0, 0.07, 0.02], dist: 0.34 }, reload: "shell",
    port: [0.07, 0.03, -0.06],
  },
  sniper: {
    // the butt must not cover the ammo counter + hotbar: less muzzle-left yaw and a little left,
    // so the stock runs back under the view instead of out to the lower-right HUD corner
    // right of centre, barrel converging on the crosshair, forearms down
    pos: [0.281, -0.222, -0.55], rot: [0.06, 0.22, -0.12], scale: 0.509, elR: [0.1, -1.0, -0.4], adsScale: 0.424,
    r: { at: [0, -0.03, 0.118], up: [0, 0.88, -0.48], palm: [1, 0, 0], a: 0.036, b: 0.034 },
    l: { at: [0, 0.03, -0.22], up: [0, 0.05, -1], palm: [0, -1, 0], a: 0.05, b: 0.058 },
    recoil: [0.09, 0.15, 0.03, 0.015, 12],
    ads: { sight: [0, 0.25, 0.07], dist: 0.34 }, reload: "bolt",
    port: [0.02, 0.13, 0.04],
  },
  rocket: {
    // a BIG launcher up on the right shoulder — tube high and nearly parallel to the view, its rear running off the right
    // edge (a small tube at the hip shows its open bore); aimed, it stays shouldered at the same size beside the sight line
    pos: [0.3, -0.085, -0.5], rot: [-0.02, 0.13, -0.04], scale: 0.75, elR: [0.1, -1.0, -0.4], adsScale: 0.75,
    r: { at: [0, -0.09, 0.12], up: [0, 0.957, -0.287], palm: [1, 0, 0], a: 0.03, b: 0.036 },
    l: { at: [0, -0.095, -0.08], up: [0, 1, 0], palm: [-1, 0, 0], a: 0.022, b: 0.022 },
    recoil: [0.13, 0.16, 0.03, 0.025, 10],
    ads: { sight: [0, 0.2, 0.1], dist: 0.36 }, reload: "warhead",
  },
  bow: {
    // held upright-diagonal across the right third, bamboo bow + glowing explosive arrow pointing at the crosshair
    pos: [0.22, -0.17, -0.49], rot: [0.02, 0.14, 0.24], scale: 0.86, elR: [0.1, -1.0, -0.4], adsScale: 0.72,
    r: { at: [0, 0.02, -0.14], up: [0, 1, 0], palm: [1, 0, 0], a: 0.026, b: 0.03 },
    l: { at: [0, 0.11, 0.12], up: [0, 1, 0], palm: [-1, 0, 0], a: 0.024, b: 0.024 },
    recoil: [0.04, 0.07, 0.02, 0.01, 22],
    ads: { sight: [-0.02, 0.135, -0.16], dist: 0.32 }, reload: "warhead",
  },
  minigun: {
    // heavy low-slung hip rotary gatling, barrels sweeping forward-left toward center
    pos: [0.30, -0.25, -0.52], rot: [0.02, 0.16, -0.06], scale: 0.74, elR: [0.1, -1.0, -0.4], adsScale: 0.66,
    r: { at: [0, -0.08, 0.26], up: [0, 0.92, -0.35], palm: [1, 0, 0], a: 0.03, b: 0.038 },
    l: { at: [0, 0.155, -0.02], up: [0, 0.2, -1], palm: [0, -1, 0], a: 0.026, b: 0.026 },
    recoil: [0.02, 0.02, 0.014, 0.014, 38],
    ads: { sight: [0, 0.18, -0.08], dist: 0.38 }, reload: "mag",
    magGrip: { at: [0, -0.14, 0.02], up: [0, 1, 0], palm: [-1, 0, 0], a: 0.06, b: 0.06 },
  },
};
/** consumables are held in the right fist, low right; the use animation brings them up to the mouth */
// right of centre like the guns (bbox centre >= 0.60), low, left of the hotbar's first slot
export const ITEM_HOLD = { pos: (flag("fp3") ? [0.115, -0.22, -0.46] : [0.24, -0.15, -0.44]) as V3, rot: [0.12, -0.3, 0.05] as V3, scale: 0.6 };
/** hand size in gun space (kong hands are big) */
const HAND_K = 1.3;
/** the glove's size in camera space, the same on every gun (HAND_K × the gun's scale would give the re-posed,
 *  bigger guns 0.64-1.13 × gloves — a pistol hand 70 % bigger than the rocket's) */
const HAND_W = 0.94;   // (big kong gloves)
/** where the forearms go (camera space): off the bottom corners, behind the view */
// both elbows BELOW the hands, not behind the camera: the forearms drop out of the bottom edge a short way from the
// gloves instead of running from the gun back to the camera as two huge fur planks
const FP3_ON = flag("fp3");
const ELBOW_R = new THREE.Vector3(0.3, -0.72, 0.05), ELBOW_L = flag("fp3") ? new THREE.Vector3(-0.05, -1.0, -0.6) : new THREE.Vector3(-0.3, -0.78, 0.0);
// ADS elbows below the hands too (the ADS forearms ran back to the camera as two planks from the bottom centre)
const ELBOW_R_ADS = FP3_ON ? new THREE.Vector3(0.2, -0.95, -0.45) : new THREE.Vector3(0.16, -0.62, -0.1), ELBOW_L_ADS = FP3_ON ? new THREE.Vector3(-0.12, -0.95, -0.55) : new THREE.Vector3(-0.22, -0.66, -0.16);
const _elR = new THREE.Vector3(), _elL = new THREE.Vector3(), _elR0 = new THREE.Vector3(), _elA = new THREE.Vector3(), _elB = new THREE.Vector3();
/** ADS layout scale about the eye (hip scale / the scale ADS was authored at) */
const adsF = (h: Hold) => (FP3 && h.adsScale ? h.scale / h.adsScale : 1);
/** live tuning handle for a dev tuning script (the vectors are read every frame: mutate them in place) */
export const VM_TUNE = { ELBOW_R, ELBOW_L, ELBOW_R_ADS, ELBOW_L_ADS,
  /** where my glider's riser ends on each fist, along the fist's grip axis (m, + = up the rope). −0.012 =
   *  inside the closed fist — the grip axis now lies along the rope (airRope) and the lashing knot is hidden on my own
   *  glider (setTails(false)), so the rope runs into the fist (−0.07 left a fat rope stub hanging past it) */
  airGripY: -0.012 };
/** the viewmodel draws with its OWN projection —
 *  the camera's FOV (slider 60–100, sprint / mantle / freefall / glide / ADS kicks) is undone by an x / y scale of the
 *  camera-space root, so the gun and the hands keep the size and screen position they have at VM_FOV (vertical deg)
 *  whatever the world FOV does (an independent weapon FOV) */
export const VM_FOV = 55;
/** the camera-space layout (hip holds, ADS distances, the parachute hands) was authored at a 72° projection: hip / ADS
 *  depths are pushed out by VMZ so each gun keeps its screen position and size while the narrower viewmodel projection
 *  takes the wide-angle stretch out of it (a gun at the corner of a 104° h view is smeared toward the edge); the
 *  parachute rig keeps the 72° projection outright (its own counter-scale) */
const AUTH_FOV = 72;
/** A/B switch for tools: ?fp3=0 = the older behaviour (world-FOV viewmodel, no parachute hands) */
const FP3 = flag("fp3");
/** the use animation's sideways travel to the mouth (the item hold already sits near the centre) */
const USE_X = FP3 ? 0.25 : 1;
/** uniform depth squeeze of the whole viewmodel about the eye (a uniform scale about the lens = the SAME image): keeps
 *  every gun / hand inside 0.9 m, where the TAA (atmos/post.ts uNearFix) treats pixels as the viewmodel — no camera
 *  reprojection, no smear in motion; also less clipping into walls (closer in the depth buffer) */
const VM_DEPTH = FP3 ? 0.6 : 1;
const VMZ = FP3 ? Math.tan(AUTH_FOV * Math.PI / 360) / Math.tan(VM_FOV * Math.PI / 360) : 1;
/** first-person parachute hands (camera space at VM_FOV, metres; s = +1 right / −1 left):
 *  freefall — skydiver hands: low in the bottom corners, back of the glove up, fingers forward-out, a wind
 *  flutter; SHIFT dive sweeps them back until only the fingertips show. glide — both fists on the risers in the top
 *  corners, forearms leaving through the side edges, the centre of the view clear; a turn
 *  pulls the inside fist down. Every change of state travels OFF-screen (out past the side edge, then up / down). */
export const AIR = {
  k: 0.92,                                                   // hand scale (camera space; the gun hands are 1.3 × ~0.62)
  // the kong's hands UP in the lower corners against the wind —
  // fingers spread up and out, the peel-wrapped backs toward the camera, the furry forearms rising from the bottom
  // corners (just under the bottom edge the black gloves read as dark blobs; the kong hands are the
  // view's best read of "I'm a kong skydiving")
  // (the forearm fur must not poke over the back of the hands, nor the left hand sit under the health panel) —
  // higher and nearer (bigger), a little further in; the elbows out to the side at the hands' own depth, so the forearms
  // leave through the bottom corners sideways instead of rising toward the camera in front of the hands
  ff: { p: [0.4, -0.2, -0.55], fing: [0.3, 0.72, -0.62], back: [0.12, 0.35, 0.93], elbow: [0.78, -0.72, -0.5] },
  dive: { p: [0.5, -0.55, -0.4], fing: [0.22, -0.3, -0.93], back: [0.04, 1, -0.3], elbow: [0.6, -0.8, 0.15] },
  // elbows high and wide (level with the fists, past the side edge): the forearms leave the frame through the TOP
  // corners — nothing of the arm hangs into the view below the fists
  // a little lower / further in (the whole fist on the rope reads in the corner; it was half cut off by the
  // top edge), the forearms out to the side edges; the grip axis follows the real rope (airRope), `rope` is the fallback
  gl: { p: [0.34, 0.25, -0.6], rope: [-0.08, 0.97, -0.2], fore: [0.8, 0.1, 0.59], elbow: [0.85, -0.05, 0.05] },
  below: [0.47, -0.82, -0.36],                               // off the bottom edge (enter from / leave to the ground)
  side: [0.98, -0.2, -0.26], sideHi: [0.98, 0.42, -0.3],      // past the side edge, low / high (deploy / cut path)
} as const;
export interface AirHands {
  /** freefall / glide / null (on foot, in the plane): the parachute hands blend in / across / out (the gun holsters
   *  while airborne and is drawn again on touchdown); `yaw` (rad) drives the steering pose, `dive` the swept-back pose.
   *  swimming: "swim" = the surface stroke (`dive` = sprinting: the crawl), "under" = under
   *  water — the gun is stowed and both hands swim; null again draws it */
  air(mode: "freefall" | "glide" | "swim" | "under" | null, yaw: number, dive: boolean): void;
  /** swimming: the swimmer's speed (m/s, 3-D under water) — drives the stroke rate and the scull ↔ stroke blend */
  swimMotion?(speed: number): void;
  /** swimming: steps on each stroke's power moment (render.ts plays the stroke sound + splash on it); kind 0 surface
   *  breaststroke, 1 crawl pull, 2 treading scull, 3 under water */
  swimEvt?(): number;
  swimEvtKind?(): number;
  /** swimming: the breaststroke clock (cycles; −1 when not swimming) and the [stroke, crawl] blends — the 1P camera bob
   *  rides the same beat (the head lifts on the in-sweep) */
  swimPhase?(): number;
  swimBlend?(): readonly [number, number] | null;
  /** the fists' grip points (world) for the glider risers; returns how much the fists are ON the risers (0..1) */
  airGrip(outL: THREE.Vector3, outR: THREE.Vector3): number;
  /** where each fist's ropes go (world: the risers' tops on the canopy frame) — the glide fists
   *  turn their grip ALONG the rope they hold (not past the fist) */
  airRope?(topL: THREE.Vector3, topR: THREE.Vector3): void;
}
/** off-screen "pouch" the left hand fetches mags / shells / rounds from (camera space) */
const POUCH = new THREE.Vector3(-0.06, -0.42, -0.34);
/** the reload keyframes (fractions of the sim's reload time) the audio foley must hit — documented contract */
export const RELOAD_KEYS_VM: Record<ReloadKind, Record<string, number>> = {
  mag: { grab: 0.16, out: 0.3, drop: 0.31, fetch: 0.44, insert: 0.64, slap: 0.66, done: 0.84 },
  pistol: { release: 0.1, drop: 0.2, insert: 0.6, slap: 0.62, rack: 0.84, done: 0.95 },
  shell: { fetch: 0.2, insert: 0.62, done: 1.0 },
  bolt: { up: 0.14, back: 0.22, round1: 0.47, round2: 0.68, forward: 0.78, down: 0.82, done: 0.9 },
  warhead: { fetch: 0.3, slide: 0.55, seat: 0.66, done: 0.86 },
};

// ------------------------------------------------------------------------------------------------ springs
class Spring3 {
  x = new THREE.Vector3(); v = new THREE.Vector3(); target = new THREE.Vector3();
  constructor(public k = 120, public d = 16) {}
  step(dt: number) {
    const n = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      this.v.x += ((this.target.x - this.x.x) * this.k - this.v.x * this.d) * h;
      this.v.y += ((this.target.y - this.x.y) * this.k - this.v.y * this.d) * h;
      this.v.z += ((this.target.z - this.x.z) * this.k - this.v.z * this.d) * h;
      this.x.addScaledVector(this.v, h);
    }
  }
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth01 = (x: number) => { const t = clamp01(x); return t * t * (3 - 2 * t); };
const easeOutBack = (x: number) => { const c = 1.7, t = clamp01(x) - 1; return 1 + (c + 1) * t * t * t + c * t * t; };
const bump = (x: number, a: number, b: number) => (x <= a || x >= b ? 0 : Math.sin(((x - a) / (b - a)) * Math.PI));
const win = (x: number, a: number, b: number) => smooth01((x - a) / (b - a));

// ------------------------------------------------------------------------------------------------ frames
/** a hand pose: grip frame (position + orientation, gun space) + grip section + finger curl */
class Frame {
  p = new THREE.Vector3(); q = new THREE.Quaternion(); a = 0.03; b = 0.03; curl = 1;
  copy(f: Frame) { this.p.copy(f.p); this.q.copy(f.q); this.a = f.a; this.b = f.b; this.curl = f.curl; return this; }
  lerp(f0: Frame, f1: Frame, t: number) { this.p.lerpVectors(f0.p, f1.p, t); this.q.slerpQuaternions(f0.q, f1.q, t); this.a = f0.a + (f1.a - f0.a) * t; this.b = f0.b + (f1.b - f0.b) * t; this.curl = f0.curl + (f1.curl - f0.curl) * t; return this; }
  matrix(out: THREE.Matrix4) { return out.compose(this.p, this.q, ONE); }
}
const ONE = new THREE.Vector3(1, 1, 1);
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _mb = new THREE.Matrix4();
/** grip config → frame (right hand: palm = +X_h; left hand: palm = −X_h) */
function gripFrame(g: GripCfg, side: "R" | "L", out = new Frame()): Frame {
  _y.set(...g.up).normalize();
  _x.set(...g.palm); _x.addScaledVector(_y, -_x.dot(_y)).normalize();
  if (side === "L") _x.negate();
  _z.crossVectors(_x, _y);
  _mb.makeBasis(_x, _y, _z);
  out.q.setFromRotationMatrix(_mb); out.p.set(...g.at); out.a = g.a; out.b = g.b; out.curl = 1;
  return out;
}

/** a frame whose grip axis (hand +Y) is `up` and whose heel (hand +Z, where the forearm leaves) points as close to
 *  `heel` as the axis allows — used for fetch / insert poses so the forearm runs naturally toward the elbow */
function frameLook(up: THREE.Vector3, heel: THREE.Vector3, out: THREE.Quaternion) {
  _y.copy(up).normalize();
  _z.copy(heel).addScaledVector(_y, -heel.dot(_y));
  if (_z.lengthSq() < 1e-6) _z.set(0, 0, 1).addScaledVector(_y, -_y.z);
  _z.normalize();
  _x.crossVectors(_y, _z);
  _mb.makeBasis(_x, _y, _z);
  return out.setFromRotationMatrix(_mb);
}

/** relative matrix of `o` in `anc`'s space (anc must be an ancestor) */
function relMatrix(o: THREE.Object3D, anc: THREE.Object3D, out = new THREE.Matrix4()) {
  out.identity();
  let n: THREE.Object3D | null = o;
  const chain: THREE.Object3D[] = [];
  while (n && n !== anc) { chain.push(n); n = n.parent; }
  for (let i = chain.length - 1; i >= 0; i--) { chain[i].updateMatrix(); out.multiply(chain[i].matrix); }
  return out;
}

/** bounding box of `o`'s meshes in `anc`'s space */
function boxIn(o: THREE.Object3D, anc: THREE.Object3D): THREE.Box3 {
  const bb = new THREE.Box3(), tmp = new THREE.Box3(), m = new THREE.Matrix4();
  o.traverse((c) => {
    const mesh = c as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.computeBoundingBox();
    tmp.copy(mesh.geometry.boundingBox!).applyMatrix4(relMatrix(mesh, anc, m));
    bb.union(tmp);
  });
  return bb;
}

/** the highest vertex (anchor space) among the parts whose z lies in front of zCut — the front sight's top */
function frontTop(o: THREE.Object3D, anc: THREE.Object3D, zCut: number): number {
  let top = -Infinity; const m = new THREE.Matrix4(), v = new THREE.Vector3();
  o.traverse((c) => {
    const mesh = c as THREE.Mesh; if (!mesh.isMesh) return;
    relMatrix(mesh, anc, m); const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(m); if (v.z < zCut && v.y > top) top = v.y; }
  });
  return top;
}

// ------------------------------------------------------------------------------------------------ props (shells, rounds)
let propMats: { hull: THREE.Material; brass: THREE.Material; tip: THREE.Material } | null = null;
function props() {
  propMats ??= {
    hull: new THREE.MeshStandardMaterial({ color: "#f2c21c", roughness: 0.38, metalness: 0 }),
    brass: new THREE.MeshStandardMaterial({ color: "#c9953a", roughness: 0.28, metalness: 1 }),
    tip: new THREE.MeshStandardMaterial({ color: "#f7d64a", roughness: 0.45 }),
  };
  return propMats;
}
/** a banana-yellow shotgun shell (hull + brass base), along +Y (base at 0), gun units */
function makeShell(): THREE.Group {
  const m = props(), g = new THREE.Group(); g.name = "vm-shell";
  const hull = new THREE.Mesh(new THREE.CylinderGeometry(0.0125, 0.0125, 0.05, 18), m.hull); hull.position.y = 0.033;
  const crimp = new THREE.Mesh(new THREE.CylinderGeometry(0.0085, 0.0125, 0.006, 18), m.hull); crimp.position.y = 0.061;
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.0138, 0.0138, 0.011, 20), m.brass); base.position.y = 0.0055;
  g.add(hull, crimp, base);
  return g;
}
/** a sniper round: brass case + a yellow banana-nose bullet, along +Y */
function makeRound(): THREE.Group {
  const m = props(), g = new THREE.Group(); g.name = "vm-round";
  const pts = [[0, 0], [0.0095, 0], [0.0095, 0.045], [0.0075, 0.052], [0.0068, 0.06], [0, 0.06]].map(([r, y]) => new THREE.Vector2(r, y));
  const cs = new THREE.Mesh(new THREE.LatheGeometry(pts, 16), m.brass);
  const tp = [[0, 0.058], [0.0068, 0.058], [0.0064, 0.07], [0.004, 0.08], [0, 0.086]].map(([r, y]) => new THREE.Vector2(r, y));
  const tip = new THREE.Mesh(new THREE.LatheGeometry(tp, 16), m.tip);
  g.add(cs, tip);
  return g;
}

// ------------------------------------------------------------------------------------------------ 1P muzzle flash
/** a flash that rides the gun's muzzle in
 *  the viewmodel itself — a camera-facing petal star with a white-hot HDR core + two crossed flame cards along the
 *  bore — shown for FLASH_S after each shot (≥ 3 frames at 60 fps, ≥ 12 at 240), on top of the world particle flash
 *  (which soft-fades against the gun's own depth). Additive, unlit, one shared texture, never casts. */
const FLASH_S = 0.05;
let flashTex: { star: THREE.Texture; flame: THREE.Texture } | null = null;
function flashTextures() {
  if (flashTex) return flashTex;
  const mk = (w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) => { const c = document.createElement("canvas"); c.width = w; c.height = h; draw(c.getContext("2d")!); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; };
  const star = mk(256, 256, (g) => {
    g.translate(128, 128);
    // 6 fat petals (orange rim → yellow), then a hot white core
    for (let i = 0; i < 6; i++) {
      g.save(); g.rotate((i / 6) * Math.PI * 2 + (i % 2 ? 0.12 : 0));
      const L = i % 2 ? 92 : 122, gr = g.createLinearGradient(0, 0, 0, -L);
      gr.addColorStop(0, "rgba(255,250,220,1)"); gr.addColorStop(0.35, "rgba(255,214,90,0.95)"); gr.addColorStop(0.8, "rgba(255,130,30,0.6)"); gr.addColorStop(1, "rgba(255,90,10,0)");
      g.fillStyle = gr; g.beginPath(); g.moveTo(-22, 0); g.quadraticCurveTo(-18, -L * 0.6, 0, -L); g.quadraticCurveTo(18, -L * 0.6, 22, 0); g.closePath(); g.fill(); g.restore();
    }
    const rg = g.createRadialGradient(0, 0, 0, 0, 0, 56); rg.addColorStop(0, "rgba(255,255,255,1)"); rg.addColorStop(0.45, "rgba(255,246,200,1)"); rg.addColorStop(1, "rgba(255,200,80,0)");
    g.fillStyle = rg; g.beginPath(); g.arc(0, 0, 56, 0, Math.PI * 2); g.fill();
  });
  const flame = mk(128, 256, (g) => {
    // a tongue of flame from the bottom (muzzle) up: white root, yellow body, orange ragged tip
    const gr = g.createLinearGradient(0, 256, 0, 0);
    gr.addColorStop(0, "rgba(255,255,235,1)"); gr.addColorStop(0.3, "rgba(255,220,100,0.95)"); gr.addColorStop(0.75, "rgba(255,140,40,0.6)"); gr.addColorStop(1, "rgba(255,90,10,0)");
    g.fillStyle = gr; g.beginPath(); g.moveTo(34, 256); g.quadraticCurveTo(6, 150, 64, 0); g.quadraticCurveTo(122, 150, 94, 256); g.closePath(); g.fill();
  });
  flashTex = { star, flame };
  return flashTex;
}
function makeFlash(size: number): THREE.Group {
  const T = flashTextures();
  const g = new THREE.Group(); g.name = "vm-flash"; g.visible = false;
  const mat = (t: THREE.Texture, k: number) => new THREE.MeshBasicMaterial({ map: t, color: new THREE.Color(k, k * 0.95, k * 0.85), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide, fog: false });
  const star = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat(T.star, 2.4)); star.name = "vm-flash-star";
  g.add(star);
  for (const r of [0, Math.PI / 2]) {
    const pl = new THREE.PlaneGeometry(size * 0.55, size * 1.5); pl.translate(0, size * 0.75, 0); pl.rotateX(-Math.PI / 2); pl.rotateZ(r);
    const m = new THREE.Mesh(pl, mat(T.flame, 1.8)); m.name = "vm-flash-flame"; g.add(m);
  }
  g.traverse((o) => { o.renderOrder = 12; (o as THREE.Mesh).frustumCulled = false; o.userData.castShadow = false; });
  return g;
}
const FLASH_SIZE: Record<WeaponId, number> = { pistol: 0.2, smg: 0.2, ar: 0.26, shotgun: 0.42, sniper: 0.36, rocket: 0, bow: 0, minigun: 0.3 };
const flashOf = new WeakMap<object, THREE.Group>();

// ------------------------------------------------------------------------------------------------ loadouts
interface Loadout {
  id: Equip; root: THREE.Group; gun: THREE.Group; hold: Hold | null; kind: ReloadKind | null;
  muzzle: THREE.Vector3; eject: THREE.Vector3;
  handR: Hand; handL: Hand | null;
  /** the hands' scale in gun space (HAND_W / hold.scale = the same glove size on every gun) */
  hk: number;
  restR: Frame; restL: Frame | null;
  mag: THREE.Object3D | null; magParent: THREE.Matrix4; magParentInv: THREE.Matrix4; magRest: THREE.Matrix4;
  /** the mag's hand frame expressed in mag space, and its inverse */
  magGripLocal: THREE.Matrix4; magGripLocalInv: THREE.Matrix4;
  drop: THREE.Object3D | null;
  slide: THREE.Object3D | null; slideRest: number;
  barrels: THREE.Object3D | null;
  bolt: THREE.Object3D | null; boltRest: THREE.Vector3; boltKnob: THREE.Vector3;
  prop: THREE.Object3D | null;
  accent: THREE.Mesh[];
  /** the gun's meshes a mythic finish recolours */
  skin: THREE.Mesh[];
  /** item (consumable) grip section */
  itemAB: [number, number];
}

const adsAuto = new Map<WeaponId, V3>();
/** ADS: the front sight this far ahead of the eye; the gun canted (pitch up, muzzle-left yaw) so its rear drops right */
const ADS_DIST = 0.62, ADS_ROT: V3 = [0.07, 0.13, -0.02];
/** per-gun ADS cant + distance. Pistol: muzzle up + left so the tall rear stem drops
 * out of the sight line to the lower right (a front-post sight picture); rocket: shouldered, the tube parallel to the
 * view, off to the lower right (see ADS_SIGHT_X) and further out — never its open rear bore in the middle */
const ADS_ROT_BY: Partial<Record<WeaponId, V3>> = { pistol: [0.2, 0.34, -0.05], rocket: [0.05, 0.16, 0] };
const ADS_DIST_BY: Partial<Record<WeaponId, number>> = { rocket: 1.0, shotgun: 1.35, pistol: 1.2 };   // (rocket 1.75 → 1.0 + full size)
/** guns whose ADS uses their sight line (exactly on the axis, no 4 mm drop) */
const ADS_LINE = new Set<WeaponId>();
/** how far behind the REAR sight the eye sits when aimed (viewmodel camera units, before VM_DEPTH):
 *  a cheek weld on the long guns — the rear sight just outside the camera's 0.1 m near plane (×VM_DEPTH: 0.21 → 0.126
 *  m); at 0.21 the AR's stock butt reached behind the eye — 0.31 keeps every part in front of the viewmodel
 *  pass's 1 cm near plane (atmos/post.ts VM_NEAR) — the pistol out at arm's length (0.66: closer, its stem cap filled
 *  the view) */
const ADS_EYE: Partial<Record<WeaponId, number>> = { ar: 0.31, smg: 0.21, shotgun: 0.26, pistol: 0.66 };

export async function createViewModel(fxRef: () => VmFx | null, onBuilt?: (o: THREE.Object3D) => void): Promise<ViewModel> {
  const object = new THREE.Group(); object.name = "viewmodel";
  object.renderOrder = 10;
  const sway = new THREE.Group(); sway.name = "vm-sway";
  const kick = new THREE.Group(); kick.name = "vm-kick";
  const pose = new THREE.Group(); pose.name = "vm-pose";
  object.add(sway); sway.add(kick); kick.add(pose);

  const loadouts = new Map<Equip, Loadout>();
  const build = (id: Equip): Loadout => {
    const hit = loadouts.get(id);
    if (hit) return hit;
    const root = new THREE.Group(); root.name = `vm:${id}`;
    const handR = createHand("R");
    let lo: Loadout;
    if ((WEAPONS as readonly string[]).includes(id)) {
      const wid = id as WeaponId, hold = VM_HOLD[wid];
      const inst = gunInstance(wid);
      const skinOf: THREE.Mesh[] = [];
      const gun = new THREE.Group(); gun.name = "vm-gun"; gun.add(inst.root);
      gun.scale.setScalar(hold.scale);
      root.add(gun);
      inst.root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.castShadow = false; m.receiveShadow = true; m.frustumCulled = false; m.userData.castShadow = false; } });
      const spec = inst.spec;
      const restR = gripFrame(hold.r, "R");
      const hk = FP3 ? HAND_W / hold.scale : HAND_K;
      handR.mesh.scale.setScalar(hk);
      gun.add(handR.mesh);
      const handL = createHand("L");
      handL.mesh.scale.setScalar(hk);
      gun.add(handL.mesh);
      const restL = hold.l ? gripFrame(hold.l, "L") : null;
      const flash = FLASH_SIZE[wid] > 0 ? makeFlash(FLASH_SIZE[wid] / hold.scale) : null;
      if (flash) { flash.position.copy(spec.muzzle); gun.add(flash); }
      // ---- the mag (or the warhead): a pivot the left hand carries; the pistol gets one built here
      let mag: THREE.Object3D | null = inst.pivots["mag"] ?? inst.pivots["rocket"] ?? null;
      if (!mag && hold.reload === "pistol") mag = pistolMag(inst.root, hold);
      const magParent = new THREE.Matrix4(), magRest = new THREE.Matrix4(), magGripLocal = new THREE.Matrix4();
      let drop: THREE.Object3D | null = null;
      if (mag) {
        relMatrix(mag.parent!, gun, magParent);
        mag.updateMatrix(); magRest.copy(mag.matrix);
        const mgCfg = hold.magGrip ?? (hold.reload === "warhead" ? warheadGrip(mag, gun) : null);
        if (mgCfg) {
          const f = gripFrame(mgCfg, "L");
          // mag space = (parent · rest)⁻¹ · grip frame
          magGripLocal.copy(magParent).multiply(magRest).invert().multiply(f.matrix(new THREE.Matrix4()));
        }
        if (hold.reload !== "warhead") { drop = mag.clone(true); drop.name = "vm-mag-drop"; drop.visible = false; mag.parent!.add(drop); }
      }
      // ---- sniper bolt: the brown handle + knob become a pivot (built by the gun as "bolt" when present)
      const bolt = inst.pivots["bolt"] ?? null;
      const boltRest = bolt ? bolt.position.clone() : new THREE.Vector3();
      const boltKnob = new THREE.Vector3(0.1, 0.1, 0.1);
      if (bolt) { const bb = boxIn(bolt, bolt.parent!); bb.getCenter(boltKnob); boltKnob.x = bb.max.x - 0.01; }
      // ---- props the left hand brings (a shell / a round)
      let prop: THREE.Object3D | null = null;
      if (hold.reload === "shell") prop = makeShell();
      else if (hold.reload === "bolt") prop = makeRound();
      if (prop) { prop.visible = false; gun.add(prop); prop.traverse((o) => { (o as THREE.Mesh).frustumCulled = false; }); }
      const accent: THREE.Mesh[] = [];
      const ac = inst.pivots["accent"];
      if (ac) ac.traverse((o) => { if ((o as THREE.Mesh).isMesh) accent.push(o as THREE.Mesh); });
      // the gun's own parts (not the accent, not the hands, not the unlit sight dots): what a mythic finish recolours
      inst.root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && !accent.includes(m) && !(m.material as THREE.Material & { isMeshBasicMaterial?: boolean }).isMeshBasicMaterial) skinOf.push(m); });
      const eject = new THREE.Vector3(0.03, spec.sightY * 0.6, -spec.length * 0.12);
      const slide = inst.pivots["slide"] ?? null;
      const barrels = inst.pivots["barrels"] ?? null;
      // ADS: look ALONG the top of the gun — the eye line just above its highest point (so the receiver /
      // stock never block the view), the sight point over the rear third; the sniper keeps its scope line
      if (hold.reload !== "bolt") {
        const bb = boxIn(inst.root, inst.root);
        // the FRONT sight (top of the gun, near the muzzle) goes to the screen centre; the gun sits canted up-left
        // behind it so the receiver / stock fall away to the lower right (the arcade-shooter ADS read)
        const len = bb.max.z - bb.min.z;
        // every gun with a real sight line (AR, SMG, pistol, shotgun) aims THROUGH it — the
        // pistol's canted over-the-post view is gone (its new rear notch lines up with the front dot)
        if (spec.sightLine) {
          // a real sight picture (rear and front sights aligned) — pitch the gun so the
          // line rear-sight-top → front-aperture-centre IS the view axis (no yaw / roll cant), the aperture centred on
          // the crosshair, further out (×1.4) so the gun stays small in the frame
          const f = spec.sightLine.front, r = spec.sightLine.rear;
          adsAuto.set(wid, [f.x, f.y, f.z]);
          ADS_ROT_BY[wid] = [Math.atan((f.y - r.y) / (f.z - r.z)), 0, 0];
          // the eye sits ADS_EYE behind the REAR sight (a cheek weld on the long guns: the stock / the
          // stem cap behind the rear sight pass under the eye, out of view, and the rear ghost ring frames the front
          // blade; the pistol at arm's length). It sat 0.75-1.0 m behind the rear sight: the stock butt and the SMG's
          // stem cap stood in the lower half of every sight picture
          // (the pose places the sight at depth D·VMZ + mz·(VMZ − 1), mz = the pitched sight point z × scale (< 0): solve D)
          const eye = ADS_EYE[wid];
          if (eye !== undefined) {
            const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(ADS_ROT_BY[wid]![0], 0, 0, "YXZ"));
            const mz = new THREE.Vector3(f.x, f.y, f.z).multiplyScalar(hold.scale).applyQuaternion(q).z;
            const T = eye + (r.z - f.z) * hold.scale;
            ADS_DIST_BY[wid] = (T - mz * (VMZ - 1)) / VMZ / (ADS_DIST * adsF(hold));
          } else ADS_DIST_BY[wid] = 0.86;
          ADS_LINE.add(wid);
        }
        else if (wid === "pistol") adsAuto.set(wid, [0, frontTop(inst.root, inst.root, bb.min.z + len * 0.3) + 0.01, bb.min.z + len * 0.1]);
        // the rocket: the eye line runs past the tube's upper LEFT edge (shouldered on the right)
        else if (wid === "rocket") adsAuto.set(wid, [bb.min.x - 0.07, bb.max.y + 0.03, bb.min.z + len * 0.14]);
        else adsAuto.set(wid, [0, bb.max.y + 0.012, bb.min.z + len * 0.14]);
      }
      lo = {
        id, root, gun, hold, kind: hold.reload, muzzle: spec.muzzle.clone(), eject, handR, handL, hk, restR, restL,
        mag, magParent, magParentInv: magParent.clone().invert(), magRest, magGripLocal, magGripLocalInv: magGripLocal.clone().invert(), drop,
        slide, slideRest: slide ? slide.position.z : 0, barrels, bolt, boltRest, boltKnob, prop, accent, skin: skinOf, itemAB: [0, 0],
      };
      if (flash) flashOf.set(lo, flash);
    } else {
      const item = buildHeal(id as ConsumableId).root;
      item.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.castShadow = false; m.receiveShadow = true; m.frustumCulled = false; } });
      const holder = new THREE.Group(); holder.name = "vm-item"; holder.add(item); holder.scale.setScalar(ITEM_HOLD.scale);
      // the hand wraps the item's lower third
      const bb = new THREE.Box3().setFromObject(item);
      item.position.y = -bb.min.y - (bb.max.y - bb.min.y) * 0.32;
      const hx = (bb.max.x - bb.min.x) / 2, hz = (bb.max.z - bb.min.z) / 2;
      root.add(holder);
      handR.mesh.scale.setScalar(HAND_K / ITEM_HOLD.scale * 0.62);
      holder.add(handR.mesh);
      const s = HAND_K / ITEM_HOLD.scale * 0.62;
      const ab: [number, number] = [Math.min(0.09, hx * 0.92) / s * 1, Math.min(0.09, hz * 0.92) / s * 1];
      const restR = gripFrame({ at: [0, 0, 0], up: [0.1, 1, 0.15], palm: [1, 0, 0.35], a: ab[0], b: ab[1] }, "R");
      lo = {
        id, root, gun: holder, hold: null, kind: null, muzzle: new THREE.Vector3(), eject: new THREE.Vector3(), handR, handL: null, hk: s, restR, restL: null,
        mag: null, magParent: new THREE.Matrix4(), magParentInv: new THREE.Matrix4(), magRest: new THREE.Matrix4(), magGripLocal: new THREE.Matrix4(), magGripLocalInv: new THREE.Matrix4(), drop: null,
        slide: null, slideRest: 0, barrels: null, bolt: null, boltRest: new THREE.Vector3(), boltKnob: new THREE.Vector3(), prop: null, accent: [], skin: [], itemAB: ab,
      };
    }
    root.visible = false;
    pose.add(root);
    loadouts.set(id, lo);
    onBuilt?.(root);
    return lo;
  };

  // ---------------------------------------------------------------------------------------------- state
  let cur: Loadout | null = null, next: Equip | null = null, nextRarity: Rarity = "common";
  /** the finish colour of the gun being equipped (null = stock) */
  let skinCol: string | null = null;
  let equipT = 1, holsterT = -1;
  let reloadT = -1, reloadDur = 1, useT = -1, useDur = 1;
  /** cancel blend: the reload pose frozen at cancelU fades out over CANCEL_S */
  let cancelT = -1, cancelU = 0;
  let pending: { dur: number; el: number; at: number } | null = null;
  const CANCEL_S = 0.2;
  let scoped = false, scopeK = 0, adsOn = false, adsK = 0;
  let bobPhase = 0, bobAmt = 0, sprintK = 0, crouchK = 0, airK = 0, wasGrounded = true, t = 0;
  /** sprint / ADS blends are critically damped 2nd-order (no velocity step when they start = no pop) */
  let sprintV = 0, adsV = 0, shellTiltV = 0, scopeV = 0;
  const crit = (x: number, v: number, target: number, w: number, dt: number): [number, number] => { const n = Math.max(1, Math.ceil(dt * 240)), h = dt / n; for (let i = 0; i < n; i++) { v += ((target - x) * w * w - 2 * w * v) * h; x += v * h; } return [x, v]; };
  let rocketSpent = false, dropT = -1, shellTilt = 0, popK = 0, flashT = 0, spinRate = 0;
  // the muzzle light pop: a warm emissive flash on the gloves + forearm fur (VM-only materials) for ~2 frames per shot
  const HM = handMaterials(), POP = new THREE.Color(1.0, 0.55, 0.16);
  (HM.glove as THREE.MeshStandardMaterial).emissive = new THREE.Color(0); (HM.peel as THREE.MeshStandardMaterial).emissive = new THREE.Color(0); (HM.fur as THREE.MeshStandardMaterial).emissive = new THREE.Color(0);
  const dropV = new THREE.Vector3(), dropW = new THREE.Vector3();
  const swayPos = new Spring3(160, 18), swayRot = new Spring3(140, 16);
  const kickPos = new Spring3(260, 20), kickRot = new Spring3(240, 18);
  const land = new Spring3(180, 14);
  const _m = new THREE.Vector3(), _d = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
  const _M = new THREE.Matrix4(), _M2 = new THREE.Matrix4(), _inv = new THREE.Matrix4(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
  // per-frame hand frames
  const fL = new Frame(), fR = new Frame(), fA = new Frame(), fB = new Frame();
  const F = { rest: new Frame(), mag: new Frame(), magOut: new Frame(), below: new Frame(), pouch: new Frame(), port: new Frame(), portIn: new Frame(), bolt: new Frame(), grip: new Frame(), front: new Frame() };

  const show = (id: Equip | null, rarity: Rarity) => {
    if (cur) { cur.root.visible = false; const flash = flashOf.get(cur); if (flash) flash.visible = false; }
    flashT = 0;
    // the outgoing gun's recoil belongs to it: it must not kick the next draw
    kickPos.x.set(0, 0, 0); kickPos.v.set(0, 0, 0); kickRot.x.set(0, 0, 0); kickRot.v.set(0, 0, 0);
    cur = id ? build(id) : null;
    if (!cur) return;
    cur.root.visible = true;
    // a mythic wears the animated mythic camo (camo.ts; atmos-patched like the stock materials)
    tintAccent(cur.accent, rarity); camoSkin(cur.skin, skinCol); if (skinCol) onBuilt?.(cur.root);
    equipT = 0; reloadT = -1; useT = -1; cancelT = -1; dropT = -1;
    resetParts(cur);
    if (pending && cur.hold) { reloadDur = pending.dur; reloadT = Math.min(0.98, (pending.el + (t - pending.at)) / reloadDur); }
    pending = null;
    if (!cur.hold) cur.gun.children[0]?.scale.setScalar(1);
  };
  const resetParts = (lo: Loadout) => {
    if (lo.mag) { lo.mag.matrix.copy(lo.magRest); lo.mag.matrix.decompose(lo.mag.position, lo.mag.quaternion, lo.mag.scale); lo.mag.visible = !(lo.kind === "warhead" && rocketSpent); }
    if (lo.drop) lo.drop.visible = false;
    if (lo.prop) lo.prop.visible = false;
    if (lo.slide) lo.slide.position.z = lo.slideRest;
    if (lo.bolt) { lo.bolt.position.copy(lo.boltRest); lo.bolt.rotation.set(0, 0, 0); }
  };

  /** a camera-space point → the current gun's space */
  const camToGun = (lo: Loadout, p: THREE.Vector3, out: THREE.Vector3) => {
    out.copy(p); object.localToWorld(out); lo.gun.worldToLocal(out); return out;
  };
  const _el = new THREE.Vector3(), _hd = new THREE.Vector3();
  /** heel direction for a left-hand pose at `p` (gun space): toward the left elbow */
  const heelL = (lo: Loadout, p: THREE.Vector3) => { camToGun(lo, ELBOW_L, _el); return _hd.copy(_el).sub(p).normalize(); };
  /** put the mag at a hand frame (the hand carries it) */
  const magToHand = (lo: Loadout, f: Frame) => {
    if (!lo.mag) return;
    f.matrix(_M);
    _M2.copy(lo.magParentInv).multiply(_M).multiply(lo.magGripLocalInv);
    _M2.decompose(lo.mag.position, lo.mag.quaternion, _s);
  };
  const magFrameAt = (lo: Loadout, magMatrix: THREE.Matrix4, out: Frame) => {
    _M.copy(lo.magParent).multiply(magMatrix).multiply(lo.magGripLocal);
    _M.decompose(out.p, out.q, _s);
    return out;
  };

  /** the reload pose at progress u: sets the gun offsets (returned through `off`), the hand frames fL/fR, part states */
  const off = { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, lVis: true };
  const evalReload = (lo: Loadout, u: number) => {
    const h = lo.hold!, kind = lo.kind!;
    off.px = off.py = off.pz = off.rx = off.ry = off.rz = 0; off.lVis = true;
    fR.copy(lo.restR);
    // shared frames
    camToGun(lo, POUCH, F.pouch.p); F.pouch.a = 0.02; F.pouch.b = 0.02; F.pouch.curl = 1; F.pouch.q.copy((lo.restL ?? lo.restR).q);
    F.rest.copy(lo.restL ?? F.pouch);
    if (lo.mag) {
      magFrameAt(lo, lo.magRest, F.mag); F.mag.curl = 1;
      F.pouch.q.copy(F.mag.q); F.pouch.a = F.mag.a; F.pouch.b = F.mag.b;
      // pulled out: down along the mag axis + a little toward the left
      _d.set(0, -1, 0).applyQuaternion(F.mag.q);
      F.magOut.copy(F.mag); F.magOut.p.addScaledVector(_d, kind === "warhead" ? 0 : 0.13).x -= 0.04;
      F.below.copy(F.mag); F.below.p.addScaledVector(_d, 0.08);
      if (kind === "warhead") { _d.set(0, 0, -1); F.front.copy(F.mag); F.front.p.addScaledVector(_d, 0.2); F.front.p.y -= 0.03; }
    } else if (lo.restL) { F.pouch.q.copy(lo.restL.q); }
    else F.pouch.q.copy(lo.restR.q);
    if (!lo.restL) F.rest.copy(F.pouch);
    const set = (k0: Frame, k1: Frame, a: number, b: number, c0: number, c1: number) => { const k = win(u, a, b); fL.lerp(k0, k1, k); fL.curl = c0 + (c1 - c0) * k; };
    if (kind === "mag") {
      const tilt = bump(u, 0.0, 1.0), heavy = lo.id === "ar" ? 1.2 : 1;
      off.rz = -tilt * 0.42 * heavy; off.rx = tilt * 0.16; off.ry = -tilt * 0.22; off.px = tilt * 0.01; off.py = tilt * 0.035; off.pz = tilt * 0.02;
      if (u < 0.1) set(F.rest, F.mag, 0, 0.1, 1, 0.3);
      else if (u < 0.16) set(F.mag, F.mag, 0.1, 0.16, 0.3, 1);
      else if (u < 0.3) set(F.mag, F.magOut, 0.16, 0.3, 1, 1);
      else if (u < 0.34) set(F.magOut, F.magOut, 0.3, 0.34, 1, 0.2);
      else if (u < 0.44) set(F.magOut, F.pouch, 0.34, 0.44, 0.2, 1);
      else if (u < 0.56) set(F.pouch, F.below, 0.44, 0.56, 1, 1);
      else if (u < 0.64) set(F.below, F.mag, 0.56, 0.64, 1, 1);
      else if (u < 0.7) set(F.mag, F.mag, 0.64, 0.7, 1, 0.3);
      else set(F.mag, F.rest, 0.7, 0.86, 0.3, 1);
      // the slap: a small upward push on the gun
      off.py += 0.012 * bump(u, 0.62, 0.7); off.rx += 0.05 * bump(u, 0.62, 0.7);
      // the charge at the end
      off.rx -= 0.06 * bump(u, 0.86, 1); off.pz += 0.015 * bump(u, 0.86, 1);
      if (lo.mag) {
        if (u < 0.16) resetMag(lo);
        else if (u < 0.31) { lo.mag.visible = true; magToHand(lo, fL); }
        else if (u < 0.44) { lo.mag.visible = false; startDrop(lo); }
        else if (u < 0.64) { lo.mag.visible = true; magToHand(lo, fL); }
        else resetMag(lo);
      }
    } else if (kind === "pistol") {
      // the pistol comes up toward the centre and tips its butt toward the camera: the empty grip + the fresh mag in view
      const tilt = bump(u, 0.0, 1.0);
      off.rz = -tilt * 0.4; off.rx = tilt * 0.5; off.ry = tilt * 0.15; off.py = tilt * 0.1; off.px = -tilt * 0.06; off.pz = tilt * 0.02;
      off.lVis = u > 0.12 && u < 0.92;
      // the mag slides out of the grip (0.1-0.18) and drops (0.18+) on its own; the left hand brings the new one
      if (lo.mag) {
        if (u < 0.1) resetMag(lo);
        else if (u < 0.18) { resetMag(lo); _d.set(0, -1, 0); lo.mag.position.addScaledVector(_d.applyQuaternion(F.mag.q), 0.06 * win(u, 0.1, 0.18)); }
        else if (u < 0.3) { lo.mag.visible = false; startDrop(lo); }
        else if (u < 0.6) { lo.mag.visible = true; magToHand(lo, fL); }
        else resetMag(lo);
      }
      if (u < 0.3) set(F.pouch, F.pouch, 0, 0.3, 1, 1);
      else if (u < 0.5) set(F.pouch, F.below, 0.3, 0.5, 1, 1);
      else if (u < 0.6) set(F.below, F.mag, 0.5, 0.6, 1, 1);
      else if (u < 0.66) set(F.mag, F.mag, 0.6, 0.66, 1, 0.2);
      else set(F.mag, F.pouch, 0.66, 0.84, 0.2, 1);
      if (lo.mag && u >= 0.3 && u < 0.6) magToHand(lo, fL);
      off.py += 0.014 * bump(u, 0.58, 0.66);
      // slide rack by the right thumb-side (a quick pull + snap forward)
      if (lo.slide) lo.slide.position.z = lo.slideRest + 0.045 * bump(u, 0.82, 0.94);
      off.rx -= 0.08 * bump(u, 0.82, 0.96);
    } else if (kind === "shell") {
      // the gun rolls onto its left side, muzzle up a touch: the port faces the camera; one shell per cycle
      // the roll itself (shellTilt) is applied outside the reload weight (see update): between two shell cycles the sim
      // reload restarts and the weight drops for a frame — the gun snapped upright and back (a 30°/frame pop)
      F.port.copy(F.pouch); F.port.p.set(...h.port!); F.port.p.x += 0.03; F.port.p.y -= 0.02; F.port.a = 0.012; F.port.b = 0.012;
      F.portIn.copy(F.port); F.portIn.p.set(...h.port!);
      // orient the hand so the shell (along the hand's up) points into the port (−X toward the gun), forearm to the elbow
      frameLook(_d.set(-1, 0.1, 0), heelL(lo, F.port.p), F.port.q); F.portIn.q.copy(F.port.q);
      frameLook(_d.set(-1, 0.1, 0), heelL(lo, F.pouch.p), F.pouch.q); F.pouch.a = F.pouch.b = 0.012;
      if (u < 0.22) set(F.rest, F.pouch, 0, 0.22, 1, 0.9);
      else if (u < 0.5) set(F.pouch, F.port, 0.22, 0.5, 0.9, 0.9);
      else if (u < 0.62) set(F.port, F.portIn, 0.5, 0.62, 0.9, 0.9);
      else if (u < 0.7) set(F.portIn, F.portIn, 0.62, 0.7, 0.9, 0.4);
      else set(F.portIn, F.rest, 0.7, 1.0, 0.4, 1);
      off.py += 0.006 * bump(u, 0.58, 0.68);
      if (lo.prop) {
        lo.prop.visible = u > 0.2 && u < 0.64;
        if (lo.prop.visible) placeProp(lo.prop, fL, 0.05);
      }
    } else if (kind === "bolt") {
      const tilt = bump(u, 0.0, 1.0);
      off.rz = -tilt * 0.3; off.rx = tilt * 0.12; off.ry = -tilt * 0.12; off.py = tilt * 0.03;
      // bolt: up 0.1-0.14, back 0.14-0.22, forward 0.72-0.78, down 0.78-0.82
      const up = win(u, 0.1, 0.14) * (1 - win(u, 0.78, 0.82)), back = win(u, 0.14, 0.22) * (1 - win(u, 0.72, 0.78));
      if (lo.bolt) { lo.bolt.position.copy(lo.boltRest); lo.bolt.position.z += 0.08 * back; lo.bolt.rotation.z = 1.2 * up; }
      // right hand on the bolt knob 0.08-0.84
      F.bolt.copy(lo.restR);
      if (lo.bolt) {
        lo.bolt.updateMatrix(); _p.copy(lo.boltKnob).sub(lo.boltRest).applyQuaternion(lo.bolt.quaternion).add(lo.bolt.position);
        relMatrix(lo.bolt.parent!, lo.gun, _M); _p.applyMatrix4(_M);
        F.bolt.p.copy(_p); F.bolt.p.x += 0.012; F.bolt.a = 0.012; F.bolt.b = 0.012; F.bolt.curl = 0.85;
        _x.set(0, 1, 0); _y.set(0, 0, 1); _z.crossVectors(_x, _y); _mb.makeBasis(_x, _y, _z); F.bolt.q.setFromRotationMatrix(_mb);
      }
      const kR = win(u, 0.04, 0.1) * (1 - win(u, 0.82, 0.9));
      fR.lerp(lo.restR, F.bolt, kR);
      // left hand: two rounds pressed into the open action
      F.port.copy(F.pouch); F.port.p.set(...h.port!); F.port.p.y += 0.035; F.port.a = F.port.b = 0.01;
      frameLook(_d.set(0.1, -1, 0.4), heelL(lo, F.port.p), F.port.q);
      F.portIn.copy(F.port); F.portIn.p.set(...h.port!);
      frameLook(_d.set(0.1, -1, 0.4), heelL(lo, F.pouch.p), F.pouch.q); F.pouch.a = F.pouch.b = 0.01;
      if (u < 0.2) fL.copy(F.rest);
      else if (u < 0.3) set(F.rest, F.pouch, 0.2, 0.3, 1, 0.9);
      else if (u < 0.42) set(F.pouch, F.port, 0.3, 0.42, 0.9, 0.9);
      else if (u < 0.48) set(F.port, F.portIn, 0.42, 0.48, 0.9, 0.9);
      else if (u < 0.56) set(F.portIn, F.pouch, 0.48, 0.56, 0.9, 0.9);
      else if (u < 0.64) set(F.pouch, F.port, 0.56, 0.64, 0.9, 0.9);
      else if (u < 0.69) set(F.port, F.portIn, 0.64, 0.69, 0.9, 0.9);
      else set(F.portIn, F.rest, 0.72, 0.84, 0.9, 1);
      if (lo.prop) { lo.prop.visible = (u > 0.27 && u < 0.48) || (u > 0.53 && u < 0.69); if (lo.prop.visible) placeProp(lo.prop, fL, -0.07); }
    } else if (kind === "warhead") {
      const tilt = bump(u, 0.0, 1.0);
      off.rz = -tilt * 0.12; off.rx = -tilt * 0.08; off.ry = tilt * 0.28; off.py = -tilt * 0.02; off.px = -tilt * 0.03;
      if (u < 0.12) fL.copy(F.rest);
      else if (u < 0.3) set(F.rest, F.pouch, 0.12, 0.3, 1, 1);
      else if (u < 0.5) set(F.pouch, F.front, 0.3, 0.5, 1, 1);
      else if (u < 0.66) set(F.front, F.mag, 0.5, 0.66, 1, 1);
      else if (u < 0.7) set(F.mag, F.mag, 0.66, 0.7, 1, 0.3);
      else set(F.mag, F.rest, 0.7, 0.86, 0.3, 1);
      if (lo.mag) {
        if (u < 0.28) { resetMag(lo); lo.mag.visible = !rocketSpent; }
        else if (u < 0.66) { lo.mag.visible = true; rocketSpent = false; magToHand(lo, fL); }
        else resetMag(lo);
      }
    }
  };
  const resetMag = (lo: Loadout) => { if (!lo.mag) return; lo.magRest.decompose(lo.mag.position, lo.mag.quaternion, _s); lo.mag.visible = !(lo.kind === "warhead" && rocketSpent); };
  const startDrop = (lo: Loadout) => {
    if (!lo.drop || !lo.mag || dropT >= 0) return;
    // the old mag leaves the hand where it is now (the last hand-carried pose) and falls, spinning
    lo.drop.position.copy(lo.mag.position); lo.drop.quaternion.copy(lo.mag.quaternion); lo.drop.visible = true;
    dropT = 0; dropV.set(-0.25, -0.2, 0.05); dropW.set(2.5 + Math.random(), 0.8, 1.6);
  };
  const stepDrop = (lo: Loadout, dt: number) => {
    if (dropT < 0 || !lo.drop) return;
    dropT += dt;
    dropV.y -= 9 * dt;
    lo.drop.position.addScaledVector(dropV, dt);
    lo.drop.rotation.x += dropW.x * dt; lo.drop.rotation.z += dropW.z * dt;
    if (dropT > 0.7) { lo.drop.visible = false; dropT = -1; }
  };
  /** a prop held between thumb and fingers: along the hand's up axis, ahead of the palm */
  const placeProp = (prop: THREE.Object3D, f: Frame, along: number) => {
    prop.quaternion.copy(f.q);
    _d.set(0, 1, 0).applyQuaternion(f.q);
    prop.position.copy(f.p).addScaledVector(_d, along - 0.03);
    prop.scale.setScalar(1.0);
  };

  const applyHand = (hand: Hand, f: Frame, elbow: THREE.Vector3, hk: number) => {
    hand.mesh.position.copy(f.p); hand.mesh.quaternion.copy(f.q);
    hand.setGrip(f.a / hk, f.b / hk, f.curl);
    hand.mesh.updateMatrixWorld(true);
    _p.copy(elbow); object.localToWorld(_p);
    hand.aimForearm(_p);
  };

  // ---------------------------------------------------------------------------------------------- parachute hands
  const airG = new THREE.Group(); airG.name = "vm-air"; airG.visible = false; object.add(airG);
  const airH = [createHand("R"), createHand("L")];
  for (const h of airH) { h.mesh.scale.setScalar(AIR.k); airG.add(h.mesh); }
  // the riser through each glide fist, drawn WITH the hands: the viewmodel has its own pass over the
  // world (atmos/post.ts native VM), so the glider's own risers now pass behind the fists and forearms — this stub
  // runs along the fist's grip axis (= the real rope's direction, airRope) from just under the fist out of the frame
  const airRopes = (() => {
    const c = document.createElement("canvas"); c.width = 32; c.height = 128; const x = c.getContext("2d")!;
    x.fillStyle = "#c9a066"; x.fillRect(0, 0, 32, 128);
    // three twisted strands: diagonal light / dark bands
    for (let k = -8; k < 24; k++) { const y = k * 8; x.fillStyle = k % 2 ? "#e2c189" : "#9c7646"; x.beginPath(); x.moveTo(0, y); x.lineTo(32, y + 12); x.lineTo(32, y + 16); x.lineTo(0, y + 4); x.closePath(); x.fill(); }
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(1, 6);
    const m = new THREE.MeshStandardMaterial({ map: tex, bumpMap: tex, bumpScale: 0.6, roughness: 0.9 }); m.name = "vm-air-rope";
    const g = new THREE.CylinderGeometry(0.012, 0.012, 0.8, 10, 1, true); g.translate(0, 0.4 - 0.06, 0);
    return airH.map((h) => { const r = new THREE.Mesh(g, m); r.name = "vm-air-rope"; r.frustumCulled = false; r.visible = false; r.castShadow = false; h.mesh.add(r); return r; });
  })();
  type AirPose = { p: THREE.Vector3; q: THREE.Quaternion; el: THREE.Vector3; curl: number; a: number };
  const mkPose = (): AirPose => ({ p: new THREE.Vector3(), q: new THREE.Quaternion(), el: new THREE.Vector3(), curl: 0, a: 0.03 });
  const airCur = [mkPose(), mkPose()], airFrom = [mkPose(), mkPose()], airTo = [mkPose(), mkPose()];
  /** the risers' tops in airG space ([right, left]) and whether they are current */
  const ropeTop = [new THREE.Vector3(), new THREE.Vector3()]; let ropeOk = 0;
  /** 0 none, 1 freefall, 2 glide, 3 swimming (surface), 4 under water; the transition from `airPrev` runs airU 0 → 1 over airDur s */
  let airDiveV = 0, airRate = 0, airTurnV = 0, airYawT = 0, legacyAir = false, airMode = 0, airPrev = 0, airU = 1, airDur = 0.4, airYaw = 0, airYawSet = false, airTurn = 0, airDive = 0, airDiveOn = false, drawPending = false;
  const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _w0 = new THREE.Vector3(), _w1 = new THREE.Vector3(), _w2 = new THREE.Vector3(), _w3 = new THREE.Vector3();
  const _qa = new THREE.Quaternion();
  const setV = (out: THREE.Vector3, v: readonly number[], s: number) => out.set(v[0] * s, v[1], v[2]);
  // ---- swimming hands (modes 3 / 4). The stroke clocks match the 3P rig's (actors/kong-rig.ts SWIM_TUNE): a breaststroke
  // cycle per ~6.4 m, the crawl alternating, the scull at 0.85 Hz. Keys are camera space (the parachute rig's 72°
  // projection), right hand; s mirrors x for the left. f = fingers, n = palm normal (both normalised at use).
  let swPh = 0, swCr = 0, swTr = 0, swSp = 0, swMove = 0, swSprint = 0, swEvt = 0, swEvtKind = 0;
  type SwKey = { p: readonly number[]; f: readonly number[]; n: readonly number[]; e: readonly number[] };
  // (a reach that met at the crosshair ran the forearms at the camera like logs — the hands now meet below
  //  the crosshair, further out, and the elbows sit out to the side at the hands' depth, so the forearms leave through
  //  the bottom corners sideways, as the skydive hands do)
  const SW_REACH: SwKey = { p: [0.12, -0.3, -0.74], f: [0.12, -0.1, -1], n: [0.3, -0.95, 0], e: [0.8, -0.72, -0.42] };
  const SW_OUT: SwKey = { p: [0.47, -0.3, -0.58], f: [0.55, -0.1, -0.83], n: [0.85, -0.5, -0.1], e: [1.0, -0.62, -0.25] };
  const SW_IN: SwKey = { p: [0.17, -0.6, -0.36], f: [-0.35, -0.55, -0.75], n: [-0.35, -0.25, 0.9], e: [0.7, -0.95, -0.05] };
  const SW_MID: SwKey = { p: [0.06, -0.44, -0.54], f: [-0.05, -0.2, -1], n: [-0.6, -0.8, 0], e: [0.65, -0.95, -0.2] };
  const CR_ENTRY: SwKey = { p: [0.2, -0.22, -0.8], f: [0.05, -0.35, -0.94], n: [0.15, -0.95, -0.25], e: [0.82, -0.58, -0.45] };
  const CR_PULL: SwKey = { p: [0.32, -0.64, -0.38], f: [0.1, -0.9, 0.4], n: [0.1, -0.3, 0.95], e: [0.62, -1.0, -0.1] };
  const CR_REC: SwKey = { p: [0.5, 0.1, -0.62], f: [-0.15, -0.5, -0.85], n: [0.6, -0.2, 0.75], e: [1.0, 0.22, -0.32] };
  const SWP = new THREE.Vector3(), SWF = new THREE.Vector3(), SWN = new THREE.Vector3(), SWE = new THREE.Vector3(), _sv = new THREE.Vector3();
  /** add w × the blend of keys a → b at k (eased) into the accumulators, x mirrored by s; `lift` raises it (under water) */
  const swAdd = (a: SwKey, b: SwKey, k: number, s: number, w: number, lift = 0) => {
    const e = smooth01(k), q = 1 - e;
    SWP.x += w * s * (a.p[0] * q + b.p[0] * e); SWP.y += w * (a.p[1] * q + b.p[1] * e + lift); SWP.z += w * (a.p[2] * q + b.p[2] * e);
    _sv.set(s * (a.f[0] * q + b.f[0] * e), a.f[1] * q + b.f[1] * e, a.f[2] * q + b.f[2] * e).normalize(); SWF.addScaledVector(_sv, w);
    _sv.set(s * (a.n[0] * q + b.n[0] * e), a.n[1] * q + b.n[1] * e, a.n[2] * q + b.n[2] * e).normalize(); SWN.addScaledVector(_sv, w);
    SWE.x += w * s * (a.e[0] * q + b.e[0] * e); SWE.y += w * (a.e[1] * q + b.e[1] * e); SWE.z += w * (a.e[2] * q + b.e[2] * e);
  };
  const swimTarget = (mode: number, i: number, out: AirPose) => {
    const s = i === 0 ? 1 : -1, under = mode === 4, m = swMove, cr = under ? 0 : swSprint * m, br = m - cr, tw = 1 - m, lift = under ? 0.05 : 0;
    SWP.set(0, 0, 0); SWF.set(0, 0, 0); SWN.set(0, 0, 0); SWE.set(0, 0, 0);
    if (tw > 0.001) {
      // treading / hovering: the hands scull flat at the bottom of the view, palms tilting with each sweep
      const a = swTr * Math.PI * 2 + i * 0.6, sw = Math.sin(a);
      SWP.x += tw * s * (0.3 + 0.07 * sw); SWP.y += tw * (-0.39 + 0.015 * Math.cos(2 * a) + lift * 1.4); SWP.z += tw * -0.5;
      _sv.set(s * 0.25, -0.15, -0.95).normalize(); SWF.addScaledVector(_sv, tw);
      _sv.set(s * 0.3 * sw, -0.95, 0).normalize(); SWN.addScaledVector(_sv, tw);
      SWE.x += tw * s * 0.85; SWE.y += tw * -0.75; SWE.z += tw * -0.25;
    }
    if (br > 0.001) {
      const u = swPh - Math.floor(swPh);
      if (u < 0.25) swAdd(SW_REACH, SW_OUT, u / 0.25, s, br, lift);
      else if (u < 0.42) swAdd(SW_OUT, SW_IN, (u - 0.25) / 0.17, s, br, lift);
      else if (u < 0.52) swAdd(SW_IN, SW_MID, (u - 0.42) / 0.1, s, br, lift);
      else if (u < 0.62) swAdd(SW_MID, SW_REACH, (u - 0.52) / 0.1, s, br, lift);
      else swAdd(SW_REACH, SW_REACH, 0, s, br, lift);
      if (u >= 0.62) SWP.z -= br * 0.03 * Math.sin(Math.PI * (u - 0.62) / 0.38);   // the glide: a slow drift forward
    }
    if (cr > 0.001) {
      const u = swCr + (i ? 0.5 : 0), v = u - Math.floor(u);
      if (v < 0.45) swAdd(CR_ENTRY, CR_PULL, v / 0.45, s, cr);
      else if (v < 0.75) swAdd(CR_PULL, CR_REC, (v - 0.45) / 0.3, s, cr);
      else swAdd(CR_REC, CR_ENTRY, (v - 0.75) / 0.25, s, cr);
    }
    out.p.copy(SWP);
    // frame: the fingers (−Z of the hand), the palm (−X right hand / +X left): index axis = s (f × n), heel = −f
    SWF.normalize(); SWN.normalize();
    _sv.crossVectors(SWF, SWN).multiplyScalar(s);
    frameLook(_sv, _w3.copy(SWF).negate(), out.q);
    out.el.copy(SWE); out.curl = 0.04; out.a = 0.03;
    return out;
  };
  /** the stroke clocks + the scull ↔ stroke ↔ crawl blends, and the stroke beat (swEvt) */
  const stepSwim = (dt: number) => {
    if (airMode < 3) { swMove = 0; swSprint = 0; return; }
    const under = airMode === 4;
    swMove += (smooth01((swSp - 0.4) / 1.6) - swMove) * (1 - Math.exp(-dt * 5));
    swSprint += ((airDiveOn && !under && swSp > 4 ? 1 : 0) - swSprint) * (1 - Math.exp(-dt * 4));
    const m = swMove, cr = under ? 0 : swSprint * m, br = m - cr;
    const ph0 = swPh, cr0 = swCr, tr0 = swTr;
    swPh += (Math.max(swSp, 0.8 * m) / (under ? 6.0 : 6.4)) * dt;
    swCr += (Math.max(swSp, 0.8 * m) / 6.4) * dt;
    swTr += 0.85 * dt;
    if (!under && br > 0.5 && Math.floor(swPh - 0.3) > Math.floor(ph0 - 0.3)) { swEvt++; swEvtKind = 0; }
    else if (!under && cr > 0.5 && Math.floor(swCr * 2) > Math.floor(cr0 * 2)) { swEvt++; swEvtKind = 1; }
    else if (!under && m < 0.3 && Math.floor(swTr) > Math.floor(tr0)) { swEvt++; swEvtKind = 2; }
    else if (under && m > 0.5 && Math.floor(swPh - 0.3) > Math.floor(ph0 - 0.3)) { swEvt++; swEvtKind = 3; }
  };
  /** the live target pose of a hand in a mode (wobble / steering / dive included) */
  const airTarget = (mode: number, i: number, out: AirPose) => {
    if (mode >= 3) return swimTarget(mode, i, out);
    const s = i === 0 ? 1 : -1, ph = i * 1.7;
    if (mode === 2) {
      const G = AIR.gl;
      // steering: the inside fist pulls its riser down (airTurn > 0 = turning right), the outside one eases up
      const pull = Math.max(0, s * airTurn), ease = Math.max(0, -s * airTurn);
      setV(out.p, G.p, s);
      out.p.y += -0.034 * pull + 0.01 * ease + Math.sin(t * 1.3 + ph) * 0.004;
      out.p.z += 0.025 * pull;
      out.p.x += Math.sin(t * 0.9 + ph * 2) * 0.003;
      setV(_a, G.rope, s); setV(_b, G.fore, s);
      // the grip axis lies ALONG the rope this fist holds (up to its riser tops, behind the head), so the
      // riser runs through the closed fist instead of past it
      if (ropeOk > 0) { _a.copy(ropeTop[i]).sub(out.p).normalize(); }
      _a.x += Math.sin(t * 1.1 + ph) * 0.03 - s * 0.05 * pull;
      frameLook(_a, _b, out.q);
      setV(out.el, G.elbow, s); out.el.y -= 0.04 * pull;
      // (the rope must not lie across the outside of the fingers) a tight fist round the rope: the fingers wrap ~150°
      // of a 1.7 cm grip and the thumb closes the rest, the rope piece (airRopes, 1.2 cm) inside it
      out.curl = 1; out.a = 0.016;
      return out;
    }
    if (mode === 1) {
      const F = AIR.ff, D = AIR.dive, d = airDive;
      // wind: a fast flutter + a slow drift, stronger in the dive; the turn sweeps the inside arm back + down
      const turn = s * airTurn;
      _w0.set(F.p[0] * s, F.p[1], F.p[2]).lerp(_w1.set(D.p[0] * s, D.p[1], D.p[2]), d);
      _w0.y += -0.022 * Math.max(0, turn) + 0.008 * Math.max(0, -turn) + Math.sin(t * 2.3 + ph) * 0.004;
      _w0.z += 0.025 * Math.max(0, turn);
      _w0.x += Math.sin(t * 1.7 + ph * 1.3) * 0.004;
      out.p.copy(_w0);
      _a.set(F.fing[0] * s, F.fing[1], F.fing[2]).lerp(_b.set(D.fing[0] * s, D.fing[1], D.fing[2]), d).normalize();
      _c.set(F.back[0] * s, F.back[1], F.back[2]).lerp(_b.set(D.back[0] * s, D.back[1], D.back[2]), d).normalize();
      // heel = −fingers; index axis = heel × back-of-glove (mirrored for the left hand, see hands.ts)
      _b.copy(_a).negate();
      if (s < 0) _c.negate();
      _w2.crossVectors(_b, _c);
      frameLook(_w2, _b, out.q);
      // ≤ 3 Hz and ≤ 1.5° (a 5-9 Hz buzz peaked near 2°/frame at 30 fps — visible pops — for hands that sit
      // under the bottom edge anyway): a slow wind sway, not a vibration
      const fl = (Math.sin(t * 2.3 + ph) * 0.6 + Math.sin(t * 3.1 + ph * 3) * 0.4) * (0.018 + 0.012 * d);
      _qa.setFromAxisAngle(_a, fl); out.q.premultiply(_qa);
      _qa.setFromAxisAngle(_w3.set(1, 0, 0), Math.sin(t * 2.7 + ph) * 0.014 * (1 + d) - 0.12 * Math.max(0, turn)); out.q.premultiply(_qa);
      out.el.set(F.elbow[0] * s, F.elbow[1], F.elbow[2]).lerp(_w1.set(D.elbow[0] * s, D.elbow[1], D.elbow[2]), d);
      out.curl = 0.08 + 0.1 * d; out.a = 0.03;
      return out;
    }
    // off-screen below (on foot / in the plane): the last pose dropped out of the bottom edge
    setV(out.p, AIR.below, s); out.q.copy(airCur[i].q); out.el.set(0.5 * s, -1, 0.1); out.curl = airCur[i].curl; out.a = airCur[i].a;
    return out;
  };
  /** cubic Bézier through the off-screen via points of a transition */
  const airPath = (from: number, to: number, s: number, p0: THREE.Vector3, p3: THREE.Vector3, u: number, out: THREE.Vector3) => {
    if (from === 1 && to === 2 || from === 2 && to === 1) { setV(_w1, from === 1 ? AIR.side : AIR.sideHi, s); setV(_w2, from === 1 ? AIR.sideHi : AIR.side, s); }
    else if (to === 2) { setV(_w1, AIR.side, s); _w1.y = -0.5; setV(_w2, AIR.sideHi, s); }
    else if (from === 2) { setV(_w1, AIR.sideHi, s); setV(_w2, AIR.side, s); _w2.y = -0.55; }
    else { _w1.lerpVectors(p0, p3, 1 / 3); _w2.lerpVectors(p0, p3, 2 / 3); }
    const v = 1 - u;
    return out.copy(p0).multiplyScalar(v * v * v).addScaledVector(_w1, 3 * v * v * u).addScaledVector(_w2, 3 * v * u * u).addScaledVector(p3, u * u * u);
  };
  const stepAir = (dt: number) => {
    if (ropeOk > 0) ropeOk--;
    stepSwim(dt);
    [airDive, airDiveV] = crit(airDive, airDiveV, airDiveOn && airMode === 1 ? 1 : 0, 6, dt);
    if (airU < 1) airU = Math.min(1, airU + dt / airDur);
    const e = smooth01(airU);
    // (a forearm swept into the view when looking up during a glide): refresh airG's chain from the CURRENT
    // camera before the hands — the elbow target (localToWorld refreshes the chain) and the palm (updateMatrixWorld from
    // the parent's last matrix, posed by an earlier pass) came from two different camera poses
    airG.updateWorldMatrix(true, false);
    for (let i = 0; i < 2; i++) {
      const s = i === 0 ? 1 : -1, C = airCur[i];
      airTarget(airMode, i, airTo[i]);
      if (airU >= 1) { C.p.copy(airTo[i].p); C.q.copy(airTo[i].q); C.el.copy(airTo[i].el); C.curl = airTo[i].curl; C.a = airTo[i].a; }
      else {
        const f = airFrom[i];
        airPath(airPrev, airMode, s, f.p, airTo[i].p, e, C.p);
        C.q.slerpQuaternions(f.q, airTo[i].q, e);
        C.el.lerpVectors(f.el, airTo[i].el, e);
        // the fist closes on the riser in the last third of a deploy, opens as it leaves
        const ce = airMode === 2 ? smooth01((airU - 0.55) / 0.4) : smooth01(airU / 0.4);
        C.curl = f.curl + (airTo[i].curl - f.curl) * ce; C.a = f.a + (airTo[i].a - f.a) * e;
      }
      const h = airH[i];
      h.mesh.position.copy(C.p); h.mesh.quaternion.copy(C.q);
      airRopes[i].visible = (airMode === 2 ? airU > 0.75 : airPrev === 2 && airU < 0.2) && C.curl > 0.6;
      h.setGrip(C.a / AIR.k, C.a / AIR.k, C.curl, Math.min(1, C.curl * 1.1));
      h.mesh.updateMatrixWorld(true);
      // (the right glide forearm flipped out of the top-right corner in some frames — looking up, after a
      // deploy — while the fist itself never moved): the elbow point goes into the hand's own space through the hand's
      // LOCAL transform, so the aim never depends on world / camera matrices or when they were last updated
      _M.compose(C.p, C.q, _s.setScalar(AIR.k)).invert();
      _p.copy(C.el).applyMatrix4(_M); h.aimForearmLocal(_p);
    }
    airG.visible = airMode !== 0 || airU < 1;
  };

  // for tools: the parachute-hand state per frame (mode, transition clock, steering, dive)
  object.userData.airDbg = () => [airMode, +airU.toFixed(3), +airTurn.toFixed(3), +airDive.toFixed(3)];
  const vm: ViewModel & AirHands = {
    object,
    air(mode, yaw, dive) {
      const m = mode === "freefall" ? 1 : mode === "glide" ? 2 : mode === "swim" ? 3 : mode === "under" ? 4 : 0;
      if (!FP3) { legacyAir = m !== 0; return; }
      if (airYawSet && airMode !== 0) {
        let dy = yaw - airYaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
        const now = performance.now(), h = Math.min(0.1, Math.max(1e-3, (now - airYawT) / 1000));
        // yaw rate → steering pull (~1.6 rad/s = a full pull): the raw per-frame rate is noisy (mouse events and frames
        // do not line up), so a 0.12 s low-pass feeds a critically damped spring (no jitter, no velocity steps)
        airRate += (THREE.MathUtils.clamp(dy / h / 1.6, -1, 1) - airRate) * Math.min(1, h / 0.12);
        [airTurn, airTurnV] = crit(airTurn, airTurnV, airRate, 9, h);
      } else { airTurn = 0; airTurnV = 0; airRate = 0; }
      airYaw = yaw; airYawT = performance.now(); airYawSet = true; airDiveOn = dive;
      if (m === airMode) return;
      // a new transition starts from wherever the hands are now (an interrupted one never pops)
      for (let i = 0; i < 2; i++) { const f = airFrom[i], c = airCur[i]; if (airMode === 0 && airU >= 1) airTarget(0, i, c); f.p.copy(c.p); f.q.copy(c.q); f.el.copy(c.el); f.curl = c.curl; f.a = c.a; }
      if (airMode === 0 && airU >= 1) for (let i = 0; i < 2; i++) { airTarget(m, i, airTo[i]); airFrom[i].q.copy(airTo[i].q); airFrom[i].curl = airTo[i].curl; airFrom[i].a = airTo[i].a; }
      // touchdown 0.28 → 0.45 s (the hands dropping off at ~20°/frame read as a snap; the gun draw is independent)
      airDur = m === 2 && airMode === 1 ? 0.6 : m === 1 && airMode === 2 ? 0.5 : m >= 3 && airMode >= 3 ? 0.3 : m === 0 ? 0.45 : 0.4;
      // touchdown: the weapon is drawn as the hands drop away (the gun was holstered for the whole drop)
      if (m === 0) drawPending = true;
      airPrev = airMode; airMode = m; airU = 0;
    },
    swimMotion(speed) { swSp = speed; },
    swimEvt: () => swEvt,
    swimEvtKind: () => swEvtKind,
    swimPhase: () => (airMode >= 3 ? swPh : -1),
    swimBlend: () => (airMode >= 3 ? [swMove, swSprint] as const : null),
    airRope(topL, topR) {
      // world → airG space (the parachute rig's own projection scale): a line stays a line, so the fist's axis aimed
      // at the top in this space lies along the rope on screen
      airG.updateWorldMatrix(true, false);
      ropeTop[0].copy(topR); airG.worldToLocal(ropeTop[0]); ropeTop[1].copy(topL); airG.worldToLocal(ropeTop[1]);
      ropeOk = 2;
    },
    airGrip(outL, outR) {
      if (!FP3) return 0;
      if (airMode !== 2 && !(airPrev === 2 && airU < 1)) return 0;
      const w = airMode === 2 ? smooth01((airU - 0.6) / 0.35) : 1 - smooth01(airU / 0.25);
      // the riser ends just under each closed fist (VM_TUNE.airGripY)
      for (const [h, o] of [[airH[1], outL], [airH[0], outR]] as const) { h.mesh.updateWorldMatrix(true, false); o.setFromMatrixColumn(h.mesh.matrixWorld, 1).normalize().multiplyScalar(VM_TUNE.airGripY); _c.setFromMatrixPosition(h.mesh.matrixWorld); o.add(_c); }
      return w;
    },
    equip(id, rarity = "common", skin = null) {
      const want = id ?? null;
      skinCol = skin ?? null;
      if (cur && want === cur.id && holsterT < 0) { tintAccent(cur.accent, rarity); camoSkin(cur.skin, skinCol); if (skinCol) onBuilt?.(cur.root); return; }
      next = want; nextRarity = rarity;
      if (cur && cur.root.visible) holsterT = holsterT < 0 ? 0 : holsterT;
      else { holsterT = -1; show(want, rarity); }
    },
    fire() {
      if (!cur || !cur.hold) return;
      const r = cur.hold.recoil;
      const rnd = () => Math.random() * 2 - 1;
      const ak = 1 - adsK * 0.6;   // (aimed, the sight stays steadier in the eye)
      kickPos.v.z += r[0] * r[4] * 0.9 * ak; kickPos.v.y += r[0] * r[4] * 0.12 * ak;
      kickRot.v.x += r[1] * r[4] * 0.9 * ak; kickRot.v.z += rnd() * r[2] * r[4] * ak; kickRot.v.y += rnd() * r[3] * r[4] * ak;
      kickPos.k = kickRot.k = r[4] * 8;
      if (cur.id === "rocket" || cur.id === "bow") rocketSpent = true;
      popK = cur.id === "bow" ? 0 : cur.id === "shotgun" || cur.id === "rocket" || cur.id === "sniper" ? 1.4 : 1;
      { const fl = flashOf.get(cur); if (fl) { flashT = FLASH_S; fl.visible = true; fl.rotation.z = Math.random() * Math.PI * 2; fl.scale.setScalar(0.85 + Math.random() * 0.3); } }
      if (cur.slide) cur.slide.position.z = cur.slideRest + 0.03;
      const fx = fxRef();
      if (fx) {
        cur.gun.updateWorldMatrix(true, false);
        const wid = cur.id as WeaponId;
        if (fx.muzzleFlash && wid !== "bow") { _m.copy(cur.muzzle).applyMatrix4(cur.gun.matrixWorld); _d.set(0, 0, -1).transformDirection(cur.gun.matrixWorld); fx.muzzleFlash(_m, _d, wid, true); }
        if (fx.shell && wid !== "rocket" && wid !== "shotgun" && wid !== "bow") {
          _m.copy(cur.eject).applyMatrix4(cur.gun.matrixWorld);
          // a fan of brass: up and out in a fan (yaw / lift jitter) that arcs through the
          // upper right of the frame before it falls, instead of a flat line straight out of view
          // aimed, the port sits a hand-width from the eye — kick the brass hard right and a little down so it clears
          // the frame in a couple of frames instead of tumbling huge across the sight picture
          if (adsK > 0.5) _d.set(3.2 + Math.random() * 0.8, -0.3 + Math.random() * 0.5, 0.6 + Math.random() * 0.4).transformDirection(cur.gun.matrixWorld).multiplyScalar(3.2);
          else _d.set(1.1 + Math.random() * 0.9, 1.9 + Math.random() * 0.9, -0.2 - Math.random() * 0.7).transformDirection(cur.gun.matrixWorld).multiplyScalar(2.0 + Math.random() * 0.8);
          fx.shell(_m, _d, wid);
        }
      }
    },
    reload(seconds, elapsed = 0) {
      // mid-swap (the old gun is still going down): start it on the incoming gun as soon as it is shown
      if (holsterT >= 0) { pending = { dur: Math.max(0.3, seconds), el: elapsed, at: t }; return; }
      if (!cur || !cur.hold) return;
      reloadDur = Math.max(0.3, seconds); reloadT = Math.min(0.98, Math.max(0, elapsed / reloadDur)); cancelT = -1;
    },
    cancelReload() {
      pending = null;
      if (reloadT < 0 || !cur) return;
      cancelU = Math.min(1, reloadT); cancelT = 0; reloadT = -1;
    },
    debugState() { return { reloadU: pending ? 0 : reloadT, reloadDur, equip: cur ? cur.id : null, ads: adsK, scope: scopeK, cancelling: cancelT >= 0 }; },
    use(seconds) { if (!cur || cur.hold) return; useT = 0; useDur = Math.max(0.3, seconds); },
    setScoped(on) { scoped = on && !!cur && cur.id === "sniper"; },
    setSpin(s) { spinRate = Math.max(0, Math.min(1, s)); },
    setAds(on) { adsOn = on && !!cur && !!cur.hold && cur.id !== "sniper"; },
    muzzle(out) {
      if (!cur) return out.set(0.2, -0.15, -0.8).applyMatrix4(object.matrixWorld);
      cur.gun.updateWorldMatrix(true, false);
      return out.copy(cur.muzzle).applyMatrix4(cur.gun.matrixWorld);
    },
    syncReload(elapsed, total) {
      // the sim's reload clock is the truth: pull the animation onto it (a long frame / a tab stall never lags it), and
      // if something reset the viewmodel mid-reload (an inventory re-equip, a late equip), pick the reload back up
      if (pending || holsterT >= 0 || !cur || !cur.hold) return;
      if (reloadT < 0) { if (cancelT >= 0 || !(total && total > 0.3) || elapsed / total > 0.9) return; reloadDur = total; reloadT = elapsed / total; return; }
      const u = elapsed / reloadDur;
      if (Math.abs(u - reloadT) > 0.02) reloadT = Math.min(0.999, u);
    },
    update(dtRaw, m: ViewModelMotion) {
      const dt = Math.min(dtRaw, 0.05); t += dt;
      // own projection (VM_FOV): undo the camera FOV on x / y (below 45° only the sniper scope zooms: the gun is hidden)
      { const cam = object.parent as THREE.PerspectiveCamera | null;
        if (FP3 && cam && cam.isPerspectiveCamera) { const k = Math.tan(Math.max(45, cam.fov) * Math.PI / 360) / Math.tan(VM_FOV * Math.PI / 360); if (Math.abs(object.scale.x - k * VM_DEPTH) > 1e-5) { object.scale.set(k * VM_DEPTH, k * VM_DEPTH, VM_DEPTH); airG.scale.set(1 / VMZ, 1 / VMZ, 1); } } }
      if (legacyAir) { object.visible = false; return; }
      if (FP3) stepAir(dt);
      if (drawPending && airMode === 0) { drawPending = false; equipT = 0; }
      if (holsterT >= 0) {
        holsterT += dt / (FP3 ? 0.2 : 0.16);
        if (holsterT >= 1) { holsterT = -1; show(next, nextRarity); }
      } else if (equipT < 1 && airMode === 0) equipT = Math.min(1, equipT + dt / (FP3 ? 0.4 : 0.32));
      sway.visible = airMode === 0;
      object.userData.draw = airMode === 0 && holsterT < 0 ? equipT : 0;   // tools: 1 = the gun is fully drawn
      if (!cur) return;
      const lo = cur, hold = lo.hold;
      if (lo.barrels && spinRate > 0.01) lo.barrels.rotation.z -= spinRate * 32 * dt;
      let aimHands = 0;
      // ---- locomotion blend
      const moving = m.grounded ? Math.min(1, m.speed / 4.5) : 0;
      bobAmt += (moving - bobAmt) * Math.min(1, dt * 8);
      if (FP3) [sprintK, sprintV] = crit(sprintK, sprintV, m.sprint && m.speed > 3 && m.grounded && reloadT < 0 ? 1 : 0, 11, dt);
      else sprintK += ((m.sprint && m.speed > 3 && m.grounded && reloadT < 0 ? 1 : 0) - sprintK) * Math.min(1, dt * 9);
      crouchK += ((m.crouch ? 1 : 0) - crouchK) * Math.min(1, dt * 10);
      airK += ((m.grounded ? 0 : 1) - airK) * Math.min(1, dt * 6);
      if (m.grounded && !wasGrounded) land.v.y -= 1.1;
      wasGrounded = m.grounded;
      bobPhase += dt * (m.sprint ? 11.5 : 8.6) * Math.max(0.15, Math.min(1.25, m.speed / 5));
      const lx = THREE.MathUtils.clamp(m.lookDX, -80, 80), ly = THREE.MathUtils.clamp(m.lookDY, -80, 80);
      // the scope raise is a critically damped spring too (the first-order lerp started
      // with a velocity step)
      if (FP3) { [scopeK, scopeV] = crit(scopeK, scopeV, scoped ? 1 : 0, 24, dt); scopeK = Math.min(1, Math.max(0, scopeK)); }
      else scopeK += ((scoped ? 1 : 0) - scopeK) * Math.min(1, dt * 16);
      if (FP3) { [adsK, adsV] = crit(adsK, adsV, adsOn && reloadT < 0 && sprintK < 0.5 ? 1 : 0, 18, dt); adsK = Math.min(1, Math.max(0, adsK)); }
      else adsK += ((adsOn && reloadT < 0 && sprintK < 0.5 ? 1 : 0) - adsK) * Math.min(1, dt * 14);
      const steady = 1 - 0.8 * Math.max(scopeK, adsK);
      swayRot.target.set(-ly * 0.0009, -lx * 0.0011, -lx * 0.0012).multiplyScalar(steady);
      swayPos.target.set(-lx * 0.00022, ly * 0.00018, 0).multiplyScalar(steady);
      swayRot.step(dt); swayPos.step(dt); kickPos.step(dt); kickRot.step(dt); land.step(dt);
      kickPos.target.set(0, 0, 0); kickRot.target.set(0, 0, 0);
      const bk = 1 - 0.75 * adsK;
      const bx = Math.sin(bobPhase) * 0.012 * bobAmt * (1 + sprintK * 0.8) * bk;
      const by = (-Math.abs(Math.cos(bobPhase)) * 0.011 * bobAmt * (1 + sprintK) + Math.sin(t * 1.6) * 0.0022) * bk;
      const br = Math.sin(bobPhase) * 0.02 * bobAmt * bk;
      sway.position.set(swayPos.x.x + bx, swayPos.x.y + by + land.x.y * 0.04 + airK * 0.012, swayPos.x.z);
      sway.rotation.set(swayRot.x.x + Math.sin(t * 1.1) * 0.004 * bk - airK * 0.04, swayRot.x.y, swayRot.x.z + br, "YXZ");
      kick.position.copy(kickPos.x);
      kick.rotation.set(kickRot.x.x, kickRot.x.y, kickRot.x.z);
      // ---- pose: hip placement blended with sprint / crouch / ADS / scope / equip / reload / use
      const P = hold ? hold.pos : ITEM_HOLD.pos, R = hold ? hold.rot : ITEM_HOLD.rot;
      let px = P[0], py = P[1], pz = P[2] * VMZ, rx = R[0], ry = R[1], rz = R[2];
      // sprint: the gun drops, cants inward and the muzzle dips (running carry)
      // the sprint carry also drifts in toward the centre (the hold sits next to the hotbar: the bob swung the stock onto it)
      px -= sprintK * (FP3 ? 0.05 : 0.02); py -= sprintK * 0.06; rx -= sprintK * 0.3; ry += sprintK * 0.28; rz += sprintK * 0.22;
      py -= crouchK * 0.012; rz += crouchK * 0.06;
      if (hold) {
        // ADS (every gun): the sight point onto the view axis; the sniper's scope raise uses its own sight point
        const k = smooth01(Math.max(adsK, scopeK));
        if (k > 0.001) {
          const s = hold.scale, fa = adsF(hold);
          if (scopeK > adsK || !adsAuto.has(lo.id as WeaponId)) {
            const S = hold.ads.sight;
            const ax = -S[0] * s, ay = -S[1] * s, az = (-hold.ads.dist * fa - S[2] * s) * VMZ;
            px += (ax - px) * k; py += (ay - py) * k; pz += (az - pz) * k; rx *= 1 - k; ry *= 1 - k; rz *= 1 - k;
          } else {
            const S = adsAuto.get(lo.id as WeaponId)!, AR = ADS_ROT_BY[lo.id as WeaponId] ?? ADS_ROT;
            _e.set(AR[0], AR[1], AR[2], "YXZ"); _q.setFromEuler(_e);
            _m.set(S[0] * s, S[1] * s, S[2] * s).applyQuaternion(_q);
            const ax = -_m.x, ay = -_m.y - (ADS_LINE.has(lo.id as WeaponId) ? 0 : 0.004), az = (-ADS_DIST * (ADS_DIST_BY[lo.id as WeaponId] ?? 1) * fa - _m.z) * VMZ;
            px += (ax - px) * k; py += (ay - py) * k; pz += (az - pz) * k;
            rx += (AR[0] - rx) * k; ry += (AR[1] - ry) * k; rz += (AR[2] - rz) * k;
          }
        }
      }
      // the draw starts from rest (smoothstep clock into the overshoot curve: no velocity step on the first frame)
      const eq = holsterT >= 0 ? 1 - smooth01(holsterT) : easeOutBack(FP3 ? smooth01(equipT) : equipT);
      py -= (1 - eq) * 0.32; rx -= (1 - eq) * (FP3 ? 0.5 : 0.7); rz += (1 - eq) * (FP3 ? 0.18 : 0.25);
      // ---- reload
      if (hold) {
        const reloading = reloadT >= 0;
        // no velocity step when the roll-out starts / ends
        if (FP3) [shellTilt, shellTiltV] = crit(shellTilt, shellTiltV, reloading && lo.kind === "shell" ? 1 : 0, 16, dt);
        else shellTilt += ((reloading && lo.kind === "shell" ? 1 : 0) - shellTilt) * Math.min(1, dt * 12);
        let w = 0, u = 0;
        // the reload pose fades out over its last 10 % (it snapped from the end pose back to rest on the last frame)
        if (reloading) { reloadT += dtRaw / reloadDur; u = Math.min(1, reloadT); w = FP3 ? 1 - smooth01((u - 0.9) / 0.1) : 1; }
        else if (cancelT >= 0) { cancelT += dt; u = cancelU; w = 1 - smooth01(cancelT / CANCEL_S); if (cancelT >= CANCEL_S) { cancelT = -1; resetParts(lo); } }
        if (w > 0) {
          evalReload(lo, u);
          px += off.px * w; py += off.py * w; pz += off.pz * w; rx += off.rx * w; ry += off.ry * w; rz += off.rz * w;
          if (w < 1) { fL.lerp(lo.restL ?? F.pouch, fL, w); fR.lerp(lo.restR, fR, w); if (lo.prop) lo.prop.visible = false; }
        } else {
          fR.copy(lo.restR);
          if (lo.restL) fL.copy(lo.restL); else { camToGun(lo, POUCH, F.pouch.p); F.pouch.q.copy(lo.restR.q); fL.copy(F.pouch); }
          off.lVis = !!lo.restL;
          if (lo.kind === "shell" && lo.prop) lo.prop.visible = false;
        }
        if (reloading && reloadT >= 1) { reloadT = -1; resetParts(lo); }
        if (lo.kind === "shell") { rz -= 0.5 * shellTilt; rx += 0.12 * shellTilt; ry -= 0.18 * shellTilt; py += 0.03 * shellTilt; px -= 0.01 * shellTilt; }
        stepDrop(lo, dt);
        // fire kick on the pistol slide recovers
        if (lo.slide && !(reloading && lo.kind === "pistol")) lo.slide.position.z += (lo.slideRest - lo.slide.position.z) * Math.min(1, dt * 30);
        const ak = smooth01(adsK);
        // ADS elbows scale about the eye with the ADS layout (adsF), so the ADS forearms are the verified ones
        const fe = adsF(hold);
        _elR.lerpVectors(hold.elR ? _elR0.set(hold.elR[0], hold.elR[1], hold.elR[2]) : ELBOW_R, _elA.copy(ELBOW_R_ADS).multiplyScalar(fe), ak); _elL.lerpVectors(ELBOW_L, _elB.copy(ELBOW_L_ADS).multiplyScalar(fe), ak);
        aimHands = 1;
        if (lo.handL) lo.handL.mesh.visible = (w > 0 ? off.lVis : !!lo.restL);
      } else {
        fR.copy(lo.restR); fR.a = lo.itemAB[0]; fR.b = lo.itemAB[1];
        lo.handR.mesh.position.copy(fR.p); lo.handR.mesh.quaternion.copy(fR.q);
        lo.handR.setGrip(fR.a, fR.b, 1);
        aimHands = 2;
      }
      // ---- consumable use: up to the mouth with sips; the leaf bundle is pressed + wrapped in beats
      if (useT >= 0) {
        useT += dtRaw / useDur;
        const u = Math.min(1, useT);
        const up = smooth01(u / 0.15) * (1 - smooth01((u - 0.84) / 0.16));
        let sq = 1;
        if (lo.id === "leaf-bundle") {
          px -= up * 0.2 * USE_X; py += up * 0.03; pz += up * 0.1; rx += up * 0.3; rz -= up * 0.25;
          const beat = Math.sin(u * Math.PI * 2 * 3.5);
          rz += beat * 0.22 * up; ry += beat * 0.12 * up; py += Math.abs(beat) * 0.012 * up;
          sq -= 0.1 * Math.max(0, beat) * up;
        } else {
          px -= up * 0.15 * USE_X; py += up * 0.12; pz += up * 0.16; rx += up * 0.85; rz -= up * 0.4;
          const sip = Math.sin(u * Math.PI * 8);
          py += sip * 0.007 * up; rx += sip * 0.04 * up;
        }
        sq *= 1 - 0.55 * bump(u, 0.8, 1.0);
        if (!lo.hold) lo.gun.children[0]?.scale.setScalar(sq);
        if (useT >= 1) { useT = -1; if (!lo.hold) lo.gun.children[0]?.scale.setScalar(1); }
      }
      pose.position.set(px, py, pz);
      _e.set(rx, ry, rz, "YXZ"); _q.setFromEuler(_e); pose.quaternion.copy(_q);
      // the hands and forearms are placed AFTER this frame's final pose, on a parent chain refreshed from the
      // current camera (they used last frame's pose and a stale camera matrix while the elbow target used the fresh one:
      // the forearms lagged a frame and swung with mouse look)
      if (aimHands) {
        lo.gun.updateWorldMatrix(true, false);
        if (aimHands === 1) { applyHand(lo.handR, fR, _elR, lo.hk); if (lo.handL && lo.handL.mesh.visible) applyHand(lo.handL, fL, _elL, lo.hk); }
        else { lo.handR.mesh.updateMatrixWorld(true); _p.copy(ELBOW_R); object.localToWorld(_p); lo.handR.aimForearm(_p); }
      }
      pose.visible = !(scoped && scopeK > 0.92);
      popK = Math.max(0, popK - dtRaw * 22);
      if (flashT > 0) { flashT -= dtRaw; if (flashT <= 0 && cur) { const fl = flashOf.get(cur); if (fl) fl.visible = false; } }
      (HM.glove as THREE.MeshStandardMaterial).emissive.copy(POP).multiplyScalar(0.3 * popK);
      (HM.peel as THREE.MeshStandardMaterial).emissive.copy(POP).multiplyScalar(0.22 * popK);
      (HM.fur as THREE.MeshStandardMaterial).emissive.copy(POP).multiplyScalar(0.18 * popK);
      void _inv; void fA; void fB; void F.grip;
    },
  };
  // for tools: the ADS sight point (world) of the held gun (the sight must sit centred within ±1 %)
  object.userData.sightWorld = (out: THREE.Vector3) => {
    if (!cur || !cur.hold) return null;
    const id = cur.id as WeaponId, S = scopeK > adsK || !adsAuto.has(id) ? cur.hold.ads.sight : adsAuto.get(id)!;
    cur.gun.updateWorldMatrix(true, false);
    return out.set(S[0], S[1], S[2]).applyMatrix4(cur.gun.matrixWorld);
  };
  // ONE loadout built now (its hand + gun materials exist for the boot compile); the other five
  // one per macrotask right after boot (~1 s of main thread moved off the critical path), each reported to onBuilt
  // (the kit's atmos material patch)
  build("ar");
  const rest = WEAPONS.filter((w) => w !== "ar");
  let bi = 0;
  const pre = () => { if (bi >= rest.length) return; if (!loadouts.has(rest[bi])) build(rest[bi]); bi++; setTimeout(pre, 0); };
  setTimeout(pre, 0);
  return vm;
}

/** the pistol has no mag part: a cream mag with a lime base plate, seated inside the grip (its base = the grip's cap) */
function pistolMag(root: THREE.Object3D, hold: Hold): THREE.Object3D {
  const g = new THREE.Group(); g.name = "mag";
  const cream = new THREE.MeshStandardMaterial({ color: "#f3e1b0", roughness: 0.45 });
  const lime = new THREE.MeshStandardMaterial({ color: "#8cc63f", roughness: 0.35 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.042, 0.15, 0.06), cream); body.position.y = 0.085;
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.02, 0.085), lime); base.position.y = 0.0;
  g.add(body, base);
  // along the grip axis, base at the grip bottom
  const up = new THREE.Vector3(...hold.r.up).normalize();
  g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
  g.position.set(0, -0.2, 0.093);
  g.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.frustumCulled = false; m.castShadow = false; } });
  root.add(g);
  return g;
}

/** the warhead's hand frame: around the cone's base, index toward the tip, palm from below */
function warheadGrip(mag: THREE.Object3D, gun: THREE.Object3D): GripCfg {
  const c = boxIn(mag, gun).getCenter(new THREE.Vector3());
  return { at: [c.x, c.y, c.z + 0.02], up: [0, 0, -1], palm: [0, -1, 0], a: 0.062, b: 0.062 };
}
